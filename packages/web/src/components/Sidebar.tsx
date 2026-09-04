import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useSnapshot } from "valtio"
import { Check, ChevronRight, CircleDashed, Clock, Ellipsis, Github, Hourglass, Loader2, Pin, PinOff, RotateCcw, Timer } from "lucide-react"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { store, openThread, scrollToQueueCard, queueCardTargetY, pushSubAgentDrawer, showToast, QUEUE_CARD_VIEWPORT_TOP } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useBoard, asThreads } from "../hooks.ts"
import { prefs } from "../lib/prefs.ts"
import { sectionThreads, externalThreads, orderByInteraction, partitionActive, needsAction, displayTitle, titleIsProvisional, isPinned, isSnoozed, parkedAwaitingHint, sessionIndicatorKind, offersRetry, futureSnoozedUntil, lastActiveLabelAt, waitNamesPr } from "../groups.ts"
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
import { awaitingProse, awaitingWaitClause } from "../lib/awaitingPresentation.ts"
import { useOptimisticallySteered } from "../lib/steering.ts"
import { useOptimisticallyArchived } from "../lib/optimisticArchive.ts"
import { activeSidebarSection, queueNavigationSettled, railRevealDelta, type SidebarSectionGeometry } from "../lib/sidebarScrollspy.ts"
import type { ReactElement, ReactNode, RefObject } from "react"

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
const ROW_ACTION_CLASS = "flex h-[19px] w-[19px] items-center justify-center rounded text-muted/70 outline-none transition-colors hover:bg-panel-2 hover:text-fg"

export const SIDEBAR_COLUMN_CLASS =
  "sticky top-0 self-start h-screen w-[clamp(272px,34vw,680px)] shrink-0 flex flex-col justify-center max-[800px]:static max-[800px]:h-auto max-[800px]:w-full max-[800px]:justify-start max-[800px]:pt-16"

export function Sidebar() {
  const snap = useSnapshot(store)
  const board = useBoard()
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
  const all = useOptimisticallyArchived(useOptimisticallySteered(asThreads(board?.threads ?? [])))
  const sections = sectionThreads(all, useSnapshot(prefs).queueOrder)
  // Its own partition, deliberately NOT a SectionKey: sectionThreads drops external rows entirely, and
  // that stays true — an external session must never be able to land in Active, Snoozed or Done by
  // accident. This band is the only place they render, and they leave it by being STEERED, not by
  // being re-sorted.
  // Ordered by the SAME key the rest of the rail uses, so the rest-time column reads monotonically down
  // the band. It cannot be left to discovery order: the tailer returns these ids by file MTIME, while
  // the label prints the agent's own last output — two clocks that disagree whenever a transcript is
  // touched without the agent speaking (a resume that writes a header, a copy, a restore).
  const externalSessions = orderByInteraction(externalThreads(all))
  const collapsed = snap.sidebarCollapsed
  const activeThreads = sections.active
  const heldThreads = sections.snoozed
  const inactiveThreads = sections.inactive
  const railRef = useRef<HTMLDivElement>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  // A click-to-card navigation in flight: the row that was clicked, plus where its scroll landed. Both
  // halves matter — see the release conditions in syncActiveSection.
  const pendingNavigation = useRef<{ id: string; landedY: number } | null>(null)

  const syncActiveSection = useCallback(() => {
    const items = [...document.querySelectorAll<HTMLElement>("[data-queue-card][data-queue-leaving=\"false\"]")]
      .map((element) => {
        const id = element.dataset.queueCard
        if (!id) return null
        // The BORDERED ROOT, not the slot: the slot is the fade wrapper and also spans the root's
        // bottom scroll-reserve margin, and the reading rule below is decided by how much of a CARD is
        // on screen.
        const card = element.querySelector<HTMLElement>("[data-queue-card-root]") ?? element
        const { top, bottom } = card.getBoundingClientRect()
        return { id, top, bottom } satisfies SidebarSectionGeometry
      })
      .filter((item): item is SidebarSectionGeometry => item !== null)
    const pending = pendingNavigation.current
    if (pending) {
      const target = items.find((item) => item.id === pending.id)
      if (queueNavigationSettled(target, window.scrollY, pending.landedY, QUEUE_CARD_VIEWPORT_TOP)) pendingNavigation.current = null
      else {
        setActiveId(pending.id)
        return
      }
    }
    const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    const atDocumentBottom = maxScrollY > 0 && window.scrollY >= maxScrollY - 1
    const nextActiveId = activeSidebarSection(items, window.innerHeight, atDocumentBottom)
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
  }, [syncActiveSection, snap.view, snap.drawers.length])

  // Reveal a newly active row inside the rail itself. Direct scrollTop adjustment is intentionally
  // local: Element.scrollIntoView could scroll the main document and steal the reader's position.
  useLayoutEffect(() => {
    const rail = railRef.current
    if (!rail || !activeId || window.matchMedia("(max-width: 800px)").matches) return
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

  return (
    // HEIGHT MODEL: a sticky, exactly viewport-height wrapper that CENTERS the inner column, which
    // grows fit-content to a near-flush cap and scrolls internally only past it. overflow-x is CLIPPED
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
    <aside className={SIDEBAR_COLUMN_CLASS}>
      {/* The content column FILLS the aside track (no narrow inner cap). Its cap reserves 16px top AND
          bottom (symmetric, so the column stays centred), and below it the column grows and then
          scrolls INTERNALLY. The reserve used to be 44px a side, holding open the band the FIXED
          status bar occupied in the page's top-left corner so a long thread list could not push the
          composer up underneath it. That bar is gone — its contents are the StatusRow at the top of
          this very column now — so the lane it needed goes with it and the rail gets the 56px back.
          Short boards are unaffected: they never reach the cap. */}
      <div className="flex max-h-[calc(100vh-32px)] min-h-0 min-w-0 w-full flex-col max-[800px]:max-h-none">
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
          <DispatchForm />
        </div>
        <div ref={railRef} data-sidebar-rail className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden max-[800px]:overflow-y-visible">
          {/* PINNED — the human's shelf, at the very top, above the cue (maintainer 2026-09-02, variant
              A of the pin mockups: unlabeled, each row wearing the small solid pin where the cue's rest
              time would sit). These rows are OUT of the band system entirely — sectionThreads diverts
              them before any band claims them, so a pinned thread stays here spinning, resting, snoozed
              or Done alike — and the band is ordered by the pin instants, oldest first, never by
              activity: it is an arrangement the human made, and nothing the threads do may shuffle it. */}
          {sections.pinned.length > 0 && (
            <section aria-label="Pinned">
              {sections.pinned.map((t) => (
                <div key={t.id}>
                  <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={navigateToQueueCard} />
                  <SubAgentRows t={t} />
                </div>
              ))}
              {/* The separating rule is drawn only when the Rested/Active section actually follows:
                  Snoozed, Done and External each draw their OWN rule above themselves, so drawing one
                  here too would double it whenever that section is empty. */}
              {activeThreads.length > 0 && <hr className="my-3 border-border/50" />}
            </section>
          )}
          {/* RESTED + ACTIVE — always shown, NEVER collapsible (you can't hide your queue or your live
              work), no label. Two rule-separated bands (see groups.ts orderActive/partitionActive):
              RESTED — the cue — sits FIRST, right under the prompt box (maintainer 2026-08-08), in the
              EXACT queue order, so the rail's top row is opposite the queue's top card and scrolling
              the queue walks the scroll marker straight down this rail. ACTIVE — live work that isn't
              waiting on you — runs BELOW the rule (an Active row has no queue card — the maintainer's
              ask: they don't render in the queue), so it stays glanceable without pushing the cue down.
              Only the cue's rows carry the rest-time column: it dates a HANDOFF, and a row that is
              still spinning has not made one. */}
          {activeThreads.length > 0 ? (
            (() => {
              const { running, rested } = partitionActive(activeThreads)
              const renderRow = (restedAge: boolean) => (t: ThreadView) => (
                <div key={t.id}>
                  <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={navigateToQueueCard} restedAge={restedAge} />
                  <SubAgentRows t={t} />
                </div>
              )
              return (
                <>
                  {rested.map(renderRow(true))}
                  {running.length > 0 && rested.length > 0 && <hr className="my-3 border-border/50" />}
                  {running.map(renderRow(false))}
                </>
              )
            })()
          ) : sections.pinned.length === 0 ? (
            // pl-5 matches ThreadRow's own content inset (its status-indicator column), so the
            // placeholder starts exactly where the rows it stands in for would — and lands within a
            // pixel of the Snoozed/Done labels, which clear the same width for their chevron. A
            // bare px-1.5 left it hanging 14px out at the rail's raw edge, alone against everything.
            // "open", not "active": this stands in for the Active AND Rested bands together, and it
            // renders only when BOTH are empty. Saying "no active threads" over a hidden queue would be
            // the same conflation the vocabulary above exists to stop. Suppressed under a pinned band —
            // the pinned rows ARE open threads, so the claim would be visibly false one band up.
            <div className="py-1 pl-5 pr-1.5 text-[11.5px] text-muted/50">No open threads</div>
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
              {!collapsed.snoozed &&
                heldThreads.map((t) => (
                  <div key={t.id}>
                    <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={navigateToQueueCard} />
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
              {/* The rest-time column is ON here, unlike Snoozed and Done. Every row in this band is by
                  definition at rest, so "how long ago" is the only thing that distinguishes them — it is
                  what tells you which terminal you wandered away from an hour ago and which one is from
                  last Tuesday. Snoozed rows carry their own hint gloss and Done rows are over; neither has
                  that problem. */}
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

// A section header: an optional collapse caret, the label, and the count. ONE source of truth for
// every band header (Snoozed, Done) so they can never visually drift apart again. Every band in
// the real rail is collapsible; omitting onToggle renders a static div with a caret-width spacer, so
// a header without a toggle (the QA fixtures' Active/Snoozed bands) still aligns with the rest.
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
      <span className="ml-1.5 tabular-nums text-muted/60">{count}</span>
    </>
  )
  const cls = "flex w-full items-center gap-1 px-1.5 py-1 text-[11px] uppercase tracking-wide text-muted/70"
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
}: {
  t: ThreadView
  legacy?: boolean
  active?: boolean
  onQueueNavigate?: (id: string) => void
  /** Show the right-justified rest-time column. The CUE's rows only — see RestedAge. */
  restedAge?: boolean
}) {
  const foreign = !legacy && t.foreign === true
  // Snoozed rows are uniformly grayed as a whole; provisional titles retain their local dim treatment.
  // A thread awaiting its OWN live sub-agent/Monitor is not Snoozed and stays fully active.
  const snoozed = !legacy && isSnoozed(t)
  const dimLabel = !legacy && titleIsProvisional(t)
  // The rows with an obvious single next action carry that verb INLINE, instead of making you open the
  // thread to find it. offersRetry (groups.ts) picks them: a STALLED row (the [!] mark — process
  // exited) AND a row KILLED by a usage limit frizz will auto-resume (the yellow hourglass — a faster
  // door to the in-drawer "Continue now" than waiting for the window). The queue card and drawer header
  // read the SAME helper, so no surface can disagree with the rail about which threads offer Retry.
  const canRestart = !legacy && offersRetry(t)
  // A pinned row wears the mark in its right-edge column AND places the unpin verb rightmost in the
  // hover strip; both read this one predicate so the two can never disagree.
  const pinned = !legacy && isPinned(t)
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
      className={`group relative flex min-w-0 items-start rounded-md transition-[color,opacity] after:pointer-events-none after:absolute after:inset-0 after:rounded-md after:bg-white/[0.04] after:opacity-0 after:transition-opacity hover:after:opacity-100 ${legacy ? "opacity-80" : snoozed ? "opacity-65 hover:opacity-90 focus-within:opacity-90" : ""}`}
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
          if (t.needsYou && scrollToQueueCard(t.id)) {
            onQueueNavigate?.(t.id)
            return
          }
          openThread(t.id)
        }}
        aria-current={active ? "location" : undefined}
        className="min-w-0 flex-1 flex items-start gap-2 pb-1 pl-5 pr-1.5 pt-1 text-left"
      >
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
            <span className={`min-w-0 flex-1 break-words text-[13px] leading-[19px] ${dimLabel ? "text-fg/50" : snoozed ? "text-fg/75" : "text-fg/90"}`}>
              <TitleWithTrailers title={displayTitle(t)}>
                {!legacy && <ProviderMark backend={t.backend} className="ml-1" />}
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
                    className="petite-caps ml-1.5 inline-block rounded border border-border/60 px-1 align-[2px] text-[9.5px] leading-[14px] text-muted/55"
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
            {/* A pinned row wears the small solid pin in this same right-edge column (the cue's
                rest-time spot — the approved mockup's variant A), and yields to the hover actions the
                same way the rest time does. Never both: the pinned band passes no restedAge. */}
            {pinned && !restedAge && <PinnedMark />}
          </span>
        </span>
      </button>
      {/* The Mark-as verb survives ONLY on legacy rows (a .frizz verb). Session lifecycle controls
          live in the thread footer. */}
      {legacy && (
        <div className="absolute right-1 top-1 hidden group-hover:flex items-stretch rounded-md bg-panel shadow-sm shadow-black/30">
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
              because it is the hover form of the mark in the row's right-edge column: the mark fades and
              the unpin appears where it was (maintainer 2026-09-03: "unpin button should be far right for
              pinned threads on hover"). Not on a foreign row: the server refuses to pin what it does not
              own, so no button rather than a throwing one. */}
          {/* MEASURED 2026-09-03 (scripts/ink-gaps.mjs on sidebar-pin-fixture, dsf 4): on the strip's
              uniform 2px gap the OUTLINE pin's ink sat 12px from the door where door→Retry read 10px and
              Retry→unpin 10.5px, because the pin is a narrow glyph (8×11 of ink in a 19px box, dead
              6/5) and the door's ink is inset too (dead 5/4). The pin's box is trimmed 2px on its door
              side so the strip reads ONE gap — pin→door 10px after the trim. The unpin needs no trim: it
              is the strip's last mark and its 11px ink already sits 10.5px from Retry. RE-MEASURE rather
              than re-guess if a glyph, its size or the gap changes. */}
          {!foreign && !pinned && <RowPinButton t={t} className="-mr-0.5" />}
          <ExpandThreadLink slug={t.id} size={12} className={ROW_ACTION_CLASS} />
          {canRestart && <RowRetryButton slug={t.id} />}
          {!foreign && pinned && <RowPinButton t={t} />}
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
      className={`shrink-0 tabular-nums text-[10.5px] leading-[19px] text-muted/55 ${
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

// THE PINNED ROW'S MARK — the small solid pin at the row's right edge, in the column the cue's rest
// time occupies, muted to that column's weight. An IN-FLOW flex item (like RestedAge, unlike the hover
// overlay) so a wrapping title breaks before it instead of running underneath, and it yields to the
// hover actions the same way the rest time yields to Retry. The pin stays FILLED but keeps its stroke:
// lucide's needle is a stroke-only line (`M12 17v5`) with no fill area, so strokeWidth 0 would erase it
// and leave a headless blob (measured on the pin mockup sheet, 2026-09-02).
//
// IT WEARS THE HOVER STRIP'S OWN BOX, and that is the whole point: `h-[19px] w-[19px]` centring a 12px
// glyph is exactly ROW_ACTION_CLASS's geometry, so the mark and the unpin button that replaces it on
// hover occupy the SAME 19px slot and the pin does not move — it only swaps for the slashed glyph
// (maintainer 2026-09-03: "it should be in the exact same place when you hover versus not hover").
// The two coincide BY CONSTRUCTION, in both app fonts, at every rail width:
//   HORIZONTAL — this box ends at the button's `pr-1.5` content edge and the strip is anchored
//     `right-1.5` on the same row, so both right edges land on the same x.
//   VERTICAL — `self-start` pins this box to the flex line's cross-start, which is the button's `pt-1`
//     content top; the strip's `top-1` is that same offset from the row. Neither reading depends on the
//     font's metrics, so nothing here needs re-fitting when the font setting flips.
// It replaced a hand-placed `relative top-[calc(5.5px - 0.5cap)]` that sat an 11px mark on the title's
// CAP band (0.01px residual in both fonts) — a better vertical in isolation, but its ink centre landed
// 4.00px RIGHT of the unpin's and 0.09px (sans) / 0.66px (mono) above it, so the glyph jumped every
// time the pointer arrived. This slot centres on the title's first LINE BOX instead, which is where the
// door and Retry have always sat; an absolutely positioned strip cannot reach the in-flow baseline the
// `cap` correction needs, so the whole slot agreeing beats one mark in it being sub-pixel more correct
// at rest. What that costs, measured: the resting pin's ink now ends 4.5px inside the rest time's,
// where the 11px mark ended 0.8px inside it — the hover square's own dead space, and the same inset the
// door already had.
//
// `-ml-1` is a layout trim, not spacing: this slot is 8px wider than the 11px mark it replaced, and
// without the trim the title's own box pays all of it. Giving 4px back leaves the ink gap from a filled
// title line to the pin at 14.0px, against 14.29px before this change.
function PinnedMark() {
  return (
    <span
      aria-hidden
      data-rail-pin-mark
      className="-ml-1 flex h-[19px] w-[19px] shrink-0 items-center justify-center self-start text-muted/55 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
    >
      <Pin size={12} fill="currentColor" />
    </span>
  )
}

// The pin/unpin verb — one of the row's hover actions (ThreadRow places it: left of the fullscreen door
// to pin, rightmost to unpin), on every row the server can pin: sessions frizz owns, in any state,
// because the pin deliberately outranks Done and Snoozed alike. THE FILL IS THE STATE: an outline pin
// offers to pin, and the solid body with the slash — the same solid pin the pinned row's mark wears —
// offers to unpin, so a filled pin anywhere on the rail means "pinned" and nothing else (maintainer
// 2026-09-02: "use the solid pin icon to make sure that the icons are consistent everywhere";
// 2026-09-03: "the pin icon should be unfilled for unpinned threads").
function RowPinButton({ t, className = "" }: { t: ThreadView; className?: string }) {
  const pinned = isPinned(t)
  const [busy, setBusy] = useState(false)
  return (
    <Tooltip label={pinned ? "Unpin — return this thread to the rail's bands" : "Pin — keep this thread at the very top"}>
      <button
        data-sidebar-pin={t.id}
        aria-label={pinned ? "Unpin thread" : "Pin thread"}
        disabled={busy}
        // Same two guards as Retry: keep DOM focus off the button so the hover reveal doesn't outlive
        // the pointer, and stop the press from reaching the row (which would also open the thread).
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          setBusy(true)
          rpc
            .setThreadPinned({ slug: t.id, sessionId: t.sessionId ?? "", pinned: !pinned })
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
function SubAgentRows({ t }: { t: ThreadView }) {
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
function popover(t: Pick<ThreadView, "lastFence">, state: string | null): string {
  const hints = t.lastFence?.kind === "awaiting" ? t.lastFence.hints : []
  const wait = awaitingWaitClause(hints)
  const head = [state, wait].filter((part) => Boolean(part)).join(" — ")
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
//                     turn, or a live SUB-AGENT whose return will re-invoke it. Both are real motion.
//   [•] background  — at rest with only a detached background SHELL still running (never a sub-agent —
//                     maintainer 2026-08-01). Nothing is coming back, so nothing spins; the pulsing blue
//                     dot says "alive, not moving". The row holds its place in the running band — and
//                     keeps this same dot once the human snoozes its card into the Snoozed band, because
//                     the shell is the fact and the park is only how the row is presented (see shellDot).
//   [?] needs input — a question / native ask / permission prompt (accent box + "?")
//   [!] stalled     — the agent's PROCESS EXITED with the work unfinished (accent box + "!"), whether
//                     it died mid-turn or exited after resting without a done fence. Same mark either
//                     way, because the next action is the same: Retry. Exactly the rows that carry the
//                     inline Retry verb (offersRetry === this kind — one decision, two surfaces).
//   clock waiting   — machine-waiting behind an ```awaiting fence
//   [✓] done        — a ```done fence at rest, OR an archived thread (muted check — NOTHING else)
//   […] at rest     — an ordinary rest with no concrete ask, INCLUDING a queued thread whose own
//                     dispatched sub-agents are still running (they spin on their own child rows)
// Attention (needs-input / stalled) wears the accent; everything else is muted.
/** Exported for TESTS ONLY. The tip is a Radix tooltip, so it renders nothing until it opens — static
 *  markup cannot see it, and asserting on the icon alone would pass a popover that said the wrong thing.
 *  This is the seam that lets the popover's TEXT be pinned directly. */
export function sessionIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  const base = sessionStateIndicatorFor(t)
  // The tooltip is now the ONLY place a snooze is legible on the rail (the subtitle no longer names it),
  // so it has to say so on every parked row — not just the ones the park actually quiets. The hourglass
  // arm below already tells that story for a Snoozed row. These are the rows a snooze does NOT silence:
  // one whose own turn is running, and one still waiting on a sub-agent it dispatched. Each keeps its
  // live glyph — MOTION is a fact about the process that a park does not change — and gains a second
  // line saying when the park takes effect.
  // A CONCRETE ASK USED TO BE THE THIRD such row, and it was the one case where the rail lied: the
  // server dequeues a user-snoozed thread before it ever reaches its ask gates (deriveNeedsYou), so the
  // [?] pointed at a card that did not exist on any surface (2026-08-31 — see sessionIndicatorKind). It
  // takes the hourglass now, and that arm names the ask the park is holding.
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
// telemetry the browser cannot see — so by the time either arm runs, the work behind it is live. That
// same gate is why the `agent` hint rides along on the shell's blue rather than the accent-yellow a
// sub-agent pulses elsewhere: a LIVE sub-agent makes isSnoozed false outright (hasLiveSubAgents), so
// the arm is reachable only on a park the server honoured for something else in the same fence.
//
// AND IT KEEPS ITS PULSE IN THE SNOOZED BAND. The band's own dim (opacity-65 on the row) is what says
// "parked" — the same ruling .frizz-rail-dot already states for its own animation, that only TONE may
// move because the geometry is what identifies the mark. A static twin would be a second mark to keep
// in sync for a distinction the band already draws, and the shell really is still running.
const shellDot = <StatusBox><span aria-hidden className="frizz-rail-dot" data-running-indicator="thread-background" /></StatusBox>

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
const githubMark = (
  <StatusBox>
    <Github size={PR_MARK_SIZE} className="text-muted/70" style={{ transform: `translateX(${PR_MARK_NUDGE}px)` }} />
  </StatusBox>
)

function sessionStateIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  const kind = sessionIndicatorKind(t)
  if (kind === "archived") return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted/75" /></StatusBox>, tip: "Done" }
  if (kind === "needs-input") {
    // Muted "?", same gray as every other glyph — a needs-you thread already carries maximum emphasis
    // by sitting in the ⚖ queue, so the rail indicator adds NO extra color (maintainer 2026-07-10).
    return { node: <StatusBox><Glyph ch="?" muted /></StatusBox>, tip: "Needs your input" }
  }
  if (kind === "working") return { node: <BoxSpinner />, tip: "Working" }
  // The thread has stopped and nothing is going to wake it — only a detached shell it launched is still
  // running — so the box stops tracing and the row simply stays alive in the running band. The mark is
  // `shellDot`, shared with the parked arm below; see its note for why one dot serves both.
  if (kind === "background") {
    // The fence, when there is one, names the shell itself (and any PR riding beside it), so the lead
    // drops to a bare "At rest" rather than saying "a background shell" twice in one sentence.
    const fenced = t.lastFence?.kind === "awaiting" && awaitingWaitClause(t.lastFence.hints) !== null
    return {
      node: shellDot,
      tip: popover(t, fenced ? "At rest" : "At rest — a background shell is still running"),
    }
  }
  if (kind === "done") return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted/75" /></StatusBox>, tip: "Done" }
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
    const which = p?.window === "weekly" ? "weekly limit" : p?.window === "session" ? "session limit" : "usage limit"
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
  if (kind === "pr") return { node: githubMark, tip: popover(t, "At rest") }
  if (kind === "snoozed") {
    const hourglass = <StatusBox><Hourglass size={9} className="text-muted/70" /></StatusBox>
    const github = githubMark
    // A snoozed row whose fence names a PR (`prs:` since the 2026-08-24 YAML cutover; `pr:` and `pr-watch:`
    // before it, both retired) is snoozed FOR A PR, and the rail says so with GitHub's mark instead of the
    // hourglass. The hourglass means "parked on the clock", and for a watch the clock is only the
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
    const parkMark = waitNamesPr(t) ? github : hourglass
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
    const eventSnoozed = t.bgSnoozed === true ? "Snoozed until the background work returns" : null
    // Canonical blocked+timer status can arrive from an older/pre-session snapshot without a fence.
    if (t.lastFence?.kind !== "awaiting") {
      // The event-snooze reaches here for a rest on a shell, a timer OR a registered PR watch, and only
      // the first of those is a shell. A watch the worker never fenced has no hints to read, so the dot
      // was the default by omission rather than by decision.
      if (eventSnoozed) return { node: waitNamesPr(t) ? github : shellDot, tip: eventSnoozed }
      const timed = typeof t.revalidate === "string" ? formatAutoSnoozedUntil(t.revalidate) : null
      return { node: hourglass, tip: timed ?? "Auto-snoozed until a scheduled check" }
    }
    // Reserve the park mark (hourglass, or GitHub when a watch is riding along) for intentional park
    // states: a durable GitHub review cursor, the thread's own live work, or a VALID scheduled instant.
    // NO HINT KIND PARKS ON ITS OWN. `human:` and `timer: <instant>` each drew the Snoozed mark from the
    // worker's assertion alone; both are deleted (2026-08-15) and the server now decides Snoozed from a
    // checked declaration. What is left to draw is the SHAPE of the wait.
    const hk = t.lastFence.hints.find((h) => h.kind === "pr" || h.kind === "shell" || h.kind === "agent" || h.kind === "timer")?.kind
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
    const mark = waitNamesPr(t)
      ? github
      : hk === "shell" || hk === "agent"
        ? shellDot
        : <StatusBox><Clock size={9} className="text-muted/70" /></StatusBox>
    return { node: mark, tip: popover(t, eventSnoozed ?? "Snoozed") }
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
    node: <StatusBox><Ellipsis size={11} className="text-muted/70" /></StatusBox>,
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
      className={`frizz-rail-glyph font-bold leading-none ${muted ? "text-muted/70" : "text-accent"}`}
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
  if (t.status === "blocked" && t.mechanism === "timer") return { node: <Timer size={INDICATOR + 1} className="text-muted/70" />, tip: "Waiting on a timer" }
  if (t.status === "blocked" && t.mechanism === "threads") return { node: <CircleDashed size={INDICATOR + 1} className="text-muted/70" />, tip: "Waiting on other work" }
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
      className="block rounded-full bg-accent shadow-[0_0_5px_rgba(232,185,35,0.45)]"
      style={{ width: ATTENTION, height: ATTENTION }}
    />
  )
}

function BlueDot() {
  return <span className="block rounded-full bg-sky-400" style={{ width: INDICATOR, height: INDICATOR }} />
}

// Awaiting-you without a queue card (legacy session-less needs-human): the status palette's yellow.
function YellowDot() {
  return <span className="block rounded-full bg-yellow-400" style={{ width: INDICATOR, height: INDICATOR }} />
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
