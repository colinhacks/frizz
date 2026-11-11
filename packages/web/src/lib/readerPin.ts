// THE READER HOLDS STILL WHILE THE LIST CHANGES UNDER THEM — a card or a row arriving, or moving, never
// moves what the reader is looking at (maintainer 2026-10-26: "when a new item enters the queue it
// shouldn't autoscroll me to the top of the queue. EVER. mobile or desktop").
//
// The browser's own scroll anchoring was trusted with this, and it fails in three places, each measured
// on a real stack with a scripted worker whose turn ended while a reader sat in the list:
//
//   · AT THE TOP OF THE PAGE. Anchoring never applies at scrollY 0. Newest first, a reader reading the
//     first card had it pushed a whole card down by the one that arrived above it, and was left looking
//     at the newcomer (desktop 1440×900: the card under the reader went from the read card to the new one,
//     both at 52px).
//   · WHEN THE LIST REORDERS. A thread that rests MOVES on the phone, from the running rows up into the
//     asks, and React moves every row it passes over to do it. A moved node loses its place as the
//     anchor, so Chromium compensated nothing and the list slid a row (390×844, newest first, scrollY
//     400: every row on screen 65px down, with anchoring on).
//   · WHERE NOTHING ANCHORS. iOS Safari has never shipped scroll anchoring (caniuse, through 26.4), so on
//     an iPhone every row that lands above the reader pushes them. And with a thread open over the list
//     the page is locked (lib/pageScrollLock), where no browser anchors: a card that arrived behind the
//     drawer, and grew to its full height after it mounted, put the reader one card up on closing it
//     (desktop, newest first, scrollY 900: the read card ended 860px below where it was).
//
// So the list holds the reader itself. Before a commit that changes it, find the item the reader is in
// and where it sits (captureReaderPin, read off the DOM the commit is about to replace); after the commit,
// put that item back (restoreReaderPin). The page lock does the same across the whole time it is held:
// it pins the reader as it locks and lands wherever that item has gone as it unlocks (App.tsx). Where
// native anchoring did work, it finds its anchor already in place and adjusts nothing, so the two never
// add up.

import { isPageScrollLocked, shiftLockedPage } from "./pageScrollLock.ts"

/** The item the reader is in, by a selector that finds it again, and where its top sat on screen. */
export type ReaderPin = { selector: string; top: number }

type Span = { top: number; bottom: number }

// Below this a difference is sub-pixel rounding, not movement.
const EPSILON = 0.5

/**
 * Which of these items the reader is in: the one with the most of itself on screen between `readingTop`
 * (the top of what the reader can see — under a fixed header, its bottom) and `viewportBottom`. The
 * earliest wins a tie, so in a list of equal rows it is the first one wholly in view. -1 when none is on
 * screen. An item taller than the screen wins outright; when two share it, the one the reader can see
 * more of is the one they are reading, and an arrival between the two moves the other.
 */
export function readerPinIndex(spans: readonly Span[], readingTop: number, viewportBottom: number): number {
  let best = -1
  let bestSeen = 0
  spans.forEach((span, i) => {
    const seen = Math.min(span.bottom, viewportBottom) - Math.max(span.top, readingTop)
    if (seen > bestSeen + EPSILON) {
      best = i
      bestSeen = seen
    }
  })
  return best
}

// What a reader reads in: the band's rows on the phone. The desktop board's queue cards were the other
// kind until the one-thread pane replaced them (2026-11-09); the pane scrolls its own column and holds
// no list.
const ITEMS: readonly { attr: string; select: string }[] = [
  { attr: "data-mobile-thread-row", select: "[data-mobile-board] [data-mobile-thread-row]" },
]

/**
 * The item the reader is in on this page, and where its top sits now — or null when no row is on
 * screen. The phone's fixed header covers the top of its list, so what the reader sees starts below it.
 */
export function captureReaderPin(): ReaderPin | null {
  if (typeof document === "undefined") return null
  const readingTop = document.querySelector("[data-mobile-board-header]")?.getBoundingClientRect().bottom ?? 0
  for (const { attr, select } of ITEMS) {
    const items = [...document.querySelectorAll<HTMLElement>(select)].map((el) => ({ el, rect: el.getBoundingClientRect() }))
    if (items.length === 0) continue
    const i = readerPinIndex(items.map(({ rect }) => rect), readingTop, window.innerHeight)
    if (i < 0) return null
    return { selector: `[${attr}="${CSS.escape(items[i].el.getAttribute(attr) ?? "")}"]`, top: items[i].rect.top }
  }
  return null
}

/** How far the pinned item has moved since it was pinned; 0 when it is gone, so nothing is chased. */
export function readerPinDrift(pin: ReaderPin): number {
  const el = document.querySelector<HTMLElement>(pin.selector)
  if (!el) return 0
  const drift = el.getBoundingClientRect().top - pin.top
  return Math.abs(drift) > EPSILON ? drift : 0
}

/**
 * Put the pinned item back where it was, by scrolling the page the distance it moved. An instant move
 * (`behavior: "auto"`), the board's idiom for every viewport correction. Under the page lock the scroll
 * would be clamped and then undone by the unlock, so the lock's own offset moves instead.
 */
export function restoreReaderPin(pin: ReaderPin): void {
  const delta = readerPinDrift(pin)
  if (delta === 0) return
  if (isPageScrollLocked()) shiftLockedPage(delta)
  else window.scrollBy({ top: delta, left: 0, behavior: "auto" })
}
