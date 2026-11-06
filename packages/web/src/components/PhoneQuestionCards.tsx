import { createContext, useContext } from "react"
import { Keyboard } from "lucide-react"
import type { RegisteredQuestionView } from "@frizz/shared"
import { useInlineMarkdownHtml, useMarkdownHtml } from "../lib/useMarkdown.ts"
import { optionLetter } from "../lib/questionBlocks.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { useRemoteHost } from "../api/supervisorStatus.ts"
import { questionNeedsMachine } from "../lib/registeredQuestion.ts"

// ON A PHONE THE TRANSCRIPT'S QUESTIONS ARE A READING SURFACE (mockup v2 §3, "The questions in the
// transcript"; the maintainer's 2026-08-17 review: the questions stay visible in the context that
// produced them, and answering slides up in a sheet one question at a time). So each open registered
// question draws here as its number, its text and its option LABELS — no descriptions, no chips, no
// free-text box, no per-card Send. The descriptions live in the sheet (RegisteredAnswerSheet), where a
// thumb-sized row has room for them; the verb that opens it is the bottom bar's "Answer".
//
// The accent is on the numbers and the RECOMMENDED tags and nowhere else (not a card border): the
// accent means "awaiting you", and on this card that is the question and the worker's own pick.
//
// PROVIDED, NOT DETECTED. The phone thread page (ChatView with `phone`) provides this context; every
// registered card under it reads it and draws compactly. Detecting the width inside the card instead
// would also compact the /full page on a narrow window, which keeps the desktop chrome — and its own
// per-card Send — on every width. `numberOf` numbers a question by its place among the thread's open
// questions, so a card placed inside a message and its sibling at the rest still count 1, 2.
export interface PhoneQuestions {
  numberOf: (id: string) => number
}

export const PhoneQuestionsContext = createContext<PhoneQuestions | null>(null)

export function usePhoneQuestions(): PhoneQuestions | null {
  return useContext(PhoneQuestionsContext)
}

/** THE RECOMMENDED TAG ADDS NOTHING TO ITS LABEL'S LINE. It is 11px type set inline on a larger label,
 *  and an inline box that inherits the label's line-height at a smaller font hangs its half-leading
 *  below the label's own: the line grew 1px, so a tagged option row stood 1px taller than its
 *  neighbours — 47 against 46px in the answer sheet (a 22px label line against 21), 25 against 24px in
 *  the list (21 against 20), measured in sans at 390px, 2026-10-13. With no leading of its own the tag
 *  sits inside the label's line and every row of a question is one height. Its baseline does not move
 *  (29.00px from the row's top before and after), and its type is the size it was. Shared by the list
 *  below and the sheet (RegisteredAnswerSheet's OptionRow). */
export const RECOMMENDED_TAG_LINE = "leading-none"

/** Several open registered questions in ONE bordered card, a hairline between each — the mockup's
 *  shape for the questions a rest asked together. A placed card (inside a message) is a list of one. */
export function CompactQuestionList({ questions }: { questions: readonly RegisteredQuestionView[] }) {
  const phone = usePhoneQuestions()
  if (questions.length === 0) return null
  return (
    <div
      data-compact-questions
      className="min-w-0 overflow-hidden rounded-[12px] border border-border-strong bg-panel pb-2.5 text-[14px] leading-5"
    >
      {questions.map((q, i) => (
        <div key={q.id} data-question-id={q.id} className={i > 0 ? "mt-2.5 border-t border-border" : undefined}>
          <CompactQuestion q={q} n={phone?.numberOf(q.id) ?? i + 1} />
        </div>
      ))}
    </div>
  )
}

function CompactQuestion({ q, n }: { q: RegisteredQuestionView; n: number }) {
  const html = useMarkdownHtml(q.spec.question)
  const options = q.spec.options ?? []
  const remoteHost = useRemoteHost()
  return (
    <>
      <div className="flex gap-2 px-3.5 pb-1 pt-[11px] font-semibold">
        <span className="shrink-0 tabular-nums text-accent">{n}</span>
        <LinkedHtml className={`min-w-0 flex-1 ${QUESTION_PROSE}`} html={html} />
      </div>
      {options.map((option, i) => (
        <div key={i} data-compact-option className="flex gap-2 py-0.5 pl-[30px] pr-3.5 text-muted">
          <span className="w-3 shrink-0 font-bold">{optionLetter(i).slice(0, -1)}</span>
          <span className="min-w-0">
            <InlineLabel md={option.label} />
            {option.recommended && <span className={`ml-1 text-[11px] font-semibold ${RECOMMENDED_TAG_LINE} text-accent`}>RECOMMENDED</span>}
          </span>
        </div>
      ))}
      {remoteHost && questionNeedsMachine(q.spec) && <p data-remote-note className="px-3.5 pt-1 text-[13px] text-muted">This question has to be answered on {remoteHost}.</p>}
    </>
  )
}

/** A question's markdown at the SURROUNDING type, not the transcript's prose scale: `md-body` pins its
 *  own 14px/1.7 and outranks any utility here (it is unlayered CSS), so the question is rendered bare —
 *  preflight zeroes a paragraph's margins — with just enough block rhythm for a worker that wrote two
 *  paragraphs or a list. `md-inline` keeps inline code monospace. Shared with the sheet. */
export const QUESTION_PROSE =
  "md-inline break-words [&_p+*]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li+li]:mt-1 [&_pre]:[white-space:var(--code-wrap,pre-wrap)] [&_pre]:overflow-x-auto [&_pre]:text-[0.85em] [&_code]:text-[0.9em] [&_a]:underline"

/** THE BOTTOM BAR'S THIRD STATE (mockup v2 §2–3): on a thread with open questions the resting row is
 *  [keyboard] + "Answer N questions". The keyboard button is for a free reply instead — it switches the
 *  bar back to the prompt and focuses it inside the same tap, which is what makes iOS raise the keyboard
 *  (Composer's PhoneBarApi). Rendered through ThreadComposerBox's `phoneBarOverride`, so it shows only
 *  while the prompt is empty and blurred. */
export function PhoneAnswerBar({ count, onAnswer, onReply }: { count: number; onAnswer: () => void; onReply?: () => void }) {
  return (
    <>
      {onReply && (
        <button
          type="button"
          data-phone-answer-reply
          onClick={onReply}
          aria-label="Write a reply instead"
          title="Write a reply instead"
          className="flex size-[42px] shrink-0 items-center justify-center rounded-full border border-border-strong bg-panel text-fg active:bg-hover"
        >
          <Keyboard aria-hidden size={19} strokeWidth={1.8} />
        </button>
      )}
      <button
        type="button"
        data-phone-answer-open
        onClick={onAnswer}
        className="flex h-[42px] min-w-0 flex-1 items-center justify-center rounded-full bg-fg px-4 text-[15px] font-semibold text-bg active:opacity-90"
      >
        {count > 1 ? `Answer ${count} questions` : "Answer"}
      </button>
    </>
  )
}

/** An option's label as the INLINE markdown it is — a worker writes `SQLite` or **Keep both** in a label
 *  and the desktop chip renders it (QuestionBlockCard's Chip). Printed as text, the phone's sheet and list showed the
 *  backticks and asterisks themselves (2026-10-13; the grammar's own example label has a code span). */
export function InlineLabel({ md }: { md: string }) {
  const html = useInlineMarkdownHtml(md)
  return <LinkedHtml as="span" className="md-inline" html={html} />
}
