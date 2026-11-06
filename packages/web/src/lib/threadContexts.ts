import { createContext } from "react"
import type { QueuedRun } from "./restReply.ts"

// The contexts a thread surface provides to everything drawn inside it. They are provided in ONE place,
// components/ThreadSurface.tsx, and defined here rather than there so a consumer deep in the transcript
// imports no component to read one.

// The thread slug the current message tree belongs to — set by the thread's surface so a nested
// AgentBlock can resolve its live tracked sub-agent (for the "running Nm" header + drill-in drawer)
// without threading the slug through every intermediate. Null in trees that are not a thread's own
// surface (a sub-agent's transcript, a fixture) → AgentBlocks there render as plain (non-live) prompt
// cards, and a done/awaiting fence card draws no confirm button.
export const ThreadSlugContext = createContext<string | null>(null)

/** How a surface that leaves the page when its thread is handed back does so. See QueueDismissContext. */
export interface SurfaceExit {
  dismiss: () => void
  cancel: () => void
  // What a SEND does, where that differs from dismissing (prototype, the one-thread pane): a thread the
  // human just replied to may stay on screen, while Done and Snooze always move on. Absent ⇒ a send
  // dismisses, which is the queue card.
  sent?: () => void
}

// A QUEUE card provides this so any in-transcript dismissal control — the ```done fence's Mark-as-done
// button, the ```awaiting fence's park button — routes its OWN card through the queue's user-initiated
// exit (fade → auto-scroll the next card to the viewport top) instead of the passive board-departure
// "hold a neighbour in place" path. `dismiss` is exactly the card's `onResolve(slug)`; `cancel` reinstates
// an OPTIMISTICALLY dismissed card (its `onUnresolve(slug)`) when the completion RPC declines — reached
// without threading either through the fence renderer. Null off the queue (the thread drawer), where there
// is no queue to scroll — there the fence buttons behave as before (archive/snooze, no scroll).
export const QueueDismissContext = createContext<SurfaceExit | null>(null)

// The surface's queued tail, as the one Send now under it reads it (lib/restReply queuedRunOf). Its own
// context, with a value that changes only when the counts do, so the control does not re-render on
// every message the transcript's context carries. Null outside a surface.
export const QueuedRunContext = createContext<QueuedRun | null>(null)
