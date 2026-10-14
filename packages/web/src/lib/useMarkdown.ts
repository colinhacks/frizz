import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import { mdToHtml, mdInlineToHtml } from "./markdown.ts"
import { githubRepoFor, subscribeGithubRepo } from "./githubAutolink.ts"
import { githubRefsInHtml, noteGithubRefs } from "./githubHovercards.ts"
import { localPathBaseFor, subscribeLocalPathBase, type LocalPathBase } from "./localPathBase.ts"
import { useProjectScope } from "./projectScope.tsx"

// Memoized markdown rendering, for every surface that drops agent prose into `dangerouslySetInnerHTML`.
//
// It exists because `mdToHtml` is not a pure function of its argument: the GitHub autolinker
// (githubAutolink.ts) reads the project's repo from module state, and that state arrives from the board a
// beat after a thread's own transcript query resolves. Every call site used to memoize on the markdown
// STRING alone, so the HTML built during that beat — with no repo, hence no links — was the HTML the
// reader kept for the life of the page. Making the repo a subscribed render input is what fixes it, and
// putting it in one hook is what stops the next markdown surface from reintroducing the bug.
//
// useSyncExternalStore over a SCALAR rather than useSnapshot, matching lib/deliverQueuedNow.ts: this
// runs in every prose block on screen, and the value changes at most once per page.

/**
 * The repo GitHub-style references link to, as a render input.
 *
 * On the Console it is the SURFACE's project's, not the page's — the page names none, and a card's
 * `#123` means an issue in the repo of the project that card belongs to (githubRepoFor).
 */
export function useGithubRepoForLinks(): string | null {
  const project = useProjectScope()
  const read = useCallback(() => githubRepoFor(project), [project])
  return useSyncExternalStore(subscribeGithubRepo, read, read)
}

/**
 * The project root a relative path in prose resolves against, as a render input.
 *
 * Same subscription shape, and the same reason, as the repo above: the board arrives after a thread's
 * own transcript query, so prose memoized on its markdown string alone renders its file links while
 * this is still empty and never rebuilds them.
 *
 * On the Console it is the SURFACE's project, not the page's — the page names none, and a card's
 * `.frizz/…/HANDOFF.md` means the directory of the project that card belongs to (localPathBaseFor).
 */
export function useLocalPathBase(): LocalPathBase {
  const project = useProjectScope()
  const read = useCallback(() => localPathBaseFor(project), [project])
  return useSyncExternalStore(subscribeLocalPathBase, read, read)
}

/**
 * Block prose → sanitized HTML. `asDocument` is the built-in file reader's (see mdToHtml), and so is an
 * explicit `baseDir` — the DOCUMENT's own directory, which outranks the project root a relative link
 * resolves against on every other surface.
 */
export function useMarkdownHtml(md: string, opts?: { baseDir?: string; asDocument?: boolean }): string {
  const repo = useGithubRepoForLinks()
  const base = useLocalPathBase()
  // The project a worker's `/thread/<slug>` link names on the Console (lib/base-path.ts prefixedAppRoute).
  const project = useProjectScope()
  const { baseDir, asDocument } = opts ?? {}
  const dir = baseDir ?? base.dir
  const html = useMemo(
    () => mdToHtml(md, { baseDir: dir, homeDir: base.home, document: asDocument, project, githubRepo: repo }),
    [md, dir, base.home, asDocument, project, repo],
  )
  useGithubHovercardRefs(html)
  return html
}

/**
 * Queue every GitHub reference this prose contains for the batched hovercard fetch.
 *
 * IT LIVES IN THE RENDER HOOK, not in a component, so a hovercard is available on EVERY surface that
 * renders agent prose — the transcript, the signal cards, the question blocks, the plan and file
 * drawers — without each of them remembering to opt in. The scan is a string match guarded by an
 * `includes` (lib/githubHovercards.ts), and registration is idempotent, so prose with no references
 * costs one substring search per render.
 */
function useGithubHovercardRefs(html: string): void {
  const refs = useMemo(() => githubRefsInHtml(html), [html])
  useEffect(() => {
    if (refs.length > 0) noteGithubRefs(refs)
  }, [refs])
}

/** Inline-only prose → sanitized HTML, for hosts that are one line tall (see mdInlineToHtml). */
export function useInlineMarkdownHtml(md: string): string {
  const repo = useGithubRepoForLinks()
  const base = useLocalPathBase()
  const project = useProjectScope()
  const html = useMemo(
    () => mdInlineToHtml(md, { baseDir: base.dir, homeDir: base.home, project, githubRepo: repo }),
    [md, base.dir, base.home, project, repo],
  )
  useGithubHovercardRefs(html)
  return html
}
