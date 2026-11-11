// The PAGE scroll lock, and reading the page's offset through it.
//
// While any overlay is open, App pins the page with the body-fixed dance (`body{position:fixed;
// top:-y}` — see App.tsx for why it isn't `overflow:hidden`). Two consequences bite anything that
// wants to scroll the page WHILE a drawer is on screen or sliding out:
//
//   1. `window.scrollY` reads 0 and the document collapses to viewport height, so `window.scrollTo`
//      is silently clamped to a no-op. Every measurement has to come off the lock's own offset.
//   2. The unlock RESTORES the offset, so even a scroll that did land would be undone. (Restores it
//      corrected for the reader's row: whatever moved it while the page was pinned — a row arriving
//      above it, or growing — is made up on the way back, lib/readerPin.)
//
// A scroll requested under the lock used to park its landing here for the unlock, so a sidebar row could
// dismiss the open drawer and still scroll the board to its queue card. The cards went with the one-thread
// pane (2026-11-09), and with them the only caller.

// The document scroll offset, whether or not the page is locked. Under the lock the body is shifted
// up by the captured offset, so `-body.style.top` is the real scrollY and every getBoundingClientRect
// is already relative to it.
export function pageScrollY(): number {
  if (typeof document === "undefined" || !document.body) return typeof window === "undefined" ? 0 : window.scrollY
  const top = isPageScrollLocked() ? Number.parseFloat(document.body.style.top) : Number.NaN
  return Number.isNaN(top) ? window.scrollY : -top
}

// Whether the page has anything to lock: it is scrolled, or it is taller than the window. A desktop
// board is the one-thread pane, one window tall (`h-dvh overflow-hidden`), so it has none; a status list
// longer than the window, a brand-new project's page and the phone's board can. App takes the lock only
// when this is true (see App.tsx for why pinning a page with nothing to scroll is not free).
export function pageHasScrollRange(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined" || !document.documentElement) return false
  return window.scrollY > 0 || document.documentElement.scrollHeight > window.innerHeight
}

export function isPageScrollLocked(): boolean {
  return typeof document !== "undefined" && document.body?.style.position === "fixed"
}

// Scroll the LOCKED page by `delta`, as an unlocked page would be scrolled: the pinned body moves by it,
// so what is on screen under the overlay holds still (lib/readerPin: a row arriving above the reader
// while a thread is open over the phone's list). The unlock restores the offset the body then holds.
export function shiftLockedPage(delta: number): void {
  if (!isPageScrollLocked()) return
  document.body.style.top = `-${Math.max(0, pageScrollY() + delta)}px`
}
