// CI test for the broker bridge's PERMISSION → dashboard routing (fake claude CLI, real InteractionStore,
// a real forked daemon — no real claude, no network). Proves: a tool-permission escalation the daemon
// relays is journaled as a provider-neutral approval interaction (provider.kind "claude",
// payload.kind "permission-approval"), and the human's dashboard decision is applied back to the daemon.
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { CLAUDE_AUTO_UNAVAILABLE_NOTE, CLAUDE_PERMISSION_LAPSED_MESSAGE } from "./claude-permission-interactions.ts"
import { claudeBrokerRecordPath, claudeBrokerRetirementPath, killBroker, liveBrokerRecords, markBrokerRetired, readBrokerRecord, takeBrokerRetirement } from "./claude-broker-host.ts"
import { describeClaudeBrokerDiagnostic } from "./claude-broker-diagnostics.ts"
import { CLAUDE_BROKER_CAPABILITY_INPUT_ACK, CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX, type ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"
import { claudeBrokerDiagnosticLogPath } from "./claude-broker-diagnostics.ts"
import { WORKER_MAX_CONCURRENT_SUBAGENTS, WORKER_MAX_SUBAGENTS, WORKER_MAX_WEB_SEARCHES } from "./types.ts"

/** The value the SDK passed for a CLI flag, in either spelling: `--flag <value>` or `--flag=<value>`. The
 *  SDK moved `--resume` and `--session-id` to the second in 0.3.260, and every other value flag
 *  (`--permission-mode`, `--model`, `--effort`…) in 0.3.296; the real CLI accepts both. */
const flagValue = (argv: readonly string[] | undefined, flag: string): string | undefined => {
  const args = argv ?? []
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
}

/** Did this argv resume a transcript? */
const resumes = (argv: readonly string[] | undefined, sessionId?: string): boolean => {
  const value = flagValue(argv, "--resume")
  return value !== undefined && (sessionId === undefined || value === sessionId)
}

const fakeCli = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// SIGKILL reaches the DAEMON, not the claude process it forked — which keeps appending to its capture
// log for a few more milliseconds. A one-shot recursive rm loses that race intermittently (ENOTEMPTY:
// a file reappears between readdir and rmdir), so retry briefly instead of failing a green test on
// teardown noise.
async function rmEventually(dir: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(50)
    }
  }
}

async function runCase(decisionId: string, expectBehavior: "allow" | "deny") {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-perm-"))
  const exe = join(dir, "fake-claude--permission.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const store = createInteractionStore(new Database(":memory:"))
  let results = 0
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    interactions: store, projectId: "proj-1",
    onEvent: (_slug: string, _sid: string, ev: ClaudeQueryEvent) => { if (ev.kind === "result") results++ },
  })
  const sessionId = randomUUID()
  const slug = "perm-thread"
  const scope = { projectId: "proj-1", threadSlug: slug, sessionId }
  const waitFor = async (cond: () => boolean, ms = 10_000) => { const d = Date.now() + ms; while (!cond()) { if (Date.now() > d) throw new Error("timeout"); await sleep(100) } }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "do the thing", permissionMode: "default" })
    await waitFor(() => store.listPending(scope).length > 0)
    const [rec] = store.listPending(scope)
    assert.equal(rec.provider.kind, "claude", "interaction is attributed to the claude broker")
    assert.equal(rec.payload.kind, "permission-approval", "escalation renders as an approval card")
    // The IDs must be the frizz web's canonical permission verbs, else the approval buttons don't render.
    assert.ok(rec.allowedDecisions.some((d) => d.id === "grant-turn" && d.semantic === "approve"))
    assert.ok(rec.allowedDecisions.some((d) => d.id === "deny" && d.semantic === "deny"))
    // The daemon must NOT have proceeded before the human decides.
    assert.equal(results, 0, "the tool call is gated until the human decides")

    store.resolve(scope, {
      slug, sessionId, interactionId: rec.id,
      sessionEpoch: rec.owner.sessionEpoch, capabilityRevision: rec.owner.capabilityRevision,
      expectedRecordRevision: rec.recordRevision, responseId: `r-${rec.id}`, decisionId,
    })
    // subscribe → answerPermission → daemon applies the decision → the turn completes with a result.
    await waitFor(() => results > 0)
    assert.ok(results > 0, `daemon proceeded after the human's ${expectBehavior} decision`)
    assert.equal(store.listPending(scope).length, 0, "the interaction is no longer pending")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
}

// A request the worker's own hook settles after the operator was already shown its card: the card must
// LEAVE, at once and for the right reason — not sit there with dead buttons until the turn's `result`
// sweeps it as `turn-ended` (measured against real claude 2026-10-10: 23s, and as long as the turn).
test("a card whose request the CLI settles is withdrawn from the journal before the turn ends", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-perm-"))
  const exe = join(dir, "fake-claude--permission-settled-late.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const db = new Database(":memory:")
  const store = createInteractionStore(db)
  let results = 0
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    interactions: store, projectId: "proj-1",
    onEvent: (_slug: string, _sid: string, ev: ClaudeQueryEvent) => { if (ev.kind === "result") results++ },
  })
  const sessionId = randomUUID()
  const slug = "perm-thread"
  const scope = { projectId: "proj-1", threadSlug: slug, sessionId }
  const waitFor = async (cond: () => boolean, ms = 10_000) => { const d = Date.now() + ms; while (!cond()) { if (Date.now() > d) throw new Error("timeout"); await sleep(20) } }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "do the thing", permissionMode: "default" })
    await waitFor(() => store.listPending(scope).length > 0)
    const [rec] = store.listPending(scope)
    await waitFor(() => store.listPending(scope).length === 0)
    assert.equal(results, 0, "the card left BEFORE the turn ended, not because it did")
    const after = store.get(scope, rec.id)
    assert.equal(after?.lifecycle, "cancelled")
    assert.equal(after?.cancellationReason, "provider-cancelled", "withdrawn by the daemon, not swept as turn-ended")
    await waitFor(() => results > 0)
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

test("broker routes a permission escalation to the InteractionStore and APPROVES on the human decision", { timeout: 25_000 }, async () => {
  await runCase("grant-turn", "allow")
})

test("broker routes a permission escalation and DENIES on the human decision", { timeout: 25_000 }, async () => {
  await runCase("deny", "deny")
})

// An unanswered approval must not hold the turn forever: past its deadline the store expires the card,
// the daemon is answered with a DENY carrying the lapsed message (never an allow), and the turn moves on.
test("an approval nobody answers is denied at its deadline and the turn carries on", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-lapse-"))
  const exe = join(dir, "fake-claude--permission.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const store = createInteractionStore(new Database(":memory:"))
  let results = 0
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    interactions: store, projectId: "proj-1", permissionDeadlineMs: 1_500,
    onEvent: (_slug: string, _sid: string, ev: ClaudeQueryEvent) => { if (ev.kind === "result") results++ },
  })
  const sessionId = randomUUID()
  const slug = "lapse-thread"
  const scope = { projectId: "proj-1", threadSlug: slug, sessionId }
  const waitFor = async (cond: () => boolean, ms = 10_000) => { const d = Date.now() + ms; while (!cond()) { if (Date.now() > d) throw new Error("timeout"); await sleep(50) } }
  const hostResponses = () => {
    try {
      return readFileSync(join(dir, "capture.jsonl"), "utf8").split("\n").filter(Boolean)
        .map((l) => JSON.parse(l) as { kind: string; response?: { response?: { behavior?: string; message?: string } } })
        .filter((r) => r.kind === "host-response")
    } catch { return [] }
  }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "do the thing", permissionMode: "default" })
    await waitFor(() => store.listPending(scope).length > 0)
    const [rec] = store.listPending(scope)
    assert.ok(rec.expiresAt !== null, "an approval card carries a deadline")
    assert.equal(results, 0, "the tool call is gated while the card is live")
    await waitFor(() => results > 0)
    assert.equal(store.get(scope, rec.id)?.lifecycle, "expired", "the card lapsed rather than being answered")
    const [answer] = hostResponses()
    assert.equal(answer?.response?.response?.behavior, "deny", "a lapsed approval fails closed")
    assert.equal(answer?.response?.response?.message, CLAUDE_PERMISSION_LAPSED_MESSAGE)
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// Claude Code starts a session in Manual when auto mode is unavailable and tells nobody, so the thread asks
// before every action. The card is the one place the operator is looking, so it says why. Only when `auto`
// is what the thread was asked to run in: a thread someone set to Manual knows why it is asking.
for (const [title, requested, noted] of [
  ["says why when `auto` was asked for and Manual started", "auto", true],
  ["says nothing extra when Manual is what the thread was asked for", "default", false],
] as const) {
  test(`an approval card ${title}`, { timeout: 25_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbrk-note-"))
    const exe = join(dir, "fake-claude--permission.mjs")
    copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
    const store = createInteractionStore(new Database(":memory:"))
    const bridge = createClaudeAgentBrokerBridge({
      stateDir: dir, executablePath: exe,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      interactions: store, projectId: "proj-1", requestedPermissionMode: () => requested,
    })
    const sessionId = randomUUID()
    const slug = "note-thread"
    const scope = { projectId: "proj-1", threadSlug: slug, sessionId }
    try {
      await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "do the thing", permissionMode: "default" })
      const deadline = Date.now() + 10_000
      while (store.listPending(scope).length === 0) {
        if (Date.now() > deadline) throw new Error("timeout")
        await new Promise((r) => setTimeout(r, 25))
      }
      const [rec] = store.listPending(scope)
      assert.equal(JSON.stringify(rec.payload).includes(CLAUDE_AUTO_UNAVAILABLE_NOTE), noted)
    } finally {
      bridge.releaseSession(slug, sessionId, "session-deleted")
      bridge.close()
      try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
      await rmEventually(dir)
    }
  })
}

// ---- freshProcess: the usage-limit latch escape hatch ----------------------------------------------
// A `claude` that has taken a usage-limit 429 refuses every later input until its reset instant, so the
// resume for that thread has to arrive in a process that never saw the 429. This proves the bridge
// actually swaps the process — same session id, new daemon, cold-resumed from the transcript — and that
// it does NOT do so on an ordinary follow-up, where the point is to keep the live context.
test("followUp: freshProcess retires the live daemon and cold-resumes; a plain follow-up keeps it", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-fresh-"))
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  })
  const sessionId = randomUUID()
  const slug = "latched-thread"
  const recordOf = () => readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))
  // The fake CLI appends its argv here as it starts, so these ARE the processes that ran.
  const startups = () => {
    try {
      return readFileSync(join(dir, "capture.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; argv?: string[] })
        .filter((r) => r.kind === "startup")
    } catch { return [] }
  }
  const waitForStartups = async (n: number) => {
    const deadline = Date.now() + 10_000
    while (startups().length < n && Date.now() < deadline) await sleep(50)
    assert.equal(startups().length, n, `expected ${n} claude process(es) by now`)
  }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "start the work", permissionMode: "default" })
    const first = recordOf()
    assert.ok(first, "the dispatch forked a daemon")
    // Let the original process actually come up before swapping it. A latched thread has been running
    // for hours; racing the swap against its own startup would test a case that never happens, and the
    // kill lands before it records its argv, so the evidence below would be missing rather than wrong.
    await waitForStartups(1)

    // An ordinary follow-up reconnects: the operator's context is the whole point of the live session.
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "carry on" })
    assert.equal(recordOf()?.daemonPid, first.daemonPid, "a plain follow-up must never restart the process")
    assert.equal(recordOf()?.generation, first.generation)
    assert.equal(startups().length, 1, "…and it spawns no second claude")

    // The limit resume asks for a fresh one.
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "the limit reset, continue", freshProcess: true })
    const second = recordOf()
    assert.ok(second, "a replacement daemon is published")
    assert.notEqual(second.daemonPid, first.daemonPid, "freshProcess must hand the message to a NEW process, not the latched one")
    assert.notEqual(second.generation, first.generation, "a new generation is what tells frizz the runtime was swapped")
    assert.equal(second.sessionId, sessionId, "the thread keeps its identity — this is a restart, not a new thread")

    // …and it RESUMED rather than starting blank, so every turn banked before the limit comes back
    // with it. This is the difference between recovering the thread and losing it.
    await waitForStartups(2)
    const replacement = startups()[1]
    assert.ok(resumes(replacement.argv), "the replacement cold-resumes the on-disk transcript")
    assert.ok(resumes(replacement.argv, sessionId), "…for this exact session")
    assert.ok(!resumes(startups()[0].argv), "…where the original was a fresh start, so the two are genuinely different processes")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = recordOf(); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// THE MECHANISM BEHIND THE COMPOSER'S Auto/Bypass PICKER, and the reason it is a process restart rather
// than a live retune: a permission mode is a LAUNCH FLAG. Real `claude` refuses to move a running
// session to bypass at all — "Cannot set permission mode to bypassPermissions because the session was
// not launched with --dangerously-skip-permissions" (measured in `_live_sdk_mode_switch.mts`) — so the
// router persists the operator's choice, retires the daemon, and lets the next follow-up cold-resume the
// same conversation under the new flag.
//
// What this pins is the half a live probe cannot cheaply re-run: the retire leaves the SESSION intact
// (`--resume`, same session id), and the mode the next process is actually STARTED with is the new one.
// The fake CLI records its own argv, so these are the flags a real `claude` would have received.
test("retireDaemon retires the process without ending the conversation, and the next turn starts under the NEW permission mode", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-retire-"))
  const exe = join(dir, "fake-claude--retire.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  })
  const sessionId = randomUUID()
  const slug = "permission-thread"
  const recordOf = () => readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))
  const startups = () => {
    try {
      return readFileSync(join(dir, "capture.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; argv?: string[] })
        .filter((r) => r.kind === "startup")
    } catch { return [] }
  }
  const waitForStartups = async (n: number) => {
    const deadline = Date.now() + 10_000
    while (startups().length < n && Date.now() < deadline) await sleep(50)
    assert.equal(startups().length, n, `expected ${n} claude process(es) by now`)
  }
  const modeOf = (argv: string[] | undefined) => flagValue(argv, "--permission-mode")
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "start the work", permissionMode: "auto" })
    const first = recordOf()
    assert.ok(first, "the dispatch forked a daemon")
    await waitForStartups(1)
    // The NEGATIVE CONTROL. Without it, "the second process runs under bypass" proves nothing about the
    // change — it could have been launched that way all along.
    assert.equal(modeOf(startups()[0].argv), "auto", "the original process runs under the mode it was dispatched with")

    assert.equal(bridge.retireDaemon({ threadSlug: slug, sessionId }), true, "a live daemon was retired")
    assert.equal(recordOf(), null, "…and its record is gone, so nothing will reattach to it")
    // Nothing here spawns a replacement: retiring is not restarting. The process comes back when there
    // is a turn for it to run, which is exactly what "takes effect on the next turn" promises.
    assert.equal(startups().length, 1, "retiring on its own starts no new process")

    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "carry on", permissionMode: "bypassPermissions" })
    const second = recordOf()
    assert.ok(second, "the follow-up cold-started a replacement daemon")
    assert.notEqual(second.daemonPid, first.daemonPid, "…a genuinely different process")
    assert.equal(second.sessionId, sessionId, "…on the same session — the thread keeps its identity")
    await waitForStartups(2)
    const replacement = startups()[1]
    assert.equal(modeOf(replacement.argv), "bypassPermissions", "THE POINT: the new process carries the operator's new mode")
    assert.ok(resumes(replacement.argv), "…and resumes the conversation rather than starting a blank one")
    assert.ok(resumes(replacement.argv, sessionId), "…for this exact session")

    // Retiring what is already gone is not an error and must not CLAIM one: the router turns this false
    // into "saved for the next resume" rather than "takes effect on the next turn", and those are
    // different promises.
    bridge.releaseSession(slug, sessionId, "session-deleted")
    assert.equal(bridge.retireDaemon({ threadSlug: slug, sessionId }), false, "no live daemon ⇒ nothing was retired")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = recordOf(); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// THE HANDLER `context.ts` INSTALLS IS THIS ONE, so this is where a refused input has to arrive. The
// `input` frame carries no reply by design, so `deps.onDiagnostic` is the only channel by which the
// frizz server can ever learn that a message the scheduler already recorded as `delivered` was thrown
// away — and until 2026-08-05 the server's end of it discarded everything that was not a daemon crash.
// Thread `are-taking-over-an-in-flight-epic` refused every input for over two hours in total silence.
// Since input-ack-v1 the refusal ALSO fails the follow-up itself — the daemon answers the frame with the
// reason, so the operator's send rolls back instead of rendering as delivered. The diagnostic is still
// relayed and persisted: it is the only trace a send from an older bridge (which asks for no ack) leaves.
test("a refused input fails the follow-up with the daemon's reason, and still reaches the bridge's onDiagnostic", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-drop-"))
  // `hold-inputs` never answers, so the first uuid stays outstanding and re-using it is refused — the
  // cheapest way to make the daemon's `handle.send` reject through the bridge's own public surface.
  const exe = join(dir, "fake-claude--hold-inputs.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const seen: { slug: string; message: string }[] = []
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    interactions: createInteractionStore(new Database(":memory:")), projectId: "proj-1",
    onEvent: () => {},
    onDiagnostic: (slug, _sid, d) => { if (d.kind === "stderr") seen.push({ slug, message: d.message }) },
  })
  const sessionId = randomUUID()
  const deliveryId = randomUUID()
  const slug = "drop-thread"
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "start the session", permissionMode: "default" })
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "this one holds the uuid", deliveryId })
    await sleep(300)
    await assert.rejects(
      bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "this one is refused", deliveryId }),
      /refused this message: input UUID is already outstanding/,
      "the operator's send fails, naming why, instead of resolving for a message the session refused",
    )
    const deadline = Date.now() + 10_000
    while (!seen.some((s) => s.message.startsWith(CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX))) {
      if (Date.now() > deadline) throw new Error("the drop never reached onDiagnostic")
      await sleep(100)
    }
    const drop = seen.find((s) => s.message.startsWith(CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX))!
    assert.equal(drop.slug, slug, "the line names the thread whose message was lost")
    assert.match(drop.message, /already outstanding/, "…and why it was refused")
    // The mapping the server applies to it is describeClaudeBrokerDiagnostic's, tested beside it.
    assert.equal(describeClaudeBrokerDiagnostic({ kind: "stderr", message: drop.message, truncated: false }), drop.message)
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// THE ONE REAL GAP HIBERNATION OPENED, and it predates hibernation: `attach` reports a death whenever a
// resume has to cold-start, because that is normally the only way frizz learns a daemon died unobserved.
// But THREE paths retire a daemon on purpose while the conversation carries on — a permission-mode
// change (retireDaemon), a usage-limit resume (freshProcess), and now hibernation — and every one of
// them ends in exactly that cold start. Each was telling the operator their thread had crashed, in the
// same words a real crash uses. Hibernation runs unattended on a timer, so it would have turned that
// into a steady drip of false crash reports.
//
// The negative control is the whole test: the SAME SIGTERM, the SAME cold resume, with and without the
// retirement mark. If suppression came from anything but the mark, the second half would be silent too.
test("a cold resume after an INTENTIONAL retirement reports no death — and the same teardown unmarked still does", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-hibernate-"))
  const exe = join(dir, "fake-claude--hibernate.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const crashes: { slug: string; message?: string }[] = []
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    onDiagnostic: (slug, _sid, d) => { if (d.kind === "lifecycle" && d.phase === "crashed") crashes.push({ slug, message: d.message }) },
  })
  const sessionId = randomUUID()
  const slug = "hibernating-thread"
  const recordOf = () => readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))
  const markPath = claudeBrokerRetirementPath(dir, sessionId)
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "start the work", permissionMode: "auto" })
    const first = recordOf()
    assert.ok(first, "the dispatch forked a daemon")

    // ---- hibernation: retire, then wake ----
    assert.equal(bridge.retireDaemon({ threadSlug: slug, sessionId, reason: "hibernate" }), true, "the resting daemon was retired")
    assert.ok(existsSync(markPath), "…leaving the mark that says frizz did it on purpose")
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "wake up" })
    const second = recordOf()
    assert.ok(second, "the follow-up cold-resumed a replacement daemon")
    assert.notEqual(second.daemonPid, first.daemonPid, "…a genuinely different process")
    assert.equal(second.sessionId, sessionId, "…on the same session")
    assert.equal(crashes.length, 0, "THE POINT: waking a hibernated thread is not a crash to report")
    assert.equal(existsSync(markPath), false, "the mark is one-shot — it explains exactly one resume")

    // ---- the control: the identical teardown, unmarked ----
    // killBroker without a reason is what a stop/complete does; here it stands in for the unobserved
    // death the report exists for. Same signal, same cold resume, no mark.
    assert.equal(killBroker(dir, sessionId), true, "the daemon was taken down without a retirement mark")
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "and again" })
    const deadline = Date.now() + 10_000
    while (crashes.length === 0) {
      if (Date.now() > deadline) throw new Error("an unmarked daemon death was never reported — the suppression is too wide")
      await sleep(100)
    }
    assert.equal(crashes[0].slug, slug, "the report names the thread")
    // The CAUSE, not the report, is what differs by platform. Windows has no signals: `process.kill(pid,
    // "SIGTERM")` is TerminateProcess, which stops the daemon dead with no chance to run its exit
    // handler, so there is no breadcrumb to carry and claude-broker-diagnostics falls back to its
    // "killed outright" wording — literally the case that message was written for. Both spellings are
    // asserted, so neither platform silently reports nothing.
    assert.match(
      crashes[0].message ?? "",
      process.platform === "win32" ? /left no exit record/ : /signal-SIGTERM/,
      "…and carries the dead daemon's own recorded cause",
    )
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = recordOf(); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// A mark left for one daemon must never explain a LATER one's genuine death. The generation is what
// keeps the suppression narrow; the one-shot consume is what keeps it from outliving its resume.
test("the retirement mark is one-shot and names the exact daemon it explains", () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-mark-"))
  try {
    assert.equal(takeBrokerRetirement(dir, "sess-none"), null, "no mark, nothing to explain")
    markBrokerRetired(dir, "sess-1", "hibernate", "gen-a")
    const mark = takeBrokerRetirement(dir, "sess-1")
    assert.equal(mark?.reason, "hibernate")
    assert.equal(mark?.generation, "gen-a", "the mark names the daemon it was left for")
    assert.equal(takeBrokerRetirement(dir, "sess-1"), null, "…and reading it consumes it")
    // It sits in the record directory but must never be READ as a record: liveBrokerRecords() unlinks
    // every *.json there whose pid probe fails, which would delete the mark the moment it was written.
    markBrokerRetired(dir, "sess-2", "retire", "gen-b")
    assert.equal(liveBrokerRecords(dir).length, 0)
    assert.ok(existsSync(claudeBrokerRetirementPath(dir, "sess-2")), "the mark survives a live-record enumeration")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- the lifted worker caps actually reach a worker ------------------------------------------------
// dispatch.ts lifts Claude Code's WebSearch and sub-agent ceilings far above their 200/200/20 defaults,
// with a page of reasoning about why a long-lived frizz worker hits them and a chat session does not.
// None of it reached a worker. The caps were set only by `claudeWorkerEnvironment()`, which only the
// argv builder called, and the argv builder has had no caller since the broker became the sole Claude
// transport; the bridge spread `CLAUDE_WORKER_ENV`, which did not carry them. Nothing failed — the
// worker simply ran on the defaults the lift existed to escape, and `backend/types.ts` recorded the
// split as a known distinction rather than a defect (found 2026-08-19).
//
// Asserted against the REAL forked process's own environment rather than against the record frizz
// composes, because composing it correctly is exactly what was never in doubt.
test("the lifted worker caps reach the process the broker actually forks", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-caps-"))
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const reportedCeilings: Array<number | undefined> = []
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    // The compaction window rides the same composed environment as the caps, read from Settings at
    // fork time — so the same startup capture proves it reaches the process (added 2026-08-26).
    getSettings: () => ({ autoCompactWindow: 123_456 }),
    onCompactionWindow: (_sessionId, window) => reportedCeilings.push(window),
  })
  const sessionId = randomUUID()
  const slug = "caps-thread"
  const startup = () => {
    try {
      return readFileSync(join(dir, "capture.jsonl"), "utf8")
        .split("\n").filter(Boolean)
        .map((l) => JSON.parse(l) as { kind: string; environment?: Record<string, unknown> })
        .find((r) => r.kind === "startup")
    } catch { return undefined }
  }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "do the thing", permissionMode: "default" })
    const deadline = Date.now() + 10_000
    while (!startup() && Date.now() < deadline) await sleep(100)
    const env = startup()?.environment
    assert.ok(env, "the fake claude recorded its startup environment")
    assert.equal(env.maxWebSearches, String(WORKER_MAX_WEB_SEARCHES), "the web-search lift reaches the worker")
    assert.equal(env.maxSubagents, String(WORKER_MAX_SUBAGENTS), "the sub-agent spawn lift reaches the worker")
    assert.equal(env.forkSubagent, "0", "the fork switch reaches the worker, so its Agent tool offers no fork")
    assert.equal(env.maxConcurrentSubagents, String(WORKER_MAX_CONCURRENT_SUBAGENTS), "the concurrency lift reaches the worker")
    assert.equal(env.autoCompactWindow, "123456", "Settings.autoCompactWindow reaches the worker as CLAUDE_CODE_AUTO_COMPACT_WINDOW")
    // …and comes back OUT again, which is how the board's context dial learns the room this session
    // actually has. The daemon stamps the ceiling it forked with onto its own record, so the value
    // survives a frizz restart adopting it — that record, not today's Settings, is what a reattach
    // reports (see ClaudeRuntimeIngest.noteCompactionWindow).
    assert.equal(readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))?.compactionWindow, 123_456, "the daemon records the ceiling it forked with")
    assert.deepEqual(reportedCeilings, [123_456], "…and the bridge reports it once, at attach")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// THE LAUNCH PREFIX, end to end through real processes: Settings → the bridge → a forked broker daemon
// → the Agent SDK → the operator's wrapper → claude. The wrapper adds a variable and `exec`s what it is
// handed, which is what `op run --` / `env FOO=bar` do; the fake CLI reports the variable back, so the
// assertion holds only if the wrapper really sat between the daemon and claude. Then the half that
// matters for an operator who mistypes it: a prefix that cannot be used fails a NEW worker with a
// sentence naming it, and never the reattach to one already running.
test("a launch prefix from Settings wraps the claude the broker forks, and a bad one fails only a fork", { timeout: 30_000, skip: process.platform === "win32" ? "the wrapper is a POSIX sh script" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-prefix-"))
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const wrapper = join(dir, "inject-vars")
  const marker = join(dir, "wrapper-argv")
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\nFRIZZ_FAKE_INHERITED=from-the-wrapper\nexport FRIZZ_FAKE_INHERITED\nshift\nexec "$@"\n`)
  chmodSync(wrapper, 0o700)
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  let prefix = `'${wrapper}' --via-frizz`
  const getSettings = () => ({ launchPrefix: { claude: prefix } })
  const bridge = createClaudeAgentBrokerBridge({ stateDir: dir, executablePath: exe, env, getSettings })
  const adopter = createClaudeAgentBrokerBridge({ stateDir: dir, executablePath: exe, env, getSettings })
  const sessionId = randomUUID()
  const slug = "prefixed"
  const recordPath = claudeBrokerRecordPath(dir, sessionId)
  const startup = () => {
    try {
      return readFileSync(join(dir, "capture.jsonl"), "utf8")
        .split("\n").filter(Boolean)
        .map((l) => JSON.parse(l) as { kind: string; environment?: Record<string, unknown> })
        .find((r) => r.kind === "startup")
    } catch { return undefined }
  }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "do the thing", permissionMode: "default" })
    const deadline = Date.now() + 10_000
    while (!startup() && Date.now() < deadline) await sleep(100)
    assert.equal(startup()?.environment?.frizzFakeInheritedPresent, true, "the variable the wrapper exported reached claude")
    const wrapperArgv = readFileSync(marker, "utf8").trimEnd().split("\n")
    assert.equal(wrapperArgv[0], "--via-frizz", "the wrapper got its own words first")
    assert.ok(wrapperArgv.includes("--output-format"), "…and the CLI's own argv after them")

    // A frizz restart with a prefix that no longer parses still reaches the daemon that is running.
    bridge.close()
    prefix = "sh -c 'exec"
    const daemonPid = readBrokerRecord(recordPath)?.daemonPid
    const deliveryId = randomUUID()
    await adopter.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "carry on", deliveryId })
    assert.equal(readBrokerRecord(recordPath)?.daemonPid, daemonPid, "the follow-up was delivered to the adopted daemon")

    // A NEW worker under the same prefix fails, saying why, before any daemon is forked for it.
    await assert.rejects(
      adopter.spawnDispatch({ threadSlug: "fresh", sessionId: randomUUID(), cwd: dir, prompt: "x", permissionMode: "default" }),
      /Claude Code launch prefix in this project's settings cannot be used: A single quote is never closed/,
    )
    prefix = join(dir, "no-such-wrapper")
    await assert.rejects(
      adopter.spawnDispatch({ threadSlug: "fresh-2", sessionId: randomUUID(), cwd: dir, prompt: "x", permissionMode: "default" }),
      /starts `.*no-such-wrapper`, which is not an executable file/,
    )
    prefix = "frizz-no-such-launch-prefix-command --"
    await assert.rejects(
      adopter.spawnDispatch({ threadSlug: "fresh-3", sessionId: randomUUID(), cwd: dir, prompt: "x", permissionMode: "default" }),
      /starts `frizz-no-such-launch-prefix-command`, which was not found on PATH/,
    )
  } finally {
    adopter.releaseSession(slug, sessionId, "session-deleted")
    adopter.close()
    bridge.close()
    try { const r = readBrokerRecord(recordPath); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// SINGLE-FLIGHT COLD RESUME. A hibernated thread whose operator answers its questions receives two
// inputs in the same instant — the waker's delivery of the answers and the operator's own send — and
// each used to find no live daemon and fork one. On 2026-09-30 that put two daemons on one session
// (pids 51062/51063) and, via the loser's teardown deleting the survivor's socket, lost every send that
// followed. Both calls must ride ONE fork, and both messages must reach the claude that fork started.
// Negative control: against the pre-single-flight bridge, the `started` count below is 2.
test("concurrent follow-ups to a daemon-less thread share ONE cold resume, and both reach claude", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-single-"))
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const bridge = createClaudeAgentBrokerBridge({ stateDir: dir, executablePath: exe, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } })
  const sessionId = randomUUID()
  const slug = "answered-while-hibernated"
  const capture = () => { try { return readFileSync(join(dir, "capture.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; uuid?: string }) } catch { return [] } }
  const daemonStarts = () => { try { return readFileSync(claudeBrokerDiagnosticLogPath(dir, sessionId), "utf8").split("\n").filter((l) => l.includes('"phase":"started"')).length } catch { return 0 } }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "start", permissionMode: "default" })
    const first = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))!
    for (let i = 0; i < 100 && !capture().some((r) => r.kind === "startup"); i++) await sleep(50)
    bridge.retireDaemon({ threadSlug: slug, sessionId, reason: "hibernate" })
    for (let i = 0; i < 100; i++) { try { process.kill(first.daemonPid, 0); await sleep(50) } catch { break } }
    const startsBefore = daemonStarts()

    const answers = randomUUID(), steer = randomUUID()
    await Promise.all([
      bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "4 question answers", deliveryId: answers }),
      bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "and the operator's own send", deliveryId: steer }),
    ])
    assert.equal(daemonStarts() - startsBefore, 1, "exactly one daemon cold-resumed the session")
    // Resolved ⇒ acknowledged by the daemon, so both are already in the session's input queue.
    for (let i = 0; i < 100 && !(capture().some((r) => r.uuid === answers) && capture().some((r) => r.uuid === steer)); i++) await sleep(50)
    assert.ok(capture().some((r) => r.kind === "user-input" && r.uuid === answers), "the waker's answers reached claude")
    assert.ok(capture().some((r) => r.kind === "user-input" && r.uuid === steer), "the operator's send reached claude")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// A SERVER BOOTS ON A MACHINE WITH NO `claude`. The bridge is built during context creation, and it
// used to resolve its executable right there: with the bare name and none on PATH, that threw out of
// context creation and nothing started at all. Both shapes a caller can hand it are built, and each
// names the missing executable when a thread is started, which is the only thing that needs one.
// Negative control: resolving a fixed name at construction throws from the first line of the loop body.
test("a bridge whose claude is nowhere on PATH is built, and says so only when a thread is started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-no-claude-"))
  const env = { PATH: join(dir, "nothing-here"), HOME: dir }
  try {
    for (const executablePath of ["claude", () => "claude"]) {
      const bridge = createClaudeAgentBrokerBridge({ stateDir: dir, executablePath, env })
      try {
        await assert.rejects(
          bridge.spawnDispatch({ threadSlug: "no-claude-here", sessionId: randomUUID(), cwd: dir, prompt: "start", permissionMode: "default" }),
          /could not resolve 'claude' to an absolute executable path on PATH/u,
        )
      } finally {
        bridge.close()
      }
    }
  } finally {
    await rmEventually(dir)
  }
})

// A character the wire cannot carry used to cost the operator the whole send: the bridge refused it
// with "This message holds a control or incomplete character frizz can't send. Edit and resend.", and
// the human was left hunting an invisible character through their own paste (maintainer 2026-10-13:
// "wtf why not strip this?"). The daemon on the other end of this socket still runs the refusing
// validator, so the message arriving at all is the proof the bridge cleaned it before the frame.
// Negative control: against the refusing bridge, the first `followUp` below rejects.
test("a follow-up and a dispatch carrying undeliverable characters arrive without them", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-strip-"))
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const bridge = createClaudeAgentBrokerBridge({ stateDir: dir, executablePath: exe, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } })
  const sessionId = randomUUID()
  const slug = "pasted-with-a-stray-character"
  const inputs = () => { try { return readFileSync(join(dir, "capture.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; uuid?: string; text?: string }).filter((r) => r.kind === "user-input") } catch { return [] } }
  const esc = String.fromCodePoint(27), lineSeparator = String.fromCodePoint(0x2028), loneSurrogate = String.fromCharCode(0xd83d)
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: `start${String.fromCodePoint(0)} here`, permissionMode: "default" })
    const deliveryId = randomUUID()
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: `first line${lineSeparator}second ${esc}[1mline${loneSurrogate} 🚀`, deliveryId })
    for (let i = 0; i < 100 && !inputs().some((r) => r.uuid === deliveryId); i++) await sleep(50)
    assert.equal(inputs().find((r) => r.uuid === deliveryId)?.text, "first line\nsecond [1mline 🚀", "the follow-up reached claude with the characters taken out and nothing else changed")
    assert.ok(inputs().some((r) => r.text === "start here"), "…and so did the dispatch's opening prompt")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// SEND NOW, from the bridge to the CLI through a daemon it really forked. The operator's message has to
// arrive saying a person typed it, and the send-now has to name that message by the uuid the CLI queued
// it under — an id that is not that uuid is left out, because a name the CLI has never heard makes the
// request do nothing at all.
test("send now reaches the CLI as its own send-now, for a message it was told a person typed", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sendnow-"))
  const exe = join(dir, "fake-claude--send-now.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const bridge = createClaudeAgentBrokerBridge({ stateDir: dir, executablePath: exe, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } })
  const sessionId = randomUUID()
  const slug = "read-this-now"
  const rows = () => { try { return readFileSync(join(dir, "capture.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) } catch { return [] } }
  const sendNows = () => rows().filter((r) => r.kind === "host-control" && r.subtype === "interrupt")
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "start", permissionMode: "default" })
    const deliveryId = randomUUID()
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "read this now", deliveryId, human: true })
    assert.equal(bridge.interruptTurn({ threadSlug: slug, sessionId, deliveryId }), true)
    for (let i = 0; i < 100 && sendNows().length < 1; i++) await sleep(50)
    assert.deepEqual(rows().find((r) => r.kind === "user-input" && r.uuid === deliveryId)?.origin, { kind: "human" })
    assert.equal(rows().find((r) => r.kind === "user-input" && r.text === "start")?.origin, undefined, "the dispatch prompt makes no such claim")
    assert.equal(sendNows()[0]?.sendNow, true)
    assert.equal(sendNows()[0]?.messageUuid, deliveryId)

    assert.equal(bridge.interruptTurn({ threadSlug: slug, sessionId, deliveryId: "not-the-uuid-the-cli-knows" }), true)
    for (let i = 0; i < 100 && sendNows().length < 2; i++) await sleep(50)
    assert.equal(sendNows()[1]?.sendNow, true)
    assert.equal(sendNows()[1]?.messageUuid, undefined, "an unnameable message leaves the send-now speaking for whatever waits")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// A daemon forked by an OLDER build survives the upgrade by hours and has no `input-result` to send.
// The bridge must read that off the record and not wait for an answer that never comes — a follow-up
// to such a thread would otherwise fail every time, 30s late. Simulated by stripping the capability
// from a current daemon's record before a fresh bridge adopts it, which is exactly what an old
// daemon's record looks like; the frame then carries no requestId and the daemon sends no reply.
test("a follow-up to a daemon that predates input acknowledgement still resolves and still arrives", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-noack-"))
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "old-daemon"
  const recordPath = claudeBrokerRecordPath(dir, sessionId)
  const bridge = createClaudeAgentBrokerBridge({ stateDir: dir, executablePath: exe, env })
  const adopter = createClaudeAgentBrokerBridge({ stateDir: dir, executablePath: exe, env })
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "start", permissionMode: "default" })
    bridge.close() // a frizz restart
    const record = readBrokerRecord(recordPath)!
    assert.ok(record.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_INPUT_ACK), "precondition: a current daemon advertises the capability")
    writeFileSync(recordPath, JSON.stringify({ ...record, capabilities: record.capabilities!.filter((c) => c !== CLAUDE_BROKER_CAPABILITY_INPUT_ACK) }))
    const deliveryId = randomUUID()
    const started = Date.now()
    await adopter.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "carry on", deliveryId })
    assert.ok(Date.now() - started < 10_000, "resolved on the write, not after an acknowledgement deadline")
    assert.equal(readBrokerRecord(recordPath)?.daemonPid, record.daemonPid, "it was delivered to the adopted daemon, not a fresh fork")
    let seen = false
    for (let i = 0; i < 100 && !seen; i++) { try { seen = readFileSync(join(dir, "capture.jsonl"), "utf8").includes(deliveryId) } catch {} if (!seen) await sleep(50) }
    assert.ok(seen, "the message reached claude")
  } finally {
    adopter.releaseSession(slug, sessionId, "session-deleted")
    adopter.close()
    try { const r = readBrokerRecord(recordPath); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})
