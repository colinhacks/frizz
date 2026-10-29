import { X } from "lucide-react"
import type { ReactElement, ReactNode } from "react"
import { PANE_HEADER_HEIGHT_CLASS } from "../../lib/paneHeaderHeight.ts"

// The one side-sheet header bar. A fixed-height row (the pane-header height, px-4) with the close
// button LEADING (SheetClose), an optional icon, the title (carrying optional inline `meta` — e.g. a
// background shell's "running 3 min" — and/or a stacked `subtitle` line — e.g. a doc drawer's
// "<slug>.md"), and optional trailing `actions` (settings' "● unsaved"). Replaces six near-identical
// hand-rolled headers that had drifted in height (h-11 vs h-12), padding (px-3 / px-4 / px-5), title
// weight, and close-button padding.
export function SheetHeader({
  title,
  subtitle,
  icon,
  meta,
  actions,
  onClose,
}: {
  title: string
  subtitle?: string
  icon?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  onClose: () => void
}): ReactElement {
  return (
    <header className={`flex ${PANE_HEADER_HEIGHT_CLASS} shrink-0 items-center gap-2.5 border-b border-border bg-panel px-4`}>
      <SheetClose onClose={onClose} />
      {icon}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium" title={title}>
            {title}
          </span>
          {meta}
        </div>
        {subtitle && <span className="truncate text-[10px] text-muted-60">{subtitle}</span>}
      </div>
      {actions}
    </header>
  )
}

// Every sheet's close: a bare X and a hairline rule, LEADING the header. Every sheet slides out to the
// RIGHT, so the X sits at the edge it leaves from and the right end is left to the sheet's own
// controls; the rule marks the X as the sheet's chrome rather than the first word of the title
// (maintainer 2026-10-08). The thread drawer's header is not a SheetHeader, so it renders this too.
//
// Both headers place it in a `gap-2.5` row whose content starts 16px in (`px-4` here; `px-3` plus the
// title group's `pl-1` there), so one set of margins spaces it in both:
//   · `-ml-1` pulls the X's hover square 4px into that padding, so its INK sits 21.75px from the
//     sheet's edge, where the thread header's trailing check sits 21px from the other.
//   · the rule's `ml-px` / `mr-[9px]` put it 20.75px of ink from the X and 20.3px from the title's
//     first letter, against the 20.75 and 20.17 the action strip keeps either side of its own rule
//     (ThreadLifecycle). `mr-2.5` read 21.3.
// Ink measured 2026-10-08 on the real thread drawer: path rects of the 15px lucide X, the title's
// text range. Re-measure rather than re-guess if the gap, the padding or the glyph changes.
//
// NO EDGE: a hover fills the square and draws no outline, so nothing frames the X but the fill. It also
// takes no initial focus — a programmatically focused button matches :focus-visible, which lit a ring
// around the X whenever a drawer opened from the keyboard or a link — so the sheet itself takes focus
// on open, as MobileThreadHeader's ← does. Tab still reaches the X and draws the focus ring.
export function SheetClose({ onClose }: { onClose: () => void }): ReactElement {
  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="-ml-1 shrink-0 rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-hover-strong hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
      >
        <X size={15} />
      </button>
      <span aria-hidden data-close-rule className="ml-px mr-[9px] h-4 w-px shrink-0 bg-border" />
    </>
  )
}
