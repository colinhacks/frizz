// The provisioner (runtimes.ts) against a LOCAL registry: a real HTTP server serving a real gzipped
// tarball built here, so the download, the integrity check, the extraction, the marker and the sweep
// are all exercised for real — without ever reaching npm. What is NOT covered here is the network
// itself and the vendors' actual tarballs; `nub scripts/provision-runtimes.mjs` does that, on demand.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { after, before, test } from "node:test"
import { gzipSync } from "node:zlib"
import { CODEX_APP_SERVER_SUPPORTED_VERSION } from "./backend/codex-app-server.ts"
import {
  CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION, describeRuntime, extractNpmTarball, pinnedBinaryPath, prepareRuntimes, protectedPins, provisionRuntime,
  provisionedBinary, recordPin, recordPinAhead, resolveRuntimes, runtimeCoordinates, shouldDeferRuntimes, sweepRuntimes, sweepSuperseded,
  type RuntimeCoordinates, type ShouldDeferRuntimesDeps,
} from "./runtimes.ts"
import { ensureRuntime, isRuntimeDeferred, resetDeferredRuntimes, runtimeDownloads } from "./runtime-deferral.ts"
import { leaseRuntime, liveRuntimeLeases, runtimeVersionDir } from "./runtime-lease.ts"

// --- a tiny tar writer, so the fixtures can carry what real tar tools refuse to write (an escaping
// --- path, a symlink beside a file, a GNU long name) -----------------------------------------------

interface Entry { name: string; data?: Buffer; type?: string; mode?: number }

function header(name: string, size: number, type: string, mode: number): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, "utf8")
  block.write(mode.toString(8).padStart(7, "0"), 100, 8, "latin1")
  block.write("0000000", 108, 8, "latin1")
  block.write("0000000", 116, 8, "latin1")
  block.write(size.toString(8).padStart(11, "0"), 124, 12, "latin1")
  block.write("00000000000", 136, 12, "latin1")
  block.write("        ", 148, 8, "latin1")
  block.write(type, 156, 1, "latin1")
  block.write("ustar\0", 257, 6, "latin1")
  block.write("00", 263, 2, "latin1")
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1")
  return block
}

function tarball(entries: Entry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0)
    const type = entry.type ?? "0"
    if (entry.name.length > 100) {
      // GNU long name: an `L` entry whose data is the real name, then the entry under a stub name.
      const long = Buffer.from(`${entry.name}\0`)
      parts.push(header("././@LongLink", long.length, "L", 0o644), long, Buffer.alloc((512 - (long.length % 512)) % 512))
      parts.push(header(entry.name.slice(0, 100), data.length, type, entry.mode ?? 0o644))
    } else {
      parts.push(header(entry.name, data.length, type, entry.mode ?? 0o644))
    }
    if (type === "0") parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

const integrityOf = (bytes: Buffer): string => `sha512-${createHash("sha512").update(bytes).digest("base64")}`

// --- a local registry ---------------------------------------------------------------------------------

interface Registry {
  url: string
  requests: string[]
  set(pkg: string, version: string, tgz: Buffer, integrity?: string): void
  remove(pkg: string, version: string): void
}

let server: Server
let registry: Registry

before(async () => {
  const packages = new Map<string, { tgz: Buffer; integrity: string }>()
  const requests: string[] = []
  server = createServer((req, res) => {
    requests.push(req.url ?? "")
    const tgz = /^\/tgz\/(.+)$/u.exec(req.url ?? "")
    if (tgz) {
      const hit = packages.get(decodeURIComponent(tgz[1]!))
      if (!hit) { res.statusCode = 404; res.end(); return }
      res.setHeader("content-length", String(hit.tgz.length))
      res.end(hit.tgz)
      return
    }
    const manifest = /^\/([^/]+)\/([^/]+)$/u.exec(req.url ?? "")
    const key = manifest ? `${decodeURIComponent(manifest[1]!)}@${manifest[2]}` : ""
    const hit = packages.get(key)
    if (!hit) { res.statusCode = key.includes("boom") ? 500 : 404; res.end(); return }
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ dist: { tarball: `${registry.url}/tgz/${encodeURIComponent(key)}`, integrity: hit.integrity } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  registry = {
    url: `http://127.0.0.1:${port}`,
    requests,
    set: (pkg, version, tgz, integrity = integrityOf(tgz)) => packages.set(`${pkg}@${version}`, { tgz, integrity }),
    remove: (pkg, version) => packages.delete(`${pkg}@${version}`),
  }
})

after(() => server.close())

const claudeCoords: RuntimeCoordinates = { pkg: "@anthropic-ai/claude-agent-sdk-darwin-arm64", packageVersion: CLAUDE_AGENT_SDK_VERSION, label: CLAUDE_CODE_VERSION, binary: "claude" }
const codexCoords: RuntimeCoordinates = { pkg: "@openai/codex", packageVersion: "0.169.1-darwin-arm64", label: "0.169.1", binary: "codex" }

const claudeTgz = tarball([
  { name: "package/package.json", data: Buffer.from('{"name":"stub"}') },
  { name: "package/claude", data: Buffer.from("#!/bin/sh\necho stub-claude\n"), mode: 0o755 },
])

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "frizz-runtimes-"))
  return dir
}

// --- the pins ---------------------------------------------------------------------------------------

test("the Claude pin is the SDK Frizz bundles, and the CLI that SDK was built against", () => {
  // The runtime package names the SDK version; the SDK's own package.json names its Claude Code.
  // Both are pinned here so a bump of one without the other fails instead of drifting.
  const runtimePkg = JSON.parse(readFileSync(new URL("../../claude-agent-sdk-runtime/package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> }
  assert.equal(runtimePkg.dependencies["@anthropic-ai/claude-agent-sdk"], CLAUDE_AGENT_SDK_VERSION)
  const sdkDir = new URL(`../../claude-agent-sdk-runtime/node_modules/@anthropic-ai/claude-agent-sdk/package.json`, import.meta.url)
  const sdkPkg = JSON.parse(readFileSync(sdkDir, "utf8")) as { version: string; claudeCodeVersion: string }
  assert.equal(sdkPkg.version, CLAUDE_AGENT_SDK_VERSION)
  assert.equal(sdkPkg.claudeCodeVersion, CLAUDE_CODE_VERSION)
})

test("coordinates: one npm package per platform, the audited Codex version, .exe on Windows", () => {
  assert.deepEqual(runtimeCoordinates("claude", "darwin", "arm64", false), claudeCoords)
  assert.deepEqual(runtimeCoordinates("claude", "linux", "x64", true), { ...claudeCoords, pkg: "@anthropic-ai/claude-agent-sdk-linux-x64-musl" })
  assert.deepEqual(runtimeCoordinates("claude", "win32", "x64", false), { ...claudeCoords, pkg: "@anthropic-ai/claude-agent-sdk-win32-x64", binary: "claude.exe" })
  assert.deepEqual(runtimeCoordinates("codex", "darwin", "arm64", false), { ...codexCoords, packageVersion: `${CODEX_APP_SERVER_SUPPORTED_VERSION}-darwin-arm64`, label: CODEX_APP_SERVER_SUPPORTED_VERSION })
  // Codex ships one Linux build (musl) — the flag changes nothing for it.
  assert.equal(runtimeCoordinates("codex", "linux", "arm64", true)?.packageVersion, `${CODEX_APP_SERVER_SUPPORTED_VERSION}-linux-arm64`)
  assert.equal(runtimeCoordinates("claude", "freebsd", "x64", false), undefined)
  assert.equal(runtimeCoordinates("codex", "linux", "ia32", false), undefined)
})

// --- the extractor ----------------------------------------------------------------------------------

test("extractor: strips package/, keeps modes, follows a GNU long name, refuses escapes and links", async () => {
  const dest = scratch()
  const longName = `package/${"deep/".repeat(30)}file.txt`
  const tgz = tarball([
    { name: "package/", type: "5" },
    { name: "package/bin/", type: "5" },
    { name: "package/bin/tool", data: Buffer.from("tool"), mode: 0o755 },
    { name: "package/README.md", data: Buffer.from("readme") },
    { name: longName, data: Buffer.from("long") },
    { name: "package/../escape.txt", data: Buffer.from("escaped") },
    { name: "package/link", type: "2" },
    { name: "loose.txt", data: Buffer.from("no package prefix") },
  ])
  const written = await extractNpmTarball(Readable.from([tgz]), dest)
  assert.equal(readFileSync(join(dest, "bin", "tool"), "utf8"), "tool")
  assert.equal(readFileSync(join(dest, "README.md"), "utf8"), "readme")
  assert.equal(readFileSync(join(dest, ...longName.split("/").slice(1)), "utf8"), "long")
  if (process.platform !== "win32") assert.equal(statSync(join(dest, "bin", "tool")).mode & 0o111, 0o111)
  assert.equal(existsSync(join(dest, "..", "escape.txt")), false)
  assert.equal(existsSync(join(dest, "escape.txt")), false)
  assert.equal(existsSync(join(dest, "link")), false)
  assert.equal(existsSync(join(dest, "loose.txt")), false)
  assert.equal(written.length, 3)
  rmSync(dest, { recursive: true, force: true })
})

// --- provisioning -----------------------------------------------------------------------------------

test("provision: downloads once, verifies, lands the binary under the label, then reads the marker", async () => {
  const root = scratch()
  registry.set(claudeCoords.pkg, claudeCoords.packageVersion, claudeTgz)
  const messages: string[] = []
  const before = registry.requests.length
  const first = await provisionRuntime("claude", { root, coordinates: claudeCoords, registry: registry.url, onProgress: (m) => messages.push(m) })
  assert.equal(first.fetched, true)
  assert.equal(first.bin, join(root, "claude", CLAUDE_CODE_VERSION, "claude"))
  assert.equal(readFileSync(first.bin, "utf8").includes("stub-claude"), true)
  if (process.platform !== "win32") assert.equal(statSync(first.bin).mode & 0o111, 0o111)
  const marker = JSON.parse(readFileSync(join(root, "claude", CLAUDE_CODE_VERSION, "provisioned.json"), "utf8")) as Record<string, string>
  assert.equal(marker.integrity, integrityOf(claudeTgz))
  assert.equal(marker.binary, "claude")
  assert.equal(registry.requests.length - before, 2, "one manifest read and one tarball download")
  assert.ok(messages.some((m) => m.startsWith("downloading")), messages.join(" | "))
  assert.equal(messages.at(-1), "ready")
  assert.equal(existsSync(join(root, "claude", `.partial-${CLAUDE_CODE_VERSION}-${process.pid}`)), false)

  const second = await provisionRuntime("claude", { root, coordinates: claudeCoords, registry: registry.url })
  assert.equal(second.fetched, false)
  assert.equal(second.bin, first.bin)
  assert.equal(registry.requests.length - before, 2, "the second call reads the marker and fetches nothing")
  assert.equal(provisionedBinary("claude", root, CLAUDE_CODE_VERSION), first.bin)
  rmSync(root, { recursive: true, force: true })
})

test("provision: the Codex package's vendor/<triple>/bin layout is found, siblings and all", async () => {
  const root = scratch()
  const tgz = tarball([
    { name: "package/package.json", data: Buffer.from("{}") },
    { name: "package/vendor/aarch64-apple-darwin/bin/codex", data: Buffer.from("codex"), mode: 0o755 },
    { name: "package/vendor/aarch64-apple-darwin/bin/codex-code-mode-host", data: Buffer.from("host"), mode: 0o755 },
    { name: "package/vendor/aarch64-apple-darwin/codex-path/rg", data: Buffer.from("rg"), mode: 0o755 },
  ])
  registry.set(codexCoords.pkg, codexCoords.packageVersion, tgz)
  const got = await provisionRuntime("codex", { root, coordinates: codexCoords, registry: registry.url })
  // Off codexCoords.label rather than a repeated literal: these are assertions ABOUT that coordinate,
  // so they must move with the pin. Three copies of the version had to be hand-edited on the 0.153.4
  // bump, which is three chances to leave one behind and assert against a directory nothing writes.
  assert.equal(got.bin, join(root, "codex", codexCoords.label, "vendor", "aarch64-apple-darwin", "bin", "codex"))
  assert.ok(existsSync(join(root, "codex", codexCoords.label, "vendor", "aarch64-apple-darwin", "codex-path", "rg")))
  const marker = JSON.parse(readFileSync(join(root, "codex", codexCoords.label, "provisioned.json"), "utf8")) as { binary: string }
  assert.equal(marker.binary, join("vendor", "aarch64-apple-darwin", "bin", "codex"))
  rmSync(root, { recursive: true, force: true })
})

test("provision: an integrity mismatch discards everything and leaves no pin behind", async () => {
  const root = scratch()
  registry.set(claudeCoords.pkg, claudeCoords.packageVersion, claudeTgz, integrityOf(Buffer.from("something else")))
  await assert.rejects(
    provisionRuntime("claude", { root, coordinates: claudeCoords, registry: registry.url }),
    /integrity mismatch/u,
  )
  assert.equal(existsSync(join(root, "claude", CLAUDE_CODE_VERSION)), false)
  assert.deepEqual(readdirSync(join(root, "claude")), [], "no partial survives a failed download")
  rmSync(root, { recursive: true, force: true })
})

test("provision: a package that unpacks without its binary is refused", async () => {
  const root = scratch()
  registry.set(claudeCoords.pkg, claudeCoords.packageVersion, tarball([{ name: "package/package.json", data: Buffer.from("{}") }]))
  await assert.rejects(provisionRuntime("claude", { root, coordinates: claudeCoords, registry: registry.url }), /without a claude binary/u)
  assert.equal(existsSync(join(root, "claude", CLAUDE_CODE_VERSION)), false)
  rmSync(root, { recursive: true, force: true })
})

test("sweep: retires the other versions and a stale partial, keeps the pin and a fresh partial", () => {
  const root = scratch()
  for (const label of [CLAUDE_CODE_VERSION, "2.1.180", ".partial-2.1.207-1", ".partial-2.1.207-2"]) {
    mkdirSync(join(root, "claude", label), { recursive: true })
    writeFileSync(join(root, "claude", label, "x"), "")
  }
  const old = Date.now() - 2 * 24 * 60 * 60 * 1000
  utimesSync(join(root, "claude", ".partial-2.1.207-1"), old / 1000, old / 1000)
  const sweep = sweepRuntimes("claude", root, CLAUDE_CODE_VERSION)
  assert.deepEqual(sweep.removed.map((p) => p.slice(root.length + 1)).sort(), [join("claude", ".partial-2.1.207-1"), join("claude", "2.1.180")])
  assert.deepEqual(sweep.kept, [])
  assert.ok(existsSync(join(root, "claude", CLAUDE_CODE_VERSION)))
  assert.ok(existsSync(join(root, "claude", ".partial-2.1.207-2")))
  assert.deepEqual(sweepRuntimes("codex", root, codexCoords.label), { removed: [], kept: [] }, "a backend with no directory sweeps nothing")
  rmSync(root, { recursive: true, force: true })
})

test("provision: the final rename survives a transient EPERM (Windows audit 2026-09-11, finding 3)", async () => {
  // Defender's real-time scan briefly holds a handle on a new executable; MoveFileEx on the directory
  // then fails EPERM once. That is a retry, not "someone else finished first".
  const root = scratch()
  registry.set(claudeCoords.pkg, claudeCoords.packageVersion, claudeTgz)
  let attempts = 0
  const flaky = (from: string, to: string) => {
    attempts++
    if (attempts === 1) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" })
    renameSync(from, to)
  }
  const got = await provisionRuntime("claude", { root, coordinates: claudeCoords, registry: registry.url, rename: flaky, retryDelayMs: 1 })
  assert.equal(attempts, 2)
  assert.equal(got.fetched, true)
  assert.equal(got.bin, join(root, "claude", CLAUDE_CODE_VERSION, "claude"))
  assert.ok(existsSync(got.bin))
  assert.deepEqual(readdirSync(join(root, "claude")), [CLAUDE_CODE_VERSION], "no partial left behind")

  // Control: a handle that never lets go, with no pin to fall back on, is still the error — and
  // EEXIST (the genuine race) is not retried at all.
  const stuck = scratch()
  let stuckAttempts = 0
  await assert.rejects(
    provisionRuntime("claude", { root: stuck, coordinates: claudeCoords, registry: registry.url, retryDelayMs: 1, rename: () => { stuckAttempts++; throw Object.assign(new Error("EPERM"), { code: "EPERM" }) } }),
    /EPERM/u,
  )
  assert.equal(stuckAttempts, 5)
  // The unpacked directory goes with the error. The verified tarball stays, so the next try unpacks it
  // again instead of fetching it again.
  assert.deepEqual(readdirSync(join(stuck, "claude")), [`.partial-${CLAUDE_CODE_VERSION}.tgz`], "only the resumable tarball outlives the error")
  let eexist = 0
  await assert.rejects(
    provisionRuntime("claude", { root: stuck, coordinates: claudeCoords, registry: registry.url, retryDelayMs: 1, rename: () => { eexist++; throw Object.assign(new Error("EEXIST"), { code: "EEXIST" }) } }),
    /EEXIST/u,
  )
  assert.equal(eexist, 1)
  rmSync(root, { recursive: true, force: true })
  rmSync(stuck, { recursive: true, force: true })
})

// A provisioned version directory as provisionRuntime leaves it: the marker plus the binary it names.
function provisionedDir(root: string, backend: "claude" | "codex", label: string, binary: string): string {
  const dir = join(root, backend, label)
  mkdirSync(join(dir, binary, ".."), { recursive: true })
  writeFileSync(join(dir, binary), "")
  writeFileSync(join(dir, "provisioned.json"), JSON.stringify({ backend, label, binary }))
  return dir
}

test("sweep: a superseded version a live process leases is kept and reported, not retired", () => {
  // The 2026-09-10 failure: a newer pin's boot swept the directory the running server still forked from.
  const root = scratch()
  const old = provisionedDir(root, "claude", "2.1.267", "claude")
  provisionedDir(root, "claude", CLAUDE_CODE_VERSION, "claude")
  const release = leaseRuntime(join(old, "claude"), "server")
  const sweep = sweepRuntimes("claude", root, CLAUDE_CODE_VERSION)
  assert.deepEqual(sweep.removed, [])
  assert.deepEqual(sweep.kept, [{ dir: old, leases: [{ pid: process.pid, role: "server" }] }])
  assert.ok(existsSync(join(old, "claude")), "the leased binary survives")
  // Released: the next sweep retires it.
  release()
  assert.deepEqual(sweepRuntimes("claude", root, CLAUDE_CODE_VERSION), { removed: [old], kept: [] })
  rmSync(root, { recursive: true, force: true })
})

test("sweep: a lease whose holder is dead is pruned and the directory retired", () => {
  const root = scratch()
  const old = provisionedDir(root, "claude", "2.1.267", "claude")
  provisionedDir(root, "claude", CLAUDE_CODE_VERSION, "claude")
  // Beyond any pid the kernel hands out (pid_max is 99999 on macOS, 4194304 on Linux by default), and
  // a corrupt lease beside it: both must count as "nobody".
  mkdirSync(join(old, ".leases"))
  writeFileSync(join(old, ".leases", "4194303.json"), JSON.stringify({ pid: 4194303, role: "server", bin: join(old, "claude"), at: "" }))
  writeFileSync(join(old, ".leases", "torn.json"), "{")
  assert.deepEqual(liveRuntimeLeases(old), [])
  assert.equal(existsSync(join(old, ".leases", "4194303.json")), false, "a dead holder's lease is pruned on read")
  assert.deepEqual(sweepRuntimes("claude", root, CLAUDE_CODE_VERSION), { removed: [old], kept: [] })
  rmSync(root, { recursive: true, force: true })
})

test("lease: the version directory is found from either layout, and a PATH bin gets no lease", () => {
  const root = scratch()
  const claude = provisionedDir(root, "claude", "2.1.267", "claude")
  const codex = provisionedDir(root, "codex", "0.169.1", join("vendor", "aarch64-apple-darwin", "bin", "codex"))
  assert.equal(runtimeVersionDir(join(claude, "claude")), claude)
  assert.equal(runtimeVersionDir(join(codex, "vendor", "aarch64-apple-darwin", "bin", "codex")), codex)
  const stray = join(root, "elsewhere", "claude")
  mkdirSync(join(root, "elsewhere"))
  writeFileSync(stray, "")
  assert.equal(runtimeVersionDir(stray), undefined)
  leaseRuntime(stray, "server")()
  assert.deepEqual(readdirSync(join(root, "elsewhere")), ["claude"], "no .leases directory appears beside an unprovisioned bin")
  rmSync(root, { recursive: true, force: true })
})

test("sweep: a version the OS refuses to remove is kept and named, and the sweep goes on", () => {
  // Windows cannot delete a claude.exe some daemon still runs (EBUSY/EPERM), lease or no lease —
  // a daemon from before the leases existed writes none. Windows audit 2026-09-11, finding 2.
  const root = scratch()
  const busy = provisionedDir(root, "claude", "2.1.267", "claude")
  const stale = provisionedDir(root, "claude", "2.1.180", "claude")
  provisionedDir(root, "claude", CLAUDE_CODE_VERSION, "claude")
  const asked: string[] = []
  const rm = (path: string) => {
    asked.push(path)
    if (path === busy) throw Object.assign(new Error("EBUSY: resource busy or locked, rmdir"), { code: "EBUSY" })
    rmSync(path, { recursive: true, force: true })
  }
  const sweep = sweepRuntimes("claude", root, CLAUDE_CODE_VERSION, Date.now(), { rm })
  assert.deepEqual(sweep.removed, [stale])
  assert.deepEqual(sweep.kept, [{ dir: busy, leases: [], reason: "in use (EBUSY)" }])
  assert.deepEqual(asked.sort(), [stale, busy].sort(), "the refusal did not stop the other entry's removal")
  assert.ok(existsSync(join(busy, "claude")))
  // Any other refusal is kept too, with the message rather than the code.
  const odd = sweepRuntimes("claude", root, CLAUDE_CODE_VERSION, Date.now(), { rm: () => { throw new Error("disk on fire") } })
  assert.deepEqual(odd.kept, [{ dir: busy, leases: [], reason: "could not remove: disk on fire" }])
  rmSync(root, { recursive: true, force: true })
})

// --- resolution -------------------------------------------------------------------------------------

test("resolve: an explicit executable wins and provisions nothing; FRIZZ_RUNTIMES=path skips it too", async () => {
  const root = scratch()
  const before = registry.requests.length
  const explicit = await resolveRuntimes({ claudeBin: "/opt/claude", env: { FRIZZ_CODEX_BIN: "/opt/codex" }, root, registry: registry.url })
  assert.deepEqual(explicit.claude, { bin: "/opt/claude", source: "override", version: "unknown" })
  assert.deepEqual(explicit.codex, { bin: "/opt/codex", source: "override", version: "unknown" })
  const path = await resolveRuntimes({ env: { FRIZZ_RUNTIMES: "path" }, root, registry: registry.url })
  assert.equal(path.claude.source, "path")
  assert.equal(path.claude.bin, "claude")
  assert.equal(path.codex.bin, "codex")
  assert.equal(registry.requests.length, before, "neither shape touched the registry")
  assert.equal(describeRuntime("claude", explicit.claude), "claude: /opt/claude (explicit)")
  assert.equal(describeRuntime("codex", path.codex), "codex: codex from PATH — FRIZZ_RUNTIMES=path")
  rmSync(root, { recursive: true, force: true })
})

test("resolve: provisions both in parallel, and a backend the registry cannot serve falls back to PATH with the reason", async () => {
  const root = scratch()
  // Real coordinates come from process.platform; this test runs wherever the suite runs, so the
  // registry has to answer for THIS platform's package names.
  const claude = runtimeCoordinates("claude")!
  const codex = runtimeCoordinates("codex")!
  registry.set(claude.pkg, claude.packageVersion, tarball([{ name: `package/${claude.binary}`, data: Buffer.from("claude"), mode: 0o755 }]))
  // Codex is deliberately NOT registered (an earlier test may have put this platform's package in): the
  // manifest read 404s.
  registry.remove(codex.pkg, codex.packageVersion)
  const log: string[] = []
  const got = await resolveRuntimes({ env: {}, root, registry: registry.url, log: (level, message) => log.push(`${level}: ${message}`) })
  assert.equal(got.claude.source, "provisioned")
  assert.equal(got.claude.version, claude.label)
  assert.equal(got.claude.bin, join(root, "claude", claude.label, claude.binary))
  assert.equal(got.codex.source, "path")
  assert.equal(got.codex.bin, "codex")
  assert.match(got.codex.note ?? "", /registry answered 404/u)
  assert.ok(log.some((line) => line.startsWith("info: runtimes: provisioned claude")), log.join("\n"))
  assert.ok(log.some((line) => line.startsWith("warn: runtimes: could not provision codex")), log.join("\n"))
  assert.equal(describeRuntime("claude", got.claude), `claude: ${claude.label} (provisioned) ${got.claude.bin}`)
  rmSync(root, { recursive: true, force: true })
})

test("resolve: a sweep the OS refuses never discards the provisioned pin (Windows audit 2026-09-11, finding 2)", async () => {
  // Until 2026-09-11 the sweep shared the pin's `try`: an EBUSY on a mapped claude.exe fell through to
  // `{ bin: "claude", source: "path" }`, and the boot then depended on an npm claude that may not exist.
  const root = scratch()
  const claude = runtimeCoordinates("claude")!
  registry.set(claude.pkg, claude.packageVersion, tarball([{ name: `package/${claude.binary}`, data: Buffer.from("claude"), mode: 0o755 }]))
  registry.remove(runtimeCoordinates("codex")!.pkg, runtimeCoordinates("codex")!.packageVersion)
  const old = provisionedDir(root, "claude", "2.1.267", claude.binary)
  const log: string[] = []
  const got = await resolveRuntimes({
    env: {}, root, registry: registry.url, log: (level, message) => log.push(`${level}: ${message}`),
    rm: () => { throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }) },
  })
  assert.equal(got.claude.source, "provisioned")
  assert.equal(got.claude.bin, join(root, "claude", claude.label, claude.binary))
  assert.ok(existsSync(old), "the refused directory is still there")
  assert.ok(log.includes(`info: runtimes: kept ${old} — in use (EBUSY)`), log.join("\n"))
  assert.ok(!log.some((line) => line.includes("could not provision claude")), log.join("\n"))
  rmSync(root, { recursive: true, force: true })
})

// --- a runtime that waits for its first thread -------------------------------------------------------

const signedOutEverywhere: ShouldDeferRuntimesDeps = {
  env: {},
  findOpenCode: () => "/usr/local/bin/opencode",
  readClaudeAuth: async () => "signed-out",
  readClaudeOther: () => false,
  readCodexAuth: () => "signed-out",
}

test("defer: Codex whenever Codex is signed out, and Claude Code only signed out of both with OpenCode on PATH", async () => {
  assert.deepEqual(await shouldDeferRuntimes(signedOutEverywhere), { claude: true, codex: true })
  // The machine that only uses Claude, which is most of them: no Codex download, at boot or at a pin.
  const codexOnly: Array<[string, ShouldDeferRuntimesDeps]> = [
    ["signed in to Claude", { readClaudeAuth: async () => "authed" }],
    ["signed in to Claude, with no OpenCode", { readClaudeAuth: async () => "authed", findOpenCode: () => undefined }],
    ["signed out of both, with no OpenCode", { findOpenCode: () => undefined }],
    ["a Claude credential the readers cannot see", { readClaudeOther: () => true }],
    ["Claude auth unreadable", { readClaudeAuth: async () => "unknown" }],
    ["Claude auth threw", { readClaudeAuth: async () => { throw new Error("security timed out") } }],
  ]
  for (const [name, change] of codexOnly) assert.deepEqual(await shouldDeferRuntimes({ ...signedOutEverywhere, ...change }), { claude: false, codex: true }, name)
  // Claude Code never waits on a machine that can use Codex: its signed-out verdict needs its own CLI.
  const neither: Array<[string, ShouldDeferRuntimesDeps]> = [
    ["signed in to Codex", { readCodexAuth: () => "authed" }],
    ["Codex auth unreadable", { readCodexAuth: () => "unknown" }],
    ["the test runner's FRIZZ_RUNTIMES=path", { env: { FRIZZ_RUNTIMES: "path" } }],
  ]
  for (const [name, change] of neither) assert.deepEqual(await shouldDeferRuntimes({ ...signedOutEverywhere, ...change }), { claude: false, codex: false }, name)
})

test("defer: with Codex alone waiting, boot fetches Claude Code and asks the registry nothing about Codex", async (t) => {
  t.after(resetDeferredRuntimes)
  const root = scratch()
  const claude = runtimeCoordinates("claude")!
  const codex = runtimeCoordinates("codex")!
  const triple = pinnedBinaryPath("codex", root, codex).split("/").at(-3)!
  registry.set(claude.pkg, claude.packageVersion, tarball([{ name: `package/${claude.binary}`, data: Buffer.from("#!/bin/sh\n"), mode: 0o755 }]))
  registry.set(codex.pkg, codex.packageVersion, tarball([{ name: `package/vendor/${triple}/bin/${codex.binary}`, data: Buffer.from("#!/bin/sh\n"), mode: 0o755 }]))
  const before = registry.requests.length
  const got = await resolveRuntimes({ env: {}, root, registry: registry.url, defer: { claude: false, codex: true } })
  const asked = registry.requests.slice(before)

  assert.equal(got.claude.source, "provisioned")
  assert.equal(existsSync(got.claude.bin), true, "Claude Code is ready at boot, as it always was")
  assert.equal(isRuntimeDeferred("claude"), false)
  assert.equal(got.codex.source, "deferred")
  assert.equal(got.codex.version, codex.label)
  assert.equal(isRuntimeDeferred("codex"), true)
  assert.equal(existsSync(join(root, "codex", codex.label)), false)
  assert.ok(asked.length > 0 && asked.every((url) => !url.includes("codex")), asked.join("\n"))

  await ensureRuntime("codex")
  assert.equal(existsSync(got.codex.bin), true, "signing in later costs the first Codex thread its download")
  assert.equal(isRuntimeDeferred("codex"), false)
  rmSync(root, { recursive: true, force: true })
})

test("defer: boot touches no registry, and the first need brings down exactly that backend at the path everyone holds", async (t) => {
  t.after(resetDeferredRuntimes)
  const root = scratch()
  const claude = runtimeCoordinates("claude")!
  const codex = runtimeCoordinates("codex")!
  const triple = pinnedBinaryPath("codex", root, codex).split("/").at(-3)!
  registry.set(claude.pkg, claude.packageVersion, tarball([{ name: `package/${claude.binary}`, data: Buffer.from("#!/bin/sh\n"), mode: 0o755 }]))
  registry.set(codex.pkg, codex.packageVersion, tarball([{ name: `package/vendor/${triple}/bin/${codex.binary}`, data: Buffer.from("#!/bin/sh\n"), mode: 0o755 }]))
  const before = registry.requests.length
  const log: string[] = []
  const got = await resolveRuntimes({ env: {}, root, registry: registry.url, defer: true, log: (level, message) => log.push(`${level}: ${message}`) })

  assert.equal(registry.requests.length, before, "boot asked the registry for nothing")
  assert.equal(existsSync(join(root, "claude", claude.label)), false)
  assert.equal(got.claude.source, "deferred")
  assert.equal(got.claude.version, claude.label, "the pin is known, so the Codex catalogue gate keeps its version")
  assert.equal(got.claude.bin, join(root, "claude", claude.label, claude.binary))
  assert.equal(isRuntimeDeferred("claude"), true)
  assert.equal(isRuntimeDeferred("codex"), true)
  assert.match(describeRuntime("claude", got.claude), /on its first thread/u)

  await Promise.all([ensureRuntime("claude"), ensureRuntime("claude")])
  assert.equal(registry.requests.filter((url) => url.includes("claude-agent-sdk") && !url.endsWith(".tgz")).length >= 1, true)
  assert.equal(existsSync(got.claude.bin), true, "the pin landed where the consumers already point")
  assert.equal(provisionedBinary("claude", root, claude.label), got.claude.bin)
  assert.equal(isRuntimeDeferred("claude"), false)
  assert.equal(isRuntimeDeferred("codex"), true, "Claude's first thread leaves Codex waiting")
  assert.equal(existsSync(join(root, "codex", codex.label)), false)
  assert.ok(liveRuntimeLeases(join(root, "claude", claude.label)).length > 0, "a pin in use is leased")

  await ensureRuntime("codex")
  assert.equal(existsSync(got.codex.bin), true, "the triple named at boot is the one the package carries")
  assert.equal(provisionedBinary("codex", root, codex.label), got.codex.bin)
  assert.ok(log.some((line) => line.startsWith("info: runtimes: provisioned codex")), log.join("\n"))
  await ensureRuntime("codex") // no longer waiting: returns at once
  rmSync(root, { recursive: true, force: true })
})

test("defer: a failed download rejects, leaves the backend waiting, and the next attempt succeeds", async (t) => {
  t.after(resetDeferredRuntimes)
  const root = scratch()
  const claude = runtimeCoordinates("claude")!
  const good = tarball([{ name: `package/${claude.binary}`, data: Buffer.from("#!/bin/sh\n"), mode: 0o755 }])
  registry.set(claude.pkg, claude.packageVersion, good, integrityOf(Buffer.from("not this")))
  await resolveRuntimes({ env: {}, root, registry: registry.url, defer: true })
  await assert.rejects(ensureRuntime("claude"), /integrity mismatch/u)
  assert.equal(isRuntimeDeferred("claude"), true)
  assert.deepEqual(runtimeDownloads(), {}, "a finished attempt reports no progress")
  registry.set(claude.pkg, claude.packageVersion, good)
  await ensureRuntime("claude")
  assert.equal(isRuntimeDeferred("claude"), false)
  rmSync(root, { recursive: true, force: true })
})

test("defer: a package laid out differently from the path the consumers hold is refused by name", async (t) => {
  t.after(resetDeferredRuntimes)
  const root = scratch()
  const codex = runtimeCoordinates("codex")!
  registry.set(codex.pkg, codex.packageVersion, tarball([{ name: `package/vendor/some-other-triple/bin/${codex.binary}`, data: Buffer.from("x"), mode: 0o755 }]))
  await resolveRuntimes({ env: {}, root, registry: registry.url, defer: true })
  await assert.rejects(ensureRuntime("codex"), /unpacked its binary at/u)
  rmSync(root, { recursive: true, force: true })
})

test("defer: a pin an earlier server left on disk is still not run until its first thread", async (t) => {
  t.after(resetDeferredRuntimes)
  const root = scratch()
  const claude = runtimeCoordinates("claude")!
  registry.set(claude.pkg, claude.packageVersion, tarball([{ name: `package/${claude.binary}`, data: Buffer.from("#!/bin/sh\n"), mode: 0o755 }]))
  await provisionRuntime("claude", { root, coordinates: claude, registry: registry.url })
  const before = registry.requests.length
  const got = await resolveRuntimes({ env: {}, root, registry: registry.url, defer: true })
  assert.equal(got.claude.source, "deferred")
  assert.equal(got.claude.bin, provisionedBinary("claude", root, claude.label))
  assert.equal(isRuntimeDeferred("claude"), true)
  await ensureRuntime("claude")
  assert.equal(registry.requests.length, before, "nothing to fetch")
  rmSync(root, { recursive: true, force: true })
})

test("the Codex triple is the package's on every published platform", () => {
  const coords = runtimeCoordinates("codex", "linux", "x64", false)!
  const tail = (platform: NodeJS.Platform, arch: string) => pinnedBinaryPath("codex", "/r", coords, platform, arch).split("/").slice(-3, -2)[0]
  assert.equal(tail("darwin", "arm64"), "aarch64-apple-darwin")
  assert.equal(tail("darwin", "x64"), "x86_64-apple-darwin")
  assert.equal(tail("linux", "x64"), "x86_64-unknown-linux-musl")
  assert.equal(tail("linux", "arm64"), "aarch64-unknown-linux-musl")
  assert.equal(tail("win32", "x64"), "x86_64-pc-windows-msvc")
  assert.equal(tail("win32", "arm64"), "aarch64-pc-windows-msvc")
})

// --- a registry that misbehaves the way slow networks do ------------------------------------------
//
// It answers Range requests the way npm's CDN does (206 with a Content-Range), and each tarball request
// is handed to `behave`, which decides how much of the body to send and whether to cut or stall after.

interface FlakyRegistry {
  url: string
  ranges: Array<string | undefined>
  close(): Promise<void>
}

async function flakyRegistry(pkg: string, version: string, tgz: Buffer, behave: (request: number) => { send: number; then: "end" | "cut" | "stall" }): Promise<FlakyRegistry> {
  const ranges: Array<string | undefined> = []
  const open = new Set<import("node:net").Socket>()
  const server = createServer((req, res) => {
    if (req.url === `/${pkg.replace("/", "%2F")}/${version}`) {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ dist: { tarball: `${flaky.url}/tgz`, integrity: integrityOf(tgz) } }))
      return
    }
    const range = req.headers.range
    ranges.push(range)
    const start = range ? Number(/^bytes=(\d+)-$/u.exec(range)?.[1] ?? 0) : 0
    if (start >= tgz.length) { res.statusCode = 416; res.end(); return }
    const plan = behave(ranges.length)
    const body = tgz.subarray(start)
    res.statusCode = range ? 206 : 200
    if (range) res.setHeader("content-range", `bytes ${start}-${tgz.length - 1}/${tgz.length}`)
    res.setHeader("content-length", String(body.length))
    res.flushHeaders()
    res.write(body.subarray(0, Math.min(plan.send, body.length)))
    if (plan.then === "end" || plan.send >= body.length) res.end(body.subarray(Math.min(plan.send, body.length)))
    else if (plan.then === "cut") setTimeout(() => res.socket?.destroy(), 20)
    // "stall": leave the response open and silent until the client gives up on it.
  })
  server.on("connection", (socket) => { open.add(socket); socket.on("close", () => open.delete(socket)) })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const flaky: FlakyRegistry = {
    url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
    ranges,
    close: () => new Promise<void>((resolve) => { for (const socket of open) socket.destroy(); server.close(() => resolve()) }),
  }
  return flaky
}

/** A tarball big enough to cut in the middle of: the binary is incompressible bytes. */
function bulkyClaudeTgz(): Buffer {
  return tarball([
    { name: "package/package.json", data: Buffer.from('{"name":"stub"}') },
    { name: "package/claude", data: Buffer.from("#!/bin/sh\necho bulky\n"), mode: 0o755 },
    { name: "package/payload.bin", data: Buffer.from(Array.from({ length: 400_000 }, (_, i) => (i * 7919) % 251)) },
  ])
}

const fast = { stallReconnectMs: 300, stallGiveUpMs: 60_000, backoffMs: () => 10 }

test("provision: a connection cut mid-download resumes with a Range from the byte it stopped at", async () => {
  const root = scratch()
  const tgz = bulkyClaudeTgz()
  const half = Math.floor(tgz.length / 2)
  const flaky = await flakyRegistry(claudeCoords.pkg, claudeCoords.packageVersion, tgz, (n) => n === 1 ? { send: half, then: "cut" } : { send: Infinity, then: "end" })
  const downloads: Array<{ state: string; received: number; total: number; resumedFrom?: number }> = []
  const got = await provisionRuntime("claude", { root, coordinates: claudeCoords, registry: flaky.url, ...fast, onDownload: (d) => downloads.push(d) })
  assert.equal(got.fetched, true)
  assert.ok(existsSync(got.bin))
  assert.equal(flaky.ranges.length, 2, "one cut request and one resumed request")
  assert.equal(flaky.ranges[0], undefined, "the first request asks for the whole tarball")
  const resumedAt = Number(/^bytes=(\d+)-$/u.exec(flaky.ranges[1] ?? "")?.[1])
  assert.ok(resumedAt > 0 && resumedAt <= half, `the second asks for the rest, from ${resumedAt} (cut at ${half})`)
  assert.deepEqual(readdirSync(join(root, "claude")), [CLAUDE_CODE_VERSION], "the tarball, its lock and the unpacked partial are gone")
  assert.equal(downloads.at(-1)?.state, "ready")
  assert.ok(downloads.some((d) => d.state === "unpacking"))
  assert.ok(downloads.some((d) => d.state === "downloading" && d.total === tgz.length), "the length is known once the registry answers")
  await flaky.close()
  rmSync(root, { recursive: true, force: true })
})

test("provision: a silent connection is dropped and asked again, and one that never answers gives up keeping its bytes", async () => {
  // Silent after half: the reconnect asks for the rest and finishes.
  const root = scratch()
  const tgz = bulkyClaudeTgz()
  const half = Math.floor(tgz.length / 2)
  const quiet = await flakyRegistry(claudeCoords.pkg, claudeCoords.packageVersion, tgz, (n) => n === 1 ? { send: half, then: "stall" } : { send: Infinity, then: "end" })
  const got = await provisionRuntime("claude", { root, coordinates: claudeCoords, registry: quiet.url, ...fast })
  assert.ok(existsSync(got.bin))
  assert.equal(quiet.ranges.length, 2)
  assert.match(quiet.ranges[1] ?? "", /^bytes=\d+-$/u)
  await quiet.close()
  rmSync(root, { recursive: true, force: true })

  // Silent every time: it fails once nothing has arrived for the give-up window, and keeps what it got.
  const stuckRoot = scratch()
  const dead = await flakyRegistry(claudeCoords.pkg, claudeCoords.packageVersion, tgz, (n) => n === 1 ? { send: half, then: "stall" } : { send: 0, then: "stall" })
  await assert.rejects(
    provisionRuntime("claude", { root: stuckRoot, coordinates: claudeCoords, registry: dead.url, stallReconnectMs: 150, stallGiveUpMs: 700, backoffMs: () => 10 }),
    /stopped receiving data; .* is kept for the next try/u,
  )
  const kept = join(stuckRoot, "claude", `.partial-${CLAUDE_CODE_VERSION}.tgz`)
  assert.equal(statSync(kept).size, half, "the bytes that did arrive are kept")
  assert.deepEqual(readdirSync(join(stuckRoot, "claude")).sort(), [`.partial-${CLAUDE_CODE_VERSION}.tgz`], "no lock and no unpacked partial survive")
  await dead.close()

  // The next attempt, on a healthy connection, fetches only the rest.
  const healthy = await flakyRegistry(claudeCoords.pkg, claudeCoords.packageVersion, tgz, () => ({ send: Infinity, then: "end" }))
  const resumed = await provisionRuntime("claude", { root: stuckRoot, coordinates: claudeCoords, registry: healthy.url, ...fast })
  assert.ok(existsSync(resumed.bin))
  assert.deepEqual(healthy.ranges, [`bytes=${half}-`])
  await healthy.close()
  rmSync(stuckRoot, { recursive: true, force: true })
})

test("provision: a kept tarball the registry disowns fails its integrity check and is not kept", async () => {
  const root = scratch()
  const tgz = bulkyClaudeTgz()
  mkdirSync(join(root, "claude"), { recursive: true })
  // Bytes from somewhere else: resuming after them yields a tarball whose hash is wrong.
  writeFileSync(join(root, "claude", `.partial-${CLAUDE_CODE_VERSION}.tgz`), Buffer.alloc(1000, 7))
  const flaky = await flakyRegistry(claudeCoords.pkg, claudeCoords.packageVersion, tgz, () => ({ send: Infinity, then: "end" }))
  await assert.rejects(provisionRuntime("claude", { root, coordinates: claudeCoords, registry: flaky.url, ...fast }), /integrity mismatch/u)
  assert.deepEqual(readdirSync(join(root, "claude")), [], "a tarball that cannot verify is not resumed again")
  // So the next attempt starts clean and succeeds.
  const got = await provisionRuntime("claude", { root, coordinates: claudeCoords, registry: flaky.url, ...fast })
  assert.ok(existsSync(got.bin))
  await flaky.close()
  rmSync(root, { recursive: true, force: true })
})

test("sweep: the pins of the last two releases booted are kept, and a pin downloaded ahead of an update", () => {
  const root = scratch()
  for (const label of ["2.1.300", "2.1.322", "2.1.325", "2.1.330"]) provisionedDir(root, "claude", label, "claude")
  // 0.15.52 booted on 2.1.322, then 0.15.55 on 2.1.325: the sweep 0.15.55 runs keeps 2.1.322.
  assert.equal(recordPin("claude", root, "2.1.322"), undefined)
  assert.equal(recordPin("claude", root, "2.1.325"), "2.1.322")
  const sweep = sweepSuperseded("claude", root, "2.1.325", {})
  void sweep
  assert.ok(existsSync(join(root, "claude", "2.1.322")), "the previous release's pin survives the update's sweep")
  assert.ok(existsSync(join(root, "claude", "2.1.330")) === false, "an unrecorded pin is retired as before")
  assert.ok(existsSync(join(root, "claude", "2.1.300")) === false)
  // A pin fetched ahead of the next update is held for the boot that will use it.
  provisionedDir(root, "claude", "2.1.340", "claude")
  recordPinAhead("claude", root, "2.1.340")
  sweepSuperseded("claude", root, "2.1.325", {})
  assert.ok(existsSync(join(root, "claude", "2.1.340")))
  assert.deepEqual(protectedPins("claude", root).sort(), ["2.1.322", "2.1.325", "2.1.340"])
  // Booting on it ends the hold; the release two back is then the one retired.
  recordPin("claude", root, "2.1.340")
  sweepSuperseded("claude", root, "2.1.340", {})
  assert.deepEqual(readdirSync(join(root, "claude")).sort(), ["2.1.325", "2.1.340"])
  rmSync(root, { recursive: true, force: true })
})

test("open now: the boot stops waiting on a slow download, and the first thread waits for the same one", async (t) => {
  t.after(resetDeferredRuntimes)
  const root = scratch()
  const claude = runtimeCoordinates("claude")!
  const codex = runtimeCoordinates("codex")!
  const tgz = tarball([
    { name: `package/${claude.binary}`, data: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
    { name: "package/payload.bin", data: Buffer.from(Array.from({ length: 400_000 }, (_, i) => (i * 7919) % 251)) },
  ])
  // Half now, then silence until `release()` lets the reconnect through.
  let released = false
  const slow = await flakyRegistry(claude.pkg, claude.packageVersion, tgz, (n) => n === 1 ? { send: Math.floor(tgz.length / 2), then: "stall" } : released ? { send: Infinity, then: "end" } : { send: 0, then: "stall" })
  let openNow!: () => void
  const asked = new Promise<void>((resolve) => { openNow = resolve })
  const downloads: string[] = []
  const resolving = resolveRuntimes({
    env: {}, root, registry: slow.url, defer: { claude: false, codex: true }, openNow: asked, ...fast,
    onDownload: (d) => downloads.push(d.state),
  })
  while (!downloads.includes("downloading")) await new Promise((resolve) => setTimeout(resolve, 10))
  openNow()
  const got = await resolving
  assert.equal(got.claude.source, "deferred")
  assert.equal(got.claude.downloading, true)
  assert.equal(got.claude.bin, pinnedBinaryPath("claude", root, claude))
  assert.equal(isRuntimeDeferred("claude"), true, "nothing may start Claude Code until the download lands")
  assert.equal(got.codex.source, "deferred", "a signed-out backend is unaffected")
  void codex
  // The first thread on it waits for the download that was already running, not a new one.
  const waiting = ensureRuntime("claude")
  const before = slow.ranges.length
  released = true
  await waiting
  assert.equal(existsSync(got.claude.bin), true)
  assert.equal(isRuntimeDeferred("claude"), false)
  assert.ok(slow.ranges.slice(before).every((range) => range !== undefined), "every later request resumed the same tarball")
  assert.ok(liveRuntimeLeases(join(root, "claude", claude.label)).length > 0, "the landed pin is leased like a boot's")
  await slow.close()
  rmSync(root, { recursive: true, force: true })
})

test("prepare: downloads what the next boot needs, sweeps nothing, and leaves signed-out backends alone", async () => {
  const root = scratch()
  const claude = runtimeCoordinates("claude")!
  const codex = runtimeCoordinates("codex")!
  provisionedDir(root, "claude", "2.1.100", "claude")
  registry.set(claude.pkg, claude.packageVersion, tarball([{ name: `package/${claude.binary}`, data: Buffer.from("#!/bin/sh\n"), mode: 0o755 }]))
  const before = registry.requests.length
  const states: string[] = []
  const got = await prepareRuntimes({ env: {}, root, registry: registry.url, defer: { claude: false, codex: true }, onDownload: (d) => states.push(`${d.backend}:${d.state}`) })
  assert.equal(got.claude?.fetched, true)
  assert.equal(got.codex, undefined)
  assert.equal(existsSync(join(root, "codex")), false, "Codex was not asked for")
  assert.ok(registry.requests.slice(before).every((url) => !url.includes("codex")))
  assert.ok(existsSync(join(root, "claude", "2.1.100")), "nothing is swept: the release still serving may run it")
  assert.ok(states.includes("claude:ready"))
  assert.ok(protectedPins("claude", root).includes(claude.label), "the fetched pin is held until a boot uses it")
  void codex
  rmSync(root, { recursive: true, force: true })
})
