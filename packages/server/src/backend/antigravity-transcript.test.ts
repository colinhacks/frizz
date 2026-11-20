import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { antigravityToolCalls, antigravityTurnOpen } from "./antigravity-transcript.ts"

// What a bridge asks of a transcript when it reattaches to a running agent, or finds its agent gone.

function file(lines: Array<Record<string, unknown> | string>): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agy-transcript-"))
  const path = join(dir, "s1.jsonl")
  writeFileSync(path, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n")
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("antigravity-transcript: a turn is open when the file's last turn marker is a start", () => {
  const open = file([{ kind: "turn-start", at: "t" }, { kind: "turn-end", at: "t", successful: true }, { kind: "user-message", at: "t", text: "go" }, { kind: "turn-start", at: "t" }, { kind: "assistant-text", at: "t", text: "working" }])
  const closed = file([{ kind: "turn-start", at: "t" }, { kind: "assistant-text", at: "t", text: 'the agent wrote "turn-start" in its answer' }, { kind: "turn-end", at: "t", successful: true }, { kind: "acp-note", at: "t", text: "after" }])
  const empty = file([])
  try {
    assert.equal(antigravityTurnOpen(open.path), true)
    assert.equal(antigravityTurnOpen(closed.path), false)
    assert.equal(antigravityTurnOpen(empty.path), false)
    assert.equal(antigravityTurnOpen(join(tmpdir(), "no-such-transcript.jsonl")), false)
  } finally { open.cleanup(); closed.cleanup(); empty.cleanup() }
})

test("antigravity-transcript: the last turn marker is found however far back it is, and across multi-byte text", () => {
  // The file is read from its end, 64KB at first. Here the marker is megabytes back, and the windows
  // open in the middle of lines made of three-byte characters.
  const filler = { kind: "assistant-text", at: "t", text: "世界".repeat(3_000) }
  const longTurn = file([{ kind: "turn-start", at: "t" }, { kind: "turn-end", at: "t", successful: true }, { kind: "turn-start", at: "t" }, ...Array.from({ length: 200 }, () => filler)])
  const longAfter = file([{ kind: "turn-start", at: "t" }, { kind: "turn-end", at: "t", successful: true }, ...Array.from({ length: 200 }, () => filler)])
  try {
    assert.equal(antigravityTurnOpen(longTurn.path), true)
    assert.equal(antigravityTurnOpen(longAfter.path), false)
  } finally { longTurn.cleanup(); longAfter.cleanup() }
})

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
