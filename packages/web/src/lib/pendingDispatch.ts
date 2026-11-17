import { useMemo } from "react"
import { proxy, useSnapshot } from "valtio"
import { keyProject, splitThreadKey, threadKey } from "./threadKey.ts"

// A DISPATCH THE SERVER HAS NOT SHOWN YET — the thread a prompt box just started, between the click and
// the board delta that carries its row.
//
// The prompt box used to say so with a card of its own ("Starting thread…" over the prompt's text), set
// between the box and the rail. That card took height for exactly as long as the dispatch call ran and
// then gave it back, so everything under it moved twice for one new row. Recorded on a project's
// sidebar, 2026-10-13 (three runs, a local stack whose dispatch answers in about half a second):
//
//   +13-22ms    the card mounts: the Queue label and every row move DOWN 73px
//   +485-580ms  the board delta lands first: the Running row appears UNDER the still-mounted card
//   +494-594ms  the call answers, the card unmounts: every row moves back UP 73px
//
// In the stacked layout (≤800px, the sidebar above the queue) the queue's cards made the same round
// trip. A real provider's dispatch takes seconds rather than half of one, so the rail sat shoved down
// for all of it.
//
// So the pending thread is kept HERE, where the rail can read it, and the rail draws it as the Running
// row it is about to become (StartingRow in Sidebar.tsx): one row appears at the click, and the real
// one takes its place without anything moving.
//
// THE CONSOLE'S RAIL does the same (ConsoleSidebar.tsx). Its card was taller, 81px for the project chip's
// longer prompt line, so the round trip there was 93px, in either grouping (three runs each). Grouped by
// status the row leads the Running band wearing its project's square; grouped by project it leads its
// own project's running rows, and a project with nothing on the Console opens its block at the click
// (lib/consoleBoard.ts projectBlocks) instead of when the row lands.
//
// THE FIRST-RUN FORM has no rail to draw a row in, and keeps the card: it is the one thing on that screen
// that still shows what was asked. But the form is centred in the window, so a card in flow lifted the
// heading, the status row and the box 36-37px for the length of the call. It is drawn out of flow there,
// hung under the form (DispatchForm `pendingCard="float"`). The same shape as lib/steering.ts and
// lib/optimisticArchive.ts — a hint that asserts what the server is about to report and yields the
// moment it does.
export interface PendingDispatchEntry {
  key: number
  /** The Console scope the dispatch went to; undefined on a project's own page (lib/projectScope). */
  project: string | undefined
  backend: string
  model: string
  /** The thread's slug, once the dispatch call has answered. On the Console, its key. */
  slug?: string
}

const pending = proxy({ list: [] as PendingDispatchEntry[] })
// The board's thread ids at the moment of each dispatch, kept out of the proxy: a Set is not something
// valtio should wrap, and nothing renders from it directly.
const knownAt = new Map<number, ReadonlySet<string>>()
const expiries = new Map<number, ReturnType<typeof setTimeout>>()
let nextKey = 1

// How long an ANSWERED dispatch may stay pending for a board delta that has not come. The delta is
// published by the dispatch handler itself, so it normally lands within a frame or two of the answer
// (and usually before it); past this the row is a guess nobody should be looking at.
export const DISPATCH_LANDING_MS = 5_000

function drop(key: number): void {
  const timer = expiries.get(key)
  if (timer !== undefined) { clearTimeout(timer); expiries.delete(key) }
  knownAt.delete(key)
  const at = pending.list.findIndex((entry) => entry.key === key)
  if (at >= 0) pending.list.splice(at, 1)
}

/** A dispatch call is going out. `known` is every thread id the board holds right now. */
export function beginDispatch(entry: Omit<PendingDispatchEntry, "key" | "slug">, known: ReadonlySet<string>): number {
  const key = nextKey++
  knownAt.set(key, known)
  pending.list.push({ ...entry, key })
  return key
}

/** The call answered with the thread's slug. The entry stays until the board shows that thread. */
export function dispatchAnswered(key: number, slug: string): void {
  const entry = pending.list.find((candidate) => candidate.key === key)
  if (!entry) return
  entry.slug = slug
  expiries.set(key, setTimeout(() => drop(key), DISPATCH_LANDING_MS))
}

/** The call failed: no thread is coming. */
export function dispatchFailed(key: number): void {
  drop(key)
}

/**
 * The id the board shows an answered dispatch under. On a project's page that is the slug the call
 * answered with. On the Console the board's ids are keys (lib/threadKey), and the call already answers
 * with one (api/rpc.ts rekeyOutput); a bare slug is keyed here all the same, so the match never depends
 * on which of the two a caller was handed.
 */
function landedId(entry: PendingDispatchEntry): string | undefined {
  return entry.slug === undefined ? undefined : dispatchedThreadId(entry.project, entry.slug)
}

/** The board id of the thread a dispatch to `project` (undefined on a project's own page) answered with. */
export function dispatchedThreadId(project: string | undefined, slug: string): string {
  return project === undefined || splitThreadKey(slug) ? slug : threadKey(project, slug)
}

/**
 * The pending dispatches the board does not show yet, oldest first.
 *
 * An ANSWERED dispatch is matched by its slug. One still in flight has no slug, and the board delta that
 * carries its row usually beats the call's own answer, so it is matched by any thread the board has gained
 * since it was sent — each such thread claimed by one dispatch, oldest first. Without that the row would
 * be drawn twice (the stand-in and the real one) until the call answered.
 *
 * ON THE CONSOLE the board is every project's, its ids are keys, and each dispatch went to one project
 * (`entry.project`). So an answered dispatch is matched by its KEY, and one in flight only by a thread
 * its own project has gained: a thread that starts in another project meanwhile is not this one's row.
 */
export function unlandedDispatches(
  entries: readonly PendingDispatchEntry[],
  boardIds: ReadonlySet<string>,
  known: (key: number) => ReadonlySet<string> | undefined = (key) => knownAt.get(key),
): PendingDispatchEntry[] {
  const claimed = new Set(entries.flatMap((entry) => landedId(entry) ?? []))
  return entries.filter((entry) => {
    const own = landedId(entry)
    if (own !== undefined) return !boardIds.has(own)
    const before = known(entry.key)
    for (const id of boardIds) {
      if (before?.has(id) || claimed.has(id) || keyProject(id) !== entry.project) continue
      claimed.add(id)
      return false
    }
    return true
  })
}

/** This surface's pending dispatches (`project` as useProjectScope gives it). */
export function usePendingDispatches(project: string | undefined): readonly PendingDispatchEntry[] {
  const list = useSnapshot(pending).list as readonly PendingDispatchEntry[]
  return useMemo(() => list.filter((entry) => entry.project === project), [list, project])
}

/** The Console's pending dispatches: every project's, each naming the project its chip pointed at. */
export function useConsolePendingDispatches(): readonly PendingDispatchEntry[] {
  const list = useSnapshot(pending).list as readonly PendingDispatchEntry[]
  return useMemo(() => list.filter((entry) => entry.project !== undefined), [list])
}
