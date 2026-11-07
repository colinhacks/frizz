// A MONITOR, end to end (`frizzctl monitor add --persistent`, 2026-11-02): one registered script, a wake per line it
// prints — driven through the real path. A worker runs `frizzctl monitor add --persistent` as a real Bash tool call; the
// RPC starts the script on the server; each line it prints is recorded, queued in the outbox, claimed by
// the scheduler, handed to the broker daemon and written into the worker's transcript as a user record,
// which the worker answers. Only the model is replaced: the worker is scripts/scripted-claude.mjs.
//
// What it pins, on the running server and in the worker's own transcript:
//   A. The worker's own `frizzctl monitor add --persistent` registers it (the tool result names a `cmw_…` id). The
//      script's first line reaches the worker as ONE wake. Its second and third lines and its exit arrive
//      as ONE merged delivery: the lines are held by the outbox's five-minute quiet window, and the exit
//      ends the watch, so it is not held and carries them with it — in order, each line in its own part.
//      The exit wake names the code and the stderr tail. The row settles `passed` with 3 events and no
//      process group, and no wake is delivered twice.
//   B. The board and a drop. A second monitor registered through the same RPC shows on the board as a
//      `command` watch row with its description and its events; dropping it kills its script at once.
//   C. The worker RESTS ON ITS MONITOR, the way the contract tells it to: `monitors: [cmw_…]` with
//      `status: watching`. The thread sits in Snoozed, out of the queue. A line wakes it; it rests again.
//      Its idle daemon is hibernated while the script keeps running on the server, and the next lines
//      cold-resume it.
//   D. A server restart inside the quiet window. A line held by the window survives the stop; the stop
//      kills the script and leaves the row armed; the next server starts the script again; a line printed
//      after the restart joins the held one, and both arrive in one delivery, in order, once.
//   E. A drop kills the script's whole process group, and a line written after it wakes nobody. Across
//      C–E every line is delivered exactly once, and until the drop the resting worker is sent nothing but
//      its monitor's wakes — no park correction and no sign-off reminder. After it, a rest that still names
//      the dropped monitor is corrected rather than parked.
//
// Boot a stack with the scripted worker and the scheduler armed, from a shell with no Frizz worker
// variables in it, on a throwaway project, keeping its HOME (case D restarts it), with hibernation brought
// down to seconds (case C waits for it):
//   FRIZZ_HIBERNATE_IDLE_MINUTES=0.5 FRIZZ_HIBERNATE_SWEEP_SECONDS=15 \
//   nub scripts/adhoc-stack.mjs --port=NNNN --wakers --keep --project=/abs/throwaway-repo \
//     --claude-bin=/abs/path/to/scripts/scripted-claude.mjs > /abs/stack.log 2>&1
//   FRIZZ_HIBERNATE_IDLE_MINUTES=0.5 FRIZZ_HIBERNATE_SWEEP_SECONDS=15 \
//   nub scripts/verify-monitor-wakes.mjs --home=/abs/temp-home --port=NNNN [--quick]
// `--quick` runs A and B alone (about a minute); C–E take about fifteen, most of it the real five-minute
// window and the daemon's five-minute minimum age before it may hibernate. Run the verifier with the
// stack's own environment: case D boots the stack again with it. It sets the stack's permission mode to
// `bypassPermissions` (a monitor is refused anywhere else) through the settings RPC — the sandbox HOME's
// own settings, nobody else's. Dispatched workers are DETACHED: kill each by pid when done
// (`ps -Ao pid,command | grep claude-agent-broker`), and the restarted stack by the pid it prints.
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync, spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { parseMergedWake, parseMonitorWake, sectionOf } from "../packages/shared/src/index.ts"

const USAGE = "usage: nub scripts/verify-monitor-wakes.mjs --home=/abs/temp-home --port=NNNN [--cwd=/abs/project] [--quick]"
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const { home, port } = flags
if (!home || !port) {
  console.error(USAGE)
  process.exit(1)
}
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const db = join(home, ".frizz", "ui.db")
if (!existsSync(db)) throw new Error(`no ui.db at ${db} — is the stack booted?`)
const registry = JSON.parse(readFileSync(join(home, ".frizz", "registry.json"), "utf8"))
const cwd = flags.cwd ?? (registry.projects.length === 1 ? registry.projects[0].path : process.cwd())
const project = registry.projects.find((p) => p.path === cwd)
if (!project) throw new Error(`${cwd} is not registered in ${home}/.frizz/registry.json — pass --cwd=<the stack's --project>`)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
const scratch = join(home, "monitor-wakes")
mkdirSync(scratch, { recursive: true })

const api = createRpcClient(`http://127.0.0.1:${port}/`, project.id)
if (!(await api.waitForHealth())) throw new Error("the stack never answered /health")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sql = (q) => JSON.parse(execFileSync("sqlite3", ["-json", db, q], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim() || "[]")
const alive = (pid) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(what, cond, timeoutMs, everyMs = 250) {
  const start = Date.now()
  for (;;) {
    const value = await cond()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(everyMs)
  }
}
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? "✔" : "✖"} ${what}`)
  if (!ok) failures++
}
const stamp = () => new Date().toISOString().slice(11, 19)

/** Every record of a session's transcript. */
const records = (path) => !existsSync(path) ? [] : readFileSync(path, "utf8").split("\n").flatMap((line) => {
  try {
    return line ? [JSON.parse(line)] : []
  } catch {
    return []
  }
})
const WAKE_TRAILER = /\n*⏱[^\n]*\s*<!-- frizz-wake:[0-9a-f]+ -->\s*$/
const WAKE_MARK = /\s*<!-- frizz-wake:[0-9a-f]+ -->\s*$/
/** Every message Frizz delivered (a user record with a string body), each cut into its parts: the part's
 *  text, and what parseMonitorWake reads in it (null for anything that is not a monitor's wake). */
const deliveries = (path) => records(path)
  .filter((r) => r.type === "user" && typeof r.message?.content === "string" && r.message.content.includes("<!-- frizz-wake:"))
  .map((r) => (parseMergedWake(r.message.content)?.map((p) => p.body) ?? [r.message.content]).map((text) => {
    const body = text.replace(WAKE_TRAILER, "").replace(WAKE_MARK, "")
    return { text: body, monitor: parseMonitorWake(body) }
  }))
/** The monitor wakes alone, delivery by delivery (A's view). */
const wakes = (path) => deliveries(path).map((parts) => parts.map((p) => p.monitor).filter(Boolean))
/** The lines a monitor's EVENTS carried, in delivery order. */
const linesDelivered = (path, id) => deliveries(path).flat().flatMap((p) => p.monitor?.kind === "event" && p.monitor.id === id ? p.monitor.output.split("\n") : [])
/** The tool result whose text matches, as text. */
const toolResult = (path, re) => {
  const result = records(path).flatMap((r) => r.type === "user" && Array.isArray(r.message?.content) ? r.message.content : [])
    .find((b) => b.type === "tool_result" && re.test(JSON.stringify(b.content)))
  return result && JSON.stringify(result.content)
}
/** The processes carrying a session id on their command line: the scripted worker under its broker daemon. */
const sessionProcesses = (sessionId) => execFileSync("ps", ["-Ao", "pid=,command="]).toString().split("\n")
  .filter((l) => l.includes(sessionId)).map((l) => ({ pid: Number(l.trim().split(/\s+/)[0]), command: l.trim() }))
/** Which board section the thread sits in (`snoozed` is the band a `status: watching` rest belongs in). */
async function sectionNow(slug) {
  const snapshot = await api.query("board")
  const thread = snapshot.threads.find((t) => t.id === slug)
  return thread ? sectionOf(thread) : undefined
}

// ---- the worker ----------------------------------------------------------------------------------
const settings = await api.query("settingsGet")
await api.mutate("settingsSet", { ...settings, permissionMode: "bypassPermissions" })

// Lines 4s apart, so the first is past registration's 2s window and wakes on its own; then the script
// says why it is stopping on stderr and exits 3.
const SCRIPT = "for i in 1 2 3; do sleep 4; echo tick-$i; done; sleep 1; echo 'stopping: out of ticks' >&2; exit 3"
// Every rest signs off on a `steps:` fence, which names the human and nothing else: a rest the worker did
// not sign off would earn a sign-off reminder, whose handoff would start the quiet window and hold the
// FIRST line back five minutes. What is under test is the monitor's own wakes, not that reminder.
const REST = "Monitoring.\n\n```awaiting\nsteps:\n  - Nothing to do; this thread verifies a monitor.\n```"
const turns = join(scratch, "turns.json")
writeFileSync(turns, JSON.stringify({
  think: 200,
  // SINGLE-quoted, as a worker must: the tool runs through a shell, which would expand `$i` inside double
  // quotes before `frizzctl` ever saw the script (the first run of this file did exactly that).
  turns: [{ name: "registers", tools: [{ command: `frizzctl monitor add '${SCRIPT.replaceAll("'", "'\\''")}' --persistent --description "verify ticks" --for 1h`, description: "Registering a monitor" }], text: REST }],
  otherwise: { text: REST },
}, null, 2))

const { slug, sessionId } = await api.mutate("dispatch", { prompt: `[script file=${turns}] Verify a monitor.`, backend: "claude", title: "Monitor wakes" })
console.log(`dispatched ${slug} (${sessionId})`)
const path = join(jsonlDir, `${sessionId}.jsonl`)

// ---- A: the worker's own registration, then a wake per line and the exit -------------------------
const registered = await until("the worker's `frizzctl monitor add --persistent` result", () => toolResult(path, /Monitoring as cmw_|NOT registered|NOTHING IS RUNNING/), 30_000)
const id = /Monitoring as (cmw_[0-9a-f]{12})/.exec(registered)?.[1]
check(!!id, `A. the worker's frizzctl registered the monitor${id ? ` as ${id}` : `: ${registered.slice(0, 300)}`}`)
if (!id) process.exit(1)
const [row0] = sql(`SELECT kind, description, pid, state FROM command_watch WHERE id = '${id}'`)
check(row0?.kind === "monitor" && row0.description === "verify ticks" && row0.state === "armed" && alive(row0.pid), "A. its row is an armed monitor whose script runs")
const pid = row0.pid

const first = await until("the first line's wake", () => {
  const all = wakes(path)
  return all.length >= 1 && all[0]
}, 40_000)
check(first.length === 1 && first[0].kind === "event" && first[0].id === id && first[0].output === "tick-1" && first[0].label === "verify ticks",
  `A. the first line is one wake of its own: ${JSON.stringify(first)}`)

const rest = await until("the exit's delivery", () => wakes(path).find((parts) => parts.some((p) => p.kind === "exited")), 60_000)
check(JSON.stringify(rest.map((p) => [p.kind, p.kind === "event" ? p.output : null])) === JSON.stringify([["event", "tick-2"], ["event", "tick-3"], ["exited", null]]),
  `A. the next two lines ride the exit in one delivery, in order: ${JSON.stringify(rest.map((p) => [p.kind, p.output]))}`)
// The exit's tail is stdout and stderr as they interleaved, so it ends in the script's last words.
check(rest.at(-1)?.output === "tick-1\ntick-2\ntick-3\nstopping: out of ticks", `A. the exit carries the tail, stderr included: ${JSON.stringify(rest.at(-1)?.output)}`)
check(rest.at(-1)?.summary === "The script exited 3 after 3 events.", `A. the exit names its code and count: ${rest.at(-1)?.summary}`)
const [row1] = sql(`SELECT state, events, pid, last_exit FROM command_watch WHERE id = '${id}'`)
check(row1.state === "passed" && row1.events === 3 && row1.pid === null && row1.last_exit === 3, `A. the row settles: ${JSON.stringify(row1)}`)
check(!alive(pid), "A. no process of the script survives")
await sleep(12_000)
const counted = wakes(path).flat().filter((p) => p.id === id)
check(counted.length === 4, `A. nothing is delivered twice (${counted.length} parts after another tick)`)

// ---- B: the board's row, and a drop that kills the script ----------------------------------------
const added = await api.mutate("addOwnMonitor", { slug, command: "echo baseline; while true; do sleep 1; done", description: "verify drop", for: "1h" })
check(added.running && JSON.stringify(added.events) === JSON.stringify(["baseline"]), `B. registration hands back the window's line: ${JSON.stringify(added.events)}`)
const [row2] = sql(`SELECT pid FROM command_watch WHERE id = '${added.id}'`)
check(alive(row2.pid), "B. its script runs")
const board = await until("the monitor on the board", async () => {
  const snapshot = await api.query("board")
  const thread = snapshot.threads.find((t) => t.id === slug)
  return thread?.watches?.find((w) => w.target === added.id)
}, 20_000)
check(board.kind === "command" && board.command?.monitor?.description === "verify drop" && board.command.monitor.events === 1,
  `B. the board carries it as a monitor row: ${JSON.stringify(board.command?.monitor)}`)
const dropped = await api.mutate("dropOwnCommandWatch", { slug, id: added.id })
check(dropped.dropped && dropped.watches.length === 0, "B. the drop is accepted")
check(!alive(row2.pid), "B. the drop killed the script before it answered")

if ("quick" in flags) finish()

// ---- C: the worker RESTS on its monitor, and hibernates under it ---------------------------------
if (!(Number(process.env.FRIZZ_HIBERNATE_IDLE_MINUTES) <= 1)) {
  console.error("C needs hibernation brought down to seconds: run the stack AND this verifier with FRIZZ_HIBERNATE_IDLE_MINUTES=0.5 FRIZZ_HIBERNATE_SWEEP_SECONDS=15, or pass --quick")
  process.exit(1)
}
const events = join(scratch, "events.log")
writeFileSync(events, "")
const restFile = join(scratch, "rest.md")
// What a worker writes for "tell me about each new line": a tail that starts at the END, so a restart that
// runs it again from the top repeats nothing. The registering call composes the fence that rests on the id
// it was handed, and every later turn (each wake) rests on the same fence again.
const TAIL = `tail -n0 -F ${events}`
const REGISTER = [
  `out=$(frizzctl monitor add '${TAIL}' --persistent --description "verify park" --for 1h 2>&1)`,
  `echo "$out"`,
  `id=$(printf '%s' "$out" | grep -oE 'cmw_[0-9a-f]{12}' | head -n 1)`,
  `printf '%s\\n' 'Watching the log.' '' '\`\`\`awaiting' "monitors: [$id]" 'status: watching' 'for: 1h' '\`\`\`' > ${restFile}`,
].join("; ")
const parkTurns = join(scratch, "park-turns.json")
writeFileSync(parkTurns, JSON.stringify({
  think: 200,
  turns: [{ name: "registers and rests on it", tools: [{ command: REGISTER, description: "Registering a monitor" }], textFile: restFile }],
  otherwise: { textFile: restFile },
}, null, 2))
const parked = await api.mutate("dispatch", { prompt: `[script file=${parkTurns}] Rest on a monitor.`, backend: "claude", title: "Monitor park" })
console.log(`\n[${stamp()}] dispatched ${parked.slug} (${parked.sessionId})`)
const parkPath = join(jsonlDir, `${parked.sessionId}.jsonl`)
const rests = () => records(parkPath).filter((r) => r.type === "assistant" && JSON.stringify(r.message?.content ?? "").includes("monitors: [cmw_")).length

const parkResult = await until("the resting worker's `frizzctl monitor add --persistent` result", () => toolResult(parkPath, /Monitoring as cmw_|NOT registered|NOTHING IS RUNNING/), 30_000)
const parkId = /Monitoring as (cmw_[0-9a-f]{12})/.exec(parkResult)?.[1]
check(!!parkId, `C. the worker registered a tail of the log${parkId ? ` as ${parkId}` : `: ${parkResult.slice(0, 300)}`}`)
if (!parkId) process.exit(1)
await until("the worker's first rest", () => rests() >= 1, 30_000)
check(readFileSync(restFile, "utf8").includes(`monitors: [${parkId}]`), "C. it rests on `monitors:` naming that monitor, `status: watching`")
check(await until("the thread in Snoozed", async () => (await sectionNow(parked.slug)) === "snoozed", 30_000), "C. the rest parks the thread in Snoozed, out of the queue")
const rowPid = () => sql(`SELECT pid FROM command_watch WHERE id = '${parkId}'`)[0]?.pid

appendFileSync(events, "evt-1\n")
await until("evt-1's wake", () => linesDelivered(parkPath, parkId).includes("evt-1"), 45_000)
console.log(`[${stamp()}] evt-1 delivered`)
await until("the worker resting again", () => rests() >= 2, 30_000)
check(await until("the thread back in Snoozed", async () => (await sectionNow(parked.slug)) === "snoozed", 30_000), "C. a line wakes the worker, and it rests on the monitor again")

const daemon = sessionProcesses(parked.sessionId)
check(daemon.length > 0, `C. the worker's daemon runs (${daemon.map((p) => p.pid).join(", ")})`)
console.log(`[${stamp()}] waiting for the idle daemon to hibernate (it may not before it is 5m old)…`)
await until("the daemon hibernated", () => sessionProcesses(parked.sessionId).length === 0, 10 * 60_000, 2_000)
console.log(`[${stamp()}] hibernated`)
check(alive(rowPid()) && sql(`SELECT state FROM command_watch WHERE id = '${parkId}'`)[0]?.state === "armed", "C. the daemon hibernates while the script keeps running on the server")
check((await sectionNow(parked.slug)) === "snoozed", "C. the hibernated thread stays in Snoozed")

appendFileSync(events, "evt-2\n")
await sleep(400)
appendFileSync(events, "evt-3\n")
await until("evt-2 and evt-3", () => linesDelivered(parkPath, parkId).includes("evt-3"), 7 * 60_000, 1_000)
console.log(`[${stamp()}] evt-2 and evt-3 delivered`)
check(sessionProcesses(parked.sessionId).length > 0, "C. the next lines cold-resume the hibernated worker")
check(JSON.stringify(linesDelivered(parkPath, parkId)) === JSON.stringify(["evt-1", "evt-2", "evt-3"]), `C. in order, once each: ${JSON.stringify(linesDelivered(parkPath, parkId))}`)
await until("the resumed worker resting again", () => rests() >= 3, 60_000)

// ---- D: a restart inside the quiet window --------------------------------------------------------
appendFileSync(events, "evt-4\n")
await sleep(60_000)
check(!linesDelivered(parkPath, parkId).includes("evt-4"), "D. a line inside the five-minute window after a wake is held")
check((await sectionNow(parked.slug)) === "snoozed", "D. the thread stays in Snoozed while it is held")

const before = rowPid()
const stack = stackProcess()
if (!stack.keeps) {
  check(false, "D. the stack keeps its HOME across a stop — boot it with --keep")
  finish()
}
process.kill(stack.pid, "SIGTERM")
await until("the server to stop", () => !alive(stack.pid), 60_000)
console.log(`[${stamp()}] server stopped`)
check(!alive(before), `D. stopping the server kills the script (pid ${before})`)
check(sql(`SELECT state FROM command_watch WHERE id = '${parkId}'`)[0]?.state === "armed", "D. and leaves its row armed")
const restarted = await restartStack(stack)
console.log(`[${stamp()}] server booted again as pid ${restarted.pid} — kill THAT pid when done`)
const after = await until("the script started again", () => {
  const p = rowPid()
  return p && p !== before && alive(p) ? p : 0
}, 60_000)
check(!!after, `D. the next server starts the script again (pid ${after})`)
appendFileSync(events, "evt-5\n")
const both = await until("evt-4's delivery", () => deliveries(parkPath).find((parts) => parts.some((p) => p.monitor?.output === "evt-4")), 7 * 60_000, 1_000)
console.log(`[${stamp()}] evt-4 delivered`)
check(JSON.stringify(both.map((p) => p.monitor?.output)) === JSON.stringify(["evt-4", "evt-5"]),
  `D. the held line survives the restart, and the line printed after it joins it in one delivery: ${JSON.stringify(both.map((p) => p.monitor?.output ?? p.text.slice(0, 60)))}`)

// ---- E: a drop kills the whole group -------------------------------------------------------------
await until("the worker resting again", () => rests() >= 4, 60_000)
const beforeDrop = deliveries(parkPath).length
const last = rowPid()
const gone = await api.mutate("dropOwnCommandWatch", { slug: parked.slug, id: parkId })
check(gone.dropped && !alive(last), "E. a drop kills the script")
const tails = execFileSync("ps", ["-Ao", "pid=,command="]).toString().split("\n").filter((l) => l.includes(`tail -n0 -F ${events}`))
check(tails.length === 0, `E. no part of its pipeline survives${tails.length ? `: ${tails.join(" | ")}` : ""}`)
appendFileSync(events, "evt-6\n")
await sleep(25_000)
check(JSON.stringify(linesDelivered(parkPath, parkId)) === JSON.stringify(["evt-1", "evt-2", "evt-3", "evt-4", "evt-5"]),
  `E. every line arrived exactly once, in order, and nothing after the drop: ${JSON.stringify(linesDelivered(parkPath, parkId))}`)
const other = deliveries(parkPath).slice(0, beforeDrop).flat().filter((p) => !p.monitor)
check(other.length === 0, `E. until the drop, the resting worker was sent nothing but its monitor's wakes${other.length ? `: ${other.map((p) => p.text.slice(0, 80)).join(" | ")}` : ""}`)
// The scripted worker rests on the same fence after the drop, as a worker that forgot would. That fence now
// names a monitor that is gone, so it is no park, and Frizz says so.
const corrected = deliveries(parkPath).slice(beforeDrop).flat().find((p) => p.text.includes("names something that is not running") && p.text.includes(parkId))
check(!!corrected, "E. a rest still naming the dropped monitor is corrected, not parked")
finish()

function finish() {
  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`)
  console.log(`worker transcripts: ${path}${existsSync(join(scratch, "park-turns.json")) ? ` and ${jsonlDir}` : ""}`)
  process.exit(failures === 0 ? 0 : 1)
}

// ---- the stack, for the case that restarts it -----------------------------------------------------

/** The server process behind this HOME, and the arguments it was booted with. */
function stackProcess() {
  const { pid: serverPid } = JSON.parse(readFileSync(join(home, ".frizz", "server.lock"), "utf8"))
  const command = execFileSync("ps", ["-o", "command=", "-p", String(serverPid)]).toString().trim()
  const at = command.indexOf("adhoc-stack.mjs")
  if (at < 0) throw new Error(`pid ${serverPid} (from server.lock) is not an adhoc stack: ${command.slice(0, 120)}`)
  const args = command.slice(at + "adhoc-stack.mjs".length).trim().split(/\s+/).filter(Boolean)
  return { pid: serverPid, args, keeps: args.some((a) => a === "--keep" || a.startsWith("--home=")) }
}

/** Boot the stack again on the same HOME, with the arguments it had, detached from this process. */
async function restartStack(stack) {
  const args = [...stack.args.filter((a) => a !== "--keep" && !a.startsWith("--home=") && !a.startsWith("--project=")), `--home=${home}`, `--project=${cwd}`]
  const out = openSync(join(scratch, "stack-restart.log"), "a")
  const child = spawn("nub", [join(repoRoot, "scripts", "adhoc-stack.mjs"), ...args], { cwd: repoRoot, detached: true, stdio: ["ignore", out, out], env: process.env })
  child.unref()
  if (!(await api.waitForHealth(60_000))) throw new Error(`the stack did not come back; see ${join(scratch, "stack-restart.log")}`)
  return { pid: JSON.parse(readFileSync(join(home, ".frizz", "server.lock"), "utf8")).pid }
}
