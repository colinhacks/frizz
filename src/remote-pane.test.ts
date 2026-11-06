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
    setRelayAccess: (relayAccess) => { current = { ...current!, relayAccess }; },
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
  pane.key("\r"); // what a device may do, asked before the form
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
  assert.deepEqual(applied, [{ hostname: "ada.frizz.sh", claim: "ada", serve: "relay", relayAccess: "full" }]);
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
  pane.key("\r"); // what a device may do, asked before the form
  await settle();
  assert.match(out.text(), /This is a sandbox, but a claim is real/);
  pane.key("\x1b");
  out.reset();
  pane.key("5");
  pane.key("\r");
  assert.doesNotMatch(out.text(), /claim is real/);
});

test("a private name claims with one question — no form, no GitHub, QR straight away", async () => {
  // The auth-free default. The pane asks what a device may do, and enter takes the preselected answer. That
  // IS the claim: it mints through claim("") and lands on the done screen with the sign-in QR.
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
  assert.deepEqual(claims, [], "nothing is claimed until the question has its answer");
  pane.key("\r");
  await settle();
  assert.deepEqual(claims, [""], "an empty name asks the claimer to mint one");
  assert.deepEqual(applied, [{ hostname: "abcdefghjkmnpqrstuvw.frizz.sh", claim: "abcdefghjkmnpqrstuvw", serve: "relay", relayAccess: "full" }]);
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

const QUESTION = /What can a device signed in through frizz\.sh do\?/;
/** The last paint, without escape codes. */
const lastScreen = (text: string) => text.split("\x1b[2J\x1b[H").pop()!.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

test("picking a frizz.sh subdomain asks what a device may do, full control preselected and nothing else said", () => {
  const { pane, out } = build();
  pane.open();
  pane.key("1");
  out.reset();
  pane.key("\r");
  const screen = lastScreen(out.text());
  assert.match(screen, QUESTION);
  assert.match(screen, /❯ Full control\s+start and steer threads, answer cards/);
  assert.match(screen, /^ {4}Read and answer\s+read the board and pick options on cards/m);
  assert.deepEqual(
    screen.split("\n").map((row) => row.trim()).filter(Boolean),
    [
      "What can a device signed in through frizz.sh do?",
      "❯ Full control      start and steer threads, answer cards",
      "Read and answer   read the board and pick options on cards",
      "↑↓ move · enter choose · esc back",
    ],
    "the question, its two answers and how to move: no warning beside them",
  );
});

test("answering read and answer is what gets saved, by either way of claiming", async () => {
  for (const [row, name] of [["1", ""], ["2", "ada"]] as const) {
    const { pane, applied, type } = build();
    pane.open();
    pane.key(row);
    pane.key("\r");
    pane.key("\x1b[B");
    pane.key("\r");
    await settle();
    if (name) {
      type(name);
      pane.key("\r");
      await settle();
    }
    assert.equal(applied[0]!.relayAccess, "read-and-answer");
    assert.equal(applied[0]!.serve, "relay");
  }
});

test("escape on the question goes back to the menu, and nothing is claimed", async () => {
  const claims: string[] = [];
  const { pane, out, applied } = build({ claim: async (name) => { claims.push(name); return { hostname: "x.frizz.sh", claim: "x", serve: "relay" }; } });
  pane.open();
  pane.key("1");
  pane.key("\r");
  assert.equal(pane.key("\x1b"), "keep");
  await settle();
  assert.match(lastScreen(out.text()), /❯ frizz\.sh subdomain/);
  assert.deepEqual(claims, []);
  assert.deepEqual(applied, []);
});

test("Cloudflare Tunnel, Tailscale, something else and Off ask nothing, and offer no row to change it", async () => {
  for (const config of [
    null,
    { hostname: "board.example.com", tunnel: "my-board" },
    { hostname: "mac.corgi-alpha.ts.net", serve: "external", provider: "tailscale" },
    { hostname: "board.example.com", serve: "external", provider: "other" },
  ] as CloudConfig[] | null[]) {
    const { pane, out } = build({ current: () => config });
    pane.open();
    assert.doesNotMatch(out.text(), /Device access/);
    for (const row of ["3", "4", "5"]) {
      pane.key(row);
      pane.key("\r");
      await settle();
      assert.doesNotMatch(out.text(), QUESTION);
      pane.key("\x1b");
    }
  }
});

test("the last row of a board on the relay says what a device may do, and changes it without touching the setup", async () => {
  const changes: string[] = [];
  let config: CloudConfig = { hostname: "ada.frizz.sh", claim: "ada", serve: "relay" };
  const { pane, out, applied } = build({
    current: () => config,
    setRelayAccess: (relayAccess) => { changes.push(relayAccess); config = { ...config, relayAccess }; },
    claim: async () => { throw new Error("changing this claims nothing"); },
  });
  pane.open();
  assert.match(lastScreen(out.text()), /Device access\s+Full control: start and steer threads, answer cards/);
  pane.key("7");
  pane.key("\r");
  assert.match(lastScreen(out.text()), QUESTION);
  assert.match(lastScreen(out.text()), /❯ Full control/, "an unset board is at full control");
  pane.key("j");
  pane.key("\r");
  await settle();
  assert.deepEqual(changes, ["read-and-answer"]);
  assert.deepEqual(applied, [], "the name and its transport stay as they are");
  assert.match(lastScreen(out.text()), /can now read the board and pick options on cards/);

  assert.equal(pane.key("x"), "close");
  pane.open();
  assert.match(lastScreen(out.text()), /Device access\s+Read and answer: read the board and pick options on cards/);
  pane.key("7");
  pane.key("\r");
  assert.match(lastScreen(out.text()), /❯ Read and answer/, "the question opens on what is in force");
  pane.key("k");
  pane.key("\r");
  assert.deepEqual(changes, ["read-and-answer", "full"]);
  assert.match(lastScreen(out.text()), /now has full control/);
});

test("escape on that question changes nothing, and a change that cannot be saved says so", async () => {
  const config: CloudConfig = { hostname: "ada.frizz.sh", claim: "ada", serve: "relay", relayAccess: "read-and-answer" };
  const { pane, out } = build({ current: () => config, setRelayAccess: () => { throw new Error("the disk is full"); } });
  pane.open();
  pane.key("7");
  pane.key("\r");
  pane.key("\x1b");
  assert.match(lastScreen(out.text()), /❯ Device access/);
  pane.key("\r");
  pane.key("1");
  pane.key("\r");
  assert.match(lastScreen(out.text()), /the disk is full/);
  assert.equal(pane.key("x"), "keep", "any key returns to the menu");
  assert.match(lastScreen(out.text()), /❯ Device access/);
});

test("serving the name a board already has again keeps its answer", async () => {
  const saved: CloudConfig = { hostname: "abcdefghjkmnpqrstuvw.frizz.sh", claim: "abcdefghjkmnpqrstuvw", serve: "relay", relayAccess: "read-and-answer" };
  const { pane, out, applied } = build({
    current: () => saved,
    claim: async () => ({ hostname: saved.hostname, claim: saved.claim!, serve: "relay" }),
  });
  pane.open();
  pane.key("1");
  pane.key("\r");
  await settle();
  assert.doesNotMatch(out.text(), QUESTION);
  assert.equal(applied[0]!.relayAccess, "read-and-answer");
});

test("moving a read-and-answer board to a new frizz.sh setup asks again, with its answer preselected", async () => {
  const saved: CloudConfig = { hostname: "abcdefghjkmnpqrstuvw.frizz.sh", claim: "abcdefghjkmnpqrstuvw", serve: "relay", relayAccess: "read-and-answer" };
  const { pane, out } = build({ current: () => saved });
  pane.open();
  pane.key("2");
  pane.key("\r");
  assert.match(lastScreen(out.text()), /❯ Read and answer/);
});
