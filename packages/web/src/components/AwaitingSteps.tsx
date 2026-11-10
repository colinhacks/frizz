// THE HUMAN'S TO-DO LIST (2026-11-09, maintainer: "a checklist component for the awaiting human stuff.
// The user can indicate which things they've completed and which ones they haven't, and it's a single,
// coherent, human-facing to-do list for the entire session"). One box per step, and no other control.
//
// It replaced a numbered stepper over ONE box, "I have completed this" (2026-10-12), which could say only
// all or nothing and forgot itself at every new fence. The list itself is the server's (human-todos.ts),
// and the ticks and what a send says are lib/stepsAnswer.
//
// Three shapes of it live here: the resting card's (LiveSteps), the flat one every other surface lists
// (HumanTodoList: the panel over the prompt box, the full-screen rail, the phone's ⋯ sheet), and the
// settled card's record of one past rest, whose boxes are not controls (StepsList).
import { useContext, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import { Check } from "lucide-react"
import type { AwaitingStep, HumanTodo } from "@frizz/shared"
import { shouldSubmitStagedEnter } from "../lib/composerKeyboard.ts"
import { useEagerFollowUp } from "../lib/eagerComposerSubmission.ts"
import { SendScopeContext, usePromptBoxSends } from "../lib/sendScope.tsx"
import { tickHumanTodo, useHumanTodos, useStepsAnswer, type StepsReply } from "../lib/stepsAnswer.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { CARD_PRIMARY_ACTION, CardActions, QUEUE_WRAP } from "./TranscriptCard.tsx"

type TodoThread = { readonly id: string; readonly humanTodos?: readonly HumanTodo[] }

// THE FRAME EVERY SHAPE SHARES, `md-body` so a step's code span and link read as they do in the prose
// above it, in the prose's own colour (maintainer 2026-10-05: "the paragraphs looks like they're a
// slightly lighter color than the text in the ol"). The gap above is the paragraph break the prose uses
// (`--md-step`), so the two read as one handoff in two pieces.
const LIST_FRAME = `md-body ${QUEUE_WRAP} mt-[var(--md-step)] first:mt-0`

/** The record of one past rest: the steps as that rest listed them, ticked as its reply said. */
export function StepsList({ steps, done }: { steps: readonly AwaitingStep[]; done?: StepsReply | null }) {
  return (
    <div data-awaiting-steps className={LIST_FRAME}>
      <ul className="frizz-todos">
        {steps.map((step, i) => <RecordRow key={i} step={step} done={done === "all" || done?.has(step.text) === true} />)}
      </ul>
    </div>
  )
}

// A STEP'S BODY (2026-11-09, maintainer: "a full Markdown body that renders underneath each item"), in the
// title's column. It is how to do the act, so it stays while the act is owed or its tick is still the
// human's to send — a tick never moves the rows under the pointer — and folds once the worker has heard
// it was done, leaving the title as the record.
function StepBody({ md }: { md: string }) {
  const html = useMarkdownHtml(md)
  return <LinkedHtml className="md-body frizz-todo-body" html={html} />
}

function RecordRow({ step, done }: { step: AwaitingStep; done: boolean }) {
  const html = useMarkdownHtml(step.text)
  const labelId = useId()
  return (
    <li data-human-todo data-done={done} className="frizz-todo">
      <span role="checkbox" aria-checked={done} aria-disabled="true" aria-labelledby={labelId} className={boxClass(done, false)}>
        {done && <BoxCheck />}
      </span>
      <div className="min-w-0">
        {/* The title alone labels the box: the body is how to do it, not its name. */}
        <div id={labelId}><LinkedHtml className="md-body frizz-todo-text" html={html} /></div>
        {step.body && !done && <StepBody md={step.body} />}
      </div>
    </li>
  )
}

function TodoRow({ slug, todo, onTicked }: { slug: string; todo: HumanTodo; onTicked?: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const html = useMarkdownHtml(todo.text)
  const labelId = useId()
  return (
    <li data-human-todo data-done={todo.done} data-staged={todo.staged} className="frizz-todo">
      <span className={boxClass(todo.done, todo.staged)}>
        {todo.done && <BoxCheck />}
        {/* Only the box is the control: the text holds links to follow and commands to select. The
            button hangs past the box so a 16px square is not a 16px target. */}
        <button
          type="button"
          role="checkbox"
          aria-checked={todo.done}
          aria-labelledby={labelId}
          onClick={(event) => {
            tickHumanTodo(slug, todo.id, !todo.done)
            onTicked?.(event)
          }}
          onMouseDown={(event) => event.preventDefault()}
          className="absolute -inset-[5px] rounded-md outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        />
      </span>
      <div className="min-w-0">
        <div id={labelId}><LinkedHtml className="md-body frizz-todo-text" html={html} /></div>
        {todo.body && (!todo.done || todo.staged) && <StepBody md={todo.body} />}
      </div>
    </li>
  )
}

/** The list on its own, where nothing but the list is the point. `sends` draws a Send under it, for the
 *  one such surface with no prompt box in reach: the phone's sheet. */
export function HumanTodoList({ thread, sends }: { thread: TodoThread; sends?: boolean }) {
  const todos = useHumanTodos(thread)
  return (
    <div data-human-todo-list className={LIST_FRAME}>
      <ul className="frizz-todos">
        {todos.map((todo) => <TodoRow key={todo.id} slug={thread.id} todo={todo} />)}
      </ul>
      {sends && <StepsSend thread={thread} />}
    </div>
  )
}

/** The resting card's list. What was finished at an earlier rest folds away, because what matters on this
 *  card is what the human does next (maintainer 2026-10-15: "All that really matters is what the human is
 *  supposed to do next"), and it stays one click off because this is still the whole session's list.
 *
 *  A surface with no prompt box to send it (a phone thread page, a collapsed queue card) draws the card's
 *  own Send under it, the same fallback the question cards keep. */
export function LiveSteps({ thread, onReplied, onReplyFailed }: {
  thread: TodoThread
  /** The queue's optimistic card exit, as for its Snooze; absent off the queue. The prompt box's own
   *  send dissolves the card itself, so these serve the fallback Send alone. */
  onReplied?: () => void
  onReplyFailed?: () => void
}) {
  const todos = useHumanTodos(thread)
  const { staged } = useStepsAnswer(thread)
  const sendScope = useContext(SendScopeContext)
  const promptBoxSends = usePromptBoxSends()
  const sendAlone = useSendAlone(thread, onReplied, onReplyFailed)
  const frame = useRef<HTMLDivElement>(null)
  const [showEarlier, setShowEarlier] = useState(false)
  const earlier = todos.filter((todo) => todo.done && !todo.staged)
  const current = todos.filter((todo) => !todo.done || todo.staged)

  // ENTER ON A TICKED BOX IS THE SURFACE'S SEND, as on a ticked option. Enter on an open box keeps the
  // button's own activation and ticks it, and a link keeps its own Enter.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!staged || !shouldSubmitStagedEnter({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
    })) return
    const target = event.target as Element
    if (target.closest("a") || target.closest("button[aria-expanded]")) return
    if (target.closest("button[role=checkbox]")?.getAttribute("aria-checked") === "false") return
    event.preventDefault()
    event.stopPropagation()
    if (!sendScope?.composer.run()) sendAlone()
  }
  // A mouse tick parks focus on the list, so Enter sends right after it. Not when the box already holds
  // focus (a keyboard tick keeps its ring), and not out of a text box: a caret there is the human writing
  // the note that rides this answer.
  const onTicked = (event: MouseEvent<HTMLButtonElement>) => {
    const active = document.activeElement
    if (active !== event.currentTarget && !isTextEntry(active)) frame.current?.focus()
  }
  // The server hands the steps over with the fence, so this is only a server older than the list.
  if (todos.length === 0) return null
  return (
    <>
      <div ref={frame} data-awaiting-steps tabIndex={-1} onKeyDown={onKeyDown} className={`${LIST_FRAME} outline-none`}>
        {earlier.length > 0 && (
          <button
            type="button"
            data-todos-earlier
            aria-expanded={showEarlier}
            onClick={() => setShowEarlier((shown) => !shown)}
            onMouseDown={(event) => event.preventDefault()}
            className="mb-2 block rounded text-[12px] leading-[18px] text-muted-70 outline-none hover:text-fg/85 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
          >
            {showEarlier ? "Hide completed" : `Show ${earlier.length} completed`}
          </button>
        )}
        <ul className="frizz-todos">
          {showEarlier && earlier.map((todo) => <TodoRow key={todo.id} slug={thread.id} todo={todo} onTicked={onTicked} />)}
          {current.map((todo) => <TodoRow key={todo.id} slug={thread.id} todo={todo} onTicked={onTicked} />)}
        </ul>
      </div>
      {!promptBoxSends && <SendBar staged={staged} send={sendAlone} />}
    </>
  )
}

// The phone's ⋯ sheet. It is not a card, and CardActions' band is cut to a card's padding, so it stopped
// short of the sheet's edges: this is the sheet's own submit, the one its Snooze has.
function StepsSend({ thread }: { thread: TodoThread }) {
  const { staged } = useStepsAnswer(thread)
  const send = useSendAlone(thread)
  return (
    <button
      type="button"
      data-steps-send
      disabled={!staged}
      onClick={send}
      className="mt-3.5 flex h-[46px] w-full items-center justify-center rounded-xl bg-fg text-[15.5px] font-semibold text-bg outline-none disabled:opacity-45"
    >
      Send
    </button>
  )
}

function SendBar({ staged, send }: { staged: boolean; send: () => void }) {
  return (
    <CardActions data-awaiting-steps-reply>
      <button
        type="button"
        data-steps-send
        disabled={!staged}
        onClick={send}
        onMouseDown={(event) => event.preventDefault()}
        className={`${CARD_PRIMARY_ACTION} disabled:opacity-40`}
      >
        Send
      </button>
    </CardActions>
  )
}

/** The report on its own, with no prompt box to carry it. `useStepsAnswer` stops staging it the moment the
 *  send commits, which is what stops a second click sending twice. */
function useSendAlone(thread: TodoThread, onReplied?: () => void, onReplyFailed?: () => void): () => void {
  const { take } = useStepsAnswer(thread)
  const followUp = useEagerFollowUp(thread.id)
  return () => {
    const report = take()
    if (!report) return
    followUp.submit(report.compose(""), {
      todos: report.todos,
      onOptimistic: () => {
        report.onOptimistic()
        onReplied?.()
      },
      onRollback: () => {
        report.onRollback()
        onReplyFailed?.()
      },
    })
  }
}

function isTextEntry(el: Element | null): boolean {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || (el instanceof HTMLElement && el.isContentEditable)
}

// A STAGED TICK WEARS THE SELECTION'S FILL AND A REPORTED ONE THE OUTLINE, the two treatments a question's
// option has: picked and not sent, or a past pick (QuestionBlockCard's `settledPick`).
function boxClass(done: boolean, staged: boolean): string {
  const state = !done
    ? "border-control-strong bg-panel"
    : staged
    ? "border-accent bg-accent-fill text-on-accent"
    : "border-control-strong text-fg"
  return `frizz-todo-box border transition-colors ${state}`
}

function BoxCheck() {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <Check size={12} strokeWidth={3} />
    </span>
  )
}
