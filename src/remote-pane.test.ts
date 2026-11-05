import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudConfig } from "./cloud.ts";
import { createRemotePane } from "./remote-pane.ts";

// The menu lists "Custom subdomain" only while custom names are offered. They are withdrawn for now, but the
// form behind the row is kept, and several cases below drive it — so this file runs with the override
// on, for the whole file because `nub --test` runs a file's tests concurrently. The withdrawn menu is
// pinned in custom-names-paused.test.ts.
process.env.FRIZZ_CUSTOM_NAMES = "1";

function fakeOutput() {
  const chunks: string[] = [];
  return {
    stream: { write: (chunk: string) => { chunks.push(chunk); return true; } } as unknown as NodeJS.WriteStream,
    text: () => chunks.join(""),
    reset: () => { chunks.length = 0; },
  };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function build(overrides: Partial<Parameters<typeof createRemotePane>[0]> = {}) {
  const out = fakeOutput();
  let current: CloudConfig | null = null;
  const applied: Array<CloudConfig | null> = [];
  const pane = createRemotePane({
    port: 9393,
    current: () => current,
    apply: async (next) => { applied.push(next); current = next; },
    claim: async (name) => ({ hostname: `${name}.frizz.sh`, claim: name, serve: "relay" }),
    issueLink: () => (current ? { code: "c0de", url: `https://${current.hostname}/?frizz_code=c0de`, expiresAt: Date.now() + 300_000 } : null),
    probes: {
      cloudflared: async () => ({ version: "2025.8.1" }),
      tailscale: async () => ({ installed: true, dnsName: "mac-mini.corgi-alpha.ts.net" }),
    },
    output: out.stream,
    ...overrides,
  });
  const type = (text: string) => { for (const ch of text) pane.key(ch); };
  return { pane, out, applied, type, current: () => current };
}

test("R opens the chooser with every setup, and Off applies loopback-only", async () => {
  const { pane, out, applied } = build();
  assert.equal(pane.open(), true);
  for (const title of ["frizz.sh subdomain", "Custom subdomain", "Cloudflare Tunnel", "Tailscale", "Something else", "Off"]) assert.match(out.text(), new RegExp(title));
  assert.match(out.text(), /Off.*\(current\)/s);
  pane.key("6");
  assert.equal(pane.key("\r"), "keep");
  await settle();
  assert.deepEqual(applied, [null]);
  assert.match(out.text(), /Loopback only/);
  // The done screen closes on any key.
  assert.equal(pane.key("x"), "close");
});

test("Cloudflare Tunnel asks for the hostname and the tunnel, then serves them", async () => {
  const { pane, out, applied, type } = build();
  pane.open();
  pane.key("3");
  pane.key("\r");
  await settle();
  assert.match(out.text(), /cloudflared tunnel route dns my-board board\.example\.com/);
  assert.match(out.text(), /cloudflared\s+found, 2025\.8\.1 ✓/);
  type("board.example.com");
  pane.key("\r"); // next field
  type("my-board");
  pane.key("\r"); // submit
  await settle();
  assert.deepEqual(applied, [{ hostname: "board.example.com", tunnel: "my-board" }]);
  assert.match(out.text(), /Serving https:\/\/board\.example\.com \(Cloudflare Tunnel\)/);
  assert.match(out.text(), /frizz_code=c0de/);
});

test("Tailscale offers this machine's MagicDNS name and saves an external origin", async () => {
  const { pane, out, applied } = build();
  pane.open();
  pane.key("4");
  pane.key("\r");
  await settle();
  assert.match(out.text(), /tailscale serve --bg 9393/);
  assert.match(out.text(), /https:\/\/mac-mini\.corgi-alpha\.ts\.net/);
  pane.key("\r"); // accept the placeholder
  await settle();
  assert.deepEqual(applied, [{ hostname: "mac-mini.corgi-alpha.ts.net", serve: "external", provider: "tailscale" }]);
});

test("a frizz.sh name is claimed through a GitHub sign-in, and a failure goes back to the form", async () => {
  const claims: string[] = [];
  const { pane, out, applied, type } = build({
    claim: async (name) => {
      claims.push(name);
      if (name === "taken") throw new Error("that name is taken");
      return { hostname: `${name}.frizz.sh`, claim: name, serve: "relay" };
    },
  });
  pane.open();
  pane.key("2"); // the cursor starts on the current setup (Off), so pick the custom name explicitly
  pane.key("\r");
  await settle();
  assert.match(out.text(), /github\.com\/login\/device/, "the screen says how the account is confirmed");
  assert.doesNotMatch(out.text(), /GitHub CLI|gh auth/, "and never asks for the gh CLI");
  type("taken");
  pane.key("\r");
  await settle();
  assert.match(out.text(), /Could not apply that: that name is taken/);
  assert.equal(pane.key("x"), "keep"); // back to the form
  for (let i = 0; i < 5; i++) pane.key("\x7f");
  type("ada");
  pane.key("\r");
  await settle();
  assert.deepEqual(claims, ["taken", "ada"]);
  assert.deepEqual(applied, [{ hostname: "ada.frizz.sh", claim: "ada", serve: "relay" }]);
  assert.match(out.text(), /Serving https:\/\/ada\.frizz\.sh \(frizz\.sh\)/);
});

test("escape leaves a form for the menu, and leaves the menu for the readout", () => {
  const { pane } = build();
  pane.open();
  pane.key("5");
  pane.key("\r");
  assert.equal(pane.key("\x1b"), "keep");
  assert.equal(pane.key("\x1b"), "close");
});

test("under --sandbox the frizz.sh screen says a claim is real, and the others say nothing", async () => {
  const { pane, out } = build({ sandbox: true });
  pane.open();
  pane.key("2");
  pane.key("\r");
  await settle();
  assert.match(out.text(), /This is a sandbox, but a claim is real/);
  pane.key("\x1b");
  out.reset();
  pane.key("5");
  pane.key("\r");
  assert.doesNotMatch(out.text(), /claim is real/);
});

test("a private name claims on the spot — no form, no GitHub, QR straight away", async () => {
  // The auth-free default. Choosing it IS the claim: the pane asks nothing, mints through claim("")
  // and lands on the done screen with the sign-in QR.
  const claims: string[] = [];
  const { pane, out, applied } = build({
    claim: async (name) => {
      claims.push(name);
      return { hostname: "abcdefghjkmnpqrstuvw.frizz.sh", claim: "abcdefghjkmnpqrstuvw", serve: "relay" };
    },
  });
  pane.open();
  pane.key("1");
  pane.key("\r");
  await settle();
  assert.deepEqual(claims, [""], "an empty name asks the claimer to mint one");
  assert.deepEqual(applied, [{ hostname: "abcdefghjkmnpqrstuvw.frizz.sh", claim: "abcdefghjkmnpqrstuvw", serve: "relay" }]);
  assert.match(out.text(), /Serving https:\/\/abcdefghjkmnpqrstuvw\.frizz\.sh \(frizz\.sh\)/);
  assert.match(out.text(), /frizz_code=c0de/, "the done screen offers the sign-in QR");
  assert.equal(pane.key("x"), "close");
});

test("in an 80x24 window the done screen keeps the whole code on screen", async () => {
  // Message, code, URL, note and the way back were 31 rows; the alternate screen scrolled the top of
  // the code, finder patterns and all, off an 80x24 window. The screen now sheds its blank lines and
  // the note instead, and never ends on a newline.
  const { pane, out } = build();
  Object.assign(out.stream, { columns: 80, rows: 24 });
  pane.open();
  pane.key("1");
  pane.key("\r");
  await settle();
  const screen = out.text().split("\x1b[2J\x1b[H").pop()!.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const rows = screen.split("\n");
  assert.ok(rows.length <= 24, `the done screen is ${rows.length} rows in a 24-row window`);
  assert.match(rows[0]!, /Serving/, "the message is the top line once the margin is dropped");
  const quiet = rows.findIndex((row) => /^ {2}\s+$/.test(row) && row.length > 30);
  assert.ok(quiet >= 0 && quiet <= 2, "the code's top quiet zone sits right under the message");
  assert.ok(rows.some((row) => row.includes("frizz_code=c0de")), "the URL still fits");
  assert.ok(rows.some((row) => row.includes("press any key to return")), "and the way back");
});

test("a saved private name shows as the current setup on the private row", () => {
  const config: CloudConfig = { hostname: "abcdefghjkmnpqrstuvw.frizz.sh", claim: "abcdefghjkmnpqrstuvw", serve: "relay" };
  const { pane, out } = build({ current: () => config });
  pane.open();
  assert.match(out.text(), /❯ frizz\.sh subdomain/, "the cursor starts on the current setup");
  assert.match(out.text(), /frizz\.sh subdomain.*\(current\)/s);
});

test("a word claim shows GitHub's device code, and escape on that screen cancels it", async () => {
  // The code has to be painted INSIDE the pane: a console line would land under the alternate screen.
  let signal: AbortSignal | null = null;
  const { pane, out, applied, type } = build({
    claim: (_name, signIn) => {
      signal = signIn.signal;
      signIn.onDeviceCode({ userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 900_000 });
      return new Promise((_resolve, reject) => {
        signIn.signal.addEventListener("abort", () => reject(new Error("the GitHub sign-in was cancelled")));
      });
    },
  });
  pane.open();
  pane.key("2");
  pane.key("\r");
  await settle();
  type("ada");
  pane.key("\r");
  await settle();
  assert.match(out.text(), /Confirm your GitHub account to claim ada\.frizz\.sh/);
  assert.match(out.text(), /Open\s+https:\/\/github\.com\/login\/device/);
  assert.match(out.text(), /Enter\s+WDJB-MJHT/);
  assert.match(out.text(), /esc cancel/);
  assert.equal(pane.key("x"), "keep", "any other key is ignored while waiting");
  assert.equal(signal!.aborted, false);
  assert.equal(pane.key("\x1b"), "keep");
  assert.equal(signal!.aborted, true, "escape aborts the sign-in");
  await settle();
  assert.match(out.text(), /Could not apply that: the GitHub sign-in was cancelled/);
  assert.deepEqual(applied, [], "nothing was applied");
});
