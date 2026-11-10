import { test } from "node:test"
import assert from "node:assert/strict"
import { sendNowStep } from "./deliverQueuedNow.ts"

// ONE PRESS, ONE STEP — what Send now does, whether it is clicked or pressed with ⌘⏎ (lib/sendNowKey):
// what Frizz holds goes to the agent's next step first; only once nothing is held is a queued steer
// pushed through, and only where the runtime can be preempted. Null is "nothing to press", which is
// also when the control draws nothing and the chord is left alone.

test("a held run is released first, interruptible or not", () => {
  assert.equal(sendNowStep({ held: 2, steered: 0 }, true), "release")
  assert.equal(sendNowStep({ held: 1, steered: 3 }, true), "release", "a mixed run takes two presses to interrupt")
  assert.equal(sendNowStep({ held: 1, steered: 0 }, false), "release", "Frizz releases what it holds on any runtime")
})

test("a queued steer is pushed through only where the turn can be interrupted", () => {
  assert.equal(sendNowStep({ held: 0, steered: 2 }, true), "interrupt")
  assert.equal(sendNowStep({ held: 0, steered: 2 }, false), null, "a codex steer is already in the turn")
})

test("nothing queued is nothing to press", () => {
  assert.equal(sendNowStep({ held: 0, steered: 0 }, true), null)
  assert.equal(sendNowStep({ held: 0, steered: 0 }, false), null)
})

test("an agent with no steer has no Send now at all: nothing it holds can reach the turn early", () => {
  assert.equal(sendNowStep({ held: 2, steered: 0 }, false, false), null)
  assert.equal(sendNowStep({ held: 0, steered: 1 }, false, false), null)
})
