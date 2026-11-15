// WHAT A RESTART IS DOING, AS THE PAGE DRAWS IT (2026-11-15).
//
// The recovery page used to say "The application server is coming back up" and "Waiting for Frizz"
// for as long as a restart took, which on 2026-11-15 was almost ten minutes of a 350 MB Codex download
// nobody could see. The launcher already read the boot's progress file to decide how patient to be; it
// now also turns it into a checklist: what stopped, each runtime on disk or downloading (bytes, speed,
// time left), the threads loading. The same view rides on /_frizz/control/status, where the recovery
// page (supervisor-pages.ts) and the board's own restart overlay and update button draw it.
//
// It is derived HERE, in TypeScript on the launcher's side, rather than in each surface, because the
// recovery page's script is an inline string with no imports and the board is a separate bundle: one
// derivation, two renderers that only lay out what they are given. Everything a surface shows as text
// is decided here, house duration grammar included (`5m`, `3m 12s`).
import type { BootProgress, BootRuntime } from "./boot-progress.ts"

import type { BootView, BootViewKind, BootViewStep, RuntimeDownloadChip } from "@frizz/shared"
import type { RuntimeDownload } from "./runtimes.ts"

export type { BootView, BootViewKind, BootViewStep, RuntimeDownloadChip }

export interface BootViewInput {
  kind: BootViewKind
  /** The release being installed, for an update. */
  version?: string
  startedAt: number
  now: number
  /** The server this restart stopped: its version and how long the stop took, or "stopping" while it runs. */
  stopped?: { version?: string; ms: number } | "stopping"
  /** The booting server's progress file (only this boot's: the caller checks the pid). */
  progress: BootProgress | null
  openNowRequested?: boolean
  /** For a download ahead of an update: whether the release's own package is installed yet. */
  installed?: boolean
  /** For a download ahead of an update: the runtimes it is fetching, in the same shape a boot reports. */
  runtimes?: Partial<Record<"claude" | "codex", BootRuntime>>
  platform?: NodeJS.Platform
}

/** A download expected to take longer than this is worth an "Open Frizz now". */
const SLOW_DOWNLOAD_MS = 60_000

const RUNTIME_NAMES = { claude: "Claude Code", codex: "Codex" } as const

/** House grammar, two units at most: `24s`, `3m 12s`, `1h 05m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** A time left, one unit and rounded up so it does not promise early: `40s`, `5m`, `1h 10m`. */
export function formatRemaining(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(0, Math.round(bytes / 1000))} KB`
  return `${Math.round(bytes / 1_000_000)} MB`
}

/** `212 of 348 MB`, with the unit once when both sides share it. */
export function formatOf(received: number, total: number): string {
  if (received >= 1_000_000 && total >= 1_000_000) return `${Math.round(received / 1_000_000)} of ${formatBytes(total)}`
  return `${formatBytes(received)} of ${formatBytes(total)}`
}

/** A short step's duration: `900ms`, `1s`, `2m 05s`. */
export function formatStepDuration(ms: number): string {
  return ms < 1000 ? `${Math.max(100, Math.round(ms / 100) * 100)}ms` : formatElapsed(ms)
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1_000_000) return `${Math.max(1, Math.round(bytesPerSecond / 1000))} KB/s`
  return `${(bytesPerSecond / 1_000_000).toFixed(bytesPerSecond < 10_000_000 ? 1 : 0)} MB/s`
}

const count = new Intl.NumberFormat("en-US")

/** The time a download has left, or undefined while there is no speed to judge it by. */
function remainingMs(runtime: BootRuntime): number | undefined {
  if (!runtime.total || !runtime.bytesPerSecond) return undefined
  return ((runtime.total - (runtime.received ?? 0)) * 1000) / runtime.bytesPerSecond
}

function runtimeStep(backend: "claude" | "codex", runtime: BootRuntime, platform: NodeJS.Platform): BootViewStep | undefined {
  const base = { key: backend, label: RUNTIME_NAMES[backend], ...(runtime.label ? { version: runtime.label } : {}) }
  const received = runtime.received ?? 0
  const total = runtime.total ?? 0
  const fraction = total > 0 ? Math.min(1, received / total) : undefined
  const percent = fraction === undefined ? undefined : `${Math.min(99, Math.floor(fraction * 100))}%`
  switch (runtime.state) {
    case "deferred":
      // Signed out of this backend: it waits for its first thread, and nothing here waits on it.
      return undefined
    case "checking":
      return { ...base, state: "live", note: "checking" }
    case "resolving":
      return { ...base, label: `Downloading ${base.label}`, state: "live", note: "connecting" }
    case "downloading": {
      const left = remainingMs(runtime)
      const parts = [total > 0 ? formatOf(received, total) : `${formatBytes(received)} so far`]
      if (runtime.bytesPerSecond) parts.push(formatSpeed(runtime.bytesPerSecond))
      if (left !== undefined) parts.push(`about ${formatRemaining(left)} left`)
      return { ...base, label: `Downloading ${base.label}`, state: "live", ...(percent ? { note: percent } : {}), ...(fraction !== undefined ? { fraction } : {}), meta: parts.join(" · ") }
    }
    case "stalled":
      return {
        ...base,
        label: `Downloading ${base.label}`,
        state: "stalled",
        ...(percent ? { note: percent } : {}),
        ...(fraction !== undefined ? { fraction } : {}),
        meta: `No data for ${formatElapsed(runtime.stalledForMs ?? 0)} · ${formatBytes(received)} kept`,
      }
    case "unpacking":
      return { ...base, label: `Unpacking ${base.label}`, state: "live", note: "unpacking", fraction: 1 }
    case "ready":
      return { ...base, state: "done", note: runtime.fetched ? "downloaded" : platform === "darwin" ? "on this Mac" : "on this machine" }
    case "background":
      return { ...base, state: "done", note: "finishing in the background" }
    case "path":
      return { ...base, state: "done", note: "from PATH" }
  }
}

/** What an older server's file says, which is a phrase: `runtimes: codex downloading 348 MB, 61%`. */
function runtimesFromPhase(phase: string): Partial<Record<"claude" | "codex", BootRuntime>> {
  const match = /^runtimes: (claude|codex) (.*)$/u.exec(phase)
  if (!match) return {}
  const backend = match[1] as "claude" | "codex"
  const words = match[2]!
  const downloading = /^downloading(?: (\d+) MB)?(?:, (\d+)%)?/u.exec(words)
  if (downloading) {
    const total = downloading[1] ? Number(downloading[1]) * 1_000_000 : 0
    const received = total && downloading[2] ? (total * Number(downloading[2])) / 100 : 0
    return { [backend]: { label: "", state: "downloading", received, total } }
  }
  if (words === "ready") return { [backend]: { label: "", state: "ready", fetched: true } }
  if (words.startsWith("resolving")) return { [backend]: { label: "", state: "resolving" } }
  return {}
}

export function bootView(input: BootViewInput): BootView {
  const platform = input.platform ?? process.platform
  const steps: BootViewStep[] = []
  const elapsedMs = Math.max(0, input.now - input.startedAt)

  if (input.kind === "prepare") {
    steps.push({ key: "release", label: "Frizz", ...(input.version ? { version: input.version } : {}), ...(input.installed === false ? { state: "live", note: "installing" } : { state: "done", note: "installed" }) })
    for (const backend of ["claude", "codex"] as const) {
      const runtime = input.runtimes?.[backend]
      const step = runtime && runtimeStep(backend, runtime, platform)
      if (step) steps.push(step)
    }
    return { kind: "prepare", title: input.version ? `Getting ${input.version} ready` : "Getting the update ready", elapsedMs, steps, openNow: false }
  }

  const title = input.kind === "update"
    ? (input.version ? `Updating Frizz to ${input.version}` : "Updating Frizz")
    : input.kind === "start" ? "Starting Frizz" : "Restarting Frizz"
  if (input.stopped === "stopping") {
    steps.push({ key: "stop", label: "Stopping the server", state: "live" })
  } else if (input.stopped) {
    steps.push({ key: "stop", label: input.stopped.version ? "Stopped" : "Stopped the server", ...(input.stopped.version ? { version: input.stopped.version } : {}), state: "done", note: formatStepDuration(input.stopped.ms) })
  }

  const progress = input.progress
  const detail = progress?.detail
  const runtimes = detail?.runtimes ?? (progress ? runtimesFromPhase(progress.phase) : {})
  let waitingOnRuntimes = false
  const downloading: string[] = []
  let openNow = false
  let hint: BootView["hint"]
  for (const backend of ["claude", "codex"] as const) {
    const runtime = runtimes[backend]
    if (!runtime) continue
    const step = runtimeStep(backend, runtime, platform)
    if (!step) continue
    steps.push(step)
    if (step.state === "live" || step.state === "stalled") waitingOnRuntimes = true
    if (["resolving", "downloading", "stalled", "unpacking"].includes(runtime.state)) downloading.push(RUNTIME_NAMES[backend])
    if (runtime.state === "stalled") {
      openNow = true
      hint = "stalled"
    } else if (runtime.state === "downloading") {
      const left = remainingMs(runtime)
      if (left !== undefined && left > SLOW_DOWNLOAD_MS) {
        openNow = true
        hint ??= "slow"
      }
    }
  }
  // Only a server that reads the request is offered the button (an older one would never open).
  if (!detail?.openNow) {
    openNow = false
    hint = undefined
  }

  if (!progress) {
    // Forked, and not far enough into its boot to say anything yet.
    steps.push({ key: "start", label: "Starting the server", state: "live" })
  } else {
    const threads = detail?.threads ?? (() => {
      const match = /^tailer producer (\d+)\/(\d+)$/u.exec(progress.phase)
      return match ? { done: Number(match[1]), total: Number(match[2]) } : undefined
    })()
    const pastRuntimes = !waitingOnRuntimes && progress.phase !== "launch ownership" && progress.phase !== "runtimes" && !progress.phase.startsWith("runtimes:")
    steps.push({
      key: "threads",
      label: "Load threads",
      state: pastRuntimes ? "live" : "todo",
      ...(pastRuntimes && threads && threads.total > 0
        ? { note: `${count.format(threads.done)} of ${count.format(threads.total)}`, fraction: Math.min(1, threads.done / threads.total) }
        : {}),
    })
  }

  const opening = input.openNowRequested === true && waitingOnRuntimes
  const offered = openNow && !input.openNowRequested
  return {
    kind: input.kind,
    title,
    elapsedMs,
    steps,
    openNow: offered,
    ...(openNow && hint ? { hint } : {}),
    ...(opening ? { opening: true } : {}),
    ...(downloading.length > 0 ? { downloading } : {}),
    ...(opening || offered ? { callout: openNowCallout(opening ? "opening" : hint ?? "slow", downloading) } : {}),
  }
}

/** `Codex`, `Claude Code and Codex`. */
function listNames(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

function openNowCallout(why: "opening" | "slow" | "stalled", downloading: string[]): NonNullable<BootView["callout"]> {
  const names = listNames(downloading)
  if (why === "opening") return { text: `Opening Frizz. ${names || "The download"} keeps downloading in the background.` }
  if (why === "stalled") {
    return {
      lead: "The download stopped receiving data.",
      text: "It picks up where it stopped when the connection comes back. Frizz can open without it in the meantime.",
    }
  }
  return {
    lead: "This connection is slow.",
    text: `Frizz can open now and finish ${names || "the download"} in the background. ${
      downloading.length === 1 ? `A new ${names} thread waits for it; everything else works right away.` : "A new thread on either waits for its download."
    }`,
  }
}

/**
 * The downloads a server is finishing after it opened without them (runtime-deferral.ts
 * runtimeDownloadStates), as the status row's chip draws them. A download that has landed is gone.
 */
export function runtimeDownloadChips(downloads: Partial<Record<"claude" | "codex", RuntimeDownload>>): RuntimeDownloadChip[] {
  const chips: RuntimeDownloadChip[] = []
  for (const backend of ["claude", "codex"] as const) {
    const download = downloads[backend]
    if (!download || download.state === "ready") continue
    const name = RUNTIME_NAMES[backend]
    const runtime: BootRuntime = { label: download.label, state: download.state, received: download.received, total: download.total, bytesPerSecond: download.bytesPerSecond, stalledForMs: download.stalledForMs }
    const step = runtimeStep(backend, runtime, process.platform)!
    const left = download.state === "downloading" ? remainingMs(runtime) : undefined
    const reading = download.state === "stalled"
      ? "stalled"
      : download.state === "resolving"
        ? "connecting"
        : download.state === "unpacking"
          ? "unpacking"
          : [step.note, left !== undefined ? formatRemaining(left) : undefined].filter(Boolean).join(" · ") || "starting"
    const waits = `A new ${name} thread waits for it.`
    chips.push({
      backend,
      name,
      state: download.state === "stalled" ? "stalled" : "live",
      ...(step.fraction !== undefined ? { fraction: step.fraction } : {}),
      reading,
      detail: `${step.label} ${download.label}${step.meta ? `: ${step.meta}` : ""}. ${waits}`,
    })
  }
  return chips
}
