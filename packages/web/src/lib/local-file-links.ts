import type { QueryClient } from "@tanstack/react-query"
import { fileRpc, localFileUrl } from "./consoleProjects.ts"
import { openLightbox, pushMarkdownDrawer, showToast, store } from "../store.ts"
import { copyTextToClipboard } from "./clipboard.ts"
import { lightboxImageFor } from "./lightbox.ts"
import { localFileQuery } from "./localFileQuery.ts"
import { browserShowsPdf, isLightboxPath, isLocalHtmlFile, isLocalMarkdownFile, isLocalPdfFile, localImageUrl } from "./markdownTargets.ts"
import { basename } from "./paths.ts"
import { isMobileViewport } from "./mobile.ts"

// One delegated listener covers every sanitized markdown surface (chat, the doc drawer, and
// drawers). It never follows file:// or an accidental same-origin pathname: only explicit data
// attributes emitted by markdown.ts reach the server's canonical-path allowlist gate.
export function installLocalFileLinkInterceptor(client?: QueryClient): () => void {
  readCache = client ?? null
  const handler = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return
    const source = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-local-path]") : null
    const path = source?.dataset.localPath
    if (!source || !path) return
    event.preventDefault()
    event.stopPropagation()
    if (source.dataset.localImage === "true") openPicture(source, path)
    else openLocalPath(path)
  }
  document.addEventListener("click", handler)
  const failed = imageFailureHandler()
  // `error` does NOT bubble, so the delegated listener has to run in the CAPTURE phase.
  document.addEventListener("error", failed, true)
  return () => {
    document.removeEventListener("click", handler)
    document.removeEventListener("error", failed, true)
  }
}

// A markdown screenshot whose file is gone — a /tmp shot that was cleaned up, a removed worktree,
// a path from another machine. `/local-image` 404s, and Chrome then paints its own broken-image glyph
// beside the alt text, which reads as a rendering fault in Frizz rather than as a missing file. Swap the
// dead <img> for the plain path, exactly as BlockImage's onError fallback does for the React-rendered
// case — nothing is silently swallowed, and the replacement holds one stable line instead of the
// zero-height-then-glyph box that made the whole message reflow.
//
// One delegated listener for the same reason the click handler is delegated: prose is injected as raw
// sanitized HTML on several surfaces (chat, question cards, fence cards, doc and plan drawers),
// so there is no React element to hang an onError on.
//
// SCOPED TO THOSE SURFACES ON PURPOSE. `data-local-image` is also carried by BlockImage's <img>, which
// React owns and which already has its own onError fallback; swapping that node out from under React
// would corrupt the tree it thinks it is reconciling. `.md-body`/`.md-inline` are set only by our own
// components around sanitized markdown, so they mark exactly the images React does NOT manage.
function imageFailureHandler(): (event: Event) => void {
  return (event) => {
    const img = event.target
    if (!(img instanceof HTMLImageElement) || img.dataset.localImage !== "true") return
    if (!img.closest(".md-body, .md-inline")) return
    const path = img.dataset.localPath ?? img.getAttribute("src") ?? ""
    const missing = document.createElement("span")
    missing.className = "md-image-missing font-mono-keep"
    missing.textContent = path
    // The author's alt text is the only description of what the picture showed; keep it reachable.
    if (img.alt && img.alt !== path) missing.title = img.alt
    // Take the FRAME with it when there is one (markdown.ts frames block images). Replacing only the
    // `<img>` would leave a bordered, matted box standing around a line of muted path text — a frame
    // advertising a picture that isn't there. BlockImage drops its frame on the same failure.
    ;(img.closest(".md-image-frame") ?? img).replaceWith(missing)
  }
}

// A picture opens in Frizz's own viewer (components/Lightbox.tsx) — a screenshot a worker drew as a
// bare path line (BlockImage) or as Markdown, on any surface — with every other picture of the same
// message beside it, so a turn's screenshots page like a ```lightbox gallery's. The message is the
// transcript's `data-frizz-msg` root; a card or a reader, which hold one message, is its `.md-body`. A
// LINK to a picture names one picture, so it opens alone.
function openPicture(source: HTMLElement, path: string): void {
  if (!(source instanceof HTMLImageElement)) {
    openLightbox([lightboxImageFor(path, source.textContent)], 0)
    return
  }
  const scope = source.closest("[data-frizz-msg]") ?? source.closest(".md-body, .md-inline")
  const pictures = scope ? [...scope.querySelectorAll<HTMLImageElement>('img[data-local-image="true"][data-local-path]')] : [source]
  openLightbox(pictures.map((img) => lightboxImageFor(img.dataset.localPath!, img.alt)), Math.max(pictures.indexOf(source), 0))
}

// Act on a vetted local path. THE RULE (maintainer 2026-10-13, after a PDF opened the /full viewer onto
// "Couldn't read this file: Local file is not a text file"): "Anything that's clickable and handled by
// Frizz needs to be openable in Frizz. Otherwise, we should just fall through to the system click." So a
// click never opens a reader that cannot show what it was handed. By kind:
//
//   · Markdown → the reader, rendered (a drawer; the split panel on /full).
//   · a picture or a video → the lightbox, which shows and plays exactly what `/local-image` serves.
//   · a PDF → the reader, in the browser's own PDF viewer; on a phone, the phone's own (a new tab). A
//     desktop browser that would download PDFs rather than show them has no viewer to lend, so there
//     a PDF goes to the desktop opener like any other binary file.
//   · an HTML page → the desktop opener, at EVERY width: the browser is the only thing that shows a
//     page as its author meant (maintainer 2026-11-02, of a worker's options page that a wide /full
//     window drew as source: "it opens in my browser instead of in Frizz"). On a phone the desktop
//     opener is the wrong machine and the server will not serve a page to render, so there it opens
//     as source, the same as any other text file.
//   · anything else → wherever the board sends code on this surface. On the desktop board that is the
//     desktop opener, as it always was. Where the surface is the reader's SOURCE view — the /full split
//     panel, a phone — the server's read decides first: text opens the reader, and a binary file falls
//     through to the desktop opener, or on a phone downloads, which is the phone's own "open".
//
// The decision lives HERE, in the one place every local-path activation passes through, rather than in
// each producer — markdown links, resolved inline-code paths, attachment chips, the Codex file rows,
// the tool-header path links and the /full rail all get the same routing from this single function.
// `image` is the lightbox's own way OUT, its "Open in default viewer": the file goes to the desktop's
// image viewer rather than back into the lightbox.
//
// Components that own their own click (PathLink, whose row swallows the event before it can reach the
// delegated listener below) call this directly; everything that only tags itself `data-local-path`
// arrives through the interceptor.
export function openLocalPath(path: string, image = false): void {
  if (image) {
    // ON A PHONE the desktop opener is the wrong machine (it launches on the computer Frizz runs on), so
    // the browser — the phone's own viewer — opens the picture through the route that already serves it.
    if (isMobileViewport()) window.open(localImageUrl(path), "_blank", "noopener")
    else void open(path, true)
    return
  }
  if (isLocalMarkdownFile(path)) return pushMarkdownDrawer(path)
  if (isLightboxPath(path)) return openLightbox([lightboxImageFor(path, null)], 0)
  if (isLocalPdfFile(path)) {
    // Synchronously, inside the tap: a phone's browser blocks a window opened after an await.
    if (isMobileViewport()) window.open(localFileUrl(path), "_blank", "noopener")
    else if (browserShowsPdf()) pushMarkdownDrawer(path)
    else void open(path, false)
    return
  }
  if ((isLocalHtmlFile(path) || !store.splitFileViewer) && !isMobileViewport()) {
    void open(path, false)
    return
  }
  void openAsSource(path)
}

// The query client the readers share, set at install, so this read IS the reader's: a text file opens
// onto a warm cache (and a rail row's hover prewarm makes the read itself free). A page that installs
// no client — a fixture — reads once without caching, and the reader reads again on mount.
let readCache: QueryClient | null = null

async function openAsSource(path: string): Promise<void> {
  let binary = false
  try {
    const read = localFileQuery(path)
    binary = (readCache ? await readCache.fetchQuery(read) : await read.queryFn()).binary
  } catch {
    // Gone, or outside the gate: the reader says so in the gate's own words, as it always has.
  }
  if (!binary) return pushMarkdownDrawer(path)
  if (isMobileViewport()) download(path)
  else void open(path, false)
}

// A same-origin `download` anchor rather than a navigation: an attachment that 404s must not take the
// page with it. It carries no `data-local-path`, so the interceptor above lets its click through.
function download(path: string): void {
  const anchor = document.createElement("a")
  anchor.href = localFileUrl(path)
  anchor.download = basename(path)
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

async function open(path: string, image: boolean) {
  try {
    await settleLocalOpen(await fileRpc(path).openLocalFile({ path, ...(image ? { image: true } : {}) }))
  } catch (error) {
    showToast(`Could not open local file: ${(error as Error).message.slice(0, 100)}`)
  }
}

/**
 * What the page owes the reader after the server answered an open: the path on the clipboard when
 * the preference is Copy, and a word when the server showed a file it would not open. A file that runs
 * when opened is revealed instead (server `runsWhenOpened`), and a file manager window with no
 * explanation reads as the click having gone wrong.
 */
export async function settleLocalOpen(result: { action: "opened" | "copy"; path: string; revealed?: boolean }): Promise<void> {
  if (result.action === "copy") {
    await copyTextToClipboard(result.path)
    showToast("Copied local path")
  } else if (result.revealed) {
    showToast("Showing this file in its folder. Opening it would run it.")
  }
}
