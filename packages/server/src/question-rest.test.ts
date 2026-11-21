// WHAT THE SERVER DOES ABOUT QUESTIONS ACROSS A THREAD'S RESTS — the real fold (applyRecord), the real
// scheduler and the real board over real SQLite, with the worker simulated rest by rest. The registrar's
// own grammar is pinned in question-fences.test.ts; this file pins how its corrections share a rest with
// the other wakes, and where a question that has FADED (asked at an earlier rest, never referenced since)
// leaves the thread.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boardAskThread, withAnswersNote, DONE_FENCE_CORRECTION_LEAD, formatThreadMessage, humanGapNote, limitResumeSteer, mergedWakeMessage, needsAction, PARK_CORRECTION_NAMES_LEAD, parkExpiredWakeMessage, prWatchWakeMessage, questionAnswerMessage, restPromptMessage, RETRY_FOLLOW_UP, sectionOf, shellDoneMessage, signoffNudgeMessage, timerPromptMessage, wakeDeliveryToken } from "@frizz/shared"
import { Bus } from "./bus.ts"
import { createBoard } from "./board.ts"
import type { Project } from "./project.ts"
import { createQuestionFaultBook } from "./question-fences.ts"
import { createScheduler } from "./scheduler.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyEvent, applyRecord, newTailState, type SessionTelemetry, type Tailer } from "./tailer.ts"

// Every fixture instant sits a week AHEAD of the real clock. The code compares a message's time with
// Date.now() (a Goal armed now refuses only questions written after it), and a fixed date stopped
// working the day the clock passed it: these were "2026-10-20T10:00Z", six days ahead when written.
const T0 = Date.now() + 7 * 86_400_000
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString()
const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``
const choice = (id: string) => fence("question", `id: ${id}\nkind: choice\nquestion: SQLite or a JSON file?\noptions:\n  - label: SQLite\n  - label: JSON file`)
/** `kind: choice` with no options: refused by the registrar, so it draws a correction. */
const broken = (id: string) => fence("question", `id: ${id}\nkind: choice\nquestion: SQLite or a JSON file?`)

/** One thread, a simulated worker writing records through the real fold, and the scheduler and board
 *  reading what the fold produced. */
function world(over: Partial<SessionRow> = {}) {
  const slug = "t"
  const dir = mkdtempSync(join(tmpdir(), "frizz-question-rest-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession({
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-10-15T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  } as SessionRow)
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")
  const s = newTailState(slug, `sid-${slug}`, "/dev/null")
  const extra: Partial<SessionTelemetry> = {}
  const tele = (): SessionTelemetry => ({
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], retiredShells: [], retiredSubAgents: [],
    lastActivityAt: s.lastActivityAt, lastAssistantAt: s.lastAssistantAt, lastAssistant: s.lastAssistant,
    lastAssistantLine: s.lastAssistantLine, questionSightings: s.questionSightings, pendingQuestion: false,
    lastAssistantAllDone: s.lastAssistantAllDone, lastUserAt: s.lastUserAt, restFromAt: s.restFromAt, questionCorrectedAt: s.questionCorrectedAt, repairAskedAt: s.repairAskedAt, lastUserText: s.lastUserText,
    lastFence: s.lastFence, ...extra,
  } as SessionTelemetry)
  const tailer = {
    get: (x: string) => (x === slug ? tele() : undefined), foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  } as unknown as Tailer
  const sent: string[] = []
  let clock = Date.parse(at(0))
  // One book for both, as in the server's context: the scheduler's pass writes it, the board reads it.
  const questionFaults = createQuestionFaultBook()
  const scheduler = createScheduler({
    wakeQuietWindowMs: 0, storage, fetchPr: async () => undefined, fetchGithubReview: async () => [], questionFaults,
    tailer, resume: async (_slug: string, message: string, deliveryId: string) => { sent.push(`${message}\n\n${wakeDeliveryToken(deliveryId)}`) }, log: () => {}, now: () => clock,
  } as never)
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const board = createBoard(project, storage, new Bus(), tailer, "question-rest", { claudeBrokerDaemonAlive: () => true, questionFaults: (x) => questionFaults.of(x) })
  return {
    /** Every delivery the scheduler sent, as it lands in the transcript: the message and its token. */
    storage, scheduler, board, sent, extra,
    /** Tick the scheduler with its clock at `minute`. */
    tick: async (minute: number) => { clock = Date.parse(at(minute)); await scheduler.tick() },
    /** A user record: the human's message, or a delivery of Frizz's (pass what `sent` holds, or `wake(…)`). */
    user: (minute: number, text: string) => applyRecord(s, { type: "user", timestamp: at(minute), message: { role: "user", content: text } } as never),
    /** A message queued behind a running turn: the runtime's own record of it, before any delivery. */
    queued: (minute: number, text: string) => applyRecord(s, { type: "queue-operation", operation: "enqueue", timestamp: at(minute), content: text } as never),
    fold: s,
    say: (minute: number, text: string) => applyRecord(s, { type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } } as never),
    deliveries: () => storage.db.prepare("SELECT fence_id FROM wake_delivery WHERE thread_slug = ? ORDER BY rowid").all(slug).map((r) => (r as { fence_id: string }).fence_id),
    view: () => board.refresh().threads.find((x) => x.id === slug)!,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

// ── The corrective cap, beside an honoured park ─────────────────────────────────────────────────────

// A broken question fence and a VALID ```awaiting park in one message. SOURCE 14 counts its correction
// against PARK_BUMP_MAX; SOURCE 12 then finds the park honoured and handed the allowance back in the
// same tick — so the count never left zero, and a worker that rewrote the same broken fence on every
// rest was corrected on every rest, forever: the closed loop the cap exists to break (617 bumps to one
// thread on 2026-08-17).
test("a broken question fence beside an honoured park still runs out of corrections", async () => {
  const w = world()
  try {
    w.extra.bgShells = [{ label: "the suite", startedAt: at(0), state: "running", id: "toolu_x", taskId: "bzvt" }] as never
    w.user(0, "move the settings into a real store")
    for (let minute = 1; minute <= 8; minute++) {
      w.say(minute, `${broken("store")}\n\n${fence("awaiting", "status: working\nshells: [bzvt]\nfor: 1h")}`)
      await w.tick(minute + 0.25)
      // The delivered correction lands in the transcript as a user record, which closes the rest.
      w.user(minute + 0.5, w.sent[w.sent.length - 1] ?? "steer")
    }
    const corrections = w.deliveries().filter((id) => id.startsWith("park:question-fence:"))
    assert.equal(corrections.length, 3, `capped at PARK_BUMP_MAX — got ${corrections.length} corrections over eight identical rests`)
  } finally { w.close() }
})

test("an honoured park still gives the allowance back on a rest whose question fences all registered", async () => {
  const w = world()
  try {
    w.extra.bgShells = [{ label: "the suite", startedAt: at(0), state: "running", id: "toolu_x", taskId: "bzvt" }] as never
    w.user(0, "go")
    w.say(1, broken("store"))
    await w.tick(1.25)
    w.user(1.5, w.sent[0])
    assert.equal(w.storage.getSession("t")?.park_bumps, 1)
    // The negative control: the same honoured park with nothing to correct resets the count as before.
    w.say(2, fence("awaiting", "status: working\nshells: [bzvt]\nfor: 1h"))
    await w.tick(2.25)
    assert.equal(w.storage.getSession("t")?.park_bumps, 0)
  } finally { w.close() }
})

// ── One rest, one voice ──────────────────────────────────────────────────────────────────────────────

// A thread with a Goal armed at rest runs AUTONOMOUSLY: a non-secret question there is refused with
// "decide it yourself" (SOURCE 14). The Goal's own rest prompt fired on the same rest as well, and the
// outbox handed the worker both under "Frizz held 2 wakes" — the two-deliveries-for-one-rest shape the
// sign-off nudge already stands down for (SOURCE 9 reads the same correction), and the one an
// ```awaiting fence's own correction (SOURCE 12) holds the Goal for.
test("on a Goal thread, a question is cancelled on the record and that wake has the rest to itself", async () => {
  const w = world()
  try {
    w.storage.setRecurringPromptBySlug("t", { prompt: "Keep going until the suite is green.", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: at(0) })
    // The sign-off reminder off, so the bare rest below is the Goal's alone (it stands down for the
    // reminder, by design — see evalRestPrompts).
    w.storage.setSetting("signoffNudge", "off")
    w.user(0, "go")
    w.say(1, `One call to make first.\n\n${choice("store")}`)
    await w.tick(2)
    // Autonomous: the question is recorded and cancelled in one breath, never put to the human, and the
    // worker hears of it from the cancellation wake — the one voice at this rest, naming its own id.
    assert.deepEqual(w.storage.listThreadQuestions("t").map((q) => [q.handle, q.state]), [["store", "dismissed"]])
    assert.equal(w.deliveries().length, 1, "the cancellation alone — no Goal prompt and no fence correction beside it")
    assert.equal(w.sent.length, 1)
    assert.match(w.sent[0], /^1 question you registered was CANCELLED without an answer\. Decide it yourself/)
    assert.match(w.sent[0], /- `store` — /)
    // The worker decides, and rests bare: now the Goal has the rest to itself.
    w.user(2.5, w.sent[0])
    w.say(3, "Went with SQLite.")
    await w.tick(4)
    assert.ok(w.deliveries().some((id) => id.startsWith("stophook:")), "the next rest gets the Goal")
  } finally { w.close() }
})

// ── A FADED question: open, asked at an earlier rest, not referenced by this one ─────────────────────

// The server queues a thread on the questions STANDING at its rest (standingQuestions), but the board
// sent every open row alike, and both readers of the view — the rail's mark (web groups.ts
// sessionIndicatorKind) and the ask count (shared needsAction) — took any open row for an ask. So a
// thread whose worker had moved on wore the [?] and counted under "N need you" wherever it sat: parked in
// Snoozed, working in Active with no card behind it, or queued as a finished handoff. That is the mark
// the maintainer reported on 2026-08-31 ("marked as a question status, but there is no question"),
// re-opened by the rule that lets an older question fade. The view now says which rows stand.
async function fadedQuestion() {
  const w = world()
  w.user(0, "move the settings into a real store")
  w.say(1, `One call to make first.\n\n${choice("store")}`)
  await w.tick(2)
  assert.deepEqual(w.view().questions.map((q) => q.standing), [true], "asked at this rest: it stands")
  assert.equal(needsAction(w.view()), true)
  // The human steers past it without answering, so the question belongs to an older rest from here on.
  w.user(3, "leave that for now and finish the migration")
  return w
}

test("a faded question beside a `status: watching` park: Snoozed, out of the queue, and not an ask", async () => {
  const w = await fadedQuestion()
  try {
    w.storage.armThreadTimer({ id: "tmr_aaaa", slug: "t", prompt: "check the release", fireAtMs: Date.parse(at(120)), createdAtMs: Date.parse(at(3)) })
    w.say(4, fence("awaiting", "status: watching\ntimers: [tmr_aaaa]\nfor: 3h"))
    await w.tick(5)
    const t = w.view()
    assert.equal(t.needsYou, false, "the park is honoured — the old question does not queue the thread")
    assert.equal(sectionOf(t), "snoozed")
    assert.deepEqual(t.questions.map((q) => [q.spec.handle, q.standing]), [["store", false]], "still open and answerable, and marked as not standing")
    assert.equal(needsAction(t), false, "nothing the human is being asked at this rest")
    assert.deepEqual(w.deliveries(), [], "and the worker is not corrected for it")
  } finally { w.close() }
})

test("a faded question beside a ```done fence or a bare rest queues the thread as that rest, not as an ask", async () => {
  const done = await fadedQuestion()
  try {
    done.say(4, `Migration finished.\n\n${fence("done", "- Landed the migration on main.")}`)
    await done.tick(5)
    const t = done.view()
    assert.equal(t.needsYou, true, "a done handoff queues")
    assert.equal(t.lastFence?.kind, "done")
    assert.equal(needsAction(t), false, "…as a handoff, not as a question")
    assert.equal(boardAskThread(t), false, "so it is not one of the board's \"N need you\"")
  } finally { done.close() }
  const bare = await fadedQuestion()
  try {
    bare.say(4, "Migration finished.")
    await bare.tick(5)
    assert.equal(needsAction(bare.view()), false)
    assert.deepEqual(bare.deliveries(), [`signoff:${at(4)}`], "a bare rest, nudged as one")
  } finally { bare.close() }
})

test("a reference brings a faded question back to the rest, and a question beats a ```done fence", async () => {
  const w = await fadedQuestion()
  try {
    w.say(4, `Migration finished, and the store is the last open call.\n\n${fence("question", "id: store")}\n\n${fence("done", "- Landed the migration on main.")}`)
    await w.tick(5)
    const t = w.view()
    assert.deepEqual(t.questions.map((q) => q.standing), [true])
    assert.equal(t.needsYou, true)
    assert.equal(needsAction(t), true, "the question is this rest's ask, whatever the fence below it says")
    // No nudge, and nothing wrong with the reference. The done fence beside an open question is corrected
    // on its own account (SOURCE 15, pinned in question-done.test.ts).
    assert.deepEqual(w.deliveries(), [`park:done-open-question:${at(4)}`])
  } finally { w.close() }
})

// ── A faded question is still a question: answering it wakes the worker wherever the thread rests ────

test("answering a faded question wakes the worker at a done rest and at a watching park; an archived thread keeps it for its reopening", async () => {
  for (const shape of ["done", "watching", "archived"] as const) {
    const w = await fadedQuestion()
    try {
      w.storage.armThreadTimer({ id: "tmr_aaaa", slug: "t", prompt: "check the release", fireAtMs: Date.parse(at(120)), createdAtMs: Date.parse(at(3)) })
      w.say(4, shape === "watching" ? fence("awaiting", "status: watching\ntimers: [tmr_aaaa]\nfor: 3h") : fence("done", "- Landed the migration on main."))
      if (shape === "archived") w.storage.setState("t", "archived")
      await w.tick(5)
      const [q] = w.storage.listThreadQuestions("t")
      w.storage.answerThreadQuestion(q.id, JSON.stringify({ questionId: q.id, question: "SQLite or a JSON file?", chosen: ["SQLite"] }), Date.parse(at(6)))
      await w.tick(7)
      if (shape === "archived") {
        assert.deepEqual(w.sent, [], "an archived thread is told nothing…")
        w.storage.setState("t", "open")
        await w.tick(8)
      }
      // (The done rest also drew SOURCE 15's correction at minute 5, for signing off over the open
      // question. The answer is what this test is about, and it arrives whatever became of that.)
      const wakes = w.sent.filter((m) => !m.startsWith(DONE_FENCE_CORRECTION_LEAD))
      assert.equal(wakes.length, 1, `${shape}: one wake`)
      // The wake names the question by the id its fence gave it, ahead of the restated text (2026-10-13).
      assert.match(wakes[0], /^Answers to earlier questions:\n1\. `store` “SQLite or a JSON file\?” → SQLite\n/)
    } finally { w.close() }
  }
})

test("dismissing a faded question wakes nobody and takes it off the view", async () => {
  const w = await fadedQuestion()
  try {
    w.say(4, fence("done", "- Landed the migration on main."))
    await w.tick(5)
    // (The done fence over the open question has drawn SOURCE 15's correction by now.)
    const before = w.sent.length
    const [q] = w.storage.listThreadQuestions("t")
    w.storage.dismissThreadQuestion(q.id, Date.parse(at(6)))
    await w.tick(7)
    assert.equal(w.sent.length, before, "the dismissal sends nothing")
    assert.deepEqual(w.view().questions, [])
    assert.equal(w.view().lastFence?.kind, "done")
  } finally { w.close() }
})

// ── A worker whose contract still teaches `questions:` in the ```awaiting fence ───────────────────────

test("a legacy `questions:` claim makes the named open question stand; an answered or unknown name is ignored without a bump", async () => {
  // Names the open question, by the id Frizz minted for it — which is what that contract's worker holds.
  const open = await fadedQuestion()
  try {
    const [q] = open.storage.listThreadQuestions("t")
    open.say(4, fence("awaiting", `questions: [${q.id}]`))
    await open.tick(5)
    const t = open.view()
    assert.deepEqual(t.questions.map((x) => x.standing), [true], "the claim is read: the question stands at this rest")
    assert.equal(t.needsYou, true)
    assert.deepEqual(open.deliveries(), [], "no refusal and no nudge")
  } finally { open.close() }
  // Names one that was answered, and one that never existed: nothing stands, nothing is refused, and the
  // thread does not vanish from the queue behind a park on nobody.
  for (const name of ["answered", "qst_000000000000"]) {
    const w = await fadedQuestion()
    try {
      const [q] = w.storage.listThreadQuestions("t")
      w.storage.answerThreadQuestion(q.id, JSON.stringify({ questionId: q.id, question: "SQLite or a JSON file?", chosen: ["SQLite"] }), Date.parse(at(3.2)))
      await w.tick(3.4)
      w.user(3.6, w.sent[0])
      w.say(4, fence("awaiting", `questions: [${name === "answered" ? q.id : name}]`))
      for (const minute of [5, 6, 7]) await w.tick(minute)
      assert.deepEqual(w.deliveries().filter((id) => id.startsWith("park:")), [], `${name}: no correction, tick after tick`)
      assert.equal(w.storage.getSession("t")?.park_bumps ?? 0, 0)
      assert.equal(w.view().needsYou, true, `${name}: a rest waiting on nothing stays in the queue`)
      assert.deepEqual(w.view().questions, [])
    } finally { w.close() }
  }
})

// ── Nothing Frizz delivers is the human replying past a question ───────────────────────────────────────

// The first cut of the standing rule bounded a rest by the newest user record of any kind, and Frizz's
// own deliveries are user records. The first casualty found was a fence correction: a question asked
// beside a fence Frizz then corrected stopped standing the moment the worker did what the correction says
// ("Re-send the same fence with that line added"). The rule since 2026-10-13: only a message the HUMAN
// TYPED moves the boundary (shared isHumanTypedMessage, folded into `restFromAt`).
test("a question asked beside a park Frizz corrected still stands once the park is re-sent", async () => {
  const w = world()
  try {
    w.extra.bgShells = [{ label: "the suite", startedAt: at(0), state: "running", id: "toolu_x", taskId: "bzvt" }] as never
    w.user(0, "move the settings into a real store")
    // No `status:` line — the answer-required contract corrects exactly that.
    w.say(1, `One call to make while the suite runs.\n\n${choice("store")}\n\n${fence("awaiting", "shells: [bzvt]\nfor: 1h")}`)
    await w.tick(1.25)
    assert.deepEqual(w.deliveries(), [`park:needs-input:${at(1)}`])
    assert.equal(w.view().needsYou, true, "queued on the question")
    w.user(1.5, w.sent[0])
    w.say(2, fence("awaiting", "status: working\nshells: [bzvt]\nfor: 1h"))
    await w.tick(2.25)
    const t = w.view()
    assert.deepEqual(t.questions.map((q) => [q.spec.handle, q.standing]), [["store", true]], "the same rest, re-fenced: the question still stands")
    assert.equal(t.needsYou, true, "and still queues the thread, whatever the park says")
    assert.equal(needsAction(t), true)
  } finally { w.close() }
})

test("fixing one broken question fence does not fade the valid one asked beside it", async () => {
  const w = world()
  try {
    w.user(0, "publish the packages")
    w.say(1, `Two calls.\n\n${choice("store")}\n\n${broken("scope")}`)
    await w.tick(1.25)
    assert.deepEqual(w.deliveries(), [`park:question-fence:${at(1)}`])
    w.user(1.5, w.sent[0])
    w.say(2, fence("question", "id: scope\nkind: text\nquestion: What npm scope should the packages publish under?"))
    await w.tick(2.25)
    assert.deepEqual(w.view().questions.map((q) => [q.spec.handle, q.standing]), [["store", true], ["scope", true]])
    assert.deepEqual(w.deliveries(), [`park:question-fence:${at(1)}`], "and the corrected fault is not reported a second time")
  } finally { w.close() }
})

/** A delivery of Frizz's as it lands in a worker's transcript: the message, then its token (context.ts). */
const wake = (message: string, id = "d1") => `${message}\n\n${wakeDeliveryToken(id)}`
const LIVE = (taskId: string) => ({ label: "the suite", startedAt: at(0), state: "running", id: `toolu_${taskId}`, taskId })
const quietPark = (taskId: string) => fence("awaiting", `status: working\nshells: [${taskId}]\nfor: 1h`)

// THE CASE THE RULE EXISTS FOR. The contract tells a worker that a quiet park is "the fence alone", so a
// worker that asks a question and parks on a build re-parks with no reference when the build wakes it —
// and under the old boundary the question left the queue right there, before the human had seen it.
test("a question beside a `status: working` park survives every machine wake: still standing, still queued, still an ask", async () => {
  const wakes: [string, string][] = [
    ["a shell finishing", wake(shellDoneMessage({ taskId: "bzvt", label: "the suite", status: "completed" }))],
    ["a timer", wake(timerPromptMessage("check whether the release went out", at(2)))],
    ["a PR watch", wake(prWatchWakeMessage({ target: "acme/app#12", checks: { verdict: "passing", summary: "3 of 3 passed" } } as never))],
    ["a Goal prompt", wake(restPromptMessage("Keep going until the suite is green."))],
    ["the sign-off reminder", wake(signoffNudgeMessage())],
    ["a fence correction", wake(`${PARK_CORRECTION_NAMES_LEAD}something that is not running, so it is not a park and your thread stayed in the queue.`)],
    ["a park expiring", wake(parkExpiredWakeMessage(["- `shells: [bzvt]` — still running"]))],
    ["a limit resume", wake(limitResumeSteer("session"))],
    ["several wakes held and delivered together", wake(mergedWakeMessage([{ reason: "background shell finished", message: shellDoneMessage({ taskId: "bzvt", label: "the suite", status: "completed" }) }, { reason: "timer", message: timerPromptMessage("check the release", at(2)) }], Date.parse(at(3))))],
    ["another thread's steer", formatThreadMessage({ slug: "release-train", title: "Release train" }, "The release went out; rebase when you can.")],
    ["a background child's report", `<agent-message from="general-purpose">\nThe audit is written up.\n</agent-message>`],
    ["the rail's Retry", RETRY_FOLLOW_UP],
  ]
  for (const [name, text] of wakes) {
    const w = world()
    try {
      w.extra.bgShells = [LIVE("bzvt")] as never
      w.user(0, "move the settings into a real store")
      w.say(1, `One call to make while the suite runs.\n\n${choice("store")}\n\n${quietPark("bzvt")}`)
      await w.tick(2)
      assert.equal(w.view().needsYou, true, `${name}: queued on the question`)
      // The wake lands, the worker reads the result and starts the next piece of work — fence alone.
      w.user(3, text)
      w.extra.bgShells = [LIVE("bnext")] as never
      w.say(4, quietPark("bnext"))
      await w.tick(5)
      const t = w.view()
      assert.deepEqual(t.questions.map((q) => [q.spec.handle, q.standing]), [["store", true]], `${name}: the question still stands`)
      assert.equal(t.needsYou, true, `${name}: the thread is still in the queue`)
      assert.equal(needsAction(t), true, `${name}: and its row is still an ask`)
      assert.deepEqual(w.deliveries(), [], `${name}: nothing to correct, nothing to nudge`)
    } finally { w.close() }
  }
})

test("the human typing past a question fades it; a reference brings it back until the human next types", async () => {
  const w = world()
  try {
    w.extra.bgShells = [LIVE("bzvt")] as never
    w.user(0, "move the settings into a real store")
    w.say(1, `One call to make first.\n\n${choice("store")}`)
    await w.tick(2)
    // The human replies, and not to the question. The worker gets on with it and parks.
    w.user(3, "leave that for now and get the migration running")
    w.say(4, quietPark("bzvt"))
    await w.tick(5)
    let t = w.view()
    assert.deepEqual(t.questions.map((q) => q.standing), [false], "replied past: it has faded")
    assert.equal(t.needsYou, false, "out of the queue")
    assert.equal(needsAction(t), false, "and not an ask")
    // The shell finishes; this rest still needs the answer, so the worker references it.
    w.user(6, wake(shellDoneMessage({ taskId: "bzvt", label: "the suite", status: "completed" })))
    w.say(7, `The migration is in. The store is the last open call.\n\n${fence("question", "id: store")}`)
    await w.tick(8)
    t = w.view()
    assert.deepEqual(t.questions.map((q) => q.standing), [true], "referenced: it stands again")
    assert.equal(t.needsYou, true)
    // Another machine wake, and a rest that says nothing about it: the reference still holds.
    w.user(9, wake(timerPromptMessage("check the release", at(9)), "d2"))
    w.extra.bgShells = [LIVE("bnext")] as never
    w.say(10, quietPark("bnext"))
    await w.tick(11)
    assert.deepEqual(w.view().questions.map((q) => q.standing), [true], "a reference lasts until the human next types")
    assert.equal(w.view().needsYou, true)
    // …and the human typing again is what ends it.
    w.user(12, "still not ready to decide that")
    w.say(13, quietPark("bnext"))
    await w.tick(14)
    assert.deepEqual(w.view().questions.map((q) => q.standing), [false])
    assert.equal(w.view().needsYou, false)
    assert.deepEqual(w.deliveries(), [], "none of it drew a correction or a nudge")
  } finally { w.close() }
})

test("answering one of two questions is not replying past the other", async () => {
  const w = world()
  try {
    w.extra.bgShells = [LIVE("bzvt")] as never
    w.user(0, "publish the packages")
    w.say(1, `Two calls.\n\n${choice("store")}\n\n${fence("question", "id: scope\nkind: text\nquestion: What npm scope should the packages publish under?")}`)
    await w.tick(2)
    const store = w.storage.listThreadQuestions("t").find((q) => q.handle === "store")!
    w.storage.answerThreadQuestion(store.id, JSON.stringify({ questionId: store.id, question: "SQLite or a JSON file?", chosen: ["SQLite"] }), Date.parse(at(3)))
    await w.tick(3.5)
    assert.match(w.sent[0], /^Answers to earlier questions:/)
    // The answer's own delivery, exactly as the scheduler sent it; then the worker acts on it and parks.
    w.user(4, w.sent[0])
    w.say(5, quietPark("bzvt"))
    await w.tick(6)
    const t = w.view()
    assert.deepEqual(t.questions.map((q) => [q.spec.handle, q.standing]), [["scope", true]], "the unanswered one still stands")
    assert.equal(t.needsYou, true)
    assert.equal(needsAction(t), true)
  } finally { w.close() }
})

test("a question asked mid-turn outranks a ```done fence many machine wakes later", async () => {
  const w = world()
  try {
    w.user(0, "move the settings into a real store")
    w.say(1, `Before I go on:\n\n${choice("store")}\n\nNow running the migration.`)
    w.say(1.5, "Migration running.")
    for (const [i, text] of [shellDoneMessage({ taskId: "bzvt", label: "the migration", status: "completed" }), timerPromptMessage("check the release", at(3)), restPromptMessage("Keep going until the suite is green.")].entries()) {
      w.user(2 + i * 2, wake(text, `d${i}`))
      w.say(3 + i * 2, `Step ${i + 1} finished.`)
      await w.tick(3.5 + i * 2)
    }
    w.say(9, `Everything else is in.\n\n${fence("done", "- Landed the migration on main.")}`)
    await w.tick(10)
    const t = w.view()
    assert.equal(t.lastFence?.kind, "done")
    assert.deepEqual(t.questions.map((q) => q.standing), [true], "nobody has replied to it")
    assert.equal(t.needsYou, true)
    assert.equal(needsAction(t), true, "the row is the question's, not the done's")
    assert.equal(boardAskThread(t), true)
    // And the bare rests on the way never drew the sign-off reminder: a standing question signs a rest off.
    assert.deepEqual(w.deliveries().filter((id) => id.startsWith("signoff:")), [], "SOURCE 9 stayed quiet at every bare rest behind the question")
    // The done fence itself is another matter: it signed off over an open question (SOURCE 15).
    assert.deepEqual(w.deliveries(), [`park:done-open-question:${at(9)}`])
  } finally { w.close() }
})

test("SOURCE 9 still nudges a bare rest once the human has typed past the question", async () => {
  const w = world()
  try {
    w.user(0, "move the settings into a real store")
    w.say(1, `One call to make first.\n\n${choice("store")}`)
    await w.tick(2)
    w.user(3, "leave that for now")
    w.say(4, "Carrying on.")
    await w.tick(5)
    assert.deepEqual(w.deliveries(), [`signoff:${at(4)}`], "the negative control: a faded question signs nothing off")
  } finally { w.close() }
})

// SOURCE 14 reads the same boundary. Its window used to open at the newest user record of any kind, so a
// fault written mid-turn was dropped if any wake landed before the worker went idle.
test("a broken fence written mid-turn is still corrected when a wake lands before the worker goes idle — once", async () => {
  const w = world()
  try {
    w.user(0, "publish the packages")
    w.say(1, `Before I go on:\n\n${broken("scope")}\n\nNow building.`)
    // A timer fires mid-turn (the clock-driven wakes do not wait for rest), and the turn runs on.
    w.user(2, wake(timerPromptMessage("check the release", at(2))))
    w.say(3, "Built. Waiting on the scope.")
    await w.tick(4)
    assert.deepEqual(w.deliveries(), [`park:question-fence:${at(3)}`], "the fault predates the wake and is still news")
    assert.match(w.sent[0], /`scope` — `kind: choice` needs two or more options/)
    // The correction lands and the worker rests again without fixing it: told once, not again.
    w.user(5, w.sent[0])
    w.say(6, "Noted.")
    await w.tick(7)
    await w.tick(8)
    assert.deepEqual(w.deliveries().filter((id) => id.startsWith("park:question-fence:")), [`park:question-fence:${at(3)}`])
    // A fault the human has typed past is moot.
    w.user(9, "forget the scope question")
    w.say(10, "Done with that.")
    await w.tick(11)
    assert.deepEqual(w.deliveries().filter((id) => id.startsWith("park:question-fence:")), [`park:question-fence:${at(3)}`])
  } finally { w.close() }
})

// ── The fold's boundary, record by record ─────────────────────────────────────────────────────────────

test("restFromAt moves only on a message the human typed, in a record of its own or sharing one with a wake", () => {
  const typed = "leave that for now and finish the migration"
  const shell = shellDoneMessage({ taskId: "bzvt", label: "the suite", status: "completed" })
  const cases: [string, string, boolean][] = [
    ["a typed message", typed, true],
    ["a typed message carrying the clock note the router appends after a long silence", `${typed}\n\n${humanGapNote(Date.parse(at(240)), at(0))}`, true],
    ["a wake", wake(shell), false],
    ["two wakes the runtime joined into one record", `${wake(shell, "d1")}\n${wake(timerPromptMessage("check", at(1)), "d2")}`, false],
    ["a wake and then the human's message, joined into one record", `${wake(shell)}\n${typed}`, true],
    ["a typed message that quotes a correction's lead", `Why did it say "${PARK_CORRECTION_NAMES_LEAD}nothing"?`, true],
    ["an answer's delivery", wake(questionAnswerMessage([{ questionId: "qst_aaaaaaaaaaaa", question: "SQLite or a JSON file?", chosen: ["SQLite"] }])), false],
    // …and one that names its question by the worker's own id is the same delivery (2026-10-13).
    ["an answer's delivery naming its question by id", wake(questionAnswerMessage([{ questionId: "qst_aaaaaaaaaaaa", question: "SQLite or a JSON file?", chosen: ["SQLite"], handle: "settings-store" }])), false],
    // The prompt box's Send carries staged answers as an ordinary follow-up, with no token. Sent with
    // nothing typed it is an answer and not the human typing, exactly as the card's own Send is; with a
    // note beside the answers the human did type.
    ["answers sent from the prompt box with nothing typed", questionAnswerMessage([{ questionId: "qst_aaaaaaaaaaaa", question: "SQLite or a JSON file?", chosen: ["SQLite"], handle: "settings-store" }]), false],
    ["…the same, carrying the clock note", `${questionAnswerMessage([{ questionId: "qst_aaaaaaaaaaaa", question: "SQLite or a JSON file?", chosen: ["SQLite"] }])}\n\n${humanGapNote(Date.parse(at(240)), at(0))}`, false],
    ["answers sent from the prompt box with a typed note", withAnswersNote(questionAnswerMessage([{ questionId: "qst_aaaaaaaaaaaa", question: "SQLite or a JSON file?", chosen: ["SQLite"] }]), "and skip the docs"), true],
    ["a typed message that merely opens on the answers header's words", "Answers to earlier questions: are they in yet?", true],
    ["another thread's steer", formatThreadMessage({ slug: "release-train", title: "Release train" }, "Rebase when you can."), false],
    ["another Claude session's message", `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock" from-name="frizz-11">\nping\n</cross-session-message>`, false],
    ["the Retry button's sentence", RETRY_FOLLOW_UP, false],
    ["the Retry sentence inside a typed message", `${RETRY_FOLLOW_UP} And skip the docs.`, true],
  ]
  for (const [name, text, moves] of cases) {
    const s = newTailState("t", "sid-t", "/dev/null")
    applyRecord(s, { type: "user", timestamp: at(0), message: { role: "user", content: "move the settings into a real store" } } as never)
    applyRecord(s, { type: "user", timestamp: at(5), message: { role: "user", content: text } } as never)
    assert.equal(s.restFromAt, moves ? at(5) : at(0), name)
    // The normalized (codex, ACP) fold reads the same predicate.
    const c = newTailState("c", "sid-c", "/dev/null")
    applyEvent(c, { kind: "user-message", at: at(0), text: "move the settings into a real store", synthetic: false } as never)
    applyEvent(c, { kind: "user-message", at: at(5), text, synthetic: false } as never)
    assert.equal(c.restFromAt, moves ? at(5) : at(0), `${name} (normalized)`)
    assert.equal(c.lastUserAt, at(5), `${name}: lastUserAt still moves — it is the row-order key`)
  }
})

test("a message typed while the worker is mid-turn moves the boundary when it was typed, not when it was delivered", async () => {
  const typed = "also bump the version"
  // QUEUED AHEAD OF A WAKE: the runtime joins the two, and the merged record reads as one delivery
  // ending in the wake's token. The queue's own record is what says the human typed.
  const w = world()
  try {
    w.user(0, "move the settings into a real store")
    w.say(1, `One call to make first.\n\n${choice("store")}\n\nNow running the migration.`)
    w.queued(2, typed)
    w.queued(2.5, wake(timerPromptMessage("check the release", at(2.5))))
    w.user(3, `${typed}\n${wake(timerPromptMessage("check the release", at(2.5)))}`)
    w.say(4, "Bumped it.")
    await w.tick(5)
    assert.equal(w.fold.restFromAt, at(2), "the instant the human typed")
    assert.deepEqual(w.view().questions.map((q) => q.standing), [false], "the human message wins: they replied past the question")
  } finally { w.close() }
  // TYPED BEFORE THE QUESTION EXISTED: the human queues a message, the worker asks a question before the
  // queue drains, and then reads the message. That is not a reply past the question.
  const v = world()
  try {
    v.user(0, "move the settings into a real store")
    v.say(1, "Reading the settings layer.")
    v.queued(2, typed)
    v.say(2.5, `One call to make first.\n\n${choice("store")}`)
    v.user(3, typed)
    v.say(4, "Bumped it.")
    await v.tick(5)
    assert.equal(v.fold.restFromAt, at(2))
    assert.deepEqual(v.view().questions.map((q) => q.standing), [true], "asked after the human typed: it stands")
    // The same words typed again later are a new message, not the queued one delivered twice.
    v.user(6, typed)
    assert.equal(v.fold.restFromAt, at(6))
  } finally { v.close() }
})

// ── A REFUSED fence is not a reference ───────────────────────────────────────────────────────────────

// A worker reuses an open question's id for a DIFFERENT question, after the human has typed past the
// first. The registrar refuses the second fence. Read by id alone it was also a reference to the first:
// the old question stood again, the thread queued on a question its newest message never mentions, and a
// rest that had asked nothing read as signed off. The fault says the fence named nothing.
test("a fence refused for reusing an open question's id does not make that question stand again", async () => {
  const w = world()
  try {
    w.user(0, "move the settings into a real store")
    w.say(1, `One call to make first.\n\n${choice("store")}`)
    await w.tick(2)
    assert.deepEqual(w.view().questions.map((q) => q.standing), [true])
    w.user(3, "do the docs first")
    w.say(4, "Docs are in.")
    await w.tick(5)
    assert.deepEqual(w.view().questions.map((q) => q.standing), [false], "the human typed past it: it has faded")
    // The reuse: same id, a different question.
    w.user(6, "and the region?")
    w.say(7, fence("question", "id: store\nkind: choice\nquestion: Which region?\noptions:\n  - label: us-east\n  - label: eu-west"))
    await w.tick(8)
    const view = w.view()
    assert.deepEqual(view.questionFaults?.map((f) => [f.at, f.id]), [[at(7), "store"]], "the board carries the refusal")
    assert.deepEqual(view.questions.map((q) => [q.spec.question, q.standing]), [["SQLite or a JSON file?", false]], "still faded: the refused fence referenced nothing")
    assert.ok(w.deliveries().some((id) => id.startsWith("park:question-fence:")), "and the worker is corrected for it")
    // Negative control: a real reference at the next rest does make it stand.
    w.user(9, w.sent[w.sent.length - 1])
    w.say(10, fence("question", "id: store"))
    await w.tick(11)
    assert.deepEqual(w.view().questions.map((q) => q.standing), [true])
  } finally { w.close() }
})

// ── A question that closed without an answer is still a fence in the transcript ──────────────────────

test("the view lists fence-asked questions that were dismissed or withdrawn, so their fences do not read as asked", async () => {
  const w = world()
  try {
    w.user(0, "go")
    w.say(1, `Two calls.\n\n${choice("store")}\n\n${choice("region")}`)
    await w.tick(2)
    assert.equal("closedQuestions" in w.view(), false, "nothing closed: no field")
    const [store, region] = w.storage.listThreadQuestions("t")
    w.storage.dismissThreadQuestion(store.id, Date.parse(at(3)))
    w.storage.withdrawThreadQuestion("t", region.id, Date.parse(at(3)))
    assert.deepEqual(w.view().closedQuestions?.map((q) => [q.handle, q.state, q.askedAt]), [["store", "dismissed", at(1)], ["region", "withdrawn", at(1)]])
    assert.deepEqual(w.view().questions, [])
  } finally { w.close() }
})

test("a Goal thread's question is on the view as dismissed from the first board that sees its fence", async () => {
  const w = world()
  try {
    w.storage.setRecurringPromptBySlug("t", { prompt: "Keep going until the suite is green.", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: at(0) })
    w.user(0, "go")
    w.say(1, `One call to make first.\n\n${choice("store")}`)
    await w.tick(2)
    const view = w.view()
    assert.deepEqual(view.closedQuestions?.map((q) => [q.handle, q.state]), [["store", "dismissed"]])
    assert.deepEqual(view.questions, [], "never an open card")
    assert.equal(view.questionFaults, undefined, "and not a fault: it is on the record")
  } finally { w.close() }
})
