/** GITHUB'S OWN STATE PALETTE — Primer, for every mark in this app that stands for a GitHub
 *  thing: a PR's state, a CI verdict, a diffstat's two sides.
 *
 *  WHY IT IS NOT THIS APP'S PALETTE, and must never drift into it. Green/purple/red on an issue is a
 *  vocabulary the reader arrives already fluent in — they have just come from github.com, and the same
 *  mark for the same fact is one less thing to translate. Re-spelling a merged PR in accent-yellow
 *  would make a familiar object unreadable. These references resolve through theme.css's dedicated
 *  Primer palettes: a merged PR stays purple in either appearance, never Frizz accent-yellow.
 *
 *  WHY IT IS ONE MODULE AND NOT A LITERAL PER CALL SITE. Because it was the latter, and it drifted —
 *  which is the whole bug this file was written for. The hovercard spelled its greens in Primer while
 *  the PR watch row beside it, the GitHub picker and the file rail all reached for the nearest Tailwind
 *  hue, and the two landed in one screenshot (maintainer 2026-08-31: "These greens just don't match.
 *  They don't look good together. We should be trying to keep this using GitHub's palette"). Tailwind's
 *  hues are NOT near-misses for Primer's — measured as rendered sRGB, hue in HSV degrees:
 *
 *      mark            Tailwind v4          Primer dark              Δhue    ΔRGB
 *      open / passing  emerald-500 #00bc7d  fgColor-success #3fb950   32°      77   ← the reported clash
 *      closed          red-400     #ff6467  fgColor-danger  #f85149    4°      36
 *      merged          purple-400  #c27aff  fgColor-done    #ab7df8   10°      24
 *      running         amber-400   #ffb900  fgColor-attention #d29922  3°      65
 *
 *  32° is not a shade apart, it is a TEAL beside a green, and it sat directly under a `#238636` pill
 *  and a `#3fb950` "+316". (The amber row is history: that mark moved to Primer on 2026-08-29 for the
 *  same reason, one glyph at a time. This module is that fix finished.)
 *
 *  THE ORIGINAL DARK VALUES WERE MEASURED — read off github.com on 2026-08-31, both as the
 *  CSS custom properties on `<html>` and as the resolved `color` of the real octicons, which is the
 *  reading that actually settles which of the two families a mark takes:
 *
 *      octicon-git-pull-request         open PR, PR list      #3fb950
 *      octicon-git-merge                merged PR, PR list    #ab7df8
 *      octicon-git-pull-request-closed  closed PR, PR list    #f85149
 *      octicon-check                    passing check, PR     #3fb950
 *      octicon-alert                    failing check, PR     #f85149
 *
 *  THE TWO FAMILIES ARE NOT INTERCHANGEABLE, and picking the wrong one is the mistake this table
 *  exists to prevent. `fg*` is for a BARE MARK on the panel — a stroke glyph, a `+316`. `bg*Emphasis`
 *  is for a SOLID FILL — a state pill, a diffstat square. They are deliberately different values: a
 *  `#3fb950` square would out-shout the text it labels, and a `#238636` 12px glyph reads as muddy
 *  rather than green on a dark panel.
 *
 *  Re-measure, don't re-guess:
 *      getComputedStyle(document.documentElement).getPropertyValue("--fgColor-success")
 *  on any github.com page with `data-color-mode="dark"`. */
export const PRIMER = {
  /** `--fgColor-success` — an open PR/issue glyph, a passing check, a diffstat's `+N`. */
  fgSuccess: "var(--gh-fg-success)",
  /** `--bgColor-success-emphasis` — the "Open" pill's fill, a diffstat's added square. */
  bgSuccessEmphasis: "var(--gh-bg-success-emphasis)",

  /** `--fgColor-danger` — a closed-PR glyph, a failing check, a diffstat's `−N`. */
  fgDanger: "var(--gh-fg-danger)",
  /** `--bgColor-danger-emphasis` — the "Closed" pill's fill, a diffstat's deleted square. */
  bgDangerEmphasis: "var(--gh-bg-danger-emphasis)",

  /** `--fgColor-done` — a merged-PR glyph, a closed-as-completed issue glyph. */
  fgDone: "var(--gh-fg-done)",
  /** `--bgColor-done-emphasis` — the "Merged" pill's fill. */
  bgDoneEmphasis: "var(--gh-bg-done-emphasis)",

  /** `--fgColor-attention` — checks still running. Already worn by the in-progress spinner. */
  fgAttention: "var(--gh-fg-attention)",

  /** `--fgColor-neutral` — a draft PR's glyph. Near-identical to this app's own `--color-muted`
   *  (#8b8f96), so the change is invisible; it is here so one `StateIcon` speaks one palette rather
   *  than three arms of Primer and one of the theme. */
  fgNeutral: "var(--gh-fg-neutral)",
  /** `--bgColor-neutral-emphasis` — the "Draft" / "Closed as not planned" pill fill. */
  bgNeutralEmphasis: "var(--gh-bg-neutral-emphasis)",
  onEmphasis: "var(--gh-on-emphasis)",
} as const

/** Primer danger ink and decoration resolve through CSS, including the legacy dark ink alpha. */
export const PRIMER_DANGER_LINK = "text-[color:var(--gh-danger-link-fg)] decoration-[color:color-mix(in_srgb,var(--gh-danger-link)_30%,transparent)] hover:decoration-[color:var(--gh-danger-link)]"

/** A mark that expresses FRIZZ's own state rather than GitHub's — "not polled yet", a sub-agent's
 *  spinner — keeps the app's palette and must NOT be pulled in here. GitHub has no such state, so
 *  there is no Primer value that means it, and dressing it in one would claim a verdict frizz has not
 *  got yet. The line is: does this mark mirror something github.com itself draws? */
export type PrimerColor = (typeof PRIMER)[keyof typeof PRIMER]
