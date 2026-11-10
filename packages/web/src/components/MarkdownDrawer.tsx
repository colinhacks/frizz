import { useMemo, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"
import { showToast } from "../store.ts"
import { fileRpc, localFileUrl } from "../lib/consoleProjects.ts"
import { useLiveLocalFile } from "../hooks.ts"
import { settleLocalOpen } from "../lib/local-file-links.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { LOCAL_FILE_POLL_MS, localFileQuery } from "../lib/localFileQuery.ts"
import { highlightedSource } from "../lib/localFileHighlight.ts"
import { useLocalFileCodeLinks } from "../lib/localFileCode.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { splitFrontmatter } from "../lib/frontmatter.ts"
import { browserShowsPdf, isLocalMarkdownFile, isLocalPdfFile, localFileDir } from "../lib/markdownTargets.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { CodeBody } from "./CodeBody.tsx"
import { useMermaidIslands } from "./CodexRichOutput.tsx"
import { useLightboxIslands } from "./Lightbox.tsx"
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
//
// NO BORDER AND NO RESTING FILL, like the sheet's X at the other corner: a hover fills it with the X's
// own `bg-panel-2`, and that is the whole of its chrome (maintainer 2026-10-29, of this reader: "it should
// not have a border ever. No borders ever, just a background color change"). It wore a bordered pill
// until then, beside an X that never had one. `-mr-2.5` hands its padding back to the footer, so the
// word's ink ends on the body text's right edge rather than 10px inside it.
export function OpenAction({ path }: { path: string }) {
  return (
    <button
      type="button"
      onClick={() => void openOutsideFrizz(path)}
      onMouseDown={(e) => e.preventDefault()}
      className="-mr-2.5 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium text-fg/80 outline-none transition-colors hover:bg-hover-strong hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
      title={`Open ${path} outside Frizz`}
      aria-label="Open"
    >
      <ExternalLink size={12} aria-hidden="true" /> Open
    </button>
  )
}

/**
 * The Open button's click. By PATH (`fileRpc`), like every other file call: a reader drawer has no
 * ProjectScope, and on the Console a plain `rpc.openLocalFile` is refused for naming no project.
 */
export function openOutsideFrizz(path: string): Promise<void> {
  return fileRpc(path)
    .openLocalFile({ path })
    .then(settleLocalOpen)
    .catch((error) => showToast(`Could not open local file: ${(error as Error).message.slice(0, 100)}`))
}

// A PDF, in the browser's own viewer: the reader's one binary document (lib/local-file-links.ts says
// which kinds open where). The bytes come through the gated `/local-file` route, which serves a PDF
// inline and nothing else that way. `revision` is the file's mtime, so a worker re-rendering the PDF
// while it is open reloads the frame, and the reader's two-second poll — which re-reads only the file's
// head — reloads nothing on its own. Exported for the /full split viewer, the same reader in a
// different frame.
export function PdfView({ path, revision, title }: { path: string; revision: number | undefined; title: string }) {
  return (
    <iframe
      data-pdf-view
      src={`${localFileUrl(path)}${revision === undefined ? "" : `&v=${revision}`}`}
      title={title}
      className="block min-h-0 w-full flex-1 border-0"
    />
  )
}

// A file that is not text, reaching a reader anyway: a click routes binary files to the system opener
// before any reader opens (lib/local-file-links.ts), so this is a file that STOPPED being text while it
// was open, or a reader restored onto one. Never the read's error — there is nothing wrong with the file.
export function BinaryFileNotice({ phone = false }: { phone?: boolean }) {
  return (
    <div className="text-[13px] text-muted">
      This file isn’t text, so Frizz can’t show it.{phone ? "" : " Open sends it to its default app."}
    </div>
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
  // (A non-markdown file — the phone's source view, below — skips the markdown pipeline entirely.)
  const markdown = isLocalMarkdownFile(path)
  // A PDF in a browser with no viewer to lend falls to the binary notice below, as the file it then is.
  const pdf = isLocalPdfFile(path) && browserShowsPdf()
  const { front, body: source } = splitFrontmatter(markdown ? body.data?.markdown ?? "" : "")
  const baseDir = localFileDir(resolved)
  const html = useMarkdownHtml(source, { baseDir, asDocument: true })
  const inner = useInnerHtml(html)
  const ref = useRef<HTMLDivElement>(null)
  useLocalFileCodeLinks(ref, html)
  // A report's ```lightbox fence is a gallery here too, its relative paths resolved against the
  // document's own directory like its links.
  const galleries = useLightboxIslands(ref, html, baseDir)
  // And its ```mermaid fence a diagram.
  const diagrams = useMermaidIslands(ref, html)
  // ON A PHONE this drawer is the reader for every TEXT file (lib/local-file-links: the desktop opener
  // would launch it on the machine Frizz runs on). A file that is not markdown has no rendered form, so
  // it shows as highlighted source — the /full split viewer's source view, same read, same highlighter.
  // The desktop opens only Markdown and PDFs here, so the source view never reaches it.
  const phone = useIsMobile()
  const raw = body.data?.markdown ?? ""
  const sourceHtml = useInnerHtml(useMemo(() => (markdown ? "" : highlightedSource(resolved, raw)), [markdown, raw, resolved]))

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          {/* No leading icon, like every other SUBTITLED sheet here (plan, frizz-doc). SheetHeader centers
              an icon on the whole title+subtitle block, so beside a two-line header a 14px glyph measured
              7.00px below the title's cap band and read as floating between the lines. The basename is the
              title and the path is the subtitle; neither needs a glyph to say "file". */}
          <SheetHeader title={title} subtitle={resolved} onClose={close} />
          {/* A PDF's frame fills the body edge to edge; its viewer scrolls and pads itself. */}
          <div className={`flex-1 min-h-0 ${pdf && body.data ? "flex flex-col" : "overflow-y-auto px-5 py-4"}`}>
            {pdf && body.data ? (
              <PdfView path={resolved} revision={body.data.modifiedAt} title={title} />
            ) : body.isLoading ? (
              <div className="text-[13px] text-muted">Loading…</div>
            ) : body.error ? (
              // The gate's own words — "outside Frizz's trusted roots", "was not found" — say more than
              // a generic failure would, and (on the desktop) the footer still offers the desktop opener.
              <div className="text-[13px] text-danger-90">Couldn’t read this file: {(body.error as Error).message}</div>
            ) : body.data?.binary ? (
              <BinaryFileNotice phone={phone} />
            ) : !markdown ? (
              raw ? (
                <pre
                  data-file-source
                  className="hljs whitespace-pre-wrap break-words bg-transparent font-mono-keep text-[12px] leading-5 text-fg/90"
                  style={{ tabSize: 2 }}
                  dangerouslySetInnerHTML={sourceHtml}
                />
              ) : (
                <div className="text-[13px] text-muted">This file is empty.</div>
              )
            ) : html ? (
              <>
                {front && <Frontmatter source={front} />}
                <div ref={ref} className="md-body" dangerouslySetInnerHTML={inner} />
                {galleries}
                {diagrams}
                {body.data?.truncated && (
                  <p className="mt-4 border-t border-border/60 pt-3 text-[12px] text-muted">
                    This file is too long to render in full — everything above the cut is shown.{phone ? "" : " Open it to read the rest."}
                  </p>
                )}
              </>
            ) : (
              <div className="text-[13px] text-muted">This file is empty.</div>
            )}
            {!markdown && !body.isLoading && !body.error && body.data?.truncated && (
              <p className="mt-4 border-t border-border/60 pt-3 text-[12px] text-muted">
                This file is too long to show in full — everything above the cut is shown.
              </p>
            )}
          </div>
          {/* The desktop-opener footer is not offered on the phone: its Open launches the file on the
              machine Frizz runs on, not on the phone in the reader's hand. The safe-area pad it carried
              moves to the page so the last line still clears the home indicator. */}
          {phone ? (
            <div aria-hidden className="shrink-0" style={{ height: "env(safe-area-inset-bottom)" }} />
          ) : (
            <div
              className="shrink-0 flex items-center justify-end gap-1.5 border-t border-border/60 bg-panel px-5 pt-3"
              style={FOOTER_STYLE}
            >
              <OpenAction path={resolved} />
            </div>
          )}
        </>
      )}
    </Sheet>
  )
}
