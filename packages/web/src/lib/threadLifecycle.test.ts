import { test } from "node:test"
import assert from "node:assert/strict"
import type { CompletionHold, ThreadView } from "@frizz/shared"
import { threadLifecycleAvailability, completionArchivesImmediately, completionHoldCanKeepRunning, completionHoldSummary } from "./threadLifecycle.ts"

function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: "owned-thread",
    title: "Owned thread",
    status: "active",
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "turn-idle",
    unread: false,
    archived: false,
    hasPlan: false,
    subAgents: [],
    bgShells: [],
    watches: [],
    pendingQuestion: false,
    questions: [],
    kind: "session",
    foreign: false,
    state: "open",
    needsYou: true,
    crashed: false,
    actionableInteraction: false,
    ...over,
  }
}

test("thread lifecycle controls have one home independent of queue/done presentation", () => {
  assert.deepEqual(threadLifecycleAvailability(thread()), {
    lifecycle: true,
    done: false,
    snooze: true,
    archive: true,
  })
  assert.deepEqual(threadLifecycleAvailability(thread({ lastFence: { kind: "done", body: "Shipped", hints: [] } })), {
    lifecycle: true,
    done: false,
    snooze: true,
    archive: true,
  }, "a done fence cannot move Archive inline or into a header")
  // An archived thread has no lifecycle VERBS — reopening is done by sending it another message, not a
  // Reopen button — but it KEEPS the strip, which reads "Done" where the buttons were. Dropping the strip
  // left the completed state with nowhere to appear on a thread's own full view.
  assert.deepEqual(threadLifecycleAvailability(thread({ state: "archived", archived: true })), {
    lifecycle: true,
    done: true,
    snooze: false,
    archive: false,
  })
  const rolling = threadLifecycleAvailability(thread({ state: undefined, archived: true }))
  assert.deepEqual({ lifecycle: rolling.lifecycle, done: rolling.done, archive: rolling.archive }, { lifecycle: true, done: true, archive: false }, "rolling snapshots still read the legacy flag as done")
  // A thread frizz does not own has no lifecycle standing at all: no verbs AND no readout, because
  // "Done" would assert a completion state frizz never wrote.
  for (const unowned of [thread({ foreign: true }), thread({ kind: "legacy" })]) {
    assert.deepEqual(threadLifecycleAvailability(unowned), { lifecycle: false, done: false, snooze: false, archive: false })
  }
  assert.deepEqual(threadLifecycleAvailability(thread({ foreign: true, state: "archived", archived: true })), {
    lifecycle: false,
    done: false,
    snooze: false,
    archive: false,
  }, "an archived FOREIGN thread still gets no strip")
})

// completionArchivesImmediately gates the OPTIMISTIC Mark-as-done dismissal, so it must match the
// server's completionNeedsConfirmation (server/src/router.ts) INVERTED: true only when the server would
// archive without an "End this session?" dialog. A false positive would flash-dismiss a card the server
// then asks to confirm; a false negative just waits out the round-trip. It must never mispredict an
// executing turn as immediate.
test("completionArchivesImmediately mirrors the server's no-confirmation cases", () => {
  const busySub = { label: "child", startedAt: "2026-07-21T00:00:00Z", state: "running" as const }
  const staleSub = { label: "child", startedAt: "2026-07-21T00:00:00Z", state: "stale" as const }
  const busyShell = { label: "watch", startedAt: "2026-07-21T00:00:00Z", state: "running" as const }

  // Resting / exited-at-rest / human-blocked → immediate (no dialog).
  assert.equal(completionArchivesImmediately(thread({ runtime: "turn-idle" })), true)
  assert.equal(completionArchivesImmediately(thread({ runtime: "exited", crashed: false })), true)
  assert.equal(completionArchivesImmediately(thread({ runtime: "perm-prompt" })), true)
  assert.equal(completionArchivesImmediately(thread({ pendingAsk: { questions: [] } })), true)
  // A worker cut off mid-turn (dead, turn never ended) is asked about (router.cutOffHold) — and a pending
  // ask on it does not make it finished.
  assert.equal(completionArchivesImmediately(thread({ runtime: "exited", crashed: true })), false)
  assert.equal(completionArchivesImmediately(thread({ runtime: "exited", crashed: true, pendingAsk: { questions: [] } })), false)
  // A human-blocked shell is safe to stop even with live background work (server short-circuits on it).
  assert.equal(completionArchivesImmediately(thread({ runtime: "perm-prompt", subAgents: [busySub] })), true)

  // Executing / spawning turn → must confirm (never optimistic).
  assert.equal(completionArchivesImmediately(thread({ runtime: "running" })), false)
  assert.equal(completionArchivesImmediately(thread({ runtime: "spawning" })), false)
  // Resting but with live background sub-agents/shells → server confirms, so not optimistic.
  assert.equal(completionArchivesImmediately(thread({ runtime: "turn-idle", subAgents: [busySub] })), false)
  assert.equal(completionArchivesImmediately(thread({ runtime: "turn-idle", subAgents: [staleSub] })), false)
  assert.equal(completionArchivesImmediately(thread({ runtime: "turn-idle", bgShells: [busyShell] })), false)
})

// "This thread is still running" told the human nothing they could act on — they clicked Done because
// they believed it WAS finished. The dialog now has to name the specific thing Done is about to kill.
function hold(over: Partial<CompletionHold> = {}): CompletionHold {
  return { turnInFlight: false, unobservable: false, subAgents: [], subAgentCount: 0, bgShells: [], bgShellCount: 0, ...over }
}

test("completionHoldSummary counts the live sub-agents and shells in its sentence and lists each as a row", () => {
  const at = "2026-11-24T12:00:00.000Z"
  const summary = completionHoldSummary(hold({
    subAgents: [{ label: "Audit the resolver", state: "running", startedAt: at }],
    subAgentCount: 1,
    bgShells: [{ label: "Watch CI", state: "running" }, { label: "vite dev", state: "stale" }],
    bgShellCount: 2,
  }))
  assert.equal(summary.lead, "The agent is resting, but a sub-agent and 2 background shells are still running:")
  assert.deepEqual(summary.rows, [
    { kind: "AGENT", label: "Audit the resolver", state: "running", startedAt: at },
    { kind: "SHELL", label: "Watch CI", state: "running" },
    { kind: "SHELL", label: "vite dev", state: "stale" },
  ], "sub-agents first, each kind drawn as its own hue, the launch carried for the row's clock")
  assert.equal(summary.overflow, 0)
  assert.equal(summary.trailer, "Marking it done stops all of it.")

  const one = completionHoldSummary(hold({ bgShells: [{ label: "Watch CI", state: "running" }], bgShellCount: 1 }))
  assert.equal(one.lead, "The agent is resting, but a background shell is still running:", "singular")
})

test("completionHoldSummary says a cut-off worker is gone, not busy, and points at Retry", () => {
  const summary = completionHoldSummary(hold({ turnInFlight: true, cutOff: true }))
  assert.match(summary.lead, /cut off mid-turn/)
  assert.match(summary.lead, /isn’t done/)
  assert.deepEqual(summary.rows, [], "nothing is running under a dead worker, so nothing is listed")
  assert.match(summary.trailer, /Retry resumes it/)
  assert.doesNotMatch(summary.trailer, /stop/, "nothing will be stopped — the copy must not promise a kill")
})

test("completionHoldSummary distinguishes a mid-turn agent from the work hanging off it", () => {
  const midTurnOnly = completionHoldSummary(hold({ turnInFlight: true }))
  assert.match(midTurnOnly.lead, /mid-turn — it’s executing right now/)
  assert.deepEqual(midTurnOnly.rows, [])
  assert.match(midTurnOnly.trailer, /stops the session mid-turn/)

  // Mid-turn AND owning children: both facts survive; neither replaces the other.
  const both = completionHoldSummary(hold({ turnInFlight: true, bgShells: [{ label: "Watch CI", state: "running" }], bgShellCount: 1 }))
  assert.equal(both.lead, "The agent is mid-turn, and a background shell is running under it:")
  assert.deepEqual(both.rows.map((row) => row.label), ["Watch CI"])
})

test("completionHoldSummary reports withheld labels as '+N more' and never claims a false cause", () => {
  const capped = completionHoldSummary(hold({
    subAgents: [{ label: "child 0", state: "running" }],
    subAgentCount: 9,
  }))
  assert.match(capped.lead, /9 sub-agents are still running/, "the sentence counts every child, not just the named ones")
  assert.equal(capped.rows.length, 1)
  assert.equal(capped.overflow, 8)

  // Telemetry missing entirely: say the transcript is unreadable rather than inventing a running turn.
  const blind = completionHoldSummary(hold({ unobservable: true }))
  assert.match(blind.lead, /transcript can’t be read right now/)
  assert.deepEqual(blind.rows, [])

  // No hold at all (older server, or a mispredict with no evidence) degrades to the original sentence.
  assert.equal(completionHoldSummary(undefined).lead, "This thread is still running.")
  assert.equal(completionHoldSummary(hold()).lead, "This thread is still running.", "an evidence-free hold asserts nothing new")
})

test("completionHoldCanKeepRunning offers the event-snooze only when the parent is resting behind live work", () => {
  const restingWithSub = hold({ subAgents: [{ label: "Audit the resolver", state: "running" }], subAgentCount: 1 })
  const restingWithShell = hold({ bgShells: [{ label: "Watch CI", state: "running" }], bgShellCount: 1 })
  assert.equal(completionHoldCanKeepRunning(restingWithSub, thread()), true)
  assert.equal(completionHoldCanKeepRunning(restingWithShell, thread()), true)
  // Already event-snoozed: nothing left for Keep running to arm.
  assert.equal(completionHoldCanKeepRunning(restingWithSub, thread({ bgSnoozed: true })), false)
  // Executing, cut off, unobservable, or no live background work: the server would reject snoozeAwaitingBackground.
  assert.equal(completionHoldCanKeepRunning(hold({ ...restingWithSub, turnInFlight: true }), thread()), false)
  assert.equal(completionHoldCanKeepRunning(hold({ turnInFlight: true }), thread()), false)
  assert.equal(completionHoldCanKeepRunning(hold({ turnInFlight: true, cutOff: true }), thread()), false)
  assert.equal(completionHoldCanKeepRunning(hold({ ...restingWithSub, unobservable: true }), thread()), false)
  assert.equal(completionHoldCanKeepRunning(hold(), thread()), false)
  assert.equal(completionHoldCanKeepRunning(undefined, thread()), false)
})

test("every owned open queue reason retains enabled lifecycle actions", () => {
  for (const state of [
    thread({ pendingQuestion: true }),
    thread({ pendingAsk: { questions: [] } }),
    thread({ runtime: "perm-prompt" }),
    thread({ actionableInteraction: true }),
    thread({ crashed: true, runtime: "exited" }),
  ]) {
    assert.deepEqual(threadLifecycleAvailability(state), {
      lifecycle: true,
      done: false,
      snooze: true,
      archive: true,
    })
  }
})
