/**
 * The workerd globals this package uses, and nothing else.
 *
 * Declared here rather than pulling in `@cloudflare/workers-types`, for the same reason the registrar
 * declares its KV binding structurally: this package is typechecked by the repo's ordinary Node
 * tsconfig alongside its own tests, and the full Workers types replace the Node globals those tests
 * need. A real workerd runtime satisfies every one of these.
 */

interface DurableObjectId {
  toString(): string
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

interface DurableObjectState {
  readonly id: DurableObjectId
  /** The object's own storage. A call holds the input gate, so no other event interleaves with it. */
  readonly storage: {
    get<T = unknown>(key: string): Promise<T | undefined>
    put(key: string, value: unknown): Promise<void>
  }
  /**
   * The HIBERNATION API. A socket accepted this way survives the request that opened it and survives
   * the object being evicted; one accepted with `WebSocket.accept()` does neither, and production
   * answers every such connect with "Network connection lost".
   */
  acceptWebSocket(ws: WorkerWebSocket, tags?: string[]): void
  /** Every hibernatable socket this object still holds, optionally filtered by tag. */
  getWebSockets(tag?: string): WorkerWebSocket[]
  /**
   * An exact-match request the RUNTIME answers on any of this object's hibernatable sockets, without
   * waking the object. What makes a keep-alive affordable: a ping answered in webSocketMessage would
   * bill a wake per beat.
   */
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
}

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string)
}

/** A message event as workerd delivers it: `data` is a string for a text frame. */
interface WorkerMessageEvent extends Event {
  readonly data: string | ArrayBuffer
}

/** workerd's WebSocket: the server half must be `accept()`ed before it will deliver events. */
interface WorkerWebSocket extends EventTarget {
  accept(): void
  /** Small JSON-able state carried WITH the socket, so a woken object can tell what it is. */
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
  send(data: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message", listener: (event: WorkerMessageEvent) => void): void
  addEventListener(type: "close" | "error", listener: (event: Event) => void): void
}

declare class WebSocketPair {
  0: WorkerWebSocket
  1: WorkerWebSocket
}

interface ResponseInit {
  /** workerd's extension: the client half of a pair, returned with a 101. */
  webSocket?: WorkerWebSocket | null
  /**
   * workerd's extension: whether the runtime encodes the body to match `content-encoding`
   * ("automatic", the default) or the body already is ("manual"). See `visitorResponseInit`.
   */
  encodeBody?: "automatic" | "manual"
}
