import { request as httpRequest } from "node:http";
// The WHATWG `WebSocket` global cannot set request headers, and the visitor's Host, Origin and session
// cookie are exactly what the board's upgrade gate reads. `ws` is already in the published bundle.
import { WebSocket as WsWebSocket } from "ws";
import {
  chunkWsMessage,
  decodeBody,
  encodeBody,
  RELAY_MAX_FRAME_BODY,
  serializeFrame,
  stripHopByHop,
  WsMessageAssembler,
  type RelayDownFrame,
  type RelayUpFrame,
} from "@frizz/shared";

/**
 * The board's half of the relay: it answers requests that arrive down the socket.
 *
 * Everything here talks to the LOCAL board over loopback. The relay never reaches in — the board
 * reaches out and then serves what it is asked, which is the whole reason this needs no inbound port
 * and no tunnel binary.
 *
 * Kept separate from the connection loop so it can be driven against a real local server in a test
 * without any relay, socket or Cloudflare involved.
 */

export interface ServeOptions {
  /** The supervisor's relay listener, e.g. `http://127.0.0.1:53124`. Never its main port: see relayListener. */
  origin: string;
  /** Where a frame goes. Separated so a test can collect them instead of writing to a socket. */
  send: (frame: RelayUpFrame) => void;
  /**
   * The public origin the visitor used, so the board's own gate sees the request as arriving there.
   *
   * The relay listener forces the same Host whatever this says. A Host is what the board's main port
   * judges a caller by, so nothing a frame carries is trusted to set it: see visitorHeaders.
   */
  publicOrigin: string;
}

/**
 * What a frame may not say about itself: which host it arrived at, who called, or what a proxy before
 * it saw. The frame's author is the relay, and the board does not trust the relay with any of that.
 */
const FRAME_CLAIMS = /^(?:host|x-frizz-caller|forwarded|x-forwarded-.*)$/;

/**
 * A frame's headers as the one request they may describe: each name once, in lower case, none of
 * FRAME_CLAIMS, and the Host the board is publicly known by.
 *
 * LOWER-CASED BEFORE ANYTHING ELSE LOOKS AT THEM. Copied as sent, a frame carrying both `host` and
 * `Host` kept both keys, Node wrote them in order, the later one won, and the supervisor read a
 * loopback name as the operator's own tab: no session asked for, and a sign-in link minted on request
 * (red team 2026-11-05).
 */
function visitorHeaders(frameHeaders: Array<[string, string]>, publicUrl: URL): Record<string, string> {
  const headers = new Map<string, string>();
  for (const [name, value] of stripHopByHop(frameHeaders)) {
    const lower = name.toLowerCase();
    if (FRAME_CLAIMS.test(lower) || headers.has(lower)) continue;
    headers.set(lower, value);
  }
  headers.set("host", publicUrl.host);
  return Object.fromEntries(headers);
}

/** What goes back for a frame that describes no request anyone can make. */
const badFrameAnswer = (id: string): RelayUpFrame => ({ t: "res", id, status: 400, headers: [], end: true });

/** A response streams when it has no length we can know up front — SSE above all. */
function shouldStream(headers: Array<[string, string]>): boolean {
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === "content-type" && value.includes("text/event-stream")) return true;
    if (lower === "transfer-encoding" && value.includes("chunked")) return true;
  }
  return false;
}

/** A relayed request in flight, and the handle that aborts it when its visitor is gone. */
export interface RelayedRequest {
  /** Resolves when the response is fully handed over, or the request is cancelled. */
  done: Promise<void>;
  /**
   * Abort the local request and go quiet. The relay sends this when the visitor hung up or the
   * stream idled out — without it an SSE feed keeps producing for a reader that no longer exists,
   * and every chunk sent up the socket wakes (and bills) the relay's Durable Object.
   */
  cancel: () => void;
}

/**
 * Answer one relayed request from the local board.
 *
 * `done` resolves when the response is fully handed over — immediately for an ordinary body, or when
 * the stream ends for one that streams. An SSE body never ends, so that promise is expected to stay
 * pending for as long as the visitor keeps the connection open.
 */
export function serveRelayRequest(frame: Extract<RelayDownFrame, { t: "req" }>, options: ServeOptions): RelayedRequest {
  // A FRAME IS UNTRUSTED INPUT, and only its `t` and `id` have been checked. Everything that can throw
  // on its contents runs here, or inside the promise below, whose `catch` answers rather than rejects:
  // one unhandled rejection in this process would take the whole board down.
  let target: URL;
  let headers: Record<string, string>;
  let body: Buffer | undefined;
  try {
    target = new URL(frame.url);
    headers = visitorHeaders(frame.headers, new URL(options.publicOrigin));
    body = frame.body ? Buffer.from(decodeBody(frame.body)) : undefined;
  } catch {
    options.send(badFrameAnswer(frame.id));
    return { done: Promise.resolve(), cancel: () => {} };
  }
  const local = new URL(options.origin);

  let cancelled = false;
  let abort: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    // After a cancel nothing may go up the socket: the relay has already dropped the entry, so a
    // frame would only wake its Durable Object to be ignored.
    const send = (upFrame: RelayUpFrame) => {
      if (!cancelled) options.send(upFrame);
    };

    const req = httpRequest(
      {
        host: local.hostname,
        port: local.port,
        path: `${target.pathname}${target.search}`,
        method: frame.method,
        headers,
        setHost: false,
      },
      (res) => {
        const outHeaders = Object.entries(res.headers).flatMap(([name, value]) =>
          value === undefined ? [] : Array.isArray(value) ? value.map((v) => [name, v] as [string, string]) : [[name, String(value)] as [string, string]],
        );
        const streaming = shouldStream(outHeaders);

        if (streaming) {
          send({ t: "res", id: frame.id, status: res.statusCode ?? 502, headers: outHeaders, end: false });
          res.on("data", (chunk: Buffer) => {
            // Chunked on the way out too: one oversized frame would be dropped by the relay rather
            // than delivered, and a silently truncated event stream is very hard to diagnose.
            for (let at = 0; at < chunk.length; at += RELAY_MAX_FRAME_BODY) {
              send({
                t: "res-chunk",
                id: frame.id,
                data: encodeBody(new Uint8Array(chunk.subarray(at, at + RELAY_MAX_FRAME_BODY))),
              });
            }
          });
          res.on("end", () => {
            send({ t: "res-end", id: frame.id });
            resolve();
          });
          res.on("error", () => {
            send({ t: "res-end", id: frame.id });
            resolve();
          });
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          if (body.byteLength <= RELAY_MAX_FRAME_BODY) {
            send({
              t: "res",
              id: frame.id,
              status: res.statusCode ?? 502,
              headers: outHeaders,
              ...(body.byteLength > 0 ? { body: encodeBody(new Uint8Array(body)) } : {}),
              end: true,
            });
            resolve();
            return;
          }
          // Too big for one frame, so it takes the streaming path instead of being dropped. This is
          // why there is one streaming implementation rather than a separate one for large bodies.
          send({ t: "res", id: frame.id, status: res.statusCode ?? 502, headers: outHeaders, end: false });
          for (let at = 0; at < body.byteLength; at += RELAY_MAX_FRAME_BODY) {
            send({
              t: "res-chunk",
              id: frame.id,
              data: encodeBody(new Uint8Array(body.subarray(at, at + RELAY_MAX_FRAME_BODY))),
            });
          }
          send({ t: "res-end", id: frame.id });
          resolve();
        });
        res.on("error", () => {
          send({ t: "res", id: frame.id, status: 502, headers: [], end: true });
          resolve();
        });
      },
    );

    req.on("error", (error) => {
      // The board is on the same machine, so this is almost always "it just went down". Answer rather
      // than leaving the visitor to time out, and say something they can act on.
      send({
        t: "res",
        id: frame.id,
        status: 502,
        headers: [["content-type", "text/plain; charset=utf-8"]],
        body: encodeBody(new TextEncoder().encode(`Frizz is not answering on this machine: ${error.message}`)),
        end: true,
      });
      resolve();
    });

    if (body) req.write(body);
    req.end();

    // Destroying the request destroys its response stream too, so a streaming SSE body stops being
    // read the moment the visitor is known to be gone. The error events that follow are silenced by
    // the `cancelled` flag the caller sets before invoking this.
    abort = () => {
      req.destroy();
      resolve();
    };
  }).catch(() => {
    // Node refused what the frame asked for: a method or a header value it will not write.
    if (!cancelled) options.send(badFrameAnswer(frame.id));
  });

  return {
    done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      abort?.();
    },
  };
}

/**
 * Headers a WebSocket CLIENT owns and a relay must never replay.
 *
 * These describe the handshake being made now, not the one the visitor made with the relay. Replaying
 * the visitor's `Sec-WebSocket-Key` would answer the local handshake with an accept value computed for
 * somebody else's key, which a strict client rejects.
 */
const HANDSHAKE_HEADERS: ReadonlySet<string> = new Set([
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-accept",
  "sec-websocket-extensions",
]);

/**
 * Open the board's end of a visitor's terminal and link the two.
 *
 * The board's terminals are WebSockets, so without this a relayed board can be read but not worked in.
 * The visitor's socket lives in the relay; this one is local; every message is carried between them as
 * a frame. Returns a handle the caller drives when frames arrive for this session.
 *
 * THE VISITOR'S HEADERS ARE THE WHOLE POINT OF THIS FUNCTION'S SHAPE. Frizz gates an upgrade on two of
 * them together: the `Origin` has to agree with the public origin, and the session cookie is what proves
 * the visitor redeemed an access code. Forward neither and the board destroys the socket, because a
 * browser always sends an Origin and this would not. The `Host` is not theirs to give: the relay
 * listener this dials treats every arrival as public, whatever it names.
 */
export function serveRelayWebSocket(
  frame: Extract<RelayDownFrame, { t: "ws-open" }>,
  options: {
    origin: string
    publicOrigin: string
    send: (frame: RelayUpFrame) => void
    connect?: (url: string, headers: Record<string, string>) => WebSocketLike
  },
): NestedSession {
  const open =
    options.connect ??
    ((url: string, h: Record<string, string>) => new WsWebSocket(url, { headers: h }) as unknown as WebSocketLike);
  let socket: WebSocketLike;
  try {
    const target = new URL(frame.url);
    const local = new URL(options.origin);
    target.protocol = local.protocol === "https:" ? "wss:" : "ws:";
    target.host = local.host;
    const headers = visitorHeaders(frame.headers, new URL(options.publicOrigin));
    for (const name of HANDSHAKE_HEADERS) delete headers[name];
    socket = open(target.toString(), headers);
  } catch (error) {
    options.send({ t: "ws-ack", id: frame.id, ok: false });
    return { message: () => {}, close: () => {}, failed: error instanceof Error ? error.message : String(error) };
  }

  let acked = false;
  socket.addEventListener("open", () => {
    acked = true;
    options.send({ t: "ws-ack", id: frame.id, ok: true });
  });
  socket.addEventListener("message", (event: { data: unknown }) => {
    if (typeof event.data !== "string") return;
    // CHUNKED, because a board frame may be four times what one relay message may carry. Sending it
    // whole would have it dropped in transit and the visitor's board would quietly stop updating.
    const parts = chunkWsMessage(event.data);
    parts.forEach((data, index) =>
      options.send({ t: "ws-msg", id: frame.id, data, ...(index < parts.length - 1 ? { more: true } : {}) }),
    );
  });
  const gone = () => {
    // If it never opened, the ack is a REFUSAL. Sending ok:true first and closing immediately after
    // would leave the visitor with a terminal that opened and then died for no stated reason.
    if (!acked) {
      acked = true;
      options.send({ t: "ws-ack", id: frame.id, ok: false });
      return;
    }
    options.send({ t: "ws-close", id: frame.id });
  };
  socket.addEventListener("close", gone);
  socket.addEventListener("error", gone);

  const inbound = new WsMessageAssembler();
  return {
    message: (data: string, more?: boolean) => {
      const whole = inbound.push(frame.id, data, more);
      if (whole === null) return;
      try {
        socket.send(whole);
      } catch {
        // The local terminal went away between frames; its close event will tell the relay.
      }
    },
    close: () => {
      try {
        socket.close();
      } catch {
        // Already gone.
      }
    },
  };
}

/** The bits of a WebSocket the agent uses. Node's global satisfies it. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

export interface NestedSession {
  /** `more` marks a continuation; the session reassembles before writing to the local socket. */
  message: (data: string, more?: boolean) => void;
  close: () => void;
  failed?: string;
}

/** Serialize a frame for the socket. Exported so the connection loop and tests agree on encoding. */
export const encodeFrame = (frame: RelayUpFrame): string => serializeFrame(frame);
