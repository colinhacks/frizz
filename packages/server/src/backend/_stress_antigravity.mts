// Manual stress run, not CI: the Antigravity bridge against the fake `agy` (antigravity.fixtures/
// fake-agy.mjs) over real stdio, and through the real detached daemon where a scenario says so. It runs
// what a unit test is too slow or too broad for (200 turns on one session, 25 sessions at once, 86
// races of ending a session against a follow-up, junk frames), and every restart, stop and crash case,
// and it holds each transcript to its own rules afterwards. It spends no quota. From the repo root:
//
//   nub packages/server/src/backend/_stress_antigravity.mts [scenario ...]     default: all of them
//
// Exit 0 only when every check passed, no agent or daemon is left running, and nothing was rejected
// unhandled. `_live_antigravity.mts` runs the restart and race cases against the real CLI.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import Database from "../sqlite.ts"
import { createInteractionStore, type InteractionStore } from "../interaction-store.ts"
import { daemonAcpHost, liveAcpDaemonSessionIds, readAcpDaemonRecord, stopAcpDaemon } from "./acp-host.ts"
import { spawnAcpChild } from "./acp-rpc.ts"
import { parseAcpRecord, type AcpRecord } from "./acp-transcript.ts"
import { createAntigravityBridge, runAntigravityUsage, type AntigravityBridge } from "./antigravity-bridge.ts"
import { antigravityTranscriptPath, createAntigravityBackend, projectAntigravityTranscript } from "./antigravity-transcript.ts"
import { opencodeToolCards } from "../transcript.ts"
import { newTailState } from "../tailer.ts"

const FAKE = fileURLToPath(new URL("./antigravity.fixtures/fake-agy.mjs", import.meta.url))

interface Rig { bridge: AntigravityBridge; stateDir: string; store: InteractionStore; log: string; status: number; diagnostics: string[] }
interface RigOpts { mode?: string; daemon?: boolean; stateDir?: string; quietMs?: number; idleMs?: number; persistentStore?: boolean; cancelWaitMs?: number }
const rigs: Rig[] = []

function rig(opts: RigOpts = {}): Rig {
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "agy-stress-"))
  const log = join(stateDir, "agy-frames.jsonl")
  const store = createInteractionStore(new Database(opts.persistentStore ? join(stateDir, "interactions.db") : ":memory:"))
  const r: Rig = { stateDir, store, log, status: 0, diagnostics: [], bridge: undefined as unknown as AntigravityBridge }
  const asNode = <T extends { command: string; args: readonly string[] }>(o: T): T => ({ ...o, command: process.execPath, args: [FAKE, ...o.args] })
  r.bridge = createAntigravityBridge({
    projectId: "proj-1", stateDir, interactions: store,
    env: { ...process.env, FAKE_AGY_MODE: opts.mode ?? "", FAKE_AGY_LOG: log, FAKE_AGY_USAGE_FAIL: join(stateDir, "usage-fails") },
    bin: () => "/fake/bin/agy",
    spawn: (o) => spawnAcpChild(asNode(o)),
    runUsage: (o) => runAntigravityUsage(asNode(o)),
    ...(opts.daemon ? { host: (o) => daemonAcpHost(asNode(o)) } : {}),
    contractFor: () => "THE CONTRACT",
    onStatusChange: () => { r.status++ },
    onDiagnostic: (d) => { if (d.kind !== "stderr") r.diagnostics.push(`${d.kind}: ${d.message}`) },
    flushMs: 20, quietMs: opts.quietMs ?? 150, ...(opts.idleMs ? { idleMs: opts.idleMs } : {}), ...(opts.cancelWaitMs ? { cancelWaitMs: opts.cancelWaitMs } : {}), initializeTimeoutMs: 8_000,
  })
  rigs.push(r)
  return r
}

async function teardown(...list: Array<Rig | undefined>): Promise<void> {
  for (const r of list) {
    if (!r) continue
    await r.bridge.shutdown().catch(() => {})
    for (const sessionId of liveAcpDaemonSessionIds(r.stateDir)) await stopAcpDaemon(r.stateDir, sessionId).catch(() => {})
  }
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))
const records = (r: Rig, sessionId = "s1"): AcpRecord[] => {
  let raw = ""
  try { raw = readFileSync(antigravityTranscriptPath(r.stateDir, sessionId), "utf8") } catch { return [] }
  return raw.split("\n").map(parseAcpRecord).filter((x): x is AcpRecord => x !== undefined)
}
const kinds = (r: Rig, sessionId = "s1"): string[] => records(r, sessionId).map((x) => x.kind)
const frames = (r: Rig): any[] => { try { return readFileSync(r.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const sent = (r: Rig, method: string): any[] => frames(r).filter((f) => f.method === method)
async function until(what: string, check: () => boolean, timeoutMs = 8_000): Promise<number> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out (${timeoutMs}ms) waiting for ${what}`)
    await sleep(10)
  }
  return Date.now() - t0
}
const idle = (r: Rig, sessionId = "s1", slug = "t1", timeoutMs = 8_000) => until(`${slug} to go idle`, () => r.bridge.turnLiveness(slug, sessionId)?.turnActive !== true, timeoutMs)
const live = (r: Rig, sessionId = "s1"): any => (r.bridge as any).sessions.get(sessionId)
const base = { threadSlug: "t1", sessionId: "s1" }
const scope = { projectId: "proj-1", threadSlug: "t1", sessionId: "s1" }

/** Every structural rule a transcript must keep, whatever happened to the agent. */
function inconsistencies(recs: AcpRecord[], opts: { allowOpen?: boolean } = {}): string[] {
  const problems: string[] = []
  let open = false
  const calls = new Map<string, number>()
  const results = new Map<string, number>()
  recs.forEach((rec, i) => {
    const x = rec as any
    if (rec.kind === "turn-start") { if (open) problems.push(`#${i} turn-start inside an open turn`); open = true }
    else if (rec.kind === "turn-end") { if (!open) problems.push(`#${i} turn-end with no turn open`); open = false }
    else if (rec.kind === "tool-call") calls.set(x.id, (calls.get(x.id) ?? 0) + 1)
    else if (rec.kind === "tool-result") { results.set(x.id, (results.get(x.id) ?? 0) + 1); if (!calls.has(x.id)) problems.push(`#${i} tool-result ${x.id} with no call`) }
    else if (rec.kind === "assistant-text" || rec.kind === "reasoning") { if (!open) problems.push(`#${i} ${rec.kind} outside a turn`) }
    else if (rec.kind === "user-message") { const next = recs[i + 1]; if (!open && next?.kind !== "turn-start") problems.push(`#${i} user-message "${String(x.text).slice(0, 30)}" starts no turn`) }
  })
  if (open && !opts.allowOpen) problems.push("a turn is left open at the end of the file")
  for (const [id, n] of calls) if (n > 1) problems.push(`tool-call ${id} written ${n} times`)
  for (const [id, n] of results) if (n > 1) problems.push(`tool-result ${id} written ${n} times`)
  return problems
}
const count = (recs: AcpRecord[], kind: string): number => recs.filter((x) => x.kind === kind).length
const finals = (recs: AcpRecord[]): Array<string | undefined> => recs.filter((x) => x.kind === "turn-end").map((x) => (x as any).finalText)

// ---- reporting ------------------------------------------------------------------------------------
const failures: string[] = []
const observations: string[] = []
let current = ""
const fail = (message: string): void => { failures.push(`[${current}] ${message}`); console.log(`  ✖ ${message}`) }
const ok = (message: string): void => { console.log(`  ✔ ${message}`) }
const obs = (message: string): void => { observations.push(`[${current}] ${message}`); console.log(`  · ${message}`) }
const expect = (cond: boolean, message: string): void => { cond ? ok(message) : fail(message) }
const expectConsistent = (recs: AcpRecord[], label: string, opts?: { allowOpen?: boolean }): void => {
  const problems = inconsistencies(recs, opts)
  problems.length ? fail(`${label}: transcript breaks its own rules: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5})` : ""}`) : ok(`${label}: transcript is well-formed (${recs.length} records)`)
}
let unhandled = 0
process.on("unhandledRejection", (reason) => { unhandled++; console.log(`  !! unhandledRejection in [${current}]: ${(reason as Error)?.stack ?? reason}`) })
process.on("uncaughtException", (err) => { unhandled++; console.log(`  !! uncaughtException in [${current}]: ${err.stack ?? err}`) })

const fakeProcesses = (): Array<{ pid: number; command: string }> =>
  execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(FAKE)).map((l) => ({ pid: Number(l.trim().split(/\s+/)[0]), command: l.trim() }))

const scenarios: Record<string, () => Promise<void>> = {}

// ---- F1: one session, 200 turns ---------------------------------------------------------------------
scenarios["sequential-200"] = async () => {
  const r = rig()
  try {
    const t0 = Date.now()
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, permissionMode: "default", prompt: "ECHO t0", userText: "ECHO t0" })
    await idle(r)
    const expected = ["ECHO t0"]
    for (let i = 1; i < 200; i++) {
      const tool = i % 10 === 0
      await r.bridge.followUp({ ...base, cwd: r.stateDir, permissionMode: "default", text: tool ? `RUN: frizzctl title 'turn ${i}'` : `ECHO t${i}` })
      await idle(r)
      expected.push(tool ? "ALLOWED" : `ECHO t${i}`)
    }
    const recs = records(r)
    expectConsistent(recs, "200 turns")
    expect(count(recs, "turn-start") === 200 && count(recs, "turn-end") === 200, `200 turn-starts and 200 turn-ends (${count(recs, "turn-start")}/${count(recs, "turn-end")})`)
    const got = finals(recs)
    const wrong = got.findIndex((text, i) => text !== expected[i])
    expect(wrong === -1, wrong === -1 ? "every turn's final text is its own" : `turn ${wrong} ended with ${JSON.stringify(got[wrong])}, expected ${JSON.stringify(expected[wrong])}`)
    const l = live(r)
    expect(l.tools.size === 0 && l.cards.size === 0 && l.answers.size === 0, `nothing held per call after 200 turns (tools ${l.tools.size}, cards ${l.cards.size}, answers ${l.answers.size}, settled ${l.settled.length})`)
    expect(sent(r, "session/new").length === 1 && frames(r).filter((f) => f.argv).length === 1, "one agent, one session throughout")
    expect(r.store.listPending(scope).length === 0, "no card left pending")
    obs(`200 turns in ${Date.now() - t0}ms; diagnostics: ${r.diagnostics.length}`)
  } finally { await teardown(r) }
}

// ---- F2: many sessions at once ----------------------------------------------------------------------
async function parallel(n: number, turns: number, daemon: boolean): Promise<void> {
  const r = rig({ daemon })
  try {
    const t0 = Date.now()
    await Promise.all(Array.from({ length: n }, async (_, k) => {
      const id = { threadSlug: `t${k}`, sessionId: `s${k}` }
      await r.bridge.spawnDispatch({ ...id, cwd: r.stateDir, prompt: `ECHO a${k}-0`, userText: `ECHO a${k}-0` })
      await idle(r, id.sessionId, id.threadSlug, 20_000)
      for (let j = 1; j < turns; j++) {
        await r.bridge.followUp({ ...id, cwd: r.stateDir, text: `ECHO a${k}-${j}` })
        await idle(r, id.sessionId, id.threadSlug, 20_000)
      }
    }))
    let bad = 0
    for (let k = 0; k < n; k++) {
      const recs = records(r, `s${k}`)
      const problems = inconsistencies(recs)
      const got = finals(recs)
      const want = Array.from({ length: turns }, (_, j) => `ECHO a${k}-${j}`)
      if (problems.length || JSON.stringify(got) !== JSON.stringify(want)) { bad++; fail(`session s${k}: ${problems.join("; ") || `finals ${JSON.stringify(got)}`}`) }
    }
    expect(bad === 0, `${n} sessions x ${turns} turns each kept to their own transcript`)
    expect((r.bridge as any).sessions.size === n, `${n} live sessions`)
    obs(`${n} sessions (${daemon ? "daemon" : "direct"}) x ${turns} turns in ${Date.now() - t0}ms`)
  } finally { await teardown(r) }
  if (daemon) expect(liveAcpDaemonSessionIds(r.stateDir).length === 0, "every daemon stopped")
}
scenarios["parallel-25"] = () => parallel(25, 6, false)
scenarios["parallel-daemon-8"] = () => parallel(8, 3, true)

// ---- F3: a storm of steers ---------------------------------------------------------------------------
scenarios["steer-storm"] = async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "SLOW", userText: "SLOW" })
    await until("the agent to speak", () => kinds(r).includes("assistant-text"))
    const steers = await Promise.all(Array.from({ length: 10 }, (_, i) => r.bridge.followUp({ ...base, cwd: r.stateDir, text: `steer ${i}` })))
    expect(steers.every((s) => s.state === "steered" && s.resumed === "live"), "ten concurrent follow-ups all joined the running turn")
    expect(r.bridge.turnLiveness("t1", "s1")?.turnActive === true, "the turn is still running after ten steers")
    await r.bridge.followUp({ ...base, cwd: r.stateDir, text: "STOP_NOW" })
    await idle(r)
    const recs = records(r)
    expectConsistent(recs, "steer storm")
    expect(count(recs, "turn-start") === 1 && count(recs, "turn-end") === 1, "one turn")
    expect(recs.filter((x) => x.kind === "user-message").length === 12, `twelve user messages recorded (${recs.filter((x) => x.kind === "user-message").length})`)
    expect(sent(r, "session/prompt").length === 12, `twelve prompts reached the agent (${sent(r, "session/prompt").length})`)
    expect(/STOPPED$/.test((recs.at(-1) as any).finalText ?? "") && (recs.at(-1) as any).successful === true, `the turn ended on the last prompt's answer (${JSON.stringify((recs.at(-1) as any).finalText)})`)
    obs(`final text exactly: ${JSON.stringify((recs.at(-1) as any).finalText)}`)
  } finally { await teardown(r) }
}

// ---- F4: Stop pressed five times, with a message sent during the stop --------------------------------
scenarios["stop-storm"] = async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "SLOW", userText: "SLOW" })
    await until("the agent to speak", () => kinds(r).includes("assistant-text"))
    const stops = Promise.all(Array.from({ length: 5 }, () => r.bridge.interruptTurn("t1", "s1")))
    await sleep(5)
    const during = await r.bridge.followUp({ ...base, cwd: r.stateDir, text: "ECHO after-stop" }).catch((err) => ({ error: (err as Error).message }))
    const results = await stops
    await idle(r)
    await sleep(200)
    const recs = records(r)
    expectConsistent(recs, "stop storm")
    obs(`stops: ${JSON.stringify(results.map((x) => x.interrupted))}; follow-up during the stop: ${JSON.stringify(during)}; finals: ${JSON.stringify(finals(recs))}; kinds tail: ${kinds(r).slice(-6).join(",")}`)
    const answered = finals(recs).includes("ECHO after-stop")
    expect(answered, "the message sent during the stop is answered in a turn of its own")
    // Whatever happened to it, the session must take the next message.
    await r.bridge.followUp({ ...base, cwd: r.stateDir, text: "ECHO next" })
    await idle(r)
    expect(finals(records(r)).at(-1) === "ECHO next", "the session answers the next message")
    expectConsistent(records(r), "after the stop storm")
  } finally { await teardown(r) }
}

// ---- F5: ending a session while a message is on its way ----------------------------------------------
async function endRace(n: number, daemon: boolean, midTurn: boolean): Promise<void> {
  const r = rig({ daemon })
  try {
    let bad = 0
    for (let i = 0; i < n; i++) {
      const id = { threadSlug: `e${i}`, sessionId: `e${i}` }
      const first = await r.bridge.spawnDispatch({ ...id, cwd: r.stateDir, prompt: midTurn ? "SLOW" : "ECHO x", userText: "x" })
      if (midTurn) await until("the agent to speak", () => kinds(r, id.sessionId).includes("assistant-text"))
      else await idle(r, id.sessionId, id.threadSlug)
      const ending = r.bridge.endSession(id.threadSlug, id.sessionId)
      const follow = r.bridge.followUp({ ...id, cwd: r.stateDir, agySessionId: first.agySessionId, text: "ECHO y" })
      const [, result] = await Promise.all([ending, follow.catch((err) => ({ error: (err as Error).message }))])
      await idle(r, id.sessionId, id.threadSlug)
      const recs = records(r, id.sessionId)
      const problems = inconsistencies(recs)
      const answered = finals(recs).at(-1) === "ECHO y"
      if (problems.length || !answered || (result as any).error) { bad++; if (bad <= 3) fail(`iteration ${i}: ${JSON.stringify(result)}; finals ${JSON.stringify(finals(recs))}; ${problems.join("; ")}`) }
      await r.bridge.endSession(id.threadSlug, id.sessionId)
    }
    expect(bad === 0, `${n} ${midTurn ? "mid-turn " : ""}end/follow-up races (${daemon ? "daemon" : "direct"}): the follow-up always reached a new agent and was answered (${bad} bad)`)
  } finally { await teardown(r) }
}
scenarios["end-race-50"] = () => endRace(50, false, false)
scenarios["end-race-midturn-20"] = () => endRace(20, false, true)
scenarios["end-race-daemon-10"] = () => endRace(10, true, false)
scenarios["end-race-daemon-midturn-6"] = () => endRace(6, true, true)

// ---- F6: the agent dies ------------------------------------------------------------------------------
scenarios["crash-mid-turn"] = async () => {
  const r = rig()
  try {
    const first = await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "CRASH", userText: "CRASH" })
    await until("the session to be dropped", () => r.bridge.turnLiveness("t1", "s1") === undefined)
    let recs = records(r)
    expectConsistent(recs, "after the crash")
    expect(recs.some((x) => x.kind === "provider-error"), "the crash is recorded as a provider error")
    expect((recs.filter((x) => x.kind === "turn-end").at(-1) as any)?.successful === false, "the turn ended unsuccessfully")
    const again = await r.bridge.followUp({ ...base, cwd: r.stateDir, agySessionId: first.agySessionId, text: "ECHO back" })
    await idle(r)
    recs = records(r)
    expect(again.resumed === "resumed" && finals(recs).at(-1) === "ECHO back", `the next message resumes the session and is answered (${again.resumed})`)
    expectConsistent(recs, "after the resume")
  } finally { await teardown(r) }
}
scenarios["crash-with-card-open"] = async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, permissionMode: "default", prompt: "RUN: ls -la", userText: "go" })
    await until("a card", () => r.store.listPending(scope).length > 0)
    process.kill(live(r).conn.process.pid, "SIGKILL")
    await until("the session to be dropped", () => r.bridge.turnLiveness("t1", "s1") === undefined)
    expect(r.store.listPending(scope).length === 0, "the card went with the agent")
    expectConsistent(records(r), "after the agent died with a card open")
  } finally { await teardown(r) }
}
scenarios["crash-in-own-turn"] = async () => {
  const r = rig({ quietMs: 150 })
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "WAKE_TOOL 3000", userText: "go" })
    await until("the agent's own turn", () => r.bridge.turnLiveness("t1", "s1")?.autonomous === true)
    await until("its tool call", () => count(records(r), "tool-call") === 1)
    process.kill(live(r).conn.process.pid, "SIGKILL")
    await until("the session to be dropped", () => r.bridge.turnLiveness("t1", "s1") === undefined)
    const recs = records(r)
    expectConsistent(recs, "after the agent died in a turn it started")
    expect((recs.filter((x) => x.kind === "turn-end").at(-1) as any)?.successful === false, "its own turn ended unsuccessfully")
  } finally { await teardown(r) }
}

// ---- F7: frames the bridge was never promised --------------------------------------------------------
scenarios["garbage"] = async () => {
  const r = rig()
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "GARBAGE", userText: "GARBAGE" })
    await idle(r, "s1", "t1", 15_000)
    const recs = records(r)
    expectConsistent(recs, "garbage frames")
    const final = (recs.at(-1) as any)?.finalText as string | undefined
    expect(recs.at(-1)?.kind === "turn-end" && final?.endsWith("SURVIVED") === true, "the turn ended with the text sent after the garbage")
    expect(r.bridge.turnLiveness("t1", "s1")?.sessionLive === true, "the session is still live")
    const answered = frames(r).find((f) => f.id === "agy-unknown-method")
    expect(answered?.error?.code === -32601, `a request Frizz does not implement gets method-not-found (${JSON.stringify(answered?.error)})`)
    obs(`transcript is ${statSync(antigravityTranscriptPath(r.stateDir, "s1")).size} bytes after a 3MB message; final text ${final?.length} chars; diagnostics: ${JSON.stringify(r.diagnostics.map((d) => d.slice(0, 70)))}`)
    await r.bridge.followUp({ ...base, cwd: r.stateDir, text: "ECHO fine" })
    await idle(r)
    expect(finals(records(r)).at(-1) === "ECHO fine", "the next turn is clean")
  } finally { await teardown(r) }
}

// ---- F8: restarts ------------------------------------------------------------------------------------
scenarios["reattach-prompt-finished-while-away"] = async () => {
  const a = rig({ daemon: true, quietMs: 150, idleMs: 4_000 })
  let b: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, prompt: "WAIT 500", userText: "wait" })
    await until("the tool call", () => count(records(a), "tool-call") === 1)
    await a.bridge.shutdown()
    await sleep(1_200) // the prompt returns to nobody
    b = rig({ daemon: true, stateDir: a.stateDir, quietMs: 150, idleMs: 4_000 })
    const t0 = Date.now()
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    const attached = Date.now() - t0
    expect(b.bridge.turnLiveness("t1", "s1") !== undefined, "the session is live again")
    const took = await idle(b, "s1", "t1", 8_000).catch(() => -1)
    obs(`reattach took ${attached}ms; the adopted turn closed ${took}ms later (quiet 150ms, idle fallback 4000ms)`)
    expect(took >= 0 && took < 1_500, `a turn whose prompt finished while Frizz was away closes on the quiet rule, not the idle fallback (${took}ms)`)
    const recs = records(b)
    expectConsistent(recs, "prompt finished while away")
    expect(count(recs, "turn-end") === 1 && (recs.find((x) => x.kind === "turn-end") as any)?.finalText === "WAITED", `one turn, ending on the agent's answer (${JSON.stringify(finals(recs))})`)
  } finally { await teardown(b, a) }
}
scenarios["reattach-mid-answer"] = async () => {
  // The restart lands in the middle of the agent's answer, 5 times: once the prompt is still running
  // when Frizz comes back, and once it has returned to nobody.
  const whole = `${Array.from({ length: 40 }, (_, i) => `w${i + 1} `).join("")}END`
  let cut = 0
  for (let round = 0; round < 5; round++) {
    for (const away of [0, 1_200]) {
      const a = rig({ daemon: true, quietMs: 150, idleMs: 4_000 })
      let b: Rig | undefined
      try {
        await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, prompt: "TALK 40", userText: "talk" })
        await until("part of the answer in the file", () => count(records(a), "assistant-text") >= 1 + round)
        await a.bridge.shutdown()
        if (away) await sleep(away)
        b = rig({ daemon: true, stateDir: a.stateDir, quietMs: 150, idleMs: 4_000 })
        await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
        await idle(b, "s1", "t1", 8_000)
        const recs = records(b)
        expectConsistent(recs, `mid-answer, away ${away}ms`)
        if (finals(recs).length !== 1 || finals(recs)[0] !== whole) cut++
      } finally { await teardown(b, a) }
    }
  }
  expect(cut === 0, `10 restarts mid-answer: the turn's final text is the whole answer every time (${cut} cut)`)
}
scenarios["reattach-mid-tool"] = async () => {
  const a = rig({ daemon: true })
  let b: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, prompt: "WAIT 1500", userText: "wait" })
    await until("the tool call", () => count(records(a), "tool-call") === 1)
    await a.bridge.shutdown()
    b = rig({ daemon: true, stateDir: a.stateDir })
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    expect(b.bridge.turnLiveness("t1", "s1")?.turnActive === true && b.bridge.turnLiveness("t1", "s1")?.autonomous === false, "the prompt in flight is the new bridge's turn")
    await idle(b)
    const recs = records(b)
    expectConsistent(recs, "restart during a tool call")
    expect(count(recs, "tool-call") === 1 && count(recs, "tool-result") === 1, `the call that spans the restart is one call with one result (${count(recs, "tool-call")}/${count(recs, "tool-result")})`)
    expect(finals(recs).at(-1) === "WAITED", "the turn ends on the agent's answer")
    const tools = projectAntigravityTranscript(readFileSync(antigravityTranscriptPath(a.stateDir, "s1"), "utf8"), "antigravity:s1", opencodeToolCards).flatMap((m) => m.tools)
    obs(`the drawer shows ${tools.length} tool row(s): ${tools.map((t) => `${t.name}/${t.status}`).join(", ")}`)
  } finally { await teardown(b, a) }
}
scenarios["reattach-card-pending"] = async () => {
  const a = rig({ daemon: true, persistentStore: true })
  let b: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, permissionMode: "default", prompt: "RUN: ls -la", userText: "go" })
    await until("a card", () => a.store.listPending(scope).length > 0)
    await a.bridge.shutdown()
    expect(a.store.listPending(scope).length === 0, "the old runtime's card is cancelled on its side")
    b = rig({ daemon: true, stateDir: a.stateDir, persistentStore: true })
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    await until("the card to be raised again", () => b!.store.listPending(scope).length > 0)
    const pending = b.store.listPending(scope)[0]!
    b.store.resolve(scope, { slug: "t1", sessionId: "s1", interactionId: pending.id, sessionEpoch: pending.owner.sessionEpoch, capabilityRevision: pending.owner.capabilityRevision, expectedRecordRevision: pending.recordRevision, responseId: "resp-1", decisionId: "accept" })
    await idle(b)
    const recs = records(b)
    expectConsistent(recs, "card pending across a restart")
    expect(finals(recs).at(-1) === "ALLOWED", `the answer given after the restart reached the agent (${JSON.stringify(finals(recs))})`)
    expect(count(recs, "tool-call") === 1 && count(recs, "tool-result") === 1, `one call, one result (${count(recs, "tool-call")}/${count(recs, "tool-result")})`)
  } finally { await teardown(b, a) }
}
scenarios["reattach-twice"] = async () => {
  const a = rig({ daemon: true })
  let b: Rig | undefined
  let c: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, prompt: "SLOW", userText: "SLOW" })
    await until("the agent to speak", () => kinds(a).includes("assistant-text"))
    await a.bridge.shutdown()
    b = rig({ daemon: true, stateDir: a.stateDir })
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    await sleep(150)
    await b.bridge.shutdown()
    c = rig({ daemon: true, stateDir: a.stateDir })
    await c.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    expect(c.bridge.turnLiveness("t1", "s1")?.turnActive === true, "the turn is still the third runtime's")
    await c.bridge.followUp({ ...base, cwd: a.stateDir, text: "STOP_NOW" })
    await idle(c)
    const recs = records(c)
    expectConsistent(recs, "two restarts in one turn")
    expect(count(recs, "turn-start") === 1 && count(recs, "turn-end") === 1 && finals(recs)[0] === "STOPPED", `one turn across two restarts (${count(recs, "turn-start")}/${count(recs, "turn-end")}, ${JSON.stringify(finals(recs))})`)
    expect(count(recs, "tool-call") === 1 && count(recs, "tool-result") === 1, `one call, one result (${count(recs, "tool-call")}/${count(recs, "tool-result")})`)
    const text = recs.filter((x) => x.kind === "assistant-text").map((x) => (x as any).text).join("")
    const numbers = text.split("\n").filter((l) => /^\d+$/.test(l)).map(Number)
    const gaps = numbers.filter((n, i) => i > 0 && n !== numbers[i - 1]! + 1).length
    expect(gaps === 0, `nothing the agent said across the restarts was lost or repeated (${numbers.length} lines, ${gaps} gaps)`)
  } finally { await teardown(c, b, a) }
}
scenarios["reattach-own-work-while-away"] = async () => {
  const a = rig({ daemon: true, quietMs: 150 })
  let b: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, prompt: "BACKGROUND", userText: "bg" })
    await until("the first turn to end", () => kinds(a).includes("turn-end"))
    await a.bridge.shutdown() // the background command reports, and the agent speaks, to nobody
    await sleep(700)
    b = rig({ daemon: true, stateDir: a.stateDir, quietMs: 150 })
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    await sleep(100)
    await idle(b)
    const recs = records(b)
    expectConsistent(recs, "the agent worked by itself while Frizz was away")
    expect(count(recs, "tool-call") === 1 && count(recs, "tool-result") === 1, `the background call is one call with one result (${count(recs, "tool-call")}/${count(recs, "tool-result")})`)
    expect(finals(recs).at(-1) === "The background command printed late.", `what it said while away is in the transcript (${JSON.stringify(finals(recs))})`)
  } finally { await teardown(b, a) }
}
scenarios["agent-dies-while-away"] = async () => {
  const a = rig({ daemon: true })
  let b: Rig | undefined
  try {
    const first = await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, prompt: "WAIT 5000", userText: "wait" })
    await until("the tool call", () => count(records(a), "tool-call") === 1)
    await a.bridge.shutdown()
    const record = readAcpDaemonRecord(a.stateDir, "s1")!
    process.kill(record.childPid, "SIGKILL")
    await sleep(600)
    b = rig({ daemon: true, stateDir: a.stateDir })
    obs(`after the agent was killed while detached: daemon record alive = ${b.bridge.isAgentAlive("t1", "s1")}`)
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    obs(`after warm-up: liveness = ${JSON.stringify(b.bridge.turnLiveness("t1", "s1"))}; file turn open = ${inconsistencies(records(b)).includes("a turn is left open at the end of the file")}`)
    const again = await b.bridge.followUp({ ...base, cwd: a.stateDir, agySessionId: first.agySessionId, text: "ECHO back" })
    await idle(b)
    const recs = records(b)
    expectConsistent(recs, "agent died while Frizz was away")
    expect(finals(recs).at(-1) === "ECHO back", `the next message is answered by a resumed session (${again.resumed})`)
  } finally { await teardown(b, a) }
}

// ---- F9: an agent that does not act on cancel --------------------------------------------------------
async function deaf(daemon: boolean): Promise<void> {
  const r = rig({ daemon, cancelWaitMs: 800 })
  try {
    const first = await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "DEAF 6000", userText: "deaf" })
    await until("the agent to speak", () => kinds(r).includes("assistant-text"))
    const t0 = Date.now()
    const result = await r.bridge.interruptTurn("t1", "s1")
    obs(`Stop returned ${JSON.stringify(result)} after ${Date.now() - t0}ms`)
    await sleep(300)
    let recs = records(r)
    expectConsistent(recs, "after Stop on a deaf agent")
    expect(recs.some((x) => x.kind === "acp-note" && (x as any).text === "Turn cancelled."), "the turn is recorded as cancelled")
    obs(`agent alive after Stop: ${r.bridge.isAgentAlive("t1", "s1")}; liveness: ${JSON.stringify(r.bridge.turnLiveness("t1", "s1"))}`)
    const again = await r.bridge.followUp({ ...base, cwd: r.stateDir, agySessionId: first.agySessionId, text: "ECHO after-deaf" })
    obs(`follow-up after the Stop: ${JSON.stringify({ state: again.state, resumed: again.resumed })}`)
    const took = await idle(r, "s1", "t1", 9_000).catch(() => -1)
    recs = records(r)
    expectConsistent(recs, "the message after a deaf Stop")
    expect(took >= 0 && finals(recs).at(-1) === "ECHO after-deaf", `the next message gets its own answer (${took}ms, finals ${JSON.stringify(finals(recs))})`)
  } finally { await teardown(r) }
}
scenarios["deaf-direct"] = () => deaf(false)
scenarios["deaf-daemon"] = () => deaf(true)

// ---- F10: bypass switched on mid-turn, with a message in the restart window ---------------------------
scenarios["bypass-flip"] = async () => {
  for (const daemon of [false, true]) {
    const r = rig({ daemon })
    try {
      const first = await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, permissionMode: "default", prompt: "SLOW", userText: "SLOW" })
      await until("the agent to speak", () => kinds(r).includes("assistant-text"))
      const set = await r.bridge.setProfile("t1", "s1", { permissionMode: "bypassPermissions" })
      expect(set.restarting === true, "the change to bypass is owed a restart")
      await r.bridge.followUp({ ...base, cwd: r.stateDir, permissionMode: "bypassPermissions", text: "STOP_NOW" })
      // Fire the next message the instant the turn ends, inside the restart.
      await until("the turn to end", () => count(records(r), "turn-end") === 1)
      const next = await r.bridge.followUp({ ...base, cwd: r.stateDir, agySessionId: first.agySessionId, permissionMode: "bypassPermissions", text: "ECHO on-bypass" })
      await idle(r)
      const recs = records(r)
      expectConsistent(recs, `bypass flip (${daemon ? "daemon" : "direct"})`)
      expect(finals(recs).at(-1) === "ECHO on-bypass", `the message sent in the restart window is answered (${next.resumed}; ${JSON.stringify(finals(recs))})`)
      const launches = frames(r).filter((f) => f.argv).map((f) => f.argv.join(" "))
      expect(launches.length === 2 && launches[1] === "acp --dangerously-skip-permissions", `exactly one restart, onto the bypass flag (${JSON.stringify(launches)})`)
      expect(sent(r, "session/prompt").filter((f) => f.params.prompt[0].text === "ECHO on-bypass").length === 1, "delivered once")
    } finally { await teardown(r) }
  }
}

// ---- F11: quota --------------------------------------------------------------------------------------
scenarios["quota-storm"] = async () => {
  const r = rig()
  try {
    const all = await Promise.all(Array.from({ length: 20 }, () => r.bridge.quota(r.stateDir)))
    expect(all.every((q) => q.status === "ok" && q.windows.length === 2), "twenty concurrent readings all answered")
    expect(frames(r).filter((f) => f.argv?.[0] === "-p").length === 1, `one usage run for twenty callers (${frames(r).filter((f) => f.argv?.[0] === "-p").length})`)
    const forced = await Promise.all(Array.from({ length: 10 }, () => r.bridge.quota(r.stateDir, { force: true })))
    expect(forced.every((q) => q.status === "ok") && frames(r).filter((f) => f.argv?.[0] === "-p").length === 2, `ten forced readings at once share one more run (${frames(r).filter((f) => f.argv?.[0] === "-p").length})`)
    const t0 = Date.now()
    const hung = await runAntigravityUsage({ command: "/bin/sleep", args: ["30"], cwd: r.stateDir, env: process.env, timeoutMs: 300 }).then(() => "resolved", (err) => (err as Error).message)
    expect(hung === "no answer in 0s" && Date.now() - t0 < 1_500, `a usage run that hangs is stopped at its timeout (${hung}, ${Date.now() - t0}ms)`)
    const sleepers = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.trim().split(/\s+/)[1] === String(process.pid) && l.includes("sleep 30"))
    expect(sleepers.length === 0, "and its process is gone")
  } finally { await teardown(r) }
}

// ---- hypotheses from reading the bridge ---------------------------------------------------------------
scenarios["own-turn-long-tool"] = async () => {
  const r = rig({ quietMs: 150, idleMs: 500 })
  try {
    await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "WAKE_TOOL 1800", userText: "go" })
    await until("the agent's own turn", () => r.bridge.turnLiveness("t1", "s1")?.autonomous === true)
    await until("CHECK DONE", () => records(r).some((x) => x.kind === "assistant-text" && (x as any).text.includes("CHECK DONE")), 6_000)
    await idle(r)
    const recs = records(r)
    expectConsistent(recs, "a long silent command in a turn the agent started")
    const wakes = recs.filter((x) => x.kind === "user-message" && (x as any).synthetic).length
    obs(`kinds after the first turn: ${kinds(r).slice(kinds(r).indexOf("turn-end") + 1).join(",")}`)
    expect(wakes === 1, `the work is one turn, not split by the idle fallback while its command ran (${wakes} "carried on by itself" turns)`)
  } finally { await teardown(r) }
}
scenarios["profile-during-open"] = async () => {
  const r = rig()
  try {
    const dispatch = r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, modelId: "gem-flash", effort: "high", prompt: "ECHO a", userText: "a" })
    const set = await r.bridge.setProfile("t1", "s1", { modelId: "third-party" })
    await dispatch
    await idle(r)
    obs(`setProfile during the open returned ${JSON.stringify(set)}; the session then runs on ${r.bridge.session("t1", "s1")?.model}`)
    expect(set.applied === true && r.bridge.session("t1", "s1")?.model === "third-party", "a profile change made while the session is opening reaches it")
  } finally { await teardown(r) }
}
scenarios["shutdown-during-open"] = async () => {
  const r = rig({ daemon: true })
  try {
    const dispatch = r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "ECHO a", userText: "a" }).then(() => "sent", (err) => `refused: ${(err as Error).message}`)
    await sleep(30)
    await r.bridge.shutdown()
    const outcome = await dispatch
    await sleep(500)
    obs(`dispatch racing a shutdown: ${outcome}; sessions held by the closed bridge: ${(r.bridge as any).sessions.size}; records: ${kinds(r).join(",")}`)
    expect((r.bridge as any).sessions.size === 0, "a bridge that has shut down holds no session")
    expectConsistent(records(r), "dispatch racing a shutdown", { allowOpen: true })
  } finally { await teardown(r) }
}
scenarios["resume-message-ids"] = async () => {
  const r = rig()
  try {
    const first = await r.bridge.spawnDispatch({ ...base, cwd: r.stateDir, prompt: "ECHO one", userText: "one" })
    await idle(r)
    await r.bridge.endSession("t1", "s1")
    await r.bridge.followUp({ ...base, cwd: r.stateDir, agySessionId: first.agySessionId, text: "ECHO two" })
    await idle(r)
    const messages = projectAntigravityTranscript(readFileSync(antigravityTranscriptPath(r.stateDir, "s1"), "utf8"), "antigravity:s1", opencodeToolCards)
    const texts = messages.filter((m) => m.role === "assistant").map((m) => m.text)
    expect(JSON.stringify(texts) === JSON.stringify(["ECHO one", "ECHO two"]), `a resumed agent's first message is its own bubble (${JSON.stringify(texts)})`)
    const state = newTailState("t1", "s1", "/x")
    const backend = createAntigravityBackend({ stateDir: r.stateDir })
    for (const line of readFileSync(antigravityTranscriptPath(r.stateDir, "s1"), "utf8").split("\n")) backend.foldLine(state, line)
    expect(state.lastAssistant === "ECHO two", `the board's fold reads the resumed agent's message alone (${JSON.stringify(state.lastAssistant)})`)
  } finally { await teardown(r) }
}

scenarios["reattach-bypass-mismatch"] = async () => {
  const a = rig({ daemon: true })
  let b: Rig | undefined
  try {
    const first = await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, permissionMode: "bypassPermissions", prompt: "SLOW", userText: "SLOW" })
    await until("the agent to speak", () => kinds(a).includes("assistant-text"))
    const set = await a.bridge.setProfile("t1", "s1", { permissionMode: "default" })
    expect(set.restarting === true, "leaving bypass mid-turn is owed a restart")
    await a.bridge.shutdown() // Frizz restarts before the turn ends; the row now says Ask
    b = rig({ daemon: true, stateDir: a.stateDir })
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir, permissionMode: "default" }])
    await b.bridge.followUp({ ...base, cwd: a.stateDir, permissionMode: "default", text: "STOP_NOW" })
    await until("the turn to end", () => count(records(b!), "turn-end") === 1)
    await until("the bypass agent to be retired", () => b!.bridge.turnLiveness("t1", "s1") === undefined)
    await b.bridge.followUp({ ...base, cwd: a.stateDir, agySessionId: first.agySessionId, permissionMode: "default", text: "ECHO asked" })
    await idle(b)
    const launches = frames(b).filter((f) => f.argv).map((f) => f.argv.join(" "))
    expect(launches.length === 2 && launches[1] === "acp", `the agent launched in bypass is replaced by one that asks (${JSON.stringify(launches)})`)
    expect(finals(records(b)).at(-1) === "ECHO asked", "and the next message is answered by it")
    expectConsistent(records(b), "bypass left across a restart")
  } finally { await teardown(b, a) }
}
scenarios["reboot-leaves-turn-open"] = async () => {
  const a = rig({ daemon: true })
  let b: Rig | undefined
  try {
    await a.bridge.spawnDispatch({ ...base, cwd: a.stateDir, prompt: "SLOW", userText: "SLOW" })
    await until("the agent to speak", () => kinds(a).includes("assistant-text"))
    await a.bridge.shutdown()
    await stopAcpDaemon(a.stateDir, "s1") // the reboot
    b = rig({ daemon: true, stateDir: a.stateDir })
    await b.bridge.warmUp([{ ...base, cwd: a.stateDir }])
    const recs = records(b)
    expectConsistent(recs, "a turn whose agent did not survive the restart")
    expect((recs.filter((x) => x.kind === "turn-end").at(-1) as any)?.successful === false, "the turn is closed, unsuccessfully, at boot")
    const state = newTailState("t1", "s1", "/x")
    const backend = createAntigravityBackend({ stateDir: a.stateDir })
    for (const line of readFileSync(antigravityTranscriptPath(a.stateDir, "s1"), "utf8").split("\n")) backend.foldLine(state, line)
    expect(state.turn === "idle", `the board's fold reads the thread as idle (${state.turn})`)
  } finally { await teardown(b, a) }
}

// ---- run ---------------------------------------------------------------------------------------------
const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : Object.keys(scenarios)
const before = fakeProcesses().map((p) => p.pid)
for (const name of names) {
  const run = scenarios[name]
  if (!run) { console.log(`unknown scenario ${name}`); continue }
  current = name
  console.log(`\n== ${name}`)
  const t0 = Date.now()
  try { await run() } catch (err) { fail(`threw: ${(err as Error).stack?.split("\n").slice(0, 3).join(" | ") ?? err}`) }
  console.log(`  (${Date.now() - t0}ms)`)
}
current = "end"
await sleep(1_500)
const leaked = fakeProcesses().filter((p) => !before.includes(p.pid))
if (leaked.length) { fail(`${leaked.length} fake agent process(es) left running: ${leaked.map((p) => p.pid).join(", ")}`); for (const p of leaked) { try { process.kill(p.pid, "SIGKILL") } catch {} } }
else console.log("\n✔ no agent process left running")
const daemons = rigs.flatMap((r) => liveAcpDaemonSessionIds(r.stateDir).map((s) => `${r.stateDir}:${s}`))
if (daemons.length) fail(`daemons left running: ${daemons.join(", ")}`)
if (unhandled) fail(`${unhandled} unhandled rejection(s) or exception(s)`)
else console.log("✔ no unhandled rejection")
for (const r of rigs) { try { rmSync(r.stateDir, { recursive: true, force: true }) } catch {} }
console.log(`\n${failures.length} failure(s)`)
for (const f of failures) console.log(`  ✖ ${f}`)
process.exit(failures.length ? 1 : 0)
