// The detached Codex app-server daemon: ONE per project. It owns the `codex app-server --stdio`
// child and serves its JSON-RPC over a local socket, so the app-server OUTLIVES the disposable frizz
// runtime that spawned it — which is what makes an in-flight codex turn survive Update & Restart.
// It buys Codex the same immunity a Claude thread gets from ITS OWN detached daemon — the session
// broker (claude-broker-host.ts), likewise forked with `detached: true` into its own process group and
// likewise not a child of frizz. That is the mechanism today, and only today: until the multiplexer was
// stripped on 2026-08-02 a Claude thread got the immunity from tmux instead, and an earlier PTY session
// broker had been removed as dead code before that. Nothing here runs a multiplexer.
//
// Before this existed the app-server was an ordinary stdio child of the runtime: every restart
// SIGTERMed it and every in-flight turn died mid-sentence with no `task_complete`, no `turn_aborted`
// and no resume — the thread simply went quiet until a human typed something (diagnosed 2026-07-23,
// and the same event on 2026-07-22 that killed four threads at once).
//
// Launched by ensureCodexAppServerDaemon() in codex-app-server-host.ts, which passes its whole config
// as JSON in FRIZZ_CODEX_APP_SERVER_DAEMON. This process has no stdio (stdio:"ignore"); its only
// interface is the socket and the on-disk record file.
import { spawn } from "node:child_process"
import { createServer, type Socket } from "node:net"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { sweepStaleSockets } from "./stale-socket-sweep.ts"

interface DaemonConfig {
  projectId: string
  socketPath: string
  recordPath: string
  codexBin: string
  cwd: string
  env: Record<string, string>
  generation: string
  clientInfo: Record<string, unknown>
  capabilities: Record<string, unknown>
  /** Opaque ChatGPT account id present when the app-server child was spawned. */
  authAccountId?: string
  /** Full argv for the app-server, built by the host (codexAppServerArgv) so this daemon never has to
   *  resolve frizz's MCP descriptors itself. Absent ⇒ a bare `app-server --stdio`, which is a worker
   *  with NO mcp tools; kept as a fallback only so an older payload cannot fail to boot. */
  appServerArgs?: string[]
  /** Test seam only; production leaves this undefined and gets REACHABILITY_CHECK_MS. */
  reachabilityCheckMs?: number
}

// A detached client cannot be allowed to make the daemon grow without bound, but dropping traffic
// silently would lose exactly the events this daemon exists to preserve (`turn/completed`, approval
// requests). Cap generously and mark the overflow so the client learns it must not trust the stream.
const MAX_QUEUED_LINES = 20_000
const MAX_QUEUED_BYTES = 64 * 1024 * 1024
const MAX_LINE_BYTES = 8 * 1024 * 1024
// A daemon whose frizz never comes back must not live forever. Reattach happens within seconds of a
// real restart, so anything still unattached after this is genuinely abandoned.
const IDLE_EXIT_MS = 6 * 60 * 60 * 1000
const HANDSHAKE_TIMEOUT_MS = 30_000
// How often an UNATTACHED daemon re-checks that its record file still names it. See `checkReachable`.
const REACHABILITY_CHECK_MS = 30_000
// …and how many consecutive checks must agree before it collects itself. Two, so a single unlucky
// stat (a state dir being rewritten, an NFS hiccup) can never end an app-server on its own.
const REACHABILITY_STRIKES = 2

function readConfig(): DaemonConfig {
  const raw = process.env.FRIZZ_CODEX_APP_SERVER_DAEMON
  if (!raw) throw new Error("codex app-server daemon started without FRIZZ_CODEX_APP_SERVER_DAEMON")
  const config = JSON.parse(raw) as DaemonConfig
  if (!config.socketPath || !config.recordPath || !config.codexBin || !config.generation) {
    throw new Error("codex app-server daemon config is incomplete")
  }
  return config
}

/** Split a byte stream into complete JSONL lines. Over-long lines are dropped, never truncated into
 *  a half-message that would desync the peer's parser. */
function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
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
      const trimmed = line.trim()
      if (trimmed) onLine(trimmed)
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) { buffer = ""; overflowed = true }
  }
}

function main(): void {
  const config = readConfig()
  const child = spawn(config.codexBin, config.appServerArgs ?? ["app-server", "--stdio"], {
    cwd: config.cwd,
    env: config.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ReturnType<typeof spawn> & { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream }

  let client: Socket | null = null
  let queuedLines: string[] = []
  let queuedBytes = 0
  let dropped = 0
  let idleTimer: NodeJS.Timeout | null = null

  let published = false

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
    // Both paths are DERIVED from (stateDir, projectId), so a successor daemon owns the very same
    // record and socket names. Unlink them unconditionally and a corpse deletes the LIVE daemon's
    // discoverability on its way out. Only ever remove what is still ours.
    const owner = recordOwner()
    if (owner === process.pid) { try { unlinkSync(config.recordPath) } catch {} }
    if (published && owner !== null && owner !== process.pid) return
    if (published && process.platform !== "win32") { try { unlinkSync(config.socketPath) } catch {} }
  }

  // Why this daemon — and the app-server + every in-flight sub-agent turn inside it — is about to end.
  // The bridge only ever SEES a socket close; it cannot tell a codex child that panicked from a daemon
  // that self-collected from an idle expiry. This breadcrumb, keyed by generation, is the only record
  // of the real cause, and it was missing exactly when it was needed (the 2026-07-24 six-sub-agent loss
  // had no attributable cause at all). Best-effort, synchronous (the process is exiting), keyed by
  // generation so a successor's reader can tell whose death it describes. It never gates anything.
  const writeExitBreadcrumb = (reason: string): void => {
    try {
      writeFileSync(`${config.recordPath}.exit`, JSON.stringify({
        projectId: config.projectId,
        generation: config.generation,
        daemonPid: process.pid,
        childPid: child.pid ?? null,
        reason,
        at: new Date().toISOString(),
      }))
    } catch {}
  }
  const die = (code: number, reason: string): never => { writeExitBreadcrumb(reason); cleanup(); process.exit(code) }

  const armIdleExit = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { try { child.kill("SIGTERM") } catch {}; die(0, "idle-timeout") }, IDLE_EXIT_MS)
    idleTimer.unref?.()
  }

  // ---- self-collection ----------------------------------------------------------------------------
  // This daemon is DISCOVERABLE only through its record file: daemonCodexAppServerHost reads exactly
  // that one path. So a daemon whose record has vanished — or has been overwritten by a successor —
  // can never be attached to by anyone, ever, and holding a `codex app-server` (~150 MB, still able
  // to edit the filesystem) for the remaining six hours of IDLE_EXIT_MS is pure waste. Nothing else
  // collects these: the orphan reaper keys on FRIZZ_THREAD, which this per-PROJECT daemon does not
  // carry, and it explicitly protects any process named `codex` as a session root
  // (orphan-reaper.ts). Daemons forked from an agent worktree that was later deleted leaked exactly
  // this way, in pairs, at ~150 MB each.
  //
  // The check is gated on being UNATTACHED, and THAT is what keeps it clear of the one property this
  // daemon exists for. A normal Update & Restart never touches the record: the runtime dies, the
  // record sits there untouched, the next generation reads it and reattaches. So the restart window
  // — the one moment nobody is attached — is invisible to this check, because the record still names
  // us throughout it. Two consecutive strikes on top of that, so a single unlucky stat cannot end a
  // turn on its own.
  let unreachableStrikes = 0
  const checkReachable = (): void => {
    if (client) { unreachableStrikes = 0; return }
    if (recordOwner() === process.pid) { unreachableStrikes = 0; return }
    if (++unreachableStrikes < REACHABILITY_STRIKES) return
    try { child.kill("SIGTERM") } catch {}
    // The record no longer names us and nobody is attached: a successor daemon replaced us (a boot
    // race or a stale-record fork). If a turn was mid-flight when that happened, it dies here — this
    // reason is the fingerprint of that class of loss.
    die(0, "self-collected-record-reassigned")
  }

  // ---- server -> client ---------------------------------------------------------------------------
  // While nobody is attached (the restart window) every line is QUEUED rather than dropped. Losing a
  // `turn/completed` here would wedge the thread's `current_turn_id` forever; losing an approval
  // request would hang the turn on a card that never appears.
  const toClient = (line: string): void => {
    if (client) { try { client.write(`${line}\n`); return } catch { /* fall through to queue */ } }
    if (queuedLines.length >= MAX_QUEUED_LINES || queuedBytes >= MAX_QUEUED_BYTES) { dropped++; return }
    queuedLines.push(line)
    queuedBytes += Buffer.byteLength(line) + 1
  }
  const control = (payload: Record<string, unknown>): string => JSON.stringify({ frizz: 1, ...payload })

  // ---- handshake ----------------------------------------------------------------------------------
  // The daemon performs `initialize` ITSELF, once, and caches the response. A reattaching client is
  // answered from that cache: re-initializing a live app-server is not something the protocol allows,
  // and the client must still be able to run its version gate on the real userAgent.
  const HANDSHAKE_ID = -1
  let initializeResult: unknown
  let handshakeDone = false
  const pendingFromClient = new Map<number, string | number>() // daemon id -> client id
  let nextDaemonId = 1_000_000 // start well clear of any client's id space

  const toServer = (message: unknown): void => {
    try { child.stdin.write(`${JSON.stringify(message)}\n`) } catch {}
  }

  const readServerLine = (line: string): void => {
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
    // Handshake response is consumed by the daemon, never forwarded.
    if (!handshakeDone && message.id === HANDSHAKE_ID) {
      if (message.error) die(3, "handshake-rejected")
      initializeResult = message.result
      handshakeDone = true
      toServer({ method: "initialized" })
      // Only now start accepting clients. Listening earlier would let one connect and be answered
      // with an empty `initialize` result, failing its version gate for no reason.
      startListening()
      return
    }
    // Map a response back onto the id the client actually used.
    if (message.id !== undefined && message.method === undefined && typeof message.id === "number") {
      const clientId = pendingFromClient.get(message.id)
      if (clientId !== undefined) {
        pendingFromClient.delete(message.id)
        toClient(JSON.stringify({ ...message, id: clientId }))
        return
      }
    }
    toClient(line)
  }

  // ---- client -> server ---------------------------------------------------------------------------
  const readClientLine = (line: string): void => {
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
    // The client's own `initialize` is served from cache — the live app-server is already initialized.
    if (message.method === "initialize") {
      if (message.id !== undefined) toClient(JSON.stringify({ id: message.id, result: initializeResult }))
      return
    }
    if (message.method === "initialized") return // already sent once, at handshake
    if (message.id !== undefined && message.method !== undefined) {
      // A REQUEST from the client. Rewrite its id into the daemon's space so a restarted client that
      // restarts its own counter at 1 can never collide with an id the dead client left in flight.
      const daemonId = nextDaemonId++
      pendingFromClient.set(daemonId, message.id as string | number)
      toServer({ ...message, id: daemonId })
      return
    }
    // A RESPONSE to a server-initiated request (approvals), or a notification: ids here are the
    // server's own and must pass through untouched.
    toServer(message)
  }

  // The record is the daemon's readiness signal, published only once the socket is actually accepting
  // and the handshake is cached — so a client that finds a record can always be served immediately.
  const writeRecord = (): void => {
    writeFileSync(config.recordPath, JSON.stringify({
      projectId: config.projectId,
      generation: config.generation,
      daemonPid: process.pid,
      childPid: child.pid,
      socketPath: config.socketPath,
      createdAt: new Date().toISOString(),
      ...(config.authAccountId ? { authAccountId: config.authAccountId } : {}),
    }))
  }

  const server = createServer((sock) => {
    // One client at a time: a new frizz generation supersedes the old one's socket outright.
    if (client) { try { client.destroy() } catch {} }
    client = sock
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    sock.setNoDelay(true)
    try {
      sock.write(`${control({ hello: 1, generation: config.generation, childPid: child.pid, droppedWhileDetached: dropped })}\n`)
      // Flush everything the app-server said while nobody was listening, in order, before live traffic.
      for (const line of queuedLines) sock.write(`${line}\n`)
    } catch {}
    queuedLines = []
    queuedBytes = 0
    dropped = 0
    sock.on("data", lineReader(readClientLine))
    const drop = (): void => {
      if (client !== sock) return
      client = null
      armIdleExit()
    }
    sock.on("close", drop)
    sock.on("error", drop)
  })

  // ---- stale socket sweep -------------------------------------------------------------------------
  // A daemon that was SIGKILLed, or that skipped its cleanup because a successor owned the record,
  // leaves its unix socket FILE behind forever. The rules that make collecting them safe — and the
  // reason connecting to one is itself destructive — live in stale-socket-sweep.ts, shared with the
  // Claude broker's sockets, which leak the same way for the same reasons.
  const sweepOwnFamily = (): void =>
    sweepStaleSockets({ dir: dirname(config.socketPath), prefix: "frizz-codex-", keep: [config.socketPath] })

  const startListening = (): void => {
    // A stale unix socket from a crashed prior daemon would block listen(); named pipes need no unlink.
    if (process.platform !== "win32" && existsSync(config.socketPath)) { try { unlinkSync(config.socketPath) } catch {} }
    server.on("error", () => die(6, "socket-listen-error"))
    server.listen(config.socketPath, () => {
      published = true
      writeRecord()
      armIdleExit()
      const reachability = setInterval(checkReachable, config.reachabilityCheckMs ?? REACHABILITY_CHECK_MS)
      reachability.unref?.()
      // Off the critical path on purpose: the client is already being served by now.
      setTimeout(sweepOwnFamily, 5_000).unref?.()
    })
  }

  child.stdout.on("data", lineReader(readServerLine))
  child.stderr.resume() // drained and discarded; the client sees stderr only via its own attachment
  // The app-server child itself ended — the single most important cause to distinguish. A non-zero
  // code is a codex panic/OOM; a signal is an external kill. Either way every turn inside it (the
  // parent AND all its sub-agents) is gone, and this is the one place we can name which happened.
  child.on("exit", (code, signal) => die(0, signal ? `app-server-killed-${signal}` : `app-server-exited-code-${code ?? "null"}`))
  child.on("error", () => die(4, "app-server-spawn-error"))

  toServer({ id: HANDSHAKE_ID, method: "initialize", params: { clientInfo: config.clientInfo, capabilities: config.capabilities } })
  const handshakeTimer = setTimeout(() => { if (!handshakeDone) { try { child.kill("SIGTERM") } catch {}; die(5, "handshake-timeout") } }, HANDSHAKE_TIMEOUT_MS)
  handshakeTimer.unref?.()

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => { try { child.kill("SIGTERM") } catch {}; die(0, `signal-${signal}`) })
  }
}

main()
