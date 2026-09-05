import { test } from "node:test"
import assert from "node:assert/strict"
import { questionAnswerMessage, questionsCancelledWakeMessage, wakeDeliveryToken } from "@frizz/shared"
import { lastAskIndex, lastHumanTurnIndex, messagePresentationText } from "./messagePresentation.ts"

test("messagePresentationText prefers a validated display projection without changing full text", () => {
  const message = { text: "compact\n\n<!-- boundary -->\n\nlarge machine tail", displayText: "compact" }
  assert.equal(messagePresentationText(message), "compact")
  assert.match(message.text, /large machine tail/)
})

test("messagePresentationText leaves ordinary messages and HTML comments untouched", () => {
  const text = "Example:\n<!-- an ordinary comment -->\nstill visible"
  assert.equal(messagePresentationText({ text }), text)
})

test("lastAskIndex pins the human's latest landed turn, never a queued one or an inter-agent message", () => {
  const ask = { role: "user" as const }
  const reply = { role: "assistant" as const }
  const report = { role: "user" as const, peerFrom: "bun_project_survey" }
  const instruction = { role: "user" as const, agentInstruction: true as const }
  const queued = { role: "user" as const, queued: true }

  assert.equal(lastAskIndex([ask, reply]), 0)
  // An orchestrator's children report continuously; each is a `user` row the human never wrote, and
  // letting one win would re-pin the current-ask band to "Sub-agent «…» reported" on every report.
  assert.equal(lastAskIndex([ask, reply, report, report]), 0)
  assert.equal(lastAskIndex([ask, reply, instruction]), 0)
  // A queued follow-up pins to the bottom until it lands, so it is not the ask either.
  assert.equal(lastAskIndex([ask, report, queued]), 0)
  // A genuine later human turn does take the pin back.
  assert.equal(lastAskIndex([ask, report, { role: "user" as const }]), 2)
  assert.equal(lastAskIndex([reply, report]), -1)
  assert.equal(lastAskIndex([]), -1)
})

// The queue card's window anchor. Built from the SERVER's own composers rather than a transcription of
// their output: the whole reason this can be got wrong is that an answer looks like frizz's own writing
// on the wire, so a fixture that only resembles one would pin nothing.
const ask = { role: "user" as const, text: "Go" }
const reply = { role: "assistant" as const, text: "Working on it." }
// A real delivery: frizz's clock note and the machine token ride on `text`, and the server strips both
// into `displayText` (transcript.ts userDisplayText). The rule has to read the projection — on the raw
// text the clock note glues itself to the last answer as a continuation line.
const delivered = (message: string) => ({
  role: "user" as const,
  wake: true,
  text: `${message}\n\n⏱ 2026-08-31 15:51 — you last spoke 4h29m ago.\n\n${wakeDeliveryToken("a".repeat(64))}`,
  displayText: message,
})
const answer = delivered(questionAnswerMessage([
  { questionId: "qst_1", question: "Push it to GitHub now, or leave it local?", chosen: ["Push it to origin/main"] },
]))

test("lastHumanTurnIndex: an answer to a REGISTERED question is an interaction, though frizz delivered it", () => {
  // The reported defect (2026-08-31): the card walked past the answer, back to "Go", and repainted the
  // whole already-answered iteration above the one the answer produced.
  assert.equal(lastHumanTurnIndex([ask, reply, answer, reply]), 2)
  // …and it still wins over everything frizz genuinely wrote after it.
  const goal = delivered("⏰ Frizz: your goal is still armed — keep going.")
  assert.equal(lastHumanTurnIndex([ask, reply, answer, reply, goal, reply]), 2)
})

test("lastHumanTurnIndex: every other user record frizz or a child wrote is skipped", () => {
  const goal = delivered("⏰ Frizz: your goal is still armed — keep going.")
  const report = { role: "user" as const, text: "child reporting in", peerFrom: "frizz:high" }
  const instruction = { role: "user" as const, text: "coordinator follow-up", agentInstruction: true as const }
  const queued = { role: "user" as const, text: "and one more thing", queued: true }
  // Nobody answered — the autonomous-thread cancellation. Frizz's own news, in frizz's own voice, so it
  // is not an interaction however close its delivery path is to the answer above.
  const cancelled = delivered(questionsCancelledWakeMessage(2))

  assert.equal(lastHumanTurnIndex([ask, reply, goal, reply]), 0)
  assert.equal(lastHumanTurnIndex([ask, reply, report]), 0)
  assert.equal(lastHumanTurnIndex([ask, reply, instruction]), 0)
  assert.equal(lastHumanTurnIndex([ask, reply, queued]), 0)
  assert.equal(lastHumanTurnIndex([ask, reply, cancelled, reply]), 0)
  // A typed steer is an interaction like any other, and takes the anchor back from the answer.
  assert.equal(lastHumanTurnIndex([ask, reply, answer, reply, { role: "user" as const, text: "now push" }]), 4)
  // Nothing the human wrote yet → the whole loaded window, so the card never opens mid-conversation.
  assert.equal(lastHumanTurnIndex([reply, goal, report, instruction]), 0)
  assert.equal(lastHumanTurnIndex([]), 0)
})
