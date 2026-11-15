import type { DragEvent as ReactDragEvent } from "react"
import { localFileUrl } from "./consoleProjects.ts"
import { isLightboxPath, localImageUrl } from "./markdownTargets.ts"
import { basename } from "./paths.ts"

// DRAGGING A FILE OUT OF FRIZZ (maintainer 2026-11-15: "it would be nice to be able to drag any file
// handle into other applications on my computer. e.g. into notes or emails. anywhere we link a file
// path or register a chip for it").
//
// A web page cannot hand the OS a real file: Chromium strips a `file://` URL out of any drag a page
// starts (RenderWidgetHostImpl filters drop data to what the renderer may request), and there is no
// API for a page to put a file on the drag pasteboard. What Chrome DOES offer is `DownloadURL` —
// `<mime>:<name>:<url>` — the type Gmail's attachments ride out on. Chrome turns it into a FILE PROMISE
// on the drag pasteboard (`content/app_shim_remote_cocoa/web_drag_source_mac.mm`), and when an app
// accepts the promise Chrome downloads the URL straight into the drop location. That download is
// issued from the page's own frame with the page as its initiator (`drag_download_file.cc`
// `set_initiator(host->GetLastCommittedOrigin())`), so it carries `Sec-Fetch-Site: same-origin` and
// passes the server's origin gate exactly as the page's own `/local-file` reads do. Safari and Firefox
// ignore the type; they still get the path as text.
//
// The path rides along as `text/plain`, for everything that takes text rather than files: a terminal, an
// editor, a chat box — and Frizz's own prompt box, where dropping a chip writes its path.
//
// Every producer of a file handle goes through `writeLocalFileDrag`: the delegated listener below for
// the markup that only carries `data-local-path` (sanitized Markdown, inline-code paths, attachment
// chips), and `localFileDragProps` for the React rows that own their own click (PathLink, the saved-link
// rows, the /full rail, the prompt box's attachment tiles).

// The MIME type names the promised file to the receiving app (Chrome maps it to a UTType). Unknown
// extensions are `application/octet-stream`, deliberately: given a type with a preferred extension,
// Chrome appends that extension to a name that lacks it (`net::GenerateFileName`), so `Makefile` sent
// as text/plain would land as `Makefile.txt`.
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  md: "text/markdown",
  mdx: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  zip: "application/zip",
}

/** The file part of a path a link may have written with an editor cursor (`README.md:12:3`). */
function filePart(path: string): string {
  return path.trim().replace(/:\d+(?::\d+)?$/, "")
}

export interface LocalFileDragPayload {
  /** `text/plain`: the path as written. */
  text: string
  /** Chrome's `DownloadURL`, or null where no file can be promised (a directory). */
  downloadUrl: string | null
}

export function localFileDragPayload(path: string, origin: string = window.location.href): LocalFileDragPayload {
  const file = filePart(path)
  // A trailing separator names a directory, which no route serves: a promise for it would drop an empty
  // file. The path still goes out as text.
  if (!file || /[\\/]$/.test(file)) return { text: path, downloadUrl: null }
  const name = basename(file)
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : ""
  const mime = MIME_BY_EXTENSION[extension] ?? "application/octet-stream"
  // A picture or a video comes from the route that already draws it, which serves any real image the
  // page can show. Everything else comes from `/local-file`, behind the readers' openable roots.
  const url = new URL(isLightboxPath(file) ? localImageUrl(file) : localFileUrl(file), origin).href
  // The three fields are split on the first two colons, so a colon in the name would cut it short. A Mac
  // shows a `:` in a file name as `/` anyway; the promised file takes the safe spelling.
  return { text: path, downloadUrl: `${mime}:${name.replace(/:/g, "_")}:${url}` }
}

/** Put a local file on a drag that is starting, replacing whatever the browser put there by default. */
export function writeLocalFileDrag(dataTransfer: DataTransfer, path: string): void {
  const payload = localFileDragPayload(path)
  // A link's default drag is its href — for a file link, a localhost URL that means nothing in Mail.
  dataTransfer.clearData()
  dataTransfer.setData("text/plain", payload.text)
  if (payload.downloadUrl) dataTransfer.setData("DownloadURL", payload.downloadUrl)
  dataTransfer.effectAllowed = "copy"
}

/** Spread onto a React element that stands for a local file and handles its own click. */
export function localFileDragProps(path: string): { draggable: true; onDragStart: (event: ReactDragEvent<HTMLElement>) => void } {
  return {
    draggable: true,
    onDragStart: (event) => {
      writeLocalFileDrag(event.dataTransfer, path)
      // Claimed: neither an enclosing row nor the delegated listener below rewrites it.
      event.stopPropagation()
    },
  }
}

/**
 * The delegated half: any element carrying `data-local-path` drags out as its file. `<a>` and `<img>`
 * drag natively; the buttons and inline code that carry a path are made `draggable` where they are
 * minted (markdown.ts, localFileCode.ts, BlockFile). Installed by installLocalFileLinkInterceptor, next
 * to the click half, so every page that routes local-file clicks also lets them drag.
 */
export function installLocalFileDragOut(): () => void {
  const handler = (event: DragEvent) => {
    if (!event.dataTransfer) return
    const source = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-local-path]") : null
    const path = source?.dataset.localPath
    if (!path) return
    writeLocalFileDrag(event.dataTransfer, path)
  }
  document.addEventListener("dragstart", handler)
  return () => document.removeEventListener("dragstart", handler)
}
