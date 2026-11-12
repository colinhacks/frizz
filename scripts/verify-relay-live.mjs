#!/usr/bin/env nub
/**
 * The relay that is ACTUALLY SERVING `*.frizz.sh`, checked from outside. Run it after every Workers
 * deploy, and any time a relayed board misbehaves while the board itself is healthy.
 *
 * WHY IT EXISTS (2026-10-11, issue #49). The relay and the board ship separately, and nothing else in
 * this repo looks at the deployed one: `verify-relay-e2e.mjs` proves `main` on a local workerd, and
 * `workers-drift.yml` proves who uploaded a version, not what it does. On 2026-10-05 the live relay
 * was a build without 7264ab4c or c3f0dedd while `main` had carried both for five days. Every 304 came
 * back as a 504, so a phone that had the board cached revalidated its modules, got a 504 for each one
 * and rendered a blank page — and a fresh browser, which sends no validators, loaded fine. A relay
 * regression takes down every relayed board at once, so the check belongs here, on the relay, rather
 * than in a workaround on every board.
 *
 * HOW. A keypair of its own claims a private name from the production registrar — the call `frizz`
 * makes when the name prompt is answered with enter — and a TOY board on loopback dials the live relay
 * with it: canned strings, no Frizz, nothing worth reading. Then a visitor asks for everything the
 * frame protocol carries. Every request is on a deadline, because half of the failures this has to
 * catch are a response that never finishes rather than a wrong status.
 *
 * THE PROBE KEEPS ITS NAME. Key and name are saved in Frizz's state root (`relay-live-probe.json`), so
 * a second run RENEWS: the registrar charges a per-address budget for each NEW private name and has no
 * call to release one, and a fresh keypair per run would leave a row behind every time. It is never
 * the board's own `identity.key` — the registrar allows one live name per key, and that key's name is
 * the board's.
 *
 * TWO THINGS ONLY THE REAL EDGE DOES, which is why this is not `verify-relay-e2e.mjs` pointed at a
 * different host. It enforces the 1 MiB WebSocket message cap, which `wrangler dev` does not, so the
 * 2 MiB frame here is the one end-to-end proof that the chunks are small enough. And it re-compresses
 * a compressible body and WEAKENS its ETag on the way out (`"v1"` arrives as `W/"v1"`), so the
 * validator a real browser sends back is not the one the board minted.
 *
 *   nub scripts/verify-relay-live.mjs
 *
 * `FRIZZ_REGISTRAR` points it at another registrar, as it does for the CLI; `RELAY_PROBE_STATE` names
 * a different file for the saved key and name.
 */
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync } from "node:zlib";
import { WebSocket as WsClient, WebSocketServer } from "ws";
import { frizzPaths } from "@frizz/server/frizz-paths";
import {
  claimIdentityFromPrivateKey,
  exportClaimPrivateKey,
  exportClaimPublicKey,
  pickAnonymousClaimName,
  generateClaimIdentity,
  isAnonymousClaimName,
} from "@frizz/shared";
import { claimName } from "../src/registrar-client.ts";
import { connectRelay } from "../src/relay-connection.ts";

/** Generous for a round trip that measures ~120 ms, and short enough that a hang reads as one. */
const DEADLINE_MS = 15_000;
const BIG = 2 * 1024 * 1024;
const PROBE_COOKIE = "__Host-frizz_session=probe-value";

/**
 * The board every check talks to. Its `/cached` answers 304 to the weak form of its own tag as well as
 * the strong one, which is what the real board's `staticIsFresh` does and what the edge makes
 * necessary.
 */
export async function startToyBoard() {
  let handshake = {};
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.write("data: two\n\n"), 50);
      setTimeout(() => res.end(), 150);
      return;
    }
    if (req.url?.startsWith("/compressed")) {
      const body = brotliCompressSync(Buffer.from("BOARD-COMPRESSED"));
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "br", "content-length": String(body.byteLength) });
      res.end(body);
      return;
    }
    if (req.url?.startsWith("/cached")) {
      const held = String(req.headers["if-none-match"] ?? "").replace(/^W\//, "");
      if (held === '"v1"') { res.writeHead(304, { etag: '"v1"' }); res.end(); return; }
      res.writeHead(200, { "content-type": "text/plain", etag: '"v1"', "content-length": "6" });
      res.end("CACHED");
      return;
    }
    if (req.url?.startsWith("/nothing")) { res.writeHead(200, { "content-type": "text/plain", "content-length": "0" }); res.end(); return; }
    if (req.url?.startsWith("/moved")) { res.writeHead(302, { location: "/", "content-length": "0" }); res.end(); return; }
    if (req.url?.startsWith("/cookies")) {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "2", "set-cookie": ["a=1; Path=/", "b=2; Path=/"] });
      res.end("OK");
      return;
    }
    if (req.url?.startsWith("/ranged")) {
      res.writeHead(206, { "content-type": "text/plain", "content-range": "bytes 0-3/13", "content-length": "4" });
      res.end("BOAR");
      return;
    }
    if (req.url?.startsWith("/empty")) { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "content-type": "text/plain", "content-length": "13", "x-board": "yes" });
    res.end("BOARD-REACHED");
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/terminal")) { socket.destroy(); return; }
    handshake = req.headers;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => {
        const text = String(raw);
        if (text.startsWith("big:")) { ws.send("B".repeat(Number(text.slice(4)))); return; }
        ws.send(`pty:${text}`);
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    handshake: () => handshake,
    close: () => { wss.close(); server.closeAllConnections(); server.close(); },
  };
}

/**
 * Everything a visitor can ask a relayed board for, against `origin` (`https://<name>.frizz.sh`).
 *
 * Exported with the toy board so the same checks can be held against a relay that is known to be
 * broken: a check that has only ever been seen passing proves nothing about what it catches.
 * `depart` stops the board; given, the last check is that the relay stops serving it.
 */
export async function probeRelay(origin, { board, check, depart }) {
  const at = (path = "/") => `${origin}${path}`;
  const socketOrigin = origin.replace(/^http/, "ws");
  const host = new URL(origin).host;
  const visit = async (label, path, init = {}) => {
    try {
      const res = await fetch(at(path), { redirect: "manual", signal: AbortSignal.timeout(DEADLINE_MS), ...init });
      return { res, text: await res.text() };
    } catch (error) {
      return { res: null, text: `<${label}: ${error.name}>` };
    }
  };
  const told = (r) => (r.res ? `HTTP ${r.res.status}${r.text ? ` ${JSON.stringify(r.text.slice(0, 120))}` : ""}` : r.text);

  // The relay accepts the board's socket a moment before its Durable Object serves it.
  let reached = await visit("first request", "/");
  for (const until = Date.now() + 30_000; reached.res?.status !== 200 && Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, 500));
    reached = await visit("first request", "/");
  }
  check("a visitor reaches the board THROUGH the relay", reached.res?.status === 200 && reached.text === "BOARD-REACHED", told(reached));
  check("the board's headers survive the hop", reached.res?.headers.get("x-board") === "yes");

  // `fetch` undoes exactly one layer, as a browser does, so a body encoded twice fails here.
  const compressed = await visit("brotli", "/compressed", { headers: { "accept-encoding": "br" } });
  check("a brotli body the board encoded arrives encoded ONCE", compressed.text === "BOARD-COMPRESSED", told(compressed));

  // NULL-BODY STATUSES (7264ab4c). A relay without it answers each with a 504 reading "The board did
  // not answer: Response with null body status (101, 204, 205, or 304) cannot have a body."
  const fresh = await visit("cacheable page", "/cached");
  const tag = fresh.res?.headers.get("etag") ?? "";
  // The relay tags a validator with the serving board's key (packages/relay/src/visitor-headers.ts).
  check("a cacheable page arrives with its etag, tagged by the board's key", fresh.res?.status === 200 && /^"[A-Za-z0-9_-]{16}\.v1"$/.test(tag.replace(/^W\//, "")), `${told(fresh)} etag=${tag}`);
  check("and is revalidated before every use", fresh.res?.headers.get("cache-control") === "no-cache", `cache-control=${fresh.res?.headers.get("cache-control")}`);
  // What a browser really sends: the tag it was handed, which the edge may have weakened.
  const browserLike = await visit("revalidation with the served tag", "/cached", { headers: { "if-none-match": tag } });
  check("a revalidation with the served tag reaches the visitor AS 304", browserLike.res?.status === 304, `${told(browserLike)} if-none-match=${tag}`);
  const untagged = await visit("revalidation with an untagged validator", "/cached", { headers: { "if-none-match": '"v1"' } });
  check("a validator the relay did not hand out is answered in full", untagged.res?.status === 200, told(untagged));
  const empty = await visit("204", "/empty", { method: "POST" });
  check("a 204 from the board reaches the visitor as 204", empty.res?.status === 204, told(empty));

  // EMPTY BODIES THAT ARE NOT NULL-BODY STATUSES (c3f0dedd). A relay without it leaves each of these
  // loading forever, which is why they are on a deadline.
  const nothing = await visit("empty 200", "/nothing");
  check("an empty 200 from the board finishes loading", nothing.res?.status === 200 && nothing.text === "", told(nothing));
  const head = await visit("HEAD", "/", { method: "HEAD" });
  check("a HEAD request finishes, with the board's headers", head.res?.status === 200 && head.res.headers.get("x-board") === "yes", told(head));
  const moved = await visit("redirect", "/moved");
  check("a redirect reaches the visitor with its location", moved.res?.status === 302 && moved.res.headers.get("location") === "/", told(moved));

  const cookies = await visit("cookies", "/cookies");
  const setCookies = cookies.res?.headers.getSetCookie() ?? [];
  check("every set-cookie survives the hop, not only the first", setCookies.length === 2, JSON.stringify(setCookies));
  const ranged = await visit("206", "/ranged", { headers: { range: "bytes=0-3" } });
  check("a 206 partial body arrives as 206", ranged.res?.status === 206 && ranged.text === "BOAR", told(ranged));

  const stream = await visit("SSE", "/events");
  check("an SSE response arrives with both of its events", stream.res?.status === 200 && /data: one[\s\S]*data: two/.test(stream.text), told(stream));

  // A TERMINAL: visitor → the edge → Durable Object → the board's socket → a real ws server. `ws`
  // rather than the global, so the visitor carries the Origin and cookie a browser would.
  const typed = await new Promise((resolve) => {
    const visitor = new WsClient(`${socketOrigin}/terminal?id=abc`, { headers: { origin, cookie: PROBE_COOKIE } });
    const timer = setTimeout(() => { visitor.terminate(); resolve({ error: "the terminal never answered" }); }, 20_000);
    visitor.on("open", () => visitor.send("ls -la"));
    visitor.on("message", (raw) => { clearTimeout(timer); visitor.close(); resolve({ data: String(raw) }); });
    visitor.on("error", () => { clearTimeout(timer); resolve({ error: "the upgrade was refused" }); });
  });
  check("a terminal opens THROUGH the relay and echoes what was typed", typed.data === "pty:ls -la", typed.error ?? JSON.stringify(typed.data));
  const handshake = board.handshake();
  check(
    "the visitor's Origin and session cookie reach the board",
    handshake.origin === origin && handshake.cookie === PROBE_COOKIE,
    `origin=${handshake.origin} cookie=${handshake.cookie}`,
  );
  check("and the board is addressed by its PUBLIC host, which is what arms the access gate", handshake.host === host, `host=${handshake.host}`);

  // On the real edge this is the proof that a chunk fits: Cloudflare drops a message over 1 MiB.
  const big = await new Promise((resolve) => {
    const visitor = new WsClient(`${socketOrigin}/terminal`, { headers: { origin } });
    const timer = setTimeout(() => { visitor.terminate(); resolve({ error: "the big message never arrived" }); }, 60_000);
    visitor.on("open", () => visitor.send(`big:${BIG}`));
    visitor.on("message", (raw) => { clearTimeout(timer); visitor.close(); resolve({ length: String(raw).length }); });
    visitor.on("error", () => { clearTimeout(timer); resolve({ error: "the upgrade was refused" }); });
  });
  check("a 2 MiB board frame is reassembled whole from its chunks", big.length === BIG, big.error ?? `${big.length} of ${BIG} chars`);

  const refused = await new Promise((resolve) => {
    const visitor = new WsClient(`${socketOrigin}/nope`, { headers: { origin } });
    const timer = setTimeout(() => { visitor.terminate(); resolve("hung"); }, 20_000);
    visitor.on("open", () => { clearTimeout(timer); visitor.close(); resolve("accepted"); });
    visitor.on("error", () => { clearTimeout(timer); resolve("refused"); });
  });
  check("a terminal the board cannot open is refused, not silently accepted", refused === "refused", refused);

  if (!depart) return;
  depart();
  let gone = await visit("departed board", "/");
  for (const until = Date.now() + 20_000; gone.res?.status !== 502 && Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, 500));
    gone = await visit("departed board", "/");
  }
  check("a departed board stops being served", gone.res?.status === 502, told(gone));
}

/**
 * The probe's own key and name, minted on first use.
 *
 * A file that will not load is REPLACED, unlike the board's `identity.key`: nothing depends on this
 * name, so the cost of a new one is one registry row, where the cost of refusing would be a check
 * nobody can run.
 */
async function probeIdentity(path) {
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    const identity = await claimIdentityFromPrivateKey(new Uint8Array(Buffer.from(saved.pkcs8, "base64")));
    if (identity && isAnonymousClaimName(saved.name)) return { identity, name: saved.name };
  } catch {
    // Absent or unreadable: mint below.
  }
  const identity = await generateClaimIdentity();
  // One of the key's own random names: the registrar takes no other (deriveAnonymousClaimName).
  const name = await pickAnonymousClaimName(await exportClaimPublicKey(identity.publicKey));
  mkdirSync(dirname(path), { recursive: true });
  const pkcs8 = Buffer.from(await exportClaimPrivateKey(identity.privateKey)).toString("base64");
  writeFileSync(path, `${JSON.stringify({ name, pkcs8 })}\n`, { mode: 0o600 });
  return { identity, name };
}

async function main() {
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push(ok);
    console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const statePath = process.env.RELAY_PROBE_STATE?.trim() || join(frizzPaths().state, "relay-live-probe.json");
  const board = await startToyBoard();
  let connection = null;
  try {
    const { identity, name } = await probeIdentity(statePath);
    const claim = await claimName({ name, port: board.port, identity });
    const origin = `https://${claim.hostname}`;
    console.log(`probing the live relay as ${claim.hostname} (${claim.renewed ? "renewed" : "a NEW name"}, kept in ${statePath})`);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the relay never accepted the board's socket")), 30_000);
      connection = connectRelay({
        name,
        identity,
        // The board's own hostname IS the relay, as in cloud.ts.
        relayOrigin: origin,
        boardOrigin: `http://127.0.0.1:${board.port}`,
        publicOrigin: origin,
        onStatus: (status) => {
          if (status === "connected") { clearTimeout(timer); resolve(); }
        },
      });
    });
    check("the live relay accepts the board's socket", true, origin);

    await probeRelay(origin, { board, check, depart: () => connection.stop() });
  } catch (error) {
    check("the probe ran to the end", false, error instanceof Error ? error.message : String(error));
  } finally {
    connection?.stop();
    board.close();
  }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  // An exit rather than a return: a relay socket mid-reconnect would hold the process open.
  process.exit(passed === checks.length ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
