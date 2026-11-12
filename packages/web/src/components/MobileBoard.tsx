import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { ArrowLeft, Check, Clock, Plus, Settings as SettingsIcon } from "lucide-react"
import { activeBandThread, boardAskThread, type ThreadView } from "@frizz/shared"
import { openThread, store } from "../store.ts"
import { useBoard, useBoardThreads, useChildThreads } from "../hooks.ts"
import { childThreadState } from "../lib/childThreads.ts"
import { prefs } from "../lib/prefs.ts"
import {
  displayTitle,
  lastActiveLabelAt,
  needsAction,
  restIsWorking,
  sectionThreads,
  sessionIndicatorKind,
} from "../groups.ts"
import { ageSpan, spanUntil } from "../lib/activityTime.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { useOptimisticallySteered } from "../lib/steering.ts"
import { clearArchived, markArchived, useOptimisticallyArchived } from "../lib/optimisticArchive.ts"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { snoozePresetInstant, snoozePresetLabel } from "../lib/snooze.ts"
import { agentSuffix, liveAgentCount, rowSecondLine, wakeAt } from "../lib/mobileBoardRow.ts"
import { projectIdentity, sessionIndicatorFor } from "./Sidebar.tsx"
import { StatusListView } from "./StatusListView.tsx"
import { ThreadActionsSheet } from "./lazySurfaces.tsx"
import { showsUpdateBadge } from "./RestartFrizzButton.tsx"
import { trackBottomFloat } from "../lib/queueDockInset.ts"
import { useSupervisorStatus } from "../api/supervisorStatus.ts"
import { settleCompletion } from "../lib/completionPins.ts"
import { captureReaderPin, restoreReaderPin, type ReaderPin } from "../lib/readerPin.ts"
import { Z_CHROME } from "../lib/layers.ts"

// THE PHONE'S BOARD — a header, three text tabs, ONE list, and a "New thread" button.
//
// It is not a narrower desktop board. The desktop's three standing surfaces (project rail, thread rail,
// workpane) and its stack of right-hand drawers assume a viewport that can hold more than one thing at
// once; 390pt cannot, so the phone gets a two-level drill-down instead: a list of threads, and a thread.
//
// WHAT IS THE SAME, deliberately: the data. Every reading on a row comes from the same helpers the rail
// uses — `sectionThreads` for the bands, `sessionIndicatorKind` for the mark, `lastActiveLabelAt` for
// the rest time. A phone that derived its own answers would drift from the desktop the first time one of
// those rules changed. The row's second line is the phone's own reading (lib/mobileBoardRow.ts), built
// from the same ThreadView fields.
//
// WHAT IS DIFFERENT, and each of these is the maintainer's call from the mockup review (2026-08-17):
//
//   · RESTED AND ACTIVE ARE ONE BAND, called QUEUE. "Something is active until it's marked done." On a
//     screen showing eight rows, splitting them costs a tab switch to see work you already own — and
//     `sectionThreads` already returns the two together, so the merge is the absence of a split rather
//     than a new rule.
//   · NOTHING IN THE CHROME ANIMATES. The header and tabs are permanent, and permanent motion in the
//     corner of the eye is noise.
//   · NO COMPOSER ON THIS SCREEN. Starting a thread is the "New thread" button; the reply box belongs to
//     a thread.
//
// AND FROM THE SECOND-DRAFT REVIEW (2026-09-30, scratch/mobile-simplify/v2.html § 1):
//
//   · THE BANDS ARE UNDERLINE TABS UNDER THE HEADER, not an iOS tab bar at the bottom: the bottom edge
//     belongs to the thumb's primary verb. Still three bands, still tabs — the 2026-08-17 call stands.
//   · THE ⋯ SHEET IS GONE. Its readings (connection, quota) open Settings now, behind a gear.
//     Settings also holds "Update Frizz" (2026-10-08, maintainer on #52, which proposed a ⋯ sheet
//     again to carry it); the gear wears a dot when a new release line is out, by the desktop's rule.
//   · ONE SECOND LINE PER ROW says what the thread wants; no provider marks, and no ⤷ sub-agent lines
//     (a live count, "· 2 agents", replaces them).
//   · THE SNOOZED TAB'S RIGHT COLUMN SAYS WHEN THE THREAD WAKES, not how long ago it rested.
//
// CHANGED 2026-10-08 (maintainer, on #51): mobile thread marks reuse the desktop renderer, including its
// travelling checkbox frames, inner symbols and muted "?". This replaces the 2026-08-17 review's static
// play mark and accent ask; sharing the renderer keeps both surfaces' state and motion consistent. The
// rows still move; the chrome above still does not.

type Tab = "queue" | "snoozed" | "done"

/** Desktop's exact mark, with a spoken state instead of a hover-only tooltip on touch screens. */
export function MobileThreadMark({ t }: { t: ThreadView }) {
  const { node, tip } = sessionIndicatorFor(t)
  // The popover's first paragraph describes the state (and park); its worker prose is not an icon label.
  const label = tip?.split("\n\n")[0] ?? "At rest"
  return <span className="inline-flex" data-mobile-thread-indicator={sessionIndicatorKind(t)} role="img" aria-label={label}>{node}</span>
}


// SWIPE A ROW TO TRIAGE IT — snooze or finish without opening the thread.
//
// The two verbs are the two the queue actually needs away from a desk, and they are the SAME RPCs the
// desktop header's snooze menu and check call (`setThreadSnooze`, `completeThread`), so a swipe and a
// click cannot mean different things. The swipe snoozes for the preset chosen in Settings.
//
// THE GESTURE, and the two details that decide whether it feels native rather than web:
//
//   · IT MUST NOT STEAL THE VERTICAL SCROLL. A row that follows the finger on any movement makes the
//     list impossible to scroll, so the drag only claims the gesture once the movement is DOMINANTLY
//     horizontal (|dx| > |dy| and past a small slop) — before that the browser keeps it and scrolls.
//   · ONE ROW OPEN AT A TIME. Two half-open rows read as a rendering fault, so the open row's id lives
//     in the LIST rather than in each row, and opening one closes the other.
//
// `touch-action: pan-y` tells the browser up front that this element will never want horizontal panning
// from it, which is what stops Safari from starting a back-navigation swipe on the same drag.
const SWIPE_ACTION_W = 76
const SWIPE_OPEN = SWIPE_ACTION_W * 2
const SWIPE_SLOP = 10

export function SwipeRow({
  open,
  onOpenChange,
  onSnooze,
  onDone,
  snoozeLabel,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSnooze: () => void
  onDone: () => void
  snoozeLabel: string
  children: React.ReactNode
}) {
  const [dx, setDx] = useState(0)
  const start = useRef<{ x: number; y: number; claimed: boolean } | null>(null)
  const offset = open ? -SWIPE_OPEN : 0
  const shown = start.current?.claimed ? dx : offset

  return (
    <div className="relative overflow-hidden" style={{ touchAction: "pan-y" }}>
      {/* `inert` while the row is closed, not `aria-hidden`: the two actions are real buttons, and
          hidden from assistive tech they were still Tab stops, two per row, behind the row's own
          content (axe's aria-hidden-focus on 16 nodes of a seeded board, 2026-11-09). Inert takes them
          out of the tab order and the accessibility tree together, until a swipe opens the row. */}
      <div className="absolute inset-y-0 right-0 flex" inert={!open}>
        <button
          data-mobile-swipe-snooze
          onClick={() => { onOpenChange(false); onSnooze() }}
          className="flex flex-col items-center justify-center gap-1 bg-elevated text-muted active:bg-panel-2"
          style={{ width: SWIPE_ACTION_W }}
        >
          <Clock size={19} />
          <span className="text-[11.5px]">{snoozeLabel}</span>
        </button>
        <button
          data-mobile-swipe-done
          onClick={() => { onOpenChange(false); onDone() }}
          className="flex flex-col items-center justify-center gap-1 bg-live/85 text-bg active:brightness-95"
          style={{ width: SWIPE_ACTION_W }}
        >
          <Check size={19} strokeWidth={2.6} />
          <span className="text-[11.5px] font-medium">Done</span>
        </button>
      </div>
      <div
        className={`relative bg-bg ${start.current?.claimed ? "" : "transition-transform duration-200 ease-out motion-reduce:transition-none"}`}
        style={{ transform: `translateX(${shown}px)` }}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse" && e.button !== 0) return
          start.current = { x: e.clientX, y: e.clientY, claimed: false }
        }}
        onPointerMove={(e) => {
          const s = start.current
          if (!s) return
          const moveX = e.clientX - s.x
          const moveY = e.clientY - s.y
          if (!s.claimed) {
            // Undecided: let the browser scroll unless the movement is clearly sideways.
            if (Math.abs(moveX) < SWIPE_SLOP || Math.abs(moveX) <= Math.abs(moveY)) return
            s.claimed = true
            e.currentTarget.setPointerCapture(e.pointerId)
          }
          // Rubber-band past the open width so the row cannot be flung off the screen, and never open
          // rightwards — there is nothing under that edge.
          const next = Math.min(0, Math.max(-SWIPE_OPEN - 24, offset + moveX))
          setDx(next)
        }}
        onPointerUp={() => {
          const s = start.current
          start.current = null
          if (!s?.claimed) return
          const settled = dx < -SWIPE_OPEN / 2
          setDx(0)
          onOpenChange(settled)
        }}
        onPointerCancel={() => {
          start.current = null
          setDx(0)
        }}
        // A tap anywhere on an OPEN row closes it rather than opening the thread — the same rule Mail
        // follows, and without it the only way back is a second swipe.
        onClickCapture={(e) => {
          if (!open) return
          e.preventDefault()
          e.stopPropagation()
          onOpenChange(false)
        }}
      >
        {children}
      </div>
    </div>
  )
}

// LONG-PRESS A ROW FOR ITS ACTIONS — the thread's own ⋯ sheet, opened from the board, so every verb a
// swipe offers (and the ones it does not) has a tap-and-hold path too. No gesture is the only way to an
// action (the approved design's rule).
//
// The press is cancelled by anything that says the finger meant something else: a move past the slop (a
// scroll, or the swipe claiming the row), the finger lifting, the browser cancelling the pointer. When it
// DOES fire, the click the lift would otherwise deliver is swallowed, or the row would also open.
const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP = 8

function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    origin.current = null
  }
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return
      fired.current = false
      origin.current = { x: e.clientX, y: e.clientY }
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        fired.current = true
        // A short tick where the platform offers one (Android); iOS Safari has no vibration API.
        navigator.vibrate?.(10)
        onLongPress()
      }, LONG_PRESS_MS)
    },
    onPointerMove: (e: React.PointerEvent) => {
      const o = origin.current
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > LONG_PRESS_SLOP) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture: (e: React.MouseEvent) => {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    },
    // The platform's own hold gesture (iOS's callout, Android's context menu) would race the sheet.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  }
}

/**
 * One thread, full width: the mark, the title with its right-hand reading, and one line under it.
 *
 * No card: a card spends side margins and then its own padding on every row, which on a 390pt screen is
 * 64pt of a 358pt measure. The hairline is INSET to the text column (16 + 18 + 12 = 46) so the glyph
 * column reads as a gutter rather than as the first cell of a table.
 *
 * THE RIGHT-HAND READING depends on the tab. In Queue and Done it is the rest age; in Snoozed it is when
 * the thread wakes (`wakes 3h`), because for a parked thread that is the fact that matters — and a park
 * with no clock behind it (a PR watch, the resting card's event-snooze) shows nothing rather than a
 * time nobody promised.
 */
function MobileThreadRow({
  t,
  tab,
  last,
  openSwipe,
  onOpenSwipe,
  onLongPress,
}: {
  t: ThreadView
  tab: Tab
  last?: boolean
  openSwipe: boolean
  onOpenSwipe: (open: boolean) => void
  onLongPress: () => void
}) {
  const press = useLongPress(onLongPress)
  const snoozePreset = useSnapshot(prefs).snoozePreset
  const now = useNowMs()
  const kind = sessionIndicatorKind(t)
  const at = lastActiveLabelAt(t)
  // A rest time dates a HANDOFF, so a row that is still going has nothing to date — the rail's own rule.
  // "Still going" is the MARK's answer, not `isActivelyRunning`'s. The two part company on one shape: a
  // thread parked on a PR whose CI has already settled counts as live work to the server flag behind
  // `isActivelyRunning` (it earns the resting card), while nothing about it is actually moving — so it
  // reads […] here, and a row that reads at-rest has to carry the rest time that goes with it.
  // A shell or PR rest is in motion only when its worker called it `working` (groups.restIsWorking,
  // 2026-10-05): the same rest in the queue or the Snoozed tab is a handoff, and carries its rest time.
  const waitMoving = (kind === "background" || kind === "pr") && restIsWorking(t)
  const inMotion = t.runtime === "running" || t.runtime === "spawning" || kind === "working" || waitMoving
  const wakes = tab === "snoozed" ? spanUntil(wakeAt(t, now), now) : null
  const right = tab === "snoozed" ? (wakes ? `wakes ${wakes}` : null) : inMotion ? null : ageSpan(at, now)
  const projectDir = useSnapshot(store).board?.projectDir
  const line = rowSecondLine(t, kind, inMotion, now, projectDir)
  const childThreads = useChildThreads(t.id)
  const agents = agentSuffix(liveAgentCount(t), childThreads.filter((c) => childThreadState(c) === "running").length)
  return (
    <div className={kind === "snoozed" ? "mobile-row-dim" : undefined}>
      <SwipeRow
        open={openSwipe}
        onOpenChange={onOpenSwipe}
        snoozeLabel={snoozePresetLabel(snoozePreset)}
        onSnooze={async () => {
          try {
            await rpc.setThreadSnooze({ slug: t.id, sessionId: t.sessionId ?? "", until: snoozePresetInstant(snoozePreset), prompt: null })
            showToast(`Snoozed · ${snoozePresetLabel(snoozePreset)}`)
          } catch (error) {
            showToast(error instanceof Error ? error.message.slice(0, 100) : "Snooze failed")
          }
        }}
        onDone={async () => {
          // `completeThread`, NOT `markComplete`. The latter is the LEGACY `.frizz` doc path — it shells
          // out to a thread-file update and 500s on a session thread that has no `.md` behind it, which
          // is exactly what this swipe did on its first outing (verified: the wire call went out, came
          // back 500, and the row stayed in the queue while the desktop's own button on the same thread
          // succeeded). The desktop's check uses the session-first mutation; so does this now.
          markArchived(t.id) // the same optimism the desktop's check runs on, so the row leaves the Queue at once
          try {
            const result = await rpc.completeThread({ slug: t.id, sessionId: t.sessionId ?? "", terminateLive: false })
            if (result.needsConfirmation) {
              // A turn is still executing, so finishing it is a decision with a dialog behind it. A
              // swipe is not the place to answer that question — hand it back rather than guessing.
              clearArchived(t.id)
              showToast(result.hold?.cutOff
                ? "Cut off mid-turn — open the thread to retry it, or to mark it done anyway"
                : "Still running — open the thread to finish it")
              return
            }
            settleCompletion("Marked as done", t) // keeps or lifts a pin as this browser chose (lib/completionPins.ts)
          } catch (error) {
            clearArchived(t.id)
            showToast(error instanceof Error ? error.message.slice(0, 100) : "Could not mark as done")
          }
        }}
      >
      <button
        data-mobile-thread-row={t.id}
        {...press}
        onClick={() => openThread(t.id)}
        // No callout, no text selection: a hold on a row is the actions gesture, not a copy.
        style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}
        className="flex w-full items-start gap-3 px-4 py-[11px] text-left active:bg-hover"
      >
        <span className="flex h-[21px] w-[18px] shrink-0 items-center justify-center">
          <MobileThreadMark t={t} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="flex min-w-0 items-baseline gap-2.5">
            <span className="min-w-0 flex-1 truncate text-[15.5px] font-medium leading-[21px] tracking-[-0.005em] text-fg">
              {displayTitle(t)}
            </span>
            {right ? (
              <span data-mobile-row-right className="shrink-0 text-[12px] leading-[21px] tabular-nums text-faint">{right}</span>
            ) : null}
          </span>
          {line || agents ? (
            // The agent count sits OUTSIDE the truncating span, so a long activity line ellipsizes before
            // it and never swallows it.
            <span data-mobile-row-line className="flex min-w-0 text-[13.5px] leading-[19px] text-muted">
              {line ? (
                <span className="min-w-0 truncate">
                  {line.lead ? <span className="font-semibold text-fg">{line.lead} </span> : null}
                  {line.text}
                </span>
              ) : null}
              {agents ? <span className="shrink-0 whitespace-pre">{line ? ` · ${agents}` : agents}</span> : null}
            </span>
          ) : null}
        </span>
      </button>
      </SwipeRow>
      {last ? null : <div className="ml-[46px] h-px bg-border/70" />}
    </div>
  )
}

function EmptyBand({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-10 pb-24 text-center">
      <p className="m-0 text-[15px] text-muted">{label}</p>
    </div>
  )
}

/**
 * One band's tab: a text label with an underline, and its count after it on the same baseline.
 *
 * The label reserves its SEMIBOLD width whichever state it is in (an invisible bold copy shares its grid
 * cell), so selecting a tab never nudges the tabs after it sideways. 44px tall: the whole strip under the
 * header is the hit area, not the 20px of text in it.
 */
function BandTab({
  band,
  label,
  active,
  onClick,
  children,
}: {
  band: Tab
  label: string
  active: boolean
  onClick: () => void
  children?: React.ReactNode
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      data-mobile-tab={band}
      onClick={onClick}
      className={`-mb-px flex h-[44px] items-center border-b-2 ${active ? "border-fg text-fg" : "border-transparent text-muted"}`}
    >
      <span className="flex items-baseline gap-1.5">
        <span className="grid text-[14.5px] leading-[20px]">
          <span aria-hidden className="invisible col-start-1 row-start-1 font-semibold">{label}</span>
          <span className={`col-start-1 row-start-1 ${active ? "font-semibold" : ""}`}>{label}</span>
        </span>
        {children}
      </span>
    </button>
  )
}

// The gear's update dot. Placed from the gear's PAINTED ink, not its box (dsf-8 pixel scan, dark,
// 2026-10-08): lucide's six-tooth Settings at 21px paints 17.4 × 19.1px, and its upper-right teeth sit
// at 0° and 60°, so the 45° notch between them is empty. A 5px dot at right/top 9.5/10.5px sits in that
// notch with 1.73px of clearance to the nearest tooth, about one pen width (1.9 × 21/24 = 1.66px), so it
// reads as attached to the gear without touching it. 6px out-weighed the gear's stroke; 4px read as a
// speck at this glyph size; a bg-coloured ring to cut it out of the teeth notched a tooth instead.
// Re-measure if the gear's size or stroke moves.
const GEAR_DOT = "pointer-events-none absolute right-[9.5px] top-[10.5px] size-[5px] rounded-full bg-accent"

const TAB_COUNT = "text-[12.5px] font-medium tabular-nums text-muted"

/**
 * The Queue tab's numbers: how many threads are asking (lit), then how many the tab lists (muted),
 * as "2 · 5". When every listed thread is asking, the second number repeats the first, and "1 · 1"
 * read as a glitch with nothing to say what either was: one number is shown. Each is named for a
 * screen reader, which was read "Queue 1 · 1".
 */
export function queueTabCounts(asks: number, listed: number): { asks?: number; listed?: number } {
  return {
    ...(asks > 0 ? { asks } : {}),
    ...(listed > 0 && listed !== asks ? { listed } : {}),
  }
}

// The drawer stack and the modals stay the App's, and the restart overlay the PageFrame's that App
// stands in: they are identical on both shells and mounting them twice would stack two of everything.
export function MobileBoard() {
  const board = useBoard()
  const snap = useSnapshot(store)
  // The desktop badge rule exactly (`isBadgeRelease`): a new release line lights the gear, a patch
  // does not — frizz-server ships those most days, and a dot that is always on says nothing. A frizz-dev
  // build names no version and never lights it. The update itself, patch or not, is in Settings.
  const updateBadge = showsUpdateBadge(useSupervisorStatus().data ?? null)
  const [tab, setTab] = useState<Tab>("queue")
  // ONE row open at a time — two half-open rows read as a rendering fault.
  const [openSwipe, setOpenSwipe] = useState<string | null>(null)
  // The thread whose actions sheet a long-press opened, if any.
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  // The "New thread" button's corner is the toaster's too: publish it, so a toast rides above the button
  // instead of over it (lib/queueDockInset.ts).
  const newThreadRef = useRef<HTMLButtonElement>(null)
  useEffect(() => (newThreadRef.current ? trackBottomFloat("phone-new-thread", newThreadRef.current) : undefined), [])
  // Both optimistic overlays, exactly as the rail composes them: a just-sent steer pulls a row into the
  // running reading and a just-clicked Mark-as-done drops it into Done, each folded in BEFORE any band
  // is derived — so a row's appearance and its band always land together.
  // Untracked, like the desktop rail's (hooks.ts useBoardThreads): the bands below walk every thread.
  const all = useOptimisticallyArchived(useOptimisticallySteered(useBoardThreads()))
  const queueOrder = useSnapshot(prefs).queueOrder
  const sections = useMemo(() => sectionThreads(all, queueOrder), [all, queueOrder])

  // THE QUEUE IS `sections.active` UNSPLIT — the desktop calls `partitionActive` on it to draw its
  // Rested/Active rule; the phone does not, which is the whole of the merge.
  //
  // Ordered asks first. The rail orders the cue by rest time, which is right for a column you scan
  // beside a workpane; on the one screen a phone has, "what needs me" earns the top. Both groups keep
  // their queue order within themselves, so nothing else about the ordering changes.
  const queue = useMemo(() => {
    const asks = sections.active.filter(needsAction)
    const rest = sections.active.filter((t) => !needsAction(t))
    // PINNED leads even the asks: the phone has no pinned band, so the human's shelf folds into the
    // top of the one list rather than vanishing (a pinned thread is diverted OUT of `active` — and out
    // of `snoozed`/`inactive` — by sectionThreads, so without this it would render nowhere).
    return [...sections.pinned, ...asks, ...rest]
  }, [sections.pinned, sections.active])
  // Counted with `boardAskThread` — the queue rows `needsAction` calls asks — which is also what the server
  // counts for the projects list's accent number, so the list and this header cannot disagree.
  const askCount = useMemo(() => all.filter(boardAskThread).length, [all])
  // "Working" is the maintainer's ACTIVE band — the rows that are spinning — counted with the predicate
  // the desktop rail's tooltip uses (activeBandThread), so the phone and the rail cannot disagree.
  const working = useMemo(() => all.filter(activeBandThread).length, [all])
  const tabCounts = queueTabCounts(askCount, queue.length)

  const rows = tab === "queue" ? queue : tab === "snoozed" ? sections.snoozed : sections.inactive
  const statusView = snap.view.startsWith("status:") ? snap.view.slice(7) : null

  // A ROW ARRIVING, MOVING OR CHANGING HEIGHT ABOVE THE READER NEVER MOVES THEM (lib/readerPin). A thread
  // that rests moves up into the asks, and iOS Safari has no scroll anchoring at all, so the list holds
  // the row the reader is on itself: read here, off the rows this render replaces, measured from under
  // the fixed header, and put back by the layout effect below. On every change of the rows rather than
  // only of their order, because without anchoring a row above that grows a line pushes just the same.
  // A different band is a different list: switching tabs holds nothing.
  const committedRowsRef = useRef<{ rows: readonly ThreadView[]; tab: Tab } | null>(null)
  const rowPinRef = useRef<ReaderPin | null>(null)
  const committedRows = committedRowsRef.current
  if (committedRows && committedRows.tab === tab && committedRows.rows !== rows && !statusView) rowPinRef.current = captureReaderPin()
  useLayoutEffect(() => {
    const pin = rowPinRef.current
    rowPinRef.current = null
    committedRowsRef.current = { rows, tab }
    if (pin) restoreReaderPin(pin)
  }, [rows, tab])
  const identity = projectIdentity(board)
  const title = identity.state === "verified" ? identity.label : identity.state === "local" ? identity.name : "Frizz"

  return (
    <div data-mobile-board className="relative min-h-dvh bg-bg">
      {/* The header and the band tabs, fixed together. `env(safe-area-inset-top)`: on a notched phone the
          status bar sits over the top of the viewport, and no headless shot has that inset — so this is a
          defect no screenshot here can show and every real device would. */}
      <div data-mobile-board-header className={`fixed inset-x-0 top-0 ${Z_CHROME} bg-bg pt-[env(safe-area-inset-top)]`}>
        <div className="flex h-[56px] items-center gap-0.5 pr-0.5">
          {/* A real navigation to the grid, not a router link: `/` is a different project binding (its
              own socket, board store and API base), which is exactly why the desktop grid is reached by
              a document load too. */}
          <a
            href="/"
            aria-label="Projects"
            data-mobile-projects
            className="flex size-[44px] shrink-0 items-center justify-center rounded-full text-fg/85 active:bg-hover-strong"
          >
            <ArrowLeft size={21} strokeWidth={2.1} />
          </a>
          <div className="min-w-0 flex-1 pl-0.5">
            <div data-mobile-board-title className="truncate text-[16.5px] font-semibold leading-[21px] tracking-[-0.01em] text-fg">
              {title}
            </div>
            {board ? (
              <div data-mobile-board-subtitle className="truncate text-[13px] leading-[17px] text-muted">
                {askCount > 0 ? <span className="font-semibold text-accent">{askCount} need you</span> : null}
                {askCount > 0 && working > 0 ? " · " : null}
                {working > 0 ? `${working} working` : null}
                {askCount === 0 && working === 0 ? "Nothing needs you" : null}
              </div>
            ) : null}
          </div>
          <button
            aria-label={updateBadge ? "Settings, update available" : "Settings"}
            data-mobile-settings
            onClick={() => (store.showSettings = true)}
            className="relative flex size-[44px] shrink-0 items-center justify-center rounded-full text-fg/85 active:bg-hover-strong"
          >
            <SettingsIcon size={21} strokeWidth={1.9} />
            {updateBadge ? (
              <span data-mobile-update-notification aria-hidden className={GEAR_DOT} />
            ) : null}
          </button>
        </div>
        <div role="tablist" aria-label="Bands" className="flex gap-[22px] border-b border-border/70 px-[18px]">
          <BandTab band="queue" label="Queue" active={tab === "queue"} onClick={() => setTab("queue")}>
            {tabCounts.asks !== undefined ? (
              <span aria-label={`${tabCounts.asks} need you`} className="text-[12.5px] font-bold tabular-nums text-accent">{tabCounts.asks}</span>
            ) : null}
            {tabCounts.listed !== undefined ? (
              <span aria-label={tabCounts.asks !== undefined ? `of ${tabCounts.listed}` : `${tabCounts.listed} threads`} className={TAB_COUNT}>
                {tabCounts.asks !== undefined ? `· ${tabCounts.listed}` : tabCounts.listed}
              </span>
            ) : null}
          </BandTab>
          <BandTab band="snoozed" label="Snoozed" active={tab === "snoozed"} onClick={() => setTab("snoozed")}>
            {sections.snoozed.length > 0 ? <span className={TAB_COUNT}>{sections.snoozed.length}</span> : null}
          </BandTab>
          <BandTab band="done" label="Done" active={tab === "done"} onClick={() => setTab("done")} />
        </div>
      </div>

      {/* The list: 56 + 45 of header and tabs above; below, the "New thread" button's 50 plus 16 either
          side, so the last row scrolls clear of it and its age column is never under the button. */}
      <div className="flex min-h-dvh flex-col pb-[calc(82px+env(safe-area-inset-bottom))] pt-[calc(101px+env(safe-area-inset-top))]">
        {statusView ? (
          // A `/status/<name>` URL is a real route on both shells; answering it with the queue would be
          // the wrong list with nothing saying so. Same component the workpane renders.
          <div className="flex min-h-0 flex-1 flex-col">
            <StatusListView status={statusView} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyBand
            label={
              !board
                ? "Loading…"
                : tab === "queue"
                  ? "Nothing in the queue. Tap New thread to start one."
                  : tab === "snoozed"
                    ? "Nothing snoozed."
                    : "Nothing finished yet."
            }
          />
        ) : (
          <div>
            {rows.map((t, i) => (
              <MobileThreadRow
                key={t.id}
                t={t}
                tab={tab}
                last={i === rows.length - 1}
                openSwipe={openSwipe === t.id}
                onOpenSwipe={(open) => setOpenSwipe(open ? t.id : null)}
                onLongPress={() => {
                  setOpenSwipe(null)
                  setActionsFor(t.id)
                }}
              />
            ))}
          </div>
        )}
      </div>

      <button
        ref={newThreadRef}
        data-mobile-new-thread
        onClick={() => (store.showNewThread = true)}
        // NOT the accent: a permanent yellow pill would out-shout every ask in the list under it, and
        // the accent means exactly one thing in this product. This is the app's own primary-button fill.
        // Labelled, not a bare +: the verb is the one thing on this screen that is not a thread.
        className={`button-outline fixed bottom-[calc(16px+env(safe-area-inset-bottom))] right-4 ${Z_CHROME} flex h-[50px] items-center gap-1.5 rounded-full bg-fg pl-4 pr-5 text-[15px] font-semibold text-bg shadow-lg shadow-shadow-ink/50 active:opacity-85`}
      >
        <Plus size={20} strokeWidth={2.4} />
        New thread
      </button>
      {actionsFor ? <ThreadActionsSheet slug={actionsFor} onClose={() => setActionsFor(null)} /> : null}
    </div>
  )
}
