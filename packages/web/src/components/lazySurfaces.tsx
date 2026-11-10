import { Suspense, lazy, useState, type ComponentType, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { store } from "../store.ts"
import { FrizzLoader } from "./FrizzLoader.tsx"

// THE THREAD'S SURFACES LOAD AFTER THE BOARD, not with it.
//
// A board's first paint is its sidebar and an empty pane ("N threads are waiting on you"): no transcript.
// The transcript renderer (ChatView and everything only it reaches: the message renderers, the
// interaction and question cards, the tool rows, the diff view) was a third of the entry chunk, and on a
// cold visit the browser downloaded, parsed and evaluated it before it drew a single row (measured on a
// copy of the maintainer's boards, 2026-11-10; the report is in the thread that made this). So it is one
// chunk of its own (threadSurfaces.ts), reached only through the components below:
//
//   · it is FETCHED as soon as the board has painted, while the browser is idle (App.tsx), so by the
//     time a human opens a thread it is loaded, and the component renders it directly — no Suspense, no
//     fallback, the same commit it always drew in;
//   · a page whose first paint IS a thread — a `?thread=` link, a full-screen page — fetches it at boot
//     (main.tsx), beside the board read rather than after it;
//   · only a thread opened before the chunk lands draws a fallback, and it is the loading state that
//     surface already draws while its thread resolves (ThreadPane / ThreadSheet's spinner, the board's
//     FrizzLoader for a brand-new project's first-task view).
//
// Which branch a mount takes is decided ONCE per mount. Swapping a Suspense-wrapped lazy element for the
// resolved component on a later render would be a different element type at the same position, and would
// remount the thread under the reader.

type Surfaces = typeof import("./threadSurfaces.ts")

let loaded: Surfaces | undefined
let loading: Promise<Surfaces> | undefined

/** Fetch and evaluate the chunk; one request however often it is asked. */
export function loadThreadSurfaces(): Promise<Surfaces> {
  loading ??= import("./threadSurfaces.ts").then((m) => (loaded = m))
  return loading
}

/** Whether the chunk is in. Exported for its test. */
export function threadSurfacesLoaded(): boolean {
  return loaded !== undefined
}

let preloadScheduled = false
/** Fetch the chunk once the browser is idle — called when the board has painted. */
export function preloadThreadSurfaces(): void {
  if (preloadScheduled || loaded) return
  preloadScheduled = true
  const run = () => void loadThreadSurfaces().catch(() => { loading = undefined })
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 })
  else setTimeout(run, 200)
}

function lazySurface<K extends keyof Surfaces>(name: K, fallback: () => ReactNode): Surfaces[K] {
  type Props = Record<string, unknown>
  const Lazy = lazy(async () => ({ default: (await loadThreadSurfaces())[name] as unknown as ComponentType<Props> }))
  function Surface(props: Props) {
    const [ready] = useState(() => loaded !== undefined)
    if (ready) {
      const Component = loaded![name] as unknown as ComponentType<Props>
      return <Component {...props} />
    }
    return <Suspense fallback={fallback()}><Lazy {...props} /></Suspense>
  }
  Surface.displayName = `Lazy(${String(name)})`
  return Surface as unknown as Surfaces[K]
}

/** The spinner ThreadPane and ThreadSheet draw while a thread's route resolves. */
function SurfaceSpinner() {
  return <div className="flex flex-1 items-center justify-center"><span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" /></div>
}

/** The board's own loader, as App draws it before the first board snapshot. */
function BoardLoader() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex h-screen items-center justify-center">
      <FrizzLoader label="Loading project" />
    </div>
  )
}

export const ThreadView = lazySurface("ThreadView", () => <SurfaceSpinner />)
export const TodosView = lazySurface("TodosView", () => <BoardLoader />)
// The sheets are overlays: until the chunk is in, nothing is drawn, and the sheet opens when it lands.
export const SubAgentSheet = lazySurface("SubAgentSheet", () => null)
export const ThreadDrawer = lazySurface("ThreadDrawer", () => null)
export const BackgroundShellSheet = lazySurface("BackgroundShellSheet", () => null)
export const MonitorSheet = lazySurface("MonitorSheet", () => null)
// The rail beside an open thread in the pane: it stands beside the thread, so it arrives with it.
export const SidePane = lazySurface("SidePane", () => null)
// The full-screen page. main.tsx fetches the chunk at boot on its URL, so this is the board's loader only
// while the chunk is still on its way.
export const StandaloneThreadPage = lazySurface("StandaloneThreadPage", () => <BoardLoader />)
// A local Markdown file's reader, and the phone's ⋯ sheet: overlays, like the sheets above.
export const MarkdownDrawer = lazySurface("MarkdownDrawer", () => null)
export const ThreadActionsSheet = lazySurface("ThreadActionsSheet", () => null)

const LazyLightboxHost = lazySurface("LightboxHost", () => null)
/** The image viewer's host (PageHosts): nothing at all until a picture is opened, then the viewer, from
 *  the chunk. Mounted per opening, so once the chunk is in it draws in the click's own commit. */
export function LightboxHost() {
  const { lightbox } = useSnapshot(store)
  return lightbox ? <LazyLightboxHost /> : null
}
