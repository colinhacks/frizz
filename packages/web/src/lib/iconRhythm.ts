/** HORIZONTAL rhythm for a strip of small marks — the sibling of `iconAlign.ts`, which does the same
 *  job vertically.
 *
 *  THE PROBLEM, stated once. `gap` spaces BOXES. The eye spaces INK. In a control strip those are not
 *  remotely the same measurement, because every mark wears a different amount of dead space inside its
 *  own box, from two independent sources:
 *
 *    1. the control's padding — a 24px hover square around a 12px glyph carries 6px a side;
 *    2. the GLYPH's own inset inside its svg — lucide's `Plug` paints only 8 of its 13 box px, while
 *       `RefreshCw` paints 10 of 12 and a bordered pill paints all of its box.
 *
 *  So a strip on one uniform `gap-1.5` drew SIX DIFFERENT distances. Measured on the shipped footer
 *  (`scripts/ink-gaps.mjs`, 2026-08-05, every CSS gap 6px):
 *
 *      context meter → hourglass    10.34px ink
 *      hourglass → heartbeat        12.50px
 *      plug → restart               20.50px   ← widest
 *      restart → Snooze pill        13.00px
 *      Snooze pill → Mark as done    5.78px   ← narrowest
 *
 *  A 3.5× spread, and the maintainer read it exactly off the pixels: "the perceived distance between
 *  the plug-in icon and the restart icon is much larger than the perceived distance between the
 *  restart icon and the left side of the snooze button, both of which are much larger than the space
 *  between the context icon and the heart… I'm sure the spacing is consistent in terms of the CSS, but
 *  what matters here is the visual spacing."
 *
 *  THE FIX. Collapse each mark's layout box onto its own ink with a negative margin equal to its
 *  MEASURED dead space, then let one `gap` mean what it says. After that the container's gap IS the
 *  ink gap, for pills and bare glyphs alike, and adding a mark to the strip is a one-line change
 *  rather than a re-tune.
 *
 *  THE STRIP THIS WAS WRITTEN FOR IS GONE. The lifecycle footer went on 2026-10-05: its context
 *  reading moved up into the header's second line (ContextMeter), its goal down into the composer rail
 *  below, and snooze and mark as done into the header's action strip as bare icons on that strip's
 *  uniform 28px squares (ThreadLifecycle.tsx), where every mark carries the same box and no trim
 *  applies. Its strip gap and its last trim (the snoozed alarm clock's) went with it.
 *
 *  What remains is the composer RAIL, whose marks sit at absolute offsets rather than on a gap — the
 *  same law applied per mark: each offset is chosen so the INK between neighbours, not their boxes,
 *  keeps one distance. Every constant below is a measurement, not a taste. Re-measure — never
 *  re-guess — if a glyph, an icon size, or a control's padding changes (`scripts/ink-gaps.mjs`, and
 *  read `deadLeft`/`deadRight` off each mark). */


/** THE RAIL, right to left: send, the microphone (only where on-device dictation exists — see
 *  lib/dictation.ts), the paperclip, the MCP plug
 *  (components/McpPlug.tsx), and the lead (the thread composer's Goal). Each is a 28px square; any of the middle marks may be absent, and
 *  the marks to its left close up.
 *
 *  What is measured is the BOX GAP between each pair of neighbours — the gap that puts their INK
 *  ~14.5px apart, given the dead space each glyph wears. The Send button is filled, so its ink is its
 *  box; the bare 15px icons carry 7–9px of empty box per side. Hover outlines do not take part in the
 *  resting rhythm. A pair missing from the table falls back to the paperclip→send gap; add the
 *  measurement rather than relying on it. */
export type RailMark = "lead" | "mcp" | "paperclip" | "mic" | "send"
const RAIL_ORDER: readonly RailMark[] = ["lead", "mcp", "paperclip", "mic", "send"]
const RAIL_BOX = 28
const RAIL_SEND_RIGHT = 8
// Clearance the prose keeps from the leftmost mark.
const RAIL_PROSE_CLEARANCE = 8

const RAIL_BOX_GAP: Partial<Record<`${RailMark}>${RailMark}`, number>> = {
  "paperclip>send": 8,
  // GoalMark at 15px paints 7px of dead box on its right against the paperclip's 8.25px on its left, so
  // the two hover squares overlap by a pixel of empty padding: 14.25px of ink between them, against
  // 14.75px from the paperclip to send. Measured on a real queue card with scripts/ink-gaps.mjs at dsf 4,
  // 2026-10-05; the two glyphs also read at one weight there (mean contrast 338.5 against 338.9).
  "lead>paperclip": -1,
  // The plug (16px, lucide's 2-unit pen) wears more dead box than the paperclip or the Goal, and its ink
  // sits half a pixel right of its box's centre: its square overlaps the paperclip's by 3px and the Goal's
  // by 2px of empty padding for 14.5px of ink on both sides, against 14.75px from the paperclip to send.
  // Measured on a real queue card and the new-thread box with scripts/ink-gaps.mjs at dsf 4, 2026-10-19.
  "mcp>paperclip": -3,
  "lead>mcp": -2,
  "mic>send": 6,
  "paperclip>mic": -2,
}

/** THE THREAD COMPOSER'S SEND IS A SPLIT BUTTON, not a 28px square: the word "Send", a hairline, and a
 *  caret that opens the two ways of sending (components/SendSplitButton.tsx, which owns these three
 *  widths and the readings behind them). It is still filled edge to edge, so its ink is its box and
 *  every gap in the table above holds unchanged — only the width the marks to its left clear grows. */
export const SEND_SPLIT_LABEL_WIDTH = 45.5
export const SEND_SPLIT_SEAM_WIDTH = 1
export const SEND_SPLIT_CARET_WIDTH = 23
export const SEND_SPLIT_WIDTH = SEND_SPLIT_LABEL_WIDTH + SEND_SPLIT_SEAM_WIDTH + SEND_SPLIT_CARET_WIDTH

/** Where each present mark sits (its CSS `right`, px) and how much right padding the prose keeps.
 *  `sendWidth` is the Send control's own width when it is not the 28px square. A fractional one is
 *  rounded UP for the marks beside it: the button is filled and may end on a half pixel, but a bare
 *  15px icon placed on one draws soft on a 1x screen. */
export function composerRail(present: { lead?: boolean; mcp?: boolean; mic?: boolean; sendWidth?: number }): {
  right: Partial<Record<RailMark, number>>
  reserve: number
} {
  const shown: Record<RailMark, boolean> = { send: true, paperclip: true, lead: !!present.lead, mcp: !!present.mcp, mic: !!present.mic }
  const marks = RAIL_ORDER.filter((m) => shown[m])
  const right: Partial<Record<RailMark, number>> = {}
  let edge = 0
  let neighbour: RailMark | null = null
  for (const mark of [...marks].reverse()) {
    right[mark] = neighbour ? edge + (RAIL_BOX_GAP[`${mark}>${neighbour}`] ?? RAIL_BOX_GAP["paperclip>send"]!) : RAIL_SEND_RIGHT
    edge = right[mark]! + (mark === "send" ? Math.ceil(present.sendWidth ?? RAIL_BOX) : RAIL_BOX)
    neighbour = mark
  }
  return { right, reserve: edge + RAIL_PROSE_CLEARANCE }
}
