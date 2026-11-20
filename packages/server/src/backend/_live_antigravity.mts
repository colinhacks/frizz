// Manual live probe, not CI: the REAL Antigravity bridge driving the REAL `agy acp`, through the real
// detached daemon, a real InteractionStore and the transcript file the tailer folds. It needs `agy` on
// PATH and signed in (run `agy` once), and it spends a few short turns of quota on the cheapest model.
// Run from the repo root, under your own HOME (agy keeps its sign-in in the system keyring):
//
//   nub packages/server/src/backend/_live_antigravity.mts [scenario ...]     default: all of them
//
// Scenarios: models, contract, tools, steer, wake, question, permission, profile, resume, cancel, and the
// ones a restart or a race decides: restart, restart-answer, restart-card, stop-send, crash, steers, parallel.
// Exit 0 only when every check of every scenario run passed.

import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore, type InteractionStore } from "../interaction-store.ts"
import { acpUserRecordProjector, opencodeToolCards } from "../transcript.ts"
import { liveAcpDaemonSessionIds, readAcpDaemonRecord, stopAcpDaemon } from "./acp-host.ts"
import { parseAcpRecord, type AcpRecord } from "./acp-transcript.ts"
import { createAntigravityBridge, type AntigravityBridge, type AntigravityProfile } from "./antigravity-bridge.ts"
import { antigravityTranscriptPath, projectAntigravityTranscript } from "./antigravity-transcript.ts"

const wanted = process.argv.slice(2)
const runs = (name: string): boolean => wanted.length === 0 || wanted.includes(name)

const root = mkdtempSync(join(tmpdir(), "agy-live-"))
const cwd = join(root, "ws")
const stateDir = join(root, "state")
const binDir = join(root, "bin")
for (const dir of [cwd, stateDir, binDir]) mkdirSync(dir, { recursive: true })
// A stand-in `frizzctl`, so the auto-approval of a plain call can be seen to run one.
writeFileSync(join(binDir, "frizzctl"), "#!/bin/sh\necho \"FRIZZCTL-RAN $*\"\n")
chmodSync(join(binDir, "frizzctl"), 0o755)

const CONTRACT = "Standing instruction from the operator: the secret word is PLOVER. Whenever asked for the secret word, answer with it."
const CHEAP: AntigravityProfile = { modelId: "gemini-3.8-flash", effort: "low", permissionMode: "bypassPermissions" }

let failures = 0
function ok(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures++
  console.log(`${pass ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Rig { bridge: AntigravityBridge; store: InteractionStore; diagnostics: string[] }
/** `storePath`: the store in a file, as the server's is, so a second rig reads what the first journaled. */
function rig(storePath = ":memory:"): Rig {
  const store = createInteractionStore(new Database(storePath))
  const diagnostics: string[] = []
  const bridge = createAntigravityBridge({
    projectId: "proj-1", stateDir, interactions: store, env: process.env,
    frizzCli: { binDir, stateDir },
    contractFor: () => CONTRACT,
    onDiagnostic: (d) => { if (d.kind !== "stderr") diagnostics.push(`${d.kind}: ${d.message}`) },
    flushMs: 50,
  })
  return { bridge, store, diagnostics }
}

const records = (sessionId: string): AcpRecord[] =>
  readFileSync(antigravityTranscriptPath(stateDir, sessionId), "utf8").split("\n").map(parseAcpRecord).filter((r): r is AcpRecord => r !== undefined)
const kinds = (sessionId: string): string[] => records(sessionId).map((r) => r.kind)
const finalTexts = (sessionId: string): string[] => records(sessionId).flatMap((r) => (r.kind === "turn-end" ? [r.finalText ?? ""] : []))
const count = (sessionId: string, kind: string): number => kinds(sessionId).filter((k) => k === kind).length

async function untilIdle(r: Rig, slug: string, sessionId: string, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (r.bridge.turnLiveness(slug, sessionId)?.turnActive === false) return true
    await sleep(150)
  }
  console.log(`      still busy: ${JSON.stringify(r.bridge.turnLiveness(slug, sessionId))}; last records: ${kinds(sessionId).slice(-8).join(" ")}`)
  return false
}
async function until(check: () => boolean, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (check()) return true; await sleep(150) }
  return false
}
const pending = (r: Rig, slug: string, sessionId: string) => r.store.listPending({ projectId: "proj-1", threadSlug: slug, sessionId })
function answer(r: Rig, slug: string, sessionId: string, decisionId: string, values?: Record<string, unknown>): void {
  const card = pending(r, slug, sessionId)[0]!
  r.store.resolve({ projectId: "proj-1", threadSlug: slug, sessionId }, { slug, sessionId, interactionId: card.id, sessionEpoch: card.owner.sessionEpoch, capabilityRevision: card.owner.capabilityRevision, expectedRecordRevision: card.recordRevision, responseId: `resp-${Date.now()}`, decisionId, ...(values ? { values } : {}) } as never)
}
function dump(sessionId: string): void {
  const raw = readFileSync(antigravityTranscriptPath(stateDir, sessionId), "utf8")
  for (const m of projectAntigravityTranscript(raw, "live", opencodeToolCards, acpUserRecordProjector)) {
    const tools = m.tools.map((t) => `${t.name}[${t.status}]${t.command ? ` ${t.command.slice(0, 50)}` : t.detail ? ` ${t.detail.slice(0, 50)}` : ""}`).join("; ")
    console.log(`      ${m.role}${m.wake ? "(wake)" : ""}${m.kind ? `/${m.kind}` : ""}: ${JSON.stringify(m.text.slice(0, 110))}${tools ? `  tools: ${tools}` : ""}`)
  }
}

const r = rig()
let n = 0
const thread = (): { threadSlug: string; sessionId: string } => { n++; return { threadSlug: `t${n}`, sessionId: `s${n}-${Date.now()}` } }

try {
  if (runs("models")) {
    console.log("models")
    const models = await r.bridge.models(cwd)
    ok("agy is installed and signed in", models.available && !models.error, models.error ?? `${models.models.length} models, tier ${models.tier ?? "?"}, agy ${models.version ?? "?"}`)
    for (const m of models.models) console.log(`      ${m.id}  levels=[${m.efforts.join(",")}] default=${m.defaultEffort ?? "-"}`)
    ok("at least one model lists thinking levels", models.models.some((m) => m.efforts.length > 0))
  }

  if (runs("contract") || runs("tools")) {
    console.log("contract + tools (bypass)")
    const t = thread()
    const info = await r.bridge.spawnDispatch({ ...t, cwd, ...CHEAP, prompt: "Create a file named probe.txt containing the single word hello, then run the shell command `echo slug=$FRIZZ_THREAD_SLUG; frizzctl ping`. Then reply with one line: the secret word, then exactly what the command printed.", userText: "the task" })
    ok("dispatch returned the session's profile", info.model === "gemini-3.8-flash" && info.effort === "low", JSON.stringify(info))
    ok("turn ended", await untilIdle(r, t.threadSlug, t.sessionId))
    const final = finalTexts(t.sessionId).at(-1) ?? ""
    ok("the contract reached the model as its system prompt", /PLOVER/.test(final), JSON.stringify(final.slice(0, 160)))
    ok("the thread's environment reached the agent's shell", final.includes(`slug=${t.threadSlug}`))
    ok("frizzctl resolved on the agent's PATH", /FRIZZCTL-RAN ping/.test(final))
    const calls = records(t.sessionId).flatMap((rec) => (rec.kind === "tool-call" ? [rec.name] : []))
    ok("tool calls are written in Frizz's vocabulary", calls.includes("Write") && calls.includes("Bash"), calls.join(","))
    ok("no card was raised in bypass", pending(r, t.threadSlug, t.sessionId).length === 0)
    ok("one turn, bracketed", count(t.sessionId, "turn-start") === 1 && count(t.sessionId, "turn-end") === 1, kinds(t.sessionId).join(" "))
    dump(t.sessionId)

    if (runs("steer")) {
      console.log("steer")
      const before = count(t.sessionId, "turn-end")
      const first = await r.bridge.followUp({ ...t, cwd, ...CHEAP, text: "Run the shell command `sleep 10 && echo slept`, then reply with the single word FIRST." })
      await sleep(4_000)
      const second = await r.bridge.followUp({ ...t, cwd, ...CHEAP, text: "Change of plan: when you reply, add the word STEERED after it." })
      ok("the first message started a turn and the second joined it", first.state === "delivered" && second.state === "steered", `${first.state}, ${second.state}`)
      ok("turn ended", await untilIdle(r, t.threadSlug, t.sessionId))
      ok("both messages made ONE turn", count(t.sessionId, "turn-end") === before + 1, `${count(t.sessionId, "turn-end") - before} endings`)
      ok("the steer was read", /STEERED/.test(finalTexts(t.sessionId).at(-1) ?? ""), JSON.stringify(finalTexts(t.sessionId).at(-1)))
    }

    if (runs("wake")) {
      console.log("wake (a turn the agent starts)")
      const before = count(t.sessionId, "turn-end")
      await r.bridge.followUp({ ...t, cwd, ...CHEAP, text: "Start the shell command `sleep 8 && echo BGDONE` as a BACKGROUND task and do not wait for it: end your turn right away with the single word STARTED. When the task finishes and you are told, reply with the single word FINISHED." })
      ok("the prompt's turn ended while the task ran", await until(() => count(t.sessionId, "turn-end") === before + 1, 60_000), JSON.stringify(finalTexts(t.sessionId).at(-1)))
      ok("the agent's own turn opened and closed", await until(() => count(t.sessionId, "turn-end") === before + 2, 60_000), kinds(t.sessionId).slice(-8).join(" "))
      const wake = records(t.sessionId).filter((rec) => rec.kind === "user-message").at(-1)
      ok("it opens with a synthetic message", wake?.kind === "user-message" && wake.synthetic === true)
      ok("its final text is the agent's report", /FINISHED/.test(finalTexts(t.sessionId).at(-1) ?? ""), JSON.stringify(finalTexts(t.sessionId).at(-1)))
      ok("the thread is at rest again", r.bridge.turnLiveness(t.threadSlug, t.sessionId)?.turnActive === false)
      dump(t.sessionId)
    }

    if (runs("resume")) {
      console.log("resume (the agent is gone; a new one takes the session)")
      await r.bridge.endSession(t.threadSlug, t.sessionId)
      ok("the daemon is gone", !r.bridge.isAgentAlive(t.threadSlug, t.sessionId))
      const back = await r.bridge.followUp({ ...t, cwd, ...CHEAP, agySessionId: info.agySessionId, text: "What is the secret word, and what did the very first shell command of this conversation print? One line." })
      ok("the session was resumed, not replaced", back.resumed === "resumed" && back.agySessionId === info.agySessionId, `${back.resumed} ${back.agySessionId}`)
      ok("the level was put back on it", back.effort === "low", String(back.effort))
      ok("turn ended", await untilIdle(r, t.threadSlug, t.sessionId))
      const final2 = finalTexts(t.sessionId).at(-1) ?? ""
      ok("history and contract survived", /PLOVER/.test(final2) && final2.includes(`slug=${t.threadSlug}`), JSON.stringify(final2.slice(0, 160)))
    }
    await r.bridge.endSession(t.threadSlug, t.sessionId)
  }

  if (runs("question")) {
    console.log("question")
    const t = thread()
    await r.bridge.spawnDispatch({ ...t, cwd, ...CHEAP, prompt: "Use your question tool ONCE to ask me two questions together: (1) single choice, which colour, options Red, Green, Blue; (2) multi-select, which toppings, options Ham, Olive, Corn. Then tell me exactly what I answered for each.", userText: "ask me" })
    ok("a question card was raised", await until(() => pending(r, t.threadSlug, t.sessionId).length === 1))
    const card = pending(r, t.threadSlug, t.sessionId)[0]
    const fields = (card?.payload as { fields?: Array<{ id: string; input: string; options?: Array<{ value: string; label: string }> }> } | undefined)?.fields ?? []
    console.log(`      card: ${card?.payload.kind} ${JSON.stringify(fields.map((f) => `${f.id}:${f.input}`))}`)
    ok("it is an agent question with both questions", card?.payload.kind === "agent-question" && fields.some((f) => f.input === "select") && fields.some((f) => f.input === "multi-select"))
    const single = fields.find((f) => f.input === "select")!
    const multi = fields.find((f) => f.input === "multi-select")!
    const green = single.options?.find((o) => /Green/.test(o.label))?.value
    const toppings = (multi.options ?? []).filter((o) => /Olive|Corn/.test(o.label)).map((o) => o.value)
    answer(r, t.threadSlug, t.sessionId, "answer", { [single.id]: green, [multi.id]: toppings })
    ok("turn ended", await untilIdle(r, t.threadSlug, t.sessionId))
    const final = finalTexts(t.sessionId).at(-1) ?? ""
    ok("the agent read the answers", /Green/.test(final) && /Olive/.test(final) && /Corn/.test(final), JSON.stringify(final.slice(0, 160)))
    const result = records(t.sessionId).find((rec) => rec.kind === "tool-result") as { answers?: unknown } | undefined
    ok("the question row carries the answers", Array.isArray(result?.answers) && /Green/.test(String(result?.answers)), JSON.stringify(result?.answers))
    dump(t.sessionId)
    await r.bridge.endSession(t.threadSlug, t.sessionId)
  }

  if (runs("permission")) {
    console.log("permission (a mode that asks)")
    const t = thread()
    const asking: AntigravityProfile = { ...CHEAP, permissionMode: "default" }
    const opened = await r.bridge.spawnDispatch({ ...t, cwd, ...asking, prompt: "Run the shell command `frizzctl title probe` and then, as a separate command, `echo asked`. Reply with exactly what the two printed.", userText: "run two" })
    ok("a card was raised for the plain command only", await until(() => pending(r, t.threadSlug, t.sessionId).length === 1))
    const card = pending(r, t.threadSlug, t.sessionId)[0]
    const preview = (card?.payload as { command?: { preview?: string } } | undefined)?.command?.preview ?? ""
    console.log(`      card: ${card?.payload.kind} ${JSON.stringify(preview)} decisions=${card?.allowedDecisions.map((d) => d.id).join(",")}`)
    ok("it is a command approval for the echo", card?.payload.kind === "command-approval" && /echo asked/.test(preview) && !/frizzctl/.test(preview))
    answer(r, t.threadSlug, t.sessionId, "accept")
    ok("turn ended", await untilIdle(r, t.threadSlug, t.sessionId))
    const final = finalTexts(t.sessionId).at(-1) ?? ""
    ok("frizzctl ran with no card, and the approved command ran", /FRIZZCTL-RAN title probe/.test(final) && /asked/.test(final), JSON.stringify(final.slice(0, 160)))

    if (runs("profile")) {
      console.log("profile (live switches)")
      const level = await r.bridge.setProfile(t.threadSlug, t.sessionId, { ...asking, effort: "medium" })
      ok("the thinking level changed on the live session", level.applied && level.effort === "medium", JSON.stringify(level))
      const model = await r.bridge.setProfile(t.threadSlug, t.sessionId, { ...asking, modelId: "gpt-oss-120b-medium", effort: "medium" })
      ok("a model with no levels reports none", model.applied && model.model === "gpt-oss-120b-medium" && model.effort === undefined, JSON.stringify(model))
      const bypass = await r.bridge.setProfile(t.threadSlug, t.sessionId, { ...CHEAP })
      ok("a move to bypass restarts the idle agent", bypass.applied && bypass.restarting === true, JSON.stringify(bypass))
      ok("the old agent is gone", await until(() => !r.bridge.isAgentAlive(t.threadSlug, t.sessionId), 20_000))
      const back = await r.bridge.followUp({ ...t, cwd, ...CHEAP, agySessionId: opened.agySessionId, text: "Run the shell command `echo unasked` and reply with exactly what it printed." })
      ok("the session resumed on the new agent", back.resumed === "resumed", back.resumed)
      ok("turn ended", await untilIdle(r, t.threadSlug, t.sessionId))
      ok("and nothing asked", pending(r, t.threadSlug, t.sessionId).length === 0 && /unasked/.test(finalTexts(t.sessionId).at(-1) ?? ""), JSON.stringify(finalTexts(t.sessionId).at(-1)))
    }
    await r.bridge.endSession(t.threadSlug, t.sessionId)
  }

  if (runs("cancel")) {
    console.log("cancel")
    const t = thread()
    await r.bridge.spawnDispatch({ ...t, cwd, ...CHEAP, prompt: "Write the integers from 1 to 3000, one per line, with no other text and no tools.", userText: "count" })
    await sleep(4_000)
    const stopped = await r.bridge.interruptTurn(t.threadSlug, t.sessionId)
    ok("the turn was interrupted", stopped.interrupted && r.bridge.turnLiveness(t.threadSlug, t.sessionId)?.turnActive === false)
    const end = records(t.sessionId).filter((rec) => rec.kind === "turn-end").at(-1)
    ok("it is recorded as not successful", end?.kind === "turn-end" && end.successful === false)
    ok("the agent is still there for the next message", r.bridge.isAgentAlive(t.threadSlug, t.sessionId))
    dump(t.sessionId)
    await r.bridge.endSession(t.threadSlug, t.sessionId)
  }

  // ---- what a restart or a race decides (the stress run of 2026-11-20) --------------------------------

  if (runs("restart")) {
    console.log("restart (Frizz goes away mid-turn, twice: with the prompt still running, and with it finishing meanwhile)")
    const t = thread()
    const a = rig()
    await a.bridge.spawnDispatch({ ...t, cwd, ...CHEAP, prompt: "Run the shell command `sleep 12 && echo slept` and wait for it. Then reply with the single word RESTARTED.", userText: "sleep" })
    ok("the command started", await until(() => count(t.sessionId, "tool-call") === 1, 60_000))
    await a.bridge.shutdown()
    const b = rig()
    await b.bridge.warmUp([{ ...t, cwd, ...CHEAP }])
    ok("the prompt in flight is the new runtime's turn", b.bridge.turnLiveness(t.threadSlug, t.sessionId)?.turnActive === true && b.bridge.turnLiveness(t.threadSlug, t.sessionId)?.autonomous === false, JSON.stringify(b.bridge.turnLiveness(t.threadSlug, t.sessionId)))
    ok("turn ended", await untilIdle(b, t.threadSlug, t.sessionId, 90_000))
    ok("the call that spanned the restart is one call with one result", count(t.sessionId, "tool-call") === 1 && count(t.sessionId, "tool-result") === 1, `${count(t.sessionId, "tool-call")}/${count(t.sessionId, "tool-result")}`)
    ok("one turn, ending on the agent's answer", count(t.sessionId, "turn-end") === 1 && /RESTARTED/.test(finalTexts(t.sessionId).at(-1) ?? ""), JSON.stringify(finalTexts(t.sessionId)))
    console.log(`      the session after the reattach: ${JSON.stringify(b.bridge.session(t.threadSlug, t.sessionId))}`)

    await b.bridge.followUp({ ...t, cwd, ...CHEAP, text: "Run the shell command `sleep 6 && echo slept2` and wait for it. Then reply with the single word AWAY." })
    ok("the second command started", await until(() => count(t.sessionId, "tool-call") === 2, 60_000))
    await b.bridge.shutdown()
    await sleep(30_000) // the command ends, the agent answers and the prompt returns, all to nobody
    const c = rig()
    const t0 = Date.now()
    await c.bridge.warmUp([{ ...t, cwd, ...CHEAP }])
    const closed = await untilIdle(c, t.threadSlug, t.sessionId, 20_000)
    ok("a turn that finished while Frizz was away closes within seconds of the reattach", closed, `${Date.now() - t0}ms`)
    ok("its call is one call with one result", count(t.sessionId, "tool-call") === 2 && count(t.sessionId, "tool-result") === 2, `${count(t.sessionId, "tool-call")}/${count(t.sessionId, "tool-result")}`)
    ok("its answer is the turn's final text", count(t.sessionId, "turn-end") === 2 && /AWAY/.test(finalTexts(t.sessionId).at(-1) ?? ""), JSON.stringify(finalTexts(t.sessionId)))
    console.log(`      records after the last reattach: ${kinds(t.sessionId).slice(kinds(t.sessionId).lastIndexOf("acp-note")).join(" ")}`)
    if (a.diagnostics.length + b.diagnostics.length + c.diagnostics.length) console.log(`      diagnostics: ${[...a.diagnostics, ...b.diagnostics, ...c.diagnostics].slice(-8).join(" | ")}`)
    dump(t.sessionId)
    await c.bridge.endSession(t.threadSlug, t.sessionId)
    await c.bridge.shutdown()
  }

  if (runs("restart-card")) {
    console.log("restart-card (an approval is open when Frizz goes away)")
    const t = thread()
    const storePath = join(root, "interactions.db")
    const asking: AntigravityProfile = { ...CHEAP, permissionMode: "default" }
    const a = rig(storePath)
    await a.bridge.spawnDispatch({ ...t, cwd, ...asking, prompt: "Run the shell command `echo asked` and reply with exactly what it printed.", userText: "run" })
    ok("a card was raised", await until(() => pending(a, t.threadSlug, t.sessionId).length === 1))
    const firstId = pending(a, t.threadSlug, t.sessionId)[0]?.id
    await a.bridge.shutdown()
    const b = rig(storePath)
    await b.bridge.warmUp([{ ...t, cwd, ...asking }])
    ok("the card is raised again after the restart", await until(() => pending(b, t.threadSlug, t.sessionId).length === 1, 20_000), `first ${firstId}, now ${pending(b, t.threadSlug, t.sessionId)[0]?.id}`)
    if (pending(b, t.threadSlug, t.sessionId).length) answer(b, t.threadSlug, t.sessionId, "accept")
    ok("turn ended", await untilIdle(b, t.threadSlug, t.sessionId))
    ok("the approval given after the restart ran the command", /asked/.test(finalTexts(t.sessionId).at(-1) ?? ""), JSON.stringify(finalTexts(t.sessionId).at(-1)))
    ok("one call, one result", count(t.sessionId, "tool-call") === 1 && count(t.sessionId, "tool-result") === 1, `${count(t.sessionId, "tool-call")}/${count(t.sessionId, "tool-result")}`)
    await b.bridge.endSession(t.threadSlug, t.sessionId)
    await b.bridge.shutdown()
  }

  if (runs("stop-send")) {
    console.log("stop-send (a message sent while the turn is being stopped)")
    const t = thread()
    await r.bridge.spawnDispatch({ ...t, cwd, ...CHEAP, prompt: "Run the shell command `sleep 40 && echo slept` and wait for it. Then reply with the single word DONE.", userText: "sleep" })
    ok("the command started", await until(() => count(t.sessionId, "tool-call") === 1, 60_000))
    const t0 = Date.now()
    const stop = r.bridge.interruptTurn(t.threadSlug, t.sessionId)
    const follow = await r.bridge.followUp({ ...t, cwd, ...CHEAP, text: "Reply with the single word AFTER and nothing else." })
    await stop
    ok("the message waited for the stop and started a turn of its own", follow.state === "delivered" && follow.resumed === "live", `${follow.state}/${follow.resumed}, ${Date.now() - t0}ms after Stop`)
    ok("turn ended", await untilIdle(r, t.threadSlug, t.sessionId))
    ok("two turns: the stopped one, then the message's", count(t.sessionId, "turn-end") === 2 && /AFTER/.test(finalTexts(t.sessionId).at(-1) ?? ""), JSON.stringify(finalTexts(t.sessionId)))
    const result = records(t.sessionId).find((rec) => rec.kind === "tool-result") as { cancelled?: boolean } | undefined
    ok("the stopped command is recorded as cancelled", result?.cancelled === true, JSON.stringify(result))
    dump(t.sessionId)
    await r.bridge.endSession(t.threadSlug, t.sessionId)
  }

  if (runs("crash")) {
    console.log("crash (the agent process is killed mid-turn)")
    const t = thread()
    const info = await r.bridge.spawnDispatch({ ...t, cwd, ...CHEAP, prompt: "Run the shell command `sleep 40 && echo slept` and wait for it. Then reply with the single word DONE.", userText: "sleep" })
    ok("the command started", await until(() => count(t.sessionId, "tool-call") === 1, 60_000))
    const record = readAcpDaemonRecord(stateDir, t.sessionId)
    if (record?.childPid) process.kill(record.childPid, "SIGKILL")
    ok("the session is dropped", await until(() => r.bridge.turnLiveness(t.threadSlug, t.sessionId) === undefined, 20_000))
    const end = records(t.sessionId).filter((rec) => rec.kind === "turn-end").at(-1)
    ok("the turn is closed, unsuccessfully, and says why", end?.kind === "turn-end" && end.successful === false && kinds(t.sessionId).includes("provider-error"), kinds(t.sessionId).slice(-4).join(" "))
    const back = await r.bridge.followUp({ ...t, cwd, ...CHEAP, agySessionId: info.agySessionId, text: "Which shell command were you running when you were interrupted? Reply with the command alone." })
    ok("the next message resumes the session", back.resumed === "resumed" && back.agySessionId === info.agySessionId, `${back.resumed}`)
    ok("turn ended", await untilIdle(r, t.threadSlug, t.sessionId))
    ok("and the agent still has the conversation", /sleep 40/.test(finalTexts(t.sessionId).at(-1) ?? ""), JSON.stringify(finalTexts(t.sessionId).at(-1)))
    await r.bridge.endSession(t.threadSlug, t.sessionId)
  }

  if (runs("restart-answer")) {
    console.log("restart-answer (Frizz goes away while the agent is writing its answer)")
    const t = thread()
    const a = rig()
    await a.bridge.spawnDispatch({ ...t, cwd, ...CHEAP, prompt: "Without using any tool, write the numbers 1 to 150, one per line, each as `line N` (line 1, line 2, and so on). Write nothing before line 1. After line 150 write the single word FINISHED.", userText: "count" })
    ok("the answer began", await until(() => count(t.sessionId, "assistant-text") >= 2, 60_000))
    const before = records(t.sessionId).flatMap((r) => (r.kind === "assistant-text" ? [r.text] : [])).join("")
    await a.bridge.shutdown()
    const b = rig()
    await b.bridge.warmUp([{ ...t, cwd, ...CHEAP }])
    ok("turn ended", await untilIdle(b, t.threadSlug, t.sessionId, 90_000))
    const final = finalTexts(t.sessionId).at(-1) ?? ""
    const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`)
    ok("the restart landed inside the answer", before.length > 0 && !/FINISHED/.test(before), `${before.length} characters were written before it`)
    ok("the turn's final text is the whole answer, the part written before the restart included", count(t.sessionId, "turn-end") === 1 && final.startsWith(before.trimStart().slice(0, 40)) && lines.every((line) => final.includes(line)) && /FINISHED\s*$/.test(final), `${final.length} characters, opens ${JSON.stringify(final.slice(0, 24))}`)
    const messages = projectAntigravityTranscript(readFileSync(antigravityTranscriptPath(stateDir, t.sessionId), "utf8"), `antigravity:${t.sessionId}`, opencodeToolCards).filter((m) => m.role === "assistant")
    ok("and the drawer shows it as one message with no break at the restart", messages.length === 1 && messages[0]!.text === final, `${messages.length} message(s), ${messages[0]?.parts.length} part(s)`)
    if (a.diagnostics.length + b.diagnostics.length) console.log(`      diagnostics: ${[...a.diagnostics, ...b.diagnostics].slice(-8).join(" | ")}`)
    await b.bridge.endSession(t.threadSlug, t.sessionId)
    await b.bridge.shutdown()
  }

  if (runs("steers")) {
    console.log("steers (three messages in quick succession while a turn runs)")
    const t = thread()
    await r.bridge.spawnDispatch({ ...t, cwd, ...CHEAP, prompt: "Run the shell command `sleep 10 && echo slept` and wait for it. Then reply with the single word BASE.", userText: "sleep" })
    ok("the command started", await until(() => count(t.sessionId, "tool-call") === 1, 60_000))
    const steers = await Promise.all(["ONE", "TWO", "THREE"].map((word) => r.bridge.followUp({ ...t, cwd, ...CHEAP, text: `When you reply, also include the word ${word}.` })))
    ok("all three joined the running turn", steers.every((s) => s.state === "steered"), steers.map((s) => s.state).join(","))
    ok("turn ended", await untilIdle(r, t.threadSlug, t.sessionId, 90_000))
    ok("the four messages made ONE turn", count(t.sessionId, "turn-start") === 1 && count(t.sessionId, "turn-end") === 1, `${count(t.sessionId, "turn-start")}/${count(t.sessionId, "turn-end")}`)
    const final = finalTexts(t.sessionId).at(-1) ?? ""
    ok("the last steer was read", /THREE/.test(final), JSON.stringify(final.slice(0, 160)))
    console.log(`      steers read: ${["ONE", "TWO", "THREE"].filter((w) => final.includes(w)).join(",") || "none"}`)
    await r.bridge.endSession(t.threadSlug, t.sessionId)
  }

  if (runs("parallel")) {
    console.log("parallel (three threads at once)")
    const threads = [thread(), thread(), thread()]
    const words = ["HERON", "IBIS", "KITE"]
    await Promise.all(threads.map((t, i) => r.bridge.spawnDispatch({ ...t, cwd, ...CHEAP, prompt: `Reply with the single word ${words[i]} and nothing else.`, userText: words[i]! })))
    for (const t of threads) {
      const pid = readAcpDaemonRecord(stateDir, t.sessionId)?.childPid
      const rss = pid ? Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) : 0
      console.log(`      ${t.threadSlug}: agy pid ${pid}, ${Math.round(rss / 1024)} MB resident`)
    }
    const ended = await Promise.all(threads.map((t) => untilIdle(r, t.threadSlug, t.sessionId)))
    ok("all three turns ended", ended.every(Boolean))
    ok("each thread got its own answer", threads.every((t, i) => new RegExp(words[i]!).test(finalTexts(t.sessionId).at(-1) ?? "") && !words.some((w, j) => j !== i && (finalTexts(t.sessionId).at(-1) ?? "").includes(w))), threads.map((t) => JSON.stringify(finalTexts(t.sessionId).at(-1))).join(" "))
    for (const t of threads) await r.bridge.endSession(t.threadSlug, t.sessionId)
  }
} finally {
  await r.bridge.shutdown()
  for (const sessionId of liveAcpDaemonSessionIds(stateDir)) await stopAcpDaemon(stateDir, sessionId)
}
if (r.diagnostics.length) console.log(`diagnostics:\n  ${r.diagnostics.slice(-12).join("\n  ")}`)
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed")
process.exit(failures ? 1 : 0)
