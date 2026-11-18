import assert from "node:assert/strict"
import { test } from "node:test"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { store } from "../store.ts"
import { isConsolePinned, isPinned } from "../groups.ts"
import { heldPin, optimisticallyPinned, setPinned } from "./optimisticPin.ts"

const row = (id: string, pins: Partial<Pick<ThreadView, "pinnedAt" | "consolePinnedAt">> = {}): ThreadView =>
  ({ id, sessionId: `sid-${id}`, kind: "session", title: id, runtime: "idle", state: "active", ...pins }) as unknown as ThreadView
const boardOf = (...threads: ThreadView[]): BoardSnapshot => ({ threads, errors: [] }) as unknown as BoardSnapshot
const tick = () => new Promise((r) => setTimeout(r, 0))

/** Answers each pin call in turn when `answer()` is called, refusing it when given a message. */
function stubPins(): { answer: (refusal?: string) => void; calls: { name: string; body: unknown }[]; previous: typeof fetch } {
  const previous = globalThis.fetch
  const calls: { name: string; body: unknown }[] = []
  const waiting: ((refusal?: string) => void)[] = []
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ name: String(url).split("/rpc/")[1] ?? String(url), body: JSON.parse(String(init?.body ?? "null")) })
    return new Promise<Response>((resolve) => {
      waiting.push((refusal) =>
        resolve(
          refusal
            ? new Response(JSON.stringify({ error: refusal }), { status: 400, headers: { "content-type": "application/json" } })
            : new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } }),
        ),
      )
    })
  }) as typeof fetch
  return { answer: (refusal) => waiting.shift()?.(refusal), calls, previous }
}

test("the overlay writes the pin's own field, and a thread that already agrees comes back by identity", () => {
  const plain = row("a")
  const pinned = optimisticallyPinned(plain, "2026-11-18T10:00:00.000Z", undefined)
  assert.equal(isPinned(pinned), true)
  assert.equal(isConsolePinned(pinned), false)
  assert.equal(optimisticallyPinned(plain, null, undefined), plain, "unpinning an unpinned thread changes nothing")
  const onBoard = row("b", { pinnedAt: "2026-11-01T00:00:00.000Z" })
  assert.equal(optimisticallyPinned(onBoard, "2026-11-18T10:00:00.000Z", undefined), onBoard, "the server's own instant stands once it lands")
  const lifted = optimisticallyPinned(onBoard, null, undefined)
  assert.equal(isPinned(lifted), false)
  assert.equal("pinnedAt" in lifted, false)
  const onConsole = optimisticallyPinned(plain, undefined, "2026-11-18T10:00:00.000Z")
  assert.equal(isConsolePinned(onConsole), true)
  assert.equal(isPinned(onConsole), false, "the Console's shelf is its own")
})

test("a pin shows from the click until the board carries it", async () => {
  store.board = boardOf(row("p1"))
  const rpc = stubPins()
  try {
    const done = setPinned({ id: "p1", sessionId: "sid-p1" }, "board", true)
    assert.equal(typeof heldPin("board", "p1"), "string", "held before the server answers")
    await tick()
    assert.deepEqual(rpc.calls, [{ name: "setThreadPinned", body: { slug: "p1", sessionId: "sid-p1", pinned: true } }])
    rpc.answer()
    await done
    assert.equal(typeof heldPin("board", "p1"), "string", "still held while the board shows it unpinned")
    store.board = boardOf(row("p1", { pinnedAt: "2026-11-18T10:00:00.000Z" }))
    await tick()
    assert.equal(heldPin("board", "p1"), undefined, "let go once the board carries it")
  } finally {
    globalThis.fetch = rpc.previous
    store.board = null
  }
})

test("a refused pin puts the row back and rejects", async () => {
  store.board = boardOf(row("p2"))
  const rpc = stubPins()
  try {
    const done = setPinned({ id: "p2", sessionId: "sid-p2" }, "console", true)
    assert.equal(typeof heldPin("console", "p2"), "string")
    await tick()
    rpc.answer("not a session")
    await assert.rejects(done, /not a session/)
    assert.equal(heldPin("console", "p2"), undefined)
  } finally {
    globalThis.fetch = rpc.previous
    store.board = null
  }
})

test("a pin then an unpin before the first lands: sent in that order, and the unpin is what shows", async () => {
  store.board = boardOf(row("p3"))
  const rpc = stubPins()
  try {
    const pin = setPinned({ id: "p3", sessionId: "sid-p3" }, "board", true)
    const unpin = setPinned({ id: "p3", sessionId: "sid-p3" }, "board", false)
    assert.equal(heldPin("board", "p3"), null)
    await tick()
    assert.equal(rpc.calls.length, 1, "the unpin waits for the pin's answer")
    rpc.answer()
    await pin
    await tick()
    assert.deepEqual(rpc.calls.map((c) => (c.body as { pinned: boolean }).pinned), [true, false])
    store.board = boardOf(row("p3", { pinnedAt: "2026-11-18T10:00:00.000Z" }))
    await tick()
    assert.equal(heldPin("board", "p3"), null, "the pin landing does not let go of the unpin")
    rpc.answer()
    await unpin
    store.board = boardOf(row("p3"))
    await tick()
    assert.equal(heldPin("board", "p3"), undefined)
  } finally {
    globalThis.fetch = rpc.previous
    store.board = null
  }
})
