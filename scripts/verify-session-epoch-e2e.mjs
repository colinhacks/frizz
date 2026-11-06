#!/usr/bin/env nub
/**
 * SESSION_EPOCH, end to end, on the BUILT launcher: an upgrade signs out every remote device that signed
 * in before it, once, and nothing else.
 *
 * The store's tests prove the rotation. They cannot prove that the launcher applies it on a real start
 * against a real state directory, that it says so on the operator's terminal, that the operator's own
 * loopback tab is untouched, and that the NEXT start leaves the new sessions alone. Only a real board
 * restarted twice shows all four.
 *
 * "A board from before the release" is simulated by deleting the epoch record, which is exactly what an
 * older launcher leaves on disk (it never wrote one). Needs `nub scripts/build-package.mjs --shell`
 * first; the first boot installs the pinned frizz-server into the throwaway HOME, which takes a minute
 * or two.
 *
 *   nub scripts/build-package.mjs --shell && nub scripts/verify-session-epoch-e2e.mjs
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cloudConfigPath } from "../src/cloud.ts";

const PORT = Number(process.env.SESSION_EPOCH_PORT ?? 47953);
const ORIGIN = "https://board.example.com";
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** RAW http: `fetch` silently drops a Host header, so every probe would arrive as loopback. */
const ask = (path, { host = "board.example.com", cookie } = {}) =>
  new Promise((resolve, reject) => {
    const headers = { host };
    if (cookie) headers.cookie = cookie;
    const req = httpRequest({ host: "127.0.0.1", port: PORT, path, method: "GET", headers, setHost: false }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, setCookie: res.headers["set-cookie"] ?? [] }));
    });
    req.on("error", reject);
    req.end();
  });

const home = mkdtempSync(join(tmpdir(), "frizz-epoch-e2e-"));
// An `external` setup gates the origin and starts nothing, so no relay or tunnel is in the way.
const cloudJson = cloudConfigPath(home);
mkdirSync(dirname(cloudJson), { recursive: true });
writeFileSync(cloudJson, JSON.stringify({ hostname: new URL(ORIGIN).hostname, serve: "external", provider: "other" }));
const env = { ...process.env, HOME: home, FRIZZ_WAKERS_OFF: "1" };

let board = null;
const startBoard = async () => {
  const child = spawn(process.execPath, ["dist/frizz.js", "--port", String(PORT), "--no-app"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const code = await new Promise((resolve, reject) => {
    const fail = (why) => { clearTimeout(timer); try { child.kill("SIGTERM"); } catch { /* gone */ } reject(new Error(`${why}:\n${out.slice(-600)}`)); };
    const timer = setTimeout(() => fail("the board never printed a link"), 300_000);
    child.once("exit", (exit) => fail(`the board exited (${exit}) before printing a link`));
    const onData = (d) => {
      out += d;
      const m = out.match(/frizz_code=([A-Za-z0-9_-]+)/);
      if (m) { clearTimeout(timer); child.removeAllListeners("exit"); resolve(m[1]); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
  // Give the readout a beat to print its last rows (the notice rides on the ready block).
  await new Promise((r) => setTimeout(r, 1500));
  return { child, code, out: () => out };
};
const stopBoard = async () => {
  const exited = new Promise((r) => board.once("exit", r));
  board.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 20_000))]);
  board = null;
};
const cli = (...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/frizz.js", ...args], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });
const redeem = async (code) => (await ask(`/?frizz_code=${encodeURIComponent(code)}`)).setCookie;
const NOTICE = /Security update: signed out (\d+) remote device/;

try {
  const first = await startBoard();
  board = first.child;
  // The state root is platform-dependent (~/Library/Application Support/Frizz on macOS, ~/.frizz where
  // one already exists), so find the key rather than guessing where it lives.
  const stateDir = readdirSync(home, { recursive: true })
    .filter((path) => String(path).endsWith(`${"/"}session-key`) && !String(path).includes("node_modules"))
    .map((path) => dirname(join(home, String(path))))[0];
  check("a board is running behind a public origin, with its session key on disk", !!stateDir, stateDir ?? "no session-key under HOME");
  check("a first run says nothing about signing anyone out", !NOTICE.test(first.out()));

  const phoneCookies = await redeem(first.code);
  const phone = phoneCookies.map((c) => c.split(";")[0]).join("; ");
  check("a phone redeems a link", phone.includes("__Host-frizz_session="));
  check("its cookie lives 30 days, not a year", /Max-Age=2592000\b|Max-Age=2591999\b/.test(phoneCookies.join(" ")), phoneCookies.join(" ").replace(/__Host-frizz_session=[^;]+/, "__Host-frizz_session=…"));
  check("the phone is let in", (await ask("/", { cookie: phone })).status === 200);
  // A cookie signed with this board's real key that the device list never recorded: refused all along.
  const key = readFileSync(join(stateDir, "session-key"));
  const payload = `${Date.now() + 60 * 24 * 60 * 60_000}.never-recorded.nonce`;
  const forged = `__Host-frizz_session=${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
  check("a session the key signed but nobody redeemed is refused", (await ask("/", { cookie: forged })).status === 401);

  // Back to a board from before the release: an older launcher never wrote the epoch record.
  await stopBoard();
  const epochFile = join(stateDir, "session-epoch");
  check("the first run recorded the epoch", existsSync(epochFile) && JSON.parse(readFileSync(epochFile, "utf8")).epoch >= 1);
  rmSync(epochFile);

  const upgraded = await startBoard();
  board = upgraded.child;
  const notice = upgraded.out().match(NOTICE);
  check("the upgraded start tells the operator, on the terminal", notice?.[1] === "1", notice?.[0] ?? upgraded.out().slice(-400));
  check("the phone's old session is refused", (await ask("/", { cookie: phone })).status === 401);
  check("the epoch is recorded again", existsSync(epochFile));
  const loopback = await ask("/", { host: `127.0.0.1:${PORT}` });
  check("the operator's own loopback tab is untouched", loopback.status < 400, `HTTP ${loopback.status}`);
  const listed = await cli("--sessions");
  check("--sessions no longer lists the phone", listed.code === 0 && /No device is signed in/.test(listed.out), listed.out.trim());
  const logs = readdirSync(join(stateDir, "logs"))
    .filter((name) => /^frizz-.*\.log$/.test(name))
    .map((name) => readFileSync(join(stateDir, "logs", name), "utf8"))
    .join("\n");
  check("the run log records the rotation", /session epoch 0 -> \d+: rotated the session key/.test(logs));

  const link = await cli("--link");
  const laptopCode = link.out.match(/frizz_code=([A-Za-z0-9_-]+)/)?.[1];
  const laptop = (await redeem(laptopCode ?? "missing")).map((c) => c.split(";")[0]).join("; ");
  check("a fresh link signs a device in after the upgrade", (await ask("/", { cookie: laptop })).status === 200);

  // The next ordinary start must not sign anyone out again.
  await stopBoard();
  const again = await startBoard();
  board = again.child;
  check("a second start says nothing about signing out", !NOTICE.test(again.out()));
  check("and the device that signed in after the upgrade is still in", (await ask("/", { cookie: laptop })).status === 200);
  check("while the old phone stays out", (await ask("/", { cookie: phone })).status === 401);
} catch (error) {
  check("harness completed", false, error instanceof Error ? error.message : String(error));
} finally {
  try { board?.kill("SIGTERM"); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 3000));
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
