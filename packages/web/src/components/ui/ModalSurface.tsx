import * as RadixDialog from "@radix-ui/react-dialog"
import { forwardRef, type ComponentPropsWithoutRef } from "react"

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
// own), and focus leaving. So is its focus restore on close, which the plain surfaces never did.
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
  { label: string } & Omit<ComponentPropsWithoutRef<typeof RadixDialog.Content>, "asChild" | "forceMount">
>(function ModalSurface({ label, children, className = "", ...props }, ref) {
  return (
    <RadixDialog.Root open>
      <RadixDialog.Portal>
        <RadixDialog.Content
          ref={ref}
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
          onCloseAutoFocus={(event) => event.preventDefault()}
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
