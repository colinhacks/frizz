// Seed a SIMULATED three-level fan-out into an adhoc stack's sandbox, so the sub-agent drawer can be
// driven in a real browser without a live provider.
//
// The layout is claude's own, copied from packages/server/src/tailer.descendants.test.ts (itself shaped
// from a real broker run): the ROOT session's JSONL dispatches ONE direct child, and every descendant
// of every depth writes into that session's FLAT `subagents/` dir beside an `agent-<id>.meta.json`
// sidecar naming its dispatch tool_use id and its parent.
//
// Usage: nub scripts/seed-subagent-fanout.mjs <tempHome> <unused> [slug]
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, _socket, slug = "fanout"] = process.argv.slice(2)
if (!home) throw new Error("usage: seed-subagent-fanout.mjs <tempHome> <unused> [slug]")

const SESSION = "11111111-2222-3333-4444-555555555555"
const at = new Date(Date.now() - 22 * 60_000).toISOString()

const assistant = (content) => JSON.stringify({ type: "assistant", timestamp: at, message: { id: `m${Math.random()}`, stop_reason: "end_turn", content } })
const user = (text) => JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } })

// The project the adhoc stack registered — its cwdSlug names the session-log dir.
const projectsRoot = join(home, ".claude", "projects")
mkdirSync(projectsRoot, { recursive: true })
const cwdSlug = readdirSync(projectsRoot)[0] ?? "-Users-colinmcd94-Documents-projects-frizz"
const logDir = join(projectsRoot, cwdSlug)
const subagents = join(logDir, SESSION, "subagents")
mkdirSync(subagents, { recursive: true })

// THE THREAD's transcript: one direct child, dispatched in the background. The grandchild's dispatch is
// deliberately NOT in here — it lives in the child's own transcript, which is the whole point.
writeFileSync(join(logDir, `${SESSION}.jsonl`), [
  user("Review the resolver change end to end."),
  assistant([
    { type: "text", text: "Now the existing action unit tests, and a behavioral spot-check of the resolver." },
    { type: "tool_use", id: "toolu_child", name: "Agent", input: { description: "Fresh-context review of effort diff", subagent_type: "frizz:opus-high", prompt: "Review the diff.", run_in_background: true } },
  ]),
  // The LAUNCH ACK. Without it the tailer never learns the child's agentId, so it resolves no output
  // file and the drawer opens on an empty transcript — which is what this fixture kept doing until the
  // ack was added (tailer.ts launchOutputFile / launchTaskId parse exactly these two fields).
  JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_child", content: "Async agent launched successfully. agentId: aChild" }] } }),
].join("\n") + "\n")

const sidecar = (agentId, body) => writeFileSync(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify(body))
const transcript = (agentId, lines) => writeFileSync(join(subagents, `agent-${agentId}.jsonl`), `${lines.join("\n")}\n`)

// Depth 1 — the child the drawer opens on. It dispatched TWO of its own and left a background shell
// running, which is exactly the state the drawer showed as empty before this fix.
sidecar("aChild", { agentType: "frizz:opus-high", description: "Fresh-context review of effort diff", toolUseId: "toolu_child", spawnDepth: 1 })
transcript("aChild", [
  assistant([{ type: "text", text: "Splitting the review across the two risky subsystems." }]),
  assistant([
    { type: "tool_use", id: "toolu_grand_a", name: "Agent", input: { description: "Audit the resolver cache keys", subagent_type: "frizz:sonnet-medium", prompt: "…", run_in_background: true } },
    { type: "tool_use", id: "toolu_grand_b", name: "Agent", input: { description: "Check the migration path", subagent_type: "frizz:sonnet-medium", prompt: "…", run_in_background: true } },
  ]),
  assistant([
    { type: "tool_use", id: "toolu_shell", name: "Bash", input: { command: "npm run test:watch -- resolver", description: "Watching the resolver suite", run_in_background: true } },
  ]),
])

// Depth 2 — one of the two grandchildren has fanned out again, so the drawer's strip has a real
// third level to indent.
sidecar("aGrandA", { agentType: "frizz:sonnet-medium", description: "Audit the resolver cache keys", toolUseId: "toolu_grand_a", parentAgentId: "aChild", spawnDepth: 2 })
transcript("aGrandA", [assistant([{ type: "tool_use", id: "toolu_great", name: "Agent", input: { description: "Trace one cache collision", run_in_background: true } }])])

sidecar("aGrandB", { agentType: "frizz:sonnet-medium", description: "Check the migration path", toolUseId: "toolu_grand_b", parentAgentId: "aChild", spawnDepth: 2 })
transcript("aGrandB", [assistant([{ type: "text", text: "Reading the migration." }])])

// Depth 3 — a great-grandchild, to prove the indent keeps stepping.
sidecar("aGreat", { agentType: "general-purpose", description: "Trace one cache collision", toolUseId: "toolu_great", parentAgentId: "aGrandA", spawnDepth: 3 })
transcript("aGreat", [assistant([{ type: "text", text: "Still tracing." }])])

const sandbox = resolveSandboxDb(home)
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const db = sandbox.db
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, state, unread, exited, archived, claude_runtime)
  VALUES (${sessionVals}'${slug}', '${SESSION}', 'frizz-${slug}', '${at}', 'Review the resolver change', 0, 'claude', 'open', 0, 0, 0, 'broker')`])

console.log(JSON.stringify({ slug, session: SESSION, logDir, db }))
