// The NATIVE transport: host the Codex app-server on its own unix-socket listener
// (`codex app-server --listen unix://PATH`) instead of inside frizz's hand-written daemon.
//
// This is a drop-in `CodexAppServerHost` — same seam as `daemonCodexAppServerHost`, same
// `CodexAppServerProcess` shape out the other end — but there is no frizz-authored daemon process in
// the middle. frizz spawns the codex binary DETACHED and talks to it over a WebSocket on a socket path
// frizz chose. What the daemon was hand-building, the app-server already does:
//
//   - lifetime      codex is spawned `detached` + `stdio:"ignore"` + `unref()`, so it outlives this
//                   runtime. Verified: the listener survives a SIGKILL of the process that spawned it.
//   - reattachment  the socket keeps accepting after every client goes away, so the next frizz
//                   generation just connects again.
//   - handshake     `initialize` is per-CONNECTION here, not per-process. The daemon had to perform
//                   the handshake itself and replay a cached response to every reattaching client;
//                   over the native listener each connection runs its own real `initialize` and gets
//                   the real `userAgent`, so the bridge's version gate reads first-hand data.
//   - single owner  a second listener on a bound path exits 1 with "app-server control socket is
//                   already in use", so the binary itself enforces one-per-project.
//
// Deliberately NOT `codex app-server daemon start`: that uses a MACHINE-GLOBAL socket
// (`~/.codex/app-server-control/app-server-control.sock`) shared by every project and every frizz, and
// a codex-managed binary version. Spawning the listener ourselves keeps frizz's per-project socket
// path, its audited env allowlist, and its pinned `CODEX_APP_SERVER_SUPPORTED_VERSION`.
//
// KNOWN TRADE-OFF vs the daemon: while NO client is attached the app-server DROPS server->client
// events rather than queueing them (`codex-app-server-daemon.ts` queues). See the evidence in
// ../../../../scripts/research/README.md.
// A turn that ends during the gap is still recoverable — `thread/resume` reports
// `thread.status: {"type":"idle"}` and `thread/turns/list` reports the turn `completed` — and a
// pending approval is actively RE-ISSUED to the reattaching subscriber, which the queue never did
// better than. What is genuinely lost is transcript content streamed during the gap.
import { spawn } from "node:child_process"
import { connect } from "node:net"
import { Agent as HttpAgent } from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PassThrough, Writable, type Readable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import { WebSocket } from "ws"
import { frizzIpcPath } from "./ipc-path.ts"
import { codexAppServerArgv } from "./codex-mcp.ts"
import type { CodexAppServerProcess } from "./codex-app-server.ts"
import type { CodexAppServerAttachment, CodexAppServerHost, CodexAppServerHostOptions } from "./codex-app-server-host.ts"
import { log as frizzLog } from "../logging.ts"

export interface NativeListenerRecord {
  projectId: string
  /** Identity of the app-server PROCESS — stable across a frizz restart, new only when the listener
   *  itself was replaced. Drives the bridge's `sameProcess` check. */
  generation: string
  listenerPid: number
  socketPath: string
  createdAt: string
  /** Opaque ChatGPT account id present when this listener was spawned. */
  authAccountId?: string
}

function nativeDir(stateDir: string): string {
  return join(stateDir, "codex-app-server-native")
}

export function nativeRecordPath(stateDir: string, projectId: string): string {
  return join(nativeDir(stateDir), `${projectId}.json`)
}

/** Unix sockets have a hard ~104-byte path limit on macOS/BSD, so hash the identity into a short name
 *  — the same trick `codexAppServerSocketPath` uses for the daemon — and let ipc-path.ts spell it for
 *  the platform. Note that frizz does not SELECT this transport on Windows: `selectCodexHostKind`
 *  returns "daemon" there, because the listener is a codex process and codex's own `--listen` is the
 *  half that would have to bind the pipe. The win32 spelling still has to be right, because the
 *  adapter below is exercised on Windows by its own tests. */
export function nativeListenSocketPath(stateDir: string, projectId: string): string {
  const key = createHash("sha256").update(stateDir).update("\0").update(projectId).digest("hex").slice(0, 16)
  return frizzIpcPath(`frizz-codex-native-${key}`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function readNativeRecord(stateDir: string, projectId: string): NativeListenerRecord | null {
  try {
    const value = JSON.parse(readFileSync(nativeRecordPath(stateDir, projectId), "utf8")) as Partial<NativeListenerRecord>
    if (typeof value.listenerPid !== "number" || typeof value.socketPath !== "string" || typeof value.generation !== "string") return null
    return {
      projectId,
      generation: value.generation,
      listenerPid: value.listenerPid,
      socketPath: value.socketPath,
      createdAt: value.createdAt ?? "",
      ...(typeof value.authAccountId === "string" && value.authAccountId ? { authAccountId: value.authAccountId } : {}),
    }
  } catch {
    return null
  }
}

/** A listener is live only while its process is running AND its socket is still bound; the app-server
 *  unlinks the socket on a clean exit, so a missing socket is proof it is gone. */
export function liveNativeRecord(stateDir: string, projectId: string): NativeListenerRecord | null {
  const record = readNativeRecord(stateDir, projectId)
  if (!record) return null
  if (pidAlive(record.listenerPid) && existsSync(record.socketPath)) return record
  try { unlinkSync(nativeRecordPath(stateDir, projectId)) } catch {}
  return null
}

/** Terminate the listener. Only for an explicit teardown — never for a restart: this transport's
 *  entire value is that the listener OUTLIVES frizz, so nothing on the shutdown path may call this.
 *  Inert when there is no record, which is every project not on this transport. */
export function killNativeListener(stateDir: string, projectId: string): void {
  const record = liveNativeRecord(stateDir, projectId)
  if (!record) return
  try { process.kill(record.listenerPid, "SIGTERM") } catch {}
  try { unlinkSync(nativeRecordPath(stateDir, projectId)) } catch {}
}

/**
 * `killNativeListener`, then WAIT for the listener to actually be gone.
 *
 * The native sibling of `stopCodexAppServerDaemon`, and it exists for the same reason that one does:
 * version skew. A listener is a codex process that was spawned from the binary as it stood at spawn
 * time, so once codex is upgraded on disk every reattach re-runs `initialize` against the OLD build
 * and reports the OLD userAgent. The bridge's version gate rejects it identically on every connect,
 * and the only cure is to end the listener so the next attach spawns the new binary.
 *
 * The wait is correctness, not politeness: the socket path is DERIVED from stateDir + projectId, and
 * the app-server unlinks it on its way out. Start a replacement before the old one has finished dying
 * and the corpse unlinks the NEW listener's socket, leaving a record that looks live and a socket
 * nothing can connect to.
 */
export async function stopNativeListener(stateDir: string, projectId: string, timeoutMs = 10_000): Promise<void> {
  const record = liveNativeRecord(stateDir, projectId)
  killNativeListener(stateDir, projectId)
  if (!record) return
  const deadline = Date.now() + timeoutMs
  while (pidAlive(record.listenerPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  // A listener that ignored SIGTERM is worse than one that is merely stale: it still holds the socket.
  // SIGKILL leaves the socket file behind unlinked-by-nobody, which `startListener` already clears
  // once it has proven nothing is accepting on it.
  if (pidAlive(record.listenerPid)) {
    try { process.kill(record.listenerPid, "SIGKILL") } catch {}
    while (pidAlive(record.listenerPid) && Date.now() < deadline + 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

/** True when something is actually accepting on `socketPath` right now. */
function socketAccepting(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath)
    const done = (value: boolean): void => { probe.destroy(); resolve(value) }
    probe.once("connect", () => done(true))
    probe.once("error", () => done(false))
    setTimeout(() => done(false), 2_000).unref?.()
  })
}

/**
 * Open a WebSocket to a local IPC endpoint — a unix socket on POSIX, a named pipe on Windows.
 *
 * `perMessageDeflate: false` is REQUIRED in both spellings, not a tuning knob. `ws` offers
 * permessage-deflate by default and the listener's tungstenite rejects the whole upgrade over it with
 * "Missing, duplicated or incorrect header sec-websocket-extensions".
 *
 * The two spellings differ because `ws` can only be pointed at a unix socket through a `ws+unix:`
 * URL, and that URL cannot express `\\.\pipe\…`: the WHATWG parser rejects the backslashes outright
 * ("Invalid URL"), and every escaping of them that does parse dials the wrong thing — forward slashes
 * give `connect UNKNOWN //pipe/<name>`, percent-encoding gives `connect EPERM /`. Measured on Windows
 * Server 2022 / node 26.7.0. `ws` also forces `socketPath: undefined` over anything the caller passes,
 * so the option is not a way out either.
 *
 * What IS left is `agent`, which `ws` hands straight to `http.request` — so on win32 the endpoint is
 * dialed by an agent that connects the pipe itself. Verified on the same box against a real
 * `WebSocketServer` bound to a pipe, with a negative control (an agent pointed at a pipe that does not
 * exist fails ENOENT rather than silently succeeding).
 *
 * POSIX deliberately keeps the `ws+unix:` URL byte-identical to what has always shipped: that path
 * runs against real codex, whose tungstenite is stricter than a node `WebSocketServer`, and the two
 * forms do not send the same `Host` header.
 */
function ipcWebSocket(endpoint: string): WebSocket {
  if (process.platform !== "win32") return new WebSocket(`ws+unix://${endpoint}:/`, { perMessageDeflate: false })
  class PipeAgent extends HttpAgent {
    createConnection(): ReturnType<typeof connect> { return connect(endpoint) }
  }
  return new WebSocket("ws://localhost/", { agent: new PipeAgent(), perMessageDeflate: false })
}

/**
 * A `CodexAppServerProcess` backed by a WebSocket to the listener rather than by a child's stdio.
 *
 * The bridge speaks newline-delimited JSON in both directions, the listener speaks one JSON-RPC
 * message per WebSocket frame, so this adapter is purely a framing translation.
 *
 * `kill()` DETACHES. It closes this WebSocket and leaves the app-server — and every turn running
 * inside it — alone. That one line is what makes quitting frizz leave Codex running.
 */
function attach(record: NativeListenerRecord, timeoutMs: number): Promise<CodexAppServerProcess> {
  return new Promise((resolve, reject) => {
    const socket = ipcWebSocket(record.socketPath)
    const stdout = new PassThrough()
    const stderr = new PassThrough()   // the listener has no stderr channel of its own over the socket
    const listeners = { exit: [] as (() => void)[], error: [] as ((error: Error) => void)[] }
    let settled = false
    let ended = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.terminate()
      reject(new Error("codex app-server native listener attach timed out"))
    }, timeoutMs)
    timer.unref?.()

    // The bridge writes newline-delimited JSON; each complete line becomes exactly one frame.
    const decoder = new StringDecoder("utf8")
    let outbound = ""
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        outbound += decoder.write(chunk as Buffer)
        for (;;) {
          const index = outbound.indexOf("\n")
          if (index < 0) break
          const line = outbound.slice(0, index).trim()
          outbound = outbound.slice(index + 1)
          if (!line) continue
          try { socket.send(line) } catch (error) { callback(error as Error); return }
        }
        callback()
      },
    })

    const handle: CodexAppServerProcess = {
      stdin,
      stdout: stdout as unknown as Readable,
      stderr: stderr as unknown as Readable,
      on(event: "exit" | "error", listener: never) {
        if (event === "exit") listeners.exit.push(listener as unknown as () => void)
        else listeners.error.push(listener as unknown as (error: Error) => void)
        return handle as never
      },
      kill() { socket.close(); return true },
    } as CodexAppServerProcess

    socket.on("open", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(handle)
    })
    socket.on("message", (data) => {
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8")
      const trimmed = text.trim()
      if (trimmed) stdout.write(`${trimmed}\n`)
    })

    const finish = (error?: Error): void => {
      if (ended) return
      ended = true
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(error ?? new Error("codex app-server native listener closed the attachment"))
        return
      }
      // A connection the bridge can no longer speak on IS a dead process from its point of view, and
      // its reconnect path already handles exactly that.
      for (const listener of listeners.exit) listener()
    }
    socket.on("close", () => finish())
    socket.on("error", (error) => {
      for (const l of listeners.error) l(error)
      finish(error)
    })
  })
}

async function startListener(options: CodexAppServerHostOptions): Promise<NativeListenerRecord> {
  const { stateDir, projectId } = options
  mkdirSync(nativeDir(stateDir), { recursive: true })
  const socketPath = nativeListenSocketPath(stateDir, projectId)

  // The app-server unlinks its socket on a clean exit, so a file left here belongs to a listener that
  // was SIGKILLed or crashed. bind() fails on an existing path either way, so clear it — but only
  // after proving nobody is accepting, so we can never unlink a live peer's socket.
  if (existsSync(socketPath) && !(await socketAccepting(socketPath))) {
    try { unlinkSync(socketPath) } catch {}
  }

  const generation = randomUUID()
  const child = spawn(options.codexBin, codexAppServerArgv(["--listen", `unix://${socketPath}`], options.frizzMcp), {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: "ignore",
  })
  child.unref()

  const record: NativeListenerRecord = {
    projectId,
    generation,
    listenerPid: child.pid ?? -1,
    socketPath,
    createdAt: new Date().toISOString(),
    ...(options.authAccountId ? { authAccountId: options.authAccountId } : {}),
  }
  // Published BEFORE the socket is up: a runtime that dies during startup must still leave the next
  // one a way to find (and if need be reap) the listener it created.
  writeFileSync(nativeRecordPath(stateDir, projectId), JSON.stringify(record))

  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  for (;;) {
    if (existsSync(socketPath) && await socketAccepting(socketPath)) return record
    if (!pidAlive(record.listenerPid)) throw new Error("codex app-server listener exited before it became ready")
    if (Date.now() > deadline) throw new Error("codex app-server listener did not become ready")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// Every reattach over this transport is LOSSY, and unlike the daemon it cannot say by how much.
//
// Two independent reasons, both verified against 0.144.6:
//   1. The app-server DROPS server->client events while no client is attached — it has no queue, and
//      no counter to report if it did.
//   2. Subscriptions are PER-CONNECTION. `thread/start` and `thread/resume` "auto-subscribe you", and
//      `thread/unsubscribe` removes "the current connection's subscription". A brand-new WebSocket is
//      therefore subscribed to NOTHING, so a rejoin that skipped `thread/resume` would sit waiting on
//      a `turn/completed` that this connection was never going to be sent.
//
// The daemon has neither problem: it holds ONE never-closing stdio connection to the app-server, so
// its subscription never lapses and it can queue and count what it withheld. So where the daemon
// reports a real overflow count, this host reports a fixed non-zero sentinel — "presume holes" — which
// is what `sameProcess` in codex-app-server.ts consumes it as (`droppedWhileDetached === 0`).
//
// That is NOT this host guessing that the turn died. It routes the rejoin through `thread/resume`,
// which is the one call that both re-subscribes this connection AND reports `thread.status` — so
// reconcileOwnedSessions then reads the turn's real state off the answer instead of inferring it from
// a stream that has holes: `{"type":"active"}` keeps the live turn exactly as it was, `{"type":"idle"}`
// retires a turn whose `turn/completed` was dropped. Guessing either way is wrong somewhere; asking is
// wrong nowhere, and only this transport is obliged to ask. For it the cold path is not a fallback, it
// is the correct rejoin.
const PRESUMED_LOSSY_REJOIN = 1

/**
 * The native host: reattach to this project's listener, or start one if there is none.
 *
 * Same failure posture as the daemon host — the transport buys turn survival, and Codex itself does
 * not need it, so a listener that will not start costs the survival property and never Codex.
 */
export const nativeListenCodexAppServerHost: CodexAppServerHost = async (options): Promise<CodexAppServerAttachment> => {
  const timeoutMs = options.timeoutMs ?? 30_000
  const existing = liveNativeRecord(options.stateDir, options.projectId)
  if (existing) {
    try {
      return {
        process: await attach(existing, timeoutMs),
        generation: existing.generation,
        reattached: true,
        daemonPid: existing.listenerPid,
        droppedWhileDetached: PRESUMED_LOSSY_REJOIN,
        authAccountId: existing.authAccountId,
      }
    } catch {
      // The record outlived its socket. Drop it and start fresh rather than failing the connect.
      try { unlinkSync(nativeRecordPath(options.stateDir, options.projectId)) } catch {}
    }
  }
  try {
    const record = await startListener(options)
    // A listener WE just started has no detached window behind it and nothing could have been missed.
    return {
      process: await attach(record, timeoutMs),
      generation: record.generation,
      reattached: false,
      daemonPid: record.listenerPid,
      droppedWhileDetached: 0,
      authAccountId: record.authAccountId,
    }
  } catch (error) {
    // A concurrent frizz may have won the bind between our probe and our spawn ("app-server control
    // socket is already in use"). Its record is authoritative; join it rather than fighting for it.
    const raced = liveNativeRecord(options.stateDir, options.projectId)
    if (raced) {
      return {
        process: await attach(raced, timeoutMs),
        generation: raced.generation,
        reattached: true,
        daemonPid: raced.listenerPid,
        droppedWhileDetached: PRESUMED_LOSSY_REJOIN,
        authAccountId: raced.authAccountId,
      }
    }
    frizzLog.error("codex", `codex app-server native listener unavailable (${(error as Error).message}); falling back to an in-process app-server — turns will NOT survive a frizz restart`)
    const child = spawn(options.codexBin, codexAppServerArgv(["--stdio"], options.frizzMcp), { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
    return { process: child as unknown as CodexAppServerProcess, generation: randomUUID(), reattached: false, daemonPid: process.pid, droppedWhileDetached: 0, authAccountId: options.authAccountId }
  }
}
