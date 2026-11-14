import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot, BoardState, SocketServerMsg } from "@frizz/shared"

type Listener = (event: unknown) => void

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readonly sent: string[] = []
  readyState = FakeWebSocket.CONNECTING
  closeCalls = 0
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onerror: Listener | null = null
  onclose: Listener | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }

  message(message: SocketServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  serverClose(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({})
  }

  send(data: string): void {
    this.sent.push(String(data))
  }

  close(): void {
    this.closeCalls++
    this.readyState = FakeWebSocket.CLOSED
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  closeCalls = 0
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onerror: Listener | null = null
  private listeners = new Map<string, Listener[]>()

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close(): void {
    this.closeCalls++
  }
}

interface FakeTimeout {
  id: number
  delay: number
  run: () => void
  cleared: boolean
}

test("socket transport bounds oversized frames, only resets reconnect backoff after protocol traffic, and resumes the board it read", async () => {
  const globals = new Map<PropertyKey, PropertyDescriptor | undefined>()
  const install = (key: PropertyKey, value: unknown) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }

  const windowListeners = new Map<string, Listener[]>()
  const documentListeners = new Map<string, Listener[]>()
  const addListener = (target: Map<string, Listener[]>) => (type: string, listener: Listener) => {
    const listeners = target.get(type) ?? []
    listeners.push(listener)
    target.set(type, listeners)
  }
  const storage = new Map<string, string>()
  const timeouts: FakeTimeout[] = []
  let nextTimer = 0
  const intervals = new Set<number>()

  // The board read over HTTP (rpc.boardState). Each call is answered from `boardState` as it is when
  // the read is made, so a test moves the server's board by assigning it.
  const board: BoardSnapshot = {
    projectDir: "/fixture",
    projectName: "fixture",
    projectLabel: "fixture/fixture",
    threads: [],
    errors: [],
    warnings: [],
  }
  let boardState: BoardState = { board, seq: 1, bootId: "boot-test" }
  const reads: string[] = []
  install("fetch", async (url: string) => {
    reads.push(String(url))
    return new Response(JSON.stringify({ result: boardState }), { status: 200, headers: { "content-type": "application/json" } })
  })
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  install("WebSocket", FakeWebSocket)
  install("EventSource", FakeEventSource)
  install("location", { origin: "http://127.0.0.1:54917", reload: () => {} })
  install("window", {
    addEventListener: addListener(windowListeners),
    removeEventListener: () => {},
    focus: () => {},
  })
  install("document", {
    readyState: "complete",
    hidden: false,
    addEventListener: addListener(documentListeners),
    removeEventListener: () => {},
  })
  install("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  install("setTimeout", ((fn: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const timeout: FakeTimeout = {
      id: ++nextTimer,
      delay,
      run: () => fn(...args),
      cleared: false,
    }
    timeouts.push(timeout)
    return timeout.id
  }) as typeof setTimeout)
  install("clearTimeout", ((id: number) => {
    const timeout = timeouts.find((candidate) => candidate.id === Number(id))
    if (timeout) timeout.cleared = true
  }) as typeof clearTimeout)
  install("setInterval", ((() => {
    const id = ++nextTimer
    intervals.add(id)
    return id
  }) as unknown) as typeof setInterval)
  install("clearInterval", ((id: number) => {
    intervals.delete(Number(id))
  }) as typeof clearInterval)

  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => { warnings.push(args) }

  const hello: SocketServerMsg = { t: "hello", bootId: "boot-test", seq: 1 }
  // What a socket sent, less the board resume it names on every hello (asserted on its own below).
  const subsSent = (sock: FakeWebSocket) => sock.sent.map((raw) => JSON.parse(raw)).filter((m) => m.t !== "board")
  const boardSent = (sock: FakeWebSocket) => sock.sent.map((raw) => JSON.parse(raw)).filter((m) => m.t === "board")
  const cache = new Map<string, unknown>()
  const queryClient = {
    setQueryData(key: readonly unknown[], update: unknown) {
      const cacheKey = JSON.stringify(key)
      const previous = cache.get(cacheKey)
      cache.set(cacheKey, typeof update === "function" ? (update as (value: unknown) => unknown)(previous) : update)
    },
    invalidateQueries: async (filters?: { queryKey?: readonly unknown[] }) => {
      if (filters?.queryKey) invalidated.push(filters.queryKey)
    },
  }
  const invalidated: (readonly unknown[])[] = []
  const projectListReads = () => invalidated.filter((key) => key[0] === "projectsList").length

  const resetTransportFixtures = () => {
    FakeWebSocket.instances = []
    timeouts.length = 0
    windowListeners.clear()
    documentListeners.clear()
  }
  const nextReconnect = (expectedDelay: number) => {
    const timeout = timeouts.find((candidate) => !candidate.cleared)
    assert.ok(timeout, `expected a ${expectedDelay}ms reconnect`)
    assert.equal(timeout.delay, expectedDelay)
    timeout.cleared = true
    timeout.run()
  }

  try {
    const { store } = await import("../store.ts")

    // Opening TCP repeatedly is not enough to erase failure history. A healthy protocol frame is.
    resetTransportFixtures()
    store.connection = "connecting"
    store.socketTranscripts = false
    store.socketTranscriptFallbacks = {}
    const backoff = await import(`./socket.ts?backoff-${Date.now()}`)
    backoff.connectSync(queryClient as never)
    await settle()
    const first = FakeWebSocket.instances[0]
    first.open()
    first.serverClose()
    nextReconnect(1_000)
    const second = FakeWebSocket.instances[1]
    second.open()
    second.serverClose()
    nextReconnect(2_000)
    const third = FakeWebSocket.instances[2]
    third.open()
    third.message({ t: "hb" })
    third.serverClose()
    assert.equal(timeouts.find((candidate) => !candidate.cleared)?.delay, 1_000)

    // A transcript overflow removes only that live subscription. It neither reconnects nor polls;
    // one explicit retry sends one subscription and a normal frame clears the stable fallback.
    resetTransportFixtures()
    store.connection = "connecting"
    store.socketTranscripts = false
    store.socketTranscriptFallbacks = {}
    const transcript = await import(`./socket.ts?transcript-${Date.now()}`)
    transcript.connectSync(queryClient as never)
    await settle()
    const transcriptSocket = FakeWebSocket.instances[0]
    transcriptSocket.open()
    transcript.subscribeTranscript("large-thread")
    assert.deepEqual(transcriptSocket.sent, [], "subscriptions wait for the server's hello")
    transcriptSocket.message(hello)
    assert.deepEqual(subsSent(transcriptSocket), [
      { t: "sub", topic: "transcript", slug: "large-thread" },
    ])
    transcriptSocket.message({
      t: "payload-too-large",
      channel: "transcript",
      slug: "large-thread",
      actualBytes: 4_194_305,
      maxBytes: 4_194_304,
    })
    assert.deepEqual(store.socketTranscriptFallbacks["large-thread"], {
      kind: "payload-too-large",
      actualBytes: 4_194_305,
      maxBytes: 4_194_304,
    })
    assert.equal(transcriptSocket.readyState, FakeWebSocket.OPEN)
    assert.equal(FakeEventSource.instances.length, 0)
    assert.equal(timeouts.length, 0, "a logical overflow cannot enter reconnect backoff")
    transcript.subscribeTranscript("large-thread")
    assert.equal(subsSent(transcriptSocket).length, 1, "additional mounted views cannot auto-retry a paused slug")
    transcript.retryTranscriptSocket("large-thread")
    assert.equal(subsSent(transcriptSocket).length, 2, "the explicit retry sends exactly one subscription")
    transcriptSocket.message({
      t: "transcript",
      slug: "large-thread",
      messages: [{ role: "assistant", text: "small again", tools: [], parts: [] }],
    })
    assert.equal(store.socketTranscriptFallbacks["large-thread"], undefined)
    assert.deepEqual(cache.get(JSON.stringify(["transcript", "large-thread"])), {
      messages: [{ role: "assistant", text: "small again", tools: [], parts: [] }],
    })

    // A push carrying its PAGE ENVELOPE is the same bounded latest window the HTTP page read returns, and
    // reconciles the same way: the envelope lands beside the messages (a slid window's cursor cannot go
    // stale), `editedFiles` and `worktreeChanges` — which never ride a push — keep the HTTP copy, and a
    // page that no longer overlaps what is held (a new transcriptKey) replaces it outright.
    const pageKey = JSON.stringify(["transcript", "large-thread"])
    cache.set(pageKey, {
      messages: [{ role: "assistant", text: "small again", tools: [], parts: [] }],
      beforeCursor: "stale-cursor",
      hasEarlier: true,
      reachedTurnBoundary: true,
      transcriptKey: "key-1",
      editedFiles: [{ path: "src/a.ts", edits: 2 }],
      worktreeChanges: [{ root: "/wt", base: "main", files: [{ path: "/wt/b.ts", status: "added", added: 1 }] }],
    })
    transcriptSocket.message({
      t: "transcript",
      slug: "large-thread",
      messages: [{ role: "assistant", text: "small again", tools: [], parts: [] }, { role: "assistant", text: "and more", tools: [], parts: [] }],
      page: { beforeCursor: "fresh-cursor", hasEarlier: true, reachedTurnBoundary: true, transcriptKey: "key-1" },
    })
    assert.deepEqual(cache.get(pageKey), {
      messages: [
        { role: "assistant", text: "small again", tools: [], parts: [] },
        { role: "assistant", text: "and more", tools: [], parts: [] },
      ],
      beforeCursor: "fresh-cursor",
      hasEarlier: true,
      reachedTurnBoundary: true,
      transcriptKey: "key-1",
      editedFiles: [{ path: "src/a.ts", edits: 2 }],
      worktreeChanges: [{ root: "/wt", base: "main", files: [{ path: "/wt/b.ts", status: "added", added: 1 }] }],
    })
    transcriptSocket.message({
      t: "transcript",
      slug: "large-thread",
      messages: [{ role: "assistant", text: "replaced", tools: [], parts: [] }],
      page: { beforeCursor: null, hasEarlier: false, reachedTurnBoundary: true, transcriptKey: "key-2" },
    })
    assert.deepEqual(cache.get(pageKey), {
      messages: [{ role: "assistant", text: "replaced", tools: [], parts: [] }],
      beforeCursor: null,
      hasEarlier: false,
      reachedTurnBoundary: true,
      transcriptKey: "key-2",
      editedFiles: [{ path: "src/a.ts", edits: 2 }],
      worktreeChanges: [{ root: "/wt", base: "main", files: [{ path: "/wt/b.ts", status: "added", added: 1 }] }],
    })
    cache.delete(pageKey)

    // A fresh page/module has no stale failure latch: after the payload shrinks, normal hello +
    // transcript traffic resumes without requiring a special server-side recovery state.
    transcriptSocket.close()
    resetTransportFixtures()
    store.connection = "connecting"
    store.socketTranscripts = false
    store.socketTranscriptFallbacks = {}
    const reloaded = await import(`./socket.ts?reload-${Date.now()}`)
    reloaded.connectSync(queryClient as never)
    await settle()
    const reloadedSocket = FakeWebSocket.instances[0]
    reloadedSocket.open()
    reloaded.subscribeTranscript("large-thread")
    reloadedSocket.message(hello)
    reloadedSocket.message({
      t: "transcript",
      slug: "large-thread",
      messages: [{ role: "assistant", text: "recovered on reload", tools: [], parts: [] }],
    })
    assert.equal(store.socketTranscriptFallbacks["large-thread"], undefined)
    assert.equal(subsSent(reloadedSocket).length, 1)

    // Aggregate server read pressure rejects only the affected subscription with a typed, stable state.
    // It never drops the board socket; one human retry sends one new sub and normal truth clears it.
    reloadedSocket.close()
    resetTransportFixtures()
    store.connection = "connecting"
    store.socketTranscripts = false
    store.socketTranscriptFallbacks = {}
    const limited = await import(`./socket.ts?limited-${Date.now()}`)
    limited.connectSync(queryClient as never)
    await settle()
    const limitedSocket = FakeWebSocket.instances[0]
    limitedSocket.open()
    limited.subscribeTranscript("busy-thread")
    limitedSocket.message(hello)
    limitedSocket.message({
      t: "resource-limited",
      resource: "transcript-read",
      scope: "origin",
      slug: "busy-thread",
      retryAfterMs: 750,
    })
    assert.deepEqual(store.socketTranscriptFallbacks["busy-thread"], {
      kind: "read-budget",
      scope: "origin",
      retryAfterMs: 750,
    })
    assert.equal(limitedSocket.readyState, FakeWebSocket.OPEN)
    // A budget refusal is transient by definition, so the client arms ONE retry after the server's own
    // retry-after (plus spread) and never a reconnect. Running it re-sends exactly one subscription.
    assert.equal(timeouts.length, 1, "one budget retry, no reconnect backoff")
    assert.ok(timeouts[0].delay >= 750 && timeouts[0].delay < 750 + 400, `retry waits the server's retry-after: ${timeouts[0].delay}`)
    timeouts[0].cleared = true
    timeouts[0].run()
    assert.equal(store.socketTranscriptFallbacks["busy-thread"], undefined)
    assert.equal(subsSent(limitedSocket).length, 2, "the automatic retry sends exactly one subscription")
    limitedSocket.message({
      t: "resource-limited",
      resource: "transcript-read",
      scope: "origin",
      slug: "busy-thread",
      retryAfterMs: 750,
    })
    assert.equal(timeouts.length, 2, "a second refusal arms a second retry")
    timeouts[1].cleared = true
    limited.retryTranscriptSocket("busy-thread")
    assert.equal(subsSent(limitedSocket).length, 3, "the explicit retry sends exactly one subscription")
    limitedSocket.message({
      t: "transcript",
      slug: "busy-thread",
      messages: [{ role: "assistant", text: "budget recovered", tools: [], parts: [] }],
    })
    assert.equal(store.socketTranscriptFallbacks["busy-thread"], undefined)

    // THE PROJECT LIST HAS NO RESUME. The server's `projects-changed` is what carries a reorder made
    // in one tab to every other, and it re-reads the list. So does every live generation after the
    // first: an announcement published while this tab had no socket is never repeated, and without the
    // catch-up the rail would keep its old order until a reload — the bug the event exists to fix. The
    // first hello re-reads nothing, because the rail's own mount read is seconds old.
    limitedSocket.close()
    resetTransportFixtures()
    store.connection = "connecting"
    store.socketTranscripts = false
    store.socketTranscriptFallbacks = {}
    const listed = await import(`./socket.ts?projects-${Date.now()}`)
    listed.connectSync(queryClient as never)
    await settle()
    const readsBefore = projectListReads()
    const listedSocket = FakeWebSocket.instances[0]
    listedSocket.open()
    listedSocket.message(hello)
    assert.equal(projectListReads(), readsBefore, "the first hello re-reads nothing")
    listedSocket.message({ t: "event", event: { type: "projects-changed" } })
    assert.equal(projectListReads(), readsBefore + 1, "the announcement re-reads the list once")
    assert.equal(FakeWebSocket.instances.length, 1, "it is not a board frame, so it cannot force a resync")
    listedSocket.serverClose()
    nextReconnect(1_000)
    const relisted = FakeWebSocket.instances[1]
    relisted.open()
    assert.equal(projectListReads(), readsBefore + 1, "an open socket is not a live feed yet")
    relisted.message(hello)
    assert.equal(projectListReads(), readsBefore + 2, "a feed back from a drop catches up on what it missed")

    // THE BOARD IS READ OVER HTTP AND RESUMED ON THE SOCKET (board-resume.ts). One read as the page
    // loads, never a board frame on the socket; the socket names the read's (boot, seq) on hello, a
    // drop keeps them for the next hello, and a `board-resync` re-reads and names the new seq on the
    // SAME socket. Nothing here may reconnect or fall back to SSE.
    relisted.close()
    resetTransportFixtures()
    FakeEventSource.instances = []
    store.board = null
    // Read through a function: the assignment above narrows `store.board` to null for the rest of the test.
    const liveBoard = (): BoardSnapshot | null => store.board
    store.connection = "connecting"
    store.socketTranscriptFallbacks = {}
    reads.length = 0
    boardState = { board: { ...board, threads: [] }, seq: 5, bootId: "boot-test" }
    const resumed = await import(`./socket.ts?resume-${Date.now()}`)
    resumed.connectSync(queryClient as never)
    assert.equal(reads.length, 1, "the board is read as the page loads, before the socket opens")
    assert.match(reads[0], /\/_frizz\/rpc\/boardState$/)
    await settle()
    assert.equal(liveBoard()?.projectName, "fixture", "the read is the page's first board")
    const resumeSocket = FakeWebSocket.instances[0]
    resumeSocket.open()
    assert.deepEqual(boardSent(resumeSocket), [], "nothing is named before the server says hello")
    resumeSocket.message({ t: "hello", bootId: "boot-test", seq: 6 })
    assert.deepEqual(boardSent(resumeSocket), [{ t: "board", bootId: "boot-test", seq: 5 }], "hello names the board read")
    assert.equal(reads.length, 1, "and reads nothing more")

    // The server replays the gap; each delta applies in order.
    const thread = (id: string) => ({ id, title: id, status: "active", runtime: "turn-idle", dependsOn: [] })
    resumeSocket.message({ t: "event", event: { type: "board-delta", seq: 6, bootId: "boot-test", upserts: [thread("a") as never], removed: [] } })
    assert.deepEqual(liveBoard()?.threads.map((t) => t.id), ["a"])

    // A drop keeps the board and its seq: the next socket names seq 6 and no read is made.
    resumeSocket.serverClose()
    nextReconnect(1_000)
    const again = FakeWebSocket.instances[1]
    again.open()
    again.message({ t: "hello", bootId: "boot-test", seq: 9 })
    assert.deepEqual(boardSent(again), [{ t: "board", bootId: "boot-test", seq: 6 }], "a reconnect resumes from the seq it held")
    assert.equal(reads.length, 1)
    assert.deepEqual(liveBoard()?.threads.map((t) => t.id), ["a"], "and the board stayed on screen through the drop")

    // The ring has rolled past seq 6: the server says so, the board is read again, and the new seq is
    // named on the same socket.
    boardState = { board: { ...board, threads: [thread("a"), thread("b"), thread("c")] as never }, seq: 9, bootId: "boot-test" }
    again.message({ t: "board-resync", reason: "expired" })
    assert.equal(reads.length, 2)
    await settle()
    assert.deepEqual(liveBoard()?.threads.map((t) => t.id), ["a", "b", "c"])
    assert.deepEqual(boardSent(again).at(-1), { t: "board", bootId: "boot-test", seq: 9 })
    assert.equal(FakeWebSocket.instances.length, 2, "a resync is not a reconnect")

    // A delta that skips a seq is not applied; the board is read again instead.
    again.message({ t: "event", event: { type: "board-delta", seq: 11, bootId: "boot-test", upserts: [thread("skipped") as never], removed: [] } })
    assert.equal(reads.length, 3)
    assert.ok(!liveBoard()?.threads.some((t) => t.id === "skipped"), "a delta past a gap never lands")
    await settle()
    assert.deepEqual(boardSent(again).at(-1), { t: "board", bootId: "boot-test", seq: 9 })

    // A server that restarted: its hello names another boot, so the held seq means nothing there. The
    // board is read again before anything is named, and the stale seq is never sent.
    again.serverClose()
    nextReconnect(1_000)
    boardState = { board: { ...board, threads: [thread("fresh")] as never }, seq: 2, bootId: "boot-next" }
    const restarted = FakeWebSocket.instances[2]
    restarted.open()
    restarted.message({ t: "hello", bootId: "boot-next", seq: 2 })
    assert.deepEqual(boardSent(restarted), [], "a seq from another boot is not named")
    assert.equal(reads.length, 4)
    await settle()
    assert.deepEqual(boardSent(restarted), [{ t: "board", bootId: "boot-next", seq: 2 }])
    assert.deepEqual(liveBoard()?.threads.map((t) => t.id), ["fresh"])
    assert.equal(FakeEventSource.instances.length, 0, "the board never sends the page to SSE")
    // The second budget refusal above lands on a cleared latch and so is a new event worth one line —
    // a refusal repeated on a still-latched slug is what must stay silent.
    assert.equal(warnings.length, 3, "each explicit downgrade logs once without console churn")
  } finally {
    console.warn = originalWarn
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
