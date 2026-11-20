import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, parse, resolve } from "node:path"
import { frizzPaths } from "./frizz-paths.ts"
import { acquireNamedLaunchLockSync, readGitProjectId, validateProjectId } from "./project-identity.ts"

// WHAT A PROJECT IS, WITHOUT ASKING GIT.
//
// Frizz used to define a project as a Git repository: the root came from `rev-parse --show-toplevel`
// and the id from `git config --local frizz.id`. That made Git a hard requirement to LAUNCH, which
// contradicts the product's own position — Frizz has no opinion about version control — and locked
// out anyone on jj (a non-colocated repo has no `.git` at all), hg, or nothing.
//
// So the id lives in the project instead, at `.frizz/.id`, beside the scratchpads Frizz already
// writes there. Two of the four properties `git config` was buying (project-identity.ts) come free
// that way: a directory that MOVES keeps its id because the id moved with it, and an alias resolves
// to the same id because it resolves to the same directory. The other two — atomic creation under a
// race, and sub-directory equivalence — are re-earned here, by the same named lock the Git path uses
// and by the walk-up below.
//
// THE ONE HAZARD, AND WHY IT IS NOT ONE. Unlike `git config --local`, a file in the working tree can
// be committed, and two clones of that repo on one machine would then share an id. `.frizz/.gitignore`
// containing `*` removes that outright: the directory ignores ITSELF and everything under it, so
// `git add -A` cannot stage any of it (verified in a repo with no top-level .gitignore at all —
// `git status --porcelain` is empty and `check-ignore` reports the id and the .gitignore as ignored).
// Writing it is not an opinion about the user's version control, it is the ordinary convention for a
// tool's own scratch directory: `.venv/.gitignore` and `.swc/.gitignore` are exactly this file.

const FRIZZ_DIR = ".frizz"
const ID_FILE = ".id"
const SELF_IGNORE = ".gitignore"

/** Any of these makes a directory the project root. A Frizz project wins over the VCS it sits in. */
const REPO_MARKERS = [".git", ".jj", ".hg", ".svn"]
const PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "deno.json",
  "deno.jsonc",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "Makefile",
]

/**
 * Where a project keeps its Frizz folder: `<root>/.frizz`, except for the home directory.
 *
 * THE HOME PROJECT'S FOLDER CANNOT BE `~/.frizz`. That path is Frizz's legacy state root, and its mere
 * EXISTENCE moves every Frizz process on the machine onto it (frizz-paths.ts rule 1), including launchers
 * and servers too old to know about a home project. On an install that keeps its state in the platform's
 * own place, the next boot would open an empty board. So the home project's folder lives inside Frizz's
 * data root instead, under a leaf still named `.frizz`, which keeps every check that the folder is a real
 * `.frizz` directory (dispatch.ts ensureSafeDirectDirectory, frizz.ts directFrizzRoot) true for it.
 *
 * Everything Frizz writes for a project goes through here: the id, each thread's scratch directory, the
 * session sentinels. The worker hooks keep a copy of this rule (cc-worker/lib/project-frizz-dir.mjs).
 */
export function projectFrizzDir(root: string, home?: string): string {
  return isHomeDirectory(root, home ?? homedir()) ? homeProjectFrizzDir(home) : join(root, FRIZZ_DIR)
}

/** The home project's Frizz folder, whether or not it exists. */
export function homeProjectFrizzDir(home = homedir()): string {
  return join(frizzPaths({ home }).data, "home", FRIZZ_DIR)
}

export function projectIdPath(root: string, home?: string): string {
  return join(projectFrizzDir(root, home), ID_FILE)
}

/** The id recorded in this exact directory, or undefined. A malformed file is refused, never guessed at. */
/**
 * The id in `.frizz/.id`, and ONLY there.
 *
 * This is a FILE reader, not the answer to "what id does this project have" — use existingProjectId
 * for that. The distinction is not pedantic: a repository that predates the gitless change carries
 * its id in `git config frizz.id` and has no file at all, so asking this one and treating `undefined`
 * as "no project" makes an established board look like a brand-new directory. That mistake shipped
 * three times in one change (registry backfill, launch intent, and the grid's add path) and made two
 * of the maintainer's four live projects invisible.
 */
export function readProjectIdFile(root: string, home?: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(projectIdPath(root, home), "utf8")
  } catch {
    return undefined
  }
  try {
    return validateProjectId(raw.trim())
  } catch {
    throw new Error(`${projectIdPath(root, home)} is invalid; expected exactly one UUID`)
  }
}

/**
 * Record `id` for `root`, atomically, and make the directory ignore itself on the way.
 *
 * open(wx) → fsync → rename is the same shape project-launch.ts uses: a reader either sees the old
 * file or the complete new one, never a half-written id.
 */
export function writeProjectIdFile(root: string, id: string, home?: string): string {
  const dir = projectFrizzDir(root, home)
  mkdirSync(dir, { recursive: true })
  // Written before the id, so the id is never briefly visible to `git add -A`.
  const ignore = join(dir, SELF_IGNORE)
  if (!existsSync(ignore)) {
    try { writeFileSync(ignore, "*\n", { flag: "wx" }) } catch { /* raced; a `*` is a `*` */ }
  }

  const path = join(dir, ID_FILE)
  const temp = join(dir, `.${ID_FILE}.${process.pid}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, "wx", 0o600)
    writeFileSync(fd, `${id}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch {} }
    try { rmSync(temp, { force: true }) } catch {}
    throw error
  }
  return id
}

/** Keyed on the canonical root rather than a common git dir, which a plain directory does not have. */
export function projectRootLockName(root: string): string {
  return `identity-path-${createHash("sha256").update(root).digest("hex")}.lock`
}

/**
 * The project's durable id, minting one only if the project has never had it.
 *
 * `seed` is the id an existing store already committed to — today that is `git config frizz.id`, so a
 * repository that predates this file ADOPTS its own id rather than being handed a new one and losing
 * its board. Nothing is ever removed from the old store: it stays readable, and stays the answer if
 * this file is deleted.
 *
 * The lock is what makes two `frizz` processes starting at once commit exactly ONE id — the property
 * `git config`'s own lock used to provide, and the one a bare "write if missing" would lose.
 */
export function ensureProjectIdFile(root: string, home = homedir(), seed?: string): string {
  const existing = readProjectIdFile(root, home)
  if (existing) return existing
  const release = acquireNamedLaunchLockSync(home, projectRootLockName(root))
  try {
    const raced = readProjectIdFile(root, home)
    if (raced) return raced
    return writeProjectIdFile(root, seed ? validateProjectId(seed) : randomUUID(), home)
  } finally {
    release()
  }
}

/**
 * Does this error mean "there is simply no Git worktree here", as opposed to "a real repository is
 * broken"?
 *
 * The distinction is the whole safety property. A malformed config or unsafe ownership means a
 * repository we could not READ, and inventing a fresh namespace for it would strand every thread on
 * its board — so those still fail closed. Not-a-repository, a bare repository, and `git` not being
 * installed at all genuinely mean there is nothing to read, and now fall through to marker walk-up.
 */
export function isNotAGitWorktree(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === "ENOENT" || code === "EACCES") return true // no `git` on this machine
  if (!error || typeof error !== "object" || !("stderr" in error)) return false
  const stderr = String((error as { stderr?: unknown }).stderr)
  return /not a git repository/iu.test(stderr) || /must be run in a work ?tree/iu.test(stderr)
}

function hasAny(dir: string, names: readonly string[]): boolean {
  return names.some((name) => existsSync(join(dir, name)))
}

/**
 * The project root for `cwd`, without running `git`.
 *
 * Walks UP, because sub-directory equivalence is the property a naive "just use cwd" loses and the
 * one users notice: `frizz` in `~/proj` and in `~/proj/src` must open the same board, not two boards
 * with two thread histories and nothing explaining why.
 *
 * Stops at `$HOME` and never returns it. A stray `~/package.json` would otherwise make a user's whole
 * home directory one project, with agents dispatched at it.
 */
/**
 * THE HOME DIRECTORY IS NEVER ADOPTED BY ACCIDENT, and is a project only when someone chooses it.
 *
 * Until 2026-11-20 it was never a project at all. Its Frizz folder would have been `~/.frizz`, which is
 * Frizz's own legacy state root — the registry, every project's state dir, the launch locks — and on
 * 2026-08-06 a home "project" wrote `~/.frizz/.id` INTO that root, after which the walk-up below found it
 * from every unmarked directory under $HOME. The home project now keeps its folder elsewhere
 * (projectFrizzDir), and the walk-up stops before it reaches $HOME, so the maintainer's ask could be met
 * (2026-11-20: "a home project with the ability to start a Frizz thread just inside of my home
 * directory"). What still holds: a launch never adopts $HOME (launch-routing.ts classifyLaunch), however
 * many markers it carries, and only the dashboard's explicit add makes it one (router.ts addProjectAtPath).
 *
 * discoverProjectRoot still ANSWERS with the directory it was given — "where would the root be" has
 * an answer even in $HOME. Whether to adopt it is the caller's call, and this is the predicate.
 */
export function isHomeDirectory(dir: string, home = homedir()): boolean {
  // REALPATH BOTH SIDES. `resolve` alone compares the paths as written, and on macOS the launch
  // directory arrives already resolved (`/private/var/...`) while `homedir()` does not (`/var/...`),
  // so a symlinked home slips straight past the guard and gets adopted — which is the bug this
  // predicate exists to stop. A home that cannot be realpath'd falls back to the literal compare.
  const canonical = (value: string): string => {
    try {
      return realpathSync(resolve(value))
    } catch {
      return resolve(value)
    }
  }
  try {
    return canonical(dir) === canonical(home)
  } catch {
    return false
  }
}

/**
 * The id this directory ALREADY claims, from either store — or undefined if it claims none.
 *
 * Both stores count, and checking only the file is a bug that has now bitten twice. `.frizz/.id` is
 * where an id lives once a current Frizz has opened the project; `git config frizz.id` is where it
 * lived before, and a repository that has not been reopened since the gitless change still carries
 * only that. On this machine boron and pullfrog/app were both in that state — established boards with
 * 15 and 85 threads — so a file-only check made them invisible to the registry backfill AND made the
 * launcher offer to "add" them as if they were new (2026-08-06).
 *
 * Pure: it never mints. resolveGitProjectIdentity would, which is exactly wrong for a question.
 */
export function existingProjectId(dir: string, home?: string): string | undefined {
  const fromFile = readProjectIdFile(dir, home)
  if (fromFile) return fromFile
  try {
    return readGitProjectId(dir)
  } catch {
    return undefined // no git, or not a repository — the file was the only place it could have been
  }
}

/** Whether this directory has already been adopted, under either identity store. */
export function isExistingProjectRoot(dir: string, home?: string): boolean {
  return existingProjectId(dir, home) !== undefined
}

/**
 * Whether this directory is a project in its own right — a VCS checkout, or a language manifest.
 *
 * The markers discoverProjectRoot walks UP for, asked about ONE directory. That is what separates the
 * two cases the launcher has to tell apart: `frizz` in a repository is someone opening that
 * repository, and Frizz adopts it on the spot; `frizz` in `~/Downloads` is a command typed in the
 * wrong terminal, and gets offered rather than adopted. Never a substitute for isHomeDirectory —
 * $HOME frequently carries a marker and is still never a project.
 */
export function hasProjectMarker(dir: string): boolean {
  return hasAny(dir, REPO_MARKERS) || hasAny(dir, PROJECT_MARKERS)
}

export function discoverProjectRoot(cwd = process.cwd(), home = homedir()): string {
  let dir: string
  try {
    dir = resolve(cwd)
  } catch {
    return resolve(cwd)
  }
  const stop = resolve(home)
  const filesystemRoot = parse(dir).root

  for (let at = dir; ; at = dirname(at)) {
    // Never climb INTO or past the home directory. Note this does not stop `dir` itself from BEING
    // $HOME — the loop simply breaks and the launch directory is returned unchanged. Whether that is
    // adoptable is isHomeDirectory's question, asked by the launcher, not answered here.
    if (at === stop || at === filesystemRoot) break
    // An existing Frizz project wins over the VCS or manifest it happens to sit in.
    if (existsSync(projectIdPath(at, home))) return at
    if (hasAny(at, REPO_MARKERS)) return at
    if (hasAny(at, PROJECT_MARKERS)) return at
    if (dirname(at) === at) break
  }
  return dir
}

/**
 * The root an EXPLICIT choice adopts — the native picker and the grid's typed path, never a cwd.
 *
 * The walk-up above exists so a folder inside a checkout resolves to the checkout instead of
 * fragmenting it, and that reasoning is about directories that are projects IN THEIR OWN RIGHT — a
 * VCS root, a manifest root. An ancestor whose only claim is `.frizz/.id` — an adopted plain
 * directory, e.g. ~/Documents opened as a project once — is no checkout, and letting it capture a
 * pick turned "add ~/Documents/projects/kirby", a brand-new empty folder, into "reopen documents":
 * the picker navigated to another project's board, and no flow could create the new project at all
 * (2026-09-02). Someone who has pointed at a folder means THAT folder.
 *
 * A launch cwd still resolves through discoverProjectRoot unchanged — sub-directory equivalence for
 * adopted plain directories is deliberate there, where the directory is incidental to the command.
 */
export function chosenProjectRoot(chosen: string, home = homedir()): string {
  const dir = resolve(chosen)
  const discovered = discoverProjectRoot(dir, home)
  return discovered === dir || hasProjectMarker(discovered) ? discovered : dir
}
