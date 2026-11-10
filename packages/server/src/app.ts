import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { createReadStream } from "node:fs"
import { Readable } from "node:stream"
import { mountRouter } from "@frizz/rpc/server"
import { DEFAULT_PORT, FRIZZ_ROUTE_PREFIX, type ServerEvent, frizzRoute } from "@frizz/shared"
import { createRouter } from "./router.ts"
import { ATTACHMENT_INVALID_JSON, storeAttachment } from "./attachment-intake.ts"
import type { AppContext } from "./context.ts"
import { allowedLocalCorsOrigin, isTrustedLocalHttpRequest } from "./local-origin.ts"
import { compress, etagMatches, MIN_COMPRESS_BYTES, negotiateEncoding, RPC_CACHE_CONTROL, rpcEtag, shouldCompress } from "./compression.ts"
import { localImageHeaders, localImageStream, resolveLocalImage } from "./local-image.ts"
import { localFileHeaders, resolveServedLocalFile } from "./local-file.ts"
import { resolveProjectIconResponse } from "./project-icon.ts"
import { resolveLocalVisualization } from "./local-visualization.ts"
import { CALLER_HEADER, requestOriginFrom, withRequestOrigin } from "./audit.ts"
import { callerAccess, refuseRemoteRoute, remoteGate, remoteRouteAllowed } from "./remote-gate.ts"
import { remoteProjectDirs, remoteReadablePath } from "./remote-reads.ts"
import { LAUNCH_ROUTE_PATH, LAUNCH_ROUTE_PROTOCOL, LAUNCH_TOKEN_HEADER, parseLaunchRouteRequest, routeLaunch } from "./launch-routing.ts"
import { openableFileRoots, resolveProject } from "./project.ts"
import { ProjectServedElsewhereError, projectServedElsewhere } from "./project-serving.ts"

export { resolveLocalImage } from "./local-image.ts"
export { resolveLocalVisualization } from "./local-visualization.ts"

// The API surface routed to app.fetch: /rpc/* (typed procedures), /events (the single SSE
// board channel), /health. The terminal WebSocket and static/Vite assets are handled by the
// node http server in index.ts, not here.
export interface AppOptions {
  port?: number
  ownerProof?: string
  controlToken?: string
  /**
   * The machine-wide owner's token, when this server runs under the stable launcher. A second
   * `frizz` typed in any folder holds it (it is in the address record that names this server), where
   * `controlToken` is known only to a launcher that can find the hosting project's own record.
   */
  machineToken?: string
  requestOwnerStop?: () => void
  /** Test seam for the launch route: the project resolver, and the home whose registry it reads. */
  launchRouting?: { open?: (dir: string) => { id: string; dir: string; name: string }; home?: string }
}

export function createApp(ctx: AppContext, options: AppOptions = {}) {
  const app = new Hono()
  const port = options.port ?? DEFAULT_PORT

  // The API is a local control plane, not a public CORS service. Validate Host and require every present
  // Origin to name that SAME canonical loopback hostname + actual port, so an unrelated service on another
  // loopback family cannot borrow Frizz's browser authority. Reject all forwarded authority (Frizz does not
  // run behind a trusted proxy) and every non-local/mismatched Origin. Missing Origin is allowed
  // only for the read-only CLI health probe or a browser-forbidden `Sec-Fetch-Site: same-origin` request
  // (same-origin GET/fetch requests may omit Origin). Browser WebSockets use the stricter mandatory
  // same-origin policy in local-origin.ts.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin")
    const allowMissingOrigin = origin === undefined && (
      (c.req.method === "GET" && c.req.path === frizzRoute("/health")) ||
      (c.req.method === "POST" && c.req.path === frizzRoute("/control/stop")) ||
      (c.req.method === "POST" && c.req.path === frizzRoute(LAUNCH_ROUTE_PATH)) ||
      c.req.header("sec-fetch-site") === "same-origin"
    )
    if (!isTrustedLocalHttpRequest({
      host: c.req.header("host"),
      origin,
      forwarded: c.req.header("forwarded"),
      "x-forwarded-for": c.req.header("x-forwarded-for"),
      "x-forwarded-host": c.req.header("x-forwarded-host"),
      "x-forwarded-port": c.req.header("x-forwarded-port"),
      "x-forwarded-proto": c.req.header("x-forwarded-proto"),
    }, port, allowMissingOrigin)) {
      return c.text("Forbidden", 403)
    }
    await next()
  })

  // A REMOTE CALLER REACHES WHAT remote-gate.ts NAMES AND NOTHING ELSE. Judged on the path Hono routes by,
  // so a spelling that does not decode to an allowed route is refused rather than guessed at.
  const gateProject = { id: ctx.project.id, dir: ctx.project.dir }
  const accessIn = (c: Context) => callerAccess(c.req.header(CALLER_HEADER))
  app.use("*", async (c, next) => {
    const access = accessIn(c)
    if (access !== "local") {
      const suffix = c.req.path.startsWith(FRIZZ_ROUTE_PREFIX) ? c.req.path.slice(FRIZZ_ROUTE_PREFIX.length) : ""
      if (!remoteRouteAllowed(suffix, access)) return refuseRemoteRoute(c, { audit: ctx.audit, project: gateProject }, c.req.path.slice(0, 200))
    }
    await next()
  })
  const mayReadRemotely = (path: string) => remoteReadablePath(path, remoteProjectDirs(ctx.project.dir)) !== null

  app.use(
    cors({
      origin: (origin) => allowedLocalCorsOrigin(origin, port),
      // Expose the boot-id header so the client can read it off /rpc responses. Today the web app is
      // same-origin to the API (Vite middleware in dev, static in prod) so this is moot — but if it is
      // ever served cross-origin, without this the browser hides x-frizz-boot and the RPC restart-detection
      // channel silently dies (SSE frames still carry the id, so detection degrades rather than breaks).
      exposeHeaders: ["x-frizz-boot"],
    }),
  )

  // Stamp the server boot id on every /rpc response — a second, always-warm channel (besides the SSE
  // board frames) for the client to notice a restart even when the board is quiet but RPCs are flowing.
  // `frizzRoute`, not a bare "/rpc/*": every route around this one moved under `/_frizz` and this
  // middleware did not, so it matched nothing and the header was never sent — while the CORS
  // `exposeHeaders` above kept advertising it. Verified absent on the live server before the fix.
  app.use(`${frizzRoute("/rpc")}/*`, async (c, next) => {
    c.header("x-frizz-boot", ctx.bootId)
    await next()
  })

  // Attribute every procedure this request runs to whoever sent it, for the audit trail (audit.ts). An
  // AsyncLocalStorage rather than a handler argument: procedures receive only `{ input }`, and only a
  // handful of them record anything. The launcher's proxy says who called in CALLER_HEADER; a request
  // without one reached this server directly, and `remoteAddress` is that caller (see pipeToApp).
  app.use(`${frizzRoute("/rpc")}/*`, (c, next) =>
    withRequestOrigin(
      requestOriginFrom({
        caller: c.req.header(CALLER_HEADER),
        userAgent: c.req.header("user-agent"),
        socketRemote: (c.env as { remoteAddress?: string } | undefined)?.remoteAddress,
      }),
      next,
    ),
  )

  // Compress RPC responses. The board payload for a busy project is ~780 KB of JSON and every page
  // load fetches it; the server produces it in ~11 ms and then spends far longer pushing it up a home
  // connection through a tunnel, which is what made a remote board feel slow. Brotli q4 takes it to
  // ~150 KB for ~6 ms of CPU. Scoped to /rpc/* on purpose: the SSE stream must never be buffered by a
  // compressor. See compression.ts for the measurements behind the level choice.
  //
  // A query's answer also carries a validator. Every page load reads each project's board (the Console,
  // ~20 of them: 460 KB of brotli, 2 MB of JSON, on the maintainer's machine), and the rail polls its
  // counts every 5s, but most of those answers are what the browser already holds. `no-cache` makes the
  // browser ask every time, exactly as it does now, and an unchanged answer comes back as a bodiless 304
  // that also skips the compressor. The tag is over the uncompressed body, so it is weak: two encodings
  // of one answer are one answer. `private` keeps it out of any shared cache; the browser's own HTTP
  // cache keeps the last answer per URL, which a 200 without directives was already storable in. A
  // route that says its own cache policy (`no-store` on a file read) is left as it says.
  app.use(`${frizzRoute("/rpc")}/*`, async (c, next) => {
    await next()
    const validated = c.req.method === "GET" && c.res.status === 200 && !!c.res.body && !c.res.headers.has("cache-control")
    const encoding = negotiateEncoding(c.req.header("accept-encoding"))
    if (!validated && (!encoding || !c.res.body)) return
    const body = new Uint8Array(await c.res.arrayBuffer())
    if (validated) {
      const etag = rpcEtag(body)
      if (etagMatches(c.req.header("if-none-match"), etag)) {
        const headers = new Headers(c.res.headers)
        for (const name of ["content-length", "content-type", "content-encoding"]) headers.delete(name)
        headers.set("etag", etag)
        headers.set("cache-control", RPC_CACHE_CONTROL)
        headers.set("vary", "Accept-Encoding")
        c.res = new Response(null, { status: 304, headers })
        return
      }
      c.res.headers.set("etag", etag)
      c.res.headers.set("cache-control", RPC_CACHE_CONTROL)
    }
    if (!encoding || !shouldCompress(c.res.headers, body.byteLength)) {
      // arrayBuffer() consumed the stream, so the response has to be rebuilt either way.
      c.res = new Response(body, { status: c.res.status, headers: c.res.headers })
      return
    }
    const headers = new Headers(c.res.headers)
    headers.set("content-encoding", encoding)
    headers.set("vary", "Accept-Encoding")
    // The old length describes the uncompressed body and would truncate the response.
    headers.delete("content-length")
    c.res = new Response(compress(body, encoding), { status: c.res.status, headers })
  })

  // Launcher identity probe: a bare `{ok:true}` cannot distinguish two workspace servers that race
  // for a port or a stale lock whose PID was reused. Keep this small and non-secret; all fields are
  // already visible in the board keyframe/client URL.
  app.get(frizzRoute("/health"), (c) => c.json({
    ok: true as const,
    projectId: ctx.project.id,
    projectDir: ctx.project.dir,
    bootId: ctx.bootId,
    ...(options.ownerProof ? { ownerProof: options.ownerProof } : {}),
  }))

  // Cross-platform owner stop channel. The raw capability is never returned by /health; the CLI
  // reads it from the 0600 owner record and health proves only its project-bound SHA-256 digest.
  app.post(frizzRoute("/control/stop"), (c) => {
    const supplied = c.req.header("x-frizz-launch-token")
    if (!options.controlToken || !supplied || supplied !== options.controlToken) return c.text("Forbidden", 403)
    if (!options.requestOwnerStop) return c.text("Owner control unavailable", 503)
    const stop = setTimeout(options.requestOwnerStop, 25)
    stop.unref()
    return c.json({ accepted: true as const }, 202)
  })

  // Where a `frizz` typed in some folder lands (launch-routing.ts). A launcher asks instead of
  // deciding, so the rule about folders changes with a server release. Token-bound like the stop
  // channel, because answering can register the folder as a project: only the OS user who started
  // Frizz can read either token, and that user's launcher did exactly this itself until now.
  app.post(frizzRoute(LAUNCH_ROUTE_PATH), async (c) => {
    const supplied = c.req.header(LAUNCH_TOKEN_HEADER)
    const held = [options.controlToken, options.machineToken].filter((token): token is string => !!token)
    if (!supplied || !held.includes(supplied)) return c.text("Forbidden", 403)
    const request = parseLaunchRouteRequest(await c.req.json().catch(() => undefined))
    if ("error" in request) return c.json({ error: request.error }, 400)
    const home = options.launchRouting?.home
    // A project another server has open would not open here either, so the launch lands on the
    // dashboard and its notice names that server, rather than on a board that fails to load.
    const open = options.launchRouting?.open ?? ((dir: string) => {
      const project = resolveProject(dir, home)
      const other = projectServedElsewhere(project.stateDir, project.id)
      if (other !== undefined) throw new ProjectServedElsewhereError(project.name, other)
      return project
    })
    try {
      return c.json({ protocol: LAUNCH_ROUTE_PROTOCOL, ...routeLaunch(request.dir, open, home) })
    } catch (error) {
      // The folder is gone, or cannot be read at all: nothing to classify.
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  // Pictures AND videos (a ```lightbox gallery plays both), in byte ranges — see local-image.ts.
  app.get(frizzRoute("/local-image"), (c) => {
    // One 404 for a remote caller's refusal, as for a missing file: the answer says nothing about the disk.
    if (accessIn(c) === "read-and-answer" && !mayReadRemotely(c.req.query("path") ?? "")) return c.text("404", 404)
    const r = resolveLocalImage(c.req.query("path"), c.req.header("range"))
    if (r.status === 416) return c.body(null, 416, { "content-range": `bytes */${r.size}`, "accept-ranges": "bytes" })
    if (r.status === 400 || r.status === 404) return c.text(String(r.status), r.status)
    // Hono answers a HEAD by running this handler and dropping the body, so open no file for one.
    const stream = c.req.method === "HEAD" ? null : localImageStream(r)
    if (!stream) return c.body(null, r.status, localImageHeaders(r))
    return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>, r.status, localImageHeaders(r))
  })

  // A local file's bytes — a PDF inline for the reader's PDF view, anything else as a download for a
  // phone — behind the readers' own openable roots (local-file.ts resolveServedLocalFile). One 404 for
  // every refusal, so the route says nothing about what exists outside the gate. No byte ranges: the
  // PDF viewer reads the whole document off the navigation, and a download wants the whole file.
  app.get(frizzRoute("/local-file"), (c) => {
    let file
    try {
      if (accessIn(c) === "read-and-answer" && !mayReadRemotely(c.req.query("path") ?? "")) return c.text("404", 404)
      file = resolveServedLocalFile(c.req.query("path") ?? "", openableFileRoots(ctx.project))
    } catch {
      return c.text("404", 404)
    }
    const headers = localFileHeaders(file)
    // A HEAD runs this handler too, and an empty file has no span for createReadStream to express.
    if (c.req.method === "HEAD" || file.size === 0) return c.body(null, 200, headers)
    // Bounded at the size the headers promised, so a file still being written cannot overrun its length.
    const stream = createReadStream(file.path, { start: 0, end: file.size - 1 })
    return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>, 200, headers)
  })

  // MACHINE-SCOPED, not this project's: the rail draws every project on the machine, so it asks for
  // icons by project id and the answer must not depend on which board's app happens to answer. There
  // is no `<slug>` segment in the URL for exactly that reason, which also means it lands here on the
  // launching project's app (splitTenantRequest finds no known slug and falls through).
  //
  // A URL whose `v` is the icon's content hash names those bytes for good, so it is served from the
  // browser's cache at once on every load — `stale-while-revalidate` — while the revalidation goes out
  // behind it. That request still matters: it is what runs the lazy rescan (resolveProjectIcon), so an
  // icon committed later is still found. It costs a 304 when nothing changed. Until 2026-10-21 this was
  // a bare `max-age=300` with no validator, and `v` was the scan TIME, restamped by every rescan: each
  // load more than five minutes after the last, and every rescan, downloaded every icon again in full.
  //
  // A URL whose `v` is not the current hash — a card from before a change, or a project never scanned —
  // is revalidated every time instead, since the bytes it is answered with are not the ones it names.
  app.get(frizzRoute("/project-icon"), (c) => {
    const size = Number(c.req.query("s")) || undefined
    const r = resolveProjectIconResponse(c.req.query("id"), { size })
    if (r.status !== 200) return c.text(String(r.status), r.status)
    const headers: Record<string, string> = {
      "content-type": r.contentType,
      "cache-control": c.req.query("v") === r.hash ? "private, max-age=300, stale-while-revalidate=2592000" : "private, no-cache",
      etag: r.etag,
      // An SVG icon is a file out of somebody's repository. It renders through <img>, where scripting
      // is already off; this makes that unconditional rather than a property of how it is embedded.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    }
    const known = (c.req.header("if-none-match") ?? "").split(",").map((tag) => tag.trim().replace(/^W\//u, ""))
    if (known.includes(r.etag.replace(/^W\//u, "")) || known.includes("*")) return c.body(null, 304, headers)
    // An SVG is text and has no rendition, so compression is its size win: the logos on the maintainer's
    // machine shrink 3–6x as brotli (keyward's 2.8 KB to 0.5 KB). A PNG is compressed already. The
    // ETag is weak, so one tag serves either encoding.
    const encoding = r.contentType === "image/svg+xml" ? negotiateEncoding(c.req.header("accept-encoding")) : null
    if (encoding && r.body.byteLength >= MIN_COMPRESS_BYTES) {
      return c.body(compress(r.body, encoding), 200, { ...headers, "content-encoding": encoding, vary: "Accept-Encoding" })
    }
    return c.body(Uint8Array.from(r.body), 200, headers)
  })

  app.get(frizzRoute("/local-visualization"), (c) => {
    const row = ctx.storage.getSession(c.req.query("slug") ?? "")
    const r = resolveLocalVisualization(ctx.project.dir, row?.session_id, c.req.query("file"))
    if (r.status !== 200) return c.text(String(r.status), r.status)
    return c.html(r.body, 200, {
      "cache-control": "private, no-store",
      "content-security-policy": r.contentSecurityPolicy,
      "x-content-type-options": "nosniff",
      // Shown in the board's own iframe, so its own origin is the one page that may frame it.
      "x-frame-options": "SAMEORIGIN",
    })
  })

  // Attachment intake (attachment-intake.ts). The launcher answers a browser's upload itself, so this route
  // serves what the launcher passes on: a caller it would not answer for, a project it could not name, and every
  // upload through a launcher older than that split.
  app.post(frizzRoute("/attach"), async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: ATTACHMENT_INVALID_JSON }, 400)
    }
    const result = await storeAttachment(ctx.project.stateDir, body)
    return result.status === 200 ? c.json({ path: result.path }) : c.json({ error: result.error }, 400)
  })

  // Delta SSE — the FALLBACK board transport, for a page whose server has no /ws (api/sse.ts). The /ws
  // board channel carries deltas only and resumes from a board read over HTTP (app-socket.ts); SSE keeps
  // its connect keyframe, since it runs only where /ws is missing. The first frame is a FULL board
  // keyframe carrying the seq it corresponds to + the boot id; every subsequent bus event is a
  // per-thread delta (or a notify). A 10s heartbeat keeps the pipe warm.
  //
  // Ordering guarantee: we SUBSCRIBE FIRST and buffer, capture the keyframe, then flush. A publish that
  // fires while we assemble the keyframe (e.g. a cold-start rebuild that itself publishes) is therefore
  // never lost — buffered deltas are all ≤ the keyframe's seq (the keyframe reflects the latest committed
  // state), so the client's dup-guard drops them. Without this, a lost delta would force an immediate
  // resync on connect.
  app.get(frizzRoute("/events"), (c) =>
    streamSSE(c, async (stream) => {
      let id = 0
      const send = (event: unknown) => stream.writeSSE({ data: JSON.stringify(event), id: String(id++) })

      let flushed = false
      const buffer: ServerEvent[] = []
      const unsubscribe = ctx.bus.subscribe((event) => {
        if (flushed) void send(event).catch(() => {})
        else buffer.push(event)
      })

      try {
        // The board and its seq read together: a refresh landing between two separate reads would
        // label the board with a seq one delta off, and the client's dup-guard would then drop a delta
        // it needed or apply one it already had.
        const { board, seq } = await ctx.board.snapshotState()
        await send({ type: "board", board, seq, bootId: ctx.bootId })
      } catch {
        // board not ready — a buffered/live bus publish will deliver the first delta instead
      }
      flushed = true
      for (const event of buffer) void send(event).catch(() => {})
      buffer.length = 0

      const heartbeat = setInterval(() => void stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => {}), 10000)

      await new Promise<void>((resolve) =>
        stream.onAbort(() => {
          unsubscribe()
          clearInterval(heartbeat)
          resolve()
        }),
      )
    }),
  )

  mountRouter(app, frizzRoute("/rpc"), createRouter(ctx), remoteGate({
    audit: ctx.audit,
    project: gateProject,
    questionSpec: (slug, id) => {
      const row = ctx.storage.getThreadQuestion(id)
      return row && row.thread_slug === slug ? { spec: row.spec } : undefined
    },
    mayRead: mayReadRemotely,
  }))
  return app
}
