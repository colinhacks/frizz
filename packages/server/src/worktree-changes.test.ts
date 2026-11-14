import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parseNameStatus, parseNumstat, registeredCheckoutRoot, underAnyRoot, worktreeChanges } from "./worktree-changes.ts"

// Real repositories and real `git worktree add`: the module reads git's own answers, so a hand-written
// layout would only confirm what it already believes.
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
}

function repository(): { root: string; repo: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-worktree-changes-")))
  const repo = join(root, "repo")
  mkdirSync(join(repo, "src"), { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "t@example.com")
  git(repo, "config", "user.name", "t")
  git(repo, "config", "commit.gpgsign", "false")
  writeFileSync(join(repo, "src", "keep.ts"), "one\ntwo\nthree\n")
  writeFileSync(join(repo, "src", "gone.ts"), "a\nb\n")
  writeFileSync(join(repo, ".gitignore"), "build/\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "init")
  return { root, repo }
}

const byPath = (files: readonly { path: string }[]) => Object.fromEntries(files.map((f) => [f.path, f]))

test("a registration names the top folder of a git checkout, and nothing else", () => {
  const { root, repo } = repository()
  const worktree = join(root, "elsewhere", "effort")
  git(repo, "worktree", "add", "-q", "-b", "effort", worktree)

  assert.equal(registeredCheckoutRoot(worktree), worktree, "a linked worktree")
  assert.equal(registeredCheckoutRoot(repo), repo, "a main checkout")
  assert.throws(() => registeredCheckoutRoot(join(worktree, "src")), /inside the checkout at `.*effort`, not the top of one/)
  assert.throws(() => registeredCheckoutRoot(root), /not a git checkout/)
  assert.throws(() => registeredCheckoutRoot("/"), /not a git checkout/)
  assert.throws(() => registeredCheckoutRoot(join(root, "missing")), /does not exist/)
  assert.throws(() => registeredCheckoutRoot("relative/path"), /not an absolute path/)
  assert.throws(() => registeredCheckoutRoot(join(repo, "src", "keep.ts")), /is a file/)

  // A `.git` symlinked to a real checkout's would lend that checkout's identity to any folder.
  const borrowed = join(root, "borrowed")
  mkdirSync(borrowed)
  symlinkSync(join(repo, ".git"), join(borrowed, ".git"))
  assert.throws(() => registeredCheckoutRoot(borrowed), /not a git checkout/)

  // A path spelled through a symlink registers as the folder it reaches.
  const alias = join(root, "alias")
  symlinkSync(worktree, alias)
  assert.equal(registeredCheckoutRoot(alias), worktree)
})

test("a worktree's changes are its branch against where it left main: committed, uncommitted, untracked and deleted", async () => {
  const { root, repo } = repository()
  const worktree = join(root, "effort")
  git(repo, "worktree", "add", "-q", "-b", "effort", worktree)
  // Committed on the branch.
  writeFileSync(join(worktree, "src", "keep.ts"), "one\nTWO\nthree\nfour\n")
  git(worktree, "commit", "-qam", "edit keep")
  // Uncommitted: a deletion, and a new file nobody has added.
  rmSync(join(worktree, "src", "gone.ts"))
  writeFileSync(join(worktree, "src", "new.ts"), "x\ny\n")
  // Ignored output is not a change.
  mkdirSync(join(worktree, "build"))
  writeFileSync(join(worktree, "build", "out.js"), "built\n")
  // Main moving on afterwards is not this checkout's work.
  writeFileSync(join(repo, "src", "main-only.ts"), "m\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "main moves")

  const changes = await worktreeChanges(worktree)
  assert.equal(changes.base, "main")
  assert.equal(changes.error, undefined)
  assert.deepEqual(byPath(changes.files), {
    [join(worktree, "src", "keep.ts")]: { path: join(worktree, "src", "keep.ts"), status: "modified", added: 2, removed: 1 },
    [join(worktree, "src", "gone.ts")]: { path: join(worktree, "src", "gone.ts"), status: "deleted", added: 0, removed: 2 },
    [join(worktree, "src", "new.ts")]: { path: join(worktree, "src", "new.ts"), status: "added", added: 2 },
  })

  // Merging main in moves the fork point with it, so main's own work never floods the list.
  git(worktree, "merge", "-q", "--no-edit", "main")
  const merged = await worktreeChanges(worktree, "main")
  assert.ok(!merged.files.some((f) => f.path.endsWith("main-only.ts")), "main's file is not this checkout's change")
})

test("the default base is the local branch origin/HEAD names, so unpushed local commits are not the thread's", async () => {
  const { root, repo } = repository()
  const origin = join(root, "origin.git")
  git(root, "clone", "-q", "--bare", repo, origin)
  const clone = join(root, "clone")
  git(root, "clone", "-q", origin, clone)
  git(clone, "config", "user.email", "t@example.com")
  git(clone, "config", "user.name", "t")
  git(clone, "config", "commit.gpgsign", "false")
  // Landed on the local main and never pushed, as this repository works.
  writeFileSync(join(clone, "src", "landed.ts"), "landed\n")
  git(clone, "add", ".")
  git(clone, "commit", "-qm", "landed locally")
  const worktree = join(root, "clone-effort")
  git(clone, "worktree", "add", "-q", "-b", "effort", worktree)
  writeFileSync(join(worktree, "src", "mine.ts"), "mine\n")

  const changes = await worktreeChanges(worktree)
  assert.equal(changes.base, "main")
  assert.deepEqual(changes.files.map((f) => f.path), [join(worktree, "src", "mine.ts")])
})

test("an explicit base is diffed against; one that shares no history says so", async () => {
  const { root, repo } = repository()
  const worktree = join(root, "effort")
  git(repo, "worktree", "add", "-q", "-b", "effort", worktree)
  writeFileSync(join(worktree, "src", "a.ts"), "a\n")
  git(worktree, "add", ".")
  git(worktree, "commit", "-qm", "a")
  const first = git(worktree, "rev-parse", "HEAD").trim()
  writeFileSync(join(worktree, "src", "b.ts"), "b\n")
  git(worktree, "add", ".")
  git(worktree, "commit", "-qm", "b")

  const sinceA = await worktreeChanges(worktree, first)
  assert.deepEqual(sinceA.files.map((f) => f.path), [join(worktree, "src", "b.ts")])

  git(repo, "checkout", "-q", "--orphan", "unrelated")
  git(repo, "rm", "-rqf", ".")
  writeFileSync(join(repo, "other.txt"), "o\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "unrelated root")
  const unrelated = await worktreeChanges(worktree, "unrelated")
  assert.match(unrelated.error ?? "", /shares no history/)
  assert.deepEqual(unrelated.files, [])
})

test("a checkout's own config cannot make reading its changes run a program", async () => {
  const { root, repo } = repository()
  const marker = join(root, "fsmonitor-ran")
  const hook = join(root, "hook.sh")
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`)
  chmodSync(hook, 0o755)
  // Negative control: plain git in this checkout DOES run it, so the assertion below can fail.
  git(repo, "config", "core.fsmonitor", hook)
  writeFileSync(join(repo, "src", "keep.ts"), "changed\n")
  execFileSync("git", ["status", "--porcelain"], { cwd: repo, stdio: "ignore" })
  assert.ok(existsSync(marker), "the control: git itself runs the fsmonitor hook")
  rmSync(marker)

  const changes = await worktreeChanges(repo, "HEAD")
  assert.deepEqual(changes.files.map((f) => f.path), [join(repo, "src", "keep.ts")])
  assert.ok(!existsSync(marker), "reading the changes ran the checkout's fsmonitor hook")
})

test("a checkout that is gone, or no longer one, says so instead of listing nothing", async () => {
  const { root, repo } = repository()
  const worktree = join(root, "effort")
  git(repo, "worktree", "add", "-q", "-b", "effort", worktree)
  rmSync(worktree, { recursive: true, force: true })
  assert.match((await worktreeChanges(worktree)).error ?? "", /no longer on disk/)
  mkdirSync(worktree)
  assert.match((await worktreeChanges(worktree)).error ?? "", /no longer a git checkout/)
})

test("git's -z listings parse, binary counts included", () => {
  assert.deepEqual([...parseNumstat("3\t1\tsrc/a.ts\0-\t-\timg.png\0")], [["src/a.ts", { added: 3, removed: 1 }], ["img.png", {}]])
  assert.deepEqual([...parseNameStatus("M\0src/a.ts\0A\0new.ts\0D\0old.ts\0T\0link\0")], [
    ["src/a.ts", "modified"], ["new.ts", "added"], ["old.ts", "deleted"], ["link", "modified"],
  ])
})

test("a file is under a registered root by where its folder really is", () => {
  const { root, repo } = repository()
  const alias = join(root, "alias")
  symlinkSync(repo, alias)
  assert.equal(underAnyRoot(join(alias, "src", "keep.ts"), [repo]), true)
  assert.equal(underAnyRoot(join(root, "repo-sibling", "x.ts"), [repo]), false, "a sibling sharing the prefix")
  assert.equal(underAnyRoot(join(repo, "src", "keep.ts"), []), false)
})
