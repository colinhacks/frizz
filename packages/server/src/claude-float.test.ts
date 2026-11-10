// The Claude Code float (claude-float.ts) against a LOCAL registry: real HTTP, real gzipped tarballs,
// the real provisioner, marker, lease and sweep. What is stubbed is the verification of a build (a
// real one runs a 300 MB binary and the SDK) and the network; scripts/verify-claude-float.mjs drives
// the real thing against npm.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { gzipSync } from "node:zlib"
import { createClaudeFloat, resolveClaudeFloatTarget } from "./claude-float.ts"
import { liveRuntimeLeases } from "./runtime-lease.ts"
import {
  claudeFloatStatePath, claudeReleaseCoordinates, isLaterOnLine, provisionRuntime, provisionedBinary, readClaudeFloat, resolveRuntimes,
  runtimeCoordinates, writeClaudeFloat, type ResolvedRuntime, type RuntimeCoordinates,
} from "./runtimes.ts"

// --- a registry that answers the three reads the float makes, plus the tarball --------------------

function tar(name: string, data: Buffer, mode: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, "utf8")
  header.write(mode.toString(8).padStart(7, "0"), 100, 8, "latin1")
  header.write("0000000", 108, 8, "latin1")
  header.write("0000000", 116, 8, "latin1")
  header.write(data.length.toString(8).padStart(11, "0"), 124, 12, "latin1")
  header.write("00000000000", 136, 12, "latin1")
  header.write("        ", 148, 8, "latin1")
  header.write("0", 156, 1, "latin1")
  header.write("ustar\0", 257, 6, "latin1")
  header.write("00", 263, 2, "latin1")
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1")
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

function claudeTarball(version: string): Buffer {
  const script = Buffer.from(`#!/bin/sh\necho "${version} (Claude Code)"\n`)
  return gzipSync(Buffer.concat([tar("package/claude", script, 0o755), Buffer.alloc(1024)]))
}

let server: Server
let url = ""
const tarballs = new Map<string, Buffer>()
let latest: Record<string, string | undefined> = {}
let failLatest = false
const requests: string[] = []

before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? ""
    requests.push(path)
    const tgz = /^\/tgz\/(.+)$/u.exec(path)
    if (tgz) {
      const body = tarballs.get(decodeURIComponent(tgz[1]!))
      if (!body) { res.statusCode = 404; res.end(); return }
      res.end(body)
      return
    }
    const [, pkgEncoded, rest] = /^\/([^/]+)(?:\/(.+))?$/u.exec(path) ?? []
    const pkg = decodeURIComponent(pkgEncoded ?? "")
    res.setHeader("content-type", "application/json")
    if (rest === "latest") {
      if (failLatest) { res.statusCode = 503; res.end(); return }
      const version = latest[pkg]
      if (!version) { res.statusCode = 404; res.end(); return }
      res.end(JSON.stringify({ version }))
      return
    }
    if (rest === undefined) {
      const versions = Object.fromEntries([...tarballs.keys()].filter((key) => key.startsWith(`${pkg}@`)).map((key) => [key.slice(pkg.length + 1), {}]))
      res.end(JSON.stringify({ versions }))
      return
    }
    const body = tarballs.get(`${pkg}@${rest}`)
    if (!body) { res.statusCode = 404; res.end(); return }
    const integrity = `sha512-${createHash("sha512").update(body).digest("base64")}`
    res.end(JSON.stringify({ dist: { tarball: `${url}/tgz/${encodeURIComponent(`${pkg}@${rest}`)}`, integrity } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
})

after(() => server.close())

const RELEASE_PKG = "@anthropic-ai/claude-code-test-platform"
const BUNDLED_PKG = "@anthropic-ai/claude-agent-sdk-test-platform"
const BUNDLED = "2.1.300"

function publish(version: string): void {
  tarballs.set(`${RELEASE_PKG}@${version}`, claudeTarball(version))
}

const releaseCoordinates = (version: string): RuntimeCoordinates => ({ pkg: RELEASE_PKG, packageVersion: version, label: version, binary: "claude" })
const bundledCoordinates: RuntimeCoordinates = { pkg: BUNDLED_PKG, packageVersion: "0.3.300", label: BUNDLED, binary: "claude" }

/** A runtimes root with the bundled build provisioned, as a booted server leaves it. */
async function bootedRoot(): Promise<{ root: string; runtime: ResolvedRuntime }> {
  const root = mkdtempSync(join(tmpdir(), "frizz-claude-float-"))
  tarballs.set(`${BUNDLED_PKG}@0.3.300`, claudeTarball(BUNDLED))
  const { bin } = await provisionRuntime("claude", { root, coordinates: bundledCoordinates, registry: url })
  return { root, runtime: { bin, source: "provisioned", version: BUNDLED } }
}

function floatFor(root: string, start: ResolvedRuntime, overrides: { verify?: (bin: string, label: string) => Promise<void>; now?: () => number } = {}) {
  let current = start
  const adopted: ResolvedRuntime[] = []
  const logs: string[] = []
  const verified: Array<[string, string]> = []
  const float = createClaudeFloat({
    root, bundled: BUNDLED, registry: url, bundledCoordinates, releaseCoordinates,
    current: () => current,
    adopt: (next) => { current = next; adopted.push(next) },
    log: (level, message) => logs.push(`${level} ${message}`),
    verify: overrides.verify ?? (async (bin, label) => { verified.push([bin, label]) }),
    ...(overrides.now ? { now: overrides.now } : {}),
  })
  return { float, adopted, logs, verified, current: () => current }
}

// --- which build ---------------------------------------------------------------------------------

test("a later release on the line is newer, and a new line or a prerelease is not", () => {
  assert.equal(isLaterOnLine("2.1.322", "2.1.321"), true)
  assert.equal(isLaterOnLine("2.1.321", "2.1.321"), false)
  assert.equal(isLaterOnLine("2.1.320", "2.1.321"), false)
  assert.equal(isLaterOnLine("2.2.0", "2.1.321"), false)
  assert.equal(isLaterOnLine("2.1.400-beta.1", "2.1.321"), false)
})

test("the target is npm's latest on the bundled line, never below the bundled build", async () => {
  const coordinates = releaseCoordinates("unused")
  latest = { [RELEASE_PKG]: "2.1.305" }
  assert.equal(await resolveClaudeFloatTarget({ coordinates, bundled: BUNDLED, registry: url }), "2.1.305")
  latest = { [RELEASE_PKG]: BUNDLED }
  assert.equal(await resolveClaudeFloatTarget({ coordinates, bundled: BUNDLED, registry: url }), BUNDLED)
  latest = { [RELEASE_PKG]: "2.1.290" }
  assert.equal(await resolveClaudeFloatTarget({ coordinates, bundled: BUNDLED, registry: url }), BUNDLED, "a pulled release moves latest back, but not past the floor")
  latest = { [RELEASE_PKG]: "2.0.999" }
  assert.equal(await resolveClaudeFloatTarget({ coordinates, bundled: BUNDLED, registry: url }), BUNDLED)
})

test("when latest leaves the line, the target is the newest release still on it", async () => {
  publish("2.1.301")
  publish("2.1.307")
  publish("2.2.0")
  latest = { [RELEASE_PKG]: "2.2.0" }
  assert.equal(await resolveClaudeFloatTarget({ coordinates: releaseCoordinates("unused"), bundled: BUNDLED, registry: url }), "2.1.307")
})

// --- moving ----------------------------------------------------------------------------------------

test("a check provisions the later build, verifies it, adopts it and records it for the next boot", async () => {
  const { root, runtime } = await bootedRoot()
  publish("2.1.310")
  latest = { [RELEASE_PKG]: "2.1.310" }
  const run = floatFor(root, runtime)
  const outcome = await run.float.check()
  assert.deepEqual(outcome, { state: "moved", from: BUNDLED, to: "2.1.310" })
  const bin = provisionedBinary("claude", root, "2.1.310")
  assert.ok(bin)
  assert.deepEqual(run.verified, [[bin, "2.1.310"]])
  assert.equal(run.current().bin, bin)
  assert.equal(run.current().version, "2.1.310")
  assert.deepEqual(readClaudeFloat(root, BUNDLED), { label: "2.1.310", bin })
  assert.deepEqual(liveRuntimeLeases(join(root, "claude", "2.1.310")).map((lease) => lease.pid), [process.pid])
  assert.deepEqual(liveRuntimeLeases(join(root, "claude", BUNDLED)), [], "the server's lease moved with it")
  assert.ok(existsSync(join(root, "claude", BUNDLED)), "the bundled build stays as the fallback")
  // Already there: the next check fetches nothing.
  const before = requests.length
  assert.deepEqual(await run.float.check(), { state: "current", version: "2.1.310" })
  assert.deepEqual(requests.slice(before).filter((path) => path.startsWith("/tgz/")), [])
})

test("moving on retires the previous later build, unless a daemon still runs it", async () => {
  const { root, runtime } = await bootedRoot()
  publish("2.1.311")
  publish("2.1.312")
  publish("2.1.313")
  latest = { [RELEASE_PKG]: "2.1.311" }
  const run = floatFor(root, runtime)
  await run.float.check()
  latest = { [RELEASE_PKG]: "2.1.312" }
  await run.float.check()
  assert.equal(existsSync(join(root, "claude", "2.1.311")), false, "nothing ran 2.1.311 any more")
  // A daemon forked on 2.1.312 holds it through the next move.
  const { spawn } = await import("node:child_process")
  const daemon = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" })
  try {
    const { writeFileSync, mkdirSync } = await import("node:fs")
    mkdirSync(join(root, "claude", "2.1.312", ".leases"), { recursive: true })
    writeFileSync(join(root, "claude", "2.1.312", ".leases", `${daemon.pid}.json`), JSON.stringify({ pid: daemon.pid, role: "daemon", bin: "x", at: "" }))
    latest = { [RELEASE_PKG]: "2.1.313" }
    await run.float.check()
    assert.equal(existsSync(join(root, "claude", "2.1.312")), true)
  } finally {
    daemon.kill()
  }
})

test("a build that fails verification is not adopted, and is left alone for a day", async () => {
  const { root, runtime } = await bootedRoot()
  publish("2.1.320")
  latest = { [RELEASE_PKG]: "2.1.320" }
  let clock = 1_000_000
  let attempts = 0
  const run = floatFor(root, runtime, {
    now: () => clock,
    verify: async () => { attempts += 1; throw new Error("the bundled SDK read no model from it") },
  })
  const outcome = await run.float.check()
  assert.equal(outcome.state, "held")
  assert.equal(run.current(), runtime)
  assert.deepEqual(run.adopted, [])
  assert.equal(readClaudeFloat(root, BUNDLED), undefined)
  assert.match(run.logs.join("\n"), /Claude Code 2\.1\.320 was not adopted \(the bundled SDK read no model from it\)/u)
  await run.float.check()
  assert.equal(attempts, 1, "not retried within the day")
  clock += 24 * 60 * 60_000
  await run.float.check()
  assert.equal(attempts, 2)
})

test("when npm's latest moves back to the bundled build, the server follows it and forgets the later one", async () => {
  const { root, runtime } = await bootedRoot()
  publish("2.1.330")
  latest = { [RELEASE_PKG]: "2.1.330" }
  const run = floatFor(root, runtime)
  await run.float.check()
  latest = { [RELEASE_PKG]: BUNDLED }
  assert.deepEqual(await run.float.check(), { state: "moved", from: "2.1.330", to: BUNDLED })
  assert.equal(run.current().bin, runtime.bin)
  assert.equal(existsSync(claudeFloatStatePath(root)), false)
})

test("an unreachable registry leaves the server where it is, and says so once", async () => {
  const { root, runtime } = await bootedRoot()
  failLatest = true
  try {
    const run = floatFor(root, runtime)
    assert.equal((await run.float.check()).state, "unavailable")
    assert.equal((await run.float.check()).state, "unavailable")
    assert.equal(run.current(), runtime)
    assert.equal(run.logs.filter((line) => line.includes("could not check npm")).length, 1)
  } finally {
    failLatest = false
  }
})

test("concurrent checks share one download", async () => {
  const { root, runtime } = await bootedRoot()
  publish("2.1.340")
  latest = { [RELEASE_PKG]: "2.1.340" }
  const run = floatFor(root, runtime)
  const before = requests.length
  const [a, b] = await Promise.all([run.float.check(), run.float.check()])
  assert.deepEqual(a, b)
  assert.equal(requests.slice(before).filter((path) => path.includes("2.1.340") && path.startsWith("/tgz/")).length, 1)
})

// --- booting ---------------------------------------------------------------------------------------

test("a boot starts on the recorded later build from disk, and on the bundled one when floating is off", async () => {
  const coordinates = runtimeCoordinates("claude")
  if (!coordinates) return // a platform with no published build resolves to PATH, covered in runtimes.test.ts
  const root = mkdtempSync(join(tmpdir(), "frizz-claude-float-boot-"))
  tarballs.set(`${coordinates.pkg}@${coordinates.packageVersion}`, claudeTarball(coordinates.label))
  const [major, minor, patch] = coordinates.label.split(".").map(Number)
  const later = `${major}.${minor}.${patch! + 1}`
  tarballs.set(`${RELEASE_PKG}@${later}`, claudeTarball(later))
  await provisionRuntime("claude", { root, coordinates: releaseCoordinates(later), registry: url })
  writeClaudeFloat(root, later)
  const resolve = (env: NodeJS.ProcessEnv) => resolveRuntimes({ root, registry: url, codexBin: "codex-stand-in", env: { ...env, FRIZZ_RUNTIMES_DIR: root } })
  const floated = (await resolve({})).claude
  assert.equal(floated.version, later)
  assert.equal(floated.bin, provisionedBinary("claude", root, later))
  assert.match(floated.note ?? "", /moved past the bundled/u)
  const pinned = (await resolve({ FRIZZ_CLAUDE_FLOAT: "0" })).claude
  assert.equal(pinned.version, coordinates.label)
  // A record naming a build that is gone, or one not past the bundled build, is ignored.
  writeClaudeFloat(root, `${major}.${minor}.${patch! + 9}`)
  assert.equal((await resolve({})).claude.version, coordinates.label)
  writeClaudeFloat(root, coordinates.label)
  assert.equal(readClaudeFloat(root, coordinates.label), undefined)
  assert.equal(JSON.parse(readFileSync(claudeFloatStatePath(root), "utf8")).label, coordinates.label)
})

test("a release's coordinates name the CLI's own platform package, versioned by Claude Code", () => {
  assert.deepEqual(claudeReleaseCoordinates("2.1.321", "darwin", "arm64", false), { pkg: "@anthropic-ai/claude-code-darwin-arm64", packageVersion: "2.1.321", label: "2.1.321", binary: "claude" })
  assert.deepEqual(claudeReleaseCoordinates("2.1.321", "linux", "x64", true)?.pkg, "@anthropic-ai/claude-code-linux-x64-musl")
  assert.deepEqual(claudeReleaseCoordinates("2.1.321", "win32", "x64", false)?.binary, "claude.exe")
  assert.equal(claudeReleaseCoordinates("2.1.321", "freebsd", "x64", false), undefined)
})
