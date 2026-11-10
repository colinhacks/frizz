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
import { hasStandingQuestion, questionFencesLive, questionHandles, type ThreadView } from "@frizz/shared"
import { splitFenceBlocks } from "../lib/fenceBlocks.ts"
import { hasQuestionBlock, splitMessageQuestions } from "../lib/questionBlocks.ts"
import { CARD_BODY, TranscriptCard } from "./TranscriptCard.tsx"

export type RestedCardThread = Pick<
  ThreadView,
  "kind" | "foreign" | "runtime" | "needsYou" | "crashed" | "lastFence" | "questions" | "answersInFlight" | "pendingQuestion" | "pendingAsk" | "pendingInteraction" | "awaitingBackground" | "limitPause" | "providerFault" | "providerError" | "lastAssistantAt" | "closedQuestions" | "operatorStopped"
> & {
  /** Which ```question grammar the thread speaks (shared questionFencesLive) — see the last check below. */
  spawnedAt?: ThreadView["spawnedAt"]
}

/** Does the chat show the residual card at the bottom of this thread? True only when the thread is at
 *  rest (or has exited) in the human's queue and NO other ending applies — every card-bearing state is
 *  excluded here by name rather than by the chain's ordering, so the row builders' gate (which is an OR
 *  over every rung) opens exactly when this rung renders and never for an empty slot.
 *
 *  `lastAssistantText` is the transcript's own copy of "no ```done, no ```question" in the final message:
 *  the board's `pendingQuestion` and `lastFence` say the same, but the message is what the reader is
 *  looking at, and a card claiming no sign-off directly under a fenced one would be the two disagreeing. */
export function showsRestedCard(thread: RestedCardThread | undefined, lastAssistantText: string | undefined, refusedFences?: ReadonlySet<string>): boolean {
  if (!thread || thread.kind !== "session" || thread.foreign) return false
  if (thread.runtime !== "turn-idle" && thread.runtime !== "exited") return false
  if (thread.needsYou !== true) return false
  if (thread.providerError) return false
  // A stall is the exception to every text check below: the final record is often a tool call with no
  // prose at all, and the card is about the process, not the message.
  if (thread.crashed === true) return true
  // AN OPEN QUESTION IS THIS REST'S ENDING WHILE IT STANDS, and the server says whether it does (shared
  // hasStandingQuestion; server standingQuestions): from when it was asked or last referenced until the
  // human next types to the thread. Until 2026-10-13 this was worked out HERE from the transcript — the
  // question had to render at the newest rest — so a worker that asked, was woken by a shell finishing
  // and rested again drew "Rested without a sign-off" under a question the board still queued it for.
  // One that no longer stands is not an ending: the human replied past it, and a bare rest after that is
  // a bare rest and says so. Read off the BOARD's rows on purpose: a question the human has just answered
  // stays on them until the board says the worker is running, so the beat between the two never reads as
  // a rest that asked nothing (measured at 25ms on a real worker, 2026-10-12).
  if (thread.lastFence || thread.pendingQuestion || hasStandingQuestion(thread)) return false
  // AN ANSWER IN FLIGHT IS NOT A BARE REST. The human answered a registered question and the worker has
  // not been handed it yet; the registered-question slot draws their answer for those seconds, and this
  // card claiming nobody signed anything off is both wrong and the louder of the two. The same field
  // carries an autonomy CANCELLATION on its way (arming a stop-hook Goal dismisses the open questions,
  // and the wake telling the worker is coming) — without it this card claimed a bare rest of a thread
  // that had asked, in the seconds after the operator hit save (maintainer 2026-09-02).
  if (thread.answersInFlight) return false
  // A PERSON'S STOP: the human ended the turn, so the worker was never given the chance to sign off, and
  // the transcript's own "Turn cancelled." already says what happened.
  if (thread.operatorStopped) return false
  if (thread.pendingAsk || thread.pendingInteraction || thread.awaitingBackground || thread.limitPause || thread.providerFault) return false
  // Nothing said yet (a thread that has not produced an assistant record) is not a rest to describe.
  if (!thread.lastAssistantAt || lastAssistantText === undefined) return false
  if (splitFenceBlocks(lastAssistantText).some((seg) => seg.kind === "fence")) return false
  // A QUESTION FENCE THAT DID NOT READ IS NOT A SIGN-OFF. On a thread that speaks the question fence, a
  // fence that tried the grammar and failed (a missing `kind:`, two recommended options) registers nothing
  // and draws as the code block it is (lib/questionBlocks splitMessageQuestions), so the rest under it IS
  // a bare one, and this card is what says Frizz is nudging the worker. The legacy reader below still
  // counted it whenever it had three backticks at the margin — the same broken fence showed this card with
  // four backticks and hid it with three. A legacy thread keeps the reader its fences were written for.
  //
  // NOR IS ONE THE SERVER REFUSED (`refusedFences`, the final message's own — lib/questionFaults): a fence
  // reusing a spent id, or following a question already answered, asked the human nothing. A fence with
  // no row and no fault yet still counts: the registrar is a second behind, and this card must not flash
  // under a question that is about to become answerable.
  //
  // NOR ONE WHOSE QUESTION CLOSED WITHOUT AN ANSWER (the board's `closedQuestions`): dismissed by the
  // human, cancelled because the thread runs autonomously, or withdrawn by the worker. Nobody is being
  // asked, and the fence draws its question closed (ClosedQuestionCard) — unless an OPEN question carries
  // the same id: a closed question's id may be asked again, and then the newest fence is that new ask.
  if (!questionFencesLive(thread.spawnedAt)) {
    const openNames = new Set((thread.questions ?? []).flatMap((q) => questionHandles(q.spec).map((h) => h.toLowerCase())))
    const closed = (thread.closedQuestions ?? []).filter((q) => !openNames.has(q.handle.toLowerCase()))
    const notAsking = closed.length === 0 ? refusedFences : new Set([...(refusedFences ?? []), ...closed.map((q) => q.handle.toLowerCase())])
    return !splitMessageQuestions(lastAssistantText, true, notAsking).some((seg) => seg.kind === "question")
  }
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
