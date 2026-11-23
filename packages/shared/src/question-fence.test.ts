import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fencedInteriors, mayHoldQuestionFence, questionFenceOpener } from "./code-fences.ts"
import { AskedQuestionSchema, askedQuestionFaults } from "./index.ts"
import { assembleQuestionFences, questionFenceBlocks, questionFenceDraft, questionFencesIn, questionHandles, readQuestionFence } from "./question-fence.ts"

const fence = (body: string, ticks = "```") => `${ticks}question\n${body}\n${ticks}`

test("a choice question reads every field, and the body below --- is its context", () => {
  const r = readQuestionFence([
    "id: settings-store",
    "kind: choice",
    "question: Should the settings store use SQLite or a JSON file?",
    "options:",
    "  - label: SQLite",
    "    description: transactional, and one store to back up",
    "    recommended: true",
    "  - label: JSON file",
    "    description: no dependency, hand-editable",
    "---",
    "Settings are read on every request.",
    "",
    "| Store | Crash-safe |",
    "|---|---|",
    "| SQLite | yes |",
  ].join("\n"))
  assert.equal(r.form, "ask")
  if (r.form !== "ask") return
  assert.equal(r.id, "settings-store")
  assert.deepEqual(r.spec, {
    handle: "settings-store",
    question: "Should the settings store use SQLite or a JSON file?",
    context: "Settings are read on every request.\n\n| Store | Crash-safe |\n|---|---|\n| SQLite | yes |",
    kind: "question",
    options: [
      { label: "SQLite", description: "transactional, and one store to back up", recommended: true },
      { label: "JSON file", description: "no dependency, hand-editable" },
    ],
  })
})

test("values are prose read verbatim: colons, backticks and # survive, and a quoted value is unquoted", () => {
  const r = readQuestionFence([
    "id: npm-scope",
    "kind: choice",
    "question: Which scope: `@frizz` or `@frizzhq`? See #42",
    "options:",
    "  - label: `@frizzhq`",
    "    description: free today: claim it now # before someone else",
    '  - label: "Keep @frizz"',
  ].join("\n"))
  assert.equal(r.form, "ask")
  if (r.form !== "ask") return
  assert.equal(r.spec.question, "Which scope: `@frizz` or `@frizzhq`? See #42")
  assert.equal(r.spec.options?.[0].label, "`@frizzhq`")
  assert.equal(r.spec.options?.[0].description, "free today: claim it now # before someone else")
  assert.equal(r.spec.options?.[1].label, "Keep @frizz")
})

test("an option's detail block is kept as markdown, a nested code fence included, under a longer outer fence", () => {
  const text = fence([
    "id: retry-backoff",
    "kind: choice",
    "question: Which backoff should the flaky upload use?",
    "options:",
    "  - label: Exponential",
    "    description: doubles from 100ms, capped at five tries",
    "    recommended: true",
    "    detail: |",
    "      ```diff",
    "      -  await sleep(100)",
    "      +  await sleep(2 ** attempt * 100)",
    "      ```",
    "",
    "      Then a second paragraph.",
    "  - Keep the fixed sleep",
  ].join("\n"), "````")
  const blocks = questionFenceBlocks(text)
  assert.equal(blocks.length, 1)
  const r = blocks[0].read
  assert.equal(r.form, "ask")
  if (r.form !== "ask") return
  assert.equal(
    r.spec.options?.[0].description,
    "doubles from 100ms, capped at five tries\n\n```diff\n-  await sleep(100)\n+  await sleep(2 ** attempt * 100)\n```\n\nThen a second paragraph.",
  )
  // A BARE item is its label.
  assert.deepEqual(r.spec.options?.[1], { label: "Keep the fixed sleep" })
})

test("the four kinds map onto the stored shape, and each refuses the options it cannot take", () => {
  const multi = readQuestionFence("id: a\nkind: multi\nquestion: Which?\noptions:\n  - label: x\n    recommended: true\n  - label: y\n    recommended: true")
  assert.equal(multi.form === "ask" && multi.spec.kind, "multi")
  const text = readQuestionFence("id: b\nkind: text\nquestion: What scope?")
  assert.deepEqual(text.form === "ask" && text.spec, { handle: "b", question: "What scope?", kind: "question" })
  const secret = readQuestionFence("id: otp\nkind: secret\nquestion: The npm one-time code")
  assert.deepEqual(secret.form === "ask" && secret.spec, { handle: "otp", question: "The npm one-time code", kind: "question", secret: true })

  const textWithOptions = readQuestionFence("id: c\nkind: text\nquestion: Q?\noptions:\n  - x\n  - y")
  assert.equal(textWithOptions.form, "invalid")
  const choiceOfOne = readQuestionFence("id: d\nkind: choice\nquestion: Q?\noptions:\n  - only")
  assert.equal(choiceOfOne.form, "invalid")
  assert.match(choiceOfOne.form === "invalid" ? choiceOfOne.faults.join("\n") : "", /two or more options/)
  const twoRecommended = readQuestionFence("id: e\nkind: choice\nquestion: Q?\noptions:\n  - label: x\n    recommended: true\n  - label: y\n    recommended: true")
  assert.match(twoRecommended.form === "invalid" ? twoRecommended.faults.join("\n") : "", /only ONE option/)
})

test("an id alone is a reference, and the id is read lowercased", () => {
  assert.deepEqual(readQuestionFence("id: Settings-Store"), { form: "ref", id: "settings-store" })
  assert.deepEqual(readQuestionFence("id: qst_ab12cd34ef56"), { form: "ref", id: "qst_ab12cd34ef56" })
})

test("every mistake is refused by name", () => {
  const faultsOf = (body: string) => {
    const r = readQuestionFence(body)
    assert.equal(r.form, "invalid", body)
    return r.form === "invalid" ? r.faults.join("\n") : ""
  }
  assert.match(faultsOf("kind: text\nquestion: Q?"), /no `id:`/)
  assert.match(faultsOf("id: Has Spaces\nkind: text\nquestion: Q?"), /an id is a slug/)
  assert.match(faultsOf("id: x\nquestion: Q?"), /no `kind:`/)
  assert.match(faultsOf("id: x\nkind: pick\nquestion: Q?"), /`kind: pick` — the kinds are/)
  assert.match(faultsOf("id: x\nkind: text"), /no `question:`/)
  assert.match(faultsOf("id: x\nkind: text\nquestion: Q?\nrecomended: true"), /unknown key `recomended:`/)
  assert.match(faultsOf("id: x\nkind: choice\nquestion: Q?\noptions:\n  - label: a\n    recomended: true\n  - b"), /option 1: unknown key `recomended:`/)
  assert.match(faultsOf("id: x\nkind: text\nquestion: Q?\nSome context without a delimiter"), /context for the human goes below a `---` line/)
  assert.match(faultsOf("id: qst_mine\nkind: text\nquestion: Q?"), /reserved/)
  assert.match(faultsOf("id: x\nkind: choice\nquestion: Q?\noptions:\n  - same\n  - same"), /two options are labelled/)
  assert.match(faultsOf("id: x\nkind: secret\nquestion: Code?\nwhen: parent = Yes"), /cannot be a follow-up/)
  assert.match(faultsOf("id: x\nkind: text\nquestion: Q?\nwhen: parent"), /write the parent's id/)
  // A fault still names the id it could read, so a correction can point at the fence.
  const r = readQuestionFence("id: named\nkind: nope\nquestion: Q?")
  assert.equal(r.form === "invalid" && r.id, "named")
})

test("only an unquoted ```question opener is a fence — a sample wrapped in a longer fence is quoted, and a marker is legacy", () => {
  const quoted = "````md\n```question\nid: x\nkind: text\nquestion: Q?\n```\n````"
  assert.deepEqual(questionFenceBlocks(quoted), [])
  const marker = "```question qst_ab12cd34\n```"
  assert.deepEqual(questionFenceBlocks(marker), [])
  const unclosed = "```question\nid: x\nkind: text\nquestion: Q?"
  assert.deepEqual(questionFenceBlocks(unclosed), [])
  const two = `Intro.\n\n${fence("id: a\nkind: text\nquestion: A?")}\n\nBetween.\n\n${fence("id: b")}\n\nAfter.`
  const blocks = questionFenceBlocks(two)
  assert.deepEqual(blocks.map((b) => b.read.form), ["ask", "ref"])
  assert.equal(two.slice(blocks[0].start, blocks[0].end).trimEnd(), fence("id: a\nkind: text\nquestion: A?"))
  assert.equal(two.slice(blocks[1].end), "\nAfter.")
})

test("a follow-up attaches to its parent's option in the same message, and the whole tree registers as one root", () => {
  const text = [
    fence("id: settings-store\nkind: choice\nquestion: SQLite or JSON?\noptions:\n  - SQLite\n  - JSON file"),
    fence("id: sqlite-path\nkind: choice\nwhen: settings-store = sqlite\nquestion: Where should it live?\noptions:\n  - Beside the sessions database\n  - In the project's `.frizz/`"),
  ].join("\n\n")
  const out = questionFencesIn(text)
  assert.deepEqual(out.faults, [])
  assert.deepEqual(out.asks.map((a) => a.id), ["settings-store"])
  const root = out.asks[0].spec
  assert.equal(root.options?.[0].followUps?.[0].handle, "sqlite-path")
  assert.deepEqual(questionHandles(root), ["settings-store", "sqlite-path"])
})

test("a follow-up whose option is missing is refused with its parent's real labels, and never takes its parent down with it", () => {
  const parent = fence("id: p\nkind: choice\nquestion: P?\noptions:\n  - Yes\n  - No")
  const wrongOption = questionFencesIn(`${parent}\n${fence("id: c\nkind: text\nwhen: p = Maybe\nquestion: C?")}`)
  assert.deepEqual(wrongOption.asks.map((a) => a.id), ["p"])
  // The labels are what lets the worker FIX the line rather than guess at it (the dead end found
  // 2026-10-13: `when: prefs-store = SQLite` against an option labelled `SQLite (better-sqlite3)`).
  assert.deepEqual(wrongOption.faults, [{ id: "c", faults: ["`when:` names the option `Maybe`, and `p` has only `Yes`, `No` — write the label exactly as the option has it"] }])
  const underMulti = questionFencesIn(`${fence("id: m\nkind: multi\nquestion: M?\noptions:\n  - a\n  - b")}\n${fence("id: c\nkind: text\nwhen: m = a\nquestion: C?")}`)
  assert.match(underMulti.faults[0].faults[0], /a multi's options cannot open follow-ups/)
  const underText = questionFencesIn(`${fence("id: t\nkind: text\nquestion: T?")}\n${fence("id: c\nkind: text\nwhen: t = anything\nquestion: C?")}`)
  assert.deepEqual(underText.asks.map((a) => a.id), ["t"])
  assert.match(underText.faults[0].faults[0], /`t` is a free-text question with no options to follow — ask this as its own question, without the `when:` line/)
})

test("a fence that does not read still drafts its question for the page, and one that reads drafts nothing", () => {
  // Two recommended options: refused, and the draft keeps both options and the context.
  const body = "id: e\nkind: choice\nquestion: Q?\noptions:\n  - label: x\n    recommended: true\n  - label: y\n    recommended: true\n---\nWhy it matters."
  assert.equal(readQuestionFence(body).form, "invalid")
  assert.deepEqual(questionFenceDraft(body), {
    handle: "e", question: "Q?", context: "Why it matters.", kind: "question",
    options: [{ label: "x", recommended: true }, { label: "y", recommended: true }],
  })
  // The read itself is unchanged by the draft: the server registers from it, and nothing else.
  assert.deepEqual(Object.keys(readQuestionFence(body)).sort(), ["faults", "form", "id"])
  assert.equal(questionFenceDraft("id: ok\nkind: text\nquestion: Fine?"), undefined, "a fence that reads is its own ask")
  assert.equal(questionFenceDraft("id: ref"), undefined, "a reference asks nothing")
  assert.equal(questionFenceDraft("---\nid: x\nkind: text\nquestion: Q?\n---"), undefined, "front matter wrapped in `---` has no question line")
})

test("labels that differ only in case are two options, and a `when:` names one of them exactly", () => {
  // Refused as duplicates until 2026-11-04: a choice between spellings is a real question.
  const body = 'id: key\nkind: choice\nquestion: Spell it?\noptions:\n  - label: "set: Array"\n  - label: "set: array"'
  assert.equal(readQuestionFence(body).form, "ask")
  const spellings = fence(body)
  const exact = questionFencesIn(`${spellings}\n${fence("id: why\nkind: text\nwhen: key = set: array\nquestion: Why lowercase?")}`)
  assert.deepEqual(exact.faults, [])
  assert.equal(exact.asks[0].spec.options?.[1].followUps?.[0].handle, "why")
  assert.equal(exact.asks[0].spec.options?.[0].followUps, undefined)
  // Folded, it names neither — the fault lists both, so the worker picks.
  const folded = questionFencesIn(`${spellings}\n${fence("id: why\nkind: text\nwhen: key = SET: ARRAY\nquestion: Why?")}`)
  assert.match(folded.faults[0].faults[0], /has only `set: Array`, `set: array`/)
  // With one label of that spelling, case still does not matter.
  const one = questionFencesIn(`${fence("id: p\nkind: choice\nquestion: P?\noptions:\n  - Yes\n  - No")}\n${fence("id: c\nkind: text\nwhen: p = yes\nquestion: C?")}`)
  assert.deepEqual(one.faults, [])
})

test("a follow-up whose parent is not asked in its message is handed over unattached, for the server to place", () => {
  // Not a fault here: the parent may be a question the thread already has open, and only the server has
  // the rows. A follow-up of the follow-up, written beside it, rides inside it.
  const late = fence("id: c\nkind: choice\nwhen: elsewhere = Yes\nquestion: C?\noptions:\n  - One\n  - Two")
  const under = fence("id: d\nkind: text\nwhen: c = two\nquestion: D?")
  const out = questionFencesIn(`${fence("id: elsewhere")}\n${late}\n${under}`)
  assert.deepEqual(out.faults, [])
  assert.deepEqual(out.asks, [])
  assert.deepEqual(out.refs, ["elsewhere"])
  assert.deepEqual(out.followUps.map((f) => [f.id, f.parent, f.option]), [["c", "elsewhere", "Yes"]])
  assert.deepEqual(questionHandles(out.followUps[0].spec), ["c", "d"])
  assert.equal(out.followUps[0].spec.options?.[1].followUps?.[0].question, "D?")
})

test("a fence under a refused fence is named too, and a `when:` that circles back reaches nothing", () => {
  const parent = fence("id: p\nkind: choice\nquestion: P?\noptions:\n  - Yes\n  - No")
  const child = fence("id: c\nkind: choice\nwhen: p = Maybe\nquestion: C?\noptions:\n  - One\n  - Two")
  const grandchild = fence("id: g\nkind: text\nwhen: c = One\nquestion: G?")
  const out = questionFencesIn([parent, child, grandchild].join("\n\n"))
  assert.deepEqual(out.asks.map((a) => questionHandles(a.spec)), [["p"]])
  assert.deepEqual(out.faults.map((f) => f.id), ["c", "g"], "the grandchild is not simply missing from the correction")
  assert.equal(out.faults[1].faults[0], "`when: c = One` hangs this question off `c`, which could not register — it goes with it, so write both again")
  const loop = questionFencesIn([
    fence("id: a\nkind: choice\nwhen: b = x\nquestion: A?\noptions:\n  - x\n  - y"),
    fence("id: b\nkind: choice\nwhen: a = x\nquestion: B?\noptions:\n  - x\n  - y"),
    fence("id: self\nkind: choice\nwhen: self = x\nquestion: S?\noptions:\n  - x\n  - y"),
  ].join("\n\n"))
  assert.deepEqual([loop.asks, loop.followUps], [[], []])
  assert.deepEqual(loop.faults.map((f) => f.id), ["a", "b", "self"])
  assert.match(loop.faults[0].faults[0], /is part of a loop of follow-ups \(`a` → `b` → `a`\) — one of them has to be a question with no `when:`/)
  assert.match(loop.faults[2].faults[0], /makes this question a follow-up of itself/)
})

test("the same fence twice in one message is one ask; two different fences on one id are a collision", () => {
  const a = fence("id: x\nkind: text\nquestion: Q?")
  assert.equal(questionFencesIn(`${a}\n${a}`).asks.length, 1)
  const out = questionFencesIn(`${a}\n${fence("id: x\nkind: text\nquestion: Different?")}`)
  assert.match(out.faults[0].faults[0], /two different questions in this message use `id: x`/)
})

test("a fourth level is refused on the fence that goes too deep — the three sound levels above it still register", () => {
  const out = assembleQuestionFences([
    { form: "ask", id: "a", spec: { handle: "a", question: "A?", kind: "question", options: [{ label: "go" }, { label: "no" }] } },
    { form: "ask", id: "b", spec: { handle: "b", question: "B?", kind: "question", options: [{ label: "go" }, { label: "no" }] }, when: { parent: "a", option: "go" } },
    { form: "ask", id: "c", spec: { handle: "c", question: "C?", kind: "question", options: [{ label: "go" }, { label: "no" }] }, when: { parent: "b", option: "go" } },
    { form: "ask", id: "d", spec: { handle: "d", question: "D?", kind: "question" }, when: { parent: "c", option: "go" } },
  ])
  // Refusing the whole tree here (as the shared validator would) took a sound question down with its
  // fourth level — and a follow-up never takes its parent down.
  assert.deepEqual(out.asks.map((a) => questionHandles(a.spec)), [["a", "b", "c"]])
  assert.deepEqual(out.faults.map((f) => f.id), ["d"])
  assert.equal(out.faults[0].faults[0], "`when: c = go` puts this question 4 levels deep, and follow-ups go 3 levels deep at most — past that you are asking the human to fill in a form; ask it as its own question, without the `when:` line, or decide it yourself")
})

// ── Adversarial review, 2026-10-13 ─────────────────────────────────────────────────────────────────────

const faultsIn = (text: string) => questionFencesIn(text).faults.flatMap((f) => f.faults).join("\n")

test("an indented fence gives its indent back to every body line, as CommonMark does — so a fence inside a list item reads", () => {
  const body = "id: x\nkind: choice\nquestion: Q?\noptions:\n  - label: A\n    detail: |\n      one\n  - B\n---\nContext."
  for (const pad of [" ", "  ", "   "]) {
    const text = fence(body).split("\n").map((l) => pad + l).join("\n")
    const blocks = questionFenceBlocks(text)
    assert.equal(blocks.length, 1, JSON.stringify(pad))
    assert.deepEqual(blocks[0].read, readQuestionFence(body), JSON.stringify(pad))
    assert.equal(blocks[0].read.form, "ask")
  }
  // The shape it is actually written in: under a numbered step, at the list's content column.
  const inList = `1. First.\n2. Then decide:\n\n   ${fence("id: step\nkind: text\nquestion: Which port?").split("\n").join("\n   ")}\n3. Last.`
  assert.deepEqual(questionFencesIn(inList).asks.map((a) => a.id), ["step"])
  assert.deepEqual(questionFencesIn(inList).faults, [])
  // A flush body under an indented opener still reads (only UP TO the opener's indent is taken), and four
  // spaces is an indented code block, not a fence.
  assert.equal(questionFenceBlocks("  ```question\nid: x\nkind: text\nquestion: Q?\n  ```")[0].read.form, "ask")
  assert.deepEqual(questionFenceBlocks(fence("id: x").split("\n").map((l) => `    ${l}`).join("\n")), [])
  // What the server keeps of a message is each block's own source, re-read later: that must read the same.
  const kept = questionFenceBlocks(inList).map((b) => inList.slice(b.start, b.end).trimEnd()).join("\n\n")
  assert.deepEqual(questionFenceBlocks(kept).map((b) => b.read), questionFenceBlocks(inList).map((b) => b.read))
})

test("a follow-up that can never hang off a registered question is refused by name, never dropped in silence", () => {
  const q = (id: string, when?: string) => fence(`id: ${id}\nkind: choice\n${when ? `when: ${when}\n` : ""}question: ${id}?\noptions:\n  - X\n  - Y`)
  // Its own follow-up.
  const self = questionFencesIn(q("a", "a = X"))
  assert.deepEqual(self.asks, [])
  assert.deepEqual(self.faults.map((f) => f.id), ["a"])
  assert.match(self.faults[0].faults[0], /follow-up of itself/)
  // Two follow-ups of each other.
  const loop = questionFencesIn(`${q("a", "b = X")}\n${q("b", "a = X")}`)
  assert.deepEqual(loop.asks, [])
  assert.deepEqual(loop.faults.map((f) => f.id).sort(), ["a", "b"])
  assert.match(faultsIn(`${q("a", "b = X")}\n${q("b", "a = X")}`), /loop/)
  // A loop beside a sound question: the sound one still registers.
  const beside = questionFencesIn(`${q("root")}\n${q("a", "b = X")}\n${q("b", "a = X")}`)
  assert.deepEqual(beside.asks.map((a) => a.id), ["root"])
  assert.equal(beside.faults.length, 2)
  // The child of a follow-up that failed goes with it, and is told so.
  const orphaned = questionFencesIn(`${q("root")}\n${q("a", "root = Nope")}\n${q("b", "a = X")}`)
  assert.deepEqual(orphaned.asks.map((a) => a.id), ["root"])
  assert.deepEqual(orphaned.faults.map((f) => f.id), ["a", "b"])
  assert.match(orphaned.faults[1].faults[0], /`a`, which could not register/)
  // Negative control: a sound three-level tree faults nothing.
  const sound = questionFencesIn(`${q("root")}\n${q("a", "root = X")}\n${q("b", "a = X")}`)
  assert.deepEqual(sound.faults, [])
  assert.deepEqual(questionHandles(sound.asks[0].spec), ["root", "a", "b"])
})

test("the same id under two different parents is a collision, not a restatement", () => {
  const parent = fence("id: p\nkind: choice\nquestion: P?\noptions:\n  - X\n  - Y")
  const child = (option: string) => fence(`id: c\nkind: text\nwhen: p = ${option}\nquestion: C?`)
  const out = questionFencesIn(`${parent}\n${child("X")}\n${child("Y")}`)
  assert.match(out.faults.flatMap((f) => f.faults).join("\n"), /two different questions in this message use `id: c`/)
  // Negative control: the same follow-up written twice is still one.
  assert.deepEqual(questionFencesIn(`${parent}\n${child("X")}\n${child("X")}`).faults, [])
})

// ── A code block inside the fence ──────────────────────────────────────────────────────────────────────
//
// The models lane's real replies (fixtures/question-fence): Haiku wrote the outer fence too short in 4 of 6
// runs, whatever the contract said. So a nested block that opens with an info string is stepped over
// (code-fences.ts questionFenceClose), and what cannot be read whole is refused by name.

const fixture = (name: string) => readFileSync(new URL(`./fixtures/question-fence/${name}.md`, import.meta.url), "utf8")

test("a code block with an info string inside a question fence is part of the question, whatever the two fences' lengths", () => {
  const sql = "ALTER TABLE orders ADD COLUMN archived_at timestamptz;"
  const ask = (outer: string, inner: string) => `${outer}question\nid: x\nkind: text\nquestion: Q?\n---\nRun this:\n\n${inner}sql\n${sql}\n${inner}\n\nand tell me.\n${outer}`
  for (const [outer, inner] of [["```", "```"], ["```", "````"], ["````", "```"], ["````", "````"], ["```", "~~~"], ["```", "`````"]]) {
    const out = questionFencesIn(`Lead.\n\n${ask(outer, inner)}\n\nAfter.`)
    assert.deepEqual(out.faults, [], `${outer} outside, ${inner} inside`)
    assert.equal(out.asks[0]?.spec.context, `Run this:\n\n${inner}sql\n${sql}\n${inner}\n\nand tell me.`, `${outer} outside, ${inner} inside`)
  }
  // Two blocks in one context, and one in an option's detail at an indent a fence line still counts at.
  const two = questionFencesIn("```question\nid: x\nkind: text\nquestion: Q?\n---\n```sql\nUP\n```\n\nRollback:\n\n```sql\nDOWN\n```\n```")
  assert.equal(two.asks[0]?.spec.context, "```sql\nUP\n```\n\nRollback:\n\n```sql\nDOWN\n```")
  const inDetail = questionFencesIn("```question\nid: y\nkind: choice\nquestion: Q?\noptions:\n- label: A\n  detail: |\n   ```diff\n   -a\n   ```\n- B\n```")
  assert.deepEqual(inDetail.faults, [])
  assert.deepEqual(inDetail.asks[0]?.spec.options, [{ label: "A", description: "```diff\n-a\n```" }, { label: "B" }])
  // The offsets take the whole fence, so what is left of the message is only what was written around it.
  const text = `Lead.\n\n${ask("```", "```")}\n\nAfter.`
  const [block] = questionFenceBlocks(text)
  assert.equal(text.slice(0, block.start) + text.slice(block.end), "Lead.\n\n\nAfter.")
})

test("what stays CommonMark: a bare inner fence closes the question, and a detail four spaces in is not a fence line", () => {
  // No info string: nothing tells this opener from the question's own closer, so it is the closer — the
  // reading every markdown renderer gives it, and the one that was here before.
  const bare = "```question\nid: x\nkind: text\nquestion: Q?\n---\nRun this:\n```\nls\n```\nand tell me.\n```"
  const blocks = questionFenceBlocks(bare)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].read.form === "ask" && blocks[0].read.spec.context, "Run this:")
  assert.equal(bare.slice(blocks[0].end), "ls\n```\nand tell me.\n```")
  // The taught shape: a detail's code block sits six spaces in, where no line is a fence line at all.
  const taught = questionFencesIn("```question\nid: y\nkind: choice\nquestion: Q?\noptions:\n  - label: A\n    detail: |\n      ```diff\n      -a\n      ```\n  - B\n```")
  assert.deepEqual(taught.faults, [])
  assert.equal(taught.asks[0]?.spec.options?.[0].description, "```diff\n-a\n```")
})

test("a fence whose only closing line closes a code block inside it is refused, with the fix spelled out", () => {
  const FIX = /the `question` lines take four backticks \(````question to open, ```` to close\); the code block inside keeps three$/
  // The inner block is closed and the question never is: under the nested reading nothing closes the
  // fence, and under CommonMark's the SQL's closer does — with the context stopped inside the block.
  const cut = "Lead.\n\n```question\nid: x\nkind: text\nquestion: Q?\n---\nRun this:\n\n````sql\nSELECT 1\n````\n\nNotes the worker meant for the card."
  const out = questionFencesIn(cut)
  assert.deepEqual(out.asks, [])
  assert.deepEqual(out.faults.map((f) => f.id), ["x"])
  assert.match(out.faults[0].faults.join("\n"), /^the body below `---` ends inside an unclosed ```` code block: the fence is cut off there/)
  assert.match(out.faults[0].faults.join("\n"), FIX)
  // The same inside an option's detail.
  const inDetail = questionFencesIn("```question\nid: y\nkind: choice\nquestion: Q?\noptions:\n- label: A\n  detail: |\n   ```diff\n   -a\n   ```\n- B")
  assert.match(inDetail.faults[0].faults.join("\n"), /option 1: its detail ends inside an unclosed ``` code block/)
  // A block that sits where no value reaches still cannot register.
  const stray = questionFenceBlocks("```question\nid: z\n```sql\nSELECT 1\n```")
  assert.equal(stray[0].read.form, "invalid")
  // A ~~~ block cannot close a backtick fence, so one left open is only an unclosed block.
  assert.match(faultsIn("```question\nid: x\nkind: text\nquestion: Q?\n---\n~~~sql\nSELECT 1\n```"), /ends inside a ~~~ code block that is never closed — close it with ~~~/)
})

test("a fence with no closing line under either reading is ignored: a turn interrupted mid-fence earns no correction", () => {
  for (const tail of [
    "```question\nid: x\nkind: text\nquestion: Q?",
    "```question\nid: x\nkind: text\nquestion: Q?\n---\nRun this:\n\n```sql\nSELECT",
    "````question\nid: x\nkind: text\nquestion: Q?\n---\n```sql\nSELECT 1\n```\nstill writing",
  ]) {
    assert.deepEqual(questionFenceBlocks(`Lead.\n\n${tail}`), [], tail)
    assert.deepEqual(questionFencesIn(`Lead.\n\n${tail}`), { asks: [], followUps: [], refs: [], faults: [] }, tail)
  }
})

test("the models lane's replies, verbatim", () => {
  // Three backticks outside, three on two inner sql blocks.
  const v1 = questionFencesIn(fixture("haiku-three-outside-three-inside"))
  assert.deepEqual(v1.faults, [])
  assert.deepEqual(v1.asks.map((a) => a.id), ["orders-archived-at-prod"])
  assert.match(v1.asks[0].spec.context ?? "", /^```sql\n-- Migration: add nullable archived_at to orders\./)
  assert.match(v1.asks[0].spec.context ?? "", /Rollback, if needed:\n\n```sql\nDROP INDEX CONCURRENTLY IF EXISTS orders_archived_at_idx;\nALTER TABLE orders DROP COLUMN IF EXISTS archived_at;\n```$/)
  // Three outside, FOUR on the inner block.
  const v2b = questionFencesIn(fixture("haiku-three-outside-four-inside"))
  assert.deepEqual(v2b.faults, [])
  assert.deepEqual(v2b.asks.map((a) => a.id), ["orders-archived-at-migration"])
  assert.match(v2b.asks[0].spec.context ?? "", /^The SQL, to run outside a transaction:\n\n````sql\n-- up\n/)
  assert.match(v2b.asks[0].spec.context ?? "", /I will write the migration file in the matching format for your tool and report the result\.$/)
  // Three outside, four inside, and the question itself never closed: refused by name, not dropped.
  const v3 = questionFencesIn(fixture("haiku-four-inside-never-closed"))
  assert.deepEqual(v3.asks, [])
  assert.deepEqual(v3.faults.map((f) => f.id), ["approve-archived-at-migration"])
  assert.match(v3.faults[0].faults.join("\n"), /ends inside an unclosed ```` code block.*the `question` lines take four backticks/s)
  // Opened with three, closed with four, the SQL written after it: a whole question with no context.
  const v0 = questionFencesIn(fixture("haiku-three-open-four-close"))
  assert.deepEqual(v0.faults, [])
  assert.deepEqual(v0.asks.map((a) => a.id), ["approve-orders-archived-at-migration"])
  assert.equal(v0.asks[0].spec.context, undefined)
  // The probe: the first fence holds a sql block, and the second used to be swallowed as quoted code.
  const probe = questionFencesIn(fixture("probe-two-questions-code-in-context"))
  assert.deepEqual(probe.faults, [])
  assert.deepEqual(probe.asks.map((a) => a.id), ["orders-archived-at", "orders-backfill"])
  assert.match(probe.asks[0].spec.context ?? "", /^The exact statements:\n\n```sql\n[^]*```\n\nBoth are safe to re-run after a failure\.$/)
})

// ── The shared scanner every other reader is built on ──────────────────────────────────────────────────

/** `fencedInteriors` as it was before a question fence learned to nest — CommonMark to the letter. */
function commonMarkInteriors(text: string): [number, number][] {
  const out: [number, number][] = []
  let offset = 0
  let open: { char: string; len: number; from: number } | null = null
  for (const line of text.split("\n")) {
    const next = offset + line.length + 1
    const m = line.replace(/\r$/, "").match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (open) {
      if (m && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === "") {
        out.push([open.from, offset])
        open = null
      }
    } else if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      open = { char: m[1][0], len: m[1].length, from: Math.min(next, text.length) }
    }
    offset = next
  }
  if (open) out.push([open.from, text.length])
  return out
}

test("only a question fence nests: every other fence, and a legacy question marker, scans exactly as before", () => {
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = <T,>(from: readonly T[]): T => from[Math.floor(rnd() * from.length)]
  // Fence soup: every opener and closer shape, at every indent, with every info string EXCEPT a bare
  // `question` in any of its spellings — including the legacy forms that carry tokens after it, on
  // backticks, on tildes and capitalised, and the two forms a worker quotes a sample in.
  const lines = ["```", "````", "~~~", "~~~~", "```sql", "````md", "~~~ts", "```done", "```awaiting", "```question qst_ab12cd34ef56", "```question multi", "```question danger", "```questions", "```Question multi", "~~~question qst_ab12cd34ef56", "~~~questions", "```a question", "``` `x`", "prose", "", "id: x", "    ```", "   ```js", "> ```sql", "> ~~~question", "    ~~~question", "    ```Question", "- item"]
  let differing = 0
  for (let n = 0; n < 3000; n++) {
    const text = Array.from({ length: 1 + Math.floor(rnd() * 14) }, () => pick(lines)).join(pick(["\n", "\n", "\r\n"]))
    try {
      assert.deepEqual(fencedInteriors(text), commonMarkInteriors(text))
    } catch (err) {
      differing++
      if (differing === 1) throw new Error(`${JSON.stringify(text)}\n${String(err)}`)
    }
  }
  // The control: with a bare ```question in the soup the two readings DO part ways, so the comparison bites.
  const nested = "```question\nid: x\n---\n```sql\nSELECT 1\n```\nmore\n```\n\n```done\n```"
  assert.notDeepEqual(fencedInteriors(nested), commonMarkInteriors(nested))
  assert.deepEqual(fencedInteriors(nested).map(([from, to]) => nested.slice(from, to)), ["id: x\n---\n```sql\nSELECT 1\n```\nmore\n", ""])
  // …and in every spelling the reader takes for the opener, each closed by its own character.
  for (const [open, close] of [["```Question", "```"], ["```QUESTION", "```"], ["``` question", "```"], ["~~~question", "~~~"], ["~~~Question", "~~~"]]) {
    const text = `${open}\nid: x\n---\n\`\`\`sql\nSELECT 1\n\`\`\`\nmore\n~~~ts\nlet a\n~~~\nlast\n${close}\n\n\`\`\`done\n\`\`\``
    assert.notDeepEqual(fencedInteriors(text), commonMarkInteriors(text), open)
    assert.deepEqual(fencedInteriors(text).map(([from, to]) => text.slice(from, to)), ["id: x\n---\n```sql\nSELECT 1\n```\nmore\n~~~ts\nlet a\n~~~\nlast\n", ""], open)
  }
})

test("a question fence quoted inside a longer fence is still prose, nested block and all", () => {
  const sample = "```question\nid: x\nkind: text\nquestion: Q?\n---\n```sql\nSELECT 1\n```\n```"
  for (const [open, close] of [["````md", "````"], ["`````", "`````"], ["~~~", "~~~"]]) {
    const text = `Here is the grammar:\n\n${open}\n${sample}\n${close}\n\nThat is all.`
    assert.deepEqual(questionFenceBlocks(text), [], open)
    assert.deepEqual(fencedInteriors(text), commonMarkInteriors(text), open)
    assert.equal(fencedInteriors(text).length, 1, open)
  }
  // …and the same sample unquoted is one question, so the test above is not passing on a broken sample.
  assert.deepEqual(questionFencesIn(sample).asks.map((a) => a.id), ["x"])
})

test("an option's keys are read as keys wherever they sit — never folded into the label above them", () => {
  const head = "id: x\nkind: choice\nquestion: Q?\noptions:\n"
  const optionsOf = (body: string) => {
    const r = readQuestionFence(head + body)
    assert.equal(r.form, "ask", JSON.stringify(r))
    return r.form === "ask" ? r.spec.options : undefined
  }
  // A bare label, then its keys.
  assert.deepEqual(optionsOf("  - SQLite\n    description: one store to back up\n    recommended: true\n  - JSON file"), [
    { label: "SQLite", description: "one store to back up", recommended: true },
    { label: "JSON file" },
  ])
  // A wide gap after the dash puts the first key further right than the ones under it.
  assert.deepEqual(optionsOf("  -   label: A\n      description: d\n  - B"), [{ label: "A", description: "d" }, { label: "B" }])
  assert.deepEqual(optionsOf("  -   label: A\n    description: d\n    detail: |\n      body\n  - B"), [{ label: "A", description: "d\n\nbody" }, { label: "B" }])
  // A bare label that wraps still joins its continuation.
  assert.deepEqual(optionsOf("  - Keep the fixed sleep\n    and add a sixth try\n  - B"), [{ label: "Keep the fixed sleep and add a sixth try" }, { label: "B" }])
  // An item nested under a bare label is a mistake with a name, not a longer label.
  const nested = readQuestionFence(`${head}  - A\n    - B\n  - C`)
  assert.equal(nested.form, "invalid")
  assert.match(nested.form === "invalid" ? nested.faults.join("\n") : "", /`- B` is indented differently from the options above it/)
})

test("a one-line value is one line however it was written, and a line separator inside a value does not hide its key", () => {
  const escaped = readQuestionFence('id: x\nkind: text\nquestion: "First line\\nsecond line"')
  assert.equal(escaped.form === "ask" && escaped.spec.question, "First line second line")
  const separated = readQuestionFence("id: x\nkind: text\nquestion: Before after")
  assert.equal(separated.form === "ask" && separated.spec.question, "Before after")
})

test("front matter wrapped in a leading --- is refused for that, not for a missing id", () => {
  const r = readQuestionFence("---\nid: x\nkind: text\nquestion: Q?\n---\nContext.")
  assert.equal(r.form, "invalid")
  assert.match(r.form === "invalid" ? r.faults[0] : "", /opens with `---`/)
  assert.doesNotMatch(r.form === "invalid" ? r.faults.join("\n") : "", /no `id:`/)
})

// THE FENCE NEVER HANDS THE REGISTRAR A SPEC THE STORED SCHEMA REFUSES. The registrar inserts what the parser
// produced, with no schema pass of its own, and every reader parses the row back through
// AskedQuestionSchema — so a value the parser accepts past a schema cap would register and then fail to
// read, rather than come back to the worker as a named fault.
test("every cap the stored schema holds is refused by the fence first, by name, at exactly the same length", () => {
  const head = "id: x\nkind: choice\nquestion: Q?\noptions:\n"
  const caps: { name: string; max: number; body: (n: number) => string; fault: RegExp; over: (n: number) => object }[] = [
    { name: "question", max: 4000, body: (n) => `id: x\nkind: text\nquestion: ${"q".repeat(n)}`, fault: /`question:` is 4001 characters/, over: (n) => ({ question: "q".repeat(n), kind: "question" }) },
    { name: "context", max: 20000, body: (n) => `id: x\nkind: text\nquestion: Q?\n---\n${"c".repeat(n)}`, fault: /below `---` is 20001 characters/, over: (n) => ({ question: "Q?", kind: "question", context: "c".repeat(n) }) },
    { name: "header", max: 24, body: (n) => `id: x\nkind: text\nquestion: Q?\nheader: ${"h".repeat(n)}`, fault: /is 25 characters; a header/, over: (n) => ({ question: "Q?", kind: "question", header: "h".repeat(n) }) },
    { name: "label", max: 400, body: (n) => `${head}  - ${"l".repeat(n)}\n  - B`, fault: /option 1: the label is 401 characters/, over: (n) => ({ question: "Q?", kind: "question", options: [{ label: "l".repeat(n) }, { label: "B" }] }) },
    { name: "description", max: 20000, body: (n) => `${head}  - label: A\n    description: ${"d".repeat(n)}\n  - B`, fault: /option 1: the description and detail run 20001/, over: (n) => ({ question: "Q?", kind: "question", options: [{ label: "A", description: "d".repeat(n) }, { label: "B" }] }) },
    // A description and a detail share the one stored field, joined by a blank line (two characters).
    { name: "description + detail", max: 20000, body: (n) => `${head}  - label: A\n    description: ${"d".repeat(10)}\n    detail: |\n      ${"e".repeat(n - 12)}\n  - B`, fault: /option 1: the description and detail run 20001/, over: (n) => ({ question: "Q?", kind: "question", options: [{ label: "A", description: "d".repeat(n) }, { label: "B" }] }) },
    { name: "id", max: 64, body: (n) => `id: ${"i".repeat(n)}\nkind: text\nquestion: Q?`, fault: /an id is a slug/, over: (n) => ({ handle: "i".repeat(n), question: "Q?", kind: "question" }) },
  ]
  for (const cap of caps) {
    const at = readQuestionFence(cap.body(cap.max))
    assert.equal(at.form, "ask", `${cap.name} at ${cap.max}`)
    assert.equal(at.form === "ask" && AskedQuestionSchema.safeParse(at.spec).success, true, `${cap.name} at ${cap.max} passes the schema`)
    const over = readQuestionFence(cap.body(cap.max + 1))
    assert.equal(over.form, "invalid", `${cap.name} at ${cap.max + 1}`)
    assert.match(over.form === "invalid" ? over.faults.join("\n") : "", cap.fault, cap.name)
    // The control: the schema really does refuse one past the cap, so "passes the schema" above can fail.
    assert.equal(AskedQuestionSchema.safeParse(cap.over(cap.max + 1)).success, false, `the schema refuses ${cap.name} at ${cap.max + 1}`)
  }
})

test("whatever the fence reads as an ask, the stored schema and the tree validator accept — over generated fences", () => {
  let seed = 20261013
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = <T,>(from: readonly T[]): T => from[Math.floor(rnd() * from.length)]
  // Prose built to sit ON the caps, from the characters that have each broken a reader somewhere: a
  // two-unit emoji, the whitespace `trim` does and does not take, both quotes, and the YAML specials.
  // (A short random run, repeated: the caps are 20,000 long and the edges are what is being tested.)
  const fill = (n: number) => {
    let run = ""
    for (let k = 0; k < 24; k++) run += pick(["a", " ", "🚀", "é", "\u00a0", "\u200b", ":", "#", "`", "'", '"', "=", "\\", "\t"])
    return run.repeat(Math.ceil(n / run.length) + 1).slice(0, n)
  }
  const value = (max: number) => {
    const text = fill(pick([0, 1, max - 1, max, max + 1, max + 2]))
    const shape = rnd()
    return shape < 0.2 ? JSON.stringify(text) : shape < 0.3 ? `'${text.replace(/'/g, "''")}'` : shape < 0.4 ? `  ${text}  ` : text
  }
  let asks = 0
  let refused = 0
  for (let n = 0; n < 1500; n++) {
    const kind = pick(["choice", "choice", "multi", "text", "secret"])
    const lines = [`id: ${pick(["a", "b".repeat(64), "c.d_e-f", "Mixed-Case"])}`, `kind: ${kind}`, `question: ${value(4000)}`]
    if (rnd() < 0.5) lines.push(`header: ${value(24)}`)
    if (rnd() < 0.3) lines.push(`danger: ${pick(["true", "yes", "True", "false", "no"])}`)
    if (kind === "choice" || kind === "multi") {
      lines.push("options:")
      for (let k = 0, count = 2 + Math.floor(rnd() * 3); k < count; k++) {
        lines.push(`  - label: ${k}${value(400)}`)
        if (rnd() < 0.5) lines.push(`    description: ${value(20000)}`)
        if (rnd() < 0.3) lines.push("    detail: |", `      ${fill(pick([1, 19990, 20000, 20001]))}`)
        if (rnd() < 0.2 && k === 0) lines.push("    recommended: true")
      }
    }
    if (rnd() < 0.5) lines.push("---", fill(pick([0, 1, 19999, 20000, 20001])))
    const out = questionFencesIn(fence(lines.join("\n"), "````"))
    refused += out.faults.length
    for (const ask of out.asks) {
      asks++
      const parsed = AskedQuestionSchema.safeParse(ask.spec)
      assert.equal(parsed.success, true, `${JSON.stringify(parsed.error?.issues)} — ${lines.join("\n").slice(0, 300)}`)
      assert.deepEqual(askedQuestionFaults(ask.spec), [])
      // …and unchanged by it: the schema trims, so a spec it would alter is one the registrar stores differently
      // from what every reader then sees.
      assert.deepEqual(parsed.data, ask.spec)
    }
  }
  // Both outcomes were exercised — a generator that only ever produced refusals would prove nothing.
  assert.ok(asks > 200 && refused > 200, `asks ${asks}, refused ${refused}`)
})

test("a follow-up chain of any length is refused past its third level — the reader never runs out of stack on it", () => {
  // The registrar calls this from the tailer's change hook; the tree validator recurses, and a chain some
  // 3,000 fences long (about 250KB of message) overflowed it. The chain is now measured by counting, three
  // steps at most per fence, so nothing deeper than three levels is ever built — and the three sound
  // levels at the top register, because a follow-up never takes its parent down.
  const chain = (n: number) => Array.from({ length: n }, (_, i) => fence(`id: q${i}\nkind: choice\n${i ? `when: q${i - 1} = a\n` : ""}question: Q?\noptions:\n  - a\n  - b`)).join("\n")
  const out = questionFencesIn(chain(4000))
  assert.deepEqual(out.asks.map((a) => questionHandles(a.spec)), [["q0", "q1", "q2"]])
  assert.equal(out.faults.length, 3997, "every fence past the third level is refused by id")
  assert.deepEqual(out.faults[0], { id: "q3", faults: ["`when: q2 = a` puts this question 4 levels deep, and follow-ups go 3 levels deep at most — past that you are asking the human to fill in a form; ask it as its own question, without the `when:` line, or decide it yourself"] })
  assert.match(out.faults[3996].faults[0], /puts this question more than 3 levels deep/)
  // The edge, on both sides: three levels register whole, a fourth is refused alone.
  assert.deepEqual(questionFencesIn(chain(3)).faults, [])
  assert.deepEqual(questionFencesIn(chain(4)).faults.map((f) => f.id), ["q3"])
})

// ── The openers a markdown reader takes for the same block (round 3, 2026-10-13) ───────────────────────

const ASK = "id: x\nkind: text\nquestion: Q?"
/** Every spelling of the opener the reader takes, with the closer that goes with it. */
const OPENERS: [open: string, close: string][] = [
  ["```question", "```"], ["````question", "````"], ["~~~question", "~~~"], ["~~~~question", "~~~~"],
  ["```Question", "```"], ["```QUESTION", "```"], ["~~~Question", "~~~"], ["```qUeStIoN", "```"],
  ["``` question", "```"], ["~~~\tquestion  ", "~~~"], ["   ~~~question", "   ~~~"],
]

test("a tilde fence, a capitalised info string and a space before the word are the question fence, read exactly as the taught one", () => {
  const taught = questionFenceBlocks(`\`\`\`question\n${ASK}\n\`\`\``)[0].read
  assert.equal(taught.form, "ask")
  for (const [open, close] of OPENERS) {
    const text = `Lead.\n\n${open}\n${ASK}\n${close}\n\nAfter.`
    const blocks = questionFenceBlocks(text)
    assert.equal(blocks.length, 1, open)
    assert.deepEqual(blocks[0].read, taught, open)
    // The block is the opener line through the closer line, so the page has nothing of it left to draw.
    assert.equal(text.slice(0, blocks[0].start) + text.slice(blocks[0].end), "Lead.\n\n\nAfter.", open)
    assert.deepEqual(questionFencesIn(text), { asks: [{ id: "x", spec: taught.form === "ask" ? taught.spec : {} }], followUps: [], refs: [], faults: [] }, open)
    // A reference in the same form.
    assert.deepEqual(questionFenceBlocks(`${open}\nid: Settings-Store\n${close}`).map((b) => b.read), [{ form: "ref", id: "settings-store" }], open)
    // …and a mistake in it is refused by name, where it used to be nothing at all.
    assert.match(faultsIn(`${open}\nid: x\nkind: pick\nquestion: Q?\n${close}`), /`kind: pick` — the kinds are/, open)
  }
  // The info string is the word and nothing else: a token after it is the legacy grammar's, in any spelling.
  for (const legacy of ["```Question multi\nWhich?\n- A. x\n- B. y\n```", "~~~question qst_ab12cd34ef56\n~~~", "```QUESTION danger\nDrop it?\n```", "```questions\nid: x\n```", "```a question\nid: x\n```"]) {
    assert.deepEqual(questionFenceBlocks(legacy), [], legacy)
  }
  // No look-alike spells the word: U+212A KELVIN SIGN and U+017F LONG S fold to k and s only under /u.
  assert.deepEqual(questionFenceBlocks(`\`\`\`que\u017Ftion\n${ASK}\n\`\`\``), [])
})

test("the cheap test in front of the scan never says no to a line the scan would take", () => {
  let seed = 11
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = <T,>(from: readonly T[]): T => from[Math.floor(rnd() * from.length)]
  let openers = 0
  for (let n = 0; n < 4000; n++) {
    const word = [..."question"].map((c) => (rnd() < 0.3 ? c.toUpperCase() : c)).join("")
    const line = `${" ".repeat(Math.floor(rnd() * 5))}${pick(["`", "~"]).repeat(2 + Math.floor(rnd() * 5))}${pick(["", "", " ", "\t", "  "])}${pick([word, word, word, `${word}s`, `${word} multi`, "sql"])}${pick(["", "", " ", "\t", "\r"])}`
    const opener = questionFenceOpener(line)
    if (!opener) continue
    openers++
    assert.ok(mayHoldQuestionFence(`prose\n${line}\nid: x`), JSON.stringify(line))
    assert.equal(questionFenceBlocks(`${line}\nid: x\n${opener.char.repeat(opener.len)}`).length, 1, JSON.stringify(line))
  }
  assert.ok(openers > 500, `the generator makes openers (${openers})`)
  // The controls: what the scan does not take, the generator also makes — and the gate is only ever a maybe.
  for (const not of ["``question", "    ```question", "```question multi", "```questions", "> ```question"]) assert.equal(questionFenceOpener(not), undefined, not)
  assert.equal(mayHoldQuestionFence("no fence here, only the word question"), false)
})

test("a question fence is closed only by its own character, at least as long as its opener", () => {
  // The other character closes nothing: the fence runs to the end of the message, unclosed, as a markdown
  // reader has it — no block, and no correction for a turn that may simply have been cut off.
  for (const text of [`~~~question\n${ASK}\n\`\`\``, `\`\`\`question\n${ASK}\n~~~`, `~~~question\n${ASK}\n\`\`\`\`\`\`\n\nMore.`, `~~~~question\n${ASK}\n~~~`]) {
    assert.deepEqual(questionFencesIn(text), { asks: [], followUps: [], refs: [], faults: [] }, text)
  }
  // A longer run of its own character does; a shorter one is a line of the body, and is refused as one.
  assert.deepEqual(questionFencesIn(`~~~question\n${ASK}\n~~~~~`).asks.map((a) => a.id), ["x"])
  assert.match(faultsIn(`~~~~question\n${ASK}\n~~~\n~~~~`), /`~~~` is not a key/)
  // The closer of a tilde question may carry trailing spaces, exactly as a backtick one may.
  assert.deepEqual(questionFencesIn(`~~~question\n${ASK}\n~~~  \t`).asks.map((a) => a.id), ["x"])
})

test("a sample of the grammar stays quoted in the new forms: inside another fence of either character, a blockquote, or four spaces in", () => {
  const tilde = `~~~question\n${ASK}\n~~~`
  const backtick = `\`\`\`question\n${ASK}\n\`\`\``
  const capital = `\`\`\`Question\n${ASK}\n\`\`\``
  const quoted: [name: string, text: string][] = [
    ["a tilde question in a longer backtick fence", `\`\`\`\`md\n${tilde}\n\`\`\`\``],
    ["a tilde question in a three-backtick fence", `\`\`\`md\n${tilde}\n\`\`\``],
    ["a tilde question in a bare backtick fence", `\`\`\`\n${tilde}\n\`\`\``],
    ["a tilde question in a longer tilde fence", `~~~~md\n${tilde}\n~~~~`],
    ["a backtick question in a tilde fence", `~~~md\n${backtick}\n~~~`],
    ["a backtick question in a bare tilde fence", `~~~\n${backtick}\n~~~`],
    ["a capitalised question in a longer fence", `\`\`\`\`\n${capital}\n\`\`\`\``],
    ["a capitalised question in a tilde fence", `~~~text\n${capital}\n~~~`],
    ["a tilde question in a blockquote", tilde.split("\n").map((l) => `> ${l}`).join("\n")],
    ["a capitalised question in a blockquote", capital.split("\n").map((l) => `> ${l}`).join("\n")],
    ["a tilde question four spaces in", tilde.split("\n").map((l) => `    ${l}`).join("\n")],
    ["a capitalised question four spaces in", capital.split("\n").map((l) => `    ${l}`).join("\n")],
    ["a tilde question tab-indented", tilde.split("\n").map((l) => `\t${l}`).join("\n")],
  ]
  for (const [name, text] of quoted) {
    const whole = `Here is the grammar:\n\n${text}\n\nThat is all.`
    assert.deepEqual(questionFenceBlocks(whole), [], name)
    assert.deepEqual(questionFencesIn(whole), { asks: [], followUps: [], refs: [], faults: [] }, name)
  }
  // A question fence of one character quoting a sample of the other: the outer one asks, the inner is its context.
  const about = questionFencesIn(`~~~question\nid: outer\nkind: text\nquestion: Is this sample right?\n---\n${backtick}\n~~~`)
  assert.deepEqual([about.asks.map((a) => a.id), about.faults], [["outer"], []])
  assert.equal(about.asks[0].spec.context, backtick)
  // The controls: each sample unquoted is one question, so nothing above passes on a broken sample.
  for (const sample of [tilde, backtick, capital]) assert.deepEqual(questionFencesIn(sample).asks.map((a) => a.id), ["x"], sample)
})

test("the nested-block rule, for both characters: an info string opens a block of either one, and a bare run closes only its own", () => {
  const ask = (open: string, close: string, context: string) => questionFencesIn(`Lead.\n\n${open}\n${ASK}\n---\n${context}\n${close}\n\nAfter.`)
  const whole = (open: string, close: string, context: string, name: string) => {
    const out = ask(open, close, context)
    assert.deepEqual(out.faults, [], name)
    assert.equal(out.asks[0]?.spec.context, context, name)
  }
  // INSIDE A TILDE QUESTION.
  whole("~~~question", "~~~", "Run:\n\n```sql\nSELECT 1\n```\n\nthen say.", "a backtick block with an info string")
  whole("~~~question", "~~~", "Run:\n\n```\nls\n```\n\nthen say.", "a backtick block with none: the other character closes nothing")
  whole("~~~question", "~~~", "Run:\n\n````sql\nSELECT 1\n````\n\nthen say.", "a longer backtick block")
  whole("~~~question", "~~~", "Run:\n\n~~~sql\nSELECT 1\n~~~\n\nthen say.", "a tilde block with an info string, the same length as the fence")
  whole("~~~question", "~~~", "```sql\nUP\n```\n\nRollback:\n\n~~~sql\nDOWN\n~~~", "one block of each character")
  // A bare ~~~ inside a block that opened with an info string closes neither the block nor the question.
  whole("~~~question", "~~~", "```md\nA tilde fence looks like:\n~~~\ncode\n~~~\n```\ndone.", "a bare tilde run inside a nested backtick block")
  // INSIDE A BACKTICK QUESTION.
  whole("```question", "```", "Run:\n\n~~~sql\nSELECT 1\n~~~\n\nthen say.", "a tilde block with an info string")
  whole("```question", "```", "Run:\n\n~~~\nls\n~~~\n\nthen say.", "a tilde block with none")
  whole("```question", "```", "~~~md\nA fence looks like:\n```\ncode\n```\n~~~\ndone.", "a bare backtick run inside a nested tilde block")
  // WHAT STAYS COMMONMARK, mirrored: a bare run of the question's OWN character is its closer.
  const bare = "~~~question\nid: x\nkind: text\nquestion: Q?\n---\nRun this:\n~~~\nls\n~~~\nand tell me.\n~~~"
  const [block] = questionFenceBlocks(bare)
  assert.equal(block.read.form === "ask" && block.read.spec.context, "Run this:")
  assert.equal(bare.slice(block.end), "ls\n~~~\nand tell me.\n~~~")
  // …and a bare run of its own character inside a block of the OTHER one that has no info string, since
  // such a block was never opened as far as the fence is concerned.
  const bareInBare = questionFenceBlocks("~~~question\nid: x\nkind: text\nquestion: Q?\n---\n```\n~~~\n```\n~~~")
  assert.equal(bareInBare[0].read.form, "invalid")
  assert.match(bareInBare[0].read.form === "invalid" ? bareInBare[0].read.faults.join("\n") : "", /ends inside a ``` code block that is never closed — close it with ```/)
})

test("a tilde question cut short is refused with the same fix, and a block of the other character left open is named as that", () => {
  // The ~~~sql block is closed and the question never is: only the block's own closer ends the fence.
  const cut = questionFencesIn(`Lead.\n\n~~~question\n${ASK}\n---\nRun this:\n\n~~~sql\nSELECT 1\n~~~\n\nNotes meant for the card.`)
  assert.deepEqual([cut.asks, cut.faults.map((f) => f.id)], [[], ["x"]])
  assert.match(cut.faults[0].faults.join("\n"), /^the body below `---` ends inside an unclosed ~~~ code block: the fence is cut off there.*the `question` lines take four backticks \(````question to open, ```` to close\); the code block inside keeps three$/s)
  // A backtick block opened and never closed swallows the tilde closer; it cannot have closed the fence.
  assert.match(faultsIn(`~~~question\n${ASK}\n---\n\`\`\`sql\nSELECT 1\n~~~`), /ends inside a ``` code block that is never closed — close it with ``` on a line of its own/)
  // A block where no value reaches, in a tilde fence.
  const stray = questionFenceBlocks("~~~question\nid: z\n~~~sql\nSELECT 1\n~~~")
  assert.equal(stray[0].read.form, "invalid")
  // Unclosed under either reading: nothing, as for backticks.
  assert.deepEqual(questionFencesIn(`~~~question\n${ASK}\n---\n~~~sql\nSELECT`), { asks: [], followUps: [], refs: [], faults: [] })
})

test("follow-ups, references and restatements hold across the forms: the opener's spelling is no part of what a fence says", () => {
  const parent = "id: p\nkind: choice\nquestion: P?\noptions:\n  - go\n  - no"
  const mixed = questionFencesIn(`~~~question\n${parent}\n~~~\n\n\`\`\`Question\nid: c\nkind: text\nwhen: p = go\nquestion: C?\n\`\`\`\n\n~~~question\nid: earlier\n~~~`)
  assert.deepEqual(mixed.faults, [])
  assert.deepEqual(mixed.asks.map((a) => questionHandles(a.spec)), [["p", "c"]])
  assert.deepEqual(mixed.refs, ["earlier"])
  // The same question once in each form is a restatement, not a collision; a different one is.
  assert.deepEqual(questionFencesIn(`\`\`\`question\n${ASK}\n\`\`\`\n\n~~~question\n${ASK}\n~~~`), { asks: mixed.asks.length ? [{ id: "x", spec: questionFencesIn(`\`\`\`question\n${ASK}\n\`\`\``).asks[0].spec }] : [], followUps: [], refs: [], faults: [] })
  assert.match(faultsIn(`\`\`\`question\n${ASK}\n\`\`\`\n\n~~~question\nid: x\nkind: text\nquestion: Different?\n~~~`), /two different questions in this message use `id: x`/)
  // What the server keeps of a message — each fence's own source — reads the same as the message did.
  const text = `Lead.\n\n~~~question\n${parent}\n---\n\`\`\`sql\nSELECT 1\n\`\`\`\n~~~\n\nBetween.\n\n\`\`\`QUESTION\nid: earlier\n\`\`\`\n`
  const blocks = questionFenceBlocks(text)
  const kept = blocks.map((b) => text.slice(b.start, b.end).trimEnd()).join("\n\n")
  assert.deepEqual(questionFenceBlocks(kept).map((b) => b.read), blocks.map((b) => b.read))
  assert.deepEqual(blocks.map((b) => b.read.form), ["ask", "ref"])
})

// ── A bare option label that opens on `Word:` ──────────────────────────────────────────────────────────

test("a bare label that opens on a capitalised word and a colon is refused once, by line, with the line to write", () => {
  const head = "id: m\nkind: choice\nquestion: Merge?\noptions:\n"
  const read = (options: string) => readQuestionFence(head + options)
  const faultsOf = (options: string) => {
    const r = read(options)
    assert.equal(r.form, "invalid", options)
    return r.form === "invalid" ? r.faults : []
  }
  // The reported shape. It drew five faults (three kinds), none of which said what to write.
  assert.deepEqual(faultsOf("  - Yes: merge it\n  - No: leave it open"), [
    'option 1: `- Yes: merge it` reads as a key named `Yes`, and an option\'s keys are `label`, `description`, `recommended`, `detail` — a label that holds a colon is written `- label: "Yes: merge it"`',
    'option 2: `- No: leave it open` reads as a key named `No` too — write `- label: "No: leave it open"`',
  ])
  // THE FIX IS THE LINE: pasted in, each reads as exactly the label the worker wrote — quotes and
  // backslashes included — and so does the unquoted form, since a value runs to the end of its line.
  for (const label of ["Yes: merge it", 'No: say "later"', "A: C:\\temp", "JSON: `{}` # literal", "v2: the new one"]) {
    const [fault] = faultsOf(`  - ${label}\n  - Other`)
    const line = /written (`- label: .*`)$/.exec(fault)?.[1].slice(1, -1)
    assert.ok(line, fault)
    const fixed = read(`  ${line}\n  - Other`)
    assert.deepEqual(fixed.form === "ask" && fixed.spec.options?.map((o) => o.label), [label, "Other"], line)
    const plain = read(`  - label: ${label}\n  - Other`)
    assert.deepEqual(plain.form === "ask" && plain.spec.options?.[0].label, label, label)
  }
  // The option's own keys under such a line are still read, and still faulted for what they are.
  assert.deepEqual(faultsOf("  - A: SQLite\n    description: one store\n    recomended: true\n  - B: JSON file"), [
    'option 1: `- A: SQLite` reads as a key named `A`, and an option\'s keys are `label`, `description`, `recommended`, `detail` — a label that holds a colon is written `- label: "A: SQLite"`',
    "option 1: unknown key `recomended:` — an option's keys are `label`, `description`, `recommended`, `detail`",
    'option 2: `- B: JSON file` reads as a key named `B` too — write `- label: "B: JSON file"`',
  ])
  // A line too long to quote back is named by its opening, and the fix is described.
  const long = faultsOf(`  - Yes: ${"very ".repeat(60)}long\n  - No`)
  assert.equal(long.length, 1)
  assert.match(long[0], /^option 1: `- Yes: (very ){31}…` reads as a key named `Yes`.*written `- label: "…"` with the whole label inside the quotes$/)
  assert.ok(long[0].length < 420)
  // What was never refused still is not: a real key in any case, and a label whose colon comes later.
  const fine = read("  - Label: SQLite\n    Description: one store\n  - Option B: a JSON file\n  - Use port 8080: the default")
  assert.deepEqual(fine.form === "ask" && fine.spec.options, [{ label: "SQLite", description: "one store" }, { label: "Option B: a JSON file" }, { label: "Use port 8080: the default" }])
})

test("a misspelled option key is still a key: refused as unknown, with the label it leaves missing — and the line to write if a label was meant", () => {
  const head = "id: m\nkind: choice\nquestion: Store?\noptions:\n"
  const faultsOf = (options: string) => {
    const r = readQuestionFence(head + options)
    assert.equal(r.form, "invalid", options)
    return r.form === "invalid" ? r.faults : []
  }
  // A SINGLE LOWERCASE WORD IS A KEY. Read as a label, `lable: SQLite` would have registered an option
  // called "lable: SQLite" with nothing said; it is refused for the key it misspells.
  assert.deepEqual(faultsOf("  - lable: SQLite\n  - label: JSON file"), [
    'option 1: unknown key `lable:` — an option\'s keys are `label`, `description`, `recommended`, `detail`; if `lable: SQLite` is the label itself, write `- label: "lable: SQLite"`',
    "option 1: no `label:`",
    "`kind: choice` needs two or more options under `options:`",
  ])
  for (const key of ["name", "title", "desc", "value", "yes", "no", "text", "re-commended", "my_label"]) {
    assert.match(faultsOf(`  - ${key}: SQLite\n  - JSON file`)[0], new RegExp(`^option 1: unknown key \`${key}:\` — an option's keys are .*; if \`${key}: SQLite\` is the label itself, write \`- label: "${key}: SQLite"\`$`), key)
  }
  // Under an item's first line the same word is only ever a key: nothing there can be a label.
  assert.deepEqual(faultsOf("  - label: SQLite\n    note: fast\n    Note: fast\n  - JSON file"), [
    "option 1: unknown key `note:` — an option's keys are `label`, `description`, `recommended`, `detail`",
    "option 1: unknown key `Note:` — an option's keys are `label`, `description`, `recommended`, `detail`",
  ])
})
