// SIGNING OFF AS DONE WHILE A QUESTION IS OPEN, and the two cap items that share its code — the real fold
// (applyRecord), the real scheduler and the real board over real SQLite, with the worker simulated rest by
// rest, in the manner of question-rest.test.ts (whose harness this copies).
//
// `frizzctl done` refuses while a question of the thread is open. A ```done FENCE cannot be refused, so the
// scheduler holds it to the same gate after the fact (SOURCE 15): one correction for the rest, naming each
// open question by the worker's own id, in the words the command's refusal uses. The first half of this
// file pins that; the second pins what a rest costs in corrections once the cap is in play.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DONE_FENCE_CORRECTION_LEAD, doneOpenQuestionsRefusal, doneOverOpenQuestionsBody, isParkCorrection, needsAction, QUESTION_FENCE_CORRECTION_LEAD, questionAnswerMessage, restPromptMessage, RETRY_FOLLOW_UP, shellDoneMessage, timerPromptMessage, wakeDeliveryToken } from "@frizz/shared"
// @ts-expect-error — the worker plugin is plain .mjs shipped loose beside the server; it has no types.
import { doneOpenQuestionsRefusal as cliDoneOpenQuestionsRefusal } from "../../../cc-worker/lib/frizz-tools.mjs"
import { Bus } from "./bus.ts"
import { createBoard } from "./board.ts"
import type { Project } from "./project.ts"
import { createQuestionFaultBook, QUESTION_FENCE_UNDER_DONE_HINT } from "./question-fences.ts"
import { createScheduler } from "./scheduler.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyRecord, newTailState, type SessionTelemetry, type Tailer } from "./tailer.ts"
import { parseTranscript } from "./transcript.ts"

// Every fixture instant sits a week AHEAD of the real clock. The code compares a message's time with
// Date.now() (a Goal armed now refuses only questions written after it), and a fixed date stopped
// working the day the clock passed it: these were "2026-10-20T10:00Z", six days ahead when written.
const T0 = Date.now() + 7 * 86_400_000
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString()
const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``
const choice = (id: string, question = "SQLite or a JSON file?") => fence("question", `id: ${id}\nkind: choice\nquestion: ${question}\noptions:\n  - label: SQLite\n  - label: JSON file`)
/** `kind: choice` with no options: refused by the registrar, so it draws a correction. */
const broken = (id: string) => fence("question", `id: ${id}\nkind: choice\nquestion: SQLite or a JSON file?`)
const done = fence("done", "- Landed the migration on main.")
/** A delivery of Frizz's as it lands in a worker's transcript: the message, then its token (context.ts). */
const wake = (message: string, id = "d1") => `${message}\n\n${wakeDeliveryToken(id)}`
const DONE_OVER = (minute: number) => `park:done-open-question:${at(minute)}`

/** One thread, a simulated worker writing records through the real fold, and the scheduler and board
 *  reading what the fold produced. */
function world(over: Partial<SessionRow> = {}, opts: { quietWindowMs?: number } = {}) {
  const slug = "t"
  const dir = mkdtempSync(join(tmpdir(), "frizz-question-done-"))
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
  const logs: string[] = []
  let clock = Date.parse(at(0))
  const questionFaults = createQuestionFaultBook()
  const scheduler = createScheduler({
    wakeQuietWindowMs: opts.quietWindowMs ?? 0, storage, fetchPr: async () => undefined, fetchGithubReview: async () => [], questionFaults,
    tailer, resume: async (_slug: string, message: string, deliveryId: string) => { sent.push(`${message}\n\n${wakeDeliveryToken(deliveryId)}`) }, log: (line: string) => { logs.push(line) }, now: () => clock,
  } as never)
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const board = createBoard(project, storage, new Bus(), tailer, "question-done", { claudeBrokerDaemonAlive: () => true, questionFaults: (x) => questionFaults.of(x) })
  return {
    /** Every delivery the scheduler sent, as it lands in the transcript: the message and its token. */
    storage, scheduler, board, sent, extra, fold: s,
    /** Every line the scheduler logged: a pass that threw says so here, and nowhere else. */
    logs,
    tick: async (minute: number) => { clock = Date.parse(at(minute)); await scheduler.tick() },
    /** A user record: the human's message, or a delivery of Frizz's (pass what `sent` holds, or `wake(…)`). */
    user: (minute: number, text: string) => applyRecord(s, { type: "user", timestamp: at(minute), message: { role: "user", content: text } } as never),
    say: (minute: number, text: string) => applyRecord(s, { type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } } as never),
    deliveries: () => storage.db.prepare("SELECT fence_id FROM wake_delivery WHERE thread_slug = ? ORDER BY rowid").all(slug).map((r) => (r as { fence_id: string }).fence_id),
    bumps: () => storage.getSession(slug)?.park_bumps ?? 0,
    view: () => board.refresh().threads.find((x) => x.id === slug)!,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

/** The ordinary sequence: asked, woken by a finished build, finished the rest, signed off done. */
async function askedThenDone() {
  const w = world()
  w.user(0, "move the settings into a real store")
  w.say(1, `One call to make first.\n\n${choice("store")}`)
  await w.tick(2)
  w.user(3, wake(shellDoneMessage({ taskId: "bzvt", label: "the migration", status: "completed" })))
  w.say(4, `Everything else is in.\n\n${done}`)
  await w.tick(5)
  return w
}

// ── One paragraph, two refusals ─────────────────────────────────────────────────────────────────────

// `cc-worker/lib/frizz-tools.mjs` ships to a worker as plain .mjs and imports nothing but node, so it
// cannot read @frizz/shared: the paragraph lives in both, and this is what keeps them one paragraph.
test("`frizzctl done`'s refusal and the done fence's correction say the same thing about an open question", () => {
  const cases = [
    [{ id: "store", question: "SQLite or a JSON file?" }],
    [{ id: "store", question: "SQLite or a JSON file?" }, { id: "qst_aaaaaaaaaaaa", question: "Which npm scope?\nThe second line never shows." }],
    [{ id: "empty", question: "" }],
  ]
  for (const questions of cases) {
    assert.equal(cliDoneOpenQuestionsRefusal(questions), doneOpenQuestionsRefusal(questions))
    assert.ok(doneOverOpenQuestionsBody(questions).includes(doneOpenQuestionsRefusal(questions)), "the correction carries the shared paragraph whole")
  }
  assert.equal(
    doneOpenQuestionsRefusal(cases[0]),
    "1 question the human has not answered:\n  store  SQLite or a JSON file?\n" +
    "Each one dies unread with a done card. Decide it yourself and withdraw it (`frizzctl unask <id>`), or leave it open and keep working until it is answered.",
  )
  assert.equal(isParkCorrection(`${DONE_FENCE_CORRECTION_LEAD}closed a rest`), true, "folded out of the chat like every other fence correction")
})

// ── The gate, on the fence ──────────────────────────────────────────────────────────────────────────

test("a ```done fence over an open question draws ONE correction, naming the question by the worker's id", async () => {
  const w = await askedThenDone()
  try {
    assert.deepEqual(w.deliveries(), [DONE_OVER(4)])
    assert.equal(w.sent.length, 1)
    // The whole message, as the worker reads it (the clock line and the delivery token follow it).
    assert.equal(w.sent[0].split("\n\n⏱")[0], [
      "⚠️ Your ```done fence closed a rest while a question of this thread is still open, so the human is shown a finished thread and an unanswered question at once, and archiving on the done card ends the question unread.",
      "",
      "1 question the human has not answered:",
      "  store  SQLite or a JSON file?",
      "Each one dies unread with a done card. Decide it yourself and withdraw it (`frizzctl unask <id>`), or leave it open and keep working until it is answered.",
      "",
      "Your next message is the rest that counts, and it takes one of two shapes:",
      "",
      "- You withdrew it: sign off done again, and it stands.",
      "- You still need the answer: write no ```done fence. Sign off with the whole handoff instead, the question named by a ```question fence carrying its `id:` alone under the paragraph it belongs to, which keeps the thread in the human's queue on it, and sign off done once it is answered.",
    ].join("\n"))
    assert.equal(w.bumps(), 1, "counted against the corrective cap")
    // What the board says is what it said before: the question first, the done fence still on the row.
    const t = w.view()
    assert.deepEqual(t.questions.map((q) => [q.spec.handle, q.standing]), [["store", true]])
    assert.equal(t.lastFence?.kind, "done")
    assert.equal(t.needsYou, true)
    assert.equal(needsAction(t), true)
    // Once per rest, however many ticks pass before the worker answers it.
    await w.tick(6)
    await w.tick(7)
    assert.deepEqual(w.deliveries(), [DONE_OVER(4)])
    assert.equal(w.bumps(), 1)
  } finally { w.close() }
})

// The page is not to change: the correction is Frizz talking to the worker about its own sign-off, so it
// is no message in the chat, and — unlike a refused park — the fence it is about keeps its card.
test("the delivered correction is not a message in the transcript, and the done card it answers still draws", async () => {
  const w = await askedThenDone()
  try {
    const signedOff = `Everything else is in.\n\n${done}`
    const msgs = parseTranscript([
      JSON.stringify({ type: "user", timestamp: at(0), message: { content: "move the settings into a real store" } }),
      JSON.stringify({ type: "assistant", timestamp: at(4), message: { id: "m1", content: [{ type: "text", text: signedOff }] } }),
      // Exactly what the scheduler sent, token and all.
      JSON.stringify({ type: "user", timestamp: at(5.5), message: { content: w.sent[0] } }),
    ].join("\n"))
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"], "the correction's record is dropped whole")
    assert.equal(msgs[1].text, signedOff)
    assert.equal(msgs[1].fenceRefused, undefined, "the done fence is not marked refused: its card is drawn as before")
  } finally { w.close() }
})

test("way out one: the worker withdraws the question and signs off done again, and the done stands", async () => {
  const w = await askedThenDone()
  try {
    w.user(5.5, w.sent[0])
    // `frizzctl unask store`, then the same sign-off.
    const [q] = w.storage.listThreadQuestions("t")
    assert.equal(w.storage.withdrawThreadQuestion("t", q.id, Date.parse(at(5.8))), true)
    w.say(6, `Went with SQLite; withdrew the question.\n\n${done}`)
    await w.tick(7)
    await w.tick(8)
    assert.deepEqual(w.deliveries(), [DONE_OVER(4)], "no second correction, no nudge")
    const t = w.view()
    assert.deepEqual(t.questions, [])
    assert.equal(t.lastFence?.kind, "done")
    assert.equal(needsAction(t), false, "a done handoff, not an ask")
  } finally { w.close() }
})

test("way out two: the worker drops the done and rests on the question, which holds the thread", async () => {
  // As the correction says: no done fence, and a reference to end on.
  const referenced = await askedThenDone()
  try {
    referenced.user(5.5, referenced.sent[0])
    referenced.say(6, `Everything else is in; the store is the one open call.\n\n${fence("question", "id: store")}`)
    await referenced.tick(7)
    await referenced.tick(8)
    assert.deepEqual(referenced.deliveries(), [DONE_OVER(4)], "no second correction, and no sign-off nudge for the fenceless rest")
    const t = referenced.view()
    assert.deepEqual(t.questions.map((q) => [q.spec.handle, q.standing]), [["store", true]])
    assert.equal(t.lastFence, undefined)
    assert.equal(t.needsYou, true)
    assert.equal(needsAction(t), true, "queued as the ask it is")
  } finally { referenced.close() }
  // A worker that drops the done and says nothing else is still covered while the question STANDS…
  const bare = await askedThenDone()
  try {
    bare.user(5.5, bare.sent[0])
    bare.say(6, "Everything else is in; waiting on the store call.")
    await bare.tick(7)
    assert.deepEqual(bare.deliveries(), [DONE_OVER(4)], "a standing question signs the bare rest off")
    assert.equal(needsAction(bare.view()), true)
  } finally { bare.close() }
})

// …and the reference is what covers it once the question has FADED, which is why the correction asks for
// one either way: a bare rest behind a faded question is nudged, a second correction for obeying the first.
test("a question the human typed past blocks the done fence too, and its reference is what the next rest needs", async () => {
  const w = world()
  try {
    w.user(0, "move the settings into a real store")
    w.say(1, `One call to make first.\n\n${choice("store")}`)
    await w.tick(2)
    w.user(3, "leave that for now and finish the migration")
    w.say(4, `Migration finished.\n\n${done}`)
    await w.tick(5)
    assert.deepEqual(w.view().questions.map((q) => q.standing), [false], "faded: the human typed past it")
    assert.deepEqual(w.deliveries(), [DONE_OVER(4)], "and it blocks the sign-off all the same, as it blocks `frizzctl done`")
    assert.match(w.sent[0], /\n {2}store {2}SQLite or a JSON file\?\n/)
    w.user(5.5, w.sent[0])
    w.say(6, `Migration finished; the store is still an open call.\n\n${fence("question", "id: store")}`)
    await w.tick(7)
    assert.deepEqual(w.deliveries(), [DONE_OVER(4)], "the reference makes it stand again: no nudge")
    assert.deepEqual(w.view().questions.map((q) => q.standing), [true])
  } finally { w.close() }
  // The negative control for that last step: the same rest without the reference is a bare one.
  const bare = world()
  try {
    bare.user(0, "move the settings into a real store")
    bare.say(1, `One call to make first.\n\n${choice("store")}`)
    await bare.tick(2)
    bare.user(3, "leave that for now and finish the migration")
    bare.say(4, `Migration finished.\n\n${done}`)
    await bare.tick(5)
    bare.user(5.5, bare.sent[0])
    bare.say(6, "Migration finished; the store is still an open call.")
    await bare.tick(7)
    assert.deepEqual(bare.deliveries(), [DONE_OVER(4), `signoff:${at(6)}`])
  } finally { bare.close() }
})

test("a ```done fence in the same message as a new question is the same correction", async () => {
  const w = world()
  try {
    w.user(0, "move the settings into a real store")
    w.say(1, `All in, bar one call.\n\n${choice("store")}\n\n${done}`)
    await w.tick(2)
    assert.deepEqual(w.deliveries(), [DONE_OVER(1)])
    assert.ok(w.sent[0].startsWith(DONE_FENCE_CORRECTION_LEAD))
    assert.match(w.sent[0], /\n {2}store {2}SQLite or a JSON file\?\n/)
    assert.deepEqual(w.view().questions.map((q) => [q.spec.handle, q.standing]), [["store", true]], "the question registered and is what the board shows")
  } finally { w.close() }
})

test("several open questions are each named, and a question asked by `frizzctl ask` goes by the id Frizz minted", async () => {
  const w = world()
  try {
    w.storage.askThreadQuestion({ id: "qst_aaaaaaaaaaaa", slug: "t", spec: JSON.stringify({ question: "Which npm scope?", kind: "question", options: [{ label: "@frizz" }, { label: "@frizzhq" }] }), askedAtMs: Date.parse(at(0.5)) })
    w.user(0, "publish the packages")
    w.say(1, `Two calls.\n\n${choice("store")}\n\n${done}`)
    await w.tick(2)
    assert.match(w.sent[0], /closed a rest while questions of this thread are still open/)
    assert.match(w.sent[0], /2 questions the human has not answered:\n {2}qst_aaaaaaaaaaaa {2}Which npm scope\?\n {2}store {2}SQLite or a JSON file\?\n/)
    assert.match(w.sent[0], /- You withdrew every one: sign off done again/)
  } finally { w.close() }
})

test("a worker that ignores the correction is capped, and the board keeps showing the question first", async () => {
  const w = world()
  try {
    w.user(0, "move the settings into a real store")
    w.say(1, `One call to make first.\n\n${choice("store")}`)
    await w.tick(1.5)
    for (let minute = 2; minute <= 9; minute++) {
      w.say(minute, `Everything is in.\n\n${done}`)
      await w.tick(minute + 0.25)
      // The delivered correction lands as a user record, which closes the rest; the worker signs off again.
      w.user(minute + 0.5, w.sent[w.sent.length - 1] ?? "steer")
    }
    assert.equal(w.deliveries().length, 3, `capped at PARK_BUMP_MAX — got ${w.deliveries().length} over eight identical rests`)
    assert.ok(w.deliveries().every((id) => id.startsWith("park:done-open-question:")))
    w.say(10, `Everything is in.\n\n${done}`)
    await w.tick(11)
    const t = w.view()
    assert.deepEqual(t.questions.map((q) => q.standing), [true])
    assert.equal(needsAction(t), true, "silence from Frizz, and the row is still the question's")
    assert.equal(t.lastFence?.kind, "done")
  } finally { w.close() }
})

// The shared count comes back whenever a ```question fence registers. A worker that answers each
// correction with a NEW question and another done fence would therefore reset its own cap on every rest.
test("asking a new question beside every done fence does not reset the cap on this correction", async () => {
  const w = world()
  try {
    w.user(0, "move the settings into a real store")
    for (let minute = 1; minute <= 8; minute++) {
      w.say(minute, `One more call.\n\n${choice(`call-${minute}`, `Call ${minute}?`)}\n\n${done}`)
      await w.tick(minute + 0.25)
      w.user(minute + 0.5, w.sent[w.sent.length - 1] ?? "steer")
    }
    assert.equal(w.deliveries().length, 3, `three since the human last typed — got ${w.deliveries().length} over eight rests`)
    // The human typing is what hands it back: they have seen the thread.
    w.user(20, "what is going on here?")
    w.say(21, `Still one call.\n\n${done}`)
    await w.tick(22)
    assert.equal(w.deliveries().length, 4)
  } finally { w.close() }
})

// The outbox holds a wake for five minutes after the thread's last one, so a burst costs one turn. This
// correction's usual rest is a minute or two after the wake that let the worker finish, and what it is
// racing is the human archiving on the done card.
test("the correction is not held behind the quiet window of the wake before it", async () => {
  const w = world({}, { quietWindowMs: 5 * 60_000 })
  try {
    w.user(0, "move the settings into a real store")
    // A bare rest, so the scheduler hands the thread a wake of its own (the sign-off reminder).
    w.say(1, "Reading the settings layer.")
    await w.tick(1.25)
    assert.deepEqual(w.deliveries(), [`signoff:${at(1)}`])
    assert.equal(w.sent.length, 1)
    w.user(1.5, w.sent[0])
    w.say(2, `All in, bar one call.\n\n${choice("store")}\n\n${done}`)
    await w.tick(2.25)
    assert.equal(w.sent.length, 2, "sent 45s after the last wake, not five minutes after it")
    assert.ok(w.sent[1].startsWith(DONE_FENCE_CORRECTION_LEAD))
  } finally { w.close() }
})

// The same holds for the two counted corrections the exemption list had missed: a ```question fence that
// could not register (measured held for 5m 15s) and a park with no `status:`. The control is a wake the
// window is FOR: a timer, which is news that can wait for the turn being rationed.
test("no fence correction waits behind the quiet window, and a wake that is not one still does", async () => {
  const shapes: [string, string, string][] = [
    ["a question fence that could not register", `One call.\n\n${broken("scope")}`, `park:question-fence:${at(2)}`],
    ["a park with no status", fence("awaiting", "shells: [bzvt]\nfor: 1h"), `park:needs-input:${at(2)}`],
  ]
  for (const [name, message, fenceId] of shapes) {
    const w = world({}, { quietWindowMs: 5 * 60_000 })
    try {
      w.extra.bgShells = [{ label: "the suite", startedAt: at(0), state: "running", id: "toolu_x", taskId: "bzvt" }] as never
      w.user(0, "publish the packages")
      w.say(1, "Reading the publish script.")
      await w.tick(1.25)
      assert.equal(w.sent.length, 1, `${name}: the sign-off reminder is the wake that opens the window`)
      w.user(1.5, w.sent[0])
      w.say(2, message)
      await w.tick(2.25)
      assert.deepEqual(w.deliveries().slice(1), [fenceId], name)
      assert.equal(w.sent.length, 2, `${name}: sent on the next tick, 1m after the last wake`)
    } finally { w.close() }
  }
  const held = world({}, { quietWindowMs: 5 * 60_000 })
  try {
    held.user(0, "publish the packages")
    held.say(1, "Reading the publish script.")
    await held.tick(1.25)
    held.user(1.5, held.sent[0])
    held.say(2, `Published.\n\n${done}`)
    held.storage.armThreadTimer({ id: "tmr_aaaa", slug: "t", prompt: "check the registry", fireAtMs: Date.parse(at(2.1)), createdAtMs: Date.parse(at(2)) })
    await held.tick(2.25)
    assert.deepEqual(held.deliveries().slice(1), ["timer:tmr_aaaa"], "the timer is due and queued")
    assert.equal(held.sent.length, 1, "and held: the thread was handed a wake 1m ago")
    await held.tick(4)
    assert.equal(held.sent.length, 1, "still held at 2m 45s")
    await held.tick(6.5)
    assert.equal(held.sent.length, 2, "sent once five minutes have passed")
  } finally { held.close() }
})

// SOURCE 14 had the same hole, from the same reset: one NEW valid question beside the same broken fence at
// every rest, and the count was back at zero before each correction was counted.
test("a new valid question beside the same broken fence at every rest does not reset the cap on that correction", async () => {
  const w = world()
  try {
    w.user(0, "publish the packages")
    for (let minute = 1; minute <= 8; minute++) {
      w.say(minute, `Calls.\n\n${choice(`ok-${minute}`, `Call ${minute}?`)}\n\n${broken("scope")}`)
      await w.tick(minute + 0.25)
      w.user(minute + 0.5, w.sent[w.sent.length - 1] ?? "steer")
    }
    assert.equal(w.deliveries().length, 3, `three since the human last typed — got ${w.deliveries().length} over eight rests`)
    assert.ok(w.deliveries().every((id) => id.startsWith("park:question-fence:")))
    assert.equal(w.storage.listThreadQuestions("t").filter((q) => q.state === "open").length, 8, "every valid question still registered")
    assert.deepEqual(w.deliveries().filter((id) => id.startsWith("signoff:")), [], "and the silenced rests are not nudged instead")
    // The human typing is what hands it back.
    w.user(20, "what is going on with the scope question?")
    w.say(21, `Still one call.\n\n${broken("scope")}`)
    await w.tick(22)
    assert.equal(w.deliveries().length, 4)
  } finally { w.close() }
})

// One budget per cause: the two are different mistakes, and a thread that has used up its corrections for
// one has been told nothing about the other.
test("three done-fence corrections do not use up the question fence's budget, nor the other way round", async () => {
  const doneFirst = world()
  try {
    doneFirst.user(0, "move the settings into a real store")
    for (let minute = 1; minute <= 4; minute++) {
      doneFirst.say(minute, `One more call.\n\n${choice(`call-${minute}`, `Call ${minute}?`)}\n\n${done}`)
      await doneFirst.tick(minute + 0.25)
      doneFirst.user(minute + 0.5, doneFirst.sent[doneFirst.sent.length - 1] ?? "steer")
    }
    assert.equal(doneFirst.deliveries().length, 3, "the done fence's three are spent")
    // A new question registers beside the broken one, so the shared count is at zero: only the
    // per-cause budget decides.
    doneFirst.say(5, `Two more.\n\n${choice("call-5", "Call 5?")}\n\n${broken("scope")}`)
    await doneFirst.tick(5.25)
    assert.deepEqual(doneFirst.deliveries().slice(3), [`park:question-fence:${at(5)}`])
  } finally { doneFirst.close() }
  const fenceFirst = world()
  try {
    fenceFirst.user(0, "publish the packages")
    for (let minute = 1; minute <= 4; minute++) {
      fenceFirst.say(minute, `Calls.\n\n${choice(`ok-${minute}`, `Call ${minute}?`)}\n\n${broken("scope")}`)
      await fenceFirst.tick(minute + 0.25)
      fenceFirst.user(minute + 0.5, fenceFirst.sent[fenceFirst.sent.length - 1] ?? "steer")
    }
    assert.equal(fenceFirst.deliveries().length, 3, "the question fence's three are spent")
    fenceFirst.say(5, `All in.\n\n${choice("ok-5", "Call 5?")}\n\n${done}`)
    await fenceFirst.tick(5.25)
    assert.deepEqual(fenceFirst.deliveries().slice(3), [DONE_OVER(5)])
  } finally { fenceFirst.close() }
})

// ── One rest, one message ───────────────────────────────────────────────────────────────────────────

test("a done fence over an open question beside a question fence that could not register is ONE correction", async () => {
  const w = world()
  try {
    w.user(0, "publish the packages")
    w.say(1, `Two calls, then done.\n\n${choice("store")}\n\n${broken("scope")}\n\n${done}`)
    await w.tick(2)
    await w.tick(3)
    assert.deepEqual(w.deliveries(), [`park:question-fence:${at(1)}`], "one delivery: no second correction, no nudge")
    assert.equal(w.sent.length, 1)
    assert.ok(w.sent[0].startsWith(QUESTION_FENCE_CORRECTION_LEAD))
    assert.match(w.sent[0], /`scope` — `kind: choice` needs two or more options/)
    assert.match(w.sent[0], /\n\nSeparately, your ```done fence closed a rest while a question of this thread is still open/)
    assert.ok(!w.sent[0].includes(QUESTION_FENCE_UNDER_DONE_HINT), "the second paragraph already says it; the one-sentence hint is for the rest with nothing open")
    assert.match(w.sent[0], /\n {2}store {2}SQLite or a JSON file\?\n/)
    assert.equal(w.bumps(), 1, "one message, one bump")
  } finally { w.close() }
})

// Nothing is open yet, so the done fence is not wrong — and it is about to be: the worker's fix is the same
// message with the fence repaired, and a done fence under a question that now registers is SOURCE 15's
// case at the very next rest. One sentence in SOURCE 14's message saves that second correction.
test("a broken question fence under a closing done fence, with nothing open: the correction says the done cannot stay", async () => {
  const w = world()
  try {
    w.user(0, "publish the packages")
    w.say(1, `One call, then done.\n\n${broken("scope")}\n\n${done}`)
    await w.tick(2)
    assert.deepEqual(w.deliveries(), [`park:question-fence:${at(1)}`])
    assert.equal(w.sent[0].split("\n\n⏱")[0], `${QUESTION_FENCE_CORRECTION("scope")}\n\n${QUESTION_FENCE_UNDER_DONE_HINT}`)
    assert.equal(
      QUESTION_FENCE_UNDER_DONE_HINT,
      "This rest also closed on a ```done fence, and a done fence cannot stand beside a question once it registers: the message that carries the fixed fence carries no ```done fence, and the sign-off as done comes once the question is answered.",
    )
    assert.doesNotMatch(w.sent[0], /Separately, your ```done fence/, "no question is open, so there is no second paragraph")
    // The worker does what it was told: the fixed fence, no done. One correction was the whole cost.
    w.user(2.5, w.sent[0])
    w.say(3, `One call.\n\n${choice("scope", "Which npm scope?")}`)
    await w.tick(4)
    await w.tick(5)
    assert.deepEqual(w.deliveries(), [`park:question-fence:${at(1)}`])
    assert.deepEqual(w.view().questions.map((q) => [q.spec.handle, q.standing]), [["scope", true]])
  } finally { w.close() }
  // What the sentence is there to prevent: the same fix with the done fence kept is a second correction.
  const kept = world()
  try {
    kept.user(0, "publish the packages")
    kept.say(1, `One call, then done.\n\n${broken("scope")}\n\n${done}`)
    await kept.tick(2)
    kept.user(2.5, kept.sent[0])
    kept.say(3, `One call, then done.\n\n${choice("scope", "Which npm scope?")}\n\n${done}`)
    await kept.tick(4)
    assert.deepEqual(kept.deliveries(), [`park:question-fence:${at(1)}`, DONE_OVER(3)])
  } finally { kept.close() }
})

test("an answer on its way takes the rest: the done fence is judged at the worker's next sign-off", async () => {
  const w = world()
  try {
    w.user(0, "publish the packages")
    w.say(1, `Two calls.\n\n${choice("store")}\n\n${choice("scope", "Which npm scope?")}`)
    await w.tick(2)
    w.user(3, wake(shellDoneMessage({ taskId: "bzvt", label: "the build", status: "completed" })))
    w.say(4, `Built.\n\n${done}`)
    // The human answers one of the two before the scheduler next looks.
    const store = w.storage.listThreadQuestions("t").find((q) => q.handle === "store")!
    w.storage.answerThreadQuestion(store.id, JSON.stringify({ questionId: store.id, question: "SQLite or a JSON file?", chosen: ["SQLite"] }), Date.parse(at(4.5)))
    await w.tick(5)
    assert.equal(w.sent.length, 1)
    assert.match(w.sent[0], /^Answers to earlier questions:/, "the answer is the one voice at this rest")
    assert.deepEqual(w.deliveries().filter((id) => id.startsWith("park:")), [])
    // The answer lands; the worker acts on it and signs off done again with `scope` still open.
    w.user(5.5, w.sent[0])
    w.say(6, `Using SQLite.\n\n${done}`)
    await w.tick(7)
    assert.deepEqual(w.deliveries().filter((id) => id.startsWith("park:")), [DONE_OVER(6)])
    assert.match(w.sent[1], /1 question the human has not answered:\n {2}scope {2}Which npm scope\?\n/)
  } finally { w.close() }
})

/** SOURCE 14's correction for one `kind: choice` fence with no options, as it has read since it shipped. */
const QUESTION_FENCE_CORRECTION = (id: string) => [
  "⚠️ Your ```question fence could not register, so the human has NOT been asked:",
  "",
  `- \`${id}\` — \`kind: choice\` needs two or more options under \`options:\``,
  "",
  "Fix the fence and write it again in your next message; a fence that registers needs nothing else.",
  "The shape: `id:` (a slug of your own), `kind:` (`choice`, `multi`, `text` or `secret`), a one-line",
  "`question:`, and for `choice`/`multi` two or more `options:` — each `- label: …`, with optional",
  "`description:`, `recommended: true` and an indented `detail: |` block. Anything else the human needs",
  "goes below a `---` line as markdown. A fence with `id:` alone references a question you already asked.",
].join("\n")

test("a question fence correction on a rest that did not close on a done fence reads as it always has", async () => {
  for (const [name, message] of [
    ["the fence alone", `One call.\n\n${broken("scope")}`],
    ["beside a park", `One call.\n\n${broken("scope")}\n\n${fence("awaiting", "status: working\nshells: [bzvt]\nfor: 1h")}`],
    ["a done fence that does not close the message", `One call.\n\n${done}\n\n${broken("scope")}`],
  ] as const) {
    const w = world()
    try {
      w.extra.bgShells = [{ label: "the suite", startedAt: at(0), state: "running", id: "toolu_x", taskId: "bzvt" }] as never
      w.user(0, "publish the packages")
      w.say(1, message)
      await w.tick(2)
      assert.equal(w.sent[0].split("\n\n⏱")[0], QUESTION_FENCE_CORRECTION("scope"), name)
    } finally { w.close() }
  }
})

// ── An autonomous (Goal) thread ─────────────────────────────────────────────────────────────────────

// A Goal armed at rest cancels every non-secret question on the record, so the only question that can be
// open there is a secret: a value only the human holds, which the worker cannot decide by signing off.
test("on a Goal thread, a done fence over an open SECRET is corrected, and the Goal says nothing beside it", async () => {
  for (const rearmed of [false, true]) {
    const w = world()
    try {
      w.storage.setRecurringPromptBySlug("t", { prompt: "Keep going until the release is out.", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: at(0) })
      w.user(0, "go")
      w.say(1, `Need the code to publish.\n\n${fence("question", "id: npm-otp\nkind: secret\nquestion: The npm one-time code for the publish")}\n\n${done}`)
      // Re-arming after the done fence re-opens the Goal's loop, which is the one way its rest prompt
      // reaches a rest that said done. (An edit of the text: the same words keep their generation.)
      if (rearmed) w.storage.setRecurringPromptBySlug("t", { prompt: "Keep going until the release is out and announced.", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: at(1.5) })
      await w.tick(2)
      await w.tick(3)
      assert.deepEqual(w.storage.listThreadQuestions("t").map((q) => [q.handle, q.state]), [["npm-otp", "open"]])
      assert.deepEqual(w.deliveries(), [DONE_OVER(1)], `rearmed=${rearmed}: the correction alone — no Goal prompt in the same rest`)
      assert.match(w.sent[0], /\n {2}npm-otp {2}The npm one-time code for the publish\n/)
    } finally { w.close() }
  }
})

test("on a Goal thread, a non-secret question is cancelled, so the done fence beside it has nothing open under it", async () => {
  const w = world()
  try {
    w.storage.setRecurringPromptBySlug("t", { prompt: "Keep going until the suite is green.", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: at(0) })
    w.user(0, "go")
    w.say(1, `All in, bar one call.\n\n${choice("store")}\n\n${done}`)
    await w.tick(2)
    await w.tick(3)
    assert.deepEqual(w.storage.listThreadQuestions("t").map((q) => [q.handle, q.state]), [["store", "dismissed"]])
    assert.deepEqual(w.deliveries().filter((id) => id.startsWith("park:")), [], "no correction: the cancellation wake is what this rest gets")
    assert.equal(w.sent.length, 1)
    assert.match(w.sent[0], /^1 question you registered was CANCELLED without an answer/)
  } finally { w.close() }
})

// ── Negative controls ───────────────────────────────────────────────────────────────────────────────

test("a done fence with no open question draws nothing", async () => {
  const w = world()
  try {
    w.user(0, "move the settings into a real store")
    w.say(1, `All in.\n\n${done}`)
    await w.tick(2)
    await w.tick(3)
    assert.deepEqual(w.deliveries(), [])
    assert.deepEqual(w.sent, [])
  } finally { w.close() }
})

test("a done fence beside a question that was answered draws nothing", async () => {
  const w = world()
  try {
    w.user(0, "move the settings into a real store")
    w.say(1, `One call to make first.\n\n${choice("store")}`)
    await w.tick(2)
    const [q] = w.storage.listThreadQuestions("t")
    w.storage.answerThreadQuestion(q.id, JSON.stringify({ questionId: q.id, question: "SQLite or a JSON file?", chosen: ["SQLite"] }), Date.parse(at(3)))
    await w.tick(3.5)
    w.user(4, w.sent[0])
    // Restated beside the done fence, even: the question is settled, so nothing is open under it.
    w.say(5, `Using SQLite, as answered.\n\n${fence("question", "id: store")}\n\n${done}`)
    await w.tick(6)
    await w.tick(7)
    assert.deepEqual(w.deliveries().filter((id) => id.startsWith("park:") || id.startsWith("signoff:")), [])
    assert.equal(w.sent.length, 1, "the answer's own wake and nothing after it")
  } finally { w.close() }
})

test("a thread dispatched before the question-fence cutover is not held to the gate", async () => {
  // The same rows and the same rest on both sides of the cutover: only the dispatch instant differs.
  for (const [spawnedAt, corrected] of [["2026-09-01T00:00:00.000Z", false], ["2026-10-15T00:00:00.000Z", true]] as const) {
    const w = world({ spawned_at: spawnedAt })
    try {
      w.storage.askThreadQuestion({ id: "qst_aaaaaaaaaaaa", slug: "t", spec: JSON.stringify({ question: "SQLite or a JSON file?", kind: "question", options: [{ label: "SQLite" }, { label: "JSON file" }] }), askedAtMs: Date.parse(at(0.5)) })
      w.user(0, "move the settings into a real store")
      w.say(1, `All in.\n\n${done}`)
      await w.tick(2)
      assert.deepEqual(w.deliveries(), corrected ? [DONE_OVER(1)] : [], `spawned ${spawnedAt}`)
    } finally { w.close() }
  }
})

test("a done fence written before registration began is not corrected after the fact", async () => {
  // The thread has rested on its done card since before the gate existed; a refold must not wake it.
  const before = (minute: number) => new Date(Date.parse("2026-10-13T19:00:00.000Z") + minute * 60_000).toISOString()
  const w = world()
  try {
    w.storage.askThreadQuestion({ id: "qst_aaaaaaaaaaaa", slug: "t", spec: JSON.stringify({ question: "SQLite or a JSON file?", kind: "question", options: [{ label: "SQLite" }, { label: "JSON file" }] }), askedAtMs: Date.parse(before(0)) })
    applyRecord(w.fold, { type: "user", timestamp: before(1), message: { role: "user", content: "go" } } as never)
    applyRecord(w.fold, { type: "assistant", timestamp: before(2), message: { role: "assistant", content: [{ type: "text", text: `All in.\n\n${done}` }], stop_reason: "end_turn" } } as never)
    await w.tick(5)
    assert.deepEqual(w.deliveries(), [])
  } finally { w.close() }
})

test("a done fence that does not close the message is not a sign-off, so there is nothing to correct", async () => {
  const w = world()
  try {
    w.user(0, "move the settings into a real store")
    // The question fence is the last thing in the message: Frizz reads no done fence here at all.
    w.say(1, `All in, bar one call.\n\n${done}\n\n${choice("store")}`)
    await w.tick(2)
    assert.equal(w.view().lastFence, undefined)
    assert.deepEqual(w.deliveries(), [])
  } finally { w.close() }
})

// The fault can end without the worker: the human closes a question from its card, and a press of the ×
// is no record in the transcript. A correction still waiting to go out must not then be delivered.
test("a correction still in the outbox dies when the human closes the question first", async () => {
  for (const dismissed of [true, false]) {
    const w = await askedThenDone()
    try {
      assert.equal(w.sent.length, 1)
      // Put the delivered correction back as if it had never gone out.
      w.storage.db.prepare("UPDATE wake_delivery SET state = 'pending', delivered_at = NULL, terminal_at = NULL, sent_at = NULL, attempts = 0 WHERE fence_id = ?").run(DONE_OVER(4))
      const [q] = w.storage.listThreadQuestions("t")
      if (dismissed) w.storage.dismissThreadQuestion(q.id, Date.parse(at(5.5)))
      await w.tick(6)
      assert.equal(w.sent.length, dismissed ? 1 : 2, dismissed ? "superseded, not sent" : "control: with the question still open it goes out")
    } finally { w.close() }
  }
})

// ── What a rest costs once the cap is in play ───────────────────────────────────────────────────────

// A worker that keeps writing the same broken ```question fence, alone. Three corrections spend the cap;
// the sign-off reminder then took the rest the cap had silenced and told the worker, twice, "You rested
// without a fence" — of a message that was a fence. Five wakes for three, the last two false.
test("once the cap is spent, a rest whose question fence failed is not nudged for resting without a fence", async () => {
  const w = world()
  try {
    w.user(0, "publish the packages")
    for (let minute = 1; minute <= 7; minute++) {
      w.say(minute, `Need a call.\n\n${broken("scope")}`)
      await w.tick(minute + 0.25)
      w.user(minute + 0.5, w.sent[w.sent.length - 1] ?? "steer")
    }
    assert.deepEqual(w.deliveries().map((id) => id.split(":").slice(0, 2).join(":")), ["park:question-fence", "park:question-fence", "park:question-fence"], "three corrections and then silence")
    assert.equal(w.storage.getSession("t")?.signoff_nudges ?? 0, 0)
    // The reminder is not switched off for the thread: a rest that really is bare still draws it.
    w.user(20, "forget the scope question")
    w.say(21, "Dropped it.")
    await w.tick(22)
    assert.deepEqual(w.deliveries().slice(3), [`signoff:${at(21)}`])
  } finally { w.close() }
})

// A broken ```question fence beside an ```awaiting fence naming a dead shell: two things wrong with one
// rest, two corrections (SOURCE 14's and SOURCE 12's, delivered as one message), and until 2026-10-13 two
// of the three bumps.
test("one rest spends one bump, however many of its fences are corrected", async () => {
  const w = world()
  try {
    w.user(0, "publish the packages")
    for (let minute = 1; minute <= 4; minute++) {
      w.say(minute, `Need a call.\n\n${broken("scope")}\n\n${fence("awaiting", "status: working\nshells: [bghost]\nfor: 1h")}`)
      await w.tick(minute + 0.25)
      if (minute <= 3) {
        assert.equal(w.bumps(), minute, `rest ${minute}: one bump`)
        assert.deepEqual(w.deliveries().slice(-2), [`park:question-fence:${at(minute)}`, `park:dead:${at(minute)}`], `rest ${minute}: both corrections, the last rest under the cap included`)
        assert.match(w.sent[w.sent.length - 1], /^Frizz held 2 wakes/)
      }
      w.user(minute + 0.5, w.sent[w.sent.length - 1])
    }
    assert.equal(w.deliveries().length, 6, "the fourth rest is past the cap for both")
    assert.equal(w.bumps(), 3)
  } finally { w.close() }
})

test("two rests with one fault each still spend two bumps", async () => {
  const w = world()
  try {
    w.user(0, "publish the packages")
    w.say(1, `Need a call.\n\n${broken("scope")}`)
    await w.tick(1.25)
    w.user(1.5, w.sent[0])
    w.say(2, fence("awaiting", "status: working\nshells: [bghost]\nfor: 1h"))
    await w.tick(2.25)
    assert.deepEqual(w.deliveries(), [`park:question-fence:${at(1)}`, `park:dead:${at(2)}`])
    assert.equal(w.bumps(), 2)
  } finally { w.close() }
})

// Kept honest by its neighbour: the Goal's prompt is what a Goal thread's bare rest draws.
test("control: the Goal thread harness does deliver a rest prompt when nothing else takes the rest", async () => {
  const w = world()
  try {
    w.storage.setRecurringPromptBySlug("t", { prompt: "Keep going until the release is out.", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: at(0) })
    w.storage.setSetting("signoffNudge", "off")
    w.user(0, "go")
    w.say(1, "Carrying on.")
    await w.tick(2)
    assert.equal(w.sent.length, 1)
    assert.ok(w.sent[0].startsWith(restPromptMessage("Keep going until the release is out.").split("\n")[0]))
  } finally { w.close() }
})

// ── The human typing hands the corrective allowance back ─────────────────────────────────────────────

// Driven through a real broker first (verify-question-fence-wakes, case L): a worker that answers every
// correction with the same fence gets three, then silence, as intended — and stayed silenced for the life
// of the thread, whatever the human then said to it. The count came back only for an honoured park or a
// question that registered. A message the human types is the third thing Frizz cannot cause by correcting.
type World = ReturnType<typeof world>
/** The worker rests on `message`; whatever Frizz sends for that rest lands as the next user record. */
async function restOn(w: World, minute: number, message: string): Promise<boolean> {
  const before = w.sent.length
  w.say(minute, message)
  await w.tick(minute + 0.25)
  if (w.sent.length === before) return false
  w.user(minute + 0.5, w.sent[w.sent.length - 1])
  return true
}

const CAPPED_SHAPES: { name: string; cause: string; setup?: (w: World) => Promise<void>; message: string }[] = [
  { name: "a question fence that cannot register", cause: "park:question-fence:", message: `Need a call.\n\n${fence("question", "id: scope\nquestion: Which npm scope?")}` },
  {
    name: "a done fence over an open question", cause: "park:done-open-question:", message: `Everything is in.\n\n${done}`,
    setup: async (w) => { w.say(0.5, `One call to make first.\n\n${choice("store")}`); await w.tick(0.75) },
  },
  { name: "a park naming a dead shell", cause: "park:dead:", message: fence("awaiting", "status: working\nshells: [bghost]\nfor: 1h") },
]

test("a worker that has used up its corrections is corrected again once the human has typed, and the count runs to three again", async () => {
  for (const shape of CAPPED_SHAPES) {
    const w = world()
    try {
      w.user(0, "publish the packages")
      await shape.setup?.(w)
      // Three rests, three corrections; each correction is itself a user record, and hands nothing back.
      for (const minute of [1, 2, 3]) assert.equal(await restOn(w, minute, shape.message), true, `${shape.name}: rest ${minute} is corrected`)
      assert.equal(w.bumps(), 3)
      // The fourth identical rest is the silence the cap is for…
      assert.equal(await restOn(w, 4, shape.message), false, `${shape.name}: the fourth rest draws nothing`)
      // …and nothing that is not the human typing ends it: a wake, Retry's fixed sentence, answers sent
      // from the prompt box with nothing typed beside them.
      const notTheHuman: [string, string][] = [
        ["a timer wake", wake(timerPromptMessage("check the registry", at(5)), "tmr")],
        ["Retry", RETRY_FOLLOW_UP],
        ["answers sent with nothing typed", questionAnswerMessage([{ questionId: "qst_aaaaaaaaaaaa", question: "Which registry?", chosen: ["npm"] }])],
      ]
      for (const [i, [what, text]] of notTheHuman.entries()) {
        w.user(5 + i, text)
        assert.equal(await restOn(w, 5.5 + i, shape.message), false, `${shape.name}: ${what} hands nothing back`)
        assert.equal(w.bumps(), 3, `${shape.name}: ${what} leaves the count where it was`)
      }
      assert.equal(w.deliveries().filter((id) => id.startsWith(shape.cause)).length, 3)
      // The human types. They have seen the thread: what the worker does next is a new attempt.
      w.user(10, "any progress on this?")
      assert.equal(await restOn(w, 11, shape.message), true, `${shape.name}: the same mistake after the human typed is corrected`)
      assert.equal(w.bumps(), 1, `${shape.name}: counted from zero`)
      assert.equal(await restOn(w, 12, shape.message), true)
      assert.equal(await restOn(w, 13, shape.message), true)
      assert.equal(await restOn(w, 14, shape.message), false, `${shape.name}: and three more is the cap again`)
      assert.equal(w.deliveries().filter((id) => id.startsWith(shape.cause)).length, 6)
      assert.equal(w.bumps(), 3)
      assert.deepEqual(w.deliveries().filter((id) => !id.startsWith(shape.cause)), [], `${shape.name}: nothing else was sent in its place`)
    } finally { w.close() }
  }
})

// A count written before 2026-10-13 is anchored on the correction's fence id, `park:<cause>:<rest>`, not
// on the rest. The rest is read out of it, so a thread already stuck at the cap comes back too. Anything
// else an anchor might hold never matches and breaks nothing.
test("an anchor written by the older code hands the allowance back too; one that is no instant never does", async () => {
  const park = fence("awaiting", "status: working\nshells: [bghost]\nfor: 1h")
  for (const [anchor, comesBack] of [[`park:dead:${at(0.5)}`, true], ["d1", false], [`park:dead:not-an-instant`, false]] as const) {
    const w = world()
    try {
      w.user(0, "publish the packages")
      w.storage.db.prepare("UPDATE session SET park_bumps = 3, park_bump_anchor = ? WHERE slug = 't'").run(anchor)
      assert.equal(await restOn(w, 1, park), false, `${anchor}: capped, and the human has not typed since`)
      w.user(2, "any progress on this?")
      assert.equal(await restOn(w, 3, park), comesBack, anchor)
      assert.equal(w.bumps(), comesBack ? 1 : 3)
      assert.deepEqual(w.logs.filter((line) => /pass failed/.test(line)), [], `${anchor}: no pass threw`)
    } finally { w.close() }
  }
})

// THE SIGN-OFF REMINDER'S OWN CAP IS A DIFFERENT COUNT WITH A RECORDED DECISION BEHIND IT (scheduler
// SOURCE 9, "ONLY A FENCE GIVES THE ALLOWANCE BACK"), and the change above deliberately leaves it alone.
// Pinned here beside the corrective cap so the two are not made to match by accident.
test("the sign-off reminder's cap still comes back only on a sign-off, not when the human types", async () => {
  const w = world()
  try {
    w.user(0, "publish the packages")
    assert.equal(await restOn(w, 1, "Reading the publish script."), true)
    assert.equal(await restOn(w, 2, "Still reading."), true)
    assert.equal(await restOn(w, 3, "Nearly there."), false, "two reminders, then none")
    w.user(10, "any progress on this?")
    assert.equal(await restOn(w, 11, "Some."), false, "the human typing does not hand the reminder back")
    assert.equal(w.storage.getSession("t")?.signoff_nudges, 2)
    // A sign-off does.
    w.user(12, "go on")
    assert.equal(await restOn(w, 13, `Published.\n\n${done}`), false)
    assert.equal(w.storage.getSession("t")?.signoff_nudges, 0)
  } finally { w.close() }
})
