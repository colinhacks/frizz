import { useSyncExternalStore } from "react"

// THE PHONE BREAKPOINT, and why it is not the 800px one the layout already uses.
//
// The app has had a `max-[800px]` stack point for a long time: below it the sidebar and the workpane
// stop sitting side by side and stack vertically. That is a TABLET layout — the same surfaces, one
// above the other — and it is unchanged by anything here.
//
// This is a different question: below what width does the desktop's information model stop working at
// all? A 390pt viewport cannot hold a rail AND a workpane in any arrangement, so the phone gets its own
// shell (nav bar → one list → tab bar) rather than a squeezed one. 700px is where that switch happens:
// wide enough that every phone in portrait gets the phone shell, narrow enough that a small window on a
// desktop keeps the layout its user knows.
//
// A PHONE ON ITS SIDE IS WIDER THAN ANY WIDTH THAT COULD SAY SO, so the second half of the query finds it
// by what it is: a touch screen with no height. Every phone since 2020 is 844 to 956px wide in landscape
// and at most 440px tall, where the width alone handed it the desktop shell: a rail, a sidebar whose
// prompt box left room for two queue rows, and a pane of mouse-sized controls, in 393px of height
// (measured 2026-11-19 at 852x393). 500px is under every tablet's landscape height, and a desktop's
// short window keeps its layout because its pointer is fine. The on-screen keyboard does not move the
// answer: browsers shrink the visual viewport for it, and the query reads the layout viewport.
//
// THE SAME QUERY IS SPELLED TWICE MORE in styles.css: the `phone:` variant every phone-only class uses,
// and the rule that makes a sheet the whole screen. Change the three together.
export const MOBILE_MAX_PX = 700
export const MOBILE_LANDSCAPE_MAX_HEIGHT_PX = 500
/** A phone held sideways, by itself: for a query that already has its own width (ui/Sheet's narrow drawer). */
export const MOBILE_LANDSCAPE_QUERY = `(pointer: coarse) and (max-height: ${MOBILE_LANDSCAPE_MAX_HEIGHT_PX}px)`
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_PX}px), ${MOBILE_LANDSCAPE_QUERY}`

const listeners = new Set<() => void>()
let media: MediaQueryList | null = null

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {}
  if (!media) {
    media = window.matchMedia(MOBILE_QUERY)
    // ONE MediaQueryList for the whole app, with the components subscribed to it — not one listener per
    // caller. Several surfaces ask this question (the shell, the grid, the status bar), and a query that
    // every one of them re-creates answers the same thing while costing a listener each.
    media.addEventListener("change", () => listeners.forEach((l) => l()))
  }
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function snapshot(): boolean {
  return media ? media.matches : typeof window !== "undefined" && !!window.matchMedia?.(MOBILE_QUERY).matches
}

/** The same answer as `useIsMobile`, for code outside React that acts on a click (lib/local-file-links). */
export function isMobileViewport(): boolean {
  return snapshot()
}

/**
 * Is this a phone-shaped viewport?
 *
 * `useSyncExternalStore` rather than a `useState` + effect pair: the effect version renders ONCE with
 * the wrong answer before it corrects itself, which on a cold load means the desktop shell mounts, binds
 * its sticky sidebar and its scroll spy, and is then thrown away — a visible flash of the wrong layout
 * on exactly the devices least able to afford it.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
