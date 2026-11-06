import { useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react"
import { Check } from "lucide-react"
import type { AskedOption, RegisteredQuestionView } from "@frizz/shared"
import { useBackDismiss } from "../lib/backDismiss.ts"
import { answerSteps, answerSummary, firstOpenStep, oneLineDescription, plainInline, stepAfter, stepAfterPick, type AnswerStep } from "../lib/answerSheet.ts"
import { useKeyboardInset } from "../lib/keyboardInset.ts"
import { nodeAnswered } from "../lib/registeredQuestion.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { SecretCaption } from "./SecretCaption.tsx"
import { MobileBottomSheet } from "./MobileBottomSheet.tsx"
import { InlineLabel, QUESTION_PROSE, RECOMMENDED_TAG_LINE } from "./PhoneQuestionCards.tsx"
import { RegisteredAnsweringContext, type RegisteredAnswering } from "./RegisteredQuestionCards.tsx"

// ANSWERING REGISTERED QUESTIONS ON A PHONE (mockup v2 §3): a bottom sheet, one question per step, then
// a review step that is the only one that sends. Opened from the bottom bar's "Answer" (ChatView); the
// transcript keeps the questions in view behind it as compact, read-only cards (PhoneQuestionCards).
//
// IT OWNS NO ANSWER STATE. Every pick, toggle and typed answer goes through the thread's ONE
// RegisteredAnswering (the provider ChatView mounts), which is the same state the desktop cards read —
// so the send is the desktop's send (same RPC, same payload, same optimistic settle), and closing the
// sheet halfway keeps everything picked. All the sheet holds is which step is on screen.
//
// A SINGLE-CHOICE TAP ADVANCES. It is the whole saving over the 2026-08-18 sheet's Continue-per-step:
// the tap records the pick and the next step (a follow-up the pick opened, the next question, or the
// review) replaces it at once. A multi-select and a free-text step cannot know when the human is done,
// so they carry Continue. Nothing sends until the review — so a mis-tap never sends by itself, even on
// a thread with one question (that 2026-08-18 reason for "Continue" is kept without its extra tap).
//
// MOUNTED MEANS OPEN, and it takes its own history entry (lib/backDismiss): a phone's Back closes the
// sheet, not the thread under it. Back INSIDE the sheet (the footer's Back) walks the steps instead.
export function RegisteredAnswerSheet({ questions, onClose }: { questions: readonly RegisteredQuestionView[]; onClose: () => void }) {
  const a = useContext(RegisteredAnsweringContext)
  const dismiss = useBackDismiss(onClose)
  const steps = a ? answerSteps(questions, a.answersOf) : []
  // `null` is the review. Opens where the human left off: the first step with nothing staged on it.
  const [at, setAt] = useState<string | null>(() => (a ? firstOpenStep(steps, a.answersOf) : null))
  // A step's free-text row, opened by "Write a different answer…". Per step, so moving on closes it.
  const [writing, setWriting] = useState(false)

  // Every question left the open list (answered in another tab, withdrawn by the worker): nothing to
  // answer, so the sheet goes rather than showing an empty review.
  const empty = questions.length === 0
  useEffect(() => {
    if (empty) dismiss()
  }, [empty, dismiss])

  if (!a || !a.slug || empty) return null
  // A step the list no longer holds (its branch closed under it) falls through to the review.
  const index = at === null ? -1 : steps.findIndex((s) => s.key === at)
  const step = index === -1 ? undefined : steps[index]
  const go = (key: string | null) => {
    setWriting(false)
    setAt(key)
  }

  const position = step ? index : steps.length
  const dots = (
    <span aria-hidden className="flex gap-[5px]">
      {Array.from({ length: steps.length + 1 }, (_, i) => (
        <i key={i} className={`size-[6px] rounded-full ${i <= position ? "bg-fg" : "bg-border-strong"}`} />
      ))}
    </span>
  )

  return (
    <MobileBottomSheet
      title={step ? `Question ${index + 1} of ${steps.length}` : "Review your answers"}
      onRequestClose={() => dismiss()}
      dataAttr="data-answer-sheet"
      footer={
        step ? (
          <StepFooter a={a} step={step} first={index === 0} writing={writing} onBack={() => go(steps[index - 1]?.key ?? step.key)} onNext={() => go(stepAfter(steps, step.key))} />
        ) : (
          <ReviewFooter a={a} onSent={() => dismiss()} />
        )
      }
    >
      <div data-answer-step={step ? step.key : "review"} className="flex items-center gap-2 px-[18px] pb-1 text-[12.5px] text-muted">
        {dots}
        <span>
          {step ? `Question ${index + 1} of ${steps.length}` : "Review"}
          {step && step.depth > 1 && " · follow-up"}
          {step?.spec.danger && <span className="text-danger-soft"> · destructive</span>}
        </span>
      </div>
      {step ? (
        <QuestionStep
          key={step.key}
          a={a}
          step={step}
          writing={writing}
          onWrite={() => setWriting(true)}
          onPick={(optIdx) => {
            const next = stepAfterPick(questions, a.answersOf, step, optIdx)
            // Never a toggle-off: re-tapping the option already kept keeps it and moves on.
            if (a.answerFor(step.q, step.path).chosen !== optIdx) a.onChip(step.q, step.path, false, optIdx)
            go(next)
          }}
        />
      ) : (
        <ReviewStep a={a} steps={steps} onChange={(key) => go(key)} />
      )}
    </MobileBottomSheet>
  )
}

// ── a question step ─────────────────────────────────────────────────────────────────────────────

function QuestionStep({ a, step, writing, onWrite, onPick }: {
  a: RegisteredAnswering
  step: AnswerStep
  writing: boolean
  onWrite: () => void
  onPick: (optIdx: number) => void
}) {
  const html = useMarkdownHtml(step.spec.question)
  // A ```question fence's context below its `---` — the table or diff the human needs to answer cold.
  const contextHtml = useMarkdownHtml(step.spec.context?.trim() ?? "")
  const answer = a.answerFor(step.q, step.path)
  const options = step.spec.options ?? []
  const multi = step.spec.kind === "multi"
  // A free-text answer already typed on a single-choice step (and no chip over it) opens the box, so a
  // step revisited through Back or Change shows what was written rather than a closed row.
  const textOpen = !a.remoteHost && (options.length === 0 || writing || (!multi && answer.chosen === null && answer.text.trim() !== ""))
  return (
    <div data-answer-question>
      <LinkedHtml className={`px-[18px] pb-3 pt-1 text-[17px] font-semibold leading-[23px] text-fg ${QUESTION_PROSE}`} html={html} />
      {/* The context at the card body's scale and strength (`card-md` makes the markdown inherit both), so
          the question above stays the ask. Scrolls sideways rather than widening the sheet: a table is
          the commonest thing a worker puts here. */}
      {contextHtml && (
        <div data-question-context className="card-md min-w-0 overflow-x-auto px-[18px] pb-3 text-fg/75">
          <LinkedHtml className="md-body" html={contextHtml} />
        </div>
      )}
      {options.length > 0 && (
        <div role={multi ? "group" : "radiogroup"} className="border-b border-border">
          {options.map((option, i) => (
            <OptionRow
              key={i}
              option={option}
              multi={multi}
              on={multi ? (answer.chosenSet ?? []).includes(i) : answer.chosen === i}
              onClick={() => (multi ? a.onChip(step.q, step.path, true, i) : onPick(i))}
            />
          ))}
          {!textOpen && !a.remoteHost && (
            <button type="button" data-answer-write onClick={onWrite} className={`${ROW} text-left`}>
              <Mark multi={multi} on={false} dashed />
              <span className="text-[15.5px] font-medium leading-[21px] text-muted">{multi ? "Add a note…" : "Write a different answer…"}</span>
            </button>
          )}
        </div>
      )}
      {textOpen && step.spec.secret && <SecretText a={a} step={step} text={answer.text} />}
      {textOpen && !step.spec.secret && (
        <FreeText
          a={a}
          step={step}
          // Autofocus only when the human asked for the box (the row tap). A free-text QUESTION opening
          // on its own would raise the keyboard over the question before it has been read.
          autoFocus={writing}
          placeholder={options.length === 0 ? "Type your answer…" : multi ? "Add a note…" : "Write a different answer…"}
        />
      )}
    </div>
  )
}

const ROW = "flex w-full items-start gap-3 border-t border-border px-[18px] py-3 outline-none active:bg-hover focus-visible:bg-hover"

function OptionRow({ option, multi, on, onClick }: { option: AskedOption; multi: boolean; on: boolean; onClick: () => void }) {
  const line = oneLineDescription(option.description)
  // A multi-line description (or a legacy `preview`) is the option's rich body — a list, a diff — and
  // it decides the choice, so it renders in full under the label, as the desktop card does.
  const body = [line ? undefined : option.description?.trim(), option.preview?.trim()].filter(Boolean).join("\n\n")
  // A picture in the body — a gallery tile, a Markdown image — is there to be LOOKED AT before choosing:
  // its tap opens the lightbox (its own handler, or lib/local-file-links.ts) and does not also pick the
  // option, as on the desktop card (QuestionBlockCard's Chip).
  const pick = (e: MouseEvent) => {
    if ((e.target as Element).closest("[data-lightbox-tile], img[data-local-path]")) return
    onClick()
  }
  return (
    <button type="button" role={multi ? "checkbox" : "radio"} aria-checked={on} data-answer-option data-on={on || undefined} onClick={pick} className={`${ROW} text-left`}>
      <Mark multi={multi} on={on} />
      <span className="min-w-0 flex-1">
        <span className="block text-[15.5px] font-medium leading-[21px] text-fg">
          <InlineLabel md={option.label} />
          {option.recommended && <span className={`ml-1.5 text-[11px] font-bold ${RECOMMENDED_TAG_LINE} tracking-[0.02em] text-accent`}>RECOMMENDED</span>}
        </span>
        {line && <span className="mt-px block text-[13px] leading-[18px] text-muted">{line}</span>}
        {body && <OptionBody md={body} />}
      </span>
    </button>
  )
}

function OptionBody({ md }: { md: string }) {
  const html = useMarkdownHtml(md)
  // `card-md` puts md-body on the card's 13px scale with an inherited colour, so the body reads muted.
  return <div className="card-md mt-1 text-muted"><LinkedHtml className="md-body" html={html} /></div>
}

/** The radio (single) or checkbox (multi) at the head of a row. A dashed ring is the free-text row.
 *  CENTRED ON THE LABEL'S CAP BAND, by measurement (sans, 15.5px on a 21px line, dsf 8, 2026-09-30): at
 *  `mt-px` the 20px mark's centre sat 0.50px below the centre of the first line's cap ink; `mt-[0.5px]`
 *  measures 0.00 in both themes. The row is `items-start`, so this offset is the whole placement. */
function Mark({ multi, on, dashed = false }: { multi: boolean; on: boolean; dashed?: boolean }) {
  const shape = multi ? "rounded-[5px]" : "rounded-full"
  return (
    <span
      aria-hidden
      className={`mt-[0.5px] flex size-5 shrink-0 items-center justify-center border-[1.5px] ${shape} ${dashed ? "border-dashed" : ""} ${
        on ? (multi ? "border-fg bg-fg text-bg" : "border-fg") : "border-border-strong"
      }`}
    >
      {on && (multi ? <Check size={14} strokeWidth={3} /> : <span className="size-2.5 rounded-full bg-fg" />)}
    </span>
  )
}

function FreeText({ a, step, autoFocus, placeholder }: { a: RegisteredAnswering; step: AnswerStep; autoFocus: boolean; placeholder: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const text = a.answerFor(step.q, step.path).text
  const multi = step.spec.kind === "multi"
  // Auto-grow to the content, as the desktop card's box does (reset to auto first so it can shrink).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [text])
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  return (
    // Under option rows it needs its own air; straight under the question, the question's 12px is it.
    <div className={`px-[18px] ${(step.spec.options ?? []).length === 0 ? "" : "pt-3"}`}>
      <textarea
        ref={ref}
        data-answer-text
        data-1p-ignore
        // The sheet, not the drawer under it, owns this Escape (see ThreadSheet's data-claims-escape).
        data-claims-escape
        // A free-text QUESTION opens with room to write; a "different answer" beside options is one line
        // that grows.
        rows={(step.spec.options ?? []).length === 0 ? 3 : 1}
        value={text}
        placeholder={placeholder}
        onChange={(e) => a.onText(step.q, step.path, multi, e.target.value)}
        // SINGLE: the box taking focus is the human choosing to write instead, and it drops the chip —
        // the producers' shared contract (RegisteredQuestionCards onText), so what the review shows and
        // what the payload carries cannot disagree.
        onFocus={() => {
          if (!multi) a.onText(step.q, step.path, false, text)
        }}
        className="block max-h-[40vh] w-full resize-none overflow-y-auto rounded-[12px] border border-border-strong bg-bg px-3 py-[11px] text-[16px] leading-[22px] text-fg outline-none placeholder:text-faint focus:border-fg/40"
      />
    </div>
  )
}

/** A SECRET step's box: a password field, so the phone keyboard neither predicts nor learns what is
 *  pasted, and its value stays in the answering state's memory (RegisteredQuestionCards). No autofocus,
 *  for the same reason as a free-text question: the keyboard would cover the question. */
function SecretText({ a, step, text }: { a: RegisteredAnswering; step: AnswerStep; text: string }) {
  return (
    <div className="px-[18px]">
      <input
        type="password"
        data-answer-text
        data-secret-answer
        data-claims-escape
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-label="Secret value"
        value={text}
        placeholder="Paste the value…"
        onChange={(e) => a.onText(step.q, step.path, false, e.target.value)}
        className="block w-full rounded-[12px] border border-border-strong bg-bg px-3 py-[11px] text-[16px] leading-[22px] text-fg outline-none placeholder:text-faint focus:border-fg/40"
      />
      <SecretCaption className="mt-2 text-[13px] leading-[18px] text-muted" />
    </div>
  )
}

function StepFooter({ a, step, first, writing, onBack, onNext }: {
  a: RegisteredAnswering
  step: AnswerStep
  first: boolean
  writing: boolean
  onBack: () => void
  onNext: () => void
}) {
  const answer = a.answerFor(step.q, step.path)
  const answered = nodeAnswered(step.spec, answer)
  const options = step.spec.options ?? []
  const typedInstead = step.spec.kind !== "multi" && answer.chosen === null && answer.text.trim() !== ""
  // Continue where a tap cannot mean "done": a multi-select, a free-text question, and a single-choice
  // step the human is writing an answer on instead of picking one.
  const continues = step.spec.kind === "multi" || options.length === 0 || writing || typedInstead
  return (
    <SheetFooter>
      <button type="button" data-answer-back disabled={first} onClick={onBack} className={`${BTN} ${QUIET} disabled:opacity-35`}>
        Back
      </button>
      <span className="flex-1" />
      {/* "Skip" leaves the step as it is; once something is kept on it, the same button is just "Next". */}
      {!(continues && answered) && (
        <button type="button" data-answer-skip onClick={onNext} className={`${BTN} ${QUIET}`}>
          {answered ? "Next" : "Skip"}
        </button>
      )}
      {continues && (
        <button type="button" data-answer-continue disabled={!answered} onClick={onNext} className={`${BTN} ${SOLID} px-6 disabled:opacity-35`}>
          Continue
        </button>
      )}
    </SheetFooter>
  )
}

// ── the review ───────────────────────────────────────────────────────────────────────────────────

function ReviewStep({ a, steps, onChange }: { a: RegisteredAnswering; steps: readonly AnswerStep[]; onChange: (key: string) => void }) {
  const rows = steps.map((s) => ({ s, said: answerSummary(s.spec, a.answerFor(s.q, s.path)) }))
  const count = rows.filter((r) => r.said !== null).length
  return (
    <div data-answer-review>
      <div className="px-[18px] pb-3 pt-1 text-[17px] font-semibold leading-[23px] text-fg">
        {count === 0 ? "No answers yet" : `${count} answer${count === 1 ? "" : "s"}`}
      </div>
      <div className="border-b border-border">
        {rows.map(({ s, said }) => (
          <button key={s.key} type="button" data-answer-change={s.key} onClick={() => onChange(s.key)} className="block w-full border-t border-border px-[18px] py-2.5 text-left outline-none active:bg-hover focus-visible:bg-hover">
            <span className="line-clamp-2 block text-[13px] leading-[18px] text-muted">{plainQuestion(s.spec.question)}</span>
            <span className="mt-0.5 flex items-baseline justify-between gap-2.5">
              <span className={`min-w-0 break-words text-[15.5px] leading-[21px] ${said === null ? "text-muted" : "font-medium text-fg"}`}>{said ?? "Skipped"}</span>
              <span className="shrink-0 text-[13.5px] text-muted">Change</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ReviewFooter({ a, onSent }: { a: RegisteredAnswering; onSent: () => void }) {
  const send = () => {
    // THE ANSWERS GO EXACTLY AS THE DESKTOP SENDS THEM (one answerQuestions call over every staged
    // answer). There is deliberately NO note field here, though the approved mockup drew one: the RPC has
    // no field for it, folding it into an answer's text would change the answer, and sent as a follow-up
    // it RACES the answers — the server stores them and the scheduler delivers them, while a follow-up
    // goes straight to the worker, so the note reached the worker first on a seeded thread. A word about
    // the answers is a reply, which the bar's keyboard button sends after them.
    a.submit()
    // Nothing advances after a send (unlike Done): the worker resumes on this thread.
    onSent()
  }
  return (
    <SheetFooter>
      <button type="button" data-answer-send disabled={a.staged === 0 || a.sending} onClick={send} className={`${BTN} ${SOLID} flex-1 disabled:opacity-35`}>
        {a.sending ? "Sending…" : "Send answers"}
      </button>
    </SheetFooter>
  )
}

// ── chrome ───────────────────────────────────────────────────────────────────────────────────────

const BTN = "flex h-[46px] shrink-0 items-center justify-center rounded-[12px] text-[15.5px] font-semibold outline-none"
const QUIET = "px-[18px] text-muted active:bg-hover focus-visible:bg-hover"
const SOLID = "bg-fg text-bg active:opacity-90"

/** The pinned footer. It rides the software keyboard: a spacer under the buttons, sized to the strip the
 *  keyboard covers (lib/keyboardInset), lifts them above it while a text field is focused — the sheet is
 *  pinned to the layout viewport's bottom, which the keyboard does not move. */
function SheetFooter({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  // MEASURED ONLY WHILE ONE OF THE SHEET'S OWN FIELDS HAS FOCUS — the only time a keyboard can be up
  // over it. Measuring from mount read the sheet mid-slide: it enters at translate-y-full, so its
  // footer's bottom sat a whole sheet below the visible band and the "inset" came back as the sheet's
  // own height, which padded the footer with a sheet of empty space.
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    let frame = 0
    const check = () => {
      cancelAnimationFrame(frame)
      // focusout fires before the next element takes focus; read activeElement once it has settled.
      frame = requestAnimationFrame(() => {
        const el = document.activeElement
        // An <input> too: a secret step's box is a password field.
        setTyping((el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && ref.current?.parentElement?.contains(el) === true)
      })
    }
    check()
    document.addEventListener("focusin", check)
    document.addEventListener("focusout", check)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("focusin", check)
      document.removeEventListener("focusout", check)
    }
  }, [])
  const inset = useKeyboardInset(ref, typing)
  return (
    <div ref={ref} data-answer-footer className="shrink-0">
      <div className="flex items-center gap-2.5 px-[18px] pt-3.5">{children}</div>
      {inset > 0 && <div aria-hidden style={{ height: inset }} />}
    </div>
  )
}

/** The question as one plain line for the review row: its first paragraph, markdown marks dropped. */
function plainQuestion(md: string): string {
  return plainInline(md.trim().split(/\n\s*\n/)[0] ?? "")
}
