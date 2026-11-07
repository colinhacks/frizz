import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import Database from "../sqlite.ts"
import { createInteractionStore, type InteractionStore } from "../interaction-store.ts"
import { createAcpBridge, type AcpBridge } from "./acp-bridge.ts"
import { daemonAcpHost, liveAcpDaemonRecord, liveAcpDaemonSessionIds, stopAcpDaemon, type AcpHost } from "./acp-host.ts"
import { spawnAcpChild } from "./acp-rpc.ts"
import { acpTranscriptPath, parseAcpRecord, projectAcpTranscript, readAcpTranscriptFile, type AcpRecord } from "./acp-transcript.ts"
import { newTailState } from "../tailer.ts"
import { createAcpBackend } from "./acp-transcript.ts"
import type { FrizzCli } from "./types.ts"
import { acpUserRecordProjector } from "../transcript.ts"
import { humanGapNote, shellDoneMessage, stripWakeTrailer, wakeDeliveryToken } from "@frizz/shared"

// The bridge against the REAL fake agent over REAL stdio and a REAL InteractionStore: what the tailer
// will fold and the drawer will project is read back from the transcript file the bridge wrote.

const FAKE = fileURLToPath(new URL("./acp.fixtures/fake-acp-agent.mjs", import.meta.url))

interface Rig { bridge: AcpBridge; stateDir: string; store: InteractionStore; status: number; diagnostics: string[] }

function rig(mode = "", opts: { customCommand?: string; stateDir?: string; direct?: boolean; host?: AcpHost; agentLog?: string; frizzCli?: FrizzCli; mountsMcp?: (slug: string) => boolean; contractFor?: (slug: string, sessionId: string) => string | undefined } = {}): Rig {
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "acp-bridge-"))
  const store = createInteractionStore(new Database(":memory:"))
  const r: Rig = { stateDir, store, status: 0, diagnostics: [], bridge: undefined as unknown as AcpBridge }
  r.bridge = createAcpBridge({
    projectId: "proj-1",
    stateDir,
    interactions: store,
    env: { ...process.env, FAKE_ACP_MODE: mode, ...(opts.agentLog ? { FAKE_ACP_LOG: opts.agentLog } : {}) },
    // The fake is "installed" as an operator-configured agent whose command is node itself.
    customAgents: () => [{ id: "fake", label: "Fake agent", command: opts.customCommand ?? process.execPath, args: opts.customCommand ? [] : [FAKE] }],
    frizzMcp: { scriptPath: "/opt/frizz/frizz-mcp.mjs", stateDir: "/opt/state", projectId: "proj-1" },
    ...(opts.frizzCli ? { frizzCli: opts.frizzCli } : {}),
    ...(opts.mountsMcp ? { mountsMcp: opts.mountsMcp } : {}),
    ...(opts.contractFor ? { contractFor: opts.contractFor } : {}),
    onStatusChange: () => { r.status++ },
    onDiagnostic: (d) => { if (d.kind !== "stderr") r.diagnostics.push(`${d.kind}: ${d.message}`) },
    flushMs: 20,
    initializeTimeoutMs: 5_000,
    // The default host forks a REAL detached daemon per session — the production transport — so every
    // test below exercises the daemon too; `direct` is the pre-daemon plain child, for the control.
    ...(opts.direct ? { spawn: spawnAcpChild } : {}),
    ...(opts.host ? { host: opts.host } : {}),
  })
  return r
}

/** `shutdown()` DETACHES from the daemons (that is its whole point), so a test must end them itself. */
async function teardown(r: Rig): Promise<void> {
  await r.bridge.shutdown()
  for (const sessionId of liveAcpDaemonSessionIds(r.stateDir)) await stopAcpDaemon(r.stateDir, sessionId)
}

const records = (r: Rig, sessionId: string): AcpRecord[] =>
  readFileSync(acpTranscriptPath(r.stateDir, sessionId), "utf8").split("\n").map(parseAcpRecord).filter((x): x is AcpRecord => x !== undefined)

async function untilIdle(r: Rig, sessionId: string, slug = "t1", timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    const live = r.bridge.turnLiveness(slug, sessionId)
    if (!live || (!live.turnActive && live.queued === 0)) return
    if (Date.now() - t0 > timeoutMs) throw new Error("turn did not end")
    await new Promise((res) => setTimeout(res, 20))
  }
}

test("acp-bridge: a dispatch opens a session with the frizz MCP server, runs the first turn, and writes a foldable transcript", async () => {
  const r = rig()
  try {
    const info = await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "CONTRACT…\n\nMake hello.txt", userText: "Make hello.txt" })
    assert.match(info.acpSessionId, /^fake_/)
    assert.equal(info.agent.name, "FakeAgent")
    assert.equal(info.model, "fake/small")
    await untilIdle(r, "s1")
    const recs = records(r, "s1")
    assert.deepEqual(recs.map((x) => x.kind), [
      "acp-session", "user-message", "turn-start", "reasoning", "tool-call", "acp-tool-input", "tool-result", "assistant-text", "context-usage", "turn-end",
    ])
    assert.equal((recs[1] as { text?: string }).text, "Make hello.txt", "the transcript records what the human wrote, not the contract")
    assert.equal((recs[3] as { text: string }).text, "thinking about it")
    assert.equal((recs[7] as { text: string }).text, "PONG")
    assert.equal((recs[9] as { finalText?: string }).finalText, "PONG")
    // The fold the tailer runs: idle, preview from the final text.
    const s = newTailState("t1", "s1", "/x")
    const backend = createAcpBackend({ stateDir: r.stateDir })
    for (const line of readFileSync(acpTranscriptPath(r.stateDir, "s1"), "utf8").split("\n")) backend.foldLine(s, line)
    assert.equal(s.turn, "idle")
    assert.equal(s.lastAssistant, "PONG")
    assert.equal(s.model, "fake/small")
    // The drawer.
    const msgs = projectAcpTranscript(readFileSync(acpTranscriptPath(r.stateDir, "s1"), "utf8"))
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "assistant"])
    assert.equal(msgs[2]!.tools[0]!.name, "write")
    assert.equal(msgs[2]!.tools[0]!.status, "completed")
    assert.ok(r.status >= 2, "status changed at turn start and end")
  } finally { await teardown(r) }
})

// An ACP agent is one daemon per thread, so the environment it is forked with can say who is calling.
// That, and the command's directory on PATH, is everything `frizzctl` needs from the agent's own shell.
test("acp-bridge: the agent is forked with the worker command on its PATH and this thread's identity", async () => {
  const cli = { binDir: "/plugin/bin", stateDir: "/data/projects/proj-1", serverLock: "/data/server.lock", projectId: "proj-1" }
  const forked: Array<Record<string, string | undefined>> = []
  const r = rig("", { frizzCli: cli, host: async (o) => { forked.push({ ...o.env }); return daemonAcpHost(o) } })
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "CONTRACT…\n\nhi", userText: "hi" })
    await untilIdle(r, "s1")
    assert.equal(forked.length, 1)
    const env = forked[0]!
    assert.equal(env.FRIZZ_THREAD_SLUG, "t1")
    assert.equal(env.FRIZZ_THREAD, undefined, "FRIZZ_THREAD is the orphan reaper's tag, and an ACP agent has no session root to keep it live")
    assert.equal(env.FRIZZ_STATE_DIR, "/data/projects/proj-1")
    assert.equal(env.FRIZZ_PROJECT_ID, "proj-1")
    assert.equal(env.FRIZZ_SERVER_LOCK, "/data/server.lock")
    assert.equal(env.FRIZZ_NODE, process.execPath)
    assert.equal((env.PATH ?? env.Path)!.split(process.platform === "win32" ? ";" : ":")[0], "/plugin/bin")
  } finally { await teardown(r) }
})

// The whole path a real ACP worker's command takes, with only the agent's brain and Frizz's router stood
// in for: the bridge forks the REAL detached daemon, the daemon forks the agent, the agent's shell runs
// `frizzctl` by BARE NAME, and the plugin's real launcher reaches a real http server. The test above
// reads the environment at the fork; this one proves that environment is enough, where it is used.
test("acp-bridge: a command the agent's own shell runs reaches Frizz as that agent's thread", { skip: process.platform === "win32" }, async () => {
  const seen: Array<{ url: string; body: unknown }> = []
  const frizz = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = JSON.parse(raw) as { title: string }
      seen.push({ url: req.url ?? "", body })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { accepted: true, title: body.title } }))
    })
  })
  await new Promise<void>((resolve) => frizz.listen(0, "127.0.0.1", resolve))
  const projectState = join(mkdtempSync(join(tmpdir(), "acp-frizz-")), "projects", "proj-1")
  mkdirSync(projectState, { recursive: true })
  writeFileSync(join(projectState, "server.lock"), JSON.stringify({ port: (frizz.address() as { port: number }).port }))
  const cli: FrizzCli = { binDir: fileURLToPath(new URL("../../../../cc-worker/bin", import.meta.url)), stateDir: projectState, projectId: "proj-1" }

  const stateDir = mkdtempSync(join(tmpdir(), "acp-bridge-"))
  const agentLog = join(stateDir, "agent-frames.jsonl")
  const r = rig("shell", { stateDir, agentLog, frizzCli: cli, mountsMcp: () => false })
  try {
    const prompt = 'CONTRACT…\n\nRUN: frizzctl title "From an ACP agent"; echo "exit=$?"; command -v frizzctl'
    await r.bridge.spawnDispatch({ threadSlug: "acp-thread", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt, userText: "hi" })
    await untilIdle(r, "s1", "acp-thread")
    const ran = readFileSync(agentLog, "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as { shell?: { code: number; stdout: string; stderr: string } })
      .find((f) => f.shell)?.shell
    assert.ok(ran, "the agent ran the command")
    assert.equal(ran.stderr, "")
    assert.deepEqual(ran.stdout.trim().split("\n"), ['This thread is now named "From an ACP agent" on the board.', "exit=0", join(cli.binDir, "frizzctl")])
    assert.deepEqual(seen, [{ url: "/_frizz/proj-1/rpc/setOwnThreadTitle", body: { slug: "acp-thread", title: "From an ACP agent" } }])
  } finally {
    await teardown(r)
    frizz.close()
  }
})

// An ACP thread's contract is its first prompt, so it has the contract it was started with for good.
test("acp-bridge: only a thread whose contract taught the MCP tools is opened with the frizz MCP server", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "acp-bridge-"))
  const agentLog = join(stateDir, "agent-frames.jsonl")
  const r = rig("", { stateDir, agentLog, mountsMcp: (slug) => slug === "taught-mcp" })
  try {
    for (const [threadSlug, sessionId] of [["taught-cli", "s-cli"], ["taught-mcp", "s-mcp"]] as const) {
      await r.bridge.spawnDispatch({ threadSlug, sessionId, cwd: r.stateDir, agentId: "fake", prompt: "CONTRACT…\n\nhi", userText: "hi" })
      await untilIdle(r, sessionId, threadSlug)
    }
    const opened = readFileSync(agentLog, "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as { method?: string; params?: { mcpServers?: Array<{ name: string; env: Array<{ name: string; value: string }> }> } })
      .filter((f) => f.method === "session/new")
    assert.deepEqual(opened.map((f) => f.params?.mcpServers?.map((m) => m.name)), [[], ["frizz"]])
    assert.equal(opened[1]!.params!.mcpServers![0]!.env.find((e) => e.name === "FRIZZ_THREAD_SLUG")?.value, "taught-mcp")
  } finally { await teardown(r) }
})

test("acp-bridge: a follow-up during a turn queues and runs after it; one after rest runs at once", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "count SLOW", userText: "count SLOW" })
    await new Promise((res) => setTimeout(res, 60))
    const queued = await r.bridge.followUp({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", text: "second", deliveryId: "d2" })
    assert.equal(queued.state, "queued")
    assert.equal(queued.resumed, "live")
    assert.equal(r.bridge.turnLiveness("t1", "s1")?.queued, 1)
    const stop = await r.bridge.interruptTurn("t1", "s1")
    assert.equal(stop.interrupted, true)
    await untilIdle(r, "s1")
    const kinds = records(r, "s1").map((x) => x.kind)
    const userIdx = kinds.map((k, i) => (k === "user-message" ? i : -1)).filter((i) => i >= 0)
    assert.equal(userIdx.length, 2, "the queued follow-up ran as its own turn after the cancel")
    assert.equal(kinds.filter((k) => k === "turn-end").length, 2)
    assert.ok(kinds.includes("acp-note"), "the cancelled turn left its note")
    const ends = records(r, "s1").filter((x) => x.kind === "turn-end") as Array<{ successful?: boolean }>
    assert.equal(ends[0]!.successful, false, "an operator's stop is not a successful turn")
    assert.equal(ends[1]!.successful, true, "the queued follow-up's own turn ran to completion")
    const delivered = await r.bridge.followUp({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", text: "third" })
    assert.equal(delivered.state, "delivered")
    await untilIdle(r, "s1")
    assert.equal(records(r, "s1").filter((x) => x.kind === "turn-end").length, 3)
  } finally { await teardown(r) }
})

// The bridge records every follow-up verbatim and `synthetic: false` — it cannot tell Frizz from the
// human — so the drawer has to. A wake goes in exactly as context.ts's scheduler resume sends it, a
// human follow-up exactly as the router sends one after a long gap, and the file the bridge wrote is
// read back through the transcript layer's own ACP reader.
test("acp-bridge: a scheduler wake and a gap-noted follow-up through the real bridge render as a wake and as the human's words", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "CONTRACT…\n\nbuild it", userText: "build it" })
    await untilIdle(r, "s1")
    const shell = shellDoneMessage({ taskId: "b1", label: "build", status: "completed" })
    const wake = `${shell}\n\n${wakeDeliveryToken("w1")}`
    assert.equal((await r.bridge.followUp({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", text: wake, deliveryId: "w1" })).state, "delivered")
    await untilIdle(r, "s1")
    const note = humanGapNote(Date.now(), new Date(Date.now() - 3 * 3_600_000).toISOString())!
    const human = `ship it\n\n${note}`
    await r.bridge.followUp({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", text: human, deliveryId: "d2" })
    await untilIdle(r, "s1")
    const users = readAcpTranscriptFile(acpTranscriptPath(r.stateDir, "s1"), "s1", acpUserRecordProjector).filter((m) => m.role === "user")
    assert.deepEqual(users.map((m) => m.text), ["build it", wake, human], "the stored text keeps every byte the worker read")
    assert.deepEqual(users.map((m) => m.displayText ?? m.text), ["build it", stripWakeTrailer(shell), "ship it"])
    assert.deepEqual(users.map((m) => m.wake), [undefined, true, undefined], "only the scheduler's delivery is Frizz speaking")
    assert.ok(users.every((m) => !(m.displayText ?? m.text).includes("frizz-wake")), "a delivery token reached a bubble")
  } finally { await teardown(r) }
})

test("acp-bridge: a permission request becomes a card with canonical decision ids; resolving it answers the agent with its own optionId", async () => {
  const r = rig("ask-permission")
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "go", userText: "go" })
    const scope = { projectId: "proj-1", threadSlug: "t1", sessionId: "s1" }
    let pending = r.store.listPending(scope)
    for (let i = 0; i < 100 && pending.length === 0; i++) { await new Promise((res) => setTimeout(res, 20)); pending = r.store.listPending(scope) }
    assert.equal(pending.length, 1)
    const card = pending[0]!
    assert.equal(card.provider.kind, "acp")
    assert.equal(card.payload.kind, "command-approval")
    assert.equal((card.payload as { command: { preview: string } }).command.preview, "rm -rf build")
    assert.deepEqual(card.allowedDecisions.map((d) => [d.id, d.semantic]), [["accept", "approve"], ["acceptForSession", "approve"], ["decline", "deny"]])
    assert.equal(r.bridge.ownsInteraction(scope, card.id), true)
    r.store.resolve(scope, { slug: "t1", sessionId: "s1", interactionId: card.id, sessionEpoch: card.owner.sessionEpoch, capabilityRevision: card.owner.capabilityRevision, expectedRecordRevision: card.recordRevision, responseId: "resp-1", decisionId: "accept" })
    await untilIdle(r, "s1")
    const result = records(r, "s1").find((x) => x.kind === "tool-result") as { text: string } | undefined
    assert.equal(result?.text, "removed", "the agent got the allow_once optionId back and completed the tool")
    assert.equal(r.bridge.ownsInteraction(scope, card.id), false)
  } finally { await teardown(r) }
})

test("acp-bridge: an open card is cancelled — and the agent answered cancelled — when the session is released", async () => {
  const r = rig("ask-permission")
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "go", userText: "go" })
    const scope = { projectId: "proj-1", threadSlug: "t1", sessionId: "s1" }
    let pending = r.store.listPending(scope)
    for (let i = 0; i < 100 && pending.length === 0; i++) { await new Promise((res) => setTimeout(res, 20)); pending = r.store.listPending(scope) }
    assert.equal(pending.length, 1)
    r.bridge.releaseSession("t1", "s1", "session-deleted")
    assert.equal(r.store.listPending(scope).length, 0)
    assert.equal(r.bridge.turnLiveness("t1", "s1"), undefined)
  } finally { await teardown(r) }
})

test("acp-bridge: after the session is gone, a follow-up re-opens it with session/load when the agent can", async () => {
  const r = rig()
  try {
    const info = await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "go", userText: "go" })
    await untilIdle(r, "s1")
    r.bridge.releaseSession("t1", "s1", "session-deleted")
    const before = records(r, "s1").length
    const again = await r.bridge.followUp({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", acpSessionId: info.acpSessionId, text: "more" })
    assert.equal(again.resumed, "loaded")
    assert.equal(again.acpSessionId, info.acpSessionId)
    await untilIdle(r, "s1")
    const after = records(r, "s1")
    // The load's replayed history was NOT written again: the new records are exactly the follow-up turn.
    assert.deepEqual(after.slice(before).map((x) => x.kind), ["user-message", "turn-start", "reasoning", "tool-call", "acp-tool-input", "tool-result", "assistant-text", "context-usage", "turn-end"])
  } finally { await teardown(r) }
})

test("acp-bridge: an agent without loadSession gets a fresh session and the transcript says so", async () => {
  const r = rig("no-load")
  try {
    const info = await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "go", userText: "go" })
    await untilIdle(r, "s1")
    r.bridge.releaseSession("t1", "s1", "session-deleted")
    const again = await r.bridge.followUp({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", acpSessionId: info.acpSessionId, text: "more" })
    assert.equal(again.resumed, "fresh")
    assert.notEqual(again.acpSessionId, info.acpSessionId)
    const note = records(r, "s1").find((x) => x.kind === "acp-note") as { text: string } | undefined
    assert.match(note?.text ?? "", /fresh Fake agent session/)
  } finally { await teardown(r) }
})

test("acp-bridge: a missing executable and an unknown agent fail the dispatch with actionable errors and leave no session", async () => {
  const r = rig("", { customCommand: "definitely-not-installed-acp-agent" })
  try {
    await assert.rejects(r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "go", userText: "go" }), /is not installed/)
    await assert.rejects(r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s2", cwd: r.stateDir, agentId: "nope", prompt: "go", userText: "go" }), /Unknown ACP agent "nope"/)
    assert.equal(r.bridge.turnLiveness("t1", "s1"), undefined)
  } finally { await teardown(r) }
})

test("acp-bridge: an agent that never completes the handshake fails the dispatch, naming the agent", async () => {
  const r = rig("slow-init")
  try {
    await assert.rejects(r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "go", userText: "go" }), /Fake agent did not complete the ACP handshake/)
  } finally { await teardown(r) }
})

test("acp-bridge: a dispatch naming a model asks the agent for it, and an unknown one leaves a note", async () => {
  const r = rig()
  try {
    const info = await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", modelId: "fake/large", prompt: "hi", userText: "hi" })
    assert.equal(info.model, "fake/large", "the session opened on the requested model")
    await untilIdle(r, "s1")
    const header = records(r, "s1").find((x) => x.kind === "acp-session") as { model?: string }
    assert.equal(header.model, "fake/large", "the header records the model in effect, not the agent's default")
    assert.ok(!records(r, "s1").some((x) => x.kind === "acp-note"), "a model the agent accepts leaves no note")

    const other = await r.bridge.spawnDispatch({ threadSlug: "t2", sessionId: "s2", cwd: r.stateDir, agentId: "fake", modelId: "fake/nonexistent", prompt: "hi", userText: "hi" })
    assert.equal(other.model, "fake/small", "a refused model leaves the session on the agent's own")
    await untilIdle(r, "s2", "t2")
    const note = records(r, "s2").find((x) => x.kind === "acp-note") as { text: string } | undefined
    assert.match(note?.text ?? "", /could not switch to fake\/nonexistent/)
  } finally { await teardown(r) }
})

test("acp-bridge: setModel switches a LIVE session's model in place, notes a refusal, and reports a closed session as not applied", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "hi", userText: "hi" })
    await untilIdle(r, "s1")
    assert.deepEqual(await r.bridge.setModel("t1", "s1", "fake/large"), { applied: true, model: "fake/large" })
    assert.equal(r.bridge.session("t1", "s1")?.model, "fake/large", "the live session now runs on the chosen model")
    assert.deepEqual(await r.bridge.setModel("t1", "s1", "fake/nonexistent"), { applied: true, model: "fake/large" })
    assert.match((records(r, "s1").find((x) => x.kind === "acp-note") as { text: string } | undefined)?.text ?? "", /could not switch to fake\/nonexistent/)
    assert.deepEqual(await r.bridge.setModel("t1", "nope", "fake/large"), { applied: false }, "no live session: the slug reaches the agent on the next open")
    assert.deepEqual(await r.bridge.setModel("other", "s1", "fake/large"), { applied: false }, "another thread's session is not this thread's to steer")
  } finally { await teardown(r) }
})

test("acp-bridge: agentModels reads the advertised list through a throwaway session and caches it", async () => {
  const r = rig()
  try {
    const first = await r.bridge.agentModels("fake", r.stateDir)
    assert.deepEqual(first.models, [{ id: "fake/small", name: "Fake Small" }, { id: "fake/large", name: "Fake Large" }])
    assert.equal(first.current, "fake/small")
    assert.equal(first.error, undefined)
    const again = await r.bridge.agentModels("fake", r.stateDir)
    assert.equal(again, first, "the second read is the cached object, no second child")
    const missing = await r.bridge.agentModels("nope", r.stateDir)
    assert.deepEqual(missing.models, [])
    assert.match(missing.error ?? "", /nope/)
  } finally { await teardown(r) }
})

// ---- THE DETACHED DAEMON: an agent and its turn outlive the bridge ----------------------------------
// The whole reason acp-daemon.ts exists (maintainer 2026-09-24: an ACP restart ended the agent, its
// turn and every sub-agent inside it). Bridge A is shut down MID-TURN — exactly what a Frizz restart
// does — and bridge B, a fresh instance over the same state dir, warms up and carries the turn to its
// real ending. The plain-child control shows the turn dying instead.

const pending = (r: Rig, slug = "t1", sessionId = "s1") => r.store.listPending({ projectId: "proj-1", threadSlug: slug, sessionId })

async function untilTurnActive(r: Rig, sessionId: string, slug = "t1"): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (r.bridge.turnLiveness(slug, sessionId)?.turnActive) return
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error("turn never started")
}

test("acp-bridge: a turn survives the bridge shutting down mid-turn; a fresh bridge reattaches and records its real ending", async () => {
  const a = rig()
  let b: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: a.stateDir, agentId: "fake", prompt: "SLOW count", userText: "SLOW count" })
    await untilTurnActive(a, "s1")
    await new Promise((res) => setTimeout(res, 300)) // let a few chunks stream first
    await a.bridge.shutdown() // the restart: the socket drops, the agent does not
    const record = liveAcpDaemonRecord(a.stateDir, "s1")
    assert.ok(record, "the daemon is still running after the bridge went away")
    const beforeReattach = records(a, "s1")
    assert.equal(beforeReattach.filter((x) => x.kind === "turn-end").length, 0, "shutting down did NOT write a turn-end: the turn is still running")
    assert.equal(beforeReattach.filter((x) => x.kind === "provider-error").length, 0)

    b = rig("", { stateDir: a.stateDir })
    await b.bridge.warmUp([{ threadSlug: "t1", sessionId: "s1", cwd: a.stateDir, agentId: "fake" }])
    assert.equal(b.bridge.turnLiveness("t1", "s1")?.turnActive, true, "the reattached bridge sees the turn as live")
    await untilIdle(b, "s1", "t1", 15_000)
    const after = records(b, "s1")
    assert.ok(after.some((x) => x.kind === "acp-note" && /Reattached to the running Fake agent/.test((x as { text: string }).text)))
    assert.equal(after.filter((x) => x.kind === "turn-start").length, 1, "one turn, not two")
    const end = after.filter((x) => x.kind === "turn-end") as Array<{ successful: boolean; finalText?: string }>
    assert.equal(end.length, 1)
    assert.equal(end[0]!.successful, true)
    assert.match(end[0]!.finalText ?? "", /PONG$/, "the turn's real ending, streamed after the reattach")
    const streamed = after.filter((x) => x.kind === "assistant-text").map((x) => (x as { text: string }).text).join("")
    for (let i = 1; i <= 200; i++) assert.ok(streamed.includes(`${i}\n`), `chunk ${i} — streamed while nobody was attached — was replayed into the transcript`)
    assert.equal(after.filter((x) => x.kind === "provider-error").length, 0)
    // The same session takes an ordinary follow-up afterwards, still on the same daemon.
    const follow = await b.bridge.followUp({ threadSlug: "t1", sessionId: "s1", cwd: a.stateDir, agentId: "fake", text: "again", acpSessionId: record.sessionId })
    assert.equal(follow.state, "delivered")
    assert.equal(liveAcpDaemonRecord(a.stateDir, "s1")?.generation, record.generation, "no new agent process was started")
  } finally {
    await teardown(a)
    if (b) await teardown(b)
  }
})

test("acp-bridge: a permission card open at shutdown is raised afresh by the reattached bridge, and its answer reaches the agent", async () => {
  const a = rig("ask-permission")
  let b: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: a.stateDir, agentId: "fake", prompt: "go", userText: "go" })
    for (let i = 0; i < 100 && pending(a).length === 0; i++) await new Promise((res) => setTimeout(res, 20))
    assert.equal(pending(a).length, 1, "the card is up")
    await a.bridge.shutdown()
    assert.equal(pending(a).length, 0, "the dead runtime's card is cancelled on its side")

    b = rig("ask-permission", { stateDir: a.stateDir })
    await b.bridge.warmUp([{ threadSlug: "t1", sessionId: "s1", cwd: a.stateDir, agentId: "fake" }])
    for (let i = 0; i < 100 && pending(b).length === 0; i++) await new Promise((res) => setTimeout(res, 20))
    const card = pending(b)[0]
    assert.ok(card, "the daemon re-sent the unanswered request and the new bridge raised the card")
    const scope = { projectId: "proj-1", threadSlug: "t1", sessionId: "s1" }
    b.store.resolve(scope, { slug: "t1", sessionId: "s1", interactionId: card.id, sessionEpoch: card.owner.sessionEpoch, capabilityRevision: card.owner.capabilityRevision, expectedRecordRevision: card.recordRevision, responseId: "resp-1", decisionId: "accept" })
    await untilIdle(b, "s1", "t1", 15_000)
    const result = records(b, "s1").find((x) => x.kind === "tool-result") as { text: string } | undefined
    assert.equal(result?.text, "removed", "the allow reached the agent through the daemon")
  } finally {
    await teardown(a)
    if (b) await teardown(b)
  }
})

test("acp-bridge: CONTROL — with a plain child instead of the daemon, shutting down mid-turn ends the turn", async () => {
  const r = rig("", { direct: true })
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "SLOW count", userText: "SLOW count" })
    await untilTurnActive(r, "s1")
    await r.bridge.shutdown()
    assert.equal(liveAcpDaemonRecord(r.stateDir, "s1"), null, "no daemon was ever forked")
    // The child exited with its stdin; nothing is left to reattach to, and a fresh bridge finds no turn.
    const b = rig("", { stateDir: r.stateDir, direct: true })
    await b.bridge.warmUp([{ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake" }])
    assert.equal(b.bridge.turnLiveness("t1", "s1"), undefined, "the turn died with the runtime")
    await teardown(b)
  } finally { await teardown(r) }
})

test("acp-bridge: releasing a session ends its daemon, and a new open starts a new agent process", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "hi", userText: "hi" })
    await untilIdle(r, "s1")
    const first = liveAcpDaemonRecord(r.stateDir, "s1")
    assert.ok(first)
    r.bridge.releaseSession("t1", "s1", "session-deleted")
    for (let i = 0; i < 200 && liveAcpDaemonRecord(r.stateDir, "s1"); i++) await new Promise((res) => setTimeout(res, 25))
    assert.equal(liveAcpDaemonRecord(r.stateDir, "s1"), null, "the daemon and its agent are gone")
    await r.bridge.followUp({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", text: "again", acpSessionId: first.sessionId })
    await untilIdle(r, "s1")
    const second = liveAcpDaemonRecord(r.stateDir, "s1")
    assert.ok(second && second.generation !== first.generation, "a fresh daemon for the re-opened session")
  } finally { await teardown(r) }
})

// The 2026-09-30 race, ACP edition: the waker delivering answers and the operator's own send reach a
// session with no live agent in the same instant. Each open found no daemon and forked one; both
// attaches reached the same daemon, which serves one client at a time, so the later hung up the earlier
// (whose next write then failed EPIPE) and BOTH follow-ups failed. Now concurrent opens of one session
// share one. Negative control: against the pre-fix bridge the host is asked twice and both reject.
test("acp-bridge: two concurrent follow-ups to a session with no live agent share ONE open, and both reach it", async () => {
  let hostCalls = 0
  const stateDir = mkdtempSync(join(tmpdir(), "acp-bridge-"))
  const agentLog = join(stateDir, "agent-frames.jsonl")
  const r = rig("", { stateDir, agentLog, host: async (o) => { hostCalls++; return daemonAcpHost(o) } })
  try {
    const input = (text: string) => ({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", text, deliveryId: text })
    const [a, b] = await Promise.all([r.bridge.followUp(input("the waker's answers")), r.bridge.followUp(input("the operator's send"))])
    assert.equal(hostCalls, 1, "one open, shared")
    assert.deepEqual([a.state, b.state], ["delivered", "queued"], "the first runs, the second queues behind it")
    await untilIdle(r, "s1")
    const frames = readFileSync(agentLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { method?: string; params?: { prompt?: Array<{ text?: string }> } })
    assert.equal(frames.filter((f) => f.method === "initialize").length, 1, "one agent process")
    assert.deepEqual(frames.filter((f) => f.method === "session/prompt").map((f) => f.params?.prompt?.[0]?.text), ["the waker's answers", "the operator's send"])
  } finally { await teardown(r) }
})

// ---- the worker contract, re-sent when the session lost it -----------------------------------------
// ACP has no system-prompt channel, so the contract rides a prompt and lives only as long as the
// session's history does. Measured 2026-10-12 against opencode 2.0.27 with a recording fake model: the
// request after `/compact` carried none of it. These pin when it goes out again — and when it does NOT.

const CONTRACT = (slug: string, sessionId: string) => `FRIZZ-CONTRACT for ${slug}/${sessionId}`

function promptsSent(agentLog: string): string[] {
  return readFileSync(agentLog, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as { method?: string; params?: { prompt?: Array<{ text?: string }> } })
    .filter((f) => f.method === "session/prompt")
    .map((f) => (f.params?.prompt ?? []).map((b) => b.text ?? "").join(""))
}

async function send(r: Rig, text: string, acpSessionId?: string) {
  const res = await r.bridge.followUp({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", text, ...(acpSessionId ? { acpSessionId } : {}) })
  await untilIdle(r, "s1")
  return res
}

for (const mode of ["", "meta-compaction"]) {
  const shape = mode ? "opencode's `_meta` marker" : "a standard `compaction_update`"
  test(`acp-bridge: after the agent compacts (${shape}) the NEXT prompt carries the contract, once; a plain follow-up never does`, async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "acp-bridge-"))
    const agentLog = join(stateDir, "agent-frames.jsonl")
    const r = rig(mode, { stateDir, agentLog, contractFor: CONTRACT })
    try {
      await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: stateDir, agentId: "fake", prompt: "DISPATCH-CONTRACT\n\ngo", userText: "go" })
      await untilIdle(r, "s1")
      await send(r, "plain follow-up")
      await send(r, "/compact")
      await send(r, "after the compaction")
      await send(r, "and once more")
      assert.deepEqual(promptsSent(agentLog), [
        "DISPATCH-CONTRACT\n\ngo", // the dispatch's own first prompt, not doubled
        "plain follow-up", // nothing was lost, so nothing is re-sent
        "/compact", // a slash command is parsed off the start of the prompt; it goes out bare
        "FRIZZ-CONTRACT for t1/s1\n\nafter the compaction",
        "and once more", // once per compaction
      ])
      const frames = readFileSync(agentLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { method?: string; params?: { clientCapabilities?: { session?: { compaction?: unknown } } } })
      assert.ok(frames.find((f) => f.method === "initialize")?.params?.clientCapabilities?.session?.compaction, "the client asks for standard compaction updates")
      const recs = records(r, "s1")
      const kinds = recs.map((x) => x.kind)
      assert.equal(kinds.filter((k) => k === "compaction").length, 1, "the compaction is in the transcript, for the fold")
      const resent = recs.findIndex((x) => x.kind === "acp-contract")
      assert.deepEqual(recs[resent], { kind: "acp-contract", at: (recs[resent] as { at: string }).at, reason: "compaction" })
      assert.equal((recs[resent + 1] as { kind: string; text?: string }).text, "after the compaction", "the transcript records the operator's words, not the contract")
      assert.equal(kinds.filter((k) => k === "acp-contract").length, 1)
    } finally { await teardown(r) }
  })
}

test("acp-bridge: a compaction is still answered after a re-open: the debt is read back from the transcript", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "acp-bridge-"))
  const agentLog = join(stateDir, "agent-frames.jsonl")
  const r = rig("", { stateDir, agentLog, contractFor: CONTRACT })
  try {
    const info = await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: stateDir, agentId: "fake", prompt: "go", userText: "go" })
    await untilIdle(r, "s1")
    await send(r, "/compact")
    // The runtime that saw the compaction goes away before the next prompt, taking its in-memory flag.
    r.bridge.releaseSession("t1", "s1", "session-deleted")
    const again = await send(r, "after the re-open", info.acpSessionId)
    assert.equal(again.resumed, "loaded")
    await send(r, "and once more", info.acpSessionId)
    assert.deepEqual(promptsSent(agentLog).slice(-2), ["FRIZZ-CONTRACT for t1/s1\n\nafter the re-open", "and once more"])
  } finally { await teardown(r) }
})

test("acp-bridge: a FRESH session replacing one the agent could not load gets the contract on its first prompt", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "acp-bridge-"))
  const agentLog = join(stateDir, "agent-frames.jsonl")
  const r = rig("no-load", { stateDir, agentLog, contractFor: CONTRACT })
  try {
    const info = await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: stateDir, agentId: "fake", prompt: "DISPATCH-CONTRACT\n\ngo", userText: "go" })
    await untilIdle(r, "s1")
    r.bridge.releaseSession("t1", "s1", "session-deleted")
    const again = await send(r, "more", info.acpSessionId)
    assert.equal(again.resumed, "fresh")
    await send(r, "still more", again.acpSessionId)
    assert.deepEqual(promptsSent(agentLog), ["DISPATCH-CONTRACT\n\ngo", "FRIZZ-CONTRACT for t1/s1\n\nmore", "still more"])
    const resent = records(r, "s1").filter((x) => x.kind === "acp-contract") as Array<{ reason: string }>
    assert.deepEqual(resent.map((x) => x.reason), ["fresh-session"])
  } finally { await teardown(r) }
})

test("acp-bridge: the contract owed to a fresh session waits behind a slash command", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "acp-bridge-"))
  const agentLog = join(stateDir, "agent-frames.jsonl")
  const r = rig("no-load", { stateDir, agentLog, contractFor: CONTRACT })
  try {
    const info = await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: stateDir, agentId: "fake", prompt: "go", userText: "go" })
    await untilIdle(r, "s1")
    r.bridge.releaseSession("t1", "s1", "session-deleted")
    await send(r, "/review", info.acpSessionId)
    await send(r, "/Users/me/notes.md is the file")
    assert.deepEqual(promptsSent(agentLog).slice(1), ["/review", "FRIZZ-CONTRACT for t1/s1\n\n/Users/me/notes.md is the file"])
  } finally { await teardown(r) }
})

// The frames in the fake are recorded from opencode 2.0.27: the first `tool_call` carries `{cwd}`, the
// command arrives on an `in_progress` update, and the completing update carries no input.
test("acp-bridge: a shell call's command arrives on a later update and reaches the row, live and on reload", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "WIRE_SHELL", userText: "WIRE_SHELL" })
    await untilIdle(r, "s1")
    const recs = records(r, "s1")
    const inputs = recs.filter((x) => x.kind === "acp-tool-input" && x.id === "call_sh") as Array<{ id: string; input: unknown }>
    assert.deepEqual(inputs.map((x) => [x.id, x.input]), [["call_sh", { command: "echo wireprobe", cwd: "/tmp/project" }]], "recorded once, though the update repeats")
    assert.equal(recs.filter((x) => x.kind === "tool-call" && x.id === "call_sh").length, 1, "still one call")
    const msgs = readAcpTranscriptFile(acpTranscriptPath(r.stateDir, "s1"), "s1", acpUserRecordProjector)
    const call = msgs.flatMap((m) => m.tools).find((t) => t.name === "shell")!
    assert.equal(call.command, "echo wireprobe")
    assert.equal(call.detail, "echo wireprobe")
    assert.equal(call.status, "completed")
    assert.equal(call.output, "wireprobe\n")
  } finally { await teardown(r) }
})

test("acp-bridge: a sub-agent's text, reasoning, title and usage stay out of the parent's message", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "WIRE_CHILD", userText: "WIRE_CHILD" })
    await untilIdle(r, "s1")
    const recs = records(r, "s1")
    const written = JSON.stringify(recs.filter((x) => x.kind === "assistant-text" || x.kind === "reasoning"))
    assert.ok(written.includes("It printed childprobe."))
    assert.ok(!written.includes("stdout (exact)"), "the child's message is not the parent's prose")
    assert.ok(!written.includes("spawner"), "nor its reasoning")
    const end = recs.find((x) => x.kind === "turn-end") as { finalText?: string }
    assert.equal(end.finalText, "It printed childprobe.")
    assert.equal(recs.filter((x) => x.kind === "title").length, 0)
    assert.equal(recs.filter((x) => x.kind === "context-usage").length, 0)
    assert.ok(recs.some((x) => x.kind === "tool-call" && x.id === "ses_child:call_c"), "the child's tool row stays")
  } finally { await teardown(r) }
})

test("acp-bridge: ending a session under a queued message sends nothing into the closing connection and hands the message back", async () => {
  const r = rig()
  const stranded: Array<{ threadSlug: string; followUps: Array<{ text: string; deliveryId?: string }> }> = []
  r.bridge.onFollowUpsStranded((event) => stranded.push(event))
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "count SLOW", userText: "count SLOW" })
    await new Promise((res) => setTimeout(res, 60))
    assert.equal((await r.bridge.followUp({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", text: "second", deliveryId: "d2" })).state, "queued")
    await r.bridge.endSession("t1", "s1")
    assert.deepEqual(stranded.map((e) => [e.threadSlug, e.followUps]), [["t1", [{ text: "second", deliveryId: "d2" }]]])
    const recs = records(r, "s1")
    assert.equal(recs.filter((x) => x.kind === "provider-error").length, 0, "a stop is not a failed request")
    assert.equal(recs.filter((x) => x.kind === "user-message").length, 1, "the queued message opened no turn")
    assert.equal(liveAcpDaemonRecord(r.stateDir, "s1"), null, "the agent is gone")
    assert.equal(r.bridge.isEnding("s1"), false)
  } finally { await teardown(r) }
})

test("acp-bridge: a follow-up sent while the session is ending waits, then opens a new agent", async () => {
  const r = rig()
  try {
    const opened = await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "count SLOW", userText: "count SLOW" })
    await new Promise((res) => setTimeout(res, 60))
    const ending = r.bridge.endSession("t1", "s1")
    assert.equal(r.bridge.isEnding("s1"), true)
    const sent = await r.bridge.followUp({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", acpSessionId: opened.acpSessionId, text: "after the stop", deliveryId: "d2" })
    await ending
    assert.equal(sent.resumed, "loaded")
    assert.equal(sent.state, "delivered")
    await untilIdle(r, "s1")
    const recs = records(r, "s1")
    assert.equal(recs.filter((x) => x.kind === "provider-error").length, 0)
    const ends = recs.filter((x) => x.kind === "turn-end") as Array<{ successful?: boolean }>
    assert.deepEqual(ends.map((e) => e.successful), [false, true])
    assert.ok(liveAcpDaemonRecord(r.stateDir, "s1"), "the new agent is up")
  } finally { await teardown(r) }
})

test("acp-bridge: an agent that dies under a turn hands back what was queued behind it", async () => {
  const r = rig()
  const stranded: string[] = []
  r.bridge.onFollowUpsStranded((event) => stranded.push(...event.followUps.map((f) => f.text)))
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "count SLOW", userText: "count SLOW" })
    await new Promise((res) => setTimeout(res, 60))
    await r.bridge.followUp({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", text: "second", deliveryId: "d2" })
    process.kill(liveAcpDaemonRecord(r.stateDir, "s1")!.childPid, "SIGKILL")
    const t0 = Date.now()
    while (!stranded.length && Date.now() - t0 < 5_000) await new Promise((res) => setTimeout(res, 20))
    assert.deepEqual(stranded, ["second"])
    assert.equal(records(r, "s1").filter((x) => x.kind === "user-message").length, 1, "it opened no turn")
  } finally { await teardown(r) }
})

test("acp-bridge: a prompt the agent never read leaves a card that says so", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, agentId: "fake", prompt: "DIE_UNHEARD", userText: "DIE_UNHEARD" })
    const t0 = Date.now()
    while (!records(r, "s1").some((x) => x.kind === "turn-end") && Date.now() - t0 < 5_000) await new Promise((res) => setTimeout(res, 20))
    const error = records(r, "s1").find((x) => x.kind === "provider-error") as { error: { details?: string } }
    assert.match(error.error.details ?? "", /did not read this message/)
  } finally { await teardown(r) }
})
