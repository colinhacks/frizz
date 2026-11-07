#!/usr/bin/env nub
/**
 * The whole claim loop, over a real socket: CLI client → HTTP → the real Worker handler → Cloudflare.
 *
 * Both halves are unit-tested against fakes, which proves each of them and nothing about the seam
 * between them — and the seam is where this would break, because it is the only place the two agree
 * on a wire format instead of on a function signature. So the client here is the real client, the
 * request really is serialized and sent, and the handler answering it is the real handler.
 *
 * Cloudflare itself stays faked, deliberately: provisioning a real tunnel needs a zone token, and this
 * must be runnable by anyone, on any machine, without one. Whether cloudflare.ts speaks the real API
 * correctly is a different question, answered by running it against the real zone — done 2026-08-24.
 *
 * GitHub is faked the same way, on its own loopback port, for the last legs: the CLI reads a REAL sealed
 * Frizz GitHub sign-in from a throwaway home and the registrar runs the REAL verifier against the fake,
 * so the token that crosses the wire is the one the sign-in holds, and a `gh` CLI token is refused by
 * the real check.
 */
import { createServer } from "node:http";
import { once } from "node:events";
import { CLAIM_LEASE_MS } from "@frizz/shared";
import { handleClaim } from "../packages/registrar/src/claim-handler.ts";
import { loadOrCreateClaimIdentity } from "../src/identity.ts";
import { claimName, ClaimError } from "../src/registrar-client.ts";
import { githubVerifier } from "../packages/registrar/src/worker.ts";
import { establishCloudConfig } from "../src/cloud.ts";
import { frizzGithubSignIn } from "../src/github-claim-identity.ts";
import { resetFrizzRoots } from "../packages/server/src/frizz-paths.ts";
import { githubCredentialPath, resetGithubCredentialMemo, writeGithubCredential } from "../packages/server/src/github-credential.ts";
import { resetGithubCredentialSeal } from "../packages/server/src/github-credential-seal.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Cloudflare's part, in memory. Records the calls so the DNS target can be asserted. */
function fakeCloudflare() {
  const tunnels = new Map();
  const dns = new Map();
  let next = 1;
  return {
    tunnels,
    dns,
    api: {
      async createTunnel(name) {
        const id = `tunnel-${next++}`;
        tunnels.set(id, name);
        return { id, token: `run-token-${id}` };
      },
      async findTunnel(name) {
        for (const [id, tunnelName] of tunnels) if (tunnelName === name) return { id };
        return null;
      },
      async tunnelToken(id) {
        return `run-token-${id}`;
      },
      async setTunnelIngress() {},
      async upsertDnsRecord(hostname, target) {
        dns.set(hostname, target);
      },
      async deleteTunnel(id) {
        tunnels.delete(id);
      },
      async deleteDnsRecord(hostname) {
        dns.delete(hostname);
      },
    },
  };
}

function memoryStore() {
  const rows = new Map();
  const owners = new Map();
  const githubOwners = new Map();
  return {
    rows,
    owners,
    githubOwners,
    store: {
      async readGithubOwner(id) {
        return githubOwners.get(id) ?? null;
      },
      async writeGithubOwner(id, name) {
        githubOwners.set(id, name);
      },
      async removeGithubOwner(id) {
        githubOwners.delete(id);
      },
      async readOwner(pubkey) {
        return owners.get(pubkey) ?? null;
      },
      async writeOwner(pubkey, name) {
        owners.set(pubkey, name);
      },
      async removeOwner(pubkey) {
        owners.delete(pubkey);
      },
      async list() {
        return [...rows.keys()];
      },
      async read(name) {
        return rows.get(name) ?? null;
      },
      async write(name, record) {
        rows.set(name, record);
      },
      async remove(name) {
        rows.delete(name);
      },
    },
  };
}

const home = mkdtempSync(join(tmpdir(), "frizz-claim-e2e-"));
const cf = fakeCloudflare();
const st = memoryStore();
let clock = 1_800_000_000_000;
// Off for the first legs, armed for the anonymous one — the waiver only means anything with a gate up.
let gate = null;
/** Every claim body the registrar was sent, so the last legs can say exactly which token crossed. */
const received = [];

/**
 * api.github.com on one port. `/user` answers the App's user token naming Frizz's App in
 * X-OAuth-Client-Id with an empty X-OAuth-Scopes (what the real API answered for one on 2026-11-07),
 * and the `gh` token naming the `gh` CLI's OAuth app with the scopes the real `gh` holds.
 */
const APP = "ghu_e2eAgentConsoleUserToken";
const GH_CLI = "gho_e2eGhCliTokenWithRepoScope";
const githubSeen = [];
const github = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    githubSeen.push({ path: req.url, form: Object.fromEntries(new URLSearchParams(raw)), auth: req.headers.authorization ?? null });
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/user") {
      const user = { id: 777, login: "e2e-user", created_at: "2015-01-01T00:00:00Z" };
      if (req.headers.authorization === `Bearer ${APP}`) return send(200, user, { "x-oauth-client-id": "Iv23licDruV3JtQIF3fI", "x-oauth-scopes": "" });
      if (req.headers.authorization === `Bearer ${GH_CLI}`) {
        return send(200, user, { "x-oauth-client-id": "178c6fc778ccc68e1d6a", "x-oauth-scopes": "gist, read:org, repo, workflow" });
      }
      return send(401, { message: "Bad credentials" });
    }
    send(404, { message: "Not Found" });
  });
});

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      body = null;
    }
    received.push(body);
    const outcome = await handleClaim(body, {
      api: cf.api,
      store: st.store,
      zone: "frizz.sh",
      now: () => clock,
      ...(gate ? { github: gate } : {}),
    });
    res.writeHead(outcome.status, { "content-type": "application/json" });
    res.end(JSON.stringify(outcome.body));
  });
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;

  // 1. A real identity from a real key file, exactly as a launch would load it.
  const identity = await loadOrCreateClaimIdentity(home);

  const first = await claimName({ name: "colin", port: 9393, identity, origin, now: () => clock });
  check("a name is claimed end to end", first.hostname === "colin.frizz.sh", first.hostname);
  check("a run token comes back", typeof first.token === "string" && first.token.length > 0, first.token);
  check("the first claim is not a renewal", first.renewed === false);
  check(
    "the DNS record points at the tunnel",
    cf.dns.get("colin.frizz.sh") === "tunnel-1.cfargotunnel.com",
    cf.dns.get("colin.frizz.sh") ?? "(none)"
  );
  check("the lease runs 30 days", first.leaseExpiresAt === clock + CLAIM_LEASE_MS);

  // 2. THE PROPERTY THAT PROTECTS THE ACCOUNT CAP. Every launch re-claims; none may provision again.
  clock += 60_000;
  const renewed = await claimName({ name: "colin", port: 9393, identity, origin, now: () => clock });
  check("a second launch renews rather than provisioning", renewed.renewed === true);
  check("no second tunnel was created", cf.tunnels.size === 1, `${cf.tunnels.size} tunnels`);

  // 3. A DIFFERENT machine — a different key — cannot take the name.
  const otherHome = mkdtempSync(join(tmpdir(), "frizz-claim-e2e-other-"));
  try {
    const stranger = await loadOrCreateClaimIdentity(otherHome);
    let refused = null;
    try {
      await claimName({ name: "colin", port: 9393, identity: stranger, origin, now: () => clock });
    } catch (error) {
      refused = error;
    }
    check(
      "another key is refused the name",
      refused instanceof ClaimError && refused.code === "name-taken",
      refused ? `${refused.code}: ${refused.message}` : "it was ALLOWED"
    );
    check("the owner still owns it", st.rows.get("colin")?.pubkey === (await (async () => {
      const { exportClaimPublicKey } = await import("@frizz/shared");
      return exportClaimPublicKey(identity.publicKey);
    })()));

    // 4. Once the lease lapses, the same stranger CAN take it, and the old tunnel is gone.
    clock += CLAIM_LEASE_MS + 1;
    const takenOver = await claimName({ name: "colin", port: 4321, identity: stranger, origin, now: () => clock });
    check("a lapsed name is reclaimable", takenOver.renewed === false && takenOver.hostname === "colin.frizz.sh");
    check("the abandoned tunnel was torn down", cf.tunnels.has("tunnel-1") === false);
    check("exactly one tunnel remains", cf.tunnels.size === 1, `${cf.tunnels.size} tunnels`);
  } finally {
    rmSync(otherHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  // 5. A name that cannot be a hostname never reaches Cloudflare.
  let rejected = null;
  try {
    await claimName({ name: "www", port: 9393, identity, origin, now: () => clock });
  } catch (error) {
    rejected = error;
  }
  check("a reserved name is refused before provisioning", rejected !== null, rejected?.message ?? "it was ALLOWED");

  // 6. THE AUTH-FREE PATH, over the same wire, with the GitHub gate UP: an anonymous name claims
  // with no token while a vanity name is still refused for lacking one.
  gate = async () => null; // every token is refused, so only the waiver can let a claim through
  const { generateAnonymousClaimName } = await import("@frizz/shared");
  const anonHome = mkdtempSync(join(tmpdir(), "frizz-claim-e2e-anon-"));
  try {
    const anonIdentity = await loadOrCreateClaimIdentity(anonHome);
    const anonName = generateAnonymousClaimName();
    const anon = await claimName({ name: anonName, port: 9393, identity: anonIdentity, origin, now: () => clock });
    check("an anonymous name claims through the gate with no GitHub", anon.hostname === `${anonName}.frizz.sh`, anon.hostname);

    let gated = null;
    try {
      await claimName({ name: "wants-a-word", port: 9393, identity: anonIdentity, origin, now: () => clock });
    } catch (error) {
      gated = error;
    }
    check(
      "a vanity name still pays the gate on the same wire",
      gated instanceof ClaimError && gated.code === "github-required",
      gated ? `${gated.code}` : "it was ALLOWED"
    );
  } finally {
    rmSync(anonHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  // 7. A CUSTOM NAME THROUGH FRIZZ'S OWN GITHUB SIGN-IN, with the real verifier as the gate. The CLI
  // side is the launcher's own establishCloudConfig with the authorizer the R pane uses, reading a real
  // sealed credential from a throwaway home; the registrar side is the real githubVerifier, asking the
  // fake GitHub what the token is and what scopes it holds. The throwaway home has no keychain, so the
  // seal's key is a file there and nothing asks the real keychain. Custom names are withdrawn for now
  // (CUSTOM_NAMES_OFFERED in src/cloud.ts); the override turns the kept path back on for this process.
  process.env.FRIZZ_CUSTOM_NAMES = "1";
  github.listen(0, "127.0.0.1");
  await once(github, "listening");
  const githubOrigin = `http://127.0.0.1:${github.address().port}`;
  gate = githubVerifier(fetch, githubOrigin);
  // establishCloudConfig signs with the real clock, so the registrar's clock joins it here.
  clock = Date.now();
  const deviceHome = mkdtempSync(join(tmpdir(), "frizz-claim-e2e-signin-"));
  const savedEnv = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, FRIZZ_GITHUB_TOKEN: process.env.FRIZZ_GITHUB_TOKEN };
  process.env.HOME = deviceHome;
  process.env.XDG_DATA_HOME = join(deviceHome, "data");
  delete process.env.FRIZZ_GITHUB_TOKEN;
  resetFrizzRoots();
  resetGithubCredentialSeal();
  resetGithubCredentialMemo();
  try {
    writeGithubCredential({
      kind: "app",
      clientId: "Iv23e2eclient",
      accessToken: APP,
      accessExpiresAt: Date.now() + 8 * 3600_000,
      refreshToken: "ghr_e2eRefresh",
      refreshExpiresAt: Date.now() + 180 * 86_400_000,
      login: "e2e-user",
      savedAt: Date.now(),
    });
    check("the sign-in is sealed on disk, not in the clear", !readFileSync(githubCredentialPath(), "utf8").includes(APP));
    resetGithubCredentialMemo();
    received.length = 0;
    const config = await establishCloudConfig("e2e-user", 9393, deviceHome, origin, frizzGithubSignIn());
    check("a custom name claims through Frizz's GitHub sign-in", config.claim === "e2e-user" && config.hostname === "e2e-user.frizz.sh", JSON.stringify(config));
    check("the claim carried the sign-in's App token and nothing else", received.length === 1 && received[0]?.github === APP, received[0]?.github ? received[0].github.slice(0, 4) : "(none)");
    check("the registrar asked GitHub about that token", githubSeen.some((r) => r.path === "/user" && r.auth === `Bearer ${APP}`));
    check("GitHub was asked nothing else", githubSeen.every((r) => r.path === "/user"), githubSeen.map((r) => r.path).join(", "));
    check("the name is bound to the account id", st.rows.get("e2e-user")?.githubId === 777, String(st.rows.get("e2e-user")?.githubId));

    // 8. AN OLD CLIENT, sending what `gh auth token` prints: the real verifier reads the scopes and refuses.
    const oldHome = mkdtempSync(join(tmpdir(), "frizz-claim-e2e-old-"));
    try {
      const oldIdentity = await loadOrCreateClaimIdentity(oldHome);
      let refused = null;
      try {
        await claimName({ name: "old-client", port: 9393, identity: oldIdentity, origin, now: () => clock, github: GH_CLI });
      } catch (error) {
        refused = error;
      }
      check(
        "a gh CLI token is refused, pointing the person at Frizz's own sign-in",
        refused instanceof ClaimError && refused.code === "github-token-foreign" && /Settings/.test(refused.message),
        refused ? `${refused.code}: ${refused.message}` : "it was ALLOWED"
      );
      check("nothing was recorded for it", !st.rows.has("old-client"));
    } finally {
      rmSync(oldHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetFrizzRoots();
    resetGithubCredentialSeal();
    resetGithubCredentialMemo();
    rmSync(deviceHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
} catch (error) {
  check("harness completed", false, error instanceof Error ? error.message : String(error));
} finally {
  server.close();
  await once(server, "close").catch(() => {});
  if (github.listening) github.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
