import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  CLAIM_PROTOCOL_VERSION,
  claimIdentityFromPrivateKey,
  claimNameIsValid,
  exportClaimPrivateKey,
  exportClaimPublicKey,
  generateClaimIdentity,
  isAnonymousClaimName,
  normalizeClaimName,
  pickAnonymousClaimName,
  signClaim,
} from "@frizz/shared/claim"
import { frizzPaths } from "../frizz-paths.ts"
import { GithubCredentialError, githubClaimToken } from "../github-credential.ts"
import { CLAIM_ZONE, type CloudConfig, CUSTOM_NAMES_PAUSED, customNamesOffered } from "./setup.ts"

/**
 * CLAIMING `<name>.frizz.sh` FROM THE R MENU — the server's copy of the claim.
 *
 * The shell keeps its own (src/identity.ts, src/registrar-client.ts, establishCloudConfig in
 * src/cloud.ts), because it still renews a served name's lease on every launch and every day, and still
 * asks for a name at a first `frizz up`. Both copies read and write the same files, so a name claimed
 * here is renewed there: the claim key and the run token in the state root (frizz-paths.ts).
 *
 * Kept to what the menu does: an empty name mints a random one with no account, and a word claims it as
 * the account's own GitHub username. A hostname is never claimed — the menu has rows for a tunnel.
 */

// ── The claim key ────────────────────────────────────────────────────────────────────────────────────

/** One key per machine, in the state root beside the run token. src/identity.ts says why not `~/.frizz`. */
export function claimIdentityPath(home = homedir(), env?: NodeJS.ProcessEnv): string {
  return join(frizzPaths({ home, env }).state, "identity.key")
}

/**
 * Load the identity, or mint one on first use. An unreadable key is an ERROR naming the file, never
 * quietly replaced: it is what proves the name is this machine's, and it is recoverable from a backup.
 */
export async function loadOrCreateClaimIdentity(home = homedir()): Promise<CryptoKeyPair> {
  const path = claimIdentityPath(home)
  let stored: Buffer | undefined
  try {
    stored = readFileSync(path)
  } catch {
    stored = undefined
  }
  if (stored !== undefined) {
    const identity = await claimIdentityFromPrivateKey(new Uint8Array(stored))
    if (identity) return identity
    throw new Error(
      `${path} is not a usable Frizz identity key. It is what proves you own your frizz.sh name, so it is not replaced automatically — restore it from a backup, or delete it to claim a new name.`,
    )
  }
  const identity = await generateClaimIdentity()
  mkdirSync(dirname(path), { recursive: true })
  // 0600 before anything is written: a world-readable identity is a name anyone on the box can take.
  writeFileSync(path, await exportClaimPrivateKey(identity.privateKey), { mode: 0o600 })
  return identity
}

/** Where the per-tunnel run token is cached: a credential, so 0600 and apart from cloud.json. */
export function tunnelTokenPath(home = homedir()): string {
  return join(frizzPaths({ home }).state, "tunnel-token")
}

function writeTunnelToken(token: string, home = homedir()): void {
  const path = tunnelTokenPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
}

// ── The registrar ────────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_REGISTRAR = "https://registrar.frizz.sh"

export function registrarOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRIZZ_REGISTRAR?.trim() || DEFAULT_REGISTRAR
}

/** https, or plain http to this machine's own loopback. */
export function carriesSecretsSafely(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol === "https:") return true
  return url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
}

export interface ClaimResult {
  hostname: string
  /** The per-tunnel run token, from a registrar in tunnel mode only; absent means the relay serves the name. */
  token?: string
  leaseExpiresAt: number
  /** False the first time a name is claimed, true for every renewal afterwards. */
  renewed: boolean
}

/** Messages for the failures a person can do something about; anything else is said in the registrar's words. */
const ADVICE: Record<string, string> = {
  "name-taken": "that name is already taken — try another",
  "github-required": "claiming a custom name needs a GitHub sign-in — sign in to GitHub in the board's Settings, then try again",
  "github-rejected": "GitHub did not recognise that sign-in — try again",
  "github-token-foreign": "a name is claimed with Frizz's own GitHub sign-in, and this was another kind of GitHub token — sign in to GitHub in the board's Settings, then try again",
  "github-token-scoped": "this registrar does not take Frizz's GitHub sign-in yet — try again once frizz.sh is updated",
  "github-too-new": "that GitHub account is too new to claim a name",
  "not-your-github-username": "a custom frizz.sh name is your own GitHub username, and this is not it",
  "one-name-per-account": "that GitHub account already holds another frizz.sh name; it frees up 30 days after it was last served",
  "one-name-per-key": "this machine already holds another custom name; it frees up 30 days after it was last served",
  expired: "this machine's clock is behind the registrar; fix the clock and try again",
  "from-the-future": "this machine's clock is ahead of the registrar; fix the clock and try again",
  "bad-version": "this version of Frizz is too old to claim a name — upgrade and try again",
}

export class ClaimError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = "ClaimError"
  }
}

export interface ClaimOptions {
  name: string
  port: number
  identity: CryptoKeyPair
  /** Frizz's own GitHub sign-in token, on a FIRST claim of a custom name only. */
  github?: string
  origin?: string
  now?: () => number
  fetchImpl?: typeof fetch
}

/** Claim a name, or renew one this identity already holds: the registrar decides which, from the key. */
export async function claimName(options: ClaimOptions): Promise<ClaimResult> {
  const origin = (options.origin ?? registrarOrigin()).replace(/\/$/, "")
  // A GitHub token goes only to a registrar reached over TLS; loopback is for tests.
  if (options.github && !carriesSecretsSafely(origin)) {
    throw new ClaimError(`refusing to send a GitHub sign-in to ${origin}, which is not https`, "insecure-registrar")
  }
  const request = await signClaim(
    {
      name: options.name,
      port: options.port,
      issuedAt: (options.now ?? Date.now)(),
      ...(options.github ? { github: options.github } : {}),
    },
    options.identity,
  )

  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(`${origin}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      // Never followed: a 307 or 308 would send the same body, GitHub token and all, wherever it pointed.
      redirect: "manual",
    })
  } catch (error) {
    // A registrar that is down must not read as "your name was rejected".
    throw new ClaimError(`could not reach the Frizz registrar at ${origin}: ${error instanceof Error ? error.message : error}`, "unreachable")
  }

  const body = (await response.json().catch(() => null)) as (Partial<ClaimResult> & { error?: string; message?: string }) | null
  if (!response.ok) {
    const code = typeof body?.error === "string" ? terminalSafe(body.error, 64) : `http-${response.status}`
    const said = typeof body?.message === "string" ? terminalSafe(body.message, 300) : ""
    throw new ClaimError(ADVICE[code] ?? (said || `the registrar refused the claim (${code})`), code)
  }

  const malformed = () =>
    new ClaimError(`the registrar at ${origin} answered something this version does not understand (protocol v${CLAIM_PROTOCOL_VERSION})`, "malformed-response")
  if (typeof body?.hostname !== "string") throw malformed()

  // THE ANSWER IS CHECKED, NOT TRUSTED (src/registrar-client.ts says what a forged one could do): from
  // Frizz's own registrar the hostname must be the name asked for in its zone, and a token is ignored.
  const name = normalizeClaimName(options.name)
  const official = origin === DEFAULT_REGISTRAR
  const hostname = body.hostname
  if (official ? hostname !== `${name}.${CLAIM_ZONE}` : !hostname.startsWith(`${name}.`) || !/^[a-z0-9.-]+$/.test(hostname)) throw malformed()

  return {
    hostname,
    ...(!official && typeof body.token === "string" && body.token ? { token: body.token } : {}),
    leaseExpiresAt: typeof body.leaseExpiresAt === "number" ? body.leaseExpiresAt : 0,
    renewed: body.renewed === true,
  }
}

/** Registrar text fit for a terminal: no control characters, and a sentence's length at most. */
function terminalSafe(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, limit)
}

// ── The claim ────────────────────────────────────────────────────────────────────────────────────────

export interface GithubAuthorization {
  /** Never logged, never stored here; it rides one claim and is dropped. */
  token: string
  login: string | null
}

/** The one question a claim asks of GitHub, behind a seam a test can stand in for. */
export interface GithubAuthorizer {
  authorize(): Promise<GithubAuthorization>
}

/** Frizz's own GitHub sign-in, read from disk at claim time — never the `gh` CLI's. */
export function frizzGithubSignIn(): GithubAuthorizer {
  return {
    authorize: async () => {
      try {
        return await githubClaimToken()
      } catch (error) {
        if (error instanceof GithubCredentialError) {
          throw new Error(`a custom frizz.sh subdomain is tied to your GitHub account through Frizz's GitHub sign-in. ${error.message}`)
        }
        throw error
      }
    },
  }
}

export interface ClaimFrizzNameOptions {
  /** The claim's progress lines ("claiming ada.frizz.sh for GitHub user Ada"), for the busy screen. */
  say?: (line: string) => void
  github?: GithubAuthorizer
  home?: string
  origin?: string
}

/**
 * Claim `answer` (empty mints a random name with no account), and the config that serves it. `fresh` is
 * true when the registrar created the name rather than renewing it, so the board signs out the devices
 * signed in under it before: someone else may have served it in between and collected their cookies.
 */
export async function claimFrizzName(
  answer: string,
  port: number,
  { say = () => {}, github = frizzGithubSignIn(), home = homedir(), origin }: ClaimFrizzNameOptions = {},
): Promise<{ config: CloudConfig; fresh: boolean }> {
  const anonymous = answer === "" || isAnonymousClaimName(answer)
  // Withdrawn custom names refuse before a keypair is minted and before GitHub or the registrar hears anything.
  if (!anonymous && !customNamesOffered()) throw new Error(CUSTOM_NAMES_PAUSED)
  // Surface the specific reason — reserved, too short, bad character — rather than a generic refusal.
  if (!anonymous && !claimNameIsValid(answer)) normalizeClaimName(answer)
  const identity = await loadOrCreateClaimIdentity(home)
  // A fresh random name is one of this key's own: the registrar takes no other.
  const name = answer === "" ? await pickAnonymousClaimName(await exportClaimPublicKey(identity.publicKey)) : normalizeClaimName(answer)
  const claimWith = (token?: string) => claimName({ name, port, identity, ...(token ? { github: token } : {}), ...(origin ? { origin } : {}) })
  let result: ClaimResult
  if (anonymous) {
    say("  claiming a frizz.sh subdomain — no account needed")
    result = await claimWith()
  } else {
    // The GitHub token goes only where the registrar asks for it: a name this key already holds renews
    // by the keypair alone, and a new one is answered `github-required` and only then gets one.
    try {
      result = await claimWith()
    } catch (error) {
      if (!(error instanceof ClaimError && error.code === "github-required")) throw error
      const authorization = await github.authorize()
      // The registrar takes only the account's own username, so a name that is not it never carries the token.
      if (authorization.login && authorization.login.toLowerCase() !== name) {
        throw new ClaimError(
          `a custom frizz.sh name is your own GitHub username, which is ${authorization.login} — claim ${authorization.login.toLowerCase()} instead`,
          "not-your-github-username",
        )
      }
      if (authorization.login) say(`  claiming ${name}.frizz.sh for GitHub user ${authorization.login}`)
      result = await claimWith(authorization.token)
    }
  }
  const fresh = !result.renewed
  if (result.token) {
    writeTunnelToken(result.token, home)
    return { config: { hostname: result.hostname, claim: name, serve: "tunnel" }, fresh }
  }
  // No run token means the registrar is in relay mode and the board serves itself over a socket.
  return { config: { hostname: result.hostname, claim: name, serve: "relay" }, fresh }
}
