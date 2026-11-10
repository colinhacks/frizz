import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveProject } from "./project.ts"
import { readGitProjectId } from "./project-identity.ts"
import { findByPath, forgetProject, registerProject, seedProjectId } from "./project-registry.ts"
import { readProjectIdFile } from "./project-root.ts"
import { addProjectAtPath } from "./router.ts"

// `.frizz/` IS DELETED, AND THE BOARD COMES BACK.
//
// The folder is ignored by Git and looks like scratch, so it goes: by hand (the README says it is
// safe), by `git clean -fdx`, by a fresh clone into the same place. The id file goes with it. A
// repository the launcher had opened was recovered from `git config frizz.id`; a plain folder, and a
// repository added from the dashboard, were given a new id and an empty board, their threads still on
// disk under an id nothing led back to. Real functions here, a temp home, real folders, real `git`.

function sandbox(t: { after: (fn: () => void) => void }): { home: string; folder: (name: string, git: boolean) => string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "frizz-id-file-deleted-")))
  mkdirSync(join(home, ".frizz"), { recursive: true }) // legacy collapse root, so state lands under it
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return {
    home,
    folder: (name, git) => {
      const dir = join(home, "work", name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "package.json"), "{}\n")
      if (git) execFileSync("git", ["init", "-q", dir])
      return dir
    },
  }
}

/** What `frizz` typed in the folder runs, and what the dashboard's "Add a project" runs. */
const launch = (dir: string, home: string) => resolveProject(dir, home).id
const add = (dir: string, home: string) => addProjectAtPath(dir, home).id
const deleteFrizz = (dir: string) => rmSync(join(dir, ".frizz"), { recursive: true, force: true })

for (const git of [false, true]) {
  for (const [firstName, first] of [["the launcher", launch], ["the dashboard", add]] as const) {
    for (const [againName, again] of [["the launcher", launch], ["the dashboard", add]] as const) {
      test(`a ${git ? "repository" : "plain folder"} first opened by ${firstName} keeps its board when .frizz/ is deleted and ${againName} opens it again`, (t) => {
        const { home, folder } = sandbox(t)
        const dir = folder("app", git)
        const id = first(dir, home)
        deleteFrizz(dir)
        assert.equal(readProjectIdFile(dir), undefined)
        assert.equal(again(dir, home), id, "the same project, so the same board")
        assert.equal(readProjectIdFile(dir), id, "and the id file is back")
        assert.equal(findByPath(dir, home)?.id, id)
      })
    }
  }
}

// The launcher gives a repository a `git config frizz.id` when it finds none, even when the id file
// already names the project. A repository added from the dashboard and launched later therefore
// carries a second id in Git that no board has ever had, and that id must not be what comes back.
test("a repository added from the dashboard, launched, and then stripped of .frizz/ keeps the dashboard's board", (t) => {
  const { home, folder } = sandbox(t)
  const dir = folder("app", true)
  const id = add(dir, home)
  assert.equal(launch(dir, home), id)
  const inGit = readGitProjectId(dir)
  deleteFrizz(dir)
  assert.equal(launch(dir, home), id, `not the id only Git holds (${inGit === id ? "the same here" : "a different one"})`)
})

test("a fresh clone into a folder Frizz knew opens that folder's board", (t) => {
  const { home, folder } = sandbox(t)
  const dir = folder("app", true)
  const id = launch(dir, home)
  rmSync(dir, { recursive: true, force: true })
  folder("app", true) // nothing of the old checkout: no id file, no frizz.id in its config
  assert.equal(launch(dir, home), id)
})

// The controls: what must still get an id of its own.
test("a folder Frizz has never seen is given a new id", (t) => {
  const { home, folder } = sandbox(t)
  const known = launch(folder("known", false), home)
  const fresh = launch(folder("fresh", false), home)
  assert.notEqual(fresh, known)
})

test("a checkout copied without its .frizz/ does not take the original's board", (t) => {
  const { home, folder } = sandbox(t)
  const original = folder("app", true)
  const id = launch(original, home)
  // `cp -R` of everything but the ignored folder: Git's config, and the frizz.id in it, come along.
  const copy = join(home, "work", "app-copy")
  cpSync(original, copy, { recursive: true, filter: (source) => !source.includes(`${join("app", ".frizz")}`) })
  assert.equal(existsSync(join(copy, ".frizz")), false)
  assert.equal(readGitProjectId(copy), id)
  const copied = launch(copy, home)
  assert.notEqual(copied, id, "the copy is its own project")
  assert.equal(launch(original, home), id, "and the original keeps its board")
})

test("a project the operator removed from Frizz is not brought back by its folder", (t) => {
  const { home, folder } = sandbox(t)
  const dir = folder("app", false)
  const id = add(dir, home)
  forgetProject(id, home)
  deleteFrizz(dir)
  assert.notEqual(add(dir, home), id)
})

test("seedProjectId: the folder's own entry, unless Git names a project the registry files elsewhere", (t) => {
  const { home, folder } = sandbox(t)
  const here = folder("here", false)
  const elsewhere = folder("elsewhere", false)
  const HERE = "029a30af-f126-40e3-b04c-d80e74e3e090"
  const ELSEWHERE = "50577e5e-802f-4567-bd0e-cf7cbf3d2ed5"
  const STRANGER = "88abce4f-16e9-42b3-899d-2576382b2ff3"
  assert.equal(seedProjectId(here, home), undefined, "nothing known: the caller mints")
  assert.equal(seedProjectId(here, home, STRANGER), STRANGER, "nothing known but Git's id")
  registerProject({ dir: here, id: HERE }, home)
  registerProject({ dir: elsewhere, id: ELSEWHERE }, home)
  assert.equal(seedProjectId(here, home), HERE)
  assert.equal(seedProjectId(here, home, HERE), HERE)
  assert.equal(seedProjectId(here, home, STRANGER), HERE, "an id only Git holds is no board")
  assert.equal(seedProjectId(here, home, ELSEWHERE), ELSEWHERE, "a checkout moved or copied here: registerProject decides")
  assert.equal(seedProjectId(join(home, "work", "unknown"), home, ELSEWHERE), ELSEWHERE)
})
