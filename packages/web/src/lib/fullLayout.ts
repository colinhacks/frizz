import type { CSSProperties } from "react"
import type { ThreadWidth } from "./prefs.ts"
import { SHEET_BASE_WIDTH } from "./sheet.ts"

// The full-screen page's lengths and the focus rail's width, read by that page (StandaloneThreadPage) and
// by the board's one-thread pane (ThreadPane). They live here rather than in either component because the
// page and the rail are in the lazy thread-surfaces chunk (components/lazySurfaces.tsx), and a constant
// imported from them would carry their whole modules into the board's entry chunk.

// The rail's width, in px — the side pane on /full is exactly this wide while nothing covers it. 340
// rather than the mockup's 300: the card's rows were fitted at a 368px card, and at 300 a PR row
// truncated to "colinhacks/zod#…" — the one part of the ref that names the PR (2026-08-28).
export const RAIL_WIDTH = 340

// THE MOST A THREAD'S COLUMN GROWS TO, per the Settings choice (lib/prefs.ts threadWidth). A cap, never a
// size: each surface still gives the column what the window has left, and only stops it here. Standard is
// the drawer's own width (lib/sheet.ts SHEET_BASE_WIDTH), the measure every thread surface kept until
// 2026-11-18, about 95 characters of body text a line; Wide is about 115 and Widest about 130. Three
// steps rather than a dragged width (maintainer 2026-11-18, closing colinhacks/frizz#77: "There is no
// value in having the pane be that wide … it just still has a somewhat opinionated max width").
export const THREAD_WIDTH_PX: Record<ThreadWidth, number> = {
  standard: SHEET_BASE_WIDTH,
  wide: 840,
  widest: 960,
}

/**
 * THE WHOLE GEOMETRY OF /full, as three lengths that depend on the PAGE WIDTH AND NOTHING ELSE — not
 * on whether a file is open, which is the point (see the layout comment below). Percentages resolve
 * against the row, which is the page minus the project rail, so a `vw` here would be wrong on a
 * board that shows one. `thread` is the cap above, THREAD_WIDTH_PX of the reader's choice.
 *
 *   thread = half the page, capped at `thread`
 *   pane   = everything the thread does not take
 *   gutter = the slack left beside the pair once the rail has its 340
 *
 * `thread + pane` is exactly the page at every width (below twice the cap both are half; above it the
 * thread pins at the cap and the pane takes the rest), which is what makes the open state a 50/50 read
 * on a 1200px screen — "600px of content, and then the file takes up 600px" (maintainer 2026-08-30) —
 * without either column having to change size to get there.
 */
export function layoutVars(thread: number): CSSProperties {
  const pane = `max(50%, calc(100% - ${thread}px))`
  return {
    "--full-thread": `min(${thread}px, ${pane})`,
    // Below the split there is no rail and no viewer, so the column simply takes the page under the cap.
    // At Standard that is the DRAWER's width, so the two surfaces agree and the morph between them is a
    // translate; a wider choice makes it a rescale, as the 50/50 rule already does between 1200 and 1440.
    "--full-thread-narrow": `min(${thread}px, 100%)`,
    "--full-pane": pane,
    "--full-gutter": `max(0px, calc((100% - min(${thread}px, ${pane}) - ${RAIL_WIDTH}px) / 2))`,
  } as CSSProperties
}
