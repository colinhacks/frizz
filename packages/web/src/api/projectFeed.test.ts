import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot, SocketServerMsg } from "@frizz/shared"

// THE LIVE FEED AND THE PROJECT IT IS FOR — the seam that produced a real, shipped bug (2026-08-11:
// every board on the machine rendered the launching project's threads under another project's URL,
// fixed in `0fb8574`) and that was still broken in a second place when this was written.
//
// Everything here is about ONE question asked three ways: when the page moves to another project, does
// anything from the project we left still reach the UI?

type Listener = (event: unknown) => void

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
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

  send(): void {}
  close(): void { this.readyState = FakeWebSocket.CLOSED }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onerror: Listener | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  addEventListener(): void {}
  close(): void {}
}

function board(projectSlug: string | undefined): BoardSnapshot {
  return {
    projectDir: `/fixture/${projectSlug ?? "launcher"}`,
    projectName: projectSlug ?? "launcher",
    projectLabel: `fixture/${projectSlug ?? "launcher"}`,
    threads: [],
    errors: [],
    warnings: [],
    ...(projectSlug === undefined ? {} : { projectSlug }),
  }
}

const frame = (projectSlug: string | undefined): SocketServerMsg => ({
  t: "event",
  event: { type: "board", board: board(projectSlug), seq: 1, bootId: "boot-test" },
})

test("nothing from the project the page has left reaches the UI", async () => {
  const globals = new Map<PropertyKey, PropertyDescriptor | undefined>()
  const install = (key: PropertyKey, value: unknown) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const here = { origin: "http://127.0.0.1:54917", pathname: "/project/alpha", reload: () => {} }
  install("WebSocket", FakeWebSocket)
  install("EventSource", FakeEventSource)
  // The feed reads the board over HTTP the moment it binds to a project. Nothing here is about that
  // read, so it stays in flight for the whole test. Left as the real `fetch`, it went to the port in
  // `here.origin`: refused, retried on the feed's own backoff, and still at it after the test had put
  // the real timers back, which is how this file passed and then failed with six errors raised after
  // its one test had ended (hidden while the suite ran under --test-force-exit).
  install("fetch", () => new Promise<never>(() => {}))
  install("location", here)
  install("window", { addEventListener: () => {}, removeEventListener: () => {}, focus: () => {} })
  install("document", { readyState: "complete", hidden: false, addEventListener: () => {}, removeEventListener: () => {} })
  install("setTimeout", (() => 0) as unknown as typeof setTimeout)
  install("clearTimeout", (() => {}) as unknown as typeof clearTimeout)
  install("setInterval", (() => 0) as unknown as typeof setInterval)
  install("clearInterval", (() => {}) as unknown as typeof clearInterval)

  const writes: unknown[][] = []
  const queryClient = {
    setQueryData: (key: readonly unknown[]) => { writes.push([...key]) },
    invalidateQueries: async () => {},
  }
  const fresh = async (tag: string) => {
    FakeWebSocket.instances = []
    FakeEventSource.instances = []
    return await import(`./socket.ts?${tag}-${Date.now()}-${Math.random()}`)
  }

  try {
    const { store, setBoard } = await import("../store.ts")

    // 1. THE FEED ANSWERS FOR ITSELF. The router asks "are you already on this project?" and the answer
    //    comes from the module holding the connection — not from a note some component kept, which is
    //    what a remount reset to a lie. Moving the address bar does NOT move the feed, and the feed says so.
    here.pathname = "/project/alpha"
    const feed = await fresh("bound")
    feed.connectSync(queryClient as never)
    assert.equal(FakeWebSocket.instances[0]?.url, "ws://127.0.0.1:54917/_frizz/alpha/ws?patch=1")
    assert.equal(feed.feedIsBoundTo("alpha"), true)
    here.pathname = "/project/beta"
    assert.equal(feed.feedIsBoundTo("beta"), false, "the page moved; the socket did not")
    feed.rebindProject()
    assert.equal(FakeWebSocket.instances[1]?.url, "ws://127.0.0.1:54917/_frizz/beta/ws?patch=1")
    assert.equal(feed.feedIsBoundTo("beta"), true)

    // 2. A FRAME FROM THE PROJECT WE LEFT IS DROPPED — and the TRANSCRIPT frame is the one that proves
    //    the connection's own stamp is doing it. The socket for alpha stays alive for as long as its
    //    close takes, so frames already on the wire arrive after the switch. A board would be caught
    //    downstream by the store's ownership door (assertion 3), but a transcript names only a thread
    //    slug, and slugs are unique WITHIN a project — nothing downstream can tell alpha's `fix-auth`
    //    from beta's. Only the socket knows, because it knows what it was opened for.
    here.pathname = "/project/alpha"
    const late = await fresh("late")
    late.connectSync(queryClient as never)
    const alphaSocket = FakeWebSocket.instances[0]!
    alphaSocket.open()
    store.board = null
    writes.length = 0
    here.pathname = "/project/beta"
    alphaSocket.message({ t: "transcript", slug: "fix-auth", messages: [] })
    assert.deepEqual(writes, [], "alpha's transcript must not be written into beta's cache")
    alphaSocket.message(frame("alpha"))
    assert.equal(store.board, null, "alpha's keyframe must not land on beta's page")

    // 3. …AND THE SAME PAYLOAD IS REFUSED AT THE STORE ITSELF, on its own evidence rather than on the
    //    transport's bookkeeping. This is the backstop for every path not yet imagined: a board read
    //    in flight across the switch lands into the just-emptied store.
    setBoard(board("alpha"))
    assert.equal(store.board, null, "setBoard must refuse a board stamped with another project")
    setBoard(board("beta"))
    assert.equal((store.board as BoardSnapshot | null)?.projectName, "beta", "…and must accept this project's own board")
    store.board = null

    // 4. A SESSION THAT FELL BACK TO SSE SWITCHES PROJECTS TOO. `rebindSSEProject` existed, was
    //    exported, and had NO caller anywhere in the repo — so on a server with no `/ws` route the board
    //    stayed fed by the project you left, with nothing to recover it but a document load. Same defect
    //    as the one that shipped, in the transport nobody was looking at.
    here.pathname = "/project/alpha"
    const fallback = await fresh("fallback")
    fallback.connectSync(queryClient as never)
    FakeWebSocket.instances[0]!.serverClose() // never opened → the server has no /ws → commit to SSE
    assert.equal(FakeEventSource.instances[0]?.url, "/_frizz/alpha/events")
    here.pathname = "/project/beta"
    fallback.rebindProject()
    assert.equal(FakeEventSource.instances[1]?.url, "/_frizz/beta/events", "the fallback must follow the switch")
  } finally {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
