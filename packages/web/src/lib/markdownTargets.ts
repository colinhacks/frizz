import { FRIZZ_ROUTE_PREFIX } from "@frizz/shared"
import { apiBase, innerPath, projectSlug, APP_ROUTE_SEGMENTS } from "./base-path.ts"
import { dirnameLike, isRooted, joinLike } from "./paths.ts"
// Markdown is often written by tools that report local artifacts as links. A browser interprets a
// POSIX absolute path as a same-origin URL path, which both navigates away from Frizz and produces a
// deceptive localhost URL. Identify those targets before DOM sanitization so they can never become
// navigable anchors. This module deliberately does not decide filesystem authorization: the server's
// origin-gated `/local-image` route serves any absolute path that realpath-resolves to a regular image
// file (packages/server/src/local-image.ts, deliberately path-unconfined).

export interface LocalMarkdownTarget {
  // Metadata for a local-looking destination. The renderer keeps this out of normal prose unless
  // it needs to expose it as an accessible title for a disabled local link.
  display: string
  // Present only for an absolute path the server can act on — its gated image endpoint, its Markdown
  // reader, or the desktop opener. POSIX (`/a/b`) and Windows (`C:\a\b`) alike; see localMarkdownTarget.
  filePath?: string
}

// Keep one-letter URL schemes such as x://host/p out of the drive-path branch.
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/](?![\\/])/

// Editor deep-link schemes that all share VS Code's URL grammar: `<scheme>://file/<path>[:line[:col]]`.
// Agents under user-level "link every file" instructions write these (`[plan.md](cursor://file/<abs>)`)
// because in a terminal that is the only clickable form. Left as an anchor, the OS resolves the scheme
// and the named editor opens no matter what the "Local file links" setting says — and a `.md` file
// never reaches Frizz's own reader. Classify the path the link names instead, so it routes exactly
// like a plain path link. The path may carry its own leading slash (`cursor://file//Users/…`) or lean
// on the route's (`cursor://file/Users/…`); both forms occur in the wild and both editors accept both.
const EDITOR_FILE_URL = /^(?:cursor|vscode|vscode-insiders|windsurf):\/\/file\/(.*)$/i

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // An invalid escape is still a local-looking value, but must never make sanitization throw.
    return value
  }
}

// The SPA's intentionally supported root-relative routes. All other single-slash absolute targets
// are treated as filesystem paths; ordinary relative links (`docs/foo`), fragments, mailto, and
// http(s) never reach this classifier.
function isFrizzRoute(href: string): boolean {
  if (href === "/" || href.startsWith("/?") || href.startsWith("/#")) return true
  // Strip this page's project prefix first. Under `/project/nub/thread/x` the in-app link IS
  // `/project/nub/thread/x`, and without this it reads as a filesystem path and renders as a
  // disabled local-file chip.
  const bare = href.replace(/[?#].*$/u, "")
  // A link straight to another project's board — `/project/nub` — is in-app even though it has no
  // route segment of its own once the prefix is stripped.
  if (projectSlug(bare)) return true
  const inner = innerPath(bare)
  const first = inner.split("/")[1] ?? ""
  return APP_ROUTE_SEGMENTS.has(first)
}

/**
 * Classify an anchor/image destination that denotes a filesystem path. A `file:` value with a REMOTE
 * host is retained as local text but deliberately has no `filePath`: a UNC share is not a file this
 * machine's server can resolve. Protocol-relative URLs (`//cdn.example/...`) remain web URLs.
 *
 * Both POSIX and Windows paths carry an actionable filePath. The server decides whether it can
 * resolve the path; dropping Windows paths here creates inert buttons and removes inline images.
 * Leave /C:/... intact: it may be a POSIX path, and only a Windows server may shed that first slash.
 */
export function localMarkdownTarget(raw: string | null | undefined): LocalMarkdownTarget | null {
  const href = raw?.trim()
  if (!href) return null
  // marked HTML-escapes backslashes in a Windows Markdown destination (`C:%5CUsers…`), so classify
  // the decoded value before checking its drive-prefix form.
  const decodedHref = decodePath(href)

  if (WINDOWS_ABSOLUTE_PATH.test(decodedHref)) return { display: decodedHref, filePath: decodedHref }

  if (decodedHref.startsWith("/") && !decodedHref.startsWith("//") && !isFrizzRoute(decodedHref)) {
    // A `#section` or `?query` tail names a place in the file, not part of its path — strip it before
    // decoding, as the editor-URL and relative branches do. Kept, it made `/repo/AGENTS.md#setup` fail
    // the Markdown test and go to the desktop opener instead of the reader, which on a phone meant a
    // tap that opened the file on the server machine and showed nothing where the tap was.
    const path = decodePath(href.replace(/[?#].*$/u, ""))
    return { display: path, filePath: path }
  }

  const editor = EDITOR_FILE_URL.exec(href)
  if (editor) {
    // Strip a query/fragment tail (`?windowId=_blank`) before decoding, as resolveRelativeLocalPath
    // does — a filesystem path has neither. The editor cursor suffix (`:12:3`) stays: the reader and
    // the server's opener both strip it themselves, the same as for a bare `README.md:12` path.
    const rest = decodePath(editor[1].replace(/[?#].*$/u, "")).replace(/^\/+/, "")
    if (!rest) return null
    if (WINDOWS_ABSOLUTE_PATH.test(rest)) return { display: rest, filePath: rest }
    const path = `/${rest}`
    return { display: path, filePath: path }
  }

  if (!/^file:/i.test(href)) return null
  try {
    const url = new URL(href)
    if (url.protocol !== "file:") return null
    // A UNC/remote file URL is not a local file the server can safely proxy. It remains a
    // non-navigating chip, while an empty or localhost authority can use the existing gated route.
    if (url.hostname && url.hostname !== "localhost") return { display: href }
    const path = decodePath(url.pathname)
    return { display: path, filePath: path }
  } catch {
    return { display: href }
  }
}

export function localImageUrl(path: string): string {
  return `${apiBase()}/local-image?path=${encodeURIComponent(path)}`
}

// Must match the server's image-content-type allowlist. The server still decides whether a path is
// actually eligible by resolving it to a regular image behind the HTTP origin gate.
const PROXIED_IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)$/i

export function localImageUrlForTarget(target: LocalMarkdownTarget): string | null {
  return target.filePath && PROXIED_IMAGE_PATH.test(target.filePath)
    ? localImageUrl(target.filePath)
    : null
}

// The VIDEOS the same route serves (server/local-image.ts, which must match). Only a ```lightbox gallery
// draws one (lib/lightbox.ts): a Markdown `![](demo.mp4)` keeps its link, because an `<img>` cannot play
// a video and the sanitizer mints no `<video>`.
const PROXIED_VIDEO_PATH = /\.(?:mp4|m4v|webm|mov)$/i

export function isProxiedVideoPath(path: string): boolean {
  return PROXIED_VIDEO_PATH.test(path)
}

// Must match the server's `MARKDOWN_FILE_EXT`. A local path with this extension is rendered by Frizz's
// own reader drawer instead of being handed to the desktop opener — the one local file kind the app
// knows how to show. The strip mirrors an editor cursor suffix (`README.md:12`) the way
// resolveOpenableFile does, so a line-anchored reference still reads as Markdown. `.mdx` counts: an MDX
// doc is Markdown prose first (its imports and JSX render as inert text), and until 2026-08-25 it was
// the one Markdown flavour that slipped past the reader to the OS opener — which on a Mac whose
// Markdown handler is Cursor meant a blog post in `content/blog/*.mdx` opened an editor, whatever
// the "Local file links" setting said.
const MARKDOWN_FILE_PATH = /\.(?:md|mdx|markdown)$/i

export function isLocalMarkdownFile(path: string): boolean {
  return MARKDOWN_FILE_PATH.test(path.trim().replace(/:\d+(?::\d+)?$/, ""))
}

// Must match the server's `PDF_FILE_EXT`. The one BINARY document the reader shows itself, in the
// browser's own PDF viewer — see lib/local-file-links.ts for where every other kind goes.
const PDF_FILE_PATH = /\.pdf$/i

export function isLocalPdfFile(path: string): boolean {
  return PDF_FILE_PATH.test(path.trim())
}

// Must match the server's `HTML_FILE_EXT`. A page — the self-contained mockup, options page or report
// a worker links for the human to open — whose only faithful view is the browser: Frizz never renders
// one itself (`/local-file` serves it as a sandboxed download), so its source is the wrong thing to show.
const HTML_FILE_PATH = /\.html?$/i

export function isLocalHtmlFile(path: string): boolean {
  return HTML_FILE_PATH.test(path.trim())
}

// The browser's own word on whether it renders a PDF inline. False where it would DOWNLOAD one instead —
// Chrome with "Download PDF files" switched on, the headless shell — and an iframe there is a blank panel
// plus a stray download, so a PDF is then not something Frizz can show. Absent only from browsers older
// than the property (Safari before 16.4), all of which render PDFs.
export function browserShowsPdf(): boolean {
  return typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false
}

/** A picture or a video the gated `/local-image` route serves, which the lightbox shows or plays. */
export function isLightboxPath(path: string): boolean {
  return PROXIED_IMAGE_PATH.test(path) || PROXIED_VIDEO_PATH.test(path)
}

// Resolve a RELATIVE Markdown destination against the directory the prose belongs to. Repo docs link
// to each other relatively on purpose (`./ARCHITECTURE.md`, `../scripts/shot.mjs`) and so does chat
// prose — a worker writing up its own scratch file names it `.frizz/threads/<id>/HANDOFF.md`, exactly
// as it typed it into the shell. With no base, none of those is a local path OR a working URL: the
// anchor stayed relative and the browser resolved it against the PAGE, so clicking a handoff link
// navigated to `/project/nub/thread/<slug>/.frizz/threads/<id>/HANDOFF.md` and out of Frizz entirely.
//
// The base is the rendering document's own directory for the file reader, and the PROJECT DIRECTORY
// for every other surface — the same root the server resolves a bare inline-code path against
// (local-file.ts `resolveOpenableFile`), so a path written in backticks and the same path written as a
// link now land on the same file. `~`/`~/` expands against `home` when the board supplied one, which
// is the other half of that parity. Returns null for anything already absolute, a fragment, a query,
// or a scheme; the query/fragment tail of a resolved path is dropped, since a filesystem path has
// neither.
//
// The base may be a Windows path — `C:\Users\…` is what the board's `projectDir` and `homeDir` and the
// reader's own file path all are when the server runs there — and until the Windows audit
// (2026-09-11, finding 12) that returned null unconditionally, so NO relative link in a rendered local
// Markdown file ever opened on Windows. joinLike keeps the base's separator and drive; the link itself
// is always written with `/`, whatever the platform (a `..` climb is bounded by the drive the same way
// it is bounded by `/`).
export function resolveRelativeLocalPath(
  raw: string | null | undefined,
  baseDir: string,
  home?: string,
): string | null {
  const href = raw?.trim()
  if (!href) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null // http(s):, file:, mailto:, cursor:, C:\…, …
  if (/^[\\/#?]/.test(href)) return null
  const relative = decodePath(href.replace(/[?#].*$/u, ""))
  if (!relative) return null
  // A home-anchored path carries its own root, so it needs no base at all — and must never be glued
  // onto one, which is what turned `~/.claude/CLAUDE.md` into `<baseDir>/~/.claude/CLAUDE.md`.
  const homeAnchored = relative === "~" || /^~[\\/]/.test(relative)
  if (homeAnchored && !(home && isRooted(home))) return null
  const root = homeAnchored ? home! : baseDir
  if (!isRooted(root)) return null
  return joinLike(root, homeAnchored ? relative.slice(2) : relative)
}

/**
 * The directory a document at `path` lives in — the base for its relative links, in the path's own
 * separator (`C:\proj\docs` for a Windows reader path). `/` for a path with no directory part, as it
 * always was: the reader only ever holds a rooted, server-canonical path, so that arm is a stand-in.
 */
export function localFileDir(path: string): string {
  return dirnameLike(path) || "/"
}
