// Seed a disposable adhoc stack with a SIMULATED worker that dispatched background sub-agents across
// several `subagent_type` shapes, so the model+effort tag on the child rows under a prompt box can be
// judged in the REAL app — driven by the REAL tailer off a real transcript, not by a fixture that hands
// the store a hand-written `subagentType`.
//
// Follows the frizz-stack recipe: a session row + a JSONL the tailer reads.
// Nothing here writes board state directly; the Agent tool_use records drive it.
//
// Usage: node scripts/seed-subagent-profiles.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node seed-subagent-profiles.mjs --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const SLUG = "subagent-profiles"
const SESSION = "5ubagen7-9r0f-4ile-8000-000000000001"
const THREAD_NAME = `frizz-${SLUG}`
const now = () => new Date().toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`

// One dispatch per shape the tag has to survive: a frizz cell with an effort, the older doubled
// namespace, a profile with no effort axis, and a named agent type that carries NO profile (which must
// render no tag at all rather than a guessed one).
const DISPATCHES = [
  { id: "toolu_p1", type: "frizz:opus-xhigh", label: "Audit the resume path for lost wakes" },
  { id: "toolu_p2", type: "frizz:frizz-sonnet-medium", label: "Sweep every call site of the renamed projection helper" },
  { id: "toolu_p3", type: "frizz:haiku", label: "Harvest the fixture inventory" },
  { id: "toolu_p4", type: "general-purpose", label: "Explore how the board signature is derived" },
]

const records = [
  {
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: { role: "user", content: "TASK:\nAudit the resume path and report what you find." },
  },
  {
    parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: {
      model: "claude-opus-5", id: "msg_dispatch", type: "message", role: "assistant", stop_reason: "tool_use",
      content: DISPATCHES.map((d) => ({
        type: "tool_use", name: "Agent", id: d.id,
        input: { description: d.label, prompt: `${d.label}. Report back.`, run_in_background: true, subagent_type: d.type },
      })),
      usage: { input_tokens: 2, output_tokens: 120 },
    },
  },
  // The launch ACK for each dispatch: without it the tailer cannot tell a detached child from a
  // foreground call that already returned (see LAUNCH_ACK_RE in tailer.ts).
  ...DISPATCHES.map((d) => ({
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: d.id, content: `Async agent launched successfully with ID: ${d.id}` }],
    },
  })),
  {
    parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: {
      model: "claude-opus-5", id: "msg_rest", type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: "Dispatched four sub-agents; I'll fold their findings in when they return." }],
      usage: { input_tokens: 2, output_tokens: 40 },
    },
  },
]

writeFileSync(join(jsonlDir, `${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${SLUG}', '${SESSION}', '${THREAD_NAME}', '${now()}', 'Audit the resume path', 'claude', 'opus', 'high', 'default', '${now()}')`,
])
console.log(`seeded ${SLUG} → ${SESSION} (${DISPATCHES.length} background dispatches)`)
