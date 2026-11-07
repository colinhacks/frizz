import assert from "node:assert/strict"
import test from "node:test"
import { generateAnonymousClaimName, generateClaimIdentity, signClaim } from "@frizz/shared"
import worker, { budgetAddress, githubVerifier, kvAnonymousBudget, kvClaimStore, type KvNamespace, type RegistrarEnv } from "./worker.ts"

function fakeKv(seed: Record<string, string> = {}): KvNamespace & { rows: Map<string, string>; ttls: Map<string, number | undefined> } {
  const rows = new Map(Object.entries(seed))
  const ttls = new Map<string, number | undefined>()
  return {
    rows,
    ttls,
    async get(key) {
      return rows.get(key) ?? null
    },
    async put(key, value, options) {
      rows.set(key, value)
      ttls.set(key, options?.expirationTtl)
    },
    async delete(key) {
      rows.delete(key)
    },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...rows.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }
    },
  }
}

function env(kv: KvNamespace): RegistrarEnv {
  return {
    // Deliberately unusable: every test here must be rejected BEFORE anything reaches Cloudflare, so
    // a test that starts making real requests fails loudly rather than quietly calling out.
    CF_API_TOKEN: "not-a-real-token",
    CF_ACCOUNT_ID: "acct",
    CF_ZONE_ID: "zone",
    FRIZZ_ZONE: "frizz.sh",
    CLAIMS: kv,
  }
}

test("only POST /claim is routed", async () => {
  const kv = fakeKv()
  const notFound = await worker.fetch(new Request("https://r.frizz.sh/other", { method: "POST" }), env(kv))
  assert.equal(notFound.status, 404)

  const wrongMethod = await worker.fetch(new Request("https://r.frizz.sh/claim"), env(kv))
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get("allow"), "POST")
})

test("GET /claim/<name> says who owns a name, and nothing else about it", async () => {
  const row = { pubkey: "owner-key", tunnelId: "", port: 9393, claimedAt: 1, renewedAt: 2, githubId: 77 }
  const kv = fakeKv({ "claim:colin": JSON.stringify(row) })
  const owned = await worker.fetch(new Request("https://r.frizz.sh/claim/colin"), env(kv))
  assert.equal(owned.status, 200)
  assert.deepEqual(await owned.json(), { pubkey: "owner-key", renewedAt: 2 })

  const free = await worker.fetch(new Request("https://r.frizz.sh/claim/free"), env(kv))
  assert.equal(free.status, 404)

  const writing = await worker.fetch(new Request("https://r.frizz.sh/claim/colin", { method: "POST" }), env(kv))
  assert.equal(writing.status, 405)
  assert.equal(writing.headers.get("allow"), "GET")

  const otherKey = await worker.fetch(new Request("https://r.frizz.sh/claim/owner%3Akey"), env(kv))
  assert.equal(otherKey.status, 404)
})

test("a body that is not JSON is a 400, not a crash", async () => {
  const kv = fakeKv()
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", { method: "POST", body: "{not json" }),
    env(kv)
  )
  assert.equal(response.status, 400)
  assert.equal(response.headers.get("cache-control"), "no-store")
  const body = (await response.json()) as { error: string }
  assert.equal(typeof body.error, "string")
})

test("an unsigned claim is refused without a Cloudflare token ever being used", async () => {
  // The token in env is junk, so if this reached Cloudflare the test would fail on a network error
  // rather than pass. That is the point: rejection has to happen first.
  const kv = fakeKv()
  const identity = await generateClaimIdentity()
  const valid = await signClaim({ name: "colin", port: 9393, issuedAt: Date.now() }, identity)
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", {
      method: "POST",
      body: JSON.stringify({ ...valid, name: "someone-else" }),
    }),
    env(kv)
  )
  assert.equal(response.status, 400)
  assert.equal(kv.rows.size, 0)
})

test("the KV store round-trips a record", async () => {
  const kv = fakeKv()
  const store = kvClaimStore(kv)
  const record = { pubkey: "k", tunnelId: "t", port: 9393, claimedAt: 1, renewedAt: 2 }
  await store.write("colin", record)
  assert.deepEqual(await store.read("colin"), record)
  await store.remove("colin")
  assert.equal(await store.read("colin"), null)
})

test("an unparseable KV row reads as absent, so one bad row cannot strand a name forever", async () => {
  const store = kvClaimStore(fakeKv({ "claim:colin": "{{{" }))
  assert.equal(await store.read("colin"), null)
})

test("the owner index round-trips under its own prefix", async () => {
  const kv = fakeKv()
  const store = kvClaimStore(kv)
  await store.writeOwner("pubkey-a", "colin")
  assert.equal(await store.readOwner("pubkey-a"), "colin")
  // It must not show up as a claimed NAME, or the sweeper would try to release a public key.
  assert.deepEqual(await store.list(), [])
  await store.removeOwner("pubkey-a")
  assert.equal(await store.readOwner("pubkey-a"), null)
})

test("listing strips the key prefix and ignores anything that is not a claim", async () => {
  // The sweeper works from this list, so a prefix left on a name would build a hostname like
  // `claim:colin.frizz.sh` and delete nothing that exists.
  const store = kvClaimStore(fakeKv({ "claim:colin": "{}", "claim:ada": "{}", "other:thing": "{}" }))
  assert.deepEqual((await store.list()).sort(), ["ada", "colin"])
})

test("an anonymous claim goes through the worker with no GitHub anywhere near it", async () => {
  // The gate is ON in this env (REQUIRE_GITHUB is unset) and relay mode records the name in KV alone,
  // so a 200 here proves the whole auth-free path: shape recognised, gate waived, nothing provisioned.
  const kv = fakeKv()
  const identity = await generateClaimIdentity()
  const name = generateAnonymousClaimName()
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify(await signClaim({ name, port: 9393, issuedAt: Date.now() }, identity)),
    }),
    env(kv)
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as { hostname: string }
  assert.equal(body.hostname, `${name}.frizz.sh`)
  assert.ok(kv.rows.has(`claim:${name}`), "the claim row was written")
  assert.equal(kv.rows.get("anonrl:203.0.113.7:" + Math.floor(Date.now() / 3_600_000)), "1", "the budget was spent")
})

test("the anonymous budget allows ten an hour and then refuses, on a row that expires itself", async () => {
  const kv = fakeKv()
  const budget = kvAnonymousBudget(kv, "203.0.113.7", () => 1_800_000_000_000)
  for (let i = 0; i < 10; i++) assert.equal(await budget(), true, `claim ${i + 1} fits the budget`)
  assert.equal(await budget(), false, "the eleventh does not")
  const key = `anonrl:203.0.113.7:${Math.floor(1_800_000_000_000 / 3_600_000)}`
  assert.equal(kv.rows.get(key), "10")
  assert.equal(kv.ttls.get(key), 7_200, "the counter cleans itself up")
  // A new hour is a new bucket: the budget refreshes without anything sweeping the old row.
  const later = kvAnonymousBudget(kv, "203.0.113.7", () => 1_800_000_000_000 + 3_600_000)
  assert.equal(await later(), true)
})

test("custom claims from one address spend a GitHub-lookup budget, and past it GitHub is not asked", async () => {
  const hour = Math.floor(Date.now() / 3_600_000)
  const kv = fakeKv({ [`ghrl:198.51.100.9:${hour}`]: "10" })
  const identity = await generateClaimIdentity()
  const realFetch = globalThis.fetch
  let asked = 0
  globalThis.fetch = (async () => { asked++; return new Response("{}", { status: 401 }) }) as typeof fetch
  try {
    const claim = async (address: string) =>
      worker.fetch(
        new Request("https://r.frizz.sh/claim", {
          method: "POST",
          headers: { "cf-connecting-ip": address },
          body: JSON.stringify(await signClaim({ name: "colin", port: 9393, issuedAt: Date.now(), github: "ghu_madeup" }, identity)),
        }),
        env(kv)
      )
    const over = await claim("198.51.100.9")
    assert.equal(over.status, 429)
    assert.equal(((await over.json()) as { error: string }).error, "too-many-claims")
    assert.equal(asked, 0, "GitHub was not asked")
    // Another address has its own budget, and spends it.
    assert.equal((await claim("203.0.113.7")).status, 400)
    assert.equal(asked, 1)
    assert.equal(kv.rows.get(`ghrl:203.0.113.7:${hour}`), "1")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("an IPv6 address is budgeted by its /64, so rotating through the block is one budget", () => {
  assert.equal(budgetAddress("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd"), "2001:db8:1234:5678::/64")
  assert.equal(budgetAddress("2001:0DB8:1234:5678:1::2"), "2001:db8:1234:5678::/64", "one /64 however it is written")
  assert.equal(budgetAddress("2001:db8::1"), "2001:db8:0:0::/64")
  assert.equal(budgetAddress("::1"), "0:0:0:0::/64")
  assert.equal(budgetAddress("203.0.113.7"), "203.0.113.7", "IPv4 is kept whole")
  assert.equal(budgetAddress("unknown"), "unknown")
})

test("a chunked body is cut off at the cap rather than read whole", async () => {
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++
      if (pulled > 1_000) return controller.close()
      controller.enqueue(new Uint8Array(1_024).fill(120))
    },
  })
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", { method: "POST", body: stream, duplex: "half" } as RequestInit),
    env(fakeKv())
  )
  assert.equal(response.status, 413)
  assert.ok(pulled < 20, `stopped after ${pulled} chunks of 1 KiB, not 1,000`)
})

test("a GitHub answer with no readable creation date is no account, not an old one", async () => {
  const api = fakeGithubApi(APP, "", { id: 4242, login: "ada" })
  assert.equal(await githubVerifier(api.fetchImpl)("ghu_agentconsole"), null)
})

test("a body far bigger than a claim is refused unread", async () => {
  const kv = fakeKv()
  const big = JSON.stringify({ padding: "x".repeat(20_000) })
  const response = await worker.fetch(new Request("https://r.frizz.sh/claim", { method: "POST", body: big }), env(kv))
  assert.equal(response.status, 413)
  assert.equal(kv.rows.size, 0)
})

test("an over-budget anonymous claim is a 429 through the worker, naming the wait", async () => {
  const hour = Math.floor(Date.now() / 3_600_000)
  const kv = fakeKv({ [`anonrl:198.51.100.9:${hour}`]: "10" })
  const identity = await generateClaimIdentity()
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.9" },
      body: JSON.stringify(
        await signClaim({ name: generateAnonymousClaimName(), port: 9393, issuedAt: Date.now() }, identity)
      ),
    }),
    env(kv)
  )
  assert.equal(response.status, 429)
  const body = (await response.json()) as { error: string }
  assert.equal(body.error, "too-many-claims")
  assert.equal([...kv.rows.keys()].filter((k) => k.startsWith("claim:")).length, 0, "nothing was recorded")
})

/**
 * GitHub's `GET /user`, faked: answers for one token, with whatever `X-OAuth-Client-Id` and
 * `X-OAuth-Scopes` the case needs (`null` leaves a header off). Records every token it was shown.
 */
const APP = "Iv23licDruV3JtQIF3fI"
function fakeGithubApi(
  clientId: string | null,
  scopes: string | null = "",
  user: Record<string, unknown> = { id: 4242, login: "ada", created_at: "2020-01-01T00:00:00Z" }
) {
  const seen: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    assert.equal(url, "https://api.github.com/user")
    assert.equal(init?.redirect, "manual", "a redirect is never followed with the token")
    seen.push(new Headers(init?.headers).get("authorization") ?? "")
    return new Response(JSON.stringify(user), {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...(clientId === null ? {} : { "x-oauth-client-id": clientId }),
        ...(scopes === null ? {} : { "x-oauth-scopes": scopes }),
      },
    })
  }) as typeof fetch
  return { fetchImpl, seen }
}

test("the user token of Frizz's GitHub App is accepted", async () => {
  // What the board's own GitHub sign-in holds. Asked of the real api.github.com on 2026-11-07, a
  // `ghu_` token answered with `x-oauth-client-id: Iv23licDruV3JtQIF3fI` and an empty X-OAuth-Scopes.
  const app = fakeGithubApi(APP)
  assert.deepEqual(await githubVerifier(app.fetchImpl)("ghu_agentconsole"), { id: 4242, login: "ada", createdAt: Date.parse("2020-01-01T00:00:00Z") })
  assert.deepEqual(app.seen, ["Bearer ghu_agentconsole"])
})

test("any token GitHub does not report as issued to Frizz's App is refused as foreign", async () => {
  // The `gh` CLI's token (what an old Frizz sends, and what a compromised registrar collected), another
  // app's token, a zero-scope OAuth token from someone's own app, and a personal access token, which
  // GitHub ties to no app at all.
  const cases: Array<[string, string | null, string | null]> = [
    ["gho_ghcli", "178c6fc778ccc68e1d6a", "gist, read:org, repo, workflow"],
    ["ghu_otherapp", "Iv23someOtherAppId00", ""],
    ["gho_zero", "Ov23someOAuthApp0000", ""],
    ["github_pat_11ABC_def", null, null],
    ["ghp_classic", null, ""],
  ]
  for (const [token, clientId, scopes] of cases) {
    assert.equal(await githubVerifier(fakeGithubApi(clientId, scopes).fetchImpl)(token), "foreign", token)
  }
  // A self-hosted registrar can name its own App instead.
  assert.equal(typeof (await githubVerifier(fakeGithubApi("Iv23fork").fetchImpl, "https://api.github.com", "Iv23fork")("ghu_fork")), "object")
})

test("a value that cannot be a token is rejected before GitHub is asked anything", async () => {
  for (const token of ["not a token", "ghu_x\r\nx-injected: 1", "", `ghu_${"a".repeat(600)}`]) {
    const api = fakeGithubApi(APP)
    assert.equal(await githubVerifier(api.fetchImpl)(token), null, JSON.stringify(token.slice(0, 20)))
    assert.deepEqual(api.seen, [], "never reached GitHub")
  }
})

test("a token GitHub refuses is rejected, not refused as foreign", async () => {
  const fetchImpl = (async () => new Response("{}", { status: 401 })) as typeof fetch
  assert.equal(await githubVerifier(fetchImpl)("gho_revoked"), null)
})

test("through the worker, a foreign token is refused with advice to update, and the App's token claims", async () => {
  // The worker's own wiring: claimDeps hands the real verifier the global fetch, faked here as GitHub.
  const kv = fakeKv()
  const identity = await generateClaimIdentity()
  const realFetch = globalThis.fetch
  let clientId = "178c6fc778ccc68e1d6a"
  const shown: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    shown.push(new Headers(init?.headers).get("authorization") ?? "")
    return fakeGithubApi(clientId).fetchImpl(input, init)
  }) as typeof fetch
  try {
    const claim = async (token: string) =>
      worker.fetch(
        new Request("https://r.frizz.sh/claim", {
          method: "POST",
          body: JSON.stringify(await signClaim({ name: "colin", port: 9393, issuedAt: Date.now(), github: token }, identity)),
        }),
        env(kv)
      )
    const refused = await claim("gho_ghcli")
    assert.equal(refused.status, 400)
    const body = (await refused.json()) as { error: string; message: string }
    assert.equal(body.error, "github-token-foreign")
    assert.match(body.message, /update Frizz/)
    assert.match(body.message, /Settings/, "and says where the sign-in a claim takes now lives")
    assert.deepEqual([...kv.rows.keys()].filter((key) => !key.startsWith("ghrl:")), [], "nothing was recorded for the foreign token")

    clientId = APP
    const accepted = await claim("ghu_agentconsole")
    assert.equal(accepted.status, 200)
    assert.equal(JSON.parse(kv.rows.get("claim:colin")!).githubId, 4242)
    assert.equal(kv.rows.get("gh:4242"), "colin", "the one-name-per-account index is kept")
    const stored = JSON.stringify([...kv.rows.entries()])
    assert.equal(stored.includes("ghu_") || stored.includes("gho_"), false, "no token is stored")
    assert.deepEqual(shown, ["Bearer gho_ghcli", "Bearer ghu_agentconsole"])
  } finally {
    globalThis.fetch = realFetch
  }
})
