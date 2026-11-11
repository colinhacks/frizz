import { useEffect, useLayoutEffect, useState } from "react"
import { useSnapshot } from "valtio"
import { useQuery } from "@tanstack/react-query"
import { Navigate, Outlet, createBrowserRouter, useLocation, useNavigate, useParams, useRevalidator, useRouteError } from "react-router"
import { App } from "./App.tsx"
import { RootErrorPage } from "./components/ErrorBoundary.tsx"
import { ProjectGrid } from "./components/ProjectGrid.tsx"
import { ProjectRail, RAIL_INSET_CLASS } from "./components/ProjectRail.tsx"
import { StandaloneThreadPage } from "./components/lazySurfaces.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { PageHosts } from "./components/PageHosts.tsx"
import { applyPath, registerNavigate, threadParam, withThreadParam } from "./lib/router.ts"
import { CONSOLE_PATH, innerPath } from "./lib/base-path.ts"
import { bindConsole, feedIsBoundTo, feedIsConsole, leaveConsole, rebindProject } from "./api/socket.ts"
import { noteStandaloneThreadRender, primeFullscreenReturn, resetProjectState, store } from "./store.ts"
import { useProjectRailVisible } from "./lib/projectRail.ts"
import { ownedByThisPage } from "./lib/projectOwnership.ts"
import { choseProjects, PROJECTS_HREF, setHomeView, useHomeView, withoutProjectsChoice } from "./lib/homeView.ts"
import { useConsoleFeedProjects } from "./lib/consoleProjects.ts"
import { useIsMobile } from "./lib/mobile.ts"
import { rpc } from "./api/rpc.ts"

// THE ROUTE TREE — and, more to the point, the LAYOUT that outlives a navigation.
//
// The rail is chrome: it draws every project on the machine and is identical on every page, so it
// must not be torn down and rebuilt when you use it. Before this it was mounted twice — once inside
// <App/> and once inside <ProjectGrid/> — because `main.tsx` chose ONE of three root shells from
// `location.pathname` at module load, which made every project switch a full document load. A layout
// route is the direct expression of "this part does not change": <RootLayout/> holds the rail and the
// tooltip provider, and the <Outlet/> below it swaps between the grid and a board.
//
// WHAT A PROJECT SWITCH ACTUALLY COSTS, and why the router alone was never the whole job. Four things
// are bound to one project, and only the first two are this hook's business:
//   · the live feed — one socket per project (api/socket.ts rebindProject)
//   · the board store, the drawer stack and the current view (store.resetProjectState)
//   · the react-query cache, which now needs NOTHING here. It used to be swept on every switch,
//     exempting the project list so the rail would not blank mid-navigation; the cache is scoped by
//     project at the hash instead (lib/queryKeyScope.ts), so one project's entries are invisible to
//     another rather than deleted in front of it. Switching back finds a warm cache, and a response
//     that arrives late has nowhere wrong to land.
//   · the API base, which needs nothing: base-path.ts derives it from the page's path on every call,
//     and the router keeps `location` synchronous with navigation.
//
// The board is KEYED by slug so it genuinely remounts per project — its state is per-project and
// reusing the instance across a switch would carry the previous board's mounted surfaces into the new
// one. The rail above it is not keyed, so it persists. That contrast is the whole design.

/** The one place that knows the URL shapes, so a route and a link cannot disagree. */
export const PROJECT_PATH = "/project/:slug"

function RootLayout() {
  useRegisterNavigate()
  // ONE decision drives the column AND the space reserved for it. They were separate — the rail was
  // conditional while every page kept an unconditional `pl-[57px]` — so turning the rail off left a
  // 57px lane of nothing down the left of every board. A hidden rail has to be gone from the layout,
  // not merely invisible in it.
  const railOn = useProjectRailVisible()
  const { pathname, search } = useLocation()
  // THE GRID IS THE RAIL, LARGER: every project's square with its queue badge (ProjectGrid). A column of
  // the same squares beside it says everything twice, so on `/` the rail is hidden — mounted still, so
  // leaving the grid does not rebuild it — and the page takes no inset for it. (`/?thread=<slug>` is the
  // launching project's board, not the grid: RootRoute.)
  const onGrid = pathname === "/" && threadParam(search) === null
  const railVisible = railOn && !onGrid
  return (
    <TooltipProvider>
      {/* Outside the <Outlet/> on purpose: this is the element that must survive the navigation.
          OPT-IN: a permanent column of every project is a standing invitation to leave the thread
          you are in, so it is off unless asked for. Hidden, the way back is the status bar's home
          crumb (StatusRow's home button), which costs a click exactly when you meant to switch. */}
      {railOn ? (
        <div className={onGrid ? "hidden" : "contents"}>
          <ProjectRail />
        </div>
      ) : null}
      <div className={railVisible ? RAIL_INSET_CLASS : undefined}>
        <Outlet />
      </div>
      {/* HOSTED BY THE LAYOUT, not by the board: the toaster lived inside <App/>, so `showToast` from
          anywhere else raised a toast with nowhere to render — silently, since the store field is set
          either way. The full-screen page, outside this layout, mounts the same set (PageHosts). */}
      <PageHosts />
    </TooltipProvider>
  )
}

/**
 * Re-bind everything that belongs to one project, whenever the project changes — and say whether the
 * tree below may render yet.
 *
 * THE CONDITION IS ASKED OF THE FEED, and that is the whole point. This hook used to keep its own note
 * of the project it had bound, in a `useRef` — a second copy of a fact it did not own. Every switch
 * that changes which ROUTE matched (the grid to a board, a board to a thread page) unmounts one element
 * and mounts another, so the ref was born fresh, initialised to the slug it was looking at, and
 * therefore always answered "already bound". The feed stayed on the previous project while the URL, the
 * `<App/>` key and the board header all said the new one, and nothing short of a document load recovered
 * it (2026-08-11: every board on the machine rendered the launching project's threads).
 *
 * `feedIsBoundTo` asks the module that HOLDS the connection. It has nothing to remember and therefore
 * nothing to get wrong on a remount, and being called redundantly is free.
 *
 * THE RETURN VALUE IS A GATE, and the caller renders nothing project-scoped until it is true. The reset
 * cannot happen before the first render under the new URL — it is a side effect, and a render must not
 * have one — so for one commit the store still holds the project you left: its board, its drawer stack,
 * its composer drafts. Rendering the remounted `<App/>` in that commit was the bug: every per-thread
 * hook in it ran against the NEW project's API with the OLD project's slugs. Most were wasted reads
 * (`threadTranscript`, `threadSettledQuestions`); one was a 500 (`threadProfileOptions`, which #50 gated
 * on its own until this made that redundant); and one was a WRITE — a thread drawer left open across
 * the switch sent `threadSeen` for its slug to the new project, marking that project's same-slug thread
 * read when nobody had opened it (2026-10-08). Gating each hook covers the hooks someone has noticed;
 * gating the tree covers the class.
 *
 * Two conditions open it:
 *   · BOUND — the feed is on this project, or this hook has just reset and rebound for this slug.
 *     `settled` is the second half rather than a second `feedIsBoundTo` read because the feed records
 *     the project from the PATH while `slug` comes from the route's params: a catch-all match can make
 *     the two disagree for good, and a gate waiting on that would be a blank page forever.
 *   · OWNED — the board in the store is stamped with this page's project (lib/projectOwnership.ts), on
 *     the payload's own evidence. Once bound this holds by construction (the reset nulled the board, and
 *     setBoard refuses a foreign one), so on a correct path it never closes the gate. It is
 *     here because the binding is bookkeeping, and bookkeeping is what has failed before; a closed gate
 *     re-runs the reset rather than waiting, so a bookkeeping miss costs a reconnect, not a blank page.
 *
 * The reset is a LAYOUT effect so the gated commit and the one that reopens it land in the same task.
 * Frame-sampled across a rail switch (2026-10-08, headless): the ordinary effect painted the old board
 * under the new URL for 2–3 frames, then an empty board area for 2; the gate paints no stale frame and 1
 * empty one.
 */
function useProjectBinding(slug: string | undefined): boolean {
  const owned = ownedByThisPage(useSnapshot(store).board?.projectSlug)
  const [settled, setSettled] = useState<{ slug: string | undefined } | null>(null)
  const bound = feedIsBoundTo(slug) || (settled !== null && settled.slug === slug)
  const ready = bound && owned
  useLayoutEffect(() => {
    if (ready) return
    resetProjectState()
    rebindProject()
    setSettled({ slug })
  }, [slug, ready])
  return ready
}

/**
 * A board, for the project the URL names.
 *
 * `slug` is undefined on the unprefixed routes, which remain a supported state: the launching project
 * is still served at `/status/<name>` (and its threads' full-screen pages at `/thread/<slug>`) with no
 * `/project/<slug>` in front of it, and `apiBase()` answers `/_frizz` for exactly that case.
 */
function BoardRoute() {
  const { slug } = useParams()
  const thread = threadParam(useLocation().search) ?? undefined
  const ready = useProjectBinding(slug)
  useRouteToStore()
  // Returning from full screen plays the fullscreen door's view transition in REVERSE (react-router re-arms
  // it for the POP; the collapse icon opts in). The reverse morph needs the thread's board surface
  // mounted and named in THIS first commit — the one the transition's new-state snapshot reads — so
  // the priming is render-phase, the mirror of StandaloneRoute's render-phase drawer clear. A no-op
  // unless the previous render really was a full-screen page (see primeFullscreenReturn).
  useState(() => primeFullscreenReturn(thread))
  // Nothing renders against another project's state — see useProjectBinding.
  if (!ready) return null
  return <App key={slug ?? "__launching__"} />
}

/**
 * `/`: the all-projects grid — or, with `?thread=<slug>`, the LAUNCHING project's board with that thread
 * open over it.
 *
 * That second reading is the unprefixed launching project's drawer, the one address its old
 * `/thread/<slug>` had that nothing else can now say (that path is the thread's full-screen page since
 * 2026-11-07). It is an inbound alias, like the rest of the unprefixed shapes: once the board names its
 * slug the router writes `/project/<slug>?thread=<slug>` over it (lib/router.ts queueDestination). Two
 * component types rather than one that branches, so a switch between them remounts instead of changing
 * a component's hooks between renders.
 */
function RootRoute() {
  const { search } = useLocation()
  return threadParam(search) === null ? <GridRoute /> : <BoardRoute />
}

/**
 * The all-projects grid, which shows no project's feed and therefore must not disturb the binding.
 *
 * It reads only the machine-wide project list, so leaving the feed where it is costs nothing and buys
 * something: going home and back into the SAME project is free, instead of a teardown plus a
 * reconnect. (It used to call `useProjectBinding(undefined)`, which meant "the launching project" —
 * never "no project" — so the grid would have swapped one live feed for another. With the ref bug it
 * was a no-op in every case, so removing it changes nothing that ever ran.)
 */
function GridRoute() {
  // `/` is the home the operator KEEPS: while that is the Console, the grid forwards to it. The houses link
  // to the grid's own address (lib/homeView.ts PROJECTS_HREF), which never forwards, so the grid is always
  // one click away. Not on a phone: its board's back arrow comes HERE for the projects list — forwarding
  // would send that arrow straight back to the Console it was leaving.
  //
  // Only a BARE `/` forwards. Anything after it is for the grid to read — PROJECTS_HREF's marker, the
  // launcher's `?add=<dir>`, the server's `?unknown=<slug>` (ProjectGrid) — and the forward dropped it: run
  // `frizz` in a new folder with the Console kept and the offer to add it never appeared.
  //
  // Decided once, on ARRIVAL. The kept home is shared by every tab (lib/homeView.ts follows the storage
  // event), and read live it moved a tab sitting on the grid to the Console the moment ANOTHER tab chose
  // it. Another tab's choice should decide where this tab's next bare `/` goes, not the page it is reading.
  const homeView = useHomeView()
  const isMobile = useIsMobile()
  const { search } = useLocation()
  const [arrival] = useState(() => ({
    forward: homeView === "console" && !isMobile && search === "",
    chose: choseProjects(search),
  }))
  if (arrival.forward) return <Navigate to={CONSOLE_PATH} replace />
  return <GridPage chose={arrival.chose} />
}

/**
 * The grid itself. It shows no project's board, and it does not disturb a PROJECT's feed (above) — but a
 * feed the Console holds is handed back, because the Console's N connections serve nothing here
 * (api/socket.ts `leaveConsole`).
 *
 * Reached through PROJECTS_HREF, it records Projects as the kept home — the grid's counterpart of
 * ConsoleRoute's — and takes the marker out of the address, so a reload or a copied URL is plain `/`.
 */
function GridPage({ chose }: { chose: boolean }) {
  const navigate = useNavigate()
  useEffect(() => leaveConsole(), [])
  useEffect(() => {
    if (!chose) return
    setHomeView("projects")
    // From the live address, not the router's: ProjectGrid strips its own one-shot params with
    // history.replaceState before this runs.
    navigate({ pathname: location.pathname, search: withoutProjectsChoice(location.search) }, { replace: true })
  }, [chose, navigate])
  return <ProjectGrid />
}

/**
 * Hand the live feed to the Console — one connection per open project (api/consoleFeed.ts) — and say
 * whether the tree below may render yet. The Console's counterpart of `useProjectBinding`, gated the same
 * way and for the same reason: a page that renders before the reset reads the previous project's board
 * under the Console's URL. `feedIsConsole` asks the module holding the connections, so a remount has
 * nothing to remember.
 */
function useConsoleBinding(): boolean {
  const [, setBound] = useState(0)
  const ready = feedIsConsole()
  useLayoutEffect(() => {
    if (ready) return
    resetProjectState()
    bindConsole()
    setBound((n) => n + 1)
  }, [ready])
  return ready
}

/** The Console: every open project's board as one, at `/console`. */
function ConsoleRoute() {
  const ready = useConsoleBinding()
  // Which projects the feed connects to: the server's open ones, in rail order (lib/consoleProjects.ts).
  useConsoleFeedProjects()
  useRouteToStore()
  // Arriving here by any door makes the Console the home that is kept — the grid's Console link, a
  // bookmark, a link — so a bare `/` comes back to it. The houses do not: they always go to the grid
  // (lib/homeView.ts).
  useEffect(() => setHomeView("console"), [])
  // A machine with no project has nothing for the Console to show and nowhere for its prompt box to send:
  // it drew an empty sidebar whose box said "Profile loading…" for good. The grid's welcome is the page
  // for that, through PROJECTS_HREF so the kept home becomes the grid and a bare `/` does not forward back
  // here. The registry's own list, not the Console's open projects: a project the server has not opened
  // yet is still a project.
  const registry = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  if (registry.data?.length === 0) return <Navigate to={PROJECTS_HREF} replace />
  if (!ready) return null
  return <App key="@console" />
}

/**
 * URL → store, for the routes INSIDE a board.
 *
 * The drawer stack is valtio state, not route state, because a drawer is a stack with its own
 * animated unwind and several ways to open — so the URL is one input to it rather than its owner.
 * This is the direction react-router does not do for us: it resolves the path, and `applyPath` turns
 * the path and its `?thread=` into "which view, which thread is open, and is it a drawer or a queue
 * card". The other direction (store → URL) lives in lib/router.ts, which now navigates rather than
 * calling history directly.
 */
function useRouteToStore() {
  const location = useLocation()
  useEffect(() => {
    applyPath(innerPath(location.pathname), location.search)
  }, [location.pathname, location.search])
}

// Hands react-router's navigate to lib/router's module-level `spaNavigate`, for the leaves that must
// change the URL without router context (see registerNavigate). Both shells call it: each is the root
// of its own tree, and the fullscreen page has no RootLayout above it.
function useRegisterNavigate(): void {
  const navigate = useNavigate()
  useEffect(() => {
    registerNavigate((path, options) => navigate(path, options))
    return () => registerNavigate(null)
  }, [navigate])
}

/** The focused single-thread page. Deliberately OUTSIDE the layout: it has no rail, and should not. */
function StandaloneRoute() {
  const { thread, slug } = useParams()
  useRegisterNavigate()
  const ready = useProjectBinding(slug)
  // Any drawer stack left by the page we came from is cleared HERE, on this route's first render —
  // deliberately NOT in the fullscreen door's click handler, and deliberately not in an effect. The
  // door's navigation runs inside a view transition, which snapshots the OLD page two renders after
  // the click — a click-time clear removed the very sheet the transition slides into place. And the
  // NEW page is snapshotted at this render's commit, so an effect would be one paint too late: this
  // page's own DrawerStack would be captured painting the thread's sheet over itself mid-transition.
  // A render-phase write (the useState initializer runs exactly once, before the children render)
  // means DrawerStack below already sees the empty stack in the same pass.
  useState(() => { if (store.drawers.length > 0) store.drawers = [] })
  // Recorded every render, consumed by BoardRoute's mount: this is how the board knows its first
  // render is the return leg of the fullscreen door and should prime the reverse morph's target.
  noteStandaloneThreadRender(thread!)
  // The same gate as BoardRoute's: reached from another project, this page must not read that
  // project's board for its first commit.
  if (!ready) return null
  return (
    <>
      <StandaloneThreadPage slug={thread!} />
      {/* Its own, since it is outside the layout — and the SAME set the layout mounts. Skipping the
          rail does not mean skipping the toast, the image viewer or a reference's card. */}
      <PageHosts />
    </>
  )
}

const boardChildren = [
  { index: true, element: <BoardRoute /> },
  { path: "status/:status", element: <BoardRoute /> },
]

/**
 * `…/thread/<slug>/full`, the full-screen page's address until 2026-11-07, put on the current shape.
 *
 * Every link minted before then carries it — a bookmark, an open tab, a URL a worker pasted into a
 * handoff — so it keeps resolving. REPLACED rather than pushed, so Back never returns to an address
 * that only forwards.
 */
function DropFullSuffix() {
  const { pathname, search, hash } = useLocation()
  return <Navigate to={{ pathname: pathname.replace(/\/full\/?$/, ""), search, hash }} replace />
}

/**
 * `/console/thread/<key>`, the Console's drawer address until 2026-11-07, put on the current one,
 * `/console?thread=<key>`. A thread's full-screen page is its own project's (standaloneThreadHref), so
 * on the Console a thread path has nothing else it could mean.
 */
function ConsoleThreadRedirect() {
  const { thread } = useParams()
  const { search, hash } = useLocation()
  return <Navigate to={{ pathname: CONSOLE_PATH, search: withThreadParam(search, thread ?? null), hash }} replace />
}

/**
 * A render error no surface caught. The router catches it at the route, and without this it draws its
 * own page for developers (components/ErrorBoundary.tsx has the history). "Try again" revalidates,
 * which is what makes the router render the route's element again.
 */
function RouteError() {
  const error = useRouteError()
  const { revalidate } = useRevalidator()
  return <RootErrorPage error={error instanceof Error ? error : new Error(String(error))} onRetry={() => void revalidate()} />
}
const errorElement = <RouteError />

export const router = createBrowserRouter([
  // THE THREAD'S OWN PATH IS ITS FULL-SCREEN PAGE (lib/standaloneThreadRoute.ts); a drawer is the
  // board's URL with `?thread=<slug>` (lib/router.ts). These pages sit OUTSIDE the layout — they have
  // no rail, and should not. react-router ranks by specificity, so the `/full` aliases beat the page's
  // own routes regardless of order.
  { path: "/thread/:thread", element: <StandaloneRoute />, errorElement },
  { path: `${PROJECT_PATH}/thread/:thread`, element: <StandaloneRoute />, errorElement },
  { path: "/thread/:thread/full", element: <DropFullSuffix />, errorElement },
  { path: `${PROJECT_PATH}/thread/:thread/full`, element: <DropFullSuffix />, errorElement },
  {
    element: <RootLayout />,
    errorElement,
    children: [
      { path: "/", element: <RootRoute /> },
      // The launching project, unprefixed. `/` itself belongs to the grid, so this project reaches its
      // board through a status path or `/?thread=<slug>` — see base-path.ts on why an empty base is
      // supported.
      { path: "/status/:status", element: <BoardRoute /> },
      { path: PROJECT_PATH, children: boardChildren },
      // The Console's own base (lib/base-path.ts): its threads are named by key, `/console?thread=<key>`.
      {
        path: CONSOLE_PATH,
        children: [
          { index: true, element: <ConsoleRoute /> },
          { path: "thread/:thread", element: <ConsoleThreadRedirect /> },
          { path: "status/:status", element: <ConsoleRoute /> },
        ],
      },
      // Anything else is a board for the launching project, which is what the old shell did with an
      // unknown path: applyPath falls through to the queue.
      { path: "*", element: <BoardRoute /> },
    ],
  },
])
