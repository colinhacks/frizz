/**
 * The wire between a board and the relay that fronts it.
 *
 * A board dials OUT to the relay and keeps one WebSocket open. Every visitor request for that board's
 * hostname is then framed down that socket and answered back up it, so the board needs no inbound
 * port, no tunnel binary, and no DNS record of its own — which is the whole reason this exists. One
 * wildcard record serves every name instead of one record per user.
 *
 * DEPENDENCY-FREE, like claim.ts and for the same reason: the board runs this on Node and the relay
 * runs it on workerd.
 *
 * WHAT THIS HAS TO CARRY, and why a plain request/response relay would be useless for Frizz: the board
 * is mostly a live surface. Its event feed is SSE and its terminals are WebSockets. So the protocol
 * frames three things, not one — a unary request, a STREAMED response body, and a nested WebSocket.
 */

export const RELAY_PROTOCOL_VERSION = 1

/** Frames the relay sends DOWN to the board. */
export type RelayDownFrame =
  /** A visitor request. `body` is base64; absent means no body. */
  | { t: "req"; id: string; method: string; url: string; headers: Array<[string, string]>; body?: string }
  /** A visitor wants a WebSocket (a terminal). The board dials its local one and links them. */
  | { t: "ws-open"; id: string; url: string; headers: Array<[string, string]> }
  /** A visitor's WebSocket message. `more` means a continuation follows — see chunkWsMessage. */
  | { t: "ws-msg"; id: string; data: string; binary?: boolean; more?: boolean }
  /** The visitor's side closed. */
  | { t: "ws-close"; id: string; code?: number }
  /** Keep-alive. The board answers with `pong` so a dead socket is noticed rather than assumed live. */
  | { t: "ping"; id: string }
  /**
   * The visitor gave up on a streamed response. The board aborts its local request, because otherwise
   * an SSE feed keeps producing chunks for a reader that no longer exists — and every chunk wakes the
   * relay's Durable Object, which is billed for the time it is awake.
   */
  | { t: "req-cancel"; id: string }
  /** The relay's answer to a board keep-alive; see RELAY_KEEPALIVE_PING. */
  | { t: "pong"; id: string }

/** Frames the board sends UP to the relay. */
export type RelayUpFrame =
  /** Response head. `end` means there is no streamed body to follow. */
  | {
      t: "res"
      id: string
      status: number
      headers: Array<[string, string]>
      body?: string
      end: boolean
    }
  /** A chunk of a streamed body — how SSE reaches a visitor at all. */
  | { t: "res-chunk"; id: string; data: string }
  /** The streamed body is finished. */
  | { t: "res-end"; id: string }
  /** The board accepted (or refused) the nested WebSocket. */
  | { t: "ws-ack"; id: string; ok: boolean; status?: number }
  | { t: "ws-msg"; id: string; data: string; binary?: boolean; more?: boolean }
  | { t: "ws-close"; id: string; code?: number }
  | { t: "pong"; id: string }
  /** The board's keep-alive; see RELAY_KEEPALIVE_PING. */
  | { t: "ping"; id: string }

export type RelayFrame = RelayDownFrame | RelayUpFrame

/**
 * Headers a relay must never forward verbatim.
 *
 * Hop-by-hop headers describe THIS connection, not the message, so replaying them onto a different
 * connection is wrong at best. `content-length` is dropped because a streamed body's length is not
 * known when the head is sent, and a stale one truncates the response.
 */
export const RELAY_STRIPPED_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
])

export function stripHopByHop(headers: Array<[string, string]>): Array<[string, string]> {
  return headers.filter(([name]) => !RELAY_STRIPPED_HEADERS.has(name.toLowerCase()))
}

/** base64 for a body, so one JSON frame carries any bytes without a second channel. */
export function encodeBody(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeBody(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * The largest body carried in ONE frame.
 *
 * A Cloudflare WebSocket message caps at 1 MiB, and base64 costs a third on top, so the real ceiling
 * is well under that. Anything bigger is streamed as chunks instead — which is the same path SSE uses,
 * so there is one streaming implementation rather than two.
 */
export const RELAY_MAX_FRAME_BODY = 512 * 1024

/**
 * The largest slice of a nested WebSocket message carried in ONE frame, in UTF-16 code units.
 *
 * A board's own frames go up to 4 MiB (`APP_SOCKET_MAX_LOGICAL_FRAME_BYTES`) — four times what a
 * Cloudflare WebSocket message may be — so a long transcript window or a big board delta would be
 * DROPPED rather than delivered, and a visitor would see a thread that simply stops updating with
 * nothing to point at. (The whole thread list no longer rides the socket: since 2026-10-14 it is read
 * over HTTP, which the relay streams as chunked bodies, and the socket carries deltas from its seq.)
 *
 * Deliberately far below the 1 MiB ceiling, because the frame is JSON and the ratio is not 1:1. A code
 * unit costs up to 3 bytes in UTF-8, and JSON escaping turns a control character — which terminal
 * output is full of — into six. 64K units is therefore at most ~384 KiB on the wire in the worst case
 * either could produce, and typically a small fraction of that.
 */
export const RELAY_MAX_WS_CHUNK = 64 * 1024

/**
 * Split a WebSocket message into frames small enough to survive the hop.
 *
 * Splitting by code unit can cut a surrogate pair in half, which is fine here and nowhere else: the
 * halves survive a JSON round trip as lone surrogates and the receiver concatenates them back into the
 * original pair. Nothing between the two ends interprets the text.
 */
export function chunkWsMessage(data: string, limit = RELAY_MAX_WS_CHUNK): string[] {
  if (data.length <= limit) return [data]
  const parts: string[] = []
  for (let at = 0; at < data.length; at += limit) parts.push(data.slice(at, at + limit))
  return parts
}

/**
 * Reassembles chunked WebSocket messages, one buffer per session.
 *
 * BOUNDED ON PURPOSE. A peer that sends `more` forever would otherwise grow this without limit, so a
 * run past the ceiling drops the partial message and says so rather than holding it.
 */
export class WsMessageAssembler {
  private readonly parts = new Map<string, string[]>()
  private readonly sizes = new Map<string, number>()
  /**
   * Runs that overflowed and must be abandoned to their end.
   *
   * DROPPING THE BUFFER IS NOT ENOUGH, and the difference is the whole defence: the chunks that follow
   * would simply start a fresh run, so an oversized message would still be delivered — a few megabytes
   * lighter and corrupt. The run stays poisoned until the frame that terminates it.
   */
  private readonly poisoned = new Set<string>()
  private readonly maxBytes: number
  constructor(maxBytes = 8 * 1024 * 1024) {
    this.maxBytes = maxBytes
  }

  /** Returns the complete message, or null while more is still to come (or once the run overflowed). */
  push(id: string, data: string, more?: boolean): string | null {
    if (this.poisoned.has(id)) {
      if (!more) this.poisoned.delete(id)
      return null
    }
    if (!more) {
      const held = this.parts.get(id)
      if (!held) return data
      this.parts.delete(id)
      this.sizes.delete(id)
      held.push(data)
      return held.join("")
    }
    const held = this.parts.get(id) ?? []
    const size = (this.sizes.get(id) ?? 0) + data.length
    if (size > this.maxBytes) {
      this.parts.delete(id)
      this.sizes.delete(id)
      this.poisoned.add(id)
      return null
    }
    held.push(data)
    this.parts.set(id, held)
    this.sizes.set(id, size)
    return null
  }

  forget(id: string): void {
    this.parts.delete(id)
    this.sizes.delete(id)
    this.poisoned.delete(id)
  }
}

export function parseFrame(raw: string): RelayFrame | null {
  try {
    const value = JSON.parse(raw) as RelayFrame
    if (typeof value !== "object" || value === null) return null
    if (typeof (value as { t?: unknown }).t !== "string") return null
    if (typeof (value as { id?: unknown }).id !== "string") return null
    return value
  } catch {
    return null
  }
}

export const serializeFrame = (frame: RelayFrame): string => JSON.stringify(frame)

/**
 * The board's keep-alive, byte-for-byte.
 *
 * These are CONSTANT STRINGS rather than frames built at the call site because the relay registers
 * them with workerd's WebSocket auto-response, which matches the request EXACTLY and answers without
 * waking the Durable Object. A ping serialized with different key order would wake the object on
 * every beat — the precise cost the auto-response exists to avoid — so both ends must send these
 * bytes, not their own serialization of an equivalent frame.
 */
export const RELAY_KEEPALIVE_PING = serializeFrame({ t: "ping", id: "keepalive" })
export const RELAY_KEEPALIVE_PONG = serializeFrame({ t: "pong", id: "keepalive" })

/**
 * The handshake a board presents when it dials in.
 *
 * Signed with the SAME Ed25519 identity that claimed the name, so the relay can prove the connection
 * belongs to whoever owns it without holding any secret of its own. `issuedAt` bounds a replay the
 * way a claim does.
 */
export interface RelayHandshake {
  v: number
  name: string
  pubkey: string
  issuedAt: number
  sig: string
}

/**
 * The exact bytes a handshake signs. Fixed order, and no field can contain the separator.
 *
 * Typed to a concrete ArrayBuffer because Web Crypto's `BufferSource` will not take the default
 * `Uint8Array<ArrayBufferLike>` — that also admits a SharedArrayBuffer, which these APIs reject.
 */
export function relayHandshakeInput(name: string, pubkey: string, issuedAt: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    ["frizz-relay", `v${RELAY_PROTOCOL_VERSION}`, name, pubkey, String(issuedAt)].join(":")
  )
}

/**
 * What a device signed in through the Frizz relay may do, as the owner chose in the R pane: everything a
 * tab on the machine can do short of what stays the machine's (server remote-gate.ts), or read the board
 * and pick listed options on cards. Unset means full control.
 */
export type RelayAccess = "full" | "read-and-answer"
