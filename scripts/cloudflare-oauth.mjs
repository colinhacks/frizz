// Signs the maintainer in to Cloudflare for ONE sitting, through the private OAuth client on the Frizz
// account, so a Workers deploy needs an Authorize click instead of a hand-made dashboard token.
//
//   env -u NODE_COMPAT nub scripts/cloudflare-oauth.mjs <dir outside the repository>
//
// It prints a link. Whoever opens it sees Cloudflare's consent screen, picks the Frizz account and
// selects Authorize. The token that comes back is handed to scripts/cloudflare-sitting.sh on stdin, and
// that holder runs the verbs (audit, deploy, revoke, exit) a sitting needs, with a person's judgment in
// between. When the holder exits, the token is revoked here.
//
// WHY OAUTH. Everything that mints the CI tokens needs Account API Tokens Write, and Cloudflare refuses
// that permission on a token made through its API. Until 2026-11-09 the only other source was a token
// the maintainer made by hand in the dashboard for each deploy, and pasted (maintainer: "That's so
// annoying to me"). A consent screen gives the same permission for one sitting with one click.
//
// WHAT THIS MUST NOT BECOME. Whatever can mint a deploy token has code execution on every board behind
// the relay (the 2026-09 chain), so:
//   - Nothing is stored. The access token lives in this process and the holder's, and is never in a
//     file, an argv or a transcript. Never add it to Keyward: the maintainer decided that on 2026-11-09.
//   - No `offline_access`, so Cloudflare issues no refresh token, and the sitting ends with the token.
//   - The client is PRIVATE, so only members of the Frizz account can authorize it, and it has no
//     secret: a command-line program cannot keep one, so PKCE proves the code came back to this process.
//   - The token mints the deploy token and does not upload anything itself. Uploads under a member's
//     own login are exactly what scripts/workers-drift.mjs alarms on, and the CI token must stay
//     account-owned for that check to mean anything.
//
// Cloudflare's reference: https://developers.cloudflare.com/fundamentals/oauth/

import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** The private client on the Frizz account. Not a secret: a PKCE client has none. */
export const CLIENT_ID = ""

export const PORT = 8977
/** Registered on the client exactly, so the two must change together. */
export const REDIRECT_URI = `http://localhost:${PORT}/callback`
/** Mirrors what scripts/cloudflare-tokens.mjs needs of its credential. Anything wider is a mistake. */
export const SCOPES = ["account-api-tokens.write", "account-settings.read", "zone.read"]

const AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth"
const TOKEN = "https://dash.cloudflare.com/oauth2/token"
const REVOKE = "https://dash.cloudflare.com/oauth2/revoke"
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000

const base64url = (bytes) => bytes.toString("base64url")

export function pkcePair() {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) }
}

export function authorizeUrl({ clientId, state, challenge }) {
  const url = new URL(AUTHORIZE)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()
  return url.toString()
}

/**
 * Waits on loopback for the browser to come back with the code. A request carrying the wrong state is
 * answered 400 and ignored rather than ending the wait, so another program knocking on the port can
 * neither inject a code nor cancel the sign-in. Resolves to `{ port, code }`, where `code` is a promise.
 */
export async function listenForCode({ state, port = PORT, timeoutMs = SIGN_IN_TIMEOUT_MS }) {
  let settle
  const code = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  const servers = []
  const finish = (act, value) => {
    clearTimeout(timer)
    for (const server of servers) {
      server.close()
      server.closeAllConnections?.()
    }
    act(value)
  }
  const onRequest = (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const page = (status, text) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" })
      response.end(`${text}\n`)
    }
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) return page(400, "Not the sign-in this program is waiting for.")
    const refused = url.searchParams.get("error")
    if (refused) {
      page(200, "Cloudflare did not authorize this sign-in. Nothing was granted.")
      return finish(settle.reject, new Error(`Cloudflare refused the sign-in: ${refused}`))
    }
    const received = url.searchParams.get("code")
    if (!received) return page(400, "That answer carried no code.")
    page(200, "Frizz is signed in to Cloudflare for this one sitting. You can close this tab.")
    finish(settle.resolve, received)
  }
  const timer = setTimeout(() => finish(settle.reject, new Error("nobody authorized the sign-in within 10 minutes")), timeoutMs)
  timer.unref?.()

  const listen = (host, onPort) =>
    new Promise((resolve, reject) => {
      const server = createServer(onRequest)
      server.once("error", reject)
      server.listen(onPort, host, () => {
        servers.push(server)
        resolve(server.address().port)
      })
    })
  let bound
  try {
    bound = await listen("127.0.0.1", port)
  } catch (error) {
    clearTimeout(timer)
    throw error
  }
  // `localhost` can resolve to either address. A machine with no IPv6 loopback just loses this listener.
  await listen("::1", bound).catch(() => {})
  return { port: bound, code }
}

const form = (fields) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
})

/** Trades the code for a token. Errors name Cloudflare's reason and never carry the code or the token. */
export async function exchangeCode({ clientId, code, verifier, fetchImpl = fetch }) {
  const response = await fetchImpl(TOKEN, form({ grant_type: "authorization_code", client_id: clientId, redirect_uri: REDIRECT_URI, code, code_verifier: verifier }))
  const parsed = await response.json().catch(() => null)
  if (!response.ok || !parsed?.access_token) {
    throw new Error(`Cloudflare did not issue a token: HTTP ${response.status} ${parsed?.error ?? ""} ${parsed?.error_description ?? ""}`.trim())
  }
  return {
    token: parsed.access_token,
    expiresIn: parsed.expires_in ?? null,
    scopes: String(parsed.scope ?? "").split(" ").filter(Boolean),
    refreshToken: parsed.refresh_token ?? null,
  }
}

export async function revokeToken({ clientId, token, fetchImpl = fetch }) {
  const response = await fetchImpl(REVOKE, form({ client_id: clientId, token }))
  return response.ok
}

/** Which required scopes the consent screen did not grant. An empty answer from Cloudflare proves nothing, so it is not a refusal. */
export function missingScopes(granted) {
  return granted.length === 0 ? [] : SCOPES.filter((scope) => !granted.includes(scope))
}

async function main([dir]) {
  if (!dir) throw new Error("usage: cloudflare-oauth.mjs <dir outside the repository>")
  if (!CLIENT_ID) throw new Error("CLIENT_ID is empty: create the private OAuth client first, see this file's header")
  const { verifier, challenge } = pkcePair()
  const state = base64url(randomBytes(16))
  const { code } = await listenForCode({ state })
  console.log(`Open this link and select Authorize, with the Frizz account picked:\n\n${authorizeUrl({ clientId: CLIENT_ID, state, challenge })}\n`)
  const session = await exchangeCode({ clientId: CLIENT_ID, code: await code, verifier })
  const revoke = async () => {
    const tokens = [session.token, session.refreshToken].filter(Boolean)
    const results = await Promise.all(tokens.map((token) => revokeToken({ clientId: CLIENT_ID, token }).catch(() => false)))
    console.log(results.every(Boolean) ? "revoked the sign-in" : "COULD NOT revoke the sign-in: it ends when it expires, or at Manage OAuth authorizations on the profile page")
  }
  const missing = missingScopes(session.scopes)
  if (missing.length) {
    await revoke()
    throw new Error(`the sign-in lacks ${missing.join(", ")}: authorize again with every permission on`)
  }
  const expiresAt = session.expiresIn ? new Date(Date.now() + session.expiresIn * 1000).toISOString() : "unknown"
  console.log(`signed in, expires ${expiresAt}, scopes ${session.scopes.join(" ") || "(not reported)"}${session.refreshToken ? ", and Cloudflare sent a refresh token anyway, which is dropped" : ""}`)

  const holder = spawn("bash", [join(dirname(fileURLToPath(import.meta.url)), "cloudflare-sitting.sh"), "-", resolve(dir), "oauth", expiresAt], { stdio: ["pipe", "inherit", "inherit"] })
  holder.stdin.end(`${session.token}\n`)
  const stop = () => holder.kill("SIGTERM")
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  const status = await new Promise((resolve) => holder.once("close", (exit) => resolve(exit ?? 1)))
  await revoke()
  return status
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (status) => process.exit(status),
    (error) => {
      console.error(error.message)
      process.exit(1)
    },
  )
}
