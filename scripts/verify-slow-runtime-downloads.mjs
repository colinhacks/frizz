// A SLOW CONNECTION, END TO END, ON REAL PACKAGES (2026-11-15). Frizz once took almost ten minutes to
// come back after a restart, behind a page that said only "Waiting for Frizz", because the server it
// started was downloading a 350 MB runtime nobody could see. This drives the two stories that fixed:
//
//   1. A first start whose runtime download is slow. The restart screen is a checklist with bytes,
//      speed and time left; "Open Frizz now" opens the board without the download; the status row's
//      chip tracks it until it lands.
//   2. An update whose new release needs a runtime. It downloads while the old release still serves:
//      the board stays usable, with the download on the update button, and the restart that follows
//      waits on nothing but the boot.
//
// Real npm artifacts -> the stable launcher -> a real server -> a headless browser, against two local
// registries: one for the Frizz packages (everything else is passed through to npm), and one for the
// runtime, which serves a stand-in Claude Code package at a rate the script turns up and down. Nothing
// runs the stand-in: no thread is dispatched. The sandbox HOME is signed in to nothing.
//
// Build first, with the release workflow's pnpm on PATH:
//   nub scripts/prepare-package.mjs --server && nub scripts/build-package.mjs --server && nub scripts/build-package.mjs --shell
// Run: nub scripts/verify-slow-runtime-downloads.mjs --out=/absolute/evidence
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { once } from "node:events"
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { gzipSync } from "node:zlib"
import { launchHeadless } from "./lib/headless-browser.mjs"
import { resolveNpmCli } from "../src/server-release.ts"
import { ensureProjectIdFile } from "../packages/server/src/project-root.ts"
import { CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION, runtimeCoordinates } from "../packages/server/src/runtimes.ts"

const workspace = resolve(import.meta.dirname, "..")
const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const out = resolve(argument("out") ?? mkdtempSync(join(tmpdir(), "frizz-slow-download-evidence-")))
mkdirSync(out, { recursive: true })
const root = mkdtempSync(join(tmpdir(), "frizz-slow-download-e2e-"))
const home = join(root, "home"), repo = join(root, "project")
mkdirSync(home); mkdirSync(repo)
const runtime = process.execPath
const npmCli = resolveNpmCli(process.env, runtime)
// No Frizz variable of the worker running this, and a PATH with nothing signed in on it: an OpenCode
// on PATH would make a signed-out machine defer Claude Code instead of downloading it at boot.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FRIZZ_|npm_|NPM_|NODE_OPTIONS|NODE_PATH|NODE_COMPAT|CODEX_HOME)/u.test(key)))
Object.assign(env, {
  PATH: [dirname(runtime), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
  npm_config_cache: join(root, "npm-cache"), npm_config_userconfig: join(root, "empty.npmrc"),
  npm_config_fetch_retries: "0", FRIZZ_ORPHAN_REAPER_OFF: "1",
})
writeFileSync(env.npm_config_userconfig, "")
const runtimesDir = join(home, "cache/frizz/runtimes")
env.FRIZZ_RUNTIMES_DIR = runtimesDir
execFileSync("git", ["init", "-q"], { cwd: repo })
ensureProjectIdFile(repo, home)

const events = []
function record(event, data = {}) {
  const row = { at: new Date().toISOString(), event, ...data }
  events.push(row); console.log(JSON.stringify(row))
}
async function until(label, check, timeout = 90_000, every = 200) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result } catch (error) { lastError = error }
    await delay(every)
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`)
}
async function freePort() {
  const server = createNetServer()
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const port = server.address().port
  await new Promise((done) => server.close(done)); return port
}

// ── The Frizz packages ────────────────────────────────────────────────────────────────────────────────
const packages = new Map()
function pack(directory, manifest) {
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest))
  const output = JSON.parse(execFileSync(runtime, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", root, "--cache", join(root, "packing-cache")], { cwd: directory, encoding: "utf8", env, maxBuffer: 4e6 }))
  const packed = Array.isArray(output) ? output[0] : Object.values(output)[0]
  const tarball = readFileSync(join(root, packed.filename))
  if (!packages.has(manifest.name)) packages.set(manifest.name, { latest: manifest.version, releases: new Map() })
  const entry = packages.get(manifest.name)
  entry.releases.set(manifest.version, { manifest, tarball, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` })
  entry.latest = manifest.version
}
function serverRelease(version) {
  const directory = join(root, `server-${version}`)
  cpSync(join(workspace, "packages/server-release"), directory, { recursive: true, filter: (source) => !source.includes("node_modules") })
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
  assert.equal(manifest.frizzServer.provisionRuntimes, 1, "this build declares that it downloads its runtimes ahead")
  manifest.version = version
  pack(directory, manifest)
}
const OLD = "0.99.0", NEW = "0.99.1"
{
  const shellDir = join(root, "shell")
  mkdirSync(shellDir); cpSync(join(workspace, "dist"), join(shellDir, "dist"), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"))
  manifest.version = OLD
  manifest.frizzServer.version = OLD
  delete manifest.frizzServer.minimum
  delete manifest.devDependencies; delete manifest.scripts; delete manifest.pnpm
  pack(shellDir, manifest)
  serverRelease(OLD)
  // The newer server is the latest from the start, so the launcher offers it once the board is up.
  serverRelease(NEW)
}
const registry = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, "http://registry").pathname)
    const packageName = path.split("/")[1]
    const entry = packages.get(packageName)
    if (!entry) {
      const upstream = await fetch(`https://registry.npmjs.org${request.url}`)
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" })
      response.end(Buffer.from(await upstream.arrayBuffer())); return
    }
    if (path.includes("/-/")) {
      const release = entry.releases.get(path.slice(path.lastIndexOf("/") + 1, -4))
      response.writeHead(release ? 200 : 404); response.end(release?.tarball); return
    }
    const versions = Object.fromEntries([...entry.releases].map(([version, release]) => [version, {
      ...release.manifest, dist: { tarball: `${env.npm_config_registry}${packageName}/-/${version}.tgz`, integrity: release.integrity },
    }]))
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ name: packageName, "dist-tags": { latest: entry.latest }, versions }))
  } catch (error) { response.writeHead(500); response.end(String(error)) }
})
registry.listen(0, "127.0.0.1"); await once(registry, "listening")
env.npm_config_registry = `http://127.0.0.1:${registry.address().port}/`

// ── The runtime, at a rate this script sets ───────────────────────────────────────────────────────────
// A stand-in for the Claude Code package the server pins: a binary that is never run, and 24 MB of
// bytes that do not compress, so the download takes as long as the rate says.
function tarHeader(name, size, mode) {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, "utf8")
  block.write(mode.toString(8).padStart(7, "0"), 100, 8, "latin1")
  block.write("0000000", 108, 8, "latin1"); block.write("0000000", 116, 8, "latin1")
  block.write(size.toString(8).padStart(11, "0"), 124, 12, "latin1")
  block.write("00000000000", 136, 12, "latin1")
  block.write("        ", 148, 8, "latin1"); block.write("0", 156, 1, "latin1")
  block.write("ustar\0", 257, 6, "latin1"); block.write("00", 263, 2, "latin1")
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1")
  return block
}
function standInTarball() {
  const parts = []
  for (const [name, data, mode] of [
    ["package/package.json", Buffer.from('{"name":"stand-in"}'), 0o644],
    ["package/claude", Buffer.from("#!/bin/sh\necho 'a stand-in: verify-slow-runtime-downloads.mjs never runs it'\nexit 1\n"), 0o755],
    ["package/payload.bin", randomBytes(24_000_000), 0o644],
  ]) parts.push(tarHeader(name, data.length, mode), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts), { level: 1 })
}
const claude = runtimeCoordinates("claude")
assert.ok(claude, "this platform has a Claude Code pin")
assert.equal(claude.label, CLAUDE_CODE_VERSION)
const standIn = standInTarball()
const standInIntegrity = `sha512-${createHash("sha512").update(standIn).digest("base64")}`
let rate = 160_000
const tarballRequests = []
const runtimeRegistry = createServer((request, response) => {
  const path = new URL(request.url, "http://runtimes").pathname
  if (path === `/${claude.pkg.replace("/", "%2F")}/${CLAUDE_AGENT_SDK_VERSION}`) {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ dist: { tarball: `${runtimesUrl}/claude.tgz`, integrity: standInIntegrity } }))
    return
  }
  if (path !== "/claude.tgz") { response.writeHead(404); response.end(); return }
  const start = Number(/^bytes=(\d+)-$/u.exec(request.headers.range ?? "")?.[1] ?? 0)
  tarballRequests.push({ at: Date.now(), start })
  if (start > 0) response.writeHead(206, { "content-length": standIn.length - start, "content-range": `bytes ${start}-${standIn.length - 1}/${standIn.length}` })
  else response.writeHead(200, { "content-length": standIn.length })
  let offset = start
  const timer = setInterval(() => {
    if (response.destroyed) { clearInterval(timer); return }
    const next = Math.min(standIn.length, offset + Math.ceil(rate / 10))
    response.write(standIn.subarray(offset, next))
    offset = next
    if (offset >= standIn.length) { clearInterval(timer); response.end() }
  }, 100)
  response.on("close", () => clearInterval(timer))
})
runtimeRegistry.listen(0, "127.0.0.1"); await once(runtimeRegistry, "listening")
const runtimesUrl = `http://127.0.0.1:${runtimeRegistry.address().port}`
env.FRIZZ_RUNTIMES_REGISTRY = runtimesUrl
const pinBinary = join(runtimesDir, "claude", CLAUDE_CODE_VERSION, "claude")

// ── The launcher ──────────────────────────────────────────────────────────────────────────────────────
const port = await freePort()
const base = `http://127.0.0.1:${port}`
record("fixture", { root, out, base, registry: env.npm_config_registry, runtimes: runtimesUrl, tarball: standIn.length })
let launcher, browser
async function status() {
  const response = await fetch(`${base}/_frizz/control/status`, { headers: { origin: base }, signal: AbortSignal.timeout(2000) })
  return response.json()
}
async function shot(page, name, clip) {
  const file = join(out, `${name}.png`)
  if (clip) {
    const box = await page.$eval(clip, (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
    await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 32 }, captureBeyondViewport: false })
  } else await page.screenshot({ path: file, captureBeyondViewport: false })
  record("shot", { file })
}

try {
  launcher = spawn(runtime, [npmCli, "exec", "--yes", `--package=frizz@${OLD}`, "--", "frizz", "--no-app", "--port", String(port)], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] })
  launcher.stdout.on("data", (bytes) => appendFileSync(join(out, "launcher.log"), bytes))
  launcher.stderr.on("data", (bytes) => appendFileSync(join(out, "launcher.log"), bytes))
  launcher.on("exit", (code, signal) => record("launcher-exit", { code, signal }))
  browser = await launchHeadless({ defaultViewport: { width: 1280, height: 860, deviceScaleFactor: 2 } })
  const page = await browser.newPage()
  page.on("pageerror", (error) => record("pageerror", { message: String(error) }))

  // ── 1. A first start on a slow connection ────────────────────────────────────────────────────────
  await until("the launcher's port", async () => (await fetch(base, { signal: AbortSignal.timeout(1000) })).status > 0, 240_000, 500)
  await until("the runtime download", () => tarballRequests.length > 0, 240_000, 500)
  record("downloading", { rate })
  // The project's own page, which the launcher opens: `/` is the all-projects page.
  await page.goto(`${base}/project/project/`, { waitUntil: "domcontentloaded" })
  // Once the download has run long enough to have a speed: bytes, speed and time left together.
  await page.waitForFunction(() => /Downloading Claude Code[\s\S]*KB\/s[\s\S]*left/u.test(document.querySelector("#steps")?.textContent ?? ""), { timeout: 60_000 })
  const checklist = await page.$eval("#steps", (element) => element.innerText)
  record("checklist", { checklist })
  assert.match(checklist, /KB\/s/u, "the checklist reads the speed")
  assert.match(checklist, /left/u, "and the time left")
  await shot(page, "1-start-downloading", "main")
  // 24 MB at 160 KB/s is about 2m 30s: past the minute that earns the offer.
  await page.waitForSelector("#open-now:not([hidden])", { visible: true, timeout: 60_000 })
  const callout = await page.$eval("#callout-text", (element) => element.textContent)
  assert.match(callout, /This connection is slow\. Frizz can open now and finish Claude Code in the background\./u)
  await shot(page, "2-start-open-now", "main")
  const clickedAt = Date.now()
  await page.click("#open-now")
  await page.waitForSelector("[data-status-row]", { timeout: 60_000 })
  const openedMs = Date.now() - clickedAt
  record("board-open", { openedMs, pinYet: existsSync(pinBinary) })
  assert.equal(existsSync(pinBinary), false, "the board opened before the download finished")
  assert.ok(openedMs < 30_000, `the board opened ${openedMs}ms after the click`)
  await page.waitForSelector('[data-runtime-download="claude"]', { visible: true, timeout: 30_000 })
  const chip = await page.$eval('[data-runtime-download="claude"]', (element) => ({ text: element.textContent, title: element.title }))
  record("chip", chip)
  assert.match(chip.text, /Claude Code/u)
  await shot(page, "3-board-background-download", "[data-status-row]")
  rate = 40_000_000
  await page.waitForFunction(() => !document.querySelector('[data-runtime-download="claude"]'), { timeout: 60_000 })
  assert.equal(existsSync(pinBinary), true, "the background download landed where the pin lives")
  record("background-download-landed", { requests: tarballRequests.length })

  // ── 2. An update whose new release needs a runtime ─────────────────────────────────────────────────
  await until("the update offer", async () => (await status()).updateVersion === NEW, 60_000, 500)
  // The new release pins the same Claude Code as this one, so take it away: what is left is exactly a
  // release whose pin this machine does not have yet.
  rmSync(join(runtimesDir, "claude", CLAUDE_CODE_VERSION), { recursive: true, force: true })
  rate = 600_000
  const before = tarballRequests.length
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForSelector('button[aria-label="Update Frizz"]', { visible: true, timeout: 30_000 })
  await page.click('button[aria-label="Update Frizz"]')
  await page.waitForSelector("button[data-preparing]", { visible: true, timeout: 120_000 })
  // The pointer is still on the button, so the popover is open on the checklist without a second hover.
  await page.waitForSelector("#update-restart-popover[data-preparing]", { visible: true, timeout: 10_000 })
  const usable = await page.evaluate(() => ({ overlay: !!document.querySelector('[role="alertdialog"]'), inert: !!document.querySelector("[inert]") }))
  record("preparing", usable)
  assert.deepEqual(usable, { overlay: false, inert: false }, "the board stays usable while the update downloads")
  await page.waitForFunction(() => document.querySelector("[data-prepare-ring]")?.getAttribute("data-prepare-ring") !== "indeterminate", { timeout: 120_000 })
  const popover = await page.$eval("#update-restart-popover", (element) => element.innerText)
  record("popover", { popover })
  assert.match(popover, new RegExp(`Getting ${NEW.replaceAll(".", "\\.")} ready`, "u"))
  assert.match(popover, /Downloading Claude Code/u)
  await shot(page, "4-update-downloading-ahead", "#update-restart-popover")
  // The download finishes under the old release; then the restart.
  rate = 40_000_000
  let restartingAt
  const settled = await until("the new release", async () => {
    const value = await status().catch(() => undefined)
    if (value?.state === "restarting") restartingAt ??= Date.now()
    return value?.state === "ready" && value.version === NEW && value
  }, 240_000, 100)
  const restartMs = restartingAt === undefined ? 0 : Date.now() - restartingAt
  const fetchedDuringPrepare = tarballRequests.slice(before).filter((request) => restartingAt === undefined || request.at < restartingAt).length
  const fetchedAfterStop = tarballRequests.slice(before).filter((request) => restartingAt !== undefined && request.at >= restartingAt).length
  record("updated", { version: settled.version, restartMs, fetchedDuringPrepare, fetchedAfterStop })
  assert.ok(fetchedDuringPrepare > 0, "the runtime came down before the old release stopped")
  assert.equal(fetchedAfterStop, 0, "and the restart downloaded nothing")
  assert.ok(restartMs < 30_000, `the restart took ${restartMs}ms`)
  await page.waitForSelector("[data-status-row]", { timeout: 60_000 })
  await shot(page, "5-after-update", "[data-status-row]")
  record("verdict", { ok: true })
} catch (error) {
  record("verdict", { ok: false, error: String(error?.stack ?? error) })
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => undefined)
  // The launcher holds the port; its server child, and the daemons under it, stop with it.
  let listener = []
  try { listener = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number) } catch { /* nothing listening */ }
  for (const pid of listener) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
  if (launcher && launcher.exitCode === null) { try { launcher.kill("SIGTERM") } catch { /* gone */ } }
  await until("the port to close", () => {
    try { return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim() === "" } catch { return true }
  }, 60_000, 500).catch((error) => record("cleanup", { error: String(error) }))
  registry.closeAllConnections(); registry.close()
  runtimeRegistry.closeAllConnections(); runtimeRegistry.close()
  writeFileSync(join(out, "events.json"), JSON.stringify(events, null, 2))
  if (process.exitCode !== 1) rmSync(root, { recursive: true, force: true })
  else record("kept", { root })
}
