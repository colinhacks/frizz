// The detached ACP agent daemon: ONE per ACP thread. It owns the agent child (`opencode acp`,
// `gemini --acp`, …) and serves its JSON-RPC over a local socket, so the agent OUTLIVES the disposable
// frizz runtime that spawned it — which is what lets an in-flight ACP turn, and every sub-agent the
// agent runs inside its own process, survive a Frizz restart or crash. It buys an ACP thread the same
// immunity a Codex thread gets from the app-server daemon (codex-app-server-daemon.ts) and a Claude
// thread from its session broker (claude-agent-broker.ts): forked `detached: true` into its own process
// group, not a child of frizz.
//
// Before this existed the agent was an ordinary stdio child of the runtime: every restart closed its
// stdin and the agent exited with it (the protocol's own teardown), taking the running turn and its
// sub-agents along — the one documented gap between ACP and the other two transports until 2026-09-24.
//
// What the daemon does on the wire, so a RESTARTED bridge can carry on as if nothing happened:
//   - client REQUEST ids are rewritten into the daemon's own id space, so a new client that restarts
//     its counter at 1 can never collide with an id the dead client left in flight; responses are
//     mapped back onto whichever client id currently owns them;
//   - the first `initialize` passes through and its response is CACHED — a reattaching client sends
//     its own `initialize` and is answered from the cache, because ACP initializes a connection once;
//   - the ACP session id is remembered from `session/new`'s result (or `session/load`'s params) and
//     reported in the hello, so the reattaching client adopts the session instead of opening another;
//   - every request still OUTSTANDING (above all a `session/prompt` — the turn) is listed in the hello
//     with its daemon id, and the client re-owns it with an `adopt` control frame naming its new id;
//   - while nobody is attached (the restart window) every child→client line is QUEUED, so the turn's
//     `session/update` stream, its final response and any `session/request_permission` the agent
//     raised meanwhile are replayed, in order, the moment the next runtime attaches.
//
// Launched by forkAcpDaemon() in acp-host.ts, which passes its whole config as JSON in
// FRIZZ_ACP_DAEMON. This process has no stdio (stdio:"ignore"); its only interface is the socket and
// the on-disk record file.
import { spawn } from "node:child_process"
import { createServer, type Socket } from "node:net"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { sweepStaleSockets } from "./stale-socket-sweep.ts"
import { socketPathOwnership } from "./socket-ownership.ts"
import { selfProcessStart } from "./daemon-identity.ts"

interface DaemonConfig {
  threadSlug: string
  sessionId: string
  socketPath: string
  recordPath: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  generation: string
  /** Test seam only; production leaves this undefined and gets REACHABILITY_CHECK_MS. */
  reachabilityCheckMs?: number
  /** Test seam only; production leaves this undefined and gets IDLE_EXIT_MS. */
  idleExitMs?: number
}

// Same caps and reasoning as the codex daemon: a detached client must not make the daemon grow without
// bound, but dropping traffic silently would lose exactly the frames this daemon exists to preserve.
const MAX_QUEUED_LINES = 20_000
const MAX_QUEUED_BYTES = 64 * 1024 * 1024
const MAX_LINE_BYTES = 8 * 1024 * 1024
// A daemon whose frizz never comes back must not live forever. Reattach happens within seconds of a
// real restart, so anything still unattached after this is genuinely abandoned.
const IDLE_EXIT_MS = 6 * 60 * 60 * 1000
const REACHABILITY_CHECK_MS = 30_000
const REACHABILITY_STRIKES = 2

function readConfig(): DaemonConfig {
  const raw = process.env.FRIZZ_ACP_DAEMON
  if (!raw) throw new Error("acp daemon started without FRIZZ_ACP_DAEMON")
  const config = JSON.parse(raw) as DaemonConfig
  if (!config.socketPath || !config.recordPath || !config.command || !config.generation || !config.sessionId) {
    throw new Error("acp daemon config is incomplete")
  }
  return config
}

/** Split a byte stream into complete JSONL lines. Over-long lines are dropped, never truncated into
 *  a half-message that would desync the peer's parser. */
function lineReader(onLine: (line: string) => void, onOverflow: () => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder("utf8")
  let buffer = ""
  let overflowed = false
  return (chunk) => {
    buffer += decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    for (;;) {
      const index = buffer.indexOf("\n")
      if (index < 0) break
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (overflowed) { overflowed = false; continue }
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { onOverflow(); continue }
      const trimmed = line.trim()
      if (trimmed) onLine(trimmed)
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      buffer = ""
      if (!overflowed) onOverflow()
      overflowed = true
    }
  }
}

function main(): void {
  const config = readConfig()
  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: config.env,
    stdio: ["pipe", "pipe", "pipe"],
    // This daemon is forked `detached`, which on Windows is DETACHED_PROCESS: it owns NO console, and a
    // console-subsystem agent started without CREATE_NO_WINDOW would get a fresh visible one.
    windowsHide: true,
  }) as ReturnType<typeof spawn> & { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream }

  let client: Socket | null = null
  let queuedLines: string[] = []
  let queuedBytes = 0
  let dropped = 0
  let idleTimer: NodeJS.Timeout | null = null
  let published = false
  // Whether the socket PATH still leads to the socket this daemon bound — by inode, not by name, since
  // every daemon for this session binds the same path (socket-ownership.ts). "Ours" until listen.
  let socketPathIsOurs: () => boolean = () => true

  /** The pid the record file currently names, or null when there is no readable record. */
  const recordOwner = (): number | null => {
    try {
      const value = JSON.parse(readFileSync(config.recordPath, "utf8")) as { daemonPid?: unknown }
      return typeof value.daemonPid === "number" ? value.daemonPid : null
    } catch {
      return null
    }
  }

  const cleanup = (): void => {
    try { client?.destroy() } catch {}
    // Both paths are DERIVED from (stateDir, sessionId), so a successor daemon owns the very same record
    // and socket names. Only ever remove what is still ours.
    const owner = recordOwner()
    if (owner === process.pid) { try { unlinkSync(config.recordPath) } catch {} }
    if (published && owner !== null && owner !== process.pid) return
    // The socket is checked by inode too: the record is ABSENT exactly while a host forks a successor
    // (forkDaemon unlinks it first), and "no owner" is not "mine". Never `server.close()` here either —
    // libuv unlinks a unix socket's path by name on close. See codex-app-server-daemon.ts's cleanup.
    if (published && process.platform !== "win32" && socketPathIsOurs()) { try { unlinkSync(config.socketPath) } catch {} }
  }

  // Why this daemon — and the agent + every turn inside it — is about to end. The bridge only ever SEES
  // a socket close; the breadcrumb, keyed by generation, is the only record of the real cause.
  const writeExitBreadcrumb = (reason: string, detail?: string): void => {
    try {
      writeFileSync(`${config.recordPath}.exit`, JSON.stringify({
        threadSlug: config.threadSlug,
        sessionId: config.sessionId,
        generation: config.generation,
        daemonPid: process.pid,
        childPid: child.pid ?? null,
        reason,
        // The message and stack of a crash (see `crash`). `reason` stays a short word a reader can match.
        ...(detail ? { detail } : {}),
        at: new Date().toISOString(),
      }))
    } catch {}
  }
  const die = (code: number, reason: string, detail?: string): never => { writeExitBreadcrumb(reason, detail); cleanup(); process.exit(code) }

  const armIdleExit = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { try { child.kill("SIGTERM") } catch {}; die(0, "idle-timeout") }, config.idleExitMs ?? IDLE_EXIT_MS)
    idleTimer.unref?.()
  }

  // ---- self-collection (see codex-app-server-daemon.ts for the full reasoning) ------------------
  // Discoverable only through the record file AND the socket path it names; a daemon whose record
  // vanished or names a successor, or whose socket file is gone, can never be attached to again.
  // Gated on being UNATTACHED, so the restart window — record and socket untouched — is invisible to
  // it, and two strikes so one unlucky stat cannot end a turn.
  let unreachableStrikes = 0
  const checkReachable = (): void => {
    if (client) { unreachableStrikes = 0; return }
    const recorded = recordOwner() === process.pid
    if (recorded && socketPathIsOurs()) { unreachableStrikes = 0; return }
    if (++unreachableStrikes < REACHABILITY_STRIKES) return
    try { child.kill("SIGTERM") } catch {}
    die(0, recorded ? "self-collected-socket-lost" : "self-collected-record-reassigned")
  }

  // ---- child -> client ----------------------------------------------------------------------------
  const toClient = (line: string): void => {
    if (client) { try { client.write(`${line}\n`); return } catch { /* fall through to queue */ } }
    if (queuedLines.length >= MAX_QUEUED_LINES || queuedBytes >= MAX_QUEUED_BYTES) { dropped++; return }
    queuedLines.push(line)
    queuedBytes += Buffer.byteLength(line) + 1
  }
  const control = (payload: Record<string, unknown>): string => JSON.stringify({ frizz: 1, ...payload })

  // ---- id bookkeeping -----------------------------------------------------------------------------
  // daemon id -> the client id that currently owns the request (rewritten by `adopt` after a restart),
  // plus the method so the hello can tell a reattaching client what is still in flight.
  const pendingFromClient = new Map<number, { clientId: string | number; method: string; params?: unknown }>()
  let nextDaemonId = 1_000_000 // start well clear of any client's id space
  let initializeResult: unknown = null
  let initializeDaemonId: number | null = null
  let acpSessionId: string | null = null

  const toChild = (message: unknown): void => {
    try { child.stdin.write(`${JSON.stringify(message)}\n`) } catch {}
  }

  const readChildLine = (line: string): void => {
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { toClient(line); return }
    // A RESPONSE to a client request: map it back onto the id the client actually used, and remember
    // what the handshake and the session opener answered.
    if (message.id !== undefined && message.method === undefined && typeof message.id === "number") {
      const owner = pendingFromClient.get(message.id)
      if (owner !== undefined) {
        pendingFromClient.delete(message.id)
        if (message.id === initializeDaemonId && message.error === undefined) initializeResult = message.result ?? null
        if (owner.method === "session/new" && message.error === undefined) {
          const result = message.result as { sessionId?: unknown } | undefined
          if (typeof result?.sessionId === "string") acpSessionId = result.sessionId
        }
        if (owner.method === "session/load" && message.error === undefined) {
          const params = owner.params as { sessionId?: unknown } | undefined
          if (typeof params?.sessionId === "string") acpSessionId = params.sessionId
        }
        toClient(JSON.stringify({ ...message, id: owner.clientId }))
        return
      }
    }
    // A request from the agent (session/request_permission): remembered until a client answers it, so a
    // client that died holding the card can be replaced by one that gets the request again (below).
    if (message.id !== undefined && message.method !== undefined) {
      pendingFromChild.set(String(message.id), { line, queued: client === null })
    }
    toClient(line)
  }

  // Agent-initiated requests nobody has answered yet, by the agent's own id. A permission request
  // delivered to a client that then died (a restart with a card open) would otherwise wait forever:
  // the daemon only replays what it QUEUED while detached, and this one was delivered. On attach, any
  // entry that is not already in the queue is sent again, so the new runtime raises the card afresh.
  const pendingFromChild = new Map<string, { line: string; queued: boolean }>()

  // ---- client -> child ----------------------------------------------------------------------------
  const readClientLine = (line: string): void => {
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
    if (message.frizz === 1) {
      // `adopt`: a reattached client takes ownership of a request the dead client left in flight.
      const adopt = message.adopt as { daemonId?: unknown; clientId?: unknown } | undefined
      if (adopt && typeof adopt.daemonId === "number" && (typeof adopt.clientId === "number" || typeof adopt.clientId === "string")) {
        const owner = pendingFromClient.get(adopt.daemonId)
        if (owner) owner.clientId = adopt.clientId
      }
      return
    }
    if (message.method === "initialize" && initializeResult !== null) {
      // The agent is already initialized; answer the reattaching client from the cache.
      if (message.id !== undefined) toClient(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: initializeResult }))
      return
    }
    if (message.id !== undefined && message.method !== undefined) {
      const daemonId = nextDaemonId++
      pendingFromClient.set(daemonId, { clientId: message.id as string | number, method: String(message.method), params: message.params })
      if (message.method === "initialize" && initializeDaemonId === null) initializeDaemonId = daemonId
      toChild({ ...message, id: daemonId })
      return
    }
    // A RESPONSE to an agent-initiated request (a permission answer), or a notification
    // (session/cancel): ids here are the agent's own and pass through untouched.
    if (message.id !== undefined && message.method === undefined) pendingFromChild.delete(String(message.id))
    toChild(message)
  }

  const processStart = selfProcessStart()
  const writeRecord = (): void => {
    writeFileSync(config.recordPath, JSON.stringify({
      threadSlug: config.threadSlug,
      sessionId: config.sessionId,
      generation: config.generation,
      daemonPid: process.pid,
      ...(processStart ? { processStart } : {}),
      childPid: child.pid,
      socketPath: config.socketPath,
      createdAt: new Date().toISOString(),
    }))
  }

  const server = createServer((sock) => {
    // One client at a time: a new frizz generation supersedes the old one's socket outright.
    if (client) { try { client.destroy() } catch {} }
    client = sock
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    sock.setNoDelay(true)
    try {
      sock.write(`${control({
        hello: 1,
        generation: config.generation,
        childPid: child.pid,
        droppedWhileDetached: dropped,
        initialize: initializeResult,
        acpSessionId,
        outstanding: [...pendingFromClient].map(([daemonId, owner]) => ({ daemonId, method: owner.method })),
      })}\n`)
      // Flush everything the agent said while nobody was listening, in order, before live traffic —
      // then re-send any agent request an earlier client took delivery of and never answered.
      for (const line of queuedLines) sock.write(`${line}\n`)
      for (const entry of pendingFromChild.values()) {
        if (!entry.queued) sock.write(`${entry.line}\n`)
        entry.queued = false
      }
    } catch {}
    queuedLines = []
    queuedBytes = 0
    dropped = 0
    sock.on("data", lineReader((line) => {
      if (!sock.destroyed) readClientLine(line)
    }, () => sock.destroy()))
    const drop = (): void => {
      if (client !== sock) return
      client = null
      armIdleExit()
    }
    sock.on("close", drop)
    sock.on("error", drop)
  })

  const sweepOwnFamily = (): void =>
    sweepStaleSockets({ dir: dirname(config.socketPath), prefix: "frizz-acp-", keep: [config.socketPath] })

  const startListening = (): void => {
    if (process.platform !== "win32" && existsSync(config.socketPath)) { try { unlinkSync(config.socketPath) } catch {} }
    server.on("error", () => die(6, "socket-listen-error"))
    server.listen(config.socketPath, () => {
      published = true
      socketPathIsOurs = socketPathOwnership(config.socketPath)
      writeRecord()
      armIdleExit()
      const reachability = setInterval(checkReachable, config.reachabilityCheckMs ?? REACHABILITY_CHECK_MS)
      reachability.unref?.()
      setTimeout(sweepOwnFamily, 5_000).unref?.()
    })
  }

  child.stdout.on("data", lineReader(readChildLine, () => {
    // Losing a frame must not look like a lossless stream: detach without killing the agent, and let
    // the next hello report the drop.
    dropped++
    const lostClient = client
    client = null
    lostClient?.destroy()
    armIdleExit()
  }))
  // stderr is the agent's only debugging channel. Forward it to an attached client as a control frame
  // (the client's adapter presents it as the process's stderr); while detached it is discarded.
  child.stderr.on("data", (chunk: Buffer | string) => {
    if (!client) return
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue
      try { client.write(`${control({ stderr: line.slice(0, 2_000) })}\n`) } catch {}
    }
  })
  child.on("exit", (code, signal) => die(0, signal ? `agent-killed-${signal}` : `agent-exited-code-${code ?? "null"}`))
  child.on("error", () => die(4, "agent-spawn-error"))

  // Unlike the codex daemon there is no handshake of the daemon's own: the ACP `initialize` carries the
  // bridge's client capabilities, so the first client sends it and the daemon caches the answer.
  startListening()

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => { try { child.kill("SIGTERM") } catch {}; die(0, `signal-${signal}`) })
  }

  // A THROW NOBODY CAUGHT LEFT NOTHING BEHIND. This daemon is forked with `stdio: "ignore"`, so node's
  // own answer to one (print a stack, exit 1) printed to nowhere and wrote no breadcrumb: the bridge saw
  // a socket close with no cause, which is also all a SIGKILL leaves. The Claude broker has recorded
  // these since 2026-08-02, after 53 of its 276 deaths could not be attributed at all; this daemon was
  // copied from it without them. Recorded and then exited NON-ZERO, as node would have: installing a
  // handler is what suppresses the default exit, so the exit here is the load-bearing line.
  const crash = (reason: "uncaught-exception" | "unhandled-rejection", error: unknown): never => {
    try { child.kill("SIGTERM") } catch {}
    return die(1, reason, (error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)).slice(0, 2000))
  }
  process.on("uncaughtException", (error) => crash("uncaught-exception", error))
  process.on("unhandledRejection", (reason) => crash("unhandled-rejection", reason))
}

main()
