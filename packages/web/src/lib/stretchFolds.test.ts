import { test } from "node:test"
import assert from "node:assert/strict"
import { SIGNOFF_NUDGE_MESSAGE } from "@frizz/shared"
import { foldCounts, stretchFoldRanges, type FoldMsg } from "./stretchFolds.ts"

const human = (text: string): FoldMsg => ({ role: "user", text })
const wake = (text: string): FoldMsg => ({ role: "user", text, wake: true })
const say = (text: string, signOff?: true): FoldMsg => ({ role: "assistant", text, signOff })
const work = (text: string, calls = 1): FoldMsg => ({ role: "assistant", text, tools: Array.from({ length: calls }, () => ({})) })
const rest = (): FoldMsg => ({ role: "assistant", kind: "event", text: "Agent rested" })
const park = (): FoldMsg => say("```awaiting\nstatus: watching\nfor: 1d\n```")

// The reylo shape: narration between tool calls, a sign-off, then wakes the worker parked quietly on.
const reylo: FoldMsg[] = [
  human("Fix the geometry values."),
  work("Reading the converter.", 3), work("Found it; patching.", 2), work("Running the suite.", 4),
  say("**Fixed** — geometry values round-trip.", true), rest(),
  wake("CI passed"), park(), rest(),
  wake("Review comment"), work("Looking.", 1), park(), rest(),
]

test("a stretch keeps its first words and its sign-off, and folds the run between and, at rest, after", () => {
  assert.deepEqual(stretchFoldRanges(reylo, { running: false }), [{ from: 2, to: 3, lead: 1 }, { from: 5, to: 12 }])
})

test("while the thread runs, the newest stretch keeps its tail: that is the live work", () => {
  assert.deepEqual(stretchFoldRanges(reylo, { running: true }), [{ from: 2, to: 3, lead: 1 }])
  // An earlier stretch's tail still folds.
  const later = [...reylo, human("Also the polygons."), work("On it.")]
  assert.deepEqual(stretchFoldRanges(later, { running: true }), [{ from: 2, to: 3, lead: 1 }, { from: 5, to: 12 }])
})

test("a stretch with no sign-off folds nothing", () => {
  assert.deepEqual(stretchFoldRanges([human("Go."), work("Working."), work("Still working."), park(), rest()], { running: false }), [])
  assert.deepEqual(stretchFoldRanges([], { running: false }), [])
})

test("the lead is the first message with words: a bare park fence or a tool-only turn is not", () => {
  const messages = [human("Go."), work("", 2), park(), work("Starting on it."), work("More.", 2), say("Done.", true)]
  assert.deepEqual(stretchFoldRanges(messages, { running: false }), [{ from: 4, to: 4, lead: 3 }])
  // With no words before the sign-off there is no lead, and the whole run folds.
  assert.deepEqual(stretchFoldRanges([human("Go."), work("", 2), work("", 1), say("Done.", true)], { running: false }), [{ from: 1, to: 2 }])
})

test("the newest sign-off replaces the earlier ones, which fold with the work", () => {
  const messages = [human("Go."), work("Step one."), say("First hand-off.", true), rest(), wake("CI failed"), work("Fixing."), say("Whole new hand-off.", true), rest()]
  assert.deepEqual(stretchFoldRanges(messages, { running: false }), [{ from: 2, to: 5, lead: 1 }, { from: 7, to: 7 }])
})

test("a sign-off answering Frizz's reminder keeps the write-up it points back to", () => {
  const messages = [human("Go."), work("Working."), say("The whole write-up.", true), rest(), wake(SIGNOFF_NUDGE_MESSAGE), say("```done\n- Fixed.\n```", true), rest()]
  // The lead sits right above the write-up, so nothing folds before it. The transcript folds runs of two
  // rows or more, so the reminder and its rest stay where they are.
  assert.deepEqual(stretchFoldRanges(messages, { running: false }), [{ from: 3, to: 4 }, { from: 6, to: 6 }])
})

test("a page opening mid-stretch folds that stretch too, with no lead: its first words are further up", () => {
  const page = [work("Patching."), work("Testing."), say("Fixed.", true), rest()]
  assert.deepEqual(stretchFoldRanges(page, { running: false }), [{ from: 0, to: 1 }, { from: 3, to: 3 }])
})

test("each stretch folds on its own", () => {
  const messages = [human("One."), work("a"), work("b"), say("Done one.", true), human("Two."), work("c"), say("Done two.", true)]
  assert.deepEqual(stretchFoldRanges(messages, { running: false }), [{ from: 2, to: 2, lead: 1 }])
})

test("a hairline counts the rounds begun inside it and every tool call, the lead's included", () => {
  assert.deepEqual(foldCounts(reylo, { from: 2, to: 3, lead: 1 }), { rounds: 0, calls: 9 })
  assert.deepEqual(foldCounts(reylo, { from: 5, to: 12 }), { rounds: 2, calls: 1 })
  // A background task's return re-invokes the worker as a wake boundary, not a user message.
  const returned: FoldMsg = { role: "assistant", kind: "event", text: "Background command completed", boundary: "wake" }
  assert.deepEqual(foldCounts([human("Go."), work("a", 2), returned, work("b", 1)], { from: 1, to: 3 }), { rounds: 1, calls: 3 })
})
