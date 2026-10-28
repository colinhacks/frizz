import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { appendFileSync, chmodSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { describeDevice } from "./access-codes.ts"
import { serverAddressPathForStateDir } from "./frizz-paths.ts"
import { log as frizzLog } from "./logging.ts"

// ── The audit trail of high-impact board actions ────────────────────────────────────────────────────
// On 2026-10-08 a board session stolen through a backdoored frizz.sh relay was used to add
// `/private/tmp` as a project, dispatch about 13 workers into it, and later remove the project with
// its data. Frizz had logged none of it: no line said a project was added or removed, that a thread
// was dispatched or messaged, whether the request came over loopback or through the relay, or which
// signed-in device sent it. Nothing could be attributed.
//
// So every action that can start work on this machine, or destroy Frizz's record of it, writes one
// JSON line here: when, what, which project and thread, whether it was refused, and WHO — the request
// origin the launcher's proxy saw (CALLER_HEADER) plus the board session it verified. Never a
// secret: a session is named by its record id (what `frizz --sessions` lists), never its cookie, and
// prompt, message and answer text are recorded as a character count and a SHA-256, never the words.
//
// Machine-wide and append-only, at `<data>/logs/audit.jsonl` (`~/.frizz/logs/audit.jsonl` on a
// legacy layout) at 0600: one file answers "what did this board do" across every project, and the
// per-run logs beside it are pruned by count and age where this one is not. Each record is also
// summarized as one line in the ordinary run log, so it is in front of whoever reads that first.
//
// AN AUDIT WRITE NEVER FAILS THE ACTION. Every failure here is caught and reported to the run log.

/**
 * The header the launcher's proxy (restart-supervisor.ts) stamps on every request it forwards.
 *
 * The application server cannot see who called on its own: the proxy rewrites Host and Origin to the
 * child's private loopback authority, so every request reaching it looks local. The proxy is the one
 * place that judged the real authority and verified the session cookie, so it says what it saw here.
 * It DELETES any copy the client sent before setting its own, so a visitor cannot forge one.
 */
export const CALLER_HEADER = "x-frizz-caller"

/**
 * How a request reached the launcher's proxy.
 *
 *  - `public`   — as the declared public origin: a frizz.sh relay, a tunnel, a proxy of the operator's.
 *  - `network`  — from another machine straight to an exposed bind (`--host`), not as the public origin.
 *  - `loopback` — from this machine, under a loopback name.
 */
export type CallerVia = "public" | "network" | "loopback"

/** What the proxy saw. `session` is a record id, `"legacy"` for a session minted before ids, or null. */
export interface CallerStamp {
  via: CallerVia
  /** The proxy's peer address. A relayed request's peer is the relay agent in the launcher: loopback. */
  remote: string | null
  /** The Host the request named, for `public` and `network`. */
  host?: string
  /** The client address a public origin's proxy CLAIMS (`cf-connecting-ip`, `x-forwarded-for`). */
  clientIp?: string
  session: string | null
}

const VIAS: readonly CallerVia[] = ["public", "network", "loopback"]
/** Every stamped field is bounded, so a hostile Host or forwarded address cannot bloat the record. */
const STAMP_FIELD_MAX = 200

function bounded(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, STAMP_FIELD_MAX) : undefined
}

export function encodeCallerStamp(stamp: CallerStamp): string {
  return Buffer.from(JSON.stringify(stamp)).toString("base64url")
}

/** The stamp in a header value, or undefined when there is none or it does not parse as one. */
export function decodeCallerStamp(value: string | undefined): CallerStamp | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object" || !VIAS.includes(parsed.via as CallerVia)) return undefined
    const host = bounded(parsed.host)
    const clientIp = bounded(parsed.clientIp)
    return {
      via: parsed.via as CallerVia,
      remote: bounded(parsed.remote) ?? null,
      ...(host ? { host } : {}),
      ...(clientIp ? { clientIp } : {}),
      session: bounded(parsed.session) ?? null,
    }
  } catch {
    return undefined
  }
}

/**
 * Who sent the request an audited action is running under.
 *
 * `direct` means it reached the application server WITHOUT passing the launcher's proxy: a worker's
 * frizz MCP server, a script against the child's port, or a server started on its own (`pnpm dev`,
 * an ad-hoc stack). `internal` is an action with no request behind it at all.
 */
export type RequestOrigin =
  | (Omit<CallerStamp, "via"> & { via: CallerVia | "direct"; device: string })
  | { via: "internal" }

export function requestOriginFrom(input: {
  caller: string | undefined
  userAgent: string | undefined
  /** The application server's own peer — the proxy, or whoever called it directly. */
  socketRemote: string | undefined
}): RequestOrigin {
  const device = describeDevice(input.userAgent)
  const stamp = decodeCallerStamp(input.caller)
  if (stamp) return { ...stamp, device }
  return { via: "direct", remote: input.socketRemote ?? null, session: null, device }
}

const requestOrigin = new AsyncLocalStorage<RequestOrigin>()

/** Run `fn` with `origin` as the request every audited action inside it is attributed to. */
export function withRequestOrigin<T>(origin: RequestOrigin, fn: () => T): T {
  return requestOrigin.run(origin, fn)
}

export function currentRequestOrigin(): RequestOrigin {
  return requestOrigin.getStore() ?? { via: "internal" }
}

/** Text an operator typed, as something that can be matched later without being stored. */
export interface TextDigest {
  chars: number
  sha256: string
}

export function textDigest(text: string): TextDigest {
  return { chars: text.length, sha256: createHash("sha256").update(text).digest("hex") }
}

export type AuditAction =
  | "projectAdd"
  | "projectPick"
  | "projectRemove"
  | "dispatch"
  | "adoptThread"
  | "githubDispatch"
  | "followUp"
  | "subAgentSteer"
  | "steerThread"
  | "spawnThread"
  | "answerQuestions"
  | "interactionResolve"

export interface AuditRecord {
  /** UTC, ISO 8601. */
  at: string
  action: AuditAction
  outcome: "ok" | "refused"
  /** The refusal's message, when there was one. */
  error?: string
  /** The project ACTED ON — for an add or a remove, the one added or removed. */
  project: { id: string | null; dir: string | null }
  thread?: string
  origin: RequestOrigin
  /** The project whose board answered the request. Not always `project`: any board can add one. */
  servedBy?: string
  /** Per-action facts. Text appears here only as a TextDigest. */
  detail?: Record<string, unknown>
}

export interface AuditLog {
  append(record: AuditRecord): void
}

/** `<data>/logs/audit.jsonl` for the Frizz root a project state dir lives under (`../..` from it). */
export function auditLogPathForStateDir(stateDir: string): string {
  return join(dirname(serverAddressPathForStateDir(stateDir)), "logs", "audit.jsonl")
}

/**
 * The append-only file sink. Throws on a failed write; recordAudit is what keeps that from reaching
 * the action.
 *
 * One `appendFileSync` per record: O_APPEND writes of one short line land whole even with several
 * Frizz processes appending (the run log relies on the same guarantee; see logging.ts).
 */
export function fileAuditLog(path: string): AuditLog {
  let secured = false
  return {
    append(record) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      if (!secured) {
        // The mode above applies only when the file is created; a file that already existed keeps its
        // own. Tightened once per process, best effort.
        try {
          chmodSync(path, 0o600)
        } catch {
          // A file this process cannot chmod is still appended to; the record matters more.
        }
        secured = true
      }
    },
  }
}

function originSummary(origin: RequestOrigin): string {
  if (origin.via === "internal") return "internal"
  const parts: string[] = [origin.via]
  if (origin.host) parts.push(origin.host)
  if (origin.remote) parts.push(`from ${origin.remote}`)
  if (origin.clientIp) parts.push(`client ${origin.clientIp}`)
  if (origin.session) parts.push(`session ${origin.session}`)
  parts.push(`(${origin.device})`)
  return parts.join(" ")
}

/** The one line the run log carries for a record. */
export function auditSummary(record: AuditRecord): string {
  const target = [record.project.dir ?? record.project.id, record.thread].filter(Boolean).join(" ")
  const outcome = record.outcome === "ok" ? "ok" : `refused: ${record.error ?? "unknown error"}`
  return `${record.action} ${outcome}${target ? ` — ${target}` : ""} — via ${originSummary(record.origin)}`
}

export type AuditEntry = Omit<AuditRecord, "at" | "origin">

/**
 * Write one record, attributed to the request this runs under. Never throws: `build` and the sink
 * both run inside the catch, so neither a bad field nor a full disk can fail the action audited.
 */
export function recordAudit(log: AuditLog | undefined, build: () => AuditEntry): void {
  let record: AuditRecord | undefined
  try {
    const { action, outcome, error, project, thread, servedBy, detail } = build()
    // Spelled out rather than spread, so every line reads in the same order: what, then who, then detail.
    record = {
      at: new Date().toISOString(),
      action,
      outcome,
      ...(error !== undefined ? { error } : {}),
      project,
      ...(thread !== undefined ? { thread } : {}),
      origin: currentRequestOrigin(),
      ...(servedBy !== undefined ? { servedBy } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
    frizzLog.info("audit", auditSummary(record))
    log?.append(record)
  } catch (error) {
    try {
      const what = record ? `${record.action} (${record.outcome})` : "an action"
      frizzLog.error("audit", `could not record ${what}: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // The run log is the last place to say so; if it cannot, the action still stands.
    }
  }
}

export interface AuditFields {
  project?: AuditRecord["project"]
  thread?: string
  detail?: Record<string, unknown>
}

function merged(base: AuditFields, extra: AuditFields | undefined): AuditFields {
  return {
    project: extra?.project ?? base.project,
    thread: extra?.thread ?? base.thread,
    detail: base.detail || extra?.detail ? { ...base.detail, ...extra?.detail } : undefined,
  }
}

/**
 * Run an action and record its outcome: `ok` with whatever `onResult` adds, or `refused` with the
 * error's message, which is then rethrown unchanged.
 *
 * `base` is taken BEFORE the action runs, so it can describe what the action is about to change (a
 * project that a remove then forgets). Pass a function when reading it can throw: it runs inside the
 * same guard as the write, and a failure leaves the record thinner rather than failing the action.
 */
export async function audited<T>(
  log: AuditLog | undefined,
  action: AuditAction,
  base: AuditFields | (() => AuditFields),
  run: () => T | Promise<T>,
  options: { onResult?: (result: T) => AuditFields; servedBy?: string } = {},
): Promise<T> {
  let fields: AuditFields = {}
  let unreadable: unknown
  try {
    fields = typeof base === "function" ? base() : base
  } catch (error) {
    unreadable = error
  }
  const entry = (from: AuditFields): Omit<AuditEntry, "outcome" | "action"> => ({
    project: from.project ?? { id: null, dir: null },
    ...(from.thread ? { thread: from.thread } : {}),
    ...(options.servedBy ? { servedBy: options.servedBy } : {}),
    ...(from.detail || unreadable !== undefined
      ? { detail: { ...(unreadable !== undefined ? { auditError: messageOf(unreadable) } : {}), ...from.detail } }
      : {}),
  })
  let result: T
  try {
    result = await run()
  } catch (error) {
    recordAudit(log, () => ({ action, outcome: "refused", error: messageOf(error), ...entry(fields) }))
    throw error
  }
  recordAudit(log, () => {
    let extra: AuditFields | undefined
    try {
      extra = options.onResult?.(result)
    } catch (error) {
      extra = { detail: { auditError: messageOf(error) } }
    }
    return { action, outcome: "ok", ...entry(merged(fields, extra)) }
  })
  return result
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
