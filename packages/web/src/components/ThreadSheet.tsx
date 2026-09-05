import * as RadixDialog from "@radix-ui/react-dialog"
import { useCallback, useEffect, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { displayTitle } from "../groups.ts"
import { registerDrawerFocus } from "../lib/overlays.ts"
import { useSheetLayer } from "./ui/Sheet.tsx"
import { SHEET_PANEL_CLASS, SHEET_SCRIM_CLASS, sheetWidth } from "../lib/sheet.ts"
import { resolveThreadRoute } from "../lib/threadRouteState.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { DrawerInitialScrollCoordinator } from "../lib/drawerInitialScroll.ts"
import { PANE_HEADER_HEIGHT_CLASS } from "../lib/paneHeaderHeight.ts"
import { ThreadView } from "./ChatView.tsx"

// One THREAD layer of the side-drawer stack: a right sheet (same slide/backdrop family as settings)
// showing a thread's FULL view as an OVERLAY — the queue (and any layers below) keep their scroll and
// state; closing just reveals what's underneath. Chat/Terminal is LOCAL to the layer. `depth` insets
// each successive layer a step further from the right edge so the stack reads as a stack.

function useNarrowDrawer(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 800px)").matches)
  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)")
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  return narrow
}

export function ThreadSheet({ id, slug, depth, widthDepth, initiallyOpen }: { id: number; slug: string; depth: number; widthDepth: number; initiallyOpen?: boolean }) {
  // URL-created sheets exist before the first React paint. They must begin visible (initiallyOpen):
  // waiting for a post-mount animation frame left a full-screen opacity-0 backdrop mounted indefinitely
  // on a cold page, so the first apparent sidebar click actually closed that invisible sheet.
  // useSheetLayer owns the slide-in/close/re-arm/Esc-registration exactly as the plain sheets do.
  const { shown, close, closingRef } = useSheetLayer(id, initiallyOpen === true)
  // INSTANT OPEN: the sheet frame + spinner paint immediately; the heavy body (ChatView — a 100KB+
  // transcript, markdown, diff highlighting) is deferred until AFTER the first paint so click→visible
  // isn't gated on rendering it. The spinner covers the one-frame gap.
  const [bodyReady, setBodyReady] = useState(initiallyOpen === true)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const initialScrollRef = useRef<DrawerInitialScrollCoordinator | null>(null)
  const drawerSnap = useSnapshot(store)
  const activeDrawer = [...drawerSnap.drawers].reverse().find((drawer) => !drawer.closing)
  const isTopDrawer = activeDrawer?.id === id
  const narrow = useNarrowDrawer()
  // Sheets are store/route-mounted rather than opened by RadixDialog.Trigger. Preserve the focused
  // row/button (or the control in the layer below) so closing this stack layer restores it exactly.
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const restoreOpener = useCallback(() => {
    const opener = openerRef.current
    // ONLY when the sheet took focus WITH it. Both restore paths fire ~0ms after the layer unmounts,
    // which is the far end of a ~210ms slide-out — and the click that STARTED that slide-out very often
    // put focus somewhere deliberate on the way past (the sidebar's prompt box is the case that
    // reported it: you click in, you type, and a fifth of a second later the sheet you dismissed yanks
    // the caret back to the row you opened it from). Focus resting on <body> means nothing else claimed
    // it — the sheet really did leave a hole, and restoring the opener fills it. Anything else is the
    // reader's own choice and outranks us.
    const active = document.activeElement
    if (active && active !== document.body) return
    if (opener?.isConnected) opener.focus({ preventScroll: true })
  }, [])
  useEffect(() => () => { window.setTimeout(restoreOpener, 0) }, [restoreOpener])

  // Opening a thread IS reading it: record seen/read telemetry without acknowledging its lifecycle
  // handoff (resting queue cards stay present until follow-up, Snooze, or Archive). Re-fire only when
  // new activity reaches rest while the drawer is open so last_read_at reflects what was actually on
  // screen; mid-turn tailer churn is excluded. Idempotent and fire-and-forget.
  const board = useBoard()
  const route = resolveThreadRoute(board, slug)
  const t = route.kind === "found" ? route.thread : undefined
  const projectDir = board?.projectDir
  const atRestNow = t ? t.runtime === "turn-idle" || t.runtime === "exited" || t.runtime === "none" : false
  const activityAt = atRestNow ? t?.lastActivityAt : undefined
  useEffect(() => {
    if (!t || !atRestNow) return
    rpc.threadSeen({ slug }).catch(() => {})
  }, [slug, atRestNow, activityAt])

  // Initial tail focus is a one-shot settling phase. The sheet's direct flex child stays viewport-
  // height even while its scrollHeight grows, so observing that child misses async transcript render.
  // Observe the transcript surface itself plus subtree commits, and yield permanently on user intent.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !bodyReady) return
    const content = () => el.querySelector<HTMLElement>("[data-drawer-scroll-ready]")
    const transcriptScroller = () => el.querySelector<HTMLElement>("[data-drawer-transcript-scroll]")
    const coordinator = new DrawerInitialScrollCoordinator({
      isActive: () => [...store.drawers].reverse().find((drawer) => !drawer.closing)?.id === id,
      isContentReady: () => content()?.dataset.drawerScrollReady === "true",
      scrollToBottom: () => {
        const scroller = transcriptScroller()
        if (!scroller) return false
        scroller.scrollTop = scroller.scrollHeight
        return true
      },
      preserveAnchor: () => location.hash.length > 1,
    })
    initialScrollRef.current = coordinator

    let observedContent: HTMLElement | null = null
    const ro = new ResizeObserver(() => coordinator.layoutChanged())
    const observeContent = () => {
      const next = content()
      if (next !== observedContent) {
        if (observedContent) ro.unobserve(observedContent)
        observedContent = next
        if (next) ro.observe(next)
      }
      coordinator.layoutChanged()
    }
    const mo = new MutationObserver(observeContent)
    mo.observe(el, { attributes: true, attributeFilter: ["data-drawer-scroll-ready"], childList: true, subtree: true })

    const userIntent = () => coordinator.userIntent()
    const keyIntent = (event: KeyboardEvent) => {
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) userIntent()
    }
    el.addEventListener("wheel", userIntent, { capture: true, passive: true })
    el.addEventListener("touchstart", userIntent, { capture: true, passive: true })
    el.addEventListener("pointerdown", userIntent, true)
    el.addEventListener("keydown", keyIntent, true)
    observeContent()

    return () => {
      coordinator.dispose()
      if (initialScrollRef.current === coordinator) initialScrollRef.current = null
      el.removeEventListener("wheel", userIntent, true)
      el.removeEventListener("touchstart", userIntent, true)
      el.removeEventListener("pointerdown", userIntent, true)
      el.removeEventListener("keydown", keyIntent, true)
      ro.disconnect()
      mo.disconnect()
    }
  }, [bodyReady, id])

  useEffect(() => {
    initialScrollRef.current?.activationChanged()
  }, [isTopDrawer])

  // Defer the heavy body (ChatView) one frame past the shell's own slide-in (useSheetLayer flips
  // `shown` on the first frame) so click→visible isn't gated on rendering a 100KB+ transcript. Same
  // 120ms RAF-starvation backstop as the shell: a background/occluded tab can report visibilityState
  // "visible" while starving requestAnimationFrame, and the body must still reveal.
  useEffect(() => {
    if (initiallyOpen) return
    let done = false
    const reveal = () => {
      if (done || closingRef.current) return
      done = true
      setBodyReady(true)
    }
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(reveal)
    })
    const fallback = window.setTimeout(reveal, 120)
    return () => {
      window.clearTimeout(fallback)
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [initiallyOpen])

  // Interaction-opened sheets paint their frame before the heavy thread body. Focus the frame for
  // that first paint, then move to the explicit close affordance once the body arrives. For a cold
  // route (body already present), Radix focuses the close affordance immediately.
  useEffect(() => {
    const el = scrollerRef.current
    if (!bodyReady || !el || document.activeElement !== el) return
    const frame = requestAnimationFrame(() => {
      el.querySelector<HTMLElement>("[data-dialog-initial-focus]")?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [bodyReady])

  useEffect(() => {
    registerDrawerFocus(id, () => {
      const initial = scrollerRef.current?.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? scrollerRef.current
      initial?.focus({ preventScroll: true })
    })
    return () => registerDrawerFocus(id, null)
  }, [id])

  return (
    <RadixDialog.Root modal={narrow} open onOpenChange={(open) => { if (!open) close() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={`${SHEET_SCRIM_CLASS} ${shown ? "opacity-100" : "opacity-0"}`}
          style={{ zIndex: 50 + depth * 2 }}
        />
        <RadixDialog.Content
          ref={scrollerRef}
          aria-modal={narrow || undefined}
          aria-describedby={undefined}
          tabIndex={-1}
          onEscapeKeyDown={(event) => {
            // Plain sheets are invisible to Radix's layer stack. Defer to DrawerStack when one
            // sits above this dialog, including its exit animation, or one Escape closes BOTH.
            // Do not stop propagation here: the top plain sheet still needs this key.
            if (store.drawers.at(-1)?.id !== id) {
              event.preventDefault()
              return
            }
            handleDialogEscape(event)
          }}
          // A non-modal Radix layer also dismisses on any pointer-down OUTSIDE its content. Two
          // cases must not self-dismiss: (1) this sheet is BURIED under another drawer layer (a
          // sub-agent/doc sheet stacked over it, or a lateral swap in flight) — only the TOPMOST
          // live layer owns outside-pointer dismissal, otherwise a click inside the child sheet
          // silently closes the parent underneath it; (2) the pointer landed on one of THIS
          // thread's own sub-agent rows (sidebar child rows / queue card lines carry
          // data-subagent-parent) — that click is a drill-IN, and the drawer policy in
          // openOrRaiseDrawer stacks the child over this sheet instead of dismissing it. Every
          // other outside pointer (backdrop, blank sidebar, sibling rows) dismisses as before —
          // sibling opens also route through the store policy, which closes this layer anyway.
          onPointerDownOutside={(event) => {
            // CLOSING layers still count as "above": Radix dispatches this event AFTER the
            // backdrop's own onMouseDown has already marked the top sheet closing (verified in the
            // real event order), so a live-only check would see this buried sheet as topmost during
            // exactly the backdrop-click unwind it must survive.
            const idx = store.drawers.findIndex((drawer) => drawer.id === id)
            if (idx !== -1 && idx < store.drawers.length - 1) {
              event.preventDefault()
              return
            }
            const target = event.target instanceof Element ? event.target.closest("[data-subagent-parent]") : null
            if (target?.getAttribute("data-subagent-parent") === slug) event.preventDefault()
          }}
          // A non-modal Radix layer dismisses on focus-OUTSIDE by default. That fired the self-close
          // bug: opening a second thread from the sidebar dismisses THIS layer via pointer-down-outside
          // (expected), and ~210ms later its close restores focus to its opener row — a focusin OUTSIDE
          // the newly-opened layer, which Radix read as focus-outside and dismissed the new drawer too,
          // leaving nothing open. Focus movement must never close a drawer (modal layers preventDefault
          // this for the same reason); only the backdrop/outside POINTER and Esc do.
          onFocusOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreOpener()
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const el = scrollerRef.current
            const initial = el?.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? el
            initial?.focus({ preventScroll: true })
          }}
          // data-vt-chat: the fullscreen door tags this panel as the view transition's shared element
          // on the way to /full (see ExpandThreadLink) — the panel is what visibly becomes the page's
          // thread column. On the way BACK the tag is declarative: while this slug is the primed
          // return target (store.primeFullscreenReturn), the panel wears the name in its first
          // commit, so the /full column has somewhere to morph back into.
          data-vt-chat
          className={`fixed right-0 top-0 overflow-hidden outline-none ${SHEET_PANEL_CLASS} ${shown ? "translate-x-0" : "translate-x-full"}`}
          style={{ zIndex: 51 + depth * 2, width: sheetWidth(widthDepth), viewTransitionName: drawerSnap.vtReturnTarget === slug ? "thread-chat" : undefined }}
        >
          <RadixDialog.Title className="sr-only">
            {route.kind === "found" ? `Thread: ${displayTitle(route.thread)}` : `Thread: ${slug}`}
          </RadixDialog.Title>
          {bodyReady && route.kind === "found" ? (
            // Mark-as CONFIRMED (any status) → the drawer closes: the thread just left the state the
            // human was looking at it for (maintainer directive).
            // `virtualized`: the drawer renders the transcript through the windowed renderer (the same
            // one the standalone page uses) instead of mounting all ~300 messages eagerly. Opening a
            // long chat used to build 6k+ DOM nodes and burn a ~300ms long task on the main thread
            // before the sheet was usable.
            <ThreadView slug={slug} onStatusApplied={close} onClose={close} virtualized />
          ) : bodyReady && route.kind === "missing" ? (
            <MissingThread slug={slug} onClose={close} />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <span className="block h-5 w-5 rounded-full border-2 border-muted/50 border-t-transparent animate-spin" />
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

function MissingThread({ slug, onClose }: { slug: string; onClose: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className={`flex ${PANE_HEADER_HEIGHT_CLASS} shrink-0 items-center gap-3 border-b border-border bg-panel px-4`}>
        <span className="min-w-0 flex-1 truncate font-medium">Thread unavailable</span>
        <button type="button" aria-label="Close" data-dialog-initial-focus onClick={onClose} className="p-1 text-muted hover:text-fg">
          ×
        </button>
      </header>
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted" role="status">
        Thread “{slug}” was not found in this project.
      </div>
    </div>
  )
}
