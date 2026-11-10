import { useRef } from "react"

// A DERIVED VALUE THAT KEEPS ITS IDENTITY WHILE ITS CONTENT DOES.
//
// A `useMemo` over the transcript's messages hands back a new object every time a message arrives,
// whether or not what it computed moved. Handed to every transcript message as a prop, that new object
// is a changed prop for all of them, and `memo(Message)` re-renders the lot.
//
// Measured on a real stack with a scripted worker (2026-11-10): one 14-second turn of eight tool calls,
// with five messages mounted at its start and nine at its end, rendered the message body 114 and 119
// times. Of 114, the memo saw `questionHomes` change 109 times and `fenceQuestions` 61, on a thread
// with no question at all: an empty map and an empty list, rebuilt. A message itself changed 13 times.
// With those two held by this hook the same turn rendered 18, twice.
//
// Two more things reached every message and each had to go as well, or the count stayed high: a
// `thread` prop the message never read (82 renders with it alone put back) and the surface's whole send
// scope, read through a context (57; lib/sendScope.tsx ComposerSendContext).
//
// A thread with an open question had a second layer of the same thing. The board hands over new question
// rows on every delta of the thread, and the maps derived from them (the questions standing at each
// message, the ones placed in it) were new lists per push: 95 renders for the same turn, and 20 once
// the rows are shared by content and each map keeps a key's list while its items are the same
// (`shareMap`, and components/ThreadSurface.tsx, which is where all of it is applied).

/** `previous` while `next` is equal to it, else `next`. */
export function sameWhileEqual<T>(previous: T, next: T, equal: (a: T, b: T) => boolean): T {
  return previous === next || equal(previous, next) ? previous : next
}

/**
 * What the last render held, shared into this render's value by `share`, which returns `previous`
 * itself when nothing moved and otherwise `next` with whatever parts of `previous` are unchanged.
 * What it returns always equals `next`, so a render React throws away can cost one extra identity,
 * never a wrong value.
 */
export function useShared<T>(next: T, share: (previous: T, next: T) => T): T {
  const held = useRef(next)
  held.current = share(held.current, next)
  return held.current
}

/** The value of the last render for as long as this render's is equal to it. */
export function useSameWhileEqual<T>(next: T, equal: (a: T, b: T) => boolean): T {
  return useShared(next, (previous, now) => sameWhileEqual(previous, now, equal))
}

/**
 * A map whose values are rebuilt on every push (the questions standing at each message, the answers
 * paired with it), sharing with the map before it: each key keeps the value it had while `same` says
 * the new one is the same, and the map itself is kept while every key did. Each message is handed its
 * own key's value, so this is what lets the messages a push did not touch skip it.
 */
export function shareMap<K, V, M extends ReadonlyMap<K, V>>(previous: M, next: M, same: (a: V, b: V) => boolean): M {
  if (previous === next) return previous
  let moved = previous.size !== next.size
  const shared = new Map<K, V>()
  for (const [key, value] of next) {
    const before = previous.get(key)
    const kept = previous.has(key) && same(before as V, value)
    if (!kept) moved = true
    shared.set(key, kept ? (before as V) : value)
  }
  return moved ? (shared as unknown as M) : previous
}

/** `shareMap` for a map of lists: a key keeps its list while the new one holds the identical items. */
export function shareLists<K, T, M extends ReadonlyMap<K, readonly T[]>>(previous: M, next: M): M {
  return shareMap<K, readonly T[], M>(previous, next, sameItems)
}

/** Two maps with the same keys, each holding the identical value. */
export function sameEntries<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) if (!b.has(key) || !Object.is(b.get(key), value)) return false
  return true
}

/** Two lists of the identical items in the same order, or neither a list. */
export function sameItems<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (!a || !b) return a === b
  return a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
}
