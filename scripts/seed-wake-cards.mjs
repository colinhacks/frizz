// Seed a disposable adhoc stack with SIMULATED workers whose last turn is each WAKE-DELIVERY shape,
// so the first-party wake card can be judged in the REAL app across all its branches — not just the
// burst shape a live poll happens to produce.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
// The delivered text is composed by the SAME shared formatter the scheduler uses, and carries the real
// wake-delivery token, so these exercise the production render path rather than a hand-written string.
//
// Usage: node scripts/seed-wake-cards.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { formatGithubWakeSteer, wakeDeliveryToken } from "../packages/shared/src/index.ts"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home) {
  console.error("usage: node seed-wake-cards.mjs --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const ago = (mins) => new Date(Date.now() - mins * 60_000).toISOString().replace(/\.\d+Z$/, "Z")
const token = (n) => wakeDeliveryToken(String(n).repeat(64).slice(0, 64))

const CASES = [
  {
    slug: "wake-single",
    title: "wake · one comment",
    steer: formatGithubWakeSteer({
      ref: "nubjs/nub#587",
      omitted: 0,
      items: [{ label: "comment", actor: "colinhacks", bot: false, at: ago(4), url: "https://github.com/nubjs/nub/pull/587#issuecomment-5120099362" }],
    }),
  },
  {
    // The commonest wake of all: a review app, whose login carries its own `[bot]` suffix. The single
    // card must say the whole event on one line — "New review comment from @pullfrog[bot]".
    slug: "wake-bot",
    title: "wake · one bot review comment",
    steer: formatGithubWakeSteer({
      ref: "nubjs/nub#587",
      omitted: 0,
      items: [{ label: "review comment", actor: "pullfrog[bot]", bot: true, at: ago(11), url: "https://github.com/nubjs/nub/pull/587#discussion_r2411100933" }],
    }),
  },
  {
    slug: "wake-approval",
    title: "wake · an approval, no permalink",
    steer: formatGithubWakeSteer({
      ref: "acme/app#391",
      omitted: 0,
      // No url: a GitHub shape surprise must degrade the row, never break the card.
      items: [{ label: "approval", actor: "dana", bot: false, at: ago(90) }],
    }),
  },
  {
    slug: "wake-capped",
    title: "wake · a burst past the cap",
    steer: formatGithubWakeSteer({
      ref: "acme/app#391",
      omitted: 7,
      items: Array.from({ length: 10 }, (_, i) => ({
        label: i % 3 === 0 ? "review comment" : "comment",
        actor: i % 3 === 0 ? "coderabbitai[bot]" : `contributor-${i}`,
        bot: i % 3 === 0,
        at: ago(200 - i * 3),
        url: `https://github.com/acme/app/pull/391#issuecomment-${i}`,
      })),
    }),
  },
  {
    // NOT a GitHub steer — a limit auto-resume. The parser refuses it, and the card must still wear
    // first-party chrome rather than falling back to the human's own bubble.
    slug: "wake-limit",
    title: "wake · a non-GitHub steer",
    steer: "⏳ The session usage limit that interrupted you has reset. Continue exactly where you left off.",
  },
]

CASES.forEach((c, n) => {
  const sessionId = `${c.slug}-0000-4000-8000-000000000000`.slice(0, 36)
  const threadName = `frizz-${c.slug}`
  const at = ago(3)
  const records = [
    {
      parentUuid: null, isSidechain: false, type: "user",
      message: { role: "user", content: `TASK:\n${c.title}` },
      uuid: `0000000${n}-0000-4000-8000-000000000001`.slice(-36), timestamp: ago(10), session_id: sessionId, cwd,
    },
    {
      parentUuid: null, isSidechain: false, type: "assistant",
      message: {
        model: "claude-opus-5", id: `msg_${c.slug}`, type: "message", role: "assistant",
        content: [{ type: "text", text: "Pushed the branch and CI is green.\n\n```awaiting\npr-watch: nubjs/nub#587\nWatching for review.\n```" }],
        stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 40 },
      },
      uuid: `0000000${n}-0000-4000-8000-000000000002`.slice(-36), timestamp: ago(5), session_id: sessionId, cwd,
    },
    {
      // The delivered wake, recorded exactly as a real worker's transcript records it: the steer plus
      // the machine-facing token the outbox acks on.
      parentUuid: null, isSidechain: false, type: "user",
      message: { role: "user", content: `${c.steer}\n\n${token(n + 1)}` },
      uuid: `0000000${n}-0000-4000-8000-000000000003`.slice(-36), timestamp: at, session_id: sessionId, cwd,
    },
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

  try {
  } catch {
    /* already exists */
  }
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
     VALUES (${sessionVals}'${c.slug}', '${sessionId}', '${threadName}', '${at}', '${c.title}', 'claude', 'opus', 'high', 'default', '${at}')`,
  ])
  console.log(`seeded ${c.slug}`)
})
