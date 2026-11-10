#!/usr/bin/env nub
// Clean npm tarballs -> private registry -> npm exec -> stable launcher -> browser -> restart.
// Run after creating tarballs with the root npm lifecycle:
//   nub scripts/verify-server-package.mjs --shell=/abs/frizz-0.13.0.tgz --server=/abs/frizz-server-0.13.0.tgz --out=/abs/evidence
// Add --update=/abs/frizz-server-next.tgz for a browser update; --public=1 uses npmjs directly.
// --worker=codex proves a real detached worker survives that update and answers a follow-up.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { launchHeadless } from "./lib/headless-browser.mjs"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { closureProblem, installedPackages } from "./lib/installed-closure.mjs"
import { resolveNpmCli } from "../src/server-release.ts"
import { frizzPaths } from "../packages/server/src/frizz-paths.ts"

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const shellTarball = resolve(arg("shell") ?? "")
const serverTarball = resolve(arg("server") ?? "")
const out = resolve(arg("out") ?? "")
const publicRegistry = arg("public") === "1"
const worker = arg("worker")
assert.ok(!worker || worker === "codex", "supported worker: codex")
if (!existsSync(shellTarball) || !existsSync(serverTarball) || !arg("out"))
  throw new Error("usage: verify-server-package.mjs --shell=/abs/frizz.tgz --server=/abs/frizz-server.tgz --out=/abs/evidence")
mkdirSync(out, { recursive: true })

const root = mkdtempSync(join(tmpdir(), "frizz-package-smoke-"))
const home = join(root, "home"), project = join(root, "project"), cache = join(root, "npm-cache")
mkdirSync(home); mkdirSync(project)
execFileSync("git", ["init", "-q"], { cwd: project })
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FRIZZ_|npm_|NPM_|NODE_OPTIONS|NODE_PATH|XDG_|HOME|USERPROFILE|CODEX_HOME)/u.test(key)))
Object.assign(env, {
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), npm_config_cache: cache,
  npm_config_userconfig: join(root, "npmrc"), npm_config_fetch_retries: "0", npm_config_audit: "false", npm_config_fund: "false",
  FRIZZ_ORPHAN_REAPER_OFF: "1", FRIZZ_RUNTIMES_DIR: join(frizzPaths().cache, "runtimes"),
  PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
})
writeFileSync(env.npm_config_userconfig, "")
writeFileSync(join(project, "FRIZZ.md"), "Disposable release test. Follow the exact prompt. No goals, delegation, unrelated work, or commits.\n")
if (worker) {
  mkdirSync(join(home, ".codex"))
  cpSync(join(process.env.HOME, ".codex/auth.json"), join(home, ".codex/auth.json"))
}
const npmCli = resolveNpmCli(process.env, process.execPath)

function sha(file) { return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}` }
function packed(file) {
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8" }))
  return { file, bytes: readFileSync(file), manifest, integrity: sha(file) }
}
const shell = packed(shellTarball), server = packed(serverTarball)
const update = arg("update") ? packed(resolve(arg("update"))) : undefined
assert.equal(shell.manifest.name, "frizz"); assert.equal(server.manifest.name, "frizz-server")
assert.equal(shell.manifest.frizzServer?.package, "frizz-server"); assert.equal(shell.manifest.frizzServer?.version, server.manifest.version)
if (update) { assert.equal(update.manifest.name, "frizz-server"); assert.notEqual(update.manifest.version, server.manifest.version) }
assert.ok(!worker || update, "worker continuity requires --update")

async function port() {
  const socket = createNetServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening")
  const value = socket.address().port; await new Promise((done) => socket.close(done)); return value
}
async function until(label, test, timeout = 120_000) {
  const deadline = Date.now() + timeout; let last
  while (Date.now() < deadline) {
    try { const value = await test(); if (value) return value } catch (error) { last = error }
    await delay(200)
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`)
}
function ownerAddress() {
  const file = join(home, "state", "frizz", "frizz-server", "address.json")
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined
}
function childGeneration() {
  const projects = join(home, "data", "frizz", "projects")
  for (const id of existsSync(projects) ? readdirSync(projects) : []) {
    const lock = join(projects, id, "server.lock")
    if (existsSync(lock)) return JSON.parse(readFileSync(lock, "utf8"))
  }
  return undefined
}
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
function selected() {
  const directory = join(home, "state/frizz/server-releases")
  const key = readdirSync(directory).find((name) => /^[0-9a-f]{16}$/.test(name))
  return JSON.parse(readFileSync(join(directory, key, "active.json"), "utf8"))
}
const workerPids = new Set()
function workerRecord() {
  const projects = join(home, "data/frizz/projects")
  for (const id of existsSync(projects) ? readdirSync(projects) : []) {
    const directory = join(projects, id, "codex-app-server-native")
    for (const file of existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".json")) : []) {
      const value = JSON.parse(readFileSync(join(directory, file), "utf8"))
      const pid = value.listenerPid ?? value.pid
      if (pid && alive(pid)) {
        workerPids.add(pid)
        if (value.childPid) workerPids.add(value.childPid)
        return { pid, childPid: value.childPid, generation: value.generation }
      }
    }
  }
}

const packages = new Map([[shell.manifest.name, shell], [server.manifest.name, server]])
let registry, launcher, browser
let browserPid
let monitor
const probes = new Set()
const childPids = new Set()
const errors = [], expectedBrowserEvents = []
let restartRequested = false
const evidence = { tarballs: { shell: { file: shellTarball, integrity: shell.integrity }, server: { file: serverTarball, integrity: server.integrity } }, browserErrors: errors, expectedBrowserEvents }
try {
  if (publicRegistry) {
    env.npm_config_registry = "https://registry.npmjs.org/"
    for (const release of [shell, server, update].filter(Boolean)) {
      const response = await fetch(`${env.npm_config_registry}${release.manifest.name}/${release.manifest.version}`)
      assert.equal(response.status, 200)
      const metadata = await response.json()
      assert.equal(metadata.dist.integrity, release.integrity, "tested tarball must match public registry bytes")
    }
  } else {
    registry = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://registry").pathname)
    const name = pathname.split("/")[1]
    const release = packages.get(name)
    if (!release) {
      const upstream = await fetch(`https://registry.npmjs.org${request.url}`)
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" })
      response.end(Buffer.from(await upstream.arrayBuffer())); return
    }
    const releases = name === "frizz-server" && update ? [server, update] : [release]
    if (pathname.includes("/-/")) {
      const exact = releases.find((value) => pathname.endsWith(`/${name}-${value.manifest.version}.tgz`))
      response.writeHead(exact ? 200 : 404); response.end(exact?.bytes); return
    }
    const registryUrl = env.npm_config_registry
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ name, "dist-tags": { latest: releases.at(-1).manifest.version }, versions: Object.fromEntries(releases.map((value) => [value.manifest.version, {
      ...value.manifest, dist: { tarball: `${registryUrl}${name}/-/${name}-${value.manifest.version}.tgz`, integrity: value.integrity },
    }])) }))
  })
  registry.listen(0, "127.0.0.1"); await once(registry, "listening")
  env.npm_config_registry = `http://127.0.0.1:${registry.address().port}/`
  }
  const publicPort = await port(); const base = `http://127.0.0.1:${publicPort}`
  evidence.registry = env.npm_config_registry; evidence.url = base
  let launcherLog = ""
  function launch() {
    launcher = spawn(process.execPath, [npmCli, "exec", "--yes", `--package=frizz@${shell.manifest.version}`, "--", "frizz", "--no-app", "--port", String(publicPort)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
    launcher.stdout.on("data", (b) => { launcherLog += b }); launcher.stderr.on("data", (b) => { launcherLog += b })
  }
  launch()
  const status = async () => {
    const response = await fetch(`${base}/_frizz/control/status`, { headers: { origin: base }, signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 200); return response.json()
  }
  const before = await until("cold package boot", async () => {
    const state = await status(); return state.state === "ready" ? state : undefined
  })
  assert.equal(before.version, server.manifest.version)
  assert.equal(before.launcherVersion, shell.manifest.version)
  const owner = await until("stable launcher owner", () => ownerAddress())
  const childBefore = await until("cold control-plane generation", () => childGeneration())
  childPids.add(childBefore.pid)
  assert.ok(alive(owner.pid), `stable launcher ${owner.pid} is alive`)
  assert.equal(owner.port, publicPort)
  evidence.cold = { ownerPid: owner.pid, npmExecPid: launcher.pid, status: before, owner, child: childBefore }
  // What the launcher's npm install put on disk for this generation: the server and the watcher's
  // binary, with nothing resolved on this machine (scripts/lib/installed-closure.mjs).
  const releases = join(home, "cache", "frizz", "server-releases")
  const nodeModules = join(releases, readdirSync(releases).find((name) => /^[0-9a-f]{16}$/.test(name)), selected().id, "node_modules")
  evidence.cold.installed = installedPackages(nodeModules)
  assert.equal(closureProblem(nodeModules), null, `the server's install is not exact: ${evidence.cold.installed.join(" ")}`)
  assert.equal((await fetch(`${base}/_frizz/control/update-restart`, { method: "POST", headers: { origin: "https://example.invalid" } })).status, 403, "negative control: cross-origin update denied")
  browser = await launchHeadless()
  browserPid = browser.process()?.pid
  const page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  page.on("console", (message) => {
    if (message.type() !== "error") return
    const event = `console: ${message.text()} @ ${message.location().url}`
    if (message.location().url.includes("/_frizz/project-icon?") && message.text().includes("404")) expectedBrowserEvents.push(event)
    else if (restartRequested && message.location().url.startsWith(`${base}/_frizz/`) && message.location().url.includes("/rpc/") && message.text() === "Failed to load resource: the server responded with a status of 503 (Service Unavailable)") expectedBrowserEvents.push(`server handoff: ${event}`)
    else if (restartRequested && /^WebSocket connection to .*failed: (Connection closed before receiving a handshake response|Error during WebSocket handshake: Unexpected response code: 503)/u.test(message.text())) expectedBrowserEvents.push(`restart: ${event}`)
    else errors.push(event)
  })
  await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 })
  await page.goto(base, { waitUntil: "networkidle2" }); await page.screenshot({ path: join(out, "cold-desktop.png") })
  await page.setViewport({ width: 420, height: 880, deviceScaleFactor: 2 })
  await page.goto(base, { waitUntil: "networkidle2" }); await page.screenshot({ path: join(out, "cold-narrow.png") })
  assert.equal(errors.length, 0, errors.join("\n"))
  let currentVersion = server.manifest.version
  if (update) {
    const api = createRpcClient(base)
    // A machine-level setting with no visual effect. This was `font` until that key left Settings on
    // 2026-09-19; the schema strips a stored `font`, so the check below failed on every update after it.
    await api.mutate("settingsSet", { ...await api.query("settingsGet"), localFileOpener: "copy" })
    let thread, daemon
    const started = join(project, "worker-started"), finished = join(project, "worker-finished"), resumed = join(project, "worker-resumed")
    if (worker) {
      thread = await api.mutate("dispatch", {
        title: "Published update continuity", backend: "codex", model: "gpt-5.6-luna", effort: "medium",
        prompt: `Execute this single authorized test command, wait for completion, then reply CONTINUITY-OK and stop: python3 -c "import pathlib,time; pathlib.Path('${started}').write_text('started'); time.sleep(30); pathlib.Path('${finished}').write_text('finished')". No other actions.`,
      })
      await until("real worker running", () => existsSync(started), 180_000)
      daemon = workerRecord(); assert.ok(daemon)
    }
    let samples = 0
    monitor = setInterval(() => {
      const probe = status().then(() => { samples++ }).catch((error) => errors.push(`public listener: ${error}`)).finally(() => probes.delete(probe))
      probes.add(probe)
    }, 100)
    restartRequested = true
    await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 })
    const tenant = JSON.parse(readFileSync(join(home, "data/frizz/registry.json"), "utf8")).projects[0]
    await page.goto(`${base}/project/${tenant.slug}/`, { waitUntil: "networkidle2" })
    await page.waitForSelector('button[aria-label="Update Frizz"]:not(:disabled)', { visible: true })
    await page.screenshot({ path: join(out, "before-update.png") })
    const accepted = page.waitForResponse((response) => response.url().endsWith("/update-restart") && response.request().method() === "POST")
    await page.click('button[aria-label="Update Frizz"]')
    assert.equal((await accepted).status(), 202)
    const updated = await until("browser server update", async () => {
      const state = await status()
      return state.state === "ready" && state.version === update.manifest.version && state
    })
    await until("durable selection", () => selected().version === update.manifest.version)
    const next = childGeneration(); childPids.add(next.pid)
    assert.notEqual(next.pid, childBefore.pid)
    assert.equal(alive(childBefore.pid), false, "old server is dead after handoff")
    assert.equal(ownerAddress().pid, owner.pid)
    assert.equal(ownerAddress().port, publicPort)
    assert.ok(alive(owner.pid))
    assert.equal((await api.query("settingsGet")).localFileOpener, "copy", "settings survive server update")
    currentVersion = update.manifest.version
    evidence.update = { status: updated, child: next, owner: ownerAddress(), selection: selected(), integrity: update.integrity }
    if (worker) {
      assert.deepEqual(workerRecord(), daemon)
      await until("worker completed through update", () => existsSync(finished))
      await api.mutate("followUp", { ...thread, message: `Run one terminal command writing reconnected to ${resumed}, then answer RECONNECTED-OK and stop.` })
      await until("worker follow-up", () => existsSync(resumed), 180_000)
      const transcript = await until("follow-up answer", async () => {
        const value = await api.query("threadTranscript", { slug: thread.slug })
        return value.messages.some((message) => message.role === "assistant" && JSON.stringify(message).includes("RECONNECTED-OK")) && value
      })
      assert.deepEqual(workerRecord(), daemon)
      evidence.worker = { thread, daemon }
      writeFileSync(join(out, "worker-transcript.json"), JSON.stringify(transcript, null, 2))
    }
    clearInterval(monitor); await Promise.all([...probes])
    evidence.listenerSamples = samples; assert.ok(samples > 0)
    restartRequested = false
    await page.reload({ waitUntil: "networkidle2" })
    // The update installed the newest version the registry offers, so the button is in its greyed
    // "up to date" state (1ea81aa1, 2026-09-25), not the plain "Restart Frizz" one.
    await page.hover('button[aria-label="Frizz is up to date"]')
    await page.waitForSelector("#update-restart-popover", { visible: true })
    await until("updated version in browser", () => page.$eval("#update-restart-popover .font-mono", (el, version) => el.textContent.replace(/^Server /, "") === version, currentVersion))
    const popover = await page.$("#update-restart-popover")
    evidence.update.popover = await popover.evaluate((el) => el.textContent)
    await popover.screenshot({ path: join(out, "updated-popover.png") })
    await page.screenshot({ path: join(out, "updated-desktop.png") })
    await page.setViewport({ width: 420, height: 880, deviceScaleFactor: 2 })
    await page.screenshot({ path: join(out, "updated-narrow.png") })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  }
  const beforeRestart = childGeneration()
  restartRequested = true
  const restarting = await fetch(`${base}/_frizz/control/restart`, { method: "POST", headers: { origin: base } })
  assert.equal(restarting.status, 202)
  const after = await until("server restart", async () => {
    const state = await status(); return state.state === "ready" ? state : undefined
  })
  assert.equal(after.version, currentVersion)
  assert.equal(after.launcherVersion, shell.manifest.version)
  const childAfter = await until("restarted control-plane generation", () => {
    const next = childGeneration(); return next?.bootId && next.bootId !== beforeRestart.bootId ? next : undefined
  })
  childPids.add(childAfter.pid)
  const ownerAfter = ownerAddress()
  assert.equal(ownerAfter.pid, owner.pid, "restart keeps the stable launcher PID")
  assert.equal(ownerAfter.port, publicPort, "restart keeps the public listener")
  assert.ok(alive(owner.pid), "stable launcher remains alive after restart")
  restartRequested = false
  await page.goto(base, { waitUntil: "networkidle2" }); await page.screenshot({ path: join(out, "after-restart.png") })
  assert.equal(errors.length, 0, errors.join("\n"))
  evidence.restart = { status: after, ownerPid: ownerAfter.pid, port: ownerAfter.port, child: childAfter }
  if (update) {
    // A full launcher stop must not silently revert to the bootstrap pin on its next invocation.
    await browser.close(); browser = undefined
    process.kill(owner.pid, "SIGTERM")
    await until("launcher stopped", () => !alive(owner.pid) && !alive(launcher.pid) && !alive(childAfter.pid), 30_000)
    launch()
    const restored = await until("committed server selected on fresh launch", async () => {
      const value = await status(); return value.state === "ready" && value.version === currentVersion && value
    })
    childPids.add(childGeneration().pid)
    assert.notEqual(ownerAddress().pid, owner.pid)
    assert.equal(selected().version, currentVersion)
    evidence.relaunch = { status: restored, owner: ownerAddress(), child: childGeneration() }
  }
  evidence.packageGitHeads = { shell: shell.manifest.gitHead ?? null, server: server.manifest.gitHead ?? null }
  evidence.launcherLog = launcherLog
  writeFileSync(join(out, "result.json"), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  clearInterval(monitor); await Promise.allSettled([...probes])
  workerRecord()
  for (const pid of workerPids) if (alive(pid)) process.kill(pid, "SIGTERM")
  if (browser) await browser.close()
  const lastChild = childGeneration()
  if (lastChild?.pid) childPids.add(lastChild.pid)
  const owner = ownerAddress()
  if (owner?.pid && alive(owner.pid)) process.kill(owner.pid, "SIGTERM")
  if (launcher && launcher.exitCode === null) launcher.kill("SIGTERM")
  if (owner?.pid) await until("stable launcher cleanup", () => !alive(owner.pid), 30_000)
  if (launcher?.pid) await until("npm exec cleanup", () => !alive(launcher.pid), 30_000)
  await until("server child cleanup", () => [...childPids].every((pid) => !alive(pid)), 30_000)
  if (browserPid) await until("browser cleanup", () => !alive(browserPid), 30_000)
  await until("worker cleanup", () => [...workerPids].every((pid) => !alive(pid)), 30_000)
  if (registry) await new Promise((done) => registry.close(done))
  evidence.cleanup = { npmExecAlive: launcher?.pid ? alive(launcher.pid) : false, stableLauncherAlive: owner?.pid ? alive(owner.pid) : false, browserAlive: browserPid ? alive(browserPid) : false, remainingChildren: [...childPids].filter(alive), remainingWorkers: [...workerPids].filter(alive) }
  writeFileSync(join(out, "cleanup.json"), `${JSON.stringify(evidence.cleanup, null, 2)}\n`)
  rmSync(root, { recursive: true, force: true })
}
