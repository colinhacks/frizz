// Seeds ONE real thread whose prose carries every shape the GitHub-style autolinker has to decide
// about — issue numbers, cross-repo references, commit hashes, and the near-misses that must stay
// plain (a hex colour, a UUID, an all-digit run, a hash inside a code span).
//
// It drives the REAL pipeline (JSONL → tailer → transcript projection → ChatView → mdToHtml), which is
// the only thing that proves the repo reaches the renderer: the board carries `githubRepo`, store.ts
// hands it to lib/githubAutolink.ts, and the linker is off until it does. A fixture would render the
// markdown and prove none of that.
//
// Usage: nub scripts/seed-github-autolink.mjs --port=4931 --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const port = Number(opt("port", "4931"))
const home = opt("home")
const cwd = opt("project", process.cwd())
if (!home) throw new Error("--home=<stack temp HOME> is required")

const SLUG = "github-autolink"
const SESSION_ID = randomUUID()
const now = new Date().toISOString()

const logDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(logDir, { recursive: true })
const base = { isSidechain: false, userType: "external", cwd, sessionId: SESSION_ID, version: "2.1.220", gitBranch: "main" }
const records = []
let n = 0
const push = (rec) => records.push({ ...base, ...rec, parentUuid: records.length ? records.at(-1).uuid : null, uuid: `0000000${++n}-0000-0000-0000-000000000000`.slice(-36), timestamp: now })
const user = (text) => push({ type: "user", message: { role: "user", content: text } })
const assistant = (text) => push({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text }] } })

const LINKED = `Everything below should be a link to github.com.

Closed #123 and #4207 in one pass, then picked up nubjs/nub#587 from the other repo. The fix landed as
749a37b, its follow-up as 2acb94a1, and the revert is nubjs/nub@fe2a46c. A full hash reads
2acb94a1b0c3d4e5f60718293a4b5c6d7e8f9012 and should link just the same.

| what | where |
| --- | --- |
| the bug | #123 |
| the fix | 749a37b |

- [x] Shipped #123 via 981a6dc
- [ ] Still open: nubjs/nub#587`

const PLAIN = `And every one of these must stay PLAIN TEXT — no link at all.

The panel background is #0d0e10 over #fff, with #000000 for the rule. This thread's id is
da3513c7-634b-489d-8cf5-f27a7ac7aa70. The build wrote 1234567 bytes on 20260813, and the wall was
defaced. A sha256 digest is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.

A hash inside code is the author's bytes: \`749a37b\` and \`#123\`, and so is a fenced block:

\`\`\`
git show 749a37b   # closes #123
\`\`\`

A reference inside link text must not nest an anchor: [see #12](https://example.com/x). A URL the
author already wrote stays one link: https://github.com/colinhacks/frizz/commit/749a37b`

user("Show me both halves of the autolinker.")
assistant(`${LINKED}\n\n${PLAIN}`)

writeFileSync(join(logDir, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
execFileSync("sqlite3", [db, `DELETE FROM session WHERE slug = '${SLUG}';`])
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session
  (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, unread, exited, archived, title_auto, runtime_generation, profile_revision)
  VALUES (${sessionVals}'${SLUG}', '${SESSION_ID}', 'frizz-${SLUG}', '${now}', 'GitHub refs', 'claude', 'opus', 'high', 'default', 0, 0, 0, 0, 0, 0);`])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/thread/${SLUG}`, slug: SLUG }))
