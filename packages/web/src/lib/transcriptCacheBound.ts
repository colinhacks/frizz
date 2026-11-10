import type { Query, QueryClient } from "@tanstack/react-query"

// A BOUND ON THE TRANSCRIPTS NOBODY IS LOOKING AT.
//
// A transcript stays in the query cache for REVISIT_GC_MS (30 minutes, hooks.ts) after the last surface
// showing it goes away, so that going back to a thread you just read paints from cache instead of
// re-reading it. That was sized for a board where you open a handful of threads. The Console's pane walks
// the queue one thread after another, and every thread it passes over stays cached for half an hour, each
// one's full latest page: tool output, commands, file reads. Walking a queue of 52 on a copy of the real
// boards held every one of them, about 1.5-3 MB apiece; the cache, not the board, was the page's memory
// (heap snapshots, 2026-11-09).
//
// So the cache keeps the RETAINED_TRANSCRIPTS most recently seen transcripts that no surface shows, and
// lets the rest go at once rather than at the half hour. A revisit to one of those still paints from cache;
// one further back reads the thread again, as a first visit does. A transcript ON SCREEN is never touched:
// only entries with no observer are counted or removed, and a removal re-reads nothing.
export const RETAINED_TRANSCRIPTS = 8

function isTranscript(query: Query): boolean {
  return query.queryKey[0] === "transcript"
}

/**
 * Hold the unobserved transcripts in `client`'s cache to the `max` most recently seen. Returns the
 * unsubscribe. Called once, beside the client (main.tsx).
 */
export function boundTranscriptCache(client: QueryClient, max = RETAINED_TRANSCRIPTS): () => void {
  const cache = client.getQueryCache()
  // When each transcript was last on screen (or arrived, for one warmed ahead of its surface).
  const seen = new WeakMap<Query, number>()
  let tick = 0
  let pending = false
  const trim = () => {
    pending = false
    const idle = cache.getAll().filter((q) => isTranscript(q) && q.getObserversCount() === 0)
    if (idle.length <= max) return
    idle.sort((a, b) => (seen.get(a) ?? 0) - (seen.get(b) ?? 0))
    for (const query of idle.slice(0, idle.length - max)) cache.remove(query)
  }
  return cache.subscribe((event) => {
    const query = event.query
    if (!isTranscript(query)) return
    if (event.type === "added" || event.type === "observerAdded" || query.getObserversCount() > 0) seen.set(query, ++tick)
    if (event.type !== "added" && event.type !== "observerRemoved") return
    // Never inside the cache's own notification: remove after it has finished telling everyone else.
    if (!pending) {
      pending = true
      queueMicrotask(trim)
    }
  })
}
