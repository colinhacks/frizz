import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import Database from "../sqlite.ts"
import { createInteractionStore, type InteractionStore } from "../interaction-store.ts"
import { newTailState } from "../tailer.ts"
import { daemonAcpHost, liveAcpDaemonSessionIds, stopAcpDaemon } from "./acp-host.ts"
import { spawnAcpChild } from "./acp-rpc.ts"
import { parseAcpRecord, type AcpRecord } from "./acp-transcript.ts"
import { createAntigravityBridge, runAntigravityUsage, type AntigravityBridge } from "./antigravity-bridge.ts"
import { antigravityTranscriptPath, createAntigravityBackend, projectAntigravityTranscript } from "./antigravity-transcript.ts"
import { opencodeToolCards } from "../transcript.ts"

// The bridge against a fake `agy` that speaks the measured dialect over REAL stdio (and, where it says
// so, through the REAL detached daemon), with a REAL InteractionStore. What the tailer folds and the
// drawer projects is read back from the transcript file the bridge wrote. The same scenarios run against
// the real CLI in `_live_antigravity.mts`.

const FAKE = fileURLToPath(new URL("./antigravity.fixtures/fake-agy.mjs", import.meta.url))

interface Rig { bridge: AntigravityBridge; stateDir: string; store: InteractionStore; log: string; status: number; diagnostics: string[] }

interface RigOptions {
  mode?: string; daemon?: boolean; stateDir?: string; installed?: boolean; quietMs?: number; idleMs?: number; cancelWaitMs?: number; contract?: string
  /** The store in a file under the state directory, as the server's is: a second rig on the same
   *  directory reads what the first one journaled. */
  persistentStore?: boolean
}

function rig(opts: RigOptions = {}): Rig {
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "agy-bridge-"))
  const log = join(stateDir, "agy-frames.jsonl")
  const store = createInteractionStore(new Database(opts.persistentStore ? join(stateDir, "interactions.db") : ":memory:"))
  const r: Rig = { stateDir, store, log, status: 0, diagnostics: [], bridge: undefined as unknown as AntigravityBridge }
  // The fake is "installed" as a node script: every launch is `node fake-agy.mjs <agy's own arguments>`.
  const asNode = <T extends { command: string; args: readonly string[] }>(o: T): T => ({ ...o, command: process.execPath, args: [FAKE, ...o.args] })
  r.bridge = createAntigravityBridge({
    projectId: "proj-1",
    stateDir,
    interactions: store,
    env: { ...process.env, FAKE_AGY_MODE: opts.mode ?? "", FAKE_AGY_LOG: log, FAKE_AGY_USAGE_FAIL: join(stateDir, "usage-fails") },
    bin: () => (opts.installed === false ? undefined : "/fake/bin/agy"),
    spawn: (o) => spawnAcpChild(asNode(o)),
    runUsage: (o) => runAntigravityUsage(asNode(o)),
    // The production transport: a REAL detached daemon per session. Without it, a plain child.
    ...(opts.daemon ? { host: (o) => daemonAcpHost(asNode(o)) } : {}),
    contractFor: () => opts.contract ?? "THE CONTRACT",
    onStatusChange: () => { r.status++ },
    onDiagnostic: (d) => { if (d.kind !== "stderr") r.diagnostics.push(`${d.kind}: ${d.message}`) },
    flushMs: 20,
    quietMs: opts.quietMs ?? 150,
    ...(opts.idleMs ? { idleMs: opts.idleMs } : {}),
    ...(opts.cancelWaitMs ? { cancelWaitMs: opts.cancelWaitMs } : {}),
    initializeTimeoutMs: 5_000,
  })
  return r
}

/** `shutdown()` DETACHES from a daemon (that is its point), so a test ends its daemons itself. */
async function teardown(r: Rig): Promise<void> {
  await r.bridge.shutdown()
  for (const sessionId of liveAcpDaemonSessionIds(r.stateDir)) await stopAcpDaemon(r.stateDir, sessionId)
  rmSync(r.stateDir, { recursive: true, force: true })
}

const records = (r: Rig, sessionId = "s1"): AcpRecord[] =>
  readFileSync(antigravityTranscriptPath(r.stateDir, sessionId), "utf8").split("\n").map(parseAcpRecord).filter((x): x is AcpRecord => x !== undefined)
const kinds = (r: Rig, sessionId = "s1"): string[] => records(r, sessionId).map((x) => x.kind)
const frames = (r: Rig): any[] => readFileSync(r.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
const sent = (r: Rig, method: string): any[] => frames(r).filter((f) => f.method === method)

async function until(what: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((res) => setTimeout(res, 15))
  }
}
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))
const count = (r: Rig, kind: string): number => kinds(r).filter((k) => k === kind).length
const finalTexts = (r: Rig): Array<string | undefined> => records(r).filter((x) => x.kind === "turn-end").map((x) => (x as { finalText?: string }).finalText)
const untilIdle = (r: Rig, sessionId = "s1", slug = "t1") => until("the turn to end", () => r.bridge.turnLiveness(slug, sessionId)?.turnActive !== true)
const untilTurn = (r: Rig, sessionId = "s1", slug = "t1") => until("a turn to start", () => r.bridge.turnLiveness(slug, sessionId)?.turnActive === true)

const scope = { projectId: "proj-1", threadSlug: "t1", sessionId: "s1" }
async function card(r: Rig) {
  await until("a card", () => r.store.listPending(scope).length > 0)
  return r.store.listPending(scope)[0]!
}

const base = { threadSlug: "t1", sessionId: "s1" }

test("antigravity-bridge: a dispatch appends the contract as a system prompt, applies the profile, and writes a foldable transcript", async () => {
  const r = rig({ daemon: true })
  try {
    const info = await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, modelId: "gem-flash", effort: "low", permissionMode: "acceptEdits", prompt: "ORIENTATION\n\nSay hi", userText: "Say hi" })
    assert.match(info.agySessionId, /^agy_/)
    assert.deepEqual({ version: info.version, model: info.model, effort: info.effort, mode: info.mode }, { version: "9.9.9", model: "gem-flash", effort: "low", mode: "accept-edits" })
    await untilIdle(r)

    // What reached the agent: the contract in the session's system prompt and NOT in the prompt, the form
    // capability that turns `ask_question` into a request, and the profile as session options.
    assert.deepEqual(frames(r)[0], { argv: ["acp"] }, "no bypass flag outside bypass")
    assert.deepEqual(sent(r, "initialize")[0].params.clientCapabilities.elicitation, { form: {} })
    assert.deepEqual(sent(r, "session/new")[0].params._meta, { antigravity: { systemPrompt: { append: "THE CONTRACT" } } })
    assert.deepEqual(sent(r, "session/set_config_option").map((f) => [f.params.configId, f.params.value]), [["thought_level", "low"], ["mode", "accept-edits"]], "the default model is not asked for again")
    assert.deepEqual(sent(r, "session/prompt")[0].params.prompt, [{ type: "text", text: "ORIENTATION\n\nSay hi" }])

    const recs = records(r)
    assert.deepEqual(recs.map((x) => x.kind), ["acp-session", "user-message", "turn-start", "reasoning", "tool-call", "tool-result", "assistant-text", "context-usage", "turn-end"])
    assert.equal((recs[1] as { text: string }).text, "Say hi", "the transcript records what the human wrote")
    assert.equal((recs[3] as { text: string }).text, "thinking about it")
    // The tool call is written in the vocabulary Frizz's cards are built from, and the result is the
    // command's own output with agy's report header and CRLFs gone. A repeated closing frame adds nothing.
    assert.deepEqual({ name: (recs[4] as any).name, input: (recs[4] as any).input }, { name: "Bash", input: { command: "echo hi", description: "Saying hi" } })
    assert.equal((recs[5] as { text: string }).text, "hi\n")
    assert.equal((recs[8] as { finalText?: string }).finalText, "PONG")

    // The fold the tailer runs, and the drawer.
    const raw = readFileSync(antigravityTranscriptPath(r.stateDir, "s1"), "utf8")
    const state = newTailState("t1", "s1", "/x")
    const backend = createAntigravityBackend({ stateDir: r.stateDir })
    for (const line of raw.split("\n")) backend.foldLine(state, line)
    assert.equal(state.turn, "idle")
    assert.equal(state.lastAssistant, "PONG")
    assert.equal(state.model, "gem-flash")
    const messages = projectAntigravityTranscript(raw, "antigravity:s1", opencodeToolCards)
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "assistant"])
    const tool = messages.flatMap((m) => m.tools)[0]!
    assert.equal(tool.name, "Bash")
    assert.equal(tool.status, "completed")
    assert.deepEqual(r.bridge.commands("t1", "s1").map((c) => c.name), ["compact", "usage"], "the agent's slash commands are the thread's")
    assert.ok(r.status >= 2, "the board heard the turn start and end")
  } finally { await teardown(r) }
})

test("antigravity-bridge: bypass is a launch flag, and the session under it stays on the default mode", async () => {
  const r = rig()
  try {
    const info = await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, permissionMode: "bypassPermissions", prompt: "go", userText: "go" })
    await untilIdle(r)
    assert.deepEqual(frames(r)[0], { argv: ["acp", "--dangerously-skip-permissions"] })
    assert.equal(info.mode, "default")
    assert.deepEqual(sent(r, "session/set_config_option"), [], "nothing to change: the default model, its default level, the default mode")
  } finally { await teardown(r) }
})

test("antigravity-bridge: a thinking level is not asked of a model that takes none, and a refused one is noted", async () => {
  const r = rig()
  try {
    const info = await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, modelId: "third-party", effort: "high", prompt: "go", userText: "go" })
    await untilIdle(r)
    assert.deepEqual({ model: info.model, effort: info.effort }, { model: "third-party", effort: undefined })
    assert.deepEqual(sent(r, "session/set_config_option").map((f) => f.params.configId), ["model"])

    const refused = await r.bridge.setProfile("t1", "s1", { modelId: "gem-flash", effort: "xhigh" })
    assert.deepEqual(refused, { applied: true, model: "gem-flash", effort: "high" }, "the session runs on what the agent kept")
    const note = records(r).filter((x) => x.kind === "acp-note").at(-1) as { text: string }
    assert.match(note.text, /could not set the thinking level to xhigh .*not offered.*runs at high/)
  } finally { await teardown(r) }
})

test("antigravity-bridge: a follow-up sent mid-turn joins the turn, which ends when the last prompt returns", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "SLOW", userText: "SLOW" })
    await until("the agent to speak", () => kinds(r).includes("assistant-text"))
    const steer = await r.bridge.followUp({ ...base, cwd: r.stateDir, text: "STOP_NOW please" })
    assert.deepEqual({ state: steer.state, resumed: steer.resumed }, { state: "steered", resumed: "live" })
    // The first prompt has returned (the fake answers it the moment it is steered), and the turn is still on.
    assert.equal(r.bridge.turnLiveness("t1", "s1")?.turnActive, true)
    await untilIdle(r)
    const recs = records(r)
    assert.equal(recs.filter((x) => x.kind === "turn-start").length, 1)
    assert.equal(recs.filter((x) => x.kind === "turn-end").length, 1)
    assert.deepEqual(recs.filter((x) => x.kind === "user-message").map((x) => (x as { text: string }).text), ["SLOW", "STOP_NOW please"])
    assert.equal((recs.at(-1) as { finalText?: string }).finalText, "STOPPED", "what was said before the steer is not the turn's answer")
    assert.equal(sent(r, "session/prompt").length, 2)
  } finally { await teardown(r) }
})

test("antigravity-bridge: stopping a turn cancels it and records the cancelled call", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "SLOW", userText: "SLOW" })
    await until("the agent to speak", () => kinds(r).includes("assistant-text"))
    assert.deepEqual(await r.bridge.interruptTurn("t1", "s1"), { interrupted: true })
    assert.equal(r.bridge.turnLiveness("t1", "s1")?.turnActive, false)
    const recs = records(r)
    assert.equal((recs.find((x) => x.kind === "tool-result") as { cancelled?: boolean }).cancelled, true)
    const end = recs.findIndex((x) => x.kind === "turn-end")
    assert.equal((recs[end] as { successful: boolean }).successful, false)
    assert.equal((recs[end + 1] as { text: string }).text, "Turn cancelled.")
    assert.deepEqual(await r.bridge.interruptTurn("t1", "s1"), { interrupted: false }, "nothing is running now")
  } finally { await teardown(r) }
})

test("antigravity-bridge: work the agent starts by itself is a turn of its own, closed by silence after a usage reading", async () => {
  const r = rig({ quietMs: 120 })
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "BACKGROUND", userText: "BACKGROUND" })
    await until("the first turn to end", () => kinds(r).includes("turn-end"))
    assert.equal((records(r).find((x) => x.kind === "tool-call") as any).input.run_in_background, true)
    assert.equal(kinds(r).includes("tool-result"), false, "the daemon command outlives the turn that started it")

    await untilTurn(r)
    assert.equal(r.bridge.turnLiveness("t1", "s1")?.autonomous, true)
    await untilIdle(r)
    const recs = records(r)
    const firstEnd = recs.findIndex((x) => x.kind === "turn-end")
    // The command's result lands with no turn open, where its call is; the agent SPEAKING is what opens one.
    assert.deepEqual(recs.slice(firstEnd + 1).map((x) => x.kind), ["tool-result", "user-message", "turn-start", "assistant-text", "context-usage", "turn-end"])
    assert.equal((recs[firstEnd + 1] as { text: string }).text, "late\n")
    const wake = recs[firstEnd + 2] as { text: string; synthetic?: boolean }
    assert.equal(wake.synthetic, true)
    assert.match(wake.text, /carried on by itself/)
    assert.deepEqual({ finalText: (recs.at(-1) as any).finalText, successful: (recs.at(-1) as any).successful }, { finalText: "The background command printed late.", successful: true })
  } finally { await teardown(r) }
})

test("antigravity-bridge: a plain frizzctl command is allowed without a card; anything else asks", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, permissionMode: "default", prompt: "RUN: frizzctl title 'Fix the lookup'", userText: "go" })
    await untilIdle(r)
    assert.equal(r.store.listPending(scope).length, 0)
    assert.deepEqual(frames(r).find((f) => f.permissionOutcome)?.permissionOutcome, { outcome: "selected", optionId: "allow" })

    await r.bridge.followUp({ ...base, cwd: r.stateDir, text: "RUN: frizzctl done && rm -rf build" })
    const pending = await card(r)
    assert.equal(pending.provider.kind, "antigravity")
    assert.equal(pending.payload.kind, "command-approval")
    assert.equal((pending.payload as { command: { preview: string } }).command.preview, "frizzctl done && rm -rf build")
    assert.deepEqual(pending.allowedDecisions.map((d) => [d.id, d.semantic]), [["accept", "approve"], ["decline", "deny"]])
    assert.equal(r.bridge.ownsInteraction(scope, pending.id), true)
    r.store.resolve(scope, { slug: "t1", sessionId: "s1", interactionId: pending.id, sessionEpoch: pending.owner.sessionEpoch, capabilityRevision: pending.owner.capabilityRevision, expectedRecordRevision: pending.recordRevision, responseId: "resp-1", decisionId: "decline" })
    await untilIdle(r)
    assert.deepEqual(frames(r).filter((f) => f.permissionOutcome).at(-1)?.permissionOutcome, { outcome: "selected", optionId: "deny" })
    assert.equal((records(r).at(-1) as { finalText?: string }).finalText, "DENIED")
    assert.equal((records(r).filter((x) => x.kind === "tool-result").at(-1) as { failed?: boolean }).failed, true)
  } finally { await teardown(r) }
})

test("antigravity-bridge: ask_question becomes a question card, and its answer goes back in the form's own terms", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "ASK", userText: "ASK" })
    const pending = await card(r)
    assert.equal(pending.payload.kind, "agent-question")
    const fields = (pending.payload as any).fields
    assert.deepEqual(fields.map((f: any) => [f.id, f.input]), [["q1", "select"], ["q1_notes", "multiline"], ["q2", "multi-select"]])
    assert.deepEqual(fields[0].options, [{ value: "1", label: "SQLite" }, { value: "2", label: "JSON file" }])
    r.store.resolve(scope, { slug: "t1", sessionId: "s1", interactionId: pending.id, sessionEpoch: 0, capabilityRevision: 0, expectedRecordRevision: pending.recordRevision, responseId: "resp-1", decisionId: "answer", values: { q1: "2", q1_notes: "one per project", q2: ["1", "3"] } })
    await untilIdle(r)
    assert.deepEqual(frames(r).find((f) => f.elicitationResult)?.elicitationResult, { action: "accept", content: { q1: "2", q1_other: "one per project", q2: ["1", "3"] } })
    const ask = projectAntigravityTranscript(readFileSync(antigravityTranscriptPath(r.stateDir, "s1"), "utf8"), "antigravity:s1", opencodeToolCards).flatMap((m) => m.tools).find((t) => t.ask)!
    assert.equal(ask.name, "AskUserQuestion")
    assert.deepEqual(ask.askAnswers, ["JSON file, one per project", "Mon, Wed"])
  } finally { await teardown(r) }
})

test("antigravity-bridge: a declined question tells the agent nobody answered", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "ASK", userText: "ASK" })
    const pending = await card(r)
    r.store.resolve(scope, { slug: "t1", sessionId: "s1", interactionId: pending.id, sessionEpoch: 0, capabilityRevision: 0, expectedRecordRevision: pending.recordRevision, responseId: "resp-1", decisionId: "decline" })
    await untilIdle(r)
    assert.deepEqual(frames(r).find((f) => f.elicitationResult)?.elicitationResult, { action: "decline" })
  } finally { await teardown(r) }
})

test("antigravity-bridge: a follow-up after the agent has gone resumes the session and puts the profile back", async () => {
  const r = rig({ daemon: true })
  try {
    const first = await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, effort: "low", prompt: "go", userText: "go" })
    await untilIdle(r)
    await r.bridge.endSession("t1", "s1")
    assert.equal(r.bridge.isAgentAlive("t1", "s1"), false)
    const before = records(r).length
    const again = await r.bridge.followUp({ ...base, cwd: r.stateDir, agySessionId: first.agySessionId, effort: "low", text: "more" })
    assert.deepEqual({ state: again.state, resumed: again.resumed, id: again.agySessionId, effort: again.effort }, { state: "delivered", resumed: "resumed", id: first.agySessionId, effort: "low" })
    await untilIdle(r)
    // `session/resume`, with no system prompt on it: the session kept the contract. The level is asked
    // for again, because the agent keeps no config option across a reopen.
    assert.deepEqual(sent(r, "session/resume").map((f) => f.params), [{ sessionId: first.agySessionId, cwd: r.stateDir, mcpServers: [] }])
    assert.equal(sent(r, "session/new").length, 1)
    assert.equal(sent(r, "session/set_config_option").filter((f) => f.params.configId === "thought_level").length, 2)
    assert.deepEqual(records(r).slice(before).map((x) => x.kind), ["user-message", "turn-start", "reasoning", "tool-call", "tool-result", "assistant-text", "context-usage", "turn-end"], "no second header, no replayed history")
  } finally { await teardown(r) }
})

test("antigravity-bridge: a session that cannot be resumed starts fresh, with the contract again, and the transcript says so", async () => {
  const r = rig({ mode: "no-resume" })
  try {
    const first = await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "go", userText: "go" })
    await untilIdle(r)
    await r.bridge.endSession("t1", "s1")
    const again = await r.bridge.followUp({ ...base, cwd: r.stateDir, agySessionId: first.agySessionId, text: "more" })
    assert.equal(again.resumed, "fresh")
    assert.notEqual(again.agySessionId, first.agySessionId)
    await untilIdle(r)
    assert.equal(sent(r, "session/new").length, 2)
    assert.deepEqual(sent(r, "session/new")[1].params._meta, { antigravity: { systemPrompt: { append: "THE CONTRACT" } } })
    const note = records(r).filter((x) => x.kind === "acp-note").at(-1) as { text: string }
    assert.match(note.text, /fresh Antigravity session.*no longer has the earlier conversation/)
  } finally { await teardown(r) }
})

test("antigravity-bridge: a live session takes a model, level or mode change at once, and a move to bypass restarts the agent", async () => {
  const r = rig({ daemon: true })
  try {
    const first = await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, permissionMode: "default", prompt: "go", userText: "go" })
    await untilIdle(r)
    assert.deepEqual(await r.bridge.setProfile("t1", "s1", { modelId: "gem-flash", effort: "medium", permissionMode: "plan" }), { applied: true, model: "gem-flash", effort: "medium" })
    assert.equal(r.bridge.session("t1", "s1")?.mode, "plan")

    // Bypass cannot be put on a running agent. Idle, it is restarted now; the next message resumes on the flag.
    assert.deepEqual(await r.bridge.setProfile("t1", "s1", { modelId: "gem-flash", effort: "medium", permissionMode: "bypassPermissions" }), { applied: true, restarting: true, model: "gem-flash", effort: "medium" })
    assert.equal(r.bridge.isAgentAlive("t1", "s1"), false)
    const again = await r.bridge.followUp({ ...base, cwd: r.stateDir, agySessionId: first.agySessionId, modelId: "gem-flash", effort: "medium", permissionMode: "bypassPermissions", text: "more" })
    assert.equal(again.resumed, "resumed")
    await untilIdle(r)
    assert.deepEqual(frames(r).filter((f) => f.argv).map((f) => f.argv), [["acp"], ["acp", "--dangerously-skip-permissions"]])
    assert.deepEqual(await r.bridge.setProfile("t1", "nope", {}), { applied: false }, "a session that is not open takes its profile at the next open")
  } finally { await teardown(r) }
})

test("antigravity-bridge: a mode change to bypass made mid-turn restarts the agent when that turn ends", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, permissionMode: "default", prompt: "SLOW", userText: "SLOW" })
    await until("the agent to speak", () => kinds(r).includes("assistant-text"))
    const result = await r.bridge.setProfile("t1", "s1", { permissionMode: "bypassPermissions" })
    assert.equal(result.restarting, true)
    assert.equal(r.bridge.turnLiveness("t1", "s1")?.turnActive, true, "the turn in flight is left alone")
    await r.bridge.followUp({ ...base, cwd: r.stateDir, permissionMode: "bypassPermissions", text: "STOP_NOW" })
    await until("the agent to be retired", () => r.bridge.turnLiveness("t1", "s1") === undefined)
    assert.equal((records(r).filter((x) => x.kind === "turn-end").at(-1) as { successful: boolean }).successful, true, "the turn ended on its own terms first")
  } finally { await teardown(r) }
})

test("antigravity-bridge: /compact records a compaction and re-sends nothing", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "go", userText: "go" })
    await untilIdle(r)
    const before = records(r).length
    await r.bridge.followUp({ ...base, cwd: r.stateDir, text: "/compact" })
    await untilIdle(r)
    assert.deepEqual(records(r).slice(before).map((x) => x.kind), ["user-message", "turn-start", "compaction", "turn-end"])
    assert.equal(sent(r, "session/prompt").length, 2, "the contract is the session's system prompt; nothing follows the compaction")
  } finally { await teardown(r) }
})

test("antigravity-bridge: the model list names each model's own thinking levels, and says why when it cannot be read", async () => {
  const r = rig()
  try {
    assert.deepEqual(await r.bridge.models(r.stateDir), {
      available: true,
      version: "9.9.9",
      defaultModel: "gem-flash",
      tier: "Free",
      models: [
        { id: "gem-flash", name: "Gem Flash", efforts: ["low", "medium", "high"], defaultEffort: "high" },
        { id: "third-party", name: "Third Party", efforts: [] },
      ],
    })
    assert.equal(sent(r, "session/prompt").length, 0, "reading the list costs no tokens")
    assert.equal(sent(r, "session/close").length, 1)
  } finally { await teardown(r) }

  const signedOut = rig({ mode: "no-auth" })
  try {
    const list = await signedOut.bridge.models(signedOut.stateDir)
    assert.deepEqual({ available: list.available, models: list.models }, { available: true, models: [] })
    assert.match(list.error ?? "", /not signed in\. Run `agy` in a terminal/)
    await assert.rejects(signedOut.bridge.spawnDispatch({ ...base, cwd: signedOut.stateDir, prompt: "go", userText: "go" }), /needs a sign-in first: run `agy`/)
    assert.equal(signedOut.bridge.turnLiveness("t1", "s1"), undefined, "a failed open leaves no session")
  } finally { await teardown(signedOut) }

  const missing = rig({ installed: false })
  try {
    assert.equal(missing.bridge.bin(), undefined)
    assert.deepEqual(await missing.bridge.models(missing.stateDir), { available: false, models: [], error: "Antigravity is not installed: `agy` is not on PATH." })
    await assert.rejects(missing.bridge.spawnDispatch({ ...base, cwd: missing.stateDir, prompt: "go", userText: "go" }), /is not installed: `agy` is not on PATH/)
  } finally { await teardown(missing) }
})

test("antigravity-bridge: a turn survives a Frizz restart in its daemon, and the next bridge adopts it", async () => {
  const a = rig({ daemon: true })
  let b: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, prompt: "SLOW", userText: "SLOW" })
    await until("the agent to speak", () => kinds(a).includes("assistant-text"))
    await a.bridge.shutdown()
    assert.equal(kinds(a).includes("turn-end"), false, "a detach leaves the turn open in the file")

    b = rig({ daemon: true, stateDir: a.stateDir })
    assert.equal(b.bridge.isAgentAlive("t1", "s1"), true)
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    assert.equal(b.bridge.turnLiveness("t1", "s1")?.turnActive, true, "the prompt still in flight is this bridge's turn now")
    await b.bridge.followUp({ ...base, cwd: a.stateDir, text: "STOP_NOW" })
    await untilIdle(b)
    const recs = records(b)
    assert.equal(recs.filter((x) => x.kind === "turn-start").length, 1)
    assert.equal(recs.filter((x) => x.kind === "turn-end").length, 1)
    assert.match((recs.find((x) => x.kind === "acp-note") as { text: string }).text, /Reattached to the running Antigravity session/)
    assert.equal(sent(b, "session/new").length, 1, "the same agent, the same session")
  } finally { await teardown(b ?? a) }
})

test("antigravity-bridge: quota is agy's own usage report, each limit naming the models it meters", async () => {
  const r = rig()
  try {
    const usageRuns = () => frames(r).filter((f) => f.argv?.[0] === "-p").length
    const quota = await r.bridge.quota(r.stateDir)
    assert.deepEqual(quota, {
      status: "ok",
      // The plan is the one the model list's session reported.
      planType: "Free",
      windows: [
        // The configured model is Gem Flash, so the bare slug ("") is metered with it.
        { key: "gem-weekly", label: "Gem", usedPercent: 25, resetsAt: Date.parse("2026-11-27T18:21:42Z") / 1000, models: ["gem-flash", ""], span: "weekly" },
        { key: "3p-weekly", label: "Third party", usedPercent: 0, resetsAt: Date.parse("2026-11-27T19:44:49Z") / 1000, models: ["third-party"], span: "weekly" },
      ],
    })
    assert.deepEqual(frames(r).find((f) => f.argv?.[0] === "-p")!.argv, ["-p", "/usage", "--output-format", "json"])
    // A reading is held: the gauge's poll starts nothing, and its click does.
    await r.bridge.quota(r.stateDir)
    assert.equal(usageRuns(), 1)
    await r.bridge.quota(r.stateDir, { force: true })
    assert.equal(usageRuns(), 2)
    // A refresh that fails keeps the reading it had.
    writeFileSync(join(r.stateDir, "usage-fails"), "")
    assert.deepEqual(await r.bridge.quota(r.stateDir, { force: true }), quota)
    assert.equal(usageRuns(), 3)
    rmSync(join(r.stateDir, "usage-fails"))
  } finally { await teardown(r) }
})

test("antigravity-bridge: quota never runs the CLI's own prompt mode for an account ACP has not vouched for", async () => {
  // Signed out: the model list says so over ACP, and `agy -p` is not started to find out for itself.
  const signedOut = rig({ mode: "no-auth" })
  try {
    assert.deepEqual(await signedOut.bridge.quota(signedOut.stateDir), { status: "unavailable", windows: [], detail: "Antigravity is not signed in. Run `agy` in a terminal and sign in." })
    assert.equal(frames(signedOut).some((f) => f.argv?.[0] === "-p"), false)
  } finally { await teardown(signedOut) }
  const missing = rig({ installed: false })
  try {
    assert.deepEqual(await missing.bridge.quota(missing.stateDir), { status: "unavailable", windows: [], detail: "Antigravity is not installed" })
  } finally { await teardown(missing) }
  // With no reading to keep, a report that cannot be had says so.
  const failing = rig()
  try {
    writeFileSync(join(failing.stateDir, "usage-fails"), "")
    const quota = await failing.bridge.quota(failing.stateDir)
    assert.deepEqual({ status: quota.status, windows: quota.windows }, { status: "unavailable", windows: [] })
    assert.match(quota.detail ?? "", /^Antigravity did not report its usage: it exited with code 1$/)
  } finally { await teardown(failing) }
})

// ---- restarts, stops and races, each found by the stress run of 2026-11-20 ----------------------------

test("antigravity-bridge: a turn whose prompt returned while Frizz was away ends on the quiet rule, its tool call written once", async () => {
  const a = rig({ daemon: true })
  let b: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, prompt: "WAIT 300", userText: "wait" })
    await until("the tool call", () => kinds(a).includes("tool-call"))
    await a.bridge.shutdown()
    await sleep(800) // the call settles, the agent answers and the prompt returns, all to nobody
    b = rig({ daemon: true, stateDir: a.stateDir })
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    // The replay ends on the MESSAGE: in a turn a prompt started, `agy` sends a step's usage reading
    // first. The idle fallback is five minutes away, so only the quiet rule can end this in time.
    await untilIdle(b)
    assert.deepEqual(kinds(b), ["acp-session", "user-message", "turn-start", "tool-call", "acp-note", "tool-result", "context-usage", "assistant-text", "turn-end"])
    assert.deepEqual(records(b).at(-1), { ...records(b).at(-1), kind: "turn-end", finalText: "WAITED", successful: true })
  } finally { await teardown(b ?? a) }
})

for (const [name, away] of [["a restart while the agent writes its answer", 0], ["an answer finished while Frizz was away", 1_200]] as const) {
  test(`antigravity-bridge: ${name} leaves one message, and the turn's final text is all of it`, async () => {
    const a = rig({ daemon: true })
    let b: Rig | undefined
    try {
      await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, prompt: "TALK 40", userText: "talk" })
      await until("part of the answer in the file", () => count(a, "assistant-text") >= 2)
      await a.bridge.shutdown()
      if (away) await sleep(away)
      b = rig({ daemon: true, stateDir: a.stateDir })
      await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
      await untilIdle(b)
      const whole = `${Array.from({ length: 40 }, (_, i) => `w${i + 1} `).join("")}END`
      assert.deepEqual(finalTexts(b), [whole], "what a fence in the answer is read from")
      const messages = projectAntigravityTranscript(readFileSync(antigravityTranscriptPath(a.stateDir, "s1"), "utf8"), "antigravity:s1", opencodeToolCards).filter((m) => m.role === "assistant")
      assert.deepEqual(messages.map((m) => m.text), [whole], "one bubble, not one on each side of the restart")
    } finally { await teardown(b ?? a) }
  })
}

test("antigravity-bridge: a tool call that spans a Frizz restart is one call with one result", async () => {
  const a = rig({ daemon: true })
  let b: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, prompt: "WAIT 700", userText: "wait" })
    await until("the tool call", () => kinds(a).includes("tool-call"))
    await a.bridge.shutdown()
    b = rig({ daemon: true, stateDir: a.stateDir })
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    assert.deepEqual(b.bridge.turnLiveness("t1", "s1"), { sessionLive: true, turnActive: true, autonomous: false })
    await untilIdle(b)
    assert.deepEqual([count(b, "tool-call"), count(b, "tool-result"), count(b, "turn-start"), count(b, "turn-end")], [1, 1, 1, 1])
    const tools = projectAntigravityTranscript(readFileSync(antigravityTranscriptPath(a.stateDir, "s1"), "utf8"), "antigravity:s1", opencodeToolCards).flatMap((m) => m.tools)
    assert.deepEqual(tools.map((t) => t.status), ["completed"], "the drawer shows no second, forever-pending row")
  } finally { await teardown(b ?? a) }
})

test("antigravity-bridge: a card open across a Frizz restart is raised again, and its answer reaches the agent", async () => {
  const a = rig({ daemon: true, persistentStore: true })
  let b: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, permissionMode: "default", prompt: "RUN: ls -la", userText: "go" })
    const first = await card(a)
    await a.bridge.shutdown()
    assert.equal(a.store.listPending(scope).length, 0, "the old runtime cancels its card on the way out")
    // The same store, as the server's is: the daemon sends the request again, under the same tool call.
    b = rig({ daemon: true, stateDir: a.stateDir, persistentStore: true })
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    const again = await card(b)
    assert.notEqual(again.id, first.id, "a new card, not the cancelled one")
    b.store.resolve(scope, { slug: "t1", sessionId: "s1", interactionId: again.id, sessionEpoch: again.owner.sessionEpoch, capabilityRevision: again.owner.capabilityRevision, expectedRecordRevision: again.recordRevision, responseId: "resp-1", decisionId: "accept" })
    await untilIdle(b)
    assert.deepEqual(frames(b).filter((f) => f.permissionOutcome).at(-1)?.permissionOutcome, { outcome: "selected", optionId: "allow" })
    assert.deepEqual([finalTexts(b).at(-1), count(b, "tool-call"), count(b, "tool-result")], ["ALLOWED", 1, 1])
  } finally { await teardown(b ?? a) }
})

test("antigravity-bridge: Stop ends an agent that does not act on the cancel, and the next message resumes the session", async () => {
  const r = rig({ daemon: true, cancelWaitMs: 300 })
  try {
    const first = await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "DEAF 6000", userText: "deaf" })
    await until("the agent to speak", () => kinds(r).includes("assistant-text"))
    assert.deepEqual(await r.bridge.interruptTurn("t1", "s1"), { interrupted: true })
    // Detaching from the daemon would have left it working unobserved, for the next message to join.
    assert.equal(r.bridge.isAgentAlive("t1", "s1"), false)
    assert.deepEqual(kinds(r).slice(-2), ["turn-end", "acp-note"])
    assert.equal((records(r).at(-1) as { text: string }).text, "Turn cancelled.")
    const again = await r.bridge.followUp({ ...base, cwd: r.stateDir, agySessionId: first.agySessionId, text: "ECHO after" })
    assert.deepEqual({ state: again.state, resumed: again.resumed }, { state: "delivered", resumed: "resumed" })
    await untilIdle(r)
    assert.equal(finalTexts(r).at(-1), "ECHO after")
    assert.deepEqual([count(r, "turn-start"), count(r, "turn-end")], [2, 2])
  } finally { await teardown(r) }
})

test("antigravity-bridge: a message sent while a turn is being stopped waits for the stop and gets a turn of its own", async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "DEAF 400", userText: "deaf" })
    await until("the agent to speak", () => kinds(r).includes("assistant-text"))
    const stop = r.bridge.interruptTurn("t1", "s1")
    const follow = await r.bridge.followUp({ ...base, cwd: r.stateDir, text: "ECHO after" })
    assert.equal(follow.state, "delivered", "it did not join the turn being cancelled")
    await stop
    await untilIdle(r)
    const recs = records(r)
    const firstEnd = recs.findIndex((x) => x.kind === "turn-end")
    assert.ok(recs.findIndex((x) => x.kind === "user-message" && (x as { text: string }).text === "ECHO after") > firstEnd, "its words follow the stopped turn's ending")
    assert.deepEqual([count(r, "turn-start"), count(r, "turn-end"), finalTexts(r).at(-1)], [2, 2, "ECHO after"])
  } finally { await teardown(r) }
})

test("antigravity-bridge: a turn the agent started is not closed while a command of its own runs in silence", async () => {
  // The last resort is 200ms here and the command runs for 900ms.
  const r = rig({ quietMs: 100, idleMs: 200 })
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "WAKE_TOOL 900", userText: "go" })
    await until("the first turn to end", () => kinds(r).includes("turn-end"))
    await until("the agent to finish its check", () => records(r).some((x) => x.kind === "assistant-text" && (x as { text: string }).text.includes("CHECK DONE")))
    await untilIdle(r)
    const after = kinds(r).slice(kinds(r).indexOf("turn-end") + 1)
    assert.deepEqual(after, ["user-message", "turn-start", "assistant-text", "context-usage", "tool-call", "tool-result", "assistant-text", "context-usage", "turn-end"], "one turn, not one before the command and one after")
  } finally { await teardown(r) }
})

test("antigravity-bridge: a profile change made while the session is opening reaches it", async () => {
  const r = rig()
  try {
    const dispatch = r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, modelId: "gem-flash", effort: "high", prompt: "ECHO a", userText: "a" })
    assert.deepEqual(await r.bridge.setProfile("t1", "s1", { modelId: "third-party" }), { applied: true, model: "third-party" })
    await dispatch
    await untilIdle(r)
    assert.equal(r.bridge.session("t1", "s1")?.model, "third-party")
  } finally { await teardown(r) }
})

test("antigravity-bridge: leaving Bypass mid-turn is still owed a restart after Frizz itself restarts", async () => {
  const a = rig({ daemon: true })
  let b: Rig | undefined
  try {
    const first = await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, permissionMode: "bypassPermissions", prompt: "SLOW", userText: "SLOW" })
    await until("the agent to speak", () => kinds(a).includes("assistant-text"))
    assert.equal((await a.bridge.setProfile("t1", "s1", { permissionMode: "default" })).restarting, true)
    await a.bridge.shutdown()
    // The thread's row says Ask by now. The agent still running was launched to ask nothing.
    b = rig({ daemon: true, stateDir: a.stateDir })
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir, permissionMode: "default" }])
    await b.bridge.followUp({ ...base, cwd: a.stateDir, permissionMode: "default", text: "STOP_NOW" })
    await until("the bypass agent to be retired", () => b!.bridge.turnLiveness("t1", "s1") === undefined)
    await b.bridge.followUp({ ...base, cwd: a.stateDir, agySessionId: first.agySessionId, permissionMode: "default", text: "ECHO asked" })
    await untilIdle(b)
    assert.deepEqual(frames(b).filter((f) => f.argv).map((f) => f.argv), [["acp", "--dangerously-skip-permissions"], ["acp"]])
    assert.equal(finalTexts(b).at(-1), "ECHO asked")
  } finally { await teardown(b ?? a) }
})

test("antigravity-bridge: a turn whose agent did not survive the restart is closed at boot", async () => {
  const a = rig({ daemon: true })
  let b: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, prompt: "SLOW", userText: "SLOW" })
    await until("the agent to speak", () => kinds(a).includes("assistant-text"))
    await a.bridge.shutdown()
    await stopAcpDaemon(a.stateDir, "s1") // a reboot: the daemon is gone with everything else
    b = rig({ daemon: true, stateDir: a.stateDir })
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    assert.deepEqual(kinds(b).slice(-2), ["turn-end", "acp-note"])
    assert.match((records(b).at(-1) as { text: string }).text, /agent stopped while this turn was running/)
    const state = newTailState("t1", "s1", "/x")
    const backend = createAntigravityBackend({ stateDir: a.stateDir })
    for (const line of readFileSync(antigravityTranscriptPath(a.stateDir, "s1"), "utf8").split("\n")) backend.foldLine(state, line)
    assert.equal(state.turn, "idle", "the board stops spinning")
    // And it is written once: the next boot finds the turn closed.
    const before = kinds(b).length
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    assert.equal(kinds(b).length, before)
  } finally { await teardown(b ?? a) }
})

test("antigravity-bridge: a dispatch racing a shutdown is refused, and the closed bridge holds no session", async () => {
  const r = rig({ daemon: true })
  try {
    const dispatch = r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "ECHO a", userText: "a" })
    await r.bridge.shutdown()
    await assert.rejects(dispatch, /Antigravity bridge is closed/)
    assert.equal(r.bridge.turnLiveness("t1", "s1"), undefined)
    assert.equal(sent(r, "session/prompt").length, 0)
  } finally { await teardown(r) }
})

test("antigravity-bridge: a reading that cannot be had is held, so a poll does not start agy each time", async () => {
  const launches = (r: Rig) => frames(r).filter((f) => f.argv).length
  const signedOut = rig({ mode: "no-auth" })
  try {
    const first = await signedOut.bridge.models(signedOut.stateDir)
    assert.match(first.error ?? "", /not signed in/)
    assert.deepEqual(await signedOut.bridge.models(signedOut.stateDir), first)
    assert.equal(launches(signedOut), 1, "the second ask is answered from the first")
    await signedOut.bridge.models(signedOut.stateDir, { refresh: true })
    assert.equal(launches(signedOut), 2, "an explicit refresh asks again")
  } finally { await teardown(signedOut) }
  const failing = rig()
  try {
    writeFileSync(join(failing.stateDir, "usage-fails"), "")
    const usageRuns = () => frames(failing).filter((f) => f.argv?.[0] === "-p").length
    const first = await failing.bridge.quota(failing.stateDir)
    assert.equal(first.status, "unavailable")
    assert.deepEqual(await failing.bridge.quota(failing.stateDir), first)
    assert.equal(usageRuns(), 1, "the gauge's next poll runs nothing")
    rmSync(join(failing.stateDir, "usage-fails"))
    assert.equal((await failing.bridge.quota(failing.stateDir, { force: true })).status, "ok", "the gauge's click asks again")
    assert.equal(usageRuns(), 2)
  } finally { await teardown(failing) }
})
