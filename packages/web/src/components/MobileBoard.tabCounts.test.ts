import assert from "node:assert/strict"
import { test } from "node:test"
import { queueTabCounts } from "./MobileBoard.tsx"

test("the phone's Queue tab shows who is asking, then how many it lists", () => {
  assert.deepEqual(queueTabCounts(2, 5), { asks: 2, listed: 5 })
  assert.deepEqual(queueTabCounts(0, 5), { listed: 5 }, "nobody asking: the one muted number, as before")
  assert.deepEqual(queueTabCounts(0, 0), {}, "an empty queue shows no number")
})

test("a number that would repeat the one before it is not shown", () => {
  // "Queue 1 · 1": one thread, and it is asking.
  assert.deepEqual(queueTabCounts(1, 1), { asks: 1 })
  assert.deepEqual(queueTabCounts(4, 4), { asks: 4 })
  // An ask the tab does not list (a snoozed thread with a question) keeps both.
  assert.deepEqual(queueTabCounts(3, 2), { asks: 3, listed: 2 })
})
