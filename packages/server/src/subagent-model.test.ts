import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readObservedChildModel } from "./subagent-model.ts"

// The model a child ran, off its own transcript: what names the edition of a child dispatched on
// another family than its parent's. Each test writes its own file, because the reader caches per path.

const assistant = (model: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", isSidechain: true, message: { model, role: "assistant", content: [{ type: "text", text: "…" }] }, ...extra })
const prompt = JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "go" } })

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "subagent-model-"))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("the child's latest real request names its model; an API-error bubble does not", () => {
  withDir((dir) => {
    const path = join(dir, "agent-a.jsonl")
    writeFileSync(path, [prompt, assistant("claude-sonnet-5-5"), assistant("<synthetic>", { isApiErrorMessage: true }), ""].join("\n"))
    assert.equal(readObservedChildModel(path), "claude-sonnet-5-5")
  })
})

test("a child that has not answered yet names nothing, and is read again once it grows", () => {
  withDir((dir) => {
    const path = join(dir, "agent-b.jsonl")
    writeFileSync(path, `${prompt}\n`)
    assert.equal(readObservedChildModel(path), undefined)
    appendFileSync(path, `${assistant("claude-haiku-4-5-20251001")}\n`)
    assert.equal(readObservedChildModel(path), "claude-haiku-4-5-20251001")
  })
})

test("an answer outside the tail window is still found, by one whole read", () => {
  withDir((dir) => {
    const path = join(dir, "agent-c.jsonl")
    // One tool result bigger than the 256KB tail, AFTER the only assistant record.
    const huge = JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(400 * 1024) }] } })
    writeFileSync(path, [prompt, assistant("claude-opus-5-5"), huge, ""].join("\n"))
    assert.equal(readObservedChildModel(path), "claude-opus-5-5")
  })
})

test("a missing transcript names nothing and never throws", () => {
  withDir((dir) => {
    assert.equal(readObservedChildModel(join(dir, "agent-gone.jsonl")), undefined)
  })
})
