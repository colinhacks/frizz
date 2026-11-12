import assert from "node:assert/strict"
import test from "node:test"
import { deriveAnonymousClaimName, exportClaimPublicKey, generateClaimIdentity, signClaim } from "@frizz/shared"
import worker, { budgetAddress, claimBudgets, githubVerifier, kvClaimStore, type KvNamespace, type RegistrarEnv } from "./worker.ts"
import { handleClaim } from "./claim-handler.ts"
import { importFromKv, withClaimLock, RegistrarBusy, type D1Database } from "./claim-db.ts"
import { fakeD1 } from "./fake-d1.ts"

/** One of this key's own random names, the only kind a NEW random claim may take (2026-11-12). */
async function ownRandom(identity: CryptoKeyPair, index = 0) {
  return deriveAnonymousClaimName(await exportClaimPublicKey(identity.publicKey), index)
}

/** A budget row's count in the fake D1, or 0. */
function budgetUsed(db: ReturnType<typeof fakeD1>, key: string): number {
  return Number((db.sqlite.prepare("SELECT used FROM budgets WHERE key = ?").get(key) as { used?: number } | undefined)?.used ?? 0)
}

function seedBudget(db: ReturnType<typeof fakeD1>, key: string, used: number) {
  db.sqlite.exec("CREATE TABLE IF NOT EXISTS budgets (key TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL)")
  db.sqlite.prepare("INSERT INTO budgets (key, used, expires_at) VALUES (?, ?, ?)").run(key, used, Date.now() + 7_200_000)
}

function fakeKv(seed: Record<string, string> = {}, latencyMs = 0): KvNamespace & { rows: Map<string, string>; ttls: Map<string, number | undefined> } {
  const rows = new Map(Object.entries(seed))
  const ttls = new Map<string, number | undefined>()
  const tick = () => (latencyMs ? new Promise<void>((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve())
  return {
    rows,
    ttls,
    async get(key) {
      await tick()
      return rows.get(key) ?? null
    },
    async put(key, value, options) {
      await tick()
      rows.set(key, value)
      ttls.set(key, options?.expirationTtl)
    },
    async delete(key) {
      await tick()
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

function env(kv: KvNamespace, db: D1Database = fakeD1()): RegistrarEnv {
  return {
    CLAIMS_DB: db,
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
  const db = fakeD1()
  const identity = await generateClaimIdentity()
  const name = await ownRandom(identity)
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify(await signClaim({ name, port: 9393, issuedAt: Date.now() }, identity)),
    }),
    env(kv, db)
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as { hostname: string }
  assert.equal(body.hostname, `${name}.frizz.sh`)
  assert.ok(kv.rows.has(`claim:${name}`), "the claim row was copied to KV, where the relay reads it")
  assert.ok(db.sqlite.prepare("SELECT 1 FROM claims WHERE name = ?").get(name), "and written to D1, which is the registry")
  const hour = Math.floor(Date.now() / 3_600_000)
  assert.equal(budgetUsed(db, `anonrl:203.0.113.7:${hour}`), 1, "the network's budget was spent")
  assert.equal(budgetUsed(db, `new-names:${hour}`), 1, "and so was one of the hour's new names")
})

test("the anonymous budget allows ten an hour and then refuses, and a new hour starts again", async () => {
  const db = fakeD1()
  const { ensureSchema } = await import("./claim-db.ts")
  await ensureSchema(db)
  const budget = claimBudgets(db, "203.0.113.7", {}, () => 1_800_000_000_000).anonymousBudget
  for (let i = 0; i < 10; i++) assert.equal(await budget(), true, `claim ${i + 1} fits the budget`)
  assert.equal(await budget(), false, "the eleventh does not")
  assert.equal(budgetUsed(db, `anonrl:203.0.113.7:${Math.floor(1_800_000_000_000 / 3_600_000)}`), 10)
  const later = claimBudgets(db, "203.0.113.7", {}, () => 1_800_000_000_000 + 3_600_000).anonymousBudget
  assert.equal(await later(), true)
  // The new-names ceiling takes its size from the env, so raising it needs no deploy.
  const small = claimBudgets(db, "x", { NEW_NAMES_PER_HOUR: "2" }, () => 1_800_000_000_000).newNameBudget
  assert.deepEqual([await small(), await small(), await small()], [true, true, false])
})

test("custom claims from one address spend a GitHub-lookup budget, and past it GitHub is not asked", async () => {
  const hour = Math.floor(Date.now() / 3_600_000)
  const kv = fakeKv()
  const db = fakeD1()
  seedBudget(db, `ghrl:198.51.100.9:${hour}`, 10)
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
        env(kv, db)
      )
    const over = await claim("198.51.100.9")
    assert.equal(over.status, 429)
    assert.equal(((await over.json()) as { error: string }).error, "too-many-claims")
    assert.equal(asked, 0, "GitHub was not asked")
    // Another address has its own budget, and spends it.
    assert.equal((await claim("203.0.113.7")).status, 400)
    assert.equal(asked, 1)
    assert.equal(budgetUsed(db, `ghrl:203.0.113.7:${hour}`), 1)
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
  const kv = fakeKv()
  const db = fakeD1()
  seedBudget(db, `anonrl:198.51.100.9:${hour}`, 10)
  const identity = await generateClaimIdentity()
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.9" },
      body: JSON.stringify(
        await signClaim({ name: await ownRandom(identity), port: 9393, issuedAt: Date.now() }, identity)
      ),
    }),
    env(kv, db)
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
  const db = fakeD1()
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
          body: JSON.stringify(await signClaim({ name: "ada", port: 9393, issuedAt: Date.now(), github: token }, identity)),
        }),
        env(kv, db)
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
    assert.equal(JSON.parse(kv.rows.get("claim:ada")!).githubId, 4242)
    assert.equal((db.sqlite.prepare("SELECT name FROM accounts WHERE github_id = 4242").get() as { name?: string } | undefined)?.name, "ada", "the one-name-per-account index is kept")
    const stored = JSON.stringify([...kv.rows.entries()]) + JSON.stringify(db.sqlite.prepare("SELECT * FROM accounts, claims").all())
    assert.equal(stored.includes("ghu_") || stored.includes("gho_"), false, "no token is stored")
    assert.deepEqual(shown, ["Bearer gho_ghcli", "Bearer ghu_agentconsole"])
  } finally {
    globalThis.fetch = realFetch
  }
})

test("without its database the registrar takes no claims, rather than racing in KV", async () => {
  const kv = fakeKv()
  const identity = await generateClaimIdentity()
  const { CLAIMS_DB: _, ...withoutDb } = env(kv)
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", { method: "POST", body: JSON.stringify(await signClaim({ name: await ownRandom(identity), port: 9393, issuedAt: Date.now() }, identity)) }),
    withoutDb
  )
  assert.equal(response.status, 503)
  assert.equal(((await response.json()) as { error: string }).error, "registrar-busy")
  assert.equal(kv.rows.size, 0)
})

/** Two custom names claimed at once by ONE key, each with a different account's token, as GitHub answers them. */
async function racePair(store: "kv" | "d1") {
  const identity = await generateClaimIdentity()
  const year = new Date(Date.now() - 365 * 86_400_000).toISOString()
  const accounts: Record<string, { id: number; login: string }> = { ghu_ada: { id: 1, login: "ada" }, ghu_bob: { id: 2, login: "bob" } }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const token = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length)
    // GitHub takes a moment, which is the window two claims race in.
    await new Promise((resolve) => setTimeout(resolve, 20))
    return new Response(JSON.stringify({ ...accounts[token], created_at: year }), { headers: { "x-oauth-client-id": "Iv23licDruV3JtQIF3fI" } })
  }) as typeof fetch
  try {
    const kv = fakeKv({}, 3)
    const db = fakeD1({ latencyMs: 3 })
    const bodies = await Promise.all(
      [["ada", "ghu_ada"], ["bob", "ghu_bob"]].map(async ([name, github]) => signClaim({ name: name!, port: 9393, issuedAt: Date.now(), github: github! }, identity))
    )
    if (store === "kv") {
      // The registry as it was before 2026-11-12: KV alone, no lock. The negative control.
      const { githubVerifier: verifier } = await import("./worker.ts")
      const deps = { store: kvClaimStore(kv), zone: "frizz.sh", now: () => Date.now(), github: verifier() }
      return await Promise.all(bodies.map((body) => handleClaim(body, deps).then((outcome) => outcome.status)))
    }
    return await Promise.all(
      bodies.map((body) => worker.fetch(new Request("https://r.frizz.sh/claim", { method: "POST", body: JSON.stringify(body) }), env(kv, db)).then((r) => r.status))
    )
  } finally {
    globalThis.fetch = realFetch
  }
}

test("one key claiming two custom names at once gets one, where KV alone gave it both", async () => {
  // plans/frizz-sh-claim-review-2026-11-07.md M1: both claims read the key's index as empty, and both won.
  assert.deepEqual((await racePair("kv")).sort(), [200, 200], "the harness can show the race: without the lock both win")
  assert.deepEqual((await racePair("d1")).sort(), [200, 409], "behind the lock the second sees the first")
})

test("twenty claims at once from one network spend its budget of ten exactly", async () => {
  const kv = fakeKv({}, 2)
  const db = fakeD1({ latencyMs: 2 })
  const identities = await Promise.all(Array.from({ length: 20 }, () => generateClaimIdentity()))
  const statuses = await Promise.all(
    identities.map(async (identity) =>
      worker
        .fetch(
          new Request("https://r.frizz.sh/claim", {
            method: "POST",
            headers: { "cf-connecting-ip": "198.51.100.20" },
            body: JSON.stringify(await signClaim({ name: await ownRandom(identity), port: 9393, issuedAt: Date.now() }, identity)),
          }),
          env(kv, db)
        )
        .then((r) => r.status)
    )
  )
  assert.equal(statuses.filter((s) => s === 200).length, 10)
  assert.equal(statuses.filter((s) => s === 429).length, 10)
  assert.equal([...kv.rows.keys()].filter((k) => k.startsWith("claim:")).length, 10)
})

test("the lock lets one holder in at a time, frees itself after its lease, and frees only its own hold", async () => {
  const db = fakeD1()
  let clock = 1_000
  const now = () => clock
  const sleep = async (ms: number) => void (clock += ms)
  let inside = 0
  let most = 0
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      withClaimLock(db, async () => {
        inside++
        most = Math.max(most, inside)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inside--
        return i
      }, { now: Date.now })
    )
  )
  assert.equal(most, 1, "never two holders at once")

  // A holder that died mid-claim (its finally never ran) is waited out, then replaced.
  db.sqlite.prepare("UPDATE lock SET holder = 'dead', expires_at = ? WHERE id = 1").run(clock + 30_000)
  assert.equal(await withClaimLock(db, async () => "next", { now, sleep, waitMs: 60_000 }), "next")
  assert.ok(clock >= 31_000, "it waited for the lease")
  // A holder that never frees in time leaves the claim answered "busy".
  db.sqlite.prepare("UPDATE lock SET holder = 'slow', expires_at = ? WHERE id = 1").run(clock + 30_000)
  await assert.rejects(withClaimLock(db, async () => "never", { now, sleep, waitMs: 5_000 }), RegistrarBusy)
  assert.equal((db.sqlite.prepare("SELECT holder FROM lock").get() as { holder: string }).holder, "slow", "and does not free a hold that is not its own")
})

test("the registry KV held is copied into D1 once, and the relay's rows stay where it reads them", async () => {
  const owner = await generateClaimIdentity()
  const pubkey = await exportClaimPublicKey(owner.publicKey)
  const row = JSON.stringify({ pubkey, tunnelId: "", port: 9393, claimedAt: 1, renewedAt: Date.now(), githubId: 7 })
  const kv = fakeKv({ "claim:colin": row, [`owner:${pubkey}`]: "colin", "gh:7": "colin", "retired:abcdefghijklmnopqrst": "someone" })
  const db = fakeD1()
  // A renewal by the name's key through the worker: the import runs first, and the renewal finds the row.
  const renewed = await worker.fetch(
    new Request("https://r.frizz.sh/claim", { method: "POST", body: JSON.stringify(await signClaim({ name: "colin", port: 9494, issuedAt: Date.now() }, owner)) }),
    env(kv, db)
  )
  assert.equal(renewed.status, 200)
  assert.equal(((await renewed.json()) as { renewed: boolean }).renewed, true)
  assert.equal((db.sqlite.prepare("SELECT name FROM accounts WHERE github_id = 7").get() as { name: string }).name, "colin")
  assert.equal((db.sqlite.prepare("SELECT pubkey FROM retired WHERE name = 'abcdefghijklmnopqrst'").get() as { pubkey: string }).pubkey, "someone")
  assert.equal(JSON.parse(kv.rows.get("claim:colin")!).port, 9494, "the relay's copy follows the renewal")
  // Once imported, never again: a KV row added later is not the registry.
  kv.rows.set("claim:late", row)
  assert.equal(await importFromKv(db, kv), 0)
  assert.equal(db.sqlite.prepare("SELECT 1 FROM claims WHERE name = 'late'").get(), undefined)
})

test("a claim keeps running when its caller hangs up, so it is never left half-written", async () => {
  const kv = fakeKv()
  const identity = await generateClaimIdentity()
  const kept: Promise<unknown>[] = []
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", { method: "POST", body: JSON.stringify(await signClaim({ name: await ownRandom(identity), port: 9393, issuedAt: Date.now() }, identity)) }),
    env(kv),
    { waitUntil: (promise) => void kept.push(promise) }
  )
  assert.equal(response.status, 200)
  assert.equal(kept.length, 1, "the claim was handed to waitUntil")
})
