import { openThread, store, topThreadSlug } from "../store.ts"
import { innerPath, isConsolePath, projectSlug } from "./base-path.ts"
import { keyProject, threadKey } from "./threadKey.ts"

// A worker can emit a markdown link to another frizz thread — `[label](/thread/<slug>)` — e.g. after
// spawning one via the frizzctl spawn-thread command. `/thread/<slug>` is a RESERVED SPA route
// (markdownTargets.ts isFrizzRoute), so markdown.ts leaves it a normal anchor rather than a local-file
// button. This one delegated listener intercepts a plain left-click on any such anchor and opens the
// thread IN THE DRAWER (openThread — dedupes/raises if already open) instead of letting the browser
// navigate a new tab. A modified click (⌘/ctrl/shift/alt) is left alone so the same href still works
// as a real deep-link opened in a new tab. Covers every sanitized markdown surface (chat, the doc
// drawer, drawers) since it delegates from document.
//
// Matched against the INNER path, because markdown.ts now stamps this page's project prefix onto an
// unprefixed in-app link (see prefixedAppRoute — the raw href had to become navigable in its own
// right, for the modified clicks this handler deliberately does not take). Opening in the drawer is
// only right for a thread of the project already on screen, so a link naming a DIFFERENT project is
// left to the browser. On the Console the stamped link names the thread's own project
// (`/project/<project>/thread/<slug>`, prefixedAppRoute), and is opened here as that project's thread; an
// old Console link names its KEY (`/console/thread/<project>~<slug>`), so the optional `<project>~` is
// part of the match.
//
// A thread link's href is the thread's FULL-SCREEN page (lib/standaloneThreadRoute.ts), so a new tab
// opens the thread alone; the in-place click opens the drawer, which is the board's `?thread=<slug>`.
const THREAD_HREF = /^\/thread\/((?:[^/~]+~)?[a-z0-9][a-z0-9-]*)\/?$/

export function installThreadLinkInterceptor(): () => void {
  const handler = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href*="/thread/"]') : null
    const href = anchor?.getAttribute("href")
    if (!anchor || !href || !href.startsWith("/")) return
    const linked = projectSlug(href)
    const onConsole = isConsolePath()
    // On the Console every project is on the page, so a link to another project's thread opens here when
    // the merged board has it. Anywhere else, another project's board — let the browser go there.
    if (linked && linked !== projectSlug() && !onConsole) return
    const match = THREAD_HREF.exec(innerPath(href))
    if (!match) return
    let target = match[1]
    const keyed = keyProject(target) !== undefined
    if (keyed && !onConsole) return // a key is the Console's name; no project page has it
    if (keyed) {
      if (!store.board?.threads.some((t) => t.id === target)) return // not on the Console — let the browser go
    } else if (onConsole) {
      // A worker's `/thread/<slug>` names a thread of ITS project: the card or drawer the link is in.
      const from = linked ?? keyProject(anchor.closest("[data-queue-card]")?.getAttribute("data-queue-card") ?? topThreadSlug() ?? "")
      if (from) {
        const key = threadKey(from, target)
        if (!store.board?.threads.some((t) => t.id === key)) return // not on the Console — let the browser go
        target = key
      }
    }
    event.preventDefault()
    event.stopPropagation()
    openThread(target)
  }
  document.addEventListener("click", handler)
  return () => document.removeEventListener("click", handler)
}
