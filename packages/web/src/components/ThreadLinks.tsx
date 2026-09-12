import { ExternalLink, FileText } from "lucide-react"
import type { ThreadLinkView } from "@frizz/shared"
import { CHILD_ARROW, CHILD_ARROW_CLASS, CHILD_KIND_TAG_CLASS, CHILD_MARK_SLOT_CLASS } from "../lib/childOps.ts"
import { openLocalPath } from "../lib/local-file-links.ts"

// The activity-row grammar, without a liveness marker or a trailing open icon — and the SAME grammar,
// column for column: a File/Link row renders under the ⤷ AGENT / ⤷ SHELL rows and the eye runs down one
// label column, so it takes their box, their 9px mark slot and their tag column rather than its own.
// THE ROW'S BOX IS THE CHILD-OP ROW'S BOX: no vertical padding and the inherited line-height, so a
// File/Link row measures exactly what the ⤷ AGENT / ⤷ SHELL rows above it measure (17.25px on the
// strip's 2px gap). It shipped with `py-0.5 leading-5`, which made each of these rows 25px against
// 17.25px and the column visibly looser than the live rows it continues (maintainer 2026-09-11:
// "It should be the exact same spacing and padding"). `items-baseline` stays: the icon's
// `self-baseline` cap-band correction below has nothing to align to on an `items-center` row.
// THE LABEL STARTS WHERE EVERY OTHER LABEL STARTS: the slot and the tag come from lib/childOps.ts, and
// the tag's width is the shared per-font track in styles.css (`.frizz-kind-tag`). This row used to
// give itself a 1em slot, a 9px tag and a 33px tag column, which put its label 14.1px right of a SHELL
// row's in mono and 7.2px in sans (maintainer, same day: "The label is further to the right. Why?
// There's no reason for that at all"). Ink gaps after, scripts/ink-gaps.mjs at dsf 6, mono: arrow→icon
// 6.10px and icon→tag 6.25px against a SHELL row's 5.02 / 5.83 (inside the instrument's ±1px floor — the
// dot's halo pulses); tag→label 12.21px against 8.04, the one gap the shared column widens, because
// `File` is four letters in a five-letter track. Label x: 61.89px in every row in mono, 73.44px in sans.
const ROW ="group flex min-w-0 items-baseline gap-1.5 rounded-sm text-left text-[11.5px] outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60"
// The SLOT is the baseline-aligned item, not the icon: an svg has no baseline of its own, so the slot's
// is synthesized from the svg's bottom edge, and that edge lands on the label's baseline. `-mt-[1em]`
// collapses the slot's OUTER box onto that edge — a baseline-aligned flex item counts its whole outer
// box above the baseline, and the mono label's ascent (≈11.2px at 11.5px) is shorter than the 1em icon,
// so without the trim the icon set the row 0.5px taller than an AGENT row and pushed the label 0.5px
// down with it (sans, whose ascent is 13px, never showed it). Nothing painted moves; only what the
// row's height arithmetic sees does.
const ICON_SLOT = `${CHILD_MARK_SLOT_CLASS} -mt-[1em] self-baseline`
// Both glyphs are symmetric vertically; `0.5em − 0.5cap` lifts the icon's centre onto the cap band of
// whichever font is resolved. Measured ink-to-cap residual: 0px in sans and mono, desktop and 390px.
const ICON = "h-[1em] w-[1em] shrink-0 translate-y-[calc(0.5em_-_0.5cap)] text-muted-45"

export function ThreadLinks({ links }: { links: readonly ThreadLinkView[] }) {
  if (!links.length) return null
  return (
    <div data-thread-links aria-label="Registered links" className="mt-2 flex min-w-0 flex-col gap-0.5 border-t border-border pt-1.5">
      {links.map((link) => {
        const isUrl = link.kind === "link"
        const Icon = isUrl ? ExternalLink : FileText
        const content = <>
          <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
          <span className={ICON_SLOT}><Icon aria-hidden className={ICON} /></span>
          <span data-link-kind className={CHILD_KIND_TAG_CLASS}>{isUrl ? "Link" : "File"}</span>
          <span data-link-label className="min-w-0 flex-1 truncate text-muted-70 group-hover:text-fg/80 group-hover:underline">{link.label}</span>
          {/* `-mb-[0.5em]`: the destination is mono at 10px in a 15px line box whose baseline sits at
              ~60% of it, so beside a SANS label (baseline at ~75% of ITS box) it hung 1.75px below the
              label's line box and made the Link row 19px against every other row's 17.25px. The
              negative margin trims what the row's height arithmetic sees; the box itself — and so
              what `truncate` clips — is unchanged. */}
          {isUrl && <span data-link-destination className="font-mono-keep ml-auto -mb-[0.5em] max-w-[45%] min-w-0 truncate text-right text-[10px] text-muted-45">{link.target}</span>}
        </>
        return isUrl ? (
          <a key={link.id} data-thread-link={link.id} href={link.target} target="_blank" rel="noopener noreferrer" title={link.target} className={ROW} onClick={(event) => event.stopPropagation()}>{content}</a>
        ) : (
          <button key={link.id} data-thread-link={link.id} type="button" title={link.target} className={`${ROW} cursor-pointer`} onClick={(event) => { event.stopPropagation(); openLocalPath(link.target) }}>{content}</button>
        )
      })}
    </div>
  )
}
