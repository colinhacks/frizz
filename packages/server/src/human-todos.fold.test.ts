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

// A done sign-off retires what the list still owes unticked, and not only while it stands: the view hid
// those items behind the live done fence and showed them again the moment the human typed anything.
const doneFence = "Shipped.\n\n```done\n- **Tagged** the release; npm skipped as asked.\n```"

test("a done rest retires the steps the list still owes, past the human's next message", () => {
  const state = fold(
    assistant("2026-11-09T10:00:00.000Z", fence(SIGN_IN, APPROVE)),
    humanString("2026-11-09T10:05:00.000Z", "skip npm, just tag it"),
    assistant("2026-11-09T10:10:00.000Z", doneFence),
    humanString("2026-11-10T09:00:00.000Z", "New task: bump the docs"),
  )
  assert.deepEqual(owed(state), [])
  // …and a later fence that lists one again owes it again: the worker needs it after all.
  const relisted = fold(
    assistant("2026-11-09T10:00:00.000Z", fence(SIGN_IN, APPROVE)),
    humanString("2026-11-09T10:05:00.000Z", "skip npm, just tag it"),
    assistant("2026-11-09T10:10:00.000Z", doneFence),
    humanString("2026-11-10T09:00:00.000Z", "Actually publish it"),
    assistant("2026-11-10T09:05:00.000Z", fence(APPROVE)),
    humanString("2026-11-10T09:10:00.000Z", "Which account?"),
  )
  assert.deepEqual(owed(relisted), [APPROVE])
})

test("humanTodoView: a registered done retires what no fence has listed since", () => {
  const steps: HumanStep[] = [
    { id: "a", text: SIGN_IN, listedAt: 1_000, listed: true },
    { id: "b", text: APPROVE, listedAt: 5_000, listed: true },
  ]
  const shown = (retiredAt?: number, ticks: { item_id: string; done_at: number | null; reported_at: number | null }[] = []) =>
    humanTodoView(steps, ticks, { retiredAt }).map((todo) => `${todo.text}${todo.done ? " ✓" : ""}`)
  assert.deepEqual(shown(undefined), [SIGN_IN, APPROVE])
  assert.deepEqual(shown(3_000), [APPROVE], "listed before the done: given up on; listed after it: owed")
  assert.deepEqual(shown(3_000, [{ item_id: "a", done_at: 2_000, reported_at: null }]), [`${SIGN_IN} ✓`, APPROVE], "a ticked one stays as the record")
})

// AN EMPTY `steps:` TAKES WHAT IS UNTICKED OFF THE LIST, for good, the way a done does: the worker's way to
// say nothing on it is owed any more. The usual case: the rest ended on a wake that showed the steps done.
test("a rest on an empty steps line retires what the list still owes, past the human's next message", () => {
  const wake = "Monitor PASSED: the registrar claim is live.\n\n<!-- frizz-wake:0a1b2c3d -->"
  const cleared = "Confirmed live.\n\n```awaiting\nsteps: []\nstatus: watching\nfor: 1h\n```"
  const state = fold(
    assistant("2026-11-09T10:00:00.000Z", fence(SIGN_IN, APPROVE)),
    humanString("2026-11-09T10:20:00.000Z", wake),
    assistant("2026-11-09T10:21:00.000Z", cleared),
    humanString("2026-11-09T11:00:00.000Z", "Anything else?"),
  )
  assert.deepEqual(owed(state), [], "nothing owed, though the human has typed since")
  assert.equal(state.stepsDoneAt, "2026-11-09T10:21:00.000Z", "and the handoff that listed them is answered")
  // Control: the same park with no `steps:` key leaves both owed.
  const kept = fold(
    assistant("2026-11-09T10:00:00.000Z", fence(SIGN_IN, APPROVE)),
    humanString("2026-11-09T10:20:00.000Z", wake),
    assistant("2026-11-09T10:21:00.000Z", "Confirmed live.\n\n```awaiting\nstatus: watching\nfor: 1h\n```"),
    humanString("2026-11-09T11:00:00.000Z", "Anything else?"),
  )
  assert.deepEqual(owed(kept), [SIGN_IN, APPROVE])
  // A ticked step stays on the list as the record of what was done.
  assert.deepEqual(humanTodoView(state.humanSteps, [{ item_id: state.humanSteps![0].id, done_at: Date.parse("2026-11-09T10:10:00.000Z"), reported_at: null }]).map((todo) => [todo.text, todo.done]), [[SIGN_IN, true]])
})
