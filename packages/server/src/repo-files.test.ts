import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
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

test("the rail keeps repo work and drops what git ignores", () => {
  const dir = repo()
  const kept = repoCarriedFiles(dir, [
    join(dir, "src/app.ts"),
    join(dir, ".frizz/notes.md"),
    join(dir, "build.log"),
  ])
  assert.deepEqual(kept, [join(dir, "src/app.ts")])
})

test("a file created but never `git add`ed still counts — the index is not the test", () => {
  const dir = repo()
  writeFileSync(join(dir, "src", "brand-new.ts"), "export {}\n")
  const kept = repoCarriedFiles(dir, [join(dir, "src/brand-new.ts")])
  assert.deepEqual(kept, [join(dir, "src/brand-new.ts")], "new work must be visible before it is committed")
})

test("a force-added file the repository really carries is kept, ignore rule notwithstanding", () => {
  const dir = repo()
  // `git add -f forced.log` against a `*.log` rule: `git ls-files` carries it, so the rail must too.
  const kept = repoCarriedFiles(dir, [join(dir, "forced.log"), join(dir, "build.log")])
  assert.deepEqual(kept, [join(dir, "forced.log")])
})

test("a path outside the project is passed through — git has no opinion on another checkout", () => {
  const dir = repo()
  const outside = join(tmpdir(), "somewhere-else", "x.ts")
  assert.deepEqual(repoCarriedFiles(dir, [outside]), [outside])
})

test("a project that is not a git repository filters nothing", () => {
  const plain = mkdtempSync(join(tmpdir(), "frizz-not-a-repo-"))
  writeFileSync(join(plain, "a.ts"), "export {}\n")
  assert.deepEqual(repoCarriedFiles(plain, [join(plain, "a.ts")]), [join(plain, "a.ts")])
})

test("row order and diffstats survive the filter", () => {
  const dir = repo()
  const rows = [
    { path: join(dir, ".frizz/notes.md"), edits: 1 },
    { path: join(dir, "src/app.ts"), edits: 2, added: 7, removed: 1 },
    { path: join(dir, "build.log"), edits: 1 },
  ]
  assert.deepEqual(repoCarriedEditedFiles(dir, rows), [{ path: join(dir, "src/app.ts"), edits: 2, added: 7, removed: 1 }])
})

test("nothing in, nothing out", () => {
  assert.deepEqual(repoCarriedFiles(repo(), []), [])
  assert.deepEqual(repoCarriedEditedFiles(repo(), []), [])
})
