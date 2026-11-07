import {
  CLAIM_LEASE_MS,
  claimLeaseExpired,
  isAnonymousClaimName,
  tunnelNameForClaim,
  verifyClaim,
  type ClaimRejection,
} from "@frizz/shared"

/**
 * The registrar's decision logic, with every side effect injected.
 *
 * This is where a name becomes a hostname. It holds no Cloudflare credentials and opens no sockets of
 * its own — the zone token lives in the Worker that wraps this, and never anywhere else, which is the
 * property the whole security argument rests on. Keeping the decisions here also means they can be
 * tested against fakes rather than against someone's real DNS zone.
 */

/** What we remember about a claimed name. The pubkey is the owner; the timestamps are the lease. */
export interface ClaimRecord {
  pubkey: string
  tunnelId: string
  port: number
  claimedAt: number
  renewedAt: number
  /** The GitHub user id this name was claimed under. Numeric, so a rename does not free the limit. */
  githubId?: number
}

export interface ClaimStore {
  read(name: string): Promise<ClaimRecord | null>
  write(name: string, record: ClaimRecord): Promise<void>
  remove(name: string): Promise<void>
  /** Every claimed name. Used by the sweeper; the claim path never needs it. */
  list(): Promise<string[]>
  /** The name this key already holds, if any. One key, one name. */
  readOwner(pubkey: string): Promise<string | null>
  writeOwner(pubkey: string, name: string): Promise<void>
  removeOwner(pubkey: string): Promise<void>
  /** The name this GitHub account already holds. The limit a keypair cannot forge its way around. */
  readGithubOwner(githubId: number): Promise<string | null>
  writeGithubOwner(githubId: number, name: string): Promise<void>
  removeGithubOwner(githubId: number): Promise<void>
}

/** Who a GitHub token belongs to. Resolved once per claim, then thrown away. */
export interface GithubIdentity {
  id: number
  login: string
  /** Account creation time, so brand-new throwaways can be held off. */
  createdAt: number
}

/**
 * Resolve a token to its account. `null` means GitHub did not accept it; `"foreign"` means GitHub did,
 * but not as a token issued to Frizz's own GitHub App — a `gh` CLI token, a personal access token,
 * another app's — and it is refused whoever it belongs to (githubVerifier in worker.ts says why).
 */
export interface GithubVerifier {
  (token: string): Promise<GithubIdentity | null | "foreign">
}

export interface CloudflareApi {
  createTunnel(name: string): Promise<{ id: string; token: string }>
  /** The tunnel with this name, if the account already has one. Used to reclaim an orphan. */
  findTunnel(name: string): Promise<{ id: string } | null>
  /** Re-read an existing tunnel's run token, so a renewal need not destroy and recreate the tunnel. */
  tunnelToken(id: string): Promise<string>
  setTunnelIngress(id: string, hostname: string, service: string): Promise<void>
  upsertDnsRecord(hostname: string, target: string): Promise<void>
  deleteTunnel(id: string): Promise<void>
  deleteDnsRecord(hostname: string): Promise<void>
}

export interface ClaimDeps {
  /**
   * Cloudflare, for the TUNNEL path only.
   *
   * Absent means RELAY mode, which is the default now: a claim records the name and nothing else. The
   * relay serves every name off one wildcard record, so there is no tunnel to create and no DNS record
   * to write — which is exactly what removed the 200-name ceiling. Kept as an option for one release
   * so the tunnel path can be turned back on without a rebuild.
   */
  api?: CloudflareApi
  store: ClaimStore
  /** The zone names hang off, e.g. `frizz.sh`. */
  zone: string
  now: () => number
  /** Absent means identity is not enforced — only ever right before there is a gate to enforce. */
  github?: GithubVerifier
  /** How old a GitHub account must be to claim. Blunts the throwaway-account version of squatting. */
  minAccountAgeMs?: number
  /**
   * How many names the namespace may hold.
   *
   * A zone caps at 200 DNS records on Cloudflare's free plan and 3,500 on Pro, and one name costs one
   * record. Without a limit here the cap is hit inside Cloudflare instead, which surfaces as an opaque
   * provisioning failure — the user cannot tell what went wrong and neither can we.
   */
  maxNames?: number
  /**
   * May this request create one more ANONYMOUS name right now?
   *
   * Anonymous names skip the GitHub gate, and keys are free — so without some cost a loop of generated
   * keypairs mints names until the namespace ceiling stops ALL signups. This is that cost, consulted
   * only for a NEW anonymous name: never for a renewal (a live board must never lose its name to its
   * neighbours' behaviour) and never for a vanity claim (GitHub is that path's cost). Absent means
   * unlimited, which is only ever right in tests.
   */
  anonymousBudget?: () => Promise<boolean>
  /**
   * May this request send GitHub one more `/user` lookup right now? Consulted only for the first claim
   * of a CUSTOM name, before GitHub is asked. Absent means unlimited, which is only ever right in tests.
   */
  githubBudget?: () => Promise<boolean>
}

export type ClaimFailure =
  | ClaimRejection
  | "name-taken"
  | "malformed"
  | "provisioning-failed"
  | "one-name-per-key"
  | "github-required"
  | "github-rejected"
  | "github-token-foreign"
  | "github-too-new"
  | "one-name-per-account"
  | "namespace-full"
  | "too-many-claims"

export type ClaimOutcome =
  /** `token` is present only in tunnel mode; a relay board proves itself with its keypair instead. */
  | { status: 200; body: { hostname: string; token?: string; leaseExpiresAt: number; renewed: boolean } }
  | { status: 400 | 409 | 429 | 502 | 503; body: { error: ClaimFailure; message: string } }

const MESSAGES: Record<ClaimFailure, string> = {
  "bad-version": "this Frizz is too old to claim a name — upgrade and try again",
  "bad-name": "that name is not usable as a hostname",
  reserved: "that name is reserved — pick another",
  "bad-port": "the port must be between 1 and 65535",
  "bad-pubkey": "the identity key was unreadable",
  "bad-signature": "the claim was not signed by the key it names",
  "bad-github": "the GitHub credential in that claim was not a string",
  expired: "the claim is too old — check this machine's clock and try again",
  "from-the-future": "the claim is dated ahead of the server — check this machine's clock",
  "name-taken": "that name belongs to someone else",
  malformed: "the request body was not a claim",
  "provisioning-failed": "the name could not be provisioned; nothing was left behind",
  "one-name-per-key":
    "this machine already holds a name — release it first, or claim from a different Frizz identity",
  "github-required": "claiming a custom name needs a GitHub sign-in — sign in to GitHub in Frizz's Settings and try again",
  "github-rejected": "GitHub did not recognise that sign-in — try again",
  "github-token-foreign":
    "a name is claimed with Frizz's own GitHub sign-in, and this was another kind of GitHub token — update Frizz, sign in to GitHub in its Settings, and try again",
  "github-too-new": "that GitHub account is too new to claim a name",
  "one-name-per-account": "that GitHub account already holds a name",
  "namespace-full": "frizz.sh has no free names left — this is our limit to raise, not yours",
  "too-many-claims": "too many new names from this network just now — try again in an hour",
}

const reject = (error: ClaimFailure, status: 400 | 409 | 429 | 502 | 503 = 400): ClaimOutcome => ({
  status,
  body: { error, message: MESSAGES[error] },
})

/**
 * Claim or renew a name.
 *
 * Renewal is the SAME call as a claim, deliberately. The CLI runs it on every launch, so making it a
 * separate endpoint would mean two code paths that have to agree about ownership — and the one that
 * runs a hundred times more often would be the less tested of the two.
 */
export async function handleClaim(body: unknown, deps: ClaimDeps): Promise<ClaimOutcome> {
  const now = deps.now()
  const verdict = await verifyClaim(body, now)
  if (!verdict.ok) return reject(verdict.reason)

  const { name, port, pubkey } = verdict.payload
  const hostname = `${name}.${deps.zone}`
  const existing = await deps.store.read(name)

  if (existing && existing.pubkey !== pubkey) {
    // A lapsed lease returns the name to the pool on demand, so a name frees up the moment someone
    // else wants it rather than when a cron happens to run. That is NOT a substitute for the sweeper
    // below: this branch only fires when somebody asks for this exact name, so a name nobody wants
    // would hold its DNS record and tunnel forever, against caps of 200 and 1,000.
    if (!claimLeaseExpired(existing.renewedAt, now)) return reject("name-taken", 409)
    // If the old tunnel will not die, do NOT proceed: creating its replacement would fail on the
    // duplicate name anyway, and we would have dropped the registry row on the way there.
    if (!(await releaseQuietly(deps, name, hostname, existing.tunnelId, existing.pubkey, existing.githubId))) {
      return reject("provisioning-failed", 502)
    }
  } else if (existing) {
    return renew(existing, { name, hostname, port, pubkey }, deps, now)
  }

  // IDENTITY, and only here — a renewal is proved by the keypair alone, so a live name never depends
  // on GitHub being reachable. A first claim is the one moment where cost can be imposed, and the two
  // claim kinds pay it differently: an ANONYMOUS name (the 20-character shape, worthless to squat)
  // pays a per-network creation budget, and a vanity name pays a GitHub identity.
  let githubId: number | undefined
  if (isAnonymousClaimName(name)) {
    if (deps.anonymousBudget && !(await deps.anonymousBudget())) {
      return reject("too-many-claims", 429)
    }
  } else if (deps.github) {
    if (!verdict.payload.github) return reject("github-required")
    if (deps.githubBudget && !(await deps.githubBudget())) return reject("too-many-claims", 429)
    const who = await deps.github(verdict.payload.github)
    if (who === "foreign") return reject("github-token-foreign")
    if (!who) return reject("github-rejected")
    if (deps.minAccountAgeMs && now - who.createdAt < deps.minAccountAgeMs) {
      return reject("github-too-new")
    }
    const heldByAccount = await deps.store.readGithubOwner(who.id)
    if (heldByAccount && heldByAccount !== name) {
      const other = await deps.store.read(heldByAccount)
      if (other && other.githubId === who.id && !claimLeaseExpired(other.renewedAt, now)) {
        return reject("one-name-per-account", 409)
      }
      await deps.store.removeGithubOwner(who.id)
    }
    githubId = who.id
  }

  // CAPACITY, checked only for a NEW name — a renewal consumes nothing and must never be refused for
  // being late to a full namespace. Counting here rather than letting Cloudflare refuse means the
  // answer says what is actually wrong instead of "provisioning failed".
  if (deps.maxNames !== undefined) {
    const taken = (await deps.store.list()).length
    if (taken >= deps.maxNames) return reject("namespace-full", 503)
  }

  // ONE LIVE NAME PER KEY. Without it a loop of generated keypairs takes the whole namespace, and the
  // zone caps at 200 records. This is a speed bump rather than a wall — keys are free, so a determined
  // squatter just makes more — and the real answer is tying a claim to an identity that costs
  // something to obtain. It closes the trivial version, which is the one that happens by accident.
  //
  // A RANDOM NAME GIVES WAY to a custom one claimed with the same key, so the key still holds one name.
  // A board starts on a random name, and the R pane offers the account's own name once Frizz is signed
  // in to GitHub; refusing that would leave the board stuck for the random name's 30-day lease, with no
  // way to release it. A custom name does not give way: its lease is the grace for coming back to it.
  const held = await deps.store.readOwner(pubkey)
  let givingWay: { name: string; record: ClaimRecord } | undefined
  if (held && held !== name) {
    const other = await deps.store.read(held)
    if (other && other.pubkey === pubkey && !claimLeaseExpired(other.renewedAt, now)) {
      if (!isAnonymousClaimName(held) || isAnonymousClaimName(name)) return reject("one-name-per-key", 409)
      givingWay = { name: held, record: other }
    } else {
      // The index outlived the name it pointed at, so it is stale rather than binding.
      await deps.store.removeOwner(pubkey)
    }
  }

  const outcome = await create({ name, hostname, port, pubkey, githubId }, deps, now)
  if (outcome.status === 200 && givingWay) {
    // Only once the new name is held, so a failed claim leaves the board on the name it had.
    const old = givingWay
    await releaseQuietly(deps, old.name, `${old.name}.${deps.zone}`, old.record.tunnelId, pubkey, old.record.githubId)
    // Releasing forgets the key's index with the name; the key's one name is the new one now.
    await deps.store.writeOwner(pubkey, name)
  }
  return outcome
}

interface ClaimTarget {
  name: string
  hostname: string
  port: number
  pubkey: string
  githubId?: number | undefined
}

async function renew(
  existing: ClaimRecord,
  target: ClaimTarget,
  deps: ClaimDeps,
  now: number
): Promise<ClaimOutcome> {
  // Relay mode: the lease is the only thing a renewal touches.
  if (!deps.api) {
    await deps.store.write(target.name, { ...existing, port: target.port, renewedAt: now })
    return {
      status: 200,
      body: { hostname: target.hostname, leaseExpiresAt: now + CLAIM_LEASE_MS, renewed: true },
    }
  }
  const api = deps.api
  try {
    // The board may have moved port since the last launch, so ingress is re-asserted every time
    // rather than only when it looks changed — one idempotent call is cheaper than a stale tunnel
    // pointing at a port nothing serves.
    if (existing.port !== target.port) {
      await api.setTunnelIngress(existing.tunnelId, target.hostname, `http://localhost:${target.port}`)
    }
    const token = await api.tunnelToken(existing.tunnelId)
    await deps.store.write(target.name, { ...existing, port: target.port, renewedAt: now })
    return {
      status: 200,
      body: { hostname: target.hostname, token, leaseExpiresAt: now + CLAIM_LEASE_MS, renewed: true },
    }
  } catch {
    return reject("provisioning-failed", 502)
  }
}

async function create(target: ClaimTarget, deps: ClaimDeps, now: number): Promise<ClaimOutcome> {
  // Relay mode: record the name and stop. No tunnel, no DNS record, nothing per-user to leak or cap.
  if (!deps.api) {
    await deps.store.write(target.name, {
      pubkey: target.pubkey,
      tunnelId: "",
      port: target.port,
      claimedAt: now,
      renewedAt: now,
      ...(target.githubId !== undefined ? { githubId: target.githubId } : {}),
    })
    await deps.store.writeOwner(target.pubkey, target.name)
    if (target.githubId !== undefined) await deps.store.writeGithubOwner(target.githubId, target.name)
    return {
      status: 200,
      body: { hostname: target.hostname, leaseExpiresAt: now + CLAIM_LEASE_MS, renewed: false },
    }
  }
  const api = deps.api
  const tunnelName = tunnelNameForClaim(target.name)
  let tunnel: { id: string; token: string }
  try {
    // RECLAIM AN ORPHAN FIRST. Cloudflare refuses a duplicate tunnel name (error 1013), so a tunnel
    // that outlived its registry row would make its name permanently unclaimable — every future
    // attempt failing on a collision with something nothing knows how to find. Reaching here means
    // the registry believes the name is free, so any tunnel still wearing it is by definition unowned.
    const orphan = await api.findTunnel(tunnelName)
    if (orphan) await api.deleteTunnel(orphan.id)
    tunnel = await api.createTunnel(tunnelName)
  } catch {
    return reject("provisioning-failed", 502)
  }

  try {
    await api.setTunnelIngress(tunnel.id, target.hostname, `http://localhost:${target.port}`)
    await api.upsertDnsRecord(target.hostname, `${tunnel.id}.cfargotunnel.com`)
    await deps.store.write(target.name, {
      pubkey: target.pubkey,
      tunnelId: tunnel.id,
      port: target.port,
      claimedAt: now,
      renewedAt: now,
      ...(target.githubId !== undefined ? { githubId: target.githubId } : {}),
    })
    await deps.store.writeOwner(target.pubkey, target.name)
    if (target.githubId !== undefined) await deps.store.writeGithubOwner(target.githubId, target.name)
  } catch {
    // UNWIND, or the account leaks a tunnel on every failed claim. Tunnels are capped at 1,000 per
    // account, so a leak here is not untidiness — it is a countdown to the product stopping.
    await releaseQuietly(deps, target.name, target.hostname, tunnel.id, target.pubkey, target.githubId)
    return reject("provisioning-failed", 502)
  }

  return {
    status: 200,
    body: {
      hostname: target.hostname,
      token: tunnel.token,
      leaseExpiresAt: now + CLAIM_LEASE_MS,
      renewed: false,
    },
  }
}

/**
 * Tear a name down without throwing, reporting whether the TUNNEL actually went.
 *
 * The registry row is removed only once its tunnel is gone, and that ordering is the whole point.
 * Forgetting a name whose tunnel survives strands it permanently: the registry says the name is free,
 * but Cloudflare refuses to create a second tunnel with that name (error 1013), so nobody can ever
 * claim it again and nothing left knows which tunnel to blame. Keeping the row instead leaves the name
 * merely taken, which the next lapse or sweep can still resolve.
 */
async function releaseQuietly(
  deps: ClaimDeps,
  name: string,
  hostname: string,
  tunnelId: string,
  pubkey: string,
  githubId?: number | undefined
): Promise<boolean> {
  if (!deps.api) {
    // Relay mode owns no Cloudflare resources for a name, so releasing it is only forgetting it.
    await Promise.allSettled([
      deps.store.remove(name),
      deps.store.removeOwner(pubkey),
      ...(githubId !== undefined ? [deps.store.removeGithubOwner(githubId)] : []),
    ])
    return true
  }
  const [, tunnel] = await Promise.allSettled([
    deps.api.deleteDnsRecord(hostname),
    deps.api.deleteTunnel(tunnelId),
  ])
  if (tunnel.status !== "fulfilled") return false
  await Promise.allSettled([
    deps.store.remove(name),
    deps.store.removeOwner(pubkey),
    ...(githubId !== undefined ? [deps.store.removeGithubOwner(githubId)] : []),
  ])
  return true
}

/**
 * Return every lapsed name to the pool.
 *
 * The on-demand release in handleClaim only fires when someone asks for that exact name, so without
 * this a name nobody ever wants again keeps its DNS record and its tunnel indefinitely. Those are the
 * two capped resources — 200 records in the zone, 1,000 tunnels in the account — so leaving them held
 * by abandoned names is what would eventually stop new signups, quietly and with no obvious cause.
 *
 * Bounded per run: a sweep that tried to release everything at once could exceed a scheduled Worker's
 * CPU budget and be killed part-way, which is survivable (the next run continues) but pointless. The
 * remaining count comes back so the caller can say what is still owed rather than implying it is done.
 */
export async function sweepExpiredClaims(
  deps: ClaimDeps,
  limit = 50
): Promise<{ released: string[]; failed: string[]; remaining: number }> {
  const now = deps.now()
  const names = await deps.store.list()
  const released: string[] = []
  const failed: string[] = []
  let expired = 0

  for (const name of names) {
    const record = await deps.store.read(name)
    if (!record || !claimLeaseExpired(record.renewedAt, now)) continue
    expired++
    if (released.length + failed.length >= limit) continue
    const hostname = `${name}.${deps.zone}`
    try {
      await release(deps, name, hostname, record.tunnelId, record.pubkey, record.githubId)
      released.push(name)
    } catch {
      // Kept in the registry deliberately. A name whose Cloudflare resources could not be removed
      // must not lose its row too, or the tunnel becomes an orphan nothing knows how to find.
      failed.push(name)
    }
  }

  return { released, failed, remaining: Math.max(0, expired - released.length - failed.length) }
}

/** Tear a name down, reporting failure. The claim path uses the quiet variant below. */
async function release(
  deps: ClaimDeps,
  name: string,
  hostname: string,
  tunnelId: string,
  pubkey: string,
  githubId?: number | undefined
): Promise<void> {
  if (deps.api) {
    await deps.api.deleteDnsRecord(hostname)
    await deps.api.deleteTunnel(tunnelId)
  }
  await deps.store.remove(name)
  await deps.store.removeOwner(pubkey)
  if (githubId !== undefined) await deps.store.removeGithubOwner(githubId)
}
