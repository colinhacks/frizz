import assert from "node:assert/strict"
import { createServer } from "node:http"
import { connect } from "node:net"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { gunzipSync } from "node:zlib"
import { after, before, test } from "node:test"
import { serveStatic } from "./index.ts"

// Driven through a REAL node http server and real fetch, because every claim here is about wire
// behaviour a fake req/res cannot show: which validator the browser gets back, whether a conditional
// request is answered 304 with no body, and whether a rebuilt index.html is picked up rather than
// served from the client's cache. The regression this pins is the one that hurts most — an
// immutably-cached shell would leave a user on the old build after Frizz promotes a new artifact and
// restarts, with no way out but a manual cache clear.

let dist: string
let origin: string
let server: ReturnType<typeof createServer>

before(async () => {
  dist = mkdtempSync(join(tmpdir(), "frizz-static-"))
  mkdirSync(join(dist, "assets"))
  writeFileSync(join(dist, "index.html"), "<!doctype html><script src=\"/assets/index-AAAA.js\"></script>")
  // Over MIN_COMPRESS_BYTES, or the compressor declines and the encoding assertions below prove nothing.
  writeFileSync(join(dist, "assets", "index-AAAA.js"), `globalThis.build = "one"; // ${"x".repeat(4096)}`)
  server = createServer((req, res) => serveStatic(dist, req, res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dist, { recursive: true, force: true })
})

test("a hashed asset is immutable; the shell that names it is not", async () => {
  const asset = await fetch(`${origin}/assets/index-AAAA.js`)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable")
  assert.ok(asset.headers.get("etag"), "a validator is what makes the second load free")

  const shell = await fetch(`${origin}/`)
  assert.equal(shell.status, 200)
  assert.equal(shell.headers.get("cache-control"), "no-cache")
  assert.ok(shell.headers.get("etag"))
})

// The root is the projects page, and the launcher sends an unknown folder there as `/?add=<dir>`.
// On Windows the platform `normalize` turns "/" into "\", which missed the root test, resolved the
// URL to the dist directory itself, and answered "not found" — while every other route worked, so
// only the grid was broken and only there (2026-09-09).
test("no document can be framed, a revalidated one included", async () => {
  const shell = await fetch(`${origin}/`)
  assert.equal(shell.headers.get("x-frame-options"), "DENY")
  assert.equal(shell.headers.get("content-security-policy"), "frame-ancestors 'none'")
  const again = await fetch(`${origin}/`, { headers: { "if-none-match": shell.headers.get("etag")! } })
  assert.equal(again.status, 304)
  assert.equal(again.headers.get("x-frame-options"), "DENY")
  assert.equal(again.headers.get("content-security-policy"), "frame-ancestors 'none'")
})

test("the root URL is the shell on every platform, with or without a query string", async () => {
  for (const path of ["/", "/?add=D%3A%5Cscratch", "/?unknown=gone"]) {
    const res = await fetch(`${origin}${path}`)
    assert.equal(res.status, 200, path)
    assert.match(await res.text(), /index-AAAA\.js/, path)
  }
})

test("a request for a hashed asset that does not exist gets the SPA shell's policy, not the asset's", async () => {
  // The fallback resolves to index.html, so the policy has to follow the RESOLVED file. Deciding it
  // from the URL would pin the app shell forever under an /assets/ URL.
  const res = await fetch(`${origin}/assets/index-GONE.js`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("cache-control"), "no-cache")
})

test("a conditional request is answered 304 with no body", async () => {
  const first = await fetch(`${origin}/assets/index-AAAA.js`)
  const etag = first.headers.get("etag")!
  await first.arrayBuffer()

  const second = await fetch(`${origin}/assets/index-AAAA.js`, { headers: { "if-none-match": etag } })
  assert.equal(second.status, 304)
  assert.equal((await second.arrayBuffer()).byteLength, 0)

  // Negative control: without the validator the same URL still costs the full body.
  const third = await fetch(`${origin}/assets/index-AAAA.js`)
  assert.equal(third.status, 200)
  assert.ok((await third.arrayBuffer()).byteLength > 4096)
})

// HALF THE PROOF, AND ONLY HALF. This says the server answers a stale validator with the new shell;
// it CANNOT say the browser asks. Whether a reload revalidates at all is decided by the
// `cache-control` the test above pins, inside the browser's cache — flip index.html to `immutable`
// and this test still passes while every real reload serves the old build from disk. The other half
// was driven in Chrome (2026-09-04, .frizz notes): rebuild, reload, new asset hash fetched.
test("a rebuilt shell is served rather than revalidated, so a promoted artifact is picked up", async () => {
  const before = await fetch(`${origin}/`)
  const etag = before.headers.get("etag")!
  assert.match(await before.text(), /index-AAAA\.js/)

  // What `frizz-update` does: a new artifact with different asset hashes, then a restart. The
  // browser comes back holding the old shell's validator.
  writeFileSync(join(dist, "index.html"), "<!doctype html><script src=\"/assets/index-BBBB.js\"></script>")

  const after = await fetch(`${origin}/`, { headers: { "if-none-match": etag } })
  assert.equal(after.status, 200, "no-cache means revalidate, and the shell changed")
  assert.match(await after.text(), /index-BBBB\.js/)
})

test("text is compressed when the client asks, and left alone when it does not", async () => {
  const plain = await fetch(`${origin}/assets/index-AAAA.js`, { headers: { "accept-encoding": "identity" } })
  assert.equal(plain.headers.get("content-encoding"), null)
  assert.equal(plain.headers.get("vary"), "Accept-Encoding")

  // undici decodes transparently, so read the encoded bytes off a raw socket request instead.
  const gzipped = await new Promise<{ headers: string; body: Buffer }>((resolve, reject) => {
    const port = Number(new URL(origin).port)
    const socket = connect(port, "127.0.0.1", () => {
      socket.write("GET /assets/index-AAAA.js HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n")
    })
    const chunks: Buffer[] = []
    socket.on("data", (chunk) => chunks.push(chunk))
    socket.on("error", reject)
    socket.on("end", () => {
      const raw = Buffer.concat(chunks)
      const split = raw.indexOf("\r\n\r\n")
      resolve({ headers: raw.subarray(0, split).toString("latin1"), body: raw.subarray(split + 4) })
    })
  })
  assert.match(gzipped.headers, /content-encoding: gzip/i)
  assert.match(gunzipSync(gzipped.body).toString("utf8"), /globalThis\.build = "one"/)
})

// A backslash must not be a way OUT of the root. On Windows the native `join` reads `\` as a
// separator, so a `..\` segment that POSIX normalization left alone walks up — and a sibling that
// shares the root's name prefix passed a bare `startsWith(distDir)` (pullfrog on #34). The request
// goes over a raw socket because fetch turns `\` into `/` before sending.
test("a backslash traversal to a prefix-sharing sibling gets the shell, never the sibling's file", async () => {
  const sibling = `${dist}-private`
  mkdirSync(sibling)
  writeFileSync(join(sibling, "secret.txt"), "SECRET")
  const name = basename(sibling)
  const rawGet = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const port = Number(new URL(origin).port)
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
      })
      const chunks: Buffer[] = []
      socket.on("data", (chunk) => chunks.push(chunk))
      socket.on("error", reject)
      socket.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8")
        const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(raw)?.[1])
        resolve({ status, body: raw.slice(raw.indexOf("\r\n\r\n") + 4) })
      })
    })
  try {
    for (const path of [`/..\\${name}\\secret.txt`, `/assets/..\\..\\${name}\\secret.txt`, `/../${name}/secret.txt`]) {
      const res = await rawGet(path)
      assert.equal(res.status, 200, path)
      assert.doesNotMatch(res.body, /SECRET/u, path)
      assert.match(res.body, /index-(AAAA|BBBB)\.js/u, path)
    }
  } finally {
    rmSync(sibling, { recursive: true, force: true })
  }
})
