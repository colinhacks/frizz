import { test } from "node:test"
import assert from "node:assert/strict"
import { BURIED_ANSWERS_HEADER, isHumanTypedMessage, questionAnswerMessage, repliesStepsDone, stepsReportOf, withAnswersNote } from "@frizz/shared"
import { owesSteps, repliedSteps, stepsDoneReplies, stepsReport, withStepsReport } from "./stepsAnswer.ts"

// Every shape the prompt box's one send gives a report (ThreadComposerBox `send`): the word alone, the
// word over a typed note, under the fenced answers' wire, and under the server's registered answers too.
const FENCED = `${BURIED_ANSWERS_HEADER}\n1. “Which ORM should the docs examples use?” → A. Drizzle`
const REGISTERED = questionAnswerMessage([{ questionId: "qst_changelog001", handle: "changelog", question: "What should the changelog entry say?", chosen: [], text: "Redesigned docs" }])
const ALL = [{ text: "Sign in.", done: true }, { text: "Approve it.", done: true }]
const SOME = [{ text: "Sign in.", done: true }, { text: "Approve it.", done: false }]

test("a report is the bare word when everything is done, and a checklist when some is not", () => {
  assert.equal(withStepsReport(ALL, ""), "Done")
  assert.equal(withStepsReport(ALL, "  Used the bot account. "), "Done\n\nUsed the bot account.")
  assert.equal(withStepsReport(SOME, ""), "Done 1 of 2:\n- [x] Sign in.\n- [ ] Approve it.")
  assert.equal(withStepsReport(SOME, "The prompt never came."), "Done 1 of 2:\n- [x] Sign in.\n- [ ] Approve it.\n\nThe prompt never came.")
})

test("a report says what is still owed and what is new, and not what the worker already knows", () => {
  const todos = [
    { id: "old", done: true, staged: false },
    { id: "new", done: true, staged: true },
    { id: "owed", done: false, staged: false },
    { id: "undone", done: false, staged: true },
  ]
  assert.deepEqual(stepsReport(todos).map((todo) => todo.id), ["new", "owed", "undone"])
})

test("a reply is a report when its words open the human's own, under any answers that rode with it", () => {
  for (const reply of [
    withStepsReport(ALL, ""),
    withStepsReport(ALL, "Approved it from the owner account."),
    withAnswersNote(FENCED, withStepsReport(ALL, "")),
    withAnswersNote(REGISTERED, withStepsReport(ALL, "Approved.")),
    withAnswersNote(REGISTERED, withAnswersNote(FENCED, withStepsReport(ALL, "Approved."))),
  ]) {
    assert.equal(repliesStepsDone(reply), true, reply)
    assert.equal(repliedSteps(reply), "all", reply)
  }
  for (const reply of [withStepsReport(SOME, ""), withStepsReport(SOME, "It never came."), withAnswersNote(REGISTERED, withStepsReport(SOME, ""))]) {
    assert.deepEqual(repliedSteps(reply), new Set(["Sign in."]), reply)
    assert.equal(repliesStepsDone(reply), false, "and it does not say everything is done")
  }
})

// The server reads the same message to decide whether the human typed past the rest (shared
// isHumanTypedMessage): a report is an answer to the to-do card, and only what is typed under it is typing.
test("a report the send composes is not typing, under any answers, unless words are typed under it", () => {
  for (const report of [withStepsReport(ALL, ""), withStepsReport(SOME, "")]) {
    assert.equal(isHumanTypedMessage(report), false, report)
    assert.equal(isHumanTypedMessage(withAnswersNote(FENCED, report)), false)
    assert.equal(isHumanTypedMessage(withAnswersNote(REGISTERED, withAnswersNote(FENCED, report))), false, "nested answers, nothing typed")
  }
  assert.equal(isHumanTypedMessage(withStepsReport(SOME, "The prompt never came.")), true)
  assert.equal(isHumanTypedMessage(withAnswersNote(FENCED, withStepsReport(ALL, "Used the bot account."))), true)
  assert.equal(isHumanTypedMessage(withAnswersNote(REGISTERED, FENCED)), false, "two sets of answers and nothing typed is not typing either")
  assert.deepEqual(stepsReportOf(withStepsReport(SOME, "")), { all: false, note: "" })
  assert.deepEqual(stepsReportOf(withStepsReport(ALL, "Used the bot account.")), { all: true, note: "Used the bot account." })
  for (const typed of ["Done.", "Done, thanks", "Done 1 of 2: nearly", "Ship it"]) {
    assert.equal(stepsReportOf(typed), null, typed)
    assert.equal(isHumanTypedMessage(typed), true, typed)
  }
})

test("a reply that only mentions done, or answers without the word, is not a report", () => {
  for (const reply of [
    "Done with the copy edits, now which account?",
    "Not done yet",
    "done",
    "Done 1 of 2 maybe",
    FENCED,
    withAnswersNote(REGISTERED, "Which account should approve it?"),
    withAnswersNote(REGISTERED, FENCED),
  ]) assert.equal(repliedSteps(reply), null, reply)
})

const say = (text: string) => ({ role: "assistant", text })
const human = (text: string) => ({ role: "user", text })
const STEPS = "```awaiting\nsteps:\n  - Approve the DNS record.\n```"

test("the rest a reply answers is the agent message before it, up to the worker's next word", () => {
  const messages = [
    human("Ship it."),
    say(`Built.\n\n${STEPS}`), // 1 — answered with the whole list
    human("Done"),
    say(`Published. One more:\n\n${STEPS}`), // 3 — answered in words
    human("Which account?"),
    { role: "assistant", kind: "event", text: "A sub-agent finished." },
    say(`The owner account.\n\n${STEPS}`), // 6 — part of the list, with a note, under answers
    human(withAnswersNote(FENCED, withStepsReport(SOME, "Half of it."))),
    say("Thanks."), // 8 — no fence, so no reply can make it one
    human("Done"),
  ].map((m) => ({ kind: undefined, ...m })) as Parameters<typeof stepsDoneReplies>[0]
  assert.deepEqual([...stepsDoneReplies(messages)], [[1, "all"], [6, new Set(["Sign in."])]])
})

test("a reply after the worker spoke again answers that later rest, never the earlier one", () => {
  const messages = [
    say(`Built.\n\n${STEPS}`),
    human("A timer fired."),
    say("Still waiting on the DNS record."),
    human("Done"),
  ].map((m) => ({ kind: undefined, ...m })) as Parameters<typeof stepsDoneReplies>[0]
  assert.deepEqual([...stepsDoneReplies(messages)], [])
})

test("a reply the worker took in mid-turn answers the rest it was sent to, below whatever the worker did first", () => {
  // The nub thread of 2026-11-11, as its transcript projects: a shell finished 14ms before the human sent
  // "Done", the worker woke and made a tool call, and the reply was drawn where the worker took it in.
  const at = (time: string) => `2026-11-12T${time}Z`
  const messages = [
    { role: "assistant", text: `Building it.\n\n${STEPS}`, at: at("06:45:16.545") }, // 0 — the first rest
    { role: "assistant", text: `Partway there.\n\n${STEPS}`, at: at("06:57:11.070") }, // 1 — the rest the human answered
    { role: "assistant", kind: "event", text: "Agent rested", at: at("06:57:11.070") },
    { role: "assistant", kind: "event", text: "Background task «Starting the second sign-in» finished", at: at("06:58:11.560") },
    { role: "assistant", text: "", at: at("06:58:15.513") }, // a tool call, made before the worker took the reply in
    { role: "user", text: "Done", at: at("06:58:11.574") },
    { role: "assistant", text: "Checked the route; merging now.", at: at("06:58:51.950") },
  ].map((m) => ({ kind: undefined, ...m })) as Parameters<typeof stepsDoneReplies>[0]
  assert.deepEqual([...stepsDoneReplies(messages)], [[1, "all"]])
})

test("what the worker said after the reply was sent never takes it, and what it said before still does", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 12, 7, 0, s)).toISOString()
  const afterSend = [
    { role: "assistant", text: `Built.\n\n${STEPS}`, at: at(0) },
    { role: "assistant", text: "The build finished; checking the record.", at: at(20) },
    { role: "user", text: "Done", at: at(10) },
  ].map((m) => ({ kind: undefined, ...m })) as Parameters<typeof stepsDoneReplies>[0]
  assert.deepEqual([...stepsDoneReplies(afterSend)], [[0, "all"]], "written after the send: the human never saw it")
  const beforeSend = [
    { role: "assistant", text: `Built.\n\n${STEPS}`, at: at(0) },
    { role: "assistant", text: "Still waiting on the DNS record.", at: at(5) },
    { role: "user", text: "Done", at: at(10) },
  ].map((m) => ({ kind: undefined, ...m })) as Parameters<typeof stepsDoneReplies>[0]
  assert.deepEqual([...stepsDoneReplies(beforeSend)], [], "written before it: the reply answers that, not the steps")
})

// The phone bar's Done means "archive the thread", so it is not offered beside boxes still owed — including
// the ones a quiet park left owed behind a last fence that names no steps (2026-11-11).
test("owesSteps: the last fence's steps, or anything the to-do list has not ticked", () => {
  const park = { kind: "awaiting" as const, body: "", hints: [{ kind: "status" as const, value: "watching" }] }
  const steps = { kind: "awaiting" as const, body: "", hints: [{ kind: "step" as const, value: "Sign in" }] }
  assert.equal(owesSteps({ lastFence: steps }), true)
  assert.equal(owesSteps({ lastFence: park, humanTodos: [{ id: "a", text: "Sign in", done: false, staged: false }] }), true)
  assert.equal(owesSteps({ lastFence: park, humanTodos: [{ id: "a", text: "Sign in", done: true, staged: false }] }), false)
  assert.equal(owesSteps({ lastFence: park }), false)
  assert.equal(owesSteps(undefined), false)
})
