import { useCallback, useMemo, useRef, type ButtonHTMLAttributes, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { ChevronDown, ChevronUp } from "lucide-react"
import type { ProjectCard, ThreadView } from "@frizz/shared"
import { store } from "../store.ts"
import { useBoardThreads } from "../hooks.ts"
import { isConsolePinned, type PinShelf } from "../groups.ts"
import { prefs } from "../lib/prefs.ts"
import { useOptimisticallySteered } from "../lib/steering.ts"
import { useOptimisticallyArchived } from "../lib/optimisticArchive.ts"
import { useConsoleProjectList } from "../lib/consoleProjects.ts"
import {
  RUNNING_CAP,
  consoleCardOrder,
  consoleDone,
  consolePinPlacements,
  consolePinned,
  consoleQueue,
  consoleRunning,
  consoleSnoozed,
  projectBlocks,
  setRunningExpanded,
  showMoreOfBand,
  toggleBand,
  useBandShown,
  useConsoleGroup,
  useRunningExpanded,
  type ConsoleFoldedBand,
} from "../lib/consoleBoard.ts"
import { bareSlug, keyProject, threadKey } from "../lib/threadKey.ts"
import { rpcFor } from "../api/rpc.ts"
import { unlandedDispatches, useConsolePendingDispatches, type PendingDispatchEntry } from "../lib/pendingDispatch.ts"
import { ProjectScope } from "../lib/projectScope.tsx"
import { STACKED_RAIL_ANCHOR_CLASS, stackedRailAnchor } from "../lib/stackedRailAnchor.ts"
import { CONSOLE_TOP_PX } from "../lib/homeView.ts"
import { SIDEBAR_WIDTH_CLASS } from "../lib/boardColumns.ts"
import { DispatchForm } from "./NewThreadModal.tsx"
import { useConsoleDispatchTarget } from "./ConsoleProjectChip.tsx"
import { ProjectSquare } from "./ProjectRail.tsx"
import { RailViewChips } from "./RailViewChips.tsx"
import { PinnedBand, SectionHeader, StartingRow, SubAgentRows, ThreadRow, useQueueScrollspy } from "./Sidebar.tsx"
import { StatusRow } from "./StatusRow.tsx"

// THE CONSOLE'S SIDEBAR — a project board's sidebar, drawn from every open project at once.
//
// The same column as a project's (Sidebar.tsx): the status row and the prompt box at its top, the rows
// under them, the scroll marker opposite the card being read. What differs is what it holds, and where
// it sits:
//   · the status row leads with the PROJECT chip, saying where a new task goes, in place of the house and
//     the crumb (StatusRow.tsx): the switcher above it is the way to the grid, and the chip's menu the way
//     to a project;
//   · "By status" adds Snoozed and Done under Queue and Running, collapsed until opened and paged behind
//     "Show more" (lib/consoleBoard.ts); "By project" stays Queue and Running alone, what needs the
//     operator now;
//   · a chip choosing between the two groupings, "By status" and "By project", in front of the queue
//     order's chip that every board has (RailViewChips.tsx);
//   · "By status" keeps a pin shelf of its own, apart from every project board's (lib/consoleBoard.ts
//     PINS): a Pinned band above Queue, drawn and dragged like a board's;
//   · the home switcher between the grid and the Console stands at its top-left (HomeSwitcher.tsx), so
//     the column opens CONSOLE_TOP_PX down, under the pill, rather than centred in the window.

export const CONSOLE_SIDEBAR_COLUMN_CLASS =
  `sticky top-0 self-start h-screen ${SIDEBAR_WIDTH_CLASS} flex flex-col pb-4 max-[800px]:static max-[800px]:h-auto max-[800px]:pt-16`

/**
 * A 16px project square beside a 19px title line: the half-step that centres it on the line.
 *
 * `-mr-1` sits it 4px closer to the status squircle than the row's `gap-2` spaces the squircle from the
 * title, so the square and the squircle read as one pair (maintainer 2026-10-20, option E of
 * console-row-gap-mockup-fixture.tsx: "4px closer"). MEASURED on that sheet: the square's ink fills its
 * box and the 15px squircle is centred in a 16px slot, so square → squircle is 4.5px of ink and
 * squircle → title stays 8.5px. The placeholder for a project the list no longer names takes the same
 * trim, so its row's title starts where every other row's does.
 */
function RowSquare({ project }: { project: ProjectCard | undefined }) {
  if (!project) return <span aria-hidden className="-mr-1 h-4 w-4 shrink-0" />
  return (
    <span className="-mr-1 mt-[1.5px] shrink-0" title={project.name}>
      <ProjectSquare project={project} size={16} />
    </span>
  )
}

export function ConsoleSidebar() {
  const snap = useSnapshot(store)
  // Untracked, like the project rail's (hooks.ts useBoardThreads): this board is EVERY project's.
  const all = useOptimisticallyArchived(useOptimisticallySteered(useBoardThreads()))
  const direction = useSnapshot(prefs).queueOrder
  const group = useConsoleGroup()
  const { projects, bySlug } = useConsoleProjectList()
  const order = useMemo(() => projects.map((project) => project.slug), [projects])
  const waiting = consoleCardOrder(consoleQueue(all, direction), group, order)
  const running = consoleRunning(all)
  // "By status" lifts the Console's own pins out of Queue and Running into the Pinned band above them.
  // The card order already leads with the pinned rows' cards (consoleCardOrder), so `waiting` stays the
  // scroll marker's order whole.
  const pinned = useMemo(() => (group === "status" ? consolePinned(all) : []), [group, all])
  const queueRows = group === "status" ? waiting.filter((t) => !isConsolePinned(t)) : waiting
  const runningRows = group === "status" ? running.filter((t) => !isConsolePinned(t)) : running
  const reorderPins = useConsolePinReorder(pinned)
  // A dispatch from the prompt box above, drawn as the Running row it is about to become — the project
  // sidebar's own treatment (Sidebar.tsx StartingRow). With the "Starting thread…" card that stood under
  // this box instead, every row moved down 93px at the click and back up when the call answered, and the
  // thread's own row landed under the card in between (recorded 2026-10-13, three runs per grouping).
  // The board's ids are only gathered while one is pending.
  const pending = useConsolePendingDispatches()
  const starting = useMemo(() => (pending.length === 0 ? pending : unlandedDispatches(pending, new Set(all.map((t) => t.id)))), [pending, all])
  const runningCount = runningRows.length + starting.length
  const nothingOpen = pinned.length === 0 && queueRows.length === 0 && runningCount === 0
  // "By status" only. Done is asked once per settled list, not once per delta (consoleBoard.ts consoleDone).
  const snoozed = useMemo(() => (group === "status" ? consoleSnoozed(all) : []), [group, all])
  const done = useMemo(() => (group === "status" ? consoleDone(all) : []), [group, all])
  const { railRef, activeId, navigateToQueueCard } = useQueueScrollspy(snap.view, snap.drawers.length, waiting.map((t) => t.id))

  const square = (t: ThreadView) => <RowSquare project={bySlug.get(keyProject(t.id) ?? "")} />
  // By status the rows speak for the Console's shelf; by project, for each project board's own.
  const shelf: PinShelf = group === "status" ? "console" : "board"
  // `dated`: the row carries the rest-time column. Waiting rows do, and Snoozed rows too, as on a project's
  // board (Sidebar.tsx): a parked row says nothing else on the rail. Running and Done rows do not.
  const row = (t: ThreadView, opts: { square: boolean; waiting: boolean; dated?: boolean }) => (
    <div key={t.id}>
      <ThreadRow
        t={t}
        // Waiting rows only: a running row has no queue card, and the marker a just-sent row arrives
        // with is handed to the row that took its place (markerRow in lib/sidebarScrollspy).
        active={opts.waiting && activeId === t.id}
        onQueueNavigate={navigateToQueueCard}
        // A pinned row keeps its rest time too: its pin shows only on hover, as the unpin (ThreadRow).
        restedAge={opts.dated ?? opts.waiting}
        leading={opts.square ? square(t) : undefined}
        shelf={shelf}
      />
      <SubAgentRows t={t} />
    </div>
  )
  const startingRow = (entry: PendingDispatchEntry, opts: { square: boolean }) => (
    <StartingRow key={`starting-${entry.key}`} entry={entry} leading={opts.square ? <RowSquare project={bySlug.get(entry.project ?? "")} /> : undefined} />
  )

  return (
    <aside ref={stackedRailAnchor} className={`${CONSOLE_SIDEBAR_COLUMN_CLASS} ${STACKED_RAIL_ANCHOR_CLASS}`} style={{ paddingTop: CONSOLE_TOP_PX }} data-console-sidebar>
      <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col max-[800px]:max-h-none">
        <div className="mb-5 shrink-0 px-0.5">
          <ConsoleDispatch />
        </div>
        {/* The list scrolls BEHIND the prompt box, as a project's does (Sidebar.tsx): its scroll edge is
            the box's bottom edge, and the 20px between them is the list's own top padding. The view chips
            are the list's first item, so they scroll away with the rows rather than standing fixed over
            them (maintainer 2026-10-20: "the tab switcher in the sidebar should scroll with the rest of the
            sidebar"). Every scroller here keeps a 7px scrollbar gutter (styles.css, `--sbw`), which inside
            the list would leave anything spanning it 7px short of the prompt box's right edge. So the list
            reaches 7px past the column, its scrollbar standing in the gap beside it, and the rows take the
            7px back. */}
        <div ref={railRef} data-sidebar-rail className="-mt-5 -mr-[var(--sbw)] min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-10 pt-5 max-[800px]:mr-0 max-[800px]:overflow-y-visible">
          <RailViewChips group={group} queued={queueRows.length > 0} />
          {/* The rows keep the column's measure, out of the scrollbar's gutter (above). */}
          <div className="mr-[var(--sbw)] max-[800px]:mr-0">
            {group === "status" ? (
              <>
                {!nothingOpen && (
                  <>
                    {/* PINNED — the Console's own shelf, the project board's band in every respect but whose it
                        is: out of Queue and Running whatever its rows' state, ordered by the pins, dragged to
                        rearrange. Its waiting rows' cards lead the cards, so the marker reaches them first. */}
                    {pinned.length > 0 && (
                      <section aria-label="Pinned" data-console-pinned>
                        <SectionHeader label="Pinned" count={pinned.length} />
                        <PinnedBand
                          threads={pinned}
                          railRef={railRef}
                          activeId={activeId}
                          onQueueNavigate={navigateToQueueCard}
                          shelf="console"
                          leading={square}
                          onReorder={reorderPins}
                        />
                        {queueRows.length + runningCount > 0 && <hr className="my-3 border-border/50" />}
                      </section>
                    )}
                    {queueRows.length > 0 && <SectionHeader label="Queue" count={queueRows.length} />}
                    {queueRows.map((t) => row(t, { square: true, waiting: true }))}
                    {runningCount > 0 && queueRows.length > 0 && <hr className="my-3 border-border/50" />}
                    {runningCount > 0 && <SectionHeader label="Running" count={runningCount} />}
                    {/* Newest first, the band's own order: a thread that starts lands at the top. */}
                    {[...starting].reverse().map((entry) => startingRow(entry, { square: true }))}
                    {runningRows.map((t) => row(t, { square: true, waiting: false }))}
                  </>
                )}
                {/* SNOOZED and DONE — collapsed until opened, then a page at a time (lib/consoleBoard.ts). Each
                    draws its own rule when a band stands above it, as on a project's board; neither has
                    queue cards, so neither row is ever the scroll marker. */}
                <FoldedBand band="snoozed" label="Snoozed" rule={!nothingOpen} threads={snoozed} render={(t) => row(t, { square: true, waiting: false, dated: true })} />
                <FoldedBand band="done" label="Done" rule={!nothingOpen || snoozed.length > 0} threads={done} render={(t) => row(t, { square: true, waiting: false })} />
              </>
            ) : (
              projectBlocks(waiting, running, order, starting).map((block, i) => (
                <section key={block.project} aria-label={bySlug.get(block.project)?.name ?? block.project} data-console-project={block.project}>
                  {i > 0 && <hr className="my-3 border-border/50" />}
                  <ProjectHeader project={bySlug.get(block.project)} slug={block.project} />
                  {block.waiting.map((t) => row(t, { square: false, waiting: true }))}
                  <RunningRows
                    project={block.project}
                    rows={block.running}
                    starting={block.starting}
                    render={(t) => row(t, { square: false, waiting: false })}
                    renderStarting={(entry) => startingRow(entry, { square: false })}
                  />
                </section>
              ))
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}

/**
 * How a drag in the Console's Pinned band is written. The band spans projects, so the browser works out
 * the new instants (lib/consoleBoard.ts consolePinPlacements) — usually one row's — and sends each project
 * its own share. Instants it has sent and the board has not shown yet stand in for the board's, so a
 * second drag made before the first lands is placed against the order on screen, not the one before it.
 */
function useConsolePinReorder(pinned: readonly ThreadView[]): (ids: readonly string[]) => Promise<unknown> {
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned
  const sent = useRef(new Map<string, string>())
  return useCallback((ids: readonly string[]) => {
    for (const [id, at] of sent.current) {
      const t = pinnedRef.current.find((x) => x.id === id)
      if (!t || t.consolePinnedAt === at) sent.current.delete(id)
    }
    const shelf = pinnedRef.current
      .map((t) => (sent.current.has(t.id) ? { ...t, consolePinnedAt: sent.current.get(t.id) } : t))
      .sort((a, b) => (a.consolePinnedAt ?? "").localeCompare(b.consolePinnedAt ?? "") || a.id.localeCompare(b.id))
    const writes = consolePinPlacements(shelf, ids)
    const byProject = new Map<string, { slug: string; at: string }[]>()
    for (const write of writes) {
      const project = keyProject(write.id)
      if (!project) continue
      sent.current.set(write.id, write.at)
      let pins = byProject.get(project)
      if (!pins) byProject.set(project, (pins = []))
      pins.push({ slug: bareSlug(write.id), at: write.at })
    }
    const calls = [...byProject].map(([project, pins]) =>
      rpcFor(project).reorderConsolePinnedThreads({ pins }).catch((error: unknown) => {
        for (const pin of pins) sent.current.delete(threadKey(project, pin.slug))
        throw error
      }),
    )
    return Promise.all(calls)
  }, [])
}

/**
 * A project's block header: its square where the rows' indicators sit, then its name. No count — the
 * rows under it are the count (maintainer 2026-10-11: "I don't think the numerical count to the right of
 * each project name is doing very much").
 */
function ProjectHeader({ project, slug }: { project: ProjectCard | undefined; slug: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2 pb-[3px] pl-5 pr-1.5 pt-1" data-console-project-header>
      {project ? (
        <span className="mt-[1.5px] shrink-0">
          <ProjectSquare project={project} size={16} />
        </span>
      ) : null}
      <span className="min-w-0 truncate text-[12.5px] font-semibold leading-[19px] text-fg/85">{project?.name ?? slug}</span>
    </div>
  )
}

/**
 * A project's running rows, the first RUNNING_CAP of them until the operator asks for the rest. A long
 * run of spinners is the least actionable thing in the column — nothing in it is waiting on anyone — so
 * it must not push the next project's queue off the screen (maintainer 2026-10-11: "cut it off at however
 * many you think is appropriate, with a Show more button"). Three keeps a busy project's block about
 * as tall as a queue of three.
 */
function RunningRows({
  project,
  rows,
  starting,
  render,
  renderStarting,
}: {
  project: string
  rows: ThreadView[]
  starting: PendingDispatchEntry[]
  render: (t: ThreadView) => ReactNode
  renderStarting: (entry: PendingDispatchEntry) => ReactNode
}) {
  const expanded = useRunningExpanded(project)
  // A thread that is starting is one of the running rows already, for the cap as for the eye: it takes
  // the top place its own row will land in (newest first), so the cap cuts the same rows before the row
  // lands as after.
  const total = starting.length + rows.length
  const capped = total > RUNNING_CAP
  const room = capped && !expanded ? RUNNING_CAP : total
  const shownStarting = [...starting].reverse().slice(0, room)
  const shown = rows.slice(0, room - shownStarting.length)
  return (
    <>
      {shownStarting.map(renderStarting)}
      {shown.map(render)}
      {capped ? (
        <ShowMoreButton less={expanded} aria-expanded={expanded} data-console-show-more={project} onClick={() => setRunningExpanded(project, !expanded)} />
      ) : null}
    </>
  )
}

/**
 * "Show more" under a list cut short, and "Show less" once a project's running rows are all out. Its
 * chevron sits in the indicator column, so the words start where the titles above them do; under rows
 * that lead with a project square, `leading` holds that square's place (RowSquare's placeholder).
 */
function ShowMoreButton({ less = false, leading, ...rest }: { less?: boolean; leading?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className="flex w-full items-center gap-2 rounded-md pb-1 pl-5 pr-1.5 pt-1 text-left text-[12px] leading-[19px] text-muted-70 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
    >
      {leading}
      <span className="flex h-[19px] w-4 shrink-0 items-center justify-center">
        {less ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
      </span>
      {less ? "Show less" : "Show more"}
    </button>
  )
}

/**
 * "By status"'s Snoozed or Done band: absent when empty, collapsed until its header is clicked, and then
 * BAND_PAGE rows at a time, each "Show more" adding the next page (lib/consoleBoard.ts). Collapsing it
 * again starts it over at one page.
 */
function FoldedBand({ band, label, rule, threads, render }: { band: ConsoleFoldedBand; label: string; rule: boolean; threads: readonly ThreadView[]; render: (t: ThreadView) => ReactNode }) {
  const shown = useBandShown(band)
  if (threads.length === 0) return null
  return (
    <section aria-label={label} data-console-band={band}>
      {rule && <hr className="my-3 border-border/50" />}
      <SectionHeader label={label} count={threads.length} collapsed={shown === 0} onToggle={() => toggleBand(band)} />
      {shown > 0 ? threads.slice(0, shown).map(render) : null}
      {shown > 0 && threads.length > shown ? (
        <ShowMoreButton leading={<RowSquare project={undefined} />} data-console-band-more={band} onClick={() => showMoreOfBand(band)} />
      ) : null}
    </section>
  )
}

/** The status row and the prompt box under it, pointed at the project the row's chip names (components/ConsoleProjectChip.tsx). */
function ConsoleDispatch() {
  const { project, chip } = useConsoleDispatchTarget()
  return (
    <>
      <StatusRow onConsole projectChip={chip} />
      <ProjectScope project={project?.slug}>
        {/* No "Starting thread…" card under this box: the rail draws the pending thread itself (above). */}
        <DispatchForm pendingCard={false} />
      </ProjectScope>
    </>
  )
}
