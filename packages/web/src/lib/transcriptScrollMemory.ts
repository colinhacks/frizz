// THE READER'S PLACE IN EACH THREAD, across thread switches within the session.
//
// Selecting another thread in the sidebar (or closing and reopening a drawer) unmounts the thread's
// VirtualizedThreadTranscript. Without per-thread scroll memory, returning to a thread treated every
// revisit as a cold open and re-ran `openAtRest` (lib/openLanding) — hauling a reader who had scrolled or
// pressed "Jump to latest" back to the human's steer at the top of the stretch.
//
// A remembered place is recorded only once the reader has actually moved in the thread (scrolled, pressed
// "Jump to latest", or expanded a fold), and is stamped with the thread's current landing
// epoch — the human's latest message (`steerKey`) and the newest sign-off after it (`latestSignOffKey`).
// While that epoch is unchanged (including while a working or quiet-parked thread appends tool calls and
// wakes), returning to the thread restores the reader's place: pinned to the tail if they were at the
// tail, or anchored to the top visible row's key and viewport offset if they were mid-thread. When a new
// human steer or a new sign-off lands while they are away, the epoch changes and the thread opens on the
// new handoff as `openLanding` intends.

import { isHumanTurn, lastHumanTurnIndex, type HumanTurnLike } from "./messagePresentation.ts"

export interface TranscriptScrollAnchor {
  rowKey: string
  viewportTop: number
}

export interface TranscriptLandingEpoch {
  /** Identity of the human's latest message in the thread, if any. */
  steerKey: string | undefined
  /** Identity of the newest sign-off after that message, if any. */
  latestSignOffKey: string | undefined
}

export type TranscriptEpochMsgLike = HumanTurnLike & {
  sourceId?: string
  signOff?: boolean
}

export type RememberedTranscriptPlace =
  | { kind: "tail" }
  | { kind: "anchor"; index: number; anchor: TranscriptScrollAnchor }

interface StoredTranscriptScroll {
  epoch: TranscriptLandingEpoch
  moved: boolean
  followingTail: boolean
  anchor: TranscriptScrollAnchor | null
  openFolds: Set<string>
}

const bySlug = new Map<string, StoredTranscriptScroll>()

function sameEpoch(a: TranscriptLandingEpoch, b: TranscriptLandingEpoch): boolean {
  return a.steerKey === b.steerKey && a.latestSignOffKey === b.latestSignOffKey
}

/** The human's latest message and the newest sign-off after it, which together identify the handoff the
 *  thread is currently at. */
export function transcriptLandingEpoch(messages: readonly TranscriptEpochMsgLike[]): TranscriptLandingEpoch {
  const at = lastHumanTurnIndex(messages)
  const steerAt = messages[at] !== undefined && isHumanTurn(messages[at]) ? at : -1
  const steerKey = steerAt >= 0 ? (messages[steerAt]?.sourceId ?? `idx:${steerAt}`) : undefined
  let latestSignOffKey: string | undefined
  for (let i = messages.length - 1; i > steerAt; i--) {
    if (messages[i]?.signOff === true) {
      latestSignOffKey = messages[i]?.sourceId ?? `idx:${i}`
      break
    }
  }
  return { steerKey, latestSignOffKey }
}

/** Record where the reader left `slug`. */
export function rememberTranscriptScroll(
  slug: string,
  state: {
    epoch: TranscriptLandingEpoch
    followingTail: boolean
    anchor: TranscriptScrollAnchor | null
  },
): void {
  const existing = bySlug.get(slug)
  const openFolds = existing && sameEpoch(existing.epoch, state.epoch) ? existing.openFolds : new Set<string>()
  bySlug.set(slug, {
    epoch: state.epoch,
    moved: true,
    followingTail: state.followingTail,
    anchor: state.followingTail ? null : state.anchor,
    openFolds,
  })
}

/** Record a fold the reader expanded in `slug`, so a remembered anchor inside it stays mounted on return. */
export function rememberTranscriptOpenFold(slug: string, epoch: TranscriptLandingEpoch, foldKey: string): void {
  const existing = bySlug.get(slug)
  if (existing && sameEpoch(existing.epoch, epoch)) {
    existing.openFolds.add(foldKey)
    return
  }
  bySlug.set(slug, {
    epoch,
    moved: false,
    followingTail: false,
    anchor: null,
    openFolds: new Set([foldKey]),
  })
}

/** The folds the reader already expanded in `slug` during the current landing epoch. */
export function rememberedTranscriptOpenFolds(slug: string, epoch: TranscriptLandingEpoch): ReadonlySet<string> {
  const existing = bySlug.get(slug)
  if (!existing || !sameEpoch(existing.epoch, epoch)) return new Set()
  return new Set(existing.openFolds)
}

/** Where `slug` should open on revisit, or `null` when it should use its cold-open landing. */
export function resolveRememberedTranscriptScroll(
  slug: string,
  epoch: TranscriptLandingEpoch,
  rows: readonly { key: string }[],
): RememberedTranscriptPlace | null {
  const entry = bySlug.get(slug)
  if (!entry) return null
  if (!sameEpoch(entry.epoch, epoch)) {
    bySlug.delete(slug)
    return null
  }
  if (!entry.moved) return null
  if (entry.followingTail) return { kind: "tail" }
  if (!entry.anchor) return null
  const index = rows.findIndex((row) => row.key === entry.anchor!.rowKey)
  if (index < 0) return null
  return { kind: "anchor", index, anchor: entry.anchor }
}

/** Test seam. */
export function clearRememberedTranscriptScroll(slug?: string): void {
  if (slug !== undefined) bySlug.delete(slug)
  else bySlug.clear()
}
