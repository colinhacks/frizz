import { flushSync } from "react-dom"
import { proxy, subscribe } from "valtio"
import { closeDrawersById, showInPane, store } from "../store.ts"
import { prefersReducedMotion } from "./sheet.ts"

// THE ONE-THREAD PANE, a PROTOTYPE on its own branch (maintainer 2026-11-06: "we may just be optimized for
// only showing one card on the screen at a time"). The board's right-hand column shows one thread at full
// height, picked by a sidebar row. Done and Snooze bring up the next thread in the queue. With nothing
// picked the column offers the first item.
//
// `after send` and `fold style` are the two questions a still frame cannot answer, so the prototype lets
// them be tried (ThreadPane.tsx PrototypeControls). They are not meant to survive it as settings.

export type AfterSend = "stay" | "next" | "auto"
export type FoldStyle = "away" | "slim"

const KEY = "frizz.threadPanePrototype.v1"

function load(): { afterSend: AfterSend; foldStyle: FoldStyle; folded: boolean } {
  const fallback = { afterSend: "stay" as AfterSend, foldStyle: "away" as FoldStyle, folded: false }
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }
  } catch {
    return fallback
  }
}

export const paneProto = proxy(load())
subscribe(paneProto, () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(paneProto))
  } catch {
    // A browser refusing storage only loses the choice across a reload.
  }
})

// The queue in the order the pane walks it, published by the mounted pane (usePaneQueue), so a click
// handler anywhere can ask for the next one without re-deriving the order.
let queueIds: readonly string[] = []
export function publishPaneQueue(ids: readonly string[]): void {
  queueIds = ids
}

// A thread just dismissed stays on the board for a moment after the human moved on, and the next
// dismissal must not walk back onto it. The same window the queue gave a dismissed card (TodosView resolve).
const LEFT_MS = 8000
const left = new Map<string, number>()
function liveQueue(): string[] {
  const now = Date.now()
  for (const [slug, at] of left) if (now - at > LEFT_MS) left.delete(slug)
  return queueIds.filter((id) => !left.has(id))
}

/** The thread after `slug`, wrapping to the first; null when nothing else is waiting. */
export function nextQueuedAfter(slug: string): string | null {
  const live = liveQueue()
  const rest = live.filter((id) => id !== slug)
  if (rest.length === 0) return null
  const at = live.indexOf(slug)
  return at === -1 ? rest[0]! : rest[at % rest.length]!
}

// Set by the chord that moves on with a keyboard, so the caret lands in the next prompt box.
let focusNextComposer = false
export function takeComposerFocus(): boolean {
  const taken = focusNextComposer
  focusNextComposer = false
  return taken
}

/** Bring up what follows `slug`, or the prompt when nothing does. A no-op once the pane has moved on. */
export function advanceFrom(slug: string, opts?: { dismissed?: boolean }): void {
  if (store.paneSlug !== slug) return
  // Asked first: `left` takes the thread out of the list its place in the queue is read from.
  const next = nextQueuedAfter(slug)
  if (opts?.dismissed) left.set(slug, Date.now())
  if (next) showInPane(next, "queue")
  else {
    closeDrawersById(store.drawers.filter((d) => !d.closing).map((d) => d.id))
    store.paneSlug = null
  }
}

/** Put back a dismissal the server declined. */
export function reinstate(slug: string): void {
  left.delete(slug)
  showInPane(slug)
}

export function openFirstQueued(): void {
  const first = liveQueue()[0]
  if (first) showInPane(first, "queue")
}

/** One step through the queue from wherever the pane is. Off the queue, down is its first item. */
export function stepPane(delta: 1 | -1): void {
  const live = liveQueue()
  const slug = store.paneSlug
  const at = slug ? live.indexOf(slug) : -1
  const target = at === -1 ? (delta === 1 ? live[0] : undefined) : live[at + delta]
  if (target) showInPane(target, "queue")
}

// ── a send ────────────────────────────────────────────────────────────────────────────────────────
let sendAndNextArmed = false

/** The one thing a send decides: whether the thread that was sent to stays on screen. */
export function paneAfterSend(slug: string): void {
  const armed = sendAndNextArmed
  sendAndNextArmed = false
  const move = armed || paneProto.afterSend === "next" || (paneProto.afterSend === "auto" && store.paneVia === "queue")
  if (move) advanceFrom(slug)
}

/** ⇧⌘⏎, and the Send menu's row. With nothing to send it only moves on. */
export function sendAndNext(canSend: boolean, submit: () => void): void {
  focusNextComposer = true
  if (canSend) {
    sendAndNextArmed = true
    submit()
    sendAndNextArmed = false
  } else {
    stepPane(1)
  }
}

// ── full screen ───────────────────────────────────────────────────────────────────────────────────
// The same page with the sidebar put away: no navigation and no remount, so the transcript keeps its
// place and the prompt box its draft. The thread column morphs through the view transition /full's door
// already uses (styles.css `thread-chat`), and it is a transition rather than animated widths because
// the column's width is a percentage of the page around it (StandaloneThreadPage LAYOUT_VARS).
export function setPaneFolded(next: boolean): void {
  if (paneProto.folded === next) return
  const apply = () => {
    flushSync(() => {
      paneProto.folded = next
    })
  }
  const start = (document as Document & { startViewTransition?: (update: () => void) => unknown }).startViewTransition
  if (!start || prefersReducedMotion()) apply()
  else start.call(document, apply)
}

export function foldPane(slug: string): void {
  if (store.paneSlug !== slug) showInPane(slug)
  setPaneFolded(true)
}
