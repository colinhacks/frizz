import assert from "node:assert/strict"
import test from "node:test"
import { applyRecord, newTailState } from "./tailer.ts"
import { humanTodoView, type HumanStep } from "./human-todos.ts"

// THE TO-DO LIST AS THE FOLD BUILDS IT FROM CLAUDE RECORDS, written the way the CLI writes them: a typed
// prompt's content is a bare STRING (2,754 of 2,834 human prompts over two days on this Mac, 2026-11-11),
// and only some records carry a block list. human-todos.test.ts drives the Codex fold; this one drives
// the Claude fold, whose user records come in both shapes.

const fence = (...steps: string[]) => `Handing over.\n\n\`\`\`awaiting\nsteps:\n${steps.map((s) => `  - ${s}`).join("\n")}\n---\nOver to you.\n\`\`\``
const assistant = (ts: string, text: string) => ({ type: "assistant", timestamp: ts, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } })
const humanString = (ts: string, text: string) => ({ type: "user", timestamp: ts, message: { role: "user", content: text } })
const humanBlocks = (ts: string, text: string) => ({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } })
type Rec = ReturnType<typeof assistant> | ReturnType<typeof humanString> | ReturnType<typeof humanBlocks>
const fold = (...recs: Rec[]) => {
  const state = newTailState("t", "sid", "/nowhere.jsonl")
  for (const rec of recs) applyRecord(state, rec as Parameters<typeof applyRecord>[1])
  return state
}
const owed = (state: { humanSteps?: HumanStep[]; lastFence?: { kind: string } }) =>
  humanTodoView(state.humanSteps, [], { finished: state.lastFence?.kind === "done" }).filter((todo) => !todo.done).map((todo) => todo.text)

const SIGN_IN = "Sign in to npm"
const APPROVE = "Approve the publish"

test("a `Done` typed as a plain string closes the steps of the rest it answers", () => {
  const state = fold(assistant("2026-11-09T10:00:00.000Z", fence(SIGN_IN, APPROVE)), humanString("2026-11-09T10:05:00.000Z", "Done"))
  assert.deepEqual(owed(state), [], "the human replied with the word the contract names")
})

test("…as a block list too, the shape the reader always handled", () => {
  const state = fold(assistant("2026-11-09T10:00:00.000Z", fence(SIGN_IN, APPROVE)), humanBlocks("2026-11-09T10:05:00.000Z", "Done"))
  assert.deepEqual(owed(state), [])
})

test("a plain-string reply in words leaves the steps owed", () => {
  const state = fold(assistant("2026-11-09T10:00:00.000Z", fence(SIGN_IN, APPROVE)), humanString("2026-11-09T10:05:00.000Z", "Which account should approve it?"))
  assert.deepEqual(owed(state), [SIGN_IN, APPROVE])
})
