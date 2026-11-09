import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { repoCarriedFiles, repoCarriedEditedFiles } from "./repo-files.ts"

// A REAL repository every time: the whole module is a question put to git, so a mocked git would only
// ever confirm what this file already believes. The force-added case below is exactly the one a
// hand-rolled ignore matcher gets wrong.
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "frizz-repo-files-"))
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
  run(["init", "-q", "-b", "main"])
  run(["config", "user.email", "t@example.com"])
  run(["config", "user.name", "t"])
  writeFileSync(join(dir, ".gitignore"), ".frizz/\nnode_modules/\n*.log\n")
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, ".frizz", "notes.md"), "scratch\n")
  writeFileSync(join(dir, "src", "app.ts"), "export {}\n")
  writeFileSync(join(dir, "build.log"), "noise\n")
  writeFileSync(join(dir, "forced.log"), "kept anyway\n")
  run(["add", ".gitignore", "src/app.ts"])
  run(["add", "-f", "forced.log"])
  run(["commit", "-qm", "init"])
  return dir
}

test("the rail keeps repo work and drops what git ignores", async () => {
  const dir = repo()
  const kept = await repoCarriedFiles(dir, [
    join(dir, "src/app.ts"),
    join(dir, ".frizz/notes.md"),
    join(dir, "build.log"),
  ])
  assert.deepEqual(kept, [join(dir, "src/app.ts")])
})

test("a file created but never `git add`ed still counts — the index is not the test", async () => {
  const dir = repo()
  writeFileSync(join(dir, "src", "brand-new.ts"), "export {}\n")
  const kept = await repoCarriedFiles(dir, [join(dir, "src/brand-new.ts")])
  assert.deepEqual(kept, [join(dir, "src/brand-new.ts")], "new work must be visible before it is committed")
})

test("a force-added file the repository really carries is kept, ignore rule notwithstanding", async () => {
  const dir = repo()
  // `git add -f forced.log` against a `*.log` rule: `git ls-files` carries it, so the rail must too.
  const kept = await repoCarriedFiles(dir, [join(dir, "forced.log"), join(dir, "build.log")])
  assert.deepEqual(kept, [join(dir, "forced.log")])
})

test("a path outside the project is passed through — git has no opinion on another checkout", async () => {
  const dir = repo()
  const outside = join(tmpdir(), "somewhere-else", "x.ts")
  assert.deepEqual(await repoCarriedFiles(dir, [outside]), [outside])
})

// THE WORKER CONTRACT'S OWN WORKTREE LOCATION, in the shape a real project has it: no top-level rule
// for `.frizz/` at all, only the `*` Frizz writes inside it (project-root.ts). Asked from the project
// root, git ignores every file in that checkout, so before this an isolated effort left the rail empty.
function repoWithWorktree(): { dir: string; worktree: string } {
  const dir = repo()
  writeFileSync(join(dir, ".frizz", ".gitignore"), "*\n")
  const worktree = join(dir, ".frizz", "worktrees", "feature")
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature", worktree], { cwd: dir, stdio: "ignore" })
  return { dir, worktree }
}

test("a file in a worktree inside the project is judged by that worktree's own ignore rules", async () => {
  const { dir, worktree } = repoWithWorktree()
  writeFileSync(join(worktree, "src", "new.ts"), "export {}\n")
  writeFileSync(join(worktree, "build.log"), "noise\n")
  const kept = await repoCarriedFiles(dir, [
    join(worktree, "src/app.ts"),
    join(worktree, "src/new.ts"),
    join(worktree, "build.log"),
    join(dir, ".frizz/notes.md"),
    join(dir, "src/app.ts"),
  ])
  assert.deepEqual(kept, [join(worktree, "src/app.ts"), join(worktree, "src/new.ts"), join(dir, "src/app.ts")])
})

test("a plain directory under .frizz/worktrees is still scratch — only a registered worktree answers for itself", async () => {
  const { dir } = repoWithWorktree()
  mkdirSync(join(dir, ".frizz", "worktrees", "not-a-checkout"), { recursive: true })
  writeFileSync(join(dir, ".frizz", "worktrees", "not-a-checkout", "a.ts"), "export {}\n")
  assert.deepEqual(await repoCarriedFiles(dir, [join(dir, ".frizz/worktrees/not-a-checkout/a.ts")]), [])
})

// Git will not judge a path spelled through a symlinked directory, and it fails the whole batch rather
// than the one path — so before this, one write through a link (this repo's `.claude/skills/<name>` is
// one) left every ignored row on the rail.
test("a path through a symlinked directory is judged where the file really is, and does not silence the rest", async () => {
  const dir = repo()
  symlinkSync("src", join(dir, "linked-src"))
  symlinkSync(".frizz", join(dir, "linked-scratch"))
  const kept = await repoCarriedFiles(dir, [
    join(dir, "linked-src/app.ts"),
    join(dir, "linked-scratch/notes.md"),
    join(dir, "build.log"),
  ])
  assert.deepEqual(kept, [join(dir, "linked-src/app.ts")])
})

test("a project that is not a git repository filters nothing", async () => {
  const plain = mkdtempSync(join(tmpdir(), "frizz-not-a-repo-"))
  writeFileSync(join(plain, "a.ts"), "export {}\n")
  assert.deepEqual(await repoCarriedFiles(plain, [join(plain, "a.ts")]), [join(plain, "a.ts")])
})

test("row order and diffstats survive the filter", async () => {
  const dir = repo()
  const rows = [
    { path: join(dir, ".frizz/notes.md"), edits: 1 },
    { path: join(dir, "src/app.ts"), edits: 2, added: 7, removed: 1 },
    { path: join(dir, "build.log"), edits: 1 },
  ]
  assert.deepEqual(await repoCarriedEditedFiles(dir, rows), [{ path: join(dir, "src/app.ts"), edits: 2, added: 7, removed: 1 }])
})

test("nothing in, nothing out", async () => {
  assert.deepEqual(await repoCarriedFiles(repo(), []), [])
  assert.deepEqual(await repoCarriedEditedFiles(repo(), []), [])
})
