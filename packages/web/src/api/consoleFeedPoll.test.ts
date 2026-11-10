import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"

// THE CONSOLE'S FALLBACK WHEN /ws NEVER OPENS (consoleFeed.ts, the header). A project page in that spot
// falls back to SSE; the Console cannot hold an EventSource per project, so each feed whose socket closed
// without opening POLLS its project for the deltas after the board it holds. These pin that it does, that
// what it gets goes through the same door a socket's deltas do, and that a `resync` reads the board again.
// Until 2026-10-15 the Console's boards loaded and then never moved (driven through a proxy that refuses
// WebSocket upgrades: a dispatch and a rename never appeared).

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
  readonly sent: unknown[] = []
  // What a proxy that refuses the upgrade looks like from the page: an error, then a close, never an open.
  refuse(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onerror?.({})
    this.onclose?.({})
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }
}

const thread = (id: string, title = id): ThreadView => ({ id, title, dependsOn: [], needsYou: true }) as unknown as ThreadView
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}
const ok = (result: unknown) => Promise.resolve(new Response(JSON.stringify({ result }), { status: 200 }))

test("a Console feed whose /ws never opens polls its project's deltas, applies them, reads the board again on a resync, and tries /ws again until one opens", async () => {
  const globals = new Map<PropertyKey, PropertyDescriptor | undefined>()
  const install = (key: PropertyKey, value: unknown) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  // Timers run when the test says, so "one poll" is one call of runTimers(): every timer due within a
  // poll's wait. A feed's next try at /ws waits longer, and runs only when the test asks (runProbes).
  let timers: { fn: () => void; delay: number }[] = []
  const runWithin = async (min: number, max: number) => {
    const due = timers.filter((t) => t.delay >= min && t.delay <= max)
    timers = timers.filter((t) => !due.includes(t))
    for (const t of due) t.fn()
    await settle()
  }
  const runTimers = () => runWithin(0, 1_500)
  const runProbes = () => runWithin(5_000, 60_000)
  const probeWaits = () => timers.filter((t) => t.delay >= 5_000).map((t) => t.delay)
  // The server: each project's board and its deltas, answered by procedure.
  const boards = new Map<string, { threads: ThreadView[]; seq: number }>([["alpha", { threads: [thread("a")], seq: 4 }], ["beta", { threads: [thread("b")], seq: 9 }]])
  const asked: { project: string; proc: string; input?: { bootId: string; seq: number } }[] = []
  let deltaAnswer: (project: string, input: { bootId: string; seq: number }) => unknown = (_p, input) => ({ bootId: "boot-test", deltas: [] as unknown[], at: input.seq })
  const fetchStub = (url: string) => {
    const u = new URL(url, "http://127.0.0.1:54917")
    const [, , project, , proc] = u.pathname.split("/")
    const raw = u.searchParams.get("input")
    const input = raw ? JSON.parse(raw) : undefined
    asked.push({ project: project!, proc: proc!, input })
    if (proc === "boardState") {
      const b = boards.get(project!)!
      const board = { projectDir: `/fixture/${project}`, projectName: project, projectSlug: project, threads: b.threads, errors: [], warnings: [] } as unknown as BoardSnapshot
      return ok({ board, seq: b.seq, bootId: "boot-test" })
    }
    if (proc === "boardDeltas") return ok(deltaAnswer(project!, input))
    return new Promise(() => {})
  }
  const here = { origin: "http://127.0.0.1:54917", pathname: "/console", reload: () => {}, replace: () => {}, assign: () => {} }
  install("WebSocket", FakeWebSocket)
  install("location", here)
  install("window", { addEventListener: () => {}, removeEventListener: () => {}, focus: () => {} })
  install("document", { readyState: "complete", hidden: false, addEventListener: () => {}, removeEventListener: () => {} })
  install("setTimeout", ((fn: () => void, delay = 0) => (timers.push({ fn, delay }), timers.length)) as unknown as typeof setTimeout)
  install("clearTimeout", (() => {}) as unknown as typeof clearTimeout)
  install("setInterval", (() => 0) as unknown as typeof setInterval)
  install("clearInterval", (() => {}) as unknown as typeof clearInterval)
  install("fetch", fetchStub as unknown as typeof fetch)

  try {
    const { store } = await import("../store.ts")
    const feed = await import("./consoleFeed.ts")
    const titles = () => store.board?.threads.map((t) => `${t.id}:${t.title}`).sort() ?? null
    feed.initConsoleFeed({ setQueryData: () => {}, invalidateQueries: async () => {} } as never)
    feed.startConsoleFeed()
    feed.setConsoleProjects(["alpha", "beta"])
    await settle()
    assert.deepEqual(titles(), ["alpha~a:a", "beta~b:b"], "both boards load over HTTP, socket or none")

    // Both sockets are refused. Nothing is applied yet, and nothing reconnects them within a poll's wait.
    for (const ws of FakeWebSocket.instances) ws.refuse()
    const sockets = FakeWebSocket.instances.length
    await runTimers()
    assert.equal(FakeWebSocket.instances.length, sockets, "a feed that fell back does not knock on /ws again at the poll's pace")
    assert.deepEqual(probeWaits(), [5_000, 5_000], "each tries /ws again once, after a wait")
    const polls = asked.filter((a) => a.proc === "boardDeltas")
    assert.deepEqual(polls.map((p) => [p.project, p.input]).sort(), [["alpha", { bootId: "boot-test", seq: 4 }], ["beta", { bootId: "boot-test", seq: 9 }]], "each project is asked for the deltas after the board it holds")
    assert.equal(store.connection, "open", "a polled board is a live one")

    // A delta for alpha: a rename and a dispatch, applied under alpha's keys and nowhere else.
    deltaAnswer = (project, input) =>
      project === "alpha" && input.seq === 4
        ? { bootId: "boot-test", deltas: [{ type: "board-delta", seq: 5, bootId: "boot-test", upserts: [thread("a", "renamed"), thread("new")], removed: [] }] }
        : { bootId: "boot-test", deltas: [] }
    await runTimers()
    assert.deepEqual(titles(), ["alpha~a:renamed", "alpha~new:new", "beta~b:b"])
    await runTimers()
    assert.deepEqual(asked.filter((a) => a.proc === "boardDeltas" && a.project === "alpha").at(-1)?.input, { bootId: "boot-test", seq: 5 }, "the next poll carries on from the delta applied")

    // The ring cannot answer (the poll fell too far behind): the project's board is read again, and only its.
    boards.set("beta", { threads: [thread("b", "read again"), thread("c")], seq: 900 })
    deltaAnswer = (project) => (project === "beta" ? { bootId: "boot-test", resync: "expired" } : { bootId: "boot-test", deltas: [] })
    const reads = asked.filter((a) => a.proc === "boardState").length
    await runTimers()
    assert.equal(asked.filter((a) => a.proc === "boardState").length, reads + 1)
    assert.deepEqual(titles(), ["alpha~a:renamed", "alpha~new:new", "beta~b:read again", "beta~c:c"])
    deltaAnswer = () => ({ bootId: "boot-test", deltas: [] })
    await runTimers()
    assert.deepEqual(asked.filter((a) => a.proc === "boardDeltas" && a.project === "beta").at(-1)?.input, { bootId: "boot-test", seq: 900 })

    // THE FALLBACK IS NOT FOR GOOD. A socket closed before it opened is also a server still starting, and
    // the page is never reloaded across a restart: each feed tries /ws again, alpha's path still refuses
    // and waits twice as long for its next try, and beta's opens and takes over from the poll.
    const beforeProbes = FakeWebSocket.instances.length
    await runProbes()
    const probes = FakeWebSocket.instances.slice(beforeProbes)
    assert.deepEqual(probes.map((ws) => new URL(ws.url).pathname.split("/")[2]).sort(), ["alpha", "beta"], "each fallen-back feed tried its own /ws")
    const [alphaProbe, betaProbe] = ["alpha", "beta"].map((p) => probes.find((ws) => ws.url.includes(`/${p}/`))!)
    alphaProbe!.refuse()
    assert.deepEqual(probeWaits(), [10_000], "a refused try waits twice as long for the next")
    betaProbe!.open()
    betaProbe!.receive({ t: "hello", bootId: "boot-test", seq: 900 })
    assert.deepEqual(betaProbe!.sent.find((m) => (m as { t: string }).t === "board"), { t: "board", bootId: "boot-test", seq: 900 }, "the socket resumes from the board the poll kept")
    const polled = (project: string) => asked.filter((a) => a.proc === "boardDeltas" && a.project === project).length
    const [alphaPolls, betaPolls] = [polled("alpha"), polled("beta")]
    await runTimers()
    await runTimers()
    assert.equal(polled("beta"), betaPolls, "beta's poll stopped once its socket opened")
    assert.equal(polled("alpha"), alphaPolls + 2, "alpha, still refused, polls on")
    betaProbe!.receive({ t: "event", event: { type: "board-delta", seq: 901, bootId: "boot-test", upserts: [thread("b", "over the socket")], removed: [] } })
    assert.ok(titles()!.includes("beta~b:over the socket"), "and beta's deltas now come down the socket")

    // Leaving the Console stops every poll.
    feed.stopConsoleFeed()
    const before = asked.length
    await runTimers()
    await runTimers()
    assert.equal(asked.length, before, "a closed feed asks nothing")
  } finally {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
