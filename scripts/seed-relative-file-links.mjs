// Seed a disposable adhoc stack with a thread whose prose links a file the way a worker actually
// writes one: RELATIVE to the project (`.frizz/threads/<id>/HANDOFF.md`) and home-anchored
// (`~/.claude/CLAUDE.md`). Neither has a base of its own, and chat prose used to supply none — so both
// stayed relative anchors the browser resolved against the THREAD PAGE, and clicking a handoff link
// navigated to `/project/<slug>/thread/<slug>/.frizz/threads/<id>/HANDOFF.md` and out of Frizz.
//
// The link targets are REAL files under the project and under home, so the click has somewhere to land:
// the point is not that the markup changed but that the reader opens the file the author meant.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
//
// Usage: node scripts/seed-relative-file-links.mjs --home=/abs/temp-home [--project=/abs/dir]
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, project = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home) {
  console.error("usage: node seed-relative-file-links.mjs --home=/abs/temp-home [--project=/abs/dir]")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const cwdSlug = project.replace(/[/.]/g, "-")
const jsonlDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(jsonlDir, { recursive: true })

const now = () => new Date().toISOString()
let uuidN = 0
const uuid = () => `0000000${(++uuidN).toString().padStart(4, "0")}-0000-4000-8000-000000000000`.slice(-36)

const slug = flags.slug ?? "relative-file-links"
const sessionId = `${slug}-0000-4000-8000-0000000000`.slice(0, 36)

// The scratch directory a worker would have written into, inside the PROJECT — so the link below is
// resolvable only if the renderer knows which project the page is showing.
const scratch = ".frizz/threads/seed-relative-file-links"
mkdirSync(join(project, scratch), { recursive: true })
writeFileSync(join(project, scratch, "HANDOFF.md"), [
  "# The handoff the link points at",
  "",
  "If you are reading this INSIDE Frizz's reader drawer, the relative link resolved against the",
  "project directory rather than against the thread page's URL.",
].join("\n"))

// The home-anchored half. `~` is written into the sandbox HOME, which is what the board reports.
writeFileSync(join(home, "NOTES.md"), "# A home-anchored file\n\nReached through `~/NOTES.md`.\n")

const user = (text) => ({
  parentUuid: null,
  isSidechain: false,
  type: "user",
  message: { role: "user", content: text },
  uuid: uuid(),
  timestamp: now(),
  session_id: sessionId,
  cwd: project,
})
const assistant = (text) => ({
  parentUuid: null,
  isSidechain: false,
  type: "assistant",
  message: {
    model: "claude-opus-5",
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 120 },
  },
  uuid: uuid(),
  timestamp: now(),
  session_id: sessionId,
  cwd: project,
})

const records = [
  user("TASK:\nLink your scratch notes the way you would normally write the path"),
  assistant([
    "**Fixed** — the durable account is in the scratch directory.",
    "",
    `- The write-up is in [\`HANDOFF.md\`](${scratch}/HANDOFF.md) — written relative to the project.`,
    "- The house rules are in [`NOTES.md`](~/NOTES.md) — written home-anchored.",
    "",
    `The same path in backticks — \`${scratch}/HANDOFF.md\` — has always resolved, because the server`,
    "resolves an inline-code candidate against the project directory. The link had to agree with it.",
  ].join("\n")),
]

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${now()}', 'relative file links', 'claude', 'opus', 'high', 'default', '${now()}')`,
])
console.log(`seeded ${slug} → ${sessionId} (scratch ${join(project, scratch)})`)
