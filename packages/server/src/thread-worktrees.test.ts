import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AddOwnWorktreeInput } from "@frizz/shared"
import type { AppContext } from "./context.ts"
import { openableFileRoots } from "./project.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { registeredWorktreeRoots } from "./worktree-changes.ts"

// `frizzctl worktree`'s three procedures over a real storage and a real git checkout: what a worker can
// register, how it reads back, and who can take it away.
function harness() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frizz-thread-worktrees-")))
  const repo = join(dir, "repo")
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" })
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "t@example.com")
  git(repo, "config", "user.name", "t")
  git(repo, "config", "commit.gpgsign", "false")
  writeFileSync(join(repo, "a.ts"), "a\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "init")
  const worktree = join(dir, "effort")
  git(repo, "worktree", "add", "-q", "-b", "effort", worktree)
  const path = join(dir, "ui.db")
  const storage = createStorage(path, "worktrees-a")
  for (const slug of ["own", "other"]) storage.upsertSession({
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } satisfies SessionRow)
  const router = createRouter({
    project: { dir: repo, stateDir: dir }, storage,
    board: { refresh: () => {} }, tailer: { get: () => undefined },
  } as unknown as AppContext)
  const register = (input: { slug?: string; path: string; base?: string }) =>
    router.addOwnWorktree.handler({ input: AddOwnWorktreeInput.parse({ slug: "own", ...input }) })
  return { dir, repo, worktree, path, storage, router, register, close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("a checkout registers once per thread, reads back through activity, and takes a new base", async () => {
  const h = harness()
  try {
    const first = await h.register({ path: h.worktree })
    assert.equal(first.alreadyRegistered, false)
    assert.match(first.worktree.id, /^wtr_[0-9a-f]{12}$/)
    assert.deepEqual(first.worktree, { id: first.worktree.id, path: h.worktree })
    const again = await h.register({ path: h.worktree, base: "main" })
    assert.equal(again.alreadyRegistered, true)
    assert.deepEqual(again.worktree, { id: first.worktree.id, path: h.worktree, base: "main" })
    // Registering again without a base keeps the one it has.
    assert.equal((await h.register({ path: h.worktree })).worktree.base, "main")
    assert.deepEqual((await h.router.listOwnWorktrees.handler({ input: { slug: "own" } })).worktrees, [again.worktree])
    const activity = await h.router.listOwnThreadActivity.handler({ input: { slug: "own" } })
    assert.deepEqual(activity.activity, [], "a registration is not running work")
    assert.deepEqual(activity.worktrees, [again.worktree])
    const reopened = createStorage(h.path, "worktrees-a")
    try { assert.equal(reopened.listThreadWorktrees("own")[0].id, first.worktree.id) } finally { reopened.close() }
  } finally { h.close() }
})

test("only the top of a real checkout registers, with a base it has, on an open thread", async () => {
  const h = harness()
  try {
    await assert.rejects(h.register({ path: join(h.worktree, "nested") }), /does not exist/)
    mkdirSync(join(h.worktree, "nested"))
    await assert.rejects(h.register({ path: join(h.worktree, "nested") }), /inside the checkout/)
    await assert.rejects(h.register({ path: h.dir }), /not a git checkout/)
    await assert.rejects(h.register({ path: h.worktree, base: "no-such-branch" }), /names no commit/)
    assert.throws(() => AddOwnWorktreeInput.parse({ slug: "own", path: h.worktree, base: "--output=/tmp/x" }), "a base git could read as a flag")
    await assert.rejects(h.register({ slug: "absent", path: h.worktree }), /not registered/)
    h.storage.setState("own", "archived")
    await assert.rejects(h.register({ path: h.worktree }), /Reopen/)
    assert.deepEqual(h.storage.registeredCheckoutPaths(), [])
  } finally { h.close() }
})

test("a registration is dropped by id or by any spelling of its path, only by its own thread and project", async () => {
  const h = harness()
  const other = createStorage(h.path, "worktrees-b")
  try {
    const { worktree } = await h.register({ path: h.worktree })
    other.upsertThreadWorktree({ id: "wtr_foreign", slug: "own", path: h.worktree, base: null, createdAtMs: 1 })
    assert.equal((await h.router.dropOwnWorktree.handler({ input: { slug: "other", target: worktree.id } })).dropped, false)
    assert.equal(other.dropThreadWorktree("own", worktree.id), false)
    assert.equal((await h.router.dropOwnWorktree.handler({ input: { slug: "own", target: worktree.id } })).dropped, true)
    assert.equal((await h.router.dropOwnWorktree.handler({ input: { slug: "own", target: worktree.id } })).dropped, false)

    await h.register({ path: h.worktree })
    const alias = join(h.dir, "alias")
    symlinkSync(h.worktree, alias)
    const byAlias = await h.router.dropOwnWorktree.handler({ input: { slug: "own", target: alias } })
    assert.equal(byAlias.dropped, true)
    assert.deepEqual(byAlias.worktrees, [])
    assert.equal(other.listThreadWorktrees("own").length, 1, "another project's same-slug thread keeps its own")

    await h.register({ path: h.worktree })
    h.storage.forgetSession("own")
    assert.deepEqual(h.storage.listThreadWorktrees("own"), [], "a retired thread's registrations go with it")
  } finally { other.close(); h.close() }
})

test("a registered checkout is one of the file readers' roots for every project, not only its own", async () => {
  const h = harness()
  // Another project on the same machine database. The Console asks the first open project for a path
  // outside them all (web lib/consoleProjects.ts), so its gate must answer as the registering one does.
  const other = createStorage(h.path, "worktrees-b")
  try {
    const project = { dir: h.repo, stateDir: h.dir }
    for (const storage of [h.storage, other]) assert.ok(!openableFileRoots(project, registeredWorktreeRoots(storage)).includes(h.worktree))
    await h.register({ path: h.worktree })
    for (const storage of [h.storage, other]) assert.ok(openableFileRoots(project, registeredWorktreeRoots(storage)).includes(h.worktree))
    h.storage.forgetSession("own")
    assert.ok(!openableFileRoots(project, registeredWorktreeRoots(other)).includes(h.worktree), "the registration went with its thread")
  } finally { other.close(); h.close() }
})
