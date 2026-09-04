// Seed a disposable adhoc stack with SIMULATED workers whose last message is each card-bearing
// shape — a ```done fence, an ```awaiting fence (timer + pr-watch), and a ```question block — so the
// card chrome can be judged in the REAL app (queue + thread drawer), not only in a fixture page.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer
// reads. Nothing here writes board state directly; the transcript records drive it.
//
// Usage: node scripts/seed-card-gallery.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home) {
  console.error("usage: node seed-card-gallery.mjs --home=/abs/temp-home")
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
    slug: "card-done",
    title: "done fence",
    text: [
      "Landed the resolver fix and its regression test.",
      "",
      "```done",
      "- Fixed the cache collision in `src/resolver.ts` — the lookup now keys on the normalized id.",
      "- Added a regression test for the collision case; `npm test` green.",
      "```",
    ].join("\n"),
  },
  {
    slug: "card-awaiting-pr",
    title: "awaiting fence · pr-watch",
    text: [
      "The branch is pushed and CI came back green.",
      "",
      "```awaiting",
      "pr-watch: acme/app#391",
      "PR is open and CI is green. Watching for review — I'll address comments or merge on approval.",
      "```",
    ].join("\n"),
  },
  {
    slug: "card-awaiting-timer",
    title: "awaiting fence · timer",
    text: [
      "Parking until the external maintainer window opens.",
      "",
      "```awaiting",
      `timer: ${new Date(Date.now() + 3 * 3600_000).toISOString().replace(/\.\d+Z$/, "Z")}`,
      "Re-check whether the external maintainer review arrived and reclassify any new failure.",
      "```",
    ].join("\n"),
  },
  {
    slug: "card-question",
    title: "question block",
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
