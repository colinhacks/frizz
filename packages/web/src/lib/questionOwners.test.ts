import assert from "node:assert/strict"
import test from "node:test"
import { questionClaims } from "./questionAnchor.ts"
import { refusedFencesByMessage } from "./questionFaults.ts"
import { questionOwnersByMessage, withQuestionOwners } from "./questionOwners.ts"
import { placeQuestions, resolveQuestionName } from "./questionShadow.ts"
import { settledQuestionPositions } from "./settledQuestions.ts"

// A settled question's id may be asked again, and the new fence registers a NEW row (server
// question-fences.ts). Each message's fence must keep naming the row it asked: the first message its
// answered question, the second the new one. These pin that every reader gets it from the message.

const at = (minute: number, second = 0) => new Date(Date.parse("2026-11-05T10:00:00.000Z") + minute * 60_000 + second * 1000).toISOString()
const fence = (body: string) => `\`\`\`question\n${body}\n\`\`\``
const choice = (id: string, question: string) =>
  fence(`id: ${id}\nkind: choice\nquestion: ${question}\noptions:\n  - label: SQLite\n  - label: JSON file`)
const spec = (question: string) => ({ handle: "store", question, kind: "question" as const, options: [{ label: "SQLite" }, { label: "JSON file" }] })

// Asked at 10:05 and answered; referenced at 10:09 while still answered (a no-op); asked again at 10:12 in
// the message's SECOND record (7s after the bubble's stamp) with a new question; that one still open.
const MESSAGES = [
  { role: "user", at: at(0), text: "Move the settings into a real store." },
  { role: "assistant", at: at(5), text: `One call first:\n\n${choice("store", "SQLite or a JSON file?")}` },
  { role: "user", at: at(8), text: "Answers:\n1. SQLite" },
  { role: "assistant", at: at(9), text: `Done with the store.\n\n${fence("id: store")}` },
  { role: "user", at: at(11), text: "Now the cache." },
  { role: "assistant", at: at(12), text: `A second call:\n\n${choice("store", "Redis or memory for the cache?")}` },
  { role: "assistant", kind: "event", at: at(12, 9), text: "Agent rested" },
]
const FIRST = { id: "qst_first000001", askedAt: at(5), settledAt: at(8), spec: spec("SQLite or a JSON file?") }
const SECOND = { id: "qst_second00001", askedAt: at(12, 7), spec: spec("Redis or memory for the cache?") }

test("each message's name means the newest row asked at or before it — a later record of the message included", () => {
  const owners = questionOwnersByMessage(MESSAGES, [SECOND, FIRST])
  assert.deepEqual([...owners].map(([i, map]) => [i, map.get("store")]), [[1, FIRST.id], [3, FIRST.id], [5, SECOND.id]])
  // A name one row carries needs nothing, and a thread that never asked an id twice keeps its array.
  assert.equal(questionOwnersByMessage(MESSAGES, [FIRST]).size, 0)
  assert.equal(withQuestionOwners(MESSAGES, [FIRST]), MESSAGES)
  // Annotated once per meaning: the same rows again hand back the same message objects.
  const first = withQuestionOwners(MESSAGES, [FIRST, SECOND])
  const again = withQuestionOwners(MESSAGES, [SECOND, FIRST])
  assert.equal(first[5], again[5])
  assert.equal(first[0], MESSAGES[0], "a message that never mentions the name is the object it was")
})

test("a fence resolves through its message: the first ask draws its answered row, the second its open one", () => {
  const marked = withQuestionOwners(MESSAGES, [FIRST, SECOND])
  const rows = [SECOND, FIRST] // open questions come first in the surface's list
  assert.equal(resolveQuestionName("store", rows, marked[1].questionOwners)?.id, FIRST.id)
  assert.equal(resolveQuestionName("store", rows, marked[5].questionOwners)?.id, SECOND.id)
  // Negative control — the bug: by name alone, the first message's fence took the open question.
  assert.equal(resolveQuestionName("store", rows)?.id, SECOND.id)
})

test("placement, claims and the answered card's slot each follow the row the message meant", () => {
  const marked = withQuestionOwners(MESSAGES, [FIRST, SECOND])
  assert.deepEqual([...placeQuestions(marked, [SECOND]).placed.keys()], [5])
  // The claims of each row are its own messages'.
  const claims = questionClaims(marked)
  assert.equal(claims.get(`store\u0000${FIRST.id}`), 3)
  assert.equal(claims.get(`store\u0000${SECOND.id}`), 5)
  // The answered question stays in the prose that asked it.
  assert.deepEqual([...settledQuestionPositions(marked, [FIRST]).placed.keys()], [1])
})

test("a fault in the message that asked the second row is not that message's refusal", () => {
  // The board is a frame ahead of the transcript, so a fault can land in the message that registered the
  // name. With two rows under it, the one asked in this message is the one to look for — not the first.
  const fault = { at: at(12, 7), id: "store", faults: ["refused"] }
  assert.equal(refusedFencesByMessage(MESSAGES, [fault], [FIRST, SECOND]).size, 0)
  assert.equal(refusedFencesByMessage(MESSAGES, [fault], [SECOND, FIRST]).size, 0)
  assert.equal(refusedFencesByMessage(MESSAGES, [fault], [FIRST]).size, 1, "control: with only the first row, it is marked")
})
