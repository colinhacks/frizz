import { GithubHovercards } from "./GithubHovercards.tsx"
import { LightboxHost } from "./lazySurfaces.tsx"
import { Toaster } from "./Toaster.tsx"

// THE HOSTS EVERY PAGE MOUNTS, in one place. The router has two shells — the layout around the grid and
// the boards (RootLayout), and the full-screen thread page, which sits outside that layout because it
// has no rail — and each mounted these by hand. So they drifted: the hovercards were hosted by the
// layout alone, under a comment saying they covered the full-screen page, and a `#123` there showed no
// card; the full-screen page mounted TWO toasters, its own and its route's, and drew every toast twice.
// Both shells render this now, and PageHosts.guard.test.ts fails when one of these is mounted anywhere
// else. A host for something a thread can raise on any page belongs here.
export function PageHosts() {
  return (
    <>
      {/* `showToast` from anywhere needs somewhere to render: the grid is where a bad project URL lands,
          and the full-screen page has the copy-a-code-block control, whose only feedback is a toast.
          Fixed-positioned, so it is inert until a toast exists. */}
      <Toaster />
      {/* The image viewer a ```lightbox gallery opens (components/Lightbox.tsx). Hosted here rather
          than by the gallery, which is a virtualized transcript row that can unmount under it. */}
      <LightboxHost />
      {/* Prose carrying `#123` renders on the board, in a drawer and on the full-screen page alike, and
          one delegated listener at the document covers all three. Inert until a pointer rests on a
          reference. */}
      <GithubHovercards />
    </>
  )
}
