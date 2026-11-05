import type { ReactNode } from "react"

// THE frame every rendered image sits in — a lightbox gallery, a path the agent wrote on its own line, a
// file the human attached. One element so they cannot drift: an outer border, a little inset padding (the
// mat), and the picture centered inside it.
// A screenshot a TOOL returned sits in the same mat inside its own collapsed row (ChatView
// ToolImageCard), whose body's border is the frame's, so opening it draws one framed object rather than a
// bordered body with a separately bordered picture nested in it. A SendUserFile delivery's gallery does
// the same inside its row (SentFilesCard, LightboxGallery `framed={false}`).
//
// The frame SPANS the message width and centers the picture inside the mat, rather than shrink-wrapping
// it. Shrink-wrapping was tried first and is what "consistent frame" rules out: two image Reads in one
// turn measured 323px and 678px wide, so a column of screenshots painted a ragged stack of boxes with no
// shared edge. A spanning frame puts them all on the same left and right rules, which is the whole point
// of having one element.
//
// The mat is `--color-panel-2`, a step LIGHTER than the card background, and it is doing real work rather
// than decoration: agent screenshots are overwhelmingly dark UI, so on the page background their own edges
// vanish and the picture bleeds into its frame. The lighter mat gives every shot a visible boundary
// without nesting a second border 6px inside the first.
//
// `frizz-image-frame` (lib/diff/diff.css) supplies the chrome and the caption's type (1px border, block
// radius, mono 12.5px). It wore the tool cards' own class until those stopped being boxes on 2026-11-05.
export function ImageFrame({ caption, children }: { caption?: ReactNode; children: ReactNode }) {
  return (
    <figure className={IMAGE_FRAME}>
      <div className={IMAGE_FRAME_MAT}>{children}</div>
      {caption}
    </figure>
  )
}

// The frame's two boxes as bare class strings, because the OTHER surface that has to draw this frame
// cannot render a component: a Markdown `![](…)` is sanitized into an HTML STRING (lib/markdown.ts),
// never into React. It mints the same two boxes around its `<img>` from these exact constants, so the
// framed picture a worker writes as Markdown and the one it delivers as a bare path are the same object
// rather than two lookalikes that drift apart on the next change here.
export const IMAGE_FRAME = "frizz-image-frame max-w-full"
export const IMAGE_FRAME_MAT = "flex justify-center bg-panel-2 p-1.5"

// The picture inside the frame: never wider than the mat, never taller than a screenful, always keeping
// its intrinsic aspect. Shared so the frame's contents are as consistent as the frame itself.
export const FRAMED_IMAGE = "block max-h-[420px] max-w-full w-auto rounded-md object-contain"
