import { test } from "node:test"
import assert from "node:assert/strict"
import { BURIED_ANSWERS_HEADER, questionAnswerMessage, repliesStepsDone, withAnswersNote } from "@frizz/shared"
import { repliedSteps, stepsDoneReplies, stepsReport, withStepsReport } from "./stepsAnswer.ts"

// Every shape the prompt box's one send gives a report (ThreadComposerBox `send`): the word alone, the
// word over a typed note, under the fenced answers' wire, and under the server's registered answers too.
const FENCED = `${BURIED_ANSWERS_HEADER}\n1. “Which ORM should the docs examples use?” → A. Drizzle`
const REGISTERED = questionAnswerMessage([{ handle: "changelog", question: "What should the changelog entry say?", chosen: [], text: "Redesigned docs" }])
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
