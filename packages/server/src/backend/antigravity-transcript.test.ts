import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { antigravityToolCalls } from "./antigravity-transcript.ts"

// What the bridge asks of a transcript when it reattaches to a running agent.

function file(lines: Array<Record<string, unknown> | string>): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agy-transcript-"))
  const path = join(dir, "s1.jsonl")
  writeFileSync(path, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n")
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("antigravity-transcript: the calls a file holds are those with a result and those still running", () => {
  const f = file([
    { kind: "turn-start", at: "t" },
    { kind: "tool-call", at: "t", id: "done-1", name: "Bash", input: { command: "ls" } },
    { kind: "tool-result", at: "t", id: "done-1", text: "a" },
    { kind: "tool-call", at: "t", id: "daemon-1", name: "Bash", input: { command: "sleep 600", run_in_background: true } },
    { kind: "tool-call", at: "t", id: "abandoned-1", name: "Bash", input: { command: "never settled" } },
    { kind: "turn-end", at: "t", successful: true },
    "not a record at all",
    { kind: "turn-start", at: "t" },
    { kind: "tool-call", at: "t", id: "running-1", name: "Read", input: { file_path: "/p/a.ts" } },
  ])
  try {
    assert.deepEqual(antigravityToolCalls(f.path), {
      settled: ["done-1"],
      open: [
        { id: "daemon-1", name: "Bash", background: true, inOpenTurn: false },
        { id: "abandoned-1", name: "Bash", background: false, inOpenTurn: false },
        { id: "running-1", name: "Read", background: false, inOpenTurn: true },
      ],
    })
    assert.deepEqual(antigravityToolCalls(join(tmpdir(), "no-such-transcript.jsonl")), { settled: [], open: [] })
  } finally { f.cleanup() }
})
