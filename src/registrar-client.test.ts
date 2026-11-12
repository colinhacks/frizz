import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { generateClaimIdentity, verifyClaim } from "@frizz/shared";
import { ClaimError, claimName, registrarOrigin, DEFAULT_REGISTRAR } from "./registrar-client.ts";

/** A real HTTP server, so the request is actually serialized, sent, parsed and answered. */
async function registrar(handler: (body: unknown) => { status: number; body: unknown }) {
  const seen: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        parsed = null;
      }
      seen.push({ url: req.url, method: req.method, body: parsed });
      const answer = handler(parsed);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return {
    seen,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

const ok = {
  hostname: "colin.frizz.sh",
  token: "run-token",
  leaseExpiresAt: 1_800_000_000_000,
  renewed: false,
};

test("a claim is signed, sent to /claim, and verifies on the far side", async () => {
  // The decisive check: the registrar in this test runs the REAL verifier over the REAL wire bytes,
  // so a serialization mistake anywhere in the client shows up here rather than in production.
  const server = await registrar(() => ({ status: 200, body: ok }));
  try {
    const identity = await generateClaimIdentity();
    const now = 1_700_000_000_000;
    const result = await claimName({
      name: "colin",
      port: 9393,
      identity,
      origin: server.origin,
      now: () => now,
    });
    assert.deepEqual(result, ok);

    const [call] = server.seen as Array<{ url: string; method: string; body: unknown }>;
    assert.equal(call.url, "/claim");
    assert.equal(call.method, "POST");
    const verdict = await verifyClaim(call.body, now);
    assert.ok(verdict.ok, "the registrar could not verify what the client sent");
    assert.equal(verdict.payload.name, "colin");
    assert.equal(verdict.payload.port, 9393);
  } finally {
    await server.close();
  }
});

test("a trailing slash on the origin does not produce a double slash", async () => {
  const server = await registrar(() => ({ status: 200, body: ok }));
  try {
    const identity = await generateClaimIdentity();
    await claimName({ name: "colin", port: 9393, identity, origin: `${server.origin}/` });
    assert.equal((server.seen[0] as { url: string }).url, "/claim");
  } finally {
    await server.close();
  }
});

test("a taken name is reported as advice, not as the server's raw code", async () => {
  const server = await registrar(() => ({
    status: 409,
    body: { error: "name-taken", message: "that name belongs to someone else" },
  }));
  try {
    const identity = await generateClaimIdentity();
    await assert.rejects(
      claimName({ name: "colin", port: 9393, identity, origin: server.origin }),
      (error: ClaimError) => {
        assert.equal(error.code, "name-taken");
        assert.match(error.message, /already taken — try another/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("an unknown error code falls back to the registrar's own words", async () => {
  // A newer registrar must be able to explain a failure this client has never heard of, instead of
  // having it flattened into something generic.
  const server = await registrar(() => ({
    status: 400,
    body: { error: "quota-exhausted", message: "the namespace is full; try again next week" },
  }));
  try {
    const identity = await generateClaimIdentity();
    await assert.rejects(
      claimName({ name: "colin", port: 9393, identity, origin: server.origin }),
      (error: ClaimError) => {
        assert.equal(error.code, "quota-exhausted");
        assert.match(error.message, /namespace is full/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("a registrar that is DOWN is distinguished from one that refused", async () => {
  // Confusing these sends someone off to pick a different name when nothing was wrong with theirs.
  const identity = await generateClaimIdentity();
  await assert.rejects(
    // Port 1 on loopback: nothing listens, so this is a connection failure rather than an HTTP error.
    claimName({ name: "colin", port: 9393, identity, origin: "http://127.0.0.1:1" }),
    (error: ClaimError) => {
      assert.equal(error.code, "unreachable");
      assert.match(error.message, /could not reach the Frizz registrar/);
      return true;
    },
  );
});

test("a 200 that is not a claim result is refused rather than half-used", async () => {
  // A captive portal or a misconfigured proxy answers 200 with HTML. Treating that as success would
  // hand cloudflared an empty token and fail somewhere far less obvious.
  // `{ hostname }` alone is NOT malformed any more: a relay-served name comes back without a token.
  for (const body of [{}, { token: "t" }, "not an object", { hostname: 42 }]) {
    const server = await registrar(() => ({ status: 200, body }));
    try {
      const identity = await generateClaimIdentity();
      await assert.rejects(
        claimName({ name: "colin", port: 9393, identity, origin: server.origin }),
        (error: ClaimError) => {
          assert.equal(error.code, "malformed-response");
          return true;
        },
        JSON.stringify(body),
      );
    } finally {
      await server.close();
    }
  }
});

test("the registrar origin is overridable, for a self-hoster or a test", () => {
  assert.equal(registrarOrigin({}), DEFAULT_REGISTRAR);
  assert.equal(registrarOrigin({ FRIZZ_REGISTRAR: "  https://mine.example  " }), "https://mine.example");
  assert.equal(registrarOrigin({ FRIZZ_REGISTRAR: "  " }), DEFAULT_REGISTRAR);
});

test("a GitHub token is sent only over https, or to this machine's loopback", async () => {
  const identity = await generateClaimIdentity();
  let sent = 0;
  const fetchImpl = (async () => { sent++; return new Response(JSON.stringify(ok), { status: 200 }); }) as typeof fetch;
  for (const origin of ["http://registrar.example", "http://10.0.0.5:8787", "ftp://registrar.example", "not a url"]) {
    await assert.rejects(
      claimName({ name: "colin", port: 9393, identity, origin, github: "ghu_token", fetchImpl }),
      (error: ClaimError) => error.code === "insecure-registrar" && !error.message.includes("ghu_token"),
      origin,
    );
  }
  assert.equal(sent, 0, "nothing was sent");
  for (const origin of ["https://registrar.example", "http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) {
    await claimName({ name: "colin", port: 9393, identity, origin, github: "ghu_token", fetchImpl });
  }
  assert.equal(sent, 4);
  // A renewal carries no token, so a self-hoster's plain-http registrar still renews.
  await claimName({ name: "colin", port: 9393, identity, origin: "http://registrar.example", fetchImpl });
  assert.equal(sent, 5);
});

test("a redirect from the registrar is not followed, so the token is not re-sent elsewhere", async () => {
  const elsewhere = await registrar(() => ({ status: 200, body: ok }));
  const redirecting: Server = createServer((_req, res) => {
    res.writeHead(307, { location: `${elsewhere.origin}/claim` });
    res.end();
  });
  redirecting.listen(0, "127.0.0.1");
  await once(redirecting, "listening");
  try {
    const identity = await generateClaimIdentity();
    const origin = `http://127.0.0.1:${(redirecting.address() as { port: number }).port}`;
    await assert.rejects(claimName({ name: "colin", port: 9393, identity, origin, github: "ghu_token" }), (error: ClaimError) => error.code === "http-307");
    assert.equal(elsewhere.seen.length, 0, "the redirect target never saw the claim");
  } finally {
    redirecting.close();
    await once(redirecting, "close");
    await elsewhere.close();
  }
});

test("Frizz's own registrar must answer with the name asked for, in its zone, and no tunnel token", async () => {
  // A hostile or hijacked registrar used to send a board to any host, or hand it a tunnel token whose routes
  // it wrote (security review 2, finding 8).
  const identity = await generateClaimIdentity();
  const answering = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  for (const hostname of ["relay.attacker.example", "colin.frizz.sh.attacker.example", "other.frizz.sh", "colin.frizz.sh."]) {
    await assert.rejects(
      claimName({ name: "colin", port: 9393, identity, origin: DEFAULT_REGISTRAR, fetchImpl: answering({ hostname, leaseExpiresAt: 1, renewed: true }) }),
      (error: ClaimError) => error.code === "malformed-response",
      hostname,
    );
  }
  const result = await claimName({
    name: "colin",
    port: 9393,
    identity,
    origin: DEFAULT_REGISTRAR,
    fetchImpl: answering({ hostname: "colin.frizz.sh", token: "their-tunnel", leaseExpiresAt: 1, renewed: false }),
  });
  assert.deepEqual(result, { hostname: "colin.frizz.sh", leaseExpiresAt: 1, renewed: false }, "the control: a right answer passes, without the token");
  // A registrar the operator pointed at is theirs to trust, but it still answers for the name asked.
  await assert.rejects(
    claimName({ name: "colin", port: 9393, identity, origin: "https://mine.example", fetchImpl: answering({ hostname: "other.mine.example", leaseExpiresAt: 1, renewed: true }) }),
    (error: ClaimError) => error.code === "malformed-response",
  );
  const own = await claimName({ name: "colin", port: 9393, identity, origin: "https://mine.example", fetchImpl: answering({ hostname: "colin.mine.example", token: "t", leaseExpiresAt: 1, renewed: true }) });
  assert.equal(own.token, "t");
});

test("a refusal's own words reach the terminal without control characters", async () => {
  const identity = await generateClaimIdentity();
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: "something-new", message: "\u001b]0;pwned\u0007\u001b[2Jcleared \u009b31mred" }), { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(claimName({ name: "colin", port: 9393, identity, origin: DEFAULT_REGISTRAR, fetchImpl }), (error: ClaimError) => {
    assert.equal(error.message, "]0;pwned[2Jcleared 31mred");
    assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f-\u009f]/);
    return true;
  });
});
