// Client side of the detached Codex app-server daemon (codex-app-server-daemon.ts): discover an
// already-running daemon for this project or fork a new one, then attach to it over its local socket
// and present the attachment as an ordinary `CodexAppServerProcess` so the bridge's JSON-RPC layer is
// unchanged.
//
// The whole point is the lifetime split. `kill()` on this adapter DETACHES the socket; it never kills
// the daemon. So when the disposable frizz runtime is recycled by Update & Restart, the app-server —
// and every turn running inside it — keeps going, and the next runtime generation reattaches to the
// SAME process. (A Claude thread gets the same immunity from its own session broker daemon, which holds
// the SDK session outside frizz entirely — see claude-broker-host.ts. That job belonged to tmux until
// the multiplexer was stripped on 2026-08-02; an earlier PTY session broker had been removed as dead
// code before that.)
//
// A long-lived process needs someone to END it. That is what `stopCodexAppServerDaemon` is for. The
// bridge uses it for version-skew recovery (a daemon caches its `initialize` handshake forever) and
// at an idle turn boundary after auth.json switches ChatGPT accounts (Codex caches AuthManager too).
// See codex-app-server.ts's `connect()` / `ensureCurrentAuth()`. It ends the NATIVE listener too — the
// bridge cannot tell the transports apart, and both kinds of cached process need the same replacement.
//
// Shutdown is deliberately NOT such a caller, for either transport. Recycling frizz must leave the
// app-server (and its in-flight turns) running, which is the whole point of the split above.
import { spawn, spawnSync } from "node:child_process"
import { createConnection, type Socket } from "node:net"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { PassThrough, Writable, type Readable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import { resolveDetachedDaemonEntry } from "../detached-daemons.ts"
import { stopNativeListener } from "./codex-app-server-native.ts"
import { frizzIpcPath } from "./ipc-path.ts"
import { codexAppServerArgv } from "./codex-mcp.ts"
import type { FrizzMcp } from "./types.ts"
import type { CodexAppServerProcess } from "./codex-app-server.ts"
import { log as frizzLog } from "../logging.ts"

export interface CodexAppServerDaemonRecord {
  projectId: string
  /** Identity of the app-server PROCESS. Unchanged across a frizz restart; new only when the
   *  app-server itself died and a fresh daemon replaced it. This is what tells the bridge whether
   *  in-flight turns survived. */
  generation: string
  daemonPid: number
  childPid: number
  socketPath: string
  createdAt: string
  /** ChatGPT account loaded by this app-server at process start. Absent for legacy records and
   *  non-ChatGPT authentication. This is an opaque identifier, never a credential. */
  authAccountId?: string
}

export interface CodexAppServerAttachment {
  process: CodexAppServerProcess
  generation: string
  /** True when we joined an app-server that was ALREADY running (i.e. it outlived a frizz restart). */
  reattached: boolean
  daemonPid: number
  /** Lines the daemon had to DROP because its detached queue overflowed while nobody was attached.
   *  Non-zero means the stream we just joined has holes in it — a `turn/completed` or an approval
   *  request may simply be gone — so the caller must NOT treat this as a lossless rejoin. */
  droppedWhileDetached: number
  /** ChatGPT account loaded when this app-server process was spawned. */
  authAccountId?: string
}

export interface CodexAppServerHostOptions {
  projectId: string
  stateDir: string
  cwd: string
  codexBin: string
  env: NodeJS.ProcessEnv
  clientInfo: Record<string, unknown>
  capabilities: Record<string, unknown>
  /** ChatGPT account present in auth.json immediately before the process is obtained/spawned. */
  authAccountId?: string
  /** Mounts the unified `frizz` MCP server into this app-server. Absent ⇒ frizz mounts nothing, the
   *  same degradation the claude side has when the descriptor cannot be resolved. */
  frizzMcp?: FrizzMcp
  /** Test seam: override the forked daemon entry. */
  daemonEntry?: string
  /** Test seam: how often the daemon re-checks that its record still names it (default 30s). */
  reachabilityCheckMs?: number
  timeoutMs?: number
}

/** Resolves an attachment to a live app-server, forking a daemon only when there is not one already. */
export type CodexAppServerHost = (options: CodexAppServerHostOptions) => Promise<CodexAppServerAttachment>

// Resolved LAZILY and by EXISTENCE: a promoted artifact is one esbuild bundle plus the daemons
// emitted beside it as `.js`, while a source checkout has only the `.ts`. Hard-coding either
// extension pointed `spawn()` at a file that was not there on the other one — see
// ../detached-daemons.ts for the outage that bought this comment.
const daemonEntry = (): string => resolveDetachedDaemonEntry(import.meta.url, "codex-app-server-daemon")

function daemonDir(stateDir: string): string {
  return join(stateDir, "codex-app-server")
}

function recordPath(stateDir: string, projectId: string): string {
  return join(daemonDir(stateDir), `${projectId}.json`)
}

/** Unix domain sockets have a hard ~104-byte path limit on macOS/BSD and a project state dir can be
 *  long, so hash the identity into a short name (same trick as the session broker). ipc-path.ts turns
 *  that name into the endpoint this platform can bind. */
export function codexAppServerSocketPath(stateDir: string, projectId: string): string {
  const key = createHash("sha256").update(stateDir).update("\0").update(projectId).digest("hex").slice(0, 16)
  return frizzIpcPath(`frizz-codex-${key}`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function readDaemonRecord(stateDir: string, projectId: string): CodexAppServerDaemonRecord | null {
  try {
    const value = JSON.parse(readFileSync(recordPath(stateDir, projectId), "utf8")) as Partial<CodexAppServerDaemonRecord>
    if (typeof value.daemonPid !== "number" || typeof value.socketPath !== "string" || typeof value.generation !== "string") return null
    return {
      projectId,
      generation: value.generation,
      daemonPid: value.daemonPid,
      childPid: typeof value.childPid === "number" ? value.childPid : 0,
      socketPath: value.socketPath,
      createdAt: value.createdAt ?? "",
      ...(typeof value.authAccountId === "string" && value.authAccountId ? { authAccountId: value.authAccountId } : {}),
    }
  } catch {
    return null
  }
}

export interface CodexAppServerExitBreadcrumb {
  generation: string
  daemonPid: number
  childPid: number | null
  /** Why the daemon (and the app-server + every turn inside it) ended. See codex-app-server-daemon.ts's
   *  `writeExitBreadcrumb` for the vocabulary (`app-server-exited-code-*`, `self-collected-*`,
   *  `signal-*`, `idle-timeout`, …). */
  reason: string
  at: string
}

/** The most recent daemon death for this project, or null when none was ever recorded. Keyed by
 *  generation so a caller can confirm it describes the generation it actually lost; never gates
 *  anything — it is pure post-hoc attribution for a socket close the bridge would otherwise see as an
 *  opaque disconnect. */
export function readDaemonExitBreadcrumb(stateDir: string, projectId: string): CodexAppServerExitBreadcrumb | null {
  try {
    const value = JSON.parse(readFileSync(`${recordPath(stateDir, projectId)}.exit`, "utf8")) as Partial<CodexAppServerExitBreadcrumb>
    if (typeof value.generation !== "string" || typeof value.reason !== "string") return null
    return {
      generation: value.generation,
      daemonPid: typeof value.daemonPid === "number" ? value.daemonPid : 0,
      childPid: typeof value.childPid === "number" ? value.childPid : null,
      reason: value.reason,
      at: typeof value.at === "string" ? value.at : "",
    }
  } catch {
    return null
  }
}

/** A daemon is live only while its process is running; a stale record is pruned. */
export function liveDaemonRecord(stateDir: string, projectId: string): CodexAppServerDaemonRecord | null {
  const record = readDaemonRecord(stateDir, projectId)
  if (!record) return null
  if (pidAlive(record.daemonPid)) return record
  try { unlinkSync(recordPath(stateDir, projectId)) } catch {}
  return null
}

/**
 * End a daemon AND the `codex app-server` underneath it.
 *
 * On POSIX that is one signal and nothing more: the daemon installs SIGTERM/SIGINT/SIGHUP handlers
 * (codex-app-server-daemon.ts) that kill the app-server child, write the exit breadcrumb and exit.
 *
 * Windows has no deliverable signals. `process.kill(pid, "SIGTERM")` there is a straight
 * TerminateProcess, so the handler NEVER runs, and the app-server — ~150 MB, still able to edit the
 * filesystem — is orphaned with nobody left who could ever collect it: the daemon was forked
 * `detached`, so it is in no job object of ours, and the orphan reaper both keys on FRIZZ_THREAD
 * (which a per-PROJECT daemon does not carry) and explicitly PROTECTS any process named `codex`.
 * There are no process groups to kill either — `process.kill(-pid, …)` is rejected outright with
 * EINVAL. `taskkill /T` instead walks the live parent/child snapshot, so it reaches exactly the child
 * the signal handler would have killed; `/F` because without it `/T` only sends the polite WM_CLOSE,
 * which a console process with no window ignores. `taskkill.exe` is a real executable on PATH, so the
 * CVE-2024-27980 ban on spawning `.bat`/`.cmd` without a shell does not apply and no shell — hence no
 * interpolation of the pid — is involved.
 *
 * The cost on win32 is the breadcrumb: a force-killed daemon cannot write its `.exit` file, so an
 * explicit teardown there is attributed only by the record's disappearance. It never gated anything.
 */
function endDaemonTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try { process.kill(pid, signal) } catch {}
    return
  }
  const killed = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
  // taskkill absent (a stripped PATH) or refusing: still end the daemon itself. An orphaned
  // app-server is bad; a live daemon still holding the named pipe and serving a stale handshake to
  // every connect is the wedge this whole stop path exists to break.
  if (killed.error || killed.status !== 0) { try { process.kill(pid, signal) } catch {} }
}

/** Terminate the daemon AND its app-server. Only for an explicit teardown — never for a restart.
 *  Inert when there is no record, which is exactly the case for `directChildHost` and the in-process
 *  fallback: a test bridge can never kill a daemon it does not own, or its own in-process child. */
export function killCodexAppServerDaemon(stateDir: string, projectId: string): void {
  const record = liveDaemonRecord(stateDir, projectId)
  if (!record) return
  endDaemonTree(record.daemonPid, "SIGTERM")
  try { unlinkSync(recordPath(stateDir, projectId)) } catch {}
}

/**
 * End whichever detached app-server host this project has, and WAIT for it to actually be gone.
 *
 * The wait is not politeness, it is correctness: a dying daemon's exit handler unlinks the record
 * and the socket, and both paths are DERIVED (same stateDir + projectId ⇒ same paths). Fork a
 * replacement before the old one finishes dying and the corpse deletes the new daemon's socket and
 * record on its way out, leaving a daemon nobody can ever find.
 *
 * It covers BOTH transports because the bridge has no idea which one is in play, and neither stale
 * state is the daemon's alone. The native listener (FRIZZ_CODEX_NATIVE_LISTEN,
 * codex-app-server-native.ts) is a codex process spawned from the binary and credential snapshot as
 * they stood at spawn time. Leave it running after either one changes and the "refork" reattaches to
 * the stale process, reproducing the same version rejection or old-account selection indefinitely.
 * Each half is inert without its own record and a project can only have one, so calling both is
 * precisely "stop the host that is actually there".
 */
export async function stopCodexAppServerDaemon(stateDir: string, projectId: string, timeoutMs = 10_000): Promise<void> {
  await stopNativeListener(stateDir, projectId, timeoutMs)
  const record = liveDaemonRecord(stateDir, projectId)
  killCodexAppServerDaemon(stateDir, projectId)
  if (!record) return
  const deadline = Date.now() + timeoutMs
  while (pidAlive(record.daemonPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  // A daemon that ignored SIGTERM is worse than one that is merely stale: it still holds the socket.
  if (pidAlive(record.daemonPid)) {
    endDaemonTree(record.daemonPid, "SIGKILL")
    while (pidAlive(record.daemonPid) && Date.now() < deadline + 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

function forkDaemon(options: CodexAppServerHostOptions): Promise<CodexAppServerDaemonRecord> {
  const { stateDir, projectId } = options
  mkdirSync(daemonDir(stateDir), { recursive: true })
  const record = recordPath(stateDir, projectId)
  try { unlinkSync(record) } catch {}
  const socketPath = codexAppServerSocketPath(stateDir, projectId)
  const generation = randomUUID()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value

  const payload = JSON.stringify({
    projectId, socketPath, recordPath: record, codexBin: options.codexBin, cwd: options.cwd,
    env, generation, clientInfo: options.clientInfo, capabilities: options.capabilities,
    ...(options.authAccountId ? { authAccountId: options.authAccountId } : {}),
    // The argv is built HERE, not in the daemon: the daemon is a bare forked entry that should not have
    // to resolve frizz's MCP descriptors, and building it once keeps this transport identical to the
    // native listener's.
    appServerArgs: codexAppServerArgv(["--stdio"], options.frizzMcp),
    ...(options.reachabilityCheckMs === undefined ? {} : { reachabilityCheckMs: options.reachabilityCheckMs }),
  })
  const child = spawn(process.execPath, [options.daemonEntry ?? daemonEntry()], {
    cwd: options.cwd,
    // The daemon's OWN environment only needs the handoff; the app-server's environment travels in
    // the payload and is applied by the daemon, keeping the audited env allowlist authoritative.
    env: { ...process.env, FRIZZ_CODEX_APP_SERVER_DAEMON: payload },
    detached: true,
    stdio: "ignore",
  })
  child.unref()

  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  return new Promise<CodexAppServerDaemonRecord>((resolve, reject) => {
    const poll = (): void => {
      const found = readDaemonRecord(stateDir, projectId)
      if (found && pidAlive(found.daemonPid)) return resolve(found)
      if (!pidAlive(child.pid ?? -1) && !found) return reject(new Error("codex app-server daemon exited before it became ready"))
      if (Date.now() > deadline) return reject(new Error("codex app-server daemon did not become ready"))
      setTimeout(poll, 50)
    }
    child.once("error", reject)
    poll()
  })
}

/**
 * A `CodexAppServerProcess` backed by a socket to the daemon rather than by a child's stdio.
 * `kill()` closes THIS attachment only — the daemon and its app-server keep running.
 */
interface Attached {
  process: CodexAppServerProcess
  droppedWhileDetached: number
}

/** Read `droppedWhileDetached` off the daemon's `hello`. An unreadable control line is treated as a
 *  clean rejoin: it is what every daemon predating the field looks like, and inventing losses would
 *  force a needless `thread/resume` on every reattach. */
function helloDropCount(line: string): number {
  try {
    const parsed = JSON.parse(line) as { droppedWhileDetached?: unknown }
    return typeof parsed.droppedWhileDetached === "number" && parsed.droppedWhileDetached > 0
      ? parsed.droppedWhileDetached
      : 0
  } catch {
    return 0
  }
}

function attach(record: CodexAppServerDaemonRecord, timeoutMs: number): Promise<Attached> {
  return new Promise<Attached>((resolve, reject) => {
    const socket = createConnection(record.socketPath)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const listeners = { exit: [] as (() => void)[], error: [] as ((error: Error) => void)[] }
    let settled = false
    let ended = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error("codex app-server daemon attach timed out"))
    }, timeoutMs)
    timer.unref?.()

    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        socket.write(chunk as Buffer, (error) => callback(error ?? null))
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
      // DETACH, never kill. This one line is the difference between a codex turn surviving Update &
      // Restart and dying mid-sentence.
      kill() { socket.destroy(); return true },
    } as CodexAppServerProcess

    // Control lines (a reserved `frizz` key) are the daemon's own; everything else is verbatim
    // app-server JSON-RPC and must reach the bridge's parser untouched.
    const decoder = new StringDecoder("utf8")
    let buffer = ""
    socket.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      for (;;) {
        const index = buffer.indexOf("\n")
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith("{\"frizz\":")) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            // The `hello` line is the daemon's own report on the stream it is about to replay. Its
            // `droppedWhileDetached` is the daemon TELLING US the queue overflowed — it was written
            // for exactly this and, before this parse existed, thrown away unread, so a lossy rejoin
            // was indistinguishable from a perfect one.
            resolve({ process: handle, droppedWhileDetached: helloDropCount(trimmed) })
          }
          continue
        }
        stdout.write(`${trimmed}\n`)
      }
    })

    const finish = (error?: Error): void => {
      if (ended) return
      ended = true
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(error ?? new Error("codex app-server daemon closed the attachment"))
        return
      }
      // Surface a lost attachment as an `exit`: from the bridge's point of view a connection it can
      // no longer speak on is exactly a dead process, and its reconnect path already handles that.
      for (const listener of listeners.exit) listener()
    }
    socket.on("close", () => finish())
    socket.on("error", (error) => { for (const l of listeners.error) l(error); finish(error) })
  })
}

/** The production host: reattach to this project's daemon, or fork one if there is none. */
export const daemonCodexAppServerHost: CodexAppServerHost = async (options) => {
  const existing = liveDaemonRecord(options.stateDir, options.projectId)
  const timeoutMs = options.timeoutMs ?? 30_000
  if (existing) {
    try {
      const attached = await attach(existing, timeoutMs)
      return { ...attached, generation: existing.generation, reattached: true, daemonPid: existing.daemonPid, authAccountId: existing.authAccountId }
    } catch {
      // The record outlived its socket (a daemon killed between the pid check and connect). Drop it
      // and fall through to a fresh fork rather than failing the whole connect.
      try { unlinkSync(recordPath(options.stateDir, options.projectId)) } catch {}
    }
  }
  if (process.platform !== "win32") {
    const stale = codexAppServerSocketPath(options.stateDir, options.projectId)
    if (existsSync(stale) && !liveDaemonRecord(options.stateDir, options.projectId)) { try { unlinkSync(stale) } catch {} }
  }
  try {
    const record = await forkDaemon(options)
    const attached = await attach(record, timeoutMs)
    return { ...attached, generation: record.generation, reattached: false, daemonPid: record.daemonPid, authAccountId: record.authAccountId }
  } catch (error) {
    // LAST RESORT, and deliberately not a hard failure. The daemon buys ONE thing — an in-flight turn
    // surviving Update & Restart. Codex itself does not need it: before the daemon existed the
    // app-server was an ordinary child of this runtime. So a daemon that cannot start must cost the
    // survival property, never Codex. Without this, one packaging slip took out every Codex dispatch,
    // follow-up, steer and interrupt at once (2026-07-23) with only a cryptic toast to go on.
    frizzLog.error("codex", `codex app-server daemon unavailable (${(error as Error).message}); falling back to an in-process app-server — turns will NOT survive a frizz restart`)
    return inProcessCodexAppServer(options)
  }
}

/** The pre-daemon transport: `codex app-server --stdio` as an ordinary child of this runtime. */
function inProcessCodexAppServer(options: CodexAppServerHostOptions): CodexAppServerAttachment {
  const child = spawn(options.codexBin, codexAppServerArgv(["--stdio"], options.frizzMcp), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  // This is the LAST-RESORT transport, so the case where codex itself cannot be spawned is a live
  // one, and on win32 the teardown of that never-started child THROWS: libuv's uv_process_kill
  // returns UV_EINVAL for the INVALID_HANDLE_VALUE a failed CreateProcess leaves on the handle, and
  // node rethrows it as `Error: kill EINVAL` (six of them in the 2026-08-24 Windows suite run). POSIX
  // returns false and says nothing. Match POSIX: a teardown must never throw because codex is missing.
  const kill = child.kill.bind(child)
  child.kill = ((signal?: number | NodeJS.Signals) => { try { return kill(signal) } catch { return false } }) as typeof child.kill
  return { process: child as unknown as CodexAppServerProcess, generation: randomUUID(), reattached: false, daemonPid: process.pid, droppedWhileDetached: 0, authAccountId: options.authAccountId }
}

/** Test/harness seam: keep the historical direct-child behavior, where every connect is a NEW
 *  app-server process (so `reattached` is false and the generation always changes). */
export function directChildHost(
  spawnChild: (binary: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => CodexAppServerProcess,
  generationId: () => string = randomUUID,
): CodexAppServerHost {
  return async (options) => ({
    process: spawnChild(options.codexBin, codexAppServerArgv(["--stdio"], options.frizzMcp), { cwd: options.cwd, env: options.env }),
    generation: generationId(),
    reattached: false,
    daemonPid: process.pid,
    droppedWhileDetached: 0,
    authAccountId: options.authAccountId,
  })
}

export { recordPath as codexAppServerDaemonRecordPath }
