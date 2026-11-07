// Orphan process reaper — frizz runs a worker per thread inside a DETACHED DAEMON (a Claude thread in
// its own session broker, a codex thread in the app-server; both forked with `detached: true` into
// their own process group), and each worker spawns auxiliary processes for its task: MCP servers,
// dev/watch servers, and verification browsers (chrome-devtools-mcp, agent-browser, puppeteer).
// Stopping a thread SIGTERMs the daemon's pid, so anything that daemonized out of that process group
// (agent-browser double-forks its Chrome to launchd; a `node --watch` reparents on crash) SURVIVES the
// stop and leaks — permanently, since nothing else collects it. Over days this accretes GBs of orphaned
// Chrome/node whose owning thread is long gone. This module reaps exactly those.
//
// Ownership is read from the env marker every worker carries: FRIZZ_THREAD=<slug> (set at spawn in
// dispatch.ts/resume.ts), inherited by everything the worker spawns. A slug is LIVE iff a live
// `claude`/`codex` session process still carries it — a worker's only OS-level agent process is its
// session root (Agent sub-agents are in-process), so this is exact and socket-agnostic (it protects
// a live adhoc-stack's workers automatically, since their roots are alive on the machine).
//
// It also collects one non-process leak of the same shape, on its own much slower timer: the unix
// SOCKET FILES dead Claude session brokers leave in $TMPDIR (see the stale-socket sweep at the bottom
// of this file). Same story — an artifact of a worker that is gone, which nothing else revisits.
//
// SAFETY — the reaper only ever kills an AUXILIARY process whose slug is live NOWHERE. It never
// touches: a session root (`claude`/`codex`, or anything bearing `--session-id`), a leftover tmux
// server from a pre-cutover frizz (it carries the first thread's slug in env but is shared
// infrastructure — see isTmuxServer), the reaper's own process or any ancestor (so it can never kill
// the server it runs in — which is untagged anyway,
// being user-spawned rather than worker-spawned), or any process whose slug is currently live. Every
// enumeration failure fails CLOSED (reap nothing). An age guard skips just-spawned processes.

import { execFileOffThread } from "./off-thread-exec.ts"
import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { claudeBrokerSocketPath } from "./backend/claude-broker-host.ts"
import { sweepStaleSockets } from "./backend/stale-socket-sweep.ts"

export const ORPHAN_REAP_INTERVAL_MS = 60_000
export const ORPHAN_MIN_AGE_MS = 120_000

const SLUG_RE = /FRIZZ_THREAD=([A-Za-z0-9._-]+)/

export interface ProcRow {
  pid: number
  ppid: number
  ageMs: number
  /** argv only (no env), from `ps -o command=` */
  command: string
  /** FRIZZ_THREAD read from the process ENVIRONMENT, or null when untagged/unreadable */
  slug: string | null
}

// ---- Pure classification --------------------------------------------------------------------------

export function firstTokenBasename(command: string): string {
  const first = command.trimStart().split(/\s+/, 1)[0] ?? ""
  const slash = first.lastIndexOf("/")
  return slash >= 0 ? first.slice(slash + 1) : first
}

/** A worker's session process — the only thing that DEFINES a slug as live, and never a reap target. */
export function isSessionRoot(command: string): boolean {
  const base = firstTokenBasename(command)
  if (base === "claude" || base === "codex") return true
  // A node-launched agent CLI still carries --session-id; belt-and-suspenders so a session process
  // is never mistaken for reapable aux regardless of how it was invoked.
  return /(?:^|\s)--session-id(?:\s|=)/.test(command)
}

/**
 * Frizz has not spawned tmux since 2026-08-02 (commit 3dc5bb1d, which deleted the last two modules
 * that did), but this guard OUTLIVES the strip on purpose: upgrading from a pre-cutover frizz can
 * leave a tmux server holding panes the operator may still be reading, and it inherits the first
 * thread's FRIZZ_THREAD in env — which is exactly what makes it look reapable. Killing it would take
 * those panes with it.
 */
export function isTmuxServer(command: string): boolean {
  return firstTokenBasename(command) === "tmux"
}

// ---- Pure decisions -------------------------------------------------------------------------------

export interface ReapDecision {
  /** aux "roots" to reap (each expanded to its subtree by the caller) */
  reap: number[]
  liveSlugs: string[]
}

function reapable(row: ProcRow, live: Set<string>, protectedPids: ReadonlySet<number>): boolean {
  if (!row.slug) return false // untagged → not ours to touch
  if (live.has(row.slug)) return false // owner still alive
  if (isSessionRoot(row.command)) return false // never a session process
  if (isTmuxServer(row.command)) return false // never shared tmux infra
  if (protectedPids.has(row.pid)) return false // never self / ancestors
  return true
}

/** Periodic sweep decision: reap tagged aux whose slug is live nowhere and which cleared the age guard. */
export function decideOrphans(
  rows: readonly ProcRow[],
  opts: { minAgeMs: number; protectedPids: ReadonlySet<number> },
): ReapDecision {
  const live = new Set<string>()
  for (const r of rows) if (r.slug && isSessionRoot(r.command)) live.add(r.slug)

  const reap: number[] = []
  for (const r of rows) {
    if (!reapable(r, live, opts.protectedPids)) continue
    if (r.ageMs < opts.minAgeMs) continue // just-spawned; give the owner time to appear
    reap.push(r.pid)
  }
  return { reap, liveSlugs: [...live] }
}

/** self + every ancestor, so the reaper can never kill the server process it runs inside. */
export function selfAndAncestors(rows: readonly ProcRow[], selfPid: number): Set<number> {
  const parentOf = new Map<number, number>()
  for (const r of rows) parentOf.set(r.pid, r.ppid)
  const set = new Set<number>([selfPid])
  let cur = selfPid
  for (let guard = 0; guard < 10_000; guard++) {
    const pp = parentOf.get(cur)
    if (pp === undefined || pp <= 0 || set.has(pp)) break
    set.add(pp)
    cur = pp
  }
  return set
}

/**
 * Expand seed pids to their full descendant subtrees, deepest-first, dropping any pid that must not
 * die (protected / session root / tmux / live-slug). Leaves-first order guarantees a parent is never
 * killed before its children, so no child is re-orphaned to launchd mid-reap.
 */
export function subtreeKillOrder(
  seed: readonly number[],
  rows: readonly ProcRow[],
  keep: (row: ProcRow) => boolean,
): number[] {
  const byPid = new Map<number, ProcRow>()
  const childrenOf = new Map<number, number[]>()
  for (const r of rows) {
    byPid.set(r.pid, r)
    const list = childrenOf.get(r.ppid) ?? []
    list.push(r.pid)
    childrenOf.set(r.ppid, list)
  }
  const set = new Set<number>()
  const stack = [...seed]
  while (stack.length) {
    const pid = stack.pop()!
    if (set.has(pid)) continue
    const row = byPid.get(pid)
    if (row && keep(row)) continue // a protected/live proc nested under a target is never killed
    set.add(pid)
    for (const c of childrenOf.get(pid) ?? []) stack.push(c)
  }
  const depth = (pid: number): number => {
    let d = 0
    let cur = pid
    for (let guard = 0; guard < 10_000; guard++) {
      const pp = byPid.get(cur)?.ppid
      if (pp === undefined || !set.has(pp)) break
      d++
      cur = pp
    }
    return d
  }
  return [...set].sort((a, b) => depth(b) - depth(a))
}

// ---- etime parsing --------------------------------------------------------------------------------

/** ps etime → ms. Accepts `SS`, `MM:SS`, `HH:MM:SS`, `DD-HH:MM:SS`. Unparseable → 0 (fails the guard). */
export function parseEtimeMs(etime: string): number {
  const trimmed = etime.trim()
  if (!trimmed) return 0
  let days = 0
  let rest = trimmed
  const dash = rest.indexOf("-")
  if (dash >= 0) {
    days = Number(rest.slice(0, dash))
    rest = rest.slice(dash + 1)
  }
  const parts = rest.split(":").map((p) => Number(p))
  if (parts.some((n) => !Number.isFinite(n))) return 0
  let h = 0
  let m = 0
  let s = 0
  if (parts.length === 3) [h, m, s] = parts
  else if (parts.length === 2) [m, s] = parts
  else if (parts.length === 1) [s] = parts
  else return 0
  return (((days * 24 + h) * 60 + m) * 60 + s) * 1000
}

// ---- Process enumeration (impure, injectable) -----------------------------------------------------

export type Exec = (file: string, args: string[]) => string | Promise<string>

// ASYNC, never execFileSync. The reaper runs inside the server's event loop, and on a busy machine the
// env pass alone reads megabytes of `ps -E` output (5.5MB across ~1,450 processes, 2026-09-30): the sync
// spawn held the loop for 1-8s per call, three calls a sweep, so every RPC, pin and websocket frame
// stalled behind it — a bare health check took 42s. The tests inject a synchronous fake, which `await`
// takes just as well.
const defaultExec: Exec = async (file, args) =>
  (await execFileOffThread(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })).stdout

/** Reads one process's raw environment block, or null when unreadable (gone, or another user's). */
export type ReadEnv = (pid: number) => string | null

// Linux exposes the env as a NUL-delimited file; permissions make it same-user-only, matching what
// `ps -E` can read on macOS. EACCES/ENOENT → null → the row keeps a null slug (never reaped).
const defaultReadEnv: ReadEnv = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8")
  } catch {
    return null
  }
}

/**
 * Pass 1 (`ps -Aww -o …`, argv only) enumerates pid/ppid/etime/command — `-A` is the spelling both
 * platforms document for "every process" (macOS ps treats it as `-ax`; verified identical output
 * there 2026-08-24, and procps only tolerates the BSD `-ax` form as a compatibility special case).
 *
 * The slug is then read FROM THE ENVIRONMENT ONLY, per platform. On Linux, `/proc/<pid>/environ` —
 * NUL-delimited, so only an exact `FRIZZ_THREAD=<slug>` entry matches and none of the pass-2 record
 * parsing below applies. procps has no `-E`: on a Linux install the old unconditional pass 2 failed
 * every sweep with `error: unsupported SysV option` into the server log (reported 2026-08-24), so the
 * reaper silently reaped nothing there. On macOS, pass 2 is `ps -Eww` (env appended after argv) with
 * the pass-1 argv prefix stripped off first. Reading the slug from env — never argv — is what stops a literal
 * `FRIZZ_THREAD=x` inside a process's argv (pasted task text, an `env FRIZZ_THREAD=x …` invocation,
 * a grep) from spoofing ownership and mis-attributing a live thread's slug.
 *
 * On macOS, deliberately TWO passes, not one `-Eww` pass storing the whole line: a process's full
 * environment (which `ps -E` appends) contains its secrets — API keys, tokens, private keys. The retained
 * `command` is argv-only, and the env-bearing text never escapes this function beyond the slug regex,
 * so secrets can't leak into a log or error. The cost is a negligible pid-reuse race (a pid reassigned
 * between the two sub-ms `ps` calls fails the `${pid} ${argv}` marker match → no slug → not reaped, so
 * the race is fail-safe, never a false kill).
 *
 * Env VALUES can contain newlines (PEM keys, JSON service accounts), so a pass-2 record spans several
 * physical lines; records are delimited by their `<pid> <argv>` marker and false splits re-merged,
 * rather than split on raw newlines. Returns only same-user, parseable rows. macOS `ps -E` cannot read
 * the env of SIP platform binaries like /bin/sleep, but every process a worker actually leaks — node
 * MCP/dev servers and Chrome browsers — is a non-system binary whose env IS readable (verified in the
 * harness). A total env-pass failure fails closed (every slug null → nothing reapable).
 *
 * A PARTIAL failure, though, does NOT fail closed, and this comment claimed the opposite until
 * 2026-08-19 — "since a root and its aux share one env read there is no partial mode that hides a live
 * root while surfacing its aux." They share the `ps` CALL, not the per-record PARSE, and the parse is
 * per-pid: anything that drops one record while keeping its neighbours' is exactly that partial mode.
 * The pid-column padding bug at (c) below was one, and it hid live ROOTS specifically. So the invariant
 * to hold on to is narrower than it looks — a null slug is safe on an AUX row (never reaped) and
 * dangerous on a ROOT row (its whole thread reads dead), and any future change here has to be judged
 * against the second case, not the first.
 */
export interface EnumerateOpts {
  platform?: NodeJS.Platform
  readEnv?: ReadEnv
}

export async function enumerateProcs(exec: Exec = defaultExec, opts: EnumerateOpts = {}): Promise<ProcRow[]> {
  // `-ww` (both passes) disables ps's column truncation so pass-1 argv is the FULL argv — required
  // on macOS for the prefix strip below to leave a clean env segment.
  const base = await exec("ps", ["-Aww", "-o", "pid=,ppid=,etime=,command="])
  const rows: ProcRow[] = []
  const byPid = new Map<number, ProcRow>()
  const pids: number[] = []
  for (const line of base.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    if (!Number.isInteger(pid) || pid <= 0) continue
    const row: ProcRow = { pid, ppid, ageMs: parseEtimeMs(m[3]!), command: m[4]!, slug: null }
    rows.push(row)
    byPid.set(pid, row)
    pids.push(pid)
  }
  if (!pids.length) return rows

  if ((opts.platform ?? process.platform) === "linux") {
    // Only an exact NUL-delimited `FRIZZ_THREAD=<slug>` entry counts — a `FRIZZ_THREAD=x` literal
    // INSIDE another variable's value (pasted task text) is part of a longer entry and never matches.
    // A pid reused between pass 1 and this read would attribute the NEW process's slug to the old
    // row, but Linux allocates pids sequentially up to pid_max, so a wrap inside this sub-ms gap is
    // not a real hazard (the macOS argv-marker check below exists because `ps -E` output forces a
    // re-parse anyway, not because the race is live there either).
    const readEnv = opts.readEnv ?? defaultReadEnv
    for (const row of rows) {
      const environ = readEnv(row.pid)
      if (environ === null) continue
      for (const entry of environ.split("\0")) {
        const m = entry.match(/^FRIZZ_THREAD=([A-Za-z0-9._-]+)$/)
        if (m) {
          row.slug = m[1]!
          break
        }
      }
    }
    return rows
  }

  // Pass 2 (macOS): `-Eww -o pid=,command=` appends the full ENVIRONMENT after argv. Two subtleties:
  //  (a) the slug MUST come from the env, not argv — a process whose argv contains a literal
  //      `FRIZZ_THREAD=x` (pasted task text, a grep, an `env FRIZZ_THREAD=x …` invocation) would spoof
  //      ownership. So strip the known pass-1 argv prefix and read the slug only from what follows.
  //  (b) an env VALUE can contain newlines (PEM keys, JSON), so a record spans multiple physical
  //      lines. Split on record starts (`<pid> <argv>`), re-merging any line that isn't a real
  //      record start (a false split inside a multiline value), rather than splitting on raw \n.
  //  (c) `-o pid=` RIGHT-ALIGNS the pid in a fixed-width column, so a record for a pid narrower than
  //      that column starts with PADDING — ` 1154 /path/claude …`, not `1154 /path/claude …`. Every
  //      record-start match here therefore tolerates leading blanks and the padding is stripped before
  //      the argv prefix is measured. Requiring a bare digit (as this did until 2026-08-19) silently
  //      dropped every sub-10000 pid: its record was re-merged into its predecessor's, so its own slug
  //      read as null. A worker's `claude` session root landing on a short pid then made its thread
  //      look DEAD to decideOrphans — and the reaper SIGKILLed that live worker's aux, adhoc-stack
  //      verification servers included. Measured on the maintainer's machine that day: 3 of 3 session
  //      roots with a 4-digit pid unattributed, 34 of 34 with a 5-digit pid attributed correctly.
  let text: string
  try {
    text = await exec("ps", ["-Eww", "-o", "pid=,command=", "-p", pids.join(",")])
  } catch {
    return rows // env unreadable → every slug null → reap nothing this pass (fail closed)
  }
  const records: string[] = []
  for (const chunk of text.split(/\n(?=[ \t]*\d+ )/)) {
    const record = chunk.replace(/^[ \t]+/, "") // drop the pid column's right-alignment padding
    const pid = Number(record.match(/^(\d+) /)?.[1])
    const argv = byPid.get(pid)?.command
    if (argv !== undefined && record.startsWith(`${pid} ${argv}`)) records.push(record)
    else if (records.length) records[records.length - 1] += `\n${chunk}` // false split → re-merge
  }
  for (const rec of records) {
    const pid = Number(rec.slice(0, rec.indexOf(" ")))
    const row = byPid.get(pid)
    if (!row) continue
    const envSegment = rec.slice(`${pid} ${row.command}`.length)
    row.slug = envSegment.match(SLUG_RE)?.[1] ?? null
  }
  return rows
}

const defaultKill = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // already gone / not permitted — idempotent
  }
}

/** Expand seeds to subtrees and SIGKILL leaves-first. Returns the count actually signalled. */
export function reapSubtrees(
  seed: readonly number[],
  rows: readonly ProcRow[],
  protectedPids: ReadonlySet<number>,
  live: ReadonlySet<string>,
  kill: (pid: number) => void = defaultKill,
): number {
  const keep = (row: ProcRow): boolean =>
    protectedPids.has(row.pid) ||
    isSessionRoot(row.command) ||
    isTmuxServer(row.command) ||
    (row.slug !== null && live.has(row.slug))
  const order = subtreeKillOrder(seed, rows, keep)
  for (const pid of order) kill(pid)
  return order.length
}

// ---- Orchestration --------------------------------------------------------------------------------

export interface SweepDeps {
  exec?: Exec
  /** Platform + env-reader overrides for enumerateProcs (tests pin the OS-specific paths). */
  platform?: NodeJS.Platform
  readEnv?: ReadEnv
  kill?: (pid: number) => void
  selfPid?: number
  minAgeMs?: number
  log?: (msg: string) => void
  /** Thresholds for the report-only runaway detector. */
  runaway?: RunawayOptions
  /** Set false to skip the runaway `ps` pass entirely (tests that assert exact exec call counts). */
  runawayReport?: boolean
}

export interface SweepResult {
  /** total processes SIGKILLed (aux roots + their descendants) */
  reaped: number
  /** distinct dead thread slugs whose aux were reaped */
  deadSlugs: string[]
  liveSlugs: string[]
  /**
   * Set when the enumeration cannot run on this machine AT ALL (`ps` is not on PATH), as opposed to
   * failing this once. startOrphanReaper reads it to say so once and stop the interval, instead of
   * swallowing the same ENOENT every minute in silence — which is what a Windows box did until
   * 2026-09-11 (Windows audit, finding 6).
   */
  unavailable?: string
}

// ── Runaway detection (REPORT ONLY — nothing here kills anything) ─────────────────────────────────
//
// The reaper's whole predicate is "the owning thread is DEAD." That leaves the opposite case entirely
// unwatched: a LIVE thread whose dispatched work is pinning the machine. Measured on the maintainer's
// box 2026-07-26 — load average 95-103 on 10 cores, 5.6 GB into swap, and the top EIGHT CPU consumers
// were all FRIZZ_THREAD-tagged node processes from just TWO threads, four of them at ~80% CPU for
// 2 days 18 hours. Every "extreme lag" / "insane contention" / "the sidebar won't update" report in
// the thread history is downstream of that, and every engineering response so far has made FRIZZ's own
// per-tick work cheaper while the workers' far larger slice stayed unmeasured.
//
// This does not reap. Killing a worker's build because it is slow is a decision frizz has no business
// making unattended, and a long compile is indistinguishable from a runaway by CPU alone. What is
// missing is not enforcement, it is VISIBILITY: today the operator's only signal is that the laptop
// is hot. So this names the thread.
//
// The metric is average cores held over the process's whole life (`cputime / etime`), not instantaneous
// %CPU — a spot reading catches a healthy compile mid-burst, whereas 0.8 cores sustained across two
// days is unambiguous.

/** ~cores held on average across this process's entire lifetime. */
export interface RunawayAux {
  pid: number
  slug: string
  ageMs: number
  cpuMs: number
  cores: number
}

export interface RunawayOptions {
  /** Average cores held before a process is worth naming. Default 0.5. */
  minCores?: number
  /** How long it must have been doing it. Default 30 min — well past any ordinary build. */
  minAgeMs?: number
}

/** `[dd-]hh:mm:ss[.ff]` accumulated CPU time → ms. NaN-safe: unparseable → 0 (never reported). */
export function parseCpuTimeMs(value: string): number {
  const m = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)
  if (!m) return 0
  const [, d, h, min, s] = m
  const ms = ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(min) * 60 + Number(s)) * 1000
  return Number.isFinite(ms) ? ms : 0
}

/**
 * Join per-pid CPU time onto already-enumerated rows and return the tagged AUX processes over budget.
 * Pure apart from the injected `exec`, and deliberately a SEPARATE `ps` pass: `enumerateProcs`'s
 * two-pass format is load-bearing for slug attribution and is not worth destabilising for telemetry.
 */
export async function detectRunawayAux(
  rows: ProcRow[],
  liveSlugs: ReadonlySet<string>,
  exec: Exec = defaultExec,
  options: RunawayOptions = {},
): Promise<RunawayAux[]> {
  const minCores = options.minCores ?? 0.5
  const minAgeMs = options.minAgeMs ?? 30 * 60_000
  let text: string
  try {
    text = await exec("ps", ["-Ao", "pid=,cputime="])
  } catch {
    return [] // telemetry only — never let it perturb the sweep
  }
  const cpuByPid = new Map<number, number>()
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s*$/)
    if (m) cpuByPid.set(Number(m[1]), parseCpuTimeMs(m[2]!))
  }
  const out: RunawayAux[] = []
  for (const row of rows) {
    // Only AUX of a LIVE thread. A dead thread's aux is the reaper's business, and a session ROOT
    // (the agent itself) is never a runaway — it is the thing the operator asked for.
    if (!row.slug || !liveSlugs.has(row.slug) || isSessionRoot(row.command)) continue
    if (row.ageMs < minAgeMs) continue
    const cpuMs = cpuByPid.get(row.pid) ?? 0
    const cores = cpuMs / Math.max(row.ageMs, 1)
    if (cores >= minCores) out.push({ pid: row.pid, slug: row.slug, ageMs: row.ageMs, cpuMs, cores })
  }
  return out.sort((a, b) => b.cores - a.cores)
}

/** One line per offending THREAD (not per process) — the operator cares which thread, not which pid. */
export function summarizeRunaways(runaways: readonly RunawayAux[]): string[] {
  const bySlug = new Map<string, RunawayAux[]>()
  for (const r of runaways) bySlug.set(r.slug, [...(bySlug.get(r.slug) ?? []), r])
  return [...bySlug.entries()]
    .map(([slug, list]) => ({ slug, list, cores: list.reduce((n, r) => n + r.cores, 0) }))
    .sort((a, b) => b.cores - a.cores)
    .map(({ slug, list, cores }) => {
      const hours = (Math.max(...list.map((r) => r.ageMs)) / 3_600_000).toFixed(1)
      return `orphan-reaper: thread "${slug}" is holding ~${cores.toFixed(1)} core(s) across ${list.length} background process(es), oldest ${hours}h — frizz dispatched these but does not reap a LIVE thread's work`
    })
}

/** One periodic sweep: enumerate → decide → reap. Never rejects (fails closed). */
export async function sweepOrphansOnce(deps: SweepDeps = {}): Promise<SweepResult> {
  const exec = deps.exec ?? defaultExec
  const selfPid = deps.selfPid ?? process.pid
  const minAgeMs = deps.minAgeMs ?? ORPHAN_MIN_AGE_MS
  let rows: ProcRow[]
  try {
    rows = await enumerateProcs(exec, { platform: deps.platform, readEnv: deps.readEnv })
  } catch (error) {
    // ENOENT is `ps` itself missing, which no later sweep will find either; anything else (a
    // timeout, a transient exec failure) is this sweep's problem alone and fails closed as before.
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return { reaped: 0, deadSlugs: [], liveSlugs: [], ...(code === "ENOENT" ? { unavailable: "`ps` is not on PATH" } : {}) }
  }
  const protectedPids = selfAndAncestors(rows, selfPid)
  const { reap, liveSlugs } = decideOrphans(rows, { minAgeMs, protectedPids })
  // Report-only, and BEFORE the early return: a board with nothing to reap is exactly the board most
  // likely to be quietly on fire.
  if (deps.log && deps.runawayReport !== false) {
    for (const line of summarizeRunaways(await detectRunawayAux(rows, new Set(liveSlugs), exec, deps.runaway))) deps.log(line)
  }
  if (!reap.length) return { reaped: 0, deadSlugs: [], liveSlugs }
  const bySlug = new Map(rows.map((r) => [r.pid, r.slug]))
  const deadSlugs = [...new Set(reap.map((pid) => bySlug.get(pid)).filter((s): s is string => !!s))]
  const live = new Set(liveSlugs)
  const reaped = reapSubtrees(reap, rows, protectedPids, live, deps.kill)
  deps.log?.(
    `orphan-reaper: reaped ${reaped} process(es) from ${deadSlugs.length} dead thread(s): ${deadSlugs.join(", ")}`,
  )
  return { reaped, deadSlugs, liveSlugs }
}

// ── Stale broker sockets (files, not processes) ───────────────────────────────────────────────────
//
// A Claude session broker that was SIGKILLed, or whose record a successor had already taken, leaves
// its socket FILE in $TMPDIR forever: the host only ever derives the one path belonging to the session
// it is connecting for, so nothing revisits the rest. Measured on this machine 2026-07-27: ~119 dead
// `frizz-claude-*.sock` against ~4 live. The codex daemon already collects its own family on every
// daemon start; the broker has no equivalent moment, and its litter is the larger pile — so it is
// collected HERE, from the one long-lived process the board always has.
//
// The rules that make this safe — never even CONNECT to a socket some process still references, and
// unlink only on a kernel-refused probe — live in backend/stale-socket-sweep.ts. Nothing here decides
// what is dead.
//
// Deliberately on its OWN, much slower timer rather than inside sweepOrphansOnce(): that function is
// the tested unit and its `ps` call count is asserted, while this pass spawns a machine-wide `lsof -U`
// that has no business running once a minute for a leak measured in a handful of files per hour.
export const STALE_SOCKET_SWEEP_INTERVAL_MS = 10 * 60_000
/** Off the critical path of server startup — nothing waits on housekeeping. */
const STALE_SOCKET_SWEEP_DELAY_MS = 30_000

// Both mirror claudeBrokerSocketPath() in backend/claude-broker-host.ts. The DIRECTORY is derived from
// that builder rather than restating `$TMPDIR`, so the two cannot drift apart; the PREFIX is named here
// because the module exports no constant for it. A wrong directory or prefix finds no candidates and
// sweeps nothing, which is the safe direction to fail.
const CLAUDE_BROKER_SOCKET_PREFIX = "frizz-claude-"

function sweepStaleBrokerSockets(): void {
  try {
    sweepStaleSockets({ dir: dirname(claudeBrokerSocketPath("", "")), prefix: CLAUDE_BROKER_SOCKET_PREFIX })
  } catch {
    // housekeeping is never allowed to perturb the reaper
  }
}

// What the reaper says, once, on a machine where it cannot run. The reaper reads a worker's slug from
// its process ENVIRONMENT (the header explains why never argv), and Windows exposes no other process's
// environment to a Node program — `Get-CimInstance Win32_Process` carries pid, parent, age and the
// command line but not the env block, and reading a foreign PEB needs a native call. So an enumerator
// there would attribute nothing: every slug null, nothing reapable, nothing to report. Rather than run
// that theatre once a minute, or swallow `spawn ps ENOENT` once a minute in silence as it did until
// 2026-09-11 (Windows audit, finding 6), the reaper says this and stays off. What it implies is real:
// the aux processes a dead thread leaves behind on Windows are collected by nobody, and a live
// thread's runaway build is never named.
const UNAVAILABLE_ON_WINDOWS =
  "orphan-reaper: unavailable on Windows — a worker's FRIZZ_THREAD is read from its process environment, which Windows does not expose; " +
  "background processes a stopped thread leaves behind are not collected here, and a live thread's runaway work is not reported"

/** Start the startup + periodic sweep. Returns a stop handle. Timers are unref'd (never hold the loop open). */
export function startOrphanReaper(deps: SweepDeps & { intervalMs?: number } = {}): () => void {
  if ((deps.platform ?? process.platform) === "win32") {
    deps.log?.(UNAVAILABLE_ON_WINDOWS)
    return () => {}
  }
  const intervalMs = deps.intervalMs ?? ORPHAN_REAP_INTERVAL_MS
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null
  // One sweep at a time: a sweep is three `ps` passes, and on a loaded machine one of them has taken
  // 8s — an interval that fires again before the last sweep settles must not stack a second on top.
  let sweeping = false
  const stopSweeps = (): void => {
    if (timer) clearInterval(timer)
    timer = null
  }
  // A POSIX box without `ps` (a stripped container) is the same silence with a different cause: say
  // it once, on whichever sweep first sees it, and stop asking.
  const sweep = async (): Promise<void> => {
    if (sweeping || stopped) return
    sweeping = true
    try {
      const result = await sweepOrphansOnce(deps)
      if (result.unavailable && !stopped) {
        stopped = true
        stopSweeps()
        deps.log?.(`orphan-reaper: unavailable on this machine — ${result.unavailable}; background processes a stopped thread leaves behind are not collected here`)
      }
    } catch {
      // never let a sweep error escape the timer
    } finally {
      sweeping = false
    }
  }
  // The startup sweep is best-effort, and the interval only starts once it has settled, so a machine
  // with no `ps` never arms one.
  void sweep().then(() => {
    if (stopped) return
    timer = setInterval(() => void sweep(), intervalMs)
    timer.unref?.()
  })
  const socketDelay = setTimeout(sweepStaleBrokerSockets, STALE_SOCKET_SWEEP_DELAY_MS)
  socketDelay.unref?.()
  const socketTimer = setInterval(sweepStaleBrokerSockets, STALE_SOCKET_SWEEP_INTERVAL_MS)
  socketTimer.unref?.()
  return () => {
    stopped = true
    stopSweeps()
    clearTimeout(socketDelay)
    clearInterval(socketTimer)
  }
}

// ONE reaper per server process, however many projects it serves. Every sweep is machine-wide — it
// enumerates every process and reaps a dead slug wherever it lives — so a second copy adds no coverage,
// only a second set of `ps` passes. Until 2026-09-30 each project's context started its own: the
// maintainer's singleton serving 22 projects ran 22 reapers, whose sweeps ran back to back and held the
// event loop ~95% of the time, so a pin took seconds to land. The first context to acquire starts it,
// the last to release stops it, and the first acquirer's deps (the same server log for every context)
// are the ones it runs with.
let shared: { refs: number; stop: () => void } | null = null

export function acquireSharedOrphanReaper(deps: SweepDeps & { intervalMs?: number } = {}): () => void {
  if (!shared) shared = { refs: 0, stop: startOrphanReaper(deps) }
  const handle = shared
  handle.refs++
  let released = false
  return () => {
    if (released) return
    released = true
    handle.refs--
    if (handle.refs === 0 && shared === handle) {
      shared = null
      handle.stop()
    }
  }
}
