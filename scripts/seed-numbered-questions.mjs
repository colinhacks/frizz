// Seed a disposable adhoc stack with SIMULATED workers carrying the two shapes this fix is about, so
// they can be judged in the REAL app rather than a fixture page:
//
//   q-numbered  — a worker that NUMBERED its question lines across a multi-block handoff
//                 ("C. Does `brokerTo` imply net access to the host?"), verbatim from the transcript
//                 that produced the maintainer's screenshot. The question line used to be chipped as
//                 option 0, leaving the card with no question and a duplicated "C." freetext row.
//   q-answered  — an earlier batch (questions numbered 9–11) that the agent then BURIED by continuing
//                 to work, answered afterwards. composeAnswerWire renumbers those rows from 1, so the
//                 answers card printed "1" beside a question reading "9. …".
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
//
// Usage: node scripts/seed-numbered-questions.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home) {
  console.error("usage: node seed-numbered-questions.mjs --home=/abs/temp-home")
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

// Verbatim from ~/.claude/projects/-Users-colinmcd94-Documents-projects-nub/a6dd0278-….jsonl (msg d316760a).
const NUMBERED_ASK = [
  "This is the last round, so let me put the real remaining unclarities on the table.",
  "",
  "```question",
  "C. Does `brokerTo` imply net access to the host?",
  "",
  "- A. No — the host must also be in the `net` allowlist; `brokerTo` only un-masks the marker on requests to an already-allowed host (recommended) — keeps env and net orthogonal, so a secret declaration can never silently punch a network hole; you state both \"this host is reachable\" (net) and \"this secret may un-mask there\" (brokerTo) explicitly.",
  "- B. Yes — listing a `brokerTo` host auto-allows reaching it. Terser (one place), but the env axis now grants network, coupling the two.",
  "```",
  "",
  "## Loopback default (you said \"discussed elsewhere\" — just closing the posture)",
  "",
  "```question",
  "D. Loopback mechanism is settled (write `localhost`, blocked-by-default at the IP layer). The only open bit is the default:",
  "",
  "- A. The default agent-sandbox template pre-includes `localhost` (recommended) — mechanism stays blocked-by-default (build-jail/tight policies never expose local services), but the agent case that actually needs the dev server works out of the box.",
  "- B. Nothing pre-included — every agent config adds `localhost` itself.",
  "```",
  "",
  "Answer these and the grammar is fully specified.",
].join("\n")

// The other real corpus shape: a numbered PLAN above the choices, every line of which was chipped.
const PLAN_ASK = [
  "```question",
  "Now that the no-PR rule is recorded, want me to retire the existing PRs the new way? The plan:",
  "",
  "1. Sync local `main` to GitHub (pull the already-merged #8/#9).",
  "2. Re-land the four real fixes (#5, #6, #7) as direct commits.",
  "3. Close the now-redundant GitHub PRs.",
  "",
  "- A. Yes — do the full plan (recommended: it honors the new rule and doesn't lose the work)",
  "- B. Re-land the fixes, but leave the GitHub PRs for you to close yourself",
  "- C. Just sync local `main`; I'll re-land and close things myself",
  "- D. Hold — don't touch anything yet",
  "```",
].join("\n")

const EARLIER_BATCH = [
  "Here is the next batch of open design calls.",
  "",
  "```question",
  "9. How is host loopback exposed under fine-grained rules?",
  "",
  "- A. Require an explicit `<loopback>` target (recommended) — `*`, `<private>`, `127/8` do NOT reach host-local services unless the config names loopback.",
  "- B. Keep current — `*` or an explicit loopback CIDR reaches host-local services via the proxy.",
  "```",
  "",
  "```question",
  "10. How do policies compose across nested runs and source scopes?",
  "",
  "- A. Monotonic intersection (recommended) — the final child gets only what EVERY active outer sandbox allows.",
  "- B. Inner policy replaces outer.",
  "```",
  "",
  "```question",
  "11. When does global sandbox config automatically constrain a project?",
  "",
  "- A. Only built-in + admin-managed policy are unconditional floors (recommended).",
  "- B. User-global is always an automatic floor — every project = intersection(global, project).",
  "```",
].join("\n")

// What composeAnswerWire emits when the batch answers a BURIED ask: rows renumbered from 1, each row
// quoting its own question — which is where the "1" met the worker's own "9.".
const BURIED_ANSWERS = [
  "Answers to earlier questions:",
  "1. “9. How is host loopback exposed under fine-grained rules?” → A. Require an explicit `<loopback>` target",
  "2. “10. How do policies compose across nested runs and source scopes?” → B. Inner policy replaces outer",
  "3. “11. When does global sandbox config automatically constrain a project?” → A. Only built-in + admin-managed policy are unconditional floors",
].join("\n")

const assistant = (slug, text) => ({
  parentUuid: null,
  isSidechain: false,
  type: "assistant",
  message: {
    model: "claude-opus-5",
    id: `msg_${slug}_${uuidN}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 120 },
  },
  uuid: uuid(),
  timestamp: now(),
  cwd,
})
const user = (text) => ({
  parentUuid: null,
  isSidechain: false,
  type: "user",
  message: { role: "user", content: text },
  uuid: uuid(),
  timestamp: now(),
  cwd,
})

// An answers batch that CANNOT be paired (nothing to look back at) — the fallback layout, where the row
// number is the only pointer a scrolled-up reader has and so must still render.
const UNPAIRED_ANSWERS = ["Answers:", "1. A. SQLite — transactional", "2. B. JSON file — zero deps"].join("\n")

// GROUPED options: the worker sorts its choices under prose headings. The heading used to END the run,
// stranding D–F below the chips as unanswerable prose.
const GROUPED_ASK = [
  "```question",
  "**Package name — brainstorm.** All of these are available on npm. Grouped by the metaphor:",
  "",
  "Thread / loom family (frizz = a frizzed thread):",
  "- A. **frizzloom** — keeps the `frizz` lineage + a loom weaves many threads into one board (recommended: brand continuity)",
  "- B. **warp** — the taut lengthwise loom threads. ⚠️ collides with **Warp.dev**.",
  "- C. **selvage** — the fabric edge that literally *doesn't frizz*.",
  "",
  "Melee family (frizz = a scrap/brawl of agents):",
  "- D. **melee** — a direct synonym for \"frizz\": the scrum of agents.",
  "- E. **fracas** — a noisy, disorderly frizz.",
  "- F. **tussle** — a scrappy, informal frizz.",
  "",
  "Also still open from before: `frizz`, `frizzhq`, `frizzboard`.",
  "```",
].join("\n")

// A worker DOCUMENTING the protocol: the sample is wrapped in a ```` fence, so it must render as a code
// block. It used to be hoisted into a live card, orphaning the ```` delimiters — whose unterminated
// fence then swallowed every word after it.
const T4 = "`".repeat(4)
const QUOTED_ASK = [
  "The grammar is one fenced block per question:",
  "",
  T4,
  "```question",
  "Should the settings store use SQLite or a JSON file?",
  "",
  "- A. SQLite — transactional (recommended)",
  "- B. JSON file — zero deps",
  "```",
  T4,
  "",
  "That trailing sentence must render as ordinary prose, not inside a code block.",
  "",
  "```question",
  "Ready for me to write that into the worker prompt?",
  "",
  "- A. Yes — add it (recommended)",
  "- B. Not yet",
  "```",
].join("\n")

const THREADS = [
  { slug: "q-numbered", title: "Numbered question lines", records: [user("TASK:\nsandbox grammar"), assistant("q-numbered", NUMBERED_ASK)] },
  { slug: "q-two", title: "Two numbered blocks, answered live", records: [user("TASK:\nsandbox grammar"), assistant("q-two", NUMBERED_ASK)] },
  { slug: "q-grouped", title: "Options under group headings", records: [user("TASK:\npackage name"), assistant("q-grouped", GROUPED_ASK)] },
  { slug: "q-quoted", title: "A quoted sample plus a real ask", records: [user("TASK:\ndocument the grammar"), assistant("q-quoted", QUOTED_ASK)] },
  {
    slug: "q-unpaired",
    title: "Answers with no question to pair",
    records: [user(UNPAIRED_ANSWERS), assistant("q-unpaired", "Understood — SQLite for the store, JSON for the export.")],
  },
  { slug: "q-plan", title: "Numbered plan above the choices", records: [user("TASK:\nretire the PRs"), assistant("q-plan", PLAN_ASK)] },
  {
    slug: "q-answered",
    title: "Answers to a buried batch",
    records: [
      user("TASK:\nsandbox grammar, batch 3"),
      assistant("q-answered", EARLIER_BATCH),
      assistant("q-answered", "Recorded Q12→B while waiting. Continuing on the proxy work in the meantime."),
      user(BURIED_ANSWERS),
      assistant("q-answered", "Got them — 9→A, 10→B, 11→A. Folding those into the grammar now."),
    ],
  },
]

for (const t of THREADS) {
  const sessionId = `${t.slug}-0000-4000-8000-000000000000`.slice(0, 36)
  const threadName = `frizz-${t.slug}`
  const records = t.records.map((r) => ({ ...r, session_id: sessionId }))
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
     VALUES (${sessionVals}'${t.slug}', '${sessionId}', '${threadName}', '${now()}', '${t.title}', 'claude', 'opus', 'high', 'default', '${now()}')`,
  ])
  console.log(`seeded ${t.slug} → ${sessionId}`)
}
