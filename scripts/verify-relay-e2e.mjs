#!/usr/bin/env nub
/**
 * The relay, end to end, on REAL workerd.
 *
 * Every piece of this is unit-tested against fakes, which proves each one and nothing about the seams
 * between them — and there are three seams here, all of which have to hold at once: the board's socket
 * to the Durable Object, the Durable Object to the visitor's request, and the frame protocol between
 * the two runtimes that implement it. So this runs the actual Worker under `wrangler dev`, a real
 * board on loopback, and a real agent connecting them.
 *
 * The zone is `localhost` rather than `frizz.sh`, so `ada.localhost` is a valid board name and
 * resolves to loopback without touching DNS or needing the wildcard route. That is the only
 * difference from production, and it exercises the same hostname-parsing code.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { brotliCompressSync } from "node:zlib";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket as WsClient, WebSocketServer } from "ws";
import { exportClaimPublicKey, generateClaimIdentity } from "@frizz/shared";
import { connectRelay } from "../src/relay-connection.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const DEV_PORT = Number(process.env.RELAY_PORT ?? 47461);
const BOARD_PORT = DEV_PORT + 1;

/**
 * A REAL hostname, not a spoofed header.
 *
 * `fetch` silently drops a `Host` header — it is a forbidden header name in undici — so setting one
 * does nothing and every request arrives as 127.0.0.1. That reads as "the relay 404s everything",
 * which is a bug in the test rather than the Worker. `*.localhost` resolves to loopback, so the URL
 * carries the hostname honestly.
 */
const at = (host, path = "/") => `http://${host}.localhost:${DEV_PORT}${path}`;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const wait = async (label, fn, ms = 90_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${label}`);
};

let dev = null;
let boardServer = null;
let connection = null;
const state = mkdtempSync(join(tmpdir(), "frizz-relay-e2e-"));

try {
  const identity = await generateClaimIdentity();
  const pubkey = await exportClaimPublicKey(identity.publicKey);

  // The registry row the relay reads to learn who owns `ada`, seeded into wrangler's LOCAL kv so the
  // run touches no real Cloudflare state. BEFORE `wrangler dev` starts: the dev process holds that
  // store open, and a write from a second process afterwards is not seen by the running Worker.
  const seed = spawn(
    "nubx",
    ["-y", "wrangler", "kv", "key", "put", "claim:ada",
     JSON.stringify({ pubkey, tunnelId: "", port: BOARD_PORT, claimedAt: Date.now(), renewedAt: Date.now() }),
     "--binding", "CLAIMS", "--local", "--persist-to", state],
    { cwd: join(repo, "packages/relay"), stdio: ["ignore", "ignore", "pipe"] },
  );
  const [seedCode] = await once(seed, "exit");
  if (seedCode !== 0) throw new Error(`seeding the claim failed with exit ${seedCode}`);

  // A dev config of its own, WITHOUT the production `[[routes]]`.
  //
  // `wrangler dev` synthesizes the request URL from the route pattern, so with `*.frizz.sh` in the
  // config every request arrives at the Worker as `frizz.sh` no matter what was actually requested —
  // and the relay refuses it, correctly, for not being a board name. That reads as a broken relay and
  // is entirely an artefact of the config.
  const devConfig = join(state, "wrangler.dev.toml");
  writeFileSync(
    devConfig,
    [
      'name = "frizz-relay-dev"',
      `main = "${join(repo, "packages/relay/src/worker.ts")}"`,
      'compatibility_date = "2026-08-24"',
      "",
      "[vars]",
      'FRIZZ_ZONE = "localhost"',
      "",
      "[[durable_objects.bindings]]",
      'name = "BOARD"',
      'class_name = "Board"',
      "",
      "[[migrations]]",
      'tag = "v1"',
      'new_sqlite_classes = ["Board"]',
      "",
      "[[kv_namespaces]]",
      'binding = "CLAIMS"',
      'id = "aa4a9c11473d4511a556e3e3a6857058"',
      "",
    ].join("\n"),
  );

  dev = spawn(
    "nubx",
    ["-y", "wrangler", "dev", "-c", devConfig, "--port", String(DEV_PORT), "--ip", "127.0.0.1", "--persist-to", state],
    { cwd: join(repo, "packages/relay"), stdio: ["ignore", "pipe", "pipe"] },
  );
  let devOut = "";
  dev.stdout.on("data", (d) => (devOut += d));
  dev.stderr.on("data", (d) => (devOut += d));

  await wait("wrangler dev to listen", async () => {
    try {
      const res = await fetch(at("nobody"));
      return res.status > 0;
    } catch {
      return false;
    }
  });
  check("the relay Worker is running on workerd", true, `127.0.0.1:${DEV_PORT}`);

  // An unclaimed name must be refused before anything else happens.
  const unclaimed = await fetch(at("nobody"));
  check("an unclaimed name is refused", unclaimed.status === 404, `HTTP ${unclaimed.status}`);

  // A claimed name with no board behind it is a DIFFERENT answer, and a visitor can act on it.
  const offline = await fetch(at("ada"));
  check("a claimed name with no board says so", offline.status === 502, `HTTP ${offline.status}`);

  // A real board on loopback.
  boardServer = createServer((req, res) => {
    if (req.url?.startsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.write("data: two\n\n"), 50);
      setTimeout(() => res.end(), 150);
      return;
    }
    if (req.url?.startsWith("/compressed")) {
      // What the real board does with index.html and every asset: brotli, declared in the header.
      const body = brotliCompressSync(Buffer.from("BOARD-COMPRESSED"));
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "br", "content-length": String(body.byteLength) });
      res.end(body);
      return;
    }
    if (req.url?.startsWith("/cached")) {
      // A revalidation, which is what a browser's back button sends for a page it still holds.
      if (req.headers["if-none-match"] === '"v1"') { res.writeHead(304, { etag: '"v1"' }); res.end(); return; }
      res.writeHead(200, { "content-type": "text/plain", etag: '"v1"', "content-length": "6" });
      res.end("CACHED");
      return;
    }
    if (req.url?.startsWith("/nothing")) {
      // An ordinary empty body: a 200 that says so with content-length 0, or a redirect with none.
      res.writeHead(200, { "content-type": "text/plain", "content-length": "0" });
      res.end();
      return;
    }
    if (req.url?.startsWith("/moved")) {
      res.writeHead(302, { location: "/", "content-length": "0" });
      res.end();
      return;
    }
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
    if (req.url?.startsWith("/empty")) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain", "content-length": "13", "x-board": "yes" });
    res.end("BOARD-REACHED");
  });
  // A REAL terminal on the board, because a relayed board you cannot type into is not Frizz. This is
  // the seam nothing else exercises: the visitor's socket lives in workerd, this one is on loopback,
  // and every keystroke is a frame carried between two different runtimes.
  const wss = new WebSocketServer({ noServer: true });
  let handshake = {};
  boardServer.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/terminal")) { socket.destroy(); return; }
    handshake = req.headers;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => {
        const text = String(raw);
        // A board's own frames go to 4 MiB, four times what one relay message may carry. Answering a
        // request for one is how this harness proves a big snapshot is chunked rather than dropped.
        if (text.startsWith("big:")) { ws.send("B".repeat(Number(text.slice(4)))); return; }
        ws.send(`pty:${text}`);
      });
    });
  });
  boardServer.listen(BOARD_PORT, "127.0.0.1");
  await once(boardServer, "listening");

  connection = connectRelay({
    name: "ada",
    identity,
    relayOrigin: `http://ada.localhost:${DEV_PORT}`,
    boardOrigin: `http://127.0.0.1:${BOARD_PORT}`,
    publicOrigin: `http://ada.localhost:${DEV_PORT}`,
  });

  const served = await wait("the board to be served through the relay", async () => {
    const res = await fetch(at("ada"));
    return res.status === 200 ? res : null;
  });
  check("a visitor reaches the board THROUGH the relay", true, `HTTP ${served.status}`);
  check("the body is the board's own", (await served.text()) === "BOARD-REACHED");
  check("the board's headers survive the hop", served.headers.get("x-board") === "yes");

  // A body the board ALREADY ENCODED. Workers compress a constructed Response to match its
  // content-encoding header unless told the body already is, so a brotli page went out brotli twice
  // and a phone rendered the inner layer as text. `fetch` undoes exactly one layer, which is what a
  // browser does, so a doubly-encoded body fails this check rather than passing by accident.
  const compressed = await fetch(at("ada", "/compressed"), { headers: { "accept-encoding": "br" } });
  const inflated = await compressed.text().catch((error) => `<${error.message}>`);
  check("a brotli body the board encoded arrives encoded ONCE", inflated === "BOARD-COMPRESSED", JSON.stringify(inflated.slice(0, 40)));

  // A NULL-BODY status. The Response constructor throws for 101/204/205/304 given any body, even an
  // empty stream, so a revalidated page came back as a 504 that read "The board did not answer" — on
  // a phone, every time the back button reused a cached page (2026-09-30).
  const fresh = await fetch(at("ada", "/cached"));
  // The relay tags a validator with the serving board's key (packages/relay/src/visitor-headers.ts), so a
  // copy cached while someone else held the name is never revalidated against this board.
  const tag = fresh.headers.get("etag") ?? "";
  check("a cacheable page arrives with its etag, tagged by the board's key", fresh.status === 200 && /^"[A-Za-z0-9_-]{16}\.v1"$/.test(tag), `HTTP ${fresh.status} etag=${tag}`);
  await fresh.arrayBuffer();
  const revalidated = await fetch(at("ada", "/cached"), { headers: { "if-none-match": tag } });
  check("a revalidation the board answers 304 reaches the visitor AS 304", revalidated.status === 304, `HTTP ${revalidated.status} ${revalidated.status === 304 ? "" : await revalidated.text()}`);
  const untagged = await fetch(at("ada", "/cached"), { headers: { "if-none-match": '"v1"' } });
  check("a validator the relay did not hand out is answered in full", untagged.status === 200 && (await untagged.text()) === "CACHED", `HTTP ${untagged.status}`);
  const empty = await fetch(at("ada", "/empty"), { method: "POST" });
  check("a 204 from the board reaches the visitor as 204", empty.status === 204, `HTTP ${empty.status} ${empty.status === 204 ? "" : await empty.text()}`);

  // EMPTY BODIES THAT ARE NOT NULL-BODY STATUSES. The board sends these as one frame with no body, and
  // the visitor's stream has to END — a stream left open is a request that never finishes loading.
  // Every fetch is on a deadline so a hang fails this check instead of hanging the harness.
  const settled = async (label, promise) => {
    try {
      const res = await promise;
      return { res, text: await res.text() };
    } catch (error) {
      return { res: null, text: `<${label}: ${error.name}>` };
    }
  };
  const nothing = await settled("empty 200", fetch(at("ada", "/nothing"), { signal: AbortSignal.timeout(10_000) }));
  check("an empty 200 from the board finishes loading", nothing.res?.status === 200 && nothing.text === "", nothing.res ? `HTTP ${nothing.res.status}` : nothing.text);
  const head = await settled("HEAD", fetch(at("ada"), { method: "HEAD", signal: AbortSignal.timeout(10_000) }));
  check("a HEAD request finishes, with the board's headers", head.res?.status === 200 && head.res.headers.get("x-board") === "yes", head.res ? `HTTP ${head.res.status}` : head.text);
  const moved = await settled("redirect", fetch(at("ada", "/moved"), { redirect: "manual", signal: AbortSignal.timeout(10_000) }));
  check("a redirect reaches the visitor with its location", moved.res?.status === 302 && moved.res.headers.get("location") === "/", moved.res ? `HTTP ${moved.res.status} location=${moved.res.headers.get("location")}` : moved.text);
  const cookies = await settled("cookies", fetch(at("ada", "/cookies"), { signal: AbortSignal.timeout(10_000) }));
  const setCookies = cookies.res?.headers.getSetCookie() ?? [];
  check("every set-cookie survives the hop, not only the first", setCookies.length === 2, JSON.stringify(setCookies));
  const ranged = await settled("206", fetch(at("ada", "/ranged"), { headers: { range: "bytes=0-3" }, signal: AbortSignal.timeout(10_000) }));
  check("a 206 partial body arrives as 206", ranged.res?.status === 206 && ranged.text === "BOAR", ranged.res ? `HTTP ${ranged.res.status} ${JSON.stringify(ranged.text)}` : ranged.text);

  // The seam that a request/response relay would fail: an SSE body has to arrive as it is produced.
  const stream = await fetch(at("ada", "/events"));
  check("an SSE response opens", stream.status === 200, stream.headers.get("content-type") ?? "");
  const body = await stream.text();
  check("both events arrived over the relay", /data: one[\s\S]*data: two/.test(body), JSON.stringify(body.slice(0, 40)));

  // A TERMINAL, end to end: visitor → workerd → Durable Object → the board's socket → a real ws server.
  const typed = await new Promise((resolve) => {
    // `ws` rather than the global, so the visitor can carry the identity a browser would. This is the
    // link nothing else covers: whether workerd puts Origin and Cookie into the frame at all. If it
    // drops them, the board's access gate never sees a visitor and a real terminal is refused.
    const visitor = new WsClient(`ws://ada.localhost:${DEV_PORT}/terminal?id=abc`, {
      headers: { origin: `http://ada.localhost:${DEV_PORT}`, cookie: "__Host-frizz_session=probe-value" },
    });
    const timer = setTimeout(() => resolve({ error: "the terminal never answered" }), 20_000);
    visitor.on("open", () => visitor.send("ls -la"));
    visitor.on("message", (raw) => {
      clearTimeout(timer);
      resolve({ data: String(raw), close: () => visitor.close() });
    });
    visitor.on("error", () => {
      clearTimeout(timer);
      resolve({ error: "the upgrade was refused" });
    });
  });
  check("a terminal opens THROUGH the relay and echoes what was typed", typed.data === "pty:ls -la", typed.error ?? JSON.stringify(typed.data));
  check(
    "the visitor's Origin and session cookie survive workerd and reach the board",
    handshake.origin === `http://ada.localhost:${DEV_PORT}` && handshake.cookie === "__Host-frizz_session=probe-value",
    `origin=${handshake.origin} cookie=${handshake.cookie}`,
  );
  check("and the board is addressed by its PUBLIC host, which is what arms the access gate", handshake.host === `ada.localhost:${DEV_PORT}`, `host=${handshake.host}`);
  typed.close?.();

  // A SINGLE MESSAGE LARGER THAN CLOUDFLARE CARRIES, reassembled from chunks.
  //
  // WHAT THIS DOES NOT PROVE, measured rather than assumed: `wrangler dev` does NOT enforce the 1 MiB
  // WebSocket message cap, so an UNCHUNKED build passes this check too. It covers the reassembly and
  // nothing else. The assertion that the chunks are actually small enough for the real edge is a unit
  // test — `a message too large for one relay frame is split below the wire limit`.
  const BIG = 2 * 1024 * 1024;
  const big = await new Promise((resolve) => {
    const visitor = new WsClient(`ws://ada.localhost:${DEV_PORT}/terminal`);
    const timer = setTimeout(() => resolve({ error: "the big message never arrived" }), 60_000);
    visitor.on("open", () => visitor.send(`big:${BIG}`));
    visitor.on("message", (raw) => {
      clearTimeout(timer);
      resolve({ length: String(raw).length, close: () => visitor.close() });
    });
    visitor.on("error", () => { clearTimeout(timer); resolve({ error: "the upgrade was refused" }); });
  });
  check("a 2 MiB board frame is reassembled whole from its chunks", big.length === BIG, big.error ?? `${big.length} of ${BIG} chars`);
  big.close?.();

  // A path the board has no terminal on must FAIL the upgrade rather than accept a silent socket.
  const refused = await new Promise((resolve) => {
    const visitor = new WebSocket(`ws://ada.localhost:${DEV_PORT}/nope`);
    const timer = setTimeout(() => resolve("hung"), 20_000);
    visitor.addEventListener("open", () => { clearTimeout(timer); resolve("accepted"); visitor.close(); });
    visitor.addEventListener("error", () => { clearTimeout(timer); resolve("refused"); });
  });
  check("a terminal the board cannot open is refused, not silently accepted", refused === "refused", refused);

  // A board that goes away must stop being served, rather than hanging visitors.
  connection.stop();
  boardServer.closeAllConnections?.();
  boardServer.close();
  boardServer = null;
  const gone = await wait("the relay to notice the board left", async () => {
    const res = await fetch(at("ada"));
    return res.status !== 200 ? res : null;
  }, 30_000);
  check("a departed board stops being served", gone.status === 502, `HTTP ${gone.status}`);
} catch (error) {
  check("harness completed", false, error instanceof Error ? error.message : String(error));
} finally {
  connection?.stop();
  boardServer?.close();
  if (dev) {
    dev.kill("SIGINT");
    await Promise.race([once(dev, "exit"), new Promise((r) => setTimeout(r, 10_000))]);
    dev.kill("SIGKILL");
  }
  rmSync(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
