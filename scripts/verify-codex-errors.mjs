// Replay provider records through a built artifact's real tailer, board, RPC and browser. No live
// worker is dispatched: the policy-error fixture is captured evidence, not another policy request.
// VERIFY_PACKAGE=/path/to/installed/frizz exercises the published npm package instead of a source build.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"
import { once } from "node:events"
import puppeteer from "puppeteer"
import { buildFrizzArtifact } from "../src/artifacts.ts"
import { resolveProject } from "../packages/server/src/project.ts"
import { findByPath } from "../packages/server/src/project-registry.ts"
import { createStorage } from "../packages/server/src/storage.ts"
import { acquireProjectLaunchOwner, projectLaunchEnvironment } from "../packages/server/src/project-launch.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"

const source = resolve(import.meta.dirname, "..")
const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-codex-errors-")))
const home = join(root, "home")
const projectDir = join(root, "project")
const shots = resolve(process.env.VERIFY_SHOTS ?? join(source, ".adhoc-shots", "codex-errors"))
const port = Number(process.env.VERIFY_PORT ?? 49537)
const api = createRpcClient(`http://127.0.0.1:${port}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let server, browser, owner
let output = ""
let storage
const record = (payload, at) => JSON.stringify({ timestamp: at, type: "event_msg", payload }) + "\n"
const stopServer = async () => {
  if (!server || server.exitCode !== null) return
  const exited = once(server, "exit")
  server.kill("SIGTERM")
  const timeout = setTimeout(() => server.kill("SIGKILL"), 10_000)
  try { await exited } finally { clearTimeout(timeout) }
}
const until = async (predicate, label) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) throw new Error(`Server exited while ${label}: ${output}`)
    const value = await predicate()
    if (value) return value
    await sleep(250)
  }
  throw new Error(`Timed out ${label}: ${output.slice(-4000)}`)
}

try {
  for (const dir of [join(home, ".frizz"), projectDir, shots]) mkdirSync(dir, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: projectDir })
  const project = resolveProject(projectDir, home)
  const projectSlug = findByPath(projectDir, home).slug
  const target = { projectId: project.id, projectDir, stateDir: project.stateDir }
  owner = acquireProjectLaunchOwner(target, "launcher")
  storage = createStorage(join(home, ".frizz", "ui.db"), project.id)
  const nativeId = randomUUID()
  const sessionId = randomUUID()
  const at = new Date(Date.now() - 20_000).toISOString()
  const failedAt = new Date(Date.now() - 10_000).toISOString()
  const message = "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber"
  const logDir = join(home, ".codex", "sessions", "2026", "09", "06")
  mkdirSync(logDir, { recursive: true })
  const rollout = join(logDir, `rollout-2026-09-06T08-31-17-${nativeId}.jsonl`)
  writeFileSync(rollout, JSON.stringify({ timestamp: at, type: "session_meta", payload: { id: nativeId, cwd: projectDir, source: "exec" } }) + "\n"
    + record({ type: "user_message", message: "Run the requested validation." }, at)
    + record({ type: "task_started" }, at)
    + record({ type: "task_complete", last_agent_message: null, error: { message, codex_error_info: "cyber_policy" } }, failedAt))
  storage.upsertSession({ slug: "policy-failure", session_id: sessionId, thread_name: "frizz-policy-failure", spawned_at: at,
    backend: "codex", agent_session_id: nativeId, codex_runtime: "app-server", model: "gpt-6-astra", effort: "high",
    title: "Provider failure regression", title_auto: 0, title_locked: 1, state: "open", exited: 0, archived: 0,
    last_read_at: null, unread: 1, rested_at: failedAt, meta: null, seen_at: null, transcript_id: null })
  storage.db.prepare("UPDATE session SET backend = 'codex', codex_runtime = 'app-server', agent_session_id = ? WHERE project_id = ? AND slug = 'policy-failure'").run(nativeId, project.id)
  storage.close()
  storage = undefined

  const packageDir = process.env.VERIFY_PACKAGE ? resolve(process.env.VERIFY_PACKAGE) : undefined
  console.log(packageDir ? "Verifying the installed npm package" : "Building the artifact")
  const artifact = packageDir ? {
    runtimeDir: join(packageDir, "runtime"), webDir: join(packageDir, "web-dist"), digest: undefined,
  } : buildFrizzArtifact(source, join(root, "artifacts"))
  const boot = async () => {
    output = ""
    server = spawn(process.execPath, [packageDir ? join(packageDir, "dist", "dev-child.js") : join(artifact.runtimeDir, "src", "index.js")], {
      cwd: projectDir,
      env: projectLaunchEnvironment({ ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"),
        FRIZZ_DEV_CHILD: "1", FRIZZ_DEV_PORT: String(port), FRIZZ_WAKERS_OFF: "1", FRIZZ_ORPHAN_REAPER_OFF: "1", FRIZZ_TENANT_PRIME_OFF: "1",
        FRIZZ_RUNTIMES_DIR: join(homedir(), ".frizz", "runtimes"), FRIZZ_STABLE_ARTIFACT: artifact.digest,
        FRIZZ_STABLE_WEB_DIST: artifact.webDir, FRIZZ_SCRIPTS_DIR: join(artifact.runtimeDir, "board"), FRIZZ_WORKER_PLUGIN_DIR: join(artifact.runtimeDir, "cc-worker") }, target, owner.token),
      stdio: ["ignore", "pipe", "pipe"],
    })
    server.stdout.on("data", (chunk) => { output += chunk })
    server.stderr.on("data", (chunk) => { output += chunk })
    assert.ok(await api.waitForHealth(40_000), output)
  }
  const thread = async () => (await api.query("board")).threads.find((row) => row.id === "policy-failure")
  await boot()
  await until(async () => (await thread())?.providerError?.code === "cyber_policy", "reading the failure on the board")
  const transcript = await api.query("threadTranscript", { slug: "policy-failure" })
  assert.equal(transcript.messages.filter((entry) => entry.providerError).length, 1)
  console.log("PASS packaged tailer → board → transcript preserves the captured error")
  await stopServer()
  await boot()
  await until(async () => (await thread())?.providerError?.code === "cyber_policy", "restoring the failure after restart")
  console.log("PASS restart reconstructs the error from the durable rollout")

  browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: ["--no-sandbox", "--force-color-profile=srgb", "--disable-gpu"] })
  const page = await browser.newPage()
  const errors = []
  let controlStatusMisses = 0
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("console", (entry) => {
    // This artifact child deliberately has no launcher control plane. Its status 404 is expected;
    // every application error and every other missing resource still fails this test.
    if (entry.type() === "error" && entry.location().url !== `${api.origin}/_frizz/control/status`) errors.push(`${entry.text()} ${entry.location().url ?? ""}`)
  })
  page.on("response", (response) => {
    if (response.status() === 404 && response.url() === `${api.origin}/_frizz/control/status`) controlStatusMisses++
    else if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
  })
  const screenshotCard = async (name) => {
    const clip = await page.$eval('[data-codex-error="cyber_policy"]', (node) => {
      node.scrollIntoView({ block: "center", behavior: "instant" })
      const rect = node.getBoundingClientRect()
      return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height }
    })
    console.log(`Capturing ${name}: ${JSON.stringify(clip)}`)
    await page.screenshot({ path: join(shots, name), clip, captureBeyondViewport: false })
  }
  const url = `${api.origin}/project/${projectSlug}/thread/policy-failure`
  for (const font of ["sans", "mono"]) {
    await api.mutate("settingsSet", { ...await api.query("settingsGet"), font })
    await page.evaluateOnNewDocument((font) => { localStorage.setItem("frizz-font", font) }, font)
    for (const width of [1000, 390]) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 2 })
      await page.goto(url, { waitUntil: "networkidle2" })
      await page.waitForSelector('[data-codex-error="cyber_policy"]', { visible: true })
      await page.evaluate((font) => { document.documentElement.dataset.font = font }, font)
      assert.equal(await page.$$eval('[data-rested-card="bare"]', (nodes) => nodes.length), 0)
      const card = await page.$('[data-codex-error="cyber_policy"]')
      assert.equal(await page.$$eval('[data-codex-error="cyber_policy"]', (nodes) => nodes.length), 1, "the latest failure is not duplicated by the status ladder")
      const bounds = await card.evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth }))
      assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify(bounds))
      await screenshotCard(`${font}-${width}.png`)
      console.log(`Captured ${font} ${width}px`)
    }
    await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 6 })
    await page.goto(url, { waitUntil: "networkidle2" })
    await page.waitForSelector('[data-codex-error="cyber_policy"]', { visible: true })
    const card = await page.$('[data-codex-error="cyber_policy"]')
    const alignment = await card.evaluate((card) => {
      const label = card.querySelector("div > span")
      const text = label.firstChild
      const span = document.createElement("span")
      label.insertBefore(span, text)
      span.appendChild(text)
      const probe = document.createElement("span")
      probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
      span.appendChild(probe)
      const baseline = probe.getBoundingClientRect().bottom
      const style = getComputedStyle(span)
      const font = style.fontFamily
      const context = document.createElement("canvas").getContext("2d")
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} / ${style.lineHeight} ${style.fontFamily}`
      const capCenter = baseline - context.measureText("H").actualBoundingBoxAscent / 2
      probe.remove()
      label.insertBefore(text, span)
      span.remove()
      const shapes = [...card.querySelectorAll("svg path,svg line,svg circle")].map((node) => node.getBoundingClientRect())
      const iconCenter = (Math.min(...shapes.map((r) => r.top)) + Math.max(...shapes.map((r) => r.bottom))) / 2
      return { capCenter, iconCenter, residual: iconCenter - capCenter, font }
    })
    writeFileSync(join(shots, `alignment-${font}.json`), JSON.stringify(alignment, null, 2))
    await screenshotCard(`${font}-detail.png`)
    console.log(`Measured title/icon alignment ${font}: ${JSON.stringify(alignment)}`)
  }
  assert.deepEqual(errors, [])
  console.log(`PASS error card replaces the sign-off card at desktop and narrow widths in both fonts; no application errors (${controlStatusMisses} expected status 404s from the absent launcher control plane)`)
  await browser.close()
  browser = undefined

  for (const font of ["sans", "mono"]) {
    await api.mutate("settingsSet", { ...await api.query("settingsGet"), font })
    const before = `document.documentElement.dataset.font=${JSON.stringify(font)}`
    const metrics = execFileSync("nub", [join(source, "scripts/ink-gaps.mjs"), url,
      '[data-codex-error] > div:first-child > span,[data-codex-error] > div:first-child > svg', "--w=1000", "--h=900", "--dsf=6", "--software", "--viewport-only", `--before=${before}`], { cwd: source, encoding: "utf8" })
    writeFileSync(join(shots, `ink-${font}.txt`), metrics)
    console.log(`PASS optical-spacing instrument ${font}: ${join(shots, `ink-${font}.txt`)}`)
  }

  const resumedAt = new Date().toISOString()
  appendFileSync(rollout, record({ type: "user_message", message: "Continue." }, resumedAt)
    + record({ type: "task_started" }, resumedAt)
    + record({ type: "agent_message", phase: "final_answer", message: "Recovered." }, resumedAt)
    + record({ type: "task_complete", last_agent_message: "Recovered.", error: null }, resumedAt))
  await until(async () => { const row = await thread(); return row?.lastAssistant === "Recovered." && row.providerError === undefined }, "clearing the current failure after recovery")
  assert.equal((await api.query("threadTranscript", { slug: "policy-failure" })).messages.filter((entry) => entry.providerError).length, 1)
  console.log("PASS successful recovery clears the current failure while preserving its history")
  console.log(JSON.stringify({ artifact: artifact.digest, shots }))
} finally {
  await browser?.close()
  await stopServer()
  owner?.release()
  storage?.close()
  rmSync(root, { recursive: true, force: true })
  console.log("CLEANUP owned browser and server closed; isolated state removed")
}
