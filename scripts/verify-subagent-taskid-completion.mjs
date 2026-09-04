// Does a sub-agent that finishes with a TASK-ID-ONLY notification say so in the thread?
//
// The harness reports a finished async sub-agent in two shapes, and one of them names the child only by
// its agent id — no `<tool-use-id>` anywhere in the block:
//
//   <task-notification>
//   <task-id>aab99c3e7b670a3ae</task-id>
//   <status>completed</status>
//   <summary>Agent "Survey bun-compiled OSS projects" finished</summary>
//
// The TAILER has always correlated that (launchTaskId reads the ack's agentId), so the child's row left
// the rail, the queue card and the ops strip — while the TRANSCRIPT parser resolved the task-id against a
// map that only ever held background shells, drew no completion divider and left the launch card pending
// forever. The child vanished with nothing said (maintainer 2026-07-30: "some sub-agents have disappeared
// from the rendered list … but I don't see any notification of it"); 155 of 1905 Agent dispatches in this
// machine's transcript corpus terminate this way.
//
// This drives the REAL stack — real tailer, real transcript projection, real render — against a fixture
// carrying BOTH shapes, so the task-id-only child is checked beside a tool-use-id control that always
// worked. Run against an `adhoc-stack.mjs` instance:
//
//   node scripts/verify-subagent-taskid-completion.mjs --port=4931 --home=<tempHome>
//
// Usage note: the stack loads server modules once at boot, so RESTART it after editing transcript.ts.
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=")
const port = arg("port") ?? "4931"
const home = arg("home")
if (!home) throw new Error("--home is required (take it from adhoc-stack's json line)")

const SLUG = `subagent-taskid-${Date.now().toString(36)}`
const SESSION = randomUUID()
const CWD = "/Users/colinmcd94/Documents/projects/frizz"
const projectDir = join(home, ".claude", "projects", CWD.replace(/[/.]/g, "-"))
const transcript = join(projectDir, `${SESSION}.jsonl`)

// ── the fixture transcript ────────────────────────────────────────────────────────────────────────
// Record shapes copied from the real bytes of nub session 0bb9560b (2026-07-30).
const rec = (o) => `${JSON.stringify(o)}\n`
const dispatch = (id, description, at) =>
  rec({ type: "assistant", timestamp: at, message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input: { description, prompt: `do ${description}`, subagent_type: "frizz:opus-high", run_in_background: true } }] } })
const ack = (id, agentId, at) =>
  rec({
    type: "user",
    timestamp: at,
    toolUseResult: { isAsync: true, status: "async_launched", agentId, description: "x" },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${agentId} (internal ID - do not mention to user.)\noutput_file: ${join(projectDir, SESSION, "tasks", `${agentId}.output`)}` }] },
  })
// SHAPE A — the one that always worked: the block names the DISPATCH by its tool_use id.
const notifyByToolUse = (id, at) =>
  rec({ type: "queue-operation", timestamp: at, content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n<summary>Agent "control" finished</summary>\n</task-notification>` })
// SHAPE B — the silent one: ONLY the agent id.
const notifyByTaskId = (agentId, label, at) =>
  rec({ type: "queue-operation", timestamp: at, content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<summary>Agent "${label}" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own.</note>\n</task-notification>` })
const say = (text, at) => rec({ type: "assistant", timestamp: at, message: { id: `m-${at}`, role: "assistant", content: [{ type: "text", text }] }, stop_reason: "end_turn" })

mkdirSync(projectDir, { recursive: true })
writeFileSync(transcript, "")
appendFileSync(transcript, rec({ type: "user", timestamp: "2026-07-30T17:40:00.000Z", message: { role: "user", content: "Survey the migration candidates." } }))
appendFileSync(transcript, dispatch("toolu_ctl", "Control — completes by tool-use-id", "2026-07-30T17:45:00.000Z"))
appendFileSync(transcript, ack("toolu_ctl", "a1111111111111111", "2026-07-30T17:45:01.000Z"))
appendFileSync(transcript, dispatch("toolu_tid", "Survey bun-compiled OSS projects", "2026-07-30T17:46:31.000Z"))
appendFileSync(transcript, ack("toolu_tid", "aab99c3e7b670a3ae", "2026-07-30T17:46:32.000Z"))
appendFileSync(transcript, dispatch("toolu_live", "Still running — no notification", "2026-07-30T17:47:00.000Z"))
appendFileSync(transcript, ack("toolu_live", "a2222222222222222", "2026-07-30T17:47:01.000Z"))
appendFileSync(transcript, say("All three are out. I'll keep working while they run.", "2026-07-30T17:48:00.000Z"))
appendFileSync(transcript, notifyByToolUse("toolu_ctl", "2026-07-30T17:52:00.000Z"))
appendFileSync(transcript, notifyByTaskId("aab99c3e7b670a3ae", "Survey bun-compiled OSS projects", "2026-07-30T18:00:39.000Z"))

// ── the session row + a live pane, so the board tails it for real ─────────────────────────────────
const sandbox = resolveSandboxDb(home)
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const dbPath = sandbox.db
execFileSync("sqlite3", [dbPath, `INSERT INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode) VALUES (${sessionVals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${new Date().toISOString()}', 'Sub-agent task-id completion', 'claude', 'opus', 'high', 'auto')`])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()

// Give the tailer a couple of ticks to fold the file and push a board delta.
await new Promise((r) => setTimeout(r, 4000))

const board = await api.query("board")
const row = board.threads?.find((t) => t.id === SLUG)
if (!row) throw new Error(`fixture thread ${SLUG} never reached the board`)
const live = (row.subAgents ?? []).map((s) => `${s.label} [${s.state}]`)

console.log(`URL   http://127.0.0.1:${port}/thread/${SLUG}/full`)
console.log(`SLUG  ${SLUG}`)
console.log(`LIVE  ${JSON.stringify(live)}`)

let failed = false
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`)
  if (!ok) failed = true
}
// The two finished children must be OFF the live list — that is the disappearance the operator sees.
check(!live.some((l) => l.startsWith("Control")), "the tool-use-id child left the live sub-agent list")
check(!live.some((l) => l.startsWith("Survey")), "the task-id-only child left the live sub-agent list")
check(live.some((l) => l.startsWith("Still running")), "the un-notified child is still listed")
process.exitCode = failed ? 1 : 0
