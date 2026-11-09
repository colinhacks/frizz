import { realpathSync } from "node:fs"
import path from "node:path"
import { execFileOffThread, type OffThreadExecError } from "./off-thread-exec.ts"

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
//
// A LINKED WORKTREE INSIDE THE PROJECT ANSWERS FOR ITSELF. The worker contract sends every worktree to
// `<project>/.frizz/worktrees/<slug>/` (workerPrompt.ts § Git worktrees), and `.frizz/` ignores itself,
// so asked from the project root git calls every file in that checkout ignored — and the whole of a
// worker's isolated effort would leave the rail, which is the opposite of what the rule above is for.
// A file there is repository work on another branch of the SAME repository, so the question goes to
// the checkout that holds it. The roots come from `git worktree list` rather than from the path, so a
// project that keeps its worktrees somewhere of its own (`.worktrees/`, `.claude/worktrees/`) gets the
// same reading, and a plain directory that merely sits under `.frizz/worktrees/` gets none.

// Enough for a whole effort's writes; a thread naming more than this is pathological and the tail is not
// worth a second git process.
const MAX_PROBE = 512
// The rail is recomputed on every transcript read, and reads are polled. One `check-ignore` is ~20-50ms on a
// quiet machine and 225ms for a whole probe on this one under load (profiled 2026-11-06), and a `.gitignore`
// changes far more slowly than a board polls.
const CACHE_TTL_MS = 15_000

// Promises, so a burst of reads for one write-set shares one probe, and a failed one is settled like any other.
type CacheEntry = { at: number; ignored: Promise<Set<string>> }
const cache = new Map<string, CacheEntry>()
// One listing per project, not per write-set: the key above changes with every file a worker writes, and
// where the project's checkouts are does not.
type CheckoutEntry = { at: number; checkouts: Promise<string[] | undefined> }
const checkoutCache = new Map<string, CheckoutEntry>()

// OFF THIS THREAD (off-thread-exec.ts). These ran as `execFileSync` on every drawer open, which held the one
// thread that serves all of Frizz for 6s out of every 5 minutes on the live server, up to 489ms at a time.
const git = (args: string[], cwd: string, input?: string) => execFileOffThread("git", args, {
  cwd,
  env: { ...process.env, LC_ALL: "C" },
  maxBuffer: 8 << 20,
  ...(input === undefined ? {} : { input }),
})

/**
 * The subset of `paths` the repository would carry — absolute paths in, absolute paths out.
 *
 * A path OUTSIDE the project is passed through untouched: git has no opinion on another checkout's
 * file, and dropping it would silently hide an edit the worker really made. A project that is not a git
 * repository filters nothing, for the same reason — there is no ignore list to consult, so every write
 * is repo work by default rather than invisible by default.
 */
export async function repoCarriedFiles(projectDir: string, paths: readonly string[]): Promise<string[]> {
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
  let ignored: Promise<Set<string>>
  if (hit && now - hit.at < CACHE_TTL_MS) {
    ignored = hit.ignored
  } else {
    ignored = probeIgnored(projectDir, inside.slice(0, MAX_PROBE))
    cache.set(key, { at: now, ignored })
    // The key carries the whole path list, so a long-lived server would otherwise accumulate one entry
    // per distinct thread-and-write-set. Cheap bound: drop the oldest once it grows past a few boards.
    if (cache.size > 256) for (const k of [...cache.keys()].slice(0, 64)) cache.delete(k)
  }
  const verdict = await ignored
  return paths.filter((p) => !verdict.has(p))
}

/** `repoCarriedFiles` over the rail's own rows, preserving their order and their diffstats. */
export async function repoCarriedEditedFiles<T extends { path: string }>(projectDir: string, files: readonly T[]): Promise<T[]> {
  if (files.length === 0) return []
  const kept = new Set(await repoCarriedFiles(projectDir, files.map((f) => f.path)))
  return files.filter((f) => kept.has(f.path))
}

function canonical(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

function within(dir: string, p: string): boolean {
  const rel = path.relative(dir, p)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * Where a file really is: its DIRECTORY resolved through every symlink, its own name kept.
 *
 * Git refuses to judge a path spelled through a symlinked directory (`fatal: pathspec … is beyond a
 * symbolic link`, exit 128), and one such path fails the whole `--stdin` batch — so a single write to
 * `.claude/skills/<name>/SKILL.md`, a link into `.agents/skills/`, switched the filter off for every
 * row on that thread's rail. The file's own name is left alone because a symlink that is itself the
 * thing written is an entry git can judge.
 */
function realLocation(p: string): string {
  try {
    return path.join(realpathSync(path.dirname(p)), path.basename(p))
  } catch {
    return p
  }
}

/**
 * Every checkout that could hold one of the project's files — the linked worktrees INSIDE `projectDir`,
 * deepest first, then the project itself — as real paths. Undefined when it is not a git checkout.
 */
function checkoutsWithin(projectDir: string): Promise<string[] | undefined> {
  const now = Date.now()
  const hit = checkoutCache.get(projectDir)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.checkouts
  const checkouts = listCheckouts(projectDir)
  checkoutCache.set(projectDir, { at: now, checkouts })
  return checkouts
}

async function listCheckouts(projectDir: string): Promise<string[] | undefined> {
  let listing: string
  try {
    // Rejects outside a repository, which is the case that filters nothing. It replaced a bare
    // `rev-parse --is-inside-work-tree` here, so asking costs no process the probe did not already spend.
    listing = (await git(["worktree", "list", "--porcelain"], projectDir)).stdout
  } catch {
    return undefined
  }
  const project = canonical(projectDir)
  const nested = listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonical(line.slice("worktree ".length)))
    .filter((root) => within(project, root))
  return [...nested.sort((a, b) => b.length - a.length), project]
}

async function probeIgnored(projectDir: string, inside: readonly string[]): Promise<Set<string>> {
  const checkouts = await checkoutsWithin(projectDir)
  if (!checkouts) return new Set()
  // checkout → real path → every spelling the caller used for it. Git is asked about real paths and
  // answers in them; the rail's rows carry the worker's spelling, so the verdict is mapped back.
  const asked = new Map<string, Map<string, string[]>>()
  for (const p of inside) {
    const real = realLocation(p)
    const checkout = checkouts.find((root) => within(root, real))
    // A link out of the project: the file is another tree's, and git here has no opinion on it.
    if (!checkout) continue
    let byReal = asked.get(checkout)
    if (!byReal) asked.set(checkout, (byReal = new Map()))
    const spellings = byReal.get(real)
    if (spellings) spellings.push(p)
    else byReal.set(real, [p])
  }
  const ignored = new Set<string>()
  const verdicts = await Promise.all([...asked].map(async ([checkout, byReal]) => ({ byReal, reals: await ignoredIn(checkout, [...byReal.keys()]) })))
  for (const { byReal, reals } of verdicts) {
    for (const real of reals) {
      for (const spelling of byReal.get(real) ?? []) ignored.add(spelling)
    }
  }
  return ignored
}

async function ignoredIn(checkout: string, paths: readonly string[]): Promise<Set<string>> {
  // `check-ignore -z --stdin` prints the paths it IS ignoring, NUL-separated. INDEX-AWARE, i.e. WITHOUT
  // `--no-index`: a file force-added under an ignored directory (`git add -f secret/kept.txt`) is one
  // the repository genuinely carries, and the default mode says so while `--no-index` calls it ignored
  // and would drop it from the rail. Verified against `git ls-files` as ground truth, 2026-09-04.
  try {
    const { stdout } = await git(["check-ignore", "-z", "--stdin"], checkout, paths.join("\0"))
    return new Set(stdout.split("\0").filter(Boolean))
  } catch (error) {
    // Exit 1 means "nothing here is ignored" and arrives as a rejection with an empty stdout — a verdict,
    // not a failure. Anything else (git missing, a broken repo) filters nothing.
    const { code, stdout } = error as OffThreadExecError
    if (code === 1) return new Set((stdout ?? "").split("\0").filter(Boolean))
    return new Set()
  }
}
