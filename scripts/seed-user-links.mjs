// Seeds ONE real thread whose USER messages carry the shapes lib/plainLinks.ts has to decide about —
// a pasted URL (the shape that used to render inert in the bubble), trailing punctuation, a wrapped
// URL, a www domain, the GitHub shorthand (`#123`, a hash), and an answers-card reply holding a URL.
//
// It drives the REAL pipeline (JSONL → tailer → transcript projection → ChatView → LinkifiedText),
// which is what proves the repo reaches the plain-text linkifier the same way it reaches mdToHtml:
// the board carries `githubRepo`, store.ts hands it to lib/githubAutolink.ts, and the shorthand is
// off until it does.
//
// Usage: nub scripts/seed-user-links.mjs --port=49411 --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const port = Number(opt("port", "49411"))
const home = opt("home")
const cwd = opt("project", process.cwd())
if (!home) throw new Error("--home=<stack temp HOME> is required")

const SLUG = "user-links"
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

// The reported shape verbatim (2026-08-24 screenshot): a bare pasted URL on its own line.
user(`We've already closed this, or at least the linked issue is already closed...
https://github.com/colinhacks/zod/pull/6013

Why don't we look for other PRs like this that close issues that close already-closed issues..`)
assistant("Looking at #6013 now.")

// Every other decision the plain-text linkifier makes, in one bubble.
user(`More link shapes: trailing punctuation https://example.com/a, a wrapped one (https://example.com/b) and www.example.com too.
Shorthand still works in MY messages: #123, 749a37b, nubjs/nub#587.
But these stay plain: #0d0e10, da3513c7-634b-489d-8cf5-f27a7ac7aa70, 20260813, the https:// prefix alone.`)
assistant("Every underlined run above should open in a new tab; the last line should hold no links.")

// An answers-card reply (the OTHER user-text surface) carrying a URL in a freeform answer.
assistant("```question\nWhere should the docs link point?\n\n- A. https://example.com/docs\n- B. Somewhere else\n```")
user("Answers:\n1. A — use https://example.com/docs, it already covers this.")

writeFileSync(join(logDir, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
execFileSync("sqlite3", [db, `DELETE FROM session WHERE slug = '${SLUG}';`])
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session
  (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, unread, exited, archived, title_auto, runtime_generation, profile_revision)
  VALUES (${sessionVals}'${SLUG}', '${SESSION_ID}', 'frizz-${SLUG}', '${now}', 'User links', 'claude', 'opus', 'high', 'default', 0, 0, 0, 0, 0, 0);`])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/thread/${SLUG}`, slug: SLUG }))
