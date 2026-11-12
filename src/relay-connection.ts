import {
  exportClaimPublicKey,
  parseFrame,
  RELAY_KEEPALIVE_PING,
  relayHandshakeInput,
  serializeFrame,
  type RelayDownFrame,
  type RelayHandshake,
  type RelayUpFrame,
} from "@frizz/shared";
import { serveRelayRequest, serveRelayWebSocket, type NestedSession, type RelayedRequest } from "./relay-agent.ts";

/**
 * The board's connection to the relay: dial out, prove who we are, then serve whatever arrives.
 *
 * The board is the one that reaches out. That single fact is what removes the inbound port, the tunnel
 * binary and the per-user DNS record all at once — and it is why a laptop behind any NAT works with no
 * configuration at all.
 *
 * RECONNECTION IS THE FEATURE, not an afterthought. A laptop sleeps, changes network and loses Wi-Fi
 * constantly; a relay connection that does not come back by itself would mean a board that is
 * permanently unreachable after the first suspend, with nothing on screen to say so.
 */

export interface RelayConnectionOptions {
  /** The claimed name, e.g. `ada`. */
  name: string;
  /** The identity that claimed it. The handshake proves ownership with the same key. */
  identity: CryptoKeyPair;
  /** The relay's origin, e.g. `https://frizz.sh`. */
  relayOrigin: string;
  /** The supervisor's relay listener on loopback, e.g. `http://127.0.0.1:53124`: see relayListener. */
  boardOrigin: string;
  /** The hostname visitors use, e.g. `https://ada.frizz.sh`. */
  publicOrigin: string;
  /** Injected so a test can drive this without a real relay. */
  socketFactory?: (url: string) => RelaySocket;
  /**
   * `displaced` is the relay closing this board's socket for a reason the operator should hear about once:
   * the name now belongs to another key, or another connection with this key took it over.
   */
  onStatus?: (status: "connected" | "disconnected" | "retrying" | "displaced", detail?: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Bounded so a test does not wait out real backoff. */
  backoff?: (attempt: number) => number;
}

/** The bits of a WebSocket this uses. Node's global and `ws` both satisfy it. */
export interface RelaySocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event?: { code?: number; reason?: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

const b64url = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Exponential with a ceiling and jitter.
 *
 * The jitter matters more than the curve: when the relay restarts, every board on it is disconnected
 * in the same instant, and without jitter they would all return in the same instant too.
 */
/**
 * How long a connection must hold before it counts as a success worth resetting the backoff for.
 *
 * Shorter than the shortest useful session and far longer than an immediate rejection, so a relay that
 * accepts and hangs up is treated as the failure it is.
 */
const SETTLED_MS = 10_000

export function defaultBackoff(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
  return Math.round(base / 2 + random() * (base / 2));
}

/**
 * How often the board pings the relay, and therefore how long a dead socket can masquerade as live.
 *
 * The relay answers with a runtime auto-response, so a beat costs nothing on the far side — it does
 * not even wake the Durable Object. What the beat buys is TCP liveness in both directions: a NAT
 * hole that stays open, and a socket that died without a FIN (a slept laptop, a changed network)
 * detected within two beats instead of lingering half-dead for hours while every visitor times out.
 */
export const RELAY_KEEPALIVE_INTERVAL_MS = 45_000;

/**
 * How much one relay connection may have open at once. Each entry holds a socket, memory and a timer
 * here, and a frame costs its sender nothing, so without a ceiling whoever writes frames can exhaust
 * the board. Well above a real page: a load's burst of reads, and a board socket plus its terminals.
 */
export const RELAY_MAX_OPEN_REQUESTS = 256;
export const RELAY_MAX_OPEN_SOCKETS = 64;

export async function signRelayHandshake(name: string, identity: CryptoKeyPair, issuedAt: number): Promise<RelayHandshake> {
  const pubkey = await exportClaimPublicKey(identity.publicKey);
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    identity.privateKey,
    relayHandshakeInput(name, pubkey, issuedAt) as BufferSource,
  );
  return { v: 1, name, pubkey, issuedAt, sig: b64url(signature) };
}

export interface RelayConnection {
  stop(): void;
  readonly connected: boolean;
}

export function connectRelay(options: RelayConnectionOptions): RelayConnection {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const backoff = options.backoff ?? defaultBackoff;
  const makeSocket =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as RelaySocket);

  let socket: RelaySocket | null = null;
  /** Local terminals, one per visitor session the relay has opened. */
  const nested = new Map<string, NestedSession>();
  /** Relayed requests in flight, so a visitor who hung up stops being served. */
  const requests = new Map<string, RelayedRequest>();
  let attempt = 0;
  let stopped = false;
  let retryHandle: unknown;
  let keepaliveHandle: unknown;
  let awaitingPong = false;

  const clearKeepalive = () => {
    if (keepaliveHandle !== undefined) {
      clearTimer(keepaliveHandle);
      keepaliveHandle = undefined;
    }
  };

  const cancelRequests = () => {
    // The relay can no longer deliver these responses — or has already dropped them — so the local
    // requests producing them must stop. Left running, an SSE feed streams into the void forever,
    // and after a reconnect its frames would ride the NEW socket with ids the relay no longer
    // knows, waking the Durable Object once per event to be ignored.
    for (const request of requests.values()) request.cancel();
    requests.clear();
  };

  const send = (frame: RelayUpFrame) => {
    try {
      socket?.send(serializeFrame(frame));
    } catch {
      // The socket died between the request arriving and its answer. The relay fails the request on
      // its side when the connection drops, so there is nothing useful to do here.
    }
  };

  /** A nested socket's frames, watched for the last one: the entry goes when the local end does. */
  const sendNested = (frame: RelayUpFrame) => {
    if (frame.t === "ws-close" || (frame.t === "ws-ack" && !frame.ok)) nested.delete(frame.id);
    send(frame);
  };

  const serveFrame = (data: string) => {
    const frame = parseFrame(data) as RelayDownFrame | null;
    if (!frame) return;
    if (frame.t === "ping") {
      send({ t: "pong", id: frame.id });
      return;
    }
    if (frame.t === "pong") {
      awaitingPong = false;
      return;
    }
    if (frame.t === "req") {
      // A reused id would orphan the entry it replaced, and the ceiling would stop counting it.
      if (requests.has(frame.id)) return;
      if (requests.size >= RELAY_MAX_OPEN_REQUESTS) {
        send({ t: "res", id: frame.id, status: 503, headers: [], end: true });
        return;
      }
      const handle = serveRelayRequest(frame, {
        origin: options.boardOrigin,
        publicOrigin: options.publicOrigin,
        send,
      });
      requests.set(frame.id, handle);
      void handle.done.then(() => {
        if (requests.get(frame.id) === handle) requests.delete(frame.id);
      });
      return;
    }
    if (frame.t === "req-cancel") {
      requests.get(frame.id)?.cancel();
      requests.delete(frame.id);
      return;
    }
    if (frame.t === "ws-open") {
      if (nested.has(frame.id)) return;
      if (nested.size >= RELAY_MAX_OPEN_SOCKETS) {
        send({ t: "ws-ack", id: frame.id, ok: false });
        return;
      }
      const session = serveRelayWebSocket(frame, {
        origin: options.boardOrigin,
        publicOrigin: options.publicOrigin,
        send: sendNested,
      });
      // A session that failed outright has already said so, and has nothing to keep.
      if (!session.failed) nested.set(frame.id, session);
      return;
    }
    if (frame.t === "ws-msg") {
      nested.get(frame.id)?.message(frame.data, frame.more);
      return;
    }
    if (frame.t === "ws-close") {
      nested.get(frame.id)?.close();
      nested.delete(frame.id);
    }
  };

  const scheduleRetry = (reason: string) => {
    if (stopped) return;
    const delay = backoff(attempt++);
    options.onStatus?.("retrying", `${reason}; retrying in ${Math.round(delay / 1000)}s`);
    retryHandle = setTimer(() => void open(), delay);
  };

  const open = async (): Promise<void> => {
    if (stopped) return;
    let handshake: RelayHandshake;
    try {
      handshake = await signRelayHandshake(options.name, options.identity, now());
    } catch (error) {
      scheduleRetry(`could not sign the relay handshake: ${error instanceof Error ? error.message : error}`);
      return;
    }
    // The handshake rides in the URL so the relay can judge it before upgrading — an unproven socket
    // then never occupies the name's Durable Object at all.
    const encoded = b64url(new TextEncoder().encode(JSON.stringify(handshake)).buffer as ArrayBuffer);
    const url = `${options.relayOrigin.replace(/^http/, "ws").replace(/\/$/, "")}/_relay/connect?h=${encoded}`;

    const next = makeSocket(url);
    socket = next;

    let settled: unknown;
    const beat = () => {
      if (stopped || socket !== next) return;
      if (awaitingPong) {
        // The last ping went unanswered for a whole interval: the TCP under this socket is dead
        // even though nobody sent a FIN. Treat it as dropped now rather than serving nobody for
        // hours while every visitor times out.
        dropped();
        try {
          next.close();
        } catch {
          // Already gone.
        }
        return;
      }
      awaitingPong = true;
      try {
        // The CONSTANT, not a locally built frame: the relay's auto-response matches these exact
        // bytes, which is what lets it answer without waking the Durable Object.
        next.send(RELAY_KEEPALIVE_PING);
      } catch {
        // The close event will follow and reconnect from there.
      }
      keepaliveHandle = setTimer(beat, RELAY_KEEPALIVE_INTERVAL_MS);
    };

    next.addEventListener("open", () => {
      // THE COUNTER RESETS ON A CONNECTION THAT LASTS, not on one that merely opens.
      //
      // Resetting here made the backoff unreachable whenever the relay accepted a socket and dropped
      // it immediately: every attempt "succeeded", so every retry waited backoff(0) — measured at ~2
      // reconnects per second, indefinitely, against our own edge. A board that cannot stay connected
      // must back off like one that cannot connect at all.
      awaitingPong = false;
      keepaliveHandle = setTimer(beat, RELAY_KEEPALIVE_INTERVAL_MS);
      settled = setTimer(() => { attempt = 0; }, SETTLED_MS);
      options.onStatus?.("connected");
    });

    next.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      // ONE BAD FRAME COSTS ONE FRAME. Whoever writes to this socket must not be able to end the
      // process serving every other visitor by sending something this code did not expect.
      try {
        serveFrame(event.data);
      } catch {
        // Dropped: the relay times out whatever was waiting on it.
      }
    });

    const dropped = (event?: { code?: number; reason?: unknown }) => {
      if (socket !== next) return; // a socket we already replaced
      // The relay names why it closed a board that is still current (packages/relay/src/worker.ts), and
      // both reasons are news: nothing else tells the operator their board stopped serving its name.
      const displaced =
        event?.code === 4003
          ? "the Frizz relay closed this board's connection because its name now belongs to another key"
          : String(event?.reason ?? "") === "replaced by a newer connection"
            ? "another connection signed with this machine's identity took the name over. If no other Frizz runs with this identity, its key may have been copied"
            : null;
      if (displaced) options.onStatus?.("displaced", displaced);
      if (settled !== undefined) { clearTimer(settled); settled = undefined; }
      clearKeepalive();
      socket = null;
      // The relay is gone, so every terminal riding on it is too. Closing the local ends stops a
      // sign-in terminal from being held open by a session nothing can reach any more.
      for (const session of nested.values()) session.close();
      nested.clear();
      cancelRequests();
      options.onStatus?.("disconnected");
      scheduleRetry("the relay connection closed");
    };
    next.addEventListener("close", (event) => dropped(event));
    next.addEventListener("error", () => dropped());
  };

  void open();

  return {
    stop() {
      stopped = true;
      if (retryHandle !== undefined) clearTimer(retryHandle);
      clearKeepalive();
      try {
        socket?.close();
      } catch {
        // Already gone.
      }
      for (const session of nested.values()) session.close();
      nested.clear();
      cancelRequests();
      socket = null;
    },
    get connected() {
      return socket !== null;
    },
  };
}
