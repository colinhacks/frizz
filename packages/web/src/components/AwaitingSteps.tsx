// THE STEPS on a resting card whose ```awaiting fence hands the human `steps:` (2026-10-03) — things
// only they can perform: a sign-in, an approval, a merge the worker may not make. They ride the fence
// itself rather than a registered row (maintainer 2026-10-03: "I don't think this requires persistently
// registering it. Is there a way to do this just inside of the awaiting card?"), so this is a stratum
// of AwaitingBackgroundCard, not a card of its own.
//
// ONE BOX, AND IT IS ANSWERED LIKE A QUESTION (2026-10-12, maintainer: "The awaiting human block should
// switch over to be a big checkbox that says 'I have completed this.' Once you've checked it you should
// have the ability to submit it as an answer just as you can with any other question"). Ticking the box
// STAGES the answer, as picking an option does; the surface's one send — the prompt box's Send, or Enter
// in it or on the ticked box — carries it with whatever is typed there (lib/stepsAnswer,
// ThreadComposerBox). What reaches the worker is still an ordinary reply, the word `Done`, with the
// human's note under it. Until then the card's Done button sent the word on the click, and a note had to
// follow as a second message.
//
// A surface with no prompt box to send it (a phone thread page, a collapsed queue card) draws the card's
// own Send under the box instead — the same fallback the question cards' "Send answers" keeps.
import { useContext, useId, useRef, useState } from "react"
import { Check } from "lucide-react"
import { STEPS_COMPLETE, STEPS_DONE } from "../lib/awaitingPresentation.ts"
import { shouldSubmitStagedEnter } from "../lib/composerKeyboard.ts"
import { useEagerFollowUp } from "../lib/eagerComposerSubmission.ts"
import { SendScopeContext, usePromptBoxSends } from "../lib/sendScope.tsx"
import { useStepsChecked } from "../lib/stepsAnswer.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { CARD_PRIMARY_ACTION, CardActions, QUEUE_WRAP } from "./TranscriptCard.tsx"

/** The steps as a STEPPER — a numbered marker per step down a rail, which is what the human reads before
 *  ticking the box under them.
 *
 *  A STEPPER, NOT A MARKDOWN LIST (2026-10-12, maintainer: "if this is supposed to be rendering like a
 *  classic to-do stepper, it's not doing that"). Until then the steps were an `<ol>` with decimal
 *  markers, which reads as one more paragraph of the handoff rather than a sequence of acts. The markers
 *  were checkboxes of their own for the same afternoon; the one box under the list replaced them, since a
 *  column of small boxes over a big one asked the reader to tick the same work twice. */
export function StepsList({ steps }: { steps: readonly string[] }) {
  return (
    // One markdown block PER STEP, rather than the steps joined into one markdown string: a step carries
    // its own code span or link, and joined steps would each need re-indenting to stay inside their item.
    //
    // THE SAME PROSE AS THE PARAGRAPH ABOVE IT, in strength and in rhythm. The list sat at full strength
    // under a paragraph at the card's 75% until 2026-10-05, and the maintainer read it as a defect
    // ("the paragraphs looks like they're a slightly lighter color than the text in the ol"): one body
    // is one colour, which is the card's (CardContent). And the gap above the list is the paragraph
    // break the prose itself uses (`--md-step`, which `.card-md .md-body` sets on this very element), not
    // a tighter 8px of its own — the two blocks are one handoff rendered in two pieces.
    <div data-awaiting-steps className={`md-body ${QUEUE_WRAP} mt-[var(--md-step)] first:mt-0`}>
      <ol className="frizz-steps">
        {steps.map((step, i) => <Step key={i} n={i + 1} md={step} />)}
      </ol>
    </div>
  )
}

function Step({ n, md }: { n: number; md: string }) {
  const html = useMarkdownHtml(md)
  return (
    <li className="frizz-step">
      <span className="frizz-step-gutter">
        <span className="frizz-step-line">
          <span data-step-mark className="frizz-step-mark">
            <span className="frizz-step-face"><span className="frizz-step-num" aria-hidden="true">{n}</span></span>
          </span>
        </span>
        <span className="frizz-step-rail" aria-hidden="true" />
      </span>
      <LinkedHtml className="md-body frizz-step-text" html={html} />
    </li>
  )
}

/** The box, and — where no prompt box sends it — its own Send. Drawn only while the thread is resting on
 *  THESE steps, which is the caller's test (AwaitingBackgroundCard `stepsLive`). */
export function StepsComplete({ slug, steps, onReplied, onReplyFailed }: {
  slug: string
  steps: readonly string[]
  /** The queue's optimistic card exit, as for its Snooze; absent off the queue. The prompt box's own
   *  send dissolves the card itself, so these serve the fallback Send alone. */
  onReplied?: () => void
  onReplyFailed?: () => void
}) {
  const [checked, setChecked] = useStepsChecked(slug, steps)
  const sendScope = useContext(SendScopeContext)
  const promptBoxSends = usePromptBoxSends()
  const followUp = useEagerFollowUp(slug)
  const labelId = useId()
  const rowRef = useRef<HTMLDivElement>(null)
  // Latched on the click and released only by a rollback: between the send and the worker's turn
  // starting the card is still on screen, and a second click would send twice.
  const [sent, setSent] = useState(false)
  const sendAlone = () => {
    if (!checked || sent) return
    setSent(true)
    const started = followUp.submit(STEPS_DONE, {
      onOptimistic: () => {
        setChecked(false)
        onReplied?.()
      },
      onRollback: () => {
        setSent(false)
        setChecked(true)
        onReplyFailed?.()
      },
    })
    if (!started) setSent(false)
  }
  return (
    <>
      {/* AN OPTION ROW, in the question cards' own chrome (QuestionBlockCard's Chip): a bordered row that
          takes the selection fill once ticked, with the whole row as the target — "big" is the hit area
          as much as the square. The control is a stretched, empty button over the row, named by the label,
          exactly as a chip's is. `mt-3` sets it off from the steps as a control rather than a sixth step. */}
      <div
        ref={rowRef}
        data-steps-complete
        data-checked={checked}
        // The row is the box's keyboard rest after a mouse tick, as the options grid is a chip's: tabIndex
        // -1, so script reaches it and Tab skips it, and no ring, because the human clicked.
        tabIndex={-1}
        // ENTER ON A TICKED BOX IS THE SURFACE'S SEND — on this row, or on the box holding keyboard focus.
        // A native checkbox in a form submits on Enter and toggles on Space, and until 2026-10-21 the
        // button took Enter as a click and unticked the answer the human had just staged. Unticked, Enter
        // keeps the button's own activation and ticks it: there is nothing of the box's to send yet.
        onKeyDown={(e) => {
          if (!checked || !shouldSubmitStagedEnter({
            key: e.key,
            altKey: e.altKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
            isComposing: e.nativeEvent.isComposing,
            keyCode: e.nativeEvent.keyCode,
          })) return
          e.preventDefault()
          e.stopPropagation()
          if (!sendScope?.composer.run()) sendAlone()
        }}
        className={`${BOX_ROW} outline-none transition-colors ${
          checked ? "border-selection-border bg-selection text-fg" : "border-border text-fg/90 hover:bg-elevated"
        }`}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-labelledby={labelId}
          onClick={(e) => {
            setChecked(!checked)
            // A mouse tick parks focus on the row, so Enter sends right after it — until 2026-10-21 focus
            // stayed on the page body, where Enter reached nothing. Not when the box already holds focus
            // (a keyboard tick keeps its ring), and not out of a text box: a caret there is the human
            // writing the note that rides this answer, and Enter in it sends anyway.
            const active = document.activeElement
            if (active !== e.currentTarget && !isTextEntry(active)) rowRef.current?.focus()
          }}
          onMouseDown={(e) => e.preventDefault()}
          className="absolute inset-0 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        />
        <span
          aria-hidden
          className={`pointer-events-none ${BOX_SQUARE} transition-colors ${
            checked ? "border-accent bg-accent-fill text-on-accent" : "border-control-strong bg-panel"
          }`}
        >
          {checked && <BoxCheck />}
        </span>
        <span id={labelId} className="pointer-events-none ml-2 font-medium">{STEPS_COMPLETE}</span>
      </div>
      {!promptBoxSends && (
        <CardActions data-awaiting-steps-reply>
          <button
            type="button"
            data-steps-send
            disabled={!checked || sent}
            onClick={sendAlone}
            onMouseDown={(e) => e.preventDefault()}
            className={`${CARD_PRIMARY_ACTION} disabled:opacity-40`}
          >
            Send
          </button>
        </CardActions>
      )}
    </>
  )
}

/** THE BOX ON A SETTLED CARD whose rest the human answered with it (lib/stepsAnswer stepsDoneReplies) —
 *  ticked, and no longer a control (maintainer 2026-10-15: "we should have something to indicate that the
 *  awaiting human block … was, in fact, completed. Maybe just leave the checked checkbox in there").
 *
 *  THE SAME ROW, IN THE SETTLED PICK'S TREATMENT: an answered question card keeps its picked option as an
 *  inset row with a soft accent rule (QuestionBlockCard's OptionChip `settledPick`), never the live
 *  selection's fill, which says "staged, not sent yet". The steps' answer is that kind of past pick, so it
 *  wears the same: a 2px left rule, the 1px padding it costs taken back (`pl-[11px]`, as there), and the
 *  square outlined rather than filled. Same box, same height as the live row, so the card does not move
 *  in the frame the send turns one into the other. */
export function StepsCompleted() {
  return (
    <div
      data-steps-completed
      role="checkbox"
      aria-checked="true"
      aria-disabled="true"
      className={`${BOX_ROW} border-border-strong border-l-2 border-l-accent/40 bg-bg/50 pl-[11px] text-fg`}
    >
      <span aria-hidden className={`${BOX_SQUARE} border-control-strong text-fg`}>
        <BoxCheck />
      </span>
      <span className="ml-2 font-medium">{STEPS_COMPLETE}</span>
    </div>
  )
}

function isTextEntry(el: Element | null): boolean {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || (el instanceof HTMLElement && el.isContentEditable)
}

// The row and its square, shared by the live box and the settled one so they cannot drift apart.
const BOX_ROW = "relative mt-3 flex items-center rounded-md border px-3 py-2.5 text-[13px] leading-5"
const BOX_SQUARE = "relative size-[18px] shrink-0 rounded-[4px] border"

function BoxCheck() {
  return (
    <span className="absolute inset-0 flex items-center justify-center">
      <Check size={13} strokeWidth={3} />
    </span>
  )
}
