// End-to-end over the REAL frizz graph — storage → tailer fold → board assembly — driven by a
// scripted Claude provider that writes the same two artifacts a live broker session does: records on
// disk and typed events over the socket. No `claude`, no daemon, no browser, no sleeps.
//
// These are the assertions that decide whether consuming the broker's event stream (item 1 of
// plans/t3code-adoption-spike.md) made the board FASTER without making it WRONG. The wrongness risk
// is entirely about ORDERING between the two surfaces, so the ordering cases are the ones written
// out longhand below.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createIntegrationHarness } from "./harness.ts"
import {
  assistantEvent,
  assistantRecord,
  event,
  record,
  resultEvent,
  userEvent,
  userRecord,
  agentDispatchRecord,
  agentLaunchRecord,
  agentResumeRecords,
  taskEvent,
  taskNotificationRecord,
} from "./scripted-claude.ts"

const T0 = "2026-07-01T00:00:00.000Z"
const T1 = "2026-07-01T00:00:01.000Z"
const T2 = "2026-07-01T00:00:02.000Z"

test("integration: a scripted broker turn folds through the real graph to an idle board thread", async () => {
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("alpha")
    h.telemetry("alpha") // prime

    s.play(
      record(userRecord("go", T0)),
      event(userEvent("go", s.sessionId)),
      record(assistantRecord("looking", "tool_use", T1)),
      event(assistantEvent("looking", s.sessionId)),
      record(assistantRecord("```done\n- shipped it\n```", "end_turn", T2)),
      event(assistantEvent("shipped it", s.sessionId)),
      event(resultEvent(s.sessionId)),
    )
    await h.settle()

    const tele = h.telemetry("alpha")
    assert.equal(tele?.turn, "idle")
    assert.equal(tele?.lastActivityAt, T2)
    // The DX guard: the signal fence still parses out of the final message after the whole chain.
    assert.equal(tele?.lastFence?.kind, "done")

    const thread = h.boardThread("alpha")
    assert.ok(thread, "the thread reaches the board")
    assert.equal(thread?.runtime, "turn-idle", "the process is alive and waiting at the prompt")
  } finally {
    h.close()
  }
})

test("integration: a thread that rested BEFORE a restart is not re-spun by a turn-neutral event", async () => {
  // Reported 2026-07-30 (the second sighting of this shimmer): four broker threads that had come to
  // rest hours earlier all rendered `runtime: "running"` on a control plane that had restarted after
  // they rested. Replaying the live DB with no runtime signal folded every one of them to `idle`, so
  // the reading could only have come from the ingest.
  //
  // This is that shape exactly. A restart empties the ingest's `live` map while the transcript on disk
  // still records a finished turn — so the fold knows the thread rested and the ingest knows nothing.
  // The next event to arrive is routinely one that carries no turn meaning (`task` is stream-only and
  // says nothing about the parent's turn), and it must not be allowed to invent one.
  const h = createIntegrationHarness()
  try {
    const s = h.dispatch("restarted")
    h.telemetry("restarted") // prime

    // Records ONLY: the turn happened, and no event of it ever reached THIS ingest.
    s.play(
      record(userRecord("go", T0)),
      record(assistantRecord("```done\n- finished before the restart\n```", "end_turn", T1)),
    )
    await h.settle()
    assert.equal(h.boardThread("restarted")?.runtime, "turn-idle", "the fold alone reads the rest correctly")

    // …and now the first event this ingest has ever seen for the session arrives, carrying no turn.
    s.play(event(taskEvent(s.sessionId, { phase: "level", tasks: [] })))
    await h.settle()

    assert.equal(h.telemetry("restarted")?.turn, "idle", "a turn-neutral event decides nothing")
    assert.equal(h.boardThread("restarted")?.runtime, "turn-idle", "no shimmer on a thread at rest")
  } finally {
    h.close()
  }
})

test("integration: a `result` event NEVER queues a thread ahead of its final record reaching disk", async () => {
  // The single most dangerous ordering, and the reason resolveRuntimeTurn refuses to override folded
  // evidence. The SDK reports the turn finished while the last record the tailer can see is an
  // unresolved tool_use. If "settled" won here, the board would card the thread at rest showing the
  // TOOL-CALL as its last message and no parsed fence — a worse regression than the latency it fixes.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("beta")
    h.telemetry("beta")

    s.play(
      record(userRecord("go", T0)),
      record(assistantRecord("calling a tool", "tool_use", T1)),
      event(resultEvent(s.sessionId)), // the SDK is ahead of the file
    )
    await h.settle()

    const midFlight = h.telemetry("beta")
    assert.equal(midFlight?.turn, "in-flight", "folded tool_use outranks a runtime `settled`")
    assert.equal(midFlight?.lastFence, undefined, "no fence has been written yet")

    // Now the real final record lands.
    s.play(record(assistantRecord("```done\n- finished\n```", "end_turn", T2)))
    await h.settle()

    const settled = h.telemetry("beta")
    assert.equal(settled?.turn, "idle")
    assert.equal(settled?.lastFence?.kind, "done", "the thread rests on the message it actually ended with")
  } finally {
    h.close()
  }
})

test("integration: a `result` event short-circuits the 5s unknown-stop_reason backstop", async () => {
  // The case where the fold has NO evidence: an assistant record whose stop_reason is missing. Today
  // that costs a 5-second wait before the thread can come to rest. The SDK already said the turn was
  // over; that is not a guess.
  const withRuntime = createIntegrationHarness()
  try {
    const s = withRuntime.dispatch("gamma")
    withRuntime.telemetry("gamma")
    s.play(
      record(userRecord("go", T0)),
      record(assistantRecord("done, i think", undefined, T1)),
    )
    await withRuntime.settle()
    assert.equal(withRuntime.telemetry("gamma")?.turn, "in-flight", "backstop has not elapsed")

    s.play(event(resultEvent(s.sessionId)))
    await withRuntime.settle()
    assert.equal(withRuntime.telemetry("gamma")?.turn, "idle", "the SDK settles it without waiting out 5s")
  } finally {
    withRuntime.close()
  }
})

test("integration: without a runtime signal the backstop behaves exactly as before", async () => {
  // The control for the test above — same script, no `result` event. This is what every pre-broker
  // session still does, and it must be untouched.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("delta")
    h.telemetry("delta")
    s.play(record(userRecord("go", T0)), record(assistantRecord("done, i think", undefined, T1)))
    await h.settle()
    assert.equal(h.telemetry("delta")?.turn, "in-flight")

    // IDLE_BACKSTOP_MS is 5s measured from lastActivityAt (T1), and the comparison is strict, so the
    // clock has to pass 00:00:06 — not merely reach it. Exactness here is the point of the control.
    h.advance(7_000)
    assert.equal(h.telemetry("delta")?.turn, "idle", "the 5s backstop still resolves it on its own")
  } finally {
    h.close()
  }
})

test("integration: a delivered follow-up shows in-flight before its user record reaches disk", async () => {
  // The other direction, and the safe one: the SDK says a turn is running while the transcript still
  // ends on the previous end_turn. Reporting `idle` there is the "I sent a message and the thread
  // still looks asleep" flicker. This can never fire a premature turn-done — it only moves the board
  // toward in-flight.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("epsilon")
    h.telemetry("epsilon")
    s.play(record(userRecord("go", T0)), record(assistantRecord("all done", "end_turn", T1)))
    await h.settle()
    assert.equal(h.telemetry("epsilon")?.turn, "idle")

    s.play(event(userEvent("one more thing", s.sessionId))) // nothing on disk yet
    await h.settle()
    assert.equal(h.telemetry("epsilon")?.turn, "in-flight", "the board moves the instant the turn starts")
  } finally {
    h.close()
  }
})

test("integration: the runtime turn reading is scoped to broker rows and dies with the session", async () => {
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("zeta")
    h.telemetry("zeta")
    s.play(record(userRecord("go", T0)), record(assistantRecord("all done", "end_turn", T1)))
    s.play(event(assistantEvent("working", s.sessionId)))
    await h.settle()
    assert.equal(h.ingest.liveness(s.sessionId)?.turn, "running")
    assert.equal(h.telemetry("zeta")?.turn, "in-flight")

    // A replaced session reuses the slug; a stale "running" left behind would be consulted for the
    // NEW session's row and spin a finished thread forever.
    h.ingest.release(s.sessionId)
    assert.equal(h.ingest.liveness(s.sessionId), undefined)
    assert.equal(h.telemetry("zeta")?.turn, "idle", "the fold decides alone again")
  } finally {
    h.close()
  }
})

test("integration: receipts name each milestone, and drain means the ingest is finished", async () => {
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("eta")
    h.telemetry("eta")

    const cursor = h.receipts.cursor()
    s.play(
      event(userEvent("go", s.sessionId)),
      event(assistantEvent("working", s.sessionId)),
      event(resultEvent(s.sessionId)),
    )
    await h.ingest.drain()
    assert.equal(h.ingest.liveness(s.sessionId)?.events, 3)

    // `since: cursor` is what makes these matchable even though they were published before the await.
    const started = await h.receipts.waitFor((r) => r.type === "claude.runtime.turn.started", { since: cursor })
    assert.equal(started.type === "claude.runtime.turn.started" && started.slug, "eta")
    const settled = await h.receipts.waitFor((r) => r.type === "claude.runtime.turn.settled", { since: cursor })
    assert.equal(settled.type === "claude.runtime.turn.settled" && settled.isError, false)
  } finally {
    h.close()
  }
})

test("integration: the fold catches up when the provider's event beats its own disk write", async () => {
  // THE case the promoted-artifact measurement caught, and the reason chaseRuntime exists. Measured
  // against a real broker session (backend/_live_broker_ingest.mts): the SDK emitted `assistant` and
  // `result` with the transcript still at its previous size, and the record landed ~100-140ms later.
  // A single nudge on the event therefore folds NOTHING, and before the chase the change sat until the
  // next 1s poll — which is exactly what the artifact showed (~920ms, i.e. no improvement at all).
  //
  // Real timers here on purpose: the whole point is that the tick has to run AGAIN, later, without
  // anything else prompting it. `settle()` (which ticks by hand) would hide the bug completely.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("iota")
    h.telemetry("iota") // prime; nothing calls tick() by hand past this line

    // The events arrive first, describing a turn whose records are not on disk yet.
    s.play(event(userEvent("go", s.sessionId)), event(assistantEvent("all done", s.sessionId)), event(resultEvent(s.sessionId)))
    await h.ingest.drain()

    // …and the writes land a beat later, with NO event to announce them.
    await new Promise((r) => setTimeout(r, 60))
    s.play(record(userRecord("go", T0)), record(assistantRecord("all done", "end_turn", T1)))

    const deadline = Date.now() + 2_000
    while (h.tailer.get("iota")?.lastAssistant !== "all done" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.equal(h.tailer.get("iota")?.lastAssistant, "all done", "the chase re-read after the write landed")
    assert.equal(h.tailer.get("iota")?.turn, "idle")
  } finally {
    h.close()
  }
})

test("integration: the chase is bounded — events that never produce a record stop nudging", async () => {
  // The other half of the contract: `init` and the system sidecars bump the provider's event count
  // without ever writing a record the fold can consume. Chasing those forever would turn a quiet
  // session into a permanent tick loop, which is a worse stability problem than the latency.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("kappa")
    h.telemetry("kappa")
    s.play(event({ kind: "other", type: "system", sessionId: s.sessionId }))
    await h.ingest.drain()

    await new Promise((r) => setTimeout(r, 900)) // ≫ RUNTIME_CHASE_MAX × the ~25ms nudge floor
    const settled = h.boardRefreshes()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(h.boardRefreshes(), settled, "the chase gave up rather than nudging forever")
  } finally {
    h.close()
  }
})

test("integration: a runtime event drives a tailer re-read with no poll tick at all", async () => {
  // The latency claim, asserted against the REAL nudge path — real timers, no tailer.tick() call.
  // Before this the same assertion would have had to wait out POLL_MS (1s) at best and MAX_POLL_MS
  // (10s) under load.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("theta")
    h.telemetry("theta") // prime; from here nothing calls tick() by hand
    const before = h.boardRefreshes()

    s.play(
      record(userRecord("go", T0)),
      record(assistantRecord("all done", "end_turn", T1)),
      event(resultEvent(s.sessionId)),
    )

    const deadline = Date.now() + 2_000
    while (h.boardRefreshes() === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.notEqual(h.boardRefreshes(), before, "the nudge ran a tick without waiting for the poll")
    assert.equal(h.tailer.get("theta")?.turn, "idle")
    assert.equal(h.tailer.get("theta")?.lastAssistant, "all done")
  } finally {
    h.close()
  }
})

// ---- sub-agent progress: the structured stream over the prose fold --------------------------------
// "There's not really any indication of what they're up to aside from starts and stops." These pin the
// three rules that answer it: the structured stream ENRICHES a folded child, it may RETIRE one, and it
// may never INVENT one. The prose path is exercised alongside in every case, because a pre-broker thread
// has nothing else and must keep behaving exactly as it did.

// The child's own transcript, which the fold resolves out of the launch ack's prose and then stats as
// the staleness clock. It has to EXIST: a path that never stats reads as stale, which is correct
// behaviour (a child whose transcript vanished is not healthy) and would mask what these tests assert.
function childTranscript(h: { project: { dir: string } }): string {
  const path = join(h.project.dir, "child.jsonl")
  writeFileSync(path, "")
  return path
}

test("integration: the structured task stream says what a live sub-agent is DOING", async () => {
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("progress")
    h.telemetry("progress")

    // The prose path registers the child, exactly as it always has.
    s.play(
      record(userRecord("go", T0)),
      record(agentDispatchRecord("toolu_child", "Audit the fold", T1)),
      record(agentLaunchRecord("toolu_child", OUT, T1)),
    )
    await h.settle()
    const bare = h.telemetry("progress")?.subAgents?.[0]
    assert.equal(bare?.label, "Audit the fold")
    assert.equal(bare?.activity, undefined, "before the SDK reports anything there is nothing to show")

    // Now the SDK reports what the child is up to — data that exists ONLY on this stream.
    s.play(
      event(taskEvent(s.sessionId, { phase: "started", taskId: "task-1", toolUseId: "toolu_child", description: "Audit the fold" })),
      event(taskEvent(s.sessionId, { phase: "progress", taskId: "task-1", description: "Running the live harness", lastToolName: "Bash", summary: "running the harness", usage: { totalTokens: 40123, toolUses: 18, durationMs: 92_000 } })),
    )
    await h.settle()

    const live = h.telemetry("progress")?.subAgents?.[0]
    assert.equal(live?.state, "running")
    assert.equal(live?.activity, "Bash", "the tool the child is running right now")
    assert.equal(live?.activityDetail, "Running the live harness", "the per-step description, not the dispatch label")
    assert.equal(live?.label, "Audit the fold", "the dispatch label is NOT overwritten by the live step")
    assert.equal(live?.summary, "running the harness")
    assert.equal(live?.toolUses, 18)
    assert.equal(live?.tokens, 40123)
    assert.equal(live?.durationMs, 92_000)
    // ...and the correlation key a manual TaskStop needs is backfilled from the structured pairing.
    assert.equal(h.tailer.subAgent("progress", "toolu_child")?.state, "running")
  } finally {
    h.close()
  }
})

test("integration: a structured task_notification retires the child with NO prose notification", async () => {
  // The phantom bug, in its exact shape. `<task-notification>` records are how the fold learns a child
  // finished — and the tailer's own comments record three separate leaks from missing one. Here none
  // ever lands on disk: the ONLY terminal signal is the SDK's, and the live count must still reach zero.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("retire")
    h.telemetry("retire")

    s.play(
      record(userRecord("go", T0)),
      record(agentDispatchRecord("toolu_child", "Do the thing", T1)),
      record(agentLaunchRecord("toolu_child", OUT, T1)),
      event(taskEvent(s.sessionId, { phase: "started", taskId: "task-1", toolUseId: "toolu_child" })),
    )
    await h.settle()
    assert.equal(h.telemetry("retire")?.subAgents.length, 1, "the child is live")

    s.play(event(taskEvent(s.sessionId, { phase: "notification", taskId: "task-1", toolUseId: "toolu_child", status: "completed", summary: "all green" })))
    await h.settle()

    assert.equal(h.telemetry("retire")?.subAgents.length, 0, "the live sub-agent count returned to zero")
    // ...and it is RETAINED for the drill-in drawer, exactly as a prose completion would leave it.
    assert.equal(h.tailer.subAgent("retire", "toolu_child")?.state, "done")
  } finally {
    h.close()
  }
})

test("integration: a parent that dispatched in the BACKGROUND and rested reads as at rest, not working", async () => {
  // The reported bug, on the seam that produced it (2026-07-30: a thread whose own turn had ended 63
  // minutes earlier rendered the "Working…" shimmer). A frizz worker's normal shape is `run_in_background:
  // true` then rest, and a background child keeps streaming assistant/user events on the PARENT's socket
  // for its whole life. Folding those as the parent's own turn held `runtime: "running"` for the child's
  // entire lifetime, which also starved `awaitingBackground` — it requires turn-idle, so the one card
  // that describes this state could never render. Measured live by backend/_live_bg_rest_turn.mts: 118
  // consecutive samples of `in-flight` across the two minutes the child ran.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("resting")
    h.telemetry("resting")

    s.play(
      record(userRecord("go", T0)),
      record(agentDispatchRecord("toolu_child", "Sweep the fold", T1)),
      record(agentLaunchRecord("toolu_child", OUT, T1)),
      event(taskEvent(s.sessionId, { phase: "started", taskId: "task-1", toolUseId: "toolu_child" })),
      // The parent says its piece and ENDS ITS TURN while the child runs on.
      record(assistantRecord("dispatched it, resting", "end_turn", T2)),
      event(assistantEvent("dispatched it, resting", s.sessionId)),
      event(resultEvent(s.sessionId)),
    )
    await h.settle()
    assert.equal(h.telemetry("resting")?.turn, "idle", "the parent's own turn is over")

    // Now the child streams — in the live run this was 18 events over two minutes, ~40ms after `result`.
    s.play(
      event(assistantEvent("child thinking", s.sessionId, "toolu_child")),
      event(userEvent("tool result", s.sessionId, "toolu_child")),
      event(assistantEvent("child still going", s.sessionId, "toolu_child")),
    )
    await h.settle()

    assert.equal(h.telemetry("resting")?.turn, "idle", "a child's chatter is not the parent's turn")
    assert.equal(h.telemetry("resting")?.subAgents.length, 1, "…and the child is still shown as live")
    const thread = h.boardThread("resting")
    assert.equal(thread?.runtime, "turn-idle", "no shimmer")
    assert.equal(thread?.awaitingBackground, true, "the resting card can finally render")

    // The parent genuinely resuming — the child's task-notification lands as a user record — still moves.
    s.play(record(userRecord("<task-notification>done</task-notification>", T2)), event(userEvent("go on", s.sessionId)))
    await h.settle()
    assert.equal(h.telemetry("resting")?.turn, "in-flight", "a MAIN-thread event still re-opens the turn")
  } finally {
    h.close()
  }
})

test("integration: a re-steered child comes back live even though its task id is already terminal", async () => {
  // The end-to-end shape of the bug, on the seam the fold alone cannot show. A task id OUTLIVES the run
  // that created it: `SendMessage` restarts a stopped child under the SAME id. So after the first run's
  // terminal event, the ingest holds `terminal:true` for that id forever — and the revived row was
  // retired again on its very next tick. Measured on the promoted artifact: the fold revived the child
  // correctly and the board showed nothing for the whole 37 s it ran.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("resteer")
    h.telemetry("resteer")

    s.play(
      record(userRecord("go", T0)),
      record(agentDispatchRecord("toolu_child", "Probe child", T1)),
      record(agentLaunchRecord("toolu_child", OUT, T1, "task-1")),
      event(taskEvent(s.sessionId, { phase: "started", taskId: "task-1", toolUseId: "toolu_child" })),
    )
    await h.settle()
    assert.equal(h.telemetry("resteer")?.subAgents.length, 1, "the child is live")

    s.play(event(taskEvent(s.sessionId, { phase: "notification", taskId: "task-1", toolUseId: "toolu_child", status: "completed" })))
    await h.settle()
    assert.equal(h.telemetry("resteer")?.subAgents.length, 0, "it retires when the run finishes")

    // The re-steer. Same runtime id, brand-new tool_use id, and the provider says it started again.
    s.play(
      ...agentResumeRecords("toolu_send", "task-1", OUT, T2).map(record),
      event(taskEvent(s.sessionId, { phase: "started", taskId: "task-1", toolUseId: "toolu_send" })),
    )
    await h.settle()

    const live = h.telemetry("resteer")?.subAgents ?? []
    assert.equal(live.length, 1, "the re-steered child is on the board again")
    assert.equal(live[0]?.label, "Probe child", "under its original label")
    assert.equal(h.boardThread("resteer")?.subAgents?.length, 1, "and the board row agrees")
  } finally {
    h.close()
  }
})

test("integration: a re-steer survives the stream and the transcript racing each other", async () => {
  // The ingest clears its terminal latch on `task_started`, but the event stream and the disk write race
  // by design (see chaseRuntime), so that ordering must never be load-bearing. Here the restart ack is
  // folded with NO task_started at all — the stale terminal reading predates this run, and a reading
  // from before the run began cannot end it.
  //
  // Record timestamps here are REAL instants, not the T0/T1/T2 fixtures the other cases use. The guard
  // compares the row's `startedAt` (a record timestamp, written by the CLI) against the task's
  // `updatedAt` (a `Date.now()` in the frizz process) — one wall clock on one host in production, but
  // hours apart if the records claim 2026-07-01. A fixture that mixes them does not test the guard, it
  // just happens to sit on one side of it.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("race")
    h.telemetry("race")
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

    s.play(
      record(userRecord("go", at(-3000))),
      record(agentDispatchRecord("toolu_child", "Probe child", at(-2000))),
      record(agentLaunchRecord("toolu_child", OUT, at(-2000), "task-1")),
      event(taskEvent(s.sessionId, { phase: "started", taskId: "task-1", toolUseId: "toolu_child" })),
      event(taskEvent(s.sessionId, { phase: "notification", taskId: "task-1", toolUseId: "toolu_child", status: "completed" })),
    )
    await h.settle()
    assert.equal(h.telemetry("race")?.subAgents.length, 0)

    // The restart ack lands AFTER the terminal event that is still latched, and nothing on the stream
    // announces it yet. `startedAt` is therefore newer than the dead run's reading.
    s.play(...agentResumeRecords("toolu_send", "task-1", OUT, at(1000)).map(record))
    await h.settle()
    assert.equal(h.telemetry("race")?.subAgents.length, 1, "the revived row survives the dead run's terminal flag")
  } finally {
    h.close()
  }
})

test("integration: the structured stream never INVENTS a sub-agent the fold does not track", async () => {
  // `trackDispatches` deliberately skips a FOREGROUND Agent (run_in_background:false) because the
  // thread spinner already covers it — and the provider reports those tasks too. Minting board rows
  // from the task stream would put foreground children on the live count and into the completion hold:
  // manufacturing exactly the phantoms this change exists to remove.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("noinvent")
    h.telemetry("noinvent")

    s.play(
      record(userRecord("go", T0)),
      event(taskEvent(s.sessionId, { phase: "started", taskId: "ghost", toolUseId: "toolu_ghost", description: "A foreground child" })),
      event(taskEvent(s.sessionId, { phase: "progress", taskId: "ghost", lastToolName: "Read" })),
      event(taskEvent(s.sessionId, { phase: "level", tasks: [{ taskId: "ghost" }] })),
    )
    await h.settle()

    assert.equal(h.telemetry("noinvent")?.subAgents.length, 0, "no folded dispatch, no board row")
    assert.equal(h.boardThread("noinvent")?.subAgents?.length ?? 0, 0)
  } finally {
    h.close()
  }
})

test("integration: the PROSE fold still retires a child on its own, with no structured stream at all", async () => {
  // The fallback that must not rot. A pre-broker thread emits no task events ever, so this is the whole of
  // its sub-agent lifecycle — byte-identical to before this change existed.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("prose")
    h.telemetry("prose")

    s.play(
      record(userRecord("go", T0)),
      record(agentDispatchRecord("toolu_child", "Prose only", T1)),
      record(agentLaunchRecord("toolu_child", OUT, T1)),
    )
    await h.settle()
    assert.equal(h.telemetry("prose")?.subAgents.length, 1)

    s.play(record(taskNotificationRecord("toolu_child", "completed", T2)))
    await h.settle()
    assert.equal(h.telemetry("prose")?.subAgents.length, 0, "the prose notification is still terminal")
  } finally {
    h.close()
  }
})

test("integration: a NON-terminal structured status never retires a live child", async () => {
  // The dangerous direction. A status frizz has never seen, or a plain progress ping, must leave the
  // child exactly where it is — the board reporting done while the work continues is far worse than
  // the phantom this whole change is about.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("nonterminal")
    h.telemetry("nonterminal")

    s.play(
      record(userRecord("go", T0)),
      record(agentDispatchRecord("toolu_child", "Still going", T1)),
      record(agentLaunchRecord("toolu_child", OUT, T1)),
      event(taskEvent(s.sessionId, { phase: "started", taskId: "task-1", toolUseId: "toolu_child" })),
      event(taskEvent(s.sessionId, { phase: "updated", taskId: "task-1", status: "paused" })),
      event(taskEvent(s.sessionId, { phase: "updated", taskId: "task-1", status: "hibernating" })),
      event(taskEvent(s.sessionId, { phase: "progress", taskId: "task-1", lastToolName: "Edit" })),
    )
    await h.settle()

    const view = h.telemetry("nonterminal")?.subAgents?.[0]
    assert.equal(view?.state, "running", "paused / unknown / progress are all still alive")
    assert.equal(view?.activity, "Edit")
  } finally {
    h.close()
  }
})

test("integration: a structured completion reaches the BOARD, not just the tailer", async () => {
  // The signature has to move for progress to be visible at all: a completion clears an entry without
  // touching lastActivityAt, and an activity change writes no record whatsoever.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("boardmove")
    h.telemetry("boardmove")

    s.play(
      record(userRecord("go", T0)),
      record(agentDispatchRecord("toolu_child", "Visible child", T1)),
      record(agentLaunchRecord("toolu_child", OUT, T1)),
      event(taskEvent(s.sessionId, { phase: "started", taskId: "task-1", toolUseId: "toolu_child" })),
    )
    await h.settle()
    assert.equal(h.boardThread("boardmove")?.subAgents?.length, 1)

    const before = h.boardRefreshes()
    s.play(event(taskEvent(s.sessionId, { phase: "progress", taskId: "task-1", lastToolName: "Grep", summary: "searching" })))
    await h.settle()
    assert.ok(h.boardRefreshes() > before, "an activity change with no new record still moves the board")
    assert.equal(h.boardThread("boardmove")?.subAgents?.[0]?.activity, "Grep")

    s.play(event(taskEvent(s.sessionId, { phase: "notification", taskId: "task-1", toolUseId: "toolu_child", status: "completed" })))
    await h.settle()
    assert.equal(h.boardThread("boardmove")?.subAgents?.length ?? 0, 0, "the board's live child list is empty")
  } finally {
    h.close()
  }
})

// THE REPORTED BUG, END TO END: "frizz shows thinking, but it's not really waiting on anything."
// A worker changes its own cwd — `EnterWorktree`, or any move of the checkout under a live session —
// and Claude Code re-buckets that session's transcript into the log dir for the new cwd. The path the
// tailer bound then names nothing. `consume` skips a missing file in silence, so the fold FREEZES on
// the last thing it managed to read, and if that was mid-turn the freeze reads "in-flight": the board
// renders the shimmer against a thread that finished hours ago and nothing can talk it down, because
// `computeTurn` has no backstop for a trailing user record the way it has one for an unknown
// stop_reason. Measured 2026-08-21 on the maintainer's own board — three threads at once, their
// `tail_state` rows pinned to three deleted worktree buckets.
//
// Records only, no events: this is the tailer→board path, and a runtime reading would only mask which
// half is under test (the fold's own `resolveRuntimeTurn` bound has its own cases in ../backend/).
test("integration: a transcript that moves under a live session stops pinning the board at Working", async () => {
  const h = createIntegrationHarness()
  try {
    const s = h.dispatch("relocated")
    h.telemetry("relocated") // prime

    s.play(record(userRecord("go", T0)), record(assistantRecord("looking", "tool_use", T1)))
    await h.settle()
    assert.equal(h.boardThread("relocated")?.runtime, "running", "mid tool_use IS working — the honest reading")

    // The worker enters a worktree. Same session, same file, a bucket the old binding cannot reach —
    // and the turn it was in the middle of comes to rest THERE.
    const bound = join(h.project.dir, "claude-logs", `${s.sessionId}.jsonl`)
    const worktree = join(h.project.dir, "claude-logs--claude-worktrees-a-branch")
    mkdirSync(worktree, { recursive: true })
    writeFileSync(
      join(worktree, `${s.sessionId}.jsonl`),
      `${readFileSync(bound, "utf8")}${JSON.stringify(assistantRecord("```done\n- shipped it\n```", "end_turn", T2))}\n`,
    )
    rmSync(bound)

    h.advance(1000)
    await h.settle()
    assert.equal(h.boardThread("relocated")?.runtime, "turn-idle", "the shimmer goes: the thread is at rest and the board says so")
    assert.equal(h.telemetry("relocated")?.lastFence?.kind, "done", "…on the message it actually ended with, fence and all")
  } finally {
    h.close()
  }
})
