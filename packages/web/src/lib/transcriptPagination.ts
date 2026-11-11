import type { TranscriptMessage, TranscriptPage } from "@frizz/shared"

export type PaginatedTranscriptData = TranscriptPage & { historyLoaded?: boolean }

// The next click starts at the immediately-previous projected user message. When no earlier user exists
// in the in-memory window, reveal its whole remaining prefix in one step; the caller consults the server
// cursor first when history exists beyond that prefix.
export function previousUserBoundary(messages: readonly TranscriptMessage[], currentStart: number): number | null {
  const start = Math.max(0, Math.min(messages.length, currentStart))
  for (let i = start - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i
  }
  return start > 0 ? 0 : null
}

function firstOverlap(
  previous: readonly TranscriptMessage[],
  incoming: readonly TranscriptMessage[],
): { previousIndex: number; incomingIndex: number } | undefined {
  const priorIds = new Map<string, number>()
  previous.forEach((message, index) => {
    if (message.sourceId) priorIds.set(message.sourceId, index)
  })
  for (let incomingIndex = 0; incomingIndex < incoming.length; incomingIndex++) {
    const id = incoming[incomingIndex].sourceId
    const previousIndex = id ? priorIds.get(id) : undefined
    if (previousIndex !== undefined) return { previousIndex, incomingIndex }
  }
  return undefined
}

// Reconcile a fresh latest-window pull/push with history already fetched by the user. The overlap's
// current server copies win (tool statuses can finalize), while the older prefix and its cursor remain.
// No overlap means a transcript/session replacement: discard the old window instead of splicing worlds.
export function reconcileLatestPage(
  previous: PaginatedTranscriptData | undefined,
  incoming: TranscriptPage,
): PaginatedTranscriptData {
  if (!previous?.historyLoaded || previous.transcriptKey !== incoming.transcriptKey) return incoming
  const overlap = firstOverlap(previous.messages, incoming.messages)
  if (!overlap) return incoming
  return {
    ...incoming,
    messages: [
      ...previous.messages.slice(0, overlap.previousIndex).filter((message) => !message.pinnedFromSourceId),
      ...incoming.messages.slice(overlap.incomingIndex),
    ],
    beforeCursor: previous.beforeCursor,
    hasEarlier: previous.hasEarlier,
    reachedTurnBoundary: previous.reachedTurnBoundary,
    historyLoaded: true,
  }
}

// A live push carries MESSAGES ONLY — never a page envelope — so the envelope can only come from what we
// already hold. Overlapping source ids mean it is the same transcript, whatever else moved.
//
// `previousIndex > 0` is the SLID WINDOW: the server's latest window is bounded (see latestWindowStart), so
// on a long enough thread every new message also pushes one off the HEAD, and the push's first message is
// one we already have further in. That is an ordinary live update on a long thread — not a session replacement —
// and dropping the envelope there was destroying `hasEarlier`/`beforeCursor`/`transcriptKey` on the FIRST
// push of any thread past the cap, which removed the "Load earlier messages" affordance outright (and
// with it the only route back to the history the slide had just trimmed away, since loadEarlier needs
// both the cursor and the key). Only a genuine no-overlap replacement discards what we hold.
export function reconcileLiveMessages(
  previous: PaginatedTranscriptData | undefined,
  incoming: readonly TranscriptMessage[],
): PaginatedTranscriptData | { messages: TranscriptMessage[] } {
  if (!previous) return { messages: [...incoming] }
  const overlap = firstOverlap(previous.messages, incoming)
  if (!overlap) return { messages: [...incoming] }
  if (!previous.historyLoaded) return { ...previous, messages: [...incoming] }
  return {
    ...previous,
    messages: [
      ...previous.messages.slice(0, overlap.previousIndex).filter((message) => !message.pinnedFromSourceId),
      ...incoming.slice(overlap.incomingIndex),
    ],
  }
}

// Apply one earlier response once. Source ids make retries/stale duplicate responses idempotent.
export function prependEarlierPage(
  current: PaginatedTranscriptData,
  earlier: TranscriptPage,
): PaginatedTranscriptData {
  if (current.transcriptKey !== earlier.transcriptKey) return current
  const incomingCanonical = new Set(earlier.messages.map((message) => message.sourceId).filter(Boolean))
  const retainedCurrent = current.messages.filter(
    (message) => !message.pinnedFromSourceId || !incomingCanonical.has(message.pinnedFromSourceId),
  )
  const present = new Set(retainedCurrent.map((message) => message.sourceId).filter(Boolean))
  const prepend = earlier.messages.filter((message) => !message.sourceId || !present.has(message.sourceId))
  return {
    ...current,
    messages: [...prepend, ...retainedCurrent],
    beforeCursor: earlier.beforeCursor,
    hasEarlier: earlier.hasEarlier,
    reachedTurnBoundary: earlier.reachedTurnBoundary,
    historyLoaded: true,
  }
}
