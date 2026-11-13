// A worker's stdio MCP servers, started on FIRST USE instead of at boot.
//
// WHY. Claude Code starts every stdio server in its config the moment a session starts, and keeps it
// for the life of the session — whether or not the session ever calls one of its tools. Measured
// 2026-09-30 on the maintainer's machine: 20 live workers each held a `chrome-devtools-mcp` (91 MB
// physical footprint) under its `npm exec` parent (95 MB), 3.9 GB in all, and not one of them had
// opened a page. A browser server is the typical case — a project declares it for the sessions that
// need one, and most sessions do not.
//
// HOW. The broker daemon hosts this. Each project stdio server reaches the worker as a REMOTE server
// (`type: "http"`, a `127.0.0.1` URL served by this daemon) instead of a command, so Claude Code starts
// nothing at boot. This host answers the handshake and the list methods (`server/discover`, `initialize`,
// `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `ping`) from a cache, and starts the
// project's REAL command — same command, args, env and cwd the CLI would have used — on the first
// request it cannot answer, normally the first `tools/call`. From then on it is a pipe: every message
// either way is forwarded verbatim, including the server's own requests (`roots/list`, elicitation),
// which reach the client over the standalone SSE stream.
//
// Nothing about a project's configuration is shared or merged. One host per WORKER (its broker daemon),
// one real process per server per worker once started, exactly as before — the only change is when it
// starts. The server name is kept, so tool names (`mcp__<server>__<tool>`) and permission rules match.
//
// THE CACHE is what the real server answered last time, keyed by everything that defines it (command,
// args, env, cwd), under `<frizz data>/mcp-cache/`. With no cache yet the host starts the real server
// at the handshake — the first worker of a new configuration pays the old cost once. A lazily started
// server's lists are re-read and compared, and a difference updates the cache and sends the client the
// matching `list_changed` notification, so a server that grew a tool (an `@latest` pin) self-corrects.
//
// WHY HTTP AND NOT THE SDK'S IN-PROCESS (`type: "sdk"`) SERVERS. That route carries client→server
// requests only: a message the SERVER sends with an id goes to the CLI as a one-way control request,
// and nothing routes the CLI's answer back (claude-agent-sdk 0.3.288, `sendMcpServerMessageToCli`). A
// project server that asks for `roots/list` would hang. Plain Streamable HTTP is the transport Claude
// Code already speaks to every remote server, in both directions.
//
// The listener is loopback-only and every request must carry this daemon's random bearer token, which
// reaches the CLI only inside the owner-only `--mcp-config` file (session-files.ts). A wrong token is a
// 403, never a 401: a 401 sends Claude Code into OAuth discovery against this URL.
import { spawn, type ChildProcess } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import http from "node:http"
import { join } from "node:path"
import type { RemoteMcpServer, StdioMcpServer } from "./project-mcp-servers.ts"

type JsonRpcId = string | number
interface JsonRpcMessage {
  jsonrpc: "2.0"
  id?: JsonRpcId | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** The methods a cache can answer: their answer is a pure function of the server's definition. `server/discover`
 *  is the version probe Claude Code sends a remote server before `initialize` (2.1.289; a stdio server never
 *  sees it) — a server that does not know it answers -32601 and the CLI falls back, so that answer is
 *  cached like any other. Missing it here started the real server at every boot. */
const CACHED_METHODS = new Set(["tools/list", "prompts/list", "resources/list", "resources/templates/list", "server/discover"])
/** Only "the server does not have this method" is a durable error; anything else is this run's problem. */
const METHOD_NOT_FOUND = -32601
const CACHE_VERSION = 2
const LIST_CHANGED: Record<string, string> = {
  "tools/list": "notifications/tools/list_changed",
  "prompts/list": "notifications/prompts/list_changed",
  "resources/list": "notifications/resources/list_changed",
  "resources/templates/list": "notifications/resources/list_changed",
}
/** The protocol revision asked for when the host itself opens a session the client never described. */
const FALLBACK_PROTOCOL_VERSION = "2025-06-18"
const STDERR_TAIL_BYTES = 2048
const MAX_BODY_BYTES = 64 * 1024 * 1024

type CachedAnswer = Pick<JsonRpcMessage, "result" | "error">
interface CacheRecord {
  version: typeof CACHE_VERSION
  initialize?: unknown
  /** `<method> <JSON params without _meta>` → what the server answered. */
  answers: Record<string, CachedAnswer>
}

function cacheable(response: JsonRpcMessage): CachedAnswer | undefined {
  if (response.result !== undefined) return { result: response.result }
  if (response.error?.code === METHOD_NOT_FOUND) return { error: response.error }
  return undefined
}

export interface LazyMcpMountContext {
  /** The worker's cwd — where the real server runs, as the CLI would have run it. */
  cwd: string
  /** The worker's environment; a server's own `env` is layered over it, as the CLI does. */
  env: Record<string, string>
  /** Where this worker's starts, exits and stale caches are reported. */
  log?: (message: string) => void
}

export interface LazyMcpHost {
  readonly port: number
  /** Register `servers` and return the remote mounts that replace them in the worker's config. */
  mount: (servers: Record<string, StdioMcpServer>, context: LazyMcpMountContext) => Record<string, RemoteMcpServer>
  /** Close the slots behind mounts this host handed out (a URL it did not mint is ignored): an MCP reload
   *  that dropped or replaced a server stops its real process, which would otherwise outlive the reload. */
  release: (mounts: RemoteMcpServer[]) => Promise<void>
  /** How many real processes are running — what the tests and the verification read. */
  running: () => string[]
  close: () => Promise<void>
}

export interface LazyMcpHostOptions {
  /** Where the per-definition caches live. */
  cacheDir: string
  log?: (message: string) => void
}

/** FRIZZ_LAZY_MCP_OFF=1 restores the CLI's own eager start (mirrors FRIZZ_HIBERNATE_OFF). */
export function lazyMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FRIZZ_LAZY_MCP_OFF !== "1"
}

export function lazyMcpCacheKey(server: StdioMcpServer, cwd: string): string {
  const identity = JSON.stringify({ command: server.command, args: server.args ?? [], env: server.env ?? {}, cwd })
  return createHash("sha256").update(identity).digest("hex").slice(0, 32)
}

/** How many tools the cache says a stdio server has — what the prompt box's MCP menu shows for a server no
 *  session has started. `undefined` with no cache yet (the server has never been started for this cwd). */
export function lazyMcpCachedToolCount(server: StdioMcpServer, cwd: string, cacheDir: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(cacheDir, `${lazyMcpCacheKey(server, cwd)}.json`), "utf8")) as CacheRecord
    if (parsed?.version !== CACHE_VERSION || !parsed.answers || typeof parsed.answers !== "object") return undefined
    for (const [key, answer] of Object.entries(parsed.answers)) {
      if (!key.startsWith("tools/list")) continue
      const tools = (answer as { result?: { tools?: unknown } })?.result?.tools
      if (Array.isArray(tools)) return tools.length
    }
  } catch {}
  return undefined
}

function listKey(method: string, params: unknown): string {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return method
  const { _meta: _ignored, ...rest } = params as Record<string, unknown>
  return Object.keys(rest).length === 0 ? method : `${method} ${JSON.stringify(rest)}`
}

function isRequest(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && message.id !== undefined && message.id !== null
}

function isResponse(message: JsonRpcMessage): boolean {
  return message.method === undefined && message.id !== undefined && ("result" in message || "error" in message)
}

class LazyServer {
  private child: ChildProcess | undefined
  private ready: Promise<void> | undefined
  private initResult: unknown
  private clientInitParams: Record<string, unknown> | undefined
  private nextInternalId = 0
  /** Requests the HOST sent the child (its own handshake and refreshes), by id. */
  private readonly internal = new Map<string, (message: JsonRpcMessage) => void>()
  /** Client requests forwarded to the child, by id, waiting for the child's answer. */
  private readonly forwarded = new Map<string, (message: JsonRpcMessage) => void>()
  private stream: http.ServerResponse | undefined
  private readonly outbox: JsonRpcMessage[] = []
  private stderrTail = ""
  private cache: CacheRecord

  constructor(
    readonly name: string,
    private readonly server: StdioMcpServer,
    private readonly context: LazyMcpMountContext,
    private readonly cachePath: string,
    private readonly log: (message: string) => void,
  ) {
    this.cache = this.readCache()
  }

  get isRunning(): boolean {
    return this.child !== undefined
  }

  private readCache(): CacheRecord {
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, "utf8")) as CacheRecord
      if (parsed?.version === CACHE_VERSION && parsed.answers && typeof parsed.answers === "object") return parsed
    } catch {}
    return { version: CACHE_VERSION, answers: {} }
  }

  private writeCache(): void {
    try {
      const temp = `${this.cachePath}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(this.cache), { mode: 0o600 })
      renameSync(temp, this.cachePath)
    } catch (error) {
      this.log(`${this.name}: cache write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---- the client side -------------------------------------------------------------------------

  async handleRequest(message: JsonRpcMessage): Promise<JsonRpcMessage> {
    const id = message.id as JsonRpcId
    try {
      const method = message.method as string
      if (method === "initialize") {
        this.clientInitParams = (message.params ?? {}) as Record<string, unknown>
        if (this.initResult !== undefined) return { jsonrpc: "2.0", id, result: this.initResult }
        if (this.cache.initialize !== undefined) return { jsonrpc: "2.0", id, result: this.cache.initialize }
        await this.start(method)
        return { jsonrpc: "2.0", id, result: this.initResult }
      }
      if (method === "ping" && !this.child) return { jsonrpc: "2.0", id, result: {} }
      if (CACHED_METHODS.has(method) && !this.child) {
        const cached = this.cache.answers[listKey(method, message.params)]
        if (cached !== undefined) return { jsonrpc: "2.0", id, ...cached }
      }
      await this.start(method)
      const response = await this.forward(message)
      const answer = CACHED_METHODS.has(method) ? cacheable(response) : undefined
      if (answer) {
        this.cache.answers[listKey(method, message.params)] = answer
        this.writeCache()
      }
      return response
    } catch (error) {
      return { jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }
    }
  }

  /** A client notification or a client's answer to a server request. Never starts the server. */
  handleOther(message: JsonRpcMessage): void {
    // The host performs the child's handshake itself, so the client's `initialized` is already said.
    if (message.method === "notifications/initialized") return
    if (this.child && this.initResult !== undefined) this.send(message)
  }

  openStream(response: http.ServerResponse): void {
    this.stream?.end()
    this.stream = response
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    response.flushHeaders()
    response.on("close", () => { if (this.stream === response) this.stream = undefined })
    for (const message of this.outbox.splice(0)) this.toClient(message)
  }

  private toClient(message: JsonRpcMessage): void {
    if (!this.stream) { this.outbox.push(message); return }
    this.stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
  }

  // ---- the server side -------------------------------------------------------------------------

  /** `reason` is the client method that needed the real server — the line that says why it ran. */
  private start(reason: string): Promise<void> {
    this.ready ??= this.spawnAndInitialize(reason).catch((error) => {
      this.ready = undefined
      throw error
    })
    return this.ready
  }

  private async spawnAndInitialize(reason: string): Promise<void> {
    this.log(`${this.name}: starting ${this.server.command} for ${reason}`)
    const child = spawn(this.server.command, this.server.args ?? [], {
      cwd: this.context.cwd,
      env: { ...this.context.env, ...(this.server.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child = child
    this.stderrTail = ""
    let buffered = ""
    child.stdout!.setEncoding("utf8")
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk
      let newline: number
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (!line) continue
        let parsed: JsonRpcMessage
        try { parsed = JSON.parse(line) as JsonRpcMessage } catch { continue }
        this.fromChild(parsed)
      }
    })
    child.stderr!.setEncoding("utf8")
    child.stderr!.on("data", (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES) })
    child.stdin!.on("error", () => {})
    const exited = new Promise<never>((_resolve, reject) => {
      const fail = (detail: string) => {
        if (this.child === child) this.reset(detail)
        reject(new Error(detail))
      }
      child.once("error", (error) => fail(`MCP server "${this.name}" could not start: ${error.message}`))
      child.once("exit", (code, signal) => fail(`MCP server "${this.name}" exited (${signal ?? `code ${code}`})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`))
    })
    exited.catch(() => {})
    const params = {
      protocolVersion: (this.clientInitParams?.protocolVersion as string | undefined) ?? FALLBACK_PROTOCOL_VERSION,
      capabilities: this.clientInitParams?.capabilities ?? {},
      clientInfo: this.clientInitParams?.clientInfo ?? { name: "frizz-lazy-mcp", version: "1" },
    }
    const response = await Promise.race([this.internalRequest("initialize", params), exited])
    if (response.error) throw new Error(`MCP server "${this.name}" refused initialize: ${response.error.message}`)
    this.initResult = response.result
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    this.cache.initialize = response.result
    this.writeCache()
    void this.refreshLists()
  }

  /** Re-read every cached list from the live server; a difference updates the cache and tells the client. */
  private async refreshLists(): Promise<void> {
    const changed = new Set<string>()
    for (const key of Object.keys(this.cache.answers)) {
      const space = key.indexOf(" ")
      const method = space < 0 ? key : key.slice(0, space)
      const params = space < 0 ? undefined : JSON.parse(key.slice(space + 1))
      const response = await this.internalRequest(method, params).catch(() => undefined)
      const answer = response && cacheable(response)
      if (!answer) continue
      if (JSON.stringify(answer) !== JSON.stringify(this.cache.answers[key])) {
        this.cache.answers[key] = answer
        changed.add(LIST_CHANGED[method] ?? "")
      }
    }
    if (changed.size === 0) return
    this.writeCache()
    for (const notification of changed) if (notification) this.toClient({ jsonrpc: "2.0", method: notification })
    this.log(`${this.name}: cached lists were stale; sent ${[...changed].join(", ")}`)
  }

  private internalRequest(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = `frizz-lazy-${++this.nextInternalId}`
    return new Promise((resolve) => {
      this.internal.set(id, resolve)
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  private forward(message: JsonRpcMessage): Promise<JsonRpcMessage> {
    return new Promise((resolve) => {
      this.forwarded.set(JSON.stringify(message.id), resolve)
      this.send(message)
    })
  }

  private send(message: JsonRpcMessage): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  private fromChild(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      const key = typeof message.id === "string" && message.id.startsWith("frizz-lazy-") ? message.id : undefined
      const waiter = key !== undefined ? this.internal.get(key) : this.forwarded.get(JSON.stringify(message.id))
      if (key !== undefined) this.internal.delete(key)
      else this.forwarded.delete(JSON.stringify(message.id))
      waiter?.(message)
      return
    }
    // A notification, or a request the server makes of the client: the standalone stream carries both.
    this.toClient(message)
  }

  /** The child is gone: fail everything waiting on it, and let the next request start a fresh one. */
  private reset(detail: string): void {
    this.log(detail)
    this.child = undefined
    this.ready = undefined
    this.initResult = undefined
    const error = { code: -32000, message: detail }
    for (const [id, waiter] of this.forwarded) waiter({ jsonrpc: "2.0", id: JSON.parse(id) as JsonRpcId, error })
    for (const [id, waiter] of this.internal) waiter({ jsonrpc: "2.0", id, error })
    this.forwarded.clear()
    this.internal.clear()
  }

  async close(): Promise<void> {
    this.stream?.end()
    const child = this.child
    if (!child) return
    this.child = undefined
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} ; resolve() }, 2000)
      child.once("exit", () => { clearTimeout(timer); resolve() })
      // Closing stdin is how a stdio MCP server is told to stop; the signal is for one that does not listen.
      try { child.stdin?.end() } catch {}
      try { child.kill("SIGTERM") } catch {}
    })
  }
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error("body too large")); request.destroy(); return }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}

export function startLazyMcpHost(options: LazyMcpHostOptions): Promise<LazyMcpHost> {
  const log = options.log ?? (() => {})
  const token = randomBytes(32).toString("hex")
  const servers = new Map<string, LazyServer>()
  let mounted = 0

  const httpServer = http.createServer((request, response) => {
    const route = /^\/mcp\/([A-Za-z0-9]+)$/.exec((request.url ?? "").split("?")[0] ?? "")
    const server = route ? servers.get(route[1]!) : undefined
    if (!server) { response.writeHead(404).end(); return }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return }
    if (request.method === "GET") { server.openStream(response); return }
    if (request.method !== "POST") { response.writeHead(405, { allow: "GET, POST" }).end(); return }
    void (async () => {
      let parsed: unknown
      try { parsed = JSON.parse(await readBody(request)) } catch {
        response.writeHead(400, { "content-type": "application/json" })
        response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }))
        return
      }
      const messages = (Array.isArray(parsed) ? parsed : [parsed]) as JsonRpcMessage[]
      const requests = messages.filter(isRequest)
      for (const message of messages) if (!isRequest(message)) server.handleOther(message)
      if (requests.length === 0) { response.writeHead(202).end(); return }
      const answers = await Promise.all(requests.map((message) => server.handleRequest(message)))
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]))
    })()
  })
  // A tool call holds its POST open for as long as the tool runs; node's 5-minute request timeout would
  // cut a long one off mid-call.
  httpServer.requestTimeout = 0

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject)
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject)
      const address = httpServer.address()
      const port = typeof address === "object" && address ? address.port : 0
      resolve({
        port,
        mount(stdio, context) {
          mkdirSync(options.cacheDir, { recursive: true, mode: 0o700 })
          const out: Record<string, RemoteMcpServer> = {}
          for (const [name, definition] of Object.entries(stdio)) {
            const slot = String(++mounted)
            const cachePath = join(options.cacheDir, `${lazyMcpCacheKey(definition, context.cwd)}.json`)
            servers.set(slot, new LazyServer(name, definition, context, cachePath, context.log ?? log))
            out[name] = { type: "http", url: `http://127.0.0.1:${port}/mcp/${slot}`, headers: { Authorization: `Bearer ${token}` } }
          }
          return out
        },
        async release(mounts) {
          const prefix = `http://127.0.0.1:${port}/mcp/`
          const closing: Promise<void>[] = []
          for (const mount of mounts) {
            if (!mount.url.startsWith(prefix)) continue
            const slot = mount.url.slice(prefix.length)
            const server = servers.get(slot)
            if (!server) continue
            servers.delete(slot)
            closing.push(server.close())
          }
          await Promise.all(closing)
        },
        running: () => [...servers.values()].filter((server) => server.isRunning).map((server) => server.name),
        async close() {
          await Promise.all([...servers.values()].map((server) => server.close()))
          httpServer.closeAllConnections()
          await new Promise<void>((done) => httpServer.close(() => done()))
        },
      })
    })
  })
}
