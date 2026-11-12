import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { cloudConfigPath, type CloudConfig, readCloudConfig, writeCloudConfig } from "./cloud.ts";
import { createRemoteController } from "./remote-controller.ts";

for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete process.env[name];

// `.invalid` never resolves, so the relay's socket goes nowhere and nothing reaches a real registrar or relay.
const RELAY: CloudConfig = { hostname: "ada.invalid", claim: "ada", serve: "relay", relayAccess: "read-and-answer" };
const STOP_HERE = "stopped where the relay would start";

let registrar: Server;
/** What the fake registrar says: a renewal, or a name it had to create again. */
let answerRenewed = true;
before(async () => {
  registrar = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hostname: RELAY.hostname, leaseExpiresAt: 0, renewed: answerRenewed }));
  }).listen(0, "127.0.0.1");
  await once(registrar, "listening");
  process.env.FRIZZ_REGISTRAR = `http://127.0.0.1:${(registrar.address() as { port: number }).port}`;
});
after(() => { registrar.close(); });

function controller({ stopAtRelay = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "frizz-remote-controller-"));
  const calls: string[] = [];
  const remote = createRemoteController({
    host: {
      setPublicOrigin: (origin) => { calls.push(`origin ${origin ?? "none"}`); },
      setRelayAccess: (access) => { calls.push(`access ${access ?? "unset"}`); },
      relayListener: async () => {
        calls.push("relay listener");
        if (stopAtRelay) throw new Error(STOP_HERE);
        return 1;
      },
      forgetSessionsFor: (hostname) => { calls.push(`forget ${hostname}`); return 0; },
    },
    port: 9393,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    say: () => {},
    home,
  });
  return { remote, calls, home, [Symbol.dispose]: () => { remote.stop(); rmSync(home, { recursive: true, force: true }); } };
}

test("a saved answer is in force before the relay can carry a session: a limited board is never full for a moment", async () => {
  using saved = controller();
  writeCloudConfig(RELAY, saved.home);
  await assert.rejects(saved.remote.serveSaved(), new RegExp(STOP_HERE));
  assert.deepEqual(saved.calls, ["access read-and-answer", "relay listener"]);

  using applied = controller();
  await assert.rejects(applied.remote.apply(RELAY, { justClaimed: true }), new RegExp(STOP_HERE));
  assert.deepEqual(applied.calls, ["origin none", "access read-and-answer", "relay listener"]);
});

test("a change is saved, declared, and leaves the name and the transport alone", async () => {
  using board = controller({ stopAtRelay: false });
  await board.remote.apply(RELAY, { justClaimed: true });
  board.calls.length = 0;

  board.remote.setRelayAccess("full");
  assert.deepEqual(board.calls, ["access full"], "the relay listener and the origin are not touched");
  assert.deepEqual(readCloudConfig(board.home), { ...RELAY, relayAccess: "full" });
  assert.equal(board.remote.current()!.relayAccess, "full");
});

test("a board the relay does not serve has nothing to change, and nothing is written", async () => {
  using nothing = controller();
  assert.throws(() => nothing.remote.setRelayAccess("read-and-answer"), /not served through the Frizz relay/);
  assert.equal(existsSync(cloudConfigPath(nothing.home)), false);

  using tailscale = controller();
  const external: CloudConfig = { hostname: "mac.corgi-alpha.ts.net", serve: "external", provider: "tailscale" };
  await tailscale.remote.apply(external);
  assert.throws(() => tailscale.remote.setRelayAccess("read-and-answer"), /not served through the Frizz relay/);
  assert.deepEqual(readCloudConfig(tailscale.home), external);
});

test("a saved value this build does not know is the narrower answer, and a board with none is unset", () => {
  using board = controller();
  writeCloudConfig({ ...RELAY, relayAccess: "something-new" as "full" }, board.home);
  assert.equal(readCloudConfig(board.home)!.relayAccess, "read-and-answer");
  const { relayAccess: _dropped, ...before } = RELAY;
  writeCloudConfig(before, board.home);
  assert.equal("relayAccess" in readCloudConfig(board.home)!, false);
});

test("only the launcher writes the setting: nothing a request can reach calls it, or saves the setup", () => {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const sources = [
    ...readdirSync(join(repo, "src"), { recursive: true, encoding: "utf8" }).map((path) => join("src", path)),
    ...readdirSync(join(repo, "packages/server/src"), { recursive: true, encoding: "utf8" }).map((path) => join("packages/server/src", path)),
  ].filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));
  const callers = sources.filter((path) => /\b(?:setRelayAccess|writeCloudConfig)\(/.test(readFileSync(join(repo, path), "utf8"))).sort();
  assert.deepEqual(callers, [
    "packages/server/src/dev-supervisor.ts", // forwards to the proxy, for the launcher
    "packages/server/src/restart-supervisor.ts", // the proxy's own method, and it writes no file
    "src/cloud.ts", // defines writeCloudConfig
    "src/index.ts", // hands the pane its controller, in the dev launcher
    "src/production.ts", // and in the shipped one
    "src/remote-controller.ts", // the launcher's controller
    "src/remote-pane.ts", // the R pane
  ]);
});

const quiet = { info() {}, warn() {}, error() {} };

/** A controller serving a relay name, against a local registrar that answers with `status`. */
async function serving(t: TestContext, status: number) {
  const home = mkdtempSync(join(tmpdir(), "frizz-lease-"));
  const claims: string[] = [];
  const said: string[] = [];
  const registrar = createServer((req, res) => {
    claims.push(req.url ?? "");
    req.resume();
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(status === 200 ? { hostname: "colin.invalid", leaseExpiresAt: Date.now(), renewed: true } : { error: "name-taken" }));
  });
  registrar.listen(0, "127.0.0.1");
  await once(registrar, "listening");
  const saved = process.env.FRIZZ_REGISTRAR;
  process.env.FRIZZ_REGISTRAR = `http://127.0.0.1:${(registrar.address() as { port: number }).port}`;
  const controller = createRemoteController({
    host: { setPublicOrigin() {}, setRelayAccess() {}, relayListener: async () => 1 },
    port: 1,
    log: quiet,
    say: (message) => said.push(message),
    home,
    leaseRenewalMs: 10,
  });
  t.after(() => {
    controller.stop();
    registrar.close();
    if (saved === undefined) delete process.env.FRIZZ_REGISTRAR;
    else process.env.FRIZZ_REGISTRAR = saved;
    rmSync(home, { recursive: true, force: true });
  });
  await controller.apply({ hostname: "colin.invalid", claim: "colin", serve: "relay" }, { justClaimed: true });
  return { controller, claims, said };
}

async function until(condition: () => boolean, what = "timed out") {
  for (const deadline = Date.now() + 30_000; !condition() && Date.now() < deadline; ) await delay(10);
  assert.ok(condition(), what);
}

test("a served name renews its lease while the board runs, and stops when it stops serving", async (t) => {
  const { controller, claims } = await serving(t, 200);
  assert.equal(claims.length, 0, "a fresh claim needs no renewal yet");
  await until(() => claims.length >= 2);
  assert.ok(claims.every((url) => url === "/claim"));
  controller.stop();
  // Renewals already on the wire still arrive, one per 10ms the board served, and on a busy machine
  // they take their time: 50ms was allowed for them, and a fourth arrived after it (`4 !== 3`, a Mac
  // at load 94). So wait for the registrar to hear nothing for fifty renewal periods on end. A timer
  // that outlived the stop never leaves that long a silence, and this times out.
  let heard = claims.length;
  let quietSince = Date.now();
  await until(() => {
    if (claims.length !== heard) [heard, quietSince] = [claims.length, Date.now()];
    return Date.now() - quietSince >= 500;
  }, "renewals kept arriving after the stop");
});

test("a refused renewal tells the operator, because the name lapses if it goes on", async (t) => {
  const { said } = await serving(t, 409);
  await until(() => said.length > 0);
  assert.match(said[0]!, /could not renew colin\.invalid.*now belongs to another machine: a sign-in to the GitHub account colin claimed it there/);
});

test("a saved name the registrar had to create again signs out what was signed in under it, and a renewal does not", async () => {
  // Someone else may have served the name while it was gone, and collected the cookies phones sent it.
  using renewed = controller();
  writeCloudConfig(RELAY, renewed.home);
  await assert.rejects(renewed.remote.serveSaved(), new RegExp(STOP_HERE));
  assert.equal(renewed.calls.some((call) => call.startsWith("forget")), false);

  answerRenewed = false;
  try {
    using recreated = controller();
    writeCloudConfig(RELAY, recreated.home);
    await assert.rejects(recreated.remote.serveSaved(), new RegExp(STOP_HERE));
    assert.deepEqual(recreated.calls, ["access read-and-answer", `forget ${RELAY.hostname}`, "relay listener"], "before the relay can carry a session")
  } finally {
    answerRenewed = true;
  }
});
