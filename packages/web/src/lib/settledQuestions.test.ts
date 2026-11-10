import assert from "node:assert/strict"
import test from "node:test"
import { settledQuestionPositions } from "./settledQuestions.ts"

// A transcript as the two position readers see it: roles, kinds, instants, and the text a marker lives in.
const msg = (role: "user" | "assistant", at: string, text = "…", kind?: string) => ({ role, at, text, ...(kind ? { kind } : {}) })
const settled = (id: string, askedAt: string, settledAt: string, pending?: true) => ({ id, askedAt, settledAt, ...(pending ? { pending } : {}) })

test("an answered question stays after the rest it was answered at, not after the answer or the turn it woke", () => {
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:01:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z"), // the handoff; the card rendered after this
    msg("user", "2026-09-25T10:06:00Z"), // the delivered answer
    msg("assistant", "2026-09-25T10:07:00Z"), // the turn it woke
  ]
  const { anchored, placed } = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z")])
  assert.deepEqual([...anchored.keys()], [2])
  assert.equal(placed.size, 0)
})

test("a question the human replied past and answered later stays at the rest that asked it", () => {
  // An open card stays where it was asked until a later ```awaiting fence names it (questionAnchor), so
  // the card the human clicked sat under the first handoff, and the settled card stays there.
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z"), // asked here
    msg("user", "2026-09-25T10:03:00Z"), // replied past it
    msg("assistant", "2026-09-25T10:04:00Z"), // rested again, question still open, not named
    msg("user", "2026-09-25T10:09:00Z"), // the answer
  ]
  const { anchored } = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:08:00Z")])
  assert.deepEqual([...anchored.keys()], [1])
})

test("a question a later fence claimed and the human then answered stays at the claiming rest", () => {
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z"), // asked here
    msg("user", "2026-09-25T10:03:00Z"), // replied past it
    msg("assistant", "2026-09-25T10:04:00Z", "Still needed.\n\n```awaiting\nquestions: [qst_a]\nstatus: needs_input\n```"),
    msg("user", "2026-09-25T10:09:00Z"), // the answer
  ]
  const { anchored } = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:08:00Z")])
  assert.deepEqual([...anchored.keys()], [3])
})

test("a marker in the answered rest places the settled card inside that message", () => {
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z", "Setup.\n\n```question qst_a\n```\n\nEither way."),
    msg("user", "2026-09-25T10:06:00Z"),
  ]
  const { anchored, placed } = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z")])
  assert.deepEqual([...placed.keys()], [1])
  assert.equal(anchored.size, 0)
})

test("a marker the worker writes AFTER the answer cannot move the settled card", () => {
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z"),
    msg("user", "2026-09-25T10:06:00Z"),
    msg("assistant", "2026-09-25T10:07:00Z", "```question qst_a\n```"),
  ]
  const { anchored, placed } = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z")])
  assert.equal(placed.size, 0)
  assert.deepEqual([...anchored.keys()], [1])
})

test("a card just sent from this tab sits at the tail whatever the browser clock says", () => {
  // Negative control for the clock: a settledAt far in the past would cut the prefix at message 0.
  const messages = [msg("user", "2026-09-25T10:00:00Z"), msg("assistant", "2026-09-25T10:02:00Z")]
  const { anchored } = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2000-01-01T00:00:00Z", true)])
  assert.deepEqual([...anchored.keys()], [1])
  const stale = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2000-01-01T00:00:00Z")])
  assert.equal(stale.anchored.size, 0)
})

test("a card just sent stays above its own answer's ghost bubble, not under it", () => {
  // The render that sends the answer already draws its ghost under the rest's hairline (lib/restReply),
  // with no server instant. The card stood above that hairline when it was clicked, and stays there:
  // the same slot the echo will give it, so the two never trade places.
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z", "Agent rested", "event"),
    { role: "user", text: "Answers to earlier questions", queued: true },
  ]
  const ghost = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z", true)])
  assert.deepEqual([...ghost.anchored.keys()], [1])
  // …and once the echo lands stamped, the server's copy puts it in the same slot.
  const landed = settledQuestionPositions([...messages.slice(0, 3), msg("user", "2026-09-25T10:05:01Z", "Answers to earlier questions")], [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z")])
  assert.deepEqual([...landed.anchored.keys()], [1])
})

test("a question answered before the loaded window draws nothing rather than hoisting to the top", () => {
  const messages = [msg("user", "2026-09-25T11:00:00Z"), msg("assistant", "2026-09-25T11:01:00Z")]
  const { anchored, placed } = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z")])
  assert.equal(anchored.size, 0)
  assert.equal(placed.size, 0)
})

test("one batch stays together in the order it was asked", () => {
  const messages = [msg("user", "2026-09-25T10:00:00Z"), msg("assistant", "2026-09-25T10:02:00Z"), msg("user", "2026-09-25T10:06:00Z")]
  const { anchored } = settledQuestionPositions(messages, [
    settled("qst_b", "2026-09-25T10:01:40Z", "2026-09-25T10:05:00Z"),
    settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z"),
  ])
  assert.deepEqual(anchored.get(1)?.map((s) => s.id), ["qst_a", "qst_b"])
})

test("the card stays above the rest divider that closes its rest, not below it", () => {
  // The shape the real tailer produces: a synthetic "Agent rested" event row after every handoff.
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z", "Agent rested", "event"),
    msg("user", "2026-09-25T10:06:00Z"),
  ]
  const { anchored } = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z")])
  assert.deepEqual([...anchored.keys()], [1])
})

// ---- THE QUESTION FENCE (2026-10-13) ----
// The open card was placed and claimed by the worker's handle, so the replay must match it too.

test("a fence-asked question answered after a later reference stays in the reference's slot", () => {
  const spec = { handle: "settings-store", question: "Which store?", kind: "question" as const }
  const messages = [
    msg("user", "2026-10-13T10:00:00Z"),
    msg("assistant", "2026-10-13T10:02:00Z", "```question\nid: settings-store\nkind: text\nquestion: Which store?\n```"),
    msg("user", "2026-10-13T10:03:00Z"), // replied past it
    msg("assistant", "2026-10-13T10:04:00Z", "Still needed:\n\n```question\nid: settings-store\n```"),
    msg("user", "2026-10-13T10:09:00Z"), // the answer
  ]
  const { placed, anchored } = settledQuestionPositions(messages, [{ ...settled("qst_a", "2026-10-13T10:02:00Z", "2026-10-13T10:08:00Z"), spec }])
  assert.deepEqual([...placed.keys()], [3])
  assert.equal(anchored.size, 0)
  // Negative control: without the handle the replay cannot see the fence, and the card falls to the anchor.
  const blind = settledQuestionPositions(messages, [settled("qst_a", "2026-10-13T10:02:00Z", "2026-10-13T10:08:00Z")])
  assert.equal(blind.placed.size, 0)
})

test("the answer's own optimistic bubble cannot pull the card it answers out of its fence slot", () => {
  // The prompt box's send appends the Answers bubble with no instant and settles the card `pending` in
  // the same commit. The bubble IS the answer, so it is outside what the card stood in.
  const spec = { handle: "settings-store", question: "Which store?", kind: "question" as const }
  const messages = [
    msg("user", "2026-10-13T10:00:00Z"),
    msg("assistant", "2026-10-13T10:02:00Z", "Lead.\n\n```question\nid: settings-store\nkind: text\nquestion: Which store?\n```\n\nTail."),
    msg("assistant", "2026-10-13T10:02:00Z", "Agent rested", "event"),
    { role: "user", text: "Answers to earlier questions: …" },
  ]
  const pending = { ...settled("qst_a", "2026-10-13T10:02:00Z", "2026-10-13T10:08:00Z", true), spec }
  const { placed, anchored } = settledQuestionPositions(messages, [pending])
  assert.deepEqual([...placed.keys()], [1])
  assert.equal(anchored.size, 0)
  // …and a card that was never placed (an `ask` row) stays under its handoff, above the bubble.
  const plain = settledQuestionPositions(
    [msg("user", "2026-09-25T10:00:00Z"), msg("assistant", "2026-09-25T10:02:00Z"), { role: "user", text: "Answers…" }],
    [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z", true)],
  )
  assert.deepEqual([...plain.anchored.keys()], [1])
})

// A recap the worker wrote after a wake, before the human's next turn, drew the open card live beside the
// write-up's (lib/questionShadow placeQuestions), so the answered card stands in both.
test("a question answered after a wake-driven recap stays answered in the write-up and the recap", () => {
  const ask = "```question\nid: store\nkind: choice\nquestion: SQLite or JSON?\noptions:\n  - SQLite\n  - JSON\n```"
  const messages = [
    msg("user", "2026-11-09T20:20:00.000Z", "Design the store."),
    msg("assistant", "2026-11-09T21:57:00.000Z", `The write-up.\n\n${ask}\n\nMore prose.`),
    { role: "user", at: "2026-11-09T22:27:00.000Z", text: "<thread-message from-thread=\"docs\">x</thread-message>", sessionPeer: { name: "Docs" } },
    msg("assistant", "2026-11-09T22:29:00.000Z", "These are open:\n\n```question\nid: store\n```"),
    { role: "user", at: "2026-11-09T22:40:00.000Z", wake: true as const, text: "Answers to earlier questions:\n1. `store` “SQLite or JSON?” → SQLite" },
  ]
  const row = { ...settled("qst_store", "2026-11-09T21:57:00.000Z", "2026-11-09T22:39:00.000Z"), spec: { handle: "store", question: "SQLite or JSON?", kind: "question" as const, options: [{ label: "SQLite" }, { label: "JSON" }] } }
  assert.deepEqual([...settledQuestionPositions(messages, [row]).placed.keys()], [1, 3])
})
