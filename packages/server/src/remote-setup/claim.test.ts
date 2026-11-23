import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { isAnonymousClaimName, verifyClaim } from "@frizz/shared/claim"
import { claimFrizzName, ClaimError, claimIdentityPath, tunnelTokenPath } from "./claim.ts"

// The server's copy of the claim the R menu makes (claim.ts), against a registrar on loopback that checks
// each request's signature for real. The shell's own copy is pinned by src/cloud.test.ts.

delete process.env.FRIZZ_CUSTOM_NAMES
for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete process.env[name]

interface Heard {
  name: string
  github?: string
  verified: boolean
}

/** A registrar: holds names by key, asks for GitHub on a new custom name, and answers as `answer` says. */
async function registrar(t: test.TestContext, answer: (claim: Heard, held: boolean) => { status?: number; body: unknown }) {
  const heard: Heard[] = []
  const owners = new Map<string, string>()
  const server: Server = createServer((req, res) => {
    let body = ""
    req.setEncoding("utf8")
    req.on("data", (chunk: string) => (body += chunk))
    req.on("end", async () => {
      const request = JSON.parse(body) as { name: string; github?: string; pubkey: string }
      const verdict = await verifyClaim(request, Date.now())
      const claim = { name: request.name, ...(request.github ? { github: request.github } : {}), verified: verdict.ok }
      heard.push(claim)
      const held = owners.get(claim.name) === request.pubkey
      const reply = answer(claim, held)
      if ((reply.status ?? 200) === 200) owners.set(claim.name, request.pubkey)
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" })
      res.end(JSON.stringify(reply.body))
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, heard }
}

function home(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "frizz-remote-setup-claim-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const noGithub = { authorize: async () => { throw new Error("GitHub was asked") } }

test("an empty name mints one of this key's random names, with no GitHub, and says whether it was new", async (t) => {
  const { origin, heard } = await registrar(t, (claim, held) => ({ body: { hostname: `${claim.name}.frizz.test`, leaseExpiresAt: 1, renewed: held } }))
  const dir = home(t)
  const said: string[] = []
  const first = await claimFrizzName("", 9393, { home: dir, origin, github: noGithub, say: (line) => said.push(line) })
  assert.ok(isAnonymousClaimName(first.config.claim!), first.config.claim)
  assert.deepEqual(first, { config: { hostname: `${first.config.claim}.frizz.test`, claim: first.config.claim, serve: "relay" }, fresh: true })
  assert.deepEqual(said, ["  claiming a frizz.sh subdomain — no account needed"])
  assert.equal(statSync(claimIdentityPath(dir)).mode & 0o777, 0o600, "the key is the owner's alone")
  // The same key claims the same name again, which the registrar renews.
  const again = await claimFrizzName(first.config.claim!, 9393, { home: dir, origin, github: noGithub })
  assert.equal(again.fresh, false)
  assert.deepEqual(heard.map((claim) => [claim.name, claim.verified, claim.github]), [[first.config.claim, true, undefined], [first.config.claim, true, undefined]])
})

test("a custom name is sent with Frizz's GitHub sign-in only once the registrar asks, and only for the account's own name", async (t) => {
  const { origin, heard } = await registrar(t, (claim, held) =>
    !held && !claim.github ? { status: 403, body: { error: "github-required" } } : { body: { hostname: `${claim.name}.frizz.test`, leaseExpiresAt: 1, renewed: held } })
  const dir = home(t)
  const said: string[] = []
  const ada = { authorize: async () => ({ token: "gho_ada", login: "Ada" }) }
  const claimed = await claimFrizzName("ada", 9393, { home: dir, origin, github: ada, say: (line) => said.push(line) })
  assert.deepEqual(claimed, { config: { hostname: "ada.frizz.test", claim: "ada", serve: "relay" }, fresh: true })
  assert.deepEqual(heard.map((claim) => claim.github), [undefined, "gho_ada"])
  assert.deepEqual(said, ["  claiming ada.frizz.sh for GitHub user Ada"])

  await assert.rejects(
    claimFrizzName("grace", 9393, { home: dir, origin, github: ada }),
    (error: unknown) => error instanceof ClaimError && error.code === "not-your-github-username",
  )
  assert.deepEqual(heard.slice(2).map((claim) => [claim.name, claim.github]), [["grace", undefined]], "the token never went with a name that is not the account's")
})

test("an answer for another name is refused, and a refusal is said in words a person can act on", async (t) => {
  const { origin } = await registrar(t, (claim) =>
    claim.name === "taken" ? { status: 409, body: { error: "name-taken" } } : { body: { hostname: "evil.example.com", leaseExpiresAt: 1, renewed: false } })
  const dir = home(t)
  const ada = { authorize: async () => ({ token: "gho_ada", login: "taken" }) }
  await assert.rejects(claimFrizzName("", 9393, { home: dir, origin, github: noGithub }), (error: unknown) => error instanceof ClaimError && error.code === "malformed-response")
  await assert.rejects(claimFrizzName("taken", 9393, { home: dir, origin, github: ada }), /that name is already taken — try another/)
})

test("a registrar in tunnel mode hands back a run token, kept beside the key and for the owner alone", async (t) => {
  const { origin } = await registrar(t, (claim) => ({ body: { hostname: `${claim.name}.frizz.test`, token: "run-token", leaseExpiresAt: 1, renewed: false } }))
  const dir = home(t)
  const claimed = await claimFrizzName("", 9393, { home: dir, origin, github: noGithub })
  assert.equal(claimed.config.serve, "tunnel")
  assert.equal(readFileSync(tunnelTokenPath(dir), "utf8"), "run-token\n")
  assert.equal(statSync(tunnelTokenPath(dir)).mode & 0o777, 0o600)
})
