// THE BUILT-IN SIGN-OFF NUDGE (scheduler SOURCE 9) — frizz's own stop hook, always on and invisible.
//
// It exists to make ONE invariant true: every item in the queue is a question you can answer or a
// checkmark you can archive. So it fires on exactly one thing — a rest that carried NO fence — and on
// nothing else. Every test here is a way that could go wrong: nudging a thread that DID sign off (which
// arrives after a ```done and reads as frizz not having noticed), or nudging one forever (a nag loop
// frizz itself generates).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyRecord, newTailState, type SessionTelemetry, type Tailer } from "./tailer.ts"
import { createScheduler } from "./scheduler.ts"
import { createCodexBackend } from "./backend/codex.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"

// `runtime` is opt-in because it changes which delivery path the scheduler takes, and the difference is
// load-bearing rather than cosmetic. With it absent — the shape every test below it was written in —
// `deliverDue` cannot tell whether the worker is alive, so it falls through to the acknowledge-and-settle
// path. In PRODUCTION the runtime is always knowable, so the sent-and-confirm-later path is the only one
// that ever runs. A cap that is only spent on the path tests take is not a cap; see the two tests at the
// bottom of this file.
function nudger(tele: Partial<SessionTelemetry>, opts: { setting?: string; runtime?: "alive" | "dead" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-signoff-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "resting"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  if (opts.setting) storage.setSetting("signoffNudge", opts.setting)
  const delivered: string[] = []
  const s = createScheduler({
    // No quiet window here: this file pins its SOURCE, and hands one thread several wakes within a few
    // clock minutes. The window and the merge are pinned in scheduler.test.ts.
    wakeQuietWindowMs: 0,
    storage,
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: "2026-08-12T00:00:00.000Z",
        // The AGENT spoke last, which is the shape of a real fenceless rest — and the one thing frizz's
        // own delivery cannot fake, since frizz only ever speaks as the user.
        lastAssistantAt: "2026-08-12T00:00:00.000Z",
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    ...(opts.runtime ? { wakeRuntimeState: () => opts.runtime! } : {}),
    log: () => {},
  })
  // THE NUDGE'S OWN DELIVERIES. `delivered` is every wake the scheduler sent, and an awaiting fence
  // frizz cannot honour legitimately draws SOURCE 12's correction on the same rest — so "the nudge held"
  // has to be asked of the nudge's namespace, not of an empty array.
  const nudges = () => storage.db
    .prepare("SELECT message FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE 'signoff:%' AND state = 'delivered'")
    .all(slug) as { message: string }[]
  return { s, storage, slug, delivered, nudges, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("Codex failed turns cannot trigger a sign-off reminder or an armed rest Goal", async () => {
  const fold = newTailState("resting", "sid", "/fixture")
  createCodexBackend().foldLine(fold, JSON.stringify({ timestamp: "2026-09-06T15:31:27.526Z", type: "event_msg", payload: {
    type: "task_complete", last_agent_message: null, error: { message: "Rejected", codex_error_info: "cyber_policy" },
  } }))
  const h = nudger({ apiFault: fold.apiFault, lastAssistantAt: fold.lastAssistantAt, lastActivityAt: fold.lastActivityAt }, { runtime: "alive" })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "Keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-09-06T15:00:00.000Z" })
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
    assert.equal(h.storage.db.prepare("SELECT count(*) AS n FROM wake_delivery").get()?.n, 0)
  } finally { h.close() }
})

test("provider failures supersede sign-off and rest Goal deliveries queued before the failure was decoded", async () => {
  const at = "2026-08-12T00:00:00.000Z"
  const h = nudger({ apiFault: true }, { runtime: "alive" })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "Keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: at })
    const outbox = createWakeDeliveryStore(h.storage.scope, { quietWindowMs: 0 })
    for (const prefix of ["signoff", "stophook"]) {
      outbox.enqueue({ id: prefix, slug: h.slug, sessionId: "sid", fenceId: prefix === "signoff" ? `signoff:${at}` : `stophook:${at}:${at}`, hintKey: prefix, message: "Do not deliver", reason: "Pre-upgrade failure misread as a rest" }, Date.parse(at))
    }
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
    assert.deepEqual(h.storage.db.prepare("SELECT state FROM wake_delivery ORDER BY id").all().map((row) => row.state), ["superseded", "superseded"])
  } finally { h.close() }
})

test("a rest with no fence is told how to sign off, and the text names all three ways", async () => {
  const h = nudger({})
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /```question/)
    assert.match(h.delivered[0], /```done/)
    assert.match(h.delivered[0], /```awaiting/)
    // THE CURRENT FENCE GRAMMAR, not the deleted `watch:` one — this reminder is the last thing many
    // workers read before writing a fence, so a stale example here teaches the wrong syntax to exactly
    // the audience that most needs the right one.
    assert.match(h.delivered[0], /shell: <the id your runtime gave you>/)
    assert.match(h.delivered[0], /for: 2h/)
    // FRONTMATTER, THEN MARKDOWN (2026-08-17): the structural lines, a `---`, and the worker's prose
    // below it. This pinned `reason:` — the ONE-LINE form that shape replaced — for two days after the
    // parser stopped needing it, which is the same staleness the comment above is about: the example
    // kept teaching the superseded field to the audience least able to know it was superseded.
    assert.match(h.delivered[0], /^\s*---\s*$/m, "the delimiter, which is what makes the prose prose")
    assert.doesNotMatch(h.delivered[0], /reason:/, "and not the one-line form it replaced")
    assert.doesNotMatch(h.delivered[0], /`watch: <id>`/, "the deleted grammar must not come back")
    // THE GOAL'S VERBIAGE LIVES HERE NOW. A new thread no longer arms the default Goal (2026-08-16) —
    // the bump is the same nudge — so the bump has to carry what the Goal used to say about finishing
    // the work and about deciding rather than asking, or dropping it quietly removed both.
    assert.match(h.delivered[0], /unfinished, unverified, or deferred/)
    assert.match(h.delivered[0], /DECIDE RATHER THAN ASK/)
    // THE TASK IS ALSO THE CEILING. "Keep going" with no upper bound is unbounded by construction —
    // every codebase always has more to do — so a worker forbidden to stop can only stop by widening
    // what it was asked. Traced 2026-08-17 on `investigate-nubjs-nub-642`: dispatched to TRIAGE an
    // issue, it shipped seven commits instead. See DEFAULT_RECURRING_PROMPT for the full account.
    assert.match(h.delivered[0], /FINDING TO REPORT/, "discovered work is reported, not adopted")
    assert.match(h.delivered[0], /THE DOCUMENT IS THE ENDING/, "a triage/review/plan ends with its write-up")
    assert.match(h.delivered[0], /not permission to go build the answer/, "an unanswered question is not a mandate")
    // …and the old copy that made the wrong reading correct must not come back: it listed a written-up
    // plan among the things that are NOT an ending, which for an analysis task denies the deliverable.
    assert.doesNotMatch(h.delivered[0], /a written-up plan and a long turn are none of them endings/)
    // `\s` rather than a literal space: the message is a wrapped array of lines, so this phrase spans a
    // newline and a regex written for one line silently stops pinning anything.
    assert.match(h.delivered[0], /which way you went and\s+what would reverse/)
    // `done` must arrive with its COST attached, or it becomes the cheapest way to stop being nudged —
    // the exact failure the retired ALLDONE warning existed for.
    assert.match(h.delivered[0], /DISMISSAL/)
    // ...and "still owed" has to spell out the cases that read as finished: a RECOMMENDATION whose act
    // the human must perform, an unsent draft, and discovered follow-up that is someone else's to do.
    // Two zod threads fenced `done` on exactly those on 2026-08-16 — see workerPrompt.ts above SIGNALS.
    assert.match(h.delivered[0], /STILL OWED counts things you are not going to do yourself/)
    assert.match(h.delivered[0], /`mcp__frizz__spawn_thread`/)
    assert.match(h.delivered[0], /not\s+worth a card is not worth a SENTENCE/)
    assert.match(h.delivered[0], /the card is the ledger of what shipped/)
    // SELF-CONTAINEDNESS is the point the first version missed: the human has seen nothing since their
    // own last message, and everything in between came from frizz. An agent that does not know that
    // writes a handoff about the last thing it touched.
    assert.match(h.delivered[0], /readable cold/i)
    assert.match(h.delivered[0], /came from\s+frizz/)
    // THE HEADLINE INSTRUCTION: a thread whose handoff already stands alone should answer with the
    // fence and nothing else. Without this the agent restates its whole summary under the reminder and
    // the human reads it twice (maintainer 2026-08-12).
    // THE MENU IS THE SECOND BRANCH, NOT THE FIRST (2026-08-14). This delivery lands on a rest that may
    // simply be premature, and a fence menu handed to a half-finished thread has no correct entry on it —
    // the agent picks the closest, which is `done`, which files the thread away. So the reminder tells it
    // to resume first and only then offers the shapes. The Goal arriving on the same rest says the same
    // thing; two frizz deliveries pulling opposite ways is the failure this pins against.
    assert.match(h.delivered[0], /THE FENCE IS NOT WHAT YOU OWE — THE WORK IS/)
    assert.ok(
      h.delivered[0].indexOf("THE WORK IS") < h.delivered[0].indexOf("```question"),
      "resuming the work is offered BEFORE the fence menu, not as a footnote under it",
    )
    assert.match(h.delivered[0], /none of\s+them endings/, "and the endings a worker mistakes for one are named")
    assert.match(h.delivered[0], /DO NOT REPEAT YOURSELF/)
    assert.match(h.delivered[0], /reply with the\s+fence ALONE/)
    // The 1-3-sentences shape belongs to a `done` BODY and nowhere else — read as general guidance it
    // made an agent omit most of what had happened (maintainer 2026-08-12, with the screenshot).
    // The 1-3-sentence shape belongs to the `done` entry and nowhere else.
    assert.match(h.delivered[0], /done[\s\S]{0,220}1-3 sentences/)
    assert.doesNotMatch(h.delivered[0], /^Keep it SHORT/m)
  } finally { h.close() }
})

// A thread that signed off is not an untriageable item, whichever way it signed off. `awaiting` counts
// too while it still exists — it is a legitimate answer to "where do you stand".
for (const [what, tele] of [
  ["a done fence", { lastFence: { kind: "done" as const, body: "", hints: [] } }],
  ["an awaiting fence", { lastFence: { kind: "awaiting" as const, body: "", hints: [] } }],
  ["a question fence", { pendingQuestion: true }],
  ["a native ask", { pendingAsk: { id: "a1", questions: [] } }],
  ["a permission prompt", { permPrompt: true }],
  ["the legacy ALLDONE sentinel", { lastAssistantAllDone: true }],
] as Array<[string, Partial<SessionTelemetry>]>) {
  test(`${what} is already a sign-off, so nothing is injected`, async () => {
    const h = nudger(tele)
    try {
      await h.s.tick()
      assert.deepEqual(h.nudges(), [])
    } finally { h.close() }
  })
}

// AND A REGISTRATION IS A SIGN-OFF TOO, which is the whole point of the five verbs: `done`, `ask` and
// `watch` each record a ROW, and none of them can write the tailer's `lastFence`. Reading only the fence
// nudged a worker for not writing the sentence it was told to replace with a tool call — the protocol
// reminder teaching the OLD protocol, on exactly the threads that had adopted the new one.
for (const [what, arrange] of [
  ["a registered done", (st: ReturnType<typeof createStorage>, slug: string) => st.markThreadDone(slug, "- **Shipped** it", Date.now())],
  ["a registered question", (st: ReturnType<typeof createStorage>, slug: string) =>
    st.askThreadQuestion({ id: "qst_x", slug, spec: JSON.stringify({ question: "Which store?", kind: "question" }), askedAtMs: Date.now() })],
  ["a registered watch", (st: ReturnType<typeof createStorage>, slug: string) =>
    st.armThreadWatch({ id: "wch_x", slug, kind: "shell", target: "bzvtnt3ig", createdAtMs: Date.now(), expiresAtMs: Date.now() + 7_200_000 })],
] as Array<[string, (st: ReturnType<typeof createStorage>, slug: string) => unknown]>) {
  test(`${what} is already a sign-off, so nothing is injected`, async () => {
    const h = nudger({})
    try {
      arrange(h.storage, h.slug)
      await h.s.tick()
      assert.deepEqual(h.nudges(), [])
    } finally { h.close() }
  })
}

// AND THE MOMENT THE HUMAN ANSWERS, EVERY GUARD ABOVE OPENS. The row leaves `open`, the done row is
// still absent, no watch was ever armed — so on the next tick this thread looked exactly like one that
// had rested saying nothing, and the nudge went out while the answer was still in the outbox. The
// transcript read: the worker's rest, "FRIZZ ASKED FOR A SIGN-OFF", then the human's answer (maintainer
// 2026-08-27, on that exact sequence). It also spent one of the two nudges this thread will ever get.
test("an answered question ON ITS WAY to the worker is a sign-off too, until the worker has it", async () => {
  const h = nudger({})
  try {
    h.storage.askThreadQuestion({ id: "qst_x", slug: h.slug, spec: JSON.stringify({ question: "Which store?", kind: "question" }), askedAtMs: Date.now() })
    h.storage.answerThreadQuestion("qst_x", JSON.stringify({ questionId: "qst_x", question: "Which store?", chosen: ["SQLite"] }), Date.now())
    await h.s.tick()
    assert.deepEqual(h.nudges(), [], "answered, not yet delivered — the worker is about to be woken with it")
  } finally { h.close() }
})

// The failing control for the four above: with none of them recorded, this very thread IS nudged — so
// they are what silenced it rather than something else about the fixture.
test("…and with no fence and no registration, the same thread IS nudged", async () => {
  const h = nudger({})
  try {
    await h.s.tick()
    assert.equal(h.nudges().length, 1)
  } finally { h.close() }
})

// A thread that is still working has not failed to sign off — it has not finished.
test("a busy thread is never nudged", async () => {
  const h = nudger({ turn: "in-flight" })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// ONE PER REST falls out of the delivery id being bound to the rest instant — no counter needed for it.
test("one nudge per rest, however many ticks run over it", async () => {
  const h = nudger({})
  try {
    await h.s.tick()
    await h.s.tick()
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
  } finally { h.close() }
})

// THE LOOP THIS ALMOST SHIPPED WITH. Frizz's own delivery lands as a USER record, so it advances both
// `lastActivityAt` and `lastUserAt`. The first design keyed the delivery id on the former and the cap's
// anchor on the latter, which meant the nudge minted a fresh id for a rest that never happened and reset
// its own counter with its own message: 22 deliveries to one thread in four minutes, measured on a real
// stack (the unit tests all passed, because they drove those fields by hand).
//
// The fix is to ask whether the AGENT spoke last, which nothing frizz says can affect.
test("a thread whose last word is frizz's own nudge is not nudged again", async () => {
  const h = nudger({
    lastAssistantAt: "2026-08-12T00:00:00.000Z",
    lastUserAt: "2026-08-12T00:00:30.000Z", // the delivery landed AFTER the agent's last word
    lastActivityAt: "2026-08-12T00:00:30.000Z",
  })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "the agent has not answered yet — there is nothing new to nudge")
  } finally { h.close() }
})

test("the cap stops a nag loop, and only SIGNING OFF gives the allowance back", async () => {
  let spokeAt = "2026-08-12T00:01:00.000Z"
  let fence: SessionTelemetry["lastFence"]
  const h = nudger({
    lastUserAt: "2026-08-12T00:00:00.000Z",
    get lastAssistantAt() { return spokeAt },
    get lastActivityAt() { return spokeAt },
    get lastFence() { return fence },
  } as Partial<SessionTelemetry>)
  try {
    // Three consecutive fenceless rests by the AGENT; only the first two are nudged.
    await h.s.tick()
    spokeAt = "2026-08-12T00:02:00.000Z"
    await h.s.tick()
    spokeAt = "2026-08-12T00:03:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 2, "capped at 2 consecutive")
    assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 2)

    // A user record does NOT restore it — that is exactly what frizz's own delivery is.
    spokeAt = "2026-08-12T00:04:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 2, "still capped")

    // Signing off does. It is the only event that proves the nudge worked.
    fence = { kind: "done", body: "", hints: [] }
    await h.s.tick()
    assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 0, "the allowance is back")
    fence = undefined
    spokeAt = "2026-08-12T00:05:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 3, "and the next fenceless rest is nudged again")
  } finally { h.close() }
})

// It lands on every live thread at once, so there has to be a way to stop it that is not a code change.
test("the kill switch silences it everywhere", async () => {
  const h = nudger({}, { setting: "off" })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// A SIGNED-OUT PROVIDER answers in milliseconds, so the auth failure is a real assistant message and
// therefore a real rest — which satisfies every other guard. Measured on a live stack: the bump fired
// ten times in a hundred seconds against a thread whose worker could only ever reply "Not logged in".
// Re-prompting cannot help; the thread already cards its auth fault and the sign-in recovery.
test("an auth-faulted thread is never re-prompted — the nudge cannot fix a signed-out provider", async () => {
  const h = nudger({ authFault: "authentication_rejected" } as never)
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// ---- A FAILED TURN IS NOT A REST ------------------------------------------------------------------
// The loop this file's cap was always meant to stop, reached anyway — twice over, and each half is
// enough on its own. Measured in the field on two real threads before either was fixed: ~5,700 and
// ~5,200 nudges to single sessions, one every ~10s (the scheduler's tick) without pause, until both
// transcripts passed 80 MB and every turn failed with `400 invalid_request` because the conversation
// had outgrown the model's context window. `signoff_nudges` read 0 on both rows throughout, against a
// SIGNOFF_NUDGE_MAX of 2.
//
//   THE CAP WAS NEVER SPENT. Every wake to a live runtime leaves `deliverDue` at the sent-and-confirm
//   branch, which did not settle the nudge, and the confirm that would have settled it later never ran:
//   `deliveryContext` reads a signoff item as SUPERSEDED as soon as the agent's next assistant record
//   lands, and superseding counts nothing. A synthetic API-error record IS an assistant record, so the
//   failing turn that provoked the nudge is also what stopped the nudge being counted.
//
//   AND THE REST WAS NEVER REAL. That same record advances `lastAssistantAt`, so each failure minted a
//   fresh rest instant, hence a fresh delivery id, defeating the per-rest dedupe as well.
test("a nudge to a LIVE runtime is counted against the cap, not just one to an unknown one", async () => {
  let spokeAt = "2026-08-12T00:01:00.000Z"
  const h = nudger({
    lastUserAt: "2026-08-12T00:00:00.000Z",
    get lastAssistantAt() { return spokeAt },
    get lastActivityAt() { return spokeAt },
  } as Partial<SessionTelemetry>, { runtime: "alive" })
  try {
    for (let i = 2; i <= 6; i++) {
      await h.s.tick()
      spokeAt = `2026-08-12T00:0${i}:00.000Z`
    }
    assert.equal(h.delivered.length, 2, "five fenceless rests to a live worker still spend exactly the cap")
    assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 2)
  } finally { h.close() }
})

// The guard the cap should never have to be the last line of defence for. A thread failing every turn
// cannot answer a reminder — nothing it writes reaches the model — and on a context-window 400 the
// reminder is what keeps the conversation over the limit, so even the two the cap allows are two too
// many. Each row is a REAL synthetic error record folded through the tailer, so what reaches the stub is
// what the fold actually raises — for the category frizz already classified (a rate limit) and for the
// one it could not see at all (a 400). The fold → `telemetry()` projection is pinned in tailer.test.ts.
for (const [what, rec] of [
  ["a terminal 400 the classifiers do not recognise", {
    error: "invalid_request", apiErrorStatus: 400,
    text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Prompt is too long"}}',
  }],
  ["a rate limit, which also never reached the model", {
    error: "rate_limit", apiErrorStatus: 429, text: "You've hit your session limit",
  }],
] as const) {
  test(`${what} is a failed turn, not a rest, so nothing is injected`, async () => {
    const fold = newTailState("resting", "sid", "/x")
    applyRecord(fold, {
      type: "assistant", isApiErrorMessage: true, error: rec.error, apiErrorStatus: rec.apiErrorStatus,
      timestamp: "2026-08-12T00:01:00.000Z",
      message: { model: "<synthetic>", content: [{ type: "text", text: rec.text }] },
    })
    assert.equal(fold.apiFault, true, "the fold raises the general fault off the record")
    let spokeAt = "2026-08-12T00:01:00.000Z"
    const h = nudger({
      lastUserAt: "2026-08-12T00:00:00.000Z",
      get lastAssistantAt() { return spokeAt },
      get lastActivityAt() { return spokeAt },
      apiFault: fold.apiFault,
      limitFault: fold.limitFault,
    } as Partial<SessionTelemetry>, { runtime: "alive" })
    try {
      // Every tick is a fresh failed turn, which is exactly what defeated the per-rest dedupe: the
      // error record is an assistant record, so it moves the rest instant every time.
      for (let i = 2; i <= 21; i++) {
        await h.s.tick()
        spokeAt = `2026-08-12T00:${String(i).padStart(2, "0")}:00.000Z`
      }
      // Asked of the reminder's own namespace: a standing limit fault legitimately draws the limit-resume
      // wake from another source, and that is not what this test is about.
      assert.deepEqual(h.nudges(), [], "twenty consecutive failed turns produce no nudges at all")
      assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 0)
    } finally { h.close() }
  })
}

// ---- THE TWO-DELIVERY INTERACTION -----------------------------------------------------------------
// Separating the reminder from the Goal (2026-08-12) means a thread WITH a Goal has two sources that
// want one fenceless rest. Until 2026-08-28 both fired on it, as separate deliveries, on the reading
// that "the deliveries serialise, and a fence supersedes whatever is still queued". They serialised in
// the RUNTIME'S queue, not frizz's: both left in one tick, 5 ms apart, the worker answered the Goal with
// a ```done fence, and then read "you rested without a fence" — the supersession check ran at send,
// before that reply existed — and fenced again. Two Done cards on one thread (`wrong-agent-id-re-fencing`,
// maintainer: "Redundant Dones"). So now ONE source takes a bare rest: the reminder, which mints first
// and already sends a half-finished thread back to the work; the Goal stands down on that rest and takes
// the bare rests the reminder does not (its cap spent — see the test after next).
test("a Goal and the reminder are due for one rest: the reminder goes, the Goal stands down, and a fence ends it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-both-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "both"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  // An ordinary armed Goal — the stop hook and nothing else, which is what the footer panel arms when an
  // operator flips one switch.
  storage.setRecurringPromptBySlug(slug, {
    prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false,
    intervalMs: null, armedAt: "2026-08-12T00:00:00.000Z",
  })
  let fence: SessionTelemetry["lastFence"]
  const delivered: string[] = []
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage,
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: "2026-08-12T00:01:00.000Z", lastAssistantAt: "2026-08-12T00:01:00.000Z",
        lastUserAt: "2026-08-12T00:00:00.000Z", subAgents: [], bgShells: [],
        pendingQuestion: false, permPrompt: false, lastFence: fence,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  try {
    await s.tick()
    // ONE wake for this rest — frizz's protocol, not the operator's words.
    assert.equal(delivered.length, 1)
    assert.match(delivered[0], /without a fence/, "the reminder is what a bare rest draws")
    assert.doesNotMatch(delivered[0], /^keep going/, "and the Goal stands down on the rest the reminder took")
    // Per REST, not per tick: the reminder is delivered now, and the Goal still does not take the rest
    // it answered. (In production the reminder's own record closes the rest before this could matter;
    // this pins the outbox-side hold that makes it true even when the tailer has not caught up.)
    await s.tick()
    await s.tick()
    assert.equal(delivered.length, 1, "the Goal does not follow the reminder onto the same rest")

    // The agent signs off. Neither source may fire again for this thread, and anything still queued for
    // the old rest is superseded rather than delivered on top of a closed thread.
    fence = { kind: "done", body: "shipped it", hints: [] }
    await s.tick()
    await s.tick()
    assert.equal(delivered.length, 1, "a signed-off thread is not re-prompted by either source")
  } finally { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ARMING A GOAL OVER AN OPEN QUESTION (maintainer 2026-09-02). The arming cancels the question for
// autonomy (router.cancelQuestionsForAutonomy), which turned a rest that had signed off WITH a question
// into what both sources read as a bare one: the reminder took it — "you rested without a fence", to a
// worker whose question frizz itself had just cancelled — and the Goal stood down for it, while the
// cancellation wake went out beside it as a second delivery. The dismissal-in-flight is a settlement on
// its way (evalQuestionAnswers wakes on exactly this shape when the rest Goal is armed), so it holds
// both sources the way an answer-in-flight already held the reminder, and the wake is the ONE delivery
// the rest draws.
test("a cancellation on its way holds BOTH sources — the wake is the one delivery the rest draws", async () => {
  let lastUserAt = "2026-08-12T00:00:00.000Z"
  let spokeAt = "2026-08-12T00:01:00.000Z"
  const h = nudger({
    get lastUserAt() { return lastUserAt },
    get lastAssistantAt() { return spokeAt },
    get lastActivityAt() { return spokeAt },
  } as Partial<SessionTelemetry>)
  try {
    // The field sequence: the worker registered a question and rested; the operator armed a stop hook
    // in the footer panel, whose handler cancelled the question and kicked the sweep.
    h.storage.askThreadQuestion({
      id: "qst_cancelled", slug: h.slug,
      spec: JSON.stringify({ question: "SQLite or a JSON file?", kind: "question" }),
      askedAtMs: Date.parse("2026-08-12T00:01:00.000Z"),
    })
    h.storage.setRecurringPromptBySlug(h.slug, {
      prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false,
      intervalMs: null, armedAt: "2026-08-12T00:02:00.000Z",
    })
    h.storage.dismissThreadQuestion("qst_cancelled", Date.parse("2026-08-12T00:02:00.000Z"))
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "one delivery for this rest")
    assert.match(h.delivered[0], /CANCELLED without an answer/, "and it is the cancellation wake")
    assert.deepEqual(h.nudges(), [], "the reminder held — the worker did not rest bare, it asked")
    // Per rest, not per tick: the settlement spends only when the wake LANDS (a user record), so a slow
    // tailer cannot reopen the rest to either source in the meantime.
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "neither source follows the wake onto the same rest")

    // The wake lands and the worker rests bare again: the hold is spent, and the new rest is an
    // ordinary bare one — the reminder's, per the pass order the tests around this one pin.
    lastUserAt = "2026-08-12T00:03:00.000Z"
    spokeAt = "2026-08-12T00:04:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 2, "the hold is bounded by the wake landing")
    assert.match(h.delivered[1], /without a fence/)
  } finally { h.close() }
})

// THE FIELD SEQUENCE, END TO END, and the control that keeps the Goal a real trigger. Every rest here is
// the AGENT'S (lastAssistantAt advances; frizz's own records are not modelled, which is the harder case
// for the hold — see the previous test).
test("the Goal takes only the bare rests the reminder does not, so a worker never reads 'you rested without a fence' after fencing", async () => {
  let spokeAt = "2026-08-12T00:01:00.000Z"
  let fence: SessionTelemetry["lastFence"]
  const h = nudger({
    lastUserAt: "2026-08-12T00:00:00.000Z",
    get lastAssistantAt() { return spokeAt },
    get lastActivityAt() { return spokeAt },
    get lastFence() { return fence },
  } as Partial<SessionTelemetry>)
  const kinds = () => h.delivered.map((m) => m.startsWith("keep going") ? "goal" : m.includes("without a fence") ? "reminder" : "other")
  try {
    h.storage.setRecurringPromptBySlug(h.slug, {
      prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false,
      intervalMs: null, armedAt: "2026-08-12T00:00:00.000Z",
    })
    // Rest 1, bare (the field thread: its `ask` had just been refused). The reminder alone.
    await h.s.tick()
    assert.deepEqual(kinds(), ["reminder"])

    // The worker answers it with a ```done fence — the reply that used to be followed by a stale
    // "you rested without a fence". Nothing more reaches this thread, however many ticks run.
    spokeAt = "2026-08-12T00:02:00.000Z"
    fence = { kind: "done", body: "shipped it", hints: [] }
    await h.s.tick()
    await h.s.tick()
    assert.deepEqual(kinds(), ["reminder"], "a fenced reply draws nothing — no Goal for the rest before it, none for this one")

    // CONTROL: the same thread ignoring the protocol. The fence gave the reminder's allowance back, so
    // two more bare rests draw it twice; the THIRD is one the reminder cannot take, and that is the
    // Goal's — the operator's words do reach a worker that keeps resting bare.
    fence = undefined
    spokeAt = "2026-08-12T00:03:00.000Z"
    await h.s.tick()
    spokeAt = "2026-08-12T00:04:00.000Z"
    await h.s.tick()
    assert.deepEqual(kinds(), ["reminder", "reminder", "reminder"])
    spokeAt = "2026-08-12T00:05:00.000Z"
    await h.s.tick()
    assert.deepEqual(kinds(), ["reminder", "reminder", "reminder", "goal"], "the reminder's cap is spent; the Goal takes the rest")
    // The Goal's trailer does not carry the protocol — the reminder is the one place it lives.
    assert.doesNotMatch(h.delivered[3], /```question/)
  } finally { h.close() }
})

// ---- AND AN ARMED GOAL DOES NOT SWITCH IT OFF -----------------------------------------------------
// It did, for one day (2026-08-13 → 2026-08-14), for the subset of Goals the panel then called Autonomous
// mode — on the reading that this reminder buys a queue A HUMAN triages, and a self-driving thread is the
// operator saying nobody is triaging this one. The switch is gone (2026-08-16) and every Goal is now that
// kind, so the argument would apply to ALL of them if it held. Two facts killed it, and this test is the
// guard against re-deriving it:
//
//   THE REMINDER STOPPED BEING A MENU OF WAYS TO STOP. It now OPENS by sending a half-finished thread back
//   to the work, which is the Goal's own instruction — so the "two deliveries pulling opposite ways" the
//   suppression was built on no longer describes anything.
//
//   IT IS THE ONLY DELIVERY THAT NAMES THE PARK. The Goal's trailer names ```done and deliberately not
//   ```awaiting (see restPromptMessage — a budget decision), so silencing this left the threads most
//   likely to be holding background work with no way to learn how to park on it. Measured over five
//   consecutive bare rests with the suppression in: five Goal bumps, no reminder, the park never
//   mentioned once.
//
// The 2026-08-28 hold runs the OTHER way — the Goal stands down on the rest the reminder takes — and
// this test is also the guard against getting that direction wrong: Goal first with the reminder held
// would starve the reminder on exactly the worker that rests bare after every Goal, which is the
// measured five-rests-no-park above by another route.
test("an armed Goal does not silence the reminder — the reminder is what lands on the rest", async () => {
  const h = nudger({})
  try {
    // The at-rest trigger driving, which is the exact row the reverted gate keyed on.
    h.storage.setRecurringPromptBySlug(h.slug, {
      prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false,
      intervalMs: null, armedAt: "2026-08-12T00:00:00.000Z",
    })
    await h.s.tick()
    const reminder = h.delivered.find((m) => m.includes("without a fence"))
    assert.ok(reminder, "the reminder fires")
    assert.ok(!h.delivered.some((m) => m.startsWith("keep going")), "and the Goal stands down on the rest it took")
    // The park is the thing the Goal's trailer cannot supply, so it is what the assertion is really
    // about. Matched on the FENCE rather than on whatever tool registers it, so a change to the
    // registration mechanism cannot silently turn this into a test of nothing.
    assert.match(reminder, /```awaiting/)
  } finally { h.close() }
})
