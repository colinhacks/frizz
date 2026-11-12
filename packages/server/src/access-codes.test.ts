import assert from "node:assert/strict"
import test from "node:test"
import { createHmac, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AccessStore,
  adoptSessionState,
  advanceSessionEpoch,
  DEFAULT_CODE_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  describeDevice,
  fileSessionDirectory,
  loadOrCreateSessionKey,
  loadSessionState,
  readSessionEpoch,
  secretsMatch,
  SESSION_EPOCH,
  sessionEpochNotice,
  signedInAgo,
} from "./access-codes.ts"

/** A clock the test drives, so expiry is exercised without sleeping through it. */
function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

function counter() {
  let n = 0
  return () => `token-${++n}`
}

test("a device's sign-in age reads in the house duration grammar, coarse enough to tell two apart", () => {
  const now = 1_000_000_000
  assert.equal(signedInAgo(now - 30_000, now), "just now")
  assert.equal(signedInAgo(now - 40 * 60_000, now), "40m ago")
  assert.equal(signedInAgo(now - 3 * 3_600_000, now), "3h ago")
  assert.equal(signedInAgo(now - 50 * 3_600_000, now), "2d ago")
  assert.equal(signedInAgo(now + 5_000, now), "just now", "a clock that moved back reads as now, not negative")
})

test("a code works exactly once, and the second attempt says so", () => {
  // The property the whole design rests on. If a code can be spent twice, "single-use" is a comment.
  const store = new AccessStore({ randomToken: counter() })
  const { code } = store.issue()

  const first = store.redeem(code)
  assert.equal(first.ok, true)
  assert.ok(first.ok && first.session.length > 0)

  const second = store.redeem(code)
  assert.deepEqual(second, { ok: false, reason: "already-used" })

  // Consumed codes stop being offered, but are REMEMBERED so a replay is distinguishable from a typo.
  assert.deepEqual(store.outstanding(), [])
  assert.deepEqual(store.redeem("token-never-issued"), { ok: false, reason: "unknown" })
})

test("two redemptions of one code cannot both win", () => {
  // The race a naive check-then-set loses. Redeem is synchronous and marks consumed before returning,
  // so interleaving is impossible — this pins that rather than trusting it.
  const store = new AccessStore({ randomToken: counter() })
  const { code } = store.issue()
  const results = [store.redeem(code), store.redeem(code), store.redeem(code)]
  assert.equal(results.filter((r) => r.ok).length, 1, "exactly one redemption may succeed")
})

test("codes expire on a human timescale, because a photographed QR is a real vector", () => {
  const time = clock()
  const store = new AccessStore({ now: time.now, randomToken: counter() })
  const { code, expiresAt } = store.issue()
  assert.equal(expiresAt - time.now(), DEFAULT_CODE_TTL_MS)

  time.advance(DEFAULT_CODE_TTL_MS - 1)
  assert.equal(store.outstanding().length, 1, "still redeemable one millisecond before expiry")

  time.advance(2)
  assert.deepEqual(store.redeem(code), { ok: false, reason: "expired" })
  assert.deepEqual(store.outstanding(), [], "expired codes are swept, not left to accumulate")
})

test("issuing a code does not invalidate one already outstanding", () => {
  // Pressing the key twice, or two people asking at once, must not silently break the first QR.
  const store = new AccessStore({ randomToken: counter() })
  const first = store.issue()
  const second = store.issue()
  assert.notEqual(first.code, second.code)
  assert.equal(store.outstanding().length, 2)
  assert.equal(store.redeem(first.code).ok, true)
  assert.equal(store.redeem(second.code).ok, true)
})

test("a session verifies, expires on its own terms, and dies when the key rotates", () => {
  const time = clock()
  const store = new AccessStore({ now: time.now, randomToken: counter(), sessionTtlMs: 10_000 })
  const redeemed = store.redeem(store.issue().code)
  assert.ok(redeemed.ok)
  const session = redeemed.session

  assert.equal(store.verifySession(session), true)
  time.advance(10_001)
  assert.equal(store.verifySession(session), false, "a session past its own expiry is refused")

  // A board with a DIFFERENT key rejects it — that is what rotating the key means, and it is the
  // revocation story.
  const rotated = new AccessStore({ now: time.now, randomToken: counter(), signingKey: Buffer.alloc(32, 9) })
  assert.equal(rotated.verifySession(session), false)
})

test("a session SURVIVES a restart when the signing key is persisted", () => {
  // The bug this pins cost a real sign-out: the key defaulted to a fresh random per process, so every
  // artifact update, crash or ctrl-C silently signed out every device — making a nominally year-long
  // cookie last only until the next restart. The board must load the same key back.
  const key = randomBytes(32)
  const dir = mkdtempSync(join(tmpdir(), "frizz-session-restart-"))
  try {
    const first = new AccessStore({ signingKey: key, sessions: fileSessionDirectory(dir), randomToken: counter() })
    const redeemed = first.redeem(first.issue().code)
    assert.ok(redeemed.ok)

    const afterRestart = new AccessStore({ signingKey: key, sessions: fileSessionDirectory(dir), randomToken: counter() })
    assert.equal(afterRestart.verifySession(redeemed.session), true, "the phone stays signed in")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the session key is persisted at 0600 and reloaded, not regenerated", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-session-key-"))
  const first = loadOrCreateSessionKey(dir)
  const second = loadOrCreateSessionKey(dir)
  assert.deepEqual(second, first, "a second start must reuse the key, or every restart signs out")
  assert.equal(first.byteLength, 32)
  // The mode bits only — everything above this line is asserted on every platform. Windows has no
  // POSIX permission bits: NTFS access is an ACL, `fs.chmod` there sets nothing but the read-only
  // flag, and node reports 0666 for any writable file. The key is still written with mode 0o600, which
  // is simply inert there; restricting it would take an icacls ACL, which frizz does not attempt.
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, "session-key")).mode & 0o777, 0o600, "a world-readable key is a forgeable session")
  }
  rmSync(dir, { recursive: true, force: true })
})

test("a truncated key file is replaced rather than used", () => {
  // A short read would silently weaken every signature; treat it as absent.
  const dir = mkdtempSync(join(tmpdir(), "frizz-session-key-"))
  writeFileSync(join(dir, "session-key"), Buffer.alloc(4))
  const key = loadOrCreateSessionKey(dir)
  assert.equal(key.byteLength, 32)
  rmSync(dir, { recursive: true, force: true })
})

test("a forged or tampered session is refused", () => {
  const store = new AccessStore({ randomToken: counter() })
  const redeemed = store.redeem(store.issue().code)
  assert.ok(redeemed.ok)
  const session = redeemed.session
  const [expiry, nonce, signature] = session.split(".")

  for (const forged of [
    undefined,
    "",
    "garbage",
    session.slice(0, -1),
    `${expiry}.${nonce}.${"A".repeat(signature!.length)}`,
    // The interesting one: push the expiry far out and keep the original signature.
    `${Number(expiry) + 10_000_000}.${nonce}.${signature}`,
  ]) {
    assert.equal(store.verifySession(forged), false, `accepted a forged session: ${String(forged)}`)
  }
})

test("consumption notifies, so a launcher can repaint a spent QR", () => {
  const seen: string[] = []
  const store = new AccessStore({ randomToken: counter(), onConsumed: (code) => seen.push(code) })
  const { code } = store.issue()
  store.redeem(code)
  store.redeem(code)
  assert.deepEqual(seen, [code], "fires on the successful redemption only")
})

test("secret comparison is length-safe and constant-time", () => {
  assert.equal(secretsMatch("abc", "abc"), true)
  assert.equal(secretsMatch("abc", "abd"), false)
  assert.equal(secretsMatch("abc", "abcd"), false, "different lengths must not throw")
  assert.equal(secretsMatch("", ""), true)
})

test("a redeemed session can be signed out on its own, without touching the others", () => {
  // The point of the whole id: losing a phone must not sign out the laptop. Before this, the only
  // revocation was rotating the key, which kicks every device the operator owns.
  const store = new AccessStore()
  const phone = store.redeem(store.issue().code, "iPhone")
  const laptop = store.redeem(store.issue().code, "Chrome on macOS")
  assert.ok(phone.ok && laptop.ok)
  assert.equal(store.verifySession(phone.session), true)

  assert.equal(store.sessions.revoke(phone.id), true)
  assert.equal(store.verifySession(phone.session), false, "the signed-out phone still works")
  assert.equal(store.verifySession(laptop.session), true, "signing out the phone kicked the laptop")
})

test("signing out a device twice, or one that never existed, is reported rather than silently ignored", () => {
  const store = new AccessStore()
  const only = store.redeem(store.issue().code, "iPhone")
  assert.ok(only.ok)
  assert.equal(store.sessions.revoke(only.id), true)
  assert.equal(store.sessions.revoke(only.id), false, "a second sign-out claimed to do something")
  assert.equal(store.sessions.revoke("no-such-id"), false)
})

test("sign out everywhere reports how many devices it actually kicked", () => {
  const store = new AccessStore()
  const a = store.redeem(store.issue().code, "iPhone")
  const b = store.redeem(store.issue().code, "Firefox on Linux")
  assert.ok(a.ok && b.ok)
  assert.equal(store.sessions.revokeAll(), 2)
  assert.equal(store.sessions.revokeAll(), 0, "already-revoked devices were counted again")
  assert.equal(store.verifySession(a.session), false)
  assert.equal(store.verifySession(b.session), false)
})

test("signing everyone out also voids a code nobody has redeemed yet", () => {
  const store = new AccessStore()
  const waiting = store.issue()
  store.signOutAll()
  assert.deepEqual(store.redeem(waiting.code, "iPhone"), { ok: false, reason: "unknown" })
  assert.equal(store.redeem(store.issue().code, "iPhone").ok, true, "a code minted afterwards works")
})

test("the device list names what redeemed each link, newest first", () => {
  const store = new AccessStore()
  store.redeem(store.issue().code, "iPhone")
  store.redeem(store.issue().code, "Chrome on macOS")
  const listed = store.sessions.list()
  assert.deepEqual(listed.map((r) => r.label), ["Chrome on macOS", "iPhone"])
})

test("a session id cannot be swapped for another device's — the signature covers it", () => {
  // Otherwise revoking a phone would be undone by editing one field of the cookie.
  const store = new AccessStore()
  const phone = store.redeem(store.issue().code, "iPhone")
  const laptop = store.redeem(store.issue().code, "macOS")
  assert.ok(phone.ok && laptop.ok)
  store.sessions.revoke(phone.id);
  // Graft the laptop's (live) id into the phone's cookie.
  const [exp, , nonce, sig] = phone.session.split(".")
  assert.equal(store.verifySession(`${exp}.${laptop.id}.${nonce}.${sig}`), false)
})

test("the signing key alone mints nothing: a session has to exist in the directory, as it was issued", () => {
  // What a copy of `session-key` buys. Every cookie below carries a good signature.
  const key = Buffer.alloc(32, 7)
  const store = new AccessStore({ signingKey: key })
  const forge = (payload: string) => `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`
  const phone = store.redeem(store.issue().code, "iPhone")
  assert.ok(phone.ok)
  const hundredYears = Date.now() + 100 * 365 * 24 * 60 * 60_000

  assert.equal(store.verifySession(forge(`${Date.now() + 60_000}.never-recorded.nonce`)), false, "an id nobody redeemed")
  assert.equal(store.verifySession(forge(`${hundredYears}.never-recorded.nonce`)), false, "the same, for a century")
  assert.equal(store.verifySession(forge(`${Date.now() + 60_000}.two-part-nonce`)), false, "the old shape, with no id")
  assert.equal(store.verifySession(forge(`${hundredYears}.${phone.id}.nonce`)), false, "a real id, past the expiry it was issued")
  assert.equal(store.sessionIdOf(forge(`${hundredYears}.${phone.id}.nonce`)), null)

  // Inside the record's bounds it does verify. It shows under that device's label, and dies with it.
  const within = forge(`${phone.expiresAt}.${phone.id}.nonce`)
  assert.equal(store.verifySession(within), true)
  assert.equal(store.revokeSession(phone.id), true)
  assert.equal(store.verifySession(within), false)
})

test("a device label is coarse on purpose, and never invents one", () => {
  assert.equal(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1"), "Safari on iPhone")
  assert.equal(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"), "Chrome on macOS")
  assert.equal(describeDevice("Mozilla/5.0 (Windows NT 10.0) Edg/120"), "Edge on Windows")
  assert.equal(describeDevice(undefined), "unknown device")
  assert.equal(describeDevice("   "), "unknown device")
})

test("a sign-out survives a restart, because a forgotten one is not a sign-out", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sessions-"))
  try {
    const key = Buffer.alloc(32, 3)
    const first = new AccessStore({ signingKey: key, sessions: fileSessionDirectory(dir) })
    const phone = first.redeem(first.issue().code, "iPhone")
    assert.ok(phone.ok)
    assert.equal(first.sessions.revoke(phone.id), true)

    // A whole new board, same state directory and same key — which is exactly what a restart is.
    const second = new AccessStore({ signingKey: key, sessions: fileSessionDirectory(dir) })
    assert.equal(second.verifySession(phone.session), false, "the restart forgot the sign-out")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unreadable session directory leaves the board running rather than taking it down", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sessions-bad-"))
  try {
    writeFileSync(join(dir, "sessions.json"), "{ this is not json")
    const store = new AccessStore({ sessions: fileSessionDirectory(dir) })
    const ok = store.redeem(store.issue().code, "iPhone")
    assert.ok(ok.ok)
    assert.equal(store.verifySession(ok.session), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a session signs ITSELF out: its own id is revoked and persisted, and no other device is touched", () => {
  // The phone's "Sign out this device". The id is taken from the verified session, so the only
  // credential it can end is the one presented — the laptop beside it must not notice.
  const dir = mkdtempSync(join(tmpdir(), "frizz-sign-self-out-"))
  try {
    const store = new AccessStore({ sessions: fileSessionDirectory(dir) })
    const phone = store.redeem(store.issue().code, "Safari on iPhone")
    const laptop = store.redeem(store.issue().code, "Chrome on macOS")
    assert.ok(phone.ok && laptop.ok)

    assert.deepEqual(store.signOutSession(phone.session), { result: "revoked", id: phone.id })
    assert.equal(store.verifySession(phone.session), false, "the phone still works after signing itself out")
    assert.equal(store.verifySession(laptop.session), true, "signing the phone out kicked the laptop")
    // On disk, where a restart and `frizz --sessions` both read it.
    assert.notEqual(fileSessionDirectory(dir).get(phone.id)?.revokedAt, undefined)
    assert.equal(fileSessionDirectory(dir).get(laptop.id)?.revokedAt, undefined)

    // Once dead, presenting it again ends nothing.
    assert.deepEqual(store.signOutSession(phone.session), { result: "no-session" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("signing out needs a VALID session: nothing, a forgery, or a grafted id revokes nothing", () => {
  const store = new AccessStore()
  const phone = store.redeem(store.issue().code, "iPhone")
  const laptop = store.redeem(store.issue().code, "macOS")
  assert.ok(phone.ok && laptop.ok)
  assert.deepEqual(store.signOutSession(undefined), { result: "no-session" })
  assert.deepEqual(store.signOutSession(""), { result: "no-session" })
  // Graft the laptop's id into the phone's cookie: the signature no longer matches, so the laptop's id
  // never reaches the directory. This is what stops one device naming another's id.
  const [exp, , nonce, sig] = phone.session.split(".")
  assert.deepEqual(store.signOutSession(`${exp}.${laptop.id}.${nonce}.${sig}`), { result: "no-session" })
  assert.equal(store.verifySession(laptop.session), true)
  assert.equal(store.verifySession(phone.session), true)
  assert.deepEqual(store.sessions.list().filter((r) => r.revokedAt !== undefined), [])
})

test("a sign-out says who it ended, so whatever holds that device's sockets can close them", () => {
  const ended: Array<string | undefined> = []
  const store = new AccessStore({ onSignedOut: (id) => ended.push(id) })
  const phone = store.redeem(store.issue().code, "iPhone")
  const laptop = store.redeem(store.issue().code, "macOS")
  assert.ok(phone.ok && laptop.ok)

  assert.deepEqual(store.signOutSession(phone.session), { result: "revoked", id: phone.id })
  assert.deepEqual(ended, [phone.id])
  assert.equal(store.revokeSession(phone.id), false, "already gone")
  assert.equal(store.revokeSession("no-such-id"), false)
  assert.deepEqual(ended, [phone.id], "nothing happened, so nothing is announced")
  assert.equal(store.signOutAll(), 1)
  assert.deepEqual(ended, [phone.id, undefined])
})

test("a session lasts 30 days, and the redeem result says so", () => {
  assert.equal(DEFAULT_SESSION_TTL_MS, 30 * 24 * 60 * 60_000)
  const time = clock()
  const store = new AccessStore({ now: time.now, randomToken: counter() })
  const phone = store.redeem(store.issue().code, "iPhone")
  assert.ok(phone.ok)
  assert.equal(phone.expiresAt, time.now() + 30 * 24 * 60 * 60_000)
  assert.equal(store.sessions.list()[0]?.expiresAt, phone.expiresAt, "the directory records the expiry, so --sessions can drop dead rows")
  time.advance(30 * 24 * 60 * 60_000 - 1)
  assert.equal(store.verifySession(phone.session), true)
  time.advance(1)
  assert.equal(store.verifySession(phone.session), false, "a day-31 cookie still signed in")
})

/** A board that ran before session epochs existed: a key, a persisted directory, one signed-in phone. */
function preEpochBoard(dir: string) {
  const key = loadOrCreateSessionKey(dir)
  const store = new AccessStore({ signingKey: key, sessions: fileSessionDirectory(dir) })
  const phone = store.redeem(store.issue().code, "iPhone")
  assert.ok(phone.ok)
  assert.equal(readSessionEpoch(dir), 0)
  return { phone }
}

test("an epoch bump refuses every session from before it, once, and a new one works", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-epoch-"))
  try {
    const { phone } = preEpochBoard(dir)

    // The upgraded launcher's start.
    const upgraded = loadSessionState(dir)
    assert.deepEqual(upgraded.advance, { advanced: true, from: 0, to: SESSION_EPOCH, rotatedKey: true })
    assert.equal(upgraded.signedOut, 1)
    assert.match(sessionEpochNotice(upgraded.signedOut) ?? "", /signed out 1 remote device/)
    const board = new AccessStore({ signingKey: upgraded.key, sessions: upgraded.directory })
    assert.equal(board.verifySession(phone.session), false, "a pre-epoch session still verifies")
    assert.equal(board.sessions.list().every((r) => r.revokedAt !== undefined), true, "--sessions would still list the phone")

    const laptop = board.redeem(board.issue().code, "Chrome on macOS")
    assert.ok(laptop.ok)
    assert.equal(board.verifySession(laptop.session), true)

    // The next ordinary start: same epoch, so no rotation, and the new session lives on.
    const restarted = loadSessionState(dir)
    assert.deepEqual(restarted.advance, { advanced: false, epoch: SESSION_EPOCH })
    assert.equal(restarted.signedOut, 0)
    assert.equal(sessionEpochNotice(restarted.signedOut), null)
    assert.equal(restarted.key.equals(upgraded.key), true, "a second start rotated the key again")
    const after = new AccessStore({ signingKey: restarted.key, sessions: restarted.directory })
    assert.equal(after.verifySession(laptop.session), true, "a second start signed the new device out")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a first run records the epoch without claiming to have signed anyone out", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-epoch-fresh-"))
  try {
    const fresh = loadSessionState(dir)
    assert.deepEqual(fresh.advance, { advanced: true, from: 0, to: SESSION_EPOCH, rotatedKey: false })
    assert.equal(fresh.signedOut, 0)
    assert.equal(sessionEpochNotice(fresh.signedOut), null)
    assert.equal(readSessionEpoch(dir), SESSION_EPOCH)
    assert.equal(loadSessionState(dir).key.equals(fresh.key), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a board that recorded a newer epoch than its code (a downgrade) is left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-epoch-down-"))
  try {
    advanceSessionEpoch(dir, SESSION_EPOCH + 1)
    const key = loadOrCreateSessionKey(dir)
    assert.deepEqual(advanceSessionEpoch(dir, SESSION_EPOCH), { advanced: false, epoch: SESSION_EPOCH + 1 })
    assert.equal(loadOrCreateSessionKey(dir).equals(key), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unreadable epoch record errs towards one more sign-out, never towards keeping a session", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-epoch-bad-"))
  try {
    const key = loadOrCreateSessionKey(dir)
    writeFileSync(join(dir, "session-epoch"), "{ not json")
    assert.equal(readSessionEpoch(dir), 0)
    assert.equal(advanceSessionEpoch(dir).advanced, true)
    assert.equal(loadOrCreateSessionKey(dir).equals(key), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("sign out all rotates the key as well as marking every record", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-signout-all-"))
  try {
    const { phone } = preEpochBoard(dir)
    let rotated: Buffer | undefined
    const board = new AccessStore({
      signingKey: loadOrCreateSessionKey(dir),
      sessions: fileSessionDirectory(dir),
      rotateSigningKey: () => (rotated = Buffer.alloc(32, 5)),
    })
    assert.equal(board.signOutAll(), 1)
    assert.ok(rotated)
    assert.equal(board.verifySession(phone.session), false)
    const next = board.redeem(board.issue().code, "iPad")
    assert.ok(next.ok)
    assert.equal(board.verifySession(next.session), true, "the board stopped minting usable sessions")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an expired device is not counted as signed out", () => {
  // The directory judges expiry by the wall clock (it stamps revokedAt with one too), so start there.
  const store = new AccessStore({ randomToken: counter() })
  store.sessions.record({ id: "old", label: "iPhone", createdAt: 1, expiresAt: 2 })
  assert.ok(store.redeem(store.issue().code, "iPad").ok)
  assert.equal(store.sessions.revokeAll(), 1)
})

test("a state folder with no sign-in state takes over the one a device signed in to most recently", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-session-adopt-"))
  try {
    const [own, older, newer, empty] = ["own", "older", "newer", "empty"].map((name) => join(root, name))
    for (const dir of [older, newer, empty]) mkdirSync(dir)
    const oldKey = loadOrCreateSessionKey(older)
    advanceSessionEpoch(newer)
    const liveKey = loadOrCreateSessionKey(newer)
    fileSessionDirectory(newer).record({ id: "phone", label: "iPhone", createdAt: 1 })
    // The OLDER folder's key was made last; the newer folder is the one a device actually used since.
    utimesSync(join(older, "session-key"), new Date(5_000_000), new Date(5_000_000))
    utimesSync(join(newer, "session-key"), new Date(1_000_000), new Date(1_000_000))
    utimesSync(join(newer, "sessions.json"), new Date(9_000_000), new Date(9_000_000))

    assert.equal(adoptSessionState(own, [older, newer, empty, own, join(root, "missing")]), newer)
    assert.deepEqual(loadOrCreateSessionKey(own), liveKey)
    assert.notDeepEqual(loadOrCreateSessionKey(own), oldKey)
    assert.equal(readSessionEpoch(own), readSessionEpoch(newer))
    assert.deepEqual(fileSessionDirectory(own).list().map((record) => record.id), ["phone"])
    assert.equal(statSync(join(own, "session-key")).mode & 0o777, 0o600)
    // Loading it afterwards signs nobody out: the epoch came with the key.
    assert.equal(loadSessionState(own).signedOut, 0)

    // A folder that has its own is never overwritten, and with nothing to take it stays empty.
    assert.equal(adoptSessionState(own, [older]), undefined)
    assert.deepEqual(readFileSync(join(own, "session-key")), liveKey)
    assert.equal(adoptSessionState(join(root, "fresh"), [empty, join(root, "missing")]), undefined)
    assert.equal(existsSync(join(root, "fresh")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a session verifies only on the host it was issued under, and again when the board comes back to it", () => {
  const store = new AccessStore()
  store.setHost("ada.frizz.sh")
  const redeemed = store.redeem(store.issue().code, "iPhone")
  assert.ok(redeemed.ok)
  assert.equal(store.sessions.get(redeemed.id)?.host, "ada.frizz.sh")
  assert.equal(store.verifySession(redeemed.session), true)
  // The name this board left can be claimed by another board, which collects the cookie phones send it.
  store.setHost("colin.frizz.sh")
  assert.equal(store.verifySession(redeemed.session), false, "a cookie from the old name opens nothing on the new one")
  store.setHost(undefined)
  assert.equal(store.verifySession(redeemed.session), false, "nor with no public host at all")
  store.setHost("ada.frizz.sh")
  assert.equal(store.verifySession(redeemed.session), true, "back on its own name, the device is signed in again")
})

test("a session from before host binding is bound to the first host declared, and to no other", () => {
  const store = new AccessStore()
  const legacy = store.redeem(store.issue().code, "iPhone")
  assert.ok(legacy.ok)
  assert.equal(store.sessions.get(legacy.id)?.host, undefined, "issued with no host, as before 2026-11-12")
  store.setHost("ada.frizz.sh")
  assert.equal(store.sessions.get(legacy.id)?.host, "ada.frizz.sh")
  assert.equal(store.verifySession(legacy.session), true)
  store.setHost("colin.frizz.sh")
  assert.equal(store.sessions.get(legacy.id)?.host, "ada.frizz.sh", "binding happens once")
  assert.equal(store.verifySession(legacy.session), false)
})

test("a name claimed afresh signs out the devices signed in under it, and only those", () => {
  const signedOut: Array<string | undefined> = []
  const store = new AccessStore({ onSignedOut: (id) => signedOut.push(id) })
  store.setHost("ada.frizz.sh")
  const first = store.redeem(store.issue().code, "iPhone")
  const second = store.redeem(store.issue().code, "iPad")
  store.setHost("colin.frizz.sh")
  const elsewhere = store.redeem(store.issue().code, "Android")
  assert.ok(first.ok && second.ok && elsewhere.ok)
  assert.equal(store.revokeSessionsFor("ada.frizz.sh"), 2)
  assert.deepEqual(signedOut.sort(), [first.id, second.id].sort(), "each one reported, so its sockets close")
  assert.equal(store.verifySession(elsewhere.session), true, "a device on another name is untouched")
  store.setHost("ada.frizz.sh")
  assert.equal(store.verifySession(first.session), false)
  assert.equal(store.revokeSessionsFor("ada.frizz.sh"), 0, "nothing left to sign out")
})

test("a sign-in code redeems only on the name it was minted for, and still does if the board comes back within its life", () => {
  const store = new AccessStore()
  store.setHost("ada.frizz.sh")
  const code = store.issue().code
  store.setHost("colin.frizz.sh")
  assert.deepEqual(store.redeem(code, "iPhone"), { ok: false, reason: "unknown" }, "a link for the old name signs nobody in under the new one")
  store.setHost(undefined)
  assert.deepEqual(store.redeem(code, "iPhone"), { ok: false, reason: "unknown" })
  store.setHost("ada.frizz.sh")
  const redeemed = store.redeem(code, "iPhone")
  assert.ok(redeemed.ok, "the control: on its own name the same code still works, once")
  assert.equal(store.sessions.get(redeemed.id)?.host, "ada.frizz.sh")
})
