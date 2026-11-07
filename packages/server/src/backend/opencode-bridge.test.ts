import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import Database from "../sqlite.ts"
import { createInteractionStore, type InteractionStore } from "../interaction-store.ts"
import { applyEvent, newTailState } from "../tailer.ts"
import { opencodeToolCards } from "../transcript.ts"
import { OPENCODE_CONTRACT_KEY, OpencodeSessionStream, createOpencodeBridge, opencodeFormAnswer, opencodeInboxId, type OpencodeBridge } from "./opencode-bridge.ts"
import { OpencodeHub } from "./opencode-hub.ts"
import { ensureOpencodeService, opencodeVersionAtLeast } from "./opencode-service.ts"
import { createOpencodeBackend, opencodeTranscriptPath, parseOpencodeSubAgentLine, projectOpencodeTranscript } from "./opencode-transcript.ts"
import { opencodeKeptRules, opencodeModeOf, opencodeSessionRules, opencodeWildcard, parseOpencodeEvent } from "./opencode-types.ts"
import { parseAcpLine, parseAcpRecord } from "./acp-transcript.ts"
// @ts-expect-error a plain .mjs fixture
import { startFakeOpencode } from "./opencode.fixtures/fake-opencode-server.mjs"

// The native backend against a fake OpenCode service over REAL HTTP and a REAL event stream, with a
// REAL InteractionStore. What the tailer folds and the drawer draws is read back from the file the bridge
// wrote. The fake's behaviour follows what OpenCode 2.2.5 did when measured (see the fixture's header).

type Fake = Awaited<ReturnType<typeof startFakeOpencode>>
interface Rig { fake: Fake; bridge: OpencodeBridge; store: InteractionStore; stateDir: string; env: NodeJS.ProcessEnv; delivered: string[]; hub: OpencodeHub }

const FRIZZ_CLI = { binDir: "/opt/frizz/bin", stateDir: "/opt/state", projectId: "proj-1" }

function writeRegistration(dir: string, reg: object): NodeJS.ProcessEnv {
  mkdirSync(join(dir, "state", "opencode"), { recursive: true })
  writeFileSync(join(dir, "state", "opencode", "service.json"), JSON.stringify(reg))
  return { PATH: process.env.PATH, HOME: dir, XDG_STATE_HOME: join(dir, "state") }
}

async function rig(fakeOpts: Record<string, unknown> = {}, opts: { contract?: string } = {}): Promise<Rig> {
  const fake = await startFakeOpencode(fakeOpts)
  const dir = mkdtempSync(join(tmpdir(), "opencode-bridge-"))
  const env = writeRegistration(dir, fake.registration)
  const store = createInteractionStore(new Database(":memory:"))
  const hub = new OpencodeHub(env)
  const delivered: string[] = []
  const bridge = createOpencodeBridge({
    projectId: "proj-1", stateDir: dir, frizzCli: FRIZZ_CLI, interactions: store, env, hub, flushMs: 20, settleMs: 300,
    contractFor: () => opts.contract ?? "THE WORKER CONTRACT",
    onDelivered: (_slug, id) => delivered.push(id),
  })
  return { fake, bridge, store, stateDir: dir, env, delivered, hub }
}
async function teardown(r: Rig) { await r.bridge.shutdown(); r.hub.stop(); await r.fake.close() }

const records = (r: Rig, sessionId = "s1") => {
  const path = opencodeTranscriptPath(r.stateDir, sessionId)
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").map((l) => parseAcpRecord(l)).filter((x): x is NonNullable<typeof x> => !!x) as Array<Record<string, any>> : []
}
async function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 20))
  }
}
const ends = (r: Rig, sid = "s1") => records(r, sid).filter((x) => x.kind === "turn-end").length
const spawn = (r: Rig, prompt: string, mode: "bypassPermissions" | "default" | "acceptEdits" | "settings" | "plan" = "bypassPermissions") =>
  r.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, mode, model: { providerID: "opencode", id: "big-pickle" }, prompt })
const ref = (r: Rig, opencodeSessionId: string, mode: "bypassPermissions" | "default" = "bypassPermissions") =>
  ({ threadSlug: "t1", sessionId: "s1", cwd: r.stateDir, opencodeSessionId, mode })

test("opencode-bridge: a dispatch creates a session with its rules and environment, puts the contract, and writes a foldable transcript", async () => {
  const r = await rig()
  try {
    const { opencodeSessionId } = await spawn(r, "[think:hmm][shell:echo hi][say:All done.\n\n```done\n- ran it\n```]")
    await until(() => ends(r) === 1)
    const create = r.fake.requests.find((q: any) => q.method === "POST" && q.path === "/api/session")
    assert.deepEqual(create.body.permissions, opencodeSessionRules("bypassPermissions"))
    assert.equal(create.body.agent, "build")
    assert.deepEqual(create.body.metadata, { frizz: { sessionId: "s1", slug: "t1", projectId: "proj-1" } })
    assert.deepEqual(create.body.model, { providerID: "opencode", id: "big-pickle" })
    const session = r.fake.sessions.get(opencodeSessionId)
    assert.equal(session.env.FRIZZ_THREAD_SLUG, "t1")
    assert.equal(session.env.FRIZZ_PROJECT_ID, "proj-1")
    assert.ok(session.env.PATH.startsWith("/opt/frizz/bin:"), "the worker command is first on the session's PATH")
    assert.ok(!Object.values(session.env).some((v) => String(v).includes(r.fake.password)), "the service password never reaches a worker")
    assert.equal(session.instructions.get(OPENCODE_CONTRACT_KEY), "THE WORKER CONTRACT")
    const prompt = r.fake.requests.find((q: any) => q.path.endsWith("/prompt"))
    assert.equal(prompt.body.text.startsWith("[think"), true, "the contract rides the instruction entry, not the prompt")

    const recs = records(r)
    assert.deepEqual(recs.map((x) => x.kind), ["opencode-session", "turn-start", "user-message", "reasoning", "tool-call", "tool-result", "context-usage", "assistant-text", "context-usage", "turn-end"])
    assert.deepEqual(recs[4]!.input, { command: "echo hi" })
    assert.equal(recs[4]!.name, "Bash")
    assert.equal(recs[8]!.tokens, 1510, "context is the step's own request, not the session's running total")
    assert.equal(recs[8]!.window, 200000)
    // The fold the tailer runs.
    const s = newTailState("t1", "s1", "/x")
    const backend = createOpencodeBackend({ stateDir: r.stateDir })
    for (const line of readFileSync(opencodeTranscriptPath(r.stateDir, "s1"), "utf8").split("\n")) backend.foldLine(s, line)
    assert.equal(s.turn, "idle")
    assert.equal(s.lastFence?.kind, "done")
    assert.equal(s.model, "opencode:opencode/big-pickle")
    assert.equal(recs[0]!.version, "2.2.5", "the header carries the service's version, from /api/info")
    // The drawer: the shell call is a Bash card with its command, not its working directory.
    const msgs = projectOpencodeTranscript(readFileSync(opencodeTranscriptPath(r.stateDir, "s1"), "utf8"), "opencode:s1", opencodeToolCards)
    const tool = msgs.flatMap((m) => m.tools)[0]!
    assert.equal(tool.name, "Bash")
    assert.equal(tool.command, "echo hi")
    assert.equal(tool.output, "ran echo hi")
    assert.equal(tool.status, "completed")
  } finally { await teardown(r) }
})

test("opencode-bridge: the first dispatch to a service still activating waits for its models instead of failing no-route", async () => {
  const r = await rig({ activatingMs: 900 })
  try {
    await spawn(r, "[say:ready]")
    await until(() => ends(r) === 1)
    assert.ok(!records(r).some((x) => x.kind === "provider-error"), JSON.stringify(records(r).filter((x) => x.kind === "provider-error")))
    assert.equal(records(r).find((x) => x.kind === "turn-end")!.finalText, "ready")
    assert.ok(r.fake.requests.filter((q: any) => q.path === "/api/model").length >= 1)
  } finally { await teardown(r) }
})

test("opencode-bridge: when the instruction route is refused, the contract rides the first prompt instead", async () => {
  const r = await rig({ noInstructions: true })
  try {
    await spawn(r, "[say:ok]")
    await until(() => ends(r) === 1)
    const prompt = r.fake.requests.find((q: any) => q.path.endsWith("/prompt"))
    assert.ok(prompt.body.text.startsWith("THE WORKER CONTRACT\n\n"))
    assert.equal(records(r).find((x) => x.kind === "user-message")!.text, "[say:ok]", "the transcript records the task, not the contract")
  } finally { await teardown(r) }
})

test("opencode-bridge: a steer is read mid-turn, inside the same turn; a queued message gets a turn of its own", async () => {
  const r = await rig()
  try {
    const { opencodeSessionId } = await spawn(r, "[shell:sleep][wait:300][shell:again][say:first answer]")
    await until(() => records(r).some((x) => x.kind === "tool-call"))
    const steer = await r.bridge.followUp({ ...ref(r, opencodeSessionId), text: "[say:steered]", deliveryId: "d-steer", delivery: "steer" })
    const queued = await r.bridge.followUp({ ...ref(r, opencodeSessionId), text: "[say:queued answer]", deliveryId: "d-queue", delivery: "queue" })
    assert.equal(queued.state, "queued")
    await until(() => ends(r) === 2)
    const kinds = records(r).map((x) => x.kind + (x.kind === "user-message" ? `:${x.text}` : ""))
    const steerAt = kinds.indexOf("user-message:[say:steered]")
    const firstEnd = kinds.indexOf("turn-end")
    assert.ok(steerAt > 0 && steerAt < firstEnd, `the steer lands inside the first turn: ${kinds.join(" ")}`)
    const queuedAt = kinds.indexOf("user-message:[say:queued answer]")
    assert.ok(queuedAt > firstEnd, "the queued message opens the second turn")
    assert.equal(kinds.filter((k) => k === "turn-start").length, 2, "one execution in OpenCode, two turns in Frizz")
    assert.equal(records(r).filter((x) => x.kind === "turn-end")[1]!.finalText, "queued answer")
    assert.deepEqual(r.delivered.sort(), ["d-queue", "d-steer"], "each delivery leaves the ledger when it reaches the transcript")
    assert.equal(steer.opencodeSessionId, opencodeSessionId)
    // Its inbox id is the delivery's, so a retried send is the same message.
    assert.ok(r.fake.requests.some((q: any) => q.body?.id === opencodeInboxId("s1", "d-queue")))
  } finally { await teardown(r) }
})

test("opencode-bridge: a steer can be taken back until its step boundary, and send now pushes one through at once", async () => {
  const r = await rig()
  try {
    const { opencodeSessionId } = await spawn(r, "[shell:a][wait:3000][shell:b][say:never reached]")
    await until(() => records(r).some((x) => x.kind === "tool-result"))
    await r.bridge.followUp({ ...ref(r, opencodeSessionId), text: "[say:never]", deliveryId: "d1", delivery: "steer" })
    assert.equal(await r.bridge.cancelQueued(ref(r, opencodeSessionId), "d1"), true)
    await r.bridge.followUp({ ...ref(r, opencodeSessionId), text: "[say:read now]", deliveryId: "d2", delivery: "steer" })
    const asked = Date.now()
    assert.equal(await r.bridge.pushSteers(ref(r, opencodeSessionId)), "pushed")
    await until(() => records(r).filter((x) => x.kind === "turn-end").some((x) => x.finalText === "read now"), 2500)
    assert.ok(Date.now() - asked < 2500, "read at once, not after the 3s step")
    const texts = records(r).filter((x) => x.kind === "user-message").map((x) => x.text)
    assert.ok(!texts.includes("[say:never]"))
    assert.equal(await r.bridge.cancelQueued(ref(r, opencodeSessionId), "d2"), false, "too late once delivered")
    assert.equal(await r.bridge.pushSteers(ref(r, opencodeSessionId)), "nothing")
  } finally { await teardown(r) }
})

test("opencode-bridge: an interrupting send leaves a foreground sub-agent running and waits for its boundary", async () => {
  const r = await rig({ childDelayMs: 600 })
  try {
    const { opencodeSessionId } = await spawn(r, "[sub:Slow child][say:parent done]")
    await until(() => records(r).some((x) => x.kind === "opencode-subagent" && x.state === "running"))
    await r.bridge.followUp({ ...ref(r, opencodeSessionId), text: "[say:after the child]", deliveryId: "d1", delivery: "steer", interrupt: true })
    assert.equal(await r.bridge.pushSteers(ref(r, opencodeSessionId)), "subagent")
    await until(() => !r.fake.sessions.get(opencodeSessionId).running && ends(r) >= 1)
    assert.ok(!r.fake.requests.some((q: any) => q.path === `/api/session/${opencodeSessionId}/interrupt`), "the parent was never interrupted")
    assert.equal(records(r).filter((x) => x.kind === "opencode-subagent").at(-1)!.state, "completed")
    assert.ok(records(r).some((x) => x.kind === "user-message" && x.text === "[say:after the child]"))
  } finally { await teardown(r) }
})

test("opencode-bridge: a permission ask is a card; allow runs the call, and deny fails only that call", async () => {
  const r = await rig()
  try {
    await spawn(r, "[shell:rm -rf build && ls | wc -l][shell:echo after][say:finished]", "default")
    const scope = { projectId: "proj-1", threadSlug: "t1", sessionId: "s1" }
    const card = await until(() => r.store.listPending(scope)[0])
    assert.equal(card.provider.kind, "opencode")
    assert.equal(card.payload.kind, "command-approval")
    // OpenCode asks with one resource per sub-command; the card shows the command the agent wrote.
    assert.equal((card.payload as any).command.preview, "rm -rf build && ls | wc -l")
    assert.equal((card.payload as any).command.summary, "rm -rf build && ls | wc -l")
    assert.deepEqual(card.allowedDecisions.map((d) => d.id), ["accept", "acceptForSession", "decline"])
    assert.ok(r.bridge.ownsInteraction(scope, card.id))
    r.store.resolve(scope, { slug: "t1", sessionId: "s1", interactionId: card.id, sessionEpoch: 0, capabilityRevision: 0, expectedRecordRevision: card.recordRevision, responseId: "r1", decisionId: "decline" })
    const card2 = await until(() => r.store.listPending(scope)[0])
    const reply1 = r.fake.requests.find((q: any) => q.path.includes("/permission/") && q.path.endsWith("/reply"))
    assert.equal(reply1.body.decision, "reject")
    assert.ok(reply1.body.message, "a denial carries words, so OpenCode fails the call and the turn goes on")
    r.store.resolve(scope, { slug: "t1", sessionId: "s1", interactionId: card2.id, sessionEpoch: 0, capabilityRevision: 0, expectedRecordRevision: card2.recordRevision, responseId: "r2", decisionId: "accept" })
    await until(() => ends(r) === 1)
    const recs = records(r)
    assert.equal(recs.filter((x) => x.kind === "tool-result")[0]!.failed, true)
    assert.equal(recs.filter((x) => x.kind === "tool-result")[1]!.text, "ran echo after")
    assert.equal(recs.find((x) => x.kind === "turn-end")!.finalText, "finished")
    assert.equal(r.store.listPending(scope).length, 0)
  } finally { await teardown(r) }
})

test("opencode-bridge: a denial with no words, which ends OpenCode's turn without an idle message, still closes Frizz's turn", async () => {
  const r = await rig()
  try {
    const { opencodeSessionId } = await spawn(r, "[shell:rm -rf build][say:unreachable]", "default")
    const scope = { projectId: "proj-1", threadSlug: "t1", sessionId: "s1" }
    const card = await until(() => r.store.listPending(scope)[0])
    // The card's own path always sends words; this is what another OpenCode client's plain reject does.
    await fetch(`${r.fake.url}/api/session/${opencodeSessionId}/permission/${card.providerRequestId}/reply`, { method: "POST", headers: { authorization: "Basic " + Buffer.from(`opencode:${r.fake.password}`).toString("base64"), "content-type": "application/json" }, body: JSON.stringify({ decision: "reject" }) })
    await until(() => ends(r) === 1, 5000)
    assert.equal(r.store.listPending(scope).length, 0, "the card went when the request did")
    assert.ok(!records(r).some((x) => x.kind === "provider-error"), "a declined step is not a provider failure")
  } finally { await teardown(r) }
})

test("opencode-bridge: a question is an agent-question card whose answer goes back as the form's", async () => {
  const r = await rig()
  try {
    await spawn(r, "[question][say:got it]")
    const scope = { projectId: "proj-1", threadSlug: "t1", sessionId: "s1" }
    const card = await until(() => r.store.listPending(scope)[0])
    assert.equal(card.payload.kind, "agent-question")
    const fields = (card.payload as any).fields
    assert.deepEqual(fields.map((f: any) => f.id), ["q0", "q0_notes"])
    assert.deepEqual(fields[0].options.map((o: any) => o.value), ["Red", "Blue"])
    r.store.resolve(scope, { slug: "t1", sessionId: "s1", interactionId: card.id, sessionEpoch: 0, capabilityRevision: 0, expectedRecordRevision: card.recordRevision, responseId: "r1", decisionId: "answer", values: { q0: "Blue" } })
    await until(() => ends(r) === 1)
    const reply = r.fake.requests.find((q: any) => q.path.includes("/form/"))
    assert.deepEqual(reply.body.answer, { q0: "Blue" })
    const ask = projectOpencodeTranscript(readFileSync(opencodeTranscriptPath(r.stateDir, "s1"), "utf8"), "opencode:s1", opencodeToolCards).flatMap((m) => m.tools).find((t) => t.ask)!
    assert.equal(ask.name, "AskUserQuestion")
    assert.deepEqual(ask.askAnswers, ["Blue"])
  } finally { await teardown(r) }
})

test("opencode-form-answer: a pick, free text, both, and a multi-select become the form's answer", () => {
  const fields = [{ key: "q0", multi: false }, { key: "q1", multi: true }, { key: "q2", multi: false }, { key: "q3", multi: false }]
  assert.deepEqual(opencodeFormAnswer(fields, { q0: "Red", q1: ["A", "B"], q1_notes: "and C", q2_notes: "neither", q3: "" }), { q0: "Red", q1: ["A", "B", "and C"], q2: "neither" })
})

test("opencode-bridge: a sub-agent is a row of its own with its own transcript, and its shell gets this thread's identity", async () => {
  const r = await rig()
  try {
    await spawn(r, "[sub:Say hello][say:parent done]")
    await until(() => ends(r) === 1)
    const rows = records(r).filter((x) => x.kind === "opencode-subagent")
    assert.deepEqual(rows.map((x) => x.state), ["running", "completed"])
    const row = parseOpencodeSubAgentLine(JSON.stringify(rows[1]))!
    assert.equal(row.label, "Say hello")
    assert.match(row.childSessionId, /^ses_/)
    const child = readFileSync(row.outputFile, "utf8").split("\n").map((l) => parseAcpRecord(l)).filter(Boolean) as Array<Record<string, any>>
    assert.equal(child.find((x) => x.kind === "tool-result")!.text, "ran echo $FRIZZ_THREAD_SLUG slug=t1", "the child's environment was put before its shell ran")
    const parentText = records(r).filter((x) => x.kind === "assistant-text").map((x) => x.text).join("")
    assert.ok(!parentText.includes("child done"), "the child's words never join the parent's message")
    const card = projectOpencodeTranscript(readFileSync(opencodeTranscriptPath(r.stateDir, "s1"), "utf8"), "opencode:s1", opencodeToolCards).flatMap((m) => m.tools).find((t) => t.name === "Agent")!
    assert.equal(card.agentId, row.id, "the dispatch card and the row share the tool call's id")
    assert.equal(card.output, "child done")
  } finally { await teardown(r) }
})

test("opencode-bridge: a stream dropped mid-turn is reconciled from the session's messages on reconnect, each item once", async () => {
  const r = await rig()
  try {
    const { opencodeSessionId } = await spawn(r, "[wait:150][shell:echo gap][say:after the gap]")
    await until(() => records(r).some((x) => x.kind === "user-message"))
    r.fake.pause(true)
    await until(() => !r.fake.sessions.get(opencodeSessionId).running, 5000)
    r.fake.pause(false)
    await until(() => ends(r) === 1, 15000)
    const recs = records(r)
    assert.equal(recs.filter((x) => x.kind === "tool-call").length, 1)
    assert.equal(recs.filter((x) => x.kind === "tool-result")[0]!.text, "ran echo gap")
    assert.equal(recs.filter((x) => x.kind === "assistant-text").map((x) => x.text).join(""), "after the gap")
    assert.equal(recs.find((x) => x.kind === "turn-end")!.finalText, "after the gap")
    assert.equal(recs.filter((x) => x.kind === "user-message").length, 1)
  } finally { await teardown(r) }
})

test("opencode-bridge: after a service restart the session's environment is put again before its next message", async () => {
  const r = await rig()
  try {
    const { opencodeSessionId } = await spawn(r, "[say:one]")
    await until(() => ends(r) === 1)
    r.fake.restart()
    await new Promise((res) => setTimeout(res, 50))
    assert.equal(r.fake.sessions.get(opencodeSessionId).env, undefined)
    await r.bridge.followUp({ ...ref(r, opencodeSessionId), text: "[shell:echo $FRIZZ_THREAD_SLUG]", delivery: "steer" })
    await until(() => ends(r) === 2, 15000)
    assert.equal(records(r).filter((x) => x.kind === "tool-result")[0]!.text, "ran echo $FRIZZ_THREAD_SLUG slug=t1")
  } finally { await teardown(r) }
})

test("opencode-bridge: a provider sign-in failure is a provider error that says how to sign in, once", async () => {
  const r = await rig()
  try {
    await spawn(r, "[fail]")
    await until(() => ends(r) === 1)
    const errors = records(r).filter((x) => x.kind === "provider-error")
    assert.equal(errors.length, 1)
    assert.match(errors[0]!.error.message, /opencode auth login/)
    assert.equal(records(r).find((x) => x.kind === "turn-end")!.successful, false)
  } finally { await teardown(r) }
})

// OpenCode keeps a session's environment in the service's memory and resumes a claimed turn at boot,
// whoever is connected. What a turn resumed while Frizz was away ran in the meantime is put in the
// transcript, once; a command that ran after Frizz put the environment back is not.
test("opencode-bridge: shell commands a restarted service ran before the environment came back are noted, once", async () => {
  // rested: the resumed turn finished before Frizz came back. running: it is still going. control: the
  // command ran after Frizz put the environment back.
  for (const variant of ["rested", "running", "control"] as const) {
    const r = await rig()
    try {
      const { opencodeSessionId } = await spawn(r, "[shell:echo started][wait:60000][say:never]")
      await until(() => records(r).some((x) => x.kind === "tool-result"))
      // The service goes down mid-turn (a shutdown keeps the claim and writes no idle message), and Frizz
      // cannot reach it while it is away.
      r.fake.pause(true)
      const s = r.fake.sessions.get(opencodeSessionId)
      s.shutdown = true
      s.abort.abort()
      await until(() => !s.running, 5000)
      s.env = undefined
      // It comes back and resumes the turn before Frizz reconnects.
      const at = Date.now()
      const ran = variant === "control" ? at + 60_000 : at
      s.messages.push(
        { id: "msg_restart", seq: 9001, type: "synthetic", metadata: { notice: "restart" }, text: "The server restarted while you were working.", time: { created: at } },
        { id: "msg_resumed", seq: 9002, type: "assistant", agent: "build", content: [{ type: "tool", id: "call_r", name: "shell", state: { status: "completed", input: { command: "frizzctl activity" }, content: [{ type: "text", text: "zsh: command not found: frizzctl" }] }, time: { created: at, ran, completed: at } }], finish: "tool-calls", time: { created: at } },
      )
      if (variant === "running") s.running = true
      else s.messages.push({ id: "msg_idle", seq: 9003, type: "idle", outcome: "succeeded", time: { created: at } })
      r.fake.pause(false)
      await until(() => records(r).some((x) => x.kind === "tool-call" && x.input?.command === "frizzctl activity"), 15000)
      await new Promise((res) => setTimeout(res, 300))
      const notes = () => records(r).filter((x) => x.kind === "opencode-note" && /without it/.test(x.text))
      const steers = () => r.fake.requests.filter((q: any) => q.method === "POST" && /envrestored/.test(JSON.stringify(q.body ?? "")))
      if (variant === "control") {
        assert.equal(notes().length, 0, "a command that ran after the environment came back did not lack it")
        assert.equal(steers().length, 0)
        continue
      }
      assert.equal(notes().length, 1)
      assert.match(notes()[0]!.text, /one shell command ran without it/)
      assert.match(notes()[0]!.text, /`frizzctl activity`/)
      if (variant === "running") {
        // The worker hears it at its next step, as a steer, so it re-runs the command.
        assert.equal(steers().length, 1)
        assert.match(JSON.stringify(steers()[0].body), /re-run any of them that needed it|Re-run any of them that needed it/)
        assert.match(notes()[0]!.text, /Frizz has told the worker/)
      } else {
        // A rested turn: the person is told; the worker is not woken for it.
        assert.equal(steers().length, 0)
      }
      // Reconnecting again says nothing new, and a stream rebuilt from the file remembers it said it.
      r.fake.dropStreams()
      await new Promise((res) => setTimeout(res, 1500))
      assert.equal(notes().length, 1)
      assert.equal(steers().length, variant === "running" ? 1 : 0)
      const again = new OpencodeSessionStream(opencodeSessionId, opencodeTranscriptPath(r.stateDir, "s1"), () => new Date().toISOString(), 10_000)
      assert.ok(again.envLossNoted.has("msg_restart"))
    } finally { await teardown(r) }
  }
})

test("opencode-bridge: stop interrupts the turn and the thread takes its next message", async () => {
  const r = await rig()
  try {
    const { opencodeSessionId } = await spawn(r, "[shell:sleep][wait:5000][say:never]")
    await until(() => records(r).some((x) => x.kind === "tool-result"))
    assert.deepEqual(await r.bridge.interruptTurn("t1", "s1"), { interrupted: true })
    await until(() => ends(r) === 1, 3000)
    const stopped = records(r).find((x) => x.kind === "turn-end")!
    assert.equal(stopped.successful, false)
    // The person's Stop is written as theirs, so no sign-off reminder or bare-rest card answers it.
    assert.equal(stopped.stoppedBy, "operator")
    const fold = newTailState("t1", "s1", "/fixture")
    for (const rec of records(r)) for (const ev of parseAcpLine(JSON.stringify(rec))) applyEvent(fold, ev)
    assert.equal(fold.operatorStopped, true)
    await r.bridge.followUp({ ...ref(r, opencodeSessionId), text: "[say:again]", delivery: "steer" })
    await until(() => ends(r) === 2)
    // The next turn is the worker's own again.
    assert.equal(records(r).filter((x) => x.kind === "turn-end")[1]!.stoppedBy, undefined)
    const after = newTailState("t1", "s1", "/fixture")
    for (const rec of records(r)) for (const ev of parseAcpLine(JSON.stringify(rec))) applyEvent(after, ev)
    assert.equal(after.operatorStopped, undefined)
  } finally { await teardown(r) }
})

test("opencode-bridge: the permission control replaces the session's rules, its children's, and its agent", async () => {
  const r = await rig()
  try {
    const { opencodeSessionId } = await spawn(r, "[say:ok]")
    await until(() => ends(r) === 1)
    await r.bridge.setPermission(ref(r, opencodeSessionId), "plan")
    assert.equal(r.fake.sessions.get(opencodeSessionId).agent, "plan")
    assert.deepEqual(r.fake.sessions.get(opencodeSessionId).permissions, [])
    await r.bridge.setPermission(ref(r, opencodeSessionId), "default")
    assert.equal(r.fake.sessions.get(opencodeSessionId).agent, "build")
    assert.deepEqual(r.fake.sessions.get(opencodeSessionId).permissions, opencodeSessionRules("default"))
    await r.bridge.setModel(ref(r, opencodeSessionId), { providerID: "opencode", id: "flash", variant: "high" })
    assert.deepEqual(r.fake.sessions.get(opencodeSessionId).model, { providerID: "opencode", id: "flash", variant: "high" })
    await r.bridge.rename(ref(r, opencodeSessionId), "A better title")
    assert.equal(r.fake.sessions.get(opencodeSessionId).title, "A better title")
    const models = await r.bridge.models(r.stateDir).catch((e) => ({ error: String(e) }))
    void models
  } finally { await teardown(r) }
})

test("opencode-session-rules: each mode's rules read as OpenCode evaluates them, last match wins", () => {
  const evaluate = (rules: { action: string; resource: string; effect: string }[], action: string, resource: string) =>
    [...rules].reverse().find((x) => new RegExp("^" + x.action.replace(/\*/g, ".*") + "$").test(action) && new RegExp("^" + x.resource.replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$").test(resource))?.effect ?? "ask"
  const ask = opencodeSessionRules("default")
  assert.equal(evaluate(ask, "shell", "rm -rf /"), "ask")
  assert.equal(evaluate(ask, "shell", "frizzctl done"), "allow")
  assert.equal(evaluate(ask, "read", "src/a.ts"), "allow")
  assert.equal(evaluate(ask, "read", ".env"), "ask")
  assert.equal(evaluate(ask, "edit", "src/a.ts"), "ask")
  assert.equal(evaluate(ask, "webfetch", "https://x"), "ask")
  assert.equal(evaluate(ask, "browser", "*"), "deny")
  const edits = opencodeSessionRules("acceptEdits")
  assert.equal(evaluate(edits, "edit", "src/a.ts"), "allow")
  assert.equal(evaluate(edits, "shell", "make"), "ask")
  const bypass = opencodeSessionRules("bypassPermissions")
  assert.equal(evaluate(bypass, "shell", "make"), "allow")
  assert.equal(evaluate(bypass, "browser", "*"), "deny")
})

test("opencode recorded stream: OpenCode 2.2.5's own events fold to the expected transcript", () => {
  const here = fileURLToPath(new URL("./opencode.fixtures/recorded-2.2.5.jsonl", import.meta.url))
  const events = readFileSync(here, "utf8").split("\n").filter(Boolean).map((l) => parseOpencodeEvent(JSON.parse(l))!)
  const dir = mkdtempSync(join(tmpdir(), "opencode-recorded-"))
  const fold = (suffix: string) => {
    const path = join(dir, `${suffix}.jsonl`)
    const stream = new OpencodeSessionStream(suffix, path, () => "2026-11-06T00:00:00.000Z", 10_000)
    for (const ev of events) if ((ev.data.sessionID as string | undefined)?.endsWith(suffix) || ((ev.data.form as any)?.sessionID as string | undefined)?.endsWith(suffix)) stream.ingest(ev, () => 200_000)
    return { path, recs: readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) }
  }
  // A shell call, a steer delivered at its boundary, a second call, and the answer.
  const steered = fold("s7G4lURd")
  assert.deepEqual(steered.recs.map((x: any) => x.kind), ["turn-start", "user-message", "tool-call", "tool-result", "context-usage", "user-message", "tool-call", "tool-result", "context-usage", "assistant-text", "context-usage", "turn-end"])
  assert.match(steered.recs[1].text, /sleep 12; echo LONGDONE/)
  assert.match(steered.recs[5].text, /WOMBAT/)
  assert.equal(steered.recs[2].name, "Bash")
  assert.match(steered.recs.at(-1).finalText, /WOMBAT/)
  const s = newTailState("t", "s", "/x")
  const backend = createOpencodeBackend({ stateDir: dir })
  for (const line of readFileSync(steered.path, "utf8").split("\n")) backend.foldLine(s, line)
  assert.equal(s.turn, "idle")
  // A question answered through the form.
  const asked = fold("Q23Q1hLy")
  const ask = projectOpencodeTranscript(readFileSync(asked.path, "utf8"), "opencode:q", opencodeToolCards).flatMap((m) => m.tools).find((t) => t.ask)!
  assert.equal(ask.ask![0]!.question, "Which option do you want to pick?")
  assert.deepEqual(ask.askAnswers, ["Alpha"])
  // A compaction.
  assert.ok(fold("wtlJr4pJ").recs.some((x: any) => x.kind === "compaction"))
  // The sub-agent call: its result is the child's answer, not the wrapper.
  const parent = fold("12qI3zEC")
  const agent = projectOpencodeTranscript(readFileSync(parent.path, "utf8"), "opencode:p", opencodeToolCards).flatMap((m) => m.tools).find((t) => t.name === "Agent")!
  assert.equal(agent.output, "CHILDOK")
})

test("opencode-service: a healthy registration is used as it is; a missing one is started and waited for; a dead start fails within the wait", async () => {
  const fake = await startFakeOpencode()
  try {
    const dir = mkdtempSync(join(tmpdir(), "opencode-service-"))
    const log = join(dir, "bin.log")
    const src = join(dir, "registration.json")
    writeFileSync(src, JSON.stringify(fake.registration))
    const bin = join(dir, "opencode")
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = "--version" ]; then echo "opencode v2.2.5"; exit 0; fi\nif [ "$1 $2" = "service start" ] && [ -n "$FAKE_REG_SRC" ]; then mkdir -p "$XDG_STATE_HOME/opencode"; cp "$FAKE_REG_SRC" "$XDG_STATE_HOME/opencode/service.json"; fi\n`)
    chmodSync(bin, 0o755)
    // Healthy and registered: nothing is run.
    const registered = writeRegistration(join(dir, "a"), fake.registration)
    const a = await ensureOpencodeService({ ...registered, FRIZZ_OPENCODE_BIN: bin })
    assert.equal(a.registration.url, fake.url)
    assert.equal(existsSync(log), false, "a healthy service is never started again: `service start` would replace one of another version")
    // Nothing registered: `service start`, then the registration it wrote.
    const empty = { PATH: process.env.PATH, HOME: join(dir, "b"), XDG_STATE_HOME: join(dir, "b", "state"), FRIZZ_OPENCODE_BIN: bin, FAKE_REG_SRC: src }
    const b = await ensureOpencodeService(empty, { waitMs: 5_000 })
    assert.equal(b.version, "2.2.5")
    assert.match(readFileSync(log, "utf8"), /service start/)
    // The negative control: a start that registers nothing fails, and says so.
    const none = { PATH: process.env.PATH, HOME: join(dir, "c"), XDG_STATE_HOME: join(dir, "c", "state"), FRIZZ_OPENCODE_BIN: bin }
    await assert.rejects(ensureOpencodeService(none, { waitMs: 800 }), /no healthy OpenCode service registered itself/)
    // A start that fails says OpenCode's own reason, and is not waited out.
    const failing = join(dir, "opencode-failing")
    writeFileSync(failing, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode v2.2.5"; exit 0; fi\necho "Error: Server process exited with code 1" >&2\necho "Error: Managed service port 49374 on 127.0.0.1 is already in use by PID 4242 (opencode serve --service)." >&2\necho "    at reap (/$bunfs/root/chunk.js:2:1159)" >&2\nexit 1\n`)
    chmodSync(failing, 0o755)
    const busy = { PATH: process.env.PATH, HOME: join(dir, "e"), XDG_STATE_HOME: join(dir, "e", "state"), FRIZZ_OPENCODE_BIN: failing }
    const failedAt = Date.now()
    await assert.rejects(ensureOpencodeService(busy, { waitMs: 10_000 }), /failed: Managed service port 49374 on 127\.0\.0\.1 is already in use by PID 4242/)
    assert.ok(Date.now() - failedAt < 5_000, "a start that said why it failed is not waited out")
    // A wrong password is not a healthy service either.
    const wrong = writeRegistration(join(dir, "d"), { ...fake.registration, password: "nope" })
    await assert.rejects(ensureOpencodeService({ ...wrong, FRIZZ_OPENCODE_BIN: join(dir, "missing") }, { waitMs: 300 }), /not installed/)
  } finally { await fake.close() }
})

test("opencode-service: a service older than the minimum is refused, not driven", async () => {
  const fake = await startFakeOpencode({ version: "2.0.3" })
  try {
    const env = writeRegistration(mkdtempSync(join(tmpdir(), "opencode-old-")), fake.registration)
    await assert.rejects(ensureOpencodeService(env), /needs 2\.0\.27 or newer/)
    assert.equal(opencodeVersionAtLeast("2.0.27", "2.0.27"), true)
    assert.equal(opencodeVersionAtLeast("2.0.26", "2.0.27"), false)
    assert.equal(opencodeVersionAtLeast("2.2.5", "2.0.27"), true)
    assert.equal(opencodeVersionAtLeast("1.14.0", "2.0.27"), false)
  } finally { await fake.close() }
})

const DENY_ME = { action: "shell", resource: "echo DENYME*", effect: "deny" as const }

test("opencode-bridge: no mode lifts a deny in the person's configuration, and a mode that asks does not turn it into a card", async () => {
  for (const mode of ["bypassPermissions", "default", "acceptEdits"] as const) {
    const r = await rig({ configRules: [DENY_ME] })
    try {
      await spawn(r, "[shell:echo DENYME please][shell:echo fine][say:over]", mode)
      const scope = { projectId: "proj-1", threadSlug: "t1", sessionId: "s1" }
      // `echo fine` asks in the asking modes; answer it so the turn ends.
      for (let i = 0; i < 40 && ends(r) === 0; i++) {
        const card = r.store.listPending(scope)[0]
        if (card) {
          assert.doesNotMatch((card.payload as any).command.preview, /DENYME/, `${mode}: a configured deny is never a card`)
          r.store.resolve(scope, { slug: "t1", sessionId: "s1", interactionId: card.id, sessionEpoch: 0, capabilityRevision: 0, expectedRecordRevision: card.recordRevision, responseId: `r${i}`, decisionId: "accept" })
        }
        await new Promise((res) => setTimeout(res, 50))
      }
      await until(() => ends(r) === 1)
      const results = records(r).filter((x) => x.kind === "tool-result")
      assert.equal(results[0]!.failed, true, `${mode}: the configured deny held`)
      assert.equal(results[1]!.text, "ran echo fine", `${mode}: everything else still runs`)
      const create = r.fake.requests.find((q: any) => q.method === "POST" && q.path === "/api/session")
      assert.deepEqual(create.body.permissions.at(-1), DENY_ME, `${mode}: the person's deny comes after Frizz's rules`)
    } finally { await teardown(r) }
  }
})

test("opencode-bridge: an exception the person carved out of their own deny still holds in Bypass", async () => {
  const r = await rig({ configRules: [{ action: "shell", resource: "git *", effect: "deny" }, { action: "shell", resource: "git status", effect: "allow" }] })
  try {
    await spawn(r, "[shell:git status][shell:git push][say:over]")
    await until(() => ends(r) === 1)
    const results = records(r).filter((x) => x.kind === "tool-result")
    assert.equal(results[0]!.text, "ran git status")
    assert.equal(results[1]!.failed, true)
  } finally { await teardown(r) }
})

test("opencode-bridge: OpenCode settings, Frizz's auto, adds no session rules and runs the person's default agent", async () => {
  const r = await rig({ configRules: [DENY_ME] })
  try {
    assert.equal(opencodeModeOf("auto"), "settings")
    assert.equal(opencodeModeOf(undefined), "settings")
    assert.equal(opencodeModeOf("bypassPermissions"), "bypassPermissions")
    await spawn(r, "[shell:echo DENYME][say:over]", "settings")
    await until(() => ends(r) === 1)
    const create = r.fake.requests.find((q: any) => q.method === "POST" && q.path === "/api/session")
    assert.deepEqual(create.body.permissions, [])
    assert.equal(create.body.agent, "build")
    assert.equal(records(r).find((x) => x.kind === "tool-result")!.failed, true)
  } finally { await teardown(r) }
})

test("opencode-bridge: when OpenCode's agents cannot be read, a mode that adds rules adds none, and says so", async () => {
  const r = await rig({ configRules: [DENY_ME], noAgentRoute: true })
  try {
    await spawn(r, "[shell:echo DENYME][say:over]")
    await until(() => ends(r) === 1)
    const create = r.fake.requests.find((q: any) => q.method === "POST" && q.path === "/api/session")
    assert.deepEqual(create.body.permissions, [], "never a bare allow-all without the person's denies after it")
    assert.equal(records(r).find((x) => x.kind === "tool-result")!.failed, true)
    assert.ok(records(r).some((x) => x.kind === "opencode-note" && /could not read OpenCode's agents/.test(x.text)))
  } finally { await teardown(r) }
})

test("opencode-bridge: a sub-agent gets its own agent's kept rules, the person's deny included", async () => {
  const r = await rig({ configRules: [DENY_ME], childScript: "[shell:echo DENYME from child][say:child done]" })
  try {
    await spawn(r, "[sub:Child][say:parent done]")
    await until(() => ends(r) === 1)
    const child = [...r.fake.sessions.values()].find((x: any) => x.parentID)
    assert.ok(child, "a child session")
    const tail = child.permissions.slice(-3)
    assert.deepEqual(tail, [{ action: "question", resource: "*", effect: "deny" }, { action: "subagent", resource: "*", effect: "deny" }, DENY_ME], "the general agent's denies and the person's, after Frizz's")
    const row = parseOpencodeSubAgentLine(JSON.stringify(records(r).filter((x) => x.kind === "opencode-subagent").at(-1)))!
    const childRecs = readFileSync(row.outputFile, "utf8").split("\n").map((l) => parseAcpRecord(l)).filter(Boolean) as Array<Record<string, any>>
    assert.equal(childRecs.find((x) => x.kind === "tool-result")!.failed, true, "the child's shell was denied too")
  } finally { await teardown(r) }
})

test("opencode-kept-rules: denies stay, the exceptions inside them stay, a deny lifted further down goes", () => {
  const rules = [
    { action: "*", resource: "*", effect: "allow" as const },
    { action: "shell", resource: "git *", effect: "deny" as const },
    { action: "shell", resource: "git status", effect: "allow" as const },
    { action: "edit", resource: "*.lock", effect: "deny" as const },
    { action: "edit", resource: "*", effect: "allow" as const },
    { action: "webfetch", resource: "*", effect: "ask" as const },
  ]
  assert.deepEqual(opencodeKeptRules(rules), [rules[1], rules[2]])
  assert.equal(opencodeWildcard("git push", "git push *"), true, "a trailing ' *' also matches the bare command")
  assert.equal(opencodeWildcard("git pushy", "git push *"), false)
})

test("opencode-bridge: a card for a call the bridge never saw reads the whole command from the call's message, and labels the split when it cannot", async () => {
  for (const [opts, expect] of [[{ unseenCalls: true }, "whole"], [{ unseenCalls: true, noMessageRoute: true }, "split"]] as const) {
    const r = await rig(opts)
    try {
      await spawn(r, "[shell:git status --short | head -5][say:over]", "default")
      const scope = { projectId: "proj-1", threadSlug: "t1", sessionId: "s1" }
      const card = await until(() => r.store.listPending(scope)[0])
      const command = (card.payload as any).command
      if (expect === "whole") {
        assert.equal(command.preview, "git status --short | head -5")
        assert.equal(command.summary, "git status --short | head -5")
      } else {
        assert.match(command.preview, /^OpenCode split this command into 2 parts; the whole command could not be read:\ngit status --short\nhead -5$/)
        assert.equal(command.summary, "2 commands: git status --short ; head -5")
      }
    } finally { await teardown(r) }
  }
})
