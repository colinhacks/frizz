// AFTER FRIZZ RENAMES A PROJECT'S FOLDER — keep every worker that started in the old folder working.
//
// A running worker does NOT follow the inode. Claude Code keeps its working directory as a PATH and
// checks it before each Bash call, so a renamed folder fails every shell command with
// `Working directory "…/old" no longer exists, so shell commands cannot run until it is restored`
// (measured 2026-11-04 on Claude Code 2.1.316 with a live `claude -p` session renamed between turns).
// `CLAUDE_PROJECT_DIR` is fixed when the session starts, too, so the worker's hooks keep aiming at the
// old path. A symlink at the old path fixes both: the same session's shell ran again with one in place,
// and Claude Code moved its own working directory to the new physical path after the next Bash call.
//
// So a rename leaves a link at the path it vacated, and each worker daemon that started before the
// rename is RETIRED as soon as it comes to rest — the same teardown hibernation performs, so its next
// input cold-resumes in the new folder with a fresh `CLAUDE_PROJECT_DIR`. A daemon in the middle of a
// turn, including the worker that asked for the rename, cannot be retired: it keeps running through
// the link and is retired at its next rest. Once no daemon from before the rename is alive, the links
// are removed.
//
// The record of what is pending lives in the project's STATE dir, keyed by id like everything else, so
// the cleanup survives a Frizz restart: every registered project opens at boot (tenant-prime.ts) and its
// context resumes the sweep.
import { lstatSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { isLinkTo } from "./project-registry.ts"
import { hibernationVerdict, type HibernationBlock } from "./thread-hibernation.ts"
import type { SessionRow } from "./storage.ts"
import type { SessionTelemetry } from "./tailer.ts"

/** What one project still owes after Frizz renamed its folder. */
export interface ProjectRelocation {
  /** Absolute paths Frizz left as links to the project's folder. */
  links: string[]
  /** When the last rename finished. A daemon created before this was started in a folder that is
   *  now only a link, and is retired at its next rest. */
  movedAt: string
}

/** How often the sweep looks while a relocation is pending. Short, because the worker that asked for
 *  the rename is retired at its first rest, and the sooner that happens the shorter the link lives. */
export const RELOCATION_SWEEP_INTERVAL_MS = 5_000

export function relocationRecordPath(stateDir: string): string {
  return join(stateDir, "relocation.json")
}

export function readRelocation(stateDir: string): ProjectRelocation | null {
  try {
    const parsed = JSON.parse(readFileSync(relocationRecordPath(stateDir), "utf8")) as Partial<ProjectRelocation>
    if (!Array.isArray(parsed?.links) || typeof parsed.movedAt !== "string") return null
    return { links: parsed.links.filter((link): link is string => typeof link === "string"), movedAt: parsed.movedAt }
  } catch {
    return null
  }
}

function writeRelocation(stateDir: string, relocation: ProjectRelocation | null): void {
  if (!relocation || relocation.links.length === 0) {
    rmSync(relocationRecordPath(stateDir), { force: true })
    return
  }
  writeFileSync(relocationRecordPath(stateDir), `${JSON.stringify(relocation, null, 2)}\n`)
}

/** Whether `link` is a symlink whose target reads as `target` — true for a link whose target has gone. */
function linkReads(link: string, target: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === resolve(target)
  } catch {
    return false
  }
}

/** Point `link` at `to`. Relative for a sibling, so the pair survives its parent being moved; a
 *  junction on Windows, which needs no privilege for a directory. */
function makeLink(link: string, to: string): void {
  if (process.platform === "win32") symlinkSync(to, link, "junction")
  else symlinkSync(dirname(link) === dirname(to) ? basename(to) : to, link, "dir")
}

/**
 * Leave a link at the folder Frizz just renamed away from, and record it. Called right after the
 * rename, before anything else, so a worker's next Bash call finds a folder at its old path.
 *
 * A link left by an EARLIER rename still names the folder's previous name, so it is pointed at the new
 * one; a link sitting where the folder now is (a rename back) was already removed by the move.
 * Best-effort throughout: a link that cannot be made costs the workers in that folder their shell
 * until they are retired, never the rename itself.
 */
export function leaveRelocationLink(input: { stateDir: string; from: string; to: string; now?: () => Date }): ProjectRelocation {
  const previous = readRelocation(input.stateDir)
  const links: string[] = []
  for (const link of previous?.links ?? []) {
    if (resolve(link) === resolve(input.to) || resolve(link) === resolve(input.from)) continue
    // Only a link this record made, still in place: it reads as the folder's previous name, or already
    // as the new one. Anything else there now is someone else's.
    if (!linkReads(link, input.from) && !linkReads(link, input.to)) continue
    try {
      unlinkSync(link)
      makeLink(link, input.to)
      links.push(link)
    } catch { /* the link is gone; a worker still on it is retired at its next rest regardless */ }
  }
  try {
    makeLink(input.from, input.to)
    links.push(input.from)
  } catch { /* see above */ }
  const relocation: ProjectRelocation = { links, movedAt: (input.now?.() ?? new Date()).toISOString() }
  writeRelocation(input.stateDir, relocation)
  return relocation
}

/** Move the record's clock to now: every daemon alive at this moment was started before the folder
 *  moved. Called once the old tenant is closed, so nothing can still be starting at the old path. */
export function stampRelocation(stateDir: string, now: () => Date = () => new Date()): void {
  const relocation = readRelocation(stateDir)
  if (relocation) writeRelocation(stateDir, { ...relocation, movedAt: now().toISOString() })
}

/** Remove every link the record names that still leads to the project, and the record with them. */
function removeRelocationLinks(stateDir: string, relocation: ProjectRelocation, projectDir: string): string[] {
  const removed: string[] = []
  for (const link of relocation.links) {
    if (!isLinkTo(link, projectDir)) continue
    // One that will not come down is left where it is: retrying every few seconds would not change it.
    try { unlinkSync(link); removed.push(link) } catch {}
  }
  writeRelocation(stateDir, null)
  return removed
}

interface DaemonRef { sessionId: string; createdAt: string }

export interface RelocationDeps {
  stateDir: string
  /** Where the project's folder is now. */
  projectDir: string
  /** Every live Claude broker daemon under this project's state dir. */
  liveDaemons: () => DaemonRef[]
  /** Live daemons of other runtimes that started in the folder too. Never retired here — there is no
   *  proven cold resume to hand them to — but the links stay up while one from before the move lives. */
  otherLiveDaemons?: () => DaemonRef[]
  rows: () => readonly SessionRow[]
  telemetry: (slug: string) => SessionTelemetry | undefined
  pendingInteractions: (slug: string, sessionId: string) => number
  /** Tear one daemon down so its next input cold-resumes. Absent ⇒ nothing is retired, links only wait. */
  retire?: (input: { threadSlug: string; sessionId: string; reason: "relocate" }) => boolean
  now?: () => number
  log?: (msg: string) => void
}

export interface RelocationSweep {
  /** No relocation is pending any more: the links are gone, or there never were any. */
  settled: boolean
  retired: string[]
  /** Threads whose daemon still runs from the old folder, and why it was not retired yet. */
  waiting: { slug: string; blockedBy: HibernationBlock | "no-row" | "other-runtime" | "no-broker" | "error" }[]
  removedLinks: string[]
}

/** A daemon created before the move. An unreadable creation time counts as before: keeping a link up
 *  for one more sweep is harmless, and removing it under a live worker is the failure this exists for. */
function startedBefore(daemon: DaemonRef, movedAtMs: number): boolean {
  const created = Date.parse(daemon.createdAt)
  return !Number.isFinite(created) || created < movedAtMs
}

/**
 * One pass: retire each resting daemon that started in the old folder, and remove the links once none
 * is left. Never throws. Whether a daemon may be retired is hibernation's own verdict with the idle
 * threshold at zero — every refusal it has (a turn in flight, sub-agents, background shells, a person
 * being asked, input not yet delivered) applies unchanged, because the cost of getting it wrong is the
 * same: in-flight work dies with the process.
 */
export function sweepRelocationOnce(deps: RelocationDeps): RelocationSweep {
  const result: RelocationSweep = { settled: false, retired: [], waiting: [], removedLinks: [] }
  const relocation = readRelocation(deps.stateDir)
  if (!relocation) return { ...result, settled: true }
  const movedAtMs = Date.parse(relocation.movedAt)
  const nowMs = deps.now?.() ?? Date.now()
  let stale: DaemonRef[]
  let other: DaemonRef[]
  let rows: readonly SessionRow[]
  try {
    stale = deps.liveDaemons().filter((daemon) => startedBefore(daemon, movedAtMs))
    other = (deps.otherLiveDaemons?.() ?? []).filter((daemon) => startedBefore(daemon, movedAtMs))
    rows = deps.rows()
  } catch {
    return result // cannot see the daemons ⇒ keep every link
  }
  const bySessionId = new Map(rows.map((row) => [row.session_id, row]))
  for (const daemon of stale) {
    const row = bySessionId.get(daemon.sessionId)
    if (!row) { result.waiting.push({ slug: daemon.sessionId, blockedBy: "no-row" }); continue }
    try {
      const verdict = hibernationVerdict(
        {
          slug: row.slug,
          sessionId: daemon.sessionId,
          row,
          telemetry: deps.telemetry(row.slug),
          pendingInteractions: (() => { try { return deps.pendingInteractions(row.slug, daemon.sessionId) } catch { return 1 } })(),
          daemonStartedAtMs: Date.parse(daemon.createdAt),
        },
        { nowMs, idleMs: 0, minDaemonAgeMs: 0 },
      )
      if (!verdict.hibernate) { result.waiting.push({ slug: row.slug, blockedBy: verdict.blockedBy }); continue }
      if (!deps.retire) { result.waiting.push({ slug: row.slug, blockedBy: "no-broker" }); continue }
      if (deps.retire({ threadSlug: row.slug, sessionId: daemon.sessionId, reason: "relocate" })) result.retired.push(row.slug)
    } catch {
      result.waiting.push({ slug: row.slug, blockedBy: "error" })
    }
  }
  for (const daemon of other) result.waiting.push({ slug: daemon.sessionId, blockedBy: "other-runtime" })
  if (result.retired.length) {
    deps.log?.(`relocate: retired ${result.retired.length} daemon(s) still running from the project's old folder; each resumes in ${deps.projectDir} on its next input: ${result.retired.join(", ")}`)
  }
  if (result.waiting.length > 0) return result
  // Read again rather than trusting the retire calls: a link comes down only when nothing from before
  // the move is alive, and a retire that did not take is exactly what this must not paper over.
  try {
    if (deps.liveDaemons().some((daemon) => startedBefore(daemon, movedAtMs))) return result
    if ((deps.otherLiveDaemons?.() ?? []).some((daemon) => startedBefore(daemon, movedAtMs))) return result
  } catch {
    return result
  }
  result.removedLinks = removeRelocationLinks(deps.stateDir, relocation, deps.projectDir)
  if (result.removedLinks.length) deps.log?.(`relocate: no worker runs from the old folder any more; removed ${result.removedLinks.join(", ")}`)
  return { ...result, settled: true }
}

/** Run the sweep until the relocation settles. A no-op when none is pending at start: a rename closes
 *  and reopens the project, so the context that has to finish it is always one created after it.
 *  The first pass is immediate, so links nothing is running behind come down as the project reopens;
 *  a daemon needs the tailer's telemetry before it can be retired, which arrives on a later pass. */
export function startRelocationSweeper(deps: RelocationDeps & { intervalMs?: number }): () => void {
  if (!readRelocation(deps.stateDir)) return () => {}
  try { if (sweepRelocationOnce(deps).settled) return () => {} } catch {}
  const timer: NodeJS.Timeout = setInterval(() => {
    try {
      if (sweepRelocationOnce(deps).settled) clearInterval(timer)
    } catch { /* never let a sweep escape the timer */ }
  }, deps.intervalMs ?? RELOCATION_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
