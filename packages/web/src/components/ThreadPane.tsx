import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Inbox, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react"
import { useSnapshot } from "valtio"
import type { ThreadView as ThreadRow } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { displayTitle, isPinned, orderQueue, queued } from "../groups.ts"
import { useBoard, useQueueCards, useThreadSnapshot, warmTranscript } from "../hooks.ts"
import { isConsolePath } from "../lib/base-path.ts"
import { consoleCardOrder, useConsoleGroup } from "../lib/consoleBoard.ts"
import { useConsoleProjectList } from "../lib/consoleProjects.ts"
import { useOptimisticallyArchived } from "../lib/optimisticArchive.ts"
import { prefs } from "../lib/prefs.ts"
import { ProjectScope } from "../lib/projectScope.tsx"
import { SPLIT_MIN_PX } from "../lib/sheet.ts"
import { useOptimisticallySteered } from "../lib/steering.ts"
import { keyProject } from "../lib/threadKey.ts"
import { resolveThreadRoute } from "../lib/threadRouteState.ts"
import {
  advanceFrom, nextQueuedAfter, openFirstQueued, PANE_RAIL_MAX_PX, PANE_RAIL_MIN_PX, PANE_SIDEBAR_MAX_PX, PANE_THREAD_PX, paneAfterSend, paneProto,
  paneRailWanted, paneRailWidth, paneSidebarWidth, publishPaneQueue, reinstate, setPaneFolded, setPaneRailShown, stepPane, takeComposerFocus,
  usePaneSplit, usePaneWide,
} from "../lib/threadPane.ts"
import { store } from "../store.ts"
import { ErrorBoundary } from "./ErrorBoundary.tsx"
import { MissingThread } from "./MissingThread.tsx"
import { SidePane, ThreadView } from "./lazySurfaces.tsx"
import { ThreadPageZone } from "./ThreadPageZone.tsx"
import { LastActive } from "./LastActive.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { LAYOUT_VARS } from "../lib/fullLayout.ts"

// THE ONE-THREAD PANE (see lib/threadPane.ts): the board as a sidebar and one thread at full
// height. The thread is the same ThreadView the drawer and /full draw; everything a queue card did about
// scrolling and fading is simply absent, because nothing here moves but the swap of one thread for another.

// THE COLUMNS MEET EDGE TO EDGE, THE SIDEBAR STANDS AGAINST THE LEFT OF THE WINDOW AND THE RAIL AGAINST ITS
// RIGHT, AND THE THREAD TAKES WHATEVER IS BETWEEN THEM. The columns met edge to edge from 2026-11-09 (the
// rail "just immediately up against the content window", "the same thing for the sidebar") but held fixed
// widths and centred as a group, which left the slack as two empty strips at the far left and far right;
// on 2026-11-17 the thread took that slack instead, and the lines between the columns became resize
// handles (PaneResizeHandle), so the sidebar and the rail are as wide as the reader drags them
// (lib/threadPane.ts paneSidebarWidth / paneRailWidth) and the thread is the rest. When the window runs
// short the sidebar gives way first, down to its minimum, then the rail, down to its own (PaneThread's
// --full-pane), before the thread drops below its 720 measure. That holds at every window width, not only
// at the moment of a drag: a width stored on a wide screen gives way on a narrow one.
// These are the minimums: 300 + the thread's 720 + the rail's 340 is the 1360 the three columns start at
// (PANE_WIDE_MIN_PX). The sidebar's 16px insets are the peek's, so the two read alike.
const WIDE_SIDEBAR_PX = 300
const NARROW_SIDEBAR_PX = 272

// THE SIDEBAR AND THE RAIL FLOAT IN THE MIDDLE OF THE WINDOW (maintainer 2026-11-09: "I want it to be
// vertically centered"). Both were centred once and anchored to the top on 2026-10-13, because a centred
// column moves everything in it by half of any change in its height (Sidebar.tsx SIDEBAR_COLUMN_CLASS);
// the pane brings the centring back for itself alone. Auto margins on the column's content, never
// `justify-center` on the column: past the window's height the margins fall to zero and the list scrolls
// from its top instead of being clipped above it (FocusRail). `flex-initial` lets the Console's column,
// which fills its aside, shrink to its content so there is room to centre it in.
const CENTRED_SIDEBAR = "[&>aside>div]:my-auto [&>aside>div]:flex-initial"

/** The queue in the order the pane walks it: the order the queue's cards stood in. */
export function usePaneQueue(): readonly ThreadRow[] {
  const onConsole = isConsolePath()
  const group = useConsoleGroup()
  const projects = useConsoleProjectList(onConsole)
  const order = useSnapshot(prefs).queueOrder
  // What had a card, not everything queued: a pinned thread's plain report is read off its pinned row and
  // never queues (lib/consoleBoard holdsCardHere), so the pane neither counts it as waiting nor steps onto it.
  const overlaid = useOptimisticallyArchived(useOptimisticallySteered(useQueueCards()))
  const slugs = projects.projects.map((p) => p.slug).join("\n")
  return useMemo(() => {
    const items = orderQueue(overlaid.filter(queued), order)
    if (onConsole) return consoleCardOrder(items, group, slugs ? slugs.split("\n") : [])
    // The rows' own order down the sidebar, so "next" is the row below: the pinned band sits above Queue.
    return [...items.filter(isPinned), ...items.filter((t) => !isPinned(t))]
  }, [overlaid, order, onConsole, group, slugs])
}

export function PaneLayout({ sidebar }: { sidebar: ReactNode }) {
  const snap = useSnapshot(store)
  const proto = useSnapshot(paneProto, { sync: true })
  const wide = usePaneWide()
  const queue = usePaneQueue()
  publishPaneQueue(queue.map((t) => t.id))
  const slug = snap.paneSlug
  // With nothing selected there is nothing to be full screen about. A thread whose address is still settling
  // counts as selected: a cold link to a full-screen thread drew the sidebar for the frames before the board
  // arrived, then took it away.
  const folded = proto.folded && (slug !== null || snap.routeThreadSlug !== null)
  const threeColumns = wide && !folded
  const railShown = threeColumns && paneRailWanted(proto.artifacts, wide)
  const widths = useSnapshot(prefs)
  const sidebarMin = wide ? WIDE_SIDEBAR_PX : NARROW_SIDEBAR_PX
  const sidebarWidth = paneSidebarWidth(widths.paneSidebarWidth, sidebarMin)
  const railWidth = paneRailWidth(widths.paneRailWidth)
  // A file wants more room than the rail, so while one is open the thread and the file take the page
  // (PaneThread) and the sidebar gives up what they need of it: the file gets the thread's 720 before the
  // sidebar stands above its minimum.
  const fileBeside = threeColumns && snap.filePanels.length > 0
  // The sidebar is the width the reader chose until the thread beside it would drop below its measure, and
  // then gives way down to its minimum: the clamp's upper bound is what the thread (and the rail) leave it.
  // The thread is the workpane's `flex-1`, the rest of the row.
  const threadRoom = fileBeside
    ? `${2 * PANE_THREAD_PX}px`
    : threeColumns
      ? railShown ? `${PANE_THREAD_PX}px - var(--pane-rail-w)` : `${PANE_THREAD_PX}px`
      : `min(${PANE_THREAD_PX}px, 62vw)`
  const sidebarFlex = `0 0 clamp(${sidebarMin}px, calc(100% - ${threadRoom}), var(--pane-sidebar-w))`
  const [peek, setPeek] = useState(false)
  if (!folded && peek) setPeek(false)
  // The sidebar keeps 12px clear above and below what it centres (a board's 52px top was the line the first
  // queue card opened on), the Console's as a project's.
  const boardTop = "[&>aside]:!py-3"

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaneFolded(!paneProto.folded)
        return
      }
      if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault()
        stepPane(e.key === "ArrowDown" ? 1 : -1)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (store.drawers.length > 0 || store.showPalette || store.showSettings || store.showNewThread) return
      const target = e.target
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='menu'], [role='dialog']")) return
      if (e.key === "j") stepPane(1)
      else if (e.key === "k") stepPane(-1)
      else if (e.key === "Enter" && !store.paneSlug && !(target instanceof HTMLButtonElement)) openFirstQueued()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // The row keeps itself in view as the queue brings threads up.
  useEffect(() => {
    if (!slug) return
    document.querySelector(`[data-sidebar-item="${CSS.escape(slug)}"]`)?.scrollIntoView({ block: "nearest" })
  }, [slug])

  return (
    <div
      data-pane-layout={folded ? "folded" : wide ? "wide" : "narrow"}
      className="flex h-dvh w-full overflow-hidden"
      // The two widths the resize handles move. A drag writes these on this element directly, frame by frame,
      // and stores the result in prefs once it ends, so the thread is not re-rendered on every pointer move.
      style={{ "--pane-sidebar-w": `${sidebarWidth}px`, "--pane-rail-w": `${railWidth}px` } as CSSProperties}
    >
      {/* The sidebar never unmounts across the wide line: the same docked column at every width. Full
          screen it waits off the left edge, and a pointer at that edge peeks it over the thread. */}
      {!folded ? (
        <div
          data-pane-sidebar
          className={`h-full px-4 [view-transition-name:pane-sidebar] [&>aside]:!w-full ${CENTRED_SIDEBAR} ${boardTop}`}
          style={{ flex: sidebarFlex, minWidth: sidebarMin, maxWidth: PANE_SIDEBAR_MAX_PX }}
        >
          {sidebar}
        </div>
      ) : (
        <>
          <div
            aria-hidden="true"
            data-pane-edge
            onMouseEnter={() => setPeek(true)}
            className="fixed inset-y-0 left-0 z-20 w-2"
          />
          <div
            data-pane-sidebar-peek={peek ? "" : undefined}
            inert={peek ? undefined : true}
            onMouseLeave={() => setPeek(false)}
            className={`fixed left-0 top-0 z-20 h-dvh border-r border-border bg-bg px-4 shadow-2xl transition-[translate,opacity] duration-150 ease-out ${CENTRED_SIDEBAR} ${boardTop} ${peek ? "translate-x-0 opacity-100" : "-translate-x-full opacity-0"}`}
          >
            {sidebar}
          </div>
        </>
      )}
      {/* The rest of the row, at every width. Narrow, that is also what makes the thread shrink once the
          sidebar is down to its minimum: before 2026-11-10 it held 62vw, and beside the project rail's 57px
          at 820px the sidebar's 272 and the thread overran the window by 17px. */}
      <main id="workpane" className="relative h-full min-w-0 flex-1">
        {!folded && !fileBeside && <PaneResizeHandle column="sidebar" value={sidebarWidth} min={sidebarMin} wide={wide} />}
        {slug ? <PaneThread key={slug} slug={slug} folded={folded} wide={wide} /> : <PaneEmpty parked={snap.routeThreadSlug !== null} queue={queue} />}
      </main>
    </div>
  )
}

function PaneThread({ slug, folded, wide }: { slug: string; folded: boolean; wide: boolean }) {
  const snap = useSnapshot(store)
  const { artifacts } = useSnapshot(paneProto)
  const prefsWidths = useSnapshot(prefs)
  const split = usePaneSplit()
  const board = useBoard()
  const thread = useThreadSnapshot(slug)
  // The row the snapshot already read, not a walk of the tracked board, which would make every board
  // delta pay to wrap the threads array (trackedThreadLookup.guard.test.ts); as ThreadSheet does.
  const route = resolveThreadRoute(board, slug, () => thread)
  const queryClient = useQueryClient()
  const threeColumns = wide && !folded
  // The rail has room beside the thread full screen (from the split width up, as on /full) and in the three
  // columns, and stands there when the reader wants it (lib/threadPane.ts paneRailWanted).
  const railRoom = folded || threeColumns
  const railWanted = paneRailWanted(artifacts, wide)
  const railBeside = railRoom && railWanted
  // A file is asked for, so it opens beside the thread with the rail put away too, over nothing.
  const sidePane = railRoom && (railWanted || snap.filePanels.length > 0)
  const fileOpen = folded && snap.filePanels.some((panel) => !panel.closing)
  // In the three columns a file takes room from the thread rather than sliding the row: the sidebar stays,
  // so there is no slack beside the pair to slide into. Held through the layer's slide-out (`closing`
  // included), so the viewer leaves at the width it came in at and the columns settle once it is gone.
  const fileBeside = threeColumns && snap.filePanels.length > 0
  // In the queue when it was opened, and read as a card from then on, whatever the thread goes on to do.
  const [opensQueued, setOpensQueued] = useState<boolean | null>(thread ? queued(thread) : null)
  if (opensQueued === null && thread) setOpensQueued(queued(thread))

  // Reading it counts as reading it, as in the drawer and on /full.
  const atRest = thread?.runtime === "turn-idle" || thread?.runtime === "exited" || thread?.runtime === "none"
  useEffect(() => {
    if (!thread || !atRest) return
    rpc.threadSeen({ slug }).catch(() => {})
  }, [atRest, slug, thread?.lastActivityAt])

  // FULL SCREEN, THE TAB IS THE THREAD'S, as the full-screen page's was (StandaloneThreadPage): a thread's
  // own path is what a new tab opens, and several such tabs on one project tell themselves apart by it.
  const title = thread ? displayTitle(thread) : null
  const projectLabel = board?.projectLabel ?? board?.projectName
  useEffect(() => {
    if (!folded || title === null) return
    const before = document.title
    document.title = projectLabel ? `${title} · ${projectLabel} — Frizz` : `${title} · Frizz`
    return () => { document.title = before }
  }, [folded, title, projectLabel])

  // The next thread's transcript is fetched ahead, so moving on draws it rather than a spinner.
  const next = nextQueuedAfter(slug)
  useEffect(() => {
    if (next) void warmTranscript(queryClient, next)
  }, [next, queryClient])

  useEffect(() => {
    if (!takeComposerFocus()) return
    const frame = requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-thread-chat-footer] textarea")?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [])

  // While the rail has room beside the thread a file opens beside it too, as it does on /full. Narrowing
  // the window past the wide line unfolded takes the room away, and an open file with it.
  useEffect(() => {
    if (!railRoom) return
    const split = window.matchMedia?.(`(min-width: ${SPLIT_MIN_PX}px)`)
    if (!split) return
    const apply = () => { store.splitFileViewer = split.matches }
    apply()
    split.addEventListener("change", apply)
    return () => {
      split.removeEventListener("change", apply)
      store.splitFileViewer = false
      store.filePanels = []
    }
  }, [railRoom])

  const pane = useMemo(() => ({
    exit: {
      dismiss: () => advanceFrom(slug, { dismissed: true }),
      cancel: () => reinstate(slug),
      sent: () => paneAfterSend(slug),
    },
    // Full screen is one click from the open thread at every width: it is how one thread gets the page to
    // itself (maintainer 2026-11-09). Already there, the header has the door's closing half instead.
    expand: !folded,
    railBeside,
    queueWindow: opensQueued === true,
  }), [slug, folded, railBeside, opensQueued])

  // ONE TREE IN EVERY LAYOUT, each slot a fixed element whose classes change, so crossing the wide line
  // or folding never remounts the thread: the transcript keeps its scroll and the prompt box its focus.
  //   [gutter] [thread] [side pane]
  // The gutter is /full's centring (LAYOUT_VARS), full screen only and only beside a side pane: in the
  // three columns the thread stands hard against the sidebar and the rail, and alone it is simply centred.
  // The whole block is the thread's drop zone, as /full's page is (ThreadPageZone): a file dropped on the rail
  // or in full screen's gutter is this thread's too. Only the sidebar beside it is the board's.
  return (
    <ProjectScope project={keyProject(slug)}>
      <ThreadPageZone
        className={`flex h-full w-full transition-transform duration-200 ease-out motion-reduce:transition-none ${threeColumns ? "" : sidePane ? "justify-center split:justify-start" : "justify-center"}`}
        style={{
          ...LAYOUT_VARS,
          // In the three columns and at rest the side pane is the rail alone, as wide as the reader dragged it
          // (PaneLayout's --pane-rail-w) until the thread would drop below its measure; with a file it is
          // /full's pane, the half of the room right of the sidebar that the thread (--full-thread) does not
          // take. The rail gives way second: the `100%` is this block, the row less the sidebar, and the
          // sidebar's own clamp leaves the thread its 720 beside the full rail until the sidebar is down to its
          // minimum, so only then does `100% - 720px` fall below the rail's width. A width stored on a wider
          // screen therefore cannot squeeze the thread on a narrower one. The `%` resolves where the variable
          // is used, the side pane's width, whose containing block is this one; the rail inside the side pane
          // simply fills it.
          ...(threeColumns && !fileBeside
            ? { "--full-pane": `clamp(${PANE_RAIL_MIN_PX}px, calc(100% - ${PANE_THREAD_PX}px), var(--pane-rail-w))`, "--focus-rail-w": "100%" }
            : null),
          transform: fileOpen ? "translateX(calc(-1 * var(--full-gutter)))" : undefined,
        } as CSSProperties}
      >
        {folded && sidePane && <div aria-hidden="true" className="hidden w-[var(--full-gutter)] shrink-0 split:block" />}
        {/* The column, which holds the thread and the controls on its two lines. */}
        <div
          className={`relative h-full min-w-0 ${
            threeColumns
              // Everything between the sidebar and the rail. The two of them give way to keep it at 720 or more,
              // the drawer's width (lib/sheet.ts SHEET_BASE_WIDTH) and the measure every thread surface keeps,
              // until both are at their minimums, which happens only beside the opt-in project rail, whose 57px
              // the 1360 does not count.
              ? fileBeside ? "w-[var(--full-thread)] shrink-0" : "flex-1"
              : folded
                ? sidePane ? "w-[var(--full-thread-narrow)] shrink-0 split:w-[var(--full-thread)]" : "w-[var(--full-thread-narrow)] shrink-0"
                : "w-full shrink-0"
          }`}
        >
          <div
            data-pane-thread
            // Full screen, this is the full-screen thread column the phone's page draws (StandaloneThreadPage),
            // and what reads that column reads this one: Escape in its prompt box leaves full screen rather
            // than blurring the box (Composer).
            data-standalone-thread={folded ? "" : undefined}
            className="flex h-full w-full min-w-0 flex-col overflow-hidden border-x border-border bg-panel [view-transition-name:thread-chat]"
          >
            {route.kind === "found" ? (
              // One thread's render error stays in this column: the sidebar is still there, and picking
              // another thread is a new render (ErrorBoundary.tsx).
              <ErrorBoundary label="this thread" resetKeys={[slug]}>
                <ThreadView slug={slug} showReturnToQueue={folded} pane={pane} />
              </ErrorBoundary>
            ) : route.kind === "missing" ? (
              // A project's thread page asks the server which project has the thread and goes there, as the
              // old full-screen page did: a link from before the singleton names a slug with no project.
              // The Console's slug is a key, which names its project already.
              isConsolePath()
                ? <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted" role="status">Thread “{slug}” was not found in this project.</div>
                : <MissingThread slug={slug} />
            ) : (
              <div className="flex flex-1 items-center justify-center"><span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" /></div>
            )}
          </div>
          <PaneEdgeToggle side="left" hidden={folded} onToggle={() => setPaneFolded(!folded)} />
          {threeColumns && railBeside && !fileBeside && <PaneResizeHandle column="rail" value={paneRailWidth(prefsWidths.paneRailWidth)} min={PANE_RAIL_MIN_PX} wide={wide} />}
          {/* Wherever the rail could stand, and not while a file stands over it: the file has its own ×. Beside
              the sidebar on a window too narrow for both, it shows the rail in the sidebar's place. */}
          {split && snap.filePanels.length === 0 && (
            <PaneEdgeToggle side="right" hidden={!railBeside} onToggle={() => setPaneRailShown(!railBeside)} />
          )}
        </div>
        {sidePane && thread && (
          <ErrorBoundary label="this thread's side pane" resetKeys={[slug]}>
            <SidePane slug={slug} thread={thread} rail={railWanted} centredRail />
          </ErrorBoundary>
        )}
      </ThreadPageZone>
    </ProjectScope>
  )
}

// THE CONTROLS ON THE LINES (maintainer 2026-11-09, of a mock page of them: "K5, let's lock it in"). An 8px
// dot centred on each line between the thread and what stands beside it, which opens under the pointer into
// a knob holding the panel icon. They belong to the line, not to the transcript ("setting this control
// inside of the content column itself doesn't make semantic sense"), so the dot's centre is the line's;
// the open knob lies half over the thread's empty margin, clear of the text, and half over the 16px inset
// of the column beside it. The left one is the header's full-screen door by another name.
function PaneEdgeToggle({ side, hidden, onToggle }: { side: "left" | "right"; hidden: boolean; onToggle: () => void }) {
  const label = `${hidden ? "Show" : "Hide"} ${side === "left" ? "sidebar" : "artifacts"}`
  const Icon = side === "left" ? (hidden ? PanelLeftOpen : PanelLeftClose) : (hidden ? PanelRightOpen : PanelRightClose)
  return (
    <Tooltip label={label} side={side}>
      <button
        type="button"
        data-pane-edge-toggle={side}
        aria-label={label}
        onClick={onToggle}
        // The column's border is its outermost pixel, so the line's centre is half a pixel inside its edge.
        className={`group absolute top-1/2 z-10 grid h-14 w-[26px] -translate-y-1/2 place-items-center outline-none ${
          side === "left" ? "-left-[12.5px] [view-transition-name:pane-edge-left]" : "-right-[12.5px] [view-transition-name:pane-edge-right]"
        }`}
      >
        <span className="grid size-2 place-items-center overflow-hidden rounded-full border border-border-strong bg-elevated text-fg transition-[width,height] duration-150 ease-out group-hover:size-[26px] group-focus-visible:size-[26px]">
          <Icon aria-hidden size={14} strokeWidth={1.75} className="shrink-0 opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100" />
        </span>
      </button>
    </Tooltip>
  )
}

// THE LINES BETWEEN THE COLUMNS ARE ALSO RESIZE HANDLES (2026-11-17). A 9px strip centred on the line, the
// full height of the column, under the toggle's knob (z-10 over this z-[5]), so the knob still takes a click
// at the line's middle and the rest of the line drags. Dragging moves the column on its far side: the
// sidebar's width on the left line, the rail's on the right, and the thread takes the difference. A drag
// never pushes the thread below its 720 measure (or, narrow, the 62vw it shrinks to), and a double-click
// puts the column back to its default. The width is written as PaneLayout's CSS variable on every move
// and stored in prefs when the drag ends, so the transcript is not re-rendered frame by frame. Arrow keys
// move a focused handle 16px at a time, 64 with Shift.
const RESIZE_VAR = { sidebar: "--pane-sidebar-w", rail: "--pane-rail-w" } as const
const RESIZE_PREF = { sidebar: "paneSidebarWidth", rail: "paneRailWidth" } as const

function PaneResizeHandle({ column, value, min, wide }: { column: "sidebar" | "rail"; value: number; min: number; wide: boolean }) {
  const [dragging, setDragging] = useState(false)
  const max = column === "sidebar" ? PANE_SIDEBAR_MAX_PX : PANE_RAIL_MAX_PX
  // The column on the far side of the line grows as the pointer moves away from the thread.
  const outward = column === "sidebar" ? 1 : -1
  const label = column === "sidebar" ? "Resize sidebar" : "Resize artifacts"

  // The column's width as drawn, and the most it can take: what the row has once the thread keeps its
  // measure and the column on the other side keeps its width. Never less than it already has, so a window
  // that has squeezed the thread does not make the handle jump on the first move.
  function measure(handle: HTMLElement) {
    const root = handle.closest<HTMLElement>("[data-pane-layout]")
    if (!root) return null
    const width = (selector: string) => root.querySelector(selector)?.getBoundingClientRect().width ?? 0
    const sidebar = width("[data-pane-sidebar]")
    const rail = width("[data-side-pane]")
    const own = column === "sidebar" ? sidebar : rail
    const threadFloor = wide ? PANE_THREAD_PX : Math.min(PANE_THREAD_PX, 0.62 * window.innerWidth)
    const room = root.clientWidth - threadFloor - (column === "sidebar" ? rail : sidebar)
    return { root, own, hi: Math.max(min, own, Math.min(max, room)) }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const m = measure(e.currentTarget)
    if (!m) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX
    let next: number | null = null
    const root = document.documentElement
    const before = { cursor: root.style.cursor, userSelect: root.style.userSelect }
    root.style.cursor = "col-resize"
    root.style.userSelect = "none"
    setDragging(true)
    const move = (ev: PointerEvent) => {
      next = Math.round(Math.min(m.hi, Math.max(min, m.own + outward * (ev.clientX - startX))))
      m.root.style.setProperty(RESIZE_VAR[column], `${next}px`)
    }
    const end = () => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", end)
      handle.removeEventListener("pointercancel", end)
      root.style.cursor = before.cursor
      root.style.userSelect = before.userSelect
      setDragging(false)
      // A press that never moved stores nothing, so a click (or the double-click that resets) does not pin
      // whatever width the window had squeezed the column to.
      if (next !== null) prefs[RESIZE_PREF[column]] = next
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", end)
    handle.addEventListener("pointercancel", end)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
    if (step === 0) return
    const m = measure(e.currentTarget)
    if (!m) return
    e.preventDefault()
    prefs[RESIZE_PREF[column]] = Math.round(Math.min(m.hi, Math.max(min, m.own + outward * step * (e.shiftKey ? 64 : 16))))
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-pane-resize={column}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => { prefs[RESIZE_PREF[column]] = null }}
      // The column's border is its outermost pixel, so the line's centre is half a pixel inside its edge.
      className={`group absolute inset-y-0 z-[5] w-[9px] cursor-col-resize touch-none outline-none ${column === "sidebar" ? "-left-[4px]" : "-right-[4px]"}`}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 transition-colors duration-150 ${
          dragging ? "bg-accent/70" : "bg-transparent group-hover:bg-border-strong group-focus-visible:bg-accent/70"
        }`}
      />
    </div>
  )
}

function PaneEmpty({ parked, queue }: { parked: boolean; queue: readonly ThreadRow[] }) {
  // A thread URL still settling has a thread coming, so the prompt would only flash.
  if (parked) return null
  if (queue.length === 0) {
    return (
      <div data-pane-empty className="flex h-full flex-col items-center justify-center gap-2">
        <Inbox size={40} strokeWidth={1.25} className="text-muted-30" />
        <div className="text-[13px] text-muted-80">No threads awaiting human input</div>
      </div>
    )
  }
  const first = queue[0]!
  return (
    <div data-pane-empty className="flex h-full flex-col items-center justify-center px-8 text-center">
      <h2 className="text-[17px] font-medium text-fg">{queue.length === 1 ? "1 thread is waiting on you" : `${queue.length} threads are waiting on you`}</h2>
      <div className="mt-1.5 flex max-w-full items-baseline gap-1.5 text-[13px] text-muted">
        <span className="min-w-0 truncate">{displayTitle(first)}</span>
        <LastActive at={first.lastActivityAt} className="shrink-0 text-muted-70" />
      </div>
      <button
        type="button"
        data-pane-open-first
        onClick={openFirstQueued}
        className="mt-5 flex h-8 items-center gap-2 rounded-lg bg-fg pl-3 pr-2.5 text-[13px] font-medium text-bg outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent"
      >
        Open first item
        <span aria-hidden className="text-[12px] opacity-60">⏎</span>
      </button>
    </div>
  )
}
