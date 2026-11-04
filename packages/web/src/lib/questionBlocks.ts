// Parse an assistant message's markdown for ```question fenced blocks so the renderer can set each
// one off as an answerable card WITHIN the message's narrative flow (prose stays in place). Pure
// string logic, no DOM — unit-testable.

import { insideFence, mayHoldQuestionFence, QUESTION_FENCE_KEYS, questionFenceBlocks, type AskedQuestion, type QuestionFenceRead } from "@frizz/shared"

// The two answer MODES a ```question block can carry (the info-string picks one):
//   question — single-select (radio feel) OR freetext; the default.
//   multi    — multi-select: several options may be toggled on at once, freetext appends color.
// `danger` (a separate orthogonal flag, below) layers destructive styling on either of these.
//
// There used to be a third, `approval`: a go/no-go gate that rendered as ONE "Approve" button which
// SENT on click. It is gone (maintainer 2026-07-26) — a one-click send contradicted the staging model
// every other block follows (choose, then Send answers), and a lone Approve button couldn't express the
// decline the gate's own second option named. A go/no-go is just a two-option question, so the token
// now degrades to `question` and legacy ```question approval blocks in old transcripts render as the
// two-option multiple choice they always were underneath.
export type QuestionKind = "question" | "multi"

// Per-question-block answer state (one per ```question block in a message). `chosen` is the selected
// chip index for a single-select block, and while it is set the chip IS the answer. Chip and typed text
// COEXIST as state — a chip click never destroys the typed draft, and re-clicking the chosen chip
// toggles it off (maintainer 2026-09-02; a click used to clear the box). Exclusivity is kept by the
// producers non-destructively: focusing or typing the free-text box clears `chosen`, so whichever was
// touched LAST is the effective answer and the other half stays visible as an unselected draft.
// `chosenSet` is the toggled-on option indices for a `multi` block, where freetext COEXISTS with the
// selection (it appends color) rather than competing with it. Lives here (not in a component) so the
// shared answering controller, the queue card, and the thread view all agree.
export type BlockAnswer = { chosen: number | null; text: string; chosenSet?: number[] }

// The interactivity handed to the shared Message renderer so a LIVE message's ```question blocks become
// answerable (chips + a per-block freetext line). Absent → the blocks render read-only.
export type MessageAnswering = {
  answerFor: (blockIdx: number) => BlockAnswer
  onChip: (blockIdx: number, optIdx: number, optText: string) => void
  onText: (blockIdx: number, text: string) => void
  onSubmit: () => void // Enter from any block input, or this message's Send button, composes + sends
  anyAnswered: boolean // at least one of THIS message's blocks is filled → its Send button is enabled
  sending: boolean // a send is in flight → disable this message's Send button
}

export type MessageSegment =
  | { kind: "prose"; text: string }
  // `registeredId` is set only when the info-string named one (```question qst_ab12cd34): the fence is
  // then a PLACEMENT for that registered row — see lib/questionShadow — rather than a question of its
  // own. Absent, not undefined, so a segment still deep-equals the plain shape it had before.
  // `fence` is set only on a thread that speaks THE QUESTION FENCE (shared question-fence.ts — every thread
  // dispatched after QUESTION_FENCE_RETIRED_AT), and only for a fence that reads as an ask or a reference:
  // its `id:` names a registered row the way `registeredId` does, so it is a placement too. See
  // splitMessageQuestions.
  | { kind: "question"; text: string; questionKind: QuestionKind; danger: boolean; registeredId?: string; fence?: Exclude<QuestionFenceRead, { form: "invalid" }> }
  // An `id:`-only fence the server REFUSED: it names a question that was never asked, or one already
  // withdrawn or dismissed (splitMessageQuestions). Drawn as a note saying so, never as a card.
  | { kind: "refusedRef"; id: string }
  // A readable ask the server REFUSED (its id spent, its parent settled, …): drawn greyed, headed "Question
  // not asked" over the server's reason, never answerable and never a claim on another row's card.
  | { kind: "refusedAsk"; id: string; spec: AskedQuestion }
  // A fence that tried the grammar and failed to read: the reader's own faults over the worker's bytes.
  | { kind: "invalidFence"; text: string; faults: string[] }

// Opening fence begins a line: ```question, an OPTIONAL info-string of one or more space-separated
// tokens (e.g. ```question multi, ```question danger), then a newline;
// the block runs non-greedily to the next line that is exactly ``` (optional trailing spaces). Group 1
// captures the WHOLE info-string run (letter-led, up to the newline) so multi-token combinations parse;
// parseInfoString below tokenizes it. The `m` flag anchors ^/$ to line boundaries; an unterminated
// opener simply never matches, so a half-written block degrades to ordinary prose (markdown renders it
// as a plain code block).
// THE BODY IS OPTIONAL ONLY FOR A PLACEMENT MARKER. A worker placing a question it already registered
// has nothing to put in the body — the card is drawn from the ROW, and anything written here is thrown
// away — so the empty two-line form is what it should be able to write:
//
//     ```question qst_ab12cd34
//     ```
//
// Every other empty fence stays prose. The loop below drops an empty body that carries no id, so
// ```question with nothing in it can never become a blank answerable card.
//
// The body group is LAZY-OPTIONAL (`??`), not optional. A greedy `?` tries to MATCH the group before it
// tries to skip it, so an empty marker followed later in the message by a real ```question fence matched
// from the marker's opener all the way to that fence's closer and swallowed everything between as its
// body. `??` skips first, which is the empty marker, and only backtracks into the group when the line
// after the opener is not the closer — i.e. for a fence that really does have a body.
const QUESTION_BLOCK = /^```question(?:[ \t]+([A-Za-z][^\r\n]*?))?[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??```[ \t]*$/gm

// The tokens the info-string understands. `multi` is the only base-kind token left; `danger` is an
// orthogonal styling flag. GRACEFUL DEGRADATION: unknown/extra tokens are ignored, and an info-string
// with no recognized base token degrades to kind "question" — a never-break rule so a future, mistyped,
// or RETIRED token can never turn a block into a parse failure. The retired `approval` rides exactly
// that rule: a legacy ```question approval danger still parses as a danger-styled two-option question.
// A REGISTERED question's id, as `ask` mints and returns it. A worker puts one in the info string to say
// "this fence is where that registration renders", which is placement by NAME rather than by matching
// the prose — the fuzzy path stays for every worker that writes no id (lib/questionShadow).
const REGISTERED_ID = /^qst_[a-z0-9]+$/

function parseInfoString(info: string | undefined): { kind: QuestionKind; danger: boolean; registeredId?: string } {
  const tokens = (info ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  const has = (t: string) => tokens.includes(t)
  const registeredId = tokens.find((t) => REGISTERED_ID.test(t))
  return { kind: has("multi") ? "multi" : "question", danger: has("danger"), ...(registeredId ? { registeredId } : {}) }
}

export function splitQuestionBlocks(text: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  // An opener that sits INSIDE a fenced code block is being QUOTED, not asked — a worker documenting
  // the protocol wraps its sample in a ```` fence. Hoisting that sample into a live answerable card also
  // strands the enclosing delimiters as orphan prose, whose unterminated fence then swallows the rest of
  // the message (maintainer 2026-07-25). Left in the prose run, it renders as the code block it is.
  const quoted = insideFence(text)
  let lastIndex = 0
  QUESTION_BLOCK.lastIndex = 0
  for (let m = QUESTION_BLOCK.exec(text); m !== null; m = QUESTION_BLOCK.exec(text)) {
    if (quoted(m.index)) {
      QUESTION_BLOCK.lastIndex = m.index + 1 // rescan from just past the opener, never skip what it spanned
      continue
    }
    const { kind, danger, registeredId } = parseInfoString(m[1])
    // An empty body with no id names nothing and asks nothing — leave it in the prose run as the code
    // block it is, and rescan from just past the opener so nothing it spanned is skipped.
    if (m[2] === undefined && !registeredId) {
      QUESTION_BLOCK.lastIndex = m.index + 1
      continue
    }
    const prose = text.slice(lastIndex, m.index)
    if (prose.trim()) segments.push({ kind: "prose", text: prose })
    segments.push({ kind: "question", text: m[2] ?? "", questionKind: kind, danger, ...(registeredId ? { registeredId } : {}) })
    lastIndex = m.index + m[0].length
  }
  const rest = text.slice(lastIndex)
  if (rest.trim()) segments.push({ kind: "prose", text: rest })
  return healOrphanedOptions(segments)
}

// ---- THE QUESTION FENCE (2026-10-13) ----
//
// A thread dispatched after QUESTION_FENCE_RETIRED_AT asks by writing a structured ```question fence —
// `id:`, `kind:`, `question:`, `options:`, then markdown context under `---` (shared question-fence.ts,
// which the server reads to register each new id as a row). A fence carrying `id:` alone REFERENCES a
// question that already exists. Either way the fence's id names a ROW, so the fence is a placement for
// that row's card exactly as the legacy empty ```question qst_… marker is (lib/questionShadow): the card is
// drawn from the row, never from these bytes, and the one Send carries it.
//
// THE SHARED READER DECIDES WHAT IS A FENCE, so this module cannot disagree with the server about which
// fences registered: questionFenceBlocks skips a sample quoted inside a longer outer fence, reads a
// ````question opener (a fence whose context carries a code block), and leaves the legacy info-string forms
// (```question qst_…, ```question multi) to splitQuestionBlocks.
//
// A FREE-FORM FENCE IS LEFT EXACTLY WHERE IT WAS. A post-cutover thread's history holds free-form fences the
// worker wrote between 2026-09-11 and this grammar; none of them reads as an ask, and each keeps the
// rendering it had (splitQuestionBlocks over the same bytes), so nothing already on screen changes shape.
//
// THE SHARED READER ALSO DECIDES WHETHER TO LOOK. Every gate in front of it here asks the shared
// `mayHoldQuestionFence`, never a literal of its own: the reader takes a ~~~question fence and a capitalised
// ```Question for the fence (shared code-fences.ts questionFenceOpener), and while these gates matched three
// backticks and a lowercase word, such a fence registered on the server and drew on the page as a code block
// labelled `question`, with its card nowhere. The legacy readers (splitQuestionBlocks, the markers) keep
// their own literal: their grammar is that exact opener and nothing else.
//
// A FENCE THAT TRIED THE GRAMMAR AND FAILED IS THE CODE BLOCK IT IS. Its body opens on a key (`id:`,
// `kind:`, …) and does not read: a missing `kind:`, an unknown key, a bad id. The server registers nothing
// for it and corrects the worker. Left to splitQuestionBlocks it drew three ways for one mistake — three
// backticks at the margin became the legacy card, headed "Question" over the worker's YAML as prose, while
// the same fence with four backticks or an indent was a code block (the legacy reader knows one opener).
// A card that cannot be answered and shows front matter is the worst of the three, so all of them are now
// the code block: the worker's own bytes, plainly not a card, until its corrected fence lands. Since
// 2026-11-04 the reader's faults ride with it (`invalidFence`), so the block says why it is not a card.

/** A message's segments under the grammar its thread speaks. `fenceGrammar` false (a legacy thread, or a
 *  surface that has no registered rows to resolve against) is splitQuestionBlocks unchanged. */
export function splitMessageQuestions(text: string, fenceGrammar: boolean, refused?: ReadonlySet<string>): MessageSegment[] {
  if (!fenceGrammar || !mayHoldQuestionFence(text)) return splitQuestionBlocks(text)
  const blocks = questionFenceBlocks(text).filter((b) => b.read.form !== "invalid" || triesFenceGrammar(b.body))
  if (blocks.length === 0) return splitQuestionBlocks(text)
  const out: MessageSegment[] = []
  let at = 0
  for (const b of blocks) {
    out.push(...splitQuestionBlocks(text.slice(at, b.start)))
    at = b.end
    // A REFUSED REFERENCE says so (2026-10-21). Its code block was two words — `id: clerk-local-dev-key` —
    // sitting where the worker's prose promised a card, and the human could not tell a reference to
    // nothing from a stray snippet.
    if (b.read.form === "ref" && isRefused(b.read, refused)) {
      out.push({ kind: "refusedRef", id: b.read.id })
      continue
    }
    // …and so does a refused ASK (2026-11-04). It was the worker's YAML as a code block, with nothing
    // saying why: the maintainer met a well-formed question drawn that way — refused only because its id
    // was spent the day before — and read it as a fence the parser could not read. Its question is still
    // worth reading, so it draws as the card it would have been, greyed and headed with what happened.
    if (b.read.form === "ask" && isRefused(b.read, refused)) {
      out.push({ kind: "refusedAsk", id: b.read.id, spec: b.read.spec })
      continue
    }
    if (b.read.form === "invalid") {
      // The worker's bytes, which markdown draws as code, under the faults that kept it from reading.
      out.push({ kind: "invalidFence", text: text.slice(b.start, b.end), faults: b.read.faults })
      continue
    }
    const read = b.read
    out.push({
      kind: "question",
      text: b.body,
      questionKind: read.form === "ask" && read.spec.kind === "multi" ? "multi" : "question",
      danger: read.form === "ask" && read.spec.danger === true,
      fence: read,
    })
  }
  out.push(...splitQuestionBlocks(text.slice(at)))
  return out
}

// A FENCE THE SERVER REFUSED NAMES NO QUESTION. It read, so it has an id, and the server would not
// register it under that id: the id is spent on a different question, its parent is settled, it references
// nothing (lib/questionFaults, which works out the refused ids of each message from the board's
// `questionFaults` and hands them in here as `refused`). It is not a question the human is being asked, so
// it draws no live card — neither a card of its own nor, the worse reading, the card of the row its id
// happens to name — and every reader below that asks "which questions does this message name" leaves it
// out. It draws as what it is instead: a refused ask as its question greyed under "Question not asked"
// (`refusedAsk`), a refused `id:`-only reference as a note naming what it pointed at (`refusedRef`).

/** Is this readable fence one the server refused (by its lowercased id)? */
function isRefused(read: Exclude<QuestionFenceRead, { form: "invalid" }>, refused: ReadonlySet<string> | undefined): boolean {
  return refused !== undefined && refused.size > 0 && refused.has(read.id.toLowerCase())
}

// The grammar's keys (shared QUESTION_FENCE_KEYS), as the first thing a fence's body says. A free-form
// fence opens on its question, in prose; a fence that opens on `id:` or `kind:` was written for the reader.
const FENCE_KEY_LINE = new RegExp(`^[ \\t]*(?:${QUESTION_FENCE_KEYS.join("|")}):(?:[ \\t]|$)`)

/** Did this fence's body TRY the question-fence grammar — does its first non-blank line open on one of the
 *  grammar's keys? Asked only of a fence that did not read (splitMessageQuestions). */
function triesFenceGrammar(body: string): boolean {
  const first = body.split(/\r?\n/).find((line) => line.trim() !== "")
  return first !== undefined && FENCE_KEY_LINE.test(first)
}

/** The ids a message's question fences NAME, lowercased, in order: an ask (not a `when:` follow-up, which
 *  lives inside its parent's card and is named by the parent's fence) or a reference — and then the parents
 *  its follow-ups claim from an earlier message (followUpParentsIn). */
export function questionFenceIdsIn(text: string, refused?: ReadonlySet<string>): string[] {
  if (!mayHoldQuestionFence(text)) return []
  const out: string[] = []
  for (const b of questionFenceBlocks(text)) {
    const r = b.read
    if (r.form === "invalid" || isRefused(r, refused)) continue
    if (r.form === "ref" || (r.form === "ask" && !r.when)) out.push(r.id.toLowerCase())
  }
  for (const parent of followUpParentsIn(text, refused)) if (!out.includes(parent)) out.push(parent)
  return out
}

/** The parents a message's `when:` follow-ups CLAIM, lowercased, in order: every `when:` parent that no
 *  fence of this same message asks or references. A follow-up may be written in a LATER message than its
 *  parent while the parent is still open (2026-10-13): the server attaches it under the parent's option and
 *  counts the parent as referenced at that rest. For the surface that makes the follow-up's fence a
 *  reference to its parent — the parent's card moves into this slot, exactly as an `id:`-only fence moves
 *  it, and shows the new branch once the row carries it. A follow-up written WITH its parent (the parent's
 *  own fence, or a follow-up of this message that is itself the parent) claims nothing: that fence places
 *  the card, and this one lives inside it. */
export function followUpParentsIn(text: string, refused?: ReadonlySet<string>): string[] {
  if (!mayHoldQuestionFence(text) || !text.includes("when:")) return []
  const reads = questionFenceBlocks(text).map((b) => b.read)
  const here = new Set(reads.flatMap((r) => (r.form === "invalid" ? [] : [r.id.toLowerCase()])))
  const out: string[] = []
  for (const r of reads) {
    // A follow-up the server REFUSED (its parent was already answered, say) attached to nothing, so it
    // claims nothing: the parent's card stays where it was, and this fence is the code block it is.
    if (r.form !== "ask" || !r.when || isRefused(r, refused)) continue
    const parent = r.when.parent.toLowerCase()
    if (!here.has(parent) && !out.includes(parent)) out.push(parent)
  }
  return out
}

// ---- Orphaned-option self-heal ----
//
// The commonest way a worker's question markup goes wrong (pullfrog-app, 2026-08-25): the ```question
// fence closes right after the question sentence and the lettered options follow OUTSIDE it as ordinary
// markdown. Parsed literally that is a freetext-only card with an inert bullet list under it — the
// options are all there, the human just cannot click them. The intent is unambiguous when the prose
// immediately after the fence opens with a choice list that either STARTS at A/1 under an option-less
// block, or CONTINUES the block's own trailing run (a fence closed mid-list), so the splitter adopts
// that run into the block instead of bouncing the turn back to the worker to rewrite its markup.
function healOrphanedOptions(segments: MessageSegment[]): MessageSegment[] {
  for (let i = 0; i < segments.length - 1; i++) {
    const q = segments[i]
    const p = segments[i + 1]
    if (q.kind !== "question" || p.kind !== "prose") continue
    // A PLACEMENT MARKER has no body for options to be orphaned FROM — its card is drawn from the
    // registered row and its body is discarded — so a lettered list after one is the message's own
    // prose. Adopting it would delete that list from the transcript, silently.
    if (q.registeredId && q.text.trim() === "") continue
    const parsed = parseQuestionBlock(q.text, q.questionKind, q.danger)
    // Which list the prose may legally continue: none absorbed unless the block is option-less (the
    // orphan list must OPEN at A/1) or its body ENDS with its option run (the orphan must continue it).
    // A block whose run is followed by trailing prose or a recommendation line is complete — a list
    // after it is genuinely the message's own.
    let lastId: string | null = null
    if (parsed.options.length > 0) {
      if (parsed.trailingMd !== undefined || parsed.recommendation !== undefined) continue
      const id = optionId(parsed.options[parsed.options.length - 1])
      if (!/^([A-Z]|\d+)$/.test(id)) continue
      lastId = id
    }
    const healed = takeOrphanRun(p.text, lastId)
    if (healed === null) continue
    segments[i] = { ...q, text: q.text.replace(/\s+$/, "") + "\n\n" + healed.run }
    if (healed.rest.trim()) segments[i + 1] = { kind: "prose", text: healed.rest }
    else segments.splice(i + 1, 1)
  }
  return segments
}

// The leading option run of a prose block, if its first non-blank line is an option that legally
// extends `lastId` (null = must open a fresh list at A/1). Walks with the fence parser's tolerances —
// blank lines inside the run, a prose line (a group heading) only when the option after it CONTINUES
// the sequence — and lets a trailing "Recommendation: …" line ride along, since parseQuestionBlock
// knows what to do with one after a run. A fresh list needs ≥2 options (a lone "- A." after a fence is
// too weak a signal to steal from prose); a continuation needs only 1. Null → the prose keeps it all.
function takeOrphanRun(prose: string, lastId: string | null): { run: string; rest: string } | null {
  const lines = prose.split("\n").map((l) => l.replace(/\r$/, ""))
  let start = 0
  while (start < lines.length && lines[start].trim() === "") start++
  if (start >= lines.length || !OPTION_RE.test(lines[start])) return null
  const firstId = lineId(lines[start])
  if (lastId === null ? !isListOrigin(firstId) : !follows(lastId, firstId)) return null
  let end = start
  let prevId = firstId
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j]
    if (OPTION_RE.test(line)) {
      if (!follows(prevId, lineId(line))) break
      prevId = lineId(line)
      end = j
      continue
    }
    if (line.trim() === "") continue
    if (REC_RE.test(line)) {
      end = j
      break
    }
    const next = lines.findIndex((l, k) => k > j && OPTION_RE.test(l))
    if (next === -1 || !follows(prevId, lineId(lines[next]))) break
  }
  const absorbed = lines.slice(start, end + 1)
  const optCount = absorbed.filter((l) => OPTION_RE.test(l)).length
  if (optCount < (lastId === null ? 2 : 1)) return null
  return { run: absorbed.join("\n"), rest: lines.slice(end + 1).join("\n") }
}

// Does this message text carry at least one live ```question block? The cheap membership test behind
// "never collapse an ask out of view" — the queue card's intermediate-summary hides ordinary middle
// messages, but a question is a decision the human owes, not disposable chatter, so a middle message
// that carries one keeps its row. Goes through the real splitter so a QUOTED fence (one inside an outer
// code block) is correctly NOT a question here either.
//
// A QUESTION FENCE counts too (splitMessageQuestions), including a ````question whose context carries a code
// block, which the legacy splitter never sees. That also covers the second or two before the server
// registers the fence's row: the message already asks, so it is not a bare rest (RestedCard).
//
// `refused` (lib/questionFaults) is only ever set on a thread that speaks the question fence, so with it the
// message is read under that grammar: a fence the server refused is a code block, not an ask.
export function hasQuestionBlock(text: string, refused?: ReadonlySet<string>): boolean {
  if (!mayHoldQuestionFence(text)) return false
  if (refused !== undefined && refused.size > 0) return splitMessageQuestions(text, true, refused).some((s) => s.kind === "question")
  return splitQuestionBlocks(text).some((s) => s.kind === "question") || questionFenceIdsIn(text).length > 0
}

// The parsed innards of one ```question block: the context prose (options + trailing recommendation
// removed), the detected answer options as clickable choices, and which option (if any) is recommended.
export interface ParsedQuestion {
  kind: QuestionKind
  danger: boolean
  // A SECRET request (registered via `frizzctl secret`): the free-text box is masked, and what is
  // typed in it never enters the draft store. Only a registered question carries it.
  secret?: boolean
  contextMd: string
  // SUPPORTING markdown under the ask: a ```question fence's body below its `---` (shared
  // question-fence.ts) — a table, a diff, a callout. Drawn under `contextMd` at the card's description
  // strength, so the question still reads as the ask and this as what informs it. Only a registered
  // question asked by a fence carries it.
  detailMd?: string
  // Option labels with any inline "recommended" marker stripped out (the badge conveys it instead).
  options: string[]
  // The recommended options' indices, ascending; empty if none. A pick-ONE question carries at most
  // one. A `multi` may carry several — the set worth ticking — because one chip in a list the human
  // ticks several of reads as "pick only this" (maintainer 2026-10-10). Primary signal: the word
  // "recommended" ON an option line. Legacy fallback: a "Recommendation: X" line whose leading letter
  // matches an option. Empty → no chip; the free-form `recommendation` line (if any) renders as a
  // muted caption instead.
  recommendedIdxs: number[]
  // The rationale shown on the FIRST recommended chip's tooltip — the inline marker's
  // `(recommended: why)` text, or the legacy "Recommendation: …" line when we fell back to letter-matching.
  recommendedNote?: string
  // A legacy "Recommendation: …" line, kept ONLY to drive the muted-caption fallback when it names no
  // matching option. New-style questions mark the option inline and carry no such line.
  recommendation?: string
  // Prose that follows the option run (a worker often adds a "Note: …" footnote AFTER the choices).
  // Rendered BELOW the chips so the options stay answerable instead of the trailing prose swallowing them.
  trailingMd?: string
  // Block markdown belonging to ONE option, parallel to `options`, rendered INSIDE that option's chip,
  // ALWAYS — a multi-line description, a diff, a mockup, the message that would actually be posted.
  // Until 2026-09-01 this was `optionPreviews`, revealed only once the option was PICKED — which put
  // the detail that should inform a choice after the choice (maintainer: "you should just be rendering
  // it as part of the answer before I click on it"). Only a REGISTERED question
  // (lib/registeredQuestion.ts) carries these: a fence's options are one-liners by grammar, and a
  // native tool call has no such field. Absent for the other two producers, so the card is unchanged there.
  optionBodies?: (string | undefined)[]
  // Group headings INSIDE the option run, parallel to `options`: a worker who groups its choices
  // ("Thread / loom family:" over A–C, "Melee family:" over D–F) writes a prose line between them.
  // `optionHeadings[i]` is the prose that introduces option i (undefined for most). Present only when
  // the run actually carries one, so the common case stays a plain option list.
  optionHeadings?: (string | undefined)[]
}

// An option line: an optional markdown list marker (workers write options as `- A. …`), then a single
// uppercase letter or a number, then `.`/`)`, then a space. Matches the frizz worker convention.
const OPTION_RE = /^\s*(?:[-*+]\s+)?([A-Z]|\d+)[.)]\s+\S/
const REC_RE = /^\s*recommendation\b/i

// Strip a leading markdown list marker so the chip shows "A. …" rather than "- A. …".
function optionText(line: string): string {
  return line.trim().replace(/^[-*+]\s+/, "")
}

// An option-looking line's leading identifier, uppercased ("- C. Does …" → "C", "3) Ten" → "3").
function lineId(line: string): string {
  return optionText(line).match(/^([A-Za-z]|\d+)[.)]/)?.[1].toUpperCase() ?? ""
}

// Is `b` the identifier that COMES NEXT after `a` in a choice list ("A"→"B", "1"→"2")? Letters and
// numbers never continue each other.
function follows(a: string, b: string): boolean {
  if (/^\d+$/.test(a)) return /^\d+$/.test(b) && Number(b) === Number(a) + 1
  return /^[A-Z]$/.test(a) && /^[A-Z]$/.test(b) && b.charCodeAt(0) === a.charCodeAt(0) + 1
}

// The only identifiers a choice list can OPEN with. A "list" that starts at C is a fragment of
// something else, not a set of choices.
const isListOrigin = (id: string) => id === "A" || id === "1"

// The inline "recommended" marker — the PRIMARY, single-source-of-truth way a worker flags the
// recommended option: the word "recommended" appearing ON that option's line (no separate letter-matched
// line to drift out of sync). Detection is intentionally permissive (just the word, case-insensitive,
// ignoring surrounding markdown emphasis). Given a match, we (1) mark the option, (2) STRIP the marker so
// the badge — not literal "(recommended)" text — is what shows, and (3) lift any `(recommended: <why>)`
// rationale into a note for the chip tooltip. The documented worker form is a trailing `(recommended)` /
// `(recommended: why)`; the leading/trailing/bare variants below are tolerated so the rule "just write
// recommended" holds. Returns the cleaned label + whether it was flagged + the optional rationale.
const REC_WORD = /(^|[^a-z])recommended([^a-z]|$)/i
// Collapse the doubled space an excision can leave; NON-destructive otherwise (must not eat a label's own
// trailing backtick/emphasis — each marker regex below consumes its own joining separator instead).
function tidyLabel(s: string): string {
  return s.replace(/\s{2,}/g, " ").trim()
}
export function stripRecommendedMarker(label: string): { label: string; recommended: boolean; note?: string } {
  if (!REC_WORD.test(label)) return { label, recommended: false }
  // We only treat the word as a MARKER when it sits in a tag position — parenthesized, emphasized, or a
  // leading/trailing tag. A bare interior "recommended" (e.g. "Use the recommended settings") is genuine
  // option CONTENT: leave it untouched (case 5). This keeps the "just write recommended" rule while
  // refusing to silently rewrite a sentence that merely contains the word.
  //
  // 1) The documented form: a parenthesized/bracketed marker anywhere, with an optional rationale after a
  //    `:`/`,`/`;`/dash — "(recommended)", "(recommended: why)", "(recommended, why)". Consume an optional
  //    preceding separator so no dangling " —" is left.
  const paren = label.match(/\s*[—–-]?\s*[([]\s*[*_`~]*recommended\b(?:\s*[:：,;—–-]\s*([^)\]]*?))?\s*[*_`~]*\s*[)\]]/i)
  if (paren) {
    const note = paren[1]?.trim() || undefined
    return { label: tidyLabel(label.slice(0, paren.index!) + label.slice(paren.index! + paren[0].length)), recommended: true, note }
  }
  // 2) An EMPHASIZED tag anywhere — the **…**/_…_/`…` wrapper marks it as a label, e.g.
  //    "B. **Recommended** — switch to pnpm". Consume an adjacent separator on either side.
  const emph = label.match(/\s*[—–:-]?\s*[*_`~]+recommended\b[*_`~]+\s*[—–:-]?\s*/i)
  if (emph) {
    return { label: tidyLabel(label.slice(0, emph.index!) + " " + label.slice(emph.index! + emph[0].length)), recommended: true }
  }
  // 3) A TRAILING tag — the word at the very END, optionally set off by a separator: "Hold — recommended".
  const trail = label.match(/\s*[—–:-]?\s*recommended\b\s*$/i)
  if (trail && trail.index! > 0) return { label: tidyLabel(label.slice(0, trail.index!)), recommended: true }
  // 4) A LEADING tag SET OFF by a separator (so a "Recommended settings …" sentence is NOT mis-stripped):
  //    "Recommended: use JSON", after any "A." / "1)" id prefix (which we keep).
  const lead = label.match(/^(\s*(?:[A-Za-z]|\d+)[.)]\s*)?[*_`~]*recommended\b[*_`~]*\s*[:：—–-]\s*/i)
  if (lead) {
    const rest = tidyLabel((lead[1] ?? "") + label.slice(lead[0].length))
    if (rest) return { label: rest, recommended: true }
  }
  // 5) The word appears only as interior sentence content — not a marker. Leave the label intact.
  return { label, recommended: false }
}

// Detect the option RUN — a maximal block of lettered/numbered choice lines (`- A. …`), wherever it
// sits in the block: NOT required to be trailing. Workers often follow the choices with a "Note: …"
// footnote (or lead with context), and the old "options must be the last thing" rule then found no run
// and dropped every chip. Now: context = prose BEFORE the run; the run = the chips; prose AFTER the run
// = `trailingMd` (rendered below the chips); a "Recommendation: …" line anywhere after the run is the
// muted rec note. Blank lines WITHIN the run are tolerated. No option run → a freetext-only question.
// The run is then read as a LIST (see below) so a question line that merely LOOKS like an option — the
// numbering workers give their questions across a batch — stays the question.
export function parseQuestionBlock(body: string, kind: QuestionKind, danger = false): ParsedQuestion {
  const lines = body.split("\n").map((l) => l.replace(/\r$/, ""))

  // The candidate run: option lines from `from` on. Blank lines never break it, and neither does a prose
  // line whose NEXT option CONTINUES the sequence — workers group their choices under headings
  // ("Thread / loom family:" over A–C, "Melee family:" over D–F), and ending the run at the heading
  // stranded D–F in the trailing prose as unanswerable text. The id check is what keeps that safe: a
  // second question's list restarts at A, which does not follow C, so the run still ends there. A
  // "Recommendation: …" line always closes the choices.
  const nextOptionAfter = (i: number) => lines.findIndex((l, j) => j > i && OPTION_RE.test(l))
  const scanRun = (from: number): number[] => {
    const run: number[] = []
    for (let i = from; i < lines.length; i++) {
      if (OPTION_RE.test(lines[i])) { run.push(i); continue }
      if (run.length === 0 || lines[i].trim() === "") continue // before the run, or a blank inside it
      if (REC_RE.test(lines[i])) break
      const next = nextOptionAfter(i)
      if (next === -1 || !follows(lineId(lines[run[run.length - 1]]), lineId(lines[next]))) break
    }
    return run
  }

  // Read the candidate run as a LIST, because OPTION_RE alone cannot tell a choice from a line that
  // merely opens with an identifier. When a handoff carries several question blocks, workers number the
  // QUESTION too ("C. Does `brokerTo` imply net access?", "9. How is loopback exposed?") and lead with a
  // numbered plan before the choices — both were chipped as options, leaving the card with no question at
  // all and a freetext row that repeated the last letter. So: walk back from the LAST option while the
  // ids keep counting up; if that trailing sequence opens at A/1 it is the real choice list, and
  // everything above it is question prose. A run whose tail does NOT open a list (a typo'd "A, C", a list
  // that starts at B) is left exactly as it was — never eat a genuine choice to invent a question.
  const listStart = (run: number[]): number => {
    for (let k = run.length - 1; k > 0; k--) {
      if (!follows(lineId(lines[run[k - 1]]), lineId(lines[run[k]]))) {
        return isListOrigin(lineId(lines[run[k]])) ? k : 0
      }
    }
    // A block whose whole content is one bare "3. What should `<tmp>` mean?" is a freetext question in a
    // numbered batch, not a one-item menu — a single choice is never a choice. Needs the marker check: a
    // lone "- A. Approve as-is" IS a (degenerate) option, and prose above it means the question is
    // already there, so only an unmarkered line that opens the block is demoted.
    if (run.length === 1 && !/^\s*[-*+]\s/.test(lines[run[0]]) && !lines.slice(0, run[0]).some((l) => l.trim())) return 1
    return 0
  }

  // Demoting the leading line can consume the whole run ("9. How is loopback exposed?" with the choices
  // below a line of prose, so the run never reached them) — then look for the real list underneath it.
  let optLines: number[] = []
  for (let from = 0; from < lines.length; ) {
    const run = scanRun(from)
    if (run.length === 0) break
    const first = listStart(run)
    if (first < run.length) { optLines = run.slice(first); break }
    from = run[0] + 1
  }

  if (optLines.length === 0) return { kind, danger, contextMd: body, options: [], recommendedIdxs: [] }
  const runStart = optLines[0]
  const runEnd = optLines[optLines.length - 1]

  // PRIMARY recommendation signal: the word "recommended" on an option line. Strip the marker from each
  // label (the badge conveys it) and remember the FIRST flagged option + its inline rationale — or, on
  // a `multi`, every flagged option, since several can be ticked.
  const options: string[] = []
  let recommendedIdxs: number[] = []
  let recommendedNote: string | undefined
  // Prose the run absorbed (a group heading) belongs to the option it introduces, so the chips can carry
  // it as a caption instead of it vanishing between them.
  const optionHeadings: (string | undefined)[] = []
  for (const [k, i] of optLines.entries()) {
    const { label, recommended, note } = stripRecommendedMarker(optionText(lines[i]))
    if (recommended && (kind === "multi" || recommendedIdxs.length === 0)) {
      if (recommendedIdxs.length === 0) recommendedNote = note
      recommendedIdxs.push(options.length)
    }
    options.push(label)
    const between = k === 0 ? [] : lines.slice(optLines[k - 1] + 1, i).filter((l) => l.trim())
    optionHeadings.push(between.length ? between.join("\n") : undefined)
  }

  const trim = (arr: string[]) => {
    let a = 0
    let b = arr.length - 1
    while (a <= b && arr[a].trim() === "") a++
    while (b >= a && arr[b].trim() === "") b--
    return arr.slice(a, b + 1)
  }

  const contextMd = trim(lines.slice(0, runStart)).join("\n")
  // After the run: peel a single legacy "Recommendation: …" line out; the rest is trailing prose.
  let recommendation: string | undefined
  const trailing: string[] = []
  for (const l of lines.slice(runEnd + 1)) {
    if (recommendation === undefined && REC_RE.test(l)) recommendation = l.trim()
    else trailing.push(l)
  }
  const trailingMd = trim(trailing).join("\n") || undefined

  // LEGACY FALLBACK: no inline marker but an old-style "Recommendation: X" line → match it to an option
  // by leading letter. If it names no option, `recommendedIdxs` stays empty and the line renders as the
  // muted caption. New-style questions never reach this branch.
  if (recommendedIdxs.length === 0 && recommendation) {
    const named = recommendedIndex(recommendation, options)
    if (named !== null) {
      recommendedIdxs = [named]
      recommendedNote = recommendation
    }
  }

  return {
    kind, danger, contextMd, options, recommendedIdxs, recommendedNote, recommendation, trailingMd,
    ...(optionHeadings.some(Boolean) ? { optionHeadings } : {}),
  }
}

// Leading markdown emphasis/backticks a worker may wrap an identifier in (`**B**`, `_B_`, `` `B` ``).
// Stripped before we read the letter so the bolded-letter form still resolves to its option.
const EMPHASIS_PREFIX = /^[*_`~\s]+/

// Match a "Recommendation: B — …" line to its option INDEX by the recommendation's leading identifier
// ("B." / "B)" / "2." / a bare "B"), tolerating markdown emphasis the worker wraps the letter in
// (`**B**` was the real-world break: the `*` blocked the letter match and the rec fell back to a muted
// caption instead of chipping option B). Returns null when nothing matches — the caller then keeps the
// free-form recommendation as a muted caption below the chips instead of marking an option.
export function recommendedIndex(recommendation: string | undefined, options: string[]): number | null {
  if (!recommendation) return null
  const m = recommendation
    .replace(/^\s*recommendation\s*:?\s*/i, "") // drop the "Recommendation:" label
    .replace(EMPHASIS_PREFIX, "") // then any emphasis/backticks around the identifier
    // A single letter/number NOT immediately followed by another alphanumeric — so a lone "B" (or "B.",
    // "**B**", "_C_") resolves, but "Approve" does not read as option A. `_` is a word char, so `\b`
    // can't be used here (it would reject "_C_"); the lookahead is the correct boundary.
    .match(/^([A-Za-z]|\d+)(?![A-Za-z0-9])/)
  if (!m) return null
  const id = m[1].toUpperCase()
  const idx = options.findIndex((o) => {
    const om = o.replace(EMPHASIS_PREFIX, "").match(/^([A-Za-z]|\d+)[.)]/)
    return om ? om[1].toUpperCase() === id : false
  })
  return idx === -1 ? null : idx
}

// THE identifier every frizz-built option carries: `A.`, `B.`, … then `AA.` past 26. Options were
// numbered, with the digit keys bound to them, from 2026-10-07 until 2026-10-15, when the maintainer had
// both rolled back: letters read better for multiple choice, and the key mode never made clear which
// question a digit would answer. A worker-written fence keeps whatever it wrote — its text is the
// worker's — and a live card shows its POSITION in the gutter regardless (see splitOptionId).
export function optionLetter(index: number): string {
  let n = index, out = ""
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return `${out}.`
}

// Split an option line into its leading identifier and the rest ("2. SQLite — …" → "2" + "SQLite — …",
// "AA) Ten" → "AA" + "Ten"). The card draws the identifier in the option's gutter rather than inline
// with the label, so the label must arrive without it. No identifier ⇒ `id` undefined, text untouched.
export function splitOptionId(opt: string): { id?: string; rest: string } {
  const m = opt.match(/^\s*([A-Za-z]{1,2}|\d+)[.)]\s+/)
  return m ? { id: m[1].toUpperCase(), rest: opt.slice(m[0].length) } : { rest: opt }
}

// An option's leading identifier ("A. SQLite …" → "A", "3) Ten" → "3"), used to compose a multi-select
// answer as a compact letter list. Falls back to the trimmed option text when there's no lettered/
// numbered prefix (a defensive path — multi options carry ids by convention).
export function optionId(opt: string): string {
  const m = opt.match(/^\s*([A-Za-z]|\d+)[.)]/)
  return m ? m[1].toUpperCase() : opt.trim()
}

// Compose ONE block's final answer string from its selection + freetext — the single source of truth
// shared by the send path and its tests. Single-select: the chosen chip IS the answer while set (text
// left in the box beside it is an unselected draft — every producer clears `chosen` when the box takes
// focus, so a non-null chip means it was picked last); no chip ⇒ the freetext. Multi-select: the
// toggled options' letters in option order ("A, C"), with any freetext appended as color ("A, C — and
// skip the flaky one"); selecting none but typing stays valid (freetext alone). Empty string ⇒ this
// block is unanswered.
export function composeBlockAnswer(block: ParsedQuestion, ans: BlockAnswer): string {
  const text = ans.text.trim()
  if (block.kind === "multi") {
    const joined = (ans.chosenSet ?? [])
      .slice()
      .sort((a, b) => a - b)
      .map((i) => optionId(block.options[i] ?? ""))
      .filter(Boolean)
      .join(", ")
    if (joined && text) return `${joined} — ${text}`
    return joined || text
  }
  return ans.chosen != null ? block.options[ans.chosen] ?? "" : text
}
