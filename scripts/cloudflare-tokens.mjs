// Mints the Cloudflare API tokens frizz.sh runs on, and hands each one straight to the one place
// that uses it, so no Cloudflare token is ever in a file, an argv, a terminal or a transcript:
//
//   github-actions workers-deploy   Workers Scripts Edit, Workers Routes Edit on frizz.sh
//                                   -> CLOUDFLARE_API_TOKEN in the `workers-deploy` environment
//   github-actions workers-drift    Workers Scripts Read
//                                   -> the repository secret CLOUDFLARE_READ_TOKEN
//   laptop read-only (Keyward)      reads the account and the frizz.sh zone, writes nothing
//                                   -> Keyward's CLOUDFLARE_API_TOKEN for this repository
//
// WHY. From 2026-09-21 to 2026-10-08 an attacker deployed backdoored builds of both frizz.sh Workers
// with a Cloudflare token copied off the maintainer's disk (`~/.frizz-cf-token`, a plain file). Now
// the token that can deploy lives only in a GitHub environment that waits for the maintainer's
// approval, and the laptop holds a token that cannot change anything, sealed in Keyward and released
// to one command per Touch ID. A Worker change goes through workers-deploy.yml; anything else that
// writes uses a token minted for that one task.
//
// INPUT: a short-lived BOOTSTRAP token, account-owned, with Account API Tokens Edit, Account Settings
// Read and Zone Read, in CLOUDFLARE_BOOTSTRAP_TOKEN or on stdin (a Frizz `kind: secret` pipe). It
// mints these three tokens and nothing else. `--stash-bootstrap` also seals it in Keyward, so a
// re-run costs a Touch ID rather than a new token; `--delete-bootstrap` revokes it when the job is
// done (then `keyward rm CLOUDFLARE_BOOTSTRAP_TOKEN`).
//
// ROTATION is a re-run: each new token is in place before the older tokens of the same name are
// revoked. Every run ends with an audit of the account's members and API tokens, flagging any token
// this script does not manage.
//
//   nub scripts/cloudflare-tokens.mjs --stash-bootstrap < '<secret pipe>'
//   keyward run --reason "…" CLOUDFLARE_BOOTSTRAP_TOKEN -- nub scripts/cloudflare-tokens.mjs [--only=deploy,drift,laptop] [--dry-run]
//   keyward run --reason "…" CLOUDFLARE_BOOTSTRAP_TOKEN -- nub scripts/cloudflare-tokens.mjs --audit
//   keyward run --reason "…" CLOUDFLARE_BOOTSTRAP_TOKEN -- nub scripts/cloudflare-tokens.mjs --delete-bootstrap

import { spawnSync } from "node:child_process"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ACCOUNT_ID } from "./workers-drift.mjs"

export const REPO = "colinhacks/frizz"
export const ZONE = "frizz.sh"
export const EXPIRES_DAYS = 365
const API = "https://api.cloudflare.com/client/v4"
const ACCOUNT_SCOPE = "com.cloudflare.api.account"
const ZONE_SCOPE = "com.cloudflare.api.account.zone"

// A trailing `?` marks a permission the token is still useful without: missing from the account's
// permission groups, it is skipped with a warning rather than failing the run.
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
  {
    key: "laptop",
    name: "laptop read-only (Keyward)",
    account: ["Account Settings Read", "Workers Scripts Read", "Workers KV Storage Read", "Workers Tail Read?", "Account API Tokens Read?"],
    zone: ["Zone Read", "DNS Read", "Workers Routes Read"],
    sink: { kind: "keyward", secret: "CLOUDFLARE_API_TOKEN" },
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
 * The policies for one token spec, or a list of the required groups the account does not have.
 * Account groups apply to this account; zone groups to the one zone.
 */
export function planToken(spec, { groups, accountId, zoneId }) {
  const missing = []
  const skipped = []
  const resolve = (names, scope) =>
    names.flatMap((raw) => {
      const optional = raw.endsWith("?")
      const name = optional ? raw.slice(0, -1) : raw
      const group = findGroup(groups, name, scope)
      if (group) return [{ id: group.id, name: group.name }]
      ;(optional ? skipped : missing).push(name)
      return []
    })
  const accountGroups = resolve(spec.account, ACCOUNT_SCOPE)
  const zoneGroups = resolve(spec.zone, ZONE_SCOPE)
  const policies = []
  if (accountGroups.length) policies.push({ effect: "allow", resources: { [`${ACCOUNT_SCOPE}.${accountId}`]: "*" }, permission_groups: accountGroups })
  if (zoneGroups.length) policies.push({ effect: "allow", resources: { [`${ZONE_SCOPE}.${zoneId}`]: "*" }, permission_groups: zoneGroups })
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
  const [command, args] =
    sink.kind === "gh"
      ? ["gh", ["secret", "set", sink.secret, "--repo", REPO, ...(sink.env ? ["--env", sink.env] : [])]]
      : ["keyward", ["set", sink.secret]]
  const result = spawnSync(command, args, { input: value, cwd: repoRoot, encoding: "utf8" })
  if (result.error) return `${command} did not start: ${result.error.message}`
  if (result.status !== 0) return `${command} ${args.slice(0, 3).join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`
  return null
}

function describeSink(sink) {
  return sink.kind === "gh"
    ? sink.env
      ? `GitHub environment ${sink.env} secret ${sink.secret}`
      : `GitHub repository secret ${sink.secret}`
    : `Keyward ${sink.secret} (repository ${REPO})`
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
      const groups = (t.policies ?? []).flatMap((p) => (p.permission_groups ?? []).map((g) => g.name)).join(", ")
      const tag = t.id === selfId ? "THIS BOOTSTRAP" : managed.has(t.name) ? "managed here" : "NOT MANAGED HERE"
      console.log(`  [${tag}] ${t.name}  id ${t.id}  ${t.status}  issued ${t.issued_on ?? "-"}  last used ${t.last_used_on ?? "never"}  expires ${t.expires_on ?? "never"}`)
      console.log(`      ${groups || "(no permission groups listed)"}`)
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

    // An audit only reads, so the laptop's Keyward token serves for it as well as the bootstrap.
    const bootstrap = (
      process.env.CLOUDFLARE_BOOTSTRAP_TOKEN ||
      (flag("--audit") ? process.env.CLOUDFLARE_API_TOKEN : "") ||
      (await readStdin())
    ).trim()
    if (!bootstrap) {
      console.error("no bootstrap token: set CLOUDFLARE_BOOTSTRAP_TOKEN (keyward run) or pipe it on stdin")
      process.exit(1)
    }
    const cf = client(bootstrap)
    const me = await whoAmI(cf)
    console.log(`bootstrap: ${me.kind}-owned token ${me.id}, ${me.status}, expires ${me.expires_on ?? "never"}`)

    if (flag("--stash-bootstrap")) {
      const failure = deliver({ kind: "keyward", secret: "CLOUDFLARE_BOOTSTRAP_TOKEN" }, bootstrap, repoRoot)
      if (failure) throw new Error(`could not stash the bootstrap token: ${failure}`)
      console.log("bootstrap sealed in Keyward as CLOUDFLARE_BOOTSTRAP_TOKEN (repository scope); `keyward rm` it once --delete-bootstrap has run")
    }

    if (flag("--delete-bootstrap")) {
      const path = me.kind === "account" ? `/accounts/${ACCOUNT_ID}/tokens/${me.id}` : `/user/tokens/${me.id}`
      await cf("DELETE", path)
      console.log(`revoked the bootstrap token ${me.id}`)
      process.exit(0)
    }

    if (!flag("--audit")) {
      const groups = await cf("GET", `/accounts/${ACCOUNT_ID}/tokens/permission_groups`)
      const zones = await cf("GET", `/zones?name=${ZONE}&account.id=${ACCOUNT_ID}`)
      if (zones.length !== 1) throw new Error(`expected one zone named ${ZONE} in account ${ACCOUNT_ID}, found ${zones.length}`)
      const zoneId = zones[0].id
      const specs = TOKENS.filter((t) => !only || only.includes(t.key))
      const plans = specs.map((spec) => ({ spec, ...planToken(spec, { groups, accountId: ACCOUNT_ID, zoneId }) }))
      const missing = plans.flatMap((p) => p.missing.map((m) => `${p.spec.name}: ${m}`))
      if (missing.length) {
        const near = groups.filter((g) => /Workers|Zone|DNS|Account Settings|API Tokens/.test(g.name)).map((g) => g.name)
        throw new Error(`permission groups not found, nothing minted:\n  ${missing.join("\n  ")}\nnearby names: ${[...new Set(near)].sort().join(", ")}`)
      }
      for (const p of plans) {
        const names = p.policies.flatMap((pol) => pol.permission_groups.map((g) => g.name)).join(", ")
        console.log(`\n${p.spec.name} -> ${describeSink(p.spec.sink)}\n  ${names}${p.skipped.length ? `  (skipped, not offered: ${p.skipped.join(", ")})` : ""}`)
      }
      if (flag("--dry-run")) {
        console.log("\n--dry-run: nothing minted")
      } else {
        const existing = await listTokens(cf)
        for (const p of plans) {
          const created = await cf("POST", `/accounts/${ACCOUNT_ID}/tokens`, {
            name: p.spec.name,
            policies: p.policies,
            expires_on: expiresOn(Date.now()),
          })
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
      }
    }

    await audit(cf, me.id)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
