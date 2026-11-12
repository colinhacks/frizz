import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { readRegistry } from "./project-registry.ts"

// A WORKER'S CHECKOUT CAN SIT OUTSIDE EVERY DIRECTORY THE FILE GATE TRUSTS. A linked git worktree is the
// usual way a worker isolates its effort, and nothing says where one lives: a machine whose internal disk
// is short keeps them on an external volume (`/Volumes/<drive>/worktrees/<project>/<slug>`), which is
// neither home, temp, nor the project directory. The rail listed every file such a worker edited, and
// each one answered a click with "Local file is outside Frizz's trusted roots".
//
// So a checkout of a REGISTERED project's repository is a root wherever it is. The answer is read off the
// path, not off `git worktree list`: listing every registered repository's worktrees costs ~250ms on a
// machine with fourteen projects and four hundred worktrees, and a cached listing would refuse a worktree
// made since it was taken. Walking up from the file reads two or three small files, with no process and
// no cache, so a worktree made a second ago is already a root.
//
// The files are git's own (gitrepository-layout(5)): a linked worktree's `.git` is a file naming its
// admin folder under the main repository's `.git/worktrees/`; that folder's `gitdir` names the `.git`
// file back, and its `commondir` names the repository. Git itself is never run here, because the
// directory being asked about is not yet trusted, and a repository's config can make git run a program.

/** The path a git link file names, resolved against the file's own folder and canonicalized. */
function followLink(file: string, prefix = ""): string {
  const text = readFileSync(file, "utf8").trim()
  if (!text.startsWith(prefix)) throw new Error(`${file} is not a git link`)
  return realpathSync(resolve(dirname(file), text.slice(prefix.length).trim()))
}

/** The repository behind the `.git` entry `dotGit`: the folder itself, or a linked worktree's verified common dir. */
function repositoryOf(dotGit: string): string | undefined {
  try {
    // A `.git` that is a link to a registered checkout's own would pass every test below as that checkout.
    const entry = lstatSync(dotGit)
    if (entry.isSymbolicLink()) return undefined
    if (entry.isDirectory()) return realpathSync(dotGit)
    const admin = followLink(dotGit, "gitdir:")
    // The back-link. A `.git` file planted anywhere can point at a real worktree's admin folder, but that
    // folder names only the one `.git` file it was made for. A submodule's admin folder has no `gitdir`.
    if (followLink(join(admin, "gitdir")) !== realpathSync(dotGit)) return undefined
    return followLink(join(admin, "commondir"))
  } catch {
    return undefined
  }
}

/** The repository holding `dir`, or undefined when no `.git` sits at or above it. */
function repositoryHolding(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    const repository = repositoryOf(join(at, ".git"))
    if (repository) return repository
    if (dirname(at) === at) return undefined
  }
}

/**
 * True when `real`, a canonical path, sits in a checkout of a registered project's git repository: its main
 * checkout or any of its linked worktrees, wherever on disk that worktree is.
 */
export function inRegisteredCheckout(real: string, home = homedir()): boolean {
  let registered: Set<string> | undefined
  for (let at = dirname(real); dirname(at) !== at; at = dirname(at)) {
    const repository = repositoryOf(join(at, ".git"))
    if (!repository) continue
    registered ??= new Set(readRegistry(home).projects.flatMap((project) => repositoryHolding(project.path) ?? []))
    if (registered.has(repository)) return true
  }
  return false
}
