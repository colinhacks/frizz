#!/usr/bin/env node
// Seed an adhoc stack with the shape the stretch fold exists for (web lib/stretchFolds; maintainer
// 2026-11-11, of a reylo thread on 0.15.51: "There is so much shit being rendered … above the sign-off
// message. So many rounds that weren't collapsed").
//
//   • fold-reylo     — the human's ask, a long run of narration between tool calls with a quiet park and a
//                      background run's return in the middle, a sign-off that asks a question, then a CI wake
//                      and a review wake the worker parked quietly on. Expect: the ask, the worker's first
//                      words, one hairline, the sign-off with its live card, one hairline.
//   • fold-long-ask  — the same rest under a human message too long for the sign-off to show beside it, so
//                      the queue's window lands the sign-off a little below the top instead of opening there.
//   • fold-history   — two stretches: an older one, answered, folds the same way above the newest.
//   • fold-restated  — a write-up ending on a to-do fence, then a wake the worker answers by pasting that
//                      fence back word for word (pullfrog-app, 2026-11-12). Expect: the write-up kept
//                      whole, one hairline, and ONE to-do card, the live one at the tail.
//   • fold-restated-quiet — the same with tool calls and no words before the write-up, the reported
//                      thread's own shape, where the card was drawn twice.
//
// Every wake is the text Frizz really delivers, built by the server's own builders, so each draws the
// hairline a real one does. A made-up wake falls back to FrizzWake's bell card, which no real wake draws.
//
// Each row is a broker row (`claude_runtime='broker'`), so the board reads the tailer's turn state and the
// thread is AT REST, with the resting card at its tail, as a real one is (seed-resting-thread.mjs). Without
// it a row reads as exited and no resting card draws.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads, so the question fence is
// registered by the server's own registrar. Nothing writes board state directly.
//
// Usage: nub scripts/seed-signoff-fold.mjs <home> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { formatGithubWakeSteer, prWatchWakeMessage, shellDoneMessage, wakeDeliveryToken } from "../packages/shared/src/index.ts"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, projectDir] = process.argv.slice(2)
if (!home || !projectDir) throw new Error("usage: seed-signoff-fold.mjs <home> <projectDir>")

const cwdSlug = projectDir.replace(/[/.]/g, "-")
const transcriptDir = path.join(home, ".claude", "projects", cwdSlug)
fs.mkdirSync(transcriptDir, { recursive: true })
const sandbox = resolveSandboxDb(home)
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)

const BASE = Date.now() - 150 * 60_000
let clock = 0
const at = (step = 1) => new Date(BASE + (clock += step) * 60_000).toISOString()
let ids = 0
const file = (p) => `${projectDir}/${p}`

const human = (s, text, step) => [{ type: "user", timestamp: at(step), sessionId: s, message: { role: "user", content: text } }]
let wakes = 0
const wake = (s, text, step) => human(s, `${text}\n\n${wakeDeliveryToken(`seed-fold-wake-${wakes++}`)}`, step)
const narrate = (s, text, calls, step) => {
  const id = `m${ids++}`
  const content = [{ type: "text", text }, ...calls.map((c, i) => ({ type: "tool_use", id: `${id}-t${i}`, ...c }))]
  return [
    { type: "assistant", timestamp: at(step), sessionId: s, message: { id, model: "claude-opus-5", role: "assistant", stop_reason: "tool_use", content } },
    ...calls.map((_, i) => ({ type: "user", timestamp: at(0.1), sessionId: s, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${id}-t${i}`, content: "ok" }] } })),
  ]
}
const restOn = (s, text, step) => [{ type: "assistant", timestamp: at(step), sessionId: s, message: { id: `m${ids++}`, model: "claude-opus-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } }]

const read = (p) => ({ name: "Read", input: { file_path: file(p) } })
const edit = (p) => ({ name: "Edit", input: { file_path: file(p), old_string: "value.toString('hex')", new_string: "wkbToGeoJson(value)" } })
const bash = (command, description) => ({ name: "Bash", input: { command, description } })
const fence = (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\``

const WORK = [
  ["Reading how the run endpoint serializes DuckDB values.", [read("src/run/serialize.ts"), bash("rg -n 'GEOMETRY' src", "Finding the geometry handling")]],
  ["Geometry columns arrive as WKB buffers and fall through to the hex branch.", [read("src/run/values.ts")]],
  ["Checking which spatial extension version the runner loads.", [bash("duckdb -c \"select * from duckdb_extensions() where extension_name = 'spatial'\"", "Reading the spatial extension version")]],
  ["Writing a failing test with a point, a line and a polygon.", [edit("src/run/values.test.ts"), bash("nub --test src/run/values.test.ts", "Running the values tests")]],
  ["Patching the converter to decode WKB into GeoJSON.", [edit("src/run/values.ts")]],
]
const MORE = [
  ["The notebook build passed, so the renderer already reads GeoJSON and nothing changes there.", [read("src/notebook/cells.tsx")]],
  ["Running the whole suite.", [bash("nub run test", "Running the full test suite")]],
  ["Two snapshot tests pinned the hex; updating them.", [edit("src/run/__snapshots__/values.snap"), bash("nub run test", "Re-running the full test suite")]],
  ["Checking the API response by hand against a real run.", [bash("curl -s localhost:3000/api/run/42 | jq '.rows[0]'", "Fetching one run's first row")]],
]
const doWork = (s, lines) => lines.flatMap(([text, calls]) => narrate(s, text, calls, 3))

const SIGN_OFF = [
  "**Needs you** — geometry values from a run now come back as GeoJSON instead of hex, on branch `fix/geometry-values`.",
  "",
  "- **The converter decodes WKB** into GeoJSON for every geometry type DuckDB's spatial extension returns (`src/run/values.ts`).",
  "- **A regression test** covers a point, a line string and a polygon with a hole.",
  "- **Two snapshots** that had pinned the hex output were updated.",
  "",
  "One call is left before it lands: what the API should return for a geometry whose WKB fails to decode.",
  "",
  fence("question", [
    "id: bad-wkb",
    "kind: choice",
    "question: What should a run return for a geometry value that fails to decode?",
    "options:",
    "  - label: null, with a warning in the run log",
    "    description: The row still renders; the log says which cell",
    "    recommended: true",
    "  - label: The raw hex, as today",
    "    description: Nothing lost, but the notebook shows an opaque string",
    "  - label: Fail the run",
    "    description: Loud, and blocks every run with one bad row",
  ].join("\n")),
].join("\n")

const QUIET = fence("awaiting", "status: watching\nfor: 1d")

const quietRounds = (s) => [
  ...wake(s, prWatchWakeMessage({ target: "acme/geo#42", checks: { verdict: "passing", passed: 212, failed: 0, failing: [] } }), 18),
  ...restOn(s, QUIET, 1),
  ...wake(s, formatGithubWakeSteer({ ref: "acme/geo#42", omitted: 0, items: [{ label: "review comment", actor: "mona", bot: false, at: at(0), url: "https://github.com/acme/geo/pull/42#discussion_r1" }] }), 25),
  ...narrate(s, "Moving the decoder beside the other converters.", [edit("src/run/converters/geometry.ts"), bash("git commit -am 'move the decoder' && git push", "Pushing the move")], 2),
  ...restOn(s, QUIET, 2),
]

function write(slug, sessionId, title, records) {
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  const spawned = new Date(BASE - 60_000).toISOString()
  const rested = records.at(-1).timestamp
  execFileSync("sqlite3", [
    sandbox.db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at)
     VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${spawned}', '${title.replaceAll("'", "''")}', 0, 'claude', 'broker', 'opus', 'high', 'default', 'open', 0, 0, 0, '${rested}')`,
  ])
  console.log(`seeded ${slug} (${sessionId})`)
}

const stretch = (s, ask) => [
  ...human(s, ask, 1),
  ...doWork(s, WORK),
  ...restOn(s, fence("awaiting", "status: working\nfor: 1h"), 1),
  ...wake(s, shellDoneMessage({ taskId: "b7k2m9q4x", label: "Building the notebook against GeoJSON cells", status: "completed" }), 6),
  ...doWork(s, MORE),
  ...restOn(s, SIGN_OFF, 2),
  ...quietRounds(s),
]

{
  const s = "f01dc0de-0000-4000-8000-000000000001"
  clock = 0
  write("fold-reylo", s, "Geometry values from a run come back as GeoJSON", stretch(s, "Geometry values from a run come back as hex strings. Fix it so the notebook can draw them."))
}

{
  const s = "f01dc0de-0000-4000-8000-000000000002"
  clock = 0
  const ask = [
    "Geometry values from a run come back as hex strings. Fix it so the notebook can draw them. Here is the spec the notebook team wrote, so the output matches what they read:",
    "",
    ...Array.from({ length: 34 }, (_, i) => `${i + 1}. A geometry cell of type ${["POINT", "LINESTRING", "POLYGON", "MULTIPOINT", "MULTIPOLYGON", "GEOMETRYCOLLECTION"][i % 6]} renders as a GeoJSON object with its coordinates in longitude, latitude order, and an empty geometry renders as null rather than an empty collection.`),
    "",
    "Ask me if anything in there contradicts what DuckDB returns.",
  ].join("\n")
  write("fold-long-ask", s, "Geometry values, with the notebook team's spec", stretch(s, ask))
}

{
  const s = "f01dc0de-0000-4000-8000-000000000003"
  clock = 0
  write("fold-history", s, "Geometry values, second round", [
    ...human(s, "The run endpoint returns geometry as hex. Find out why before changing anything.", 1),
    ...doWork(s, WORK.slice(0, 3)),
    ...restOn(s, "**Found it** — geometry columns arrive as WKB buffers and fall through to the hex branch in `src/run/values.ts`. The fix is a WKB decoder in that branch; nothing else reads the hex.\n\n" + fence("awaiting", "status: needs_input\nfor: 1h"), 2),
    ...stretch(s, "Good, fix it."),
  ])
}

{
  const s = "f01dc0de-0000-4000-8000-000000000004"
  clock = 0
  const steps = fence("awaiting", [
    "title: Add Lubos's company as a Justworks international contractor",
    "steps:",
    "  - In [Justworks](https://secure.justworks.com/), add Lubos Venntures Limited as an international contractor.",
    "",
    "    | Field | Value |",
    "    |---|---|",
    "    | Contractor | Lubos Venntures Limited |",
    "    | Pay | $7,083.33 a month |",
    "---",
    "Justworks emails Lubos to enter his own payment details.",
  ].join("\n"))
  const quiet = (sid, calls, step) => {
    const id = `m${ids++}`
    return [
      { type: "assistant", timestamp: at(step), sessionId: sid, message: { id, model: "claude-opus-5", role: "assistant", stop_reason: "tool_use", content: calls.map((c, i) => ({ type: "tool_use", id: `${id}-t${i}`, ...c })) } },
      ...calls.map((_, i) => ({ type: "user", timestamp: at(0.1), sessionId: sid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${id}-t${i}`, content: "ok" }] } })),
    ]
  }
  const writeUp = (sid) => restOn(sid, `Justworks stays. The one thing left is getting the two contractors set up in Justworks.\n\n- **Lubos** is next: add his company as an international contractor (step below).\n- **Notes:** \`payroll/notes.md\` records the decision.\n\n${steps}`, 2)
  const pasteBack = (sid) => [
    ...wake(sid, shellDoneMessage({ taskId: "b2c4e6g8i", label: "Re-checking the contractor notes", status: "completed" }), 1),
    ...narrate(sid, "Checking the notes once more.", [bash("rg -n Mercury people", "Checking the notes for Mercury")], 1),
    ...restOn(sid, steps, 1),
  ]
  {
    const q = "f01dc0de-0000-4000-8000-000000000005"
    write("fold-restated-quiet", q, "Stay on Justworks, tool calls only before the write-up", [
      ...human(q, "Stay on Justworks, and pay the two contractors through it.", 1),
      ...quiet(q, [read("people/lubos/offer.md"), edit("payroll/notes.md")], 2),
      ...writeUp(q),
      ...pasteBack(q),
    ])
  }
  write("fold-restated", s, "Stay on Justworks; pay the contractors through it", [
    ...human(s, "Stay on Justworks, and pay the two contractors through it.", 1),
    ...narrate(s, "Reading the offer letter for the contractor details.", [read("people/lubos/offer.md")], 2),
    ...narrate(s, "Updating the payroll notes.", [edit("payroll/notes.md")], 2),
    ...restOn(s, `Justworks stays. The one thing left is getting the two contractors set up in Justworks.\n\n- **Lubos** is next: add his company as an international contractor (step below).\n- **Notes:** \`payroll/notes.md\` records the decision.\n\n${steps}`, 2),
    ...wake(s, shellDoneMessage({ taskId: "b2c4e6g8i", label: "Re-checking the contractor notes", status: "completed" }), 1),
    ...narrate(s, "Checking the notes once more.", [bash("rg -n Mercury people", "Checking the notes for Mercury")], 1),
    ...restOn(s, steps, 1),
  ])
}
