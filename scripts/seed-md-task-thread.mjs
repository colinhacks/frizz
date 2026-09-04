// Seeds ONE real thread that exercises, in the running app rather than in a fixture:
//   • the Obsidian task list inside real assistant prose (`.md-body` in the transcript)
//   • the collapsed `Ran N tool calls` band directly above a reply — the type-scale pair
//   • a RUN of consecutive user messages, then a single one, then one ending in an IMAGE — the three
//     shapes the extra space under the last user message has to get right
//
// Drives the REAL pipeline (JSONL → tailer → transcript projection → ChatView), because the fixture
// proves the renderer and only this proves the transcript reaches it.
//
// Usage: nub scripts/seed-md-task-thread.mjs --port=4948 --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const port = Number(opt("port", "4948"))
const home = opt("home")
const cwd = opt("project", process.cwd())
const shot = opt("image")
if (!home) throw new Error("--home=<stack temp HOME> is required")

const SLUG = "md-task-render"
const SESSION_ID = randomUUID()
const now = new Date().toISOString()

const logDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(logDir, { recursive: true })
const base = { isSidechain: false, userType: "external", cwd, sessionId: SESSION_ID, version: "2.1.220", gitBranch: "main" }
const records = []
let n = 0
const push = (rec) => records.push({ ...base, ...rec, parentUuid: records.length ? records.at(-1).uuid : null, uuid: `0000000${++n}-0000-0000-0000-000000000000`.slice(-36), timestamp: now })
const user = (content) => push({ type: "user", message: { role: "user", content } })
const assistant = (text) => push({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text }] } })
const toolCall = (id, name, input) => push({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id, name, input }] } })
const toolResult = (id, content) => push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } })

const TASKS = `Here is where the sandbox work stands.

- [x] Confine reads on Windows — unconfined is fatal
- [/] Fix the coarse network grant on Linux and Windows
- [ ] Drop per-host on macOS and delete \`$downloads\`
- [-] Ship the restricted-token fallback
- [?] Reconcile the five parallel sandbox branches into \`sandbox/integration\`, then re-run the per-OS jail measurements on each host before the release cut

And the nested shape, where a live child hangs under a finished parent:

- [x] Land the sandbox jail
  - [ ] Re-run the per-OS measurements
- [-] Ship the restricted-token fallback
  - [ ] A live child under a cancelled parent keeps its own styling`

// A RUN of two user messages: only the LAST may take the extra space beneath it.
user("Work through the build-jail defects.")
user("And keep the Windows read posture first.")
assistant("Understood — starting on the Windows read posture.")
// A tool band sitting directly above a reply: the type-scale pair the maintainer photographed.
for (const [i, f] of ["src/resolver.ts", "src/jail.ts"].entries()) {
  toolCall(`t${i}`, "Read", { file_path: `${cwd}/${f}` })
  toolResult(`t${i}`, "…file contents…")
}
assistant("Frizz correction is complete and the sandbox policy is rebuilding.")
user("Show me the list.")
assistant(TASKS)
// A user message whose LAST rendered thing is an image — the extra space belongs under the screenshot.
if (shot && existsSync(shot)) {
  const attachDir = join(cwd, "attachments")
  mkdirSync(attachDir, { recursive: true })
  const dest = join(attachDir, "md-task-seed-shot.png")
  copyFileSync(shot, dest)
  user([{ type: "text", text: "Here is the shot:" }, { type: "text", text: `![the seeded screenshot](${dest})` }])
} else {
  user("Here is the shot:")
}
assistant("Got it — that matches what I measured.")

writeFileSync(join(logDir, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const threadName = `frizz-${SLUG}`
execFileSync("sqlite3", [db, `DELETE FROM session WHERE slug = '${SLUG}';`])
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session
  (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, unread, exited, archived, title_auto, runtime_generation, profile_revision)
  VALUES (${sessionVals}'${SLUG}', '${SESSION_ID}', '${threadName}', '${now}', 'Md task render', 'claude', 'opus', 'high', 'default', 0, 0, 0, 0, 0, 0);`])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/thread/${SLUG}`, slug: SLUG, threadName }))
