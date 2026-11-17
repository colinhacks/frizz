import { subscribe } from "valtio"
import { openThread, store, threadSnapshotBySlug, topThreadSlug } from "../store.ts"
import { DISPATCH_LANDING_MS } from "./pendingDispatch.ts"

// THE THREAD THE HUMAN STARTS IS THE THREAD THEY ARE LOOKING AT (maintainer 2026-11-17: "When you start a new
// thread, it should remain open. The fact that it currently just shows up in running is a bit of a vestige
// of the old queue based UI"). Until then a dispatch left the screen as it stood: beside the queue's cards
// that was the point, and the new thread was a Running row and a toast's "Open thread". It opens where a
// click on its row opens it (openThread: the pane on a desktop board, a drawer on a phone), once the board
// holds the row. Before that the pane has nothing to draw it from, and would call it missing.
//
// UNLESS THE HUMAN HAS MOVED ON. The call answers in about a second, and in minutes when a first thread
// waits on its runtime's download; opened over a thread they picked meanwhile, it would take that one from
// under them. So what is on screen is read at the click and again when the thread lands, and it opens only
// if nothing changed, or if what changed was an earlier dispatch opening its own thread: two prompts sent
// back to back end on the second.

/** What is on screen, as far as a landing dispatch is concerned: the view, and the thread open in it. */
export function screenNow(): string {
  return `${store.view}\n${topThreadSlug() ?? ""}`
}

// The screen the latest of these openings left.
let openedScreen: string | null = null

function unmoved(screenAtClick: string): boolean {
  const now = screenNow()
  return now === screenAtClick || now === openedScreen
}

function open(id: string): void {
  openThread(id)
  openedScreen = screenNow()
}

/**
 * Open the thread a dispatch started — `id` as the board names it (pendingDispatch dispatchedThreadId) — as
 * soon as the board shows it, if the screen still stands as it did at the click (`screenAtClick`, from
 * screenNow). True when it opened or will once the row lands; false when the human had already moved on.
 */
export function openStartedThread(id: string, screenAtClick: string): boolean {
  if (!unmoved(screenAtClick)) return false
  if (threadSnapshotBySlug(id)) {
    open(id)
    return true
  }
  // The board delta that carries the row usually beats the call's answer, and is given as long to land as
  // the rail's stand-in row is (DISPATCH_LANDING_MS).
  const unsubscribe = subscribe(store, () => {
    if (!threadSnapshotBySlug(id)) return
    stop()
    if (unmoved(screenAtClick)) open(id)
  })
  const timer = setTimeout(stop, DISPATCH_LANDING_MS)
  function stop(): void {
    clearTimeout(timer)
    unsubscribe()
  }
  return true
}
