// THE RESIDUAL RUNG: the card for a rest that carries NOTHING ELSE. Every other ending has its own card —
// a done (fenced or registered), a question (fenced or registered), a declared or registered wait, a
// native ask, a permission prompt, a limit pause, a provider fault, a human snooze — and a rest that is
// none of those drew nothing: the transcript simply stopped, on the thread page, on /full and on the
// queue card alike, and nothing on the page said whether the worker was finished, waiting or dead
// (maintainer 2026-08-27: "A thread should never come to rest like this without some indication of its
// handoff"; then "always some kind of handoff card that will show up no matter what").
//
// Two shapes reach it. A BARE REST — the worker spoke last, signed nothing off, registered nothing — is
// the one the sign-off nudge exists for (scheduler.evalSignoffNudges), and the card says so in the
// worker's absence. A STALL — the process exited mid-turn (`crashed`) — is not a rest at all, and the
// card says that instead, beside the header's Retry. Both are last in ChatView's chain: every rung above
// is a harder reading of the same slot and wins it.
import { CircleDashed, TriangleAlert } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { splitFenceBlocks } from "../lib/fenceBlocks.ts"
import { hasQuestionBlock } from "../lib/questionBlocks.ts"
import { CARD_BODY, TranscriptCard } from "./TranscriptCard.tsx"

export type RestedCardThread = Pick<
  ThreadView,
  "kind" | "foreign" | "runtime" | "needsYou" | "crashed" | "lastFence" | "questions" | "answersInFlight" | "pendingQuestion" | "pendingAsk" | "pendingInteraction" | "awaitingBackground" | "limitPause" | "providerFault" | "providerError" | "lastAssistantAt"
>

/** Does the chat show the residual card at the bottom of this thread? True only when the thread is at
 *  rest (or has exited) in the human's queue and NO other ending applies — every card-bearing state is
 *  excluded here by name rather than by the chain's ordering, so the row builders' gate (which is an OR
 *  over every rung) opens exactly when this rung renders and never for an empty slot.
 *
 *  `lastAssistantText` is the transcript's own copy of "no ```done, no ```question" in the final message:
 *  the board's `pendingQuestion` and `lastFence` say the same, but the message is what the reader is
 *  looking at, and a card claiming no sign-off directly under a fenced one would be the two disagreeing. */
export function showsRestedCard(thread: RestedCardThread | undefined, lastAssistantText: string | undefined): boolean {
  if (!thread || thread.kind !== "session" || thread.foreign) return false
  if (thread.runtime !== "turn-idle" && thread.runtime !== "exited") return false
  if (thread.needsYou !== true) return false
  if (thread.providerError) return false
  // A stall is the exception to every text check below: the final record is often a tool call with no
  // prose at all, and the card is about the process, not the message.
  if (thread.crashed === true) return true
  if (thread.lastFence || thread.pendingQuestion || (thread.questions?.length ?? 0) > 0) return false
  // AN ANSWER IN FLIGHT IS NOT A BARE REST. The human answered a registered question and the worker has
  // not been handed it yet; the registered-question slot draws their answer for those seconds, and this
  // card claiming nobody signed anything off is both wrong and the louder of the two. The same field
  // carries an autonomy CANCELLATION on its way (arming a stop-hook Goal dismisses the open questions,
  // and the wake telling the worker is coming) — without it this card claimed a bare rest of a thread
  // that had asked, in the seconds after the operator hit save (maintainer 2026-09-02).
  if (thread.answersInFlight) return false
  if (thread.pendingAsk || thread.pendingInteraction || thread.awaitingBackground || thread.limitPause || thread.providerFault) return false
  // Nothing said yet (a thread that has not produced an assistant record) is not a rest to describe.
  if (!thread.lastAssistantAt || lastAssistantText === undefined) return false
  if (splitFenceBlocks(lastAssistantText).some((seg) => seg.kind === "fence")) return false
  if (hasQuestionBlock(lastAssistantText)) return false
  return true
}

export function RestedCard({ thread }: { thread: Pick<ThreadView, "crashed"> }) {
  if (thread.crashed === true) {
    return (
      <TranscriptCard data-rested-card="stalled" icon={TriangleAlert} label="Stalled">
        <p className={CARD_BODY}>The agent's process exited mid-turn. Retry, in the header, re-sends the last message.</p>
      </TranscriptCard>
    )
  }
  return (
    <TranscriptCard data-rested-card="bare" icon={CircleDashed} label="Rested without a sign-off">
      <p className={CARD_BODY}>The worker stopped without a done card, a question or a registered wait. Frizz nudges it for one; a reply here also wakes it.</p>
    </TranscriptCard>
  )
}
