import { test } from "node:test"
import assert from "node:assert/strict"
import { SIGNOFF_NUDGE_MESSAGE } from "@frizz/shared"
import { foldSummary, stretchFoldRanges, type FoldMsg } from "./stretchFolds.ts"

const T0 = Date.parse("2026-11-11T10:00:00.000Z")
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString()
const human = (text: string, minute = 0): FoldMsg => ({ role: "user", text, at: at(minute) })
const wake = (text: string, minute = 0): FoldMsg => ({ role: "user", text, wake: true, at: at(minute) })
const say = (text: string, minute = 0, signOff?: true): FoldMsg => ({ role: "assistant", text, signOff, at: at(minute) })
const work = (text: string, minute = 0, calls = 1): FoldMsg => ({ role: "assistant", text, tools: Array.from({ length: calls }, () => ({})), at: at(minute) })
const rest = (minute = 0): FoldMsg => ({ role: "assistant", kind: "event", text: "Agent rested", at: at(minute) })
const park = (minute = 0): FoldMsg => say("```awaiting\nstatus: watching\nfor: 1d\n```", minute)

// The reylo shape: narration between tool calls, a sign-off, then wakes the worker parked quietly on.
const reylo: FoldMsg[] = [
  human("Fix the geometry values.", 0),
  work("Reading the converter.", 1, 3), work("Found it; patching.", 2, 2), work("Running the suite.", 5, 4),
  say("**Fixed** — geometry values round-trip.", 9, true), rest(9),
  wake("CI passed", 30), park(31), rest(31),
  wake("Review comment", 50), work("Looking.", 51, 1), park(52), rest(52),
]

test("a stretch folds the run before its sign-off and, at rest, the run after it", () => {
  assert.deepEqual(stretchFoldRanges(reylo, { running: false }), [{ from: 1, to: 3 }, { from: 5, to: 12 }])
})

test("while the thread runs, the newest stretch keeps its tail: that is the live work", () => {
  assert.deepEqual(stretchFoldRanges(reylo, { running: true }), [{ from: 1, to: 3 }])
  // An earlier stretch's tail still folds.
  const later = [...reylo, human("Also the polygons.", 60), work("On it.", 61)]
  assert.deepEqual(stretchFoldRanges(later, { running: true }), [{ from: 1, to: 3 }, { from: 5, to: 12 }])
})

test("a stretch with no sign-off folds nothing", () => {
  assert.deepEqual(stretchFoldRanges([human("Go."), work("Working."), work("Still working."), park(), rest()], { running: false }), [])
  assert.deepEqual(stretchFoldRanges([], { running: false }), [])
})

test("the newest sign-off replaces the earlier ones, which fold with the work", () => {
  const messages = [human("Go."), work("Step one."), say("First hand-off.", 1, true), rest(), wake("CI failed"), work("Fixing."), say("Whole new hand-off.", 9, true), rest()]
  assert.deepEqual(stretchFoldRanges(messages, { running: false }), [{ from: 1, to: 5 }, { from: 7, to: 7 }])
})

test("a sign-off answering Frizz's reminder keeps the write-up it points back to", () => {
  const messages = [human("Go."), work("Working."), say("The whole write-up.", 1, true), rest(), wake(SIGNOFF_NUDGE_MESSAGE), say("```done\n- Fixed.\n```", 2, true), rest()]
  // Nothing between the write-up and its fence is worth a fold of its own; the transcript folds runs of two
  // rows or more, so the reminder and its rest stay where they are.
  assert.deepEqual(stretchFoldRanges(messages, { running: false }), [{ from: 1, to: 1 }, { from: 3, to: 4 }, { from: 6, to: 6 }])
})

test("a page opening mid-stretch folds that stretch too", () => {
  const page = [work("Patching.", 3), work("Testing.", 4), say("Fixed.", 5, true), rest(5)]
  assert.deepEqual(stretchFoldRanges(page, { running: false }), [{ from: 0, to: 1 }, { from: 3, to: 3 }])
})

test("each stretch folds on its own", () => {
  const messages = [human("One."), work("a"), work("b"), say("Done one.", 1, true), human("Two."), work("c"), say("Done two.", 2, true)]
  assert.deepEqual(stretchFoldRanges(messages, { running: false }), [{ from: 1, to: 2 }, { from: 5, to: 5 }])
})

test("the fold row says how long the run took and what is in it", () => {
  assert.equal(foldSummary(reylo, { from: 1, to: 3 }), "Worked 5m · 3 messages · 9 tool calls")
  // A bare park fence says nothing, so it is not a message; the wakes are counted.
  assert.equal(foldSummary(reylo, { from: 5, to: 12 }), "Worked 43m · 1 message · 1 tool call · 2 wakes")
  // Under a minute reads as the counts alone.
  assert.equal(foldSummary([human("Go."), work("Quick.", 0, 2)], { from: 1, to: 1 }), "1 message · 2 tool calls")
  assert.equal(foldSummary([human("Go."), rest()], { from: 1, to: 1 }), "Earlier activity")
})
