import { X } from "lucide-react"
import type { ReactElement, ReactNode } from "react"
import { PANE_HEADER_HEIGHT_CLASS } from "../../lib/paneHeaderHeight.ts"

// The one side-sheet header bar. A fixed-height row (the pane-header height, px-4) with an optional leading icon, the
// title (carrying optional inline `meta` — e.g. a background shell's "running 3 min" — and/or a stacked
// `subtitle` line — e.g. a doc drawer's "<slug>.md"), optional trailing `actions` (settings' "● unsaved"),
// and the lucide close button. Replaces six near-identical hand-rolled headers that had drifted in
// height (h-11 vs h-12), padding (px-3 / px-4 / px-5), title weight, and close-button padding.
//
// `initialFocus` stamps data-dialog-initial-focus on the close button for Radix/focus managers that
// query it (ThreadSheet's onOpenAutoFocus / registerDrawerFocus); omitted, the attribute is absent.
export function SheetHeader({
  title,
  subtitle,
  icon,
  meta,
  actions,
  onClose,
  initialFocus,
}: {
  title: string
  subtitle?: string
  icon?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  onClose: () => void
  initialFocus?: boolean
}): ReactElement {
  return (
    <header className={`flex ${PANE_HEADER_HEIGHT_CLASS} shrink-0 items-center gap-2.5 border-b border-border bg-panel px-4`}>
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
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        {...(initialFocus ? { "data-dialog-initial-focus": "" } : {})}
        className="rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
      >
        <X size={15} />
      </button>
    </header>
  )
}
