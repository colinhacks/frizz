import assert from "node:assert/strict"
import test from "node:test"
import { generateClaimIdentity, exportClaimPublicKey, parseFrame, relayHandshakeInput, serializeFrame, encodeBody } from "@frizz/shared"
import { Board, boardNameFor, handshakeAccepted, ownerPubkeyFor, visitorResponseInit, type RelayEnv } from "./worker.ts"
import { OWNER_HEADER } from "./visitor-headers.ts"

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

/** A hibernatable socket as a woken Durable Object finds it: a state, an attachment, and what was sent on it. */
class ListedSocket {
  sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  onSend?: (data: string) => void
  readyState: number
  private attachment: unknown
  constructor(readyState: number, attachment: unknown) {
    this.readyState = readyState
    this.attachment = attachment
  }
  serializeAttachment(value: unknown) { this.attachment = value }
  deserializeAttachment() { return this.attachment }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("Can't call WebSocket send() after close().")
    this.sent.push(data)
    this.onSend?.(data)
  }
  close(code?: number, reason?: string) {
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) }
    this.readyState = 2
  }
  accept() {}
  addEventListener() {}
}

/** A Durable Object woken from hibernation with these sockets still listed, in this order. */
function wokenBoard(sockets: ListedSocket[]) {
  const globals = globalThis as unknown as { WebSocketRequestResponsePair?: unknown }
  globals.WebSocketRequestResponsePair ??= class {}
  const state = {
    id: { toString: () => "ada" },
    storage: { get: async () => undefined, put: async () => {} },
    acceptWebSocket: () => {},
    getWebSockets: () => sockets as unknown as WorkerWebSocket[],
    setWebSocketAutoResponse: () => {},
  }
  return new Board(state as unknown as DurableObjectState)
}

test("a woken relay serves the visitor through the newest OPEN board socket, and never closes it", async () => {
  // 2026-11-16, on the live relay: a phone's first request after a pause woke the object, which attached
  // every listed board socket in turn. The last one listed was a socket it had closed as "replaced" when
  // the board reconnected, still CLOSING because the board had abandoned it, so the live socket was closed
  // as "replaced by a newer connection" and the visitor got "The board did not answer: the board is not
  // connected". The board heard it had been displaced, with no other connection anywhere.
  const owner = "owner-key"
  const live = new ListedSocket(1, { role: "board", pubkey: owner, issuedAt: 300 })
  const stale = new ListedSocket(2, { role: "board", pubkey: owner, issuedAt: 200 })
  const older = new ListedSocket(1, { role: "board", pubkey: owner, issuedAt: 100 })
  const board = wokenBoard([live, stale, older])
  live.onSend = (data) => {
    const frame = parseFrame(data) as { t: string; id: string }
    if (frame.t !== "req") return
    queueMicrotask(() => board.webSocketMessage(live as unknown as WorkerWebSocket, serializeFrame({
      t: "res", id: frame.id, status: 200, headers: [["content-type", "text/plain"]], body: encodeBody(new TextEncoder().encode("BOARD")), end: true,
    })))
  }

  const response = await board.fetch(new Request("https://ada.frizz.sh/", { headers: { [OWNER_HEADER]: owner } }))
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(await response.text(), "BOARD")
  assert.equal(live.closed, null, "the live board socket was closed")
  assert.equal(live.sent.length, 1)
  assert.deepEqual(stale.sent, [], "a request went down a socket the relay had already closed")
  assert.deepEqual(older.closed, { code: 1000, reason: "replaced by a newer connection" }, "an older open socket was kept")
})

test("a woken relay that finds only a closing board socket says the board is not running, rather than answering into it", async () => {
  const owner = "owner-key"
  const stale = new ListedSocket(2, { role: "board", pubkey: owner, issuedAt: 200 })
  const board = wokenBoard([stale])
  const response = await board.fetch(new Request("https://ada.frizz.sh/", { headers: { [OWNER_HEADER]: owner } }))
  assert.equal(response.status, 502, "a closing socket was treated as a board")
  assert.deepEqual(stale.sent, [])
})
