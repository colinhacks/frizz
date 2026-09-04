// Seed a disposable adhoc stack with the ONE comparison that decides whether a Markdown image is
// framed correctly: the SAME picture shown twice in a row, once as a Markdown `![](…)` and once as a
// bare absolute path. The two travel completely different render paths — the markdown one is sanitized
// into an HTML string by lib/markdown.ts, the bare path becomes a React <BlockImage> — and they are
// supposed to arrive at the identical frame (components/ImageFrame). Stacked adjacently, any drift
// between the two is a visible seam rather than something you have to measure to notice.
//
// A third image is deliberately MISSING, because the frame has a second correct behavior: when the file
// is gone the whole frame must come down with it (lib/local-file-links.ts), not leave a bordered box
// standing around a line of muted path text.
//
// The images must be real files on disk — /local-image serves real bytes and this is the whole point of
// running it here rather than in a fixture, where an <img> load bypasses the stubbed fetch and every
// picture silently falls back to its path.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
//
// Usage: nub scripts/seed-markdown-image-frame.mjs --home=/abs/temp-home --shot=/abs/real.png [--slug=x]
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, shot, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home || !shot) {
  console.error("usage: nub scripts/seed-markdown-image-frame.mjs --home=/abs/temp-home --shot=/abs/real.png")
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
const slug = flags.slug ?? "markdown-image-frame"
const sessionId = `${slug}-0000-4000-8000-000000000000`.slice(0, 36)
const MISSING = "/tmp/frizz-frame-this-file-does-not-exist.png"

const user = (text) => ({
  parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: now(), session_id: sessionId, cwd,
  message: { role: "user", content: text },
})
const assistant = (text) => ({
  parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: now(), session_id: sessionId, cwd,
  message: {
    model: "claude-opus-5", id: `msg_${uuid()}`, type: "message", role: "assistant",
    content: [{ type: "text", text }], stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 120 },
  },
})

const records = [
  user("TASK:\nShow me the same screenshot both ways so the frames can be compared."),
  // Adjacent on purpose: markdown FIRST, bare path SECOND, nothing between them but one line of prose,
  // so the two frames share an edge and any difference in border, mat or height cap reads immediately.
  assistant([
    "**Both renderings, back to back.** First as Markdown:",
    "",
    `![the drawer footer, written as markdown](${shot})`,
    "",
    "…and immediately below, the identical file as a bare path, which ChatView renders as a BlockImage:",
    "",
    shot,
    "",
    "A markdown image also has to survive being *inside* a sentence's paragraph without splitting it, so",
    `here is one mid-paragraph — ![inline](${shot}) — with prose continuing after it on the same line.`,
  ].join("\n")),
  user("And what happens when the file is gone?"),
  assistant([
    "It falls back to the plain path, and the FRAME comes down with it — no empty bordered box:",
    "",
    `![a screenshot whose file was cleaned up](${MISSING})`,
    "",
    "That is the same fallback `BlockImage` performs for the React-rendered case.",
  ].join("\n")),
]

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived, rested_at)
   VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${now()}', 'Markdown image frames', 0, 'claude', 'opus', 'high', 'default', 'open', 1, 0, 0, '${now()}')`,
])
console.log(`seeded ${slug} → ${sessionId} (markdown + bare-path + inline + missing, shot=${shot})`)
