// A SERVER MOVES TO THE NEWEST CLAUDE CODE ON ITS LINE, WITHOUT A FRIZZ RELEASE.
//
// Each frizz-server release bundles one Claude Code build (CLAUDE_CODE_VERSION in runtimes.ts), and
// until 2026-11-09 that build was the only one a server ran. A model edition reaches a user only
// through the binary — `--model fable` is the alias, and the binary decides it means claude-fable-5-2
// (2.1.321) rather than 5.1 (2.1.319) — so a new edition waited on a pin bump, a release, npm's
// review and the user's click on Update. The maintainer chose to float instead (2026-11-09).
//
// What floats, and what does not:
//
//   - The LINE is the bundled build's `major.minor`. A 2.1.x server takes every 2.1.x Anthropic tags
//     `latest`, and never a 2.2.0, which waits for a release that bundles it. Every Claude Code
//     release so far has been a 2.1.x, so in practice this is "every release".
//   - The FLOOR is the bundled build. When npm's `latest` moves back (a pulled release), the server
//     follows it down, but never below what it shipped with.
//   - The SDK does not float. The bundled Agent SDK drives the newer CLI over its control protocol,
//     which is why a build is adopted only after that SDK has spoken to it (verifyClaudeBuild).
//
// How a server moves: a check an hour (the first a minute after boot) reads `latest` for this
// platform's `@anthropic-ai/claude-code-<platform>` package, provisions that build beside the bundled
// one (runtimes.ts provisionRuntime: integrity-checked, renamed into place whole), verifies it, then
// swaps the server's `runtimes.claude`. Everything that starts Claude Code reads that through a getter
// (index.ts, context.ts), so the NEXT fork, resume, model probe or quota read runs the new build, and
// every daemon already running keeps the build it was forked on, held against the sweep by its lease.
// The verified label goes into `<root>/claude-float.json`, so a restart boots straight onto it from
// disk (runtimes.ts readClaudeFloat) instead of starting on the bundled build and fetching again.
//
// A build that fails verification is not retried for a day, and the server stays where it was.
// `FRIZZ_CLAUDE_FLOAT=0` keeps a server on its bundled build. An explicit executable, `FRIZZ_RUNTIMES=
// path` and a runtime still waiting for its first thread never float (index.ts starts this only for a
// provisioned Claude Code).

import { execFile } from "node:child_process"
import { tmpdir } from "node:os"
import { probeClaudeModels } from "./backend/claude-models.ts"
import { leaseRuntime } from "./runtime-lease.ts"
import {
  CLAUDE_CODE_VERSION, claudeReleaseCoordinates, isLaterOnLine, parseReleaseVersion, provisionRuntime, provisionedBinary,
  runtimeCoordinates, sweepSuperseded, writeClaudeFloat, type ResolvedRuntime, type RuntimeCoordinates,
} from "./runtimes.ts"

const REGISTRY = "https://registry.npmjs.org"
export const CLAUDE_FLOAT_FIRST_CHECK_MS = 60_000
export const CLAUDE_FLOAT_INTERVAL_MS = 60 * 60_000
/** How long a build that failed verification is left alone before it is tried again. */
export const CLAUDE_FLOAT_RETRY_MS = 24 * 60 * 60_000
const VERSION_TIMEOUT_MS = 30_000

type Fetch = typeof globalThis.fetch

function packageUrl(registry: string, pkg: string, suffix = ""): string {
  return `${registry}/${pkg.replace("/", "%2F")}${suffix}`
}

/**
 * The Claude Code this server should run: npm's `latest` for this platform's binary package when it is
 * on the bundled build's line and not below it, else the newest release on that line, else the
 * bundled build itself. Throws when the registry cannot be read, which the caller treats as "stay".
 */
export async function resolveClaudeFloatTarget(options: {
  coordinates: RuntimeCoordinates
  bundled?: string
  fetch?: Fetch
  registry?: string
}): Promise<string> {
  const bundled = options.bundled ?? CLAUDE_CODE_VERSION
  const fetchImpl = options.fetch ?? globalThis.fetch
  const registry = options.registry ?? REGISTRY
  const latestResponse = await fetchImpl(packageUrl(registry, options.coordinates.pkg, "/latest"))
  if (!latestResponse.ok) throw new Error(`registry answered ${latestResponse.status} for ${options.coordinates.pkg}@latest`)
  const latest = ((await latestResponse.json()) as { version?: unknown }).version
  if (typeof latest !== "string" || !parseReleaseVersion(latest)) throw new Error(`registry named no release version for ${options.coordinates.pkg}@latest`)
  if (isLaterOnLine(latest, bundled)) return latest
  const [major, minor] = parseReleaseVersion(latest)!
  const [bMajor, bMinor] = parseReleaseVersion(bundled) ?? [0, 0]
  // `latest` at or below the bundled build, on its line or an older one: the floor holds.
  if (major < bMajor || (major === bMajor && minor <= bMinor)) return bundled
  // `latest` has left the line (a 2.2.0): the newest release still on it, if any is past the floor.
  const packument = await fetchImpl(packageUrl(registry, options.coordinates.pkg), { headers: { accept: "application/vnd.npm.install-v1+json" } })
  if (!packument.ok) throw new Error(`registry answered ${packument.status} for ${options.coordinates.pkg}`)
  const versions = Object.keys(((await packument.json()) as { versions?: Record<string, unknown> }).versions ?? {})
  let best = bundled
  for (const version of versions) if (isLaterOnLine(version, best)) best = version
  return best
}

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, env: { ...process.env, DISABLE_AUTOUPDATER: "1" } }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${bin} ${args.join(" ")} failed: ${(stderr || error.message).trim().split("\n")[0]}`))
      else resolve(stdout)
    })
  })
}

/**
 * Prove a downloaded build can serve before anything starts on it: it names itself as the version it
 * was fetched as, and the bundled SDK can open a session on it and read its model list (a control
 * request the CLI answers locally: no API call, no session file). The second is the check that matters,
 * because the SDK does not float with the CLI.
 */
export async function verifyClaudeBuild(bin: string, label: string, cwd: string = tmpdir()): Promise<void> {
  const version = (await run(bin, ["--version"], VERSION_TIMEOUT_MS)).trim()
  if (!version.startsWith(`${label} `) && version !== label) throw new Error(`it names itself "${version}", not ${label}`)
  const models = await probeClaudeModels(bin, cwd)
  if (!models.some((model) => model.edition)) throw new Error("the bundled SDK read no model from it")
}

export interface ClaudeFloatDeps {
  root: string
  /** The server's Claude Code right now. */
  current: () => ResolvedRuntime
  /** Make `runtime` the server's Claude Code: the next fork, probe and quota read use it. */
  adopt: (runtime: ResolvedRuntime) => void
  log: (level: "info" | "warn", message: string) => void
  bundled?: string
  fetch?: Fetch
  registry?: string
  verify?: (bin: string, label: string) => Promise<void>
  now?: () => number
  /** Seam for a test: where the bundled build's coordinates come from. */
  bundledCoordinates?: RuntimeCoordinates
  /** Seam for a test: the coordinates of a release. */
  releaseCoordinates?: (version: string) => RuntimeCoordinates | undefined
}

export type ClaudeFloatOutcome =
  | { state: "current"; version: string }
  | { state: "moved"; from: string; to: string }
  | { state: "held"; version: string; reason: string }
  | { state: "unavailable"; reason: string }

export interface ClaudeFloat {
  /** One check, start to finish. Concurrent calls share the one in flight. Never throws. */
  check(): Promise<ClaudeFloatOutcome>
  start(firstCheckMs?: number, intervalMs?: number): void
  stop(): void
}

export function createClaudeFloat(deps: ClaudeFloatDeps): ClaudeFloat {
  const bundled = deps.bundled ?? CLAUDE_CODE_VERSION
  const now = deps.now ?? Date.now
  const verify = deps.verify ?? ((bin: string, label: string) => verifyClaudeBuild(bin, label))
  const releaseCoordinates = deps.releaseCoordinates ?? ((version: string) => claudeReleaseCoordinates(version))
  const failed = new Map<string, number>()
  let inFlight: Promise<ClaudeFloatOutcome> | undefined
  let firstTimer: NodeJS.Timeout | undefined
  let interval: NodeJS.Timeout | undefined
  let lastUnavailable: string | undefined

  const adopt = (bin: string, label: string, from: string): ClaudeFloatOutcome => {
    // Lease the new build before this server's lease on the old one goes, so no sweep sees neither.
    // A lease is a file per pid, so re-leasing the old build hands back the release for the one the
    // boot (or the last move) wrote. Daemons forked on the old build hold leases of their own.
    const previous = deps.current().bin
    leaseRuntime(bin, "server")
    if (previous !== bin) leaseRuntime(previous, "server")()
    deps.adopt({ bin, source: "provisioned", version: label, ...(label === bundled ? {} : { note: `moved past the bundled ${bundled}` }) })
    writeClaudeFloat(deps.root, label === bundled ? undefined : label)
    sweepSuperseded("claude", deps.root, label === bundled ? bundled : [bundled, label], { log: deps.log })
    deps.log("info", `runtimes: claude moved from ${from} to ${label}; new threads start on it, running ones keep their build`)
    return { state: "moved", from, to: label }
  }

  const once = async (): Promise<ClaudeFloatOutcome> => {
    const from = deps.current().version
    const bundledCoordinates = deps.bundledCoordinates ?? runtimeCoordinates("claude")
    const probeCoordinates = releaseCoordinates(bundled)
    if (!bundledCoordinates || !probeCoordinates) return { state: "unavailable", reason: `no Claude Code build is published for ${process.platform}-${process.arch}` }
    let target: string
    try {
      target = await resolveClaudeFloatTarget({ coordinates: probeCoordinates, bundled, fetch: deps.fetch, registry: deps.registry })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // Offline is the ordinary case for a laptop, so it is logged once per distinct failure.
      if (reason !== lastUnavailable) deps.log("warn", `runtimes: could not check npm for a newer Claude Code (${reason}); staying on ${from}`)
      lastUnavailable = reason
      return { state: "unavailable", reason }
    }
    lastUnavailable = undefined
    if (target === from) return { state: "current", version: from }
    const failedAt = failed.get(target)
    if (failedAt !== undefined && now() - failedAt < CLAUDE_FLOAT_RETRY_MS) return { state: "held", version: from, reason: `${target} failed verification` }
    const coordinates = target === bundled ? bundledCoordinates : releaseCoordinates(target)!
    try {
      const provisioned = provisionedBinary("claude", deps.root, coordinates.label)
        ?? (await provisionRuntime("claude", { root: deps.root, coordinates, fetch: deps.fetch, registry: deps.registry })).bin
      // The bundled build was verified by the release that shipped it; a fetched one is checked here.
      if (target !== bundled) await verify(provisioned, target)
      failed.delete(target)
      return adopt(provisioned, target, from)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      failed.set(target, now())
      deps.log("warn", `runtimes: Claude Code ${target} was not adopted (${reason}); staying on ${from}, and trying it again in a day`)
      return { state: "held", version: from, reason }
    }
  }

  const check = (): Promise<ClaudeFloatOutcome> => {
    inFlight ??= once()
      .catch((err: unknown): ClaudeFloatOutcome => ({ state: "unavailable", reason: err instanceof Error ? err.message : String(err) }))
      .finally(() => { inFlight = undefined })
    return inFlight
  }

  return {
    check,
    start(firstCheckMs = CLAUDE_FLOAT_FIRST_CHECK_MS, intervalMs = CLAUDE_FLOAT_INTERVAL_MS) {
      if (firstTimer || interval) return
      firstTimer = setTimeout(() => {
        firstTimer = undefined
        void check()
        interval = setInterval(() => void check(), intervalMs)
        interval.unref?.()
      }, firstCheckMs)
      firstTimer.unref?.()
    },
    stop() {
      if (firstTimer) clearTimeout(firstTimer)
      if (interval) clearInterval(interval)
      firstTimer = undefined
      interval = undefined
    },
  }
}
