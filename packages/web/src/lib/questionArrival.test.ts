import assert from "node:assert/strict"
import test from "node:test"
import { arrivedQuestions, awaitsItsMessage, FENCE_MESSAGE_WAIT_MS } from "./questionArrival.ts"
import { placeQuestions } from "./questionShadow.ts"
import { questionsByAnchor } from "./questionAnchor.ts"

// The board's row reaches the browser a round trip ahead of the transcript message that asked it. Drawn
// at once, the card started at the tail and hopped into its message; these pin that it waits instead, for
// how long, and that a question with no fence coming does not wait at all.

const at = (minute: number, second = 0) => new Date(Date.parse("2026-10-20T10:00:00.000Z") + minute * 60_000 + second * 1000).toISOString()
const fence = (body: string) => `\`\`\`question\n${body}\n\`\`\``
const ASK = fence("id: store\nkind: choice\nquestion: SQLite or a JSON file?\noptions:\n  - label: SQLite\n  - label: JSON file")
const row = (askedAt: string, handle: string | null = "store") => ({
  id: handle ? `qst_${handle}` : "qst_asked",
  askedAt,
  spec: { ...(handle ? { handle } : {}), question: "SQLite or a JSON file?", kind: "question" as const, options: [{ label: "SQLite" }, { label: "JSON file" }] },
})
const BEFORE = [
  { role: "user", at: at(0), text: "Move the settings into a real store." },
  { role: "assistant", at: at(1), text: "Reading the settings layer." },
]
const ASKING = { role: "assistant", at: at(5), text: `One call first:\n\n${ASK}\n\nThe rest is done.` }

test("a fence-asked row is ahead of the transcript until its message is loaded", () => {
  const q = row(at(5))
  assert.equal(awaitsItsMessage(q, BEFORE), true, "the board landed first: nothing at or after 10:05, nothing naming it")
  assert.equal(awaitsItsMessage(q, [...BEFORE, ASKING]), false, "its message is here")
  assert.equal(awaitsItsMessage(q, []), true)
  // What the hold prevents, stated as the readers see it: with the row and no message, the card has no
  // slot and anchors at the tail; with the message, the fence places it.
  assert.deepEqual([...placeQuestions(BEFORE, [q]).placed.keys()], [])
  assert.deepEqual([...questionsByAnchor(BEFORE, [q]).keys()], [1], "the tail, under a message that never asked")
  assert.deepEqual([...placeQuestions([...BEFORE, ASKING], [q]).placed.keys()], [2])
})

test("a later record of the message, or a line stamped after it, is the transcript catching up", () => {
  // The fence sat in the message's SECOND text record: asked 7s after the bubble's own instant, with
  // nothing later in the transcript yet (the turn is still running). The message names it.
  const late = row(at(5, 7))
  assert.equal(awaitsItsMessage(late, [...BEFORE, ASKING]), false)
  // Loaded through the instant by a line that names nothing — the rest divider, a wake.
  const divider = { role: "assistant", kind: "event", at: at(5, 7), text: "Agent rested" }
  assert.equal(awaitsItsMessage(late, [...BEFORE, divider]), false)
  // An unstamped tail (this tab's own optimistic send) proves nothing about the transcript.
  assert.equal(awaitsItsMessage(late, [...BEFORE, { role: "user", text: "and another thing" }]), true)
  // A question asked long ago, its message above the loaded window: everything loaded is later.
  assert.equal(awaitsItsMessage(row(at(-60)), BEFORE), false)
})

test("a question with no fence coming never waits", () => {
  assert.equal(awaitsItsMessage(row(at(5), null), BEFORE), false, "registered through the `ask` RPC: no handle, no message to wait for")
  assert.equal(awaitsItsMessage(row("not a date"), BEFORE), false)
})

test("the wait is bounded: a row whose message never arrives is drawn after it, and the memory is kept tidy", () => {
  const q = row(at(5))
  const other = row(at(1), null)
  const open = [other, q]
  const seen = new Map<string, number>()
  const first = arrivedQuestions(open, BEFORE, seen, 1_000)
  assert.deepEqual(first.shown, [other])
  assert.equal(first.wakeAt, 1_000 + FENCE_MESSAGE_WAIT_MS)
  // Asked again mid-wait: still held, and the clock did not restart.
  const mid = arrivedQuestions(open, BEFORE, seen, 1_900)
  assert.deepEqual(mid.shown, [other])
  assert.equal(mid.wakeAt, 1_000 + FENCE_MESSAGE_WAIT_MS)
  // The bound runs out with no message: drawn anyway, at the tail, as before this rule.
  const late = arrivedQuestions(open, BEFORE, seen, 1_000 + FENCE_MESSAGE_WAIT_MS)
  assert.equal(late.shown, open, "the very same array")
  assert.equal(late.wakeAt, undefined)
  // The ordinary case: the message arrives 30ms later and the row is shown in that same pass.
  const seen2 = new Map<string, number>()
  assert.deepEqual(arrivedQuestions(open, BEFORE, seen2, 5_000).shown, [other])
  const arrived = arrivedQuestions(open, [...BEFORE, ASKING], seen2, 5_030)
  assert.equal(arrived.shown, open)
  assert.equal(seen2.size, 0, "nothing left waiting, nothing remembered")
  // A row that leaves the board while waiting (answered in another tab) is forgotten too.
  const seen3 = new Map<string, number>()
  arrivedQuestions(open, BEFORE, seen3, 0)
  assert.equal(seen3.size, 1)
  arrivedQuestions([other], BEFORE, seen3, 10)
  assert.equal(seen3.size, 0)
})
