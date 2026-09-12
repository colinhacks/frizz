import assert from "node:assert/strict"
import test from "node:test"
import { createMermaidRenderQueue } from "./mermaidRenderQueue.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test("serialized Mermaid requests retain queue-time source, theme, and palette", async () => {
  const first = deferred<string>()
  const seen: { source: string; resolved: string; palette: string }[] = []
  const queue = createMermaidRenderQueue(async (request) => {
    seen.push({ source: request.source, resolved: request.resolved, palette: request.palette.background })
    return request.id === "one" ? first.promise : "two"
  }, () => {})
  const palette = { background: "before" }
  const one = queue.enqueue({ id: "one", source: "first", resolved: "dark", palette })
  palette.background = "after"
  const two = queue.enqueue({ id: "two", source: "second", resolved: "light", palette: { background: "light" } })
  await Promise.resolve()
  assert.deepEqual(seen, [{ source: "first", resolved: "dark", palette: "before" }])
  first.resolve("one")
  assert.equal(await one, "one")
  assert.equal(await two, "two")
  assert.deepEqual(seen, [
    { source: "first", resolved: "dark", palette: "before" },
    { source: "second", resolved: "light", palette: "light" },
  ])
})

test("a failed Mermaid request cleans scratch state and does not stall later work", async () => {
  const cleaned: string[] = []
  const queue = createMermaidRenderQueue(async (request) => {
    if (request.id === "bad") throw new Error("bad diagram")
    return request.id
  }, (id) => cleaned.push(id))
  await assert.rejects(queue.enqueue({ id: "bad", source: "x", resolved: "dark", palette: {} }), /bad diagram/)
  assert.equal(await queue.enqueue({ id: "good", source: "y", resolved: "light", palette: {} }), "good")
  assert.deepEqual(cleaned, ["bad", "good"])
})
