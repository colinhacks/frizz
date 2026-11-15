import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

// ── Boot progress, published for the launcher ──────────────────────────────────────────────────────
// A launcher spawns the control plane DETACHED and then waits for /health. Until this existed the wait
// was a flat 30s deadline against a process it could not see inside: a boot that was working fine but
// slow (a first-ever boot of a large board, or any boot on a loaded machine) hit the deadline, the
// launcher printed "Frizz did not become healthy", and the child carried on booting and bound the port —
// so the operator got an error AND a stray control plane contending with their next attempt.
//
// The child now names what it is doing, as it does it. That converts the launcher's question from
// "has 30 seconds elapsed?" (which says nothing about whether anything is wrong) to "has this boot
// stopped making progress?" (which is the actual failure), and lets the give-up message say where it
// got stuck instead of just how long it waited.
//
// Transient IPC, not durable state: written without fsync, removed once the server is listening, and
// every read/write is best-effort. A missing or unparseable file simply means "no progress signal",
// which degrades the launcher to its historical flat deadline.

export const BOOT_PROGRESS_NAME = "boot.progress"
export const BOOT_STALL_TIMEOUT_MS = 30_000
/** Progress buys patience, but even a continuously reporting boot must eventually finish. */
export const BOOT_HARD_TIMEOUT_MS = 10 * 60_000

/** Where one backend's executable stands during a boot, for the restart page's checklist. */
export type BootRuntimeState =
  /** Looking for the pin on disk. */
  | "checking"
  /** Asking the registry for the pin. */
  | "resolving"
  | "downloading"
  /** No data for a while; the download is reconnecting. */
  | "stalled"
  | "unpacking"
  /** On disk and ready. `fetched` says whether this boot downloaded it. */
  | "ready"
  /** The board opened before the download finished; it carries on in the background. */
  | "background"
  /** Waits for its first thread (a backend this machine is signed out of). */
  | "deferred"
  /** Could not be provisioned; the bare name on PATH runs instead. */
  | "path"

export interface BootRuntime {
  /** The version, e.g. "2.1.325". Empty for an executable the operator named. */
  label: string
  state: BootRuntimeState
  fetched?: boolean
  received?: number
  total?: number
  bytesPerSecond?: number
  stalledForMs?: number
  resumedFrom?: number
}

/**
 * What a boot is doing, as numbers rather than a phrase. Written by servers from 2026-11-15 on; a
 * launcher reading an older server's file finds only `phase` and reads that instead.
 */
export interface BootDetail {
  runtimes?: Partial<Record<"claude" | "codex", BootRuntime>>
  /** The tailer's first pass, which is most of a large board's boot. */
  threads?: { done: number; total: number }
  /** This boot honours BOOT_OPEN_NOW_NAME while it waits on a runtime download. */
  openNow?: boolean
}

export interface BootProgress {
  /** The publishing process, so a launcher can tell a live boot from a leftover file. */
  pid: number
  /** Monotonically increasing within one boot; the launcher treats any increase as progress. */
  step: number
  /** Human-readable phase, e.g. "tailer producer 1200/5000". */
  phase: string
  /** ISO8601 publication instant. */
  at: string
  detail?: BootDetail
}

export function bootProgressPath(stateDir: string): string {
  return join(stateDir, BOOT_PROGRESS_NAME)
}

export function readBootProgress(stateDir: string): BootProgress | null {
  try {
    const value = JSON.parse(readFileSync(bootProgressPath(stateDir), "utf8")) as Partial<BootProgress>
    if (
      !Number.isInteger(value.pid) || !Number.isInteger(value.step) ||
      typeof value.phase !== "string" || typeof value.at !== "string"
    ) return null
    if (value.detail !== undefined && (typeof value.detail !== "object" || value.detail === null)) delete value.detail
    return value as BootProgress
  } catch {
    return null
  }
}

export interface BootProgressPublisher {
  /** Record that the boot has reached `phase`. Rate-limited; a phase CHANGE always publishes. */
  (phase: string): void
  /**
   * Merge `patch` into the boot's detail and publish it under the current phase. Rate-limited like a
   * phase, except that a runtime changing STATE always publishes: "ready" must never be dropped.
   */
  detail(patch: BootDetail): void
  /** Remove the file — the boot is over, one way or the other. Nothing is published after it. */
  done(): void
}

/**
 * A publisher for one boot. `minIntervalMs` throttles same-phase updates (the tailer's first pass
 * reports its row counter continuously) without ever suppressing a phase transition.
 */
export function createBootProgressPublisher(stateDir: string | undefined, minIntervalMs = 200): BootProgressPublisher {
  if (!stateDir) {
    const inert = Object.assign(() => {}, { detail: () => {}, done: () => {} })
    return inert
  }
  const path = bootProgressPath(stateDir)
  let step = 0
  let lastKey = ""
  let lastAt = 0
  let phase = ""
  let detail: BootDetail = {}
  // A write after done() would put a finished boot's file back, and a launcher waiting on the NEXT boot
  // of this project would read it. Nothing is published once the boot is over.
  let finished = false
  // What has to publish even inside the rate limit: a new phase, or a runtime reaching a new state.
  const keyOf = () => `${phase}|${Object.entries(detail.runtimes ?? {}).map(([backend, runtime]) => `${backend}:${runtime?.state}`).join(",")}`
  const write = () => {
    if (finished) return
    const now = Date.now()
    const key = keyOf()
    if (key === lastKey && now - lastAt < minIntervalMs) return
    lastKey = key
    lastAt = now
    step++
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
      const record: BootProgress = { pid: process.pid, step, phase, at: new Date(now).toISOString(), ...(Object.keys(detail).length > 0 ? { detail } : {}) }
      writeFileSync(temp, `${JSON.stringify(record)}\n`, "utf8")
      renameSync(temp, path)
    } catch {
      // Progress is an optimization for the launcher's patience; never a boot dependency.
    }
  }
  return Object.assign((next: string) => { phase = next; write() }, {
    detail: (patch: BootDetail) => {
      detail = {
        ...detail,
        ...patch,
        ...(patch.runtimes ? { runtimes: { ...detail.runtimes, ...patch.runtimes } } : {}),
      }
      write()
    },
    done: () => {
      finished = true
      try {
        rmSync(path, { force: true })
      } catch {
        // A leftover file is inert: its pid is checked, and a stale one simply stops advancing.
      }
    },
  })
}

/**
 * Is this boot waiting on a runtime download? The launcher's ten-minute cap on a boot does not count
 * that time: a slow connection is not a wedged server, and killing the boot only started the download
 * over (2026-11-15). The stall window still applies, and a download that hears nothing for minutes
 * fails on its own (runtimes.ts), so this cannot keep a dead boot alive. An older server's file has
 * no detail, only its `runtimes: claude downloading 320 MB, 40%` phases.
 */
export function bootIsDownloading(progress: BootProgress | null): boolean {
  if (!progress) return false
  const runtimes = progress.detail?.runtimes
  if (runtimes) return Object.values(runtimes).some((runtime) => runtime !== undefined && ["resolving", "downloading", "stalled", "unpacking"].includes(runtime.state))
  return progress.phase.startsWith("runtimes:")
}

// ── "Open Frizz now" ─────────────────────────────────────────────────────────────────────────────────
// The restart page's escape hatch from a slow download. The launcher cannot reach a booting server
// over HTTP (it is not listening yet), so it leaves a request file naming the boot it is meant for,
// and the boot reads it while it waits on its runtimes. Naming the pid means a request left behind by
// an earlier boot is never honoured by a later one.

export const BOOT_OPEN_NOW_NAME = "boot.open-now"

export function requestBootOpenNow(stateDir: string, pid: number): void {
  const path = join(stateDir, BOOT_OPEN_NOW_NAME)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify({ pid, at: new Date().toISOString() })}\n`, "utf8")
}

export function bootOpenNowRequested(stateDir: string, pid: number): boolean {
  try {
    return (JSON.parse(readFileSync(join(stateDir, BOOT_OPEN_NOW_NAME), "utf8")) as { pid?: unknown }).pid === pid
  } catch {
    return false
  }
}

export function clearBootOpenNow(stateDir: string): void {
  rmSync(join(stateDir, BOOT_OPEN_NOW_NAME), { force: true })
}

/** Watch for a request aimed at `pid`. `requested` settles when one arrives; `stop()` ends the watch. */
export function watchBootOpenNow(stateDir: string, pid: number, intervalMs = 250): { requested: Promise<void>; stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined
  const requested = new Promise<void>((resolve) => {
    timer = setInterval(() => {
      if (!bootOpenNowRequested(stateDir, pid)) return
      clearInterval(timer)
      try { clearBootOpenNow(stateDir) } catch { /* the request was read; leaving the file is harmless */ }
      resolve()
    }, intervalMs)
    timer.unref?.()
  })
  return { requested, stop: () => clearInterval(timer) }
}
