import assert from "node:assert/strict"
import test from "node:test"
import {
  CLAIM_LEASE_MS,
  CLAIM_MAX_AGE_MS,
  CLAIM_PROTOCOL_VERSION,
  claimLeaseExpired,
  claimNameIsValid,
  generateAnonymousClaimName,
  isAnonymousClaimName,
  claimSigningInput,
  exportClaimPrivateKey,
  exportClaimPublicKey,
  generateClaimIdentity,
  importClaimPrivateKey,
  importClaimPublicKey,
  normalizeClaimName,
  signClaim,
  tunnelNameForClaim,
  verifyClaim,
} from "./claim.ts"

const NOW = 1_800_000_000_000

async function claim(overrides: { name?: string; port?: number; issuedAt?: number } = {}) {
  const identity = await generateClaimIdentity()
  const request = await signClaim(
    { name: overrides.name ?? "colin", port: overrides.port ?? 9393, issuedAt: overrides.issuedAt ?? NOW },
    identity
  )
  return { identity, request }
}

test("a signed claim verifies, and the payload survives the round trip", async () => {
  const { request } = await claim()
  const verdict = await verifyClaim(request, NOW)
  assert.ok(verdict.ok)
  assert.equal(verdict.payload.name, "colin")
  assert.equal(verdict.payload.port, 9393)
  assert.equal(verdict.payload.issuedAt, NOW)
})

test("every tampered field is caught — the control that makes the test above mean something", async () => {
  // Without this, "it verifies" could just as easily mean "verify() returns true unconditionally".
  const { request } = await claim()
  const tampered: Array<[string, Record<string, unknown>]> = [
    ["name", { ...request, name: "someone-else" }],
    ["port", { ...request, port: 1234 }],
    ["issuedAt", { ...request, issuedAt: NOW - 1 }],
    ["signature", { ...request, sig: `${request.sig.slice(0, -4)}AAAA` }],
  ]
  for (const [field, mutated] of tampered) {
    const verdict = await verifyClaim(mutated, NOW)
    assert.equal(verdict.ok, false, `tampering with ${field} was accepted`)
  }
})

test("a claim signed by one key cannot be re-attributed to another", async () => {
  // The attack this pins: take someone's valid request, swap in your own pubkey, and claim you signed
  // it. The signature covers the pubkey field, so it cannot survive the swap.
  const { request } = await claim()
  const attacker = await generateClaimIdentity()
  const stolen = { ...request, pubkey: await exportClaimPublicKey(attacker.publicKey) }
  const verdict = await verifyClaim(stolen, NOW)
  assert.deepEqual(verdict, { ok: false, reason: "bad-signature" })
})

test("a claim expires, and one from the future is refused too", async () => {
  const { request } = await claim()
  assert.equal((await verifyClaim(request, NOW + CLAIM_MAX_AGE_MS)).ok, true, "still good at the edge")

  const stale = await verifyClaim(request, NOW + CLAIM_MAX_AGE_MS + 1)
  assert.deepEqual(stale, { ok: false, reason: "expired" })

  // A wildly future-dated claim is refused rather than trusted, or a wrong clock would mint a
  // credential good for as long as the skew.
  const future = await verifyClaim(request, NOW - CLAIM_MAX_AGE_MS - 1)
  assert.deepEqual(future, { ok: false, reason: "from-the-future" })
})

test("a name must arrive already normalized, so one hostname has one spelling", async () => {
  // `Colin` and `colin` are the same DNS label. If both verified, two signed requests would describe
  // one hostname and the registry could not say which key owns it.
  const { identity } = await claim()
  const request = await signClaim({ name: "colin", port: 9393, issuedAt: NOW }, identity)
  const shouted = { ...request, name: "Colin" }
  assert.deepEqual(await verifyClaim(shouted, NOW), { ok: false, reason: "bad-name" })

  // Signing normalizes on the way in, so the CLI cannot accidentally send an unnormalized one.
  const messy = await signClaim({ name: "  COLIN.  ", port: 9393, issuedAt: NOW }, identity)
  assert.equal(messy.name, "colin")
  assert.equal((await verifyClaim(messy, NOW)).ok, true)
})

test("names are DNS labels, and the reserved ones are refused", async () => {
  for (const good of ["colin", "a-b", "abc", "x".repeat(63), "9lives"]) {
    assert.equal(normalizeClaimName(good), good, good)
  }
  for (const bad of [
    "",
    "ab",
    "x".repeat(64),
    "-lead",
    "trail-",
    "has space",
    "has_underscore",
    "UPPER!",
    "xn--punycode",
  ]) {
    assert.throws(() => normalizeClaimName(bad), JSON.stringify(bad))
  }
  // Handing out the ACME challenge label would let someone get a certificate for the zone.
  for (const reserved of ["_acme-challenge", "www", "api", "admin", "mail", "registrar", "frizz", "relay"]) {
    assert.throws(() => normalizeClaimName(reserved), /reserved/, reserved)
  }
})

test("a malformed or hostile request is rejected without throwing", async () => {
  // The Worker feeds untrusted JSON straight in, so anything that throws here is a 500 on a request
  // an attacker chose.
  for (const junk of [null, undefined, 42, "string", [], {}, { v: 99 }, { v: CLAIM_PROTOCOL_VERSION }]) {
    const verdict = await verifyClaim(junk, NOW)
    assert.equal(verdict.ok, false, JSON.stringify(junk))
  }
  const { request } = await claim()
  for (const junk of [
    { ...request, port: 0 },
    { ...request, port: 65_536 },
    { ...request, port: 3.5 },
    { ...request, pubkey: "not base64url!" },
    { ...request, pubkey: "AAAA" },
    { ...request, sig: "short" },
  ]) {
    assert.equal((await verifyClaim(junk, NOW)).ok, false, JSON.stringify(junk).slice(0, 60))
  }
})

test("the signing input is stable and separator-safe", async () => {
  const payload = { name: "colin", port: 9393, pubkey: "abc", issuedAt: NOW }
  const once = new TextDecoder().decode(claimSigningInput(payload))
  assert.equal(once, `frizz-claim:v${CLAIM_PROTOCOL_VERSION}:colin:9393:abc:${NOW}:`)
  // Field order is fixed rather than derived from object key order, so a second call with the keys
  // written differently produces identical bytes.
  const reordered = { issuedAt: NOW, pubkey: "abc", port: 9393, name: "colin" }
  assert.deepEqual(claimSigningInput(reordered), claimSigningInput(payload))

  // The GitHub field is always in the string, empty when absent, so a claim carrying one can never
  // produce the same bytes as a claim without.
  const withToken = new TextDecoder().decode(claimSigningInput({ ...payload, github: "gho_abc" }))
  assert.equal(withToken, `frizz-claim:v${CLAIM_PROTOCOL_VERSION}:colin:9393:abc:${NOW}:gho_abc`)
  assert.notEqual(withToken, once)
})

test("a GitHub token cannot be swapped after signing", async () => {
  // It is the one field an intermediary could change to attribute someone else's name to their own
  // account, so it is inside the signature.
  const identity = await generateClaimIdentity()
  const request = await signClaim({ name: "colin", port: 9393, issuedAt: NOW, github: "gho_mine" }, identity)
  assert.equal((await verifyClaim(request, NOW)).ok, true)
  const swapped = { ...request, github: "gho_theirs" }
  assert.deepEqual(await verifyClaim(swapped, NOW), { ok: false, reason: "bad-signature" })
  // And dropping it entirely is caught too.
  const { github, ...stripped } = request
  assert.deepEqual(await verifyClaim(stripped, NOW), { ok: false, reason: "bad-signature" })
})

test("a keypair survives being written to disk and read back", async () => {
  // This is what `~/.frizz/identity.key` does on every launch; a key that cannot round-trip means the
  // owner silently loses their name on the next renewal.
  const identity = await generateClaimIdentity()
  const pkcs8 = await exportClaimPrivateKey(identity.privateKey)
  const pubkey = await exportClaimPublicKey(identity.publicKey)
  assert.equal(pkcs8.byteLength, 48)

  const restored = await importClaimPrivateKey(pkcs8)
  assert.ok(restored)
  const request = await signClaim({ name: "colin", port: 9393, issuedAt: NOW }, {
    privateKey: restored,
    publicKey: identity.publicKey,
  })
  assert.equal(request.pubkey, pubkey, "the same key must present the same identity")
  assert.equal((await verifyClaim(request, NOW)).ok, true)
})

test("a corrupt key file is reported, not thrown", async () => {
  assert.equal(await importClaimPrivateKey(new Uint8Array([1, 2, 3])), null)
  assert.equal(await importClaimPublicKey("nonsense!"), null)
  assert.equal(await importClaimPublicKey("AAAA"), null, "right shape, wrong length")
})

test("a tunnel name is namespaced, so a user cannot collide with one of ours", () => {
  assert.equal(tunnelNameForClaim("colin"), "u-colin")
  assert.equal(tunnelNameForClaim("  COLIN  "), "u-colin")
})

test("a lease lapses exactly at its horizon", () => {
  assert.equal(claimLeaseExpired(NOW, NOW + CLAIM_LEASE_MS), false)
  assert.equal(claimLeaseExpired(NOW, NOW + CLAIM_LEASE_MS + 1), true)
})

test("a reserved name is told it is RESERVED, not that it is a bad hostname", async () => {
  // `docs` is a perfectly good hostname. Telling someone it "is not usable as a hostname" is false,
  // and it leaves them permuting a name that was never going to be available. Caught against the live
  // registrar on 2026-08-26.
  const verdict = await verifyClaim(
    { v: CLAIM_PROTOCOL_VERSION, name: "docs", port: 9393, pubkey: "AAAA", issuedAt: Date.now(), sig: "AAAA", github: "x" },
    Date.now(),
  )
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.reason, "reserved")
})

test("reserved beats syntax even when the spelling needs normalizing", async () => {
  const verdict = await verifyClaim(
    { v: CLAIM_PROTOCOL_VERSION, name: "  ADMIN  ", port: 9393, pubkey: "AAAA", issuedAt: Date.now(), sig: "AAAA", github: "x" },
    Date.now(),
  )
  assert.equal(verdict.ok === false && verdict.reason, "reserved")
})

test("a genuinely malformed name is still bad-name, not reserved", async () => {
  for (const name of ["Not A Valid Name!", "-leading", "trailing-", "a"]) {
    const verdict = await verifyClaim(
      { v: CLAIM_PROTOCOL_VERSION, name, port: 9393, pubkey: "AAAA", issuedAt: Date.now(), sig: "AAAA", github: "x" },
      Date.now(),
    )
    assert.equal(verdict.ok === false && verdict.reason, "bad-name", `${name} was misclassified`)
  }
})

test("an anonymous name is 20 characters of [a-z2-7], valid to claim, and never repeats", () => {
  const seen = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const name = generateAnonymousClaimName()
    assert.match(name, /^[a-z2-7]{20}$/)
    assert.ok(isAnonymousClaimName(name))
    assert.ok(claimNameIsValid(name), "the shape must pass ordinary name validation")
    seen.add(name)
  }
  assert.equal(seen.size, 200, "100 bits of entropy cannot collide in 200 draws")
})

test("the anonymous shape excludes near misses", () => {
  for (const name of [
    "colin",
    "abcdefghjkmnpqrstuv", // 19
    "abcdefghjkmnpqrstuvwx", // 21
    "Abcdefghjkmnpqrstuvw", // uppercase
    "abcdefghjkmnpqrstuv1", // 1 is outside base32
    "abcdefghjkmnpqrstu-v", // hyphen
  ]) {
    assert.equal(isAnonymousClaimName(name), false, name)
  }
})

test("an anonymous name signs and verifies like any other claim", async () => {
  const identity = await generateClaimIdentity()
  const name = generateAnonymousClaimName()
  const request = await signClaim({ name, port: 9393, issuedAt: 1_800_000_000_000 }, identity)
  const verdict = await verifyClaim(request, 1_800_000_000_000)
  assert.ok(verdict.ok)
  assert.equal(verdict.ok && verdict.payload.name, name)
})
