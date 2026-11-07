import { isConsolePath, outerPath, projectHref } from "./base-path.ts"
import { splitThreadKey } from "./threadKey.ts"

/**
 * The href for a thread's FULL-SCREEN page — an OUTER path, because it goes straight into an `<a href>`
 * and the browser resolves it against the origin, not against the router.
 *
 * THE THREAD'S OWN PATH IS ITS FULL-SCREEN PAGE: `/project/<p>/thread/<slug>`. A drawer over a board is
 * that board's URL with `?thread=<slug>` (lib/router.ts boardThreadHref). Until 2026-11-07 it was the
 * other way round — the path opened the drawer and full screen was `…/thread/<slug>/full` — and the
 * maintainer asked for the swap: the path names the thread, so it is the page that shows the thread
 * alone. `/full` is still read, and routes.tsx replaces it with this shape.
 *
 * It MUST carry the project prefix. One Frizz serves every project on the machine now, so the
 * unprefixed `/thread/<slug>` resolves against whichever project happened to launch the server:
 * the ↗ button on a thread in any OTHER project opened a page that either showed the wrong project's
 * thread of the same name or dead-ended in <MissingThread> (maintainer 2026-08-07, on the ↗ button:
 * "this is an old url"). Unprefixed output is still correct — and still what this returns — for the
 * launching project, which is served at the root.
 */
export function standaloneThreadHref(slug: string, pathname?: string): string {
  // A Console thread is named by its key; its full page is its own project's, where the slug is real.
  const parts = splitThreadKey(slug)
  if (parts) return `${projectHref(parts.project)}/thread/${encodeURIComponent(parts.slug)}`
  if (isConsolePath(pathname)) return `/thread/${encodeURIComponent(slug)}`
  return outerPath(`/thread/${encodeURIComponent(slug)}`, pathname)
}

/**
 * The slug in an INNER full-screen path (main.tsx feeds it `innerPath()`), or null: `/thread/<slug>`,
 * or the `/thread/<slug>/full` every link minted before 2026-11-07 carries.
 */
export function parseStandaloneThreadPath(path: string): string | null {
  const match = path.match(/^\/thread\/([^/]+)(?:\/full)?\/?$/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/**
 * Is this click one the SPA should handle itself? The fullscreen affordance is a real `<a href>` so the
 * browser owns every "open elsewhere" gesture — ⌘/Ctrl-click, middle-click, shift-click, right-click
 * → Open in new tab — and only an unmodified primary click is intercepted to navigate in place
 * (maintainer 2026-08-28: "if you click it normally, it just happens in the same tab; right-click or
 * command-click opens a new tab").
 */
export function isPlainLeftClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented
}
