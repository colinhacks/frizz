#!/usr/bin/env nub
/**
 * The tunnel guide, driven end to end over the real internet.
 *
 * `docs/cloudflare-tunnel` makes three claims about the Frizz side that no unit test can settle: that a
 * board behind a tunnel accepts requests arriving as the public origin, that it REFUSES them without a
 * redeemed access code, and that scanning the link it prints turns a phone into a signed-in visitor.
 * Every one of those depends on headers a real Cloudflare edge sets and a loopback probe does not.
 *
 * A QUICK TUNNEL (`cloudflared tunnel --url`) rather than a named one, deliberately: it needs no zone,
 * no DNS record and no account, so this can run on any machine without touching anyone's
 * infrastructure. The named-tunnel commands in the guide are verified separately against
 * `cloudflared --help`; what is under test here is Frizz's behaviour behind a real edge.
 *
 * KNOWN EXTERNAL FAILURE, and read it before blaming this repo: on 2026-08-25 every quick tunnel from
 * this machine answered 404 for EVERY origin, including a trivial server that returns 200 to any path.
 * Both curl and fetch saw it, so the 404 comes from Cloudflare's edge and not from the board.
 * TryCloudflare is rate-limited and carries no uptime guarantee — it is documented as unreliable. If
 * this harness reports the tunnel never answering, prove the edge with a two-line origin server before
 * looking at Frizz, or point TUNNEL_GUIDE_HOSTNAME at a named tunnel on a zone you control.
 *
 * Runs the BUILT artifact, not the source, because that is what `npx frizz` gives a reader of the guide.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.TUNNEL_GUIDE_PORT ?? 47821);
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const home = mkdtempSync(join(tmpdir(), "frizz-tunnel-guide-"));
let tunnel = null;
let board = null;
const kill = (child) => { try { child?.kill("SIGTERM"); } catch { /* already gone */ } };

const waitFor = (stream, pattern, label, ms = 90_000) =>
  new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    const onData = (d) => {
      buf += d;
      const m = buf.match(pattern);
      if (m) { clearTimeout(timer); resolve(m); }
    };
    stream.on("data", onData);
  });

try {
  // 1. A real Cloudflare edge in front of a port nothing is listening on yet.
  tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  const [, host] = await waitFor(tunnel.stderr, /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/, "the tunnel hostname");
  const origin = `https://${host}`;
  check("a Cloudflare tunnel is up", true, origin);

  // 2. The BUILT artifact, told which origin fronts it.
  board = spawn(process.execPath, ["dist/frizz.js", "--public-origin", origin, "--port", String(PORT), "--no-app"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, FRIZZ_WAKERS_OFF: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  board.stdout.on("data", (d) => (out += d));
  board.stderr.on("data", (d) => (out += d));
  const [, code] = await waitFor(board.stdout, /frizz_code=([A-Za-z0-9_-]+)/, "the access link");
  check("the board printed a single-use access link", true, `${code.slice(0, 6)}…`);

  // 3. Reachable from the public internet, and REFUSED without the code.
  //
  // RETRIED, because the edge is not ready the instant cloudflared prints the hostname: the tunnel
  // registers before the origin is listening, and DNS for a fresh trycloudflare name takes a moment
  // to resolve. A single fetch here fails with a bare "fetch failed" that reads like a broken board.
  const reach = async () => {
    const deadline = Date.now() + 90_000;
    let last;
    while (Date.now() < deadline) {
      try {
        return await fetch(origin, { redirect: "manual" });
      } catch (error) {
        last = error;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error(`the tunnel never answered: ${last?.message ?? "unknown"}`);
  };
  const cold = await reach();
  check("the board is reachable through the tunnel", cold.status !== 0, `HTTP ${cold.status}`);
  check("and an uninvited visitor is refused", cold.status === 401, `HTTP ${cold.status}`);

  // 4. Redeeming the code is what a phone does when it scans the QR.
  const redeem = await fetch(`${origin}/?frizz_code=${encodeURIComponent(code)}`, { redirect: "manual" });
  const cookie = (redeem.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  check("scanning the link trades the code for a session", redeem.status === 302 && cookie.includes("__Host-frizz_session="), `HTTP ${redeem.status}`);

  const board200 = await fetch(origin, { headers: { cookie } });
  const html = await board200.text();
  check("the board itself loads for a signed-in visitor", board200.status === 200 && html.includes('id="root"'), `HTTP ${board200.status}, ${html.length} bytes`);

  // 5. The code is SINGLE use — the whole reason the link is safe to put on screen.
  const replay = await fetch(`${origin}/?frizz_code=${encodeURIComponent(code)}`, { redirect: "manual" });
  check("the same code cannot be redeemed twice", replay.status === 401, `HTTP ${replay.status}`);
} catch (error) {
  check("harness completed", false, error instanceof Error ? error.message : String(error));
} finally {
  kill(board);
  kill(tunnel);
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
