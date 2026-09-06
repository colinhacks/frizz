import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import {
  resolveGitProjectIdentity,
  type GitProjectIdentityScope,
} from "./project-identity.ts"
import type { ProjectLaunchTarget } from "./project-launch.ts"
import { discoverProjectRoot, ensureProjectIdFile, writeProjectIdFile } from "./project-root.ts"
import { registerProject } from "./project-registry.ts"
import { projectStateDir } from "./frizz-paths.ts"
import { originRemoteUrl, parseRepoLabel, resolveProjectLabel } from "./project-identity.ts"
import { githubRemoteNameWithOwner } from "./github.ts"

// Workspace resolution + on-disk locations. Everything here is derived once at boot and
// threaded through the AppContext — no module reads cwd on its own.

/**
 * A project's display name and its github.com link target, from ONE `git remote get-url origin`.
 *
 * Two answers because they are two different questions, and conflating them would ship a wrong URL.
 * `label` is DISPLAY, so it is host-agnostic: a GitLab or Gitea origin gets its "owner/repo" shown
 * just the same, and falls back to the directory name when there is no remote at all. `githubRepo` is
 * a LINK TARGET — what the rendered-markdown autolinker turns `#123` and a bare commit hash into — so
 * it goes through the host-strict parser whose spoof cases (`github.com.evil.com`) are unit-tested in
 * github.test.ts. Rendering a GitLab project's `#12` as a github.com URL is a WRONG destination, which
 * is worse than no link at all; absent here simply means the augmentation stays off.
 *
 * No `gh`, no network: this is the local git remote, so autolinking works signed out and with gh
 * absent entirely (the picker's `githubStatus` gate is a different, gh-authoritative question).
 */
export function projectRepoIdentity(dir: string, name: string): { label: string; githubRepo?: string } {
  const url = originRemoteUrl(dir)
  if (!url) return { label: name }
  const githubRepo = githubRemoteNameWithOwner(url)
  return { label: parseRepoLabel(url) ?? name, ...(githubRepo ? { githubRepo } : {}) }
}

export interface Project {
  dir: string // repo root (git toplevel of the server's cwd)
  id: string // stable checkout UUID; common config for main, private Git metadata for linked worktrees
  name: string // basename of dir, for display
  label: string // "owner/repo" from the git origin remote, else name (repos with no remote)
  githubRepo?: string // "owner/repo" ONLY when that origin remote is github.com — see projectRepoIdentity
  stateDir: string // ~/.frizz/projects/<id>/ — SQLite + server.lock live here
  cwdSlug: string // ~/.claude/projects/<slug>/ session-log dir name
  // Present for linked worktrees; ordinary/main worktrees use the repository-scoped identity.
  identityScope?: Extract<GitProjectIdentityScope, "worktree">
}

// The trusted read roots for serving/opening local files (the /local-image route + the openLocalFile
// mutation). A file is served only when its symlink-resolved real path sits under one of these AND has a
// whitelisted image extension; the HTTP layer already rejects non-local/mismatched origins, so this is the
// defense-in-depth gate that keeps those endpoints from becoming arbitrary file read. Both temp trees are
// trusted, not just the per-user one (os.tmpdir() → /var/folders on macOS): agents write screenshots into
// the shared temp tree too — Claude Code's own per-session scratchpad lives at /tmp/claude-<uid>/…, and
// frizz's disposable-stack scratch under /tmp/frizz-* — so `/tmp` (realpath-normalized by the caller's
// isUnder check, e.g. → /private/tmp on macOS) covers every worker + subagent scratchpad without coupling
// to Claude Code's internal path convention. Intentionally permissive within the temp/screenshot space.
export function trustedLocalFileRoots(project: Pick<Project, "dir" | "stateDir">): string[] {
  return [project.dir, tmpdir(), "/tmp", resolve(homedir(), "Screenshots"), join(project.stateDir, "attachments")]
}

// The roots for the file-OPEN action (openLocalFile + the resolveLocalPaths classifier behind clickable
// inline-code paths). Broader than trustedLocalFileRoots: home-and-below is added so a referenced file
// like ~/.claude/CLAUDE.md opens, while system trees (/etc, /usr, …) stay out. Opening spawns the desktop
// opener (no bytes enter the page) and is still realpath-confined by the caller's isUnder check — never
// the whole filesystem. homedir() subsumes ~/Screenshots and an in-home project/attachments dir; the temp
// trees and an out-of-home checkout are kept explicit via the trusted set.
export function openableFileRoots(project: Pick<Project, "dir" | "stateDir">): string[] {
  return [homedir(), ...trustedLocalFileRoots(project)]
}

function isNotGitRepositoryError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("stderr" in error)) return false
  return /not a git repository/iu.test(String(error.stderr))
}

// The server's cwd's git root. Falls back to cwd for a non-git dir (degraded, but usable).
export function resolveProjectDir(cwd = process.cwd()): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    return realpathSync(root)
  } catch (error) {
    // A malformed config or unsafe ownership still fails closed — those mean a REAL repository we
    // could not read, and inventing a namespace for it would strand its board. "Not a repository" and
    // "git is not installed" are the two that legitimately mean there is no Git here, and both now
    // fall through to marker-based discovery (project-root.ts) instead of ending the launch.
    if (!isNotGitRepositoryError(error) && !isMissingGitBinary(error)) {
      throw new Error("unable to resolve Git repository root")
    }
    const root = discoverProjectRoot(cwd)
    try {
      return realpathSync(root)
    } catch {
      return resolve(root)
    }
  }
}

/** `git` itself is absent — spawning it failed rather than the command reporting anything. */
function isMissingGitBinary(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === "ENOENT" || code === "EACCES"
}

// THE ID LIVES IN THE PROJECT, at `.frizz/.id` (project-root.ts), for a repository and a plain
// directory alike. Git is still consulted when it is there, for two things a file cannot answer:
// which directory is the repository root, and whether this is a LINKED WORKTREE — worktree isolation
// is a Git concept, so reading it needs Git.
//
// A repository that predates the file keeps its exact id: `git config frizz.id` SEEDS the file, and
// stays readable forever. Nothing migrates away from it, so a board cannot be lost by this.
//
// A plain directory used to get `randomUUID()` per launch — a fresh, empty board every time you ran
// Frizz there. That is what made a non-repo unusable rather than merely unsupported.
function resolveProjectIdentity(
  dir: string,
  home = homedir(),
): { id: string; scope: GitProjectIdentityScope; root: string } {
  let insideWorktree = false
  try {
    const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    if (inside !== "true") throw new Error("Git directory is not a worktree")
    insideWorktree = true
  } catch (error) {
    if (!isNotGitRepositoryError(error) && !isMissingGitBinary(error)) {
      throw new Error("unable to inspect Git repository identity")
    }
  }
  // Deliberately OUTSIDE the probe's catch. This call fails closed with a precise message — a
  // duplicated or malformed `frizz.id` must surface as itself, not be flattened into "unable to
  // inspect", and must never fall through to minting a fresh id beside a real board.
  const git = insideWorktree ? resolveGitProjectIdentity(dir, home) : undefined
  const root = git?.root ?? dir
  return { id: ensureProjectIdFile(root, home, git?.id), scope: git?.scope ?? "repository", root }
}

// Claude Code's per-project session-log dir name: the absolute cwd with every character that is not
// A–Z, a–z or 0–9 replaced by '-', and then capped at 200 characters (CWD_SLUG_MAX, below — that half
// of the rule is easy to miss and fails the same way). Verified empirically against ~/.claude/projects:
// /Users/x/.workshell → -Users-x--workshell, D:\Development\Feature3 → D--Development-Feature3, and
// D:\Development\frizz\slug_probe dir → D--Development-frizz-slug-probe-dir (claude 2.1.257).
//
// Until 2026-09-01 this replaced only '/' and '.', which is the same thing for a plain POSIX path and
// a different thing for everything else. A Windows path has neither, so it came back UNCHANGED and the
// tailer watched ~/.claude/projects/D:\Development\Feature3/<id>.jsonl — a path that never exists.
// Sixty seconds later every Windows thread was reported as "no transcript 60s after dispatch — likely
// a boot failure" and shown dead on the board, while claude was still mid-turn in a transcript frizz
// never opened. '_' and ' ' in a POSIX path went wrong the same way, just more rarely.
// Used later by the JSONL tailer; computed here so the rule lives once.
export function cwdSlug(absPath: string): string {
  const slug = absPath.replace(/[^A-Za-z0-9]/g, "-")
  if (slug.length <= CWD_SLUG_MAX) return slug
  return `${slug.slice(0, CWD_SLUG_MAX)}-${Math.abs(cwdSlugHash(absPath)).toString(36)}`
}

// The second half of the same rule, and the half a plain replace cannot reach: past 200 characters
// claude cuts the slug and names the bucket with a hash of the WHOLE path instead. Read out of the
// shipped CLI (2.1.263, `s.length <= 200 ? s : s.slice(0, 200) + "-" + Math.abs(hash(path)).toString(36)`)
// and then measured — a 215-character cwd produced exactly the directory the test pins. Without this a
// checkout nested deeply enough fails the same way Windows did: frizz watches the untruncated name,
// nothing ever appears there, and the crash-net calls a working thread dead.
const CWD_SLUG_MAX = 200

// Claude Code's own string hash — h*31 + charCode, kept in int32 — reproduced rather than replaced,
// because the suffix has to name the bucket claude actually writes to, not one frizz finds reasonable.
function cwdSlugHash(absPath: string): number {
  let hash = 0
  for (let i = 0; i < absPath.length; i++) hash = ((hash << 5) - hash + absPath.charCodeAt(i)) | 0
  return hash
}

// The repo-label helpers moved to project-identity.ts, which is an exported subpath: the LAUNCHER
// needs the remote owner to register a project, and importing project.ts for it would pull the
// whole server into a CLI that only wants to name a directory.
export { parseRepoLabel, resolveProjectLabel } from "./project-identity.ts"

/**
 * Record this project in the machine's registry, silently — running the CLI inside a directory IS the
 * authorization, so there is no prompt (plan §4b).
 *
 * The one case that needs a decision is a COPIED checkout: `cp -R` brings `.frizz/.id` along, so two
 * directories claim one id. The registry spots it (the id is registered at another path that still
 * exists) and refuses; the copy then gets a fresh id of its own rather than adopting the original's
 * threads. That is the duplicate self-heal the id-in-the-tree design cannot do unaided.
 */
function registerAndReconcile(dir: string, id: string, home: string): string {
  const remoteOwner = resolveProjectLabel(dir)?.split("/")[0]
  try {
    const first = registerProject({ dir, id, remoteOwner }, home)
    if (first.action !== "duplicate") return id
    const minted = writeProjectIdFile(dir, randomUUID())
    registerProject({ dir, id: minted, remoteOwner }, home)
    return minted
  } catch {
    // The registry is an INDEX. Failing to write it must never stop a project from opening — the
    // worst case is a missing card, and the next open re-registers.
    return id
  }
}

/**
 * The Project for a registry entry, without opening the directory.
 *
 * The registry records the id and the path; everything else about a Project is derived from those
 * two, exactly as resolveProject derives them. This is the path a SECOND project takes — the one you
 * navigated to rather than launched from — so it must not re-resolve identity: the id in the registry
 * is already the answer, and re-deriving would mean re-reading a checkout that may not even be there.
 */
export function projectFromRegistryEntry(
  entry: { id: string; path: string; name?: string },
  home = homedir(),
): Project {
  const name = entry.name ?? basename(entry.path) ?? entry.path
  const stateDir = projectStateDir(entry.id, home)
  // CREATE IT, exactly as resolveProject does for the launching project. A registry entry is not
  // proof that this project has ever been opened: `projectAdd` (the grid's "Add a project", and the
  // rail's) registers an id and writes the index without opening anything, and backfill can register
  // from a checkout too. SQLite will not create `ui.db` under a directory that does not exist, so
  // without this the tenant fails to activate with "unable to open database file" — and because
  // tenants.ts reports activation failures rather than throwing, the whole thing surfaced as a bare
  // 404 on that project's every route, i.e. a card you can click and a board that never loads.
  mkdirSync(stateDir, { recursive: true })
  return {
    dir: entry.path,
    id: entry.id,
    name,
    ...projectRepoIdentity(entry.path, name),
    stateDir,
    cwdSlug: cwdSlug(entry.path),
  }
}

export function resolveProject(
  cwd = process.cwd(),
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Project {
  const identity = resolveProjectIdentity(resolveProjectDir(cwd), home)
  const dir = identity.root
  const id = registerAndReconcile(dir, identity.id, home)
  const stateDir = projectStateDir(id, home)
  mkdirSync(stateDir, { recursive: true })
  const name = basename(dir) || dir
  const target = {
    projectId: id,
    projectDir: dir,
    stateDir,
    ...(identity.scope === "worktree" ? { identityScope: "worktree" as const } : {}),
  }
  return {
    dir,
    id,
    name,
    ...projectRepoIdentity(dir, name),
    stateDir,
    cwdSlug: cwdSlug(dir),
    ...(identity.scope === "worktree" ? { identityScope: "worktree" as const } : {}),
  }
}

// Where a worker's PermissionRequest hook (cc-worker/hooks/perm-policy.mjs) drops its durable
// permission-request marker — the policy decision plus the request it decided about — and where the
// tailer reads it (only a DEFERRED decision counts as a human block). Injected to the worker as env
// `FRIZZ_PERM_DIR` at spawn; the hook appends `<slug>.json`. Co-located under the per-project stateDir
// (server-owned, worktree-independent) so the exact dir the server scans is the exact dir the worker
// writes. The CONTRACT with the plugin hook is only (env var name, `<slug>.json` filename) — the hook
// cannot import this module.
export const PERM_DIR_ENV = "FRIZZ_PERM_DIR"
export function permRequestDir(project: Pick<Project, "stateDir">): string {
  return join(project.stateDir, "perm-requests")
}
export function permMarkerPath(project: Pick<Project, "stateDir">, slug: string): string {
  return join(permRequestDir(project), `${slug}.json`)
}

export function projectLaunchTarget(project: Project): ProjectLaunchTarget {
  return {
    projectId: project.id,
    projectDir: project.dir,
    stateDir: project.stateDir,
    ...(project.identityScope === "worktree" ? { identityScope: "worktree" as const } : {}),
  }
}

/** Rebuild non-secret display metadata from an already owner-verified pinned launch target. */
export function projectFromLaunchTarget(
  target: ProjectLaunchTarget,
  env: NodeJS.ProcessEnv = process.env,
): Project {
  let dir: string
  try {
    dir = realpathSync(target.projectDir)
  } catch {
    throw new Error("pinned Frizz project directory is no longer available")
  }
  if (dir !== target.projectDir) throw new Error("pinned Frizz project directory is not canonical")
  const name = basename(dir) || dir
  return {
    dir,
    id: target.projectId,
    name,
    ...projectRepoIdentity(dir, name),
    stateDir: target.stateDir,
    cwdSlug: cwdSlug(dir),
    ...(target.identityScope === "worktree" ? { identityScope: "worktree" as const } : {}),
  }
}
