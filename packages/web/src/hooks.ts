import { useEffect, useMemo, useSyncExternalStore } from "react"
import { subscribe, useSnapshot } from "valtio"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { BoardSnapshot, InteractionRecord, ThreadView, TranscriptMessage } from "@frizz/shared"
import { boardThreadsNow, store, threadBySlug, threadSnapshotBySlug } from "./store.ts"
import { queued } from "./groups.ts"
import { partitionBoard } from "./lib/boardPartition.ts"
import { childThreadsOf } from "./lib/childThreads.ts"
import { holdsCardHere, useConsoleGroup } from "./lib/consoleBoard.ts"
import { rpc } from "./api/rpc.ts"
import { retryTranscriptSocket, subscribeFile, subscribeTranscript, unsubscribeFile, unsubscribeTranscript } from "./api/socket.ts"
import { mergeOptimistic, preserveMessageIdentity, isTranscriptStale, newestRenderedAt } from "./lib/transcript-sync.ts"
import { pendingInteractionsKey } from "./api/interaction-cache.ts"
import { reconcileLatestPage, type PaginatedTranscriptData } from "./lib/transcriptPagination.ts"

// A transcript message carrying a transient client-only flag: a follow-up we optimistically appended
// on send that hasn't yet appeared in a server refetch. The flag drives the "queued" affordance and
// is naturally dropped when server truth overwrites the cache — EXCEPT that a blunt overwrite would drop
// it too early (before the server's own copy lands), so overwrites now route through mergeOptimistic.
// `restReply`: a queued send the thread view draws in the message flow rather than the queued tail
// (presentation only, never in the cache — see lib/restReply).
// `refusedFences`: the ids of this message's ```question fences the server refused to register, hung on
// the message by the surface that draws it (lib/questionFaults withRefusedFences) — presentation only,
// never in the cache. `refusedReasons` maps each to the server's reasons, which its card shows.
// `questionOwners`: for a question id the thread has asked more than once (a settled id asked again), the
// row it named when this message was written (lib/questionOwners) — presentation only, the same way.
export type ChatMessage = TranscriptMessage & { queued?: boolean; deliveryId?: string; restReply?: boolean; refusedFences?: ReadonlySet<string>; refusedReasons?: ReadonlyMap<string, readonly string[]>; questionOwners?: ReadonlyMap<string, string> }
export type TranscriptData = Partial<Omit<PaginatedTranscriptData, "messages">> & { messages: ChatMessage[] }

// `mergeToolRuns` stays deleted: mutating transcript truth before the ordered-parts walk hoisted tools
// across prose and lost block fidelity. The minimal renderer now performs a narrower PRESENTATION-ONLY
// coalescing in lib/toolActivity.ts: a visible tool tail and its following provider-only turns share
// one disclosure; prose and dedicated block tools such as sub-agent operations are hard boundaries.
// VISUAL ORDER == TURN ORDER remains the invariant; no persisted/query-cached message is rewritten.

// React-only helpers live here, not in store.ts, because store.ts is also imported by
// non-React code (api/sse.ts) that has no business pulling in React/valtio hooks.

// Valtio's useSnapshot() produces a DeepReadonly view that doesn't structurally match
// BoardSnapshot/ThreadView (readonly arrays vs. the mutable shapes zod infers), so every read
// needs a cast. Centralized here so it happens once instead of scattered `as BoardSnapshot`
// casts across components.
export function useBoard(): BoardSnapshot | null {
  const snap = useSnapshot(store)
  return snap.board as BoardSnapshot | null
}

// The project root every display path is shortened against (see relativeToolPaths). Narrower than
// useBoard() on purpose: valtio tracks the single property, so a transcript row that only needs the
// root does not re-render on unrelated board churn.
export function useProjectDir(): string | undefined {
  return useSnapshot(store).board?.projectDir
}

// The server's home directory — what /full's rail and file viewer write as `~` (see editedFileSegments).
// Narrow for the same reason as useProjectDir.
export function useHomeDir(): string | undefined {
  return useSnapshot(store).board?.homeDir
}

export function asThreads(threads: readonly unknown[]): ThreadView[] {
  return threads as ThreadView[]
}

// ── THE BOARD'S THREADS, READ WITHOUT TRACKING ────────────────────────────────────────────────────
// useBoard() hands out valtio's TRACKING view: every property a render reads off it is recorded, per
// object, so the next store change can be tested against exactly what was read. That is the right tool
// for a component that reads one thread. It is the wrong one for a component that walks the whole list —
// the rail sections and sorts every thread, the queue filters every thread — because the walk then costs
// a proxy trap and a bookkeeping write per read, per thread, per render, and the list is mostly Done
// threads nobody is looking at. Measured on a send from a queue card (2026-10-13, three runs each, the
// click's own handler, then the first frame the card fades):
//
//   Done threads                 30                 300                1,000
//   production bundle, before    12-18 / 30-40ms    20-23 / 37-45ms    24-36 / 43-53ms
//   production bundle, after     11-12 / 25-31ms    13-18 / 30-37ms    13-17 / 29-37ms
//   dev server, before           27-32 / 48-62ms    74-89 / 151-164ms  156-162 / 284-298ms
//   dev server, after            27-30 / 56-70ms    26-29 / 50-69ms    28-31 / 58-67ms
//
// (The dev figure was mostly instrumentation walking the same recorded reads again: valtio's
// useDebugValue path list and React's per-render prop diff, 207ms of a 420ms profile at 1,000.)
//
// These hooks read valtio's SNAPSHOT instead: plain immutable objects, replaced only along a path that
// changed, so an unchanged thread is the same object from one board to the next. A reader subscribes to
// the identity of what it derives and recomputes only when that moves; memo boundaries below it compare
// rows by identity. Nothing here defers or batches anything — the work is simply not done.
//
// What was left at 1,000 was valtio's own: a change to any thread rebuilt the snapshot of the threads
// ARRAY, one slot per thread, 1.3-3.1ms each time (a send makes two such changes inside its click). The
// array is a plain value now, replaced copy-on-write, and a snapshot shares it (store.ts plainArray).
//
// A COMPONENT THAT SHOWS ONE THREAD READS IT WITH useThreadSnapshot, not by looking it up on useBoard().
// Through the tracking view, even threadBySlug's one-row read makes proxy-compare wrap the threads array,
// and wrapping a NEW array (every delta brings one) first walks a property descriptor for every slot to
// decide whether it must copy it. Once per array, whichever render gets there first: ~0.5ms of every
// delta at 5,000 threads with a thread's drawer open (CPU profile, the Console, production bundle,
// 2026-10-15), and it grew with the history. useThreadSnapshot finds the row by table and re-renders
// when that thread is replaced, which is what the tracked read did.
//
// TWO RULES FOR A COMPONENT THAT STILL USES useBoard():
//   - Never walk `board.threads`; and where a hook cannot reach (a callback, a loop), find a thread with
//     threadBySlug (store.ts), never `board.threads.find`: it reads one row.
//   - Never hand the tracked board, or a tracked thread, to a child as a PROP. React's development build
//     diffs a changed prop key by key, and through the tracking view every `in` check is recorded as a
//     read of the parent's. One `<BoardErrorsBanner board={board} />` left the queue page holding 101,748
//     recorded paths on a 1,047-thread board, re-walked after every render.
const NO_THREADS: readonly ThreadView[] = Object.freeze([]) as readonly ThreadView[]
const onStoreChange = (notify: () => void) => subscribe(store, notify)
const allThreadsNow = (): readonly ThreadView[] => boardThreadsNow() ?? NO_THREADS

/** Every thread on the board, as plain snapshots. Re-renders when any thread changes, and only then. */
export function useBoardThreads(): readonly ThreadView[] {
  return useSyncExternalStore(onStoreChange, allThreadsNow, allThreadsNow)
}

// The queue's threads, unordered. The SAME array until a queued thread changes or the set does, so the
// queue page does not re-render while the threads that are merely running tick.
let queuedFrom: readonly ThreadView[] | undefined
let queuedNow: readonly ThreadView[] = NO_THREADS
/** useQueuedThreads' reading. Exported for its test, which pins the identity rule. */
export function queuedThreadsNow(): readonly ThreadView[] {
  const threads = allThreadsNow()
  if (threads === queuedFrom) return queuedNow
  queuedFrom = threads
  // A settled thread is archived, so never queued: only the live ones are asked (lib/boardPartition).
  const next = partitionBoard(threads).live.filter(queued)
  if (next.length !== queuedNow.length || next.some((t, i) => t !== queuedNow[i])) queuedNow = next
  return queuedNow
}

/** The threads waiting on the human (groups.queued), as plain snapshots, in board order. */
export function useQueuedThreads(): readonly ThreadView[] {
  return useSyncExternalStore(onStoreChange, queuedThreadsNow)
}

/** The threads drawing a queue card on the page on screen: the queue, less the pinned reports a shelf on
 *  this page shows instead (lib/consoleBoard holdsCardHere). Stable until the queue or the grouping moves. */
export function useQueueCards(): readonly ThreadView[] {
  const queuedThreads = useQueuedThreads()
  const group = useConsoleGroup()
  return useMemo(() => queuedThreads.filter((t) => holdsCardHere(t, group)), [queuedThreads, group])
}

// A THREAD'S CHILD THREADS (lib/childThreads), untracked like the queue above. The SAME array until one
// of that parent's children changes or the set does, so a sidebar row does not re-render on every delta
// of a board it shares with a streaming turn. Keyed per parent: every rail row asks for its own.
const childrenNow = new Map<string, readonly ThreadView[]>()
/** useChildThreads' reading. Exported for its test, which pins the identity rule. */
export function childThreadsNow(parent: string): readonly ThreadView[] {
  const next = childThreadsOf(allThreadsNow(), parent)
  const prev = childrenNow.get(parent)
  if (prev && prev.length === next.length && prev.every((t, i) => t === next[i])) return prev
  if (next.length === 0 && !prev) return next
  childrenNow.set(parent, next)
  return next
}

/** The children of `parent` the board draws beneath it, oldest first, as plain snapshots. */
export function useChildThreads(parent: string): readonly ThreadView[] {
  const read = () => childThreadsNow(parent)
  // The server reading too: the rail is rendered to a string in its tests (renderToString).
  return useSyncExternalStore(onStoreChange, read, read)
}

/** Whether a board has arrived at all. A boolean, so only the edge re-renders. */
export function useBoardLoaded(): boolean {
  return useSyncExternalStore(onStoreChange, () => boardThreadsNow() !== undefined)
}

/** Whether the board holds no thread at all (or has not arrived). A boolean, so only the edge re-renders. */
export function useBoardIsEmpty(): boolean {
  return useSyncExternalStore(onStoreChange, () => allThreadsNow().length === 0)
}

/** One thread, as a plain snapshot. Re-renders when THAT thread changes, and only then. */
export function useThreadSnapshot(slug: string | null | undefined): ThreadView | undefined {
  return useSyncExternalStore(onStoreChange, () => threadSnapshotBySlug(slug))
}

// True once the /ws multiplex is the transcript source (server pushes into the cache). Components read
// this to skip pull-based refetch paths that the push now covers.
export function useSocketTranscripts(): boolean {
  return useSnapshot(store).socketTranscripts
}

// A READER'S LIVE HOLD on the local file it shows (the /full split viewer, the Markdown drawer). For
// as long as the surface is mounted the server watches the file and pushes `file-changed`, which
// invalidates the reader's query (api/socket.ts) — so a file a worker is editing re-renders as it is
// saved instead of sitting at whatever it read on open (maintainer 2026-09-03: "it needs to be live").
// Returns whether that push is up: without it (a pre-/ws server, the SSE fallback) the reader polls
// on LOCAL_FILE_POLL_MS instead, which is the same "read it again" on a clock.
export function useLiveLocalFile(path: string): boolean {
  const live = useSnapshot(store).socketTranscripts
  useEffect(() => {
    subscribeFile(path)
    return () => unsubscribeFile(path)
  }, [path])
  return live
}

export function ownedInteractionScope(thread: ThreadView | undefined): { slug: string; sessionId: string } | undefined {
  if (!thread || thread.kind !== "session" || thread.foreign || !thread.sessionId) return undefined
  return { slug: thread.id, sessionId: thread.sessionId }
}

// A current server emits an exact board-level presence bit, so unrelated needs-you rows (questions,
// done handoffs, native prompts) do not each fan out another list RPC. During a rolling update an older
// board omits the optional field; preserve the prior query behavior until the server catches up so a
// real typed request is never hidden merely because client and server bundles changed out of order.
export function pendingInteractionScope(thread: ThreadView | undefined): { slug: string; sessionId: string } | undefined {
  const scope = ownedInteractionScope(thread)
  if (!scope || thread?.pendingInteraction === false) return undefined
  return scope
}

// Keep an expiring card accurate even if the provider edge or push transport is lost. The server's
// scoped list call performs the authoritative expiry transition; otherwise SSE/WS invalidations keep
// this query pull-free.
export function nextInteractionExpiryDelay(interactions: readonly InteractionRecord[], now = Date.now()): number | false {
  let earliest = Infinity
  for (const interaction of interactions) {
    if (!interaction.expiresAt) continue
    const expires = Date.parse(interaction.expiresAt)
    if (Number.isFinite(expires)) earliest = Math.min(earliest, expires)
  }
  if (!Number.isFinite(earliest)) return false
  return Math.max(250, earliest - now + 50)
}

export function usePendingInteractions(thread: ThreadView | undefined) {
  const scope = pendingInteractionScope(thread)
  return useQuery({
    queryKey: scope ? pendingInteractionsKey(scope.slug, scope.sessionId) : ["interactions", "pending", "unowned"],
    queryFn: () => rpc.pendingInteractions(scope!),
    enabled: scope !== undefined,
    refetchInterval: (query) => nextInteractionExpiryDelay(query.state.data?.interactions ?? []),
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  })
}

// Shared transcript query. `poll` controls whether the transcript stays LIVE (chat while the agent is
// running) or is left to refetch only on explicit triggers (the To-dos pager).
//
// Freshness has two transports: with the /ws multiplex live (store.socketTranscripts), a live surface
// SUBSCRIBES and the server PUSHES updates into this same cache — no interval poll. Without it (before the
// socket confirms, or on SSE fallback against a pre-restart server) it falls back to the 1.5s interval —
// exactly today's behavior. Either way the mount fetch (staleTime 0) paints immediately.
// Watchdog cadence + staleness threshold. The board's lastActivityAt can legitimately lead the rendered
// tail by a couple seconds (the two ride different reads of the same JSONL), so only a LARGER lead is a
// real delivery miss. A genuine miss self-heals on the first refetch (it pulls the whole transcript); the
// attempt cap stops us hammering when the lead is a benign tail-advance with nothing new to render.
const WATCHDOG_MS = 7000
const STALE_MS = 5000
const MAX_HEAL_ATTEMPTS = 3

// ── The revisit cache: a thread you have already read must not re-download on the way back in ──────────
// This query carried no staleTime at all, so react-query treated every cached copy as stale the instant
// it landed and EVERY open issued a fresh threadTranscript — including a return to the thread you just
// left. Measured against a copy of the maintainer's 558-thread board (2026-09-04): four cold opens
// painted their first row at 408 / 910 / 2072 / 1660ms with zero client-side long tasks (the wait is the
// server reading JSONL, not us), while a REVISIT painted from cache in 63ms and then spent 1998ms on a
// request whose answer was already on screen — one of ~11 RPCs fighting over the browser's six HTTP/1.1
// connections, which is how a transcript read came to report `stall: 1978ms` before it was ever sent.
const REVISIT_STALE_MS = 15_000
// Long enough that moving around a board keeps the threads you visited warm. The cost is bounded by what
// the server actually sends — the latest page of a windowed transcript, not a thread's whole history.
const REVISIT_GC_MS = 30 * 60_000

/**
 * How long a cached transcript may be served without re-reading it. The NUMBER is the easy part; the
 * GATE is what makes this safe, because a stale transcript is far worse than a slow one.
 *
 * `dataUpdatedAt` is when the SERVER last confirmed this cache entry — a queryFn refetch and a socket
 * push both stamp it — and the board delivers `lastActivityAt` per thread over its own delta channel.
 * A marker NEWER than that stamp therefore means the thread moved after our freshest confirmation, and
 * the copy is re-read on sight. So does a thread with no board row at all (a board that has not seeded
 * yet, another project's thread): with no marker there is nothing to gate on, and the answer is 0.
 *
 * The one window this cannot see is a read whose FLIGHT spanned the activity — the response lands after
 * a marker it does not contain. Three things already cover it and none of them consult staleTime: the
 * socket push (a fresh subscription makes the server send a full snapshot, app-socket.ts
 * `enqueueSubscriptionPush`), the activity-edge refetch beyond the subscription budget
 * (api/transcript-live.ts), and the level-triggered watchdog below. The window is also bounded — it
 * closes on its own after REVISIT_STALE_MS.
 */
export function transcriptStaleTime(board: BoardSnapshot | null, slug: string, dataUpdatedAt: number): number {
  const activity = threadBySlug(board, slug)?.lastActivityAt
  if (!activity) return 0
  const movedAt = Date.parse(activity)
  if (!Number.isFinite(movedAt)) return 0
  return movedAt > dataUpdatedAt ? 0 : REVISIT_STALE_MS
}

// The later of the server's last confirmation of a cache entry (`dataUpdatedAt`, as an ISO string for
// isTranscriptStale) and the newest rendered message's own timestamp. Exported for the watchdog test.
export function latestConfirmation(dataUpdatedAt: number | undefined, newestRendered: string | undefined): string | undefined {
  const rendered = newestRendered ? Date.parse(newestRendered) : NaN
  const confirmed = dataUpdatedAt && dataUpdatedAt > 0 ? dataUpdatedAt : NaN
  if (!Number.isFinite(rendered) && !Number.isFinite(confirmed)) return newestRendered
  const at = Math.max(Number.isFinite(rendered) ? rendered : 0, Number.isFinite(confirmed) ? confirmed : 0)
  return new Date(at).toISOString()
}

// The transcript query's read, shared by the hook and by warmTranscript below so a warmed cache entry is
// exactly the one the hook would have written.
// Preserve optimistic sends across a poll refetch too (not just the socket push) — see mergeOptimistic.
async function fetchTranscript(qc: QueryClient, slug: string): Promise<TranscriptData> {
  const res = await rpc.threadTranscript({ slug })
  const prev = qc.getQueryData<TranscriptData>(["transcript", slug])
  const reconciled = reconcileLatestPage(prev as PaginatedTranscriptData | undefined, res)
  return {
    ...reconciled,
    // preserveMessageIdentity: unchanged messages keep their previous object so memoized rows
    // bail out of re-render — a refetch repaints only what actually changed.
    messages: preserveMessageIdentity(
      prev?.messages,
      mergeOptimistic(prev?.messages, reconciled.messages as ChatMessage[]),
    ),
  }
}

/** How long a navigation waits for a thread's transcript before it goes ahead without it. */
export const WARM_TRANSCRIPT_MS = 300

// WARM A THREAD'S TRANSCRIPT BEFORE A SURFACE MOUNTS ON IT. A navigation that mounts a thread whose
// transcript is not cached paints "Loading…" first and the transcript a beat later; under the fullscreen
// door's view transition that first frame is the one the browser snapshots and cross-fades in, so the
// page arrived as a spinner and then cut to its content (a sidebar row's door, 2 states where 1 says it,
// 2026-10-14). Resolves when the cache has the transcript, or after `capMs` regardless, so a slow read
// costs the click at most that long and the surface's own query takes over from there.
export function warmTranscript(qc: QueryClient, slug: string, capMs = WARM_TRANSCRIPT_MS): Promise<void> {
  if (qc.getQueryData(["transcript", slug]) !== undefined) return Promise.resolve()
  const read = qc.prefetchQuery({ queryKey: ["transcript", slug], queryFn: () => fetchTranscript(qc, slug), gcTime: REVISIT_GC_MS })
  return Promise.race([read, new Promise<void>((resolve) => setTimeout(resolve, capMs))])
}

export function useTranscript(slug: string, opts: { poll: boolean }) {
  const qc = useQueryClient()
  const snap = useSnapshot(store)
  const socket = snap.socketTranscripts
  const transportFallback = snap.socketTranscriptFallbacks[slug]
  // Liveness is NOT this hook's job anymore: transcript-live.ts watches the query cache and keeps every
  // OBSERVED ["transcript", slug] fresh centrally (socket subscription within budget, activity-edge
  // refetch beyond, nothing for typed-fallback slugs). Mounting this hook is what registers the observer.
  // `poll` retains exactly one meaning: the 1.5s HTTP interval for a RUNNING thread when the socket is
  // down (SSE fallback) — an at-rest thread must never interval-poll.

  const query = useQuery({
    queryKey: ["transcript", slug],
    queryFn: () => fetchTranscript(qc, slug),
    // A typed per-subscription transport rejection (logical overflow or aggregate read budget) never
    // interval-polls: keep the last complete copy visible and let the banner offer explicit one-shot
    // refresh/retry actions. An overflowed slug is still kept fresh — one paged HTTP pull per activity
    // edge, owned centrally by api/transcript-live.ts. Ordinary SSE fallback still polls exactly as before.
    refetchInterval: opts.poll && !socket && !transportFallback ? 1500 : false,
    // A window focus is one bounded HTTP read; under a transport pause it is the cheapest recovery there is.
    refetchOnWindowFocus: true,
    // Serve a revisited thread from cache instead of re-reading it — see transcriptStaleTime above for
    // the activity gate that keeps that from ever showing a transcript the board says has moved on.
    // Nothing that keeps a LIVE thread live goes through here: the socket push writes the cache
    // directly, and the interval poll, the activity-edge refetch and the watchdog below all fetch
    // unconditionally. staleTime governs exactly one decision — whether MOUNTING re-reads.
    staleTime: (query) => transcriptStaleTime(store.board as BoardSnapshot | null, slug, query.state.dataUpdatedAt),
    gcTime: REVISIT_GC_MS,
  })

  // LEVEL-TRIGGERED freshness watchdog — the self-healing complement to the edge-triggered push/poll. A
  // missed edge (a dropped subscription across a reconnect/HMR, a suppressed broadcast, a mount-order flip)
  // would otherwise wedge a live view FOREVER with no recovery — the class of bug behind "it needed a hard
  // reload". Every WATCHDOG_MS (cheap: one timestamp compare, no network unless stale) we check the board's
  // lastActivityAt for this slug (delivered independently over the board-delta channel) against the moment
  // the SERVER last confirmed this cache entry; a lead beyond STALE_MS means the transcript is provably
  // behind, so we force a pull refetch (always works — plain HTTP) AND re-establish the subscription (fixes
  // a lost server-side sub for FUTURE pushes), and warn a structured breadcrumb so the underlying delivery
  // bug stays diagnosable. Lives in the hook so every consumer (main ChatView + the drawer's) inherits it.
  //
  // "Confirmed" is react-query's `dataUpdatedAt` — stamped by a push and by a refetch alike — not the
  // newest rendered message's own timestamp. Until 2026-09-18 it was the latter, and on a STREAMING thread
  // that reads as permanently stale: the board's marker moves on every rollout record (a token count, a
  // reasoning summary, a tool result still in flight) while the newest message that carries an `at` sits
  // minutes back during a long tool stretch. Pushes were landing every few seconds and the watchdog still
  // fired every 7s, twice per page (main view + rail), each firing an unsub+sub (a full server re-read)
  // and an HTTP refetch (another) — on a 19 MB codex rollout, ~300 ms of parse each, on a server already
  // re-parsing that file once a second for the push. The attempt cap never engaged, because "the transcript
  // advanced" re-armed it on every push. The rendered timestamp is kept only as the floor for a cache the
  // server has never stamped.
  useEffect(() => {
    // Armed whenever the surface has a live source to guard: the SSE interval poll, or (socket mode) the
    // centrally-managed subscription/edge-refetch — a missed push edge would otherwise freeze the view
    // exactly like the pre-subscription bug this watchdog exists for.
    if ((!opts.poll && !socket) || transportFallback) return // typed pause stays manual; never turn the watchdog into a full-read loop
    let inFlight = false
    let attempts = 0
    let lastHealNewest: string | undefined
    const tick = () => {
      if (inFlight) return
      const activity = threadBySlug(store.board as BoardSnapshot | null, slug)?.lastActivityAt
      const state = qc.getQueryState<TranscriptData>(["transcript", slug])
      const newest = newestRenderedAt(state?.data?.messages)
      const confirmedAt = latestConfirmation(state?.dataUpdatedAt, newest)
      if (!isTranscriptStale(activity, confirmedAt, STALE_MS)) {
        attempts = 0 // caught up — re-arm
        return
      }
      // Stale. If the transcript advanced since our last heal, re-arm; otherwise the lead is likely a benign
      // tail-advance (sidecar records with nothing renderable) — cap attempts so we don't hammer forever.
      if (newest !== lastHealNewest) attempts = 0
      if (attempts >= MAX_HEAL_ATTEMPTS) return
      attempts++
      lastHealNewest = newest
      const lagMs = activity ? Date.parse(activity) - (newest ? Date.parse(newest) : 0) : 0
      console.warn("[frizz] transcript watchdog: stale view — self-healing", { slug, lagMs, transport: socket ? "socket" : "poll", attempt: attempts })
      if (socket) {
        // Re-establish the server-side subscription (drop→re-add on the ref count) so future pushes resume.
        unsubscribeTranscript(slug)
        subscribeTranscript(slug)
      }
      inFlight = true
      void query.refetch().finally(() => {
        inFlight = false
      })
    }
    const iv = setInterval(tick, WATCHDOG_MS)
    return () => clearInterval(iv)
    // query.refetch is stable across renders (react-query); slug/poll/socket cover the meaningful deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, opts.poll, socket, transportFallback])

  return {
    ...query,
    transportFallback: transportFallback
      ? transportFallback.kind === "payload-too-large"
        ? {
            kind: "payload-too-large" as const,
            actualBytes: transportFallback.actualBytes,
            maxBytes: transportFallback.maxBytes,
          }
        : {
            kind: "read-budget" as const,
            scope: transportFallback.scope,
            retryAfterMs: transportFallback.retryAfterMs,
          }
      : null,
    retryLiveUpdates: () => retryTranscriptSocket(slug),
  }
}

// A live/stale sub-agent's OWN transcript, for the drill-in drawer. Keyed by (slug, id) so distinct
// children never collide, and polled ONLY while the child is still running — once the RPC reports
// stale/gone the drawer is showing a settled (or unavailable) transcript, so we stop hammering the
// connection budget. The predicate reads the last result so polling self-cancels as the state flips.
export function useSubAgentTranscript(slug: string, id: string) {
  return useQuery({
    queryKey: ["subAgentTranscript", slug, id],
    queryFn: () => rpc.subAgentTranscript({ slug, id }),
    refetchInterval: (query) => (query.state.data?.state === "running" ? 2500 : false),
  })
}

export function useBackgroundShellOutput(slug: string, id: string) {
  return useQuery({
    queryKey: ["backgroundShellOutput", slug, id],
    queryFn: () => rpc.backgroundShellOutput({ slug, id }),
    refetchInterval: (query) => (query.state.data?.state === "running" ? 1500 : false),
  })
}

/** A monitor's drawer: its script, what it printed and how it ended, polled while it runs. */
export function useMonitorOutput(slug: string, id: string) {
  return useQuery({
    queryKey: ["monitorOutput", slug, id],
    queryFn: () => rpc.monitorOutput({ slug, id }),
    refetchInterval: (query) => (query.state.data?.state === "running" ? 1500 : false),
  })
}

// The ops strip's LIVE OUTPUT COUNTER: lines produced, per shell row on screen, refreshed while any of
// them is still running. One batched request per poll for the whole strip.
//
// The key carries the sorted ids, so a strip that gains or loses a shell re-keys rather than serving
// the old set's answer; sorting keeps a re-ordered board frame from thrashing the cache.
//
// Polling continues while any named shell is RUNNING — including one that has no readable output yet
// (`lines: null`), which is the state a shell sits in between its tool_use and its launch ack. Keying
// the stop on "did anything report a number" instead stopped the poll during that window and the
// counter never arrived. It stops when every named shell has settled, and when the server knows none
// of them at all: a settled shell's line count cannot move again.
//
// SCOPED TO WHAT IS RENDERED, on purpose: this is the reason the reading is not a board field. An
// operator looking at one thread pays for that thread's shells and nothing else, and closing the view
// unmounts the poll entirely.
export function useBackgroundShellLines(slug: string, ids: readonly string[]): Map<string, number> {
  const key = [...ids].sort()
  const query = useQuery({
    queryKey: ["backgroundShellActivity", slug, key],
    queryFn: () => rpc.backgroundShellActivity({ slug, ids: key }),
    enabled: key.length > 0,
    refetchInterval: (q) => (q.state.data && !q.state.data.shells.some((s) => s.running) ? false : 1500),
  })
  return useMemo(
    () => new Map((query.data?.shells ?? []).flatMap((s) => (s.lines === null ? [] : [[s.id, s.lines] as const]))),
    [query.data],
  )
}

// Follow-ups are injected into the agent's terminal stdin and only surface in the transcript once the
// agent's next turn picks them up — so the message would otherwise vanish on send. Optimistically
// append it to the ["transcript", slug] cache as a user bubble tagged `queued`; the next real refetch
// (which never sets `queued`) overwrites the cache and dedupes it against the server's own copy.
export function appendQueuedMessage(
  qc: QueryClient,
  slug: string,
  text: string,
  // `held`: the operator sent it TO THE QUEUE while a turn runs, so the bubble says it is waiting for
  // the agent's rest from the first frame — the server's own copy (deliveryState "held") says the same.
  opts: { deliveryId?: string; held?: boolean } = {},
) {
  qc.setQueryData<TranscriptData>(["transcript", slug], (prev) => {
    const messages = prev?.messages ?? []
    return { ...prev, messages: [...messages, { role: "user", text, tools: [], parts: [], queued: true, deliveryId: opts.deliveryId, ...(opts.held ? { deliveryState: "held" as const } : {}) }] }
  })
  // NOTHING SCROLLS THE PAGE HERE. This smooth-scrolled the DOCUMENT to its bottom on every send until
  // 2026-10-12, from when the thread view was itself the page scroll. It has not been for months — a
  // transcript is its own scroller, kept at its tail by ChatView's tail follow — so the pin reached only
  // two places: a drawer, where the locked page made it a no-op, and the QUEUE, which is a page of other
  // threads' cards. Only the queue card's own composer and answers opted out; its steps Done, Retry,
  // Restart worker, Continue and a failed bubble's retry did not, so pressing Done scrolled the queue
  // 670-1800px toward its end during the card's 320ms fade (measured on a real stack) until the exit
  // landing snapped it back — and wherever no landing followed, the reader was left at the very bottom.
}

// Roll back the optimistic bubble appendQueuedMessage added, when the send actually FAILS. Removes
// the LAST still-queued message whose text matches (only optimistic entries carry `queued`, so a
// server-confirmed copy is never touched). Keeps the optimistic UX honest: a failed follow-up no
// longer leaves a phantom "sent" bubble the reload silently erases.
export function removeQueuedMessage(qc: QueryClient, slug: string, text: string, deliveryId?: string) {
  qc.setQueryData<TranscriptData>(["transcript", slug], (prev) => {
    if (!prev?.messages?.length) return prev
    const i = prev.messages.findLastIndex((m) => m.queued && m.role === "user" && m.text === text &&
      (deliveryId === undefined || m.deliveryId === deliveryId))
    if (i === -1) return prev
    return { ...prev, messages: prev.messages.filter((_, j) => j !== i) }
  })
}
