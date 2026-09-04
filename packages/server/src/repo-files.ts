import { execFileSync } from "node:child_process"
import path from "node:path"

// WHICH OF A THREAD'S WRITTEN FILES BELONG ON THE RAIL: the ones git would carry, and nothing else.
//
// The rail lists what a worker wrote (edited-files.ts). Restricting it to files git is not ignoring is
// the maintainer's product call (2026-09-04): "it's fine to only track changes that are tracked in git
// here". The rail becomes an account of work on the REPOSITORY, and a thread's scratch — `.frizz/`
// notes, plans, research docs — drops out of it along with build output and `node_modules`.
//
// It is deliberately a FILTER and never a SOURCE. Attribution stays with the transcript, which is the
// only place a file can be tied to the session that wrote it: git records what changed and when, never
// WHICH session, and every attempt to infer it put other agents' work on the rail (measured over this
// machine's own history — a thread that wrote 10 files drew 282 from a commit-window sweep, and even
// commits within ±2min of that thread's own `git commit` calls were other agents' CI and wiki work).
// So git answers exactly one question here: is this path one the repository would carry?
//
// NOT-IGNORED, rather than IN-THE-INDEX. `git ls-files` would hide a file until someone ran `git add`,
// so a source file a worker had just created would be missing from the rail for the whole effort and
// appear only after the commit — the moment it is most worth seeing is the moment it would be absent.
// The test is therefore `git check-ignore`, which keeps new work visible and still drops everything
// ignored: build output, `node_modules`, and the thread scratch this rule is aimed at.

// Enough for a whole effort's writes; a thread naming more than this is pathological and the tail is not
// worth a second git process.
const MAX_PROBE = 512
// The rail is recomputed on every transcript read, and reads are polled. One `check-ignore` is ~20-50ms,
// which is not free at poll rates, and a `.gitignore` changes far more slowly than a board polls.
const CACHE_TTL_MS = 15_000

type CacheEntry = { at: number; ignored: Set<string> }
const cache = new Map<string, CacheEntry>()

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 8 << 20,
  })
}

/**
 * The subset of `paths` the repository would carry — absolute paths in, absolute paths out.
 *
 * A path OUTSIDE the project is passed through untouched: git has no opinion on another checkout's
 * file, and dropping it would silently hide an edit the worker really made. A project that is not a git
 * repository filters nothing, for the same reason — there is no ignore list to consult, so every write
 * is repo work by default rather than invisible by default.
 */
export function repoCarriedFiles(projectDir: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return []
  const inside: string[] = []
  for (const p of paths) {
    const rel = path.relative(projectDir, p)
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) inside.push(p)
  }
  if (inside.length === 0) return [...paths]

  const key = `${projectDir}\0${inside.join("\0")}`
  const now = Date.now()
  const hit = cache.get(key)
  let ignored: Set<string>
  if (hit && now - hit.at < CACHE_TTL_MS) {
    ignored = hit.ignored
  } else {
    ignored = probeIgnored(projectDir, inside.slice(0, MAX_PROBE))
    cache.set(key, { at: now, ignored })
    // The key carries the whole path list, so a long-lived server would otherwise accumulate one entry
    // per distinct thread-and-write-set. Cheap bound: drop the oldest once it grows past a few boards.
    if (cache.size > 256) for (const k of [...cache.keys()].slice(0, 64)) cache.delete(k)
  }
  return paths.filter((p) => !ignored.has(p))
}

/** `repoCarriedFiles` over the rail's own rows, preserving their order and their diffstats. */
export function repoCarriedEditedFiles<T extends { path: string }>(projectDir: string, files: readonly T[]): T[] {
  if (files.length === 0) return []
  const kept = new Set(repoCarriedFiles(projectDir, files.map((f) => f.path)))
  return files.filter((f) => kept.has(f.path))
}

function probeIgnored(projectDir: string, inside: readonly string[]): Set<string> {
  try {
    // `--is-inside-work-tree` is the cheap "is there an ignore list at all" probe; it throws for a
    // non-repository, which is the case that filters nothing.
    git(["rev-parse", "--is-inside-work-tree"], projectDir)
  } catch {
    return new Set()
  }
  // `check-ignore -z --stdin` prints the paths it IS ignoring, NUL-separated. INDEX-AWARE, i.e. WITHOUT
  // `--no-index`: a file force-added under an ignored directory (`git add -f secret/kept.txt`) is one
  // the repository genuinely carries, and the default mode says so while `--no-index` calls it ignored
  // and would drop it from the rail. Verified against `git ls-files` as ground truth, 2026-09-04.
  try {
    const out = execFileSync("git", ["check-ignore", "-z", "--stdin"], {
      cwd: projectDir,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      input: inside.join("\0"),
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 8 << 20,
    })
    return new Set(out.split("\0").filter(Boolean))
  } catch (error) {
    // Exit 1 means "nothing here is ignored" and arrives as a thrown error with an empty stdout — a
    // verdict, not a failure. Anything else (git missing, a broken repo) filters nothing.
    const status = (error as { status?: number }).status
    const stdout = (error as { stdout?: string }).stdout
    if (status === 1) return new Set((stdout ?? "").split("\0").filter(Boolean))
    return new Set()
  }
}
