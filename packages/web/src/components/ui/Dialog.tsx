import * as RadixDialog from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import type { ReactNode } from "react"
import { dialogDefaultButton, enterTargetOf, isDefaultEnter, ownsEnter } from "../../lib/dialogDefault.ts"
import { handleDialogEscape } from "../../lib/selectOverlay.ts"
import { Z_DIALOG } from "../../lib/layers.ts"

// Centered modal dialog on Radix. Dark scrim, elevated panel with a soft shadow and a titled
// header with a close affordance. Shared by the frizz-document viewer and settings.
//
// THE FOOTER'S DEFAULT BUTTON, the white one, marked `data-dialog-default`, takes the focus on open and
// answers Enter from anywhere in the dialog that has no Enter of its own (lib/dialogDefault.ts).
export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  footer,
  className = "w-[640px] max-w-[92vw] max-h-[82vh]",
  onOpenAutoFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  // Absent for a question the title asks whole: the header then sits straight on the footer, under
  // one rule rather than two.
  children?: ReactNode
  /** The buttons. The white one, the answer the title asks for, carries `data-dialog-default`; a red one
   *  never does (lib/dialogDefault.ts). */
  footer?: ReactNode
  className?: string
  /**
   * Where focus lands on open. Without this it is the footer's `data-dialog-default` button, or, in a
   * dialog without one, the first focusable thing in the content (Radix's choice, the header's Close
   * button). A dialog whose body is a text field calls `preventDefault` and focuses the field itself.
   */
  onOpenAutoFocus?: (event: Event) => void
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={`overlay-in fixed inset-0 ${Z_DIALOG} bg-scrim-55 backdrop-blur-[1px]`} />
        <RadixDialog.Content
          aria-modal="true"
          onEscapeKeyDown={handleDialogEscape}
          onOpenAutoFocus={(event) => {
            onOpenAutoFocus?.(event)
            if (event.defaultPrevented) return
            const button = dialogDefaultButton(event.target as Element)
            if (!button) return
            event.preventDefault()
            button.focus({ preventScroll: true })
          }}
          onKeyDown={(event) => {
            // In the DOM, not just React's tree: a menu or select opened from the dialog portals out of it
            // and still bubbles its keys through here.
            const target = event.target
            if (!(target instanceof Element) || !event.currentTarget.contains(target)) return
            if (!isDefaultEnter(event.nativeEvent) || ownsEnter(enterTargetOf(target))) return
            const button = dialogDefaultButton(event.currentTarget)
            if (!button) return
            event.preventDefault()
            event.stopPropagation()
            button.click()
          }}
          className={`pop-in fixed left-1/2 top-1/2 ${Z_DIALOG} flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl shadow-shadow-ink/50 outline-none ${className}`}
        >
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
            <RadixDialog.Title className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {title}
            </RadixDialog.Title>
            <RadixDialog.Close type="button" aria-label="Close" className="rounded-md p-1 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg">
              <X size={15} />
            </RadixDialog.Close>
          </header>
          {children != null && <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>}
          {footer && (
            <footer className={`flex shrink-0 items-center justify-end gap-2 px-4 py-3 ${children != null ? "border-t border-border" : ""}`}>
              {footer}
            </footer>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
