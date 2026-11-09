#!/usr/bin/env node
// Seed an adhoc stack with the shape that hid a worker's sign-off on its queue card (maintainer 2026-11-06:
// "it'll say that 7 rounds have passed … There's clearly one big message that was intended for the user to
// consume, but afterwards, two PR reviews came in"). The card kept the first round and the last, and the
// hand-off sat in the collapsed middle under quiet parks.
//
//   • signoff-buried — the human's ask, a first hand-off, a CI wake that ends in the big hand-off
//                      (`status: needs_input`), then a review wake and a CI wake that each end in a
//                      fence-only quiet park (`status: watching`). The big hand-off must stay on the card,
//                      its awaiting card drawn, while the review round collapses.
//   • signoff-nudged — the same, except the big write-up rests with NO fence, Frizz's sign-off reminder
//                      wakes the worker, and it answers with the fence alone. Both stay.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads. Nothing writes board state
// directly; the transcript records drive it. The last park names a PR no watch was registered for, so the
// board does not honour it and the thread queues.
//
// Usage: nub scripts/seed-signoff-under-quiet-parks.mjs <home> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { SIGNOFF_NUDGE_MESSAGE, wakeDeliveryToken } from "../packages/shared/src/index.ts"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, projectDir] = process.argv.slice(2)
if (!home || !projectDir) throw new Error("usage: seed-signoff-under-quiet-parks.mjs <home> <projectDir>")

const cwdSlug = projectDir.replace(/[/.]/g, "-")
const transcriptDir = path.join(home, ".claude", "projects", cwdSlug)
fs.mkdirSync(transcriptDir, { recursive: true })
const sandbox = resolveSandboxDb(home)
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)

// Minutes back from now, so the rest reads as recent.
const BASE = Date.now() - 90 * 60_000
let clock = 0
const at = () => new Date(BASE + clock++ * 60_000).toISOString()
let ids = 0
const file = (p) => `${projectDir}/${p}`

const human = (s, text) => [{ type: "user", timestamp: at(), sessionId: s, message: { role: "user", content: text } }]
let wakes = 0
const wake = (s, text) => human(s, `${text}\n\n${wakeDeliveryToken(`seed-wake-${wakes++}`)}`)
// Narration with its calls batched after it, each answered, so the round reads as finished work.
const narrate = (s, text, calls) => {
  const id = `m${ids++}`
  const content = [{ type: "text", text }, ...calls.map((c, i) => ({ type: "tool_use", id: `${id}-t${i}`, ...c }))]
  return [
    { type: "assistant", timestamp: at(), sessionId: s, message: { id, model: "claude-opus-5", role: "assistant", stop_reason: "tool_use", content } },
    ...calls.map((_, i) => ({ type: "user", timestamp: at(), sessionId: s, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${id}-t${i}`, content: "ok" }] } })),
  ]
}
// The message the turn RESTED on.
const restOn = (s, text) => [{ type: "assistant", timestamp: at(), sessionId: s, message: { id: `m${ids++}`, model: "claude-opus-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } }]

const read = (p) => ({ name: "Read", input: { file_path: file(p) } })
const edit = (p) => ({ name: "Edit", input: { file_path: file(p), old_string: "await sleep(100)", new_string: "await sleep(2 ** attempt * 100)" } })
const bash = (command, description) => ({ name: "Bash", input: { command, description } })

const fence = (body) => `\`\`\`awaiting\n${body}\n\`\`\``
const QUIET = fence("prs: [acme/app#391]\nstatus: watching\nfor: 180d")
const FIRST = [
  "The upload retry slept a fixed 100ms between tries, so a slow first connection failed all five. acme/app#391 makes it back off; CI is running on it.",
  "",
  fence("prs: [acme/app#391]\nstatus: needs_input\nfor: 180d\ntitle: Backoff fix open as acme/app#391\n---\nThe approach is in the PR description if you want to look before CI finishes."),
].join("\n")
const WRITE_UP = [
  "**Needs you** — the upload retry fix is ready to merge as acme/app#391. CI is green at `0251203e`: 93 checks passed, 31 skipped.",
  "",
  "- **The retry backs off** from 100ms, doubling, capped at five tries (`src/upload.ts`).",
  "- **A regression test** replays the slow-first-connection trace that failed one run in twenty.",
  "- **Nothing else moved**: the public API and the config surface are unchanged.",
].join("\n")
const BIG = `${WRITE_UP}\n\n${fence("prs: [acme/app#391]\nstatus: needs_input\nfor: 180d\ntitle: Upload retry fixed, ready to merge\n---\nThe merge is yours once you have read the diff.")}`

function write(slug, sessionId, title, records) {
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  const spawned = new Date(BASE - 60_000).toISOString()
  const rested = records.at(-1).timestamp
  execFileSync("sqlite3", [
    sandbox.db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived, rested_at)
     VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${spawned}', '${title}', 0, 'claude', 'opus', 'high', 'default', 'open', 0, 0, 0, '${rested}')`,
  ])
  console.log(`seeded ${slug} (${sessionId})`)
}

// The rounds after the hand-off: a review the worker answers, and CI on its push, each parked quietly.
const quietRounds = (s) => [
  ...wake(s, "💬 New review comment on acme/app#391 from mona: \"Rename `attempt` to `tries` to match the config key.\""),
  ...narrate(s, "Renaming it to match the config key.", [edit("src/upload.ts"), bash("git commit -am 'rename attempt to tries' && git push", "Pushing the rename")]),
  ...restOn(s, QUIET),
  ...wake(s, "✅ CI PASSED on acme/app#391 — 93 checks green, 31 skipped."),
  ...restOn(s, QUIET),
]

{
  const s = "5160ff00-0000-4000-8000-000000000001"
  clock = 0
  write("signoff-buried", s, "Upload retry backoff", [
    ...human(s, "The upload retry is flaky. Fix it and open a PR."),
    ...narrate(s, "Reading the upload path and its retry loop.", [read("src/upload.ts"), bash("rg -n 'sleep\\(' src", "Finding the retry sleeps")]),
    ...narrate(s, "Opening the PR with the backoff.", [edit("src/upload.ts"), bash("gh pr create --fill", "Opening the pull request")]),
    ...restOn(s, FIRST),
    ...wake(s, "✅ CI PASSED on acme/app#391 — 93 checks green, 31 skipped."),
    ...narrate(s, "CI is green; checking the trace replay once more.", [bash("nub --test src/upload.test.ts", "Running the upload tests")]),
    ...restOn(s, BIG),
    ...quietRounds(s),
  ])
}

{
  const s = "5160ff00-0000-4000-8000-000000000002"
  clock = 0
  write("signoff-nudged", s, "Upload retry backoff, fence forgotten", [
    ...human(s, "The upload retry is flaky. Fix it and open a PR."),
    ...narrate(s, "Reading the upload path and its retry loop.", [read("src/upload.ts")]),
    ...restOn(s, FIRST),
    ...wake(s, "✅ CI PASSED on acme/app#391 — 93 checks green, 31 skipped."),
    ...narrate(s, "CI is green; checking the trace replay once more.", [bash("nub --test src/upload.test.ts", "Running the upload tests")]),
    ...restOn(s, WRITE_UP),
    ...wake(s, SIGNOFF_NUDGE_MESSAGE),
    ...restOn(s, fence("prs: [acme/app#391]\nstatus: needs_input\nfor: 180d\ntitle: Upload retry fixed, ready to merge\n---\nThe write-up is in the message above.")),
    ...quietRounds(s),
  ])
}
