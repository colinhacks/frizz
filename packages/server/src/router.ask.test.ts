// THE QUESTION REGISTRY at the RPC boundary — the real router against real SQLite.
//
// `mcp__frizz__ask` registers a question the human owes an answer to, so that asking stops being a
// fenced block with the lifetime of the message carrying it (plans/rest-by-registration.md). The
// tailer recomputes `pendingQuestion` from the LATEST assistant text on every assistant record
// (`lastAssistantHasQuestion = hasQuestionBlock(raw)` — an assignment, not an OR) and clears it on any
// human turn, so a worker that asks and then says one more sentence has silently un-asked. A row does
// not do that, and these tests are about the ways a question could still go missing.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { execFile } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AskedQuestion, BoardSnapshot, Settings } from "@frizz/shared"
import { AnswerQuestionsInput, AskInput, BURIED_ANSWERS_HEADER, parseQuestionsCancelledWake, questionAnswerMessage, questionsCancelledWakeMessage, secretAnswerText } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-ask-rpc-"))
  const project: Project = { dir, id: "ask", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0, deltasSince: () => null, snapshotState: async () => ({ board: ({}) as never, seq: 0 }),
    rebuild: async () => snapshot,
    refresh: () => { refreshes++; return snapshot },
    start: async () => {},
    stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => undefined, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  // The scheduler stub COUNTS kicks rather than ignoring them: answering must run the delivery sweep
  // immediately, because the human is sitting right there and the next scheduled pass is up to a whole
  // tick away — five seconds in which the question card is gone and the answer has not arrived.
  let kicks = 0
  const scheduler = { start: () => {}, stop: async () => {}, tick: async () => {}, kick: () => { kicks++ } }
  const ctx = {
    project, storage, board, tailer, scheduler,
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
  } as unknown as AppContext
  return {
    storage,
    stateDir: dir,
    router: createRouter(ctx),
    refreshes: () => refreshes,
    kicks: () => kicks,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-08-26T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

const simple = (question = "SQLite or a JSON file?"): AskedQuestion => ({
  question,
  kind: "question",
  options: [
    { label: "SQLite — transactional, matches how sessions are already stored", recommended: true },
    { label: "JSON file — zero deps, human-editable, racy under concurrent writes" },
  ],
})

test("ask registers a question, mints its id, and reads back the whole open set", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const result = await h.router.ask.handler({ input: { slug: "t", questions: [simple()] } })
    assert.equal(result.registered.length, 1)
    assert.match(result.registered[0].id, /^qst_[0-9a-f]{12}$/)
    // THE WORKER NEVER CHOSE THE ID — frizz minted it — which is exactly why the answer restates the
    // question text later on: an id alone cannot be correlated back to anything the worker wrote.
    assert.deepEqual(result.open.map((q) => q.id), [result.registered[0].id])
    assert.deepEqual(result.open[0].spec, simple())
    assert.equal(h.refreshes() > 0, true, "the board must re-derive: an open question is a queue member")
  } finally { h.close() }
})

test("registering the same question twice is TWO questions, unlike a watch", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.ask.handler({ input: { slug: "t", questions: [simple()] } })
    const again = await h.router.ask.handler({ input: { slug: "t", questions: [simple()] } })
    // Two identically-worded questions are two things the human owes an answer to. Collapsing them the
    // way an idempotent watch collapses a re-registration would silently drop one.
    assert.equal(again.open.length, 2)
    assert.notEqual(again.open[0].id, again.open[1].id)
  } finally { h.close() }
})

test("a malformed tree is REFUSED with the fault named, and nothing is stored", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    // A `multi` with no options renders as a plain free-text box — SILENTLY, so the worker never learns
    // its multi-select did nothing. A shape zod accepts can still be a question nobody can answer.
    await assert.rejects(
      () => h.router.ask.handler({ input: { slug: "t", questions: [{ question: "Which?", kind: "multi" }] } }),
      /needs options/,
    )
    // "Recommended" means nothing when it is on two of three choices.
    await assert.rejects(
      () => h.router.ask.handler({ input: { slug: "t", questions: [{
        question: "Which?", kind: "question",
        options: [{ label: "A", recommended: true }, { label: "B", recommended: true }],
      }] } }),
      /only ONE option may be/,
    )
    // A follow-up hangs off the option TAKEN, so a multi-select cannot carry one: several picked options
    // would open several branches at once, and the tree stops being static.
    await assert.rejects(
      () => h.router.ask.handler({ input: { slug: "t", questions: [{
        question: "Which?", kind: "multi",
        options: [{ label: "A", followUps: [{ question: "And then?", kind: "question", options: [{ label: "x" }] }] }, { label: "B" }],
      }] } }),
      /cannot carry follow-ups/,
    )
    assert.deepEqual(h.storage.listThreadQuestions("t"), [])
  } finally { h.close() }
})

// The one-recommendation rule is a pick-ONE rule. On a `multi` the recommendation is a SET — every
// option worth ticking — and a single chip there reads as "pick only this" (maintainer 2026-10-10).
test("a multi registers with several options recommended", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const { registered } = await h.router.ask.handler({ input: { slug: "t", questions: [{
      question: "Which?", kind: "multi",
      options: [{ label: "A", recommended: true }, { label: "B", recommended: true }, { label: "C" }],
    }] } })
    assert.deepEqual(registered[0].spec.options?.map((o) => o.recommended === true), [true, true, false])
  } finally { h.close() }
})

test("a follow-up tree deeper than three levels is refused", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const leaf: AskedQuestion = { question: "L4", kind: "question", options: [{ label: "x" }] }
    const l3: AskedQuestion = { question: "L3", kind: "question", options: [{ label: "x", followUps: [leaf] }] }
    const l2: AskedQuestion = { question: "L2", kind: "question", options: [{ label: "x", followUps: [l3] }] }
    const l1: AskedQuestion = { question: "L1", kind: "question", options: [{ label: "x", followUps: [l2] }] }
    // Three levels is a question, a follow-up on the option taken, and one more. Past that the human is
    // filling in a form rather than answering, and the worker should be deciding the rest itself.
    await assert.rejects(() => h.router.ask.handler({ input: { slug: "t", questions: [l1] } }), /the limit is 3/)
    const ok = await h.router.ask.handler({ input: { slug: "t", questions: [l2] } })
    assert.equal(ok.registered.length, 1, "exactly three levels is fine")
  } finally { h.close() }
})

test("a question takes as many options as the choice has, and a multi answer may pick every one", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    // The option count carried `.max(8)` until 2026-09-03 (maintainer: "allow arbitrary numbers of
    // options"). Forty is past every cap that ever sat here, and past the 26 the card letters `A.`–`Z.`,
    // so this pins the RPC schema (the zod boundary, which the handler calls above skip), the row, and
    // the answer that picks the whole list — `chosen` carried the same cap and had to go with it.
    const labels = Array.from({ length: 40 }, (_, i) => `Finding ${i + 1}`)
    const wide: AskedQuestion = { question: "Which findings should be acted on?", kind: "multi", options: labels.map((label) => ({ label })) }
    const input = AskInput.parse({ slug: "t", questions: [wide] })
    const { registered } = await h.router.ask.handler({ input })
    assert.equal(registered[0].spec.options?.length, 40)
    assert.equal(h.storage.listThreadQuestions("t", { openOnly: true }).length, 1)

    const answers = AnswerQuestionsInput.parse({ slug: "t", answers: [{ questionId: registered[0].id, question: wide.question, chosen: labels }] })
    const result = await h.router.answerQuestions.handler({ input: answers })
    assert.deepEqual(result.answered, [registered[0].id])
    assert.deepEqual(JSON.parse(h.storage.getThreadQuestion(registered[0].id)!.answer!).chosen, labels)
  } finally { h.close() }
})

test("the text caps carry the evidence, and an option takes more than four follow-ups", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    // 600 / 120 / 4000 characters and four follow-ups until 2026-09-03. The question is the whole card
    // context, a label is a chip line that runs long, and a description is allowed to be a real diff —
    // each of these is past its old cap and inside the new one.
    const question = `Which? ${"evidence ".repeat(300)}`.trim()
    const label = `Post the drafted comment as written ${"x".repeat(300)}`
    const description = `\`\`\`diff\n${"+ a line of the diff\n".repeat(600)}\`\`\``
    const followUps = Array.from({ length: 6 }, (_, i) => ({ question: `And ${i}?`, kind: "question" as const }))
    assert.ok(question.length > 600 && label.length > 120 && description.length > 4000)
    const input = AskInput.parse({ slug: "t", questions: [{ question, kind: "question", options: [{ label, description, followUps }, { label: "No" }] }] })
    const { registered } = await h.router.ask.handler({ input })
    assert.equal(registered[0].spec.options?.[0].followUps?.length, 6)
    // …and the answer restates the long question, carries the long label, and answers all six branches.
    const answers = AnswerQuestionsInput.parse({ slug: "t", answers: [{
      questionId: registered[0].id, question, chosen: [label],
      followUps: followUps.map((f) => ({ questionId: registered[0].id, question: f.question, chosen: [], text: "ok" })),
    }] })
    assert.equal(answers.answers[0].followUps?.length, 6)
  } finally { h.close() }
})

test("the open set and the call are unbounded, and an archived thread refuses outright", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    // Four per call and twelve open were the caps until 2026-09-03 ("a worker holding more than this is
    // refusing to decide"); the maintainer had both removed as arbitrary. Twenty in ONE call, through the
    // zod boundary the handler skips, then one more on top.
    const twenty = Array.from({ length: 20 }, (_, i) => simple(`Q${i}?`))
    const { registered } = await h.router.ask.handler({ input: AskInput.parse({ slug: "t", questions: twenty }) })
    assert.equal(registered.length, 20)
    const more = await h.router.ask.handler({ input: { slug: "t", questions: [simple("one more?")] } })
    assert.equal(more.open.length, 21)

    h.storage.upsertSession(row("gone", { state: "archived", archived: 1 }))
    await assert.rejects(
      () => h.router.ask.handler({ input: { slug: "gone", questions: [simple()] } }),
      /Reopen this thread/,
    )
  } finally { h.close() }
})

test("unask is the worker's own withdrawal, scoped to its thread", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.upsertSession(row("other"))
    const { registered } = await h.router.ask.handler({ input: { slug: "t", questions: [simple()] } })
    const id = registered[0].id

    const foreign = await h.router.unask.handler({ input: { slug: "other", id } })
    assert.equal(foreign.withdrawn, false, "another thread cannot withdraw it")
    assert.equal(h.storage.getThreadQuestion(id)?.state, "open")

    const own = await h.router.unask.handler({ input: { slug: "t", id } })
    assert.equal(own.withdrawn, true)
    assert.deepEqual(own.open, [])
    assert.equal(h.storage.getThreadQuestion(id)?.state, "withdrawn")
    assert.equal((await h.router.unask.handler({ input: { slug: "t", id } })).withdrawn, false, "and not repeatable")
  } finally { h.close() }
})

test("answering stores the answer WITHOUT delivering it, and leaves the row for the waker", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const { registered } = await h.router.ask.handler({ input: { slug: "t", questions: [simple(), simple("Ship it?")] } })
    const [a, b] = registered

    const result = await h.router.answerQuestions.handler({ input: { slug: "t", answers: [
      { questionId: a.id, question: a.spec.question, chosen: ["SQLite"] },
      { questionId: b.id, question: b.spec.question, chosen: [], text: "not yet" },
    ] } })
    assert.deepEqual(result.answered.sort(), [a.id, b.id].sort())
    assert.deepEqual(result.open, [])
    // ANSWERING IS NOT DELIVERING: an answer given while the worker's process was down has to survive
    // the gap, or it is lost in the same silence the fence used to lose the QUESTION in.
    assert.deepEqual(h.storage.undeliveredSettlements().map((q) => q.id).sort(), [a.id, b.id].sort())
    assert.equal(h.storage.getThreadQuestion(a.id)?.delivered, 0)
    // …BUT IT DOES NOT WAIT FOR THE NEXT TICK EITHER. The durable path is untouched; the sweep simply
    // runs now, because the human is right here and up to ten seconds of "nothing happened" reads as a
    // thread that rested without saying anything (maintainer 2026-08-27).
    assert.equal(h.kicks(), 1, "answering runs the delivery sweep immediately")

    // An id belonging to another thread answers nothing, and an already-settled one is silently absent
    // rather than an error — two browser tabs answering the same card is a race nobody should see.
    h.storage.upsertSession(row("other"))
    const again = await h.router.answerQuestions.handler({ input: { slug: "other", answers: [
      { questionId: a.id, question: "x", chosen: ["JSON"] },
    ] } })
    assert.deepEqual(again.answered, [])
    assert.equal(JSON.parse(h.storage.getThreadQuestion(a.id)!.answer!).chosen[0], "SQLite")
  } finally { h.close() }
})

test("answering a card on an archived thread reopens it, so the answer has somebody to reach", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const { registered } = await h.router.ask.handler({ input: { slug: "t", questions: [simple(), simple("Ship it?")] } })
    const [a, b] = registered
    // Marked done with its questions still open: nothing closes them, and the scheduler delivers nothing
    // to an archived thread, so an answer given here used to be stored and reach nobody.
    h.storage.setState("t", "archived")
    assert.equal(h.storage.getSession("t")?.state, "archived")

    // An answer naming no open row of this thread changes nothing, the thread stays where it was put.
    h.storage.upsertSession(row("other"))
    const { registered: [foreign] } = await h.router.ask.handler({ input: { slug: "other", questions: [simple()] } })
    await h.router.answerQuestions.handler({ input: { slug: "t", answers: [
      { questionId: foreign.id, question: foreign.spec.question, chosen: ["SQLite"] },
    ] } })
    assert.equal(h.storage.getSession("t")?.state, "archived", "an id from another thread reopens nothing")

    const result = await h.router.answerQuestions.handler({ input: { slug: "t", answers: [
      { questionId: a.id, question: a.spec.question, chosen: ["SQLite"] },
    ] } })
    assert.deepEqual(result.answered, [a.id])
    assert.equal(h.storage.getSession("t")?.state, "open", "the answer reopens the thread")
    assert.equal(h.storage.getSession("t")?.archived, 0)
    assert.ok(h.refreshes() > 0, "and the board redraws it out of Done")

    // Re-archived, an answer that settles nothing (the row is already answered) leaves it archived.
    h.storage.setState("t", "archived")
    await h.router.answerQuestions.handler({ input: { slug: "t", answers: [
      { questionId: a.id, question: a.spec.question, chosen: ["JSON"] },
    ] } })
    assert.equal(h.storage.getSession("t")?.state, "archived", "a settled row reopens nothing")
    assert.equal(h.storage.getThreadQuestion(b.id)?.state, "open")
  } finally { h.close() }
})

test("the transcript reads back the ANSWERED questions with their answers, and nothing else", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.upsertSession(row("other"))
    const { registered } = await h.router.ask.handler({ input: { slug: "t", questions: [simple(), simple("Ship it?"), simple("Tag it?"), simple("Still open?")] } })
    const [answered, dismissed, withdrawn] = registered
    await h.router.ask.handler({ input: { slug: "other", questions: [simple("Another thread's?")] } })
    const answer = { questionId: answered.id, question: answered.spec.question, chosen: ["SQLite — transactional, matches how sessions are already stored"], text: "and index it" }
    await h.router.answerQuestions.handler({ input: { slug: "t", answers: [answer] } })
    await h.router.dismissQuestions.handler({ input: { slug: "t", ids: [dismissed.id] } })
    await h.router.unask.handler({ input: { slug: "t", id: withdrawn.id } })

    const { questions } = await h.router.threadSettledQuestions.handler({ input: { slug: "t" } })
    // A dismissal and a withdrawal carry no answer to draw, an open question is still the live card, and
    // another thread's rows never leak in.
    assert.deepEqual(questions.map((q) => q.id), [answered.id])
    assert.deepEqual(questions[0].answer, answer)
    assert.deepEqual(questions[0].spec, answered.spec)
    assert.equal(questions[0].askedAt, answered.askedAt)
    assert.ok(Date.parse(questions[0].settledAt) >= Date.parse(questions[0].askedAt))
    assert.deepEqual((await h.router.threadSettledQuestions.handler({ input: { slug: "other" } })).questions, [])

    // A FENCE-ASKED question that closed unanswered comes back with what it asked, for the `id:`-only
    // fences that named it while it was open. One the `ask` RPC registered has no handle, so no fence can
    // name it, and stays out — the dismissal and the withdrawal above.
    const fenceSpec = simple("Which store?")
    h.storage.askThreadQuestion({ id: "qst_fencewithdrawn", slug: "t", spec: JSON.stringify(fenceSpec), askedAtMs: Date.now(), handle: "which-store" })
    h.storage.withdrawThreadQuestion("t", "qst_fencewithdrawn", Date.now())
    h.storage.askThreadQuestion({ id: "qst_fencestillopen", slug: "t", spec: JSON.stringify(simple("Still asking?")), askedAtMs: Date.now(), handle: "still-asking" })
    const { closed } = await h.router.threadSettledQuestions.handler({ input: { slug: "t" } })
    assert.deepEqual(closed, [{ id: "qst_fencewithdrawn", spec: fenceSpec }])
  } finally { h.close() }
})

test("the × dismisses an ordinary question and CANNOT reach a danger-tagged one", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const danger: AskedQuestion = {
      question: "Force-push over the rewritten history?",
      kind: "question", danger: true,
      options: [{ label: "Force-push it" }, { label: "Leave it — reopen the branch instead" }],
    }
    const { registered } = await h.router.ask.handler({ input: { slug: "t", questions: [simple(), danger] } })
    const [ordinary, irreversible] = registered

    const result = await h.router.dismissQuestions.handler({ input: { slug: "t", ids: [ordinary.id, irreversible.id] } })
    // A generic close icon is not consent for something irreversible. Declining is a real option INSIDE
    // the question, so the danger row stays open and the ordinary one goes.
    assert.deepEqual(result.dismissed, [ordinary.id])
    assert.deepEqual(result.open.map((q) => q.id), [irreversible.id])
    assert.equal(h.storage.getThreadQuestion(ordinary.id)?.state, "dismissed")
    assert.equal(h.storage.getThreadQuestion(irreversible.id)?.state, "open")
    // A dismissal carries no ANSWER, but it is still news the worker needs ("decide it yourself"), so it
    // sits in the delivery queue — it just never wakes anybody on its own. It rides the next answer.
    assert.deepEqual(h.storage.undeliveredSettlements().map((q) => [q.id, q.state, q.answer]), [[ordinary.id, "dismissed", null]])
  } finally { h.close() }
})

test("the answer message is written in the wire form the chat renders as the human's own Answers card", () => {
  // THE FORMAT IS THE ATTRIBUTION. This message is delivered as a frizz WAKE, and the chat draws a wake
  // as frizz's own notification card — UNLESS the text is in the one form `parseAnswersCard` reads, which
  // it checks first. Getting it wrong does not fail: the answer simply stops being the human's words on
  // screen and becomes agent-facing prose in a Frizz card over them (the 2026-08-27 regression).
  //
  // The worker never saw an id, so `{id: choice}` would be unreadable to it — each row quotes its own
  // question, which is also what makes the card restate the question beside the answer. And a dismissal
  // RIDES the next message rather than waking anybody: the human dismissing questions is almost always
  // dismissing several in a row and is sitting right there, so a wake per × would be a turn per click.
  const message = questionAnswerMessage([
    {
      questionId: "qst_a", question: "SQLite or a JSON file?", chosen: ["SQLite"],
      followUps: [{ questionId: "qst_b", question: "Migrate the existing rows?", chosen: ["Yes, at boot"] }],
    },
  ], [{ question: "Ship the banner this week?" }])
  assert.equal(message.split("\n")[0], BURIED_ANSWERS_HEADER)
  assert.match(message, /^1\. “SQLite or a JSON file\?” → SQLite$/m)
  // FLAT, not indented: the parser reads any non-row line as a continuation of the row above it, so an
  // indented child would render inside its parent's answer chip. The ⤷ is what carries the nesting, and
  // it sits OUTSIDE the quotes so it never reads as part of the question the worker asked.
  assert.match(message, /^2\. ⤷ “Migrate the existing rows\?” → Yes, at boot$/m)
  // A dismissal is a ROW for the same reason — a trailing paragraph is swallowed by the last answer.
  assert.match(message, /^3\. “Ship the banner this week\?” → \(dismissed — decide it yourself; do not re-ask\)$/m)
  assert.equal(message.split("\n").length, 4, "header + one row per node, nothing else")
})

test("nobody-is-coming is its own message, and NOT the answers form", () => {
  // The autonomous thread whose questions were cancelled wholesale. Frizz is speaking here, not the
  // human, so it must NOT wear the Answers card — the chat draws it as a hairline instead.
  const message = questionsCancelledWakeMessage(2)
  assert.doesNotMatch(message, new RegExp(BURIED_ANSWERS_HEADER))
  assert.deepEqual(parseQuestionsCancelledWake(message), { count: 2 })
  assert.match(message, /Do not re-ask\./)
  assert.equal(parseQuestionsCancelledWake("Answers to earlier questions:\n1. “Q” → A"), undefined)
})

// ---- AUTONOMOUS MODE -------------------------------------------------------------------------------
//
// There is no autonomous-mode switch and there is not going to be one. A `recurring_pause_on_questions`
// column shown in the footer as "Autonomous mode" was deleted 2026-08-16, on the grounds that arming a
// Goal already IS that consent, and plans/rest-by-registration.md keeps that shape rather than restoring
// it: ONE control, the prompt as its payload. So these tests are about an armed REST GOAL.

const goal = (h: ReturnType<typeof harness>, slug: string, prompt = "Keep going. Make decisions autonomously.") =>
  h.storage.setRecurringPromptBySlug(slug, {
    prompt, stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null,
    armedAt: new Date().toISOString(),
  })

test("`ask` is REFUSED on an autonomous thread, and the refusal quotes the standing instruction", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    goal(h, "t", "Finish the migration. Decide the small things yourself.")
    await assert.rejects(
      () => h.router.ask.handler({ input: { slug: "t", questions: [simple()] } }),
      (e: Error) => {
        assert.match(e.message, /running autonomously — decide it yourself/)
        // QUOTING THE PROMPT is the point: the refusal is the worker's only chance to see WHAT it was
        // told, and a bare "you are autonomous" leaves it guessing at the scope of its own mandate.
        assert.match(e.message, /Finish the migration\. Decide the small things yourself\./)
        // And it names the way out that is NOT asking, so a genuinely human-owned call is not simply
        // swallowed by the mode.
        assert.match(e.message, /say so in your final message/)
        return true
      },
    )
    assert.deepEqual(h.storage.listThreadQuestions("t", { openOnly: true }), [])
  } finally { h.close() }
})

test("the OTHER two triggers are not autonomy — neither tells anybody to decide anything", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.setRecurringPromptBySlug("t", {
      prompt: "Re-read the plan doc.", stopHook: false, heartbeat: true, postCompaction: true,
      intervalMs: 3_600_000, armedAt: new Date().toISOString(),
    })
    const result = await h.router.ask.handler({ input: { slug: "t", questions: [simple()] } })
    assert.equal(result.registered.length, 1)
  } finally { h.close() }
})

test("an armed trigger with NO TEXT is not autonomy either — there is no instruction to obey", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.setRecurringPromptBySlug("t", {
      prompt: null, stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null,
      armedAt: new Date().toISOString(),
    })
    assert.equal((await h.router.ask.handler({ input: { slug: "t", questions: [simple()] } })).registered.length, 1)
  } finally { h.close() }
})

test("arming a Goal CANCELS the questions already open — a thread cannot be autonomous and blocked", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const asked = await h.router.ask.handler({ input: { slug: "t", questions: [simple("A?"), simple("B?")] } })
    await h.router.setOwnThreadRecurringPrompt.handler({
      input: { slug: "t", prompt: "Keep going.", stopHook: true, heartbeat: false, postCompaction: false },
    })
    assert.deepEqual(h.storage.listThreadQuestions("t", { openOnly: true }), [])
    // CANCELLED, not withdrawn: the worker did not do this, so it is told — and it is told through the
    // ordinary settlement queue, which is what carries it to a thread nobody is about to steer.
    assert.deepEqual(
      h.storage.undeliveredSettlements().map((q) => [q.id, q.state]).sort(),
      asked.registered.map((q) => [q.id, "dismissed"]).sort(),
    )
  } finally { h.close() }
})

test("arming over open questions runs the delivery sweep NOW — the cancellation wake must not sit a tick away", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    // No questions to cancel ⇒ nothing new for the sweep to carry ⇒ no kick. The rest pass finds the
    // fresh Goal on its own tick, exactly as before.
    await h.router.setOwnThreadRecurringPrompt.handler({
      input: { slug: "t", prompt: "Keep going.", stopHook: true, heartbeat: false, postCompaction: false },
    })
    assert.equal(h.kicks(), 0, "arming with nothing to cancel kicks nothing")

    // With a question open, the arming that cancels it also kicks: between the question card leaving
    // the board and the cancellation wake landing there is otherwise a whole tick of bare rest, drawn
    // as "Rested without a sign-off" over a thread that had asked (maintainer 2026-09-02).
    h.storage.upsertSession(row("u"))
    await h.router.ask.handler({ input: { slug: "u", questions: [simple()] } })
    await h.router.setOwnThreadRecurringPrompt.handler({
      input: { slug: "u", prompt: "Keep going.", stopHook: true, heartbeat: false, postCompaction: false },
    })
    assert.equal(h.kicks(), 1, "arming over an open question sweeps immediately")

    // The Goal panel's writer makes the same call through its own guard.
    h.storage.upsertSession(row("v"))
    await h.router.ask.handler({ input: { slug: "v", questions: [simple()] } })
    await h.router.setThreadRecurringPrompt.handler({
      input: { slug: "v", sessionId: "sid-v", prompt: "Keep going.", stopHook: true, heartbeat: false, postCompaction: false },
    })
    assert.equal(h.kicks(), 2, "the operator's save sweeps the same way")
  } finally { h.close() }
})

test("a DANGER question survives the flip, exactly as it survives the human's ×", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const gate: AskedQuestion = {
      question: "Force-push over the three commits?", kind: "question", danger: true,
      options: [{ label: "Force-push" }, { label: "Stop", recommended: true }],
    }
    await h.router.ask.handler({ input: { slug: "t", questions: [simple("ordinary?"), gate] } })
    await h.router.setOwnThreadRecurringPrompt.handler({
      input: { slug: "t", prompt: "Keep going.", stopHook: true, heartbeat: false, postCompaction: false },
    })
    // Autonomy is consent to decide ORDINARY things. It is not consent to a force-push, and a mode flip
    // is even weaker consent than the × the server already refuses on one of these.
    assert.deepEqual(h.storage.listThreadQuestions("t", { openOnly: true }).map((q) => JSON.parse(q.spec).question), ["Force-push over the three commits?"])
  } finally { h.close() }
})

test("an EDIT to an already-autonomous thread cancels nothing — it is a transition, not a state", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    goal(h, "t")
    // The Goal panel writes the whole row on every edit — text, all three triggers and the cadence are
    // one save — so re-firing on a cadence tweak would quietly bin a question registered a moment ago.
    // (Which is reachable: `ask` refuses on an autonomous thread, but the row can be written directly,
    // and a question registered BEFORE the Goal was armed outlives a danger-tagged flip.)
    h.storage.askThreadQuestion({ id: "qst_survivor", slug: "t", spec: JSON.stringify(simple()), askedAtMs: Date.now() })
    await h.router.setOwnThreadRecurringPrompt.handler({
      input: { slug: "t", prompt: "Keep going, but faster.", stopHook: true, heartbeat: false, postCompaction: false },
    })
    assert.deepEqual(h.storage.listThreadQuestions("t", { openOnly: true }).map((q) => q.id), ["qst_survivor"])
  } finally { h.close() }
})

test("turning the Goal OFF cancels nothing — the human is back, and back to answering", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    goal(h, "t")
    h.storage.askThreadQuestion({ id: "qst_kept", slug: "t", spec: JSON.stringify(simple()), askedAtMs: Date.now() })
    await h.router.setOwnThreadRecurringPrompt.handler({
      input: { slug: "t", prompt: null, stopHook: false, heartbeat: false, postCompaction: false },
    })
    assert.deepEqual(h.storage.listThreadQuestions("t", { openOnly: true }).map((q) => q.id), ["qst_kept"])
  } finally { h.close() }
})

// READING THE OPEN SET WITHOUT MUTATING ANYTHING (maintainer 2026-08-28: "Is there a way for the agent
// to read out the current set of watchers and questions?"). It could not: `ask` returns the open set but
// registers another question, and `unask` returns it but withdraws one — so the ids that block `done`,
// and the id a ```question fence needs to PLACE a question in the handoff, were reachable only through a
// mutation. `listOwnThreadActivity` is the read, and it is the same procedure that hands back the ids of
// everything running.
test("listOwnThreadActivity reads the open questions back — the only way to see them without asking or unasking", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const { registered } = await h.router.ask.handler({ input: { slug: "t", questions: [simple(), simple("Which dist-tag should 4.5.0 publish under?")] } })
    const out = await h.router.listOwnThreadActivity.handler({ input: { slug: "t" } })
    assert.deepEqual(out.activity, [], "nothing is RUNNING — the questions are their own list, never fence items")
    assert.deepEqual(out.questions.map((q) => q.id), registered.map((q) => q.id))
    assert.deepEqual(out.questions.map((q) => q.spec.question), ["SQLite or a JSON file?", "Which dist-tag should 4.5.0 publish under?"])
  } finally { h.close() }
})

test("an answered or withdrawn question leaves the readout — it lists what is still OWED", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const { registered } = await h.router.ask.handler({ input: { slug: "t", questions: [simple(), simple("Second?")] } })
    await h.router.unask.handler({ input: { slug: "t", id: registered[0].id } })
    const afterUnask = await h.router.listOwnThreadActivity.handler({ input: { slug: "t" } })
    assert.deepEqual(afterUnask.questions.map((q) => q.id), [registered[1].id])
    await h.router.answerQuestions.handler({ input: { slug: "t", answers: [{ questionId: registered[1].id, question: "Second?", chosen: ["SQLite — transactional, matches how sessions are already stored"] }] } })
    const afterAnswer = await h.router.listOwnThreadActivity.handler({ input: { slug: "t" } })
    assert.deepEqual(afterAnswer.questions, [], "an answered question is no longer owed")
  } finally { h.close() }
})

// A BATCH READS BACK IN THE ORDER IT WAS WRITTEN. Every question of one `ask` call shares one `asked_at`
// — the router stamps a single `now` — so the tiebreak decides the order the human sees. It was the
// random `qst_…` id until 2026-08-28, which shuffled the worker's own first/second on the card stack and
// in the readout; it is now the insertion rowid.
test("questions asked in ONE call keep their order — the tiebreak is insertion, not a random id", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const asked = ["First?", "Second?", "Third?", "Fourth?"]
    const { registered } = await h.router.ask.handler({ input: { slug: "t", questions: asked.map((q) => simple(q)) } })
    assert.deepEqual(registered.map((q) => q.spec.question), asked)
    const out = await h.router.listOwnThreadActivity.handler({ input: { slug: "t" } })
    assert.deepEqual(out.questions.map((q) => q.spec.question), asked, "the readout must not shuffle a batch")
    assert.deepEqual(out.questions.map((q) => q.id), registered.map((q) => q.id))
  } finally { h.close() }
})

// ---- SECRET requests (`mcp__frizz__secret`) --------------------------------------------------------
// A credential the human pastes — a one-time code, a token — goes to a private file, and every surface
// that reads the answer row (the settled card, the in-flight card, the worker's wake) sees only where
// it went. These pin the one property that matters: the value is in the file and NOWHERE in the row.

/** Read a secret's path the way a worker's `$(cat …)` does: a real `cat`, blocking on the pipe until the
 *  server's writer finds it. */
const catPath = (path: string) => new Promise<string>((resolve, reject) =>
  execFile("cat", [path], { timeout: 5_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))))

const secretAsk = (question = "The npm one-time code for the maintainer account."): AskedQuestion => ({ question, kind: "question", secret: true })

test("a SECRET answer is served once from memory through its pipe, and the row keeps only the path", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const asked = await h.router.ask.handler({ input: { slug: "t", questions: [secretAsk()] } })
    const q = asked.registered[0]
    // The path is known at REGISTRATION, so the worker can prepare its command before the answer.
    assert.ok(q.secretPath, "the ask result names the path")
    assert.equal(q.secretPath, join(h.stateDir, "secrets", "t", q.id))
    assert.equal(existsSync(q.secretPath!), false, "nothing exists until the human answers")
    assert.equal(asked.open[0].secretPath, q.secretPath, "the read-back names it too")

    const value = "493817"
    const result = await h.router.answerQuestions.handler({ input: { slug: "t", answers: [
      { questionId: q.id, question: q.spec.question, chosen: [], text: `  ${value}\n` },
    ] } })
    assert.deepEqual(result.answered, [q.id])
    const stat = lstatSync(q.secretPath!)
    assert.ok(stat.isFIFO(), "a named pipe, not a file: the value is never on disk")
    assert.equal(stat.mode & 0o777, 0o600, "readable by this user alone")
    assert.equal(statSync(join(h.stateDir, "secrets")).mode & 0o777, 0o700)
    assert.equal(await catPath(q.secretPath!), value, "the reader gets the value, trimmed")

    const stored = h.storage.getThreadQuestion(q.id)!
    assert.equal(stored.state, "answered")
    assert.ok(!stored.answer!.includes(value), "the database row never holds the value")
    const answer = JSON.parse(stored.answer!)
    assert.equal(answer.text, secretAnswerText(q.secretPath!))
    // The wake is composed from the row, so it cannot carry the value either — and it says how to use it.
    const wake = questionAnswerMessage([answer])
    assert.ok(!wake.includes(value))
    assert.ok(wake.includes(`secret ready at '${q.secretPath}'`), "the path is single-quoted for the shell")
    assert.match(wake, /read ONCE, within 15m/)
  } finally { h.close() }
})

test("a BLANK secret answers nothing — the request stays open rather than waking the worker to an empty file", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const q = (await h.router.ask.handler({ input: { slug: "t", questions: [secretAsk()] } })).registered[0]
    const result = await h.router.answerQuestions.handler({ input: { slug: "t", answers: [
      { questionId: q.id, question: q.spec.question, chosen: [], text: "   " },
    ] } })
    assert.deepEqual(result.answered, [])
    assert.equal(h.storage.getThreadQuestion(q.id)?.state, "open")
    assert.equal(existsSync(q.secretPath!), false)
  } finally { h.close() }
})

test("a secret request is allowed on an autonomous thread, and arming a Goal does not cancel one", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const open = await h.router.ask.handler({ input: { slug: "t", questions: [secretAsk("Token?"), simple("A?")] } })
    await h.router.setOwnThreadRecurringPrompt.handler({
      input: { slug: "t", prompt: "Keep going.", stopHook: true, heartbeat: false, postCompaction: false },
    })
    // The ordinary question is the worker's to decide now; the credential is not something it can decide.
    assert.deepEqual(h.storage.listThreadQuestions("t", { openOnly: true }).map((q) => q.id), [open.registered[0].id])
    // And a NEW secret request is accepted on the now-autonomous thread, while a mixed batch is not.
    assert.equal((await h.router.ask.handler({ input: { slug: "t", questions: [secretAsk("Another?")] } })).registered.length, 1)
    await assert.rejects(() => h.router.ask.handler({ input: { slug: "t", questions: [secretAsk("B?"), simple("C?")] } }), /running autonomously/)
  } finally { h.close() }
})

test("a secret request takes no options and cannot be a follow-up", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await assert.rejects(
      () => h.router.ask.handler({ input: { slug: "t", questions: [{ ...secretAsk(), options: [{ label: "123456" }] }] } }),
      /a secret request takes no options/,
    )
    await assert.rejects(
      () => h.router.ask.handler({ input: { slug: "t", questions: [{
        question: "Publish?", kind: "question",
        options: [{ label: "Yes", followUps: [secretAsk()] }, { label: "No" }],
      }] } }),
      /a secret request cannot be a follow-up/,
    )
    assert.deepEqual(h.storage.listThreadQuestions("t", { openOnly: true }), [])
  } finally { h.close() }
})
