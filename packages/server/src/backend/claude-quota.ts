import { join } from "node:path"
import { frizzRoots } from "../frizz-paths.ts"
import { homedir, platform } from "node:os"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ProviderQuota, QuotaWindow } from "@frizz/shared"
import { resolveClaudeExecutableAbsolute } from "./claude-broker-host.ts"
import { readObservedClaudeQuota, type ObservedClaudeQuota, type ObservedWindow } from "./claude-quota-observed.ts"
import { log as frizzLog } from "../logging.ts"

const execFileAsync = promisify(execFile)

// Subscription quota is read from the OAuth usage endpoint — the same call Claude Code's own /usage
// command makes — authorized by the credential already on this machine (the on-disk
// ~/.claude/.credentials.json, or the macOS login Keychain). That is one ~200ms HTTPS GET, immune to
// local CPU load.
//
// It is not the only source. Claude Code can be signed in by routes that leave no token in either
// place: a token in its environment, or a proxy in front of the API that adds the sign-in to every
// request (a "token broker"). With no token to read, the request goes the way Claude Code was told to
// send its own — see ConfiguredRoute. And the endpoint refuses and rate-limits like any other, so what
// the account's own sessions report on every turn is laid over whatever this returns — see
// readClaudeQuota at the bottom, and claude-quota-observed.ts for where those reports come from.
//
// `claude -p /usage` IS A WHOLE CLAUDE CODE PROCESS, AND IT STARTS FOR EXACTLY ONE REASON: a
// credential exists and the endpoint rejected it (401/403). Claude Code owns OAuth refresh and
// rotation, so it is the only thing that can turn an expired token back into a working one. Every
// other failure — no credential at all, the network down, a timeout, a 5xx, a malformed body — fails
// the refresh and starts nothing, because the CLI makes this same request with this same credential
// and fails the same way. Until 2026-10-11 all of those fell through to the CLI and nothing
// remembered that it had failed, so a machine that was not signed in to Claude started a Claude Code
// process on every refresh attempt, for as long as Frizz ran (maintainer: "That's fucking nuts. We
// can't do that."). Measured that day: a real signed-out server with an empty board started one every
// 30s off the heartbeat alone, and with a chip polling every 15s beside it the same reader started
// 362 in a simulated hour — six a minute. Offline and a dead credential cost the same. The one start
// that remains is bounded by a persisted backoff — see CLI_BACKOFF_BASE_MS.
//
// (Spawning Claude Code was once the PRIMARY path, and under heavy machine load — worker fleets
// pushing load-80+ — it reliably exceeded any sane exec timeout: every refresh died and the chip
// served the same stale reading for hours.)
//
//   GET https://api.anthropic.com/api/oauth/usage
//     Authorization: Bearer <oauth access token>
//     anthropic-beta: oauth-2025-04-20
//     User-Agent: claude-code/<version>      ← REQUIRED; without it the endpoint 429s aggressively
//   → { five_hour:{utilization 0..100, reset_at ISO}, seven_day:{…}, seven_day_opus, seven_day_sonnet }
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const OAUTH_BETA = "oauth-2025-04-20"
const USER_AGENT = "claude-code/2.0.0" // gates by product, not exact version
const ENDPOINT_TIMEOUT_MS = 5000
// A healthy reading is trusted for two minutes. The endpoint is one cheap ~200ms GET, and a proactive
// server-side heartbeat (refreshClaudeQuotaInBackground, wired in context.ts) already keeps this cache
// warm, so a lazy read reflects a value about as recent as the endpoint's rate limit allows (see
// RATE_LIMIT_DEFAULT_BACKOFF_MS — in practice ~5 minutes, not these 2).
//
// A FAILED refresh is not retried for FAIL_TTL_MS — BY ANYONE. The failure is stamped beside the reading
// (`failedAt`), and the heartbeat, a stale read's background kick and a lazy read all stand behind it.
// It used to bind the lazy read alone, and only through a reading it had itself written: the heartbeat
// never looked, and it is armed once per PROJECT (context.ts) for a credential that is the machine's. So
// a signed-out or offline machine paid one attempt — a Keychain lookup, or a request that times out —
// per open project every 30s, with the browser's poll on top. One window, one attempt, however many
// projects tick. 30s is the heartbeat's own cadence; signing in is noticed within it, and the popover's
// forced recheck does not wait for it at all.
const OK_TTL_MS = 2 * 60_000
const FAIL_TTL_MS = 30_000
const STALE_MAX_AGE_MS = 24 * 60 * 60_000
// The CLI fallback boots a full Claude Code process; under load-80 a cold boot alone can blow well
// past 12s, and a too-tight bound here is indistinguishable from a broken credential.
const CLI_TIMEOUT_MS = 30_000
// HOW OFTEN THAT PROCESS MAY START: once, then no sooner than 15m later, then 30m, 1h … doubling to
// one a day. The count is persisted beside the reading (`cli`), so it holds across every Frizz
// process on the machine and across a restart, it binds the heartbeat, a stale read and a forced
// recheck alike, and ONLY THE ENDPOINT ACCEPTING THE TOKEN resets it — a usage reading the CLI printed
// proves nothing about the token this reader holds. A refresh that worked buys hours of valid token,
// so the healthy case is one start per expiry. The doubling is for the credential Claude Code cannot
// repair (a revoked sign-in, a token without the usage scope), which would otherwise be retried at the
// base interval for ever.
const CLI_BACKOFF_BASE_MS = 15 * 60_000
const CLI_BACKOFF_MAX_MS = 24 * 60 * 60_000
// The lock must outlive the slowest refresh (the 30s CLI fallback), and followers must be willing to
// wait through most of that bound. Otherwise a merely slow first process would make every other Frizz
// window give up early.
const LOCK_STALE_MS = 40_000
const LOCK_WAIT_MS = 15_000
const LOCK_POLL_MS = 50
// THE ENDPOINT RATE-LIMITS PER ACCESS TOKEN, HARD: measured 2026-09-19, one success bought a 429 with
// `retry-after` counting down a fixed ~5-minute window, and every Claude Code session on the machine
// shares that token's budget (upstream: anthropics/claude-code#31637). A caller that ignores the header
// spends most of its requests on refusals — a 2-minute heartbeat landed one success in three, and every
// popover recheck inside the window failed, which is why "Could not refresh" was the popover's usual
// reading. So the refusal's deadline is PERSISTED beside the reading (`retryAt`) and nothing — heartbeat,
// stale-read kick, forced recheck — calls the endpoint before it. Upstream also reports 429s carrying
// `retry-after: 0` or no header at all; those get this default. The cap bounds an absurd header.
const RATE_LIMIT_DEFAULT_BACKOFF_MS = 5 * 60_000
const RATE_LIMIT_MAX_BACKOFF_MS = 60 * 60_000

function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override && override.trim() ? override : join(homedir(), ".claude")
}

// Pull the OAuth access token out of a Claude credentials blob. The shape has drifted across
// versions, so probe the known nests defensively; return undefined when absent.
export function tokenFromCredentialsJson(raw: string): string | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!doc || typeof doc !== "object") return undefined
  const root = doc as Record<string, unknown>
  const oauth = root.claudeAiOauth && typeof root.claudeAiOauth === "object" ? (root.claudeAiOauth as Record<string, unknown>) : root
  const token = oauth.accessToken ?? oauth.access_token
  return typeof token === "string" && token ? token : undefined
}

// Keychain path for a default macOS install (no .credentials.json on disk; `security -w` prints the
// same blob shape as the file). Defensive: darwin-only, short timeout, swallow any error → undefined.
// ASYNC on purpose: a Keychain ACL prompt can block until the timeout, and a synchronous exec would
// freeze the whole server event loop for that window.
async function readKeychainToken(): Promise<string | undefined> {
  if (platform() !== "darwin") return undefined
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      encoding: "utf8",
      timeout: 4000,
    })
    return tokenFromCredentialsJson(String(stdout).trim())
  } catch {
    return undefined
  }
}

// The OAuth access token, tried in the order Claude Code itself resolves it. Its store on macOS is the
// login Keychain with .credentials.json as a fallback it reads only when the Keychain yields nothing
// (`keychain-with-plaintext-fallback`, read in the 2.1.328 binary). A file can outlive the Keychain's
// copy: Claude Code does not delete it once the Keychain holds a token, and a credential rotator such
// as ccbroker writes both. Reading the file first would show the quota of an account no worker is
// using whenever the two disagree. Off macOS the Keychain reader returns undefined, leaving the file.
//
// With CLAUDE_CONFIG_DIR set, Claude Code names its Keychain item with a hash of that directory, which
// readKeychainToken does not reproduce, so that install keeps its own directory's file first.
export async function readAccessToken(
  configDir: string,
  readKeychain: () => Promise<string | undefined> = readKeychainToken,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const readFileToken = async () => {
    try {
      return tokenFromCredentialsJson(await readFile(join(configDir, ".credentials.json"), "utf8"))
    } catch {
      // Missing/unreadable file is expected on a Keychain-backed macOS install.
      return undefined
    }
  }
  if (env.CLAUDE_CONFIG_DIR?.trim()) return (await readFileToken()) ?? readKeychain()
  return (await readKeychain()) ?? readFileToken()
}

function isoToUnix(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? Math.round(ms / 1000) : undefined
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

// Map one legacy usage window from the endpoint (utilization 0..100, reset_at/resets_at ISO).
function toWindow(raw: unknown, key: string, label: string): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const w = raw as Record<string, unknown>
  const util = typeof w.utilization === "number" && Number.isFinite(w.utilization) ? w.utilization : undefined
  if (util === undefined) return undefined
  const resetsAt = isoToUnix(w.resets_at ?? w.reset_at)
  return { key, label, usedPercent: util, ...(resetsAt === undefined ? {} : { resetsAt }) }
}

// Map one modern `limits[]` entry: { kind, group, percent, resets_at, scope: { model: { display_name } } }.
// A scoped weekly ("weekly_scoped" with a model name — e.g. the Fable weekly cap on a Fable plan) keeps
// its model identity so the chip's tightest-window pick can name the cap that actually binds.
function windowFromLimit(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const l = raw as Record<string, unknown>
  const percent = typeof l.percent === "number" && Number.isFinite(l.percent) ? l.percent : undefined
  if (percent === undefined) return undefined
  const group = typeof l.group === "string" ? l.group : typeof l.kind === "string" ? l.kind : ""
  const scope = l.scope && typeof l.scope === "object" ? (l.scope as Record<string, unknown>) : undefined
  const model = scope?.model && typeof scope.model === "object" ? (scope.model as Record<string, unknown>) : undefined
  const scopeName = typeof model?.display_name === "string" && model.display_name ? model.display_name : undefined
  let key: string
  let label: string
  if (group === "session") {
    key = "5h"
    label = "5h"
  } else if (group === "weekly") {
    key = scopeName ? `weekly-${slugify(scopeName)}` : "weekly"
    label = scopeName ? `${scopeName} wk` : "Weekly"
  } else if (group) {
    // An unfamiliar future cap must not be invisible — it may be the one that binds.
    key = slugify(group)
    label = scopeName ? `${scopeName} ${group}` : group
  } else {
    return undefined
  }
  const resetsAt = isoToUnix(l.resets_at ?? l.reset_at)
  return { key, label, usedPercent: percent, ...(resetsAt === undefined ? {} : { resetsAt }) }
}

// Parse the endpoint's JSON body → a ProviderQuota. Total: never throws. Exported for a fixture test.
// The modern body carries the authoritative windows in `limits[]` (session + weekly entries, scoped
// weeklies naming their model); older bodies used top-level five_hour / seven_day / seven_day_<model>
// objects. Read `limits[]` first and fill any window the legacy keys still uniquely describe — the
// model-scoped weekly caps matter because they are frequently the BINDING limit, and omitting one
// would let the chip show a rosy general weekly % while the user is actually near that wall.
export function parseClaudeUsage(body: unknown, planType?: string): ProviderQuota {
  if (!body || typeof body !== "object") return { status: "unavailable", windows: [], detail: "Malformed usage response" }
  const b = body as Record<string, unknown>
  const windows: QuotaWindow[] = []
  const seen = new Set<string>()
  const add = (w: QuotaWindow | undefined) => {
    if (w && !seen.has(w.key)) {
      seen.add(w.key)
      windows.push(w)
    }
  }
  if (Array.isArray(b.limits)) for (const entry of b.limits) add(windowFromLimit(entry))
  add(toWindow(b.five_hour, "5h", "5h"))
  add(toWindow(b.seven_day, "weekly", "Weekly"))
  add(toWindow(b.seven_day_opus, "weekly-opus", "Opus wk"))
  add(toWindow(b.seven_day_sonnet, "weekly-sonnet", "Sonnet wk"))
  if (windows.length === 0) return { status: "unavailable", windows: [], detail: "No usage windows reported" }
  return { status: "ok", planType, windows }
}

type UsageExec = (claudeBin: string) => Promise<string>

/** The endpoint refused with 429/529. `retryAt` (ms) is when it said another request may succeed. */
class UsageRateLimited extends Error {
  constructor(status: number, readonly retryAt: number) {
    super(`Usage endpoint ${status}`)
  }
}

function retryAtFrom(res: Response, now: number): number {
  const seconds = Number(res.headers.get("retry-after"))
  const backoff = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : RATE_LIMIT_DEFAULT_BACKOFF_MS
  return now + Math.min(backoff, RATE_LIMIT_MAX_BACKOFF_MS)
}

/** Claude Code's starts since the endpoint last accepted the token, and the instant (ms) before which
 *  nothing starts it again. See CLI_BACKOFF_BASE_MS. */
interface CliRuns {
  runs: number
  retryAt: number
}

// With no cache directory there is nowhere to record that Claude Code ran, so nothing could bound it.
const CLI_NEVER: CliRuns = { runs: 0, retryAt: Infinity }

/** Claude Code was started to refresh a rejected credential and reported no quota. `cli` is the
 *  record of that start, which the caller must persist whatever else it does with the failure. */
class ClaudeCodeRefreshFailed extends Error {
  constructor(readonly cli: CliRuns, cause: unknown) {
    super("Claude Code could not refresh the rejected credential", { cause })
  }
}

export interface ClaudeQuotaDeps {
  now?: () => number
  execUsage?: UsageExec
  cacheDir?: string
  fetchImpl?: typeof fetch
  readToken?: (configDir: string) => Promise<string | undefined>
  /** The configured route (resolveConfiguredRoute). Defaults to the real one — unless `readToken` is
   *  injected, which stands for the whole credential lookup, so a test that scripts the token is never
   *  reached by the machine's own environment. */
  readRoute?: (configDir: string) => Promise<ConfiguredRoute | undefined>
}

// ---- The configured route: the address and credential Claude Code was TOLD to use ----
//
// Claude Code can be signed in with no token in the credentials file or the Keychain, by its
// environment: a token in CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`'s), or a PROXY in front of the
// API — ANTHROPIC_BASE_URL — that holds the real sign-in itself and adds it to every request passing
// through, while Claude Code holds only a placeholder (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, or the
// OAuth variable). That is what a "token broker" usually is. The pair lives in the environment Frizz
// was started with, or in the `env` block of Claude Code's user settings, which is where a proxy's
// installer writes it and which wins when both name one (measured 2026-10-11: a real `claude -p` with a
// different proxy in each called the settings' one). The workers inherit both, so this IS their route.
//
// The usage request goes exactly where Claude Code's own requests go, carrying exactly the credential
// Claude Code would send, in the same header. Through a proxy it is decorated like any other request:
// Frizz never holds the real token and sends nothing anywhere Claude Code does not.
//
// It is the ONLY reading a proxied machine can have when the placeholder is ANTHROPIC_AUTH_TOKEN:
// measured the same day through a stand-in proxy, Anthropic's rate-limit headers came back to Claude
// Code on every response, and Claude Code emitted no rate_limit_event for them, so the sessions' report
// (claude-quota-observed.ts) stays empty there. With the OAuth variable as the placeholder it did.
//
// Not covered, deliberately: an `apiKeyHelper` (it is a program, and a poll does not start programs —
// that is the storm 2cf00464 removed), and a cloud provider (Bedrock, Vertex, Foundry), which has no
// plan windows to read.
export interface ConfiguredRoute {
  url: string
  headers: Record<string, string>
  /** Changes whenever the address or the credential does; resets the route's backoff. Never the secret. */
  fingerprint: string
}

const ROUTE_VARS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const
const CLOUD_PROVIDER_VARS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] as const

async function readSettingsEnv(configDir: string): Promise<Record<string, string>> {
  try {
    const doc = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8")) as { env?: unknown }
    if (!doc?.env || typeof doc.env !== "object") return {}
    return Object.fromEntries(Object.entries(doc.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
  } catch {
    return {}
  }
}

export async function resolveConfiguredRoute(configDir: string, env: NodeJS.ProcessEnv = process.env): Promise<ConfiguredRoute | undefined> {
  const settings = await readSettingsEnv(configDir)
  const pick = (name: string): string | undefined => (settings[name] ?? env[name])?.trim() || undefined
  if (CLOUD_PROVIDER_VARS.some((name) => { const v = pick(name); return v !== undefined && v !== "0" && v.toLowerCase() !== "false" })) return undefined
  let base = new URL(USAGE_URL).origin
  const configuredBase = pick("ANTHROPIC_BASE_URL")
  if (configuredBase) {
    let parsed: URL
    try {
      parsed = new URL(configuredBase)
    } catch {
      return undefined
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined
    // Claude Code appends its API paths to the base, so a base that carries a path prefix keeps it.
    base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`
  }
  const viaProxy = new URL(base).host !== new URL(USAGE_URL).host
  // Claude Code's own order (its authentication docs): the gateway bearer, then an API key, then the
  // OAuth token.
  const bearer = pick("ANTHROPIC_AUTH_TOKEN")
  const apiKey = pick("ANTHROPIC_API_KEY")
  const oauth = pick("CLAUDE_CODE_OAUTH_TOKEN")
  let credential: Record<string, string>
  if (bearer) credential = { Authorization: `Bearer ${bearer}` }
  // A Console key sent to Anthropic itself has no plan behind it; to a proxy it is just a placeholder.
  else if (apiKey) {
    if (!viaProxy) return undefined
    credential = { "x-api-key": apiKey }
  } else if (oauth) credential = { Authorization: `Bearer ${oauth}` }
  else return undefined
  const url = `${base}${new URL(USAGE_URL).pathname}`
  return {
    url,
    headers: credential,
    fingerprint: createHash("sha256").update(JSON.stringify([url, credential])).digest("hex").slice(0, 16),
  }
}

// A route that failed is asked again no sooner than this, doubling, and never more often than the
// endpoint itself would allow. A proxy that does not forward the usage path answers the same way every
// time, and it is somebody's server — so a refusal costs one request per window, not one per poll.
const ROUTE_BACKOFF_BASE_MS = 5 * 60_000
const ROUTE_BACKOFF_MAX_MS = 6 * 60 * 60_000

/** The configured route's failures in a row, and the instant (ms) before which it is not asked again. */
interface RouteRuns {
  fingerprint: string
  failures: number
  retryAt: number
}

/** The configured route failed; `configured` is the backoff the caller must persist. */
class ConfiguredRouteFailed extends Error {
  constructor(readonly configured: RouteRuns, message: string) {
    super(message)
  }
}

interface SharedQuota {
  at: number
  quota: ProviderQuota
  /** Set by a 429: no caller touches the endpoint before this instant (ms). A success clears it. */
  retryAt?: number
  /** Set by every start of Claude Code. Carried through every failure; an endpoint success clears it. */
  cli?: CliRuns
  /** Set by a refresh that failed for any other reason (ms). No unforced caller retries inside
   *  FAIL_TTL_MS of it; a success clears it. */
  failedAt?: number
  /** Set by every failure of the configured route (ROUTE_BACKOFF_BASE_MS). A success clears it. */
  configured?: RouteRuns
}

function cachePaths(cacheDir: string, configDir: string) {
  const profile = createHash("sha256").update(configDir).digest("hex").slice(0, 12)
  return {
    data: join(cacheDir, `claude-${profile}.json`),
    lock: join(cacheDir, `claude-${profile}.lock`),
  }
}

async function readShared(path: string): Promise<SharedQuota | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SharedQuota
    if (!Number.isFinite(parsed.at) || !parsed.quota || !Array.isArray(parsed.quota.windows)) return undefined
    // A malformed record must read as "never ran", not as NaN arithmetic that no deadline ever beats.
    if (!Number.isFinite(parsed.cli?.runs) || !Number.isFinite(parsed.cli?.retryAt)) delete parsed.cli
    if (typeof parsed.configured?.fingerprint !== "string" || !Number.isFinite(parsed.configured?.failures) || !Number.isFinite(parsed.configured?.retryAt)) delete parsed.configured
    return parsed
  } catch {
    return undefined
  }
}

async function writeShared(path: string, value: SharedQuota): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await mkdir(path)
      return () => rm(path, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      try {
        if (Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MS) {
          await rm(path, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() >= deadline) throw new Error("Claude quota refresh lock timed out")
      await delay(LOCK_POLL_MS)
    }
  }
}

async function runClaudeUsage(claudeBin: string): Promise<string> {
  const { stdout } = await execFileAsync(
    // Never a bare name: on Windows `execFile("claude")` is ENOENT and `execFile("claude.cmd")` is
    // EINVAL (node refuses .cmd/.bat without a shell since CVE-2024-27980), so this reader could
    // never reach the CLI there and every quota refresh threw. See auth-status.ts for the measurement.
    // A resolver throw is a refresh failure like any other — the callers' stale-serving catch owns it.
    resolveClaudeExecutableAbsolute(claudeBin),
    ["-p", "/usage", "--safe-mode", "--output-format", "json", "--no-session-persistence", "--tools", ""],
    { encoding: "utf8", timeout: CLI_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
  )
  return String(stdout)
}

// One live refresh: the endpoint, and Claude Code only for a credential the endpoint rejected. Returns
// ONLY a healthy quota; every failure shape throws so the callers' stale-serving catch handles them
// uniformly. `standing` is the persisted record read under the refresh lock: `cli`, Claude Code's last
// start (a result or a ClaudeCodeRefreshFailed that carries one means it was started again), and
// `configured`, the configured route's backoff. The caller persists whatever comes back.
async function refreshQuota(
  claudeBin: string,
  deps: ClaudeQuotaDeps,
  now: number,
  standing: Pick<SharedQuota, "cli" | "configured"> | undefined,
): Promise<{ quota: ProviderQuota; cli?: CliRuns }> {
  const cli = standing?.cli
  const doFetch = deps.fetchImpl ?? fetch
  const readToken = deps.readToken ?? readAccessToken
  const configDir = claudeConfigDir()
  let token: string | undefined
  try {
    token = await readToken(configDir)
  } catch {
    token = undefined
  }
  // No token in the credentials file or the Keychain. That is not the same as signed out: Claude Code
  // may have been told where to send its requests and with what (see ConfiguredRoute), and then the
  // usage request goes the same way. Starting Claude Code to ask is still never the answer — it was the
  // 5-a-minute process storm — and the sessions' own reports are laid over whatever this returns.
  if (!token) {
    const readRoute = deps.readRoute ?? (deps.readToken ? async () => undefined : (dir: string) => resolveConfiguredRoute(dir))
    let route: ConfiguredRoute | undefined
    try {
      route = await readRoute(configDir)
    } catch {
      route = undefined
    }
    if (!route) throw new Error("Not signed in to Claude")
    return { quota: await refreshThroughRoute(route, doFetch, now, standing?.configured) }
  }
  let res: Response
  try {
    res = await doFetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
    })
  } catch {
    throw new Error("Usage endpoint unreachable")
  }
  if (res.ok) {
    const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined
    const quota = parseClaudeUsage(body, typeof body?.plan_type === "string" ? body.plan_type : undefined)
    if (quota.status !== "ok") throw new Error(quota.detail)
    return { quota }
  }
  // The endpoint asked us to back off: fail this refresh and let the cached reading ride.
  if (res.status === 429 || res.status === 529) throw new UsageRateLimited(res.status, retryAtFrom(res, now))
  if (res.status !== 401 && res.status !== 403) throw new Error(`Usage endpoint ${res.status}`)
  if (cli && now < cli.retryAt) throw new Error("Claude credential rejected")
  const runs = (cli?.runs ?? 0) + 1
  const started: CliRuns = { runs, retryAt: now + Math.min(CLI_BACKOFF_BASE_MS * 2 ** (runs - 1), CLI_BACKOFF_MAX_MS) }
  // The only place a quota read costs a process, and rare by construction — so it always says so.
  frizzLog.warn("quota", `the usage endpoint rejected the Claude credential (${res.status}); starting Claude Code to refresh it (start ${runs} since the endpoint last accepted one)`)
  try {
    const quota = parseClaudeUsageOutput(await (deps.execUsage ?? runClaudeUsage)(claudeBin), now)
    if (quota.status !== "ok") throw new Error(quota.detail)
    return { quota, cli: started }
  } catch (err) {
    throw new ClaudeCodeRefreshFailed(started, err)
  }
}

// The usage request along the configured route. A 429 is the endpoint's (or the proxy's) own deadline
// and binds every caller as usual; every other failure — the proxy down, a path it does not forward, a
// credential it refuses, a body that is not a usage reading — is the route's, and backs it off. Never
// Claude Code: it cannot repair a credential it was handed.
async function refreshThroughRoute(route: ConfiguredRoute, doFetch: typeof fetch, now: number, standing: RouteRuns | undefined): Promise<ProviderQuota> {
  const backoff = standing?.fingerprint === route.fingerprint ? standing : undefined
  if (backoff && now < backoff.retryAt) throw new Error("Usage unavailable through the configured API address")
  const fail = (message: string): never => {
    const failures = (backoff?.failures ?? 0) + 1
    throw new ConfiguredRouteFailed(
      { fingerprint: route.fingerprint, failures, retryAt: now + Math.min(ROUTE_BACKOFF_BASE_MS * 2 ** (failures - 1), ROUTE_BACKOFF_MAX_MS) },
      message,
    )
  }
  let res: Response
  try {
    res = await doFetch(route.url, {
      headers: { ...route.headers, "anthropic-beta": OAUTH_BETA, "User-Agent": USER_AGENT, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
      // A proxy that redirects is not one this request should follow anywhere with a credential on it.
      redirect: "manual",
    })
  } catch {
    return fail("Configured API address unreachable")
  }
  if (res.status === 429 || res.status === 529) throw new UsageRateLimited(res.status, retryAtFrom(res, now))
  if (!res.ok) return fail(`Configured API address answered ${res.status}`)
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined
  const quota = parseClaudeUsage(body, typeof body?.plan_type === "string" ? body.plan_type : undefined)
  if (quota.status !== "ok") return fail(quota.detail ?? "No usage windows reported")
  return quota
}

const LINE_WINDOWS: Array<[RegExp, string, string]> = [
  [/^Current session$/i, "5h", "5h"],
  [/^Current week \(all models\)$/i, "weekly", "Weekly"],
  [/^Current week \(Opus only\)$/i, "weekly-opus", "Opus wk"],
  [/^Current week \(Sonnet only\)$/i, "weekly-sonnet", "Sonnet wk"],
]

function windowIdentity(title: string): [string, string] | undefined {
  for (const [pattern, key, label] of LINE_WINDOWS) {
    if (pattern.test(title)) return [key, label]
  }
  const scoped = /^Current week \((.+)\)$/i.exec(title)
  if (!scoped) return undefined
  const name = scoped[1]!.replace(/\s+only$/i, "")
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return slug ? [`weekly-${slug}`, `${name} wk`] : undefined
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

function parseResetLabel(label: string | undefined, now: number): number | undefined {
  if (!label) return undefined
  // Claude Code and Frizz run on the same machine, so its explicit IANA suffix names the local timezone
  // already in effect here. Remove only that redundant suffix; never reinterpret it as UTC.
  const text = label.replace(/\s+\([^)]+\)\s*$/, "").trim()
  // The live label shapes: "3pm", "Jul 23 at 3pm", "Jul 27 at 12:59am", optionally with a year.
  // Date.parse cannot handle the "<Mon> <D> at <clock>" form (and resolves a year-less "<Mon> <D>" to
  // 2001), so assemble these from local-time parts directly.
  const parts = /^(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?)?\s*(?:at\s+)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm))?$/i.exec(text)
  const month = parts?.[1] ? MONTH_INDEX[parts[1].slice(0, 3).toLowerCase()] : undefined
  const hasClock = parts?.[6] !== undefined
  if (parts && (month !== undefined || hasClock) && (parts[1] === undefined || month !== undefined)) {
    const date = new Date(now)
    if (hasClock) {
      let hour = Number(parts[4]) % 12
      if (parts[6]!.toLowerCase() === "pm") hour += 12
      date.setHours(hour, Number(parts[5] ?? 0), 0, 0)
    } else {
      date.setHours(0, 0, 0, 0)
    }
    if (month !== undefined) {
      date.setMonth(month, Number(parts[2]))
      // A year-less date must resolve forward: a weekly reset labeled "Jan 2" in late December is next
      // year's Jan 2, not the one eleven+ months past.
      if (parts[3]) date.setFullYear(Number(parts[3]))
      else if (date.getTime() <= now) date.setFullYear(date.getFullYear() + 1)
    } else if (date.getTime() <= now) {
      date.setDate(date.getDate() + 1)
    }
    return Math.round(date.getTime() / 1000)
  }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) return undefined
  const date = new Date(parsed)
  if (!/\b\d{4}\b/.test(text) && date.getTime() <= now) date.setFullYear(date.getFullYear() + 1)
  return Math.round(date.getTime() / 1000)
}

// Claude Code intentionally formats this output as a small line-oriented contract for non-interactive
// callers. Preserve its percentages and turn its local reset labels back into the unix instants Frizz's
// display and subscription-limit scheduler already consume.
export function parseClaudeUsageOutput(stdout: string, now = Date.now()): ProviderQuota {
  let text = stdout
  try {
    const envelope = JSON.parse(stdout) as Record<string, unknown>
    if (typeof envelope.result === "string") text = envelope.result
  } catch {
    // Plain-text output is accepted too, which keeps this parser compatible with simple test doubles.
  }
  const windows: QuotaWindow[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(Current (?:session|week \(.+?\))):\s*(\d+(?:\.\d+)?)%\s+used\b(?:\s*·\s*resets\s+(.+?))?\s*$/i.exec(line)
    if (!match) continue
    const identity = windowIdentity(match[1]!)
    if (!identity) continue
    const resetsAt = parseResetLabel(match[3], now)
    windows.push({
      key: identity[0],
      label: identity[1],
      usedPercent: Number(match[2]),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    })
  }
  if (windows.length === 0) {
    return { status: "unavailable", windows: [], detail: "Claude Code did not report subscription quota" }
  }
  return { status: "ok", windows }
}

// One non-blocking lock attempt for a BACKGROUND refresh: if another process holds the lock, someone
// is already refreshing and this process's next poll will read their result — give up instantly
// instead of parking a waiter.
async function tryAcquireLock(path: string): Promise<(() => Promise<void>) | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(path)
      return () => rm(path, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined
      try {
        if (Date.now() - (await stat(path)).mtimeMs <= LOCK_STALE_MS) return undefined
        await rm(path, { recursive: true, force: true })
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

const UNAVAILABLE = { status: "unavailable", windows: [], detail: "Claude Code usage unavailable" } satisfies ProviderQuota

function rateLimited(shared: SharedQuota | undefined, now: number): shared is SharedQuota & { retryAt: number } {
  return shared?.retryAt !== undefined && now < shared.retryAt
}

// What a caller gets INSTEAD of a request while the endpoint's refusal stands. This is not a failure —
// the reading is as fresh as the provider allows — so it says when the next one is due rather than
// "Could not refresh". House duration grammar (`3m`), minutes floored at 1 so it never reads `0m`.
function serveRateLimited(shared: SharedQuota & { retryAt: number }, now: number): ProviderQuota {
  if (shared.quota.status !== "ok" || now - shared.at >= STALE_MAX_AGE_MS) return UNAVAILABLE
  const minutes = (ms: number, round: (n: number) => number) => Math.max(1, round(ms / 60_000))
  return {
    ...shared.quota,
    detail: `Next refresh in ${minutes(shared.retryAt - now, Math.ceil)}m · last updated ${minutes(now - shared.at, Math.round)}m ago`,
  }
}

function recentlyFailed(shared: SharedQuota | undefined, now: number): boolean {
  return shared?.failedAt !== undefined && now >= shared.failedAt && now - shared.failedAt < FAIL_TTL_MS
}

// What a failed refresh leaves beside the reading, so that whoever comes next does not repeat it: the
// endpoint's own deadline for a 429, and otherwise the failure's instant — with the record of Claude
// Code's start and the configured route's backoff, each the one this failure made or the one already
// standing, because only a success may clear either.
function failureStamp(err: unknown, standing: SharedQuota | undefined, now: number): Partial<SharedQuota> {
  if (err instanceof UsageRateLimited) return { retryAt: err.retryAt }
  const cli = err instanceof ClaudeCodeRefreshFailed ? err.cli : standing?.cli
  const configured = err instanceof ConfiguredRouteFailed ? err.configured : standing?.configured
  return { failedAt: now, ...(cli ? { cli } : {}), ...(configured ? { configured } : {}) }
}

// In-process guard so overlapping polls from one server start at most one background refresh.
const backgroundRefreshes = new Map<string, Promise<void>>()

function refreshSharedInBackground(paths: { data: string; lock: string }, claudeBin: string, deps: ClaudeQuotaDeps, now: number): void {
  if (backgroundRefreshes.has(paths.data)) return
  const task = (async () => {
    const before = await readShared(paths.data)
    if (rateLimited(before, now) || recentlyFailed(before, now)) return
    const release = await tryAcquireLock(paths.lock)
    if (!release) return
    try {
      // Read again under the lock: another Frizz process may have failed this same refresh a moment ago.
      const held = await readShared(paths.data)
      if (recentlyFailed(held, now)) return
      try {
        const refreshed = await refreshQuota(claudeBin, deps, now, held)
        await writeShared(paths.data, { at: now, ...refreshed })
      } catch (err) {
        // Keep the reading and its age; record only what the failure set, so the next tick does not ask
        // the endpoint (or look the credential up, or start Claude Code) again before it.
        const current = await readShared(paths.data)
        await writeShared(paths.data, { ...(current ?? { at: now, quota: UNAVAILABLE }), ...failureStamp(err, current, now) })
      }
    } finally {
      await release().catch(() => {})
    }
  })().catch(() => {})
    .finally(() => backgroundRefreshes.delete(paths.data))
  backgroundRefreshes.set(paths.data, task)
}

/** Test seam: resolves once any in-flight background refreshes have settled. */
export async function claudeQuotaRefreshSettled(): Promise<void> {
  await Promise.all([...backgroundRefreshes.values()])
}

// Proactively refresh the shared quota cache on a fixed schedule, independent of whether any browser is
// polling. The freshness of the sidebar chip (and the scheduler's weekly-reset check) used to be a
// side effect of someone READING the cache: with a 3-minute stale-while-revalidate TTL and a 60s
// browser poll, the displayed reading could lag 3–4 minutes — long enough to blow past a limit during
// a fast fleet burn without the chip ever warning. A server-side heartbeat ticking this every 30s
// keeps the cache as warm as the endpoint allows: a tick is a no-op while the reading is inside its
// TTL or the endpoint's `retryAt` has not passed.
//
// It uses the SAME non-blocking background path a stale read kicks — one in-flight refresh per process,
// a cross-process lock so N Frizz processes make one request per window per account, and Claude Code
// started only for a rejected credential, inside its own backoff. It NEVER blocks the caller and
// swallows every failure (the last known-good reading rides until the next success). It is armed once
// per project, so on a machine that is not signed in to Claude — or is offline — the ticks of every open
// project share ONE attempt per FAIL_TTL_MS: a credential lookup, or a request, and nothing else.
export async function refreshClaudeQuotaInBackground(claudeBin = "claude", deps: ClaudeQuotaDeps = {}): Promise<void> {
  const now = (deps.now ?? Date.now)()
  const configDir = claudeConfigDir()
  const cacheDir = deps.cacheDir ?? join(frizzRoots().cache, "quota-cache")
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  } catch {
    return // No shared cache dir → nothing to warm; a lazy read still has its own no-cache fallback.
  }
  const paths = cachePaths(cacheDir, configDir)
  // The heartbeat ticks faster than the TTL so a refresh lands soon after the endpoint's `retryAt`
  // rather than up to a whole interval late; a reading still inside its TTL needs nothing.
  const current = await readShared(paths.data)
  if (current?.quota.status === "ok" && now - current.at < OK_TTL_MS) return
  refreshSharedInBackground(paths, claudeBin, deps, now)
}

// The healthy cache is shared under ~/.frizz so three project windows make one usage request, not
// three simultaneous requests to the same account. A failed refresh serves the last known-good
// reading (clearly labeled in the popover) for at most one day instead of erasing useful data.
//
// Ordinary (non-force) reads are STALE-WHILE-REVALIDATE: any known-good reading newer than a day is
// returned immediately and the refresh happens in the background. The poll must never block on the
// CLI + cross-process lock (~27s worst case) — responses that slow straddle dev-server restarts and
// leave the browser's fetch hung, which is exactly how the chip froze into an em dash. Only `force`
// (the popover's explicit recheck) waits for a live refresh.
async function readEndpointQuota(
  claudeBin = "claude",
  deps: ClaudeQuotaDeps = {},
  options: { force?: boolean } = {},
): Promise<ProviderQuota> {
  const now = (deps.now ?? Date.now)()
  const configDir = claudeConfigDir()
  const cacheDir = deps.cacheDir ?? join(frizzRoots().cache, "quota-cache")
  const paths = cachePaths(cacheDir, configDir)
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  } catch {
    try {
      return (await refreshQuota(claudeBin, deps, now, { cli: CLI_NEVER })).quota
    } catch {
      return { status: "unavailable", windows: [], detail: "Claude usage unavailable" }
    }
  }
  const initial = await readShared(paths.data)
  if (!options.force && initial && now - initial.at < (initial.quota.status === "ok" ? OK_TTL_MS : FAIL_TTL_MS)) {
    return initial.quota
  }
  if (!options.force && initial?.quota.status === "ok" && now - initial.at < STALE_MAX_AGE_MS) {
    refreshSharedInBackground(paths, claudeBin, deps, now)
    const ageMs = now - initial.at
    if (ageMs >= 10 * 60_000 && rateLimited(initial, now)) return serveRateLimited(initial, now)
    // Freshly-expired data is normal churn; only label the reading once it is meaningfully old.
    if (ageMs < 10 * 60_000) return initial.quota
    return { ...initial.quota, detail: `Refreshing · last updated ${Math.round(ageMs / 60_000)}m ago` }
  }

  // A forced recheck inside the refusal window cannot succeed; asking anyway only buys another 429.
  if (rateLimited(initial, now)) return serveRateLimited(initial, now)
  // Somebody else's refresh failed moments ago and there is no reading left to serve. Only a forced
  // recheck asks again inside the window.
  if (!options.force && recentlyFailed(initial, now)) return UNAVAILABLE

  let release: (() => Promise<void>) | undefined
  try {
    release = await acquireLock(paths.lock)
    const afterLock = await readShared(paths.data)
    if (rateLimited(afterLock, now)) return serveRateLimited(afterLock, now)
    // Another Frizz process may have completed the requested refresh while this process waited.
    if (afterLock && afterLock.at !== initial?.at && now - afterLock.at < OK_TTL_MS) return afterLock.quota

    const refreshed = await refreshQuota(claudeBin, deps, now, afterLock)
    await writeShared(paths.data, { at: now, ...refreshed }).catch(() => {})
    return refreshed.quota
  } catch (err) {
    const fallback = await readShared(paths.data)
    if (err instanceof UsageRateLimited) {
      const refused = { ...(fallback ?? { at: now, quota: UNAVAILABLE }), retryAt: err.retryAt }
      await writeShared(paths.data, refused).catch(() => {})
      return serveRateLimited(refused, now)
    }
    // Claude Code's backoff outlives every failure, this one's write included: only an endpoint
    // success clears it, or the next rejected read would start the CLI all over again.
    const failed = failureStamp(err, fallback, now)
    if (fallback?.quota.status === "ok" && now - fallback.at < STALE_MAX_AGE_MS) {
      await writeShared(paths.data, { ...fallback, ...failed }).catch(() => {})
      return {
        ...fallback.quota,
        detail: `Could not refresh · last updated ${Math.max(1, Math.round((now - fallback.at) / 60_000))}m ago`,
      }
    }
    await writeShared(paths.data, { at: now, quota: UNAVAILABLE, ...failed }).catch(() => {})
    return UNAVAILABLE
  } finally {
    await release?.().catch(() => {})
  }
}

// House duration grammar (`40m`, `2h 35m`), as an age.
function agoLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const rest = minutes % 60
  return rest ? `${Math.floor(minutes / 60)}h ${rest}m ago` : `${Math.floor(minutes / 60)}h ago`
}

/**
 * The endpoint's reading with what Claude Code's own sessions have reported laid over it
 * (claude-quota-observed.ts). `servedAt` is the instant (ms) the endpoint's reading was taken.
 *
 *  • NO ENDPOINT READING — the machine a token broker signs in, where Frizz finds no credential to ask
 *    with, and equally a rejected or unreachable one with nothing cached: the sessions' report IS the
 *    reading, and its note says where it came from.
 *  • AN ENDPOINT READING OLDER THAN A REPORT: the windows that report names take its numbers — both are
 *    the provider's own, so the newer one is simply the truth — and the windows it does not name (the
 *    per-model weeklies, which no session reports) keep the endpoint's. A staleness note the endpoint's
 *    reading carried no longer describes what is shown, so it is replaced; a reading that carried none
 *    stays silent.
 */
export function withObservedClaudeQuota(
  served: ProviderQuota,
  servedAt: number | undefined,
  observed: ObservedClaudeQuota | undefined,
  now: number,
): ProviderQuota {
  if (!observed) return served
  const plain = ({ at: _at, ...window }: ObservedWindow): QuotaWindow => window
  if (served.status !== "ok") {
    return { status: "ok", windows: observed.windows.map(plain), detail: `From this machine's Claude sessions · ${agoLabel(now - observed.at)}` }
  }
  if (servedAt === undefined) return served
  const newer = new Map(observed.windows.filter((w) => w.at > servedAt).map((w) => [w.key, w]))
  if (!served.windows.some((w) => newer.has(w.key))) return served
  const windows = served.windows.map((w) => {
    const report = newer.get(w.key)
    return report ? plain(report) : w
  })
  const latest = Math.max(...[...newer.values()].map((w) => w.at))
  return {
    ...served,
    windows,
    ...(served.detail ? { detail: `Updated from this machine's Claude sessions · ${agoLabel(now - latest)}` } : {}),
  }
}

// THE READING EVERY CALLER GETS: the endpoint's (readEndpointQuota, above — every bound on what a read
// may cost lives there, untouched), then the sessions' own reports over it. The overlay costs one small
// local file read and can only ever add a reading or freshen one.
export async function readClaudeQuota(
  claudeBin = "claude",
  deps: ClaudeQuotaDeps = {},
  options: { force?: boolean } = {},
): Promise<ProviderQuota> {
  const served = await readEndpointQuota(claudeBin, deps, options)
  try {
    const now = (deps.now ?? Date.now)()
    const configDir = claudeConfigDir()
    const cacheDir = deps.cacheDir ?? join(frizzRoots().cache, "quota-cache")
    const observed = await readObservedClaudeQuota(cacheDir, configDir, now)
    if (!observed) return served
    const shared = served.status === "ok" ? await readShared(cachePaths(cacheDir, configDir).data) : undefined
    return withObservedClaudeQuota(served, shared?.quota.status === "ok" ? shared.at : undefined, observed, now)
  } catch {
    return served
  }
}
