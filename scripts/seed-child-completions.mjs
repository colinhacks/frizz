// Seed a disposable adhoc stack with a SIMULATED worker whose transcript contains BOTH kinds of child
// completion — a dispatched sub-agent that finished, and a background shell that was killed — so the
// converged rendering can be judged in the REAL app: real tailer, real transcript.ts fold, real board
// push, real browser. A fixture page proves the components; only this proves the SERVER actually sets
// `agentCompletion` on the completion copy and not on the launch card.
//
// Follows the frizz-stack recipe: a session row + a JSONL the tailer reads.
//
// Usage: node scripts/seed-child-completions.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node seed-child-completions.mjs --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const SLUG = "child-completions"
const SESSION = "c41ld-c0mp-4let-8000-000000000001"
const THREAD_NAME = `frizz-${SLUG}`
const AGENT_ID = "toolu_audit"
const SHELL_ID = "toolu_vite"
// A fixed timeline so the elapsed readings are stable across runs; ending "now" so the thread reads live.
const T0 = Date.now() - 40 * 60_000
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`

const assistant = (id, ts, content, stop = "tool_use") => ({
  parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: ts, session_id: SESSION, cwd,
  message: { model: "claude-opus-5", id, type: "message", role: "assistant", stop_reason: stop, content, usage: { input_tokens: 2, output_tokens: 60 } },
})
const toolResult = (toolUseId, text, ts) => ({
  parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: ts, session_id: SESSION, cwd,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] },
})
const notification = (toolUseId, status, summary, ts) => ({
  type: "queue-operation", operation: "remove", uuid: uuid(), timestamp: ts, session_id: SESSION, cwd,
  content: `<task-notification>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
})

const records = [
  {
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(0), session_id: SESSION, cwd,
    message: { role: "user", content: "TASK:\nRefactor the pricing parser and verify it end-to-end." },
  },
  assistant("msg_lead", at(1), [{ type: "text", text: "Dispatching an audit sub-agent, then reading the tier table myself." }], "end_turn"),
  // The sub-agent dispatch, plus the launch ACK that tells the tailer this child is detached.
  assistant("msg_dispatch", at(2), [{
    type: "tool_use", name: "Agent", id: AGENT_ID,
    input: { description: "Audit the pricing parser for edge cases", prompt: "Audit the pricing parser for edge cases.\nReport every tier boundary that rounds the wrong way.", run_in_background: true, subagent_type: "frizz:opus-high" },
  }]),
  toolResult(AGENT_ID, `Async agent launched successfully with ID: ${AGENT_ID}`, at(2)),
  // A run of ORDINARY tool cards — the "big sea of tool call blocks" the divider has to stand out from.
  assistant("msg_tools", at(3), [
    { type: "tool_use", name: "Read", id: "t1", input: { file_path: `${cwd}/README.md` } },
    { type: "tool_use", name: "Grep", id: "t2", input: { pattern: "roundHalfEven", path: `${cwd}/packages` } },
    { type: "tool_use", name: "Bash", id: "t3", input: { command: "pnpm test pricing", description: "Run the pricing suite" } },
  ]),
  toolResult("t1", "# frizz", at(3)),
  toolResult("t2", "no matches", at(3)),
  toolResult("t3", "3 passed", at(4)),
  // A BACKGROUND shell + its ack, so its own wake divider lands later in the same timeline.
  assistant("msg_shell", at(5), [{
    type: "tool_use", name: "Bash", id: SHELL_ID,
    input: { command: "pnpm --filter web dev --host", description: "Start vite from web package dir", run_in_background: true },
  }]),
  toolResult(SHELL_ID, "Command running in background", at(5)),
  // THE SUB-AGENT COMPLETION — the marker the client draws as a wake divider.
  notification(AGENT_ID, "completed", "Sub-agent finished", at(37)),
  assistant("msg_after_agent", at(38), [{ type: "text", text: "The audit came back with three off-by-one-cent boundaries; folding the fix in now." }], "end_turn"),
  // THE SHELL COMPLETION — the divider the agent one converged onto.
  notification(SHELL_ID, "failed", 'Background command "Start vite from web package dir" failed with exit code 143', at(39)),
  assistant("msg_after_shell", at(39), [{ type: "text", text: "That was the dev server I killed (143 = SIGTERM). Work is done and verified." }], "end_turn"),
]

writeFileSync(join(jsonlDir, `${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${SLUG}', '${SESSION}', '${THREAD_NAME}', '${at(0)}', 'Refactor the pricing parser', 'claude', 'opus', 'high', 'default', '${at(39)}')`,
])
console.log(`seeded ${SLUG} → ${SESSION} (one sub-agent completion + one background-shell wake)`)

// ── A second thread whose children are still LIVE ────────────────────────────────────────────────
// This is the surface the child-row changes land on: the rows under the prompt box (BackgroundOpsStrip
// in the drawer, QueueSubAgentLines on the queue card). It needs children that never got a terminal
// notification, so the tailer keeps them in the live set and the board pushes them as rows.
const LIVE_SLUG = "live-children"
const LIVE_SESSION = "11ve-c41d-4ren-8000-000000000002"
const LIVE_THREAD_NAME = `frizz-${LIVE_SLUG}`
const LIVE = [
  { id: "toolu_live1", label: "Sweep every call site of the renamed board projection helper", type: "frizz:opus-xhigh" },
  { id: "toolu_live2", label: "Harvest the fixture inventory", type: "frizz:haiku" },
  { id: "toolu_live3", label: "Explore the resume path", type: "general-purpose" },
]
const liveRecords = [
  {
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(0), session_id: LIVE_SESSION, cwd,
    message: { role: "user", content: "TASK:\nFan the audit out across the board projection." },
  },
  {
    parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: at(1), session_id: LIVE_SESSION, cwd,
    message: {
      model: "claude-opus-5", id: "msg_live_dispatch", type: "message", role: "assistant", stop_reason: "tool_use",
      content: [
        ...LIVE.map((d) => ({ type: "tool_use", name: "Agent", id: d.id, input: { description: d.label, prompt: `${d.label}. Report back.`, run_in_background: true, subagent_type: d.type } })),
        { type: "tool_use", name: "Bash", id: "toolu_live_shell", input: { command: "gh run watch", description: "Watch CI", run_in_background: true } },
      ],
      usage: { input_tokens: 2, output_tokens: 120 },
    },
  },
  ...LIVE.map((d) => toolResult(d.id, `Async agent launched successfully with ID: ${d.id}`, at(1))),
  toolResult("toolu_live_shell", "Command running in background", at(1)),
  {
    parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: at(2), session_id: LIVE_SESSION, cwd,
    message: {
      model: "claude-opus-5", id: "msg_live_rest", type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: "Three sub-agents and a CI watcher are running; I'll fold their findings in when they return." }],
      usage: { input_tokens: 2, output_tokens: 40 },
    },
  },
]
writeFileSync(join(jsonlDir, `${LIVE_SESSION}.jsonl`), liveRecords.map((r) => JSON.stringify(r)).join("\n") + "\n")
execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${LIVE_SLUG}', '${LIVE_SESSION}', '${LIVE_THREAD_NAME}', '${at(0)}', 'Fan the audit out', 'claude', 'opus', 'high', 'default', '${at(2)}')`,
])
console.log(`seeded ${LIVE_SLUG} → ${LIVE_SESSION} (${LIVE.length} live sub-agents + 1 live shell)`)
