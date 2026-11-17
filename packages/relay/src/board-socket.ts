import {
  chunkWsMessage,
  decodeBody,
  encodeBody,
  parseFrame,
  serializeFrame,
  stripHopByHop,
  WsMessageAssembler,
  type RelayDownFrame,
  type RelayUpFrame,
} from "@frizz/shared"

/**
 * One board's live connection, and the requests in flight over it.
 *
 * This is the half that runs INSIDE a Durable Object — one instance per claimed name, which is what
 * makes the routing work at all: a visitor's request for `ada.frizz.sh` and Ada's board socket have to
 * meet somewhere, and a DO keyed by the name is the only place in Workers where they reliably can.
 *
 * Kept apart from the Worker entry so it can be tested without workerd: everything it touches is
 * passed in. The DO wrapper is then thin enough to read in one screen.
 */

/** A WebSocket as this file uses it — Node's and workerd's both satisfy it. */
export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** A visitor's WebSocket, waiting on or linked to one the board opened locally. */
interface NestedSocket {
  visitor: SocketLike
  /** Resolves once the board says whether it could open its end. */
  settle?: (ok: boolean) => void
}

/**
 * The head of the board's answer. `end` says the frame was the WHOLE answer — its body, or none — so
 * nothing further will arrive; without it a body-less answer and the head of a stream look the same,
 * and the visitor's stream for an empty 200, a HEAD or a redirect was never closed.
 */
export interface RelayedResponse {
  status: number
  headers: Array<[string, string]>
  body: Uint8Array | null
  end: boolean
}

/** A visitor's request as it goes down the socket, less the id each sending gives it. */
type RequestFrame = Omit<Extract<RelayDownFrame, { t: "req" }>, "t" | "id">

interface Pending {
  /** The id of its current sending. A request sent again after a reconnect gets a new one. */
  id: string
  /** Head resolved; the body may still be streaming. */
  settle: (response: RelayedResponse) => void
  fail: (reason: string) => void
  /** Present once a streamed body is underway. */
  stream?: { push: (chunk: Uint8Array) => void; end: () => void }
  frame: RequestFrame
  /**
   * The key of the board it was framed for. Its validators were filtered for that key and its answer is
   * tagged with it (visitor-headers.ts), so it is only ever sent to a socket that proved the same key.
   */
  key: string | null
  /** The board has answered with a head, so the request can no longer be sent again. */
  answered?: boolean
  /** Times it has been sent. Bounded by REPLAY_LIMIT, so a board that cannot stay connected cannot loop it. */
  sends: number
  /** The head's deadline. Armed once, when the visitor asked: sending it again does not restart it. */
  deadline?: unknown
  /** While it waits for a board to come back: the end of that wait, and the reason it fails with then. */
  waiting?: { timer: unknown; reason: string }
}

export interface BoardSocketOptions {
  /** How long a visitor waits before the board is declared unresponsive. */
  requestTimeoutMs?: number
  /** How long a visitor waits for a board that has just dropped its socket to dial back in. See BOARD_RETURN_GRACE_MS. */
  boardReturnGraceMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * The default is 30s because a board's SSE stream never "finishes" — the HEAD arrives promptly and the
 * body stays open. So the timeout guards the head only, and a stream that has started is never timed
 * out for still being open.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * How long a STARTED stream may sit with no chunks before it is ended.
 *
 * An open streamed response is what keeps the Durable Object awake — and billed — so a stream nobody
 * is feeding must not be allowed to hold it open forever. This is an inactivity bound, not a lifetime
 * cap: a live SSE feed re-arms it on every chunk and is never cut, while a stream orphaned by a
 * vanished board or visitor dies within minutes instead of pinning the object for days (measured:
 * ~30 object-hours per day of pure idle burn, which blew the free tier's daily cap with zero
 * traffic). A visitor cut mid-stream is an EventSource, and an EventSource reconnects by itself.
 */
const STREAM_IDLE_TIMEOUT_MS = 2 * 60_000

/**
 * How long a visitor waits for a board that has just lost its socket, before being told it is not there.
 *
 * A board's socket drops and comes back all the time, and the visitor should not see it. On 2026-11-16 one
 * board's socket was replaced 131 times in a day: Cloudflare cut it without a close frame (1006) the moment
 * a frame crossed it after an idle stretch, a ping or a visitor's request, and the board was back within
 * 1.5s (median; 34s at worst, over 131 reconnects). Every visitor request that met one of those cuts was
 * answered "The board did not answer", a 504 the phone showed instead of the board, until a reload. Ten
 * seconds covers the board's first five reconnect attempts (relay-connection.ts defaultBackoff) and keeps
 * a board that is really gone from holding its visitor much longer than a slow page would.
 */
const BOARD_RETURN_GRACE_MS = 10_000

/** How long after a board's socket goes the relay still expects it back, and holds a visitor for it. */
const BOARD_EXPECTED_BACK_MS = 60_000

/** How many times one visitor request may be sent. Enough for a reconnect or two, never a loop. */
const REPLAY_LIMIT = 3

/**
 * Methods the relay may send to the board again when the socket it went down died before an answer
 * came back. Whether the board saw the first one is unknowable, so only a request that is safe to repeat
 * is repeated (RFC 9110 §9.2.1): a page, an asset, an RPC query. A mutation is a POST, and fails as before.
 */
const REPEATABLE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"])

export class BoardSocket {
  private socket: SocketLike | null = null
  /** The key the current board proved itself with, kept after it goes, so a request in the gap knows whose it is. */
  private key: string | null = null
  private readonly pending = new Map<string, Pending>()
  /** Requests waiting for a board to dial back in, to be sent the moment one does. */
  private readonly waiting = new Set<Pending>()
  /** Callers of `whenConnected` waiting for the same. */
  private readonly returning = new Set<(connected: boolean) => void>()
  /** When the board's socket last went, so a request in the gap waits for it instead of failing. */
  private lostAt: number | null = null
  private readonly nested = new Map<string, NestedSocket>()
  /** Rebuilds board messages that were too large for one frame. See RELAY_MAX_WS_CHUNK. */
  private readonly inbound = new WsMessageAssembler()
  private readonly timers = new Map<string, unknown>()
  private counter = 0
  /** Set by `nextId`. See there. */
  private idPrefix: string | null = null
  private readonly options: Required<Pick<BoardSocketOptions, "requestTimeoutMs" | "boardReturnGraceMs" | "now">> &
    Pick<BoardSocketOptions, "setTimer" | "clearTimer">

  constructor(options: BoardSocketOptions = {}) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      boardReturnGraceMs: options.boardReturnGraceMs ?? BOARD_RETURN_GRACE_MS,
      now: options.now ?? Date.now,
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
      ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
    }
  }

  get connected(): boolean {
    return this.socket !== null
  }

  /**
   * Whether a board that lost its socket a moment ago is worth waiting for. Without a timer nothing could
   * end the wait, so nothing waits; the Durable Object always has one.
   */
  private expectingBoard(): boolean {
    return (
      this.options.setTimer !== undefined &&
      this.options.boardReturnGraceMs > 0 &&
      this.lostAt !== null &&
      this.options.now() - this.lostAt < BOARD_EXPECTED_BACK_MS
    )
  }

  /**
   * True once a board is connected: at once if one is, after it dials back in if its socket went a moment
   * ago, and false when none comes within the grace or none was here to come back.
   */
  whenConnected(): Promise<boolean> {
    if (this.socket) return Promise.resolve(true)
    if (!this.expectingBoard()) return Promise.resolve(false)
    return new Promise((resolve) => {
      let timer: unknown
      const done = (connected: boolean) => {
        if (!this.returning.delete(done)) return
        this.options.clearTimer?.(timer)
        resolve(connected)
      }
      this.returning.add(done)
      timer = this.options.setTimer!(() => done(false), this.options.boardReturnGraceMs)
    })
  }

  /**
   * An id no earlier instance used. A Durable Object can lose its memory while the board's socket
   * survives, and the board then keeps streaming under the old id, so a counter alone would hand that
   * id, and that stream, to a stranger's new request. The prefix is made on first use because this
   * class is constructed where a Worker may not be able to generate randomness yet.
   */
  private nextId(kind: "r" | "w"): string {
    this.idPrefix ??= crypto.randomUUID().slice(0, 8)
    return `${kind}${this.idPrefix}-${++this.counter}`
  }

  /**
   * A board has dialled in, proven with `key`. Any previous socket is replaced — a reconnect wins over a
   * corpse.
   */
  attach(socket: SocketLike, key: string | null = null): void {
    const previous = this.socket
    this.socket = socket
    this.key = key
    this.lostAt = null
    if (previous) {
      // The old socket may simply be a stale reconnect from the same board. Nothing in flight on it
      // can be answered now: a request that is safe to repeat goes down the new socket instead, and
      // the rest fail rather than let visitors wait out the full timeout.
      this.failAll("the board reconnected")
      try {
        previous.close(1000, "replaced by a newer connection")
      } catch {
        // Already gone; nothing to do.
      }
    }
    for (const entry of [...this.waiting]) {
      // The name changed hands while it waited: what it carries was meant for the other key's board.
      if (entry.key !== key) {
        this.finish(entry)
        entry.fail("the board's key changed")
        continue
      }
      this.dispatch(entry)
    }
    for (const done of [...this.returning]) done(true)
  }

  detach(socket: SocketLike): void {
    if (this.socket !== socket) return // a stale socket closing after being replaced
    this.socket = null
    this.lostAt = this.options.now()
    this.failAll("the board disconnected")
  }

  private failAll(reason: string): void {
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id)
      this.clear(id)
      // Not answered yet and safe to send again: hold it for the board to come back, which it nearly
      // always does within a second or two. See BOARD_RETURN_GRACE_MS.
      if (this.mayResend(entry)) {
        this.wait(entry, reason)
        continue
      }
      this.finish(entry)
      entry.fail(reason)
      // A settled head cannot be failed — the promise already resolved — so a streaming response has
      // to be ENDED here or it stays open with nothing left to feed it. Before this line, a board
      // that disconnected left every visitor's SSE response open indefinitely, and those orphaned
      // streams held the Durable Object awake (and billed) for days.
      entry.stream?.end()
    }
    // A terminal is useless once the board it was typing into has gone. Closing tells the browser at
    // once, instead of leaving a dead pane that looks live until someone types into it.
    for (const [id, session] of [...this.nested]) {
      this.nested.delete(id)
      this.inbound.forget(id)
      session.settle?.(false)
      try {
        session.visitor.close(1001, reason)
      } catch {
        // Already gone.
      }
    }
  }

  private clear(id: string): void {
    const handle = this.timers.get(id)
    if (handle !== undefined) {
      this.timers.delete(id)
      this.options.clearTimer?.(handle)
    }
  }

  /** (Re)arm the inactivity bound on a started stream. Every chunk pushes it back; see STREAM_IDLE_TIMEOUT_MS. */
  private armIdleTimer(id: string, entry: Pending): void {
    if (!this.options.setTimer) return
    this.timers.set(
      id,
      this.options.setTimer(() => {
        if (!this.pending.delete(id)) return
        this.timers.delete(id)
        entry.stream?.end()
        // The board's local request is still producing. Abort it, or it streams into the void forever.
        this.send({ t: "req-cancel", id })
      }, STREAM_IDLE_TIMEOUT_MS)
    )
  }

  private send(frame: RelayDownFrame): boolean {
    if (!this.socket) return false
    try {
      this.socket.send(serializeFrame(frame))
      return true
    } catch {
      return false
    }
  }

  /**
   * Forward a visitor request and wait for the head.
   *
   * Resolves as soon as the STATUS AND HEADERS arrive. A streamed body is delivered through `onChunk`
   * afterwards, which is what lets an SSE response reach the visitor while it is still being produced
   * rather than being buffered until it ends — and it never ends.
   */
  async request(
    input: { method: string; url: string; headers: Array<[string, string]>; body?: Uint8Array },
    stream?: { push: (chunk: Uint8Array) => void; end: () => void }
  ): Promise<RelayedResponse> {
    if (!this.socket && !this.expectingBoard()) throw new Error("the board is not connected")

    return new Promise((resolve, reject) => {
      const entry: Pending = {
        id: "",
        settle: resolve,
        fail: (reason) => reject(new Error(reason)),
        ...(stream ? { stream } : {}),
        frame: {
          method: input.method,
          url: input.url,
          headers: stripHopByHop(input.headers),
          ...(input.body && input.body.byteLength > 0 ? { body: encodeBody(input.body) } : {}),
        },
        sends: 0,
        key: this.key,
      }
      if (this.options.setTimer) {
        entry.deadline = this.options.setTimer(() => {
          if (this.pending.get(entry.id) === entry) {
            this.pending.delete(entry.id)
            this.clear(entry.id)
          }
          this.finish(entry)
          entry.fail("the board did not answer in time")
        }, this.options.requestTimeoutMs)
      }
      // Never sent, so waiting is safe whatever the method: the board went a moment ago and is due back.
      if (this.socket) this.dispatch(entry)
      else this.wait(entry, "the board is not connected")
    })
  }

  /** Whether a request may go down another socket: unanswered, safe to repeat, and not sent too often. */
  private mayResend(entry: Pending): boolean {
    return (
      !entry.answered &&
      entry.sends < REPLAY_LIMIT &&
      REPEATABLE_METHODS.has(entry.frame.method.toUpperCase()) &&
      this.options.setTimer !== undefined &&
      this.options.boardReturnGraceMs > 0
    )
  }

  /** Send a request down the current socket under a fresh id, or hold it for the board if there is none. */
  private dispatch(entry: Pending): void {
    this.waiting.delete(entry)
    if (entry.waiting) {
      this.options.clearTimer?.(entry.waiting.timer)
      delete entry.waiting
    }
    entry.id = this.nextId("r")
    entry.sends += 1
    this.pending.set(entry.id, entry)
    if (this.send({ t: "req", id: entry.id, ...entry.frame })) return
    this.pending.delete(entry.id)
    if (this.mayResend(entry)) {
      this.wait(entry, "the board is not connected")
      return
    }
    this.finish(entry)
    entry.fail("the board is not connected")
  }

  /** Hold a request until a board dials in, and fail it with `reason` if none does within the grace. */
  private wait(entry: Pending, reason: string): void {
    this.waiting.add(entry)
    const timer = this.options.setTimer!(() => {
      if (!this.waiting.delete(entry)) return
      delete entry.waiting
      this.finish(entry)
      entry.fail(reason)
    }, this.options.boardReturnGraceMs)
    entry.waiting = { timer, reason }
  }

  /** Disarm a request's own timers once it is answered or has failed. */
  private finish(entry: Pending): void {
    this.waiting.delete(entry)
    if (entry.waiting) {
      this.options.clearTimer?.(entry.waiting.timer)
      delete entry.waiting
    }
    if (entry.deadline !== undefined) {
      this.options.clearTimer?.(entry.deadline)
      delete entry.deadline
    }
  }

  /**
   * Ask the board to open a nested WebSocket — a terminal — and link it to this visitor.
   *
   * Resolves to the session id, or null when the board refuses or is not there — so the caller can
   * answer the upgrade with a normal error instead of a socket that accepts and then goes silent. The
   * id is what labels every later message from this visitor.
   */
  async openWebSocket(
    input: { url: string; headers: Array<[string, string]> },
    visitor: SocketLike
  ): Promise<string | null> {
    if (!this.socket) return null
    const id = this.nextId("w")
    return new Promise<string | null>((resolve) => {
      const done = (ok: boolean) => resolve(ok ? id : null)
      this.nested.set(id, { visitor, settle: done })
      const sent = this.send({ t: "ws-open", id, url: input.url, headers: stripHopByHop(input.headers) })
      if (!sent) {
        this.nested.delete(id)
        resolve(null)
        return
      }
      if (this.options.setTimer) {
        this.options.setTimer(() => {
          const session = this.nested.get(id)
          if (!session?.settle) return // already answered
          this.nested.delete(id)
          session.settle(false)
        }, this.options.requestTimeoutMs)
      }
    })
  }

  /** The visitor sent something. Forward it down to the board, in pieces if it is large. */
  sendWebSocketMessage(id: string, data: string, binary = false): void {
    const parts = chunkWsMessage(data)
    parts.forEach((part, index) =>
      this.send({
        t: "ws-msg",
        id,
        data: part,
        ...(binary ? { binary: true } : {}),
        ...(index < parts.length - 1 ? { more: true } : {}),
      })
    )
  }

  /** The visitor's side closed. Tell the board so it can close its local end too. */
  closeWebSocket(id: string, code?: number): void {
    this.nested.delete(id)
    this.inbound.forget(id)
    this.send({ t: "ws-close", id, ...(code !== undefined ? { code } : {}) })
  }

  /** A frame arrived from the board. Unknown ids are ignored — a late answer is not an error. */
  handleFrame(raw: string): void {
    const frame = parseFrame(raw) as RelayUpFrame | null
    if (!frame) return
    const entry = this.pending.get(frame.id)

    switch (frame.t) {
      case "res": {
        // A second head for one request is a board breaking the protocol. Taking it would drop the entry
        // while its stream is open, and leave the visitor's response, and the object, open for good.
        if (!entry || entry.answered) return
        this.clear(frame.id)
        entry.answered = true
        this.finish(entry)
        // The head is settled here, but the entry STAYS while a body streams — res-chunk and res-end
        // still need somewhere to land. Removing it now is what would drop an SSE body on the floor.
        if (frame.end) this.pending.delete(frame.id)
        else this.armIdleTimer(frame.id, entry)
        entry.settle({
          status: frame.status,
          headers: stripHopByHop(frame.headers),
          body: frame.body ? decodeBody(frame.body) : null,
          end: frame.end,
        })
        return
      }
      case "res-chunk": {
        if (!entry) return
        this.clear(frame.id)
        this.armIdleTimer(frame.id, entry)
        try {
          entry.stream?.push(decodeBody(frame.data))
        } catch {
          // The visitor hung up. Drop the entry and abort the board's local request, or an SSE feed
          // keeps producing chunks for a reader that no longer exists — each one waking this object.
          this.pending.delete(frame.id)
          this.clear(frame.id)
          entry.stream?.end()
          this.send({ t: "req-cancel", id: frame.id })
        }
        return
      }
      case "res-end": {
        if (!entry) return
        this.pending.delete(frame.id)
        this.clear(frame.id)
        entry.stream?.end()
        return
      }
      case "ws-ack": {
        const session = this.nested.get(frame.id)
        if (!session) return
        const settle = session.settle
        delete session.settle
        if (!frame.ok) this.nested.delete(frame.id)
        settle?.(frame.ok)
        return
      }
      case "ws-msg": {
        const session = this.nested.get(frame.id)
        if (!session) return
        const whole = this.inbound.push(frame.id, frame.data, frame.more)
        if (whole === null) return
        try {
          session.visitor.send(whole)
        } catch {
          this.nested.delete(frame.id)
        }
        return
      }
      case "ws-close": {
        const session = this.nested.get(frame.id)
        if (!session) return
        this.nested.delete(frame.id)
        this.inbound.forget(frame.id)
        session.settle?.(false)
        try {
          session.visitor.close(frame.code ?? 1000)
        } catch {
          // Already gone.
        }
        return
      }
      default:
        return
    }
  }
}
