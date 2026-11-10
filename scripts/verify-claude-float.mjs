// A running server moves to a newer Claude Code by itself, and the next worker forks on it
// (packages/server/src/claude-float.ts), driven end to end on a real stack with real Claude workers.
//
//   env -u NODE_COMPAT nub scripts/verify-claude-float.mjs
//
// npm cannot be told to publish a newer Claude Code on demand, so a local registry stands in for it and
// announces `<bundled + 1>` as `latest`. That build is a wrapper: it answers `--version` as the new
// version, writes one line per call (with the thread it serves) to a log, and runs the real bundled
// binary. Everything else is real: the stack, the provisioner, the bundled SDK's verification of the
// build, the swap, the broker's fork, and a real Haiku turn per thread.
//
//   1. Boot. Thread A dispatches at once, before the first check, so it forks on the bundled build.
//   2. The first check (a minute after boot) moves the server to the wrapper and records it.
//   3. Thread B dispatches, and must fork on the wrapper; A's worker must not have.
//   4. Restart on the same runtimes folder. Thread C dispatches at once, and must fork on the wrapper:
//      a boot starts on the recorded build with no check.
//
// Isolation: the stack runs on the real HOME (a Claude worker under a sandbox HOME puts a keychain
// dialog on screen, AGENTS.md) with a throwaway project, an isolated Frizz root, and a runtimes folder
// of its own (FRIZZ_RUNTIMES_DIR), cloned from the machine's, so the real `claude-float.json` and
// version directories are never touched. Everything it made is removed at the end, pass or fail.
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { frizzPaths } from "../packages/server/src/frizz-paths.ts"

const repo = resolve(import.meta.dirname, "..")
const runtimesSource = readFileSync(join(repo, "packages/server/src/runtimes.ts"), "utf8")
const bundled = /export const CLAUDE_CODE_VERSION = "([^"]+)"/u.exec(runtimesSource)[1]
const codexVersion = /CODEX_APP_SERVER_SUPPORTED_VERSION = "([^"]+)"/u.exec(readFileSync(join(repo, "packages/server/src/backend/codex-app-server.ts"), "utf8"))?.[1]
const [major, minor, patch] = bundled.split(".").map(Number)
const next = `${major}.${minor}.${patch + 1}`
const platformKey = `${process.platform}-${process.arch}`
const releasePkg = `@anthropic-ai/claude-code-${platformKey}`

const work = mkdtempSync(join(tmpdir(), "frizz-claude-float-"))
const runtimes = join(work, "runtimes")
const project = mkdtempSync(join(homedir(), "Documents", "scratch", "claude-float-project-"))
const wrapperLog = join(work, "wrapper-calls.log")
const stacks = []
const failures = []
const check = (ok, message) => { console.log(`${ok ? "PASS" : "FAIL"} ${message}`); if (!ok) failures.push(message) }

// --- the runtimes folder: the machine's bundled Claude Code and Codex, cloned (APFS: no copy) ----------
const realRuntimes = join(frizzPaths().cache, "runtimes")
const realBundled = join(realRuntimes, "claude", bundled)
if (!existsSync(join(realBundled, "provisioned.json"))) throw new Error(`the bundled Claude Code ${bundled} is not provisioned at ${realBundled}; run a Frizz on this checkout once first`)
for (const [backend, label] of [["claude", bundled], ["codex", codexVersion]]) {
  if (!label || !existsSync(join(realRuntimes, backend, label))) continue
  mkdirSync(join(runtimes, backend), { recursive: true })
  execFileSync("cp", ["-cR", join(realRuntimes, backend, label), join(runtimes, backend, label)])
  rmSync(join(runtimes, backend, label, ".leases"), { recursive: true, force: true })
}
const bundledBin = join(runtimes, "claude", bundled, "claude")

// --- a registry announcing the next release, whose binary is a logging wrapper around the bundled one
function tarEntry(name, data, mode) {
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
const wrapper = Buffer.from([
  "#!/bin/sh",
  `if [ "$1" = "--version" ]; then echo "${next} (Claude Code)"; exit 0; fi`,
  `printf '%s thread=%s args=%s\\n' "$(date +%s)" "\${FRIZZ_THREAD:-none}" "$*" >> '${wrapperLog}'`,
  `exec '${bundledBin}' "$@"`,
  "",
].join("\n"))
const tgz = gzipSync(Buffer.concat([tarEntry("package/claude", wrapper, 0o755), Buffer.alloc(1024)]))
const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`
const registryRequests = []
const registry = createServer((req, res) => {
  registryRequests.push(req.url)
  const pkg = encodeURIComponent(releasePkg).replace("%40", "@")
  if (req.url === `/${pkg}/latest`) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ version: next })); return }
  if (req.url === `/${pkg}/${next}`) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ dist: { tarball: `http://127.0.0.1:${registry.address().port}/tgz`, integrity } })); return }
  if (req.url === "/tgz") { res.end(tgz); return }
  res.statusCode = 404
  res.end()
})
await new Promise((ok) => registry.listen(0, "127.0.0.1", ok))
const registryUrl = `http://127.0.0.1:${registry.address().port}`

// --- the stack -----------------------------------------------------------------------------------------
function freePort() {
  return new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)) }) })
}

async function bootStack(name) {
  const port = await freePort()
  const logPath = join(work, `${name}.log`)
  const out = (await import("node:fs")).openSync(logPath, "w")
  const child = spawn(process.execPath, [join(repo, "scripts/adhoc-stack.mjs"), `--port=${port}`, `--home=${homedir()}`, `--project=${project}`], {
    cwd: repo, stdio: ["ignore", out, out],
    env: { ...process.env, FRIZZ_RUNTIMES_DIR: runtimes, FRIZZ_RUNTIMES_REGISTRY: registryUrl, FRIZZ_RUNTIMES: "" },
  })
  const stack = { child, logPath, port, info: undefined }
  stacks.push(stack)
  for (let i = 0; i < 600 && !stack.info; i++) {
    const line = readFileSync(logPath, "utf8").split("\n").find((l) => l.startsWith("{\"url\""))
    if (line) stack.info = JSON.parse(line)
    else await new Promise((ok) => setTimeout(ok, 500))
    if (child.exitCode !== null) throw new Error(`${name} exited during boot: ${readFileSync(logPath, "utf8").slice(-2000)}`)
  }
  if (!stack.info) throw new Error(`${name} printed no json line`)
  stack.api = createRpcClient(`http://127.0.0.1:${port}/`)
  await stack.api.waitForHealth()
  return stack
}

async function stopStack(stack) {
  if (stack.child.exitCode !== null) return
  stack.child.kill("SIGTERM")
  await new Promise((ok) => { stack.child.once("exit", ok); setTimeout(ok, 30_000) })
  if (stack.info?.isolatedRoot) rmSync(stack.info.isolatedRoot, { recursive: true, force: true })
}

const until = async (what, predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((ok) => setTimeout(ok, 2000))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const claudeProjects = join(homedir(), ".claude", "projects")
function transcriptOf(sessionId) {
  for (const dir of existsSync(claudeProjects) ? readdirSync(claudeProjects) : []) {
    const path = join(claudeProjects, dir, `${sessionId}.jsonl`)
    if (existsSync(path)) return path
  }
  return undefined
}
function replied(sessionId) {
  const path = transcriptOf(sessionId)
  if (!path) return false
  return readFileSync(path, "utf8").split("\n").some((line) => {
    try {
      const record = JSON.parse(line)
      return record.type === "assistant" && record.message?.content?.some?.((block) => block.type === "text" && block.text.trim())
    } catch { return false }
  })
}
const wrapperCallsFor = (slug) => (existsSync(wrapperLog) ? readFileSync(wrapperLog, "utf8") : "").split("\n").filter((line) => line.includes(`thread=${slug} `))

async function dispatch(stack, label) {
  const out = await stack.api.mutate("dispatch", { prompt: "Reply with the single word ok and nothing else.", backend: "claude", model: "haiku", title: `claude float ${label}` })
  await until(`thread ${label} to reply`, () => replied(out.sessionId), 240_000)
  console.log(`thread ${label}: ${out.slug} replied`)
  return out
}

const sessions = []
try {
  execFileSync("git", ["init", "-q", project])
  const first = await bootStack("stack-1")
  const a = await dispatch(first, "A")
  sessions.push(a.sessionId)
  // The stack does not print Frizz's log, so the move is read off what it leaves: the record a boot reads.
  const floatState = join(runtimes, "claude-float.json")
  await until("the server to move to the announced build", () => existsSync(floatState) && JSON.parse(readFileSync(floatState, "utf8")).label === next, 240_000)
  check(true, `the running server moved from ${bundled} to ${next}, and recorded it in claude-float.json`)
  check(existsSync(join(runtimes, "claude", bundled, "claude")), `the bundled ${bundled} stayed beside it`)
  check(readFileSync(wrapperLog, "utf8").includes("args=--output-format"), "the bundled SDK opened a session on the new build before it was adopted")
  const b = await dispatch(first, "B")
  sessions.push(b.sessionId)
  check(wrapperCallsFor(b.slug).length > 0, `thread B forked on ${next}`)
  check(wrapperCallsFor(a.slug).length === 0, `thread A, dispatched before the move, never ran ${next}`)
  await stopStack(first)

  const second = await bootStack("stack-2")
  const c = await dispatch(second, "C")
  sessions.push(c.sessionId)
  check(wrapperCallsFor(c.slug).length > 0, `after a restart, thread C started on ${next} with no check (boot read claude-float.json)`)
  await stopStack(second)
} catch (error) {
  failures.push(String(error?.message ?? error))
  console.log(`FAIL ${error?.stack ?? error}`)
} finally {
  for (const stack of stacks) await stopStack(stack)
  registry.close()
  // Broker daemons outlive their server by design; these are the ones forked into this project.
  const leftovers = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")
    .filter((line) => line.includes(project) || sessions.some((id) => line.includes(id)))
    .map((line) => Number(line.trim().split(/\s+/u)[0]))
    .filter((pid) => pid && pid !== process.pid)
  for (const pid of leftovers) { try { process.kill(pid, "SIGTERM") } catch {} }
  for (const id of sessions) { const path = transcriptOf(id); if (path) rmSync(path, { force: true }) }
  const projectSlug = project.replace(/[^a-zA-Z0-9]/gu, "-")
  rmSync(join(claudeProjects, projectSlug), { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
  console.log(`cleaned up: ${leftovers.length} leftover process(es), the project, the runtimes copy`)
}
console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASS")
process.exit(failures.length ? 1 : 0)
