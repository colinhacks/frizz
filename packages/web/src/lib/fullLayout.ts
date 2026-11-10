import type { CSSProperties } from "react"
import { SHEET_BASE_WIDTH } from "./sheet.ts"

// The full-screen page's lengths and the focus rail's width, read by that page (StandaloneThreadPage) and
// by the board's one-thread pane (ThreadPane). They live here rather than in either component because the
// page and the rail are in the lazy thread-surfaces chunk (components/lazySurfaces.tsx), and a constant
// imported from them would carry their whole modules into the board's entry chunk.

// The rail's width, in px — the side pane on /full is exactly this wide while nothing covers it. 340
// rather than the mockup's 300: the card's rows were fitted at a 368px card, and at 300 a PR row
// truncated to "colinhacks/zod#…" — the one part of the ref that names the PR (2026-08-28).
export const RAIL_WIDTH = 340

/**
 * THE WHOLE GEOMETRY OF /full, as three lengths that depend on the PAGE WIDTH AND NOTHING ELSE — not
 * on whether a file is open, which is the point (see the layout comment below). Percentages resolve
 * against the row, which is the page minus the project rail, so a `vw` here would be wrong on a
 * board that shows one.
 *
 *   thread = half the page, capped at the drawer's width
 *   pane   = everything the thread does not take
 *   gutter = the slack left beside the pair once the rail has its 340
 *
 * `thread + pane` is exactly the page at every width (below 1440 both are half; above it the thread
 * pins at 720 and the pane takes the rest), which is what makes the open state a 50/50 read on a
 * 1200px screen — "600px of content, and then the file takes up 600px" (maintainer 2026-08-30) —
 * without either column having to change size to get there.
 */
const PANE_W = `max(50%, calc(100% - ${SHEET_BASE_WIDTH}px))`
export const LAYOUT_VARS = {
  "--full-thread": `min(${SHEET_BASE_WIDTH}px, ${PANE_W})`,
  // Below the split there is no rail and no viewer, so the column simply takes the page under the cap
  // — which is the DRAWER's width, so the two surfaces agree and the morph between them is a translate.
  "--full-thread-narrow": `min(${SHEET_BASE_WIDTH}px, 100%)`,
  "--full-pane": PANE_W,
  "--full-gutter": `max(0px, calc((100% - min(${SHEET_BASE_WIDTH}px, ${PANE_W}) - ${RAIL_WIDTH}px) / 2))`,
} as CSSProperties
