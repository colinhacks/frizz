// Seed a disposable adhoc stack with ONE resting thread that owns BOTH kinds of child op at once —
// a live background sub-agent AND two auto-backgrounded shells — so the queue card's ⤷ column can be
// judged in the REAL app instead of in queue-ops-spacing-fixture (which hands the store a hand-written
// board and, having no app font loaded, renders the rows in a fallback monospace).
//
// That column is TWO components stacked: QueueSubAgentLines (the agent rows) then BackgroundOpsStrip
// (the shell rows). This is the only state where their shared rhythm is visible, and it is the state
// the maintainer screenshotted on 2026-07-30 when the agent→shell gap read as a group break.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer folds.
//
// Usage: node scripts/seed-queue-ops-column.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node seed-queue-ops-column.mjs --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const SLUG = "queue-ops-column"
const SESSION = "7c0110ff-0000-4000-8000-000000000001"
const THREAD_NAME = `frizz-${SLUG}`
const now = () => new Date().toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`

const AGENT = { id: "toolu_qoc_agent", agent: "qocA", type: "frizz:opus-xhigh", label: "Verify catalog override end-to-end" }
const SHELLS = [
  { id: "toolu_qoc_sh1", op: "bgqoc001", label: "Restart the census sweep" },
  { id: "toolu_qoc_sh2", op: "bgqoc002", label: "Re-run remote test after reverting the catalog promotion" },
]

// The sub-agent's sidecar + transcript, in claude's flat `<session-dir>/subagents/` layout. A FRESH
// mtime is what makes the child read `running`.
const subagentsDir = join(jsonlDir, SESSION, "subagents")
mkdirSync(subagentsDir, { recursive: true })
writeFileSync(
  join(subagentsDir, `agent-${AGENT.agent}.meta.json`),
  JSON.stringify({ agentType: AGENT.type, description: AGENT.label, toolUseId: AGENT.id, spawnDepth: 1 }),
)
writeFileSync(
  join(subagentsDir, `agent-${AGENT.agent}.jsonl`),
  JSON.stringify({
    parentUuid: null, isSidechain: true, type: "assistant", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: { model: "claude-opus-5", id: `msg_${AGENT.agent}`, type: "message", role: "assistant", stop_reason: null, content: [{ type: "text", text: `Working on: ${AGENT.label}` }], usage: { input_tokens: 2, output_tokens: 20 } },
  }) + "\n",
)

const tasksDir = join(home, "tasks")
mkdirSync(tasksDir, { recursive: true })
for (const s of SHELLS) writeFileSync(join(tasksDir, `${s.op}.output`), "working…\n")

// The harness's own auto-background ack, verbatim in shape — LAUNCH_ACK_RE in tailer.ts is what turns a
// timed-out foreground Bash into a TRACKED background op, so the wording has to match.
const autoBg = (s) =>
  `Command did not complete within its 590s timeout and was moved to the background (ID: ${s.op}). ` +
  `Output is being written to: ${join(tasksDir, `${s.op}.output`)}. ` +
  "You will be notified when it completes. To check interim output, use Read on that file path."

const records = [
  {
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: { role: "user", content: "TASK:\nPromote the new catalog and keep the census sweep alive while it lands." },
  },
  {
    parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: {
      model: "claude-opus-5", id: "msg_qoc_dispatch", type: "message", role: "assistant", stop_reason: "tool_use",
      content: [
        { type: "tool_use", name: "Agent", id: AGENT.id, input: { description: AGENT.label, prompt: `${AGENT.label}. Report back.`, run_in_background: true, subagent_type: AGENT.type } },
        ...SHELLS.map((s) => ({ type: "tool_use", name: "Bash", id: s.id, input: { command: `# ${s.label}\nsleep 7200`, description: s.label, timeout: 590000 } })),
      ],
      usage: { input_tokens: 2, output_tokens: 160 },
    },
  },
  {
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: AGENT.id, content: `Async agent launched successfully.\nagentId: ${AGENT.agent}\noutput_file: ${join(subagentsDir, `agent-${AGENT.agent}.jsonl`)}` },
        ...SHELLS.map((s) => ({ type: "tool_result", tool_use_id: s.id, content: autoBg(s) })),
      ],
    },
  },
  {
    parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: {
      model: "claude-opus-5", id: "msg_qoc_rest", type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: "The catalog is promoted. One sub-agent is still verifying it end to end and two shells are holding the sweep open — I'll fold their results in when they land." }],
      usage: { input_tokens: 2, output_tokens: 48 },
    },
  },
]

writeFileSync(join(jsonlDir, `${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived, rested_at)
   VALUES (${sessionVals}'${SLUG}', '${SESSION}', '${THREAD_NAME}', '${now()}', 'Promote the catalog', 0, 'claude', 'opus', 'xhigh', 'default', 'open', 0, 0, 0, '${now()}')`,
])
console.log(`seeded ${SLUG} → ${SESSION} (1 sub-agent + ${SHELLS.length} background shells)`)
