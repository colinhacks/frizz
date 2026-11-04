import type { ThreadView } from "@frizz/shared"
import { drawnUnderParent, isActivelyRunning } from "@frizz/shared"

// THE BOARD, SPLIT ONCE PER STATE INTO THE THREADS THAT CAN STILL MOVE AND THE ONES THAT CANNOT.
//
// A board holds every thread its project ever finished, and almost all of them are SETTLED: archived,
// at rest, unpinned, nothing in flight. Every derivation the board page runs on a delta walked all of
// them anyway — the queue's filter, the rail's sections, its external band, the steer overlay — each
// asking a settled thread a question whose answer cannot have changed. At 5,000 threads those walks were
// ~3ms of every delta of a streaming turn (CPU profile, production bundle, 2026-10-14: queuedThreadsNow
// 0.8ms, sectionThreads 0.8, the steer overlay 0.6, externalThreads 0.4, sectionOf 0.3).
//
// So the partition is kept, per threads array, and carried from one array to the next: a delta replaces
// a few slots (store.ts plainArray), and when none of them is or becomes settled, the settled list is the
// SAME array as before and only the live slots are re-read. Finding the replaced slots is one identity
// comparison per slot, with nothing allocated and nothing asked of the thread. A slot that crosses the
// line (a thread archived or reopened) or an array of another length builds the partition afresh.
//
// A settled thread answers every derivation that reads this the same way, which is what lets each skip
// them (and what the tests in boardPartition.test.ts pin against each derivation):
//   · queued (shared queuedThread) — false: it is archived.
//   · sectionOf — "inactive", the Done band: a session, archived, not actively running; and it is not
//     pinned (sectionThreads diverts a pin before sectionOf) nor foreign (dropped before).
//   · externalThreads — not foreign.
//   · optimisticallySteered with no stamp of its own — itself: no delivery in flight.
// A CHILD THREAD is never settled, archived or not: sectionOf answers null for it, not "inactive"
// (shared drawnUnderParent), so it must reach the derivations that drop it rather than be filed as Done.
// It stays live for the index that draws it under its parent (lib/childThreads.ts), which reads `live`.
export function settledThread(t: ThreadView): boolean {
  return (
    t.kind === "session" &&
    t.foreign !== true &&
    typeof t.pinnedAt !== "string" &&
    !drawnUnderParent(t) &&
    t.state === "archived" &&
    t.deliveryInFlight !== true &&
    !isActivelyRunning(t)
  )
}

export interface BoardPartition {
  /** Every thread that is not settled, in board order. */
  readonly live: readonly ThreadView[]
  /** The board positions of `live`, in the same order. */
  readonly liveAt: readonly number[]
  /** The settled threads, in board order. The same array for as long as none of them changes. */
  readonly settled: readonly ThreadView[]
}

interface Kept extends BoardPartition {
  readonly threads: readonly ThreadView[]
  readonly settledAt: Uint8Array
}

const partitions = new WeakMap<readonly ThreadView[], Kept>()
let last: Kept | undefined

export function partitionBoard(threads: readonly ThreadView[]): BoardPartition {
  const hit = partitions.get(threads)
  if (hit) return hit
  const kept = carried(threads) ?? build(threads)
  partitions.set(threads, kept)
  last = kept
  return kept
}

function carried(threads: readonly ThreadView[]): Kept | undefined {
  const prev = last
  if (!prev || prev.threads.length !== threads.length) return undefined
  for (let i = 0; i < threads.length; i++) {
    const t = threads[i]!
    if (t === prev.threads[i]) continue
    if (prev.settledAt[i] === 1 || settledThread(t)) return undefined
  }
  return { threads, live: prev.liveAt.map((i) => threads[i]!), liveAt: prev.liveAt, settled: prev.settled, settledAt: prev.settledAt }
}

function build(threads: readonly ThreadView[]): Kept {
  const live: ThreadView[] = []
  const liveAt: number[] = []
  const settled: ThreadView[] = []
  const settledAt = new Uint8Array(threads.length)
  for (let i = 0; i < threads.length; i++) {
    const t = threads[i]!
    if (settledThread(t)) {
      settled.push(t)
      settledAt[i] = 1
    } else {
      live.push(t)
      liveAt.push(i)
    }
  }
  return { threads, live, liveAt, settled, settledAt }
}
