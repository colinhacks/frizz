// Seed a disposable adhoc stack with SIMULATED workers whose last turn is a DELIVERED pr-watch wake —
// the exact user-turn text the scheduler pastes into a worker's composer, delivery token and all.
//
// This is the browser gate for the review-read tail on the wake steer: the tail speaks to the WORKER,
// and `GithubWakeCard` renders from `parseGithubWakeSteer`'s structured result rather than from the raw
// text, so the tail must be invisible to the human. That claim is only worth anything if the REAL card
// renders the REAL delivered string — hence a JSONL the production tailer reads, not a props fixture.
//
// Usage: nub scripts/seed-review-wake-card.mjs --home=/abs/temp-home
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
  console.error("usage: node seed-review-wake-card.mjs --home=/abs/temp-home")
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
const PR = "https://github.com/nubjs/nub/pull/587"

const CASES = [
  {
    // The reported case, byte for byte: an empty-bodied @pullfrog review. Carries ONE tail line.
    slug: "wake-review",
    title: "wake · one review (tail present)",
    steer: {
      ref: "nubjs/nub#587",
      omitted: 0,
      items: [{ label: "review comment", actor: "pullfrog", bot: true, at: ago(4), url: `${PR}#pullrequestreview-4831999377` }],
    },
  },
  {
    // TWO distinct reviews in one poll ⇒ two tail lines, plus a comment that earns none. The burst is
    // where a leaked tail would be most obvious: the card draws a row per item, and a tail rendered as
    // content would show up as two extra rows.
    slug: "wake-burst",
    title: "wake · burst, two reviews + a comment",
    steer: {
      ref: "nubjs/nub#587",
      omitted: 0,
      items: [
        { label: "comment", actor: "colinhacks", bot: false, at: ago(12), url: `${PR}#issuecomment-5120099362` },
        { label: "review comment", actor: "pullfrog", bot: true, at: ago(8), url: `${PR}#pullrequestreview-4831999377` },
        { label: "approval", actor: "dana", bot: false, at: ago(5), url: `${PR}#pullrequestreview-4810267375` },
      ],
    },
  },
  {
    // CONTROL — an issue comment carries its substance in its own body, so no tail is emitted at all.
    // This card is the "before" picture: whatever the two above render, this must match it exactly.
    slug: "wake-comment",
    title: "wake · one comment (no tail — control)",
    steer: {
      ref: "nubjs/nub#587",
      omitted: 0,
      items: [{ label: "comment", actor: "colinhacks", bot: false, at: ago(4), url: `${PR}#issuecomment-5120099362` }],
    },
  },
  {
    // THE REGRESSION CASE. A steer carrying a tail NO build has ever seen stands in for the real
    // failure: on 2026-07-31 the steer grew the review-read tail above and every already-open tab —
    // whose bundle predated it, because `web/api/boot.ts` adopts a new server boot id in place instead
    // of reloading — fell back to the raw-text card and dumped the agent-facing steer into the chat.
    // The card must render exactly like its control, and the tail must be nowhere on screen.
    slug: "wake-future",
    title: "wake · a tail no build has seen",
    steer: {
      ref: "nubjs/nub#587",
      omitted: 0,
      items: [{ label: "comment", actor: "colinhacks", bot: false, at: ago(4), url: `${PR}#issuecomment-5120099362` }],
    },
    extraTail: "\n\nSOME FUTURE INSTRUCTION this build has never heard of.\nnub run some-future-command --with-flags",
  },
]

CASES.forEach((c, n) => {
  const sessionId = `${c.slug}-0000-4000-8000-000000000000`.slice(0, 36)
  const threadName = `frizz-${c.slug}`
  const at = ago(3)
  const text = `${formatGithubWakeSteer(c.steer)}${c.extraTail ?? ""}\n\n${wakeDeliveryToken(`${c.slug}`.padEnd(64, "0"))}`
  const records = [
    {
      parentUuid: null, isSidechain: false, type: "user",
      message: { role: "user", content: `TASK:\n${c.title}` },
      uuid: `1000000${n}-0000-4000-8000-000000000001`.slice(-36), timestamp: ago(20), session_id: sessionId, cwd,
    },
    {
      parentUuid: null, isSidechain: false, type: "assistant",
      message: {
        model: "claude-opus-5", id: `msg_${c.slug}_a`, type: "message", role: "assistant",
        content: [{ type: "text", text: "Pushed the fix and the regression test. CI came back green, so the branch is ready for review.\n\n```awaiting\npr-watch: nubjs/nub#587\nWatching for review.\n```" }],
        stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 40 },
      },
      uuid: `1000000${n}-0000-4000-8000-000000000002`.slice(-36), timestamp: ago(15), session_id: sessionId, cwd,
    },
    // THE wake, recorded exactly as the scheduler delivers it: an ordinary user turn whose text is the
    // steer plus the machine-facing token.
    {
      parentUuid: null, isSidechain: false, type: "user",
      message: { role: "user", content: text },
      uuid: `1000000${n}-0000-4000-8000-000000000003`.slice(-36), timestamp: at, session_id: sessionId, cwd,
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
