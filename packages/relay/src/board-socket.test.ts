import assert from "node:assert/strict"
import test from "node:test"
import { encodeBody, parseFrame, serializeFrame } from "@frizz/shared"
import { BoardSocket, type SocketLike } from "./board-socket.ts"

/** A socket that records what the relay sent, so a fake board can answer it. */
function fakeSocket() {
  const sent: string[] = []
  let closed: number | undefined
  const socket: SocketLike = {
    send: (d) => void sent.push(d),
    close: (code) => { closed = code },
  }
  return {
    socket,
    sent,
    get closed() { return closed },
    lastId() {
      const frame = parseFrame(sent[sent.length - 1]!)
      return frame?.id ?? ""
    },
  }
}

const text = (s: string) => new TextEncoder().encode(s)

test("a request reaches the board and its answer comes back", async () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)

  const pending = relay.request({ method: "GET", url: "https://ada.frizz.sh/x", headers: [["accept", "*/*"]] })
  const sent = parseFrame(board.sent[0]!)
  assert.equal(sent?.t, "req")

  relay.handleFrame(serializeFrame({
    t: "res", id: board.lastId(), status: 200,
    headers: [["content-type", "text/plain"]], body: encodeBody(text("hi")), end: true,
  }))
  const response = await pending
  assert.equal(response.status, 200)
  assert.equal(new TextDecoder().decode(response.body!), "hi")
  assert.equal(response.end, true)
})

test("a whole answer with no body is marked ended, so the visitor's stream can close", async () => {
  // A body-less whole answer and the head of a stream both carry a null body. Only `end` tells them
  // apart, and without it the relay left an empty 200, a HEAD or a redirect loading forever.
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)

  const whole = relay.request({ method: "HEAD", url: "https://ada.frizz.sh/", headers: [] })
  relay.handleFrame(serializeFrame({ t: "res", id: board.lastId(), status: 200, headers: [], end: true }))
  assert.deepEqual(await whole, { status: 200, headers: [], body: null, end: true })

  const streamed = relay.request({ method: "GET", url: "https://ada.frizz.sh/events", headers: [] }, { push: () => {}, end: () => {} })
  relay.handleFrame(serializeFrame({ t: "res", id: board.lastId(), status: 200, headers: [], end: false }))
  assert.equal((await streamed).end, false)
})

test("a STREAMED body reaches the visitor while it is still being produced", async () => {
  // This is the whole reason the head and the body are separate frames. Frizz's event feed is SSE: the
  // response never ends, so buffering until it does would mean the board never appears to load at all.
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)

  const chunks: string[] = []
  let ended = false
  const pending = relay.request(
    { method: "GET", url: "https://ada.frizz.sh/events", headers: [] },
    { push: (c) => chunks.push(new TextDecoder().decode(c)), end: () => { ended = true } }
  )
  const id = board.lastId()

  relay.handleFrame(serializeFrame({
    t: "res", id, status: 200, headers: [["content-type", "text/event-stream"]], end: false,
  }))
  const head = await pending
  assert.equal(head.status, 200, "the head resolves before the body is finished")
  assert.equal(ended, false)

  relay.handleFrame(serializeFrame({ t: "res-chunk", id, data: encodeBody(text("data: one\n")) }))
  relay.handleFrame(serializeFrame({ t: "res-chunk", id, data: encodeBody(text("data: two\n")) }))
  assert.deepEqual(chunks, ["data: one\n", "data: two\n"])
  assert.equal(ended, false, "an open stream must not be closed early")

  relay.handleFrame(serializeFrame({ t: "res-end", id }))
  assert.equal(ended, true)
})

test("a stream from before a reset cannot land in a stranger's request", async () => {
  // A Durable Object can lose its memory while the board's socket survives, and the board then keeps
  // streaming under the old id. A fresh instance must never hand that id to a new request.
  const board = fakeSocket()
  const before = new BoardSocket()
  before.attach(board.socket)
  void before.request({ method: "GET", url: "https://ada.frizz.sh/events", headers: [] }, { push: () => {}, end: () => {} })
  const oldId = board.lastId()

  const after = new BoardSocket()
  after.attach(board.socket)
  const chunks: string[] = []
  const pending = after.request(
    { method: "GET", url: "https://ada.frizz.sh/", headers: [] },
    { push: (c) => chunks.push(new TextDecoder().decode(c)), end: () => {} }
  )
  const newId = board.lastId()
  assert.notEqual(newId, oldId)

  after.handleFrame(serializeFrame({ t: "res-chunk", id: oldId, data: encodeBody(text("data: the owner's board event\n")) }))
  assert.deepEqual(chunks, [])

  after.handleFrame(serializeFrame({ t: "res", id: newId, status: 401, headers: [], end: true }))
  assert.equal((await pending).status, 401)
})

test("a request with no board connected fails immediately rather than hanging", async () => {
  const relay = new BoardSocket()
  await assert.rejects(
    relay.request({ method: "GET", url: "https://ada.frizz.sh/", headers: [] }),
    /not connected/
  )
})

test("a board that disconnects fails everything in flight", async () => {
  // Otherwise every visitor waits out the full timeout for an answer that can never arrive.
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  const pending = relay.request({ method: "GET", url: "https://ada.frizz.sh/", headers: [] })
  relay.detach(board.socket)
  await assert.rejects(pending, /disconnected/)
  assert.equal(relay.connected, false)
})

test("a reconnect replaces the old socket and fails what was riding on it", async () => {
  const first = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(first.socket)
  const pending = relay.request({ method: "GET", url: "https://ada.frizz.sh/", headers: [] })

  const second = fakeSocket()
  relay.attach(second.socket)
  await assert.rejects(pending, /reconnected/)
  assert.equal(first.closed, 1000, "the stale socket is closed, not left open")
  assert.equal(relay.connected, true)
})

test("a stale socket closing later does not detach the live one", async () => {
  // The old socket's close event arrives AFTER the replacement is in place. Treating it as a detach
  // would tear down a board that had just successfully reconnected.
  const first = fakeSocket()
  const second = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(first.socket)
  relay.attach(second.socket)
  relay.detach(first.socket)
  assert.equal(relay.connected, true)
})

test("a request the board never answers times out", async () => {
  const board = fakeSocket()
  const fire: Array<() => void> = []
  const relay = new BoardSocket({
    requestTimeoutMs: 1,
    setTimer: (fn) => { fire.push(fn); return fire.length },
    clearTimer: () => {},
  })
  relay.attach(board.socket)
  const pending = relay.request({ method: "GET", url: "https://ada.frizz.sh/", headers: [] })
  fire[0]!()
  await assert.rejects(pending, /did not answer in time/)
})

test("hop-by-hop headers never reach the board", () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  void relay.request({
    method: "GET", url: "https://ada.frizz.sh/", headers: [["Connection", "keep-alive"], ["X-Keep", "1"]],
  })
  const frame = parseFrame(board.sent[0]!) as { headers: Array<[string, string]> }
  assert.deepEqual(frame.headers, [["X-Keep", "1"]])
})

test("a late or unknown frame is ignored rather than throwing", () => {
  const relay = new BoardSocket()
  relay.attach(fakeSocket().socket)
  for (const raw of ['{"t":"res","id":"nope","status":200,"headers":[],"end":true}', "garbage", '{"t":"pong","id":"x"}']) {
    assert.doesNotThrow(() => relay.handleFrame(raw))
  }
})

/** A visitor's end of a terminal, recording what the relay pushed at it. */
function fakeVisitor() {
  const received: string[] = []
  let closed: number | undefined
  return {
    received,
    get closed() { return closed },
    socket: { send: (d: string) => void received.push(d), close: (code?: number) => { closed = code } } as SocketLike,
  }
}

test("a terminal is opened on the board and acknowledged before the visitor is upgraded", async () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  const visitor = fakeVisitor()

  const opening = relay.openWebSocket({ url: "https://ada.frizz.sh/terminal", headers: [["x-keep", "1"]] }, visitor.socket)
  const sent = parseFrame(board.sent[0]!) as { t: string; url: string }
  assert.equal(sent.t, "ws-open")
  assert.equal(sent.url, "https://ada.frizz.sh/terminal")

  relay.handleFrame(serializeFrame({ t: "ws-ack", id: board.lastId(), ok: true }))
  assert.equal(await opening, board.lastId())
})

test("a terminal the board refuses resolves to null, so the upgrade can fail honestly", async () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  const visitor = fakeVisitor()

  const opening = relay.openWebSocket({ url: "https://ada.frizz.sh/terminal", headers: [] }, visitor.socket)
  relay.handleFrame(serializeFrame({ t: "ws-ack", id: board.lastId(), ok: false }))
  assert.equal(await opening, null)
})

test("a terminal on a board that is not connected is refused rather than left hanging", async () => {
  const relay = new BoardSocket()
  const visitor = fakeVisitor()
  assert.equal(await relay.openWebSocket({ url: "https://ada.frizz.sh/terminal", headers: [] }, visitor.socket), null)
})

test("the board's output reaches the visitor, and the visitor's input reaches the board", async () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  const visitor = fakeVisitor()

  const opening = relay.openWebSocket({ url: "https://ada.frizz.sh/terminal", headers: [] }, visitor.socket)
  const id = board.lastId()
  relay.handleFrame(serializeFrame({ t: "ws-ack", id, ok: true }))
  await opening

  relay.handleFrame(serializeFrame({ t: "ws-msg", id, data: "hello from the pty" }))
  assert.deepEqual(visitor.received, ["hello from the pty"])

  relay.sendWebSocketMessage(id, "ls -la")
  const up = parseFrame(board.sent[board.sent.length - 1]!) as { t: string; data: string }
  assert.equal(up.t, "ws-msg")
  assert.equal(up.data, "ls -la")
})

test("a terminal that ends on the board closes the visitor's pane", async () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  const visitor = fakeVisitor()

  const opening = relay.openWebSocket({ url: "https://ada.frizz.sh/terminal", headers: [] }, visitor.socket)
  const id = board.lastId()
  relay.handleFrame(serializeFrame({ t: "ws-ack", id, ok: true }))
  await opening

  relay.handleFrame(serializeFrame({ t: "ws-close", id, code: 1000 }))
  assert.equal(visitor.closed, 1000)
  // And a later message for a closed session is ignored rather than throwing.
  relay.handleFrame(serializeFrame({ t: "ws-msg", id, data: "late" }))
  assert.deepEqual(visitor.received, [])
})

test("a board that disconnects closes every terminal riding on it", async () => {
  // A pane that looks live but types into nothing is the worst outcome here: the visitor cannot tell
  // the board went away, and the relay has no way to answer them later.
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  const visitor = fakeVisitor()

  const opening = relay.openWebSocket({ url: "https://ada.frizz.sh/terminal", headers: [] }, visitor.socket)
  relay.handleFrame(serializeFrame({ t: "ws-ack", id: board.lastId(), ok: true }))
  await opening

  relay.detach(board.socket)
  assert.equal(visitor.closed, 1001)
})

test("a terminal opened while the board is going away resolves rather than hanging forever", async () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  const visitor = fakeVisitor()

  const opening = relay.openWebSocket({ url: "https://ada.frizz.sh/terminal", headers: [] }, visitor.socket)
  relay.detach(board.socket)
  assert.equal(await opening, null)
})

test("the visitor closing tells the board, so a terminal is not left running for nobody", () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  const visitor = fakeVisitor()

  void relay.openWebSocket({ url: "https://ada.frizz.sh/terminal", headers: [] }, visitor.socket)
  const id = board.lastId()
  relay.handleFrame(serializeFrame({ t: "ws-ack", id, ok: true }))
  relay.closeWebSocket(id, 1000)
  const frame = parseFrame(board.sent[board.sent.length - 1]!) as { t: string; code: number }
  assert.equal(frame.t, "ws-close")
  assert.equal(frame.code, 1000)
})

test("a terminal the board never answers for is given up on rather than held open", async () => {
  const fire: Array<() => void> = []
  const board = fakeSocket()
  const relay = new BoardSocket({ requestTimeoutMs: 10, setTimer: (fn) => { fire.push(fn); return fire.length }, clearTimer: () => {} })
  relay.attach(board.socket)
  const visitor = fakeVisitor()

  const opening = relay.openWebSocket({ url: "https://ada.frizz.sh/terminal", headers: [] }, visitor.socket)
  for (const fn of fire) fn()
  assert.equal(await opening, null)
})

test("hop-by-hop headers never reach the board on a terminal either", () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  void relay.openWebSocket(
    { url: "https://ada.frizz.sh/terminal", headers: [["connection", "Upgrade"], ["upgrade", "websocket"], ["x-keep", "1"]] },
    fakeVisitor().socket,
  )
  const frame = parseFrame(board.sent[0]!) as { headers: Array<[string, string]> }
  assert.deepEqual(frame.headers, [["x-keep", "1"]])
})

test("a board message that arrives in pieces reaches the visitor as ONE message", async () => {
  // The visitor's browser must never see a board frame in halves: it is JSON, and half of it is not
  // parseable. Reassembly is what makes chunking invisible to both ends.
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  const visitor = fakeVisitor()

  const opening = relay.openWebSocket({ url: "https://ada.frizz.sh/ws", headers: [] }, visitor.socket)
  const id = board.lastId()
  relay.handleFrame(serializeFrame({ t: "ws-ack", id, ok: true }))
  await opening

  relay.handleFrame(serializeFrame({ t: "ws-msg", id, data: '{"a":', more: true }))
  relay.handleFrame(serializeFrame({ t: "ws-msg", id, data: "1}" }))
  assert.deepEqual(visitor.received, ['{"a":1}'])
})

test("a large visitor message is split on its way down to the board", () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  void relay.openWebSocket({ url: "https://ada.frizz.sh/ws", headers: [] }, fakeVisitor().socket)
  const id = board.lastId()
  relay.handleFrame(serializeFrame({ t: "ws-ack", id, ok: true }))

  const big = "V".repeat(200_000)
  board.sent.length = 0
  relay.sendWebSocketMessage(id, big)
  const parts = board.sent.map((raw) => parseFrame(raw) as { t: string; data: string; more?: boolean })
  assert.ok(parts.length > 1, "a 200,000-character message was not split")
  assert.equal(parts[parts.length - 1]!.more, undefined)
  assert.equal(parts.map((p) => p.data).join(""), big)
})

test("a peer that never finishes a message is dropped rather than buffered forever", async () => {
  // Unbounded reassembly is a way to exhaust the Durable Object's memory from outside it. Past the
  // ceiling the partial message goes, and the visitor gets nothing rather than the relay getting large.
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  const visitor = fakeVisitor()

  const opening = relay.openWebSocket({ url: "https://ada.frizz.sh/ws", headers: [] }, visitor.socket)
  const id = board.lastId()
  relay.handleFrame(serializeFrame({ t: "ws-ack", id, ok: true }))
  await opening

  const chunk = "X".repeat(1024 * 1024)
  for (let i = 0; i < 12; i++) relay.handleFrame(serializeFrame({ t: "ws-msg", id, data: chunk, more: true }))
  relay.handleFrame(serializeFrame({ t: "ws-msg", id, data: "end" }))
  assert.deepEqual(visitor.received, [], "an overflowed run was delivered anyway")

  // And the NEXT message is unaffected: poisoning ends with the run, not with the session.
  relay.handleFrame(serializeFrame({ t: "ws-msg", id, data: "after" }))
  assert.deepEqual(visitor.received, ["after"])
})

test("a board that disconnects ENDS every started stream, not just the pending heads", async () => {
  // The head's promise settled long ago, so failAll's reject is a no-op for a streaming response —
  // ending the stream is the ONLY way the visitor's response ever terminates. Before this, a dead
  // board left every relayed SSE response open indefinitely, and those orphans held the Durable
  // Object awake (and billed) for days.
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)

  let ended = false
  const pending = relay.request(
    { method: "GET", url: "https://ada.frizz.sh/events", headers: [] },
    { push: () => {}, end: () => { ended = true } }
  )
  relay.handleFrame(serializeFrame({ t: "res", id: board.lastId(), status: 200, headers: [], end: false }))
  await pending

  relay.detach(board.socket)
  assert.equal(ended, true, "the board disconnected and the stream was left open")
})

test("a stream nobody feeds is ended, and the board is told to stop producing", async () => {
  const fire: Array<() => void> = []
  const board = fakeSocket()
  const relay = new BoardSocket({ setTimer: (fn) => { fire.push(fn); return fire.length }, clearTimer: () => {} })
  relay.attach(board.socket)

  let ended = false
  const pending = relay.request(
    { method: "GET", url: "https://ada.frizz.sh/events", headers: [] },
    { push: () => {}, end: () => { ended = true } }
  )
  const id = board.lastId()
  relay.handleFrame(serializeFrame({ t: "res", id, status: 200, headers: [], end: false }))
  await pending

  // The idle timer is the LAST one armed: the head's own timeout precedes it.
  fire[fire.length - 1]!()
  assert.equal(ended, true, "an idle stream was not ended")
  const cancel = parseFrame(board.sent[board.sent.length - 1]!)
  assert.deepEqual(cancel, { t: "req-cancel", id }, "the board was left producing for nobody")

  // And a late chunk for the abandoned id is ignored, not delivered to a closed stream.
  relay.handleFrame(serializeFrame({ t: "res-chunk", id, data: encodeBody(text("late")) }))
})

test("a chunk re-arms the idle bound, so a LIVE stream is never cut", async () => {
  // A cancelling fake, because the code counts on clearTimer the way the real runtime honors it: the
  // superseded timer must never fire at all.
  const armed = new Map<number, () => void>()
  let handles = 0
  const board = fakeSocket()
  const relay = new BoardSocket({
    setTimer: (fn) => { armed.set(++handles, fn); return handles },
    clearTimer: (handle) => void armed.delete(handle as number),
  })
  relay.attach(board.socket)

  let ended = false
  const chunks: string[] = []
  const pending = relay.request(
    { method: "GET", url: "https://ada.frizz.sh/events", headers: [] },
    { push: (c) => chunks.push(new TextDecoder().decode(c)), end: () => { ended = true } }
  )
  const id = board.lastId()
  relay.handleFrame(serializeFrame({ t: "res", id, status: 200, headers: [], end: false }))
  await pending

  const before = handles
  relay.handleFrame(serializeFrame({ t: "res-chunk", id, data: encodeBody(text("beat")) }))
  assert.ok(handles > before, "a chunk did not re-arm the idle bound")
  assert.equal(armed.has(before), false, "the superseded idle timer was left armed")

  // Only the LIVE timer exists; firing everything still armed must not touch the live stream until
  // the stream actually idles out.
  assert.equal(ended, false)
  assert.deepEqual(chunks, ["beat"])

  // And when it does idle out, the live timer ends it.
  for (const fn of [...armed.values()]) fn()
  assert.equal(ended, true, "the idle bound never fired")
})

test("a visitor who hung up stops the board's request instead of being streamed to forever", async () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)

  let pushes = 0
  let ended = false
  const pending = relay.request(
    { method: "GET", url: "https://ada.frizz.sh/events", headers: [] },
    {
      push: () => {
        pushes++
        throw new Error("the visitor hung up")
      },
      end: () => { ended = true },
    }
  )
  const id = board.lastId()
  relay.handleFrame(serializeFrame({ t: "res", id, status: 200, headers: [], end: false }))
  await pending

  relay.handleFrame(serializeFrame({ t: "res-chunk", id, data: encodeBody(text("one")) }))
  assert.equal(ended, true, "a dead visitor's stream was not ended")
  const cancel = parseFrame(board.sent[board.sent.length - 1]!)
  assert.deepEqual(cancel, { t: "req-cancel", id }, "the board was not told to abort")

  // The entry is gone: later chunks are ignored rather than pushed to a visitor who is not there.
  relay.handleFrame(serializeFrame({ t: "res-chunk", id, data: encodeBody(text("two")) }))
  assert.equal(pushes, 1)
})
