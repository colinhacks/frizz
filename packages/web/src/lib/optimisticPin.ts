import { useMemo } from "react"
import { proxy, subscribe, useSnapshot } from "valtio"
import type { ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { store, threadSnapshotBySlug } from "../store.ts"
import type { PinShelf } from "../groups.ts"
import { overlayEach, plainEntries } from "./steering.ts"

// A PIN MOVES THE ROW ON THE CLICK. The rail's bands are derived from the board, and the board learns a
// pin only from the delta the server sends once it has stored it, so the row sat in its old band with
// its pin button greyed out until then: 30-70ms on an idle scripted stack (2026-11-18), a round trip plus
// a board rebuild on a loaded one. The same wait lib/steering.ts and lib/optimisticArchive.ts took out of
// a steer and a Mark as done.
//
// So the click writes the pin's own field here, by shelf and thread, and every surface that derives bands
// folds it in with the other two overlays (useOptimisticallyPinned): the row lands in the band truth will
// put it in, and the button flips with it. The hint is let go when the board agrees (or 12s after the
// server took it, whatever the board says), and at once if the server refuses, which puts the row back.
// The click's instant is the pin's place on the shelf, the bottom, where the server's own stamp puts it.

type PinHints = Record<string, string | null>

/** Per shelf, per thread: the instant pinned at, or null for unpinned. */
const hints = proxy<{ board: PinHints; console: PinHints }>({ board: {}, console: {} })

/** How long a pin the server took may stand in for a board that has not shown it. */
const LANDING_MS = 12_000

/** Each thread's writes in the order they were clicked, so a quick pin-then-unpin is stored as unpinned. */
const writes = new Map<string, Promise<unknown>>()

function field(shelf: PinShelf): "pinnedAt" | "consolePinnedAt" {
  return shelf === "console" ? "consolePinnedAt" : "pinnedAt"
}

function agrees(t: ThreadView | undefined, shelf: PinShelf, pinned: boolean): boolean {
  return t !== undefined && (typeof t[field(shelf)] === "string") === pinned
}

/** Pin or unpin `t` on `shelf`, shown at once. Rejects as the server does, with the row put back. */
export async function setPinned(t: Pick<ThreadView, "id" | "sessionId">, shelf: PinShelf, pinned: boolean): Promise<void> {
  const id = t.id
  const hint = pinned ? new Date().toISOString() : null
  hints[shelf][id] = hint
  const input = { slug: id, sessionId: t.sessionId ?? "", pinned }
  const key = `${shelf}\n${id}`
  const write = (writes.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => (shelf === "console" ? rpc.setThreadConsolePinned(input) : rpc.setThreadPinned(input)))
  writes.set(key, write)
  try {
    await write
  } catch (error) {
    drop(shelf, id, hint)
    throw error
  } finally {
    if (writes.get(key) === write) writes.delete(key)
  }
  // A thread the board does not hold has no row to move, so there is nothing to hold for it.
  const landed = () => {
    const now = threadSnapshotBySlug(id)
    return now === undefined || agrees(now, shelf, pinned)
  }
  if (landed()) return drop(shelf, id, hint)
  const unsubscribe = subscribe(store, () => {
    if (landed()) release()
  })
  const timer = setTimeout(release, LANDING_MS)
  function release(): void {
    clearTimeout(timer)
    unsubscribe()
    drop(shelf, id, hint)
  }
}

/** Let go of `hint` for `id`, unless a later click has taken its place. */
function drop(shelf: PinShelf, id: string, hint: string | null): void {
  if (hints[shelf][id] === hint) delete hints[shelf][id]
}

/** The pin a click from this tab holds for thread `id` on `shelf`: an instant, null for unpinned, or undefined. */
export function heldPin(shelf: PinShelf, id: string): string | null | undefined {
  return hints[shelf][id]
}

// THE overlay: the pin's own field, as the server will report it, so every predicate that reads it
// (isPinned, isConsolePinned, sectionThreads, boardQueuedThread, the Console's shelf) reaches the
// conclusion truth will. A thread whose field already agrees comes back BY IDENTITY.
export function optimisticallyPinned(t: ThreadView, board: string | null | undefined, onConsole: string | null | undefined): ThreadView {
  let next = t
  if (board !== undefined && !agrees(t, "board", board !== null)) {
    const { pinnedAt: _, ...rest } = next
    next = board === null ? rest : { ...rest, pinnedAt: board }
  }
  if (onConsole !== undefined && !agrees(t, "console", onConsole !== null)) {
    const { consolePinnedAt: _, ...rest } = next
    next = onConsole === null ? rest : { ...rest, consolePinnedAt: onConsole }
  }
  return next
}

/** The overlay across a board's threads; with no pin in flight the input array itself comes back. */
export function useOptimisticallyPinned(threads: readonly ThreadView[]): ThreadView[] {
  const snap = useSnapshot(hints)
  const board = snap.board as PinHints
  const onConsole = snap.console as PinHints
  return useMemo(() => {
    const boardHints = plainEntries(board)
    const consoleHints = plainEntries(onConsole)
    if (boardHints.size === 0 && consoleHints.size === 0) return threads as ThreadView[]
    return overlayEach(threads, (t) => optimisticallyPinned(t, boardHints.get(t.id), consoleHints.get(t.id)))
  }, [threads, board, onConsole])
}
