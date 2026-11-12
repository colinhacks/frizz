import type { MouseEvent } from "react"
import { Minimize2 } from "lucide-react"
import { boardThreadHref, queueDestination, spaNavigate } from "../lib/router.ts"
import { paneEnabled } from "../store.ts"
import { setPaneFolded } from "../lib/threadPane.ts"
import { fullscreenOriginFor } from "../lib/fullscreenHandoff.ts"
import { prefersReducedMotion } from "../lib/sheet.ts"
import { isPlainLeftClick } from "../lib/standaloneThreadRoute.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { Tooltip } from "./Tooltip.tsx"

// The href of the way out, shared by the icon below and by Escape (StandaloneThreadPage), so the key
// and the click can never land in two different places.
//
// BACK TO THE SURFACE THE DOOR WAS PRESSED IN, when the door noted one (lib/fullscreenHandoff).
// A thread read through a DRAWER has no surface on the board root, so landing there both stranded
// the reader and left the reverse morph with nothing named to shrink into — it cross-faded at every
// width. `?thread=<slug>` is that drawer's own address, and BoardRoute re-mounts and names it.
//
// The fallback is the queue, and it is THIS project's queue, not the launching one's — and a BOARD,
// not the project picker. A bare "/" sent a reader who opened `/project/nub/thread/x` to
// whichever board the server was started from, and on the launching project it sent them to the grid.
// It is what a COLD arrival at full screen gets: a deep link, a bookmark, a reload — no door was pressed,
// so there is nowhere to go back to and the queue is the honest destination.
export function exitFullscreenHref(slug: string): string {
  return fullscreenOriginFor(slug) ?? queueDestination("/")
}

// The fullscreen door's transition, played backwards: BoardRoute primes the reverse morph's target
// (store.primeFullscreenReturn), so this opts the navigation in the same way the door does. The
// browser Back button gets the same treatment for free — react-router re-arms the transition for
// the POP of a pair that transitioned.
export function exitFullscreen(slug: string): void {
  spaNavigate(exitFullscreenHref(slug), { viewTransition: !prefersReducedMotion() })
}

// THE FULLSCREEN DOOR, CLOSING — ExpandThreadLink's exact counterpart, and it stands in the exact
// place: HeaderActions' `expand` slot, so the icon that took the reader to /full and the icon that
// brings them back occupy one position in one strip (maintainer 2026-09-02: "instead of a back arrow
// in the upper left, I think we should just have a collapse icon in the same place where the expand
// icon is in the cue card").
//
// It replaced an ArrowLeft that sat before the TITLE, at the header's far left — a second, unrelated
// place to look for a whole-thread verb, and a glyph that says "previous page" about a control whose
// job is to change how this thread is being SHOWN.
//
// A real anchor, for the same reasons as the door out: ⌘/middle/right-click and "copy link address"
// need no code, and a plain left click becomes a react-router navigation through lib/router's
// registered navigator. `data-standalone-return` is kept from the arrow — it names the FUNCTION, which
// has not changed.
export function CollapseThreadLink({ slug, label = "Exit fullscreen" }: { slug: string; label?: string }) {
  // In the pane the way out is the same thread beside the sidebar, which is where a plain click goes too.
  const href = paneEnabled() ? boardThreadHref(slug) : exitFullscreenHref(slug)
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!isPlainLeftClick(event)) return
    event.preventDefault()
    if (paneEnabled()) {
      setPaneFolded(false)
      return
    }
    exitFullscreen(slug)
  }
  return (
    <Tooltip label={label}>
      <a
        href={href}
        aria-label={label}
        data-standalone-return
        // The strip's shared focus behaviour: a click on any icon here must not take the keyboard
        // away from the composer below it.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        className={HEADER_ICON_CLASS}
      >
        <Minimize2 size={14} />
      </a>
    </Tooltip>
  )
}
