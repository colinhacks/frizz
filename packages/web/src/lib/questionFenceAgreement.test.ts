// WHERE THE SERVER, THE WEB AND THE PROSE RENDERER EACH THINK A QUESTION FENCE IS — run over the same inputs.
//
// Three readers have an opinion about a ```question fence in a message:
//   · the SERVER registers a row for what `questionFencesIn` assembles (question-fences.ts syncQuestionFences);
//   · the WEB draws a card where `splitMessageQuestions` cuts a fence segment, and counts a message as naming
//     a question by `questionFenceIdsIn` (lib/questionAnchor, lib/questionShadow);
//   · MARKED draws everything the web did not cut out, so it decides what a fence the other two ignored
//     looks like: a code block labelled `question`, or raw HTML, or prose.
//
// The first two share one reader (shared question-fence.ts questionFenceBlocks), so they agree by construction
// about where a fence IS. This file pins that, and writes down every place the three still part ways, so a
// change to any of them shows up here as a named difference rather than as a card that is drawn and never
// registered. Written for the adversarial review of 2026-10-13; the inputs are the shapes that review tried.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { Lexer, type Token } from "marked"
import { questionFenceBlocks, questionFencesIn, questionHandles } from "@frizz/shared"
import { splitFenceBlocks } from "./fenceBlocks.ts"
import { awaitsItsMessage } from "./questionArrival.ts"
import { followUpParentsIn, hasQuestionBlock, questionFenceIdsIn, splitMessageQuestions, splitQuestionBlocks } from "./questionBlocks.ts"
import { refusedFencesByMessage } from "./questionFaults.ts"
import { placementNamesIn } from "./questionShadow.ts"

const TEXT = "id: x\nkind: text\nquestion: Q?"
const fence = (body: string, ticks = "```") => `${ticks}question\n${body}\n${ticks}`
const indented = (text: string, pad: string) => text.split("\n").map((l) => pad + l).join("\n")
const choice = (id: string, when?: string) => fence(`id: ${id}\nkind: choice\n${when ? `when: ${when}\n` : ""}question: ${id}?\noptions:\n  - go\n  - no`)

interface View {
  /** Root ids the server would register, then ids it would take as references. */
  server: string[]
  /** How many fences the server would answer with a correction. */
  faults: number
  /** Ids the web cuts a card slot for: an ask or a reference, then the parent a `when:` follow-up names when
   *  that parent is not in the message (the follow-up's fence is then the slot its parent's card moves to —
   *  a follow-up may be written in a later message than its parent; beside its parent it draws inside the
   *  parent's card and is no slot of its own). */
  web: string[]
  /** Fences the web hands to the LEGACY free-form card: only a fence that never tried this grammar. */
  legacyCards: number
  /** What marked makes of the whole message: every `question` code block, and every fence it read as HTML. */
  marked: string[]
}

function markedView(text: string): string[] {
  const out: string[] = []
  const walk = (tokens: Token[], path: string) => {
    for (const t of tokens) {
      if (t.type === "code" && /^question$/i.test((t as { lang?: string }).lang ?? "")) out.push(`${path}code`)
      if (t.type === "html" && /(?:`{3}|~{3})[ \t]*question/i.test(t.raw)) out.push(`${path}html`)
      const kids = (t as { tokens?: Token[] }).tokens
      if (kids) walk(kids, `${path}${t.type}>`)
      for (const item of (t as { items?: { tokens?: Token[] }[] }).items ?? []) walk(item.tokens ?? [], `${path}item>`)
    }
  }
  walk(new Lexer({ gfm: true, breaks: true }).lex(text), "")
  return out
}

function view(text: string): View {
  const assembled = questionFencesIn(text)
  const segments = splitMessageQuestions(text, true)
  return {
    server: [...assembled.asks.map((a) => a.id), ...assembled.refs],
    faults: assembled.faults.length,
    web: (() => {
      const own = segments.flatMap((s) => (s.kind === "question" && s.fence && !(s.fence.form === "ask" && s.fence.when) ? [s.fence.id] : []))
      return [...own, ...followUpParentsIn(text).filter((parent) => !own.includes(parent))]
    })(),
    legacyCards: segments.filter((s) => s.kind === "question" && !s.fence).length,
    marked: markedView(text),
  }
}

// ── The inputs ─────────────────────────────────────────────────────────────────────────────────────────

// The models lane's real replies and its probe, verbatim (shared fixtures/question-fence — the same files
// the parser's own tests read).
const fixture = (name: string) => readFileSync(new URL(`../../../shared/src/fixtures/question-fence/${name}.md`, import.meta.url), "utf8")
const REPLY_THREE_THREE = fixture("haiku-three-outside-three-inside")
const REPLY_THREE_FOUR = fixture("haiku-three-outside-four-inside")
const REPLY_NEVER_CLOSED = fixture("haiku-four-inside-never-closed")
const REPLY_LONGER_CLOSER = fixture("haiku-three-open-four-close")
const PROBE_TWO_QUESTIONS = fixture("probe-two-questions-code-in-context")

const PROBE_DETAIL_CODE = fence("id: retry-backoff\nkind: choice\nquestion: Which backoff?\noptions:\n  - label: Exponential\n    detail: |\n      ```diff\n      -  await sleep(100)\n      ```\n  - label: Keep the fixed sleep")

// A question holding a code block, written with the outer fence no longer than the inner one.
const NESTED = fence(`${TEXT}\n---\nRun this:\n\n\`\`\`sql\nSELECT 1\n\`\`\`\n\nand tell me.`)

const handMade: Record<string, string> = {
  plain: `Lead.\n\n${fence(TEXT)}\n\nAfter.`,
  crlf: `Lead.\r\n\r\n${fence(TEXT).replace(/\n/g, "\r\n")}\r\n`,
  "tilde fence": `~~~question\n${TEXT}\n~~~`,
  "tilde fence, four long": `Lead.\n\n~~~~question\n${TEXT}\n~~~~\n\nAfter.`,
  "tilde fence, capitalised": `~~~Question\n${TEXT}\n~~~`,
  "tilde fence closed by backticks": `~~~question\n${TEXT}\n\`\`\`\n\nAfter.`,
  "backtick fence closed by tildes": `\`\`\`question\n${TEXT}\n~~~\n\nAfter.`,
  "tilde fence, a reference": "Still need this:\n\n~~~question\nid: x\n~~~",
  "tilde fence, an invalid kind": "~~~question\nid: x\nkind: pick\nquestion: Q?\n~~~",
  "tilde fence, free-form": "~~~question\nShip tonight?\n\nA. Yes\nB. No\n~~~",
  "tilde fence quoted in a backtick fence": `\`\`\`md\n~~~question\n${TEXT}\n~~~\n\`\`\``,
  "tilde fence quoted in a longer backtick fence": `\`\`\`\`\n~~~question\n${TEXT}\n~~~\n\`\`\`\``,
  "tilde fence in a blockquote": indented(`~~~question\n${TEXT}\n~~~`, "> "),
  "tilde fence indented 4": indented(`~~~question\n${TEXT}\n~~~`, "    "),
  "tilde fence in a numbered list": `1. First\n2. Then:\n\n${indented(`~~~question\n${TEXT}\n~~~`, "   ")}\n3. Last`,
  "tilde fence, code in the context": `Lead.\n\n~~~question\n${TEXT}\n---\nRun this:\n\n\`\`\`sql\nSELECT 1\n\`\`\`\n\nand tell me.\n~~~\n\nAfter.`,
  "tilde fence, a bare code block in the context": `~~~question\n${TEXT}\n---\nRun:\n\`\`\`\nls\n\`\`\`\ntell me\n~~~`,
  "tilde fence, code in the context, then a done fence": `~~~question\n${TEXT}\n---\n\`\`\`sql\nSELECT 1\n\`\`\`\n~~~\n\n\`\`\`done\nShipped.\n\`\`\``,
  "tilde fence, then a backtick one": `~~~question\n${TEXT}\n~~~\n\n${fence("id: y\nkind: text\nquestion: Y?")}`,
  "tilde follow-up beside a backtick parent": `${choice("p")}\n\n~~~question\nid: c\nkind: text\nwhen: p = go\nquestion: C?\n~~~`,
  "tilde orphan follow-up": "~~~question\nid: c\nkind: text\nwhen: p = go\nquestion: C?\n~~~",
  "indented 3": indented(fence(TEXT), "   "),
  "indented 3, body flush": `   \`\`\`question\n${TEXT}\n   \`\`\``,
  "indented 4": indented(fence(TEXT), "    "),
  "tab-indented": indented(fence(TEXT), "\t"),
  "in a numbered list": `1. First\n2. Then:\n\n${indented(fence(TEXT), "   ")}\n3. Last`,
  "in a tight bullet": `- a\n${indented(fence(TEXT), "  ")}`,
  "in a blockquote": indented(fence(TEXT), "> "),
  "in <details>, blank line": `<details>\n<summary>s</summary>\n\n${fence(TEXT)}\n\n</details>`,
  "in <details>, no blank line": `<details>\n<summary>s</summary>\n${fence(TEXT)}\n</details>`,
  "in an HTML comment": `<!--\n${fence(TEXT)}\n-->`,
  "quoted in a longer fence": `\`\`\`\`md\n${fence(TEXT)}\n\`\`\`\``,
  "quoted in a tilde fence": `~~~md\n${fence(TEXT)}\n~~~`,
  "unclosed (a streaming tail)": `Lead.\n\n\`\`\`question\n${TEXT}`,
  "closer with trailing spaces": `${fence(TEXT)}   `,
  "closer longer than the opener": `\`\`\`question\n${TEXT}\n\`\`\`\`\``,
  "closer shorter than the opener": `\`\`\`\`question\n${TEXT}\n\`\`\`\n\`\`\`\``,
  "info string with a trailing space": `\`\`\`question \n${TEXT}\n\`\`\``,
  "info string capitalised": `\`\`\`Question\n${TEXT}\n\`\`\``,
  "info string in capitals": `Lead.\n\n\`\`\`QUESTION\n${TEXT}\n\`\`\`\n\nAfter.`,
  "info string capitalised, four backticks, code in the context": `\`\`\`\`Question\n${TEXT}\n---\n\`\`\`sh\nls\n\`\`\`\n\`\`\`\`\n\nTail.`,
  "info string capitalised, a reference": "```Question\nid: x\n```",
  "info string capitalised, an invalid kind": "```Question\nid: x\nkind: pick\nquestion: Q?\n```",
  "info string capitalised, free-form": "```Question\nShip tonight?\n\nA. Yes\nB. No\n```",
  "info string capitalised, quoted in a longer fence": `\`\`\`\`md\n\`\`\`Question\n${TEXT}\n\`\`\`\n\`\`\`\``,
  "info string capitalised, in a blockquote": indented(`\`\`\`Question\n${TEXT}\n\`\`\``, "> "),
  "info string capitalised, indented 4": indented(`\`\`\`Question\n${TEXT}\n\`\`\``, "    "),
  "info string after a space": `\`\`\` question\n${TEXT}\n\`\`\``,
  "legacy marker, capitalised": "```Question qst_abcdef123456\n```",
  "legacy multi, capitalised": "```Question multi\nWhich?\n- A. x\n- B. y\n```",
  "legacy multi, tilde": "~~~question multi\nWhich?\n- A. x\n- B. y\n~~~",
  "zero-width space before the opener": `​${fence(TEXT)}`,
  "legacy marker": "```question qst_abcdef123456\n```",
  "legacy multi": "```question multi\nWhich?\n- A. x\n- B. y\n```",
  "after an unclosed code block": `Code:\n\`\`\`js\nconst a = 1\n\n${fence(TEXT)}`,
  "after inline triple backticks": `Use \`\`\`question fences.\n\n${fence(TEXT)}`,
  "straight after a table": `| a | b |\n|---|---|\n| 1 | 2 |\n${fence(TEXT)}`,
  "straight after a paragraph": `Some prose line\n${fence(TEXT)}`,
  "a reference": fence("id: x"),
  "an invalid kind": fence("id: x\nkind: pick\nquestion: Q?"),
  "an invalid four-backtick fence": fence("id: x\nkind: pick\nquestion: Q?", "````"),
  "a follow-up beside its parent": `${choice("p")}\n\n${fence("id: c\nkind: text\nwhen: p = go\nquestion: C?")}`,
  "an orphan follow-up": fence("id: c\nkind: text\nwhen: p = go\nquestion: C?"),
  "a loop of follow-ups": `${choice("a", "b = go")}\n${choice("b", "a = go")}`,
  "a tree four deep": `${choice("a")}\n${choice("b", "a = go")}\n${choice("c", "b = go")}\n${fence("id: d\nkind: text\nwhen: c = go\nquestion: D?")}`,
  "two questions on one id": `${fence(TEXT)}\n${fence("id: x\nkind: text\nquestion: Different?")}`,
  "context with a longer outer fence": `${fence(`${TEXT}\n---\n\`\`\`sh\nls\n\`\`\`\nmore`, "````")}\n\nTail.`,
  "code in the context, fences the same length": `Lead.\n\n${NESTED}\n\nAfter.`,
  "code in the context, then a second question": `${NESTED}\n\n${fence("id: y\nkind: text\nquestion: Y?")}`,
  "code in the context, then a done fence": `${NESTED}\n\n\`\`\`done\nShipped.\n\`\`\``,
  "code in the context, then an awaiting fence": `${NESTED}\n\n\`\`\`awaiting\nstatus: blocked\n\`\`\``,
  "code in the context, the question never closed": `Lead.\n\n\`\`\`question\n${TEXT}\n---\n\`\`\`\`sql\nSELECT 1\n\`\`\`\`\n\nNotes.`,
  "a bare code block in the context": `${fence(`${TEXT}\n---\nRun:\n\`\`\`\nls\n\`\`\`\ntell me`)}`,
  "probe: two questions, code in the first one's context": PROBE_TWO_QUESTIONS,
  "probe: three-tick fence, code in a detail": PROBE_DETAIL_CODE,
  "reply: three outside, three inside": REPLY_THREE_THREE,
  "reply: three outside, four inside": REPLY_THREE_FOUR,
  "reply: four inside, the question never closed": REPLY_NEVER_CLOSED,
  "reply: opened with three, closed with four": REPLY_LONGER_CLOSER,
}

const wrappers: Record<string, (s: string) => string> = {
  bare: (s) => s,
  "under a paragraph": (s) => `Intro paragraph.\n${s}`,
  "in a bullet": (s) => `- item\n\n${indented(s, "  ")}`,
  "in a numbered item": (s) => `1. item\n\n${indented(s, "   ")}`,
  "in a blockquote": (s) => indented(s, "> "),
  "in <details>": (s) => `<details>\n\n${s}\n\n</details>`,
  "quoted in a longer fence": (s) => `\`\`\`\`\`text\n${s}\n\`\`\`\`\``,
  crlf: (s) => s.replace(/\n/g, "\r\n"),
  "one space in": (s) => indented(s, " "),
}
const variants: Record<string, string> = {
  text: fence(TEXT),
  "tilde text": `~~~question\n${TEXT}\n~~~`,
  "capitalised text": `\`\`\`Question\n${TEXT}\n\`\`\``,
  choice: fence("id: y\nkind: choice\nquestion: Pick?\noptions:\n  - label: A\n    description: d\n  - B"),
  "context with code": fence("id: z\nkind: text\nquestion: Z?\n---\n```sh\nls\n```", "````"),
  reference: fence("id: x"),
}
const generated: Record<string, string> = {}
for (const [w, wrap] of Object.entries(wrappers)) for (const [v, text] of Object.entries(variants)) generated[`${v}, ${w}`] = wrap(text)

const inputs = { ...handMade, ...generated }

// ── What must always hold ──────────────────────────────────────────────────────────────────────────────

test("the id helper and the splitter name the same fences, in the same order, on every input", () => {
  for (const [name, text] of Object.entries(inputs)) assert.deepEqual(questionFenceIdsIn(text), view(text).web, name)
})

test("the web cuts the message exactly where the shared reader found a fence, and loses none of it", () => {
  for (const [name, text] of Object.entries(inputs)) {
    const valid = questionFenceBlocks(text).filter((b) => b.read.form !== "invalid")
    const cut = splitMessageQuestions(text, true).filter((s) => s.kind === "question" && s.fence)
    assert.equal(cut.length, valid.length, name)
    // Every block is the opener line through the closer line: nothing of the prose on either side.
    for (const b of valid) {
      const source = text.slice(b.start, b.end)
      assert.match(source, /^ {0,3}(`{3,}|~{3,})[ \t]*question[ \t]*\r?\n/i, name)
      // …closed by a run of the character it opened with.
      assert.ok(source.trimEnd().endsWith(/^ {0,3}(`{3,}|~{3,})/.exec(source)![1]), name)
    }
  }
})

test("what the server keeps of a message — each fence's own source — reads the same as the message did", () => {
  for (const [name, text] of Object.entries(inputs)) {
    const blocks = questionFenceBlocks(text)
    const kept = blocks.map((b) => text.slice(b.start, b.end).trimEnd()).join("\n\n")
    assert.deepEqual(questionFenceBlocks(kept).map((b) => b.read), blocks.map((b) => b.read), name)
  }
})

// ── Server against web ─────────────────────────────────────────────────────────────────────────────────

// The web reads each fence ALONE, and the server refuses some for what the whole message makes of them. A
// `when:` follow-up draws nothing of its own beside its parent, and a follow-up never takes its parent down
// (since 2026-10-13 a fourth level is refused on its own fence, and the three sound levels above it
// register), so a root's slot and its row agree on every message below.
//
// The one way the two differ: a follow-up whose parent is NOT in its message. The web cuts the PARENT's slot
// there (lib/questionBlocks followUpParentsIn — the parent may be an open question of an earlier message,
// which only the thread's rows can say), while this message alone gives the assembly nothing to register:
// it hands the follow-up to the registrar unjudged.
const WEB_ONLY: Record<string, string[]> = {
  "an orphan follow-up": ["p"],
  "tilde orphan follow-up": ["p"],
}

test("the web cuts a card slot for exactly the ids the server registers or references", () => {
  const differing: Record<string, { server: string[]; web: string[] }> = {}
  for (const [name, text] of Object.entries(inputs)) {
    const v = view(text)
    // As SETS: two fences on one id are two slots, and ChatView draws a card in the first only.
    const ids = (list: string[]) => JSON.stringify([...new Set(list)].sort())
    if (ids(v.server) !== ids(v.web)) differing[name] = { server: v.server, web: v.web }
  }
  assert.deepEqual(differing, Object.fromEntries(Object.entries(WEB_ONLY).map(([name, web]) => [name, { server: [], web }])))
  // The four-deep tree: its root registers with three levels, and the fourth is refused by name.
  assert.deepEqual([view(inputs["a tree four deep"]).server, view(inputs["a tree four deep"]).faults], [["a"], 1])
  // The control: the harness can see a difference — a root the server refuses whole is still cut by the web.
  const refusedRoot = view("```question\nid: m\nkind: choice\nquestion: Q?\noptions:\n  - label: A\n    recommended: true\n  - label: B\n    recommended: true\n```")
  assert.deepEqual([refusedRoot.server, refusedRoot.web.length > 0 || refusedRoot.faults > 0], [[], true])
  assert.deepEqual(view(inputs.plain), { server: ["x"], faults: 0, web: ["x"], legacyCards: 0, marked: ["code"] })
})

test("a follow-up is the server's through its root and the web's through its parent's card", () => {
  const v = view(inputs["a follow-up beside its parent"])
  assert.deepEqual(v.server, ["p"])
  assert.deepEqual(v.web, ["p"])
  assert.deepEqual(questionHandles(questionFencesIn(inputs["a follow-up beside its parent"]).asks[0].spec), ["p", "c"])
  // …and a loop hangs off nothing: refused by the server and drawn nowhere.
  const lost = view(inputs["a loop of follow-ups"])
  assert.deepEqual([lost.server, lost.web], [[], []])
  assert.ok(lost.faults > 0, "a loop of follow-ups: the worker is told")
  // A follow-up whose parent is NOT in its message is no longer refused here: it may hang off a question
  // the thread already has open, so the reader hands it to the server unjudged (the registrar attaches it
  // or refuses it by name — server question-fences.test.ts). The web cuts no slot of ITS own for it, and
  // keeps the slot for its parent's card, which draws there only if the thread has a row by that name.
  const late = view(inputs["an orphan follow-up"])
  assert.deepEqual([late.server, late.web, late.faults], [[], ["p"], 0])
  assert.equal(questionFencesIn(inputs["an orphan follow-up"]).followUps.length, 1)
})

test("a question holding a code block: the server registers it whole and the web cuts the same span", () => {
  // The four replies and the probe, each as [what registers, how many corrections].
  const expected: [string, string[], number][] = [
    ["reply: three outside, three inside", ["orders-archived-at-prod"], 0],
    ["reply: three outside, four inside", ["orders-archived-at-migration"], 0],
    // Its sql block is closed and the question never is: refused by name, and drawn by nobody as a card.
    ["reply: four inside, the question never closed", [], 1],
    // A whole question with no context; the SQL after it is the message's own prose.
    ["reply: opened with three, closed with four", ["approve-orders-archived-at-migration"], 0],
    // The second question used to be swallowed by the block the first one's real closer opened.
    ["probe: two questions, code in the first one's context", ["orders-archived-at", "orders-backfill"], 0],
    ["probe: three-tick fence, code in a detail", ["retry-backoff"], 0],
  ]
  for (const [name, ids, faults] of expected) {
    const v = view(inputs[name])
    assert.deepEqual([v.server, v.web, v.faults], [ids, ids, faults], name)
  }
  // THE SPAN. What the web hands marked is the message with each question cut out at the shared reader's
  // offsets — so no half of a fence is left behind for marked to open a code block on.
  for (const name of ["code in the context, fences the same length", "reply: three outside, three inside", "reply: three outside, four inside", "probe: two questions, code in the first one's context"]) {
    const segments = splitMessageQuestions(inputs[name], true)
    const prose = segments.flatMap((s) => (s.kind === "prose" ? [s.text] : []))
    for (const text of prose) assert.doesNotMatch(text, /^ {0,3}(`{3,}|~{3,})/m, `${name}: no fence line is left in the prose`)
    assert.deepEqual(prose.flatMap((text) => markedView(text)), [], name)
    // …and the card's context is the worker's whole body, its code block closed.
    for (const s of segments) {
      if (s.kind !== "question" || s.fence?.form !== "ask" || !s.fence.spec.context?.includes("sql")) continue
      const context = new Lexer({ gfm: true }).lex(s.fence.spec.context)
      assert.ok(context.some((t) => t.type === "code" && (t as { lang?: string }).lang === "sql"), `${name}: the context draws a sql block`)
      for (const t of context) if (t.type === "code") assert.match(t.raw.trimEnd(), /\n`{3,}$/, `${name}: and every block in it is closed`)
    }
  }
  assert.deepEqual(splitMessageQuestions(inputs["code in the context, fences the same length"], true).map((s) => (s.kind === "prose" ? s.text : s.fence?.id)), ["Lead.\n\n", "x", "\nAfter."])
})

test("a done or awaiting fence written after a question that holds a code block is still a signal fence", () => {
  for (const [name, kind] of [["code in the context, then a done fence", "done"], ["code in the context, then an awaiting fence", "awaiting"]] as const) {
    const segments = splitFenceBlocks(inputs[name])
    assert.deepEqual(segments.map((s) => (s.kind === "fence" ? s.fenceKind : "prose")), ["prose", kind], name)
    // The prose run it leaves is the question, whole, which the question splitter then cuts as one card.
    const prose = segments[0].kind === "prose" ? segments[0].text : ""
    assert.deepEqual(splitMessageQuestions(prose, true).map((s) => (s.kind === "question" ? s.fence?.id : "prose")), ["x"], name)
  }
  // The control: the same signal fence inside a code block that really is open stays quoted.
  assert.deepEqual(splitFenceBlocks("```sql\nSELECT 1\n\n```done\nShipped.\n```").map((s) => s.kind), ["prose"])
})

test("a legacy thread reads its fences as it always did", () => {
  // A placement marker (an info string with a token after `question`) and a ```question multi block are
  // not the nesting grammar: nothing about where they end, or what follows them, moves.
  const marker = "Before.\n\n```question qst_abcdef123456\n```\n\nAfter, with code:\n\n```sql\nSELECT 1\n```\n\n```done\nShipped.\n```"
  assert.deepEqual(splitFenceBlocks(marker).map((s) => (s.kind === "fence" ? s.fenceKind : "prose")), ["prose", "done"])
  assert.deepEqual(splitQuestionBlocks(marker).map((s) => (s.kind === "question" ? s.registeredId : "prose")), ["prose", "qst_abcdef123456", "prose"])
  const multi = "```question multi\nWhich?\n- A. x\n- B. y\n```\n\n```sql\nSELECT 1\n```\n\n```awaiting\nstatus: blocked\n```"
  assert.deepEqual(splitFenceBlocks(multi).map((s) => (s.kind === "fence" ? s.fenceKind : "prose")), ["prose", "awaiting"])
  assert.deepEqual(splitQuestionBlocks(multi).map((s) => (s.kind === "question" ? s.questionKind : "prose")), ["multi", "prose"])
  // A free-form ```question block — the legacy grammar's own ask — followed by a second one.
  const freeForm = "```question\nWhich store?\n- A. SQLite\n- B. JSON\n```\n\nAnd:\n\n```question\nWhich port?\n```"
  assert.deepEqual(splitQuestionBlocks(freeForm).map((s) => s.kind), ["question", "prose", "question"])
  assert.deepEqual(splitMessageQuestions(freeForm, false), splitQuestionBlocks(freeForm))
})

// ── Both against the renderer ──────────────────────────────────────────────────────────────────────────

test("what the shared reader takes for a fence, against what marked would have drawn there", () => {
  const read: string[] = []
  const unread: string[] = []
  for (const [name, text] of Object.entries(inputs)) {
    const blocks = questionFenceBlocks(text).length
    const drawn = view(text).marked
    // READ, BUT NOT A CODE BLOCK TO MARKED: the card is cut out of what marked takes for one HTML block, so
    // the tags around it are rendered as two halves.
    if (blocks > 0 && drawn.some((d) => d.endsWith("html"))) read.push(name)
    // A `question` CODE BLOCK TO MARKED, BUT NOT READ: the worker wrote something a markdown reader shows as
    // a question fence, nothing registers, and no correction says so.
    if (blocks === 0 && drawn.some((d) => d.endsWith("code"))) unread.push(name)
  }
  assert.deepEqual(read, ["in <details>, no blank line", "in an HTML comment"])
  // What is left unread is a fence that never closed, and the forms a worker QUOTES a sample in. A tilde
  // fence and a capitalised info string were on this list until the reader took them (2026-10-13).
  assert.deepEqual(unread, [
    "tilde fence closed by backticks",
    "backtick fence closed by tildes",
    "tilde fence in a blockquote",
    "in a blockquote",
    "unclosed (a streaming tail)",
    "info string capitalised, in a blockquote",
    "text, in a blockquote",
    "tilde text, in a blockquote",
    "capitalised text, in a blockquote",
    "choice, in a blockquote",
    "context with code, in a blockquote",
    "reference, in a blockquote",
  ])
})

// ── The openers a markdown reader takes for the same block ─────────────────────────────────────────────

// The forms the reader took on 2026-10-13 (shared code-fences.ts questionFenceOpener). The server registers
// each, so the page has to draw the card for each — and must not ALSO hand the fence to marked, which would
// draw a code block labelled `question` beside it.
const NEW_FORMS: [name: string, ids: string[]][] = [
  ["tilde fence", ["x"]],
  ["tilde fence, four long", ["x"]],
  ["tilde fence, capitalised", ["x"]],
  ["tilde fence, a reference", ["x"]],
  ["tilde fence in a numbered list", ["x"]],
  ["tilde fence, code in the context", ["x"]],
  ["tilde fence, a bare code block in the context", ["x"]],
  ["tilde fence, then a backtick one", ["x", "y"]],
  ["tilde follow-up beside a backtick parent", ["p"]],
  ["info string capitalised", ["x"]],
  ["info string in capitals", ["x"]],
  ["info string capitalised, four backticks, code in the context", ["x"]],
  ["info string capitalised, a reference", ["x"]],
  ["info string after a space", ["x"]],
]

test("a tilde fence and a capitalised info string: the server registers it, and the page draws its card and no code block", () => {
  for (const [name, ids] of NEW_FORMS) {
    const text = inputs[name]
    const v = view(text)
    assert.deepEqual([v.server, v.web, v.faults, v.legacyCards], [ids, ids, 0, 0], name)
    // What is left for marked once the cards are cut out holds no fence line at all.
    const segments = splitMessageQuestions(text, true)
    assert.deepEqual(segments.filter((s) => s.kind === "question").map((s) => (s.kind === "question" ? s.fence?.id : "")), ids.length === 1 && name.includes("follow-up") ? ["p", "c"] : ids, name)
    for (const s of segments) {
      if (s.kind !== "prose") continue
      assert.doesNotMatch(s.text, /^ {0,3}(`{3,}|~{3,})/m, `${name}: no fence line is left in the prose`)
      assert.deepEqual(markedView(s.text), [], `${name}: and marked draws no question code block`)
    }
    // EVERY READER BEHIND A GATE sees it: each of these returned early on a literal ```question.
    assert.equal(hasQuestionBlock(text), true, name)
    assert.deepEqual(placementNamesIn(text), ids, name)
    assert.deepEqual(questionFenceIdsIn(text), ids, name)
  }
  assert.deepEqual(splitMessageQuestions(inputs["tilde fence, code in the context"], true).map((s) => (s.kind === "prose" ? s.text : s.fence?.id)), ["Lead.\n\n", "x", "\nAfter."])
  // A follow-up written on tildes in a later message than its parent claims the parent's slot.
  assert.deepEqual(followUpParentsIn(inputs["tilde orphan follow-up"]), ["p"])
  // The row that arrives before its message is held until a message names it — a tilde fence names it.
  const row = { id: "qst_1", askedAt: "2026-10-20T10:00:05.000Z", spec: { handle: "x", question: "Q?", kind: "question" as const } }
  const message = (text: string) => [{ role: "assistant" as const, text, at: "2026-10-20T10:00:00.000Z" }]
  assert.equal(awaitsItsMessage(row, message("Nothing yet.")), true)
  for (const name of ["tilde fence", "info string in capitals", "info string capitalised, a reference"]) assert.equal(awaitsItsMessage(row, message(inputs[name])), false, name)
  // A fence the server refused is matched to its message by id, whatever its opener.
  const refused = refusedFencesByMessage(message(inputs["tilde fence"]), [{ at: "2026-10-20T10:00:00.000Z", id: "x", faults: ["`id: x` is already used"] }])
  assert.deepEqual([...refused].map(([i, set]) => [i, [...set]]), [[0, ["x"]]])
  assert.deepEqual(splitMessageQuestions(inputs["tilde fence"], true, refused.get(0)).map((s) => s.kind), ["refusedAsk"], "…and is then a question not asked")
})

test("a new-form fence that does not read is a code block, and one that is quoted stays quoted", () => {
  // Tried the grammar and failed: corrected by the server, a code block on the page, never the legacy card.
  for (const name of ["tilde fence, an invalid kind", "info string capitalised, an invalid kind"]) {
    const v = view(inputs[name])
    assert.deepEqual([v.server, v.web, v.faults, v.legacyCards, v.marked], [[], [], 1, 0, ["code"]], name)
    assert.deepEqual(splitMessageQuestions(inputs[name], true).map((s) => s.kind), ["invalidFence"], name)
  }
  // Free-form under a new opener: the legacy card knows one opener and this is not it, so it is a code
  // block too — and now the server says so, where it used to say nothing.
  for (const name of ["tilde fence, free-form", "info string capitalised, free-form"]) {
    const v = view(inputs[name])
    assert.deepEqual([v.server, v.web, v.legacyCards, v.marked], [[], [], 0, ["code"]], name)
    assert.ok(v.faults > 0, name)
  }
  // Quoted, in every way a sample is quoted: nothing registers, nothing is corrected, no card.
  for (const name of ["tilde fence quoted in a backtick fence", "tilde fence quoted in a longer backtick fence", "tilde fence in a blockquote", "tilde fence indented 4", "info string capitalised, quoted in a longer fence", "info string capitalised, in a blockquote", "info string capitalised, indented 4", "quoted in a tilde fence"]) {
    const v = view(inputs[name])
    assert.deepEqual([v.server, v.web, v.faults, v.legacyCards], [[], [], 0, 0], name)
    assert.equal(hasQuestionBlock(inputs[name]), false, name)
  }
  // Closed by the other character, it never closed: marked runs it to the end of the message as code.
  for (const name of ["tilde fence closed by backticks", "backtick fence closed by tildes"]) {
    assert.deepEqual([view(inputs[name]).server, view(inputs[name]).faults, view(inputs[name]).marked], [[], 0, ["code"]], name)
  }
  // A done fence after a tilde question that holds a code block is still a signal fence.
  const segments = splitFenceBlocks(inputs["tilde fence, code in the context, then a done fence"])
  assert.deepEqual(segments.map((s) => (s.kind === "fence" ? s.fenceKind : "prose")), ["prose", "done"])
})

test("a legacy thread, and the legacy forms on any thread, are untouched by the new openers", () => {
  // THE LEGACY READER KNOWS ONE OPENER: three backticks and a lowercase `question` at the margin. Every
  // input here reads through it exactly as it did, new forms included — on a legacy thread a tilde or
  // capitalised fence was a code block before and is one now.
  const expected: Record<string, unknown[]> = {
    "legacy marker": [{ kind: "question", text: "", questionKind: "question", danger: false, registeredId: "qst_abcdef123456" }],
    "legacy multi": [{ kind: "question", text: "Which?\n- A. x\n- B. y", questionKind: "multi", danger: false }],
    "legacy marker, capitalised": [{ kind: "prose", text: inputs["legacy marker, capitalised"] }],
    "legacy multi, capitalised": [{ kind: "prose", text: inputs["legacy multi, capitalised"] }],
    "legacy multi, tilde": [{ kind: "prose", text: inputs["legacy multi, tilde"] }],
    "tilde fence": [{ kind: "prose", text: inputs["tilde fence"] }],
    "tilde fence, free-form": [{ kind: "prose", text: inputs["tilde fence, free-form"] }],
    "info string capitalised": [{ kind: "prose", text: inputs["info string capitalised"] }],
    "info string capitalised, free-form": [{ kind: "prose", text: inputs["info string capitalised, free-form"] }],
    "info string after a space": [{ kind: "prose", text: inputs["info string after a space"] }],
    "tilde fence, code in the context": [{ kind: "prose", text: inputs["tilde fence, code in the context"] }],
  }
  for (const [name, segments] of Object.entries(expected)) {
    assert.deepEqual(splitQuestionBlocks(inputs[name]), segments, name)
    assert.deepEqual(splitMessageQuestions(inputs[name], false), segments, `${name}: a legacy thread`)
  }
  // The free-form fence itself, in each shape the legacy grammar has: one card, the same bytes in it.
  const freeForm: [text: string, segments: unknown[]][] = [
    ["```question\nShip tonight?\n\nA. Yes\nB. No\n```", [{ kind: "question", text: "Ship tonight?\n\nA. Yes\nB. No", questionKind: "question", danger: false }]],
    ["Lead.\n\n```question danger\nDrop the table?\n```\n\nAfter.", [{ kind: "prose", text: "Lead.\n\n" }, { kind: "question", text: "Drop the table?", questionKind: "question", danger: true }, { kind: "prose", text: "\n\nAfter." }]],
    // Beside a tilde or capitalised block on the same legacy thread: that block is prose, the fence a card.
    ["~~~question\nnot an ask here\n~~~\n\n```question\nWhich port?\n```", [{ kind: "prose", text: "~~~question\nnot an ask here\n~~~\n\n" }, { kind: "question", text: "Which port?", questionKind: "question", danger: false }]],
    ["```Question\nnot an ask here\n```\n\n```question\nWhich port?\n```", [{ kind: "prose", text: "```Question\nnot an ask here\n```\n\n" }, { kind: "question", text: "Which port?", questionKind: "question", danger: false }]],
    // A legacy fence QUOTED inside a tilde block stays quoted.
    ["~~~md\n```question\nWhich port?\n```\n~~~", [{ kind: "prose", text: "~~~md\n```question\nWhich port?\n```\n~~~" }]],
  ]
  for (const [text, segments] of freeForm) {
    assert.deepEqual(splitQuestionBlocks(text), segments, text)
    assert.deepEqual(splitMessageQuestions(text, false), segments, text)
    assert.equal(hasQuestionBlock(text), segments.some((s) => (s as { kind: string }).kind === "question"), text)
  }
  // On a thread that DOES speak the fence, a free-form fence with the taught opener keeps the legacy card.
  assert.deepEqual(splitMessageQuestions(freeForm[0][0], true), freeForm[0][1])
})


test("a fence that tried the grammar and failed is a code block, whatever its backticks or indent", () => {
  // It used to "keep the rendering it had": splitQuestionBlocks over the same bytes. That reader knows one
  // opener — ```question at column 0 — so the same mistake drew as the legacy card there and as a code block
  // with four backticks or an indent. The web now hands none of them to the legacy card.
  for (const text of [inputs["an invalid kind"], inputs["an invalid four-backtick fence"], indented(inputs["an invalid kind"], "  ")]) {
    assert.equal(view(text).legacyCards, 0)
    assert.deepEqual(view(text).marked, ["code"])
    assert.deepEqual(splitMessageQuestions(text, true).map((s) => s.kind), ["invalidFence"])
  }
  // Negative control: a free-form fence (no key opens its body) is still the legacy card on such a thread.
  assert.equal(view("```question\nShip tonight?\n\nA. Yes\nB. No\n```").legacyCards, 1)
})
