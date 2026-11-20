import { spawn, type ChildProcess } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import {
  JsonRpcInbound,
  type JsonRpcError,
  type JsonRpcId,
} from "./acp-types.ts"

// The JSON-RPC 2.0 transport under the ACP backend: newline-delimited JSON on a child's stdio, client
// speaks first. Hand-rolled rather than `@agentclientprotocol/sdk` (plans/acp-backend.md, decision 1):
// the wire is sixty lines, and what Frizz actually needs from the transport is the part no SDK gives it —
//
//   - a BOUNDED line reader that SKIPS what it cannot parse. In ACP mode fd 1 IS the transport, and the
//     most common failure in the field is a dependency, a banner or an update notice writing to stdout
//     (opencode once emitted LSP `Content-Length:` headers there). A junk line is a diagnostic, never a
//     crash, and a line past `maxLineBytes` is dropped rather than buffered until memory runs out;
//   - a spawn-failure path: ENOENT arrives as a `child.error` event, which the SDK turned into an
//     unhandled rejection when it raced `initialize`. Here every pending request settles on exit;
//   - stderr kept and surfaced, because it is the only debugging channel an agent has;
//   - `requestTimeoutMs` per call, because an agent that never answers `initialize` (the registry
//     quarantines one that takes 120s) must fail the dispatch, not hold it open.
//
// The connection knows nothing about sessions or transcripts; `acp-bridge.ts` owns those.

export interface AcpSpawnOptions {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/** What the connection needs from a process: stdio streams and a lifecycle. `ChildProcess` satisfies
 *  it; tests may hand in anything with the same shape. */
export interface AcpProcess {
  stdin: NodeJS.WritableStream | null
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  pid?: number | undefined
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: "error", listener: (err: Error) => void): this
}

export type AcpSpawn = (options: AcpSpawnOptions) => AcpProcess

/** The default host: a plain child of the server over piped stdio. Not detached — when the server
 *  exits, stdin closes and the agent exits with it, which is the protocol's own teardown. */
export const spawnAcpChild: AcpSpawn = ({ command, args, cwd, env }) =>
  spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as unknown as AcpProcess

export interface AcpDiagnostic {
  kind: "junk-line" | "oversized-line" | "stderr" | "unhandled-request" | "protocol"
  message: string
}

export interface AcpConnectionOptions {
  /** The agent calling US (`session/request_permission`, `fs/*`). Return the result, or throw an
   *  `AcpRequestError` to answer with a JSON-RPC error; any other throw answers `-32603`. */
  onRequest: (method: string, params: unknown) => Promise<unknown>
  onNotification: (method: string, params: unknown) => void
  onDiagnostic?: (d: AcpDiagnostic) => void
  /** A response to a request this connection never sent. Behind a daemon that is what the PREVIOUS
   *  runtime's request looks like when its answer came while nobody was attached (acp-daemon.ts replays
   *  it under the old id). Return true to take it; otherwise it is reported as a protocol fault. */
  onOrphanResponse?: (frame: { id: JsonRpcId; result?: unknown; error?: JsonRpcError }) => boolean
  /** Default per-request timeout; `request()` may override. */
  requestTimeoutMs?: number
  /** Lines longer than this are dropped (with a diagnostic) instead of buffered. Default 8 MiB. */
  maxLineBytes?: number
}

export class AcpRequestError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message) }
}

/** The agent answered a request with a JSON-RPC error. `code` is the agent's. */
export class AcpRemoteError extends Error {
  constructor(readonly method: string, readonly error: JsonRpcError) {
    super(`${method}: ${error.message} (${error.code})`)
  }
}

/** The process ended (or never started) while a request was pending. */
export class AcpConnectionClosed extends Error {
  constructor(readonly method: string, readonly reason: string) { super(`${method}: agent connection closed (${reason})`) }
}

export class AcpRequestTimeout extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) { super(`${method}: no response from the agent within ${Math.round(timeoutMs / 1000)}s`) }
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout | undefined
}

export class AcpConnection {
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, Pending>()
  private readonly decoder = new StringDecoder("utf8")
  private buffer = ""
  private overflowing = false
  private closedReason: string | undefined
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private readonly stderrTail: string[] = []

  constructor(readonly process: AcpProcess, private readonly options: AcpConnectionOptions) {
    const maxLine = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    this.exitPromise = new Promise((resolve) => {
      process.on("exit", (code, signal) => {
        this.settleClosed(`exit ${signal ?? code ?? "?"}`)
        resolve({ code, signal })
      })
      process.on("error", (err) => {
        // ENOENT and friends: the process never ran. Every waiter (above all `initialize`) fails now.
        this.settleClosed(err.message)
        resolve({ code: null, signal: null })
      })
    })
    // A write the far end will never read — the agent exited, or (over the daemon transport) the
    // daemon hung this socket up, which it does to the older client the moment a newer one attaches —
    // fails ASYNCHRONOUSLY, as an `error` event on stdin (EPIPE), after `write()` has returned. An
    // `error` event nobody listens for is thrown out of the event loop, and that ends the server: two
    // concurrent opens of one ACP session did exactly that (scripts/verify-daemon-socket-takeover.mjs,
    // scenario D, before acp-bridge.ts's `openOnce`). The codex transport has always listened
    // (codex-app-server.ts `JsonlRpcConnection`). A broken stdin is a closed connection: fail the
    // waiters now; the exit event follows.
    process.stdin?.on("error", (err: Error) => this.settleClosed(`stdin: ${err.message}`))
    process.stdout?.on("data", (chunk: Buffer | string) => {
      this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk)
      let nl: number
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        if (this.overflowing) { this.overflowing = false; continue } // the tail of a dropped line
        this.handleLine(line)
      }
      if (this.buffer.length > maxLine) {
        options.onDiagnostic?.({ kind: "oversized-line", message: `dropped a stdout line longer than ${maxLine} bytes` })
        this.buffer = ""
        this.overflowing = true
      }
    })
    process.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk)
      for (const line of text.split("\n")) {
        if (!line.trim()) continue
        this.stderrTail.push(line.slice(0, 2_000))
        if (this.stderrTail.length > 40) this.stderrTail.shift()
        options.onDiagnostic?.({ kind: "stderr", message: line.slice(0, 2_000) })
      }
    })
  }

  /** The last lines the agent wrote to stderr — what a failed dispatch shows the operator. */
  get recentStderr(): readonly string[] { return this.stderrTail }

  get closed(): boolean { return this.closedReason !== undefined }

  /** Resolves when the process has exited (or failed to start). */
  get exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> { return this.exitPromise }

  request(method: string, params: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    if (this.closedReason !== undefined) return Promise.reject(new AcpConnectionClosed(method, this.closedReason))
    const id = this.nextId++
    const timeoutMs = opts.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => { this.pending.delete(id); reject(new AcpRequestTimeout(method, timeoutMs)) }, timeoutMs)
        : undefined
      timer?.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(new AcpConnectionClosed(method, this.closedReason ?? "stdin closed"))
      }
    })
  }

  /** A prompt turn is long-lived by design (its response IS the end of the turn), so it is the one
   *  request that must not time out; callers pass `timeoutMs: 0` through this alias for readability. */
  requestOpenEnded(method: string, params: unknown): Promise<unknown> { return this.request(method, params, { timeoutMs: 0 }) }

  /**
   * Re-own a request a PREVIOUS connection left in flight (a `session/prompt` still running in a
   * detached agent, see acp-host.ts). Nothing is written to the agent: an id is allocated and
   * registered exactly as `request()` would, then handed to `onId` so the caller can tell the daemon
   * to route that request's response here. Resolves when the response arrives; never times out.
   */
  adoptPending(method: string, onId: (id: number) => void): Promise<unknown> {
    if (this.closedReason !== undefined) return Promise.reject(new AcpConnectionClosed(method, this.closedReason))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject, timer: undefined })
      onId(id)
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params })
  }

  /** Close stdin (the protocol's teardown) and, if the agent has not exited after `graceMs`, kill it. */
  async close(graceMs = 3_000): Promise<void> {
    try { this.process.stdin?.end() } catch { /* already gone */ }
    if (this.closedReason !== undefined) return
    const exited = await Promise.race([this.exitPromise.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), graceMs).unref?.())])
    if (!exited) { try { this.process.kill("SIGKILL") } catch { /* already gone */ } }
  }

  private write(frame: unknown): boolean {
    if (this.closedReason !== undefined) return false
    const stdin = this.process.stdin as (NodeJS.WritableStream & { writableEnded?: boolean; destroyed?: boolean }) | null
    // After close() a late reply (a permission answer resolved by the teardown itself) has nowhere to
    // go; dropping it is the correct answer, a throw would not be.
    if (!stdin || stdin.writableEnded || stdin.destroyed) return false
    try { stdin.write(JSON.stringify(frame) + "\n"); return true } catch (err) {
      this.settleClosed((err as Error).message)
      return false
    }
  }

  private settleClosed(reason: string): void {
    if (this.closedReason !== undefined) return
    this.closedReason = reason
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      if (p.timer) clearTimeout(p.timer)
      p.reject(new AcpConnectionClosed(p.method, reason))
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let raw: unknown
    try { raw = JSON.parse(line) } catch {
      this.options.onDiagnostic?.({ kind: "junk-line", message: line.slice(0, 500) })
      return
    }
    const parsed = JsonRpcInbound.safeParse(raw)
    if (!parsed.success) {
      this.options.onDiagnostic?.({ kind: "protocol", message: `unrecognized frame: ${line.slice(0, 500)}` })
      return
    }
    // The union is `.passthrough()` on every arm, so the narrowed members read as `unknown`; the
    // schema has already checked each shape, so the casts below only restate what it proved.
    const frame = parsed.data as { id?: JsonRpcId; method?: string; params?: unknown; result?: unknown; error?: JsonRpcError }
    if (typeof frame.method === "string") {
      if (frame.id !== undefined) this.handleRequest(frame.id, frame.method, frame.params)
      else this.options.onNotification(frame.method, frame.params)
      return
    }
    const id = frame.id as JsonRpcId
    const p = this.pending.get(id)
    if (!p) {
      if (this.options.onOrphanResponse?.({ id, ...(frame.error !== undefined ? { error: frame.error } : { result: frame.result }) })) return
      this.options.onDiagnostic?.({ kind: "protocol", message: `response to unknown request id ${String(id)}` })
      return
    }
    this.pending.delete(id)
    if (p.timer) clearTimeout(p.timer)
    if (frame.error !== undefined) p.reject(new AcpRemoteError(p.method, frame.error))
    else p.resolve(frame.result)
  }

  private handleRequest(id: JsonRpcId, method: string, params: unknown): void {
    void this.options.onRequest(method, params).then(
      (result) => { this.write({ jsonrpc: "2.0", id, result: result ?? {} }) },
      (err: unknown) => {
        const e = err instanceof AcpRequestError
          ? { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) }
          : { code: -32603, message: err instanceof Error ? err.message : String(err) }
        if (!(err instanceof AcpRequestError)) this.options.onDiagnostic?.({ kind: "unhandled-request", message: `${method}: ${e.message}` })
        this.write({ jsonrpc: "2.0", id, error: e })
      },
    )
  }
}
