#!/usr/bin/env node
// Seed an adhoc stack with the threads that say where a thread OPENS (maintainer 2026-11-18: "you should
// not be auto-scrolled to the bottom. You should be auto-scrolled to a place where you can see the most
// recent user steer, and then it shows all of the stuff that was collapsed. Then it shows the start of the
// thread's sign-off messages").
//
// Every long thread carries the same shape: five earlier stretches the human typed past, then the newest
// one — the human's steer, the worker's first words, a long run of work the fold hides, a long sign-off, a
// wake, a second sign-off, and a quiet park after another wake. What differs is where the board has it:
//
//   • land-queued     — at rest and in the queue (the pane's queue window).
//   • land-snoozed    — at rest and snoozed: out of the queue, so the pane draws the whole transcript.
//   • land-done       — archived, ending on a ```done sign-off.
//   • land-long-steer — queued, and the human's steer is itself taller than a pane.
//   • land-short      — queued, one short stretch that fits a pane whole.
//   • land-unsigned   — at rest on a bare quiet park with no sign-off since the steer: nothing folds.
//   • land-running    — mid-turn after a steer, a tool call still open (`--running`, which needs a stand-in
//                       broker daemon and so leaves a `sleep` whose pid this prints).
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads. The quiet parks name a PR
// no watch was registered for, so the board does not honour them and the thread queues.
//
// Usage: nub scripts/seed-open-landing.mjs <home> <projectDir> [--running]
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { wakeDeliveryToken } from "../packages/shared/src/index.ts"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const [home, projectDir] = args.filter((a) => !a.startsWith("--"))
const withRunning = args.includes("--running")
if (!home || !projectDir) throw new Error("usage: seed-open-landing.mjs <home> <projectDir> [--running]")

const cwdSlug = projectDir.replace(/[/.]/g, "-")
const transcriptDir = path.join(home, ".claude", "projects", cwdSlug)
fs.mkdirSync(transcriptDir, { recursive: true })
const sandbox = resolveSandboxDb(home)
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)

const BASE = Date.now() - 6 * 60 * 60_000
let clock = 0
const at = () => new Date(BASE + clock++ * 20_000).toISOString()
let ids = 0
const file = (p) => `${projectDir}/${p}`

const human = (s, text) => [{ type: "user", timestamp: at(), sessionId: s, message: { role: "user", content: text } }]
let wakes = 0
const wake = (s, text) => human(s, `${text}\n\n${wakeDeliveryToken(`seed-landing-wake-${wakes++}`)}`)
const narrate = (s, text, calls) => {
  const id = `landing-m${ids++}`
  const content = [{ type: "text", text }, ...calls.map((c, i) => ({ type: "tool_use", id: `${id}-t${i}`, ...c }))]
  return [
    { type: "assistant", timestamp: at(), sessionId: s, message: { id, model: "claude-opus-5", role: "assistant", stop_reason: "tool_use", content } },
    ...calls.map((_, i) => ({ type: "user", timestamp: at(), sessionId: s, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${id}-t${i}`, content: "ok" }] } })),
  ]
}
// A call the worker is still inside: no result follows it.
const calling = (s, text, call) => {
  const id = `landing-m${ids++}`
  return [{ type: "assistant", timestamp: at(), sessionId: s, message: { id, model: "claude-opus-5", role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text }, { type: "tool_use", id: `${id}-t0`, ...call }] } }]
}
const restOn = (s, text) => [{ type: "assistant", timestamp: at(), sessionId: s, message: { id: `landing-m${ids++}`, model: "claude-opus-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } }]

const read = (p) => ({ name: "Read", input: { file_path: file(p) } })
const edit = (p) => ({ name: "Edit", input: { file_path: file(p), old_string: "await sleep(100)", new_string: "await sleep(2 ** attempt * 100)" } })
const bash = (command, description) => ({ name: "Bash", input: { command, description } })

const fence = (kind, body) => `\`\`\`${kind}\n${body}\n\`\`\``
const QUIET = fence("awaiting", "prs: [acme/app#391]\nstatus: watching\nfor: 180d")

// Each named so a test can find it in the pane by its text.
export const STEER = "LANDING-STEER: the retry still fails on a slow first connection."
export const LEAD = "LANDING-LEAD: reading the retry loop before I touch it."
export const FIRST_SIGN_OFF = "LANDING-SIGNOFF-ONE"
export const SECOND_SIGN_OFF = "LANDING-SIGNOFF-TWO"

const steerText = (extra = 0) => [
  STEER,
  "",
  "I ran the upload against the staging bucket again this morning and three of the twenty runs died on the first try. Back the retry off properly, keep the public API as it is, and open a PR when the trace replay passes.",
  ...Array.from({ length: extra }, (_, i) => `\nPasted log line ${i + 1}: upload: ECONNRESET after 100ms (attempt 1 of 5), bucket staging-eu-${i % 4}, object batch-${1000 + i}.bin, retrying with the same fixed delay as before.`),
].join("\n")

const WRITE_UP_ONE = [
  `**Needs you** — ${FIRST_SIGN_OFF}: the upload retry backs off now, and acme/app#391 is open with CI running.`,
  "",
  "The retry slept a fixed 100ms between tries, so a slow first connection failed all five inside half a second. It now doubles from 100ms and gives up after five tries, which rides out the slowest connection in the staging trace with two tries to spare.",
  "",
  "- **The retry backs off** from 100ms, doubling, capped at five tries (`src/upload.ts`).",
  "- **A regression test** replays the slow-first-connection trace that failed three runs in twenty.",
  "- **The config key is unchanged**: `upload.retries` still means the number of tries.",
  "- **Nothing else moved**: the public API and the error the caller sees are the same.",
  "",
  "| Run | Before | After |",
  "|---|---|---|",
  "| Fast connection | 1 try | 1 try |",
  "| Slow first connection | 5 tries, failed | 3 tries, passed |",
  "| Dead bucket | 5 tries in 0.5s | 5 tries in 3.1s |",
  "",
  "```ts",
  "for (let attempt = 0; attempt < retries; attempt++) {",
  "  const sent = await send(chunk)",
  "  if (sent.ok) return sent",
  "  await sleep(2 ** attempt * 100)",
  "}",
  "```",
  "",
  "The one call worth a look is the cap: five tries at this pitch is 3.1 seconds against a dead bucket, where the old loop gave up in half a second. A caller that wants the old behaviour sets `upload.retries` to 1.",
  "",
  "What I did not do: the download path has the same fixed sleep. It is not in the trace and you did not ask for it, so it is as it was.",
  "",
  fence("awaiting", "prs: [acme/app#391]\nstatus: needs_input\nfor: 180d\ntitle: Backoff fix open as acme/app#391\n---\nThe approach is in the PR description if you want to look before CI finishes."),
].join("\n")

const WRITE_UP_TWO = [
  `**Needs you** — ${SECOND_SIGN_OFF}: CI is green on acme/app#391 at \`0251203e\`, 93 checks passed and 31 skipped.`,
  "",
  "- **The trace replay passed** on all three platforms, twenty runs each.",
  "- **The dead-bucket case** takes 3.1 seconds, as measured locally.",
  "",
  fence("awaiting", "prs: [acme/app#391]\nstatus: needs_input\nfor: 180d\ntitle: Upload retry fixed, ready to merge\n---\nThe merge is yours once you have read the diff."),
].join("\n")

const DONE = [
  `**Fixed** — ${SECOND_SIGN_OFF}: the upload retry backs off, merged as acme/app#391.`,
  "",
  fence("done", "title: Upload retry backs off\n---\n- **Fixed the fixed-delay retry** in `src/upload.ts`; it doubles from 100ms.\n- **Added the trace replay** as a regression test."),
].join("\n")

// The work a fold hides: narration between tool calls, a dozen and a half rounds of it.
const work = (s, rounds, tag) => Array.from({ length: rounds }, (_, i) => narrate(s, `${tag} step ${i + 1}: checking the next caller of the retry loop and what it does with a failure.`, [read(`src/caller-${i}.ts`), bash(`rg -n 'retry' src/caller-${i}.ts`, `Searching caller ${i}`)])).flat()

// Five stretches the human typed past, each with its own sign-off.
const history = (s) => Array.from({ length: 5 }, (_, k) => [
  ...human(s, `Earlier ask ${k + 1}: look at why the ${["upload", "download", "resume", "checksum", "progress"][k]} path is flaky and tell me what you find.`),
  ...narrate(s, `Earlier lead ${k + 1}: starting with the code path and its tests.`, [read(`src/earlier-${k}.ts`)]),
  ...work(s, 6, `Earlier ${k + 1}`),
  ...restOn(s, [
    `**Not fixed** — earlier finding ${k + 1}: the path is flaky because it sleeps a fixed interval, and nothing landed yet.`,
    "",
    "- **The sleep is fixed** at 100ms, so a slow peer fails every try.",
    "- **The test is timing-dependent** and passes on a fast machine.",
    "- **Next** is a backoff, which needs your say on the cap.",
  ].join("\n")),
]).flat()

// The newest stretch, as every long thread here has it.
const newest = (s, { steerExtra = 0, done = false } = {}) => [
  ...human(s, steerText(steerExtra)),
  ...narrate(s, LEAD, [read("src/upload.ts"), bash("rg -n 'sleep\\(' src", "Finding the retry sleeps")]),
  ...work(s, 18, "Newest"),
  ...narrate(s, "Opening the PR with the backoff.", [edit("src/upload.ts"), bash("gh pr create --fill", "Opening the pull request")]),
  ...restOn(s, WRITE_UP_ONE),
  ...wake(s, "✅ CI PASSED on acme/app#391 — 93 checks green, 31 skipped."),
  ...narrate(s, "CI is green; running the trace replay once more.", [bash("nub --test src/upload.test.ts", "Running the upload tests")]),
  ...restOn(s, done ? DONE : WRITE_UP_TWO),
  ...(done ? [] : [
    ...wake(s, "💬 New review comment on acme/app#391 from mona: \"Looks right to me.\""),
    ...restOn(s, QUIET),
  ]),
]

const sql = (v) => (v === null ? "NULL" : `'${String(v).replaceAll("'", "''")}'`)
const pids = []
function write(slug, sessionId, title, records, { snoozedUntil = null, archived = false, running = false } = {}) {
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  const spawned = new Date(BASE - 60_000).toISOString()
  const rested = running ? null : records.at(-1).timestamp
  if (running) {
    // A broker record naming a live process is what makes the board read the row as mid-turn.
    const daemon = spawn("sleep", ["7200"], { detached: true, stdio: "ignore" })
    daemon.unref()
    pids.push(daemon.pid)
    const brokerDir = path.join(sandbox.stateDir, "claude-broker")
    fs.mkdirSync(brokerDir, { recursive: true })
    fs.writeFileSync(
      path.join(brokerDir, `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.json`),
      JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: path.join(brokerDir, `${slug}.sock`) }),
    )
  }
  execFileSync("sqlite3", ["-cmd", ".timeout 15000", sandbox.db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at, snoozed_until, archived_at)
     VALUES (${sessionVals}${sql(slug)}, ${sql(sessionId)}, ${sql(`frizz-${slug}`)}, ${sql(spawned)}, ${sql(title)}, 0, 'claude', 'broker', 'opus', 'high', 'default', ${sql(archived ? "archived" : "active")}, 0, 0, ${archived ? 1 : 0}, ${sql(rested)}, ${sql(snoozedUntil)}, ${archived ? sql(rested) : "NULL"})`,
  ])
  console.log(`seeded ${slug} (${sessionId})`)
}

const session = (n) => `1a2d1260-0000-4000-8000-${String(n).padStart(12, "0")}`
const begin = () => { clock = 0 }

{
  const s = session(1)
  begin()
  write("land-queued", s, "Upload retry backoff", [...history(s), ...newest(s)])
}
{
  const s = session(2)
  begin()
  write("land-snoozed", s, "Upload retry backoff, snoozed", [...history(s), ...newest(s)], { snoozedUntil: new Date(Date.now() + 12 * 60 * 60_000).toISOString() })
}
{
  const s = session(3)
  begin()
  write("land-done", s, "Upload retry backoff, done", [...history(s), ...newest(s, { done: true })], { archived: true })
}
{
  const s = session(4)
  begin()
  write("land-long-steer", s, "Upload retry backoff, long steer", [...history(s), ...newest(s, { steerExtra: 40 })])
}
{
  const s = session(5)
  begin()
  write("land-short", s, "Upload retry backoff, short", [
    ...human(s, STEER),
    ...narrate(s, LEAD, [read("src/upload.ts")]),
    ...work(s, 3, "Short"),
    ...restOn(s, `**Needs you** — ${FIRST_SIGN_OFF}: the retry backs off and acme/app#391 is open.\n\n${fence("awaiting", "prs: [acme/app#391]\nstatus: needs_input\nfor: 180d\ntitle: Backoff fix open\n---\nRead the diff when you can.")}`),
  ])
}
{
  const s = session(6)
  begin()
  write("land-unsigned", s, "Upload retry backoff, no sign-off", [
    ...history(s),
    ...human(s, steerText()),
    ...narrate(s, LEAD, [read("src/upload.ts")]),
    ...work(s, 18, "Unsigned"),
    ...restOn(s, QUIET),
  ])
}
if (withRunning) {
  const s = session(7)
  begin()
  write("land-running", s, "Upload retry backoff, running", [
    ...history(s),
    ...human(s, steerText()),
    ...narrate(s, LEAD, [read("src/upload.ts")]),
    ...work(s, 18, "Running"),
    ...calling(s, "Running the whole suite now.", bash("nub run test", "Running the test suite")),
  ], { running: true })
  console.log(JSON.stringify({ standInDaemons: pids }))
}
