import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { needsAction, queued, orderQueue, partitionActive, sectionOf, sectionThreads, isSnoozed, sessionIndicatorKind, offersRetry, titleIsProvisional, displayTitle, lastActiveLabelAt, SPINNING_UP_TITLE, UNTITLED_THREAD_TITLE } from "./groups.ts"

// Minimal ThreadView fixture — the same shape board-delta.test.ts uses, defaulting to a live/active
// thread; each case overrides only the fields under test.
function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: "t",
    title: "t",
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
    pendingQuestion: false,
    spawnedAt: "2026-07-08T00:00:00.000Z",
    ...over,
  }
}

/** A running background shell — the plain "something it launched is still going" fixture. */
function shell(over: Partial<NonNullable<ThreadView["bgShells"]>[number]> = {}): NonNullable<ThreadView["bgShells"]>[number] {
  return { label: "vite dev", startedAt: "2026-08-14T00:00:00.000Z", state: "running", id: "s1", ...over }
}

// ---- needsAction: the queue definition ----

test("needsAction: needs-human AT REST cards — but only with a SESSION (humanBlocked derived from status)", () => {
  // humanBlocked is re-derived server-side as status === "needs-human"; the client sees the flag.
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "turn-idle" })), true)
  // exited still cards: that agent RAN and asked here — the ask is in its transcript.
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "exited" })), true)
})

test("needsAction: SESSION-LESS needs-human NEVER cards (the queue is agent work paused on the human)", () => {
  // A thread worked outside frizz (frizz classic / hand edits): no session, no transcript to card.
  // It surfaces in the SIDEBAR (yellow awaiting-you dot); its click-through composite (doc +
  // kick-off composer) is where it gets read and acted on.
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "none", spawnedAt: undefined })), false)
  // Even with a spawnedAt on the row, `none` + needs-human stays out of the queue (the crash net
  // only covers active/planning — verified below — so the two clauses never fight).
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "none" })), false)
})

test("needsAction: needs-human MID-TURN does NOT card (the ask text hasn't landed yet)", () => {
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "running" })), false)
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "spawning" })), false)
})

test("needsAction: perm-prompt always cards (a frozen worker can't declare anything)", () => {
  assert.equal(needsAction(thread({ runtime: "perm-prompt" })), true)
})

test("needsAction: a chat question at rest cards; mid-turn it does not", () => {
  assert.equal(needsAction(thread({ pendingQuestion: true, runtime: "turn-idle" })), true)
  assert.equal(needsAction(thread({ pendingQuestion: true, runtime: "running" })), false)
})

test("needsAction: a REGISTERED question at rest cards; mid-turn it does not (the worker keeps working)", () => {
  assert.equal(needsAction(thread({ questions: regQuestion, runtime: "turn-idle" })), true)
  // The registry outlives the process — an exited worker's open row still cards (unlike pendingQuestion
  // it needs no transcript heuristics, the row IS the ask).
  assert.equal(needsAction(thread({ questions: regQuestion, runtime: "exited" })), true)
  assert.equal(needsAction(thread({ questions: regQuestion, runtime: "running" })), false)
})

test("needsAction: `unread` no longer drives carding (unread is dead)", () => {
  // A completed turn on a still-live thread badged unread — pure progress, never a card.
  assert.equal(needsAction(thread({ unread: true, runtime: "turn-idle" })), false)
  assert.equal(needsAction(thread({ unread: true, runtime: "running" })), false)
})

test("needsAction: crash net — a spawned agent gone while IN-FLIGHT (active/planning) cards", () => {
  assert.equal(needsAction(thread({ status: "active", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z" })), true)
  assert.equal(needsAction(thread({ status: "planning", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z" })), true)
})

test("needsAction: crash net does NOT card a `blocked` MACHINE-wait whose session was cleaned up", () => {
  // blocked = waiting on revalidate_at / blocking_threads. killAgent / reboot kills the worker process
  // (runtime exited/none, spawnedAt set) — but the agent is LEGITIMATELY absent, not crashed. It must
  // NOT card and must NOT steal the blue dot from its timer/threads glyph (Nav short-circuits on this).
  assert.equal(needsAction(thread({ status: "blocked", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z", mechanism: "timer" })), false)
  assert.equal(needsAction(thread({ status: "blocked", runtime: "none", spawnedAt: "2026-07-08T00:00:00.000Z", mechanism: "threads" })), false)
})

test("needsAction: crash net does NOT flood never-spawned roadmap items", () => {
  // runtime none + no spawnedAt = a planned/planning item no agent ever touched → not a crash.
  assert.equal(needsAction(thread({ status: "planned", runtime: "none", spawnedAt: undefined })), false)
  assert.equal(needsAction(thread({ status: "planning", runtime: "none", spawnedAt: undefined })), false)
  // A spawned `planned` (backlog) thread whose agent exited is NOT mid-work → does not card.
  assert.equal(needsAction(thread({ status: "planned", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z" })), false)
})

test("needsAction: an ARCHIVED thread never crash-cards (even if its archive→done write raced)", () => {
  assert.equal(needsAction(thread({ status: "active", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z", archived: true })), false)
})

test("needsAction: terminal threads NEVER card, even exited-with-spawn (crash net can't win)", () => {
  assert.equal(needsAction(thread({ status: "done", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z" })), false)
  assert.equal(needsAction(thread({ status: "dismissed", runtime: "exited", unread: true })), false)
})

// ---- queued: the session-first queue definition (server-derived t.needsYou) ----

test("queued: a session thread with needsYou cards; without it, it does not", () => {
  assert.equal(queued(thread({ kind: "session", needsYou: true, state: "open" })), true)
  assert.equal(queued(thread({ kind: "session", needsYou: false, state: "open" })), false)
})

test("queued: a server-marked checked/done thread cards and keeps its active checked presentation", () => {
  const done = thread({
    kind: "session",
    needsYou: true,
    state: "open",
    lastFence: { kind: "done", body: "shipped", hints: [] },
  })
  assert.equal(queued(done), true)
  assert.equal(sectionOf(done), "active")
  assert.equal(sessionIndicatorKind(done), "done")
})

test("sessionIndicatorKind: bare queued rest stays rest while concrete input states use question styling", () => {
  assert.equal(sessionIndicatorKind(thread({ kind: "session", needsYou: true, runtime: "turn-idle" })), "rest")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, pendingQuestion: true, runtime: "exited" })), "needs-input")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, pendingAsk: { questions: [] }, runtime: "turn-idle" })), "needs-input")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, actionableInteraction: true, runtime: "turn-idle" })), "needs-input")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, status: "needs-human", humanBlocked: true, runtime: "exited" })), "needs-input")
  // STALLED keys on the PROCESS being gone (runtime "exited"), NOT on the server's `crashed` bit —
  // a mid-turn death and an exit at bare rest are equally stopped and need the same verb, so all three
  // `crashed` shapes (true / false / absent on an older snapshot) render the same [!].
  assert.equal(sessionIndicatorKind(thread({ kind: "session", needsYou: true, crashed: true, runtime: "exited" })), "stalled")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", needsYou: true, crashed: false, runtime: "exited" })), "stalled")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", needsYou: true, crashed: undefined, runtime: "exited" })), "stalled")
  // …and a thread with no retryable process behind it is never stalled, however `crashed` reads.
  assert.equal(sessionIndicatorKind(thread({ kind: "session", foreign: true, needsYou: true, crashed: true, runtime: "exited" })), "rest")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", needsYou: true, crashed: true, runtime: "none" })), "rest")
  // A live SUB-AGENT is live work → "working", beating the future-timer held state.
  assert.equal(sessionIndicatorKind(thread({ runtime: "turn-idle", subAgents: liveSub, lastFence: awaitingTimer })), "working")
  // A live background SHELL is NOT live work by itself (2026-07-22 — `bgShells` is telemetry, and the
  // server's awaitingBackground is what speaks for the thread): the future-timer wait shows through as "snoozed".
  assert.equal(sessionIndicatorKind(thread({ runtime: "turn-idle", bgShells: liveShell, lastFence: awaitingTimer })), "snoozed")
  assert.equal(sessionIndicatorKind(thread({ state: "archived", needsYou: true, runtime: "exited" })), "archived")
})

// A worker that comes to rest and lands in the queue reads AT REST on the rail, even while the
// sub-agents it dispatched keep running (maintainer 2026-07-27). The children still spin — on their
// OWN indented rows — but the parent's mark speaks for the parent, and the parent has handed off.
test("sessionIndicatorKind: a rested QUEUED thread is at rest even with live sub-agents", () => {
  const restedInQueue = thread({ kind: "session", state: "open", needsYou: true, runtime: "turn-idle", subAgents: liveSub })
  assert.equal(sessionIndicatorKind(restedInQueue), "rest")
  // …and it stays in the undimmed Active section's RESTED band: only the glyph changed.
  assert.equal(sectionOf(restedInQueue), "active")
  assert.equal(isSnoozed(restedInQueue), false)
  assert.equal(partitionActive([restedInQueue]).rested.length, 1)

  // NOTHING else collapses into the ellipsis:
  // • the parent's OWN turn in flight still spins, queued or not
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, runtime: "running" })), "working")
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, runtime: "spawning" })), "working")
  // • a rested thread with live children that is NOT a handoff (event-snoozed card, no queue entry)
  //   keeps its spinner — that row is genuinely just cooking, and the child's return will re-invoke it
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, needsYou: false })), "working")
  // • a concrete ask still wins the row
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, pendingQuestion: true })), "needs-input")
  // • a done fence still reads as the completed handoff
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, lastFence: { kind: "done", body: "shipped", hints: [] } })), "done")
  // • a parked wait keeps its hourglass (needsYou is false there — the server holds it out of the queue)
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, needsYou: false, subAgents: [], lastFence: awaitingShell })), "snoozed")
  // • an EXITED parent with children still reading "running" is a stall, not a rest
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, runtime: "exited" })), "stalled")
})

// A REGISTERED question (mcp__frizz__ask) queues its thread server-side (deriveNeedsYou's
// openQuestions) and the card renders the ask — the rail must agree. Found 2026-08-31: a queued thread
// resting on nothing but an open registered row wore the bare-rest ellipsis beside its own question card.
test("sessionIndicatorKind: a REGISTERED question wears the ? at rest, never the ellipsis", () => {
  const asked = thread({ kind: "session", state: "open", needsYou: true, runtime: "turn-idle", questions: regQuestion })
  assert.equal(sessionIndicatorKind(asked), "needs-input")
  // The ask survives the worker's exit — same rule as pendingQuestion: a real human ask stays a
  // question after the process is gone, never [!].
  assert.equal(sessionIndicatorKind(thread({ ...asked, runtime: "exited" })), "needs-input")
  // …but never stops the spinner: a worker that registers a question KEEPS WORKING (the board keeps
  // these rows out of degradeIfAwaitingAnswer for the same reason).
  assert.equal(sessionIndicatorKind(thread({ ...asked, needsYou: false, runtime: "running" })), "working")
  // A queued rest with live children AND an open row is the ask, not the 2026-07-27 ellipsis.
  assert.equal(sessionIndicatorKind(thread({ ...asked, subAgents: liveSub })), "needs-input")
})

// A USER SNOOZE OUTRANKS THE ASK MARKS, because the SERVER already dequeued the thread on it
// (deriveNeedsYou checks futureSnooze before every ask gate). Until 2026-08-31 the mark did not: a
// snoozed thread with an unanswered ask sat in the dimmed Snoozed band wearing the [?] of a queue
// member, and since it had no card on any surface, nothing rendered the question the mark advertised
// (maintainer: "marked as a question status, but there is no question rendering"). Measured that day on
// the maintainer's own machine: 3 of the 37 rows marked [?] were in exactly this state, across three
// projects.
test("sessionIndicatorKind: a user snooze outranks an ask the server has already dequeued", () => {
  const parked = { snoozedUntil: "2999-01-01T00:00:00.000Z", needsYou: false, runtime: "turn-idle" as const }
  // A ```question fence at the tail (pendingQuestion), a registered row, and a native ask — all three.
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", ...parked, pendingQuestion: true })), "snoozed")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", ...parked, questions: regQuestion })), "snoozed")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", ...parked, pendingAsk: { questions: [] } })), "snoozed")
  // MOTION still wins — a park does not change what the process is doing, and isSnoozed carves both out
  // (a running/spawning turn, and a live sub-agent whose return will re-invoke the thread).
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", ...parked, runtime: "running", questions: regQuestion })), "working")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", ...parked, questions: regQuestion, subAgents: liveSub })), "working")
  // A ```question fence mid-turn is the one ask that outranks motion, snoozed or not, and that is
  // untouched here: the board degrades a pendingQuestion thread to turn-idle anyway
  // (board.degradeIfAwaitingAnswer), so the pair below does not occur in production.
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", ...parked, runtime: "running", pendingQuestion: true })), "needs-input")
  // …and an ask with NO user park is untouched: the server queues it, so the [?] leads to a real card.
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", needsYou: true, runtime: "turn-idle", pendingQuestion: true })), "needs-input")
})

test("needsAction: a user-snoozed ask is not an attention row — the server dequeued it", () => {
  const parked = { snoozedUntil: "2999-01-01T00:00:00.000Z", runtime: "turn-idle" as const }
  assert.equal(needsAction(thread({ ...parked, pendingQuestion: true })), false)
  assert.equal(needsAction(thread({ ...parked, questions: regQuestion })), false)
  assert.equal(needsAction(thread({ ...parked, pendingAsk: { questions: [] } })), false)
  // A perm-prompt is parked by the same rule — the server checks futureSnooze ahead of it too.
  assert.equal(needsAction(thread({ ...parked, runtime: "perm-prompt" })), false)
  // The park ELAPSED ⇒ the ask is a queue member again, with nothing to re-derive.
  assert.equal(needsAction(thread({ runtime: "turn-idle", snoozedUntil: "2020-01-01T00:00:00.000Z", pendingQuestion: true })), true)
})

// THE SHELL-ONLY REST — maintainer 2026-08-01: "if a thread has rested but it still has background work
// going, like background shells, we should … stop the spinner and put a pulsing blue dot in the middle
// of the rounded circle shape" — and, decisively, "this should not show up if there are sub-agents". So
// the two live-work states are told apart rather than merged: a dispatched CHILD will come back and
// re-invoke the parent (real motion → spinner), a detached SHELL will not (alive but still → dot).
//
// The MARK outlived the BAND. Since 2026-08-04 such a thread QUEUES ("if a thread has rested and the
// only thing remaining is background shells, we should put it into the queue"), so `needsYou` puts its
// row below the rule — and the dot stays, because it is what tells that row apart from a bare rest.
test("sessionIndicatorKind: a queued shell-only rest sits in the rested band and still wears the dot", () => {
  // needsYou TRUE is server truth for this state, not an assumption: board.deriveNeedsYou excuses a rest
  // on a live SUB-AGENT only, so a shell-only rest is an ordinary queue handoff again.
  const shellRest = thread({ kind: "session", state: "open", needsYou: true, runtime: "turn-idle", awaitingBackground: true, bgShells: liveShell })
  assert.equal(sessionIndicatorKind(shellRest), "background", "the dot outranks the 2026-07-27 queued-rest ellipsis")
  assert.equal(queued(shellRest), true)
  assert.deepEqual(partitionActive([shellRest]).rested.map((t) => t.id), ["t"], "a card must have a rested-band row")

  // SNOOZED — the card's own event-Snooze clears needsYou (board.bgSnoozeArmed) while the thread stays
  // alive. It goes back to the running band wearing the SAME dot: still alive, no longer asking.
  const snoozed = thread({ ...shellRest, needsYou: false })
  assert.equal(sessionIndicatorKind(snoozed), "background")
  assert.deepEqual(partitionActive([snoozed]).running.map((t) => t.id), ["t"])
  assert.equal(queued(snoozed), false, "a row in the running band must never also be a queue card")

  // A LIVE SUB-AGENT OUTRANKS THE SHELL — the dot must not show up for it, however the shell reads.
  const withChild = thread({ ...shellRest, needsYou: false, subAgents: liveSub })
  assert.equal(sessionIndicatorKind(withChild), "working", "a dispatched child is real motion — it spins")
  assert.equal(sessionIndicatorKind(thread({ ...withChild, needsYou: true })), "rest", "…and queued, it is the 2026-07-27 ellipsis, still never the dot")

  // The shell going quiet leaves an ordinary rest — same band, the plain ellipsis, still queued.
  const settled = thread({ ...shellRest, awaitingBackground: false, bgShells: [] })
  assert.equal(sessionIndicatorKind(settled), "rest")
  assert.equal(queued(settled), true)
  assert.deepEqual(partitionActive([settled]).rested.map((t) => t.id), ["t"])
  // An EXITED worker whose shell still reads live is a stall, not a quietly-alive row.
  assert.equal(sessionIndicatorKind(thread({ ...shellRest, runtime: "exited" })), "stalled")
})

// A RECURRING PROMPT IS NOT A RAIL FACT — maintainer 2026-08-02, killing a mark that had shipped hours
// earlier: "the whole point of a stop hook is that it means the agent never stops, so it should always
// just be loading." (Said of the rest trigger, back when it was its own feature; it binds the merged
// control the same way, and the schedule trigger only makes it truer.)
//
// Exactly right, and the mark could only ever have contradicted it. `working` outranks everything below
// it, so the mark renders only in the at-rest gap — and a live prompt barely has one (the thread is
// bumped again within a tick of stopping). The at-rest state that does last is the thread whose agent
// answered ALLDONE, i.e. the loop that just CLOSED. The mark was invisible while the prompt was doing
// its job and visible only once it had stopped doing it.
//
// So an armed thread's rail row is whatever it would have been anyway: spinning while it works, at rest
// when it is genuinely done. This test is the guard against reintroducing the mark.
test("sessionIndicatorKind: an armed recurring prompt changes NO rail mark", () => {
  const hook = { prompt: "keep going", stopHook: true, heartbeat: false, armedAt: "2026-07-10T00:00:00.000Z" }
  const base = { kind: "session" as const, state: "open" as const, needsYou: false, runtime: "turn-idle" as const }

  // At rest with a hook armed: the ordinary at-rest ellipsis, exactly as without one.
  assert.equal(sessionIndicatorKind(thread({ ...base, recurringPrompt: hook })), "rest")
  assert.equal(sessionIndicatorKind(thread({ ...base })), "rest")
  // Disabled likewise.
  assert.equal(sessionIndicatorKind(thread({ ...base, recurringPrompt: { ...hook, stopHook: false } })), "rest")
  // And every other state keeps the mark it earned on its own terms.
  assert.equal(sessionIndicatorKind(thread({ ...base, recurringPrompt: hook, subAgents: liveSub })), "working")
  assert.equal(sessionIndicatorKind(thread({ ...base, recurringPrompt: hook, awaitingBackground: true, bgShells: liveShell })), "background")
  assert.equal(sessionIndicatorKind(thread({ ...base, recurringPrompt: hook, needsYou: true, pendingQuestion: true })), "needs-input")
})

// THE INVARIANT, stated once and checked over every shape the rail can produce (maintainer 2026-08-01:
// "if something is listed as currently running, then it should never show up in the queue"). It holds by
// CONSTRUCTION — inActiveBand is `isActivelyRunning && !needsYou`, and `queued` is `needsYou` —
// so this test is really guarding the construction: any future clause that bands a row on something
// OTHER than the absence of a queue card breaks it here.
test("partitionActive: NOTHING in the running band has a queue card, and every card has a rested-band row", () => {
  const at = "2026-07-09T00:00:00.000Z"
  const base = { kind: "session" as const, state: "open" as const, lastUserAt: at }
  const shapes = [
    thread({ ...base, id: "own-turn", runtime: "running", needsYou: false }),
    thread({ ...base, id: "spawning", runtime: "spawning", needsYou: false }),
    thread({ ...base, id: "rested-on-child", runtime: "turn-idle", needsYou: false, awaitingBackground: true, subAgents: liveSub }),
    // Shell-only and EXCUSED from the queue with no card — the shape the server produced for an
    // event-snoozed shell rest until 2026-08-28. An event-snoozed one now carries `bgSnoozed` and sections
    // to Snoozed before partitionActive ever sees it; a cardless one that is NOT snoozed still bands here.
    // Its queued twin is `queued-on-shell` below.
    thread({ ...base, id: "excused-on-shell", runtime: "turn-idle", needsYou: false, awaitingBackground: true, bgShells: liveShell }),
    thread({ ...base, id: "queued-on-shell", runtime: "turn-idle", needsYou: true, awaitingBackground: true, bgShells: liveShell }),
    thread({ ...base, id: "bare-rest", runtime: "turn-idle", needsYou: true }),
    thread({ ...base, id: "asking", runtime: "turn-idle", needsYou: true, pendingQuestion: true }),
    thread({ ...base, id: "stalled", runtime: "exited", needsYou: true }),
    thread({ ...base, id: "done-fenced", runtime: "turn-idle", needsYou: true, lastFence: { kind: "done", body: "shipped", hints: [] } }),
    // The rare spinning-yet-queued shape: its own turn is in flight AND the server queued it.
    thread({ ...base, id: "spin-ask", runtime: "running", needsYou: true }),
    // AT REST, NOT SPINNING, AND EXCUSED FROM THE QUEUE ANYWAY — the shape that has now broken the cue
    // twice. The server takes a thread out of the queue for reasons the client cannot see and does not
    // always band it (`awaitingBackground`): a snoozed shell-only rest in 2026-07-29, a stale delivery
    // ledger in 2026-08-14. Wherever the next one comes from, it belongs BELOW the rule — a cue row with
    // no card looks queued, answers nothing, and opens a drawer on click instead of scrolling to a card.
    thread({ ...base, id: "excused-at-rest", runtime: "turn-idle", needsYou: false }),
  ]
  const { running, rested } = partitionActive(shapes)
  assert.equal(running.length + rested.length, shapes.length, "every thread lands in exactly one band")
  for (const t of running) assert.equal(queued(t), false, `${t.id} is in the running band but carries a queue card`)
  for (const t of shapes.filter(queued)) {
    assert.ok(rested.some((r) => r.id === t.id), `${t.id} has a queue card but no rested-band row to map it to`)
  }
  // THE OTHER DIRECTION, which is the half that kept breaking: the cue is EXACTLY the cards.
  for (const t of rested) assert.equal(queued(t), true, `${t.id} sits in the cue with no queue card behind it`)
  // …and the rested-with-live-work rows are exactly the ones that made this worth pinning: the excused
  // child and the snoozed shell band on top, while the QUEUED shell sits below the rule with its card.
  assert.deepEqual(running.map((t) => t.id), ["own-turn", "spawning", "rested-on-child", "excused-on-shell", "excused-at-rest"])
})

// ── THE STALLED/RETRY CONTRACT ────────────────────────────────────────────────────────────────────
// The queue card's Retry button and the sidebar row's yellow [!] must be ONE decision. They were not:
// the card gated on "the process exited" while the row gated on the server's `crashed` bit (exited AND
// turn-in-flight/live-background-work), so a worker that exited at BARE REST carried a Retry button on
// its card while its rail row read a calm "At rest" […] (maintainer 2026-07-23: "the card in the queue
// has a retry button, but it's not marked as stalled in the sidebar with the yellow and the exclamation
// point"). This table is the enumeration that found it; the invariant below is what keeps it fixed.
const RETRY_CONTRACT: { name: string; over: Partial<ThreadView>; kind: string; retry: boolean }[] = [
  // ── the states that must show BOTH the [!] and the Retry ──
  { name: "exited mid-turn (crashed) — the classic stall", over: { needsYou: true, crashed: true, runtime: "exited" }, kind: "stalled", retry: true },
  // THE REGRESSION: this row said kind "rest" (no badge) while its card offered Retry.
  { name: "exited at bare rest (crashed:false, no done fence)", over: { needsYou: true, crashed: false, runtime: "exited" }, kind: "stalled", retry: true },
  { name: "exited on a pre-reload snapshot with no `crashed` field", over: { needsYou: true, runtime: "exited" }, kind: "stalled", retry: true },
  { name: "exited at rest and NOT queued (needsYou cleared)", over: { needsYou: false, crashed: false, runtime: "exited" }, kind: "stalled", retry: true },
  // ── the states that must show NEITHER ──
  { name: "live and working", over: { runtime: "running" }, kind: "working", retry: false },
  { name: "live at rest (turn-idle) — type at it, don't retry", over: { needsYou: true, crashed: false, runtime: "turn-idle" }, kind: "rest", retry: false },
  { name: "exited mid-ask — answered, not retried", over: { needsYou: true, crashed: true, humanBlocked: true, status: "needs-human", runtime: "exited" }, kind: "needs-input", retry: false },
  { name: "exited with a pending question", over: { needsYou: true, pendingQuestion: true, runtime: "exited" }, kind: "needs-input", retry: false },
  { name: "exited after a done fence — finished, not stopped", over: { runtime: "exited", lastFence: { kind: "done", body: "shipped", hints: [] } }, kind: "done", retry: false },
  { name: "exited but snoozed — held, wakes on its own deadline", over: { runtime: "exited", snoozedUntil: "2999-01-01T00:00:00.000Z" }, kind: "snoozed", retry: false },
  { name: "archived", over: { state: "archived", needsYou: true, crashed: true, runtime: "exited" }, kind: "archived", retry: false },
  { name: "foreign (read-only — nothing frizz can restart)", over: { foreign: true, crashed: true, needsYou: true, runtime: "exited" }, kind: "rest", retry: false },
  { name: "registry lost the row (runtime none — not reattachable)", over: { needsYou: true, crashed: true, runtime: "none" }, kind: "rest", retry: false },
  // ── KILLED BY A USAGE LIMIT frizz will auto-resume: the rail's OTHER yellow mark, with Retry ──
  // Snoozed until 2026-08-31 (maintainer: killed threads "showed up and fucking snoozed … they should
  // have shown up in the queue, as threads that had failed in some way"); the server now queues them.
  { name: "killed by a session limit (auto-resume) — yellow hourglass, retry", over: { needsYou: true, runtime: "exited", limitPause: { backend: "claude", window: "session", at: "2026-07-23T00:00:00.000Z", autoResume: true } }, kind: "limit", retry: true },
  { name: "killed by a weekly limit (auto-resume) — same one-click continue", over: { needsYou: true, runtime: "exited", limitPause: { backend: "codex", window: "weekly", at: "2026-07-23T00:00:00.000Z", autoResume: true } }, kind: "limit", retry: true },
  // The mark must not hinge on needsYou arriving: a stale snapshot still reads as a limit kill.
  { name: "killed by a limit, needsYou not yet set — still the limit mark", over: { runtime: "exited", limitPause: { backend: "claude", window: "session", at: "2026-07-23T00:00:00.000Z", autoResume: true } }, kind: "limit", retry: true },
  // The OPERATOR's own snooze outranks the kill: they parked it, so it parks (and Retry stands down).
  { name: "limit-killed but user-snoozed — the human's park wins", over: { runtime: "exited", snoozedUntil: "2999-01-01T00:00:00.000Z", limitPause: { backend: "claude", window: "session", at: "2026-07-23T00:00:00.000Z", autoResume: true } }, kind: "snoozed", retry: false },
  // A limit pause frizz will NOT auto-resume (an unknown phrasing, an aged-out fault) is STILL a limit
  // kill: same yellow hourglass, same Retry — there the Retry is the only way back, not a shortcut.
  { name: "limit pause without auto-resume — still the limit mark, retry is the way back", over: { needsYou: true, runtime: "exited", limitPause: { backend: "claude", window: "unknown", at: "2026-07-23T00:00:00.000Z", autoResume: false } }, kind: "limit", retry: true },
  // A FOREIGN read-only session is nothing frizz can restart, so it takes neither yellow mark.
  { name: "foreign killed on a limit — read-only, no retry", over: { foreign: true, runtime: "exited", limitPause: { backend: "claude", window: "session", at: "2026-07-23T00:00:00.000Z", autoResume: true } }, kind: "rest", retry: false },
]

test("offersRetry: the retry gate is the stalled state PLUS the auto-resume limit kill", () => {
  for (const { name, over, kind, retry } of RETRY_CONTRACT) {
    const t = thread({ kind: "session", ...over })
    assert.equal(sessionIndicatorKind(t), kind, `${name}: sidebar indicator`)
    assert.equal(offersRetry(t), retry, `${name}: inline retry`)
  }
  assert.equal(offersRetry(thread({ kind: "legacy", crashed: true, runtime: "exited" })), false, "legacy: no provider runtime")
})

test("every surface shares the ONE offersRetry derivation — the retry verb is stalled OR limit-killed", () => {
  // The load-bearing invariant is that the sidebar row, queue card, and drawer header ALL read
  // offersRetry, so no two can disagree about a thread (the drift bug, maintainer 2026-07-23, twice).
  // Since 2026-08-31 the pairing is also the maintainer's rail invariant: retry ⇔ YELLOW — the stalled
  // [!] and the limit kill's yellow hourglass are exactly the rows that carry the hover Retry, and a
  // snoozed/timer park never does.
  for (const { name, over } of RETRY_CONTRACT) {
    const t = thread({ kind: "session", ...over })
    const kind = sessionIndicatorKind(t)
    assert.equal(
      offersRetry(t),
      kind === "stalled" || kind === "limit",
      `${name}: Retry is offered on exactly the yellow rows (stalled or limit-killed)`,
    )
  }
  // A held row parked by something OTHER than a limit frizz will auto-resume (a user snooze, a timer
  // wait) must NEVER offer Retry — those are intentional parks with no stall to recover.
  assert.equal(offersRetry(thread({ kind: "session", runtime: "exited", snoozedUntil: "2999-01-01T00:00:00.000Z" })), false, "snooze-snoozed: no retry")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", runtime: "exited", snoozedUntil: "2999-01-01T00:00:00.000Z" })), "snoozed", "snooze-snoozed: still held")
})

test("queued: legacy rows NEVER card (only session threads enter the queue)", () => {
  // kind absent = legacy; even a would-be-actionable legacy row stays out of the queue.
  assert.equal(queued(thread({ needsYou: true, status: "needs-human", humanBlocked: true })), false)
  assert.equal(queued(thread({ kind: "legacy", needsYou: true })), false)
})

test("queued: an archived session thread stays out of the queue even if needsYou lingers", () => {
  assert.equal(queued(thread({ kind: "session", needsYou: true, state: "archived" })), false)
})

test("queued: pre-restart snapshot (no kind/needsYou) degrades to an empty queue", () => {
  assert.equal(queued(thread({})), false)
})

test("orderQueue: NO priority band — one strict time order across attention + passive alike", () => {
  // The hidden hard-attention band is gone (maintainer 2026-07-21: "too confusing"). Order is
  // last-active alone; kind (crash/question vs done/rest) never lifts a card into a separate tier.
  // The timestamps deliberately INTERLEAVE attention and passive rows so BOTH directions differ from
  // the old banded order — proving band removal, not just re-proving FIFO:
  //   crash-newest 07-14 (hard) · done-newer 07-13 (passive) · question-older 07-11 (hard) · rest-oldest 07-10 (passive)
  // Old banded FIFO would be [question-older, crash-newest, rest-oldest, done-newer]; old banded LIFO
  // [crash-newest, question-older, done-newer, rest-oldest]. Both differ from the strict orders below.
  const rows = () => [
    thread({ id: "crash-newest", lastUserAt: "2026-07-14T12:00:00.000Z", crashed: true }),
    thread({ id: "done-newer", lastUserAt: "2026-07-13T12:00:00.000Z", lastFence: { kind: "done", body: "shipped", hints: [] } }),
    thread({ id: "question-older", lastUserAt: "2026-07-11T12:00:00.000Z", pendingQuestion: true }),
    thread({ id: "rest-oldest", lastUserAt: "2026-07-10T12:00:00.000Z" }),
  ]
  // FIFO oldest-first: the fresh CRASH sinks to the BOTTOM under an older done card — the accepted tradeoff.
  assert.deepEqual(orderQueue(rows()).map((item) => item.id), ["rest-oldest", "question-older", "done-newer", "crash-newest"])
  // LIFO newest-first: a newer DONE card outranks an older question — impossible under the old band.
  assert.deepEqual(orderQueue(rows(), "lifo").map((item) => item.id), ["crash-newest", "done-newer", "question-older", "rest-oldest"])
})

test("orderQueue: AT-REST rows key on REST TIME (lastAssistantAt), not lastActivityAt; direction flips it", () => {
  // The row that came to REST later (later lastAssistantAt = its final assistant output) is more
  // recently active. Ordering keys on this, NOT lastActivityAt — even though a much-later lastActivityAt
  // (a background sub-agent's completion notification) is present, it must NOT move the row. FIFO
  // (default) leads with the longest-since-rested (earlier-rested) row.
  const rows = () => [
    thread({ id: "rested-later", lastUserAt: "2026-07-14T12:00:00.000Z", lastAssistantAt: "2026-07-14T12:05:00.000Z", lastActivityAt: "2026-07-14T13:00:00.000Z" }),
    thread({ id: "rested-earlier", lastUserAt: "2026-07-14T12:00:00.000Z", lastAssistantAt: "2026-07-14T12:01:00.000Z", lastActivityAt: "2026-07-14T13:30:00.000Z" }),
  ]
  assert.deepEqual(orderQueue(rows()).map((item) => item.id), ["rested-earlier", "rested-later"])
  // LIFO surfaces the most recently rested first.
  assert.deepEqual(orderQueue(rows(), "lifo").map((item) => item.id), ["rested-later", "rested-earlier"])
})

test("orderQueue: a background sub-agent completing (lastActivityAt bump) does NOT reorder an at-rest row", () => {
  // The exact regression: a completed sub-agent posts a promptSource:system record that bumps the
  // parent's lastActivityAt but NOT its lastAssistantAt (rest time). Since ordering keys on rest time,
  // the parent's position is invariant to that child motion. Equal rest times ⇒ id tiebreak holds
  // no matter how recent the child-driven lastActivityAt is.
  const rows = (childActivity: string) => [
    thread({ id: "bravo", lastAssistantAt: "2026-07-14T12:00:00.000Z", lastActivityAt: childActivity }),
    thread({ id: "alpha", lastAssistantAt: "2026-07-14T12:00:00.000Z", lastActivityAt: childActivity }),
  ]
  assert.deepEqual(orderQueue(rows("2026-07-14T12:00:01.000Z")).map((item) => item.id), ["alpha", "bravo"])
  assert.deepEqual(orderQueue(rows("2026-07-14T18:00:00.000Z")).map((item) => item.id), ["alpha", "bravo"])
})

test("orderQueue: high-frequency agent activity on a RUNNING row cannot oscillate order (churn guard)", () => {
  // A running row keys off its STABLE user-interaction time, never the churning lastActivityAt — so
  // tool_result motion the user didn't cause can never reorder it. Equal lastUserAt/spawnedAt ⇒ the
  // id tiebreak holds regardless of how fast lastActivityAt advances.
  const rows = (activity: string) => [
    thread({ id: "bravo", runtime: "running", lastUserAt: "2026-07-14T12:00:00.000Z", lastActivityAt: activity }),
    thread({ id: "alpha", runtime: "running", lastUserAt: "2026-07-14T12:00:00.000Z", lastActivityAt: activity }),
  ]
  assert.deepEqual(orderQueue(rows("2026-07-14T12:00:01.000Z")).map((item) => item.id), ["alpha", "bravo"])
  assert.deepEqual(orderQueue(rows("2026-07-14T12:09:00.000Z")).map((item) => item.id), ["alpha", "bravo"])
})

test("lastActiveLabelAt: at-rest shows REST time, running shows live activity, sub-agent bump ignored at rest", () => {
  // At rest → the agent's own rest time (lastAssistantAt), NOT the later lastActivityAt a completed
  // sub-agent bumped. So the label reads "when the agent rested", never a spurious "just now".
  assert.equal(
    lastActiveLabelAt(thread({ runtime: "turn-idle", lastAssistantAt: "2026-07-14T12:00:00.000Z", lastActivityAt: "2026-07-14T13:00:00.000Z" })),
    "2026-07-14T12:00:00.000Z",
  )
  // Running → live activity (a running row IS active now), matching the spinner.
  assert.equal(
    lastActiveLabelAt(thread({ runtime: "running", lastAssistantAt: "2026-07-14T12:00:00.000Z", lastActivityAt: "2026-07-14T13:00:00.000Z" })),
    "2026-07-14T13:00:00.000Z",
  )
  // At rest with no recorded rest instant → falls back to lastActivityAt, then spawn.
  assert.equal(
    lastActiveLabelAt(thread({ runtime: "turn-idle", lastAssistantAt: undefined, lastActivityAt: "2026-07-14T11:00:00.000Z" })),
    "2026-07-14T11:00:00.000Z",
  )
})

// ---- sidebar sections: session-first partition ----

test("sectionOf: running/needs-you land in the Active+Rested section; only truthful human/future-timer waits are Snoozed", () => {
  // Legacy / absent-kind rows are HIDDEN entirely (null), any status.
  assert.equal(sectionOf(thread({ status: "active" })), null)
  assert.equal(sectionOf(thread({ kind: "legacy", status: "done" })), null)
  // Open in-play work stays in the Active+Rested section: running, at-rest bare, needs-you, done-fenced.
  // Which BAND each lands in is partitionActive's job, not this key's — a needs-you row is RESTED, not Active.
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "running" })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle" })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", needsYou: true })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "done", body: "shipped", hints: [] } })), "active")
  // A hintless fence still reaches Snoozed when the SERVER excused the thread — the client reads that
  // verdict rather than re-deriving it from hints it can no longer check (2026-08-15).
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [] } })), "snoozed")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", needsYou: true, runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [] } })), "active", "…and a queued one stays queued")
  // Archive wins over a lingering needsYou.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived" })), "inactive")
  assert.equal(sectionOf(thread({ kind: "session", needsYou: true, state: "archived" })), "inactive")
  // Foreign sessions section as active by sectionOf — but sectionThreads EXCLUDES them from rows.
  assert.equal(sectionOf(thread({ kind: "session", foreign: true, runtime: "running" })), "active")
})

test("sectionOf: an ARCHIVED thread that's ACTIVELY RUNNING goes to Active (never a spinner under Inactive)", () => {
  // Idle-archived stays Inactive — the user hid it and it's at rest.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle" })), "inactive")
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "exited" })), "inactive")
  // Running / spawning archived → Active (a live, in-flight session must NEVER sit in Inactive; maintainer hit 3×).
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "running" })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "spawning" })), "active")
  // turn-idle but a dispatched sub-agent is still going (the sidebar shows a spinner) → Active too.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle", subAgents: [{ label: "x", startedAt: "2026-07-10T00:00:00.000Z", state: "running", id: "a1" }] })), "active")
  // A live background Bash/Monitor is NOT live work (2026-07-22): an idle-archived thread with only a
  // background shell stays Inactive — the shell can't be told apart from an endless dev server.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle", bgShells: [{ label: "watch CI", startedAt: "2026-07-10T00:00:00.000Z", state: "running" }] })), "inactive")
})

test("sectionThreads v2: Active bands rested-on-top (queue order) then running; foreign + legacy excluded", () => {
  const s = sectionThreads([
    thread({ id: "older", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
    thread({ id: "newer", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-09T01:00:00.000Z" }),
    thread({ id: "queued", kind: "session", state: "open", needsYou: true, lastUserAt: "2026-07-09T02:00:00.000Z" }),
    thread({ id: "arch", kind: "session", state: "archived" }),
    thread({ id: "old", status: "done" }),
    thread({ id: "term", kind: "session", foreign: true, runtime: "running" }),
  ])
  // The CUE leads (the rested rows, in queue order, sit directly under the prompt box); the running
  // band follows BELOW it, ordered by interaction recency (newer before older).
  assert.deepEqual(s.active.map((t) => t.id), ["queued", "newer", "older"])
  assert.deepEqual(s.inactive.map((t) => t.id), ["arch"])
  assert.equal("legacy" in s, false)
})

test("sectionThreads: a pin diverts a thread out of EVERY band onto the pinned shelf, in pin order", () => {
  const s = sectionThreads([
    thread({ id: "queued", kind: "session", state: "open", needsYou: true }),
    // Pinned out of each band it would otherwise land in: running (Active), archived (Done), and a
    // future user snooze (Snoozed). The pin outranks all three — that is the feature.
    thread({ id: "pin-running", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-09-02T02:00:00.000Z", pinnedAt: "2026-09-02T02:00:00.000Z" }),
    thread({ id: "pin-done", kind: "session", state: "archived", pinnedAt: "2026-09-01T01:00:00.000Z" }),
    thread({ id: "pin-snoozed", kind: "session", state: "open", snoozedUntil: "2126-01-01T00:00:00.000Z", pinnedAt: "2026-09-03T03:00:00.000Z" }),
    // Foreign never rows, pinnedAt or not — the foreign drop sits ABOVE the pin diversion.
    thread({ id: "term", kind: "session", foreign: true, pinnedAt: "2026-08-01T00:00:00.000Z" }),
  ])
  // Pin instants decide the shelf's order — oldest pin first — never the threads' own activity.
  assert.deepEqual(s.pinned.map((t) => t.id), ["pin-done", "pin-running", "pin-snoozed"])
  assert.deepEqual(s.active.map((t) => t.id), ["queued"])
  assert.deepEqual(s.snoozed, [])
  assert.deepEqual(s.inactive, [])
})

test("partitionActive: splits an ordered Active list into running/rested; queued stays rested; FIFO within rested", () => {
  // A queued thread that ALSO reads as actively running (spinning-yet-needs-you) still files under
  // rested so its queue card maps to a rested-band row.
  const active = [
    thread({ id: "run-b", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-09T00:00:00.000Z" }),
    thread({ id: "run-a", kind: "session", state: "open", runtime: "spawning", lastUserAt: "2026-07-08T00:00:00.000Z" }),
    thread({ id: "rest-old", kind: "session", state: "open", needsYou: true, lastUserAt: "2026-07-05T00:00:00.000Z" }),
    thread({ id: "rest-new", kind: "session", state: "open", needsYou: true, lastUserAt: "2026-07-11T00:00:00.000Z" }),
    thread({ id: "spin-ask", kind: "session", state: "open", runtime: "running", needsYou: true, lastUserAt: "2026-07-06T00:00:00.000Z" }),
  ]
  // orderQueue over the rested set is FIFO (oldest first): rest-old (07-05) < spin-ask (07-06) < rest-new (07-11).
  const ordered = [
    active[2], active[4], active[3], // the cue leads, in FIFO order
    active[0], active[1], // running band below it (already recency-ordered for this fixture)
  ]
  const { running, rested } = partitionActive(ordered)
  assert.deepEqual(running.map((t) => t.id), ["run-b", "run-a"])
  assert.deepEqual(rested.map((t) => t.id), ["rest-old", "spin-ask", "rest-new"])
})

// LIVE OWN WORK KEEPS THE ROW IN THE RUNNING BAND, and the server is what puts it there — by excusing it
// from the queue, which is the same thing. A live child is excused outright; a shell-only rest reaches
// this state only once the human snoozes its card (needsYou false is the shared precondition). They
// differ only in what the row READS as.
test("partitionActive: a thread cooking on its own background work, with no card, stays in the running band", () => {
  const at = "2026-07-09T00:00:00.000Z"
  const shellOnly = thread({ id: "shell-only", kind: "session", state: "open", runtime: "turn-idle", needsYou: false, awaitingBackground: true, subAgents: [], bgShells: liveShell, lastUserAt: at })
  const withChild = thread({ id: "with-child", kind: "session", state: "open", runtime: "turn-idle", needsYou: false, awaitingBackground: true, subAgents: [{ id: "a1", label: "c", startedAt: at, state: "running" }], lastUserAt: at })
  const { running, rested } = partitionActive([shellOnly, withChild])
  assert.deepEqual(running.map((t) => t.id), ["shell-only", "with-child"])
  assert.deepEqual(rested.map((t) => t.id), [])
  // Same band, two different readings — and that split is deliberate: the shell is alive-but-still, the
  // dispatched child is motion that will come back.
  assert.equal(sessionIndicatorKind(shellOnly), "background")
  assert.equal(sessionIndicatorKind(withChild), "working")
})

// THE LAYOUT-SHIFT FIX (maintainer 2026-07-30): "if an agent has children that are still running child
// subprocesses or subagents, but it itself has rested, it should still stay in the active agent's rail
// instead of shifting down to the queue … it should only show up in the queue when it's fully rested and
// it has no running sub-agents". The server stops setting needsYou for that thread
// (board.deriveNeedsYou), and these are the two consequences on the rail that the human actually sees.
test("partitionActive: a parent resting on a live sub-agent holds its place in the running band", () => {
  const at = "2026-07-09T00:00:00.000Z"
  const child = [{ id: "a1", label: "c", startedAt: at, state: "running" as const }]
  // Mid-turn, then rested-with-the-child-still-out: the SAME row, and it must not move between them.
  const working = thread({ id: "p", kind: "session", state: "open", runtime: "running", needsYou: false, subAgents: child, lastUserAt: at })
  const rested = thread({ id: "p", kind: "session", state: "open", runtime: "turn-idle", needsYou: false, awaitingBackground: true, subAgents: child, lastUserAt: at })
  assert.deepEqual(partitionActive([working]).running.map((t) => t.id), ["p"])
  assert.deepEqual(partitionActive([rested]).running.map((t) => t.id), ["p"], "resting on a child must not drop it to the rested band")
  // FULLY rested — the last child returned — is the one state that belongs in the queue-ordered band.
  const done = thread({ id: "p", kind: "session", state: "open", runtime: "turn-idle", needsYou: true, subAgents: [], lastUserAt: at })
  assert.deepEqual(partitionActive([done]).rested.map((t) => t.id), ["p"])
})

test("sessionIndicatorKind: a parent resting on a live sub-agent keeps its spinner, so the row never flickers", () => {
  const at = "2026-07-09T00:00:00.000Z"
  const child = [{ id: "a1", label: "c", startedAt: at, state: "running" as const }]
  // Same glyph mid-turn and at rest-with-a-child — the point is that NOTHING about the row changes when
  // the parent's own turn ends, which is what removes the churn the maintainer reported. The 2026-08-01
  // dot deliberately does NOT reach here ("this should not show up if there are sub-agents").
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", runtime: "running", needsYou: false, subAgents: child })), "working")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", runtime: "turn-idle", needsYou: false, awaitingBackground: true, subAgents: child })), "working")
  // The EXITED parent is the case restedQueueHandoff still protects: its children keep reading "running"
  // until they go stale, and it must read as a stall, never as a spinner.
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", runtime: "exited", needsYou: true, subAgents: child })), "stalled")
})

// ---- isSnoozed: every rendered wait glyph belongs to the labeled dimmed Snoozed band ----

const awaitingShell = { kind: "awaiting" as const, body: "", hints: [{ kind: "shell" as const, value: "bzvtnt3ig" }, { kind: "for" as const, value: "2h" }] }
const awaitingPrWatch = { kind: "awaiting" as const, body: "", hints: [{ kind: "pr" as const, value: "owner/repo#12" }] }
const awaitingTimer = { kind: "awaiting" as const, body: "", hints: [{ kind: "timer" as const, value: "tmr_a1b2c3" }, { kind: "for" as const, value: "2h" }] }
const awaitingPr = { kind: "awaiting" as const, body: "", hints: [{ kind: "pr" as const, value: "owner/repo#12" }, { kind: "for" as const, value: "2h" }] }
const liveSub = [{ label: "x", startedAt: "2026-07-10T00:00:00.000Z", state: "running" as const, id: "a1" }]
/** One open registered question (mcp__frizz__ask), as the board emits it on `questions`. */
const regQuestion = [{ id: "qst_ab12cd34", spec: { question: "Merge it?", kind: "question" as const }, askedAt: "2026-08-31T00:00:00.000Z" }]
const liveShell = [{ label: "Watch CI", startedAt: "2026-07-10T00:00:00.000Z", state: "running" as const }]
// HELD IS THE SERVER'S VERDICT, and this pins that the client reads it rather than re-deriving it.
//
// The matrix this replaced walked every hint kind — a human gate held, a future timer held, an elapsed
// one did not, a malformed one did not — because the FENCE was the registration and the client could
// judge it from the text. That grammar is deleted (2026-08-15): a park is honoured only when every item
// it names is still live, checked against telemetry and the registries the browser cannot see. The
// server excuses an honoured park from the queue, so what the client has to do is trust that and put it
// in the dimmed band, and NOT invent a second opinion from the hints.
test("isSnoozed: an awaiting fence the server honoured is Snoozed; anything it did not is not", () => {
  // Honoured ⇒ the server cleared needsYou, and the fence says the rest.
  assert.equal(isSnoozed(thread({ runtime: "turn-idle", lastFence: awaitingShell })), true)
  assert.equal(isSnoozed(thread({ runtime: "exited", lastFence: awaitingShell })), true)
  // The FENCE alone, with no awaitingBackground behind it — a shape the server stopped emitting for a
  // PR park when it started flagging one (2026-08-13). A real PR park carries the flag and is NOT Snoozed,
  // because a wait whose reviews may never arrive must stay visible: see parkedAwaitingHint, and the
  // prPark case in the armed-timer test below, which pins the shape board.ts actually sends.
  assert.equal(isSnoozed(thread({ runtime: "turn-idle", lastFence: awaitingPrWatch })), true, "the client trusts the excusal, whatever the fence names")
  // NOT honoured ⇒ the server left it in the queue, and needsYou is what says so. The fence being
  // present changes nothing: an unverifiable declaration is not a park.
  assert.equal(isSnoozed(thread({ runtime: "turn-idle", needsYou: true, lastFence: awaitingShell })), false, "queued means not held, fence or no fence")
  // No fence at all is an ordinary rest.
  assert.equal(isSnoozed(thread({ runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [] } })), true, "the server still excused it — that is its call, not the client's")
  assert.equal(isSnoozed(thread({ runtime: "turn-idle" })), false, "no fence, no park")
  // Mid-turn work keeps spinning in Active whatever it declared.
  assert.equal(isSnoozed(thread({ runtime: "running", lastFence: awaitingShell })), false)
})

// THE SHAPE THE SERVER ACTUALLY EMITS — which is the one thing every isSnoozed fixture above leaves out,
// and the reason this suite stayed green while the real board got it wrong. `awaitingBackground` is TRUE
// on a parked ```awaiting fence: for a declared background park, for a registered PR watch (2026-08-13),
// and for an ARMED TIMER (2026-08-24, f50f9e60). hasLiveOps read that widened flag through its old
// meaning — "its own dispatched work is still live" — so isSnoozed's FIRST gate threw the one park
// ARCHITECTURE.md names as Snoozed, "a valid future `timer:`", straight into the Active band (maintainer
// 2026-08-26, on a thread parked on a Sept-2 timer: "showing up in a separate rail that isn't held").
// Every case here carries the flag exactly as board.ts sets it, so a future widening cannot re-break it.
const armedTimerRow = {
  id: "timer:t:tmr_a1b2c3", kind: "timer" as const, target: "tmr_a1b2c3", state: "armed" as const,
  createdAt: "2026-08-25T22:33:31.777Z", timer: { fireAt: "2099-09-02T16:00:00.000Z", prompt: "generate the closed-August update" },
}
const armedPrRow = {
  id: "github:t:o/r#1", kind: "github" as const, target: "o/r#1", state: "armed" as const,
  createdAt: "2026-08-19T00:00:00.000Z",
}
test("isSnoozed: an armed-timer park is Snoozed even though the server flags it awaitingBackground", () => {
  const timerPark = thread({
    kind: "session", state: "open", runtime: "turn-idle", needsYou: false,
    awaitingBackground: true, lastFence: awaitingTimer, watches: [armedTimerRow],
  })
  // Nothing is running behind it — a wake with a known future instant is precisely what Snoozed means.
  assert.equal(isSnoozed(timerPark), true)
  assert.equal(sectionOf(timerPark), "snoozed")
  // The glyph shares the predicate, so no hourglass can sit in the Active/Rested section.
  assert.equal(sessionIndicatorKind(timerPark), "snoozed")
  // partitionActive splits the ACTIVE SECTION, so the band check has to go through sectionThreads —
  // handing it the row directly would band a thread sectionOf never sent there.
  const s = sectionThreads([timerPark])
  assert.deepEqual(s.snoozed.map((t) => t.id), [timerPark.id])
  assert.deepEqual(partitionActive(s.active).running, [], "and it is gone from the Active band entirely")
  // ALONE is the predicate: anything else behind the same fence keeps the row visible and undimmed.
  assert.equal(isSnoozed({ ...timerPark, subAgents: liveSub }), false, "a live child is own work in flight")
  assert.equal(isSnoozed({ ...timerPark, bgShells: liveShell }), false, "so is a running shell")
  assert.equal(isSnoozed({ ...timerPark, watches: [armedTimerRow, armedPrRow] }), false, "a PR watcher stays a visible handoff")
  // And the two OTHER parks the same flag describes are unmoved by this carve-out.
  const shellPark = thread({
    kind: "session", state: "open", runtime: "turn-idle", needsYou: false,
    awaitingBackground: true, lastFence: awaitingShell, bgShells: liveShell,
  })
  assert.equal(isSnoozed(shellPark), false, "own live work is never dimmed (maintainer 2026-07-10)")
  const prPark = thread({
    kind: "session", state: "open", runtime: "turn-idle", needsYou: false,
    awaitingBackground: true, lastFence: awaitingPr, watches: [armedPrRow],
  })
  assert.equal(isSnoozed(prPark), false, "a PR wait must never vanish into the dimmed band")
})

test("manual snooze: every parked queue reason is Snoozed until the exact deadline", () => {
  const future = "2099-07-15T17:00:00.000Z"
  const elapsed = "2020-07-15T17:00:00.000Z"
  const snoozed = thread({ kind: "session", state: "open", runtime: "turn-idle", snoozedUntil: future, needsYou: false })
  assert.equal(isSnoozed(snoozed), true)
  assert.equal(sectionOf(snoozed), "snoozed")
  assert.equal(sessionIndicatorKind(snoozed), "snoozed")
  assert.equal(isSnoozed(thread({ ...snoozed, snoozedUntil: elapsed })), false)
  assert.equal(sectionOf(thread({ ...snoozed, snoozedUntil: elapsed, needsYou: true })), "active")
  assert.equal(queued(thread({ ...snoozed, snoozedUntil: elapsed, needsYou: true })), true)
  assert.equal(isSnoozed(thread({ ...snoozed, needsYou: true, pendingQuestion: true })), true)
  assert.equal(sectionOf(thread({ ...snoozed, needsYou: true, pendingQuestion: true })), "snoozed")
  assert.equal(isSnoozed(thread({ ...snoozed, runtime: "perm-prompt", pendingAsk: { questions: [] } })), true)
  assert.equal(isSnoozed(thread({ ...snoozed, runtime: "exited", crashed: true })), true)
  assert.equal(isSnoozed(thread({ ...snoozed, runtime: "running" })), false, "snooze never relabels a turn still producing output")
})

test("isSnoozed: live work, mid-turn, settled, bare, archived, and non-timer blocked states are not held", () => {
  // Awaiting its own live SUB-AGENT is live work, even with a stale wait fence — not held.
  assert.equal(isSnoozed(thread({ runtime: "turn-idle", lastFence: awaitingShell, subAgents: liveSub })), false)
  // A background shell is NOT live work (2026-07-22), so it can't rescue a thread from a valid future
  // wait: awaitingTimer + only a bgShell → held (see the held test below for the paired assertion).
  assert.equal(isSnoozed(thread({ runtime: "turn-idle", lastFence: awaitingTimer, bgShells: liveShell })), true)
  // Mid-turn (still working) never awaits externally, even with a stale human fence.
  assert.equal(isSnoozed(thread({ runtime: "running", lastFence: awaitingShell })), false)
  // A done fence or a bare rest is NOT awaiting-external (those read as done/idle).
  assert.equal(isSnoozed(thread({ runtime: "turn-idle", lastFence: { kind: "done", body: "x", hints: [] } })), false)
  assert.equal(isSnoozed(thread({ runtime: "turn-idle" })), false)
  assert.equal(isSnoozed(thread({ runtime: "turn-idle", state: "archived", lastFence: awaitingTimer })), false)
  assert.equal(isSnoozed(thread({ status: "blocked", mechanism: "threads", runtime: "turn-idle" })), false)
  assert.equal(isSnoozed(thread({ needsYou: true, runtime: "exited", lastFence: awaitingTimer })), false, "attention beats a stale wait fence")
  assert.equal(isSnoozed(thread({ pendingAsk: { questions: [] }, runtime: "turn-idle", lastFence: awaitingShell })), false)
})

test("sectionOf: human/future-timer waits and canonical timers are Snoozed; machine waits stay out of Snoozed", () => {
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingShell })), "snoozed")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingTimer })), "snoozed")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingPr })), "snoozed", "a PR park is a park like any other now")
  // The pre-session `blocked`+`revalidate` status was an absolute instant a worker wrote; it went with
  // the `timer:` grammar, so it no longer claims Snoozed on its own.
  assert.equal(sectionOf(thread({ kind: "session", state: "open", status: "blocked", mechanism: "timer", revalidate: "2099-07-15T17:00:00Z", runtime: "turn-idle" })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", needsYou: true, runtime: "exited", lastFence: awaitingTimer })), "active")
  // A live SUB-AGENT wins over a stale parked fence (live work → Active).
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingShell, subAgents: liveSub })), "active")
  // A background shell does NOT (2026-07-22): the future-timer wait shows through → Snoozed.
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingTimer, bgShells: liveShell })), "snoozed")
  // A fence the SERVER did not honour stays Active — and `needsYou` is how that verdict reaches the client.
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [] }, needsYou: true })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", needsYou: true, runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [] } })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle" })), "active")
  // Archive wins over an external wait.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle", lastFence: awaitingShell })), "inactive")
})

test("sectionThreads: only human/future-timer waits partition into Snoozed; live and machine waits stay out of it", () => {
  const s = sectionThreads([
    thread({ id: "human-new", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingShell, lastUserAt: "2026-07-09T05:00:00.000Z" }),
    thread({ id: "live-old", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
    thread({ id: "timer-old", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingTimer, lastUserAt: "2026-07-08T05:00:00.000Z" }),
    thread({ id: "sub-wait", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingShell, subAgents: liveSub, lastUserAt: "2026-07-09T01:00:00.000Z" }),
    // shell-wait: a future-timer fence + only a background shell. The shell is no longer live work
    // (2026-07-22), so this now partitions into HELD (its timer wait), not the Active running band.
    thread({ id: "shell-wait", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingTimer, bgShells: liveShell, lastUserAt: "2026-07-09T02:00:00.000Z" }),
    thread({ id: "legacy-pr", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingPr, lastUserAt: "2026-07-09T03:00:00.000Z" }),
  ])
  // The cue leads with the legacy-pr rest; the running band — live-old + the one live-SUB-AGENT
  // waiter, by recency — follows below it.
  // A PR park is a park now — the required `for:` replaced "stays a visible queue card" as the safety
  // net — so the cue no longer leads with it. What is left Active is the live sub-agent waiter and the
  // running row.
  assert.deepEqual(s.active.map((t) => t.id), ["sub-wait", "live-old"])
  // Snoozed: every park the server honoured, newest first — the PR one among them.
  assert.deepEqual(s.snoozed.map((t) => t.id), ["human-new", "legacy-pr", "shell-wait", "timer-old"])
})

test("displayTitle: an explicit human title wins over stale backend AI-title and slug fallbacks", () => {
  assert.equal(
    displayTitle(thread({ id: "generated-slug", title: "Human-readable thread title", titleAuto: false, titleLocked: true, aiTitle: "generated-slug" })),
    "Human-readable thread title",
  )
  // A pre-split row carries no titleLocked; its real-looking title must still read as the human's.
  assert.equal(
    displayTitle(thread({ id: "generated-slug", title: "Human-readable thread title", titleAuto: false, aiTitle: "generated-slug" })),
    "Human-readable thread title",
  )
})

test("displayTitle: a title a dispatch CALLER hard-coded shows until the worker names the thread itself", () => {
  // `Investigate acme/app#391` (GitHub batch) / a parent agent's spawn_thread guess: a real name, so no
  // "Spinning up…" placeholder, but nobody human chose it.
  const hardCoded = { id: "investigate-acme-app-391", title: "Investigate acme/app#391", titleAuto: false, titleLocked: false }
  assert.equal(titleIsProvisional(thread({ ...hardCoded, spawnedAt: new Date().toISOString() })), false)
  assert.equal(displayTitle(thread(hardCoded)), "Investigate acme/app#391")
  // …and the moment the worker reports what the task actually is, that wins.
  assert.equal(
    displayTitle(thread({ ...hardCoded, aiTitle: "Cache key collides on normalized ids" })),
    "Cache key collides on normalized ids",
  )
  // Renaming it locks it again — a later/stale backend record can no longer displace the human's choice.
  assert.equal(
    displayTitle(thread({ ...hardCoded, title: "Resolver cache bug", titleLocked: true, aiTitle: "generated-slug" })),
    "Resolver cache bug",
  )
})

test("displayTitle: a machine-generated session slug is never presented as a successful title", () => {
  assert.equal(
    displayTitle(thread({ id: "generated-slug", title: "generated-slug", titleAuto: true, spawnedAt: "2026-07-01T00:00:00.000Z" })),
    "Untitled thread",
  )
  assert.equal(
    displayTitle(thread({ id: "internal-id", title: "internal-id", titleAuto: true, aiTitle: "conversation-summary-task" })),
    "Conversation summary task",
    "a native backend slug is humanized (sentence case) even when it differs from the Frizz thread id",
  )
})

test("a legacy session/hintless declared wait is never Snoozed — at rest it is simply a rested/queued row", () => {
  // A fence whose lines frizz cannot parse at all (the deleted `session:` kind) folds to NO hints, and a
  // thread the server left needing you is queued whatever it wrote.
  const sessWait = { kind: "awaiting" as const, body: "", hints: [] }
  const s = sectionThreads([
    thread({ id: "wait-new", kind: "session", state: "open", runtime: "turn-idle", needsYou: true, lastFence: sessWait, lastUserAt: "2026-07-09T05:00:00.000Z" }),
    thread({ id: "live-old", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
  ])
  // The hintless-wait rest (wait-new) is a cue row, so it leads; live-old is running and files below it.
  assert.deepEqual(s.active.map((t) => t.id), ["wait-new", "live-old"])
  assert.deepEqual(s.snoozed.map((t) => t.id), [])
})

// ---- title placeholder: never show the machine-guessed dispatch title ----

test("titleIsProvisional / displayTitle: 'Spinning up' shows briefly, then falls back to the dispatch title", () => {
  const fresh = new Date().toISOString()
  // Fresh dispatch, guessed title, no aiTitle yet → the placeholder.
  assert.equal(titleIsProvisional(thread({ titleAuto: true, title: "fix the parser bug", spawnedAt: fresh })), true)
  assert.equal(displayTitle(thread({ titleAuto: true, title: "fix the parser bug", spawnedAt: fresh })), SPINNING_UP_TITLE)
  // aiTitle landed → not provisional; the real name wins.
  assert.equal(titleIsProvisional(thread({ titleAuto: true, aiTitle: "Parser fix", spawnedAt: fresh })), false)
  assert.equal(displayTitle(thread({ titleAuto: true, aiTitle: "Parser fix", spawnedAt: fresh })), "Parser fix")
  // STALE spawn, still no aiTitle (e.g. a compacted session whose transcript frizz lost track of) → NOT
  // provisional: fall back to the dispatch title, never stick on "Spinning up…" forever.
  assert.equal(titleIsProvisional(thread({ titleAuto: true, title: "fix the parser bug", spawnedAt: "2026-07-08T00:00:00.000Z" })), false)
  assert.equal(displayTitle(thread({ titleAuto: true, title: "fix the parser bug", spawnedAt: "2026-07-08T00:00:00.000Z" })), "fix the parser bug")
  // A user-supplied title (titleAuto false) is real — shown as-is, never provisional.
  assert.equal(titleIsProvisional(thread({ titleAuto: false, title: "My thread", spawnedAt: fresh })), false)
  assert.equal(displayTitle(thread({ titleAuto: false, title: "My thread" })), "My thread")
  // Absent titleAuto (legacy/slim/foreign row) ⇒ never provisional.
  assert.equal(titleIsProvisional(thread({ title: "legacy" })), false)
})

test("displayTitle: an EXTERNAL row shows the name the server resolved, whichever harness wrote the transcript", () => {
  // The server (foreignThreadView) names a terminal session the way its own resume picker does — the
  // harness's title, else a chop of the opening human turn — and marks the chop `titleAuto`. The codex
  // dispatch rule ("no title signal ⇒ Untitled thread") must not fire on it: that rule guards a raw
  // prompt frizz seeded, and an external row has no such prompt (2026-08-24: every external codex row
  // read "Untitled thread" while every external claude row was named).
  const stale = new Date(Date.now() - 20_000).toISOString()
  const codexChop = thread({ id: "0199-uuid", backend: "codex", foreign: true, runtime: "turn-idle", titleAuto: true, title: "Which skills are available to you?…", spawnedAt: stale })
  assert.equal(displayTitle(codexChop), "Which skills are available to you?…")
  // The harness's own name arrives as the title with titleAuto false, and shows verbatim.
  const codexNamed = thread({ id: "0199-uuid", backend: "codex", foreign: true, runtime: "turn-idle", titleAuto: false, title: "Fix queue focus", aiTitle: "Fix queue focus" })
  assert.equal(displayTitle(codexNamed), "Fix queue focus")
  // Claude's chop already passed through the generic fallback; pin that it still does.
  const claudeChop = thread({ id: "0199-uuid", backend: "claude", foreign: true, runtime: "turn-idle", titleAuto: true, title: "is frizz down? threads aren't starting…" })
  assert.equal(displayTitle(claudeChop), "is frizz down? threads aren't starting…")
  // A transcript with no human turn keeps the server's short id, never a placeholder.
  const noTurn = thread({ id: "0199-uuid", backend: "codex", foreign: true, runtime: "turn-idle", titleAuto: true, title: "Session 0199-uui" })
  assert.equal(displayTitle(noTurn), "Session 0199-uui")
})

test("Codex automatic titles follow runtime and never expose the raw initial-prompt fallback", () => {
  const rawPrompt = "Please inspect this entire raw initial prompt and fix everything"
  const fresh = new Date().toISOString()
  const stale = new Date(Date.now() - 20_000).toISOString()
  const spawning = thread({ backend: "codex", runtime: "spawning", titleAuto: true, title: rawPrompt, spawnedAt: fresh })
  assert.equal(titleIsProvisional(spawning), true)
  assert.equal(displayTitle(spawning), SPINNING_UP_TITLE)

  const runningBeforeSignal = thread({ backend: "codex", runtime: "running", titleAuto: true, title: rawPrompt, spawnedAt: fresh })
  assert.equal(titleIsProvisional(runningBeforeSignal), true)
  assert.equal(displayTitle(runningBeforeSignal), SPINNING_UP_TITLE, "task_started cannot flash Untitled before first commentary")

  for (const runtime of ["running", "turn-idle", "exited"] as const) {
    const omitted = thread({ backend: "codex", runtime, titleAuto: true, title: rawPrompt, spawnedAt: stale })
    assert.equal(titleIsProvisional(omitted), false)
    assert.equal(displayTitle(omitted), UNTITLED_THREAD_TITLE)
  }

  assert.equal(
    displayTitle(thread({ backend: "codex", runtime: "turn-idle", titleAuto: true, title: "slug", aiTitle: "Fix queue focus" })),
    "Fix queue focus",
  )
  assert.equal(
    displayTitle(thread({ backend: "codex", runtime: "turn-idle", titleAuto: false, title: "Human rename" })),
    "Human rename",
  )
})

// A THREAD THAT IS TRULY AWAITING SOMETHING SITS IN THE ACTIVE RAIL WITH ITS OWN DOT, and never in the
// queue (maintainer 2026-08-14: "If the subagent is truly awaiting something, it should remain in the
// active rail with a distinct dot… if there is a GitHub watcher registered and the GitHub actions are
// still running, then that should remain in the running active rail").
//
// Every part of that is decided SERVER-side and lands here as two flags — `needsYou: false` (excused
// from the queue) and `awaitingBackground: true` (it is waiting on something named). This pins the
// reading those two produce, because the same pair now arrives from two new server rules that never
// existed when the reading was written: a park on the thread's own shells/children, and one on a
// registered PR watcher whose CI is still running.
test("sessionIndicatorKind: a declared wait draws the quiet dot in the ACTIVE band, not a spinner", () => {
  const awaiting = thread({ kind: "session", runtime: "turn-idle", needsYou: false, awaitingBackground: true, bgShells: [shell()] })
  assert.equal(sessionIndicatorKind(awaiting), "background", "its own mark — not the spinner, not the at-rest ellipsis")
  assert.deepEqual(partitionActive([awaiting]).running.map((t) => t.id), [awaiting.id], "and it bands ACTIVE")
  assert.equal(queued(awaiting), false, "…so it is not in the queue")
  // A LIVE SUB-AGENT STILL SPINS. It is not the same state: a child returns and re-invokes its parent
  // within seconds, so the thread is mid-flight in substance, and the spinner tells the truth. The dot
  // is for a wait on something that merely runs on.
  const withChild = thread({
    kind: "session", runtime: "turn-idle", needsYou: false, awaitingBackground: true, bgShells: [shell()],
    subAgents: [{ label: "reviewer", startedAt: "2026-08-14T00:00:00.000Z", state: "running", id: "a1" }],
  })
  assert.equal(sessionIndicatorKind(withChild), "working")
  // BACK IN THE QUEUE the moment the server says so — CI finished, the shell retired. The BAND is what
  // moves: `needsYou` bands it below the rule regardless of what it still has running (inActiveBand).
  // The MARK deliberately does not: the dot says "something it launched is still going", which is still
  // true of a thread whose second shell is running, and that reading predates this change (2026-08-04,
  // when a shell-only rest started carding while keeping its dot).
  const requeued = thread({ kind: "session", runtime: "turn-idle", needsYou: true, awaitingBackground: true, bgShells: [shell()] })
  assert.equal(queued(requeued), true)
  assert.deepEqual(partitionActive([requeued]).running, [], "it leaves the Active band for the queue's own")
  assert.equal(sessionIndicatorKind(requeued), "background", "…while the dot keeps stating the live work")
})

// THE DOT NEEDS SOMETHING TO ACTUALLY BE MOVING. An ```awaiting fence naming a PR (`prs:`) earns
// `awaitingBackground` too (it carries the resting card and that card's snooze), but unlike a shell its
// subject can be ALREADY DONE:
// a green PR is a handoff sitting on the human's merge, not work in flight, and it wore the same live
// blue dot as a running dev server (maintainer 2026-08-19: "this task should not be listed as in the
// actively running rail if it's only awaiting a PR with green CI"). The frontmatter key is `prs:` since
// the 2026-08-24 YAML cutover; the singular `pr:` it replaced and the older `pr-watch:` are both retired
// (RETIRED_AWAITING_KINDS). The WIRE kind stays singular, which is why the fixtures build `kind: "pr"`.
// REWRITTEN 2026-09-04. This pinned the rule that a watched PR wore whatever mark its CHECKS implied —
// the blue dot while CI ran, the bare-rest ellipsis once it settled — so the rail drew two different
// marks for one state and neither of them said "GitHub". The BAND logic it also pinned is unchanged and
// still asserted below; only the MARK moved (maintainer: "the GitHub icon should show up anytime that
// an agent is awaiting a PR").
test("sessionIndicatorKind: a watched PR wears GitHub's mark whether its checks are running or settled", () => {
  const watching = (checks: "running" | "passing" | "failing" | "none", over: Partial<ThreadView> = {}) => thread({
    kind: "session", runtime: "turn-idle", awaitingBackground: true,
    watches: [{
      id: "github:t:o/r#1", kind: "github", target: "o/r#1", state: "armed", createdAt: "2026-08-19T00:00:00.000Z",
      github: { checks, running: checks === "running" ? 1 : 0, passed: 10, failed: 0, failing: [], merge: "mergeable", state: "open", polledAt: "2026-08-19T00:00:00.000Z" },
    }],
    ...over,
  })
  // CI green, so the server has already banded it back into the queue. The mark names the SUBJECT of the
  // wait, which the band cannot: the row is a queue handoff AND it is about a pull request.
  const green = watching("passing", { needsYou: true })
  assert.equal(sessionIndicatorKind(green), "pr", "a settled PR is still a PR, not a bare rest")
  assert.equal(queued(green), true, "…and it is still a queue handoff — the BAND is unchanged by the mark")
  // Red is settled too — the wait is over either way, and the human is the one who acts next.
  assert.equal(sessionIndicatorKind(watching("failing", { needsYou: true })), "pr")
  // A PR with NO checks at all never had CI to wait for.
  assert.equal(sessionIndicatorKind(watching("none", { needsYou: true })), "pr")
  // CI STILL RUNNING used to be the one case that drew the dot, and the server excuses it from the queue
  // (board.heldByRunningChecks) — so the row still sits in the Active band. It just no longer claims to
  // be this machine's own background work while it does.
  const live = watching("running", { needsYou: false })
  assert.equal(sessionIndicatorKind(live), "pr")
  assert.deepEqual(partitionActive([live]).running.map((t) => t.id), [live.id], "and it still bands ACTIVE")
  // A LIVE SHELL BESIDE THE WATCH does not take the mark back. A dev server the thread also left running
  // is not what it is WAITING for, and the dot would name the incidental half of the rest.
  assert.equal(sessionIndicatorKind(watching("passing", { needsYou: true, bgShells: [shell()] })), "pr")
})

// THE MARK IS THE WAIT'S, NOT THE BAND'S — the whole point of the 2026-09-04 change. Every shape that is
// "at rest with a PR out" gets the octocat, and every state that is NOT that keeps its own mark.
test("sessionIndicatorKind: a PR wait is marked from the REGISTERED watch, and yields to every louder state", () => {
  const armed = [{ id: "github:t:o/r#9", kind: "github" as const, target: "o/r#9", state: "armed" as const, createdAt: "2026-09-04T00:00:00.000Z" }]
  // A watch and NO fence at all — the shape the worker contract steers toward, and the one the old
  // fence-only reading missed entirely.
  assert.equal(sessionIndicatorKind(thread({ kind: "session", runtime: "turn-idle", needsYou: true, watches: armed })), "pr")
  // …and a `prs:` fence with nothing registered still reads, so a fence written before the watch lands
  // (or by a worker whose MCP predates it) does not fall back to the ellipsis.
  assert.equal(sessionIndicatorKind(thread({
    kind: "session", runtime: "turn-idle", needsYou: true,
    lastFence: { kind: "awaiting", body: "", hints: [{ kind: "pr", value: "o/r#9" }] },
  })), "pr")
  // A ref that is only whitespace names nothing and must not light the mark.
  assert.equal(sessionIndicatorKind(thread({
    kind: "session", runtime: "turn-idle", needsYou: true,
    lastFence: { kind: "awaiting", body: "", hints: [{ kind: "pr", value: "   " }] },
  })), "rest")
  // EVERY LOUDER STATE WINS. A turn in flight and a live sub-agent are motion; an ask is the human's;
  // a limit kill and a stall are dead threads whose next action is Retry; a done fence is a dismissal.
  const withWatch = (over: Partial<ThreadView>) => sessionIndicatorKind(thread({ kind: "session", runtime: "turn-idle", needsYou: true, watches: armed, ...over }))
  assert.equal(withWatch({ runtime: "running" }), "working")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", runtime: "turn-idle", needsYou: false, watches: armed, subAgents: liveSub })), "working")
  // …but a RESTED QUEUE HANDOFF never reaches the working branch (restedQueueHandoff), and for that row
  // the PR is the truer of the two rests. The children keep their spinners on their own child rows.
  assert.equal(withWatch({ subAgents: liveSub }), "pr")
  assert.equal(withWatch({ pendingQuestion: true }), "needs-input")
  assert.equal(withWatch({ runtime: "exited", sessionId: "s", limitPause: { backend: "claude", window: "session", at: "2026-09-04T00:00:00.000Z", autoResume: true } }), "limit")
  assert.equal(withWatch({ lastFence: { kind: "done", body: "shipped", hints: [] } }), "done")
  // EXITED stays a stall: the process is gone, Retry is the next action, and offersRetry reads this
  // same ladder — so letting the octocat win here would silently take the recovery verb off the row.
  assert.equal(withWatch({ runtime: "exited", sessionId: "s" }), "stalled")
  assert.equal(offersRetry(thread({ kind: "session", runtime: "exited", sessionId: "s", needsYou: true, watches: armed })), true)
})

// AN ARMED TIMER IS MOTION THE SAME WAY RUNNING CI IS: a wake with a known terminal instant that frizz
// itself delivers. Timer watch rows landed 2026-08-24 (f50f9e60) after the dot's predicate was last
// touched, so a timer park wore the bare-rest ellipsis — the mark Sidebar reserves for "NOTHING it
// launched still running" — including the snoozed shape 60383a56 put in the Active band.
test("sessionIndicatorKind: an armed timer park keeps the dot", () => {
  const timerRow = {
    id: "timer:t:tmr_1", kind: "timer" as const, target: "tmr_1", state: "armed" as const,
    createdAt: "2026-08-24T00:00:00.000Z", timer: { fireAt: "2026-09-02T16:00:00.000Z", prompt: "re-check the deploy" },
  }
  const snoozedPark = thread({ kind: "session", runtime: "turn-idle", awaitingBackground: true, needsYou: false, watches: [timerRow] })
  assert.equal(sessionIndicatorKind(snoozedPark), "background", "an armed wake is motion, not bare rest")
  assert.deepEqual(partitionActive([snoozedPark]).running.map((t) => t.id), [snoozedPark.id], "and the snoozed shape bands ACTIVE")
  // Queued (unsnoozed), the mark still states the armed wake — exactly as a queued shell rest keeps its
  // dot while the BAND moves to the queue's own.
  assert.equal(sessionIndicatorKind(thread({ kind: "session", runtime: "turn-idle", awaitingBackground: true, needsYou: true, watches: [timerRow] })), "background")
})

// THE RESTING CARD'S EVENT-SNOOZE PARKS THE ROW IN SNOOZED. The click sets `bgSnoozed` and takes the queue
// card away, but the server keeps `awaitingBackground` TRUE across it (the flag states what the thread
// waits on; a snooze does not change that) — and isSnoozed's first gate read that flag through hasLiveOps,
// so the snoozed row stayed in the Active band, undimmed, wearing an at-rest mark. Reported 2026-08-28 on
// a thread parked on a green PR: "It's resting and snoozed, and for some reason it's in the actively
// running rail instead of a snoozed rail".
test("isSnoozed: an event-snoozed rest parks in Snoozed — behind a PR watch, a shell, or nothing fenced at all", () => {
  const greenPr = thread({
    kind: "session", state: "open", runtime: "turn-idle", needsYou: false, awaitingBackground: true, bgSnoozed: true,
    lastFence: { kind: "awaiting", body: "Waiting on the merge.", hints: [{ kind: "pr", value: "o/r#1" }] },
    watches: [{
      id: "github:t:o/r#1", kind: "github", target: "o/r#1", state: "armed", createdAt: "2026-08-28T00:00:00.000Z",
      github: { checks: "passing", running: 0, passed: 7, failed: 0, failing: [], merge: "mergeable", state: "open", polledAt: "2026-08-28T00:00:00.000Z" },
    }],
  })
  assert.equal(isSnoozed(greenPr), true)
  assert.equal(sectionOf(greenPr), "snoozed")
  assert.equal(sessionIndicatorKind(greenPr), "snoozed", "the park mark, not the dot and not the ellipsis")
  // A shell-only rest cards without a fence, and its snooze is the same click.
  const shellOnly = thread({ kind: "session", state: "open", runtime: "turn-idle", needsYou: false, awaitingBackground: true, bgSnoozed: true, bgShells: [shell()] })
  assert.equal(sectionOf(shellOnly), "snoozed")
  assert.equal(sessionIndicatorKind(shellOnly), "snoozed")
  // UNSNOOZED, the same two shapes read exactly as before: the queued one below the rule with its own
  // mark, the excused-but-cardless one in the Active band.
  assert.equal(sectionOf({ ...greenPr, bgSnoozed: undefined, needsYou: true }), "active")
  // The queued PR wears GitHub's mark since 2026-09-04 (it read "rest" before). The SNOOZED twin above
  // still reads "snoozed" — isSnoozed is checked first, so the park keeps the band and its own tooltip,
  // and the Sidebar picks the octocat within that arm from the same waitNamesPr predicate.
  assert.equal(sessionIndicatorKind({ ...greenPr, bgSnoozed: undefined, needsYou: true }), "pr")
  assert.equal(sectionOf({ ...shellOnly, bgSnoozed: undefined }), "active")
  assert.equal(sessionIndicatorKind({ ...shellOnly, bgSnoozed: undefined }), "background")
})

test("isSnoozed: the event-snooze yields to a live sub-agent, a queue reason, and a running turn", () => {
  const base = { kind: "session" as const, state: "open" as const, runtime: "turn-idle" as const, needsYou: false, awaitingBackground: true, bgSnoozed: true, bgShells: [shell()] }
  // A child's return re-invokes the parent within seconds: that row spins in Active, snooze or not
  // (maintainer 2026-07-10: "when an agent is merely awaiting its own sub-agents, we should NOT dim it").
  const withChild = thread({ ...base, subAgents: liveSub })
  assert.equal(isSnoozed(withChild), false)
  assert.equal(sessionIndicatorKind(withChild), "working")
  // A stale `bgSnoozed` beside a fresh ask never hides the ask.
  assert.equal(isSnoozed(thread({ ...base, needsYou: true, pendingQuestion: true })), false)
  // And it never dims a turn that is actually in flight.
  assert.equal(isSnoozed(thread({ ...base, runtime: "running" })), false)
  assert.equal(sessionIndicatorKind(thread({ ...base, runtime: "running" })), "working")
})
