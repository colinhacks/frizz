import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudConfig } from "./cloud.ts";
import { createRemotePane, remoteReachedLine } from "./remote-pane.ts";

// The menu lists "Custom subdomain" only while custom names are offered. They are withdrawn for now, but the
// claim behind the row is kept, and several cases below drive it — so this file runs with the override
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

test("R opens on a checked Off, first, says plainly that Frizz runs on localhost, and Off keeps it there", async () => {
  const { pane, out, applied } = build({ devices: { list: () => [], signOut: () => false, signOutAll: () => 0 } });
  assert.equal(pane.open(), true);
  const screen = lastScreen(out.text());
  const rows = screen.split("\n").filter((row) => /^ {2}[❯ ] [✓ ] \S/.test(row)).map((row) => row.slice(6, 26).trim());
  assert.deepEqual(rows, ["Off", "frizz.sh subdomain", "Custom subdomain", "Cloudflare Tunnel", "Tailscale", "Something else"]);
  assert.match(screen, /^ {2}❯ ✓ Off {17}localhost only$/m, "a board never set up opens with the cursor on a checked Off");
  assert.match(prose(screen), /Frizz runs on localhost, so only this computer can open the board\./);
  assert.doesNotMatch(screen, /127\.0\.0\.1|loopback|binds|\(current\)/);
  // With nobody signed in there is no device to list, so there is no Devices section and no row saying so.
  assert.doesNotMatch(screen, /Devices|Sign out|signed in/);
  pane.key("1");
  assert.equal(pane.key("\r"), "keep");
  await settle();
  assert.deepEqual(applied, [null]);
  assert.match(out.text(), /Back to localhost only: this computer alone can open the board\./);
  // The done screen closes on any key.
  assert.equal(pane.key("x"), "close");
});

test("Cloudflare Tunnel asks for the hostname and the tunnel, then serves them", async () => {
  const { pane, out, applied, type } = build();
  pane.open();
  pane.key("4");
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
  pane.key("5");
  pane.key("\r");
  await settle();
  assert.match(out.text(), /tailscale serve --bg 9393/);
  assert.match(out.text(), /https:\/\/mac-mini\.corgi-alpha\.ts\.net/);
  pane.key("\r"); // accept the placeholder
  await settle();
  assert.deepEqual(applied, [{ hostname: "mac-mini.corgi-alpha.ts.net", serve: "external", provider: "tailscale" }]);
});

test("signed out of GitHub, the custom row says where to sign in, asks nothing and claims nothing", async () => {
  const claims: string[] = [];
  const { pane, out, applied } = build({ claim: async (name) => { claims.push(name); return { hostname: `${name}.frizz.sh`, claim: name, serve: "relay" }; } });
  pane.open();
  assert.match(prose(lastScreen(out.text())), /Custom subdomain your GitHub username\.frizz\.sh; needs Frizz's GitHub sign-in/);
  pane.key("3"); // the cursor starts on the current setup (Off), so pick the custom name explicitly
  pane.key("\r");
  await settle();
  const screen = lastScreen(out.text());
  assert.match(prose(screen), /^A custom subdomain is your GitHub username, so it needs Frizz's GitHub sign-in: open Settings in the board/, "the screen says where to sign in, with no \"could not\" lead");
  assert.doesNotMatch(screen, QUESTION, "before any question about devices");
  assert.doesNotMatch(out.text(), /GitHub CLI|gh auth|login\/device/, "and never asks for the gh CLI or a device code");
  assert.deepEqual(claims, []);
  assert.deepEqual(applied, []);
  assert.equal(pane.key("x"), "keep");
  assert.match(lastScreen(out.text()), /❯ {3}Custom subdomain/, "any key goes back to the menu");
});

test("escape leaves a form for the menu, and leaves the menu for the readout", () => {
  const { pane } = build();
  pane.open();
  pane.key("6");
  pane.key("\r");
  assert.equal(pane.key("\x1b"), "keep");
  assert.equal(pane.key("\x1b"), "close");
});

test("under --sandbox the username screen says a claim is real, and the others say nothing", async () => {
  const { pane, out } = build({ sandbox: true, githubLogin: () => "ada" });
  pane.open();
  pane.key("3");
  pane.key("\r");
  pane.key("\r"); // what a device may do, asked before the name
  await settle();
  assert.match(lastScreen(out.text()), /Claim ada\.frizz\.sh\?/);
  assert.match(out.text(), /This is a sandbox, but a claim is real/);
  pane.key("\x1b");
  out.reset();
  pane.key("6");
  pane.key("\r");
  assert.doesNotMatch(out.text(), /claim is real/);
});

test("a private name claims after one question and a confirmation — no form, no GitHub, QR straight away", async () => {
  // The auth-free default. The pane asks what a device may do, enter takes the preselected answer, and a
  // confirmation says the board goes on the internet and stays there. Its enter IS the claim: it mints
  // through claim("") and lands on the done screen with the sign-in QR.
  const claims: string[] = [];
  const { pane, out, applied } = build({
    claim: async (name) => {
      claims.push(name);
      return { hostname: "abcdefghjkmnpqrstuvw.frizz.sh", claim: "abcdefghjkmnpqrstuvw", serve: "relay" };
    },
  });
  pane.open();
  pane.key("2");
  pane.key("\r");
  assert.deepEqual(claims, [], "nothing is claimed until the question has its answer");
  pane.key("\r");
  await settle();
  assert.deepEqual(claims, [], "nor until the confirmation has its enter");
  assert.match(lastScreen(out.text()), /Put this board on the internet\?/);
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
  pane.key("2");
  pane.key("\r");
  pane.key("\r");
  pane.key("\r"); // confirm putting the board on the internet
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
  assert.match(out.text(), /❯ ✓ frizz\.sh subdomain/, "the cursor starts on the current setup");
  assert.match(lastScreen(out.text()), /^ {6}Off {17}localhost only$/m, "and Off is not checked");
});

test("signed in to GitHub, the custom row offers the account's own username, and says so before enter claims it", async () => {
  const claims: string[] = [];
  const { pane, out, applied } = build({
    githubLogin: () => "Ada-Lovelace",
    claim: async (name) => { claims.push(name); return { hostname: `${name}.frizz.sh`, claim: name, serve: "relay" }; },
  });
  pane.open();
  assert.match(lastScreen(out.text()), /Custom subdomain\s+ada-lovelace\.frizz\.sh, your GitHub username/, "the menu row names it");
  pane.key("3");
  pane.key("\r");
  assert.match(lastScreen(out.text()), QUESTION, "what a device may do comes first");
  pane.key("\r");
  await settle();
  const screen = lastScreen(out.text());
  assert.match(screen, /Claim ada-lovelace\.frizz\.sh\?/);
  assert.match(screen, /tied to Ada-Lovelace, the account Frizz is\s+signed in to/);
  assert.match(screen, /enter claim · esc back/);
  assert.doesNotMatch(screen, /Name\s/, "there is no name to type");
  assert.deepEqual(claims, [], "nothing is claimed until enter");
  pane.key("\r");
  await settle();
  assert.deepEqual(claims, ["ada-lovelace"]);
  assert.deepEqual(applied, [{ hostname: "ada-lovelace.frizz.sh", claim: "ada-lovelace", serve: "relay", relayAccess: "full" }]);
  assert.match(out.text(), /Serving https:\/\/ada-lovelace\.frizz\.sh \(frizz\.sh\)/);
});

test("escape on the username screen claims nothing, and a failed claim goes back to the menu", async () => {
  const claims: string[] = [];
  const { pane, out, applied } = build({
    githubLogin: () => "ada",
    claim: async (name) => { claims.push(name); throw new Error("that name is taken"); },
  });
  pane.open();
  pane.key("3");
  pane.key("\r");
  pane.key("\r");
  await settle();
  assert.equal(pane.key("\x1b"), "keep");
  assert.match(lastScreen(out.text()), /❯ {3}Custom subdomain/);
  assert.deepEqual(claims, []);
  pane.key("\r");
  pane.key("\r");
  await settle();
  pane.key("\r");
  await settle();
  assert.match(lastScreen(out.text()), /Could not claim ada\.frizz\.sh: that name is taken/);
  assert.deepEqual(claims, ["ada"]);
  assert.deepEqual(applied, []);
  assert.equal(pane.key("x"), "keep");
  assert.match(lastScreen(out.text()), /❯ {3}Custom subdomain/);
});

test("a board already serving its username serves it again, with no claim and no question", async () => {
  const config: CloudConfig = { hostname: "ada.frizz.sh", claim: "ada", serve: "relay" };
  const { pane, out, applied } = build({
    current: () => config,
    githubLogin: () => "Ada",
    claim: async () => { throw new Error("serving it again claims nothing"); },
  });
  pane.open();
  assert.match(lastScreen(out.text()), /❯ ✓ Custom subdomain/);
  pane.key("\r");
  await settle();
  assert.deepEqual(applied, [config]);
  assert.doesNotMatch(out.text(), QUESTION);
  assert.match(out.text(), /Serving https:\/\/ada\.frizz\.sh/);
});

test("a login that makes no usable name is not offered, and choosing the row says why", async () => {
  // Too short for a name, and a login in the random-name shape would claim with no account at all.
  for (const login of ["ab", "abcdefghjkmnpqrstuvw"]) {
    const claims: string[] = [];
    const { pane, out } = build({
      githubLogin: () => login,
      claim: async (name) => { claims.push(name); return { hostname: `${name}.frizz.sh`, claim: name, serve: "relay" }; },
    });
    pane.open();
    assert.match(prose(lastScreen(out.text())), new RegExp(`Custom subdomain your GitHub username, ${login}, is not a usable name`), login);
    pane.key("3");
    pane.key("\r");
    await settle();
    assert.match(prose(lastScreen(out.text())), new RegExp(`^Your GitHub username, ${login}, does not make a frizz\\.sh name`), login);
    assert.deepEqual(claims, [], login);
  }
});

const QUESTION = /What can a device signed in through frizz\.sh do\?/;
/** A screen's words with every run of whitespace, line breaks and indents included, as one space. */
const prose = (screen: string) => screen.replace(/\s+/g, " ").trim();
/** The last paint, without escape codes. */
const lastScreen = (text: string) => text.split("\x1b[2J\x1b[H").pop()!.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

test("picking a frizz.sh subdomain asks what a device may do, full control preselected and nothing else said", () => {
  const { pane, out } = build();
  pane.open();
  pane.key("2");
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
  for (const row of ["2", "3"]) {
    const { pane, applied } = build({ githubLogin: () => "ada" });
    pane.open();
    pane.key(row);
    pane.key("\r");
    pane.key("\x1b[B");
    pane.key("\r");
    await settle();
    pane.key("\r"); // confirm the claim: the random name's and the username's confirmations alike
    await settle();
    assert.equal(applied[0]!.relayAccess, "read-and-answer", row);
    assert.equal(applied[0]!.serve, "relay");
  }
});

test("escape on the question goes back to the menu, and nothing is claimed", async () => {
  const claims: string[] = [];
  const { pane, out, applied } = build({ claim: async (name) => { claims.push(name); return { hostname: "x.frizz.sh", claim: "x", serve: "relay" }; } });
  pane.open();
  pane.key("2");
  pane.key("\r");
  assert.equal(pane.key("\x1b"), "keep");
  await settle();
  assert.match(lastScreen(out.text()), /❯ {3}frizz\.sh subdomain/);
  assert.deepEqual(claims, []);
  assert.deepEqual(applied, []);
});

test("a random name goes public only after a confirmation that says so, and escape there claims nothing", async () => {
  for (const [moves, said] of [
    [[], "full control: start and steer threads, answer cards"],
    [["\x1b[B"], "read and answer: read the board and pick options on cards"],
  ] as const) {
    const claims: string[] = [];
    const { pane, out, applied } = build({ claim: async (name) => { claims.push(name); return { hostname: "x.frizz.sh", claim: "x", serve: "relay" }; } });
    Object.assign(out.stream, { columns: 80, rows: 24 });
    pane.open();
    pane.key("2");
    pane.key("\r");
    for (const move of moves) pane.key(move);
    pane.key("\r");
    await settle();
    const screen = lastScreen(out.text());
    assert.deepEqual(claims, [], "the access answer alone claims nothing");
    assert.match(prose(screen), /^Put this board on the internet\? .*every project on this machine.*every launch until Off is chosen here\./);
    assert.ok(prose(screen).includes(said), said);
    assert.match(screen, /enter claim · esc back/);
    for (const line of screen.split("\n")) assert.ok(line.length < 80, `${JSON.stringify(line)} fits 80 columns`);
    assert.equal(pane.key("\x1b"), "keep");
    await settle();
    assert.match(lastScreen(out.text()), /❯ {3}frizz\.sh subdomain/, "escape goes back to the menu");
    assert.deepEqual(claims, []);
    assert.deepEqual(applied, []);
  }
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
    assert.doesNotMatch(out.text(), /What they can do/);
    for (const row of ["4", "5", "6"]) {
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
  assert.match(lastScreen(out.text()), /What they can do\s+Full control: start and steer threads, answer cards/);
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
  assert.match(prose(lastScreen(out.text())), /What they can do Read and answer: read the board and pick options on cards/);
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
  assert.match(lastScreen(out.text()), /❯ {3}What they can do/);
  pane.key("\r");
  pane.key("1");
  pane.key("\r");
  assert.match(lastScreen(out.text()), /the disk is full/);
  assert.equal(pane.key("x"), "keep", "any key returns to the menu");
  assert.match(lastScreen(out.text()), /❯ {3}What they can do/);
});

test("serving the name a board already has again keeps its answer", async () => {
  const saved: CloudConfig = { hostname: "abcdefghjkmnpqrstuvw.frizz.sh", claim: "abcdefghjkmnpqrstuvw", serve: "relay", relayAccess: "read-and-answer" };
  const { pane, out, applied } = build({
    current: () => saved,
    claim: async () => ({ hostname: saved.hostname, claim: saved.claim!, serve: "relay" }),
  });
  pane.open();
  pane.key("2");
  pane.key("\r");
  await settle();
  assert.doesNotMatch(out.text(), QUESTION);
  assert.equal(applied[0]!.relayAccess, "read-and-answer");
});

test("moving a read-and-answer board to a new frizz.sh setup asks again, with its answer preselected", async () => {
  const saved: CloudConfig = { hostname: "abcdefghjkmnpqrstuvw.frizz.sh", claim: "abcdefghjkmnpqrstuvw", serve: "relay", relayAccess: "read-and-answer" };
  const { pane, out } = build({ current: () => saved, githubLogin: () => "ada" });
  pane.open();
  pane.key("3");
  pane.key("\r");
  assert.match(lastScreen(out.text()), /❯ Read and answer/);
});

/** A signed-in device, `hours` after it signed in. */
const device = (id: string, label: string, hours: number) => ({ id, label, createdAt: Date.now() - hours * 3_600_000 });

/** A board whose signed-in devices are `held`; the sign-outs it was asked for land in `signedOut`. */
function withDevices(held: Array<ReturnType<typeof device>>, overrides: Partial<Parameters<typeof createRemotePane>[0]> = {}) {
  const signedOut: string[] = [];
  const built = build({
    devices: {
      list: () => held,
      signOut: (id) => {
        const at = held.findIndex((d) => d.id === id);
        if (at < 0) return false;
        held.splice(at, 1);
        signedOut.push(id);
        return true;
      },
      signOutAll: () => {
        const count = held.length;
        signedOut.push(...held.map((d) => d.id));
        held.length = 0;
        return count;
      },
    },
    ...overrides,
  });
  return { ...built, signedOut };
}

test("each signed-in device is a row of its own under Devices, named by its browser and when it signed in", () => {
  const { pane, out } = withDevices([device("s1", "Safari on iPhone", 3), device("s2", "Chrome on macOS", 50)]);
  pane.open();
  const screen = lastScreen(out.text());
  assert.match(
    screen,
    /Something else.*\n {2}\n {2}Devices\n {6}Safari on iPhone {4}signed in 3h ago\n {6}Chrome on macOS {5}signed in 2d ago\n {6}Sign out all\n/,
    "under their own heading, below the setups",
  );
  assert.doesNotMatch(screen, /remote devices? signed in/, "no count standing in for the list");
});

test("a device's row asks before it signs that one device out, and escape keeps it", () => {
  const { pane, out, signedOut } = withDevices([device("s1", "Safari on iPhone", 3), device("s2", "Chrome on macOS", 50)]);
  pane.open();
  // Six setups, no relay so no access row, then the devices newest first.
  pane.key("7");
  pane.key("\r");
  const asked = lastScreen(out.text());
  assert.match(prose(asked), /^Sign out Safari on iPhone\? It signed in 3h ago\. To get back in, it needs a new sign-in link from L\./);
  assert.match(asked, /enter sign out · esc back/);
  assert.deepEqual(signedOut, [], "nothing is signed out by choosing the row");
  pane.key("\x1b");
  assert.match(lastScreen(out.text()), /❯ {3}Safari on iPhone/, "escape goes back to the menu, on the same row");
  assert.deepEqual(signedOut, []);

  pane.key("\r");
  assert.equal(pane.key("\r"), "keep");
  assert.deepEqual(signedOut, ["s1"], "only that device");
  assert.match(lastScreen(out.text()), /Signed out Safari on iPhone\. It needs a new code from L to sign in again\./);
  assert.equal(pane.key("x"), "close");

  pane.open();
  const after = lastScreen(out.text());
  assert.match(after, /Devices\n {6}Chrome on macOS {5}signed in 2d ago\n {2}\n/, "one device left, and no Sign out all beside it");
  assert.doesNotMatch(after, /Safari on iPhone|Sign out all/);
});

test("Sign out all signs every listed device out and says how many it was", () => {
  const { pane, out, signedOut } = withDevices([device("s1", "Safari on iPhone", 3), device("s2", "Chrome on macOS", 50)]);
  pane.open();
  pane.key("9");
  out.reset();
  assert.equal(pane.key("\r"), "keep");
  assert.deepEqual(signedOut, ["s1", "s2"]);
  assert.match(out.text(), /Signed out 2 devices\. Each needs a new code from L to sign in again\./);
  assert.equal(pane.key("x"), "close");
  pane.open();
  assert.doesNotMatch(out.text(), /Devices|Sign out all/, "with nobody left, the section is gone");
});

test("a sign-out that fails says so and goes back to the menu", () => {
  const broken = withDevices([device("s1", "Safari on iPhone", 3), device("s2", "Chrome on macOS", 50)], {
    devices: {
      list: () => [device("s1", "Safari on iPhone", 3), device("s2", "Chrome on macOS", 50)],
      signOut: () => { throw new Error("the session list could not be saved"); },
      signOutAll: () => { throw new Error("the session key could not be saved"); },
    },
  });
  broken.pane.open();
  broken.pane.key("9");
  broken.pane.key("\r");
  assert.match(broken.out.text(), /Could not apply that: the session key could not be saved/);
  assert.equal(broken.pane.key("x"), "keep");
  assert.match(lastScreen(broken.out.text()), /❯ {3}Sign out all/);
  broken.pane.key("7");
  broken.pane.key("\r");
  broken.pane.key("\r");
  assert.match(lastScreen(broken.out.text()), /Could not apply that: the session list could not be saved/);
  assert.equal(broken.pane.key("x"), "keep");
  assert.match(lastScreen(broken.out.text()), /❯ {3}Safari on iPhone/);
});

test("a pane built without devices lists no Devices section", () => {
  const { pane, out } = build();
  pane.open();
  assert.doesNotMatch(out.text(), /Devices|Sign out/);
});


test("in an 80x24 window a random name's done screen keeps the message, the whole code, the URL and the way back", async () => {
  // A real random-name link: a 20-character host and a 22-character code, 72 characters. At error
  // correction M that is a 23-row code, and the screen scrolled its message and half the code's top quiet
  // zone off an 80x24 window. The fake in the test above is too short to need it.
  const host = "abcdefghjkmnpqrstuvw";
  const code = "q7Hn2xVdL0pRk4WmTz9bYa";
  const { pane, out } = build({
    claim: async () => ({ hostname: `${host}.frizz.sh`, claim: host, serve: "relay" }),
    issueLink: () => ({ code, url: `https://${host}.frizz.sh/?frizz_code=${code}`, expiresAt: Date.now() + 300_000 }),
  });
  Object.assign(out.stream, { columns: 80, rows: 24 });
  pane.open();
  pane.key("2");
  pane.key("\r");
  pane.key("\r");
  pane.key("\r"); // confirm putting the board on the internet
  await settle();
  const rows = lastScreen(out.text()).split("\n");
  assert.ok(rows.length <= 24, `the done screen is ${rows.length} rows in a 24-row window`);
  assert.match(rows[0]!, /^ {2}Serving https:\/\/abcdefghjkmnpqrstuvw\.frizz\.sh \(frizz\.sh\)\.$/);
  // The code's top two rows are its quiet zone, all four modules of it: light cells, no glyph.
  assert.ok(/^ {2} {41}$/.test(rows[1]!) && /^ {2} {41}$/.test(rows[2]!), "the code's quiet zone is whole under the message");
  assert.ok(rows.at(-2)!.includes(`frizz_code=${code}`), "the URL fits");
  assert.match(rows.at(-1)!, /press any key to return/, "and the way back");
});

test("a claim's progress lines go to the busy screen, not to the terminal under it", async () => {
  let release!: () => void;
  const { pane, out } = build({
    githubLogin: () => "ada",
    claim: async (name, progress) => {
      progress(`  claiming ${name}.frizz.sh for GitHub user Ada`);
      await new Promise<void>((resolve) => { release = resolve; });
      return { hostname: `${name}.frizz.sh`, claim: name, serve: "relay" };
    },
  });
  pane.open();
  pane.key("3");
  pane.key("\r");
  pane.key("\r");
  await settle();
  pane.key("\r");
  await settle();
  const busy = lastScreen(out.text()).split("\n").map((row) => row.trim()).filter(Boolean);
  assert.deepEqual(busy, ["claiming ada.frizz.sh for GitHub user Ada…", "working…"]);
  release();
  await settle();
  assert.match(lastScreen(out.text()), /Serving https:\/\/ada\.frizz\.sh/);
});

test("a refused claim names what it could not claim, and wraps between words under its indent", async () => {
  const refusal = "a name is claimed with Frizz's own GitHub sign-in, and this was another kind of GitHub token — sign in to GitHub in the board's Settings, then try again";
  for (const row of ["2", "3"]) {
    const { pane, out } = build({ githubLogin: () => "ada", claim: async () => { throw new Error(refusal); } });
    pane.open();
    pane.key(row);
    pane.key("\r");
    pane.key("\r");
    await settle();
    pane.key("\r"); // either way, a confirmation comes before the claim
    await settle();
    const screen = lastScreen(out.text());
    const lead = row === "2" ? "Could not claim a frizz.sh subdomain:" : "Could not claim ada.frizz.sh:";
    assert.equal(prose(screen), `${lead} ${refusal} press any key to go back`, row);
    const lines = screen.split("\n").filter((line) => line.trim());
    assert.ok(lines.length >= 3, "the message wraps");
    for (const line of lines) {
      assert.match(line, /^ {2}\S/, `every line sits under the indent: ${JSON.stringify(line)}`);
      assert.ok(line.length <= 78, `no line reaches the window's edge: ${JSON.stringify(line)}`);
    }
  }
});

test("at 80 columns no menu row reaches the window's edge, and a long blurb wraps under its column", () => {
  for (const login of [null, "ada", "abcdefghjkmnpqrstuvw"]) {
    const { pane, out } = build({ githubLogin: () => login, current: () => ({ hostname: "ada.frizz.sh", claim: "ada", serve: "relay" }), devices: { list: () => [device("s1", "Firefox on Android", 1), device("s2", "Chrome on Windows", 30)], signOut: () => true, signOutAll: () => 2 } });
    Object.assign(out.stream, { columns: 80, rows: 24 });
    pane.open();
    const screen = lastScreen(out.text());
    for (const line of screen.split("\n")) {
      assert.ok([...line].length < 80, `${JSON.stringify(line)} is ${[...line].length} columns`);
      assert.match(line, /^(| {2}.*)$/, `no line starts at column 0: ${JSON.stringify(line)}`);
    }
    assert.match(screen, /Cloudflare Tunnel {3}a domain on Cloudflare; cloudflared on this machine/);
  }
});

test("once the pane closes on a change, it says the new setup, once; closing on no change says nothing", async () => {
  const told: Array<CloudConfig | null> = [];
  const { pane } = build({ onClosedAfterChange: (config) => told.push(config) });
  pane.open();
  assert.equal(pane.key("\x1b"), "close");
  pane.close();
  assert.deepEqual(told, [], "nothing changed");

  pane.open();
  pane.key("2");
  pane.key("\r");
  pane.key("\r");
  pane.key("\r"); // confirm putting the board on the internet
  await settle();
  assert.deepEqual(told, [], "not while the pane holds the terminal");
  assert.equal(pane.key("x"), "close");
  pane.close();
  assert.equal(told.length, 1);
  assert.equal((told[0] as CloudConfig | null)?.hostname, ".frizz.sh", "the fake claim in build() mints an empty name");
  pane.open();
  pane.close();
  assert.equal(told.length, 1, "said once");
});

test("the readout's line after a change names the address, or localhost", () => {
  assert.equal(remoteReachedLine({ hostname: "ada.frizz.sh", claim: "ada", serve: "relay" }), "now at https://ada.frizz.sh");
  assert.equal(remoteReachedLine(null), "localhost only now");
  // The notice is not truncated, so a random name's line must fit 80 columns after the readout's 27.
  const random = remoteReachedLine({ hostname: "abcdefghjkmnpqrstuvw.frizz.sh", claim: "abcdefghjkmnpqrstuvw", serve: "relay" });
  assert.ok(27 + random.length < 80, `${27 + random.length} columns`);
});
