import type { QueryClient } from "@tanstack/react-query"
import type { BoardSnapshot, ServerEvent, SocketClientMsg, SocketServerMsg, ThreadView } from "@frizz/shared"
import { applyBoardDelta, deltaAction } from "@frizz/shared"
import { store, openThread, setBoardPendingCheck } from "../store.ts"
import { isConsolePath, projectApiBase, projectHref } from "../lib/base-path.ts"
import { setProjectGithubRepo } from "../lib/githubAutolink.ts"
import { localFileQueryKey } from "../lib/localFileQuery.ts"
import { splitThreadKey, threadKey } from "../lib/threadKey.ts"
import { noteServerBootId } from "./boot.ts"
import { refreshProjectList } from "./board-stream.ts"
import { invalidateInteractionQueries } from "./interaction-cache.ts"
import { rpcFor } from "./rpc.ts"
import { writeTranscriptPush } from "./transcript-push.ts"

// THE CONSOLE'S LIVE FEED — every open project's board, as one.
//
// A project's page has ONE live connection (api/socket.ts), bound to the project in its URL. The Console
// names no project and shows them all, so it opens each project's OWN connection — the same
// `/_frizz/<slug>/ws` that project's page would open, so the server is unchanged — and merges what they
// deliver into one board in the store. Every thread on that board is named by its KEY (lib/threadKey.ts):
// a slug is unique only within its project, and the merged board is the one place two projects' threads
// sit side by side.
//
// Each project keeps its OWN sequence. A delta is checked against the keyframe of the project it came
// from, a gap resyncs that project's connection alone, and a keyframe replaces that project's threads
// and no one else's. A board is admitted only from the connection opened for its project (the board
// says which it is, `projectSlug`), which is the door api/socket.ts keeps for a page, kept per project.
//
// Transcripts ride the same connections: a subscription goes to the socket of the thread's project with
// the real slug, and a push is written to the cache under the key (transcript-push.ts) — the entry the
// Console's cards are reading. api/transcript-live.ts decides WHICH threads are live, as it does on a
// project page; it calls api/socket.ts, which hands a Console page's calls to here.
//
// What this does NOT have is the SSE fallback. Browsers allow about six connections per host over
// HTTP/1.1 and the Console would need one EventSource per project, so a project whose board is too big
// for its socket is polled over HTTP instead (BOARD_POLL_MS), and its transcripts still push: the server
// shuts only that connection's BOARD channel (app-socket.ts), and keeps its transcripts and heartbeat.
// What such a project loses is the bus — its desktop notifications and its question-card invalidations —
// because those ride the board channel the server has closed.

const HEARTBEAT_TIMEOUT = 35_000
const BOARD_POLL_MS = 5_000
// The same drip api/socket.ts replays with: the server budgets transcript reads per origin per project.
const REPLAY_BATCH = 6
const REPLAY_MS = 700
const MAX_BUDGET_RETRIES = 5

let qc: QueryClient | null = null
const feeds = new Map<string, ProjectFeed>()
let health: ReturnType<typeof setInterval> | null = null
/** Is the Console holding the feed? Set by startConsoleFeed, cleared by stopConsoleFeed. */
let active = false
// The merged board BEFORE it is shown. The Console's first paint waits for every project's first keyframe
// (or PUBLISH_DEADLINE_MS, whichever is sooner): a board painted from the first project to answer would
// reorder its queue under the operator as each other project's threads arrived, and the card at the top —
// the one they were about to read — would be replaced by an older one a beat later.
let staged: BoardSnapshot | null = null
let publishDeadline: ReturnType<typeof setTimeout> | null = null
const PUBLISH_DEADLINE_MS = 2_500
// Has the route said which projects this start covers? Until it has, every project is still to come.
let projectsKnown = false

/** The merged board's own fields. It belongs to no project, so it carries no project's identity. */
function emptyUnion(): BoardSnapshot {
  return { projectDir: "", projectName: "Console", projectLabel: "Console", threads: [], errors: [], warnings: [] }
}

/** A project's thread under its key. `dependsOn` names threads of the same project, so it is keyed too. */
export function keyThread(project: string, t: ThreadView): ThreadView {
  return { ...t, id: threadKey(project, t.id), dependsOn: t.dependsOn.map((slug) => threadKey(project, slug)) }
}

/** Replace ONE project's threads on the merged board with this keyframe's. */
export function mergeKeyframe(union: BoardSnapshot, project: string, board: BoardSnapshot): void {
  const prefix = threadKey(project, "")
  const kept = union.threads.filter((t) => !t.id.startsWith(prefix))
  union.threads = [...kept, ...board.threads.map((t) => keyThread(project, t))]
  // The machine's home directory is the same whichever project says it; the Console's paths use it.
  if (board.homeDir && !union.homeDir) union.homeDir = board.homeDir
}

/** Apply one project's delta to the merged board. Board-level meta is that project's, so it is not applied. */
export function mergeDelta(union: BoardSnapshot, project: string, delta: Extract<ServerEvent, { type: "board-delta" }>): void {
  applyBoardDelta(union, {
    upserts: delta.upserts.map((t) => keyThread(project, t)),
    removed: delta.removed.map((slug) => threadKey(project, slug)),
  })
}

/** Drop a project's threads from the merged board — it closed, was removed, or left the Console's set. */
export function dropProject(union: BoardSnapshot, project: string): void {
  const prefix = threadKey(project, "")
  if (union.threads.some((t) => t.id.startsWith(prefix))) union.threads = union.threads.filter((t) => !t.id.startsWith(prefix))
}

class ProjectFeed {
  private ws: WebSocket | null = null
  private seq = -1
  /** Has this project's first keyframe landed? The Console's first paint waits for every project's. */
  keyframed = false
  private confirmed = false
  private protocolReady = false
  private failures = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private replayTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private closed = false
  lastMsg = 0
  /** Real slug → number of interested surfaces. Ref-counted exactly as api/socket.ts's `subs`. */
  private readonly subs = new Map<string, number>()
  private readonly fileSubs = new Map<string, number>()
  private readonly budgetRetries = new Map<string, number>()
  private readonly budgetTimers = new Map<string, ReturnType<typeof setTimeout>>()
  state: "connecting" | "open" | "closed" = "connecting"

  constructor(readonly project: string) {}

  connect(): void {
    if (this.closed || this.ws) return
    const sock = new WebSocket(`${location.origin.replace(/^http/, "ws")}${projectApiBase(this.project)}/ws`)
    this.ws = sock
    this.protocolReady = false
    this.lastMsg = Date.now()
    sock.onopen = () => {
      this.confirmed = true
      this.lastMsg = Date.now()
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
    }
    sock.onmessage = (e) => {
      if (this.ws !== sock || this.closed || !isConsolePath()) return
      this.lastMsg = Date.now()
      try {
        if (this.handle(JSON.parse(e.data) as SocketServerMsg)) this.failures = 0
      } catch (err) {
        console.error(`bad /ws message from ${this.project}`, err)
      }
    }
    sock.onerror = () => {}
    sock.onclose = () => {
      if (this.ws !== sock) return
      this.ws = null
      this.protocolReady = false
      this.seq = -1
      if (this.closed) return
      this.failures++
      this.setState(this.failures > 3 ? "closed" : "connecting")
      this.scheduleReconnect()
    }
  }

  private setState(state: ProjectFeed["state"]): void {
    this.state = state
    reportConnection()
    maybePublish()
  }

  private scheduleReconnect(immediate = false): void {
    if (this.closed) return
    if (this.reconnectTimer) {
      if (!immediate) return
      clearTimeout(this.reconnectTimer)
    }
    const delay = immediate ? 0 : Math.min(1000 * 2 ** Math.min(Math.max(this.failures - 1, 0), 4), 15_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /** Drop the socket WITHOUT the close handler's recovery, then open a fresh one for a new keyframe. */
  resync(): void {
    this.dropSocket()
    this.connect()
  }

  /**
   * Start over for a new start of the feed: a fresh connection, and so a fresh keyframe, and this
   * project counted as not yet answered. A feed that outlived its start would otherwise report the
   * keyframe it delivered to a board that has since been thrown away — and the new start would publish
   * without it.
   */
  restart(): void {
    this.keyframed = false
    this.failures = 0
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.state = "connecting"
    this.resync()
  }

  /** The watchdog's and the wake signals' reconnect: a socket gone quiet past the heartbeat is dead. */
  checkHealth(now: number, force = false): void {
    if (this.closed) return
    if (!this.ws) {
      if (force) this.scheduleReconnect(true)
      return
    }
    if (now - this.lastMsg <= HEARTBEAT_TIMEOUT) return
    this.dropSocket()
    this.failures++
    this.setState(this.failures > 3 ? "closed" : "connecting")
    this.scheduleReconnect(force)
  }

  private dropSocket(): void {
    const sock = this.ws
    this.ws = null
    this.protocolReady = false
    this.seq = -1
    if (!sock) return
    sock.onopen = null
    sock.onmessage = null
    sock.onerror = null
    sock.onclose = null
    try {
      sock.close()
    } catch {
      // already closing
    }
  }

  close(): void {
    this.closed = true
    this.dropSocket()
    for (const timer of [this.reconnectTimer, this.replayTimer]) if (timer) clearTimeout(timer)
    for (const timer of this.budgetTimers.values()) clearTimeout(timer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.reconnectTimer = this.replayTimer = this.pollTimer = null
    this.budgetTimers.clear()
    const board = store.board ?? staged
    if (board) dropProject(board, this.project)
    setProjectGithubRepo(this.project, null)
    for (const slug of this.subs.keys()) delete store.socketTranscriptFallbacks[threadKey(this.project, slug)]
  }

  private handle(msg: SocketServerMsg): boolean {
    switch (msg.t) {
      case "event":
        return this.handleEvent(msg.event)
      case "transcript": {
        const key = threadKey(this.project, msg.slug)
        writeTranscriptPush(qc, key, msg)
        delete store.socketTranscriptFallbacks[key]
        return true
      }
      case "file-changed":
        void qc?.invalidateQueries({ queryKey: localFileQueryKey(msg.path) })
        return true
      case "payload-too-large":
        if (msg.channel === "board") {
          console.warn(`[frizz] ${this.project}'s live board exceeded the socket limit; polling it instead`, { actualBytes: msg.actualBytes, maxBytes: msg.maxBytes })
          this.pollBoard()
          // The connection is still this project's transcript channel; only its board was shut. So it is
          // ready for subscriptions now, as a keyframe would have made it.
          this.becomeReady()
        } else {
          store.socketTranscriptFallbacks[threadKey(this.project, msg.slug)] = { kind: "payload-too-large", actualBytes: msg.actualBytes, maxBytes: msg.maxBytes }
        }
        return false
      case "resource-limited":
        store.socketTranscriptFallbacks[threadKey(this.project, msg.slug)] = { kind: "read-budget", scope: msg.scope, retryAfterMs: msg.retryAfterMs }
        this.scheduleBudgetRetry(msg.slug, msg.retryAfterMs)
        return false
      case "hb":
        return true
    }
  }

  private handleEvent(event: ServerEvent): boolean {
    switch (event.type) {
      case "board":
        noteServerBootId(event.bootId)
        // THE DOOR, per project: a board that names another project did not come from the connection
        // this feed opened for `project`, and nothing it says belongs under this project's keys.
        if (event.board.projectSlug && event.board.projectSlug !== this.project) return false
        this.adoptKeyframe(event.board)
        this.seq = typeof event.seq === "number" ? event.seq : -1
        this.becomeReady()
        return true
      case "board-delta":
        noteServerBootId(event.bootId)
        switch (deltaAction(this.seq, event.seq)) {
          case "apply": {
            const board = store.board ?? staged
            if (!board) {
              this.resync()
              return true
            }
            mergeDelta(board, this.project, event)
            this.seq = event.seq
            return true
          }
          case "ignore":
            return true
          case "resync":
            this.resync()
            return true
        }
        return true
      case "notify":
        notifyConsole(this.project, event)
        return true
      case "interactions-invalidated":
        if (qc) void invalidateInteractionQueries(qc, { ...event, slug: threadKey(this.project, event.slug) })
        return true
      case "projects-changed":
        refreshProjectList(qc)
        return true
    }
  }

  private becomeReady(): void {
    if (this.protocolReady) return
    this.protocolReady = true
    this.setState("open")
    store.socketTranscripts = true
    this.resubscribe()
  }

  private adoptKeyframe(board: BoardSnapshot): void {
    if (!isConsolePath() || !active) return
    mergeKeyframe(store.board ?? (staged ??= emptyUnion()), this.project, board)
    // The repo this project's `#123` and commit hashes link to. The merged board carries no project's
    // repo, so this keyframe — the project's own — is the one place that knows it (lib/githubAutolink.ts).
    setProjectGithubRepo(this.project, board.githubRepo)
    this.keyframed = true
    maybePublish()
  }

  /** A board too big for the socket: read it over HTTP on a clock, and keep the socket for transcripts. */
  private pollBoard(): void {
    if (this.pollTimer) return
    const read = () => {
      rpcFor(this.project).board().then((board) => {
        if (!this.closed && board.projectSlug === this.project) this.adoptKeyframe(board)
      }).catch(() => {})
    }
    read()
    this.pollTimer = setInterval(read, BOARD_POLL_MS)
  }

  private send(msg: SocketClientMsg): void {
    if (this.protocolReady && this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private resubscribe(): void {
    for (const slug of this.subs.keys()) delete store.socketTranscriptFallbacks[threadKey(this.project, slug)]
    this.budgetRetries.clear()
    if (this.replayTimer) clearTimeout(this.replayTimer)
    const pending = [...this.subs.keys()]
    const batch = (): void => {
      this.replayTimer = null
      for (const slug of pending.splice(0, REPLAY_BATCH)) if (this.subs.has(slug)) this.send({ t: "sub", topic: "transcript", slug })
      if (pending.length) this.replayTimer = setTimeout(batch, REPLAY_MS)
    }
    batch()
    for (const path of this.fileSubs.keys()) this.send({ t: "sub", topic: "file", path })
  }

  subscribe(slug: string): void {
    const n = (this.subs.get(slug) ?? 0) + 1
    this.subs.set(slug, n)
    if (n === 1 && !store.socketTranscriptFallbacks[threadKey(this.project, slug)]) this.send({ t: "sub", topic: "transcript", slug })
  }

  unsubscribe(slug: string): void {
    const n = (this.subs.get(slug) ?? 0) - 1
    if (n <= 0) {
      this.subs.delete(slug)
      this.send({ t: "unsub", topic: "transcript", slug })
    } else {
      this.subs.set(slug, n)
    }
  }

  retry(slug: string): void {
    const key = threadKey(this.project, slug)
    if (!store.socketTranscriptFallbacks[key]) return
    delete store.socketTranscriptFallbacks[key]
    if (this.subs.has(slug)) this.send({ t: "sub", topic: "transcript", slug })
  }

  subscribeFile(path: string): void {
    const n = (this.fileSubs.get(path) ?? 0) + 1
    this.fileSubs.set(path, n)
    if (n === 1) this.send({ t: "sub", topic: "file", path })
  }

  unsubscribeFile(path: string): void {
    const n = (this.fileSubs.get(path) ?? 0) - 1
    if (n <= 0) {
      this.fileSubs.delete(path)
      this.send({ t: "unsub", topic: "file", path })
    } else {
      this.fileSubs.set(path, n)
    }
  }

  private scheduleBudgetRetry(slug: string, retryAfterMs: number): void {
    const attempts = this.budgetRetries.get(slug) ?? 0
    if (attempts >= MAX_BUDGET_RETRIES) return
    const pending = this.budgetTimers.get(slug)
    if (pending) clearTimeout(pending)
    this.budgetTimers.set(slug, setTimeout(() => {
      this.budgetTimers.delete(slug)
      this.budgetRetries.set(slug, attempts + 1)
      const key = threadKey(this.project, slug)
      if (store.socketTranscriptFallbacks[key]?.kind !== "read-budget") return
      delete store.socketTranscriptFallbacks[key]
      if (this.subs.has(slug)) this.send({ t: "sub", topic: "transcript", slug })
    }, Math.max(1, retryAfterMs) + Math.random() * 400))
  }
}

/**
 * Show the merged board once every project has answered — its first keyframe, or a connection given up
 * on — or once the deadline says to stop waiting for the stragglers (`force`).
 */
function maybePublish(force = false): void {
  if (!active || store.board || !isConsolePath()) return
  if (!force && [...feeds.values()].some((feed) => !feed.keyframed && feed.state !== "closed")) return
  store.board = staged ?? emptyUnion()
  staged = null
  if (publishDeadline) clearTimeout(publishDeadline)
  publishDeadline = null
}

/** The status bar's one reading of N connections: live once every project's is, closed if any is. */
function reportConnection(): void {
  if (!isConsolePath()) return
  const states = [...feeds.values()].map((feed) => feed.state)
  store.connection = states.length === 0 || states.every((state) => state === "open") ? "open" : states.includes("closed") ? "closed" : "connecting"
}

function installHealth(): void {
  if (health) return
  health = setInterval(() => {
    const now = Date.now()
    for (const feed of feeds.values()) feed.checkHealth(now)
  }, 10_000)
  // Timers throttle in hidden tabs and stall across sleep, so a dead socket can sit unnoticed; these
  // wake signals check every connection the moment the operator is back, as api/socket.ts does.
  const wake = () => {
    const now = Date.now()
    for (const feed of feeds.values()) feed.checkHealth(now, true)
  }
  window.addEventListener("focus", wake)
  window.addEventListener("online", wake)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) wake()
  })
}

/** Give the feed the app's query cache — the transcripts and file notices it writes land there. */
export function initConsoleFeed(queryClient: QueryClient): void {
  qc = queryClient
}

/**
 * Point the Console at exactly these projects: open a connection for each new one, close the ones that
 * left. Called with the projects the server has OPEN (the rail's counts say which), so the Console never
 * activates a project out of the server's paced start-up order.
 */
export function setConsoleProjects(projects: readonly string[]): void {
  projectsKnown = true
  const wanted = new Set(projects)
  for (const [project, feed] of feeds) {
    if (wanted.has(project)) continue
    feed.close()
    feeds.delete(project)
  }
  for (const project of wanted) {
    if (feeds.has(project)) continue
    const feed = new ProjectFeed(project)
    feeds.set(project, feed)
    feed.connect()
  }
  installHealth()
  reportConnection()
  // No project to wait for (none is open) publishes the empty board now; otherwise each keyframe asks.
  maybePublish()
}

/** Is the Console's feed running? The route's binding asks, as a project route asks api/socket.ts. */
export function consoleFeedActive(): boolean {
  return active
}

/**
 * Is a project the Console is still waiting to hear from — or, with no project named, any of them? A
 * thread URL that names a project still loading is not MISSING yet, and must not be sent away to look
 * for it (store.ts resolveRoutedThread).
 */
export function consoleFeedPending(project?: string): boolean {
  if (!active) return false
  if (!projectsKnown) return true
  const waiting = (feed: ProjectFeed) => !feed.keyframed && feed.state !== "closed"
  if (project === undefined) return [...feeds.values()].some(waiting)
  const feed = feeds.get(project)
  return feed !== undefined && waiting(feed)
}

setBoardPendingCheck(consoleFeedPending)

/**
 * Start the Console's feed. The merged board is shown once its projects have answered (maybePublish).
 * Connections left from an earlier start are started over, not trusted: they answered a board this one
 * has just thrown away.
 */
export function startConsoleFeed(): void {
  active = true
  store.board = null
  staged = null
  // A restart keeps the projects it already has, so the set is known; a first start learns it from the
  // route (setConsoleProjects).
  projectsKnown = feeds.size > 0
  for (const feed of feeds.values()) feed.restart()
  store.connection = "connecting"
  if (publishDeadline) clearTimeout(publishDeadline)
  publishDeadline = setTimeout(() => {
    publishDeadline = null
    maybePublish(true)
  }, PUBLISH_DEADLINE_MS)
}

/** Close every connection and forget the merged board. Leaving the Console for a project calls this. */
export function stopConsoleFeed(): void {
  if (!active && feeds.size === 0) return
  active = false
  projectsKnown = false
  for (const feed of feeds.values()) feed.close()
  feeds.clear()
  staged = null
  if (publishDeadline) clearTimeout(publishDeadline)
  publishDeadline = null
}

function feedFor(key: string): { feed: ProjectFeed; slug: string } | null {
  const parts = splitThreadKey(key)
  const feed = parts && feeds.get(parts.project)
  return parts && feed ? { feed, slug: parts.slug } : null
}

export function consoleSubscribeTranscript(key: string): void {
  const hit = feedFor(key)
  hit?.feed.subscribe(hit.slug)
}

export function consoleUnsubscribeTranscript(key: string): void {
  const hit = feedFor(key)
  hit?.feed.unsubscribe(hit.slug)
}

export function consoleRetryTranscript(key: string): void {
  const hit = feedFor(key)
  hit?.feed.retry(hit.slug)
}

// A file has no project in its name, but the server's file watch is gated by the OWNING project's roots,
// and every other project's gate refuses it silently (app-socket.ts subscribeFile). So the watch is
// asked of every connection, and the one project that owns the file is the one that arms it.
export function consoleSubscribeFile(path: string): void {
  for (const feed of feeds.values()) feed.subscribeFile(path)
}

export function consoleUnsubscribeFile(path: string): void {
  for (const feed of feeds.values()) feed.unsubscribeFile(path)
}

/**
 * A desktop notification from one of the Console's projects. The same rules as a project page's
 * (board-stream.ts `notify`): only when opted in and the tab is not the one being looked at. Its tag
 * names the project, and its click opens the thread on the Console when the tab is still there, or the
 * thread's own project otherwise.
 */
function notifyConsole(project: string, event: Extract<ServerEvent, { type: "notify" }>): void {
  if (!store.notificationsEnabled) return
  if (!document.hidden) return
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return
  const n = new Notification(event.title, { body: event.body, tag: `${projectHref(project)}/${event.slug}` })
  n.onclick = () => {
    window.focus()
    if (isConsolePath()) openThread(threadKey(project, event.slug))
    else location.assign(`${projectHref(project)}/thread/${encodeURIComponent(event.slug)}`)
    n.close()
  }
}
