// Parse an assistant message's markdown for ```done / ```awaiting SIGNAL fences so the renderer can
// set each one off as a CARD in place of the raw block (mirrors questionBlocks.ts). Transcripts arrive
// as raw markdown, so the client parses fences itself — the grammar is identical to the fence spec the
// worker writes and the server's lastFence parser: an opening line exactly ```done or ```awaiting, the
// body, then a closing ``` line. Pure string logic, no DOM — unit-testable.
//
// The signal fence LANGUAGE is the state: `done` = a presentation-only success card (thread lifecycle
// actions live in a stable footer), `awaiting` = a compact parked human/timer handoff. Distinct
// from ```question blocks (their own machinery in questionBlocks.ts) — those never match here.

import { awaitingNeedsInput, insideFence, splitAwaitingFrontmatter, splitDoneFrontmatter, type AwaitingHint, type TranscriptMessage } from "@frizz/shared"

export type FenceKind = "done" | "awaiting"

export type FenceSegment =
  | { kind: "prose"; text: string }
  | { kind: "fence"; fenceKind: FenceKind; body: string; hints: AwaitingHint[] }

// Opening fence begins a line: ```done or ```awaiting (NO info-string — the language alone is the
// state), a newline, then the body non-greedily to the next line that is exactly ``` (optional trailing
// spaces). The `m` flag anchors ^/$ to line boundaries; an unterminated opener never matches, so a
// half-written fence degrades to ordinary prose (markdown renders it as a plain code block). ```question
// can't match the (done|awaiting) alternation, so question blocks are left entirely to questionBlocks.ts.
const FENCE_BLOCK = /^```(done|awaiting)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm

// Split the body of a fence into its prose (hint lines removed) and its parsed hints. A `done` fence
// carries one hint at most — an optional leading `title:`, the card's heading (2026-10-13) — and the
// rest of it is prose.
//
// ONE PARSER, IN @frizz/shared, AND THIS IS WHY. This file used to carry its own copy of the grammar with
// a comment on it saying "THIS LIST MUST MATCH THE TAILER'S … keep them in step". The 2026-08-24 YAML
// cutover moved the tailer and not this, so a correct current-grammar fence parked correctly on the
// server and rendered `shells: [bzvtnt3ig]` as PROSE in the in-chat card — the raw frontmatter printed at
// the human, which is the exact bug class that comment was written to prevent. A comment cannot keep two
// implementations in step; having one implementation can.
//
// THIS CALL IS WHY THE `yaml` PACKAGE IS IN THE ENTRY CHUNK, and it is not the barrel's doing.
// Measured 2026-09-04 by building three ways: yaml stubbed out costs 97,450 bytes of the entry chunk;
// with this one call removed and the barrel's `import … from "yaml"` left exactly as it is, rolldown
// tree-shakes 66,095 of those away by itself. So a perf pass that moves the export out of @frizz/shared
// into its own module buys nothing while ChatView, RestedCard and registeredDone.ts still call
// splitFenceBlocks synchronously during render. The only way to get the bytes back is to stop needing
// the parse in the browser — and a LAZY parse is not it: the degraded return before the module lands
// prints the raw frontmatter at the human, which is the exact bug the paragraph above exists to end.
export function parseFenceBody(raw: string, kind: FenceKind): { body: string; hints: AwaitingHint[] } {
  if (kind === "done") return splitDoneFrontmatter(raw)
  return splitAwaitingFrontmatter(raw)
}

// Split an assistant message's markdown into prose runs and signal-fence blocks, in document order.
// Prose runs that are whitespace-only are dropped (a fence never leads/trails with an empty prose slot).
export function splitFenceBlocks(text: string): FenceSegment[] {
  const segments: FenceSegment[] = []
  // A fence nested inside another code fence is being QUOTED (a worker showing the human what a ```done
  // block looks like), so it stays in the prose run and renders as the code block it is — see the same
  // guard in questionBlocks.ts.
  const quoted = insideFence(text)
  let lastIndex = 0
  FENCE_BLOCK.lastIndex = 0
  for (let m = FENCE_BLOCK.exec(text); m !== null; m = FENCE_BLOCK.exec(text)) {
    if (quoted(m.index)) {
      FENCE_BLOCK.lastIndex = m.index + 1
      continue
    }
    const prose = text.slice(lastIndex, m.index)
    if (prose.trim()) segments.push({ kind: "prose", text: prose })
    const fenceKind = m[1] as FenceKind
    const { body, hints } = parseFenceBody(m[2], fenceKind)
    segments.push({ kind: "fence", fenceKind, body, hints })
    lastIndex = m.index + m[0].length
  }
  const rest = text.slice(lastIndex)
  if (rest.trim()) segments.push({ kind: "prose", text: rest })
  return segments
}

// True when a message carries at least one signal fence — the cheap check ChatView uses to decide a
// message renders a fence card rather than the raw block. Goes through the splitter so a QUOTED fence
// (one nested in a code block) can never answer yes.
export function hasFence(text: string): boolean {
  return splitFenceBlocks(text).some((s) => s.kind === "fence")
}

// THE HANDOFF A QUIET PARK COULD NOT TAKE BACK (ThreadView.heldHandoff, server board handoffStands): the
// newest agent message before `before` whose ```awaiting fence handed the rest to the human. Every fence
// before the last agent message is otherwise drawn as settled (ThreadSurface hidesAwaiting), which hid the
// very handoff the board was holding the thread in the queue for: the card showed the later quiet park
// alone. `awaitingNeedsInput` is the predicate the fold stamps `handoffAt` with, so this finds the same
// message. -1 when there is none in the page.
export function heldHandoffIndex(messages: readonly Pick<TranscriptMessage, "role" | "kind" | "text">[], before: number): number {
  for (let i = Math.min(before, messages.length) - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "assistant" || m.kind === "event") continue
    if (splitFenceBlocks(m.text).some((seg) => seg.kind === "fence" && seg.fenceKind === "awaiting" && awaitingNeedsInput(seg.hints) === true)) return i
  }
  return -1
}
