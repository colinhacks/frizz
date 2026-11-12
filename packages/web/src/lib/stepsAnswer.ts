import { useEffect } from "react"
import { proxy, useSnapshot } from "valtio"
import type { AwaitingHint, HumanTodo, ThreadView } from "@frizz/shared"
import { awaitingSteps, repliesStepsDone, STEPS_DONE, wordsUnderAnswers } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import type { ChatMessage } from "../hooks.ts"
import { showToast } from "../store.ts"

// THE HUMAN'S TO-DO LIST, FROM THE BROWSER'S SIDE (2026-11-09, maintainer: "The user can indicate which
// things they've completed and which ones they haven't, and it's a single, coherent, human-facing to-do
// list for the entire session. That's maintained by Frizz").
//
// The list is the server's (human-todos.ts) and arrives on the thread. Clicking a box saves the tick at
// once, so the queue card, the drawer, /full and a phone all agree before anything is sent. Saving tells
// the worker nothing: a tick STAGES an answer, as picking a question's option does (maintainer
// 2026-10-12: "you should have the ability to submit it as an answer just as you can with any other
// question"), and the surface's one send (lib/sendScope) carries every tick the worker has not heard,
// together with whatever is typed in the box.

/** The slice of a thread these read — READONLY all the way down, because the prompt box hands in the
 *  board's frozen snapshot rather than a ThreadView. */
type StepsThread = {
  readonly id: string
  readonly runtime: ThreadView["runtime"]
  readonly lastFence?: { readonly kind: NonNullable<ThreadView["lastFence"]>["kind"]; readonly hints: readonly AwaitingHint[] }
  readonly humanTodos?: readonly HumanTodo[]
}
type TodoThread = Pick<StepsThread, "id" | "humanTodos">

/** Is the thread resting on EXACTLY these steps right now — the board's own last fence, at rest? Only
 *  then is a card live. A fence the transcript hands in is a rest the thread may already have left: the
 *  tailer clears `lastFence` on the human's very next message, so a steps card drawn after the reply is a
 *  record of what was asked. */
export function restingOnSteps(thread: Omit<StepsThread, "id"> | undefined, steps: readonly string[]): boolean {
  if (steps.length === 0 || thread?.runtime !== "turn-idle" || thread.lastFence?.kind !== "awaiting") return false
  const live = awaitingSteps(thread.lastFence.hints)
  return live.length === steps.length && live.every((step, i) => step === steps[i])
}

/** Are these the same step? A step is its own text, compared as the server keys it (human-todos.ts
 *  humanStepId): trimmed, every run of whitespace one space, so a re-wrapped copy is the same item. */
export function sameStep(a: string, b: string): boolean {
  const key = (text: string) => text.trim().replace(/\s+/g, " ")
  return key(a) === key(b)
}

// ---- the ticks in flight --------------------------------------------------------------------------
// What this tab has done that the board has not shown yet. An entry goes the moment the board agrees,
// because from then on the board may know better: a worker that re-lists a step reopens its box. The
// timer is for a push that never comes.

interface PendingTick {
  done: boolean
  /** Set by a send: the worker has heard this, whatever the board still says. */
  staged?: boolean
  /** Set by a send, the same instant on every box it reported (HumanTodo.reportedAt), so the card it
   *  answered keeps every row it sent from the first frame, before the board stamps the server's own. */
  reportedAt?: number
  /** The board's own report instant when the send went: the board agrees once it has moved off it. An
   *  open box reported open already agrees on everything else. */
  reportedWas?: number | null
}

const pending = proxy<Record<string, PendingTick>>({})
const settling = new Map<string, ReturnType<typeof setTimeout>>()
const SETTLE_MS = 5_000
const tickKey = (slug: string, id: string) => `${slug}\u0000${id}`

function settleLater(key: string): void {
  clearTimeout(settling.get(key))
  settling.set(key, setTimeout(() => forgetTick(key), SETTLE_MS))
}

function forgetTick(key: string): void {
  clearTimeout(settling.get(key))
  settling.delete(key)
  delete pending[key]
}

/** Tick or untick one box. Saved at once, and sent to nobody. */
export function tickHumanTodo(slug: string, id: string, done: boolean): void {
  const key = tickKey(slug, id)
  clearTimeout(settling.get(key))
  settling.delete(key)
  pending[key] = { done }
  rpc.setHumanTodo({ slug, id, done }).then(
    () => settleLater(key),
    (error: Error) => {
      forgetTick(key)
      showToast(`Couldn’t save that tick — ${error.message.slice(0, 120)}`)
    },
  )
}

/** The thread's list as this tab should draw it. */
export function useHumanTodos(thread: TodoThread | undefined): HumanTodo[] {
  const ticks = useSnapshot(pending)
  const slug = thread?.id
  const board = thread?.humanTodos
  useEffect(() => {
    if (!slug) return
    for (const todo of board ?? []) {
      const key = tickKey(slug, todo.id)
      const tick = pending[key]
      if (!tick || tick.done !== todo.done || (tick.staged !== undefined && tick.staged !== todo.staged)) continue
      if (tick.reportedAt === undefined || (todo.reportedAt ?? null) !== tick.reportedWas) forgetTick(key)
    }
  }, [slug, board])
  if (!thread) return []
  return (thread.humanTodos ?? []).map((todo) => {
    const tick = ticks[tickKey(thread.id, todo.id)]
    if (!tick) return todo
    const staged = tick.staged ?? (tick.done === todo.done ? todo.staged : !todo.staged)
    return { ...todo, done: tick.done, staged, ...(tick.reportedAt !== undefined ? { reportedAt: tick.reportedAt } : {}) }
  })
}

// ---- what a send says -----------------------------------------------------------------------------

/** What a send reports: everything still owed, and every tick the worker has not heard. A step it already
 *  knows is done stays out, so a long thread's reply does not recite its whole history. */
export function stepsReport<T extends Pick<HumanTodo, "done" | "staged">>(todos: readonly T[]): T[] {
  return todos.filter((todo) => todo.staged || !todo.done)
}

/** The reply a send carries: the bare word when everything is done, as if the human had typed it, and a
 *  checklist when some is not. The human's note goes under either. */
export function withStepsReport(report: readonly Pick<HumanTodo, "text" | "done">[], note: string): string {
  const done = report.filter((todo) => todo.done).length
  const head = done === report.length
    ? STEPS_DONE
    : `${STEPS_DONE} ${done} of ${report.length}:\n${report.map((todo) => `- [${todo.done ? "x" : " "}] ${todo.text}`).join("\n")}`
  const trimmed = note.trim()
  return trimmed ? `${head}\n\n${trimmed}` : head
}

/** What a reply said was done: everything, the steps it ticked, or null for a reply that was not a report. */
export type StepsReply = "all" | ReadonlySet<string>

const REPORT_HEAD = new RegExp(`^${STEPS_DONE} \\d+ of \\d+:$`)
const REPORT_ROW = /^- \[( |x)\] (.*)$/

export function repliedSteps(text: string): StepsReply | null {
  if (repliesStepsDone(text)) return "all"
  const [head, ...rows] = wordsUnderAnswers(text).split("\n")
  if (!REPORT_HEAD.test(head)) return null
  const done = new Set<string>()
  for (const row of rows) {
    const match = REPORT_ROW.exec(row)
    if (!match) break
    if (match[1] === "x") done.add(match[2])
  }
  return done
}

// A SETTLED STEPS CARD SHOWS WHAT ITS REPLY SAID (maintainer 2026-10-15: "we should have something to
// indicate that the awaiting human block … was, in fact, completed"). Read off the TRANSCRIPT, not the
// list: a card is the record of one rest, and the list has moved on since.

/** The agent messages whose rest the human answered with a report (repliedSteps), by index: the first
 *  such reply to it. Only a message carrying an ```awaiting fence can be one.
 *
 *  A REPLY ANSWERS THE WORKER'S NEWEST WORD AS OF THE MOMENT IT WAS SENT, not the message drawn above it
 *  (2026-11-11, maintainer: "I checked all three boxes … all I did was show a message containing the word
 *  'done'"). A send that lands while the worker is busy waits in its queue and is drawn where the worker
 *  took it in, after whatever the worker did first. On a nub thread a shell finished 14ms before the human
 *  sent, the worker woke and made a tool call, and the "Done" was drawn under that call; reading the call
 *  as the worker's next word left the card unpaired and its three ticked boxes empty. So the walk back
 *  from a reply passes over what said nothing to the human (a tool call alone, an event line) and what was
 *  written after the reply was sent. The worker's prose before the send still ends its rest: a "Done"
 *  typed under "Still waiting on the DNS record." answers that, not the steps above it. */
export function stepsDoneReplies(messages: readonly Pick<ChatMessage, "role" | "kind" | "text" | "at">[]): ReadonlyMap<number, StepsReply> {
  const replies = new Map<number, StepsReply>()
  for (let j = 0; j < messages.length; j++) {
    const reply = messages[j]
    const said = reply.role === "user" ? repliedSteps(reply.text) : null
    if (!said) continue
    const sentAt = instant(reply.at)
    for (let i = j - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "assistant" || m.kind === "event" || !m.text.trim()) continue
      if (instant(m.at) > sentAt && sentAt !== Number.NEGATIVE_INFINITY) continue
      if (m.text.includes("```awaiting") && !replies.has(i)) replies.set(i, said)
      break
    }
  }
  return replies
}

/** An ISO instant in ms, or -Infinity when there is none: a message with no time counts as written
 *  before anything that has one, which is what the order of the list already says. */
const instant = (at: string | undefined): number => {
  const ms = at ? Date.parse(at) : Number.NaN
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY
}

/** A staged report, as a send needs it. */
export interface StepsTake {
  /** What the server records once the send is accepted (FollowUpInput.todos). */
  todos: { id: string; done: boolean }[]
  /** The reply, with the human's note under it. */
  compose: (note: string) => string
  /** The send has committed locally: nothing is staged any more, so a second Enter cannot repeat it. */
  onOptimistic: () => void
  /** The send was refused: the ticks are staged again. */
  onRollback: () => void
}

/** For whatever sends: is anything staged, and the hand-off of it. */
export function useStepsAnswer(thread: TodoThread | undefined): { staged: boolean; take: () => StepsTake | null } {
  const todos = useHumanTodos(thread)
  const staged = todos.some((todo) => todo.staged)
  const take = (): StepsTake | null => {
    if (!thread || !staged) return null
    const report = stepsReport(todos)
    const keys = report.map((todo) => tickKey(thread.id, todo.id))
    return {
      todos: report.map(({ id, done }) => ({ id, done })),
      compose: (note) => withStepsReport(report, note),
      onOptimistic: () => {
        const reportedAt = Date.now()
        report.forEach((todo, i) => {
          const reportedWas = thread.humanTodos?.find((listed) => listed.id === todo.id)?.reportedAt ?? null
          pending[keys[i]] = { done: todo.done, staged: false, reportedAt, reportedWas }
          settleLater(keys[i])
        })
      },
      onRollback: () => keys.forEach(forgetTick),
    }
  }
  return { staged, take }
}
