import {
  CLAIM_LEASE_MS,
  claimLeaseExpired,
  isAnonymousClaimName,
  isKeysOwnAnonymousName,
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
  /** How many names are claimed, where the store can say so without listing them all. */
  count?(): Promise<number>
  /** Up to `limit` names whose last renewal is before `before`, oldest first: the sweep, in one read. */
  expired?(before: number, limit: number): Promise<Array<{ name: string; record: ClaimRecord }>>
  /** How many names expired() would find with no limit. */
  countExpired?(before: number): Promise<number>
  /** The name this key already holds, if any. One key, one name. */
  readOwner(pubkey: string): Promise<string | null>
  writeOwner(pubkey: string, name: string): Promise<void>
  removeOwner(pubkey: string): Promise<void>
  /** The name this GitHub account already holds. The limit a keypair cannot forge its way around. */
  readGithubOwner(githubId: number): Promise<string | null>
  writeGithubOwner(githubId: number, name: string): Promise<void>
  removeGithubOwner(githubId: number): Promise<void>
  /** The key that last held a released RANDOM name, which nobody else may ever claim. */
  readRetired(name: string): Promise<string | null>
  writeRetired(name: string, pubkey: string): Promise<void>
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
  /**
   * May one more new RANDOM name be handed out this hour, by anyone? The per-network budget above does
   * nothing against many networks at once, and this is the ceiling over all of them. Never consulted for a
   * renewal, so a board already serving keeps its name whatever the hour looks like, and never for a custom
   * name: GitHub is that path's cost, one name per account, and someone holding this ceiling down with
   * claims from many networks must not shut out a person claiming their own username. Absent means
   * unlimited, which is only ever right in tests.
   */
  newNameBudget?: () => Promise<boolean>
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
  | "not-your-github-username"
  | "github-too-new"
  | "one-name-per-account"
  | "namespace-full"
  | "too-many-claims"
  | "too-many-names"
  | "registrar-busy"

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
    "this machine already holds another custom name, which stays its own until 30 days after it was last served",
  "github-required": "claiming a custom name needs a GitHub sign-in — sign in to GitHub in Frizz's Settings and try again",
  "github-rejected": "GitHub did not recognise that sign-in — try again",
  "github-token-foreign":
    "a name is claimed with Frizz's own GitHub sign-in, and this was another kind of GitHub token — update Frizz, sign in to GitHub in its Settings, and try again",
  "github-too-new": "that GitHub account is too new to claim a name",
  "not-your-github-username": "a custom frizz.sh name is the claiming account's own GitHub username, and this is not it",
  "one-name-per-account":
    "that GitHub account already holds another name, which stays its own until 30 days after it was last served",
  "namespace-full": "frizz.sh has no free names left — this is our limit to raise, not yours",
  "too-many-claims": "too many new names from this network just now — try again in an hour",
  "too-many-names": "frizz.sh has handed out all the new names it gives in an hour — try again later",
  "registrar-busy": "the registrar is busy with other claims — try again in a minute",
}

/** The answer for a refusal, worded as the handler words it. The Worker's own early refusals use it too. */
export const reject = (error: ClaimFailure, status: 400 | 409 | 429 | 502 | 503 = 400): ClaimOutcome => ({
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
  const anonymous = isAnonymousClaimName(name)
  const existing = await deps.store.read(name)

  // A RANDOM NAME IS NEVER REUSED (maintainer, 2026-11-07: "there's plenty to go around"). Phones and
  // bookmarks keep pointing at a name after its board leaves it, and they send it their session cookies;
  // whoever held it next would collect them. So once released, a random name belongs to the key that
  // held it, for good: that key may have it back, and every other key is told it is taken. 100 bits of
  // name means no one ever needs a used one.
  if (anonymous) {
    const holder = existing?.pubkey ?? (await deps.store.readRetired(name))
    if (holder && holder !== pubkey) return reject("name-taken", 409)
    // A NEW RANDOM NAME IS ONE OF THE KEY'S OWN (2026-11-12). This shape skips GitHub, so a name chosen
    // by the claimant — `githubsupportfrizz22` — would be a vanity name with no account behind it. Every
    // launcher since derives its random names from its key (deriveAnonymousClaimName). One that does not
    // is older than that, and is told to update. A name this key already holds, or held, is its own.
    if (!holder && !(await isKeysOwnAnonymousName(pubkey, name))) return reject("bad-version")
  }

  // Released only once every check below has passed, so a claim refused for its budget, its account or
  // its key never costs the name's last holder anything.
  let releasing: ClaimRecord | undefined
  // Settled while deciding whether this claim may take the name from another key, and then not asked again.
  let proved: GithubIdentity | undefined

  if (existing && existing.pubkey !== pubkey) {
    // A lapsed lease returns the name to the pool on demand, so a name frees up the moment someone
    // else wants it rather than when a cron happens to run. That is NOT a substitute for the sweeper
    // below: this branch only fires when somebody asks for this exact name, so a name nobody wants
    // would hold its DNS record and tunnel forever, against caps of 200 and 1,000.
    if (!claimLeaseExpired(existing.renewedAt, now)) {
      // A CUSTOM NAME FOLLOWS ITS ACCOUNT (2026-11-12). Whoever held a leaked sign-in token for its eight
      // hours could bind the account's username to a key of their own and renew it forever, and the
      // account would be refused its own name. The account proving itself again takes the name back,
      // onto the key that proves it. A stolen token can do the same while it lasts, and a stolen refresh
      // token for as long as the owner leaves Frizz authorised on GitHub, so the board that loses a name
      // says what to do (cloud.ts, resolveRunToken). What a stranger's interim hold collects opens
      // nothing afterwards: the board that takes the name back is answered `renewed: false` and signs
      // out every session issued under it (cloud.ts, onFreshClaim), the relay closes the stranger's
      // socket on the next request (relay Board.dropBoardUnlessOwner), and nothing the stranger's board
      // served is used from a browser's cache without the new board's say (relay visitor-headers.ts).
      //
      // WHY NOT A DELAY with a second proof and a cancel, which the second security review weighed: both
      // sides of a take-back hold a token for the SAME account, so a cancel tells the owner from the
      // thief no better than the take-back does. Revoking Frizz on GitHub is what ends a stolen token,
      // and after that only the owner can prove anything; a delay would only make the owner wait.
      if (anonymous || existing.githubId === undefined || !deps.github) return reject("name-taken", 409)
      const account = await proveAccount(verdict.payload.github, name, deps, now)
      if (!("who" in account)) return account.outcome
      if (account.who.id !== existing.githubId) return reject("name-taken", 409)
      proved = account.who
    }
    releasing = existing
  } else if (existing) {
    const renewed = await renew(existing, { name, hostname, port, pubkey }, deps, now)
    // The name a board serves is its key's one name, so coming back to a name it stepped off points
    // the key's index back at it, and the one-custom-name rule below sees the name actually in use.
    if (renewed.status === 200 && (await deps.store.readOwner(pubkey)) !== name) {
      await deps.store.writeOwner(pubkey, name)
    }
    return renewed
  }

  // IDENTITY, and only here — a renewal is proved by the keypair alone, so a live name never depends
  // on GitHub being reachable. A first claim is the one moment where cost can be imposed, and the two
  // claim kinds pay it differently: an ANONYMOUS name (the 20-character shape, worthless to squat)
  // pays a per-network creation budget, and a vanity name pays a GitHub identity.
  let githubId: number | undefined
  if (anonymous) {
    if (deps.anonymousBudget && !(await deps.anonymousBudget())) {
      return reject("too-many-claims", 429)
    }
  } else if (deps.github) {
    let who = proved
    if (!who) {
      const account = await proveAccount(verdict.payload.github, name, deps, now)
      if (!("who" in account)) return account.outcome
      who = account.who
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

  // ONE LIVE CUSTOM NAME PER KEY: a key holding a live custom name cannot claim a second one. It is a
  // speed bump rather than a wall, since keys are free; the account's own username and one name per
  // account, above, are what bind a custom name. Random names are held back by the per-network budget
  // above instead, so any name gives way to a RANDOM one, and a random name gives way to a custom one.
  // There is no way to release a name from the R pane, so refusing either would strand the board for
  // the old name's 30-day lease: Off forgets the name on the machine, and picking a frizz.sh subdomain
  // again asked for a fresh random name and was refused (maintainer, 2026-11-10: "This should not be
  // fucking possible").
  //
  // The old name is NOT released, only stepped off: its row keeps this key until its lease lapses
  // (the board no longer renews it), exactly as if the board had moved away without claiming. Freeing it
  // at once would hand it to whoever claimed it next, and the phones still bookmarked on it would send
  // that stranger their session cookies, which the board would still honour on its new name. Coming
  // back to it within the lease is a renewal, matched by key before this check.
  const held = await deps.store.readOwner(pubkey)
  let staleOwner = false
  if (held && held !== name) {
    const other = await deps.store.read(held)
    if (other && other.pubkey === pubkey && !claimLeaseExpired(other.renewedAt, now)) {
      // Stepping off the old name is create() pointing the key's index at the new one.
      if (!isAnonymousClaimName(held) && !anonymous) return reject("one-name-per-key", 409)
    } else {
      // The index outlived the name it pointed at, so it is stale rather than binding.
      staleOwner = true
    }
  }

  // CAPACITY, checked only for a NEW name — a renewal consumes nothing and must never be refused for
  // being late to a full namespace. Counting here rather than letting Cloudflare refuse means the
  // answer says what is actually wrong instead of "provisioning failed". A name being taken back or
  // reclaimed after a lapse frees its own place first, so it is not counted against itself.
  if (deps.maxNames !== undefined && !releasing) {
    const taken = deps.store.count ? await deps.store.count() : (await deps.store.list()).length
    if (taken >= deps.maxNames) return reject("namespace-full", 503)
  }

  // Last of the gates, so a claim refused for anything else spends none of the hour's names.
  if (anonymous && deps.newNameBudget && !(await deps.newNameBudget())) return reject("too-many-names", 503)

  if (releasing) {
    // If the old tunnel will not die, do NOT proceed: creating its replacement would fail on the
    // duplicate name anyway, and we would have dropped the registry row on the way there.
    if (!(await releaseQuietly(deps, name, hostname, releasing.tunnelId, releasing.pubkey, releasing.githubId))) {
      return reject("provisioning-failed", 502)
    }
  }
  if (staleOwner) await deps.store.removeOwner(pubkey)

  return create({ name, hostname, port, pubkey, githubId }, deps, now)
}

/**
 * Prove a GitHub account owns `name`: its own username, through Frizz's own sign-in, old enough to count.
 * Spends one lookup of the network's GitHub budget. Returns the account, or the refusal to send back.
 */
async function proveAccount(
  token: string | undefined,
  name: string,
  deps: ClaimDeps,
  now: number
): Promise<{ who: GithubIdentity } | { outcome: ClaimOutcome }> {
  if (!token) return { outcome: reject("github-required") }
  if (deps.githubBudget && !(await deps.githubBudget())) return { outcome: reject("too-many-claims", 429) }
  const who = await deps.github!(token)
  if (who === "foreign") return { outcome: reject("github-token-foreign") }
  if (!who) return { outcome: reject("github-rejected") }
  // A CUSTOM NAME IS THE ACCOUNT'S OWN USERNAME (maintainer, 2026-11-07). Otherwise any account old
  // enough could take someone else's login first, and a visitor would read it as theirs. GitHub logins
  // are case-insensitive and claim names lowercase. A name claimed before this rule renews by its key.
  if (name !== who.login.toLowerCase()) return { outcome: reject("not-your-github-username") }
  if (deps.minAccountAgeMs && now - who.createdAt < deps.minAccountAgeMs) return { outcome: reject("github-too-new") }
  return { who }
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
    await retire(deps, name, pubkey)
    await Promise.allSettled([deps.store.remove(name), forgetIndexes(deps, name, pubkey, githubId)])
    return true
  }
  const [, tunnel] = await Promise.allSettled([
    deps.api.deleteDnsRecord(hostname),
    deps.api.deleteTunnel(tunnelId),
  ])
  if (tunnel.status !== "fulfilled") return false
  await retire(deps, name, pubkey)
  await Promise.allSettled([deps.store.remove(name), forgetIndexes(deps, name, pubkey, githubId)])
  return true
}

/** A random name keeps its key after release (handleClaim says why). Written before the row goes. */
async function retire(deps: ClaimDeps, name: string, pubkey: string): Promise<void> {
  if (isAnonymousClaimName(name)) await deps.store.writeRetired(name, pubkey)
}

/**
 * Drop the key's and the account's index entries for a released name, but only where they still point
 * at it. A key or account that has since moved to another name keeps that index: deleting it would
 * lift its one-name limit, so the next claim would leave it holding two names.
 */
async function forgetIndexes(deps: ClaimDeps, name: string, pubkey: string, githubId?: number | undefined): Promise<void> {
  if ((await deps.store.readOwner(pubkey)) === name) await deps.store.removeOwner(pubkey)
  if (githubId !== undefined && (await deps.store.readGithubOwner(githubId)) === name) await deps.store.removeGithubOwner(githubId)
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
  const released: string[] = []
  const failed: string[] = []
  let expired = 0
  let lapsed: Array<{ name: string; record: ClaimRecord }>
  if (deps.store.expired && deps.store.countExpired) {
    const before = now - CLAIM_LEASE_MS
    lapsed = await deps.store.expired(before, limit)
    expired = await deps.store.countExpired(before)
  } else {
    lapsed = []
    for (const name of await deps.store.list()) {
      const record = await deps.store.read(name)
      if (!record || !claimLeaseExpired(record.renewedAt, now)) continue
      expired++
      if (lapsed.length < limit) lapsed.push({ name, record })
    }
  }

  for (const { name, record } of lapsed) {
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
  await retire(deps, name, pubkey)
  await deps.store.remove(name)
  await forgetIndexes(deps, name, pubkey, githubId)
}
