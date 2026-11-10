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
 *              plug 12 x 12, 42.9 · gauge 13 x 11.5, 39.9 (both drawn smaller since: GAUGE_GLYPH)
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
 *  in a 24px square on a quarter pixel and blurs on a 1x screen. */
export function markGlyph(ink: number): { size: number; viewBox: string; strokeWidth: number } {
  const span = (24 * MARK_GLYPH_BOX) / ink
  const inset = (24 - span) / 2
  return { size: MARK_GLYPH_BOX, viewBox: `${inset} ${inset} ${span} ${span}`, strokeWidth: (MARK_PEN * 24) / ink }
}

export const PAPERCLIP_GLYPH = markGlyph(12.5)
export const GOAL_GLYPH = markGlyph(12.5)
export const MIC_GLYPH = markGlyph(13)

/** THE GAUGE AND THE PLUG ARE SIZED BY THE OUTLINE THEY ENCLOSE (maintainer 2026-11-07: "the quota gauge seems
 *  a lot visually bigger than the microphone icon and the paperclip icon"). Matching heights left them the two
 *  biggest marks in the box: a round dial and a diagonal plug wrap far more area than a paperclip or a
 *  microphone of the same height. Convex-hull area of all the ink, faint included, in square px at a real 4x,
 *  each mark isolated, the dial reading 83%:
 *
 *    before    gauge 125 (13 x 11.5) · plug 105 (12 x 12) · paperclip 87 (11 x 12) · mic 77 (9 x 12)
 *    now       gauge 102 (11.75 x 10.25) · plug 89 (11 x 11.25)
 *
 *  The plug now encloses the paperclip's area. The dial still encloses more, but the faint track (42% opacity)
 *  is part of that ring, and on the real footer, with a full tank lighting all of it, a dial drawn at the
 *  paperclip's 12.5px reads as the paperclip's size; at 11.75px it read smaller than the microphone. The pen is
 *  the one pen, so neither mark gets lighter as it shrinks. */
export const GAUGE_GLYPH = markGlyph(12.5)
/** THE PLUG IS DIAGONAL (maintainer 2026-11-06: "I like the diagonal plug"). Upright it paints a tall sliver
 *  beside the round gauge; turned 45° it is as wide as it is tall. Prongs up and to the right: at -45° it read
 *  as a slashed "off" icon. Turning it leaves its ink up and right of the box's centre, which the translate
 *  takes back. */
export const PLUG_GLYPH = {
  ...markGlyph(14.5),
  style: { transform: "translate(-0.68px, 0.68px) rotate(45deg)" },
} as const

/** THE PROMPT BOX'S BOTTOM ROW SITS IN ITS CORNERS (maintainer 2026-11-07, of the model chip's corner: "There's
 *  clearly an unnecessary amount of space, like padding-bottom here. The buttons, the radius of the prompt box,
 *  and the model selector button don't even slot together in a good way."). Measured on the real thread box:
 *
 *    before    box corner 12px · chip 22px tall, 6px corner, 9px from the left edge and 12px from the bottom
 *              Send 28px tall, 8px corner, 9px from the right edge and the bottom · rail squares 28px
 *    now       every control on the row 24px tall with a 6px corner, 8px from each box edge it meets
 *              box corner 6 + 8 = 14px, so each corner control's arc shares its centre with the box's
 *
 *  Three heights, two insets and no shared arc became one of each, and the empty box dropped from 82px to 73px:
 *  the text keeps one line of its own above the row (Composer's textarea), and the row keeps the 8px inset.
 *  The chip's label lands on the prose's left edge, 15px in, as a side effect of the 8px inset.
 *
 *  `PROMPT_ROW_INSET` is measured from inside the box's 1px border, which is what `bottom`, `right` and
 *  padding are measured from. A box with no footer row centres its rail on its one line instead: the
 *  textarea's 44px with a 24px square is 10px either side, where the rail's centre has always sat. */
export const PROMPT_ROW_INSET = 7
export const PROMPT_ROW_INSET_SINGLE_LINE = 10
/** The bordered box itself, and the drop hint that covers it. */
export const PROMPT_BOX_CORNER = "rounded-[14px]"
/** The footer row: the 24px controls on the 7px inset, below and to the left. */
export const PROMPT_FOOTER_ROW = "min-h-[31px] pb-[7px] pl-[7px]"
/** A rail mark's square (the Goal, the paperclip, the microphone, the plain send): the chip's height and corner. */
export const RAIL_MARK_SQUARE = "h-6 w-6 rounded-md"

/** THE AGENT'S MARKS beside the model chip (components/AgentMarks.tsx): the paperclip's hover fill and tone at the
 *  chip's own 24px height and 6px corner, trimmed onto its ink so the row's one gap is a distance of ink: the
 *  rail's ~14.5px (RAIL_BOX_GAP), so one distance runs between every mark in the box.
 *
 *  EACH IS 28PX WIDE, SO NEIGHBOURS OVERLAP AND THERE IS NO DEAD GAP BETWEEN THEM (maintainer 2026-11-09: "a little
 *  overlap is fine ... there's a gap between them, which means that the tap target is just unnecessarily small").
 *  At that ink distance the gauge and the plug share a 1.7px band, and the later in the DOM, the plug, takes the
 *  pointer there. They stood 2.3px apart for two days after both were seen lit at once, which shrank both targets
 *  and fixed the wrong thing: the fault was two lit at once, which AgentMarks.tsx now rules out.
 *
 *  THE FILL FADES IN AND GOES OUT AT ONCE. Fading out while the neighbour fades in is two lit at once for 150ms,
 *  so the fill's transition lives on the lit states alone. `data-quiet` is a mark standing down while its
 *  neighbour's panel is open: it takes no hover (AgentMarks.tsx). */
export const AGENT_MARKS = "ml-[9px] flex shrink-0 items-center gap-[15px] empty:hidden"
const AGENT_MARK = "icon-focus-outline relative flex h-6 w-7 rounded-md shrink-0 items-center justify-center text-muted outline-none transition-[color] not-data-[quiet]:hover:bg-hover-strong not-data-[quiet]:hover:text-fg not-data-[quiet]:hover:transition-[color,background-color] aria-expanded:bg-hover-strong aria-expanded:text-fg aria-expanded:transition-[color,background-color]"
export const GAUGE_MARK = `-mx-[8.2px] ${AGENT_MARK}`
export const PLUG_MARK = `-mx-[8.5px] ${AGENT_MARK}`

/** THE RAIL, right to left: send, the microphone (only where on-device dictation exists — see
 *  lib/dictation.ts), the paperclip, and the lead (the thread composer's Goal). Each is a 24px square
 *  (RAIL_MARK_SQUARE); any of the middle marks may be absent, and the marks to its left close up.
 *
 *  What is measured is the BOX GAP between each pair of neighbours — the gap that puts their INK
 *  ~14.5px apart, given the dead space each glyph wears. The Send button is filled, so its ink is its
 *  box; the bare marks carry 6–7px of empty box per side. Hover outlines do not take part in the
 *  resting rhythm. A pair missing from the table falls back to the paperclip→send gap; add the
 *  measurement rather than relying on it. */
export type RailMark = "lead" | "paperclip" | "mic" | "send"
const RAIL_ORDER: readonly RailMark[] = ["lead", "paperclip", "mic", "send"]
const RAIL_BOX = 24
const RAIL_SEND_RIGHT = PROMPT_ROW_INSET
// Clearance the prose keeps from the leftmost mark.
const RAIL_PROSE_CLEARANCE = 8

const RAIL_BOX_GAP: Partial<Record<`${RailMark}>${RailMark}`, number>> = {
  // The paperclip's 11px of ink wears 6.5px of dead box a side, the Goal's the same and the microphone's 7.5px.
  // Each gap is the 28px square's measured gap plus the 2px a side the 24px square gave back: painted pixels at
  // a real 4x, 2026-11-06, on 28px squares, paperclip→send 14.25, Goal→paperclip 14.50, paperclip→mic 14.75,
  // mic→send 14.50, re-measured on 24px squares in the commit that made them. No rail mark holds its fill when
  // the pointer leaves it, so at most the hovered one is ever lit.
  "paperclip>send": 8,
  "lead>paperclip": 1,
  "mic>send": 7,
  "paperclip>mic": 1,
}

/** THE THREAD COMPOSER'S SEND IS A SPLIT BUTTON, not a 24px square: the word "Send", a hairline, and a
 *  caret that opens the two ways of sending (components/SendSplitButton.tsx, which owns these three
 *  widths and the readings behind them). It is still filled edge to edge, so its ink is its box and
 *  every gap in the table above holds unchanged — only the width the marks to its left clear grows. */
export const SEND_SPLIT_LABEL_WIDTH = 45.5
export const SEND_SPLIT_SEAM_WIDTH = 1
export const SEND_SPLIT_CARET_WIDTH = 23
export const SEND_SPLIT_WIDTH = SEND_SPLIT_LABEL_WIDTH + SEND_SPLIT_SEAM_WIDTH + SEND_SPLIT_CARET_WIDTH
/** The button alone, for a thread with only one way to send: no seam and no caret. The word sits 9.6px
 *  from the left edge (SendSplitButton), so this leaves it about the same to the right. */
export const SEND_SOLO_WIDTH = 47.5

/** Where each present mark sits (its CSS `right`, px) and how much right padding the prose keeps.
 *  `sendWidth` is the Send control's own width when it is not the 24px square. A fractional one is
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
