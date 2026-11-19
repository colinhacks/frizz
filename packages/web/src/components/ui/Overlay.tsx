import type { ReactNode } from "react"
import { Z_DIALOG } from "../../lib/layers.ts"
import { ModalSurface, ModalSurfaceTitle } from "./ModalSurface.tsx"

// THE SCRIM OF A CENTRED DIALOG THE APP DRAWS ITSELF: the GitHub picker, and the sign-in it is while
// Frizz is signed out. Frosted glass: heavy blur and saturation over a light black wash, so the board
// reads as a texture behind the dialog rather than going fully dark. The dialog layer (lib/layers.ts),
// so it sits above every drawer and modal it can open from.
//
// A MEMBER OF RADIX'S LAYER STACK (ui/ModalSurface, rule 4 of lib/layers.ts), because both of them open
// from INSIDE a Radix dialog: New thread's GitHub mark, and on a phone its "Issue or PR" chip, where New
// thread is a full-screen modal layer. Until 2026-11-19 this was a plain `fixed` div. It was painted over
// that dialog and took no pointer, since <body> is click-through under a modal layer: on a phone every
// tap on the picker or the sign-in landed in the prompt box beneath it, and the chip was the phone's only
// way to either. On the desktop the first click outside New thread's 640px closed it and let the picker
// through. It lived in NewThreadModal.tsx, whose own Radix dialog satisfied layers.guard.test.ts for the
// whole file, which is why it has a file to itself now.
//
// The dialog's own heading names it: wrap it in `OverlayTitle`, so the layer adds no second, hidden one.
// A press on the scrim closes it. Escape is the dialog's own: each stops the key at its panel, and the
// app's chain (DrawerStack) takes it otherwise.
export function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <ModalSurface
      ownTitle
      // `text-sm`: the app frame's type (App.tsx), which a portal to <body> leaves behind.
      className={`fixed inset-0 ${Z_DIALOG} flex items-center justify-center bg-scrim-30 text-sm backdrop-blur-md backdrop-saturate-150`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {children}
    </ModalSurface>
  )
}

/** The dialog's heading: `<OverlayTitle asChild><h2>…</h2></OverlayTitle>`. */
export const OverlayTitle = ModalSurfaceTitle
