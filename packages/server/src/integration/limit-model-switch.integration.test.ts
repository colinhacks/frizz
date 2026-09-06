// THE MODEL-SCOPED CAP, END TO END: a real transcript record in, a real `claude` argv model out.
//
// The unit tests either side of this one each prove a link — the classifier reads "Fable 5" off the
// record, the scheduler picks the rung below, `deliverClaudeBrokerWake` forwards `row.model`. None of
// them proves the CHAIN, and the chain is where this feature can silently do nothing: the scheduler
// writes the new model to the registry, and the delivery re-reads the row from that same registry a
// moment later. A wake composed from a stale row would restart the thread on the model that just
// capped, look completely healthy from every unit test, and burn a fresh process per bounce.
//
// So this drives the REAL fold (the corpus-verified tailer over a real JSONL file), the REAL scheduler,
// the REAL registry and the REAL wake composition. The only stand-in is the broker's socket — a bridge
// that records what it was asked to fork with, which is precisely the value under test.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createIntegrationHarness } from "./harness.ts"
import { createScheduler } from "../scheduler.ts"
import { deliverClaudeBrokerWake } from "../context.ts"
import { mayHaveLiveBackgroundWork, needsFreshProcessForLimit } from "../backend/usage-limit.ts"

// Verbatim from the real 2026-08-31 transcript (CLI 2.1.251) — the same bytes the classifier's own
// pin carries. `stop_reason: "stop_sequence"` is neither end_turn nor tool_use, so the tailer lands the
// thread idle on its unknown-stop-reason backstop, which is what makes it a resume candidate at all.
const LIMIT_TEXT = "You've reached your Fable 5 limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."
const limitRecord = (at: string) => ({
  type: "assistant",
  timestamp: at,
  message: { model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: LIMIT_TEXT }] },
  error: "rate_limit",
  apiErrorStatus: 429,
  isApiErrorMessage: true,
})

interface Fork { model?: string; effort?: string; text: string; freshProcess?: boolean }

// The production wiring of the scheduler's `resume`, verbatim in shape (context.ts): re-read the row,
// recompute freshProcess off the live tail, compose the wake. Only the socket underneath is a recorder.
function schedulerOver(h: ReturnType<typeof createIntegrationHarness>, forks: Fork[]) {
  return createScheduler({
    // No quiet window here: this file pins its SOURCE, and hands one thread several wakes within a few
    // clock minutes. The window and the merge are pinned in scheduler.test.ts.
    wakeQuietWindowMs: 0,
    storage: h.storage,
    tailer: h.tailer,
    now: () => h.clockMs(),
    log: () => {},
    resume: (slug, message) => {
      const row = h.storage.getSession(slug)!
      return deliverClaudeBrokerWake({
        bridge: { followUp: async (input) => void forks.push({ model: input.model, effort: input.effort, text: input.text, freshProcess: input.freshProcess }) },
        slug,
        cwd: h.project.dir,
        row,
        settings: { permissionMode: "bypassPermissions" },
        deliveryMessage: message,
        freshProcess: needsFreshProcessForLimit(h.tailer.get(slug)?.limitFault, h.clockMs(), mayHaveLiveBackgroundWork(h.tailer.get(slug))),
      })
    },
  })
}

test("a Fable cap on a real transcript restarts the thread on Opus, with Opus in the fork options", async () => {
  const h = createIntegrationHarness()
  const forks: Fork[] = []
  try {
    const s = h.dispatch("capped")
    h.storage.setProfile("capped", "fable", "high")

    // The provider cuts the turn off mid-work.
    s.play({ kind: "record", record: limitRecord(new Date(h.clockMs()).toISOString()) })
    h.advance(6_000) // past the unknown-stop-reason backstop, so the thread reads as at rest
    await h.settle()
    const fault = h.telemetry("capped")?.limitFault
    assert.deepEqual(
      { window: fault?.window, model: fault?.model },
      { window: "model", model: "Fable 5" },
      "the real fold has to produce the model-scoped fault, or nothing below is being tested",
    )

    const scheduler = schedulerOver(h, forks)
    await scheduler.tick()

    assert.equal(forks.length, 1, "the capped thread is restarted rather than parked behind a weekly window")
    assert.equal(forks[0].model, "opus", "THE POINT: the fork that actually happens is on the rung below")
    assert.equal(forks[0].effort, "high", "the thread's own effort survives the switch")
    assert.equal(forks[0].freshProcess, true, "a live process latched on the 429 would refuse this, and would keep the old model anyway")
    assert.match(forks[0].text, /The Fable 5 limit that interrupted you is still closed — frizz restarted this thread on Opus\./)
    assert.equal(h.storage.getSession("capped")?.model, "opus", "and the registry agrees, so the composer selector reads Opus too")
    await scheduler.stop()
  } finally {
    h.close()
  }
})

// THE NEGATIVE CONTROL, and the reason it is in this file rather than beside the unit tests: it runs
// every link of the chain above and must still fork NOTHING. A harness that cannot produce this answer
// is a harness whose green above proves only that it forks.
test("the same cap on a thread NOT running Fable forks nothing at all", async () => {
  const h = createIntegrationHarness()
  const forks: Fork[] = []
  try {
    const s = h.dispatch("elsewhere")
    // Same account, same message — but this thread is already on Opus, so the model that ran out is one
    // a sibling thread (or a sub-agent of its own) was using. Stepping it down buys nothing.
    h.storage.setProfile("elsewhere", "opus", "high")
    s.play({ kind: "record", record: limitRecord(new Date(h.clockMs()).toISOString()) })
    h.advance(6_000)
    await h.settle()
    assert.equal(h.telemetry("elsewhere")?.limitFault?.window, "model", "the fault is identical; only the thread's model differs")

    const scheduler = schedulerOver(h, forks)
    await scheduler.tick()
    h.advance(2 * 60 * 60_000)
    await scheduler.tick()

    assert.deepEqual(forks, [], "no endpoint could say the cap had lifted, so the thread waits — as every other limit does")
    assert.equal(h.storage.getSession("elsewhere")?.model, "opus", "and its profile is left exactly as the operator set it")
    await scheduler.stop()
  } finally {
    h.close()
  }
})
