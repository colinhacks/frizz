import { join } from "node:path"
import { readdirSync, statSync, openSync, readSync, fstatSync, closeSync } from "node:fs"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import type { ProviderQuota, QuotaWindow } from "@frizz/shared"
import { defaultCodexHome } from "./codex.ts"
import { resolveCodexExecutable } from "./codex-executable.ts"
import { readCodexAccountId, readCodexAuthState } from "./auth-status.ts"
import { isRuntimeDeferred } from "../runtime-deferral.ts"
// The SAME handshake identity the dispatch path uses, so the app-server sees one consistent client.
import { CLIENT_INFO, CLIENT_CAPABILITIES } from "./codex-app-server.ts"

// The Codex subscription quota (5-hour + weekly rate-limit windows) has TWO sources, in this order:
//
//   1. LIVE — the app-server's `account/rateLimits/read`, which is what the Codex TUI itself renders.
//      It answers for the account that is signed in RIGHT NOW.
//   2. ROLLOUT TAIL — the `rate_limits` block on the last `token_count` event of the newest rollout
//      JSONL. Free and offline-safe, but it is only a CACHE of whichever account last ran a turn.
//
// The fallback ordering is not cosmetic: rollouts carry NO account identity (verified — `session_meta`
// has session_id/cwd/originator/cli_version/git and nothing about the account), so after `codex login`
// switches accounts, every rollout on disk still describes the OLD one. That is exactly how frizz came
// to show "1% remaining" from an exhausted previous account while `codex` in a terminal reported a
// fresh 100% (2026-07-31). Nothing local can re-attribute those files, so the live read has to be
// primary and the tail only a degradation path for when the app-server can't be reached.

// ---- source 2: the rollout tail ----
//
// Every Codex `token_count` event carries a `rate_limits` block that is ACCOUNT-GLOBAL (identical
// across concurrent sessions of the same account), so the freshest one from the most-recently-written
// rollout is that account's last known state:
//
//   {"type":"token_count","info":{…},"rate_limits":{
//     "limit_id":"codex","plan_type":"pro",
//     "primary":  {"used_percent":12.5,"window_minutes":300,  "resets_at":1783730191},  // 5-hour
//     "secondary":{"used_percent":40.0,"window_minutes":10080,"resets_at":1784316991}}} // weekly (7d)
//
// window_minutes disambiguates which window is which rather than trusting primary/secondary names:
// 300 → "5h", 10080 → "Weekly". used_percent is 0..100 (remaining = 100 - used_percent); resets_at is
// unix seconds. Grounded in captured 0.144.1 rollouts (backend/codex.fixtures/*.jsonl).

function sessionsDir(codexHome: string): string {
  return join(codexHome, "sessions")
}

// Newest-first walk of the date-sharded rollout tree (YYYY/MM/DD dirs + flat legacy files), bounded so
// a pathological "thousands of sessions" tree can't blow the budget. Mirrors codex.ts's own discovery
// ordering (descending dir/file names visit today's shard first). Degrades to [] on any fs error.
const descByName = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)
function newestRollouts(dir: string, out: string[], budget: { n: number }): void {
  if (budget.n <= 0) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(descByName)
  const files = entries
    .filter((e) => e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl"))
    .map((e) => e.name)
    .sort(descByName)
  for (const d of dirs) {
    if (budget.n <= 0) return
    newestRollouts(join(dir, d), out, budget)
  }
  for (const f of files) {
    if (budget.n <= 0) return
    out.push(join(dir, f))
    budget.n--
  }
}

// A rate_limits window as it appears in a token_count event.
interface RawWindow {
  used_percent?: unknown
  window_minutes?: unknown
  resets_at?: unknown
}

// Read only the TAIL of a rollout — a live transcript can be tens of MB, but the `token_count` event we
// need is emitted every turn and the file ends within a few records of the last turn, so the last chunk
// always holds the freshest rate_limits. Bounds every read; degrades to "" on any fs error (never throws).
const TAIL_BYTES = 512 * 1024
function readTail(path: string): string {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const len = size - start
    const buf = Buffer.allocUnsafe(len)
    let read = 0
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read)
      if (n <= 0) break
      read += n
    }
    return buf.toString("utf8", 0, read)
  } catch {
    return ""
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* already closed / gone */
      }
    }
  }
}

// Build a QuotaWindow from an already-normalized (usedPercent, minutes, resetsAt) triple. Label by
// window LENGTH rather than trusting the primary/secondary names: 300 min = 5h, 10080 min = weekly;
// anything else falls back to an hour count. usedPercent is 0..100 (remaining = 100 - usedPercent).
//
// The key doubles as the label because `5h` is BOTH a stable provider-neutral id (QuotaBar looks the
// binding window up by it) and the house duration grammar's own spelling of five hours. Those are two
// different jobs that happen to want the same string; if the grammar ever moves off single letters,
// the key must not move with it.
function makeWindow(used: number | undefined, minutes: number | undefined, resetsAt: number | undefined): QuotaWindow | undefined {
  if (used === undefined) return undefined
  const key = minutes === 300 ? "5h" : minutes && minutes >= 10080 ? "weekly" : minutes ? `${Math.round(minutes / 60)}h` : "window"
  const label = key === "weekly" ? "Weekly" : key
  return { key, label, usedPercent: used, resetsAt }
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

// The rollout (snake_case) spelling of a window.
function toWindow(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const w = raw as RawWindow
  return makeWindow(num(w.used_percent), num(w.window_minutes), num(w.resets_at))
}

// Parse the LAST token_count event out of a rollout's raw text → its rate_limits, or undefined. Scans
// lines from the end so a long rollout only JSON-parses its tail. Handles BOTH captured shapes: the
// live rollout wraps it as {type:"event_msg", payload:{type:"token_count", rate_limits}}, while some
// exec/fixture captures flatten rate_limits onto the top-level object. Total: never throws.
export function parseCodexQuotaFromRollout(raw: string): ProviderQuota | undefined {
  const lines = raw.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes("\"token_count\"") || !line.includes("rate_limits")) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!obj || typeof obj !== "object") continue
    const top = obj as Record<string, unknown>
    const payload = top.payload && typeof top.payload === "object" ? (top.payload as Record<string, unknown>) : undefined
    const rl = top.rate_limits ?? payload?.rate_limits
    if (!rl || typeof rl !== "object") continue
    const r = rl as Record<string, unknown>
    const windows = [toWindow(r.primary), toWindow(r.secondary)].filter((x): x is QuotaWindow => x !== undefined)
    if (windows.length === 0) continue
    const planType = typeof r.plan_type === "string" ? r.plan_type : undefined
    return { status: "ok", planType, windows }
  }
  return undefined
}

// The rollout-derived quota, or a neutral "unavailable" when Codex has no sessions yet or none
// recorded a rate_limits block. Never throws.
export function readCodexQuotaFromRollouts(codexHome = defaultCodexHome()): ProviderQuota {
  let quota: ProviderQuota = { status: "unavailable", windows: [], detail: "No recent Codex session" }
  try {
    const rollouts: string[] = []
    newestRollouts(sessionsDir(codexHome), rollouts, { n: 8 })
    // Order the candidates by mtime so the freshest rate_limits wins even across date shards.
    const byMtime = rollouts
      .map((path) => {
        try {
          return { path, mtimeMs: statSync(path).mtimeMs }
        } catch {
          return undefined
        }
      })
      .filter((x): x is { path: string; mtimeMs: number } => x !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const { path } of byMtime) {
      const parsed = parseCodexQuotaFromRollout(readTail(path))
      if (parsed) {
        quota = parsed
        break
      }
    }
  } catch {
    quota = { status: "unavailable", windows: [], detail: "Codex rollouts unreadable" }
  }
  return quota
}

// ---- source 1: the live app-server read ----
//
// `account/rateLimits/read` is the method the Codex TUI itself calls to paint its limits line, so it is
// authoritative and always describes the CURRENTLY signed-in account. Its window fields are camelCase
// (`usedPercent`, `windowDurationMins`, `resetsAt`) where the rollout's are snake_case — the two shapes
// are otherwise the same, hence the separate reader below. Response, verified live against codex-cli
// 0.146.0 on 2026-07-31:
//
//   {"result":{"rateLimits":{"limitId":"codex","planType":"pro",
//     "primary":{"usedPercent":0,"windowDurationMins":10080,"resetsAt":1786130265},
//     "secondary":null,"credits":{…}}, "rateLimitsByLimitId":{…}, "rateLimitResetCredits":{…}}}
//
// `rateLimitsByLimitId` additionally breaks the account down per model family; frizz shows the account
// aggregate, so only the top-level `rateLimits` is read.

// The camelCase (app-server) spelling of a window.
function toLiveWindow(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const w = raw as Record<string, unknown>
  return makeWindow(num(w.usedPercent), num(w.windowDurationMins), num(w.resetsAt))
}

/** Parse an `account/rateLimits/read` result into a ProviderQuota. Pure; undefined if unusable. */
export function parseCodexQuotaFromRateLimits(result: unknown, observedAt = Date.now()): ProviderQuota | undefined {
  if (!result || typeof result !== "object") return undefined
  const rl = (result as Record<string, unknown>).rateLimits
  if (!rl || typeof rl !== "object") return undefined
  const r = rl as Record<string, unknown>
  const allowed = (result as Record<string, unknown>).ordinaryUsageAllowed
  const ordinaryUsageAllowed = !("ordinaryUsageAllowed" in result) ? undefined : typeof allowed === "boolean" ? allowed : null
  const windows = [toLiveWindow(r.primary), toLiveWindow(r.secondary)].filter((x): x is QuotaWindow => x !== undefined)
  const credits = r.credits && typeof r.credits === "object" ? r.credits as Record<string, unknown> : undefined
  const creditsAvailable = credits?.unlimited === true || credits?.hasCredits === true ? true
    : credits?.unlimited === false && credits?.hasCredits === false ? false : undefined
  const reached = r.rateLimitReachedType
  const individual = r.individualLimit && typeof r.individualLimit === "object" ? r.individualLimit as Record<string, unknown> : undefined
  const blocked = r.spendControlReached === true ||
    (typeof reached === "string" && reached !== "rate_limit_reached") ||
    (typeof individual?.remainingPercent === "number" && individual.remainingPercent <= 0)
  if (windows.length === 0 && creditsAvailable === undefined && ordinaryUsageAllowed !== true) return undefined
  const planType = typeof r.planType === "string" ? r.planType : undefined
  return { status: "ok", planType, windows, codexRecovery: {
    observedAt, creditsAvailable, ...(ordinaryUsageAllowed !== undefined ? { ordinaryUsageAllowed } : {}),
    ...(blocked ? { blocked: true } : {}),
  } }
}

// One short-lived `codex app-server` (~0.7-0.9s measured end to end): initialize → initialized →
// account/rateLimits/read → SIGKILL. Deliberately a fresh process rather than the project's dispatch
// daemon: that daemon is per-project and only exists while threads run, whereas the sidebar chip polls
// whether or not anything is dispatched. Bounded by `timeoutMs` and total — resolves undefined on a
// missing binary, a signed-out account, a protocol change, or a hang, and the caller degrades to the
// rollout tail.
export function queryCodexRateLimits(
  codexHome = defaultCodexHome(),
  codexBin = "codex",
  timeoutMs = 12_000,
): Promise<ProviderQuota | undefined> {
  return new Promise((resolve) => {
    const observedAt = Date.now()
    const accountId = readCodexAccountId(codexHome)
    let child: ReturnType<typeof spawn>
    try {
      // DELIBERATELY BARE — no codexAppServerArgv here. This is a short-lived read of the quota
      // endpoint, not a worker: mounting frizz's MCP server would make every quota poll fork a
      // frizz-MCP process for tools nothing in this path can call, and drag in whatever servers the
      // operator's own codex config mounts alongside it.
      //
      // Resolved inside the try: on Windows a bare `codex` never reaches an npm-installed CLI (see
      // codex-executable.ts), and this poll read the quota as unavailable for an installed Codex
      // whenever the runtime pin had fallen back to PATH (Windows audit 2026-09-11, finding 8). A
      // miss throws, which lands in the catch below exactly as a spawn failure always has.
      const codex = resolveCodexExecutable(codexBin)
      child = spawn(codex.file, [...codex.args, "app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, CODEX_HOME: codexHome },
        // No console window for codex.exe (Windows audit 2026-09-11, finding 4).
        windowsHide: true,
      })
    } catch {
      resolve(undefined)
      return
    }

    let settled = false
    const finish = (quota: ProviderQuota | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
      resolve(quota)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)

    const send = (msg: object) => {
      try {
        child.stdin?.write(JSON.stringify(msg) + "\n")
      } catch {
        finish(undefined)
      }
    }

    child.on("error", () => finish(undefined))
    child.on("exit", () => finish(undefined))
    // A write into a child that has stopped reading fails on the STREAM, a tick after `write` returned:
    // the `try` in `send` never sees the EPIPE, and an 'error' nobody listens for is an uncaught
    // exception, which exits the server (2026-10-11, a disposable stack taken down mid-run).
    child.stdin?.on("error", () => finish(undefined))

    // Line-framed JSON-RPC on stdout. Ignore every notification; we only care about our two replies.
    let buf = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8")
      // A stuck/garbage stream must not grow without bound.
      if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-64 * 1024)
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (msg.id === 1) {
          // Handshake done: the app-server requires the `initialized` notification before it will
          // serve account methods.
          send({ jsonrpc: "2.0", method: "initialized" })
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} })
        } else if (msg.id === 2) {
          const quota = parseCodexQuotaFromRateLimits(msg.result, observedAt)
          if (quota) {
            // auth.json can change while the subprocess is answering. Its quota remains useful for
            // display, but is not recovery evidence for the account the next turn would load.
            const reported = msg.result && typeof msg.result === "object" ? (msg.result as Record<string, unknown>).accountId : undefined
            if (readCodexAccountId(codexHome) !== accountId || (accountId && typeof reported === "string" && reported !== accountId)) delete quota.codexRecovery
            else if (accountId) quota.codexRecovery!.accountKey = createHash("sha256").update(accountId).digest("hex")
          }
          finish(quota)
        }
      }
    })

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: CLIENT_INFO, capabilities: CLIENT_CAPABILITIES },
    })
  })
}

// HOW OFTEN THAT PROCESS MAY START. Every live read is a whole `codex app-server`, and the read is
// driven by a browser poll (every 30s, every 15s while EITHER provider's reading is degraded) on a
// machine whose Codex runtime Frizz itself provisioned — so it runs for people who have never used
// Codex. Until 2026-10-11 the only bound was a 20s memo that treated a failed read like a good one:
// a 30s poll always missed it, so one open tab started an app-server on every poll for as long as it
// stayed open, signed in or not, and the same again for a read that could never succeed. Four bounds
// now, each for a different way of paying for nothing:
//
//   • NO CREDENTIAL, NO PROCESS. A positively signed-out Codex (no auth.json, no key in the
//     environment — readCodexAuthState, the dispatch gate's own reader) has no account to ask about.
//   • A healthy reading is good for TTL_MS, which is longer than the poll, so polls share it.
//   • A FAILED read is not re-asked until LIVE_BACKOFF has passed — 1m, doubling to 30m — because the
//     failures that persist (an API-key sign-in, which has no plan windows; a CLI that cannot speak
//     this method; no network) fail identically every time. The rollout tail is served meanwhile. The
//     backoff resets on a good read and whenever the credential changes hands (a sign-in, an account
//     switch), so signing in is never something a deadline makes you wait out.
//   • Callers that arrive while a read is running join it rather than starting their own.
//
// `force` is the popover's explicit recheck: it skips the memo and the backoff, never the credential
// check. Keyed by codexHome so distinct homes (tests) never collide; process-wide on purpose — there
// is one server per machine, and the account is the machine's.
const TTL_MS = 60_000
const LIVE_BACKOFF_BASE_MS = 60_000
const LIVE_BACKOFF_MAX_MS = 30 * 60_000

interface CodexQuotaState {
  memo?: { at: number; quota: ProviderQuota }
  inFlight?: Promise<ProviderQuota>
  /** What the live read was last asked with; a different one means a different account to ask about. */
  credential?: string
  /** Consecutive live reads that produced nothing, and the instant (ms) before which none is retried. */
  failures: number
  retryAt: number
}
const states = new Map<string, CodexQuotaState>()

/** Test seam: forget every reading and every backoff so a test can observe a fresh read. */
export function resetCodexQuotaMemo(): void {
  states.clear()
}

const SIGNED_OUT = "signed-out"

// Who the live read would be asking about. "unknown" (an unreadable auth.json) is NOT signed out: the
// read goes ahead and its own failure is what gets remembered.
function codexCredential(codexHome: string): string {
  const auth = readCodexAuthState(codexHome)
  return auth === "signed-out" ? SIGNED_OUT : `${auth}:${readCodexAccountId(codexHome) ?? ""}`
}

// The Codex provider quota (RPC-facing): the live app-server reading when it can be had, else the
// rollout tail. Never throws.
export async function readCodexQuota(
  codexHome = defaultCodexHome(),
  codexBin = "codex",
  options: { force?: boolean; now?: () => number } = {},
): Promise<ProviderQuota> {
  const now = (options.now ?? Date.now)()
  let state = states.get(codexHome)
  if (!state) states.set(codexHome, (state = { failures: 0, retryAt: 0 }))
  if (!options.force && state.memo && now - state.memo.at < TTL_MS) return state.memo.quota
  if (state.inFlight) return state.inFlight
  const held = state
  held.inFlight = refreshCodexQuota(held, codexHome, codexBin, now, options.force === true).finally(() => {
    held.inFlight = undefined
  })
  return held.inFlight
}

async function refreshCodexQuota(state: CodexQuotaState, codexHome: string, codexBin: string, now: number, force: boolean): Promise<ProviderQuota> {
  let credential: string
  try {
    credential = codexCredential(codexHome)
  } catch {
    credential = "unknown:"
  }
  if (credential !== state.credential) {
    state.credential = credential
    state.failures = 0
    state.retryAt = 0
  }
  let quota: ProviderQuota | undefined
  // A runtime still waiting for its first thread (runtime-deferral.ts) is not on disk to be started, and
  // a chip is no reason to fetch it. Not a failed read either: nothing was asked, so no backoff is spent
  // and the first poll after the thread that brings it down gets its reading.
  if (credential !== SIGNED_OUT && !isRuntimeDeferred("codex") && (force || now >= state.retryAt)) {
    try {
      quota = await queryCodexRateLimits(codexHome, codexBin)
    } catch {
      quota = undefined
    }
    if (quota) {
      state.failures = 0
      state.retryAt = 0
    } else {
      state.failures++
      state.retryAt = now + Math.min(LIVE_BACKOFF_BASE_MS * 2 ** (state.failures - 1), LIVE_BACKOFF_MAX_MS)
    }
  }
  // The tail can only ever describe the account that last ran a turn, so label it: after an account
  // switch it is the ONLY thing that can still show a stale number, and the popover should say so.
  if (!quota) {
    const fallback = readCodexQuotaFromRollouts(codexHome)
    quota =
      fallback.status === "ok"
        ? { ...fallback, detail: "From the last local session — sign-in state unconfirmed" }
        : fallback
  }
  state.memo = { at: now, quota }
  return quota
}
