import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react"
import { ExternalLink, FileText, ListTodo } from "lucide-react"
import type { BgShellView, ThreadView } from "@frizz/shared"
import { CHILD_RESTED_DOT_CLASS, CHILD_STALE_DOT_CLASS, type TranscriptShellRecord } from "../lib/childOps.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { isRunningOperation } from "../lib/operationIndicators.ts"
import { panelWidthOn } from "../lib/overlaySurface.ts"
import { extendTrail, trailHeadingInto, type PointerSample } from "../lib/pointerAim.ts"
import { queueOpsCounts, type QueueOpsCount, type QueueOpsKind } from "../lib/queueOpsCounts.ts"
import { threadOps } from "../lib/threadOps.ts"
import { commandWatchLabel, commandWatchStatus, commandWatchTitle, timerWatchStatus, timerWatchTitle } from "./AwaitingBackgroundCard.tsx"
import { HumanTodoList } from "./AwaitingSteps.tsx"
import { BackgroundOpsStrip } from "./ChatView.tsx"
import { ChildOpRow } from "./ChildOpRow.tsx"
import { ChildThreadRows } from "./ChildThreadRows.tsx"
import { useChildThreads } from "../hooks.ts"
import { QueueSubAgentLines } from "./QueueSubAgentLines.tsx"
import { useSurfaceOpsThread } from "./ThreadSurface.tsx"
import { pushMonitorDrawer } from "../store.ts"
import { Popover, PopoverAnchor, PopoverContent } from "./ui/Popover.tsx"

// THE QUEUE CARD'S LIVE OPS, CONDENSED: one line of counts at the right, just above the docked prompt
// box — "● 2 agents  ● 1 shell  ● 1 PR  ▤ 2 files" — with the ⤷ rows themselves one hover away.
//
// Until 2026-10-05 every live op was its own ⤷ row hanging under the card's prompt box, then the
// lifecycle footer under those: on a busy thread the bottom of a card was a column of rows taller than
// the reply it carried, all of it scrolling away with the card. The prompt box now docks to the bottom
// of the screen while the card is on it, and a dock cannot carry a column of rows, so the rows fold into
// counts (maintainer: "the area where we list out all of the sub agents and the files and all of that
// should probably just show up as like a condensed view, like to the upper right of the prompt box,
// where it just lists out the number of subagents, the number of files, et cetera … Then you can hover
// over to see the details").
//
// EACH COUNT OPENS ITS OWN PANEL, holding that kind of row and no other (maintainer 2026-10-11: "there
// should be a popover for each of the different categories … If you hover over Files, it should show
// the files. If you hover over the pull request watchers, it should show the pull request"). Until then
// the whole line was one control over one panel listing every row, so the count the pointer was on said
// nothing about what opened. One panel is open at a time, and the pointer moving along the line swaps
// it the way a menu bar does.
//
// EVERY PANEL OPENS IN THE SAME PLACE, right-aligned to the line, which ends where the prompt box does
// (maintainer 2026-10-17: "those popovers should always show up in the same place, regardless of which
// one you're hovering over"). Each panel was right-aligned to its own count until then, so sliding along
// six counts walked it 322px sideways and the first count's panel hung 125px past the card's left edge.
// The hovered count keeps its highlight, and that is what says which kind is open.
//
// A TRIANGLE ON ITS BOTTOM EDGE POINTS AT THE COUNT THAT OPENED IT, since the panel itself stays put, and
// slides to the next count as the pointer moves along the line (maintainer 2026-11-06). The panel's bottom
// edge sits on the rule over the line, so the two draw one line: 1px apart they read as a doubled rule.
//
// THE ROWS IN A PANEL ARE THE REAL ONES — QueueSubAgentLines and BackgroundOpsStrip, the components
// that drew them under the box, at the menu-sized density they take here (ChildOpRow's "panel") — so a row
// still opens its drawer, stops its child, and reads its CI the way it did. The COUNTS are taken from the same lists those components render, by the same filters, so
// a count and its panel cannot disagree about how many there are (lib/queueOpsCounts.ts).
//
// THE DRAWER DRAWS THE SAME LINE, since 2026-10-09 (maintainer: "We should be using the condensed
// activity summary in the queue cards as well as in the drawer view"). Until then the drawer kept the
// ⤷ column under its prompt box, so one thread read as counts on its card and as a column of rows in
// its drawer. Both hand in the shells they read off the transcript (`transcriptShells`), which the board
// does not report for a Codex thread. The phone and /full
// beside its rail draw neither: the ⋯ sheet and the rail already list every row (ChatView).
//
// THE MARK IS THE ROWS' OWN LIVENESS DOT, in the row's hue (yellow agent, blue shell, violet watch), and
// it pulses only while at least one row of that kind is running. Otherwise it is the rows' own settled
// mark (lib/childOps.ts): the hollow ring when one of them rested, the flat dot when they went stale.

// THE POINTER'S WAY INTO A PANEL IS ITS OWN (maintainer 2026-11-06: "It's kind of hard to click on the
// things, especially for links, without the little popover going away"). Every panel is right-aligned to
// the line and a row's label sits at the panel's far left, so from "1 link" the natural line to "Dev
// server" runs 300px left and only 30px up: straight across "2 files" and "1 issue", each of which took
// the panel for itself, and through the 4px gap at a shallow enough angle to outlast the close delay.
// Driven on the real card, that line read link → file → issue → closed.
//
// So a count the pointer is merely CROSSING does not take the panel. While the pointer is still closing
// on the open panel (lib/pointerAim.ts) a swap waits, and a close does too; the moment it stops, or turns
// away, whichever count it is on takes over. Sliding along the line of counts never rises toward the
// panel, so it still swaps at once, the way a menu bar does.
//
// How long a panel survives the pointer leaving both it and its count, once the pointer is not heading
// back to it.
const HOVER_CLOSE_DELAY_MS = 300
// How often a held swap or close looks at the pointer again. A pointer that stopped reads as stopped
// within REST_MS, so a deliberate hover on a neighbouring count wins in about that long.
const AIM_RECHECK_MS = 50

// The panel's width where the line is wide enough. A share of the box sets it on every 720px surface.
const PANEL_WIDEST_PX = 480
// What a triangle takes up on the panel's edge, across and down. Its tip stops just short of the count,
// which stands about 5.4px under the rule the panel sits on.
const CARET_WIDTH_PX = 12
const CARET_HEIGHT_PX = 6

// What a panel is called, since it holds one kind of row.
const PANEL_LABEL: Record<QueueOpsKind, string> = {
  todo: "What this thread needs a person to do",
  agent: "Sub-agents running for this thread",
  child: "Child threads this thread started",
  shell: "Background shells running for this thread",
  pr: "Pull requests this thread is watching",
  issue: "Issues this thread is watching",
  command: "Monitors this thread is waiting on",
  timer: "Timers this thread has set",
  file: "Files saved for this thread",
  link: "Links saved for this thread",
}

export function QueueOpsSummary({ thread: given, transcriptShells = [] }: { thread: ThreadView; transcriptShells?: readonly (BgShellView & TranscriptShellRecord)[] }) {
  // The counts move with the transcript's Agent rows, not ahead of them (ThreadSurface opsThread).
  const thread = useSurfaceOpsThread(given)
  // The thread's CHILD THREADS are other rows of the board, read here rather than off the thread (they
  // are not held with the transcript the way its Agent rows are: a child is not drawn in this transcript).
  const childThreads = useChildThreads(thread.id)
  const [openKind, setOpenKind] = useState<QueueOpsKind | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const swapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    clearTimeout(closeTimer.current)
    clearTimeout(swapTimer.current)
  }, [])
  const groups = queueOpsCounts(thread, transcriptShells, childThreads)
  const line = useRef<HTMLDivElement>(null)
  // Where the pointer has just been, for as long as a panel is open. On the document, because the panel
  // is portaled and the pointer's whole path runs between the two.
  const trail = useRef<PointerSample[]>([])
  const anyOpen = openKind !== null
  // Where the open panel's triangle stands, so the next count's panel can start its own there and slide.
  const caretAt = useRef<number | null>(null)
  useEffect(() => {
    if (!anyOpen) {
      caretAt.current = null
      return
    }
    const follow = (event: PointerEvent) => {
      trail.current = extendTrail(trail.current, { x: event.clientX, y: event.clientY, at: performance.now() })
    }
    document.addEventListener("pointermove", follow, { capture: true, passive: true })
    return () => {
      document.removeEventListener("pointermove", follow, { capture: true })
      trail.current = []
    }
  }, [anyOpen])
  // Only one panel is mounted at a time, so the last to mount is the open one.
  const openPanel = useRef<HTMLDivElement | null>(null)
  const registerPanel = useCallback((element: HTMLDivElement | null) => {
    if (element) openPanel.current = element
  }, [])
  const headingIntoPanel = () => {
    const rect = openPanel.current?.isConnected ? openPanel.current.getBoundingClientRect() : undefined
    return !!rect && trailHeadingInto(trail.current, performance.now(), rect)
  }
  // The last row of a kind can end, or be stopped from its × in the panel, while its panel is open —
  // and nothing then says close: the count unmounts and its panel with it, so no pointer leaves either
  // and Radix sends no change. Left set, the panel sprang open by itself, over the transcript, the next
  // time the agent started anything of that kind. With nothing of that kind to count it is closed.
  const gone = openKind !== null && !groups.some((group) => group.key === openKind)
  useEffect(() => {
    if (!gone) return
    clearTimeout(closeTimer.current)
    clearTimeout(swapTimer.current)
    setOpenKind(null)
  }, [gone])
  if (groups.length === 0) return null
  const openNow = (kind: QueueOpsKind) => {
    clearTimeout(closeTimer.current)
    clearTimeout(swapTimer.current)
    setOpenKind(kind)
  }
  // The pointer arrived on a count. With another count's panel open and the pointer still closing on it,
  // this count is only on the way, so it waits for the pointer to settle.
  const hoverCount = (kind: QueueOpsKind) => {
    clearTimeout(closeTimer.current)
    clearTimeout(swapTimer.current)
    if (openKind === null || openKind === kind || !headingIntoPanel()) {
      setOpenKind(kind)
      return
    }
    swapTimer.current = setTimeout(() => hoverCount(kind), AIM_RECHECK_MS)
  }
  // The pointer entered the panel: it arrived, and nothing it crossed on the way may now take over.
  const holdPanel = () => {
    clearTimeout(closeTimer.current)
    clearTimeout(swapTimer.current)
  }
  const closeSoon = () => {
    clearTimeout(closeTimer.current)
    clearTimeout(swapTimer.current)
    const closeUnlessHeadingBack = () => {
      if (headingIntoPanel()) closeTimer.current = setTimeout(closeUnlessHeadingBack, AIM_RECHECK_MS)
      else setOpenKind(null)
    }
    closeTimer.current = setTimeout(closeUnlessHeadingBack, HOVER_CLOSE_DELAY_MS)
  }
  return (
    // THE LINE FILLS THE DOCK'S TOP INSET AND SITS IN THE MIDDLE OF IT. `-mt-3 h-8`: the dock pads 12px
    // over its content (the drawer's footer pads the same), so the line starts on the rule and the prompt
    // box stands 32px under it, where it stood before. It was `-mt-2 h-7 items-center` until 2026-10-11,
    // which centred the counts in the lower 28px of those 32: 14.27px from the rule down to the cap band
    // and 9.63px from the baseline to the box (maintainer: "there's more space above the artifact chips
    // than below. The spacing looks off").
    //
    // THE BROWSER PLACES THE BASELINE, not a nudge fitted to one font. The strut is an empty box, whose
    // baseline is its bottom edge, and it is the tallest thing above the row's shared baseline — so the
    // baseline lands `16px + 0.5cap` under the rule, and the cap band's centre lands on 16px, half of the
    // 32. Measured after, sans: 11.94px above the cap band and 11.95px under the baseline, on the queue
    // card and in the drawer (queueOpsPanels.e2e.test.ts pins the pair). The size is set HERE so the
    // strut's `cap` is the counts' own.
    <div data-queue-ops-summary ref={line} className="-mt-3 flex h-8 min-w-0 items-baseline justify-end text-[11.5px]">
      <span aria-hidden className="h-[calc(16px_+_0.5cap)] w-0 shrink-0" />
      {groups.map((group) => (
        <OpsCount
          key={group.key}
          group={group}
          line={line}
          open={openKind === group.key}
          onOpen={() => openNow(group.key)}
          onHover={(event) => {
            // Where it came in is the first thing the trail knows: the document's listener only starts once
            // a panel is open, so a flick off a count that had just opened one had no direction to read.
            trail.current = extendTrail(trail.current, { x: event.clientX, y: event.clientY, at: performance.now() })
            hoverCount(group.key)
          }}
          onHoverPanel={holdPanel}
          onCloseSoon={closeSoon}
          registerPanel={registerPanel}
          caretAt={caretAt}
          // A change Radix sends for one panel (a press outside it, Escape, focus moving on) closes only
          // that panel: by then the pointer or the focus may already have opened the next count's.
          onOpenChange={(next) => (next ? openNow(group.key) : setOpenKind((current) => (current === group.key ? null : current)))}
        >
          {group.key === "todo"
            ? <div className="px-2 py-1.5"><HumanTodoList thread={thread} /></div>
            : group.key === "agent"
            ? <QueueSubAgentLines slug={thread.id} subAgents={thread.subAgents ?? []} className="" density="panel" />
            : group.key === "child"
            ? <div data-queue-child-threads className="flex min-w-0 flex-col"><ChildThreadRows parent={thread.id} childThreads={childThreads} density="panel" /></div>
            : group.key === "command" || group.key === "timer"
            ? <WaitPanelRows thread={thread} kind={group.key} />
            : <BackgroundOpsStrip slug={thread.id} includeAgents={false} only={group.key} transcriptShells={transcriptShells} className="" density="panel" />}
        </OpsCount>
      ))}
    </div>
  )
}

// One count and the panel it opens.
function OpsCount({ group, line, open, onOpen, onHover, onHoverPanel, onCloseSoon, registerPanel, caretAt, onOpenChange, children }: {
  group: QueueOpsCount
  line: RefObject<HTMLDivElement | null>
  open: boolean
  onOpen: () => void
  onHover: (event: ReactMouseEvent) => void
  onHoverPanel: () => void
  onCloseSoon: () => void
  registerPanel: (element: HTMLDivElement | null) => void
  caretAt: RefObject<number | null>
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  // THE PANEL'S ANCHOR IS THE LINE, whose top is the rule the panel's bottom edge sits on. So every count's
  // panel takes the same place. `contextElement` is the line, which floating-ui watches for scroll, resize
  // and moves in a virtual anchor's place.
  const [anchor] = useState(() => ({
    current: {
      getBoundingClientRect: () => line.current?.getBoundingClientRect() ?? new DOMRect(),
      get contextElement() {
        return line.current ?? undefined
      },
    },
  }))
  const word = group.n === 1 ? group.one : group.many
  // THE KEYBOARD'S WAY IN. Focus opens the panel the way hover does, but it is portaled to the end of the
  // page, so Tab from a count goes to the next count and then the prompt box, and the panel closes — its
  // rows (open a drawer, stop a child) were Tab stops when they hung under the box. Enter, Space or ↓ on
  // a count moves focus to its panel's first control; Escape there brings it back to the count.
  const focusPanel = () => {
    onOpen()
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])")?.focus())
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchor} />
      <button
        type="button"
        data-ops-count={group.key}
        aria-label={`${group.n} ${word} — show ${group.n === 1 ? "it" : "them"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseEnter={onHover}
        onMouseLeave={onCloseSoon}
        onFocus={onOpen}
        ref={button}
        onClick={(event) => {
          // The line sits inside a queue card; the click is this control's, not the card's. A click
          // OPENS, never toggles: with a mouse the hover already opened the panel. A keyboard click
          // (Enter or Space, `detail` 0) carries focus into it.
          event.stopPropagation()
          if (event.detail === 0) focusPanel()
          else onOpen()
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return
          event.preventDefault()
          focusPanel()
        }}
        onMouseDown={(event) => event.preventDefault()}
        // `px-1.5` and no gap between the counts: two neighbours stand 12px apart, box to box, which is
        // what the one control's `gap-3` drew, and each count's hover square reaches halfway to the next.
        // Ink, scripts/ink-gaps.mjs at dsf 6, sans: 8.00–9.42px from a mark to its digit and
        // 13.57–14.64px from one count's word to the next count's mark, dots and icons alike.
        className={`flex shrink-0 items-baseline gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${open ? "bg-panel-2 text-fg/85" : "text-muted-70 hover:bg-panel-2 hover:text-fg/85"}`}
      >
        {/* ON THE CAP BAND, computed by the browser (the ThreadLinks icon idiom): a 1em slot whose
            bottom sits on the baseline, lifted so its centre lands at half the cap height — the
            count beside it is digits, which are cap-height ink. The mark is ABSOLUTELY centred in
            the slot, never a flex child of it: a flex slot takes its baseline from its first
            child, so a 6px dot's bottom edge (not the slot's) landed on the baseline and the dot
            rode ~2px low. An empty block synthesizes its baseline from its own bottom edge. */}
        <span aria-hidden className="relative block h-[1em] w-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]">
          <span className="absolute inset-0 flex items-center justify-center"><CountMark kind={group.key} states={group.states} /></span>
        </span>
        <span><span className="tabular-nums text-fg/85">{group.n}</span> {word}</span>
      </button>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={0}
        data-queue-ops-panel={group.key}
        aria-label={PANEL_LABEL[group.key]}
        onMouseEnter={onHoverPanel}
        onMouseLeave={onCloseSoon}
        // Hover opened it, so focus stays where the operator left it — the caret in the prompt box.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // A press on a count, or focus arriving on one, is the line's own gesture, and the line decides
        // what it opens. Without this Radix reads either as an interaction OUTSIDE the panel and shuts
        // it: a press closed the panel under the click that then had to reopen it, and Tab onto a count
        // opened its panel and closed it inside the same focus event — the panel mounts while that event
        // is still on its way to the document, where Radix has just started listening for it.
        onInteractOutside={(event) => {
          if (line.current?.contains(event.target as Node)) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          // Replaces the wrapper's handler, so it keeps that handler's one job: this Escape is the
          // panel's, not the window's (App, or /full's exit).
          event.stopPropagation()
          if (panel.current?.contains(document.activeElement)) button.current?.focus()
        }}
        ref={(element) => {
          panel.current = element
          registerPanel(element)
        }}
        onClick={(event) => event.stopPropagation()}
        // THE GAP IS PART OF THE PANEL, to the pointer: `before:` hangs an invisible strip from its edge
        // down to the counts, so nothing it crosses on the way up counts as having left.
        className="group/panel relative flex max-w-[calc(100vw-1.5rem)] flex-col p-1 before:absolute before:inset-x-0 before:top-full before:h-1.5 before:content-[''] data-[side=bottom]:before:top-auto data-[side=bottom]:before:bottom-full"
        style={open ? { width: panelWidthOn(line.current?.getBoundingClientRect().width ?? PANEL_WIDEST_PX, PANEL_WIDEST_PX) } : undefined}
      >
        {/* The scroll is in here so it cannot clip the triangle, which hangs off the panel's edge. No
            scrollbar: every other vertical scroller reserves one's 7px for good (styles.css), which set a
            row's fill 12px from the panel's right edge against 5px from its left. A row cut off by the edge
            is what says there is more, as it does in the prompt box. */}
        <div className="max-h-[min(20rem,50vh)] overflow-y-auto scrollbar-none">{children}</div>
        <PanelCaret count={button} line={line} caretAt={caretAt} />
      </PopoverContent>
    </Popover>
  )
}

// THE TRIANGLE ON A PANEL'S EDGE, over the middle of the count that opened it. The fill covers the panel's
// bottom border where the two meet, so the panel's outline runs on down the triangle's sides.
//
// A swap mounts a new panel, each count having its own, so the slide is this: start where the last
// triangle stood, and move to this count's place on the next frame. A panel opened from nothing starts
// in place.
function PanelCaret({ count, line, caretAt }: { count: RefObject<HTMLButtonElement | null>; line: RefObject<HTMLDivElement | null>; caretAt: RefObject<number | null> }) {
  const measure = () => {
    const span = line.current?.getBoundingClientRect()
    const chip = count.current?.getBoundingClientRect()
    // From the panel's right edge, which is the line's. `right` counts from inside the panel's 1px border.
    return span && chip ? span.right - (chip.left + chip.width / 2) - CARET_WIDTH_PX / 2 - 1 : 0
  }
  const [right, setRight] = useState(() => caretAt.current ?? measure())
  // On every render, since a count's place on its line moves whenever the line's other counts change.
  useEffect(() => {
    const target = measure()
    caretAt.current = target
    const frame = requestAnimationFrame(() => setRight(target))
    return () => cancelAnimationFrame(frame)
  })
  return (
    <svg
      aria-hidden
      data-queue-ops-caret
      width={CARET_WIDTH_PX}
      height={CARET_HEIGHT_PX}
      viewBox={`0 0 ${CARET_WIDTH_PX} ${CARET_HEIGHT_PX}`}
      style={{ right }}
      className="pointer-events-none absolute top-full transition-[right] duration-100 ease-out motion-reduce:transition-none group-data-[side=bottom]/panel:top-auto group-data-[side=bottom]/panel:bottom-full group-data-[side=bottom]/panel:rotate-180"
    >
      <path d="M1 0 L6 5 L11 0 Z" className="fill-elevated" />
      <path d="M.5 .75 L5.5 5.1 Q6 5.5 6.5 5.1 L11.5 .75" fill="none" strokeLinejoin="round" className="stroke-border" />
    </svg>
  )
}

function CountMark({ kind, states }: { kind: QueueOpsKind; states: readonly (string | undefined)[] }) {
  switch (kind) {
    case "todo": return <ListTodo aria-hidden className="h-[1em] w-[1em] text-muted-45" />
    case "agent":
    case "child": return <Dot hue="agent" states={states} />
    case "shell": return <Dot hue="shell" states={states} />
    case "pr":
    case "issue": return <Dot hue="github" states={states} />
    case "command":
    case "timer": return <Dot hue="github" states={states} />
    case "file": return <FileText aria-hidden className="h-[1em] w-[1em] text-muted-45" />
    case "link": return <ExternalLink aria-hidden className="h-[1em] w-[1em] text-muted-45" />
  }
}

function Dot({ hue, states }: { hue: "agent" | "shell" | "github"; states: readonly (string | undefined)[] }) {
  if (states.some(isRunningOperation)) return <span className={`frizz-live-dot frizz-live-dot--${hue}`} />
  return <span className={states.includes("rested") ? CHILD_RESTED_DOT_CLASS : CHILD_STALE_DOT_CLASS} />
}

// A COMMAND WATCH'S AND A TIMER'S PANEL — the strip's own ⤷ rows, as a PR's panel draws, so every
// panel on the line speaks one row. Their readings are the awaiting card's (CommandWatchRow, TimerRow):
// a command watch's cadence beside how long it has watched, as a PR row's check count sits beside its
// age, and a timer's countdown alone — beside it, the time since it was set would read as a second clock.
// A persistent watch's row opens its drawer (MonitorSheet), as a shell's does — its stop lives there, beside what
// it printed. A plain command watch and a timer have no drawer, so their rows are not buttons, and none
// carries a ×.
function WaitPanelRows({ thread, kind }: { thread: ThreadView; kind: "command" | "timer" }) {
  const now = useNowMs()
  const { commands, timers } = threadOps(thread)
  return (
    <div className="flex flex-col">
      {kind !== "timer"
        ? commands.map((watch) => (
            <ChildOpRow
              key={watch.id}
              kind="COMMAND"
              label={commandWatchLabel(watch)}
              state="running"
              density="panel"
              startedAt={watch.createdAt}
              counter={commandWatchStatus(watch)}
              title={commandWatchTitle(watch, now)}
              onOpen={watch.command?.monitor ? () => pushMonitorDrawer(thread.id, watch.target, { label: commandWatchLabel(watch) }) : undefined}
            />
          ))
        : timers.map((watch) => (
            <ChildOpRow
              key={watch.id}
              kind="TIMER"
              label={watch.timer?.prompt?.split("\n")[0] || watch.target}
              state="running"
              density="panel"
              counter={timerWatchStatus(watch, now)}
              title={timerWatchTitle(watch)}
            />
          ))}
    </div>
  )
}
