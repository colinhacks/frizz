// Mints the Cloudflare API tokens the frizz.sh CI uses, and hands each one straight to the GitHub
// secret that holds it, so none is ever in a file, an argv, a terminal or a transcript:
//
//   github-actions workers-deploy   Workers Scripts Edit, Workers Routes Edit on frizz.sh
//                                   -> CLOUDFLARE_API_TOKEN in the `workers-deploy` environment
//   github-actions workers-drift    Workers Scripts Read
//                                   -> the repository secret CLOUDFLARE_READ_TOKEN
//
// WHY. From 2026-09-21 to 2026-10-08 an attacker deployed backdoored builds of both frizz.sh Workers
// with a Cloudflare token copied off the maintainer's disk (`~/.frizz-cf-token`, a plain file). Now
// the token that can deploy lives only in a GitHub environment that waits for the maintainer's
// approval. The laptop holds no Cloudflare API token at all: it signs wrangler in through Keyward,
// which keeps the sign-in sealed (the global `cloudflare` skill).
//
// THE CREDENTIAL is a short-lived dashboard token with Account API Tokens Edit, Account Settings Read
// and Zone Read, on stdin (a Frizz `kind: secret` pipe). `--stash-bootstrap` seals it in Keyward as
// CLOUDFLARE_BOOTSTRAP_TOKEN first, so a failed run is retried under `keyward run` rather than with a
// new token. Once both tokens are in place it revokes itself and leaves Keyward.
//
// ROTATION is a re-run on a fresh dashboard token: each new token is in place before the older tokens
// of the same name are revoked. Every run ends with an audit of the account's members and API tokens,
// flagging any token this script does not manage; `--audit` runs the audit alone.
//
//   env -u NODE_COMPAT nub scripts/cloudflare-tokens.mjs --stash-bootstrap [--only=deploy,drift] [--dry-run] < '<secret pipe>'
//   keyward run --reason "…" CLOUDFLARE_BOOTSTRAP_TOKEN -- env -u NODE_COMPAT nub scripts/cloudflare-tokens.mjs
//   keyward run --reason "audit the Frizz Cloudflare account" CLOUDFLARE_BOOTSTRAP_TOKEN -- env -u NODE_COMPAT nub scripts/cloudflare-tokens.mjs --audit

import { spawnSync } from "node:child_process"
import { ghCommand } from "./lib/gh-command.mjs"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ACCOUNT_ID } from "./workers-drift.mjs"

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
    zone: ["Workers Routes Write"],
    sink: { kind: "gh", secret: "CLOUDFLARE_API_TOKEN", env: "workers-deploy" },
  },
  {
    key: "drift",
    name: "github-actions workers-drift",
    account: ["Workers Scripts Read"],
    zone: [],
    sink: { kind: "gh", secret: "CLOUDFLARE_READ_TOKEN" },
  },
]

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
export function planToken(spec, { groups, accountId, zoneId }) {
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
      if (group) return [group]
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

/** Hand `value` to its sink on stdin. Returns null on success, or what went wrong (never the value). */
function deliver(sink, value, repoRoot) {
  // `keyward set` stores for the repository the current directory belongs to, so it runs from here.
  const [command, args] =
    sink.kind === "gh"
      ? ghCommand(`Store the ${sink.secret} secret on ${REPO}`, ["secret", "set", sink.secret, "--repo", REPO, ...(sink.env ? ["--env", sink.env] : [])])
      : ["keyward", ["set", ...(sink.about ? ["--about", sink.about] : []), sink.secret]]
  const result = spawnSync(command, args, { input: value, cwd: repoRoot, encoding: "utf8" })
  if (result.error) return `${command} did not start: ${result.error.message}`
  if (result.status !== 0) return `${command} ${args.slice(0, 3).join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`
  return null
}

function describeSink(sink) {
  if (sink.kind === "keyward") return `Keyward ${sink.secret} (repository ${REPO})`
  return sink.env ? `GitHub environment ${sink.env} secret ${sink.secret}` : `GitHub repository secret ${sink.secret}`
}

async function readStdin() {
  if (process.stdin.isTTY) return ""
  let data = ""
  for await (const chunk of process.stdin) data += chunk
  return data
}

async function whoAmI(cf) {
  try {
    return { kind: "account", ...(await cf("GET", `/accounts/${ACCOUNT_ID}/tokens/verify`)) }
  } catch (error) {
    // Cloudflare answers a token of the other kind with anything from 400 to 404.
    if (!(error.status >= 400 && error.status < 500)) throw error
    return { kind: "user", ...(await cf("GET", "/user/tokens/verify")) }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    const flag = (name) => args.includes(name)
    const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",")
    const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

    const env = process.env
    const fromStdin = !env.CLOUDFLARE_BOOTSTRAP_TOKEN
    const credential = (env.CLOUDFLARE_BOOTSTRAP_TOKEN || (await readStdin())).trim()
    if (!credential) {
      console.error("no credential: pipe a bootstrap token on stdin, or run under `keyward run … CLOUDFLARE_BOOTSTRAP_TOKEN --`")
      process.exit(1)
    }
    const cf = client(credential)
    const me = await whoAmI(cf)
    console.log(`credential: bootstrap ${me.kind}-owned token ${me.id}, ${me.status}, expires ${me.expires_on ?? "never"}`)

    if (flag("--stash-bootstrap")) {
      if (!fromStdin) throw new Error("--stash-bootstrap seals a token read from stdin; this one is already in the environment")
      const bootstrap = { kind: "keyward", secret: "CLOUDFLARE_BOOTSTRAP_TOKEN", about: "Cloudflare, one-day token that mints the frizz.sh CI tokens" }
      const failure = deliver(bootstrap, credential, repoRoot)
      if (failure) throw new Error(`could not stash the bootstrap token: ${failure}`)
      console.log("bootstrap sealed in Keyward as CLOUDFLARE_BOOTSTRAP_TOKEN, so a retry needs no new token")
    }

    if (flag("--audit")) {
      await audit(cf, me.id)
      process.exit(0)
    }

    const groups = await cf("GET", `/accounts/${ACCOUNT_ID}/tokens/permission_groups`)
    const zones = await cf("GET", `/zones?name=${ZONE}&account.id=${ACCOUNT_ID}`)
    if (zones.length !== 1) throw new Error(`expected one zone named ${ZONE} in account ${ACCOUNT_ID}, found ${zones.length}`)
    const specs = TOKENS.filter((t) => !only || only.includes(t.key))
    const plans = specs.map((spec) => ({ spec, ...planToken(spec, { groups, accountId: ACCOUNT_ID, zoneId: zones[0].id }) }))
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
      console.log("\n--dry-run: nothing minted")
      process.exit(0)
    }

    const existing = await listTokens(cf).catch((error) => {
      console.error(`could not list the account's tokens (${error.message}); older tokens of these names are not revoked, see the audit`)
      return []
    })
    for (const p of plans) {
      const created = await cf("POST", `/accounts/${ACCOUNT_ID}/tokens`, { name: p.spec.name, policies: p.policies, expires_on: expiresOn(Date.now()) })
      const failure = deliver(p.spec.sink, created.value, repoRoot)
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

    // Both tokens are in place, so the bootstrap has done its job: it goes, from Cloudflare and Keyward.
    await cf("DELETE", me.kind === "account" ? `/accounts/${ACCOUNT_ID}/tokens/${me.id}` : `/user/tokens/${me.id}`).then(
      () => console.log(`\nrevoked the bootstrap token (${me.id})`),
      (error) => console.error(`\ncould not revoke the bootstrap token (${me.id}): ${error.message}; delete it in the dashboard`),
    )
    const rm = spawnSync("keyward", ["rm", "CLOUDFLARE_BOOTSTRAP_TOKEN"], { cwd: repoRoot, encoding: "utf8" })
    if (rm.status === 0) console.log("removed CLOUDFLARE_BOOTSTRAP_TOKEN from Keyward")
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
