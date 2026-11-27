// THE READER'S PLACE IN EACH THREAD, across thread switches within the tab.
//
// Selecting another thread in the sidebar (or closing and reopening a drawer) unmounts the thread's
// VirtualizedThreadTranscript. Without per-thread scroll memory, returning to a thread treated every
// revisit as a cold open and re-ran `openAtRest` (lib/openLanding) — hauling a reader who had scrolled or
// pressed "Jump to latest" back to the human's steer at the top of the stretch.
//
// A remembered place is recorded only once the reader has actually moved in the thread (scrolled, pressed
// "Jump to latest" or expanded a fold): pinned to the tail if they were at the tail, or the top visible
// row's key and its offset in the pane if they were mid-thread, with the folds they had open. It is
// stamped with the thread as it stood: the human's latest message (`steerKey`), the newest sign-off after
// it (`latestSignOffKey`) and the board's `lastActivityAt`. Coming back to a thread that has not moved
// since restores the place. Coming back to one that has — a steer from another tab, a sign-off, a wake —
// opens on its landing again, as `openLanding` intends for a new handoff. The board's stamp is what
// decides that: a transcript no surface shows is not kept live (api/transcript-live.ts), so the copy a
// revisit paints first can predate what happened while the reader was away, and the board never does.
// While the reader stays on the thread, each place they move to is stamped with whatever arrives, so what
// they watched land does not count as moving while away. The transcript reads all this only for a thread
// at rest: one whose turn is in flight still opens on its tail.
//
// In memory, for this tab alone: a reload, or another device, opens every thread on its landing again.
// Keyed by project and slug, because a thread slug is unique only within its project and a tab moves
// between projects without a reload (lib/queryKeyScope), and bounded to the threads read most recently.

import { isConsolePath, projectSlug } from "./base-path.ts"
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
  /** The board's `lastActivityAt` for the thread: anything appended to it since moves this. */
  activityAt: string | undefined
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
  followingTail: boolean
  anchor: TranscriptScrollAnchor | null
  openFolds: ReadonlySet<string>
}

// A few hundred bytes each. Past this the thread read longest ago opens on its landing again.
export const MAX_REMEMBERED_THREADS = 100

const byThread = new Map<string, StoredTranscriptScroll>()

function threadKey(slug: string): string {
  return `${isConsolePath() ? "@console" : (projectSlug() ?? "")}\u0000${slug}`
}

function current(slug: string, epoch: TranscriptLandingEpoch): StoredTranscriptScroll | undefined {
  const entry = byThread.get(threadKey(slug))
  return entry && sameEpoch(entry.epoch, epoch) ? entry : undefined
}

function sameEpoch(a: TranscriptLandingEpoch, b: TranscriptLandingEpoch): boolean {
  return a.steerKey === b.steerKey && a.latestSignOffKey === b.latestSignOffKey && a.activityAt === b.activityAt
}

/** The human's latest message and the newest sign-off after it, which together identify the handoff the
 *  thread is currently at, and the board's last activity on it. */
export function transcriptLandingEpoch(messages: readonly TranscriptEpochMsgLike[], activityAt: string | undefined): TranscriptLandingEpoch {
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
  return { steerKey, latestSignOffKey, activityAt }
}

/** Record where the reader is in `slug`, with the folds they have open. Newest last: a Map iterates in
 *  insertion order, so the first key is the thread read longest ago. */
export function rememberTranscriptScroll(
  slug: string,
  state: {
    epoch: TranscriptLandingEpoch
    followingTail: boolean
    anchor: TranscriptScrollAnchor | null
    openFolds: ReadonlySet<string>
  },
): void {
  const key = threadKey(slug)
  byThread.delete(key)
  byThread.set(key, { ...state, anchor: state.followingTail ? null : state.anchor })
  while (byThread.size > MAX_REMEMBERED_THREADS) byThread.delete(byThread.keys().next().value!)
}

/** The folds the reader had open in `slug`, if it has not moved since. */
export function rememberedTranscriptOpenFolds(slug: string, epoch: TranscriptLandingEpoch): ReadonlySet<string> {
  return new Set(current(slug, epoch)?.openFolds)
}

/** Where `slug` should open on revisit, or `null` when it should use its cold-open landing. */
export function resolveRememberedTranscriptScroll(
  slug: string,
  epoch: TranscriptLandingEpoch,
  rows: readonly { key: string }[],
): RememberedTranscriptPlace | null {
  const entry = current(slug, epoch)
  if (!entry) return null
  if (entry.followingTail) return { kind: "tail" }
  const anchor = entry.anchor
  if (!anchor) return null
  const index = rows.findIndex((row) => row.key === anchor.rowKey)
  if (index < 0) return null
  return { kind: "anchor", index, anchor }
}

/** Test seam. */
export function clearRememberedTranscriptScroll(): void {
  byThread.clear()
}
