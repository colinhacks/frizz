import { exportClaimPublicKey } from "@frizz/shared/claim";
import { parseFrame, RELAY_KEEPALIVE_PING, relayHandshakeInput, serializeFrame, type RelayDownFrame, type RelayHandshake, type RelayUpFrame } from "@frizz/shared/relay-protocol";
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
  /** Bytes queued and not yet sent. Every WebSocket in the platform has it; a test's fake may not. */
  readonly bufferedAmount?: number;
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
 * The relay answers with a runtime auto-response, so a beat does not wake the Durable Object and bills
 * no duration; Cloudflare's pricing page leaves open whether it counts as an incoming message (20 to one
 * request), which at this rate would be 216 a day per board. What the beat buys is TCP liveness in both
 * directions: a NAT hole that stays open, and a socket that died without a FIN (a slept laptop, a changed
 * network) detected within one beat and the pong deadline instead of lingering while visitors time out.
 *
 * WHY 20s AND NOT 45s (2026-11-16). Cloudflare cuts a hibernated board socket now and then, and the board
 * often hears nothing: the socket is simply dead until the next frame crosses it. A visitor whose request
 * woke the relay into such a socket waited for the board to notice, reconnect and be sent the request again
 * (packages/relay/src/board-socket.ts), and the relay gives a visitor 30s for an answer. At 45s, with a
 * whole beat to answer each ping, the board noticed after up to 90s (52s on the board where it was seen),
 * so the phone got "The board did not answer: the board did not answer in time". This beat and the pong
 * deadline bound it to 25s.
 */
export const RELAY_KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * How long a ping may go unanswered before the socket is declared dead. The relay's auto-response comes
 * back in one round trip (about 100ms measured from a home connection), so five seconds is a dead socket
 * or a network too broken to serve a visitor anyway, never a slow answer.
 *
 * Measured from when the ping can have LEFT, not from when it was queued: it shares the socket with every
 * answer the board sends, so behind a few megabytes of a visitor's download on a slow uplink it waits its
 * turn for seconds. So the deadline starts over while the socket is still sending what was queued before it,
 * and anything at all arriving from the relay counts as the answer, since a busy relay is plainly there.
 */
export const RELAY_PONG_DEADLINE_MS = 5_000;

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
  /** The deadline for the ping in flight. See RELAY_PONG_DEADLINE_MS. */
  let pongHandle: unknown;
  let awaitingPong = false;
  /** Every byte handed to the socket to send, so the pong deadline can tell what has gone out. */
  let queuedBytes = 0;

  const clearPongDeadline = () => {
    if (pongHandle !== undefined) {
      clearTimer(pongHandle);
      pongHandle = undefined;
    }
  };

  const clearKeepalive = () => {
    if (keepaliveHandle !== undefined) {
      clearTimer(keepaliveHandle);
      keepaliveHandle = undefined;
    }
    clearPongDeadline();
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
      if (!socket) return;
      const data = serializeFrame(frame);
      socket.send(data);
      queuedBytes += data.length;
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
      clearPongDeadline();
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
    /**
     * The TCP under this socket is dead even though nobody sent a FIN. Treat it as dropped now rather
     * than serving nobody while every visitor times out.
     */
    const dead = () => {
      dropped();
      try {
        next.close();
      } catch {
        // Already gone.
      }
    };
    /**
     * The ping's deadline, started over while the `ahead` bytes queued before it (the ping's own included)
     * are still going out and some went out since. Answers keep being queued BEHIND the ping meanwhile, so
     * what went out is worked out from what was queued, not read off the buffer.
     */
    const armPongDeadline = (ahead: number) => {
      const buffered = next.bufferedAmount ?? 0;
      const mark = queuedBytes;
      pongHandle = setTimer(() => {
        pongHandle = undefined;
        if (stopped || socket !== next || !awaitingPong) return;
        const sent = buffered + (queuedBytes - mark) - (next.bufferedAmount ?? 0);
        if (ahead > 0 && sent > 0) {
          armPongDeadline(Math.max(0, ahead - sent));
          return;
        }
        dead();
      }, RELAY_PONG_DEADLINE_MS);
    };
    const beat = () => {
      if (stopped || socket !== next) return;
      if (awaitingPong) {
        // Still sending what was queued ahead of the ping, and the deadline is watching that: no second
        // ping behind the first.
        if (pongHandle !== undefined && (next.bufferedAmount ?? 0) > 0) {
          keepaliveHandle = setTimer(beat, RELAY_KEEPALIVE_INTERVAL_MS);
          return;
        }
        // The pong deadline normally catches a silent socket first; this is the backstop for a deadline
        // that never fired.
        dead();
        return;
      }
      awaitingPong = true;
      try {
        // The CONSTANT, not a locally built frame: the relay's auto-response matches these exact
        // bytes, which is what lets it answer without waking the Durable Object.
        next.send(RELAY_KEEPALIVE_PING);
        queuedBytes += RELAY_KEEPALIVE_PING.length;
      } catch {
        // The close event will follow and reconnect from there.
      }
      armPongDeadline(next.bufferedAmount ?? 0);
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
      // Anything from the relay answers the ping: see RELAY_PONG_DEADLINE_MS.
      if (socket === next && awaitingPong) {
        awaitingPong = false;
        clearPongDeadline();
      }
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
