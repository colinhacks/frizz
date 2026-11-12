import { createHash } from "node:crypto"
import type { AwaitingStep, HumanTodo } from "@frizz/shared"
import { detached } from "./detached-string.ts"

// THE HUMAN'S TO-DO LIST (2026-11-09, maintainer: "a single, coherent, human-facing to-do list for the
// entire session. That's maintained by Frizz").
//
// Two sources, joined only when the board reads them:
//
//   · WHAT IS ON THE LIST is a pure fold over the transcript (HumanStep, carried in the tail state): every
//     ```awaiting fence that handed the human `steps:` and that the thread really rested on. So nothing
//     is registered, as `steps:` never was (maintainer 2026-10-03: "I don't think this requires
//     persistently registering it"), and a worker gains no new verb.
//   · WHAT IS TICKED is the one thing a transcript cannot hold: the thread_human_todo row, written the
//     moment the box is clicked, so every surface and every device agree before anything is sent.
//
// THE RULES THAT MAKE IT ONE LIST
//
//   · A step is its own text: its title, the first paragraph of its `- ` item. The same title in a later
//     fence is the same item and keeps its box, and the body under it is whatever that fence wrote.
//   · The newest `steps:` says what is still owed. An unticked item it leaves out has been dropped by the
//     worker and leaves the list; a ticked one stays, as the record of what was done.
//   · A rest with no `steps:` says nothing about the list. Handing over the first of three acts and then
//     parking on a build must not lose the other two.
//   · A worker that lists a step AFTER hearing it was done still needs it (the sign-in did not take), so
//     the item reopens. A tick the worker has not heard about is left alone: a worker re-posting its steps
//     on a timer has not said the human's tick was wrong.

export interface HumanStep {
  id: string
  text: string
  /** The Markdown under the title, as the newest fence listing the step wrote it. */
  body?: string
  /** When a fence last listed this step, in ms. */
  listedAt: number
  /** Did the newest fence with `steps:` list it? */
  listed: boolean
  /** A reply said `Done` to the rest that listed it, with no tick behind it: a word typed by hand, or a
   *  reply from before the list existed. Cleared by listing the step again. */
  closedAt?: number
}

/** The ticks of one item, as stored. Both instants are ms. */
export interface HumanTodoTick {
  item_id: string
  done_at: number | null
  reported_at: number | null
}

/** Enough for any real thread. Past it the oldest items no fence lists any more go first. */
export const HUMAN_STEPS_MAX = 64

/** A step's identity: its text, so a re-wrapped copy of the same words is the same item. */
export function humanStepId(text: string): string {
  return createHash("sha256").update(text.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 16)
}

/** The list after a fence listing `steps` landed at `atMs`. Pure: the fold's state is cached as JSON, and
 *  the board reads a fence that has not ended its rest yet through this same function. */
export function foldHumanSteps(list: readonly HumanStep[], steps: readonly AwaitingStep[], atMs: number): HumanStep[] {
  const named = new Map(steps.map((step) => [humanStepId(step.text), step]))
  const next = list.map((step): HumanStep => {
    const listed = named.get(step.id)
    if (listed === undefined) return { ...step, listed: false }
    named.delete(step.id)
    const { closedAt: _closed, body: _body, ...open } = step
    return { ...open, text: detached(listed.text), ...(listed.body ? { body: detached(listed.body) } : {}), listedAt: atMs, listed: true }
  })
  // A step is cut out of the reply that listed it, and the list outlives the reply: copy (detached-string.ts).
  for (const [id, { text, body }] of named) next.push({ id, text: detached(text), ...(body ? { body: detached(body) } : {}), listedAt: atMs, listed: true })
  while (next.length > HUMAN_STEPS_MAX) {
    const oldest = next.findIndex((step) => !step.listed)
    next.splice(oldest === -1 ? 0 : oldest, 1)
  }
  return next
}

/** A reply said `Done` to the rest that listed `steps`. */
export function closeHumanSteps(list: readonly HumanStep[], steps: readonly string[], atMs: number): HumanStep[] {
  const named = new Set(steps.map(humanStepId))
  return list.map((step) => (named.has(step.id) ? { ...step, closedAt: atMs } : step))
}

/** The list as the human sees it. `finished` is a thread its worker signed off: nothing is owed any more,
 *  so what was never ticked goes and what was done stays. */
export function humanTodoView(
  steps: readonly HumanStep[] | undefined,
  ticks: readonly HumanTodoTick[] | undefined,
  options: { finished?: boolean } = {},
): HumanTodo[] {
  if (!steps?.length) return []
  const byId = new Map(ticks?.map((tick) => [tick.item_id, tick]))
  const todos: HumanTodo[] = []
  for (const step of steps) {
    const tick = byId.get(step.id)
    // The worker has listed it since it was last told, so that report no longer stands, and nor does the
    // tick it covered. A tick made after the report is a new one.
    const stale = tick?.reported_at != null && tick.reported_at < step.listedAt
    const doneAt = stale && tick.done_at !== null && tick.done_at <= (tick.reported_at as number) ? null : tick?.done_at ?? null
    const reportedAt = stale ? null : tick?.reported_at ?? null
    const done = tick ? doneAt !== null : step.closedAt !== undefined
    if (!done && (!step.listed || options.finished)) continue
    todos.push({
      id: step.id,
      text: step.text,
      ...(step.body ? { body: step.body } : {}),
      done,
      staged: tick ? done !== (reportedAt !== null) : false,
      ...(reportedAt !== null ? { reportedAt } : {}),
    })
  }
  return todos
}
