import { test } from "node:test"
import assert from "node:assert/strict"
import type { AskedQuestion } from "@frizz/shared"
import type { BlockAnswer } from "./questionBlocks.ts"
import { ROOT_PATH, childPath, liveQuestionNodes, nodeAnswered, questionNeedsMachine, registeredAnswer, settledQuestionNodes, toParsedQuestion } from "./registeredQuestion.ts"

const blank: BlockAnswer = { chosen: null, chosenSet: [], text: "" }
const pick = (i: number): BlockAnswer => ({ chosen: i, chosenSet: [], text: "" })
const toggle = (...set: number[]): BlockAnswer => ({ chosen: null, chosenSet: set, text: "" })
const typed = (text: string): BlockAnswer => ({ chosen: null, chosenSet: [], text })

const STORE: AskedQuestion = {
  question: "Where should the settings live?",
  kind: "question",
  options: [
    { label: "SQLite", description: "transactional", recommended: true },
    { label: "A JSON file", description: "zero deps" },
  ],
}

// ---- toParsedQuestion ----

test("options letter and join their trade-off exactly as a fence's option lines do", () => {
  const { question, optionLabels } = toParsedQuestion(STORE)
  assert.deepEqual(question.options, ["A. SQLite — transactional", "B. A JSON file — zero deps"])
  // The RAW labels are what an answer submits — the letter and the trade-off are display only.
  assert.deepEqual(optionLabels, ["SQLite", "A JSON file"])
  assert.deepEqual(question.recommendedIdxs, [0])
  assert.equal(question.contextMd, "Where should the settings live?")
  assert.equal(question.danger, false)
})

test("an option with no description carries no dangling dash", () => {
  const { question } = toParsedQuestion({ question: "Which?", kind: "question", options: [{ label: "One" }] })
  assert.deepEqual(question.options, ["A. One"])
})

test("a question with no options is free text, and the card renders its box unconditionally", () => {
  const { question, optionLabels } = toParsedQuestion({ question: "What should it be called?", kind: "question" })
  assert.deepEqual(question.options, [])
  assert.deepEqual(optionLabels, [])
  assert.deepEqual(question.recommendedIdxs, [])
})

test("bodies ride the options array, and are absent entirely when no option has one", () => {
  const { question } = toParsedQuestion(STORE)
  assert.equal(question.optionBodies, undefined)
  // A MULTI-LINE description is the option's body — the label line carries no em-dash join for it.
  const rich = toParsedQuestion({ ...STORE, options: [{ label: "SQLite", description: "transactional\n\n- one more table in `ui.db`" }, { label: "JSON" }] })
  assert.deepEqual(rich.question.options, ["A. SQLite", "B. JSON"])
  assert.deepEqual(rich.question.optionBodies, ["transactional\n\n- one more table in `ui.db`", undefined])
})

test("a legacy preview folds into the body — after a body-shaped description, under a one-line one", () => {
  // Stored rows and in-flight workers still write `preview`; it renders as part of the option now,
  // never behind a pick (the reveal-on-select was retired 2026-09-01).
  const legacy = toParsedQuestion({ ...STORE, options: [{ label: "SQLite", preview: "```sql\nCREATE …\n```" }, { label: "JSON" }] })
  assert.deepEqual(legacy.question.optionBodies, ["```sql\nCREATE …\n```", undefined])
  const both = toParsedQuestion({
    ...STORE,
    options: [{ label: "SQLite", description: "transactional", preview: "```sql\nCREATE …\n```" }],
  })
  // The one-line description keeps its em-dash join; the preview is the body under it.
  assert.deepEqual(both.question.options, ["A. SQLite — transactional"])
  assert.deepEqual(both.question.optionBodies, ["```sql\nCREATE …\n```"])
})

// ---- the static tree ----

const TREE: AskedQuestion = {
  question: "Ship it?",
  kind: "question",
  options: [
    {
      label: "Yes",
      followUps: [
        { question: "Tag a release too?", kind: "question", options: [{ label: "Yes" }, { label: "No" }] },
        { question: "Anything for the notes?", kind: "question" },
      ],
    },
    { label: "No", followUps: [{ question: "What blocks it?", kind: "question" }] },
  ],
}

test("only the root is live until an option is picked", () => {
  const nodes = liveQuestionNodes(TREE, new Map([[ROOT_PATH, blank]]))
  assert.deepEqual(nodes.map((n) => n.path), [ROOT_PATH])
  assert.equal(nodes[0].depth, 1)
})

test("picking an option opens exactly ITS branch, depth-first", () => {
  const nodes = liveQuestionNodes(TREE, new Map([[ROOT_PATH, pick(0)]]))
  assert.deepEqual(nodes.map((n) => n.path), [ROOT_PATH, childPath(ROOT_PATH, 0, 0), childPath(ROOT_PATH, 0, 1)])
  assert.deepEqual(nodes.map((n) => n.depth), [1, 2, 2])
  // The OTHER option's follow-up is nowhere — a branch not taken is not a question anyone owes.
  assert.equal(nodes.some((n) => n.spec.question === "What blocks it?"), false)
})

test("a branch opened two deep keeps counting", () => {
  const deep: AskedQuestion = {
    question: "One?", kind: "question",
    options: [{ label: "Yes", followUps: [{ question: "Two?", kind: "question", options: [{ label: "Yes", followUps: [{ question: "Three?", kind: "question" }] }] }] }],
  }
  const answers = new Map([[ROOT_PATH, pick(0)], [childPath(ROOT_PATH, 0, 0), pick(0)]])
  assert.deepEqual(liveQuestionNodes(deep, answers).map((n) => n.depth), [1, 2, 3])
})

test("draft text beside a chosen chip does NOT close the branch — the chip governs while set", () => {
  // A chip click no longer clears the box (2026-09-02), so this state is a picked chip with a leftover
  // draft. Committing to the box instead nulls `chosen` (the producers' onText contract), and THAT is
  // what closes the branch — pinned by the second assertion.
  const answers = new Map([[ROOT_PATH, { chosen: 0, chosenSet: [], text: "neither, actually" }]])
  assert.deepEqual(
    liveQuestionNodes(TREE, answers).map((n) => n.path),
    [ROOT_PATH, childPath(ROOT_PATH, 0, 0), childPath(ROOT_PATH, 0, 1)],
  )
  assert.deepEqual(liveQuestionNodes(TREE, new Map([[ROOT_PATH, typed("neither, actually")]])).map((n) => n.path), [ROOT_PATH])
})

test("a multi question opens no branch — several picked options would open several at once", () => {
  const multi: AskedQuestion = { ...TREE, kind: "multi" }
  assert.deepEqual(liveQuestionNodes(multi, new Map([[ROOT_PATH, toggle(0, 1)]])).map((n) => n.path), [ROOT_PATH])
})

// ---- the answer payload ----

test("an unanswered ROOT yields nothing at all, whatever is staged below it", () => {
  const answers = new Map([[ROOT_PATH, blank], [childPath(ROOT_PATH, 0, 0), pick(1)]])
  assert.equal(registeredAnswer({ id: "qst_1", spec: TREE }, answers), undefined)
})

test("the payload restates the question and carries the worker's OWN label, not the numbered chip", () => {
  const built = registeredAnswer({ id: "qst_1", spec: STORE }, new Map([[ROOT_PATH, pick(0)]]))
  assert.deepEqual(built, { questionId: "qst_1", question: "Where should the settings live?", chosen: ["SQLite"] })
})

test("draft text left beside a chosen chip stays out of the payload — the chip is the whole reply", () => {
  const built = registeredAnswer({ id: "qst_1", spec: STORE }, new Map([[ROOT_PATH, { chosen: 0, chosenSet: [], text: "neither, actually" }]]))
  assert.deepEqual(built, { questionId: "qst_1", question: "Where should the settings live?", chosen: ["SQLite"] })
})

test("a multi answer carries every toggled label in option order, plus any note", () => {
  const multi: AskedQuestion = { question: "Which gates?", kind: "multi", options: [{ label: "lint" }, { label: "types" }, { label: "tests" }] }
  const built = registeredAnswer({ id: "qst_2", spec: multi }, new Map([[ROOT_PATH, { chosen: null, chosenSet: [2, 0], text: "skip the flaky one" }]]))
  assert.deepEqual(built, { questionId: "qst_2", question: "Which gates?", chosen: ["lint", "tests"], text: "skip the flaky one" })
})

test("free text alone answers a question that has options — it is the last option", () => {
  const built = registeredAnswer({ id: "qst_3", spec: STORE }, new Map([[ROOT_PATH, typed("neither — use the keychain")]]))
  assert.deepEqual(built, { questionId: "qst_3", question: "Where should the settings live?", chosen: [], text: "neither — use the keychain" })
})

test("the follow-ups of the branch TAKEN ride the payload; the other branch contributes nothing", () => {
  const answers = new Map([
    [ROOT_PATH, pick(0)],
    [childPath(ROOT_PATH, 0, 0), pick(1)],
    [childPath(ROOT_PATH, 0, 1), typed("mention the migration")],
    // Staged earlier, then abandoned when the human changed the root answer. It is not live, so it must
    // not reach the worker — an absent follow-up means "not asked", never "asked and skipped".
    [childPath(ROOT_PATH, 1, 0), typed("the flaky test")],
  ])
  const built = registeredAnswer({ id: "qst_4", spec: TREE }, answers)
  assert.deepEqual(built, {
    questionId: "qst_4",
    question: "Ship it?",
    chosen: ["Yes"],
    followUps: [
      { questionId: "qst_4", question: "Tag a release too?", chosen: ["No"] },
      { questionId: "qst_4", question: "Anything for the notes?", chosen: [], text: "mention the migration" },
    ],
  })
})

test("a live-but-BLANK follow-up still rides the payload — seeing it and skipping it is information", () => {
  const built = registeredAnswer({ id: "qst_5", spec: TREE }, new Map([[ROOT_PATH, pick(1)]]))
  assert.deepEqual(built?.followUps, [{ questionId: "qst_5", question: "What blocks it?", chosen: [] }])
})

// ---- nodeAnswered ----

test("any one of a pick, a toggle or typed text is an answer; nothing is not", () => {
  assert.equal(nodeAnswered(STORE, blank), false)
  assert.equal(nodeAnswered(STORE, undefined), false)
  assert.equal(nodeAnswered(STORE, pick(1)), true)
  assert.equal(nodeAnswered(STORE, typed("  ")), false)
  assert.equal(nodeAnswered(STORE, typed("x")), true)
  assert.equal(nodeAnswered({ ...STORE, kind: "multi" }, toggle(0)), true)
  assert.equal(nodeAnswered({ ...STORE, kind: "multi" }, pick(0)), false)
})

// ---- settledQuestionNodes: the answered card, built from the answer registeredAnswer produced ----

const BRANCHED: AskedQuestion = {
  question: "Ship it?",
  kind: "question",
  options: [
    { label: "Hold", description: "nothing moves" },
    { label: "Ship", description: "cut the release", recommended: true, followUps: [
      { question: "Which channel?", kind: "question", options: [{ label: "latest" }, { label: "next" }] },
    ] },
  ],
}

test("a settled card keeps ONLY the picked option, lettered as it was, and the branch it opened", () => {
  const answer = registeredAnswer({ id: "qst_a", spec: BRANCHED }, new Map([[ROOT_PATH, pick(1)], [childPath(ROOT_PATH, 1, 0), pick(1)]]))!
  const nodes = settledQuestionNodes(BRANCHED, answer)
  assert.deepEqual(nodes.map((n) => [n.depth, n.question.options, n.settled]), [
    [1, ["B. Ship — cut the release"], { chosenIdxs: [0] }],
    [2, ["B. next"], { chosenIdxs: [0] }],
  ])
  // The recommendation follows the kept option to its new index rather than pointing at a dropped one.
  assert.deepEqual(nodes[0].question.recommendedIdxs, [0])
})

test("a settled card whose answer took the other branch drops the recommendation and opens nothing", () => {
  const answer = registeredAnswer({ id: "qst_a", spec: BRANCHED }, new Map([[ROOT_PATH, pick(0)]]))!
  const nodes = settledQuestionNodes(BRANCHED, answer)
  assert.equal(nodes.length, 1)
  assert.deepEqual(nodes[0].question.options, ["A. Hold — nothing moves"])
  assert.deepEqual(nodes[0].question.recommendedIdxs, [])
})

test("a multi carries EVERY recommended option, and its settled card keeps the ones that were picked", () => {
  const gates: AskedQuestion = {
    question: "Which gates?",
    kind: "multi",
    options: [{ label: "Typecheck", recommended: true }, { label: "Lint" }, { label: "Unit tests", recommended: true }],
  }
  assert.deepEqual(toParsedQuestion(gates).question.recommendedIdxs, [0, 2])
  const answer = registeredAnswer({ id: "qst_a", spec: gates }, new Map([[ROOT_PATH, { chosen: null, chosenSet: [1, 2], text: "" }]]))!
  const [node] = settledQuestionNodes(gates, answer)
  assert.deepEqual(node.question.options, ["B. Lint", "C. Unit tests"])
  // Re-indexed against the KEPT options: "Unit tests" is row 1 of the two that remain.
  assert.deepEqual(node.question.recommendedIdxs, [1])
})

test("free text settles as text with no option chips, and a multi keeps every toggle plus its note", () => {
  const free = settledQuestionNodes(STORE, registeredAnswer({ id: "qst_a", spec: STORE }, new Map([[ROOT_PATH, typed("Postgres")]]))!)
  assert.deepEqual([free[0].question.options, free[0].settled], [[], { chosenIdxs: [], text: "Postgres" }])
  const MULTI: AskedQuestion = { question: "Which platforms?", kind: "multi", options: [{ label: "macOS" }, { label: "Linux" }, { label: "Windows" }] }
  const multi = settledQuestionNodes(MULTI, registeredAnswer({ id: "qst_b", spec: MULTI }, new Map([[ROOT_PATH, { chosen: null, chosenSet: [2, 0], text: "ARM too" }]]))!)
  assert.deepEqual([multi[0].question.options, multi[0].settled], [["A. macOS", "C. Windows"], { chosenIdxs: [0, 1], text: "ARM too" }])
})

test("a chosen label the spec no longer names is kept as text rather than lost", () => {
  const nodes = settledQuestionNodes(STORE, { questionId: "qst_a", question: STORE.question, chosen: ["Postgres"] })
  assert.deepEqual(nodes[0].settled, { chosenIdxs: [], text: "Postgres" })
})

test("a SECRET question carries its flag into the card model, and an ordinary one does not", () => {
  assert.equal(toParsedQuestion({ question: "Token?", kind: "question", secret: true }).question.secret, true)
  assert.equal("secret" in toParsedQuestion({ question: "Name?", kind: "question" }).question, false)
})

// ---- THE QUESTION FENCE's CONTEXT (2026-10-13) ----

test("a fence's context rides under the question line as its own markdown block; the answer restates only the line", () => {
  const spec: AskedQuestion = { ...STORE, handle: "settings-store", context: "| Store | Crash-safe |\n|---|---|\n| SQLite | yes |" }
  const { question } = toParsedQuestion(spec)
  assert.equal(question.contextMd, "Where should the settings live?")
  assert.equal(question.detailMd, "| Store | Crash-safe |\n|---|---|\n| SQLite | yes |")
  const answer = registeredAnswer({ id: "qst_a", spec }, new Map([[ROOT_PATH, pick(0)]]))
  assert.equal(answer?.question, "Where should the settings live?")
  assert.deepEqual(answer?.chosen, ["SQLite"])
  // The settled card keeps the context too: in a fence-asked thread the card is the only place it is drawn.
  const [root] = settledQuestionNodes(spec, { questionId: "qst_a", question: spec.question, chosen: ["SQLite"] })
  assert.match(root.question.detailMd ?? "", /\| SQLite \| yes \|/)
})

test("no context, no change: the body is the question line alone", () => {
  const { question } = toParsedQuestion({ ...STORE, context: "   " })
  assert.equal(question.contextMd, "Where should the settings live?")
  assert.equal("detailMd" in question, false)
})

test("a card a remote session can't answer: secret, danger, free text, or a follow-up that is any of those", () => {
  const choice = { question: "Which?", kind: "question", options: [{ label: "A" }, { label: "B" }] } as const
  assert.equal(questionNeedsMachine(choice), false)
  assert.equal(questionNeedsMachine({ ...choice, kind: "multi" }), false)
  assert.equal(questionNeedsMachine({ question: "Name it", kind: "question" }), true)
  assert.equal(questionNeedsMachine({ ...choice, options: [] }), true)
  assert.equal(questionNeedsMachine({ ...choice, secret: true }), true)
  assert.equal(questionNeedsMachine({ ...choice, danger: true }), true)
  const under = (followUp: AskedQuestion): AskedQuestion => ({ ...choice, options: [{ label: "A", followUps: [followUp] }, { label: "B" }] })
  assert.equal(questionNeedsMachine(under(choice)), false)
  assert.equal(questionNeedsMachine(under({ ...choice, danger: true })), true)
  assert.equal(questionNeedsMachine(under({ question: "Name it", kind: "question" })), true)
})
