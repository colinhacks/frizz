import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { scratchDirRelPath, writeScratchDir } from "./dispatch.ts"
import { frizzPaths, projectStateDir, resetFrizzRoots } from "./frizz-paths.ts"
import { registerProject } from "./project-registry.ts"
import { discoverProjectRoot, ensureProjectIdFile, homeProjectFrizzDir, projectFrizzDir } from "./project-root.ts"
import { remoteProjectDirs, remoteReadablePath } from "./remote-reads.ts"
import { scratchFiles, scratchRoot } from "./scratch-files.ts"
import { cleanupAdoptionSessionFiles } from "./session-files.ts"

// THE HOME PROJECT (maintainer 2026-11-20: "a home project with the ability to start a Frizz thread just
// inside of my home directory"). Its one hard rule: nothing may create `~/.frizz`, because that path is
// Frizz's legacy state root and its existence alone moves every Frizz process on the machine onto it
// (frizz-paths.ts rule 1), launchers too old to know any of this included. Every test here ends by
// asking whether `<home>/.frizz` appeared.

const here = dirname(fileURLToPath(import.meta.url))
const HOOKS = join(here, "../../../cc-worker/hooks")
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const XDG = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const

/** A fresh HOME for this process, with no XDG roots to lead the data root out of it. */
function withHome(t: { after: (fn: () => void) => void }): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "frizz-home-project-")))
  const saved = { HOME: process.env.HOME, ...Object.fromEntries(XDG.map((name) => [name, process.env[name]])) }
  process.env.HOME = home
  for (const name of XDG) delete process.env[name]
  resetFrizzRoots()
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    resetFrizzRoots()
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

test("the home project's Frizz folder is in the data root; every other project keeps `<root>/.frizz`", (t) => {
  const home = withHome(t)
  const data = frizzPaths({ home }).data
  assert.equal(projectFrizzDir(home), join(data, "home", ".frizz"))
  assert.equal(homeProjectFrizzDir(), join(data, "home", ".frizz"))
  const repo = join(home, "repo")
  mkdirSync(repo)
  assert.equal(projectFrizzDir(repo), join(repo, ".frizz"))
  // Its id lands there, and a folder under home still resolves to itself rather than to the home project.
  const id = ensureProjectIdFile(home, home)
  assert.ok(existsSync(join(data, "home", ".frizz", ".id")))
  assert.equal(ensureProjectIdFile(home, home), id)
  const loose = join(home, "Downloads")
  mkdirSync(loose)
  assert.equal(discoverProjectRoot(loose, home), loose)
  assert.equal(existsSync(join(home, ".frizz")), false)
})

test("a home thread's scratch directory is provisioned, listed and cleaned up out of the data root", (t) => {
  const home = withHome(t)
  const expected = join(homeProjectFrizzDir(), "threads", SID)
  assert.equal(writeScratchDir(home, SID), expected)
  assert.equal(scratchDirRelPath(SID, home), expected)
  assert.equal(scratchRoot(home, SID), expected)
  writeFileSync(join(expected, "notes.md"), "hi\n")
  assert.deepEqual(scratchFiles(home, SID)?.files.map((file) => file.path), [join(realpathSync(expected), "notes.md")])
  assert.equal(cleanupAdoptionSessionFiles(home, SID), true)
  assert.equal(existsSync(expected), false)
  // Any other project's stays relative to it, exactly as before.
  const repo = join(home, "repo")
  mkdirSync(repo)
  assert.equal(writeScratchDir(repo, SID), `.frizz/threads/${SID}`)
  assert.equal(existsSync(join(home, ".frizz")), false)
})

test("a read-and-answer session reaches the home project's scratch, and nothing else in home", (t) => {
  const home = withHome(t)
  const id = ensureProjectIdFile(home, home)
  registerProject({ dir: home, id }, home)
  const repo = join(home, "repo")
  mkdirSync(repo)
  registerProject({ dir: repo, id: ensureProjectIdFile(repo, home) }, home)
  const dirs = remoteProjectDirs(home)
  assert.deepEqual(dirs, [realpathSync(repo)])

  const document = join(home, "Documents", "taxes.pdf")
  mkdirSync(dirname(document))
  writeFileSync(document, "")
  assert.equal(remoteReadablePath(document, dirs), null)
  const scratch = join(writeScratchDir(home, SID), "shot.png")
  writeFileSync(scratch, "")
  assert.equal(remoteReadablePath(scratch, dirs), realpathSync(scratch))
  assert.equal(existsSync(join(home, ".frizz")), false)
})

// The hooks run inside the worker, from its own copy of the rule (cc-worker/lib/project-frizz-dir.mjs),
// so they are run here as Claude Code runs them: a process, an event on stdin, the worker's env.
function runHook(script: string, args: string[], event: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
  return execFileSync("node", [join(HOOKS, script), ...args], { input: JSON.stringify(event), encoding: "utf8", env })
}

function workerEnv(home: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ghConfig = join(home, ".gh-empty")
  mkdirSync(ghConfig, { recursive: true })
  // No keyward on PATH, no gh token and an empty gh config: session-seed probes both, and must find neither.
  const path = (process.env.PATH ?? "").split(delimiter).filter((d) => d && !existsSync(join(d, "keyward")))
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path.join(delimiter), HOME: home, GH_CONFIG_DIR: ghConfig, CLAUDE_PROJECT_DIR: home, ...extra }
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "FRIZZ_STATE_DIR", "FRIZZ_PERM_DIR", ...XDG]) {
    if (!(name in extra)) delete env[name]
  }
  return env
}

test("the worker hooks name and make the home project's scratch, and never touch ~/.frizz", (t) => {
  const home = withHome(t)
  const stateDir = projectStateDir("11111111-2222-4333-8444-555555555555", home)
  const env = workerEnv(home, { FRIZZ_THREAD: "home-thread", FRIZZ_STATE_DIR: stateDir })
  const expected = join(homeProjectFrizzDir(), "threads", SID)

  const seed = runHook("session-seed.mjs", [], { session_id: SID, source: "startup" }, env)
  assert.match(seed, new RegExp(`SCRATCH DIRECTORY \\(OPTIONAL\\): \`${expected}/\``))
  runHook("scratchpad.mjs", ["--mode=session-start"], { session_id: SID, source: "startup" }, { ...env, FRIZZ_THREAD: "" })
  assert.ok(existsSync(expected), "the scratch hook provisions the directory it names")
  runHook(
    "agent-bind.mjs",
    [],
    { session_id: SID, tool_input: { prompt: "THREAD: some-thread\nwork", description: "child" }, tool_response: { agentId: "a1" } },
    env,
  )
  assert.equal(existsSync(join(home, ".frizz")), false)
})

test("a home worker whose data root cannot be told gets no scratch path, rather than ~/.frizz", (t) => {
  const home = withHome(t)
  const env = workerEnv(home, { FRIZZ_THREAD: "home-thread" })
  const seed = runHook("session-seed.mjs", [], { session_id: SID, source: "startup" }, env)
  assert.match(seed, /the scratch directory named in your prompt/u)
  assert.equal(runHook("scratchpad.mjs", ["--mode=session-start"], { session_id: SID, source: "startup" }, { ...env, FRIZZ_THREAD: "" }), "")
  assert.equal(existsSync(join(home, ".frizz")), false)
})
