// A MONITOR, end to end (`frizzctl monitor`, 2026-11-02): one registered script, a wake per line it
// prints — driven through the real path. A worker runs `frizzctl monitor add` as a real Bash tool call; the
// RPC starts the script on the server; each line it prints is recorded, queued in the outbox, claimed by
// the scheduler, handed to the broker daemon and written into the worker's transcript as a user record,
// which the worker answers. Only the model is replaced: the worker is scripts/scripted-claude.mjs.
//
// What it pins, on the running server and in the worker's own transcript:
//   A. The worker's own `frizzctl monitor add` registers it (the tool result names a `cmw_…` id). The
//      script's first line reaches the worker as ONE wake. Its second and third lines and its exit arrive
//      as ONE merged delivery: the lines are held by the outbox's five-minute quiet window, and the exit
//      ends the watch, so it is not held and carries them with it — in order, each line in its own part.
//      The exit wake names the code and the stderr tail. The row settles `passed` with 3 events and no
//      process group, and no wake is delivered twice.
//   B. The board and a drop. A second monitor registered through the same RPC shows on the board as a
//      `command` watch row with its description and its events; dropping it kills its script at once.
//
// Boot a stack with the scripted worker and the scheduler armed, from a shell with no Frizz worker
// variables in it, on a throwaway project, then:
//   nub scripts/adhoc-stack.mjs --port=NNNN --wakers --project=/abs/throwaway-repo \
//     --claude-bin=/abs/path/to/scripts/scripted-claude.mjs > /abs/stack.log 2>&1
//   nub scripts/verify-monitor-wakes.mjs --home=/abs/temp-home --port=NNNN
// It sets the stack's permission mode to `bypassPermissions` (a monitor is refused anywhere else) through
// the settings RPC — the sandbox HOME's own settings, nobody else's. Dispatched workers are DETACHED: kill
// each by pid when done (`ps -Ao pid,command | grep claude-agent-broker`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { parseMergedWake, parseMonitorWake } from "../packages/shared/src/index.ts"

const USAGE = "usage: nub scripts/verify-monitor-wakes.mjs --home=/abs/temp-home --port=NNNN [--cwd=/abs/project]"
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const { home, port } = flags
if (!home || !port) {
  console.error(USAGE)
  process.exit(1)
}

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
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(what, cond, timeoutMs) {
  const start = Date.now()
  for (;;) {
    const value = await cond()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(250)
  }
}
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? "✔" : "✖"} ${what}`)
  if (!ok) failures++
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
  turns: [{ name: "registers", tools: [{ command: `frizzctl monitor add '${SCRIPT.replaceAll("'", "'\\''")}' --description "verify ticks" --for 1h`, description: "Registering a monitor" }], text: REST }],
  otherwise: { text: REST },
}, null, 2))

const { slug, sessionId } = await api.mutate("dispatch", { prompt: `[script file=${turns}] Verify a monitor.`, backend: "claude", title: "Monitor wakes" })
console.log(`dispatched ${slug} (${sessionId})`)
const path = join(jsonlDir, `${sessionId}.jsonl`)
const records = () => !existsSync(path) ? [] : readFileSync(path, "utf8").split("\n").flatMap((line) => {
  try {
    return line ? [JSON.parse(line)] : []
  } catch {
    return []
  }
})
/** Every message Frizz delivered (a user record with a string body), cut into its wakes. */
const wakes = () => records()
  .filter((r) => r.type === "user" && typeof r.message?.content === "string" && r.message.content.includes("<!-- frizz-wake:"))
  .map((r) => {
    const parts = parseMergedWake(r.message.content)?.map((p) => p.body) ?? [r.message.content]
    return parts.map((text) => parseMonitorWake(text.replace(/\n*⏱[^\n]*\s*<!-- frizz-wake:[0-9a-f]+ -->\s*$/, "").replace(/\s*<!-- frizz-wake:[0-9a-f]+ -->\s*$/, ""))).filter(Boolean)
  })

// ---- A: the worker's own registration, then a wake per line and the exit -------------------------
const registered = await until("the worker's `frizzctl monitor add` result", () => {
  const result = records().flatMap((r) => r.type === "user" && Array.isArray(r.message?.content) ? r.message.content : [])
    .find((b) => b.type === "tool_result" && /Monitoring as cmw_|NOT registered|NOTHING IS RUNNING/.test(JSON.stringify(b.content)))
  return result && JSON.stringify(result.content)
}, 30_000)
const id = /Monitoring as (cmw_[0-9a-f]{12})/.exec(registered)?.[1]
check(!!id, `A. the worker's frizzctl registered the monitor${id ? ` as ${id}` : `: ${registered.slice(0, 300)}`}`)
if (!id) process.exit(1)
const [row0] = sql(`SELECT kind, description, pid, state FROM command_watch WHERE id = '${id}'`)
check(row0?.kind === "monitor" && row0.description === "verify ticks" && row0.state === "armed" && alive(row0.pid), "A. its row is an armed monitor whose script runs")
const pid = row0.pid

const first = await until("the first line's wake", () => {
  const all = wakes()
  return all.length >= 1 && all[0]
}, 40_000)
check(first.length === 1 && first[0].kind === "event" && first[0].id === id && first[0].output === "tick-1" && first[0].label === "verify ticks",
  `A. the first line is one wake of its own: ${JSON.stringify(first)}`)

const rest = await until("the exit's delivery", () => {
  const all = wakes()
  return all.find((parts) => parts.some((p) => p.kind === "exited"))
}, 60_000)
check(JSON.stringify(rest.map((p) => [p.kind, p.kind === "event" ? p.output : null])) === JSON.stringify([["event", "tick-2"], ["event", "tick-3"], ["exited", null]]),
  `A. the next two lines ride the exit in one delivery, in order: ${JSON.stringify(rest.map((p) => [p.kind, p.output]))}`)
// The exit's tail is stdout and stderr as they interleaved, so it ends in the script's last words.
check(rest.at(-1)?.output === "tick-1\ntick-2\ntick-3\nstopping: out of ticks", `A. the exit carries the tail, stderr included: ${JSON.stringify(rest.at(-1)?.output)}`)
check(rest.at(-1)?.summary === "The script exited 3 after 3 events.", `A. the exit names its code and count: ${rest.at(-1)?.summary}`)
const [row1] = sql(`SELECT state, events, pid, last_exit FROM command_watch WHERE id = '${id}'`)
check(row1.state === "passed" && row1.events === 3 && row1.pid === null && row1.last_exit === 3, `A. the row settles: ${JSON.stringify(row1)}`)
check(!alive(pid), "A. no process of the script survives")
await sleep(12_000)
const counted = wakes().flat().filter((p) => p.id === id)
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

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`)
console.log(`worker transcript: ${path}`)
process.exit(failures === 0 ? 0 : 1)
