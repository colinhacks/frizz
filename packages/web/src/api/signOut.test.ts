import assert from "node:assert/strict"
import test from "node:test"
import { isRemoteSession, leaveAfterSignOut, SIGN_OUT_THIS_DEVICE_PATH, signOutThisDevice } from "./signOut.ts"

function reply(status: number, body: unknown, contentType = "application/json; charset=utf-8") {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": contentType } })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

test("the row shows only on a page the supervisor says holds a remote session", () => {
  assert.equal(isRemoteSession({ protocol: 1, state: "ready", remoteSession: true }), true)
  // Loopback, an older supervisor without the field, and no supervisor at all read the same: no row.
  assert.equal(isRemoteSession({ protocol: 1, state: "ready" }), false)
  assert.equal(isRemoteSession(null), false)
  assert.equal(isRemoteSession(undefined), false)
})

test("signing out POSTs to the supervisor with no body — the server takes the id from the cookie", async () => {
  const { fetcher, calls } = reply(200, { protocol: 1, result: "signed-out", id: "abc" })
  const outcome = await signOutThisDevice(fetcher)
  assert.equal(outcome.signedOut, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, SIGN_OUT_THIS_DEVICE_PATH)
  assert.equal(calls[0]!.init?.method, "POST")
  assert.equal(calls[0]!.init?.body, undefined, "a body naming an id would be the wrong shape for this endpoint")
})

test("a pre-id session and an already-dead cookie both leave this browser signed out", async () => {
  assert.equal((await signOutThisDevice(reply(200, { protocol: 1, result: "cookie-cleared" }).fetcher)).signedOut, true)
  assert.equal((await signOutThisDevice(reply(401, { protocol: 1, result: "no-remote-session" }).fetcher)).signedOut, true)
})

test("a loopback tab has nothing to sign out, and is not told it did", async () => {
  assert.equal((await signOutThisDevice(reply(200, { protocol: 1, result: "no-remote-session" }).fetcher)).signedOut, false)
})

test("a server without the endpoint is an error, not a silent sign-out", async () => {
  await assert.rejects(signOutThisDevice(reply(404, "<!doctype html>", "text/html").fetcher), /cannot sign a device out/)
  await assert.rejects(signOutThisDevice(reply(200, { protocol: 1, result: "something-else" }).fetcher), /cannot sign a device out/)
})

test("leaving replaces the history entry, so Back cannot return to the board", () => {
  const moves: [string | null, boolean | undefined][] = []
  leaveAfterSignOut((to, options) => (moves.push([to, options.replace]), true))
  assert.deepEqual(moves, [["/", true]])
})
