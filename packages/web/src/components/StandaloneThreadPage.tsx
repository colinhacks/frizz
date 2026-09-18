import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { useSnapshot } from "valtio"
import { seedBoard, store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { displayTitle } from "../groups.ts"
import { resolveThreadRoute } from "../lib/threadRouteState.ts"
import { projectHref } from "../lib/base-path.ts"
import { standaloneThreadHref } from "../lib/standaloneThreadRoute.ts"
import { SHEET_BASE_WIDTH, SPLIT_MIN_PX } from "../lib/sheet.ts"
import type { ThreadView } from "@frizz/shared"
import { ThreadView as ThreadViewSurface } from "./ChatView.tsx"
import { DrawerStack } from "./DrawerStack.tsx"
import { FileViewerPanel } from "./FileViewerPanel.tsx"
import { FocusRail, RAIL_WIDTH } from "./FocusRail.tsx"
import { TooltipProvider } from "./Tooltip.tsx"
import { Toaster } from "./Toaster.tsx"
import { useQuery } from "@tanstack/react-query"

/**
 * THE WHOLE GEOMETRY OF /full, as three lengths that depend on the PAGE WIDTH AND NOTHING ELSE — not
 * on whether a file is open, which is the point (see the layout comment below). Percentages resolve
 * against the row, which is the page minus the project rail, so a `vw` here would be wrong on a
 * board that shows one.
 *
 *   thread = half the page, capped at the drawer's width
 *   pane   = everything the thread does not take
 *   gutter = the slack left beside the pair once the rail has its 340
 *
 * `thread + pane` is exactly the page at every width (below 1440 both are half; above it the thread
 * pins at 720 and the pane takes the rest), which is what makes the open state a 50/50 read on a
 * 1200px screen — "600px of content, and then the file takes up 600px" (maintainer 2026-08-30) —
 * without either column having to change size to get there.
 */
const PANE_W = `max(50%, calc(100% - ${SHEET_BASE_WIDTH}px))`
const LAYOUT_VARS = {
  "--full-thread": `min(${SHEET_BASE_WIDTH}px, ${PANE_W})`,
  // Below the split there is no rail and no viewer, so the column simply takes the page under the cap
  // — which is the DRAWER's width, so the two surfaces agree and the morph between them is a translate.
  "--full-thread-narrow": `min(${SHEET_BASE_WIDTH}px, 100%)`,
  "--full-pane": PANE_W,
  "--full-gutter": `max(0px, calc((100% - min(${SHEET_BASE_WIDTH}px, ${PANE_W}) - ${RAIL_WIDTH}px) / 2))`,
} as CSSProperties

/**
 * The `/full` page for a thread in ANOTHER project — the two places that must name a project other
 * than this page's. Composed from the two helpers that own the shapes rather than spelled by hand:
 * these were the only call sites bypassing `projectHref`, and a hand-spelled prefix is exactly how the
 * ↗ button came to mint an unprefixed URL in the first place.
 */
function standaloneHrefIn(projectSlug: string, slug: string): string {
  // `"/"` forces the UNPREFIXED inner form: this page may itself be prefixed (a `/project/a/…/full`
  // link to a thread that turns out to live in project b), and `standaloneThreadHref` would otherwise
  // stamp THIS page's prefix on before we prepend the other project's.
  return `${projectHref(projectSlug)}${standaloneThreadHref(slug, "/")}`
}

export function StandaloneThreadPage({ slug }: { slug: string }) {
  const snap = useSnapshot(store)
  const fileOpen = snap.filePanels.some((panel) => !panel.closing)
  const board = useBoard()
  const route = resolveThreadRoute(board, slug)
  const thread = route.kind === "found" ? route.thread : undefined
  const projectDir = board?.projectDir

  useEffect(() => {
    rpc.board().then(seedBoard).catch(() => {})
  }, [])

  // SPLIT MODE for the file reader: while this page is mounted (and the window is wide enough for two
  // real columns), a click on a local file renders beside the thread instead of as a sheet over it —
  // Markdown through pushMarkdownDrawer, any other text file through openLocalPath (a project file in
  // the rail's Edited files list, say). Tracked live so shrinking the window falls back to the drawer for later
  // clicks; a panel already open stays (its layout degrades gracefully, and yanking it on resize
  // would lose the reader's place).
  useEffect(() => {
    const wide = window.matchMedia?.(`(min-width: ${SPLIT_MIN_PX}px)`)
    if (!wide) return
    const apply = () => { store.splitFileViewer = wide.matches }
    apply()
    wide.addEventListener("change", apply)
    return () => {
      wide.removeEventListener("change", apply)
      store.splitFileViewer = false
      store.filePanels = []
    }
  }, [])


  const atRest = thread?.runtime === "turn-idle" || thread?.runtime === "exited" || thread?.runtime === "none"
  useEffect(() => {
    if (!thread || !atRest) return
    rpc.threadSeen({ slug }).catch(() => {})
  }, [atRest, slug, thread?.lastActivityAt])

  // "<thread> · owner/repo — Frizz". The thread title LEADS because a tab truncates from the end and
  // several of these are usually open on the same repo at once — the thread is what tells them apart.
  // The workspace identity trails as "owner/repo — Frizz", the same mark the installed app window uses.
  useEffect(() => {
    const projectLabel = board?.projectLabel ?? board?.projectName
    const threadLabel = thread ? displayTitle(thread) : slug
    document.title = projectLabel ? `${threadLabel} · ${projectLabel} — Frizz` : `${threadLabel} · Frizz`
  }, [board?.projectLabel, board?.projectName, slug, thread])

  return (
    <TooltipProvider>
      <div className="h-dvh min-h-0 bg-bg text-sm text-fg">
        {/* THE FULLSCREEN LAYOUT (maintainer 2026-08-28, second pass): the thread column and the
            rail sit together as ONE CENTERED PAIR — "the combination of the agent pane and the
            artifact readout should be centered on the page, and there should be some reasonable
            maximum width on the agent pane" — with the file viewer sliding in over the rail when a
            file opens (see SidePane). The column's ceiling is the DRAWER's own width
            (lib/sheet.ts SHEET_BASE_WIDTH; maintainer 2026-08-31: "the same width as the regular
            drawer width" — an earlier 960px "still lets the chat go too wide").

            NOTHING HERE IS SIZED BY WHAT IS BESIDE IT (maintainer 2026-09-01: "you should not be
            resizing the chat transcript column … you also should never resize the code panes that
            slide in. Otherwise, it's going to be re-flowing in a way that just takes unnecessary
            CPU"). Both columns are pure functions of the PAGE width — see LAYOUT_VARS — so opening
            or closing a file changes no width anywhere and neither the transcript nor the file
            re-wraps. What moves is the ROW, by one transform, from centered to hard left; a
            transform is composited, so the whole open costs no layout at all. The flex-grow /
            flex-basis / width transitions this replaced re-laid out both columns' contents on every
            frame of the 200ms.

            The GUTTER is that centering spelled out rather than left to `flex-1` — exactly the slack
            beside the pair, so translating the row by −gutter puts the thread column hard against the
            left edge and the pane against the right. The pane is ALREADY full width while it is
            closed (the rail sits at its left and the remainder hangs off the page, clipped by the
            frame around the row), which is what lets its width be a constant.

            A window NARROWER THAN THE SPLIT gets one column — the rail and the viewer need the width
            they hide under, so below SPLIT_MIN_PX the thread column takes the page under its 720 cap,
            which is exactly the drawer's width. */}
        <div className="h-full w-full overflow-hidden">
          <div
            // `justify-center` is for the SINGLE-column state only: below the split the gutter and the
            // pane are both `hidden`, so without it a 720px column on a 1024px page would sit hard
            // against the left edge with 304px of dead space beside it. Above the split the row is
            // deliberately wider than the page (the closed pane hangs off the right, clipped by the
            // frame) and centring it would drag that overflow back into view — so the split state
            // takes `justify-start`, which is what it has always had.
            className="flex h-full w-full justify-center transition-transform duration-200 ease-out motion-reduce:transition-none split:justify-start"
            style={{ ...LAYOUT_VARS, transform: fileOpen ? "translateX(calc(-1 * var(--full-gutter)))" : undefined }}
          >
            <div className="hidden w-[var(--full-gutter)] shrink-0 split:block" aria-hidden="true" />
            <main
              data-standalone-thread
              // `thread-chat` is the fullscreen door's shared view-transition element: the drawer
              // panel / queue card the door was clicked in wears the same name (tagged at click time,
              // ExpandThreadLink), and the browser morphs that surface into this column. Inert
              // outside a transition — no navigation but the door's opts in.
              className="flex h-full w-[var(--full-thread-narrow)] min-w-0 shrink-0 flex-col overflow-hidden border-border bg-panel sm:border-x split:w-[var(--full-thread)] [view-transition-name:thread-chat]"
            >
              {route.kind === "loading" ? (
                <div className="flex flex-1 items-center justify-center" role="status" aria-label="Loading thread">
                  <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
                </div>
              ) : route.kind === "missing" ? (
                <MissingThread slug={slug} />
              ) : (
                <ThreadViewSurface slug={slug} virtualized showReturnToQueue />
              )}
            </main>
            {/* No thread, no rail — but the page still has to read as centered, so the region holds
                its width either way. */}
            {thread
              ? <SidePane slug={slug} thread={thread} />
              : <div className="hidden w-[var(--full-pane)] shrink-0 split:block" aria-hidden="true" />}
          </div>
        </div>
        {/* The SAME drawer stack the queue mounts. Without it every drill-in this page renders — a
            sub-agent row, a background-shell row, the frizz-doc button, a `[…](/thread/<slug>)` link —
            pushed a layer onto the store that nothing displayed, so the click was simply dead. Mounted
            OUTSIDE the transformed row: the sheets are `fixed inset-0`, and a transform on an ancestor
            is a containing block for them, which would drag every sheet along with the slide. */}
        <DrawerStack />
        <Toaster />
      </div>
    </TooltipProvider>
  )
}

// THE SIDE PANE: the rail and the file viewer share the one region right of the thread column, and
// the viewer FADES AND SLIDES IN OVER the rail instead of opening beside it (maintainer 2026-08-28:
// "the right-side pane should slide over … hide the artifact readout … press the X to see the
// artifacts again", then: "fade in and slide left over top of the artifact rail"). The region is
// ALWAYS its open width — the rail takes the leftmost 340 of it and the rest hangs off the page while
// nothing is open — so the viewer's own width is a constant and it never re-wraps a line of code to
// arrive. The rail stays MOUNTED under the pane — its live rows keep polling — but goes inert, so
// nothing hidden can take focus or a click. Readers stay mounted under each new layer, including
// during its slide-out, so dismissing a file reveals exactly the reading position beneath it.
function SidePane({ slug, thread }: { slug: string; thread: ThreadView }) {
  const snap = useSnapshot(store)
  return (
    <div
      data-side-pane
      className="relative hidden h-full w-[var(--full-pane)] min-h-0 min-w-0 shrink-0 grow-0 overflow-hidden split:block"
    >
      <div inert={snap.filePanels.length > 0 ? true : undefined} className="h-full min-h-0">
        <FocusRail thread={thread} />
      </div>
      {snap.filePanels.map((panel, i) => (
        <FilePaneLayer
          key={panel.id}
          slug={slug}
          path={panel.path}
          closing={!!panel.closing}
          active={i === snap.filePanels.length - 1 && !panel.closing && snap.splitFileViewer}
        />
      ))}
    </div>
  )
}

function FilePaneLayer({ slug, path, closing, active }: { slug: string; path: string; closing: boolean; active: boolean }) {
  const [entered, setEntered] = useState(false)
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    // Establish the offscreen position before the first frame, including a warm/cached document.
    ref.current?.getBoundingClientRect()
    const show = () => setEntered(true)
    const frame = requestAnimationFrame(show)
    const fallback = window.setTimeout(show, 120)
    return () => { cancelAnimationFrame(frame); window.clearTimeout(fallback) }
  }, [])
  useEffect(() => {
    if (active) ref.current?.focus({ preventScroll: true })
  }, [active])
  const shown = entered && !closing
  // No left border: the thread's right border already draws the seam. Transition `translate`, not
  // `transform` — Tailwind v4's translate-x classes set the standalone property.
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      data-file-viewer-slot
      aria-hidden={!active}
      inert={!active}
      className={`absolute inset-0 outline-none transition-[translate,opacity] duration-200 ease-out motion-reduce:transition-none ${shown ? "translate-x-0 opacity-100" : "translate-x-full opacity-0"}`}
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-panel">
        <FileViewerPanel slug={slug} path={path} active={active} />
      </div>
    </aside>
  )
}

/**
 * A thread this project does not have — which, since one server started serving every project, is
 * usually a thread ANOTHER project has.
 *
 * Every URL from the per-project era is unprefixed: `localhost:4917/thread/fix-auth/full` was
 * unambiguous because the PORT named the project. The same path now resolves against whichever
 * project launched the server, so a bookmark that worked yesterday lands here. It is not lost, it is
 * one directory over — so look, and say where it went rather than blaming the operator.
 */
function MissingThread({ slug }: { slug: string }) {
  const { data, isPending } = useQuery({
    queryKey: ["threadLocate", slug],
    queryFn: () => rpc.threadLocate({ slug }),
  })
  // Exactly one owner is the overwhelmingly common case, and there is nothing to choose between.
  useEffect(() => {
    if (data?.length === 1) location.replace(standaloneHrefIn(data[0].projectSlug, slug))
  }, [data, slug])

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <div>
        <h1 className="font-medium text-fg">Thread unavailable</h1>
        {isPending ? (
          <p className="mt-1 text-muted">Looking for “{slug}” in your other projects…</p>
        ) : data && data.length > 0 ? (
          <p className="mt-1 text-muted">
            “{slug}” lives in {data.length === 1 ? "another project" : "these projects"} — opening it there.
          </p>
        ) : (
          <p className="mt-1 text-muted">Thread “{slug}” was not found in any project on this machine.</p>
        )}
      </div>
      {data && data.length > 1 ? (
        <div className="flex flex-wrap justify-center gap-2">
          {data.map((hit) => (
            <a
              key={hit.projectSlug}
              href={standaloneHrefIn(hit.projectSlug, slug)}
              className="rounded-md border border-border px-3 py-1.5 text-[12px] text-fg/90 hover:bg-panel-2"
            >
              {hit.projectName}
            </a>
          ))}
        </div>
      ) : (
        <a href="/" className="rounded-md border border-border px-3 py-1.5 text-[12px] text-fg/90 hover:bg-panel-2">
          All projects
        </a>
      )}
    </div>
  )
}
