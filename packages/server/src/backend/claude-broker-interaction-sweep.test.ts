// A Claude interaction that outlives its answerability must be TERMINALIZED, not left pending.
//
// The defect these pin, from a live thread: a `claude`/`agent-question` row journaled
// 2026-08-02T02:23:52Z on `https-varlock-dev-integrations-overview-can` was still `pending` a day
// later, rendering an answerable question card pinned to the tail of a transcript whose turn had long
// since moved past it. Nothing on the Claude side ever swept: `cancelForSession` was reached only from
// storage.ts (session replaced/deleted) and from the codex bridge, which retires its own on
// `turn/completed` and on a rebind onto a dead turn.
//
// Both tests drive the REAL fork/socket/daemon path with the fake CLI, because the whole question is
// what happens to the journal when a real turn ends and when a real daemon is gone — a stubbed bridge
// would be asserting the stub.
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { buildClaudePermissionInteraction } from "./claude-permission-interactions.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"

const fakeCli = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function rmEventually(dir: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(50)
    }
  }
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timeout")
    await sleep(50)
  }
}

function fakeExe(dir: string, scenario: string): string {
  const exe = join(dir, `fake-claude--${scenario}.mjs`)
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  return exe
}

/** Journal a pending Claude approval the way the bridge does, for a request nothing will answer. */
function seedOrphan(
  store: ReturnType<typeof createInteractionStore>,
  owner: { projectId: string; threadSlug: string; sessionId: string; cwd: string },
  requestId: string,
): string {
  const request = buildClaudePermissionInteraction(
    { requestId, toolName: "Bash", toolUseId: `tool-${requestId}`, input: { command: "echo orphan" }, suggestions: [] },
    owner,
  )
  assert.ok(request, "the fixture escalation is representable")
  return store.create(request).interaction.id
}

// A `result` ENDS the turn. A permission escalation holds the turn open by construction, so a card
// still pending when the result lands is a card the turn abandoned — the cc-worker PreToolUse hook and
// an unrepresentable-question refusal both answer the daemon directly, leaving anything already
// journaled for that escalation with nothing left to resolve it.
//
// The seeded row stands in for the card a PREVIOUS frizz journaled for a turn this one knows nothing
// about, which is exactly what the live thread was carrying. A plain turn (the `basic` scenario, which
// reaches `result` unaided) is deliberate: this test is about the SWEEP, and driving it through a
// scenario that has to be un-blocked first only couples it to whatever that block currently is. It was
// written against `ask` while AskUserQuestion was refused on the socket; the moment the refusal became
// a real card again the fake stopped emitting `result` at all and this hung for its full timeout.
test("a turn's result retires the interactions it left pending", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sweep-turn-"))
  const exe = fakeExe(dir, "basic")
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "sweep-turn"
  const projectId = "proj-sweep-turn"
  const scope = { projectId, threadSlug: slug, sessionId }
  const store = createInteractionStore(new Database(":memory:"))
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe, env, interactions: store, projectId,
  })
  try {
    const orphanId = seedOrphan(store, { projectId, threadSlug: slug, sessionId, cwd: dir }, "stranded-request-1")
    assert.equal(store.listPending(scope).length, 1, "the card starts out pending and answerable")

    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "ask me something", permissionMode: "default" })
    // The ask is denied on the socket, the fake answers its own tool call and emits `result`.
    await waitFor(() => store.listPending(scope).length === 0)

    const swept = store.get(scope, orphanId)
    assert.equal(swept?.lifecycle, "cancelled", "the abandoned card is terminal, not pending forever")
    assert.equal(swept?.cancellationReason, "turn-ended")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// The other half: a card journaled by a frizz that is GONE. The canUseTool promise lived in that
// daemon's process, `pendingPerms` is memory this bridge never had, and a cold resume re-asks inside a
// new turn under a new request id — so nothing can ever route an answer to it. This boot is the only
// thing that will notice, which is why it must sweep rather than skip.
//
// It also pins the ORDER of the reasons: a dead daemon is `provider-cancelled` (the turn's fate is
// unknown; the provider is provably gone), not `turn-ended`.
test("warmUp retires the interactions of an owned session whose daemon is gone", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sweep-boot-"))
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "sweep-boot"
  const projectId = "proj-sweep-boot"
  const scope = { projectId, threadSlug: slug, sessionId }
  const store = createInteractionStore(new Database(":memory:"))
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: fakeExe(dir, "permission"), env,
    interactions: store, projectId,
    ownedSessions: () => [{ threadSlug: slug, sessionId, cwd: dir }],
  })
  try {
    const orphanId = seedOrphan(store, { projectId, threadSlug: slug, sessionId, cwd: dir }, "ghost-request-1")
    assert.equal(store.listPending(scope).length, 1)

    await bridge.warmUp()

    assert.equal(store.listPending(scope).length, 0, "the boot sweep emptied the queue")
    const swept = store.get(scope, orphanId)
    assert.equal(swept?.lifecycle, "cancelled")
    assert.equal(swept?.cancellationReason, "provider-cancelled")
    // The sweep must never be mistaken for a reason to start something: warmUp still only ADOPTS.
    assert.equal(bridge.isDaemonAlive(sessionId), false, "no daemon was forked")
    assert.equal(bridge.binding(slug, sessionId), undefined, "no session was bound")
  } finally {
    bridge.close()
    await rmEventually(dir)
  }
})

// The regression guard for the sweep itself: warmUp used to bail on `live.size === 0`, which is the
// single most common boot there is — every frizz start after every daemon has aged out. If that early
// return comes back, the sweep silently never runs on exactly the boots that need it, and this is the
// only test that would notice. A second owned session with a still-pending card and no daemon anywhere
// makes the zero-live-daemons path explicit rather than incidental.
test("the boot sweep runs when NO daemon is alive at all", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sweep-none-"))
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const projectId = "proj-sweep-none"
  const store = createInteractionStore(new Database(":memory:"))
  const owned = [
    { threadSlug: "ghost-a", sessionId: randomUUID(), cwd: dir },
    { threadSlug: "ghost-b", sessionId: randomUUID(), cwd: dir },
  ]
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: fakeExe(dir, "permission"), env,
    interactions: store, projectId, ownedSessions: () => owned,
  })
  try {
    for (const target of owned) {
      seedOrphan(store, { projectId, ...target }, `ghost-${target.threadSlug}`)
    }
    await bridge.warmUp()
    for (const target of owned) {
      const scope = { projectId, threadSlug: target.threadSlug, sessionId: target.sessionId }
      assert.equal(store.listPending(scope).length, 0, `${target.threadSlug} was swept`)
    }
  } finally {
    bridge.close()
    await rmEventually(dir)
  }
})

// A LIVE daemon re-delivers its held escalation on reattach, so its cards are answerable and must
// survive the boot untouched. This is the control that keeps the sweep above from becoming a boot that
// throws away every pending approval it finds.
test("warmUp leaves the interactions of a session whose daemon is still alive alone", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sweep-live-"))
  const exe = fakeExe(dir, "permission")
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "sweep-live"
  const projectId = "proj-sweep-live"
  const scope = { projectId, threadSlug: slug, sessionId }
  const store = createInteractionStore(new Database(":memory:"))
  // frizz #1 raises a real escalation and journals a real card, then goes away leaving the daemon up.
  const first = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe, env, interactions: store, projectId,
  })
  let second: ReturnType<typeof createClaudeAgentBrokerBridge> | undefined
  try {
    await first.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "do the thing", permissionMode: "default" })
    await waitFor(() => store.listPending(scope).length > 0)
    const [live] = store.listPending(scope)
    first.close()
    await sleep(300)
    assert.ok(readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)), "the daemon outlived frizz #1")

    second = createClaudeAgentBrokerBridge({
      stateDir: dir, executablePath: exe, env, interactions: store, projectId,
      ownedSessions: () => [{ threadSlug: slug, sessionId, cwd: dir }],
    })
    await second.warmUp()
    await sleep(500)

    assert.equal(store.get(scope, live.id)?.lifecycle, "pending", "an answerable card survives the boot")
    assert.equal(store.get(scope, live.id)?.expiresAt, live.expiresAt, "and keeps the deadline it was shown with")
    assert.ok(second.binding(slug, sessionId), "and its session was adopted, not swept")
  } finally {
    second?.releaseSession(slug, sessionId, "session-deleted")
    second?.close()
    first.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// THE THIRD SWEEP, and the one a native AskUserQuestion depends on to be shippable at all.
//
// An ask PARKS the turn inside canUseTool. So an operator who reads the card and then types a follow-up
// instead of clicking an option — "actually forget that, do X" — used to get nothing at all: `sendInput`
// wrote the frame, the parked turn never reached the point of consuming it, and the message sat queued
// and unread. That is precisely how `https-varlock-dev-integrations-overview-can` stranded two operator
// messages for 90 minutes, and it is the ONE property a ```question fence has for free that a native ask
// does not — a fence ends the turn, so the next message is just the next message.
//
// The `ask` scenario is the right driver here (unlike the turn-ended test above): the whole point is a
// card that is genuinely holding a live turn open, which is the only state this sweep exists for.
// The other half of that rule: a message NOBODY TYPED supersedes nothing. A scheduled wake reaches the
// same `followUp`, and until 2026-10-10 it retired the card the same way — so a timer coming due, a
// schedule beat or a report held past the scheduler's mid-turn ceiling answered an open approval `deny`
// on the operator's behalf, and told a question-blocked model to "read their next message", which was
// the wake's own text.
test("an automatic follow-up leaves the open card open, and the turn parked, until the operator answers", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sweep-wake-"))
  const exe = fakeExe(dir, "permission")
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "sweep-wake"
  const projectId = "proj-sweep-wake"
  const scope = { projectId, threadSlug: slug, sessionId }
  const store = createInteractionStore(new Database(":memory:"))
  let results = 0
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe, env, interactions: store, projectId,
    onEvent: (_slug, _sid, ev) => { if (ev.kind === "result") results++ },
  })
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "do the thing", permissionMode: "default" })
    await waitFor(() => store.listPending(scope).length > 0)
    const [card] = store.listPending(scope)

    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "[timer] check the deploy", keepOpenCards: true })
    await sleep(600)
    assert.deepEqual(store.listPending(scope).map((r) => r.id), [card.id], "the approval is still the operator's to give")
    assert.equal(results, 0, "and the turn is still parked on it")

    store.resolve(scope, {
      slug, sessionId, interactionId: card.id, sessionEpoch: card.owner.sessionEpoch, capabilityRevision: card.owner.capabilityRevision,
      expectedRecordRevision: card.recordRevision, responseId: `r-${card.id}`, decisionId: "grant-turn",
    })
    await waitFor(() => results > 0)
    assert.equal(store.get(scope, card.id)?.lifecycle, "resolved", "answered by the operator, not cancelled by the wake")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

test("a follow-up sent instead of an answer retires the open card and UNBLOCKS the turn", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sweep-steer-"))
  const exe = fakeExe(dir, "ask")
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "sweep-steer"
  const projectId = "proj-sweep-steer"
  const scope = { projectId, threadSlug: slug, sessionId }
  const store = createInteractionStore(new Database(":memory:"))
  let results = 0
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe, env, interactions: store, projectId,
    onEvent: (_slug, _sid, ev) => { if (ev.kind === "result") results++ },
  })
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "ask me something", permissionMode: "default" })
    // The daemon raises AskUserQuestion and the bridge journals it as a real, answerable question card.
    await waitFor(() => store.listPending(scope).length > 0)
    const [card] = store.listPending(scope)
    assert.equal(card.payload.kind, "agent-question", "the ask is a question card, not an approval")
    // THE PRECONDITION, and the whole reason this sweep exists: the turn is parked. Assert it rather
    // than assume it, or the test below passes just as well against a turn that was never blocked.
    assert.equal(results, 0, "the turn is parked on the open question")

    // The operator types instead of clicking.
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "forget the question, just pick one" })

    await waitFor(() => store.listPending(scope).length === 0)
    const retired = store.get(scope, card.id)
    assert.equal(retired?.lifecycle, "cancelled", "the superseded card is terminal, not left answerable")
    assert.equal(retired?.cancellationReason, "user-cancelled")
    // Retiring the journal row is only half of it. The deny has to reach the DAEMON so the tool call
    // unwinds — otherwise the card is gone from the queue and the turn is still parked behind it, which
    // is strictly worse than the bug. A `result` is the observable proof the turn moved again.
    await waitFor(() => results > 0)
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// The THIRD way a session stops being answerable, and the one nothing swept: an operator pressing Stop
// or "Mark as done". Both reach router.stopThreadRuntime, which SIGTERMs the daemon by record via
// releaseSession — and releaseSession swept only `pendingPerms`, its own PROCESS memory. The durable
// journal row stayed `pending`.
//
// Nothing else catches it afterwards. `cancelForSession` runs from storage.ts only on a session DELETE
// or REPLACE, and a completion is neither: it UPDATEs the row to state='archived'. The boot sweep
// cannot help either, because `ownedSessions` filters archived rows out by design ("never wake a thread
// the human has already put away") — so warmUp will not see this row at this boot or any future one.
// And Claude's two create sites both journal `expiresAt: null`, so `expireDue` will never reach it.
//
// The result is the exact 2026-08-02 defect through a different door: reopening the thread from Done
// renders a live, answerable card for a daemon that has been dead since the day it was completed, and
// answering it flips the journal while telling nobody. releaseSession already RECEIVES the reason it
// needs — router passes "session-deleted" — it just dropped the argument on the floor.
test("releaseSession terminalizes the journal, not just its own process memory", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sweep-release-"))
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "sweep-release"
  const projectId = "proj-sweep-release"
  const scope = { projectId, threadSlug: slug, sessionId }
  const store = createInteractionStore(new Database(":memory:"))
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: fakeExe(dir, "permission"), env,
    interactions: store, projectId,
    // Archived by completion: the boot sweep is filtered away from this row forever.
    ownedSessions: () => [],
  })
  try {
    const orphanId = seedOrphan(store, { projectId, threadSlug: slug, sessionId, cwd: dir }, "released-request-1")
    assert.equal(store.listPending(scope).length, 1)

    bridge.releaseSession(slug, sessionId, "session-deleted")

    assert.equal(store.listPending(scope).length, 0, "a stopped session leaves no answerable card")
    const swept = store.get(scope, orphanId)
    assert.equal(swept?.lifecycle, "cancelled")
    assert.equal(swept?.cancellationReason, "session-deleted", "and it says WHY it went away")
  } finally {
    bridge.close()
    await rmEventually(dir)
  }
})
