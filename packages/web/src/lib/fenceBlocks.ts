// Parse an assistant message's markdown for ```done / ```awaiting SIGNAL fences so the renderer can
// set each one off as a CARD in place of the raw block (mirrors questionBlocks.ts). Transcripts arrive
// as raw markdown, so the client parses fences itself — through the one rule the server's lastFence parser
// reads too (@frizz/shared signal-fence.ts), so a message draws a card exactly when the server acts on its
// fence. Pure string logic, no DOM — unit-testable.
//
// The signal fence LANGUAGE is the state: `done` = a presentation-only success card (thread lifecycle
// actions live in a stable footer), `awaiting` = a compact parked human/timer handoff. Distinct
// from ```question blocks (their own machinery in questionBlocks.ts) — those never match here.

import { fenceWaitsOnHuman, signalFenceBlocks, signalFenceOf, splitAwaitingFrontmatter, splitDoneFrontmatter, type AwaitingHint, type TranscriptMessage } from "@frizz/shared"
import { awaitingProseBlock } from "./awaitingPresentation.ts"

export type FenceKind = "done" | "awaiting"

export type FenceSegment =
  | { kind: "prose"; text: string }
  | { kind: "fence"; fenceKind: FenceKind; body: string; hints: AwaitingHint[] }

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
//
// ONLY THE FENCE THE MESSAGE SIGNALS WITH IS A CARD (@frizz/shared signalFenceOf), the one the server's
// fold acts on: the last fence not quoted inside a code block, and only when it closes the message. A
// card is a claim — the thread is finished, or parked on this — and drawing one the server never read put
// live tickable steps and a Mark as done on rests the board held as bare (2026-11-11). A message whose
// last fence does not close it draws its fences as the code blocks they are, which is what the worker is
// told it wrote.
//
// An earlier fence in a message that does signal is still the worker's words, so it stays as prose: the
// ledger without the card's claim, the awaiting prose without its machinery. On 2026-11-11 a rest carrying
// a ```done ledger and then an ```awaiting with steps drew a Done card back to back with an Awaiting human
// card, while the server had parked the thread on the steps and ignored the done (maintainer: "It's also
// very weird that it would show up back-to-back with a done card").
export function splitFenceBlocks(text: string): FenceSegment[] {
  const signal = signalFenceOf(text)
  if (!signal) return text.trim() ? [{ kind: "prose", text }] : []
  const segments: FenceSegment[] = []
  let prose = ""
  let lastIndex = 0
  for (const fence of signalFenceBlocks(text).filter((f) => f.start <= signal.start)) {
    prose += text.slice(lastIndex, fence.start)
    lastIndex = fence.end
    const { body, hints } = parseFenceBody(fence.raw, fence.kind)
    if (fence.start !== signal.start) {
      const words = fence.kind === "awaiting" ? awaitingProseBlock(body) ?? "" : body
      if (words.trim()) prose += `\n\n${words}\n\n`
      continue
    }
    if (prose.trim()) segments.push({ kind: "prose", text: prose })
    prose = ""
    segments.push({ kind: "fence", fenceKind: fence.kind, body, hints })
  }
  prose += text.slice(lastIndex)
  if (prose.trim()) segments.push({ kind: "prose", text: prose })
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
// alone. `fenceWaitsOnHuman` (steps or questions) is the predicate the fold stamps `handoffAt` with, so
// this finds the same message; a plain `status: needs_input` report holds nothing. -1 when there is none
// in the page.
export function heldHandoffIndex(messages: readonly Pick<TranscriptMessage, "role" | "kind" | "text">[], before: number): number {
  for (let i = Math.min(before, messages.length) - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "assistant" || m.kind === "event") continue
    if (splitFenceBlocks(m.text).some((seg) => seg.kind === "fence" && seg.fenceKind === "awaiting" && fenceWaitsOnHuman(seg.hints))) return i
  }
  return -1
}
