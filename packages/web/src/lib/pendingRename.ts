import { proxy, subscribe, useSnapshot } from "valtio"
import { displayTitle, type ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { store, threadSnapshotBySlug } from "../store.ts"

// A RENAME SHOWS THE NEW NAME FROM THE KEYSTROKE THAT COMMITS IT.
//
// The name every surface draws is the board's, and the board learns a rename only from the delta the
// server sends once it has stored it. So Enter closed the header's editor straight back onto the OLD name,
// which stood there, and in the rail row, until that delta came: 48ms on an idle scripted stack
// (2026-11-18), and a round trip plus a board rebuild on a loaded one.
//
// So the name typed is kept here, by the thread's board id, and the title the header, the rail row and the
// phone's header and row draw is this one while it is held. It is let go when the board carries it (or 5s
// after the server took it, whatever the board says), and at once if the server refuses it, which puts the
// old name back. The same shape as lib/steering.ts and lib/pendingDispatch.ts: a hint that asserts what the
// server is about to report and yields the moment it does.

const pending = proxy<Record<string, string>>({})

/** How long a rename the server took may stand in for a board that has not shown it. */
const LANDING_MS = 5_000

/** Rename thread `id` (as the board names it) to `title`. Rejects as the server does, with the old name back. */
export async function renameThread(id: string, title: string): Promise<void> {
  pending[id] = title
  try {
    await rpc.renameThread({ slug: id, title })
  } catch (error) {
    drop(id, title)
    throw error
  }
  // A thread the board does not hold has no name drawn from it, so there is nothing to hold for it.
  const landed = () => {
    const now = threadSnapshotBySlug(id)
    return now === undefined || now.title === title
  }
  if (landed()) return drop(id, title)
  const unsubscribe = subscribe(store, () => {
    if (landed()) release()
  })
  const timer = setTimeout(release, LANDING_MS)
  function release(): void {
    clearTimeout(timer)
    unsubscribe()
    drop(id, title)
  }
}

/** Let go of `title` for `id`, unless a later rename has taken its place. */
function drop(id: string, title: string): void {
  if (pending[id] === title) delete pending[id]
}

/** The name a rename from this tab holds for thread `id`, if one is waiting on the board. */
export function heldTitle(id: string): string | undefined {
  return pending[id]
}

/** The name to draw for `t`: the one a rename from this tab is waiting on, else the board's. */
export function useShownTitle(t: ThreadView | undefined): string {
  const held = useSnapshot(pending)[t?.id ?? ""]
  if (!t) return ""
  return held ?? displayTitle(t)
}
