// Real npm artifacts -> stable launcher -> real server -> browser. No public package publication.
// Build first: nub scripts/prepare-package.mjs --server && nub scripts/build-package.mjs --server
//   && nub scripts/build-package.mjs --shell
// Run: nub scripts/verify-server-updates.mjs --out=/absolute/evidence
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { once } from "node:events"
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { launchHeadless } from "./lib/headless-browser.mjs"
import { resolveNpmCli } from "../src/server-release.ts"
import { SESSION_EPOCH } from "../packages/server/src/access-codes.ts"
import { frizzPaths } from "../packages/server/src/frizz-paths.ts"
import { ensureProjectIdFile } from "../packages/server/src/project-root.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"

const workspace = resolve(import.meta.dirname, "..")
const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const out = resolve(argument("out") ?? mkdtempSync(join(tmpdir(), "frizz-server-evidence-")))
mkdirSync(out, { recursive: true })
const root = mkdtempSync(join(tmpdir(), "frizz-server-e2e-"))
const home = join(root, "home"), repo = join(root, "project"), eventFile = join(root, "children.jsonl")
mkdirSync(home); mkdirSync(repo)
// Resolved now: the last scenario deletes the folder, and cleanup still needs both spellings.
const repoPaths = new Set([repo, realpathSync(repo)])
writeFileSync(eventFile, "")
const runtime = argument("node") ?? process.execPath
const npmCli = resolveNpmCli(process.env, runtime)
const runtimeVersion = execFileSync(runtime, ["--version"], { encoding: "utf8" }).trim()
const workerBackends = argument("worker")?.split(",") ?? []
if (workerBackends.includes("codex")) {
  mkdirSync(join(home, ".codex"))
  cpSync(join(process.env.HOME, ".codex/auth.json"), join(home, ".codex/auth.json"))
}
if (workerBackends.includes("claude")) {
  for (const name of [".claude", ".claude.json"]) symlinkSync(join(process.env.HOME, name), join(home, name))
}
writeFileSync(join(repo, "FRIZZ.md"), "This is a disposable upgrade test project. Follow the exact test prompt; do not inspect other repositories, create goals, delegate, commit, or perform unrelated work. Once the requested command finishes, answer and stop.\n")
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FRIZZ_|npm_|NPM_|NODE_OPTIONS|NODE_PATH|CODEX_HOME)/u.test(key)))
Object.assign(env, {
  PATH: `${dirname(runtime)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
  npm_config_cache: join(root, "npm-cache"), npm_config_userconfig: join(root, "empty.npmrc"),
  npm_config_fetch_retries: "0", FRIZZ_ORPHAN_REAPER_OFF: "1", FRIZZ_TEST_CHILD_EVENTS: eventFile,
  FRIZZ_RUNTIMES_DIR: join(frizzPaths().cache, "runtimes"),
})
writeFileSync(env.npm_config_userconfig, "")
execFileSync("git", ["init", "-q"], { cwd: repo })
// A launch opens the folder it is run in only when Frizz already knows it as a project. Anywhere
// else it lands on the dashboard, hosted on a folder of Frizz's own (49000c91), and no project is
// registered at all. Every scenario below is about the project the launcher was started in.
ensureProjectIdFile(repo, home)
const events = [], failures = [], consoleErrors = [], processes = []
const probes = new Set()
const workerPids = new Set()
// The launcher and server of a published release, which carries none of the fixtures' reporting.
const publishedPids = new Set()
const packages = new Map()
let browser, page, registry, base, shellPid, listenerMonitor, monitorEnabled = false
let downloadGate
// While set, the registry cannot say which frizz-server is latest: the launcher's probe fails.
let probeOutage = false
function record(event, data = {}) {
  const row = { at: new Date().toISOString(), event, ...data }
  events.push(row); console.log(JSON.stringify(row))
}
function children() { return readFileSync(eventFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) }
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
async function until(label, check, timeout = 90_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result } catch (error) { lastError = error }
    await delay(100)
  }
  throw new Error(`Timed out: ${label}${lastError ? `: ${lastError}` : ""}`)
}
function start(name, args, cwd = repo) {
  const child = spawn(runtime, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
  processes.push(child)
  child.stdout.on("data", (bytes) => appendFileSync(join(out, `${name}.log`), bytes))
  child.stderr.on("data", (bytes) => appendFileSync(join(out, `${name}.log`), bytes))
  child.on("error", (error) => failures.push({ process: name, error: String(error) }))
  child.on("exit", (code, signal) => record("exit", { name, pid: child.pid, code, signal }))
  return child
}
async function freePort() {
  const server = createNetServer()
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const port = server.address().port
  await new Promise((done) => server.close(done)); return port
}
function pack(directory, manifest) {
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest))
  const output = JSON.parse(execFileSync(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", out, "--cache", join(root, "packing-cache")], { cwd: directory, encoding: "utf8", env, maxBuffer: 4e6 }))
  // npm 12 answers `pack --json` with an object keyed by package name; npm 11 answered an array.
  const packed = Array.isArray(output) ? output[0] : Object.values(output)[0]
  const tarball = readFileSync(join(out, packed.filename))
  const release = { manifest, tarball, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` }
  if (!packages.has(manifest.name)) packages.set(manifest.name, { latest: manifest.version, releases: new Map() })
  packages.get(manifest.name).releases.set(manifest.version, release)
  return release
}
function serverFixture(version, fault) {
  const directory = join(root, `server-${version}`)
  cpSync(join(workspace, "packages/server-release"), directory, { recursive: true, filter: (source) => !source.includes("node_modules") })
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
  manifest.version = version
  if (fault === "epoch") manifest.frizzServer.dataEpoch++
  if (fault === "protocol") manifest.frizzServer.protocol++
  const entry = join(directory, "dist/dev-child.js")
  const instrumentation = `
import {appendFileSync as _proofAppend,readFileSync as _proofRead} from 'node:fs';
const _proof = (event) => _proofAppend(process.env.FRIZZ_TEST_CHILD_EVENTS, JSON.stringify({event,pid:process.pid,parent:process.ppid,version:${JSON.stringify(version)},node:process.version,at:Date.now()})+'\\n');
for (const row of _proofRead(process.env.FRIZZ_TEST_CHILD_EVENTS,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)) {if(row.event==='start' && row.pid!==process.pid) {try{process.kill(row.pid,0);_proof('overlapping-server')}catch{}}}
_proof('start'); process.on('exit',()=>_proof('exit'));
const _send = process.send.bind(process); process.send=(message,...args)=>{if(message.type==='frizz-ready'){_proof('ready');${fault === "crash" ? "setTimeout(()=>process.exit(86),100);" : ""}} return _send(message,...args)};
${fault === "exit" ? "throw new Error('INJECTED_BOOT_FAILURE');" : ""}
`
  let contents = readFileSync(entry, "utf8")
  if (fault === "hang") {
    const boot = /(?:const|var) server = await startServer\d*\(/u
    assert.ok(boot.test(contents), "hang injection must follow the real early disconnect guard")
    contents = contents.replace(boot, "await new Promise(()=>setInterval(()=>{},1000)); $&")
  }
  if (fault === "slow") {
    const boot = /(?:const|var) server = await startServer\d*\(/u
    assert.ok(boot.test(contents), "slow boot must follow the real early disconnect guard")
    assert.match(contents, /function createBootProgressPublisher\(/u, "use the artifact's real progress publisher")
    contents = contents.replace(boot, `
      const _progress = createBootProgressPublisher(target.stateDir);
      const _progressTimer = setInterval(() => _progress("runtimes: downloading slow fixture"), 500);
      await new Promise(resolve => setTimeout(resolve, 35_000));
      clearInterval(_progressTimer);
      $&`)
  }
  writeFileSync(entry, instrumentation + contents)
  if (fault === "missing") rmSync(join(directory, "web-dist/index.html"))
  // npm must not run this: an install that touches the sentinel is a test failure.
  manifest.scripts = { postinstall: `node -e "require('fs').writeFileSync(process.env.FRIZZ_TEST_CHILD_EVENTS+'.postinstall','bad')"` }
  return pack(directory, manifest)
}
async function status() {
  const response = await fetch(`${base}/_frizz/control/status`, { headers: { origin: base }, signal: AbortSignal.timeout(2000) })
  assert.equal(response.status, 200)
  return response.json()
}
async function action(name = "update-restart") {
  const response = await fetch(`${base}/_frizz/control/${name}`, { method: "POST", headers: { origin: base }, signal: AbortSignal.timeout(name === "restart" ? 90_000 : 5000) })
  assert.equal(response.status, 202)
}
async function healthy(version) {
  return until(`server ${version}`, async () => {
    const value = await status()
    return value.state === "ready" && value.version === version && value
  })
}
/** Everything every launcher has logged so far, whichever root this platform keeps a project's logs under. */
function launcherLogs(from = home) {
  let text = ""
  for (const base of ["data", "state"]) {
    const projects = join(from, base, "frizz/projects")
    if (!existsSync(projects)) continue
    for (const project of readdirSync(projects)) {
      const logs = join(projects, project, "logs")
      if (!existsSync(logs)) continue
      for (const name of readdirSync(logs).filter((file) => /^frizz-.*\.log$/.test(file))) text += readFileSync(join(logs, name), "utf8")
    }
  }
  return text
}
function selected(from = home) {
  const directory = join(from, "state/frizz/server-releases")
  const key = readdirSync(directory).find((name) => /^[0-9a-f]{16}$/.test(name))
  return JSON.parse(readFileSync(join(directory, key, "active.json"), "utf8"))
}
function workerRecord(backend) {
  const projects = join(home, "data/frizz/projects")
  for (const project of readdirSync(projects)) {
    for (const name of backend === "codex" ? ["codex-app-server-native", "codex-app-server"] : ["claude-broker"]) {
    const directory = join(projects, project, name)
    if (!existsSync(directory)) continue
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
      const value = JSON.parse(readFileSync(join(directory, file), "utf8"))
      const pid = value.listenerPid ?? value.daemonPid ?? value.pid
      if (Number.isInteger(pid) && alive(pid)) return { pid, childPid: value.childPid, generation: value.generation }
    }
    }
  }
  throw new Error(`No live ${backend} daemon record`)
}
async function stopShell(signal = "SIGTERM") {
  monitorEnabled = false
  await Promise.allSettled([...probes])
  if (shellPid && alive(shellPid)) process.kill(shellPid, signal)
  if (shellPid) await until(`shell ${shellPid} stopped`, () => !alive(shellPid), 30_000)
}
/** The folder a live process is standing in, where this platform lets another process read it. */
function cwdOf(pid) {
  if (process.platform === "linux") return realpathSync(`/proc/${pid}/cwd`)
  if (process.platform !== "darwin") return undefined
  return execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).split("\n").find((line) => line.startsWith("n"))?.slice(1)
}
// Releases this machine took long ago, what a killed install left behind, and a daemon still running
// out of the oldest of them: what the launcher's sweep has to tell apart (ServerReleaseStore.sweep).
// None is a real install. A sweep weighs a generation by its age and by what runs from it, and
// never opens one.
function seedOldReleases() {
  const directory = join(home, "cache/frizz/server-releases", createHash("sha256").update("frizz-server").digest("hex").slice(0, 16))
  const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const [running, unused, third, fourth] = ["0.1.1", "0.1.2", "0.1.3", "0.1.4"].map((version, index) => {
    const path = join(directory, randomUUID()), packageRoot = join(path, "node_modules/frizz-server")
    mkdirSync(join(packageRoot, "dist"), { recursive: true })
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "frizz-server", version }))
    writeFileSync(join(packageRoot, "dist/claude-agent-broker.js"), "setInterval(() => {}, 1000)\n")
    utimesSync(path, daysAgo(10 - index), daysAgo(10 - index))
    return { version, path, daemon: join(packageRoot, "dist/claude-agent-broker.js") }
  })
  const unfinished = join(directory, `${randomUUID()}.staging`)
  mkdirSync(unfinished); utimesSync(unfinished, daysAgo(3), daysAgo(3))
  start("old-release-daemon", [running.daemon])
  return { running, unused, third, fourth, unfinished }
}
async function launch(version = "0.13.0", cwd = repo) {
  const before = children().length
  const child = start(`launcher-${processes.length}`, [npmCli, "exec", "--yes", `--package=frizz@${version}`, "--", "frizz", "--no-app", "--port", new URL(base).port], cwd)
  const entry = await until("server process", () => {
    if (child.exitCode !== null) throw new Error(`npm launcher exited ${child.exitCode}`)
    return children().slice(before).find((event) => event.event === "start")
  }, 180_000)
  shellPid = entry.parent
  record("shell-started", { pid: shellPid, npm: child.pid })
  return shellPid
}

async function secondLaunch(expectedExit) {
  const directory = join(root, "second-project")
  if (!existsSync(directory)) { mkdirSync(directory); execFileSync("git", ["init", "-q"], { cwd: directory }) }
  const before = children().length
  const child = start(`second-launch-${processes.length}`, [npmCli, "exec", "--yes", "--package=frizz@0.13.0", "--", "frizz", "--no-app"], directory)
  await until("second invocation exits without another server", () => child.exitCode !== null || child.signalCode !== null, 30_000)
  assert.equal(child.exitCode, expectedExit)
  assert.equal(children().slice(before).some((event) => event.event === "start"), false)
  record("second-project-launch-coalesced", { expectedExit })
}

try {
  const shellDir = join(root, "shell")
  mkdirSync(shellDir); cpSync(join(workspace, "dist"), join(shellDir, "dist"), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"))
  // These are local fixture coordinates, independent of either package's current release version.
  manifest.version = "0.13.0"
  manifest.frizzServer.version = "0.13.0"
  // A minimum is its own scenario, at the end; every shell before it declares none.
  delete manifest.frizzServer.minimum
  delete manifest.devDependencies; delete manifest.scripts; delete manifest.pnpm
  const shellRelease = pack(shellDir, manifest)
  const legacyTarball = argument("legacy-tarball")
  if (legacyTarball) {
    const tarball = readFileSync(legacyTarball)
    const legacy = JSON.parse(execFileSync("tar", ["-xOzf", legacyTarball, "package/package.json"], { encoding: "utf8" }))
    assert.equal(legacy.version, "0.12.10")
    packages.get("frizz").releases.set(legacy.version, { manifest: legacy, tarball, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` })
  }
  serverFixture("0.13.0")
  serverFixture("0.13.1", "slow")
  serverFixture("0.13.2", "epoch")
  serverFixture("0.13.3", "missing")
  serverFixture("0.13.4", "exit")
  serverFixture("0.13.5", "crash")
  serverFixture("0.13.6", "hang")
  serverFixture("0.13.7")
  serverFixture("0.13.8", "hang")
  serverFixture("0.13.9")
  serverFixture("0.13.10")
  serverFixture("0.13.11", "protocol")
  serverFixture("0.13.12")
  registry = createServer(async (request, response) => {
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
        const version = path.slice(path.lastIndexOf("/") + 1, -4)
        if (packageName === "frizz-server" && version === "0.13.9") { response.writeHead(503); response.end("INJECTED_DOWNLOAD_FAILURE"); return }
        if (packageName === "frizz-server" && version === "0.13.10") { response.writeHead(200); response.end("INJECTED_INTEGRITY_FAILURE"); return }
        if (packageName === "frizz-server" && downloadGate?.version === version) { downloadGate.requested = true; await downloadGate.promise }
        const release = entry.releases.get(version)
        response.writeHead(release ? 200 : 404); response.end(release?.tarball); return
      }
      if (packageName === "frizz-server" && probeOutage) { response.writeHead(503); response.end("INJECTED_REGISTRY_OUTAGE"); return }
      const versions = Object.fromEntries([...entry.releases].map(([version, release]) => [version, {
        ...release.manifest, dist: { tarball: `${env.npm_config_registry}${packageName}/-/${version}.tgz`, integrity: release.integrity },
      }]))
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ name: packageName, "dist-tags": { latest: entry.latest }, versions }))
    } catch (error) { response.writeHead(500); response.end(String(error)) }
  })
  registry.listen(0, "127.0.0.1"); await once(registry, "listening")
  env.npm_config_registry = `http://127.0.0.1:${registry.address().port}/`
  base = `http://127.0.0.1:${await freePort()}`
  record("fixture", { root, out, base, registry: env.npm_config_registry, shellIntegrity: shellRelease.integrity })
  const old = seedOldReleases()
  if (legacyTarball) {
    start("legacy-launcher", [npmCli, "exec", "--yes", "--package=frizz@0.12.10", "--", "frizz", "--no-app", "--port", new URL(base).port])
    await healthy("0.12.10")
    browser = await launchHeadless()
    page = await browser.newPage()
    const project = JSON.parse(readFileSync(join(home, "data/frizz/registry.json"), "utf8")).projects[0]
    await page.goto(`${base}/project/${project.slug}/`, { waitUntil: "networkidle2" })
    await page.waitForSelector('button[aria-label="Update Frizz"]', { visible: true })
    const accepted = page.waitForResponse((response) => response.url().endsWith("/update-restart") && response.request().method() === "POST").catch((error) => ({ error }))
    await page.click('button[aria-label="Update Frizz"]')
    const response = await accepted
    if (response.error) throw response.error
    assert.equal(response.status(), 202)
    const started = await until("legacy successor starts managed server", () => children().find((event) => event.event === "start"), 180_000)
    shellPid = started.parent
    record("legacy-browser-handoff", { shellPid })
  } else if (argument("singleton")) {
    let release
    downloadGate = { version: "0.13.0", requested: false, promise: new Promise((done) => { release = done }), release: () => release() }
    const boot = launch()
    await until("cold server download", () => downloadGate.requested)
    await secondLaunch(1)
    release(); downloadGate = undefined
    await boot
  } else await launch()
  const initialPid = shellPid
  await healthy("0.13.0")
  await until("initial selection committed", () => selected().version === "0.13.0")
  // A 0.12.10 launcher installs releases of its own first, which changes which two are the newest.
  if (!legacyTarball) {
    await until("the launcher swept what nothing runs from", () => !existsSync(old.unused.path) && !existsSync(old.unfinished), 30_000)
    assert.deepEqual([old.running, old.third, old.fourth].map((release) => existsSync(release.daemon)), [true, true, true], "the release a daemon runs from and the two newest are kept")
    await until("the sweep is in the log", () => launcherLogs().includes("old Frizz server releases: removed 0.1.2; removed 1 unfinished install; kept 0.1.1, still used by a running process"), 30_000)
    record("old-releases-swept-at-first-boot")
  }
  const registered = (directory) => JSON.parse(readFileSync(join(home, "data/frizz/registry.json"), "utf8")).projects.find((project) => project.path === realpathSync(directory))
  // The launch was typed in the project, and that is all the project is to the launcher: the server
  // runs on Frizz's own folder, and it was the SERVER that opened the project — registered it and
  // said where to land — when the launcher asked it (POST /_frizz/control/launch). A 0.12.10 launcher
  // predates all of this and still runs the server on the project.
  let opened
  if (!legacyTarball) {
    opened = await until("the server opened the project the launch was typed in", () => registered(repo), 30_000)
    await until("the launcher landed where the server said", () => launcherLogs().includes(`started Frizz at ${base}/project/${opened.slug}`), 30_000)
    assert.doesNotMatch(launcherLogs(), /did not say where this launch lands/, "the server answered; the launcher's own rules were not used")
    const server = children().find((event) => event.event === "ready").pid
    if (cwdOf(server) !== undefined) {
      assert.equal(cwdOf(server), realpathSync(join(home, "data/frizz/host")), "the server runs on Frizz's own folder, not the project")
      assert.equal(cwdOf(shellPid), realpathSync(repo), "the launcher stays in the folder the command was typed in")
    }
    // A second launch, typed in another project, joins this server and lands on THAT project.
    const other = join(root, "other-project")
    mkdirSync(other); execFileSync("git", ["init", "-q"], { cwd: other }); ensureProjectIdFile(other, home)
    const before = children().length
    const joining = start(`join-${processes.length}`, [npmCli, "exec", "--yes", "--package=frizz@0.13.0", "--", "frizz", "--no-app"], other)
    await until("the second launch exits", () => joining.exitCode !== null || joining.signalCode !== null, 60_000)
    assert.equal(joining.exitCode, 0)
    assert.equal(children().slice(before).some((event) => event.event === "start"), false, "a second launch starts no server")
    assert.ok(launcherLogs().includes(`reusing Frizz at ${base}/project/${registered(other).slug}`), "the second launch lands on the project it was typed in")
    record("server-routed-the-launch", { opened: opened.slug, joined: registered(other).slug, host: cwdOf(server) })
  }
  const api = createRpcClient(base, opened?.slug)
  await api.query("board")
  const workers = []
  for (const backend of workerBackends) {
    const started = join(repo, `${backend}-started`), finished = join(repo, `${backend}-finished`)
    const command = `python3 -c "import pathlib,time; pathlib.Path('${started}').write_text('started'); time.sleep(20); pathlib.Path('${finished}').write_text('finished')"`
    const thread = await api.mutate("dispatch", {
      title: `${backend} update continuity`, backend,
      model: backend === "codex" ? "gpt-5.6-luna" : "claude-haiku-4-5", effort: "medium",
      prompt: `This is an authorized bounded runtime test. Do not create subagents or goals. Execute exactly this single terminal command: ${command}\nWait for it to finish, then reply WORKER-CONTINUITY-OK and stop. No other tasks.`,
    })
    await until(`${backend} tool running`, () => existsSync(started), 180_000)
    workers.push({ backend, thread, finished, daemon: workerRecord(backend) })
    record("worker-command-started", { backend, thread })
  }
  listenerMonitor = setInterval(() => {
    if (monitorEnabled) {
      const probe = status().catch((error) => failures.push({ control: String(error) })).finally(() => probes.delete(probe))
      probes.add(probe)
    }
  }, 200)
  monitorEnabled = true
  browser ??= await launchHeadless()
  page ??= await browser.newPage()
  page.on("pageerror", (error) => failures.push({ page: String(error) }))
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()) })
  const project = opened ?? JSON.parse(readFileSync(join(home, "data/frizz/registry.json"), "utf8")).projects[0]
  await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 })
  await page.goto(`${base}/project/${project.slug}/`, { waitUntil: "networkidle2" })
  await page.screenshot({ path: join(out, "before-desktop.png") })
  // Slow transfer proves preparation does not stop the healthy child or its existing browser.
  let releaseDownload
  downloadGate = { version: "0.13.1", requested: false, promise: new Promise((done) => { releaseDownload = done }), release: () => releaseDownload() }
  packages.get("frizz-server").latest = "0.13.1"
  await action()
  await until("candidate download requested", () => downloadGate.requested)
  if (argument("singleton")) await secondLaunch(0)
  const oldPid = children().find((event) => event.event === "ready").pid
  assert.equal(alive(oldPid), true)
  await api.query("board")
  assert.equal(selected().version, "0.13.0")
  const restartDuringUpdate = action("restart").then(() => undefined, (error) => error)
  await Promise.all([action(), action()])
  releaseDownload(); downloadGate = undefined
  assert.equal(await restartDuringUpdate, undefined)
  await healthy("0.13.1")
  assert.equal(shellPid, initialPid)
  assert.equal(alive(initialPid), true)
  await until("selection version advanced", () => selected().version === "0.13.1")
  if (!legacyTarball) {
    // The update swept too, and removed nothing: 0.13.0 is what the launcher would roll back to, which
    // it holds, so 0.1.3 and 0.1.4 are still the two newest of the rest.
    const kept = "old Frizz server releases: kept 0.1.1, still used by a running process"
    await until("the update's sweep is in the log", () => launcherLogs().split(kept).length > 1, 30_000)
    assert.deepEqual([old.running, old.third, old.fourth].map((release) => existsSync(release.daemon)), [true, true, true])
    record("an-update-swept-and-removed-nothing-it-holds")
  }
  assert.equal(children().filter((event) => event.event === "start" && event.version === "0.13.1").length, 1)
  const slowStart = children().find((event) => event.event === "start" && event.version === "0.13.1")
  const slowReady = children().find((event) => event.event === "ready" && event.version === "0.13.1")
  assert.ok(slowReady.at - slowStart.at > 30_000, "a progressing boot must outlive the former flat 30s timeout")
  record("progressing-boot-passed", { elapsedMs: slowReady.at - slowStart.at })
  record("slow-update-and-concurrent-actions-passed", { pid: shellPid })
  for (const worker of workers) {
    assert.deepEqual(workerRecord(worker.backend), worker.daemon, "same detached provider daemon must survive the update")
    await until(`${worker.backend} command survived update`, () => existsSync(worker.finished), 90_000)
    const resumed = join(repo, `${worker.backend}-resumed`)
    await api.mutate("followUp", { ...worker.thread, message: `One final authorized test: run a terminal command that writes the text reconnected to ${resumed}, then answer RECONNECTED-OK and stop. No other actions.` })
    await until(`${worker.backend} follow-up after update`, () => existsSync(resumed), 180_000)
    const transcript = await until(`${worker.backend} terminal answer`, async () => {
      const transcript = await api.query("threadTranscript", { slug: worker.thread.slug })
      return transcript.messages.some((message) => message.role === "assistant" && JSON.stringify(message).includes("RECONNECTED-OK")) && transcript
    }, 90_000)
    writeFileSync(join(out, `${worker.backend}-transcript.json`), JSON.stringify(transcript, null, 2))
    record("worker-survived-and-answered-followup", { backend: worker.backend, thread: worker.thread, daemon: worker.daemon })
  }
  // The recovered board's control reads "Frizz is up to date" once the launcher has confirmed there
  // is nothing newer (greyed rather than hidden since 1ea81aa1), and "Restart Frizz" until then.
  await until("browser recovered", () => page.evaluate(() => !!document.querySelector('button[aria-label="Restart Frizz"], button[aria-label="Frizz is up to date"]')))
  if (argument("visual")) {
    for (const font of ["sans", "mono"]) {
      await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 6 })
      await api.mutate("settingsSet", { ...await api.query("settingsGet"), font })
      await page.reload({ waitUntil: "networkidle2" })
      await page.hover('button[aria-label="Restart Frizz"]')
      await page.waitForSelector("#update-restart-popover", { visible: true })
      await until("browser version poll catches up", () => page.evaluate(() => document.querySelector("#update-restart-popover .font-mono")?.textContent === "0.13.1"), 15_000)
      await delay(250)
      const panel = await page.$("#update-restart-popover")
      await panel.screenshot({ path: join(out, `versions-${font}.png`) })
      const measurements = await page.evaluate(() => {
        const row = document.querySelector("#update-restart-popover > div")
        const icon = row.firstElementChild.getBoundingClientRect()
        const text = row.lastElementChild.getBoundingClientRect()
        const bands = [...row.lastElementChild.children].map((span) => {
          const probe = document.createElement("span")
          probe.style.cssText = "display:inline-block;width:0;height:0"
          span.append(probe)
          const baseline = probe.getBoundingClientRect().bottom
          probe.remove()
          const cs = getComputedStyle(span), canvas = document.createElement("canvas").getContext("2d")
          canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
          const metric = canvas.measureText(span.textContent)
          return { top: baseline - metric.actualBoundingBoxAscent, bottom: baseline + metric.actualBoundingBoxDescent }
        })
        const inkCentre = (Math.min(...bands.map((band) => band.top)) + Math.max(...bands.map((band) => band.bottom))) / 2
        return { font: document.documentElement.dataset.font, boxGap: text.left - icon.right, groupCentreResidual: (icon.top + icon.bottom - text.top - text.bottom) / 2, inkGroupResidual: (icon.top + icon.bottom) / 2 - inkCentre, copy: row.textContent }
      })
      assert.equal(measurements.font, font)
      assert.ok(Math.abs(measurements.groupCentreResidual) < 0.2)
      assert.match(measurements.copy, /Restart Frizz0.13.1/)
      assert.doesNotMatch(measurements.copy, /Launcher/)
      record("version-optical-geometry", measurements)
      const ink = execFileSync(process.execPath, [join(workspace, "scripts/ink-gaps.mjs"), page.url(), "#update-restart-popover > div > span,#update-restart-popover > div > div", "--dsf=6", "--w=1280", "--h=850", `--before=document.documentElement.dataset.font='${font}'`, '--hover=button[aria-label="Restart Frizz"]'], { cwd: workspace, encoding: "utf8", timeout: 90_000, maxBuffer: 1e6 })
      writeFileSync(join(out, `ink-${font}.json`), ink)
    }
    await page.mouse.move(1000, 800)
    await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 })
  }
  await page.screenshot({ path: join(out, "after-desktop.png") })
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
  await delay(500)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: join(out, "after-narrow.png") })
  for (const [version, reason] of [["0.13.2", "incompatible epoch"], ["0.13.3", "missing asset"], ["0.13.4", "boot failure"], ["0.13.5", "early crash"], ["0.13.6", "boot timeout"], ["0.13.9", "download failure"], ["0.13.10", "integrity failure"], ["0.13.11", "incompatible protocol"]]) {
    packages.get("frizz-server").latest = version
    await action()
    if (version === "0.13.6" && argument("singleton")) {
      await until("candidate stalled before ready", () => children().some((event) => event.event === "start" && event.version === version))
      await secondLaunch(0)
    }
    const failed = await until(reason, async () => { const value = await status(); return value.state === "failed" && value })
    assert.equal(failed.version, "0.13.1")
    assert.equal(selected().version, "0.13.1")
    assert.equal(alive(initialPid), true)
    await api.query("board")
    record("candidate-rejected", { version, reason, status: failed })
  }
  packages.get("frizz-server").latest = "0.13.7"
  await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 })
  // Repeated failed boots can exhaust the recovery page's bounded polling budget. The rollback
  // server is healthy above; exercise its explicit retry link before using the app's update control.
  const retry = await page.$('a.btn')
  if (retry && await retry.evaluate((element) => element.textContent.trim() === "Try again")) {
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), retry.click()])
    record("browser-recovery-retry-passed", { url: page.url() })
  }
  await delay(600)
  // The real browser button sends the final recovery update, after all injected failures.
  await page.waitForSelector('button[aria-label="Update Frizz"]:not(:disabled)', { visible: true })
  record("browser-control", { url: page.url(), control: await page.$eval('button[aria-label="Update Frizz"]', (element) => element.outerHTML) })
  const accepted = page.waitForResponse((response) => response.url().endsWith("/update-restart") && response.request().method() === "POST").catch((error) => ({ error }))
  await page.click('button[aria-label="Update Frizz"]')
  const response = await accepted
  if (response.error) throw response.error
  assert.equal(response.status(), 202)
  await healthy("0.13.7")
  assert.equal(selected().version, "0.13.7")
  record("browser-update-after-failures-passed")
  // Kill the launcher while a candidate is stuck before ready. The early disconnect guard must
  // reclaim that child; a relaunch must choose the last committed server, not the pending package.
  packages.get("frizz-server").latest = "0.13.8"
  await action()
  const stuck = await until("hanging candidate started", () => children().find((event) => event.event === "start" && event.version === "0.13.8"))
  await stopShell("SIGKILL")
  await until("orphan candidate exited", () => !alive(stuck.pid), 20_000)
  assert.equal(selected().version, "0.13.7")
  packages.get("frizz-server").latest = "0.13.7"
  await launch(); await healthy("0.13.7")
  await api.query("board")
  record("crash-before-commit-recovered", { pid: shellPid })
  await stopShell("SIGKILL")
  await launch(); await healthy("0.13.7")
  record("committed-selection-survived-launcher-crash", { pid: shellPid })
  await stopShell()
  const saved = selected()
  rmSync(join(home, "cache/frizz/server-releases", createHash("sha256").update(saved.package).digest("hex").slice(0, 16), saved.id), { recursive: true })
  await launch(); await healthy("0.13.7")
  assert.equal(selected().version, "0.13.7")
  assert.notEqual(selected().id, saved.id)
  record("cache-eviction-restored-exact-version")
  if (!legacyTarball) {
    // By now this machine has taken several releases, so the two seeded ones are no longer among the
    // newest. The one a process still runs from is the only seeded release left.
    await until("the releases pushed out of the newest two are gone", () => !existsSync(old.third.path) && !existsSync(old.fourth.path), 30_000)
    assert.equal(existsSync(old.running.daemon), true)
    record("old-releases-swept-once-newer-ones-arrived")
  }
  // A probe the registry cannot answer changes nothing about the board, but it has to leave a
  // record. Every failure used to be swallowed, so a probe that could NEVER answer was invisible:
  // on 2026-10-11 a board had failed one every half hour for twenty hours, never offered an update,
  // and the first anyone knew was a failed click.
  await stopShell()
  assert.doesNotMatch(launcherLogs(), /could not check npm for a newer Frizz server/, "no probe has failed yet")
  probeOutage = true
  await launch(); await healthy("0.13.7")
  await until("the failed probe is logged", () => /could not check npm for a newer Frizz server: .*INJECTED_REGISTRY_OUTAGE|could not check npm for a newer Frizz server: .*503/su.test(launcherLogs()), 60_000)
  probeOutage = false
  await api.query("board")
  record("failed-probe-logged")
  // The folder Frizz was started FROM is deleted while it runs. On 2026-10-11 a board started in a
  // scratch folder that was removed a day later could no longer update or restart: the server ran ON
  // that folder, and nothing forks into a directory that is gone. The folder is now only where the
  // command was typed — the server runs on Frizz's own — so the board restarts and updates with it
  // gone, and with the launcher itself left standing in a directory that no longer exists.
  const serving = children().filter((event) => event.event === "ready").at(-1).pid
  rmSync(repo, { recursive: true, force: true })
  const machine = createRpcClient(base)
  await action("restart")
  const restarted = await until("a restart after the launch folder is gone", async () => {
    const pid = children().filter((event) => event.event === "ready").at(-1).pid
    return pid !== serving && (await status()).state === "ready" && pid
  })
  assert.equal(alive(serving), false)
  packages.get("frizz-server").latest = "0.13.12"
  await action(); await healthy("0.13.12")
  await until("the update is committed", () => selected().version === "0.13.12")
  assert.equal(alive(restarted), false)
  assert.equal(alive(shellPid), true)
  await machine.query("projectsList")
  record("launch-folder-deleted-restart-and-update-work", { launcher: cwdOf(shellPid) })
  // A launch typed outside any project is about no project: it lands on the dashboard.
  await stopShell()
  const outside = join(root, "outside")
  mkdirSync(outside)
  await launch("0.13.0", outside); await healthy("0.13.12")
  await until("an outside launch lands on the dashboard", () => new RegExp(`started Frizz at ${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/$`, "m").test(launcherLogs()), 30_000)
  if (cwdOf(shellPid) !== undefined) assert.equal(cwdOf(shellPid), realpathSync(outside), "the launcher stays in the folder the command was typed in")
  await machine.query("projectsList")
  record("outside-launch-lands-on-the-dashboard")
  // A shell newer than the installed server is the ordinary pairing, not a rare one: npx fetches the
  // newest shell on every run and the server moves only on Update. So a shell that depends on what a
  // server release learned says so (`frizzServer.minimum`), and starts an older machine on its
  // pinned release. The older server here is the REAL frizz-server 0.15.20 from npm — the last one
  // that lists Frizz's own launch folder as a project, which is where a shell from 0.13.13 hosts
  // every launch outside one. A new machine, so nothing above bears on it.
  await stopShell()
  const OLD_SERVER = "0.15.20"
  const published = async (path) => {
    const response = await fetch(`https://registry.npmjs.org/${path}`)
    assert.equal(response.status, 200, `npm did not serve ${path}`)
    return response
  }
  const oldTarball = Buffer.from(await (await published(`frizz-server/-/frizz-server-${OLD_SERVER}.tgz`)).arrayBuffer())
  packages.get("frizz-server").releases.set(OLD_SERVER, {
    manifest: await (await published(`frizz-server/${OLD_SERVER}`)).json(),
    tarball: oldTarball,
    integrity: `sha512-${createHash("sha512").update(oldTarball).digest("base64")}`,
  })
  serverFixture("0.15.99")
  const shellFixture = (version, server, minimum) => {
    const next = structuredClone(manifest)
    next.version = version; next.frizzServer.version = server
    if (minimum) next.frizzServer.minimum = minimum
    pack(shellDir, next)
  }
  shellFixture("0.13.20", OLD_SERVER) // what put the old server on the machine
  shellFixture("0.13.21", "0.15.99") // a newer shell that declares no minimum
  shellFixture("0.13.22", "0.15.99", "0.15.21") // the same shell, declaring one
  const newHome = join(root, "home-minimum"), nowhere = join(root, "outside-minimum")
  mkdirSync(newHome); mkdirSync(nowhere)
  Object.assign(env, {
    HOME: newHome, USERPROFILE: newHome, XDG_CONFIG_HOME: join(newHome, "config"), XDG_DATA_HOME: join(newHome, "data"),
    XDG_STATE_HOME: join(newHome, "state"), XDG_CACHE_HOME: join(newHome, "cache"),
  })
  base = `http://127.0.0.1:${await freePort()}`
  const launchFolder = () => realpathSync(join(newHome, "data/frizz/host"))
  const listed = async () => (await createRpcClient(base).query("projectsList")).map((project) => project.path)
  // A published server reports nothing to the fixtures' event file, so the launcher is found by the
  // record it publishes and readiness by the supervisor's own status.
  const launchPublished = async (shell, server, cwd = nowhere) => {
    const landings = () => launcherLogs(newHome).match(/started Frizz at /g)?.length ?? 0
    const landed = landings()
    start(`launcher-${processes.length}`, [npmCli, "exec", "--yes", `--package=frizz@${shell}`, "--", "frizz", "--no-app", "--port", new URL(base).port], cwd)
    await until(`server ${server} under shell ${shell}`, async () => { const value = await status(); return value.state === "ready" && value.version === server }, 300_000)
    // The supervisor answers before the launcher has asked where it lands, and a launcher stopped in
    // that window never asked at all. Its own line says the launch is finished.
    await until(`shell ${shell} says where it landed`, () => landings() > landed, 30_000)
    const projects = join(newHome, "data/frizz/projects")
    const pidIn = (name) => readdirSync(projects).map((project) => {
      try { return JSON.parse(readFileSync(join(projects, project, name), "utf8")).pid } catch { return undefined }
    }).find((pid) => Number.isInteger(pid) && alive(pid))
    shellPid = await until("the launcher's owner record", () => pidIn("project-launch.owner"), 10_000)
    for (const pid of [shellPid, pidIn("server.lock")]) if (pid) publishedPids.add(pid)
  }
  // This machine ran Frizz before the server moved onto its own folder, so its remote sign-ins are
  // under the project it was last started in. The first launch brings them along: the launcher goes
  // on signing sessions with the key the phones already hold, and the move signs nobody out.
  const formerHost = join(newHome, "data/frizz/projects/11111111-1111-4111-8111-111111111111")
  const sessionKey = randomBytes(32)
  mkdirSync(formerHost, { recursive: true })
  writeFileSync(join(formerHost, "session-key"), sessionKey, { mode: 0o600 })
  writeFileSync(join(formerHost, "session-epoch"), JSON.stringify({ epoch: SESSION_EPOCH }))
  await launchPublished("0.13.20", OLD_SERVER)
  assert.equal(selected(newHome).version, OLD_SERVER)
  await until("the launcher says whose sign-in state it carried over", () => /carried the remote sign-in state over from \S*11111111-1111-4111-8111-111111111111$/m.test(launcherLogs(newHome)), 10_000)
  const sessionKeys = readdirSync(dirname(formerHost)).map((project) => join(dirname(formerHost), project, "session-key")).filter((path) => existsSync(path))
  assert.equal(sessionKeys.length, 2, "the former host's key, and the one Frizz's own folder now holds")
  for (const path of sessionKeys) assert.ok(readFileSync(path).equals(sessionKey), `${path} is the key the devices already hold`)
  record("remote-sign-ins-carried-over", { from: formerHost, keys: sessionKeys })
  await stopShell()
  // The pairing as it ships without a minimum: the installed server stands, whatever the shell pins.
  // Typed in a project first, against a server from before the launch route: the launcher gets no
  // answer, and its own rules open the project exactly as they always did.
  const theirs = join(root, "their-project")
  mkdirSync(theirs); execFileSync("git", ["init", "-q"], { cwd: theirs }); ensureProjectIdFile(theirs, newHome)
  await launchPublished("0.13.21", OLD_SERVER, theirs)
  assert.equal(selected(newHome).version, OLD_SERVER, "a shell without a minimum never moves the installed server")
  assert.match(launcherLogs(newHome), new RegExp(`started Frizz at ${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/project/their-project$`, "m"), "the launcher opened the project by its own rules")
  // Both launches so far met a server with no launch route: the one that installed it, and this one.
  assert.equal(launcherLogs(newHome).match(/did not say where this launch lands; using this launcher's own rules/g)?.length, 2)
  assert.ok((await listed()).includes(realpathSync(theirs)))
  record("launch-without-a-route-opens-the-project", { server: OLD_SERVER, listed: await listed() })
  await stopShell()
  // Then typed outside one, which is the launch that leaves the dashboard with a project the operator
  // never added and cannot open usefully. It has to be this launch: the one above registered a
  // project through the launcher's own registry code, which writes the list back without Frizz's
  // folder, and the older server only puts it there as it boots.
  await launchPublished("0.13.21", OLD_SERVER)
  await until("the older server lists Frizz's own launch folder", async () => (await listed()).includes(launchFolder()), 30_000)
  record("older-server-lists-the-launch-folder", { server: OLD_SERVER, listed: await listed() })
  await stopShell()
  await launch("0.13.22", nowhere); await healthy("0.15.99")
  await until("the pinned release is selected once it is up", () => selected(newHome).version === "0.15.99", 30_000)
  assert.match(launcherLogs(newHome), new RegExp(`the installed Frizz server ${OLD_SERVER.replaceAll(".", "\\.")} is older than this launcher works with \\(0\\.15\\.21\\); starting on 0\\.15\\.99`))
  assert.deepEqual(await listed(), [realpathSync(theirs)], "the entry the older server wrote is gone from the dashboard")
  record("minimum-starts-an-older-machine-on-the-pinned-server", { from: OLD_SERVER, to: selected(newHome).version, listed: await listed() })
  assert.equal(children().some((event) => event.event === "overlapping-server"), false, "no server process may overlap its predecessor")
  assert.ok(children().every((event) => event.node === runtimeVersion), "npm bin shebang and all server forks must use the requested Node version")
  assert.equal(existsSync(`${eventFile}.postinstall`), false, "dependency postinstall must never run")
  assert.deepEqual(failures, [])
  assert.equal(existsSync(old.running.daemon), true, "the release a daemon was running from outlived every update and relaunch")
  record("passed", { children: children() })
} catch (error) {
  record("test-failed", { error: error.stack ?? String(error) })
  if (page) await page.screenshot({ path: join(out, "failure.png") }).catch(() => {})
  throw error
} finally {
  if (listenerMonitor) clearInterval(listenerMonitor)
  monitorEnabled = false
  downloadGate?.release()
  if (browser) { await browser.close(); record("browser-closed") }
  const projects = join(home, "data/frizz/projects")
  if (existsSync(projects)) for (const project of readdirSync(projects)) {
    for (const name of ["codex-app-server-native", "codex-app-server", "claude-broker"]) {
      const directory = join(projects, project, name)
      if (!existsSync(directory)) continue
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
        const record = JSON.parse(readFileSync(join(directory, file), "utf8"))
        for (const pid of [record.listenerPid, record.daemonPid, record.childPid, record.pid]) if (Number.isInteger(pid)) workerPids.add(pid)
      }
    }
  }
  await stopShell().catch((error) => record("stop-error", { error: String(error) }))
  const owned = new Set([...children().map((event) => event.pid), ...processes.map((child) => child.pid), ...workerPids, ...publishedPids, shellPid].filter(Boolean))
  for (const pid of owned) if (alive(pid)) { try { process.kill(pid, "SIGKILL") } catch {} }
  if (registry) { registry.closeAllConnections(); await new Promise((done) => registry.close(done)) }
  await delay(500)
  const remaining = [...owned].filter(alive)
  record("cleanup", { remaining })
  writeFileSync(join(out, "evidence.json"), JSON.stringify({ root, events, failures, consoleErrors, children: children() }, null, 2))
  assert.deepEqual(remaining, [])
  if (workerBackends.includes("claude")) {
    // Claude's real credential directory was linked, but only this unique project's transcripts are ours.
    for (const path of repoPaths) rmSync(join(process.env.HOME, ".claude/projects", path.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, force: true })
  }
  if (!argument("keep")) rmSync(root, { recursive: true, force: true })
}
