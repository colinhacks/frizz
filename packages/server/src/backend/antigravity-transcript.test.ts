import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { antigravityToolCalls, cleanAntigravityReasoning, projectAntigravityTranscript } from "./antigravity-transcript.ts"

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

test("antigravity-transcript: strips the thinking placeholder, marks real reasoning inline, and keeps tool runs merged across filler", () => {
  assert.equal(cleanAntigravityReasoning("I'm thinking through how to approach this.\n\n\n"), "")
  assert.equal(cleanAntigravityReasoning("I’m thinking through how to approach this."), "")
  assert.equal(
    cleanAntigravityReasoning("I'm thinking through how to approach this.\n\n\nInspecting `src/router.ts` first.\n\n\nNext: check tests."),
    "Inspecting `src/router.ts` first.\n\nNext: check tests.",
  )

  const raw = [
    { kind: "user-message", at: "t0", text: "Fix it", synthetic: false },
    { kind: "turn-start", at: "t0" },
    { kind: "reasoning", at: "t1", text: "I'm thinking through how to approach this.\n\n\n" },
    { kind: "tool-call", at: "t2", id: "c1", name: "Read", input: { file_path: "/a.ts" } },
    { kind: "tool-result", at: "t3", id: "c1", text: "ok" },
    // Solo filler between two tool calls drops out without closing the assistant message.
    { kind: "reasoning", at: "t4", text: "I'm thinking through how to approach this." },
    { kind: "tool-call", at: "t5", id: "c2", name: "Edit", input: { file_path: "/a.ts" } },
    { kind: "tool-result", at: "t6", id: "c2", text: "edited" },
    // Leading filler is stripped; surviving summary renders inline.
    { kind: "reasoning", at: "t7", text: "I'm thinking through how to approach this.\n\n\nRunning the test suite to verify the fix." },
    { kind: "tool-call", at: "t8", id: "c3", name: "Bash", input: { command: "npm test" } },
    { kind: "tool-result", at: "t9", id: "c3", text: "pass" },
    { kind: "assistant-text", at: "t10", text: "Fixed.", final: true, messageId: "m1" },
    { kind: "turn-end", at: "t10", finalText: "Fixed.", successful: true },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n"

  const msgs = projectAntigravityTranscript(raw, "antigravity:s1", (b) => [{ name: b.name }])
  assert.deepEqual(
    msgs.map((m) => [m.role, m.kind ?? "message", m.reasoningInline ?? false, m.tools.length, m.text]),
    [
      ["user", "message", false, 0, "Fix it"],
      ["assistant", "message", false, 2, ""],
      ["assistant", "reasoning", true, 0, "Running the test suite to verify the fix."],
      ["assistant", "message", false, 1, "Fixed."],
    ],
  )
})
