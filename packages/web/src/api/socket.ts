import type { QueryClient } from "@tanstack/react-query"
import type { SocketClientMsg, SocketServerMsg } from "@frizz/shared"
import { store } from "../store.ts"
import { BoardStream, refreshProjectList } from "./board-stream.ts"
import { BoardResume } from "./board-resume.ts"
import { noteServerBootId } from "./boot.ts"
import { rpc } from "./rpc.ts"
import { connectSSE, rebindSSEProject, suspendSSE } from "./sse.ts"
import { writeTranscriptPush } from "./transcript-push.ts"
import { cachedMessages, TranscriptTails, WS_PATCH_QUERY } from "./wirePatch.ts"
import { invalidateInteractionQueries } from "./interaction-cache.ts"
import { FRIZZ_ROUTE_PREFIX } from "@frizz/shared"
import { apiBase, isConsolePath, projectSlug } from "../lib/base-path.ts"
import { splitThreadKey } from "../lib/threadKey.ts"
import {
  consoleFeedActive,
  consoleRetryTranscript,
  consoleSubscribeFile,
  consoleSubscribeTranscript,
  consoleUnsubscribeFile,
  consoleUnsubscribeTranscript,
  startConsoleFeed,
  stopConsoleFeed,
} from "./consoleFeed.ts"
import { localFileQueryKey } from "../lib/localFileQuery.ts"

// The stage-2 multiplexed client: ONE WebSocket("/ws") carrying the board channel (deltas + notify,
// driven through the shared BoardStream) AND per-thread transcript push (replacing the 1.5s
// threadTranscript poll). The board itself never comes down the socket: it is read over HTTP and the
// socket resumes from its seq (board-resume.ts has the why and the protocol).
//
// GRACEFUL FALLBACK: a pre-restart server has no /ws route — its upgrade handler destroys the socket, so
// we never see `onopen`. On a close/error BEFORE the socket ever confirms, we hand the board channel back
// to the proven SSE path (connectSSE) and useTranscript keeps polling — i.e. EXACTLY today's behavior.
// Once confirmed, transient drops reconnect on /ws (never fall back); the boot-id reload closes the
// bundle-mismatch window across a server bounce.

let ws: WebSocket | null = null
let qc: QueryClient | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let health: ReturnType<typeof setInterval> | null = null
let failures = 0
let lastMsg = 0
let protocolReady = false
// /ws proved live at least once this session (onopen fired). A PERMANENT latch by design: after the first
// confirm, later drops reconnect on /ws with backoff and never fall back. Bounces are forward-only (/ws is
// only ever ADDED), so a hypothetical restart to a /ws-less build would retry (backoff-capped, not a storm)
// rather than degrade — an accepted tradeoff for not re-probing SSE on every transient blip.
let confirmed = false
let fellBack = false // committed to the SSE fallback — never touch /ws again this session

// slug → count of interested surfaces (main ChatView + any drawer ChatViews on the same running thread).
// Ref-counted so a drawer close doesn't unsubscribe a slug the main view still shows; the server holds one
// subscription per connection per slug, so we send `sub` on 0→1 and `unsub` on 1→0.
const subs = new Map<string, number>()

// path → count of READERS showing that local file (the /full split viewer, and every Markdown drawer
// stacked over it). Same ref-count discipline as `subs`: `sub` on 0→1, `unsub` on 1→0, replayed on
// every (re)connect. The server answers a change with `file-changed`, and the handler below
// invalidates the reader's query so it re-reads through its own gated RPC.
const fileSubs = new Map<string, number>()
// How many times this session has reached a live protocol (a hello on /ws). The first is the
// initial connect; every later one is a reconnect, across which a change to an open file may have
// gone unheard — so those re-read every open file once, and the first does not (the reader's own
// mount read is at most seconds old).
let liveGenerations = 0

// A seq gap reads the board over HTTP again and resumes the SAME socket from the new seq — the socket is
// healthy, only the board's continuity is in doubt.
const stream = new BoardStream(
  () => resume.resync(),
  (event) => {
    if (qc) void invalidateInteractionQueries(qc, event)
  },
  () => refreshProjectList(qc),
  () => resume.progressed(),
)

// The page's board: read over HTTP (from the page's own project — `rpc` resolves it per call), resumed
// on the live socket. `send` runs only between a hello and a drop, on the socket that said hello.
const resume = new BoardResume({
  read: () => rpc.boardState(),
  adopt: (state) => stream.adopt(state),
  held: () => stream.held(),
  send: (bootId, seq) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "board", bootId, seq } satisfies SocketClientMsg))
  },
})

// Server pushes a 10s heartbeat; if we go quiet past this we assume the socket is dead and reconnect.
const HEARTBEAT_TIMEOUT = 35_000

function wsUrl(): string {
  return `${location.origin.replace(/^http/, "ws")}${apiBase()}/ws${WS_PATCH_QUERY}`
}

// The last whole window of each subscribed transcript on the CURRENT socket, which its tails splice
// onto (wirePatch.ts). Emptied whenever a socket is opened: the server starts each subscription on a new
// socket with a whole window.
const tails = new TranscriptTails()

// WHICH PROJECT THE LIVE FEED IS ON — one copy of that fact, kept by the module that actually holds the
// connection, and readable by anyone who needs to ask (`feedIsBoundTo`). It covers BOTH transports,
// because the SSE fallback is only ever reached through here.
//
// The point is that there is no SECOND copy. routes.tsx used to keep its own note of the project it had
// bound, in a ref, and a remount reset that note to whatever the new route said — so the app believed it
// was bound to a project it had never connected to, and every board showed the previous one until a
// document load (`0fb8574`). A bystander cannot get this wrong if it has nothing to remember: the thing
// that holds the socket is the only thing that says what the socket is for.
let feedProject: string | undefined
let feedBound = false
// What `feedProject` says while the Console holds the feed. Not a slug: project slugs are slugify output
// and never contain `@`, so no project can be mistaken for it.
const CONSOLE_FEED = "@console"

function noteFeedProject(): void {
  feedProject = projectSlug()
  feedBound = true
}

/** Is the live feed already pointed at `slug`? A caller with nothing of its own to remember. */
export function feedIsBoundTo(slug: string | undefined): boolean {
  return feedBound && feedProject === slug
}

function connect(): void {
  // The Console has no project of its own to connect to — its feed is one connection per project
  // (consoleFeed.ts). A timer or a wake armed before the switch must not open the launching project's,
  // and neither may one that fires while the Console still holds the feed off its own page.
  if (ws || fellBack || isConsolePath() || feedProject === CONSOLE_FEED) return
  if (store.connection !== "open") store.connection = "connecting"
  noteFeedProject()
  tails.clear()
  const sock = new WebSocket(wsUrl())
  // The project THIS socket was opened for, frozen at construction. Every frame it later delivers is
  // checked against it: a socket outlives the navigation that supersedes it by however long the close
  // takes, and a board or a transcript arriving down that pipe belongs to a project nobody is looking
  // at any more. Frozen rather than re-derived, because re-deriving is how a stale frame passes.
  const socketProject = projectSlug()
  ws = sock
  protocolReady = false
  lastMsg = Date.now()

  sock.onopen = () => {
    // The server spoke WebSocket on /ws → the route exists → commit to socket mode.
    confirmed = true
    lastMsg = Date.now()
    store.connection = "open"
    store.socketTranscripts = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  sock.onmessage = (e) => {
    // A frame for the project we have left goes nowhere. `ws !== sock` catches a socket already
    // superseded here; the project check catches the window before that, where this IS the current
    // socket and the address bar has already moved on.
    if (ws !== sock || socketProject !== projectSlug() || isConsolePath()) return
    lastMsg = Date.now()
    try {
      const msg = JSON.parse(e.data) as SocketServerMsg
      const healthy = handle(msg)
      // A TCP upgrade alone is not proof of a healthy protocol session: a server that accepts and then
      // immediately rejects would otherwise reset this counter forever. Reset only after useful protocol
      // traffic. Typed payload downgrades deliberately return false and choose their stable fallback path.
      if (healthy) failures = 0
      if (healthy && msg.t === "hello") {
        protocolReady = true
        liveGenerations++
        resubscribe() // replay subscriptions only once this generation has said hello
        // The resume restores the BOARD across a gap; the project list has none, so a
        // `projects-changed` published while this tab had no socket is caught up here instead. Not on
        // the first generation: the rail's own mount read is at most seconds old.
        if (liveGenerations > 1) refreshProjectList(qc)
        resume.hello(msg.bootId)
      }
    } catch (err) {
      console.error("bad /ws message", err)
    }
  }

  // Let onclose drive recovery (onerror always precedes a close for a failed/closed socket).
  sock.onerror = () => {}
  sock.onclose = () => {
    if (ws !== sock) return // superseded by a newer socket (resync/forceReconnect already handled it)
    ws = null
    onDrop()
  }

  installHealth()
}

// Detach handlers + close WITHOUT triggering the onclose recovery path — for INTENTIONAL drops
// (resync / watchdog) that immediately reconnect themselves.
function dropWs(): void {
  const sock = ws
  ws = null
  protocolReady = false
  resume.dropped()
  if (!sock) return
  sock.onopen = null
  sock.onmessage = null
  sock.onerror = null
  sock.onclose = null
  try {
    sock.close()
  } catch {
    // already closing/closed
  }
}

// An UNEXPECTED close. If /ws never confirmed, the server has no /ws route (pre-restart) → fall back to
// SSE for good. Otherwise it's a transient drop → reconnect on /ws with backoff (same robustness as SSE).
function onDrop(): void {
  // The board and its seq are KEPT: the next socket's hello resumes from them, and the server replays
  // whatever was published in between.
  protocolReady = false
  resume.dropped()
  if (!confirmed) {
    fallBackToSSE()
    return
  }
  failures++
  store.connection = failures > 3 ? "closed" : "connecting"
  scheduleReconnect()
}

function scheduleReconnect(immediate = false): void {
  if (reconnectTimer) {
    if (!immediate) return
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const delay = immediate ? 0 : Math.min(1000 * 2 ** Math.min(failures - 1, 4), 15_000)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

function installHealth(): void {
  if (health) return
  health = setInterval(() => {
    if (ws && Date.now() - lastMsg > HEARTBEAT_TIMEOUT) forceReconnect()
  }, 10_000)

  // Timers throttle in hidden tabs and stall across machine sleep, so a dead socket can sit unnoticed.
  // These wake signals force an immediate staleness check the moment the user is back.
  const wake = () => {
    if (fellBack) return
    if (!ws || Date.now() - lastMsg > HEARTBEAT_TIMEOUT) forceReconnect(true)
  }
  window.addEventListener("focus", wake)
  window.addEventListener("online", wake)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) wake()
  })
}

// Watchdog/wake-triggered reconnect. A socket that never confirmed and has now gone stale is treated like
// an unconfirmed drop (fall back to SSE); a confirmed one reconnects with backoff.
function forceReconnect(immediate = false): void {
  if (fellBack || isConsolePath() || feedProject === CONSOLE_FEED) return
  dropWs()
  if (!confirmed) {
    fallBackToSSE()
    return
  }
  failures++
  store.connection = failures > 3 ? "closed" : "connecting"
  scheduleReconnect(immediate)
}

// A server with no /ws route (one from before the multiplex): hand the board to SSE for the session.
function fallBackToSSE(): void {
  if (fellBack) return
  fellBack = true
  // Detach the socket's handlers before closing so this handoff cannot enter the reconnect path; the SSE
  // keyframe becomes the sole board source.
  dropWs()
  resume.reset()
  stream.reset()
  store.socketTranscripts = false // useTranscript resumes its 1.5s poll (today's behavior)
  // Hand the board channel + notifications to the proven SSE path.
  connectSSE(qc ?? undefined)
}

function handle(msg: SocketServerMsg): boolean {
  switch (msg.t) {
    case "hello":
      noteServerBootId(msg.bootId)
      return true
    case "board-resync":
      // The server could not resume from the seq named (`reason` says why); the board is read again.
      resume.resync()
      return true
    case "event":
      stream.handle(msg.event)
      return true
    case "transcript":
      // Server truth into the SAME cache useTranscript reads — components are unchanged (transcript-push.ts).
      tails.whole(msg.slug, msg.messages)
      writeTranscriptPush(qc, msg.slug, msg)
      tails.adopt(msg.slug, cachedMessages(qc, msg.slug))
      delete store.socketTranscriptFallbacks[msg.slug]
      return true
    case "transcript-tail": {
      // The same window as a splice of the last one this socket received: rebuilt whole, then handled
      // exactly like a `transcript` frame.
      const messages = tails.tail(msg)
      if (!messages) {
        // Not made against the window held (never expected): ask for the window whole again.
        if (subs.has(msg.slug)) {
          send({ t: "unsub", topic: "transcript", slug: msg.slug })
          send({ t: "sub", topic: "transcript", slug: msg.slug })
        }
        return true
      }
      writeTranscriptPush(qc, msg.slug, { t: "transcript", slug: msg.slug, messages, ...(msg.page ? { page: msg.page } : {}) })
      tails.adopt(msg.slug, cachedMessages(qc, msg.slug))
      delete store.socketTranscriptFallbacks[msg.slug]
      return true
    }
    case "file-changed":
      // A notice, not the bytes: the reader's query goes stale and refetches through the same gated
      // read it mounted with, so nothing reaches the page that the read gate would not have admitted.
      void qc?.invalidateQueries({ queryKey: localFileQueryKey(msg.path) })
      return true
    case "payload-too-large":
      if (msg.channel === "board") {
        // Not sent by a server that resumes the board (it answers a delta too big for a frame with
        // `board-resync`); were it ever, the answer is the same one — read the board over HTTP.
        resume.resync()
      } else {
        if (!store.socketTranscriptFallbacks[msg.slug]) {
          console.warn("[frizz] live transcript payload exceeded the socket limit; updates paused", {
            slug: msg.slug,
            actualBytes: msg.actualBytes,
            maxBytes: msg.maxBytes,
          })
        }
        store.socketTranscriptFallbacks[msg.slug] = {
          kind: "payload-too-large",
          actualBytes: msg.actualBytes,
          maxBytes: msg.maxBytes,
        }
      }
      return false
    case "resource-limited":
      if (!store.socketTranscriptFallbacks[msg.slug]) {
        console.warn("[frizz] live transcript read budget reached; updates paused", {
          slug: msg.slug,
          scope: msg.scope,
          retryAfterMs: msg.retryAfterMs,
        })
      }
      store.socketTranscriptFallbacks[msg.slug] = {
        kind: "read-budget",
        scope: msg.scope,
        retryAfterMs: msg.retryAfterMs,
      }
      scheduleBudgetRetry(msg.slug, msg.retryAfterMs)
      return false
    case "hb":
      return true // lastMsg already bumped
  }
}

function send(msg: SocketClientMsg): void {
  if (protocolReady && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// A reconnect replays every held subscription in batches of REPLAY_BATCH per REPLAY_MS — the same drip
// api/transcript-live.ts uses for first subscriptions, for the same reason: the server budgets on-demand
// transcript reads per origin (16 per second, app-socket.ts), every tab on this origin shares that
// budget, and a board holding two dozen queue cards replayed in one burst asks for two dozen reads in one
// check-phase batch. The overflow came back as resource-limited, which the client then treated as a
// permanent pause. Dripping keeps the replay under the budget; the latch reset below handles the rest.
const REPLAY_BATCH = 6
const REPLAY_MS = 700
let replayTimer: ReturnType<typeof setTimeout> | null = null

function resubscribe(): void {
  // A fresh live generation is fresh server state: whatever refused a subscription before this keyframe
  // (a frame over the cap, a read budget spent) is not known to hold now, and the server-side subscription
  // that was dropped with the refusal has to be re-asked for anyway. Clear every latch and let the replay
  // retry; a refusal that still stands simply re-latches, with its banner. Without this a tab that hit one
  // refusal in its lifetime stayed paused across every reconnect — including a server upgrade that had
  // fixed the very overflow it was paused on (maintainer 2026-09-18: "the problem definitely still
  // exists"; it did not, in a fresh tab).
  for (const slug of Object.keys(store.socketTranscriptFallbacks)) delete store.socketTranscriptFallbacks[slug]
  for (const slug of budgetRetryTimers.keys()) cancelBudgetRetry(slug)
  budgetRetries.clear()
  if (replayTimer) {
    clearTimeout(replayTimer)
    replayTimer = null
  }
  const pending = [...subs.keys()]
  const replayBatch = (): void => {
    replayTimer = null
    for (const slug of pending.splice(0, REPLAY_BATCH)) {
      if (subs.has(slug) && !store.socketTranscriptFallbacks[slug]) send({ t: "sub", topic: "transcript", slug })
    }
    if (pending.length) replayTimer = setTimeout(replayBatch, REPLAY_MS)
  }
  replayBatch()
  for (const path of fileSubs.keys()) {
    send({ t: "sub", topic: "file", path })
    // A reconnect may have slept through a change; one re-read per open file closes that gap. Not on
    // the first connect, where the reader's own mount read just happened.
    if (liveGenerations > 1) void qc?.invalidateQueries({ queryKey: localFileQueryKey(path) })
  }
}

// ── Public API (used by useTranscript) ───────────────────────────────────────────────────────────────

// Register interest in a thread's transcript. Ref-counted: the first interested surface sends `sub`;
// later ones just bump the count. A no-op before the socket opens — resubscribe() replays on open.
export function subscribeTranscript(slug: string): void {
  // A KEY names its project, so it belongs to the Console's connection for that project whatever page
  // is asking — and must never reach this one, whose server would refuse `~` and close the socket. A
  // bare slug on the Console names no project at all.
  if (splitThreadKey(slug)) return consoleSubscribeTranscript(slug)
  if (isConsolePath()) return
  const n = (subs.get(slug) ?? 0) + 1
  subs.set(slug, n)
  if (n === 1 && !store.socketTranscriptFallbacks[slug]) send({ t: "sub", topic: "transcript", slug })
}

// Drop one surface's interest. The LAST one sends `unsub` and forgets the slug (no leak); others decrement.
export function unsubscribeTranscript(slug: string): void {
  if (splitThreadKey(slug)) return consoleUnsubscribeTranscript(slug)
  if (isConsolePath()) return
  const n = (subs.get(slug) ?? 0) - 1
  if (n <= 0) {
    subs.delete(slug)
    tails.forget(slug)
    send({ t: "unsub", topic: "transcript", slug })
  } else {
    subs.set(slug, n)
  }
}

// A reader opened a local file: the first reader on a path sends `sub`; later ones bump the count.
// Before the socket opens it is a no-op that resubscribe() replays, exactly as a transcript is.
export function subscribeFile(path: string): void {
  if (isConsolePath()) return consoleSubscribeFile(path)
  const n = (fileSubs.get(path) ?? 0) + 1
  fileSubs.set(path, n)
  if (n === 1) send({ t: "sub", topic: "file", path })
}

// The last reader on a path sends `unsub` and forgets it; the others decrement.
export function unsubscribeFile(path: string): void {
  if (isConsolePath()) return consoleUnsubscribeFile(path)
  const n = (fileSubs.get(path) ?? 0) - 1
  if (n <= 0) {
    fileSubs.delete(path)
    send({ t: "unsub", topic: "file", path })
  } else {
    fileSubs.set(path, n)
  }
}

// Human-triggered recovery for a per-thread logical overflow or read-budget rejection. The server removed
// the failed subscription, so one explicit retry is at most one budgeted read + serialization. Success
// resumes push; another typed rejection restores the stable warning without reconnecting the board socket.
export function retryTranscriptSocket(slug: string): void {
  if (splitThreadKey(slug)) return consoleRetryTranscript(slug)
  if (!store.socketTranscriptFallbacks[slug]) return
  cancelBudgetRetry(slug)
  delete store.socketTranscriptFallbacks[slug]
  if (subs.has(slug)) send({ t: "sub", topic: "transcript", slug })
}

// A read-budget refusal is TRANSIENT by its own definition — the server names the retry-after — so the
// client retries on its own after that much (plus a little spread, so the tabs that were refused together
// do not all ask again in the same millisecond), up to MAX_BUDGET_RETRIES times per slug per live
// generation. Past that it is the banner's manual "Retry live", as it always was. An overflow is not
// retried here: its refusal is a property of the thread, and re-asking every edge would only re-trip it.
const MAX_BUDGET_RETRIES = 5
const BUDGET_RETRY_SPREAD_MS = 400
const budgetRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const budgetRetries = new Map<string, number>()

function scheduleBudgetRetry(slug: string, retryAfterMs: number): void {
  const attempts = budgetRetries.get(slug) ?? 0
  if (attempts >= MAX_BUDGET_RETRIES) return
  cancelBudgetRetry(slug)
  const delay = Math.max(1, retryAfterMs) + Math.random() * BUDGET_RETRY_SPREAD_MS
  budgetRetryTimers.set(slug, setTimeout(() => {
    budgetRetryTimers.delete(slug)
    budgetRetries.set(slug, attempts + 1)
    const fallback = store.socketTranscriptFallbacks[slug]
    if (!fallback || fallback.kind !== "read-budget") return
    delete store.socketTranscriptFallbacks[slug]
    if (subs.has(slug)) send({ t: "sub", topic: "transcript", slug })
  }, delay))
}

function cancelBudgetRetry(slug: string): void {
  const timer = budgetRetryTimers.get(slug)
  if (!timer) return
  clearTimeout(timer)
  budgetRetryTimers.delete(slug)
}

/**
 * Point the live feed at a DIFFERENT project, in place.
 *
 * The rail switches projects without a document load, and every stream in this module is bound to one
 * project: `wsUrl()` derives from `apiBase()`, which derives from the page's own path. So a switch is
 * a resync against a URL that has already changed — the same drop-and-reopen the seq-gap path uses,
 * plus the two pieces of per-project bookkeeping a seq gap must NOT clear:
 *
 *   · `subs` is keyed by THREAD SLUG, which is only unique within a project. Carrying it across would
 *     re-subscribe the new project's socket to the old project's threads, and slugs collide.
 *   · `connection` goes back to connecting, so the status bar stops claiming a live feed it no longer
 *     has while the new socket opens.
 *
 * `confirmed`/`fellBack` are deliberately KEPT: they describe whether this SERVER speaks /ws at all,
 * which is a property of the process, not of the project it happens to be serving.
 */
export function rebindProject(): void {
  stopConsoleFeed()
  subs.clear()
  // Absolute paths do not collide across projects the way slugs do, but the file gate is the NEW
  // project's, and the readers holding these are unmounting with the page they were on.
  fileSubs.clear()
  stream.reset()
  dropWs()
  resume.reset()
  store.connection = "connecting"
  noteFeedProject()
  // A session that fell back has no socket to re-open — its board comes down the EventSource, which is
  // bound to one project in exactly the same way and needs the same instruction. `rebindSSEProject` was
  // written for this and never wired up: it sat exported with no caller in the repo, so on any server
  // without `/ws` a project switch left the board fed by the project you just left. Same bug as
  // `0fb8574`, second instance, found while auditing the first.
  if (fellBack) rebindSSEProject()
  else {
    // Read the new project's board now rather than when its socket says hello: the read is the long pole.
    resume.prefetch()
    connect()
  }
}

/**
 * Hand the live feed to the CONSOLE: drop this page's connection and start the Console's, which opens
 * one connection per project (consoleFeed.ts). The mirror of `rebindProject`, which takes it back.
 */
export function bindConsole(): void {
  subs.clear()
  fileSubs.clear()
  stream.reset()
  dropWs()
  resume.reset()
  // A session that fell back to SSE has its board coming down an EventSource bound to one project. The
  // Console has no use for it, and left open its notifications would double the Console's own.
  if (fellBack) suspendSSE()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  feedProject = CONSOLE_FEED
  feedBound = true
  startConsoleFeed()
}

/**
 * Take the feed back from the Console for a page that shows no project's board — the grid. It is what a
 * cold load of that page would hold: the launching project's connection. Left with the Console instead,
 * N connections sit on a page that reads none of them, each dropping its frames and being reopened by
 * the watchdog for it, and the next visit to the Console started from feeds that had already answered a
 * board it had thrown away.
 */
export function leaveConsole(): void {
  if (feedProject !== CONSOLE_FEED && !consoleFeedActive()) return
  rebindProject()
}

/** Is the live feed the Console's? What `feedIsBoundTo` is for a project page. */
export function feedIsConsole(): boolean {
  return feedBound && feedProject === CONSOLE_FEED && consoleFeedActive()
}

// Entry point (replaces connectSSE in main.tsx). Deferred to `load` so the socket doesn't consume one of
// Chrome's 6 per-host connection slots while Vite is still streaming modules in dev.
export function connectSync(queryClient: QueryClient): void {
  qc = queryClient
  // Commit to this page's project NOW, not when the socket actually opens. The open is deferred to
  // `load`, and in between the router renders and asks whether the feed is bound: answering "nothing is
  // bound yet" would make a cold load tear down and re-establish the connection main.tsx had already
  // arranged. The module is committed from here, so that is what it reports.
  noteFeedProject()
  // The board is read NOW, while the page is still loading: it is the page's one big payload, and the
  // socket only resumes from it. This read is also the page's first paint of the board — there is no
  // separate startup seed any more (App.tsx and StandaloneThreadPage each fetched one until 2026-10-14,
  // which with the socket's keyframe meant every load read the board twice).
  if (!isConsolePath()) resume.prefetch()
  const go = () => connect()
  if (document.readyState === "complete") go()
  else window.addEventListener("load", go, { once: true })
}
