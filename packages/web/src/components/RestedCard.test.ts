import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RestedCard, showsRestedCard, type RestedCardThread } from "./RestedCard.tsx"

// The residual rung fires when NO other card does. What these pin is the exclusion list: every state
// that already has a card must keep this one off, or the bottom of a thread shows two endings.

const bare: RestedCardThread = {
  kind: "session", runtime: "turn-idle", needsYou: true, questions: [], pendingQuestion: false, lastAssistantAt: "2026-08-27T22:19:32.609Z",
}

test("a bare rest in the queue draws the card; a stall draws it whatever the message says", () => {
  assert.equal(showsRestedCard(bare, "**Fixed** — landed."), true)
  assert.equal(showsRestedCard({ ...bare, runtime: "exited" }, "**Fixed** — landed."), true)
  assert.equal(showsRestedCard({ ...bare, runtime: "exited", crashed: true }, undefined), true)
  assert.equal(showsRestedCard({ ...bare, runtime: "exited", crashed: true, lastFence: { kind: "done", body: "x", hints: [] } }, "```done\nx\n```"), true)
})

// WHETHER AN OPEN QUESTION IS THIS REST'S ENDING IS THE SERVER'S ANSWER (`standing` on each row), not a
// reading of the transcript. Until 2026-10-13 the caller worked it out from where the card rendered, so
// a worker that asked, was woken by a finished shell and rested again drew this card under a question
// the board still queued the thread for. One the human has typed past (`standing: false`) is not an
// ending — a bare rest beside it would otherwise draw nothing at all, the 2026-08-31 report ("Why was
// this able to come to rest without a proper handoff?").
test("an open question is this rest's ending while the server says it stands, wherever it was asked", () => {
  const text = "Changelog updated."
  const question = { id: "q", spec: { question: "?", kind: "question" as const }, askedAt: "2026-08-27T20:00:00.000Z" }
  assert.equal(showsRestedCard({ ...bare, questions: [{ ...question, standing: false }] }, text), true, "the human typed past it: still a bare rest")
  assert.equal(showsRestedCard({ ...bare, questions: [{ ...question, standing: true }] }, text), false, "it stands — asked many machine wakes ago or at this rest — so the question is the ending")
  assert.equal(showsRestedCard({ ...bare, questions: [{ ...question, standing: false }, { ...question, id: "r", standing: true }] }, text), false, "one of each: the standing one decides")
  assert.equal(showsRestedCard({ ...bare, questions: [question] }, text), false, "a snapshot from before the flag: every open question stands, as before")
})

test("every ending with a card of its own keeps this one off", () => {
  const text = "**Fixed** — landed."
  assert.equal(showsRestedCard({ ...bare, lastFence: { kind: "done", body: "x", hints: [], registered: true } }, text), false)
  assert.equal(showsRestedCard({ ...bare, lastFence: { kind: "awaiting", body: "x", hints: [] } }, text), false)
  assert.equal(showsRestedCard({ ...bare, questions: [{ id: "q", spec: { question: "?", kind: "question" }, askedAt: bare.lastAssistantAt! }] }, text), false)
  assert.equal(showsRestedCard({ ...bare, pendingQuestion: true }, text), false)
  // THE SECONDS AFTER AN ANSWER. The question row is settled, so `questions` is already empty, and the
  // worker has not been handed the answer yet — so every OTHER rung is false and this one caught the
  // hole: a card saying nobody signed anything off, over a human who had just answered.
  assert.equal(showsRestedCard({ ...bare, answersInFlight: "Answers to earlier questions:\n1. “Q?” → A" }, text), false)
  // …and the seconds after arming a Goal cancelled the questions: the same field carries the
  // cancellation wake on its way, and a card claiming a bare rest of a thread that had asked is the
  // exact render the maintainer reported (2026-09-02).
  assert.equal(showsRestedCard({ ...bare, answersInFlight: "1 question you registered was CANCELLED without an answer. Decide it yourself and carry on — say which way you went in your write-up. Do not re-ask." }, text), false)
  assert.equal(showsRestedCard({ ...bare, awaitingBackground: true }, text), false)
  // A person's Stop ended the turn: the worker was never given the chance to sign off.
  assert.equal(showsRestedCard({ ...bare, operatorStopped: true }, text), false)
  assert.equal(showsRestedCard({ ...bare, pendingInteraction: true }, text), false)
  assert.equal(showsRestedCard({ ...bare, limitPause: { window: "session", since: bare.lastAssistantAt! } as never }, text), false)
  // The message's own copy of the same facts: a fence or a question block in the final text.
  assert.equal(showsRestedCard(bare, "Done.\n\n```done\nlanded\n```"), false)
  assert.equal(showsRestedCard(bare, "```question\nShip it?\n\n- A. Yes\n- B. No\n```"), false)
})

test("not a rest: running, spawning, excused from the queue, foreign, or nothing said yet", () => {
  assert.equal(showsRestedCard({ ...bare, runtime: "running" }, "x"), false)
  assert.equal(showsRestedCard({ ...bare, runtime: "spawning" }, "x"), false)
  assert.equal(showsRestedCard({ ...bare, needsYou: false }, "x"), false)
  assert.equal(showsRestedCard({ ...bare, foreign: true }, "x"), false)
  assert.equal(showsRestedCard({ ...bare, lastAssistantAt: undefined }, "x"), false)
  assert.equal(showsRestedCard(bare, undefined), false)
  assert.equal(showsRestedCard(undefined, "x"), false)
})

test("the two shapes render their own label", () => {
  const stalled = renderToStaticMarkup(createElement(RestedCard, { thread: { crashed: true } }))
  assert.match(stalled, /data-rested-card="stalled"/)
  assert.match(stalled, />Stalled</)
  const rested = renderToStaticMarkup(createElement(RestedCard, { thread: { crashed: false } }))
  assert.match(rested, /data-rested-card="bare"/)
  assert.match(rested, />Rested without a sign-off</)
})

// THE QUESTION FENCE (2026-10-13). A fence that tried the grammar and failed registers nothing and draws as
// a code block, so the rest under it is a bare one — whatever its backticks. Before, three backticks at
// the margin hid this card (the legacy reader counted the fence) and four showed it.
test("on a thread that speaks the question fence, a fence that did not read is not a sign-off", () => {
  const fenced: RestedCardThread = { ...bare, spawnedAt: "2026-10-13T20:30:00.000Z" }
  const broken = (ticks: string) => `Which region?\n\n${ticks}question\nid: two-recs\nquestion: Which region?\noptions:\n  - a\n  - b\n${ticks}`
  assert.equal(showsRestedCard(fenced, broken("```")), true)
  assert.equal(showsRestedCard(fenced, broken("````")), true)
  // Negative controls: a fence that reads is the rest's ending (its row may not have landed yet), a
  // follow-up written alone still names its parent, and a free-form fence keeps the legacy reading.
  assert.equal(showsRestedCard(fenced, "```question\nid: region\nkind: text\nquestion: Which region?\n```"), false)
  assert.equal(showsRestedCard(fenced, "```question\nid: az\nkind: text\nwhen: region = us-east\nquestion: Which zone?\n```"), false)
  assert.equal(showsRestedCard(fenced, "```question\nWhich region?\n\nA. us-east\nB. eu-west\n```"), false)
  // A legacy thread's three-backtick fence is a question whatever its body opens on.
  assert.equal(showsRestedCard({ ...bare, spawnedAt: "2026-09-01T12:00:00.000Z" }, broken("```")), false)
  assert.equal(showsRestedCard(bare, broken("```")), false, "an unknown dispatch instant reads as legacy")
})

// A fence the server REFUSED asked the human nothing, exactly like one that did not read — but it reads
// fine, so only the board can say (ThreadView.questionFaults, hung on the message by lib/questionFaults).
test("on a thread that speaks the question fence, a rest whose only fence the server refused is a bare rest", () => {
  const speaks: RestedCardThread = { ...bare, spawnedAt: "2026-10-14T00:00:00.000Z" }
  const reused = "A different question:\n\n```question\nid: store\nkind: choice\nquestion: Which region?\noptions:\n  - label: us-east\n  - label: eu-west\n```"
  assert.equal(showsRestedCard(speaks, reused), false, "no fault yet: the registrar is a second behind, and the question is about to be answerable")
  assert.equal(showsRestedCard(speaks, reused, new Set()), false)
  assert.equal(showsRestedCard(speaks, reused, new Set(["store"])), true, "refused: nobody was asked, and the card says Frizz is nudging the worker")
  assert.equal(showsRestedCard(speaks, reused, new Set(["other"])), false, "a refusal of some other fence is not this one's")
  // Beside a fence that held, the rest still ends on a question.
  const both = `${reused}\n\n\`\`\`question\nid: fresh\nkind: text\nquestion: Ship it?\n\`\`\``
  assert.equal(showsRestedCard(speaks, both, new Set(["store"])), false)
})

// A fence whose question CLOSED without an answer asks nobody either: the human dismissed it, Frizz
// cancelled it because the thread runs autonomously, or the worker withdrew it.
test("a rest whose only fence names a question that closed without an answer is a bare rest", () => {
  const speaks: RestedCardThread = { ...bare, spawnedAt: "2026-10-14T00:00:00.000Z" }
  const text = "I hit a fork.\n\n```question\nid: retry-policy\nkind: choice\nquestion: Retry or quarantine?\noptions:\n  - label: Retry\n  - label: Quarantine\n```"
  assert.equal(showsRestedCard(speaks, text), false, "no row yet: about to be asked")
  const closed = (state: "dismissed" | "withdrawn") => [{ id: "qst_1", handle: "retry-policy", state, askedAt: "2026-10-14T10:00:00.000Z" }]
  assert.equal(showsRestedCard({ ...speaks, closedQuestions: closed("dismissed") }, text), true)
  assert.equal(showsRestedCard({ ...speaks, closedQuestions: closed("withdrawn") }, text), true)
  assert.equal(showsRestedCard({ ...speaks, closedQuestions: [{ ...closed("dismissed")[0], handle: "other" }] }, text), false, "some other question closed, not this one")
  // A closed question's id asked AGAIN: the newest fence is the new, open question — whether or not it
  // still stands — so this rest asked something.
  const reasked = { id: "qst_2", askedAt: "2026-10-14T11:00:00.000Z", standing: false, spec: { handle: "retry-policy", question: "Retry or quarantine?", kind: "question" as const, options: [{ label: "Retry" }, { label: "Quarantine" }] } }
  assert.equal(showsRestedCard({ ...speaks, closedQuestions: closed("withdrawn"), questions: [reasked] }, text), false)
  // …and it composes with a refusal in the same message.
  const both = `${text}\n\n\`\`\`question\nid: ghost\n\`\`\``
  assert.equal(showsRestedCard({ ...speaks, closedQuestions: closed("dismissed") }, both, new Set(["ghost"])), true)
})
