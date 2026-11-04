import {
  displayTitle,
  drawnUnderParent,
  futureSnoozedUntil,
  hasStandingQuestion,
  isDirectSubAgent,
  threadBandAt,
  type ListThreadsResult,
  type ThreadBand,
  type ThreadListing,
  type ThreadView,
} from "@frizz/shared"

// `frizzctl threads` — one board, reduced to what another agent needs to know about each thread on it.
// Pure: the router hands it a board snapshot and a clock, so the readout is pinned here without a server.
// Where a thread SITS is threadBandAt's (the sidebar's own predicates); everything else is a fact read
// off the view, never a second guess at the band.

const BAND_ORDER: readonly ThreadBand[] = ["rested", "active", "snoozed", "done"]
const LAST_LINE_MAX = 200

/** One thread as a listing row, or `null` for a row the sidebar never draws. `children` are its open
 *  child threads, which have no row of their own (drawnUnderParent) and are listed on their parent's. */
export function threadListing(t: ThreadView, nowMs: number, children: readonly ThreadView[] = []): ThreadListing | null {
  const band = threadBandAt(t, nowMs)
  if (!band) return null
  const inFlight = t.runtime === "running" || t.runtime === "spawning"
  const asked = (t.questions ?? []).filter((q) => q.standing !== false).length
  // A native ask, an ask fenced in chat and a permission prompt are each one more thing the human owes
  // an answer to, and none is a registered row — so they count on top of the registered ones.
  const unregistered = (t.pendingAsk ? 1 : 0) + (t.pendingQuestion && !hasStandingQuestion(t) ? 1 : 0) + (t.runtime === "perm-prompt" ? 1 : 0)
  const lastLine = t.lastAssistantLine?.trim()
  const snoozedUntil = futureSnoozedUntil(t, nowMs)
  return {
    slug: t.id,
    title: displayTitle(t),
    band,
    runtime: t.runtime,
    ...(t.backend ? { backend: t.backend } : {}),
    ...(t.model ? { model: t.model } : {}),
    ...(t.pinnedAt ? { pinned: true as const } : {}),
    ...(inFlight && t.liveTool ? { doing: t.liveTool.desc?.trim() || t.liveTool.name } : {}),
    ...(lastLine ? { lastLine: lastLine.length > LAST_LINE_MAX ? `${lastLine.slice(0, LAST_LINE_MAX - 1)}…` : lastLine } : {}),
    ...(t.lastFence ? { fence: t.lastFence.kind } : {}),
    questions: asked + unregistered,
    subAgents: (t.subAgents ?? []).filter((a) => isDirectSubAgent(a) && a.state === "running").length,
    shells: (t.bgShells ?? []).filter((s) => s.state === "running").length,
    watches: (t.watches ?? []).filter((w) => w.state === "armed" && w.kind !== "shell").map(watchLabel),
    ...(children.length ? { children: children.map((c) => ({ slug: c.id, title: displayTitle(c), runtime: c.runtime })) } : {}),
    ...(t.limitPause ? { limited: true as const } : {}),
    ...(t.crashed ? { crashed: true as const } : {}),
    ...(t.spawnedAt ? { spawnedAt: t.spawnedAt } : {}),
    ...(t.lastAssistantAt ? { restedAt: t.lastAssistantAt } : {}),
    ...(t.lastActivityAt ? { lastActivityAt: t.lastActivityAt } : {}),
    ...(snoozedUntil ? { snoozedUntil } : {}),
    ...(t.archivedAt ? { archivedAt: t.archivedAt } : {}),
  }
}

/** What an armed watch is on, in the words a worker would use for it. A `shell` watch is left out by
 *  the caller: the shell itself is already counted, and its label is a command line. */
function watchLabel(w: NonNullable<ThreadView["watches"]>[number]): string {
  if (w.kind === "timer" && w.timer) return `timer at ${w.timer.fireAt}`
  return w.target
}

/** The newest instant a row's band is ordered by: Done by when it was archived, every other band by its
 *  newest activity. */
function recency(row: ThreadListing): number {
  const at = row.band === "done" ? (row.archivedAt ?? row.lastActivityAt) : (row.lastActivityAt ?? row.restedAt ?? row.spawnedAt)
  const ms = Date.parse(at ?? "")
  return Number.isFinite(ms) ? ms : 0
}

/** A board's threads as `listThreads` answers them: banded, newest first within a band, and the Done
 *  band only when it is asked for — but counted either way, so a reader knows what it left out. */
export function listBoardThreads(
  threads: readonly ThreadView[],
  project: ListThreadsResult["project"],
  opts: { all?: boolean; nowMs?: number } = {},
): ListThreadsResult {
  const nowMs = opts.nowMs ?? Date.now()
  const counts = { rested: 0, active: 0, snoozed: 0, done: 0 }
  const rows: ThreadListing[] = []
  const childrenOf = new Map<string, ThreadView[]>()
  for (const t of threads) {
    if (!t.parentSlug || !drawnUnderParent(t) || t.state === "archived") continue
    childrenOf.set(t.parentSlug, [...(childrenOf.get(t.parentSlug) ?? []), t])
  }
  for (const t of threads) {
    const row = threadListing(t, nowMs, childrenOf.get(t.id))
    if (!row) continue
    counts[row.band] += 1
    if (row.band === "done" && !opts.all) continue
    rows.push(row)
  }
  rows.sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band) || recency(b) - recency(a) || a.slug.localeCompare(b.slug))
  return { project, threads: rows, counts }
}
