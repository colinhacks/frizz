import { createHash } from "node:crypto"
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { slugify } from "@frizz/shared"
import { frizzPaths, launchHostDir } from "./frizz-paths.ts"
import { existingProjectId } from "./project-root.ts"

// THE MACHINE'S LIST OF PROJECTS.
//
// One Frizz per machine needs something no per-project server ever did: a list of every project, to
// draw a grid of them and to route `/<slug>` at one of them. That list did not exist — the mapping
// only ever ran repo → id, with no reverse index, and 38 of this machine's 46 state directories have
// no on-disk record of which repo they belong to at all.
//
// THIS FILE IS AN INDEX, NOT IDENTITY. The id lives in the project, at `.frizz/.id` (project-root.ts),
// and that stays the source of truth. Everything here is derived from it and rebuildable by opening a
// project again — which is what makes a machine-level file acceptable at all after the deliberate
// choice to keep identity local. Delete registry.json and you lose card ordering and URL slugs, not
// a single thread.
//
// Keying on the id rather than the path is what makes a project SURVIVE BEING MOVED: `~/.frizz/
// projects/<id>/` already holds every thread, log and attachment, so a path-keyed registry would have
// to re-key all of that on a `mv` or keep a path → id map anyway. The id is already the spine.
//
// It also buys back the duplicate-checkout self-heal that went out with `identity.json`: an id found
// at a path the registry does not know, while the path it DOES know still exists, means someone
// `cp -R`'d a project. Copying is the one case the id-in-the-tree design cannot distinguish on its
// own, and the registry sees it for free.

export interface RegistryEntry {
  /** The project id — the same UUID in that project's `.frizz/.id`. */
  id: string
  /** Canonical root, as resolved when it was last opened. */
  path: string
  /** URL alias: `/<slug>`. Derived once at registration and never re-derived — see §1 of the plan. */
  slug: string
  /** Operator's display override, if they renamed it. */
  name?: string
  lastOpenedAt: string
  /** Hidden from the grid without forgetting it — throwaway repos should not be permanent fixtures. */
  archived?: boolean
  /**
   * Absolute path to this project's icon — inside the project when detected, inside its state dir
   * when the operator uploaded one. Cached here so drawing a rail of forty squares is one file read;
   * `resolveProjectIcon` owns filling it in.
   */
  icon?: string
  /** `custom` is an operator's choice and is never overwritten by a scan. */
  iconSource?: "custom" | "detected"
  /** When the scan last ran. Its absence — not a missing `icon` — is what asks for another one. */
  iconScannedAt?: string
  /**
   * Which VERSION of the scanner produced that answer.
   *
   * A cached "this project has no icon" is only as good as the scan that concluded it, and improving
   * the scanner is precisely when every one of those answers becomes suspect. Without this, widening
   * the search (2026-08-06: `site/public` was never looked in, so nub's complete icon set was
   * invisible) would have left every affected project showing a monogram until the 12-hour retry
   * happened to come round. Bumping ICON_SCAN_VERSION re-asks every project at once.
   */
  iconScanVersion?: number
  /**
   * A hash of the icon file's BYTES (`iconContentHash`), and the card's `iconVersion` whenever it is
   * known. It replaced `iconScannedAt` there because a rescan restamps that every ten minutes, whether or
   * not it found a different picture, and each new stamp was a new URL — so every icon on the machine
   * was downloaded again at least that often. The hash changes only when the picture does.
   *
   * Set by an upload and by a scan; the icon route corrects it whenever the file it serves no longer
   * matches, which covers a file edited in place and an entry written before this existed.
   */
  iconHash?: string
  /**
   * The operator's own position for this project in the rail, ascending.
   *
   * Absent until somebody drags something, and then written for EVERY project at once (see
   * `reorderProjects`) so the list is never half-ordered. Its absence is what keeps recency as the
   * default: a machine nobody has arranged still opens with what it was last working on at the top.
   */
  order?: number
}

export interface Registry {
  version: 1
  projects: RegistryEntry[]
  /**
   * Ids the operator deleted from the grid while KEEPING their state — see `forgetProject`.
   *
   * The state dir is what `backfillRegistry` recovers a project from, so without this a forgotten
   * project came straight back at the next boot. Cleared by `registerProject`, which is every
   * deliberate way of opening a project again.
   */
  forgotten?: string[]
}

export type RegisterAction = "created" | "reopened" | "moved" | "rekeyed" | "duplicate" | "unlisted"

const EMPTY: Registry = { version: 1, projects: [] }

/**
 * Basenames too generic to be a useful URL on their own — `~/x/app` and `~/y/app` are both `app`.
 * Qualified with the parent directory at registration (`pullfrog/app` → `pullfrog-app`).
 */
const GENERIC = new Set([
  "app", "src", "web", "www", "main", "repo", "code", "server", "client",
  "packages", "site", "scratch", "tmp", "test",
])

/**
 * Segments a project may never take, because Frizz itself answers on them. `_frizz` is the formal
 * namespace; the rest are today's hardcoded routes and static assets, kept until they move under it.
 */
const RESERVED = new Set([
  "_frizz", "rpc", "events", "ws", "term", "attach", "local-image", "local-file", "local-visualization",
  // `control` answers `/control/stop` and `/control/status` — the supervisor channel the board polls
  // every few seconds. It was missing from this list, so a directory called `control` could have taken
  // the segment and routed the whole machine's supervisor polling into one project's app, which has no
  // such route. Only newly minted slugs consult this, so adding it strands nothing already registered.
  "control",
  "project-icon", "assets", "favicon", "manifest", "index", "api", "health",
])

export function registryPath(home = homedir()): string {
  return join(frizzPaths({ home }).data, "registry.json")
}

export function readRegistry(home = homedir()): Registry {
  let raw: string
  try {
    raw = readFileSync(registryPath(home), "utf8")
  } catch {
    return { ...EMPTY, projects: [] }
  }
  try {
    const parsed = JSON.parse(raw) as Registry
    if (parsed?.version !== 1 || !Array.isArray(parsed.projects)) return { ...EMPTY, projects: [] }
    // A malformed entry is dropped rather than poisoning the whole list — this is an index, and the
    // cost of forgetting one card is that opening that project re-registers it.
    const forgotten = Array.isArray(parsed.forgotten) ? parsed.forgotten.filter((id) => typeof id === "string") : []
    // Frizz's own launch folder is never a project (registerProject refuses it), but a server older
    // than 0.15.21 had no such refusal and its boot backfill registered the folder as "host" whenever
    // a newer launcher hosted it there. Dropped HERE so no reader ever sees that entry — the list, the
    // slug lookup, the rail — and the next write of any kind takes it out of the file.
    const host = canonicalPath(launchHostDir(home))
    return {
      version: 1,
      projects: parsed.projects.filter(
        (p) => p && typeof p.id === "string" && typeof p.path === "string" && typeof p.slug === "string" && p.path !== host,
      ),
      ...(forgotten.length > 0 ? { forgotten } : {}),
    }
  } catch {
    return { ...EMPTY, projects: [] }
  }
}

const writeListeners = new Set<(path: string) => void>()

/**
 * Hear about every registry write THIS PROCESS makes, with the path of the file it replaced.
 *
 * Hung on `writeRegistry` rather than on the procedures that call it, because every change to the
 * project list — a reorder, a rename, an icon, a project added, moved or forgotten — funnels through
 * that one function, and the server has to tell every open tab about each of them (index.ts). A
 * listener per call site would cover the ones somebody remembered. The path rides along because the
 * registry is addressed by `home`: a listener compares it against the file it cares about.
 *
 * In-process only. Another process's write (a second `frizz` launch registering its directory) is
 * not heard; a tab picks that one up at its next load or reconnect.
 */
export function onRegistryWrite(listener: (path: string) => void): () => void {
  writeListeners.add(listener)
  return () => { writeListeners.delete(listener) }
}

/** open(wx) → fsync → rename, the same shape project-launch.ts uses: a reader never sees a half file. */
export function writeRegistry(registry: Registry, home = homedir()): void {
  const path = registryPath(home)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temp, "w", 0o600)
    writeFileSync(fd, `${JSON.stringify(registry, null, 2)}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch {} }
    try { rmSync(temp, { force: true }) } catch {}
    throw error
  }
  for (const listener of writeListeners) {
    try {
      listener(path)
    } catch {
      // The write landed. A listener that throws must not turn it into a failed mutation.
    }
  }
}

function slugifyProject(value: string): string {
  const s = slugify(value)
  return s === "thread" ? "project" : s // slugify's own fallback is thread-shaped
}

/**
 * The URL alias, derived ONCE at registration.
 *
 * Never re-derived on boot: renaming a directory must not silently change a bookmarked URL. The
 * incumbent always keeps its slug for the same reason — a newcomer is what gets qualified.
 */
export function deriveSlug(
  dir: string,
  taken: ReadonlySet<string>,
  options: { remoteOwner?: string } = {},
): string {
  const base = slugifyProject(basename(dir))
  const parent = slugifyProject(basename(dirname(dir)))
  const qualified = GENERIC.has(base) && parent ? `${parent}-${base}` : base

  const candidates = [
    qualified,
    ...(options.remoteOwner ? [`${slugifyProject(options.remoteOwner)}-${base}`] : []),
    ...(parent && parent !== qualified ? [`${parent}-${base}`] : []),
  ]
  for (const candidate of candidates) {
    if (candidate && !taken.has(candidate) && !RESERVED.has(candidate)) return candidate
  }
  const root = candidates[0] || "project"
  for (let n = 2; ; n++) {
    const candidate = `${root}-${n}`
    if (!taken.has(candidate) && !RESERVED.has(candidate)) return candidate
  }
}

/**
 * Record that `id` lives at `dir`, reconciling whatever the registry believed before.
 *
 * `duplicate` is the one the caller must act on: the id is registered at a DIFFERENT path that still
 * exists, so this directory is a copy of that one rather than the same project moved. Nothing is
 * written in that case — the caller mints a fresh id for the copy and calls again.
 */
/**
 * The canonical form of a project path — resolved through every symlink.
 *
 * ONE place, because the callers disagreed and the disagreement was invisible until a rail rendered
 * the same project twice. On macOS `/var` is a symlink to `/private/var`, so the launcher (which
 * realpaths) and the grid's add path (which did not) registered one directory under two paths, with
 * two ids and two slugs. Normalising at the boundary means no caller can get it wrong, and a path
 * that cannot be resolved — a directory since deleted — is kept verbatim so a stale card still
 * matches the entry it came from.
 */
function canonicalPath(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

export function registerProject(
  input: { dir: string; id: string; remoteOwner?: string; now?: () => Date },
  home = homedir(),
): { entry?: RegistryEntry; action: RegisterAction } {
  input = { ...input, dir: canonicalPath(input.dir) }
  // The folder the server is launched on when the machine has no project yet (frizz-paths.ts
  // launchHostDir) has an id and a state dir like any project, and every caller that registers one —
  // the launchers, the boot backfill, the dashboard's add — comes through here. It is never listed.
  if (input.dir === canonicalPath(launchHostDir(home))) return { action: "unlisted" }
  const registry = readRegistry(home)
  // Opening a project again is what undoes forgetting it. Every branch below that registers this id
  // writes the registry, so the cleared list rides along; `duplicate` writes nothing and keeps it.
  if (registry.forgotten) {
    registry.forgotten = registry.forgotten.filter((id) => id !== input.id)
    if (registry.forgotten.length === 0) delete registry.forgotten
  }
  const at = (input.now ?? (() => new Date()))().toISOString()
  const byId = registry.projects.find((p) => p.id === input.id)

  if (byId) {
    if (byId.path === input.dir) {
      byId.lastOpenedAt = at
      writeRegistry(registry, home)
      return { entry: byId, action: "reopened" }
    }
    // The id is claimed by a path that is still there ⇒ this directory is a COPY of it, not the same
    // project relocated. Refuse rather than stealing the original's threads.
    if (existsSync(join(byId.path, ".frizz", ".id"))) return { action: "duplicate" }
    byId.path = input.dir
    byId.lastOpenedAt = at
    writeRegistry(registry, home)
    return { entry: byId, action: "moved" }
  }

  // A known path whose id changed — the directory was replaced. The file in the tree wins.
  const byPath = registry.projects.find((p) => p.path === input.dir)
  if (byPath) {
    byPath.id = input.id
    byPath.lastOpenedAt = at
    writeRegistry(registry, home)
    return { entry: byPath, action: "rekeyed" }
  }

  const taken = new Set(registry.projects.map((p) => p.slug))
  const entry: RegistryEntry = {
    id: input.id,
    path: input.dir,
    slug: deriveSlug(input.dir, taken, { remoteOwner: input.remoteOwner }),
    lastOpenedAt: at,
  }
  registry.projects.push(entry)
  writeRegistry(registry, home)
  return { entry, action: "created" }
}

/** Most recently opened first — the order a grid wants. `stale` marks a path that is gone. */
/**
 * Seed the registry from state directories that predate it.
 *
 * WHY THIS EXISTS. The registry only learns about a project when something opens it, so a machine
 * that has been running Frizz for months arrives at its first grid with one card — and the operator's
 * only way to fill it is to visit every repository in a terminal, which is precisely the chore one
 * server for the machine was supposed to end. Everything needed is already on disk: each state dir is
 * named for its project id and records the directory it was opened from.
 *
 * CONSERVATIVE ON PURPOSE. A state dir is adopted only when the project STILL CLAIMS THAT ID. It may
 * claim it either way Frizz has ever stored one: `.frizz/.id`, or the older `git config frizz.id`.
 * Checking only the file was a real bug — boron and pullfrog/app both predate the gitless change and
 * had never been reopened since, so they carried a git-config id and no file, and the backfill
 * silently skipped two of the four projects actually in use (2026-08-06). A checkout that has since been re-identified (copied,
 * or re-created after a delete) is skipped rather than guessed at, because the cost of guessing is a
 * card that opens the wrong board. Same for a directory that no longer exists.
 *
 * DUPLICATES ARE REAL. Two ids can name one path — a project deleted and re-opened leaves the old
 * state dir behind, and this machine had two for nub and two for boron. The `.frizz/.id` check
 * settles it: only the id the project currently claims is adopted.
 *
 * Runs once at boot and is idempotent: a path already registered is left exactly as it is, so an
 * operator's rename is never undone.
 */
export function backfillRegistry(
  home = homedir(),
  read: (root: string) => string | undefined = existingProjectId,
): number {
  let dirs: string[]
  try {
    dirs = readdirSync(join(frizzPaths({ home }).data, "projects"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return 0 // no state dirs yet — a genuinely new machine has nothing to recover
  }
  const registry = readRegistry(home)
  const known = new Set(registry.projects.map((p) => p.path))
  // A project the operator deleted from the grid keeps its state dir, and its folder still claims the
  // id — which is exactly what this pass adopts. Recovering it would undo the delete at every boot.
  const forgotten = new Set(registry.forgotten)
  let added = 0
  for (const id of dirs) {
    if (forgotten.has(id)) continue
    // Canonical BEFORE the known-check: the registry stores canonical paths, so comparing a raw
    // recorded one misses its own entry and re-registers the same project on every single boot.
    const recorded = recordedProjectDir(join(frizzPaths({ home }).data, "projects", id))
    const dir = recorded ? canonicalPath(recorded) : undefined
    if (!dir || known.has(dir)) continue
    if (read(dir) !== id) continue
    try {
      const result = registerProject({ dir, id }, home)
      if (result.entry) {
        known.add(dir)
        added++
      }
    } catch {
      // One unreadable state dir must not stop the rest; this is a convenience, not a source of truth.
    }
  }
  return added
}

/**
 * The directory a state dir was last opened from, per the small JSON files a server and the launcher
 * leave.
 *
 * The SURVIVORS FIRST, and that ordering is the whole point. `server.lock` and `project-launch.owner`
 * are liveness records and are removed when the server stops, so a backfill that consulted only those
 * could recover a project that happened to be running and nothing else — which on this machine meant
 * boron and pullfrog/app, both stopped, stayed invisible even after the identity fix that was supposed
 * to find them (2026-08-06). `serving.json` leads: every server that opens the project writes it and
 * keeps the folder when it closes (project-serving.ts), where `launcher.json` is written only for the
 * folder a launcher ran the server on, which since the server moved onto Frizz's own folder is none.
 */
function recordedProjectDir(stateDir: string): string | undefined {
  // `serving.json` is PROJECT_SERVING_FILE, spelled out rather than imported so the registry does not
  // take on the launch-ownership module behind it.
  for (const name of ["serving.json", "launcher.json", "server.lock", "project-launch.owner"]) {
    try {
      const value = (JSON.parse(readFileSync(join(stateDir, name), "utf8")) as { projectDir?: unknown }).projectDir
      if (typeof value === "string" && value.length > 0 && existsSync(value)) return value
    } catch {
      // Missing or malformed; try the next one.
    }
  }
  return undefined
}

/**
 * Every project, in the order the rail and the grid draw them.
 *
 * The operator's ARRANGEMENT wins where one exists, and recency is the default until it does. Both
 * surfaces read this one function on purpose: they are on screen together at `/`, and a rail the
 * operator has arranged sitting beside a grid that has re-sorted itself by recency is two answers to
 * the same question.
 *
 * Recency as the default is not merely a fallback, it is the better cold start — a machine nobody has
 * arranged opens with what it was last working on at the top. But it also means the rail SHUFFLES
 * ITSELF as you work, which is the thing manual order exists to stop, so the first drag pins
 * everything (`reorderProjects` writes an order for every project, not just the moved one).
 *
 * A project registered after an arrangement has no order and sorts to the END, newest first, which is
 * where a new arrival belongs in a list somebody has already arranged.
 */
export function listProjects(home = homedir()): (RegistryEntry & { stale: boolean })[] {
  const byRecency = (a: RegistryEntry, b: RegistryEntry) =>
    a.lastOpenedAt < b.lastOpenedAt ? 1 : a.lastOpenedAt > b.lastOpenedAt ? -1 : 0
  return readRegistry(home)
    .projects.map((p) => ({ ...p, stale: !existsSync(p.path) }))
    .sort((a, b) => {
      if (a.order === undefined && b.order === undefined) return byRecency(a, b)
      if (a.order === undefined) return 1
      if (b.order === undefined) return -1
      return a.order - b.order
    })
}

/**
 * Pin the rail's order to exactly `ids`.
 *
 * Writes an order for EVERY project the registry knows, not only the ones named: a half-ordered list
 * has to fall back to recency for the rest, and then the unordered tail keeps rearranging itself
 * underneath an operator who has just said where they want things. Anything the caller did not name
 * (registered on another tab, mid-drag) keeps its relative position after the named ones rather than
 * being dropped.
 */
export function reorderProjects(ids: readonly string[], home = homedir()): RegistryEntry[] {
  const registry = readRegistry(home)
  const rank = new Map(ids.map((id, index) => [id, index]))
  const known = registry.projects.filter((p) => rank.has(p.id))
  const rest = listProjects(home).filter((p) => !rank.has(p.id))
  known.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  ;[...known, ...rest].forEach((entry, index) => {
    const target = registry.projects.find((p) => p.id === entry.id)
    if (target) target.order = index
  })
  writeRegistry(registry, home)
  return registry.projects
}

/**
 * The id a project root with NO id file is given, before a new one is minted.
 *
 * `.frizz/` is ignored by Git and looks like scratch, so it gets deleted: by hand, by `git clean -fdx`,
 * by a fresh clone into the same folder. Two things still remember the project. `git config frizz.id`
 * does, for a repository the launcher has opened; nothing in the tree does for a plain folder, or for
 * a repository added from the dashboard, and each of those came back as a new project with an empty
 * board, its threads still on disk under an id nothing led to (the registry filed it as `rekeyed`).
 * The registry remembers all of them, by folder.
 *
 *  - The registry's entry for this exact folder is the board that was open here, and wins.
 *  - Unless Git names an id the registry files under ANOTHER folder: that is a checkout moved or
 *    copied here, which carries its own identity, and `registerProject` settles who keeps it.
 *  - With neither, whatever Git says, and a caller mints when that is nothing.
 *
 * Never asked for a linked worktree: its id lives in Git's own directory for that worktree, where
 * removing the worktree is meant to remove it.
 */
export function seedProjectId(root: string, home = homedir(), gitId?: string): string | undefined {
  const registry = readRegistry(home)
  const canonical = canonicalPath(root)
  const here = registry.projects.find((p) => p.path === canonical || p.path === root)
  if (!here) return gitId
  if (gitId && gitId !== here.id && registry.projects.some((p) => p.id === gitId)) return gitId
  return here.id
}

/** The entry for a directory Frizz already knows, if it knows it. */
export function findByPath(path: string, home = homedir()): RegistryEntry | undefined {
  // Canonical on both sides, or a caller passing the symlinked spelling misses its own entry.
  const canonical = canonicalPath(path)
  return readRegistry(home).projects.find((p) => p.path === canonical || p.path === path)
}

export function findBySlug(slug: string, home = homedir()): RegistryEntry | undefined {
  return readRegistry(home).projects.find((p) => p.slug === slug)
}

export function findById(id: string, home = homedir()): RegistryEntry | undefined {
  return readRegistry(home).projects.find((p) => p.id === id)
}

/**
 * The project a `/_frizz/<segment>/…` request names: its slug, or its id.
 *
 * The browser addresses a project by SLUG, because that is what the operator reads in the URL bar. A
 * worker's frizz MCP server addresses it by ID, because it is handed the segment once when it spawns
 * and then holds it for the life of a detached daemon — a rename would silently strand it, and the
 * failure would be an unknown segment falling through to whichever project launched the server.
 *
 * Slug wins a tie. An id is a UUID and the slug rule cannot mint one from a directory basename
 * without someone naming a directory after a UUID, so the two do not realistically collide.
 */
export function findProjectBySegment(segment: string, home = homedir()): RegistryEntry | undefined {
  return findBySlug(segment, home) ?? findById(segment, home)
}

// ── ICONS ───────────────────────────────────────────────────────────────────────────────────────
//
// The rail draws one square per project, and the icon behind each square is DERIVED — a path found by
// scanning the project (project-icon.ts), or one the operator uploaded. Both live here for the same
// reason the rest of this file does: the rail needs forty of them at once, and opening forty projects
// to answer is exactly what lazy activation exists to avoid.
//
// Losing this cache costs one rescan, like losing anything else in the index.

/**
 * Bump whenever the SCAN changes in a way that could find something it previously missed.
 *
 * 2 — `site/public` and its family: hosts (`site`, `web`, `docs`, `frontend`, …) are now crossed with
 *     asset directories instead of hand-listed, so a site in a subdirectory is finally looked in.
 * 3 — a colourless SVG is demoted below any coloured sibling, so a Simple-Icons-style glyph stops
 *     winning and rendering as a solid black tile. A cached PICK is as stale as a cached miss here:
 *     bun had already stored the black one.
 * 4 — a brand kit (`logos/`, `branding/`, under `public/` and friends too) is searched, and its
 *     `-square` cut counts as an app icon. Pullfrog had stored a 180px disc from `app/` while a 600px
 *     square sat unread in `public/logos/`.
 */
export const ICON_SCAN_VERSION = 4

/**
 * How long one scan's answer stands — a miss or a pick — before the next icon request scans again.
 *
 * Minutes, not hours, because a project's icon is a file somebody adds WHILE Frizz is running, and a
 * scan is cheap: ~2ms warm per project, 23ms for a whole 12-project registry and 10ms for the largest
 * repo in it (measured 2026-10-11). It was 12 hours for a miss and forever for a pick until then, and
 * keyward, ccbroker and macwatch each committed a `logo.svg` hours after a scan had found nothing there;
 * none of the three ever showed it.
 */
export const ICON_RESCAN_AFTER_MS = 10 * 60 * 1000

/**
 * Whether this entry's scanned answer still stands: it came from the CURRENT scanner, and recently.
 *
 * ONE predicate for both halves of the cache. `resolveProjectIcon` trusts an answer only while this
 * holds, and `projectIconStatus` tells the client a miss is `none` (do not even ask) only while this
 * holds. They disagreed until 2026-10-11: the route would have rescanned an old miss, but the card
 * still said `none`, so the request that triggers the rescan never went out and a miss was final.
 */
export function iconScanIsCurrent(
  entry: Pick<RegistryEntry, "iconScannedAt" | "iconScanVersion">,
  options: { now?: number; version?: number; rescanAfterMs?: number } = {},
): boolean {
  if ((entry.iconScanVersion ?? 0) !== (options.version ?? ICON_SCAN_VERSION)) return false
  if (!entry.iconScannedAt) return false
  return (options.now ?? Date.now()) - Date.parse(entry.iconScannedAt) < (options.rescanAfterMs ?? ICON_RESCAN_AFTER_MS)
}

/**
 * What the grid and the rail are told about a project's icon — see ProjectCard.iconStatus.
 *
 * `none` is the one that stops the client asking, so it is only said of a miss the server would
 * itself still trust (`iconScanIsCurrent`). Once that miss is old, the card says `unknown`, the
 * square requests the icon, and that request is the rescan.
 */
export function projectIconStatus(
  entry: Pick<RegistryEntry, "icon" | "iconScannedAt" | "iconScanVersion">,
  now = Date.now(),
): "icon" | "none" | "unknown" {
  if (entry.icon) return "icon"
  return iconScanIsCurrent(entry, { now }) ? "none" : "unknown"
}

/** Where an uploaded icon lands: the project's own state dir, never inside the repository. */
export function customIconPath(id: string, extension: string, home = homedir()): string {
  return join(frizzPaths({ home }).data, "projects", id, `icon${extension}`)
}

function updateEntry(
  id: string,
  apply: (entry: RegistryEntry) => void,
  home: string,
): RegistryEntry | undefined {
  const registry = readRegistry(home)
  const entry = registry.projects.find((p) => p.id === id)
  if (!entry) return undefined
  apply(entry)
  writeRegistry(registry, home)
  return entry
}

/**
 * Record the operator's own icon for a project. `custom` is a floor, not a preference: no later scan
 * overwrites it, because a person choosing a picture outranks anything a heuristic finds.
 */
export function setProjectIcon(id: string, path: string, home = homedir()): RegistryEntry | undefined {
  const hash = iconFileHash(path)
  return updateEntry(id, (entry) => {
    entry.icon = path
    entry.iconSource = "custom"
    entry.iconScannedAt = new Date().toISOString()
    if (hash) entry.iconHash = hash
    else delete entry.iconHash
  }, home)
}

/** What an icon is known by — its URL version, its ETag, its renditions — from its bytes alone. */
export function iconContentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16)
}

function iconFileHash(path: string): string | undefined {
  try {
    return iconContentHash(readFileSync(path))
  } catch {
    return undefined
  }
}

/**
 * Record the hash of the icon file as the route just READ it, when it differs from what the entry
 * holds: the file was edited in place, or the entry predates `iconHash`. Writing the registry is
 * what announces the change, so every open tab re-reads the list and moves to the new URL.
 */
export function recordProjectIconHash(id: string, path: string, hash: string, home = homedir()): void {
  const entry = readRegistry(home).projects.find((p) => p.id === id)
  if (!entry || entry.icon !== path || entry.iconHash === hash) return
  updateEntry(id, (target) => {
    target.iconHash = hash
  }, home)
}

/** Forget whatever we hold, so the next resolve scans the project again. */
export function clearProjectIcon(id: string, home = homedir()): RegistryEntry | undefined {
  return updateEntry(id, (entry) => {
    delete entry.icon
    delete entry.iconSource
    delete entry.iconScannedAt
    delete entry.iconHash
  }, home)
}

/**
 * This project's icon path, scanning for one the first time it is asked and caching what it finds.
 *
 * RESOLVED LAZILY, which is the whole design. Scanning at registration would leave every project
 * registered before this feature shipped without an icon forever, and scanning inside `listProjects`
 * would turn the grid's one file read into forty directory walks. Instead the icon ROUTE calls this,
 * and the answer is cached for `ICON_RESCAN_AFTER_MS`.
 *
 * A remembered path that has since been deleted — someone reorganised `public/` — triggers a rescan
 * at once rather than a broken image. Any other answer, a pick or a miss, is re-asked once it is older
 * than `rescanAfterMs` or came from an older scanner (`iconScanIsCurrent`), which is how an icon
 * committed after the last scan is ever found.
 */
export function resolveProjectIcon(
  id: string,
  detect: (root: string) => string | undefined,
  options: { home?: string; rescanAfterMs?: number; now?: () => number; version?: number } = {},
): string | undefined {
  const home = options.home ?? homedir()
  const version = options.version ?? ICON_SCAN_VERSION
  const now = options.now ?? Date.now
  const entry = readRegistry(home).projects.find((p) => p.id === id)
  if (!entry) return undefined

  // THE OPERATOR'S OWN CHOICE IS NOT A SCAN RESULT, so no scanner version can overrule it. This is
  // checked FIRST and on its own for that reason: folding it in below let a version bump discard
  // every uploaded icon on the machine at once — every entry written before versioning existed has
  // no `iconScanVersion`, so all of them read as stale, and a project whose icon the operator had
  // deliberately chosen fell back to its monogram. Measured on a real registry (2026-08-08).
  //
  // A chosen file that has gone MISSING is a broken square, not an invitation to pick a different
  // picture for them — leave the choice recorded and let them fix it.
  if (entry.iconSource === "custom") {
    return entry.icon && existsSync(entry.icon) ? entry.icon : undefined
  }

  // A stored DETECTED pick goes stale exactly as a stored miss does. Improving the RANKING (not just
  // the search) means the file we settled on may no longer be the one this project should wear — bun
  // had already cached a black glyph, so re-asking only the misses would have left it black — and so
  // does time: a project that adds a real logo beside the favicon we picked should get to wear it.
  // The version check is what makes improving the scan take effect on the very next request.
  if (iconScanIsCurrent(entry, { now: now(), version, rescanAfterMs: options.rescanAfterMs })) {
    if (!entry.icon) return undefined
    if (existsSync(entry.icon)) return entry.icon
  }
  if (!existsSync(entry.path)) return undefined

  const found = detect(entry.path)
  // Hashed on every scan, so a rescan that lands on the same picture keeps the same URL.
  const hash = found ? iconFileHash(found) : undefined
  updateEntry(id, (target) => {
    if (found) {
      target.icon = found
      target.iconSource = "detected"
    } else {
      delete target.icon
      delete target.iconSource
    }
    if (hash) target.iconHash = hash
    else delete target.iconHash
    target.iconScannedAt = new Date(now()).toISOString()
    target.iconScanVersion = version
  }, home)
  return found
}

/** Rename is the escape hatch for every derivation rule above, so it exists from day one. */
export function renameProject(
  id: string,
  /** `name: null` clears the display override, so the card follows the directory's basename again. */
  update: { slug?: string; name?: string | null; archived?: boolean },
  home = homedir(),
): RegistryEntry | undefined {
  const registry = readRegistry(home)
  const entry = registry.projects.find((p) => p.id === id)
  if (!entry) return undefined
  if (update.slug !== undefined) {
    const slug = slugifyProject(update.slug)
    if (RESERVED.has(slug)) throw new Error(`"${slug}" is reserved by Frizz itself`)
    if (registry.projects.some((p) => p.id !== id && p.slug === slug)) {
      throw new Error(`another project already uses "${slug}"`)
    }
    entry.slug = slug
  }
  if (update.name === null) delete entry.name
  else if (update.name !== undefined) entry.name = update.name
  if (update.archived !== undefined) entry.archived = update.archived
  writeRegistry(registry, home)
  return entry
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

/** Whether `link` is a symlink that leads to `dir`. Anything else at that path is not Frizz's to touch. */
export function isLinkTo(link: string, dir: string): boolean {
  try {
    return isSymlink(link) && realpathSync(link) === realpathSync(dir)
  } catch {
    return false
  }
}

/**
 * Rename a project's DIRECTORY to a sibling basename, and re-register it there.
 *
 * The one first-party way to change the folder itself. The id travels with the tree, so this is the
 * "moved" case `registerProject` already reconciles — the difference is that Frizz did the move and
 * knows about it at once, rather than learning at the next `frizz` run. Off by default in the rename
 * dialog: a folder is the operator's, and renaming Frizz's card must never rename it uninvited.
 *
 * A basename only — no separators, no `.`/`..` — so this can rename a folder and cannot move one
 * somewhere else. The target must not exist: `rename(2)` onto a directory either fails or, on some
 * platforms, replaces an empty one, and neither is what "rename" means here.
 */
export function moveProjectDirectory(id: string, newBasename: string, home = homedir()): RegistryEntry {
  const entry = findById(id, home)
  if (!entry) throw new Error("No such project.")
  const name = newBasename.trim()
  if (!name || name === "." || name === ".." || /[\\/\0]/u.test(name)) {
    throw new Error("A folder name cannot contain a slash.")
  }
  if (!existsSync(entry.path)) throw new Error(`The folder is missing: ${entry.path}`)
  const target = join(dirname(entry.path), name)
  if (target === entry.path) return entry
  // A symlink that leads to this very folder is the one an earlier rename left for its workers
  // (project-relocation.ts), so renaming back takes its place rather than being refused by it.
  if (isLinkTo(target, entry.path)) unlinkSync(target)
  if (existsSync(target) || isSymlink(target)) throw new Error(`Something already exists at ${target}`)
  renameSync(entry.path, target)
  const moved = registerProject({ dir: target, id }, home)
  // The old path is gone, so this can only be "moved"; anything else means the registry changed under
  // us between the read above and the rename, and the folder is already where the operator asked.
  return moved.entry ?? entry
}

/**
 * Drop a project's card, and REMEMBER that it was dropped for as long as its state dir exists.
 *
 * The remembering is what makes the delete last: `backfillRegistry` adopts any state dir whose folder
 * still claims its id, and forgetting touches neither. A project whose state was deleted as well has
 * nothing left to recover, so its id is not kept — the caller removes the state dir first.
 */
export function forgetProject(id: string, home = homedir()): boolean {
  const registry = readRegistry(home)
  const before = registry.projects.length
  registry.projects = registry.projects.filter((p) => p.id !== id)
  if (registry.projects.length === before) return false
  const stateRoot = join(frizzPaths({ home }).data, "projects")
  const forgotten = [...new Set([...(registry.forgotten ?? []), id])].filter((each) => existsSync(join(stateRoot, each)))
  if (forgotten.length > 0) registry.forgotten = forgotten
  else delete registry.forgotten
  writeRegistry(registry, home)
  return true
}
