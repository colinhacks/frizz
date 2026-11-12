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

// Claude Code writes "No response requested." as a `<synthetic>` assistant record on a cold resume, just
// ahead of the message it delivers. Read as the model's last word, it cleared the rest's fence the instant
// before the reply reached the fold, and the reply settled nothing: the steps vanished from the list.
const placeholder = (ts: string) => ({ type: "assistant", isApiErrorMessage: false, timestamp: ts, message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "No response requested." }] } })

test("a cold resume's placeholder record leaves the rest's steps for the reply to settle", () => {
  const rest = assistant("2026-11-09T10:00:00.000Z", fence(SIGN_IN, APPROVE))
  const asked = fold(rest, placeholder("2026-11-09T11:00:00.000Z") as Rec, humanString("2026-11-09T11:00:01.000Z", "Can you explain step 2 first?"))
  assert.deepEqual(owed(asked), [SIGN_IN, APPROVE], "a reply in words lists the steps, the same as with no placeholder")
  const done = fold(rest, placeholder("2026-11-09T11:00:00.000Z") as Rec, humanString("2026-11-09T11:00:01.000Z", "Done"))
  assert.deepEqual(owed(done), [], "and a Done closes them")
  const resting = fold(rest, placeholder("2026-11-09T11:00:00.000Z") as Rec)
  assert.equal(resting.lastFence?.kind, "awaiting", "the rest is still the thread's last word")
  assert.equal(resting.lastAssistantAt, "2026-11-09T10:00:00.000Z", "and its rest time is the worker's own")
})
