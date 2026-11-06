import {
  importClaimPublicKey,
  RELAY_KEEPALIVE_PING,
  RELAY_KEEPALIVE_PONG,
  relayHandshakeInput,
  type RelayHandshake,
} from "@frizz/shared"
import { BoardSocket } from "./board-socket.ts"

/**
 * The relay: one wildcard hostname in front of every board.
 *
 * `*.frizz.sh` resolves here. A board dials in over a WebSocket and holds it open; a visitor's request
 * for that board's hostname is routed to the Durable Object holding that socket and framed down it.
 * No per-user DNS record and no per-user tunnel, which is what removes the 200-name ceiling the
 * tunnel design could never get past.
 *
 * WE ARE ON THE DATA PATH HERE, unlike the registrar. That is the trade this design makes deliberately:
 * unlimited names cost us the traffic. The visitor still meets Frizz's own single-use access gate on
 * the far side, but the credential that gate checks crosses this hop, so the relay is trusted with it.
 * Every byte passes through here in plaintext: the access code as it is redeemed, the session cookie on
 * every request after it, and everything the board shows that session. So whoever controls this Worker
 * can act as any device signed in behind it: between 2026-09-21 and 2026-10-08 a stolen Cloudflare token
 * was used to deploy a build of this file that copied all of that out and drove a board with a copied
 * cookie. Deploys go through CI only (packages/relay/README.md), and plans/blind-relay.md is the design
 * that takes the plaintext away from this hop.
 *
 * WHAT THAT ACTING REACHES IS THE BOARD'S CALL, not this file's. A remote session may read the board and
 * pick listed options on question cards, and nothing else runs (packages/server/src/remote-gate.ts). The
 * board's relay agent dials a listener on which every request is public, so no frame can claim to be local.
 */

export interface RelayEnv {
  BOARD: DurableObjectNamespace
  /** The apex boards hang off, e.g. `frizz.sh`. A hostname outside it is not ours to serve. */
  FRIZZ_ZONE: string
  /** Registry written by the registrar: `claim:<name>` → the record naming the owning pubkey. */
  CLAIMS: { get(key: string): Promise<string | null> }
}

/** How long a handshake may sit before the relay stops believing it. Matches the claim protocol. */
const HANDSHAKE_MAX_AGE_MS = 5 * 60_000

/** The label to the left of the zone, or null when the host is not one of ours. */
export function boardNameFor(hostname: string, zone: string): string | null {
  const suffix = `.${zone}`
  if (!hostname.endsWith(suffix)) return null
  const name = hostname.slice(0, -suffix.length)
  // One level only: Universal SSL covers `*.frizz.sh` and nothing deeper, so `a.b.frizz.sh` would
  // arrive with a certificate error anyway and must not be treated as a board.
  return name.length > 0 && !name.includes(".") ? name : null
}

/**
 * Is this handshake signed by the key that owns the name?
 *
 * The relay holds no secret of its own — it reads the pubkey the REGISTRAR recorded and checks the
 * signature against it. So a board proves itself with the same identity that claimed the name, and a
 * relay compromise leaks no credential capable of taking anyone's hostname.
 */
export async function handshakeAccepted(
  handshake: unknown,
  ownerPubkey: string | null,
  now: number
): Promise<boolean> {
  if (typeof handshake !== "object" || handshake === null) return false
  const candidate = handshake as Partial<RelayHandshake>
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.pubkey !== "string" ||
    typeof candidate.sig !== "string" ||
    typeof candidate.issuedAt !== "number"
  ) {
    return false
  }
  // The key must be the one on record. Without this any well-formed self-signed handshake would be
  // accepted, and a board could serve a name it never claimed.
  if (!ownerPubkey || candidate.pubkey !== ownerPubkey) return false
  if (Math.abs(now - candidate.issuedAt) > HANDSHAKE_MAX_AGE_MS) return false

  const key = await importClaimPublicKey(candidate.pubkey)
  if (!key) return false
  let signature: Uint8Array<ArrayBuffer>
  try {
    const binary = atob(candidate.sig.replace(/-/g, "+").replace(/_/g, "/"))
    signature = new Uint8Array(new ArrayBuffer(binary.length))
    for (let i = 0; i < binary.length; i++) signature[i] = binary.charCodeAt(i)
  } catch {
    return false
  }
  if (signature.byteLength !== 64) return false
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    signature,
    relayHandshakeInput(candidate.name, candidate.pubkey, candidate.issuedAt)
  )
}

/**
 * How the board's answer is handed to the visitor.
 *
 * THE BODY IS PASSED THROUGH AS THE BOARD ENCODED IT. Workers treat a `content-encoding` header on a
 * constructed Response as an instruction: in the default "automatic" mode the runtime compresses the
 * body to match it. The board already did — index.html and every asset arrive here brotli-encoded,
 * because Cloudflare advertises `accept-encoding: gzip, br` to the board whatever the phone asked for
 * — so the edge compressed them a second time, the browser undid one layer, and a phone that scanned
 * the access link rendered raw brotli as text (2026-09-20). "manual" says the body is already what the
 * header claims. It is set only when the board declared an encoding, so a plain body keeps the edge's
 * own compression for a client that accepts it.
 */
export function visitorResponseInit(status: number, headers: Array<[string, string]>): ResponseInit {
  const encoded = headers.some(([name, value]) => name.toLowerCase() === "content-encoding" && value.trim().toLowerCase() !== "identity")
  return encoded ? { status, headers, encodeBody: "manual" } : { status, headers }
}

/** Statuses the Fetch spec forbids a body on; `new Response(body, { status })` throws for them. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304])

/** The owning pubkey the registrar recorded for a name, or null if the name is unclaimed. */
export async function ownerPubkeyFor(env: RelayEnv, name: string): Promise<string | null> {
  const raw = await env.CLAIMS.get(`claim:${name}`)
  if (!raw) return null
  try {
    const record = JSON.parse(raw) as { pubkey?: unknown }
    return typeof record.pubkey === "string" ? record.pubkey : null
  } catch {
    return null
  }
}

/** One board's Durable Object: it holds the socket and answers visitors from it. */
/** What a socket is, once the Durable Object has forgotten everything else about it. */
interface SocketRole {
  role: "board" | "visitor"
  /** The nested-session id, for a visitor. */
  id?: string
}

export class Board {
  private readonly relay = new BoardSocket({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
  /**
   * One adapter per live socket, and never a second for the same one.
   *
   * BoardSocket compares adapters by IDENTITY, so a freshly built object with the same methods matches
   * nothing: detach would no-op and the board would read as connected forever after it had gone.
   */
  private readonly adapters = new WeakMap<WorkerWebSocket, { send: (data: string) => void; close: (code?: number, reason?: string) => void }>()
  private restored = false

  private readonly state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
    // The board's keep-alive is answered by the RUNTIME, not by this object: an exact-match
    // auto-response works while the object is hibernated and does not wake it. Answering in
    // webSocketMessage instead would bill a wake per beat — thousands a day per idle board.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_KEEPALIVE_PING, RELAY_KEEPALIVE_PONG))
  }

  private adapterFor(ws: WorkerWebSocket) {
    const existing = this.adapters.get(ws)
    if (existing) return existing
    const adapter = {
      send: (data: string) => ws.send(data),
      close: (code?: number, reason?: string) => ws.close(code, reason),
    }
    this.adapters.set(ws, adapter)
    return adapter
  }

  private roleOf(ws: WorkerWebSocket): SocketRole | null {
    try {
      return (ws.deserializeAttachment() as SocketRole | null) ?? null
    } catch {
      return null
    }
  }

  /**
   * Pick up the sockets that outlived a hibernation.
   *
   * A woken Durable Object is a FRESH instance: `relay`'s pending requests and nested sessions are
   * gone, even though the sockets themselves survived. So the board's socket is re-attached, and every
   * visitor socket is closed — its session existed only in the memory that was just discarded, and a
   * pane that looks live while typing into nothing is the worst of the available outcomes. Both ends
   * already reconnect on their own.
   */
  private restore(): void {
    if (this.restored) return
    this.restored = true
    for (const ws of this.state.getWebSockets()) {
      const role = this.roleOf(ws)
      if (role?.role === "board") this.relay.attach(this.adapterFor(ws))
      else {
        try {
          ws.close(1012, "the relay restarted")
        } catch {
          // Already gone.
        }
      }
    }
  }

  /** A frame from a socket this instance may never have seen accepted. */
  webSocketMessage(ws: WorkerWebSocket, message: string | ArrayBuffer): void {
    this.restore()
    if (typeof message !== "string") return
    const role = this.roleOf(ws)
    if (role?.role === "board") this.relay.handleFrame(message)
    else if (role?.role === "visitor" && role.id) this.relay.sendWebSocketMessage(role.id, message)
  }

  webSocketClose(ws: WorkerWebSocket): void {
    this.restore()
    const role = this.roleOf(ws)
    if (role?.role === "board") this.relay.detach(this.adapterFor(ws))
    else if (role?.role === "visitor" && role.id) this.relay.closeWebSocket(role.id)
  }

  webSocketError(ws: WorkerWebSocket): void {
    this.webSocketClose(ws)
  }

  async fetch(request: Request): Promise<Response> {
    this.restore()
    const url = new URL(request.url)

    // The board dialling in.
    if (url.pathname === "/_relay/connect" && request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair()
      const server = pair[1]!
      // HIBERNATION, not `accept()`. A socket accepted the ordinary way is bound to the request that
      // opened it, and production tears that context down: every connect threw "Network connection
      // lost" and the board reconnected about twice a second, forever. `wrangler dev` does not
      // reproduce it, which is why the whole local suite stayed green through it.
      this.state.acceptWebSocket(server, ["board"])
      server.serializeAttachment({ role: "board" } satisfies SocketRole)
      this.relay.attach(this.adapterFor(server))
      return new Response(null, { status: 101, webSocket: pair[0]! })
    }

    // A visitor's WebSocket — a terminal. The board opens its own end locally and the two are linked
    // frame by frame. Without this a relayed board renders and streams but cannot be worked in, which
    // is most of what Frizz is for.
    if (request.headers.get("upgrade") === "websocket") {
      if (!this.relay.connected) return new Response("This Frizz board is not running right now.", { status: 502 })
      const pair = new WebSocketPair()
      const visitor = pair[1]!
      this.state.acceptWebSocket(visitor, ["visitor"])
      const id = await this.relay.openWebSocket({ url: url.toString(), headers: [...request.headers] }, this.adapterFor(visitor))
      if (!id) {
        // Refuse the upgrade outright rather than accepting a socket that will never carry anything.
        // A terminal pane that opens and stays silent is far harder to diagnose than one that fails.
        try {
          visitor.close(1011, "the board did not open a terminal")
        } catch {
          // Already gone.
        }
        return new Response("The board did not open a terminal.", { status: 502 })
      }
      // The id has to ride ON the socket: after a wake this instance has no map to look it up in.
      visitor.serializeAttachment({ role: "visitor", id } satisfies SocketRole)
      return new Response(null, { status: 101, webSocket: pair[0]! })
    }

    if (!this.relay.connected) {
      // The name exists but nothing is serving it. Said plainly, because "this board is offline" is a
      // different problem from "no such board" and the visitor can act on one of them.
      return new Response("This Frizz board is not running right now.", {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      })
    }

    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
    // A stream, so an SSE response reaches the visitor as it is produced rather than when it ends —
    // which for the board's event feed is never.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    // A visitor that hangs up cancels the readable, and the write after that rejects. The chunk
    // AFTER that one then throws, which BoardSocket reads as "drop this request and tell the board
    // to abort" — the only signal there is, because a TransformStream reports a gone reader no
    // earlier than the next write.
    let visitorGone = false

    try {
      const response = await this.relay.request(
        {
          method: request.method,
          url: url.toString(),
          headers: [...request.headers],
          ...(body && body.byteLength > 0 ? { body } : {}),
        },
        {
          push: (chunk) => {
            if (visitorGone) throw new Error("the visitor hung up")
            void writer.write(chunk).catch(() => {
              visitorGone = true
            })
          },
          end: () => void writer.close().catch(() => {}),
        }
      )
      // No body to stream, so answer with none. A null-body status MUST — the Response constructor
      // throws on one given any body, even an empty stream, so a browser revalidating a page it still
      // holds (the back button, above all) got its 304 turned into a 504. And a whole answer that
      // happens to be empty (an empty 200, a HEAD, a redirect) would otherwise leave the visitor's
      // stream open, and the request loading, forever.
      if (NULL_BODY_STATUSES.has(response.status) || (response.end && response.body === null)) {
        void writer.close().catch(() => {})
        return new Response(null, visitorResponseInit(response.status, response.headers))
      }
      // An inline body is the whole response, so write it and close. Otherwise the writer stays open
      // for chunks still to come — for the board's event feed, that is the normal case and it never
      // closes at all.
      if (response.body !== null) {
        void writer.write(response.body).then(() => writer.close().catch(() => {}))
      }
      return new Response(readable, visitorResponseInit(response.status, response.headers))
    } catch (error) {
      void writer.close().catch(() => {})
      return new Response(`The board did not answer: ${error instanceof Error ? error.message : error}`, {
        status: 504,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      })
    }
  }
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const url = new URL(request.url)
    const name = boardNameFor(url.hostname, env.FRIZZ_ZONE)
    if (!name) {
      // Name the host it refused. A bare "Not found" here is indistinguishable from an unclaimed name
      // and from a routing mistake, which is exactly the confusion worth spending a line to avoid.
      return new Response(`${url.hostname} is not a board name under ${env.FRIZZ_ZONE}.`, {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }

    const owner = await ownerPubkeyFor(env, name)
    if (!owner) {
      return new Response("No Frizz board has claimed this name.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }

    // A board dialling in proves itself BEFORE reaching the Durable Object, so an unproven socket
    // never occupies a name's object at all.
    if (url.pathname === "/_relay/connect") {
      const raw = url.searchParams.get("h")
      let handshake: unknown = null
      try {
        handshake = raw ? JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) : null
      } catch {
        handshake = null
      }
      if (!(await handshakeAccepted(handshake, owner, Date.now()))) {
        return new Response("handshake rejected", { status: 401 })
      }
      if ((handshake as RelayHandshake).name !== name) {
        return new Response("handshake is for a different name", { status: 401 })
      }
    }

    return env.BOARD.get(env.BOARD.idFromName(name)).fetch(request)
  },
}
