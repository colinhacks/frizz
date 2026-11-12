import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { readLocalTextFile, type LocalFileRoot } from "./local-file.ts"
import { writeRegistry } from "./project-registry.ts"
import { inRegisteredCheckout } from "./registered-checkout.ts"

// Real repositories and real `git worktree add`: the check reads git's own link files, so a hand-written
// layout would only confirm what the check already believes about them.
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

function repository(dir: string): string {
  mkdirSync(join(dir, "src"), { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "t@example.com")
  git(dir, "config", "user.name", "t")
  writeFileSync(join(dir, "src", "app.ts"), "export const main = true\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  return dir
}

function machine() {
  const root = mkdtempSync(join(tmpdir(), "frizz-registered-checkout-"))
  const home = join(root, "home")
  mkdirSync(join(home, ".frizz"), { recursive: true })
  const registered = repository(join(root, "registered"))
  const unregistered = repository(join(root, "unregistered"))
  writeRegistry({ version: 1, projects: [{ id: "029a30af-f126-40e3-b04c-d80e74e3e090", path: registered, slug: "registered", lastOpenedAt: new Date(0).toISOString() }] }, home)
  // The check alone, without the home and temp directories, which would admit everything in this sandbox.
  const roots: LocalFileRoot[] = [(real) => inRegisteredCheckout(real, home)]
  return { root, home, registered, unregistered, roots }
}

test("a linked worktree of a registered project's repository is a root wherever it is", () => {
  const m = machine()
  const worktree = join(m.root, "volume", "worktrees", "effort")
  git(m.registered, "worktree", "add", "-q", "-b", "effort", worktree)
  writeFileSync(join(worktree, "src", "app.ts"), "export const effort = true\n")

  assert.equal(readLocalTextFile(join(worktree, "src", "app.ts"), m.roots).text, "export const effort = true\n")
  assert.equal(readLocalTextFile(join(m.registered, "src", "app.ts"), m.roots).text, "export const main = true\n", "the main checkout too")
})

test("a worktree of a repository no project is registered for stays outside", () => {
  const m = machine()
  const worktree = join(m.root, "volume", "worktrees", "stranger")
  git(m.unregistered, "worktree", "add", "-q", "-b", "stranger", worktree)

  assert.throws(() => readLocalTextFile(join(worktree, "src", "app.ts"), m.roots), /trusted roots/)
  assert.throws(() => readLocalTextFile(join(m.unregistered, "src", "app.ts"), m.roots), /trusted roots/)
})

test("a .git file planted elsewhere cannot borrow a registered worktree's admin folder", () => {
  const m = machine()
  git(m.registered, "worktree", "add", "-q", "-b", "real", join(m.root, "real"))
  const planted = join(m.root, "planted")
  mkdirSync(planted)
  writeFileSync(join(planted, ".git"), `gitdir: ${join(m.registered, ".git", "worktrees", "real")}\n`)
  writeFileSync(join(planted, "secret.txt"), "not a checkout\n")

  assert.throws(() => readLocalTextFile(join(planted, "secret.txt"), m.roots), /trusted roots/)
})

test("a .git symlinked to a registered checkout's own does not make its folder that checkout", () => {
  const m = machine()
  const worktree = join(m.root, "real")
  git(m.registered, "worktree", "add", "-q", "-b", "real", worktree)
  for (const [name, target] of [["repo", join(m.registered, ".git")], ["worktree", join(worktree, ".git")]]) {
    const borrowed = join(m.root, `borrowed-${name}`)
    mkdirSync(borrowed)
    symlinkSync(target, join(borrowed, ".git"))
    writeFileSync(join(borrowed, "secret.txt"), "not a checkout\n")
    assert.throws(() => readLocalTextFile(join(borrowed, "secret.txt"), m.roots), /trusted roots/, `a .git linked to the ${name}'s`)
  }
})

test("a worktree made after a refusal is a root at once, with nothing cached in between", () => {
  const m = machine()
  const stray = join(m.root, "volume", "stray.ts")
  mkdirSync(join(m.root, "volume"))
  writeFileSync(stray, "\n")
  assert.throws(() => readLocalTextFile(stray, m.roots), /trusted roots/)

  const worktree = join(m.root, "volume", "worktrees", "later")
  git(m.registered, "worktree", "add", "-q", "-b", "later", worktree)
  assert.equal(readLocalTextFile(join(worktree, "src", "app.ts"), m.roots).text, "export const main = true\n")
})
