import {
  displayTitle,
  drawnUnderParent,
  futureSnoozedUntil,
  hasStandingQuestion,
  isDirectSubAgent,
  SPINNING_UP_TITLE,
  threadBandAt,
  UNTITLED_THREAD_TITLE,
  type FindThreadsResult,
  type ListThreadsResult,
  type ThreadBand,
  type ThreadListing,
  type ThreadMatch,
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
  const childrenOf = openChildren(threads)
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

/** Each parent's open child threads, which the board draws under it rather than as rows of their own. */
function openChildren(threads: readonly ThreadView[]): Map<string, ThreadView[]> {
  const childrenOf = new Map<string, ThreadView[]>()
  for (const t of threads) {
    if (!t.parentSlug || !drawnUnderParent(t) || t.state === "archived") continue
    childrenOf.set(t.parentSlug, [...(childrenOf.get(t.parentSlug) ?? []), t])
  }
  return childrenOf
}

// ── `frizzctl threads --find`: A THREAD BY ITS NAME, ON EVERY BOARD ──────────────────────────────────
//
// The human names threads by what they are called ("tell the releaser", "the resolver cache thread"), and a
// worker can only message one by its slug, which is minted from the first prompt and never changes: the
// releaser's is `cut-a-patch`. Until 2026-11-19 the worker's only way across was to list one project's open
// threads and match the titles by eye, which quietly missed a thread in Done (212 of them on this board
// that day) or on any of the other projects (25). This searches all of them at once.
//
// A query matches when EVERY word in it starts a word of one of the thread's names: the title the sidebar
// shows, the slug, the name Claude gave it, the one it was dispatched with. A prefix, so "release" finds
// "Releaser" and "pin" finds "pinned"; and a plural, so "releasers" still finds "Releaser". Not a longer
// word in general: "releaser" finding "Prepare the nub release" was noise in the first real run. The words
// a person puts around a name ("the", "thread") are dropped first. Ranked by how good the match is, then
// open before Done, then newest activity.

const FILLER = new Set(["the", "a", "an", "thread", "threads", "one", "that"])
/** Names a row wears while it has none of its own, which nobody uses to refer to a thread. */
const PLACEHOLDERS = new Set([SPINNING_UP_TITLE, UNTITLED_THREAD_TITLE])
const FIND_LIMIT = 20

/** A name's words: lowercase letters and digits, accents dropped. */
export function nameWords(s: string): string[] {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** The words of a query that say which thread: everything but the filler around a name, unless that is all there is. */
export function queryWords(query: string): string[] {
  const all = nameWords(query)
  const meant = all.filter((w) => !FILLER.has(w))
  return meant.length ? meant : all
}

function wordMatches(query: string, name: readonly string[]): boolean {
  return name.some((w) => w.startsWith(query) || query === `${w}s` || query === `${w}es`)
}

const everyWord = (query: readonly string[], name: readonly string[]) => query.every((q) => wordMatches(q, name))

/** How well `query` names `t`: 0 its title or slug exactly, 1 every word in its title, 2 in its slug, 3 in
 *  another name it has had (returned, so the reader sees why it matched); null when it does not. The exact
 *  comparison keeps the filler words, since "cut a patch" is a slug's own words. */
export function nameMatch(t: Pick<ThreadView, "id" | "title" | "aiTitle"> & { shown: string }, text: string): { rank: 0 | 1 | 2 | 3; matchedName?: string } | null {
  const query = queryWords(text)
  if (query.length === 0) return null
  const whole = nameWords(text).join(" ")
  const shown = PLACEHOLDERS.has(t.shown) ? [] : nameWords(t.shown)
  const slug = nameWords(t.id)
  if (whole === shown.join(" ") || whole === slug.join(" ") || query.join(" ") === shown.join(" ")) return { rank: 0 }
  if (everyWord(query, shown)) return { rank: 1 }
  if (everyWord(query, slug)) return { rank: 2 }
  for (const other of [t.aiTitle, t.title]) {
    const name = other?.trim()
    if (name && name !== t.shown && !PLACEHOLDERS.has(name) && everyWord(query, nameWords(name))) return { rank: 3, matchedName: name }
  }
  return null
}

/** The threads `query` names, across `boards` (the caller's own first), best first and capped. */
export function findBoardThreads(
  query: string,
  boards: readonly { project: ThreadMatch["project"]; threads: readonly ThreadView[] }[],
  opts: { nowMs?: number; limit?: number } = {},
): FindThreadsResult {
  const nowMs = opts.nowMs ?? Date.now()
  const found: { match: ThreadMatch; rank: number; board: number }[] = []
  boards.forEach((board, index) => {
    const childrenOf = openChildren(board.threads)
    for (const t of board.threads) {
      const hit = nameMatch({ id: t.id, title: t.title, aiTitle: t.aiTitle, shown: displayTitle(t) }, query)
      if (!hit) continue
      const row = threadListing(t, nowMs, childrenOf.get(t.id))
      if (!row) continue
      found.push({ match: { ...row, project: board.project, ...(hit.matchedName ? { matchedName: hit.matchedName } : {}) }, rank: hit.rank, board: index })
    }
  })
  const done = (m: ThreadMatch) => (m.band === "done" ? 1 : 0)
  found.sort((a, b) =>
    a.rank - b.rank || done(a.match) - done(b.match) || recency(b.match) - recency(a.match) || a.board - b.board || a.match.slug.localeCompare(b.match.slug))
  return { query, matches: found.slice(0, opts.limit ?? FIND_LIMIT).map((f) => f.match), total: found.length, projects: boards.length }
}
