import { useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"
import { showToast } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useLiveLocalFile } from "../hooks.ts"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { LOCAL_FILE_POLL_MS, localFileQuery } from "../lib/localFileQuery.ts"
import { useLocalFileCodeLinks } from "../lib/localFileCode.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { splitFrontmatter } from "../lib/frontmatter.ts"
import { localFileDir } from "../lib/markdownTargets.ts"
import { CodeBody } from "./CodeBody.tsx"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// The BUILT-IN MARKDOWN READER: a right side sheet (the same slide/backdrop family as the plan and
// frizz-document drawers) rendering a `.md` file that lives on disk. Every link to one lands here
// instead of launching the desktop opener — a worker citing `AGENTS.md`, a backticked path that
// resolved to a doc, an attached `.md` — because throwing the user out of Frizz into an editor to read
// two paragraphs is the wrong answer to "what does that file say?".
//
// The file's own directory is passed as the render base, so its RELATIVE links (`./ARCHITECTURE.md`,
// `docs/x.md`, an image beside it) resolve to real paths — a doc that cross-references its neighbours
// is browsable, each link stacking another reader over this one. Content is a file on disk written by
// whoever wrote it, so it goes through the same allowlist sanitizer as every other prose surface.

export const FOOTER_STYLE = { paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }

// The desktop-opener escape hatch. Reading is the default now, but a file you want to EDIT still
// belongs in the editor, and this is the only affordance left that gets it there. It honours the
// `localFileOpener` setting, exactly as a click on the link used to. Exported because the /full
// page's split FileViewerPanel is the same reader in a different frame and must not fork this.
export function OpenAction({ path }: { path: string }) {
  const open = () => {
    rpc
      .openLocalFile({ path })
      .then(async (result) => {
        if (result.action !== "copy") return
        await copyTextToClipboard(result.path)
        showToast("Copied local path")
      })
      .catch((error) => showToast(`Could not open local file: ${(error as Error).message.slice(0, 100)}`))
  }
  return (
    <button
      type="button"
      onClick={open}
      onMouseDown={(e) => e.preventDefault()}
      className="flex items-center gap-1.5 rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-fg/80 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
      title={`Open ${path} outside Frizz`}
      aria-label="Open"
    >
      <ExternalLink size={12} aria-hidden="true" /> Open
    </button>
  )
}

// The document's frontmatter is YAML, so render it through the same grammar and token palette as a
// `.yaml` source file. CodeBody keeps the text byte-for-byte while the pre preserves nesting/indentation;
// the former hand-rolled "text before the first colon is a key" treatment flattened both.
export function Frontmatter({ source }: { source: string }) {
  return (
    <CodeBody
      text={source}
      language="yaml"
      className="mb-4 whitespace-pre-wrap break-words rounded-md border border-border/60 bg-panel-2/40 px-3 py-2 font-mono-keep text-[12px] leading-5 text-muted"
    />
  )
}

export function MarkdownDrawer({ id, path, title, depth, widthDepth }: { id: number; path: string; title: string; depth: number; widthDepth: number }) {
  // The same read (and key) as the /full split viewer, and LIVE the same way: the server watches the
  // file while this drawer is open and the socket invalidates the query on each save; the poll covers
  // a socket that is not up (useLiveLocalFile).
  const live = useLiveLocalFile(path)
  const body = useQuery({ ...localFileQuery(path), refetchInterval: live ? false : LOCAL_FILE_POLL_MS })
  // Base the relative links on the CANONICAL path the server resolved, not the one that was clicked:
  // a link through a symlinked directory would otherwise rebase its neighbours onto a directory the
  // gate never admitted, and every one of them would 404.
  const resolved = body.data?.path ?? path
  // Frontmatter is shown as metadata, not rendered as prose — see lib/frontmatter.ts for the heading
  // it became otherwise. It opens every MDX blog post and every skill file, so this is the common case.
  const { front, body: source } = splitFrontmatter(body.data?.markdown ?? "")
  const html = useMarkdownHtml(source, { baseDir: localFileDir(resolved), asDocument: true })
  const inner = useInnerHtml(html)
  const ref = useRef<HTMLDivElement>(null)
  useLocalFileCodeLinks(ref, html)

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          {/* No leading icon, like every other SUBTITLED sheet here (plan, frizz-doc). SheetHeader centers
              an icon on the whole title+subtitle block, so beside a two-line header a 14px glyph measured
              7.00px below the title's cap band and read as floating between the lines. The basename is the
              title and the path is the subtitle; neither needs a glyph to say "file". */}
          <SheetHeader title={title} subtitle={resolved} onClose={close} />
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
            {body.isLoading ? (
              <div className="text-[13px] text-muted">Loading…</div>
            ) : body.error ? (
              // The gate's own words — "outside Frizz's trusted roots", "was not found" — say more than
              // a generic failure would, and the footer still offers the desktop opener.
              <div className="text-[13px] text-red-400/90">Couldn’t read this file: {(body.error as Error).message}</div>
            ) : html ? (
              <>
                {front && <Frontmatter source={front} />}
                <div ref={ref} className="md-body" dangerouslySetInnerHTML={inner} />
                {body.data?.truncated && (
                  <p className="mt-4 border-t border-border/60 pt-3 text-[12px] text-muted">
                    This file is too long to render in full — everything above the cut is shown. Open it to read the rest.
                  </p>
                )}
              </>
            ) : (
              <div className="text-[13px] text-muted">This file is empty.</div>
            )}
          </div>
          <div
            className="shrink-0 flex items-center justify-end gap-1.5 border-t border-border/60 bg-panel px-5 pt-3"
            style={FOOTER_STYLE}
          >
            <OpenAction path={resolved} />
          </div>
        </>
      )}
    </Sheet>
  )
}
