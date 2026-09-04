// Seed a disposable adhoc stack with the exact shape that pinned the thread view at frame-rate churn
// (2026-08-01): an assistant turn whose prose carries a markdown screenshot WHOSE FILE IS GONE, followed
// by a ```question multi fence. The dead image is the engine — it re-404s on every DOM rebuild, flipping
// the virtualized row's height and re-rendering the transcript, which rebuilds the markup again.
//
// Enough filler turns are seeded ahead of it that the transcript is genuinely virtualized, so the row
// measurement feedback path is the real one and not an artifact of a two-message thread.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
//
// Usage: node scripts/seed-broken-image-question.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home) {
  console.error("usage: node seed-broken-image-question.mjs --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const cwdSlug = cwd.replace(/[/.]/g, "-")
const jsonlDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(jsonlDir, { recursive: true })

const now = () => new Date().toISOString()
let uuidN = 0
const uuid = () => `0000000${(++uuidN).toString().padStart(4, "0")}-0000-4000-8000-000000000000`.slice(-36)

// `--slug` lets a re-seed land in a FRESH thread: the tailer tracks byte offsets, so overwriting an
// already-tailed JSONL in place leaves the projection stuck on the old content.
const slug = flags.slug ?? "broken-image-flash"
const sessionId = `${slug}-0000-4000-8000-000000000000`.slice(0, 36)
const threadName = `frizz-${slug}`

// The path is deliberately absent from disk: /local-image resolves it, fails realpath, and 404s.
const MISSING = "/tmp/frizz-does-not-exist-1785612974807.png"
// A screenshot that IS on disk — the control that proves a working image still paints.
const PRESENT = "/tmp/frizz-working-shot.png"
// A bare path line: ChatView's splitProseAttachments turns this into a React BlockImage, not markdown.
const MISSING_BLOCK = "/tmp/frizz-block-image-does-not-exist.png"

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

const records = [user("TASK:\nRewrite the README with UI-focused content")]
// Filler so the transcript is tall enough to virtualize (the loop rides the row measurement path).
for (let i = 0; i < 14; i++) {
  records.push(assistant([
    `Step ${i + 1} — walked \`packages/web/src/components/ChatView.tsx\` and the surrounding prose surfaces.`,
    "",
    "The projection is unchanged; the notes below are the parts that matter for the next pass, kept long",
    "enough that each turn occupies a real row rather than a single line, so the virtualizer has to",
    "measure something. Nothing here re-renders on its own.",
  ].join("\n")))
  records.push(user(`Keep going (${i + 1})`))
}

records.push(assistant([
  "**Fixed** — GitHub picker screenshot landed, `FRIZZ.md` demoted, `584a159` on `main`.",
  "",
  `![The GitHub picker listing real zod issues with three selected](${MISSING})`,
  "",
  "The picker shot is real: I pointed a throwaway repo at `colinhacks/zod`, so it's showing genuine",
  "issues with numbers, authors and reaction counts, three selected, dispatch enabled.",
  "",
  // CONTROL 1 — a markdown image whose file EXISTS must still render as a picture.
  `![A screenshot that is actually on disk](${PRESENT})`,
  "",
  // CONTROL 2 — a bare path line becomes a React-rendered BlockImage, which owns its own onError
  // fallback. The delegated handler must leave it alone.
  MISSING_BLOCK,
  "",
  "```question multi",
  "Which follow-ups should I take in the same pass?",
  "",
  "- A. Reserve the image box so a slow screenshot never reflows the message (recommended: it is the visible defect)",
  "- B. Cache the 404 so a missing screenshot is not re-requested",
  "- C. Show the alt text beside the fallback path",
  "- D. Nothing — land it as is",
  "```",
].join("\n")))

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

try {
} catch {
  /* already exists */
}

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${slug}', '${sessionId}', '${threadName}', '${now()}', 'broken image + multi question', 'claude', 'opus', 'high', 'default', '${now()}')`,
])
console.log(`seeded ${slug} → ${sessionId} (missing image ${MISSING})`)
