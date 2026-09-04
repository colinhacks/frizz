#!/usr/bin/env node
// Seed an adhoc stack with the shape that decides WHERE an open REGISTERED question renders once the
// human has replied past it and the worker has rested again (maintainer 2026-08-31, on
// `evaluate-critically-never-assume`: "Why was this able to come to rest without a proper handoff?").
//
//   • q-current-rest — the worker registers a question and rests; the human replies WITHOUT answering
//                      it; the worker answers the follow-up and RESTS AGAIN with the row still open.
//                      Anchored to the asking rest, the card strands above the human's own reply and
//                      the newest handoff — the one they are reading — shows no ask at all, so the rest
//                      reads as a bare stop. It belongs at the CURRENT rest, under the final message.
//   • q-fresh-ask    — the control: asked at the newest rest with nothing since. This one already
//                      rendered at the tail and must not move.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads. The `thread_question`
// row is the same kind of fixture as the session row — there is no human-facing RPC that registers a
// question (only a worker's `ask` MCP tool does), so the row IS the fixture and everything downstream
// of it — board projection, push, render — runs for real.
//
// Usage: node scripts/seed-question-at-current-rest.mjs <home> <projectId> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const [home, projectId, projectDir] = process.argv.slice(2)
if (!home || !projectId || !projectDir) throw new Error("usage: seed-question-at-current-rest.mjs <home> <projectId> <projectDir>")

const cwdSlug = projectDir.replace(/[/.]/g, "-")
const transcriptDir = path.join(home, ".claude", "projects", cwdSlug)
fs.mkdirSync(transcriptDir, { recursive: true })

// ONE server, EVERY project: the tables live in the unified `~/.frizz/ui.db` and are scoped by
// `project_id`, not in a per-project file. This script takes its project id as an argument, so it
// names the file directly; the seeds that have to DISCOVER one go through scripts/lib/sandbox-db.mjs.
const db = path.join(home, ".frizz", "ui.db")

const T = (n) => new Date(Date.UTC(2026, 7, 31, 19, n, 0)).toISOString()
const MS = (n) => Date.UTC(2026, 7, 31, 19, n, 0)
const file = (p) => `${projectDir}/${p}`
const call = (id, name, input) => ({ type: "tool_use", id, name, input })
const result = (id, content) => ({ type: "tool_result", tool_use_id: id, content })

let clock = 0
const stamp = () => T(clock++)

const human = (sessionId, text) => [
  { type: "user", sessionId, timestamp: stamp(), message: { role: "user", content: [{ type: "text", text }] } },
]
const prose = (sessionId, text) => [
  { type: "assistant", sessionId, timestamp: stamp(), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } },
]
const toolTurn = (sessionId, calls, text) => [
  { type: "assistant", sessionId, timestamp: stamp(), message: { role: "assistant", content: calls } },
  { type: "user", sessionId, timestamp: stamp(), message: { role: "user", content: calls.map((c) => result(c.id, "ok")) } },
  ...prose(sessionId, text),
]

function write(slug, sessionId, title, records) {
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived, rested_at)
     VALUES ('${projectId}', '${slug}', '${sessionId}', 'frizz-${slug}', '${T(0)}', '${title}', 0, 'claude', 'opus', 'high', 'default', 'open', 0, 0, 0, '${T(clock)}')`,
  ])
  console.log(`seeded ${slug} (${sessionId})`)
}

function ask(slug, id, askedAtMs, spec) {
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO thread_question (id, project_id, thread_slug, spec, state, answer, delivered, asked_at, settled_at)
     VALUES ('${id}', '${projectId}', '${slug}', '${JSON.stringify(spec).replace(/'/g, "''")}', 'open', NULL, 0, ${askedAtMs}, NULL)`,
  ])
}

const BOX_Q = {
  question: "Take the prototype-accessor representation for util.cached, or leave it exactly as it is?",
  header: "util.cached",
  kind: "question",
  options: [
    { label: "Take the prototype-accessor representation", description: "Same contract, same laziness, no call-site or type changes; -544 B per object schema.", recommended: true },
    { label: "Leave util.cached untouched", description: "The ~360 B per box and the per-parse dictionary load stay as the accepted cost of the current form." },
  ],
}

const readUtil = (id) => call(id, "Read", { file_path: file("packages/core/src/util.ts") })
const bench = (id) => call(id, "Bash", { command: "node --expose-gc --import tsx /tmp/box-read-bench.ts", description: "Measuring read speed per box representation" })

// 1 — THE DEFECT. Asked at an earlier rest, replied past, rested again with the row still open.
{
  const s = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
  clock = 0
  write("q-current-rest", s, "Question the human replied past", [
    ...human(s, "TASK:\nEvaluate the util.cached optimization proposals critically. Never assume."),
    ...toolTurn(s, [readUtil("r1")], "Read the current box. Measuring the three representations before I recommend anything."),
    // clock is at 4 here — the rest the question is registered at.
    ...prose(s, "The measurements are in and the trade is not what the design assumes. Registering the call as a card."),
    ...human(s, "It's about access speed versus memory, right? I don't know which one matters here?"),
    ...toolTurn(s, [bench("r2")], "Good question, and it deserves a measured answer rather than a theoretical one. Let me measure the read side properly."),
    ...prose(s, "Yes — access speed versus memory is exactly the trade the current design intends. I measured both sides, and the answer is that the trade is not real here: the current form loses both. The prototype getter reads *faster* in both regimes, because the redefine lands the property on a dictionary-mode object, so every later read is a hash lookup. The numbers are recorded in `.triage/issues/6517/results.md`."),
  ])
  ask("q-current-rest", "qst_replied_past", MS(4), BOX_Q)
}

// 2 — THE CONTROL. Asked at the newest rest, nothing since; already rendered at the tail.
{
  const s = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
  clock = 0
  write("q-fresh-ask", s, "Question asked at the current rest", [
    ...human(s, "TASK:\nEvaluate the util.cached optimization proposals critically. Never assume."),
    ...toolTurn(s, [readUtil("f1")], "Read the current box. Measuring the three representations before I recommend anything."),
    ...prose(s, "The measurements are in and the trade is not what the design assumes. Registering the call as a card."),
  ])
  ask("q-fresh-ask", "qst_fresh_ask", MS(4), BOX_Q)
}
