import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createRemoteController } from "./remote-controller.ts";

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
    host: { setPublicOrigin() {}, relayListener: async () => 1 },
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

async function until(condition: () => boolean) {
  for (let i = 0; i < 300 && !condition(); i++) await delay(10);
  assert.ok(condition(), "timed out");
}

test("a served name renews its lease while the board runs, and stops when it stops serving", async (t) => {
  const { controller, claims } = await serving(t, 200);
  assert.equal(claims.length, 0, "a fresh claim needs no renewal yet");
  await until(() => claims.length >= 2);
  assert.ok(claims.every((url) => url === "/claim"));
  controller.stop();
  await delay(50);
  const settled = claims.length;
  await delay(60);
  assert.equal(claims.length, settled);
});

test("a refused renewal tells the operator, because the name lapses if it goes on", async (t) => {
  const { said } = await serving(t, 409);
  await until(() => said.length > 0);
  assert.match(said[0]!, /could not renew colin\.invalid.*already taken/);
});
