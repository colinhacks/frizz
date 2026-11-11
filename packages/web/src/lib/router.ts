import { subscribe } from "valtio"
import { store, topThreadSlug, closeDrawersById, closeLayersDisplacedBy, paneEnabled } from "../store.ts"
import { innerPath, outerPath, projectHref } from "./base-path.ts"
import { parseStandaloneThreadPath } from "./standaloneThreadRoute.ts"

// URL ⇄ state sync, SPA-style. A board's URL is its VIEW in the path — `/` (the board) or
// `/status/<status>` (URL-only lists) — and the thread open on it in the QUERY: `?thread=<slug>`
// names the thread in the board's pane, or the drawer stack's topmost thread layer. The thread's own
// path, `/thread/<slug>`, is its full-screen page (lib/standaloneThreadRoute.ts), which is a different
// route and not this module's to write.
//
// THE DRAWER IS A QUERY PARAMETER, not a path, since 2026-11-07 (maintainer: "a thread opened in a
// drawer in a project console is indicated with a query parameter", with `/project/reylo/thread/<slug>`
// as the full-screen view). It was `/thread/<slug>` until then, and full screen `/thread/<slug>/full`.
// A query composes with the path the way a drawer composes with the board: the drawer sits OVER a view,
// so a status list keeps its own path under it.
//
// History contract (standard SPA): opening a thread PUSHES an entry so the browser Back button unwinds
// it; other transitions REPLACE so transient state never buries the back stack.
//
// (The focus machine this used to route through was deleted — the router writes store.view directly.)

/** The query parameter that names the thread open over a board. */
export const THREAD_PARAM = "thread"

/** The thread a board URL's query names, or null. */
export function threadParam(search: string): string | null {
  const value = new URLSearchParams(search).get(THREAD_PARAM)
  return value ? value : null
}

/**
 * `search` with the thread parameter set to `slug` (or removed, for null), every other parameter kept.
 *
 * Spelled by hand rather than through URLSearchParams' serializer, which writes `~` as `%7E`: a Console
 * key (`billing~retry-webhooks`, lib/threadKey.ts) would read as `billing%7Eretry-webhooks` in the
 * address bar.
 */
export function withThreadParam(search: string, slug: string | null): string {
  const params = new URLSearchParams(search)
  params.delete(THREAD_PARAM)
  const rest = params.toString()
  const parts = [...(slug ? [`${THREAD_PARAM}=${encodeURIComponent(slug)}`] : []), ...(rest ? [rest] : [])]
  return parts.length ? `?${parts.join("&")}` : ""
}

/** The board view the store is showing, as an inner path. */
function currentViewPath(): string {
  if (store.view.startsWith("status:")) return `/status/${encodeURIComponent(store.view.slice(7))}`
  return "/"
}

/** The thread the URL should name: the topmost thread layer, or a parked route still being settled. */
function currentThread(): string | null {
  // A parked route still IS that thread's URL. Without this the address bar would drop the parameter
  // for the frame or two before the board settles the destination, and settling it into a drawer would
  // then push a redundant history entry for a URL the user never left.
  return topThreadSlug() ?? store.routeThreadSlug
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    // A hand-edited/truncated percent escape must not throw during primeRoute() and abort the entire
    // app before React mounts. Treat malformed routes like any other unknown path: return to Queue.
    return null
  }
}

/**
 * An inner path put back in address-bar terms — with ONE correction `outerPath` cannot make.
 *
 * On an unprefixed page `outerPath("/")` is `"/"`, and since the singleton landed `/` is the
 * ALL-PROJECTS GRID, not a board. So closing the last thread drawer on the launching project — the
 * commonest navigation there is — navigated the maintainer straight to the project picker (verified
 * live, 2026-08-07). Every other project was unaffected: theirs is `/project/<slug>`, which is a board.
 *
 * The launching project has a `/project/<slug>` URL too; it simply had no way to say its own slug
 * until the board snapshot started carrying one. Use it for the queue and the ejection stops. With no
 * slug yet (a pre-restart server, or before the first board lands) this is exactly the old behaviour.
 */
export function queueDestination(inner: string, slug = store.board?.projectSlug): string {
  const outer = outerPath(inner)
  return outer === "/" && slug ? projectHref(slug) : outer
}

/**
 * The URL of a board with `slug` open on it, in the pane or a drawer. THIS page's board by default;
 * `project` names another project's.
 */
export function boardThreadHref(slug: string, project?: string): string {
  const board = project ? projectHref(project) : queueDestination("/")
  return `${board}${withThreadParam("", slug)}`
}

/** URL → store: `path` is the INNER path (the board's view), `search` the query (the open thread). */
export function applyPath(path: string, search = ""): void {
  const status = path.match(/^\/status\/([^/]+)$/)
  const statusName = status ? decodeSegment(status[1]) : null
  // Everything but a status list is the queue.
  store.view = statusName === null ? "todos" : `status:${statusName}`
  const slug = threadParam(search)
  if (slug === null) {
    // No thread named: Back past the last thread layer unwinds the stack (animated).
    store.routeThreadSlug = null
    store.paneSlug = null
    closeDrawersById(store.drawers.map((d) => d.id))
    return
  }
  // THE PANE: the address names what the pane shows. A thread it already shows is this sync
  // coming back around, and the sheets over it stay. Anything else is Back, Forward or a link: parked
  // like any thread, with the board's App settling it through pushDrawer (store.ts).
  if (paneEnabled()) {
    if (store.paneSlug === slug) {
      store.routeThreadSlug = null
      return
    }
    closeDrawersById(store.drawers.map((d) => d.id))
    store.paneSlug = null
    store.routeThreadSlug = slug
    return
  }
  // Back/forward landed on a thread: if that thread is somewhere in the stack, unwind ABOVE it and
  // we're done — the surface it asks for is already up.
  const idx = store.drawers.findIndex((d) => d.kind === "thread" && d.slug === slug && !d.closing)
  // Unwind the layers ABOVE the matched thread through their animated closers (slide-out), not an
  // instant splice — Back/forward must play the same exit animation as backdrop/Esc.
  if (idx !== -1) {
    store.routeThreadSlug = null
    closeDrawersById(store.drawers.slice(idx + 1).map((d) => d.id))
    return
  }
  // Otherwise PARK the slug: the destination depends on whether the thread is in this project, which
  // the board alone can say, and on a cold deep link no board has arrived yet. App settles it the first
  // render the board is authoritative (store.resolveRoutedThread).
  //
  // What the destination DISPLACES is already known, though, and must go now. The commonest way here
  // with a stack open is Back after a lateral move — thread A, then a link or a sidebar row to B: the
  // one-drawer policy replaced A with B, so Back to A's entry finds B still on top. Leaving B up made
  // the store→URL sync push B's URL back over A's, then resolveRoutedThread push A's over that — two
  // new entries per Back press, flipping between the threads and never reaching the board. Closing B
  // here is the same displacement opening A would do, a beat earlier, so the URL never disagrees.
  closeLayersDisplacedBy({ kind: "thread", slug })
  store.routeThreadSlug = slug
}

// Cold-load adoption is initial application state, so establish it BEFORE React's first render.
// main.tsx primes synchronously; startRouter repeats this safely (both paths are idempotent) so
// tests/non-main entry points retain the old self-contained contract.
//
// A thread parameter only PARKS its slug here — the destination needs the board (see applyPath). That is
// not a regression of the old opacity-0-phantom bug: the layer that bug produced was one animated in
// AFTER mount, whereas resolveRoutedThread still pushes `routed: true` (painted open, no animation),
// and it fires on the very render the board lands — the same render that replaces App's boot spinner
// with the board, so the thread and the page around it appear together.
export function primeRoute(path = location.pathname, search = currentSearch()): void {
  applyPath(innerPath(path), search)
}

/** This page's query, or `""` where there is no page (a node test, a stubbed location). */
function currentSearch(): string {
  return typeof location === "undefined" ? "" : (location.search ?? "")
}

/**
 * STORE → URL. The other direction now belongs to the route tree (routes.tsx `useRouteToStore`).
 *
 * `navigate` rather than `history.pushState`: with a real router the history stack is the router's,
 * and writing to it behind its back leaves react-router rendering the previous match — the drawer
 * would open with the address bar agreeing and the page not.
 *
 * Back/forward needs no listener any more either. The router owns popstate and re-renders the match,
 * which drives `useRouteToStore`, which calls `applyPath` — the same function the old popstate
 * handler called, reached the same way every other navigation reaches it.
 */
// THE APP'S NAVIGATOR, reachable without router context. react-router's `useNavigate` is a hook, and
// the components that need to change the URL in place — the fullscreen door on a sidebar row, the
// back arrow on the fullscreen page — render in unit tests and fixtures with no <Router> above them,
// where the hook throws. The route tree registers its navigate here (routes.tsx, both shells) and
// leaves call there; with nothing registered (a bare test render) it falls back to a document load,
// which is what the underlying <a href> would have done anyway.
// `viewTransition` rides through to react-router's navigate, which wraps the route swap in
// `document.startViewTransition` where the browser has it and falls back to an instant swap where it
// doesn't. Both halves of the fullscreen door pass it today; react-router re-arms
// it on its own for the browser-Back POP of a pair that transitioned.
export type SpaNavigateOptions = { replace?: boolean; viewTransition?: boolean }

let registeredNavigate: ((path: string, options?: SpaNavigateOptions) => void) | null = null

export function registerNavigate(navigate: ((path: string, options?: SpaNavigateOptions) => void) | null): void {
  registeredNavigate = navigate
}

export function spaNavigate(path: string, options?: SpaNavigateOptions): void {
  if (registeredNavigate) registeredNavigate(path, options)
  else if (typeof location !== "undefined") location.assign(path)
}

/**
 * Did this app push the history entry the page is on, in this session?
 *
 * react-router numbers the entries it writes (`idx` in history.state): the entry a document loaded on
 * is 0, and every push counts up from there — including a push lib/router made when a thread opened.
 * So a thread page on an entry above 0 has an entry BELOW it that is ours (the board it was opened
 * from, or whatever the app showed before), and the platform's Back returns there. On 0 it arrived by
 * a cold link — a bookmark, a notification, a pasted URL — and what sits below it, if anything, is some
 * other site.
 *
 * The phone thread header's ← asks this to behave exactly like Back: pop when there is an entry of
 * ours to pop to, and only otherwise fall back to replacing the thread's entry with the board (the
 * desktop ×'s close). Replacing it always had left TWO board entries behind every ← — the board the
 * thread was opened from, and the thread's entry rewritten to it — so the next Back did nothing.
 * The same-URL entries lib/backDismiss pushes carry the router's state over, so they read the same.
 * That includes one a reload left behind with no sheet to own it, which made ← pop onto the very same
 * thread; main.tsx steps off such an entry at boot (backDismiss `stepOffStaleLayerEntries`), so the
 * entry a page sits on is the router's own and this index stays truthful across a reload.
 */
export function appPushedCurrentEntry(state: unknown = typeof history === "undefined" ? null : history.state): boolean {
  const idx = state && typeof state === "object" ? (state as { idx?: unknown }).idx : undefined
  return typeof idx === "number" && idx > 0
}

export function startRouter(navigate: (path: string, options: { replace: boolean }) => void): () => void {
  // Boot: adopt whatever the address bar says (deep link / reload restores the state).
  primeRoute()

  return subscribe(store, () => {
    // The fullscreen page is NOT the board's URL to write. Its route lives outside RootLayout, but
    // valtio delivers this notification a microtask late: StandaloneRoute clears the drawer stack on
    // its first render (it moved there from the fullscreen door's click handler for the view
    // transition — see ExpandThreadLink), so by the time this runs the address bar already says
    // `/thread/<slug>` and the board shell is on its way out — and without this guard the
    // "unwind" below navigated straight back to the board (caught live, 2026-08-28: a plain click
    // on the door left the URL exactly where it was).
    if (parseStandaloneThreadPath(innerPath()) !== null) return
    const thread = currentThread()
    const pathname = queueDestination(currentViewPath())
    const search = withThreadParam(currentSearch(), thread)
    if (pathname === location.pathname && search === currentSearch()) return
    // OPENING a thread pushes history — a URL naming a thread the address bar does not already name.
    // Unwinding, non-thread transitions and a rewrite that keeps the thread (the unprefixed `/?thread=x`
    // taking its `/project/<slug>` prefix once the board names it) replace.
    const opening = thread !== null && thread !== threadParam(currentSearch())
    navigate(`${pathname}${search}`, { replace: !opening })
  })
}
