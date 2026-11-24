import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { AppContext } from "./context.ts"
import { projectStateDir } from "./frizz-paths.ts"
import { ensureHomeProject, listProjects, registerProject } from "./project-registry.ts"
import { deleteProjectState } from "./project-teardown.ts"
import { createRouter } from "./router.ts"

const A = "029a30af-f126-40e3-b04c-d80e74e3e090"
const B = "50577e5e-802f-4567-bd0e-cf7cbf3d2ed5"

function sandbox(): string {
  const home = mkdtempSync(join(tmpdir(), "frizz-teardown-"))
  mkdirSync(join(home, ".frizz"), { recursive: true }) // legacy collapse root, so data lands under it
  return home
}

function stateDir(home: string, id: string): string {
  const dir = projectStateDir(id, home)
  mkdirSync(join(dir, "attachments"), { recursive: true })
  writeFileSync(join(dir, "ui.db"), "not really sqlite")
  return dir
}

test("deleting a project's state takes the whole directory and nothing above it", () => {
  const home = sandbox()
  const a = stateDir(home, A)
  const b = stateDir(home, B)
  deleteProjectState(A, home)
  assert.equal(existsSync(a), false)
  assert.equal(existsSync(b), true, "its neighbour is untouched")
  assert.equal(existsSync(join(home, ".frizz", "projects")), true, "and so is the root they sit in")
  deleteProjectState(A, home) // idempotent — force:true, so a second delete is not an error
})

// The id is spliced straight into a path. Every one of these would otherwise resolve to the projects
// root or above it, which is `rm -rf` aimed at every project on the machine.
for (const id of ["..", ".", "", "../..", "a/../..", "/"]) {
  test(`a malformed project id (${JSON.stringify(id)}) is refused rather than resolved`, () => {
    const home = sandbox()
    const kept = stateDir(home, A)
    assert.throws(() => deleteProjectState(id, home), /Refusing to delete/)
    assert.equal(existsSync(kept), true)
    assert.equal(existsSync(join(home, ".frizz", "projects")), true)
  })
}

/**
 * A sandbox home the ROUTER will actually read.
 *
 * `projectRemove` reaches the registry through `findById`/`forgetProject`, which default their `home`
 * to `homedir()` — so a sandbox that is only passed to the helpers is a sandbox the procedure under
 * test never sees, and the run would rewrite the maintainer's own registry instead. `homedir()`
 * resolves `$HOME` on POSIX and `%USERPROFILE%` on win32; node's runner gives each test FILE its own
 * process, so setting them here is contained to this one.
 */
function homeSandbox(t: { after: (fn: () => void) => void }): string {
  const home = sandbox()
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  t.after(() => {
    process.env.HOME = previous.HOME
    process.env.USERPROFILE = previous.USERPROFILE
  })
  return home
}

/**
 * The router with nothing but what `projectRemove` reaches for. Handlers are lazy, so a stub carries
 * only what `createRouter` resolves up front plus this procedure's own dependencies.
 */
function harness(options: {
  home: string
  launchProjectId?: string
  teardown?: AppContext["teardownProject"]
}) {
  const calls: { id: string; stopWorkers?: boolean; deleteState?: boolean }[] = []
  const ctx = {
    project: { dir: options.home, stateDir: options.home, id: "own" },
    storage: {},
    board: {},
    tailer: {},
    launchProjectId: options.launchProjectId,
    teardownProject:
      options.teardown ??
      (async (id: string, opts?: { stopWorkers?: boolean; deleteState?: boolean }) => {
        calls.push({ id, ...opts })
        if (opts?.deleteState) deleteProjectState(id, options.home)
        return { closed: true, stoppedWorkers: 2 }
      }),
  } as unknown as AppContext
  return { router: createRouter(ctx), calls }
}

test("removing a project forgets the registry entry and leaves its threads alone by default", async (t) => {
  const home = homeSandbox(t)
  const dir = join(home, "code", "alpha")
  // `.frizz/.id` and a file of the operator's own, so "the folder is never touched" is a real assertion.
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  writeFileSync(join(dir, ".frizz", ".id"), `${A}\n`)
  writeFileSync(join(dir, "README.md"), "theirs, not ours")
  registerProject({ dir, id: A }, home)
  const state = stateDir(home, A)

  const { router, calls } = harness({ home })
  const result = await router.projectRemove.handler({ input: { id: A } })

  assert.deepEqual(result, { removed: true, deletedData: false, stoppedWorkers: 2 })
  assert.deepEqual(calls, [{ id: A, stopWorkers: false, deleteState: false }])
  assert.equal(existsSync(state), true, "its threads survive, so re-adding the folder restores the board")
  assert.equal(existsSync(join(dir, ".frizz", ".id")), true, "the project's own directory is never touched")
  assert.equal(existsSync(join(dir, "README.md")), true)
})

test("deleteData stops the project's workers and removes everything Frizz holds for it", async (t) => {
  const home = homeSandbox(t)
  const dir = join(home, "code", "alpha")
  // `.frizz/.id` and a file of the operator's own, so "the folder is never touched" is a real assertion.
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  writeFileSync(join(dir, ".frizz", ".id"), `${A}\n`)
  writeFileSync(join(dir, "README.md"), "theirs, not ours")
  registerProject({ dir, id: A }, home)
  const state = stateDir(home, A)

  const { router, calls } = harness({ home })
  const result = await router.projectRemove.handler({ input: { id: A, deleteData: true } })

  assert.deepEqual(result, { removed: true, deletedData: true, stoppedWorkers: 2 })
  assert.deepEqual(calls, [{ id: A, stopWorkers: true, deleteState: true }])
  assert.equal(existsSync(state), false)
  assert.equal(existsSync(join(dir, ".frizz", ".id")), true, "the folder itself is still not touched")
  assert.equal(existsSync(join(dir, "README.md")), true)
})

test("deleting the data of the project Frizz is hosted on is refused, and nothing is torn down", async (t) => {
  const home = homeSandbox(t)
  const dir = join(home, "code", "alpha")
  // `.frizz/.id` and a file of the operator's own, so "the folder is never touched" is a real assertion.
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  writeFileSync(join(dir, ".frizz", ".id"), `${A}\n`)
  writeFileSync(join(dir, "README.md"), "theirs, not ours")
  registerProject({ dir, id: A }, home)
  const state = stateDir(home, A)

  const { router, calls } = harness({ home, launchProjectId: A })
  await assert.rejects(
    () => router.projectRemove.handler({ input: { id: A, deleteData: true } }),
    /threads and history cannot be deleted right now/,
  )
  assert.deepEqual(calls, [])
  assert.equal(listProjects(home).length, 1, "it is still registered")
  assert.equal(existsSync(state), true)
})

// A `frizz` run from $HOME was hosted on the most recently opened project until 2026-10-11, so the
// host was routinely a project nobody launched from — and refusing to forget it left a card the
// operator could not remove by any restart that did not start inside a DIFFERENT project (2026-10-10).
test("the project Frizz is hosted on can still be forgotten, without a teardown", async (t) => {
  const home = homeSandbox(t)
  const dir = join(home, "code", "alpha")
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  writeFileSync(join(dir, ".frizz", ".id"), `${A}\n`)
  registerProject({ dir, id: A }, home)
  const state = stateDir(home, A)

  const { router, calls } = harness({ home, launchProjectId: A })
  const result = await router.projectRemove.handler({ input: { id: A } })

  assert.deepEqual(result, { removed: true, deletedData: false, stoppedWorkers: 0 })
  assert.deepEqual(calls, [], "its tenant is the server's own, so nothing closes it")
  assert.deepEqual(listProjects(home), [])
  assert.equal(existsSync(state), true, "the state the running server stands on is untouched")
})

test("an id the registry has already forgotten reports removed: false rather than failing", async (t) => {
  const home = homeSandbox(t)
  const { router, calls } = harness({ home })
  assert.deepEqual(await router.projectRemove.handler({ input: { id: A, deleteData: true } }), {
    removed: false,
    deletedData: false,
    stoppedWorkers: 0,
  })
  assert.deepEqual(calls, [], "a project nobody knows about is never torn down")
})

test("a server with no tenant map still forgets the entry", async (t) => {
  // A one-project server, or a test context: `teardownProject` is absent and the registry half is all
  // there is to do. The alternative — refusing — would make the card unremovable.
  const home = homeSandbox(t)
  const dir = join(home, "code", "alpha")
  // `.frizz/.id` and a file of the operator's own, so "the folder is never touched" is a real assertion.
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  writeFileSync(join(dir, ".frizz", ".id"), `${A}\n`)
  writeFileSync(join(dir, "README.md"), "theirs, not ours")
  registerProject({ dir, id: A }, home)
  const ctx = {
    project: { dir: home, stateDir: home, id: "own" },
    storage: {},
    board: {},
    tailer: {},
  } as unknown as AppContext
  assert.deepEqual(await createRouter(ctx).projectRemove.handler({ input: { id: A } }), {
    removed: true,
    deletedData: false,
    stoppedWorkers: 0,
  })
  assert.equal(listProjects(home).length, 0)
})

test("removing or folder-renaming the built-in Home project is refused through the router", async (t) => {
  const home = homeSandbox(t)
  const entry = ensureHomeProject(home)
  const { router, calls } = harness({ home })
  await assert.rejects(
    () => router.projectRemove.handler({ input: { id: entry.id } }),
    /built-in/i,
  )
  await assert.rejects(
    () => router.projectRemove.handler({ input: { id: entry.id, deleteData: true } }),
    /built-in/i,
  )
  await assert.rejects(
    () => router.projectRename.handler({ input: { id: entry.id, name: "Other", renameDirectory: true } }),
    /home directory cannot be renamed/i,
  )
  assert.deepEqual(calls, [])
  assert.equal(listProjects(home).length, 1)
})
