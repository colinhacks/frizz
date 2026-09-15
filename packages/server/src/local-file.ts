import { spawn, type SpawnOptions } from "node:child_process"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import type { LocalFileOpener } from "@frizz/shared"

export type LocalFileOpenResult = { action: "opened"; path: string } | { action: "copy"; path: string }

/** The slice of a ChildProcess the opener needs: the two events that settle a spawn, and unref. */
export interface SpawnedOpener {
  unref(): void
  once(event: "spawn", listener: () => void): unknown
  once(event: "error", listener: (error: Error) => void): unknown
}

export type LocalFileSpawn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedOpener

// Windows paths name the same file in either case, and the two spellings of one root DO occur: a tool
// reports `d:\dev\repo\a.ts` while `project.dir` came back from git as `D:\Development\repo`, and
// `realpathSync` preserves whatever case it was handed for the drive. A byte comparison then read that
// as an escape attempt and refused the file. Fold case on win32 only — a POSIX path is case-sensitive
// and must keep being compared byte for byte.
function sameCase(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path
}

function isUnder(rawReal: string, root: string): boolean {
  let rootReal: string
  try { rootReal = sameCase(realpathSync(root)) } catch { return false }
  const real = sameCase(rawReal)
  return real === rootReal || real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)
}

// Canonicalize before containment so a symlink below a trusted root cannot smuggle a path outside.
// Files only. The breadth of what's openable is the CALLER's `roots`: the image proxy stays narrow
// (artifact dirs), while the open action gates to home-and-below (see the router) so a referenced file
// like ~/.claude/CLAUDE.md can open — still confined, never the whole filesystem.
export function resolveLocalFile(rawPath: string, roots: readonly string[]): string {
  // A file URL's pathname keeps `/` before a Windows drive (`/D:/docs/plan.md`).
  // Normalize here so readers, watchers and openers agree, but leave POSIX names untouched.
  if (process.platform === "win32") rawPath = rawPath.replace(/^\/([a-zA-Z]:[\\/])/, "$1")
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

export type LocalTextRead = { path: string; text: string; truncated: boolean }

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
 * The narrower gate also bought no security it was the last line of. Frizz's exposed mode (`--host` /
 * `--public-origin`) has no auth at all, so anyone who can reach the origin can already dispatch a
 * worker that reads any file on the machine and prints it into a transcript — and `openLocalFile`
 * already spawns the desktop opener on anything under home. The origin check is the boundary; this is
 * defense in depth behind it, and it stays exactly as wide as the reader's.
 *
 * Binary is refused rather than rendered as noise: a NUL in the first 8 KiB is the classic tell and the
 * viewer is a text surface. Same 1 MiB line-boundary truncation as the Markdown reader.
 */
export function readLocalTextFile(rawPath: string, roots: readonly string[]): LocalTextRead {
  const path = resolveLocalFile(rawPath, roots)
  const bytes = readFileSync(path)
  if (bytes.subarray(0, 8192).includes(0)) throw new Error("Local file is not a text file")
  if (bytes.length <= MARKDOWN_READ_LIMIT) return { path, text: bytes.toString("utf8"), truncated: false }
  const head = bytes.subarray(0, MARKDOWN_READ_LIMIT)
  const lastBreak = head.lastIndexOf(0x0a)
  return { path, text: head.subarray(0, lastBreak > 0 ? lastBreak : head.length).toString("utf8"), truncated: true }
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
  const selected = options.forceSystem ? "system" : opener
  if (selected === "copy") return { action: "copy", path }

  const spec = localFileOpenCommand(path, selected, options)
  const child = (options.spawn ?? defaultSpawn)(spec.command, spec.args, {
    detached: true, stdio: "ignore", shell: false, windowsHide: true,
    ...(spec.verbatim ? { windowsVerbatimArguments: true } : {}),
  })
  await awaitOpenerStart(child, spec.command)
  return { action: "opened", path }
}
