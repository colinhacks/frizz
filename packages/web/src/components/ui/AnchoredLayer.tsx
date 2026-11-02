import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Z_POPOVER } from "../../lib/layers.ts"

// A PANEL PLACED BY HAND off the element it is rendered inside, and PORTALED to <body> — for what the
// Radix primitives do not fit: a typeahead the textarea keeps driving (Composer's skills menu), a panel
// whose arrow geometry is measured (RestartFrizzButton). Rule 2 of lib/layers.ts: anything that hangs off
// a trigger and can leave its box is portaled, because in the tree its z ranks only inside the nearest
// stacking context — and both sidebars, every card footer and every drawer are one.
//
// THE ANCHOR IS THE PARENT OF A HIDDEN MARKER this renders in place, not a ref the caller passes: React
// attaches a child's ref before its parent's layout effect runs, but a PARENT's ref only after its
// children's effects, so a panel that mounted together with its anchor read a null ref and never drew
// (the update-failure fixture, 2026-10-30). The marker is `display: none`, so it takes no flex slot and
// no gap; it does count as a child for `:last-child`-keyed utilities (`space-y-*`), so render this
// before a sibling rather than last in such a parent.
//
// RE-MEASURED AFTER EVERY COMMIT (the first one has no panel to take the size of) and on every scroll,
// resize and visual-viewport change, so a panel that stays up tracks its anchor, the phone's keyboard
// included. An unchanged reading keeps the same state, so it settles in one extra pass, before paint.
//
// A portaled panel no longer sits inside its surface, so it outranks anything opened after it: it has
// to CLOSE when its moment passes (focus leaves, the pointer leaves), as a Radix popover does.
//
// It takes the pointer OUTRIGHT (`pointer-events: auto`). Opened from inside a modal Radix layer — a
// drawer's composer on the phone — it is outside that layer's DOM, and a modal layer makes <body>
// click-through, so an inherited `none` sent a tap on a row to the transcript underneath. Radix still
// counts a press here as inside the drawer, since it follows the React tree, not the DOM; its focus
// trap follows the DOM, so a panel that must hold focus (an input) is a Radix popover instead.

export type AnchorRect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
export type LayerSize = { width: number; height: number }
export type Viewport = { width: number; height: number }
/** Where the layer goes, as `position: fixed` style, from its anchor, its own size and the viewport. */
export type Placement = (anchor: AnchorRect, size: LayerSize, viewport: Viewport) => CSSProperties

type Reading = { anchor: AnchorRect; size: LayerSize; viewport: Viewport }

function sameReading(a: Reading, b: Reading): boolean {
  return (
    a.anchor.left === b.anchor.left && a.anchor.top === b.anchor.top && a.anchor.width === b.anchor.width && a.anchor.height === b.anchor.height &&
    a.size.width === b.size.width && a.size.height === b.size.height &&
    a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height
  )
}

export function AnchoredLayer({
  place,
  children,
  zClass = Z_POPOVER,
}: {
  place: Placement
  children: ReactNode
  /** A layer from lib/layers.ts; the popover layer unless the panel opens from somewhere higher. */
  zClass?: string
}) {
  const marker = useRef<HTMLSpanElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const [reading, setReading] = useState<Reading | null>(null)
  const measure = useCallback(() => {
    const anchor = marker.current?.parentElement?.getBoundingClientRect()
    if (!anchor) return
    const next: Reading = {
      anchor: { left: anchor.left, top: anchor.top, right: anchor.right, bottom: anchor.bottom, width: anchor.width, height: anchor.height },
      size: { width: layer.current?.offsetWidth ?? 0, height: layer.current?.offsetHeight ?? 0 },
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    }
    setReading((was) => (was && sameReading(was, next) ? was : next))
  }, [])
  useLayoutEffect(measure)
  useLayoutEffect(() => {
    const visual = window.visualViewport
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    visual?.addEventListener("resize", measure)
    visual?.addEventListener("scroll", measure)
    return () => {
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
      visual?.removeEventListener("resize", measure)
      visual?.removeEventListener("scroll", measure)
    }
  }, [measure])
  return (
    <>
      <span ref={marker} hidden />
      {reading &&
        createPortal(
          <div ref={layer} className={`pointer-events-auto fixed ${zClass}`} style={place(reading.anchor, reading.size, reading.viewport)}>
            {children}
          </div>,
          document.body,
        )}
    </>
  )
}

/**
 * The typeahead's placement: the anchor's own width, `gap` px ABOVE it, and below it instead only when
 * the room above runs out and there is more below — a composer near the top of the window (a short
 * queue card scrolled up, the phone's composer page) would otherwise open its menu off the screen.
 */
export function aboveAnchor(gap: number, margin = 8): Placement {
  return (anchor, size, viewport) => {
    const above = anchor.top - gap - margin
    const below = viewport.height - anchor.bottom - gap - margin
    const top = size.height <= above || above >= below ? anchor.top - gap - size.height : anchor.bottom + gap
    return { left: anchor.left, top, width: anchor.width }
  }
}
