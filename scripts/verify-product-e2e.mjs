#!/usr/bin/env nub
/**
 * The whole product, against the LIVE registrar and the LIVE relay.
 *
 * Every other harness here stands something in for the internet — workerd on loopback, a supervisor
 * with an invented public origin, a toy board that accepts any upgrade. This one has no stand-ins. It
 * claims a name from the registrar that is actually deployed, serves a real board through the relay
 * that is actually deployed, and reaches it the way a phone does: over the public internet, by
 * hostname, through Cloudflare.
 *
 * WHAT IT COSTS: a 30-day lease on the name. The seeded config is a relay claim, so the launch RENEWS
 * it with the owning key alone — no GitHub sign-in, nothing new consumed. The name must therefore be
 * held by that key already. A renewal works while custom names are withdrawn (CUSTOM_NAMES_OFFERED in
 * src/cloud.ts), because it never touches GitHub; a custom name nobody holds yet cannot be claimed at
 * all until they return, and then only through the R pane's GitHub device-flow sign-in, which this
 * harness cannot answer.
 *
 * Three things it has to do that a naive harness gets wrong, each of which cost a run:
 *
 *   A PTY, NOT A PIPE. The board's readout is a terminal UI, and `script` cannot stand in for one —
 *   it wants a terminal on its own stdin and dies with tcgetattr/ioctl.
 *
 *   A SAVED CONFIG rather than the R walkthrough. Remote access is set up interactively now, and the
 *   walkthrough's cursor starts on whichever choice is CURRENT — so blind key-sending picks a
 *   different option depending on prior state. Seeding `~/.frizz/cloud.json` is what the walkthrough
 *   writes, and it exercises the path every launch after the first one takes, which is the path that
 *   actually has to keep working.
 *
 *   A GIT REPOSITORY as the launch directory, from when Frizz refused a bare one. Neither is adopted
 *   any more — a launch from a folder that is not already a project lands on the dashboard, hosted
 *   on Frizz's own folder — and nothing below asks which board is open.
 *
 *   THE OWNING IDENTITY, seeded into the sandbox home. A name belongs to the key that claimed it, so a
 *   fresh key is correctly refused with "that name is already taken" — verified below, because that
 *   refusal is the whole ownership model.
 *
 * KNOWN FLAKE, 2026-08-26, and it is NOT this harness: a board with a saved setup sometimes comes up
 * loopback-only. When it does, `serveSaved()` neither throws nor acts — nothing is printed, and the
 * cloud.json is still on disk and still correct afterwards (this harness checks both on failure). That
 * points at the `home` the remote controller resolves in the launched process rather than at the config.
 * Re-run; when the setup takes, every check below passes.
 */
import { execFileSync } from "node:child_process";
import { spawn as spawnPty } from "node-pty";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsClient } from "ws";

const NAME = process.env.FRIZZ_PRODUCT_NAME ?? "colin";
const ORIGIN = `https://${NAME}.frizz.sh`;
const PORT = Number(process.env.FRIZZ_PRODUCT_PORT ?? 47990);
const CLI = process.env.FRIZZ_PRODUCT_CLI ?? join(process.cwd(), "dist/frizz.js");

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const home = mkdtempSync(join(tmpdir(), "frizz-product-home-"));
const project = mkdtempSync(join(tmpdir(), "frizz-product-repo-"));
let pty = null;

const until = async (label, fn, ms = 150_000) => {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
};

const socket = (headers) =>
  new Promise((resolve) => {
    const ws = new WsClient(`wss://${NAME}.frizz.sh/_frizz/ws`, { headers });
    const timer = setTimeout(() => resolve({ verdict: "hung" }), 45_000);
    ws.on("open", () => { clearTimeout(timer); resolve({ verdict: "open", ws }); });
    ws.on("error", (error) => { clearTimeout(timer); resolve({ verdict: "refused", detail: error.message }); });
  });

try {
  if (!existsSync(CLI)) throw new Error(`no artifact at ${CLI} — run scripts/build-package.mjs first`);

  // The key that owns NAME. Defaults to this machine's own identity; FRIZZ_PRODUCT_IDENTITY points at
  // a different key file when the run exercises a name claimed by a throwaway identity instead — an
  // anonymous name above all, whose whole point is that no account of ours is anywhere near it.
  const owned = process.env.FRIZZ_PRODUCT_IDENTITY ?? join(homedir(), ".frizz", "identity.key");
  if (existsSync(owned)) {
    mkdirSync(join(home, ".frizz"), { recursive: true });
    copyFileSync(owned, join(home, ".frizz", "identity.key"));
  }

  const git = (...args) =>
    execFileSync("git", args, {
      cwd: project,
      env: { ...process.env, GIT_AUTHOR_NAME: "frizz", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "frizz", GIT_COMMITTER_EMAIL: "f@example.invalid" },
    });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");

  // What the R walkthrough writes once a frizz.sh name is chosen.
  mkdirSync(join(home, ".frizz"), { recursive: true });
  writeFileSync(
    join(home, ".frizz", "cloud.json"),
    JSON.stringify({ hostname: `${NAME}.frizz.sh`, claim: NAME, serve: "relay" }, null, 2),
  );

  const env = { ...process.env, HOME: home, FRIZZ_WAKERS_OFF: "1" };
  pty = spawnPty(process.execPath, [CLI, "--no-app", "--port", String(PORT)], {
    name: "xterm-color", cols: 100, rows: 30, cwd: project, env,
  });

  let out = "";
  // ANSI-STRIPPED. The readout is styled, so a phrase that reads as one run on screen is broken up by
  // escape codes in the stream — matching the raw bytes silently never fires.
  const plain = () => out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  pty.onData((chunk) => (out += chunk));
  // Wait for the REMOTE readout, not just the local one. A board with no saved setup says "press R to
  // reach this board"; one that came up on its saved name offers a sign-in link instead.
  {
    const deadline = Date.now() + 180_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      up = /fresh sign-in link/.test(plain()) || plain().includes(`${NAME}.frizz.sh`);
      if (!up) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!up) {
      // GREP THE WHOLE STREAM, not its tail. The readout is a TUI that repaints over itself, so an
      // error printed during boot is scrolled out of the visible frame while still sitting in the bytes.
      const said = plain().split("\n").map((l) => l.trim()).filter((l) => l.startsWith("frizz:"));
      // Is the seeded config still there, and still what we wrote? A boot path that rewrites it would
      // look exactly like one that ignored it.
      let onDisk = "(missing)";
      try { onDisk = readFileSync(join(home, ".frizz", "cloud.json"), "utf8").replace(/\s+/g, " "); } catch { /* missing */ }
      console.log(`  cloud.json after boot: ${onDisk}`);
      throw new Error(
        `the board never came up on its saved name.\n  frizz said: ${said.length ? said.join("\n  frizz said: ") : "(nothing)"}\n  tail:\n${plain().split("\n").filter((l) => l.trim()).slice(-8).join("\n")}`,
      );
    }
  }
  check("a saved frizz.sh name is served on a plain launch", true, ORIGIN);

  // Mint the link with --link rather than scraping the readout: the readout shows it as a QR, which is
  // exactly right for a phone and useless to a harness.
  const minted = execFileSync(process.execPath, [CLI, "--link"], { cwd: project, env, encoding: "utf8" });
  const code = (minted.match(/frizz_code=([A-Za-z0-9_-]+)/) ?? [])[1];
  check("--link mints a fresh single-use link", !!code, code ? `${code.slice(0, 6)}…` : minted.trim().slice(0, 120));
  if (!code) throw new Error("no access code to redeem");

  const cold = await until("the relay to serve the board", async () => {
    const res = await fetch(ORIGIN, { redirect: "manual" });
    return res.status !== 404 && res.status !== 502 ? res : null;
  });
  check("the board answers at its own hostname, over the internet", cold.status === 401, `HTTP ${cold.status}`);

  const redeem = await fetch(`${ORIGIN}/?frizz_code=${encodeURIComponent(code)}`, { redirect: "manual" });
  const cookie = (redeem.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  // The refusal page names the reason, and the reasons point at very different bugs: "already used"
  // means something redeemed it first (a retry at the edge would do that, and single-use plus retry is
  // a broken sign-in); "no such link" means the code was minted against a different board.
  const why = redeem.status === 302 ? "" : (await redeem.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
  check("the access link redeems into a session", redeem.status === 302 && cookie.includes("__Host-frizz_session="), `HTTP ${redeem.status}${why ? ` — ${why}` : ""}`);

  const page = await fetch(ORIGIN, { headers: { cookie } });
  const html = await page.text();
  check("the board itself loads through the relay", page.status === 200 && html.includes('id="root"'), `HTTP ${page.status}, ${html.length} bytes`);

  const asset = await fetch(`${ORIGIN}/favicon.svg`, { headers: { cookie } });
  check("static assets come through too", asset.status === 200, `HTTP ${asset.status}`);

  // The nested WebSocket, against Cloudflare's own edge. Nothing on loopback can prove this.
  const live = await socket({ cookie, origin: ORIGIN });
  check("a WebSocket opens THROUGH the relay", live.verdict === "open", live.detail ?? live.verdict);
  if (live.ws) {
    const frame = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 30_000);
      live.ws.on("message", (raw) => { clearTimeout(timer); resolve(String(raw)); });
    });
    check("and the board pushes a real frame down it", !!frame, frame ? `${frame.length} bytes` : "nothing arrived");
    live.ws.close();
  }

  const bare = await socket({ origin: ORIGIN });
  check("an unauthenticated WebSocket is refused", bare.verdict === "refused", bare.verdict);

  const uninvited = await fetch(ORIGIN, { redirect: "manual" });
  check("a visitor without the cookie is still refused", uninvited.status === 401, `HTTP ${uninvited.status}`);

  // SIGN-OUT, against a board on the public internet. Locally this is 14/14, but the whole point of the
  // feature is revoking a device you no longer hold — which is a device reaching the board from away.
  const cli = (...args) => {
    try {
      return execFileSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: "utf8" });
    } catch (error) {
      return `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
  };
  const listed = cli("--sessions");
  const deviceId = (listed.match(/^\s*(\S+)\s+\S/m) ?? [])[1];
  check("--sessions names the device that redeemed over the internet", !!deviceId, listed.trim().split("\n")[0] ?? listed.slice(0, 90));

  if (deviceId) {
    const out = cli("--sign-out", deviceId);
    check("--sign-out reports it signed that device out", /Signed out/.test(out), out.trim().slice(0, 80));
    const after = await fetch(ORIGIN, { headers: { cookie }, redirect: "manual" });
    check("the signed-out device is locked out THROUGH the relay", after.status === 401, `HTTP ${after.status}`);
    const afterWs = await socket({ cookie, origin: ORIGIN });
    check("and its WebSocket is refused too", afterWs.verdict === "refused", afterWs.verdict);
  }
} catch (error) {
  check("harness completed", false, error instanceof Error ? error.message : String(error));
} finally {
  // KEEP THE IDENTITY. The name is bound to this key, so discarding it would leave a claimed name
  // nobody can renew — and the lease still runs for 30 days.
  const minted = join(home, ".frizz", "identity.key");
  const target = join(homedir(), ".frizz", "identity.key");
  try {
    if (existsSync(minted) && !existsSync(target)) {
      mkdirSync(join(homedir(), ".frizz"), { recursive: true });
      copyFileSync(minted, target);
      console.log(`\n  kept the claim identity at ${target} — it is what proves you own ${NAME}.frizz.sh`);
    }
  } catch (error) {
    console.log(`\n  WARNING: could not keep the claim identity: ${error.message}`);
  }
  try { pty?.kill(); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 3000));
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
