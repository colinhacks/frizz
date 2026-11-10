import { createContext, useContext, useRef, type ComponentPropsWithRef, type ReactElement, type RefObject } from "react"
import type { FileDropZone } from "../lib/fileDrop.ts"

// The page-wide drop zone of a page that is one thread's, part of the thread shell (ThreadSurface.tsx).
// It is its own module because the board's one-thread pane mounts it at first paint, and the shell
// itself reaches the transcript renderer's Markdown and highlight.js, which the board's first paint does
// not load (lazySurfaces.tsx, entryChunk.guard.test.ts). This file imports nothing but React.

type ZoneHandlers = FileDropZone["handlers"]
const ThreadPageZoneContext = createContext<RefObject<ZoneHandlers | null> | null>(null)

/** A PAGE THAT IS ONE THREAD takes a dropped file anywhere on it. The full-screen page draws its thread
 *  in a column with a gutter on one side and a rail on the other, and at a desktop width the column is
 *  about half of what the reader sees. A file dropped on the other half missed the thread's surface, so
 *  the browser opened it in place of the app — on the one page where "drop it anywhere" can only mean
 *  this thread. So that page's root is this element: it is the drop zone, and the thread surface drawn
 *  inside it hands its zone up here instead of binding it on its own root (one zone, so a drop in the
 *  column is not taken twice). A sheet opened over the page is not inside this element, so a file
 *  dropped on a drawer still goes to that drawer's own thread. */
export function ThreadPageZone({ children, ...root }: Omit<ComponentPropsWithRef<"div">, "onDragOver" | "onDragLeave" | "onDrop">): ReactElement {
  const zone = useRef<ZoneHandlers | null>(null)
  return (
    <ThreadPageZoneContext.Provider value={zone}>
      <div
        {...root}
        data-thread-page-zone
        onDragOver={(e) => zone.current?.onDragOver(e)}
        onDragLeave={(e) => zone.current?.onDragLeave(e)}
        onDrop={(e) => zone.current?.onDrop(e)}
      >
        {children}
      </div>
    </ThreadPageZoneContext.Provider>
  )
}

/** The page zone a thread surface is drawn inside, if any: the surface hands its handlers to it. */
export function useThreadPageZone(): RefObject<ZoneHandlers | null> | null {
  return useContext(ThreadPageZoneContext)
}
