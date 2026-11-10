import assert from "node:assert/strict"
import { test } from "node:test"
import { brotliDecompressSync } from "node:zlib"
import { createApp } from "./app.ts"
import type { AppContext } from "./context.ts"

// A query's answer carries a validator, and an unchanged answer revalidates as a bodiless 304: what lets
// a reloaded Console skip re-downloading every project's unchanged board (2 MB of JSON on the
// maintainer's machine), and the rail's 5s poll skip its unchanged counts.

const PORT = 49_271

function app(board: () => unknown) {
  const inert = new Proxy({}, { get: () => () => {} })
  const ctx = {
    bootId: "rpc-etag-boot",
    project: { id: "rpc-etag-project", dir: "/tmp/rpc-etag-project", stateDir: "/tmp/rpc-etag-state", cwdSlug: "-tmp-rpc-etag-project", name: "rpc-etag", label: "local/rpc-etag" },
    bus: inert, transcriptChange: inert, storage: inert, interactions: inert, tailer: inert,
    board: { snapshotState: async () => ({ board: board(), seq: 3 }) },
    dispatcher: inert, backendFor: () => inert, scheduler: inert, permissionController: inert,
    getSettings: () => ({}), setSettings: (settings: unknown) => settings, resetSettings: () => ({}),
  } as unknown as AppContext
  const served = createApp(ctx, { port: PORT })
  return (headers: Record<string, string> = {}, method = "GET") =>
    served.request(`http://127.0.0.1:${PORT}/_frizz/rpc/boardState`, {
      method,
      headers: { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${PORT}`, ...headers },
    })
}

test("an unchanged query answer revalidates as a 304 with no body; a changed one is sent whole", async () => {
  let threads = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, title: `thread ${i}` }))
  const get = app(() => ({ projectDir: "/tmp/x", threads }))
  const first = await get({ "accept-encoding": "br" })
  assert.equal(first.status, 200)
  assert.equal(first.headers.get("cache-control"), "private, no-cache", "stored, but asked about every time")
  assert.equal(first.headers.get("content-encoding"), "br")
  const etag = first.headers.get("etag")!
  assert.match(etag, /^W\//)
  const body = JSON.parse(brotliDecompressSync(Buffer.from(await first.arrayBuffer())).toString())
  assert.equal(body.result.board.threads.length, 40)

  const same = await get({ "accept-encoding": "br", "if-none-match": etag })
  assert.equal(same.status, 304)
  assert.equal((await same.arrayBuffer()).byteLength, 0)
  assert.equal(same.headers.get("etag"), etag)
  assert.equal(same.headers.get("x-frizz-boot"), "rpc-etag-boot", "a 304 still names the server's boot")

  // The same answer through another encoding (or none) is the same answer.
  assert.equal((await get({ "accept-encoding": "identity", "if-none-match": etag })).status, 304)

  threads = [...threads, { id: "t40", title: "a new thread" }]
  const changed = await get({ "accept-encoding": "br", "if-none-match": etag })
  assert.equal(changed.status, 200, "a board that moved is sent whole")
  assert.notEqual(changed.headers.get("etag"), etag)
})
