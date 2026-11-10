import { stripHumanGapNote, stripWakeDeliveryToken, type TranscriptMessage } from "@frizz/shared"

// A transcript message that may carry the client-only/queued flag (server pending OR local optimistic).
export type QueuedMessage = TranscriptMessage & { queued?: boolean }

// The canonical form for matching an OPTIMISTIC bubble against the server's own record of that send.
//
// The worker's copy of a follow-up is not byte-identical to what the human typed: frizz appends its own
// machine-facing riders — the clock note (humanGapNote, on any reply landing ≥20min after the agent last
// spoke) and the wake delivery token — and the transcript is read from the WORKER's record, so those are
// part of `text`. Comparing raw text therefore fails to consume the optimistic copy of the very send the
// server is reporting, and the bubble is re-appended beside it: two identical gray bubbles of the human's
// own message, until a later push tags the record with its deliveryId. The server hit exactly this in its
// own ledger projection (delivery-ledger.renderMatchKey, the maintainer's 2026-08-24 double render); this
// is the same shedding on the client half. `displayText` is the server's own projection of these riders,
// so it is preferred where present and the strippers cover a record that arrived without one.
const matchKey = (m: QueuedMessage): string => stripHumanGapNote(stripWakeDeliveryToken(m.displayText ?? m.text)).trim()

function freshServerUserTexts(prev: QueuedMessage[], incoming: QueuedMessage[]): string[] {
  const previousSourceIds = new Set(
    prev.filter((m) => m.role === "user" && m.sourceId).map((m) => m.sourceId),
  )
  return incoming
    .filter((message) => message.role === "user" && message.sourceId && !previousSourceIds.has(message.sourceId))
    .map(matchKey)
}

function consumedOptimisticIndexes(optimistic: QueuedMessage[], serverUserTexts: string[]): Set<number> {
  const consumed = new Set<number>()
  const separator = "\n\n"

  for (const serverText of serverUserTexts) {
    for (let start = 0; start < optimistic.length; start++) {
      if (consumed.has(start)) continue
      const first = matchKey(optimistic[start])
      if (serverText === first) {
        consumed.add(start)
        break
      }
      if (!serverText.startsWith(first)) continue
      let offset = first.length
      for (let end = start + 1; end < optimistic.length; end++) {
        if (consumed.has(end)) break
        const next = matchKey(optimistic[end])
        if (!serverText.startsWith(separator, offset) || !serverText.startsWith(next, offset + separator.length)) break
        offset += separator.length + next.length
        if (offset !== serverText.length) continue
        for (let i = start; i <= end; i++) consumed.add(i)
        break
      }
      if (consumed.has(start)) break
    }
  }
  return consumed
}

// ── Layer 3: optimistic-merge hardening (the sync audit's S1 finding) ──────────────────────────────────
// A transcript cache OVERWRITE (a poll refetch OR a socket push) must not blunt-replace an optimistic
// "queued" bubble the client appended on send but the incoming server truth doesn't yet carry — that
// blunt replace is exactly what makes a just-sent message VANISH for the window before the server's own
// copy (a pending/delivered queued message — see the server parser) shows up. So: re-append any optimistic
// queued user entry until a newly observed server user record accounts for it; drop the ones the server
// has now materialized so there's never a duplicate. With the server now carrying the message within
// ~a tick this is a short bridge, but it closes the visible swallow.
export function mergeOptimistic(prev: QueuedMessage[] | undefined, incoming: QueuedMessage[]): QueuedMessage[] {
  if (!prev?.length) return incoming
  // Server-projected pending turns also carry `queued`, but unlike client-only optimistic sends they
  // already have a stable sourceId and must never be re-appended beside the same incoming record.
  const optimistic = prev.filter((m) => m.queued && !m.sourceId && m.role === "user" && m.text.trim())
  if (!optimistic.length) return incoming
  // A newly observed server USER record (delivered OR the server's own queued copy) consumes a matching
  // optimistic entry. Every current transcript parser assigns a stable sourceId; id-less input is ignored
  // rather than using text-count heuristics that can mistake historical repeated prose for fresh delivery.
  // Codex can also materialize several consecutive sends as one user turn joined by blank lines. Consume
  // that whole run only when at least two optimistic texts reconstruct the complete server turn; a lone
  // matching paragraph inside unrelated prose is not delivery proof.
  // Delivery-ledger consumption — exact and text-independent: the server projects (or tags) the queued
  // bubble for a tracked send with its deliveryId, so the optimistic copy of that SAME send is accounted
  // for the moment any incoming message carries the id. The text paths below remain for id-less legacy
  // flows (answers composed pre-ledger, old servers).
  const incomingDeliveryIds = new Set(incoming.map((m) => m.deliveryId).filter((id): id is string => Boolean(id)))
  const serverUserTexts = freshServerUserTexts(prev, incoming)
  const consumed = consumedOptimisticIndexes(optimistic, serverUserTexts)
  const unconsumed = optimistic.filter((m, i) => !consumed.has(i) && !(m.deliveryId && incomingDeliveryIds.has(m.deliveryId)))
  if (!unconsumed.length) return incoming
  const alive = unconsumed.filter((message) => retainOptimistic(message, newestServerAt(incoming), newestServerAt(prev)))
  return alive.length ? [...incoming, ...alive] : incoming
}

// ── The ghost floor: an optimistic bubble must not outlive the conversation ────────────────────────────
// Consumption above requires seeing the matching server record arrive FRESH exactly once. Every path that
// breaks that single chance strands the bubble PERMANENTLY: a steer whose provider delivery failed after
// the RPC acknowledged durable acceptance (that rollback only runs while the submitting surface is still
// mounted), a re-send of text the server only ever recorded once, a record that slid out of the 300-message
// window before any push was observed. The residue renders at 50% opacity pinned to the thread bottom
// forever and reads as "still pending" — the "random stuck queued message" class.
//
// So bound the guess by EVIDENCE, not by a timer: anchor each bubble to the newest SERVER timestamp seen
// when it first survived a merge, and retire it once the transcript has provably advanced GHOST_GRACE_MS
// past that anchor while still not accounting for it. Only server clocks are compared — the browser clock
// never enters, so there is no skew to tune. A quiet thread never advances its anchor, so a genuinely
// in-flight send is never dropped for being slow; only one the conversation demonstrably moved on past.
const GHOST_GRACE_MS = 60_000
const ghostAnchor = new WeakMap<QueuedMessage, number>()

// The newest timestamp in SERVER truth. Client-only bubbles are skipped: they carry no server time, and a
// merge appends them last, so scanning the tail would otherwise read a bubble instead of the transcript.
function newestServerAt(messages: readonly QueuedMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.queued && !message.sourceId) continue
    const at = message.at ? Date.parse(message.at) : NaN
    if (Number.isFinite(at)) return at
  }
  return NaN
}

// `atSend` is the transcript tail the client already held when the bubble was appended — the true
// send-time anchor, so a ghost retires on the FIRST push that clears the grace rather than the second.
function retainOptimistic(message: QueuedMessage, serverNow: number, atSend: number): boolean {
  if (!Number.isFinite(serverNow)) return true // no server clock to judge against
  const anchor = ghostAnchor.get(message)
  if (anchor === undefined) {
    ghostAnchor.set(message, Number.isFinite(atSend) ? atSend : serverNow)
    return retainOptimistic(message, serverNow, atSend)
  }
  if (serverNow - anchor <= GHOST_GRACE_MS) return true
  console.warn("[frizz] retiring a stranded optimistic send: the transcript advanced past it without ever recording it", {
    text: message.text.slice(0, 120),
    advancedMs: serverNow - anchor,
  })
  return false
}

// ── Per-push message identity preservation ─────────────────────────────────────────────────────────────
// Every transcript push/refetch re-parses the full window, so each message arrives as a NEW object even
// when nothing about it changed. The memoized <Message> rows key their bail-out on `m`'s identity, so an
// identity churn re-renders EVERY mounted row on EVERY push — measured ~60-75ms of main-thread block per
// push on an ~130-row drawer, i.e. a solid jank beat all through a streaming turn. Reuse the PREVIOUS
// render's object wherever the incoming copy is content-identical (sourceId match + a structural compare).
// Messages that really changed (a tool status backfill, a queued→delivered flip, tail growth) keep the
// fresh object and re-render exactly as before.
//
// THE COMPARE WALKS BOTH MESSAGES AND KEEPS NOTHING. Until 2026-11-09 it compared JSON signatures, cached
// per message in a WeakMap so the previous side was stringified once in its lifetime — which kept a second,
// serialized copy of every message alive as long as the message itself. A transcript is mostly strings (tool
// output, commands, file reads), so that copy was as big as the transcript: on the Console, after visiting
// twelve threads, the signatures were 22 MB of a 50 MB string heap, more than the transcripts they described
// (heap snapshot, copy of the real boards, 2026-11-09). The walk costs no more than stringifying the incoming
// side did, and stops at the first difference.
export function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameContent(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  // What JSON would have kept: a key whose value is undefined is the same as no key at all.
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  let count = 0
  for (const key in ra) {
    if (!Object.hasOwn(ra, key) || ra[key] === undefined) continue
    count++
    if (!Object.hasOwn(rb, key) || !sameContent(ra[key], rb[key])) return false
  }
  for (const key in rb) if (Object.hasOwn(rb, key) && rb[key] !== undefined) count--
  return count === 0
}

export function preserveMessageIdentity(
  prev: readonly QueuedMessage[] | undefined,
  incoming: QueuedMessage[],
): QueuedMessage[] {
  if (!prev?.length || !incoming.length) return incoming
  const prevById = new Map<string, QueuedMessage>()
  for (const message of prev) {
    if (message.sourceId) prevById.set(message.sourceId, message)
  }
  if (!prevById.size) return incoming
  let reused = false
  const out = incoming.map((message) => {
    if (message === prevById.get(message.sourceId ?? "")) return message // already the same object (optimistic re-append)
    const previous = message.sourceId ? prevById.get(message.sourceId) : undefined
    if (previous && sameContent(previous, message)) {
      reused = true
      return previous
    }
    return message
  })
  return reused ? out : incoming
}

// ── Level-triggered freshness watchdog (pure decision) ─────────────────────────────────────────────────
// The transport (socket push AND poll) is edge-triggered: a single missed edge — a dropped subscription
// across a reconnect/HMR, a suppressed broadcast, a mount-order flip — wedges a live view forever with no
// self-healing. The watchdog is the level-triggered complement: it compares the board's lastActivityAt for
// a slug (delivered independently over the board-delta channel) against the newest RENDERED message; a lead
// beyond the threshold means the rendered transcript is provably behind. Pure so the decision is unit-tested
// apart from the React timer/heal machinery in useTranscript.
export function isTranscriptStale(lastActivityAt: string | undefined, newestRenderedAt: string | undefined, staleMs: number): boolean {
  if (!lastActivityAt) return false // no activity marker → nothing to be behind
  const activity = Date.parse(lastActivityAt)
  if (!Number.isFinite(activity)) return false
  // No rendered message yet but the board reports activity → treat as maximally behind (rendered = epoch).
  const rendered = newestRenderedAt ? Date.parse(newestRenderedAt) : 0
  if (newestRenderedAt && !Number.isFinite(rendered)) return false // unparseable tail → don't thrash
  return activity - rendered > staleMs
}

// The newest RENDERED message timestamp: the last message that carries an `at` (scanning from the tail, so
// a trailing event/at-less line doesn't mask the real newest). undefined when nothing has a timestamp.
export function newestRenderedAt(messages: QueuedMessage[] | undefined): string | undefined {
  if (!messages) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const at = messages[i].at
    if (at) return at
  }
  return undefined
}
