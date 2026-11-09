import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { createHash } from "node:crypto"
import { WebSocketServer, type WebSocket } from "ws"
import type { BoardDelta, BoardResyncReason, ServerEvent, SocketServerMsg, TranscriptMessage, TranscriptPushPage } from "@frizz/shared"
import { projectTranscriptSessionPeers, type SessionPeerThread } from "./session-peer.ts"
import { SocketClientMsg, frizzRoute, type RelayAccess } from "@frizz/shared"
import type { Bus } from "./bus.ts"
import type { Emitter } from "./bus.ts"
import type { Project } from "./project.ts"
import type { Storage } from "./storage.ts"
import type { AgentBackend } from "./backend/types.ts"
import { projectRetiredBackgroundOps, retiredOpsFor, projectTranscriptAgentLifecycles, projectTranscriptPeerNames, readLatestThreadTranscriptPage, type AgentLifecycleProjection } from "./transcript.ts"
import { isTrustedLocalWebSocketRequest, rejectWebSocketUpgrade } from "./local-origin.ts"
import { CALLER_HEADER } from "./audit.ts"
import { callerAccess, REMOTE_SOCKET_MESSAGES } from "./remote-gate.ts"

// Stage-2 multiplex: a noServer WebSocket at /ws carrying the board
// channel (deltas + notify — the stage-1 ServerEvent shapes, wrapped in {t:"event"}; never the board
// itself, which a client reads over HTTP and resumes from — see `initializeConnection`) AND per-thread
// transcript PUSH (replacing the client's 1.5s threadTranscript poll). index.ts routes the /ws upgrade
// here.

const WS_PATH = frizzRoute("/ws")

function isWsPath(url: string | undefined): boolean {
  return (url ?? "").split("?")[0] === WS_PATH
}

// ── subscription registry ─────────────────────────────────────────────────────────────────────────────
// Tracks which connections are subscribed to which thread transcripts, both directions (slug→conns for the
// producer fan-out, conn→slugs for O(1) cleanup on socket close). Generic over the connection type so it is
// unit-testable with a plain token. Subscribing the same conn+slug twice is idempotent (a Set).
export class SubscriptionRegistry<C> {
  private bySlug = new Map<string, Set<C>>()
  private byConn = new Map<C, Set<string>>()

  // Returns true iff this slug had NO subscribers before (the producer can skip work until the first).
  subscribe(conn: C, slug: string): boolean {
    const wasEmpty = !this.bySlug.has(slug)
    let conns = this.bySlug.get(slug)
    if (!conns) {
      conns = new Set()
      this.bySlug.set(slug, conns)
    }
    conns.add(conn)
    let slugs = this.byConn.get(conn)
    if (!slugs) {
      slugs = new Set()
      this.byConn.set(conn, slugs)
    }
    slugs.add(slug)
    return wasEmpty
  }

  unsubscribe(conn: C, slug: string): void {
    const conns = this.bySlug.get(slug)
    if (conns) {
      conns.delete(conn)
      if (conns.size === 0) this.bySlug.delete(slug)
    }
    const slugs = this.byConn.get(conn)
    if (slugs) {
      slugs.delete(slug)
      if (slugs.size === 0) this.byConn.delete(conn)
    }
  }

  // Drop a whole connection (socket close) — clears it from every slug it held. This is the leak-guard:
  // after removeConn, no slug set can still reference the closed connection.
  removeConn(conn: C): void {
    const slugs = this.byConn.get(conn)
    if (!slugs) return
    for (const slug of slugs) {
      const conns = this.bySlug.get(slug)
      if (conns) {
        conns.delete(conn)
        if (conns.size === 0) this.bySlug.delete(slug)
      }
    }
    this.byConn.delete(conn)
  }

  subscribers(slug: string): C[] {
    const conns = this.bySlug.get(slug)
    return conns ? [...conns] : []
  }

  hasSubscribers(slug: string): boolean {
    return this.bySlug.has(slug)
  }

  isSubscribed(conn: C, slug: string): boolean {
    return this.byConn.get(conn)?.has(slug) ?? false
  }

  slugsFor(conn: C): string[] {
    const slugs = this.byConn.get(conn)
    return slugs ? [...slugs] : []
  }

  // Live counts — for tests/assertions (a clean shutdown must leave both at 0).
  get slugCount(): number {
    return this.bySlug.size
  }
  get connCount(): number {
    return this.byConn.size
  }
}

// What one transcript read hands the push: the bounded latest window and, from a real reader, the page
// envelope the paged HTTP read returns beside it (see TranscriptPushPage). A bare harness omits the
// envelope and the frame goes out messages-only, exactly as it did before the envelope existed.
export interface TranscriptPush {
  messages: TranscriptMessage[]
  page?: TranscriptPushPage
}

// ── narrow deps ─────────────────────────────────────────────────────────────────────────────────────
// app-socket depends on this SUBSET of AppContext (not the whole thing) so the protocol is testable with
// fakes + an in-process ws client — no real board/tailer/storage needed.
export interface AppSocketDeps {
  bus: Pick<Bus, "subscribe">
  bootId: string
  transcriptChange: Pick<Emitter<string[]>, "on">
  currentSeq: () => number
  /** The board deltas published after `seq`, or null when they cannot all be produced (board.ts). */
  boardDeltasSince: (seq: number) => BoardDelta[] | null
  maxReplayBytes?: number
  readTranscript: (slug: string) => TranscriptPush
  /**
   * A promise while `readTranscript` would have to fold a cold transcript whole on this thread: it settles once
   * that work is done in slices (transcript.ts catchUpTranscriptFold), and the read goes ahead then. Undefined
   * means go ahead now. Absent (tests) means every read goes straight ahead.
   */
  catchUpTranscript?: (slug: string) => Promise<void> | undefined
  /**
   * Arm a live watch on a local file for the FILE topic: gate the path exactly as its read is gated,
   * then call `onChange` after each settled burst of changes until the returned release runs. Throws
   * for a path the gate refuses or a directory that cannot be watched — the subscription is then
   * quietly dropped, because the reader's own read has already told the client why. Absent (a bare
   * test harness), the topic is accepted and does nothing.
   */
  watchFile?: (path: string, onChange: () => void) => () => void
  /** Whether a read-and-answer session may read this path (remote-reads.ts). Absent means no. */
  mayReadRemotely?: (path: string) => boolean
  /** Write down what a remote socket was refused. */
  refusedRemotely?: (request: { stamp: string | undefined; userAgent: string | undefined }, detail: Record<string, unknown>) => void
  /** Narrow test/operational seams; production uses the conservative exported defaults below. */
  maxLogicalFrameBytes?: number
  maxFileWatchesPerConnection?: number
  maxOutputBufferBytes?: number
  maxConnections?: number
  maxSubscriptionsPerConnection?: number
  maxMessagesPerWindow?: number
  messageWindowMs?: number
  maxTranscriptReadsPerOrigin?: number
  maxTranscriptReadsOverall?: number
  transcriptReadWindowMs?: number
  maxTranscriptCacheEntries?: number
  maxTranscriptCacheBytes?: number
  bufferedAmount?: (ws: WebSocket) => number
  now?: () => number
  serializeMessage?: (msg: SocketServerMsg) => string
  /**
   * Arms the deferred subscription batch, and optionally returns a cancel for shutdown. Production uses
   * setImmediate — the check phase right after the poll phase that delivered the sub frames — so every
   * subscription read off one poll iteration shares a single read. A test injects a manual trigger to
   * make the batch BOUNDARY explicit: which frames land in one poll iteration is a property of the
   * kernel and the machine's load, never something a socket client can guarantee.
   */
  scheduleSubscriptionFlush?: (flush: () => void) => (() => void) | void
}

// Build the transcript reader index.ts injects — resolves a thread slug to its rendered latest window the
// SAME way router.ts's threadTranscript does (registry row → its session's JSONL; foreign slug → the
// session id itself; else []). Shared via readLatestThreadTranscriptPage so both producers render the
// same window of the same foreign or native thread.
export function makeTranscriptReader(
  project: Project,
  storage: Storage,
  backendFor?: (kind?: string) => AgentBackend,
  lifecycleFor?: (slug: string, id: string) => AgentLifecycleProjection | undefined,
  // Resolve an upward report's sender by its runtime agent id. This producer reads the WHOLE transcript,
  // so the fold usually names the child itself; this covers the residue the fold cannot see — a
  // grandchild whose dispatch lives in an ancestor's transcript, or a session resumed past its own
  // dispatch records. Same lookup the paged RPC uses, so the two producers cannot label one child two
  // ways (which is exactly how the profile-as-title reading survived).
  peerNameFor?: (slug: string, taskId: string) => { id: string; label: string } | undefined,
  // "The process that owned this thread's background ops is gone." Absent (tests / a bridge-less
  // server) ⇒ never gone, so nothing is retired that the × did not retire — the pre-existing behaviour.
  ownerGone?: (slug: string) => boolean,
  // The thread behind a cross-session message's sender (session-peer.ts) — the same lookup the paged
  // RPC uses, so the live push and the page head the card with the same link.
  sessionPeerThread?: (peer: NonNullable<TranscriptMessage["sessionPeer"]>) => SessionPeerThread | undefined,
): (slug: string) => TranscriptPush {
  return (slug: string) => {
    // The SAME bounded latest window the paged RPC serves (readLatestThreadTranscriptPage), never the
    // whole transcript. This read used to be readThreadTranscript — every message the thread had ever
    // produced — while the client's push reconciler was already written for a window that slides
    // (web/lib/transcriptPagination.ts reconcileLiveMessages). The whole transcript grows without bound,
    // so a long-running thread eventually crossed APP_SOCKET_MAX_LOGICAL_FRAME_BYTES, the server
    // answered every subscribe with payload-too-large, and the client parked the thread in a fallback
    // that refreshed on nothing but the banner's buttons: the /full page sat frozen until a hard reload
    // (maintainer 2026-09-16, a 19.5 MB codex rollout projecting to 4.47 MB against the 4 MB cap; the
    // window came to 0.5 MB). `editedFiles: false` skips the git-backed scan the page otherwise runs —
    // this producer fires on every byte-advance of every subscribed thread, and the rail keeps the copy
    // its last HTTP read delivered.
    const page = readLatestThreadTranscriptPage(project, storage, slug, backendFor)
    const named = peerNameFor ? projectTranscriptPeerNames(page.messages, (taskId) => peerNameFor(slug, taskId)) : page.messages
    const sent = sessionPeerThread ? projectTranscriptSessionPeers(named, sessionPeerThread) : named
    const projected = lifecycleFor ? projectTranscriptAgentLifecycles(sent, (id) => lifecycleFor(slug, id)) : sent
    // The operator's × has to reach THIS producer too, and it is the one that matters most: the live UI
    // renders from the /ws push, so projecting only the RPC left the killed shell's card reading
    // "RUNNING · 1 MIN 34 SEC" on screen while the RPC returned "cancelled". A dead OWNER retires the
    // same cards for a stronger reason and reaches the same two producers.
    const messages = projectRetiredBackgroundOps(projected, retiredOpsFor(storage, slug), ownerGone?.(slug) ?? false)
    return {
      messages,
      page: {
        beforeCursor: page.beforeCursor,
        hasEarlier: page.hasEarlier,
        reachedTurnBoundary: page.reachedTurnBoundary,
        transcriptKey: page.transcriptKey,
      },
    }
  }
}

export interface AppSocketServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): Promise<void>
  // Exposed for tests/observability — the live subscription registry.
  registry: SubscriptionRegistry<WebSocket>
  // Count of cached per-slug transcript signatures — for tests to assert no unbounded growth.
  readonly lastSigSize: number
  // Bounded process-wide resource gauges — intentionally narrow, read-only observability for tests.
  readonly connectionCount: number
  readonly transcriptCacheEntries: number
  readonly transcriptCacheBytes: number
  readonly pendingTranscriptRefreshes: number
  // Live file watches held across every connection — a clean close must leave 0.
  readonly fileWatchCount: number
}

const HEARTBEAT_MS = 10_000
export const APP_SOCKET_MAX_MESSAGE_BYTES = 1_048_576
export const APP_SOCKET_MAX_LOGICAL_FRAME_BYTES = 4 * 1_024 * 1_024
export const APP_SOCKET_MAX_OUTPUT_BUFFER_BYTES = 4 * 1_024 * 1_024
// The most a resume replays before it answers `board-resync` instead. A replay goes out in one burst, so
// it has to stay well inside the output buffer above (past it the socket is closed as a slow consumer,
// and the reconnect would replay the same burst again); past ~1 MiB of deltas, reading the board over
// gzipped HTTP is also simply the cheaper way to catch up.
export const APP_SOCKET_MAX_REPLAY_BYTES = 1 * 1_024 * 1_024
export const APP_SOCKET_MAX_CONNECTIONS = 64
export const APP_SOCKET_MAX_SUBSCRIPTIONS = 32
// One open document per reader, and the readers stack (a drawer over a drawer over the split viewer):
// sixteen is far past what a page can show and far short of what an OS watch table minds.
export const APP_SOCKET_MAX_FILE_WATCHES = 16
export const APP_SOCKET_MAX_MESSAGES_PER_WINDOW = 120
export const APP_SOCKET_MESSAGE_WINDOW_MS = 1_000
export const APP_SOCKET_MAX_TRANSCRIPT_READS_PER_ORIGIN = 16
export const APP_SOCKET_MAX_TRANSCRIPT_READS_OVERALL = 64
export const APP_SOCKET_TRANSCRIPT_READ_WINDOW_MS = 1_000
export const APP_SOCKET_MAX_TRANSCRIPT_CACHE_ENTRIES = 128
export const APP_SOCKET_MAX_TRANSCRIPT_CACHE_BYTES = 32 * 1_024 * 1_024

// `ws` defaults perMessageDeflate to OFF, so every frame went out raw while the SAME board went over
// HTTP gzipped by the compression middleware. Measured 2026-09-04 on the maintainer's own board: 914 KB
// raw, 158 KB gzip — a 5.8x difference, paid on the handshake keyframe of every page load and again on
// every board push after it. (The board has not ridden the socket since 2026-10-14; a long transcript
// window and a bulk delta still do.) Loopback bandwidth is cheap, but the browser still has to receive and the
// server still has to write 914 KB, and on a relayed/remote origin it is the whole cost.
//
// The threshold keeps the small frames raw: a per-frame deflate on a 200-byte tail event costs more in
// CPU and zlib bookkeeping than it saves, and those frames are the common case. The memLevel and
// concurrency caps are the `ws` documentation's own guardrails against per-connection zlib memory,
// which is the reason the default is off at all.
export const APP_SOCKET_DEFLATE = {
  threshold: 8 * 1_024,
  concurrencyLimit: 10,
  zlibDeflateOptions: { level: 6, memLevel: 8 },
  // A sliding window is negotiated per connection and costs memory on both ends for the whole
  // connection's life; these frames are independently compressible, so decline the context takeover.
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
} as const

export function createAppSocketServer(deps: AppSocketDeps): AppSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: APP_SOCKET_MAX_MESSAGE_BYTES,
    perMessageDeflate: APP_SOCKET_DEFLATE,
  })
  const registry = new SubscriptionRegistry<WebSocket>()
  const boundedCount = (value: number | undefined, fallback: number): number => {
    const candidate = value ?? fallback
    return Number.isFinite(candidate) ? Math.max(0, Math.floor(candidate)) : fallback
  }
  const positiveDuration = (value: number | undefined, fallback: number): number => {
    const candidate = value ?? fallback
    return Number.isFinite(candidate) ? Math.max(1, Math.floor(candidate)) : fallback
  }
  const maxLogicalFrameBytes = deps.maxLogicalFrameBytes ?? APP_SOCKET_MAX_LOGICAL_FRAME_BYTES
  const maxOutputBufferBytes = deps.maxOutputBufferBytes ?? APP_SOCKET_MAX_OUTPUT_BUFFER_BYTES
  const maxReplayBytes = deps.maxReplayBytes ?? APP_SOCKET_MAX_REPLAY_BYTES
  const maxConnections = boundedCount(deps.maxConnections, APP_SOCKET_MAX_CONNECTIONS)
  const maxSubscriptions = deps.maxSubscriptionsPerConnection ?? APP_SOCKET_MAX_SUBSCRIPTIONS
  const maxFileWatches = boundedCount(deps.maxFileWatchesPerConnection, APP_SOCKET_MAX_FILE_WATCHES)
  const maxMessagesPerWindow = deps.maxMessagesPerWindow ?? APP_SOCKET_MAX_MESSAGES_PER_WINDOW
  const messageWindowMs = deps.messageWindowMs ?? APP_SOCKET_MESSAGE_WINDOW_MS
  const maxTranscriptReadsPerOrigin = boundedCount(
    deps.maxTranscriptReadsPerOrigin,
    APP_SOCKET_MAX_TRANSCRIPT_READS_PER_ORIGIN,
  )
  const maxTranscriptReadsOverall = boundedCount(
    deps.maxTranscriptReadsOverall,
    APP_SOCKET_MAX_TRANSCRIPT_READS_OVERALL,
  )
  const transcriptReadWindowMs = positiveDuration(
    deps.transcriptReadWindowMs,
    APP_SOCKET_TRANSCRIPT_READ_WINDOW_MS,
  )
  const maxTranscriptCacheEntries = boundedCount(
    deps.maxTranscriptCacheEntries,
    APP_SOCKET_MAX_TRANSCRIPT_CACHE_ENTRIES,
  )
  const maxTranscriptCacheBytes = boundedCount(
    deps.maxTranscriptCacheBytes,
    APP_SOCKET_MAX_TRANSCRIPT_CACHE_BYTES,
  )
  const bufferedAmount = deps.bufferedAmount ?? ((ws: WebSocket) => ws.bufferedAmount)
  const now = deps.now ?? Date.now
  const serializeMessage = deps.serializeMessage ?? JSON.stringify
  const scheduleSubscriptionFlush = deps.scheduleSubscriptionFlush
    ?? ((flush: () => void) => {
      const immediate = setImmediate(flush)
      immediate.unref?.()
      return () => clearImmediate(immediate)
    })
  const terminationTimers = new WeakMap<WebSocket, NodeJS.Timeout>()
  let closing = false
  let closePromise: Promise<void> | null = null
  let connectionCount = 0
  let pendingUpgrades = 0
  const socketOrigins = new WeakMap<WebSocket, string>()
  // Per-slug signature of the last BROADCAST transcript — dedupes an unchanged re-read (a tailer tick that
  // advanced the file with records the transcript renderer ignores) so we don't push identical frames.
  const lastSig = new Map<string, string>()

  // ── the FILE topic ─────────────────────────────────────────────────────────────────────────────────
  // Per connection, the local files its readers have open, each holding the release of a live watch.
  // Keyed by the path AS SUBSCRIBED: that is what the client keys its query by, so it is what the
  // `file-changed` frame carries back. The watch itself is shared per canonical path underneath
  // (local-file-watch.ts), so two readers on one file cost one OS watch.
  const fileWatches = new WeakMap<WebSocket, Map<string, () => void>>()
  let fileWatchCount = 0
  // Sockets a remote caller opened, with what the proxy stamped on the upgrade: it is the only request
  // these messages ever had. A socket outlives its upgrade, so the answer is kept, not re-derived.
  const remoteSockets = new WeakMap<WebSocket, { stamp: string | undefined; userAgent: string | undefined; access: RelayAccess }>()

  function subscribeFile(ws: WebSocket, path: string): void {
    const remote = remoteSockets.get(ws)
    if (remote?.access === "read-and-answer" && !deps.mayReadRemotely?.(path)) {
      // Dropped without a word, as a path that cannot be watched is below: the frame this would have sent
      // is only ever a change notice, and silence says nothing about what exists.
      deps.refusedRemotely?.(remote, { socket: "file" })
      return
    }
    let held = fileWatches.get(ws)
    if (!held) {
      held = new Map()
      fileWatches.set(ws, held)
    }
    // A duplicate is a true no-op, as a duplicate transcript subscription is.
    if (held.has(path)) return
    if (held.size >= maxFileWatches) {
      closeSocket(ws, 1008, "subscription limit exceeded")
      return
    }
    const watchFile = deps.watchFile
    if (!watchFile) return
    let release: () => void
    try {
      release = watchFile(path, () => {
        sendMsg(ws, { t: "file-changed", path })
      })
    } catch {
      // The gate refused it, or its directory is gone. The reader's own read reports the same file in
      // its own words; a watch that never arms is the right answer here, not a closed socket.
      return
    }
    held.set(path, release)
    fileWatchCount++
  }

  function unsubscribeFile(ws: WebSocket, path: string): void {
    const held = fileWatches.get(ws)
    const release = held?.get(path)
    if (!held || !release) return
    held.delete(path)
    fileWatchCount--
    try {
      release()
    } catch {
      // A watch the OS already dropped has nothing left to release.
    }
  }

  function dropFileWatches(ws: WebSocket): void {
    const held = fileWatches.get(ws)
    if (!held) return
    fileWatches.delete(ws)
    for (const release of held.values()) {
      fileWatchCount--
      try {
        release()
      } catch {
        // As above.
      }
    }
  }

  function closeSocket(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) return
    try {
      ws.close(code, reason)
      // A peer that stopped reading may never consume the close frame. Reclaim it after a short grace;
      // normal clients complete the handshake and clear this timer in their close handler.
      const prior = terminationTimers.get(ws)
      if (prior) clearTimeout(prior)
      const timer = setTimeout(() => {
        try {
          ws.terminate()
        } catch {
          // Already closed.
        }
      }, 250)
      timer.unref?.()
      terminationTimers.set(ws, timer)
    } catch {
      try {
        ws.terminate()
      } catch {
        // Already closed.
      }
    }
  }

  interface EncodedMessage {
    text: string
    bytes: number
  }
  type SendResult =
    | { kind: "sent" }
    | { kind: "unavailable" }
    | { kind: "slow" }
    | { kind: "backpressure" }
    | { kind: "oversized"; actualBytes: number }

  // How a channel sheds when this peer's queued output would breach the cap.
  //  • "close" — the board channel. Its frames are an ORDERED delta stream: a dropped frame tears the
  //    client's incremental base, so the only sound shed is to drop the connection; the client's next
  //    socket resumes from the last seq it applied, and the ring replays the rest.
  //  • "skip"  — the transcript channel. Its frames are IDEMPOTENT FULL SNAPSHOTS, so a backed-up peer
  //    loses nothing by not queueing this generation: the slug stays dirty and the NEWER snapshot goes
  //    out once the peer drains. Closing here is actively harmful — the client's recovery is to reconnect
  //    and replay every subscription at once, i.e. a strictly LARGER burst than the one that shed it, so
  //    the cap trips again on the next generation and the connection flaps forever (connecting/connected)
  //    without ever reaching a state the user can read as broken.
  type ShedPolicy = "close" | "skip"

  // A skipped generation retries on this cadence. Retries are cheap: with no intervening change edge the
  // snapshot cache still holds the encoded frame, so a retry costs neither a disk read nor a serialization.
  const BACKPRESSURE_RETRY_MS = 250

  function encodeMsg(msg: SocketServerMsg): EncodedMessage | null {
    try {
      const text = serializeMessage(msg)
      return { text, bytes: Buffer.byteLength(text, "utf8") }
    } catch {
      return null
    }
  }

  // Logical frame size and queued transport pressure are different failure classes. A payload that is
  // intrinsically too large gets a typed, non-closing downgrade below; a bounded frame that cannot be
  // queued because this peer stopped reading is still shed as a slow consumer.
  function sendEncoded(
    ws: WebSocket,
    frame: EncodedMessage,
    enforceLogicalLimit = true,
    shed: ShedPolicy = "close",
  ): SendResult {
    if (ws.readyState !== ws.OPEN) return { kind: "unavailable" }
    if (enforceLogicalLimit && frame.bytes > maxLogicalFrameBytes) {
      return { kind: "oversized", actualBytes: frame.bytes }
    }
    if (bufferedAmount(ws) + frame.bytes > maxOutputBufferBytes) {
      if (shed === "skip") return { kind: "backpressure" }
      closeSocket(ws, 1013, "client too slow")
      return { kind: "slow" }
    }
    try {
      ws.send(frame.text, (error) => {
        if (error) closeSocket(ws, 1011, "transport failed")
      })
      return { kind: "sent" }
    } catch {
      closeSocket(ws, 1011, "transport failed")
      return { kind: "unavailable" }
    }
  }

  function sendMsg(ws: WebSocket, msg: SocketServerMsg): SendResult {
    const frame = encodeMsg(msg)
    if (!frame) {
      closeSocket(ws, 1011, "serialization failed")
      return { kind: "unavailable" }
    }
    return sendEncoded(ws, frame)
  }

  function sendPayloadTooLarge(
    ws: WebSocket,
    msg: Extract<SocketServerMsg, { t: "payload-too-large" }>,
  ): void {
    const frame = encodeMsg(msg)
    if (!frame) {
      closeSocket(ws, 1011, "serialization failed")
      return
    }
    // The small control frame must not recursively fail the logical-payload limit it reports. It still
    // obeys the real queued-output cap, so an actually slow peer is reclaimed normally.
    sendEncoded(ws, frame, false)
  }

  function sendResourceLimited(
    ws: WebSocket,
    msg: Extract<SocketServerMsg, { t: "resource-limited" }>,
  ): void {
    const frame = encodeMsg(msg)
    if (!frame) {
      closeSocket(ws, 1011, "serialization failed")
      return
    }
    // Like payload-too-large, this is a small control frame describing why ONE subscription was
    // rejected. It bypasses the logical data-frame limit but never the queued-output/slow-peer bound.
    sendEncoded(ws, frame, false)
  }

  function frameSignature(frame: EncodedMessage): string {
    return createHash("sha256").update(frame.text).digest("base64url")
  }

  // ── aggregate transcript read budget ─────────────────────────────────────────────────────────────
  // Sliding timestamps (rather than resettable fixed windows) prevent a client from taking one full
  // allowance immediately before a boundary and another immediately after it. Origin reservations make
  // one noisy browser identity unable to consume every on-demand read; global reservations bound all
  // actual full reads, including tailer-driven refreshes shared by many origins.
  const globalReadTimes: number[] = []
  const originReadTimes = new Map<string, number[]>()
  const effectiveReadWindowMs = Math.max(1, transcriptReadWindowMs)
  let lastReadBudgetAt = Number.NEGATIVE_INFINITY

  function readBudgetNow(): number {
    const candidate = now()
    if (Number.isFinite(candidate)) lastReadBudgetAt = Math.max(lastReadBudgetAt, candidate)
    if (!Number.isFinite(lastReadBudgetAt)) lastReadBudgetAt = Date.now()
    return lastReadBudgetAt
  }

  function pruneReadTimes(times: number[], at: number): void {
    const expiredAt = at - effectiveReadWindowMs
    while (times.length && times[0] <= expiredAt) times.shift()
  }

  function retryAfter(times: number[], limit: number, at: number): number {
    if (limit <= 0 || !times.length) return effectiveReadWindowMs
    return Math.max(1, Math.ceil(times[0] + effectiveReadWindowMs - at))
  }

  type ReadReservation =
    | { kind: "allowed" }
    | { kind: "limited"; scope: "origin" | "global"; retryAfterMs: number }

  function reserveTranscriptRead(origin?: string): ReadReservation {
    const at = readBudgetNow()
    pruneReadTimes(globalReadTimes, at)
    let perOrigin: number[] | undefined
    if (origin) {
      perOrigin = originReadTimes.get(origin)
      if (!perOrigin) {
        perOrigin = []
        originReadTimes.set(origin, perOrigin)
      }
      pruneReadTimes(perOrigin, at)
      if (perOrigin.length >= maxTranscriptReadsPerOrigin) {
        return {
          kind: "limited",
          scope: "origin",
          retryAfterMs: retryAfter(perOrigin, maxTranscriptReadsPerOrigin, at),
        }
      }
    }
    if (globalReadTimes.length >= maxTranscriptReadsOverall) {
      return {
        kind: "limited",
        scope: "global",
        retryAfterMs: retryAfter(globalReadTimes, maxTranscriptReadsOverall, at),
      }
    }
    globalReadTimes.push(at)
    perOrigin?.push(at)
    return { kind: "allowed" }
  }

  // ── bounded encoded transcript snapshot cache ────────────────────────────────────────────────────
  // Cache the exact encoded frame, not both the message graph and another JSON copy. Hits therefore do
  // zero disk/parse work AND zero full-frame serialization. Map insertion order is the LRU order.
  // Entries are evicted as soon as the last subscriber leaves, so a forgotten thread cannot be served
  // from stale retained content; tailer invalidation deletes the entry synchronously before refresh.
  interface TranscriptSnapshot {
    frame: EncodedMessage
    sig: string
    weight: number
  }
  const transcriptCache = new Map<string, TranscriptSnapshot>()
  let transcriptCacheBytes = 0

  function snapshotWeight(frame: EncodedMessage): number {
    // V8 strings may occupy two bytes/code-unit; take the larger of UTF-8 wire bytes and that
    // conservative in-memory estimate. Small Map/object overhead is bounded by the separate entry cap.
    return Math.max(frame.bytes, frame.text.length * 2)
  }

  function deleteTranscriptSnapshot(slug: string): void {
    const cached = transcriptCache.get(slug)
    if (!cached) return
    transcriptCache.delete(slug)
    transcriptCacheBytes -= cached.weight
  }

  function getTranscriptSnapshot(slug: string): TranscriptSnapshot | undefined {
    const cached = transcriptCache.get(slug)
    if (!cached) return undefined
    transcriptCache.delete(slug)
    transcriptCache.set(slug, cached)
    return cached
  }

  function cacheTranscriptSnapshot(slug: string, snapshot: TranscriptSnapshot): void {
    deleteTranscriptSnapshot(slug)
    if (
      maxTranscriptCacheEntries <= 0
      || maxTranscriptCacheBytes <= 0
      || snapshot.weight > maxTranscriptCacheBytes
    ) return
    transcriptCache.set(slug, snapshot)
    transcriptCacheBytes += snapshot.weight
    while (
      transcriptCache.size > maxTranscriptCacheEntries
      || transcriptCacheBytes > maxTranscriptCacheBytes
    ) {
      const oldest = transcriptCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      deleteTranscriptSnapshot(oldest)
    }
  }

  function clearTranscriptSnapshots(): void {
    transcriptCache.clear()
    transcriptCacheBytes = 0
  }

  function readTranscript(slug: string): TranscriptPush | null {
    try {
      return deps.readTranscript(slug)
    } catch {
      return null
    }
  }

  type SnapshotResult =
    | { kind: "ready"; snapshot: TranscriptSnapshot }
    | { kind: "unavailable" }
    | { kind: "oversized"; actualBytes: number }
    | { kind: "limited"; scope: "origin" | "global"; retryAfterMs: number }
    | { kind: "folding"; done: Promise<void> }

  function snapshotFor(slug: string, origin?: string): SnapshotResult {
    const cached = getTranscriptSnapshot(slug)
    if (cached) return { kind: "ready", snapshot: cached }
    // Before the read budget: a read that has not happened yet has spent nothing.
    const folding = deps.catchUpTranscript?.(slug)
    if (folding) return { kind: "folding", done: folding }
    const reservation = reserveTranscriptRead(origin)
    if (reservation.kind === "limited") return reservation
    const read = readTranscript(slug)
    if (!read) return { kind: "unavailable" }
    const frame = encodeMsg(read.page ? { t: "transcript", slug, messages: read.messages, page: read.page } : { t: "transcript", slug, messages: read.messages })
    if (!frame) return { kind: "unavailable" }
    if (frame.bytes > maxLogicalFrameBytes) return { kind: "oversized", actualBytes: frame.bytes }
    const snapshot = { frame, sig: frameSignature(frame), weight: snapshotWeight(frame) }
    cacheTranscriptSnapshot(slug, snapshot)
    return { kind: "ready", snapshot }
  }

  function dropSubscription(ws: WebSocket, slug: string): void {
    registry.unsubscribe(ws, slug)
    if (!registry.hasSubscribers(slug)) {
      lastSig.delete(slug)
      deleteTranscriptSnapshot(slug)
    }
  }

  // Read + push one slug's current transcript to a SINGLE connection (the immediate on-subscribe push).
  // Seeds lastSig so a subsequent identical broadcast is deduped — but ONLY when this connection is the
  // SOLE subscriber. With multiple subscribers, seeding here would suppress the producer's pending
  // broadcast of this SAME change to the OTHER (already-subscribed) connections, leaving them stale until
  // the next change. Called right after registry.subscribe, so subscribers(slug) includes this conn.
  function pushSnapshotResult(ws: WebSocket, slug: string, result: SnapshotResult): void {
    if (result.kind === "folding") {
      void result.done.then(() => {
        if (!closing && ws.readyState === ws.OPEN && registry.isSubscribed(ws, slug)) enqueueSubscriptionPush(ws, slug)
      })
      return
    }
    if (result.kind === "unavailable") {
      closeSocket(ws, 1011, "transcript unavailable")
      return
    }
    if (result.kind === "limited") {
      dropSubscription(ws, slug)
      sendResourceLimited(ws, {
        t: "resource-limited",
        resource: "transcript-read",
        scope: result.scope,
        slug,
        retryAfterMs: result.retryAfterMs,
      })
      return
    }
    if (result.kind === "oversized") {
      dropSubscription(ws, slug)
      sendPayloadTooLarge(ws, {
        t: "payload-too-large",
        channel: "transcript",
        slug,
        actualBytes: result.actualBytes,
        maxBytes: maxLogicalFrameBytes,
      })
      return
    }
    const sent = sendEncoded(ws, result.snapshot.frame, true, "skip")
    if (sent.kind === "backpressure") {
      // Keep the subscription: this peer is merely behind, not broken. Leave the slug dirty so the next
      // flush delivers the CURRENT snapshot, and never seed lastSig — that would dedupe away the very
      // frame this connection has not received yet.
      requeueTranscript(slug)
      return
    }
    if (sent.kind === "sent" && registry.subscribers(slug).length <= 1) {
      lastSig.set(slug, result.snapshot.sig)
    }
  }

  // Mark a slug for redelivery after a backpressure skip, on a fixed short cadence.
  function requeueTranscript(slug: string): void {
    if (closing) return
    pendingTranscriptRefreshes.add(slug)
    scheduleTranscriptFlush(BACKPRESSURE_RETRY_MS)
  }

  // New subscriptions are deferred to one check-phase batch. All sockets that arrive in that batch
  // share the first fresh read/encoded snapshot; a LATER batch first invalidates retained cache so it
  // preserves the historical guarantee that a late subscriber sees disk truth even in the small gap
  // before the tailer emits its change edge. Map+Set dedupes sub/unsub/sub churn within the same batch.
  const pendingSubscriptionPushes = new Map<WebSocket, Set<string>>()
  let subscriptionFlushArmed = false
  let cancelSubscriptionFlush: (() => void) | null = null

  function flushSubscriptionPushes(): void {
    subscriptionFlushArmed = false
    cancelSubscriptionFlush = null
    if (closing) {
      pendingSubscriptionPushes.clear()
      return
    }
    const batch = [...pendingSubscriptionPushes]
    pendingSubscriptionPushes.clear()
    const batchResults = new Map<string, SnapshotResult>()
    for (const [candidate, candidateSlugs] of batch) {
      if (candidate.readyState !== candidate.OPEN) continue
      for (const candidateSlug of candidateSlugs) {
        if (!registry.isSubscribed(candidate, candidateSlug)) continue
        let result = batchResults.get(candidateSlug)
        if (!result || (result.kind === "limited" && result.scope === "origin")) {
          result = snapshotFor(candidateSlug, socketOrigins.get(candidate))
          // An origin denial is local to that origin; let the next origin attempt its own fair share.
          // Every other outcome describes the one process-wide read/result and is safe to share.
          if (!(result.kind === "limited" && result.scope === "origin")) {
            batchResults.set(candidateSlug, result)
          }
        }
        pushSnapshotResult(candidate, candidateSlug, result)
      }
    }
  }

  function enqueueSubscriptionPush(ws: WebSocket, slug: string): void {
    deleteTranscriptSnapshot(slug)
    let slugs = pendingSubscriptionPushes.get(ws)
    if (!slugs) {
      slugs = new Set()
      pendingSubscriptionPushes.set(ws, slugs)
    }
    slugs.add(slug)
    if (subscriptionFlushArmed) return
    subscriptionFlushArmed = true
    const cancel = scheduleSubscriptionFlush(flushSubscriptionPushes)
    // A scheduler that ran the flush synchronously has already disarmed; don't retain its dead cancel.
    if (subscriptionFlushArmed) cancelSubscriptionFlush = cancel ?? null
  }

  function cancelPendingSubscriptionPush(ws: WebSocket, slug?: string): void {
    if (slug === undefined) {
      pendingSubscriptionPushes.delete(ws)
      return
    }
    const slugs = pendingSubscriptionPushes.get(ws)
    if (!slugs) return
    slugs.delete(slug)
    if (!slugs.size) pendingSubscriptionPushes.delete(ws)
  }

  // Producer invalidations coalesce by slug in one microtask. A global-budget miss retains the dirty slug
  // and arms ONE retry timer for the earliest token; further invalidations merely join the same set/timer.
  // This preserves eventual freshness without a timer/read amplification loop.
  const pendingTranscriptRefreshes = new Set<string>()
  let transcriptFlushQueued = false
  let transcriptRefreshTimer: NodeJS.Timeout | null = null

  function scheduleTranscriptFlush(delayMs = 0): void {
    if (closing) return
    if (delayMs > 0) {
      if (transcriptRefreshTimer || transcriptFlushQueued) return
      transcriptRefreshTimer = setTimeout(() => {
        transcriptRefreshTimer = null
        scheduleTranscriptFlush()
      }, Math.max(1, Math.ceil(delayMs)))
      transcriptRefreshTimer.unref?.()
      return
    }
    // An existing budget timer is the one allowed retry edge. New invalidations join it without probing.
    if (transcriptRefreshTimer || transcriptFlushQueued) return
    transcriptFlushQueued = true
    queueMicrotask(() => {
      transcriptFlushQueued = false
      flushTranscriptChanges()
    })
  }

  function flushTranscriptChanges(): void {
    if (closing) {
      pendingTranscriptRefreshes.clear()
      return
    }
    const slugs = [...pendingTranscriptRefreshes]
    pendingTranscriptRefreshes.clear()
    let retryMs: number | undefined
    for (const slug of slugs) {
      if (!registry.hasSubscribers(slug)) {
        lastSig.delete(slug)
        deleteTranscriptSnapshot(slug)
        continue
      }
      const result = snapshotFor(slug) // shared producer refresh: global budget only
      if (result.kind === "folding") {
        void result.done.then(() => {
          pendingTranscriptRefreshes.add(slug)
          scheduleTranscriptFlush()
        })
        continue
      }
      if (result.kind === "limited") {
        if (maxTranscriptReadsOverall === 0) {
          for (const ws of registry.subscribers(slug)) {
            dropSubscription(ws, slug)
            sendResourceLimited(ws, {
              t: "resource-limited",
              resource: "transcript-read",
              scope: "global",
              slug,
              retryAfterMs: result.retryAfterMs,
            })
          }
          deleteTranscriptSnapshot(slug)
          continue
        }
        pendingTranscriptRefreshes.add(slug)
        retryMs = retryMs === undefined ? result.retryAfterMs : Math.min(retryMs, result.retryAfterMs)
        continue
      }
      if (result.kind === "unavailable") {
        for (const ws of registry.subscribers(slug)) closeSocket(ws, 1011, "transcript unavailable")
        lastSig.delete(slug)
        deleteTranscriptSnapshot(slug)
        continue
      }
      if (result.kind === "oversized") {
        const subscribers = registry.subscribers(slug)
        for (const ws of subscribers) {
          dropSubscription(ws, slug)
          sendPayloadTooLarge(ws, {
            t: "payload-too-large",
            channel: "transcript",
            slug,
            actualBytes: result.actualBytes,
            maxBytes: maxLogicalFrameBytes,
          })
        }
        lastSig.delete(slug)
        deleteTranscriptSnapshot(slug)
        continue
      }
      if (result.snapshot.sig === lastSig.get(slug)) continue
      let sent = false
      let skipped = false
      for (const ws of registry.subscribers(slug)) {
        const outcome = sendEncoded(ws, result.snapshot.frame, true, "skip")
        if (outcome.kind === "sent") sent = true
        else if (outcome.kind === "backpressure") skipped = true
      }
      // A skipped peer must not be stranded: hold the slug dirty (and withhold lastSig, which would
      // otherwise dedupe the redelivery away) until every subscriber has actually taken a generation.
      if (skipped) {
        pendingTranscriptRefreshes.add(slug)
        retryMs = retryMs === undefined ? BACKPRESSURE_RETRY_MS : Math.min(retryMs, BACKPRESSURE_RETRY_MS)
        continue
      }
      if (sent) lastSig.set(slug, result.snapshot.sig)
    }
    if (pendingTranscriptRefreshes.size) scheduleTranscriptFlush(retryMs ?? 0)
  }

  const offTranscript = deps.transcriptChange.on((slugs) => {
    if (closing) return
    for (const slug of slugs) {
      deleteTranscriptSnapshot(slug) // dirty NOW: a same-tick subscriber can never receive old content
      pendingTranscriptRefreshes.add(slug)
    }
    if (pendingTranscriptRefreshes.size) scheduleTranscriptFlush()
  })

  function initializeConnection(ws: WebSocket): void {
    if (closing) {
      closeSocket(ws, 1012, "server restarting")
      return
    }
    // THE BOARD CHANNEL CARRIES DELTAS, NEVER A BOARD. The client reads the board over HTTP (the
    // `boardState` query) and then names the (boot, seq) it holds with a {t:"board"} message; from then
    // on this connection forwards every delta after that seq — the ones it missed first, from the
    // board's ring of recent deltas, then live ones — and nothing before. `boardSeq` is the last seq
    // this connection has delivered, null while the client has not asked (or must read the board
    // again). The bus is subscribed for the connection's whole life, so the notify/invalidation events
    // flow from the first frame; only board deltas wait for the client's seq.
    //
    // Everything here is synchronous, from the ring read to the live subscription: no publish can land
    // between the replay and the first live delta, and the seq check below would drop a duplicate if
    // one did. A board too big for one frame is therefore never a reason to leave the socket — the
    // only multi-megabyte board message there ever was is gone (it went out as the connect keyframe
    // until 2026-10-14, and past 4 MiB sent the tab to SSE).
    let boardSeq: number | null = null
    let unsubscribeBus = () => {}
    const resyncBoard = (reason: BoardResyncReason): void => {
      boardSeq = null
      const frame = encodeMsg({ t: "board-resync", reason })
      if (!frame) {
        closeSocket(ws, 1011, "serialization failed")
        return
      }
      // A small control frame: never held to the logical data limit it may be reporting.
      sendEncoded(ws, frame, false)
    }
    const sendBoardDelta = (event: BoardDelta, encoded?: EncodedMessage): void => {
      if (boardSeq === null || event.seq <= boardSeq) return
      if (event.seq !== boardSeq + 1) {
        // Not reachable from the ring, which is contiguous; refusing it beats delivering a hole.
        resyncBoard("expired")
        return
      }
      boardSeq = event.seq
      const frame = encoded ?? encodeMsg({ t: "event", event })
      if (!frame) {
        closeSocket(ws, 1011, "serialization failed")
        return
      }
      const result = sendEncoded(ws, frame)
      // One delta bigger than a frame (a bulk change to every thread) is skipped by reading the
      // board over HTTP again; the board read there already includes it.
      if (result.kind === "oversized") resyncBoard("oversized")
    }
    const sendOtherEvent = (event: ServerEvent): void => {
      // Notify and invalidation events are small by construction (a notify's body is one capped
      // line). One that is not is dropped: it carries no state a client could miss, and the
      // payload-too-large notice for the board channel would send a client to SSE for nothing.
      sendMsg(ws, { t: "event", event })
    }
    const resumeBoard = (bootId: string, seq: number): void => {
      boardSeq = null
      if (bootId !== deps.bootId) return resyncBoard("boot")
      const missed = deps.boardDeltasSince(seq)
      if (!missed) return resyncBoard(seq > deps.currentSeq() ? "ahead" : "expired")
      // Encoded before anything is sent, so a replay too big to burst is answered with a resync rather
      // than started and cut off.
      const frames: EncodedMessage[] = []
      let bytes = 0
      for (const event of missed) {
        const frame = encodeMsg({ t: "event", event })
        if (!frame) {
          closeSocket(ws, 1011, "serialization failed")
          return
        }
        bytes += frame.bytes
        if (bytes > maxReplayBytes) return resyncBoard("expired")
        frames.push(frame)
      }
      boardSeq = seq
      for (let i = 0; i < missed.length; i++) {
        sendBoardDelta(missed[i]!, frames[i])
        if (boardSeq === null) return
      }
    }
    try {
      unsubscribeBus = deps.bus.subscribe((event) => {
        if (event.type === "board-delta") sendBoardDelta(event)
        else if (event.type !== "board") sendOtherEvent(event)
      })
    } catch {
      closeSocket(ws, 1011, "board unavailable")
      return
    }
    // The first frame: which server this is and where its board stands. It is also what tells the
    // client the protocol is live, so it can replay its subscriptions.
    sendMsg(ws, { t: "hello", bootId: deps.bootId, seq: deps.currentSeq() })

    const heartbeat = setInterval(() => sendMsg(ws, { t: "hb" }), HEARTBEAT_MS)
    heartbeat.unref?.()
    let windowStartedAt = now()
    let messagesInWindow = 0

    ws.on("message", (raw, isBinary) => {
      // close() flips readyState synchronously. Ignore frames already parsed/queued by ws after any
      // policy violation so a single coalesced flood cannot keep reaching transcript work while the
      // close handshake drains.
      if (closing || ws.readyState !== ws.OPEN) return
      const at = now()
      if (at - windowStartedAt >= messageWindowMs) {
        windowStartedAt = at
        messagesInWindow = 0
      }
      messagesInWindow++
      if (messagesInWindow > maxMessagesPerWindow) {
        closeSocket(ws, 1008, "message rate exceeded")
        return
      }
      if (isBinary) {
        closeSocket(ws, 1003, "text frames required")
        return
      }
      let decoded: unknown
      try {
        decoded = JSON.parse(raw.toString())
      } catch {
        closeSocket(ws, 1008, "invalid message")
        return
      }
      const parsed = SocketClientMsg.safeParse(decoded)
      if (!parsed.success) {
        closeSocket(ws, 1008, "invalid message")
        return
      }
      const msg = parsed.data
      if (remoteSockets.has(ws) && !REMOTE_SOCKET_MESSAGES[msg.t]) {
        deps.refusedRemotely?.(remoteSockets.get(ws)!, { socket: msg.t })
        closeSocket(ws, 1008, "not available remotely")
        return
      }
      if (msg.t === "board") {
        resumeBoard(msg.bootId, msg.seq)
        return
      }
      if (msg.topic === "file") {
        if (msg.t === "sub") subscribeFile(ws, msg.path)
        else unsubscribeFile(ws, msg.path)
        return
      }
      if (msg.t === "sub") {
        // A duplicate subscription is a true no-op: it consumes rate budget but cannot force another
        // disk read or transcript serialization.
        if (registry.isSubscribed(ws, msg.slug)) return
        if (registry.slugsFor(ws).length >= maxSubscriptions) {
          closeSocket(ws, 1008, "subscription limit exceeded")
          return
        }
        registry.subscribe(ws, msg.slug)
        enqueueSubscriptionPush(ws, msg.slug)
      } else if (msg.t === "unsub") {
        cancelPendingSubscriptionPush(ws, msg.slug)
        dropSubscription(ws, msg.slug)
      }
    })

    ws.on("close", () => {
      try {
        unsubscribeBus()
      } catch {
        // A broken producer cleanup must not skip this connection's remaining resource cleanup.
      }
      clearInterval(heartbeat)
      cancelPendingSubscriptionPush(ws)
      dropFileWatches(ws) // leak-guard for the OS watches, as removeConn is for the registry below
      const terminationTimer = terminationTimers.get(ws)
      if (terminationTimer) clearTimeout(terminationTimer)
      terminationTimers.delete(ws)
      const held = registry.slugsFor(ws) // capture BEFORE removeConn so we can reclaim orphaned signatures
      registry.removeConn(ws) // leak-guard: drop this connection from every slug it held
      for (const slug of held) {
        if (!registry.hasSubscribers(slug)) {
          lastSig.delete(slug)
          deleteTranscriptSnapshot(slug)
        }
      }
      socketOrigins.delete(ws)
    })
    ws.on("error", () => {
      closeSocket(ws, 1011, "transport failed")
    })
  }

  wss.on("error", () => {})
  wss.on("connection", (ws: WebSocket) => {
    connectionCount++
    ws.once("close", () => {
      connectionCount = Math.max(0, connectionCount - 1)
    })
    if (closing) {
      closeSocket(ws, 1012, "server restarting")
      return
    }
    try {
      initializeConnection(ws)
    } catch {
      closeSocket(ws, 1011, "connection failed")
    }
  })

  return {
    handleUpgrade(req, socket, head) {
      if (!isWsPath(req.url)) return false
      if (closing) {
        rejectWebSocketUpgrade(socket, 503, "Service Unavailable")
        return true
      }
      // The first frame is a full project board, so apply the same mandatory browser-origin boundary as
      // the terminal before the WebSocket parser or any board/transcript work is reachable.
      if (!isTrustedLocalWebSocketRequest(req)) {
        rejectWebSocketUpgrade(socket)
        return true
      }
      // Reserve before handing bytes to ws so simultaneous upgrades cannot all observe the same final
      // slot. Capacity rejection stays an HTTP 503: a rejected peer never allocates a WebSocket/parser,
      // never reaches a board snapshot, and can retry after another tab closes.
      if (connectionCount + pendingUpgrades >= maxConnections) {
        rejectWebSocketUpgrade(socket, 503, "WebSocket capacity reached")
        return true
      }
      pendingUpgrades++
      let reserved = true
      const releaseReservation = () => {
        if (!reserved) return
        reserved = false
        pendingUpgrades = Math.max(0, pendingUpgrades - 1)
      }
      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          releaseReservation()
          const origin = req.headers.origin
          if (typeof origin === "string") socketOrigins.set(ws, origin)
          const stamp = req.headers[CALLER_HEADER]
          const access = typeof stamp === "string" ? callerAccess(stamp) : "local"
          if (access !== "local") remoteSockets.set(ws, { stamp: stamp as string, userAgent: req.headers["user-agent"], access })
          wss.emit("connection", ws, req)
        })
      } catch {
        releaseReservation()
        rejectWebSocketUpgrade(socket, 400, "Bad Request")
      }
      return true
    },
    close() {
      if (closePromise) return closePromise
      closing = true
      try {
        offTranscript()
      } catch {
        // Continue reclaiming sockets even if a custom producer cleanup fails.
      }
      try {
        cancelSubscriptionFlush?.()
      } catch {
        // The flush is a no-op once `closing` is set, so a failed cancel cannot start a read.
      }
      cancelSubscriptionFlush = null
      subscriptionFlushArmed = false
      pendingSubscriptionPushes.clear()
      if (transcriptRefreshTimer) clearTimeout(transcriptRefreshTimer)
      transcriptRefreshTimer = null
      pendingTranscriptRefreshes.clear()
      clearTranscriptSnapshots()
      globalReadTimes.length = 0
      originReadTimes.clear()
      // Force clients onto their reconnect path before the old process releases its listener. Normal
      // close handshakes can otherwise keep a replaced dev child alive indefinitely in a sleeping tab.
      const socketDrains = [...wss.clients].map((ws) => new Promise<void>((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve()
        ws.once("close", () => resolve())
        try {
          ws.terminate()
        } catch {
          resolve() // One broken client must not keep the rest of the server alive.
        }
      }))
      lastSig.clear()
      closePromise = (async () => {
        await Promise.allSettled(socketDrains)
        try {
          wss.close()
        } catch {
          // Idempotent shutdown after a failed boot/upgrade.
        }
      })()
      return closePromise
    },
    registry,
    get lastSigSize() {
      return lastSig.size
    },
    get connectionCount() {
      return connectionCount
    },
    get transcriptCacheEntries() {
      return transcriptCache.size
    },
    get transcriptCacheBytes() {
      return transcriptCacheBytes
    },
    get pendingTranscriptRefreshes() {
      return pendingTranscriptRefreshes.size
    },
    get fileWatchCount() {
      return fileWatchCount
    },
  }
}
