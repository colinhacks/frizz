import { test } from "node:test"
import assert from "node:assert/strict"
import { ANSWER_FOLLOW_UP_MARKER, BURIED_ANSWERS_HEADER, DISMISSED_ANSWER, SECRET_ANSWER_MASK, nameQuestionAnswer, questionAnswerMessage, questionFencesIn, secretAnswerText, withAnswersNote, type QuestionAnswer } from "@frizz/shared"
import { answersForDisplay, answersNote, splitAnswerPicks, parseAnswersMessage, parseBuriedAnswersMessage, parseAnswersCard, pairAnswersMessage, pairAllAnswers, unrenderedAnswers, isAnswersMessage, userSendShown, type MsgLike } from "./answersMessage.ts"
import { composeAnswerWire } from "./answering.ts"

test("parses the multi-block composed-answer format into numbered rows", () => {
  const parsed = parseAnswersMessage("Answers:\n1. B. Hard-error with an install hint\n2. A. Preload it")
  assert.deepEqual(parsed, [
    { n: 1, answer: "B. Hard-error with an install hint" },
    { n: 2, answer: "A. Preload it" },
  ])
})

test("a multi-line answer folds its continuation lines in (newline preserved)", () => {
  const parsed = parseAnswersMessage("Answers:\n1. first line\ncontinued here\n2. second")
  assert.equal(parsed?.length, 2)
  assert.equal(parsed?.[0].answer, "first line\ncontinued here")
  assert.equal(parsed?.[1].answer, "second")
})

test("CR-separated composed answer (terminal-injected) parses (the newline-collapse fix)", () => {
  // The real session 2cfe3c81 16:24:42 shape: a follow-up round-tripped through the tty is \r-separated.
  const parsed = parseAnswersMessage("Answers:\r1. B. Hard-error with an install hint\r2. A. Preload it")
  assert.deepEqual(parsed, [
    { n: 1, answer: "B. Hard-error with an install hint" },
    { n: 2, answer: "A. Preload it" },
  ])
})

test("tolerates leading blank lines before the header", () => {
  const parsed = parseAnswersMessage("\n\nAnswers:\n1. yes")
  assert.deepEqual(parsed, [{ n: 1, answer: "yes" }])
})

test("a plain (non-answers) user message returns null → falls back to the bubble", () => {
  assert.equal(parseAnswersMessage("Stop. Ask me the questions again."), null)
})

test("a single bare answer (no 'Answers:' header) returns null", () => {
  assert.equal(parseAnswersMessage("B. Hard-error with an install hint"), null)
})

test("header present but no numbered lines → null (degrade to bubble)", () => {
  assert.equal(parseAnswersMessage("Answers:\njust some prose"), null)
})

test("prose that merely contains the word Answers is not misdetected", () => {
  assert.equal(parseAnswersMessage("Answers: it depends\n1. maybe"), null) // first line isn't exactly "Answers:"
})

test("empty / whitespace input returns null", () => {
  assert.equal(parseAnswersMessage(""), null)
  assert.equal(parseAnswersMessage("   \n  "), null)
})

// ---- parseBuriedAnswersMessage (composeAnswerWire's self-describing form) ----

test("parses the buried form's quoted question and answer into card rows", () => {
  const parsed = parseBuriedAnswersMessage('Answers to earlier questions:\n1. “Which database?” → A. Postgres\n2. “Ship it?” → B. Hold')
  assert.deepEqual(parsed, [
    { n: 1, answer: "A. Postgres", question: "Which database?" },
    { n: 2, answer: "B. Hold", question: "Ship it?" },
  ])
})

test("a marked row is a FOLLOW-UP, and the marker never leaks into the question", () => {
  // The REGISTERED path's tree, flat on the wire (questionAnswerMessage). The marker sits outside the
  // quotes on purpose: inside them it would read as part of the question the worker asked, and it is the
  // one thing that tells the card to indent the row under the answer that opened it.
  const wire = [
    BURIED_ANSWERS_HEADER,
    "1. “SQLite or a JSON file?” → SQLite",
    `2. ${ANSWER_FOLLOW_UP_MARKER} “Migrate the existing rows?” → Yes, at boot`,
  ].join("\n")
  assert.deepEqual(parseBuriedAnswersMessage(wire), [
    { n: 1, answer: "SQLite", question: "SQLite or a JSON file?" },
    { n: 2, answer: "Yes, at boot", question: "Migrate the existing rows?", followUp: true },
  ])
})

test("a dismissed question is an ordinary row, so it can never land inside the answer above it", () => {
  // The dismissal used to ride as a trailing paragraph. Any non-row line after a row is read as a
  // CONTINUATION of that row's answer — so it printed inside the human's own chip.
  const wire = `${BURIED_ANSWERS_HEADER}\n1. “Which store?” → SQLite\n2. “Name the flag?” → ${DISMISSED_ANSWER}`
  const parsed = parseBuriedAnswersMessage(wire)
  assert.equal(parsed?.length, 2)
  assert.equal(parsed?.[0].answer, "SQLite", "the answer above it is untouched")
  assert.equal(parsed?.[1].answer, DISMISSED_ANSWER)
})

test("an answer containing its own arrow keeps everything after the FIRST quote-arrow", () => {
  const parsed = parseBuriedAnswersMessage('Answers to earlier questions:\n1. “Which flow?” → A. draft → review → merge')
  assert.equal(parsed?.[0].question, "Which flow?")
  assert.equal(parsed?.[0].answer, "A. draft → review → merge")
})

test("a multi-line buried answer folds its continuation lines in", () => {
  const parsed = parseBuriedAnswersMessage('Answers to earlier questions:\n1. “Why?” → because\nof this\n2. “And?” → sure')
  assert.equal(parsed?.length, 2)
  assert.equal(parsed?.[0].answer, "because\nof this")
  assert.equal(parsed?.[1].answer, "sure")
})

test("a typed answer that is itself a numbered list cannot forge rows — the writer indents, the reader strips", () => {
  // 2026-09-23: "Answers:\n1. Do these:\n1. run x\n2. run y" parsed as THREE answers to one question.
  const typed = "Do these:\n1. run x\n2. run y"
  const live = composeAnswerWire({ answered: [{ isLive: true, question: "Q", answer: typed }], live: { numbered: [{ n: 1, a: typed }] } })
  assert.equal(live, "Answers:\n1. Do these:\n  1. run x\n  2. run y")
  assert.deepEqual(parseAnswersMessage(live), [{ n: 1, answer: typed }])
  const buried = composeAnswerWire({ answered: [{ isLive: false, question: "Q?", answer: typed }] })
  assert.deepEqual(parseBuriedAnswersMessage(buried), [{ n: 1, answer: typed, question: "Q?" }])
  const registered = questionAnswerMessage([{ questionId: "qst_a", question: "Q?", chosen: [], text: typed }])
  assert.deepEqual(parseBuriedAnswersMessage(registered), [{ n: 1, answer: typed, question: "Q?" }])
  // The indent is only ever stripped where the writer put it: a continuation from before the indent
  // existed carries none and reads exactly as it did.
  assert.deepEqual(parseAnswersMessage("Answers:\n1. because\nof this"), [{ n: 1, answer: "because\nof this" }])
})

test("a multi-select's picks travel one per line, and the card gets each pick and the note back apart", () => {
  // 2026-10-08: five picks and a note went out as `A, B, C — note` and the card drew one run-on chip.
  // A comma cannot be split back out — a label can hold one, as the second pick here does.
  const wire = questionAnswerMessage([
    { questionId: "qst_a", question: "Which gates?", chosen: ["lint", "tests, unit and e2e"], text: "skip the flaky one\n1. really" },
    { questionId: "qst_b", question: "Ship it?", chosen: ["Yes"] },
  ])
  assert.equal(wire, `${BURIED_ANSWERS_HEADER}\n1. “Which gates?” → - [x] lint\n  - [x] tests, unit and e2e\n  \n  skip the flaky one\n  1. really\n2. “Ship it?” → Yes`)
  const [multi, single] = parseAnswersCard(wire)!
  assert.deepEqual(splitAnswerPicks(multi.answer), { picks: ["lint", "tests, unit and e2e"], note: "skip the flaky one\n1. really" })
  // A lone pick stays the bare label it always was, and so does every answer written before the change.
  assert.deepEqual(splitAnswerPicks(single.answer), { picks: [], note: "Yes" })
  assert.deepEqual(splitAnswerPicks("lint, tests — skip it"), { picks: [], note: "lint, tests — skip it" })
  assert.deepEqual(splitAnswerPicks(parseAnswersCard(questionAnswerMessage([{ questionId: "q", question: "Q?", chosen: ["a", "b"] }]))![0].answer), { picks: ["a", "b"], note: "" })
})

test("a question that spans lines still closes at its quote-arrow — the registered path restates it verbatim", () => {
  // 2026-09-23: a registered question walked the human through adding an SSH key and carried the key
  // on its own line, so the row spanned five lines. The single-line row pattern missed it and the whole
  // answer fell through to frizz's notification card as a broken numbered list.
  const question = "Add it to GitHub: open the keys page, paste this line:\n\n`ecdsa-sha2-nistp256 AAAA… colinhacks@keyward`\n\nIs the key added?"
  const wire = questionAnswerMessage([
    { questionId: "qst_a", question, chosen: ["Yes, added"] },
    { questionId: "qst_b", question: "And restart?", chosen: ["No"], text: "later" },
  ])
  assert.deepEqual(parseAnswersCard(wire), [
    { n: 1, answer: "Yes, added", question },
    { n: 2, answer: "- [x] No\n\nlater", question: "And restart?" },
  ])
  assert.equal(isAnswersMessage({ role: "user", kind: "wake", text: wire }), true, "it is the human's turn, not frizz's card")
})

test("a multi-line question followed by a multi-line answer keeps each on its own side of the arrow", () => {
  const parsed = parseBuriedAnswersMessage("Answers to earlier questions:\n1. “First line\nsecond line?” → yes\nand more\n2. “Next?” → no")
  assert.deepEqual(parsed, [
    { n: 1, answer: "yes\nand more", question: "First line\nsecond line?" },
    { n: 2, answer: "no", question: "Next?" },
  ])
})

test("a quoted question that never closes is not our format", () => {
  assert.equal(parseBuriedAnswersMessage("Answers to earlier questions:\n1. “Never closed\nstill going"), null)
  assert.equal(parseBuriedAnswersMessage("Answers to earlier questions:\n1. “Never closed\n2. “Next?” → no"), null)
})

test("an empty quoted question leaves the row unpaired (the numbered fallback, never an empty label)", () => {
  const parsed = parseBuriedAnswersMessage('Answers to earlier questions:\n1. “” → A. Postgres')
  assert.deepEqual(parsed, [{ n: 1, answer: "A. Postgres" }])
})

test("CR-separated buried form parses (terminal-injected follow-up)", () => {
  const parsed = parseBuriedAnswersMessage('Answers to earlier questions:\r1. “Q?” → A')
  assert.deepEqual(parsed, [{ n: 1, answer: "A", question: "Q?" }])
})

test("the SERVER's composed answer round-trips through this reader — the one that decides it is the human's", () => {
  // THE WHOLE POINT OF THE PAIRING. questionAnswerMessage composes the answer to a REGISTERED question,
  // and it is delivered as a frizz WAKE — which the chat draws as frizz's own notification card unless
  // this parser claims it first. It did not claim it until 2026-08-27, and the human's answer rendered as
  // agent-facing prose in a Frizz card over their own words. Composer and reader are pinned to each other
  // here because nothing else in the system compares them.
  const wire = questionAnswerMessage([
    {
      questionId: "qst_a", question: "SQLite or a JSON file?", chosen: ["SQLite"], text: "and vacuum on boot",
      followUps: [{ questionId: "qst_b", question: "Migrate the existing rows?", chosen: ["Yes, at boot"] }],
    },
  ], [{ question: "Ship the banner this week?" }])
  assert.deepEqual(parseAnswersCard(wire), [
    { n: 1, answer: "- [x] SQLite\n\nand vacuum on boot", question: "SQLite or a JSON file?" },
    { n: 2, answer: "Yes, at boot", question: "Migrate the existing rows?", followUp: true },
    { n: 3, answer: DISMISSED_ANSWER, question: "Ship the banner this week?" },
  ])
})

test("the card drops a dismissal row: the worker needs it, the human already said it with the ×", () => {
  // A dismissal rides the NEXT answer's message, which can be several rests after the click, so drawing
  // it read as the dismissed question coming back under the fresh answers (maintainer 2026-09-25).
  const wire = questionAnswerMessage(
    [{ questionId: "qst_a", question: "SQLite or a JSON file?", chosen: ["SQLite"] }],
    [{ question: "Ship the banner this week?" }],
  )
  const parsed = parseAnswersCard(wire)
  assert.equal(parsed?.length, 2, "the parse keeps the row — it is the worker's wire")
  assert.deepEqual(answersForDisplay(parsed ?? []), [{ n: 1, answer: "SQLite", question: "SQLite or a JSON file?" }])
})

test("a secret's row draws the mask, never the delivery note the worker reads", () => {
  const wire = questionAnswerMessage([
    { questionId: "qst_s", question: "The npm one-time code", chosen: [], text: secretAnswerText("/state/secrets/t/qst_s") },
  ])
  const parsed = parseAnswersCard(wire)
  assert.ok(parsed?.[0]?.answer.includes("/state/secrets/t/qst_s"), "the wire still carries the path for the worker")
  assert.deepEqual(answersForDisplay(parsed ?? []), [{ n: 1, answer: SECRET_ANSWER_MASK, question: "The npm one-time code" }])
})

test("buried detection is strict: wrong header, or rows without the quote-arrow, → null", () => {
  assert.equal(parseBuriedAnswersMessage('Answers to earlier questions: sort of\n1. “Q?” → A'), null)
  assert.equal(parseBuriedAnswersMessage("Answers to earlier questions:\n1. just an answer"), null)
  assert.equal(parseBuriedAnswersMessage("Answers to earlier questions:\nprose first\n1. “Q?” → A"), null)
  assert.equal(parseBuriedAnswersMessage("Answers to earlier questions:"), null)
  assert.equal(parseBuriedAnswersMessage("Answers:\n1. A"), null) // the live form is the other parser's
  assert.equal(parseBuriedAnswersMessage(""), null)
})

test("parseAnswersCard accepts either wire form", () => {
  assert.equal(parseAnswersCard('Answers to earlier questions:\n1. “Q?” → A')?.[0].question, "Q?")
  assert.equal(parseAnswersCard("Answers:\n1. A")?.[0].answer, "A")
  assert.equal(parseAnswersCard("plain follow-up"), null)
})

// ---- pairAnswersMessage (question↔answer correlation for the AnswersCard) ----
const user = (text: string): MsgLike => ({ role: "user", text })
const asst = (text: string): MsgLike => ({ role: "assistant", text })
const event = (text = "Agent finished"): MsgLike => ({ role: "assistant", kind: "event", text })
// An assistant message carrying one ```question block per body, in the frizz worker convention
// (context prose, then trailing lettered options).
const qmsg = (...bodies: string[]): MsgLike => asst(bodies.map((b) => "```question\n" + b + "\n```").join("\n\n"))

test("pairs answer N with question-block N of the immediately-preceding assistant message", () => {
  const msgs = [qmsg("Q1 — install policy?\n- A. soft\n- B. hard", "Q2 — trigger?\n- A. schema\n- B. flag"), user("Answers:\n1. B. hard\n2. A. schema")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.length, 2)
  assert.equal(paired?.[0].question, "Q1 — install policy?") // options stripped — context prose only
  assert.equal(paired?.[0].answer, "B. hard")
  assert.equal(paired?.[1].question, "Q2 — trigger?")
  assert.equal(paired?.[1].answer, "A. schema")
})

test("skips event punctuation and tool-only (text-less) turns during the lookback", () => {
  const msgs = [qmsg("Pick one?\n- A. x\n- B. y"), event(), asst(""), user("Answers:\n1. A. x")]
  const paired = pairAnswersMessage(msgs, 3)
  assert.equal(paired?.[0].question, "Pick one?")
})

test("scans past a prose-only assistant message to the nearest question-bearing one", () => {
  const msgs = [qmsg("Pick one?\n- A. x"), asst("One more note before you answer."), user("Answers:\n1. A. x")]
  const paired = pairAnswersMessage(msgs, 2)
  assert.equal(paired?.[0].question, "Pick one?")
})

test("an intervening user message stops the lookback → unpaired numbered fallback", () => {
  const msgs = [qmsg("Old ask?\n- A. x"), user("something unrelated"), user("Answers:\n1. A. x")]
  const paired = pairAnswersMessage(msgs, 2)
  assert.equal(paired?.length, 1)
  assert.equal(paired?.[0].question, undefined) // those questions were already claimed — never mislabel
})

test("an out-of-range answer number degrades to unpaired rows (never the wrong question)", () => {
  const msgs = [qmsg("Only one?\n- A. x"), user("Answers:\n1. A. x\n2. B. y")] // n=2 but only one block
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.length, 2)
  assert.ok(paired?.every((p) => p.question === undefined))
})

test("a PARTIAL answer set pairs by the answer's own number (sendAnswers keeps original block numbers)", () => {
  // Three-block ask, only block 2 answered → "Answers:\n2. …" must pair with the SECOND question.
  const msgs = [qmsg("First?\n- A. x", "Second?\n- B. y", "Third?\n- C. z"), user("Answers:\n2. B. y")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.length, 1)
  assert.equal(paired?.[0].n, 2)
  assert.equal(paired?.[0].question, "Second?")
})

test("non-increasing answer numbers (hand-typed) degrade to unpaired rows", () => {
  const msgs = [qmsg("First?\n- A. x", "Second?\n- B. y"), user("Answers:\n2. B\n1. A")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.ok(paired?.every((p) => p.question === undefined))
})

test("no preceding question message at all → unpaired rows", () => {
  const paired = pairAnswersMessage([user("Answers:\n1. A. x")], 0)
  assert.equal(paired?.length, 1)
  assert.equal(paired?.[0].question, undefined)
})

test("a non-answers message returns null (the caller renders the plain bubble)", () => {
  assert.equal(pairAnswersMessage([qmsg("Q?"), user("plain follow-up")], 1), null)
  assert.equal(pairAnswersMessage([qmsg("Q?"), asst("Answers:\n1. A")], 1), null) // wrong role
})

test("a one-block ask's answer pairs and cards up (the numbered form composeAnswerWire now always sends)", () => {
  const msgs = [qmsg("Delete the orphaned binaries?\n- A. Yes, delete them\n- B. Leave them"), user("Answers:\n1. A. Yes, delete them")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.length, 1)
  assert.equal(paired?.[0].question, "Delete the orphaned binaries?")
  assert.equal(paired?.[0].answer, "A. Yes, delete them")
})

// ---- legacy bare single answers (pre-numbering transcripts) ----

test("a LEGACY bare answer matching a one-block ask's option still cards up", () => {
  const msgs = [qmsg("Delete the orphaned binaries?\n- A. Yes, delete them\n- B. Leave them"), user("A. Yes, delete them")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.deepEqual(paired, [{ n: 1, answer: "A. Yes, delete them", question: "Delete the orphaned binaries?" }])
})

test("a bare reply that matches NO option keeps its plain bubble (never box an ordinary steer)", () => {
  const msgs = [qmsg("Delete them?\n- A. Yes\n- B. No"), user("Neither — check whether anything still links them first.")]
  assert.equal(pairAnswersMessage(msgs, 1), null)
})

test("a bare option match against a MULTI-block ask is not recovered (that form was always numbered)", () => {
  const msgs = [qmsg("First?\n- A. x\n- B. y", "Second?\n- A. p\n- B. q"), user("A. x")]
  assert.equal(pairAnswersMessage(msgs, 1), null)
})

test("a bare option match does not reach across an intervening human turn", () => {
  const msgs = [qmsg("Pick?\n- A. x\n- B. y"), user("hold on"), user("A. x")]
  assert.equal(pairAnswersMessage(msgs, 2), null)
})

test("a bare answer with no preceding ask at all stays a plain bubble", () => {
  assert.equal(pairAnswersMessage([user("A. x")], 0), null)
})

test("a CR-separated answers message still pairs (normalization happens inside)", () => {
  const msgs = [qmsg("Pick?\n- A. x", "Also?\n- B. y"), user("Answers:\r1. A. x\r2. B. y")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.[0].question, "Pick?")
  assert.equal(paired?.[1].question, "Also?")
})

test("pairAllAnswers: null at ordinary indices, pairing at answers indices", () => {
  const msgs = [qmsg("Pick?\n- A. x"), asst("prose"), user("Answers:\n1. A. x")]
  const all = pairAllAnswers(msgs)
  assert.deepEqual([all[0], all[1]], [null, null])
  assert.equal(all[2]?.[0].question, "Pick?")
})

test("the buried form pairs from its OWN quoted questions, ignoring the lookback entirely", () => {
  // Two asks buried behind an intervening human turn — the lookback would stop at that turn and drop
  // every question (or, worse, number-map onto the nearest ask). The inline quotes win instead.
  const msgs = [
    qmsg("Old ask — which database?\n- A. Postgres"),
    user("actually hold on"),
    qmsg("Newer ask — ship it?\n- A. Yes"),
    asst("still working…"),
    user('Answers to earlier questions:\n1. “Old ask — which database?” → A. Postgres\n2. “Newer ask — ship it?” → A. Yes'),
  ]
  const paired = pairAnswersMessage(msgs, 4)
  assert.equal(paired?.length, 2)
  assert.equal(paired?.[0].question, "Old ask — which database?")
  assert.equal(paired?.[0].answer, "A. Postgres")
  assert.equal(paired?.[1].question, "Newer ask — ship it?")
  assert.equal(paired?.[1].answer, "A. Yes")
})

// The clock note frizz appends to a late human reply (humanGapNote) lives in the worker's record and so
// in `text`; the server projects it away into `displayText`. The pairing must read the projection, or
// the note rides into the card as a continuation line of the last answer — which is exactly what the
// maintainer saw (2026-08-25) under their chosen option.
const GAP_NOTE = "\n\n⏱ Frizz: the message above arrived 4h9m after your last one. It is now 2026-08-25 16:39."
const userWithNote = (text: string): MsgLike => ({ role: "user", text: text + GAP_NOTE, displayText: text })

test("an answers turn carrying frizz's clock note pairs from displayText — the note never reaches the card", () => {
  const ask = "Auto-charging means the run gate must accept a subscription the customer never clicked through. How wide should that opening be?\n- A. Wide\n- B. Same column, but the gate honours it only for rows stamped before a hard cutoff date"
  const msgs = [qmsg(ask), userWithNote("Answers:\n1. B. Same column, but the gate honours it only for rows stamped before a hard cutoff date")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.length, 1)
  assert.equal(paired?.[0].answer, "B. Same column, but the gate honours it only for rows stamped before a hard cutoff date")
  assert.equal(paired?.[0].question, "Auto-charging means the run gate must accept a subscription the customer never clicked through. How wide should that opening be?")
  // Negative control: the raw record DOES carry the note, and reading it would have leaked it.
  assert.match(msgs[1].text, /It is now 2026-08-25 16:39\.$/)
  assert.equal(parseAnswersMessage(msgs[1].text)?.[0].answer.includes("It is now"), true)
})

test("the buried form and the legacy bare-chip form read displayText the same way", () => {
  const buried = pairAnswersMessage([userWithNote('Answers to earlier questions:\n1. “Ship it?” → A. Yes')], 0)
  assert.deepEqual(buried, [{ n: 1, answer: "A. Yes", question: "Ship it?" }])
  // A bare chip click is recovered by BYTE-IDENTITY with an option label; with the note on the raw
  // text it matched nothing and the answer fell back to a plain bubble.
  const chip = pairAnswersMessage([qmsg("Pick?\n- A. x\n- B. y"), userWithNote("B. y")], 1)
  assert.deepEqual(chip, [{ n: 1, answer: "B. y", question: "Pick?" }])
})

test("a user turn with no projection still reads its raw text", () => {
  const paired = pairAnswersMessage([qmsg("Pick?\n- A. x"), user("Answers:\n1. A. x")], 1)
  assert.equal(paired?.[0].answer, "A. x")
})

// ---- unrenderedAnswers (the in-flight card stands down once the transcript draws the answer) -------
//
// The 2026-09-01 double render: the human answers a registered question, frizz's delivery lands in the
// worker's own queue (a `queue-operation enqueue`, which the transcript draws as this very card), and
// `answersInFlight` is still set because it is spent by the worker RECEIVING the answer — a later event.
// So the same answer drew twice, in two identical dimmed cards, for as long as the in-flight turn ran.
const WIRE = 'Answers to earlier questions:\n1. “Add a Kimi key, or leave the cells off?” → just test it ad hoc'

test("unrenderedAnswers: with nothing on screen the whole in-flight card still has to draw", () => {
  assert.deepEqual(unrenderedAnswers([user("go")], WIRE), [
    { n: 1, answer: "just test it ad hoc", question: "Add a Kimi key, or leave the cells off?" },
  ])
})

test("unrenderedAnswers: the transcript's own copy of the delivery retires the pinned card", () => {
  assert.equal(unrenderedAnswers([user("go"), user(WIRE)], WIRE), null)
})

test("unrenderedAnswers: frizz's riders on the delivered copy do not defeat the match", () => {
  const delivered: MsgLike = { role: "user", text: `${WIRE}${GAP_NOTE}`, displayText: WIRE }
  assert.equal(unrenderedAnswers([delivered], WIRE), null)
})

// The board composes ONE message from every unspent row; the scheduler delivers per BATCH. A half
// delivered pair must leave the pinned card saying the half nobody can see yet — not all of it, and
// not none of it.
test("unrenderedAnswers: a partly delivered batch keeps only the rows still unseen", () => {
  const both = 'Answers to earlier questions:\n1. “First?” → A\n2. “Second?” → B'
  const delivered = user('Answers to earlier questions:\n1. “First?” → A')
  assert.deepEqual(unrenderedAnswers([delivered], both), [{ n: 2, answer: "B", question: "Second?" }])
})

// The abuse-monitor thread, 2026-10-19: two answers reached the worker mid-turn, and the human dismissed a
// third question five seconds later. The board's message carried all three; the transcript drew the two
// answers, and the dismissal alone was left — a row the card never draws, so it drew an EMPTY card.
test("unrenderedAnswers: a dismissal is never the only thing left to draw", () => {
  const answered = [
    { questionId: "q1", question: "Merge it?", chosen: ["Merge it"], handle: "merge" },
    { questionId: "q2", question: "Have a cert?", chosen: [], text: "Not sure", handle: "cert" },
  ]
  const delivered = user(questionAnswerMessage(answered))
  const wire = questionAnswerMessage(answered, [{ question: "Mint or store?", handle: "creds" }])
  assert.equal(unrenderedAnswers([delivered], wire), null)
  // Negative control: the dismissal IS an unseen row, and it is exactly what would have drawn.
  assert.equal(parseAnswersCard(wire)?.filter((a) => a.answer === DISMISSED_ANSWER).length, 1)
  // With an unseen ANSWER beside it the card still draws, and the dismissal rides along as before.
  const partly = user(questionAnswerMessage(answered.slice(0, 1)))
  assert.deepEqual(unrenderedAnswers([partly], wire)?.map((a) => a.handle), ["cert", "creds"])
  // Nothing on screen at all: still the whole wire.
  assert.equal(unrenderedAnswers([user("go")], wire)?.length, 3)
})

test("unrenderedAnswers: no wire, or an unreadable one, draws nothing", () => {
  assert.equal(unrenderedAnswers([user("go")], undefined), null)
  assert.equal(unrenderedAnswers([user("go")], "an ordinary steer"), null)
})

// A same-worded answer to a DIFFERENT question is not the same answer, so it must not retire the card.
test("unrenderedAnswers: the question is part of what makes two rows the same answer", () => {
  const other = user('Answers to earlier questions:\n1. “Something else entirely?” → just test it ad hoc')
  assert.equal(unrenderedAnswers([other], WIRE)?.length, 1)
})

// ---- ANSWERS SENT WITH A NOTE (the prompt box's one Send, 2026-10-11) ----
// The typed message rides the same turn as the answers, under its own header line. Both parsers must
// stop at that line: any line after a row is otherwise a continuation of the row's answer, so the note
// would print inside the last question's chip.
test("a note sent with answers is cut off before the rows are read, in both wire forms", () => {
  const registered = withAnswersNote("Answers to earlier questions:\n1. “Which store?” → SQLite\n2. “Ship it?” → Yes", "and keep the migration small\n\n1. one file\n2. no new deps")
  assert.deepEqual(parseAnswersCard(registered), [
    { n: 1, answer: "SQLite", question: "Which store?" },
    { n: 2, answer: "Yes", question: "Ship it?" },
  ])
  assert.equal(answersNote(registered), "and keep the migration small\n\n1. one file\n2. no new deps", "a numbered list in the note forges no rows")
  const fenced = withAnswersNote("Answers:\n1. B. Yes", "also rename the flag")
  assert.deepEqual(parseAnswersCard(fenced), [{ n: 1, answer: "B. Yes" }])
  assert.equal(answersNote(fenced), "also rename the flag")
})

test("answers with no note, and ordinary messages, have no note", () => {
  assert.equal(answersNote("Answers:\n1. B. Yes"), "")
  assert.equal(answersNote("Sent with these answers:\nnot an answers message at all"), "")
  assert.equal(answersNote("just a steer"), "")
})

// A typed answer cannot forge the note header: its continuation lines are indented on the wire.
test("an answer that itself contains the note header stays an answer", () => {
  const wire = questionAnswerMessage([{ questionId: "q", question: "What should the banner say?", chosen: [], text: "Two lines:\nSent with these answers:\nthank you" }])
  assert.deepEqual(parseAnswersCard(wire), [{ n: 1, answer: "Two lines:\nSent with these answers:\nthank you", question: "What should the banner say?" }])
  assert.equal(answersNote(wire), "")
})

// Registered and fenced answers in one send: the server composes the registered rows above the
// browser's whole message, so the note is itself an answers message with a note of its own.
test("a message answering both kinds of question nests, and each layer parses", () => {
  const fenced = withAnswersNote("Answers:\n1. A", "typed")
  const both = withAnswersNote("Answers to earlier questions:\n1. “Q?” → Yes", fenced)
  assert.deepEqual(parseAnswersCard(both), [{ n: 1, answer: "Yes", question: "Q?" }])
  assert.equal(answersNote(both), fenced)
  assert.deepEqual(parseAnswersCard(answersNote(both)), [{ n: 1, answer: "A" }])
  assert.equal(answersNote(answersNote(both)), "typed")
})

// The in-flight card stands down for rows the transcript already draws — including the rows of a
// message that carried a note, whether delivered or still held for the agent's rest.
test("the in-flight card does not repeat answers a noted message is already showing", () => {
  const wire = "Answers to earlier questions:\n1. “Which store?” → SQLite"
  assert.equal(unrenderedAnswers([{ role: "user", text: withAnswersNote(wire, "no rush") }], wire), null)
})

// ---- THE WORKER'S OWN ID ON A ROW (2026-10-13) ----
// A fence-asked question's answer names it by the id the worker gave it, in backticks between the row's
// number (and its follow-up marker) and the opening quote (shared answerRowId). This reader takes the id
// when it is there and never requires it: every transcript on disk, every question `ask` registered and
// the browser's own composeAnswerWire write rows without one. The CARD does not draw it.
const M = ANSWER_FOLLOW_UP_MARKER
const idWire = [
  BURIED_ANSWERS_HEADER,
  "1. `store` “SQLite or a JSON file?” → SQLite",
  `2. ${M} \`sqlite-path\` “Which path?” → Beside the sessions database`,
  `3. ${M} \`sqlite-wal\` “Turn on WAL?” → Yes`,
  "4. `retries` “How many retries?” → 3",
  `5. \`flag-name\` “Name the flag?” → ${DISMISSED_ANSWER}`,
].join("\n")

test("a row's id is read off its head, and the question and answer are exactly what they were without it", () => {
  const rows = parseBuriedAnswersMessage(idWire)
  assert.deepEqual(rows, [
    { n: 1, answer: "SQLite", question: "SQLite or a JSON file?", handle: "store" },
    { n: 2, answer: "Beside the sessions database", question: "Which path?", followUp: true, handle: "sqlite-path" },
    { n: 3, answer: "Yes", question: "Turn on WAL?", followUp: true, handle: "sqlite-wal" },
    { n: 4, answer: "3", question: "How many retries?", handle: "retries" },
    { n: 5, answer: DISMISSED_ANSWER, question: "Name the flag?", handle: "flag-name" },
  ])
  // THE SAME ROWS WITHOUT THEIR IDS are the old form, and read to the same card, field for field.
  const old = parseBuriedAnswersMessage(idWire.replace(/`[a-z-]+` “/g, "“"))
  assert.deepEqual(old, rows!.map(({ handle: _handle, ...row }) => row))
  // The human's card: the dismissal is left out as ever, and nothing the card prints holds an id.
  const shown = answersForDisplay(rows!)
  assert.deepEqual(shown.map((a) => a.question), ["SQLite or a JSON file?", "Which path?", "Turn on WAL?", "How many retries?"])
  for (const a of shown) assert.doesNotMatch(`${a.question} ${a.answer}`, /`/)
  assert.equal(isAnswersMessage({ role: "user", text: idWire }), true, "it is still the human's own answer, not a notification")
})

test("the server's wake for a fence-asked tree round-trips: two same-worded follow-ups come back under their own ids", () => {
  const fence = (lines: string[]) => `\`\`\`question\n${lines.join("\n")}\n\`\`\``
  const asked = questionFencesIn([
    fence(["id: store", "kind: choice", "question: SQLite or a JSON file?", "options:", "  - SQLite", "  - JSON file"]),
    fence(["id: sqlite-path", "kind: text", "when: store = SQLite", "question: Which path?"]),
    fence(["id: json-path", "kind: text", "when: store = JSON file", "question: Which path?"]),
    fence(["id: cache", "kind: choice", "question: Cache on disk?", "options:", "  - Yes", "  - No"]),
    fence(["id: cache-path", "kind: text", "when: cache = Yes", "question: Which path?"]),
  ].join("\n\n"))
  assert.deepEqual(asked.faults, [])
  const [store, cache] = asked.asks
  const answers: QuestionAnswer[] = [
    { questionId: "q1", question: "SQLite or a JSON file?", chosen: ["JSON file"], followUps: [{ questionId: "q1", question: "Which path?", chosen: [], text: "/tmp" }] },
    { questionId: "q2", question: "Cache on disk?", chosen: ["Yes"], followUps: [{ questionId: "q2", question: "Which path?", chosen: [], text: "/tmp" }] },
  ]
  const wire = questionAnswerMessage([nameQuestionAnswer(answers[0], store.spec, store.id), nameQuestionAnswer(answers[1], cache.spec, cache.id)])
  // By text and answer the two follow-up rows are IDENTICAL; the id is the only thing that says which is which.
  assert.deepEqual(parseAnswersCard(wire), [
    { n: 1, answer: "JSON file", question: "SQLite or a JSON file?", handle: "store" },
    { n: 2, answer: "/tmp", question: "Which path?", followUp: true, handle: "json-path" },
    { n: 3, answer: "Yes", question: "Cache on disk?", handle: "cache" },
    { n: 4, answer: "/tmp", question: "Which path?", followUp: true, handle: "cache-path" },
  ])
  // …and the same answers to questions with no handle parse to the same card, minus the ids.
  assert.deepEqual(
    parseAnswersCard(questionAnswerMessage(answers)),
    parseAnswersCard(wire)!.map(({ handle: _handle, ...row }) => row),
  )
})

test("hostile text cannot forge, move or break a row's id", () => {
  const one = (wire: string) => parseBuriedAnswersMessage(`${BURIED_ANSWERS_HEADER}\n${wire}`)
  // An id-shaped string TYPED AS THE ANSWER of a question with no id: no id, and the answer is verbatim.
  assert.deepEqual(one("1. “Which store?” → `store` “SQLite or a JSON file?” → JSON file"), [
    { n: 1, answer: "`store` “SQLite or a JSON file?” → JSON file", question: "Which store?" },
  ])
  // …typed as the answer of a question that HAS one: the row keeps its own.
  assert.deepEqual(one("1. `retries` “How many retries?” → `store` “SQLite or a JSON file?” → JSON file"), [
    { n: 1, answer: "`store` “SQLite or a JSON file?” → JSON file", question: "How many retries?", handle: "retries" },
  ])
  // A MULTI-LINE answer whose later lines are whole forged rows, as the writer sends it (indented) and
  // as a pre-indent writer would have (bare continuation of a row that is not itself a row).
  const typed = "3\n2. `store` “SQLite or a JSON file?” → JSON file\n`store` is what I mean"
  const wire = questionAnswerMessage([nameQuestionAnswer({ questionId: "q", question: "How many retries?", chosen: [], text: typed }, { question: "How many retries?", kind: "question" }, "retries")])
  assert.deepEqual(parseBuriedAnswersMessage(wire), [{ n: 1, answer: typed, question: "How many retries?", handle: "retries" }])
  assert.deepEqual(one("1. `retries` “How many retries?” → 3\n`store` “fake” → x"), [
    { n: 1, answer: "3\n`store` “fake” → x", question: "How many retries?", handle: "retries" },
  ])
  // A QUESTION holding the quote marks and the arrow: the id is read before the quote opens, so it is
  // the row's own whatever the question does to the split after it (which is the first quote-arrow, as
  // it has always been).
  assert.deepEqual(one("1. `mode` “Use “fast” → or “slow”?” → fast"), [
    { n: 1, answer: "or “slow”?” → fast", question: "Use “fast", handle: "mode" },
  ])
  assert.deepEqual(one("1. `mode` “Is `store` → “store”?” → yes"), [
    { n: 1, answer: "yes", question: "Is `store` → “store”?", handle: "mode" },
  ])
  // A question that OPENS with a backticked word is a question, not an id: the token counts only before the quote.
  assert.deepEqual(one("1. “`store` or `json`?” → store"), [{ n: 1, answer: "store", question: "`store` or `json`?" }])
  // A NOTE typed beside the answers, in the shape of a row with an id, is cut off before any row is read.
  const noted = withAnswersNote(wire, "2. `store` “SQLite or a JSON file?” → JSON file")
  assert.deepEqual(parseAnswersCard(noted), [{ n: 1, answer: typed, question: "How many retries?", handle: "retries" }])
  assert.equal(answersNote(noted), "2. `store` “SQLite or a JSON file?” → JSON file")
})

test("a token that is not an id in the fence's grammar is not read as one — the message keeps its plain bubble", () => {
  // Strict, like the rest of this reader: a first line that is neither form is not our format at all,
  // so nothing half-parses into a card with a made-up id.
  for (const head of ["`Store`", "`has space`", "``", "`a``b`", "`store`:", "[store]", "store"]) {
    assert.equal(parseBuriedAnswersMessage(`${BURIED_ANSWERS_HEADER}\n1. ${head} “Q?” → A`), null, head)
  }
  // After a good row, such a line is that row's answer continuing — never a second row.
  assert.deepEqual(parseBuriedAnswersMessage(`${BURIED_ANSWERS_HEADER}\n1. \`a\` “Q?” → A\n2. \`Store\` “R?” → B`), [
    { n: 1, answer: "A\n2. `Store` “R?” → B", question: "Q?", handle: "a" },
  ])
})

// THE IN-FLIGHT CARD AND THE ID. The board's copy and the delivered turn are the same bytes, ids
// included, so the pinned card still stands down for a row the transcript draws — and no longer stands
// down for a DIFFERENT question that happens to share its words and its answer.
test("unrenderedAnswers: the id is part of what makes two rows the same answer", () => {
  const a = `${BURIED_ANSWERS_HEADER}\n1. \`sqlite-path\` “Which path?” → /tmp`
  const b = `${BURIED_ANSWERS_HEADER}\n1. \`cache-path\` “Which path?” → /tmp`
  assert.equal(unrenderedAnswers([user(a)], a), null, "its own delivery retires it")
  assert.deepEqual(unrenderedAnswers([user(a)], b), [{ n: 1, answer: "/tmp", question: "Which path?", handle: "cache-path" }], "another question's does not")
  // A half-delivered pair of same-worded rows leaves exactly the one nobody can see yet.
  const both = `${BURIED_ANSWERS_HEADER}\n1. \`sqlite-path\` “Which path?” → /tmp\n2. \`cache-path\` “Which path?” → /tmp`
  assert.deepEqual(unrenderedAnswers([user(a)], both)?.map((r) => r.handle), ["cache-path"])
  // Rows with no id match as they always did.
  const plain = `${BURIED_ANSWERS_HEADER}\n1. “Which path?” → /tmp`
  assert.equal(unrenderedAnswers([user(plain)], plain), null)
})

test("the browser's own writer still writes rows with no id, and they still read", () => {
  // composeAnswerWire answers a question written in a pre-cutover fence, which has no id to name.
  const wire = composeAnswerWire({ answered: [{ isLive: false, question: "Which store?", answer: "`store`" }] })
  assert.equal(wire, `${BURIED_ANSWERS_HEADER}\n1. “Which store?” → \`store\``)
  assert.deepEqual(parseBuriedAnswersMessage(wire), [{ n: 1, answer: "`store`", question: "Which store?" }])
})

// The human's × rides their next send (router pendingDismissals), and the card hides a dismissed row, so
// a send carrying nothing else would draw as an empty Answers card over their words.
test("a send whose only rows are dismissals draws as the words the human typed", () => {
  const dismissed = questionAnswerMessage([{ questionId: "q", question: "Which store?", chosen: ["SQLite"] }], []).replace(/1\. .*$/m, `1. “Which name?” → ${DISMISSED_ANSWER}`)
  const wire = withAnswersNote(dismissed, "carry on with the tests")
  assert.deepEqual(userSendShown(wire, parseAnswersCard(wire)), { text: "carry on with the tests", answers: null })
  // …and as a card again when what they typed is itself an answers wire (fenced answers, composed in the browser).
  const nested = withAnswersNote(dismissed, "Answers:\n1. B. Preload it")
  assert.deepEqual(userSendShown(nested, parseAnswersCard(nested)).answers?.map((a) => a.answer), ["B. Preload it"])
  // A send with a real answer in it draws as it always did.
  const answered = withAnswersNote(questionAnswerMessage([{ questionId: "q", question: "Which store?", chosen: ["SQLite"] }], [{ question: "Which name?" }]), "and keep it small")
  assert.equal(userSendShown(answered, parseAnswersCard(answered)).text, answered)
  // A plain bubble is untouched.
  assert.deepEqual(userSendShown("just words", null), { text: "just words", answers: null })
})
