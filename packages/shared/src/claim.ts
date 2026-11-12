/**
 * The claim protocol for `<name>.frizz.sh`.
 *
 * A name is owned by whoever holds a private key — there is no account, no email and no password, so
 * this module is the entire ownership model. The CLI signs a claim; the registration Worker verifies
 * it and, if the name is free or already belongs to that key, provisions the tunnel and DNS record.
 *
 * DEPENDENCY-FREE ON PURPOSE. Both halves run this code, and they run in different places: the CLI on
 * Node, the Worker on workerd. Web Crypto's Ed25519 is the one primitive both have, so nothing here
 * imports from `node:` or from the rest of `@frizz/shared` — a Worker can import this single file
 * without dragging in zod, yaml and 3,600 lines of unrelated types.
 */

export const CLAIM_PROTOCOL_VERSION = 2

/**
 * The client id of Frizz's GitHub App, "Frizz Agent Console" (github.com/apps/frizz-agent-console).
 * Public by design. The board signs in to GitHub through it, and the registrar accepts a custom-name
 * claim only with a user token GitHub reports as issued to it (`X-OAuth-Client-Id` on `/user`).
 */
export const FRIZZ_GITHUB_APP_CLIENT_ID: string = "Iv23licDruV3JtQIF3fI"

/**
 * How far a claim's own timestamp may sit from the verifier's clock, in either direction.
 *
 * This is a REPLAY WINDOW, not a security boundary: inside it a captured request can be replayed. That
 * is tolerable because every operation the protocol supports is idempotent for the key that signed it
 * — claiming a name you already hold, or renewing it, changes nothing. The one case it does not cover
 * is a port change being replayed back to an older port, which costs a re-claim and nothing else.
 * Closing it properly needs a server-side nonce set, which is storage this design deliberately avoids.
 */
export const CLAIM_MAX_AGE_MS = 5 * 60_000

/** A lease runs 30 days; every launch renews it. An unrenewed name returns to the pool. */
export const CLAIM_LEASE_MS = 30 * 24 * 60 * 60_000

/**
 * Names Frizz keeps for itself.
 *
 * `_acme-challenge` is the one that actually matters — handing it out would let someone obtain a
 * certificate for a name in the zone. The rest are the ordinary infrastructure labels that would be
 * confusing or phishable in someone else's hands.
 */
export const RESERVED_CLAIM_NAMES: ReadonlySet<string> = new Set([
  "_acme-challenge",
  "acme",
  "admin",
  "api",
  "app",
  "billing",
  "blog",
  "board",
  "cdn",
  "dashboard",
  "docs",
  "frizz",
  "ftp",
  "help",
  "localhost",
  "login",
  "mail",
  "ns",
  "ns1",
  "ns2",
  "registrar",
  "relay",
  "root",
  "smtp",
  "ssl",
  "staging",
  "status",
  "support",
  "test",
  "www",
])

export const CLAIM_NAME_MIN_LENGTH = 3
export const CLAIM_NAME_MAX_LENGTH = 63

/**
 * Anonymous names: the auth-free path.
 *
 * A name of exactly this shape — 20 characters drawn from a 32-letter alphabet — is claimable with no
 * GitHub identity at all: the registrar recognises the shape and waives the gate. That is safe where
 * waiving it for vanity names would not be, because the whole point of the gate is to make squatting
 * cost something, and a name nobody can predict or want has no squatting value. What the shape buys
 * the OWNER is 100 bits of entropy: the hostname itself is unguessable, the zone's certificate is a
 * wildcard so no per-name hostname ever appears in a certificate-transparency log, and the wildcard
 * DNS record means there is no per-name record to enumerate. The single-use access gate still stands
 * on the far side; the obscure name is a moat in front of it, not a replacement for it.
 */
export const ANONYMOUS_CLAIM_NAME_LENGTH = 20

/** Exactly 32 letters, so a random byte masked to 5 bits indexes it without modulo bias. */
const ANONYMOUS_CLAIM_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

const ANONYMOUS_CLAIM_PATTERN = new RegExp(`^[a-z2-7]{${ANONYMOUS_CLAIM_NAME_LENGTH}}$`)

/** Does this (already-normalized) name have the shape the registrar claims without identity? */
export function isAnonymousClaimName(name: string): boolean {
  return ANONYMOUS_CLAIM_PATTERN.test(name)
}

/**
 * How many random names one key may take. A launcher asked for a fresh name picks one of them at random,
 * and a name it comes back to is its own: renewed while its lease runs, and handed back after.
 */
export const ANONYMOUS_NAMES_PER_KEY = 64

/**
 * A key's `index`th random name: 20 characters of [a-z2-7], 100 bits of a SHA-256 over the key.
 *
 * DERIVED, NOT CHOSEN (2026-11-12). The registrar waives GitHub for this shape, so when a launcher drew it
 * from `crypto.getRandomValues` anyone could send a name of their choosing in it — `colinhacksfrizzboard`,
 * `githubsupportfrizz22` — and have it with no account. A NEW random name is now taken only if it is one of
 * the claiming key's own ANONYMOUS_NAMES_PER_KEY, which nobody can steer: grinding keys buys a few
 * characters of prefix, never a word. Names claimed before keep renewing by their key.
 */
export async function deriveAnonymousClaimName(pubkey: string, index: number): Promise<string> {
  const input = new TextEncoder().encode(`frizz-random-name:v1:${pubkey}:${index}`)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input))
  let name = ""
  // Five bits from each of the first 20 bytes: the alphabet has exactly 32 letters, so no letter is favoured.
  for (let i = 0; i < ANONYMOUS_CLAIM_NAME_LENGTH; i++) name += ANONYMOUS_CLAIM_ALPHABET[digest[i]! & 31]
  return name
}

/** A fresh random name for this key: one of its own, picked at random. */
export async function pickAnonymousClaimName(pubkey: string): Promise<string> {
  const [byte = 0] = crypto.getRandomValues(new Uint8Array(1))
  return deriveAnonymousClaimName(pubkey, byte % ANONYMOUS_NAMES_PER_KEY)
}

/** Is `name` one of this key's own random names? What the registrar asks of a new random claim. */
export async function isKeysOwnAnonymousName(pubkey: string, name: string): Promise<boolean> {
  if (!isAnonymousClaimName(name)) return false
  for (let index = 0; index < ANONYMOUS_NAMES_PER_KEY; index++) {
    if ((await deriveAnonymousClaimName(pubkey, index)) === name) return true
  }
  return false
}

export interface ClaimPayload {
  /** The label to the left of `.frizz.sh`. */
  name: string
  /** Which local port the tunnel's ingress should point at. */
  port: number
  /** base64url of the raw 32-byte Ed25519 public key that owns this name. */
  pubkey: string
  /** Milliseconds since the epoch, from the CLAIMING machine's clock. */
  issuedAt: number
  /**
   * A GitHub access token, proving the claimant is a real account.
   *
   * SIGNED but NEVER STORED. The registrar exchanges it for a user id, records the id as the name's
   * owner, and discards the token — it is a rate limit on identity, not a login, and Frizz keeps no
   * session with GitHub at all. Renewals carry no token: the keypair alone proves ownership after the
   * first claim, so a name does not depend on GitHub being reachable to stay alive.
   *
   * Signing it matters because it is the only field an intermediary could swap to attribute someone
   * else's name to their own account.
   */
  github?: string
}

export interface ClaimRequest extends ClaimPayload {
  v: number
  /** base64url of the 64-byte signature over `claimSigningInput`. */
  sig: string
}

export type ClaimRejection =
  | "bad-version"
  | "bad-name"
  /** A perfectly good hostname that this service keeps for itself. Distinct from bad-name on purpose. */
  | "reserved"
  | "bad-port"
  | "bad-pubkey"
  | "bad-signature"
  | "expired"
  | "from-the-future"
  | "bad-github"

export type ClaimVerdict = { ok: true; payload: ClaimPayload } | { ok: false; reason: ClaimRejection }

const BASE64URL = /^[A-Za-z0-9_-]+$/

/**
 * Web Crypto takes a `BufferSource`, which since TypeScript 5.7 means `Uint8Array<ArrayBuffer>` and
 * NOT the default `Uint8Array<ArrayBufferLike>` — the latter also admits a SharedArrayBuffer, which
 * these APIs reject. Naming the concrete backing store here keeps that detail out of every call site.
 */
type Bytes = Uint8Array<ArrayBuffer>

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): Bytes | null {
  if (!BASE64URL.test(value)) return null
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/**
 * Normalize what a person typed into the DNS label it has to become, or explain why it cannot be one.
 *
 * Deliberately strict rather than forgiving: this string becomes a public hostname and a tunnel name,
 * so "close enough" spellings that differ only in case or a trailing dot must not be able to claim two
 * different names that read identically.
 */
export function normalizeClaimName(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/\.$/, "")
  // Reserved FIRST, so the set stays authoritative no matter what the syntax rules below happen to
  // allow. Several entries (`_acme-challenge`) are already unreachable through the charset rule; that
  // is belt and braces, and it means loosening the charset later cannot quietly release one of them.
  if (RESERVED_CLAIM_NAMES.has(name)) throw new Error(`${name} is reserved`)
  if (name.length < CLAIM_NAME_MIN_LENGTH || name.length > CLAIM_NAME_MAX_LENGTH) {
    throw new Error(
      `a name must be ${CLAIM_NAME_MIN_LENGTH}-${CLAIM_NAME_MAX_LENGTH} characters (got ${name.length || 0})`
    )
  }
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("a name may use only letters, digits and hyphens")
  if (name.startsWith("-") || name.endsWith("-")) throw new Error("a name may not start or end with a hyphen")
  // Two hyphens in positions 3-4 is the IDN "punycode" prefix form; a name shaped like one would be
  // interpreted as an encoded internationalized label by resolvers rather than read literally.
  if (name.slice(2, 4) === "--") throw new Error("a name may not have two hyphens in the third and fourth positions")
  return name
}

/**
 * Just enough normalization to compare against the reserved list.
 *
 * NOT normalizeClaimName, which THROWS for a reserved name — using it here would defeat the whole
 * point of telling the two apart.
 */
function normalizeForReservedCheck(raw: string): string {
  return raw.trim().toLowerCase()
}

export function claimNameIsValid(raw: string): boolean {
  try {
    normalizeClaimName(raw)
    return true
  } catch {
    return false
  }
}

/**
 * The exact bytes a claim signs.
 *
 * A fixed-order string rather than JSON, because two runtimes serializing "the same" object can order
 * keys differently and the signature would stop verifying for reasons nobody could see. Every field is
 * already constrained to exclude the separator, so the encoding cannot be made ambiguous by its input.
 */
export function claimSigningInput(payload: ClaimPayload): Bytes {
  const canonical = [
    "frizz-claim",
    `v${CLAIM_PROTOCOL_VERSION}`,
    payload.name,
    String(payload.port),
    payload.pubkey,
    String(payload.issuedAt),
    // Last, and always present even when empty, so a claim WITH a token can never produce the same
    // bytes as one without. GitHub tokens are `[A-Za-z0-9_]` only, so they cannot forge a separator.
    payload.github ?? "",
  ].join(":")
  return new TextEncoder().encode(canonical)
}

export async function generateClaimIdentity(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
}

/** base64url of the raw 32-byte public key — the string that IS the owner's identity. */
export async function exportClaimPublicKey(key: CryptoKey): Promise<string> {
  return toBase64Url(await crypto.subtle.exportKey("raw", key))
}

export async function importClaimPublicKey(pubkey: string): Promise<CryptoKey | null> {
  const bytes = fromBase64Url(pubkey)
  if (!bytes || bytes.byteLength !== 32) return null
  try {
    return await crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, true, ["verify"])
  } catch {
    return null
  }
}

/** PKCS#8 bytes, which is what the CLI writes to `identity.key` under its state root at mode 0600. */
export async function exportClaimPrivateKey(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.exportKey("pkcs8", key))
}

export async function importClaimPrivateKey(pkcs8: Bytes): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"])
  } catch {
    return null
  }
}

export async function signClaim(
  payload: Omit<ClaimPayload, "pubkey">,
  identity: CryptoKeyPair
): Promise<ClaimRequest> {
  const pubkey = await exportClaimPublicKey(identity.publicKey)
  const full: ClaimPayload = { ...payload, name: normalizeClaimName(payload.name), pubkey }
  if (payload.github !== undefined && !/^[A-Za-z0-9_]+$/.test(payload.github)) {
    throw new Error("that does not look like a GitHub access token")
  }
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, identity.privateKey, claimSigningInput(full))
  return { v: CLAIM_PROTOCOL_VERSION, ...full, sig: toBase64Url(signature) }
}

/**
 * Verify a claim, in the order that gives the most useful answer.
 *
 * Cheap structural checks first, signature last — not for speed, but because a request that fails the
 * signature check after failing validation would be reported as "bad signature", which sends whoever
 * is debugging it looking at their key instead of at the malformed field they actually sent.
 *
 * A valid signature proves POSSESSION OF THE KEY, and nothing about who owns the name. The caller
 * still has to compare `payload.pubkey` against the key already on record for that name; this function
 * cannot do it, because it holds no registry.
 */
export async function verifyClaim(request: unknown, now: number): Promise<ClaimVerdict> {
  if (typeof request !== "object" || request === null) return { ok: false, reason: "bad-version" }
  const candidate = request as Partial<ClaimRequest>
  if (candidate.v !== CLAIM_PROTOCOL_VERSION) return { ok: false, reason: "bad-version" }

  if (typeof candidate.name !== "string") return { ok: false, reason: "bad-name" }
  // RESERVED IS NOT MALFORMED, and collapsing the two told anyone who tried `docs` or `admin` that
  // their name "is not usable as a hostname" — which is false, and leaves them permuting a name that
  // was never going to be available. Checked first, because normalizeClaimName rejects both.
  if (RESERVED_CLAIM_NAMES.has(normalizeForReservedCheck(candidate.name))) {
    return { ok: false, reason: "reserved" }
  }
  if (!claimNameIsValid(candidate.name)) return { ok: false, reason: "bad-name" }
  // The name must arrive ALREADY normalized. Accepting a spelling that merely normalizes to a valid
  // name would let two different signed requests describe one hostname.
  const name = normalizeClaimName(candidate.name)
  if (name !== candidate.name) return { ok: false, reason: "bad-name" }

  if (
    typeof candidate.port !== "number" ||
    !Number.isInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65535
  ) {
    return { ok: false, reason: "bad-port" }
  }
  if (typeof candidate.issuedAt !== "number" || !Number.isFinite(candidate.issuedAt)) {
    return { ok: false, reason: "expired" }
  }
  if (typeof candidate.pubkey !== "string" || typeof candidate.sig !== "string") {
    return { ok: false, reason: "bad-pubkey" }
  }

  const age = now - candidate.issuedAt
  if (age > CLAIM_MAX_AGE_MS) return { ok: false, reason: "expired" }
  if (age < -CLAIM_MAX_AGE_MS) return { ok: false, reason: "from-the-future" }

  const key = await importClaimPublicKey(candidate.pubkey)
  if (!key) return { ok: false, reason: "bad-pubkey" }
  const signature = fromBase64Url(candidate.sig)
  if (!signature || signature.byteLength !== 64) return { ok: false, reason: "bad-signature" }

  if (candidate.github !== undefined && typeof candidate.github !== "string") {
    return { ok: false, reason: "bad-github" }
  }
  const payload: ClaimPayload = {
    name,
    port: candidate.port,
    pubkey: candidate.pubkey,
    issuedAt: candidate.issuedAt,
    ...(candidate.github !== undefined ? { github: candidate.github } : {}),
  }
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    signature,
    claimSigningInput(payload)
  )
  return verified ? { ok: true, payload } : { ok: false, reason: "bad-signature" }
}

/** The tunnel name a claim maps to. Prefixed so a user's name can never collide with one of ours. */
export function tunnelNameForClaim(name: string): string {
  return `u-${normalizeClaimName(name)}`
}

/**
 * Rebuild a whole keypair from the private half alone.
 *
 * An Ed25519 private key already contains its public key, so the on-disk identity is just the 48-byte
 * PKCS#8 blob — there is no second file to keep in step, and no way for the two halves to disagree.
 * Recovering the public key goes through JWK because Web Crypto will not export `raw` from a private
 * key, but a private key's JWK carries the public `x` coordinate.
 */
export async function claimIdentityFromPrivateKey(pkcs8: Bytes): Promise<CryptoKeyPair | null> {
  const privateKey = await importClaimPrivateKey(pkcs8)
  if (!privateKey) return null
  try {
    const jwk = await crypto.subtle.exportKey("jwk", privateKey)
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      { name: "Ed25519" },
      true,
      ["verify"]
    )
    return { privateKey, publicKey }
  } catch {
    return null
  }
}

/** Has a lease lapsed? Used by the sweeper that returns abandoned names to the pool. */
export function claimLeaseExpired(lastRenewedAt: number, now: number): boolean {
  return now - lastRenewedAt > CLAIM_LEASE_MS
}
