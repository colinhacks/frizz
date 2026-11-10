// Client side of the detached ACP agent daemon (acp-daemon.ts): discover an already-running daemon for
// this thread's session or fork a new one, then attach to it over its local socket and present the
// attachment as an ordinary `AcpProcess`, so the bridge's JSON-RPC layer (acp-rpc.ts) is unchanged.
//
// The whole point is the lifetime split. `kill()` on this adapter DETACHES the socket; it never kills
// the daemon. So when the frizz runtime is recycled — Update & Restart, a crash — the agent and every
// turn running inside it keep going, and the next runtime attaches to the SAME process. A long-lived
// process needs someone to END it: that is `stopAcpDaemon`, for an explicit teardown (the thread
// dismissed, its session replaced, Mark as done) and never for a restart.
//
// The hello the daemon sends on attach is what makes a reattach more than a reconnect: it carries the
// cached `initialize` result, the ACP session id already open, and every request the previous client
// left outstanding (the `session/prompt` that IS the turn). `adopt()` re-owns one of those under an id
// the new connection chose. See acp-daemon.ts for the wire.
import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { PassThrough, Writable, type Readable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import { resolveDetachedDaemonEntry } from "../detached-daemons.ts"
import { daemonMayBeSignalled, type DaemonIdentityDeps } from "./daemon-identity.ts"
import { endDaemonTree } from "./daemon-tree.ts"
import { frizzIpcPath } from "./ipc-path.ts"
import { spawnAcpChild, type AcpProcess, type AcpSpawn, type AcpSpawnOptions } from "./acp-rpc.ts"
import { log as frizzLog } from "../logging.ts"

export interface AcpDaemonRecord {
  threadSlug: string
  sessionId: string
  /** Identity of the agent PROCESS. Unchanged across a frizz restart; new only when the agent itself
   *  died and a fresh daemon replaced it. */
  generation: string
  daemonPid: number
  childPid: number
  socketPath: string
  createdAt: string
  /** The daemon's own exact start marker, where the platform has one (daemon-identity.ts). */
  processStart?: string
}

/** What the daemon reports about the stream a client is about to join. */
export interface AcpDaemonHello {
  /** The agent's cached `initialize` result, when the previous client completed the handshake. */
  initialize?: unknown
  /** The ACP session already open in the agent, when the previous client opened one. */
  acpSessionId?: string
  /** Requests the previous client left in flight, by the daemon's own id. A `session/prompt` here is
   *  a turn still running. */
  outstanding: Array<{ daemonId: number; method: string }>
  /** Lines the daemon had to DROP because its detached queue overflowed while nobody was attached. */
  droppedWhileDetached: number
}

export interface AcpAttachment {
  process: AcpProcess
  /** True when we joined an agent that was ALREADY running (it outlived a frizz restart). */
  reattached: boolean
  generation: string
  daemonPid: number
  hello: AcpDaemonHello
  /** Take ownership of an outstanding request under `clientId`: the daemon then maps that request's
   *  response onto the new id. */
  adopt(daemonId: number, clientId: number | string): void
}

export interface AcpHostOptions extends AcpSpawnOptions {
  stateDir: string
  threadSlug: string
  sessionId: string
  /** Test seam: override the forked daemon entry. */
  daemonEntry?: string
  /** Test seams for the daemon's own clocks. */
  reachabilityCheckMs?: number
  idleExitMs?: number
  timeoutMs?: number
}

/** Resolves an attachment to a live agent, forking a daemon only when there is not one already. */
export type AcpHost = (options: AcpHostOptions) => Promise<AcpAttachment>

const daemonEntry = (): string => resolveDetachedDaemonEntry(import.meta.url, "acp-daemon")

function daemonDir(stateDir: string): string { return join(stateDir, "acp-daemon") }

export function acpDaemonRecordPath(stateDir: string, sessionId: string): string {
  return join(daemonDir(stateDir), `${sessionId}.json`)
}

/** Unix domain sockets have a hard ~104-byte path limit on macOS/BSD, so hash the identity into a
 *  short name (same trick as the session broker and the codex daemon). */
export function acpDaemonSocketPath(stateDir: string, sessionId: string): string {
  const key = createHash("sha256").update(stateDir).update("\0").update(sessionId).digest("hex").slice(0, 16)
  return frizzIpcPath(`frizz-acp-${key}`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function readAcpDaemonRecord(stateDir: string, sessionId: string): AcpDaemonRecord | null {
  try {
    const value = JSON.parse(readFileSync(acpDaemonRecordPath(stateDir, sessionId), "utf8")) as Partial<AcpDaemonRecord>
    if (typeof value.daemonPid !== "number" || typeof value.socketPath !== "string" || typeof value.generation !== "string") return null
    return {
      threadSlug: typeof value.threadSlug === "string" ? value.threadSlug : "",
      sessionId,
      generation: value.generation,
      daemonPid: value.daemonPid,
      childPid: typeof value.childPid === "number" ? value.childPid : 0,
      socketPath: value.socketPath,
      createdAt: value.createdAt ?? "",
      // Copied by name like every field here, so a new one is lost unless it is listed: the stamp was
      // written and never read back until this line, which left a Linux record judged as unstamped.
      ...(typeof value.processStart === "string" && value.processStart ? { processStart: value.processStart } : {}),
    }
  } catch {
    return null
  }
}

/** A daemon is live only while its process is running; a stale record is pruned. */
export function liveAcpDaemonRecord(stateDir: string, sessionId: string): AcpDaemonRecord | null {
  const record = readAcpDaemonRecord(stateDir, sessionId)
  if (!record) return null
  if (pidAlive(record.daemonPid)) return record
  try { unlinkSync(acpDaemonRecordPath(stateDir, sessionId)) } catch {}
  return null
}

/** Every live daemon under this state dir, for a boot-time reattach sweep. */
export function liveAcpDaemonSessionIds(stateDir: string): string[] {
  let names: string[]
  try { names = readdirSync(daemonDir(stateDir)) } catch { return [] }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((sessionId) => liveAcpDaemonRecord(stateDir, sessionId) !== null)
}

/**
 * End the daemon AND its agent, and WAIT for it to actually be gone. Only for an explicit teardown —
 * never for a restart. The wait is correctness, not politeness: a dying daemon unlinks its record and
 * socket, both DERIVED from (stateDir, sessionId), so a replacement forked before the corpse finishes
 * dying would have its own paths deleted from under it. (A daemon forked by a current build checks the
 * socket by inode and spares a successor's — socket-ownership.ts — but one forked by an older build can
 * outlive an update, so the wait stays.)
 *
 * Only a process that can still be the daemon is signalled (daemon-identity.ts): a record that outlived
 * its daemon names a pid that may be somebody else's by now, and that record is dropped without one.
 */
export async function stopAcpDaemon(stateDir: string, sessionId: string, timeoutMs = 10_000, identity?: DaemonIdentityDeps): Promise<void> {
  const record = liveAcpDaemonRecord(stateDir, sessionId)
  if (!record) return
  const ours = daemonMayBeSignalled({ pid: record.daemonPid, createdAt: record.createdAt, processStart: record.processStart }, identity)
  if (ours) endDaemonTree(record.daemonPid, "SIGTERM")
  try { unlinkSync(acpDaemonRecordPath(stateDir, sessionId)) } catch {}
  if (!ours) return
  const deadline = Date.now() + timeoutMs
  while (pidAlive(record.daemonPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (pidAlive(record.daemonPid)) {
    endDaemonTree(record.daemonPid, "SIGKILL")
    while (pidAlive(record.daemonPid) && Date.now() < deadline + 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

function forkDaemon(options: AcpHostOptions): Promise<AcpDaemonRecord> {
  const { stateDir, sessionId } = options
  mkdirSync(daemonDir(stateDir), { recursive: true })
  const record = acpDaemonRecordPath(stateDir, sessionId)
  try { unlinkSync(record) } catch {}
  const socketPath = acpDaemonSocketPath(stateDir, sessionId)
  const generation = randomUUID()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value
  const payload = JSON.stringify({
    threadSlug: options.threadSlug, sessionId, socketPath, recordPath: record,
    command: options.command, args: [...options.args], cwd: options.cwd, env, generation,
    ...(options.reachabilityCheckMs === undefined ? {} : { reachabilityCheckMs: options.reachabilityCheckMs }),
    ...(options.idleExitMs === undefined ? {} : { idleExitMs: options.idleExitMs }),
  })
  const child = spawn(process.execPath, [options.daemonEntry ?? daemonEntry()], {
    cwd: options.cwd,
    // The daemon's OWN environment only needs the handoff; the agent's environment travels in the
    // payload and is applied by the daemon, keeping the audited env allowlist authoritative.
    env: { ...process.env, FRIZZ_ACP_DAEMON: payload },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.unref()

  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  return new Promise<AcpDaemonRecord>((resolve, reject) => {
    const poll = (): void => {
      const found = readAcpDaemonRecord(stateDir, sessionId)
      if (found && pidAlive(found.daemonPid)) return resolve(found)
      if (!pidAlive(child.pid ?? -1) && !found) return reject(new Error("acp daemon exited before it became ready"))
      if (Date.now() > deadline) return reject(new Error("acp daemon did not become ready"))
      setTimeout(poll, 50)
    }
    child.once("error", reject)
    poll()
  })
}

function parseHello(line: string): AcpDaemonHello {
  const fallback: AcpDaemonHello = { outstanding: [], droppedWhileDetached: 0 }
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    const outstanding = Array.isArray(parsed.outstanding)
      ? (parsed.outstanding as Array<{ daemonId?: unknown; method?: unknown }>)
        .filter((o) => typeof o.daemonId === "number" && typeof o.method === "string")
        .map((o) => ({ daemonId: o.daemonId as number, method: o.method as string }))
      : []
    return {
      ...(parsed.initialize !== null && parsed.initialize !== undefined ? { initialize: parsed.initialize } : {}),
      ...(typeof parsed.acpSessionId === "string" && parsed.acpSessionId ? { acpSessionId: parsed.acpSessionId } : {}),
      outstanding,
      droppedWhileDetached: typeof parsed.droppedWhileDetached === "number" && parsed.droppedWhileDetached > 0 ? parsed.droppedWhileDetached : 0,
    }
  } catch {
    return fallback
  }
}

/** An `AcpProcess` backed by a socket to the daemon rather than by a child's stdio. `kill()` closes
 *  THIS attachment only — the daemon and its agent keep running. */
function attach(record: AcpDaemonRecord, timeoutMs: number): Promise<{ process: AcpProcess; hello: AcpDaemonHello; adopt: AcpAttachment["adopt"] }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(record.socketPath)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const listeners = { exit: [] as Array<(code: number | null, signal: NodeJS.Signals | null) => void>, error: [] as Array<(error: Error) => void> }
    let settled = false
    let ended = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error("acp daemon attach timed out"))
    }, timeoutMs)
    timer.unref?.()

    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        socket.write(chunk as Buffer, (error) => callback(error ?? null))
      },
      // The bridge's `close()` ends stdin as the protocol's teardown. On a daemon attachment that is a
      // DETACH: the socket closes, the agent keeps running.
      final(callback) { socket.end(); callback() },
    })

    const handle = {
      stdin,
      stdout: stdout as unknown as Readable,
      stderr: stderr as unknown as Readable,
      pid: record.childPid,
      on(event: "exit" | "error", listener: never) {
        if (event === "exit") listeners.exit.push(listener as unknown as (code: number | null, signal: NodeJS.Signals | null) => void)
        else listeners.error.push(listener as unknown as (error: Error) => void)
        return handle as never
      },
      // DETACH, never kill.
      kill() { socket.destroy(); return true },
    } as unknown as AcpProcess

    const adopt = (daemonId: number, clientId: number | string): void => {
      try { socket.write(`${JSON.stringify({ frizz: 1, adopt: { daemonId, clientId } })}\n`) } catch {}
    }

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
        // Control lines (a reserved `frizz` key) are the daemon's own; everything else is verbatim
        // agent JSON-RPC and must reach the bridge's parser untouched.
        if (trimmed.startsWith("{\"frizz\":")) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve({ process: handle, hello: parseHello(trimmed), adopt })
            continue
          }
          try {
            const control = JSON.parse(trimmed) as { stderr?: unknown }
            if (typeof control.stderr === "string") stderr.write(`${control.stderr}\n`)
          } catch {}
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
        reject(error ?? new Error("acp daemon closed the attachment"))
        return
      }
      // A lost attachment reads as an `exit` to the bridge: a connection it can no longer speak on is
      // exactly a dead process from its point of view, and its reopen path (which reattaches) handles it.
      for (const listener of listeners.exit) listener(null, null)
    }
    socket.on("close", () => finish())
    socket.on("error", (error) => { for (const l of listeners.error) l(error); finish(error) })
  })
}

/** The production host: reattach to this session's daemon, or fork one if there is none. */
export const daemonAcpHost: AcpHost = async (options) => {
  const { stateDir, sessionId } = options
  const timeoutMs = options.timeoutMs ?? 30_000
  const existing = liveAcpDaemonRecord(stateDir, sessionId)
  if (existing) {
    try {
      const attached = await attach(existing, timeoutMs)
      return { ...attached, reattached: true, generation: existing.generation, daemonPid: existing.daemonPid }
    } catch {
      // The record outlived its socket (a daemon killed between the pid check and connect). Drop it
      // and fall through to a fresh fork rather than failing the whole open.
      try { unlinkSync(acpDaemonRecordPath(stateDir, sessionId)) } catch {}
    }
  }
  if (process.platform !== "win32") {
    const stale = acpDaemonSocketPath(stateDir, sessionId)
    if (existsSync(stale) && !liveAcpDaemonRecord(stateDir, sessionId)) { try { unlinkSync(stale) } catch {} }
  }
  try {
    const record = await forkDaemon(options)
    const attached = await attach(record, timeoutMs)
    return { ...attached, reattached: false, generation: record.generation, daemonPid: record.daemonPid }
  } catch (error) {
    // LAST RESORT, and deliberately not a hard failure: the daemon buys restart survival, and a daemon
    // that cannot start must cost that property, never the ACP thread itself.
    frizzLog.error("acp", `acp daemon unavailable (${(error as Error).message}); running ${options.command} as a plain child — its turns will NOT survive a frizz restart`)
    return directAcpHost(spawnAcpChild)(options)
  }
}

/** The pre-daemon transport as a host: every open is a NEW agent child of this process. For tests
 *  (and the last-resort fallback above). */
export function directAcpHost(spawnChild: AcpSpawn): AcpHost {
  return async (options) => ({
    process: spawnChild({ command: options.command, args: options.args, cwd: options.cwd, env: options.env }),
    reattached: false,
    generation: randomUUID(),
    daemonPid: process.pid,
    hello: { outstanding: [], droppedWhileDetached: 0 },
    adopt() {},
  })
}
