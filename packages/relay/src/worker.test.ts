import assert from "node:assert/strict"
import test from "node:test"
import { generateClaimIdentity, exportClaimPublicKey, relayHandshakeInput } from "@frizz/shared"
import { boardNameFor, handshakeAccepted, ownerPubkeyFor, visitorResponseInit, type RelayEnv } from "./worker.ts"

const NOW = 1_800_000_000_000

const b64url = (bytes: ArrayBuffer) => {
  const view = new Uint8Array(bytes)
  let s = ""
  for (const b of view) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function signHandshake(name: string, identity: CryptoKeyPair, issuedAt = NOW) {
  const pubkey = await exportClaimPublicKey(identity.publicKey)
  const input = relayHandshakeInput(name, pubkey, issuedAt)
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, identity.privateKey, input as BufferSource)
  return { v: 1, name, pubkey, issuedAt, sig: b64url(sig) }
}

test("a hostname maps to a board name, one level only", () => {
  assert.equal(boardNameFor("ada.frizz.sh", "frizz.sh"), "ada")
  // Universal SSL covers `*.frizz.sh` and nothing deeper, so a two-level name would arrive with a
  // certificate error anyway and must not be treated as a board.
  assert.equal(boardNameFor("a.b.frizz.sh", "frizz.sh"), null)
  assert.equal(boardNameFor("frizz.sh", "frizz.sh"), null, "the apex is not a board")
  assert.equal(boardNameFor("ada.example.com", "frizz.sh"), null, "another zone is not ours to serve")
  assert.equal(boardNameFor("frizz.sh.evil.com", "frizz.sh"), null, "a suffix trick is not a match")
})

test("a handshake must be signed by the key the REGISTRAR recorded", async () => {
  // Without the owner check any well-formed self-signed handshake would be accepted, and a board
  // could serve a name it never claimed.
  const owner = await generateClaimIdentity()
  const ownerKey = await exportClaimPublicKey(owner.publicKey)
  const good = await signHandshake("ada", owner)
  assert.equal(await handshakeAccepted(good, ownerKey, NOW), true)

  const stranger = await generateClaimIdentity()
  const forged = await signHandshake("ada", stranger)
  assert.equal(await handshakeAccepted(forged, ownerKey, NOW), false, "a stranger's key was accepted")
  assert.equal(await handshakeAccepted(good, null, NOW), false, "an unclaimed name accepted a board")
})

test("a tampered or stale handshake is refused", async () => {
  const owner = await generateClaimIdentity()
  const ownerKey = await exportClaimPublicKey(owner.publicKey)
  const good = await signHandshake("ada", owner)

  assert.equal(await handshakeAccepted({ ...good, name: "eve" }, ownerKey, NOW), false)
  assert.equal(await handshakeAccepted({ ...good, issuedAt: NOW + 1 }, ownerKey, NOW), false)
  assert.equal(await handshakeAccepted({ ...good, sig: `${good.sig.slice(0, -4)}AAAA` }, ownerKey, NOW), false)
  // Replay window, both directions — a wrong clock must not mint a long-lived credential.
  assert.equal(await handshakeAccepted(good, ownerKey, NOW + 6 * 60_000), false)
  assert.equal(await handshakeAccepted(good, ownerKey, NOW - 6 * 60_000), false)
})

test("junk never reaches the signature check", async () => {
  const owner = await generateClaimIdentity()
  const ownerKey = await exportClaimPublicKey(owner.publicKey)
  for (const junk of [null, undefined, 42, "str", [], {}, { name: "ada" }, { name: "ada", pubkey: 1 }]) {
    assert.equal(await handshakeAccepted(junk, ownerKey, NOW), false, JSON.stringify(junk))
  }
})

test("the owning key is read from the registry, and a bad row reads as unclaimed", async () => {
  const rows: Record<string, string> = {
    "claim:ada": JSON.stringify({ pubkey: "KEY", tunnelId: "t", port: 1, claimedAt: 1, renewedAt: 1 }),
    "claim:broken": "{{{",
    "claim:empty": JSON.stringify({ tunnelId: "t" }),
  }
  const env = { CLAIMS: { get: async (k: string) => rows[k] ?? null } } as unknown as RelayEnv
  assert.equal(await ownerPubkeyFor(env, "ada"), "KEY")
  assert.equal(await ownerPubkeyFor(env, "broken"), null)
  assert.equal(await ownerPubkeyFor(env, "empty"), null)
  assert.equal(await ownerPubkeyFor(env, "nobody"), null)
})

test("a body the board already encoded is passed through, never encoded a second time", () => {
  // Workers compress a constructed Response to match its content-encoding header unless told the body
  // already is. The board brotli-encodes index.html, so without "manual" a phone got brotli twice.
  const brotli = visitorResponseInit(200, [["content-type", "text/html"], ["Content-Encoding", "br"]])
  assert.equal(brotli.encodeBody, "manual")
  assert.equal(brotli.status, 200)
  const gzip = visitorResponseInit(200, [["content-encoding", "gzip"]])
  assert.equal(gzip.encodeBody, "manual")
  // A plain body keeps the default so the edge can still compress it for a client that accepts it.
  const plain = visitorResponseInit(401, [["content-type", "text/html; charset=utf-8"]])
  assert.equal(plain.encodeBody, undefined)
  const identity = visitorResponseInit(200, [["content-encoding", "identity"]])
  assert.equal(identity.encodeBody, undefined)
})

test("the Worker's module exports nothing workerd cannot run as an entry point", async () => {
  // workerd reads every export of the main module as a handler or an entrypoint class, and refuses to start
  // the Worker when one is anything else: an exported size constant took the whole relay down in `wrangler
  // dev` on 2026-11-12 ("Incorrect type for map entry ... not of type 'function or ExportedHandler'").
  const exported = await import("./worker.ts")
  for (const [name, value] of Object.entries(exported)) {
    assert.ok(typeof value === "function" || (name === "default" && typeof value === "object" && value !== null), `${name} is a ${typeof value}`)
  }
})
