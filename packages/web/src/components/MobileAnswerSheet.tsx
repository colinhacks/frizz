import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import type { MessageAnswering, QuestionKind } from "../lib/questionBlocks.ts"
import { QuestionBlockCard } from "./QuestionBlockCard.tsx"

// ANSWERING ON A PHONE — one question at a time, in a sheet that slides up from the bottom.
//
// The mockup's first attempt put a per-question "Answer" button in the transcript that opened a PAGE
// rendering every question at once with a single Send at the bottom, and the maintainer took it apart
// (2026-08-17): "will there be an answer button like that on every question? When you open it up, for
// some reason it's showing you all of the questions. Seems odd, very odd… I think it's nicer to only
// show a single question at a time in that pop-up. It'd also be nicer if it slid up from the bottom,
// the question pane, so it feels more like a modal and less like you are pushing a new page."
//
// So: one step per question, presented as a modal rather than a place you navigate to. The transcript
// keeps the questions in view behind it — read-only, in the context that produced them — which is the
// other half of that review ("you should just be clicking into the thread in order to review the rest
// of the message and the full context, and then answer the questions that way").
//
// IT OWNS NO ANSWER STATE. The chips, the free-text and the send are the SAME `MessageAnswering`
// controller the desktop cards use (lib/answering.ts, scoped to this message), so a phone answer and a
// desktop answer travel the identical path and a half-filled answer survives closing this sheet. All
// this component adds is which block is on screen.
//
// THE VERB IS "CONTINUE" UNTIL THE LAST STEP. With one question in front of you, "Send" would claim the
// whole ask went back when only this answer was kept; the last step is the only one that submits, and
// it is the only one that says so.
export function MobileAnswerSheet({
  blocks,
  answering,
  onClose,
}: {
  blocks: { raw: string; kind: QuestionKind; danger: boolean; bi: number }[]
  answering: MessageAnswering
  onClose: () => void
}) {
  const [step, setStep] = useState(0)
  const [shown, setShown] = useState(false)
  // Slide up on the next frame, exactly as the side sheets do — mounting already-open would skip the
  // transition and read as a jump cut.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  // Escape closes, and stops there: the thread sheet underneath must not also unwind (this is a layer
  // over it, and dismissing both would throw the reader back to the board for one keystroke).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])

  const block = blocks[Math.min(step, blocks.length - 1)]
  if (!block) return null
  const last = step >= blocks.length - 1
  // PORTALED TO THE BODY, and not for tidiness. A `position: fixed` element resolves against the
  // nearest TRANSFORMED ancestor, not the viewport — and this sheet is rendered from inside a message,
  // which sits inside a virtualized transcript that positions its rows with `transform`. Left in place
  // the sheet anchored to the row's window instead of the screen: it floated mid-page with the thread's
  // composer visible and undimmed below it. The portal escapes every transformed ancestor at once.
  return createPortal(
    <div data-mobile-answer-sheet className="fixed inset-0 z-[80] flex flex-col justify-end">
      <button
        aria-label="Close"
        onClick={onClose}
        className={`absolute inset-0 bg-scrim-50 transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
      />
      <div
        className={`relative flex max-h-[86%] flex-col overflow-hidden rounded-t-[14px] border-t border-border-strong bg-panel pb-[env(safe-area-inset-bottom)] shadow-[0_-20px_60px_-10px_var(--sheet-shadow)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
          shown ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="mx-auto mt-[6px] h-[5px] w-[36px] shrink-0 rounded-full bg-muted/35" />
        <div className="flex h-[48px] shrink-0 items-center gap-2 border-b border-border/70 px-3">
          <button onClick={onClose} className="flex h-[44px] items-center px-2 text-[16px] text-fg/85">
            Cancel
          </button>
          <span className="flex-1 text-center text-[15px] font-semibold tracking-[-0.01em] text-fg">
            {blocks.length > 1 ? `Question ${step + 1} of ${blocks.length}` : "Question"}
          </span>
          <span className="flex h-[44px] w-[44px] items-center justify-center">
            {/* Balances the Cancel label so the title is centred on the SHEET, not on what is left of it. */}
            <X size={19} className="opacity-0" aria-hidden />
          </span>
        </div>

        <div data-mobile-answer-body className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <QuestionBlockCard
            key={block.bi}
            raw={block.raw}
            questionKind={block.kind}
            danger={block.danger}
            interactive={{
              answer: answering.answerFor(block.bi),
              onChip: (optIdx, optText) => answering.onChip(block.bi, optIdx, optText),
              onText: (text) => answering.onText(block.bi, text),
              // Enter inside a step ADVANCES rather than sending, so the keyboard path and the button
              // path cannot disagree about what "done with this question" means.
              onSubmit: () => (last ? submit() : setStep((s) => s + 1)),
            }}
          />
        </div>

        <div className="flex shrink-0 flex-col items-center gap-3 border-t border-border/70 px-4 pb-[30px] pt-3">
          {blocks.length > 1 ? (
            <div className="flex items-center gap-1.5">
              {blocks.map((b, i) => (
                <span key={b.bi} className={`size-[6px] rounded-full ${i === step ? "bg-accent" : "bg-muted/35"}`} />
              ))}
            </div>
          ) : null}
          <div className="flex w-full items-center gap-2">
            {step > 0 ? (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="flex h-[50px] shrink-0 items-center justify-center rounded-[14px] border border-border-strong bg-elevated px-5 text-[17px] text-fg active:bg-panel-2"
              >
                Back
              </button>
            ) : null}
            <button
              onClick={() => (last ? submit() : setStep((s) => s + 1))}
              disabled={last ? !answering.anyAnswered || answering.sending : false}
              className="flex h-[50px] flex-1 items-center justify-center rounded-[14px] bg-accent-fill px-5 text-[17px] font-semibold text-on-accent transition-[filter,opacity] active:brightness-90 disabled:opacity-40"
            >
              {last ? (answering.sending ? "Sending…" : "Send answers") : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )

  function submit() {
    answering.onSubmit()
    onClose()
  }
}
