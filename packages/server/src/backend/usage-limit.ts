import type { LimitWindow } from "@frizz/shared"
// Type-only, so this never becomes a runtime cycle (types.ts reaches back here through tailer.ts).
import type { LimitFault } from "./types.ts"

// ---- SUBSCRIPTION USAGE-LIMIT DETECTION (the auto-resume feature's read side) -------------------
// When a Claude subscription window is exhausted mid-turn, the CLI does NOT crash: it appends one
// SYNTHETIC assistant record and stops. Verified shape (claude-code 2.1.216, real transcripts):
//
//   {"type":"assistant","timestamp":"…","message":{"model":"<synthetic>","stop_reason":"stop_sequence",
//     "content":[{"type":"text","text":"You've hit your session limit · resets 5:50pm (America/Los_Angeles)"}]},
//    "error":"rate_limit","apiErrorStatus":429,"isApiErrorMessage":true}
//
// `error:"rate_limit"` is a STRUCTURAL discriminator, not a text guess: across the whole local corpus
// it appears on session/weekly-limit records and NOTHING else (connection failures carry
// "server_error"; Overloaded and the 400 consumer-terms notice carry "unknown"). So detection keys on
// the structured field and the text is parsed only for the two things the field doesn't carry — WHICH
// window blew, and when it resets.
//
// stop_reason "stop_sequence" is neither end_turn nor tool_use, so computeTurn's unknown-stop-reason
// backstop lands the thread IDLE ~5s later. That idle-with-a-live-limit-fault state is exactly the
// "was running when the limit hit" set the scheduler resumes.

// Which subscription window the provider says is exhausted. The 5-hour window ("5-hour limit" since
// Claude Code 2.1.312, "session limit" before it; Frizz's own key stays "session") always resets within 5 hours, so its wall-clock reset text resolves unambiguously to the next
// occurrence. The weekly window can be days out, so its text-only clock is NOT resolvable — that
// case defers to the quota endpoint for an exact instant (see resolveResetInstant's callers).
export type { LimitWindow }

export interface LimitClassification {
  window: LimitWindow
  // Wall-clock reset as the provider stated it, kept structured (hour/minute/tz) rather than as raw
  // provider text — the same discipline authFault follows: only typed data leaves the fold.
  resetClock?: { hour: number; minute: number; timeZone: string }
  // The provider's model name for a MODEL-scoped cap ("Fable 5" from "You've reached your Fable 5
  // limit"). Only typed data leaves the fold; the scheduler resolves it against the usage endpoint's
  // scoped weekly windows (scopedQuotaWindow below).
  model?: string
}

// The shape the fold hands us: only the fields this classifier reads, `unknown`-tolerant so a schema
// drift degrades to "not a limit record" instead of throwing.
export interface LimitRecordLike {
  isApiErrorMessage?: boolean
  error?: unknown
  apiErrorStatus?: unknown
}

// "You've hit your session limit · resets 5:50pm (America/Los_Angeles)"
// The separator is U+00B7 in the observed corpus, but accept the ASCII fallbacks too — the recovery
// path must not hinge on which bullet the CLI happens to render.
const RESET_RE = /\bresets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i

// Which window the message names. Deliberately conservative: an unrecognized phrasing is "unknown"
// (→ no auto-resume from text alone) rather than being guessed into the 5-hour bucket, because a
// wrong guess there would resume against a still-exhausted weekly window. Claude Code 2.1.312 renamed
// the 5-hour window's line to "You've hit your 5-hour limit · resets …" ("session limit" through
// 2.1.311), so both spellings are live: older transcripts keep the old one.
function windowFromText(text: string): LimitWindow {
  if (/\bweekly\s+limit\b/i.test(text) || /\bweek\b/i.test(text)) return "weekly"
  if (/\bsession\s+limit\b/i.test(text) || /\b5[- ]?hour\b/i.test(text)) return "session"
  if (modelFromText(text) !== undefined) return "model"
  return "unknown"
}

// The MODEL-SCOPED cap, verbatim shape from a real transcript (CLI 2.1.251, 2026-08-31, `error:
// "rate_limit"` + 429 riding the same synthetic channel):
//
//   "You've reached your Fable 5 limit. Switch to another model, or manage usage credits at
//    claude.ai/settings/usage?from=cc_cli_limit_message, to continue."
//
// The captured name ("Fable 5") is the only text-derivable fact; the window's live percent and reset
// instant come off the usage endpoint's matching `weekly-<model>` scoped entry. Checked AFTER the
// session/weekly phrasings above, so "reached your weekly limit" can never be mis-read as a model name.
function modelFromText(text: string): string | undefined {
  const m = /\breached your\s+(.+?)\s+(?:usage\s+)?limit\b/i.exec(text)
  const name = m?.[1]?.trim()
  if (!name || /^(?:session|weekly|usage|5[- ]?hour)$/i.test(name)) return undefined
  return name
}

// Parse the wall-clock reset out of the limit text. Returns undefined when the message carries no
// recognizable clock (→ the caller falls back to the quota endpoint's exact epoch).
export function parseLimitResetClock(text: string): LimitClassification["resetClock"] | undefined {
  const m = RESET_RE.exec(text)
  if (!m) return undefined
  let hour = parseInt(m[1], 10)
  const minute = m[2] ? parseInt(m[2], 10) : 0
  const meridiem = m[3]?.toLowerCase()
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return undefined
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined
    if (meridiem === "pm" && hour !== 12) hour += 12
    if (meridiem === "am" && hour === 12) hour = 0
  } else if (hour > 23) return undefined
  const timeZone = m[4]?.trim()
  // A clock with no zone cannot be resolved to an instant safely (the CLI renders the ACCOUNT's zone,
  // which need not be this machine's), so treat it as unparseable rather than assuming local time.
  if (!timeZone || !isValidTimeZone(timeZone)) return undefined
  return { hour, minute, timeZone }
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// Classify one transcript record. Returns undefined for every record that is not a subscription
// usage-limit stop — including other API errors riding the same synthetic-record channel.
export function classifyLimitRecord(rec: LimitRecordLike, text: string | undefined): LimitClassification | undefined {
  if (rec.isApiErrorMessage !== true) return undefined
  // Structural first. The 429 is corroborating, not required: the field is absent on some error
  // records, and `error:"rate_limit"` alone has never appeared on anything but a limit stop.
  if (rec.error !== "rate_limit") return undefined
  const body = text ?? ""
  const resetClock = parseLimitResetClock(body)
  const window = windowFromText(body)
  const model = window === "model" ? modelFromText(body) : undefined
  return { window, ...(resetClock ? { resetClock } : {}), ...(model ? { model } : {}) }
}

// ---- Wall-clock → instant, in an arbitrary IANA zone ----------------------------------------------
// Node has no "build a Date from Y/M/D H:M in zone Z" primitive, so invert Intl: format a guess in the
// target zone, measure how far the formatted wall clock is from the wall clock we want, and correct.
// Two passes settle a DST boundary (the first correction can land on the other side of a transition).
function zonedPartsAt(instantMs: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(instantMs))
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "", 10)
  // Intl renders midnight as hour 24 under hour12:false in some ICU versions — normalize it.
  const h = get("hour")
  return { y: get("year"), mo: get("month"), d: get("day"), h: h === 24 ? 0 : h, mi: get("minute") }
}

// The instant at which the given zone's wall clock reads exactly `y-mo-d h:mi`.
function instantForZonedWallClock(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  // Start from the UTC interpretation, then correct by the observed skew (twice, for DST edges).
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0)
  for (let i = 0; i < 2; i++) {
    const got = zonedPartsAt(guess, timeZone)
    const skew = Date.UTC(got.y, got.mo - 1, got.d, got.h, got.mi) - Date.UTC(y, mo - 1, d, h, mi)
    if (skew === 0) break
    guess -= skew
  }
  return guess
}

// Resolve a parsed reset clock to the NEXT instant it occurs at or after `nowMs`, in its own zone.
// Only meaningful for a window whose period is under 24h — the caller gates on that (see below).
export function resolveResetInstant(
  clock: NonNullable<LimitClassification["resetClock"]>,
  nowMs: number,
): number | undefined {
  const { hour, minute, timeZone } = clock
  const today = zonedPartsAt(nowMs, timeZone)
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const candidate = instantForZonedWallClock(today.y, today.mo, today.d + dayOffset, hour, minute, timeZone)
    if (!Number.isFinite(candidate)) return undefined
    if (candidate > nowMs) return candidate
  }
  return undefined
}

// The provider-stated reset instant for a fault, when the TEXT alone can resolve it.
//
// `faultAtMs` is the instant the provider WROTE the message, and every caller must anchor on it
// rather than on "now": "resets 5:50pm" means the first 5:50pm after the provider said so, and
// re-anchoring on the current time would roll the answer to TOMORROW's 5:50pm the moment the real one
// passed — a deadline that runs away from you and never arrives.
//
// GATED TO THE 5-HOUR WINDOW ON PURPOSE. The message carries a time of day but no DATE, so it is only
// unambiguous when the window is guaranteed to roll within a day. A 5-hour window always is. A WEEKLY
// window is NOT — verified in this account's own corpus, where a weekly stop at 16:27 PDT read "resets
// 4pm", a time already past that day — so reading it as today's 4pm would fire every paused agent
// straight back into an exhausted account. Weekly faults resolve from the usage endpoint instead.
export function textResetInstant(c: LimitClassification, faultAtMs: number): number | undefined {
  if (c.window !== "session") return undefined
  if (!c.resetClock) return undefined
  if (!Number.isFinite(faultAtMs)) return undefined
  const at = resolveResetInstant(c.resetClock, faultAtMs)
  if (at === undefined) return undefined
  // A 5-hour window cannot reset more than 5 hours after the stop. A parse implying more than that (a
  // mis-read meridiem, a zone surprise) is rejected rather than trusted — better no auto-resume than
  // one scheduled 20 hours late.
  return at - faultAtMs > 5 * 60 * 60_000 ? undefined : at
}

// ---- The LATCH: why a resume sometimes needs a whole new process ----------------------------------
//
// A `claude` process that takes a usage-limit 429 LATCHES on it. Every later input is refused by the
// PROCESS, locally: it answers in ~1s with a byte-identical synthetic record naming the same reset
// clock, without reaching the API at all. Nothing delivered over the existing session clears it —
// not a "continue", not a fresh credential.
//
// Measured live 2026-07-30 on a five-thread fleet. The operator's credential rotator swapped in an
// account with 99% headroom at 17:05:54Z; the same processes went on emitting `resets 11:20am` at
// 17:06, 17:08, 17:10, 17:12, 17:15 and 17:17, while a brand-new `claude -p` on that same repaired
// credential answered normally in the same minute. Killing the process and cold-resuming its
// transcript brought every one of them straight back.
//
// This is why the auto-resume feature worked for as long as its only trigger was the reset clock: by
// the time that clock passes, the process's own latch has expired too, so poking the live session is
// enough. The account-HEADROOM trigger broke that alignment — it exists precisely to resume EARLY,
// off a fresh sign-in or a rotated account, at a moment the latch is still holding. An early resume
// is therefore deliverable only into a process that has never seen the 429.
//
// Returns true when this fault's resume must restart the runtime rather than steer the live one.
export function limitResumeNeedsFreshProcess(
  fault: Pick<LimitFault, "window" | "at" | "resetClock">,
  nowMs: number,
): boolean {
  const resumesAt = faultResetInstant(fault)
  // No resolvable instant — a weekly clock never resolves from text, so that resume rides the usage
  // endpoint's window roll and we cannot prove the latch has expired. Restart rather than deliver
  // into a process that may still be refusing everything.
  if (resumesAt === undefined) return true
  return nowMs < resumesAt
}

/**
 * Whether a thread MAY have background work in flight. Unknown counts as YES.
 *
 * This feeds needsFreshProcessForLimit, whose whole job is the invariant stated at the restart verb:
 * frizz "declines to kill a live child when FRIZZ is the one deciding to restart" (an operator asking
 * outright is a different case and still kills them, deliberately).
 *
 * The call sites used to read `(tailer.get(slug)?.subAgents ?? []).some(running)`, which silently
 * turns "I have no state for this thread" into "this thread has no background work" — the two
 * readings a safety guard must never confuse. On 2026-08-06 a 566MB transcript could not be primed,
 * so the tailer had NO state for the busiest thread on the machine, the guard read false, and the
 * daemon was retired mid-flight — killing seven background sub-agents whose reports were never
 * delivered. A read failure produced a confident wrong answer that then drove a destructive action.
 *
 * So it fails CLOSED. The cost of a false positive is a limit-paused thread that waits for the
 * operator instead of auto-resuming; the cost of a false negative is the work they already lost.
 * Background SHELLS count too — they were never checked at all, and a running shell is exactly as
 * live as a running sub-agent.
 */
export function mayHaveLiveBackgroundWork(
  state:
    | { subAgents?: { state: string }[]; bgShells?: { state: string }[] }
    | undefined,
): boolean {
  // The distinction that matters is whether the tailer knows this thread AT ALL. A state object that
  // simply omits one of the arrays is shape variance, not a read failure, so it contributes nothing.
  if (!state) return true // no state is not evidence of no work
  return (
    (state.subAgents ?? []).some((agent) => agent.state === "running") ||
    (state.bgShells ?? []).some((shell) => shell.state === "running")
  )
}

/**
 * Does a follow-up aimed at this thread have to land in a NEW `claude` process?
 *
 * Yes exactly when the thread's tail still carries a usage-limit fault whose reset instant has not
 * arrived: the running process latched on that 429 and will refuse this message — and every later one
 * — until then, so delivering into it is a guaranteed no-op (the latch is measured above).
 * Shared by the scheduler's auto-resume and the followUp RPC behind the card's "Continue now", because
 * both are the same act: asking a walled-off thread to carry on.
 *
 * A thread with LIVE background work is deliberately exempt. A restart kills the in-memory sub-agents,
 * and frizz's completion invariant says an agent runs to its terminal return; a parent whose child is
 * still producing is not the wedged case this exists for.
 */
export function needsFreshProcessForLimit(
  fault: LimitFault | undefined,
  nowMs: number,
  liveBackgroundWork = false,
): boolean {
  if (!fault || liveBackgroundWork) return false
  return limitResumeNeedsFreshProcess(fault, nowMs)
}

// One stable key per "wall the provider put this thread behind". Two faults that name the SAME reset
// instant are the same wall — the second is just the thread bouncing off it again — so anything that
// must happen once per wall (see the scheduler's early-resume guard) keys on this rather than on
// `fault.at`, which changes on every bounce.
export function limitFaultResetKey(fault: Pick<LimitFault, "window" | "at" | "resetClock">): string {
  const resumesAt = faultResetInstant(fault)
  return `${fault.window}:${resumesAt ?? "unresolved"}`
}

// The provider-stated reset instant for a fault, anchored on the fault itself (never on `now` — see
// textResetInstant). `undefined` when the text cannot resolve one.
function faultResetInstant(fault: Pick<LimitFault, "window" | "at" | "resetClock">): number | undefined {
  const at = Date.parse(fault.at)
  if (!fault.resetClock || !Number.isFinite(at)) return undefined
  return textResetInstant({ window: fault.window, resetClock: fault.resetClock }, at)
}

// How long a paused thread stays auto-resumable AFTER its window was due back. This is the boot
// guard: a server starting days later replays every transcript from byte zero and would otherwise see
// a fleet of old limit faults and wake them all at once, long after the operator moved on.
//
// Measured from when the pause became RESUMABLE, not from the interruption — those differ by up to a
// whole week. A weekly window can reset seven days after it cut a thread off, so a flat age-since-
// interruption cap would have made weekly auto-resume structurally impossible while looking perfectly
// reasonable in the code. (Caught by the weekly scheduler test, which fired zero wakes.)
export const LIMIT_RESUME_GRACE_AFTER_RESET_MS = 36 * 60 * 60_000

// The longest a window can stay closed after cutting a thread off, per window kind. A model-scoped
// cap is a weekly window on the endpoint (`weekly-<model>`), so it shares the weekly budget.
const MAX_CLOSED_MS: Record<LimitWindow, number> = {
  session: 5 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
  model: 7 * 24 * 60 * 60_000,
  unknown: 5 * 60 * 60_000,
}

// Has this pause aged past the point where waking it is still what the operator would want? Shared by
// the board (which renders the promise) and the waker (which keeps it), so a card can never advertise
// an auto-resume the scheduler has already written off.
export function limitPauseIsStale(window: LimitWindow, faultAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(faultAtMs)) return true
  return nowMs - faultAtMs > MAX_CLOSED_MS[window] + LIMIT_RESUME_GRACE_AFTER_RESET_MS
}

// ---- Recovery, read off the provider's own usage endpoint ------------------------------------------
// The span of each metered window, used to derive when the CURRENT window began.
const WINDOW_SPAN_MS: Record<string, number> = {
  "5h": 5 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
}

// One quota window as the snapshot reports it (structurally what `QuotaWindow` gives us).
export interface QuotaWindowLike {
  key: string
  resetsAt?: number // unix seconds
  usedPercent?: number // 0..100 — read by the scheduler's headroom trigger on a scoped window
}

// Has the window that cut this thread off ROLLED since it did?
//
// The test is deliberately NOT "utilization dropped below some threshold" — that needs a magic number
// and a near-100 reading would resume straight into the wall. Instead it compares WINDOW IDENTITY: the
// currently-reported window began at `resetsAt - span`, so if that start is later than the fault, the
// window the fault belonged to is over. Exact, threshold-free, restart-proof (it re-derives from a
// single live read rather than anything we had to persist at fault time) — and inherently loop-proof,
// since a thread that resumes and immediately re-limits produces a NEW fault inside the CURRENT
// window, which by construction reads as not-yet-recovered.
//
// Returns undefined when the snapshot can't answer (unavailable, window absent, no reset instant) —
// indeterminate, so the caller waits rather than guessing in either direction.
export function quotaWindowRecovered(
  windows: readonly QuotaWindowLike[],
  window: LimitWindow,
  faultAtMs: number,
  nowMs: number,
): boolean | undefined {
  const key = quotaWindowKeyFor(window)
  if (!key) return undefined
  const span = WINDOW_SPAN_MS[key]
  const w = windows.find((x) => x.key === key)
  if (!w || typeof w.resetsAt !== "number" || !Number.isFinite(w.resetsAt) || !span) return undefined
  const resetsAtMs = w.resetsAt * 1000
  // A reset instant already in the past means the window ended and nothing has restarted it yet.
  if (resetsAtMs <= nowMs) return true
  if (!Number.isFinite(faultAtMs)) return undefined
  return resetsAtMs - span > faultAtMs
}

// Map a limit window onto the quota snapshot's window key, so a fault can read its exact reset epoch
// off the provider's own usage endpoint when the text can't supply one. A MODEL-scoped fault has no
// static key — its window is found by name (scopedQuotaWindow).
export function quotaWindowKeyFor(window: LimitWindow): string | undefined {
  if (window === "session") return "5h"
  if (window === "weekly") return "weekly"
  return undefined
}

// Resolve a MODEL-scoped fault to its usage-endpoint window. The endpoint keys a scoped weekly as
// `weekly-<slug of the model's display_name>` (claude-quota.ts windowFromLimit); the fault carries the
// LIMIT MESSAGE's name for the same model — and the two spellings differ on the real account
// (message: "Fable 5" → `fable-5`; endpoint display_name: "Fable" → key `weekly-fable`). So the match
// is token-prefix in either direction, never equality. Falls back to the SINGLE scoped weekly when
// exactly one exists (an account is only ever capped per-model on the model tier it actually has);
// with several scoped windows and no name match, undefined — indeterminate, never a guess.
export function scopedQuotaWindow(
  windows: readonly QuotaWindowLike[],
  model: string | undefined,
): QuotaWindowLike | undefined {
  const scoped = windows.filter((w) => w.key.startsWith("weekly-"))
  if (scoped.length === 0) return undefined
  const slug = model ? model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : ""
  if (slug) {
    const hit = scoped.find((w) => {
      const suffix = w.key.slice("weekly-".length)
      return slug === suffix || slug.startsWith(`${suffix}-`) || suffix.startsWith(`${slug}-`)
    })
    if (hit) return hit
  }
  return scoped.length === 1 ? scoped[0] : undefined
}

// The identity-roll test for a MODEL-scoped fault — the same threshold-free window-identity logic as
// quotaWindowRecovered, against the scoped weekly window (span: 7 days) instead of a static key.
// Returns undefined when the endpoint can't answer (no scoped window, no reset instant) — wait, don't
// guess. The scoped window's HEADROOM is deliberately not read here; that is the scheduler's separate
// early-resume trigger, with its own floor and once-per-wall guard.
export function scopedQuotaWindowRecovered(
  windows: readonly QuotaWindowLike[],
  model: string | undefined,
  faultAtMs: number,
  nowMs: number,
): boolean | undefined {
  const w = scopedQuotaWindow(windows, model)
  if (!w || typeof w.resetsAt !== "number" || !Number.isFinite(w.resetsAt)) return undefined
  const span = WINDOW_SPAN_MS.weekly
  const resetsAtMs = w.resetsAt * 1000
  if (resetsAtMs <= nowMs) return true
  if (!Number.isFinite(faultAtMs)) return undefined
  return resetsAtMs - span > faultAtMs
}
