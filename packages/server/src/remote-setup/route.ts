import { randomUUID } from "node:crypto"
import {
  REMOTE_SETUP_PROTOCOL,
  type RemoteSetupAnswer,
  type RemoteSetupConfig,
  type RemoteSetupContext,
  type RemoteSetupDevice,
  type RemoteSetupEffect,
  type RemoteSetupEvent,
  type RemoteSetupRequest,
} from "../remote-setup-protocol.ts"
import { claimFrizzName } from "./claim.ts"
import { type AccessLink, createRemoteSetupPane, type RemoteSetupPane, type RemoteSetupPaneOptions } from "./pane.ts"
import { probeCloudflared, probeTailscale } from "./probes.ts"
import { frizzGithubLogin } from "./setup.ts"

/**
 * The R menu's sessions: one per R pressed in the shell, each a pane (pane.ts) and the effects it is
 * waiting on the shell for. `POST /_frizz/control/remote-setup` (app.ts) is the whole surface, and the
 * wire is remote-setup-protocol.ts.
 *
 * Everything the menu does on its own — drawing, the claim, the probes — happens here, between requests.
 * What it needs the shell for is queued as an effect and rides out on the next answer: the answer to the
 * key that caused it when the shell can be told at once, otherwise the answer to the `wait` the shell
 * keeps open while the menu is up. A screen the menu draws later (a probe result, a claim's progress
 * line) reaches the shell the same way.
 */

/** How long a `wait` is held before it is answered with the screen the shell already has. */
export const REMOTE_SETUP_WAIT_MS = 25_000

/** A shell holds one menu at a time; a few more covers a menu the shell never closed, and no more. */
const MAX_SESSIONS = 4

const MAX_KEY_LENGTH = 4096
const MAX_DEVICES = 500

export interface RemoteSetupRouteOptions {
  /** Test seams; each defaults to the real thing. */
  claim?: (name: string, port: number, progress: (line: string) => void) => Promise<{ config: RemoteSetupConfig; fresh: boolean }>
  probes?: RemoteSetupPaneOptions["probes"]
  githubLogin?: () => string | null
  waitMs?: number
}

export interface RemoteSetupRoute {
  handle(body: unknown): Promise<{ status: number; body: RemoteSetupAnswer | { error: string } }>
  /** How many menus are open; for tests. */
  size(): number
  /** Close every menu, answering each one's open wait. */
  dispose(): void
}

interface PendingEffect {
  request: RemoteSetupEffect
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface Session {
  id: string
  pane: RemoteSetupPane
  context: RemoteSetupContext
  frame: number
  screen: string
  closed: boolean
  effects: PendingEffect[]
  nextEffect: number
  waiters: Set<() => void>
  touched: number
}

class ShellRefused extends Error {}

export function createRemoteSetupRoute(options: RemoteSetupRouteOptions = {}): RemoteSetupRoute {
  const sessions = new Map<string, Session>()
  const waitMs = options.waitMs ?? REMOTE_SETUP_WAIT_MS
  const claim = options.claim ?? ((name, port, progress) => claimFrizzName(name, port, { say: progress }))
  const probes = options.probes ?? { cloudflared: probeCloudflared, tailscale: probeTailscale }
  const githubLogin = options.githubLogin ?? frizzGithubLogin

  const bump = (session: Session) => {
    session.frame += 1
    const waiters = [...session.waiters]
    session.waiters.clear()
    for (const wake of waiters) wake()
  }

  const end = (session: Session) => {
    if (session.closed) return
    session.closed = true
    session.pane.close()
    sessions.delete(session.id)
    for (const effect of session.effects.splice(0)) effect.reject(new ShellRefused("the menu was closed"))
    bump(session)
  }

  /** Queue an effect for the shell; settles when the shell answers it. */
  const ask = (session: Session, effect: DistributiveOmit<RemoteSetupEffect, "id">): Promise<unknown> => {
    if (session.closed) return Promise.reject(new ShellRefused("the menu was closed"))
    return new Promise((resolve, reject) => {
      session.effects.push({ request: { ...effect, id: (session.nextEffect += 1) } as RemoteSetupEffect, resolve, reject })
      bump(session)
    })
  }

  const open = (context: RemoteSetupContext): Session => {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.touched - b.touched)[0]
      if (oldest) end(oldest)
    }
    const session = { id: randomUUID(), context, frame: 0, screen: "", closed: false, effects: [], nextEffect: 0, waiters: new Set(), touched: Date.now() } as unknown as Session
    session.pane = createRemoteSetupPane({
      context: () => session.context,
      act: {
        apply: async (config, applyOptions) => {
          await ask(session, { kind: "apply", config, ...(applyOptions?.justClaimed ? { justClaimed: true } : {}) })
        },
        setRelayAccess: async (access) => {
          await ask(session, { kind: "relay-access", access })
        },
        issueLink: async () => linkOf(await ask(session, { kind: "issue-link" })),
        signOut: async (device) => {
          const value = await ask(session, { kind: "sign-out", device })
          if (typeof value !== "boolean") throw new Error("the launcher did not say whether that device was signed out")
          return value
        },
        signOutAll: async () => {
          const value = await ask(session, { kind: "sign-out-all" })
          if (typeof value !== "number") throw new Error("the launcher did not say how many devices it signed out")
          return value
        },
      },
      claim: async (name, progress) => {
        const { config, fresh } = await claim(name, session.context.port, progress)
        // A name claimed afresh signs out what was signed in under it before (src/cloud.ts, onFreshClaim).
        if (fresh) await ask(session, { kind: "forget-sessions", hostname: config.hostname })
        return config
      },
      githubLogin,
      probes,
      draw: (screen) => {
        if (session.closed || screen === session.screen) return
        session.screen = screen
        bump(session)
      },
    })
    sessions.set(session.id, session)
    session.pane.open()
    return session
  }

  const answer = (session: Session): RemoteSetupAnswer => {
    const effect = session.closed ? undefined : session.effects[0]
    return {
      protocol: REMOTE_SETUP_PROTOCOL,
      session: session.id,
      frame: session.frame,
      screen: session.screen,
      ...(session.closed ? { close: true as const } : {}),
      ...(effect ? { effect: effect.request } : {}),
    }
  }

  const waitFor = (session: Session, after: number) =>
    new Promise<void>((resolve) => {
      if (session.frame > after || session.closed) return resolve()
      const timer = setTimeout(done, waitMs)
      timer.unref?.()
      function done() {
        clearTimeout(timer)
        session.waiters.delete(done)
        resolve()
      }
      session.waiters.add(done)
    })

  return {
    async handle(body) {
      const request = parseRemoteSetupRequest(body)
      if ("error" in request) return { status: 400, body: { error: request.error } }
      const { event, context } = request
      if (event.type === "open") return { status: 200, body: answer(open(context)) }
      const session = request.session ? sessions.get(request.session) : undefined
      if (!session) return { status: 404, body: { error: "unknown-session" } }
      session.context = context
      session.touched = Date.now()
      if (event.type === "key") {
        // A context that changed under an open screen (a device signed in, the window resized) shows on
        // the next paint, which this key may well cause.
        if (session.pane.key(event.key) === "close") end(session)
        return { status: 200, body: answer(session) }
      }
      if (event.type === "wait") {
        await waitFor(session, event.after)
        return { status: 200, body: answer(session) }
      }
      if (event.type === "effect") {
        const at = session.effects.findIndex((effect) => effect.request.id === event.id)
        if (at >= 0) {
          const [effect] = session.effects.splice(at, 1)
          if (event.ok) effect!.resolve(event.value)
          else effect!.reject(new ShellRefused(event.error))
          // Let the menu act on the outcome first — paint its result, or ask for the next effect — so this
          // answer carries it, rather than the shell's next wait.
          await new Promise((resolve) => setImmediate(resolve))
        }
        return { status: 200, body: answer(session) }
      }
      end(session)
      return { status: 200, body: answer(session) }
    },
    size: () => sessions.size,
    dispose() {
      for (const session of [...sessions.values()]) end(session)
    },
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

function linkOf(value: unknown): AccessLink | null {
  if (value === null) return null
  const link = value as Partial<AccessLink> | undefined
  if (typeof link?.url !== "string" || typeof link.code !== "string" || typeof link.expiresAt !== "number") {
    throw new Error("the launcher answered the sign-in link request with something that is not a link")
  }
  return { code: link.code, url: link.url, expiresAt: link.expiresAt }
}

// ── Parsing what the shell sent ─────────────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const sizeOf = (value: unknown, fallback: number) => (Number.isInteger(value) && (value as number) > 0 && (value as number) <= 10_000 ? (value as number) : fallback)

/** A setup as the shell holds it, or undefined when it is not one. */
export function parseRemoteSetupConfig(value: unknown): RemoteSetupConfig | null | undefined {
  if (value === null) return null
  if (!isObject(value) || typeof value.hostname !== "string" || !value.hostname) return undefined
  const text = (field: unknown) => (typeof field === "string" && field.length > 0 ? field : undefined)
  const tunnel = text(value.tunnel)
  const claim = text(value.claim)
  const config = text(value.config)
  return {
    hostname: value.hostname,
    ...(tunnel ? { tunnel } : {}),
    ...(claim ? { claim } : {}),
    ...(config ? { config } : {}),
    ...(value.serve === "relay" || value.serve === "tunnel" || value.serve === "external" ? { serve: value.serve } : {}),
    ...(value.provider === "tailscale" || value.provider === "other" ? { provider: value.provider } : {}),
    ...(value.relayAccess === "full" || value.relayAccess === "read-and-answer" ? { relayAccess: value.relayAccess } : {}),
  }
}

function parseContext(value: unknown): RemoteSetupContext | undefined {
  if (!isObject(value)) return undefined
  const port = value.port
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) return undefined
  const current = parseRemoteSetupConfig(value.current ?? null)
  if (current === undefined) return undefined
  if (!Array.isArray(value.devices) || value.devices.length > MAX_DEVICES) return undefined
  const devices: RemoteSetupDevice[] = []
  for (const device of value.devices) {
    if (!isObject(device) || typeof device.id !== "string" || typeof device.label !== "string" || typeof device.createdAt !== "number") return undefined
    devices.push({ id: device.id, label: device.label.slice(0, 200), createdAt: device.createdAt })
  }
  return { port: port as number, columns: sizeOf(value.columns, 80), rows: sizeOf(value.rows, 24), current, devices, sandbox: value.sandbox === true }
}

function parseEvent(value: unknown): RemoteSetupEvent | undefined {
  if (!isObject(value)) return undefined
  switch (value.type) {
    case "open":
    case "close":
      return { type: value.type }
    case "key":
      return typeof value.key === "string" && value.key.length > 0 && value.key.length <= MAX_KEY_LENGTH ? { type: "key", key: value.key } : undefined
    case "wait":
      return typeof value.after === "number" && Number.isFinite(value.after) ? { type: "wait", after: value.after } : undefined
    case "effect":
      if (!Number.isInteger(value.id)) return undefined
      if (value.ok === true) return { type: "effect", id: value.id as number, ok: true, value: value.value }
      if (value.ok === false) return { type: "effect", id: value.id as number, ok: false, error: typeof value.error === "string" && value.error ? value.error.slice(0, 500) : "the launcher could not do that" }
      return undefined
    default:
      return undefined
  }
}

export function parseRemoteSetupRequest(body: unknown): RemoteSetupRequest | { error: string } {
  if (!isObject(body)) return { error: "expected a JSON object" }
  if (body.protocol !== REMOTE_SETUP_PROTOCOL) return { error: `unsupported remote-setup protocol: ${String(body.protocol)}` }
  const event = parseEvent(body.event)
  if (!event) return { error: "expected an event: open, key, wait, effect or close" }
  const context = parseContext(body.context)
  if (!context) return { error: "expected the launcher's context: port, terminal size, setup and devices" }
  if (body.session !== undefined && (typeof body.session !== "string" || body.session.length > 100)) return { error: "a session is a string" }
  return { protocol: REMOTE_SETUP_PROTOCOL, ...(typeof body.session === "string" ? { session: body.session } : {}), event, context }
}
