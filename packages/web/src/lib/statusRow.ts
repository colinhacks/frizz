// The one icon-action treatment used by every button in the status row above the prompt box (settings,
// reload). It lives here rather than in StatusRow.tsx because RestartFrizzButton also needs it, and
// importing it from StatusRow — which itself renders RestartFrizzButton — would be an import cycle.
//
// 24px square: the WCAG 2.2 minimum pointer target, and the largest size that still reads as part of a
// 12px text strip rather than as chrome parked next to it. The old corner button was 32px, which
// out-weighed the owner/repo label once the two became neighbours.
//
// The hover fill is bg-hover-strong, every icon button's (styles.css, icon-focus-outline). It was
// bg-panel while the row was a corner CHIP with its own bg-panel fill, where the hover was the same
// colour as the surface behind it and simply stopped reading, and then bg-elevated until 2026-10-29.
//
// `-mx-1.5` IS THE 24px SQUARE'S DEAD SPACE, and it is what makes the row's one `gap` mean one
// distance. The square is the HOVER TARGET; the mark is the 14px glyph inside it, which paints 12px
// (measured, both glyphs, `scripts/ink-gaps.mjs --pad=0`) — so each button wears 6px of nothing a
// side. On a uniform `gap-2` that drew 20px of ink between the gear and the reload icon against 8px
// between the divider and the first quota chip, and the maintainer read the widest of them straight
// off the pixels (2026-08-14: "there's too much space between these two icons"). Collapsing the box
// onto the ink is the same fix lib/iconRhythm.ts documents for the old thread footer, and it leaves the
// two squares exactly touching at the row's `gap-3` rather than overlapping.
//
// RE-MEASURE, DON'T RE-GUESS, if STATUS_ROW_ICON or the square changes, or if a row action ever
// carries a glyph whose ink does NOT reach lucide's outer 24-unit bound — this constant is one
// number for both buttons only because their two glyphs happen to paint the same 12px:
//   nub scripts/ink-gaps.mjs http://localhost:<vite>/status-row-fixture.html \
//     '[data-status-row] button[aria-label="Settings"],[data-status-row] button[aria-label="Update Frizz"]' \
//     --dsf=4 --pad=0
const ACTION_SQUARE =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg/75 outline-none transition-colors hover:bg-hover-strong hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong disabled:opacity-55"
export const STATUS_ROW_ACTION = `-mx-1.5 ${ACTION_SQUARE}`

/** Icon size for every glyph in the row. Matched to the 24px target so no button reads heavier. */
export const STATUS_ROW_ICON = 14
