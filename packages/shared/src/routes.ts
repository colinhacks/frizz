// Frizz's route prefix and ports. Their own module, apart from the shared index, so the launcher reads
// them without bundling zod, yaml and the index's schemas (plans/shell-release-cadence.md).

/**
 * Everything Frizz itself serves lives under this prefix, so the top level stays free for the project
 * routes (`/project/<slug>`) and for the SPA's own route names. Without a reserved namespace the
 * deny-list is a growing list of route names that breaks the day someone clones a repo called
 * `settings`.
 *
 * One constant, exported to both sides, because a server route and the client URL that calls it
 * drifting apart is a 404 that looks like a hung request. The client end is `apiBase()`
 * (web/src/lib/base-path.ts), which appends the project slug; ARCHITECTURE.md § URL shape has the map.
 *
 * (This docstring sat ~80 lines up the file, stacked on ProjectCard's own, until 2026-08-07 — which is
 * why nothing here said where the client half lived.)
 */
export const FRIZZ_ROUTE_PREFIX = "/_frizz"
export function frizzRoute(path: string): string {
  return `${FRIZZ_ROUTE_PREFIX}${path.startsWith("/") ? path : `/${path}`}`
}

/**
 * `http://localhost:9393`.
 *
 * Unassigned in the IANA registry on both TCP and UDP — its neighbours `9390` (OpenVAS) and `9396`
 * are registered and it is not — clear of both Chromium's and Firefox's blocklists (the highest port
 * either blocks is 10080), no dev-tool default, and below every platform's ephemeral floor.
 *
 * Port choice CANNOT buy robustness on Windows: Hyper-V/WSL reservations reported at
 * microsoft/WSL#5514 and #5306 cover 89% of 1024-9999 between them, and every four-digit repeating
 * port is inside a block on at least one of those machines — as are Vite's 5173 and Postgres's 5432.
 * Robustness lives entirely in the fallback below.
 */
export const DEFAULT_PORT = 9393

/**
 * The dev server's own default, so `frizz-dev` never fights the singleton for `9393`.
 *
 * Picked off the same verified shortlist as DEFAULT_PORT: IANA-unassigned on TCP and UDP, on neither
 * browser's blocklist, no tool default. Adjacent by sight for the same reason the fallback is.
 */
export const DEFAULT_DEV_PORT = 9494

/**
 * The primary with a `1` in front: 9393 → 19393.
 *
 * Lands in `10896-24265`, a 13,370-port gap clean on both reported Windows machines, above the
 * highest browser-blocked port and below Linux's ephemeral floor (32768). The band is wide enough
 * that "clean" picks no winner, so the tiebreak is explicability — someone meeting
 * `localhost:19393` is meeting it while something is already going wrong, and it should read at a
 * glance as the same app on its backup port.
 */
export function fallbackPort(base: number): number {
  return base + 10_000
}
