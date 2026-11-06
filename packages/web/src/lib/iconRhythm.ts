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


/** ONE PEN AND ONE SIZE FOR EVERY BARE MARK IN THE PROMPT BOX (maintainer 2026-11-06: "Let's make sure that
 *  there's consistency in the icons here. The paperclip still looks way bigger than the other ones.").
 *
 *  Each mark is sized by what it PAINTS, because a shared box size means nothing here: lucide's plug paints
 *  10 of its 16 box px and its paperclip 13 of 15. Readings at a real 2x, with each mark isolated (width x
 *  height of the ink, then its ink mass in square px):
 *
 *    before    paperclip 13 x 14, 67.2 · Goal 13 x 13, 76.9 · mic 10 x 14, 48.4 · plug 10 x 15, 48.7
 *    now       paperclip 11 x 12, 52.0 · Goal 11 x 11, 59.4 · mic  9 x 12, 40.2
 *              plug 12 x 12, 42.9 · gauge 13 x 11.5, 39.9
 *
 *  The Goal and the paperclip keep the most mass because they are drawn with the most line, and with the pen
 *  fixed a smaller size barely changes that (the paperclip at 12px: 50.8). What the five share is their height.
 *
 *  The pen is the 1.17px every 14px lucide glyph in the status row already paints. The send arrow keeps its
 *  own 1.46px: it sits inside a filled button, where it is read against the fill. */
const MARK_PEN = 7 / 6
const MARK_GLYPH_BOX = 14

/** Lucide props that draw a glyph at `ink` px (the size its 24-unit grid would be drawn at) with the one
 *  pen, inside an even 14px box. The viewBox carries the scale so the box stays even: a 12.5px svg centres
 *  in a 28px square on a quarter pixel and blurs on a 1x screen. */
export function markGlyph(ink: number): { size: number; viewBox: string; strokeWidth: number } {
  const span = (24 * MARK_GLYPH_BOX) / ink
  const inset = (24 - span) / 2
  return { size: MARK_GLYPH_BOX, viewBox: `${inset} ${inset} ${span} ${span}`, strokeWidth: (MARK_PEN * 24) / ink }
}

export const PAPERCLIP_GLYPH = markGlyph(12.5)
export const GOAL_GLYPH = markGlyph(12.5)
export const MIC_GLYPH = markGlyph(13)

/** The usage gauge is drawn for its box, so it needs no scaling: 14px on its 2-unit pen is the one pen. */
export const GAUGE_GLYPH_SIZE = MARK_GLYPH_BOX
/** THE PLUG IS DIAGONAL (maintainer 2026-11-06: "I like the diagonal plug"). Upright it paints 10 x 15, a tall
 *  sliver beside the round gauge; turned 45° it paints 12 x 12. Prongs up and to the right: at -45° it read as
 *  a slashed "off" icon. Turning it leaves its ink 0.75px up and right of the box's centre, which the translate
 *  takes back. */
export const PLUG_GLYPH = {
  size: 16,
  strokeWidth: (MARK_PEN * 24) / 16,
  style: { transform: "translate(-0.75px, 0.75px) rotate(45deg)" },
} as const

/** THE AGENT'S MARKS beside the model chip (components/AgentMarks.tsx). Each is the paperclip's own 28px
 *  square, hover fill and tone, trimmed onto its ink so the row's one gap is a distance of ink: 11.5px of box
 *  gap draws about 12px between the gauge and the plug, the same as from the chip's border to the gauge.
 *  The two squares overlap by about 3.75px of empty padding. Only one can paint a fill at a time. */
export const AGENT_MARKS = "ml-1.5 flex shrink-0 items-center gap-[11.5px] empty:hidden"
const AGENT_MARK = "icon-focus-outline relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted outline-none transition-[color,background-color] hover:bg-hover-strong hover:text-fg aria-expanded:bg-hover-strong aria-expanded:text-fg"
export const GAUGE_MARK = `-mx-[7.5px] ${AGENT_MARK}`
export const PLUG_MARK = `-mx-[7.75px] ${AGENT_MARK}`

/** THE RAIL, right to left: send, the microphone (only where on-device dictation exists — see
 *  lib/dictation.ts), the paperclip, and the lead (the thread composer's Goal). Each is a 28px square; any of
 *  the middle marks may be absent, and the marks to its left close up.
 *
 *  What is measured is the BOX GAP between each pair of neighbours — the gap that puts their INK
 *  ~14.5px apart, given the dead space each glyph wears. The Send button is filled, so its ink is its
 *  box; the bare marks carry 8–9px of empty box per side. Hover outlines do not take part in the
 *  resting rhythm. A pair missing from the table falls back to the paperclip→send gap; add the
 *  measurement rather than relying on it. */
export type RailMark = "lead" | "paperclip" | "mic" | "send"
const RAIL_ORDER: readonly RailMark[] = ["lead", "paperclip", "mic", "send"]
const RAIL_BOX = 28
const RAIL_SEND_RIGHT = 8
// Clearance the prose keeps from the leftmost mark.
const RAIL_PROSE_CLEARANCE = 8

const RAIL_BOX_GAP: Partial<Record<`${RailMark}>${RailMark}`, number>> = {
  // The paperclip's 11px of ink wears 8.5px of dead box a side, the Goal's the same and the microphone's 9.5px.
  // Painted pixels at a real 4x, 2026-11-06: paperclip→send 14.25, Goal→paperclip 14.50, paperclip→mic 14.75,
  // mic→send 14.50. The squares overlap by empty padding where the gap is negative.
  "paperclip>send": 6,
  "lead>paperclip": -3,
  "mic>send": 5,
  "paperclip>mic": -3,
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
 *  icon placed on one draws soft on a 1x screen. */
export function composerRail(present: { lead?: boolean; mic?: boolean; sendWidth?: number }): {
  right: Partial<Record<RailMark, number>>
  reserve: number
} {
  const shown: Record<RailMark, boolean> = { send: true, paperclip: true, lead: !!present.lead, mic: !!present.mic }
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
