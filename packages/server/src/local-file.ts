import { spawn, type SpawnOptions } from "node:child_process"
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import type { LocalFileOpener } from "@frizz/shared"
import { normalizeLocalPath } from "./local-path.ts"

export type LocalFileOpenResult = { action: "opened"; path: string } | { action: "copy"; path: string }

/** The slice of a ChildProcess the opener needs: the two events that settle a spawn, and unref. */
export interface SpawnedOpener {
  unref(): void
  once(event: "spawn", listener: () => void): unknown
  once(event: "error", listener: (error: Error) => void): unknown
}

export type LocalFileSpawn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedOpener

function isUnder(real: string, root: string): boolean {
  let rootReal: string
  try { rootReal = realpathSync(root) } catch { return false }
  if (process.platform !== "win32") {
    return real === rootReal || real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)
  }
  // Windows realpath can retain the caller's casing. Compare directory identities instead:
  // folding names would also admit distinct siblings in a case-sensitive NTFS directory.
  try {
    const trusted = statSync(rootReal, { bigint: true })
    if (!trusted.isDirectory() || trusted.ino === 0n) return false
    for (let ancestor = real; ;) {
      const actual = statSync(ancestor, { bigint: true })
      if (actual.dev === trusted.dev && actual.ino === trusted.ino) return true
      const parent = dirname(ancestor)
      if (parent === ancestor) return false
      ancestor = parent
    }
  } catch { return false }
}

// Canonicalize before containment so a symlink below a trusted root cannot smuggle a path outside.
// Files only; readers, watchers and openers share the caller's trusted directory roots.
// The image proxy has its own, deliberately path-unconfined resolver.
export function resolveLocalFile(rawPath: string, roots: readonly string[]): string {
  rawPath = normalizeLocalPath(rawPath)
  if (!isAbsolute(rawPath)) throw new Error("Local path must be absolute")
  let real: string
  try { real = realpathSync(rawPath) } catch { throw new Error("Local file was not found") }
  if (!roots.some((root) => isUnder(real, root))) throw new Error("Local file is outside Frizz's trusted roots")
  try {
    if (!statSync(real).isFile()) throw new Error("Local path is not a regular file")
  } catch (error) {
    if (error instanceof Error && error.message === "Local path is not a regular file") throw error
    throw new Error("Local file was not found")
  }
  return real
}

// Resolve a human-written path REFERENCE (as it might appear in inline code) to a canonical openable
// file under `roots`, or null when it doesn't resolve to a real file there. Absolute paths are taken
// as-is; a leading `~`/`~/` expands to the home dir; anything else is resolved relative to the project
// dir (so a repo-relative `packages/web/App.tsx` works). A trailing `:line[:col]` (editor cursor
// suffix) is dropped. Returns null rather than throwing so a batch resolver can score many candidates
// cheaply; the same realpath + containment + is-file gate as resolveLocalFile keeps it confined.
export function resolveOpenableFile(
  raw: string,
  projectDir: string,
  roots: readonly string[],
  home: string = homedir(),
): string | null {
  const trimmed = raw.trim().replace(/:\d+(?::\d+)?$/, "")
  if (!trimmed) return null
  const abs = trimmed === "~" ? home
    // Either separator after the tilde: a Windows worker writes `~\.claude\CLAUDE.md` (2026-09-11).
    : /^~[\/\\]/.test(trimmed) ? join(home, trimmed.slice(2))
      : isAbsolute(trimmed) ? trimmed
        : resolve(projectDir, trimmed)
  try {
    return resolveLocalFile(abs, roots)
  } catch {
    return null
  }
}

// A local Markdown file is the ONE local-file kind Frizz renders itself instead of handing to the
// desktop opener, so its bytes are the only ones this gate lets into the page. Both the requested path
// and its canonical real path must carry the extension: a normal `.md` symlink (a skill file linked out
// of `.agents/`) still reads, while a symlink whose target is some other file cannot ride a `.md` href
// into the reader. `.mdx` is Markdown here too — see the web's `MARKDOWN_FILE_PATH`, which this must
// match.
export const MARKDOWN_FILE_EXT = /\.(?:md|mdx|markdown)$/i

// Ceiling on one click's read. A rendered document is prose a person is about to read, not a data
// channel — past a megabyte the renderer is the wrong tool and the browser pays for the whole string.
// Over the cap the reader still opens, truncated at a line boundary, and says so.
export const MARKDOWN_READ_LIMIT = 1024 * 1024

export type LocalMarkdownRead = { path: string; markdown: string; truncated: boolean }

/**
 * `binary` is the reader's answer to "can Frizz show this as text?", given as DATA rather than thrown:
 * the web routes every file click on it (lib/local-file-links.ts), and a binary file goes to the
 * system opener instead of opening a reader that can only say it cannot read it (maintainer
 * 2026-10-13, of a PDF: "Anything that's clickable and handled by Frizz needs to be openable in
 * Frizz. Otherwise, we should just fall through to the system click."). A binary read carries no
 * text. `modifiedAt` is the file's mtime in ms, the revision the PDF view reloads on.
 */
export type LocalTextRead = { path: string; text: string; truncated: boolean; binary: boolean; modifiedAt: number }

// A PDF is the one BINARY document Frizz shows itself — in the browser's own PDF viewer, fed by the
// `/local-file` route (resolveServedLocalFile) — so the text reader never sends one's bytes as source,
// even a PDF whose first 8 KiB happen to hold no NUL. The web's `PDF_FILE_PATH` must match.
export const PDF_FILE_EXT = /\.pdf$/i

// An HTML page is text, but the browser is its viewer: a worker links a mockup or a report for the
// human to open, never to edit. So an editor preference hands one to the system opener, as it does a
// binary file (openLocalFile). The web's `HTML_FILE_PATH` must match.
export const HTML_FILE_EXT = /\.html?$/i

// The binary sniff: a NUL in the first 8 KiB, git's own tell. Compressed and media formats carry one
// within a few bytes; UTF-8 text never does.
const SNIFF_BYTES = 8192

// Up to `max` bytes from the start of an open file, stopping early at EOF. Bounded on purpose: the
// reader shows at most a megabyte, and the sniff needs 8 KiB, so neither reads a 2 GB recording whole.
function readHead(fd: number, max: number): Buffer {
  const buffer = Buffer.alloc(max)
  let filled = 0
  while (filled < max) {
    const read = readSync(fd, buffer, filled, max - filled, filled)
    if (read === 0) break
    filled += read
  }
  return buffer.subarray(0, filled)
}

/** True for a file Frizz cannot show as text: a PDF by name, anything else by a NUL in its head. */
export function isBinaryLocalFile(path: string): boolean {
  if (PDF_FILE_EXT.test(path)) return true
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    return readHead(fd, SNIFF_BYTES).includes(0)
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * A file's source, for the fullscreen page's file viewer (the "edited files" rail, 2026-08-28).
 *
 * The SAME openable roots as the Markdown reader, deliberately: this gate was the project directory
 * alone until 2026-09-03, on the premise that "the files it exists for are the ones a worker just
 * edited in the checkout, so nothing under `~` needs to be readable here". That premise is false —
 * a worker's checkout is very often NOT the project directory. Over two weeks of this machine's
 * transcripts, 41% of every file a worker wrote sat outside every registered project dir: git
 * worktrees at `~/.cache/<tool>/worktrees/<slug>/`, sibling clones, `/tmp` scratch, the project's own
 * `attachments` state dir. Every one of those rail rows answered a click with "Local file is outside
 * Frizz's trusted roots" — while a `.md` in the SAME directory opened fine through the reader, which
 * had home-and-below all along (maintainer 2026-09-03: "why do we have this? I see it a lot, and it's
 * annoying").
 *
 * The narrower gate also bought no security it was the last line of. In exposed mode (`--host` /
 * `--public-origin`) every request needs a board session, and anyone holding one can already dispatch a
 * worker that reads any file on the machine and prints it into a transcript — and `openLocalFile`
 * already spawns the desktop opener on anything under home. The origin check and the session are the
 * boundary; this is defense in depth behind them, and it stays exactly as wide as the reader's.
 *
 * A binary file is REPORTED, never rendered as noise and never refused: `binary: true`, no text (see
 * LocalTextRead). It was a thrown "Local file is not a text file" until 2026-10-13, which the viewer
 * printed as its whole body. Same 1 MiB line-boundary truncation as the Markdown reader, and the read
 * stops there too rather than pulling the whole file into memory first.
 */
export function readLocalTextFile(rawPath: string, roots: readonly string[]): LocalTextRead {
  const path = resolveLocalFile(rawPath, roots)
  const fd = openSync(path, "r")
  try {
    const modifiedAt = Math.trunc(fstatSync(fd).mtimeMs)
    const binary = { path, text: "", truncated: false, binary: true, modifiedAt }
    if (PDF_FILE_EXT.test(rawPath.trim()) || PDF_FILE_EXT.test(path)) return binary
    // One byte past the cap says whether the cut is needed.
    const bytes = readHead(fd, MARKDOWN_READ_LIMIT + 1)
    if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return binary
    if (bytes.length <= MARKDOWN_READ_LIMIT) return { path, text: bytes.toString("utf8"), truncated: false, binary: false, modifiedAt }
    const head = bytes.subarray(0, MARKDOWN_READ_LIMIT)
    const lastBreak = head.lastIndexOf(0x0a)
    return { path, text: head.subarray(0, lastBreak > 0 ? lastBreak : head.length).toString("utf8"), truncated: true, binary: false, modifiedAt }
  } finally {
    closeSync(fd)
  }
}

export type ServedLocalFile = { path: string; size: number; name: string; pdf: boolean }

/**
 * A local file's BYTES, for the `/local-file` route: behind the same openable roots as the readers,
 * which already hand any text file under them to the page. Two shapes, and only two:
 *
 *   · a PDF — the requested AND the canonical path both `.pdf`, as the Markdown gate pairs them — is
 *     served inline as `application/pdf`, for the reader's PDF view and a phone's own viewer;
 *   · anything else is a DOWNLOAD (`application/octet-stream`, `attachment`, sandboxed), a phone's
 *     fall-through for a file Frizz cannot show, since the desktop opener there is the wrong machine.
 *
 * Nothing is ever served as a type the page could run: an `.html` under home comes back as a download,
 * never as a document on Frizz's origin (localFileHeaders).
 */
export function resolveServedLocalFile(rawPath: string, roots: readonly string[]): ServedLocalFile {
  const path = resolveLocalFile(rawPath, roots)
  return { path, size: statSync(path).size, name: basename(path), pdf: PDF_FILE_EXT.test(rawPath.trim()) && PDF_FILE_EXT.test(path) }
}

export function localFileHeaders(file: ServedLocalFile): Record<string, string> {
  // RFC 6266 / 5987: the name percent-encoded, plus the characters encodeURIComponent leaves alone.
  const name = encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return {
    "content-type": file.pdf ? "application/pdf" : "application/octet-stream",
    "content-length": String(file.size),
    "content-disposition": `${file.pdf ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    // A CSP sandbox stops Chrome's PDF viewer from loading at all, so only the download carries one.
    ...(file.pdf ? {} : { "content-security-policy": "default-src 'none'; sandbox" }),
  }
}

export function readLocalMarkdown(rawPath: string, roots: readonly string[]): LocalMarkdownRead {
  if (!MARKDOWN_FILE_EXT.test(rawPath.trim())) throw new Error("Local file is not a Markdown file")
  const path = resolveLocalFile(rawPath, roots)
  if (!MARKDOWN_FILE_EXT.test(path)) throw new Error("Local file is not a Markdown file")
  const bytes = readFileSync(path)
  if (bytes.length <= MARKDOWN_READ_LIMIT) return { path, markdown: bytes.toString("utf8"), truncated: false }
  // Cut on the last newline inside the cap so the tail is a whole line rather than a split multi-byte
  // character or half a fenced block; fall back to the raw cap if the prefix holds no newline at all.
  const head = bytes.subarray(0, MARKDOWN_READ_LIMIT)
  const lastBreak = head.lastIndexOf(0x0a)
  return { path, markdown: head.subarray(0, lastBreak > 0 ? lastBreak : head.length).toString("utf8"), truncated: true }
}

/**
 * The path a LIVE WATCH of a file may attach to — exactly the gate its read passed, or nothing. Both
 * readers now share one set of roots, so the containment is one call; the only asymmetry left is the
 * Markdown one, where the CANONICAL path must be Markdown too. A watch reveals only "this changed",
 * but a file the reader is not allowed to read is not one it may be told about either — so a `.md`
 * href whose target is some other file arms nothing, exactly as it reads nothing.
 */
export function resolveWatchableLocalFile(rawPath: string, roots: readonly string[]): string {
  const path = resolveLocalFile(rawPath, roots)
  if (MARKDOWN_FILE_EXT.test(rawPath.trim()) && !MARKDOWN_FILE_EXT.test(path)) {
    throw new Error("Local file is not a Markdown file")
  }
  return path
}

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions): SpawnedOpener {
  return spawn(command, [...args], options)
}

/**
 * Wait for a detached opener to either start or fail to start, and turn the failure into an error the
 * RPC can carry. A `spawn` failure (ENOENT above all) arrives as an asynchronous `error` EVENT on the
 * ChildProcess, and an `error` event nobody listens for THROWS — out of the event loop, into the
 * control-plane child's `uncaughtException` handler, which exits the process. That is how one click
 * on a file link took the whole board down on Windows, where `xdg-open` does not exist and `cursor` /
 * `code` are `.cmd` shims libuv cannot find (Windows audit 2026-09-11, finding 1). `src/cloud.ts`
 * attaches the same listener to cloudflared for the same reason.
 */
export async function awaitOpenerStart(child: SpawnedOpener, command: string): Promise<void> {
  child.unref()
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => reject(new Error(
      error.code === "ENOENT"
        ? `${command} is not installed or not on PATH`
        : `could not start ${command}: ${error.message}`,
    )))
    child.once("spawn", resolve)
  })
}

export interface OpenerCommand {
  command: string
  args: readonly string[]
  /** Hand `args` to the process VERBATIM (the `cmd.exe /c` shape, whose one argument is already quoted). */
  verbatim?: boolean
}

export interface OpenerCommandOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Probe for an editor's real executable (tests point it at a fixture). */
  exists?: (path: string) => boolean
}

// Where the two editors' user-scope installers put the real executable on Windows. The `cursor` /
// `code` names on PATH there are `.cmd` shims beside them, and node has refused to spawn a `.cmd`
// without a shell since CVE-2024-27980 — so the exe is what to run when it is where it usually is.
const WINDOWS_EDITOR_EXE: Record<"cursor" | "vscode", { exe: readonly string[]; shim: string }> = {
  cursor: { exe: ["Programs", "cursor", "Cursor.exe"], shim: "cursor" },
  vscode: { exe: ["Programs", "Microsoft VS Code", "Code.exe"], shim: "code" },
}

/**
 * The fixed command plus argv that opens `path` with the selected app on `platform`. Pure over its
 * inputs so the Windows shapes are testable from a Mac.
 *
 * Windows: the system opener is `explorer.exe <path>` (the shell's own "open with the registered
 * handler"), reveal is `explorer.exe /select,<path>`. An editor runs its real executable when the
 * user-scope installer put it under `%LOCALAPPDATA%\Programs`; otherwise the `.cmd` shim on PATH is
 * run THROUGH `cmd.exe`, with the path quoted inside the one verbatim argument — never `shell: true`
 * with a bare string, which would let a path's `&` or `^` become syntax. A Windows path cannot contain
 * `"`, so quoting it is complete; `%` is refused because cmd.exe expands `%name%` even inside quotes.
 */
export function localFileOpenCommand(path: string, selected: Exclude<LocalFileOpener, "copy">, options: OpenerCommandOptions = {}): OpenerCommand {
  const platform = options.platform ?? process.platform
  if (platform === "darwin") {
    return selected === "cursor" ? { command: "open", args: ["-a", "Cursor", path] }
      : selected === "vscode" ? { command: "open", args: ["-a", "Visual Studio Code", path] }
        : selected === "finder" ? { command: "open", args: ["-R", path] }
          : { command: "open", args: [path] }
  }
  if (platform === "win32") {
    if (selected === "system") return { command: "explorer.exe", args: [path] }
    if (selected === "finder") return { command: "explorer.exe", args: [`/select,${path}`] }
    const editor = WINDOWS_EDITOR_EXE[selected]
    const env = options.env ?? process.env
    const exists = options.exists ?? existsSync
    const localAppData = env.LOCALAPPDATA
    if (localAppData) {
      const exe = join(localAppData, ...editor.exe)
      if (exists(exe)) return { command: exe, args: [path] }
    }
    if (/["%\r\n]/u.test(path)) throw new Error(`cannot hand ${path} to the ${editor.shim} shim through cmd.exe`)
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${editor.shim} "${path}""`], verbatim: true }
  }
  return selected === "cursor" ? { command: "cursor", args: [path] }
    : selected === "vscode" ? { command: "code", args: [path] }
      : { command: "xdg-open", args: [path] }
}

// Open only a previously canonicalized, allowlisted local path. No shell is ever involved; each
// platform integration gets a fixed command plus an argv array. `copy` deliberately performs no OS
// action: the trusted same-origin client writes the returned canonical path to its clipboard.
// Resolves once the opener has STARTED, and rejects — as the RPC's error — when it cannot.
export async function openLocalFile(
  rawPath: string,
  opener: LocalFileOpener,
  roots: readonly string[],
  options: { forceSystem?: boolean; spawn?: LocalFileSpawn } & OpenerCommandOptions = {},
): Promise<LocalFileOpenResult> {
  const path = resolveLocalFile(rawPath, roots)
  const chosen = options.forceSystem ? "system" : opener
  if (chosen === "copy") return { action: "copy", path }
  // An editor is the opener for TEXT. Cursor handed a PDF or a zip shows a binary-file warning, so a
  // file the reader would call binary goes where a double-click would send it: the system's own app.
  // An HTML page goes there too — the browser — since nobody clicks a linked page to edit its source.
  const editor = chosen === "cursor" || chosen === "vscode"
  const selected = editor && (HTML_FILE_EXT.test(path) || isBinaryLocalFile(path)) ? "system" : chosen

  const spec = localFileOpenCommand(path, selected, options)
  const child = (options.spawn ?? defaultSpawn)(spec.command, spec.args, {
    detached: true, stdio: "ignore", shell: false, windowsHide: true,
    ...(spec.verbatim ? { windowsVerbatimArguments: true } : {}),
  })
  await awaitOpenerStart(child, spec.command)
  return { action: "opened", path }
}
