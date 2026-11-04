#!/usr/bin/env node
// What did the model see change between two Claude Code builds? Compares the tools offered in two
// transcripts, one probe from each build (claude-probe.mjs, run from `main` and from the bump).
//
//   nub scripts/pin-bump/tools-diff.mjs <old.jsonl> <new.jsonl>
//
// Since 2.1.300 every transcript records the request shape sent to the model (`api-request-shape`),
// tools included, so this reads exactly what a worker is offered rather than what the docs say.
// Prints tools added and removed, and for each tool whose description or input schema changed, the
// description lines that left and arrived and whether the schema moved.
//
// What to look for: a capability that contradicts the worker contract (packages/server/src/workerPrompt.ts).
// 2.1.302 turned fork sub-agents on for SDK sessions — the Agent tool began offering
// `subagent_type: "fork"`, a child carrying the parent's whole conversation, where the contract tells
// every worker each child starts fresh. That is the bump's to switch off in CLAUDE_WORKER_ENV
// (backend/types.ts), or to report when no switch exists. A probe with the switch set, compared again,
// proves it took.
import { readFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"

const [oldPath, newPath] = process.argv.slice(2)
if (!oldPath || !newPath) {
  console.error("usage: nub scripts/pin-bump/tools-diff.mjs <old.jsonl> <new.jsonl>")
  process.exit(1)
}

function offered(path) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    const record = JSON.parse(line)
    if (record.type !== "api-request-shape") continue
    return { version: record.version, tools: new Map((record.shape?.tools ?? []).map((tool) => [tool.name, tool])) }
  }
  throw new Error(`${path} has no api-request-shape record (written by Claude Code 2.1.300 and later)`)
}

const before = offered(oldPath)
const after = offered(newPath)
console.log(`${before.version}: ${before.tools.size} tools · ${after.version}: ${after.tools.size} tools`)
const added = [...after.tools.keys()].filter((name) => !before.tools.has(name)).sort()
const removed = [...before.tools.keys()].filter((name) => !after.tools.has(name)).sort()
console.log("added:", added.join(", ") || "none")
console.log("removed:", removed.join(", ") || "none")
const changed = [...before.tools.keys()].filter((name) => after.tools.has(name)).sort().filter((name) => {
  const a = before.tools.get(name), b = after.tools.get(name)
  return a.description !== b.description || !isDeepStrictEqual(a.input_schema, b.input_schema)
})
console.log("changed:", changed.join(", ") || "none")
for (const name of changed) {
  const a = before.tools.get(name), b = after.tools.get(name)
  console.log(`\n--- ${name}: description ${a.description?.length ?? 0} -> ${b.description?.length ?? 0} chars; input schema ${isDeepStrictEqual(a.input_schema, b.input_schema) ? "unchanged" : "CHANGED"}`)
  const oldLines = new Set((a.description ?? "").split("\n"))
  const newLines = new Set((b.description ?? "").split("\n"))
  for (const line of oldLines) if (!newLines.has(line) && line.trim()) console.log(`- ${line}`)
  for (const line of newLines) if (!oldLines.has(line) && line.trim()) console.log(`+ ${line}`)
}
