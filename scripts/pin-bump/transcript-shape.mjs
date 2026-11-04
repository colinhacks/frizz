#!/usr/bin/env node
// Which record kinds and keys did a Claude Code build start or stop writing? Compares the transcripts
// of two probe runs (claude-probe.mjs, from `main` and from the bump).
//
//   nub scripts/pin-bump/transcript-shape.mjs --old <a.jsonl> [...] --new <b.jsonl> [...]
//
// A record kind is its `type`, refined by `subtype` or by `attachment.type` where it has one. Prints
// the builds each side was written by, kinds only one side wrote, and per shared kind the top-level
// keys added or dropped. A kind or key that appears is the usual finding and is mostly harmless —
// Frizz's folds skip what they do not name — but each new KIND gets `record-inert.mjs` to prove it,
// and a vanished one is read against tailer.ts and transcript.ts. One run is a sample: a kind the
// model happened not to trigger (a thinking block, a remote-session attachment) reads as missing, so
// check a delta against the binary or a second run before believing it.
import { readFileSync } from "node:fs"

const args = process.argv.slice(2)
const oldAt = args.indexOf("--old")
const newAt = args.indexOf("--new")
if (oldAt < 0 || newAt < 0) {
  console.error("usage: nub scripts/pin-bump/transcript-shape.mjs --old <a.jsonl> [...] --new <b.jsonl> [...]")
  process.exit(1)
}
const oldFiles = oldAt < newAt ? args.slice(oldAt + 1, newAt) : args.slice(oldAt + 1)
const newFiles = newAt < oldAt ? args.slice(newAt + 1, oldAt) : args.slice(newAt + 1)

function shape(files) {
  const kinds = new Map()
  const versions = new Set()
  let records = 0
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue
      const record = JSON.parse(line)
      records++
      if (record.version) versions.add(record.version)
      const refinement = record.subtype ?? record.attachment?.type
      const kind = refinement ? `${record.type}/${refinement}` : String(record.type)
      const keys = kinds.get(kind) ?? new Set()
      for (const key of Object.keys(record)) keys.add(key)
      kinds.set(kind, keys)
    }
  }
  return { kinds, versions, records }
}

const before = shape(oldFiles)
const after = shape(newFiles)
console.log(`old: ${[...before.versions].join(", ")} · ${before.records} records · ${before.kinds.size} kinds`)
console.log(`new: ${[...after.versions].join(", ")} · ${after.records} records · ${after.kinds.size} kinds`)
console.log("kinds only old:", [...before.kinds.keys()].filter((kind) => !after.kinds.has(kind)).sort().join(", ") || "none")
console.log("kinds only new:", [...after.kinds.keys()].filter((kind) => !before.kinds.has(kind)).sort().join(", ") || "none")
let moved = 0
for (const kind of [...before.kinds.keys()].filter((kind) => after.kinds.has(kind)).sort()) {
  const a = before.kinds.get(kind), b = after.kinds.get(kind)
  const gained = [...b].filter((key) => !a.has(key)).sort()
  const lost = [...a].filter((key) => !b.has(key)).sort()
  if (!gained.length && !lost.length) continue
  moved++
  console.log(`keys ${kind}:${lost.length ? ` -[${lost.join(", ")}]` : ""}${gained.length ? ` +[${gained.join(", ")}]` : ""}`)
}
if (!moved) console.log("keys: no shared kind gained or lost a key")
