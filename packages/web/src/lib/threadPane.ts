import { useSyncExternalStore } from "react"
import { flushSync } from "react-dom"
import { proxy } from "valtio"
import { closeDrawersById, showInPane, store } from "../store.ts"
import { prefersReducedMotion, SPLIT_MIN_PX } from "./sheet.ts"

// THE ONE-THREAD PANE (maintainer 2026-11-06: "we may just be optimized for only showing one card on the
// screen at a time"; tried on its own branch and landed 2026-11-09). The board's right-hand column shows
// one thread at full height, picked by a sidebar row. Done and Snooze bring up the next thread in the
// queue. With nothing picked the column offers the first item. A send stays on the thread; ⇧⌘⏎ sends
// and moves on.

// WHAT THE PANE SHOWS BESIDE ITS THREAD IS IN THE ADDRESS (maintainer 2026-11-11: "There needs to be a change
// in the URL based on whether you are showing/hiding artifacts or showing/hiding the sidebar"). lib/router.ts
// writes both and reads them back, so a reload, Back, a copied link and a second tab all open the thread
// the way it was being read:
//   · the sidebar put away is the thread's own path, `…/thread/<slug>`, its full-screen page since
//     2026-11-07, so every link to that page opens this view; beside the sidebar it is `?thread=<slug>`.
//   · the artifact rail is `artifacts=shown` or `artifacts=hidden` when the reader chose against what the
//     window does by itself, and absent otherwise (paneRailWanted).
// Both were remembered in localStorage until then (`frizz.threadPanePrototype.v1`), which is gone: the URL
// is what is remembered now, and in the page the choice rides along from one thread to the next.

/** The artifact rail: what the window does by itself, or what the reader chose. */
export type PaneArtifacts = "default" | "shown" | "hidden"

export const paneProto = proxy({ folded: false, artifacts: "default" as PaneArtifacts })

/** The query parameter that says the reader chose to show or hide the artifact rail. */
export const ARTIFACTS_PARAM = "artifacts"

/** The rail choice a URL's query records. */
export function artifactsParam(search: string): PaneArtifacts {
  const value = new URLSearchParams(search).get(ARTIFACTS_PARAM)
  return value === "shown" || value === "hidden" ? value : "default"
}

// THE RAIL STANDS BY ITSELF ONLY WHERE IT FITS BESIDE THE SIDEBAR (maintainer 2026-11-11: "the artifact
// sidebar should be visible on the screens that can support it by default. On the others, it should not
// be"). That is the three columns' width, PANE_WIDE_MIN_PX; narrower, it stands only when asked for.
/** Does the reader want the rail, on a window that is (or is not) wide enough for the three columns? */
export function paneRailWanted(artifacts: PaneArtifacts, wide: boolean): boolean {
  return artifacts === "shown" || (artifacts === "default" && wide)
}

// The queue in the order the pane walks it, published by the mounted pane (usePaneQueue), so a click
// handler anywhere can ask for the next one without re-deriving the order.
let queueIds: readonly string[] = []
export function publishPaneQueue(ids: readonly string[]): void {
  queueIds = ids
}

// A thread just dismissed stays on the board for a moment after the human moved on, and the next
// dismissal must not walk back onto it. The same window the queue gave a dismissed card, before the pane.
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
  if (next) showInPane(next)
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
  if (first) showInPane(first)
}

/** One step through the queue from wherever the pane is. Off the queue, down is its first item. */
export function stepPane(delta: 1 | -1): void {
  const live = liveQueue()
  const slug = store.paneSlug
  const at = slug ? live.indexOf(slug) : -1
  const target = at === -1 ? (delta === 1 ? live[0] : undefined) : live[at + delta]
  if (target) showInPane(target)
}

// ── a send ────────────────────────────────────────────────────────────────────────────────────────
let sendAndNextArmed = false

/** The one thing a send decides: whether the thread that was sent to stays on screen. It does, unless
 *  the send was ⇧⌘⏎'s. */
export function paneAfterSend(slug: string): void {
  const armed = sendAndNextArmed
  sendAndNextArmed = false
  if (armed) advanceFrom(slug)
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
// sidebar … This is the whole idea"). The same page with the sidebar put away: no remount, so the transcript
// keeps its place and the prompt box its draft. The address moves to the thread's own path (lib/router.ts),
// a route that renders this same board, so the page under it does not change. The thread column morphs
// through the view transition /full's door already uses (styles.css `thread-chat`), and it is a transition
// rather than animated widths because the column's width is a percentage of the page around it
// (StandaloneThreadPage LAYOUT_VARS).
export function setPaneFolded(next: boolean): void {
  if (paneProto.folded === next) return
  morph(() => {
    paneProto.folded = next
    // The sidebar back on a window with no room for it and the rail together takes the rail's place: the
    // reverse of showing the rail there, which put the sidebar away (setPaneRailShown).
    if (!next && !isPaneWide() && paneProto.artifacts === "shown") paneProto.artifacts = "default"
  })
}

// THE ARTIFACT RAIL, SHOWN OR PUT AWAY (maintainer 2026-11-09, of the collapse controls on the lines between
// the columns: a dot that opens into a knob, "K5, let's lock it in"). The columns that are left re-centre as
// a pair, and the thread's ops strip comes back above its transcript, as it does wherever no rail stands
// beside it. A choice that matches what this window does by itself is no choice, and leaves the address
// clean (paneRailWanted). Asked for on a window too narrow for the sidebar and the rail together, the rail
// takes the sidebar's room (maintainer 2026-11-11: "it should also hide the regular sidebar if the screen is
// not big enough to include both").
export function setPaneRailShown(next: boolean): void {
  const wide = isPaneWide()
  const artifacts: PaneArtifacts = next === wide ? "default" : next ? "shown" : "hidden"
  const folded = next && !wide ? true : paneProto.folded
  if (paneProto.artifacts === artifacts && paneProto.folded === folded) return
  morph(() => {
    paneProto.artifacts = artifacts
    paneProto.folded = folded
  })
}

// THE RAIL HAS ROOM BESIDE A THREAD FROM THE SPLIT WIDTH UP (lib/sheet.ts SPLIT_MIN_PX), as on /full: with the
// sidebar beside them only at the three columns' width, full screen from here. Narrower, nothing stands
// beside the thread, so there is nothing to show or hide.
const SPLIT_QUERY = `(min-width: ${SPLIT_MIN_PX}px)`
let splitMedia: MediaQueryList | null = null
const splitListeners = new Set<() => void>()
function subscribeSplit(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {}
  if (!splitMedia) {
    splitMedia = window.matchMedia(SPLIT_QUERY)
    splitMedia.addEventListener("change", () => splitListeners.forEach((l) => l()))
  }
  splitListeners.add(callback)
  return () => splitListeners.delete(callback)
}
function isPaneSplit(): boolean {
  if (splitMedia) return splitMedia.matches
  return typeof window !== "undefined" && !!window.matchMedia?.(SPLIT_QUERY).matches
}

/** Is the window wide enough for the rail beside a thread at all? Live, as usePaneWide is. */
export function usePaneSplit(): boolean {
  return useSyncExternalStore(subscribeSplit, isPaneSplit, () => false)
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
