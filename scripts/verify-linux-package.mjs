#!/usr/bin/env node
// A packed Frizz on a clean Linux box: the real launcher (`npm exec frizz`) installs the real server
// generation from a registry, boots it, and answers a real RPC. scripts/verify-server-package.mjs is
// the full macOS run (browser, update, worker); this is the part nothing else ran on Linux, where
// node-pty's missing prebuild killed every boot (#42). The server resolves the provider CLIs from PATH
// here (`FRIZZ_RUNTIMES=path`), which is why the image installs Claude Code first.
//
// Pack both tarballs with the shell pinning the server (see verify-server-package.mjs), then run it in a
// slim image with no C++ toolchain — Docker's `--tmpfs` keeps it off a full Docker disk:
//
//   docker run --rm --tmpfs /tmp:rw,exec,size=3g -e HOME=/tmp/root -v "$PWD":/repo:ro -v /abs/tgz:/t:ro node:22-slim sh -c \
//     'npm i -g --prefix /tmp/g @anthropic-ai/claude-code >/dev/null && PATH=/tmp/g/bin:$PATH \
//      node /repo/scripts/verify-linux-package.mjs --shell=/t/frizz-X.tgz --server=/t/frizz-server-Y.tgz'
//
// `--public=<frizz version>` runs a published shell from npmjs instead — the negative control: frizz@0.13.1
// dies at boot with "Failed to load native module: pty.node" here.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { closureProblem, installedPackages } from "./lib/installed-closure.mjs"

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const publicVersion = arg("public")
const root = mkdtempSync("/tmp/frizz-linux-e2e-")
const home = join(root, "home"), project = join(root, "project")
mkdirSync(home); mkdirSync(project)
writeFileSync(join(project, "FRIZZ.md"), "Disposable Linux test.\n")
// A project marker: the slim image has no git to `git init` with, and package.json is one too.
writeFileSync(join(project, "package.json"), '{"private":true}\n')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FRIZZ_|npm_|NPM_|NODE_OPTIONS|XDG_|HOME|CLAUDE_CONFIG_DIR)/u.test(key)))
Object.assign(env, {
  HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
  XDG_CACHE_HOME: join(home, "cache"), npm_config_cache: join(root, "npm-cache"), npm_config_userconfig: join(root, "npmrc"),
  npm_config_audit: "false", npm_config_fund: "false", FRIZZ_ORPHAN_REAPER_OFF: "1", FRIZZ_RUNTIMES: "path",
})
writeFileSync(env.npm_config_userconfig, "")

function sha(bytes) { return `sha512-${createHash("sha512").update(bytes).digest("base64")}` }
function packed(file) {
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8" }))
  const bytes = readFileSync(file)
  return { bytes, manifest, integrity: sha(bytes) }
}
async function freePort() {
  const socket = createNetServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening")
  const value = socket.address().port; await new Promise((done) => socket.close(done)); return value
}
async function until(label, test, timeout = 240_000) {
  const deadline = Date.now() + timeout; let last
  while (Date.now() < deadline) {
    try { const value = await test(); if (value) return value } catch (error) { if (error.fatal) throw error; last = error }
    await delay(250)
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`)
}

let registry, launcher, launcherLog = ""
let shellVersion
const checks = []
const check = (name, ok, detail = "") => { checks.push(ok); console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`) }
try {
  console.log(`host ${process.platform}-${process.arch}, node ${process.version}, npm ${execFileSync("npm", ["-v"], { encoding: "utf8" }).trim()}, toolchain: ${["g++", "make"].filter((tool) => { try { execFileSync("which", [tool]); return true } catch { return false } }).join(",") || "none"}`)
  if (publicVersion) {
    env.npm_config_registry = "https://registry.npmjs.org/"
    shellVersion = publicVersion
  } else {
    const shell = packed(resolve(arg("shell"))), server = packed(resolve(arg("server")))
    assert.equal(shell.manifest.frizzServer?.version, server.manifest.version, "the shell pins this server")
    assert.equal(server.manifest.dependencies?.["node-pty"], undefined, "the server package declares no node-pty")
    shellVersion = shell.manifest.version
    const packages = new Map([["frizz", shell], ["frizz-server", server]])
    registry = createServer(async (request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, "http://registry").pathname)
      const name = pathname.split("/")[1]
      const release = packages.get(name)
      if (!release) {
        const upstream = await fetch(`https://registry.npmjs.org${request.url}`)
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" })
        response.end(Buffer.from(await upstream.arrayBuffer())); return
      }
      if (pathname.includes("/-/")) { response.writeHead(200); response.end(release.bytes); return }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ name, "dist-tags": { latest: release.manifest.version }, versions: { [release.manifest.version]: {
        ...release.manifest, dist: { tarball: `${env.npm_config_registry}${name}/-/${name}-${release.manifest.version}.tgz`, integrity: release.integrity },
      } } }))
    })
    registry.listen(0, "127.0.0.1"); await once(registry, "listening")
    env.npm_config_registry = `http://127.0.0.1:${registry.address().port}/`
  }

  const port = await freePort(), base = `http://127.0.0.1:${port}`
  const started = Date.now()
  launcher = spawn("npm", ["exec", "--yes", `--package=frizz@${shellVersion}`, "--", "frizz", "--no-app", "--port", String(port)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  launcher.stdout.on("data", (b) => { launcherLog += b }); launcher.stderr.on("data", (b) => { launcherLog += b })
  const status = await until("a ready server", async () => {
    if (launcher.exitCode !== null) throw Object.assign(new Error(`launcher exited ${launcher.exitCode}`), { fatal: true })
    const response = await fetch(`${base}/_frizz/control/status`, { headers: { origin: base }, signal: AbortSignal.timeout(2000) })
    const state = await response.json(); return state.state === "ready" ? state : undefined
  }).catch((error) => { check("the server boots on this host", false, String(error.message)); throw error })
  check("the server boots on this host", true, `frizz-server ${status.version} ready in ${Math.round((Date.now() - started) / 1000)}s`)

  const generations = join(home, "cache", "frizz", "server-releases")
  const key = readdirSync(generations)[0]
  const generation = readdirSync(join(generations, key)).find((id) => !id.endsWith(".staging"))
  check("the installed generation carries no node-pty", !existsSync(join(generations, key, generation, "node_modules", "node-pty")))
  // The server's bundle carries the watcher's JavaScript, so the install is the server and the binary
  // for this libc. That the server booted says the binary was found; this says nothing else came with it.
  const nodeModules = join(generations, key, generation, "node_modules")
  const problem = closureProblem(nodeModules)
  check("the install is the server and the watcher's binary, nothing npm had to resolve", problem === null, problem ?? installedPackages(nodeModules).join(" "))

  // A real RPC through the booted server. The provider credential read is the one Linux-specific path a
  // board takes on its first render (a file under ~/.claude, where macOS reads the Keychain).
  const auth = await createRpcClient(base).query("authStatus")
  check("the server answers a real RPC", typeof auth?.claude === "string", JSON.stringify(auth))
} catch (error) {
  if (!checks.length || checks.every(Boolean)) check("harness completed", false, error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  if (launcher && launcher.exitCode === null) { launcher.kill("SIGINT"); await Promise.race([once(launcher, "exit"), delay(20_000)]) }
  registry?.close()
  if (checks.some((ok) => !ok)) console.log(`launcher said:\n  ${launcherLog.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\n").filter((line) => line.trim()).slice(-30).join("\n  ")}`)
}
const failed = checks.filter((ok) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
