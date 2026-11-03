import assert from "node:assert/strict"
import { test } from "node:test"
import { TOKENS, expiresOn, findGroup, planToken, staleTokens } from "./cloudflare-tokens.mjs"

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

test("the deploy token edits Workers on the account and routes on the one zone, nothing else", () => {
  const plan = planToken(spec("deploy"), { groups, accountId: "acct", zoneId: "zone1" })
  assert.deepEqual(plan.missing, [])
  assert.deepEqual(ids(plan), [
    { resources: [`${ACCOUNT}.acct`], groups: ["g-scripts-w"] },
    { resources: [`${ZONE}.zone1`], groups: ["g-routes-w"] },
  ])
})

test("the drift token only reads Workers, and has no zone policy at all", () => {
  const plan = planToken(spec("drift"), { groups, accountId: "acct", zoneId: "zone1" })
  assert.deepEqual(ids(plan), [{ resources: [`${ACCOUNT}.acct`], groups: ["g-scripts-r"] }])
})

test("only the two CI tokens are minted here, and both go to GitHub", () => {
  assert.deepEqual(TOKENS.map((t) => [t.key, t.sink.secret, t.sink.env ?? null]), [
    ["deploy", "CLOUDFLARE_API_TOKEN", "workers-deploy"],
    ["drift", "CLOUDFLARE_READ_TOKEN", null],
  ])
})

test("an optional group the account lacks is skipped rather than failing the plan", () => {
  const plan = planToken({ account: ["Workers Scripts Read", "Workers Tail Read?"], zone: [] }, { groups, accountId: "acct", zoneId: "zone1" })
  assert.deepEqual(plan.missing, [])
  assert.deepEqual(plan.skipped, ["Workers Tail Read"])
  assert.deepEqual(ids(plan), [{ resources: [`${ACCOUNT}.acct`], groups: ["g-scripts-r"] }])
})

test("a required group the account does not offer is reported, so nothing gets minted", () => {
  const plan = planToken(spec("deploy"), { groups: groups.filter((g) => g.id !== "g-routes-w"), accountId: "acct", zoneId: "zone1" })
  assert.deepEqual(plan.missing, ["Workers Routes Write"])
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

test("expires_on is whole seconds, a year out", () => {
  assert.equal(expiresOn(Date.parse("2026-11-01T10:20:30.456Z")), "2027-11-01T10:20:30Z")
})
