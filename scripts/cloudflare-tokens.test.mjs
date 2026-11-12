import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JOBS, MINTER_SCOPES, OAUTH_SCOPES, SNAPSHOT_TOKEN, TOKENS, expiresOn, findGroup, planToken, scopesForJob, snapshotAccount, staleTokens, withId } from "./cloudflare-tokens.mjs"

// Shapes from GET /accounts/{account_id}/tokens/permission_groups, cut down to the fields the plan
// reads. Not captured from the live account: the first real run resolves against the real list and
// refuses to mint anything if a name is missing.
const ACCOUNT = "com.cloudflare.api.account"
const ZONE = "com.cloudflare.api.account.zone"
const groups = [
  { id: "g-scripts-w", name: "Workers Scripts Write", scopes: [ACCOUNT] },
  { id: "g-scripts-r", name: "Workers Scripts Read", scopes: [ACCOUNT] },
  { id: "g-routes-w", name: "Workers Routes Write", scopes: [ZONE] },
  { id: "g-routes-r", name: "Workers Routes Read", scopes: [ZONE] },
  { id: "g-kv-r", name: "Workers KV Storage Read", scopes: [ACCOUNT] },
  { id: "g-settings-r", name: "Account Settings Read", scopes: [ACCOUNT] },
  { id: "g-zone-r", name: "Zone Read", scopes: [ZONE] },
  { id: "g-dns-r", name: "DNS Read", scopes: [ZONE] },
  // The same name at the wrong scope must never be picked.
  { id: "g-zone-r-account", name: "Zone Read", scopes: [ACCOUNT] },
]
const spec = (key) => TOKENS.find((t) => t.key === key)
const ids = (plan) => plan.policies.map((p) => ({ resources: Object.keys(p.resources), groups: p.permission_groups.map((g) => g.id) }))

test("a write group is found under the API's Write spelling and the dashboard's Edit spelling", () => {
  assert.equal(findGroup(groups, "Workers Scripts Write", ACCOUNT)?.id, "g-scripts-w")
  assert.equal(findGroup(groups, "Workers Scripts Edit", ACCOUNT)?.id, "g-scripts-w")
  assert.equal(findGroup([{ id: "e", name: "Workers Scripts Edit", scopes: [ACCOUNT] }], "Workers Scripts Write", ACCOUNT)?.id, "e")
  assert.equal(findGroup(groups, "Zone Read", ZONE)?.id, "g-zone-r")
  assert.equal(findGroup(groups, "Workers Routes Write", ACCOUNT), null)
})

test("the deploy token edits Workers on the account, nothing else, and lasts one hour", () => {
  const plan = planToken(spec("deploy"), { groups, accountId: "acct", zoneId: "zone1" })
  assert.deepEqual(plan.missing, [])
  assert.deepEqual(ids(plan), [{ resources: [`${ACCOUNT}.acct`], groups: ["g-scripts-w"] }])
  assert.equal(expiresOn(Date.parse("2026-11-01T10:20:30.456Z"), spec("deploy").expiresDays), "2026-11-01T11:20:30Z")
})

test("each new deploy token joins the authors drift accepts, and the older ones stay", () => {
  assert.equal(spec("deploy").authorVariable, "WORKERS_CI_AUTHOR")
  assert.equal(withId("", "new"), "new")
  assert.equal(withId("old\n", "new"), "old,new")
  assert.equal(withId("old,new", "new"), "old,new")
})

test("the drift token holds the reads its check needs, and can never write or see the relay's traffic", () => {
  const plan = planToken(spec("drift"), { groups, accountId: "acct", zoneId: "zone1" })
  assert.deepEqual(plan.missing, [])
  assert.deepEqual(ids(plan), [
    { resources: [`${ACCOUNT}.acct`], groups: ["g-scripts-r", "g-settings-r"] },
    { resources: [`${ZONE}.zone1`], groups: ["g-zone-r", "g-dns-r", "g-routes-r"] },
  ])
  const names = [...spec("drift").account, ...spec("drift").zone]
  assert.deepEqual(names.filter((name) => !/ Read\??$/.test(name) || /tail|log/i.test(name)), [])
})

test("only the two CI tokens are minted, both into GitHub, so no run can touch a token in Keyward", () => {
  assert.deepEqual(TOKENS.map((t) => [t.key, t.sink.kind, t.sink.secret, t.sink.env ?? null]), [
    ["deploy", "gh", "CLOUDFLARE_API_TOKEN", "workers-deploy"],
    ["drift", "gh", "CLOUDFLARE_READ_TOKEN", null],
  ])
})

test("an optional group the account lacks is skipped rather than failing the plan", () => {
  const plan = planToken({ account: ["Workers Scripts Read", "Workers Tail Read?"], zone: [] }, { groups, accountId: "acct", zoneId: "zone1" })
  assert.deepEqual(plan.missing, [])
  assert.deepEqual(plan.skipped, ["Workers Tail Read"])
  assert.deepEqual(ids(plan), [{ resources: [`${ACCOUNT}.acct`], groups: ["g-scripts-r"] }])
})

test("a required group the account does not offer is reported, so nothing gets minted", () => {
  const plan = planToken(spec("deploy"), { groups: groups.filter((g) => g.id !== "g-scripts-w"), accountId: "acct", zoneId: "zone1" })
  assert.deepEqual(plan.missing, ["Workers Scripts Write"])
})

test("a rotation revokes the older tokens of that name, never the new one or the bootstrap", () => {
  const existing = [
    { id: "old1", name: "github-actions workers-deploy" },
    { id: "new", name: "github-actions workers-deploy" },
    { id: "boot", name: "github-actions workers-deploy" },
    { id: "other", name: "github-actions workers-drift" },
  ]
  assert.deepEqual(staleTokens(existing, "github-actions workers-deploy", new Set(["new", "boot"])).map((t) => t.id), ["old1"])
})

test("the snapshot's token only reads, and can never see the relay's traffic", () => {
  const names = [...SNAPSHOT_TOKEN.account, ...SNAPSHOT_TOKEN.zone]
  assert.deepEqual(names.filter((name) => !/ Read\??$/.test(name) || /tail|log/i.test(name)), [])
})

test("expires_on is whole seconds, a year out", () => {
  assert.equal(expiresOn(Date.parse("2026-11-01T10:20:30.456Z")), "2027-11-01T10:20:30Z")
})

test("a snapshot saves every read it can, records each refusal, and covers a Worker nobody expected", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "cf-snapshot-"))
  const asked = []
  const get = async (path) => {
    asked.push(path)
    if (path.includes("/logpush/")) throw new Error("HTTP 403")
    if (path.includes("/audit_logs")) return { result: Array.from({ length: path.endsWith("page=1") ? 1000 : 2 }, (_, i) => ({ i })) }
    if (path.endsWith("/workers/scripts")) return { result: [{ id: "frizz-relay", tag: "tag1" }, { id: "surprise" }] }
    if (path.startsWith("/zones?")) return { result: [{ id: "zone1" }] }
    if (path.includes("/versions")) return { result: { items: [{ id: "v1" }] } }
    return { result: [] }
  }
  const getBytes = async (path) => {
    if (path.endsWith("/frizz-registrar")) throw new Error("HTTP 404")
    return Buffer.from(`code of ${path}`)
  }
  try {
    const tokensAsked = []
    const tokensGet = async (path) => {
      tokensAsked.push(path)
      return { result: [{ id: "t1" }] }
    }
    const { saved, refused, scripts } = await snapshotAccount({ get, tokensGet, getBytes, outDir, accountId: "acct", zone: "frizz.sh", since: "2026-08-01T00:00:00Z", knownScripts: ["frizz-relay", "frizz-registrar"] })
    assert.deepEqual(scripts, ["frizz-relay", "surprise", "frizz-registrar"], "the listed Workers and the known ones, once each")
    assert.equal(JSON.parse(readFileSync(join(outDir, "audit-log.json"), "utf8")).length, 1002, "a paged read carries on until a short page")
    assert.deepEqual(JSON.parse(readFileSync(join(outDir, "surprise.versions.json"), "utf8")), [{ id: "v1" }], "versions nest their list in items")
    assert.equal(readFileSync(join(outDir, "surprise.deployed-code.multipart"), "utf8"), "code of /accounts/acct/workers/scripts/surprise")
    assert.deepEqual(refused.map((r) => r.name).sort(), ["frizz-registrar.deployed-code", "logpush-account", "logpush-zone"])
    assert.ok(saved.some((s) => s.name === "routes"), "a zone's reads run under the zone Cloudflare named")
    assert.ok(asked.includes("/zones/zone1/workers/routes"))
    assert.ok(asked.includes("/accounts/acct/builds/workers/tag1/triggers"), "a Workers Builds connection is read through the Worker's tag")
    assert.equal(readFileSync(join(outDir, "claim-colin.value"), "utf8"), "code of /accounts/acct/storage/kv/namespaces/aa4a9c11473d4511a556e3e3a6857058/values/claim:colin")
    assert.equal(statSync(join(outDir, "audit-log.json")).mode & 0o077, 0, "evidence is readable by its owner alone")
    assert.deepEqual(tokensAsked.map((path) => path.split("?")[0]), ["/accounts/acct/tokens", "/user/tokens"], "token lists use the credential that can read them")
    assert.ok(!asked.some((path) => path.includes("/tokens")), "and the everyday token is never asked for them")
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test("every group a token names has its OAuth scope known, and only an optional one may have none", () => {
  for (const spec of [...TOKENS, SNAPSHOT_TOKEN]) {
    for (const raw of [...spec.account, ...spec.zone]) {
      const name = raw.replace(/\?$/, "")
      assert.ok(name in OAUTH_SCOPES, `${spec.name}: ${name} has no entry in OAUTH_SCOPES`)
      if (!raw.endsWith("?")) assert.ok(OAUTH_SCOPES[name], `${spec.name}: ${name} is required, so a sign-in must be able to grant it`)
    }
  }
})

test("a deploy sitting asks to write Workers scripts, the registrar's database and to read, and nothing else", () => {
  const deploy = scopesForJob("deploy")
  for (const scope of [...MINTER_SCOPES, "workers-scripts.write", "dns.read"]) assert.ok(deploy.includes(scope), scope)
  assert.equal(deploy.filter((scope) => /\.(write|edit|admin)$/.test(scope)).sort().join(" "), "account-api-tokens.write d1.write workers-scripts.write")
  assert.ok(deploy.includes("d1.write"), "a deploy sitting can create the registrar's database")
  assert.equal(scopesForJob("audit").includes("d1.write"), false)
  assert.equal(scopesForJob("audit").includes("workers-scripts.write"), false)
  assert.equal(scopesForJob("drift").includes("workers-scripts.write"), false)
  assert.deepEqual(Object.keys(JOBS).sort(), ["audit", "deploy", "drift"])
  assert.throws(() => scopesForJob("everything"), /no such sitting/)
})

test("under a sign-in, a group it was not granted counts as absent: skipped if optional, missing if required", () => {
  const groups = [
    { id: "g-scripts-w", name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] },
    { id: "g-scripts-r", name: "Workers Scripts Read", scopes: ["com.cloudflare.api.account"] },
    { id: "g-wr", name: "Waiting Room Read", scopes: ["com.cloudflare.api.account.zone"] },
  ]
  const spec = { account: ["Workers Scripts Write", "Workers Scripts Read"], zone: ["Waiting Room Read?"] }
  const granted = new Set(["workers-scripts.read"])
  const plan = planToken(spec, { groups, accountId: "acct", zoneId: "zone1", granted })
  assert.deepEqual(plan.missing, ["Workers Scripts Write"])
  assert.deepEqual(plan.skipped, ["Waiting Room Read"])
  assert.deepEqual(plan.policies.flatMap((p) => p.permission_groups.map((g) => g.name)), ["Workers Scripts Read"])
  const unlimited = planToken(spec, { groups, accountId: "acct", zoneId: "zone1" })
  assert.deepEqual(unlimited.missing, [])
})
