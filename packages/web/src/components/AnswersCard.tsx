import { ListChecks } from "lucide-react"
import type { PairedAnswer } from "../lib/answersMessage.ts"
import { LinkifiedText } from "./LinkifiedText.tsx"
import { BLOCK_RADIUS, CardContent, CardHead } from "./TranscriptCard.tsx"

// THE HUMAN'S ANSWER, on their own side of the conversation. Three different acts compose the message
// this renders — answering a ```question fence, answering a native ask, and answering a question the
// worker REGISTERED (`mcp__frizz__ask`) — and all three write the one wire form `parseAnswersCard`
// reads, so all three land here rather than in three shapes of bubble.
//
// It lived inside ChatView until 2026-08-27, when the registered path needed it too: that path's answer
// is stored on the server and DELIVERED a moment later, so the seconds in between have to draw the same
// card from the same bytes (RegisteredQuestionStack, board.answersInFlight) or the answer visibly
// disappears and comes back.
export function AnswersCard({ answers, queued, sourceId }: { answers: PairedAnswer[]; queued?: boolean; sourceId?: string }) {
  return (
    <div data-frizz-msg={sourceId} data-answers-card className={`self-end flex w-full max-w-[85%] flex-col items-end ${queued ? "opacity-50" : ""}`}>
      <div className={`w-full min-w-0 ${BLOCK_RADIUS} rounded-br-sm border border-border-strong bg-elevated p-4`}>
        <CardHead icon={ListChecks} label="Answers" />
        <CardContent>
          <div className="flex flex-col gap-2.5">
            {answers.map((a, i) => (
              // A FOLLOW-UP sits under the answer that opened it, behind the same rule every nested
              // question in this app wears (RegisteredQuestionCards). The wire form is flat — an
              // indented line there reads as a continuation of the row above (see questionAnswerMessage)
              // — so this indent is the only place the tree survives into the reading.
              <div key={i} className={a.followUp ? "ml-3 flex flex-col gap-1 border-l border-border pl-3" : "flex flex-col gap-1"}>
                {a.question && (
                  <div title={a.question} className="line-clamp-2 min-w-0 text-[11px] leading-snug text-muted">
                    {a.question}
                  </div>
                )}
                <div className="flex items-start gap-2">
                  {!a.question && (
                    <span className="mt-1.5 shrink-0 text-[10px] uppercase tabular-nums tracking-wide text-muted-70">{a.n}</span>
                  )}
                  {/* Neutral recessed chip — a SETTLED answer, not "awaiting you". The bright yellow accent
                      is reserved solely for the awaiting-you motif (see styles.css); a past choice reads
                      quiet: a darker inset panel with a soft left rule to still mark it as the reply. The
                      12px is the family's CHIP scale (the question card's options), not its 13px body. */}
                  <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-border-strong border-l-2 border-l-accent/40 bg-bg/50 px-2.5 py-1.5 text-[12px] leading-snug text-fg">
                    <LinkifiedText text={a.answer} />
                  </span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </div>
    </div>
  )
}

