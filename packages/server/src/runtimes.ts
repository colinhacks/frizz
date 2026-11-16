// FRIZZ PROVISIONS ITS OWN CLAUDE CODE AND CODEX.
//
// Until 2026-09-04 a worker was whatever `claude` or `codex` happened to be first on the operator's
// PATH, and Frizz pinned only half of each pair. The Claude Agent SDK bundled into the artifact is
// built against ONE Claude Code build (the SDK's package.json names it as `claudeCodeVersion`) and
// Anthropic ships that matched binary as an optional platform package the SDK resolves by itself when
// handed no executable path — Frizz overrode that with PATH, so a 0.3.207 SDK was driving a 2.1.260
// CLI over a private wire nothing audited. Codex had a real audited pin (codex-app-server.ts) but no
// binary behind it: the gate refused older and merely WARNED on newer, and the conformance test that
// checks Frizz's parameters against the binary's own schema skipped on any machine that had moved on.
//
// So each backend now has one pin, declared here, and Frizz fetches that exact platform binary from
// the vendor's own npm package into the cache root the first time a server boots without it:
//
// (named by the constants below rather than by a sample version, because a sample one goes stale on
// every bump and both of these had — claude still read 2.1.207 four pins later)
//
//   <cache>/runtimes/claude/<CLAUDE_CODE_VERSION>/claude                (@anthropic-ai/claude-agent-sdk-<os>-<arch>)
//   <cache>/runtimes/codex/<CODEX_VERSION>/vendor/<triple>/bin/codex    (@openai/codex@<version>-<os>-<arch>)
//
// The download is verified against the registry's own sha512 integrity before anything is trusted,
// the extraction refuses links and paths that escape the version directory, and a version directory
// is only ever renamed into place COMPLETE — a crash mid-download leaves a `.partial-*` sibling that
// the next boot sweeps, never a half-written pin that resolves. Bumping a pin is a normal release:
// the SDK version moves in packages/claude-agent-sdk-runtime and CLAUDE_CODE_VERSION follows it (a
// test pins the pair to the SDK's own manifest); the codex coordinate is the audited one and moves
// with the re-audit.
//
// RESOLUTION ORDER, per backend: an explicit executable (`StartOptions.claudeBin`, or the
// `FRIZZ_CLAUDE_BIN` / `FRIZZ_CODEX_BIN` variables) wins outright and is never provisioned around;
// then the provisioned pin; then the bare name on PATH as a WARNED fallback, so an offline or
// firewalled machine still dispatches and the log says the version seam is open again.
// `FRIZZ_RUNTIMES=path` skips provisioning altogether (the test runner sets it — a suite must never
// pull half a gigabyte), and `FRIZZ_RUNTIMES_DIR` relocates the root (the ad-hoc stack points a
// sandbox HOME at the machine's real copies for the same reason). `FRIZZ_RUNTIMES_REGISTRY` names
// another npm registry, a mirror or a verification's own, and the integrity check still applies.
//
// A RUNTIME THIS MACHINE HAS NO USE FOR YET waits, and the first thread on that backend brings its pin
// down (shouldDeferRuntimes, runtime-deferral.ts). Codex waits whenever Codex is signed out, which is
// every machine that only uses Claude: until 2026-11-10 those fetched 350 MB of Codex at first boot and
// again at every Codex pin. Claude Code waits only on a machine signed out of both with OpenCode on
// PATH, because its signed-out verdict is not final until its own CLI confirms it (auth-status.ts).
// One difference from a boot download: a failed fetch has no PATH fallback, because every consumer
// already holds the pin's path. That thread's dispatch fails naming the download, and the next retries.
//
// NOT done on purpose: reusing the vendor's own versioned install (`~/.local/share/claude/versions/`,
// `~/.codex/packages/standalone/releases/`) when it happens to hold the exact pin. It would save one
// download, but both installers prune those directories on their own schedule, and a pin that can
// vanish under a running server is a worse failure than a download.
//
// CLAUDE CODE FLOATS PAST ITS PIN since 2026-11-09 (claude-float.ts). The bundled build above is the
// FLOOR: a server checks npm hourly and moves to the newest Claude Code on the bundled build's
// `major.minor` line once the bundled SDK has spoken to it, recording it in `<root>/claude-float.json`
// so the next boot starts there (readClaudeFloat). Codex stays on its audited pin.
//
// THE SWEEP IS LEASE-AWARE since 2026-09-10, because it was itself the "pin that can vanish under a
// running server": a source-tree stack pinned to 2.1.268 booted against the machine's real root and
// retired `claude/2.1.267/` while the running 0.12.9 server still forked every broker from it — every
// new thread died with "Claude executable is not executable" behind a 30s "did not become ready". A
// server now leases the pin it resolved and each detached daemon leases the binary it runs
// (runtime-lease.ts); sweepRuntimes skips a version directory with a live lease and logs why.

import { createHash, type Hash } from "node:crypto"
import {
  chmodSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeFileSync, writeSync,
} from "node:fs"
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path"
import { Readable, Transform, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"
import type { ProviderAuth } from "@frizz/shared"
import { findOnPath } from "./backend/acp-agents.ts"
import { readClaudeAuthState, readClaudeOtherCredential, readCodexAuthState } from "./backend/auth-status.ts"
import { CODEX_APP_SERVER_SUPPORTED_VERSION } from "./backend/codex-app-server.ts"
import { frizzRoots } from "./frizz-paths.ts"
import { adoptRuntimeDownload, deferRuntime } from "./runtime-deferral.ts"
import { leaseRuntime, liveRuntimeLeases } from "./runtime-lease.ts"

/** The Claude Agent SDK Frizz bundles. Must equal packages/claude-agent-sdk-runtime's dependency. */
export const CLAUDE_AGENT_SDK_VERSION = "0.3.326"
/** The Claude Code build that SDK was built against — its package.json `claudeCodeVersion`.
 *
 *  Keep this CURRENT when bumping, not merely matched: the first provisioned build (2.1.207, the SDK
 *  Frizz had sat on since July) refused the default model outright — `API Error: 400 Claude Code
 *  2.1.207 does not support this model; version 2.1.251 or newer is required` — because a model's
 *  minimum CLI is enforced server-side. The pin makes Frizz's lag the worker's lag; a stale pin is a
 *  broken worker, not a conservative one. */
export const CLAUDE_CODE_VERSION = "2.1.326"
/** The Codex build Frizz audited the app-server protocol against. One coordinate, owned there. */
export const CODEX_VERSION = CODEX_APP_SERVER_SUPPORTED_VERSION

export type RuntimeBackend = "claude" | "codex"

export type RuntimeSource =
  /** An executable the operator or a test named explicitly. Never provisioned around. */
  | "override"
  /** Frizz's own pinned copy under the cache root. */
  | "provisioned"
  /** The same copy, not fetched yet: `bin` is where it will land, on the first thread that needs it. */
  | "deferred"
  /** The bare name on PATH — the pre-2026-09 behaviour, now the fallback. `note` says why. */
  | "path"

export interface ResolvedRuntime {
  bin: string
  source: RuntimeSource
  /** The pinned version for a provisioned runtime; "unknown" for an override or PATH. */
  version: string
  /** Why a fallback happened, for the log and the diagnostics surface. */
  note?: string
  /** This boot downloaded the pin (it was not on disk already). */
  fetched?: true
  /** A deferred pin whose download is already running, because the board opened before it finished. */
  downloading?: true
}

export interface ResolvedRuntimes {
  claude: ResolvedRuntime
  codex: ResolvedRuntime
}

export const RUNTIMES_MODE_ENV = "FRIZZ_RUNTIMES"
export const RUNTIMES_DIR_ENV = "FRIZZ_RUNTIMES_DIR"
export const CLAUDE_BIN_ENV = "FRIZZ_CLAUDE_BIN"
export const CODEX_BIN_ENV = "FRIZZ_CODEX_BIN"
export const RUNTIMES_REGISTRY_ENV = "FRIZZ_RUNTIMES_REGISTRY"

const REGISTRY = "https://registry.npmjs.org"

/** Where the pins live: `<cache>/runtimes`, or wherever FRIZZ_RUNTIMES_DIR points. */
export function runtimesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[RUNTIMES_DIR_ENV]
  if (override && isAbsolute(override)) return override
  return join(frizzRoots().cache, "runtimes")
}

/** Is this Linux a musl one (Alpine)? The SDK ships a separate musl build; Codex ships musl for all. */
function isMusl(): boolean {
  if (process.platform !== "linux") return false
  const report = typeof process.report?.getReport === "function"
    ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
    : null
  return report != null && report.header?.glibcVersionRuntime === undefined
}

export interface RuntimeCoordinates {
  /** The npm package that carries the binary. */
  pkg: string
  /** The exact version of that package to fetch. */
  packageVersion: string
  /** The directory name under `<root>/<backend>/` — the version a human recognises. */
  label: string
  /** The binary's file name inside the package (extension included on Windows). */
  binary: string
}

/**
 * The npm coordinates of one backend's pinned binary on one platform, or undefined where the vendor
 * publishes nothing for it (a platform Frizz does not support anyway; the caller falls back to PATH).
 */
export function runtimeCoordinates(
  backend: RuntimeBackend,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMusl(),
): RuntimeCoordinates | undefined {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) return undefined
  const exe = platform === "win32" ? ".exe" : ""
  if (backend === "claude") {
    return { pkg: `@anthropic-ai/claude-agent-sdk-${claudePlatformKey(platform, arch, musl)}`, packageVersion: CLAUDE_AGENT_SDK_VERSION, label: CLAUDE_CODE_VERSION, binary: `claude${exe}` }
  }
  return { pkg: "@openai/codex", packageVersion: `${CODEX_VERSION}-${platform}-${arch}`, label: CODEX_VERSION, binary: `codex${exe}` }
}

function claudePlatformKey(platform: NodeJS.Platform, arch: string, musl: boolean): string {
  return `${platform}-${arch}${platform === "linux" && musl ? "-musl" : ""}`
}

/**
 * The npm coordinates of one Claude Code release on one platform, for a server that moves past its
 * bundled build (claude-float.ts). Not the SDK's platform package, which is versioned by the SDK: the
 * CLI's own `@anthropic-ai/claude-code-<platform>` is versioned by Claude Code and carries the same
 * binary at its root (2.1.321's was byte-identical to the SDK's, checked 2026-11-09), so it lands in
 * the same `<root>/claude/<version>/claude` layout as the bundled pin.
 */
export function claudeReleaseCoordinates(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMusl(),
): RuntimeCoordinates | undefined {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) return undefined
  return { pkg: `@anthropic-ai/claude-code-${claudePlatformKey(platform, arch, musl)}`, packageVersion: version, label: version, binary: platform === "win32" ? "claude.exe" : "claude" }
}

/** `2.1.321` → [2, 1, 321]; anything but three plain numbers (a prerelease, a typo) is undefined. */
export function parseReleaseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** Is `candidate` a later release on the same `major.minor` line as `base`? */
export function isLaterOnLine(candidate: string, base: string): boolean {
  const a = parseReleaseVersion(candidate)
  const b = parseReleaseVersion(base)
  return !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] > b[2]
}

/** Where a server records the Claude Code it moved to, so the next boot starts on it with no fetch. */
export function claudeFloatStatePath(root: string): string {
  return join(root, "claude-float.json")
}

/** The verified build a previous server moved to, when it is still on disk and later than `bundled`. */
export function readClaudeFloat(root: string, bundled: string = CLAUDE_CODE_VERSION): { label: string; bin: string } | undefined {
  let label: unknown
  try {
    label = (JSON.parse(readFileSync(claudeFloatStatePath(root), "utf8")) as { label?: unknown }).label
  } catch {
    return undefined
  }
  if (typeof label !== "string" || !isLaterOnLine(label, bundled)) return undefined
  const bin = provisionedBinary("claude", root, label)
  return bin ? { label, bin } : undefined
}

/** Record (or, with no label, clear) the build this machine's servers should start on. */
export function writeClaudeFloat(root: string, label: string | undefined): void {
  const path = claudeFloatStatePath(root)
  if (label === undefined) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(root, { recursive: true })
  const partial = `${path}.${process.pid}`
  writeFileSync(partial, `${JSON.stringify({ label, at: new Date().toISOString() })}\n`, "utf8")
  renameSync(partial, path)
}

/** Is floating switched off? `FRIZZ_CLAUDE_FLOAT=0` keeps a server on its bundled Claude Code. */
export const CLAUDE_FLOAT_ENV = "FRIZZ_CLAUDE_FLOAT"
export function claudeFloatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLAUDE_FLOAT_ENV] !== "0"
}

/**
 * The Rust target triple of @openai/codex's platform package, which names the directory its binary sits
 * in. The package carries exactly one, and this is what lets a deferred Codex be named before it exists.
 */
function codexTriple(platform: NodeJS.Platform, arch: string): string {
  const cpu = arch === "arm64" ? "aarch64" : "x86_64"
  if (platform === "darwin") return `${cpu}-apple-darwin`
  if (platform === "win32") return `${cpu}-pc-windows-msvc`
  return `${cpu}-unknown-linux-musl`
}

/** The path a pin's binary has once provisioned: what locateBinary finds and the marker records. */
export function pinnedBinaryPath(
  backend: RuntimeBackend,
  root: string,
  coordinates: RuntimeCoordinates,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const dir = join(root, backend, coordinates.label)
  return backend === "claude" ? join(dir, coordinates.binary) : join(dir, "vendor", codexTriple(platform, arch), "bin", coordinates.binary)
}

const MARKER = "provisioned.json"

interface ProvisionedMarker {
  backend: RuntimeBackend
  label: string
  pkg: string
  packageVersion: string
  integrity: string
  /** The binary's path relative to the version directory. */
  binary: string
  at: string
}

/** The binary of an already-provisioned pin, or undefined when the version directory is absent or torn. */
export function provisionedBinary(backend: RuntimeBackend, root: string, label: string): string | undefined {
  const dir = join(root, backend, label)
  let marker: ProvisionedMarker
  try {
    marker = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as ProvisionedMarker
  } catch {
    return undefined
  }
  if (typeof marker.binary !== "string" || marker.label !== label) return undefined
  const bin = join(dir, marker.binary)
  return existsSync(bin) ? bin : undefined
}

// ---------------------------------------------------------------------------------------------------
// A minimal tar reader — enough for an npm tarball, and nothing more.
//
// npm tarballs are gzipped ustar/pax archives whose every path starts with `package/`. Node has gzip
// but no tar, and the published artifact bundles no tar library, so this reads the format directly:
// 512-byte headers, octal sizes, data padded to the block, GNU `L` long names and pax `x` `path=`
// records for names past 100 bytes. Anything that is not a plain file or a directory — a symlink, a
// hard link, a device — is skipped WITHOUT being created: a tarball is untrusted input until its
// integrity has been checked, and the check finishes after the last byte, so extraction must be safe
// on its own. Paths are normalised and refused if they would land outside the destination.
// ---------------------------------------------------------------------------------------------------

const BLOCK = 512

function octal(buffer: Buffer, offset: number, length: number): number {
  const text = buffer.toString("latin1", offset, offset + length).replace(/\0.*$/su, "").trim()
  return text ? Number.parseInt(text, 8) : 0
}

function field(buffer: Buffer, offset: number, length: number): string {
  return buffer.toString("utf8", offset, offset + length).replace(/\0.*$/su, "")
}

/** Strip the leading `package/` npm puts on every entry, then refuse anything that escapes `dest`. */
function safeEntryPath(dest: string, name: string): string | undefined {
  const parts = name.split("/").filter((part) => part.length > 0)
  if (parts.length < 2) return undefined // `package/` itself, or a bare file at the root
  const rel = normalize(parts.slice(1).join(sep))
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return undefined
  const full = join(dest, rel)
  const back = relative(dest, full)
  if (back.startsWith("..") || isAbsolute(back)) return undefined
  return full
}

class TarExtractor extends Writable {
  private pending = Buffer.alloc(0)
  private remaining = 0
  private padding = 0
  private fd: number | undefined
  private longName: string | undefined
  private paxPath: string | undefined
  private paxBuffer: Buffer[] | undefined
  private nameBuffer: Buffer[] | undefined
  readonly written: string[] = []

  constructor(private readonly dest: string) {
    super()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.consume(chunk)
      callback()
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)))
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.fd !== undefined) closeSync(this.fd)
    this.fd = undefined
    callback(this.remaining > 0 ? new Error("tarball ended inside a file entry") : null)
  }

  private consume(chunk: Buffer): void {
    let data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    this.pending = Buffer.alloc(0)
    for (;;) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, data.length)
        this.sink(data.subarray(0, take))
        this.remaining -= take
        data = data.subarray(take)
        if (this.remaining === 0) this.finishEntry()
        if (data.length === 0) return
        continue
      }
      if (this.padding > 0) {
        const take = Math.min(this.padding, data.length)
        this.padding -= take
        data = data.subarray(take)
        if (data.length === 0) return
        continue
      }
      if (data.length < BLOCK) {
        this.pending = Buffer.from(data)
        return
      }
      const header = data.subarray(0, BLOCK)
      data = data.subarray(BLOCK)
      if (header.every((byte) => byte === 0)) continue // end-of-archive blocks
      this.startEntry(header)
    }
  }

  private startEntry(header: Buffer): void {
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156]!) || "0"
    const magic = field(header, 257, 6)
    const prefix = magic.startsWith("ustar") ? field(header, 345, 155) : ""
    const base = field(header, 0, 100)
    const name = this.longName ?? this.paxPath ?? (prefix ? `${prefix}/${base}` : base)
    this.longName = undefined
    this.paxPath = undefined
    this.remaining = size
    this.padding = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK)
    this.fd = undefined
    this.nameBuffer = undefined
    this.paxBuffer = undefined
    switch (type) {
      case "L": // GNU long name: the data IS the next entry's name
        this.nameBuffer = []
        return
      case "x": // pax extended header for the next entry
        this.paxBuffer = []
        return
      case "5": {
        const dir = safeEntryPath(this.dest, name)
        if (dir) mkdirSync(dir, { recursive: true })
        return
      }
      case "0":
      case "\0":
      case "7": {
        const file = safeEntryPath(this.dest, name)
        if (!file) return // skipped: the data is drained by `remaining` with no sink
        mkdirSync(dirname(file), { recursive: true })
        this.fd = openSync(file, "w", octal(header, 100, 8) & 0o777 || 0o644)
        this.written.push(file)
        return
      }
      default:
        return // links, devices, globals, unknowns: drained and not created
    }
  }

  private sink(bytes: Buffer): void {
    if (this.fd !== undefined) writeSync(this.fd, bytes)
    else if (this.nameBuffer) this.nameBuffer.push(Buffer.from(bytes))
    else if (this.paxBuffer) this.paxBuffer.push(Buffer.from(bytes))
  }

  private finishEntry(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd)
      this.fd = undefined
    }
    if (this.nameBuffer) {
      this.longName = Buffer.concat(this.nameBuffer).toString("utf8").replace(/\0.*$/su, "")
      this.nameBuffer = undefined
    }
    if (this.paxBuffer) {
      // Records are `<decimal length> <key>=<value>\n`, length counting the whole record.
      const text = Buffer.concat(this.paxBuffer).toString("utf8")
      this.paxBuffer = undefined
      let at = 0
      while (at < text.length) {
        const space = text.indexOf(" ", at)
        if (space === -1) break
        const length = Number.parseInt(text.slice(at, space), 10)
        if (!Number.isFinite(length) || length <= 0) break
        const record = text.slice(space + 1, at + length - 1)
        const eq = record.indexOf("=")
        if (eq !== -1 && record.slice(0, eq) === "path") this.paxPath = record.slice(eq + 1)
        at += length
      }
    }
  }
}

/** Extract a gzipped npm tarball into `dest`, returning the files written. Exported for its test. */
export async function extractNpmTarball(source: Readable, dest: string): Promise<string[]> {
  const extractor = new TarExtractor(dest)
  await pipeline(source, createGunzip(), extractor)
  return extractor.written
}

// ---------------------------------------------------------------------------------------------------

export interface ProvisionOptions {
  root: string
  coordinates: RuntimeCoordinates
  fetch?: typeof globalThis.fetch
  /** Registry base — a test points it at a local server. */
  registry?: string
  onProgress?: (message: string) => void
  /** The same progress as numbers, for a progress bar (RuntimeDownload). */
  onDownload?: (download: RuntimeDownload) => void
  /** Drop a connection that has sent nothing for this long, and ask again from where it stopped. */
  stallReconnectMs?: number
  /** Fail once nothing has arrived for this long; what did arrive stays on disk for the next try. */
  stallGiveUpMs?: number
  /** The wait before reconnecting after the `attempt`th connection was lost (tests make it short). */
  backoffMs?: (attempt: number) => number
  /** The final `renameSync(partial, finalDir)` — a test makes it fail the way Windows does. */
  rename?: (from: string, to: string) => void
  /** Pause between rename attempts (see RENAME_ATTEMPTS). */
  retryDelayMs?: number
}

// How many times the final rename is tried before the race is called lost. On Windows the directory
// that just received a 200 MB claude.exe is briefly held by Defender's real-time scan (and by the
// Search indexer), and MoveFileEx on a directory with an open handle inside it fails EPERM/EBUSY —
// so the first attempt losing says nothing about whether another provisioner finished first
// (Windows audit 2026-09-11, finding 3; src/artifacts.ts carries the same retry for the same class).
// Five tries 200 ms apart is a second: past that a held handle is a scanner that has the file open
// for real, and the fallback below (someone else's pin, or the error) is the honest answer.
const RENAME_ATTEMPTS = 5
const RENAME_RETRY_DELAY_MS = 200
const TRANSIENT_HANDLE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"])

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code

export interface Provisioned {
  bin: string
  label: string
  /** False when the pin was already on disk and nothing was fetched. */
  fetched: boolean
}

/** Find the extracted binary: at the package root for Claude, under `vendor/<triple>/bin/` for Codex. */
function locateBinary(dir: string, backend: RuntimeBackend, binary: string): string | undefined {
  if (backend === "claude") {
    const direct = join(dir, binary)
    return existsSync(direct) ? direct : undefined
  }
  const vendor = join(dir, "vendor")
  let triples: string[]
  try {
    triples = readdirSync(vendor)
  } catch {
    return undefined
  }
  for (const triple of triples) {
    const candidate = join(vendor, triple, "bin", binary)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function describeBytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

/** What one pin's download is doing, for a progress bar rather than a log line. */
export interface RuntimeDownload {
  backend: RuntimeBackend
  label: string
  state: "resolving" | "downloading" | "stalled" | "unpacking" | "ready"
  /** Compressed bytes on disk so far, an earlier interrupted attempt's included. */
  received: number
  /** The tarball's length, or 0 when the registry names none. */
  total: number
  /** Bytes per second over the last few seconds; 0 until there is a reading. */
  bytesPerSecond: number
  /** How long since the last byte arrived, once that is long enough to call the download stalled. */
  stalledForMs?: number
  /** Bytes an earlier attempt left on disk, which this download did not fetch again. */
  resumedFrom?: number
}

// THE DOWNLOAD SURVIVES A SLOW OR DROPPED CONNECTION (2026-11-15). Until then the tarball streamed
// straight into gunzip and the extractor, so none of it was kept as a tarball: a connection that
// dropped at 300 of 348 MB, or a boot the launcher killed for taking too long, started from zero the
// next time. On the maintainer's ~500 KB/s connection that turned one update into a ten-minute outage,
// and a slower connection could have looped forever. Now the compressed bytes land in
// `.partial-<label>.tgz` first (the sweep's `.partial-` rule keeps it for a day, then retires it), a
// later attempt asks the registry for the rest with a Range header, and only a complete, verified
// tarball is unpacked.
//
// A connection that goes quiet is not waited on: after STALL_RECONNECT_MS without a byte the request
// is dropped and made again from where it stopped, and after STALL_GIVE_UP_MS without one the download
// fails (a boot then falls back to PATH as it always has, and the bytes stay for the next try). The
// manifest request is not retried, so a machine with no network at all fails as fast as it did before.
const STALL_NOTICE_MS = 10_000
const STALL_RECONNECT_MS = 30_000
const STALL_GIVE_UP_MS = 5 * 60_000
const SPEED_WINDOW_MS = 5_000
const REPORT_EVERY_MS = 500

/** Hash a file already on disk, for a download that resumes after it. */
async function hashFile(path: string, hash: Hash): Promise<void> {
  await pipeline(createReadStream(path), new Writable({ write(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback() } }))
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

/**
 * Claim the shared tarball for one label, or learn that a live process holds it. Two processes
 * provisioning one pin at once (a dev child beside a stable one) must not append to one file; the
 * second downloads into a private file and simply does not resume. A dead holder's claim is taken over.
 */
function claimTarball(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx")
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (err) {
      if (errorCode(err) !== "EEXIST") return false
      let holder = Number.NaN
      try { holder = Number.parseInt(readFileSync(lock, "utf8").trim(), 10) } catch { /* removed meanwhile */ }
      if (Number.isInteger(holder) && holder !== process.pid && pidAlive(holder)) return false
      rmSync(lock, { force: true })
    }
  }
  return false
}

interface TarballDownload {
  url: string
  file: string
  integrity: string
  fetch: typeof globalThis.fetch
  report: (state: "downloading" | "stalled", fields: Omit<RuntimeDownload, "backend" | "label" | "state">) => void
  stallReconnectMs: number
  stallGiveUpMs: number
  /** How long to wait before attempt `n + 1` after attempt `n` lost its connection. */
  backoffMs: (attempt: number) => number
}

/** Fetch `url` into `file`, resuming whatever is already there, and verify all of it. */
async function downloadTarball(options: TarballDownload): Promise<void> {
  const { file } = options
  let hash = createHash("sha512")
  let received = existsSync(file) ? statSync(file).size : 0
  const resumedFrom = received > 0 ? received : undefined
  if (received > 0) await hashFile(file, hash)
  let total = 0
  let lastByteAt = Date.now()
  let samples: Array<[number, number]> = [[lastByteAt, received]]
  const report = () => {
    const now = Date.now()
    samples.push([now, received])
    while (samples.length > 2 && now - samples[1]![0] >= SPEED_WINDOW_MS) samples.shift()
    const [at, bytes] = samples[0]!
    const quiet = now - lastByteAt
    const stalled = quiet >= STALL_NOTICE_MS
    options.report(stalled ? "stalled" : "downloading", {
      received,
      total,
      bytesPerSecond: stalled || now - at < 1000 ? 0 : Math.max(0, Math.round(((received - bytes) * 1000) / (now - at))),
      ...(stalled ? { stalledForMs: quiet } : {}),
      ...(resumedFrom ? { resumedFrom } : {}),
    })
  }
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    let fd: number | undefined
    const ticker = setInterval(() => {
      report()
      if (Date.now() - lastByteAt >= options.stallReconnectMs) controller.abort(new Error("no data"))
    }, REPORT_EVERY_MS)
    let complete = false
    try {
      const response = await options.fetch(options.url, {
        signal: controller.signal,
        ...(received > 0 ? { headers: { range: `bytes=${received}-` } } : {}),
      })
      if (response.status === 416 && received > 0) {
        // Nothing lies past what is on disk: an earlier attempt got all of it. The hash decides.
        complete = true
      } else {
        if (!response.ok || !response.body) throw new RegistryRefusal(`tarball download answered ${response.status}`)
        const range = /^bytes (\d+)-\d+\/(\d+)$/u.exec(response.headers.get("content-range") ?? "")
        if (response.status === 206 && range && Number(range[1]) === received) {
          total = Number(range[2])
        } else {
          // The whole tarball (a registry that ignores Range, or a 200 to a first request): whatever is
          // on disk is superseded by it.
          if (received > 0) {
            hash = createHash("sha512")
            received = 0
            samples = [[Date.now(), 0]]
          }
          total = Number(response.headers.get("content-length") ?? 0)
        }
        fd = openSync(file, received > 0 ? "a" : "w")
        const reader = (response.body as ReadableStream<Uint8Array>).getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          writeSync(fd, value)
          hash.update(value)
          received += value.length
          lastByteAt = Date.now()
        }
        complete = total === 0 || received >= total
      }
    } catch (err) {
      // What the registry meant (a 404, a 500) is final. A dropped or silent connection is not.
      if (err instanceof RegistryRefusal) throw err
    } finally {
      clearInterval(ticker)
      if (fd !== undefined) closeSync(fd)
    }
    if (complete) break
    if (Date.now() - lastByteAt >= options.stallGiveUpMs) {
      throw new Error(`the download stopped receiving data; ${describeBytes(received)}${total ? ` of ${describeBytes(total)}` : ""} is kept for the next try`)
    }
    const until = Date.now() + options.backoffMs(attempt)
    while (Date.now() < until) {
      report()
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, Math.min(REPORT_EVERY_MS, until - Date.now()))))
    }
  }
  report()
  const digest = `sha512-${hash.digest("base64")}`
  if (digest !== options.integrity) {
    rmSync(file, { force: true })
    throw new Error(`integrity mismatch for ${options.url}: expected ${options.integrity}, got ${digest}`)
  }
}

/** An answer the registry meant, which retrying will not change. */
class RegistryRefusal extends Error {}

/**
 * Make sure one backend's pin is on disk, fetching it from the registry when it is not.
 *
 * Idempotent and crash-safe: the tarball is downloaded to `.partial-<label>.tgz` (resumable, above),
 * then unpacked into a `.partial-<label>-<pid>` sibling that is renamed into place only after the
 * integrity check and the binary lookup both pass. Two servers racing the same pin each build their
 * own directory; the second rename finds the version already there and simply uses it.
 */
export async function provisionRuntime(backend: RuntimeBackend, options: ProvisionOptions): Promise<Provisioned> {
  const { root, coordinates } = options
  const existing = provisionedBinary(backend, root, coordinates.label)
  if (existing) return { bin: existing, label: coordinates.label, fetched: false }

  const fetchImpl = options.fetch ?? globalThis.fetch
  const registry = options.registry ?? REGISTRY
  const progress = options.onProgress ?? (() => {})
  const download = (state: RuntimeDownload["state"], fields: Partial<Omit<RuntimeDownload, "backend" | "label" | "state">> = {}) =>
    options.onDownload?.({ backend, label: coordinates.label, state, received: 0, total: 0, bytesPerSecond: 0, ...fields })
  const backendDir = join(root, backend)
  const finalDir = join(backendDir, coordinates.label)
  const partial = join(backendDir, `.partial-${coordinates.label}-${process.pid}`)
  mkdirSync(backendDir, { recursive: true })
  const lock = join(backendDir, `.partial-${coordinates.label}.tgz.lock`)
  const shared = claimTarball(lock)
  const tarballFile = shared ? join(backendDir, `.partial-${coordinates.label}.tgz`) : join(backendDir, `.partial-${coordinates.label}-${process.pid}.tgz`)

  try {
    const manifestUrl = `${registry}/${coordinates.pkg.replace("/", "%2F")}/${coordinates.packageVersion}`
    progress(`resolving ${coordinates.pkg}@${coordinates.packageVersion}`)
    download("resolving")
    const manifestResponse = await fetchImpl(manifestUrl)
    if (!manifestResponse.ok) throw new Error(`registry answered ${manifestResponse.status} for ${coordinates.pkg}@${coordinates.packageVersion}`)
    const manifest = (await manifestResponse.json()) as { dist?: { tarball?: string; integrity?: string } }
    const tarball = manifest.dist?.tarball
    const integrity = manifest.dist?.integrity
    if (!tarball || !integrity?.startsWith("sha512-")) throw new Error(`registry manifest for ${coordinates.pkg}@${coordinates.packageVersion} carries no sha512 tarball`)

    let lastLine = 0
    await downloadTarball({
      url: tarball,
      file: tarballFile,
      integrity,
      fetch: fetchImpl,
      stallReconnectMs: options.stallReconnectMs ?? STALL_RECONNECT_MS,
      stallGiveUpMs: options.stallGiveUpMs ?? STALL_GIVE_UP_MS,
      backoffMs: options.backoffMs ?? ((attempt) => Math.min(15_000, 1000 * 2 ** attempt)),
      report: (state, fields) => {
        download(state, fields)
        // The log line keeps its old words: runtimeDownloadNote and the launcher's readout read them.
        const now = Date.now()
        if (now - lastLine < REPORT_EVERY_MS) return
        lastLine = now
        const quiet = fields.stalledForMs ? `, no data for ${Math.round(fields.stalledForMs / 1000)}s` : ""
        progress(fields.total > 0
          ? `downloading ${describeBytes(fields.total)}, ${Math.min(99, Math.floor((fields.received / fields.total) * 100))}%${quiet}`
          : `downloading, ${describeBytes(fields.received)} so far${quiet}`)
      },
    })

    // Unpacked from the verified file, never from the network, so a torn download cannot reach here.
    progress("unpacking")
    download("unpacking")
    rmSync(partial, { recursive: true, force: true })
    mkdirSync(partial)
    await pipeline(createReadStream(tarballFile), createGunzip(), new TarExtractor(partial))
    const bin = locateBinary(partial, backend, coordinates.binary)
    if (!bin) throw new Error(`${coordinates.pkg}@${coordinates.packageVersion} unpacked without a ${coordinates.binary} binary`)
    if (process.platform !== "win32") chmodSync(bin, 0o755)
    const marker: ProvisionedMarker = {
      backend, label: coordinates.label, pkg: coordinates.pkg, packageVersion: coordinates.packageVersion, integrity,
      binary: relative(partial, bin), at: new Date().toISOString(),
    }
    writeFileSync(join(partial, MARKER), `${JSON.stringify(marker, null, 2)}\n`, "utf8")

    const rename = options.rename ?? renameSync
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          rename(partial, finalDir)
          break
        } catch (err) {
          // A transient handle (Windows, see RENAME_ATTEMPTS) is retried; EEXIST and the rest are the
          // race, decided below. Once the pin exists the retry is pointless either way.
          if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_HANDLE_CODES.has(errorCode(err) ?? "") || existsSync(finalDir)) throw err
          await new Promise<void>((resolve) => setTimeout(resolve, options.retryDelayMs ?? RENAME_RETRY_DELAY_MS))
        }
      }
    } catch (err) {
      // Someone else finished first. Theirs is complete by construction, so use it.
      const theirs = provisionedBinary(backend, root, coordinates.label)
      if (!theirs) throw err
      rmSync(partial, { recursive: true, force: true })
      rmSync(tarballFile, { force: true })
      return { bin: theirs, label: coordinates.label, fetched: false }
    }
    rmSync(tarballFile, { force: true })
    progress("ready")
    download("ready")
    return { bin: join(finalDir, marker.binary), label: coordinates.label, fetched: true }
  } catch (err) {
    rmSync(partial, { recursive: true, force: true })
    // A private tarball cannot be resumed by anyone, so it goes; the shared one is the point of keeping.
    if (!shared) rmSync(tarballFile, { force: true })
    throw err
  } finally {
    if (shared) rmSync(lock, { force: true })
  }
}

export interface RuntimeSweep {
  /** Version directories and stale partials that were removed. */
  removed: string[]
  /**
   * Superseded version directories left in place: because a live process leases them (`leases`), or
   * because the OS refused to remove them (`reason`) — on Windows a binary some process still runs
   * cannot be deleted, lease or no lease.
   */
  kept: Array<{ dir: string; leases: Array<{ pid: number; role: string }>; reason?: string }>
}

export interface SweepRuntimesDeps {
  /** `rmSync` of one entry — a test makes it fail the way Windows does on a mapped executable. */
  rm?: (path: string) => void
}

// Windows cannot delete an executable that is currently mapped as a process image: rmSync gets
// EBUSY/EPERM (or ENOTEMPTY for the directory, once the files inside it refused), and `force: true`
// only forgives ENOENT. The version directory being swept is by design the one still-running daemons
// execute from — they survive an update on purpose — and a daemon started by a Frizz older than
// d37b8588 (2026-09-10) wrote no lease, so the lease check above cannot see it. `maxRetries` covers
// the transient holders (a scanner, an exiting process); a refusal past that is a live one, and the
// directory is KEPT and named rather than thrown about (Windows audit 2026-09-11, finding 2). The
// next boot sweeps again.
const defaultSweepRm = (path: string): void => rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })

/**
 * Retire what the current pin superseded: every other version directory of this backend that no
 * live process leases (runtime-lease.ts — a server or daemon still running out of it), and any
 * partial left by a run that died more than a day ago (a younger one may still be mid-download in
 * another process). Returns what it removed and what it kept, for the log. Never throws for one
 * entry's sake: an entry the OS refuses to remove is reported as kept, and the sweep goes on.
 */
export function sweepRuntimes(backend: RuntimeBackend, root: string, keepLabel: string | readonly string[], now = Date.now(), deps: SweepRuntimesDeps = {}): RuntimeSweep {
  const keep = new Set(typeof keepLabel === "string" ? [keepLabel] : keepLabel)
  const rm = deps.rm ?? defaultSweepRm
  const backendDir = join(root, backend)
  let entries: string[]
  try {
    entries = readdirSync(backendDir)
  } catch {
    return { removed: [], kept: [] }
  }
  const sweep: RuntimeSweep = { removed: [], kept: [] }
  for (const entry of entries) {
    if (keep.has(entry)) continue
    const full = join(backendDir, entry)
    if (entry.startsWith(".partial-")) {
      try {
        if (now - statSync(full).mtimeMs < 24 * 60 * 60 * 1000) continue
      } catch {
        continue
      }
    } else {
      const leases = liveRuntimeLeases(full)
      if (leases.length > 0) {
        sweep.kept.push({ dir: full, leases: leases.map(({ pid, role }) => ({ pid, role })) })
        continue
      }
    }
    try {
      rm(full)
      sweep.removed.push(full)
    } catch (err) {
      const code = errorCode(err)
      const reason = code && TRANSIENT_HANDLE_CODES.has(code)
        ? `in use (${code})`
        : `could not remove: ${err instanceof Error ? err.message : String(err)}`
      sweep.kept.push({ dir: full, leases: [], reason })
    }
  }
  return sweep
}

// ---------------------------------------------------------------------------------------------------

export interface ResolveRuntimesOptions {
  claudeBin?: string
  codexBin?: string
  env?: NodeJS.ProcessEnv
  root?: string
  fetch?: typeof globalThis.fetch
  registry?: string
  log?: (level: "info" | "warn", message: string) => void
  /** Boot-progress hook; the message names the backend. */
  onProgress?: (backend: RuntimeBackend, message: string) => void
  /** The same progress as numbers, for the restart page's bars. */
  onDownload?: (download: RuntimeDownload) => void
  /**
   * Fetch nothing now for these backends: register the pin to come down on its first thread
   * (runtime-deferral.ts). `true` is both of them.
   */
  defer?: boolean | Partial<DeferRuntimes>
  /**
   * Settles when the operator asks the boot to stop waiting ("Open Frizz now" on the restart page). A
   * pin still downloading then becomes a deferred one whose download carries on in the background,
   * and the first thread on that backend waits for the same download rather than starting another.
   */
  openNow?: Promise<void>
  /** Seams for the Windows failure modes (tests): see ProvisionOptions.rename and SweepRuntimesDeps.rm. */
  rename?: ProvisionOptions["rename"]
  rm?: SweepRuntimesDeps["rm"]
  /** Download seams (tests): see ProvisionOptions. */
  stallReconnectMs?: number
  stallGiveUpMs?: number
  backoffMs?: (attempt: number) => number
}

async function resolveOne(backend: RuntimeBackend, explicit: string | undefined, options: ResolveRuntimesOptions): Promise<ResolvedRuntime> {
  const env = options.env ?? process.env
  const log = options.log ?? (() => {})
  const bare = backend
  const override = explicit ?? env[backend === "claude" ? CLAUDE_BIN_ENV : CODEX_BIN_ENV]
  if (override) return { bin: override, source: "override", version: "unknown" }
  if (env[RUNTIMES_MODE_ENV] === "path") return { bin: bare, source: "path", version: "unknown", note: `${RUNTIMES_MODE_ENV}=path` }
  const coordinates = runtimeCoordinates(backend)
  if (!coordinates) {
    const note = `no ${backend} build is published for ${process.platform}-${process.arch}`
    log("warn", `runtimes: ${note}; using ${bare} from PATH`)
    return { bin: bare, source: "path", version: "unknown", note }
  }
  const root = options.root ?? runtimesRoot(env)
  const registry = options.registry ?? env[RUNTIMES_REGISTRY_ENV]
  const provision = (onProgress: (message: string) => void, onDownload?: (download: RuntimeDownload) => void) => provisionRuntime(backend, {
    root, coordinates, fetch: options.fetch, registry, rename: options.rename, onProgress, onDownload,
    stallReconnectMs: options.stallReconnectMs, stallGiveUpMs: options.stallGiveUpMs, backoffMs: options.backoffMs,
  })
  // Before the sweep: it is what tells the sweep which pin the release before this one booted on.
  recordPin(backend, root, coordinates.label)
  const bin = provisionedBinary(backend, root, coordinates.label) ?? pinnedBinaryPath(backend, root, coordinates)
  // What a deferred pin does on its first need: the same download, then the same lease a boot takes.
  const deferredProvision = async (onProgress: (message: string) => void, onDownload?: (download: RuntimeDownload) => void) => {
    const provisioned = await provision(onProgress, onDownload)
    if (provisioned.fetched) log("info", `runtimes: provisioned ${backend} ${provisioned.label} at ${provisioned.bin}`)
    // The consumers have held `bin` since boot, so a package laid out differently must say so here.
    if (provisioned.bin !== bin) throw new Error(`${coordinates.pkg} unpacked its binary at ${provisioned.bin}, not ${bin}`)
    leaseRuntime(provisioned.bin, "server")
  }
  if (typeof options.defer === "object" ? options.defer[backend] : options.defer) {
    deferRuntime(backend, deferredProvision)
    // A recorded later build is kept for the boot that provisions: this one starts nothing on it.
    const recorded = backend === "claude" ? readClaudeFloat(root, coordinates.label)?.label : undefined
    sweepSuperseded(backend, root, recorded ? [coordinates.label, recorded] : coordinates.label, options)
    return { bin, source: "deferred", version: coordinates.label }
  }
  // Where this download reports. "Open Frizz now" moves it from the boot's readout to the deferred
  // runtime's own, which is what the composer and the board read once the server is up.
  const sink = {
    progress: (message: string) => options.onProgress?.(backend, message),
    download: (download: RuntimeDownload) => options.onDownload?.(download),
  }
  const running = provision((message) => sink.progress(message), (download) => sink.download(download))
  let provisioned: Provisioned
  try {
    if (options.openNow) {
      const opened = await Promise.race([running.then(() => false, () => false), options.openNow.then(() => true)])
      if (opened) {
        const adopted = adoptRuntimeDownload(backend, deferredProvision, running.then(async (done) => {
          if (done.fetched) log("info", `runtimes: provisioned ${backend} ${done.label} at ${done.bin} after the board opened`)
          if (done.bin !== bin) throw new Error(`${coordinates.pkg} unpacked its binary at ${done.bin}, not ${bin}`)
          leaseRuntime(done.bin, "server")
        }))
        sink.progress = adopted.progress
        sink.download = adopted.download
        log("info", `runtimes: the board opened before ${backend} ${coordinates.label} finished downloading; it continues in the background`)
        const recorded = backend === "claude" ? readClaudeFloat(root, coordinates.label)?.label : undefined
        sweepSuperseded(backend, root, recorded ? [coordinates.label, recorded] : coordinates.label, options)
        return { bin, source: "deferred", version: coordinates.label, downloading: true, note: "still downloading when the board opened" }
      }
    }
    provisioned = await running
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err)
    log("warn", `runtimes: could not provision ${backend} ${coordinates.label} (${note}); using ${bare} from PATH — the version Frizz was built against is not what will run`)
    return { bin: bare, source: "path", version: "unknown", note }
  }
  if (provisioned.fetched) log("info", `runtimes: provisioned ${backend} ${provisioned.label} at ${provisioned.bin}`)
  // A later Claude Code this machine already moved to and verified (claude-float.ts) is where a boot
  // starts, from disk and with no fetch. The bundled pin stays provisioned beside it as the fallback.
  const floated = backend === "claude" && claudeFloatEnabled(env) ? readClaudeFloat(root, coordinates.label) : undefined
  // Lease BEFORE sweeping: another Frizz on this machine (a stack booted from a source tree with a
  // newer pin, the successor of an in-place update) sweeps on ITS boot, and this is what tells it
  // the pin resolved here is still in use.
  leaseRuntime(floated?.bin ?? provisioned.bin, "server")
  sweepSuperseded(backend, root, floated ? [coordinates.label, floated.label] : coordinates.label, options)
  if (floated) return { bin: floated.bin, source: "provisioned", version: floated.label, note: `moved past the bundled ${coordinates.label}`, ...(provisioned.fetched ? { fetched: true } : {}) }
  return { bin: provisioned.bin, source: "provisioned", version: provisioned.label, ...(provisioned.fetched ? { fetched: true } : {}) }
}

// THE PREVIOUS RELEASE'S PINS ARE KEPT (2026-11-15). The sweep used to keep only what the booting
// server would run, so an update deleted the pins of the release before it the moment it booted. When that
// release came back — a restart onto the pinned bootstrap server, an update undone — it downloaded all
// of them again: on 2026-11-15 0.15.55 retired Claude Code 2.1.322 (0.15.52's pin; 0.15.52 itself had
// floated to 2.1.325, so nothing leased it) and the next restart onto 0.15.52 spent eight minutes
// fetching 320 MB back. So every boot records the pin it booted on, newest first, and every sweep
// keeps the newest two: this release's and the one before it. A pin downloaded AHEAD of an update
// (prepareRuntimes) is kept too, for the day it waits to be booted on.
const PIN_HISTORY = "pin-history.json"
const PIN_HISTORY_DEPTH = 4
const PIN_AHEAD_KEPT_MS = 24 * 60 * 60 * 1000

interface PinHistory {
  booted?: Partial<Record<RuntimeBackend, string[]>>
  ahead?: Partial<Record<RuntimeBackend, { label: string; at: string }>>
}

function readPinHistory(root: string): PinHistory {
  try {
    const value = JSON.parse(readFileSync(join(root, PIN_HISTORY), "utf8")) as PinHistory
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

function writePinHistory(root: string, history: PinHistory): void {
  try {
    mkdirSync(root, { recursive: true })
    const path = join(root, PIN_HISTORY)
    const partial = `${path}.${process.pid}`
    writeFileSync(partial, `${JSON.stringify(history, null, 2)}\n`, "utf8")
    renameSync(partial, path)
  } catch {
    // The history only spares a download. Failing to write it costs one, never a boot.
  }
}

/** Record that a server booted on `label` for `backend`. Returns the pin booted on before it, if any. */
export function recordPin(backend: RuntimeBackend, root: string, label: string): string | undefined {
  const history = readPinHistory(root)
  const booted = (history.booted?.[backend] ?? []).filter((entry): entry is string => typeof entry === "string")
  const next = [label, ...booted.filter((entry) => entry !== label)].slice(0, PIN_HISTORY_DEPTH)
  const ahead = { ...history.ahead }
  if (ahead[backend]?.label === label) delete ahead[backend]
  if (next.join() !== booted.join() || ahead[backend] !== history.ahead?.[backend]) writePinHistory(root, { ...history, booted: { ...history.booted, [backend]: next }, ahead })
  return next[1]
}

/** Record a pin downloaded ahead of the update that will boot on it, so no sweep retires it meanwhile. */
export function recordPinAhead(backend: RuntimeBackend, root: string, label: string): void {
  const history = readPinHistory(root)
  writePinHistory(root, { ...history, ahead: { ...history.ahead, [backend]: { label, at: new Date().toISOString() } } })
}

/** The pins every sweep keeps whatever its caller names: the last two booted on, and a fresh one fetched ahead. */
export function protectedPins(backend: RuntimeBackend, root: string, now = Date.now()): string[] {
  const history = readPinHistory(root)
  const kept = (history.booted?.[backend] ?? []).filter((entry): entry is string => typeof entry === "string").slice(0, 2)
  const ahead = history.ahead?.[backend]
  if (ahead && typeof ahead.label === "string" && now - Date.parse(ahead.at) < PIN_AHEAD_KEPT_MS) kept.push(ahead.label)
  // A Claude Code build the previous release floated to is what it would start on, so it is kept with it.
  if (backend === "claude") for (const label of [...kept]) {
    const floated = readClaudeFloat(root, label)?.label
    if (floated) kept.push(floated)
  }
  return [...new Set(kept)]
}

/**
 * Download what this machine's boot will need, ahead of booting on it — the runtimes an update's new
 * release pins, while the release before it is still serving (the launcher runs this out of the NEW
 * release's package, so its pins are the ones that count). Signed-out backends wait for their first
 * thread exactly as a boot would leave them. Nothing is swept, leased or recorded as booted: no server
 * runs these yet, and the one that will records them when it boots.
 */
export async function prepareRuntimes(options: Omit<ResolveRuntimesOptions, "openNow"> = {}): Promise<Partial<Record<RuntimeBackend, Provisioned>>> {
  const env = options.env ?? process.env
  const root = options.root ?? runtimesRoot(env)
  const registry = options.registry ?? env[RUNTIMES_REGISTRY_ENV]
  const out: Partial<Record<RuntimeBackend, Provisioned>> = {}
  await Promise.all((["claude", "codex"] as const).map(async (backend) => {
    if ((backend === "claude" ? options.claudeBin : options.codexBin) ?? env[backend === "claude" ? CLAUDE_BIN_ENV : CODEX_BIN_ENV]) return
    if (env[RUNTIMES_MODE_ENV] === "path") return
    if (typeof options.defer === "object" ? options.defer[backend] : options.defer) return
    const coordinates = runtimeCoordinates(backend)
    if (!coordinates) return
    recordPinAhead(backend, root, coordinates.label)
    out[backend] = await provisionRuntime(backend, {
      root, coordinates, fetch: options.fetch, registry, rename: options.rename,
      onProgress: (message) => options.onProgress?.(backend, message),
      onDownload: options.onDownload,
      stallReconnectMs: options.stallReconnectMs, stallGiveUpMs: options.stallGiveUpMs, backoffMs: options.backoffMs,
    })
  }))
  return out
}

// The sweep is housekeeping and shares NOTHING with the pin: until 2026-09-11 both sat in one
// `try`, so a sweep that threw (Windows refusing to delete a claude.exe some daemon still runs)
// discarded a perfectly good provisioned binary and degraded the whole backend to a bare name on
// PATH — which on a machine without an npm claude is "could not resolve 'claude'" at boot (Windows
// audit 2026-09-11, finding 2). sweepRuntimes itself now keeps rather than throws, and this catch
// is the backstop for whatever else it might do.
export function sweepSuperseded(backend: RuntimeBackend, root: string, label: string | readonly string[], options: Pick<ResolveRuntimesOptions, "log" | "rm">): void {
  const log = options.log ?? (() => {})
  try {
    const sweep = sweepRuntimes(backend, root, [...(typeof label === "string" ? [label] : label), ...protectedPins(backend, root)], Date.now(), { rm: options.rm })
    for (const retired of sweep.removed) log("info", `runtimes: retired ${retired}`)
    for (const { dir, leases, reason } of sweep.kept) {
      const why = reason ?? `still used by ${leases.map((lease) => `${lease.role} pid ${lease.pid}`).join(", ")}`
      log("info", `runtimes: kept ${dir} — ${why}`)
    }
  } catch (err) {
    log("warn", `runtimes: sweep of superseded ${backend} versions failed (${err instanceof Error ? err.message : String(err)}); the pin is unaffected`)
  }
}

export interface ShouldDeferRuntimesDeps {
  env?: NodeJS.ProcessEnv
  findOpenCode?: (env: NodeJS.ProcessEnv) => string | undefined
  readClaudeAuth?: () => Promise<ProviderAuth>
  readClaudeOther?: (env: NodeJS.ProcessEnv) => boolean
  readCodexAuth?: () => ProviderAuth
}

/** Which backends' runtimes a boot leaves for their first thread. */
export type DeferRuntimes = Record<RuntimeBackend, boolean>

/**
 * Which runtimes should this boot leave for their first thread? Each only on a positive answer, so a
 * machine Frizz cannot read provisions at boot as it always has.
 *
 * CODEX waits whenever Codex is signed out: no auth.json and no key in the environment, the same
 * reader and the same verdict the dispatch gate refuses a Codex thread on (readCodexAuthState). That
 * verdict is final without the binary, so nothing can be starting a Codex thread that this holds up,
 * and signing in later costs the first Codex thread its download, under the composer's toast.
 *
 * CLAUDE CODE waits only with Codex signed out as well and OpenCode on PATH, the machine that has
 * another agent to use and no sign of this one. Its signed-out verdict is NOT final: the gate confirms
 * a local signed-out by starting the CLI, which sees credentials the readers here do not, and a
 * deferred runtime skips that confirmation. A machine wrongly judged signed out is then offered a
 * sign-in that never clears, so this stays as narrow as it was. Widening it to every machine signed in
 * to Codex alone needs the sign-in dialog's re-check to bring the runtime down and ask first.
 */
export async function shouldDeferRuntimes(deps: ShouldDeferRuntimesDeps = {}): Promise<DeferRuntimes> {
  const env = deps.env ?? process.env
  if (env[RUNTIMES_MODE_ENV] === "path") return { claude: false, codex: false }
  if ((deps.readCodexAuth ?? readCodexAuthState)() !== "signed-out") return { claude: false, codex: false }
  const claude =
    Boolean((deps.findOpenCode ?? ((e) => findOnPath("opencode", e)))(env)) &&
    !(deps.readClaudeOther ?? readClaudeOtherCredential)(env) &&
    (await (deps.readClaudeAuth ?? readClaudeAuthState)().catch((): ProviderAuth => "unknown")) === "signed-out"
  return { claude, codex: true }
}

/** Resolve both backends, in parallel. Never throws: the fallback for every failure is PATH. */
export async function resolveRuntimes(options: ResolveRuntimesOptions = {}): Promise<ResolvedRuntimes> {
  const [claude, codex] = await Promise.all([
    resolveOne("claude", options.claudeBin, options),
    resolveOne("codex", options.codexBin, options),
  ])
  return { claude, codex }
}

/** One line per backend for the boot log: what will run, and from where. */
export function describeRuntime(backend: RuntimeBackend, runtime: ResolvedRuntime): string {
  switch (runtime.source) {
    case "provisioned": return `${backend}: ${runtime.version} (provisioned) ${runtime.bin}`
    case "deferred": return `${backend}: ${runtime.version} (on its first thread) ${runtime.bin}`
    case "override": return `${backend}: ${runtime.bin} (explicit)`
    case "path": return `${backend}: ${runtime.bin} from PATH${runtime.note ? ` — ${runtime.note}` : ""}`
  }
}
