import { useSyncExternalStore } from "react"
import { flushSync } from "react-dom"
import { proxy, subscribe } from "valtio"
import { closeDrawersById, showInPane, store } from "../store.ts"
import { prefersReducedMotion } from "./sheet.ts"

// THE ONE-THREAD PANE, a PROTOTYPE on its own branch (maintainer 2026-11-06: "we may just be optimized for
// only showing one card on the screen at a time"). The board's right-hand column shows one thread at full
// height, picked by a sidebar row. Done and Snooze bring up the next thread in the queue. With nothing
// picked the column offers the first item.
//
// `after send` is the question a still frame cannot answer, so the prototype lets it be tried
// (ThreadPane.tsx PrototypeControls). It is not meant to survive it as a setting.

export type AfterSend = "stay" | "next" | "auto"

const KEY = "frizz.threadPanePrototype.v1"

function load(): { afterSend: AfterSend; folded: boolean; railHidden: boolean } {
  const fallback = { afterSend: "stay" as AfterSend, folded: false, railHidden: false }
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<typeof fallback>
    // Field by field, so a key an earlier build stored (the slim rail's `foldStyle`) is dropped.
    return {
      afterSend: stored.afterSend ?? fallback.afterSend,
      folded: stored.folded ?? fallback.folded,
      railHidden: stored.railHidden ?? fallback.railHidden,
    }
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

// ── the wide layout ───────────────────────────────────────────────────────────────────────────────
// AT 1360PX AND WIDER THE PANE IS THREE COLUMNS (maintainer 2026-11-06, "4C"): the sidebar's minimum 300,
// the thread's 720 and the rail's 340 add up to exactly 1360, so from there on nothing has to be put away
// to show the rail. Narrower, the sidebar and the rail cannot both stand beside a thread, and only full
// screen brings the rail back.
export const PANE_WIDE_MIN_PX = 1360
export const PANE_THREAD_PX = 720
export const PANE_SIDEBAR_MAX_PX = 480
// The rail's 340 is FocusRail's RAIL_WIDTH, which this file sits under.
const WIDEST_COLUMNS_PX = PANE_SIDEBAR_MAX_PX + PANE_THREAD_PX + 340
const WIDEST_PAIR_PX = PANE_SIDEBAR_MAX_PX + PANE_THREAD_PX

/** Where the sidebar's left edge stands, as a CSS length of the page: past the columns' greatest widths,
 *  the far left and far right share what is left over. `rail` is whether the rail stands beside them. */
export function paneSidebarLeft(rail: boolean): string {
  return `max(0px, calc((100% - ${rail ? WIDEST_COLUMNS_PX : WIDEST_PAIR_PX}px) / 2))`
}
const WIDE_QUERY = `(min-width: ${PANE_WIDE_MIN_PX}px)`

// One MediaQueryList for every caller, as lib/mobile.ts keeps for the phone breakpoint.
let wideMedia: MediaQueryList | null = null
const wideListeners = new Set<() => void>()
function subscribeWide(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {}
  if (!wideMedia) {
    wideMedia = window.matchMedia(WIDE_QUERY)
    wideMedia.addEventListener("change", () => wideListeners.forEach((l) => l()))
  }
  wideListeners.add(callback)
  return () => wideListeners.delete(callback)
}

export function isPaneWide(): boolean {
  if (wideMedia) return wideMedia.matches
  return typeof window !== "undefined" && !!window.matchMedia?.(WIDE_QUERY).matches
}

/** Is the window wide enough for the three columns? Live: a resize across the line re-renders. */
export function usePaneWide(): boolean {
  return useSyncExternalStore(subscribeWide, isPaneWide, () => false)
}

// ── full screen ───────────────────────────────────────────────────────────────────────────────────
// FOCUS MODE, AT EVERY WIDTH (maintainer 2026-11-09: "open up a specific thread in a view that drops the
// sidebar … This is the whole idea"). The same page with the sidebar put away: no navigation and no
// remount, so the transcript keeps its place and the prompt box its draft. The thread column morphs
// through the view transition /full's door already uses (styles.css `thread-chat`), and it is a transition
// rather than animated widths because the column's width is a percentage of the page around it
// (StandaloneThreadPage LAYOUT_VARS).
export function setPaneFolded(next: boolean): void {
  if (paneProto.folded === next) return
  morph(() => {
    paneProto.folded = next
  })
}

// THE RAIL PUT AWAY (maintainer 2026-11-09, of the collapse controls on the lines between the columns: a
// dot that opens into a knob, "K5, let's lock it in"). The columns that are left re-centre as a pair, and
// the thread's ops strip comes back above its transcript, as it does wherever no rail stands beside it.
// Remembered, like full screen: a reader who put it away wants it away on the next thread too.
export function setPaneRailHidden(next: boolean): void {
  if (paneProto.railHidden === next) return
  morph(() => {
    paneProto.railHidden = next
  })
}

function morph(update: () => void): void {
  const apply = () => flushSync(update)
  const start = (document as Document & { startViewTransition?: (update: () => void) => unknown }).startViewTransition
  if (!start || prefersReducedMotion()) apply()
  else start.call(document, apply)
}

export function foldPane(slug: string): void {
  if (store.paneSlug !== slug) showInPane(slug)
  setPaneFolded(true)
}
