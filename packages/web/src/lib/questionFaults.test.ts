import assert from "node:assert/strict"
import test from "node:test"
import type { QuestionFenceFaultView } from "@frizz/shared"
import { questionClaims } from "./questionAnchor.ts"
import { followUpParentsIn, hasQuestionBlock, questionFenceIdsIn, splitMessageQuestions } from "./questionBlocks.ts"
import { messageIndexAt, questionFaultsKey, refusalSummary, refusedFencesByMessage, withRefusedFences, type FaultMessage } from "./questionFaults.ts"
import { placeQuestions } from "./questionShadow.ts"
import { settledQuestionPositions } from "./settledQuestions.ts"

// A fence the server REFUSED has no row — and neither has one the registrar has not reached yet. The board
// says which is which (ThreadView.questionFaults); this pins how each fault finds its fence, and what the
// fence then is to every reader: a question not asked, drawn with why, that names no question.

const at = (minute: number, second = 0) => new Date(Date.parse("2026-10-20T10:00:00.000Z") + minute * 60_000 + second * 1000).toISOString()
const fence = (body: string) => `\`\`\`question\n${body}\n\`\`\``
const choice = (id: string, question = "SQLite or a JSON file?") =>
  fence(`id: ${id}\nkind: choice\nquestion: ${question}\noptions:\n  - label: SQLite\n  - label: JSON file`)
const fault = (minute: number, id: string | undefined, second = 0): QuestionFenceFaultView => ({ at: at(minute, second), ...(id ? { id } : {}), faults: ["refused"] })
const ROW = {
  id: "qst_store000001",
  askedAt: at(5),
  spec: { handle: "store", question: "SQLite or a JSON file?", kind: "question" as const, options: [{ label: "SQLite" }, { label: "JSON file" }] },
}

// The reused id, as it happens: asked at 10:05, the human replies past it, and at 10:12 the worker writes
// a DIFFERENT question under the same id. The server refuses the second and faults it at its own instant.
const REUSED: FaultMessage[] = [
  { role: "user", at: at(0), text: "Move the settings into a real store." },
  { role: "assistant", at: at(5), text: `One call first:\n\n${choice("store")}\n\nThe rest is done.` },
  { role: "assistant", kind: "event", at: at(5), text: "Agent rested" },
  { role: "user", at: at(8), text: "Do the docs first." },
  { role: "assistant", at: at(12), text: `Docs are in. A different question:\n\n${choice("store", "Which region?")}\n\nEither way.` },
  { role: "assistant", kind: "event", at: at(12), text: "Agent rested" },
]

test("a fault belongs to the message whose span holds its instant — a later record of the message, or the record its rest line shares", () => {
  // The fence sat in the message's SECOND text record, written 7s after the first: the bubble is stamped
  // 10:12:00 and the fault 10:12:07. No string equality, and the "Agent rested" line stamped with that
  // same closing record is not what the instant lands in.
  const split = REUSED.map((m, i) => (i === 5 ? { ...m, at: at(12, 7) } : m))
  assert.equal(messageIndexAt(split, Date.parse(at(12, 7))), 4)
  assert.deepEqual([...refusedFencesByMessage(split, [fault(12, "store", 7)], [ROW])], [[4, new Set(["store"])]])
  // The single-record message: fault, bubble and rest line all carry one instant.
  assert.deepEqual([...refusedFencesByMessage(REUSED, [fault(12, "store")], [ROW])], [[4, new Set(["store"])]])
  // Older than everything loaded, or in a message with no such fence: nothing to mark.
  assert.equal(messageIndexAt(REUSED, Date.parse(at(-5))), -1)
  assert.equal(refusedFencesByMessage(REUSED, [fault(-5, "store")], [ROW]).size, 0)
  assert.equal(refusedFencesByMessage(REUSED, [fault(8, "store")], [ROW]).size, 0, "the instant lands in the human's own turn")
  assert.equal(refusedFencesByMessage(REUSED, [fault(12, "other")], [ROW]).size, 0, "the message carries no fence of that id")
  assert.equal(refusedFencesByMessage(REUSED, [fault(12, undefined)], [ROW]).size, 0, "a fence too broken to have an id is already a code block")
  assert.equal(refusedFencesByMessage(REUSED, [fault(12, "STORE")], [ROW]).get(4)?.has("store"), true, "ids match case-blind")
})

test("two messages reuse one id: only the refused one is marked, and the question's card stays where it was asked", () => {
  const marked = withRefusedFences(REUSED, [fault(12, "store")], [ROW])
  assert.deepEqual(marked.map((m) => (m.refusedFences ? [...m.refusedFences] : null)), [null, null, null, null, ["store"], null])
  assert.deepEqual([...placeQuestions(marked, [ROW]).placed.keys()], [1], "the open card is still in the prose that asked it")
  assert.equal(questionClaims(marked).get("store"), 1, "…and the refused fence is no claim on it")
  // Negative control — the bug: read by id alone, the newest message naming `store` takes the card.
  assert.deepEqual([...placeQuestions(REUSED, [ROW]).placed.keys()], [4])
  assert.equal(questionClaims(REUSED).get("store"), 4)
  // Answered instead: the settled card stays in the asking message too (it was answered at 10:07, before
  // the second fence existed, so the replay never saw that fence — but the claim must not move either).
  const answered = { ...ROW, settledAt: at(7) }
  assert.deepEqual([...settledQuestionPositions(marked, [answered]).placed.keys()], [1])
})

test("the board lands before the transcript: a fault for a message not loaded yet never marks the one that asked", () => {
  // The same reuse with the 10:12 message still on its way. The fault's instant can only land in the
  // newest loaded message — the one that REGISTERED `store`, which the server never faults for it.
  const early = REUSED.slice(0, 3)
  assert.equal(messageIndexAt(early, Date.parse(at(12))), 1)
  assert.equal(refusedFencesByMessage(early, [fault(12, "store")], [ROW]).size, 0)
  assert.equal(withRefusedFences(early, [fault(12, "store")], [ROW]), early, "the very same array: nothing re-renders")
  // Without the row (a reference to nothing, refused twice) there is no such guard to need: the earlier
  // message's own fault already marks it.
  const ghost = [
    { role: "assistant", at: at(1), text: fence("id: ghost") },
    { role: "user", at: at(2), text: "?" },
    { role: "assistant", at: at(3), text: fence("id: ghost") },
  ]
  assert.deepEqual([...refusedFencesByMessage(ghost, [fault(1, "ghost"), fault(3, "ghost")]).keys()], [0, 2])
})

test("a refused fence is a refused ask to the splitter and names nothing to the placement readers; an unfaulted one is untouched", () => {
  const text = `Two things:\n\n${choice("store", "Which region?")}\n\nand\n\n${choice("fresh", "Ship it?")}\n\nDone.`
  const refused = new Set(["store"])
  const segs = splitMessageQuestions(text, true, refused)
  assert.deepEqual(segs.map((s) => s.kind), ["prose", "refusedAsk", "prose", "question", "prose"])
  // Its question, read, so it draws greyed under the reason — not the worker's YAML as a code block.
  assert.equal(segs[1].kind === "refusedAsk" && segs[1].spec.question, "Which region?")
  assert.equal(segs[3].kind === "question" && segs[3].fence?.id, "fresh")
  assert.deepEqual(questionFenceIdsIn(text, refused), ["fresh"])
  assert.equal(hasQuestionBlock(text, refused), true)
  assert.equal(hasQuestionBlock(choice("store"), refused), false, "a message whose only fence was refused asks nothing")
  // No fault (the registrar is a second behind, or the fence is fine): exactly as before.
  assert.deepEqual(splitMessageQuestions(text, true).map((s) => s.kind), ["prose", "question", "prose", "question", "prose"])
  assert.deepEqual(splitMessageQuestions(text, true, new Set()).map((s) => s.kind), ["prose", "question", "prose", "question", "prose"])
  assert.deepEqual(questionFenceIdsIn(text), ["store", "fresh"])
  // A reference to nothing is refused too, and is then a note naming what it pointed at (2026-10-21) — not
  // nothing at all, and not the bare `id: ghost` code block a reader could not tell from a stray snippet.
  assert.deepEqual(splitMessageQuestions(`See:\n\n${fence("id: ghost")}`, true, new Set(["ghost"])), [{ kind: "prose", text: "See:\n\n" }, { kind: "refusedRef", id: "ghost" }])
  assert.equal(hasQuestionBlock(`See:\n\n${fence("id: ghost")}`, new Set(["ghost"])), false, "and it asks nothing")
  // Unrefused, the same fence is still a placement for its row.
  assert.deepEqual(splitMessageQuestions(`See:\n\n${fence("id: ghost")}`, true).map((s) => s.kind), ["prose", "question"])
})

test("a refused late follow-up claims nothing: its parent's card does not move, and the fence draws as not asked", () => {
  const followUp = fence("id: store-path\nkind: text\nquestion: Where does the file live?\nwhen: store = SQLite")
  const text = `One more thing hangs on SQLite:\n\n${followUp}`
  assert.deepEqual(followUpParentsIn(text), ["store"], "attached, it names its parent here")
  assert.deepEqual(followUpParentsIn(text, new Set(["store-path"])), [])
  assert.deepEqual(questionFenceIdsIn(text, new Set(["store-path"])), [])
  assert.deepEqual(splitMessageQuestions(text, true, new Set(["store-path"])).map((s) => s.kind), ["prose", "refusedAsk"])
  const messages: FaultMessage[] = [
    { role: "assistant", at: at(5), text: `One call first:\n\n${choice("store")}` },
    { role: "user", at: at(8), text: "Answers: SQLite" },
    { role: "assistant", at: at(12), text },
  ]
  const answered = { ...ROW, settledAt: at(7) }
  const marked = withRefusedFences(messages, [fault(12, "store-path")], [answered])
  assert.deepEqual(marked.map((m) => Boolean(m.refusedFences)), [false, false, true])
  assert.deepEqual([...settledQuestionPositions(marked, [answered]).placed.keys()], [0])
})

test("marking is stable: the same message object for the same refusals, and one key per fault list", () => {
  const faults = [fault(12, "store")]
  const first = withRefusedFences(REUSED, faults, [ROW])
  const again = withRefusedFences([...REUSED], [fault(12, "store")], [ROW])
  assert.notEqual(first[4], REUSED[4])
  assert.equal(first[4], again[4], "a memoized Message sees no new prop")
  assert.equal(first[1], REUSED[1], "every other message is the object it was")
  assert.equal(withRefusedFences(REUSED, undefined, [ROW]), REUSED)
  assert.equal(withRefusedFences(REUSED, [], [ROW]), REUSED)
  assert.equal(questionFaultsKey(faults), questionFaultsKey([fault(12, "store")]))
  assert.notEqual(questionFaultsKey(faults), questionFaultsKey([fault(13, "store")]))
  assert.equal(questionFaultsKey(undefined), "")
  assert.equal(questionFaultsKey([]), "")
})

test("the server's reasons ride on the refused message, and the human reads the first one up to its dash", () => {
  const used = "`id: store` is already used by a different question on this thread that is still open — choose a new id, or reference that one with `id: store` alone (an id is free again once its question is answered, withdrawn or dismissed)"
  const marked = withRefusedFences(REUSED, [{ at: at(12), id: "store", faults: [used] }], [ROW])
  assert.deepEqual(marked[4].refusedReasons && [...marked[4].refusedReasons], [["store", [used]]])
  assert.equal(marked[1].refusedReasons, undefined)
  // A new reason for the same refusal is a new message object, so the card redraws with it.
  assert.notEqual(withRefusedFences(REUSED, [{ at: at(12), id: "store", faults: ["other"] }], [ROW])[4], marked[4])
  assert.notEqual(questionFaultsKey([{ at: at(12), id: "store", faults: [used] }]), questionFaultsKey([{ at: at(12), id: "store", faults: ["other"] }]))

  assert.equal(refusalSummary([used]), "`id: store` is already used by a different question on this thread that is still open")
  assert.equal(refusalSummary(["a `secret` cannot be a follow-up — its answer would ride inside its parent's, unmasked"]), "a `secret` cannot be a follow-up")
  // A head that is only the offending line keeps the clause naming what is wrong with it.
  assert.equal(refusalSummary(["`kind: question` — the kinds are `choice`, `multi`, `text`, `secret`"]), "`kind: question` — the kinds are `choice`, `multi`, `text`, `secret`")
  assert.equal(refusalSummary([]), undefined)
  assert.equal(refusalSummary(undefined), undefined)
})

test("a fence that did not read carries the reader's faults to the page, and its question as far as it reads", () => {
  // The secret written as a follow-up, five of 2026-10's 25 refusals: drawn as the question, never its YAML.
  const broken = fence("id: new-token\nkind: secret\nwhen: rotate = Yes\nquestion: The new token for the tap")
  const segs = splitMessageQuestions(`Before.\n\n${broken}`, true)
  assert.deepEqual(segs.map((s) => s.kind), ["prose", "invalidFence"])
  const seg = segs[1]
  assert.ok(seg.kind === "invalidFence")
  assert.match(seg.faults.join("\n"), /a `secret` cannot be a follow-up/)
  assert.deepEqual(seg.draft, { handle: "new-token", question: "The new token for the tap", kind: "question", secret: true })
  assert.equal(seg.text.trimEnd(), broken, "the bytes still ride along, for a fence with nothing to draw")
  // An unknown kind draws its options as the choice it reads like, and a multi stays a multi.
  const pick = splitMessageQuestions(fence("id: x\nkind: question\nquestion: Ship it?\noptions:\n  - Yes\n  - No"), true)[0]
  assert.deepEqual(pick.kind === "invalidFence" && pick.draft?.options?.map((o) => o.label), ["Yes", "No"])
  assert.equal(pick.kind === "invalidFence" && pick.draft?.kind, "question")
  // With no `question:` line there is no card to draw, only the reason over the folded bytes.
  const headless = splitMessageQuestions(fence("id: x\nkind: choice\noptions:\n  - Yes\n  - No"), true)[0]
  assert.equal(headless.kind === "invalidFence" && headless.draft, undefined)
})

test("a question that closed without an answer is still the row its message registered", () => {
  // A Goal thread's question: cancelled the moment it was written, so the board lists it by handle only.
  // A later message reusing that id is refused; the message that asked it is not marked, loaded or not.
  const closed = { id: "qst_store000001", askedAt: at(5), handle: "store" }
  assert.deepEqual([...refusedFencesByMessage(REUSED, [fault(12, "store")], [closed]).keys()], [4])
  assert.equal(refusedFencesByMessage(REUSED.slice(0, 3), [fault(12, "store")], [closed]).size, 0)
})
