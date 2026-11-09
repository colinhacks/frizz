import { FRIZZ_ROUTE_PREFIX } from "@frizz/shared"

// WHICH PROJECT THIS PAGE IS SHOWING, taken from its own URL.
//
// One Frizz per machine serves every project from one origin, so the URL names the project:
// `/project/nub/thread/fix-auth`. That works precisely because Frizz's own routes were moved under
// `/_frizz/` — the top-level namespace is otherwise free, so a first segment is either the SPA's own
// route or the `project` segment, and nothing else. (`/nub/thread/x` — the project at the ROOT — was
// the shape considered and rejected; see PROJECT_SEGMENT below for why it cost too much.)
//
// AN EMPTY BASE IS A SUPPORTED STATE, not a bug: the launching project is still served unprefixed at
// `/status/<name>` (and its threads' full-screen pages at `/thread/<slug>`), which is what lets the server land slug routing without a
// lockstep rewrite of this file, and what keeps every pre-singleton bookmark resolving. It is a legacy
// INBOUND alias, not a shape to MINT — see `outerPath`/`projectHref`. Note it does NOT include `/`,
// which is the all-projects GRID; the launching project's queue reaches its board through
// `queueDestination` (lib/router.ts) instead.

/**
 * The SPA's own top-level route names.
 *
 * Anything else in first position is a project slug. This is the single definition of that set —
 * `isFrizzRoute` in markdownTargets.ts used to keep its own copy, and under a project prefix a stale
 * copy is not a small bug: every in-app link starts looking like a FILESYSTEM path to the markdown
 * sanitizer, and renders as a disabled local-file chip.
 */
export const APP_ROUTE_SEGMENTS = new Set(["thread", "status"])

// A thread slug's grammar (shared/src/thread-slug.ts) — what a Console link may pair with its project.
// A segment outside it (already a `<project>~<slug>` key, or junk) is not re-keyed.
const CONSOLE_KEYABLE_SLUG = /^[a-z0-9][a-z0-9-]*$/

/**
 * This page’s path, or `/` where there is no page.
 *
 * These helpers are imported by modules that also run under node — the markdown sanitizer and the
 * socket transport both have unit tests with no DOM — so reading `location` unguarded turns a pure
 * function into one that throws depending on who imported it. A STUBBED location counts too: the
 * socket tests install one carrying only `origin`, so a present `location` is not a promise of a
 * present `pathname`.
 */
function here(pathname?: string): string {
  if (typeof pathname === "string") return pathname
  const current = typeof location === "undefined" ? undefined : location.pathname
  return typeof current === "string" ? current : "/"
}

/**
 * Projects live UNDER a segment of their own rather than at the root.
 *
 * `/nub` would have made every project slug a top-level route name, so every page Frizz might later
 * want — settings, docs, a machine dashboard — would have to be fought for against a directory
 * somebody happens to have. `/project/nub` costs one segment and keeps the root free.
 */
const PROJECT_SEGMENT = "project"
export const PROJECT_PREFIX = `/${PROJECT_SEGMENT}`

/** The slug this page is showing, or `undefined` for the unprefixed launching project. */
export function projectSlug(pathname?: string): string | undefined {
  const [, first, second] = here(pathname).split("/")
  return first === PROJECT_SEGMENT && second ? second : undefined
}

/**
 * THE CONSOLE — every project's board as one, at `/console`.
 *
 * It names NO project, and that is the one way it differs from the unprefixed launching project, which
 * also names none: the launching project's page talks to `/_frizz` and means it, while a Console page
 * that reaches `/_frizz` for a thread or a project has forgotten to say which one. So the Console is a
 * base of its own — the router's paths (`/status/<name>`, and `?thread=<key>`) work under it exactly as
 * under a project — and api/rpc.ts refuses, on this page, any call that would fall back to the launching project.
 * Its threads are named by key (lib/threadKey.ts).
 */
const CONSOLE_SEGMENT = "console"
export const CONSOLE_PATH = `/${CONSOLE_SEGMENT}`

/** Is this page the Console? */
export function isConsolePath(pathname?: string): boolean {
  return here(pathname).split("/")[1] === CONSOLE_SEGMENT
}

/** The page URL for a project — the one place that knows the shape. */
export function projectHref(slug: string): string {
  return `${PROJECT_PREFIX}/${slug}`
}

/** `/project/nub`, `/console` on the Console, or `""` when this page is the unprefixed launching project. */
export function basePath(pathname?: string): string {
  if (isConsolePath(pathname)) return CONSOLE_PATH
  const slug = projectSlug(pathname)
  return slug ? projectHref(slug) : ""
}

/** The path with the project prefix removed — what the router reasons about. */
export function innerPath(pathname?: string): string {
  const path = here(pathname)
  const base = basePath(path)
  if (!base) return path || "/"
  return path.slice(base.length) || "/"
}

/** An inner path put back in terms the address bar uses. */
export function outerPath(inner: string, pathname?: string): string {
  const base = basePath(here(pathname))
  return base ? `${base}${inner === "/" ? "" : inner}` || "/" : inner
}

/**
 * An UNPREFIXED in-app route re-pointed at the project this page is showing, or `null` for anything
 * else (an already-prefixed link, a `/project/...` link, `/`, a filesystem path, a web URL).
 *
 * A worker writes `[label](/thread/<slug>)` — the shape from when one server meant one project, and
 * the shape its prompt still teaches. Rendered verbatim under `/project/nub`, that anchor addresses
 * whichever project LAUNCHED the server: a plain left-click is caught by the thread-link interceptor
 * and opens the right thread, but ⌘-click, middle-click and "open link in new tab" hand the raw href
 * to the browser and land on a stranger's board (or on <MissingThread>). Rewriting the href at
 * sanitize time fixes every one of those without the author having to know which project they are in.
 *
 * `/` is deliberately NOT rewritten: it is the all-projects grid, which is the same page everywhere.
 *
 * ON THE CONSOLE a thread link needs `project` — the project the prose belongs to (its surface's
 * <ProjectScope>). The Console names no project, so a thread link there would leave the browser to
 * guess among every project's threads of that name: one that opens it in a new tab, or any link the
 * click interceptor (lib/thread-links.ts) cannot place, landed on whichever project happened to have the
 * slug, or on the launching project's. With a project the link goes to that project's own page for the
 * thread (`/project/<project>/thread/<slug>`, its full-screen page), which is where it lives; a plain
 * click still opens it on the Console. With none, the link is left exactly as written.
 */
export function prefixedAppRoute(href: string | null | undefined, pathname?: string, project?: string): string | null {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return null
  const bare = href.replace(/[?#].*$/u, "")
  if (projectSlug(bare)) return null // already names its project
  const [, first = "", slug = ""] = bare.split("/")
  if (!APP_ROUTE_SEGMENTS.has(first)) return null
  if (first === "thread" && isConsolePath(pathname)) {
    if (!project || !CONSOLE_KEYABLE_SLUG.test(slug)) return null
    return `${projectHref(project)}${href}`
  }
  const outer = outerPath(href, pathname)
  return outer === href ? null : outer
}

/**
 * Where THIS page's API lives: `/_frizz/nub`, or `/_frizz` unprefixed.
 *
 * Every client URL builder goes through here, so a page always addresses the project it is showing
 * rather than whichever one happens to have launched the server.
 */
export function apiBase(pathname?: string): string {
  const slug = projectSlug(pathname)
  // The API keeps the FLAT `/_frizz/<slug>/…` shape. It already sits inside a reserved namespace, so
  // it has no root to protect, and the server's split stays a two-part one.
  return slug ? projectApiBase(slug) : FRIZZ_ROUTE_PREFIX
}

/** Where a NAMED project's API lives, whatever page is asking — the Console's way to address one. */
export function projectApiBase(slug: string): string {
  return `${FRIZZ_ROUTE_PREFIX}/${slug}`
}
