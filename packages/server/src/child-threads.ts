// CHILD THREADS (Settings.childThreads, 2026-11-04) — the facts about a thread's children that the board
// and the scheduler both read, so the two cannot disagree about whether a parent's `threads:` park holds.
//
// A child is an ordinary thread whose row names the thread that spawned it (SessionRow.parent_slug). The
// rest of the feature lives where its rule does: the queue rule in board.ts (deriveChildHandoff), the
// delivery in scheduler.ts (SOURCE 17), the spawn in router.ts (`spawnChild`).
import type { SessionRow } from "./storage.ts"

/** The tailer reading these rules need: is the child mid-turn, and when did it last speak. */
export interface ChildTelemetry {
  turn?: string
  lastAssistantAt?: string
}

/** Every thread's children, by parent slug, from one pass over the registry. */
export function childrenByParent(rows: readonly SessionRow[]): ReadonlyMap<string, readonly SessionRow[]> {
  const out = new Map<string, SessionRow[]>()
  for (const row of rows) {
    if (!row.parent_slug) continue
    const list = out.get(row.parent_slug)
    if (list) list.push(row)
    else out.set(row.parent_slug, [row])
  }
  return out
}

/**
 * The children a parent may still be waiting on — what a `threads: [slug]` line in its ```awaiting fence
 * is checked against. A child is LIVE while it is working, or resting on a rest whose handoff has not yet
 * reached its parent (a quiet park of its own, or a handoff the scheduler has still to deliver). Once its
 * latest rest has been reported (child_reported_at), the parent has been woken with it, so a park that
 * still names the child is waiting on nothing.
 *
 * An archived child is never live: nothing wakes it, so nothing it does can end the wait.
 */
export function liveChildThreads(
  children: readonly SessionRow[],
  teleOf: (slug: string) => ChildTelemetry | undefined,
): Set<string> {
  const live = new Set<string>()
  for (const child of children) {
    if (child.state === "archived" || child.archived === 1) continue
    const tele = teleOf(child.slug)
    if (tele?.turn === "idle" && reported(child, tele.lastAssistantAt)) continue
    live.add(child.slug)
  }
  return live
}

/** Has the rest at `restAt` already been handed to the parent? */
function reported(child: Pick<SessionRow, "child_reported_at">, restAt: string | undefined): boolean {
  if (!child.child_reported_at || !restAt) return false
  return Date.parse(child.child_reported_at) >= Date.parse(restAt)
}
