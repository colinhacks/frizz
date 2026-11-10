import assert from "node:assert/strict"
import test from "node:test"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import { compress, MIN_COMPRESS_BYTES, negotiateEncoding, shouldCompress } from "./compression.ts"

test("brotli is preferred, gzip is the fallback, and neither is invented", () => {
  assert.equal(negotiateEncoding("gzip, deflate, br"), "br")
  assert.equal(negotiateEncoding("gzip, deflate"), "gzip")
  assert.equal(negotiateEncoding("gzip;q=0.8, br;q=0.9"), "br")
  assert.equal(negotiateEncoding("deflate"), null, "deflate alone is not something we emit")
  assert.equal(negotiateEncoding(""), null)
  assert.equal(negotiateEncoding(undefined), null)
})

test("a client that REFUSES an encoding is believed", () => {
  // `q=0` means "do not send me this". Sending it anyway produces a body the client cannot read, and
  // it looks like corruption rather than a negotiation bug.
  assert.equal(negotiateEncoding("br;q=0, gzip"), "gzip")
  assert.equal(negotiateEncoding("br;q=0, gzip;q=0"), null)
  assert.equal(negotiateEncoding("*;q=0"), null)
  assert.equal(negotiateEncoding("*"), "br", "a bare wildcard accepts our preferred encoding")
  assert.equal(negotiateEncoding("*, br;q=0"), "gzip", "an explicit refusal beats the wildcard")
})

test("compressed bytes decompress back to exactly the input", () => {
  // The failure this catches is silent and total: a wrong level or a truncated buffer still returns
  // bytes, and the browser reports a network error rather than anything diagnosable.
  const body = new TextEncoder().encode(JSON.stringify({ threads: Array.from({ length: 500 }, (_, i) => ({ id: `t-${i}`, title: `thread ${i}`, status: "rested" })) }))
  const br = compress(body, "br")
  const gz = compress(body, "gzip")
  assert.deepEqual(new Uint8Array(brotliDecompressSync(br)), body)
  assert.deepEqual(new Uint8Array(gunzipSync(gz)), body)
  assert.ok(br.byteLength < body.byteLength / 3, `brotli only reached ${(body.byteLength / br.byteLength).toFixed(1)}x`)
})

test("small and already-encoded responses are left alone", () => {
  const json = new Headers({ "content-type": "application/json" })
  assert.equal(shouldCompress(json, MIN_COMPRESS_BYTES - 1), false, "framing costs more than it saves")
  assert.equal(shouldCompress(json, MIN_COMPRESS_BYTES), true)
  const already = new Headers({ "content-type": "application/json", "content-encoding": "gzip" })
  assert.equal(shouldCompress(already, 10_000), false, "double-encoding produces an unreadable body")
})

test("an event stream is never compressed, even if a route slips past the path scope", () => {
  // Buffering an SSE stream turns a live board into a stuttering one — the exact problem this feature
  // exists to fix, relocated somewhere harder to spot.
  const sse = new Headers({ "content-type": "text/event-stream" })
  assert.equal(shouldCompress(sse, 100_000), false)
})

test("binary payloads are skipped; text-shaped ones are not", () => {
  assert.equal(shouldCompress(new Headers({ "content-type": "image/png" }), 100_000), false)
  assert.equal(shouldCompress(new Headers({ "content-type": "application/octet-stream" }), 100_000), false)
  for (const type of ["application/json", "text/html; charset=utf-8", "image/svg+xml", "text/javascript"]) {
    assert.equal(shouldCompress(new Headers({ "content-type": type }), 100_000), true, type)
  }
})

test("an RPC tag matches itself through either form and a list, and nothing else", async () => {
  const { etagMatches, rpcEtag } = await import("./compression.ts")
  const tag = rpcEtag(new TextEncoder().encode('{"result":1}'))
  assert.match(tag, /^W\/"[\w-]+"$/)
  assert.equal(etagMatches(tag, tag), true)
  assert.equal(etagMatches(tag.slice(2), tag), true, "weak comparison ignores the W/")
  assert.equal(etagMatches(`"other", ${tag}`, tag), true)
  assert.equal(etagMatches("*", tag), true)
  assert.equal(etagMatches(rpcEtag(new TextEncoder().encode('{"result":2}')), tag), false)
  assert.equal(etagMatches(undefined, tag), false)
})
