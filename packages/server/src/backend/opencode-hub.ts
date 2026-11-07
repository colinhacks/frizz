import { log } from "../logging.ts"
import { OpencodeClient } from "./opencode-client.ts"
import { discoverOpencodeService, ensureOpencodeService, opencodeRegistrationPath } from "./opencode-service.ts"
import type { OpencodeEvent } from "./opencode-types.ts"

// One event stream per service, whatever number of projects and threads this server has on it. Each
// project context has its own OpenCodeBridge, and every bridge attaches here; the hub fans each frame out
// and the bridge keeps the ones for its own sessions, by session id (`GET /api/event` is global).
//
// `server.connected` is the first frame of every connection, including the one after a service restart,
// which may be on another port with another password, so each attempt re-reads the registration. Nothing is
// replayed, so that frame is what tells a bridge to reconcile.

export interface OpencodeHubListener {
  onEvent(ev: OpencodeEvent): void
  onConnected(client: OpencodeClient): void
  onDisconnected(): void
  /** Whether a turn is open, which is what justifies starting a service that went away. */
  needsService(): boolean
}

const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 5_000

export class OpencodeHub {
  private readonly listeners = new Set<OpencodeHubListener>()
  private running = false
  private abort: AbortController | undefined
  private currentClient: OpencodeClient | undefined
  private connected: Array<(client: OpencodeClient) => void> = []
  private stopped = false

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  attach(listener: OpencodeHubListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) this.stop()
    }
  }

  get client(): OpencodeClient | undefined { return this.currentClient }

  /** Connect now, starting the service if nothing healthy is registered, and resolve on `server.connected`. */
  async connect(): Promise<OpencodeClient> {
    if (this.currentClient) return this.currentClient
    await ensureOpencodeService(this.env)
    this.wake()
    return new Promise<OpencodeClient>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connected = this.connected.filter((c) => c !== done)
        reject(new Error("Timed out connecting to the OpenCode service."))
      }, 30_000)
      const done = (client: OpencodeClient) => { clearTimeout(timer); resolve(client) }
      this.connected.push(done)
    })
  }

  /** Run the loop if it is not running. Attaching to a healthy service costs nothing, and starts nothing. */
  wake(): void {
    if (this.running) return
    this.running = true
    this.stopped = false
    void this.loop()
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
    this.currentClient = undefined
  }

  private anyoneNeedsService(): boolean {
    for (const l of this.listeners) if (l.needsService()) return true
    return false
  }

  private async loop(): Promise<void> {
    let backoff = BACKOFF_MIN_MS
    try {
      while (!this.stopped) {
        let client: OpencodeClient | undefined
        try {
          const found = this.anyoneNeedsService() || this.connected.length
            ? await ensureOpencodeService(this.env)
            : await discoverOpencodeService(this.env)
          if (found) client = new OpencodeClient(found.registration)
        } catch (err) {
          log.warn("opencode", `service unavailable: ${(err as Error).message}`)
        }
        if (client && !this.stopped) {
          const abort = new AbortController()
          this.abort = abort
          const opened = client
          try {
            await opened.stream(abort.signal, (ev) => {
              if (ev.type === "server.connected") {
                backoff = BACKOFF_MIN_MS
                this.currentClient = opened
                for (const done of this.connected.splice(0)) done(opened)
                for (const l of this.listeners) l.onConnected(opened)
                return
              }
              for (const l of this.listeners) l.onEvent(ev)
            })
          } catch (err) {
            if (!abort.signal.aborted) log.info("opencode", `event stream dropped: ${(err as Error).message}`)
          }
          if (this.currentClient === opened) {
            this.currentClient = undefined
            for (const l of this.listeners) l.onDisconnected()
          }
        }
        if (this.stopped) break
        await new Promise((r) => setTimeout(r, backoff).unref?.())
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    } finally {
      this.running = false
    }
  }
}

const hubs = new Map<string, OpencodeHub>()

/** The one hub for the service this environment resolves to. */
export function sharedOpencodeHub(env: NodeJS.ProcessEnv = process.env): OpencodeHub {
  const key = opencodeRegistrationPath(env)
  let hub = hubs.get(key)
  if (!hub) { hub = new OpencodeHub(env); hubs.set(key, hub) }
  return hub
}
