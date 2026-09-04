// The provisioner (runtimes.ts) against a LOCAL registry: a real HTTP server serving a real gzipped
// tarball built here, so the download, the integrity check, the extraction, the marker and the sweep
// are all exercised for real — without ever reaching npm. What is NOT covered here is the network
// itself and the vendors' actual tarballs; `nub scripts/provision-runtimes.mjs` does that, on demand.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { after, before, test } from "node:test"
import { gzipSync } from "node:zlib"
import { CODEX_APP_SERVER_SUPPORTED_VERSION } from "./backend/codex-app-server.ts"
import {
  CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION, describeRuntime, extractNpmTarball, provisionRuntime, provisionedBinary,
  resolveRuntimes, runtimeCoordinates, sweepRuntimes, type RuntimeCoordinates,
} from "./runtimes.ts"

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

const claudeCoords: RuntimeCoordinates = { pkg: "@anthropic-ai/claude-agent-sdk-darwin-arm64", packageVersion: "0.3.207", label: "2.1.207", binary: "claude" }
const codexCoords: RuntimeCoordinates = { pkg: "@openai/codex", packageVersion: "0.153.2-darwin-arm64", label: "0.153.2", binary: "codex" }

const claudeTgz = tarball([
  { name: "package/package.json", data: Buffer.from('{"name":"stub"}') },
  { name: "package/claude", data: Buffer.from("#!/bin/sh\necho 2.1.207 (stub)\n"), mode: 0o755 },
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
  assert.equal(first.bin, join(root, "claude", "2.1.207", "claude"))
  assert.equal(readFileSync(first.bin, "utf8").includes("2.1.207"), true)
  if (process.platform !== "win32") assert.equal(statSync(first.bin).mode & 0o111, 0o111)
  const marker = JSON.parse(readFileSync(join(root, "claude", "2.1.207", "provisioned.json"), "utf8")) as Record<string, string>
  assert.equal(marker.integrity, integrityOf(claudeTgz))
  assert.equal(marker.binary, "claude")
  assert.equal(registry.requests.length - before, 2, "one manifest read and one tarball download")
  assert.ok(messages.some((m) => m.startsWith("downloading")), messages.join(" | "))
  assert.equal(messages.at(-1), "ready")
  assert.equal(existsSync(join(root, "claude", `.partial-2.1.207-${process.pid}`)), false)

  const second = await provisionRuntime("claude", { root, coordinates: claudeCoords, registry: registry.url })
  assert.equal(second.fetched, false)
  assert.equal(second.bin, first.bin)
  assert.equal(registry.requests.length - before, 2, "the second call reads the marker and fetches nothing")
  assert.equal(provisionedBinary("claude", root, "2.1.207"), first.bin)
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
  assert.equal(got.bin, join(root, "codex", "0.153.2", "vendor", "aarch64-apple-darwin", "bin", "codex"))
  assert.ok(existsSync(join(root, "codex", "0.153.2", "vendor", "aarch64-apple-darwin", "codex-path", "rg")))
  const marker = JSON.parse(readFileSync(join(root, "codex", "0.153.2", "provisioned.json"), "utf8")) as { binary: string }
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
  assert.equal(existsSync(join(root, "claude", "2.1.207")), false)
  assert.deepEqual(readdirSync(join(root, "claude")), [], "no partial survives a failed download")
  rmSync(root, { recursive: true, force: true })
})

test("provision: a package that unpacks without its binary is refused", async () => {
  const root = scratch()
  registry.set(claudeCoords.pkg, claudeCoords.packageVersion, tarball([{ name: "package/package.json", data: Buffer.from("{}") }]))
  await assert.rejects(provisionRuntime("claude", { root, coordinates: claudeCoords, registry: registry.url }), /without a claude binary/u)
  assert.equal(existsSync(join(root, "claude", "2.1.207")), false)
  rmSync(root, { recursive: true, force: true })
})

test("sweep: retires the other versions and a stale partial, keeps the pin and a fresh partial", () => {
  const root = scratch()
  for (const label of ["2.1.207", "2.1.180", ".partial-2.1.207-1", ".partial-2.1.207-2"]) {
    mkdirSync(join(root, "claude", label), { recursive: true })
    writeFileSync(join(root, "claude", label, "x"), "")
  }
  const old = Date.now() - 2 * 24 * 60 * 60 * 1000
  utimesSync(join(root, "claude", ".partial-2.1.207-1"), old / 1000, old / 1000)
  const removed = sweepRuntimes("claude", root, "2.1.207")
  assert.deepEqual(removed.map((p) => p.slice(root.length + 1)).sort(), [join("claude", ".partial-2.1.207-1"), join("claude", "2.1.180")])
  assert.ok(existsSync(join(root, "claude", "2.1.207")))
  assert.ok(existsSync(join(root, "claude", ".partial-2.1.207-2")))
  assert.deepEqual(sweepRuntimes("codex", root, "0.153.2"), [], "a backend with no directory sweeps nothing")
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
