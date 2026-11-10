import type { QueryClient } from "@tanstack/react-query"
import { renderCodeBody } from "./codeBody.ts"
import { localFileQuery, type LocalFileRead } from "./localFileQuery.ts"
import { isLightboxPath, isLocalMarkdownFile } from "./markdownTargets.ts"
import { resolveFileLanguage } from "./syntaxHighlight.ts"

// The local file readers' highlighted source and the hover prewarm (lib/localFileQuery.ts is the read
// they share). Split from that module on 2026-11-10: it is the half that needs highlight.js, and the
// read's key is needed on every page (api/socket.ts invalidates it), so the two no longer travel together.

// Highlighted source markup, memoised across mounts. hljs over a few thousand lines is a single
// blocking task, and the one moment it must not run is while the viewer is sliding in — so the hover
// prewarm pays it during the idle time before the click, and the panel then just reads the string.
const HIGHLIGHTED = new Map<string, { raw: string; html: string }>()
const HIGHLIGHTED_MAX = 12

export function highlightedSource(path: string, raw: string): string {
  const hit = HIGHLIGHTED.get(path)
  if (hit && hit.raw === raw) return hit.html
  const html = renderCodeBody(raw, resolveFileLanguage(path))
  HIGHLIGHTED.set(path, { raw, html })
  // Insertion-ordered, so the oldest key is the first one out — a plain LRU is not worth the bookkeeping
  // for a cache this small, and the reader only ever moves between a handful of files.
  if (HIGHLIGHTED.size > HIGHLIGHTED_MAX) {
    const oldest = HIGHLIGHTED.keys().next()
    if (!oldest.done) HIGHLIGHTED.delete(oldest.value)
  }
  return html
}

function whenIdle(run: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
  if (idle) idle(run, { timeout: 500 })
  else setTimeout(run, 0)
}

// Hover on a file row: fetch the body and highlight it, both off the click path. Fire-and-forget by
// design — a file that has gone away, or a gate that refuses it, must not raise anything on a HOVER;
// the click that follows renders the same error through the panel's own query, where the reader can
// see it.
export function prewarmLocalFile(client: QueryClient, path: string): void {
  // A picture or a video opens in the lightbox, which reads nothing through here.
  if (isLightboxPath(path)) return
  client
    .prefetchQuery(localFileQuery(path))
    .then(() => {
      const cached = client.getQueryData<LocalFileRead>(localFileQuery(path).queryKey)
      if (!cached?.markdown || cached.binary || isLocalMarkdownFile(path)) return
      whenIdle(() => highlightedSource(cached.path, cached.markdown))
    })
    .catch(() => {})
}
