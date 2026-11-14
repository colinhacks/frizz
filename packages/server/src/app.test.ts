import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { createApp, resolveLocalImage, type AppOptions } from "./app.ts"
import type { AppContext } from "./context.ts"

// A 1x1 PNG's leading bytes are enough — the route serves the bytes verbatim, it doesn't decode.
const PNG = Buffer.from("89504e470d0a1a0a", "hex")

function originTestApp(port: number, onDispatch?: () => void, options: Partial<AppOptions> = {}, stateDir = "/tmp/origin-test-state", overrides: Partial<AppContext> = {}) {
  const inert = new Proxy({}, { get: () => () => {} })
  const ctx = {
    bootId: "origin-test-boot",
    project: {
      id: "origin-test-project",
      dir: "/tmp/origin-test-project",
      stateDir,
      cwdSlug: "-tmp-origin-test-project",
      name: "origin-test",
      label: "local/origin-test",
    },
    bus: inert,
    transcriptChange: inert,
    storage: inert,
    interactions: inert,
    board: inert,
    tailer: inert,
    dispatcher: onDispatch
      ? {
          dispatch: async () => {
            onDispatch()
            return { slug: "authority-probe", sessionId: "authority-probe-session" }
          },
        }
      : inert,
    backendFor: () => inert,
    scheduler: inert,
    permissionController: inert,
    getSettings: () => ({}),
    setSettings: (settings: unknown) => settings,
    resetSettings: () => ({}),
    ...overrides,
  } as unknown as AppContext
  return createApp(ctx, { port, ...options })
}

test("HTTP control plane accepts exact local origins and intentional no-Origin CLI probes", async () => {
  const port = 49_177
  const app = originTestApp(port)
  const request = (headers: Record<string, string>) => app.request(`http://127.0.0.1:${port}/_frizz/health`, { headers })

  const cli = await request({ host: `127.0.0.1:${port}` })
  assert.equal(cli.status, 200, "native local health probes intentionally carry no Origin")

  const missingOriginControl = await app.request(`http://127.0.0.1:${port}/_frizz/local-image`, {
    headers: { host: `127.0.0.1:${port}` },
  })
  assert.equal(missingOriginControl.status, 403, "no-Origin compatibility is not control-plane-wide")

  const sameOriginBrowser = await app.request(`http://127.0.0.1:${port}/_frizz/local-image`, {
    headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
  })
  assert.equal(sameOriginBrowser.status, 400, "same-origin browser metadata reaches the route (which then rejects its missing path)")

  for (const [host, origin] of [
    [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
    [`localhost:${port}`, `http://localhost:${port}`],
    [`[::1]:${port}`, `http://[::1]:${port}`],
  ]) {
    const response = await request({ host, origin })
    assert.equal(response.status, 200, origin)
    assert.equal(response.headers.get("access-control-allow-origin"), origin)
  }
})

test("token-bound health and stop control never expose or accept a forged owner capability", async () => {
  const port = 49_177
  let stops = 0
  const app = originTestApp(port, undefined, {
    ownerProof: "project-bound-proof",
    controlToken: "owner-capability",
    requestOwnerStop: () => { stops++ },
  })
  const health = await app.request(`http://127.0.0.1:${port}/_frizz/health`, {
    headers: { host: `127.0.0.1:${port}` },
  })
  assert.deepEqual(await health.json(), {
    ok: true,
    projectId: "origin-test-project",
    projectDir: "/tmp/origin-test-project",
    bootId: "origin-test-boot",
    ownerProof: "project-bound-proof",
  })

  const forged = await app.request(`http://127.0.0.1:${port}/_frizz/control/stop`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, "x-frizz-launch-token": "forged" },
  })
  assert.equal(forged.status, 403)
  const crossOrigin = await app.request(`http://127.0.0.1:${port}/_frizz/control/stop`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://localhost:${port}`,
      "x-frizz-launch-token": "owner-capability",
    },
  })
  assert.equal(crossOrigin.status, 403)
  const accepted = await app.request(`http://127.0.0.1:${port}/_frizz/control/stop`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, "x-frizz-launch-token": "owner-capability" },
  })
  assert.equal(accepted.status, 202)
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(stops, 1)
})

test("the launch route answers a launcher holding either owner token, and nobody else", async () => {
  const port = 49_176
  const opened: string[] = []
  const home = mkdtempSync(join(tmpdir(), "frizz-launch-route-"))
  const elsewhere = join(home, "elsewhere")
  mkdirSync(elsewhere)
  const app = originTestApp(port, undefined, {
    controlToken: "host-capability",
    machineToken: "machine-capability",
    launchRouting: { home, open: (dir) => { opened.push(dir); throw new Error("nothing here is a project") } },
  })
  const ask = (headers: Record<string, string>, body: unknown = { protocol: 1, dir: elsewhere }) =>
    app.request(`http://127.0.0.1:${port}/_frizz/control/launch`, {
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })

  // A launcher is not a browser and sends no Origin; the token is what it is known by.
  for (const token of ["host-capability", "machine-capability"]) {
    const answered = await ask({ "x-frizz-launch-token": token })
    assert.equal(answered.status, 200, token)
    assert.deepEqual(await answered.json(), { protocol: 1, path: "/" })
  }
  assert.equal((await ask({})).status, 403)
  assert.equal((await ask({ "x-frizz-launch-token": "forged" })).status, 403)
  // A page on another loopback name cannot borrow the token it has no way to read anyway.
  assert.equal((await ask({ "x-frizz-launch-token": "machine-capability", origin: `http://localhost:${port}` })).status, 403)
  assert.equal((await ask({ "x-frizz-launch-token": "machine-capability" }, { protocol: 2, dir: elsewhere })).status, 400)
  assert.equal((await ask({ "x-frizz-launch-token": "machine-capability" }, { protocol: 1, dir: "relative" })).status, 400)
  assert.equal((await ask({ "x-frizz-launch-token": "machine-capability" }, { protocol: 1, dir: join(home, "gone") })).status, 400)
  assert.deepEqual(opened, [], "a folder that is not a project is never opened")

  // No token configured at all — a server nothing launched — answers nobody.
  const bare = originTestApp(port)
  const refused = await bare.request(`http://127.0.0.1:${port}/_frizz/control/launch`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, "x-frizz-launch-token": "" },
    body: JSON.stringify({ protocol: 1, dir: elsewhere }),
  })
  assert.equal(refused.status, 403)
})

test("HTTP/CORS rejects every cross-loopback Host/Origin pair before reads, preflights, or mutation bodies", async () => {
  const port = 49_177
  let dispatchCalls = 0
  const app = originTestApp(port, () => { dispatchCalls++ })
  const authorities = [
    { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
    { host: `localhost:${port}`, origin: `http://localhost:${port}` },
    { host: `[::1]:${port}`, origin: `http://[::1]:${port}` },
  ]

  for (const target of authorities) {
    for (const source of authorities) {
      if (target.host === source.host) continue
      const headers = { host: target.host, origin: source.origin }

      const read = await app.request(`http://127.0.0.1:${port}/_frizz/health`, { headers })
      assert.equal(read.status, 403, `read ${source.origin} -> ${target.host}`)
      assert.equal(read.headers.get("access-control-allow-origin"), null)

      const preflight = await app.request(`http://127.0.0.1:${port}/_frizz/rpc/dispatch`, {
        method: "OPTIONS",
        headers: {
          ...headers,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      })
      assert.equal(preflight.status, 403, `preflight ${source.origin} -> ${target.host}`)
      assert.equal(preflight.headers.get("access-control-allow-origin"), null)

      const mutation = await app.request(`http://127.0.0.1:${port}/_frizz/rpc/dispatch`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "must not dispatch", slug: "must-not-dispatch" }),
      })
      assert.equal(mutation.status, 403, `mutation ${source.origin} -> ${target.host}`)
      assert.equal(mutation.headers.get("access-control-allow-origin"), null)
    }
  }
  assert.equal(dispatchCalls, 0, "rejected cross-authority bodies never reach the RPC handler")
})

test("HTTP/CORS preserves same-authority desktop/PWA preflights and valid mutation routing", async () => {
  const port = 49_177
  let dispatchCalls = 0
  const app = originTestApp(port, () => { dispatchCalls++ })
  for (const { host, origin } of [
    { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
    { host: `localhost:${port}`, origin: `http://localhost:${port}` },
    { host: `[::1]:${port}`, origin: `http://[::1]:${port}` },
  ]) {
    const preflight = await app.request(`http://127.0.0.1:${port}/_frizz/rpc/dispatch`, {
      method: "OPTIONS",
      headers: {
        host,
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    })
    assert.equal(preflight.status, 204, origin)
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin)
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /content-type/i)

    const mutation = await app.request(`http://127.0.0.1:${port}/_frizz/rpc/dispatch`, {
      method: "POST",
      headers: { host, origin, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "same-authority dispatch", slug: "authority-probe" }),
    })
    assert.equal(mutation.status, 200, `${origin} reaches the typed mutation handler`)
    assert.equal(mutation.headers.get("access-control-allow-origin"), origin)
  }
  const sameOriginMetadataOnly = await app.request(`http://127.0.0.1:${port}/_frizz/rpc/dispatch`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt: "same-origin metadata dispatch", slug: "authority-probe" }),
  })
  assert.equal(sameOriginMetadataOnly.status, 200, "same-origin Fetch Metadata preserves the no-Origin PWA path")
  assert.equal(dispatchCalls, 4)
})

// A rejected input must name what was wrong. The envelope used to carry zod's nested `format()` OBJECT,
// which the web client cannot render — every validation failure app-wide surfaced as the opaque
// "RPC <name> failed", and that is what hid a real snooze timer-format bug from the operator.
test("a rejected RPC input returns a readable string message, not an unrenderable object", async () => {
  const port = 49_177
  const app = originTestApp(port)
  const res = await app.request(`http://127.0.0.1:${port}/_frizz/rpc/setThreadSnooze`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
    body: JSON.stringify({ slug: "some-thread", until: "2026-07-24T17:00:00Z" }),
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: unknown }
  assert.equal(typeof body.error, "string", "the web client only surfaces a string error verbatim")
  assert.match(body.error as string, /until: .*ISO-8601 UTC instant/)
})

test("HTTP control plane rejects hostile/prefix/port/Host/forwarded origin tricks", async () => {
  const port = 49_177
  const app = originTestApp(port)
  const request = (headers: Record<string, string>) => app.request(`http://127.0.0.1:${port}/_frizz/health`, { headers })
  const validHost = `127.0.0.1:${port}`

  const hostileOrigins = [
    "http://evil.example",
    `http://localhost.evil.example:${port}`,
    `http://127.0.0.1.evil.example:${port}`,
    `http://127.0.0.1:${port + 1}`,
    `http://127.1:${port}`,
    `http://2130706433:${port}`,
    `http://0177.0.0.1:${port}`,
    `HTTP://LOCALHOST:${port}`,
    `http://localhost:${port}/`,
    `http://xn--localhst-sbh:${port}`,
    `http://%6cocalhost:${port}`,
    `http://[0:0:0:0:0:0:0:1]:${port}`,
    `http://[::ffff:127.0.0.1]:${port}`,
    "null",
  ]
  for (const origin of hostileOrigins) {
    assert.equal((await request({ host: validHost, origin })).status, 403, origin)
    const preflight = await app.request(`http://127.0.0.1:${port}/_frizz/rpc/dispatch`, {
      method: "OPTIONS",
      headers: {
        host: validHost,
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    })
    assert.equal(preflight.status, 403, `preflight ${origin}`)
    assert.equal(preflight.headers.get("access-control-allow-origin"), null)
  }
  const hostileHosts = [
    `localhost.evil.example:${port}`,
    `127.0.0.1.evil.example:${port}`,
    `127.0.0.1:${port + 1}`,
    `127.1:${port}`,
    `2130706433:${port}`,
    `0177.0.0.1:${port}`,
    `xn--localhst-sbh:${port}`,
    `%6cocalhost:${port}`,
    `[0:0:0:0:0:0:0:1]:${port}`,
    `[::ffff:127.0.0.1]:${port}`,
  ]
  for (const host of hostileHosts) {
    assert.equal((await request({ host })).status, 403, host)
    const preflight = await app.request(`http://127.0.0.1:${port}/_frizz/rpc/dispatch`, {
      method: "OPTIONS",
      headers: {
        host,
        origin: `http://127.0.0.1:${port}`,
        "access-control-request-method": "POST",
      },
    })
    assert.equal(preflight.status, 403, `preflight Host ${host}`)
  }
  for (const name of [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
  ]) {
    assert.equal((await request({
      host: validHost,
      origin: `http://127.0.0.1:${port}`,
      [name]: name === "forwarded" ? "" : "attacker-controlled",
    })).status, 403, name)
  }
  assert.equal((await app.request(`http://127.0.0.1:${port}/_frizz/local-image`, {
    headers: { host: validHost, "sec-fetch-site": "cross-site" },
  })).status, 403, "a cross-site browser cannot use the CLI's missing-Origin exception")
})

function fixtures() {
  const root = mkdtempSync(join(tmpdir(), "frizz-img-"))
  const img = join(root, "shot.png")
  writeFileSync(img, PNG)
  return { root, img }
}

test("allowed: absolute png → 200 with content-type", () => {
  const { img } = fixtures()
  const r = resolveLocalImage(img)
  assert.equal(r.status, 200)
  if (r.status === 200) {
    assert.equal(r.contentType, "image/png")
    assert.equal(r.size, PNG.length)
  }
})

test("unconfined: an image ANYWHERE on disk renders → 200 (no trusted-root gate)", () => {
  // The proxy deliberately renders any readable local image, not just workspace/tmp ones — a
  // screenshot under ~/Desktop, /var/folders, wherever. This is the behavior the maintainer asked for.
  const outside = mkdtempSync(join(tmpdir(), "frizz-anywhere-"))
  const img = join(outside, "anywhere.png")
  writeFileSync(img, PNG)
  assert.equal(resolveLocalImage(img).status, 200)
})

test("non-image path → 400 (wrong extension, e.g. /etc/passwd)", () => {
  assert.equal(resolveLocalImage("/etc/passwd").status, 400)
})

test("relative path → 400", () => {
  assert.equal(resolveLocalImage("shot.png").status, 400)
})

test("non-image extension → 400", () => {
  const { root } = fixtures()
  const txt = join(root, "note.txt")
  writeFileSync(txt, "hi")
  assert.equal(resolveLocalImage(txt).status, 400)
})

test("missing file → 404", () => {
  const { root } = fixtures()
  assert.equal(resolveLocalImage(join(root, "nope.png")).status, 404)
})

test("/_frizz/local-image route serves an agent screenshot under /tmp end-to-end", async () => {
  const port = 49_233
  const app = originTestApp(port)
  // A Claude-Code-scratchpad-shaped screenshot under the shared temp tree, driven through the REAL route.
  const scratch = mkdtempSync(join("/tmp", "claude-501-worker-"))
  const shot = join(scratch, "summary-dark-crop.png")
  writeFileSync(shot, PNG)
  const served = await app.request(`http://127.0.0.1:${port}/_frizz/local-image?path=${encodeURIComponent(shot)}`, {
    headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
  })
  assert.equal(served.status, 200, "worker screenshot serves")
  assert.equal(served.headers.get("content-type"), "image/png")
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG)
})

test("/_frizz/local-image route plays a video: byte ranges, a HEAD with no body, a 416 past the end", async () => {
  const port = 49_235
  const app = originTestApp(port)
  const dir = mkdtempSync(join(tmpdir(), "frizz-video-route-"))
  const video = join(dir, "flow.webm")
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 253))
  writeFileSync(video, bytes)
  const url = `http://127.0.0.1:${port}/_frizz/local-image?path=${encodeURIComponent(video)}`
  const headers = { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" }

  // What a <video> sends first, and then for a seek.
  const opening = await app.request(url, { headers: { ...headers, range: "bytes=0-" } })
  assert.equal(opening.status, 206)
  assert.equal(opening.headers.get("content-range"), "bytes 0-4095/4096")
  assert.deepEqual(Buffer.from(await opening.arrayBuffer()), bytes)
  const seek = await app.request(url, { headers: { ...headers, range: "bytes=1000-1999" } })
  assert.equal(seek.status, 206)
  assert.equal(seek.headers.get("content-type"), "video/webm")
  assert.equal(seek.headers.get("content-length"), "1000")
  assert.equal(seek.headers.get("accept-ranges"), "bytes")
  assert.deepEqual(Buffer.from(await seek.arrayBuffer()), bytes.subarray(1000, 2000))

  const whole = await app.request(url, { headers })
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get("accept-ranges"), "bytes")
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes)

  const head = await app.request(url, { method: "HEAD", headers })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get("content-length"), "4096")
  assert.equal((await head.arrayBuffer()).byteLength, 0)

  const past = await app.request(url, { headers: { ...headers, range: "bytes=4096-" } })
  assert.equal(past.status, 416)
  assert.equal(past.headers.get("content-range"), "bytes */4096")
})

test("/_frizz/local-file serves a PDF inline, everything else as a sandboxed download, and nothing outside the roots", async () => {
  const port = 49_236
  // No thread has registered a checkout, so the readers' roots are the directory ones alone.
  const app = originTestApp(port, undefined, {}, undefined, { storage: { registeredCheckoutPaths: () => [] } as unknown as AppContext["storage"] })
  const dir = mkdtempSync(join(tmpdir(), "frizz-local-file-route-"))
  const headers = { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" }
  const get = (path: string, init: RequestInit = {}) =>
    app.request(`http://127.0.0.1:${port}/_frizz/local-file?path=${encodeURIComponent(path)}`, { headers, ...init })
  const pdfBytes = Buffer.from("%PDF-1.7\n%âã\n1 0 obj\n<<>>\nendobj\n\u0000trailer\n%%EOF\n", "latin1")
  writeFileSync(join(dir, "report (final).pdf"), pdfBytes)
  // The case the gate exists for: a document the page could RUN, if it were served as one.
  writeFileSync(join(dir, "page.html"), "<script>parent.document.title = 'owned'</script>")
  writeFileSync(join(dir, "archive.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))
  writeFileSync(join(dir, "empty.bin"), "")
  // A `.pdf` name on bytes that are not one: the PDF shape needs the CANONICAL path to be a PDF too.
  symlinkSync(join(dir, "page.html"), join(dir, "decoy.pdf"))

  const pdf = await get(join(dir, "report (final).pdf"))
  assert.equal(pdf.status, 200)
  assert.equal(pdf.headers.get("content-type"), "application/pdf")
  assert.equal(pdf.headers.get("content-disposition"), "inline; filename*=UTF-8''report%20%28final%29.pdf")
  assert.equal(pdf.headers.get("x-content-type-options"), "nosniff")
  assert.equal(pdf.headers.get("content-security-policy"), null, "a sandbox keeps Chrome's PDF viewer from loading")
  assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), pdfBytes)

  for (const name of ["page.html", "archive.zip", "decoy.pdf"]) {
    const download = await get(join(dir, name))
    assert.equal(download.status, 200, name)
    assert.equal(download.headers.get("content-type"), "application/octet-stream", name)
    assert.match(download.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''/u, name)
    assert.equal(download.headers.get("content-security-policy"), "default-src 'none'; sandbox", name)
    assert.equal(download.headers.get("x-content-type-options"), "nosniff", name)
  }

  const head = await get(join(dir, "report (final).pdf"), { method: "HEAD" })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get("content-length"), String(pdfBytes.length))
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  const empty = await get(join(dir, "empty.bin"))
  assert.equal(empty.status, 200)
  assert.equal((await empty.arrayBuffer()).byteLength, 0)

  // One answer for every refusal: gone, relative, outside home and the temp trees, and no path at all.
  for (const path of [join(dir, "gone.pdf"), "report.pdf", "/etc/hosts", ""]) {
    assert.equal((await get(path)).status, 404, path)
  }
  // And the origin gate in front of it, like every route: a cross-site page cannot pull a file.
  assert.equal((await get(join(dir, "report (final).pdf"), { headers: { host: `127.0.0.1:${port}`, origin: "https://evil.example" } })).status, 403)
})

test("/_frizz/local-visualization binds a directive basename to the owning thread session", async () => {
  const port = 49_234
  const projectDir = mkdtempSync(join(tmpdir(), "frizz-inline-vis-route-"))
  const dir = join(projectDir, ".codex", "visualizations", "2026", "07", "22", "session-a")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "spend-chart.html"), "<section>bound visualization</section>")
  const app = originTestApp(port, undefined, {}, "/tmp/origin-test-state", {
    project: {
      id: "origin-test-project",
      dir: projectDir,
      stateDir: "/tmp/origin-test-state",
      cwdSlug: "-tmp-origin-test-project",
      name: "origin-test",
      label: "local/origin-test",
    },
    storage: { getSession: (slug: string) => slug === "spend-thread" ? { session_id: "session-a" } : undefined } as AppContext["storage"],
  })
  const headers = { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" }
  const served = await app.request(`http://127.0.0.1:${port}/_frizz/local-visualization?slug=spend-thread&file=spend-chart.html`, { headers })
  assert.equal(served.status, 200)
  assert.match(served.headers.get("content-security-policy") ?? "", /default-src 'none'/)
  assert.equal(served.headers.get("x-content-type-options"), "nosniff")
  assert.match(await served.text(), /bound visualization/)

  const probe = await app.request(`http://127.0.0.1:${port}/_frizz/local-visualization?slug=spend-thread&file=spend-chart.html`, { method: "HEAD", headers })
  assert.equal(probe.status, 200)
  assert.equal(await probe.text(), "")

  const unowned = await app.request(`http://127.0.0.1:${port}/_frizz/local-visualization?slug=other&file=spend-chart.html`, { headers })
  assert.equal(unowned.status, 400)
})

test("symlink to a real image resolves and renders → 200; a dangling symlink → 404", () => {
  const { root } = fixtures()
  const outside = mkdtempSync(join(tmpdir(), "frizz-out-"))
  writeFileSync(join(outside, "real.png"), PNG)
  const link = join(root, "link.png")
  symlinkSync(join(outside, "real.png"), link)
  assert.equal(resolveLocalImage(link).status, 200) // realpath resolves to a real image → served
  const dangling = join(root, "dangling.png")
  symlinkSync(join(outside, "gone.png"), dangling)
  assert.equal(resolveLocalImage(dangling).status, 404) // realpath throws on a dangling link → clean 404
})

test("/_frizz/attach accepts the allowlist (docs, office, data, archives), rejects extensionless/unknown/oversized, and keeps the uploaded name", async () => {
  const port = 49_231
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-attach-"))
  const app = originTestApp(port, undefined, {}, stateDir)
  const b64 = (s: string) => Buffer.from(s).toString("base64")
  const attach = (body: unknown) =>
    app.request(`http://127.0.0.1:${port}/_frizz/attach`, {
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  const pathOf = async (body: unknown) => {
    const res = await attach(body)
    assert.equal(res.status, 200)
    return (await res.json() as { path: string }).path
  }

  // A document (PDF): accepted and on disk under the name it was uploaded with — spaces, dots and case
  // intact — in a folder of its own. Separator-agnostic: path.join gives `\attachments\…` on win32.
  const pdfPath = await pathOf({ name: "My Report v2.PDF", data: b64("%PDF-1.4 hello") })
  assert.match(pdfPath, /[\\/]attachments[\\/]\d+-[0-9a-f]{8}[\\/]My Report v2\.PDF$/)
  assert.equal(readFileSync(pdfPath, "utf8"), "%PDF-1.4 hello")

  // The same name twice: two paths, both still called what was uploaded, neither overwriting the other.
  const again = await pathOf({ name: "My Report v2.PDF", data: b64("second") })
  assert.notEqual(again, pdfPath)
  assert.equal(basename(again), "My Report v2.PDF")
  assert.equal(readFileSync(pdfPath, "utf8"), "%PDF-1.4 hello")

  // A macOS screenshot's narrow no-break space reads as the plain space it looks like, which is the
  // only space the transcript's path grammar takes; a newline or a backtick, which would break the
  // message line the path rides on, becomes a dash.
  assert.equal(basename(await pathOf({ name: "Screenshot 2026-10-15 at 9.41.23 AM.png", data: b64("\x89PNG") })), "Screenshot 2026-10-15 at 9.41.23 AM.png")
  assert.equal(basename(await pathOf({ name: "a`b\u0000c.md", data: b64("x") })), "a-b-c.md")

  // A client path never leaves the folder: only its last segment is kept.
  const escaped = await pathOf({ name: "../../../etc/evil.md", data: b64("x") })
  assert.equal(basename(escaped), "evil.md")
  assert.equal(basename(dirname(dirname(escaped))), "attachments")
  assert.equal(basename(await pathOf({ name: "..\\..\\.png", data: b64("x") })), "file.png")

  // A name past the filesystem's 255-byte limit is cut, keeping its extension.
  const long = basename(await pathOf({ name: `${"é".repeat(200)}.csv`, data: b64("x") }))
  assert.ok(Buffer.byteLength(long) <= 255)
  assert.match(long, /^é+\.csv$/)

  // A text/code file and an image are both allowed.
  assert.equal((await attach({ name: "notes.md", data: b64("# hi") })).status, 200)
  assert.equal((await attach({ name: "main.ts", data: b64("export {}") })).status, 200)
  assert.equal((await attach({ name: "shot.png", data: b64("\x89PNG") })).status, 200)

  // Office, data and archive formats are allowed too — a worker installs openpyxl/duckdb/unzip and
  // reads them. Refusing them only moved the conversion onto the person dropping the file.
  assert.equal((await attach({ name: "sheet.xlsx", data: b64("x") })).status, 200)
  assert.equal((await attach({ name: "doc.docx", data: b64("x") })).status, 200)
  assert.equal((await attach({ name: "deck.pptx", data: b64("x") })).status, 200)
  assert.equal((await attach({ name: "events.parquet", data: b64("x") })).status, 200)
  assert.equal((await attach({ name: "app.sqlite3", data: b64("x") })).status, 200)
  assert.equal((await attach({ name: "logs.tar.gz", data: b64("x") })).status, 200)
  assert.equal((await attach({ name: "archive.zip", data: b64("x") })).status, 200)

  // Extension-less and off-list types are still rejected — the allowlist is still an allowlist.
  assert.equal((await attach({ name: "README", data: b64("x") })).status, 400)
  assert.equal((await attach({ name: "installer.dmg", data: b64("x") })).status, 400)
  assert.equal((await attach({ name: "tool.exe", data: b64("x") })).status, 400)

  // The base64 payload cap is enforced (ATTACHMENT_MAX_BASE64_CHARS = 25_000_000).
  assert.equal((await attach({ name: "big.pdf", data: "A".repeat(25_000_001) })).status, 400)
})

// The /events board stream was the single reason a healthy Ctrl-C never finished: Hono wires
// `c.req.raw.signal` → `stream.abort()` ONLY on old Bun, so on Node the sole way to end a streaming
// handler is CANCELLING its response body. index.ts's pipeToApp therefore cancels the reader when the
// request aborts. Pin BOTH halves — the trap and the fix — so that cancel can never be "simplified"
// back into an AbortController that this handler cannot hear.
test("/_frizz/events ends when its response body is cancelled, and an aborted request signal alone does not", async () => {
  const port = 49_181
  let unsubscribed = 0
  const app = originTestApp(port, undefined, {}, "/tmp/origin-test-state", {
    bus: { subscribe: () => () => { unsubscribed++ } },
    board: { snapshotState: async () => ({ board: {}, seq: 0 }) },
  } as unknown as Partial<AppContext>)

  const controller = new AbortController()
  const res = await app.request(`http://127.0.0.1:${port}/_frizz/events`, {
    headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
    signal: controller.signal,
  })
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()
  await reader.read() // the connect keyframe

  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(unsubscribed, 0, "aborting the request signal alone leaves a hono stream running on Node")

  await reader.cancel()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(unsubscribed, 1, "cancelling the response body is what actually ends the stream")
})
