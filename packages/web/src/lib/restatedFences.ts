// THE RESTING CARD ALREADY SAYS IT (2026-11-12). An earlier ```awaiting fence whose card the live one at
// the tail restates draws nothing.
//
// Two rules keep an earlier fence's card on screen after the thread has moved past it: a fence that handed
// the human steps keeps its card as the record of them, and the newest sign-off keeps its card while later
// quiet rounds pass (ChatView renderText). Neither asked what the RESTING card at the tail was drawing.
// A worker woken by something that changes nothing often rests by pasting its last fence back, and the
// thread then drew the same to-do card twice, one above the fold of the round between them and one below
// it (maintainer 2026-11-12, of a pullfrog-app thread: "it just shows the same question back-to-back with
// one tool call in between"). The to-do list is one list per thread, so the two cards even ticked
// together.
//
// The resting card is the one kept: it carries the thread's live controls (the Snooze, the steps' verbs).
// An earlier fence goes when the resting fence lists every one of its steps, which is the to-do list the
// earlier card was there to show (the more common restatement keeps the steps and rewords the rest: 118
// of 231 consecutive steps fences in one stretch over 12 days, against 39 verbatim), or, for a fence with
// no steps, when the two say the same thing: the same title and the same prose.
//
// Only since the human last came in. Before that, an earlier card answers an earlier message, and a step
// handed again later is a second attempt, not a copy.

import { awaitingFenceTitle, awaitingSteps, type AwaitingHint } from "@frizz/shared"
import { awaitingProseBlock } from "./awaitingPresentation.ts"
import { splitFenceBlocks } from "./fenceBlocks.ts"
import { isHumanTurn, type HumanTurnLike } from "./messagePresentation.ts"

export interface FenceLike {
  body: string
  hints: readonly AwaitingHint[]
}

const fold = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim()

/** Does the resting card say everything `earlier`'s card said? */
export function restatesFence(resting: FenceLike, earlier: FenceLike): boolean {
  const steps = awaitingSteps(earlier.hints)
  const restingSteps = awaitingSteps(resting.hints)
  if (steps.length > 0) {
    const listed = new Set(restingSteps.map(fold))
    return steps.every((step) => listed.has(fold(step)))
  }
  if (restingSteps.length > 0) return false
  const title = fold(awaitingFenceTitle(earlier.hints))
  const prose = fold(awaitingProseBlock(earlier.body))
  if (!title && !prose) return false
  return title === fold(awaitingFenceTitle(resting.hints)) && prose === fold(awaitingProseBlock(resting.body))
}

/** The messages before `cut` (the newest agent message, whose fence the resting card draws already) and
 *  since the human last came in, whose ```awaiting fences the resting card restates, every one. Empty with
 *  no resting fence. */
export function restatedByRestingCard(
  messages: readonly (HumanTurnLike & { text: string })[],
  cut: number,
  resting: FenceLike | undefined,
): ReadonlySet<number> {
  const out = new Set<number>()
  if (!resting) return out
  for (let i = Math.min(cut, messages.length) - 1; i >= 0; i--) {
    const m = messages[i]
    if (isHumanTurn(m)) break
    if (m.role !== "assistant" || m.kind || !m.text.includes("```awaiting")) continue
    const fences = splitFenceBlocks(m.text).filter((s) => s.kind === "fence" && s.fenceKind === "awaiting")
    if (fences.length > 0 && fences.every((f) => f.kind === "fence" && restatesFence(resting, f))) out.add(i)
  }
  return out
}
