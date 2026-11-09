import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { frizzPaths } from "@frizz/server/frizz-paths";
import { isAnonymousClaimName } from "@frizz/shared";
import { ClaimError } from "./registrar-client.ts";
import {
  cloudConfigPath,
  establishCloudConfig,
  normalizeHostname,
  promptForCloudName,
  readCloudConfig,
  reconcileCloudConfig,
  isRelayConfig,
  readTunnelToken,
  REGISTRAR_IS_LIVE,
  resolveRunToken,
  resolveTunnelConfigPath,
  startTunnel,
  tunnelTokenPath,
  writeCloudConfig,
  zoneClaimLabel,
} from "./cloud.ts";

// Every case below hands cloud.ts a throwaway home, and frizz-paths.ts resolves the paths under it —
// unless a SET XDG variable outranks it, which it does by design. On an XDG-configured machine that
// would point the writes at the operator's real `$XDG_DATA_HOME/frizz`, where the cleanup never looks.
for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete process.env[name];

// Custom names are withdrawn (CUSTOM_NAMES_OFFERED is false), but the path behind the gate is kept to
// be switched back on, and most claims below drive it — so this whole file runs with the override on.
// It is set for the FILE, not per test: `nub --test` runs a file's tests concurrently, so a per-test
// toggle would leak into its neighbours. The shipped default is pinned in custom-names-paused.test.ts.
process.env.FRIZZ_CUSTOM_NAMES = "1";

// Claiming a NAME binds it to a GitHub account, which establishCloudConfig confirms through Frizz's
// own GitHub sign-in. The claim tests hand in this stand-in for it, so no test reads a real one
// (github-credential.test.ts covers githubClaimToken itself).
const fakeGithub = { authorize: async () => ({ token: "ghu_testtoken", login: "colin" }) };

/**
 * A registrar that answers every claim, so the CLI side can be driven without one deployed. Like the real
 * one, it asks for GitHub (`github-required`) on the first claim of a custom name that carries no token,
 * and renews a name its key already holds without one. `status` makes every answer that error instead.
 */
async function claimServer(
  reply: unknown = { hostname: "colin.frizz.sh", token: "run-token", leaseExpiresAt: 0, renewed: false },
  status?: number,
) {
  const claims: Array<Record<string, unknown>> = [];
  const accepted: Array<Record<string, unknown>> = [];
  const held = new Map<string, unknown>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      const claim = JSON.parse(body) as Record<string, unknown>;
      claims.push(claim);
      const name = String(claim.name);
      if (status) {
        res.writeHead(status, { "content-type": "text/plain" });
        return res.end("worker threw");
      }
      if (!isAnonymousClaimName(name) && !claim.github && held.get(name) !== claim.pubkey) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "github-required", message: "needs GitHub" }));
      }
      held.set(name, claim.pubkey);
      accepted.push(claim);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    /** Every claim body the registrar was sent, in order. */
    claims,
    /** The ones it answered 200. */
    accepted,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), "frizz-cloud-"));
}

test("a pasted URL, a trailing slash or a stray dot all resolve to the same hostname", () => {
  // People paste the address bar. Refusing that would be a pointless second question.
  for (const raw of ["colin.frizz.sh", "https://colin.frizz.sh", "https://colin.frizz.sh/", "COLIN.Frizz.SH", "colin.frizz.sh."]) {
    assert.equal(normalizeHostname(raw), "colin.frizz.sh", raw);
  }
  assert.equal(normalizeHostname("  https://colin.frizz.sh/board  "), "colin.frizz.sh");
});

test("something that is not a hostname is refused at the prompt, not at the 403", () => {
  // A bare word would produce `https://laptop`, which fails later as an opaque origin mismatch.
  for (const raw of ["", "   ", "laptop", "https://"]) {
    assert.throws(() => normalizeHostname(raw), /invalid hostname/, JSON.stringify(raw));
  }
});

test("the config round-trips, so the second run of --cloud asks nothing", () => {
  const home = tempHome();
  try {
    assert.equal(readCloudConfig(home), null, "no config means first run");
    writeCloudConfig({ hostname: "colin.frizz.sh", tunnel: "colin" }, home);
    assert.deepEqual(readCloudConfig(home), { hostname: "colin.frizz.sh", tunnel: "colin" });
    assert.ok(readFileSync(cloudConfigPath(home), "utf8").endsWith("\n"), "written as a normal text file");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("saving the setup on a machine with no ~/.frizz does not create one", () => {
  // frizz-paths.ts reads an existing `~/.frizz` as "legacy install, route every root here". Until
  // 2026-09-23 the first remote-access setup on a fresh install wrote `~/.frizz/cloud.json`, and the
  // next launch resolved the registry, the projects and the database under that new directory instead
  // of the roots that held them — an empty board, with the setup it just saved. The claim identity had
  // the same bug and the same fix (identity.ts, 2026-08-28).
  const home = tempHome();
  try {
    const paths = frizzPaths({ home });
    assert.equal(paths.legacy, false, "a temp home starts out as a fresh install");
    writeCloudConfig({ hostname: "colin.frizz.sh", tunnel: "colin" }, home);
    assert.equal(existsSync(join(home, ".frizz")), false, "the literal directory must not appear");
    assert.equal(cloudConfigPath(home), join(paths.data, "cloud.json"));
    assert.equal(tunnelTokenPath(home), join(paths.state, "tunnel-token"));
    assert.equal(frizzPaths({ home }).legacy, false, "the install is still resolved the same way");
    assert.deepEqual(readCloudConfig(home), { hostname: "colin.frizz.sh", tunnel: "colin" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a machine that already has ~/.frizz keeps its setup exactly where it was", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, ".frizz"), { recursive: true });
    assert.equal(cloudConfigPath(home), join(home, ".frizz", "cloud.json"));
    assert.equal(tunnelTokenPath(home), join(home, ".frizz", "tunnel-token"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a corrupt or half-written config reads as absent rather than throwing", () => {
  // The failure mode this avoids is a launcher that cannot start at all because a JSON file got
  // truncated — falling back to the prompt is always recoverable.
  const home = tempHome();
  try {
    mkdirSync(dirname(cloudConfigPath(home)), { recursive: true });
    for (const bad of ["", "{", "null", '{"hostname":"x.dev"}', '{"tunnel":"t"}', '{"hostname":"","tunnel":"t"}']) {
      writeFileSync(cloudConfigPath(home), bad);
      assert.equal(readCloudConfig(home), null, JSON.stringify(bad));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an explicit cloudflared config wins; otherwise it is found or reported missing", () => {
  const home = tempHome();
  try {
    const base = { hostname: "colin.frizz.sh", tunnel: "colin" };
    assert.equal(resolveTunnelConfigPath(base, home), null, "absent means let cloudflared use its own default");

    mkdirSync(join(home, ".cloudflared"), { recursive: true });
    writeFileSync(join(home, ".cloudflared", "frizz.yml"), "tunnel: colin\n");
    assert.equal(resolveTunnelConfigPath(base, home), join(home, ".cloudflared", "frizz.yml"));

    assert.equal(resolveTunnelConfigPath({ ...base, config: "/somewhere/else.yml" }, home), "/somewhere/else.yml");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a --cloud launch with no terminal refuses rather than blocking on stdin forever", async () => {
  // Update & Restart re-execs the launcher with --cloud and no TTY. A prompt there would hang on a
  // stdin nobody can reach, and the board would never come back at all.
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  try {
    await assert.rejects(promptForCloudName(), /needs a saved name/);
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
  }
});

test("a bare word claims a name; anything with a dot keeps the bring-your-own path", async () => {
  // One question instead of two. The dot is the whole discriminator, so it is worth pinning that a
  // hostname never accidentally becomes a claim (which would talk to the registrar) and vice versa.
  const home = tempHome();
  try {
    const byo = await establishCloudConfig("board.example.com", 9393, home);
    assert.deepEqual(byo, { hostname: "board.example.com", tunnel: "board" });
    assert.equal(readTunnelToken(home), null, "a hostname you own needs no run token");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a name that cannot be claimed says WHY, before any network call", async () => {
  const home = tempHome();
  try {
    // An unreachable origin is named explicitly, which both bypasses the availability gate and proves
    // these refusals happen locally: reaching the network would surface as a connection error instead.
    const dead = "http://127.0.0.1:1";
    await assert.rejects(establishCloudConfig("www", 9393, home, dead), /reserved/);
    await assert.rejects(establishCloudConfig("ab", 9393, home, dead), /3-63 characters/);
    await assert.rejects(establishCloudConfig("has space", 9393, home, dead), /letters, digits and hyphens/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a claimed name stores the token at 0600, apart from the world-readable config", async () => {
  const home = tempHome();
  const server = await claimServer();
  try {
    const config = await establishCloudConfig("colin", 9393, home, server.origin, fakeGithub);
    assert.deepEqual(config, { hostname: "colin.frizz.sh", claim: "colin", serve: "tunnel" });
    assert.equal(readTunnelToken(home), "run-token");
    // A first try carries no token; the registrar asks for GitHub, and the second carries Frizz's sign-in.
    assert.equal("github" in server.claims[0]!, false, "the first try carries no token");
    assert.equal(server.accepted[0]?.github, "ghu_testtoken", "the claim carries the injected token");
    // The mode bits only — the claim, the token round trip and the config separation below are asserted
    // on every platform. Windows has no POSIX permission bits (NTFS access is an ACL, `fs.chmod` sets
    // only the read-only flag, node reports 0666), so the 0o600 cloud.ts writes with is inert there.
    if (process.platform !== "win32") {
      assert.equal(statSync(tunnelTokenPath(home)).mode & 0o777, 0o600, "a run token is a credential");
    }
    // The config file is NOT where the secret goes — it predates this feature and is world-readable
    // on machines that already have one. The launcher writes it, so write it the same way here.
    writeCloudConfig(config, home);
    assert.equal(readFileSync(cloudConfigPath(home), "utf8").includes("run-token"), false);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a launch renews the lease, and falls back to the cached token when the registrar is down", async () => {
  // The registrar is not on the data plane. A board that could not start because a signup service was
  // down would quietly make it one.
  const home = tempHome();
  const server = await claimServer();
  try {
    await establishCloudConfig("colin", 9393, home, server.origin, fakeGithub);
    const config = { hostname: "colin.frizz.sh", claim: "colin" };

    const renewed = await resolveRunToken(config, 9393, home, undefined, server.origin);
    assert.equal(renewed, "run-token");

    const warnings: string[] = [];
    const offline = await resolveRunToken(config, 9393, home, (m) => warnings.push(m), "http://127.0.0.1:1");
    assert.equal(offline, "run-token", "the cached token carries the launch");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /could not reach the Frizz registrar/);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a name the key already holds is claimed again without a GitHub token, and GitHub is not asked", async () => {
  const home = tempHome();
  const server = await claimServer({ hostname: "colin.frizz.sh", leaseExpiresAt: 0, renewed: false });
  let asked = 0;
  const counting = { authorize: async () => { asked++; return { token: "ghu_testtoken", login: "colin" }; } };
  try {
    await establishCloudConfig("colin", 9393, home, server.origin, counting);
    assert.equal(asked, 1);
    server.claims.length = 0;
    await establishCloudConfig("colin", 9393, home, server.origin, counting);
    assert.equal(asked, 1, "re-entering it did not touch the sign-in");
    assert.deepEqual(server.claims.map((claim) => "github" in claim), [false], "and sent no token");
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a custom name that is not the sign-in's own username is refused before the token is sent", async () => {
  const home = tempHome();
  const server = await claimServer({ hostname: "colin.frizz.sh", leaseExpiresAt: 0, renewed: false });
  try {
    const someoneElse = { authorize: async () => ({ token: "ghu_testtoken", login: "Ada-Lovelace" }) };
    await assert.rejects(
      establishCloudConfig("colin", 9393, home, server.origin, someoneElse),
      (error: unknown) =>
        error instanceof ClaimError && error.code === "not-your-github-username" && /claim ada-lovelace instead/.test(error.message),
    );
    assert.deepEqual(server.claims.map((claim) => "github" in claim), [false], "only the tokenless try went out");
    assert.equal(readCloudConfig(home), null, "and nothing was saved");
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a registrar failing on its own side does not stop a relay board's launch, and a refusal does", async () => {
  const home = tempHome();
  const relay = { hostname: "colin.frizz.sh", claim: "colin", serve: "relay" as const };
  for (const status of [500, 503]) {
    const server = await claimServer(undefined, status);
    try {
      const warnings: string[] = [];
      assert.equal(await resolveRunToken(relay, 9393, home, (m) => warnings.push(m), server.origin), null, String(status));
      assert.match(warnings[0] ?? "", new RegExp(`serving it on its current lease`));
    } finally {
      await server.close();
    }
  }
  const warnings: string[] = [];
  assert.equal(await resolveRunToken(relay, 9393, home, (m) => warnings.push(m), "http://127.0.0.1:1"), null, "unreachable too");
  // An answer that refuses (here, asking for GitHub, as it does for a name this key does not hold) is
  // not a failure, and the launch must hear it.
  const taken = await claimServer({ hostname: "colin.frizz.sh", leaseExpiresAt: 0, renewed: true });
  try {
    await assert.rejects(resolveRunToken({ ...relay, claim: "colin" }, 9393, home, undefined, taken.origin), /needs GitHub|github/i);
  } finally {
    await taken.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a bring-your-own config needs no token at all", async () => {
  const home = tempHome();
  try {
    assert.equal(await resolveRunToken({ hostname: "board.example.com", tunnel: "board" }, 9393, home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a claimed tunnel runs from its token; a hand-made one runs by name", () => {
  // cloudflared takes an entirely different command line for the two. Getting it wrong means the
  // tunnel never connects and the hostname serves a Cloudflare error with nothing to explain it.
  const claimed = startTunnel({ hostname: "colin.frizz.sh", claim: "colin" }, () => {}, () => {}, "/nowhere", "tok");
  const spawnArgs = claimed.child.spawnargs;
  claimed.stop();
  assert.deepEqual(spawnArgs.slice(1), ["tunnel", "--no-autoupdate", "run", "--token", "tok"]);

  const byo = startTunnel({ hostname: "board.example.com", tunnel: "board" }, () => {}, () => {}, "/nowhere");
  const byoArgs = byo.child.spawnargs;
  byo.stop();
  assert.deepEqual(byoArgs.slice(1), ["tunnel", "--no-autoupdate", "run", "board"]);
});

test("a config naming neither a tunnel nor a claim reads as absent", () => {
  // It describes a hostname nothing can serve, and acting on it would arm the origin gate for an
  // address with no tunnel behind it — a board that answers Forbidden with no way to tell why.
  const home = tempHome();
  try {
    mkdirSync(join(home, ".frizz"), { recursive: true });
    writeFileSync(cloudConfigPath(home), JSON.stringify({ hostname: "colin.frizz.sh" }));
    assert.equal(readCloudConfig(home), null);
    writeFileSync(cloudConfigPath(home), JSON.stringify({ hostname: "colin.frizz.sh", claim: "colin" }));
    assert.deepEqual(readCloudConfig(home), { hostname: "colin.frizz.sh", claim: "colin" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a first claim that cannot reach the registrar points at the path that works without it", async () => {
  // A renewal falls back to its cached token; a FIRST claim has nothing to fall back to, so the
  // operator is left with a network error for a service they have never heard of.
  const home = tempHome();
  try {
    await assert.rejects(
      establishCloudConfig("colin", 9393, home, "http://127.0.0.1:1", fakeGithub),
      /could not reach the Frizz registrar[\s\S]*tunnel of your own/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a claim's progress lines go where the caller says, and the R pane's unreachable error drops the prompt's hint", async () => {
  // Under the R pane, a console.log lands inside the pane's paint; the pane passes its own `say`. The
  // hint at the end of an unreachable error names the launch prompt's other answer, which the pane has
  // as rows of its own.
  const home = tempHome();
  const server = await claimServer();
  const printed: unknown[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { printed.push(args); };
  try {
    const said: string[] = [];
    await establishCloudConfig("colin", 9393, home, server.origin, fakeGithub, { say: (line) => said.push(line) });
    assert.deepEqual(said, ["  claiming colin.frizz.sh for GitHub user colin"]);
    assert.deepEqual(printed, [], "nothing reaches console.log");
    await assert.rejects(
      establishCloudConfig("colin", 9393, home, "http://127.0.0.1:1", fakeGithub, { say: () => {}, promptHint: false }),
      (error: Error) => /could not reach the Frizz registrar/.test(error.message) && !/tunnel of your own|\n/.test(error.message),
    );
  } finally {
    console.log = log;
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("the offer can be withdrawn by one constant, and a hostname never depended on it", async () => {
  // REGISTRAR_IS_LIVE is the whole gate. It is true now that the Worker is deployed; setting it back
  // to false must refuse a bare name up front rather than letting people hit a connection error.
  const home = tempHome();
  try {
    assert.equal(REGISTRAR_IS_LIVE, true, "the registrar is deployed at registrar.frizz.sh");
    // The bring-your-own path is unaffected either way, which is what makes the gate safe to flip.
    assert.deepEqual(await establishCloudConfig("board.example.com", 9393, home), {
      hostname: "board.example.com",
      tunnel: "board",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("naming a registrar explicitly bypasses the gate, which is how the deploy gets tested", async () => {
  const home = tempHome();
  const server = await claimServer();
  try {
    const config = await establishCloudConfig("colin", 9393, home, server.origin, fakeGithub);
    assert.deepEqual(config, { hostname: "colin.frizz.sh", claim: "colin", serve: "tunnel" });
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});


test("a registrar that returns NO token means the name is served by the relay", async () => {
  // Relay mode is the default now: the board opens a socket to the relay and proves itself with its
  // keypair, so there is no tunnel to run and nothing to cache.
  const home = tempHome();
  const server = await claimServer({ hostname: "colin.frizz.sh", leaseExpiresAt: 0, renewed: false });
  try {
    const config = await establishCloudConfig("colin", 9393, home, server.origin, fakeGithub);
    assert.deepEqual(config, { hostname: "colin.frizz.sh", claim: "colin", serve: "relay" });
    assert.equal(readTunnelToken(home), null, "a relay board must cache no run token");
    assert.equal(isRelayConfig(config), true);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("isRelayConfig reads the file and nothing else; the older shapes are not relay configs", async () => {
  // Reconciling them is reconcileCloudConfig's job (below); the predicate must not guess.
  assert.equal(isRelayConfig({ hostname: "colin.frizz.sh", claim: "colin" }), false);
  assert.equal(isRelayConfig({ hostname: "colin.frizz.sh", claim: "colin", serve: "tunnel" }), false);
  assert.equal(isRelayConfig({ hostname: "b.example.com", tunnel: "b" }), false, "a hand-made tunnel is not relayed");
});

test("a hostname inside the zone stands for exactly one claim label", () => {
  assert.equal(zoneClaimLabel("colin.frizz.sh"), "colin");
  assert.equal(zoneClaimLabel("frizz.sh"), null, "the apex is not a name");
  assert.equal(zoneClaimLabel("a.b.frizz.sh"), null, "the registrar never hands out a deeper name");
  assert.equal(zoneClaimLabel("board.example.com"), null);
  assert.equal(zoneClaimLabel("notfrizz.sh"), null);
});

// 2026-08-25: `frizz up` ran the hand-made tunnel for colin.frizz.sh faithfully, and the phone that
// scanned the QR read "No Frizz board has claimed this name." — the relay's wildcard route had taken
// the zone, and nothing in `up` would ever have claimed the name. Claiming is part of `up`.
test("up claims a zone hostname that was saved as a hand-made tunnel, and serves it by relay", async () => {
  const home = tempHome();
  const server = await claimServer({ hostname: "colin.frizz.sh", leaseExpiresAt: 0, renewed: false });
  const notices: string[] = [];
  try {
    const stale = { hostname: "colin.frizz.sh", tunnel: "colin", config: "/x/frizz.yml" };
    const config = await reconcileCloudConfig(stale, 9393, home, (m) => notices.push(m), server.origin, fakeGithub);
    assert.deepEqual(config, { hostname: "colin.frizz.sh", claim: "colin", serve: "relay" });
    assert.equal(server.accepted.length, 1, "the label is claimed through the same call a first launch makes");
    assert.equal(server.accepted[0]!.name, "colin");
    assert.ok(notices.some((m) => m.includes("claiming colin")), notices.join("\n"));
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("up moves a claim issued in the tunnel era onto the relay", async () => {
  const home = tempHome();
  const server = await claimServer({ hostname: "colin.frizz.sh", leaseExpiresAt: 0, renewed: true });
  try {
    const config = await reconcileCloudConfig({ hostname: "colin.frizz.sh", claim: "colin", serve: "tunnel" }, 9393, home, undefined, server.origin, fakeGithub);
    assert.deepEqual(config, { hostname: "colin.frizz.sh", claim: "colin", serve: "relay" });
    assert.equal(server.claims[0]!.name, "colin");
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("reconciling leaves a relay claim and an operator's own hostname exactly as saved", async () => {
  const home = tempHome();
  const server = await claimServer();
  try {
    const relay = { hostname: "colin.frizz.sh", claim: "colin", serve: "relay" as const };
    assert.equal(await reconcileCloudConfig(relay, 9393, home, undefined, server.origin, fakeGithub), relay);
    const own = { hostname: "board.example.com", tunnel: "my-board" };
    assert.equal(await reconcileCloudConfig(own, 9393, home, undefined, server.origin, fakeGithub), own);
    assert.equal(server.claims.length, 0, "neither shape makes a claim call");
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("an EMPTY answer claims a private unguessable name, and GitHub is never consulted", async () => {
  // The auth-free default: no account, no sign-in. The stand-in below throws on any touch,
  // so this also proves the anonymous path never starts a GitHub sign-in.
  const home = tempHome();
  const server = await claimServer({ hostname: "x.frizz.sh", leaseExpiresAt: 0, renewed: false });
  const untouchable = {
    authorize: async (): Promise<never> => { throw new Error("GitHub must not be consulted"); },
  };
  try {
    const config = await establishCloudConfig("", 9393, home, server.origin, untouchable);
    assert.match(config.claim!, /^[a-z2-7]{20}$/, "the label is the 20-character anonymous shape");
    assert.equal(config.serve, "relay");
    assert.equal(server.claims[0]?.name, config.claim, "the generated name is what was claimed");
    assert.equal("github" in server.claims[0]!, false, "the claim carries no GitHub token");
    assert.equal(readTunnelToken(home), null, "a relay name has no run token");
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a name that already HAS the anonymous shape re-claims without GitHub too", async () => {
  // reconcileCloudConfig re-claims a saved label through establishCloudConfig, so an anonymous label
  // arriving as TEXT must ride the anonymous path — or a reconcile would suddenly demand a GitHub sign-in.
  const home = tempHome();
  const server = await claimServer({ hostname: "x.frizz.sh", leaseExpiresAt: 0, renewed: true });
  const untouchable = {
    authorize: async (): Promise<never> => { throw new Error("GitHub must not be consulted"); },
  };
  try {
    const label = "abcdefghjkmnpqrstuvw";
    const config = await establishCloudConfig(label, 9393, home, server.origin, untouchable);
    assert.equal(config.claim, label, "the given label is claimed, not a fresh one");
    assert.equal("github" in server.claims[0]!, false);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// 2026-10-08: a compromised registrar collected the `gh auth token` every named claim sent — a token
// that can push to every repository its owner can. The claim path no longer runs `gh` at all. This
// puts a `gh` on PATH that would hand over a secret and record being run, then claims a name: the body
// carries only Frizz's own sign-in, and the `gh` was never touched.
test("a named claim never runs `gh` and never sends its token", { skip: process.platform === "win32" && "a shell-script gh needs a POSIX shell" }, async () => {
  const home = tempHome();
  const bin = mkdtempSync(join(tmpdir(), "frizz-fake-gh-"));
  const ran = join(bin, "ran");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${ran}"\necho gho_SECRET_FROM_GH_CLI\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const server = await claimServer({ hostname: "colin.frizz.sh", leaseExpiresAt: 0, renewed: false });
  try {
    // The fake `gh` is live: a control proving the test could see it if the claim path used it.
    assert.equal(execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim(), "gho_SECRET_FROM_GH_CLI");
    rmSync(ran, { force: true });

    await establishCloudConfig("colin", 9393, home, server.origin, {
      authorize: async () => ({ token: "ghu_frizzSignInToken", login: "colin" }),
    });
    const sent = JSON.stringify(server.claims);
    assert.equal(server.accepted[0]?.github, "ghu_frizzSignInToken", "the claim carries Frizz's sign-in");
    assert.equal(sent.includes("gho_SECRET_FROM_GH_CLI"), false, "the gh token never reaches the registrar");
    assert.equal(existsSync(ran), false, "the claim path never ran gh");
  } finally {
    process.env.PATH = path;
    await server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
