import { proxy, useSnapshot } from "valtio"
import { isConsolePath, projectSlug } from "./base-path.ts"

// WHICH SIDEBAR BANDS ARE FOLDED, remembered per project in this browser (maintainer 2026-11-14: "we need
// to remember persistently per project which rails are collapsed. running should be default open").
//
// Each band header in the rail is a fold toggle — Running, Snoozed, Done and External; Pinned and Queue
// never fold. Until 2026-11-14 the folds lived in the store and every load started over from the
// defaults, so a band opened on a project closed again at the next reload.
//
// PER PROJECT, because what a reader keeps open is a fact about the board: a project with forty
// terminals open folds External, a quiet one leaves it open. Keyed by the project the page names — the
// slug, "" for the unprefixed launching project, and "@console" for the Console's "By status" view —
// the same scopes lib/queryKeyScope.ts and lib/sidebarPresence.ts use. That key is in the URL, so the
// first frame of a reload already has the right folds, before the board arrives. App remounts per
// project (routes.tsx keys it by slug), so a switch re-reads the scope with nothing to reset.
//
// One localStorage key PER PROJECT rather than one blob: a tab on project A never holds project B's
// folds, so it can never write a stale copy of them over a change another tab made on B.
//
// localStorage, not the server's per-project Settings: this is how one browser draws its rail, like the
// rest of lib/prefs.ts, and only a desktop browser has the rail at all (the phone's board has no bands).

export type FoldingBand = "running" | "snoozed" | "inactive" | "external"
export type BandFolds = Record<FoldingBand, boolean>

// true = folded. RUNNING OPENS: its rows are the work in flight, and a folded Running hid exactly what a
// reader looks for after a dispatch (it opened folded from 2026-11-11 to 2026-11-14). Snoozed, Done and
// External open folded: nothing in them waits on the reader, so each header's count is the glance.
export const DEFAULT_BAND_FOLDS: Readonly<BandFolds> = Object.freeze({ running: false, snoozed: true, inactive: true, external: true })

const BANDS = Object.keys(DEFAULT_BAND_FOLDS) as FoldingBand[]
const PREFIX = "frizz.sidebarBands.v1:"

/** The Console's scope. No project's can be it: a slug has no `@`. */
export const CONSOLE_BAND_SCOPE = "@console"

/** The project scope this page's rail belongs to. */
export function bandScope(pathname?: string): string {
  return isConsolePath(pathname) ? CONSOLE_BAND_SCOPE : (projectSlug(pathname) ?? "")
}

/** A stored value, read leniently: anything missing or malformed falls back to its default. */
export function parseBandFolds(raw: string | null): BandFolds {
  const folds = { ...DEFAULT_BAND_FOLDS }
  if (!raw) return folds
  try {
    const stored = JSON.parse(raw) as unknown
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return folds
    for (const band of BANDS) {
      const value = (stored as Record<string, unknown>)[band]
      if (typeof value === "boolean") folds[band] = value
    }
  } catch {
    // a corrupt entry reads as the defaults; the next toggle overwrites it
  }
  return folds
}

// The folds this page has CHANGED, by scope. A scope nobody toggled in this page has no entry here and
// reads from `stored`, so a render never writes to the proxy.
const live = proxy<Record<string, BandFolds>>({})
// localStorage read once per scope per page, not on every render of a rail that re-renders per delta.
const stored = new Map<string, BandFolds>()

function storedFolds(scope: string): BandFolds {
  let folds = stored.get(scope)
  if (!folds) {
    let raw: string | null = null
    try {
      raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PREFIX + scope)
    } catch {
      // storage unavailable — the defaults
    }
    folds = parseBandFolds(raw)
    stored.set(scope, folds)
  }
  return folds
}

/** A project's folds right now, outside React (the Console's paged bands seed from this). */
export function readBandFolds(scope: string = bandScope()): BandFolds {
  return live[scope] ?? storedFolds(scope)
}

/** The rail's folds for this page's project, reactive to every toggle. */
export function useBandFolds(scope: string = bandScope()): BandFolds {
  const snap = useSnapshot(live)
  return snap[scope] ?? storedFolds(scope)
}

/** Fold or open one band, and remember it for this project. */
export function setBandFolded(band: FoldingBand, folded: boolean, scope: string = bandScope()): void {
  const next = { ...(live[scope] ?? storedFolds(scope)), [band]: folded }
  live[scope] = next
  stored.set(scope, next)
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(PREFIX + scope, JSON.stringify(next))
  } catch {
    // private mode / quota — the fold still holds for this page
  }
}

export function toggleBandFold(band: FoldingBand, scope: string = bandScope()): void {
  setBandFolded(band, !(live[scope] ?? storedFolds(scope))[band], scope)
}

/** Forget a project's folds, in this page and in storage, so it reads as the defaults again. */
export function resetBandFolds(scope: string = bandScope()): void {
  delete live[scope]
  stored.delete(scope)
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(PREFIX + scope)
  } catch {
    // nothing stored to forget
  }
}
