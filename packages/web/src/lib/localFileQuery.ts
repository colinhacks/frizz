import { fileRpc } from "./consoleProjects.ts"
import { isLocalMarkdownFile } from "./markdownTargets.ts"

// The ONE read of a local file the /full split viewer renders, shared by the panel that shows it and
// by the rail row that PREWARMS it on hover (maintainer 2026-09-01: "consider rendering optimizations
// like eager rendering when the user hovers over a given changed file"). Both must use the identical
// key and fetcher or the prefetch warms a cache entry the panel never looks in.
//
// Markdown reads through the reader gate (`.md` only, canonical path included); anything else reads
// through the text gate, which since 2026-09-03 is rooted identically — home-and-below plus the temp
// trees — so a worker's worktree file opens as readily as one in the project dir. Either way the result
// carries the CANONICAL path (symlinks resolved), which is what the panel labels, links relative to,
// and stamps on context items — and `binary`, the text gate's word on whether the file is text at all,
// which is what a click routes on (lib/local-file-links.ts) and what the PDF view reloads on (`modifiedAt`).
// The key alone — what the socket's `file-changed` frame invalidates (api/socket.ts), keyed by the
// path the reader subscribed with, which is the path it queried with.
export function localFileQueryKey(path: string): readonly [string, string] {
  return [isLocalMarkdownFile(path) ? "localMarkdown" : "localFile", path]
}

export interface LocalFileRead {
  path: string
  markdown: string
  truncated: boolean
  binary: boolean
  /** The file's mtime in ms — absent for Markdown, whose reader re-renders on content alone. */
  modifiedAt?: number
}

export function localFileQuery(path: string) {
  const markdown = isLocalMarkdownFile(path)
  return {
    queryKey: localFileQueryKey(path),
    queryFn: async (): Promise<LocalFileRead> => {
      if (markdown) return { ...(await fileRpc(path).localMarkdown({ path })), binary: false }
      const read = await fileRpc(path).localFile({ path })
      return { path: read.path, markdown: read.text, truncated: read.truncated, binary: read.binary, modifiedAt: read.modifiedAt }
    },
    // Long enough that a hover followed by a click is ONE read. Freshness while the file is OPEN is
    // the live watch's job (useLiveLocalFile: the server pushes `file-changed`, the key above is
    // invalidated, and the reader re-reads), so this only decides whether a re-open re-reads.
    staleTime: 5_000,
  }
}

// The reader's poll cadence when the /ws push is not live (a pre-/ws server, or the SSE fallback):
// the same "read it again" on a clock instead of on a change, and never while the push is up.
export const LOCAL_FILE_POLL_MS = 2_000

// The highlighted markup and the hover prewarm are lib/localFileHighlight.ts: they need the highlighter,
// and this module is read by the socket and the link interceptor on every page, which do not.
