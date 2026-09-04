// Seed a disposable adhoc stack with a SIMULATED worker that dispatched background sub-agents which
// then dispatched sub-agents OF THEIR OWN — a real three-level chain on disk, in claude's exact layout,
// so nested rendering can be judged in the REAL app rather than in a fixture that hands the store a
// hand-written tree.
//
// The layout is the one claude actually writes (verified against a live nested run, 2026-07-28): the
// thread transcript holds ONLY the depth-1 dispatches, and every descendant of every depth — child,
// grandchild, great-grandchild — drops a sidecar + its own transcript into the SAME FLAT
// `<session-dir>/subagents/` dir, carrying `toolUseId` / `parentAgentId` / `spawnDepth`.
//
//   child       "Review the resolver diff"      toolu_n1 / agent-nA   depth 1
//     grandchild  "Trace the cache key"          toolu_n2 / agent-nB   depth 2  (parent nA)
//       great-gr.   "Diff the two key shapes"    toolu_n3 / agent-nC   depth 3  (parent nB)
//   child       "Sweep every call site"         toolu_n4 / agent-nD   depth 1  (no children)
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer folds.
//
// Usage: node scripts/seed-nested-subagents.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node seed-nested-subagents.mjs --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const SLUG = "nested-subagents"
const SESSION = "9e57ed00-0000-4000-8000-000000000001"
const THREAD_NAME = `frizz-${SLUG}`
const now = () => new Date().toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`

// The DEPTH-1 dispatches — the only ones that appear in the thread's own transcript.
const DISPATCHES = [
  { id: "toolu_n1", agent: "nA", type: "frizz:opus-medium", label: "Review the resolver diff" },
  { id: "toolu_n4", agent: "nD", type: "frizz:sonnet-medium", label: "Sweep every call site of the renamed helper" },
]

// Every descendant of every depth, flat — exactly how claude writes them.
const SIDECARS = [
  { agent: "nA", meta: { agentType: "frizz:opus-medium", description: "Review the resolver diff", toolUseId: "toolu_n1", spawnDepth: 1 } },
  { agent: "nB", meta: { agentType: "frizz:sonnet-medium", description: "Trace the cache key through the resolver", toolUseId: "toolu_n2", parentAgentId: "nA", spawnDepth: 2 } },
  { agent: "nC", meta: { agentType: "frizz:haiku", description: "Diff the two key shapes", toolUseId: "toolu_n3", parentAgentId: "nB", spawnDepth: 3 } },
  { agent: "nD", meta: { agentType: "frizz:sonnet-medium", description: "Sweep every call site of the renamed helper", toolUseId: "toolu_n4", spawnDepth: 1 } },
]

const subagentsDir = join(jsonlDir, SESSION, "subagents")
mkdirSync(subagentsDir, { recursive: true })
for (const s of SIDECARS) {
  writeFileSync(join(subagentsDir, `agent-${s.agent}.meta.json`), JSON.stringify(s.meta))
  // A transcript with a FRESH mtime is what makes the descendant read `running` (the same mtime rule
  // every tracked child uses). Content is irrelevant to liveness; one plausible record keeps it real.
  writeFileSync(
    join(subagentsDir, `agent-${s.agent}.jsonl`),
    JSON.stringify({
      parentUuid: null, isSidechain: true, type: "assistant", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
      message: { model: "claude-opus-5", id: `msg_${s.agent}`, type: "message", role: "assistant", stop_reason: null, content: [{ type: "text", text: `Working on: ${s.meta.description}` }], usage: { input_tokens: 2, output_tokens: 20 } },
    }) + "\n",
  )
}

const records = [
  {
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: { role: "user", content: "TASK:\nFix the cache collision in the resolver and prove it with a test." },
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
  // The launch ACK per dispatch — without it the tailer cannot tell a detached child from a foreground
  // call that already returned (LAUNCH_ACK_RE in tailer.ts). `output_file:` points at the real child
  // transcript so the staleness clock stats something that exists.
  ...DISPATCHES.map((d) => ({
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: {
      role: "user",
      content: [{
        type: "tool_result", tool_use_id: d.id,
        content: `Async agent launched successfully.\nagentId: ${d.agent}\noutput_file: ${join(subagentsDir, `agent-${d.agent}.jsonl`)}`,
      }],
    },
  })),
  {
    parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: {
      model: "claude-opus-5", id: "msg_rest", type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: "Dispatched two sub-agents; the reviewer is fanning out further on its own. I'll fold the findings in when they return." }],
      usage: { input_tokens: 2, output_tokens: 40 },
    },
  },
]

writeFileSync(join(jsonlDir, `${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${SLUG}', '${SESSION}', '${THREAD_NAME}', '${now()}', 'Fix the resolver cache collision', 'claude', 'opus', 'high', 'default', '${now()}')`,
])
console.log(`seeded ${SLUG} → ${SESSION} (${DISPATCHES.length} direct dispatches, ${SIDECARS.length} descendants across 3 depths)`)
