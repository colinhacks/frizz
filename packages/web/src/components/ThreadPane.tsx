import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronUp, Inbox, PanelLeftOpen } from "lucide-react"
import { useSnapshot } from "valtio"
import type { ThreadView as ThreadRow } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { displayTitle, isPinned, orderQueue, partitionActive, queued, sectionThreads } from "../groups.ts"
import { useBoard, useBoardThreads, useQueuedThreads, useThreadSnapshot, warmTranscript } from "../hooks.ts"
import { isConsolePath } from "../lib/base-path.ts"
import { consoleCardOrder, useConsoleGroup } from "../lib/consoleBoard.ts"
import { useConsoleProjectList } from "../lib/consoleProjects.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { useOptimisticallyArchived } from "../lib/optimisticArchive.ts"
import { prefs } from "../lib/prefs.ts"
import { ProjectScope } from "../lib/projectScope.tsx"
import { SPLIT_MIN_PX } from "../lib/sheet.ts"
import { useOptimisticallySteered } from "../lib/steering.ts"
import { keyProject } from "../lib/threadKey.ts"
import { resolveThreadRoute } from "../lib/threadRouteState.ts"
import {
  advanceFrom, nextQueuedAfter, openFirstQueued, paneAfterSend, paneProto, publishPaneQueue, reinstate, setPaneFolded, stepPane, takeComposerFocus,
  type AfterSend, type FoldStyle,
} from "../lib/threadPane.ts"
import { openThread, store, threadBySlug } from "../store.ts"
import { ThreadView } from "./ChatView.tsx"
import { LastActive } from "./LastActive.tsx"
import { ThreadIndicator } from "./Sidebar.tsx"
import { LAYOUT_VARS, SidePane } from "./StandaloneThreadPage.tsx"
import { Tooltip } from "./Tooltip.tsx"

// THE ONE-THREAD PANE, a PROTOTYPE (see lib/threadPane.ts): the board as a sidebar and one thread at full
// height. The thread is the same ThreadView the drawer and /full draw; everything a queue card did about
// scrolling and fading is simply absent, because nothing here moves but the swap of one thread for another.

const SLIM_RAIL_W = 52
const SIDEBAR_W = "clamp(272px,34vw,680px)"

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
  const queue = usePaneQueue()
  publishPaneQueue(queue.map((t) => t.id))
  const slug = snap.paneSlug
  // With nothing selected there is nothing to be full screen about.
  const folded = proto.folded && slug !== null
  const slim = folded && proto.foldStyle === "slim"
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
      className="flex h-dvh w-full justify-center overflow-hidden"
      style={{ gap: folded ? 0 : "clamp(28px,3.4vw,52px)", paddingInline: folded ? 0 : 20 }}
    >
      {/* The sidebar never unmounts: its bands, its scroll and the prompt box's draft are all there when
          it comes back. Folded it waits off the left edge, and a pointer at that edge peeks it over the
          thread. */}
      {!folded ? (
        <div data-pane-sidebar className={`h-full shrink-0 [view-transition-name:pane-sidebar] ${boardTop}`} style={{ width: SIDEBAR_W }}>
          {sidebar}
        </div>
      ) : (
        <>
          {slim && <SlimRail />}
          <div
            aria-hidden="true"
            data-pane-edge
            onMouseEnter={() => setPeek(true)}
            className="fixed inset-y-0 left-0 z-20 w-2"
            style={{ display: slim ? "none" : undefined }}
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
      <main id="workpane" className="h-full min-w-0" style={{ width: folded ? `calc(100% - ${slim ? SLIM_RAIL_W : 0}px)` : "min(720px, 62vw)" }}>
        {slug ? <PaneThread key={slug} slug={slug} folded={folded} /> : <PaneEmpty parked={snap.routeThreadSlug !== null} queue={queue} />}
      </main>
      <PrototypeControls />
    </div>
  )
}

function PaneThread({ slug, folded }: { slug: string; folded: boolean }) {
  const snap = useSnapshot(store)
  const board = useBoard()
  const thread = useThreadSnapshot(slug)
  const route = resolveThreadRoute(board, slug, threadBySlug)
  const queryClient = useQueryClient()
  const fileOpen = folded && snap.filePanels.some((panel) => !panel.closing)

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

  // While folded a file opens beside the thread, as it does on /full.
  useEffect(() => {
    if (!folded) return
    const wide = window.matchMedia?.(`(min-width: ${SPLIT_MIN_PX}px)`)
    if (!wide) return
    const apply = () => { store.splitFileViewer = wide.matches }
    apply()
    wide.addEventListener("change", apply)
    return () => {
      wide.removeEventListener("change", apply)
      store.splitFileViewer = false
      store.filePanels = []
    }
  }, [folded])

  const pane = useMemo(() => ({
    exit: {
      dismiss: () => advanceFrom(slug, { dismissed: true }),
      cancel: () => reinstate(slug),
      sent: () => paneAfterSend(slug),
    },
    expand: !folded,
    stepper: <PaneStepper slug={slug} />,
  }), [slug, folded])

  return (
    <ProjectScope project={keyProject(slug)}>
      <div
        className="flex h-full w-full justify-center transition-transform duration-200 ease-out motion-reduce:transition-none split:justify-start"
        style={{ ...LAYOUT_VARS, transform: fileOpen ? "translateX(calc(-1 * var(--full-gutter)))" : undefined }}
      >
        {folded && <div className="hidden w-[var(--full-gutter)] shrink-0 split:block" aria-hidden="true" />}
        <div
          data-pane-thread
          className={`flex h-full min-w-0 shrink-0 flex-col overflow-hidden border-x border-border bg-panel [view-transition-name:thread-chat] ${
            folded ? "w-[var(--full-thread-narrow)] split:w-[var(--full-thread)]" : "w-full"
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
        {folded && thread && <SidePane slug={slug} thread={thread} />}
      </div>
    </ProjectScope>
  )
}

function PaneStepper({ slug }: { slug: string }) {
  const queue = usePaneQueue()
  if (queue.length === 0) return null
  const at = queue.findIndex((t) => t.id === slug)
  return (
    // The two chevrons read as one control: 14.5px of ink between them, the distance from the count to the
    // first. Their boxes alone put 20.5px there (measured at 1440px, dsf 6; count and chevron share a centre).
    <span data-pane-stepper className="flex shrink-0 items-center">
      <span data-pane-position className="mr-1 text-[12px] tabular-nums text-muted-80">{at === -1 ? `${queue.length} waiting` : `${at + 1} of ${queue.length}`}</span>
      <Tooltip label="Previous in queue (⌥↑)">
        <button type="button" aria-label="Previous in queue" disabled={at <= 0} onMouseDown={(e) => e.preventDefault()} onClick={() => stepPane(-1)} className={`${HEADER_ICON_CLASS} disabled:opacity-30`}>
          <ChevronUp size={15} strokeWidth={2} />
        </button>
      </Tooltip>
      <Tooltip label="Next in queue (⌥↓)">
        <button type="button" aria-label="Next in queue" disabled={at === queue.length - 1} onMouseDown={(e) => e.preventDefault()} onClick={() => stepPane(1)} className={`${HEADER_ICON_CLASS} -ml-1.5 disabled:opacity-30`}>
          <ChevronDown size={15} strokeWidth={2} />
        </button>
      </Tooltip>
    </span>
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

function SlimRail() {
  const { paneSlug } = useSnapshot(store)
  const order = useSnapshot(prefs).queueOrder
  const all = useOptimisticallyArchived(useOptimisticallySteered(useBoardThreads()))
  const { running, rested } = useMemo(() => partitionActive(sectionThreads(all, order).active), [all, order])
  const row = (t: ThreadRow) => (
    <Tooltip key={t.id} side="right" label={displayTitle(t)}>
      <button
        type="button"
        data-pane-slim-row={t.id}
        aria-current={paneSlug === t.id ? "location" : undefined}
        onClick={() => openThread(t.id)}
        className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-hover ${paneSlug === t.id ? "bg-hover" : ""}`}
      >
        {paneSlug === t.id && <span aria-hidden className="absolute inset-y-1 -left-[9px] w-[2px] rounded-full bg-accent" />}
        {/* The mark's own tooltip names its state; the row's names the thread, which is what is missing here. */}
        <span className="pointer-events-none flex"><ThreadIndicator t={t} /></span>
      </button>
    </Tooltip>
  )
  return (
    <nav data-pane-slim-rail aria-label="Threads" className="flex h-full shrink-0 flex-col items-center gap-0.5 overflow-y-auto overflow-x-hidden border-r border-border py-2 [scrollbar-gutter:auto] [scrollbar-width:none]" style={{ width: SLIM_RAIL_W }}>
      <Tooltip side="right" label="Show sidebar (⌘\)">
        <button type="button" aria-label="Show sidebar" onClick={() => setPaneFolded(false)} className={HEADER_ICON_CLASS}>
          <PanelLeftOpen size={15} strokeWidth={2} />
        </button>
      </Tooltip>
      {rested.length > 0 && <div className="mt-2 mb-0.5 text-[11px] tabular-nums text-muted-70">{rested.length}</div>}
      {rested.map(row)}
      {running.length > 0 && rested.length > 0 && <div aria-hidden className="my-1.5 h-px w-5 shrink-0 bg-border" />}
      {running.map(row)}
    </nav>
  )
}

// The two questions a still frame cannot answer, kept out of Settings because they are not settings.
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
        <ProtoChoice<FoldStyle>
          name="Full screen (⌘\)"
          value={proto.foldStyle}
          onChange={(v) => { paneProto.foldStyle = v }}
          options={[
            ["away", "Sidebar slides away", "Pointer at the left edge peeks it back"],
            ["slim", "Slim rail", "One mark per thread stays on screen"],
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
