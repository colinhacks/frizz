import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { store, topThreadSlug } from "../store.ts"
import { openStartedThread, screenNow } from "./openStartedThread.ts"

// Node has no window, so a thread opens here as it does on a phone, in a drawer (store.ts paneEnabled);
// topThreadSlug reads the pane and the drawers alike, and the desktop pane is driven in a browser by
// queueRailSettle.e2e.test.ts.

function setBoard(...ids: string[]): void {
  store.board = { threads: ids.map((id) => ({ id, title: id, runtime: "running" }) as unknown as ThreadView), errors: [] } as unknown as BoardSnapshot
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  store.view = "todos"
  store.drawers = []
  store.paneSlug = null
  setBoard("a", "b")
})

test("a thread already on the board when the call answers opens at once", () => {
  const screen = screenNow()
  setBoard("a", "b", "started")
  assert.equal(openStartedThread("started", screen), true)
  assert.equal(topThreadSlug(), "started")
})

test("a thread the board has not shown yet opens when its row lands", async () => {
  const screen = screenNow()
  assert.equal(openStartedThread("late", screen), true)
  await settle()
  assert.equal(topThreadSlug(), null, "nothing opens before the row does")
  setBoard("a", "b", "late")
  await settle()
  assert.equal(topThreadSlug(), "late")
})

test("a human who opened another thread during the call is left on it", async () => {
  const screen = screenNow()
  store.drawers.push({ id: 900, kind: "thread", slug: "b", openedAt: 900 } as (typeof store.drawers)[number])
  setBoard("a", "b", "started")
  assert.equal(openStartedThread("started", screen), false)
  assert.equal(topThreadSlug(), "b")
})

test("moving on after the answer but before the row lands also keeps the thread shut", async () => {
  const screen = screenNow()
  assert.equal(openStartedThread("late", screen), true)
  store.view = "status:done"
  setBoard("a", "b", "late")
  await settle()
  assert.equal(topThreadSlug(), null)
})

test("two prompts sent back to back end on the second thread", () => {
  const first = screenNow()
  const second = screenNow()
  setBoard("a", "b", "one", "two")
  assert.equal(openStartedThread("one", first), true)
  assert.equal(openStartedThread("two", second), true, "the screen the first opening left is not the human moving on")
  assert.equal(topThreadSlug(), "two")
})
