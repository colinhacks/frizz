import * as RadixDialog from "@radix-ui/react-dialog"
import { forwardRef, useCallback, useState, type ComponentPropsWithoutRef } from "react"
import { focusToRestore, openerChain, rememberChain } from "../../lib/restoreFocus.ts"

// A FULL-SCREEN SURFACE WE DRAW OURSELVES — its own scrim, its own slide, its own close — made a MEMBER of
// Radix's layer stack. Rule 4 of lib/layers.ts. Every thread drawer is a Radix dialog, and Radix keeps its
// layers in a stack only it can see: Escape goes to the topmost layer it knows about, and a modal layer
// (a drawer on the phone) makes <body> click-through and pulls focus back into itself. A plain `fixed`
// div opened over a drawer is invisible to that stack, however high its z. On 2026-11-01, Escape with ⌘K
// or Settings open over a drawer closed the DRAWER underneath and left the overlay up, and on the phone
// ⌘K over a drawer could be neither typed into nor tapped. Rendered through this, the surface is the
// topmost layer: it takes the pointer and the focus, and the drawers under it stand down.
//
// Radix only joins it to the stack; CLOSING stays the surface's own. The app's Escape chain (DrawerStack)
// unwinds overlays in its own order, so Radix's dismissals are refused here: its Escape (the event still
// bubbles on to that chain), a press outside (the surface fills the screen, and its scrim's click is its
// own), and focus leaving. So is its focus restore on close, which returns to a `Dialog.Trigger` these
// surfaces do not have.
//
// ON CLOSE, FOCUS GOES BACK TO WHAT HELD IT WHEN THE SURFACE OPENED (lib/restoreFocus.ts has the cases:
// a surface opened from another, a close that was a navigation, an opener that has left the page). The
// plain surfaces never returned it and neither did this until 2026-11-10: closing Settings or ⌘K left
// the focus on <body>, and the next Tab started from the top of the rail. `returnsFocus` is how a
// surface says a particular close was not a dismissal: ⌘K answers false once it has run a command, so a
// jump to a thread leaves the focus where it has always left it, on the page, where `j` and `k` step
// the pane, and not back in the prompt box ⌘K was pressed in.
//
// ON OPEN, FOCUS GOES TO THE ELEMENT MARKED `data-autofocus`, else to the surface itself — never to its
// first control, which Radix would pick. React's `autoFocus` is not enough: the portal mounts a commit
// late, and over a modal drawer the drawer's focus trap is still live then and pulls the focus straight
// back (⌘K on the phone took no keystroke that way). By the time this runs, the drawer's trap has
// stood down.
//
// The props are the surface's root element's: its class (it is `fixed`, with a layer from lib/layers.ts),
// its data attributes, its handlers. `label` names it for assistive tech, as a hidden title.
export const ModalSurface = forwardRef<
  HTMLDivElement,
  {
    label: string
    /** Asked as the surface closes. False leaves the focus alone; absent, it goes back to the opener. */
    returnsFocus?: () => boolean
  } & Omit<ComponentPropsWithoutRef<typeof RadixDialog.Content>, "asChild" | "forceMount">
>(function ModalSurface({ label, returnsFocus, children, className = "", ...props }, ref) {
  // Read on the FIRST render, which is the surface opening: by its first effect Radix has already
  // moved the focus inside.
  const [openers] = useState(openerChain)
  const surfaceRef = useCallback(
    (surface: HTMLDivElement | null) => {
      if (surface) rememberChain(surface, openers)
      if (typeof ref === "function") ref(surface)
      else if (ref) ref.current = surface
    },
    [openers, ref],
  )
  return (
    <RadixDialog.Root open>
      <RadixDialog.Portal>
        <RadixDialog.Content
          ref={surfaceRef}
          // How an opener is asked which surface it sits in (lib/restoreFocus.ts).
          data-modal-surface=""
          aria-label={label}
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onFocusOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const surface = event.target as HTMLElement
            ;(surface.querySelector<HTMLElement>("[data-autofocus]") ?? surface).focus({ preventScroll: true })
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (returnsFocus && !returnsFocus()) return
            const back = focusToRestore(openers, document.activeElement, document.body)
            if (back instanceof HTMLElement) back.focus({ preventScroll: true })
          }}
          className={`outline-none ${className}`}
          {...props}
        >
          <RadixDialog.Title className="sr-only">{label}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
})
