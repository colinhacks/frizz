import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import Database from "../sqlite.ts"
import { createInteractionStore, type InteractionStore } from "../interaction-store.ts"
import { newTailState } from "../tailer.ts"
import { daemonAcpHost, liveAcpDaemonSessionIds, stopAcpDaemon } from "./acp-host.ts"
import { spawnAcpChild } from "./acp-rpc.ts"
import { parseAcpRecord, type AcpRecord } from "./acp-transcript.ts"
import { createAntigravityBridge, type AntigravityBridge } from "./antigravity-bridge.ts"
import { antigravityTranscriptPath, createAntigravityBackend, projectAntigravityTranscript } from "./antigravity-transcript.ts"
import { opencodeToolCards } from "../transcript.ts"

// The bridge against a fake `agy` that speaks the measured dialect over REAL stdio (and, where it says
// so, through the REAL detached daemon), with a REAL InteractionStore. What the tailer folds and the
// drawer projects is read back from the transcript file the bridge wrote. The same scenarios run against
// the real CLI in `_live_antigravity.mts`.

const FAKE = fileURLToPath(new URL("./antigravity.fixtures/fake-agy.mjs", import.meta.url))

interface Rig { bridge: AntigravityBridge; stateDir: string; store: InteractionStore; log: string; status: number; diagnostics: string[] }

function rig(opts: { mode?: string; daemon?: boolean; stateDir?: string; installed?: boolean; quietMs?: number; contract?: string } = {}): Rig {
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "agy-bridge-"))
  const log = join(stateDir, "agy-frames.jsonl")
  const store = createInteractionStore(new Database(":memory:"))
  const r: Rig = { stateDir, store, log, status: 0, diagnostics: [], bridge: undefined as unknown as AntigravityBridge }
  // The fake is "installed" as a node script: every launch is `node fake-agy.mjs <agy's own arguments>`.
  const asNode = <T extends { command: string; args: readonly string[] }>(o: T): T => ({ ...o, command: process.execPath, args: [FAKE, ...o.args] })
  r.bridge = createAntigravityBridge({
    projectId: "proj-1",
    stateDir,
    interactions: store,
    env: { ...process.env, FAKE_AGY_MODE: opts.mode ?? "", FAKE_AGY_LOG: log },
    bin: () => (opts.installed === false ? undefined : "/fake/bin/agy"),
    spawn: (o) => spawnAcpChild(asNode(o)),
    // The production transport: a REAL detached daemon per session. Without it, a plain child.
    ...(opts.daemon ? { host: (o) => daemonAcpHost(asNode(o)) } : {}),
    contractFor: () => opts.contract ?? "THE CONTRACT",
    onStatusChange: () => { r.status++ },
    onDiagnostic: (d) => { if (d.kind !== "stderr") r.diagnostics.push(`${d.kind}: ${d.message}`) },
    flushMs: 20,
    quietMs: opts.quietMs ?? 150,
    initializeTimeoutMs: 5_000,
  })
  return r
}

/** `shutdown()` DETACHES from a daemon (that is its point), so a test ends its daemons itself. */
async function teardown(r: Rig): Promise<void> {
  await r.bridge.shutdown()
  for (const sessionId of liveAcpDaemonSessionIds(r.stateDir)) await stopAcpDaemon(r.stateDir, sessionId)
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
