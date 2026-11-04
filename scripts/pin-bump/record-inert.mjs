#!/usr/bin/env node
// Does a record kind Claude Code just started writing change anything Frizz shows? Folds and reads
// real transcripts as written and again with every record of that `type` removed, through this
// checkout's own code, and reports any difference.
//
//   nub scripts/pin-bump/record-inert.mjs <type> <transcript.jsonl> [...]
//
// Two readers consume a transcript, and both are exercised:
//   - the live fold the board runs on (`createClaudeBackend().foldLine` into a tail state): every field
//     of the final tail state, plus the turn `computeTurn` derives from it 1s and 10s after the last
//     activity;
//   - the transcript a thread draws (`readTranscriptFile`): every message, minus `sourceId`, which is
//     the file's identity plus a byte offset and so moves whenever lines are removed.
// "INERT" on both for every file means the new kind is safe to ignore, and the bump pins it with a
// test (as 2.1.300's `api-request` records and 2.1.317's `session-owner` are pinned in tailer.test.ts
// and transcript.test.ts). Any difference is printed field by field: that is the parser change to make.
// Name a kind every transcript carries (`assistant`) to watch it report differences, as a control.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"

const [type, ...files] = process.argv.slice(2)
if (!type || files.length === 0) {
  console.error("usage: nub scripts/pin-bump/record-inert.mjs <type> <transcript.jsonl> [...]")
  process.exit(1)
}
const root = fileURLToPath(new URL("../..", import.meta.url))
const source = (path) => import(pathToFileURL(join(root, path)).href)
const { createClaudeBackend } = await source("packages/server/src/backend/claude.ts")
const { newTailState, computeTurn } = await source("packages/server/src/tailer.ts")
const { readTranscriptFile } = await source("packages/server/src/transcript.ts")
const scratch = mkdtempSync(join(tmpdir(), "frizz-record-inert-"))

const fold = (lines) => {
  const backend = createClaudeBackend({ logDir: "/nonexistent" })
  const state = newTailState("probe", "session", "/nonexistent")
  for (const line of lines) backend.foldLine(state, line)
  const last = Date.parse(state.lastActivityAt ?? "")
  return { ...state, "turn@+1s": computeTurn(state, last + 1_000), "turn@+10s": computeTurn(state, last + 10_000) }
}
const read = (lines, name) => {
  const path = join(scratch, name)
  writeFileSync(path, lines.join("\n") + "\n")
  return readTranscriptFile(path).map(({ sourceId: _offset, ...message }) => message)
}

let differs = 0
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
  const kept = lines.filter((line) => JSON.parse(line).type !== type)
  const name = basename(file)
  const foldA = fold(lines), foldB = fold(kept)
  const foldKeys = [...new Set([...Object.keys(foldA), ...Object.keys(foldB)])].filter((key) => !isDeepStrictEqual(foldA[key], foldB[key]))
  const readA = read(lines, `as-written-${name}`), readB = read(kept, `without-${name}`)
  const readSame = isDeepStrictEqual(readA, readB)
  console.log(`${name}: ${lines.length - kept.length} of ${lines.length} records are ${type}; fold ${foldKeys.length ? "DIFFERS" : "INERT"}; read ${readSame ? "INERT" : "DIFFERS"} (${readA.length} vs ${readB.length} messages)`)
  for (const key of foldKeys) console.log(`  fold ${key}: ${JSON.stringify(foldA[key])?.slice(0, 200)} -> without: ${JSON.stringify(foldB[key])?.slice(0, 200)}`)
  if (!readSame) {
    for (let i = 0; i < Math.max(readA.length, readB.length); i++) {
      if (isDeepStrictEqual(readA[i], readB[i])) continue
      console.log(`  read message ${i}: ${JSON.stringify(readA[i])?.slice(0, 200)} -> without: ${JSON.stringify(readB[i])?.slice(0, 200)}`)
      break
    }
  }
  if (foldKeys.length || !readSame) differs++
}
console.log(differs ? `${differs} of ${files.length} transcripts change without ${type}` : `${type} is inert in every transcript`)
process.exit(differs ? 1 : 0)
