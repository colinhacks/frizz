/** The strip's SQUARE alone: its size, its corner, where the glyph sits in it. Separate from the tones
 *  below because one surface draws this strip off the theme: the lightbox viewer is near-black in both
 *  palettes, so it cannot read `text-muted` or `bg-panel-2`, and it spells the dark palette's tones
 *  itself (components/Lightbox.tsx). The geometry is the half that must not drift, so it is shared. */
export const HEADER_ICON_SQUARE = "flex h-7 w-7 shrink-0 items-center justify-center rounded-md outline-none"

/** ONE class string for every icon control in a thread's top action strip.
 *
 *  The strip is rendered identically by the queue card's header and the thread header (see
 *  HeaderActions), and it carries verbs from several modules — the navigation icons HeaderActions
 *  owns, the fullscreen door, the lifecycle verbs, and Restart worker, which moved up out of the
 *  lifecycle footer on 2026-08-26 (maintainer: "the restart worker button should be at the top… it
 *  shouldn't be along the bottom"). It arrived wearing the FOOTER's chrome — a 24px square at
 *  `text-fg/55` with a hand-measured ink trim for that strip's 12px ink rhythm — and none of it
 *  transfers: this strip is 28px squares at `text-muted` on a flat `gap-0.5`. Sharing the string is
 *  what stops an imported verb reading as a different family from the icons beside it.
 *
 *  Its hover fill is every icon button's, `bg-hover-strong` (styles.css, icon-focus-outline). It was
 *  `bg-panel-2` until 2026-10-29, five levels over the card's own `bg-panel`: with the hover edge gone
 *  that step was the whole of the hover, and it did not read.
 *
 *  It lives here rather than in HeaderActions.tsx because several of those buttons are imported BY
 *  that file; taking the constant from it would close an import cycle. */
export const HEADER_ICON_CLASS =
  `icon-focus-outline ${HEADER_ICON_SQUARE} text-muted transition-colors hover:bg-hover-strong hover:text-fg disabled:hover:bg-transparent disabled:hover:text-muted disabled:opacity-40`
