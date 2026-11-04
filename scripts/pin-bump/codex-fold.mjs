#!/usr/bin/env node
// What does Frizz make of a real Codex rollout? Runs each line through this checkout's
// `parseCodexLine`, then folds the whole file through the Codex backend the board uses.
//
//   nub scripts/pin-bump/codex-fold.mjs <rollout.jsonl>
//
// Rollouts live in `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`. One row per record —
// `type/payload.type/payload.item.type`, then the events it parses to, or `-` for none — and a final
// line with the folded turn, first user text, last assistant text and last activity. A record kind the
// new build writes and nothing parses (`-`) is the thing to read against `parseCodexLine` in
// backend/codex.ts. 0.153 moved every semantic event onto an `item_completed` envelope and the fold
// went quietly empty, which is what an empty `lastAssistant` here would look like.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const path = process.argv[2]
if (!path) {
  console.error("usage: nub scripts/pin-bump/codex-fold.mjs <rollout.jsonl>")
  process.exit(1)
}
const root = fileURLToPath(new URL("../..", import.meta.url))
const source = (file) => import(pathToFileURL(join(root, file)).href)
const { parseCodexLine, createCodexBackend } = await source("packages/server/src/backend/codex.ts")
const { newTailState } = await source("packages/server/src/tailer.ts")

const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
for (const line of lines) {
  const record = JSON.parse(line)
  const tag = [record.type, record.payload?.type, record.payload?.item?.type].filter(Boolean).join("/")
  const events = parseCodexLine(line).map((event) => event.kind + (event.final === undefined ? "" : `(final=${event.final})`))
  console.log(tag.padEnd(48), events.join(", ") || "-")
}
const state = newTailState("t", "s", "/x")
const backend = createCodexBackend()
for (const line of lines) backend.foldLine(state, line)
console.log(JSON.stringify({ turn: state.turn, firstUserText: state.firstUserText?.slice(0, 60), lastAssistant: state.lastAssistant?.slice(0, 120), lastActivityAt: state.lastActivityAt }))
