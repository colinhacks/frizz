import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { authorizeUrl, exchangeCode, listenForCode, missingScopes, pkcePair, revokeToken } from "./cloudflare-oauth.mjs"
import { scopesForJob } from "./cloudflare-tokens.mjs"

const SCOPES = scopesForJob("deploy")

const callback = (port, query) => fetch(`http://127.0.0.1:${port}/callback?${query}`)

test("the link asks for exactly the job's scopes, with PKCE, and never for a refresh token", () => {
  const { verifier, challenge } = pkcePair()
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"))
  const url = new URL(authorizeUrl({ clientId: "client", state: "st", challenge, scopes: SCOPES }))
  assert.equal(url.origin + url.pathname, "https://dash.cloudflare.com/oauth2/auth")
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("code_challenge"), challenge)
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8977/callback")
  assert.deepEqual(url.searchParams.get("scope").split(" "), SCOPES)
  assert.doesNotMatch(url.search, /offline/)
  assert.equal(url.searchParams.has("code_verifier"), false, "the verifier stays in this process")
})

test("a request with the wrong state can neither hand in a code nor end the wait", async () => {
  const { port, code } = await listenForCode({ state: "right", port: 0 })
  assert.equal((await callback(port, "state=wrong&code=planted")).status, 400)
  assert.equal((await callback(port, "state=wrong&error=access_denied")).status, 400)
  assert.equal((await callback(port, "state=right&code=the-code")).status, 200)
  assert.equal(await code, "the-code")
})

test("declining on the consent screen ends the sign-in with Cloudflare's reason", async () => {
  const { port, code } = await listenForCode({ state: "right", port: 0 })
  const failed = assert.rejects(code, /access_denied/)
  await callback(port, "state=right&error=access_denied")
  await failed
})

test("the sign-in gives up when nobody authorizes it", async () => {
  const { code } = await listenForCode({ state: "right", port: 0, timeoutMs: 5 })
  await assert.rejects(code, /nobody authorized/)
})

test("the code is exchanged with its verifier, and a refusal carries neither", async () => {
  let sent
  const issued = await exchangeCode({
    clientId: "client",
    code: "the-code",
    verifier: "the-verifier",
    fetchImpl: async (url, init) => {
      sent = { url, body: new URLSearchParams(init.body) }
      return Response.json({ access_token: "tok", expires_in: 3600, scope: SCOPES.join(" ") })
    },
  })
  assert.equal(sent.url, "https://dash.cloudflare.com/oauth2/token")
  assert.equal(sent.body.get("grant_type"), "authorization_code")
  assert.equal(sent.body.get("code_verifier"), "the-verifier")
  assert.equal(sent.body.has("client_secret"), false)
  assert.deepEqual(issued, { token: "tok", expiresIn: 3600, scopes: SCOPES, refreshToken: null })

  await assert.rejects(
    exchangeCode({ clientId: "client", code: "the-code", verifier: "the-verifier", fetchImpl: async () => Response.json({ error: "invalid_grant" }, { status: 400 }) }),
    (error) => /invalid_grant/.test(error.message) && !/the-code|the-verifier/.test(error.message),
  )
})

test("a sign-in missing a scope is caught, and one that reports none is left to the API to judge", () => {
  assert.deepEqual(missingScopes(SCOPES, SCOPES), [])
  assert.deepEqual(missingScopes(["zone.read"], ["account-api-tokens.write", "zone.read"]), ["account-api-tokens.write"])
  assert.deepEqual(missingScopes([], SCOPES), [])
})

test("revoking posts the token to Cloudflare's revoke endpoint", async () => {
  let sent
  const ok = await revokeToken({
    clientId: "client",
    token: "tok",
    fetchImpl: async (url, init) => {
      sent = { url, body: new URLSearchParams(init.body) }
      return new Response(null, { status: 200 })
    },
  })
  assert.equal(ok, true)
  assert.equal(sent.url, "https://dash.cloudflare.com/oauth2/revoke")
  assert.equal(sent.body.get("token"), "tok")
})
