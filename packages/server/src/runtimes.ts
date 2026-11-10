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

import { createHash } from "node:crypto"
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
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
import { deferRuntime } from "./runtime-deferral.ts"
import { leaseRuntime, liveRuntimeLeases } from "./runtime-lease.ts"

/** The Claude Agent SDK Frizz bundles. Must equal packages/claude-agent-sdk-runtime's dependency. */
export const CLAUDE_AGENT_SDK_VERSION = "0.3.321"
/** The Claude Code build that SDK was built against — its package.json `claudeCodeVersion`.
 *
 *  Keep this CURRENT when bumping, not merely matched: the first provisioned build (2.1.207, the SDK
 *  Frizz had sat on since July) refused the default model outright — `API Error: 400 Claude Code
 *  2.1.207 does not support this model; version 2.1.251 or newer is required` — because a model's
 *  minimum CLI is enforced server-side. The pin makes Frizz's lag the worker's lag; a stale pin is a
 *  broken worker, not a conservative one. */
export const CLAUDE_CODE_VERSION = "2.1.321"
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

/**
 * Make sure one backend's pin is on disk, fetching it from the registry when it is not.
 *
 * Idempotent and crash-safe: the work happens in a `.partial-<label>-<pid>` sibling and is renamed
 * into place only after the integrity check and the binary lookup both pass. Two servers racing the
 * same pin (a dev child beside a stable one) each build their own partial; the second rename finds the
 * directory already there and simply uses it.
 */
export async function provisionRuntime(backend: RuntimeBackend, options: ProvisionOptions): Promise<Provisioned> {
  const { root, coordinates } = options
  const existing = provisionedBinary(backend, root, coordinates.label)
  if (existing) return { bin: existing, label: coordinates.label, fetched: false }

  const fetchImpl = options.fetch ?? globalThis.fetch
  const registry = options.registry ?? REGISTRY
  const progress = options.onProgress ?? (() => {})
  const backendDir = join(root, backend)
  const finalDir = join(backendDir, coordinates.label)
  const partial = join(backendDir, `.partial-${coordinates.label}-${process.pid}`)
  mkdirSync(backendDir, { recursive: true })
  rmSync(partial, { recursive: true, force: true })
  mkdirSync(partial)

  try {
    const manifestUrl = `${registry}/${coordinates.pkg.replace("/", "%2F")}/${coordinates.packageVersion}`
    progress(`resolving ${coordinates.pkg}@${coordinates.packageVersion}`)
    const manifestResponse = await fetchImpl(manifestUrl)
    if (!manifestResponse.ok) throw new Error(`registry answered ${manifestResponse.status} for ${coordinates.pkg}@${coordinates.packageVersion}`)
    const manifest = (await manifestResponse.json()) as { dist?: { tarball?: string; integrity?: string } }
    const tarball = manifest.dist?.tarball
    const integrity = manifest.dist?.integrity
    if (!tarball || !integrity?.startsWith("sha512-")) throw new Error(`registry manifest for ${coordinates.pkg}@${coordinates.packageVersion} carries no sha512 tarball`)

    const response = await fetchImpl(tarball)
    if (!response.ok || !response.body) throw new Error(`tarball download answered ${response.status}`)
    const total = Number(response.headers.get("content-length") ?? 0)
    const hash = createHash("sha512")
    let seen = 0
    let lastReport = 0
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        seen += chunk.length
        const now = Date.now()
        if (now - lastReport > 500) {
          lastReport = now
          progress(total > 0
            ? `downloading ${describeBytes(total)}, ${Math.min(99, Math.floor((seen / total) * 100))}%`
            : `downloading, ${describeBytes(seen)} so far`)
        }
        callback(null, chunk)
      },
    })
    progress(total > 0 ? `downloading ${describeBytes(total)}` : "downloading")
    // The hash is taken over the COMPRESSED bytes, which is what the registry's integrity names, and
    // the extraction runs on the same pass — so the verdict arrives after the files are written and
    // a mismatch discards the whole partial directory, never a file of it.
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), hasher, createGunzip(), new TarExtractor(partial))
    const digest = `sha512-${hash.digest("base64")}`
    if (digest !== integrity) throw new Error(`integrity mismatch for ${tarball}: expected ${integrity}, got ${digest}`)

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
      return { bin: theirs, label: coordinates.label, fetched: false }
    }
    progress("ready")
    return { bin: join(finalDir, marker.binary), label: coordinates.label, fetched: true }
  } catch (err) {
    rmSync(partial, { recursive: true, force: true })
    throw err
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
  /**
   * Fetch nothing now for these backends: register the pin to come down on its first thread
   * (runtime-deferral.ts). `true` is both of them.
   */
  defer?: boolean | Partial<DeferRuntimes>
  /** Seams for the Windows failure modes (tests): see ProvisionOptions.rename and SweepRuntimesDeps.rm. */
  rename?: ProvisionOptions["rename"]
  rm?: SweepRuntimesDeps["rm"]
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
  const provision = (onProgress: (message: string) => void) => provisionRuntime(backend, {
    root, coordinates, fetch: options.fetch, registry, rename: options.rename, onProgress,
  })
  if (typeof options.defer === "object" ? options.defer[backend] : options.defer) {
    const bin = provisionedBinary(backend, root, coordinates.label) ?? pinnedBinaryPath(backend, root, coordinates)
    deferRuntime(backend, async (onProgress) => {
      const provisioned = await provision(onProgress)
      if (provisioned.fetched) log("info", `runtimes: provisioned ${backend} ${provisioned.label} at ${provisioned.bin}`)
      // The consumers have held `bin` since boot, so a package laid out differently must say so here.
      if (provisioned.bin !== bin) throw new Error(`${coordinates.pkg} unpacked its binary at ${provisioned.bin}, not ${bin}`)
      leaseRuntime(provisioned.bin, "server")
    })
    // A recorded later build is kept for the boot that provisions: this one starts nothing on it.
    const recorded = backend === "claude" ? readClaudeFloat(root, coordinates.label)?.label : undefined
    sweepSuperseded(backend, root, recorded ? [coordinates.label, recorded] : coordinates.label, options)
    return { bin, source: "deferred", version: coordinates.label }
  }
  let provisioned: Provisioned
  try {
    provisioned = await provision((message) => options.onProgress?.(backend, message))
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
  if (floated) return { bin: floated.bin, source: "provisioned", version: floated.label, note: `moved past the bundled ${coordinates.label}` }
  return { bin: provisioned.bin, source: "provisioned", version: provisioned.label }
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
    const sweep = sweepRuntimes(backend, root, label, Date.now(), { rm: options.rm })
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
