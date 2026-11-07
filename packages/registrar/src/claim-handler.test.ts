import assert from "node:assert/strict"
import test from "node:test"
import { CLAIM_LEASE_MS, generateAnonymousClaimName, generateClaimIdentity, signClaim } from "@frizz/shared"
import { handleClaim, sweepExpiredClaims, type ClaimDeps, type ClaimRecord } from "./claim-handler.ts"

const NOW = 1_800_000_000_000
const ZONE = "frizz.sh"

/** A Cloudflare that records what it was asked to do, and can be told to fail any single step. */
function fakeCloudflare(
  failAt?: "createTunnel" | "setTunnelIngress" | "upsertDnsRecord" | "tunnelToken" | "deleteTunnel"
) {
  const calls: string[] = []
  const tunnels = new Map<string, string>()
  const dns = new Map<string, string>()
  let nextId = 1
  const maybeFail = (step: string) => {
    calls.push(step)
    if (failAt && step.startsWith(failAt)) throw new Error(`${step} failed`)
  }
  return {
    calls,
    tunnels,
    dns,
    api: {
      async findTunnel(name: string) {
        calls.push(`findTunnel:${name}`)
        for (const [id, tunnelName] of tunnels) if (tunnelName === name) return { id }
        return null
      },
      async createTunnel(name: string) {
        maybeFail(`createTunnel:${name}`)
        // Cloudflare refuses a duplicate tunnel name with error 1013, so the fake must too — the
        // orphan-reclaim path exists precisely because of that refusal.
        for (const existing of tunnels.values()) {
          if (existing === name) throw new Error("1013 You already have a tunnel with this name")
        }
        const id = `tunnel-${nextId++}`
        tunnels.set(id, name)
        return { id, token: `run-token-for-${id}` }
      },
      async tunnelToken(id: string) {
        maybeFail(`tunnelToken:${id}`)
        return `run-token-for-${id}`
      },
      async setTunnelIngress(id: string, hostname: string, service: string) {
        maybeFail(`setTunnelIngress:${id}:${hostname}:${service}`)
      },
      async upsertDnsRecord(hostname: string, target: string) {
        maybeFail(`upsertDnsRecord:${hostname}:${target}`)
        dns.set(hostname, target)
      },
      async deleteTunnel(id: string) {
        calls.push(`deleteTunnel:${id}`)
        if (failAt === "deleteTunnel") throw new Error("deleteTunnel failed")
        tunnels.delete(id)
      },
      async deleteDnsRecord(hostname: string) {
        calls.push(`deleteDnsRecord:${hostname}`)
        dns.delete(hostname)
      },
    },
  }
}

function fakeStore(seed: Record<string, ClaimRecord> = {}) {
  const rows = new Map<string, ClaimRecord>(Object.entries(seed))
  const owners = new Map<string, string>()
  const githubOwners = new Map<number, string>()
  for (const [name, record] of rows) owners.set(record.pubkey, name)
  return {
    rows,
    owners,
    githubOwners,
    store: {
      async read(name: string) {
        return rows.get(name) ?? null
      },
      async write(name: string, record: ClaimRecord) {
        rows.set(name, record)
      },
      async remove(name: string) {
        rows.delete(name)
      },
      async list() {
        return [...rows.keys()]
      },
      async readOwner(pubkey: string) {
        return owners.get(pubkey) ?? null
      },
      async writeOwner(pubkey: string, name: string) {
        owners.set(pubkey, name)
      },
      async removeOwner(pubkey: string) {
        owners.delete(pubkey)
      },
      async readGithubOwner(id: number) {
        return githubOwners.get(id) ?? null
      },
      async writeGithubOwner(id: number, name: string) {
        githubOwners.set(id, name)
      },
      async removeGithubOwner(id: number) {
        githubOwners.delete(id)
      },
    },
  }
}

function deps(overrides: Partial<ClaimDeps> = {}): ClaimDeps {
  return {
    api: fakeCloudflare().api,
    store: fakeStore().store,
    zone: ZONE,
    now: () => NOW,
    ...overrides,
  }
}

async function claimFor(identity: CryptoKeyPair, name = "colin", port = 9393, issuedAt = NOW) {
  return signClaim({ name, port, issuedAt }, identity)
}

test("a first claim provisions the tunnel, the ingress and the DNS record, and returns only the run token", async () => {
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const result = await handleClaim(await claimFor(identity), deps({ api: cf.api, store: st.store }))

  assert.equal(result.status, 200)
  assert.ok("token" in result.body)
  assert.equal(result.body.hostname, "colin.frizz.sh")
  assert.equal(result.body.renewed, false)
  assert.equal(result.body.leaseExpiresAt, NOW + CLAIM_LEASE_MS)

  assert.deepEqual(cf.calls, [
    "findTunnel:u-colin",
    "createTunnel:u-colin",
    "setTunnelIngress:tunnel-1:colin.frizz.sh:http://localhost:9393",
    "upsertDnsRecord:colin.frizz.sh:tunnel-1.cfargotunnel.com",
  ])
  assert.equal(cf.dns.get("colin.frizz.sh"), "tunnel-1.cfargotunnel.com")
  assert.equal(st.rows.get("colin")?.tunnelId, "tunnel-1")
})

test("the same key claiming again RENEWS rather than provisioning a second tunnel", async () => {
  // The CLI calls this on every launch. If it created a tunnel each time, the 1,000-tunnel account cap
  // would be reached by a single enthusiastic user.
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const d = deps({ api: cf.api, store: st.store })

  await handleClaim(await claimFor(identity), d)
  const before = cf.tunnels.size
  const again = await handleClaim(await claimFor(identity, "colin", 9393, NOW + 1000), {
    ...d,
    now: () => NOW + 1000,
  })

  assert.equal(again.status, 200)
  assert.ok("renewed" in again.body && again.body.renewed)
  assert.equal(cf.tunnels.size, before, "no second tunnel")
  assert.equal(st.rows.get("colin")?.renewedAt, NOW + 1000, "the lease moved forward")
  assert.equal(st.rows.get("colin")?.claimedAt, NOW, "but the original claim date did not")
})

test("a renewal on a new port re-points the ingress", async () => {
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const d = deps({ api: cf.api, store: st.store })

  await handleClaim(await claimFor(identity), d)
  cf.calls.length = 0
  await handleClaim(await claimFor(identity, "colin", 4321), d)

  assert.ok(
    cf.calls.includes("setTunnelIngress:tunnel-1:colin.frizz.sh:http://localhost:4321"),
    `ingress was not re-pointed: ${cf.calls.join(", ")}`
  )
  assert.equal(st.rows.get("colin")?.port, 4321)
})

test("a different key cannot take a name whose lease is still live", async () => {
  const cf = fakeCloudflare()
  const st = fakeStore()
  const owner = await generateClaimIdentity()
  const d = deps({ api: cf.api, store: st.store })
  await handleClaim(await claimFor(owner), d)

  const attacker = await generateClaimIdentity()
  const stolen = await handleClaim(await claimFor(attacker), d)
  assert.equal(stolen.status, 409)
  assert.deepEqual(stolen.body, {
    error: "name-taken",
    message: "that name belongs to someone else",
  })
  assert.equal(st.rows.get("colin")?.pubkey, (await claimFor(owner)).pubkey, "the owner is unchanged")
})

test("a lapsed lease returns the name to the pool, tearing the old one down first", async () => {
  const cf = fakeCloudflare()
  const st = fakeStore()
  const owner = await generateClaimIdentity()
  await handleClaim(await claimFor(owner), deps({ api: cf.api, store: st.store }))

  const later = NOW + CLAIM_LEASE_MS + 1
  const newcomer = await generateClaimIdentity()
  cf.calls.length = 0
  const taken = await handleClaim(
    await claimFor(newcomer, "colin", 9393, later),
    deps({ api: cf.api, store: st.store, now: () => later })
  )

  assert.equal(taken.status, 200)
  // The old tunnel and record must go BEFORE the new ones, or the account leaks a tunnel per handover.
  assert.ok(cf.calls.includes("deleteTunnel:tunnel-1"), `old tunnel not removed: ${cf.calls.join(", ")}`)
  assert.ok(cf.calls.includes("deleteDnsRecord:colin.frizz.sh"))
  assert.equal(cf.tunnels.has("tunnel-1"), false)
  assert.equal(st.rows.get("colin")?.pubkey, (await claimFor(newcomer)).pubkey)
})

test("a failure midway through provisioning leaves NOTHING behind", async () => {
  // Tunnels are capped at 1,000 per account, so leaking one on every failed claim is a countdown to
  // the product stopping. Each step is failed in turn and the account must come back clean.
  for (const step of ["setTunnelIngress", "upsertDnsRecord"] as const) {
    const cf = fakeCloudflare(step)
    const st = fakeStore()
    const identity = await generateClaimIdentity()
    const result = await handleClaim(await claimFor(identity), deps({ api: cf.api, store: st.store }))

    assert.equal(result.status, 502, step)
    assert.deepEqual(result.body, {
      error: "provisioning-failed",
      message: "the name could not be provisioned; nothing was left behind",
    })
    assert.equal(cf.tunnels.size, 0, `${step} leaked a tunnel`)
    assert.equal(cf.dns.size, 0, `${step} leaked a DNS record`)
    assert.equal(st.rows.size, 0, `${step} leaked a registry row`)
  }
})

test("a tunnel that cannot even be created reports failure without touching the registry", async () => {
  const cf = fakeCloudflare("createTunnel")
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const result = await handleClaim(await claimFor(identity), deps({ api: cf.api, store: st.store }))
  assert.equal(result.status, 502)
  assert.equal(st.rows.size, 0)
  assert.equal(cf.calls.filter((c) => c.startsWith("deleteTunnel")).length, 0, "nothing to unwind")
})

test("an unsigned, tampered or malformed body never reaches Cloudflare", async () => {
  // The handler is the only thing between an open endpoint and an API token that can write the zone.
  const identity = await generateClaimIdentity()
  const valid = await claimFor(identity)
  for (const body of [
    null,
    "nonsense",
    {},
    { ...valid, name: "someone-else" },
    { ...valid, sig: `${valid.sig.slice(0, -4)}AAAA` },
    { ...valid, port: 0 },
    { ...valid, issuedAt: NOW - CLAIM_LEASE_MS },
  ]) {
    const cf = fakeCloudflare()
    const st = fakeStore()
    const result = await handleClaim(body, deps({ api: cf.api, store: st.store }))
    assert.notEqual(result.status, 200, JSON.stringify(body)?.slice(0, 50))
    assert.deepEqual(cf.calls, [], "a rejected claim must not call Cloudflare at all")
    assert.equal(st.rows.size, 0)
  }
})

test("a renewal whose token cannot be re-read fails without disturbing the record", async () => {
  const st = fakeStore({
    colin: { pubkey: "", tunnelId: "tunnel-9", port: 9393, claimedAt: NOW, renewedAt: NOW },
  })
  const identity = await generateClaimIdentity()
  const request = await claimFor(identity)
  st.rows.set("colin", { ...st.rows.get("colin")!, pubkey: request.pubkey })

  const cf = fakeCloudflare("tunnelToken")
  const result = await handleClaim(request, deps({ api: cf.api, store: st.store }))

  assert.equal(result.status, 502)
  assert.equal(st.rows.get("colin")?.renewedAt, NOW, "the lease was not advanced by a failed renewal")
})


test("the sweeper returns lapsed names to the pool, and leaves live ones alone", async () => {
  // The gap this closes: handleClaim only releases a lapsed name when somebody asks for THAT name, so
  // a name nobody wants again would hold its DNS record and tunnel forever — against caps of 200 and
  // 1,000, which is what would eventually stop new signups with nothing pointing at the cause.
  const cf = fakeCloudflare()
  const later = NOW + CLAIM_LEASE_MS + 1
  const st = fakeStore({
    // Renewed just now, so its lease is nowhere near the horizon.
    live: { pubkey: "a", tunnelId: "t-live", port: 1, claimedAt: NOW, renewedAt: later },
    lapsed: { pubkey: "b", tunnelId: "t-lapsed", port: 1, claimedAt: NOW, renewedAt: NOW },
  })
  const result = await sweepExpiredClaims(
    deps({ api: cf.api, store: st.store, now: () => later })
  )

  assert.deepEqual(result.released, ["lapsed"])
  assert.deepEqual(result.failed, [])
  assert.equal(result.remaining, 0)
  assert.deepEqual(cf.calls, ["deleteDnsRecord:lapsed.frizz.sh", "deleteTunnel:t-lapsed"])
  assert.equal(st.rows.has("lapsed"), false)
  assert.equal(st.rows.has("live"), true, "a live name must survive the sweep")
})

test("a sweep with nothing to do touches nothing", async () => {
  const cf = fakeCloudflare()
  const st = fakeStore({ live: { pubkey: "a", tunnelId: "t1", port: 1, claimedAt: NOW, renewedAt: NOW } })
  const result = await sweepExpiredClaims(deps({ api: cf.api, store: st.store }))
  assert.deepEqual(result, { released: [], failed: [], remaining: 0 })
  assert.deepEqual(cf.calls, [])
  assert.equal(st.rows.size, 1)
})

test("a name whose Cloudflare teardown fails KEEPS its registry row", async () => {
  // Dropping the row would orphan the tunnel: it would still exist, still consume the cap, and
  // nothing would know its id any more. Better to keep the row and retry on the next sweep.
  const cf = fakeCloudflare("deleteTunnel")
  const st = fakeStore({ lapsed: { pubkey: "b", tunnelId: "t1", port: 1, claimedAt: NOW, renewedAt: NOW } })
  const later = NOW + CLAIM_LEASE_MS + 1
  const result = await sweepExpiredClaims(deps({ api: cf.api, store: st.store, now: () => later }))

  assert.deepEqual(result.released, [])
  assert.deepEqual(result.failed, ["lapsed"])
  assert.equal(st.rows.has("lapsed"), true, "the row survives so the tunnel is not orphaned")
})

test("a sweep is bounded, and says how much it did not get to", async () => {
  // A scheduled Worker has a CPU budget. Reporting the remainder keeps a partial sweep from reading
  // as a complete one.
  const cf = fakeCloudflare()
  const seed: Record<string, ClaimRecord> = {}
  for (let i = 0; i < 5; i++) {
    seed[`name${i}`] = { pubkey: "x", tunnelId: `t${i}`, port: 1, claimedAt: NOW, renewedAt: NOW }
  }
  const st = fakeStore(seed)
  const later = NOW + CLAIM_LEASE_MS + 1
  const result = await sweepExpiredClaims(deps({ api: cf.api, store: st.store, now: () => later }), 2)

  assert.equal(result.released.length, 2)
  assert.equal(result.remaining, 3)
  assert.equal(st.rows.size, 3, "the rest wait for the next run")
})


test("a tunnel that outlived its registry row is RECLAIMED, not left to poison the name", async () => {
  // Cloudflare refuses a duplicate tunnel name (error 1013). So a tunnel that survived while its
  // registry row went would make its name permanently unclaimable — every future attempt colliding
  // with something nothing knows how to find. Reaching create means the registry says the name is
  // free, so a tunnel still wearing it is by definition unowned.
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()

  await handleClaim(await claimFor(identity), deps({ api: cf.api, store: st.store }))
  st.rows.clear() // the row is lost; the tunnel is not
  cf.calls.length = 0

  const again = await handleClaim(await claimFor(identity), deps({ api: cf.api, store: st.store }))
  assert.equal(again.status, 200, "the name must still be claimable")
  assert.ok(cf.calls.includes("deleteTunnel:tunnel-1"), `orphan not reclaimed: ${cf.calls.join(", ")}`)
  assert.equal(cf.tunnels.size, 1, "exactly one tunnel wears the name")
})

test("a name is NOT forgotten while its tunnel refuses to die", async () => {
  // Removing the row first is what creates the orphan above. Keeping it leaves the name merely taken,
  // which the next lapse or sweep can still resolve.
  const cf = fakeCloudflare()
  const st = fakeStore()
  const owner = await generateClaimIdentity()
  await handleClaim(await claimFor(owner), deps({ api: cf.api, store: st.store }))

  const stubborn = { ...cf.api, deleteTunnel: async () => { throw new Error("still connected") } }
  const later = NOW + CLAIM_LEASE_MS + 1
  const newcomer = await generateClaimIdentity()
  const result = await handleClaim(
    await claimFor(newcomer, "colin", 9393, later),
    deps({ api: stubborn, store: st.store, now: () => later })
  )

  assert.equal(result.status, 502, "the takeover must fail rather than strand the name")
  assert.equal(st.rows.has("colin"), true, "the registry still knows who to blame")
  assert.equal(st.rows.get("colin")?.pubkey, (await claimFor(owner)).pubkey)
})


test("one key holds ONE name — a loop of claims cannot take the namespace", async () => {
  // The zone caps at 200 records, so without this a `for` loop over generated keypairs is a complete
  // denial of the product. It is a speed bump, not a wall: keys are free, so a determined squatter
  // just makes more. It closes the version that happens by accident.
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const d = deps({ api: cf.api, store: st.store })

  assert.equal((await handleClaim(await claimFor(identity, "first"), d)).status, 200)

  const second = await handleClaim(await claimFor(identity, "second"), d)
  assert.equal(second.status, 409)
  assert.deepEqual(second.body, {
    error: "one-name-per-key",
    message: "this machine already holds a name — release it first, or claim from a different Frizz identity",
  })
  assert.equal(cf.tunnels.size, 1, "the second name provisioned nothing")

  // Renewing the name it DOES hold is unaffected — that is the call every launch makes.
  assert.equal((await handleClaim(await claimFor(identity, "first"), d)).status, 200)
})

test("a random name gives way to a custom one on the same key, and stays the key's until it lapses", async () => {
  // Boards start on a random name, and the R pane then offers the account's own name. Refusing that
  // would strand the board for the random name's 30-day lease, with no way to release it.
  for (const relay of [false, true]) {
    const cf = fakeCloudflare()
    const st = fakeStore()
    const identity = await generateClaimIdentity()
    const pubkey = (await claimFor(identity)).pubkey
    const d = deps({ ...(relay ? { api: undefined } : { api: cf.api }), store: st.store })
    const random = generateAnonymousClaimName()
    assert.equal((await handleClaim(await claimFor(identity, random), d)).status, 200)

    const moved = await handleClaim(await claimFor(identity, "colin"), d)
    assert.equal(moved.status, 200, relay ? "relay" : "tunnel")
    assert.equal(st.rows.get("colin")?.pubkey, pubkey)
    assert.equal(await st.store.readOwner(pubkey), "colin", "the key's one name is the new one")
    // NOT released: phones still bookmarked on it would hand whoever claimed it next their sessions.
    assert.equal(st.rows.get(random)?.pubkey, pubkey, "the random name stays the key's")
    const stranger = await generateClaimIdentity()
    assert.equal((await handleClaim(await claimFor(stranger, random), d)).status, 409, "and nobody else can take it")
    // And the key is held to one name from there: a further name is refused.
    assert.equal((await handleClaim(await claimFor(identity, "another"), d)).status, 409)

    // Unrenewed, it lapses like any name, and the sweep leaves the key's index on the custom one.
    const later = NOW + CLAIM_LEASE_MS + 1
    await handleClaim(await claimFor(identity, "colin", 9393, later), deps({ ...(relay ? { api: undefined } : { api: cf.api }), store: st.store, now: () => later }))
    const swept = await sweepExpiredClaims(deps({ ...(relay ? { api: undefined } : { api: cf.api }), store: st.store, now: () => later }))
    assert.deepEqual(swept.released, [random])
    assert.equal(await st.store.readOwner(pubkey), "colin", "releasing the random name kept the key's index")
    if (!relay) assert.equal(cf.dns.has(`${random}.frizz.sh`), false, "its DNS record went with it")
  }
})

test("releasing a lapsed name leaves an account's index alone once it points at another name", async () => {
  // Account 42's name lapses; the account claims another; then the old one is released. Deleting the
  // account's index then would let it claim a third name while still holding the second.
  const st = fakeStore()
  const github = fakeGithub({ "ghu_a": { id: 42, login: "ada", createdAt: NOW - 365 * 86_400_000 } })
  const first = await generateClaimIdentity()
  const second = await generateClaimIdentity()
  const third = await generateClaimIdentity()
  const at = (now: number) => deps({ api: undefined, store: st.store, github, now: () => now })
  assert.equal((await handleClaim(await signClaim({ name: "old", port: 9393, issuedAt: NOW, github: "ghu_a" }, first), at(NOW))).status, 200)
  const later = NOW + CLAIM_LEASE_MS + 1
  assert.equal((await handleClaim(await signClaim({ name: "new", port: 9393, issuedAt: later, github: "ghu_a" }, second), at(later))).status, 200)
  assert.equal(st.githubOwners.get(42), "new")
  assert.deepEqual((await sweepExpiredClaims(at(later))).released, ["old"])
  assert.equal(st.githubOwners.get(42), "new", "the account's index still names its live name")
  const third_ = await handleClaim(await signClaim({ name: "third", port: 9393, issuedAt: later, github: "ghu_a" }, third), at(later))
  assert.equal(third_.status, 409, "so the account still holds one name")
})

test("a custom name does not give way, and neither does a random one to another random one", async () => {
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const d = deps({ api: fakeCloudflare().api, store: st.store })
  assert.equal((await handleClaim(await claimFor(identity, "colin"), d)).status, 200)
  assert.equal((await handleClaim(await claimFor(identity, generateAnonymousClaimName()), d)).status, 409)
  assert.equal(st.rows.has("colin"), true, "the custom name keeps its lease, the grace for coming back")

  const other = await generateClaimIdentity()
  const first = generateAnonymousClaimName()
  assert.equal((await handleClaim(await claimFor(other, first), d)).status, 200)
  assert.equal((await handleClaim(await claimFor(other, generateAnonymousClaimName()), d)).status, 409)
  assert.equal(st.rows.has(first), true)
})

test("a custom claim that fails leaves the board on its random name", async () => {
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const random = generateAnonymousClaimName()
  assert.equal((await handleClaim(await claimFor(identity, random), deps({ api: fakeCloudflare().api, store: st.store }))).status, 200)
  const failed = await handleClaim(await claimFor(identity, "colin"), deps({ api: fakeCloudflare("createTunnel").api, store: st.store }))
  assert.equal(failed.status, 502)
  assert.equal(st.rows.has(random), true, "the name it had is still its own")
  assert.equal(await st.store.readOwner((await claimFor(identity)).pubkey), random)
})

test("a key whose name lapsed may claim again", async () => {
  // The index must not outlive the name. Otherwise letting a lease go would lock the owner out of the
  // service permanently, which is a worse failure than the squatting this guards against.
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  await handleClaim(await claimFor(identity, "first"), deps({ api: cf.api, store: st.store }))

  const later = NOW + CLAIM_LEASE_MS + 1
  st.rows.delete("first") // the sweeper released it; the owner index is what might be left behind
  const again = await handleClaim(
    await claimFor(identity, "second", 9393, later),
    deps({ api: cf.api, store: st.store, now: () => later })
  )
  assert.equal(again.status, 200, "a stale owner index must not lock someone out")
})


/** A GitHub that recognises the tokens it was told about. */
function fakeGithub(accounts: Record<string, { id: number; login: string; createdAt: number }>) {
  return async (token: string) => accounts[token] ?? null
}

const ACCOUNT = { id: 4242, login: "colin", createdAt: NOW - 365 * 24 * 60 * 60_000 }

test("a `gh` CLI token is refused, and nothing is recorded", async () => {
  // 2026-10-08: a compromised registrar collected the `gh` tokens old clients sent. The verifier now
  // answers "foreign" for any such token; the claim must stop there, distinctly from an unknown login,
  // so an old client is told to update rather than to sign in again.
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const d = deps({ api: cf.api, store: st.store, github: async (token) => (token === "gho_ghcli" ? "foreign" : ACCOUNT) })
  const result = await handleClaim(
    await signClaim({ name: "colin", port: 9393, issuedAt: NOW, github: "gho_ghcli" }, identity),
    d
  )
  assert.equal(result.status, 400)
  assert.equal("error" in result.body && result.body.error, "github-token-foreign")
  assert.match("message" in result.body ? result.body.message : "", /update Frizz/)
  assert.deepEqual(cf.calls, [], "nothing was provisioned")
  assert.equal(st.rows.size, 0, "nothing was recorded")
})

test("with the gate on, a claim without a GitHub token is refused before provisioning", async () => {
  // Reading a username locally proves nothing — the CLI could send any string. The token is what lets
  // the registrar check with GitHub, which is the only thing that makes this a limit at all.
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const d = deps({ api: cf.api, store: st.store, github: fakeGithub({ "gho_ok": ACCOUNT }) })

  const bare = await handleClaim(await claimFor(identity), d)
  assert.equal(bare.status, 400)
  assert.equal("error" in bare.body && bare.body.error, "github-required")
  assert.deepEqual(cf.calls, [], "nothing was provisioned")

  const wrong = await handleClaim(
    await signClaim({ name: "colin", port: 9393, issuedAt: NOW, github: "gho_nope" }, identity),
    d
  )
  assert.equal("error" in wrong.body && wrong.body.error, "github-rejected")

  const good = await handleClaim(
    await signClaim({ name: "colin", port: 9393, issuedAt: NOW, github: "gho_ok" }, identity),
    d
  )
  assert.equal(good.status, 200)
  assert.equal(st.rows.get("colin")?.githubId, 4242)
})

test("one name per GITHUB ACCOUNT — the limit a fresh keypair cannot walk around", async () => {
  // one-name-per-key alone is defeated by generating a second key. Tying it to an account that costs
  // something to obtain is the point of the whole gate.
  const cf = fakeCloudflare()
  const st = fakeStore()
  const d = deps({ api: cf.api, store: st.store, github: fakeGithub({ "gho_ok": ACCOUNT }) })

  const first = await generateClaimIdentity()
  assert.equal(
    (await handleClaim(await signClaim({ name: "one", port: 9393, issuedAt: NOW, github: "gho_ok" }, first), d)).status,
    200
  )

  // A BRAND NEW keypair, same GitHub account: the per-key check cannot see it, the per-account one can.
  const second = await generateClaimIdentity()
  const blocked = await handleClaim(
    await signClaim({ name: "two", port: 9393, issuedAt: NOW, github: "gho_ok" }, second),
    d
  )
  assert.equal(blocked.status, 409)
  assert.equal("error" in blocked.body && blocked.body.error, "one-name-per-account")
  assert.equal(cf.tunnels.size, 1)
})

test("a brand-new GitHub account cannot claim", async () => {
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const fresh = { id: 99, login: "throwaway", createdAt: NOW - 60_000 }
  const result = await handleClaim(
    await signClaim({ name: "colin", port: 9393, issuedAt: NOW, github: "gho_new" }, identity),
    deps({
      store: st.store,
      github: fakeGithub({ "gho_new": fresh }),
      minAccountAgeMs: 30 * 24 * 60 * 60_000,
    })
  )
  assert.equal("error" in result.body && result.body.error, "github-too-new")
  assert.equal(st.rows.size, 0)
})

test("a RENEWAL needs no GitHub token, so a live name never depends on GitHub", async () => {
  // The registrar is off the data plane; the gate must not put GitHub on the renewal path either, or
  // a GitHub outage would start expiring people's names.
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const d = deps({ api: cf.api, store: st.store, github: fakeGithub({ "gho_ok": ACCOUNT }) })
  await handleClaim(await signClaim({ name: "colin", port: 9393, issuedAt: NOW, github: "gho_ok" }, identity), d)

  // GitHub is now unreachable — every token is refused.
  const offline = deps({ api: cf.api, store: st.store, github: async () => null })
  const renewed = await handleClaim(await claimFor(identity), offline)
  assert.equal(renewed.status, 200, "a renewal must survive GitHub being down")
  assert.ok("renewed" in renewed.body && renewed.body.renewed)
})

test("a full namespace says so, and says whose problem it is", async () => {
  // Without this the cap is hit inside Cloudflare and surfaces as "provisioning failed", which tells
  // the user nothing and points us at the wrong thing. One name costs one DNS record, and the zone
  // caps at 200 on the free plan.
  const cf = fakeCloudflare()
  const st = fakeStore({
    a: { pubkey: "p1", tunnelId: "t1", port: 1, claimedAt: NOW, renewedAt: NOW },
    b: { pubkey: "p2", tunnelId: "t2", port: 1, claimedAt: NOW, renewedAt: NOW },
  })
  const identity = await generateClaimIdentity()
  const full = await handleClaim(
    await claimFor(identity, "third"),
    deps({ api: cf.api, store: st.store, maxNames: 2 })
  )
  assert.equal(full.status, 503, "a full namespace is OUR unavailability, not the caller's mistake")
  assert.deepEqual(full.body, {
    error: "namespace-full",
    message: "frizz.sh has no free names left — this is our limit to raise, not yours",
  })
  assert.deepEqual(cf.calls, [], "nothing was provisioned")
})

test("a RENEWAL is never refused for a full namespace", async () => {
  // A renewal consumes no new record. Refusing one because the namespace filled after it was claimed
  // would take a working board away from someone who did nothing wrong.
  const cf = fakeCloudflare()
  const identity = await generateClaimIdentity()
  const request = await claimFor(identity, "mine")
  const st = fakeStore({
    mine: { pubkey: request.pubkey, tunnelId: "t1", port: 9393, claimedAt: NOW, renewedAt: NOW },
    other: { pubkey: "p2", tunnelId: "t2", port: 1, claimedAt: NOW, renewedAt: NOW },
  })
  const renewed = await handleClaim(request, deps({ api: cf.api, store: st.store, maxNames: 1 }))
  assert.equal(renewed.status, 200, "an existing name must keep renewing past the ceiling")
  assert.ok("renewed" in renewed.body && renewed.body.renewed)
})


test("RELAY MODE records the name and touches no Cloudflare at all", async () => {
  // The default now. The relay serves every name off one wildcard record, so there is no tunnel to
  // create and no DNS record to write — which is exactly what removed the 200-name ceiling.
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const relay = { store: st.store, zone: ZONE, now: () => NOW } as ClaimDeps

  const claimed = await handleClaim(await claimFor(identity), relay)
  assert.equal(claimed.status, 200)
  assert.ok("hostname" in claimed.body && claimed.body.hostname === "colin.frizz.sh")
  assert.equal((claimed.body as { token?: string }).token, undefined, "a relay board needs no run token")
  assert.deepEqual(cf.calls, [], "relay mode must not call Cloudflare")
  assert.equal(st.rows.get("colin")?.tunnelId, "", "there is no tunnel to record")

  // Renewal is the lease and nothing else.
  const again = await handleClaim(await claimFor(identity, "colin", 9393, NOW + 1000), {
    ...relay,
    now: () => NOW + 1000,
  })
  assert.ok("renewed" in again.body && again.body.renewed)
  assert.equal(st.rows.get("colin")?.renewedAt, NOW + 1000)
})

test("releasing a relay name is only forgetting it", async () => {
  const cf = fakeCloudflare()
  const owner = await generateClaimIdentity()
  const request = await claimFor(owner, "colin")
  const st = fakeStore({
    colin: { pubkey: request.pubkey, tunnelId: "", port: 1, claimedAt: NOW, renewedAt: NOW },
  })
  const later = NOW + CLAIM_LEASE_MS + 1
  const newcomer = await generateClaimIdentity()
  const taken = await handleClaim(await claimFor(newcomer, "colin", 9393, later), {
    store: st.store, zone: ZONE, now: () => later,
  } as ClaimDeps)

  assert.equal(taken.status, 200, "a lapsed relay name must still be reclaimable")
  assert.deepEqual(cf.calls, [], "nothing to tear down in Cloudflare")
  assert.equal(st.rows.get("colin")?.pubkey, (await claimFor(newcomer)).pubkey)
})

test("an ANONYMOUS name claims through the gate with no GitHub identity at all", async () => {
  // The gate exists to make squatting cost something, and a 20-character random name has no squatting
  // value — so the auth-free path must work even while the gate is ON for everyone else.
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const name = generateAnonymousClaimName()
  const d: ClaimDeps = { store: st.store, zone: ZONE, now: () => NOW, github: fakeGithub({ "gho_ok": ACCOUNT }) }

  const result = await handleClaim(await signClaim({ name, port: 9393, issuedAt: NOW }, identity), d)
  assert.equal(result.status, 200)
  assert.equal("hostname" in result.body && result.body.hostname, `${name}.${ZONE}`)
  assert.equal(st.rows.get(name)?.githubId, undefined, "no account is recorded — there is none")
})

test("the anonymous shape is exact — anything else still pays the GitHub gate", async () => {
  // A 19- or 21-character name, or one outside the alphabet, is a vanity claim like any other. The
  // waiver keys on the shape alone, so the shape must not be approximately matched.
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const d: ClaimDeps = { store: st.store, zone: ZONE, now: () => NOW, github: fakeGithub({}) }
  for (const name of ["abcdefghjkmnpqrstuv", "abcdefghjkmnpqrstuvwx", "abcdefghjkmnpqrstuv1"]) {
    const result = await handleClaim(await signClaim({ name, port: 9393, issuedAt: NOW }, identity), d)
    assert.equal("error" in result.body && result.body.error, "github-required", name)
  }
})

test("a spent anonymous budget refuses a NEW name, and a renewal never consults it", async () => {
  // The budget is the auth-free path's whole cost, so it must bind creation — but a live board
  // renewing its lease must never lose its name to its network neighbours' behaviour.
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const name = generateAnonymousClaimName()
  let consulted = 0
  let allow = false
  const d: ClaimDeps = {
    store: st.store,
    zone: ZONE,
    now: () => NOW,
    anonymousBudget: async () => (consulted++, allow),
  }

  const refused = await handleClaim(await signClaim({ name, port: 9393, issuedAt: NOW }, identity), d)
  assert.equal(refused.status, 429)
  assert.equal("error" in refused.body && refused.body.error, "too-many-claims")
  assert.equal(st.rows.size, 0, "nothing was recorded")

  allow = true
  assert.equal((await handleClaim(await signClaim({ name, port: 9393, issuedAt: NOW }, identity), d)).status, 200)

  allow = false
  const renewed = await handleClaim(await signClaim({ name, port: 9494, issuedAt: NOW }, identity), d)
  assert.equal(renewed.status, 200, "a renewal must never be budget-limited")
  assert.ok("renewed" in renewed.body && renewed.body.renewed)
  assert.equal(consulted, 2, "the renewal did not consult the budget")
})

test("a VANITY claim never consults the anonymous budget — GitHub is that path's cost", async () => {
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  let consulted = 0
  const d: ClaimDeps = {
    store: st.store,
    zone: ZONE,
    now: () => NOW,
    github: fakeGithub({ "gho_ok": ACCOUNT }),
    anonymousBudget: async () => (consulted++, false),
  }
  const result = await handleClaim(
    await signClaim({ name: "colin", port: 9393, issuedAt: NOW, github: "gho_ok" }, identity),
    d
  )
  assert.equal(result.status, 200)
  assert.equal(consulted, 0)
})
