import { proxy, useSnapshot } from "valtio"
import type { ThreadView } from "@frizz/shared"
import { activeBandThread, boardQueuedThread } from "@frizz/shared"
import { isConsolePinned, orderByInteraction, orderDone, orderQueue, orderRunning, queued, sectionOf } from "../groups.ts"
import type { QueueDirection } from "../groups.ts"
import { isConsolePath } from "./base-path.ts"
import type { PendingDispatchEntry } from "./pendingDispatch.ts"
import { partitionBoard } from "./boardPartition.ts"
import { keyProject } from "./threadKey.ts"

// THE CONSOLE'S BANDS AND ITS TWO GROUPINGS.
//
// The Console is a queue first: it draws the threads waiting on the operator (a project's Queue band,
// `queued`) and the ones in flight (its Running band, `activeBandThread`) — the same two predicates the
// rail counts with, so a square's badge and the Console's rows for that project agree.
//
// GROUPED BY STATUS, the bands hold every project's rows mixed, each row wearing its project's square,
// and Snoozed and Done follow Running, as on a project's board. Both are COLLAPSED until opened and then
// PAGED, BAND_PAGE rows at a time behind "Show more" (maintainer 2026-10-23: "Add both, both collapsed.
// They'll need pagination"): Done holds every project's history, so it is the longest list on the page.
// They were left out until then (2026-10-11: "I don't think those are worth including").
//
// GROUPED BY PROJECT, each project with anything waiting or running is one block, in the rail's order,
// its waiting rows first and its running rows after (RUNNING_CAP of them until asked for more). It has no
// Snoozed and no Done. The cards follow whichever the sidebar draws.
//
// PINS. "By status" has a shelf of its OWN (groups.ts isConsolePinned; maintainer 2026-10-19: "a
// separate pin system specifically for the By Status page"), apart from every project board's. A thread
// pinned there leaves Queue and Running for a Pinned band at the top, in the shelf's order, whatever its
// state — the project board's rule — and if it is waiting, its card leads the cards in that same order,
// so the card at the top is still the row at the top and the scroll marker still walks straight down
// the column. A project's own pins play no part in "By status". "By project" is each project's board in
// miniature, so it is the other way round there: nothing is lifted, and a row wears its board's pin in
// the band its state puts it in.

export type ConsoleGroup = "status" | "project"

const GROUP_KEY = "frizz:console-group"

/** How many running rows a project's block shows before "Show more". */
export const RUNNING_CAP = 3

function readGroup(): ConsoleGroup {
  try {
    return localStorage.getItem(GROUP_KEY) === "status" ? "status" : "project"
  } catch {
    return "project"
  }
}

/** "By status"'s bands that fold: Snoozed and Done. */
export type ConsoleFoldedBand = "snoozed" | "done"

/** How many rows an open Snoozed or Done band shows, and how many more each "Show more" adds. */
export const BAND_PAGE = 10

const state = proxy({
  group: typeof window === "undefined" ? ("project" as ConsoleGroup) : readGroup(),
  /** Projects whose running rows are expanded past RUNNING_CAP. This visit's, not remembered. */
  expanded: {} as Record<string, boolean>,
  /** How many rows each folded band shows; 0 is collapsed, the default. This visit's, not remembered. */
  shown: { snoozed: 0, done: 0 } as Record<ConsoleFoldedBand, number>,
})

export function useConsoleGroup(): ConsoleGroup {
  return useSnapshot(state).group
}

export function setConsoleGroup(group: ConsoleGroup): void {
  state.group = group
  try {
    localStorage.setItem(GROUP_KEY, group)
  } catch {
    // Not remembered, but it holds for this page.
  }
}

export function useRunningExpanded(project: string): boolean {
  return useSnapshot(state).expanded[project] === true
}

export function setRunningExpanded(project: string, expanded: boolean): void {
  state.expanded[project] = expanded
}

/** How many of a folded band's rows are drawn: 0 while it is collapsed. */
export function useBandShown(band: ConsoleFoldedBand): number {
  return useSnapshot(state).shown[band]
}

/** Open a folded band on its first page, or collapse it. Collapsing forgets the pages it had shown. */
export function toggleBand(band: ConsoleFoldedBand): void {
  state.shown[band] = state.shown[band] > 0 ? 0 : BAND_PAGE
}

/** "Show more": the band's next page. */
export function showMoreOfBand(band: ConsoleFoldedBand): void {
  state.shown[band] += BAND_PAGE
}

// Both bands are asked of the LIVE threads only (lib/boardPartition.ts): a settled thread is archived and
// at rest, so it is neither waiting nor running, and the merged board holds every project's Done
// history. Asking all of them was 0.9ms of every delta at 5,000 threads (CPU profile, a streaming turn
// with its drawer open on the Console), and it grew with each project's history.

// A PINNED THREAD'S REPORT LOSES ITS CARD ONLY WHERE A PINNED ROW SHOWS IT INSTEAD, so nothing is ever in
// neither place. On a project's board that is the board's pin (shared boardQueuedThread). On "By status"
// it is the Console's own pin, since a project's pin is no part of that view and its row sits on no shelf
// there. "By project" lifts nothing, whichever pin a thread wears, so a report keeps its card.
export function holdsCardOnConsole(t: ThreadView, group: ConsoleGroup): boolean {
  return queued(t) && !(group === "status" && t.plainReport === true && isConsolePinned(t))
}

/** Does this thread draw a queue card on the page on screen? `needsYou` says it is waiting to be read;
 *  this says where. A row with no card here opens a drawer instead of scrolling to one. */
export function holdsCardHere(t: ThreadView, group: ConsoleGroup = state.group): boolean {
  return isConsolePath() ? holdsCardOnConsole(t, group) : boardQueuedThread(t)
}

/** Every project's waiting threads with a card on `group`, in the queue's own order. */
export function consoleQueue(threads: readonly ThreadView[], direction: QueueDirection, group: ConsoleGroup): ThreadView[] {
  return orderQueue(partitionBoard(threads).live.filter((t) => holdsCardOnConsole(t, group)), direction)
}

/** The Console's shelf order: oldest pin first, the key on a tie (the project board's rule). */
function byConsolePin(a: ThreadView, b: ThreadView): number {
  return (a.consolePinnedAt ?? "").localeCompare(b.consolePinnedAt ?? "") || a.id.localeCompare(b.id)
}

// A Console-pinned thread that is archived and at rest is a SETTLED one (lib/boardPartition reads only
// the project pin), so the band asks the settled list too — once per settled array, which a delta
// almost never replaces, rather than walking every project's history on every delta.
const settledPins = new WeakMap<readonly ThreadView[], ThreadView[]>()

/** The Console's Pinned band: every thread pinned on the Console, in any state, in the shelf's order. */
export function consolePinned(threads: readonly ThreadView[]): ThreadView[] {
  const { live, settled } = partitionBoard(threads)
  let pinnedSettled = settledPins.get(settled)
  if (!pinnedSettled) settledPins.set(settled, (pinnedSettled = settled.filter(isConsolePinned)))
  return [...live.filter(isConsolePinned), ...pinnedSettled].sort(byConsolePin)
}

/** Every project's running threads, the one that most recently switched to running first — a project
 *  board's Running order (groups.ts orderRunning). */
export function consoleRunning(threads: readonly ThreadView[]): ThreadView[] {
  return orderRunning(partitionBoard(threads).live.filter(activeBandThread))
}

// SNOOZED AND DONE, "By status" only, so a Console pin lifts a row out of them as it does out of Queue and
// Running, and a project board's pin does not (it is no part of this view). Classified as a project board
// classifies them (groups.ts sectionThreads): sectionOf's "snoozed" and "inactive", foreign sessions never.

/** "By status"'s Snoozed band: every project's snoozed threads, the most recently active first. */
export function consoleSnoozed(threads: readonly ThreadView[]): ThreadView[] {
  return orderByInteraction(partitionBoard(threads).live.filter((t) => t.foreign !== true && !isConsolePinned(t) && sectionOf(t) === "snoozed"))
}

// The settled threads are nearly all of Done, and their list is the SAME array from one delta to the next
// (lib/boardPartition.ts), so they are filtered and sorted once per settled array rather than on every
// delta. A settled thread may still be pinned on the Console (the partition reads only the board's pin).
const settledDone = new WeakMap<readonly ThreadView[], ThreadView[]>()

/** "By status"'s Done band: every project's finished threads, the most recently finished first. */
export function consoleDone(threads: readonly ThreadView[]): ThreadView[] {
  const { live, settled } = partitionBoard(threads)
  let done = settledDone.get(settled)
  if (!done) settledDone.set(settled, (done = orderDone(settled.filter((t) => !isConsolePinned(t)))))
  // A live thread in Done is rare — one pinned on its project's board, or archived with a delivery still
  // in flight — so the merge sorts afresh only when there is one.
  const liveDone = live.filter((t) => t.foreign !== true && !isConsolePinned(t) && sectionOf(t) === "inactive")
  return liveDone.length === 0 ? done : orderDone([...liveDone, ...done])
}

export interface ProjectBlock {
  project: string
  waiting: ThreadView[]
  running: ThreadView[]
  /** Dispatches to this project whose rows the board has not delivered yet (lib/pendingDispatch), oldest first. */
  starting: PendingDispatchEntry[]
}

/**
 * One block per project with anything waiting or running, in `order` (the rail's). Rows keep the order
 * they arrive in, so each block's waiting rows are in queue order. A project missing from `order` — one
 * whose threads are still on the board after the rail dropped it — goes last rather than vanishing.
 *
 * A thread that is STARTING counts as something running: a dispatch to a project with nothing else on
 * the Console opens that project's block at the click, where the thread's own row then lands, instead
 * of the block arriving with the row and pushing every block under it down a second time.
 */
export function projectBlocks(
  waiting: readonly ThreadView[],
  running: readonly ThreadView[],
  order: readonly string[],
  starting: readonly PendingDispatchEntry[] = [],
): ProjectBlock[] {
  const blocks = new Map<string, ProjectBlock>()
  const block = (project: string) => {
    let b = blocks.get(project)
    if (!b) blocks.set(project, (b = { project, waiting: [], running: [], starting: [] }))
    return b
  }
  for (const t of waiting) block(keyProject(t.id) ?? "").waiting.push(t)
  for (const t of running) block(keyProject(t.id) ?? "").running.push(t)
  for (const entry of starting) if (entry.project !== undefined) block(entry.project).starting.push(entry)
  const rank = new Map(order.map((project, i) => [project, i]))
  return [...blocks.values()].sort((a, b) => (rank.get(a.project) ?? order.length) - (rank.get(b.project) ?? order.length))
}

/** The Queue band's rows — and so the cards — in the order the sidebar draws them for `group`. */
export function consoleCardOrder(waiting: readonly ThreadView[], group: ConsoleGroup, order: readonly string[]): ThreadView[] {
  // By status, the pinned rows' cards lead, in the shelf's order: the Pinned band sits above Queue.
  if (group === "status") return [...waiting.filter(isConsolePinned).sort(byConsolePin), ...waiting.filter((t) => !isConsolePinned(t))]
  return projectBlocks(waiting, [], order).flatMap((b) => b.waiting)
}

export interface ConsolePinPlacement {
  /** The thread's Console key. */
  id: string
  /** Its new instant on the shelf. */
  at: string
}

/** How far above the top row a row dragged to the top is placed. Any gap would do; nothing reads it as a time. */
const TOP_STEP_MS = 60_000

/**
 * THE WRITES A DRAG IN THE CONSOLE'S PINNED BAND COMES TO. The band is ordered by its instants, and it
 * spans every project, so no one project's storage can re-deal it the way a board's reorder does (server
 * storage.ts reorderPinned); the browser works out the new instants and each project is sent its own.
 *
 * A drag moves ONE row, so the common answer is ONE write: that row takes an instant between its new
 * neighbours (a minute above the top row, a millisecond below the bottom one — never later than a pin
 * made afterwards, which is stamped now and must still land last). Only when there is no room between
 * the neighbours — two pins in one millisecond, or a list that is not a single move — is the whole shelf
 * dealt again, the board's way: its own instants, earliest to the top row, strictly increasing, and only
 * the rows whose instant changed are written.
 *
 * `shelf` is the band in its CURRENT order, carrying the instants that order came from; `next` is the
 * order to make. An id `next` does not name keeps its place after the ones it does, as on the board.
 */
export function consolePinPlacements(shelf: readonly ThreadView[], next: readonly string[]): ConsolePinPlacement[] {
  const instants = new Map(shelf.map((t) => [t.id, Date.parse(t.consolePinnedAt ?? "")]))
  const current = shelf.map((t) => t.id)
  const listed = [...new Set(next)].filter((id) => instants.has(id))
  const named = new Set(listed)
  const order = [...listed, ...current.filter((id) => !named.has(id))]
  const iso = (ms: number) => new Date(ms).toISOString()

  const moved = singleMove(current, order)
  if (moved === null) return []
  if (moved !== undefined) {
    const index = order.indexOf(moved)
    const above = index > 0 ? instants.get(order[index - 1]!) : undefined
    const below = index < order.length - 1 ? instants.get(order[index + 1]!) : undefined
    const at = above === undefined ? below! - TOP_STEP_MS : below === undefined ? above + 1 : Math.floor((above + below) / 2)
    const fits = Number.isFinite(at) && (above === undefined || at > above) && (below === undefined || at < below)
    if (fits) return [{ id: moved, at: iso(at) }]
  }

  const dealt = current.map((id) => instants.get(id)!)
  const writes: ConsolePinPlacement[] = []
  let previous = 0
  order.forEach((id, index) => {
    const instant = dealt[index]!
    previous = Number.isFinite(instant) && instant > previous ? instant : previous + 1
    if (previous !== instants.get(id)) writes.push({ id, at: iso(previous) })
  })
  return writes
}

/** The one id whose move turns `from` into `to`; `null` when they are the same, `undefined` when no single move does. */
function singleMove(from: readonly string[], to: readonly string[]): string | null | undefined {
  let first = 0
  while (first < from.length && from[first] === to[first]) first++
  if (first === from.length) return null
  const without = (list: readonly string[], id: string) => list.filter((x) => x !== id)
  for (const candidate of [from[first]!, to[first]!]) {
    const a = without(from, candidate)
    const b = without(to, candidate)
    if (a.every((id, i) => id === b[i])) return candidate
  }
  return undefined
}
