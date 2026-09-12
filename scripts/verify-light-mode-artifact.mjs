import assert from "node:assert/strict"
import { execFileSync, execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, renameSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { request } from "node:http"
import puppeteer from "puppeteer"
import { buildFrizzArtifact, defaultArtifactRoot, promoteFrizzArtifact } from "../src/artifacts.ts"
import { acquireProjectLaunchOwner, projectLaunchEnvironment } from "../packages/server/src/project-launch.ts"
import { frizzPaths } from "../packages/server/src/frizz-paths.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { writeCloudConfig } from "../src/cloud.ts"
import { measureTextContrast, measureControlContrast } from "./lib/light-mode-contrast.mjs"

const source = resolve(fileURLToPath(new URL("..", import.meta.url)))
const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-light-artifact-")))
const home = join(root, "home")
const project = join(root, "project")
const state = join(home, ".frizz", "projects", randomUUID())
const port = Number(process.env.THEME_ARTIFACT_PORT ?? 45905)
const origin = `http://127.0.0.1:${port}`
const out = resolve(process.env.THEME_EVIDENCE_DIR ?? join(source, ".adhoc-shots/light-mode"))
for (const dir of [home, project, state, out]) mkdirSync(dir, { recursive: true })
execFileSync("git", ["init", "-q"], { cwd: project })
let server
let browser
let owner
let logs = ""
const evidence = { checks: [] }
const check = (label, detail) => { evidence.checks.push({ label, detail }); console.log(`PASS ${label}`, detail ?? "") }
const waitUntil = async (predicate, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`Artifact exited while ${label}\n${logs}`)
    const result = await predicate()
    if (result) return result
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`Timed out ${label}\n${logs}`)
}
try {
  const artifactRoot = defaultArtifactRoot(home)
  console.log("Building the immutable artifact")
  const artifact = buildFrizzArtifact(source, artifactRoot)
  evidence.digest = artifact.digest
  promoteFrizzArtifact(state, artifact.digest, artifactRoot)
  writeCloudConfig({ hostname: "light-mode.invalid", serve: "external", provider: "other" }, home)
  const target = { projectId: state.split("/").at(-1), projectDir: project, stateDir: state }
  owner = acquireProjectLaunchOwner(target, "launcher")
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("FRIZZ_")))
  const env = projectLaunchEnvironment({ ...clean, HOME: home, FRIZZ_DIRECT_SUPERVISOR: "1", FRIZZ_STABLE_ARTIFACT: artifact.digest, FRIZZ_STABLE_WEB_DIST: artifact.webDir, FRIZZ_RUNTIMES_DIR: join(frizzPaths({ home: homedir() }).cache, "runtimes"), FRIZZ_WAKERS_OFF: "1", FRIZZ_ORPHAN_REAPER_OFF: "1", FRIZZ_TENANT_PRIME_OFF: "1", BROWSER: "/usr/bin/true" }, target, owner.token)
  server = spawn(process.execPath, [join(artifact.runtimeDir, "src", "index.js"), "--no-app", `--port=${port}`], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { logs += String(chunk) })
  const api = createRpcClient(origin)
  await waitUntil(async () => { try { return await api.waitForHealth(500) } catch { return false } }, "waiting for promoted server")
  check("Promoted artifact serves the real UI", artifact.digest)
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  const pageErrors = []
  page.on("pageerror", error => pageErrors.push(String(error)))
  await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 1 })
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
  await page.evaluateOnNewDocument(() => localStorage.setItem("frizz-theme", "light"))
  await page.goto(origin, { waitUntil: "networkidle2" })
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light")
  assert.equal(await page.evaluate(() => [...document.scripts].some(script => script.src.includes("/assets/"))), true)
  const tokenNames = [...readFileSync(join(source, 'packages/web/src/theme.css'), 'utf8').matchAll(/(--[\w-]+):/g)].map(match => match[1])
  const missingTokens = await page.evaluate(names => {
    const css = getComputedStyle(document.documentElement)
    return [...new Set(names)].filter(name => !css.getPropertyValue(name).trim())
  }, tokenNames)
  assert.deepEqual(missingTokens, [], 'The production build retains every CSS palette token, including adapter-only colors')
  const canvas = await page.evaluate(() => ({ color: getComputedStyle(document.documentElement).backgroundColor, chrome: document.querySelector('meta[name="theme-color"]').content }))
  const lock = await waitUntil(async () => { try { const lock = JSON.parse(readFileSync(join(state, "server.lock"), "utf8")); return lock.pid && lock.pid !== server.pid ? lock : false } catch { return false } }, "finding the exact disposable child")
  // Remove only this disposable artifact's assets: its verified child cannot restart, while the
  // already-loaded promoted supervisor must still serve its self-contained recovery document.
  renameSync(artifact.webDir, `${artifact.webDir}.unavailable`)
  process.kill(lock.pid, "SIGKILL")
  await waitUntil(async () => {
    const response = await fetch(`${origin}/_frizz/control/status`, { headers: { origin } })
    if (!response.ok) throw new Error(`Supervisor status refused: ${response.status} ${await response.text()}`)
    const status = await response.json()
    return status.state !== "ready"
  }, "waiting for recovery")
  const requests = []
  page.on("request", req => requests.push({ url: req.url(), type: req.resourceType() }))
  const response = await page.goto(`${origin}/project/project/thread/example/full`, { waitUntil: "networkidle2" })
  assert.equal(response.status(), 503)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light")
  const recovery = await page.evaluate(() => ({ color: getComputedStyle(document.documentElement).backgroundColor, chrome: document.querySelector('meta[name="theme-color"]').content }))
  assert.deepEqual(recovery, canvas)
  assert.deepEqual(requests.filter(req => ["stylesheet", "script", "font"].includes(req.type)), [])
  await page.screenshot({ path: join(out, "light-artifact-recovery.png") })
  check("Recovery paints persisted Light without web assets", { canvas, recovery })
  const darkPage = await browser.newPage()
  await darkPage.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }])
  await darkPage.evaluateOnNewDocument(() => localStorage.setItem("frizz-theme", "dark"))
  await darkPage.goto(origin, { waitUntil: "networkidle2" })
  assert.equal(await darkPage.evaluate(() => document.documentElement.dataset.theme), "dark")
  await darkPage.screenshot({ path: join(out, "dark-artifact-recovery.png") })
  check("Recovery honors explicit Dark against light OS")
  for (const font of ['sans', 'mono']) for (const width of [1000, 390]) {
    await page.setViewport({ width, height: 800, deviceScaleFactor: 1 })
    await page.evaluate(font => { document.documentElement.dataset.font = font }, font)
    const text = await measureTextContrast(page)
    const controls = await measureControlContrast(page, [{ label: 'Recovery retry border', selector: '.btn', property: 'borderTopColor' }])
    assert.deepEqual(text.filter(r => !r.disabled && r.ratio < 4.5), [], 'Recovery readable text')
    assert.deepEqual(controls.filter(r => r.ratio < 3), [], 'Recovery control boundaries')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: join(out, `light-${font}-${width}-recovery.png`) })
    check(`Promoted recovery ${font} ${width}px contrast and overflow`, { text, controls })
    if (width === 1000) {
      const ink = await promisify(execFile)('nub', [join(source, 'scripts/ink-gaps.mjs'), origin, '.actions > .btn:nth-child(1),.actions > .btn:nth-child(2)', `--browser=${browser.wsEndpoint()}`, '--dsf=8', '--w=1000', '--h=800', '--wait=100', `--before=document.documentElement.dataset.theme='light';document.documentElement.dataset.font='${font}'`], { encoding: 'utf8', cwd: source })
      writeFileSync(join(out, `light-${font}-recovery-ink.txt`), ink.stdout)
      await page.bringToFront()
      await page.setViewport({ width, height: 800, deviceScaleFactor: 8 })
      await (await page.$('main')).screenshot({ path: join(out, `light-${font}-recovery-crop.png`) })
      await page.setViewport({ width, height: 800, deviceScaleFactor: 1 })
    }
  }
  const systemPage = await browser.newPage()
  systemPage.on('pageerror', error => pageErrors.push(String(error)))
  await systemPage.evaluateOnNewDocument(() => localStorage.removeItem('frizz-theme'))
  for (const os of ['light', 'dark']) {
    await systemPage.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: os }])
    await systemPage.goto(origin, { waitUntil: 'networkidle2' })
    assert.equal(await systemPage.evaluate(() => document.documentElement.dataset.theme), os)
  }
  check('Recovery System resolves the OS on each real navigation')
  const anonymous = await new Promise((resolveResponse, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", headers: { host: "light-mode.invalid" } }, res => { let body = ""; res.on("data", chunk => { body += chunk }); res.on("end", () => resolveResponse({ status: res.statusCode, body })) })
    req.on("error", reject)
    req.end()
  })
  assert.equal(anonymous.status, 401)
  assert.doesNotMatch(anonymous.body, /frizz|board|agent/i)
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }])
  await page.setContent(anonymous.body)
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), "light")
  await page.screenshot({ path: join(out, "light-anonymous-refusal.png") })
  check("Anonymous artifact response follows the OS without product disclosure")
  assert.deepEqual(pageErrors, [])
  check("Promoted recovery has no page errors")
} catch (error) {
  evidence.failure = String(error.stack ?? error)
  throw error
} finally {
  if (browser) { await browser.close(); check("Owned artifact Chrome closed") }
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await once(server, "exit") }
  owner?.release()
  writeFileSync(join(out, "artifact.json"), JSON.stringify(evidence, null, 2))
  writeFileSync(join(out, "artifact-server.log"), logs)
  rmSync(root, { recursive: true, force: true })
  console.log("CLEANUP complete")
}
