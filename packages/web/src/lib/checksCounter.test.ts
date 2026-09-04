// THE WATCHER ROW'S COUNTER — one number, chosen by severity.
//
// The strip under the prompt box is on screen while the thread WORKS; the awaiting card that renders the
// full check reading is only drawn at REST. So a watcher row said a ref and an age and nothing else, and
// a maintainer watching a thread grind could not tell a red PR from a green one (2026-09-04: "It does
// not appear to me that the PR watcher is working well here").
//
// The order below must stay in step with `checkCountLine`'s (AwaitingBackgroundCard): the two surfaces
// render the same fact, and leading on different numbers is how they would drift apart.
import { test } from "node:test"
import assert from "node:assert/strict"
import { checksCounterLabel } from "./childOps.ts"

const status = (over: Record<string, unknown>) => ({
  checks: "running", failed: 0, gated: 0, running: 0, passed: 0, state: "open", ...over,
} as Parameters<typeof checksCounterLabel>[0])

test("the counter leads on what decides the next move", () => {
  // Red first, and it outranks everything beside it — a gated workflow and 31 greens do not change what
  // the human does about a failed build.
  assert.equal(checksCounterLabel(status({ checks: "failing", failed: 1, gated: 9, running: 2, passed: 31 })), "1 failed")
  // Then the gate, which outranks "running" because it is the one state that never resolves by itself.
  assert.equal(checksCounterLabel(status({ gated: 9, running: 2, passed: 3 })), "9 held")
  assert.equal(checksCounterLabel(status({ running: 14, passed: 15 })), "14 running")
  assert.equal(checksCounterLabel(status({ checks: "passing", passed: 29 })), "29 green")
})

test("a reading frizz does not have is absent, never a zero", () => {
  // Never polled: the row's own liveness mark already says the watcher is armed, and "0" would claim a
  // fact — that CI reported nothing — which is a different thing from not having looked.
  assert.equal(checksCounterLabel(undefined), undefined)
  // A PR with no CI at all. Nothing to count, and every counter branch would have to invent a number.
  assert.equal(checksCounterLabel(status({ checks: "none" })), undefined)
})

test("a finished PR says so instead of counting its history", () => {
  assert.equal(checksCounterLabel(status({ state: "merged", passed: 29, checks: "passing" })), "merged")
  assert.equal(checksCounterLabel(status({ state: "closed", failed: 3, checks: "failing" })), "closed")
})
