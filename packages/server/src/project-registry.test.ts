import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  backfillRegistry,
  deriveSlug,
  findByPath,
  findByPathCached,
  findBySlug,
  findProjectBySegment,
  forgetProject,
  ICON_RESCAN_AFTER_MS,
  ICON_SCAN_VERSION,
  listProjects,
  moveProjectDirectory,
  readRegistry,
  registerProject,
  registryPath,
  renameProject,
  projectIconStatus,
  reorderProjects,
  resolveProjectIcon,
  setProjectIcon,
} from "./project-registry.ts"
import { launchHostDir } from "./frizz-paths.ts"

const A = "029a30af-f126-40e3-b04c-d80e74e3e090"
const B = "50577e5e-802f-4567-bd0e-cf7cbf3d2ed5"

function sandbox(): string {
  const home = mkdtempSync(join(tmpdir(), "frizz-registry-"))
  mkdirSync(join(home, ".frizz"), { recursive: true }) // legacy collapse root, so data lands under it
  return home
}
/** A directory that looks like a registered project — `.frizz/.id` is what "still exists" means. */
function project(home: string, rel: string, id?: string): string {
  const dir = join(home, rel)
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  if (id) writeFileSync(join(dir, ".frizz", ".id"), `${id}\n`)
  return dir
}

/** The registry stores canonical paths, so an expectation built from a temp dir must match. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

test("a fresh registration takes the directory basename", () => {
  const home = sandbox()
  try {
    const { entry, action } = registerProject({ dir: project(home, "code/frizz", A), id: A }, home)
    assert.equal(action, "created")
    assert.equal(entry?.slug, "frizz")
    assert.equal(findBySlug("frizz", home)?.id, A)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// `~/x/app` and `~/y/app` are both `app`. This is a live case — pullfrog/app is registered today.
test("a generic basename is qualified by its parent", () => {
  const home = sandbox()
  try {
    const { entry } = registerProject({ dir: project(home, "pullfrog/app", A), id: A }, home)
    assert.equal(entry?.slug, "pullfrog-app")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// A URL must never change under someone who bookmarked it.
test("on collision the incumbent keeps its slug and the newcomer is qualified", () => {
  const home = sandbox()
  try {
    const first = registerProject({ dir: project(home, "a/zod", A), id: A }, home)
    assert.equal(first.entry?.slug, "zod")
    const second = registerProject(
      { dir: project(home, "b/zod", B), id: B, remoteOwner: "colinhacks" },
      home,
    )
    assert.equal(second.entry?.slug, "colinhacks-zod")
    assert.equal(findBySlug("zod", home)?.id, A, "the incumbent is untouched")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a slug that would shadow Frizz's own routes is refused", () => {
  const taken = new Set<string>()
  // These are reachable: a repo really can be called `rpc` or `assets`.
  for (const reserved of ["rpc", "assets", "events", "health"]) {
    assert.notEqual(deriveSlug(`/x/${reserved}`, taken), reserved, reserved)
  }
  // `_frizz` itself is unreachable BY CONSTRUCTION — slugify strips the underscore, so a directory
  // named `_frizz` derives `frizz`, and no derived slug can ever begin with one.
  assert.equal(deriveSlug("/x/_frizz", taken), "frizz")
})

test("numeric suffixes carry on once every qualifier is taken", () => {
  const taken = new Set(["zod", "colinhacks-zod", "a-zod"])
  assert.equal(deriveSlug("/a/zod", taken, { remoteOwner: "colinhacks" }), "zod-2")
})

// The whole reason the registry is keyed by id rather than path.
test("a moved project keeps its id, its slug and its threads", () => {
  const home = sandbox()
  try {
    const before = project(home, "old/place", A)
    const first = registerProject({ dir: before, id: A }, home)
    assert.equal(first.entry?.slug, "place")
    rmSync(before, { recursive: true, force: true }) // it moved: the old path is gone

    const after = project(home, "new/place", A)
    const moved = registerProject({ dir: after, id: A }, home)
    assert.equal(moved.action, "moved")
    assert.equal(moved.entry?.slug, "place", "the URL survives the move")
    assert.equal(moved.entry?.path, canonical(after))
    assert.equal(readRegistry(home).projects.length, 1, "not a second card")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The one case an id-in-the-tree cannot tell apart on its own — and the registry sees it for free.
test("a copied checkout is detected rather than stealing the original's board", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "orig", A), id: A }, home)
    // `cp -R` brought .frizz/.id along, and the ORIGINAL still exists.
    const copy = project(home, "copy", A)
    const result = registerProject({ dir: copy, id: A }, home)
    assert.equal(result.action, "duplicate")
    assert.equal(result.entry, undefined, "nothing written — the caller mints a fresh id")
    assert.equal(readRegistry(home).projects.length, 1)
    assert.equal(readRegistry(home).projects[0]?.path, canonical(join(home, "orig")))

    // With a new id it registers as its own project.
    const reminted = registerProject({ dir: copy, id: B }, home)
    assert.equal(reminted.action, "created")
    assert.equal(readRegistry(home).projects.length, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a directory whose id changed is re-keyed in place", () => {
  const home = sandbox()
  try {
    const dir = project(home, "swap", A)
    registerProject({ dir, id: A }, home)
    const result = registerProject({ dir, id: B }, home)
    assert.equal(result.action, "rekeyed")
    assert.equal(readRegistry(home).projects.length, 1)
    assert.equal(readRegistry(home).projects[0]?.id, B)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the grid gets most-recent-first with dead paths marked stale", () => {
  const home = sandbox()
  try {
    const gone = project(home, "gone", A)
    registerProject({ dir: gone, id: A, now: () => new Date("2026-01-01T00:00:00Z") }, home)
    registerProject(
      { dir: project(home, "live", B), id: B, now: () => new Date("2026-08-01T00:00:00Z") },
      home,
    )
    rmSync(gone, { recursive: true, force: true })

    const listed = listProjects(home)
    assert.equal(listed[0]?.id, B, "most recently opened first")
    assert.equal(listed[0]?.stale, false)
    assert.equal(listed[1]?.stale, true, "the dead path is marked, not silently dropped")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a name override of null hands the card back to the folder's basename", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "work/place", A), id: A }, home)
    assert.equal(renameProject(A, { name: "Somewhere" }, home)?.name, "Somewhere")
    const cleared = renameProject(A, { name: null }, home)
    assert.equal(cleared?.name, undefined)
    assert.equal("name" in cleared!, false, "the key is gone, not set to null")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("moveProjectDirectory renames the folder to a sibling and re-registers the id there", () => {
  const home = sandbox()
  try {
    const before = project(home, "work/hypergres", A)
    const created = registerProject({ dir: before, id: A }, home)
    assert.equal(created.action, "created")
    const moved = moveProjectDirectory(A, "porg", home)
    assert.equal(moved.path, canonical(join(home, "work/porg")))
    assert.equal(moved.slug, "hypergres", "the slug is the rename dialog's to change, not the move's")
    assert.equal(existsSync(before), false)
    assert.equal(existsSync(join(home, "work/porg/.frizz/.id")), true, "the id travelled with the tree")
    assert.equal(readRegistry(home).projects.length, 1)
    assert.equal(moveProjectDirectory(A, "porg", home).path, moved.path, "the same name is a no-op")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("moveProjectDirectory refuses a path, an occupied target and a missing folder", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "work/one", A), id: A }, home)
    project(home, "work/two")
    assert.throws(() => moveProjectDirectory(A, "else/where", home), /slash/)
    assert.throws(() => moveProjectDirectory(A, "..", home), /slash/)
    assert.throws(() => moveProjectDirectory(A, "two", home), /already exists/)
    assert.throws(() => moveProjectDirectory("nope", "x", home), /No such project/)
    registerProject({ dir: project(home, "gone/here", B), id: B }, home)
    rmSync(join(home, "gone/here"), { recursive: true, force: true })
    assert.throws(() => moveProjectDirectory(B, "there", home), /missing/)
    assert.equal(existsSync(join(home, "work/one/.frizz/.id")), true, "nothing moved")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("rename is the escape hatch, and it refuses a reserved or taken slug", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "one", A), id: A }, home)
    registerProject({ dir: project(home, "two", B), id: B }, home)

    assert.equal(renameProject(A, { slug: "Work Stuff" }, home)?.slug, "work-stuff")
    assert.equal(findBySlug("work-stuff", home)?.id, A)
    assert.throws(() => renameProject(A, { slug: "rpc" }, home), /reserved/)
    assert.throws(() => renameProject(A, { slug: "two" }, home), /already uses/)

    assert.equal(renameProject(A, { archived: true }, home)?.archived, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// A `/_frizz/<segment>/…` request may name a project either way, and the id exists for exactly the
// case below: a worker is handed its project segment once, at spawn, and then holds it for hours
// inside a detached daemon. A slug renamed under it would leave every frizz tool addressing an unknown
// segment — which falls through to whichever project launched the server, not to an error.
test("a project segment resolves by slug OR by id, so a rename cannot strand a live worker", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "one", A), id: A }, home)
    assert.equal(findProjectBySegment("one", home)?.id, A)
    assert.equal(findProjectBySegment(A, home)?.id, A)

    renameProject(A, { slug: "renamed" }, home)
    assert.equal(findProjectBySegment("one", home), undefined)
    assert.equal(findProjectBySegment(A, home)?.id, A, "the id outlives the rename")
    assert.equal(findProjectBySegment("nobody", home), undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a corrupt registry reads as empty rather than throwing", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "p", A), id: A }, home)
    writeFileSync(join(home, ".frizz", "registry.json"), "{ not json")
    assert.deepEqual(readRegistry(home).projects, [], "an index that cannot be read is rebuilt, not fatal")
    const again = registerProject({ dir: project(home, "p", A), id: A }, home)
    assert.equal(again.action, "created")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("an entry an older server wrote for Frizz's own launch folder is never listed, and the next write drops it", () => {
  const home = sandbox()
  try {
    const host = launchHostDir(home)
    mkdirSync(join(host, ".frizz"), { recursive: true })
    writeFileSync(join(host, ".frizz", ".id"), `${B}\n`)
    // A project of the operator's own that is merely NAMED host is theirs, and stays.
    const mine = registerProject({ dir: project(home, "code/host", A), id: A }, home).entry!
    // What frizz-server 0.15.20 and older left behind: its boot backfill had no refusal for this folder.
    const file = JSON.parse(readFileSync(registryPath(home), "utf8"))
    file.projects.push({ ...mine, id: B, path: canonical(host), slug: "frizz-host" })
    writeFileSync(registryPath(home), JSON.stringify(file))

    assert.deepEqual(listProjects(home).map((entry) => entry.id), [A])
    assert.equal(findProjectBySegment("frizz-host", home), undefined)
    assert.equal(findProjectBySegment(B, home), undefined)
    assert.equal(findByPath(host, home), undefined)
    assert.equal(findProjectBySegment(mine.slug, home)?.id, A)

    renameProject(A, { name: "Mine" }, home)
    const written = JSON.parse(readFileSync(registryPath(home), "utf8")) as { projects: { id: string }[] }
    assert.deepEqual(written.projects.map((entry) => entry.id), [A])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("forgetting a project removes exactly one card", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "one", A), id: A }, home)
    registerProject({ dir: project(home, "two", B), id: B }, home)
    assert.equal(forgetProject(A, home), true)
    assert.equal(forgetProject(A, home), false, "idempotent")
    assert.deepEqual(readRegistry(home).projects.map((p) => p.id), [B])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// A machine that has been running Frizz for months arrives at its first grid with ONE card, and the
// only way to fill it would be to visit every repository in a terminal — the chore one server per
// machine exists to end. Everything needed is already on disk.
test("backfill recovers projects from existing state dirs, and refuses to guess", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-backfill-"))
  try {
    const stateDir = (id: string) => join(home, ".frizz", "projects", id)
    const seed = (id: string, dir: string, file = "server.lock") => {
      mkdirSync(stateDir(id), { recursive: true })
      writeFileSync(join(stateDir(id), file), JSON.stringify({ projectDir: dir }))
    }
    const repo = (name: string) => {
      const dir = join(home, name)
      mkdirSync(dir, { recursive: true })
      return dir
    }

    const alpha = repo("alpha")
    const beta = repo("beta")
    const movedAway = join(home, "gone")
    const reidentified = repo("reidentified")

    seed("id-alpha", alpha)
    seed("id-beta", beta, "project-launch.owner") // the other file the launcher leaves
    seed("id-gone", movedAway) // directory no longer exists
    seed("id-stale", reidentified) // the project claims a DIFFERENT id now

    // Stands in for each project's own `.frizz/.id`.
    const claims: Record<string, string> = {
      [canonical(alpha)]: "id-alpha",
      [canonical(beta)]: "id-beta",
      [canonical(reidentified)]: "id-something-else",
    }
    const recovered = backfillRegistry(home, (root) => claims[root])
    assert.equal(recovered, 2)

    const slugs = listProjects(home).map((p) => p.slug).sort()
    assert.deepEqual(slugs, ["alpha", "beta"])
    assert.equal(
      listProjects(home).some((p) => p.path === canonical(movedAway)),
      false,
      "a directory that no longer exists is not a project",
    )
    assert.equal(
      listProjects(home).some((p) => p.path === canonical(reidentified)),
      false,
      "a checkout that claims another id is skipped rather than guessed at",
    )

    // Idempotent: a second pass adds nothing and disturbs nothing.
    assert.equal(backfillRegistry(home, (root) => claims[root]), 0)
    assert.deepEqual(listProjects(home).map((p) => p.slug).sort(), ["alpha", "beta"])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("recency is the default order, and the operator's arrangement replaces it", () => {
  const home = sandbox()
  try {
    const ids = [A, B, "7c1a0000-0000-4000-8000-000000000003"]
    ids.forEach((id, index) => {
      registerProject({ dir: project(home, `code/p${index}`, id), id, now: () => new Date(2026, 0, index + 1) }, home)
    })
    // Newest first while nobody has arranged anything.
    assert.deepEqual(listProjects(home).map((p) => p.id), [ids[2], ids[1], ids[0]])

    reorderProjects([ids[0], ids[2], ids[1]], home)
    assert.deepEqual(listProjects(home).map((p) => p.id), [ids[0], ids[2], ids[1]])
    // EVERY project is pinned, not only the one that moved — a half-ordered list falls back to
    // recency for the rest, and then the tail keeps rearranging itself under the operator.
    assert.deepEqual(readRegistry(home).projects.map((p) => p.order).sort(), [0, 1, 2])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a project registered after an arrangement lands at the end rather than jumping to the top", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "code/a", A), id: A, now: () => new Date(2026, 0, 1) }, home)
    registerProject({ dir: project(home, "code/b", B), id: B, now: () => new Date(2026, 0, 2) }, home)
    reorderProjects([A, B], home)

    const C = "7c1a0000-0000-4000-8000-00000000000c"
    registerProject({ dir: project(home, "code/c", C), id: C, now: () => new Date(2026, 0, 9) }, home)
    // Newest by a mile, and still last: the operator arranged this list and a newcomer does not get
    // to displace the top of it.
    assert.deepEqual(listProjects(home).map((p) => p.id), [A, B, C])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("reordering a subset keeps the projects it did not name, after the ones it did", () => {
  const home = sandbox()
  try {
    const ids = [A, B, "7c1a0000-0000-4000-8000-000000000003"]
    ids.forEach((id, index) => {
      registerProject({ dir: project(home, `code/p${index}`, id), id, now: () => new Date(2026, 0, index + 1) }, home)
    })
    // A client that was mid-drag when a third project appeared sends only the two it knew about.
    reorderProjects([ids[1], ids[0]], home)
    assert.deepEqual(listProjects(home).map((p) => p.id), [ids[1], ids[0], ids[2]])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// `server.lock` and `project-launch.owner` are LIVENESS records — removed when the server stops. A
// backfill reading only those recovers whatever happened to be running and nothing else, which is why
// boron and pullfrog/app stayed missing from the maintainer's grid even after the identity fix that
// was supposed to find them. `launcher.json` is the one that survives (2026-08-06).
test("backfill recovers a project whose server is STOPPED, not just a running one", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-backfill-stopped-"))
  try {
    const stopped = join(home, "stopped-project")
    const running = join(home, "running-project")
    for (const [id, dir, file] of [["id-stopped", stopped, "launcher.json"], ["id-running", running, "server.lock"]]) {
      mkdirSync(dir, { recursive: true })
      const sd = join(home, ".frizz", "projects", id)
      mkdirSync(sd, { recursive: true })
      writeFileSync(join(sd, file), JSON.stringify({ projectDir: dir }))
    }
    const claims: Record<string, string> = { [canonical(stopped)]: "id-stopped", [canonical(running)]: "id-running" }
    assert.equal(backfillRegistry(home, (root) => claims[root]), 2)
    assert.deepEqual(listProjects(home).map((p) => p.slug).sort(), ["running-project", "stopped-project"])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// A server on Frizz's own folder opens every project as one of many, and leaves no `launcher.json` in
// any of them: the serving record it keeps is what names the folder.
test("backfill recovers a project a server opened as one of many, from its serving record", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-backfill-serving-"))
  try {
    const dir = join(home, "opened-project")
    const stateDir = join(home, ".frizz", "projects", A)
    mkdirSync(dir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, "serving.json"), JSON.stringify({ version: 1, projectId: A, projectDir: dir, updatedAt: "2026-10-11T20:00:00.000Z" }))
    assert.equal(backfillRegistry(home, (root) => ({ [canonical(dir)]: A })[root]), 1)
    assert.deepEqual(listProjects(home).map((p) => p.slug), ["opened-project"])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// Forgetting keeps the state dir, and the folder still claims the id — exactly what backfill adopts.
// So a project deleted from the grid came back at the next boot, and the project the server is hosted
// on came back at every restart of the server under its launcher, whose owner record names it.
test("a forgotten project is not recovered by backfill until it is opened again", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-backfill-forgotten-"))
  try {
    const dir = join(home, "forgotten-project")
    const stateDir = join(home, ".frizz", "projects", A)
    mkdirSync(dir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, "launcher.json"), JSON.stringify({ projectDir: dir }))
    const claims: Record<string, string> = { [canonical(dir)]: A }

    registerProject({ dir, id: A }, home)
    assert.equal(forgetProject(A, home), true)
    assert.equal(backfillRegistry(home, (root) => claims[root]), 0)
    assert.deepEqual(listProjects(home), [])

    // Opening it again — the launcher, or the grid's add — is what ends the forgetting.
    registerProject({ dir, id: A }, home)
    assert.equal(readRegistry(home).forgotten, undefined)
    assert.equal(forgetProject(A, home), true)

    // With its state deleted too there is nothing left to recover, so nothing is remembered.
    registerProject({ dir, id: A }, home)
    rmSync(stateDir, { recursive: true, force: true })
    assert.equal(forgetProject(A, home), true)
    assert.equal(readRegistry(home).forgotten, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// A rail rendered the same project twice — `/var/...` and `/private/var/...`, two ids, two slugs —
// because the launcher realpaths and the grid's add path did not. On macOS /var IS a symlink, so this
// is the default state of every temp path, not an edge case (2026-08-06).
test("one directory registers once, whatever spelling of its path a caller uses", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-canonical-"))
  try {
    const real = realpathSync(home)
    const dir = join(real, "project")
    mkdirSync(dir, { recursive: true })
    // The symlinked spelling, if this platform has one; otherwise the same path twice, which still
    // pins that a second registration of one directory is not a second project.
    const alias = join(home, "project")

    const first = registerProject({ dir: alias, id: "id-1" }, home)
    assert.equal(first.action, "created")
    assert.equal(first.entry?.path, canonical(alias), "stored canonically")

    const again = registerProject({ dir, id: "id-1" }, home)
    assert.notEqual(again.action, "created", "the same directory is not a new project")
    assert.equal(listProjects(home).length, 1)

    // And a lookup by either spelling finds it.
    assert.ok(findByPath(dir, home))
    assert.ok(findByPath(alias, home))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a cached 'no icon' is re-asked when the SCANNER changes, not just when it ages out", () => {
  const home = sandbox()
  try {
    const dir = project(home, "code/nub", A)
    registerProject({ dir, id: A }, home)

    // An older scanner concluded there was nothing here, moments ago.
    let asked = 0
    assert.equal(resolveProjectIcon(A, () => { asked++; return undefined }, { home, version: 1 }), undefined)
    assert.equal(asked, 1)

    // Same scanner version → the remembered answer stands, and nothing is re-scanned.
    assert.equal(resolveProjectIcon(A, () => { asked++; return undefined }, { home, version: 1 }), undefined)
    assert.equal(asked, 1, "a fresh answer from the same scanner is not re-asked")

    // A NEWER scanner → asked again immediately, without waiting out the 12-hour retry. This is the
    // difference between shipping a scan fix and shipping it half a day later.
    const found = join(dir, "site", "public", "icon.svg")
    assert.equal(resolveProjectIcon(A, () => { asked++; return found }, { home, version: 2 }), found)
    assert.equal(asked, 2)
    assert.equal(readRegistry(home).projects[0]?.iconScanVersion, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the shipped scan version is what an unversioned cache is compared against", () => {
  const home = sandbox()
  try {
    const dir = project(home, "code/legacy", A)
    registerProject({ dir, id: A }, home)
    // An entry written before versioning existed has no iconScanVersion at all, so it must re-scan.
    let asked = 0
    resolveProjectIcon(A, () => { asked++; return undefined }, { home })
    assert.equal(asked, 1)
    assert.equal(readRegistry(home).projects[0]?.iconScanVersion, ICON_SCAN_VERSION)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a scanner version NEVER overrules the operator's own uploaded icon", () => {
  const home = sandbox()
  try {
    const dir = project(home, "code/app", A)
    registerProject({ dir, id: A }, home)
    const chosen = join(home, "chosen.png")
    writeFileSync(chosen, "not really a png, but it exists")
    setProjectIcon(A, chosen, home)

    // Every entry written before versioning existed has NO iconScanVersion, so it reads as stale. A
    // version bump discarding those would have thrown away every uploaded icon on the machine at
    // once — measured on a real registry, where `pullfrog/app` fell back to its monogram with the
    // file it had been given sitting right there on disk.
    let scanned = 0
    const got = resolveProjectIcon(A, () => { scanned++; return join(dir, "detected.png") }, { home, version: 99 })
    assert.equal(got, chosen)
    assert.equal(scanned, 0, "a custom icon is not a scan result and must not trigger one")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a custom icon that has gone missing stays missing rather than being re-detected", () => {
  const home = sandbox()
  try {
    const dir = project(home, "code/app", A)
    registerProject({ dir, id: A }, home)
    setProjectIcon(A, join(home, "deleted.png"), home)
    let scanned = 0
    assert.equal(resolveProjectIcon(A, () => { scanned++; return join(dir, "found.png") }, { home }), undefined)
    assert.equal(scanned, 0, "their choice is recorded; picking a different picture for them is not the fix")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a miss from an OLDER scanner reads as unknown, so the client asks again", () => {
  // The two halves of the version mechanism have to agree. The client suppresses the icon request for
  // a `none`, and the server can only rescan when a request ARRIVES — so if a pre-versioning miss
  // still read as `none`, a widened scan would never be asked about the very projects it was widened
  // for. This is the exact shape of nub on the real machine: its icon resolves correctly on demand,
  // and the grid never demanded it.
  const now = Date.parse("2026-08-07T00:05:00.000Z")
  const scannedAt = "2026-08-07T00:00:00.000Z"
  assert.equal(projectIconStatus({ icon: "/x/icon.svg" }, now), "icon")
  assert.equal(projectIconStatus({}, now), "unknown", "never scanned")
  assert.equal(projectIconStatus({ iconScannedAt: scannedAt }, now), "unknown", "scanned before versioning existed")
  assert.equal(projectIconStatus({ iconScannedAt: scannedAt, iconScanVersion: ICON_SCAN_VERSION - 1 }, now), "unknown", "an older scanner")
  assert.equal(projectIconStatus({ iconScannedAt: scannedAt, iconScanVersion: ICON_SCAN_VERSION }, now), "none", "the current scanner really did find nothing")
})

test("an OLD miss reads as unknown and is re-scanned, so an icon added since the scan is found", () => {
  // keyward, ccbroker and macwatch on the real machine (2026-10-11): each was scanned in the morning,
  // found nothing, and committed a `logo.svg` hours later. The card said `none`, so the client never
  // asked, so the server's own retry never ran, and none of the three ever showed its new icon.
  const home = sandbox()
  try {
    const dir = project(home, "code/keyward", A)
    registerProject({ dir, id: A }, home)
    const scannedAt = Date.parse("2026-10-11T15:59:23.740Z")
    let asked = 0
    assert.equal(resolveProjectIcon(A, () => { asked++; return undefined }, { home, now: () => scannedAt }), undefined)
    const miss = () => readRegistry(home).projects[0]!

    // Inside the window: the miss stands, on BOTH halves, and nothing is re-walked.
    const soon = scannedAt + ICON_RESCAN_AFTER_MS - 1
    assert.equal(projectIconStatus(miss(), soon), "none")
    assert.equal(resolveProjectIcon(A, () => { asked++; return undefined }, { home, now: () => soon }), undefined)
    assert.equal(asked, 1)

    // Past it: the card tells the client to ask, and the asking finds the logo.
    const later = scannedAt + ICON_RESCAN_AFTER_MS
    assert.equal(projectIconStatus(miss(), later), "unknown", "the client has to request the icon for the rescan to run")
    const logo = join(dir, "logo.svg")
    assert.equal(resolveProjectIcon(A, () => { asked++; return logo }, { home, now: () => later }), logo)
    assert.equal(asked, 2)
    assert.equal(projectIconStatus(miss(), later), "icon")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("an old detected pick is re-scanned too, so a better icon added beside it replaces it", () => {
  const home = sandbox()
  try {
    const dir = project(home, "code/app", A)
    registerProject({ dir, id: A }, home)
    const favicon = join(dir, "favicon.ico")
    const logo = join(dir, "logo.svg")
    writeFileSync(favicon, "")
    writeFileSync(logo, "")
    const scannedAt = Date.parse("2026-10-11T09:00:00.000Z")
    resolveProjectIcon(A, () => favicon, { home, now: () => scannedAt })

    let asked = 0
    const soon = scannedAt + ICON_RESCAN_AFTER_MS - 1
    assert.equal(resolveProjectIcon(A, () => { asked++; return logo }, { home, now: () => soon }), favicon)
    assert.equal(asked, 0, "a current pick that is still on disk is served without a walk")

    const later = scannedAt + ICON_RESCAN_AFTER_MS
    assert.equal(resolveProjectIcon(A, () => { asked++; return logo }, { home, now: () => later }), logo)
    assert.equal(asked, 1)
    const entry = readRegistry(home).projects[0]!
    assert.equal(entry.icon, logo)
    assert.equal(entry.iconScannedAt, new Date(later).toISOString(), "a new scan is a new iconVersion, so the client's URL changes")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// A board build asks for its own project's slug on every build (board.ts assemble). The cached lookup
// answers without reading the file while the file is the one it read, and reads it again the moment any
// writer replaces or rewrites it: this process through writeRegistry, or another one in place.
test("findByPathCached: the same answer while the file is unchanged, and the new one after any write", () => {
  const home = sandbox()
  try {
    const dir = project(home, "code/frizz", A)
    registerProject({ dir, id: A }, home)
    const first = findByPathCached(dir, home)
    assert.equal(first?.slug, "frizz")
    assert.equal(findByPathCached(dir, home), first, "unchanged file: the remembered entry, not a fresh read")

    renameProject(A, { slug: "renamed" }, home)
    assert.equal(findByPathCached(dir, home)?.slug, "renamed", "a write through writeRegistry is seen at once")

    // Another process rewriting the file IN PLACE (same inode, same size): only its instants move.
    const path = registryPath(home)
    const text = readFileSync(path, "utf8")
    writeFileSync(path, text.replace('"slug": "renamed"', '"slug": "rename2"'))
    assert.equal(findByPathCached(dir, home)?.slug, "rename2", "an in-place rewrite is seen at once")
    assert.deepEqual(findByPathCached(dir, home), findByPath(dir, home), "and it is what the uncached lookup says")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
