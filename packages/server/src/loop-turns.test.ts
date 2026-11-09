import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createConnection, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { test } from "node:test"
import { takeLoopTurn } from "./loop-turns.ts"

const block = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until); }

// How many of five jobs had run when a socket that was already readable got its turn.
//
// A Unix socket, because a write to one is in the peer's buffer before `write` returns. Over TCP loopback the
// kernel delivers on a thread of its own, and at load 240 that took longer than the first job, so the
// connection looked late through no fault of the queue.
async function readDuring(start: (job: () => void) => void): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "frizz-loop-turns-"))
  const server = createServer()
  server.listen(join(dir, "s"))
  await once(server, "listening")
  const accepted = once(server, "connection")
  const client = createConnection(join(dir, "s"))
  const [[peer]] = await Promise.all([accepted, once(client, "connect")])
  let read = -1
  let ran = 0
  ;(peer as Socket).on("data", () => { if (read === -1) read = ran })
  const finished = new Promise<void>((resolve) => {
    setTimeout(() => {
      // Five projects' jobs, all due in one timers phase, with a request already waiting.
      client.write("x")
      for (let i = 0; i < 5; i++) start(() => { block(20); if (++ran === 5) setImmediate(resolve) })
    }, 1)
  })
  await finished
  await new Promise((r) => setImmediate(r))
  client.destroy()
  ;(peer as Socket).destroy()
  server.close()
  rmSync(dir, { recursive: true, force: true })
  return read
}

test("jobs due at once take turns with the sockets, where bare timers would run them all first", async () => {
  // Negative control: all five run before the loop looks at a socket.
  assert.equal(await readDuring((job) => job()), 5)
  // Through the queue, the request is read after the first job.
  assert.equal(await readDuring(takeLoopTurn), 1)
})

test("a job that throws does not stop the ones behind it, and an idle queue runs a job at once", async () => {
  const order: string[] = []
  takeLoopTurn(() => { order.push("first"); throw new Error("expected by this test") })
  takeLoopTurn(() => order.push("second"))
  assert.deepEqual(order, ["first"], "the first runs where it was handed in")
  // Jobs run in the order handed in, so one queued last runs after both.
  await new Promise<void>((resolve) => takeLoopTurn(resolve))
  assert.deepEqual(order, ["first", "second"])
  // One more turn and the queue has found itself empty.
  await new Promise((r) => setImmediate(r))
  takeLoopTurn(() => order.push("third"))
  assert.deepEqual(order, ["first", "second", "third"], "an idle queue runs a job where it is handed in")
})
