import assert from "node:assert/strict"
import test from "node:test"
import { createServer, request, type RequestListener } from "node:http"
import { once } from "node:events"
import { refuseTransforms, withNoTransform } from "./no-transform.ts"

test("no-transform joins whatever Cache-Control there was, once", () => {
  assert.equal(withNoTransform(undefined), "no-transform")
  assert.equal(withNoTransform(""), "no-transform")
  assert.equal(withNoTransform("no-store"), "no-store, no-transform")
  assert.equal(withNoTransform(["no-cache", "private"]), "no-cache, private, no-transform")
  assert.equal(withNoTransform("public, No-Transform"), "public, No-Transform")
  assert.equal(withNoTransform("no-transformation-please"), "no-transformation-please, no-transform")
})

// Every way a Node handler can write its headers, through a real server, so the patch is held to what
// actually goes out on the wire rather than to what the handler passed.
test("every way of writing headers goes out with no-transform", async () => {
  const cases: Record<string, RequestListener> = {
    "/object": (_req, res) => { res.writeHead(200, { "cache-control": "no-store" }); res.end() },
    "/message": (_req, res) => { res.writeHead(200, "OK", { "Cache-Control": "no-cache" }); res.end() },
    "/none": (_req, res) => { res.writeHead(404, { "content-type": "text/plain" }); res.end() },
    "/bare": (_req, res) => { res.writeHead(204); res.end() },
    "/set": (_req, res) => { res.setHeader("cache-control", "private"); res.end("x") },
    "/implicit": (_req, res) => { res.end("x") },
    "/already": (_req, res) => { res.writeHead(200, { "cache-control": "no-transform" }); res.end() },
  }
  const server = createServer((req, res) => {
    refuseTransforms(res)
    cases[req.url ?? ""]!(req, res)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as { port: number }
  const cacheControl = (path: string) => new Promise<string | undefined>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (res) => {
      res.resume()
      res.on("end", () => resolve(res.headers["cache-control"]))
    }).once("error", reject).end()
  })
  try {
    assert.deepEqual(
      Object.fromEntries(await Promise.all(Object.keys(cases).map(async (path) => [path, await cacheControl(path)]))),
      {
        "/object": "no-store, no-transform",
        "/message": "no-cache, no-transform",
        "/none": "no-transform",
        "/bare": "no-transform",
        "/set": "private, no-transform",
        "/implicit": "no-transform",
        "/already": "no-transform",
      },
    )
  } finally {
    server.close()
  }
})
