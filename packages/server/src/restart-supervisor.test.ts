import assert from "node:assert/strict"
import { createServer, request, type IncomingHttpHeaders, type RequestListener } from "node:http"
import { connect as netConnect } from "node:net"
import { once } from "node:events"
import { test } from "node:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  RestartSupervisorProxy,
  SUPERVISOR_RESTART_PATH,
  SUPERVISOR_UPDATE_RESTART_PATH,
  SUPERVISOR_STATUS_PATH,
  SUPERVISOR_ACCESS_CODE_PATH,
  SUPERVISOR_SESSIONS_PATH,
  SUPERVISOR_SIGN_OUT_PATH,
  type RestartResult,
} from "./restart-supervisor.ts"
import { fileSessionDirectory, loadOrCreateSessionKey, readSessionEpoch, rotateSessionKey, SESSION_EPOCH } from "./access-codes.ts"
import { signOutOlderSessionEpoch } from "./session-epoch-child.ts"
import { CALLER_HEADER, decodeCallerStamp, encodeCallerStamp } from "./audit.ts"

async function listen(handler: RequestListener) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    server,
    port: address.port,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, "close")
    },
  }
}

async function get(port: number, path: string, method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: { origin: `http://127.0.0.1:${port}` },
    }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => { body += chunk })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.once("error", reject)
    req.end()
  })
}

async function getBytes(port: number, path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers, method }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => { chunks.push(chunk) })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.once("error", reject)
    req.end()
  })
}

async function child(label: string) {
  return listen((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`${label}:${req.url}`)
  })
}

test("public restart supervisor preserves routes, does not restart initial/subresource requests, and recovers a dead child", async () => {
  let current = await child("one")
  let restarts = 0
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: async (): Promise<RestartResult> => {
      restarts++
      await current.close().catch(() => undefined)
      current = await child(`generation-${restarts + 1}`)
      return { state: "ready" }
    },
  })
  try {
    await proxy.listen()
    assert.equal((await get(port, "/thread/demo?tab=terminal")).body, "one:/thread/demo?tab=terminal")
    assert.equal((await get(port, "/assets/app.css")).body, "one:/assets/app.css")
    assert.equal(restarts, 0, "ordinary initial and subresource requests never restart Frizz")

    assert.equal((await get(port, SUPERVISOR_RESTART_PATH, "POST")).status, 202)
    assert.equal((await get(port, "/thread/demo?tab=terminal")).body, "generation-2:/thread/demo?tab=terminal")

    // Simulate a crash that leaves the durable proxy still bound. Restart remains available without
    // talking to the dead child first.
    await current.close()
    assert.equal((await get(port, SUPERVISOR_RESTART_PATH, "POST")).status, 202)
    assert.equal((await get(port, "/thread/demo?tab=terminal")).body, "generation-3:/thread/demo?tab=terminal")
    assert.equal(restarts, 2)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("public supervisor serves local images without entering or requiring the disposable child", async () => {
  const image = Buffer.from("89504e470d0a1a0a", "hex")
  const imageDir = mkdtempSync(join(tmpdir(), "frizz-supervisor-image-"))
  const imagePath = join(imageDir, "handoff.png")
  writeFileSync(imagePath, image)

  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => undefined,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    const path = `/_frizz/local-image?path=${encodeURIComponent(imagePath)}`
    const served = await getBytes(port, path, { "sec-fetch-site": "same-origin" })
    assert.equal(served.status, 200)
    assert.equal(served.headers["content-type"], "image/png")
    assert.equal(served.headers["cache-control"], "private, max-age=60")
    assert.deepEqual(served.body, image)

    const head = await getBytes(port, path, { "sec-fetch-site": "same-origin" }, "HEAD")
    assert.equal(head.status, 200)
    assert.equal(head.headers["content-length"], String(image.length))
    assert.equal(head.body.length, 0)

    const cors = await getBytes(port, path, { origin: `http://127.0.0.1:${port}` })
    assert.equal(cors.status, 200)
    assert.equal(cors.headers["access-control-allow-origin"], `http://127.0.0.1:${port}`)

    assert.equal((await getBytes(port, path)).status, 403, "missing browser authority stays forbidden")
    assert.equal((await getBytes(port, path, { origin: "http://attacker.invalid" })).status, 403)
    assert.equal((await get(port, "/ordinary-route")).status, 503, "only local images bypass an unavailable child")

    // A lightbox video keeps playing through a restart: the supervisor answers its byte ranges too.
    const videoPath = join(imageDir, "flow.webm")
    const video = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 241))
    writeFileSync(videoPath, video)
    const videoUrl = `/_frizz/local-image?path=${encodeURIComponent(videoPath)}`
    const range = await getBytes(port, videoUrl, { "sec-fetch-site": "same-origin", range: "bytes=1024-1535" })
    assert.equal(range.status, 206)
    assert.equal(range.headers["content-type"], "video/webm")
    assert.equal(range.headers["content-range"], "bytes 1024-1535/2048")
    assert.equal(range.headers["accept-ranges"], "bytes")
    assert.deepEqual(range.body, video.subarray(1024, 1536))
    const past = await getBytes(port, videoUrl, { "sec-fetch-site": "same-origin", range: "bytes=2048-" })
    assert.equal(past.status, 416)
    assert.equal(past.headers["content-range"], "bytes */2048")
  } finally {
    await proxy.close().catch(() => undefined)
  }
})

test("repeat restart clicks coalesce and status is served by the public owner", async () => {
  const current = await child("one")
  let calls = 0
  let release!: (result: RestartResult) => void
  const waiting = new Promise<RestartResult>((resolve) => { release = resolve })
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: () => { calls++; return waiting },
  })
  try {
    await proxy.listen()
    const first = get(port, SUPERVISOR_RESTART_PATH, "POST")
    const second = get(port, SUPERVISOR_RESTART_PATH, "POST")
    await eventually(() => calls === 1 ? calls : undefined, "the one coalesced restart action")
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /restarting/)
    release({ state: "ready" })
    assert.deepEqual((await Promise.all([first, second])).map((response) => response.status), [202, 202])
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("public supervisor fails closed on a forbidden restart or occupied public port", async () => {
  const current = await child("one")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({ port, childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await proxy.listen()
    const denied = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: SUPERVISOR_RESTART_PATH, method: "POST" }, (res) => resolve(res.statusCode ?? 0))
      req.once("error", reject)
      req.end()
    })
    assert.equal(denied, 403)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }

  const blocker = await listen((_req, res) => res.end())
  const occupied = new RestartSupervisorProxy({ port: blocker.port, childPort: () => undefined, restart: async () => ({ state: "ready" }) })
  await assert.rejects(occupied.listen())
  await blocker.close()
})

test("update-and-restart is explicit and never falls through to an ordinary restart", async () => {
  const current = await child("one")
  const port = await freePort()
  let ordinary = 0
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: async () => { ordinary++; return { state: "ready" } },
  })
  try {
    await proxy.listen()
    const response = await get(port, SUPERVISOR_UPDATE_RESTART_PATH, "POST")
    assert.equal(response.status, 409)
    assert.match(response.body, /immutable Frizz artifact/)
    assert.equal(ordinary, 0)
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /"updateRestart":false/)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("status advertises Update & Restart only when the durable supervisor owns that capability", async () => {
  const current = await child("one")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
    updateRestart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /"updateRestart":true/)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

// The launcher is the ONLY thing that can answer "is this a development build". The client used to
// guess with `import.meta.env.DEV`, which is false in every artifact frizz-dev builds — so the dev-only
// Restart-worker verb was compiled out of the build its author ran all day. Absent must keep meaning
// "no", so a published Frizz never grows a dev affordance.
test("status reports a development build only when the launcher says so", async () => {
  for (const [name, dev, expected] of [
    ["frizz-dev / pnpm dev", true, /"dev":true/],
    ["the published frizz bin", undefined, /^(?!.*"dev")/s],
  ] as [string, boolean | undefined, RegExp][]) {
    const current = await child(`dev-${String(dev)}`)
    const port = await freePort()
    const proxy = new RestartSupervisorProxy({
      port,
      childPort: () => current.port,
      restart: async () => ({ state: "ready" }),
      ...(dev === undefined ? {} : { dev }),
    })
    try {
      await proxy.listen()
      assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, expected, name)
    } finally {
      await proxy.close().catch(() => undefined)
      await current.close().catch(() => undefined)
    }
  }
})

// Only the registry launcher can name versions, so the fields ride the same launcher-only contract as
// `updateAvailable`: absent for frizz-dev and legacy supervisors, and `updateVersion` absent until the
// registry probe has actually observed something newer.
test("status names the running and newer versions only when the launcher supplies them", async () => {
  const current = await child("versioned")
  const port = await freePort()
  let observed: string | undefined
  let running = "0.4.2"
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
    version: () => running,
    launcherVersion: "0.4.0",
    updateVersion: () => observed,
  })
  const barePort = await freePort()
  const bare = new RestartSupervisorProxy({
    port: barePort,
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    await bare.listen()
    const before = (await get(port, SUPERVISOR_STATUS_PATH)).body
    assert.match(before, /"version":"0\.4\.2"/)
    assert.match(before, /"launcherVersion":"0\.4\.0"/)
    assert.doesNotMatch(before, /"updateVersion"/, "no observed newer version yet")
    observed = "0.5.0"
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /"updateVersion":"0\.5\.0"/)
    running = "0.4.3"
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /"version":"0\.4\.3"/, "a child-only commit can update the running version without replacing the listener")
    const versionless = (await get(barePort, SUPERVISOR_STATUS_PATH)).body
    assert.doesNotMatch(versionless, /"version"|"launcherVersion"|"updateVersion"/, "frizz-dev/legacy stays byte-identical")
  } finally {
    await proxy.close().catch(() => undefined)
    await bare.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

// Changed deliberately (audit 2026-09-11, finding 6). This test used to pin "restarting" for the whole
// update, prepare phase included — which put every open tab behind the blocking overlay for the entire
// npm install, while the old child underneath was healthy and serving. The 202 acknowledgement still
// says "restarting"; /status now reports what the OWNER's delegate reports, and stamps its "ready" as
// `preparing` (additive, absent otherwise) until the delegate itself says the drain has begun.
test("update acknowledgement is accepted, but status follows the owner delegate through prepare and drain", async () => {
  const current = await child("old-but-still-serving")
  const port = await freePort()
  let release!: (result: RestartResult) => void
  const building = new Promise<RestartResult>((resolve) => { release = resolve })
  let delegated: { state: "ready" | "restarting"; artifactDigest?: string } = { state: "ready", artifactDigest: "old-artifact" }
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    // The disposable child serves requests while the durable owner prepares its successor artifact.
    status: () => delegated,
    restart: async () => ({ state: "ready" }),
    updateRestart: () => building,
  })
  try {
    await proxy.listen()
    const update = await get(port, SUPERVISOR_UPDATE_RESTART_PATH, "POST")
    assert.equal(update.status, 202)
    assert.match(update.body, /"state":"restarting"/)
    const preparing = JSON.parse((await get(port, SUPERVISOR_STATUS_PATH)).body)
    assert.equal(preparing.state, "ready", "the old child is untouched while the candidate is prepared")
    assert.equal(preparing.preparing, true)
    assert.equal(preparing.artifactDigest, "old-artifact")
    assert.equal((await get(port, "/still-live")).body, "old-but-still-serving:/still-live")
    // The owner starts draining: its delegate says so, and the stamp leaves with the "ready" it qualified.
    delegated = { state: "restarting" }
    const draining = JSON.parse((await get(port, SUPERVISOR_STATUS_PATH)).body)
    assert.equal(draining.state, "restarting")
    assert.equal("preparing" in draining, false)
    delegated = { state: "ready", artifactDigest: "new-artifact" }
    release({ state: "ready" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const settled = JSON.parse((await get(port, SUPERVISOR_STATUS_PATH)).body)
    assert.equal(settled.state, "ready")
    assert.equal("preparing" in settled, false, "the stamp is an in-flight qualifier, not a state")
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

// A RESTART drains the child the moment it is accepted, and a proxy with no owner delegate has nothing
// truer to say than the transition it acknowledged: both report "restarting" for the whole action,
// exactly as before, however long the delegate's stale "ready" lingers.
test("a plain restart, and an update with no owner delegate, report restarting throughout", async () => {
  const current = await child("draining")
  const restartPort = await freePort()
  const updatePort = await freePort()
  let releaseRestart!: (result: RestartResult) => void
  let releaseUpdate!: (result: RestartResult) => void
  const restarting = new RestartSupervisorProxy({
    port: restartPort,
    childPort: () => current.port,
    status: () => ({ state: "ready", artifactDigest: "stale" }),
    restart: () => new Promise<RestartResult>((resolve) => { releaseRestart = resolve }),
  })
  const updating = new RestartSupervisorProxy({
    port: updatePort,
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
    updateRestart: () => new Promise<RestartResult>((resolve) => { releaseUpdate = resolve }),
  })
  try {
    await restarting.listen()
    await updating.listen()
    const restart = get(restartPort, SUPERVISOR_RESTART_PATH, "POST")
    await new Promise((resolve) => setTimeout(resolve, 20))
    const midRestart = JSON.parse((await get(restartPort, SUPERVISOR_STATUS_PATH)).body)
    assert.equal(midRestart.state, "restarting", "the delegate's lingering ready never leaks through a restart")
    assert.equal("preparing" in midRestart, false)
    releaseRestart({ state: "ready" })
    assert.equal((await restart).status, 202)

    assert.equal((await get(updatePort, SUPERVISOR_UPDATE_RESTART_PATH, "POST")).status, 202)
    const midUpdate = JSON.parse((await get(updatePort, SUPERVISOR_STATUS_PATH)).body)
    assert.equal(midUpdate.state, "restarting", "no delegate: the acknowledged transition is all the proxy knows")
    assert.equal("preparing" in midUpdate, false)
    releaseUpdate({ state: "ready" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.match((await get(updatePort, SUPERVISOR_STATUS_PATH)).body, /"state":"ready"/)
  } finally {
    await restarting.close().catch(() => undefined)
    await updating.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

/** Reach the proxy with an arbitrary Host/Origin pair, the way a foreign browser would. */
async function proxied(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; body: string; headers?: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => { body += chunk })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.once("error", reject)
    req.end()
  })
}

test("the proxy refuses a foreign Origin instead of laundering it into the child's same-origin", async () => {
  // proxyHeaders REWRITES Host and Origin to the child's private loopback authority, so the child's
  // own gate sees a perfect same-origin request no matter who sent it. Without this check, any page
  // in any browser on this machine could drive the whole control plane.
  const current = await child("only")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({ port, childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await proxy.listen()
    const host = `127.0.0.1:${port}`
    assert.equal((await proxied(port, "/_frizz/rpc/x", { host, origin: `http://127.0.0.1:${port}` }, "POST")).status, 200)
    // A same-origin GET may legitimately omit Origin; the child still applies its own per-route rule.
    assert.equal((await proxied(port, "/assets/app.css", { host })).status, 200)
    for (const origin of ["http://evil.example", `http://localhost.evil:${port}`, `http://127.0.0.1:${port + 1}`]) {
      assert.equal((await proxied(port, "/_frizz/rpc/x", { host, origin }, "POST")).status, 403, origin)
    }
    // A Host naming somebody else is refused too, which is what stops DNS rebinding.
    assert.equal((await proxied(port, "/_frizz/rpc/x", { host: `frizz.evil:${port}` }, "POST")).status, 403)
    // ...and wordlessly: a loopback-only board has no operator arriving by name, only probes.
    assert.equal((await proxied(port, "/", { host: `frizz.evil:${port}` })).body, "Forbidden")
    assert.equal((await proxied(port, "/_frizz/rpc/x", { host, "x-forwarded-host": "evil.example" }, "POST")).status, 403)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("--host: a non-loopback bind accepts IP-literal authorities, and loopback still does not", async () => {
  const current = await child("only")
  const port = await freePort()
  // Bound to the wildcard so the test can still reach it over 127.0.0.1 while the POLICY is exposed.
  const proxy = new RestartSupervisorProxy({
    port,
    host: "0.0.0.0",
    allowedHosts: ["frizz.local"],
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    for (const authority of [`192.168.1.5:${port}`, `10.0.0.4:${port}`, `frizz.local:${port}`, `127.0.0.1:${port}`]) {
      const status = (await proxied(port, "/_frizz/rpc/x", { host: authority, origin: `http://${authority}` }, "POST")).status
      assert.equal(status, 200, authority)
    }
    // Exposure widens WHICH authority is legitimate, never the Origin-must-match-Host rule itself.
    assert.equal((await proxied(port, "/_frizz/rpc/x", { host: `192.168.1.5:${port}`, origin: "http://evil.example" }, "POST")).status, 403)
    assert.equal((await proxied(port, "/_frizz/rpc/x", { host: `evil.example:${port}` }, "POST")).status, 403)
    // Opening the board by an unlisted name is refused WITH the flag that would allow it — a bare
    // "Forbidden" sent the operator back to the IP and a guess ("it seems to filter by hostname?").
    const byName = await proxied(port, "/", { host: `pupper:${port}` })
    assert.equal(byName.status, 403)
    assert.match(byName.headers?.["content-type"] ?? "", /text\/html/)
    assert.match(byName.body, /--allowed-host pupper/)
    assert.match(byName.body, /FRIZZ_ALLOWED_HOSTS=pupper/)
    // The name is echoed only when it parsed as a host — a port alias is a trick, not a typo.
    assert.equal((await proxied(port, "/", { host: `pupper:${port + 1}` })).body, "Forbidden")
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("an exposed board supplies the Sec-Fetch stamp a LAN browser cannot send", async () => {
  // Chrome sends Sec-Fetch-* only to a potentially-trustworthy origin, which http://192.168.1.5 is
  // not. Frizz's missing-Origin rules ask for `sec-fetch-site: same-origin`, so without the proxy
  // vouching, --host served the shell and then 403'd every /rpc read the app made. Measured in
  // Chrome 151: the LAN request carried neither an origin nor a sec-fetch-site header.
  const seen: Array<Record<string, string | string[] | undefined>> = []
  const current = await listen((req, res) => {
    seen.push(req.headers)
    res.writeHead(200)
    res.end("ok")
  })
  const port = await freePort()
  const exposed = new RestartSupervisorProxy({ port, host: "0.0.0.0", childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await exposed.listen()
    assert.equal((await proxied(port, "/_frizz/rpc/board", { host: `192.168.1.5:${port}` })).status, 200)
    assert.equal(seen.at(-1)?.["sec-fetch-site"], "same-origin", "a LAN read is vouched for")

    // Loopback is untouched even on an exposed board: the browser really can stamp that one, so the
    // real signal is forwarded and its absence stays meaningful.
    await proxied(port, "/_frizz/rpc/board", { host: `127.0.0.1:${port}` })
    assert.equal(seen.at(-1)?.["sec-fetch-site"], undefined, "loopback keeps the browser's own signal")

    // A stamp the caller supplied is never overwritten, in either direction.
    await proxied(port, "/_frizz/rpc/board", { host: `192.168.1.5:${port}`, "sec-fetch-site": "cross-site" })
    assert.equal(seen.at(-1)?.["sec-fetch-site"], "cross-site", "a declared cross-site request stays cross-site")

    // Vouching is for the Origin-LESS case only; a present Origin still has to match, and did.
    await proxied(port, "/_frizz/rpc/board", { host: `192.168.1.5:${port}`, origin: `http://192.168.1.5:${port}` })
    assert.equal(seen.at(-1)?.["sec-fetch-site"], undefined)
  } finally {
    await exposed.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("a loopback-bound proxy never vouches, so its missing-Origin posture is exactly as before", async () => {
  const seen: Array<Record<string, string | string[] | undefined>> = []
  const current = await listen((req, res) => {
    seen.push(req.headers)
    res.writeHead(200)
    res.end("ok")
  })
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({ port, childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await proxy.listen()
    await proxied(port, "/_frizz/rpc/board", { host: `127.0.0.1:${port}` })
    assert.equal(seen.at(-1)?.["sec-fetch-site"], undefined, "the default posture invents no signal")
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("a loopback-bound proxy rejects the LAN authority an exposed one would accept", async () => {
  const current = await child("only")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({ port, childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await proxy.listen()
    assert.equal((await proxied(port, "/_frizz/rpc/x", { host: `192.168.1.5:${port}` }, "POST")).status, 403)
    assert.equal((await proxied(port, "/_frizz/rpc/x", { host: `frizz.local:${port}` }, "POST")).status, 403)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

/** Send a raw WebSocket handshake and report whether the proxy forwarded it or hung up. */
async function upgrade(port: number, headers: Record<string, string>): Promise<"forwarded" | "refused"> {
  const socket = netConnect(port, "127.0.0.1")
  await once(socket, "connect")
  const lines = [
    "GET /ws HTTP/1.1",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "upgrade: websocket",
    "connection: Upgrade",
    "sec-websocket-version: 13",
    "sec-websocket-key: AQIDBAUGBwgJCgsMDQ4PEC==",
  ]
  socket.write(`${lines.join("\r\n")}\r\n\r\n`)
  try {
    let received = ""
    socket.setEncoding("utf8")
    const done = new Promise<"forwarded" | "refused">((resolve) => {
      socket.on("data", (chunk: string) => {
        received += chunk
        if (received.includes("\r\n\r\n")) resolve("forwarded")
      })
      socket.on("close", () => resolve(received.includes("\r\n\r\n") ? "forwarded" : "refused"))
      socket.on("error", () => resolve("refused"))
      // A gate that neither answers nor hangs up is its own failure. Bound it so a regression here
      // reports as a failed assertion instead of wedging the whole suite.
      setTimeout(() => resolve("refused"), 2_000).unref()
    })
    return await done
  } finally {
    socket.destroy()
  }
}

test("a WebSocket upgrade is gated at the proxy, where a browser Origin is mandatory", async () => {
  // The child requires an Origin on every upgrade, but proxyHeaders manufactures one, so the child
  // can never enforce that itself. The terminal socket is the most privileged surface Frizz has.
  const upstream = await listen((_req, res) => res.end())
  // An upgraded socket is DETACHED from the http server, so closeAllConnections() cannot reach it and
  // the server never emits 'close'. Hold them here and destroy them explicitly, or teardown hangs.
  const upgraded: import("node:stream").Duplex[] = []
  upstream.server.on("upgrade", (_req, socket) => {
    upgraded.push(socket)
    socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n")
  })
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    host: "0.0.0.0",
    childPort: () => upstream.port,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    assert.equal(await upgrade(port, { host: `192.168.1.5:${port}`, origin: `http://192.168.1.5:${port}` }), "forwarded")
    assert.equal(await upgrade(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }), "forwarded")
    assert.equal(await upgrade(port, { host: `192.168.1.5:${port}` }), "refused", "no Origin")
    assert.equal(await upgrade(port, { host: `192.168.1.5:${port}`, origin: "http://evil.example" }), "refused")
    assert.equal(await upgrade(port, { host: `evil.example:${port}`, origin: `http://evil.example:${port}` }), "refused")

    // Regression: an upgraded socket is detached from the http server, so closeAllConnections() never
    // reaches it and close() waited on it forever. Frizz always has live WebSockets once a browser is
    // open, so this hung every shutdown that followed a real page load.
    await assert.doesNotReject(
      Promise.race([
        proxy.close(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("proxy.close() hung on a live upgrade")), 3_000).unref()),
      ]),
    )
  } finally {
    await proxy.close().catch(() => undefined)
    for (const socket of upgraded) socket.destroy()
    await upstream.close().catch(() => undefined)
  }
})

async function freePort(): Promise<number> {
  const listener = await listen((_req, res) => res.end())
  const port = listener.port
  await listener.close()
  return port
}

async function eventually<T>(probe: () => T | undefined, description: string, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${description}`)
}

test("--public-origin: a tunnelled request is accepted and reaches the child with no forwarded claims", async () => {
  // The child keeps the strict loopback policy and refuses `x-forwarded-*` outright — it has to, since
  // proxyHeaders has already erased who really called. So the proxy must not just ACCEPT the tunnel's
  // request, it must strip the tunnel's headers on the way through, or every request 403s at the child.
  const seen: Array<Record<string, string | string[] | undefined>> = []
  const current = await listen((req, res) => {
    seen.push(req.headers)
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("child")
  })
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    publicOrigin: "https://frizz.example.com",
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    // This test is about HEADER STRIPPING, not auth, so it redeems a real code for the session cookie
    // that gets past the gate. A public origin with no credential is 401 — see the bearer-gate test below.
    const minted = proxy.issueAccessCode()!
    const exchanged = await proxied(port, `/?frizz_code=${minted.code}`, { host: "frizz.example.com", origin: "https://frizz.example.com" })
    const session = String(exchanged.headers?.["set-cookie"]).split(";")[0]!
    // Exactly what cloudflared sends: the browser's Host and Origin verbatim, plus its own forwarding.
    // `x-forwarded-host` is Tailscale Serve's addition rather than cloudflared's — both are supported
    // fronts, so the accepted shape covers the union rather than one vendor's subset.
    const tunnelled = {
      host: "frizz.example.com",
      origin: "https://frizz.example.com",
      "x-forwarded-for": "203.0.113.7",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "frizz.example.com",
      "sec-fetch-site": "same-origin",
      cookie: session,
    }
    assert.equal((await proxied(port, "/_frizz/rpc/x", tunnelled, "POST")).status, 200)
    const forwarded = seen.at(-1)!
    assert.equal(forwarded.host, `127.0.0.1:${current.port}`)
    assert.equal(forwarded.origin, `http://127.0.0.1:${current.port}`)
    for (const name of ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "forwarded"]) {
      assert.equal(forwarded[name], undefined, name)
    }
    // The board's own socket comes through the same gate.
    assert.equal(await upgrade(port, tunnelled), "forwarded")

    // The widening is exactly one origin wide. A neighbouring name, a scheme downgrade, and the
    // loopback caller trying to borrow the tunnel's forwarding licence are all still refused.
    assert.equal((await proxied(port, "/_frizz/rpc/x", { ...tunnelled, host: "frizz.example.com.evil", origin: "https://frizz.example.com.evil" }, "POST")).status, 403)
    assert.equal((await proxied(port, "/_frizz/rpc/x", { ...tunnelled, origin: "http://frizz.example.com" }, "POST")).status, 403)
    assert.equal(
      (await proxied(port, "/_frizz/rpc/x", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "x-forwarded-for": "203.0.113.7" }, "POST")).status,
      403,
    )
    // The operator's own tab on the box keeps working while a tunnel is declared.
    assert.equal((await proxied(port, "/_frizz/rpc/x", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }, "POST")).status, 200)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

/**
 * The upgrade's real outcome: the HTTP status the proxy answered with, or "refused" if it hung up
 * without one. `upgrade()` above only asks "did any bytes come back", which cannot tell a 101 from
 * a 401 — and the bearer gate answers 401 rather than destroying the socket, so it needs this.
 */
async function upgradeStatus(port: number, headers: Record<string, string>): Promise<string> {
  const socket = netConnect(port, "127.0.0.1")
  await once(socket, "connect")
  const lines = [
    "GET /ws HTTP/1.1",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "upgrade: websocket",
    "connection: Upgrade",
    "sec-websocket-version: 13",
    "sec-websocket-key: AQIDBAUGBwgJCgsMDQ4PEC==",
  ]
  socket.write(`${lines.join("\r\n")}\r\n\r\n`)
  try {
    let received = ""
    socket.setEncoding("utf8")
    return await new Promise<string>((resolve) => {
      socket.on("data", (chunk: string) => {
        received += chunk
        const match = /^HTTP\/1\.1 (\d{3})/.exec(received)
        if (match) resolve(match[1]!)
      })
      socket.on("close", () => resolve(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? "refused"))
      socket.on("error", () => resolve("refused"))
      setTimeout(() => resolve("timeout"), 2_000).unref()
    })
  } finally {
    socket.destroy()
  }
}

test("--public-origin without a session is not a reachable state: the gate covers page and socket", async () => {
  // Frizz has no accounts, so on a tunnelled board a session minted from a single-use code IS the
  // authorization. What must hold: loopback is never challenged, the public origin always is, and the
  // board socket is gated too — a shell reachable over ws:// without a session would make the page
  // gate theatre.
  const current = await child("only")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    publicOrigin: "https://colin.frizz.sh",
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    const publicHeaders = { host: "colin.frizz.sh", origin: "https://colin.frizz.sh" }

    // No session at all: refused, and the page must not advertise what lives here.
    const bare = await proxied(port, "/", publicHeaders)
    assert.equal(bare.status, 401)
    assert.ok(!/frizz|board|agent/i.test(bare.body), `401 page leaked product identity: ${bare.body.slice(0, 120)}`)

    // The one-time link is traded for a session cookie and bounced to a URL without the secret in it,
    // so it never lands in history, a Referer, or a screenshot.
    const minted = proxy.issueAccessCode()!
    const exchange = await proxied(port, `/thread/abc?frizz_code=${minted.code}`, publicHeaders)
    assert.equal(exchange.status, 302)
    assert.equal(exchange.headers?.location, "/thread/abc")
    assert.match(String(exchange.headers?.["set-cookie"]), /__Host-frizz_session=/)
    assert.match(String(exchange.headers?.["set-cookie"]), /HttpOnly/)
    const session = String(exchange.headers?.["set-cookie"]).split(";")[0]!

    // The cookie the exchange set is accepted.
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: session })).status, 200)

    // A tampered session of the SAME LENGTH is refused — the signature, not the shape, is the proof.
    const flipped = session.slice(0, -1) + (session.endsWith("a") ? "b" : "a")
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: flipped })).status, 401)
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: "__Host-frizz_session=short" })).status, 401)

    // The board socket and every terminal ride this gate too.
    assert.equal(await upgradeStatus(port, publicHeaders), "401")
    assert.equal(await upgrade(port, { ...publicHeaders, cookie: session }), "forwarded")

    // Loopback is NEVER challenged — the operator's own tab on the box keeps working untouched.
    const loopback = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }
    assert.equal((await proxied(port, "/", loopback)).status, 200)
    assert.equal(await upgrade(port, loopback), "forwarded")
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("the proxy tells the child who called: loopback or public, and which session — never the cookie", async () => {
  // The child sees every request as loopback once Host and Origin are rewritten, so the audit trail
  // (audit.ts) can only attribute an action through what this proxy stamps. A relayed request arrives
  // here from loopback too, so the stamp must key on the authority, not the socket.
  const seen: (string | undefined)[] = []
  const current = await listen((req, res) => {
    seen.push(req.headers[CALLER_HEADER] as string | undefined)
    res.end("ok")
  })
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    publicOrigin: "https://colin.frizz.sh",
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    const loopback = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }
    const forged = encodeCallerStamp({ via: "loopback", remote: "127.0.0.1", session: "forged" })

    // The operator's own tab; a stamp the CLIENT sent is replaced, never forwarded.
    assert.equal((await proxied(port, "/", { ...loopback, [CALLER_HEADER]: forged })).status, 200)
    assert.deepEqual(decodeCallerStamp(seen.at(-1)), { via: "loopback", remote: "127.0.0.1", session: null })

    const publicHeaders = { host: "colin.frizz.sh", origin: "https://colin.frizz.sh" }
    const exchange = await proxied(port, `/?frizz_code=${proxy.issueAccessCode()!.code}`, publicHeaders)
    const cookie = String(exchange.headers?.["set-cookie"]).split(";")[0]!
    const sessions = JSON.parse((await proxied(port, SUPERVISOR_SESSIONS_PATH, loopback)).body) as { sessions: { id: string }[] }
    const id = sessions.sessions[0]!.id

    // A relayed visitor: the public authority, the device's session RECORD id, the relay's claimed
    // client address — and a forged stamp of its own, which does not survive.
    const relayed = { ...publicHeaders, cookie, "cf-connecting-ip": "203.0.113.9", [CALLER_HEADER]: forged }
    assert.equal((await proxied(port, "/_frizz/rpc/projectsList", relayed)).status, 200)
    const stamp = decodeCallerStamp(seen.at(-1))
    assert.deepEqual(stamp, { via: "public", remote: "127.0.0.1", host: "colin.frizz.sh", clientIp: "203.0.113.9", session: id })
    const raw = Buffer.from(seen.at(-1)!, "base64url").toString("utf8")
    assert.ok(!raw.includes(cookie.slice("__Host-frizz_session=".length)), "the session value never leaves the proxy")
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("an access code is spent once over HTTP: it mints a session, then stops working", async () => {
  // The end-to-end shape of the whole feature. The unit tests prove the store is single-use; this
  // proves the PROXY actually funnels through it, mints a session cookie, and does not keep honouring
  // the spent code just because it is still sitting in someone's URL bar.
  const current = await child("only")
  const port = await freePort()
  let consumed = 0
  const proxy = new RestartSupervisorProxy({
    port,
    publicOrigin: "https://colin.frizz.sh",
    onCodeConsumed: () => { consumed++ },
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    const publicHeaders = { host: "colin.frizz.sh", origin: "https://colin.frizz.sh" }
    const code = proxy.issueAccessCode()
    assert.ok(code, "a declared public origin can mint codes")
    assert.equal(proxy.accessUrl(code.code), `https://colin.frizz.sh/?frizz_code=${code.code}`)

    // No credential at all.
    assert.equal((await proxied(port, "/", publicHeaders)).status, 401)

    // Spending the code redirects, strips the secret from the URL, and hands back a session.
    const spent = await proxied(port, `/thread/x?frizz_code=${code.code}`, publicHeaders)
    assert.equal(spent.status, 302)
    assert.equal(spent.headers?.location, "/thread/x", "the code is stripped from the redirect target")
    const setCookie = String(spent.headers?.["set-cookie"])
    assert.match(setCookie, /__Host-frizz_session=/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Lax/)
    assert.equal(consumed, 1, "consumption fires once, so a launcher can repaint the QR")

    // That session works.
    const session = /__Host-frizz_session=([^;]+)/.exec(setCookie)![1]!
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: `__Host-frizz_session=${session}` })).status, 200)
    assert.equal(await upgrade(port, { ...publicHeaders, cookie: `__Host-frizz_session=${session}` }), "forwarded")

    // The code does NOT. This is the property the standing secret never had.
    const replay = await proxied(port, `/?frizz_code=${code.code}`, publicHeaders)
    assert.equal(replay.status, 401)
    assert.match(replay.body, /already been used/, "says WHICH failure, so the operator knows to reissue")
    assert.equal(consumed, 1, "a refused replay does not fire consumption again")

    // A code that was never issued is refused without disclosing anything.
    const bogus = await proxied(port, "/?frizz_code=neverissued", publicHeaders)
    assert.equal(bogus.status, 401)
    assert.doesNotMatch(bogus.body, /frizz|board|agent/i, "the 401 page still names nothing")

    // Loopback remains completely ungated.
    assert.equal((await proxied(port, "/", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).status, 200)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("--link mints from loopback only: a tunnelled session cannot hand out further links", async () => {
  // The escalation this prevents: minting is how a NEW device gets in, so anyone who could mint from
  // the tunnel could turn one shared link into unlimited further links for people who were never let
  // in. Presence on the machine is the requirement, and a session is not presence.
  const current = await child("only")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    publicOrigin: "https://colin.frizz.sh",
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    const loopback = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }

    const minted = await proxied(port, SUPERVISOR_ACCESS_CODE_PATH, loopback, "POST")
    assert.equal(minted.status, 200)
    const { url } = JSON.parse(minted.body) as { url: string }
    assert.match(url, /^https:\/\/colin\.frizz\.sh\/\?frizz_code=/)

    // And the link it hands back actually works, which is the only thing that makes --link useful.
    const code = new URL(url).searchParams.get("frizz_code")!
    const redeemed = await proxied(port, `/?frizz_code=${code}`, { host: "colin.frizz.sh", origin: "https://colin.frizz.sh" })
    assert.equal(redeemed.status, 302)

    // From the tunnel: refused outright, session or no session.
    const publicHeaders = { host: "colin.frizz.sh", origin: "https://colin.frizz.sh" }
    const session = /__Host-frizz_session=([^;]+)/.exec(String(redeemed.headers?.["set-cookie"]))![1]!
    // With no session the control plane's session gate answers first (see the control-plane gate test).
    assert.equal((await proxied(port, SUPERVISOR_ACCESS_CODE_PATH, publicHeaders, "POST")).status, 401)
    assert.equal(
      (await proxied(port, SUPERVISOR_ACCESS_CODE_PATH, { ...publicHeaders, cookie: `__Host-frizz_session=${session}` }, "POST")).status,
      403,
      "even a VALID session may not mint",
    )

    // GET is not a minting verb; minting has a side effect.
    assert.equal((await proxied(port, SUPERVISOR_ACCESS_CODE_PATH, loopback)).status, 405)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("--link on a board with no public origin says so instead of minting a useless code", async () => {
  const current = await child("only")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({ port, childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await proxy.listen()
    const res = await proxied(port, SUPERVISOR_ACCESS_CODE_PATH, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }, "POST")
    assert.equal(res.status, 409)
    assert.match(res.body, /no public origin/)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("setPublicOrigin flips the gate on a running board, and clearing it flips it back", async () => {
  // The R pane changes how a board is reached WITHOUT restarting it, so the proxy has to re-judge
  // every later request by the new origin: a name that was refused as a stranger becomes the gated
  // public front, and clearing the origin makes it a stranger again while loopback never notices.
  const current = await child("only")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({ port, childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await proxy.listen()
    const publicHeaders = { host: "colin.frizz.sh", origin: "https://colin.frizz.sh" }
    const loopback = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }
    assert.equal(proxy.issueAccessCode(), null)
    assert.equal((await proxied(port, "/", publicHeaders)).status, 403)

    proxy.setPublicOrigin("https://colin.frizz.sh")
    assert.equal((await proxied(port, "/", publicHeaders)).status, 401)
    const minted = proxy.issueAccessCode()
    assert.ok(minted)
    const exchange = await proxied(port, `/?frizz_code=${minted.code}`, publicHeaders)
    assert.equal(exchange.status, 302)
    const session = String(exchange.headers?.["set-cookie"]).split(";")[0]!
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: session })).status, 200)
    assert.equal((await proxied(port, "/", loopback)).status, 200)

    proxy.setPublicOrigin(undefined)
    assert.equal(proxy.issueAccessCode(), null)
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: session })).status, 403)
    assert.equal((await proxied(port, "/", loopback)).status, 200)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close()
  }
})

test("sign out this device: a tunnelled session ends ITSELF, persisted, and can reach no other device", async () => {
  // The phone's Settings row. It is the one session-ending verb the tunnel may reach, and only because
  // it can end nothing but the credential on the request making it. What must hold: the caller's own id
  // lands on the SAME directory `--sign-out` writes (so a restart remembers it), the cookie is cleared,
  // the very next request with that cookie is refused, a body naming another id is ignored, and the
  // loopback-only rule for signing out OTHER devices is exactly as strict as before.
  const current = await child("only")
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), "frizz-sign-out-"))
  const proxy = new RestartSupervisorProxy({
    port,
    publicOrigin: "https://colin.frizz.sh",
    sessionDirectory: fileSessionDirectory(dir),
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    const publicHeaders = { host: "colin.frizz.sh", origin: "https://colin.frizz.sh" }
    const loopback = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }
    const redeem = async () => {
      const exchange = await proxied(port, `/?frizz_code=${proxy.issueAccessCode()!.code}`, publicHeaders)
      return String(exchange.headers?.["set-cookie"]).split(";")[0]!
    }
    const phone = await redeem()
    const laptop = await redeem()
    const idOf = (cookie: string) => cookie.split("=")[1]!.split(".")[1]!

    // Only a request that arrived publicly WITH a live session is told it has one to end.
    const statusOf = async (headers: Record<string, string>) =>
      JSON.parse((await proxied(port, SUPERVISOR_STATUS_PATH, headers)).body) as { remoteSession?: boolean }
    assert.equal((await statusOf({ ...publicHeaders, cookie: phone })).remoteSession, true)
    // No cookie through the tunnel: the control plane's session gate refuses status outright.
    assert.equal((await proxied(port, SUPERVISOR_STATUS_PATH, publicHeaders)).status, 401)
    assert.equal((await statusOf(loopback)).remoteSession, undefined, "the operator's own tab has none")
    assert.equal((await statusOf({ ...loopback, cookie: phone })).remoteSession, undefined, "a cookie on loopback is not a remote session")

    // It is a mutation, so it is a POST and nothing else.
    assert.equal((await proxied(port, SUPERVISOR_SIGN_OUT_PATH, { ...publicHeaders, cookie: phone })).status, 405)

    // CSRF: a cross-site page cannot drive it. A foreign Origin fails the authority gate before any
    // session is looked at, and so does a POST with no Origin at all.
    assert.equal((await proxied(port, SUPERVISOR_SIGN_OUT_PATH, { ...publicHeaders, origin: "https://evil.example", cookie: phone }, "POST")).status, 403)
    assert.equal((await proxied(port, SUPERVISOR_SIGN_OUT_PATH, { host: "colin.frizz.sh", cookie: phone }, "POST")).status, 403)
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: phone })).status, 200, "a refused attempt signed nothing out")

    // THE FEATURE. A body naming the LAPTOP's id is ignored — the id comes from the cookie, never the body.
    const signOut = await new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: SUPERVISOR_SIGN_OUT_PATH, method: "POST", headers: { ...publicHeaders, cookie: phone, "content-type": "application/json" } }, (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => { body += chunk })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      })
      req.once("error", reject)
      req.end(JSON.stringify({ id: idOf(laptop), all: true }))
    })
    assert.equal(signOut.status, 200)
    assert.deepEqual(JSON.parse(signOut.body), { protocol: 1, result: "signed-out", id: idOf(phone) })
    assert.match(String(signOut.headers["set-cookie"]), /^__Host-frizz_session=;.*Max-Age=0/, "the browser is told to drop the cookie")

    // The phone is refused on its very next request — page and socket — even holding the old cookie.
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: phone })).status, 401)
    assert.equal(await upgradeStatus(port, { ...publicHeaders, cookie: phone }), "401")
    // And the laptop, which the body named, is untouched.
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: laptop })).status, 200)

    // Persisted to the directory `--sign-out` uses, so a restart remembers it.
    const reloaded = fileSessionDirectory(dir)
    assert.notEqual(reloaded.get(idOf(phone))?.revokedAt, undefined)
    assert.equal(reloaded.get(idOf(laptop))?.revokedAt, undefined)

    // Replaying the dead cookie changes nothing and says so.
    const replay = await proxied(port, SUPERVISOR_SIGN_OUT_PATH, { ...publicHeaders, cookie: phone }, "POST")
    assert.equal(replay.status, 401)
    assert.equal(JSON.parse(replay.body).result, "no-remote-session")

    // Loopback with no session (the maintainer's own machine): a clear no-op, and no cookie is touched.
    const local = await proxied(port, SUPERVISOR_SIGN_OUT_PATH, loopback, "POST")
    assert.equal(local.status, 200)
    assert.deepEqual(JSON.parse(local.body), { protocol: 1, result: "no-remote-session" })
    assert.equal(local.headers?.["set-cookie"], undefined)
    // Even a loopback request carrying a live cookie ends nothing.
    assert.equal(JSON.parse((await proxied(port, SUPERVISOR_SIGN_OUT_PATH, { ...loopback, cookie: laptop }, "POST")).body).result, "no-remote-session")
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: laptop })).status, 200)

    // The loopback-only rule for signing out OTHER devices is unchanged: a live session still cannot.
    assert.equal((await proxied(port, SUPERVISOR_SESSIONS_PATH, { ...publicHeaders, cookie: laptop }, "POST")).status, 403)
    assert.equal((await proxied(port, SUPERVISOR_SESSIONS_PATH, { ...publicHeaders, cookie: laptop })).status, 403)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the control plane is behind the session gate: no session through the tunnel, no restart, no status", async () => {
  // handle() routes /_frizz/control/* to handleControl BEFORE its own session check, and handleControl
  // judged only Host and Origin — which a non-browser client sets freely. So anyone who knew a board's
  // public name could restart it, start an update, and read its status with no session at all. Found
  // while building the phone's sign-out. What must hold now: every control path refuses a public request
  // without a live session with a bare 401 and NO side effect; a valid session gets exactly today's
  // answer; loopback is untouched; sign-out keeps its own self-verifying handling.
  const current = await child("only")
  const port = await freePort()
  let restarts = 0
  let updates = 0
  const proxy = new RestartSupervisorProxy({
    port,
    publicOrigin: "https://colin.frizz.sh",
    childPort: () => current.port,
    restart: async () => { restarts++; return { state: "ready" } },
    updateRestart: async () => { updates++; return { state: "ready" } },
  })
  try {
    await proxy.listen()
    const publicHeaders = { host: "colin.frizz.sh", origin: "https://colin.frizz.sh" }
    const loopback = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }
    const exchange = await proxied(port, `/?frizz_code=${proxy.issueAccessCode()!.code}`, publicHeaders)
    const session = String(exchange.headers?.["set-cookie"]).split(";")[0]!
    const forged = session.slice(0, -1) + (session.endsWith("a") ? "b" : "a")
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

    const routes: Array<[string, string]> = [
      [SUPERVISOR_RESTART_PATH, "POST"],
      [SUPERVISOR_UPDATE_RESTART_PATH, "POST"],
      [SUPERVISOR_STATUS_PATH, "GET"],
      [SUPERVISOR_ACCESS_CODE_PATH, "POST"],
      [SUPERVISOR_SESSIONS_PATH, "GET"],
      [SUPERVISOR_SESSIONS_PATH, "POST"],
    ]
    // No session, a forged one, and the missing-Origin spelling a same-origin status read may use: all
    // refused before any per-path logic, with nothing in the body to say what lives here.
    const unauthenticated: Array<Record<string, string>> = [
      publicHeaders,
      { ...publicHeaders, cookie: forged },
      { host: "colin.frizz.sh", "sec-fetch-site": "same-origin" },
    ]
    for (const headers of unauthenticated) {
      for (const [path, method] of routes) {
        const refused = await proxied(port, path, headers, method)
        assert.equal(refused.status, 401, `${method} ${path} without a live session`)
        assert.equal(refused.body, "", `${method} ${path} leaked a body to an unauthenticated caller`)
      }
    }
    await settle()
    assert.equal(restarts, 0, "an unauthenticated restart ran")
    assert.equal(updates, 0, "an unauthenticated update ran")

    // A live session reads the status, and nothing else here is its to do.
    const authed = { ...publicHeaders, cookie: session }
    const status = await proxied(port, SUPERVISOR_STATUS_PATH, authed)
    assert.equal(status.status, 200)
    assert.equal(JSON.parse(status.body).protocol, 1)
    for (const path of [SUPERVISOR_RESTART_PATH, SUPERVISOR_UPDATE_RESTART_PATH]) {
      const refused = await proxied(port, path, authed, "POST")
      assert.equal(refused.status, 403, path)
      assert.equal(JSON.parse(refused.body).code, "remote_refused", path)
    }
    await settle()
    assert.equal(restarts, 0, "a remote session restarted the board")
    assert.equal(updates, 0, "a remote session started an update")
    // Minting and the device list stay loopback-only even WITH a session.
    assert.equal((await proxied(port, SUPERVISOR_ACCESS_CODE_PATH, authed, "POST")).status, 403)
    assert.equal((await proxied(port, SUPERVISOR_SESSIONS_PATH, authed)).status, 403)
    assert.equal((await proxied(port, SUPERVISOR_SESSIONS_PATH, authed, "POST")).status, 403)

    // Loopback is never asked for a session.
    const localStatus = await proxied(port, SUPERVISOR_STATUS_PATH, loopback)
    assert.equal(localStatus.status, 200)
    assert.equal(localStatus.body, status.body.replace(/,"remoteSession":true,"remoteHost":"[^"]*"/, ""), "loopback status changed shape")
    assert.equal((await proxied(port, SUPERVISOR_RESTART_PATH, loopback, "POST")).status, 202)
    assert.equal((await proxied(port, SUPERVISOR_ACCESS_CODE_PATH, loopback, "POST")).status, 200)
    assert.equal((await proxied(port, SUPERVISOR_SESSIONS_PATH, loopback)).status, 200)
    await settle()
    assert.equal(restarts, 1)

    // A foreign authority is still the authority check's 403, exactly as before.
    assert.equal((await proxied(port, SUPERVISOR_RESTART_PATH, { host: "evil.example", origin: "https://evil.example" }, "POST")).status, 403)

    // Sign-out is the exception: a dead cookie gets ITS 401, with a body and a cleared cookie.
    const dead = await proxied(port, SUPERVISOR_SIGN_OUT_PATH, { ...publicHeaders, cookie: forged }, "POST")
    assert.equal(dead.status, 401)
    assert.deepEqual(JSON.parse(dead.body), { protocol: 1, result: "no-remote-session" })
    assert.match(String(dead.headers?.["set-cookie"]), /^__Host-frizz_session=;.*Max-Age=0/)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("an epoch bump reaches a RUNNING launcher: the server child signs every older session out, once", async () => {
  // An in-app update replaces only the child, so the launcher holding the key keeps running. The child's
  // half (signOutOlderSessionEpoch) must end every pre-bump session on that live board, leave new ones
  // alone, and do nothing on the next start.
  const current = await child("only")
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), "frizz-epoch-live-"))
  const key = loadOrCreateSessionKey(dir)
  const proxy = new RestartSupervisorProxy({
    port,
    publicOrigin: "https://colin.frizz.sh",
    sessionKey: key,
    rotateSessionKey: () => rotateSessionKey(dir),
    sessionDirectory: fileSessionDirectory(dir),
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    const publicHeaders = { host: "colin.frizz.sh", origin: "https://colin.frizz.sh" }
    const redeem = async () => {
      const exchange = await proxied(port, `/?frizz_code=${proxy.issueAccessCode()!.code}`, publicHeaders)
      return String(exchange.headers?.["set-cookie"])
    }
    const phoneHeader = await redeem()
    // The cookie lives exactly as long as the session it carries: 30 days, not the old year.
    assert.match(phoneHeader, /; Max-Age=(2591999|2592000)(;|$)/)
    const phone = phoneHeader.split(";")[0]!
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: phone })).status, 200)

    // The launcher's own status file is how the child finds it; a different pid is not trusted.
    writeFileSync(join(dir, "dev-supervisor.lock"), JSON.stringify({ pid: process.pid, port }))
    const first = await signOutOlderSessionEpoch({ stateDir: dir, supervisorPid: process.pid })
    assert.deepEqual(first, { advance: { advanced: true, from: 0, to: SESSION_EPOCH, rotatedKey: true }, signedOut: 1 })
    assert.equal(readSessionEpoch(dir), SESSION_EPOCH)
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: phone })).status, 401, "a pre-epoch session still works")
    assert.equal(await upgradeStatus(port, { ...publicHeaders, cookie: phone }), "401")
    assert.equal((await proxied(port, "/", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).status, 200, "loopback was signed out")

    const tablet = (await redeem()).split(";")[0]!
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: tablet })).status, 200)
    // The next child start: the record is there, so nothing is rotated or revoked again.
    const second = await signOutOlderSessionEpoch({ stateDir: dir, supervisorPid: process.pid })
    assert.deepEqual(second, { advance: { advanced: false, epoch: SESSION_EPOCH }, signedOut: 0 })
    assert.equal((await proxied(port, "/", { ...publicHeaders, cookie: tablet })).status, 200, "a second start signed the new device out")
    // And the key the launcher would load on ITS next start is the one it is signing with now.
    const restartedPort = await freePort()
    const restarted = new RestartSupervisorProxy({
      port: restartedPort,
      publicOrigin: "https://colin.frizz.sh",
      sessionKey: loadOrCreateSessionKey(dir),
      sessionDirectory: fileSessionDirectory(dir),
      childPort: () => current.port,
      restart: async () => ({ state: "ready" }),
    })
    await restarted.listen()
    try {
      assert.equal((await proxied(restartedPort, "/", { ...publicHeaders, cookie: tablet })).status, 200)
    } finally {
      await restarted.close().catch(() => undefined)
    }
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the server child trusts only its own launcher's status file to name the port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-epoch-pid-"))
  try {
    loadOrCreateSessionKey(dir)
    writeFileSync(join(dir, "dev-supervisor.lock"), JSON.stringify({ pid: process.pid + 1, port: 1 }))
    let asked = false
    const result = await signOutOlderSessionEpoch({
      stateDir: dir,
      supervisorPid: process.pid,
      fetcher: (async () => { asked = true; return new Response("{}") }) as typeof fetch,
    })
    assert.equal(asked, false)
    // The file is still rotated, so the launcher's next start refuses every older session regardless.
    assert.deepEqual(result, { advance: { advanced: true, from: 0, to: SESSION_EPOCH, rotatedKey: true }, signedOut: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A toy child that counts what reached it, keeps the stamp each request carried, and holds what it is asked to. */
async function countingChild() {
  const stamps: Array<ReturnType<typeof decodeCallerStamp>> = []
  let reached = 0
  const server = await listen((req, res) => {
    reached++
    stamps.push(decodeCallerStamp(req.headers[CALLER_HEADER] as string | undefined))
    res.writeHead(200, { "content-type": "text/plain" })
    // A stream that never ends, the way the board's event feed does not.
    if (req.url === "/stream") res.write("open\n")
    else res.end("child")
  })
  const upgraded = new Set<import("node:stream").Duplex>()
  server.server.on("upgrade", (req, socket) => {
    reached++
    stamps.push(decodeCallerStamp(req.headers[CALLER_HEADER] as string | undefined))
    upgraded.add(socket)
    socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n")
    socket.on("error", () => undefined)
  })
  return {
    ...server,
    stamps,
    get reached() { return reached },
    // An upgraded socket is detached from the server, and close() would wait for it forever.
    close: async () => {
      for (const socket of upgraded) socket.destroy()
      await server.close()
    },
  }
}

/** An upgrade held open. `closed` settles when either side hangs up. */
async function openUpgrade(port: number, headers: Record<string, string>) {
  const socket = netConnect(port, "127.0.0.1")
  await once(socket, "connect")
  const lines = ["GET /ws HTTP/1.1", ...Object.entries(headers).map(([n, v]) => `${n}: ${v}`), "upgrade: websocket", "connection: Upgrade", "sec-websocket-version: 13", "sec-websocket-key: AQIDBAUGBwgJCgsMDQ4PEC=="]
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
  socket.on("error", () => undefined)
  socket.write(`${lines.join("\r\n")}\r\n\r\n`)
  const first = await new Promise<string>((resolve) => {
    socket.once("data", (chunk) => resolve(String(chunk)))
    void closed.then(() => resolve(""))
  })
  return { socket, closed, status: /^HTTP\/1\.1 (\d{3})/.exec(first)?.[1] ?? "refused" }
}

/** A forwarded stream held open, its first bytes read. `closed` settles when the proxy ends it. */
async function openStream(port: number, headers: Record<string, string>) {
  return new Promise<{ closed: Promise<void>; destroy: () => void }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/stream", headers }, (res) => {
      const closed = new Promise<void>((done) => res.once("close", () => done()))
      res.on("error", () => undefined)
      res.once("data", () => resolve({ closed, destroy: () => req.destroy() }))
    })
    req.once("error", reject)
    req.end()
  })
}

const within = (ms: number, what: Promise<unknown>, label: string) =>
  Promise.race([what, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: still open after ${ms}ms`)), ms).unref())])

const stillOpen = async (what: Promise<unknown>) =>
  Promise.race([what.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), 100))])

const PUBLIC = "https://colin.frizz.sh"
const publicVisitor = { host: "colin.frizz.sh", origin: PUBLIC }

async function redeemed(port: number, proxy: RestartSupervisorProxy) {
  const exchange = await proxied(port, `/?frizz_code=${proxy.issueAccessCode()!.code}`, publicVisitor)
  return String(exchange.headers?.["set-cookie"]).split(";")[0]!
}

test("the relay listener is public by construction: no header can read as loopback", async () => {
  const current = await countingChild()
  const port = await freePort()
  let restarts = 0
  const proxy = new RestartSupervisorProxy({ port, publicOrigin: PUBLIC, childPort: () => current.port, restart: async () => { restarts++; return { state: "ready" } } })
  try {
    await proxy.listen()
    const relay = await proxy.relayListener()
    assert.equal(await proxy.relayListener(), relay, "one listener, however often it is asked for")
    const claims: Array<Record<string, string> & { host: string }> = [
      { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
      { host: "localhost", origin: `http://localhost:${port}` },
      { host: "colin.frizz.sh", origin: PUBLIC },
    ]
    for (const headers of claims) {
      assert.equal((await proxied(relay, "/", headers)).status, 401, headers.host)
      assert.equal((await proxied(relay, SUPERVISOR_ACCESS_CODE_PATH, headers, "POST")).status, 401, headers.host)
      assert.equal((await proxied(relay, SUPERVISOR_RESTART_PATH, headers, "POST")).status, 401, headers.host)
      assert.equal((await proxied(relay, SUPERVISOR_SESSIONS_PATH, headers)).status, 401, headers.host)
      assert.equal(await upgradeStatus(relay, headers), "401", headers.host)
    }
    assert.equal(current.reached, 0, "a claim got through to the child")
    assert.equal(restarts, 0)

    // A real session, claiming to be the operator's own tab: it arrives as what it is, and a forged Origin
    // no longer agrees with the Host the listener forced.
    const cookie = await redeemed(port, proxy)
    const forged = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cookie }
    assert.equal((await proxied(relay, "/", forged)).status, 403)
    assert.equal(await upgradeStatus(relay, forged), "refused")
    assert.equal(current.reached, 0)
    const lying = { host: `127.0.0.1:${port}`, origin: PUBLIC, cookie }
    assert.equal((await proxied(relay, "/", lying)).status, 200)
    assert.equal(current.stamps.at(-1)?.via, "public")
    assert.equal(current.stamps.at(-1)?.host, "colin.frizz.sh")
    assert.equal(await upgradeStatus(relay, lying), "101")
    assert.equal(current.stamps.at(-1)?.via, "public")
    assert.equal((await proxied(relay, SUPERVISOR_ACCESS_CODE_PATH, lying, "POST")).status, 403)
    assert.equal((await proxied(relay, SUPERVISOR_RESTART_PATH, lying, "POST")).status, 403)
    assert.equal(restarts, 0)

    // A code redeems here as well, since this is where a phone's link arrives.
    const phone = await proxied(relay, `/?frizz_code=${proxy.issueAccessCode()!.code}`, publicVisitor)
    assert.equal(phone.status, 302)

    // No origin declared, which is every relayed request's position before the launcher declares one.
    proxy.setPublicOrigin(undefined)
    const before = current.reached
    assert.equal((await proxied(relay, "/", lying)).status, 403)
    assert.equal((await proxied(relay, "/", { host: `127.0.0.1:${port}` })).status, 403)
    assert.equal(await upgradeStatus(relay, lying), "403")
    assert.equal(current.reached, before, "with no origin, the relay's door still looked like loopback")

    // The operator's own port is unmoved by any of this.
    assert.equal((await proxied(port, "/", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).status, 200)
    assert.equal(current.stamps.at(-1)?.via, "loopback")
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("a sign-out ends what is already open: that device's sockets and streams at once, every device's with all", async () => {
  const current = await countingChild()
  const port = await freePort()
  const signedIn: Array<{ label: string; devices: number }> = []
  const proxy = new RestartSupervisorProxy({ port, publicOrigin: PUBLIC, onDeviceSignedIn: (device) => signedIn.push(device), childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  const loopback = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }
  try {
    await proxy.listen()
    const phone = await redeemed(port, proxy)
    const laptop = await redeemed(port, proxy)
    assert.deepEqual(signedIn.at(-1), { label: "unknown device", devices: 2 }, "the launcher hears about each device")
    const sessionId = (cookie: string) => cookie.split("=")[1]!.split(".")[1]!

    const phoneSocket = await openUpgrade(port, { ...publicVisitor, cookie: phone })
    const phoneStream = await openStream(port, { ...publicVisitor, cookie: phone, "sec-fetch-site": "same-origin" })
    const laptopSocket = await openUpgrade(port, { ...publicVisitor, cookie: laptop })
    const laptopStream = await openStream(port, { ...publicVisitor, cookie: laptop, "sec-fetch-site": "same-origin" })
    const localSocket = await openUpgrade(port, loopback)
    assert.equal(phoneSocket.status, "101")
    assert.equal(laptopSocket.status, "101")
    assert.equal(localSocket.status, "101")

    // One device, by the name `frizz --sign-out` takes.
    const one = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: SUPERVISOR_SESSIONS_PATH, method: "POST", headers: { ...loopback, "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.once("error", reject)
      req.end(JSON.stringify({ id: sessionId(phone) }))
    })
    assert.equal(one, 200)
    await within(2_000, phoneSocket.closed, "the signed-out device's socket")
    await within(2_000, phoneStream.closed, "the signed-out device's stream")
    assert.equal(await stillOpen(laptopSocket.closed), true, "signing the phone out closed the laptop's socket")
    assert.equal(await stillOpen(laptopStream.closed), true, "signing the phone out closed the laptop's stream")

    // A device signing itself out closes its own, the same way.
    const tablet = await redeemed(port, proxy)
    const tabletSocket = await openUpgrade(port, { ...publicVisitor, cookie: tablet })
    assert.equal((await proxied(port, SUPERVISOR_SIGN_OUT_PATH, { ...publicVisitor, cookie: tablet }, "POST")).status, 200)
    await within(2_000, tabletSocket.closed, "the device that signed itself out")
    assert.equal(await stillOpen(laptopSocket.closed), true)

    // Everyone.
    const all = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: SUPERVISOR_SESSIONS_PATH, method: "POST", headers: { ...loopback, "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.once("error", reject)
      req.end(JSON.stringify({ all: true }))
    })
    assert.equal(all, 200)
    await within(2_000, laptopSocket.closed, "sign out all, a socket")
    await within(2_000, laptopStream.closed, "sign out all, a stream")
    assert.equal(await stillOpen(localSocket.closed), true, "the operator's own tab is no session and was not touched")
    localSocket.socket.destroy()
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("loopback can always list and end sessions, even with no public origin declared", async () => {
  const current = await countingChild()
  const port = await freePort()
  let rotated = 0
  const proxy = new RestartSupervisorProxy({ port, publicOrigin: PUBLIC, rotateSessionKey: () => { rotated++; return Buffer.alloc(32, rotated) }, childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  const loopback = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }
  try {
    await proxy.listen()
    const phone = await redeemed(port, proxy)
    // The relay turned off in a hurry. Those cookies are good again the moment it comes back on.
    proxy.setPublicOrigin(undefined)
    assert.equal(JSON.parse((await proxied(port, SUPERVISOR_SESSIONS_PATH, loopback)).body).sessions.length, 1)
    const all = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: SUPERVISOR_SESSIONS_PATH, method: "POST", headers: { ...loopback, "content-type": "application/json" } }, (res) => {
        let body = ""
        res.on("data", (chunk) => { body += chunk })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.once("error", reject)
      req.end(JSON.stringify({ all: true }))
    })
    assert.deepEqual([all.status, JSON.parse(all.body)], [200, { signedOut: 1 }])
    assert.equal(rotated, 1, "the key rotated")
    proxy.setPublicOrigin(PUBLIC)
    assert.equal((await proxied(port, "/", { ...publicVisitor, cookie: phone })).status, 401)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("the supervisor's own pages refuse to be framed", async () => {
  const port = await freePort()
  let childPort: number | undefined
  const proxy = new RestartSupervisorProxy({ port, publicOrigin: PUBLIC, childPort: () => childPort, restart: async () => ({ state: "ready" }) })
  try {
    await proxy.listen()
    const framing = (answer: { headers?: IncomingHttpHeaders }) => [answer.headers?.["x-frame-options"], answer.headers?.["content-security-policy"]]
    const refused = ["DENY", "frame-ancestors 'none'"]
    const stranger = await proxied(port, "/", publicVisitor)
    assert.equal(stranger.status, 401)
    assert.deepEqual(framing(stranger), refused, "the sign-in page")
    assert.deepEqual(framing(await proxied(port, "/?frizz_code=spent", publicVisitor)), refused, "a dead link's page")
    const cookie = await redeemed(port, proxy)
    const recovery = await proxied(port, "/", { ...publicVisitor, cookie })
    assert.equal(recovery.status, 503)
    assert.deepEqual(framing(recovery), refused, "the recovery page")
    childPort = await freePort()
    const unreachable = await proxied(port, "/", { ...publicVisitor, cookie })
    assert.deepEqual(framing(unreachable), refused, "the page for a child that does not answer")
    proxy.setPublicOrigin(undefined)
    const unlisted = await proxied(port, "/", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })
    assert.equal(unlisted.status, 503)
    assert.deepEqual(framing(unlisted), refused, "the loopback recovery page")
  } finally {
    await proxy.close().catch(() => undefined)
  }
})

test("a child that answers an upgrade as plain HTTP never sees the visitor's next bytes, which no stamp covers", async () => {
  const seen: Array<{ url: string | undefined; stamp: ReturnType<typeof decodeCallerStamp> }> = []
  // A server with no `upgrade` listener: Node treats the handshake as an ordinary keep-alive request.
  const child = await listen((req, res) => {
    seen.push({ url: req.url, stamp: decodeCallerStamp(req.headers[CALLER_HEADER] as string | undefined) })
    res.writeHead(200, { "content-type": "text/plain", "content-length": "5" })
    res.end("child")
  })
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({ port, childPort: () => child.port, restart: async () => ({ state: "ready" }) })
  await proxy.listen()
  const socket = netConnect(port, "127.0.0.1")
  try {
    await once(socket, "connect")
    socket.on("error", () => undefined)
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    const host = `127.0.0.1:${port}`
    const handshake = `GET /first HTTP/1.1\r\nhost: ${host}\r\norigin: http://${host}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n`
    const smuggled = `POST /_frizz/rpc/dispatch HTTP/1.1\r\nhost: 127.0.0.1:${child.port}\r\ncontent-length: 0\r\n\r\n`
    socket.write(handshake + smuggled)
    await once(socket, "data")
    socket.write(smuggled)
    await closed
    assert.deepEqual(seen.map((request) => request.url), ["/first"])
    assert.equal(seen[0]!.stamp?.via, "loopback")
  } finally {
    socket.destroy()
    await proxy.close()
    await child.close()
  }
})
