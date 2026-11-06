import assert from "node:assert/strict"
import { test } from "node:test"
import { derivePlainReport } from "./board.ts"

// What a pin may quieten, and what it may not (maintainer 2026-11-06). Every rest below queued the thread;
// only the report leaves the queue on a pinned thread, so each ask and failure has to read as neither.
const report = {
  needsYou: true,
  runtime: "turn-idle" as const,
  actionableInteraction: false,
  pendingAsk: false,
  pendingQuestion: false,
  standingQuestions: 0,
  humanSteps: false,
  crashed: false,
  limitPause: false,
  providerError: false,
}

test("a rest that asks nothing and did not fail is a plain report", () => {
  assert.equal(derivePlainReport(report), true)
  assert.equal(derivePlainReport({ ...report, runtime: "exited" }), true, "a process that ended cleanly has nothing to retry")
})

test("a rest out of the queue is no report at all", () => {
  assert.equal(derivePlainReport({ ...report, needsYou: false }), false)
})

for (const [name, over] of Object.entries({
  "a typed interaction": { actionableInteraction: true },
  "a permission prompt": { runtime: "perm-prompt" as const },
  "a native ask": { pendingAsk: true },
  "a fenced question": { pendingQuestion: true },
  "a registered question that stands": { standingQuestions: 1 },
  "a steps list": { humanSteps: true },
  "a crash": { runtime: "exited" as const, crashed: true },
  "a usage-limit stop": { limitPause: true },
  "a provider error it is not retrying": { providerError: true },
})) {
  test(`${name} still takes a turn in the queue`, () => {
    assert.equal(derivePlainReport({ ...report, ...over }), false)
  })
}
