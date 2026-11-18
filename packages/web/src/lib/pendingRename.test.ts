import assert from "node:assert/strict"
import { test } from "node:test"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { store } from "../store.ts"
import { heldTitle, renameThread } from "./pendingRename.ts"

const boardTitled = (id: string, title: string): BoardSnapshot =>
  ({ threads: [{ id, title, runtime: "idle" } as unknown as ThreadView], errors: [] }) as unknown as BoardSnapshot
const tick = () => new Promise((r) => setTimeout(r, 0))

/** Answers each renameThread call when `answer()` is called, refusing it when given a message. */
function stubRenames(): { answer: (refusal?: string) => void; previous: typeof fetch } {
  const previous = globalThis.fetch
  const waiting: ((refusal?: string) => void)[] = []
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      waiting.push((refusal) =>
        resolve(
          refusal
            ? new Response(JSON.stringify({ error: refusal }), { status: 400, headers: { "content-type": "application/json" } })
            : new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } }),
        ),
      )
    })) as typeof fetch
  return { answer: (refusal) => waiting.shift()?.(refusal), previous }
}

test("a rename holds the new name from the call until the board carries it", async () => {
  store.board = boardTitled("t1", "Old name")
  const rpc = stubRenames()
  try {
    const done = renameThread("t1", "New name")
    assert.equal(heldTitle("t1"), "New name", "held before the server answers")
    rpc.answer()
    await done
    assert.equal(heldTitle("t1"), "New name", "still held while the board shows the old name")
    store.board = boardTitled("t1", "New name")
    await tick()
    assert.equal(heldTitle("t1"), undefined, "let go once the board carries it")
  } finally {
    globalThis.fetch = rpc.previous
    store.board = null
  }
})

test("a refused rename puts the old name back and rejects", async () => {
  store.board = boardTitled("t2", "Old name")
  const rpc = stubRenames()
  try {
    const done = renameThread("t2", "Bad name")
    assert.equal(heldTitle("t2"), "Bad name")
    rpc.answer("title too long")
    await assert.rejects(done, /title too long/)
    assert.equal(heldTitle("t2"), undefined)
  } finally {
    globalThis.fetch = rpc.previous
    store.board = null
  }
})

test("an earlier rename landing does not let go of a later one", async () => {
  store.board = boardTitled("t3", "Old name")
  const rpc = stubRenames()
  try {
    const first = renameThread("t3", "First")
    const second = renameThread("t3", "Second")
    rpc.answer()
    await first
    store.board = boardTitled("t3", "First")
    await tick()
    assert.equal(heldTitle("t3"), "Second", "the later name still stands over the board's")
    rpc.answer()
    await second
    store.board = boardTitled("t3", "Second")
    await tick()
    assert.equal(heldTitle("t3"), undefined)
  } finally {
    globalThis.fetch = rpc.previous
    store.board = null
  }
})
