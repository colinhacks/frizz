import type { ThreadView } from "@frizz/shared"
import { isActivelyRunning, isChildThread } from "@frizz/shared"
import { partitionBoard } from "./boardPartition.ts"

// CHILD THREADS UNDER THEIR PARENT — which of a thread's children are drawn beneath it, and how each reads.
//
// A child (`frizzctl spawn-child`, shared isChildThread) is no row of its own on the board: the bands
// drop it (shared drawnUnderParent), and it is drawn under the thread that started it instead, wherever
// that thread's sub-agents are drawn — the rail's indented rows (Sidebar SubAgentRows), the counts over
// its prompt box and their panel (lib/threadOps, QueueOpsSummary), and the full page's rail (FocusRail).
// This module is the one answer all of them read.
//
// EVERY CHILD THAT IS STILL OPEN is listed, at rest or working: a child's rest is a handoff its parent
// has to read and answer, so a rested child is unresolved work hanging off the parent the way a rested
// sub-agent is. An ARCHIVED child is not listed (it is finished, and it has no band either, so it is
// reached from its parent's transcript), unless it is actively running — a running thread is never
// hidden as finished (shared isActivelyRunning's rule for Done). A child at a hard gate is listed here
// AND queues as a card of its own: under its parent the row says the parent's work is held on the human.

/** Is this child still listed under its parent? */
export function listedChildThread(t: ThreadView): boolean {
  return t.state !== "archived" || isActivelyRunning(t)
}

/** A child's row state, in the child-row vocabulary (ChildOpRow): `running` while it works — its turn in
 *  flight, or at rest with a sub-agent of its own still going — `stale` once its worker crashed, and
 *  `rested` otherwise (its rest went to its parent, or it waits on the human). */
export function childThreadState(t: ThreadView): "running" | "stale" | "rested" {
  if (isActivelyRunning(t)) return "running"
  if (t.crashed) return "stale"
  return "rested"
}

/** The instant a running child's current stretch of work began — the turn the newest message started —
 *  else its dispatch. Absent at rest: a rested child's row carries no running clock. */
export function childThreadStartedAt(t: ThreadView): string | undefined {
  if (!isActivelyRunning(t)) return undefined
  return t.lastUserAt ?? t.spawnedAt
}

// Built once per threads array, from the LIVE threads only: a child is never settled
// (lib/boardPartition settledThread), so the Done history a board carries is never walked for this.
const indexes = new WeakMap<readonly ThreadView[], ReadonlyMap<string, readonly ThreadView[]>>()

/** Every listed child on the board, by its parent's id, oldest dispatch first. */
export function childThreadIndex(threads: readonly ThreadView[]): ReadonlyMap<string, readonly ThreadView[]> {
  const hit = indexes.get(threads)
  if (hit) return hit
  const out = new Map<string, ThreadView[]>()
  for (const t of partitionBoard(threads).live) {
    if (!isChildThread(t) || !listedChildThread(t)) continue
    const list = out.get(t.parentSlug!)
    if (list) list.push(t)
    else out.set(t.parentSlug!, [t])
  }
  for (const list of out.values()) list.sort((a, b) => (a.spawnedAt ?? "").localeCompare(b.spawnedAt ?? "") || a.id.localeCompare(b.id))
  indexes.set(threads, out)
  return out
}

const NONE: readonly ThreadView[] = Object.freeze([]) as readonly ThreadView[]

/** The listed children of `parent` on this board, oldest first. */
export function childThreadsOf(threads: readonly ThreadView[], parent: string): readonly ThreadView[] {
  return childThreadIndex(threads).get(parent) ?? NONE
}
