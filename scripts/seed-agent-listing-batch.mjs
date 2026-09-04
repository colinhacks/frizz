// Seed a disposable adhoc stack with a SIMULATED codex worker that polls `list_agents` in the MIDDLE of
// an otherwise ordinary tool burst — the shape that made the maintainer's transcript read
// `Ran 1 tool call` / a standalone `Agents · list live agents` card / `Ran 4 tool calls`.
//
// The listing is a roster READ, not a dispatch, so it must fold into the run like Bash/Read/Grep: the
// whole burst is ONE `Ran 6 tool calls` row, and expanding it shows the Agents card in place. Drives the
// real tailer → projection → push → `/thread/<slug>` render, which is the only way to see the run
// splitting (ChatView is not unit-renderable and `*-fixture.html` is not servable through the stack).
//
// Follows the frizz-stack recipe: a session row + a transcript the tailer reads.
// Usage: node scripts/seed-agent-listing-batch.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node seed-agent-listing-batch.mjs --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)

const SLUG = "agent-listing-batch"
const ROLLOUT_ID = "019842aa-0000-4000-9000-00000000a9e5"
const T0 = Date.now() - 12 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()

const ev = (ts, payload) => JSON.stringify({ timestamp: ts, type: "event_msg", payload })
const item = (ts, payload) => JSON.stringify({ timestamp: ts, type: "response_item", payload })

// One shell call and its result, in codex's `function_call` protocol.
const shell = (ts, id, command, output) => [
  item(ts, { type: "function_call", call_id: id, name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", command] }) }),
  item(ts, { type: "function_call_output", call_id: id, output }),
]

const lines = [
  JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { id: ROLLOUT_ID, cwd } }),
  JSON.stringify({ timestamp: at(0), type: "turn_context", payload: { model: "gpt-5-codex", effort: "high", sandbox_policy: { type: "workspace-write" } } }),
  ev(at(0), { type: "user_message", message: "TASK:\nFold the roster poll into the ordinary activity run." }),
  ev(at(0), { type: "task_started" }),
  ...shell(at(1), "c1", "rg -n 'SUB_AGENT_TOOL_NAMES' packages/web/src", "packages/web/src/lib/toolActivity.ts:10:const SUB_AGENT_TOOL_NAMES = new Set(["),
  // The roster poll, mid-burst. This is the record the whole fixture exists for.
  item(at(1), { type: "function_call", call_id: "roster", name: "list_agents", arguments: "{}" }),
  item(at(1), {
    type: "function_call_output",
    call_id: "roster",
    output: JSON.stringify({ agents: [{ agent_status: "running" }, { agent_status: "running" }, { agent_status: { completed: "verified the fold" } }] }),
  }),
  ...shell(at(1), "c2", "rg -n 'isToolActivityException' packages/web/src", "packages/web/src/components/ChatView.tsx:1889:    const exceptional = isToolActivityException(tool)"),
  ...shell(at(2), "c3", "nub --test packages/web/src/lib/toolActivity.test.ts", "ℹ pass 17\nℹ fail 0"),
  ...shell(at(2), "c4", "nub run typecheck", "tsc --noEmit"),
  ...shell(at(2), "c5", "git commit -m 'fix(transcript): the roster poll folds into the run'", "[main 0e0e2f2] fix(transcript): the roster poll folds into the run"),
  ev(at(3), { type: "agent_message", message: "The roster poll no longer splits the burst — the whole run reads as one row.", phase: "final_answer" }),
  ev(at(3), { type: "task_complete", last_agent_message: "The roster poll no longer splits the burst — the whole run reads as one row." }),
]

// The tailer locates a codex rollout by the id pinned on `agent_session_id`, matching the filename
// suffix `-<id>.jsonl` under $CODEX_HOME/sessions (which is <tempHome>/.codex here, since the stack
// moves HOME). The date shard is cosmetic — discovery walks the whole tree.
const shard = join(home, ".codex", "sessions", "2026", "07", "31")
mkdirSync(shard, { recursive: true })
writeFileSync(join(shard, `rollout-2026-07-31T10-00-00-${ROLLOUT_ID}.jsonl`), lines.join("\n") + "\n")

const threadName = `frizz-${SLUG}`
execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, agent_session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${SLUG}', '${ROLLOUT_ID}', '${ROLLOUT_ID}', '${threadName}', '${at(0)}', 'Fold the roster poll into the run', 'codex', 'gpt-5-codex', 'high', 'default', '${at(3)}')`,
])
console.log(`seeded ${SLUG} → ${ROLLOUT_ID}`)
