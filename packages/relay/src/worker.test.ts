import assert from "node:assert/strict"
import test from "node:test"
import { generateClaimIdentity, exportClaimPublicKey, parseFrame, relayHandshakeInput, serializeFrame, encodeBody } from "@frizz/shared"
import { Board, boardNameFor, handshakeAccepted, ownerPubkeyFor, visitorResponseInit, type RelayEnv } from "./worker.ts"
import { ISSUED_HEADER, OWNER_HEADER } from "./visitor-headers.ts"

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

/**
 * A Durable Object that is awake, with real storage, that boards can dial into. Node's Response refuses a
 * 101, which workerd takes with a `webSocket`, so the connect path answers 200 here.
 */
function liveBoard(listed: ListedSocket[] = [], stored: Record<string, unknown> = {}) {
  const globals = globalThis as unknown as { WebSocketPair?: unknown; WebSocketRequestResponsePair?: unknown; Response: typeof Response }
  globals.WebSocketRequestResponsePair ??= class {}
  const accepted: ListedSocket[] = []
  globals.WebSocketPair = class {
    0 = new ListedSocket(1, null)
    1 = new ListedSocket(1, null)
    constructor() {
      accepted.push(this[1])
    }
  }
  const Native = globals.Response
  if (!(Native as unknown as { upgradeTolerant?: boolean }).upgradeTolerant) {
    globals.Response = class extends Native {
      static upgradeTolerant = true
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(init?.status === 101 ? null : body, init?.status === 101 ? { ...init, status: 200 } : init)
      }
    } as typeof Response
  }
  const storage = new Map<string, unknown>(Object.entries(stored))
  const sockets = [...listed]
  const state = {
    id: { toString: () => "ada" },
    storage: { get: async (k: string) => storage.get(k), put: async (k: string, v: unknown) => void storage.set(k, v) },
    acceptWebSocket: (ws: ListedSocket) => void sockets.push(ws),
    getWebSockets: () => sockets as unknown as WorkerWebSocket[],
    setWebSocketAutoResponse: () => {},
  }
  const board = new Board(state as unknown as DurableObjectState)
  return {
    board,
    /** A board dialling in with `owner`'s key: the relay's half of its socket. */
    async connect(owner: string, issuedAt: number): Promise<ListedSocket> {
      await board.fetch(new Request("https://ada.frizz.sh/_relay/connect?h=x", {
        headers: { upgrade: "websocket", [OWNER_HEADER]: owner, [ISSUED_HEADER]: String(issuedAt) },
      }))
      return accepted.at(-1)!
    },
    /** Have `socket` answer every request sent down it with `body`. */
    answers(socket: ListedSocket, body: string) {
      const reply = (data: string) => {
        const frame = parseFrame(data) as { t: string; id: string }
        if (frame.t !== "req") return
        queueMicrotask(() => board.webSocketMessage(socket as unknown as WorkerWebSocket, serializeFrame({
          t: "res", id: frame.id, status: 200, headers: [], body: encodeBody(new TextEncoder().encode(body)), end: true,
        })))
      }
      socket.onSend = reply
      for (const data of socket.sent) reply(data)
    },
  }
}

const requestsOn = (socket: ListedSocket) => socket.sent.map((d) => parseFrame(d) as { t: string }).filter((f) => f.t === "req")
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test("a visitor of the name's new key is never served by the old key's board, even one let back in during the wait", async () => {
  // KV is eventually consistent, so the old key's board can be let back in by a colo still caching its claim,
  // while this visitor waited out the drop its own request caused. It would have had their session cookie.
  const { board, connect, answers } = liveBoard()
  const first = await connect("key-a", 100)
  const pending = board.fetch(new Request("https://ada.frizz.sh/", { headers: { [OWNER_HEADER]: "key-b", cookie: "frizz_session=secret" } }))
  await tick()
  assert.equal(first.closed?.code, 4003)
  const back = await connect("key-a", 150)
  answers(back, "served by key-a")
  const response = await pending
  assert.equal(response.status, 502)
  assert.deepEqual(requestsOn(back), [], "the new key's visitor reached the old key's board")
})

test("a board of another key dialling in tells the old one the name moved, and nothing the old one had goes to the new", async () => {
  const { board, connect, answers } = liveBoard()
  const old = await connect("key-a", 100)
  const pending = board.fetch(new Request("https://ada.frizz.sh/assets/app.js", { headers: { [OWNER_HEADER]: "key-a", "if-none-match": '"v1"' } }))
  await tick()
  const next = await connect("key-b", 200)
  answers(next, "key-b's script")
  assert.equal((await pending).status, 504)
  assert.equal(old.closed?.code, 4003, "the old board was told it was replaced, which reads as a copied key")
  assert.deepEqual(requestsOn(next), [], "a request framed for one key went to another key's board")
})

test("a board socket whose close woke the object is waited for, as it would be had the object been awake", async () => {
  // Cloudflare cuts a hibernated board's socket, and the close is what wakes the object: restore() finds it
  // closed and attaches nothing, and a visitor in the gap was told the board was not running.
  const cut = new ListedSocket(3, { role: "board", pubkey: "key-a", issuedAt: 100 })
  const { board, connect, answers } = liveBoard([cut], { "handshake-issued:key-a": 100 })
  await board.webSocketClose(cut as unknown as WorkerWebSocket)
  const pending = board.fetch(new Request("https://ada.frizz.sh/", { headers: { [OWNER_HEADER]: "key-a" } }))
  await tick()
  answers(await connect("key-a", 200), "BOARD")
  const response = await pending
  assert.equal(response.status, 200)
  assert.equal(await response.text(), "BOARD")
})

test("an old board socket closing late says nothing about the board, and a visitor is not held for it", async () => {
  const stale = new ListedSocket(3, { role: "board", pubkey: "key-a", issuedAt: 100 })
  const { board } = liveBoard([stale], { "handshake-issued:key-a": 300 })
  await board.webSocketClose(stale as unknown as WorkerWebSocket)
  const started = Date.now()
  const response = await board.fetch(new Request("https://ada.frizz.sh/", { headers: { [OWNER_HEADER]: "key-a" } }))
  assert.equal(response.status, 502)
  assert.ok(Date.now() - started < 1000, "a visitor waited for a board that had not just gone")
})

test("a body cut short by a drop fails the visitor's response instead of ending it as though whole", async () => {
  const { board, connect } = liveBoard()
  const socket = await connect("key-a", 100)
  const response = board.fetch(new Request("https://ada.frizz.sh/assets/app.js", { headers: { [OWNER_HEADER]: "key-a" } }))
  await tick()
  const id = (requestsOn(socket)[0] as unknown as { id: string }).id
  board.webSocketMessage(socket as unknown as WorkerWebSocket, serializeFrame({ t: "res", id, status: 200, headers: [["etag", '"v1"']], end: false }))
  board.webSocketMessage(socket as unknown as WorkerWebSocket, serializeFrame({ t: "res-chunk", id, data: encodeBody(new TextEncoder().encode("first half;")) }))
  const visitor = await response
  socket.readyState = 3
  await board.webSocketClose(socket as unknown as WorkerWebSocket)
  await assert.rejects(visitor.text(), "a truncated body read as complete")
})

test("a page load the relay cannot serve gets a page that loads the board again by itself, and a fetch gets text", async () => {
  // A line of plain text ran nothing, and a board opened from the home screen has no reload button.
  const { board } = liveBoard()
  const page = await board.fetch(new Request("https://ada.frizz.sh/", { headers: { [OWNER_HEADER]: "key-a", "sec-fetch-mode": "navigate" } }))
  assert.equal(page.status, 502)
  assert.match(page.headers.get("content-type") ?? "", /text\/html/)
  assert.equal(page.headers.get("cache-control"), "no-store")
  assert.match(await page.text(), /location\.reload\(\)/)

  const read = await board.fetch(new Request("https://ada.frizz.sh/_frizz/rpc/boardState", { headers: { [OWNER_HEADER]: "key-a", "sec-fetch-mode": "cors" } }))
  assert.equal(read.status, 502)
  assert.equal(await read.text(), "This Frizz board is not running right now.")
})

test("a woken relay tells the board to close every terminal whose visitor it just closed", async () => {
  // The visitor may never answer the close, so its close event, which would tell the board, may never come,
  // and each board-side terminal left open holds one of its RELAY_MAX_OPEN_SOCKETS.
  const live = new ListedSocket(1, { role: "board", pubkey: "key-a", issuedAt: 100 })
  const visitor = new ListedSocket(1, { role: "visitor", id: "wabc-1" })
  const board = wokenBoard([visitor, live])
  board.webSocketMessage(live as unknown as WorkerWebSocket, serializeFrame({ t: "pong", id: "keepalive" })) // the frame that woke it
  assert.equal(visitor.closed?.code, 1012)
  assert.deepEqual(parseFrame(live.sent[0]!), { t: "ws-close", id: "wabc-1" })
})
