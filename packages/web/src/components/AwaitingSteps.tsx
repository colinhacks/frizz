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
// settled card's record of one past rest (StepsList), whose boxes are controls only for what the list
// still owes.
import { useContext, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { Check } from "lucide-react"
import type { AwaitingStep, HumanTodo } from "@frizz/shared"
import { useThreadHumanTodos } from "../hooks.ts"
import { shouldSubmitStagedEnter } from "../lib/composerKeyboard.ts"
import { useEagerFollowUp } from "../lib/eagerComposerSubmission.ts"
import { SendScopeContext, usePromptBoxSends } from "../lib/sendScope.tsx"
import { sameStep, tickHumanTodo, useHumanTodos, useStepsAnswer, type StepsReply } from "../lib/stepsAnswer.ts"
import { ThreadSlugContext } from "../lib/threadContexts.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { CARD_PRIMARY_ACTION, CardActions, WRAP_ANYWHERE } from "./TranscriptCard.tsx"

type TodoThread = { readonly id: string; readonly humanTodos?: readonly HumanTodo[] }

// THE FRAME EVERY SHAPE SHARES, `md-body` so a step's code span and link read as they do in the prose
// above it, in the prose's own colour (maintainer 2026-10-05: "the paragraphs looks like they're a
// slightly lighter color than the text in the ol"). The gap above is the paragraph break the prose uses
// (`--md-step`), so the two read as one handoff in two pieces.
const LIST_FRAME = `md-body ${WRAP_ANYWHERE} mt-[var(--md-step)] first:mt-0`

/** What the list still asks of the human: open, or ticked and not yet sent. */
const owed = (todo: HumanTodo) => !todo.done || todo.staged

/** The record of one past rest: the steps as that rest listed them, ticked as its reply said.
 *
 *  A STEP THE LIST STILL OWES STAYS A BOX TO TICK (2026-11-11, maintainer: "this 'Awaiting Human to Do'
 *  list is showing up but isn't clickable, and I don't know why"). The card is a record because its rest is
 *  over, but the list is the whole session's, and a rest ends on far more than the human's reply: a watch
 *  firing, a timer, a message in words, a send that set the worker running again. Each of those left the
 *  steps unticked on the list and drew them here as boxes that did nothing, beside a count over the prompt
 *  box saying they were owed. So a step the list still owes is that list's item, ticked as on every other
 *  surface. What was sent as done stays the record, ticked and inert, as does a step the list no longer
 *  holds (the worker dropped it, or signed off).
 *
 *  AND THE CARD KEEPS EVERY ROW ITS REPLY SENT (2026-11-11, maintainer: "It seemed to remove the first
 *  item of three from the rendered to-do list, despite the fact that all of them were checked"). The
 *  resting card draws the whole list, so a box ticked at an earlier rest and not yet sent rides on it
 *  beside this rest's own steps, and the human ticks and sends them together. Drawing only the fence's
 *  own steps once the rest was over took that row away the moment Send was pressed. So the card the
 *  reply answered (`done`) also draws, first, as the list orders them, every other box that one send
 *  reported, which the list stamps with the same instant. */
export function StepsList({ steps, done }: { steps: readonly AwaitingStep[]; done?: StepsReply | null }) {
  // From the surface, not a prop: a settled card is drawn inside a memoized message, and the list moves
  // without the message changing. Null in a tree that is no thread's own (a sub-agent's transcript).
  const slug = useContext(ThreadSlugContext)
  const listed = useThreadHumanTodos(slug)
  const thread = useMemo(() => (slug && listed ? { id: slug, humanTodos: listed } : undefined), [slug, listed])
  const todos = useHumanTodos(thread)
  const own = steps.map((step) => ({ step, todo: todos.find((todo) => sameStep(todo.text, step.text)) }))
  const rows = done ? [...sentAlongside(todos, own.map(({ todo }) => todo)), ...own] : own
  const list = (onTicked?: (event: MouseEvent<HTMLButtonElement>) => void) => (
    <ul className="frizz-todos">
      {rows.map(({ step, todo }, i) => thread && todo && owed(todo)
        ? <TodoRow key={i} slug={thread.id} todo={todo} onTicked={onTicked} />
        : <RecordRow key={i} step={step} done={todo?.done === true || done === "all" || done?.has(step.text) === true} />)}
    </ul>
  )
  if (!thread || !rows.some(({ todo }) => todo && owed(todo))) return <div data-awaiting-steps className={LIST_FRAME}>{list()}</div>
  return <TickFrame thread={thread}>{list}</TickFrame>
}

/** The boxes the send that reported this rest's own steps also reported: the newest report among them
 *  names the send. */
function sentAlongside(todos: readonly HumanTodo[], own: readonly (HumanTodo | undefined)[]): { step: AwaitingStep; todo: HumanTodo }[] {
  const sent = Math.max(...own.map((todo) => todo?.reportedAt ?? Number.NEGATIVE_INFINITY))
  if (!Number.isFinite(sent)) return []
  return todos
    .filter((todo) => todo.reportedAt === sent && !own.some((mine) => mine?.id === todo.id))
    .map((todo) => ({ step: { text: todo.text, ...(todo.body ? { body: todo.body } : {}) }, todo }))
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
  const [showEarlier, setShowEarlier] = useState(false)
  const earlier = todos.filter((todo) => !owed(todo))
  const current = todos.filter(owed)
  // The server hands the steps over with the fence, so this is only a server older than the list.
  if (todos.length === 0) return null
  return (
    <TickFrame thread={thread} onReplied={onReplied} onReplyFailed={onReplyFailed}>
      {(onTicked) => (
        <>
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
        </>
      )}
    </TickFrame>
  )
}

/** A list whose boxes answer: Enter on a ticked box sends, and with no prompt box in reach the list draws
 *  its own Send. The resting card's and a settled card's, which differ only in which rows they hold. */
function TickFrame({ thread, onReplied, onReplyFailed, children }: {
  thread: TodoThread
  onReplied?: () => void
  onReplyFailed?: () => void
  children: (onTicked: (event: MouseEvent<HTMLButtonElement>) => void) => ReactNode
}) {
  const { staged } = useStepsAnswer(thread)
  const sendScope = useContext(SendScopeContext)
  const promptBoxSends = usePromptBoxSends()
  const sendAlone = useSendAlone(thread, onReplied, onReplyFailed)
  const frame = useRef<HTMLDivElement>(null)

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
  return (
    <>
      <div ref={frame} data-awaiting-steps tabIndex={-1} onKeyDown={onKeyDown} className={`${LIST_FRAME} outline-none`}>
        {children(onTicked)}
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
      onSuccess: report.onSuccess,
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
