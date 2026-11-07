// Disposable, fully-ISOLATED frizz stack for ad hoc CDP / manual verification.
//
// Why this exists: verifying a frizz change means driving the REAL app end-to-end, but you must never
// touch the maintainer's live instance or real ~/.frizz SQLite. This boots a
// throwaway stack that is sandboxed on every axis:
//   • HOME              → a fresh temp dir, so the SQLite DB + server.lock live in an empty ~/.frizz
//   • PORT              → a unique high port, so it never fights the dev server on 5175
//   • FRIZZ_WAKERS_OFF=1 → scheduler OFF by default (no wake side effects); pass --wakers to arm it
// The project defaults to the frizz repo itself (a GitHub repo, an empty board under the temp HOME).
//
// Usage:
//   nub scripts/adhoc-stack.mjs [--port=4930] [--project=/abs/dir] [--claude-bin=/abs/bin] [--wakers] [--reaper] [--prime] [--keep] [--home=/abs] [--seed] [--prod [--web-dist=/abs]]
//
// `--prod` serves the web app from `packages/web/dist` (run `nub run build` in packages/web first) instead
// of the Vite dev server. A timing taken through Vite measures React's development build and valtio's
// debug paths as much as the app; a cost a user pays is measured on the production bundle.
// `--web-dist=/abs` serves another build instead, e.g. one made with `vite build --minify false` so a
// CPU profile names the functions it samples.
//
// It prints ONE json line to stdout: {"url","port","home","project"} once /health is green,
// then stays up until SIGINT/SIGTERM, deleting the temp HOME on exit (unless --keep). Run it with Bash
// run_in_background:true, parse that json line, then drive the url with Chrome DevTools MCP or shot.mjs.
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, symlinkSync, lstatSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { frizzPaths, projectStateDir } from "../packages/server/src/frizz-paths.ts"
import { adhocFrizzRoot } from "./lib/adhoc-frizz-root.mjs"

const args = process.argv.slice(2)
const flag = (k) => args.includes(`--${k}`)
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}

const port = Number(opt("port", "4930"))
const projectDir = opt("project", process.cwd()) // default: the frizz repo root
const claudeBin = opt("claude-bin", undefined)
// ONE frizz serves N projects, so a whole class of bugs only exists in a project the server did NOT
// launch from — the tenant's board, its tailer, its scheduler, and the env its workers are spawned
// with. `--also-project=/abs/dir` (repeatable) registers extra projects so the stack has a launcher
// AND at least one tenant; each one's id + slug comes back in the json line, and a tenant is addressed
// as `/_frizz/<id-or-slug>/rpc/…`. Without this you can only ever test the launching project, which is
// exactly the half that already works.
const alsoProjects = args.filter((a) => a.startsWith("--also-project=")).map((a) => a.slice("--also-project=".length))
// A DISPATCH needs real credentials, and a fresh sandbox HOME has none — the broker is the sole claude
// transport, so a worker under a credential-less HOME simply never starts. `--creds` symlinks the real
// agent logins into the sandbox; everything frizz itself writes still lands in the throwaway `~/.frizz`.
// On macOS it leaves CLAUDE's login out: when its token is due, Claude Code saves the new one to the
// keychain, this HOME has none, and macOS puts a "Keychain Not Found" modal on the maintainer's screen
// (AGENTS.md § Never put a macOS keychain dialog on the maintainer's screen; maintainer 2026-10-13: keep
// sandboxes keychain-less, with no real Claude workers in them). A Claude dispatch here fails
// `AUTH_REQUIRED:claude` instead. Simulate the worker, or run with --home=$HOME and a throwaway --project.
const creds = flag("creds")
// --home=/abs reuses a sandbox a previous `--keep` run left behind, which is the only way to verify
// anything that happens at BOOT against state that already exists — a schema migration, a registry
// repair, resume/recovery. Implies --keep: a HOME you were handed is never one this run may delete.
// --home=$HOME is the other use: the real HOME, for a live Claude worker that must find the keychain.
// Frizz's own state is then the machine's `~/.frizz` if it has one and a temp root of this run's if
// it does not; see `frizzRoot` below.
const reuseHome = opt("home", undefined)
const keep = flag("keep") || reuseHome !== undefined

// Sandbox HOME first — resolveProject() reads homedir() lazily, so setting it now redirects the whole
// state tree (~/.frizz/projects/<id>/) into the throwaway dir before the server derives any path.
const home = reuseHome ?? mkdtempSync(join(tmpdir(), "frizz-adhoc-home-"))
const realHome = process.env.HOME
// The pinned Claude Code and Codex (runtimes.ts) live under the cache root, which the sandbox HOME is
// about to move — so without this every stack would download both pins again. Point the sandbox at the
// machine's real copies; a stack that must exercise provisioning itself sets FRIZZ_RUNTIMES_DIR.
// Resolved FIRST: everything below changes what `frizzPaths()` answers.
const realRuntimes = join(frizzPaths({ home: realHome }).cache, "runtimes")
// Frizz's own GitHub credential (packages/server/src/github-credential.ts) — what the board's GitHub
// cards and PR/issue watchers read. Never the operator's `gh` sign-in, which the server no longer uses.
const realGithubCredentials = join(frizzPaths({ home: realHome }).data, "github")
// Frizz's own state. A sandbox HOME gets its `.frizz`; the REAL home is never given one, because that
// folder existing is what tells every Frizz process on the machine to use it (lib/adhoc-frizz-root.mjs).
const frizzRoot = adhocFrizzRoot({ home, realHome, legacyExists: existsSync(join(home, ".frizz")) })
let isolatedRoot
if (frizzRoot === "sandbox") mkdirSync(join(home, ".frizz"), { recursive: true })
if (frizzRoot === "isolated") {
  // These are inherited by everything the stack starts, which is what keeps a worker's daemon and its
  // `frizzctl` on the same roots as the server. It also means a tool in a worker that honors XDG
  // (a package cache, opencode's login under XDG_DATA_HOME) sees empty directories here.
  isolatedRoot = mkdtempSync(join(tmpdir(), "frizz-adhoc-state-"))
  for (const [name, dir] of [["XDG_DATA_HOME", "data"], ["XDG_STATE_HOME", "state"], ["XDG_CACHE_HOME", "cache"]]) {
    process.env[name] = join(isolatedRoot, dir)
  }
}
process.env.HOME = home
// A real-HOME stack keeps its state in the temp root, where Frizz would read as signed out to GitHub, and
// a PR-watcher e2e on one needs a real PR. The DIRECTORY, for the reason given under `--creds` below.
if (frizzRoot === "isolated" && existsSync(realGithubCredentials)) {
  const stackGithub = join(frizzPaths({ home }).data, "github")
  mkdirSync(dirname(stackGithub), { recursive: true })
  symlinkSync(realGithubCredentials, stackGithub)
}
if (!process.env.FRIZZ_RUNTIMES && !process.env.FRIZZ_RUNTIMES_DIR) process.env.FRIZZ_RUNTIMES_DIR = realRuntimes
// See `--creds` above: on macOS a sandbox HOME never gets Claude's login.
const claudeLogin = creds && !(process.platform === "darwin" && home !== realHome)
if (creds) {
  // The agent CLIs read their own credentials out of HOME. `.frizz/builds` rides along so a stack that
  // promotes an artifact starts warm instead of rebuilding from cold.
  for (const name of [...(claudeLogin ? [".claude", ".claude.json"] : []), ".codex", ".config"]) {
    try { symlinkSync(join(realHome, name), join(home, name)) } catch {}
  }
  // ACP agents keep their credentials under XDG data dirs (opencode: ~/.local/share/opencode/auth.json),
  // so a real `backend: "acp"` dispatch needs those too. Linked per agent, never the whole ~/.local.
  for (const name of [join(".local", "share", "opencode")]) {
    try { mkdirSync(join(home, dirname(name)), { recursive: true }); symlinkSync(join(realHome, name), join(home, name)) } catch {}
  }
  try { symlinkSync(join(realHome, ".frizz", "builds"), join(home, ".frizz", "builds")) } catch {}
  // The DIRECTORY, not the file: a token renewal renames a sibling over the file, and through a linked
  // file that would land here and leave the real board holding a spent refresh token.
  if (existsSync(realGithubCredentials) && home !== realHome) {
    const stackGithub = join(frizzPaths({ home }).data, "github")
    try { mkdirSync(dirname(stackGithub), { recursive: true }); symlinkSync(realGithubCredentials, stackGithub) } catch {}
    // Its key is in the real login keychain, which the sandbox HOME can't find on its own (github-credential-seal.ts).
    const keychain = join(realHome, "Library", "Keychains", "login.keychain-db")
    if (existsSync(keychain)) process.env.FRIZZ_GITHUB_KEYCHAIN = keychain
  }
}
// OpenCode's managed service listens on ONE fixed port per machine (49374 on 2.2.5, ServiceConfig.defaultPort),
// so a sandbox service started by a native OpenCode dispatch would hold the port the operator's own service
// needs, and two stacks could not both start one. A sandbox HOME gets a service config naming a port of
// its own. Never written into the real HOME, nor through a `.config` that --creds linked to the real one.
if (home !== realHome) {
  const configHome = process.env.XDG_CONFIG_HOME?.startsWith(home) ? process.env.XDG_CONFIG_HOME : join(home, ".config")
  let linked = false
  try { linked = lstatSync(configHome).isSymbolicLink() } catch {}
  const serviceConfig = join(configHome, "opencode", "service.json")
  if (!linked && !existsSync(serviceConfig)) {
    const servicePort = port + 10_000 <= 65_535 ? port + 10_000 : port - 10_000
    try { mkdirSync(dirname(serviceConfig), { recursive: true }); writeFileSync(serviceConfig, JSON.stringify({ port: servicePort }) + "\n") } catch {}
  }
}
if (!flag("wakers")) process.env.FRIZZ_WAKERS_OFF = "1"
// A disposable stack must never reap the real machine's leaked worker processes (the orphan reaper
// enumerates ALL processes, not just this stack's). Off by default, exactly like the scheduler; pass
// --reaper to arm it when verifying the reaper itself.
if (!flag("reaper")) process.env.FRIZZ_ORPHAN_REAPER_OFF = "1"
// The server OPENS every registered project a few seconds after boot, so the rail can badge them all
// (tenant-prime.ts). Harmless under a sandbox HOME — the registry there holds only this stack's
// projects — but `--home=$HOME` reuses the REAL registry, and priming would then put a second tailer
// on every one of the maintainer's live boards. Off by default for the same reason the reaper is; pass
// --prime when what you are verifying is the priming (a sandbox HOME, where it costs nothing).
if (!flag("prime")) process.env.FRIZZ_TENANT_PRIME_OFF = "1"
// A worker's `frizzctl` is the first one on its PATH, and Claude Code APPENDS its plugin's `bin/` to the
// PATH it inherited (measured 2026-11-03: the 27th entry of 27). A stack booted from inside a Frizz thread
// inherits that thread's plugin bin, `…/Frizz/current/cc-worker/bin` — the INSTALLED release's — so a live
// worker here ran the installed `frizzctl`, not this checkout's: it answered `frizzctl monitor` with "no
// command" while the checkout had one. Drop every inherited worker-plugin bin, so the one Claude Code
// appends for this stack's plugin is the only one.
if (process.env.PATH) process.env.PATH = process.env.PATH.split(":").filter((dir) => !/[/\\]cc-worker[/\\]bin[/\\]?$/.test(dir)).join(":")
process.chdir(projectDir)

// Optional: drop a tiny fixture note so the board isn't stone empty when eyeballing the shell. Off by
// default — most verification wants a known clean board and seeds its own rows through the RPC surface.
if (flag("seed")) {
  try {
    writeFileSync(join(home, ".frizz", "ADHOC_SEED"), "adhoc stack seed marker\n")
  } catch {}
}

let close = async () => {}
const cleanup = () => {
  stopSandboxOpencodeService()
  if (!keep) { try { rmSync(home, { recursive: true, force: true }) } catch {} }
  // The isolated root is this run's own even though the HOME is not, so `--home` alone (which only
  // implies --keep to protect the HOME it was handed) does not keep it; an explicit --keep does.
  if (isolatedRoot && !flag("keep")) { try { rmSync(isolatedRoot, { recursive: true, force: true }) } catch {} }
}
const stop = (code) => {
  void (async () => {
    try { await close() } catch {}
    cleanup()
    process.exit(code ?? 0)
  })()
}
// A dispatch to OpenCode starts OpenCode's background service, which outlives its client on purpose. This
// one is the sandbox's: its registration is under the sandbox's state directory, never the real one, and
// nothing else here will stop it. By the PID it registered, and only when that file is the sandbox's.
function stopSandboxOpencodeService() {
  if (keep) return
  const stateDirs = [isolatedRoot && join(isolatedRoot, "state"), process.env.XDG_STATE_HOME, join(home, ".local", "state")].filter(Boolean)
  for (const dir of stateDirs) {
    if (!dir.startsWith(home) && !(isolatedRoot && dir.startsWith(isolatedRoot))) continue
    const file = join(dir, "opencode", "service.json")
    try {
      const pid = JSON.parse(readFileSync(file, "utf8")).pid
      if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGTERM")
    } catch {}
  }
}
process.on("SIGINT", () => stop(0))
process.on("SIGTERM", () => stop(0))
process.on("uncaughtException", (e) => { console.error("[adhoc-stack] uncaught", e); stop(1) })

const { startServer } = await import("../packages/server/src/index.ts")
try {
  const webDist = opt("web-dist", undefined)
  const started = await startServer({ dev: !flag("prod"), ...(webDist ? { webDistDir: webDist } : {}), port, installSignalHandlers: false, claudeBin })
  close = () => started.close()
  // Confirm the API is actually serving before announcing — a race here would hand CDP a dead port.
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  // `/` is the all-projects GRID, not a board. Announcing it sent every agent doing browser QA to the
  // project picker, where a `threads: N` assertion reads 0 forever and a screenshot shows the wrong
  // page entirely. Announce the BOARD — `/project/<slug>` — and keep the grid at `gridUrl` for the
  // rare check that actually wants it.
  const { findByPath, registerProject } = await import("../packages/server/src/project-registry.ts")
  const { resolveProject } = await import("../packages/server/src/project.ts")
  // Extra projects are registered AFTER boot, the way opening one in the grid does it — the server
  // activates a tenant lazily on the first `/_frizz/<id-or-slug>/…` request, so nothing else is needed.
  const tenants = []
  for (const dir of alsoProjects) {
    try {
      process.chdir(dir)
      const project = resolveProject()
      registerProject({ dir: project.dir, id: project.id })
      tenants.push({ id: project.id, slug: findByPath(project.dir, home)?.slug, dir: project.dir, stateDir: project.stateDir })
    } catch (error) {
      console.error(`[adhoc-stack] could not register ${dir}:`, error instanceof Error ? error.message : error)
    } finally {
      process.chdir(projectDir)
    }
  }
  const launcher = findByPath(projectDir, home)
  const slug = launcher?.slug
  console.log(JSON.stringify({
    url: slug ? `http://127.0.0.1:${port}/project/${slug}` : `http://127.0.0.1:${port}/`,
    gridUrl: `http://127.0.0.1:${port}/`,
    slug, port, home, project: projectDir,
    // The launcher is the project whose `server.lock` this process publishes — the one file every
    // worker on this stack, in ANY project, reads the port out of.
    launcher: launcher ? { id: launcher.id, slug: launcher.slug, dir: projectDir, serverLock: join(projectStateDir(launcher.id, home), "server.lock") } : undefined,
    tenants,
    // Where Frizz's own state is: "sandbox" (<home>/.frizz), "shared" (the real ~/.frizz) or
    // "isolated" (a temp root, named here, that this run deletes on exit unless --keep).
    frizzRoot,
    ...(isolatedRoot ? { isolatedRoot } : {}),
    wakers: flag("wakers"),
    creds,
    claudeLogin,
  }))
  // After the json line, never before it: agents read that line first.
  if (creds && !claudeLogin) {
    console.error("[adhoc-stack] --creds on macOS leaves Claude's login out of this sandbox: a live Claude worker here would put a keychain dialog on the maintainer's screen. Simulate the worker, or use --home=$HOME.")
  }
} catch (error) {
  console.error("[adhoc-stack] boot failed:", error)
  cleanup()
  process.exit(1)
}
