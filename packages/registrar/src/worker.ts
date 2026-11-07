import {
  handleClaim,
  sweepExpiredClaims,
  type ClaimRecord,
  type ClaimStore,
  type GithubIdentity,
} from "./claim-handler.ts"
import { createCloudflareApi } from "./cloudflare.ts"
import { FRIZZ_GITHUB_APP_CLIENT_ID } from "@frizz/shared"

/**
 * The registration Worker for `<name>.frizz.sh`.
 *
 * It runs during signup and never again — it is not on the data plane, so a board that is already
 * running keeps working whether or not this is up. Protecting that property is worth more than any
 * other choice here: nothing in Frizz should ever have to reach this to stay reachable.
 */

/**
 * Structural only, so this package needs no `@cloudflare/workers-types`.
 *
 * A real `KVNamespace` satisfies this. Declaring only the methods actually used keeps the registrar
 * typecheckable by the repo's ordinary Node tsconfig, which knows nothing about workerd.
 */
export interface KvNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }>
}

/**
 * Ask GitHub who a token belongs to, then forget the token.
 *
 * Only the numeric id is kept. A login can be renamed and reused by someone else, so binding a name
 * to one would let the limit be laundered through a rename.
 *
 * ONLY FRIZZ'S OWN GITHUB SIGN-IN IS ACCEPTED: a user token GitHub reports, in `X-OAuth-Client-Id` on
 * that same `/user` answer, as issued to Frizz's GitHub App, "Frizz Agent Console". It is the token the
 * board already holds for its GitHub reads, and its powers are the App's read-only permissions. A `gh`
 * CLI token (what a Frizz from before 2026-10-08 sends), a personal access token, or a token from any
 * other app is refused as "foreign", whoever it belongs to. So is anything GitHub does not tie to an
 * app at all. That also means a token some other app collected cannot claim in its owner's name.
 *
 * Until 2026-11-07 only a zero-scope OAuth token was accepted, so that a hijacked registrar collected
 * nothing worth stealing (a compromised build collected `gh` tokens from 2026-09-21 to 2026-10-08).
 * The maintainer dropped that rule (2026-11-07): this Worker deploys from the same workflow, with the
 * same token and the same approval, as the relay, and a hijacked relay already has full control of
 * every board that serves through it. What still protects the token: it goes to GitHub's `/user` once,
 * only the numeric id is kept, and it is never stored or logged.
 */
export function githubVerifier(
  // Wrapped, not passed bare: workerd throws "Illegal invocation" for a `fetch` called off its global.
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  apiOrigin = "https://api.github.com",
  appClientId: string = FRIZZ_GITHUB_APP_CLIENT_ID
): (token: string) => Promise<GithubIdentity | null | "foreign"> {
  return async (token) => {
    // Anything else cannot be a GitHub token, and must never reach a request header.
    if (token.length > MAX_GITHUB_TOKEN_LENGTH || !/^[A-Za-z0-9_]+$/.test(token)) return null
    try {
      const response = await fetchImpl(`${apiOrigin}/user`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          // GitHub rejects an API request with no user agent.
          "user-agent": "frizz-registrar",
        },
        // A redirect is never followed: it would carry the token's request somewhere else.
        redirect: "manual",
      })
      if (!response.ok) return null
      if (response.headers.get("x-oauth-client-id") !== appClientId) return "foreign"
      const user = (await response.json()) as { id?: unknown; login?: unknown; created_at?: unknown }
      if (typeof user.id !== "number" || typeof user.login !== "string") return null
      const createdAt = typeof user.created_at === "string" ? Date.parse(user.created_at) : Number.NaN
      return { id: user.id, login: user.login, createdAt: Number.isNaN(createdAt) ? 0 : createdAt }
    } catch {
      return null
    }
  }
}

/** A real token is far shorter (a `ghu_` token is 40 characters). Keeps an absurd value out of a header. */
const MAX_GITHUB_TOKEN_LENGTH = 512

/** A claim is a few hundred bytes. Anything far past that is refused before it is parsed. */
const MAX_CLAIM_BODY_BYTES = 8_192

export interface RegistrarEnv {
  /** Zone-scoped Cloudflare token. NEVER leaves this Worker. */
  CF_API_TOKEN: string
  CF_ACCOUNT_ID: string
  CF_ZONE_ID: string
  /** The apex names hang off, e.g. `frizz.sh`. */
  FRIZZ_ZONE: string
  /** "0" turns the GitHub gate OFF. Anything else, including absent, leaves it ON. */
  REQUIRE_GITHUB?: string
  /** Overrides the built-in name ceiling, so a plan upgrade needs no deploy. */
  MAX_NAMES?: string
  /** "tunnel" restores per-name Cloudflare tunnels. Anything else, including absent, means relay. */
  CLOUD_MODE?: string
  CLAIMS: KvNamespace
}

/** A GitHub account younger than this cannot claim, which blunts throwaway-account squatting. */
const MIN_GITHUB_ACCOUNT_AGE_MS = 30 * 24 * 60 * 60_000

/**
 * New ANONYMOUS names one network address may mint per hour.
 *
 * Anonymous claims have no GitHub gate, so this is their entire cost. Generous on purpose: a person
 * setting up every machine they own in one sitting stays far under it, while the loop that would mint
 * keys until the namespace ceiling stopped all signups hits it on its tenth iteration. Renewals are
 * never counted — the handler consults the budget only when creating.
 */
const ANONYMOUS_CLAIMS_PER_HOUR = 10

/**
 * GitHub lookups one network address may set off per hour, for first claims of CUSTOM names.
 *
 * Every such claim sends GitHub one `/user` request, and a loop of generated keys with made-up tokens
 * would otherwise turn this Worker into a cheap way to hammer GitHub from Cloudflare's addresses. A
 * person claims one name per account, so ten an hour never touches them.
 */
const GITHUB_LOOKUPS_PER_HOUR = 10

/**
 * A per-address creation budget on one KV counter per hour bucket.
 *
 * KV is eventually consistent, so two racing claims can both read the same count and one slips past —
 * this is a blunt guard against a runaway loop, not an exact quota, and an exact one would need
 * storage this Worker deliberately does not have. The row expires on its own; nothing sweeps it.
 */
function kvHourlyBudget(kv: KvNamespace, key: string, perHour: number, now: () => number): () => Promise<boolean> {
  return async () => {
    const bucket = Math.floor(now() / 3_600_000)
    const row = `${key}:${bucket}`
    const used = Number((await kv.get(row)) ?? "0")
    if (used >= perHour) return false
    // TTL of two hours, not one: the row only has to outlive its own bucket, and cutting it close
    // would let a claim land in a bucket whose counter had already expired mid-hour.
    await kv.put(row, String(used + 1), { expirationTtl: 7_200 })
    return true
  }
}

/** New anonymous names from one address (ANONYMOUS_CLAIMS_PER_HOUR). */
export function kvAnonymousBudget(kv: KvNamespace, address: string, now: () => number = Date.now): () => Promise<boolean> {
  return kvHourlyBudget(kv, `anonrl:${address}`, ANONYMOUS_CLAIMS_PER_HOUR, now)
}

/** GitHub lookups from one address (GITHUB_LOOKUPS_PER_HOUR). */
export function kvGithubBudget(kv: KvNamespace, address: string, now: () => number = Date.now): () => Promise<boolean> {
  return kvHourlyBudget(kv, `ghrl:${address}`, GITHUB_LOOKUPS_PER_HOUR, now)
}

/**
 * How many names the zone may hold.
 *
 * The free plan caps a zone at 200 DNS RECORDS and one name costs one, so the ceiling is shared with
 * every infrastructure record — the apex, www, the registrar's own hostname. Stopping short of it
 * leaves room for those to be added without a claim having already eaten the last slot.
 *
 * Raise this after upgrading the zone to Pro, which lifts the record cap to 3,500.
 */
const MAX_NAMES = 180

/**
 * Relay mode has no per-name DNS record, so the zone's 200-record cap no longer bounds the namespace.
 * The ceiling stays only as a blunt guard against a runaway, at a level no real launch would reach.
 */
const MAX_NAMES_RELAY = 100_000

/** KV holds one small JSON row per name: who owns it, which tunnel serves it, and its lease. */
export function kvClaimStore(kv: KvNamespace): ClaimStore {
  return {
    async read(name) {
      const raw = await kv.get(`claim:${name}`)
      if (!raw) return null
      try {
        return JSON.parse(raw) as ClaimRecord
      } catch {
        // A row we cannot parse is treated as absent rather than fatal. The name then behaves as
        // unclaimed, which is recoverable; throwing would make one bad row a permanent 500 for a
        // hostname nobody can release.
        return null
      }
    },
    async write(name, record) {
      await kv.put(`claim:${name}`, JSON.stringify(record))
    },
    async remove(name) {
      await kv.delete(`claim:${name}`)
    },
    async readGithubOwner(githubId) {
      return kv.get(`gh:${githubId}`)
    },
    async writeGithubOwner(githubId, name) {
      await kv.put(`gh:${githubId}`, name)
    },
    async removeGithubOwner(githubId) {
      await kv.delete(`gh:${githubId}`)
    },
    async readOwner(pubkey) {
      return kv.get(`owner:${pubkey}`)
    },
    async writeOwner(pubkey, name) {
      await kv.put(`owner:${pubkey}`, name)
    },
    async removeOwner(pubkey) {
      await kv.delete(`owner:${pubkey}`)
    },
    async list() {
      // KV pages its listing, and a page boundary is invisible from one call. Following the cursor is
      // what stops the sweeper from silently only ever seeing the first 1,000 names.
      const names: string[] = []
      let cursor: string | undefined
      for (;;) {
        const page = await kv.list({ prefix: "claim:", ...(cursor ? { cursor } : {}) })
        for (const key of page.keys) names.push(key.name.slice("claim:".length))
        if (page.list_complete || !page.cursor) return names
        cursor = page.cursor
      }
    },
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })

function claimDeps(env: RegistrarEnv, budgets: { anonymousBudget?: () => Promise<boolean>; githubBudget?: () => Promise<boolean> } = {}) {
  return {
    ...budgets,
    // RELAY by default: a claim records the name and nothing else, because the relay serves every
    // name off one wildcard record. `CLOUD_MODE=tunnel` restores per-name tunnel provisioning for one
    // release, so the old path can be turned back on without a rebuild.
    ...(env.CLOUD_MODE === "tunnel"
      ? {
          api: createCloudflareApi({
            token: env.CF_API_TOKEN,
            accountId: env.CF_ACCOUNT_ID,
            zoneId: env.CF_ZONE_ID,
          }),
        }
      : {}),
    store: kvClaimStore(env.CLAIMS),
    zone: env.FRIZZ_ZONE,
    now: () => Date.now(),
    // ON unless explicitly disabled. A gate that defaults off is a gate that ships off by accident.
    maxNames: env.MAX_NAMES ? Number(env.MAX_NAMES) : env.CLOUD_MODE === "tunnel" ? MAX_NAMES : MAX_NAMES_RELAY,
    ...(env.REQUIRE_GITHUB === "0"
      ? {}
      : { github: githubVerifier(), minAccountAgeMs: MIN_GITHUB_ACCOUNT_AGE_MS }),
  }
}

export default {
  /**
   * Return lapsed names to the pool.
   *
   * Without this the two capped resources — 200 DNS records in the zone, 1,000 tunnels in the account
   * — fill up with names nobody uses any more, and new signups stop for a reason nothing points at.
   * The claim path releases a lapsed name on demand, but only when somebody asks for that exact name.
   */
  async scheduled(_event: unknown, env: RegistrarEnv): Promise<void> {
    const deps = claimDeps(env)
    // Counted BEFORE the sweep. KV's list is eventually consistent, so reading it straight after a
    // batch of deletes still reports the rows just removed — the first live run logged "1/180 in use"
    // having just emptied the namespace. Subtracting what was released is both accurate and cheap.
    const before = (await deps.store.list()).length
    const result = await sweepExpiredClaims(deps)
    // The only regular look at how full the namespace is. Nothing else would notice it filling until
    // a claim failed, which is exactly the surprise the ceiling should never be.
    const taken = before - result.released.length
    const ceiling = deps.maxNames ?? Infinity
    if (taken >= ceiling * 0.8) {
      console.warn(`namespace is ${taken}/${ceiling} full — upgrade the zone before it stops accepting names`)
    }
    // Worker logs are the only place a sweep is visible, so say what happened even when it is nothing.
    console.log(
      `swept ${result.released.length} expired name(s)` +
        `${result.failed.length ? `, ${result.failed.length} failed: ${result.failed.join(", ")}` : ""}` +
        `${result.remaining ? `, ${result.remaining} left for the next run` : ""}` +
        `; ${taken}/${ceiling} names in use`
    )
  },

  async fetch(request: Request, env: RegistrarEnv): Promise<Response> {
    const url = new URL(request.url)
    // Who owns a name, for workers-drift, which holds nothing that can read KV. Public on purpose: a
    // public key and a date give a visitor nothing to use, and asking takes knowing the name already.
    const lookup = /^\/claim\/([a-z0-9-]+)$/.exec(url.pathname)
    if (lookup) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } })
      const record = await kvClaimStore(env.CLAIMS).read(lookup[1]!)
      if (!record) return json(404, { error: "not-found" })
      return json(200, { pubkey: record.pubkey, renewedAt: record.renewedAt })
    }
    if (url.pathname !== "/claim") return json(404, { error: "not-found" })
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } })
    }

    // A body that is not JSON is the claimant's mistake, not a crash. The handler validates
    // everything past this point, including that the thing parsed is shaped like a claim at all.
    if (Number(request.headers.get("content-length") ?? "0") > MAX_CLAIM_BODY_BYTES) {
      return json(413, { error: "malformed", message: "the request body was not a claim" })
    }
    const text = await request.text().catch(() => "")
    if (text.length > MAX_CLAIM_BODY_BYTES) return json(413, { error: "malformed", message: "the request body was not a claim" })
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {}

    // The budget key is the connecting address, which Cloudflare stamps on every request it fronts.
    // Absent (a direct hit on the Worker in a test) the budget still exists under one shared key,
    // because an absent header must never mean an absent limit.
    const address = request.headers.get("cf-connecting-ip") ?? "unknown"
    const outcome = await handleClaim(
      body,
      claimDeps(env, { anonymousBudget: kvAnonymousBudget(env.CLAIMS, address), githubBudget: kvGithubBudget(env.CLAIMS, address) })
    )

    return json(outcome.status, outcome.body)
  },
}
