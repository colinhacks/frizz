import { useContext, useRef, type MouseEvent } from "react"
import { QueryClientContext } from "@tanstack/react-query"
import { Maximize2 } from "lucide-react"
import { warmTranscript } from "../hooks.ts"
import { captureFullscreenEnterAnchor, rememberFullscreenOrigin } from "../lib/fullscreenHandoff.ts"
import { armFullscreenMorph } from "../lib/fullscreenMorph.ts"
import { spaNavigate } from "../lib/router.ts"
import { prefersReducedMotion } from "../lib/sheet.ts"
import { isPlainLeftClick, standaloneThreadHref } from "../lib/standaloneThreadRoute.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { Tooltip } from "./Tooltip.tsx"

// THE FULLSCREEN DOOR — one affordance, three surfaces (the sidebar row on hover, the queue card's
// action strip, the drawer header), all opening the thread's full-screen page, `…/thread/<slug>`. It replaced the ↗
// "Open in new tab" arrow on 2026-08-28: the maintainer wants the fullscreen view to be the ordinary
// way to focus on a thread, in THIS tab, with the address bar following — and a new tab only on the
// gestures a browser already reserves for that.
//
// A real anchor, so ⌘/middle/right-click and "copy link address" need no code; a plain left click is
// intercepted into a react-router navigation (through lib/router's registered navigator, so this
// needs no router context and renders in a bare test). `/full` lives in the same router as the board
// (routes.tsx), so this is a route change, not a document load — wrapped in a VIEW TRANSITION so the
// chat surface visibly slides into its /full position instead of the page hard-cutting. The stack
// clear that used to sit here (the fullscreen page mounts the same DrawerStack and would paint the
// thread's own sheet over itself) moved to StandaloneRoute: the old page is snapshotted two renders
// AFTER this click, so a click-time clear removed the very sheet the transition slides.
export function ExpandThreadLink({ slug, size = 14, className, label = "Open fullscreen" }: { slug: string; size?: number; className?: string; label?: string }) {
  const href = standaloneThreadHref(slug)
  // Read off the context rather than through useQueryClient, which throws without a provider: the door
  // renders in bare tests (the sidebar row's), and with no client there is nothing to warm.
  const queryClient = useContext(QueryClientContext)
  const warming = useRef(false)
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    // Never let the click reach the row/card underneath: the sidebar row would ALSO open its drawer.
    event.stopPropagation()
    if (!isPlainLeftClick(event)) return
    event.preventDefault()
    const animate = !prefersReducedMotion()
    // The chat surface this door sits in: the drawer's panel, or the queue card's shell. It is both
    // what the transition morphs and what the reader's place is measured against, so it is read once
    // whether or not the navigation animates — the scroll hand-off is continuity, not decoration, and a
    // reader on reduced motion needs it more, not less.
    const surface = event.currentTarget.closest<HTMLElement>("[data-vt-chat]")
    // Where they are in it, for /full to restore instead of jumping to the tail (lib/fullscreenHandoff).
    captureFullscreenEnterAnchor(surface, slug)
    // And the address they are at, so the way OUT of full screen leads back to this same surface rather
    // than to the board root — which for a drawer-read thread mounts nothing to morph back into. The
    // QUERY is the drawer (`?thread=<slug>`, lib/router.ts), so it is part of the address.
    if (typeof location !== "undefined") rememberFullscreenOrigin(slug, `${location.pathname}${location.search}`)
    // A door on a surface already showing the thread has its transcript cached and goes at once. A
    // sidebar row's door usually does not: the page would mount on "Loading…", and the view transition
    // would cross-fade that frame in and then cut to the transcript. So it waits for the transcript, a
    // few hundred ms at most (hooks.ts warmTranscript), and a second click meanwhile is the same one.
    if (!queryClient || queryClient.getQueryData(["transcript", slug]) !== undefined) return go(surface, animate)
    if (warming.current) return
    warming.current = true
    void warmTranscript(queryClient, slug).then(() => {
      warming.current = false
      go(surface, animate)
    })
  }
  function go(surface: HTMLElement | null, animate: boolean) {
    if (animate && surface) {
      // Tag it as the transition's shared element — imperatively, so exactly ONE element ever carries
      // the name (a queue card and an open drawer can both be on screen; `view-transition-name` must be
      // unique). The /full page's thread column wears the same name statically, so the browser morphs
      // one into the other. A sidebar-row door has no tagged ancestor — the column then simply fades in.
      surface.style.viewTransitionName = "thread-chat"
      // And start the morph from the part of it the reader can SEE: a tall card scrolled to its middle
      // has a box that begins far above the viewport, and morphing from the whole box swept the entire
      // screen downward (lib/fullscreenMorph).
      armFullscreenMorph(surface)
    }
    spaNavigate(href, { viewTransition: animate })
  }
  return (
    <Tooltip label={label}>
      <a
        href={href}
        aria-label={label}
        data-expand-thread={slug}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
        onClick={onClick}
        className={className ?? HEADER_ICON_CLASS}
      >
        <Maximize2 size={size} />
      </a>
    </Tooltip>
  )
}
