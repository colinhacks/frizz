import { test } from "node:test"
import assert from "node:assert/strict"
import { Hono } from "hono"
import { z } from "zod"
import { mountRouter, mutation, query, RpcRefusal, stream } from "./server.ts"

function app() {
  const hono = new Hono()
  mountRouter(hono, "/rpc", {
    echo: query({
      input: z.object({ path: z.string() }).strict(),
      output: z.object({ path: z.string() }),
      handler: async ({ input }) => ({ path: input.path }),
    }),
    post: mutation({
      input: z.object({ path: z.string() }).strict(),
      output: z.object({ path: z.string() }),
      handler: async ({ input }) => ({ path: input.path }),
    }),
    follow: stream({
      input: z.object({ path: z.string() }).strict(),
      event: z.object({ path: z.string() }),
      handler: async function* ({ input }) { yield { path: input.path } },
    }),
  })
  return hono
}

// What every client does (packages/web/src/api/rpc.ts, scripts/lib/rpc-client.mjs): encode once.
function clientUrl(procedure: string, input: unknown): string {
  const url = new URL(`http://127.0.0.1/rpc/${procedure}`)
  url.searchParams.set("input", JSON.stringify(input))
  return url.toString()
}

// A `%` in a query's input. Decoded twice, "50% done" failed the second decode and the whole call was
// refused as invalid JSON, and "a%2Fb.md" came through as "a/b.md": a different file.
const PATHS = ["notes/plain.md", "notes/50% done.md", "shots/Screenshot%202026.png", "a%2Fb.md", "coverage is 100%", "a+b c&d=e#f?g"]

test("a query's input arrives exactly as the client sent it, percent signs included", async () => {
  for (const path of PATHS) {
    const res = await app().request(clientUrl("echo", { path }))
    assert.equal(res.status, 200, path)
    assert.deepEqual(await res.json(), { result: { path } }, path)
  }
})

test("a stream's input arrives the same way", async () => {
  for (const path of PATHS) {
    const res = await app().request(clientUrl("follow", { path }))
    assert.equal(res.status, 200, path)
    const sent = (await res.text()).split("\n").find((line) => line.startsWith("data:"))
    assert.deepEqual(JSON.parse(sent!.slice("data:".length)), { path }, path)
  }
})

test("a query input that is not JSON is refused as the caller's mistake", async () => {
  const res = await app().request("http://127.0.0.1/rpc/echo?input=%7Bnot%20json")
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: "Invalid input JSON" })
})

test("a mutation's body is untouched by any of this, and a malformed one is a 400, not a 500", async () => {
  const send = (body: string) => app().request("http://127.0.0.1/rpc/post", { method: "POST", headers: { "content-type": "application/json" }, body })
  for (const path of PATHS) {
    const res = await send(JSON.stringify({ path }))
    assert.equal(res.status, 200, path)
    assert.deepEqual(await res.json(), { result: { path } }, path)
  }
  const bad = await send("{not json")
  assert.equal(bad.status, 400)
  assert.deepEqual(await bad.json(), { error: "Invalid input JSON" })
})

// A worker's `frizzctl` read `steerThread returned HTTP 500: {"error":"no thread …"}` for a mistyped slug:
// a refusal the handler wrote for it, wearing a fault's status. A handler that throws RpcRefusal is
// answered 409, so a caller can tell the two apart without reading the sentence.
test("a handler's refusal is a 409 and its fault a 500, each with the sentence it threw", async () => {
  const hono = new Hono()
  const input = z.object({ how: z.enum(["refuse", "fault"]) }).strict()
  const handler = async ({ input: { how } }: { input: { how: "refuse" | "fault" } }): Promise<{ ok: true }> => {
    if (how === "refuse") throw new RpcRefusal("no thread `nope` in this project")
    throw new Error("database is locked")
  }
  mountRouter(hono, "/rpc", {
    read: query({ input, output: z.object({ ok: z.literal(true) }), handler }),
    write: mutation({ input, output: z.object({ ok: z.literal(true) }), handler }),
  })
  const write = (how: string) => hono.request("http://127.0.0.1/rpc/write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ how }) })
  for (const ask of [write, (how: string) => hono.request(clientUrl("read", { how }))]) {
    const refused = await ask("refuse")
    assert.equal(refused.status, 409)
    assert.deepEqual(await refused.json(), { error: "no thread `nope` in this project" })
    const fault = await ask("fault")
    assert.equal(fault.status, 500)
    assert.deepEqual(await fault.json(), { error: "database is locked" })
  }
})
