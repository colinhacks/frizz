// Seeds ONE real thread whose prose carries GitHub references that REALLY EXIST, so the hovercard
// path can be driven end to end against live GitHub: JSONL → tailer → transcript projection →
// ChatView → mdToHtml (which stamps `data-gh-ref`) → the batched githubRefPreview RPC → the card.
//
// Distinct from seed-github-autolink.mjs, which seeds every shape the LINKER has to decide about
// using invented numbers. A card needs a reference that resolves, so these are real: a bare `#1` in
// this repo, a cross-repo open issue with a label, a merged PR, a commit, and one number that names
// nothing — the four outcomes a reader can actually get.
//
// Usage: nub scripts/seed-github-hovercards.mjs --port=4931 --home=/abs/temp-home
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

const SLUG = "github-hovercards"
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

const PROSE = `Every reference below resolves against real GitHub, so each one should carry a hovercard.

An OPEN ISSUE in another repo, with a label: nubjs/nub#660. A MERGED pull request written as a bare
number in this project's own repo: #1. Another merged one across repos: nubjs/nub#640. The COMMIT the
maintainer screenshotted: nubjs/nub@92ed4cc.

A number that names nothing is a real outcome too — nubjs/nub#999999 must stay a working link with no
card rather than a broken panel.

A URL the author simply pasted gets the same card, because the handle is read off the destination:
https://github.com/nubjs/nub/issues/660

| what | where |
| --- | --- |
| the report | nubjs/nub#660 |
| the fix | nubjs/nub@92ed4cc |

- [x] Landed nubjs/nub#640
- [ ] Still open: nubjs/nub#660

And the author's literal bytes stay literal, so \`nubjs/nub#660\` gets no anchor and therefore no card.`

user("Show me the references with their hovercards.")
assistant(PROSE)

writeFileSync(join(logDir, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
execFileSync("sqlite3", [db, `DELETE FROM session WHERE slug = '${SLUG}';`])
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session
  (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, unread, exited, archived, title_auto, runtime_generation, profile_revision)
  VALUES (${sessionVals}'${SLUG}', '${SESSION_ID}', 'frizz-${SLUG}', '${now}', 'GitHub hovercards', 'claude', 'opus', 'high', 'default', 0, 0, 0, 0, 0, 0);`])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/thread/${SLUG}`, slug: SLUG }))
