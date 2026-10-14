import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot, SocketServerMsg, ThreadView } from "@frizz/shared"

// THE CONSOLE'S FEED ACROSS ITS OWN LIFETIME — leaving it, coming back, and the projects that answer
// late or answer too big. consoleFeed.test.ts pins the merge; this pins when the merged board may be
// SHOWN, because every bug here was a board shown with a project missing from it and nothing saying so.

type Listener = (event: unknown) => void

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readonly sent: unknown[] = []
  readyState = FakeWebSocket.CONNECTING
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
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  closed = false
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onerror: Listener | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  addEventListener(): void {}
  close(): void {
    this.closed = true
  }
}

const thread = (id: string): ThreadView => ({ id, title: id, dependsOn: [], needsYou: true }) as unknown as ThreadView
const keyframe = (projectSlug: string, ids: string[], githubRepo?: string): SocketServerMsg => ({
  t: "event",
  event: {
    type: "board",
    seq: 1,
    bootId: "boot-test",
    board: { projectDir: `/fixture/${projectSlug}`, projectName: projectSlug, projectSlug, githubRepo, threads: ids.map(thread), errors: [], warnings: [] } as BoardSnapshot,
  },
})
const socketFor = (path: string) => FakeWebSocket.instances.filter((s) => new URL(s.url).pathname === path).at(-1)

test("the Console's feed shows a board only once every project in it has answered, across leaving and coming back", async () => {
  const globals = new Map<PropertyKey, PropertyDescriptor | undefined>()
  const install = (key: PropertyKey, value: unknown) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const replaced: string[] = []
  const here = { origin: "http://127.0.0.1:54917", pathname: "/", reload: () => {}, replace: (url: string) => replaced.push(url), assign: () => {} }
  const listeners = new Map<string, Listener[]>()
  const on = (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn])
  const fire = (type: string) => { for (const fn of listeners.get(type) ?? []) fn({}) }
  install("WebSocket", FakeWebSocket)
  install("EventSource", FakeEventSource)
  install("location", here)
  install("window", { addEventListener: on, removeEventListener: () => {}, focus: () => {} })
  install("document", { readyState: "complete", hidden: false, addEventListener: on, removeEventListener: () => {} })
  install("setTimeout", (() => 0) as unknown as typeof setTimeout)
  install("clearTimeout", (() => {}) as unknown as typeof clearTimeout)
  install("setInterval", (() => 0) as unknown as typeof setInterval)
  install("clearInterval", (() => {}) as unknown as typeof clearInterval)
  install("fetch", (() => new Promise(() => {})) as unknown as typeof fetch)

  const queryClient = { setQueryData: () => {}, invalidateQueries: async () => {} }

  try {
    const { store, resolveRoutedThread } = await import("../store.ts")
    const socket = await import("./socket.ts")
    const feed = await import("./consoleFeed.ts")
    const { githubRepoFor } = await import("../lib/githubAutolink.ts")
    feed.initConsoleFeed(queryClient as never)
    const ids = () => store.board?.threads.map((t) => t.id).sort() ?? null

    // A cold load of the grid holds the launching project's connection.
    here.pathname = "/"
    socket.connectSync(queryClient as never)
    assert.equal(socketFor("/_frizz/ws")?.url, "ws://127.0.0.1:54917/_frizz/ws")

    // 1. INTO THE CONSOLE: nothing is shown until both projects have answered.
    here.pathname = "/console"
    store.board = null
    socket.bindConsole()
    feed.setConsoleProjects(["alpha", "beta"])
    assert.equal(feed.consoleFeedPending("beta"), true)
    socketFor("/_frizz/alpha/ws")!.open()
    socketFor("/_frizz/alpha/ws")!.message(keyframe("alpha", ["a"], "o/alpha"))
    assert.equal(store.board, null, "beta has not answered, so the board waits")
    // Each project's references link to ITS repo, read off its own keyframe; the merged board has none.
    assert.equal(githubRepoFor("alpha"), "o/alpha")
    assert.equal(githubRepoFor("beta"), null, "a project whose keyframe names no github.com repo links nothing")
    // A cold link to one of beta's threads is not MISSING while beta is still on its way: it stays parked,
    // where before it was sent off the Console to a full page.
    store.board = { projectDir: "", projectName: "Console", threads: [], errors: [], warnings: [] } as unknown as BoardSnapshot
    store.routeThreadSlug = "beta~b"
    resolveRoutedThread()
    assert.equal(store.routeThreadSlug, "beta~b", "a key whose project is loading stays parked")
    assert.deepEqual(replaced, [], "…and the page is not sent away to look for it")
    store.routeThreadSlug = null
    store.board = null
    socketFor("/_frizz/beta/ws")!.open()
    socketFor("/_frizz/beta/ws")!.message(keyframe("beta", ["b"]))
    assert.deepEqual(ids(), ["alpha~a", "beta~b"])
    assert.equal(feed.consoleFeedPending(), false)
    // The control: a key whose project is NOT on its way is missing, and goes to its full page as before.
    store.routeThreadSlug = "gamma~c"
    resolveRoutedThread()
    assert.equal(store.routeThreadSlug, null)
    assert.equal(replaced.length, 1, "a key no project is bringing is handed to the full page")
    replaced.length = 0

    // 2. A RESTART OF FEEDS THAT ALREADY ANSWERED waits for fresh keyframes. The route re-binds whenever
    //    the feed stops reporting itself as the Console's; the feeds it found had answered a board that
    //    the re-bind threw away, and publishing on their word showed an EMPTY Console that stayed empty
    //    for every project with nothing new to say.
    const alphaBefore = socketFor("/_frizz/alpha/ws")!
    socket.bindConsole()
    feed.setConsoleProjects(["alpha", "beta"])
    assert.equal(store.board, null, "no board until the restarted feeds answer again")
    assert.notEqual(socketFor("/_frizz/alpha/ws"), alphaBefore, "a fresh connection, so a fresh keyframe")
    socketFor("/_frizz/alpha/ws")!.open()
    socketFor("/_frizz/alpha/ws")!.message(keyframe("alpha", ["a"]))
    socketFor("/_frizz/beta/ws")!.open()
    socketFor("/_frizz/beta/ws")!.message(keyframe("beta", ["b"]))
    assert.deepEqual(ids(), ["alpha~a", "beta~b"])

    // 3. THE GRID TAKES THE FEED BACK. The Console's connections serve nothing there; left open, each one
    //    dropped its frames and was reopened by the watchdog, forever.
    const consoleSockets = [socketFor("/_frizz/alpha/ws")!, socketFor("/_frizz/beta/ws")!]
    here.pathname = "/"
    socket.leaveConsole()
    assert.ok(consoleSockets.every((s) => s.readyState === FakeWebSocket.CLOSED), "the Console's connections close")
    assert.equal(githubRepoFor("alpha"), null, "…and take their projects' repos with them")
    assert.equal(socket.feedIsConsole(), false)
    const launcher = socketFor("/_frizz/ws")!
    assert.equal(launcher.readyState, FakeWebSocket.CONNECTING, "the grid holds what a cold load of it would")
    // …and a wake on the grid is the ordinary launching-project reconnect, nothing of the Console's.
    fire("focus")
    assert.equal(FakeWebSocket.instances.filter((s) => s.url.includes("/alpha/") && s.readyState !== FakeWebSocket.CLOSED).length, 0)

    // 4. BACK TO THE CONSOLE from the grid: fresh connections, and no board until they answer.
    here.pathname = "/console"
    store.board = null
    socket.bindConsole()
    feed.setConsoleProjects(["alpha", "beta"])
    assert.equal(store.board, null)
    socketFor("/_frizz/alpha/ws")!.open()
    socketFor("/_frizz/alpha/ws")!.message(keyframe("alpha", ["a"]))
    socketFor("/_frizz/beta/ws")!.open()
    socketFor("/_frizz/beta/ws")!.message(keyframe("beta", ["b"]))
    assert.deepEqual(ids(), ["alpha~a", "beta~b"])
    // A wake while the Console holds the feed never reopens the launching project's connection.
    const before = FakeWebSocket.instances.length
    fire("focus")
    assert.equal(FakeWebSocket.instances.slice(before).filter((s) => new URL(s.url).pathname === "/_frizz/ws").length, 0)

    // 5. A BOARD TOO BIG FOR ITS SOCKET still leaves that socket carrying transcripts. Before, nothing
    //    marked it ready, so a subscription was never sent and the project's transcripts never pushed.
    const alpha = socketFor("/_frizz/alpha/ws")!
    socket.leaveConsole()
    here.pathname = "/console"
    socket.bindConsole()
    feed.setConsoleProjects(["alpha"])
    const big = socketFor("/_frizz/alpha/ws")!
    assert.notEqual(big, alpha)
    big.open()
    feed.consoleSubscribeTranscript("alpha~a")
    assert.deepEqual(big.sent, [], "nothing is sent before the connection is ready")
    big.message({ t: "payload-too-large", channel: "board", actualBytes: 5_000_000, maxBytes: 4_194_304 } as SocketServerMsg)
    assert.deepEqual(big.sent, [{ t: "sub", topic: "transcript", slug: "a" }], "the transcript subscription goes out under the real slug")
  } finally {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test("a session on the SSE fallback hands its stream over to the Console, and gets it back for a project", async () => {
  const globals = new Map<PropertyKey, PropertyDescriptor | undefined>()
  const install = (key: PropertyKey, value: unknown) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const here = { origin: "http://127.0.0.1:54917", pathname: "/", reload: () => {}, replace: () => {}, assign: () => {} }
  const listeners = new Map<string, Listener[]>()
  const on = (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn])
  install("WebSocket", FakeWebSocket)
  install("EventSource", FakeEventSource)
  install("location", here)
  install("window", { addEventListener: on, removeEventListener: () => {}, focus: () => {} })
  install("document", { readyState: "complete", hidden: false, addEventListener: on, removeEventListener: () => {} })
  install("setTimeout", (() => 0) as unknown as typeof setTimeout)
  install("clearTimeout", (() => {}) as unknown as typeof clearTimeout)
  install("setInterval", (() => 0) as unknown as typeof setInterval)
  install("clearInterval", (() => {}) as unknown as typeof clearInterval)
  install("fetch", (() => new Promise(() => {})) as unknown as typeof fetch)

  try {
    FakeWebSocket.instances = []
    FakeEventSource.instances = []
    const socket = await import(`./socket.ts?sse-${Date.now()}`)
    here.pathname = "/"
    socket.connectSync({ setQueryData: () => {}, invalidateQueries: async () => {} } as never)
    FakeWebSocket.instances[0]!.serverClose() // never opened → the server has no /ws → commit to SSE
    const unprefixed = FakeEventSource.instances[0]!
    assert.equal(unprefixed.url, "/_frizz/events")

    here.pathname = "/console"
    socket.bindConsole()
    assert.equal(unprefixed.closed, true, "the launching project's stream closes when the Console takes the feed")
    // Its error handler and the wake signals would reopen it unprefixed — the launching project, whose
    // notifications then doubled the Console's own. They must not.
    unprefixed.onerror?.({})
    for (const fn of listeners.get("focus") ?? []) fn({})
    assert.equal(FakeEventSource.instances.length, 1, "nothing reopens it while the Console holds the feed")

    here.pathname = "/project/alpha"
    socket.rebindProject()
    assert.equal(FakeEventSource.instances.at(-1)?.url, "/_frizz/alpha/events", "a project page gets its own stream back")
  } finally {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
