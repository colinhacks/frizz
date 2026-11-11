// IN THE STACKED LAYOUT THE WORKPANE, NOT THE RAIL, IS WHAT A READER'S SCROLL POSITION HOLDS ON TO.
//
// At 800px and under the sidebar is a block ABOVE the workpane instead of a column beside it, so a row
// that arrives in the rail — a thread starting, a turn ending elsewhere — pushes everything under it down
// by the row's height. It was measured on the queue's cards, the workpane until the one-thread pane
// (2026-11-09); a status list stacks under the sidebar the same way. The browser's scroll anchoring is what should absorb that: it adjusts the scroll
// offset so the anchor element stays where it was. But it anchors to the FIRST thing on screen, and
// while any slice of the rail is still on screen that thing is the rail, which is above the change and
// does not move. So the offset was left alone and the cards jumped. Recorded at 780x900 on 2026-10-13, a
// row arriving in the Running band, the first card's top before and after:
//
//   page at the top (scrollY 0)                 557 -> 584   anchoring never applies at the origin
//   scrollY 150, 420 (the rail still on screen)  407 -> 434, 137 -> 164   (3 of 3 and 1 of 1)
//   scrollY 480, 700 (the bands above the fold)  no change: scrollY +27 in the same frame
//
// The rail is therefore taken out of the running (`overflow-anchor: none`) while the workpane is on
// screen, and the browser anchors to the first thing in it instead: at 150 and 420 the offset now moves by the
// 27px and the cards hold (3 of 3 each); what moves is the slice of the rail above the new row.
//
// NOT WHILE THE WORKPANE IS OFF SCREEN. A reader scrolled inside a long rail (an expanded Done band) has
// nothing else to anchor to, and excluding the rail there would let the rows they are reading jump
// instead. So the exclusion follows the workpane in and out of the viewport.
//
// At scrollY 0 nothing changes: the row's height arrives above the workpane and it moves down by it.
// Beside the workpane (over 800px) the rail is its own sticky column and none of this applies; the class
// below is scoped to the stacked breakpoint.

/** On the stacked `<aside>`: not a scroll anchor while the workpane is on screen. */
export const STACKED_RAIL_ANCHOR_CLASS = "max-[800px]:data-[queue-in-view]:[overflow-anchor:none]"

/**
 * The `<aside>`'s ref: keeps `data-queue-in-view` on it while the workpane (`#workpane`) intersects
 * the viewport. A module-level function, so React attaches it once; the returned cleanup detaches it.
 */
export function stackedRailAnchor(aside: HTMLElement | null): (() => void) | undefined {
  if (!aside || typeof IntersectionObserver === "undefined") return undefined
  const queue = document.getElementById("workpane")
  if (!queue) return undefined
  const observer = new IntersectionObserver((entries) => {
    const entry = entries[entries.length - 1]
    if (entry.isIntersecting) aside.dataset.queueInView = ""
    else delete aside.dataset.queueInView
  })
  observer.observe(queue)
  return () => {
    observer.disconnect()
    delete aside.dataset.queueInView
  }
}
