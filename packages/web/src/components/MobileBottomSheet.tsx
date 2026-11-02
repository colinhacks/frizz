import * as RadixDialog from "@radix-ui/react-dialog"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { Z_MODAL } from "../lib/layers.ts"

// THE PHONE'S BOTTOM SHEET, on Radix Dialog rather than a hand-rolled fixed div, for one reason that
// decides it: the thread page it opens over IS a modal Radix dialog (ThreadSheet, `modal` below 700px).
// A plain portal beside it is outside that dialog's focus trap and its dismissable layer — a text field
// in it could not keep focus, and a tap on it read as a tap outside the thread, which closes the thread.
// A nested Radix dialog joins the same layer stack: Escape and outside taps go to the TOP layer only,
// its focus scope pauses the one under it, and the page under it stays exactly as it was.
//
// Chrome follows the two phone sheets already in the app (MobileBoard's ⋯, MobileAnswerSheet): 14px top
// radius, the 36×5 grab bar, `bg-panel`, the strong top rule, the upward shadow, `bg-scrim-50`. It slides
// up and fades its scrim in, as they do; it leaves at once, as they do.
//
// `onRequestClose` is every dismissal the sheet itself sees — a scrim tap and Escape. It does not close
// anything by itself: the caller decides (the ⋯ sheet routes it through the browser history, so that
// Back and a scrim tap are the same close).
export function MobileBottomSheet({
  title,
  onRequestClose,
  children,
  footer,
  className = "",
  dataAttr,
}: {
  // The accessible name. Rendered by the caller inside the sheet (it is often a row with a back arrow);
  // this is the screen-reader title only.
  title: string
  onRequestClose: () => void
  children: ReactNode
  footer?: ReactNode
  className?: string
  dataAttr?: string
}) {
  const [shown, setShown] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  // Slide up on the next frame — mounting already-open would skip the transition and read as a jump cut.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  const dataProps = dataAttr ? { [dataAttr]: "" } : {}
  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) onRequestClose() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={`fixed inset-0 ${Z_MODAL} bg-scrim-50 transition-opacity duration-200 motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
        />
        <RadixDialog.Content
          ref={contentRef}
          {...dataProps}
          aria-describedby={undefined}
          // Focus the sheet itself, not its first row: a row wearing focus on open reads as selected.
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.focus({ preventScroll: true })
          }}
          // Close THIS layer and stop there: the thread under it must not also unwind on one keystroke.
          onEscapeKeyDown={handleDialogEscape}
          className={`fixed inset-x-0 bottom-0 ${Z_MODAL} flex max-h-[86%] flex-col overflow-hidden rounded-t-[14px] border-t border-border-strong bg-panel pb-[calc(14px+env(safe-area-inset-bottom))] shadow-[0_-20px_60px_-10px_var(--sheet-shadow)] outline-none transition-transform duration-200 ease-out motion-reduce:transition-none ${
            shown ? "translate-y-0" : "translate-y-full"
          } ${className}`}
        >
          <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
          <div aria-hidden className="mx-auto mt-[6px] mb-[6px] h-[5px] w-[36px] shrink-0 rounded-full bg-muted/35" />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
          {footer}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
