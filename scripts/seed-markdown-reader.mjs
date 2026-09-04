// Seed a disposable adhoc stack with a thread whose prose links to `.md` FILES ON DISK — the shape the
// built-in Markdown reader exists for. Clicking any of them must open Frizz's own reader drawer instead
// of launching the desktop opener, while a non-Markdown file beside them must still go to the opener.
//
// It also writes a two-document tree under /tmp (a trusted root) whose docs cross-reference each other
// RELATIVELY, which is what proves the reader rebases a document's links against its own directory —
// a repo doc's `./NEIGHBOUR.md` is the common case and has no meaning without a base.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
//
// Usage: node scripts/seed-markdown-reader.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { existsSync, globSync, mkdirSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home) {
  console.error("usage: node seed-markdown-reader.mjs --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// `--projectId` still wins: a stack with more than one registered project needs to say which.
const projectId = flags.projectId ?? sandbox.projectId
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns({ ...sandbox, projectId })
const cwdSlug = cwd.replace(/[/.]/g, "-")
const jsonlDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(jsonlDir, { recursive: true })

const now = () => new Date().toISOString()
let uuidN = 0
const uuid = () => `0000000${(++uuidN).toString().padStart(4, "0")}-0000-4000-8000-000000000000`.slice(-36)

const slug = flags.slug ?? "markdown-reader"
const sessionId = `${slug}-0000-4000-8000-00000000000`.slice(0, 36)

// The document tree the reader browses. /tmp is a trusted root, so these are readable through the same
// gate a repo doc passes.
const docs = "/tmp/frizz-md-reader-demo"
mkdirSync(join(docs, "nested"), { recursive: true })
writeFileSync(join(docs, "guide.md"), [
  "---",
  "title: Reader guide",
  "draft: false",
  "tags:",
  "  - Frizz",
  "  - Markdown",
  "owner:",
  '  name: "Docs team" # nested YAML stays nested',
  "---",
  "",
  "# Reader guide",
  "",
  "This paragraph is HARD-WRAPPED at a column, the way most README files on disk are written,",
  "so it proves the reader renders a file with CommonMark's soft breaks rather than the chat",
  "surface's hard ones. All three of these lines belong to one paragraph and must read as one.",
  "",
  "## Relative links",
  "",
  "- [The nested document](nested/deep.md) — one directory down, written relatively.",
  "- [Explicitly dotted](./nested/deep.md) — the same file, spelled with a leading `./`.",
  "- [A file that is not Markdown](notes.txt) — still goes to the desktop opener.",
  "",
  "| Column | Meaning |",
  "| --- | --- |",
  "| `baseDir` | the directory this file lives in |",
  "| `document` | soft breaks, because this is a file |",
  "",
  "```ts",
  'const html = mdToHtml(markdown, { baseDir: "/tmp/frizz-md-reader-demo", document: true })',
  "```",
].join("\n"))
writeFileSync(join(docs, "notes.txt"), "not markdown\n")
writeFileSync(join(docs, "nested", "deep.md"), [
  "# The nested document",
  "",
  "You reached this by following a relative link, so the base directory resolved.",
  "",
  "- [Back up to the guide](../guide.md) — `..` climbs a directory.",
  "- [An absolute link out to the repo](/Users/colinmcd94/Documents/projects/frizz/AGENTS.md)",
].join("\n"))

const user = (text) => ({
  parentUuid: null,
  isSidechain: false,
  type: "user",
  message: { role: "user", content: text },
  uuid: uuid(),
  timestamp: now(),
  session_id: sessionId,
  cwd,
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
  cwd,
})

const records = [
  user("TASK:\nCheck that a link to a Markdown file opens inside Frizz"),
  assistant([
    "**Fixed** — every link to a `.md` file on disk now opens in Frizz's own reader.",
    "",
    `- [The reader guide](${docs}/guide.md) — an ordinary Markdown link to an absolute path.`,
    `- [The nested document](${docs}/nested/deep.md) — another one, a directory down.`,
    "- [This repo's own AGENTS.md](/Users/colinmcd94/Documents/projects/frizz/AGENTS.md) — a real repo doc.",
    // CONTROL — a non-Markdown local file must still be handed to the desktop opener.
    `- [A plain text file](${docs}/notes.txt) — NOT Markdown, so it still opens externally.`,
    "",
    "The same routing covers a backticked path that resolves on disk: `~/.claude/CLAUDE.md` is a",
    "Markdown file and opens in the reader, while `packages/web/src/lib/markdown.ts` is not and does not.",
  ].join("\n")),
]

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${now()}', 'markdown reader', 'claude', 'opus', 'high', 'default', '${now()}')`,
])
console.log(`seeded ${slug} → ${sessionId} (docs under ${docs})`)
