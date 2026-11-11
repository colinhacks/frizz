import type { QueryClient } from "@tanstack/react-query"
import type { BoardSnapshot, BoardState, ServerEvent, SocketClientMsg, SocketServerMsg, ThreadView } from "@frizz/shared"
import { deltaAction } from "@frizz/shared"
import { store, openThread, plainArray, plainThreads, setBoardPendingCheck, threadsWithDelta } from "../store.ts"
import { isConsolePath, projectApiBase, projectHref } from "../lib/base-path.ts"
import { boardThreadHref } from "../lib/router.ts"
import { setProjectGithubRepo } from "../lib/githubAutolink.ts"
import { localFileQueryKey } from "../lib/localFileQuery.ts"
import { splitThreadKey, threadKey } from "../lib/threadKey.ts"
import { noteServerBootId } from "./boot.ts"
import { refreshProjectList } from "./board-stream.ts"
import { BoardResume } from "./board-resume.ts"
import { invalidateInteractionQueries } from "./interaction-cache.ts"
import { rpcFor } from "./rpc.ts"
import { writeTranscriptPush } from "./transcript-push.ts"
import { cachedMessages, expandBoardDelta, TranscriptTails, WS_PATCH_QUERY } from "./wirePatch.ts"

// THE CONSOLE'S LIVE FEED — every open project's board, as one.
//
// A project's page has ONE live connection (api/socket.ts), bound to the project in its URL. The Console
// names no project and shows them all, so it opens each project's OWN connection — the same
// `/_frizz/<slug>/ws` that project's page would open, so the server is unchanged — and merges what they
// deliver into one board in the store. Every thread on that board is named by its KEY (lib/threadKey.ts):
// a slug is unique only within its project, and the merged board is the one place two projects' threads
// sit side by side.
//
// Each project keeps its OWN sequence. Its board is read over HTTP and its socket resumes from that
// board's seq, exactly as a project page's does (board-resume.ts); a delta is checked against the board
// of the project it came from, a gap re-reads that project's board alone, and a read replaces that
// project's threads and no one else's. A board is admitted only for the project it was read for (the
// board says which it is, `projectSlug`), which is the door api/socket.ts keeps for a page, kept per
// project.
//
// Transcripts ride the same connections: a subscription goes to the socket of the thread's project with
// the real slug, and a push is written to the cache under the key (transcript-push.ts) — the entry the
// Console's cards are reading. api/transcript-live.ts decides WHICH threads are live, as it does on a
// project page; it calls api/socket.ts, which hands a Console page's calls to here.
//
// ITS FALLBACK IS A POLL, NOT AN EVENTSOURCE. A project page whose /ws never opens (a proxy that does not
// pass WebSocket upgrades) falls back to SSE (api/socket.ts). The Console cannot: browsers allow about six
// connections per host over HTTP/1.1, and an EventSource per project would hold one each, starving every
// other request once five projects were open. So a feed whose socket never opened asks its project for
// the deltas after the board it holds (`boardDeltas`, from the same ring a socket's resume replays) every
// POLL_MS, and applies them through the very path a socket's deltas take; a `resync` answer reads the
// board again. One short request per project per poll, none held open.
//
// What the poll does not carry is everything else a socket does: transcripts (useTranscript polls them
// itself while no feed is live, `store.socketTranscripts`), desktop notifications, interaction
// invalidations and the project list's change notice. That is the degraded mode — the board stays live.
// Measured through a proxy that refuses upgrades, a rename on either project showed within one poll.
// (Until 2026-10-15 the Console had no fallback at all: its boards loaded over HTTP and then never moved.)
//
// A FEED THAT FELL BACK KEEPS TRYING /ws, on a backoff, and stops polling the moment a try opens. A socket
// that closes before it opens is also what a server still starting up looks like, and the page is never
// reloaded across a restart (api/boot.ts), so a Console loaded mid-restart fell back for good: every
// project polled every POLL_MS for as long as the tab lived, about 14 requests a second across 21
// projects, ~5% of a core in the browser and the same requests' cost on the server (2026-11-09).

const HEARTBEAT_TIMEOUT = 35_000
// The same drip api/socket.ts replays with: the server budgets transcript reads per origin per project.
const REPLAY_BATCH = 6
const REPLAY_MS = 700
const MAX_BUDGET_RETRIES = 5
// How often a feed whose /ws never opened asks for its project's deltas (see the header).
const POLL_MS = 1_500
// How long such a feed waits before it tries /ws again, doubling on each refusal up to the cap. A path
// that really refuses upgrades costs one failed upgrade a minute; the poll it replaces asks 40 times.
const PROBE_FIRST_MS = 5_000
const PROBE_MAX_MS = 60_000

let qc: QueryClient | null = null
const feeds = new Map<string, ProjectFeed>()
let health: ReturnType<typeof setInterval> | null = null
/** Is the Console holding the feed? Set by startConsoleFeed, cleared by stopConsoleFeed. */
let active = false
// The merged board BEFORE it is shown. The Console's first paint waits for every project's first board
// (or PUBLISH_DEADLINE_MS, whichever is sooner): a board painted from the first project to answer would
// reorder its queue under the operator as each other project's threads arrived, and the card at the top —
// the one they were about to read — would be replaced by an older one a beat later.
let staged: BoardSnapshot | null = null
let publishDeadline: ReturnType<typeof setTimeout> | null = null
const PUBLISH_DEADLINE_MS = 2_500
// Has the route said which projects this start covers? Until it has, every project is still to come.
let projectsKnown = false

/**
 * The merged board's own fields. It belongs to no project, so it carries no project's identity. Its name is
 * the one the grid's tile wears, "All projects", and the tab title reads it (App.tsx).
 */
function emptyUnion(): BoardSnapshot {
  return { projectDir: "", projectName: "All projects", projectLabel: "All projects", threads: plainArray([]), errors: [], warnings: [] }
}

/** A project's thread under its key. `dependsOn` names threads of the same project, so it is keyed too. */
// A plain value on the merged board, like every thread on a project's (store.ts plainThreads).
// A child thread's `parentSlug` names a thread of the same project too, and is keyed so the Console finds
// the parent it is drawn under (lib/childThreads) by plain string identity, as everything else does.
export function keyThread(project: string, t: ThreadView): ThreadView {
  return plainThreads([{
    ...t,
    id: threadKey(project, t.id),
    dependsOn: t.dependsOn.map((slug) => threadKey(project, slug)),
    ...(t.parentSlug ? { parentSlug: threadKey(project, t.parentSlug) } : {}),
  }])[0]
}

// THE MERGED THREADS ARRAY IS A PLAIN VALUE, like a project page's (store.ts plainArray): every change
// below builds a new array and assigns it, and never writes into the one already there, so a snapshot
// that holds it keeps the board it saw. As a valtio proxy it was the one part of the Console that grew
// with every project's history — each delta made the next snapshot copy every thread slot of every
// project, and proxy-compare copy that again for each tracking view — and the merged board is the
// biggest board there is. A delta now costs one `slice` of it, and its upserts keep the slot table
// (threadsWithDelta), so a delta also finds its threads without a walk.

/** The inverse of keyThread: a thread on the merged board as its own project's board holds it. */
export function unkeyThread(t: ThreadView): ThreadView {
  const slugOf = (key: string) => splitThreadKey(key)?.slug ?? key
  return {
    ...t,
    id: slugOf(t.id),
    dependsOn: t.dependsOn.map(slugOf),
    ...(t.parentSlug ? { parentSlug: slugOf(t.parentSlug) } : {}),
  }
}

/** Replace ONE project's threads on the merged board with this board's. */
export function mergeKeyframe(union: BoardSnapshot, project: string, board: BoardSnapshot): void {
  const prefix = threadKey(project, "")
  const kept = union.threads.filter((t) => !t.id.startsWith(prefix))
  union.threads = plainArray([...kept, ...board.threads.map((t) => keyThread(project, t))])
  // The machine's home directory is the same whichever project says it; the Console's paths use it.
  if (board.homeDir && !union.homeDir) union.homeDir = board.homeDir
}

/** Apply one project's delta to the merged board. Board-level meta is that project's, so it is not applied. */
export function mergeDelta(union: BoardSnapshot, project: string, delta: Extract<ServerEvent, { type: "board-delta" }>): void {
  if (delta.upserts.length === 0 && delta.removed.length === 0) return
  union.threads = threadsWithDelta(
    union.threads,
    delta.upserts.map((t) => keyThread(project, t)),
    delta.removed.map((slug) => threadKey(project, slug)),
  )
}

/** Drop a project's threads from the merged board — it closed, was removed, or left the Console's set. */
export function dropProject(union: BoardSnapshot, project: string): void {
  const prefix = threadKey(project, "")
  if (union.threads.some((t) => t.id.startsWith(prefix))) union.threads = plainArray(union.threads.filter((t) => !t.id.startsWith(prefix)))
}

class ProjectFeed {
  private ws: WebSocket | null = null
  // The seq of the board this project's threads on the merged board reflect, and the boot it counts in.
  // Kept across a dropped socket: the next hello resumes from them.
  private seq = -1
  private boot: string | null = null
  /** Has this project's first board landed? The Console's first paint waits for every project's. */
  keyframed = false
  private confirmed = false
  // This project's /ws never opened, so its deltas are polled for (the header). Kept across a restart:
  // it describes the path to this server, not one start of the feed — as api/socket.ts's `fellBack`.
  // Left only when a later try at /ws opens (`probe`).
  private fellBack = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private probeDelay = PROBE_FIRST_MS
  private polling = false
  private protocolReady = false
  private failures = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private replayTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  lastMsg = 0
  /** Real slug → number of interested surfaces. Ref-counted exactly as api/socket.ts's `subs`. */
  private readonly subs = new Map<string, number>()
  private readonly fileSubs = new Map<string, number>()
  // The last whole window of each subscribed transcript on THIS socket, which its tails splice onto.
  private readonly tails = new TranscriptTails()
  private readonly budgetRetries = new Map<string, number>()
  private readonly budgetTimers = new Map<string, ReturnType<typeof setTimeout>>()
  state: "connecting" | "open" | "closed" = "connecting"

  private readonly resume: BoardResume

  constructor(readonly project: string) {
    this.resume = new BoardResume({
      read: () => rpcFor(this.project).boardState(),
      adopt: (state) => this.adopt(state),
      held: () => (this.boot !== null && this.seq >= 0 ? { bootId: this.boot, seq: this.seq } : null),
      send: (bootId, seq) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "board", bootId, seq } satisfies SocketClientMsg))
      },
    })
  }

  /** Read the board and open the socket together: the read is the long pole, so it does not wait for hello. */
  start(): void {
    this.resume.prefetch()
    this.connect()
  }

  /** Open this project's /ws — or, for a feed that fell back, poll, unless this is its next try (`probe`). */
  connect(probe = false): void {
    if (this.closed || this.ws) return
    if (this.fellBack && !probe) {
      this.scheduleProbe()
      return this.schedulePoll(0)
    }
    // A new socket starts every subscription with a whole window, so nothing held for the last one applies.
    this.tails.clear()
    const sock = new WebSocket(`${location.origin.replace(/^http/, "ws")}${projectApiBase(this.project)}/ws${WS_PATCH_QUERY}`)
    this.ws = sock
    this.protocolReady = false
    this.lastMsg = Date.now()
    sock.onopen = () => {
      this.confirmed = true
      this.lastMsg = Date.now()
      if (this.fellBack) this.leaveFallback()
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
      this.resume.dropped()
      if (this.closed) return
      // Closed before it ever opened: nothing on the way to this server passes a WebSocket.
      if (!this.confirmed) return this.fallBack()
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

  /**
   * Start over for a new start of the feed: a fresh connection, a fresh read of the board, and this
   * project counted as not yet answered. A feed that outlived its start would otherwise report the
   * board it delivered to a merged board that has since been thrown away — and the new start would
   * publish without it.
   */
  restart(): void {
    this.keyframed = false
    this.failures = 0
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.state = "connecting"
    this.dropSocket()
    this.seq = -1
    this.boot = null
    this.resume.reset()
    this.resume.prefetch()
    this.connect()
  }

  /** The watchdog's and the wake signals' reconnect: a socket gone quiet past the heartbeat is dead. */
  checkHealth(now: number, force = false): void {
    if (this.closed) return
    if (this.fellBack) {
      // A try at /ws that neither opened nor closed is given up on, as a socket gone quiet is.
      if (this.ws && now - this.lastMsg > HEARTBEAT_TIMEOUT) {
        this.dropSocket()
        this.fallBack()
      }
      if (force) this.schedulePoll(0)
      return
    }
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
    this.resume.dropped()
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
    this.resume.reset()
    for (const timer of [this.reconnectTimer, this.replayTimer, this.pollTimer, this.probeTimer]) if (timer) clearTimeout(timer)
    for (const timer of this.budgetTimers.values()) clearTimeout(timer)
    this.reconnectTimer = this.replayTimer = this.pollTimer = this.probeTimer = null
    this.budgetTimers.clear()
    const board = store.board ?? staged
    if (board) dropProject(board, this.project)
    setProjectGithubRepo(this.project, null)
    for (const slug of this.subs.keys()) delete store.socketTranscriptFallbacks[threadKey(this.project, slug)]
  }

  /** Poll for this project's deltas instead (the header), and try /ws again later. A second call is a refused try. */
  private fallBack(): void {
    if (this.fellBack) this.probeDelay = Math.min(this.probeDelay * 2, PROBE_MAX_MS)
    else {
      this.fellBack = true
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.schedulePoll(0)
    }
    this.scheduleProbe()
  }

  private scheduleProbe(): void {
    if (this.closed || this.probeTimer) return
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null
      if (this.fellBack) this.connect(true)
    }, this.probeDelay)
  }

  /** A try at /ws opened: the socket carries this project from here, resuming from the board the poll kept. */
  private leaveFallback(): void {
    this.fellBack = false
    this.probeDelay = PROBE_FIRST_MS
    for (const timer of [this.pollTimer, this.probeTimer]) if (timer) clearTimeout(timer)
    this.pollTimer = this.probeTimer = null
  }

  private schedulePoll(delay = POLL_MS): void {
    if (this.closed) return
    if (this.pollTimer) {
      if (delay > 0) return
      clearTimeout(this.pollTimer)
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.poll()
    }, delay)
  }

  private async poll(): Promise<void> {
    if (this.closed || this.polling || !this.fellBack) return
    // Nothing to carry forward until the board is read (BoardResume reads it, and retries a failure).
    const held = this.boot !== null && this.seq >= 0 ? { bootId: this.boot, seq: this.seq } : null
    if (!held) return this.schedulePoll()
    this.polling = true
    try {
      const out = await rpcFor(this.project).boardDeltas(held)
      // A socket that opened meanwhile resumes from the board held when it said hello; this answer is its.
      if (this.closed || !isConsolePath() || !this.fellBack) return
      noteServerBootId(out.bootId)
      this.failures = 0
      if (this.state !== "open") this.setState("open")
      // A board read since the request went out (a restart, a resync) is newer than what was asked
      // about; its own next poll carries it forward.
      if (this.boot !== held.bootId) return
      if ("resync" in out) this.resume.resync()
      else for (const event of out.deltas) this.handleEvent(event)
    } catch {
      if (this.fellBack) {
        this.failures++
        this.setState(this.failures > 3 ? "closed" : "connecting")
      }
    } finally {
      this.polling = false
      if (this.fellBack) this.schedulePoll()
    }
  }

  private handle(msg: SocketServerMsg): boolean {
    switch (msg.t) {
      case "hello":
        noteServerBootId(msg.bootId)
        this.becomeReady()
        this.resume.hello(msg.bootId)
        return true
      case "board-resync":
        this.resume.resync()
        return true
      case "event":
        return this.handleEvent(msg.event)
      case "transcript": {
        const key = threadKey(this.project, msg.slug)
        this.tails.whole(msg.slug, msg.messages)
        writeTranscriptPush(qc, key, msg)
        this.tails.adopt(msg.slug, cachedMessages(qc, key))
        delete store.socketTranscriptFallbacks[key]
        return true
      }
      case "transcript-tail": {
        const messages = this.tails.tail(msg)
        if (!messages) {
          // Not made against the window held (never expected): ask for the window whole again.
          if (this.subs.has(msg.slug)) {
            this.send({ t: "unsub", topic: "transcript", slug: msg.slug })
            this.send({ t: "sub", topic: "transcript", slug: msg.slug })
          }
          return true
        }
        const key = threadKey(this.project, msg.slug)
        writeTranscriptPush(qc, key, { t: "transcript", slug: msg.slug, messages, ...(msg.page ? { page: msg.page } : {}) })
        this.tails.adopt(msg.slug, cachedMessages(qc, key))
        delete store.socketTranscriptFallbacks[key]
        return true
      }
      case "file-changed":
        void qc?.invalidateQueries({ queryKey: localFileQueryKey(msg.path) })
        return true
      case "payload-too-large":
        // The board channel never sends one now (the board is read over HTTP); a transcript's still can.
        if (msg.channel === "transcript") {
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
        if (this.adoptKeyframe(event.board)) {
          this.seq = typeof event.seq === "number" ? event.seq : -1
          this.boot = event.bootId ?? null
        }
        return true
      case "board-delta":
        noteServerBootId(event.bootId)
        if (this.boot !== null && event.bootId !== this.boot) {
          this.resume.resync()
          return true
        }
        switch (deltaAction(this.seq, event.seq)) {
          case "apply": {
            const board = store.board ?? staged
            if (!board) {
              this.resume.resync()
              return true
            }
            // Patched threads are made whole against this project's views on the merged board, unkeyed
            // first, since a patch is the server's and names nothing by key (wirePatch.ts).
            const whole = expandBoardDelta(event, (slug) => {
              const key = threadKey(this.project, slug)
              const held = board.threads.find((t) => t.id === key)
              return held ? unkeyThread(held) : undefined
            })
            if (!whole) {
              this.resume.resync()
              return true
            }
            mergeDelta(board, this.project, whole)
            this.seq = event.seq
            this.resume.progressed()
            return true
          }
          case "ignore":
            return true
          case "resync":
            this.resume.resync()
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

  /** This project's board read over HTTP. Never steps the merged board back past a delta already applied. */
  private adopt(state: BoardState): boolean {
    noteServerBootId(state.bootId)
    if (this.closed) return false
    if (state.board.projectSlug && state.board.projectSlug !== this.project) return false
    if (this.boot === state.bootId && this.seq >= state.seq) return true
    if (!this.adoptKeyframe(state.board)) return false
    this.seq = state.seq
    this.boot = state.bootId
    return true
  }

  private adoptKeyframe(board: BoardSnapshot): boolean {
    if (!isConsolePath() || !active) return false
    mergeKeyframe(store.board ?? (staged ??= emptyUnion()), this.project, board)
    // The repo this project's `#123` and commit hashes link to. The merged board carries no project's
    // repo, so this board — the project's own — is the one place that knows it (lib/githubAutolink.ts).
    setProjectGithubRepo(this.project, board.githubRepo)
    this.keyframed = true
    maybePublish()
    return true
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
      this.tails.forget(slug)
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
 * Show the merged board once every project has answered — its first board, or a connection given up
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
    feed.start()
  }
  installHealth()
  reportConnection()
  // No project to wait for (none is open) publishes the empty board now; otherwise each board read asks.
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
    else location.assign(boardThreadHref(event.slug, project))
    n.close()
  }
}
