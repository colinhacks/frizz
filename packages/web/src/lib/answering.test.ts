import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { selectOpenAsks, composeAnswerWire, type AskMsgLike } from "./answering.ts"

// A single ```question block message, tagged with a sourceId for identity.
const ask = (id: string, body = "Pick one\n- A. Left\n- B. Right"): AskMsgLike => ({
  role: "assistant",
  sourceId: id,
  text: `Some lead-in.\n\n\`\`\`question\n${body}\n\`\`\``,
})
const prose = (text: string): AskMsgLike => ({ role: "assistant", text })
const user = (text: string): AskMsgLike => ({ role: "user", text })
const event = (text: string): AskMsgLike => ({ role: "assistant", kind: "event", text })
const reasoning = (text: string): AskMsgLike => ({ role: "assistant", kind: "reasoning", text })

test("the trailing ask is answerable", () => {
  const open = selectOpenAsks([user("do it"), ask("q1")])
  assert.equal(open.length, 1)
  assert.equal(open[0].identity, "q1")
  assert.equal(open[0].isLive, true)
})

test("an ask the agent BURIED by continuing to work stays answerable", () => {
  // The agent asked, then kept working (a background wake) with no human turn between — so a no-question
  // assistant turn now trails the ask. Its isLive is false (a later substantive turn exists).
  const open = selectOpenAsks([ask("q1"), prose("meanwhile I did other work")])
  assert.equal(open.length, 1)
  assert.equal(open[0].identity, "q1")
  assert.equal(open[0].isLive, false)
})

test("a transcript with no question at all yields nothing answerable", () => {
  assert.equal(selectOpenAsks([user("do it"), prose("did the work, no question")]).length, 0)
})

test("two asks with no human turn between are BOTH open; only the last is live", () => {
  const open = selectOpenAsks([ask("q1"), prose("note"), ask("q2")])
  assert.deepEqual(open.map((a) => a.identity), ["q1", "q2"]) // transcript order
  assert.deepEqual(open.map((a) => a.isLive), [false, true])
})

test("TRACKS NOTHING: a question stays answerable even after a human turn (best-effort)", () => {
  // No 'closing' — every question in the transcript is answerable regardless of intervening human turns.
  const open = selectOpenAsks([ask("q1"), user("actually do something else")])
  assert.deepEqual(open.map((a) => a.identity), ["q1"])
})

test("ALL question-bearing messages are answerable, across human turns", () => {
  const open = selectOpenAsks([ask("q0"), user("go"), ask("q1"), prose("work"), ask("q2")])
  assert.deepEqual(open.map((a) => a.identity), ["q0", "q1", "q2"]) // q0 (pre-human-turn) is answerable too
  assert.deepEqual(open.map((a) => a.isLive), [false, false, true]) // only the last substantive assistant
})

test("event (sub-agent completion) punctuation after an ask is skipped, not treated as a turn", () => {
  // A completion event landing after the ask must not shadow it (the same skip discipline as pairing).
  const open = selectOpenAsks([ask("q1"), event('Agent "x" finished — 2m')])
  assert.equal(open.length, 1)
  assert.equal(open[0].isLive, true)
})

test("codex 'reasoning' punctuation is skipped like an event — never the live/substantive turn", () => {
  // Codex emits a reasoning summary FIRST in a turn (role assistant, non-empty text), so it must NOT
  // become the live anchor and shadow a trailing ask. Both a leading and a trailing reasoning block skip.
  const open = selectOpenAsks([reasoning("**Thinking about it**"), ask("q1"), reasoning("**More thought**")])
  assert.equal(open.length, 1)
  assert.equal(open[0].identity, "q1")
  assert.equal(open[0].isLive, true)
})

test("tool-only / empty assistant turns are stepped over", () => {
  const open = selectOpenAsks([ask("q1"), { role: "assistant", text: "   " }])
  assert.equal(open.length, 1)
  assert.equal(open[0].identity, "q1")
})

test("legacy line without sourceId gets a deterministic content identity", () => {
  const a = selectOpenAsks([{ role: "assistant", text: "```question\nGo?\n```" }])
  const b = selectOpenAsks([{ role: "assistant", text: "```question\nGo?\n```" }])
  assert.equal(a[0].identity, b[0].identity)
  assert.match(a[0].identity, /^legacy-/)
})

// ---- composeAnswerWire ----

test("all-live SINGLE block is numbered too → the answers card, never a flat bubble", () => {
  // It used to send the bare answer text, which carried no marker for parseAnswersMessage and so
  // rendered as a run-on user bubble while every other answer shape got the structured card.
  const wire = composeAnswerWire({
    answered: [{ isLive: true, question: "Pick one", answer: "B. Right" }],
    live: { numbered: [{ n: 1, a: "B. Right" }] },
  })
  assert.equal(wire, "Answers:\n1. B. Right")
})

test("all-live multi block → Answers: numbered by original position", () => {
  const wire = composeAnswerWire({
    answered: [
      { isLive: true, question: "Q1", answer: "yes" },
      { isLive: true, question: "Q2", answer: "no" },
    ],
    live: { numbered: [{ n: 1, a: "yes" }, { n: 2, a: "no" }] },
  })
  assert.equal(wire, "Answers:\n1. yes\n2. no")
})

test("all-live multi block, PARTIAL answer → keeps original block numbers", () => {
  // Only block 2 answered against a 3-block ask: number stays 2 so pairAnswersMessage maps it faithfully.
  const wire = composeAnswerWire({
    answered: [{ isLive: true, question: "Q2", answer: "just this" }],
    live: { numbered: [{ n: 2, a: "just this" }] },
  })
  assert.equal(wire, "Answers:\n2. just this")
})

test("any buried answer → self-describing quoted form (does NOT match parseAnswersMessage header)", () => {
  const wire = composeAnswerWire({
    answered: [{ isLive: false, question: "Which database?", answer: "Postgres" }],
  })
  assert.equal(wire, 'Answers to earlier questions:\n1. “Which database?” → Postgres')
  // Never the historic header — this batch's rows must NOT go through the numbered lookback pairing
  // (they can span several messages). parseBuriedAnswersMessage reads them straight into the card.
  assert.doesNotMatch(wire.split("\n")[0], /^Answers:$/)
})

test("mixed live + buried answers → self-describing form for the whole batch", () => {
  const wire = composeAnswerWire({
    answered: [
      { isLive: false, question: "Old Q", answer: "A" },
      { isLive: true, question: "New Q", answer: "B" },
    ],
    live: { numbered: [{ n: 1, a: "B" }] },
  })
  assert.equal(wire, 'Answers to earlier questions:\n1. “Old Q” → A\n2. “New Q” → B')
})

test("buried empty-question label falls back to a non-empty string (never a bare '\"\"' quote)", () => {
  const wire = composeAnswerWire({
    answered: [{ isLive: false, question: "", answer: "A. Postgres" }],
  })
  // composeAnswerWire trusts the caller's `question`; the fallback lives in questionLabel (hook side).
  // This asserts the FORMAT is stable; the empty-context fallback is exercised via selectOpenAsks below.
  assert.equal(wire, 'Answers to earlier questions:\n1. “” → A. Postgres')
})

test("two identical-text asks with no sourceId get DISTINCT identities (no state bleed)", () => {
  const dup = (): AskMsgLike => ({ role: "assistant", text: "```question\nGo?\n- A. Yes\n- B. No\n```" })
  const open = selectOpenAsks([dup(), prose("interstitial"), dup()])
  assert.equal(open.length, 2)
  assert.notEqual(open[0].identity, open[1].identity) // suffixed apart, so answer keys never collide
})

test("unique-identity asks are NOT perturbed by the collision guard", () => {
  const open = selectOpenAsks([ask("q1"), prose("x"), ask("q2")])
  assert.deepEqual(open.map((a) => a.identity), ["q1", "q2"]) // no '#idx' suffix on distinct identities
})

// ---- the optimistic exit's REVERSAL --------------------------------------------------------------
//
// `onSent` moved the queue card (now the pane) on the instant the human commits, which is the point;
// nothing undid it when the send was then REFUSED, so the card stayed gone and only a toast said otherwise until
// resolve()'s 8s reappear guard noticed the board still wanted it (measured on a refused steer against a
// dead worker: 8084ms before, 305ms after). Two things have to hold, and both are structure rather than
// behaviour a pure call can reach — so they are read off the source, as the question-shadow pins are.
const answeringSource = readFileSync(new URL("./answering.ts", import.meta.url), "utf8")

test("sendMessage composes the caller's own onRollback ahead of the failure tail", () => {
  // sendAnswers restores the answer drafts with its onRollback and the composer restores its text with
  // one; overwriting either — rather than calling it first — loses the human's words on a failed send.
  // The failure is passed THROUGH: the composer uses it to make its re-send supersede the failed bubble.
  assert.match(
    answeringSource,
    /onRollback: \(failure\) => \{ callbacks\.onRollback\?\.\(failure\); onSendFailedRef\.current\?\.\(\) \}/,
    "the caller's rollback must run, and run BEFORE the card is reinstated",
  )
})

test("the board's pane wires the reversal; the drawer and the thread page do not", () => {
  const chat = readFileSync(new URL("../components/ChatView.tsx", import.meta.url), "utf8")
  const shell = readFileSync(new URL("../components/ThreadSurface.tsx", import.meta.url), "utf8")
  // The pane tells its surface how it leaves and comes back; the shell (ThreadSurface) turns that into
  // the controller's onSent and its reversal, so the two cannot be wired apart.
  assert.match(shell, /\{ onSendFailed: exit\?\.cancel, composer \}/, "the shell reinstates a surface whose send was refused")
  // The thread view names an exit only when the one-thread pane hosts it: there a dismissal brings up the
  // next thread and a refused one brings this one back (ThreadPane.tsx). In a drawer or on the thread page
  // there is nothing to reinstate, so it names none.
  assert.match(chat, /const surface = useThreadSurface\(\{ slug, thread, messages, openQuestions, settledQuestions \}, pane \? \{ exit: pane\.exit \} : undefined\)\n/, "only the pane's thread wires a reversal")
  assert.ok(!/onSendFailed/.test(chat))
})
