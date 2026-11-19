import { ArrowLeft, X } from "lucide-react"
import type { ReactElement, ReactNode } from "react"
import { PANE_HEADER_HEIGHT_CLASS } from "../../lib/paneHeaderHeight.ts"

// The one side-sheet header bar. A fixed-height row (the pane-header height, px-4) with the close
// button LEADING (SheetClose), an optional icon, the title (carrying optional inline `meta` — e.g. a
// background shell's "running 3 min" — and/or a stacked `subtitle` line — e.g. a doc drawer's
// "<slug>.md"), and optional trailing `actions` (settings' "● unsaved"). Replaces six near-identical
// hand-rolled headers that had drifted in height (h-11 vs h-12), padding (px-3 / px-4 / px-5), title
// weight, and close-button padding.
//
// ON A PHONE A SHEET IS A PAGE (styles.css `.frizz-sheet-panel`), so its bar is the phone thread header's
// (MobileThreadHeader): 56px, the ← its 44px circle, the title at 16.5px and the line under it at 13.
// Until 2026-11-19 a sub-agent, a shell or a document opened from a phone's thread wore the desktop bar
// under that thread's phone one: a 27px ×, a 13px title and a 10px path.
//
// `subtitlePath`: the subtitle is a file's path, which is cut at its START. The title is already the
// file's name, so what a narrow bar has to keep is the folders nearest it, and an ordinary truncation kept
// "/Users/…/Documents/…" and dropped them.
export function SheetHeader({
  title,
  subtitle,
  subtitlePath = false,
  icon,
  meta,
  actions,
  onClose,
}: {
  title: string
  subtitle?: string
  subtitlePath?: boolean
  icon?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  onClose: () => void
}): ReactElement {
  return (
    <header className={`flex ${PANE_HEADER_HEIGHT_CLASS} shrink-0 items-center gap-2.5 border-b border-border bg-panel px-4 ${PHONE_SHEET_BAR}`}>
      <SheetClose onClose={onClose} />
      {/* No icon on a phone: its bar is two lines there, and a glyph centred on two lines floats between
          them (MarkdownDrawer has the measurement). */}
      {icon && <span className="contents phone:hidden">{icon}</span>}
      <div className="flex min-w-0 flex-1 flex-col justify-center phone:pl-0.5 phone:leading-[1.25]">
        {/* On a phone the `meta` goes UNDER the title, as the line a thread's header keeps there: beside it,
            a shell's "running 1h 25m" cut its title to "Running the sync load t…". */}
        <div className="flex min-w-0 items-center gap-2 phone:flex-col phone:items-start phone:gap-0 phone:[&>:nth-child(2)]:text-[13px] phone:[&>:nth-child(2)]:text-muted">
          <span className={`min-w-0 truncate text-[13px] font-medium phone:max-w-full ${PHONE_SHEET_TITLE}`} title={title}>
            {title}
          </span>
          {meta}
        </div>
        {subtitle && (
          // A path keeps its END: the box runs right to left, so the ellipsis lands on the left, and the
          // isolate keeps the path itself reading left to right.
          <span className={`truncate text-[10px] text-muted-60 phone:text-[13px] phone:text-muted ${subtitlePath ? "text-left [direction:rtl]" : ""}`} title={subtitlePath ? subtitle : undefined}>
            {subtitlePath ? <bdi>{subtitle}</bdi> : subtitle}
          </span>
        )}
      </div>
      {actions}
    </header>
  )
}

/** A sheet bar's box on a phone: the phone thread header's own (MobileThreadHeader). For a bar that is not a
 *  SheetHeader and leads with SheetClose (the sub-agent sheet). */
export const PHONE_SHEET_BAR = "phone:h-auto phone:min-h-14 phone:gap-0.5 phone:py-1 phone:pl-1 phone:pr-3"
/** And its title's type there. */
export const PHONE_SHEET_TITLE = "phone:text-[16.5px] phone:font-semibold phone:tracking-[-0.01em]"

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
//
// ON A PHONE IT IS THE PAGE'S ←, the phone thread header's own: a 44px circle, the 21px arrow, no rule. A
// sheet there is a page pushed over the one before it, and its way out is back.
export function SheetClose({ onClose }: { onClose: () => void }): ReactElement {
  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="-ml-1 shrink-0 rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-hover-strong hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 phone:ml-0 phone:flex phone:size-11 phone:items-center phone:justify-center phone:rounded-full phone:p-0 phone:text-fg/90 phone:hover:bg-transparent phone:active:bg-hover"
      >
        <X size={15} className="phone:hidden" />
        <ArrowLeft size={21} strokeWidth={2.1} className="hidden phone:block" />
      </button>
      <span aria-hidden data-close-rule className="ml-px mr-[9px] h-4 w-px shrink-0 bg-border phone:hidden" />
    </>
  )
}
