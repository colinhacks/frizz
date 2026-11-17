import type { ReactNode } from "react"
import { Check, ListChecks } from "lucide-react"
import { answersForDisplay, splitAnswerPicks, type PairedAnswer } from "../lib/answersMessage.ts"
import { LinkifiedText } from "./LinkifiedText.tsx"
import { BLOCK_RADIUS, CardContent, CardHead } from "./TranscriptCard.tsx"

// THE HUMAN'S ANSWER, on their own side of the conversation. Three different acts compose the message
// this renders — answering a ```question fence, answering a native ask, and answering a question the
// worker REGISTERED (`frizzctl ask`) — and all three write the one wire form `parseAnswersCard`
// reads, so all three land here rather than in three shapes of bubble.
//
// It lived inside ChatView until 2026-08-27, when the registered path needed it too: that path's answer
// is stored on the server and DELIVERED a moment later, so the seconds in between have to draw the same
// card from the same bytes (RegisteredQuestionStack, board.answersInFlight) or the answer visibly
// disappears and comes back.
export function AnswersCard({ answers, queued, sourceId }: { answers: PairedAnswer[]; queued?: boolean; sourceId?: string }) {
  return (
    <ReplyCard label="Answers" queued={queued} sourceId={sourceId} data-answers-card>
      <div className="flex flex-col gap-2.5">
        {answersForDisplay(answers).map((a, i) => (
          // A FOLLOW-UP sits under the answer that opened it, behind the same rule every nested
          // question in this app wears (RegisteredQuestionCards). The wire form is flat — an
          // indented line there reads as a continuation of the row above (see questionAnswerMessage)
          // — so this indent is the only place the tree survives into the reading.
          //
          // THE WORKER'S ID FOR THE QUESTION IS NOT DRAWN. A fence-asked question's row carries it
          // on the wire (shared answerRowId) so the worker can tell two same-worded questions
          // apart; the human asked nothing by id, and reads the question restated right here. It
          // stays on the row as an attribute, for a verifier and for whoever inspects the card.
          <div key={i} data-answer-id={a.handle} className={a.followUp ? "ml-3 flex flex-col gap-1 border-l border-border pl-3" : "flex flex-col gap-1"}>
            {a.question && (
              <div title={a.question} className="line-clamp-2 min-w-0 [overflow-wrap:anywhere] text-[11px] leading-snug text-muted">
                {a.question}
              </div>
            )}
            <div className="flex items-start gap-2">
              {!a.question && (
                <span className="mt-1.5 shrink-0 text-[10px] uppercase tabular-nums tracking-wide text-muted-70">{a.n}</span>
              )}
              <AnswerChips answer={a.answer} />
            </div>
          </div>
        ))}
      </div>
    </ReplyCard>
  )
}

/** The frame of a reply the human answered a card with, on their side of the conversation: the Answers
 *  card, and the to-do list's report (AwaitingSteps StepsReportCard). */
export function ReplyCard({ label, queued, sourceId, children, ...data }: { label: string; queued?: boolean; sourceId?: string; children: ReactNode } & { [attr: `data-${string}`]: boolean }) {
  return (
    <div {...data} data-frizz-msg={sourceId} className={`self-end flex w-full max-w-[85%] flex-col items-end ${queued ? "opacity-50" : ""}`}>
      <div className={`w-full min-w-0 ${BLOCK_RADIUS} rounded-br-sm border border-border-strong bg-elevated p-4`}>
        <CardHead icon={ListChecks} label={label} />
        <CardContent>{children}</CardContent>
      </div>
    </div>
  )
}


// Neutral recessed chip — a SETTLED answer, not "awaiting you". The bright yellow accent is reserved
// solely for the awaiting-you motif (see styles.css); a past choice reads quiet: a darker inset panel
// with a soft left rule to still mark it as the reply. The 12px is the family's CHIP scale (the question
// card's options), not its 13px body.
const CHIP = "min-w-0 [overflow-wrap:anywhere] rounded-md border border-border-strong border-l-2 border-l-accent/40 bg-bg/50 px-2.5 py-1.5 text-[12px] leading-snug text-fg"

// A multi-select's answer is SEVERAL picks and maybe a note, so its chip is a checked list — each pick
// on its own line, boxed the way the settled question card checks it (QuestionBlockCard's settled multi
// chip: same box, same classes) — with the note under a hairline. Still ONE chip, because it is one
// question's one answer, like every other row of this card. It was one comma-joined line until
// 2026-10-08, which ran five long labels and the human's note together into a paragraph (see
// answerPicksText).
function AnswerChips({ answer }: { answer: string }) {
  const { picks, note } = splitAnswerPicks(answer)
  if (picks.length === 0) {
    return (
      <span className={`${CHIP} flex-1 whitespace-pre-wrap`}>
        <LinkifiedText text={answer} />
      </span>
    )
  }
  return (
    <div className={`${CHIP} flex flex-1 flex-col`}>
      <ul className="flex flex-col gap-1">
        {picks.map((pick, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span aria-hidden className="mt-px flex h-3.5 w-3.5 shrink-0 self-start items-center justify-center rounded-[3px] border border-control-strong text-fg">
              <Check size={10} strokeWidth={3} />
            </span>
            <span className="min-w-0 flex-1">
              <LinkifiedText text={pick} />
            </span>
          </li>
        ))}
      </ul>
      {note && (
        <div className="mt-1.5 whitespace-pre-wrap border-t border-border pt-1.5">
          <LinkifiedText text={note} />
        </div>
      )}
    </div>
  )
}
