// Tool activity and transcript thoughts are peer progress rows. Keep their regular type scale,
// light-grey tone, and line box shared so alternating `N tool calls` / `Thought for Ns` rows have
// one rhythm without making thought metadata look like a separate petite-caps label system.
//
// 14px is the ASSISTANT PROSE size (`.md-body` in styles.css), and these rows deliberately match it
// (maintainer 2026-07-31, on a shot of `Ran 2 tool calls` above a reply: "is this the same font size?
// shoudl be"). They sat at 13px, which read as a second, smaller type scale interleaved with the
// prose rather than as the same column speaking quietly — the tone, not the size, is what makes these
// rows recede. Any glyph sized against this line must be `1em` so it follows.
export const TRANSCRIPT_META_LABEL_CLASS = "text-[14px] leading-5 text-muted"

// The DISCLOSURE CHEVRON of that same column — one measured treatment for the tool digest, the codex
// reasoning toggle and the live shimmer alike. Each used to place its own by hand and the three drifted:
// two different vertical offsets, two different tones, and a horizontal rhythm nobody had measured at
// all (maintainer 2026-08-05: "fix the fucking optical spacing on that chevron").
//
// VERTICAL — `items-center` centres the glyph's BOX on the flex line; the eye reads INK, and the two are
// never the same. The correction is DERIVED, not measured, because a measured one cannot survive this
// column: the prose font is a SETTING (`html[data-font]`), so these rows ship in a mono stack AND a sans
// stack whose cap heights differ, and a constant hand-fitted to one rides visibly high in the other —
// which is exactly what shipped (2026-08-05: "this is awful", under sans, from a correction measured at
// a 0.00px residual under mono).
//
//   `self-baseline` puts the glyph's bottom margin edge on the text baseline — a flex item with no
//   baseline of its own synthesises one there. Its ink centre is then `0.5em` above the baseline (the
//   lucide path is symmetric about its 24-unit box centre, in both orientations). The target is the
//   CAP BAND's centre, `0.5cap` above the baseline — the string-independent reference, because a
//   descender moves the string's own ink box by >1px. So the shift is exactly `0.5em - 0.5cap`, and
//   `1cap` is the BROWSER's cap height for whatever font actually resolved. Nothing to re-measure when
//   the font setting flips, the type scale changes, or a stack gains a fallback.
//
//   The negative TOP margin is what stops that from disturbing the column: a 1em box whose bottom sits
//   on the baseline reaches higher above it than the text's own ascent does, so it grew the row and
//   pushed the label down a pixel — enough to break the "shimmer reads as a peer of a settled meta
//   label" rhythm this column is measured on. Trimming the contributed height to `1cap` (never more
//   than the ascent) leaves the glyph exactly where baseline alignment put it while the TEXT goes back
//   to driving the line box. Margin-top does not move a baseline-aligned item; it only shortens what it
//   contributes above.
//
// HORIZONTAL — `gap` spaces BOXES, and this glyph is mostly empty box: lucide's chevron paints 8 of its
// 24 viewBox units across (6 of path + 1 of stroke either side), so a third of its 1em box is dead space
// on EACH side. On `gap-1` beside its label and `gap-2` before the shimmer's clock, the row therefore
// drew 9.06px and 13.00px of INK where the CSS claimed 4 and 8 — the chevron floated almost equidistant
// between the two and read as a third, unrelated mark instead of the label's handle (2026-08-05: "fix
// the fucking optical spacing on that chevron"). A negative margin sized to that dead space collapses
// the box onto the ink; after it, a container's `gap` IS the optical distance.
//
// The trim is STATE-DEPENDENT because rotating the glyph rotates its ink box — 8/24 units wide pointing
// right, 14/24 pointing down — so an open chevron wears only 0.208em of dead space a side. One constant
// for both would over-collapse the open state by ~1.8px, well above the instrument's ±0.75px noise floor.
// Both trims are pure viewBox geometry, so unlike the vertical they are font-independent.
const TRANSCRIPT_META_CHEVRON_BASE =
  "size-[1em] shrink-0 self-baseline -mt-[calc(1em_-_1cap)] translate-y-[calc(0.5em_-_0.5cap)] text-muted-70 transition-transform group-hover:text-fg"

export function transcriptMetaChevronClass(open: boolean): string {
  return `${TRANSCRIPT_META_CHEVRON_BASE} ${open ? "-mx-[0.208em] rotate-90" : "-mx-[0.333em]"}`
}
