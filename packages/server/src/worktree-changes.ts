import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import type { WorktreeChangedFile, WorktreeChanges } from "@frizz/shared"
import { execFileOffThread } from "./off-thread-exec.ts"
import type { Storage } from "./storage.ts"

// A CHECKOUT A THREAD REGISTERED AS ITS OWN, AND WHAT GIT SAYS CHANGED IN IT (maintainer 2026-11-14: "a
// tool for registering a worktree root so the sidebar can show changes scoped to the current worktree").
//
// The rail's "Edited files" is read off the transcript, and deliberately never off git (repo-files.ts): in
// the shared checkout every agent on the machine commits, and a git sweep there put 282 files on the rail of
// a thread that wrote 10. A checkout ONE thread registered as its own has no such problem. Its diff against
// where its branch left the base IS that thread's work, and it holds what the transcript cannot see: a
// codegen step, a formatter, a `git mv`, a sub-agent's edits, a script the shell parser does not read.
// So each registered checkout gets a "Changes" group of its own, read off git, and a file the transcript
// shows the worker writing under one of them leaves "Edited files" for it.
//
// FRIZZ CREATES NO CHECKOUT ("I dont want us to be creating any worktrees. different users have different
// approaches. that's up to the user"). A registration names one that exists: a linked worktree, a separate
// clone, wherever the user's habits put it. What is checked is only that it is the top folder of a git
// checkout, so a worker cannot register `/` or its home as one.
//
// GIT RUNS IN A FOLDER A WORKER NAMED, so every call here takes the options that keep a checkout's own
// config from running anything: no fsmonitor hook, no external diff, no textconv filter. And it never
// writes: `GIT_OPTIONAL_LOCKS=0` stops `git diff` refreshing the index, which would take `index.lock` out
// from under the worker's own git commands in that checkout.

/** More than an effort writes. Past it the group says it is truncated rather than growing without bound. */
const MAX_FILES = 500
/** An untracked file is counted line by line only up to this size; a bigger one is listed with no count. */
const COUNT_LIMIT = 1 << 20
/** What `git diff` compares against when HEAD has no commit yet: the empty tree. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

const SAFE_CONFIG = ["-c", "core.fsmonitor=false"]

function git(args: string[], cwd: string) {
  return execFileOffThread("git", [...SAFE_CONFIG, ...args], {
    cwd,
    env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 16 << 20,
  })
}

async function gitOut(args: string[], cwd: string): Promise<string | undefined> {
  try {
    return (await git(args, cwd)).stdout
  } catch {
    return undefined
  }
}

/**
 * The canonical top folder of the git checkout at `raw`, or a thrown Error whose message says what is wrong
 * with it, in words a worker can act on. `raw` must be absolute: the worker's command line resolves a
 * relative one against its own working directory, which the server cannot know.
 */
export function registeredCheckoutRoot(raw: string): string {
  if (!path.isAbsolute(raw)) throw new Error(`\`${raw}\` is not an absolute path`)
  let real: string
  try {
    real = realpathSync(raw)
  } catch {
    throw new Error(`\`${raw}\` does not exist`)
  }
  if (!statSync(real).isDirectory()) throw new Error(`\`${raw}\` is a file, not a checkout's folder`)
  if (!hasOwnGitEntry(real)) {
    const top = enclosingCheckout(real)
    throw new Error(top
      ? `\`${raw}\` is inside the checkout at \`${top}\`, not the top of one. Register the checkout's own folder.`
      : `\`${raw}\` is not a git checkout: no \`.git\` in it or above it`)
  }
  return real
}

/** A `.git` folder or link file of the checkout's own — never a symlink, which could lend it another's. */
function hasOwnGitEntry(dir: string): boolean {
  try {
    const entry = lstatSync(path.join(dir, ".git"))
    return entry.isDirectory() || entry.isFile()
  } catch {
    return false
  }
}

function enclosingCheckout(dir: string): string | undefined {
  for (let at = path.dirname(dir); ; at = path.dirname(at)) {
    if (hasOwnGitEntry(at)) return at
    if (path.dirname(at) === at) return undefined
  }
}

/** Every checkout a thread of this project registered, for the file readers' roots (project.ts). */
export function registeredWorktreeRoots(storage: Pick<Storage, "registeredCheckoutPaths">): string[] {
  return storage.registeredCheckoutPaths()
}

/** Does `base` name a commit in the checkout at `root`? Asked once, at registration, so a typo is refused there. */
export async function resolvesToCommit(root: string, base: string): Promise<boolean> {
  return (await gitOut(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], root)) !== undefined
}

/**
 * The branch a checkout's work is measured from when the worker named none: the repository's default
 * branch. `origin/HEAD` names it where there is a remote, and the LOCAL branch of that name is preferred
 * over the remote one, because a repository that lands work on its local `main` before pushing (this one)
 * would otherwise see every unpushed commit as the thread's. Then `main`, then `master`.
 */
async function defaultBase(root: string): Promise<string | undefined> {
  const remoteHead = (await gitOut(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root))?.trim()
  const candidates: string[] = []
  if (remoteHead) {
    const branch = remoteHead.slice(remoteHead.indexOf("/") + 1)
    candidates.push(`refs/heads/${branch}`, `refs/remotes/${remoteHead}`)
  }
  candidates.push("refs/heads/main", "refs/heads/master")
  for (const ref of candidates) {
    if (await resolvesToCommit(root, ref)) return ref.replace(/^refs\/(?:heads|remotes)\//, "")
  }
  return undefined
}

// Reads of one checkout that overlap share one diff — two surfaces opening the thread at once — and none
// outlives its answer: the rail re-reads right after a worker writes, and a kept answer would be the old one.
const inFlight = new Map<string, Promise<WorktreeChanges>>()

/** The registered checkout's "Changes": its working tree against where it left `base` (default: see defaultBase). */
export function worktreeChanges(root: string, base?: string): Promise<WorktreeChanges> {
  const key = `${root}\0${base ?? ""}`
  const pending = inFlight.get(key)
  if (pending) return pending
  const changes = readChanges(root, base).finally(() => inFlight.delete(key))
  inFlight.set(key, changes)
  return changes
}

async function readChanges(root: string, explicitBase?: string): Promise<WorktreeChanges> {
  if (!existsSync(root)) return { root, files: [], error: "This checkout is no longer on disk" }
  if (!hasOwnGitEntry(root)) return { root, files: [], error: "This folder is no longer a git checkout" }
  const base = explicitBase ?? await defaultBase(root)
  const head = (await gitOut(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], root))?.trim()
  let from = head ?? EMPTY_TREE
  if (base && head) {
    const forkPoint = (await gitOut(["merge-base", "HEAD", base], root))?.trim()
    if (forkPoint) from = forkPoint
    else if (explicitBase) return { root, base, files: [], error: `\`${base}\` shares no history with this checkout's HEAD` }
  }
  const [numstat, nameStatus, untracked] = await Promise.all([
    gitOut(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", from, "--"], root),
    gitOut(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", from, "--"], root),
    gitOut(["ls-files", "--others", "--exclude-standard", "-z"], root),
  ])
  if (numstat === undefined || nameStatus === undefined) return { root, ...(base ? { base } : {}), files: [], error: "git could not read this checkout" }

  const files = new Map<string, WorktreeChangedFile>()
  const status = parseNameStatus(nameStatus)
  for (const [rel, counts] of parseNumstat(numstat)) {
    const abs = path.join(root, rel)
    files.set(abs, { path: abs, status: status.get(rel) ?? "modified", ...counts })
  }
  for (const rel of (untracked ?? "").split("\0").filter(Boolean)) {
    const abs = path.join(root, rel)
    if (files.has(abs)) continue
    const lines = countLines(abs)
    files.set(abs, { path: abs, status: "added", ...(lines === undefined ? {} : { added: lines }) })
  }
  const all = [...files.values()]
  return {
    root,
    ...(base ? { base } : {}),
    files: all.slice(0, MAX_FILES),
    ...(all.length > MAX_FILES ? { truncated: true } : {}),
  }
}

/** `--numstat -z`: `added\tremoved\tpath\0` per file; a binary file's counts are `-`, which become none. */
export function parseNumstat(out: string): Map<string, { added?: number; removed?: number }> {
  const byPath = new Map<string, { added?: number; removed?: number }>()
  for (const record of out.split("\0")) {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record)
    if (!match) continue
    const [, added, removed, rel] = match
    byPath.set(rel, added === "-" ? {} : { added: Number(added), removed: Number(removed) })
  }
  return byPath
}

/** `--name-status -z`: a status letter, then its path, each NUL-terminated. Renames are off, so no third field. */
export function parseNameStatus(out: string): Map<string, WorktreeChangedFile["status"]> {
  const byPath = new Map<string, WorktreeChangedFile["status"]>()
  const fields = out.split("\0")
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const letter = fields[i]
    const rel = fields[i + 1]
    if (!letter || !rel) continue
    byPath.set(rel, letter === "A" ? "added" : letter === "D" ? "deleted" : "modified")
  }
  return byPath
}

/** An untracked text file's line count, as git would count its additions; undefined for a binary or a big one. */
function countLines(file: string): number | undefined {
  let fd: number | undefined
  try {
    const size = statSync(file).size
    if (size > COUNT_LIMIT) return undefined
    if (size === 0) return 0
    fd = openSync(file, "r")
    const buffer = Buffer.alloc(size)
    readSync(fd, buffer, 0, size, 0)
    if (buffer.subarray(0, 8192).includes(0)) return undefined
    let lines = 0
    for (const byte of buffer) if (byte === 0x0a) lines++
    return buffer[size - 1] === 0x0a ? lines : lines + 1
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Is `file` inside one of `roots` (canonical)? Judged on where the file's folder really is. */
export function underAnyRoot(file: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return false
  let real: string
  try {
    real = path.join(realpathSync(path.dirname(file)), path.basename(file))
  } catch {
    real = path.resolve(file)
  }
  return roots.some((root) => real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
}

