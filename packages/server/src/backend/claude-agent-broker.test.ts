// CI-runnable protocol test for the Claude session broker + its client, driven by the FAKE claude CLI
// (no real claude, no network — fast and deterministic). Proves the broker↔client typed socket
// protocol, the permission round-trip over the socket, and — the reason the broker exists —
// reconnect with a PENDING permission re-delivered to a fresh client.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID, createHash } from "node:crypto"
import net from "node:net"
import { test } from "node:test"
import assert from "node:assert/strict"
import { runClaudeBroker } from "./claude-agent-broker.ts"
import { frizzIpcPath } from "./ipc-path.ts"
import { connectClaudeBroker, type ClaudeBrokerClient } from "./claude-broker-client.ts"
import { CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX, type ClaudeDiagnostic, type ClaudePermissionRequest, type ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"
import { BROKER_DISALLOWED_TOOLS } from "./types.ts"

const fakeCli = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))

// Short endpoint name (macOS unix sockets cap at ~104 bytes); frizzIpcPath spells it as a unix socket
// on POSIX and a named pipe on Windows, which has no filesystem sockets at all — binding one there
// fails `listen EACCES` and every test below then times out waiting for a broker that never listened.
function shortSocket(): string {
  return frizzIpcPath(`cbt-${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16)}`)
}

interface Captured { events: ClaudeQueryEvent[]; perms: { requestId: string; request: ClaudePermissionRequest }[]; withdrawn: string[]; hellos: string[]; diagnostics: ClaudeDiagnostic[] }
function clientWith(socketPath: string): { client: ClaudeBrokerClient; cap: Captured; waitPerm: (ms?: number) => Promise<{ requestId: string; request: ClaudePermissionRequest }>; waitEvent: (pred: (e: ClaudeQueryEvent) => boolean, ms?: number) => Promise<ClaudeQueryEvent> } {
  const cap: Captured = { events: [], perms: [], withdrawn: [], hellos: [], diagnostics: [] }
  const permWaiters: ((v: any) => void)[] = []
  const eventWaiters: { pred: (e: ClaudeQueryEvent) => boolean; resolve: (e: ClaudeQueryEvent) => void }[] = []
  const client = connectClaudeBroker(socketPath, {
    onHello: (sid) => cap.hellos.push(sid),
    onEvent: (e) => { cap.events.push(e); for (let i = eventWaiters.length - 1; i >= 0; i--) if (eventWaiters[i].pred(e)) { eventWaiters[i].resolve(e); eventWaiters.splice(i, 1) } },
    onPermissionRequest: (requestId, request) => { const p = { requestId, request }; cap.perms.push(p); const w = permWaiters.shift(); if (w) w(p) },
    onPermissionWithdrawn: (requestId) => cap.withdrawn.push(requestId),
    onDiagnostic: (diagnostic) => cap.diagnostics.push(diagnostic),
  })
  return {
    client, cap,
    waitPerm: (ms = 5_000) => new Promise((res, rej) => { const p = cap.perms[0]; if (p) return res(p); const t = setTimeout(() => rej(new Error("waitPerm timeout")), ms); permWaiters.push((v) => { clearTimeout(t); res(v) }) }),
    waitEvent: (pred, ms = 5_000) => new Promise((res, rej) => { const e = cap.events.find(pred); if (e) return res(e); const t = setTimeout(() => rej(new Error("waitEvent timeout")), ms); eventWaiters.push({ pred, resolve: (e) => { clearTimeout(t); res(e) } }) }),
  }
}

function startBroker(scenario: string, extra: Partial<Parameters<typeof runClaudeBroker>[0]> = {}): { socketPath: string; close: () => Promise<void>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cbroker-"))
  const exe = join(dir, `fake-claude--${scenario}.mjs`)
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const socketPath = shortSocket()
  // CLAUDE_CONFIG_DIR is the fixture's own, not the developer's `~/.claude`: the daemon fingerprints that
  // directory to notice a plugin closure that moved (claude-plugin-sync.ts), and a skill some live
  // session installs in the real one mid-test would put a reload request into a control sequence a test
  // here counts. HOME stays real — the stand-in CLI is started through whatever `node` PATH resolves.
  const broker = runClaudeBroker({ socketPath, cwd: dir, sessionId: randomUUID(), executablePath: exe, permissionMode: "default", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CLAUDE_CONFIG_DIR: join(dir, "claude-config") }, ...extra })
  return { socketPath, close: async () => { await broker.close(); rmSync(dir, { recursive: true, force: true }) }, dir }
}

// The fake CLI writes one JSON record per line beside its executable; `session-title` rows are the
// `generate_session_title` control requests the broker issued.
function captureRows(dir: string): { kind: string; description?: string; persist?: boolean }[] {
  try {
    return readFileSync(join(dir, "capture.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
  } catch { return [] }
}
async function waitForRows(dir: string, predicate: (rows: ReturnType<typeof captureRows>) => boolean, ms = 5_000): Promise<ReturnType<typeof captureRows>> {
  const deadline = Date.now() + ms
  for (;;) {
    const rows = captureRows(dir)
    if (predicate(rows)) return rows
    if (Date.now() > deadline) return rows
    await new Promise((r) => setTimeout(r, 50))
  }
}

// What a worker is started WITHOUT, read off the arguments the CLI was really given. Claude Code's own
// schedulers never fired while a background task was outstanding, so the contract warned every worker off
// them; now they are simply not offered (BROKER_DISALLOWED_TOOLS). AskUserQuestion stays: this path
// draws it as a card.
test("a worker's CLI is started without Claude Code's own schedulers, and with AskUserQuestion", { timeout: 15_000 }, async () => {
  const b = startBroker("basic")
  try {
    const rows = await waitForRows(b.dir, (r) => r.some((row) => row.kind === "startup"))
    const argv = (rows.find((row) => row.kind === "startup") as unknown as { argv: string[] } | undefined)?.argv ?? []
    const flag = argv.find((arg) => arg.startsWith("--disallowedTools="))
    assert.ok(flag, `the CLI was given no --disallowedTools: ${argv.join(" ")}`)
    const taken = flag.slice("--disallowedTools=".length).split(",")
    assert.equal(taken.join(","), BROKER_DISALLOWED_TOOLS.join(","))
    for (const tool of ["ScheduleWakeup", "CronCreate"]) assert.ok(taken.includes(tool), `${tool} is still offered`)
    assert.ok(!taken.includes("AskUserQuestion"), "a question still has a card to go to")
  } finally { await b.close() }
})

// The diagnostics log recorded a DROPPED input but never a RECEIVED one, and the drop line fires only
// when `handle.send` REJECTS. A send that never completes — an agent wedged before it drains stdin —
// left the file byte-identical to one where the frame never arrived at all, so the two were
// indistinguishable. That ambiguity is what stalled the 2026-07-31 investigation into a thread whose
// diagnostics held a single `started` line. Receipt is now recorded: ids and sizes ONLY, because the
// message text is the operator's content and must never be written to a diagnostics file.
test("the daemon records every input frame on receipt, without the message text", { timeout: 15_000 }, async () => {
  const sessionId = randomUUID()
  const logDir = mkdtempSync(join(tmpdir(), "cbroker-diag-"))
  const diagnosticLogPath = join(logDir, "diag.log")
  const b = startBroker("basic", { sessionId, diagnosticLogPath })
  const SECRET = "the Landlock people, and this text must never reach the diagnostics file"
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    const id = randomUUID()
    c.client.sendInput({ id, text: SECRET })
    await c.waitEvent((e) => e.kind === "result")

    const log = readFileSync(diagnosticLogPath, "utf8")
    const received = log.split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => typeof r.diagnostic?.message === "string" && r.diagnostic.message.startsWith("input received:"))
    assert.equal(received.length, 1, "exactly one receipt line for one input frame")
    assert.match(received[0].diagnostic.message, new RegExp(`id=${id}\\b`), "the receipt names the input's id")
    assert.match(received[0].diagnostic.message, new RegExp(`chars=${SECRET.length}\\b`), "the receipt carries the size")
    assert.ok(!log.includes(SECRET), "the operator's prompt text is NEVER written to the diagnostics log")
    c.client.close()
  } finally {
    await b.close()
    rmSync(logDir, { recursive: true, force: true })
  }
})

// A refused input has to reach the ATTACHED CLIENT, not just the diagnostics file on disk. The `input`
// frame carries no reply by design, so this relay is the only channel by which the frizz server can
// ever learn that a message it recorded as delivered was in fact thrown away — and until 2026-08-05 the
// server's own handler discarded every diagnostic that was not a daemon crash, so the channel ran into
// a wall. Thread `are-taking-over-an-in-flight-epic` refused every input for over two hours and said
// nothing anywhere an operator would look. Both ends are pinned here: the daemon emits the shared
// prefix, and a live client receives it.
test("a refused input is relayed to the attached client, not just written to the diagnostics file", { timeout: 15_000 }, async () => {
  // `hold-inputs` never answers, so the first send's uuid stays outstanding and the second is refused
  // as a duplicate — the cheapest way to make `handle.send` reject over the real socket.
  const b = startBroker("hold-inputs")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    const id = randomUUID()
    c.client.sendInput({ id, text: "the first send holds the uuid outstanding" })
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id, text: "the second send is refused" })
    const isDrop = (d: ClaudeDiagnostic): boolean => d.kind === "stderr" && d.message.startsWith(CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX)
    for (let waited = 0; waited < 5_000 && !c.cap.diagnostics.some(isDrop); waited += 50) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const drop = c.cap.diagnostics.find(isDrop)
    assert.ok(drop, "the client is told its message never reached the agent")
    assert.match(drop.kind === "stderr" ? drop.message : "", /already outstanding/, "the diagnostic names the refusal")
    c.client.close()
  } finally {
    await b.close()
  }
})

// A daemon shut down with a client still attached must not re-arm its idle timer. shutdown() clears the
// timer and destroys the client, and that socket's 'close' fires a tick later into the handler that
// arms the idle timer for an unattached daemon — so every embedded broker closed under a live client
// left a REF'D six-hour timer behind. Nothing failed: this file passed every test and then never exited
// (2026-10-01), which the runner reports only as a cancelled file once something kills it. Counted with
// a RAW socket rather than the broker client, whose reconnect timers would muddy the count, and through
// `getActiveResourcesInfo`, whose `Timeout` entries are exactly the ref'd timers that keep a process up.
test("a daemon shut down under an attached client leaves no timer holding the process open", { timeout: 15_000 }, async () => {
  const b = startBroker("basic")
  const refTimers = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length
  const sock = net.connect(b.socketPath)
  try {
    await new Promise<void>((res, rej) => { sock.once("data", () => res()); sock.once("error", rej) })
    const before = refTimers()
    const gone = new Promise<void>((res) => sock.once("close", () => res()))
    await b.close()
    await gone
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) // let the daemon side's 'close' land
    assert.ok(refTimers() <= before, `no ref'd timer outlives the daemon (before=${before}, after=${refTimers()})`)
  } finally { sock.destroy() }
})

// The composer typeahead's data path, end to end over the REAL socket: client `list-skills` frame →
// daemon dispatch → handle (initialize commands ∩ init-frame skills) → `skills-result` frame → client
// promise. The fake CLI's initialize response carries "review" and "explore" AND the built-in stand-in
// "compact"; only the first two are named by its init frame's `skills`, so only those may cross back.
// Each one's SOURCE has to survive the socket too, including the undefined one — the client re-checks
// the value against the closed set, and a bug there would silently strip every label.
test("listSkills round-trips the harness's skill list over the broker socket", { timeout: 15_000 }, async () => {
  const b = startBroker("basic")
  try {
    const c = clientWith(b.socketPath)
    await c.waitEvent((e) => e.kind === "init")
    assert.deepEqual(await c.client.listSkills(), [
      { name: "review", description: "Review changes", source: "project" },
      { name: "explore", description: "Explore the repository (dynamic workflow)", source: undefined },
    ])
    c.client.close()
  } finally {
    await b.close()
  }
})

test("broker relays a typed permission request and forwards the decision", { timeout: 15_000 }, async () => {
  const b = startBroker("permission")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "do the thing" })
    const perm = await c.waitPerm()
    assert.equal(perm.request.toolName, "Bash") // the fake CLI's permission scenario requests Bash
    assert.ok(typeof perm.requestId === "string")
    c.client.answerPermission(perm.requestId, { behavior: "allow" })
    const result = await c.waitEvent((e) => e.kind === "result")
    assert.equal(result.kind, "result")
    c.client.close()
  } finally { await b.close() }
})

// The SDK asks the host AND runs the PermissionRequest hooks side by side, and takes the host's copy
// back when a hook settles the request first — which the worker's policy hook does for nearly every
// request. Measured against real claude 2026-10-10: frizz was never told, so the card it had journaled
// sat in front of the operator, dead, until the turn ended.
test("a request the CLI settles inside the hold never reaches frizz at all", { timeout: 15_000 }, async () => {
  const b = startBroker("permission-settled-fast")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "do the thing" })
    await c.waitEvent((e) => e.kind === "result")
    assert.deepEqual(c.cap.perms, [], "no card for a request a hook answered in 30ms")
    assert.deepEqual(c.cap.withdrawn, [], "and nothing to take back, because nothing was shown")
    c.client.close()
  } finally { await b.close() }
})

test("a request frizz WAS shown is taken back when the CLI settles it", { timeout: 15_000 }, async () => {
  const b = startBroker("permission-settled-late")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "do the thing" })
    const perm = await c.waitPerm()
    await c.waitEvent((e) => e.kind === "result")
    assert.deepEqual(c.cap.withdrawn, [perm.requestId], "frizz is told the request it is showing no longer exists")
    c.client.close()
  } finally { await b.close() }
})

test("a pending permission is re-delivered to a client that reconnects (the broker's reason to exist)", { timeout: 15_000 }, async () => {
  const b = startBroker("permission")
  try {
    const c1 = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c1.client.sendInput({ id: randomUUID(), text: "do the thing" })
    const perm1 = await c1.waitPerm()
    assert.ok(perm1.requestId)
    // frizz "dies" mid-permission — drop the client WITHOUT answering.
    c1.client.close()
    await new Promise((r) => setTimeout(r, 300))
    // frizz "restarts" — a fresh client reconnects to the SAME live broker.
    const c2 = clientWith(b.socketPath)
    const helloAgain = await new Promise<boolean>((res) => { const t = setTimeout(() => res(false), 5_000); const iv = setInterval(() => { if (c2.cap.hellos.length) { clearInterval(iv); clearTimeout(t); res(true) } }, 50) })
    assert.ok(helloAgain, "reconnected client got a hello")
    const perm2 = await c2.waitPerm()
    assert.equal(perm2.requestId, perm1.requestId, "the SAME pending permission was re-delivered")
    c2.client.answerPermission(perm2.requestId, { behavior: "allow" })
    const result = await c2.waitEvent((e) => e.kind === "result")
    assert.equal(result.kind, "result", "the session continued after reconnect")
    c2.client.close()
  } finally { await b.close() }
})

// ─── The session title ────────────────────────────────────────────────────────────────────────────
// Claude Code titles a session by itself on the first user message — EXCEPT on the Agent-SDK
// transport with a SessionStart hook registered, which is exactly the broker's configuration (it
// always loads the cc-worker plugin). Bisected live against 2.1.220: a plugin carrying only a no-op
// SessionStart hook produces NO `ai-title` record, the same plugin with only PreToolUse/PostToolUse/
// PermissionRequest hooks titles normally. So the broker ASKS, and the board stops falling back to a
// truncation of the raw dispatch prompt.
test("the broker asks Claude to title the session from the first dispatch prompt", { timeout: 15_000 }, async () => {
  const b = startBroker("basic")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "Fix the login button on mobile" })
    const rows = await waitForRows(b.dir, (r) => r.some((row) => row.kind === "session-title"))
    const titles = rows.filter((row) => row.kind === "session-title")
    assert.equal(titles.length, 1, "exactly one title request")
    assert.equal(titles[0].description, "Fix the login button on mobile", "titled from the dispatch prompt")
    assert.equal(titles[0].persist, true, "persisted — an unpersisted title never reaches the transcript frizz reads")
    c.client.close()
  } finally { await b.close() }
})

test("a follow-up never retitles the thread", { timeout: 15_000 }, async () => {
  const b = startBroker("basic")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "first prompt" })
    await waitForRows(b.dir, (r) => r.some((row) => row.kind === "session-title"))
    c.client.sendInput({ id: randomUUID(), text: "and now something completely different" })
    await new Promise((r) => setTimeout(r, 600))
    const titles = captureRows(b.dir).filter((row) => row.kind === "session-title")
    assert.equal(titles.length, 1, "still exactly one title request")
    assert.equal(titles[0].description, "first prompt")
    c.client.close()
  } finally { await b.close() }
})

test("a resumed session keeps the title its transcript already carries", { timeout: 15_000 }, async () => {
  const b = startBroker("basic", { resume: true })
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "carry on where we left off" })
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(captureRows(b.dir).filter((row) => row.kind === "session-title").length, 0, "no title request on resume")
    c.client.close()
  } finally { await b.close() }
})

test("a failed title request neither throws nor stops the turn", { timeout: 15_000 }, async () => {
  const b = startBroker("title-failure")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "do the thing" })
    const result = await c.waitEvent((e) => e.kind === "result")
    assert.equal(result.kind, "result", "the turn completed despite the title request failing")
    // The title request is deliberately NOT awaited by the turn, so it races the result event: under
    // load the turn can complete before the fake CLI has flushed its capture row. Wait for the row
    // instead of sampling it — the assertion is that the request happened, not that it happened first.
    const rows = await waitForRows(b.dir, (r) => r.some((row) => row.kind === "session-title"))
    assert.ok(rows.some((row) => row.kind === "session-title"), "the title request was made")
    c.client.close()
  } finally { await b.close() }
})

// input-ack-v1, both answers, over the real socket. The acknowledgement is what lets a follow-up RPC
// report success only for a message the session actually took — before it, an input frame had no
// reply, and "a frame was written somewhere" was indistinguishable from "the agent has it".
test("an acknowledged input resolves once the session holds it, and a refused one rejects with the reason", { timeout: 15_000 }, async () => {
  const b = startBroker("hold-inputs")
  try {
    const c = clientWith(b.socketPath)
    const id = randomUUID()
    await c.client.deliverInput({ id, text: "the first send holds the uuid outstanding" }, { acknowledged: true })
    const rows = await waitForRows(b.dir, (r) => r.some((row) => row.kind === "user-input"))
    assert.ok(rows.some((row) => row.kind === "user-input"), "resolved ⇒ the claude process was handed the input")
    await assert.rejects(
      c.client.deliverInput({ id, text: "the second send is refused" }, { acknowledged: true }),
      /refused this message: input UUID is already outstanding/,
      "the refusal reaches the caller instead of only a diagnostics file",
    )
    c.client.close()
  } finally { await b.close() }
})

// SEND NOW, across the socket. Two things have to survive the trip from the server to the CLI: the
// claim that a person typed the message (without it the CLI aborts the turn instead of moving the
// running call aside), and the send-now itself, naming that message. A bare interrupt frame — "Stop",
// and every frame an older server sends — must stay the plain abort it always was.
test("a send-now frame reaches the CLI naming the person's message; a bare interrupt stays an interrupt", { timeout: 15_000 }, async () => {
  const logDir = mkdtempSync(join(tmpdir(), "cbroker-diag-"))
  const diagnosticLogPath = join(logDir, "diag.log")
  const b = startBroker("send-now", { diagnosticLogPath })
  try {
    const c = clientWith(b.socketPath)
    const id = randomUUID()
    await c.client.deliverInput({ id, text: "read this now", human: true }, { acknowledged: true })
    c.client.interrupt({ sendNow: { messageId: id } })
    // The fake's capture rows carry more than the title fields `captureRows` is typed for.
    const interrupts = (r: unknown[]) => (r as Array<Record<string, unknown>>).filter((row) => row.kind === "host-control" && row.subtype === "interrupt")
    let rows = await waitForRows(b.dir, (r) => interrupts(r).length === 1) as Array<Record<string, unknown>>
    assert.deepEqual(rows.find((row) => row.kind === "user-input")?.origin, { kind: "human" })
    const sendNow = interrupts(rows)[0]
    assert.equal(sendNow?.sendNow, true)
    assert.equal(sendNow?.messageUuid, id)

    c.client.interrupt()
    rows = await waitForRows(b.dir, (r) => interrupts(r).length === 2) as Array<Record<string, unknown>>
    const plain = interrupts(rows)[1]
    assert.equal(plain?.sendNow, undefined, "an interrupt with no send-now is a plain abort")

    // What the send-now turned into is on record, by id and never by text.
    const log = readFileSync(diagnosticLogPath, "utf8")
    assert.match(log, new RegExp(`send-now: delivering id=${id}`))
    c.client.close()
  } finally {
    await b.close()
    rmSync(logDir, { recursive: true, force: true })
  }
})

// The compatibility half: a daemon forked by an older build has no `input-result` to send, so the
// bridge asks for no acknowledgement and settles for the frame having been WRITTEN to a connected
// socket. Driven against a current daemon with no requestId on the frame, which is exactly the frame an
// older daemon receives — it must still arrive, and the promise must still settle.
test("an unacknowledged input resolves once written to a connected socket, and still arrives", { timeout: 15_000 }, async () => {
  const b = startBroker("basic")
  try {
    const c = clientWith(b.socketPath)
    const id = randomUUID()
    await c.client.deliverInput({ id, text: "for a daemon that cannot answer" }, { acknowledged: false })
    const rows = await waitForRows(b.dir, (r) => r.some((row) => row.kind === "user-input"))
    assert.ok(rows.some((row) => row.kind === "user-input"), "the input reached the claude process")
    c.client.close()
  } finally { await b.close() }
})

// The never-connected hole, which is the one that lost "GO!!" on 2026-09-30: the client was bound to a
// socket path whose file had been deleted, `sendInput` buffered the frame and returned, and the client
// dropped it on its first-connect give-up with nobody told. `deliverInput` must reject at that give-up,
// and say the message was NOT delivered (it was never written anywhere).
test("a delivery to a socket nothing listens on rejects when the client gives up, as not delivered", { timeout: 15_000 }, async () => {
  const client = connectClaudeBroker(shortSocket(), {}, { connectDeadlineMs: 600, retryDelayMs: 100 })
  const started = Date.now()
  await assert.rejects(
    client.deliverInput({ id: randomUUID(), text: "GO!!" }, { acknowledged: true, timeoutMs: 10_000 }),
    /could not reach this thread's Claude session, so the message was not delivered/,
  )
  assert.ok(Date.now() - started < 5_000, "rejected at the connect give-up, not at the ack deadline")
  assert.equal(client.isClosed(), true)
  client.close()
})

// Two daemons for ONE session bind ONE socket path; the second unlinks the first's file and binds its
// own. Closing a unix-socket server makes libuv unlink its PATH, by name — so before the fix the first
// daemon's teardown deleted the SECOND's socket file, and the survivor ran on, recorded and unreachable
// (the 2026-09-30 loss on `we-ve-got-to-start-working`). A daemon must close its listener only while the
// path still leads to it. Negative control: against the pre-fix daemon, the existsSync below fails.
test("a daemon whose socket path was taken over leaves the successor's socket alone when it shuts down", { timeout: 20_000 }, async () => {
  const socketPath = shortSocket()
  const first = startBroker("basic")
  const loser = runClaudeBroker({ socketPath, cwd: first.dir, sessionId: randomUUID(), executablePath: join(first.dir, "fake-claude--basic.mjs"), permissionMode: "default", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } })
  await new Promise((r) => setTimeout(r, 300))
  const survivor = startBroker("basic", { socketPath })
  try {
    await new Promise((r) => setTimeout(r, 300))
    await loser.close()
    assert.ok(existsSync(socketPath), "the survivor's socket file outlives the loser's teardown")
    const c = clientWith(socketPath)
    await c.client.deliverInput({ id: randomUUID(), text: "are you still reachable?" }, { acknowledged: true, timeoutMs: 5_000 })
    const rows = await waitForRows(survivor.dir, (r) => r.some((row) => row.kind === "user-input"))
    assert.ok(rows.some((row) => row.kind === "user-input"), "…and an input sent to it reaches the survivor's claude")
    c.client.close()
  } finally {
    await survivor.close()
    await first.close()
  }
})

// ---- plugin sync (claude-plugin-sync.ts): the daemon re-reads a plugin that moved, between turns ----

/** A plugin closure the test owns and can change under a running daemon. */
function tempPlugin(): { dir: string; change: (name: string) => void; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), "cbroker-plugin-"))
  const dir = join(root, "cc-worker")
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true })
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "probe", version: "0.0.1" }))
  return {
    dir,
    change: (name) => { mkdirSync(join(dir, "skills", name), { recursive: true }); writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`) },
    remove: () => rmSync(root, { recursive: true, force: true }),
  }
}
type CaptureRow = { kind: string; subtype?: string; text?: string }
const reloadsIn = (rows: CaptureRow[]): number => rows.filter((row) => row.kind === "host-control" && row.subtype === "reload_plugins").length
const waitResults = async (c: ReturnType<typeof clientWith>, count: number): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (c.cap.events.filter((e) => e.kind === "result").length < count) {
    if (Date.now() > deadline) throw new Error(`waited for ${count} result(s), saw ${c.cap.events.filter((e) => e.kind === "result").length}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

test("a plugin that changed while the session was idle is reloaded BEFORE the next input reaches claude", { timeout: 20_000 }, async () => {
  const plugin = tempPlugin()
  const b = startBroker("basic", { pluginDir: plugin.dir })
  try {
    const c = clientWith(b.socketPath)
    await c.waitEvent((e) => e.kind === "init")
    await c.client.deliverInput({ id: randomUUID(), text: "first" }, { acknowledged: true, timeoutMs: 5_000 })
    await waitResults(c, 1)
    assert.equal(reloadsIn(captureRows(b.dir) as CaptureRow[]), 0, "an unchanged plugin costs nothing")

    plugin.change("added-while-idle")
    await c.client.deliverInput({ id: randomUUID(), text: "second" }, { acknowledged: true, timeoutMs: 5_000 })
    await waitResults(c, 2)
    const rows = captureRows(b.dir) as CaptureRow[]
    const order = rows.filter((row) => row.kind === "user-input" || (row.kind === "host-control" && row.subtype === "reload_plugins"))
      .map((row) => row.kind === "user-input" ? row.text : "reload")
    assert.deepEqual(order, ["first", "reload", "second"], "the reload lands between the turns, ahead of the input that found it")

    await c.client.deliverInput({ id: randomUUID(), text: "third" }, { acknowledged: true, timeoutMs: 5_000 })
    await waitResults(c, 3)
    assert.equal(reloadsIn(captureRows(b.dir) as CaptureRow[]), 1, "and it is not reloaded again until it changes again")
    c.client.close()
  } finally { await b.close(); plugin.remove() }
})

// The other half of the closure: what the OPERATOR adds. A live session does not notice a new project
// skill by itself (measured against real claude), so this reaches it the same way the plugin does.
test("a skill added to the project while the session was idle is picked up before the next input", { timeout: 20_000 }, async () => {
  const b = startBroker("basic") // no Frizz plugin at all: the closure is still worth keeping current
  try {
    const c = clientWith(b.socketPath)
    await c.waitEvent((e) => e.kind === "init")
    await c.client.deliverInput({ id: randomUUID(), text: "first" }, { acknowledged: true, timeoutMs: 5_000 })
    await waitResults(c, 1)
    mkdirSync(join(b.dir, ".claude", "skills", "added-by-the-operator"), { recursive: true })
    writeFileSync(join(b.dir, ".claude", "skills", "added-by-the-operator", "SKILL.md"), "---\nname: added-by-the-operator\n---\n")
    await c.client.deliverInput({ id: randomUUID(), text: "second" }, { acknowledged: true, timeoutMs: 5_000 })
    await waitResults(c, 2)
    const order = (captureRows(b.dir) as CaptureRow[])
      .filter((row) => row.kind === "user-input" || (row.kind === "host-control" && row.subtype === "reload_plugins"))
      .map((row) => row.kind === "user-input" ? row.text : "reload")
    assert.deepEqual(order, ["first", "reload", "second"])
    c.client.close()
  } finally { await b.close() }
})

test("a plugin that changes DURING a turn is not reloaded under it", { timeout: 20_000 }, async () => {
  const plugin = tempPlugin()
  // `hold-inputs`: the fake never answers, so the first input opens a turn that stays open.
  const b = startBroker("hold-inputs", { pluginDir: plugin.dir })
  try {
    const c = clientWith(b.socketPath)
    await c.waitEvent((e) => e.kind === "init")
    await c.client.deliverInput({ id: randomUUID(), text: "open a turn" }, { acknowledged: true, timeoutMs: 5_000 })
    plugin.change("added-mid-turn")
    await c.client.deliverInput({ id: randomUUID(), text: "a steer into it" }, { acknowledged: true, timeoutMs: 5_000 })
    const rows = await waitForRows(b.dir, (r) => r.filter((row) => row.kind === "user-input").length === 2) as CaptureRow[]
    assert.equal(rows.filter((row) => row.kind === "user-input").length, 2, "both inputs reached claude")
    assert.equal(reloadsIn(rows), 0, "with no reload while the turn was running")
    c.client.close()
  } finally { await b.close(); plugin.remove() }
})

test("a reload the session refuses still lets the input through", { timeout: 20_000 }, async () => {
  const plugin = tempPlugin()
  const b = startBroker("reload-failure", { pluginDir: plugin.dir })
  try {
    const c = clientWith(b.socketPath)
    await c.waitEvent((e) => e.kind === "init")
    plugin.change("unloadable")
    await c.client.deliverInput({ id: randomUUID(), text: "must not be lost" }, { acknowledged: true, timeoutMs: 5_000 })
    await waitResults(c, 1)
    const rows = captureRows(b.dir) as CaptureRow[]
    assert.ok(rows.some((row) => row.kind === "user-input" && row.text === "must not be lost"), "the failure did not cost the operator's message")
    assert.equal(reloadsIn(rows), 2, "tried before the input, and once more when its turn ended")

    await c.client.deliverInput({ id: randomUUID(), text: "and again" }, { acknowledged: true, timeoutMs: 5_000 })
    await waitResults(c, 2)
    assert.equal(reloadsIn(captureRows(b.dir) as CaptureRow[]), 2, "then the same unloadable plugin is left alone")
    c.client.close()
  } finally { await b.close(); plugin.remove() }
})

test("FRIZZ_PLUGIN_SYNC_OFF=1 leaves the session on the plugin it started with", { timeout: 20_000 }, async () => {
  const plugin = tempPlugin()
  const before = process.env.FRIZZ_PLUGIN_SYNC_OFF
  process.env.FRIZZ_PLUGIN_SYNC_OFF = "1"
  let b: ReturnType<typeof startBroker>
  try { b = startBroker("basic", { pluginDir: plugin.dir }) } finally {
    if (before === undefined) delete process.env.FRIZZ_PLUGIN_SYNC_OFF
    else process.env.FRIZZ_PLUGIN_SYNC_OFF = before
  }
  try {
    const c = clientWith(b.socketPath)
    await c.waitEvent((e) => e.kind === "init")
    plugin.change("ignored")
    await c.client.deliverInput({ id: randomUUID(), text: "hello" }, { acknowledged: true, timeoutMs: 5_000 })
    await waitResults(c, 1)
    assert.equal(reloadsIn(captureRows(b.dir) as CaptureRow[]), 0)
    c.client.close()
  } finally { await b.close(); plugin.remove() }
})

// An MCP reload re-reads the project's `.mcp.json` into the live session. The first one names the servers
// the session was LAUNCHED with, unchanged, before the new set: a launch server leaves only once a call has
// named it (measured on claude 2.1.323), so without it a server deleted from the file would stay mounted.
test("an MCP reload adopts the launch set once, then sends the project's servers as they read now", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbroker-mcp-"))
  const writeMcp = (servers: Record<string, unknown> | string) => writeFileSync(join(dir, ".mcp.json"), typeof servers === "string" ? servers : JSON.stringify({ mcpServers: servers }))
  mkdirSync(join(dir, ".claude"), { recursive: true })
  writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["a", "b"] }))
  writeMcp({ a: { command: "a-mcp" } })
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const socketPath = shortSocket()
  const broker = runClaudeBroker({ socketPath, cwd: dir, sessionId: randomUUID(), executablePath: exe, permissionMode: "default", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CLAUDE_CONFIG_DIR: join(dir, "claude-config") } })
  const sets = () => captureRows(dir).filter((row) => row.kind === "mcp-set-servers").map((row) => (row as { servers?: unknown }).servers)
  try {
    const c = clientWith(socketPath)
    await c.waitEvent((e) => e.kind === "init")

    writeMcp({ b: { command: "b-mcp" }, c: { command: "c-mcp" } })
    assert.deepEqual(await c.client.reloadMcpServers(), { added: ["b"], removed: ["a"], changed: [], unchanged: 0, errors: {}, unapproved: ["c"] })
    assert.deepEqual(sets(), [{ a: { command: "a-mcp" } }, { b: { command: "b-mcp" } }], "the launch set is adopted first, then replaced")

    // Nothing changed: one call, the same set, no second adoption.
    assert.deepEqual(await c.client.reloadMcpServers(), { added: [], removed: [], changed: [], unchanged: 1, errors: {}, unapproved: ["c"] })
    assert.equal(sets().length, 3)

    // A file caught half-written refuses the reload instead of unmounting everything it declared.
    writeMcp('{ "mcpServers": { "b": ')
    await assert.rejects(c.client.reloadMcpServers(), /not valid JSON/)
    assert.equal(sets().length, 3, "nothing was sent")
    c.client.close()
  } finally {
    await broker.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
