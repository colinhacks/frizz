import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useSnapshot } from "valtio"
import { AlarmClock, Check, ChevronRight, CircleDashed, Ellipsis, Github, Hourglass, Loader2, Pin, PinOff, RotateCcw, Timer } from "lucide-react"
import { hasLiveSubAgents, type BoardSnapshot, type ThreadView } from "@frizz/shared"
import { store, openThread, scrollToQueueCard, queueCardTargetY, pushSubAgentDrawer, showToast, queueCardViewportTop } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useBoardThreads } from "../hooks.ts"
import { prefs } from "../lib/prefs.ts"
import type { PinShelf } from "../groups.ts"
import { sectionThreads, externalThreads, orderByInteraction, partitionActive, needsAction, displayTitle, titleIsProvisional, SPINNING_UP_TITLE, pinnedOn, isSnoozed, parkedAwaitingHint, sessionIndicatorKind, offersRetry, futureSnoozedUntil, lastActiveLabelAt, waitNamesPr, prChecksRunning, restingOnSubAgents, restIsWorking, workingWithOpenQuestion, isActivelyRunning } from "../groups.ts"
import { ageSpan, relativeAge, limitResumeClock } from "../lib/activityTime.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { BoxSpinner, STATUS_BOX } from "./BoxSpinner.tsx"
import { ChildOpRow } from "./ChildOpRow.tsx"
import { ExpandThreadLink } from "./ExpandThreadLink.tsx"
import { visibleChildOps } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { MarkAsButton } from "./MarkAsButton.tsx"
import { DispatchForm } from "./NewThreadModal.tsx"
import { StatusRow } from "./StatusRow.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { ProviderMark } from "./ProviderMark.tsx"
import { STATUS_CHIP } from "../lib/status.ts"
import { retrySession } from "../lib/retrySession.ts"
import { formatSnoozedUntil, formatAutoSnoozedUntil, formatUserSnooze } from "../lib/snooze.ts"
import { formatCompactElapsed } from "../lib/durationLabels.ts"
import { awaitingProse, awaitingWaitClause } from "../lib/awaitingPresentation.ts"
import { useOptimisticallySteered } from "../lib/steering.ts"
import { useOptimisticallyArchived } from "../lib/optimisticArchive.ts"
import { unlandedDispatches, usePendingDispatches, type PendingDispatchEntry } from "../lib/pendingDispatch.ts"
import { STACKED_RAIL_ANCHOR_CLASS, stackedRailAnchor } from "../lib/stackedRailAnchor.ts"
import { useProjectScope } from "../lib/projectScope.tsx"
import { clampToSlots, edgeScrollVelocity, heldStep, moveItem, nearestSlot, shiftFor, type RowSlot } from "../lib/railReorder.ts"
import { activeSidebarSection, markerRow, queueCardGeometry, queueNavigationSettled, railRevealDelta, scrolledToDocumentBottom } from "../lib/sidebarScrollspy.ts"
import { SIDEBAR_WIDTH_CLASS } from "../lib/boardColumns.ts"
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode, RefObject } from "react"

// THE LEFT SIDEBAR — the thread list as a FLOATING column (no border, no fill: it floats in the
// page's whitespace the way the old ToC nav did). App centers the sidebar + workpane as a PAIR with
// a scaling gutter between them; this column is VERTICALLY CENTERED in the viewport and holds still
// while the workpane scrolls. Width SCALES with the viewport — clamp(272px, 34vw, 680px) — so titles
// get real room on large screens (titles WRAP, never truncate; captions stay one line; NEVER a
// horizontal scrollbar — overflow-x is clipped and unbreakable tokens break).
//
// ENTIRELY MOUSE-DRIVEN: no arrow-walk, no selection chevron. A session row CLICK opens the thread's
// drawer (chat / doc via store.openThread); a legacy row opens its frizz doc.
//
// Sections: FOUR bands top→bottom, in the names ARCHITECTURE.md § Board nomenclature fixes — RESTED
// (everything at rest = the queue's own rows, a.k.a. the cue), ACTIVE (the rows currently spinning),
// then a labeled DIMMED HELD band (every declared clock/hourglass/timed wait), then DONE — each split
// by a bare <hr>, and Snoozed and Done both collapsible. Rested and Active are ONE uncollapsible <section>
// (you can't hide your queue or your live work); the <hr> between them is the whole distinction, so
// never describe a rested row as active. A thread merely awaiting its OWN sub-agents is INTERNAL work
// and stays spinning in Active undimmed; only external waiters drop into the dimmed band (groups.ts
// isSnoozed).
// Needs-you renders as the row INDICATOR + the queue; awaiting as the hint gloss.
// Done = explicitly completed. Legacy .frizz rows do not render at all.
//
// Below those four, and outside the vocabulary entirely, sits EXTERNAL — the project's own
// `claude`/`codex` terminals. They are not a fifth band of frizz's model, they are a separate listing
// of work frizz can read but does not drive, so nothing about the four names above applies to them.


/**
 * The column's track, in ONE place: App reserves an empty aside with these exact classes while the
 * board is still loading for a project this browser has seen populated (lib/sidebarPresence.ts), so
 * the workpane sits where it will end up instead of jumping when the real sidebar mounts.
 */
// A row's hover-revealed icon action: sized to the title's FIRST line (h-[19px]; the group's top-1
// matches the row's pt-1) so it never exceeds the row height. Bare glyphs — the group draws no box
// around them (its backing is the rail's own base colour under the row's hover wash; see the strip in
// ThreadRow), and only the one under the pointer paints its own square.
// OPAQUE PAINT, TRANSLUCENT BOX — `text-muted opacity-70`, never `text-muted-70`. The unpin is a lucide
// glyph FILLED and STROKED in currentColor, and an SVG paints the stroke over the fill: with an alpha
// colour the ring lands at ~0.8 alpha where it overlaps the 0.7 fill, so the pin read as a darker
// outline around a lighter middle (maintainer 2026-09-11: "slightly dimmer in the middle. It looks
// insane"). Group opacity composites the finished glyph once, so fill and stroke read as one solid
// body. Identical for the stroke-only door and Retry; `disabled:opacity-50` still wins, as a variant
// utility over a bare one.
const ROW_ACTION_CLASS = "flex h-[19px] w-[19px] items-center justify-center rounded text-muted opacity-70 outline-none transition-[color,opacity] hover:bg-panel-2 hover:text-fg hover:opacity-100"

// ANCHORED TO THE TOP, 52px down: the line the queue's first card opens on (main's py-5 + the queue
// column's py-8 — TodosView), so the status row and the top card start level. It was centred
// (`justify-center`) until 2026-10-13, and a centred column moves every row and the prompt box by half of
// any change in its height: a send that put a thread in a fresh Running band moved the whole sidebar up
// 24px, and its return moved it back (maintainer: "Anchor both to the top").
export const SIDEBAR_COLUMN_CLASS =
  `sticky top-0 self-start h-screen ${SIDEBAR_WIDTH_CLASS} flex flex-col pt-[52px] max-[800px]:static max-[800px]:h-auto max-[800px]:pt-16`

/**
 * Which row's card is under the reading line, and the rail scrolled to keep that row in view — the
 * sidebar's scroll marker. Shared with the Console's sidebar (ConsoleSidebar.tsx), whose rows sit
 * opposite cards the same way. `view` and `drawerCount` re-arm the observers when the workpane changes.
 * `queueIds` is the queue band's rows in order: `activeId` is the row the marker is DRAWN on, which is
 * the reading rule's card until that card's row leaves the band while the card is still fading, and
 * from then the row that takes its place (markerRow).
 */
export function useQueueScrollspy(view: string, drawerCount: number, queueIds: readonly string[]): {
  railRef: RefObject<HTMLDivElement | null>
  activeId: string | null
  navigateToQueueCard: (id: string) => void
} {
  const railRef = useRef<HTMLDivElement>(null)
  const [readingId, setActiveId] = useState<string | null>(null)
  // The queue's order the last time the marked row was in it. Advanced during render, like the queue's
  // own departure refs (TodosView): the hand-over has to land in the commit that moves the row.
  const whileQueued = useRef<readonly string[]>([])
  if (readingId && queueIds.includes(readingId)) whileQueued.current = queueIds
  const activeId = markerRow(readingId, queueIds, whileQueued.current)
  // A click-to-card navigation in flight: the row that was clicked, plus where its scroll landed. Both
  // halves matter — see the release conditions in syncActiveSection.
  const pendingNavigation = useRef<{ id: string; landedY: number } | null>(null)

  const syncActiveSection = useCallback(() => {
    // Fading cards included: a card still holds the reader's place until it unmounts (queueCardGeometry).
    const items = queueCardGeometry({ includeLeaving: true })
    const pending = pendingNavigation.current
    if (pending) {
      const target = items.find((item) => item.id === pending.id)
      if (queueNavigationSettled(target, window.scrollY, pending.landedY, queueCardViewportTop())) pendingNavigation.current = null
      else {
        setActiveId(pending.id)
        return
      }
    }
    const nextActiveId = activeSidebarSection(items, window.innerHeight, scrolledToDocumentBottom())
    // Scroll/resize observations can fire several times per frame. Preserve the same primitive
    // state value to avoid a needless row-tree update when the selected card has not changed.
    setActiveId((current) => current === nextActiveId ? current : nextActiveId)
  }, [])

  useEffect(() => {
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(syncActiveSection)
    }
    schedule()
    // Capture scroll so this also follows an app-level scrolling element if the page's scroll root
    // changes. The rail's own scroll is harmless here (card geometry has not changed), while a
    // programmatic/smooth queue-card scroll is always observed.
    document.addEventListener("scroll", schedule, { capture: true, passive: true })
    window.addEventListener("resize", schedule)
    const workpane = document.getElementById("workpane")
    const observer = workpane ? new ResizeObserver(schedule) : null
    // Transcript expansion, card exits, and keyframe reorders can change which card crosses the
    // reading line without a window scroll. Observe those DOM changes as well as the workpane box.
    const mutations = workpane ? new MutationObserver(schedule) : null
    if (workpane) observer?.observe(workpane)
    if (workpane) mutations?.observe(workpane, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-queue-card", "data-queue-leaving", "style", "class"] })
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      observer?.disconnect()
      mutations?.disconnect()
    }
  }, [syncActiveSection, view, drawerCount])

  // Reveal a newly active row inside the rail itself. Direct scrollTop adjustment is intentionally
  // local: Element.scrollIntoView could scroll the main document and steal the reader's position.
  useLayoutEffect(() => {
    const rail = railRef.current
    if (!rail || !activeId || window.matchMedia?.("(max-width: 800px)").matches) return
    const item = rail.querySelector<HTMLElement>(`[data-sidebar-item="${CSS.escape(activeId)}"]`)
    if (!item) return
    const railBox = rail.getBoundingClientRect()
    const itemBox = item.getBoundingClientRect()
    const delta = railRevealDelta(railBox.top, railBox.bottom, itemBox.top, itemBox.bottom)
    if (Math.abs(delta) > 0.5) rail.scrollTop += delta
  }, [activeId])

  // Called AFTER scrollToQueueCard, which has either scrolled or (with a drawer dismissing over the
  // still-locked page) parked the landing for the unlock ~210ms out. So the landing is read off the
  // CARD, not off window.scrollY: the two agree once the page has settled, and only the card knows the
  // answer while the lock is still holding scrollY at 0.
  const navigateToQueueCard = useCallback((id: string) => {
    pendingNavigation.current = { id, landedY: queueCardTargetY(id) ?? window.scrollY }
    setActiveId(id)
  }, [])

  return { railRef, activeId, navigateToQueueCard }
}

export function Sidebar() {
  const snap = useSnapshot(store)
  // A just-sent steer is folded into the board BEFORE anything is derived from it, so the row's
  // spinner and its POSITION land together. Consulting the hint further down (in the indicator alone,
  // as this once did) left the two disagreeing for the whole injection + tailer round-trip: the row
  // spun while still sitting in the queue-ordered rested band, below the rule, and hopped up to the
  // running band seconds later — measured at 2.0s here with an instantaneous fixture worker, longer in
  // production. See lib/steering.ts.
  // Both optimistic overlays, composed: a just-sent steer pulls a row into Active, a just-clicked
  // Mark-as-done drops it into Done — each folded in BEFORE any band is derived, so the row's
  // appearance and its POSITION always land together instead of one waiting on a round-trip the other
  // already skipped (lib/steering.ts, lib/optimisticArchive.ts).
  // The threads are read UNTRACKED and everything derived from them is memoized on their identity
  // (hooks.ts useBoardThreads): the rail sections and sorts every thread, and most of a long-lived
  // board is the Done band. Walking it through useBoard()'s tracking view on every render was most of
  // what a send's click handler spent on a board of 1,000 Done threads.
  const all = useOptimisticallyArchived(useOptimisticallySteered(useBoardThreads()))
  const queueOrder = useSnapshot(prefs).queueOrder
  const sections = useMemo(() => sectionThreads(all, queueOrder), [all, queueOrder])
  // Its own partition, deliberately NOT a SectionKey: sectionThreads drops external rows entirely, and
  // that stays true — an external session must never be able to land in Active, Snoozed or Done by
  // accident. This band is the only place they render, and they leave it by being STEERED, not by
  // being re-sorted.
  // Ordered by the SAME key the rest of the rail uses, so the rest-time column reads monotonically down
  // the band. It cannot be left to discovery order: the tailer returns these ids by file MTIME, while
  // the label prints the agent's own last output — two clocks that disagree whenever a transcript is
  // touched without the agent speaking (a resume that writes a header, a copy, a restore).
  const externalSessions = useMemo(() => orderByInteraction(externalThreads(all)), [all])
  const collapsed = snap.sidebarCollapsed
  const activeThreads = sections.active
  const heldThreads = sections.snoozed
  const inactiveThreads = sections.inactive
  // The two bands of the Active section: RESTED is the cue (one row per queue card), RUNNING the rows
  // with no card. Split here rather than at the render so the scroll marker can be told the cue's order.
  const { running, rested } = useMemo(() => partitionActive(activeThreads), [activeThreads])
  const { railRef, activeId, navigateToQueueCard } = useQueueScrollspy(snap.view, snap.drawers.length, rested.map((t) => t.id))
  // A dispatch from the prompt box above, drawn as the Running row it is about to become — see StartingRow.
  // The board's ids are only gathered while one is pending.
  const pending = usePendingDispatches(useProjectScope())
  const starting = useMemo(() => (pending.length === 0 ? pending : unlandedDispatches(pending, new Set(all.map((t) => t.id)))), [pending, all])
  const runningCount = running.length + starting.length
  const openCount = activeThreads.length + starting.length

  return (
    // HEIGHT MODEL: a sticky, exactly viewport-height wrapper that holds the inner column at its top
    // inset, where it grows fit-content to a near-flush cap and scrolls internally only past it. overflow-x is CLIPPED
    // (titles wrap; min-w-0 at every level). No bg/clip on the column itself.
    // NO z-index. The rail and the workpane are side-by-side flex columns that never overlap, so the
    // old desktop `z-[100]` bought nothing — but it outranked every ordinary overlay (the ⌘K palette
    // at z-[60], the new-thread modal and settings drawer at z-50, toasts at z-[70]), so each of them
    // painted BEHIND the prompt box and had to escalate past 100 to be seen. That escalation is the
    // recurring "hidden underneath the prompt box" bug. Default stacking is the fix: overlays win by
    // simply being overlays. Do not re-add a z here — raise the specific overlay instead.
    // The 272px FLOOR (was 320px) only binds in the TABLET BAND just above the 800px stack point, where
    // 34vw is smallest and the workpane is squeezed hardest — 320px claimed ~39% of an 820px viewport
    // for nav and left the queue with the remainder. 272px still holds the dispatch composer's profile
    // chip and its icon buttons on one line, and hands the difference back to the queue.
    <aside ref={stackedRailAnchor} className={`${SIDEBAR_COLUMN_CLASS} ${STACKED_RAIL_ANCHOR_CLASS}`}>
      {/* The content column FILLS the aside track (no narrow inner cap). Its cap reserves the 52px top
          inset and 16px below, and under it the column grows and then scrolls INTERNALLY. The reserve used to be 44px a side, holding open the band the FIXED
          status bar occupied in the page's top-left corner so a long thread list could not push the
          composer up underneath it. That bar is gone — its contents are the StatusRow at the top of
          this very column now — so the lane it needed goes with it and the rail gets the 56px back.
          Short boards are unaffected: they never reach the cap. */}
      <div className="flex max-h-[calc(100vh-68px)] min-h-0 min-w-0 w-full flex-col max-[800px]:max-h-none">
        {/* THE PROMPT BOX lives at the sidebar top (it replaced the New-thread pill — maintainer
            2026-07-09): always present, type + Enter dispatches a new thread. A brand-new repo shows
            this same box CENTERED as the whole screen (App hides the sidebar); the first dispatch
            shunts it here to the left. */}
        <div className="mb-5 shrink-0 px-0.5">
          {/* THE STATUS ROW rides the top of the prompt box: home, the settings/reload pair and both
              quota chips at the left edge, the project — its GitHub mark and owner/repo, one link to
              the repo — at the right. The quota chips did once float
              here on their own, then moved out to a fixed corner bar because quota is ACCOUNT-global
              rather than a property of this composer — which is still true, and is why they come back
              as part of a GLOBAL status row instead of as a composer decoration. */}
          {/* The GitHub picker's door now lives INSIDE the dispatch composer (a small icon left of the
              send button — see DispatchForm/Composer leftAction); no separate pill here. */}
          <StatusRow />
          {/* No "Starting thread…" card under this box: it stood between the box and the rail for the
              length of the dispatch call and then left, so every row moved down 73px and back up
              (2026-10-13, 472-581ms on a local stack; in the stacked layout the whole queue moved with
              it). The rail draws the pending thread as the Running row it becomes instead (StartingRow). */}
          <DispatchForm pendingCard={false} />
        </div>
        {/* The rows scroll BEHIND the prompt box: the list's scroll edge is the box's bottom edge, and the
            20px between them is the list's own top padding, not the block's margin. With the gap outside
            the scroller, a row scrolled up was cut off 20px short of the box in a strip of page colour
            (maintainer 2026-10-20: "should look like they scroll behind the prompt box. no black padding
            under it"). At rest nothing moves: the first row sits where it did. */}
        <div ref={railRef} data-sidebar-rail className="-mt-5 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden pt-5 max-[800px]:overflow-y-visible">
          {/* PINNED — the human's shelf, at the very top, above the cue (maintainer 2026-09-02). Each row
              carries the same rest-time column as the cue, and the pin itself appears only on hover, as the
              unpin verb (colinhacks/frizz#66: "show the updated times first and only show the pin/unpin on hover?
              pinned ones already live in their own section anyway" — the band's label already says pinned, so
              a solid pin on every row said it twice and cost the row its age). A row that is actively
              SPINNING shows no age, as in the Running band: it has not come to rest, and its spinner is the
              reading. A pinned row that holds a queue card is dated whatever it has running, as the cue
              dates it (PinnedBand). These rows are OUT of the band system entirely — sectionThreads diverts them before any
              band claims them, so a pinned thread stays here spinning, resting, snoozed or Done alike — and
              the band is ordered by the pin instants, oldest first, never by activity: it is an arrangement
              the human made, and nothing the threads do may shuffle it. The human rearranges it by dragging a
              row (PinnedBand).
              LABELED since 2026-09-19, like every band below it, and NOT collapsible (maintainer: the Pinned,
              Queue and Running labels "should not be collapsible") — the header is the static form of
              SectionHeader, so it lines up with the collapsible Snoozed/Done headers. */}
          {sections.pinned.length > 0 && (
            <section aria-label="Pinned">
              <SectionHeader label="Pinned" count={sections.pinned.length} />
              <PinnedBand threads={sections.pinned} railRef={railRef} activeId={activeId} onQueueNavigate={navigateToQueueCard} />
              {/* The separating rule is drawn only when the Rested/Active section actually follows:
                  Snoozed, Done and External each draw their OWN rule above themselves, so drawing one
                  here too would double it whenever that section is empty. */}
              {openCount > 0 && <hr className="my-3 border-border/50" />}
            </section>
          )}
          {/* RESTED + ACTIVE — always shown, NEVER collapsible (you can't hide your queue or your live
              work). Two rule-separated bands (see groups.ts orderActive/partitionActive), each under a
              static label since 2026-09-19 (maintainer: "sidebar labels for pinned, queue, and running
              … should not be collapsible"). The labels use the maintainer's own words for the bands —
              QUEUE for the cue, RUNNING for the spinning rows — rather than the code's Rested/Active
              keys, because the label is copy the human reads, and "the queue" is what they call it.
              RESTED — the cue — sits FIRST, right under the prompt box (maintainer 2026-08-08), in the
              EXACT queue order, so the rail's top row is opposite the queue's top card and scrolling
              the queue walks the scroll marker straight down this rail. ACTIVE — live work that isn't
              waiting on you — runs BELOW the rule (an Active row has no queue card — the maintainer's
              ask: they don't render in the queue), so it stays glanceable without pushing the cue down.
              Only the cue's rows carry the rest-time column: it dates a HANDOFF, and a row that is
              still spinning has not made one. An empty band draws no label, the same as Snoozed and
              Done: a "Queue 0" header over nothing is a count nobody needs. */}
          {openCount > 0 ? (
            <>
              {rested.length > 0 && <SectionHeader label="Queue" count={rested.length} />}
              {rested.map((t) => (
                <div key={t.id}>
                  <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={navigateToQueueCard} restedAge />
                  <SubAgentRows t={t} />
                </div>
              ))}
              {runningCount > 0 && rested.length > 0 && <hr className="my-3 border-border/50" />}
              {runningCount > 0 && <SectionHeader label="Running" count={runningCount} />}
              {/* Newest first, the band's own order (orderRunning): a thread that starts lands at the
                  top, so that is where the row standing in for it is drawn. */}
              {[...starting].reverse().map((entry) => <StartingRow key={entry.key} entry={entry} />)}
              {/* NEVER the scroll marker: no Running row has a queue card. A row arrives here still
                  named by the reading rule on every send — the card it left is fading under the
                  reader — and the marker is handed to the row that took its place (markerRow). */}
              {running.map((t) => (
                <div key={t.id}>
                  <ThreadRow t={t} onQueueNavigate={navigateToQueueCard} />
                  <SubAgentRows t={t} />
                </div>
              ))}
            </>
          ) : sections.pinned.length === 0 ? (
            // pl-5 matches ThreadRow's own content inset (its status-indicator column), so the
            // placeholder starts exactly where the rows it stands in for would — and lands within a
            // pixel of the Snoozed/Done labels, which clear the same width for their chevron. A
            // bare px-1.5 left it hanging 14px out at the rail's raw edge, alone against everything.
            // "open", not "active": this stands in for the Active AND Rested bands together, and it
            // renders only when BOTH are empty. Saying "no active threads" over a hidden queue would be
            // the same conflation the vocabulary above exists to stop. Suppressed under a pinned band —
            // the pinned rows ARE open threads, so the claim would be visibly false one band up.
            <div className="py-1 pl-5 pr-1.5 text-[11.5px] text-muted-50">No open threads</div>
          ) : null}
          {/* HELD — every deliberate clock/hourglass/timed wait, visibly de-emphasized and labeled so
              it cannot read as active work. COLLAPSIBLE, and collapsed by default (maintainer
              2026-08-04): nothing here is waiting on the rail's reader right now, so it opens as a
              labeled count and expands on demand — the count is the glance. */}
          {heldThreads.length > 0 && (
            <section aria-label="Snoozed">
              <hr className="my-3 border-border/50" />
              {/* Same header component as Done so the bands can never visually drift. */}
              <SectionHeader
                label="Snoozed"
                count={heldThreads.length}
                collapsed={collapsed.snoozed}
                onToggle={() => (store.sidebarCollapsed.snoozed = !store.sidebarCollapsed.snoozed)}
              />
              {/* The rest-time column is ON here too (colinhacks/frizz#66: "It's hard for me to know
                  how long some of these snoozes have been snoozed for"). A parked row says nothing else
                  on the rail — its wake detail lives in the indicator's tooltip — so without the column a
                  watch that went quiet a week ago reads exactly like one parked this morning. The band is
                  ordered by the same instant (orderByInteraction), so the column reads monotonically. */}
              {!collapsed.snoozed &&
                heldThreads.map((t) => (
                  <div key={t.id}>
                    <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={navigateToQueueCard} restedAge />
                    <SubAgentRows t={t} />
                  </div>
                ))}
            </section>
          )}
          {/* DONE — collapsible, OMITTED entirely (with its rule) when empty, and the ONLY band whose
              rows are virtualized once open (see DoneBand: it is the only band that grows without
              bound). Collapsed, it has always mounted nothing at all — the gate below is the original
              one — so virtualization is about the EXPANDED band alone. */}
          {inactiveThreads.length > 0 && (
            <div>
              <hr className="my-3 border-border/50" />
              <SectionHeader
                label="Done"
                count={inactiveThreads.length}
                collapsed={collapsed.inactive}
                onToggle={() => (store.sidebarCollapsed.inactive = !store.sidebarCollapsed.inactive)}
              />
              {!collapsed.inactive && (
                <DoneBand threads={inactiveThreads} railRef={railRef} activeId={activeId} onQueueNavigate={navigateToQueueCard} />
              )}
            </div>
          )}
          {/* EXTERNAL — the project's own `claude`/`codex` terminals, which frizz reads but
              does not drive. LAST in the rail and collapsed by default: it is the only band that is not
              frizz's work at all, so it must never compete with the queue for the reader's eye. Only
              RESTED sessions are in it — the server drops a spinning one, because a session that is
              working is one the human already has open in its own window (maintainer 2026-08-19).
              Rows are read-only: ThreadActionBar swaps the composer for a plain "running in an external
              terminal" line, and there is no queue card, no verb and no Snoozed/Done to fall into. */}
          {externalSessions.length > 0 && (
            <section aria-label="External">
              <hr className="my-3 border-border/50" />
              <SectionHeader
                label="External"
                count={externalSessions.length}
                collapsed={collapsed.external}
                onToggle={() => (store.sidebarCollapsed.external = !store.sidebarCollapsed.external)}
              />
              {/* The rest-time column is ON here, as in the cue and Snoozed, and unlike Done. Every row in
                  this band is by definition at rest, so "how long ago" is the only thing that distinguishes
                  them — it is what tells you which terminal you wandered away from an hour ago and which
                  one is from last Tuesday. Done rows are over, so their age answers nothing. */}
              {!collapsed.external &&
                externalSessions.map((t) => (
                  <ThreadRow key={t.id} t={t} active={activeId === t.id} onQueueNavigate={navigateToQueueCard} restedAge />
                ))}
            </section>
          )}
        </div>
      </div>
    </aside>
  )
}

// THE PINNED BAND, rearranged by dragging a row (maintainer 2026-10-17: "make the pin list reorderable
// with a simple drag operation"). It is the project rail's drag (ProjectRail.tsx), adapted to rows that
// are not one height — a title wraps, and a thread's live sub-agents hang under it — so each row is
// measured when the drag begins (lib/railReorder nearestSlot). A press becomes a drag only after
// PIN_DRAG_THRESHOLD_PX, so a click still opens the thread; the held row follows the pointer inside the
// band while the rows it passes slide aside; the drop writes the band's whole order and holds it on
// screen until the board carries it back. Alt+↑/↓ on a focused row moves it one slot, as on the rail.
//
// THE CONSOLE'S "BY STATUS" VIEW DRAWS ONE TOO (ConsoleSidebar.tsx), for its own shelf: `shelf` says
// which pin the rows speak for, `leading` carries each row's project square, and `onReorder` is how
// that shelf is written — one call to this project here, one per project there.
const PIN_DRAG_THRESHOLD_PX = 4
/** How long a drop is drawn while the board has not caught up with it, before the board is believed again. */
const PIN_ARRANGEMENT_HOLD_MS = 10_000
/** When the last pinned-row drag ended: the click the browser fires on release must not open the row. */
let pinDragEndedAt = 0

interface PinDrag {
  fromIndex: number
  toIndex: number
  deltaY: number
  /** How far a passed row slides: the held row's height plus the gap between rows. */
  step: number
  /** The band as the drag found it. The indices are positions in this list, whatever the board does meanwhile. */
  list: readonly ThreadView[]
}

/** `threads` in the order of `ids`; any thread `ids` does not name keeps its place after them. */
function inPinOrder(threads: readonly ThreadView[], ids: readonly string[]): readonly ThreadView[] {
  const byId = new Map(threads.map((t) => [t.id, t]))
  const named = ids.flatMap((id) => byId.get(id) ?? [])
  return named.length === threads.length ? named : [...named, ...threads.filter((t) => !ids.includes(t.id))]
}

/** A project board's shelf, written in one call: the band's whole order, re-dealt by the server. */
function reorderBoardPins(ids: readonly string[]): Promise<unknown> {
  return rpc.reorderPinnedThreads({ slugs: [...ids] })
}

/** The band's members, order aside: a pin or an unpin changes them, a reorder does not. */
const membersKey = (ids: readonly string[]) => [...ids].sort().join("\n")

export function PinnedBand({ threads, railRef, activeId, onQueueNavigate, shelf = "board", leading, onReorder = reorderBoardPins }: {
  threads: readonly ThreadView[]
  railRef: RefObject<HTMLDivElement | null>
  activeId: string | null
  onQueueNavigate: (id: string) => void
  /** Which pin the rows speak for: the project board's, or the Console's (groups.ts pinnedOn). */
  shelf?: PinShelf
  /** A mark before each row's indicator — the Console's project square. */
  leading?: (t: ThreadView) => ReactNode
  /** Write the band's new order, top first. */
  onReorder?: (ids: readonly string[]) => Promise<unknown>
}) {
  const bandRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<PinDrag | null>(null)
  // The order the human just made, drawn until the board AGREES with it — the write landed — or the
  // shelf's members change (a pin or unpin anywhere: the board is the truth again), or the write fails,
  // or PIN_ARRANGEMENT_HOLD_MS passes without the board catching up. Waiting for agreement, not for the
  // board's next change, is what the Console needs: its band spans projects, a drop there can be
  // written to more than one, and each project's write reaches the board in a delta of its own, so the
  // first to land would draw an order that is neither the old one nor the new for a beat.
  const [arranged, setArranged] = useState<{ ids: readonly string[]; members: string } | null>(null)
  const boardIds = threads.map((t) => t.id)
  const boardKey = boardIds.join("\n")
  const boardMembers = membersKey(boardIds)
  useEffect(() => {
    if (arranged && (arranged.ids.join("\n") === boardKey || arranged.members !== boardMembers)) setArranged(null)
  }, [arranged, boardKey, boardMembers])
  useEffect(() => {
    if (!arranged) return
    const timer = setTimeout(() => setArranged((current) => (current === arranged ? null : current)), PIN_ARRANGEMENT_HOLD_MS)
    return () => clearTimeout(timer)
  }, [arranged])
  const shown = useMemo(() => {
    if (drag) {
      // The latest copy of each row the drag picked up, so a spinner still stops mid-drag.
      const byId = new Map(threads.map((t) => [t.id, t]))
      return drag.list.map((t) => byId.get(t.id) ?? t)
    }
    return arranged && arranged.members === boardMembers ? inPinOrder(threads, arranged.ids) : threads
  }, [drag, arranged, boardMembers, threads])

  const onReorderRef = useRef(onReorder)
  onReorderRef.current = onReorder
  const commit = useCallback((next: readonly ThreadView[]) => {
    const ids = next.map((t) => t.id)
    const made = { ids, members: membersKey(ids) }
    setArranged(made)
    onReorderRef.current(ids).catch((error: unknown) => {
      setArranged((current) => (current === made ? null : current))
      showToast(`Reorder failed: ${String(error instanceof Error ? error.message : error).slice(0, 80)}`)
    })
  }, [])

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, index: number) => {
    // Left button only, and never a modified click: ⌘-click on the row's door opens a new tab.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (shown.length < 2) return
    const row = event.currentTarget
    const { pointerId, clientY: startY } = event
    const rail = railRef.current
    const startScroll = rail?.scrollTop ?? 0
    const list = shown
    let slots: RowSlot[] | null = null
    let frame = 0
    // The pointer's travel plus whatever the rail has scrolled under it: the held row stays under the
    // pointer while the rail auto-scrolls, or while a wheel scrolls it.
    const deltaFor = (clientY: number) => clampToSlots(slots!, index, clientY - startY + ((rail?.scrollTop ?? 0) - startScroll))
    const apply = (clientY: number) => {
      if (rail) {
        const velocity = edgeScrollVelocity(clientY, rail.getBoundingClientRect())
        if (velocity) rail.scrollTop += velocity
      }
      const deltaY = deltaFor(clientY)
      setDrag({ fromIndex: index, toIndex: nearestSlot(slots!, index, deltaY), deltaY, step: heldStep(slots!, index), list })
    }
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return
      if (!slots) {
        if (Math.abs(move.clientY - startY) < PIN_DRAG_THRESHOLD_PX) return
        const rows = bandRef.current?.querySelectorAll<HTMLElement>(":scope > [data-pinned-row]")
        if (!rows || rows.length !== list.length) return
        slots = [...rows].map((el) => {
          const box = el.getBoundingClientRect()
          return { top: box.top, height: box.height }
        })
        row.setPointerCapture(pointerId)
        window.getSelection()?.removeAllRanges()
      }
      move.preventDefault()
      const clientY = move.clientY
      // One update per frame, and the edge auto-scroll keeps running while the pointer is held still.
      cancelAnimationFrame(frame)
      const tick = () => {
        apply(clientY)
        if (rail && edgeScrollVelocity(clientY, rail.getBoundingClientRect())) frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    }
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return
      cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      if (!slots) return // a click: nothing was dragged
      pinDragEndedAt = Date.now()
      setDrag(null)
      if (up.type === "pointercancel") return
      // From the release itself rather than the last frame, which may not have run yet.
      const toIndex = nearestSlot(slots, index, deltaFor(up.clientY))
      if (toIndex !== index) commit(moveItem(list, index, toIndex))
    }
    window.addEventListener("pointermove", onMove, { passive: false })
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }, [shown, railRef, commit])

  // Alt+Arrow, not a bare arrow: a bare ArrowUp on a focused row is how the rail scrolls.
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
    const to = index + (event.key === "ArrowUp" ? -1 : 1)
    if (to < 0 || to >= shown.length) return
    event.preventDefault()
    commit(moveItem(shown, index, to))
    // Focus follows the row, not the slot — otherwise a second press moves whatever landed here.
    requestAnimationFrame(() => {
      bandRef.current?.querySelectorAll<HTMLElement>(":scope > [data-pinned-row]")[to]?.querySelector("button")?.focus()
    })
  }, [shown, commit])

  return (
    <div ref={bandRef} data-pinned-band className={drag ? "select-none" : undefined}>
      {shown.map((t, index) => {
        const held = drag?.fromIndex === index
        const offset = drag ? (held ? drag.deltaY : shiftFor(index, drag.fromIndex, drag.toIndex, drag.step)) : 0
        return (
          <div
            key={t.id}
            data-pinned-row={t.id}
            data-pin-held={held || undefined}
            onPointerDown={(event) => startDrag(event, index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            // The release click: Chrome fires it at the capture target — this box, which opens nothing —
            // but an engine that fires it at the row under the pointer would open the row just dropped.
            onClickCapture={(event) => {
              if (Date.now() - pinDragEndedAt < 250) {
                event.preventDefault()
                event.stopPropagation()
              }
            }}
            // The row's door is a link, and a native link drag would take the pointer away mid-drag.
            onDragStart={(event) => event.preventDefault()}
            // Held, the row is lifted off the band on the rail's own base colour — the backing its hover
            // strip already paints — so it reads as the hovered row it is, raised over the rows it crosses.
            // The hairline ring is what lifts it in the dark theme, where a shadow on the near-black rail
            // does not show.
            className={held ? "relative z-10 cursor-grabbing rounded-md bg-bg shadow-lg shadow-shadow-ink/40 ring-1 ring-border" : undefined}
            style={{
              transform: offset ? `translateY(${offset}px)` : undefined,
              // Only the rows sliding aside animate, and only while a row is held: the drop moves every
              // row to its new slot in the same commit that clears the transforms, so it must not ease.
              transition: drag && !held ? "transform 160ms ease" : undefined,
            }}
          >
            {/* Undated only while it SPINS: actively running and holding no queue card. A queued row with
                live work out (an open question beside a running sub-agent) wears the queue's glyph, not a
                spinner, and the cue would date it — so it is dated here too. */}
            <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={onQueueNavigate} shelf={shelf} leading={leading?.(t)} restedAge={t.needsYou === true || !isActivelyRunning(t)} />
            <SubAgentRows t={t} />
          </div>
        )
      })}
    </div>
  )
}

// A THREAD THAT IS STARTING — a dispatch from the prompt box whose row the board has not delivered yet
// (lib/pendingDispatch), drawn as the row it is about to become: the Running band's spinner, the
// "Spinning up a thread…" placeholder a fresh thread's own row opens on (displayTitle), and the provider
// mark. It copies ThreadRow's boxes class for class, so the real row replaces it without a pixel moving;
// the recorder that watches the rail (2026-10-13) saw one geometry change per dispatch with it, the row
// appearing, where the "Starting thread…" card it replaces had three.
// Not a button: there is no thread to open yet, and it is gone within the dispatch call's answer.
// `leading` is ThreadRow's own slot, in the same place: the Console's rows carry their project's square.
export function StartingRow({ entry, leading }: { entry: PendingDispatchEntry; leading?: ReactNode }) {
  return (
    <div data-sidebar-starting role="status" aria-label="Starting thread" className="relative flex min-w-0 items-start rounded-md">
      <div className="min-w-0 flex-1 flex items-start gap-2 pb-1 pl-5 pr-1.5 pt-1 text-left">
        {leading}
        <span className="w-4 h-[19px] shrink-0 flex items-center justify-center">
          <span className="flex items-center justify-center"><BoxSpinner /></span>
        </span>
        <span className="min-w-0 flex-1 flex flex-col">
          <span className="flex min-w-0 items-baseline gap-3">
            <span className="min-w-0 flex-1 break-words text-[13px] leading-[19px] text-provisional">
              <TitleWithTrailers title={SPINNING_UP_TITLE}>
                <ProviderMark backend={entry.backend} model={entry.model} className="ml-1" />
              </TitleWithTrailers>
            </span>
          </span>
        </span>
      </div>
    </div>
  )
}

// A section header: an optional collapse caret, the label, and the count. ONE source of truth for
// every band header so they can never visually drift apart again. Snoozed, Done and External are
// collapsible; Pinned, Queue and Running (since 2026-09-19) omit onToggle and render as a static div
// with a caret-width spacer, so a non-collapsible label still aligns with the collapsible ones.
export function SectionHeader({ label, count, collapsed, onToggle }: { label: string; count: number; collapsed?: boolean; onToggle?: () => void }) {
  const inner = (
    <>
      {onToggle ? (
        <ChevronRight size={11} className={`transition-transform ${collapsed ? "" : "rotate-90"}`} />
      ) : (
        // Reserve the caret's width so a non-collapsible label lines up with the collapsible ones.
        <span className="w-[11px] shrink-0" aria-hidden />
      )}
      <span>{label}</span>
      {/* Count rides right next to its label (not floated to the far edge) — it's meaningful data,
          not a margin ornament; raised contrast so it actually reads. */}
      <span className="ml-1.5 tabular-nums text-muted-60">{count}</span>
    </>
  )
  // A WHOLE-PIXEL HEADER: `leading-4` makes it 24px (py-1 + a 16px line). Left to the font's own line
  // height it was 23.703px in sans, so a band arriving or leaving changed the rail's height by a fraction
  // (48.703px for Running). Beside the queue that only put the rows under it on fractional pixels; ABOVE
  // it (the stacked layout, ≤800px) the page's scroll anchor compensates in whole pixels, so every send
  // and every rest moved the whole queue by the remainder — the cards read 1px off at the send and 1px
  // back at the return in 3 of 3 recordings at 780x900 (2026-10-13).
  const cls = "flex w-full items-center gap-1 px-1.5 py-1 text-[11px] leading-4 uppercase tracking-wide text-muted-70"
  return onToggle ? (
    <button onClick={onToggle} className={`${cls} transition-colors hover:text-fg`}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  )
}

// THE DONE BAND, VIRTUALIZED — the only band that is, because it is the only one that grows without
// bound. Done holds every thread the human has ever finished, and it mounted all of them: 553 rows on a
// copy of the maintainer's own board, measured 2026-09-04 with scripts/verify-done-band-virtualization.mjs.
//
//   rail DOM nodes                     154 collapsed → 15,085 expanded
//   ONE full style recalculation      3.10ms         →  21.50ms   (6.9×)
//   ONE overlay open: main thread blocked   0ms      → 101-108ms, and 53ms → 119ms to paint
//
// Virtualized, expanded: 884 nodes, a 4.00ms recalculation, and no long task at all.
//
// The recalculation is the MECHANISM, not a side reading. App's body scroll lock (App.tsx) forces
// exactly one every time a drawer, the palette or the settings pane opens, so an expanded Done band
// taxes every later navigation whether or not the reader is looking at it — and the rows it taxes you
// for are the ones you finished with. The rows are ALREADY memoized; this was never a render problem.
//
// It shares the RAIL's scroller rather than growing a nested one — a second scrollbar inside the rail
// would be a UI change, and this is a performance fix. That is what `scrollMargin` is for: the band's
// own offset inside the rail's scrolled content, so the virtualizer can read the rail's scrollTop in the
// band's coordinates. The offset MOVES whenever anything above changes — a row arrives, Snoozed
// expands, a title rewraps — so it is re-measured after every commit (every band above is rendered from
// the board, so a commit is the only way any of them can change) and on any resize of the rail itself
// (a width change rewraps titles above without a commit).
//
// WHAT THIS COSTS, so nobody rediscovers it as a bug: the browser's own find (⌘F) and Tab order reach
// only the rows currently mounted. That is inherent to virtualizing, and the rail is a column of names
// you SCAN — ⌘K searches every thread, mounted or not.
// The rail has no arrow-walk and no programmatic row focus (it is mouse-driven — see the header note),
// so there is nothing here that has to scroll an unmounted row into view before focusing it. If one is
// ever added, it must call virtualizer.scrollToIndex first; a row that is not mounted cannot be focused.
//
// 27px is STRUCTURAL, not a fitted constant: a row is pt-1 + leading-[19px] + pb-1, and that line box
// is fixed, so it holds in BOTH app fonts (`html[data-font]`) with nothing to re-measure when the
// setting flips. Verified: the band's ink pitch reads exactly 27.00px in mono AND in sans, and all 553
// rows measured 27px each, so the whole band is 14,931px estimated and 14,931px real — the rail's
// scrollHeight is 15,120px with the band virtualized and 15,120px without it, and the scrollbar cannot
// tell. Only a WRAPPED title (46px) breaks the estimate, and measureElement corrects it as it mounts.
const DONE_ROW_ESTIMATE = 27
// ~25 rows fill the 684px rail at 1440×900, so eight either side is a screenful of slack for a fast
// wheel without taking the node count back up.
const DONE_OVERSCAN = 8

function DoneBand({
  threads,
  railRef,
  activeId,
  onQueueNavigate,
}: {
  threads: ThreadView[]
  railRef: RefObject<HTMLDivElement | null>
  activeId: string | null
  onQueueNavigate: (id: string) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => railRef.current,
    // Keyed by THREAD, not index: a Done row is archived by the human at any position in the band, and
    // an index key would hand the next row the vanished one's measured height.
    getItemKey: (index) => threads[index]?.id ?? index,
    estimateSize: () => DONE_ROW_ESTIMATE,
    overscan: DONE_OVERSCAN,
    scrollMargin,
  })

  // NO DEPENDENCY ARRAY, deliberately: this has to run after every commit, because a commit is exactly
  // when the bands above may have changed height. It reads two rects and settles immediately — a state
  // write only happens when the offset actually moved.
  useLayoutEffect(() => {
    const rail = railRef.current
    const list = listRef.current
    if (!rail || !list) return
    const measure = () => {
      // CONTENT coordinates, not offsetTop. Neither the rail nor the aside above it is positioned, so
      // offsetTop would answer against the document and carry the whole page layout into the number.
      const next = list.getBoundingClientRect().top - rail.getBoundingClientRect().top + rail.scrollTop
      setScrollMargin((current) => (Math.abs(current - next) < 0.5 ? current : next))
    }
    measure()
    // The rail's own box: a width change rewraps the titles ABOVE this band, which moves it without any
    // commit of its own.
    const observer = new ResizeObserver(measure)
    observer.observe(rail)
    return () => observer.disconnect()
  })

  return (
    // The band's full height, so the rail's scrollbar is the length the whole archive deserves — the
    // reader must not be able to tell which rows are mounted.
    <div ref={listRef} data-done-band className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const t = threads[item.index]
        if (!t) return null
        return (
          <div
            key={t.id}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className="absolute left-0 top-0 w-full"
            // `start` is in the RAIL's coordinates (it includes scrollMargin); this box is positioned
            // inside the band, so the offset comes back off.
            style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
          >
            <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={onQueueNavigate} />
            <SubAgentRows t={t} />
          </div>
        )
      })}
    </div>
  )
}

// The title's trailing adornments — the provider mark, the `terminal` tag, the legacy status chip —
// are ATOMIC inline boxes, and the line breaker is free to break right BEFORE one even though no
// whitespace separates it from the title. On a wrapping title that regularly stranded the provider
// mark ALONE on a second line, with the whole title above it (maintainer 2026-07-31: "often the only
// thing that breaks onto the new line is the agent icon"). Glue them to the title's LAST WORD in a
// nowrap group so the pair wraps together instead.
//
// The group takes the whole last word when it is short enough to fit the narrowest rail beside the
// adornments, and otherwise just its TAIL — gluing a rail-wide token whole would overflow instead of
// wrapping. Cutting a long token is safe: an element boundary mid-word adds no break opportunity of
// its own, so the head still breaks exactly where `break-words` would have broken it, and the mark
// keeps a dozen characters of company either way.
const MAX_GLUED_TITLE_WORD = 16
const GLUED_TITLE_TAIL = 12
function TitleWithTrailers({ title, children }: { title: string; children: ReactNode }) {
  const text = title.trimEnd()
  const wordStart = text.lastIndexOf(" ") + 1
  const cut = text.length - wordStart <= MAX_GLUED_TITLE_WORD ? wordStart : text.length - GLUED_TITLE_TAIL
  if (cut >= text.length) return <>{title}{children}</>
  return (
    <>
      {text.slice(0, cut)}
      <span className="whitespace-nowrap">{text.slice(cut)}{children}</span>
    </>
  )
}

// One THREAD row. Session rows (the default): the derived session indicator, the title, a foreign
// read-only tag, an awaiting hint gloss, and the activity + live-sub-agent suffix. NO Mark-as verb —
// session threads use Archive in the persistent thread footer. A LEGACY row
// keeps the vestigial rendering: a status chip + the hover-revealed Mark-as split button (the ONLY
// place it survives). A click opens the thread's drawer (openThread routes chat/doc).
//
// MEMOIZED: board deltas REPLACE a changed thread's whole object, so `t` keeps snapshot identity iff
// unchanged — memo skips exactly the untouched rows.
export const ThreadRow = memo(function ThreadRow({
  t,
  legacy,
  active = false,
  onQueueNavigate,
  restedAge = false,
  leading,
  shelf = "board",
}: {
  t: ThreadView
  legacy?: boolean
  active?: boolean
  onQueueNavigate?: (id: string) => void
  /** Show the right-justified rest-time column: the cue, Pinned, Snoozed and External rows — see RestedAge. */
  restedAge?: boolean
  /** A mark before the indicator — the Console's project square (ConsoleSidebar.tsx). */
  leading?: ReactNode
  /** Which pin the row's mark and pin verb speak for: its project board's, or the Console's "By status"
   *  shelf (groups.ts isConsolePinned). One row shows ONE shelf's pin, never both. */
  shelf?: PinShelf
}) {
  const foreign = !legacy && t.foreign === true
  // Snoozed rows are uniformly grayed as a whole; provisional titles retain their local dim treatment.
  // A thread awaiting its OWN live sub-agent/Monitor is not Snoozed and stays fully active — unless its
  // worker called that rest `watching` (2026-10-05), which parks it here like any other watcher.
  const snoozed = !legacy && isSnoozed(t)
  // A DONE THREAD IS GRAYED WHEREVER IT ROWS — the Done band, and the pinned band just the same
  // (maintainer 2026-09-11: "a thread that's marked as done should always be grayed out, even if it's
  // pinned"). The pin freezes a row's PLACE, never its state, so the dim has to ride the ROW rather than
  // the band it happens to sit in; the two dims share one treatment so the rail has exactly one way of
  // saying "nothing here is moving". Read off the indicator's own predicate, so a running-yet-archived
  // thread — which sectionOf files under Active with its spinner — keeps its full weight there too.
  const done = !legacy && sessionIndicatorKind(t) === "archived"
  const dim = snoozed || done
  const dimLabel = !legacy && titleIsProvisional(t)
  // The rows with an obvious single next action carry that verb INLINE, instead of making you open the
  // thread to find it. offersRetry (groups.ts) picks them: a STALLED row (the [!] mark — process
  // exited) AND a row KILLED by a usage limit frizz will auto-resume (the yellow hourglass — a faster
  // door to the in-drawer "Continue now" than waiting for the window). The queue card and drawer header
  // read the SAME helper, so no surface can disagree with the rail about which threads offer Retry.
  const canRestart = !legacy && offersRetry(t)
  // A pinned row places the unpin verb rightmost in the hover strip, where its rest time sits at rest.
  const pinned = !legacy && pinnedOn(t, shelf)
  // A ROW IS ITS TITLE, AND NOTHING ELSE (maintainer 2026-08-19: "there should never ever be any fucking
  // thing in the sidebar except for the fucking title"). There is no subtitle line on any row, in any
  // state: not the fence's PR ref, not a snooze, not the legacy `.frizz` activity gloss, not a sub-agent
  // count. Every one of them was a second, competing status beside the row's own — the rail is a column
  // of NAMES you scan, and each caption added there made the next one harder to find.
  //
  // What frizz knows about the row still exists, one hover away: the indicator's popover composes it
  // from the AWAITING BLOCK deterministically (awaitingWaitClause) plus the worker's own handoff prose, so
  // the detail is available on demand and never spends a line of the rail. That is the same call that
  // hid the SNOOZED label (2026-08-03) and the worker's reason (2026-08-16), applied to the last of them.
  //
  // THE HOVER WASH IS AN `after:` PSEUDO PAINTED ABOVE THE ROW, not a background under it. The hover
  // actions overlay the title's first line and need an opaque backing (a long title's last words would
  // otherwise show through the glyphs); painting the wash on top lets that backing be the rail's plain
  // base colour and still match the lit row exactly — in every state and every frame of the fade. As a
  // `hover:bg-*` under the strip, the backing had to be a second, guessed colour, and it read as a
  // darker box around the buttons (maintainer 2026-09-03). `pointer-events-none`, so it never shadows a
  // click on the row or its actions; `rounded-md` because the row clips nothing.
  return (
    <div
      data-sidebar-item={t.id}
      className={`group relative flex min-w-0 items-start rounded-md transition-[color,opacity] after:pointer-events-none after:absolute after:inset-0 after:rounded-md after:bg-hover after:opacity-0 after:transition-opacity hover:after:opacity-100 ${legacy ? "opacity-80" : dim ? "sidebar-row-dim" : ""}`}
    >
      {/* The reading position owns a real, in-row rail rather than borrowing the status-icon column.
          The marker spans the row's complete visual height, including wrapped titles and subtitles,
          while the fixed rail keeps it from shifting content or relying on clipped overflow. */}
      <span aria-hidden="true" data-sidebar-marker-rail className="pointer-events-none absolute inset-y-0 left-0 w-5">
        {active && <span data-sidebar-scroll-marker className="absolute inset-y-0 left-1 w-[2px] rounded-full bg-accent" />}
      </span>
      <button
        onClick={() => {
          // A queued (needsYou) thread already has its full card in the main column. A sidebar click
          // just SCROLLS to that card — it does NOT open a redundant drawer over it (maintainer
          // 2026-07-15: "it should not open the thread drawer, just auto-scroll to the item in the
          // queue"). Only fall through to the drawer when no card is mounted (not queued/not rendered).
          // Opening the drawer here even over the card was tried on 2026-10-21 (c8f97f3c) and reverted
          // the next day (maintainer: "It definitely should scroll to where it is in the queue instead").
          if (t.needsYou && scrollToQueueCard(t.id)) {
            onQueueNavigate?.(t.id)
            return
          }
          openThread(t.id)
        }}
        aria-current={active ? "location" : undefined}
        className="min-w-0 flex-1 flex items-start gap-2 pb-1 pl-5 pr-1.5 pt-1 text-left"
      >
        {leading}
        {/* h-[19px] so the indicator centers on the title's FIRST line, not the middle of a wrapped row. */}
        <span className="w-4 h-[19px] shrink-0 flex items-center justify-center">
          <ThreadIndicator t={t} legacy={legacy} />
        </span>
        <span className="min-w-0 flex-1 flex flex-col">
          {/* items-BASELINE, not items-center: the rest time is a smaller type size sitting beside the
              title, and the eye reads the two as one line only when their baselines agree. On a WRAPPED
              title flex aligns the FIRST baseline, so the label stays on the title's first line where
              the row's other right-edge affordance (RowRetryButton) also lives. */}
          {/* gap-3, not gap-2. The measured gap is usually 20–40px of ink (ragged-right titles rarely
              reach their box edge), but the case that decides the number is the line that DOES fill:
              8px is ~2 word spaces at 13px, which reads as the title running into its own timestamp.
              12px is a gutter, and it costs the title 4px it does not miss. */}
          <span className="flex min-w-0 items-baseline gap-3">
            <span className={`min-w-0 flex-1 break-words text-[13px] leading-[19px] ${dimLabel ? "text-provisional" : dim ? "text-fg/75" : "text-fg/90"}`}>
              <TitleWithTrailers title={displayTitle(t)}>
                {!legacy && <ProviderMark backend={t.backend} model={t.model} className="ml-1" />}
                {/* MEASURED 2026-08-19, the first time this tag ever rendered (it was written for a
                    foreign row and no foreign row reached the rail until the External band). Readings
                    on the real rail at dsf 4, `scripts/ink-gaps.mjs` + the visual-review cap-band probe:
                      title's last word → provider mark   box 4px  → ink 4.15px
                      provider mark     → this tag        box 6px  → ink 6.00px   (a bordered pill's
                                                                     border IS its ink: deadLeft 0)
                    The 1.4× step is the grouping and is deliberate — the mark is the title's own
                    adornment and clings to it, the tag is a separate label and stands off.
                    VERTICAL: this pill's ink centre rides 0.42px ABOVE the title's cap band, and the
                    provider mark beside it 0.08px below. Both are under half a device pixel at the
                    shipped size, so `align-[2px]` stands as measured rather than as a guess.
                    RE-MEASURE rather than re-guess if the type scale or the pill's size moves. */}
                {foreign && (
                  <span
                    className="petite-caps ml-1.5 inline-block rounded border border-border/60 px-1 align-[2px] text-[9.5px] leading-[14px] text-muted-55"
                    title="Read-only — running in an external terminal"
                  >
                    terminal
                  </span>
                )}
                {legacy && <StatusChip status={t.archived ? "archived" : t.status} />}
              </TitleWithTrailers>
            </span>
            {/* The Retry verb is an OVERLAY pinned to this same right edge, so on the rows that offer
                it the two would collide — a 19px opaque button landing halfway across "20 seconds",
                which reads as a rendering fault rather than an affordance. The label gives way to it
                on hover instead: the button is why you pointed at the row. */}
            {restedAge && <RestedAge t={t} yieldsToRetry />}
          </span>
        </span>
      </button>
      {/* The Mark-as verb survives ONLY on legacy rows (a .frizz verb). Session lifecycle controls
          live in the thread header's action strip. */}
      {legacy && (
        <div className="absolute right-1 top-1 hidden group-hover:flex items-stretch rounded-md bg-panel shadow-sm shadow-shadow-ink/30">
          <MarkAsButton slug={t.id} size="sm" />
        </div>
      )}
      {/* ONE-CLICK RECOVERY on a stalled OR limit-killed row (offersRetry). Hover-revealed and
          pinned to the row's right edge, over the title's first line (it OVERLAYS rather than taking
          layout, so pointing at a row never reflows its wrapped title). `group-focus-within` keeps it
          reachable from the keyboard: focus the row button and the next Tab lands here. */}
      {/* THE ROW'S HOVER ACTIONS, pinned to the right edge over the title's first line — exactly where
          the cue's rest time sits, which yields to them on hover (maintainer 2026-08-28: the expand icon
          "should replace where the current time rest duration currently is"). Every row gets the
          fullscreen door; a stalled/held row gets Retry after it, because recovery is the verb the row
          is pointing at.

          NO BOX around the strip (maintainer 2026-09-03: "drop the background color around the icon
          buttons"). It still needs an OPAQUE backing — it overlays the title's first line, and a long
          title's last words would show through the glyphs — so the backing is the rail's base colour
          (`bg-bg`), with a short gradient off its left edge that dissolves the covered letters instead
          of slicing one in half. Both are invisible because the row's hover wash paints ABOVE them (the
          `after:` pseudo on the row), so the strip is exactly the row's colour whether hovered,
          keyboard-focused or snoozed. The old opaque `bg-panel` pill sat UNDER the wash and read as a
          darker box on the lit row. */}
      {!legacy && (
        <div className="absolute right-1.5 top-1 hidden items-center gap-0.5 bg-bg group-hover:flex group-focus-within:flex before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-3 before:bg-linear-to-r before:from-transparent before:to-bg">
          {/* The pin sits LEFT of the fullscreen door on a row that can be pinned (the approved mockup's
              order). On a PINNED row the same button is the unpin and goes RIGHTMOST — after Retry too —
              over the spot the rest time yields on hover (maintainer 2026-09-03: "unpin button should be
              far right for pinned threads on hover"). It is the only pin a pinned row shows: the band's
              label says pinned, so the row spends its right edge on the rest time (colinhacks/frizz#66).
              Not on a foreign row: the server refuses to pin what it does not own, so no button rather
              than a throwing one. */}
          {/* MEASURED 2026-09-03 (scripts/ink-gaps.mjs on sidebar-pin-fixture, dsf 4): on the strip's
              uniform 2px gap the OUTLINE pin's ink sat 12px from the door where door→Retry read 10px and
              Retry→unpin 10.5px, because the pin is a narrow glyph (8×11 of ink in a 19px box, dead
              6/5) and the door's ink is inset too (dead 5/4). The pin's box is trimmed 2px on its door
              side so the strip reads ONE gap — pin→door 10px after the trim. The unpin needs no trim: it
              is the strip's last mark and its 11px ink already sits 10.5px from Retry. RE-MEASURE rather
              than re-guess if a glyph, its size or the gap changes. */}
          {!foreign && !pinned && <RowPinButton t={t} shelf={shelf} className="-mr-0.5" />}
          <ExpandThreadLink slug={t.id} size={12} className={ROW_ACTION_CLASS} />
          {canRestart && <RowRetryButton slug={t.id} />}
          {!foreign && pinned && <RowPinButton t={t} shelf={shelf} />}
        </div>
      )}
      {/* Live children render as SIBLING rows under this one, not inside it — see SubAgentRows, which
          the rail's three sections mount directly after each ThreadRow (maintainer 2026-07-09: render
          running sub-agents in the sidebar). They replaced an old one-line summary suffix that used to
          live in this row's subtitle. */}
    </div>
  )
})

// THE CUE'S RIGHT-HAND COLUMN — how long ago this thread came to REST (maintainer 2026-08-08: "a
// right-justified label on each item in the cue indicating when the thread came to rest").
//
// The instant is `lastActiveLabelAt`, the SAME one the queue card's "Last active" line renders and the
// same one the band is ORDERED by — so the column reads monotonically down the cue instead of
// disagreeing with the order it is printed in. That helper is what keeps a completed background
// sub-agent from bumping a rested row's reading to "just now": at rest it reads the agent's own last
// output (`lastAssistantAt`), never the tailer's last record of any kind.
//
// It carries the SPAN without "ago" (lib/activityTime ageSpan) because the column position is the
// "ago", and it is right-justified rather than trailing the title so the whole cue reads as one column
// of times — a title's length must not decide where its timestamp sits. `useNowMs` is the app's single
// 30s wall clock, so a screenful of these ticks on one timer.
function RestedAge({ t, yieldsToRetry }: { t: ThreadView; yieldsToRetry?: boolean }) {
  const now = useNowMs()
  const at = lastActiveLabelAt(t)
  const span = ageSpan(at, now)
  if (!at || !span) return null
  return (
    <time
      dateTime={at}
      data-rail-rested-age
      title={relativeAge(at, now) ?? undefined}
      // The row's accessible name concatenates its parts, and a bare "2 days" arriving after the title
      // says nothing about WHAT took two days. The label names the reading for that reader; the visible
      // text stays bare, because sighted readers have the column to tell them.
      aria-label={`Rested ${relativeAge(at, now) ?? span}`}
      // shrink-0 + tabular-nums: the column must not compress under a long title, and the digits must
      // not jitter horizontally when the clock ticks. The title takes the remaining width and wraps.
      // leading-[15px], NOT the title's 19px. The two sit on one baseline (the flex line is
      // items-baseline), and at 10.5px a 19px box carries its baseline a pixel higher than the 13px
      // title's does, so the box hung a pixel below the title's and made every cue row 28px where every
      // other row is 27 (measured in sans, 2026-10-13: time box 5-24 beside a title box 4-23). A row
      // therefore changed height each time it crossed between Queue and Running, and everything under
      // the bands moved 1px on every send and back on every rest — the whole queue too, in the stacked
      // layout. At 15px the box is 7-22, inside the title's line; the ink does not move, the baseline
      // being what places it.
      className={`shrink-0 tabular-nums text-[10.5px] leading-[15px] text-muted-55 ${
        yieldsToRetry ? "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0" : ""
      }`}
    >
      {span}
    </time>
  )
}

// The stalled row's recovery verb: a SMALL GREY icon button that restarts the exited session in ONE
// click, without opening the thread. Deliberately the SAME verb, icon, message and RPC path as the
// thread header's Retry (lib/retrySession) — the row is just a faster door to it. Named "Retry", not
// "Restart", because "restart" already means the frizz control plane restarting itself
// (RestartFrizzButton) and the two must not blur.
function RowRetryButton({ slug }: { slug: string }) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  return (
    <Tooltip label="Retry — resume this session where it left off">
      <button
        data-sidebar-retry={slug}
        aria-label="Retry exited session"
        disabled={busy}
        // Keep DOM focus off the button on click so the reveal doesn't outlive the pointer, and stop
        // the press from reaching the row (which would navigate to the thread as well as retry it).
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          setBusy(true)
          retrySession(queryClient, slug).finally(() => setBusy(false))
        }}
        // One of the row's hover actions (see the group in ThreadRow): sized to the title's first line,
        // quiet grey, no border/accent — the muted-icon idiom of the header actions.
        className={`${ROW_ACTION_CLASS} disabled:opacity-50`}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
      </button>
    </Tooltip>
  )
}

// The pin/unpin verb — one of the row's hover actions (ThreadRow places it: left of the fullscreen door
// to pin, rightmost to unpin), on every row the server can pin: sessions frizz owns, in any state,
// because the pin deliberately outranks Done and Snoozed alike. THE FILL IS THE STATE: an outline pin
// offers to pin, and the solid body with the slash offers to unpin, so a filled pin anywhere on the
// rail means "pinned" and nothing else (maintainer 2026-09-02: "use the solid pin icon to make sure
// that the icons are consistent everywhere"; 2026-09-03: "the pin icon should be unfilled for unpinned
// threads").
//
// On the Console's "By status" view the same verb writes the CONSOLE's shelf instead, and says so: two
// shelves now exist, and a tooltip that read the same on both would not tell the human which one a click
// changes.
const PIN_COPY: Record<PinShelf, { pin: string; unpin: string; pinLabel: string; unpinLabel: string }> = {
  board: {
    pin: "Pin — keep this thread at the very top",
    unpin: "Unpin — return this thread to the rail's bands",
    pinLabel: "Pin thread",
    unpinLabel: "Unpin thread",
  },
  console: {
    pin: "Pin to All projects — keep this thread at the top here",
    unpin: "Unpin from All projects — return this thread to its band",
    pinLabel: "Pin thread to All projects",
    unpinLabel: "Unpin thread from All projects",
  },
}

function setPinnedOn(t: ThreadView, shelf: PinShelf, pinned: boolean): Promise<void> {
  const input = { slug: t.id, sessionId: t.sessionId ?? "", pinned }
  return shelf === "console" ? rpc.setThreadConsolePinned(input) : rpc.setThreadPinned(input)
}

function RowPinButton({ t, shelf, className = "" }: { t: ThreadView; shelf: PinShelf; className?: string }) {
  const pinned = pinnedOn(t, shelf)
  const copy = PIN_COPY[shelf]
  const [busy, setBusy] = useState(false)
  return (
    <Tooltip label={pinned ? copy.unpin : copy.pin}>
      <button
        data-sidebar-pin={t.id}
        data-pin-shelf={shelf}
        aria-label={pinned ? copy.unpinLabel : copy.pinLabel}
        disabled={busy}
        // Same two guards as Retry: keep DOM focus off the button so the hover reveal doesn't outlive
        // the pointer, and stop the press from reaching the row (which would also open the thread).
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          setBusy(true)
          setPinnedOn(t, shelf, !pinned)
            .catch((error: unknown) => showToast(`${pinned ? "Unpin" : "Pin"} failed: ${String(error instanceof Error ? error.message : error).slice(0, 80)}`))
            .finally(() => setBusy(false))
        }}
        // `className` carries a layout trim the strip decides per position (see ThreadRow's readings).
        className={`${ROW_ACTION_CLASS} disabled:opacity-50 ${className}`}
      >
        {pinned ? <PinOff size={12} fill="currentColor" /> : <Pin size={12} />}
      </button>
    </Tooltip>
  )
}

// The rail's INDENTED child rows — the same shared ChildOpRow the queue cards and the drawer's ops
// strip render, at "rail" density (the [ ]/[/] checkbox motif the rest of the rail speaks, indented to
// clear the parent row's indicator column). The liveness policy is the rail's own and is deliberately
// unchanged: running OR stale, and only children carrying an id (the drill-in drawer's RPC handle —
// see lib/childOps.ts, which lists all three surfaces' divergent policies in one place).
export function SubAgentRows({ t }: { t: ThreadView }) {
  const subs = visibleChildOps(t.subAgents ?? [], "rail")
  if (subs.length === 0) return null
  return (
    <div className="flex flex-col">
      {subs.map((s) => (
        <ChildOpRow
          key={s.id}
          kind="AGENT"
          label={s.label}
          state={s.state}
          density="rail"
          // A sub-agent's own sub-agents indent one step further under it, so a branch reads as a tree.
          depth={s.depth}
          startedAt={s.startedAt}
          parentSlug={t.id}
          onOpen={() => pushSubAgentDrawer(t.id, s.id, { label: s.label, subagentType: s.subagentType, startedAt: s.startedAt })}
          // The same dismiss × the queue card and the ops strip carry (maintainer 2026-07-30): the rail
          // is where a phantom child is most often SEEN, so it is where retiring one has to be possible.
          onDismiss={childOpDismisser(t.id, s)}
          // The rail has no room for the worker-profile tag the ops strip can show, so it rides the tooltip.
          title={s.subagentType ? `[${s.subagentType}] ${s.label}` : s.label}
        />
      ))}
    </div>
  )
}

// Small-caps bordered status label on legacy rows. Inline so it flows after a wrapped title's last
// word. Colors come from the shared status palette so chips + picker dots speak one language.
function StatusChip({ status }: { status: string }) {
  const label = status === "archived" ? "Done" : status
  return (
    <span className={`petite-caps ml-1.5 inline-block rounded border px-1 align-[2px] leading-[14px] text-[9.5px] ${STATUS_CHIP[status] ?? "text-muted border-border"}`}>
      {label}
    </span>
  )
}


/** THE ROW'S POPOVER — ONE SENTENCE about the wait, then the worker's own sentence under it.
 *
 *  The rail's rows are TITLE-ONLY (see ThreadRow), so this is the only place the wait is legible, which
 *  means it has to READ rather than merely be complete. The first cut stacked one fragment per hint
 *  kind and the reason under that — four lines of record, no sentence anywhere in it (maintainer
 *  2026-08-19: "that popover text looks fucking terrible"). Now the state and what it is waiting on are
 *  joined into one clause, exactly the shape every other tooltip on this rail already has ("Stalled —
 *  the agent's process exited"):
 *
 *      Snoozed until tomorrow at 11:11 AM — waiting on acme/app#391 and a background shell
 *
 *      the tap submission is queued behind their CI backlog
 *
 *  The STATE leads because it is what the glyph you pointed at is claiming; the fence's clause follows
 *  because it says what that glyph means on THIS row; the worker's own prose takes a PARAGRAPH of its
 *  own, because it is the one line frizz did not write. The blank line is load-bearing: the sentence
 *  above it wraps, and a reason set directly under a wrapped line reads as its third line — which is
 *  exactly how it looked when they were merely stacked. Nulls and blanks drop out, so a row with no
 *  fence is just its state. */
// `tail` is one more clause AFTER the fence's own — the timer arm's countdown — so the sentence still
// reads state, then what is waited on, then when: "At rest — waiting on a timer — fires in 34m".
function popover(t: Pick<ThreadView, "lastFence">, state: string | null, tail: string | null = null): string {
  const hints = t.lastFence?.kind === "awaiting" ? t.lastFence.hints : []
  const wait = awaitingWaitClause(hints)
  const head = [state, wait, tail].filter((part) => Boolean(part)).join(" — ")
  return [head, awaitingReason(t)].filter((line) => Boolean(line)).join("\n\n")
}

/** The worker's own prose for this row's POPOVER — the fence's Markdown body, else the `reason:` line a
 *  fence written before 2026-08-24 may still carry, as one sentence. awaitingProse owns both halves of
 *  that; see it for why reading only `reason:` silently dropped the handoff of every fence written in the
 *  current frontmatter shape. Null when the fence carries neither, which is an ordinary park. */
export function awaitingReason(t: Pick<ThreadView, "lastFence">): string | null {
  if (t.lastFence?.kind !== "awaiting") return null
  return awaitingProse(t.lastFence)
}

// ── the indicator (one per row) ──────────────────────────────────────────────────────────────────

// One indicator, one diameter: the spinner ring and the machine-wait glyphs occupy the same optical
// size so rows read evenly. ATTENTION marks (needs-you / question) run a touch LARGER and full-accent
// on purpose — "what needs you" must be the most salient pixel on the rail, never the least.
const INDICATOR = 7
const ATTENTION = 9

// Each indicator carries a terse hover tooltip naming the state it signals. The faint "at rest" dot
// gets none. A plain wrapper <span> is the tooltip trigger (a real DOM node Radix can ref).
export function ThreadIndicator({ t, legacy }: { t: ThreadView; legacy?: boolean }) {
  // No steer special-case here anymore: Sidebar overlays a just-sent steer onto the thread itself
  // (useOptimisticallySteered), so `t` already reads as running and the ordinary derivation returns
  // the spinner — the same one decision that put the row in the running band. When this hook consulted
  // the hint on its own, the glyph and the placement were two rules and drifted apart on every steer.
  const { node, tip } = legacy ? legacyIndicatorFor(t) : sessionIndicatorFor(t)
  // The resolved kind, on the shipped markup. Cheap, and it is what lets the rail's own glyphs be
  // measured where they actually render (scripts/verify-rail-status-glyphs.mjs holds the family to one
  // weight band) instead of against a reconstruction that can drift from the real thing.
  const mark = legacy ? undefined : sessionIndicatorKind(t)
  if (!tip) return mark ? <span data-rail-glyph={mark} className="flex items-center justify-center">{node}</span> : node
  return (
    // A live row that is ALSO snoozed stacks its park under its state ("Working" / "Snoozed until …"),
    // so the tooltip has to keep that newline rather than reflowing the two into one sentence.
    <Tooltip label={tip} side="left" multiline={tip.includes("\n")}>
      <span data-rail-glyph={mark} className="flex items-center justify-center">{node}</span>
    </Tooltip>
  )
}

// The SESSION-first row indicator (kind === "session"). A "?" is reserved for a concrete unresolved
// input state: question/ask, typed interaction, native selector, permission prompt, or explicit human
// block. Queue membership by itself is only a handoff: a bare rested thread keeps the ordinary
// ellipsis. Everything the human is not on the hook for remains quieter: a spinner (in motion), a
// muted hourglass (intentional hold), a quiet check (done/archived), or the at-rest ellipsis.
// STATUS = a markdown-task CHECKBOX family (maintainer 2026-07-10, Obsidian-flavored): every state is
// the SAME rounded-rect outer box with a glyph inside, so the rail reads like a to-do list.
//   [ ] idle        — at rest, nothing pending (empty box)
//   [/] in progress — the rounded-RECT spinner (a segment travels the box perimeter): this thread's own
//                     turn. SINCE 2026-09-20 THE SPINNER IS ALSO THE FRAME for every row something will
//                     wake, and the mark inside says what (maintainer: "everything in the running rail
//                     should always have this spinner animation going"): empty for an own turn, the
//                     ellipsis for a parent at rest with a live SUB-AGENT out (restingOnSubAgents — the
//                     children spin on their own rows), the blue dot below for a shell, the octocat for
//                     a PR. SINCE 2026-10-05 A REST SPINS ONLY WHEN ITS WORKER CALLED IT `working`
//                     (groups.restIsWorking): a queued rest and a `watching` one draw the same glyph in
//                     the static box, because the Running band is the only band that moves.
//   [•] background  — at rest with only a detached background SHELL still running (never a sub-agent —
//                     maintainer 2026-08-01): a SOLID blue dot. It was a pulsing dot in a static box until
//                     2026-09-20; the motion moved to the frame and the dot went solid ("a solid,
//                     non-pulsing blue dot"). Inside the spinner on a `working` rest, in the static box
//                     everywhere else — the queue, and the Snoozed band (see shellDot).
//   [?] needs input — a question / native ask / permission prompt (accent box + "?")
//   [!] stalled     — the agent's PROCESS EXITED with the work unfinished (accent box + "!"), whether
//                     it died mid-turn or exited after resting without a done fence. Same mark either
//                     way, because the next action is the same: Retry. Exactly the rows that carry the
//                     inline Retry verb (offersRetry === this kind — one decision, two surfaces).
//   [⧗] on the clock — awaiting a TIMER (muted hourglass), in the queue or parked in Snoozed alike; the
//                     Snoozed band's other parks wear the mark of what they wait on (the octocat for a
//                     PR, the dot for a shell). See hourglassMark.
//   [⏰] snoozed     — the human's OWN wall-clock park (muted alarm clock): the one wait the operator
//                     set rather than the worker, and the one that rings for THEM. See alarmMark.
//   [✓] done        — a ```done fence at rest, OR an archived thread (muted check — NOTHING else)
//   […] at rest     — an ordinary rest with no concrete ask, INCLUDING a queued thread whose own
//                     dispatched sub-agents are still running (they spin on their own child rows)
// Attention (needs-input / stalled) wears the accent; everything else is muted.
/** Shared mark and state description: desktop uses a hover tooltip, mobile speaks the state as its
 *  accessible label. Tests can also pin the text directly without opening a tooltip. */
export function sessionIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  const base = sessionStateIndicatorFor(t)
  // The tooltip is now the ONLY place a snooze is legible on the rail (the subtitle no longer names it),
  // so it has to say so on every parked row — not just the ones the park actually quiets. The alarm-clock
  // arm below already tells that story for a Snoozed row. These are the rows a snooze does NOT silence:
  // one whose own turn is running, and one still waiting on a sub-agent it dispatched. Each keeps its
  // live glyph — MOTION is a fact about the process that a park does not change — and gains a second
  // line saying when the park takes effect.
  // A CONCRETE ASK USED TO BE THE THIRD such row, and it was the one case where the rail lied: the
  // server dequeues a user-snoozed thread before it ever reaches its ask gates (deriveNeedsYou), so the
  // [?] pointed at a card that did not exist on any surface (2026-08-31 — see sessionIndicatorKind). It
  // takes the alarm clock now, and that arm names the ask the park is holding.
  if (sessionIndicatorKind(t) === "snoozed") return base
  const snoozedUntil = futureSnoozedUntil(t)
  const parked = snoozedUntil ? formatUserSnooze(snoozedUntil, t.snoozePrompt) : null
  if (!parked) return base
  return { node: base.node, tip: stackParked(base.tip, parked) }
}

/** A snooze stacks under the row's STATE, never under the worker's own prose.
 *
 *  That prose is a PARAGRAPH — see `popover`, which sets it off with a blank line precisely so a wrapped
 *  state sentence and a human one cannot be read as one run of lines. Appending the park to the end
 *  would land it inside that paragraph and undo exactly that. */
function stackParked(tip: string | null, parked: string): string {
  if (!tip) return parked
  const [state, ...reason] = tip.split("\n\n")
  return [`${state}\n${parked}`, ...reason].join("\n\n")
}

// THE ONE MARK FOR "A BACKGROUND SHELL IS ALIVE BEHIND THIS ROW" — the same blue and the same pulse as
// the transcript's live-shell dot, sized to this box (styles.css .frizz-rail-dot), so both surfaces say
// it in one language. It is drawn by BOTH background arms below, and that is the whole point: the
// Active one (`kind === "background"` — resting on a live shell, undimmed) and the parked one (the same
// thread after the human snoozed its resting card) are ONE fact about the process, and a park does not
// change it. The parked arm wore lucide's CircleDashed until 2026-08-31, which said only "waiting on
// something" — a generic mark for the one state the rail already had a specific one for (maintainer:
// "we use blue dots to represent background shells … if we're not using a blue dot for a thread that's
// awaiting a background shell, then what do we use it for?"). What separates the two is the BAND, which
// dims a snoozed row, and the tooltip, which names the park; the mark itself stays the shell's.
//
// THE DOT MUST NEVER CLAIM LIFE THAT IS NOT THERE (see restingOnLiveBackgroundWork's long note in
// groups.ts, where a green PR wearing this dot was the bug). It cannot here: every arm that draws it is
// already gated on the server's own `awaitingBackground` verdict — an honoured park, checked against
// telemetry the browser cannot see — so by the time either arm runs, the work behind it is live. The
// `agent` hint rides along on the shell's blue rather than the accent-yellow a sub-agent pulses
// elsewhere: in the Snoozed band it marks a sub-agent its worker called a WATCHER (`status: watching`,
// 2026-10-05) — the only shape that parks with a live child — and the child spins on its own row.
//
// SINCE 2026-09-20 THE DOT SITS INSIDE THE SPINNER AND NO LONGER PULSES. The maintainer's rule for the
// Running band is that every row spins and the mark inside says what is alive ("an empty square if the
// thread is actively running … a blue dot if there's a background shell, a solid, non-pulsing blue
// dot"). The motion moved from the dot to the frame: the spinner says "something will wake this", the
// solid dot says "it is a shell". The pulse was the dot's way of saying alive-not-moving while the box
// stood still; with the box tracing, a pulsing dot inside it would be two animations for one fact.
//
// AND SINCE 2026-10-05 THE FRAME SPINS ONLY IN THE RUNNING BAND. The same dot sits in the static box on a
// queued shell rest and in the Snoozed band (`restingShellDot`): a spinner there claimed the thread was
// working when its worker had stopped for the human or parked on a watcher (maintainer 2026-10-03:
// "it looks like it's actively working on stuff, but it's obviously not"). StatusBox and the spinner's
// children slot share one 13px content box, so the dot lands on the same pixels in both frames.
const shellDot = <BoxSpinner><span aria-hidden className="frizz-rail-dot" data-running-indicator="thread-background" /></BoxSpinner>
const restingShellDot = <StatusBox><span aria-hidden className="frizz-rail-dot" /></StatusBox>

// THE OCTOCAT IS THE ONE MARK IN THIS FAMILY WHOSE INK IS NOT CENTRED IN ITS OWN VIEWBOX, so it is the
// one that needs a correction rather than just an odd size. `items-center justify-center` centres the
// glyph's BOX in the 13px content box — which it does correctly — and the mark still reads left, because
// lucide's github path is asymmetric inside its 24-unit grid: the head/body/legs path is centred, but the
// TAIL sweeps out to x=1 while nothing balances it on the right, so the ink ends at 21.01 instead of 23.
//
// MEASURED as the four CLEARANCES between the ink and the box's inner edge, which is the reading that
// matches the complaint ("icon spacing is broken"). At the shipped 9px:
//
//   nudge              L      R      T      B     L−R     T−B
//   none             2.75   3.50   2.75   2.75   -0.75   0.00   ← the mark hugs the left wall
//   x only  (ships)  3.13   3.12   2.75   2.75   +0.01   0.00
//   x and y          3.13   3.12   3.13   2.38   +0.01  +0.75   ← rejected; see below
//
// ONE LUCIDE GRID UNIT, sideways only — `size / 24`, not a hand-fitted decimal. One unit is exactly what
// the geometry asks for (the ink bbox centre sits 0.99 units left of the box's 12), and deriving it from
// `size` means it survives a resize of the mark, which a pinned 0.375px would not.
//
// NO VERTICAL NUDGE, and this is the part worth keeping, because the obvious instrument argues for one.
// An intensity-weighted centroid reads the glyph 0.33px HIGH — the head is a thick closed loop while the
// legs beneath it are single strokes, so the mark's MASS genuinely sits above its middle. Correcting to
// that centroid moves the whole glyph down and turns a vertical clearance that was exactly balanced
// (2.75 / 2.75) into 3.13 / 2.38: the legs then crowd the bottom wall while the ears gain a gap, which
// is the same defect being fixed sideways, recreated on the other axis. The top-heaviness is intrinsic
// to the LOGO and cannot be translated away — only redistributed — so the bbox stays balanced and the
// residual mass offset stands. Rendered side by side at dsf 8 the untouched vertical is plainly better.
const PR_MARK_SIZE = 9
const PR_MARK_NUDGE = PR_MARK_SIZE / 24

// THE ONE MARK FOR "THIS THREAD IS WAITING ON A PULL REQUEST", drawn by both arms that can reach that
// state — the parked one in the Snoozed band and the queued one below it — for the same reason shellDot
// is shared: the PR is the fact, and which band the row happens to sit in is only how it is presented
// (maintainer 2026-09-04: "the GitHub icon should show up anytime that an agent is awaiting a PR").
//
// The glyph alone, so the same octocat can sit inside the static box (settled checks) and inside the
// spinner (checks running) — one glyph, two frames; see the `pr` arm.
const githubGlyph = <Github size={PR_MARK_SIZE} className="text-muted-70" style={{ transform: `translateX(${PR_MARK_NUDGE}px)` }} />
const githubMark = <StatusBox>{githubGlyph}</StatusBox>

// The at-rest ellipsis, alone, for the same reason: the bare-rest arm draws it in the static box, and
// since 2026-09-20 the `working` arm draws it inside the spinner for a parent resting on its sub-agents.
const ellipsisGlyph = <Ellipsis size={11} className="text-muted-70" />

// THE ONE MARK FOR "THIS THREAD IS PARKED ON THE CLOCK" — the muted hourglass, drawn by every arm whose
// row is waiting for an instant the WORKER set: a park with no fence to read, and since 2026-09-07 a
// wait on a TIMER in whichever band it sits. (A user snooze wore it too until 2026-09-19; it is the
// alarm clock below now.) A timer park QUEUES (board.deriveNeedsYou
// keeps it a visible handoff), so most timer waits live below the rule in the Rested band, and there the
// row wore the shell's blue dot — groups.restingOnLiveBackgroundWork counted an armed timer as motion —
// while the SAME wait parked in Snoozed drew lucide's Clock. Three readings of one fact (maintainer:
// "an item in the queue that's awaiting a timer should show up with the hourglass icon in the sidebar,
// not with the flashing blue dot"). The clock is gone with it: the rail already had a word for "on the
// clock", and the limit kill's accent hourglass is this same glyph in the attention colour, so the
// family stays one glyph in two tones rather than two glyphs for one idea.
const hourglassMark = <StatusBox><Hourglass size={9} className="text-muted-70" /></StatusBox>

// THE ONE MARK FOR "THE HUMAN SNOOZED THIS" — the muted alarm clock, on the row whose park the OPERATOR
// set on a wall clock (futureSnoozedUntil), whether it re-surfaces the card or resumes the worker with a
// prompt. Until 2026-09-19 it wore the hourglass above, which made the operator's own park read as one
// more of the worker's timer waits (maintainer: "something that's snoozed … switch it over to some kind of
// icon that's like Zs, or an alarm clock"). An alarm is the snooze metaphor everyone already carries, and
// lucide has no Zs. Size 9, like the hourglass: the box's content is 13px, so only an ODD size centres
// on a whole pixel, and 11 would put the clock's bells and feet — which reach its viewBox edge — over
// the 0.62 extent ceiling the family holds to. The verify script has the readings
// (scripts/verify-rail-status-glyphs.mjs, the `user-snoozed` slot).
const alarmMark = <StatusBox><AlarmClock size={9} className="text-muted/70" /></StatusBox>

/** "fires in 34m" for the SOONEST armed timer — the resting card's TimerRow countdown, so the rail's
 *  hover and the card never count down in two vocabularies. The row drops the verb its "Timers" heading
 *  implies ("in 34m"); this tooltip is a sentence with no heading, so it keeps it. A due-but-undelivered
 *  timer (the scheduler's tick runs seconds behind the instant) says "firing…" rather than a negative
 *  countdown. Null when no armed row carries an instant, which today is never — the board only
 *  synthesizes armed rows, each with one. */
function timerWake(t: Pick<ThreadView, "watches">, nowMs = Date.now()): string | null {
  const soonest = (t.watches ?? [])
    .filter((w) => w.kind === "timer" && w.state === "armed")
    .map((w) => Date.parse(w.timer?.fireAt ?? ""))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b)[0]
  if (soonest === undefined) return null
  return soonest > nowMs ? `fires in ${formatCompactElapsed(soonest - nowMs)}` : "firing…"
}

function sessionStateIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  const kind = sessionIndicatorKind(t)
  if (kind === "archived") return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted-75" /></StatusBox>, tip: "Done" }
  if (kind === "needs-input") {
    // Muted "?", same gray as every other glyph — a needs-you thread already carries maximum emphasis
    // by sitting in the ⚖ queue, so the rail indicator adds NO extra color (maintainer 2026-07-10).
    return { node: <StatusBox><Glyph ch="?" muted /></StatusBox>, tip: "Needs your input" }
  }
  if (kind === "working") {
    // A PARENT AT REST WITH ITS SUB-AGENTS OUT spins with the ellipsis inside (2026-09-20): the spinner
    // says a child's return will re-invoke it, the ellipsis says the parent itself has stopped. Same
    // kind, same band — only the mark inside changes — because the motion is real either way and the
    // kind is what offersRetry and the band read. A thread whose own turn is running keeps the empty box.
    // A REGISTERED QUESTION STILL OPEN puts the "?" in that frame instead (groups.workingWithOpenQuestion,
    // 2026-10-08): the worker kept going after it asked, and the answer would steer what it does next.
    if (workingWithOpenQuestion(t)) return { node: <BoxSpinner><Glyph ch="?" muted /></BoxSpinner>, tip: "Working — a question is waiting on your answer" }
    if (restingOnSubAgents(t)) return { node: <BoxSpinner>{ellipsisGlyph}</BoxSpinner>, tip: "At rest — waiting on its sub-agents" }
    return { node: <BoxSpinner />, tip: "Working" }
  }
  // The thread has stopped and only a shell it launched is still running. The mark is the solid blue dot
  // — inside the spinner when its worker called the rest `working`, in the static box when the row is in
  // the queue; see shellDot for why one dot serves every band.
  if (kind === "background") {
    // The fence, when there is one, names the shell itself (and any PR riding beside it), so the lead
    // drops to a bare "At rest" rather than saying "a background shell" twice in one sentence.
    const fenced = t.lastFence?.kind === "awaiting" && awaitingWaitClause(t.lastFence.hints) !== null
    return {
      node: restIsWorking(t) ? shellDot : restingShellDot,
      tip: popover(t, fenced ? "At rest" : "At rest — a background shell is still running"),
    }
  }
  if (kind === "done") return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted-75" /></StatusBox>, tip: "Done" }
  if (kind === "stalled") {
    // ONE mark for "the process is gone". The server's `crashed` bit (exited AND turn-in-flight/live
    // background work) no longer gates the mark — it only picks the wording, so the tooltip still tells
    // you HOW it stopped while the glyph and the Retry verb treat both stops identically.
    const tip = t.crashed === true ? "Stalled — the agent exited mid-turn" : "Stalled — the agent's process exited"
    return { node: <StatusBox accent><Glyph ch="!" /></StatusBox>, tip }
  }
  if (kind === "limit") {
    // KILLED BY A USAGE LIMIT, auto-resume promised — the rail's OTHER yellow mark (2026-08-31). Accent
    // like the stalled [!] because both are dead threads carrying the same one-click Retry (offersRetry;
    // maintainer: every yellow row gets the hover Retry), but the glyph stays the hourglass because this
    // one has a wake frizz itself delivers. Until 2026-08-31 it wore the MUTED hourglass in the Snoozed
    // band, which read as a calm intentional park over a whole limit-killed fleet (maintainer: "they
    // showed up and fucking snoozed"). The tip mirrors the drawer's LimitPauseCard word for word, so the
    // rail and the card can never tell two stories about one thread.
    const p = t.limitPause
    const which = p?.window === "weekly" ? "weekly limit" : p?.window === "session" ? "5-hour limit" : "usage limit"
    // The auto-resume promise is the server's word (resolveLimitPause keeps it truthful — an unknown
    // window has no wake), so the tip splits on it: a promised wake names its clock, an unpromised one
    // says plainly that Retry is the way back.
    const resume = p?.autoResume
      ? p.resumesAt ? `continuing automatically at ${limitResumeClock(p.resumesAt)}` : "continuing automatically once the window resets"
      : "won't resume by itself — Retry to continue"
    return {
      node: <StatusBox accent><Hourglass size={9} className="text-accent" /></StatusBox>,
      tip: `Paused by the ${p?.backend === "codex" ? "Codex" : "Claude"} ${which} — ${resume}`,
    }
  }
  // AWAITING A PR, IN THE QUEUE — the same octocat the Snoozed arm draws, on the rows that never park.
  // A PR wait deliberately stays a visible queue handoff (parkedAwaitingHint excludes it), so this is
  // where MOST PR waits actually live, and until 2026-09-04 every one of them wore either the shell's
  // blue dot (checks still running) or the bare-rest ellipsis (checks settled). The tooltip is the
  // fence's own clause, which names the ref — "waiting on acme/app#391" — so the hover reaches the PR.
  // THE OCTOCAT SPINS ON A `working` REST (2026-09-20 for running checks; 2026-10-05 for the rule). CI
  // running is the PR reading that is motion with a known end, so the server reads it as `working` and
  // holds such a thread in the Running band (board.deriveWaitStatus); the row wears the spinner around
  // GitHub's mark there, and the static octocat in the queue — checks or no checks, a queued row never
  // spins. A gated PR is not motion (the server's ciInMotion refuses it), so an approval gate never spins.
  if (kind === "pr") {
    const tip = popover(t, prChecksRunning(t) ? "At rest — checks are running" : "At rest")
    return restIsWorking(t) ? { node: <BoxSpinner>{githubGlyph}</BoxSpinner>, tip } : { node: githubMark, tip }
  }
  // AWAITING A TIMER, IN THE QUEUE — the same hourglass the Snoozed arm draws, on the rows that never
  // park. A timer park queues (board.deriveNeedsYou), so this is where MOST timer waits actually live,
  // and until 2026-09-07 every one of them wore the shell's blue dot (groups.awaitingTimerWatch carries
  // the report). The tooltip says what is waited on and WHEN: the fence's own clause where there is one
  // ("waiting on a timer and a background shell"), a synthesized one for a worker that registered the
  // timer and rested without fencing, and the countdown either way — the one thing about this row the
  // rail cannot show, and what the operator most wants on hover.
  if (kind === "timer") {
    const fenced = t.lastFence?.kind === "awaiting" && awaitingWaitClause(t.lastFence.hints) !== null
    return { node: hourglassMark, tip: popover(t, fenced ? "At rest" : "At rest — waiting on a timer", timerWake(t)) }
  }
  if (kind === "snoozed") {
    const hourglass = hourglassMark
    const github = githubMark
    // A snoozed row whose fence names a PR (`prs:` since the 2026-08-24 YAML cutover; `pr:` and `pr-watch:`
    // before it, both retired) is snoozed FOR A PR, and the rail says so with GitHub's mark instead of the
    // clock. The alarm clock means "the human parked this until an instant", and for a watch the clock is only the
    // backstop: the scheduler polls the PR and CLEARS the park the moment new activity lands
    // (scheduler.ts, the clear-snooze-on-PR-wake), so what actually wakes this row is GitHub. A PR wait
    // never parks itself — parkedAwaitingHint excludes it so a watch stays a visible queue handoff — so
    // the rows that reach here are the ones parked ANYWAY: one the human snoozed on a wall clock, and,
    // until the 2026-08-15 grammar deleted the kind, one whose worker co-declared a `human:` gate
    // beside the watch — and, since 2026-08-28, one the human snoozed off the RESTING card (the
    // event-snooze that replaced the awaiting card's own "PR watcher armed" Snooze on 2026-08-13; it
    // dropped the queue card without parking the thread until isSnoozed learned to read `bgSnoozed`).
    // All were previously indistinguishable from a plain timer park.
    // ONE answer to "does this wait name a PR", shared with the queued arm below (groups.waitNamesPr).
    // It reads the REGISTERED watch as well as the fence, so a row parked on a watch it never fenced
    // stops wearing the clock — the fence-only reading was why the mark looked like a property of the
    // Snoozed band rather than of the wait.
    const parkMark = waitNamesPr(t) ? github : alarmMark
    // A snoozed row carries its whole "what it is waiting for" story HERE, in the popover — the rail row itself
    // is a title and nothing else. The two time-based holds are ONE concept — a snooze (park until a wall-clock instant) — sharing the same
    // parkMark + single-line layout. They differ only in WHO resolves the park at the deadline, which
    // the tooltip wording marks as an `auto` variant of the same word rather than a separate idea:
    //   • a user snooze re-surfaces the CARD for you  → "Snoozed until <wake>"       (you act next)
    //   • an ```awaiting park naming a timer / blocked+timer status auto-resumes the agent → "Auto-snoozed until <wake>"
    // A user snooze that carries a PROMPT crosses that line by design — frizz resumes the agent with it —
    // so formatUserSnooze reads it as the auto variant and names the follow-up it will send.
    const snoozedUntil = futureSnoozedUntil(t)
    if (snoozedUntil) {
      const parked = formatUserSnooze(snoozedUntil, t.snoozePrompt) ?? "Snoozed until a scheduled check"
      // …AND WHAT THE PARK IS HOLDING, when it is holding an ask. A user snooze takes this row out of the
      // queue server-side, so its card — the only surface that renders a question — is gone until the
      // wake. The mark can no longer say [?] (it would advertise a card nobody can open), so the tooltip
      // is where the unanswered ask stays legible until then.
      const asking = (t.questions?.length ?? 0) > 0 || t.pendingQuestion === true || Boolean(t.pendingAsk)
      return { node: parkMark, tip: popover(t, asking ? `${parked}\nA question is unanswered behind this park` : parked) }
    }
    // A usage-limit park is NOT in this family any more (2026-08-31): a limit kill queues as a failed
    // thread and wears the yellow "limit" mark above. What still reaches this arm with a limitPause set
    // is only a row the OPERATOR also snoozed, and their park is the story the row tells.
    // THE RESTING CARD'S EVENT-SNOOZE (isSnoozed, 2026-08-28). No instant to name: it expires by itself
    // the moment the thread next comes to rest, which is when the work it hid has reported back — so
    // the state reads the way the card's own toast did when it was clicked. A fence, when there is
    // one, still supplies the clause and the glyph below; a shell-only rest has no fence, and its snooze
    // wears the shell's blue dot rather than the hourglass, because nothing here is on a clock.
    //
    // "Snoozed until activity" since 2026-10-19, when the header's snooze menu began arming the same park
    // on any rested thread under that name — one park, one name in the header and here. It read "until
    // the background work returns" before, which a thread parked on a Goal alone has none of.
    const eventSnoozed = t.bgSnoozed === true ? "Snoozed until activity" : null
    // Canonical blocked+timer status can arrive from an older/pre-session snapshot without a fence.
    if (t.lastFence?.kind !== "awaiting") {
      // The event-snooze reaches here for a rest on a shell, a timer, a registered PR watch OR — from the
      // header — a Goal alone, and only the first of those is live work. The dot is for a running shell or
      // sub-agent; anything else that will end the park is a wake frizz delivers, and the row wears the
      // human's own alarm clock rather than a dot claiming something is running.
      if (eventSnoozed) {
        const live = (t.bgShells ?? []).some((s) => s.state === "running") || hasLiveSubAgents(t)
        return { node: waitNamesPr(t) ? github : live ? restingShellDot : alarmMark, tip: eventSnoozed }
      }
      // A `watching` REST WITH NO FENCE TO READ (2026-10-05): a worker that rested behind a watch it
      // registered, which the board reads as a watcher. The mark is the watch's own, as above.
      if (t.waitStatus === "watching") {
        const shell = (t.bgShells ?? []).some((s) => s.state === "running")
        return { node: waitNamesPr(t) ? github : shell ? restingShellDot : hourglass, tip: "Snoozed until its watch reports back" }
      }
      const timed = typeof t.revalidate === "string" ? formatAutoSnoozedUntil(t.revalidate) : null
      return { node: hourglass, tip: timed ?? "Auto-snoozed until a scheduled check" }
    }
    // Reserve the park mark (hourglass, or GitHub when a watch is riding along) for intentional park
    // states: a durable GitHub review cursor, the thread's own live work, or a VALID scheduled instant.
    // NO HINT KIND PARKS ON ITS OWN. `human:` and `timer: <instant>` each drew the Snoozed mark from the
    // worker's assertion alone; both are deleted (2026-08-15) and the server now decides Snoozed from a
    // checked declaration. What is left to draw is the SHAPE of the wait.
    const hk = t.lastFence.hints.find((h) => h.kind === "pr" || h.kind === "issue" || h.kind === "shell" || h.kind === "agent" || h.kind === "timer")?.kind
    // The tooltip's WORDS come from the fence itself (popover → awaitingWaitClause), which names the
    // things it parked on; the arms below only pick the GLYPH that matches the leading kind. They used
    // to say the shape in prose too — "Waiting on its own background work" — which restated vaguely
    // what the clause says exactly ("waiting on 2 background shells and a timer"), and was the only
    // place the popover's text was hand-written per arm instead of derived.
    // A PR IN THE WAIT WINS THE GLYPH OUTRIGHT — it is no longer one of the leading-kind arms. `hk`
    // reads the FIRST hint the worker happened to write, so a fence naming a shell before its PR drew
    // the shell's dot for a wait GitHub resolves; the same wait written the other way round drew the
    // octocat. One state, two marks, decided by fence order. The kinds below still rank among
    // themselves, because none of them is the subject of the wait the way a PR is.
    // A TIMER — or a fence naming nothing the rail draws a shape for — is "parked on the clock", and
    // wears the hourglass. It drew lucide's Clock until 2026-09-07, when the queued timer wait two arms
    // up took the hourglass and the parked one had to match it: one wait, one mark (see hourglassMark).
    const mark = waitNamesPr(t)
      ? github
      : hk === "shell" || hk === "agent"
        ? restingShellDot
        : hourglass
    return { node: mark, tip: popover(t, eventSnoozed ?? "Snoozed", hk === "timer" ? timerWake(t) : null) }
  }
  // At rest (no fence, nothing pending) with the process still ALIVE — a worker that came to rest
  // WITHOUT declaring done or a machine-wait, and with NOTHING it launched still running (that is the
  // pulsing dot above). (An exited one is `stalled` above; this ellipsis is now honestly reserved for a
  // session you can still just type at.) Read it as WAITING
  // (maintainer 2026-07-10: a rested-not-done thread "should be blocked or waiting", never a stark
  // empty box and never a false check). We don't know the reason — the worker didn't fence — so: no
  // hint gloss (vs an ```awaiting fence, which names what it waits on AND dims + sinks the row). The
  // honest fix is the worker emitting ` ```awaiting ` when it's blocked on a machine.
  // RESTED AND AWAITING lands here whenever the park is not Snoozed — the fence declared a wait but frizz
  // could not honour it (an item that is not running, no `for:`), so the row stays in the queue wearing
  // the ordinary at-rest mark. That row is exactly where the worker's own prose earns its place: the
  // glyph says "at rest" and the popover says what it thinks it is waiting for, which is the one thing
  // the rail cannot show and the operator most wants on hover (maintainer 2026-08-16).
  return {
    node: <StatusBox>{ellipsisGlyph}</StatusBox>,
    tip: popover(t, "At rest"),
  }
}

// THE shared rounded-rect checkbox — the ONE outer shape every status glyph sits in. Its size and the
// spinner that traces it live in ./BoxSpinner.tsx, because the indented child rows (ChildOpRow, "rail"
// density) draw the same spinner and must not import their own parent module to get it.
function StatusBox({ accent, children }: { accent?: boolean; children?: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-[4px] border ${accent ? "border-accent/90" : "border-muted/45"}`}
      style={{ width: STATUS_BOX, height: STATUS_BOX }}
    >
      {children}
    </span>
  )
}
// A bold single-char glyph (?, !) centered in the box. Accent by default; `muted` renders it the same
// gray as every other rail glyph (the "?" needs-you mark — the ⚖ queue already carries the emphasis).
function Glyph({ ch, muted }: { ch: string; muted?: boolean }) {
  return (
    <span
      aria-hidden
      // `frizz-rail-glyph` trims the span to the glyph's own cap band, so the box centres its INK rather
      // than its em box — the correction is the BROWSER's, holds in both of this app's fonts, and lives
      // with its readings in styles.css. It replaced `translateY(0.09em)`, a constant fitted on a fixture
      // that silently rendered mono while the app runs sans, which left both marks ~1.4px low on screen.
      className={`frizz-rail-glyph font-bold leading-none ${muted ? "text-muted-70" : "text-accent"}`}
      style={{ fontSize: 10 }}
    >
      {ch}
    </span>
  )
}
// The LEGACY (.frizz status) row indicator — the vestigial status-keyed logic, kept only for the
// read-only Legacy shelf.
function legacyIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  if (t.runtime === "running" || t.runtime === "spawning" || t.runtime === "perm-prompt") return { node: <Spinner />, tip: "Working" }
  const liveSub = (t.subAgents ?? []).some((s) => s.state === "running")
  if (t.runtime === "turn-idle" && liveSub && !t.humanBlocked) return { node: <Spinner />, tip: "Working" }
  if (needsAction(t)) return { node: <BlueDot />, tip: "Needs your input" }
  if (t.status === "needs-human") return { node: <YellowDot />, tip: "Awaiting you — open to read & reply" }
  if (t.status === "blocked" && t.mechanism === "timer") return { node: <Timer size={INDICATOR + 1} className="text-muted-70" />, tip: "Waiting on a timer" }
  if (t.status === "blocked" && t.mechanism === "threads") return { node: <CircleDashed size={INDICATOR + 1} className="text-muted-70" />, tip: "Waiting on other work" }
  return { node: <FaintDot />, tip: null }
}

function Spinner() {
  return (
    <span
      // Matches the sub-agent child-row spinner EXACTLY (8px, 1px border) — the maintainer converged
      // the two after the top-level spinner (was 7px/1.5px) read visibly smaller than the sub-agent's.
      className="block rounded-full border border-muted/70 border-t-transparent animate-spin"
      style={{ width: 8, height: 8 }}
    />
  )
}

// THE attention mark — needs-you at rest. The signature accent (#e8b923) at full strength with a
// soft halo: the app spends its yellow in exactly one place, and this is it. Larger than the machine
// glyphs so it wins the row at a glance.
function AccentDot() {
  return (
    <span
      className="block rounded-full bg-accent shadow-[0_0_5px_color-mix(in_srgb,var(--color-accent)_45%,transparent)]"
      style={{ width: ATTENTION, height: ATTENTION }}
    />
  )
}

function BlueDot() {
  return <span className="block rounded-full bg-planning" style={{ width: INDICATOR, height: INDICATOR }} />
}

// Awaiting-you without a queue card (legacy session-less needs-human): the status palette's yellow.
function YellowDot() {
  return <span className="block rounded-full bg-needs-human" style={{ width: INDICATOR, height: INDICATOR }} />
}

function FaintDot() {
  return <span className="block rounded-full bg-muted/30" style={{ width: INDICATOR, height: INDICATOR }} />
}

// THE PROJECT IDENTITY, derived only from the currently adopted board keyframe. There is no
// session/local-storage cache: keeping a stale owner/repo while another project or boot is becoming
// authoritative is worse than showing the small neutral reservation. A transport reset leaves the
// adopted board in the store, so a normal reconnect keeps its known identity in place.
//
// It LIVES here rather than in StatusRow because the rail derives from the same board and this file
// already owns that derivation; StatusRow (which draws it, at the right edge of the row above the
// prompt box) is the only consumer. The IdentityMark COMPONENT that used to sit beside this — the
// home crumb, the name and the connection word as one cluster — is gone with the corner bar it was
// laid out for: the row now places those three at two different ends, so there was nothing left for
// one component to hold together.
export type ProjectIdentity =
  | { state: "loading" }
  | { state: "unavailable" }
  /**
   * A repo with NO ORIGIN REMOTE (or one whose URL yields no owner/repo). There is no owner half to
   * show and there never will be, so this is a settled answer, not a pending one — `local` exists to
   * keep it from wearing the loading skeleton forever. The name is the directory basename, which is
   * what the server already falls back to for `projectLabel`.
   */
  | { state: "local"; name: string }
  | { state: "verified"; label: string; owner: string; repo: string }

export function projectIdentity(
  board: (Pick<BoardSnapshot, "projectLabel"> & Partial<Pick<BoardSnapshot, "projectName">>) | null | undefined,
): ProjectIdentity {
  if (!board) return { state: "loading" }
  // A board WITHOUT a projectLabel is not a crash. The field is required on the wire, so this only
  // guards a board keyframe that arrived partial — but the identity renders inside the SIDEBAR COLUMN
  // rather than as detached corner chrome, so a throw here takes the whole rail (and the prompt box
  // with it) rather than one line of chrome. Caught the moment StatusRow moved: every fixture that
  // seeds a board without a label crashed on `.trim()` of undefined.
  const label = board.projectLabel?.trim() ?? ""
  const cut = label.lastIndexOf("/")
  const owner = cut === -1 ? "" : label.slice(0, cut).trim()
  const repo = cut === -1 ? "" : label.slice(cut + 1).trim()
  if (owner && repo) return { state: "verified", label, owner, repo }
  // NO OWNER/REPO — a local-only git repo with no origin remote, which is an ANSWER and must read as
  // one. `projectLabel` deliberately falls back to the directory basename in that case, and this used
  // to fold that fallback into "unavailable": the row then rendered the cold loading skeleton, and
  // kept rendering it, because no keyframe was ever going to resolve into an owner/repo (maintainer
  // 2026-08-19: "it just shows a skeleton forever"). It still must not GUESS an owner — there is
  // simply nothing to guess, and the directory name is a fact the server already computed.
  const name = label || board.projectName?.trim() || ""
  if (name) return { state: "local", name }
  // Nothing nameable at all. Only reachable from a keyframe carrying neither field, which is a broken
  // server rather than a project shape — the placeholder is honest there because something IS missing.
  return { state: "unavailable" }
}
