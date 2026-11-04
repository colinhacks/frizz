import { test } from "node:test"
import assert from "node:assert/strict"
import { splitQuestionBlocks, splitMessageQuestions, questionFenceIdsIn, followUpParentsIn, hasQuestionBlock, parseQuestionBlock, composeBlockAnswer, optionId, optionLetter, recommendedIndex, splitOptionId } from "./questionBlocks.ts"

// ---- splitQuestionBlocks ----

test("no fences → a single prose segment", () => {
  assert.deepEqual(splitQuestionBlocks("just some prose\n\nmore prose"), [
    { kind: "prose", text: "just some prose\n\nmore prose" },
  ])
})

test("empty / whitespace-only text → no segments", () => {
  assert.deepEqual(splitQuestionBlocks(""), [])
  assert.deepEqual(splitQuestionBlocks("   \n  "), [])
})

test("a single question block with surrounding prose (default kind)", () => {
  const text = "Here is my status.\n\n```question\nWhich default?\n\nA. Plain\nB. JSON\n```\n\nThanks!"
  assert.deepEqual(splitQuestionBlocks(text), [
    { kind: "prose", text: "Here is my status.\n\n" },
    { kind: "question", text: "Which default?\n\nA. Plain\nB. JSON", questionKind: "question", danger: false },
    { kind: "prose", text: "\n\nThanks!" },
  ])
})

test("info-string kinds: the RETIRED `approval` degrades to question; bare/other → question", () => {
  // `approval` is gone (2026-07-26). A legacy transcript's gate must still render — as the two-option
  // question it always was — never as a parse failure.
  const approval = splitQuestionBlocks("```question approval\nShip it?\n```")
  assert.deepEqual(approval, [{ kind: "question", text: "Ship it?", questionKind: "question", danger: false }])
  const bare = splitQuestionBlocks("```question\nShip it?\n```")
  assert.equal(bare[0].kind === "question" && bare[0].questionKind, "question")
  const explicit = splitQuestionBlocks("```question question\nShip it?\n```")
  assert.equal(explicit[0].kind === "question" && explicit[0].questionKind, "question")
})

test("multiple question blocks in order", () => {
  const text = "```question\nQ1?\nA. a\nB. b\n```\nbetween\n```question danger\nQ2?\n```"
  assert.deepEqual(splitQuestionBlocks(text), [
    { kind: "question", text: "Q1?\nA. a\nB. b", questionKind: "question", danger: false },
    { kind: "prose", text: "\nbetween\n" },
    { kind: "question", text: "Q2?", questionKind: "question", danger: true },
  ])
})

// ---- info-string kinds: multi, danger, multi-token degradation ----

test("```question multi → kind multi, no danger", () => {
  const segs = splitQuestionBlocks("```question multi\nWhich to fix?\n- A. one\n- B. two\n```")
  assert.deepEqual(segs, [{ kind: "question", text: "Which to fix?\n- A. one\n- B. two", questionKind: "multi", danger: false }])
})

test("```question multi danger → multi + danger (order-independent)", () => {
  const a = splitQuestionBlocks("```question multi danger\nWhich to force-delete?\n```")
  assert.deepEqual(a, [{ kind: "question", text: "Which to force-delete?", questionKind: "multi", danger: true }])
  const b = splitQuestionBlocks("```question danger multi\nWhich to force-delete?\n```")
  assert.equal(b[0].kind === "question" && b[0].questionKind, "multi")
  assert.equal(b[0].kind === "question" && b[0].danger, true)
})

test("legacy `approval danger` still carries danger onto the degraded question", () => {
  const a = splitQuestionBlocks("```question approval danger\nForce-merge?\n```")
  assert.deepEqual(a, [{ kind: "question", text: "Force-merge?", questionKind: "question", danger: true }])
  // Plain legacy `approval` carries no danger; trailing/internal whitespace is stripped, not tokenized.
  const b = splitQuestionBlocks("```question   approval   \nShip it?\n```")
  assert.equal(b[0].kind === "question" && b[0].questionKind, "question")
  assert.equal(b[0].kind === "question" && b[0].danger, false)
})

test("unknown / extra tokens degrade to kind question without breaking parsing", () => {
  // No recognized base token → question; the block still parses (never a hard fail).
  const a = splitQuestionBlocks("```question wat\nStill a question?\n```")
  assert.deepEqual(a, [{ kind: "question", text: "Still a question?", questionKind: "question", danger: false }])
  // A recognized kind survives an unknown neighbor token; danger still detected alongside noise.
  const b = splitQuestionBlocks("```question multi frobnicate danger\nPick some\n- A. x\n```")
  assert.equal(b[0].kind === "question" && b[0].questionKind, "multi")
  assert.equal(b[0].kind === "question" && b[0].danger, true)
})

test("unterminated fence degrades to plain prose (no question segment)", () => {
  const text = "prose\n\n```question\nnever closed...\nstill going"
  const segs = splitQuestionBlocks(text)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, "prose")
  assert.equal(segs[0].text, text)
})

test("a normal (non-question) code fence is left in prose", () => {
  const text = "run this:\n\n```bash\nnpm test\n```"
  assert.deepEqual(splitQuestionBlocks(text), [{ kind: "prose", text }])
})

// ---- a QUOTED opener is not an ask ----
// Documenting the protocol means showing the syntax, and the correct authoring form wraps the sample in
// a ```` fence. Hoisting that sample out into a live answerable card ALSO strands the enclosing ````
// delimiters as prose, whose unterminated fence then swallows the rest of the message (2026-07-25).

const TICK4 = "`".repeat(4)

test("a ```question sample inside a ```` fence stays prose — no phantom card", () => {
  const text = `${TICK4}\n\`\`\`question\nShip it?\n\n- A. Yes\n- B. No\n\`\`\`\n${TICK4}\n\nTrailing prose.`
  const segs = splitQuestionBlocks(text)
  assert.deepEqual(segs.map((s) => s.kind), ["prose"])
  assert.equal(segs[0].text, text) // the whole thing renders as the code block it is
})

test("a ```question sample inside a ```markdown fence stays prose", () => {
  const segs = splitQuestionBlocks("```markdown\n```question\nShip it?\n- A. Yes\n```\n```")
  assert.deepEqual(segs.map((s) => s.kind), ["prose"])
})

test("a REAL question after a quoted sample is still found", () => {
  const text = `Here is the syntax:\n\n${TICK4}\n\`\`\`question\nExample?\n- A. Yes\n\`\`\`\n${TICK4}\n\n\`\`\`question\nSo: ship it?\n\n- A. Yes\n- B. No\n\`\`\``
  const segs = splitQuestionBlocks(text)
  const asks = segs.filter((s) => s.kind === "question")
  assert.equal(asks.length, 1)
  assert.equal(asks[0].kind === "question" && asks[0].text, "So: ship it?\n\n- A. Yes\n- B. No")
})

// ---- parseQuestionBlock: choice detection ----

test("lettered options (markdown list form) → chips, stripped from context", () => {
  const body = "Which store?\n\n- A. SQLite — transactional\n- B. JSON — zero deps\n\nRecommendation: A, for consistency."
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "Which store?")
  assert.deepEqual(p.options, ["A. SQLite — transactional", "B. JSON — zero deps"])
  assert.equal(p.recommendation, "Recommendation: A, for consistency.")
})

test("options FOLLOWED by a trailing Note paragraph → chips STILL detected, note → trailingMd (the nub#440 bug)", () => {
  // The worker put a footnote after the choices; the old "options must be trailing" rule then found no
  // run and dropped every chip. Inline markdown (backticks, **bold**, em-dash) must not confuse it either.
  const body =
    "How do you want to proceed?\n\n" +
    "- A. Merge as-is (`--admin`) — my recommendation\n" +
    "- B. Switch to **pnpm-owned** first\n" +
    "- C. Hold — review it yourself\n\n" +
    "Note: the invalid-URL warn-drop is in the PR body as recommend-only."
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, ["A. Merge as-is (`--admin`) — my recommendation", "B. Switch to **pnpm-owned** first", "C. Hold — review it yourself"])
  assert.equal(p.contextMd, "How do you want to proceed?")
  assert.equal(p.trailingMd, "Note: the invalid-URL warn-drop is in the PR body as recommend-only.")
})

test("lettered options (bare form, no list marker)", () => {
  const body = "Pick one:\nA. Tabs\nB. Spaces"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "Pick one:")
  assert.deepEqual(p.options, ["A. Tabs", "B. Spaces"])
  assert.equal(p.recommendation, undefined)
})

test("numbered options → chips", () => {
  const body = "How many retries?\n\n1. Zero\n2. Three\n3. Ten"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "How many retries?")
  assert.deepEqual(p.options, ["1. Zero", "2. Three", "3. Ten"])
})

// ---- the question line is never an option ----
// A handoff carrying several blocks makes workers number the QUESTION too ("C. Does `brokerTo` …?"),
// which OPTION_RE cannot tell from a choice: the question was chipped as option 0, the card rendered NO
// question at all, and the freetext row re-used the letter (options ended at B → placeholder "C.").
// Every case below is a verbatim shape from the transcript corpus on this machine.

test("a LETTER-numbered question line is context, not the first option", () => {
  const body = "C. Does `brokerTo` imply net access to the host?\n\n- A. No — the host must also be in `net` (recommended)\n- B. Yes — listing a host auto-allows it"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "C. Does `brokerTo` imply net access to the host?")
  assert.deepEqual(p.options, ["A. No — the host must also be in `net`", "B. Yes — listing a host auto-allows it"])
  assert.deepEqual(p.recommendedIdxs, [0]) // the recommendation follows the option, not the old off-by-one index
})

test("a question numbered with the SAME letter its options start at is still context", () => {
  const body = "A. What does `...` become?\n\n- A. Repurpose it\n- B. Drop it\n- C. Keep it"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "A. What does `...` become?")
  assert.deepEqual(p.options, ["A. Repurpose it", "B. Drop it", "C. Keep it"])
})

test("a NUMBER-numbered question line is context, even against numbered options", () => {
  const body = "3. What should `<tmp>` mean?\n\n1. A private writable per-run directory\n2. The OS shared temp dir"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "3. What should `<tmp>` mean?")
  assert.deepEqual(p.options, ["1. A private writable per-run directory", "2. The OS shared temp dir"])
})

test("a numbered PLAN above the choices stays prose (the whole lead-in is context)", () => {
  const body = "Retire the existing PRs? The plan:\n\n1. Sync local `main`\n2. Re-land the four fixes\n3. Close the redundant PRs\n\n- A. Yes — do the full plan\n- B. Hold"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "Retire the existing PRs? The plan:\n\n1. Sync local `main`\n2. Re-land the four fixes\n3. Close the redundant PRs")
  assert.deepEqual(p.options, ["A. Yes — do the full plan", "B. Hold"])
})

test("a numbered question with NO options is a freetext question, not a one-option card", () => {
  const p = parseQuestionBlock("4. Which name do you want?", "question")
  assert.deepEqual(p.options, [])
  assert.equal(p.contextMd, "4. Which name do you want?")
})

test("a block that OPENS with a real option run keeps every option (no question to demote)", () => {
  // "A." opens the list and "B." continues it, so nothing here is a question — eating option A to invent
  // one would silently lose a choice.
  const p = parseQuestionBlock("- A. Approve as-is\n- B. Approve with edits", "question")
  assert.deepEqual(p.options, ["A. Approve as-is", "B. Approve with edits"])
  assert.equal(p.contextMd, "")
})

test("a lone MARKED option is still an option (only a bare leading line is demoted)", () => {
  const p = parseQuestionBlock("- A. Approve as-is", "question")
  assert.deepEqual(p.options, ["A. Approve as-is"])
})

test("a run that does NOT open a list is left alone — a skipped letter never eats a choice", () => {
  // "A, C" is a typo'd list, not a question above a list: demoting A would drop a real option, so the
  // ambiguous case keeps the old behavior.
  const p = parseQuestionBlock("Pick one:\n- A. Foo\n- C. Bar", "question")
  assert.deepEqual(p.options, ["A. Foo", "C. Bar"])
  assert.equal(p.contextMd, "Pick one:")
})

test("options that legitimately start at B are not re-read as question + list", () => {
  const p = parseQuestionBlock("Pick one:\n- B. Foo\n- C. Bar", "question")
  assert.deepEqual(p.options, ["B. Foo", "C. Bar"])
})

// ---- grouped options: a prose heading between choices doesn't end the run ----

test("a group heading between C and D keeps ALL SIX options answerable", () => {
  const body =
    "Package name — brainstorm.\n\n" +
    "Thread / loom family (frizz = a frizzed thread):\n" +
    "- A. **frizzloom** — keeps the lineage\n" +
    "- B. **warp** — the taut loom threads\n" +
    "- C. **selvage** — the edge that doesn't frizz\n\n" +
    "Melee family (frizz = a scrap/brawl of agents):\n" +
    "- D. **melee** — a direct synonym\n" +
    "- E. **fracas** — a noisy frizz\n" +
    "- F. **tussle** — a scrappy frizz\n\n" +
    "Also still open: `frizz`, `frizzhq`."
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options.map(optionId), ["A", "B", "C", "D", "E", "F"])
  assert.equal(p.options[3], "D. **melee** — a direct synonym")
  // The heading rides WITH the option it introduces instead of being stranded below the chips.
  assert.equal(p.optionHeadings?.[3], "Melee family (frizz = a scrap/brawl of agents):")
  assert.equal(p.optionHeadings?.[0], undefined)
  assert.equal(p.contextMd, "Package name — brainstorm.\n\nThread / loom family (frizz = a frizzed thread):")
  assert.equal(p.trailingMd, "Also still open: `frizz`, `frizzhq`.")
})

test("a SECOND question's list restarts at A, so the run still ends at the first set", () => {
  // Two asks crammed into one block: the heading rule must not weld them into one six-option menu.
  const body =
    "Two scope calls:\n\n" +
    "**1. Which formats?**\n- A. Safe tier\n- B. Safe tier + office\n\n" +
    "**2. Should I proceed?**\n- A. Implement now\n- B. Stop here"
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, ["A. Safe tier", "B. Safe tier + office"])
  assert.equal(p.optionHeadings, undefined)
  assert.match(p.trailingMd ?? "", /^\*\*2\. Should I proceed\?\*\*/)
})

test("a numbered list after lettered options is trailing prose, not a continuation", () => {
  const body = "Approve the plan?\n\n- A. Approve all three\n- B. Adjust one\n\nThe three calls:\n1. SURFACE — config-only\n2. STREAMING — pipe bridge"
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, ["A. Approve all three", "B. Adjust one"])
  assert.equal(p.trailingMd, "The three calls:\n1. SURFACE — config-only\n2. STREAMING — pipe bridge")
})

test("a Recommendation line always closes the choices, even with more options below", () => {
  const body = "Pick:\n- A. One\n- B. Two\n\nRecommendation: A\n\n- C. A later, unrelated list item"
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, ["A. One", "B. Two"])
  assert.equal(p.recommendation, "Recommendation: A")
})

test("prose between a numbered question line and its options still finds the options", () => {
  // The question line is demoted, which empties the run — the real list sits below the prose.
  const body = "9. How is host loopback exposed?\nThe knot is nested runs.\n- A. Require an explicit target\n- B. Keep current"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "9. How is host loopback exposed?\nThe knot is nested runs.")
  assert.deepEqual(p.options, ["A. Require an explicit target", "B. Keep current"])
})

test("no trailing option run → freetext-only (empty options), whole body is context", () => {
  const body = "What should I name the flag? Give me a short kebab-case string."
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, [])
  assert.equal(p.contextMd, body)
})

test("a lone Recommendation line without options stays in context (not special)", () => {
  const body = "Some prose.\n\nRecommendation: do the thing."
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, [])
  assert.equal(p.contextMd, body)
})

test("a go/no-go gate is an ordinary two-option question", () => {
  const p = parseQuestionBlock("Ready to ship?\nA. Ship it\nB. Hold", "question")
  assert.equal(p.kind, "question")
  assert.deepEqual(p.options, ["A. Ship it", "B. Hold"])
})

test("CRLF line endings are handled in both split and parse", () => {
  const segs = splitQuestionBlocks("```question\r\nWhich?\r\nA. one\r\nB. two\r\n```")
  assert.equal(segs[0].kind, "question")
  const p = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  assert.equal(p.contextMd, "Which?")
  assert.deepEqual(p.options, ["A. one", "B. two"])
})

test("parse defaults danger to false and threads a passed danger flag through", () => {
  const noFlag = parseQuestionBlock("Ready?\nA. Yes", "question")
  assert.equal(noFlag.danger, false)
  const flagged = parseQuestionBlock("Ready?\nA. Yes", "question", true)
  assert.equal(flagged.kind, "question")
  assert.equal(flagged.danger, true)
  // danger threads through the freetext-only (no trailing options) return path too.
  const freetext = parseQuestionBlock("Type a reason.", "question", true)
  assert.deepEqual(freetext.options, [])
  assert.equal(freetext.danger, true)
})

test("multi kind carries through parse with options detected", () => {
  const body = "Which findings should I fix?\n\n- A. Null deref in parse()\n- B. Off-by-one in slice()\n- C. Flaky timeout test"
  const p = parseQuestionBlock(body, "multi")
  assert.equal(p.kind, "multi")
  assert.equal(p.contextMd, "Which findings should I fix?")
  assert.deepEqual(p.options, ["A. Null deref in parse()", "B. Off-by-one in slice()", "C. Flaky timeout test"])
})

// ---- optionId ----

test("optionId extracts the leading letter/number identifier, uppercased", () => {
  assert.equal(optionId("A. SQLite — transactional"), "A")
  assert.equal(optionId("b) lowercase becomes upper"), "B")
  assert.equal(optionId("3. Ten"), "3")
  // No lettered/numbered prefix → the trimmed text (defensive fallback).
  assert.equal(optionId("  just prose  "), "just prose")
})

// ---- composeBlockAnswer ----

test("compose single-select: the chosen chip is the answer while set, else the freetext", () => {
  const blk = parseQuestionBlock("Pick one\nA. SQLite\nB. JSON", "question")
  assert.equal(composeBlockAnswer(blk, { chosen: 0, text: "" }), "A. SQLite")
  // Text beside a chosen chip is an UNSELECTED DRAFT, not an override — a chip click no longer clears
  // the box (2026-09-02), and the producers null `chosen` whenever the box takes focus, so a non-null
  // chip means it was picked last and the reply is the chip.
  assert.equal(composeBlockAnswer(blk, { chosen: 0, text: "actually neither" }), "A. SQLite")
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "actually neither" }), "actually neither")
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "" }), "")
})

test("compose a danger gate: same single-select semantics as any question", () => {
  const blk = parseQuestionBlock("Ship it?\nA. Approve\nB. Hold", "question", true)
  assert.equal(composeBlockAnswer(blk, { chosen: 1, text: "" }), "B. Hold")
  // A MULTI-LINE freetext answer survives compose verbatim — the box takes newlines (2026-07-26).
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "Hold.\n\nRerun CI first." }), "Hold.\n\nRerun CI first.")
})

test("compose multi: selected letters in option order, freetext appends color", () => {
  const blk = parseQuestionBlock("Which to fix?\n- A. one\n- B. two\n- C. three\n- D. four", "multi")
  // Selected letters render in OPTION order regardless of click order.
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "", chosenSet: [2, 0, 3] }), "A, C, D")
  // Freetext appends as color after the letters.
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "and skip the flaky one", chosenSet: [0, 2] }), "A, C — and skip the flaky one")
  // Selecting none + text-only stays valid (freetext alone).
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "none of these — do X instead", chosenSet: [] }), "none of these — do X instead")
  // Nothing selected and no text → unanswered.
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "", chosenSet: [] }), "")
  // A multi block with an absent chosenSet is treated as an empty selection.
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "" }), "")
})

// ---- recommendedIndex ----

const OPTS = ["A. Implement all three", "B. Just the primary fix", "C. Diagnosis only"]

test("recommendedIndex: plain letter matches its option", () => {
  assert.equal(recommendedIndex("Recommendation: B — tightest fix", OPTS), 1)
  assert.equal(recommendedIndex("Recommendation: A.", OPTS), 0)
})

test("recommendedIndex: markdown-bolded letter still resolves (the **B** regression)", () => {
  // Real-world break: `Recommendation: **B** — …` used to return null and fall back to a muted caption.
  assert.equal(recommendedIndex("Recommendation: **B** — it's the tightest fix", OPTS), 1)
  assert.equal(recommendedIndex("Recommendation: _C_ for now", OPTS), 2)
  assert.equal(recommendedIndex("Recommendation: `A`", OPTS), 0)
})

test("recommendedIndex: also tolerates a bolded option identifier", () => {
  assert.equal(recommendedIndex("Recommendation: B", ["**A.** one", "**B.** two"]), 1)
})

test("recommendedIndex: numeric identifiers", () => {
  assert.equal(recommendedIndex("Recommendation: 2 — cheaper", ["1. one", "2. two", "3. three"]), 1)
})

test("recommendedIndex: no match → null (keeps the muted caption fallback)", () => {
  assert.equal(recommendedIndex(undefined, OPTS), null)
  assert.equal(recommendedIndex("Recommendation: whichever you prefer", OPTS), null)
  assert.equal(recommendedIndex("Recommendation: Z — off the list", OPTS), null)
  // Guard the `(?![A-Za-z0-9])` boundary: an English lead word must NOT read as its first-letter option
  // ("Approve" must not chip option A). Dropping the lookahead would silently regress this to 0.
  assert.equal(recommendedIndex("Recommendation: Approve as-is", OPTS), null)
})

// ---- inline "recommended" marker (the primary mechanism) ----

test("inline (recommended) marker → flags the option, strips the marker, no leftover text", () => {
  const p = parseQuestionBlock("How to proceed?\n\n- A. SQLite — transactional (recommended)\n- B. JSON — zero deps", "question")
  assert.deepEqual(p.recommendedIdxs, [0])
  assert.deepEqual(p.options, ["A. SQLite — transactional", "B. JSON — zero deps"])
  assert.equal(p.recommendedNote, undefined)
})

test("inline (recommended: why) → rationale captured as the note", () => {
  const p = parseQuestionBlock("Pick one:\n\n- A. one\n- B. two (recommended: cheaper and simpler)", "question")
  assert.deepEqual(p.recommendedIdxs, [1])
  assert.deepEqual(p.options, ["A. one", "B. two"])
  assert.equal(p.recommendedNote, "cheaper and simpler")
})

test("inline marker variants: **Recommended** — lead, trailing — recommended, no dangling separators", () => {
  const lead = parseQuestionBlock("Q?\n\n- A. keep it\n- B. **Recommended** — switch to pnpm", "question")
  assert.deepEqual(lead.recommendedIdxs, [1])
  assert.deepEqual(lead.options, ["A. keep it", "B. switch to pnpm"])
  const trail = parseQuestionBlock("Q?\n\n- A. Hold — recommended\n- B. Ship now", "question")
  assert.deepEqual(trail.recommendedIdxs, [0])
  assert.deepEqual(trail.options, ["A. Hold", "B. Ship now"])
})

test("inline marker preserves the option's own backticks/emphasis when stripping", () => {
  const p = parseQuestionBlock("Flag?\n\n- A. Use `--strict` (recommended)\n- B. Use `--safe`", "question")
  assert.deepEqual(p.options, ["A. Use `--strict`", "B. Use `--safe`"])
  assert.deepEqual(p.recommendedIdxs, [0])
})

test("'recommendation' (the noun) in option prose does NOT flag it — only the word 'recommended'", () => {
  const p = parseQuestionBlock("Q?\n\n- A. Merge as-is — my recommendation stands\n- B. Hold", "question")
  assert.deepEqual(p.recommendedIdxs, [])
  assert.deepEqual(p.options, ["A. Merge as-is — my recommendation stands", "B. Hold"])
})

test("first flagged option wins when several carry the marker", () => {
  const p = parseQuestionBlock("Q?\n\n- A. one\n- B. two (recommended)\n- C. three (recommended)", "question")
  assert.deepEqual(p.recommendedIdxs, [1])
})

test("a `multi` flags EVERY marked option — its recommendation is the set worth ticking", () => {
  const p = parseQuestionBlock("Q?\n\n- A. one (recommended: fast)\n- B. two\n- C. three (recommended)", "multi")
  assert.deepEqual(p.recommendedIdxs, [0, 2])
  assert.deepEqual(p.options, ["A. one", "B. two", "C. three"])
  assert.equal(p.recommendedNote, "fast")
})

test("no marker + no rec line → recommendedIdxs empty, no caption", () => {
  const p = parseQuestionBlock("Q?\n\n- A. one\n- B. two", "question")
  assert.deepEqual(p.recommendedIdxs, [])
  assert.equal(p.recommendation, undefined)
})

// ---- legacy "Recommendation: X" line still works as a fallback ----

test("legacy rec line: matches an option by letter → recommendedIdxs + note, chip (no inline marker)", () => {
  const p = parseQuestionBlock("Pick:\n\n- A. one\n- B. two\n\nRecommendation: B — cheaper", "question")
  assert.deepEqual(p.recommendedIdxs, [1])
  assert.equal(p.recommendedNote, "Recommendation: B — cheaper")
  assert.equal(p.recommendation, "Recommendation: B — cheaper")
})

test("legacy rec line that names no option → recommendedIdxs empty but recommendation kept (muted caption)", () => {
  const p = parseQuestionBlock("Pick:\n\n- A. one\n- B. two\n\nRecommendation: whichever you like", "question")
  assert.deepEqual(p.recommendedIdxs, [])
  assert.equal(p.recommendation, "Recommendation: whichever you like")
})

test("inline marker WINS over a legacy rec line if both are present", () => {
  const p = parseQuestionBlock("Pick:\n\n- A. one (recommended)\n- B. two\n\nRecommendation: B", "question")
  assert.deepEqual(p.recommendedIdxs, [0])
})

// ---- inline marker: rationale separators + content-vs-marker (round-2 review fixes) ----

test("inline note accepts comma/semicolon separators, not just colon/dash", () => {
  const comma = parseQuestionBlock("Q?\n\n- A. Foo (recommended, because it's faster)\n- B. Bar", "question")
  assert.deepEqual(comma.options, ["A. Foo", "B. Bar"])
  assert.deepEqual(comma.recommendedIdxs, [0])
  assert.equal(comma.recommendedNote, "because it's faster")
  const semi = parseQuestionBlock("Q?\n\n- A. Foo (recommended; also cheapest)\n- B. Bar", "question")
  assert.equal(semi.recommendedNote, "also cheapest")
})

test("a bare interior 'recommended' is CONTENT, not a marker — never flagged, never rewritten", () => {
  const p = parseQuestionBlock("Q?\n\n- A. Use the recommended settings\n- B. Use custom settings", "question")
  assert.deepEqual(p.recommendedIdxs, [])
  assert.deepEqual(p.options, ["A. Use the recommended settings", "B. Use custom settings"])
  // A hyphenated neighbor ("recommended-only") is likewise left as content.
  const q = parseQuestionBlock("Q?\n\n- A. Enable recommended-only mode\n- B. Enable all", "question")
  assert.deepEqual(q.recommendedIdxs, [])
  assert.deepEqual(q.options, ["A. Enable recommended-only mode", "B. Enable all"])
})

test("inline marker with no space before the paren, preserving the label's own backticks", () => {
  const p = parseQuestionBlock("Flag?\n\n- A. Use `--strict`(recommended)\n- B. Use `--safe`", "question")
  assert.deepEqual(p.options, ["A. Use `--strict`", "B. Use `--safe`"])
  assert.deepEqual(p.recommendedIdxs, [0])
})

// ---- hasQuestionBlock ----

test("hasQuestionBlock: true only for a real fence, and never for a QUOTED one", () => {
  assert.equal(hasQuestionBlock("Some prose with no fence at all."), false)
  assert.equal(hasQuestionBlock("Lead-in.\n\n```question\nGo?\n- A. Yes\n- B. No\n```"), true)
  // A worker DOCUMENTING the protocol wraps its sample in an outer fence — that is a code block, not an
  // ask, and the queue card must not lift it out of the collapse as if a decision were owed.
  assert.equal(hasQuestionBlock("Here is the shape:\n\n````\n```question\nGo?\n```\n````"), false)
  // An unterminated opener never parses, so it stays prose.
  assert.equal(hasQuestionBlock("```question\nGo?"), false)
})

// ---- orphaned-option self-heal (options written OUTSIDE the fence) ----

test("heal: an option-less fence adopts the A-led list immediately after it (pullfrog-app 2026-08-25)", () => {
  // The real failure shape: the worker closed the fence after the question sentence and wrote the
  // options outside as ordinary markdown — a freetext-only card over an inert bullet list.
  const text = [
    "Context prose above.",
    "",
    "```question",
    "Pullfrog runs stop for 85 active orgs on Sep 8. What should happen?",
    "```",
    "",
    "- A. Send an opt-out notice, then auto-start (recommended: gets the conversion)",
    "- B. Auto-charge with no further notice",
    "- C. Keep confirmation mandatory, but soften the deadline",
    "- D. Change nothing",
  ].join("\n")
  const segs = splitQuestionBlocks(text)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].kind, "prose")
  const q = segs[1]
  assert.equal(q.kind, "question")
  const parsed = parseQuestionBlock(q.text, "question")
  assert.equal(parsed.options.length, 4)
  assert.equal(parsed.contextMd, "Pullfrog runs stop for 85 active orgs on Sep 8. What should happen?")
  assert.deepEqual(parsed.recommendedIdxs, [0])
  assert.equal(parsed.recommendedNote, "gets the conversion")
})

test("heal: two option-less fences each adopt their own trailing list", () => {
  const text = [
    "```question",
    "First question?",
    "```",
    "",
    "- A. one",
    "- B. two",
    "",
    "```question",
    "Second question?",
    "```",
    "",
    "- A. yes",
    "- B. no",
  ].join("\n")
  const segs = splitQuestionBlocks(text)
  assert.deepEqual(segs.map((s) => s.kind), ["question", "question"])
  const p0 = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  const p1 = parseQuestionBlock(segs[1].kind === "question" ? segs[1].text : "", "question")
  assert.deepEqual(p0.options, ["A. one", "B. two"])
  assert.deepEqual(p1.options, ["A. yes", "B. no"])
})

test("heal: prose after the adopted run stays prose", () => {
  const text = "```question\nWhich?\n```\n- A. one\n- B. two\n\nUnrelated closing prose."
  const segs = splitQuestionBlocks(text)
  assert.equal(segs.length, 2)
  assert.equal(segs[1].kind === "prose" && segs[1].text.trim(), "Unrelated closing prose.")
  const parsed = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  assert.deepEqual(parsed.options, ["A. one", "B. two"])
})

test("heal: a paragraph between the fence and the list blocks adoption", () => {
  const text = "```question\nWhich?\n```\n\nSome unrelated paragraph.\n\n- A. one\n- B. two"
  const segs = splitQuestionBlocks(text)
  const parsed = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  assert.equal(parsed.options.length, 0)
})

test("heal: a list that does not open at A/1 is not adopted", () => {
  const text = "```question\nWhich?\n```\n- C. three\n- D. four"
  const segs = splitQuestionBlocks(text)
  const parsed = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  assert.equal(parsed.options.length, 0)
})

test("heal: a lone orphan option is too weak a signal to steal", () => {
  const text = "```question\nWhich?\n```\n- A. the only line"
  const segs = splitQuestionBlocks(text)
  const parsed = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  assert.equal(parsed.options.length, 0)
})

test("heal: a fence closed MID-list adopts the continuation", () => {
  const text = "```question\nWhich?\n- A. one\n- B. two\n```\n- C. three\n- D. four"
  const segs = splitQuestionBlocks(text)
  assert.equal(segs.length, 1)
  const parsed = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  assert.deepEqual(parsed.options, ["A. one", "B. two", "C. three", "D. four"])
})

test("heal: a complete block does not steal a fresh list that restarts at A", () => {
  // The follow-on list opens at A, which does not continue B — it is the message's own list.
  const text = "```question\nWhich?\n- A. one\n- B. two\n```\n\n- A. unrelated\n- B. also unrelated"
  const segs = splitQuestionBlocks(text)
  assert.equal(segs.length, 2)
  const parsed = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  assert.deepEqual(parsed.options, ["A. one", "B. two"])
})

test("heal: a block whose run is followed by trailing prose is complete — nothing adopted", () => {
  const text = "```question\nWhich?\n- A. one\n- B. two\n\nNote: a footnote.\n```\n- C. stray"
  const segs = splitQuestionBlocks(text)
  assert.equal(segs.length, 2)
  const parsed = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  assert.deepEqual(parsed.options, ["A. one", "B. two"])
})

test("heal: an adopted run carries its Recommendation line along", () => {
  const text = "```question\nWhich?\n```\n- A. one\n- B. two\nRecommendation: B\n\nAfterword."
  const segs = splitQuestionBlocks(text)
  assert.equal(segs.length, 2)
  const parsed = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  assert.deepEqual(parsed.options, ["A. one", "B. two"])
  assert.deepEqual(parsed.recommendedIdxs, [1])
  assert.equal(segs[1].kind === "prose" && segs[1].text.trim(), "Afterword.")
})

test("heal: numbered orphan lists work too", () => {
  const text = "```question\nHow many?\n```\n1. one\n2. two\n3. three"
  const segs = splitQuestionBlocks(text)
  const parsed = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  assert.deepEqual(parsed.options, ["1. one", "2. two", "3. three"])
})

test("heal: hasQuestionBlock and answerability agree on a healed message", () => {
  const text = "```question\nWhich?\n```\n- A. one\n- B. two"
  assert.equal(hasQuestionBlock(text), true)
})

test("an info-string `qst_…` token names the REGISTERED row this fence stands for", () => {
  const a = splitQuestionBlocks("```question qst_6b9bdbe563fa\nCut 4.5.0 now?\n\n- A. Yes\n- B. No\n```")
  assert.deepEqual(a, [{ kind: "question", text: "Cut 4.5.0 now?\n\n- A. Yes\n- B. No", questionKind: "question", danger: false, registeredId: "qst_6b9bdbe563fa" }])
})

test("the id rides beside the other tokens, and a fence without one carries no key at all", () => {
  const withBoth = splitQuestionBlocks("```question multi qst_ab12cd34ef56\nWhich?\n- A. one\n- B. two\n```")
  assert.deepEqual(withBoth, [{ kind: "question", text: "Which?\n- A. one\n- B. two", questionKind: "multi", danger: false, registeredId: "qst_ab12cd34ef56" }])
  // Absent rather than undefined: a plain fence still deep-equals the shape it had before ids existed.
  assert.deepEqual(splitQuestionBlocks("```question\nWhich?\n- A. one\n- B. two\n```"), [
    { kind: "question", text: "Which?\n- A. one\n- B. two", questionKind: "question", danger: false },
  ])
})

test("a token that only looks like an id is ignored, like every other unknown token", () => {
  const a = splitQuestionBlocks("```question qst-not-an-id\nWhich?\n- A. one\n- B. two\n```")
  assert.deepEqual(a, [{ kind: "question", text: "Which?\n- A. one\n- B. two", questionKind: "question", danger: false }])
})

// A worker PLACING a question it already registered has nothing to put in the body — the card comes
// from the row — so the two-line marker is the form it should be able to write.
test("a placement marker is two lines: the id in the info string and nothing in the body", () => {
  const a = splitQuestionBlocks("Setup prose.\n\n```question qst_ab12cd34ef56\n```\n\nClosing prose.")
  assert.deepEqual(a, [
    { kind: "prose", text: "Setup prose.\n\n" },
    { kind: "question", text: "", questionKind: "question", danger: false, registeredId: "qst_ab12cd34ef56" },
    { kind: "prose", text: "\n\nClosing prose." },
  ])
})

test("the same marker with a blank line in it parses identically — the shape a worker reaches for varies", () => {
  const a = splitQuestionBlocks("```question qst_ab12cd34ef56\n\n```")
  assert.deepEqual(a, [{ kind: "question", text: "", questionKind: "question", danger: false, registeredId: "qst_ab12cd34ef56" }])
})

test("an EMPTY fence with no id is left as prose — it names nothing, so it can never become a blank card", () => {
  assert.deepEqual(splitQuestionBlocks("```question\n```"), [{ kind: "prose", text: "```question\n```" }])
  assert.deepEqual(splitQuestionBlocks("```question multi\n```"), [{ kind: "prose", text: "```question multi\n```" }])
})

test("a marker never swallows the prose around it, and a real fence after one still parses", () => {
  const a = splitQuestionBlocks("A.\n\n```question qst_aaaaaaaaaaaa\n```\n\nB.\n\n```question\nWhich?\n- A. one\n- B. two\n```")
  assert.deepEqual(a.map((s) => s.kind), ["prose", "question", "prose", "question"])
  assert.equal(a[1].kind === "question" && a[1].registeredId, "qst_aaaaaaaaaaaa")
  assert.equal(a[3].kind === "question" && a[3].text, "Which?\n- A. one\n- B. two")
})

test("a lettered list after a placement marker is the message's own prose, never adopted into it", () => {
  // The orphan-heal exists for a fence that closed early and left its options outside. A marker has no
  // body to orphan them from, so adopting the list would delete it from the transcript with that body.
  const a = splitQuestionBlocks("Setup.\n\n```question qst_aaaaaaaaaaaa\n```\n\n- A. the first step\n- B. the second step\n\nClosing.")
  assert.deepEqual(a.map((s) => s.kind), ["prose", "question", "prose"])
  assert.equal(a[1].kind === "question" && a[1].text, "")
  assert.equal(a[2].kind === "prose" && a[2].text.includes("- A. the first step"), true)
})

test("a marker a worker QUOTES — showing the form, or pasting the contract's own indented sample — stays prose", () => {
  const quoted = "Here is the form:\n\n````\n```question qst_aaaaaaaaaaaa\n```\n````\n\nThat is all."
  assert.deepEqual(splitQuestionBlocks(quoted).map((s) => s.kind), ["prose"])
  // The contract prints the sample indented by four spaces, which is a code block, not an opener.
  const indented = "Here is the form:\n\n    ```question qst_aaaaaaaaaaaa\n    ```\n\nThat is all."
  assert.deepEqual(splitQuestionBlocks(indented).map((s) => s.kind), ["prose"])
})

test("optionLetter: frizz-built options are lettered from A, and run on to AA past Z", () => {
  assert.deepEqual([0, 1, 8, 25, 26, 27, 51, 52].map(optionLetter), ["A.", "B.", "I.", "Z.", "AA.", "AB.", "AZ.", "BA."])
})

test("splitOptionId: the identifier comes off the label for the gutter, the rest stays verbatim", () => {
  assert.deepEqual(splitOptionId("2. SQLite — transactional"), { id: "2", rest: "SQLite — transactional" })
  assert.deepEqual(splitOptionId("12) Twelve"), { id: "12", rest: "Twelve" })
  // A worker's numbered fence: the number comes off too; a live card shows the option's position instead.
  assert.deepEqual(splitOptionId("b. lowercase"), { id: "B", rest: "lowercase" })
  assert.deepEqual(splitOptionId("AA. Past twenty-six"), { id: "AA", rest: "Past twenty-six" })
  // No identifier, or a word that merely starts like one, is left alone.
  assert.deepEqual(splitOptionId("SQLite. Transactional"), { rest: "SQLite. Transactional" })
  assert.deepEqual(splitOptionId("just prose"), { rest: "just prose" })
})

// ---- THE QUESTION FENCE (2026-10-13): splitMessageQuestions ----
// A thread dispatched after QUESTION_FENCE_RETIRED_AT asks with a structured fence whose `id:` names a row.
// The shared reader decides what is a fence; this module only turns its blocks into segments.

const ASK = [
  "```question",
  "id: settings-store",
  "kind: choice",
  "question: Should the settings store use SQLite or a JSON file?",
  "options:",
  "  - label: SQLite",
  "    recommended: true",
  "  - label: JSON file",
  "---",
  "| Store | Crash-safe |",
  "|---|---|",
  "| SQLite | yes |",
  "```",
].join("\n")
const FOLLOW_UP = ["```question", "id: sqlite-path", "kind: choice", "when: settings-store = SQLite", "question: Where should the database live?", "options:", "  - Beside the sessions database", "  - In the project's `.frizz/`", "```"].join("\n")
const REF = (id: string) => `\`\`\`question\nid: ${id}\n\`\`\``

test("fence grammar OFF is the legacy splitter, byte for byte — a legacy thread renders exactly as before", () => {
  const text = `Lead.\n\n${ASK}\n\nTail.`
  assert.deepEqual(splitMessageQuestions(text, false), splitQuestionBlocks(text))
})

test("an ask fence is ONE question segment carrying its read, with the prose either side kept in place", () => {
  const segs = splitMessageQuestions(`Lead paragraph.\n\n${ASK}\n\nWhat happens either way.`, true)
  assert.deepEqual(segs.map((s) => s.kind), ["prose", "question", "prose"])
  const q = segs[1]
  assert.ok(q.kind === "question" && q.fence?.form === "ask")
  assert.equal(q.fence.id, "settings-store")
  assert.equal(q.fence.spec.context, "| Store | Crash-safe |\n|---|---|\n| SQLite | yes |")
  assert.equal(segs[0].kind === "prose" && segs[0].text.trim(), "Lead paragraph.")
  assert.equal(segs[2].kind === "prose" && segs[2].text.trim(), "What happens either way.")
})

test("a reference fence is a segment too; a follow-up keeps its `when:` so the renderer can draw nothing for it", () => {
  const segs = splitMessageQuestions(`${ASK}\n\n${FOLLOW_UP}\n\nLater:\n\n${REF("settings-store")}`, true).filter((s) => s.kind === "question")
  assert.deepEqual(segs.map((s) => (s.kind === "question" ? s.fence?.form : null)), ["ask", "ask", "ref"])
  const follow = segs[1]
  assert.ok(follow.kind === "question" && follow.fence?.form === "ask")
  assert.deepEqual(follow.fence.when, { parent: "settings-store", option: "SQLite" })
})

test("a ````question fence whose context carries a code block is one segment — the legacy splitter never saw it", () => {
  const four = ["````question", "id: retry-backoff", "kind: text", "question: Which backoff?", "---", "```diff", "-  await sleep(100)", "+  await sleep(2 ** attempt * 100)", "```", "````"].join("\n")
  const segs = splitMessageQuestions(`Lead.\n\n${four}\n\nTail.`, true)
  assert.deepEqual(segs.map((s) => s.kind), ["prose", "question", "prose"])
  assert.ok(segs[1].kind === "question" && segs[1].fence?.form === "ask")
  assert.match(segs[1].fence.spec.context ?? "", /```diff/)
})

test("a fence QUOTED inside a longer outer fence is the worker documenting the grammar — prose, and it names nothing", () => {
  const quoted = `Here is the grammar:\n\n\`\`\`\`md\n${ASK}\n\`\`\`\`\n`
  assert.deepEqual(splitMessageQuestions(quoted, true), splitQuestionBlocks(quoted))
  assert.ok(splitMessageQuestions(quoted, true).every((s) => s.kind === "prose"))
  assert.deepEqual(questionFenceIdsIn(quoted), [])
})

test("an INVALID read keeps the rendering it had — a free-form fence in a post-cutover thread's history is unchanged", () => {
  const freeForm = "Lead.\n\n```question\nShould we ship?\n\n- A. Yes\n- B. No\n```\n"
  assert.deepEqual(splitMessageQuestions(freeForm, true), splitQuestionBlocks(freeForm))
  const segs = splitMessageQuestions(freeForm, true)
  assert.ok(segs.every((s) => s.kind !== "question" || s.fence === undefined))
})

test("the legacy empty marker still places by its minted id beside a fence in the same message", () => {
  const text = `${ASK}\n\nAnd the older one:\n\n\`\`\`question qst_ab12cd34\n\`\`\`\n`
  const qs = splitMessageQuestions(text, true).filter((s) => s.kind === "question")
  assert.equal(qs.length, 2)
  assert.ok(qs[0].kind === "question" && qs[0].fence?.form === "ask")
  assert.ok(qs[1].kind === "question" && qs[1].registeredId === "qst_ab12cd34" && qs[1].fence === undefined)
})

test("questionFenceIdsIn names asks and references, never a follow-up, in order", () => {
  assert.deepEqual(questionFenceIdsIn(`${ASK}\n\n${FOLLOW_UP}\n\n${REF("Older-Question")}`), ["settings-store", "older-question"])
  assert.deepEqual(questionFenceIdsIn("no fence"), [])
})

test("hasQuestionBlock counts a ````question fence, so a message that asks with one is never a bare rest", () => {
  const four = ["````question", "id: retry-backoff", "kind: text", "question: Which backoff?", "---", "```ts", "x()", "```", "````"].join("\n")
  assert.equal(hasQuestionBlock(four), true)
  assert.equal(hasQuestionBlock(`\`\`\`\`\`md\n${four}\n\`\`\`\`\``), false, "quoted, it asks nothing")
})

// A FOLLOW-UP WRITTEN IN A LATER MESSAGE than its parent (allowed while the parent is open, 2026-10-13):
// the server attaches it to the parent's row and counts the parent as referenced at that rest, so for the
// surface the follow-up's fence names its PARENT there — the slot the parent's card moves to.
test("a follow-up whose parent is not in its message claims the parent; one written with its parent claims nothing", () => {
  assert.deepEqual(followUpParentsIn(`Still open, and one more thing hangs on it:\n\n${FOLLOW_UP}`), ["settings-store"])
  assert.deepEqual(questionFenceIdsIn(`Later:\n\n${FOLLOW_UP}`), ["settings-store"], "the parent's id, never the follow-up's own")
  assert.equal(hasQuestionBlock(`Later:\n\n${FOLLOW_UP}`), true, "so the rest that writes it is not a bare rest")
  // Negative controls: the parent asked or referenced in the same message is what places the card.
  assert.deepEqual(followUpParentsIn(`${ASK}\n\n${FOLLOW_UP}`), [])
  assert.deepEqual(followUpParentsIn(`${REF("settings-store")}\n\n${FOLLOW_UP}`), [])
  assert.deepEqual(questionFenceIdsIn(`${REF("settings-store")}\n\n${FOLLOW_UP}`), ["settings-store"], "named once")
  // A branch of a branch, both written later: only the outermost parent is missing from the message.
  const grandchild = ["```question", "id: wal-mode", "kind: choice", "when: sqlite-path = Beside the sessions database", "question: WAL?", "options:", "  - Yes", "  - No", "```"].join("\n")
  assert.deepEqual(followUpParentsIn(`${FOLLOW_UP}\n\n${grandchild}`), ["settings-store"])
  // A sample quoted in an outer fence claims nothing.
  assert.deepEqual(followUpParentsIn(`\`\`\`\`md\n${FOLLOW_UP}\n\`\`\`\``), [])
})

// A fence that TRIED the grammar and did not read (the server registers nothing and corrects the worker)
// is the code block it is, under its faults — at three backticks too, where the legacy reader used to make
// it a "Question" card over the worker's YAML.
test("an invalid question fence stays in the prose as its own run; a free-form one keeps the legacy card", () => {
  const noKind = "```question\nid: no-kind\nquestion: Is this missing its kind?\noptions:\n  - yes\n  - no\n```"
  const segs = splitMessageQuestions(`Lead.\n\n${noKind}\n\n${ASK}\n\nTail.`, true)
  assert.deepEqual(segs.map((s) => s.kind), ["prose", "invalidFence", "question", "prose"])
  assert.equal(segs[1].kind === "invalidFence" && segs[1].text.trimEnd(), noKind, "the whole fence, delimiters included, for markdown to draw as code")
  assert.match(segs[1].kind === "invalidFence" ? segs[1].faults.join("\n") : "", /no `kind:`/, "…under the reason it is not a card")
  assert.ok(segs[2].kind === "question" && segs[2].fence?.form === "ask", "a valid fence beside it is still a card")
  // The same mistake with four backticks, an unknown key, and a bad id all agree.
  for (const bad of [noKind.replace(/```/g, "````"), "```question\nid: bad-key\nkind: text\ncolour: red\nquestion: Q?\n```", "```question\nid: Not A Slug\n```"]) {
    assert.deepEqual(splitMessageQuestions(bad, true).map((s) => s.kind), ["invalidFence"], bad)
  }
  // Negative controls: free-form prose in a fence is the legacy read-only card, as before; and on a
  // legacy thread nothing here applies at all.
  const freeForm = "```question\nShould I ship tonight?\n\nA. Yes\nB. No\n```"
  assert.deepEqual(splitMessageQuestions(freeForm, true), splitQuestionBlocks(freeForm))
  assert.equal(splitMessageQuestions(freeForm, true)[0].kind, "question")
  assert.deepEqual(splitMessageQuestions(noKind, false), splitQuestionBlocks(noKind))
})
