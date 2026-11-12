import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CloudConfig,
  CUSTOM_NAMES_OFFERED,
  CUSTOM_NAMES_PAUSED,
  customNamesOffered,
  establishCloudConfig,
  reconcileCloudConfig,
  resolveRunToken,
} from "./cloud.ts";
import { createRemotePane } from "./remote-pane.ts";

/**
 * Custom frizz.sh names as they SHIP while withdrawn (2026-10-08): CUSTOM_NAMES_OFFERED is false and
 * nothing here sets `FRIZZ_CUSTOM_NAMES`. cloud.test.ts and remote-pane.test.ts turn the override on
 * for their whole file to keep driving the path behind the gate; this file is the other half, and
 * runs as its own process, so their setting never reaches it.
 */
for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "FRIZZ_CUSTOM_NAMES"]) delete process.env[name];

/** A registrar that answers every claim and records it, so "never called" is an observation. */
async function claimServer(reply: unknown = { hostname: "x.frizz.sh", leaseExpiresAt: 0, renewed: false }) {
  const claims: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      const claim = JSON.parse(body) as Record<string, unknown>;
      claims.push(claim);
      res.writeHead(200, { "content-type": "application/json" });
      // Answered for the name asked, as a real registrar does; the launcher refuses any other hostname.
      res.end(JSON.stringify(reply && typeof reply === "object" ? { ...reply, hostname: `${String(claim.name)}.frizz.sh` } : reply));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    claims,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), "frizz-paused-"));
}

/** A GitHub sign-in that fails the test if anything starts it. */
const untouchableGithub = {
  authorize: async (): Promise<never> => { throw new Error("GitHub must not be consulted"); },
};

// 2026-10-08: custom names are withdrawn until Frizz's GitHub OAuth app exists. Before the gate, a
// custom claim reached the device flow and only then refused with "not-configured".
test("custom names are off by default, and only FRIZZ_CUSTOM_NAMES=1 turns them on", () => {
  assert.equal(CUSTOM_NAMES_OFFERED, false, "withdrawn until the GitHub OAuth app is registered");
  assert.equal(customNamesOffered({}), false);
  assert.equal(customNamesOffered({ FRIZZ_CUSTOM_NAMES: "true" }), false, "only the exact value 1 counts");
  assert.equal(customNamesOffered({ FRIZZ_CUSTOM_NAMES: "1" }), true);
});

test("while custom names are paused, a word is refused before GitHub or the registrar hears of it", async () => {
  const home = tempHome();
  const server = await claimServer();
  try {
    for (const word of ["colin", "www", "has space"]) {
      await assert.rejects(establishCloudConfig(word, 9393, home, server.origin, untouchableGithub), (error: Error) => {
        assert.equal(error.message, CUSTOM_NAMES_PAUSED, `${word}: ${error.message}`);
        return true;
      });
    }
    assert.match(CUSTOM_NAMES_PAUSED, /custom frizz\.sh subdomains are paused[\s\S]*random subdomain[\s\S]*hostname of a tunnel/);
    assert.equal(server.claims.length, 0, "the registrar was never called");
    // The same registrar and the same untouchable GitHub serve the paths the gate leaves alone, which
    // proves the refusals above were the gate's and not a broken harness.
    const anonymous = await establishCloudConfig("", 9393, home, server.origin, untouchableGithub);
    assert.match(anonymous.claim!, /^[a-z2-7]{20}$/);
    assert.equal(server.claims.length, 1);
    assert.deepEqual(await establishCloudConfig("board.example.com", 9393, home, server.origin, untouchableGithub), {
      hostname: "board.example.com",
      tunnel: "board",
    });
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("while custom names are paused, a custom name already claimed still renews by keypair alone", async () => {
  // The renewal every launch makes carries no GitHub token, so withdrawing the offer must not strand
  // a board that already holds a custom name.
  const home = tempHome();
  const server = await claimServer({ hostname: "colin.frizz.sh", leaseExpiresAt: 0, renewed: true });
  try {
    const saved = { hostname: "colin.frizz.sh", claim: "colin", serve: "relay" as const };
    assert.equal(await reconcileCloudConfig(saved, 9393, home, undefined, server.origin, untouchableGithub), saved);
    assert.equal(await resolveRunToken(saved, 9393, home, undefined, server.origin), null, "a relay name has no run token");
    assert.equal(server.claims.length, 1, "exactly one call: the renewal");
    assert.equal(server.claims[0]!.name, "colin");
    assert.equal("github" in server.claims[0]!, false, "the renewal carries no GitHub token");
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("while custom names are paused, a saved custom name that needs re-claiming says so at launch", async () => {
  // Moving a pre-relay config onto the relay means claiming its label, and for a custom label that
  // is the paused path. It refuses with a message naming the way out instead of opening a sign-in.
  const home = tempHome();
  const server = await claimServer();
  const notices: string[] = [];
  try {
    for (const stale of [
      { hostname: "colin.frizz.sh", tunnel: "colin" },
      { hostname: "colin.frizz.sh", claim: "colin", serve: "tunnel" as const },
    ]) {
      await assert.rejects(
        reconcileCloudConfig(stale, 9393, home, (m) => notices.push(m), server.origin, untouchableGithub),
        /colin\.frizz\.sh needs moving onto the Frizz relay[\s\S]*custom frizz\.sh subdomains are paused[\s\S]*press R/,
      );
    }
    assert.deepEqual(notices, [], "no notice promises a claim that is not going to happen");
    assert.equal(server.claims.length, 0);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

function fakeOutput() {
  const chunks: string[] = [];
  return {
    stream: { write: (chunk: string) => { chunks.push(chunk); return true; } } as unknown as NodeJS.WriteStream,
    text: () => chunks.join(""),
  };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildPane(initial: CloudConfig | null) {
  const out = fakeOutput();
  let current = initial;
  const applied: Array<CloudConfig | null> = [];
  const pane = createRemotePane({
    port: 9393,
    current: () => current,
    apply: async (next) => { applied.push(next); current = next; },
    setRelayAccess: (relayAccess) => { current = { ...current!, relayAccess }; },
    claim: async () => { throw new Error("nothing may be claimed here"); },
    issueLink: () => (current ? { code: "c0de", url: `https://${current.hostname}/?frizz_code=c0de`, expiresAt: Date.now() + 300_000 } : null),
    probes: {
      cloudflared: async () => ({ version: "2025.8.1" }),
      tailscale: async () => ({ installed: true, dnsName: "mac-mini.corgi-alpha.ts.net" }),
    },
    output: out.stream,
  });
  return { pane, out, applied };
}

/** The menu rows of the last paint, without escape codes. */
function menuRows(text: string): string[] {
  const screen = text.split("\x1b[2J\x1b[H").pop()!.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  return screen.split("\n").filter((row) => /^ {2}[❯ ] [✓ ] \S/.test(row));
}

test("while custom names are paused, the R menu does not offer one, and every number still lands", async () => {
  const { pane, out, applied } = buildPane(null);
  pane.open();
  assert.doesNotMatch(out.text(), /Custom subdomain/);
  assert.doesNotMatch(out.text(), /GitHub/, "no row mentions a GitHub account");
  const rows = menuRows(out.text());
  assert.deepEqual(
    rows.map((row) => row.slice(6, 26).trim()),
    ["Off", "frizz.sh subdomain", "Cloudflare Tunnel", "Tailscale", "Something else"],
  );
  assert.match(rows[0]!, /^ {2}❯ ✓ Off/, "Off is first and current, and the cursor is on it");
  // A number past the end is ignored rather than selecting a row that is not there.
  pane.key("5");
  pane.key("6");
  assert.match(menuRows(out.text())[4]!, /^ {2}❯ {3}Something else/);
  pane.key("1");
  pane.key("\r");
  await settle();
  assert.deepEqual(applied, [null], "1 is Off, with or without the custom row");
});

test("while custom names are paused, a board already on a custom name shows it, and choosing it renews without a claim", async () => {
  // The claim fake throws, so reaching it would fail the test: serving the saved name again goes
  // through apply, whose renewal is the keypair-only call every launch makes.
  const saved: CloudConfig = { hostname: "colin.frizz.sh", claim: "colin", serve: "relay" };
  const { pane, out, applied } = buildPane(saved);
  pane.open();
  const rows = menuRows(out.text());
  assert.equal(rows.length, 7, "the custom row stays while it is the current setup, and what a device may do is the last");
  assert.match(rows[6]!, /^ {6}What they can do\s+Full control/);
  assert.match(rows[2]!, /^ {2}❯ ✓ Custom subdomain\s+colin\.frizz\.sh — kept and renewed;/);
  // The blurb wraps at 80 columns, its continuation hanging under the blurb column.
  const screen = out.text().split("\x1b[2J\x1b[H").pop()!.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  assert.match(screen, /kept and renewed; new custom\n {26}subdomains are paused\n/);
  assert.doesNotMatch(out.text(), /needs a GitHub account/);
  pane.key("\r");
  await settle();
  assert.deepEqual(applied, [saved], "the saved claim is applied as it is");
  assert.doesNotMatch(out.text(), /Custom frizz\.sh subdomain|github\.com\/login\/device/, "no claim form, no sign-in");
  assert.match(out.text(), /Serving https:\/\/colin\.frizz\.sh \(frizz\.sh\)/);
  assert.match(out.text(), /frizz_code=c0de/);
});

test("while custom names are paused, leaving a custom name says the menu cannot bring it back, and asks first", async () => {
  const saved: CloudConfig = { hostname: "colin.frizz.sh", claim: "colin", serve: "relay" };
  const { pane, out, applied } = buildPane(saved);
  pane.open();
  pane.key("2");
  pane.key("\r");
  await settle();
  assert.deepEqual(applied, [], "a random name was claimed before anyone was asked");
  assert.match(out.text(), /Leave colin\.frizz\.sh\?/);
  assert.match(out.text(), /cannot bring\s+colin\.frizz\.sh\s+back/);
  pane.key("\x1b");
  assert.equal(menuRows(out.text()).length, 7, "escape goes back to the menu");
  assert.match(menuRows(out.text())[1]!, /^ {2}❯ {3}frizz\.sh subdomain/);

  pane.key("1");
  pane.key("\r");
  assert.match(out.text(), /Leave colin\.frizz\.sh\?/);
  assert.deepEqual(applied, []);
  pane.key("\r");
  await settle();
  assert.deepEqual(applied, [null], "enter goes ahead with the switch");
  assert.match(out.text(), /Back to localhost only/);
});

test("a board on a random name switches without being asked", async () => {
  const { pane, applied } = buildPane({ hostname: "h2cioy5ilpwjdwptl7yz.frizz.sh", claim: "h2cioy5ilpwjdwptl7yz", serve: "relay" });
  pane.open();
  pane.key("1");
  pane.key("\r");
  await settle();
  assert.deepEqual(applied, [null]);
});
