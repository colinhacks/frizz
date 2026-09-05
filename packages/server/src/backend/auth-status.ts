import { join } from "node:path"
import { homedir, platform } from "node:os"
import { readFileSync, statSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AccountEmails, AuthSnapshot, ProviderAuth } from "@frizz/shared"
import { tokenFromCredentialsJson } from "./claude-quota.ts"
import { defaultCodexHome } from "./codex.ts"
import { resolveClaudeExecutableAbsolute } from "./claude-broker-host.ts"

const execFileAsync = promisify(execFile)

// Whether a provider's LOCAL credential exists — the signal the new-thread gate keys on. Deliberately
// distinct from quota's `status: "unavailable"`, which is OVERLOADED (it also fires on a flaky usage
// endpoint or a 5s timeout). Blocking a dispatch must never turn on a network blip, so this reader
// reports credential PRESENCE only, and separates a positive "no credential" ("signed-out") from an
// "I couldn't tell" ("unknown"). The gate blocks on "signed-out" and FAILS OPEN on "unknown".

function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override && override.trim() ? override : join(homedir(), ".claude")
}

// Classify the on-disk ~/.claude/.credentials.json into a credential state. "token" = a usable OAuth
// token is present; "absent" = the file simply isn't there (expected on a Keychain-backed macOS
// install, where the credential lives in the login Keychain instead); "empty" = the file exists but
// carries no token; "error" = it exists but couldn't be read/parsed (→ we can't tell).
type CredState = "token" | "absent" | "empty" | "error"
function claudeFileState(configDir: string): CredState {
  let raw: string
  try {
    raw = readFileSync(join(configDir, ".credentials.json"), "utf8")
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "error"
  }
  return tokenFromCredentialsJson(raw) ? "token" : "empty"
}

// Classify the macOS login Keychain entry ("Claude Code-credentials"). darwin-only; on any other
// platform the Keychain isn't a source, so callers treat it as "absent". `security` exits non-zero
// with a distinctive "could not be found" message when the item genuinely doesn't exist — that's a
// clean "absent"; any other failure is "error" (→ unknown, fail open).
async function claudeKeychainState(): Promise<CredState> {
  // DEV/QA seam: on a Keychain-backed macOS install, pointing CLAUDE_CONFIG_DIR at an empty dir does
  // NOT simulate signed-out because the Keychain still holds the real token. FRIZZ_KEYCHAIN_DISABLED
  // forces the Keychain source to read as absent so the signed-out gate can be exercised locally. Never
  // honored in a production build, so it can't weaken real auth detection in a deploy.
  if (process.env.FRIZZ_KEYCHAIN_DISABLED && process.env.NODE_ENV !== "production") return "absent"
  if (platform() !== "darwin") return "absent"
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      encoding: "utf8",
      timeout: 4000,
    })
    return tokenFromCredentialsJson(String(stdout).trim()) ? "token" : "empty"
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string }
    const notFound = e.code === 44 || (typeof e.stderr === "string" && /could not be found/i.test(e.stderr))
    return notFound ? "absent" : "error"
  }
}

// The Claude credential state, resolved in the order Claude Code itself resolves it: the on-disk file
// first, then the macOS Keychain. A token from EITHER source ⇒ authed. When neither yields a token, we
// distinguish a clean "no credential anywhere" (signed-out) from a source that errored (unknown).
export async function readClaudeAuthState(configDir = claudeConfigDir()): Promise<ProviderAuth> {
  const file = claudeFileState(configDir)
  if (file === "token") return "authed"
  const keychain = await claudeKeychainState()
  if (keychain === "token") return "authed"
  if (file === "error" || keychain === "error") return "unknown"
  // Both sources cleanly reported absent/empty → genuinely signed out.
  return "signed-out"
}

// The Codex credential state, from $CODEX_HOME/auth.json (default ~/.codex/auth.json). Codex stores
// either an API key (OPENAI_API_KEY) or a ChatGPT-plan OAuth blob (tokens.access_token); either one
// present ⇒ authed. Missing file ⇒ signed-out; present-but-unreadable/unparseable ⇒ unknown (fail open).
export function readCodexAuthState(codexHome = defaultCodexHome()): ProviderAuth {
  // Codex ALSO authenticates from the environment — frizz forwards OPENAI_API_KEY / CODEX_API_KEY /
  // CODEX_ACCESS_TOKEN into the spawned app-server (a worker inherits frizz's environment minus frizz's
  // own control plane; see worker-env.ts, which replaced the CODEX_APP_SERVER_ENV_KEYS allowlist this
  // once had to stay in step with). A user authed that way has NO auth.json, so checking the file alone
  // would falsely block them with no way to recover (the "codex login" the modal suggests isn't how
  // they authed). Honor those keys first.
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN) return "authed"
  let raw: string
  try {
    raw = readFileSync(join(codexHome, "auth.json"), "utf8")
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "signed-out" : "unknown"
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return "unknown"
  }
  if (!doc || typeof doc !== "object") return "unknown"
  const root = doc as Record<string, unknown>
  const apiKey = typeof root.OPENAI_API_KEY === "string" && root.OPENAI_API_KEY ? root.OPENAI_API_KEY : undefined
  const tokens = root.tokens && typeof root.tokens === "object" ? (root.tokens as Record<string, unknown>) : undefined
  const accessToken = tokens && typeof tokens.access_token === "string" && tokens.access_token ? tokens.access_token : undefined
  return apiKey || accessToken ? "authed" : "signed-out"
}

/**
 * The ChatGPT account Codex would load from auth.json at process start.
 *
 * Codex's AuthManager intentionally keeps one in-memory credential snapshot for the life of an
 * app-server. Frizz uses this non-secret identifier to notice when an account switch replaced the
 * file underneath a long-lived listener. Environment authentication takes precedence over the file,
 * so there is no meaningful ChatGPT account identity to track in that mode.
 */
export function readCodexAccountId(codexHome = defaultCodexHome()): string | undefined {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN) return undefined
  try {
    const doc = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as unknown
    if (!doc || typeof doc !== "object") return undefined
    const tokens = (doc as Record<string, unknown>).tokens
    if (!tokens || typeof tokens !== "object") return undefined
    const accountId = (tokens as Record<string, unknown>).account_id
    return typeof accountId === "string" && accountId.trim() ? accountId : undefined
  } catch {
    return undefined
  }
}

// Is the `codex` executable actually runnable? Auth (auth.json/env) says a credential EXISTS; it says
// nothing about whether the binary a codex dispatch needs is installed. When it is not, the dispatch
// otherwise proceeds to create thread state and only then fails deep in the app-server with "daemon
// exited before it became ready" — a first-run footgun for a public launch, where a user may be signed
// in via env but never installed the CLI.
//
// FAIL OPEN, exactly like the auth reader: return "missing" ONLY on a positive ENOENT from the spawn.
// A timeout, a permission error, a non-zero exit (a broken-but-present binary) — anything short of
// "the OS could not find it" — is "unknown", so a slow or weird environment never blocks a working
// user. `codex --version` exits immediately; never probe with `codex app-server`, which hangs.
export async function readCodexBinaryState(
  codexBin = "codex",
  exec: typeof execFileAsync = execFileAsync,
): Promise<"present" | "missing" | "unknown"> {
  try {
    await exec(codexBin, ["--version"], { timeout: 5_000 })
    return "present"
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown"
  }
}

// Dispatch preflight rejection: the server refuses to create ANY thread state (scratchpad, worker
// daemon, registry row) for a provider that is positively signed out. The message is a stable
// sentinel the web client parses to open the sign-in modal instead of a generic failure toast.
export class ProviderAuthRequiredError extends Error {
  readonly backend: "claude" | "codex"
  constructor(backend: "claude" | "codex") {
    super(`AUTH_REQUIRED:${backend}`)
    this.name = "ProviderAuthRequiredError"
    this.backend = backend
  }
}

// Parse `claude auth status --json` stdout into a tri-state. Positive-signal only: a definite
// `loggedIn: false` in the JSON is the ONLY thing that reads as signed-out; anything unparseable is
// undefined (→ unknown upstream, fail open). The CLI may print human noise around the JSON, so scan
// for the outermost object rather than trusting the whole stream to be JSON.
export function parseClaudeAuthStatusJson(stdout: string): boolean | undefined {
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  try {
    const doc = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>
    return typeof doc.loggedIn === "boolean" ? doc.loggedIn : undefined
  } catch {
    return undefined
  }
}

// The dispatch-preflight Claude signal: `claude auth status --json` run with the worker's own
// executable in the project cwd (maintainer call: the auth-status CLI is the right detection signal
// for Claude). Exit 0 ⇒ the CLI considers the user logged in. A non-zero exit is only signed-out when
// the emitted JSON POSITIVELY says `loggedIn: false` — a missing binary, timeout, or unparseable
// output is "unknown" so the gate fails open. NOTE this is a presence check, not validity proof: an
// expired/revoked token still passes and is caught by the runtime 401 classifier.
export async function readClaudeAuthStatusCli(opts?: {
  claudeBin?: string
  cwd?: string
  timeoutMs?: number
}): Promise<ProviderAuth> {
  try {
    // Resolved INSIDE the try, and through the broker's resolver rather than by handing `execFile` a
    // bare name: on Windows a bare name never reaches an npm-installed CLI. Measured there against
    // claude 2.1.241 with a control — `execFile("claude")` is ENOENT (the file on PATH is a POSIX sh
    // script), and `execFile("claude.cmd")` is EINVAL, because node has refused .cmd/.bat without a
    // shell since CVE-2024-27980. So this reader could only ever return "unknown" on Windows. The
    // resolver follows the .cmd stub to the real claude.exe. It THROWS when nothing resolves, which
    // is why it sits inside the try: a machine with no CLI must still fail open as it always did.
    const bin = resolveClaudeExecutableAbsolute(opts?.claudeBin)
    const { stdout } = await execFileAsync(bin, ["auth", "status", "--json"], {
      encoding: "utf8",
      timeout: opts?.timeoutMs ?? 5000,
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    })
    return parseClaudeAuthStatusJson(String(stdout)) === false ? "signed-out" : "authed"
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout
    const loggedIn = typeof stdout === "string" ? parseClaudeAuthStatusJson(stdout) : undefined
    if (loggedIn === false) return "signed-out"
    if (loggedIn === true) return "authed"
    return "unknown"
  }
}

// The DISPATCH-PREFLIGHT Claude verdict — local credential first, CLI only to confirm a positive
// local signed-out. Same shape as readAuthSnapshot's Claude arm below, and for the same reason, but
// with the preflight's own fail-open rule: the CLI's verdict is returned AS-IS, so an "unknown" from
// it still fails open (readAuthSnapshot instead lets the local signed-out stand, because a gate that
// can't confirm should keep offering sign-in).
//
// This preflight is the FIRST thing dispatch() does — before the scratchpad, the worker prompt, the
// daemon, the registry — so anything it waits on is dead time between Enter and the worker existing at
// all.
// Reaching for the CLI unconditionally put a fork+exec of a heavy binary doing a network round trip
// on that path; under worker-fleet load it routinely blew its own 5s timeout and fell back to
// "unknown", i.e. the common case paid five seconds to learn nothing. Measured under load: CLI
// 5449ms → "unknown"; local read 674–1909ms → a definitive "authed". See also claude-quota.ts, which
// is endpoint-first for exactly this reason. Do not put the CLI back on the signed-in path.
export async function readClaudePreflightAuth(opts?: { claudeBin?: string; cwd?: string }): Promise<ProviderAuth> {
  const local = await readClaudeAuthState()
  if (local !== "signed-out") return local
  return readClaudeAuthStatusCli({ claudeBin: opts?.claudeBin, ...(opts?.cwd ? { cwd: opts.cwd } : {}) })
}

// ---- Which ACCOUNT each credential belongs to ----
// Purely informational: the quota popover answers "signed in as who?". Nothing gates on it, so every
// reader here returns undefined rather than throwing, and an unreadable/absent record is simply "we
// don't know" — never an error the caller has to handle.
//
// Read from the providers' OWN on-disk account records, never from a CLI. `claude auth status --json`
// does report the email, but this file's preflight comment explains at length why the CLI must not sit
// on the signed-in path (measured 5449ms → "unknown" under fleet load); the same reasoning applies
// tenfold to a decorative label.

// An email-shaped string, capped at the RFC-max 320 chars — the shared AccountEmails schema rejects
// anything longer, and a corrupt account record must not put arbitrary text into the popover.
function asEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const email = value.trim()
  return email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined
}

// Claude Code's account record. NOTE this is `.claude.json` beside the config dir, NOT the
// `.credentials.json` INSIDE it: the credential file (and the Keychain item that replaces it on macOS)
// carries the token and no identity at all. With CLAUDE_CONFIG_DIR set, Claude Code moves this file
// into that dir, so it tracks the same override claudeConfigDir() honors.
function claudeAccountFile(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override && override.trim() ? join(override, ".claude.json") : join(homedir(), ".claude.json")
}

// That file also holds Claude Code's entire per-project history — it is routinely a few hundred KB, and
// readAuthSnapshot runs on a 2s poll while the sign-in terminal is open. Memoize on (path, mtime, size)
// so the parse happens once per actual write instead of once per poll.
let claudeAccountMemo: { path: string; mtimeMs: number; size: number; email: string | undefined } | undefined
export function readClaudeAccountEmail(path = claudeAccountFile()): string | undefined {
  let stat: { mtimeMs: number; size: number }
  try {
    stat = statSync(path)
  } catch {
    return undefined
  }
  const memo = claudeAccountMemo
  if (memo && memo.path === path && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.email
  let email: string | undefined
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { oauthAccount?: { emailAddress?: unknown } }
    email = asEmail(doc?.oauthAccount?.emailAddress)
  } catch {
    email = undefined
  }
  claudeAccountMemo = { path, mtimeMs: stat.mtimeMs, size: stat.size, email }
  return email
}

// Codex keeps no plaintext account record: the identity lives in the OIDC id_token inside auth.json.
// Read the payload segment WITHOUT verifying the signature — this is a display label sourced from the
// user's own credential file, not an authorization decision, and frizz has no key to verify it against.
// An expired id_token still names the right account (Codex refreshes in place), so expiry is ignored.
export function readCodexAccountEmail(codexHome = defaultCodexHome()): string | undefined {
  let doc: { tokens?: { id_token?: unknown } }
  try {
    doc = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as typeof doc
  } catch {
    return undefined
  }
  const idToken = doc?.tokens?.id_token
  if (typeof idToken !== "string") return undefined
  const payload = idToken.split(".")[1]
  if (!payload) return undefined
  try {
    return asEmail((JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown }).email)
  } catch {
    return undefined
  }
}

// Both providers' account emails. Independent and individually best-effort: one provider's unreadable
// record never costs the other its label. An API-key-only Codex install has no id_token and therefore
// no email — that is a normal outcome, not a failure.
export function readAccountEmails(): AccountEmails {
  const emails: AccountEmails = {}
  const claude = tryRead(readClaudeAccountEmail)
  const codex = tryRead(readCodexAccountEmail)
  if (claude) emails.claude = claude
  if (codex) emails.codex = codex
  return emails
}

function tryRead(read: () => string | undefined): string | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

// The per-provider auth snapshot the new-thread gate reads. Never throws — each provider degrades to
// "unknown" independently, and the gate fails open on "unknown".
//
// Claude uses TWO detectors that must not disagree into a dead-end: the fast local reader
// (file/keychain) answers most calls, but its positive "signed-out" is CONFIRMED against the CLI
// (`claude auth status --json` — the signal the dispatch preflight trusts) before it is reported.
// A credential stored somewhere the local reader doesn't cover would otherwise trap the user in the
// sign-in modal ("Still signed out" / "didn't complete") while a real dispatch would succeed. The
// CLI shell-out only happens on the signed-out path, so signed-in users never pay for it.
export async function readAuthSnapshot(opts?: { claudeBin?: string }): Promise<AuthSnapshot> {
  const [claude, codex] = await Promise.all([
    readClaudeAuthState()
      .then(async (local): Promise<ProviderAuth> => {
        if (local !== "signed-out") return local
        const cli = await readClaudeAuthStatusCli({ claudeBin: opts?.claudeBin })
        return cli === "authed" ? "authed" : local
      })
      .catch((): ProviderAuth => "unknown"),
    Promise.resolve().then(() => readCodexAuthState()).catch((): ProviderAuth => "unknown"),
  ])
  // A signed-out provider has no account to name, and a stale email under a signed-out chip would read
  // as "still signed in as…". Only report the label for a credential we actually found.
  const emails = readAccountEmails()
  return {
    claude,
    codex,
    emails: {
      ...(claude === "signed-out" ? {} : emails.claude ? { claude: emails.claude } : {}),
      ...(codex === "signed-out" ? {} : emails.codex ? { codex: emails.codex } : {}),
    },
  }
}
