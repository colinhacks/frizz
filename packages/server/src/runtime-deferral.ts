// A RUNTIME THAT WAITS FOR ITS FIRST THREAD.
//
// A machine signed out of both Claude and Codex with OpenCode on PATH has no use for either runtime
// yet, and first boot used to cost it 698 MB and a Claude Code start that wrote `~/.claude` under its
// HOME. A machine signed out of Codex alone has no use for Codex's, and that is most of them. So
// runtimes.ts registers such a pin here instead of fetching it (shouldDeferRuntimes says which), and the
// first dispatch or cold resume on that backend brings it down through ensureRuntime.
//
// The bin every consumer holds is a plain string, captured all over the context, so it does not change:
// it is the path the pin will have once it lands (runtimes.ts pinnedBinaryPath). What changes is whether
// anything may run it. A reader that would start the binary on its own, such as the model catalogue or
// the signed-out confirmation, asks isRuntimeDeferred first, and that holds even when an earlier server
// left the pin on disk.
//
// Fs-free and dependency-free, because auth-status.ts and claude-models.ts read it and runtimes.ts pulls
// in the provisioner. One process serves every project and holds one pin per backend, so module state
// is the right scope.

import type { RuntimeDownload } from "./runtimes.ts"

export type DeferredBackend = "claude" | "codex"

type Provision = (onProgress: (message: string) => void, onDownload?: (download: RuntimeDownload) => void) => Promise<void>

interface Deferred {
  provision: Provision
  inFlight?: Promise<void>
  /** The provisioner's latest word, while a download runs. */
  progress?: string
  /** The same, as numbers. */
  download?: RuntimeDownload
}

const deferred = new Map<DeferredBackend, Deferred>()

export function deferRuntime(backend: DeferredBackend, provision: Provision): void {
  deferred.set(backend, { provision })
}

/**
 * A pin whose download was already running when the boot stopped waiting for it ("Open Frizz now"):
 * it becomes a deferred pin whose first need awaits THIS download rather than starting a second one.
 * Returns where that download should report from now on. A download that fails leaves the backend
 * deferred, so its first thread tries again, exactly as a deferred pin's own failure does.
 */
export function adoptRuntimeDownload(backend: DeferredBackend, provision: Provision, running: Promise<void>): {
  progress: (message: string) => void
  download: (download: RuntimeDownload) => void
} {
  const entry: Deferred = { provision }
  deferred.set(backend, entry)
  entry.inFlight = running
    .then(() => { if (deferred.get(backend) === entry) deferred.delete(backend) })
    .finally(() => {
      entry.inFlight = undefined
      entry.progress = undefined
      entry.download = undefined
    })
  // Nobody may be waiting on it yet; its rejection is answered by the next ensureRuntime.
  entry.inFlight.catch(() => {})
  return {
    progress: (message) => { if (entry.inFlight) entry.progress = message },
    download: (download) => { if (entry.inFlight) entry.download = download },
  }
}

/** True until this backend's first need has brought its pin down. */
export function isRuntimeDeferred(backend: DeferredBackend): boolean {
  return deferred.has(backend)
}

/**
 * Bring a deferred pin down, or return at once when the backend is not waiting on one. Callers that
 * arrive together share one download. A failure rejects and leaves the backend deferred, so the next
 * dispatch tries again.
 */
export function ensureRuntime(backend: DeferredBackend): Promise<void> {
  const entry = deferred.get(backend)
  if (!entry) return Promise.resolve()
  entry.inFlight ??= entry.provision((message) => { entry.progress = message }, (download) => { entry.download = download })
    .then(() => { deferred.delete(backend) })
    .finally(() => {
      entry.inFlight = undefined
      entry.progress = undefined
      entry.download = undefined
    })
  return entry.inFlight
}

/** What each download is doing right now, for the composer's toast. Empty when nothing is downloading. */
export function runtimeDownloads(): Partial<Record<DeferredBackend, string>> {
  const out: Partial<Record<DeferredBackend, string>> = {}
  for (const [backend, entry] of deferred) if (entry.inFlight && entry.progress) out[backend] = entry.progress
  return out
}

/** The same downloads as numbers, for the board's download chip. Empty when nothing is downloading. */
export function runtimeDownloadStates(): Partial<Record<DeferredBackend, RuntimeDownload>> {
  const out: Partial<Record<DeferredBackend, RuntimeDownload>> = {}
  for (const [backend, entry] of deferred) if (entry.inFlight && entry.download) out[backend] = entry.download
  return out
}

/** Test seam: forget every deferred runtime. */
export function resetDeferredRuntimes(): void {
  deferred.clear()
}
