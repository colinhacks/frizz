import { joinComposerValue, splitComposerValue } from "./imagePaths.ts"

// INLINE COMMENTS ON THE TRANSCRIPT. Select a passage of something the agent said, leave a comment on
// it, and the comment waits as PENDING, drawn as a highlight over its passage. The next send carries
// every pending comment in the one message: the prompt box's words as a note on top, then each comment
// under a blockquote of the passage it is about, in transcript order (maintainer 2026-10-01: "highlight
// any part of the chat transcript and leave a sort of inline comment that gets kind of staged … send
// everything at once as a unified steer"). The design was settled on two mockup sheets that day
// (ae33ed51b and 72f2176c3, deleted with the other mockups in c4c5eb816): a soft yellow highlight, the
// words in a popover on hover, and the count on the line above the prompt box.
//
// This file is the half with no React in it: what a comment is, where its passage is in the page, and
// the text a send carries. components/TranscriptComments.tsx draws it.
//
// AN ANCHOR IS CHARACTER OFFSETS over one agent message's prose: the text nodes inside its `.md-body`
// blocks, in document order, controls left out (`commentTextNodes`). The prose is HTML React owns, so a
// comment never splices an element into it (a <mark> would be torn out on the next render): the page
// paints a Range over the text that is already there, through the CSS Custom Highlight API. The quote
// rides along with the offsets, so an anchor that no longer lands on its words (the message re-rendered
// differently, a card above it in the same message changed its text) is found again by its words, and
// a passage that is gone altogether still goes out with its quote.

export interface TranscriptComment {
  id: string
  /** The `sourceId` of the agent message the passage is in (its `data-frizz-msg`). */
  sourceId: string
  /** Offsets into that message's prose text (`messageProseText`), end exclusive. */
  start: number
  end: number
  /** The passage, whitespace collapsed to single spaces: what the send quotes. */
  quote: string
  /** The human's words about it. */
  text: string
}

/** Collapse a passage's whitespace the way its quote is stored, so a quote matches the page it came from. */
export function normalizePassage(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

// ── storage: one JSON list per thread, in the draft store (lib/drafts.ts) ───────────────────────────────
// Kept with the prompt box's own draft, so pending comments outlive closing the drawer, a reload and a
// browser restart, and show in every tab with that thread open, exactly as the typed words do.

function isComment(value: unknown): value is TranscriptComment {
  if (!value || typeof value !== "object") return false
  const c = value as Record<string, unknown>
  return (
    typeof c.id === "string" && typeof c.sourceId === "string" && typeof c.quote === "string" && typeof c.text === "string" &&
    Number.isInteger(c.start) && Number.isInteger(c.end) && (c.start as number) >= 0 && (c.end as number) > (c.start as number)
  )
}

export function parseStoredComments(raw: string): TranscriptComment[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter(isComment) : []
  } catch {
    return []
  }
}

export function serializeStoredComments(comments: readonly TranscriptComment[]): string {
  return comments.length ? JSON.stringify(comments) : ""
}

/**
 * Transcript order: by the position of each comment's message in the list the surface draws, then by
 * where in the message its passage starts. A comment whose message is not in the list (paged out, or a
 * message the transcript no longer draws) keeps its place after the ones that are, in the order written.
 */
export function inTranscriptOrder(comments: readonly TranscriptComment[], messages: readonly { sourceId?: string }[]): TranscriptComment[] {
  const position = new Map<string, number>()
  messages.forEach((m, i) => {
    if (m.sourceId !== undefined && !position.has(m.sourceId)) position.set(m.sourceId, i)
  })
  return comments
    .map((comment, written) => ({ comment, written, at: position.get(comment.sourceId) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.at - b.at || (a.at === Number.POSITIVE_INFINITY ? a.written - b.written : a.comment.start - b.comment.start || a.written - b.written))
    .map(({ comment }) => comment)
}

// ── the wire: what the worker reads ─────────────────────────────────────────────────────────────────────
// Plain text in one user message, so every backend carries it and an old client shows readable text: the
// note, then a header naming the count, then one block per comment — the passage as a blockquote (the
// quotation shape ⌘I's selected context already sends, lib/composerContext.ts), a blank line, and the
// comment. The transcript reads it back (`parseSentComments`) and draws it as quotes and comments.

const HEADER_RE = /^Comments on your earlier messages \((\d+)\), each under the passage it is about:$/

export function commentsHeader(n: number): string {
  return `Comments on your earlier messages (${n}), each under the passage it is about:`
}

function quoted(passage: string): string {
  return normalizePassage(passage) ? `> ${normalizePassage(passage)}` : ">"
}

/** The comments as the worker reads them, or "" with none. */
export function commentsWireText(comments: readonly Pick<TranscriptComment, "quote" | "text">[]): string {
  if (!comments.length) return ""
  const blocks = comments.map((c) => `${quoted(c.quote)}\n\n${c.text.trim()}`)
  return `${commentsHeader(comments.length)}\n\n${blocks.join("\n\n")}`
}

/**
 * The prompt box's value with the comments added under its words and above any trailing attachment
 * lines, which other surfaces find by their trailing position (lib/imagePaths.ts). With no comments the
 * value comes back as it was; with no words, the comments are the whole message.
 */
export function buildMessageWithComments(value: string, comments: readonly Pick<TranscriptComment, "quote" | "text">[]): string {
  const wire = commentsWireText(comments)
  if (!wire) return value
  const { prose, attachments } = splitComposerValue(value)
  const body = prose.trim() ? `${prose.trimEnd()}\n\n${wire}` : wire
  return joinComposerValue(body, attachments.map((attachment) => attachment.path))
}

export interface SentComment {
  quote: string
  text: string
}

/**
 * A SENT message's comments, read back off the text `buildMessageWithComments` wrote: the note above
 * them (which may be empty) and each comment with its quote. Strict: anything that does not parse back
 * into exactly as many comments as its header says — a message that merely quotes the header, a comment
 * whose own words open a paragraph with `>` — returns null and keeps its plain-text rendering.
 */
export function parseSentComments(text: string): { note: string; items: SentComment[] } | null {
  const lines = text.split("\n")
  let at = -1
  let count = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = HEADER_RE.exec(lines[i])
    if (match && (i === 0 || lines[i - 1] === "")) {
      at = i
      count = Number(match[1])
      break
    }
  }
  if (at < 0 || count < 1) return null
  const note = lines.slice(0, at).join("\n").trimEnd()
  const rest = lines.slice(at + 1).join("\n")
  if (!rest.startsWith("\n> ") && !rest.startsWith("\n>\n")) return null
  // A block opens on a quote line right after a blank line. Split on that, not on every blank line, so a
  // comment of several paragraphs stays one comment.
  const blocks = rest.slice(1).split(/\n\n(?=>(?: |\n|$))/)
  const items: SentComment[] = []
  for (const block of blocks) {
    const blockLines = block.split("\n")
    let i = 0
    const quote: string[] = []
    for (; i < blockLines.length && blockLines[i].startsWith(">"); i++) quote.push(blockLines[i].replace(/^> ?/, ""))
    if (blockLines[i] !== "") return null
    const comment = blockLines.slice(i + 1).join("\n").trim()
    if (!comment) return null
    items.push({ quote: quote.join(" ").trim(), text: comment })
  }
  if (items.length !== count) return null
  return { note, items }
}

// ── anchors in the page ─────────────────────────────────────────────────────────────────────────────────

/** Marks the root of an agent message whose prose takes comments (ChatView's assistant message). */
export const COMMENTABLE_ATTR = "data-commentable"
/** Marks the comment UI itself, whose text is never part of a passage. */
export const COMMENT_UI_ATTR = "data-comment-ui"

const SKIPPED = `button, [aria-hidden="true"], [${COMMENT_UI_ATTR}], .sr-only`

/** The text nodes a message's anchors count over: its prose, less the controls drawn inside it. */
export function commentTextNodes(message: Element): Text[] {
  const out: Text[] = []
  const doc = message.ownerDocument
  const walker = doc.createTreeWalker(message, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent || !parent.closest(".md-body") || !message.contains(parent.closest(".md-body"))) return NodeFilter.FILTER_REJECT
      return parent.closest(SKIPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    },
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node as Text)
  return out
}

export function messageProseText(message: Element): string {
  return commentTextNodes(message).map((t) => t.data).join("")
}

/** A Range's extent within a message's prose, or null when it covers none of it. */
export function rangeToOffsets(message: Element, range: Range): [number, number] | null {
  let pos = 0
  let start = -1
  let end = -1
  for (const t of commentTextNodes(message)) {
    const len = t.data.length
    if (range.intersectsNode(t)) {
      if (start < 0) start = pos + (range.startContainer === t ? range.startOffset : 0)
      end = pos + (range.endContainer === t ? range.endOffset : len)
    }
    pos += len
  }
  return start < 0 || end <= start ? null : [start, end]
}

export function offsetsToRange(message: Element, start: number, end: number): Range | null {
  let pos = 0
  let started = false
  const range = message.ownerDocument.createRange()
  for (const t of commentTextNodes(message)) {
    const len = t.data.length
    if (!started && start < pos + len) {
      range.setStart(t, start - pos)
      started = true
    }
    if (started && end <= pos + len) {
      range.setEnd(t, end - pos)
      return range
    }
    pos += len
  }
  return null
}

/** Pull a selection's ends in past whitespace, so a triple-click does not quote a trailing newline. */
export function trimOffsets(text: string, [start, end]: [number, number]): [number, number] {
  while (start < end && /\s/.test(text[start])) start++
  while (end > start && /\s/.test(text[end - 1])) end--
  return [start, end]
}

/**
 * Where a quote sits in a text, whitespace-insensitively: the first occurrence at or after `near`, else
 * the first anywhere. Offsets are into `text` itself.
 */
export function findPassage(text: string, quote: string, near = 0): [number, number] | null {
  const needle = normalizePassage(quote)
  if (!needle) return null
  // Map every character of the collapsed text back to its offset in the original.
  const map: number[] = []
  let collapsed = ""
  let space = false
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      space = collapsed.length > 0
      continue
    }
    if (space) {
      collapsed += " "
      map.push(i - 1)
      space = false
    }
    collapsed += text[i]
    map.push(i)
  }
  const nearCollapsed = map.findIndex((offset) => offset >= near)
  let at = nearCollapsed >= 0 ? collapsed.indexOf(needle, nearCollapsed) : -1
  if (at < 0) at = collapsed.indexOf(needle)
  if (at < 0) return null
  return [map[at], map[at + needle.length - 1] + 1]
}

/**
 * The Range a comment paints, in its message as the page draws it now: at its offsets while they still
 * hold its quote, else wherever its quote is found. Null when the message is not on the page or its words
 * are gone from it.
 */
export function resolveComment(message: Element, comment: Pick<TranscriptComment, "start" | "end" | "quote">): Range | null {
  const text = messageProseText(message)
  let offsets: [number, number] | null = [comment.start, comment.end]
  if (comment.end > text.length || normalizePassage(text.slice(comment.start, comment.end)) !== normalizePassage(comment.quote)) {
    offsets = findPassage(text, comment.quote, comment.start)
  }
  return offsets ? offsetsToRange(message, offsets[0], offsets[1]) : null
}
