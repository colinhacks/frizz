import type { QueryClient } from "@tanstack/react-query"
import type { SocketServerMsg } from "@frizz/shared"
import { mergeOptimistic, preserveMessageIdentity, type QueuedMessage } from "../lib/transcript-sync.ts"
import { reconcileLatestPage, reconcileLiveMessages, type PaginatedTranscriptData } from "../lib/transcriptPagination.ts"

type TranscriptFrame = Extract<SocketServerMsg, { t: "transcript" }>

/**
 * Write a pushed transcript into the SAME cache entry `useTranscript` reads, so components never know a
 * push happened. `key` is the cache's name for the thread — the frame's own slug on a project page, the
 * thread's key on the Console (api/consoleFeed.ts), where the frame's slug is unique only within the one
 * project whose socket it came down.
 *
 * PRESERVE any optimistic `queued` bubble the incoming truth does not yet carry (mergeOptimistic), so a
 * just-sent follow-up never vanishes in the window before the server's own copy lands (the S1 sync-audit
 * fix).
 */
export function writeTranscriptPush(qc: QueryClient | null, key: string, msg: TranscriptFrame): void {
  qc?.setQueryData<PaginatedTranscriptData | { messages: QueuedMessage[] }>(["transcript", key], (prev) => {
    const previous = prev as PaginatedTranscriptData | undefined
    // A push that carries its page envelope is the SAME bounded latest window the HTTP page read
    // returns, so it reconciles through the same function the queryFn uses — the envelope (cursor,
    // hasEarlier, transcriptKey) stays as fresh as the messages, and a long thread whose window slid
    // under a push cannot page "earlier" from a cursor that no longer names its head. `editedFiles` and
    // `worktreeChanges` never ride a push (see TranscriptPushPage); the rail keeps its last HTTP copy of
    // each, and dropping one here emptied that group on the first push after a read. A server that
    // predates the envelope pushes messages only, and those take the messages-only reconcile.
    const reconciled = msg.page
      ? reconcileLatestPage(previous, { ...msg.page, messages: msg.messages, editedFiles: previous?.editedFiles, worktreeChanges: previous?.worktreeChanges })
      : reconcileLiveMessages(previous, msg.messages)
    return {
      ...reconciled,
      // preserveMessageIdentity: unchanged messages keep the previous render's object so the
      // memoized rows bail out — a push re-renders only what actually changed.
      messages: preserveMessageIdentity(
        prev?.messages,
        mergeOptimistic(prev?.messages, reconciled.messages as QueuedMessage[]),
      ),
    }
  })
}
