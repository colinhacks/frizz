// Shared side-sheet primitives — the timing, width curve, scrim, and panel classes that the whole
// right-side drawer family (thread / doc / plan / sub-agent / background-shell) and the settings drawer
// render with. Extracted so these can never drift apart again: they had been copied near-identically
// across six files, and small divergences crept in (settings' scrim was bg-scrim-55, the rest /40).
// One scrim darkness, one slide duration, one width formula, one reduced-motion check.

// Slide-out duration. A layer is removed from the drawer stack (or the settings panel unmounts) after
// this elapses — kept ~10ms past the 200ms CSS transition so removal lands just after the slide ends.
export const SHEET_CLOSE_MS = 210

// The full-screen backdrop: one uniform scrim darkness (bg-scrim-40) that fades with the panel. Layout
// is the consumer's: a plain sheet parks its panel against the right edge by adding `flex justify-end`,
// while ThreadSheet's Radix overlay is a bare scrim whose content is a separately-positioned portal
// sibling — so this string is exactly ThreadSheet's overlay className minus the opacity toggle.
export const SHEET_SCRIM_CLASS =
  "fixed inset-0 bg-scrim-40 backdrop-blur-[1px] transition-opacity duration-200 ease-out motion-reduce:transition-none"

// The sliding panel: right-anchored, full-height, bordered, elevated; slides along the X axis. The
// consumer appends the translate toggle (translate-x-0 / translate-x-full) and its own width.
export const SHEET_PANEL_CLASS =
  "frizz-sheet-panel flex h-full flex-col border-l border-border bg-panel shadow-2xl shadow-black/50 transition-transform duration-200 ease-out motion-reduce:transition-none"

// The stack width curve: each STAYING layer below steps the panel 28px / 4vw narrower so the stack
// reads as a stack. `offset` pulls the effective depth back — ThreadDrawer passes 1 because the frizz-doc
// is a "flip surface" of the chat drawer for the same thread, not a genuine extra layer, so it must
// render at the width of the drawer beneath it (depth-1) rather than one step narrower.
// The depth-0 panel width, exported because the fullscreen page's thread column caps at the SAME
// width — the maintainer wants /full to read like the drawer, not wider (2026-08-31).
export const SHEET_BASE_WIDTH = 720

/**
 * WHERE THE PAGE BECOMES TWO COLUMNS. Below this it is one thread column at the drawer's own width;
 * at and above it the 50/50 rule in StandaloneThreadPage's LAYOUT_VARS takes over.
 *
 * It is 1200 because 1200 is the width the split was SPECIFIED at — "600px of content, and then the
 * file takes up 600px" (maintainer 2026-08-30) — so switching exactly there keeps that reading intact
 * and gives every narrower window a transcript worth reading. Two things were wrong before:
 *
 *   • The LAYOUT split at `md` (768), where the thread column fell from 720px to 384px on one pixel of
 *     resize and then sat beside a 340px rail usually reading "Nothing running, watched or edited yet".
 *   • The FILE-CLICK gate was a separate `1000px` media query, so between 768 and 999 the rail was on
 *     screen while a file click still fell back to the overlay drawer. One number now drives both.
 *
 * A consequence worth knowing, because it is what the maintainer asked after (2026-09-02: "the chat
 * column widths are always the same in both views?"): the board's card and drawer are 720 wide, and so
 * is this column below 1200 and again at 1440+, which makes the fullscreen morph a pure translate at
 * those sizes. Between 1200 and 1440 the 50/50 rule puts this column at 600–719 against the drawer's
 * 720, so the morph rescales by up to 120px there. The two rules cannot both hold at 1200; the
 * specified 50/50 wins, and the mismatch shrinks to nothing by 1440. The mirror of the CSS
 * `--breakpoint-split` in styles.css, which draws the `split:` variant — change them together.
 */
export const SPLIT_MIN_PX = 1200

export function sheetWidth(widthDepth: number, offset = 0): string {
  const depth = Math.max(0, widthDepth - offset)
  return `min(${SHEET_BASE_WIDTH - depth * 28}px, ${80 - depth * 4}vw)`
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}
