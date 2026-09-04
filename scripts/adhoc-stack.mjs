// Disposable, fully-ISOLATED frizz stack for ad hoc CDP / manual verification.
//
// Why this exists: verifying a frizz change means driving the REAL app end-to-end, but you must never
// touch the maintainer's live instance or real ~/.frizz SQLite. This boots a
// throwaway stack that is sandboxed on every axis:
//   • HOME              → a fresh temp dir, so the SQLite DB + server.lock live in an empty ~/.frizz
//   • PORT              → a unique high port, so it never fights the dev server on 5175
//   • FRIZZ_WAKERS_OFF=1 → scheduler OFF by default (no wake side effects); pass --wakers to arm it
// The project defaults to the frizz repo itself (a gh-authed repo, an empty board under the temp HOME).
//
// Usage:
//   nub scripts/adhoc-stack.mjs [--port=4930] [--project=/abs/dir] [--claude-bin=/abs/bin] [--wakers] [--reaper] [--prime] [--keep] [--home=/abs] [--seed]
//
// It prints ONE json line to stdout: {"url","port","home","project"} once /health is green,
// then stays up until SIGINT/SIGTERM, deleting the temp HOME on exit (unless --keep). Run it with Bash
// run_in_background:true, parse that json line, then drive the url with Chrome DevTools MCP or shot.mjs.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { frizzPaths } from "../packages/server/src/frizz-paths.ts"

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
// `~/.claude*` into the sandbox; everything frizz itself writes still lands in the throwaway `~/.frizz`.
const creds = flag("creds")
// --home=/abs reuses a sandbox a previous `--keep` run left behind, which is the only way to verify
// anything that happens at BOOT against state that already exists — a schema migration, a registry
// repair, resume/recovery. Implies --keep: a HOME you were handed is never one this run may delete.
const reuseHome = opt("home", undefined)
const keep = flag("keep") || reuseHome !== undefined

// Sandbox HOME first — resolveProject() reads homedir() lazily, so setting it now redirects the whole
// state tree (~/.frizz/projects/<id>/) into the throwaway dir before the server derives any path.
const home = reuseHome ?? mkdtempSync(join(tmpdir(), "frizz-adhoc-home-"))
mkdirSync(join(home, ".frizz"), { recursive: true })
const realHome = process.env.HOME
process.env.HOME = home
// The pinned Claude Code and Codex (runtimes.ts) live under the cache root, which the sandbox HOME
// just moved — so without this every stack would download both pins again. Point the sandbox at the
// machine's real copies; a stack that must exercise provisioning itself sets FRIZZ_RUNTIMES_DIR.
if (!process.env.FRIZZ_RUNTIMES && !process.env.FRIZZ_RUNTIMES_DIR) {
  process.env.FRIZZ_RUNTIMES_DIR = join(frizzPaths({ home: realHome }).cache, "runtimes")
}
if (creds) {
  // The agent CLIs read their own credentials out of HOME. `.frizz/builds` rides along so a stack that
  // promotes an artifact starts warm instead of rebuilding from cold.
  for (const name of [".claude", ".claude.json", ".codex", ".config"]) {
    try { symlinkSync(join(realHome, name), join(home, name)) } catch {}
  }
  try { symlinkSync(join(realHome, ".frizz", "builds"), join(home, ".frizz", "builds")) } catch {}
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
  if (!keep) { try { rmSync(home, { recursive: true, force: true }) } catch {} }
}
const stop = (code) => {
  void (async () => {
    try { await close() } catch {}
    cleanup()
    process.exit(code ?? 0)
  })()
}
process.on("SIGINT", () => stop(0))
process.on("SIGTERM", () => stop(0))
process.on("uncaughtException", (e) => { console.error("[adhoc-stack] uncaught", e); stop(1) })

const { startServer } = await import("../packages/server/src/index.ts")
try {
  const started = await startServer({ dev: true, port, installSignalHandlers: false, claudeBin })
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
    launcher: launcher ? { id: launcher.id, slug: launcher.slug, dir: projectDir, serverLock: join(home, ".frizz", "projects", launcher.id, "server.lock") } : undefined,
    tenants,
    wakers: flag("wakers"),
    creds,
  }))
} catch (error) {
  console.error("[adhoc-stack] boot failed:", error)
  cleanup()
  process.exit(1)
}
