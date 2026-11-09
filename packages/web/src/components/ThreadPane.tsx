import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Inbox } from "lucide-react"
import { useSnapshot } from "valtio"
import type { ThreadView as ThreadRow } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { displayTitle, isPinned, orderQueue, queued } from "../groups.ts"
import { useBoard, useQueuedThreads, useThreadSnapshot, warmTranscript } from "../hooks.ts"
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
  advanceFrom, nextQueuedAfter, openFirstQueued, PANE_SIDEBAR_MAX_PX, PANE_THREAD_PX, paneAfterSend, paneProto, publishPaneQueue, reinstate, setPaneFolded, stepPane,
  takeComposerFocus, usePaneWide, type AfterSend,
} from "../lib/threadPane.ts"
import { store, threadBySlug } from "../store.ts"
import { ThreadView } from "./ChatView.tsx"
import { LastActive } from "./LastActive.tsx"
import { RAIL_WIDTH } from "./FocusRail.tsx"
import { LAYOUT_VARS, SidePane } from "./StandaloneThreadPage.tsx"

// THE ONE-THREAD PANE, a PROTOTYPE (see lib/threadPane.ts): the board as a sidebar and one thread at full
// height. The thread is the same ThreadView the drawer and /full draw; everything a queue card did about
// scrolling and fading is simply absent, because nothing here moves but the swap of one thread for another.

// THE COLUMNS MEET EDGE TO EDGE, AND THE SIDEBAR TAKES THE SLACK UP TO A LIMIT (maintainer 2026-11-09: the
// rail "just immediately up against the content window", "the same thing for the sidebar", and of a sidebar
// with no limit, "That looks insane … some reasonable max width, and then, if there's extra horizontal
// space, it should just be off to the far left and to the far right"). The thread and the rail hold their
// widths, the sidebar grows to lib/threadPane.ts PANE_SIDEBAR_MAX_PX, and the group centres in what is
// left. These are its minimums: 300 + the thread's 720 + the rail's 340 is the 1360 the three columns start
// at (PANE_WIDE_MIN_PX). Its 16px insets are the peek's, so the two read alike.
const WIDE_SIDEBAR_PX = 300
const NARROW_SIDEBAR_PX = 272

/** The queue in the order the pane walks it: the order the queue's cards stood in. */
export function usePaneQueue(): readonly ThreadRow[] {
  const onConsole = isConsolePath()
  const group = useConsoleGroup()
  const projects = useConsoleProjectList(onConsole)
  const order = useSnapshot(prefs).queueOrder
  const overlaid = useOptimisticallyArchived(useOptimisticallySteered(useQueuedThreads()))
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
  // With nothing selected there is nothing to be full screen about.
  const folded = proto.folded && slug !== null
  const threeColumns = wide && !folded
  // A file wants more room than the rail's 340, so while one is open the thread and the file take the page
  // (PaneThread) and the sidebar gives up what they need of it: the file gets the thread's 720 before the
  // sidebar stands above its minimum.
  const fileBeside = threeColumns && snap.filePanels.length > 0
  const sidebarFlex = fileBeside
    ? `0 0 clamp(${WIDE_SIDEBAR_PX}px, calc(100% - ${2 * PANE_THREAD_PX}px), ${PANE_SIDEBAR_MAX_PX}px)`
    : "1 1 0"
  const [peek, setPeek] = useState(false)
  if (!folded && peek) setPeek(false)
  // A board's sidebar opens level with the thread's header (its 52px was the line the first queue card
  // opened on). The Console's top is held by the home switcher above its status row.
  const boardTop = isConsolePath() ? "" : "[&>aside]:!pt-3"

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
      className={`flex h-dvh w-full overflow-hidden ${folded || fileBeside ? "" : "justify-center"}`}
    >
      {/* The sidebar never unmounts across the wide line: the same docked column at every width. Full
          screen it waits off the left edge, and a pointer at that edge peeks it over the thread. */}
      {!folded ? (
        <div
          data-pane-sidebar
          className={`h-full px-4 [view-transition-name:pane-sidebar] [&>aside]:!w-full ${boardTop}`}
          style={{ flex: sidebarFlex, minWidth: wide ? WIDE_SIDEBAR_PX : NARROW_SIDEBAR_PX, maxWidth: PANE_SIDEBAR_MAX_PX }}
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
            className={`fixed left-0 top-0 z-20 h-dvh border-r border-border bg-bg px-4 shadow-2xl transition-[translate,opacity] duration-150 ease-out ${boardTop} ${peek ? "translate-x-0 opacity-100" : "-translate-x-full opacity-0"}`}
          >
            {sidebar}
          </div>
        </>
      )}
      <main
        id="workpane"
        className="h-full min-w-0"
        style={{ flex: folded || fileBeside ? "1 1 0" : threeColumns ? `0 1 ${PANE_THREAD_PX + RAIL_WIDTH}px` : `0 0 min(${PANE_THREAD_PX}px, 62vw)` }}
      >
        {slug ? <PaneThread key={slug} slug={slug} folded={folded} wide={wide} /> : <PaneEmpty parked={snap.routeThreadSlug !== null} queue={queue} />}
      </main>
      <PrototypeControls />
    </div>
  )
}

function PaneThread({ slug, folded, wide }: { slug: string; folded: boolean; wide: boolean }) {
  const snap = useSnapshot(store)
  const board = useBoard()
  const thread = useThreadSnapshot(slug)
  const route = resolveThreadRoute(board, slug, threadBySlug)
  const queryClient = useQueryClient()
  const threeColumns = wide && !folded
  // The rail stands beside the thread full screen (from the split width up, as on /full) and in the three
  // columns.
  const railBeside = folded || threeColumns
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

  // While the rail is beside the thread a file opens beside it too, as it does on /full. Narrowing the
  // window past the wide line unfolded takes the rail away, and an open file with it.
  useEffect(() => {
    if (!railBeside) return
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
  }, [railBeside])

  const pane = useMemo(() => ({
    exit: {
      dismiss: () => advanceFrom(slug, { dismissed: true }),
      cancel: () => reinstate(slug),
      sent: () => paneAfterSend(slug),
    },
    // Full screen is one click from the open thread at every width: it is how one thread gets the page to
    // itself (maintainer 2026-11-09). Already there, the header has the door's closing half instead.
    expand: !folded,
    railBeside: threeColumns,
    queueWindow: opensQueued === true,
  }), [slug, folded, threeColumns, opensQueued])

  // ONE TREE IN EVERY LAYOUT, each slot a fixed element whose classes change, so crossing the wide line
  // or folding never remounts the thread: the transcript keeps its scroll and the prompt box its focus.
  //   [gutter] [thread] [side pane]
  // The gutter is /full's centring (LAYOUT_VARS), full screen only: in the three columns the thread
  // stands hard against the sidebar and the rail.
  return (
    <ProjectScope project={keyProject(slug)}>
      <div
        className={`flex h-full w-full transition-transform duration-200 ease-out motion-reduce:transition-none ${threeColumns ? "" : "justify-center split:justify-start"}`}
        style={{
          ...LAYOUT_VARS,
          // In the three columns and at rest the side pane is the rail alone; with a file it is /full's
          // pane, the half of the room right of the sidebar that the thread (--full-thread) does not take.
          ...(threeColumns && !fileBeside ? { "--full-pane": `${RAIL_WIDTH}px` } : null),
          transform: fileOpen ? "translateX(calc(-1 * var(--full-gutter)))" : undefined,
        } as CSSProperties}
      >
        {folded && <div aria-hidden="true" className="hidden w-[var(--full-gutter)] shrink-0 split:block" />}
        <div
          data-pane-thread
          className={`flex h-full min-w-0 flex-col overflow-hidden border-x border-border bg-panel [view-transition-name:thread-chat] ${
            threeColumns
              // 720 is the drawer's width (lib/sheet.ts SHEET_BASE_WIDTH), the measure every thread surface
              // keeps. It gives way only to the opt-in project rail, whose 57px the 1360 does not count.
              ? fileBeside ? "w-[var(--full-thread)] shrink-0" : "w-[720px] shrink"
              : folded ? "w-[var(--full-thread-narrow)] shrink-0 split:w-[var(--full-thread)]" : "w-full shrink-0"
          }`}
        >
          {route.kind === "found" ? (
            <ThreadView slug={slug} showReturnToQueue={folded} pane={pane} />
          ) : route.kind === "missing" ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted" role="status">Thread “{slug}” was not found in this project.</div>
          ) : (
            <div className="flex flex-1 items-center justify-center"><span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" /></div>
          )}
        </div>
        {railBeside && thread && <SidePane slug={slug} thread={thread} />}
      </div>
    </ProjectScope>
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

// The question a still frame cannot answer, kept out of Settings because it is not a setting.
function PrototypeControls() {
  const proto = useSnapshot(paneProto)
  return (
    <details data-pane-prototype className="group fixed bottom-3 left-3 z-20 text-[12px]">
      <summary className="w-fit cursor-pointer list-none rounded-md border border-border bg-panel-2 px-2 py-1 text-muted-80 outline-none transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
        Prototype
      </summary>
      <div className="absolute bottom-8 left-0 flex w-[300px] flex-col gap-3 rounded-lg border border-border bg-panel p-3 shadow-2xl">
        <ProtoChoice<AfterSend>
          name="After a send"
          value={proto.afterSend}
          onChange={(v) => { paneProto.afterSend = v }}
          options={[
            ["stay", "Stay on the thread", "⇧⌘⏎ sends and moves on"],
            ["next", "Go to the next one", "Every send moves on"],
            ["auto", "Depends how it was opened", "Stays from a row, moves on from the queue"],
          ]}
        />
      </div>
    </details>
  )
}

function ProtoChoice<V extends string>({ name, value, onChange, options }: { name: string; value: V; onChange: (v: V) => void; options: readonly (readonly [V, string, string])[] }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-[11px] font-medium text-muted-70">{name}</legend>
      {options.map(([v, label, says]) => (
        <label key={v} className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 hover:bg-hover">
          <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} className="mt-[3px] accent-[var(--color-accent)]" />
          <span className="min-w-0">
            <span className="block leading-[18px] text-fg">{label}</span>
            <span className="block text-[11.5px] leading-[15px] text-muted">{says}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}
