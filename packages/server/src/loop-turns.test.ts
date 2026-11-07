import assert from "node:assert/strict"
import { createConnection, createServer } from "node:net"
import { once } from "node:events"
import { test } from "node:test"
import { takeLoopTurn } from "./loop-turns.ts"

const block = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until); }

async function acceptedDuring(start: (job: () => void) => void): Promise<number> {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as { port: number }
  let accepted = -1
  let ran = 0
  server.on("connection", (socket) => { accepted = ran; socket.destroy() })
  const finished = new Promise<void>((resolve) => {
    setTimeout(() => {
      // Five projects' jobs, all due in one timers phase, and a client already waiting at the door.
      const client = createConnection(port, "127.0.0.1")
      client.on("error", () => undefined)
      block(10)
      for (let i = 0; i < 5; i++) start(() => { block(20); if (++ran === 5) setImmediate(resolve) })
    }, 1)
  })
  await finished
  await new Promise((r) => setTimeout(r, 20))
  server.close()
  return accepted
}

test("jobs due at once take turns with the sockets, where bare timers would run them all first", async () => {
  // Negative control: all five run before the loop looks at a socket.
  assert.equal(await acceptedDuring((job) => job()), 5)
  // Through the queue, the connection is answered after the first job.
  assert.equal(await acceptedDuring(takeLoopTurn), 1)
})

test("a job that throws does not stop the ones behind it, and an idle queue runs a job at once", async () => {
  const order: string[] = []
  takeLoopTurn(() => { order.push("first"); throw new Error("expected by this test") })
  takeLoopTurn(() => order.push("second"))
  assert.deepEqual(order, ["first"], "the first runs where it was handed in")
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(order, ["first", "second"])
  takeLoopTurn(() => order.push("third"))
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(order, ["first", "second", "third"])
})
