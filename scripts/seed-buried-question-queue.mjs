#!/usr/bin/env node
// Seed an adhoc stack with the three transcript shapes that decide whether a ```question stays
// ANSWERABLE ON THE QUEUE CARD once a newer message exists (maintainer 2026-08-03: "question fences
// should be answerable, even if there's been a more recent message… possible in the full view, but not
// in the queue card view").
//
//   • q-buried  — the ask sits in the MIDDLE of the run: the agent asked, then kept working and closed
//                 with a summary. Two things must hold: the card LIFTS the ask out of the intermediate
//                 collapse (it used to hide inside `Ran N tool calls`, so the card offered "Send
//                 answers" with no question on screen), and its chips are live.
//   • q-stacked — two unanswered asks with work between them. BOTH take chips; the queue card used to
//                 make only the most recent one answerable.
//   • q-human-past — an ask the human already replied PAST. Nothing stands at the tail, so the card's
//                 own "Send answers" action is down until a chip is filled — but the ask itself, once
//                 "Load earlier messages" brings it back, still takes chips.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
// Nothing writes board state directly; the transcript records drive it.
//
// Usage: node scripts/seed-buried-question-queue.mjs <home> <unused> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, _socket, projectDir] = process.argv.slice(2)
if (!home || !projectDir) throw new Error("usage: seed-buried-question-queue.mjs <home> <unused> <projectDir>")

const cwdSlug = projectDir.replace(/[/.]/g, "-")
const transcriptDir = path.join(home, ".claude", "projects", cwdSlug)
fs.mkdirSync(transcriptDir, { recursive: true })

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)

const T = (n) => new Date(Date.UTC(2026, 7, 3, 4, n, 0)).toISOString()
const file = (p) => `${projectDir}/${p}`
const call = (id, name, input) => ({ type: "tool_use", id, name, input })
const result = (id, content) => ({ type: "tool_result", tool_use_id: id, content })

const ENGINE_Q = [
  "Before I go further, one call is yours.",
  "",
  "```question",
  "Which database engine should the storage layer target?",
  "",
  "- A. Postgres — matches prod, so the migrations are the ones we actually ship (recommended)",
  "- B. SQLite — zero setup, but no parity with prod",
  "```",
].join("\n")

const LABEL_Q = [
  "And a smaller one while you're here.",
  "",
  "```question",
  "Which collapse label reads best on the card?",
  "",
  "- A. `11 tool calls · Click to expand` — names the scale and the affordance (recommended)",
  "- B. Just `Click to expand` — leaner, but the reader can't tell how much is hidden",
  "```",
].join("\n")

let clock = 0
const at = () => T(clock++)

// A settled assistant turn: each call gets a result, so the run reads as finished rather than live.
const toolTurn = (sessionId, calls, text) => {
  const records = []
  calls.forEach((c, i) => {
    records.push({
      type: "assistant",
      timestamp: at(),
      sessionId,
      message: { id: `m-${c.id}-${i}`, model: "claude-opus-5", role: "assistant", stop_reason: "tool_use", content: [c] },
    })
    records.push({ type: "user", timestamp: at(), sessionId, message: { role: "user", content: [result(c.id, "ok")] } })
  })
  if (text) {
    records.push({
      type: "assistant",
      timestamp: at(),
      sessionId,
      message: { id: `m-text-${clock}`, model: "claude-opus-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] },
    })
  }
  return records
}

const prose = (sessionId, text) => toolTurn(sessionId, [], text)
const human = (sessionId, text) => [{ type: "user", timestamp: at(), sessionId, message: { role: "user", content: text } }]

function write(slug, sessionId, title, records) {
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived, rested_at)
     VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${T(0)}', '${title}', 0, 'claude', 'opus', 'high', 'default', 'open', 0, 0, 0, '${T(59)}')`,
  ])
  console.log(`seeded ${slug} (${sessionId})`)
}

const readStorage = (id) => call(id, "Read", { file_path: file("packages/server/src/storage.ts") })
const editStorage = (id) => call(id, "Edit", { file_path: file("packages/server/src/storage.ts"), old_string: "const rows = []", new_string: "const rows = await all()" })
const runTests = (id) => call(id, "Bash", { command: "nub --test packages/server/src/**/*.test.ts", description: "Run the server suite" })

// 1 — the ask buried mid-run by the agent's own continuation.
{
  const s = "11111111-1111-4111-8111-111111111111"
  clock = 0
  write("q-buried", s, "Buried ask, agent kept working", [
    ...human(s, "TASK:\nSet up the database layer end to end."),
    ...toolTurn(s, [readStorage("b1"), call("b2", "Grep", { pattern: "migrate|schema" })], "Reading the current schema and migration setup first."),
    ...prose(s, ENGINE_Q),
    ...toolTurn(s, [editStorage("b3"), runTests("b4")], "Meanwhile I wired the migrations runner so either answer lands cleanly."),
    ...prose(s, "Runner and a connection-pool stub are in — still waiting on the engine call above before I go further."),
  ])
}

// 2 — two unanswered asks stacked with work between them.
{
  const s = "22222222-2222-4222-8222-222222222222"
  clock = 0
  write("q-stacked", s, "Two stacked asks", [
    ...human(s, "TASK:\nSet up the database layer end to end."),
    ...toolTurn(s, [readStorage("s1")], "Reading the current schema first."),
    ...prose(s, ENGINE_Q),
    ...toolTurn(s, [editStorage("s2"), runTests("s3")], "Sketching the collapse label while I wait."),
    ...prose(s, LABEL_Q),
  ])
}

// 3 — the human already replied past the ask.
{
  const s = "33333333-3333-4333-8333-333333333333"
  clock = 0
  write("q-human-past", s, "Ask the human replied past", [
    ...human(s, "TASK:\nSet up the database layer end to end."),
    ...toolTurn(s, [readStorage("h1")], "Reading the current schema first."),
    ...prose(s, ENGINE_Q),
    ...human(s, "Park the engine question — do the migrations runner first."),
    ...toolTurn(s, [editStorage("h2"), runTests("h3")], "On it — runner first."),
    ...prose(s, "Migrations runner is in and green."),
  ])
}
