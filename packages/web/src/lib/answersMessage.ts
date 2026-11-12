import { ANSWER_CONTINUATION_INDENT, ANSWER_FOLLOW_UP_MARKER, ANSWER_PICK_PREFIX, ANSWER_ROW_ID_PATTERN, BURIED_ANSWERS_HEADER, DISMISSED_ANSWER, SECRET_ANSWER_MASK, isSecretAnswerText, splitAnswersNote } from "@frizz/shared"
import { splitQuestionBlocks, parseQuestionBlock, type MessageSegment } from "./questionBlocks.ts"

// Detect + parse OUR OWN composed-answer format, so a user message that is a multi-block answer renders
// as a structured card (echoing the question component) instead of a flat run-on bubble. The format is
// produced by useLiveAnswering.sendAnswers for a message with >1 question block:
//
//   Answers:
//   1. <answer one>
//   2. <answer two>
//   …
//
// — for EVERY live-ask send, a one-block ask included (see composeAnswerWire). Detection is deliberately
// strict: the FIRST non-empty line must be exactly "Answers:", and the body must be numbered "N. …"
// lines. Anything else returns null and the caller falls back to the plain bubble — degrade safely,
// never lose text.
//
// composeAnswerWire has a SECOND form for a batch that answers a BURIED ask (see parseBuriedAnswersMessage):
//
//   Answers to earlier questions:
//   1. “<question>” → <answer>
//   2. <child arrow> “<follow-up question>” → <answer>
//   3. `<the worker's id>` “<question>” → <answer>
//
// which carries its own questions inline and so needs no lookback pairing at all. `parseAnswersCard`
// is the entry point that accepts either. A row's id (the third shape; a follow-up carries its own after
// its arrow) is there for the WORKER, on a question it asked by fence, and is absent on every other row
// and in every transcript written before 2026-10-13 — so it is read when present and never required.
//
// THAT SECOND FORM HAS A THIRD WRITER, and it is the one this file's shape now has to serve: an answer to
// a REGISTERED question (`frizzctl ask`), composed on the SERVER by questionAnswerMessage because the
// human may have answered while the worker's process was down. It arrives as a frizz WAKE rather than as
// a message the browser sent, and the only thing that makes it read as the human's own answer instead of
// a notification card is that it is written in this form (see Message, which checks for it first). The
// marked rows are that path's: its questions can be a static TREE, which is flat on the wire.

//
// EITHER FORM MAY CARRY A NOTE: what the human typed in the prompt box, sent in the same turn as the
// answers (the box's one Send, 2026-10-11). It sits under its own header line after the rows
// (withAnswersNote), and both parsers cut it off BEFORE reading a row — any line after a row is
// otherwise a continuation of that row's answer, and the note would print inside the last chip.
// `answersNote` hands it to the renderer, which draws it as the human's bubble under the card.

export interface ParsedAnswer {
  n: number
  answer: string
}

// CR/CRLF → LF first: a terminal-injected follow-up arrives carriage-return-separated, which would
// otherwise leave the whole message on one "line" and defeat detection (see the server's normalizer).
const rowsOf = (text: string): string => splitAnswersNote(text.replace(/\r\n?/g, "\n")).answers

/** The note sent with an answers message — "" when there is none, or when `text` is not one. */
export function answersNote(text: string): string {
  if (!text || parseAnswersCard(text) === null) return ""
  return splitAnswersNote(text.replace(/\r\n?/g, "\n")).note
}

// A ParsedAnswer PAIRED with the question it answers — `question` is the originating ```question
// block's context prose (options/recommendation stripped), or undefined when pairing wasn't possible
// (no question message found / count mismatch), in which case the card falls back to numbered rows.
export interface PairedAnswer extends ParsedAnswer {
  question?: string
  // A row the registered path marked with the child arrow: an answer to a FOLLOW-UP, a question that
  // only became live because of the answer on the row above it. Rendered indented under its parent,
  // which is the only place the tree survives — the wire form is flat, because an indented child line
  // reads as a continuation of the previous answer (see questionAnswerMessage).
  followUp?: true
  // The WORKER's own id for the question, when its row carried one (shared answerRowId). The card does
  // not draw it: it is the worker's vocabulary, and the human reads the question restated beside it.
  // It is kept because it is the one thing that tells two rows with the same question and the same
  // answer apart (see answerKey).
  handle?: string
}

const MARKER = /^(\d+)\.\s+(.*)$/

// Fold a continuation line into the row above it, minus the indent the writer put on it (see
// indentAnswerContinuation). A continuation written before the indent existed carries none, and loses
// nothing here — only a line that starts with exactly that indent is trimmed.
function continueAnswer(row: { answer: string }, line: string): void {
  const text = line.startsWith(ANSWER_CONTINUATION_INDENT) ? line.slice(ANSWER_CONTINUATION_INDENT.length) : line
  row.answer = row.answer ? `${row.answer}\n${text}` : text
}

export function parseAnswersMessage(text: string): ParsedAnswer[] | null {
  if (!text) return null
  const lines = rowsOf(text).split("\n")
  // First NON-empty line must be exactly the "Answers:" header.
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i >= lines.length || lines[i].trim() !== "Answers:") return null
  i++

  const out: ParsedAnswer[] = []
  for (; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(MARKER)
    if (m) {
      out.push({ n: Number(m[1]), answer: m[2] })
    } else if (out.length > 0) {
      continueAnswer(out[out.length - 1], line) // an answer that itself spans lines — keep the break
    } else if (line.trim()) {
      // Non-empty, non-numbered content before ANY numbered answer → not our clean format; bail.
      return null
    }
  }

  if (out.length === 0) return null
  for (const a of out) a.answer = a.answer.replace(/\s+$/, "") // trim trailing blank continuation lines
  return out
}

const BURIED_HEADER = BURIED_ANSWERS_HEADER
// The optional child arrow is the FOLLOW-UP marker the registered path writes (questionAnswerMessage). It
// sits OUTSIDE the quotes deliberately: inside them it would read as part of the question the worker
// asked. Built from the shared token rather than written out — no web source may spell either down-right
// arrow (subAgentArrow.test.ts), and this parser must read exactly what the server wrote.
//
// THE OPTIONAL BACKTICKED TOKEN AFTER IT IS THE WORKER'S ID. It is matched only HERE, between the row's
// number and its opening quote, in the id's own grammar — the one stretch of a row no human text reaches:
// an answer starts after the quote-arrow, and its later lines are indented. So a row whose ANSWER reads
// like an id and a quoted question is a row with no id, its answer everything after the first arrow, and
// an old row is read as it always was.
const BURIED_ROW_START = new RegExp(`^(\\d+)\\.\\s+(${ANSWER_FOLLOW_UP_MARKER}\\s+)?(?:\`(${ANSWER_ROW_ID_PATTERN})\`\\s+)?[“"]`)
// The end of a row's quoted question: the FIRST closing quote followed by the arrow. First, so an answer
// carrying its own arrow (`A. draft → review → merge`) keeps everything after the quote.
const BURIED_QUESTION_CLOSE = /[”"]\s+→\s+/

// Parse composeAnswerWire's SELF-DESCRIBING form — the one it emits when any answer in the batch targets
// a BURIED ask (a question the agent scrolled past by continuing to work), where a bare "N." would be
// ambiguous about WHICH turn's question it answers:
//
//   Answers to earlier questions:
//   1. “Should the settings store use SQLite?” → A. SQLite
//
// This form is self-contained: each row quotes its own question, so — unlike the "Answers:" form — it
// needs NO lookback and no block-number correlation. That matters, because a buried batch can answer
// questions from SEVERAL different messages at once, which the numbered lookback (pairAnswersMessage)
// could only ever mislabel. Parsing here rather than there is what lets these rows render as the same
// structured card instead of a raw run-on bubble. Same strict/degrade-safely discipline as above: the
// first non-empty line must be the header verbatim, every row must quote-then-arrow, and anything else
// returns null so the caller keeps the plain bubble.
export function parseBuriedAnswersMessage(text: string): PairedAnswer[] | null {
  if (!text) return null
  const lines = rowsOf(text).split("\n") // CR/CRLF → LF (terminal-injected follow-ups), note cut off
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i >= lines.length || lines[i].trim() !== BURIED_HEADER) return null
  i++

  const out: PairedAnswer[] = []
  // A row whose quoted question has not closed yet. THE QUESTION CAN SPAN LINES: a worker's registered
  // question is stored and restated VERBATIM (questionAnswerMessage), and a question that walks the human
  // through a procedure carries paragraphs — one that ended in an SSH public key on its own line (2026-09-23)
  // made the row span five lines, the single-line row pattern missed it, and the whole answer fell through
  // to frizz's notification card as a broken numbered list, the human's own reply dangling under it as a
  // paragraph of its own. So a row opens at `N. “` and its question runs to the first `” → `, wherever
  // that lands; only the ANSWER half continues line by line as before.
  let open: { n: number; followUp: boolean; handle: string | undefined; lines: string[] } | null = null
  const close = (o: NonNullable<typeof open>, question: string, answer: string): void => {
    const row: PairedAnswer = { n: o.n, answer }
    const q = question.trim()
    if (q) row.question = q
    if (o.followUp) row.followUp = true
    if (o.handle) row.handle = o.handle
    out.push(row)
  }
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (open) {
      // A second row opening before the first closed its quote is checked FIRST: that line carries its
      // own quote-arrow, which would otherwise close the dangling row around the wrong question.
      if (BURIED_ROW_START.test(line)) return null // not our format
      const c = line.match(BURIED_QUESTION_CLOSE)
      if (c) {
        close(open, [...open.lines, line.slice(0, c.index)].join("\n"), line.slice(c.index! + c[0].length))
        open = null
      } else {
        open.lines.push(line)
      }
      continue
    }
    const s = line.match(BURIED_ROW_START)
    if (s) {
      const rest = line.slice(s[0].length)
      const o = { n: Number(s[1]), followUp: Boolean(s[2]), handle: s[3], lines: [] as string[] }
      const c = rest.match(BURIED_QUESTION_CLOSE)
      if (c) close(o, rest.slice(0, c.index), rest.slice(c.index! + c[0].length))
      else open = { ...o, lines: [rest] }
    } else if (out.length > 0) {
      continueAnswer(out[out.length - 1], line) // a multi-line answer's continuation — keep the break
    } else if (line.trim()) {
      return null // non-empty, non-row content before ANY row → not our format
    }
  }

  if (open || out.length === 0) return null // a question that never closed is not a row
  for (const a of out) a.answer = a.answer.replace(/\s+$/, "")
  return out
}

// Either composed-answer form → card rows. The lookback-free entry point, for a caller that renders one
// message without the surrounding list (the sub-agent sheet); list call sites go through pairAllAnswers.
export function parseAnswersCard(text: string): PairedAnswer[] | null {
  return parseBuriedAnswersMessage(text) ?? parseAnswersMessage(text)
}

// THE ROWS THE HUMAN SEES — every row but a dismissal. A dismissed question rides the next answer's
// message because that is the WORKER's only news of it (questionAnswerMessage), but the human already
// said it with the × and needs nothing back. And "next answer" can be several rests later, so the row
// reads as that question coming back: an × from turns ago drew as a fourth answer under three fresh ones
// (maintainer 2026-09-25). The parse keeps the row — the wire is the worker's and the pairing counts
// on it — and only the card leaves it out. A card of nothing but dismissals never reaches here: the
// server composes that as the cancellation wake, a different message, and the human's own send that
// carries nothing else draws as the bubble they typed (userSendShown, below).
// A SECRET's row draws the mask, not the delivery note the worker reads (where the value was put and on
// what terms) — that note is the worker's, and on the human's card it read as noise.
export function answersForDisplay(answers: readonly PairedAnswer[]): PairedAnswer[] {
  return answers
    .filter((a) => a.answer !== DISMISSED_ANSWER)
    .map((a) => (isSecretAnswerText(a.answer) ? { ...a, answer: SECRET_ANSWER_MASK } : a))
}

// WHAT A HUMAN SEND DRAWS AS: its answers card and the text under it. A send whose only rows are
// DISMISSALS is the human's typed message with the questions they × -ed riding above it for the worker
// (the server's pendingDismissals, 2026-11-11). Every one of those rows is hidden from the card
// (answersForDisplay), so it would draw as an empty Answers card over the bubble: the human's own words
// draw as what they typed instead, and as a card again when what they typed is itself an answers wire
// (fenced answers, composed in the browser). A send with no words under its rows keeps them: there is
// nothing else to draw.
export function userSendShown(text: string, answers: PairedAnswer[] | null): { text: string; answers: PairedAnswer[] | null } {
  if (!answers || answersForDisplay(answers).length > 0) return { text, answers }
  const typed = answersNote(text)
  return typed ? { text: typed, answers: parseAnswersCard(typed) } : { text, answers }
}

// One answer's PICKS and NOTE, as the card draws them: each `- [x] ` line the writer put first
// (answerPicksText) is one picked option, and whatever follows the blank line is what the human typed.
// An answer with no such lines — a single pick, free text, every answer written before 2026-10-08 — is
// all note, and draws as the one chip it always was.
export function splitAnswerPicks(answer: string): { picks: string[]; note: string } {
  const lines = answer.split("\n")
  const picks: string[] = []
  while (picks.length < lines.length && lines[picks.length].startsWith(ANSWER_PICK_PREFIX)) {
    picks.push(lines[picks.length].slice(ANSWER_PICK_PREFIX.length))
  }
  if (picks.length === 0) return { picks, note: answer }
  return { picks, note: lines.slice(picks.length).join("\n").trim() }
}

// The minimal structural slice of a transcript message the pairing needs — role/kind/text plus the
// server's display projection — so the function stays pure and testable without the shared schema
// (TranscriptMessage satisfies it).
export interface MsgLike {
  role: string
  kind?: string
  text: string
  displayText?: string
}

// THE HUMAN'S TURN IS READ THROUGH ITS DISPLAY PROJECTION, never the raw record. The raw `text` of an
// answers turn is not only what the human typed: frizz appends its own machine-facing tail to the copy
// the worker receives — the clock note (`⏱ Frizz: the message above arrived 4h9m after your last one…`)
// on any reply landing after a long gap — and the transcript is read from the WORKER's record, so that
// tail is part of `text`. The server strips it into `displayText` (see transcript.ts userDisplayText),
// and the plain bubble renders that. This pairing used to read `text` instead, so the numbered parser
// took the note as a continuation line of the LAST answer and the Answers card printed it under the
// human's chosen option, in their own card (reported 2026-08-25: "the freaking time stamps are still
// showing up in my question answers"). The ask blocks of the ASSISTANT turn keep reading `text` — an
// assistant record never carries a projection, and that is the text the human answered.
const answersText = (m: MsgLike): string => m.displayText ?? m.text

// Does this turn render as the human's own ANSWERS card? Exactly the condition Message branches on,
// exported so a caller that has to know WHO WROTE a turn asks the one question instead of re-deriving
// it — the two must never disagree about a message the chat is already drawing as the human's.
//
// It matters because the REGISTERED path's answer (`frizzctl ask`) is DELIVERED by frizz: it arrives
// as a scheduler wake, since the human may have answered while the worker's process was down. So
// `wake` on its own does not mean "frizz wrote this" — here only the transport is frizz's.
//
// `kind` punctuation is excluded because Message routes an event/reasoning line before the role branch
// ever runs, so such a message can never reach the answers card however its text reads.
export function isAnswersMessage(m: MsgLike): boolean {
  if (m.role !== "user" || m.kind === "event" || m.kind === "reasoning") return false
  return parseAnswersCard(answersText(m)) !== null
}

// One answered question, as a key: what makes two renders of it THE SAME ANSWER. The question text plus
// the answer, because that pair is what the card draws and it is stable across both of the wire's forms
// — and, ahead of them, the worker's id when the row carries one. Two fence-asked questions can share a
// text ("Which path?") and an answer; by text alone the second, still in flight, read as the first one
// already on screen, and its in-flight card stood down. Every writer of an id-carrying row stamps it
// from the same row (nameQuestionAnswer), the prompt box's optimistic bubble included, so the two
// renders of one answer agree on it.
const answerKey = (a: PairedAnswer): string => `${a.handle ?? ""} ${a.question ?? ""} ${a.answer}`

/** WHAT THE IN-FLIGHT ANSWER CARD STILL HAS TO SAY — the rows of `wire` that no message in the
 *  transcript is already drawing. Null when there is nothing left for it to add.
 *
 *  The board hands every surface `answersInFlight`: the answer the human has already sent, composed from
 *  the registry, drawn dimmed at the tail so the seconds before the worker has it are not a hole (see
 *  board.answersInFlight). It is spent by the worker RECEIVING the answer — the newest USER record — and
 *  that is deliberately later than the delivery being handed to a channel.
 *
 *  But the transcript reaches the same bytes FIRST. Frizz's delivery lands in the worker's own queue the
 *  moment it is injected, and Claude Code writes a `queue-operation enqueue` for it — which the transcript
 *  renders as a queued bubble, i.e. as this very Answers card, while `lastUserAt` has not moved because no
 *  user record exists yet. So for the whole length of the turn that was in flight (minutes on a loaded
 *  machine) the human saw their own answer TWICE, in two identical dimmed cards, one in the transcript and
 *  one pinned above the composer (reported 2026-09-01, with a screenshot of both). The same overlap opens
 *  a shorter way whenever a transcript push simply beats the board push that spends the row.
 *
 *  The transcript's copy is the one at its true place in the conversation, so it wins and the pinned card
 *  stands down. Row-wise rather than whole-message, because the board composes ONE message from every
 *  unspent row while the scheduler delivers per BATCH: two answers given in two clicks can be half
 *  delivered, and then the card's job is the half that is not on screen yet — not all of it, and not none.
 *
 *  WHAT IS LEFT HAS TO BE SOMETHING THE CARD DRAWS. The board's message carries a row for every question
 *  the human dismissed since the worker last heard, and the card leaves those out (answersForDisplay).
 *  So answering two questions and then dismissing a third left the dismissal as the only unseen row, and
 *  the tail drew an Answers card with nothing in it (reported 2026-10-19, on a thread whose answers had
 *  reached the worker mid-turn). Dismissal rows still ride along when a real answer is left beside them. */
export function unrenderedAnswers(messages: readonly MsgLike[], wire: string | undefined): PairedAnswer[] | null {
  const rows = wire ? parseAnswersCard(wire) : null
  if (!rows?.length) return null
  const shown = new Set<string>()
  for (const m of messages) {
    if (m.role !== "user" || m.kind === "event" || m.kind === "reasoning") continue
    for (const a of parseAnswersCard(answersText(m)) ?? []) shown.add(answerKey(a))
  }
  const left = rows.filter((a) => !shown.has(answerKey(a)))
  return answersForDisplay(left).length > 0 ? left : null
}

// The ```question blocks of the NEAREST EARLIER ask, looking backward from `index` with the same skip
// discipline as useLiveAnswering: kind:"event"/"reasoning" punctuation and text-less (tool-only) turns
// are scanned past, and so is a prose-only assistant message WITHOUT blocks (a worker often follows its
// ask with a note before the human answers). Null when a text-bearing USER message intervenes (an
// earlier human turn claims anything before it — those questions were already answered) or the list
// starts. The `includes` guard keeps the walk cheap: it now runs for every user message, not just the
// ones already known to carry an "Answers:" header.
function nearestAskBlocks(messages: readonly MsgLike[], index: number): MessageSegment[] | null {
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === "event" || m.kind === "reasoning") continue // punctuation, not a conversation turn
    if (!m.text.trim()) continue // tool-only turn — no narrative to pair with
    if (m.role === "user") return null // an earlier human turn — don't pair across it
    if (!m.text.includes("```question")) continue // interstitial assistant prose — keep looking for the ask
    const blocks = splitQuestionBlocks(m.text).filter((s) => s.kind === "question")
    if (blocks.length > 0) return blocks
  }
  return null
}

const questionOf = (b: MessageSegment): string =>
  b.kind === "question" ? parseQuestionBlock(b.text, b.questionKind, b.danger).contextMd.trim() : ""

// LEGACY single-answer bubbles. Before composeAnswerWire numbered every live send, a ONE-block ask's
// answer went out as bare text with no header at all — so those messages carry no marker to parse and
// there are transcripts full of them. Recover exactly the unambiguous ones: a single-block ask whose
// bare reply is BYTE-IDENTICAL to one of its own option labels, i.e. the human clicked that chip. A
// freeform reply (the "Or skip the questions and reply…" path, or a typed override) matches no option
// and correctly keeps its plain bubble — this must never box an ordinary steer into an Answers card.
function pairBareChipAnswer(text: string, blocks: MessageSegment[]): PairedAnswer[] | null {
  if (blocks.length !== 1) return null // a multi-block ask always numbered its answers — nothing to recover
  const answer = text.trim()
  if (!answer) return null
  const b = blocks[0]
  if (b.kind !== "question") return null
  const parsed = parseQuestionBlock(b.text, b.questionKind, b.danger)
  if (!parsed.options.some((o) => o.trim() === answer)) return null
  const question = parsed.contextMd.trim()
  return [question ? { n: 1, answer, question } : { n: 1, answer }]
}

// Pair an answers-message with the questions it answers. The composed reply targets the ```question
// blocks of the nearest earlier ask (see nearestAskBlocks), so each answer pairs by ITS OWN NUMBER:
// answer `n` ↔ block n (sendAnswers numbers by ORIGINAL block position and filters unanswered blocks,
// so a PARTIAL answer set — "Answers:\n1. A" against a five-block ask — still maps faithfully). An
// out-of-range or non-increasing number means the correlation is unreliable → unpaired rows (never
// mislabel an answer with the wrong question). Returns null when messages[index] isn't an
// answers-message at all — callers fall back to the plain bubble. Unpaired rows keep question undefined
// → the numbered fallback.
export function pairAnswersMessage(messages: readonly MsgLike[], index: number): PairedAnswer[] | null {
  const msg = messages[index]
  if (!msg || msg.role !== "user" || msg.kind === "event") return null
  // The buried form already quotes each question — take it verbatim and skip the lookback entirely
  // (its rows can answer several different messages, which the numbered correlation below can't model).
  const text = answersText(msg)
  const buried = parseBuriedAnswersMessage(text)
  if (buried) return buried
  const answers = parseAnswersMessage(text)
  const blocks = nearestAskBlocks(messages, index)
  if (!answers) return blocks ? pairBareChipAnswer(text, blocks) : null
  if (!blocks) return answers
  // Sanity: numbers must be strictly increasing and within the block range (sendAnswers guarantees
  // both; hand-typed text that violates them gets the safe numbered fallback).
  const sane = answers.every((a, j) => Number.isInteger(a.n) && a.n >= 1 && a.n <= blocks.length && (j === 0 || a.n > answers[j - 1].n))
  if (!sane) return answers
  return answers.map((a) => {
    const q = questionOf(blocks[a.n - 1])
    return q ? { ...a, question: q } : { ...a }
  })
}

// Convenience for the list-map call sites: the pairing for EVERY index in one pass, null at non-answers
// positions. Precomputed where the message list is mapped (a useMemo on the messages identity) so the
// memoized Message's `paired` prop is null — a stable primitive — for every ordinary message, and only
// the (few) answers-messages get a fresh array when the list changes.
export function pairAllAnswers(messages: readonly MsgLike[]): (PairedAnswer[] | null)[] {
  return messages.map((_, i) => pairAnswersMessage(messages, i))
}
