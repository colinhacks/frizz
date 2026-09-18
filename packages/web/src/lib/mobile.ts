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
// wide enough that every phone in portrait and most in landscape get the phone shell, narrow enough
// that a small window on a desktop keeps the layout its user knows.
export const MOBILE_MAX_PX = 700
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_PX}px)`

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
