// Mints the Cloudflare API tokens the frizz.sh CI uses, and hands each one straight to the GitHub
// secret that holds it, so none is ever in a file, an argv, a terminal or a transcript:
//
//   github-actions workers-deploy   Workers Scripts Edit, for ONE HOUR, minted for one deploy
//                                   -> CLOUDFLARE_API_TOKEN in the `workers-deploy` environment
//   github-actions workers-drift    the reads scripts/workers-drift.mjs needs, for a year
//                                   -> the repository secret CLOUDFLARE_READ_TOKEN
//
// WHY. From 2026-09-21 to 2026-10-08 an attacker deployed backdoored builds of both frizz.sh Workers
// with a Cloudflare token copied off the maintainer's disk (`~/.frizz-cf-token`, a plain file).
//
// NO STANDING DEPLOY TOKEN. A token parked in the `workers-deploy` environment is not safe either: the
// repository owner's GitHub token, in one `keyward -- gh` window, can loosen the environment's main-only
// rule and read the secret from a branch workflow, with nothing on main, and a Cloudflare token works from
// anywhere until it expires. So one exists only for the hour around a deploy, and between deploys there
// is nothing to steal. That hour is also the gate: minting the token takes the maintainer's Authorize
// click, so the environment asks for no reviewer (2026-11-11). The last Worker upload before this rule was five weeks old, so it rarely costs
// anything. It has no route permission because the workflow uses `wrangler versions`, which leaves routes
// alone. Whether Cloudflare can narrow it to the two scripts is checked by `--dry-run`, which lists the
// account's Workers permission groups.
//
// THE CREDENTIAL is CLOUDFLARE_FRIZZ_MINTER, read from the environment and never stored by this script.
// It manages the account's API tokens: Account API Tokens Edit, Account Settings Read and Zone Read on
// the Frizz account. API Tokens Read on the user who made it adds that user's token list to the snapshot,
// and the sitting goes on without it. Only the dashboard can issue it,
// because Cloudflare refuses token-management permissions on a token made through its API. It can mint
// a token that deploys the relay, and whatever can deploy the relay has code execution on every board
// behind it. So it exists for one sitting and is kept nowhere. Since 2026-11-09 it is an OAuth sign-in
// (scripts/cloudflare-oauth.mjs): the maintainer clicks Authorize, and Cloudflare refuses to mint any
// group the sign-in was not granted, so each sitting asks for its own tokens' scopes (scopesForJob). A
// dashboard-made token on a secret card still works the same way through scripts/cloudflare-sitting.sh.
// The maintainer's everyday CLOUDFLARE_API_TOKEN cannot manage tokens, so it plays no part here.
//
// THE CI TOKENS ARE ACCOUNT-OWNED ON PURPOSE. `workers-drift` tells CI's uploads from a laptop's by their
// author, and a user-owned CI token would share its author with the maintainer's own token.
//
// EVERY TOKEN IT MINTS IS RECORDED by id in the repository variable WORKERS_MINTED_TOKENS (the deploy
// token, the drift token, and each audit's snapshot token), so workers-drift passes the audit log's
// create and revoke of each and still alarms on a token made anywhere else (2026-11-11). A recording
// that fails is a warning: the token works, and the cost is one alarm.
//
// ROTATION is a re-run: each new token is in place before the older tokens of the same name are
// revoked. Every run ends with an audit of the account's members and API tokens, flagging any token
// this script does not manage.
//
//   T="$(cat '<secret pipe>')"
//   CLOUDFLARE_FRIZZ_MINTER="$T" env -u NODE_COMPAT nub scripts/cloudflare-tokens.mjs --audit [--out=<dir>]
//   CLOUDFLARE_FRIZZ_MINTER="$T" env -u NODE_COMPAT nub scripts/cloudflare-tokens.mjs --only=drift          once, then yearly
//   CLOUDFLARE_FRIZZ_MINTER="$T" env -u NODE_COMPAT nub scripts/cloudflare-tokens.mjs --only=deploy         then dispatch within the hour
//   CLOUDFLARE_FRIZZ_MINTER="$T" env -u NODE_COMPAT nub scripts/cloudflare-tokens.mjs --revoke-deploy       right after the deploy
//
// Add `--dry-run` to a mint to see the plan and mint nothing.
//
// `--out=<dir>` also saves the whole account as it stands, raw: every Worker's deployments, versions,
// secret names, crons and deployed code, plus routes, domains, tunnels, DNS, user-owned tokens and the
// audit log. Run it BEFORE a deploy, which replaces what is running and with it any trace of a
// backdoor. The minter can't read most of that, so the run mints its own read token (SNAPSHOT_TOKEN),
// holds it in memory and revokes it at the end. The directory is evidence, so keep it out of the
// repository.

import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { ghCommand } from "./lib/gh-command.mjs"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { ACCOUNT_ID, CLAIMS_NAMESPACE, MINTED_VARIABLE } from "./workers-drift.mjs"

export const REPO = "colinhacks/frizz"
export const ZONE = "frizz.sh"
export const EXPIRES_DAYS = 365
const API = "https://api.cloudflare.com/client/v4"
const ACCOUNT_SCOPE = "com.cloudflare.api.account"
const ZONE_SCOPE = "com.cloudflare.api.account.zone"

// A spec names its permission groups: `account` ones on the Frizz account, `zone` ones on frizz.sh alone.
// A trailing `?` marks a permission the token is still useful without: missing from the account's
// groups, it is skipped with a warning rather than failing.
export const TOKENS = [
  {
    key: "deploy",
    name: "github-actions workers-deploy",
    account: ["Workers Scripts Write"],
    zone: [],
    expiresDays: 1 / 24,
    sink: { kind: "gh", secret: "CLOUDFLARE_API_TOKEN", env: "workers-deploy" },
    // This token uploads as its own id, so workers-drift has to be told each new one.
    authorVariable: "WORKERS_CI_AUTHOR",
  },
  {
    // What checkAccount and checkWorker read. Never Workers Tail or Logs: see SNAPSHOT_TOKEN. The optional
    // ones are every group that can list a zone's rulesets, because a list shows only what its token may see.
    key: "drift",
    name: "github-actions workers-drift",
    account: ["Workers Scripts Read", "Account Settings Read"],
    zone: [
      "Zone Read",
      "DNS Read",
      "Workers Routes Read",
      "Zone WAF Read?",
      "Transform Rules Read?",
      "Dynamic URL Redirects Read?",
      "Config Settings Read?",
      "Cache Settings Read?",
      "Origin Read?",
    ],
    expiresDays: EXPIRES_DAYS,
    sink: { kind: "gh", secret: "CLOUDFLARE_READ_TOKEN" },
  },
]

// What the `--out` snapshot's own token reads. "Read" does not mean harmless on this account: Workers
// Tail Read streams every request's URL and headers, Logs Read gives Logpull and Instant Logs, and the
// relay carries each board's session cookie and single-use access code in those. A test fails if either
// joins this list. Logpush jobs stay unread because of it; the audit log still records one being made.
export const SNAPSHOT_TOKEN = {
  name: "frizz audit snapshot",
  account: [
    "Workers Scripts Read",
    "Account Settings Read",
    "Workers KV Storage Read?",
    "Workers R2 Storage Read?",
    "D1 Read?",
    "Pages Read?",
    "Queues Read?",
    "Cloudflare Tunnel Read?",
    "Access: Apps and Policies Read?",
    "Access: Service Tokens Read?",
    "Notifications Read?",
    "Workers CI Read?",
    "Workers for Platforms Read?",
    "Account Rulesets Read?",
    "Account Custom Pages Read?",
    "Account Analytics Read?",
  ],
  zone: [
    "Zone Read",
    "DNS Read",
    "Workers Routes Read",
    "Page Rules Read?",
    "Zone WAF Read?",
    "Transform Rules Read?",
    "Dynamic URL Redirects Read?",
    "Config Settings Read?",
    "Cache Settings Read?",
    "Origin Read?",
    "Email Routing Rules Read?",
    "Custom Pages Read?",
    "Zaraz Read?",
    "Waiting Room Read?",
    "Page Shield Read?",
    "SSL and Certificates Read?",
    "Load Balancers Read?",
    "Snippets Read?",
  ],
}
const SNAPSHOT_TOKEN_DAYS = 1 / 24

// THE OAUTH SCOPE OF EACH PERMISSION GROUP the specs above name, from GET /oauth/scopes on 2026-11-09.
// Under an OAuth sign-in (scripts/cloudflare-oauth.mjs), Cloudflare refuses to mint a token holding any
// group the sign-in was not granted: "The OAuth session does not include the scopes required for the
// requested permission groups". So a job's sign-in asks for the scope of every group it mints, and a
// group with no scope (null) can never be minted under one, which only optional groups may be. A test
// fails if a spec names a group missing here.
export const OAUTH_SCOPES = {
  // Cloudflare lists this name twice: `access.read` on the account, `zone-access.read` on a zone. The
  // snapshot reads it on the account.
  "Access: Apps and Policies Read": "access.read",
  "Access: Service Tokens Read": "access-service-token.read",
  "Account API Tokens Write": "account-api-tokens.write",
  "Account Analytics Read": "account-analytics.read",
  "Account Custom Pages Read": "account-custom-pages.read",
  "Account Rulesets Read": "account-rulesets.read",
  "Account Settings Read": "account-settings.read",
  "Cache Settings Read": "cache-settings.read",
  "Cloudflare Tunnel Read": "argotunnel.read",
  "Config Settings Read": "config-settings.read",
  "Custom Pages Read": "custom-pages.read",
  "D1 Read": "d1.read",
  "DNS Read": "dns.read",
  "Dynamic URL Redirects Read": "dynamic-redirect.read",
  "Email Routing Rules Read": "email-routing-rule.read",
  "Load Balancers Read": "load-balancers.read",
  "Notifications Read": "notifications.read",
  "Origin Read": "origin.read",
  "Page Rules Read": "page-rules.read",
  "Page Shield Read": "page-shield.read",
  "Pages Read": "page.read",
  "Queues Read": "queues.read",
  "SSL and Certificates Read": "ssl-and-certificates.read",
  "Snippets Read": "snippets.read",
  "Transform Rules Read": "transform-rules.read",
  "Waiting Room Read": null,
  "Workers CI Read": "workers-ci.read",
  "Workers KV Storage Read": "workers-kv-storage.read",
  "Workers R2 Storage Read": "workers-r2.read",
  "Workers Routes Read": "workers-routes.read",
  "Workers Scripts Read": "workers-scripts.read",
  "Workers Scripts Write": "workers-scripts.write",
  "Workers for Platforms Read": null,
  "Zaraz Read": "zaraz.read",
  "Zone Read": "zone.read",
  "Zone WAF Read": "zone-waf.read",
}

/** What this script itself does with its credential: list and mint the account's tokens, find the zone. */
export const MINTER_SCOPES = ["account-api-tokens.write", "account-settings.read", "zone.read"]

/** Each sitting a sign-in can be for, by the tokens it mints. Every sitting starts with the audit snapshot. */
export const JOBS = {
  deploy: () => [SNAPSHOT_TOKEN, TOKENS.find((t) => t.key === "deploy")],
  drift: () => [SNAPSHOT_TOKEN, TOKENS.find((t) => t.key === "drift")],
  audit: () => [SNAPSHOT_TOKEN],
}

/** The OAuth scopes a sitting for `job` asks for: the minter's own, plus every group its tokens hold. */
export function scopesForJob(job) {
  const specs = JOBS[job]?.()
  if (!specs) throw new Error(`no such sitting: ${job} (one of ${Object.keys(JOBS).join(", ")})`)
  const scopes = new Set(MINTER_SCOPES)
  for (const spec of specs) {
    for (const raw of [...spec.account, ...spec.zone]) {
      const scope = OAUTH_SCOPES[raw.replace(/\?$/, "")]
      if (scope) scopes.add(scope)
    }
  }
  return [...scopes]
}

/** The scopes an OAuth sign-in was granted, or null for an API token, which has no such limit. */
function grantedScopes() {
  if (process.env.CLOUDFLARE_FRIZZ_MINTER_KIND !== "oauth") return null
  return new Set(String(process.env.CLOUDFLARE_FRIZZ_MINTER_SCOPES ?? "").split(" ").filter(Boolean))
}

/**
 * The permission group called `wanted` at `scope`, from the account's list. Cloudflare names a write
 * group "… Write" in the API and "… Edit" in the dashboard, so either spelling finds it.
 */
export function findGroup(groups, wanted, scope) {
  const base = wanted.replace(/ (Write|Edit)$/, "")
  const spellings = base === wanted ? [wanted] : [`${base} Write`, `${base} Edit`]
  for (const spelling of spellings) {
    const group = groups.find((g) => g.name === spelling && (g.scopes ?? []).includes(scope))
    if (group) return group
  }
  return null
}

/**
 * The policies for one token spec, plus the required groups the account does not have. Account groups
 * apply to this account, zone groups to the one zone.
 */
export function planToken(spec, { groups, accountId, zoneId, granted = null }) {
  const missing = []
  const skipped = []
  const account = `${ACCOUNT_SCOPE}.${accountId}`
  const policies = []
  const push = (resources, picked) => {
    if (picked.length) policies.push({ effect: "allow", resources, permission_groups: picked.map((g) => ({ id: g.id, name: g.name })) })
  }
  const resolve = (names, scope) =>
    names.flatMap((raw) => {
      const optional = raw.endsWith("?")
      const name = optional ? raw.slice(0, -1) : raw
      const group = findGroup(groups, name, scope)
      // Under a sign-in, a group whose scope it was not granted cannot be minted, so it counts as absent.
      if (group && (!granted || granted.has(OAUTH_SCOPES[name]))) return [group]
      ;(optional ? skipped : missing).push(name)
      return []
    })
  push({ [account]: "*" }, resolve(spec.account, ACCOUNT_SCOPE))
  push({ [`${ZONE_SCOPE}.${zoneId}`]: "*" }, resolve(spec.zone, ZONE_SCOPE))
  return { policies, missing, skipped }
}

/** The tokens a rotation revokes: same name as a managed spec, and not one this run just made. */
export function staleTokens(existing, name, keepIds) {
  return existing.filter((t) => t.name === name && !keepIds.has(t.id))
}

/** `expires_on` for a token minted at `now`. Cloudflare refuses fractional seconds. */
export function expiresOn(now, days = EXPIRES_DAYS) {
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
}

function client(token) {
  return async (method, path, body) => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const parsed = await response.json().catch(() => null)
    if (!response.ok || !parsed?.success) {
      const errors = (parsed?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ")
      const error = new Error(`Cloudflare ${method} ${path}: HTTP ${response.status}${errors ? ` (${errors})` : ""}`)
      error.status = response.status
      throw error
    }
    return parsed.result
  }
}

/** Hand `value` to its GitHub secret on stdin. Returns null on success, or what went wrong (never the value). */
function deliver(sink, value) {
  const [command, args] = ghCommand(`Store the ${sink.secret} secret on ${REPO}`, ["secret", "set", sink.secret, "--repo", REPO, ...(sink.env ? ["--env", sink.env] : [])], { write: true })
  const result = spawnSync(command, args, { input: value, encoding: "utf8" })
  if (result.error) return `${command} did not start: ${result.error.message}`
  if (result.status !== 0) return `${command} ${args.slice(0, 3).join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`
  return null
}

/** Empties a GitHub secret. Returns null on success, or what went wrong. */
function removeFromSink(sink) {
  const [command, args] = ghCommand(`Remove the expired ${sink.secret} secret from ${REPO}`, ["secret", "delete", sink.secret, "--repo", REPO, ...(sink.env ? ["--env", sink.env] : [])], { write: true })
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.error) return `${command} did not start: ${result.error.message}`
  if (result.status !== 0) return `${command} ${args.slice(0, 3).join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`
  return null
}

/** `list`, a repository variable's comma-separated ids, with `id` added. */
export function withId(list, id) {
  const ids = list.split(",").map((each) => each.trim()).filter(Boolean)
  return (ids.includes(id) ? ids : [...ids, id]).join(",")
}

/**
 * Adds a new token's id to a list workers-drift reads, keeping the older ones: WORKERS_CI_AUTHOR, the
 * authors it accepts (the Workers go on running what the last token uploaded until this one deploys,
 * and a mint that never deploys changes nothing), and MINTED_VARIABLE, whose create and revoke it lets
 * pass (an older token's revoke comes a deploy or a year later). Returns null on success, or what went
 * wrong.
 */
function recordId(variable, id, what) {
  const [readCommand, readArgs] = ghCommand(`Read ${variable} on ${REPO}`, ["variable", "get", variable, "--repo", REPO], { write: true })
  const read = spawnSync(readCommand, readArgs, { encoding: "utf8" })
  if (read.error) return `${readCommand} did not start: ${read.error.message}`
  if (read.status !== 0 && !/not found/i.test(read.stderr)) return `${readCommand} ${readArgs.slice(0, 3).join(" ")} exited ${read.status}: ${(read.stderr || read.stdout).trim()}`
  const list = read.status === 0 ? read.stdout : ""
  const [command, args] = ghCommand(`Add the new ${what} to ${variable} on ${REPO}`, ["variable", "set", variable, "--repo", REPO, "--body", withId(list, id)], { write: true })
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.error) return `${command} did not start: ${result.error.message}`
  if (result.status !== 0) return `${command} ${args.slice(0, 3).join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`
  return null
}

/** Records a token just minted in MINTED_VARIABLE, warning rather than failing: see this file's header. */
function recordMinted(id, what) {
  const failure = recordId(MINTED_VARIABLE, id, what)
  if (failure) console.error(`warning: ${what} (${id}) is not in ${MINTED_VARIABLE}, so workers-drift will alarm on its create and revoke: ${failure}`)
}

function describeSink(sink) {
  return sink.env ? `GitHub environment ${sink.env} secret ${sink.secret}` : `GitHub repository secret ${sink.secret}`
}

async function whoAmI(cf) {
  // An OAuth sign-in (scripts/cloudflare-oauth.mjs) is not an API token, so neither verify endpoint knows it.
  if (process.env.CLOUDFLARE_FRIZZ_MINTER_KIND === "oauth") {
    return { kind: "oauth", id: null, status: "active", expires_on: process.env.CLOUDFLARE_FRIZZ_MINTER_EXPIRES || "unknown" }
  }
  try {
    return { kind: "account", ...(await cf("GET", `/accounts/${ACCOUNT_ID}/tokens/verify`)) }
  } catch (error) {
    // Cloudflare answers a token of the other kind with anything from 400 to 404.
    if (!(error.status >= 400 && error.status < 500)) throw error
    return { kind: "user", ...(await cf("GET", "/user/tokens/verify")) }
  }
}

/** What the credential reaches, so that a refusal on this account says what to fix on the token. */
async function reachOf(cf, id) {
  try {
    const accounts = await cf("GET", "/accounts?per_page=50")
    console.log(`  accounts it can see: ${accounts.map((a) => `${a.name} (${a.id})`).join(", ") || "none"}`)
  } catch (error) {
    console.log(`  accounts it can see: ${error.message}`)
  }
  try {
    const { name, issued_on, last_used_on, policies = [] } = await cf("GET", `/user/tokens/${id}`)
    console.log(`  named ${JSON.stringify(name)}, issued ${issued_on}, last used ${last_used_on ?? "never"}`)
    for (const token of await cf("GET", "/user/tokens?per_page=50")) {
      console.log(`  the user's token ${JSON.stringify(token.name)} …${token.id.slice(-4)}: ${token.status}, issued ${token.issued_on}, last used ${token.last_used_on ?? "never"}, expires ${token.expires_on ?? "never"}`)
    }
    for (const policy of policies) {
      const on = Object.entries(policy.resources ?? {}).map(([resource, level]) => (typeof level === "string" ? resource : `${resource} ${JSON.stringify(level)}`))
      console.log(`  ${policy.effect}: ${(policy.permission_groups ?? []).map((g) => g.name).join(", ")} on ${on.join(", ")}`)
    }
  } catch (error) {
    console.log(`  its policies: ${error.message}`)
  }
}

async function listTokens(cf) {
  const all = []
  for (let page = 1; page <= 20; page++) {
    const items = await cf("GET", `/accounts/${ACCOUNT_ID}/tokens?per_page=50&page=${page}`)
    all.push(...items)
    if (items.length < 50) break
  }
  return all
}

async function audit(cf, selfId) {
  console.log("\n== Audit: account members")
  try {
    const members = await cf("GET", `/accounts/${ACCOUNT_ID}/members?per_page=50`)
    for (const m of members) {
      const roles = (m.roles ?? []).map((r) => r.name).join(", ") || (m.policies ?? []).length + " policies"
      console.log(`  ${m.user?.email ?? m.email ?? m.id}  status ${m.status}  roles ${roles}  2FA ${m.user?.two_factor_authentication_enabled ? "on" : "OFF"}`)
    }
  } catch (error) {
    console.log(`  could not read members: ${error.message}`)
  }
  console.log("\n== Audit: account-owned API tokens (user-owned tokens are listed only on each user's profile)")
  try {
    const managed = new Set(TOKENS.map((t) => t.name))
    for (const t of await listTokens(cf)) {
      const groups = (t.policies ?? []).flatMap((p) => (p.permission_groups ?? []).map((g) => g.name))
      const tag = t.id === selfId ? "THIS CREDENTIAL" : managed.has(t.name) ? "managed here" : "NOT MANAGED HERE"
      console.log(`  [${tag}] ${t.name}  id ${t.id}  ${t.status}  issued ${t.issued_on ?? "-"}  last used ${t.last_used_on ?? "never"}  expires ${t.expires_on ?? "never"}`)
      console.log(`      ${groups.length > 12 ? `${groups.length} permission groups` : groups.join(", ") || "(no permission groups listed)"}`)
    }
  } catch (error) {
    console.log(`  could not read tokens: ${error.message}`)
  }
}

// The audit log reaches back to before the backdoored builds of 2026-09-21.
const SNAPSHOT_SINCE = "2026-08-01T00:00:00Z"
const KNOWN_SCRIPTS = ["frizz-relay", "frizz-registrar"]
// The registry the relay trusts for name-to-key. A write here re-points a board's name with no upload.
const WATCHED_CLAIM = "claim:colin"

/** Everything a token holder could leave behind besides a Worker build. A surprise in any of it is a finding. */
export function accountEndpoints(accountId, since) {
  const account = `/accounts/${accountId}`
  return [
    { name: "audit-log", path: `${account}/audit_logs?since=${since}&direction=desc`, perPage: 1000 },
    { name: "account-tokens", path: `${account}/tokens`, perPage: 50, tokens: true },
    { name: "user-tokens", path: "/user/tokens", perPage: 50, tokens: true },
    { name: "accounts", path: "/accounts", perPage: 50 },
    { name: "worker-domains", path: `${account}/workers/domains` },
    { name: "tunnels", path: `${account}/cfd_tunnel?is_deleted=false`, perPage: 100 },
    { name: "kv-namespaces", path: `${account}/storage/kv/namespaces`, perPage: 100 },
    { name: "r2-buckets", path: `${account}/r2/buckets` },
    { name: "d1-databases", path: `${account}/d1/database`, perPage: 100 },
    { name: "pages-projects", path: `${account}/pages/projects` },
    { name: "queues", path: `${account}/queues` },
    { name: "logpush-account", path: `${account}/logpush/jobs` },
    { name: "access-apps", path: `${account}/access/apps` },
    { name: "access-service-tokens", path: `${account}/access/service_tokens` },
    { name: "notification-policies", path: `${account}/alerting/v3/policies` },
    { name: "members", path: `${account}/members`, perPage: 50 },
    { name: "kv-claims-keys", path: `${account}/storage/kv/namespaces/${CLAIMS_NAMESPACE}/keys?limit=1000` },
    { name: "dispatch-namespaces", path: `${account}/workers/dispatch/namespaces` },
    { name: "account-rulesets", path: `${account}/rulesets` },
    { name: "account-custom-pages", path: `${account}/custom_pages` },
    { name: "web-analytics-sites", path: `${account}/rum/site_info/list` },
  ]
}

export function zoneEndpoints(zoneId) {
  const zone = `/zones/${zoneId}`
  return [
    { name: "routes", path: `${zone}/workers/routes` },
    { name: "dns", path: `${zone}/dns_records`, perPage: 100 },
    { name: "rulesets", path: `${zone}/rulesets` },
    { name: "page-rules", path: `${zone}/pagerules` },
    { name: "email-routing", path: `${zone}/email/routing/rules`, perPage: 50 },
    { name: "logpush-zone", path: `${zone}/logpush/jobs` },
    { name: "dnssec", path: `${zone}/dnssec` },
    { name: "custom-pages", path: `${zone}/custom_pages` },
    { name: "zaraz", path: `${zone}/settings/zaraz/config` },
    { name: "waiting-rooms", path: `${zone}/waiting_rooms` },
    { name: "page-shield", path: `${zone}/page_shield` },
    { name: "custom-hostnames", path: `${zone}/custom_hostnames` },
    { name: "load-balancers", path: `${zone}/load_balancers` },
    { name: "custom-certificates", path: `${zone}/custom_certificates` },
    { name: "spectrum-apps", path: `${zone}/spectrum/apps` },
    { name: "snippets", path: `${zone}/snippets` },
  ]
}

export function scriptEndpoints(accountId, script) {
  const base = `/accounts/${accountId}/workers/scripts/${script}`
  return [
    { name: `${script}.deployments`, path: `${base}/deployments` },
    { name: `${script}.versions`, path: `${base}/versions`, perPage: 50 },
    { name: `${script}.secret-names`, path: `${base}/secrets` },
    { name: `${script}.crons`, path: `${base}/schedules` },
    { name: `${script}.settings`, path: `${base}/settings` },
    { name: `${script}.subdomain`, path: `${base}/subdomain` },
    { name: `${script}.script-settings`, path: `${base}/script-settings` },
    // Listing live tails needs Workers Tail Read, which this token must never hold, so this read is
    // expected to be refused. It stays so that every snapshot says so.
    { name: `${script}.tails`, path: `${base}/tails` },
  ]
}

/** One endpoint's whole answer. A paged one is read until a short page; the versions API nests its list in `items`. */
async function readEndpoint(get, { path, perPage }) {
  if (!perPage) return (await get(path)).result
  const all = []
  for (let page = 1; page <= 50; page++) {
    const { result } = await get(`${path}${path.includes("?") ? "&" : "?"}per_page=${perPage}&page=${page}`)
    const items = Array.isArray(result) ? result : (result?.items ?? [])
    all.push(...items)
    if (items.length < perPage) break
  }
  return all
}

/**
 * Saves the account as it stands to `outDir`, one raw JSON file per endpoint. A read Cloudflare refuses
 * is recorded and the run carries on, because a partial record beats none, and the caller says what it
 * could not see. `get` answers Cloudflare's whole envelope and throws on a refusal; `getBytes` answers
 * the raw body; `tokensGet` is `get` for the endpoints that list API tokens, which need their own credential.
 */
export async function snapshotAccount({ get, tokensGet = get, getBytes, outDir, accountId, zone, since, knownScripts }) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const write = (file, data) => writeFileSync(join(outDir, file), data, { mode: 0o600 })
  const saved = []
  const refused = []
  const take = async (endpoint) => {
    try {
      const result = await readEndpoint(endpoint.tokens ? tokensGet : get, endpoint)
      write(`${endpoint.name}.json`, JSON.stringify(result, null, 2))
      saved.push({ name: endpoint.name, count: Array.isArray(result) ? result.length : null })
      return result
    } catch (error) {
      refused.push({ name: endpoint.name, why: error.message })
      return null
    }
  }
  for (const endpoint of accountEndpoints(accountId, since)) await take(endpoint)
  const listed = await take({ name: "workers", path: `/accounts/${accountId}/workers/scripts` })
  const zones = await take({ name: "zones", path: `/zones?name=${zone}&account.id=${accountId}` })
  for (const { id } of zones ?? []) for (const endpoint of zoneEndpoints(id)) await take(endpoint)
  // A Workers Builds connection deploys on a push and skips the deploy environment entirely.
  for (const { id, tag } of listed ?? []) {
    if (tag) await take({ name: `${id}.builds-triggers`, path: `/accounts/${accountId}/builds/workers/${tag}/triggers` })
  }
  try {
    write("claim-colin.value", await getBytes(`/accounts/${accountId}/storage/kv/namespaces/${CLAIMS_NAMESPACE}/values/${WATCHED_CLAIM}`))
    saved.push({ name: WATCHED_CLAIM, count: null })
  } catch (error) {
    refused.push({ name: WATCHED_CLAIM, why: error.message })
  }
  const scripts = [...new Set([...(listed ?? []).map((w) => w.id), ...knownScripts])]
  for (const script of scripts) {
    for (const endpoint of scriptEndpoints(accountId, script)) await take(endpoint)
    try {
      write(`${script}.deployed-code.multipart`, await getBytes(`/accounts/${accountId}/workers/scripts/${script}`))
      saved.push({ name: `${script}.deployed-code`, count: null })
    } catch (error) {
      refused.push({ name: `${script}.deployed-code`, why: error.message })
    }
  }
  return { saved, refused, scripts }
}

/** Calls `use` with a token minted for this one run, in memory only, and revokes it however `use` ends. */
async function withSnapshotToken(cf, use) {
  const groups = await cf("GET", `/accounts/${ACCOUNT_ID}/tokens/permission_groups`)
  const zones = await cf("GET", `/zones?name=${ZONE}&account.id=${ACCOUNT_ID}`)
  if (zones.length !== 1) throw new Error(`expected one zone named ${ZONE} in account ${ACCOUNT_ID}, found ${zones.length}`)
  const { policies, missing, skipped } = planToken(SNAPSHOT_TOKEN, { groups, accountId: ACCOUNT_ID, zoneId: zones[0].id, granted: grantedScopes() })
  if (missing.length) throw new Error(`permission groups not found, nothing minted: ${missing.join(", ")}`)
  if (skipped.length) console.log(`\nsnapshot token: not offered, so skipped: ${skipped.join(", ")}`)
  const created = await cf("POST", `/accounts/${ACCOUNT_ID}/tokens`, { name: SNAPSHOT_TOKEN.name, policies, expires_on: expiresOn(Date.now(), SNAPSHOT_TOKEN_DAYS) })
  console.log(`\nminted ${SNAPSHOT_TOKEN.name} (${created.id}), expires ${created.expires_on}`)
  try {
    recordMinted(created.id, SNAPSHOT_TOKEN.name)
    // A new token can answer 401 for its first moments, and a snapshot would record that as a refusal.
    const verify = client(created.value)
    for (let attempt = 1; ; attempt++) {
      try {
        await verify("GET", `/accounts/${ACCOUNT_ID}/tokens/verify`)
        break
      } catch (error) {
        if (attempt === 10) throw error
        await setTimeout(1000)
      }
    }
    return await use(created.value)
  } finally {
    await cf("DELETE", `/accounts/${ACCOUNT_ID}/tokens/${created.id}`)
    console.log(`revoked ${SNAPSHOT_TOKEN.name} (${created.id})`)
  }
}

function reader(token) {
  const request = async (path) => {
    const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response
  }
  return {
    get: async (path) => {
      const parsed = await (await request(path)).json()
      if (!parsed?.success) throw new Error((parsed?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") || "not successful")
      return parsed
    },
    getBytes: async (path) => Buffer.from(await (await request(path)).arrayBuffer()),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    const flag = (name) => args.includes(name)
    const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",")
    const credential = (process.env.CLOUDFLARE_FRIZZ_MINTER ?? "").trim()
    if (!credential) {
      console.error("no credential: set CLOUDFLARE_FRIZZ_MINTER, see this file's header")
      process.exit(1)
    }
    const cf = client(credential)
    const me = await whoAmI(cf)
    console.log(me.kind === "oauth" ? `credential: OAuth sign-in, expires ${me.expires_on}` : `credential: ${me.kind}-owned token ${me.id}, ${me.status}, expires ${me.expires_on ?? "never"}`)
    if (me.kind === "user") await reachOf(cf, me.id)

    if (flag("--audit")) {
      await audit(cf, me.id)
      const outDir = args.find((a) => a.startsWith("--out="))?.slice("--out=".length)
      if (outDir) {
        const { saved, refused, scripts } = await withSnapshotToken(cf, (token) =>
          snapshotAccount({ ...reader(token), tokensGet: reader(credential).get, outDir, accountId: ACCOUNT_ID, zone: ZONE, since: SNAPSHOT_SINCE, knownScripts: KNOWN_SCRIPTS }),
        )
        console.log(`\n== Snapshot in ${outDir}: Workers ${scripts.join(", ")}`)
        for (const { name, count } of saved) console.log(`  ${name}${count === null ? "" : `: ${count}`}`)
        for (const { name, why } of refused) console.log(`  COULD NOT READ ${name}: ${why}`)
      }
      process.exit(0)
    }

    if (flag("--revoke-deploy")) {
      const deploy = TOKENS.find((t) => t.key === "deploy")
      for (const token of await listTokens(cf)) {
        if (token.name !== deploy.name) continue
        await cf("DELETE", `/accounts/${ACCOUNT_ID}/tokens/${token.id}`)
        console.log(`revoked ${token.name} (${token.id})`)
      }
      const failure = removeFromSink(deploy.sink)
      if (failure) throw new Error(`the token is revoked, but ${describeSink(deploy.sink)} is still set: ${failure}`)
      console.log(`emptied ${describeSink(deploy.sink)}`)
      await audit(cf, me.id)
      process.exit(0)
    }

    const groups = await cf("GET", `/accounts/${ACCOUNT_ID}/tokens/permission_groups`)
    const zones = await cf("GET", `/zones?name=${ZONE}&account.id=${ACCOUNT_ID}`)
    if (zones.length !== 1) throw new Error(`expected one zone named ${ZONE} in account ${ACCOUNT_ID}, found ${zones.length}`)
    const specs = TOKENS.filter((t) => !only || only.includes(t.key))
    const plans = specs.map((spec) => ({ spec, ...planToken(spec, { groups, accountId: ACCOUNT_ID, zoneId: zones[0].id, granted: grantedScopes() }) }))
    const missing = plans.flatMap((p) => p.missing.map((m) => `${p.spec.name}: ${m}`))
    if (missing.length) {
      const near = groups.filter((g) => /Workers|Zone|DNS|Account Settings|API Tokens/.test(g.name)).map((g) => g.name)
      throw new Error(`permission groups not found, nothing minted:\n  ${missing.join("\n  ")}\nnearby names: ${[...new Set(near)].sort().join(", ")}`)
    }
    for (const p of plans) {
      const names = p.policies.flatMap((pol) => pol.permission_groups.map((g) => g.name))
      const shown = names.length > 12 ? `${names.length} permission groups` : names.join(", ")
      console.log(`\n${p.spec.name} -> ${describeSink(p.spec.sink)}\n  ${shown}${p.skipped.length ? `  (skipped, not offered: ${p.skipped.join(", ")})` : ""}`)
    }
    if (flag("--dry-run")) {
      // What a narrower deploy token could be built from, which only the real list can say.
      console.log("\nWorkers permission groups this account offers:")
      for (const g of groups.filter((g) => /Worker/.test(g.name))) console.log(`  ${g.name}  [${(g.scopes ?? []).join(", ")}]`)
      console.log("\n--dry-run: nothing minted")
      process.exit(0)
    }

    const existing = await listTokens(cf).catch((error) => {
      console.error(`could not list the account's tokens (${error.message}); older tokens of these names are not revoked, see the audit`)
      return []
    })
    for (const p of plans) {
      const created = await cf("POST", `/accounts/${ACCOUNT_ID}/tokens`, { name: p.spec.name, policies: p.policies, expires_on: expiresOn(Date.now(), p.spec.expiresDays) })
      recordMinted(created.id, p.spec.name)
      const failure = deliver(p.spec.sink, created.value) ?? (p.spec.authorVariable ? recordId(p.spec.authorVariable, created.id, p.spec.name) : null)
      if (failure) {
        await cf("DELETE", `/accounts/${ACCOUNT_ID}/tokens/${created.id}`).catch(() => {})
        throw new Error(`${p.spec.name}: ${failure} — the new token ${created.id} was revoked again`)
      }
      console.log(`\nminted ${p.spec.name} (${created.id}), expires ${created.expires_on}, into ${describeSink(p.spec.sink)}`)
      for (const old of staleTokens(existing, p.spec.name, new Set([created.id, me.id]))) {
        await cf("DELETE", `/accounts/${ACCOUNT_ID}/tokens/${old.id}`)
        console.log(`  revoked the older ${old.name} (${old.id})`)
      }
    }

    await audit(cf, me.id)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
