import { execFile } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { findOnPath } from "./backend/acp-agents.ts"
import { frizzRoots } from "./frizz-paths.ts"
import { GithubCredentialSealError, openGithubCredential, resetGithubCredentialSeal, sealGithubCredential } from "./github-credential-seal.ts"

// FRIZZ'S OWN GITHUB CREDENTIAL — the one thing every server-side GitHub read authenticates with.
//
// Until 2026-11-04 the server borrowed the operator's `gh` sign-in: the PR and issue watchers and the
// hovercards ran `gh auth token`, and the picker ran `gh` itself. That token lives in the login
// keychain with `repo`, `workflow` and `delete_repo`, and any process can read it the same way. On this
// machine it is moving behind Keyward (`keyward -- gh …`, one Touch ID at a time, nothing while the
// screen is locked), which the watchers cannot use: they poll every minute, all night, locked.
//
// So the server has a credential of its own, and it is READ-ONLY by construction rather than by
// promise:
//   · "app"   — a user token from Frizz's GitHub App, signed in through GitHub's device flow. The
//               App's permissions are all read-only, and a user token can never exceed its App's
//               permissions, whatever the person who signed in can do. It lasts 8 hours; its refresh
//               token lasts 6 months and rolls on every refresh. A device-flow token refreshes with
//               the public client id alone, so Frizz renews it itself, unattended.
//   · "token" — a pasted fine-grained token (the stopgap). Nothing to refresh.
//   · FRIZZ_GITHUB_TOKEN in the server's environment overrides both — for tests, CI, and a self-hosted
//     server that injects its own. The FRIZZ_ prefix keeps it out of every worker's environment
//     (worker-env.ts), which a GITHUB_TOKEN would not.
//
// AT REST it is an encrypted 0600 file in Frizz's data root, whose key is random per machine and lives in
// the keychain (github-credential-seal.ts says what that does and does not stop). Keyward cannot release
// while the screen is locked and cannot take the 8-hourly rewrite. The rest of what protects this
// credential is what it cannot do: its one write is a commit comment, which GitHub allows with Contents.
// A worker's folder below is the exception: `gh` reads `hosts.yml` in the clear, so the 8-hour access
// token is plain there. The refresh token is never written outside the encrypted file.
//
// THERE IS NO FALLBACK TO `gh`'S OWN SIGN-IN, and that is the point. Signed out here means GitHub is
// signed out for the server. `runFrizzGh` gives every `gh` child this token in GH_TOKEN and an empty
// private GH_CONFIG_DIR, so a `gh` the server runs cannot find the operator's account even when no
// Frizz credential exists.

export type StoredGithubCredential =
  | {
    kind: "app"
    clientId: string
    accessToken: string
    /** Epoch ms. */
    accessExpiresAt: number
    refreshToken: string
    /** Epoch ms. */
    refreshExpiresAt: number
    login: string | null
    savedAt: number
  }
  | {
    kind: "token"
    token: string
    login: string | null
    savedAt: number
  }

export interface GithubCredentialStatus {
  signedIn: boolean
  /** Where the credential came from. Absent while signed out. */
  source?: "app" | "token" | "env"
  login: string | null
  /** Why a stored credential stopped working (a refresh GitHub refused). Absent while it works. */
  problem?: string
}

export class GithubCredentialError extends Error {
  readonly githubFailureKind = "gh-auth" as const
}

const GITHUB = "https://github.com"
const REQUEST_TIMEOUT_MS = 15_000
/** Refresh this long before the access token runs out, so no poll ever carries a dying token. */
const REFRESH_MARGIN_MS = 10 * 60_000

/** `<data>/github` — the credential file and gh's private, empty config dir. 0700. */
export function githubCredentialDir(): string {
  return join(frizzRoots().data, "github")
}

export function githubCredentialPath(): string {
  return join(githubCredentialDir(), "credential.enc")
}

/** The GH_CONFIG_DIR every server-run `gh` gets: Frizz's own, holding no account. */
export function frizzGhConfigDir(): string {
  return join(githubCredentialDir(), "gh-config")
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

/** Parse the stored file; anything malformed reads as signed out rather than throwing. */
export function parseStoredCredential(raw: unknown): StoredGithubCredential | null {
  const c = raw as Record<string, unknown> | null
  if (!c || typeof c !== "object") return null
  const login = isString(c.login) ? c.login : null
  const savedAt = typeof c.savedAt === "number" ? c.savedAt : 0
  if (c.kind === "token" && isString(c.token)) return { kind: "token", token: c.token, login, savedAt }
  if (
    c.kind === "app" && isString(c.clientId) && isString(c.accessToken) && isString(c.refreshToken)
    && typeof c.accessExpiresAt === "number" && typeof c.refreshExpiresAt === "number"
  ) {
    return {
      kind: "app",
      clientId: c.clientId,
      accessToken: c.accessToken,
      accessExpiresAt: c.accessExpiresAt,
      refreshToken: c.refreshToken,
      refreshExpiresAt: c.refreshExpiresAt,
      login,
      savedAt,
    }
  }
  return null
}

/** What the file holds, or why it can't be read. No file at all is plainly signed out, and runs nothing. */
function readStored(): { credential: StoredGithubCredential | null; problem: string | undefined } {
  let text: string
  try {
    text = readFileSync(githubCredentialPath(), "utf8")
  } catch {
    return { credential: null, problem: undefined }
  }
  try {
    return { credential: parseStoredCredential(JSON.parse(openGithubCredential(text))), problem: undefined }
  } catch (error) {
    return { credential: null, problem: error instanceof GithubCredentialSealError ? error.message : "The stored file is damaged." }
  }
}

export function readGithubCredential(): StoredGithubCredential | null {
  return readStored().credential
}

/** Atomic and private: written to a 0600 sibling, then renamed over the old file. */
export function writeGithubCredential(credential: StoredGithubCredential): void {
  ensureDir(githubCredentialDir())
  const path = githubCredentialPath()
  const tmp = `${path}.${process.pid}.tmp`
  // Sealed before anything touches the disk, so a key that can't be saved leaves the old file alone.
  writeFileSync(tmp, sealGithubCredential(JSON.stringify(credential)), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  memo = { credential, problem: undefined }
  syncWorkerGhConfig()
}

export function clearGithubCredential(): void {
  rmSync(githubCredentialPath(), { force: true })
  memo = { credential: null, problem: undefined }
  syncWorkerGhConfig()
}

// The credential as this process last read or wrote it, plus why it stopped working, if it did.
let memo: { credential: StoredGithubCredential | null; problem: string | undefined } | undefined
let refreshing: Promise<string> | undefined

/** Test-only: forget the in-memory copy. */
export function resetGithubCredentialMemo(): void {
  memo = undefined
  refreshing = undefined
  resetGithubCredentialSeal()
}

function current(): { credential: StoredGithubCredential | null; problem: string | undefined } {
  // Holding nothing, look again: a sign-in another process wrote into this folder (a sandbox stack and
  // the real board share it) is picked up on the next read rather than at the next restart.
  if (!memo?.credential) memo = readStored()
  return memo
}

function envToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.FRIZZ_GITHUB_TOKEN?.trim()
  return v ? v : null
}

export function githubCredentialStatus(): GithubCredentialStatus {
  if (envToken()) return { signedIn: true, source: "env", login: null }
  const { credential, problem } = current()
  if (!credential) return { signedIn: false, login: null, ...(problem ? { problem } : {}) }
  if (problem) return { signedIn: false, source: credential.kind, login: credential.login, problem }
  if (credential.kind === "app" && credential.refreshExpiresAt <= Date.now()) {
    return { signedIn: false, source: "app", login: credential.login, problem: "The GitHub sign-in expired after six months unused." }
  }
  return { signedIn: true, source: credential.kind, login: credential.login }
}

/** Cheap and local: does the server hold a credential it believes works? No network. */
export function githubSignedIn(): boolean {
  return githubCredentialStatus().signedIn
}

interface TokenDeps {
  request?: typeof globalThis.fetch
  now?: () => number
}

/** The token every server-side GitHub read sends. Refreshes an App token that is close to expiry,
 *  once, however many callers ask at the same moment. Throws GithubCredentialError when signed out. */
export async function frizzGithubToken(deps: TokenDeps = {}): Promise<string> {
  const fromEnv = envToken()
  if (fromEnv) return fromEnv
  const now = deps.now ?? Date.now
  const { credential, problem } = current()
  if (!credential) {
    throw new GithubCredentialError(problem
      ? `Frizz's GitHub sign-in can't be read: ${problem} Sign in again from Frizz's Settings.`
      : "Frizz is not signed in to GitHub. Sign in from Frizz's Settings.")
  }
  if (problem) throw new GithubCredentialError(`Frizz's GitHub sign-in stopped working: ${problem} Sign in again from Frizz's Settings.`)
  if (credential.kind === "token") return credential.token
  if (credential.accessExpiresAt - REFRESH_MARGIN_MS > now()) return credential.accessToken
  return await (refreshing ??= refreshAppToken(credential, deps).finally(() => { refreshing = undefined }))
}

/** Another process sharing this folder (a sandbox stack links it in) may have renewed first. A fresher
 *  App credential on disk than the one held in memory is adopted rather than refreshed again. */
function adoptNewerFromDisk(held: Extract<StoredGithubCredential, { kind: "app" }>, now: number): StoredGithubCredential | null {
  const onDisk = readGithubCredential()
  if (!onDisk || onDisk.kind !== "app" || onDisk.refreshToken === held.refreshToken) return null
  if (onDisk.accessExpiresAt - REFRESH_MARGIN_MS <= now) return null
  memo = { credential: onDisk, problem: undefined }
  return onDisk
}

/** A read came back 401 with this token: GitHub revoked it before its expiry. The next call refreshes
 *  (an App token) or reports the sign-in broken (a pasted token, which nothing can renew). */
export function rejectFrizzGithubToken(token: string): void {
  const { credential } = current()
  if (!credential) return
  if (credential.kind === "app" && credential.accessToken === token) {
    memo = { credential: { ...credential, accessExpiresAt: 0 }, problem: undefined }
  } else if (credential.kind === "token" && credential.token === token) {
    memo = { credential, problem: "GitHub refused the stored token (revoked or expired)." }
  }
}

interface OAuthTokenResponse {
  access_token?: unknown
  expires_in?: unknown
  refresh_token?: unknown
  refresh_token_expires_in?: unknown
  error?: unknown
  error_description?: unknown
  interval?: unknown
}

async function postForm(path: string, form: Record<string, string>, deps: TokenDeps): Promise<OAuthTokenResponse> {
  const request = deps.request ?? globalThis.fetch
  const response = await request(`${GITHUB}${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  let body: OAuthTokenResponse
  try {
    body = JSON.parse(text) as OAuthTokenResponse
  } catch {
    throw new Error(`GitHub answered ${path} with HTTP ${response.status} and no JSON`)
  }
  if (!response.ok && !body.error) throw new Error(`GitHub answered ${path} with HTTP ${response.status}`)
  return body
}

/** A token response → the stored App credential. Null when GitHub did not hand back a usable pair. */
export function appCredentialFrom(body: OAuthTokenResponse, clientId: string, login: string | null, now: number): StoredGithubCredential | null {
  if (!isString(body.access_token)) return null
  // An App with expiring tokens turned OFF answers with no refresh token and no expiry. Stored as a
  // plain token: it is still read-only, and there is nothing to renew.
  if (!isString(body.refresh_token)) return { kind: "token", token: body.access_token, login, savedAt: now }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 8 * 3600
  const refreshIn = typeof body.refresh_token_expires_in === "number" ? body.refresh_token_expires_in : 182 * 86400
  return {
    kind: "app",
    clientId,
    accessToken: body.access_token,
    accessExpiresAt: now + expiresIn * 1000,
    refreshToken: body.refresh_token,
    refreshExpiresAt: now + refreshIn * 1000,
    login,
    savedAt: now,
  }
}

async function refreshAppToken(credential: Extract<StoredGithubCredential, { kind: "app" }>, deps: TokenDeps): Promise<string> {
  const now = deps.now ?? Date.now
  const adopted = adoptNewerFromDisk(credential, now())
  if (adopted?.kind === "app") return adopted.accessToken
  let body: OAuthTokenResponse
  try {
    // No client_secret: GitHub does not require one to refresh a token the device flow issued.
    body = await postForm("/login/oauth/access_token", {
      client_id: credential.clientId,
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
    }, deps)
  } catch (error) {
    // Network trouble is not a broken sign-in: keep the credential and let the next poll try again.
    throw new GithubCredentialError(`Could not refresh Frizz's GitHub token: ${error instanceof Error ? error.message : String(error)}`)
  }
  const next = appCredentialFrom(body, credential.clientId, credential.login, now())
  if (!next) {
    // Spent by the other process sharing this folder in the moment between our read and our refresh?
    const raced = adoptNewerFromDisk(credential, now())
    if (raced?.kind === "app") return raced.accessToken
    // GitHub refused the refresh token itself — revoked, expired, or already spent by someone else.
    // That is the one sign of a copied refresh token, so it is surfaced, never retried in a loop.
    const reason = isString(body.error_description) ? body.error_description : isString(body.error) ? body.error : "no token in the response"
    memo = { credential, problem: `GitHub refused to renew it (${reason}).` }
    throw new GithubCredentialError(`Frizz's GitHub sign-in could not be renewed: ${reason}. Sign in again from Frizz's Settings.`)
  }
  writeGithubCredential(next)
  return next.kind === "app" ? next.accessToken : next.token
}

// ── Device-flow sign-in ─────────────────────────────────────────────────────────────────────────

/**
 * The client id of Frizz's GitHub App, "Frizz Agent Console" (github.com/apps/frizz-agent-console,
 * owned by colinhacks, registered 2026-11-04) — public by design: device flow has no secret. Its
 * permissions, all read-only: actions, checks, issues, metadata, pull_requests, statuses; no contents,
 * no webhook. `FRIZZ_GITHUB_APP_CLIENT_ID` overrides it (a test, a self-hosted fork). This is NOT
 * the OAuth App in src/github-device-flow.ts: that one proves who claims a frizz.sh name and must
 * carry no permissions at all, and the registrar refuses a GitHub App token outright.
 */
export const GITHUB_APP_CLIENT_ID_PLACEHOLDER = "frizz-github-app-client-id-not-set"
export const FRIZZ_GITHUB_APP_CLIENT_ID: string = "Iv23licDruV3JtQIF3fI"

export function githubAppClientId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env.FRIZZ_GITHUB_APP_CLIENT_ID?.trim() || FRIZZ_GITHUB_APP_CLIENT_ID
  return id === GITHUB_APP_CLIENT_ID_PLACEHOLDER ? null : id
}

export interface GithubDeviceSignIn {
  userCode: string
  verificationUri: string
  /** Epoch ms after which the code is dead. */
  expiresAt: number
}

type SignInState =
  | { phase: "idle" }
  | { phase: "pending"; prompt: GithubDeviceSignIn }
  | { phase: "failed"; message: string }

let signIn: SignInState = { phase: "idle" }
let signInGeneration = 0

export function githubSignInState(): SignInState {
  if (signIn.phase === "pending" && signIn.prompt.expiresAt <= Date.now()) signIn = { phase: "failed", message: "The code expired before it was entered." }
  return signIn
}

/** Ask GitHub for a device code, then poll for the token in the background. A second start replaces
 *  the first. Resolves with the code to show; the sign-in itself lands through githubSignInState(). */
export async function startGithubSignIn(deps: TokenDeps & { clientId?: string; sleep?: (ms: number) => Promise<void> } = {}): Promise<GithubDeviceSignIn> {
  const clientId = deps.clientId ?? githubAppClientId()
  if (!clientId) throw new Error("Frizz's GitHub App is not registered yet, so there is nothing to sign in to.")
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const body = await postForm("/login/device/code", { client_id: clientId }, deps) as Record<string, unknown>
  if (!isString(body.device_code) || !isString(body.user_code) || !isString(body.verification_uri)) {
    throw new Error(`GitHub did not issue a device code${isString(body.error_description) ? `: ${body.error_description}` : ""}`)
  }
  const prompt: GithubDeviceSignIn = {
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresAt: now() + (typeof body.expires_in === "number" ? body.expires_in : 900) * 1000,
  }
  const generation = ++signInGeneration
  signIn = { phase: "pending", prompt }
  let interval = (typeof body.interval === "number" ? body.interval : 5) * 1000
  const deviceCode = body.device_code
  void (async () => {
    while (generation === signInGeneration && now() < prompt.expiresAt) {
      await sleep(interval)
      if (generation !== signInGeneration) return
      let res: OAuthTokenResponse
      try {
        res = await postForm("/login/oauth/access_token", {
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }, deps)
      } catch {
        continue // a network blip mid-poll: keep polling until the code expires
      }
      if (res.error === "authorization_pending") continue
      if (res.error === "slow_down") {
        interval = (typeof res.interval === "number" ? res.interval : interval / 1000 + 5) * 1000
        continue
      }
      if (generation !== signInGeneration) return
      const login = isString(res.access_token) ? await fetchLogin(res.access_token, deps) : null
      const credential = appCredentialFrom(res, clientId, login, now())
      if (!credential) {
        const reason = isString(res.error_description) ? res.error_description : isString(res.error) ? res.error : "no token in the response"
        signIn = { phase: "failed", message: reason }
        return
      }
      try {
        writeGithubCredential(credential)
      } catch (error) {
        signIn = { phase: "failed", message: error instanceof Error ? error.message : String(error) }
        return
      }
      signIn = { phase: "idle" }
      return
    }
    if (generation === signInGeneration && signIn.phase === "pending") signIn = { phase: "failed", message: "The code expired before it was entered." }
  })()
  return prompt
}

export function cancelGithubSignIn(): void {
  signInGeneration++
  signIn = { phase: "idle" }
}

/** Store a pasted token (the stopgap), after checking GitHub accepts it. Returns the account login. */
export async function saveGithubToken(token: string, deps: TokenDeps = {}): Promise<string | null> {
  const trimmed = token.trim()
  if (!trimmed) throw new Error("The token is empty.")
  const login = await fetchLogin(trimmed, deps)
  if (login === null) throw new Error("GitHub did not accept that token.")
  writeGithubCredential({ kind: "token", token: trimmed, login, savedAt: (deps.now ?? Date.now)() })
  return login
}

async function fetchLogin(token: string, deps: TokenDeps): Promise<string | null> {
  try {
    const response = await (deps.request ?? globalThis.fetch)("https://api.github.com/user", {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "frizz" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body = await response.json() as { login?: unknown }
    return isString(body.login) ? body.login : null
  } catch {
    return null
  }
}

// ── `gh`, in a worker's shell ──────────────────────────────────────────────────────────────────
//
// Colin's decision of 2026-11-04: a worker's GitHub READS use this same read-only credential, with no
// Touch ID and through a locked screen, and anything that WRITES goes through Keyward
// (`keyward --reason "…" -- gh …`). Nothing wraps `gh` to do that. The worker's GH_CONFIG_DIR names a
// folder Frizz owns, whose hosts.yml holds the token, so plain `gh` simply reads and a write simply
// fails with GitHub's own permission error. Keyward sets GH_TOKEN for its run, and gh prefers that to
// hosts.yml, so the write goes out on the operator's token.
//
// A FILE, NOT GH_TOKEN. gh reads it on every run, so a worker outliving an 8-hour token gets the fresh
// one when the server renews it. And the token stays out of every child's environment, where one
// `env` in a transcript would print it.
//
// ONLY WHERE KEYWARD IS INSTALLED. Elsewhere a worker's `gh` is its operator's own sign-in, which may
// well be able to write, and there would be no path left for a write at all. So a machine without
// Keyward keeps exactly the environment it had.

/** A worker's GH_CONFIG_DIR: Frizz-owned, holding hosts.yml with the read-only token. */
export function frizzWorkerGhConfigDir(): string {
  return join(githubCredentialDir(), "worker-gh")
}

/** Beside hosts.yml: how the session-seed hook and the repo scripts tell that this `gh` cannot write.
 *  A file rather than a variable, because Codex's environment drops every FRIZZ_ name. */
export const WORKER_GH_READ_ONLY_MARKER = "frizz-read-only"

/** The hosts.yml for one token. JSON strings are valid YAML, so nothing here needs escaping. */
export function workerHostsYaml(token: string, login: string | null): string {
  return `github.com:\n    oauth_token: ${JSON.stringify(token)}\n    git_protocol: ssh\n${login ? `    user: ${JSON.stringify(login)}\n` : ""}`
}

function workerGhToken(): { token: string; login: string | null } | null {
  const fromEnv = envToken()
  if (fromEnv) return { token: fromEnv, login: null }
  const { credential, problem } = current()
  if (!credential || problem) return null
  return { token: credential.kind === "app" ? credential.accessToken : credential.token, login: credential.login }
}

/** Make the worker folder match the credential: written atomically, so a `gh` starting at this moment
 *  reads a whole file, and removed while signed out. Best-effort, because a failure here must not fail
 *  the sign-in or the renewal that called it; the keeper's next tick writes it again. */
export function syncWorkerGhConfig(): void {
  const dir = frizzWorkerGhConfigDir()
  const hosts = join(dir, "hosts.yml")
  try {
    const held = workerGhToken()
    if (!held) {
      rmSync(hosts, { force: true })
      return
    }
    ensureDir(dir)
    writeFileSync(join(dir, WORKER_GH_READ_ONLY_MARKER), "", { mode: 0o600 })
    const next = workerHostsYaml(held.token, held.login)
    let existing: string | null = null
    try {
      existing = readFileSync(hosts, "utf8")
    } catch {
      // Not written yet.
    }
    if (existing === next) return
    const tmp = `${hosts}.${process.pid}.tmp`
    writeFileSync(tmp, next, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, hosts)
  } catch {
    // See above.
  }
}

/** What a worker's environment adds so its `gh` reads with Frizz's credential. Empty unless Frizz is
 *  signed in and this machine has a Keyward to send writes through. Read when a worker's process
 *  starts, so one started before the sign-in keeps its own `gh` until it next resumes. */
export function frizzGithubWorkerEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!githubSignedIn() || !findOnPath("keyward", env)) return {}
  syncWorkerGhConfig()
  return { GH_CONFIG_DIR: frizzWorkerGhConfigDir() }
}

const KEEPER_TICK_MS = 60_000
let keeper: NodeJS.Timeout | undefined

/** Renew the App token ahead of its expiry whether or not anything on the server is reading GitHub,
 *  because a worker's `gh` reads the file and never asks. Once per process, and idle while signed out.
 *  A failed renewal is already recorded by frizzGithubToken; nothing here adds to it. */
export function startGithubCredentialKeeper(deps: TokenDeps = {}): () => void {
  const tick = () => {
    if (githubSignedIn()) void frizzGithubToken(deps).catch(() => {})
    syncWorkerGhConfig()
  }
  if (!keeper) {
    tick()
    keeper = setInterval(tick, KEEPER_TICK_MS)
    keeper.unref?.()
  }
  return () => {
    if (keeper) clearInterval(keeper)
    keeper = undefined
  }
}

// ── `gh`, run as Frizz ─────────────────────────────────────────────────────────────────────────

const pexec = promisify(execFile)

/** The environment for a `gh` the server runs: Frizz's token (or none), an empty private config dir,
 *  no prompts, no pager. Without a Frizz credential `gh` is simply signed out — it cannot find the
 *  operator's account, because GH_CONFIG_DIR names no user and GH_TOKEN wins over the keychain. */
export function frizzGhEnv(token: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"]) delete env[key]
  if (token) env.GH_TOKEN = token
  env.GH_CONFIG_DIR = frizzGhConfigDir()
  env.GH_PROMPT_DISABLED = "1"
  env.GH_PAGER = "cat"
  env.GH_NO_UPDATE_NOTIFIER = "1"
  return env
}

/** Run `gh` with Frizz's credential, never the operator's. An args array, no shell. Signed out, it
 *  still runs (signed out), so callers see gh's own "not logged in" error rather than a different one. */
export async function runFrizzGh(
  args: string[],
  opts: { cwd?: string; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  let token: string | null = null
  try {
    token = await frizzGithubToken()
  } catch {
    token = null
  }
  ensureDir(frizzGhConfigDir())
  return await pexec("gh", args, { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: opts.maxBuffer, env: frizzGhEnv(token) })
}
