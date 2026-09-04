// Seed a disposable adhoc stack with SIMULATED workers whose last message carries each ```question
// SHAPE the renderer has to handle after the approval gate was retired (2026-07-26):
//   · a plain two-option question,
//   · a LEGACY ```question approval block (must degrade to the same two-option card, never a lone
//     Approve button and never a parse failure),
//   · a LEGACY ```question approval danger block (degrades to a danger-styled two-option card),
//   · a freetext-only question (no options) — the box that has to take newlines.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
// Nothing writes board state directly; the transcript records drive it.
//
// Usage: node scripts/seed-question-cards.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home) {
  console.error("usage: node seed-question-cards.mjs --home=/abs/temp-home")
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

const CARDS = [
  {
    slug: "q-plain",
    title: "plain question",
    text: [
      "The store is scaffolded; one call is yours before I wire persistence.",
      "",
      "```question",
      "Should the settings store use SQLite or a JSON file?",
      "",
      "- A. SQLite — transactional, matches the session registry (recommended: consistency with what exists)",
      "- B. JSON file — zero deps, human-editable, racy under concurrent writes",
      "```",
    ].join("\n"),
  },
  {
    slug: "q-legacy-approval",
    title: "legacy approval gate",
    text: [
      "The CONTRIBUTING.md draft is above and ready to write.",
      "",
      "```question approval",
      "Ready to create CONTRIBUTING.md with the draft above?",
      "",
      "- A. Approve as-is",
      "- B. Approve with edits — tell me what to change",
      "```",
    ].join("\n"),
  },
  {
    slug: "q-legacy-danger",
    title: "legacy approval danger gate",
    text: [
      "CI is red on the known-flaky timeout only.",
      "",
      "```question approval danger",
      "Force-merge PR #391 over the failing flaky check and delete the `legacy-api` branch?",
      "",
      "- A. Do it — the failure is the known-flaky timeout",
      "- B. Hold — I'll wait for a green run",
      "```",
    ].join("\n"),
  },
  {
    slug: "q-freetext",
    title: "freetext question",
    text: [
      "The migration notes need your wording before I commit them.",
      "",
      "```question",
      "What should the release note say about the retired approval gate?",
      "```",
    ].join("\n"),
  },
]

for (const card of CARDS) {
  const sessionId = `${card.slug}-0000-4000-8000-000000000000`.slice(0, 36)
  const threadName = `frizz-${card.slug}`
  const records = [
    {
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: `TASK:\n${card.title}` },
      uuid: uuid(),
      timestamp: now(),
      session_id: sessionId,
      cwd,
    },
    {
      parentUuid: null,
      isSidechain: false,
      type: "assistant",
      message: {
        model: "claude-opus-5",
        id: `msg_${card.slug}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: card.text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 120 },
      },
      uuid: uuid(),
      timestamp: now(),
      session_id: sessionId,
      cwd,
    },
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

  // A live pane so the thread reads as a real resting session rather than an exited one.
  try {
  } catch {
    /* already exists */
  }

  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
     VALUES (${sessionVals}'${card.slug}', '${sessionId}', '${threadName}', '${now()}', '${card.title}', 'claude', 'opus', 'high', 'default', '${now()}')`,
  ])
  console.log(`seeded ${card.slug} → ${sessionId}`)
}
