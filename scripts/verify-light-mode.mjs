import assert from "node:assert/strict"
import { spawn, execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { once } from "node:events"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { seedLightModeFixture } from "./lib/light-mode-fixture.mjs"
import { RestartSupervisorProxy } from "../packages/server/src/restart-supervisor.ts"
import { checkThemePreferences, checkRichRendererState, checkLoginTerminal, checkIframeFirstPaint } from "./lib/light-mode-browser-checks.mjs"
import { measureTextContrast, measureAppearanceInk } from "./lib/light-mode-contrast.mjs"
import { checkSurfaceStates } from "./lib/light-mode-surfaces.mjs"

const source = resolve(fileURLToPath(new URL("..", import.meta.url)))
const baseline = process.argv.includes("--baseline")
const out = resolve(process.env.THEME_EVIDENCE_DIR ?? join(source, ".adhoc-shots/light-mode"))
const port = Number(process.env.THEME_VERIFY_PORT ?? 45891)
const root = mkdtempSync(join(tmpdir(), "frizz-light-qa-"))
const project = join(root, "theme-project")
const tenant = join(root, "second-project")
mkdirSync(out, { recursive: true })
for (const path of [project, tenant]) {
  mkdirSync(path)
  execFileSync("git", ["init", "-q"], { cwd: path })
  writeFileSync(join(path, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#52677a"/><path d="M7 7h10v3h-7v7H7z" fill="white"/></svg>')
}
let server
let browser
let page
let proxy
let serverLog = ""
const errors = []
const result = { mode: baseline ? "baseline" : "acceptance", cases: [], colors: {} }
const check = (label, detail) => { result.cases.push({ label, detail }); console.log(`PASS ${label}`, detail ?? "") }
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FRIZZ_")))
env.BROWSER = "/usr/bin/true"

try {
  const ready = new Promise((resolveReady, reject) => {
    server = spawn("nub", [join(source, "scripts/adhoc-stack.mjs"), `--port=${port}`, `--project=${project}`, `--also-project=${tenant}`], { cwd: source, env, stdio: ["ignore", "pipe", "pipe"] })
    const timeout = setTimeout(() => reject(new Error(`Stack boot timed out\n${serverLog}`)), 90_000)
    server.on("exit", code => { clearTimeout(timeout); reject(new Error(`Stack exited ${code}\n${serverLog}`)) })
    for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => {
      serverLog += String(chunk)
      for (const line of serverLog.split("\n")) {
        if (!line.startsWith('{"url"')) continue
        try { const state = JSON.parse(line); clearTimeout(timeout); resolveReady(state) } catch {}
      }
    })
  })
  const stack = await ready
  proxy = new RestartSupervisorProxy({ port: port + 1, childPort: () => port, restart: async () => ({ state: "ready" }), status: () => ({ state: "ready" }) })
  await proxy.listen()
  stack.url = stack.url.replace(`:${port}`, `:${port + 1}`)
  stack.gridUrl = stack.gridUrl.replace(`:${port}`, `:${port + 1}`)
  console.log("STACK", JSON.stringify(stack))
  const api = createRpcClient(stack.gridUrl)
  await seedLightModeFixture(stack, api)
  const settings = await api.query("settingsGet")
  await api.mutate("settingsSet", { ...settings, font: "sans", projectRail: true })
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--no-sandbox", "--force-color-profile=srgb"], protocolTimeout: 120_000 })
  console.log("BROWSER", browser.process().pid)
  page = await browser.newPage()
  page.on("pageerror", error => errors.push(String(error)))
  page.on("console", message => { if (message.type() === "error") errors.push(`${message.text()} ${message.location().url ?? ""}`) })
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
  await page.goto(stack.url, { waitUntil: "networkidle2" })
  await page.waitForSelector("[data-status-row]", { timeout: 30_000 })
  check("Seeded threads reach the real board", await page.$$eval("[data-status-row]", rows => rows.length))

  const openSettings = async () => {
    await page.evaluate(async () => { const { store } = await import("/src/store.ts"); store.showSettings = true })
    await page.waitForSelector('header [title="Settings"]')
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".frizz-sheet-panel").parentElement).opacity === "1")
  }
  const closeSettings = async () => {
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector('header [title="Settings"]'))
  }
  const colors = async () => page.evaluate(() => {
    const css = getComputedStyle(document.documentElement)
    return Object.fromEntries(["bg", "panel", "panel-2", "elevated", "border", "border-strong", "fg", "user-bubble", "muted", "accent", "live", "watch", "idle", "shell"].map(k => [k, css.getPropertyValue(`--color-${k}`).trim()]))
  })
  const screen = async name => { await page.screenshot({ path: join(out, `${name}.png`) }); check(`Captured ${name}`) }
  const setTheme = async preference => {
    await page.evaluate(async preference => { const theme = await import("/src/lib/theme.ts"); theme.setThemePreference(preference) }, preference)
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, {}, preference === "system" ? "dark" : preference)
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame)
      await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))
    })
  }
  const palettes = baseline ? ["dark"] : ["dark", "light"]
  for (const font of process.argv.includes("--behavior-only") ? [] : ["sans", "mono"]) {
    await api.mutate("settingsSet", { ...settings, font, projectRail: true })
    await page.evaluate(font => localStorage.setItem("frizz-font", font), font)
    await page.reload({ waitUntil: "networkidle2" })
    for (const palette of palettes) {
      if (!baseline) await setTheme(palette)
      result.colors[palette] = await colors()
      if (palette === 'dark' && process.env.THEME_BASELINE_DIR) {
        const previous = JSON.parse(readFileSync(join(process.env.THEME_BASELINE_DIR, 'baseline.json'), 'utf8'))
        // The former non-static @theme dropped unused tokens (idle); compare every value it emitted.
        for (const [name, value] of Object.entries(previous.colors.dark)) if (value) assert.equal(result.colors.dark[name], value, `Dark ${name} matches the pre-feature runtime`)
      }
      await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
      await screen(`${baseline ? "baseline-" : ""}${palette}-${font}-board`)
      if (!baseline) result[`${palette}-${font}-board-contrast`] = await measureTextContrast(page)
      await openSettings()
      await screen(`${baseline ? "baseline-" : ""}${palette}-${font}-settings`)
      if (!baseline) {
        check(`${palette} ${font} Appearance ink alignment`, await measureAppearanceInk(page))
        result[`${palette}-${font}-settings-contrast`] = await measureTextContrast(page)
        const before = `(async () => { document.documentElement.dataset.font = ${JSON.stringify(font)}; (await import('/src/lib/theme.ts')).setThemePreference(${JSON.stringify(palette)}); (await import('/src/store.ts')).store.showSettings = true; await new Promise(r => setTimeout(r, 600)); })()`
        const ink = await promisify(execFile)("nub", [join(source, "scripts/ink-gaps.mjs"), stack.url, 'button[aria-label="Appearance"] > span,button[aria-label="Appearance"] > svg', `--browser=${browser.wsEndpoint()}`, "--dsf=8", "--w=1440", "--h=1000", "--wait=300", `--before=${before}`], { cwd: source, encoding: "utf8" })
        writeFileSync(join(out, `${palette}-${font}-ink.txt`), ink.stdout)
        await page.bringToFront()
        await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 8 })
        await (await page.$('button[aria-label="Appearance"]')).screenshot({ path: join(out, `${palette}-${font}-appearance-crop.png`) })
        await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
      }
      await closeSettings()
      await page.goto(`${stack.url}/thread/theme-rich/full`, { waitUntil: "networkidle2" })
      await page.waitForSelector('[data-mermaid-state="ready"]', { timeout: 45_000 })
      assert.equal(await page.$$eval('[data-mermaid-state="ready"]', nodes => nodes.length), 2)
      await page.waitForSelector('iframe[title="theme counter"]', { timeout: 20_000 })
      await screen(`${baseline ? "baseline-" : ""}${palette}-${font}-thread`)
      if (!baseline) result[`${palette}-${font}-thread-contrast`] = await measureTextContrast(page)
      await page.$eval('[data-drawer-transcript-scroll]', el => el.scrollTop = 0)
      await screen(`${baseline ? "baseline-" : ""}${palette}-${font}-code`)
      if (!baseline) result[`${palette}-${font}-code-contrast`] = await measureTextContrast(page)
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
      await screen(`${baseline ? "baseline-" : ""}${palette}-${font}-phone-thread`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No document-level horizontal overflow")
      await page.goto(stack.url, { waitUntil: "networkidle2" })
      await screen(`${baseline ? "baseline-" : ""}${palette}-${font}-phone-board`)
      if (!baseline) result[`${palette}-${font}-phone-contrast`] = await measureTextContrast(page)
      await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
      if (!baseline) await checkSurfaceStates({ page, url: stack.url, font, palette, out, check, result })
    }
  }
  if (!baseline && !process.argv.includes("--visual-only")) {
    await checkThemePreferences({ browser, url: stack.url, check })
    await setTheme("dark")
    await checkRichRendererState({ page, url: stack.url, check })
    await checkIframeFirstPaint({ browser, url: stack.url, check })
    await checkLoginTerminal({ page, url: stack.url, check, out })
  }
  const contrastFailures = Object.entries(result).filter(([key]) => key.startsWith('light-') && key.endsWith('-contrast')).flatMap(([surface, readings]) => readings.filter(reading => !reading.disabled && reading.ratio < 4.5).map(reading => ({ surface, ...reading })))
  assert.deepEqual(contrastFailures, [], "Light text meets 4.5:1 contrast on every sampled surface")
  assert.deepEqual(errors, [], "No console or page errors")
  check("Console and page errors are clean")
} catch (error) {
  if (page) await page.screenshot({ path: join(out, "failure.png") }).catch(() => {})
  result.failure = String(error.stack ?? error)
  throw error
} finally {
  result.errors = errors
  writeFileSync(join(out, "server.log"), serverLog)
  if (browser) { const pid = browser.process().pid; await browser.close(); check("Owned Chrome closed", pid) }
  if (proxy) await proxy.close()
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await once(server, "exit") }
  rmSync(root, { recursive: true, force: true })
  writeFileSync(join(out, `${baseline ? "baseline" : "acceptance"}.json`), JSON.stringify(result, null, 2))
  console.log("CLEANUP complete")
}
