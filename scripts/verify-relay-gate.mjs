#!/usr/bin/env nub
/**
 * A relayed terminal against the REAL access gate.
 *
 * `verify-relay-e2e.mjs` proves the frames reach a socket server. It cannot prove the thing that
 * matters most about a terminal on the public internet: that Frizz's own gate stands in front of it.
 * Its board is a toy that accepts every upgrade, so a relay forwarding NO identity at all passes there
 * and fails against the real thing — in whichever direction is worse.
 *
 * So this puts the real `RestartSupervisorProxy` in the path, with a public origin declared, and asks
 * it the only two questions worth asking: is an unauthenticated terminal REFUSED, and does a visitor
 * holding a redeemed session get through? No relay and no workerd — the seam under test is the board's
 * authority boundary, and adding a runtime either side of it would only make a failure harder to read.
 */
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { RestartSupervisorProxy } from "@frizz/server/restart-supervisor";
import { CALLER_HEADER, decodeCallerStamp } from "../packages/server/src/audit.ts";
import { serveRelayRequest, serveRelayWebSocket } from "../src/relay-agent.ts";

const PUBLIC_ORIGIN = "https://ada.frizz.sh";
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Drive one relayed request and report the status it came back with. */
function relayed(path, headers, options, method = "GET") {
  return new Promise((resolve) => {
    serveRelayRequest(
      { t: "req", id: "r1", method, url: `${PUBLIC_ORIGIN}${path}`, headers },
      { ...options, send: (frame) => { if (frame.t === "res") resolve(frame.status); } },
    );
  });
}

/** Drive one relayed upgrade and report what the board did with it. */
function attempt(headers, options) {
  return new Promise((resolve) => {
    const out = [];
    const session = serveRelayWebSocket(
      { t: "ws-open", id: "w1", url: `${PUBLIC_ORIGIN}/terminal`, headers },
      { ...options, send: (frame) => { out.push(frame); if (frame.t === "ws-ack") { clearTimeout(timer); resolve({ ok: frame.ok, session }); } } },
    );
    const timer = setTimeout(() => resolve({ ok: null, session }), 15_000);
  });
}

let child = null;
let proxy = null;
try {
  // A stand-in board: the real proxy's child, serving one terminal. What it does with the socket is
  // beside the point — whether the upgrade reaches it at all is the whole test.
  const wss = new WebSocketServer({ noServer: true });
  let reached = 0;
  let lastStamp;
  const stampOf = (req) => { lastStamp = decodeCallerStamp(req.headers[CALLER_HEADER]); };
  child = createServer((req, res) => { reached++; stampOf(req); res.writeHead(200); res.end("board"); });
  child.on("upgrade", (req, socket, head) => {
    reached++;
    stampOf(req);
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (raw) => ws.send(`pty:${String(raw)}`)));
  });
  child.listen(0, "127.0.0.1");
  await once(child, "listening");
  const childPort = child.address().port;

  // The real boundary, with a public origin declared — which is what arms the access gate at all.
  const port = 47590;
  proxy = new RestartSupervisorProxy({
    port,
    publicOrigin: PUBLIC_ORIGIN,
    childPort: () => childPort,
    restart: async () => ({ state: "ready" }),
  });
  await proxy.listen();
  // The relay agent's own door, as the launcher wires it: everything arriving on it is public.
  const boardOrigin = `http://127.0.0.1:${await proxy.relayListener()}`;
  check("the real supervisor proxy is serving with a public origin", true, PUBLIC_ORIGIN);

  // 1. NO IDENTITY AT ALL — what the relay agent used to send.
  const bare = await attempt([], { origin: boardOrigin, publicOrigin: PUBLIC_ORIGIN });
  check("a terminal with no visitor identity is refused", bare.ok === false, `ack ok=${bare.ok}`);
  bare.session.close();

  // 2. THE VISITOR'S HEADERS, BUT NO REDEEMED SESSION. This is the one that matters: the board must
  //    see a PUBLIC arrival and demand the code, not read loopback and wave a shell through.
  const before = reached;
  const uninvited = await attempt(
    [["host", "ada.frizz.sh"], ["origin", PUBLIC_ORIGIN]],
    { origin: boardOrigin, publicOrigin: PUBLIC_ORIGIN },
  );
  check("a visitor without a redeemed access code is refused", uninvited.ok === false, `ack ok=${uninvited.ok}`);
  check("and the upgrade never reached the board behind the gate", reached === before, `${reached - before} got through`);
  uninvited.session.close();

  // 3. A REDEEMED SESSION. Mint a code the way the launcher does, trade it for the cookie a browser
  //    would hold, and present that.
  const code = proxy.issueAccessCode();
  // RAW node:http, because `fetch` SILENTLY DROPS a Host header — it is forbidden in undici. The
  // redemption would then arrive as loopback, the gate would never engage, and the 403 that comes back
  // reads as a broken gate rather than as a broken probe.
  const redeem = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: `/?frizz_code=${encodeURIComponent(code.code)}`,
        headers: { host: "ada.frizz.sh", origin: PUBLIC_ORIGIN },
        setHost: false,
      },
      (res) => { res.resume(); resolve({ status: res.statusCode, setCookie: res.headers["set-cookie"] ?? [] }); },
    );
    req.on("error", reject);
    req.end();
  });
  const cookie = redeem.setCookie.map((c) => c.split(";")[0]).join("; ");
  check("an access code is traded for a session cookie", cookie.includes("__Host-frizz_session="), `HTTP ${redeem.status}`);

  const invited = await attempt(
    [["host", "ada.frizz.sh"], ["origin", PUBLIC_ORIGIN], ["cookie", cookie]],
    { origin: boardOrigin, publicOrigin: PUBLIC_ORIGIN },
  );
  check("a visitor holding a redeemed session opens a terminal", invited.ok === true, `ack ok=${invited.ok}`);
  invited.session.close();

  // 4. A RELAY THAT LIES. `host` and `Host` together, then spellings Node would merge, with a forged Origin
  //    as well: each one used to read as the operator's own tab, with no session asked for.
  const loopbackOrigin = `http://127.0.0.1:${port}`;
  const forgeries = {
    "host + Host": [["host", "ada.frizz.sh"], ["Host", `127.0.0.1:${port}`]],
    "HOST": [["HOST", `127.0.0.1:${port}`]],
    "hOsT": [["hOsT", `localhost:${port}`]],
    "X-Forwarded-Host": [["host", "ada.frizz.sh"], ["X-Forwarded-Host", "127.0.0.1"]],
    "x-frizz-caller": [["host", "ada.frizz.sh"], ["X-Frizz-Caller", Buffer.from(JSON.stringify({ via: "loopback", remote: "127.0.0.1", session: null })).toString("base64url")]],
  };
  const agent = { origin: boardOrigin, publicOrigin: PUBLIC_ORIGIN };
  for (const [name, forged] of Object.entries(forgeries)) {
    const headers = [...forged, ["origin", loopbackOrigin], ["sec-fetch-site", "same-origin"]];
    const before = reached;
    check(`${name}, no cookie: GET / refused`, (await relayed("/", headers, agent)) === 401);
    check(`${name}, no cookie: minting a link refused`, (await relayed("/_frizz/control/access-code", headers, agent, "POST")) === 401);
    const socket = await attempt(headers, agent);
    check(`${name}, no cookie: a terminal refused`, socket.ok === false, `ack ok=${socket.ok}`);
    socket.session.close();
    check(`${name}, no cookie: the board behind the gate was reached 0 times`, reached === before, `${reached - before} got through`);

    // With a real session and an Origin that agrees, the same frame reaches the board as what it is.
    const withSession = [...forged, ["origin", PUBLIC_ORIGIN], ["cookie", cookie]];
    check(`${name}, with a session: reaches the board`, (await relayed("/", withSession, agent)) === 200);
    check(`${name}, with a session: stamped public`, lastStamp?.via === "public", JSON.stringify(lastStamp?.via));
    const live = await attempt(withSession, agent);
    check(`${name}, with a session: a terminal opens, stamped public`, live.ok === true && lastStamp?.via === "public", JSON.stringify(lastStamp?.via));
    live.session.close();
    check(`${name}, with a session: minting a link still refused`, (await relayed("/_frizz/control/access-code", withSession, agent, "POST")) === 403);
  }
} catch (error) {
  check("harness completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await proxy?.close().catch(() => undefined);
  child?.closeAllConnections?.();
  child?.close();
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
