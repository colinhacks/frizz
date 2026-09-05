import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, randomUUID } from "node:crypto"
import { PARK_CORRECTION_NAMES_LEAD, PARK_CORRECTION_QUESTION_LEAD, PARK_CORRECTION_RETIRED_LEAD, parkExpiredWakeMessage, parkFinishedWakeMessage, prWatchExpiredWakeMessage, ownWatchExpiredWakeMessage, questionAnswerMessage, questionsCancelledWakeMessage, type QuestionAnswer, type QuestionDismissal, RETIRED_AWAITING_REPLACEMENT, retiredAwaitingKindsIn, compactionPromptMessage, limitResumeSteer, limitModelSwitchSteer, formatGithubWakeSteer, GithubWakeItem, type GithubWatchStatus, prWatchWakeMessage, shellDoneMessage, restPromptMessage, schedulePromptMessage, timerPromptMessage, signoffNudgeMessage, liveOpsLines, wakeDeliveryToken, wakeTimeHeader, stripWakeTimeHeader, type QuotaSnapshot } from "@frizz/shared"
import { GITHUB_STATUS_SETTING, parkExpiresAt, parkIsHonoured, readAwaitingPark, unaccountedItems, type LiveActivity } from "./awaiting.ts"
import type { SessionRow, Storage, ThreadQuestionRow } from "./storage.ts"
import type { Tailer } from "./tailer.ts"
import type { SessionTelemetry } from "./tailer.ts"
import type { LimitFault } from "./backend/types.ts"
import { limitFaultResetKey, limitPauseIsStale, mayHaveLiveBackgroundWork, quotaWindowKeyFor, quotaWindowRecovered, scopedQuotaWindow, scopedQuotaWindowRecovered, textResetInstant } from "./backend/usage-limit.ts"
import { claudeFallbackModel, claudeModelFromLimitName, claudeProfile, normalizeObservedThreadModel } from "./backend/thread-profiles.ts"
import { createWakeDeliveryStore, WAKE_QUIET_WINDOW_MS, type WakeDelivery } from "./wake-store.ts"
// The board owns the registered-done lifetime rule, and the waker must read it by exactly the same rule
// or the two disagree about whether a thread is finished.
import { answersInFlight, registeredDoneFence, safeQuestionAnswer, safeQuestionSpec } from "./board.ts"
import { ProducerStoppedError } from "./shutdown.ts"
import { completionsDueForRelay, relayMessage } from "./completion-relay.ts"
import {
  createGithubReviewFetcher,
  isBotGithubActor,
  parseGithubReviewActivities,
  type GithubReviewActivity,
  type GithubReviewFetchResult,
} from "./github-review.ts"
import { isNoisePrActivity } from "./pr-watch-noise.ts"

const execFileAsync = promisify(execFile)

export {
  isBotGithubActor,
  parseGithubReviewActivities,
  type GithubReviewActivity,
} from "./github-review.ts"
import { log as frizzLog } from "./logging.ts"

// ---- THE DURABLE WAKER ---------------------------------------------------------------------------
// NOTHING IN AN ```awaiting FENCE WAKES A THREAD. A fence STATES what a thread is waiting on; every
// wait frizz can actually fire is a REGISTRATION the worker made through a tool — a `thread_timer` row
// (`mcp__frizz__timer`), a `pr_watch` row (`mcp__frizz__watch_pr`, SOURCE 11), a background shell's own
// telemetry — or a condition the server itself observes: a provider limit lifting, a human's snooze
// coming due, a recurring prompt's schedule, a rest with nothing declared. The limb that polled
// `pr-watch:`/`pr:`/`ci:`/`timer:` hints out of the fence was hardwired off by the 2026-08-15 grammar
// cut and deleted on 2026-08-24, because a line frizz cannot check is a wait that can silently never
// resolve. Any other automated wait should stay ACTIVE instead, through Bash/Monitor (Claude) or a
// blocking exec wait (Codex).
//
// ---- THE BOOT-MASS-FIRE SAFETY GUARD (critical — the maintainer has ~14 real sessions) ----
// We fire ONLY on a wait REGISTERED with this scheduler, and every registration is persisted before it
// can fire — so a timer crossing or PR activity during downtime still wakes after a restart, while a
// thread that merely inherited an old transcript has registered nothing and therefore wakes nothing.
// Once a condition fires, a deterministic SQLite outbox row is committed BEFORE terminal delivery.
// Atomic leases serialize multiple scheduler instances; delivery acknowledgement, transcript-token
// confirmation, and per-source supersession produce explicit terminal states. A crash leaves
// pending/leased work recoverable instead of burning a fired bit before the wake reached the worker.

export interface PrRef {
  owner: string
  repo: string
  number: number
}

// The distilled PR status we act on (from one `gh pr view … --json state,mergedAt,statusCheckRollup`).
export interface PrStatus {
  state: string // OPEN | CLOSED | MERGED
  mergedAt: string | null
  rollup: RollupEntry[] // statusCheckRollup entries (CheckRun and/or StatusContext shapes)
  // GitHub's own merge verdict, as the merge box states it. MERGEABLE | CONFLICTING | UNKNOWN, plus the
  // review gate (APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | "") — the two facts behind "can this
  // actually land", which the card renders and the queue rule reads.
  mergeable?: string
  reviewDecision?: string
  /** The head commit the rollup describes. Fetched all along to query workflow runs, and now KEPT: a
   *  verdict is only news against the commit it was reached on (see the pr-watch cursor). */
  head?: string
  // Workflow runs queried by the PR's exact head SHA. statusCheckRollup can omit a fork-gated
  // ACTION_REQUIRED run, so the exact-head runs are what let a watcher NAME the jobs that went red.
  //
  // ONLY THE `gh` FALLBACK FILLS THIS. The batched GraphQL poll reads the head's CHECK SUITES in the
  // same request instead (`checkSuites` below) — the same facts, one round trip, no subprocess.
  workflowRuns?: WorkflowRun[]
  /** The head's check suites, from the batched poll. Same role as `workflowRuns` and the same shape as
   *  far as anything here reads it: a conclusion and a workflow name. */
  checkSuites?: WorkflowRun[]
  /** Everything else the one query now brings back, for the triggers that read PR state rather than CI.
   *  Absent on the `gh` fallback, which does not ask for them. */
  labels?: string[]
  reviewRequests?: string[]
}

export interface WorkflowRun {
  name?: string
  workflowName?: string
  status?: string
  conclusion?: string | null
  databaseId?: number
  event?: string
  createdAt?: string
}

interface RollupEntry {
  status?: string // CheckRun: QUEUED | IN_PROGRESS | COMPLETED | PENDING | WAITING
  conclusion?: string // CheckRun: SUCCESS | FAILURE | NEUTRAL | CANCELLED | TIMED_OUT | ACTION_REQUIRED | SKIPPED | STALE
  state?: string // StatusContext: PENDING | SUCCESS | FAILURE | ERROR | EXPECTED
  name?: string // CheckRun's job name
  context?: string // StatusContext's context label
  workflowName?: string // CheckRun's parent workflow, when GitHub reports one
  // The two fields that make one FAILURE EVENT distinguishable from the next. `detailsUrl` carries the
  // run and job ids (`/actions/runs/<run>/job/<job>`), so a re-run of the same job on the same commit is
  // a different URL — which is exactly what "this failed AGAIN" has to be keyed on.
  detailsUrl?: string // CheckRun's job URL
  targetUrl?: string // StatusContext's equivalent
  completedAt?: string
}

// THE IDENTITY OF THE CURRENT FAILURES, so "CI is red" can be told apart from "CI is red AGAIN".
//
// A verdict word cannot express a second failure, and neither can the head commit alone: CI fails, the
// job is re-run on the SAME commit and fails again, or a slower job goes red minutes after the first —
// all real, all news, and all invisible to `failing === failing`. This digests what is failing RIGHT NOW
// into one short string, so any change in the failing set is a change in the stamp.
//
// Keyed on the job URL first because it carries the run and job ids and therefore changes on a re-run;
// `completedAt` is the fallback for a StatusContext that has no such URL, and the name alone is the last
// resort. Hashed because a rollup can carry 60+ entries and this string lives in a cursor column.
export function failureSignature(rollup: RollupEntry[]): string {
  const ids: string[] = []
  for (const c of Array.isArray(rollup) ? rollup : []) {
    if (!c || typeof c !== "object") continue
    if (!rollupEntryFailed(typeof c.conclusion === "string" ? c.conclusion : undefined, typeof c.state === "string" ? c.state : undefined)) continue
    const label = c.name ?? c.context ?? c.workflowName ?? "?"
    ids.push(`${label}@${c.detailsUrl ?? c.targetUrl ?? c.completedAt ?? ""}`)
  }
  if (ids.length === 0) return ""
  // SORTED, because GitHub's rollup order is not stable and an order flip is not a new failure.
  return createHash("sha1").update(ids.sort().join("\n")).digest("hex").slice(0, 12)
}

// Parse a PR reference: `owner/repo#123` or a GitHub PR URL. Undefined when neither shape matches
// (e.g. an actions-run URL with no PR number). Duplicated from `awaiting.ts`, which the board and the
// router parse with — the two are byte-identical and worth collapsing, but that is its own change.
const PR_REF_RE = /(?:https?:\/\/github\.com\/)?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\/pull\/|\/pulls\/|#)(\d+)/
export function parsePrRef(value: string): PrRef | undefined {
  const m = value.trim().match(PR_REF_RE)
  if (!m) return undefined
  const number = parseInt(m[3], 10)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number }
}

// `gh pr view` does not accept owner/repo#N as its positional selector. Pin the CLI-compatible shape:
// numeric selector plus an explicit repository. Kept pure/exported so a regression cannot silently
// turn every healthy watcher poll into an "unavailable" result again.
export function ghPrViewArgs(ref: PrRef): string[] {
  return ["pr", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", "state,mergedAt,statusCheckRollup,headRefOid,mergeable,reviewDecision"]
}

// Reduce a statusCheckRollup to a terminal verdict. `done` = every check has reached a terminal state
// (nothing queued/in-progress/pending); `ok` = none concluded in failure. An EMPTY rollup is treated as
// still-pending: no check has reported yet, which is not the same answer as green.
//
// This is the REFERENCE reading of a rollup. `githubWatchStatus` below re-derives the same verdict
// beside its counts rather than calling it, so this stays exported and unit-tested as the thing that
// reading must not be allowed to drift from.
//
// IT READS THE ROLLUP AND NOTHING ELSE, which is a real limit and not an oversight: a workflow held at
// `action_required` for a maintainer's approval produces NO check run, so it is absent from the rollup
// entirely and `done` here says true over CI that has not started. `githubWatchStatus` is given the
// head's workflow runs as well and can see it; this cannot. Anything that needs the true verdict must
// go through that one.
export function evalRollup(rollup: RollupEntry[]): { done: boolean; ok: boolean } {
  if (!Array.isArray(rollup) || rollup.length === 0) return { done: false, ok: false }
  let pending = false
  let failed = false
  for (const c of rollup) {
    if (!c || typeof c !== "object") continue
    const status = typeof c.status === "string" ? c.status : undefined
    const conclusion = typeof c.conclusion === "string" ? c.conclusion : undefined
    const state = typeof c.state === "string" ? c.state : undefined
    // An entry is terminal ONLY if it AFFIRMATIVELY says so: a CheckRun with status COMPLETED, or a
    // StatusContext whose state is a settled value. An entry we can't classify (no recognizable
    // status/state — a `{}` or a future/unknown shape) is treated as still-PENDING, never as
    // done+green — so a shape surprise can never launder an unknown check into a false "green" verdict.
    const terminal = status ? status === "COMPLETED" : state ? state !== "PENDING" && state !== "EXPECTED" : false
    if (!terminal) pending = true
    if (rollupEntryFailed(conclusion, state)) failed = true
  }
  return { done: !pending, ok: !failed }
}

// The single definition of "this check concluded badly", shared by the pass/fail verdict and by the
// steer that NAMES the failures — so the wake can never say "CI failed" and then list nothing.
function rollupEntryFailed(conclusion: string | undefined, state: string | undefined): boolean {
  return (
    conclusion === "FAILURE" ||
    conclusion === "TIMED_OUT" ||
    conclusion === "CANCELLED" ||
    conclusion === "ACTION_REQUIRED" ||
    conclusion === "STARTUP_FAILURE" ||
    state === "FAILURE" ||
    state === "ERROR"
  )
}

// A check that reached a terminal state without asserting anything — GitHub's own `SKIPPED` (a path
// filter or an `if:` that did not match) and `STALE` (superseded before it ran). Neither is a failure,
// so neither may make the rollup pending; neither is evidence of a green build either, so neither may
// be counted as a pass. Both were counted as passes until 2026-09-04, which is half of how "15 checks
// green" got said about a commit nothing had built (see below).
function rollupEntrySkipped(conclusion: string | undefined): boolean {
  return conclusion === "SKIPPED" || conclusion === "STALE"
}

// WORKFLOWS HELD FOR A MAINTAINER'S APPROVAL, named. `action_required` on a workflow RUN is GitHub's
// "Approve and run" gate — the default for a first-time contributor and for any fork PR in a repo that
// requires approval. The gated run produces no check run at all, so nothing about it reaches the
// rollup: `statusCheckRollup` simply does not mention the eight workflows that are waiting.
//
// That is the other half of the false green. On nodejs/node#65795 (2026-09-04 15:12Z) the head carried
// 8 gated workflows — Test Linux, Test macOS, Linters, Coverage Windows, Build from tarball — and a
// rollup of 15 entries that were 12 `SKIPPED` no-ops plus 3 label bots. Every entry present was
// terminal and none had failed, so the poll reported "✅ CI PASSED — 15 checks green" about a commit
// whose real 29-check matrix had not been allowed to start and never did run on it.
//
// Frizz was already fetching the answer: `defaultFetchPr` lists the head's workflow runs to name failed
// jobs, and the gated ones are in that same list. `failedCheckNames` skips them because a pending
// approval is not a failure, which is right — but until this they were then dropped on the floor rather
// than reported as the distinct, and very actionable, state they are.
export function gatedWorkflowNames(runs: WorkflowRun[] = [], cap = 8): { names: string[]; total: number } {
  const names: string[] = []
  const seen = new Set<string>()
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== "object") continue
    if (run.conclusion !== "ACTION_REQUIRED") continue
    const name = (run.workflowName ?? run.name)?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return { names: names.slice(0, cap), total: names.length }
}

// Which checks actually failed. "❌ CI failed on owner/repo#N" told a worker only that SOMETHING went
// red, so its first move was always another `gh pr checks` round-trip; naming the jobs it must look at
// costs nothing here and saves that turn. Deduplicated and bounded — a red matrix can be 40 entries.
export function failedCheckNames(rollup: RollupEntry[], runs: WorkflowRun[] = [], cap = 8): { names: string[]; omitted: number } {
  const names: string[] = []
  const seen = new Set<string>()
  const push = (raw: string | undefined) => {
    const name = raw?.trim()
    if (!name || seen.has(name)) return
    seen.add(name)
    names.push(name)
  }
  for (const c of Array.isArray(rollup) ? rollup : []) {
    if (!c || typeof c !== "object") continue
    if (!rollupEntryFailed(typeof c.conclusion === "string" ? c.conclusion : undefined, typeof c.state === "string" ? c.state : undefined)) continue
    push(c.name ?? c.context ?? c.workflowName)
  }
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== "object") continue
    // An unapproved fork run reads ACTION_REQUIRED but is a pending approval, not a failure, so it
    // must not be listed as a failed job.
    if (run.conclusion === "ACTION_REQUIRED") continue
    if (!rollupEntryFailed(run.conclusion ?? undefined, undefined)) continue
    push(run.workflowName ?? run.name)
  }
  return { names: names.slice(0, cap), omitted: Math.max(0, names.length - cap) }
}

// ---- WHAT A WATCHED PR'S CHECKS LOOK LIKE FROM OUTSIDE ------------------------------------------
// The `gh pr view` rollup, projected into the shape GitHub's own merge box states — because it DECIDES
// A QUEUE RULE and not just a readout (maintainer 2026-08-14: "if there is a GitHub watcher registered
// and the GitHub actions are still running, then that should remain in the running active rail. Only if
// CI has failed or completed successfully should it show up back in the queue").
//
// `none` and `running` are deliberately different answers. An EMPTY rollup means no check has reported
// yet, which `evalRollup` already treats as pending — but a PR with no CI at all would then wait
// forever for checks that are never coming, so the two are split here: `none` lets the thread queue
// immediately, `running` is what parks it.
//
// A PASS NOW REQUIRES SOMETHING TO HAVE ACTUALLY PASSED, and nothing may be waiting for approval
// (2026-09-04). Both halves are the same defect read twice: the old reading answered "did anything
// present go red?" when the question is "did this commit get built?". Skips and label bots are not a
// build, and a workflow nobody has approved has not run. `gated` folds into `running` rather than
// earning a fifth verdict word — the queue rule (board.ts, groups.ts) asks only whether CI has SETTLED,
// and a gated PR has not — but it is counted and named separately, because "waiting for a maintainer to
// press Approve and run" is a different instruction to the worker than "wait".
export function githubWatchStatus(pr: PrStatus, polledAt: string): GithubWatchStatus {
  const entries = Array.isArray(pr.rollup) ? pr.rollup.filter((c) => c && typeof c === "object") : []
  let running = 0
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const c of entries) {
    const status = typeof c.status === "string" ? c.status : undefined
    const state = typeof c.state === "string" ? c.state : undefined
    const conclusion = typeof c.conclusion === "string" ? c.conclusion : undefined
    // Terminal ONLY if it AFFIRMATIVELY says so, exactly as `evalRollup` reads it: an unrecognizable
    // entry counts as still running, never as quietly green.
    const terminal = status ? status === "COMPLETED" : state ? state !== "PENDING" && state !== "EXPECTED" : false
    if (!terminal) running++
    else if (rollupEntryFailed(conclusion, state)) failed++
    else if (rollupEntrySkipped(conclusion)) skipped++
    else passed++
  }
  // The batched poll's check suites, or the `gh` fallback's workflow runs — whichever this reading came
  // from. They answer the same two questions (what is gated, what went red outside the rollup) with the
  // same two fields, so everything downstream reads one list and never asks which fetch produced it.
  const aux = pr.checkSuites ?? pr.workflowRuns ?? []
  const gate = gatedWorkflowNames(aux)
  const state = pr.state === "MERGED" ? "merged" as const : pr.state === "CLOSED" ? "closed" as const : "open" as const
  // FAILING WINS OVER GATED. A red job is news the worker acts on now; an unapproved workflow beside it
  // is context, and it is carried in `gating` either way rather than deciding the verdict.
  const checks: GithubWatchStatus["checks"] =
    failed > 0 ? "failing"
    : running > 0 || gate.total > 0 ? "running"
    : passed > 0 ? "passing"
    : "none" // no rollup at all, or one that is entirely skips: nothing has run and nothing is coming
  // MERGEABILITY, in GitHub's own three words plus the review gate. `blocked` is deliberately coarse:
  // a required review and a failing required check are reported the same way, and frizz has no business
  // claiming to tell them apart.
  const merge: GithubWatchStatus["merge"] =
    pr.mergeable === "CONFLICTING" ? "conflicting"
    : pr.mergeable !== "MERGEABLE" ? "unknown"
    : checks === "failing" || pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED" ? "blocked"
    : "mergeable"
  return {
    checks,
    running,
    passed,
    failed,
    skipped,
    gated: gate.total,
    gating: gate.names,
    failing: failedCheckNames(entries, aux).names,
    merge,
    state,
    polledAt,
    head: pr.head,
    failureSig: failureSignature(entries),
  }
}

function wakeDeliveryId(slug: string, sessionId: string, fenceId: string): string {
  return createHash("sha256").update(slug).update("\0").update(sessionId).update("\0").update(fenceId).digest("hex")
}

// ---- SOURCE 2: SUBSCRIPTION-LIMIT AUTO-RESUME -----------------------------------------------------
// The waker's other wake source. Where the fence source asks "did the wait this agent DECLARED come
// true?", this one asks "did the wall the provider put in front of this agent come down?" — and the
// set of agents behind that wall needs no registry, because the tailer's `limitFault` standing on a
// thread's tail IS the record that this agent was mid-turn when the window ran dry. It clears the
// instant any user record lands, so the "continue" we deliver erases the very fault that selected the
// thread: one wake per interruption, with no bookkeeping to drift.
//
// Both sources share ONE durable outbox (lease → deliver → ack, backend-aware delivery, retry with
// exponential backoff, supersession). Only the identity differs, and these two prefixes are what keep
// a limit wake and a fence wake for the same session from ever colliding on a delivery id.
const LIMIT_FENCE_PREFIX = "limit"
const LIMIT_HINT_PREFIX = "limit:"
// Deliberate slack past the provider's stated reset. Their clock and ours are not the same clock, and
// resuming a whole fleet one second early just re-hits the wall and burns every thread's wake.
const LIMIT_RESUME_GRACE_MS = 60_000

// The ACCOUNT-AVAILABILITY resume trigger (independent of the original window's own clock): a
// limit-paused thread also resumes when the blown window is no longer near-full on the CURRENTLY
// signed-in account — a fresh sign-in or a raised cap frees up quota the original clock knows nothing
// about. Two stateless guards keep it from resuming straight back into the wall:
//   • the FLOOR — a limit fault only happens at ~100% of the window, so requiring the current reading to
//     sit at/below 85% is the genuine down-edge while ignoring tick-to-tick jitter near 100%.
//   • the MIN FAULT AGE — the served quota reading can lag the fault by up to its cache TTL, and during
//     a fast fleet burn the window climbs 85→100 in well under a minute, so a reading OLDER than the
//     fault could still show pre-burn headroom. Only trusting the signal once the fault is comfortably
//     older than that staleness guarantees the reading POST-dates the fault (a real recovery), not a
//     stale pre-fault value. It adds no delay to the real case — an account switched hours after the
//     fault clears this instantly — it only holds off the first couple of minutes.
const LIMIT_RESUME_HEADROOM_PERCENT = 85
const LIMIT_HEADROOM_MIN_FAULT_AGE_MS = 2 * 60_000

// The generation id for one interruption. The limit record's timestamp is what makes it a generation:
// a thread that resumes and gets cut off AGAIN produces a later `at`, hence a different delivery id,
// hence its own single wake.
function limitFenceId(fault: LimitFault): string {
  return `${LIMIT_FENCE_PREFIX}${fault.at}`
}
function isLimitFenceId(fenceId: string): boolean {
  return fenceId.startsWith(LIMIT_FENCE_PREFIX)
}

// The message the resumed worker actually receives now lives in @frizz/shared (imported above), beside
// its parser and every other wake formatter — the chat rebuilds this delivery's hairline from the
// delivered text alone, so the pair has to sit in the one package both sides can reach.

// ---- SOURCE 4: DROPPED SUB-AGENT REPORT REPAIR ---------------------------------------------------
// Where the limit source asks "did the wall come down?", this one asks "is this agent missing findings
// it believes it already has?" — and like that one it needs no registry, because the tailer's
// `droppedReports` standing on a thread's tail IS the record (see report-delivery.ts for the corpus:
// 242 of 498 completed sub-agent reports on one production thread reached the runtime's queue and
// never reached the model).
//
// It rides the same durable outbox as the other three, which is the whole reason to put it here rather
// than in a bespoke timer: lease → deliver → ack, retry with backoff, and — the load-bearing part —
// a delivery id of hash(slug, sessionId, fenceId). With the TASK ID as the generation, one dropped
// report can produce exactly ONE repair for a session, no matter how many ticks observe it. Re-nagging
// an agent about the same lost report every minute would be its own denial of service.
const REPORT_FENCE_PREFIX = "report"
const REPORT_HINT_PREFIX = "report:"

function reportFenceId(taskId: string): string {
  return `${REPORT_FENCE_PREFIX}:${taskId}`
}
function isReportFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${REPORT_FENCE_PREFIX}:`)
}

// ---- SOURCE 3: THE USER SNOOZE ------------------------------------------------------------------
// A snooze that carries a prompt is the human's own `awaiting timer:` — park until an instant, then
// resume with a message — differing only in WHO authored the message. So it wakes over this same
// outbox rather than a private timer of its own, inheriting crash-safety, retry/backoff, supersession
// and every-backend delivery for free.
//
// Its record of intent is the session row itself (`snoozed_until` + `snooze_prompt`), exactly as the
// limit source's record is the tail's limit fault. That is why `clearExpiredSnoozes` deliberately
// leaves a prompt-carrying snooze standing past its deadline: the row must outlive the crossing so a
// wake-now, a human follow-up, or a re-snooze can be READ here as supersession. It is cleared only
// once this wake reaches a terminal state — and only while it still matches the delivery it armed.
//
// The prompt is delivered VERBATIM, with no "⏰ your snooze fired" preamble: the human scheduled a
// follow-up, so the worker should receive precisely the turn they wrote, not a paraphrase of it.
const SNOOZE_FENCE_PREFIX = "snooze"
const SNOOZE_HINT_PREFIX = "snooze:"

// The prompt is part of the generation id, not just the instant: editing the follow-up on an
// already-due snooze must mint a NEW delivery rather than collide with the enqueued one's message.
function snoozeFenceId(until: string, prompt: string): string {
  const digest = createHash("sha256").update(prompt).digest("hex").slice(0, 16)
  return `${SNOOZE_FENCE_PREFIX}:${until}:${digest}`
}
function isSnoozeFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${SNOOZE_FENCE_PREFIX}:`)
}

interface ArmedSnooze {
  until: string
  untilMs: number
  prompt: string
  fenceId: string
}
// A row's CURRENT scheduled bump, if it has one. A snooze without a prompt is the historical reminder
// (the board owns its expiry) and never reaches the waker.
function armedSnooze(row: Pick<SessionRow, "snoozed_until" | "snooze_prompt">): ArmedSnooze | undefined {
  const until = row.snoozed_until
  const prompt = row.snooze_prompt?.trim()
  if (!until || !prompt) return undefined
  const untilMs = Date.parse(until)
  if (!Number.isFinite(untilMs)) return undefined
  return { until, untilMs, prompt, fenceId: snoozeFenceId(until, prompt) }
}

// ---- SOURCE 4: THE RECURRING PROMPT, ON SCHEDULE --------------------------------------------------
// SOURCES 4 and 5 are two TRIGGERS on ONE stored prompt (`recurring_*`), not two features. They stayed
// two scheduler passes through the merge because they genuinely do not fold together: this one keys its
// delivery id on (generation, beat index) and must NOT filter on rest, while SOURCE 5 keys on
// (generation, rest instant) and must. One pass with a mode flag would be both of them wearing an if.
//
// THE DUMB TRIGGER: a prompt on a chosen clock. It consults nothing about the thread — not rest, not
// `--awaiting`, not sub-agents, not shells. If the interval has elapsed, a delivery is queued, and it
// GOES OUT whether or not the thread is mid-turn (`isDeliverableNow`, which carries the transport
// detail). It is the only source that does not wait for rest, and that is the feature.
//
// It is the sibling of SOURCE 5, not a rival: the rest trigger asks "you stopped — is there more?" and
// only a thread that stops ever hears it; this one asks "it has been an hour" and a thread hears it an
// hour later, working or not. An operator who needs a thread revisited on a schedule regardless of what
// the agent is doing needs this one.
//
// It also remains the only recurring wake a worker CAN have. Claude Code's own `CronCreate` /
// `ScheduleWakeup` cannot fire in the runtime frizz spawns: their gate stays shut while ANY background
// task is outstanding, so the thread most in need of a nudge — one parked behind a sub-agent that will
// never report — is exactly the one whose cron is dead (measured 2026-08-01: 3 fires in 150s with no
// background work, 0 with a background shell alive). Riding frizz's outbox sidesteps that entirely.
//
// Its record of intent is the session row, with `recurring_armed_at` as the GENERATION: re-arming mints
// a new one, so a delivery still in the outbox under the old settings reads as superseded.
//
// It never ABORTS the turn it lands in. Both transports accept a mid-turn message as an ordinary
// queued/steered input, so the running work finishes and the prompt is read at the next sampling
// boundary — which is what "fires on its cadence" means, and is also the only reading compatible with
// frizz's completion invariant.
//
// THE FENCE PREFIXES ARE THE PRE-MERGE ONES, on purpose. They are internal delivery-id namespaces that
// nothing outside this file reads, and renaming them would reclassify every delivery already sitting in
// a live outbox as an unknown fence across the upgrade — real churn to buy a nicer string.
const HEARTBEAT_FENCE_PREFIX = "heartbeat"
const HEARTBEAT_HINT_PREFIX = "heartbeat:"

// The generation is (armed_at, beat index). The index advances only once the previous delivery is
// TERMINAL, so a thread accumulates exactly one pending scheduled prompt rather than one per interval —
// an agent handed an hour of backlog at once is its own denial of service.
function heartbeatFenceId(armedAt: string, beat: number): string {
  return `${HEARTBEAT_FENCE_PREFIX}:${armedAt}:${beat}`
}
function isHeartbeatFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${HEARTBEAT_FENCE_PREFIX}:`)
}

interface ArmedSchedule {
  prompt: string
  intervalMs: number
  armedAt: string
  /** When the next one becomes due: an interval after the last delivered one, else after arming. */
  dueAtMs: number
}

type RecurringRow = Pick<
  SessionRow,
  | "recurring_prompt" | "recurring_on_rest" | "recurring_on_schedule" | "recurring_on_compact"
  | "recurring_interval_ms" | "recurring_armed_at"
  | "recurring_rest_fired_at" | "recurring_schedule_fired_at" | "recurring_compact_fired_at"
>

// ---- WHAT A PENDING QUESTION DOES TO THE THREE TRIGGERS -------------------------------------------
// NOTHING, as of 2026-08-16. A Goal fires over an unanswered question fence, a native ask and a
// permission prompt alike, on every trigger, and there is no setting that changes it.
//
// THAT IS A DELETION, not a default flip. The row carried a `recurring_pause_on_questions` column and the
// footer panel showed it inverted as an "Autonomous mode" switch; both are gone. Maintainer 2026-08-16:
// "I feel like the stop hook should just fire even when there are open questions, unconditionally, and we
// could just drop the AutonomousMode toggle… If somebody enables the stop hook goal, then that kind of
// implies to me that they don't really want to answer any more questions." Arming a Goal IS the consent
// the switch used to collect, so collecting it twice only bought a way to get it wrong — and the hold's
// original job (a half-finished thread resting silently, with nobody to bring it back) belongs to the
// built-in sign-off nudge now (SOURCE 9), which fires on exactly the rests that need it.
//
// WHAT STILL STOPS A BUMP is `restMessageIsSignedOff` below, and it is about the FENCE rather than about
// questions: the stop hook asks "you stopped — is there more?", and a ```done or an ```awaiting on a wait
// somebody else owns has already answered it in the very message that ENDED the turn. Firing over either
// is the trigger talking to itself. A ```question fence used to be a third limb of that rule and no
// longer is — it is an answer only for a thread that is waiting on a human, and a thread carrying a Goal
// is not.
//
// Its two surviving limbs reach different distances. A ```done fence ends the arrangement, so it also
// stops the HEARTBEAT (`saidDone`) — it is the successor to the ALLDONE sentinel and inherits its reach
// exactly. A parked ```awaiting stops the stop hook alone: the heartbeat asks "it has been an hour" and
// the compaction trigger asks "your context is gone", and a PR nobody has reviewed is an answer to
// neither. A `human:` gate stays held for the same reason it always did — bumping one is measured harm
// (see `parkedOnAWaitItCannotAdvance`) and the fix for it is the operator, not a bump.
//
// THE BUMP THAT CROSSES A QUESTION SAYS SO. A worker handed the bare goal on top of its own unanswered
// question re-asks it, correctly — so `restPromptMessage(prompt, {overQuestion:true})` tells it no answer
// is coming and to record the call instead. Without that clause this would produce the duplicate queue
// card the old hold existed to prevent, rather than the forward motion asked for.
//
// THE `done` CARVE-OUT IS THE LOOP'S OFF SWITCH, and is the one thing here that is not negotiable: the
// delivered trailer tells the worker to sign off with `done` to stop the prompts, so a goal that kept
// firing over a `done` fence would be a loop with no terminating condition that frizz had also promised
// terminates. Predictability cuts the other way here — an unconditional trigger is only simpler until it
// is the thing reopening finished threads.

/** The thread SIGNED OFF: the message that ended the turn declares the work finished.
 *
 *  That is the ```done fence as of 2026-08-11, and the legacy `ALLDONE` sentinel for as long as sessions
 *  dispatched before the change are still running — they were told to reply it, and dropping the
 *  recogniser the same day would take their exit away and loop them forever.
 *
 *  Needs no stored state: both facts are folded off the FINAL assistant message, so either holds for
 *  exactly as long as that message is the thread's last word, and anything said afterwards re-opens the
 *  loop by itself. */
function saidDone(tele: Pick<SessionTelemetry, "lastFence" | "lastAssistantAllDone">): boolean {
  return tele.lastFence?.kind === "done" || tele.lastAssistantAllDone === true
}

/** The same question, asked of a thread rather than of a message — because since 2026-08-27 a worker
 *  signs off by CALLING `done`, and a tool call cannot write the tailer's `lastFence`.
 *
 *  Without this the arrangement outlived the sign-off it was built to end: a worker that used the verb
 *  instead of the fence kept being woken at every rest, forever, by a Goal it had explicitly finished
 *  with. `registeredDoneFence` carries the same "nothing newer from the human" lifetime the board reads
 *  it by, so the loop reopens on the human's next word exactly as the fence's version does. */
function threadSaidDone(
  storage: Storage,
  slug: string,
  tele: Pick<SessionTelemetry, "lastFence" | "lastAssistantAllDone" | "lastUserAt" | "lastAssistantAt">,
  armedAt?: string | null,
): boolean {
  const registered = registeredDoneFence(storage.getThreadDone(slug), tele.lastUserAt) !== undefined
  const fenced = saidDone(tele)
  if (!registered && !fenced) return false
  return !armReopenedTheLoop(storage, slug, tele, registered, fenced, armedAt)
}

/** ARMING A GOAL AFTER THE SIGN-OFF IS THE HUMAN REOPENING THE LOOP — and it is the one form of "new
 *  work from the human" that `threadSaidDone` could not see.
 *
 *  Both sign-off readings above take their lifetime from the human's last word in the TRANSCRIPT
 *  (`lastUserAt` for a registered done, the final assistant message for a fenced one). Arming a Goal
 *  writes no transcript record, so a human who armed one on a thread that had already signed off got a
 *  panel reading "Goal (on)" over a trigger that could never fire: the rest pass and the beat both
 *  declined, nothing in the UI said why, and the only way out was to type a message. Observed
 *  2026-09-05 on `design-nub-static-server` — the worker registered a done at 23:00:44Z, the human
 *  re-armed at 23:20:54Z, and the thread sat there while its operator read it as frozen.
 *
 *  The comparison is against the sign-off the arm is meant to override — the registered done's own
 *  instant, and (for a fenced one, which carries no instant of its own) the message that holds it,
 *  whichever is later. An arm OLDER than the sign-off changes nothing, which is the ordinary case and
 *  the one that keeps the loop terminable: a worker signs off under a Goal armed long before, and that
 *  done still ends the arrangement. Each re-arm reopens exactly once — the worker's next sign-off is
 *  necessarily later than it, so it silences the loop again. */
function armReopenedTheLoop(
  storage: Storage,
  slug: string,
  tele: Pick<SessionTelemetry, "lastAssistantAt">,
  registered: boolean,
  fenced: boolean,
  armedAt: string | null | undefined,
): boolean {
  const armed = armedAt ? Date.parse(armedAt) : Number.NaN
  if (!Number.isFinite(armed)) return false
  let signedOffAt = Number.NEGATIVE_INFINITY
  if (registered) {
    const doneAt = storage.getThreadDone(slug)?.doneAt
    if (doneAt !== undefined) signedOffAt = Math.max(signedOffAt, doneAt)
  }
  if (fenced) {
    const fencedAt = Date.parse(tele.lastAssistantAt ?? "")
    // A fenced done with no readable instant cannot be dated, so it is never overridden — declining to
    // reopen is the direction that cannot loop.
    if (!Number.isFinite(fencedAt)) return false
    signedOffAt = Math.max(signedOffAt, fencedAt)
  }
  return Number.isFinite(signedOffAt) && armed > signedOffAt
}

/** This thread's ARMED timer ids — the other registry a \`timer:\` line is checked against. */
function armedTimerIdsOf(storage: Storage, slug: string): ReadonlySet<string> {
  return new Set(storage.listThreadTimers(slug, { armedOnly: true }).map((t) => t.id))
}

/** The stop hook asks "you stopped — is there more?", and this is the message that ALREADY ANSWERED it:
 *  the thread declared itself finished, or it parked on a wait somebody else owns. Firing over either is
 *  the trigger talking to itself.
 *
 *  A PENDING QUESTION IS NOT ONE OF THEM, since 2026-08-16 — see the header block. It was a third limb,
 *  switchable off by the panel's "Autonomous mode", and the switch and the limb went together.
 *
 *  `armedAt` is the Goal's own generation, and it reaches the done reading only — see
 *  `armReopenedTheLoop`. An `awaiting` fence is untouched by it: that park says what the rest is
 *  waiting for, which re-arming answers nothing about. */
function restMessageIsSignedOff(
  storage: Storage,
  slug: string,
  tele: Pick<SessionTelemetry, "lastFence" | "lastAssistantAllDone" | "bgShells" | "subAgents">,
  _registeredPrWatches: ReadonlySet<string> = new Set(),
  _armedTimerIds: ReadonlySet<string> = new Set(),
  armedAt?: string | null,
): boolean {
  // AN `awaiting` FENCE ENDS THE GOAL'S BUSINESS WITH THIS REST, honoured or not — and the "or not" is
  // the whole point of widening this from `parkIsHonoured` to the fence's mere presence.
  //
  // The scheduler already owns an awaiting rest in BOTH directions: a park it can honour needs nothing,
  // and one it cannot gets SOURCE 12, which names exactly what is wrong and how to fix it. The Goal
  // firing on top of that is a second bump for one rest, and its text is a generic "keep going" that says
  // nothing about fence grammar — so a worker whose fence is unhonourable cannot learn anything from it.
  //
  // MEASURED, and it is a tight loop rather than a nuisance (2026-08-17, thread
  // `we-need-to-unify-some-development`): a worker on the OLD contract wrote `pr-watch: pullfrog/app#1221`,
  // a kind the grammar cut deleted. Zero hints parse, so the park was never honourable, so the Goal fired
  // ~6s after every rest — three identical fences in 40 seconds, each one re-writing the same dead line
  // because nothing it received mentioned the grammar. Holding the Goal here leaves SOURCE 12 as the one
  // voice on that rest, which is the voice that can actually get the worker out.
  //
  // A worker that writes a garbage fence is therefore NOT left alone: it is bumped once per rest, by the
  // source whose message is about fences.
  if (tele.lastFence?.kind === "awaiting") return true
  return threadSaidDone(storage, slug, tele, armedAt)
}

/** What frizz can actually see running for this thread, in the shape `unaccountedItems` checks against.
 *
 *  A shell and a sub-agent each answer to THREE handles, because the fence names whichever string the
 *  worker was shown: the runtime id it was handed ("Command running in background with ID: bzvtnt3ig";
 *  "agentId: a01b2d20b32feab11" in the Agent launch ack), the launch tool_use id, or the label it reads
 *  back in its own transcript. The runtime id is the one a worker actually has — the tool_use id never
 *  appears in its context — and until 2026-08-28 a sub-agent answered to only the latter two, so a
 *  worker that named the id it was handed was bumped "nothing by that name", then re-fenced with the id
 *  the correction printed and asked why there were two. Refusing a
 *  correct-but-label-shaped name would make the fence unusable for the case it exists for. */
function liveActivityOf(
  tele: Pick<SessionTelemetry, "bgShells" | "subAgents">,
  registeredPrWatches: ReadonlySet<string>,
  armedTimerIds: ReadonlySet<string>,
): LiveActivity {
  const shells = new Set<string>()
  for (const sh of tele.bgShells ?? []) {
    if (sh.state !== "running") continue
    for (const h of [sh.taskId, sh.id, sh.label]) if (h) shells.add(h)
  }
  const agents = new Set<string>()
  for (const a of tele.subAgents ?? []) {
    if (a.state !== "running") continue
    for (const h of [a.taskId, a.id, a.label]) if (h) agents.add(h)
  }
  return { shells, agents, timers: armedTimerIds, prs: registeredPrWatches }
}

/** The rest parked on a wait THIS TRIGGER CANNOT ADVANCE: an `awaiting` fence naming a durable wake the
 *  scheduler itself will deliver — a registered PR (`prs:`) or an armed timer (`timers:`).
 *
 *  IT USED TO FIRE OVER THESE, on the reasoning that the stop hook is the one thing that rescues a
 *  thread parked behind something that will never report. That rescue is real, and it is kept below —
 *  but it never applied to these two shapes, and firing over them was a self-feeding loop rather than a
 *  rescue. Measured on the maintainer's own board 2026-08-12 (project zod): a worker parked on
 *  `pr-watch: colinhacks/zod#6382` was bumped 7 times in 46 minutes, each bump costing a turn whose only
 *  product was the SAME fence reworded, because "keep going" has no answer while a PR sits unreviewed. A
 *  second thread added `human: Colin to merge — the task barred me from merging` and was bumped anyway,
 *  until it escaped the loop the only way left to it: a ```done fence on a PR nobody had merged. The
 *  trigger corrupted the signal it exists to produce.
 *
 *  WHAT STILL GETS THE RESCUE: an `awaiting` fence with no items at all, an unparseable PR ref, a timer
 *  id matching no armed row — every park frizz has no way to fire. Those are the threads that genuinely
 *  wait forever, and this reads the SAME predicates the waker's own passes fire from, so the hold and the
 *  wake can never disagree about which is which.
 *
 *  A PR ENTRY IS THE ONE THAT NEEDS A SECOND FACT, since 2026-08-14: the fence no longer arms anything,
 *  so naming a PR says nothing about whether a wake is coming. A REGISTERED watcher
 *  (`mcp__frizz__watch_pr`) will fire, so the Goal holds; a `prs:` entry with no registration behind it
 *  is a park frizz cannot honour, so it gets the rescue like any other unfireable item. Without the first
 *  half this reintroduces the measured loop above verbatim.
 *
 *  (The quoted incident keeps the spelling of its day: `pr-watch:` was the fence key until 2026-08-15,
 *  and the singular `pr:` until the YAML cutover on 2026-08-24. Both are retired — see
 *  RETIRED_AWAITING_KINDS — and neither parses now.) */
function parkedOnAWaitItCannotAdvance(
  tele: Pick<SessionTelemetry, "lastFence" | "bgShells" | "subAgents">,
  registeredPrWatches: ReadonlySet<string>,
  armedTimerIds: ReadonlySet<string>,
): boolean {
  const fence = tele.lastFence
  if (fence?.kind !== "awaiting") return false
  // A REAL PARK, checked, not merely asserted. Three things have to hold: it names at least one item, it
  // carries a usable `for:`, and EVERY item it names is something frizz can currently see. Anything else
  // is a wait that cannot resolve, and gets the rescue — which is the whole reason the grammar became
  // structural. Before this, a worker could park indefinitely on `human: Alice` or on an instant already
  // in the past, and frizz had no way to tell the difference from a healthy wait.
  return parkIsHonoured(readAwaitingPark(fence.hints), liveActivityOf(tele, registeredPrWatches, armedTimerIds))
}

/** The PRs a thread has actually registered, by `owner/repo#N`. Read where the Goal decides whether to
 *  bump, because a declaration alone no longer means a wake is coming. */
function registeredPrWatchesOf(storage: Storage, slug: string): ReadonlySet<string> {
  return new Set(storage.listPrWatches(slug, { armedOnly: true }).map((w) => `${w.owner}/${w.repo}#${w.number}`))
}

// A row's live ON SCHEDULE trigger, if it has one. A switched-off trigger deliberately reads as ABSENT
// here — off must stop new deliveries AND drop queued ones — while the row keeps the text and the
// cadence so switching it back on resumes the same schedule rather than making anyone re-enter it.
function armedSchedule(row: RecurringRow): ArmedSchedule | undefined {
  const prompt = row.recurring_prompt?.trim()
  const intervalMs = row.recurring_interval_ms
  const armedAt = row.recurring_armed_at
  if (!prompt || !intervalMs || intervalMs <= 0 || !armedAt) return undefined
  if (row.recurring_on_schedule !== 1) return undefined
  const anchor = Date.parse(row.recurring_schedule_fired_at ?? armedAt)
  if (!Number.isFinite(anchor)) return undefined
  return { prompt, intervalMs, armedAt, dueAtMs: anchor + intervalMs }
}

// ---- SOURCE 5: THE RECURRING PROMPT, ON REST -----------------------------------------------------
// The SAME stored text as SOURCE 4, delivered every time the thread STOPS — which is the event an
// operator actually means when they want one to keep going.
//
// There is no cadence here and nothing to get wrong. An earlier interval-based version of this idea was
// removed 2026-08-02 for exactly that reason: an operator who wants "keep going until X" has no idea
// what number to put in a box. A thread that stops gets the text, and one that never stops never needed
// it — that thread is SOURCE 4's job.
//
// The loop's OFF SWITCH belongs to the worker, and it is the one part of this that is not optional. A
// rest trigger with no terminating condition is an infinite bump generator, so the delivered text
// carries a trailer (shared `restPromptMessage`) teaching the worker to sign off with a ```done fence
// when the work is genuinely finished. The tailer folds that fence onto the final message (`lastFence`)
// and this pass simply declines to fire while it stands — no state to write, and it re-opens by itself
// the moment the thread produces any other final message. See `saidDone`, which also still honours the
// legacy `ALLDONE` sentinel for sessions dispatched before 2026-08-11.
//
// Same generation as SOURCE 4 (`recurring_armed_at`), because it is the same prompt: editing the text
// supersedes a delivery queued for the old words on BOTH triggers at once.
const STOP_HOOK_FENCE_PREFIX = "stophook"
const STOP_HOOK_HINT_KEY = "stophook:rest"

// The rest a delivery is bound to: the AGENT'S OWN last word.
//
// It was `lastActivityAt`, the thread's high-water mark over ANY record, and that was a self-feeding
// loop for a thread whose worker is gone. Frizz speaks as the USER, so a delivered bump lands in the
// transcript and advances the high-water mark — minting a new "rest" that nobody rested, and with it a
// new delivery id. Measured 2026-08-12 on a real stack with the worker absent: 10 bumps in 100 seconds,
// climbing. It was survivable while a Goal was something an operator opted into on one thread; it stopped
// being survivable when every dispatched thread started carrying one.
//
// `lastAssistantAt` keeps the property that made the old key work — a genuine new rest necessarily
// carries a new one, so "at most one per rest" still falls out of delivery-id uniqueness — and adds the
// one frizz needs: nothing frizz says can move it. A thread with no assistant output yet has never
// rested.
function stopHookFenceId(armedAt: string, restedAt: string): string {
  return `${STOP_HOOK_FENCE_PREFIX}:${armedAt}:${restedAt}`
}
function isStopHookFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${STOP_HOOK_FENCE_PREFIX}:`)
}

interface ArmedRest {
  prompt: string
  armedAt: string
}

// A row's live ON REST trigger, if it has one. Switched off reads as ABSENT, exactly as for the
// schedule, and for the same reason.
function armedRest(row: RecurringRow): ArmedRest | undefined {
  const prompt = row.recurring_prompt?.trim()
  const armedAt = row.recurring_armed_at
  if (!prompt || !armedAt) return undefined
  if (row.recurring_on_rest !== 1) return undefined
  return { prompt, armedAt }
}

// ---- SOURCE 7: THE RECURRING PROMPT, ON COMPACTION -----------------------------------------------
// The THIRD trigger on the same stored text (2026-08-06), delivered every time the harness summarizes
// the thread's context away.
//
// WHY IT IS A TRIGGER AND NOT A HOOK. Compaction is the largest source of context loss there is, and
// frizz used to answer it by having a worker-side hook splice the head of a canonical `scratch.md` into
// the emptied window. That made the pad a load-bearing file every worker had to maintain whether or not
// it wanted one. The recurring prompt already solves the same problem better: the worker writes whatever
// doc it likes in its scratch directory and LINKS it here, and the link comes back at exactly the moment
// the context is gone. The row is durable, it is visible in the thread footer, and the operator can edit
// it — none of which a hook injection was.
//
// IT DOES NOT WAIT FOR REST, and that is the one place it deliberately parts company with SOURCE 5. A
// compaction lands MID-TURN: the worker is still working, and the whole value is re-grounding it before
// its next tool call rather than after it has finished acting on a summary. So this takes the SCHEDULE
// trigger's delivery gate, not the rest trigger's.
//
// Same generation (`recurring_armed_at`) as its two siblings, because it is the same prompt.
const COMPACT_FENCE_PREFIX = "compact"
const COMPACT_HINT_KEY = "recurring:compaction"

// The compaction a delivery is bound to. A new compaction necessarily carries a new instant, so "at most
// one per compaction" falls out of delivery-id uniqueness — the same trick the rest trigger plays with
// `lastActivityAt`, and the reason neither needs a counter.
function compactFenceId(armedAt: string, compactedAt: string): string {
  return `${COMPACT_FENCE_PREFIX}:${armedAt}:${compactedAt}`
}
function isCompactFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${COMPACT_FENCE_PREFIX}:`)
}

// A row's live ON COMPACTION trigger, if it has one. Switched off reads as ABSENT, same as the others.
function armedCompact(row: RecurringRow): ArmedRest | undefined {
  const prompt = row.recurring_prompt?.trim()
  const armedAt = row.recurring_armed_at
  if (!prompt || !armedAt) return undefined
  if (row.recurring_on_compact !== 1) return undefined
  return { prompt, armedAt }
}

// ---- SOURCE 6: THE WORKER'S ONE-OFF TIMERS -------------------------------------------------------
// The heartbeat with the repetition taken out: text the worker asked to be handed back at ONE instant,
// once. A thread may hold arbitrarily many, so unlike every other source here the record of intent is a
// TABLE (`thread_timer`) rather than a column on the session row — a row can hold one arrangement, and
// "check the deploy in 10 min AND re-read the spec in an hour" is two.
//
// It inherits the SCHEDULE trigger's delivery gate rather than the snooze's, deliberately: a timer set
// for 15:00 that a busy thread only hears at 15:50 has not kept the promise it made, and "in ten
// minutes" is the instruction being obeyed. See `isDeliverableNow`.
//
// It does NOT inherit the sign-off opt-out. That exists because a recurring trigger is an
// infinite bump generator with no terminating condition; a one-off has exactly one delivery in it, and a
// worker that scheduled an alarm and then said "nothing further right now" still wants the alarm.
//
// The GENERATION is the timer id itself — each row is armed once and never edited, so a delivery can
// only be superseded by the row leaving the `armed` state (the worker cancelled it, or it already
// fired). That is also what makes the row's own state, not the outbox, the durable "never twice" guard:
// terminal outbox rows are pruned past a cap, while `state = 'fired'` is permanent.
const TIMER_FENCE_PREFIX = "timer"
const TIMER_HINT_PREFIX = "timer:"

// Every delivery-id namespace here is safe against its neighbours: no prefix minted below is a prefix
// of another, and a source that mints an id outside all of them is superseded by `deliveryContext`'s
// tail rather than delivered. (A registered watcher is scheduler SOURCE 8; the built-in sign-off nudge
// is SOURCE 9, and it carries its own consecutive cap.)
/** A finished background shell's delivery namespace. The shell's own launch tool_use id is the whole
 *  key, so one shell can wake its thread exactly once, ever — no counter, no cursor, no way to loop. */
const SHELL_FENCE_PREFIX = "shell"
function shellFenceId(toolUseId: string): string {
  return `${SHELL_FENCE_PREFIX}:${toolUseId}`
}
function isShellFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${SHELL_FENCE_PREFIX}:`)
}

/** A registered PR watcher's delivery namespace. The id plus a monotonically-increasing REPORT number,
 *  because this watcher fires many times over one PR's life — the id alone would dedupe every wake after
 *  the first, which is exactly the bug a one-shot namespace would hide. */
const PR_WATCH_FENCE_PREFIX = "prwatch"
/** The same watcher's LAST word — its registration ran out. A separate namespace because it is a
 *  different piece of news from a report, and one-shot: the watcher is settled by the time it is sent. */
const PR_WATCH_EXPIRED_FENCE_PREFIX = "prwatch-expired"
function prWatchFenceId(watchId: string, report: number): string {
  return `${PR_WATCH_FENCE_PREFIX}:${watchId}:${report}`
}
function prWatchExpiredFenceId(watchId: string): string {
  return `${PR_WATCH_EXPIRED_FENCE_PREFIX}:${watchId}`
}
// BOTH spellings, and the expired one is why this cannot be a bare `startsWith(prefix + ":")`:
// `prwatch-expired:…` does NOT start with `prwatch:`, so it fell past every branch in deliveryContext()
// and into the awaiting-fence tail, which supersedes unconditionally. 7 expiry reports were enqueued and
// 0 delivered on the live board before anyone looked (2026-08-18).
function isPrWatchFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${PR_WATCH_FENCE_PREFIX}:`) || fenceId.startsWith(`${PR_WATCH_EXPIRED_FENCE_PREFIX}:`)
}
/** A REGISTERED WATCH that ran out of `for:` — the `thread_watch` twin of the PR expiry above, and a
 *  separate namespace for the same reason: it is one-shot news about a row that is settled by the time
 *  it is sent. There is no `watch:` REPORT prefix beside it, because a watch has no report to make —
 *  evalShellCompletions already wakes a resting thread when its shell finishes, and a second wake for
 *  the same fact would be the duplicate noise that pass exists to avoid. */
const OWN_WATCH_EXPIRED_FENCE_PREFIX = "watch-expired"
function ownWatchExpiredFenceId(watchId: string): string {
  return `${OWN_WATCH_EXPIRED_FENCE_PREFIX}:${watchId}`
}
function isOwnWatchExpiredFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${OWN_WATCH_EXPIRED_FENCE_PREFIX}:`)
}

/** A batch of question settlements handed over as one message. The ids are IN the key so a second
 *  answer on the same thread is its own piece of news rather than a duplicate the outbox dedupes away. */
const QUESTION_ANSWER_FENCE_PREFIX = "answers"
function questionAnswerFenceId(ids: readonly string[]): string {
  return `${QUESTION_ANSWER_FENCE_PREFIX}:${createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 16)}`
}
function isQuestionAnswerFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${QUESTION_ANSWER_FENCE_PREFIX}:`)
}

/** How often a registered watcher re-reads GitHub, per PR. The fence poller's floor, for the same
 *  reason: this is somebody else's API and the answer changes on a human's timescale. */
const PR_WATCH_POLL_MS = 60_000

/** How many `gh` children the STATUS FALLBACK may have in flight at once (2026-09-04).
 *
 *  THE BOUND IS ON THE SUBPROCESS, NOT ON THE FAN-OUT, and that is the whole design. The poll fans out
 *  over every armed PR at once and must keep doing so: the GraphQL half coalesces those calls in a
 *  microtask into batches of 20, so an unbounded fan-out is ONE request where a fan-out capped at 8
 *  would be three — paying more of somebody else's rate limit to fix a problem the batch does not have.
 *  What is genuinely unbounded is `defaultFetchPr`, which is two `gh` children per PR; and because the
 *  GraphQL half fails for the WHOLE batch at once (an expired token, a network blip, a shape surprise),
 *  every ref reaches the fallback in the same tick or none does. That is the storm: N armed watchers
 *  becoming 2N `gh` processes inside one second, each of them several forks, once a minute for as long
 *  as the cause stands. Four at a time turns it into a queue. */
const PR_STATUS_FALLBACK_LIMIT = 4

/** A slot allocator: `run(fn)` waits until fewer than `limit` calls are in flight. The released slot is
 *  handed STRAIGHT to the next waiter rather than counted down and re-acquired, so a caller arriving in
 *  the same tick as a release cannot slip past the limit. */
function concurrencyGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < limit) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

const SIGNOFF_FENCE_PREFIX = "signoff"
const SIGNOFF_HINT_KEY = "signoff:rest"
const SIGNOFF_NUDGE_MAX = 2
/** SOURCE 12's cap on CORRECTIVE bumps (nameless / retired / dead). Three, not two: there are three
 *  distinct corrections and a worker may legitimately need to be told about more than one. `expired` is
 *  uncounted — re-parking on still-running work is unlimited by explicit decision (2026-08-15). */
const PARK_BUMP_MAX = 3
/** The kill switch. Not in the UI — this lands on every live thread at once, so there has to be a way
 *  to stop it that is not a code change. Absent (the default) means ON. */
const SIGNOFF_NUDGE_SETTING = "signoffNudge"

function signoffFenceId(restedAt: string): string {
  return `${SIGNOFF_FENCE_PREFIX}:${restedAt}`
}
function isSignoffFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${SIGNOFF_FENCE_PREFIX}:`)
}

/** The question a `thread_question` row asks, as one short line for a correction's list — the worker
 *  never saw the id frizz minted, so the id alone would not tell it which question is meant. */
function questionLine(spec: string): string {
  try {
    const q = String((JSON.parse(spec) as { question?: unknown }).question ?? "").replace(/\s+/g, " ").trim()
    return q.length > 120 ? `${q.slice(0, 117)}…` : q
  } catch {
    return "(unreadable question)"
  }
}

/** SOURCE 12's delivery namespace — `park:<cause>:<the rest it corrects>`. The cause is in the key so a
 *  fence bumped for a dead id and later for expiry is two pieces of news rather than one deduped away. */
const PARK_FENCE_PREFIX = "park"
function parkFenceId(cause: string, spokeAt: string): string {
  return `${PARK_FENCE_PREFIX}:${cause}:${spokeAt}`
}
function isParkFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${PARK_FENCE_PREFIX}:`)
}
/** The rest instant a correction was minted for. Sliced past the SECOND colon, never `split(":")[2]` —
 *  the value is an ISO instant and carries colons of its own. */
function parkFenceRestOf(fenceId: string): string {
  const cut = fenceId.indexOf(":", PARK_FENCE_PREFIX.length + 1)
  return cut < 0 ? "" : fenceId.slice(cut + 1)
}


function timerFenceId(timerId: string): string {
  return `${TIMER_FENCE_PREFIX}:${timerId}`
}
function isTimerFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${TIMER_FENCE_PREFIX}:`)
}
function timerIdOf(fenceId: string): string {
  return fenceId.slice(TIMER_FENCE_PREFIX.length + 1)
}

// Default gh-backed PR fetcher. Uses the USER'S `gh` (their auth) via execFile — NO shell. Any failure
// (gh missing → ENOENT, not authed / rate-limited → nonzero exit, malformed JSON) resolves to undefined
// so the tick logs + skips and NEVER crashes. Timeout-bounded so a hung gh can't wedge the scheduler.
/** The first line gh printed on stderr, or the process-level reason — what a worker or an operator can
 *  act on. `gh` names the cause in one line ("Could not resolve to a Repository…", "authentication
 *  required", "HTTP 404"); everything after it is stack and hint. */
export function conciseGhError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === "ENOENT") return "the `gh` CLI is not installed on the PATH of the process Frizz runs as"
  if ((err as { killed?: unknown })?.killed || code === "ETIMEDOUT") return "`gh` did not answer within 15s"
  const stderr = typeof (err as { stderr?: unknown })?.stderr === "string" ? (err as { stderr: string }).stderr : ""
  const line = stderr.trim().split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
  if (line) return line.slice(0, 300)
  const message = err instanceof Error ? err.message : String(err)
  return message.trim().split(/\r?\n/, 1)[0]?.slice(0, 300) || "unknown error"
}

export type PrProbe = { ok: true } | { ok: false; reason: string }

/** CAN FRIZZ READ THIS PR AT ALL — asked at registration, so a watcher that could never fire is refused
 *  on the spot rather than armed. Reported 2026-08-25: a worker parked 12h+ on a watcher, and among the
 *  ways that happens is a PR the server's own `gh` cannot see (signed out on github.com, an SSO-gated
 *  org, a repo that does not exist, no `gh` on the daemon's PATH) — every poll failed, silently, and the
 *  worker rested believing it was covered. One `gh pr view`, the same call the poll makes. */
export async function probePrReadable(ref: PrRef): Promise<PrProbe> {
  try {
    await execFileAsync(
      "gh",
      ["pr", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", "state"],
      { timeout: 15_000, maxBuffer: 1_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: conciseGhError(err) }
  }
}

// THROWS on a failed `gh`, so the poll can SAY why — it returned undefined for everything until
// 2026-08-25, which made a PR the server could not read (signed out, SSO, no such repo, no `gh` on the
// PATH) indistinguishable from a PR with nothing to report: no log line, no wake, ever. `undefined` is
// kept for the one honest case, a response frizz cannot interpret (below).
async function defaultFetchPr(ref: PrRef): Promise<PrStatus | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ghPrViewArgs(ref),
      { timeout: 15_000, maxBuffer: 8_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    const j = JSON.parse(stdout) as {
      state?: unknown; mergedAt?: unknown; statusCheckRollup?: unknown; headRefOid?: unknown
      mergeable?: unknown; reviewDecision?: unknown
    }
    // A SHAPE SURPRISE (valid JSON, but no string `state`) is INDETERMINATE, not "OPEN with no
    // checks" — returning a fabricated `{state:"", rollup:[]}` would read as UNMET and ARM the hint,
    // so a later accurate read could then fire an already-merged PR. Undefined = try again next poll.
    if (typeof j.state !== "string" || !j.state) return undefined
    if (typeof j.headRefOid !== "string" || !j.headRefOid) return undefined
    const runs = await execFileAsync(
      "gh",
      ["run", "list", "--repo", `${ref.owner}/${ref.repo}`, "--commit", j.headRefOid, "--limit", "100", "--json", "name,workflowName,status,conclusion,databaseId,event,createdAt"],
      { timeout: 15_000, maxBuffer: 8_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    const workflowRuns = JSON.parse(runs.stdout)
    if (!Array.isArray(workflowRuns)) return undefined
    return {
      state: j.state,
      mergedAt: typeof j.mergedAt === "string" ? j.mergedAt : null,
      rollup: Array.isArray(j.statusCheckRollup) ? (j.statusCheckRollup as RollupEntry[]) : [],
      head: j.headRefOid,
      mergeable: typeof j.mergeable === "string" ? j.mergeable : undefined,
      reviewDecision: typeof j.reviewDecision === "string" ? j.reviewDecision : undefined,
      workflowRuns: workflowRuns as WorkflowRun[],
    }
  } catch (err) {
    throw new Error(conciseGhError(err))
  }
}

/** How many PRs' readings the book keeps. Shared by ref, so two threads watching one PR see one reading
 *  and cost one fetch. The key itself lives in awaiting.ts, beside the parser the board reads it with. */
const GITHUB_STATUS_CAP = 200
const REVIEW_SEEN_CAP = 300
// How many fresh activities a single wake steer enumerates. One poll interval can collect a whole
// review app's burst; naming ten of them is already a long steer, and the count line tells the worker
// how many it did not get named individually.
const REVIEW_STEER_CAP = 10

export interface SchedulerDeps {
  storage: Storage
  tailer: Tailer
  // Resume/steer a thread (prod: the shared resumeThread; tests: a spy). `deliveryId` is a stable
  // idempotency key for the exact session + awaiting-fence generation. Implementations must carry it
  // through durable downstream queues and append wakeDeliveryToken(id) to terminal input so transcript
  // recovery can prove a crash-window delivery before retrying (the production composition does both).
  resume: (slug: string, message: string, deliveryId: string) => void | Promise<void>
  now?: () => number
  // The provider quota snapshot, used ONLY to decide whether an exhausted window has rolled when the
  // limit message's own text can't say (every weekly limit, since its clock carries no date). Absent
  // in tests that exercise the text path; a read that throws is treated as indeterminate.
  readQuota?: () => Promise<QuotaSnapshot>
  fetchPr?: (ref: PrRef) => Promise<PrStatus | undefined>
  // Tests may keep injecting the historical bare array/undefined result. Production uses the
  // structured result so the scheduler can distinguish auth, timeout, network, API, and shape faults.
  fetchGithubReview?: (ref: PrRef) => Promise<GithubReviewActivity[] | GithubReviewFetchResult | undefined>
  log?: (msg: string) => void
  // After `resume` has handed a wake to the worker's runtime: is the process that took it still there?
  // The broker transport is a socket frame with no reply, and a cold resume that dies at startup takes
  // the frame with it — so "resume returned" is SENT, not delivered. Answering "alive" or "dead" lets the
  // scheduler hold the wake as sent and confirm or re-send it later; "unknown" (or no hook at all) keeps
  // the old behaviour, delivered on return. See deliverDue and reconcileOutbox.
  wakeRuntimeState?: (slug: string, sessionId: string) => "alive" | "dead" | "unknown"
  // How long a sent wake waits for its transcript token before the runtime's survival alone confirms it.
  confirmGraceMs?: number
  // The per-thread quiet window (wake-store.ts WAKE_QUIET_WINDOW_MS): how long after a wake is handed
  // to a thread its next wake waits, so a burst of events costs one turn. Tests pass 0 to pin the
  // behaviour of each source without the window in the way; production takes the constant.
  wakeQuietWindowMs?: number
  tickMs?: number // how often to check (timers resolve at this cadence)
  deliveryLeaseMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  maxDeliveryAttempts?: number
  deliveryBatchSize?: number
  // Deterministic hard-crash fault injection. Throwing here escapes tick without compensating writes,
  // exactly like process death at the named durability boundary. Never configured in production.
  crashPoint?: (point: SchedulerCrashPoint, delivery: WakeDelivery) => void
}

export type SchedulerCrashPoint = "after-enqueue" | "after-claim" | "after-delivery" | "after-ack"

export interface Scheduler {
  start(): void
  stop(): Promise<void>
  tick(): Promise<void> // exposed for tests + boot
  /** RUN THE NEXT PASS NOW, for a caller that just created work the sweep would otherwise find up to a
   *  whole `tickMs` later. Fire-and-forget: it never throws and never blocks the caller's response.
   *
   *  It is a no-op unless the scheduler was actually STARTED — a disposable stack boots with
   *  FRIZZ_WAKERS_OFF and never calls `start()`, and a kick that ran the sweep anyway would deliver
   *  wakes the operator explicitly turned off. `tick()` stays the unconditional one, for tests and boot. */
  kick(): void
}

/** The FENCE key a wire kind is written as. The wire kinds stayed SINGULAR through the 2026-08-24 YAML
 *  cutover; the grammar the worker writes did not, so every message that quotes a fence line back at a
 *  worker has to translate — printing `i.kind` raw teaches a spelling the parser now refuses. */
const AWAITING_KEY_OF: Record<"shell" | "agent" | "timer" | "pr", string> = {
  shell: "shells", agent: "agents", timer: "timers", pr: "prs",
}

// ---- THE MID-TURN HOLD'S BOUND ------------------------------------------------------------------
// A wake that is not clock-driven waits for the thread to come to rest (`isDeliverableNow`), and that
// wait used to be unbounded: a thread whose turn reading never returned to idle — a fold that stalled, a
// runtime whose last record is a tool_use that will never be answered — starved every wake queued behind
// it, silently, for as long as the row lived. This is the ceiling. A held wake older than this goes out
// even while the thread reads busy, into the runtime's queue exactly as a heartbeat does — which neither
// aborts the running turn nor opens a new one (the CLI drains its queue at the next sampling boundary).
// Ten minutes is long enough that an ordinary turn ends first and the rest-time delivery stays the rule;
// short enough that a stuck reading costs one wake ten minutes rather than a thread its whole wait.
export const MID_TURN_HOLD_MAX_MS = 10 * 60_000

// The reason a deferred row carries while it is held. It is what tells `reconcileOutbox` that an
// expired lease was NEVER SENT — a deferral happens before `resume` is called — as opposed to an
// attempt that died with the socket write in flight, which is the one case a re-open on a busy thread
// must never guess at.
export const WAKE_HOLD_DEFERRAL = "delivery deferred until exact awaiting telemetry is idle and available"

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? Date.now
  const fetchPr = deps.fetchPr ?? defaultFetchPr
  const fetchGithubReview = deps.fetchGithubReview ?? createGithubReviewFetcher({ now })
  const log = deps.log ?? ((m: string) => frizzLog.info("scheduler", m))
  const tickMs = deps.tickMs ?? 10_000
  const deliveryLeaseMs = Math.max(1, deps.deliveryLeaseMs ?? 30_000)
  const retryBaseMs = Math.max(1, deps.retryBaseMs ?? 5_000)
  const retryMaxMs = Math.max(retryBaseMs, deps.retryMaxMs ?? 5 * 60_000)
  const maxDeliveryAttempts = Math.max(1, deps.maxDeliveryAttempts ?? 6)
  // A `claude --resume` that is going to die does so within seconds (a missing session, a refused
  // credential) to tens of seconds (an MCP server that will not boot); one that is alive a minute after
  // taking the frame has read it, whether or not the transcript check can see the token yet.
  const confirmGraceMs = Math.max(1, deps.confirmGraceMs ?? 60_000)
  const deliveryBatchSize = Math.max(0, deps.deliveryBatchSize ?? 50)
  const deliveryOwner = randomUUID()
  const outbox = createWakeDeliveryStore(deps.storage.scope, { quietWindowMs: deps.wakeQuietWindowMs ?? WAKE_QUIET_WINDOW_MS })

  const reviewFailures = new Map<string, { signature: string; loggedAt: number; suppressed: number }>()
  let timer: NodeJS.Timeout | null = null
  let activeTick: Promise<void> | null = null // guard + shutdown drain for a slow poll/delivery
  let stopped = false

  // ---- THE WATCHED-PR STATUS LEDGER ---------------------------------------------------------------
  // The poller is the only thing here that talks to GitHub, and the BOARD is what has to render the
  // result and decide the queue rule from it. So the poll publishes into a setting keyed by PR ref, and
  // the board reads it — one shared reading per PR, however many threads are watching it.
  //
  // A setting rather than a table because there is nothing to reconcile: it is a pure CACHE of GitHub's
  // own answer, every entry is replaceable, and an entry for a PR nobody watches any more is stale data
  // that costs a few bytes until it is evicted. Bounded like the ledgers beside it.
  function publishGithubStatus(key: string, pr: PrStatus, nowMs: number): void {
    const raw = deps.storage.getSetting(GITHUB_STATUS_SETTING)
    const book = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
    book[key] = githubWatchStatus(pr, new Date(nowMs).toISOString())
    const keys = Object.keys(book)
    // Newest-wins eviction on insertion order, which for this book is poll order — the entry evicted is
    // the one longest unpolled, i.e. the PR nobody is watching any more.
    for (const stale of keys.slice(0, Math.max(0, keys.length - GITHUB_STATUS_CAP))) delete book[stale]
    deps.storage.setSetting(GITHUB_STATUS_SETTING, book)
  }

  class InjectedSchedulerCrash extends Error {
    constructor(cause: unknown) {
      super("simulated scheduler hard crash", { cause })
    }
  }

  function checkpoint(point: SchedulerCrashPoint, item: WakeDelivery): void {
    if (!deps.crashPoint) return
    try {
      deps.crashPoint(point, item)
    } catch (error) {
      throw new InjectedSchedulerCrash(error)
    }
  }

  function retryDelay(attempts: number): number {
    return Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, Math.min(30, attempts - 1)))
  }

  type DeliveryContext = "confirmed" | "superseded" | "current-idle" | "current-busy" | "unknown"

  function deliveryContext(item: WakeDelivery): DeliveryContext {
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return "superseded"
    if (row.state === "archived" || row.archived === 1) return "superseded"
    const tele = deps.tailer.get(item.slug)
    if (!tele) return "unknown"
    if (tele.lastUserText?.includes(wakeDeliveryToken(item.id))) return "confirmed"
    // A limit wake is bound to its interruption, not to a fence: it stays deliverable exactly as long
    // as THAT limit fault is still the thread's live tail state. The fault clears on the first user
    // record, so a delivery that reached the worker before the process died reads as superseded on the next
    // pass instead of being sent twice — the same supersession safety the fence path gets, obtained
    // from the fold rather than from anything the scheduler had to persist.
    if (isLimitFenceId(item.fenceId)) {
      const fault = tele.limitFault
      if (!fault || limitFenceId(fault) !== item.fenceId) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A snooze wake is bound to the exact (instant, prompt) the human armed. Wake-now (clears the row),
    // a re-snooze (a different fence id) and an ordinary follow-up (clears the row too — see
    // resume.wakeParkedThreadForFollowUp) therefore all read as supersession here: each one is the human
    // replacing the promise we were holding. Reprompting a thread means "now", which is precisely the
    // instruction a bump scheduled for later no longer describes.
    // A SHELL-COMPLETION WAKE CANNOT BE SUPERSEDED BY ANYTHING THE THREAD SAYS. It is bound to a fact
    // that has already happened — this shell finished, and its agent was resting when it did — and no
    // later fence, rest or edit makes that untrue. So the only question is whether the thread is free to
    // receive it. (Without this branch it fell through to the awaiting-fence logic below, which compares
    // the delivery against the thread's CURRENT fence and superseded every wake for a bare rest: queued
    // on every tick, delivered never.)
    if (isShellFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A REGISTERED PR WATCHER's report is bound to something that happened on GitHub, not to anything
    // this thread wrote, so no fence, rest or edit can supersede it either. Same reasoning as the shell
    // wake directly above, and the same bug if it is missing.
    if (isPrWatchFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A REGISTERED WATCH's expiry is bound to a clock, not to anything the thread wrote — the row is
    // already settled by the time this is enqueued, so no fence, rest or edit can make it untrue.
    // Same reasoning as the two above, and the same silent never-delivered bug if it is missing.
    if (isOwnWatchExpiredFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // AN ANSWER IS BOUND TO WHAT THE HUMAN SAID, not to anything the thread wrote, so no fence, rest or
    // edit supersedes it. Same reasoning as the three above, and the same silent never-delivered bug if
    // it is missing — this is the one delivery a worker is actually waiting on.
    if (isQuestionAnswerFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    if (isSnoozeFenceId(item.fenceId)) {
      if (armedSnooze(row)?.fenceId !== item.fenceId) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A scheduled delivery is bound to the exact GENERATION that queued it. Switching the trigger off, re-arming it
    // with different settings, and either side switching it off all read as
    // supersession here — each one means the queued text no longer describes what the thread wants.
    // Disabling therefore drops a beat already waiting, rather than delivering it on re-enable.
    if (isHeartbeatFenceId(item.fenceId)) {
      const armed = armedSchedule(row)
      if (!armed || !item.fenceId.startsWith(`${HEARTBEAT_FENCE_PREFIX}:${armed.armedAt}:`)) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A rest delivery is bound to the exact GENERATION that queued it AND to the exact REST it
    // was queued for. Disabling the toggle, editing the text, and the thread moving on to a new rest
    // all read as supersession here — and so does an AWAITING that landed between enqueue and delivery,
    // which is the case that matters: a worker that closed the loop while a bump sat in the outbox must
    // not be handed it anyway.
    if (isStopHookFenceId(item.fenceId)) {
      const armed = armedRest(row)
      if (!armed || item.fenceId !== stopHookFenceId(armed.armedAt, tele.lastAssistantAt ?? "")) return "superseded"
      if (restMessageIsSignedOff(deps.storage, item.slug, tele, registeredPrWatchesOf(deps.storage, item.slug), armedTimerIdsOf(deps.storage, item.slug), armed.armedAt)) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A post-compaction delivery is bound to the generation AND to the exact compaction it was queued
    // for — a SECOND compaction between enqueue and delivery supersedes the first, because re-grounding
    // on the older window is not what the operator asked for. Unlike the rest trigger it does NOT check
    // whether the thread signed off: `done` answers "you stopped, is there more?", and a compaction is
    // not that question.
    if (isCompactFenceId(item.fenceId)) {
      const armed = armedCompact(row)
      if (!armed || item.fenceId !== compactFenceId(armed.armedAt, tele.lastCompactionAt ?? "")) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A one-off timer is bound to its own row still being ARMED. The worker cancelling it, and a
    // previous attempt having already settled it as fired, both read as supersession here — which is
    // what makes "exactly once" hold even after the outbox has pruned this delivery's terminal row.
    if (isTimerFenceId(item.fenceId)) {
      if (deps.storage.getThreadTimer(timerIdOf(item.fenceId))?.state !== "armed") return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A registered watcher is bound to its own row still being ARMED, exactly as a timer is — and for
    // the same two reasons. The worker DROPPING it between enqueue and delivery must cancel the wake
    // (that is the whole point of a dismissable wait), and a previous attempt having already settled it
    // as fired is what makes "exactly once" hold after the outbox prunes this delivery's terminal row.
    //
    // This branch is load-bearing in a way the others are not: without it the fallthrough below reads
    // every watcher delivery as an awaiting fence, finds none, and supersedes it — the watcher enqueues
    // on every tick and never delivers, which looks exactly like a watcher that does not work.
    // The built-in nudge is bound to the exact rest it was queued for, and to that rest still being
    // fenceless. A worker that signed off between enqueue and delivery must not then be told how to
    // sign off — which is both useless and, arriving after a ```done, actively confusing.
    if (isSignoffFenceId(item.fenceId)) {
      if (item.fenceId !== signoffFenceId(tele.lastAssistantAt ?? "")) return "superseded"
      if (tele.lastFence || tele.pendingQuestion) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A report repair is bound to a report that is STILL missing from the model's context. If the
    // runtime delivered it late — between the tick that queued this repair and the tick that would
    // send it — the fold drops it out of `droppedReports` and the repair reads as superseded here.
    // That is what keeps a slow delivery from producing a repair for a report the agent has now read,
    // and it is obtained from the fold rather than from anything the scheduler had to persist.
    if (isReportFenceId(item.fenceId)) {
      const stillMissing = tele.droppedReports?.some((r) => reportFenceId(r.taskId) === item.fenceId)
      if (!stillMissing) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // SOURCE 12's correction is bound to the exact REST it was minted for, and to that rest still being
    // the thread's last word — a follow-up or a new turn means the worker is no longer looking at the
    // fence being corrected. Nothing else can supersede it: whether the fence is still wrong is settled
    // at ENQUEUE, and re-deciding it here would race the very bump that fixes it.
    //
    // THIS BRANCH IS WHY THE SOURCE WORKED AT ALL. Without it a `park:…` id fell to the tail below,
    // which supersedes everything that reaches it — so every correction read as superseded, at zero
    // attempts, and the one voice that can get a worker out of a bad fence was silent. Measured on the
    // maintainer's own board 2026-08-18: 2034 corrections enqueued across four projects, 0 delivered,
    // ever, while every kind that HAS a branch here ran at ~100%. The thread that surfaced it wrote
    // `timer: none` and sat for three hours.
    //
    // THE GENERAL SHAPE OF THAT BUG: a fallthrough that supersedes is a fallthrough that fails CLOSED, so
    // a source minting a new prefix without a branch here is silently undeliverable and the enqueue-side
    // tests still pass. Any new wake source needs its branch here and a test that asserts `resume` ran.
    if (isParkFenceId(item.fenceId)) {
      if (parkFenceRestOf(item.fenceId) !== (tele.lastAssistantAt ?? "")) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // NOTHING ROUTES TO THE TAIL ANY MORE, so everything that reaches it supersedes. Every live source
    // above claims its own prefix; an id arriving here belongs to a source that mints one nobody routes,
    // and a fallthrough that supersedes is a fallthrough that fails CLOSED — that source is silently
    // undeliverable while its enqueue-side tests stay green. Both bugs found on 2026-08-18 were exactly
    // this, and neither was visible without querying the database. It still supersedes (failing open
    // would deliver an id we cannot reason about), but it SAYS SO.
    //
    // The one id shape that is NOT a bug is a fence identity from a pre-cutover scheduler, still sitting
    // in an old outbox. That source was deleted on 2026-08-24 and nothing mints those ids now, so
    // superseding one is the right answer and it needs no alarm — hence the separator check below.
    if (!item.fenceId.includes("\u0001")) {
      log(`waker: UNROUTED wake prefix ${item.fenceId.split(":")[0]} for ${item.slug} — no deliveryContext branch, superseding`)
    }
    return "superseded"
  }

  // May this item go out RIGHT NOW? Most sources wait for the thread to come to rest, because they are
  // answering a question about a thread that has stopped — an elapsed awaiting fence, a PR review, a bump
  // for a worker that just rested. Delivering those mid-turn would interrupt work the worker is already
  // doing about the very thing that woke it.
  //
  // THE CLOCK-DRIVEN PAIR ARE THE EXCEPTION — the recurring prompt's SCHEDULE trigger and the worker's
  // own ONE-OFF TIMER — and it is the whole point of both. What follows is written about the heartbeat
  // because that is where the behavior was settled; a timer is the same promise made once, so holding one
  // until rest would break it in exactly the same way.
  //
  // It fires on its cadence
  // regardless of what the thread is doing (maintainer 2026-08-03 — "my intention was for the heartbeat
  // to fire on its regular cadence, regardless of whether the agent is currently running or not"). It
  // used to be held here like everything else, which quietly made it a second rest trigger: one due at
  // 14:00 on a thread that stayed busy until 14:50 arrived at 14:50, so the cadence the operator set
  // described nothing.
  //
  // Both transports take a mid-turn message natively, so this is a gate change and not a new channel.
  // Claude's broker queues it into the running CLI's command queue, which Claude Code drains at its
  // first sampling boundary (see the bridge's `interruptTurn` contract for the measured latency); the
  // codex app-server steers the live turn through `turn/steer`. Neither ABORTS what is running, which is
  // the correct reading of "fires on its cadence" — the beat is delivered, the in-flight work is not
  // cut off, and frizz's completion invariant stays intact.
  //
  // `unknown` still defers on every source, this one included: telemetry we cannot read is not a thread
  // we can safely address.
  //
  // AND THE HOLD HAS A CEILING (MID_TURN_HOLD_MAX_MS): a wake that has waited that long behind a busy
  // reading goes out anyway, so a turn that never ends — or a reading that never says so — cannot starve
  // the thread's whole queue. Measured from the row's creation, which is the instant the news existed.
  function isDeliverableNow(item: WakeDelivery, context: DeliveryContext, nowMs: number): boolean {
    if (context === "current-idle") return true
    if (context !== "current-busy") return false
    // The post-compaction trigger joins the mid-turn pair for the reason it exists at all: a compaction
    // happens WHILE the worker is working, and a re-grounding that waits for it to stop has missed the
    // window it was written for.
    if (isHeartbeatFenceId(item.fenceId) || isTimerFenceId(item.fenceId) || isCompactFenceId(item.fenceId)) return true
    return nowMs - item.createdAt >= MID_TURN_HOLD_MAX_MS
  }

  // The re-open gate's reading of the same ceiling. Only a row the scheduler itself DEFERRED qualifies —
  // never one whose lease died around a `resume` call — because that is the one expired lease whose
  // input provably never crossed the transport (see the reconcile branch that calls this).
  function heldPastBound(item: WakeDelivery, context: DeliveryContext, nowMs: number): boolean {
    return context === "current-busy"
      && item.sentAt === null
      && item.lastError === WAKE_HOLD_DEFERRAL
      && nowMs - item.createdAt >= MID_TURN_HOLD_MAX_MS
  }

  // Name the activity for the bump steer. A review carries a GitHub `state`, so an APPROVAL or a
  // CHANGES_REQUESTED is called out specifically (the two the worker most needs to act on); a plain
  // review or a conversation comment reads generically. Falls back to "activity" for an unknown state.
  // Every label fills a NOUN slot ("New GitHub ___ on owner/repo#N"), so GitHub's own verb-phrase
  // wording for CHANGES_REQUESTED is nominalized rather than pasted in.
  function activityLabel(a: GithubReviewActivity): string {
    if (a.kind === "comment") return "comment"
    switch (a.reviewState?.toUpperCase()) {
      case "APPROVED": return "approval"
      case "CHANGES_REQUESTED": return "change request"
      case "COMMENTED": return "review comment"
      case "DISMISSED": return "dismissed review"
      default: return "review"
    }
  }

  function normalizeReviewResult(
    result: GithubReviewActivity[] | GithubReviewFetchResult | undefined,
  ): GithubReviewFetchResult {
    if (Array.isArray(result)) return { status: "ok", activity: result }
    return result ?? {
      status: "error",
      failure: { kind: "shape", message: "GitHub review fetcher returned no result" },
    }
  }

  function recordReviewFailure(key: string, slug: string, result: Extract<GithubReviewFetchResult, { status: "error" }>, at: number): void {
    const signature = `${result.failure.kind}:${result.failure.message}`
    const prior = reviewFailures.get(key)
    if (prior?.signature === signature && at - prior.loggedAt < 15 * 60_000) {
      prior.suppressed++
      return
    }
    const suppressed = prior?.suppressed ? ` (${prior.suppressed} identical repeats suppressed)` : ""
    log(`waker: GitHub review check failed for ${key} (${slug}) [${result.failure.kind}] — ${result.failure.message}${suppressed}`)
    reviewFailures.set(key, { signature, loggedAt: at, suppressed: 0 })
  }

  // The status poll's twin of the pair above: one line per distinct `gh` failure per PR, repeats
  // counted, recovery said. Without it (before 2026-08-25) the poll swallowed every failure and a PR
  // the server could not read looked exactly like a quiet one.
  const statusFailures = new Map<string, { signature: string; loggedAt: number; suppressed: number }>()
  function recordStatusFailure(key: string, message: string, at: number): void {
    const prior = statusFailures.get(key)
    if (prior?.signature === message && at - prior.loggedAt < 15 * 60_000) {
      prior.suppressed++
      return
    }
    const suppressed = prior?.suppressed ? ` (${prior.suppressed} identical repeats suppressed)` : ""
    log(`waker: PR status check failed for ${key} — ${message}${suppressed}; CI and merge wakes cannot fire until \`gh\` can read it`)
    statusFailures.set(key, { signature: message, loggedAt: at, suppressed: 0 })
  }
  function recordStatusSuccess(key: string): void {
    const prior = statusFailures.get(key)
    if (!prior) return
    statusFailures.delete(key)
    log(`waker: PR status check recovered for ${key}${prior.suppressed ? `; ${prior.suppressed} identical repeats were suppressed` : ""}`)
  }

  function recordReviewSuccess(key: string, slug: string): void {
    const prior = reviewFailures.get(key)
    if (!prior) return
    const suppressed = prior.suppressed ? `; ${prior.suppressed} identical repeats were suppressed` : ""
    log(`waker: GitHub review check recovered for ${key} (${slug})${suppressed}`)
    reviewFailures.delete(key)
  }

  // ---- The limit auto-resume pass ------------------------------------------------------------------
  // Every non-archived thread whose tail still carries a limit fault and has come to rest. `turn` must
  // be idle: a thread that has already started moving again was resumed by someone else, and stepping
  // on a live turn is exactly what the fence path refuses to do too.
  interface LimitCandidate {
    slug: string
    sessionId: string
    backend: "claude" | "codex"
    fault: LimitFault
  }
  function limitCandidates(nowMs: number): LimitCandidate[] {
    const out: LimitCandidate[] = []
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      const fault = tele?.limitFault
      if (!fault || tele?.turn !== "idle") continue
      // The boot guard, and the same age policy the board renders — so a card never promises a wake
      // the waker has already written off.
      if (limitPauseIsStale(fault.window, Date.parse(fault.at), nowMs)) continue
      out.push({
        slug: row.slug,
        sessionId: row.session_id,
        backend: row.backend === "codex" ? "codex" : "claude",
        fault,
      })
    }
    return out
  }

  // The wall each thread has already spent its ONE early (account-headroom) resume on — see the guard
  // in limitRecovered. Keyed by slug, valued by limitFaultResetKey.
  //
  // The headroom trigger reads the ACCOUNT while the wall belongs to the THREAD's own process, so when
  // an early resume bounces off that wall the trigger's premise is untouched: the account still shows
  // headroom, so it fires again, and again. Each bounce writes a new fault, whose new `at` mints a new
  // fence id, so the once-per-interruption dedupe in evalLimits never bites either. Live on 2026-07-30
  // that ran every 2 minutes (exactly LIMIT_HEADROOM_MIN_FAULT_AGE_MS) for half an hour and buried a
  // worker's transcript under 184 limit records — a self-inflicted context burn on a thread that was
  // already stuck.
  //
  // In memory on purpose: a frizz restart costs one extra attempt per thread, and a durable table for a
  // guard this cheap would be a migration in exchange for nothing.
  const spentEarlyResume = new Map<string, string>()

  // Has this fault's window come back? Two independent triggers, whichever fires first:
  //   (1) the ORIGINAL window RESET — its own reset clock (5-hour session: exact, local, free) or, for a
  //       weekly whose text carries no date, the endpoint's window-identity roll.
  //   (2) quota FREED UP on the current account — the blown window now reads below the headroom floor,
  //       so a fresh sign-in or a raised cap made room even though the original clock hasn't passed
  //       (guarded by the floor + min-fault-age; see LIMIT_RESUME_HEADROOM_PERCENT).
  // `undefined` = indeterminate: wait for a later tick rather than guessing, since guessing "recovered"
  // resumes the fleet into a wall.
  function limitRecovered(
    c: LimitCandidate,
    quota: QuotaSnapshot | undefined,
    nowMs: number,
  ): boolean | undefined {
    const faultAtMs = Date.parse(c.fault.at)
    const provider = quota?.[c.backend]

    // (2) Account-availability: the blown window is no longer near-full on the signed-in account. Only
    // trusted once the fault is old enough that a warmed reading necessarily post-dates it (so we read a
    // real recovery, not a stale pre-fault value) and only when the window sits below the floor (so
    // jitter near 100% can't resume the fleet straight back into the wall).
    if (provider?.status === "ok" && Number.isFinite(faultAtMs) && nowMs - faultAtMs >= LIMIT_HEADROOM_MIN_FAULT_AGE_MS) {
      const key = quotaWindowKeyFor(c.fault.window)
      // A MODEL-scoped fault has no static key: its window is the endpoint's `weekly-<model>` scoped
      // entry, found by name. This trigger is the one that actually revives a model-capped fleet —
      // buying credits or a raised cap frees the scoped window's percent long before its weekly roll
      // (observed live 2026-08-31: the killed fleet's `weekly-fable` read 62% within the hour).
      const w = key
        ? provider.windows.find((x) => x.key === key)
        : c.fault.window === "model"
          ? scopedQuotaWindow(provider.windows, c.fault.model)
          : undefined
      const wall = limitFaultResetKey(c.fault)
      // One early resume per wall. A second fault naming the same reset instant is this thread bouncing
      // off the same wall, not a new interruption, so it gets no second attempt — it waits for trigger
      // (1), its own clock, below.
      if (w && typeof w.usedPercent === "number" && w.usedPercent <= LIMIT_RESUME_HEADROOM_PERCENT && spentEarlyResume.get(c.slug) !== wall) {
        spentEarlyResume.set(c.slug, wall)
        return true
      }
    }

    // (1) Original-window reset. Text first — exact, local, free, covers the common 5-hour session case.
    const textAt = c.fault.resetClock
      ? textResetInstant({ window: c.fault.window, resetClock: c.fault.resetClock }, faultAtMs)
      : undefined
    if (textAt !== undefined) return nowMs >= textAt + LIMIT_RESUME_GRACE_MS
    if (!provider || provider.status !== "ok") return undefined
    // A model-scoped fault rolls with its `weekly-<model>` scoped window — same identity-roll logic,
    // resolved by name instead of a static key.
    const rolled = c.fault.window === "model"
      ? scopedQuotaWindowRecovered(provider.windows, c.fault.model, faultAtMs, nowMs)
      : quotaWindowRecovered(provider.windows, c.fault.window, faultAtMs, nowMs)
    if (rolled !== true) return rolled
    return nowMs >= faultAtMs + LIMIT_RESUME_GRACE_MS
  }

  // ---- The MODEL-SCOPED cap: step down a rung instead of waiting out the week ----------------------
  //
  // A model-scoped limit is NOT the account running dry, and the provider's own message says so —
  // "You've reached your Fable 5 limit. Switch to another model, or manage usage credits … to
  // continue." Parking the thread behind that cap's `weekly-<model>` window costs up to seven days of
  // capacity the account still has, so frizz takes the provider's advice on the thread's behalf:
  // persist the next model down as the thread's profile and resume it now. The resume is a COLD one
  // (the fault has no resolvable clock, so needsFreshProcessForLimit is true), and a cold resume forks
  // `claude` with `row.model` — which is what carries the new model into argv, and the reason this
  // cannot be done by steering the live process: the SDK takes the model at query start.
  //
  // IT TERMINATES BY CONSTRUCTION, which is what makes it safe to fire without the once-per-wall guard
  // the headroom trigger needs. Every step names a DIFFERENT model, so a thread that re-caps on the
  // rung below writes a fault naming THAT model and steps down again — Fable → Opus → Sonnet → Haiku,
  // where the ladder ends and it waits out the window like any other limit. A step that fails to take
  // effect cannot loop either: the persisted model no longer matches the fault's, so the
  // same-model guard below declines and the thread falls back to waiting.
  function modelFallbackFor(c: LimitCandidate): { model: string; effort: string; label: string; capped: string } | undefined {
    if (c.backend !== "claude" || c.fault.window !== "model" || !c.fault.model) return undefined
    const row = deps.storage.getSession(c.slug)
    // Broker rows only. The cold fork is the thing that applies a new model, and only the broker
    // transport has one; a legacy row would be downgraded on paper and resumed on the old model.
    if (!row || row.claude_runtime !== "broker") return undefined
    // Restarting is how the switch happens at all, so a thread frizz may not restart cannot be
    // switched — the same fail-closed reading, on the same predicate, as the resume's own freshProcess
    // decision. Such a thread keeps the ordinary wait-for-the-window behaviour.
    const tele = deps.tailer.get(c.slug)
    if (mayHaveLiveBackgroundWork(tele)) return undefined
    const capped = claudeModelFromLimitName(c.fault.model)
    if (!capped) return undefined
    // The cap must be on the model THIS thread is running. Another thread — or a sub-agent dispatched
    // onto a model of its own — can exhaust one this thread never touched, and stepping an Opus thread
    // down to Sonnet because Fable ran dry is a downgrade that buys nothing. Read the value the resume
    // will actually spawn with (the persisted target), falling back to the observed model only where
    // the row never recorded one.
    const current = row.model?.trim() || (tele?.model ? normalizeObservedThreadModel("claude", tele.model) : undefined)
    if (!current || current !== capped) return undefined
    const next = claudeFallbackModel(capped)
    const option = next ? claudeProfile(next) : undefined
    if (!next || !option) return undefined // bottom rung: nothing left to fall to
    // Carry the thread's own effort across when the target offers it (ultracode rides only the
    // xhigh-capable models), else that model's default — the pair a fresh dispatch of it would use.
    const effort = row.effort?.trim()
    return {
      model: next,
      effort: effort && option.efforts.includes(effort) ? effort : option.defaultEffort,
      label: option.label,
      capped: c.fault.model,
    }
  }

  async function evalLimits(nowMs: number): Promise<void> {
    const candidates = limitCandidates(nowMs)
    if (candidates.length === 0) return
    // Read the quota-warmed usage snapshot. The account-availability trigger needs it for EVERY
    // candidate — a session limit included, now that a fresh sign-in or raised cap can free it before
    // its own clock — and the weekly window-roll check needs it too. This is a cached read (the server
    // keeps it warm on its own cadence), so a fleet parked on a limit doesn't hammer the endpoint.
    let quota: QuotaSnapshot | undefined
    if (deps.readQuota) {
      try {
        quota = await deps.readQuota()
      } catch (err) {
        log(`waker: quota read failed while checking limit resumes: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (const c of candidates) {
      const fenceId = limitFenceId(c.fault)
      const deliveryId = wakeDeliveryId(c.slug, c.sessionId, fenceId)
      if (outbox.get(deliveryId)) continue // this interruption already has its one wake
      // A model-scoped cap the thread can simply step down from needs no recovery at all — the account
      // is not out of capacity, this model is. Everything else waits for its window.
      const fallback = modelFallbackFor(c)
      if (!fallback && limitRecovered(c, quota, nowMs) !== true) continue
      // Persist the new pair BEFORE the wake is enqueued: the delivery forks `claude` from this row, so
      // a wake that raced ahead of the write would restart the thread on the model that just capped.
      if (fallback) deps.storage.setProfile(c.slug, fallback.model, fallback.effort)
      const item = outbox.enqueue({
        id: deliveryId,
        slug: c.slug,
        sessionId: c.sessionId,
        fenceId,
        hintKey: fallback ? `${LIMIT_HINT_PREFIX}model-switch` : `${LIMIT_HINT_PREFIX}${c.fault.window}`,
        message: fallback ? limitModelSwitchSteer(fallback.capped, fallback.label) : limitResumeSteer(c.fault.window),
        reason: fallback
          ? `${fallback.capped} limit — restarting on ${fallback.label} (interrupted ${c.fault.at})`
          : `${c.fault.window} usage limit reset (interrupted ${c.fault.at})`,
      }, nowMs).delivery
      log(`waker: queued ${c.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- The dropped-report repair pass --------------------------------------------------------------
  // `turn === "idle"` is not a courtesy here, it is the CORRECTNESS condition. The runtime hands a
  // queued notification to the model at a turn boundary, so while a turn is in flight the report may
  // still be about to arrive and a repair would be a lie. Once the agent has come to rest without it,
  // the delivery that was going to happen already didn't.
  function repairDroppedReports(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      const dropped = tele?.droppedReports
      if (!dropped?.length || tele?.turn !== "idle") continue
      // No cap and no ordering games: the watermark in completion-relay.ts means only completions
      // dropped during THIS process are eligible, so the due set is the handful a live thread actually
      // lost — not the hundreds of historical drops sitting in a long transcript.
      for (const report of completionsDueForRelay(dropped, { nowMs, atRest: true })) {
        const fenceId = reportFenceId(report.taskId)
        const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
        if (outbox.get(deliveryId)) continue // this report already has its one repair
        const item = outbox.enqueue({
          id: deliveryId,
          slug: row.slug,
          sessionId: row.session_id,
          fenceId,
          hintKey: `${REPORT_HINT_PREFIX}${report.taskId}`,
          message: relayMessage(report),
          reason: `sub-agent report never reached the model (${report.summary ?? report.taskId})`,
        }, nowMs).delivery
        log(`waker: queued ${row.slug} — ${item.reason}`)
        checkpoint("after-enqueue", item)
      }
    }
  }

  // ---- The user-snooze bump pass -------------------------------------------------------------------
  // Deliberately does NOT filter on `turn === "idle"` the way the fence pass does. A snooze deadline is
  // a promise to the human, so a thread that happens to be mid-turn when it crosses must not LOSE its
  // follow-up — the delivery gate below holds the item until the thread comes to rest instead.
  //
  // Unlike an unregistered legacy timer, an overdue snooze found at boot DOES fire: the DB row is
  // itself the durable registration, so a deadline that crossed while frizz was down is exactly the case
  // this is meant to honor. The blast radius stays bounded by the handful of threads a human snoozed.
  function evalSnoozes(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const armed = armedSnooze(row)
      if (!armed || armed.untilMs > nowMs) continue
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, armed.fenceId)
      if (outbox.get(deliveryId)) continue // this snooze already has its one wake
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId: armed.fenceId,
        hintKey: `${SNOOZE_HINT_PREFIX}${armed.until}`,
        message: armed.prompt,
        reason: `snooze elapsed (${armed.until})`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- The one-off TIMER pass ----------------------------------------------------------------------
  // One indexed read for every due alarm on every thread, rather than the row-per-session walk the other
  // passes do: timers live in their own table precisely because a thread may hold many, and most threads
  // hold none.
  //
  // Like the snooze pass, an alarm that came due while frizz was DOWN still fires when it comes back —
  // the row is its own durable registration, and "you asked to be woken at 15:00" does not stop being
  // true because the server restarted at 14:59. Unlike the snooze pass, it does not wait for rest.
  // ---- SOURCE 9: THE BUILT-IN SIGN-OFF NUDGE ---------------------------------------------------
  // Frizz's own stop hook. Always on, not disableable per-thread, and invisible in the UI — orthogonal
  // to the operator's Goal, which keeps its own three triggers.
  //
  // THE PER-THREAD OFF SWITCH WAS TRIED AND REVERTED (2026-08-13 → 2026-08-14): the Goal's then-existing
  // "Autonomous mode" silenced this for a day, on the argument that a thread told to keep going should not
  // also be handed a menu of ways to stop. What killed it is that the reminder no longer IS that menu — it
  // opens by sending a half-finished thread back to the work — and that suppressing it took the
  // ```awaiting park with it, which nothing else on that thread's deliveries names. That switch is gone
  // entirely now (2026-08-16), so re-deriving the exemption would silence this on EVERY thread with a Goal.
  // The maintainer's 2026-08-12 call stands: keep it separate from the Goal, enabled all the time. (Until
  // 2026-08-28 that meant paying one extra transcript record per rest, both going out together; the
  // record turned out to arrive stale and draw a second ```done. Now the GOAL stands down on the rest
  // this takes — evalRestPrompts — and this never stands down for the Goal.)
  //
  // It fires on a rest that carried NO FENCE AT ALL, and its message is the sign-off protocol itself.
  // The rules therefore arrive at the one moment they are about to be used, rather than 200k tokens
  // earlier in a system prompt the agent stopped attending to (maintainer 2026-08-11: "the agent seems
  // to often forget about this stuff when it's added to the additional system prompt anyway"). A thread
  // that signs off correctly never sees it, so the mechanism costs nothing except on exactly the rests
  // that were about to produce an item nobody can triage.
  //
  // THE CAP IS CONSECUTIVE AND IT IS NOT OPTIONAL. An agent that rests bare, is told how to sign off,
  // and rests bare again would otherwise be told forever — a nag loop frizz itself generates. After
  // SIGNOFF_NUDGE_MAX in a row with no fence appearing, it gives up and the item sits in the queue as a
  // plain bare rest, which is exactly today's behaviour.
  //
  // ONLY A FENCE GIVES THE ALLOWANCE BACK. This used to say a new word from the HUMAN did too, on the
  // reasoning that their message is a new task and the count was about the old one — but that was written
  // before the delivery-id fix below, and the code has never done it. It cannot: frizz's own nudge lands
  // as a USER record, so "the human spoke" is a condition the nudge satisfies by nudging, which is the
  // 22-deliveries-in-four-minutes loop that fix exists to close. The consequence is worth stating plainly
  // rather than leaving as a footnote — on a thread with a Goal armed, two bare rests exhaust this
  // permanently, and everything after is the Goal alone.
  //
  // TOP-LEVEL THREADS ONLY — a sub-agent's final message is a report to its parent, not a queue item.
  // That falls out of this pass reading session rows, which sub-agents do not have.
  function evalSignoffNudges(nowMs: number): void {
    if (deps.storage.getSetting(SIGNOFF_NUDGE_SETTING) === "off") return
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele || tele.turn !== "idle") continue
      // THE AGENT MUST HAVE SPOKEN LAST, and this is the load-bearing guard rather than a nicety.
      //
      // Frizz's own delivery lands in the transcript as a USER record, so it advances `lastActivityAt`
      // AND `lastUserAt`. Keying on either meant the nudge minted a fresh delivery id for a rest that
      // had not happened, and reset its own consecutive counter with its own message: measured on a real
      // stack, 22 deliveries in four minutes to one thread. The cap could not save it, because the thing
      // being counted was resetting the count.
      //
      // `lastAssistantAt > lastUserAt` is the honest question — did the AGENT end the exchange? — and it
      // is immune to anything frizz says, because frizz only ever speaks as the user. A thread whose last
      // word is frizz's own nudge is a thread that has not answered it yet.
      const spokeAt = tele.lastAssistantAt
      if (!spokeAt) continue
      if (tele.lastUserAt && Date.parse(tele.lastUserAt) >= Date.parse(spokeAt)) continue
      // Same trap as the stop hook's: a signed-out provider answers instantly, so the failure LOOKS like
      // a fenceless rest and satisfies every guard above. Teaching it to sign off cannot help — it never
      // reached the model.
      if (tele.authFault) continue
      // AND THE GENERAL CASE OF IT, which the auth guard above is one instance of. A FAILED TURN IS NOT A
      // REST: a synthetic API-error record is written as an assistant record, so it advances the rest
      // instant and satisfies every guard above, and a thread whose every turn fails therefore presents
      // as an agent that keeps resting without a fence. The nudge cannot be answered — nothing the agent
      // writes reaches the model — so it is pure burn, and on the error this matters most for it is
      // WORSE than pure burn: a 400 for a conversation that has outgrown the model's context window is
      // made permanent by anything that appends to the conversation, which is exactly what the nudge
      // does. Observed unbounded in the field before the cap was fixed to bind at all; both fixes are
      // needed, because the cap alone still spends two deliveries on a thread that can never use them.
      if (tele.apiFault) continue
      // ANY fence means the thread already said where it stands — including `awaiting`, which is still
      // a legitimate sign-off until the registry replaces it. Nothing to teach, AND the allowance comes
      // back: signing off is the only event that proves the nudge worked, and the only one frizz cannot
      // cause by nudging. (Guarded on a non-zero count in storage, so this is a transition, not a write
      // on every tick.)
      //
      // A REGISTRATION SAYS IT JUST AS LOUDLY, and since 2026-08-27 it is how a worker is meant to say
      // it: `done` records a row, `ask` records a row, `watch` records a row, and none of the three can
      // write the tailer's `lastFence`. Reading only the fence would nudge a worker for not writing a
      // sentence it was told to replace with a tool call — which is the protocol reminder teaching the
      // OLD protocol, on exactly the threads that adopted the new one.
      //
      // AND AN ANSWER ON ITS WAY COUNTS TOO, which is the case this guard read wrong for a day. Every
      // registration test above opens the INSTANT the human answers — the row leaves `open` and nothing
      // has replaced it yet — so the very next tick nudged a worker for resting without a fence while its
      // answer was still in the outbox. The transcript then read: the worker's rest, "FRIZZ ASKED FOR A
      // SIGN-OFF", then the human's answer (maintainer 2026-08-27, on exactly that sequence). It also
      // spent one of the two nudges this thread will ever get on a thread that had done nothing wrong.
      //
      // A CANCELLATION ON ITS WAY IS THE SAME CASE FROM THE OTHER DIRECTION (2026-09-02): arming a Goal
      // dismisses the open questions wholesale, which turned a rest that had signed off WITH a question
      // into what this pass reads as a bare one — so the nudge took the rest ("you rested without a
      // fence", to a worker whose question frizz itself had just cancelled) and the Goal stood down for
      // it. The armed-rest flag scopes it to exactly the threads whose dismissals wake on their own.
      const questionRows = deps.storage.listThreadQuestions(row.slug)
      if (
        tele.lastFence ||
        tele.pendingQuestion ||
        registeredDoneFence(deps.storage.getThreadDone(row.slug), tele.lastUserAt) !== undefined ||
        questionRows.some((q) => q.state === "open") ||
        answersInFlight(questionRows, tele.lastUserAt, row.recurring_on_rest === 1 && Boolean(row.recurring_prompt?.trim())) !== undefined ||
        deps.storage.listThreadWatches(row.slug, { armedOnly: true }).length > 0
      ) {
        if ((row.signoff_nudges ?? 0) > 0) deps.storage.resetSignoffNudges(row.slug)
        continue
      }
      // A native ask is a question by another route: the thread is frozen on a modal the human has to
      // answer, and telling it to write a ```question fence is telling it to do what it already did.
      if (tele.pendingAsk || tele.permPrompt) continue
      // The sentinel still ends the arrangement for sessions that predate the fence (see `saidDone`).
      if (tele.lastAssistantAllDone) continue
      // IT DOES NOT YIELD TO THE GOAL, and that is a deliberate reversal (maintainer 2026-08-12: "we
      // should keep it separate from goal… It should just be enabled all the time"). The reminder used
      // to ride the Goal's at-rest trailer so a rest produced one delivery instead of two — but that
      // made the protocol a thing a thread only learned if an operator had armed a Goal, and put a copy
      // of it in the trailer, which is its own kind of repetition. It is frizz's own hook now: identical
      // on every thread, whatever the operator has configured.
      // THE GOAL YIELDS TO IT INSTEAD (2026-08-28). "The second delivery costs one transcript record"
      // was the accounting here until then, and it was wrong: the two went out in one tick, 5 ms apart,
      // the runtime queued the Goal's turn first, and this message — "you rested without a fence" —
      // reached a worker that had just answered the Goal WITH one. It fenced again; two Done cards. The
      // supersession check in `deliveryContext` exists for exactly that and could not fire, because it
      // ran at send. So this pass mints first in the tick and SOURCE 5 declines the rest it took.
      // AND NO GOAL-SHAPED EXEMPTION HERE — see the SOURCE 9 header for the day it had one.
      // THE CONSECUTIVE CAP. It counts fenceless rests and is cleared ONLY by a fence (above) — never by
      // a user record, because frizz's own delivery is one, and anchoring on that let the nudge reset its
      // own counter with its own message.
      if ((row.signoff_nudges ?? 0) >= SIGNOFF_NUDGE_MAX) continue
      const fenceId = signoffFenceId(spokeAt)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      // Bound to the AGENT'S OWN last word, so one nudge per rest falls out of delivery-id uniqueness.
      // Deliberately NOT `lastActivityAt`, which frizz's own delivery advances — see the guard above.
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: SIGNOFF_HINT_KEY,
        // The reminder plus THIS THREAD's live ops and their ids, so the agent can write a correct
        // `watch:` line without going looking for an id it cannot see. Shells are named by `taskId` —
        // the handle the runtime actually showed the worker — because that is the string it will
        // naturally reach for, and the one the fence's own integrity check matches on.
        message: withClock(signoffNudgeMessage({
          shells: (tele.bgShells ?? []).filter((sh) => sh.state === "running").map((sh) => ({ id: sh.taskId ?? sh.id, label: sh.label })),
          subAgents: (tele.subAgents ?? []).filter((a) => a.state === "running").map((a) => ({ id: a.taskId ?? a.id, label: a.label })),
          // The other two registries, so the nudge lists EVERY kind an awaiting fence can name rather
          // than the two the fold happens to know about — a worker told about half its work writes half
          // a fence, and the half it left out is not what gets it bumped.
          timers: deps.storage.listThreadTimers(row.slug, { armedOnly: true })
            .map((t) => ({ id: t.id, label: t.prompt.trim().replace(/\s+/g, " ").slice(0, 80) })),
          prs: deps.storage.listPrWatches(row.slug, { armedOnly: true })
            .map((w) => ({ id: `${w.owner}/${w.repo}#${w.number}`, label: `${w.owner}/${w.repo}#${w.number}` })),
        }), spokeAt),
        reason: "rested without signing off",
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // Count a nudge against the consecutive cap. Called at SEND — the only path a wake to a live runtime
  // takes — and again when the same item is confirmed later; the storage write is idempotent per
  // anchor, so the second call for one item is a no-op rather than a double count.
  function settleSignoffNudge(item: WakeDelivery): void {
    if (!isSignoffFenceId(item.fenceId)) return
    // Anchored on the REST this nudge was for (the agent's own last word, which is the fence id), so a
    // retry of the same delivery cannot count twice while a genuinely new fenceless rest does.
    deps.storage.countSignoffNudge(item.slug, item.fenceId)
  }


  // ---- SOURCE 12: A PARK THAT RAN OUT, OR THAT NAMED SOMETHING DEAD -------------------------------
  //
  // The two ways an ```awaiting fence stops being true, and neither may pass silently — that is the whole
  // lesson of the three stalls this grammar replaced (see the AwaitingHint doc block in @frizz/shared).
  //
  //  1. IT NAMED SOMETHING THAT IS NOT RUNNING. Checked the moment the fence lands. The bump says WHICH,
  //     because "your fence is wrong" sends a worker to re-read its own transcript for an id it has
  //     already lost, and that is exactly how it got the id wrong the first time.
  //  2. IT RAN OUT. `for:` elapsed and nothing resolved. The worker is brought back to re-check
  //     everything rather than the wait simply continuing, and re-parking on the same still-running
  //     items is UNLIMITED (maintainer 2026-08-15) — a three-hour build under a one-hour estimate is a
  //     bad estimate, not a failure, and each bump is a real checkpoint where it could decide otherwise.
  /** Frizz's own message, with the clock on it. Used ONLY where frizz is the author — never on an
   *  operator-authored prompt (a Goal, a heartbeat, a snooze), whose text is delivered verbatim by
   *  invariant. A broker-run worker is told neither the date nor the time by its runtime, so without this
   *  it cannot tell a four-minute park from a four-hour one. */
  function withClock(message: string, spokeAt?: string | null): string {
    return `${message}\n\n${wakeTimeHeader(now(), spokeAt)}`
  }

  function evalParkIntegrity(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele || tele.turn !== "idle") continue
      if (tele.lastFence?.kind !== "awaiting") continue
      // The agent must have spoken last — same guard as the sign-off nudge, and for the same measured
      // reason: frizz's own delivery lands as a USER record, so keying on activity would let this reset
      // its own dedupe and bump in a loop.
      const spokeAt = tele.lastAssistantAt
      if (!spokeAt) continue
      if (tele.lastUserAt && Date.parse(tele.lastUserAt) >= Date.parse(spokeAt)) continue
      // A failed turn is not a rest — the same guard as SOURCES 5 and 9, in both its forms. (In practice
      // the error record's own text has already cleared `lastFence`, so this rarely binds; it is here so
      // the four passes that read "the agent spoke last" agree on what a failed turn is.)
      if (tele.authFault || tele.apiFault) continue

      // AN OPEN QUESTION REFUSES THE PARK OUTRIGHT, before any look at what the fence names. A question
      // outranks a wait everywhere else — deriveNeedsYou queues the thread on the open row before any
      // park excusal, and the resting card yields to it (deriveAwaitingBackground) — so a fence here
      // declares a park frizz will not honour, and the two used to render stacked: a parked-looking
      // card, hourglass and shell table, above the ask (maintainer 2026-08-28: "Weird that there's both
      // an awaiting block and open questions"; a first fix drew the fence as plain prose and was
      // rejected the same day — "it should not be allowed, basically"). So it is refused like any
      // other bad park: the correction folds out of the transcript, un-draws the fence (fenceRefused),
      // and the worker rewrites its sign-off without it — prose plus the placed question, which is what
      // the contract asks for. Counted against PARK_BUMP_MAX like the other corrections, because a
      // worker whose contract froze before this rule cannot learn it, and keyed on the rest so one
      // fence draws one bump. Checked BEFORE the honoured-park reset below on purpose: live names do
      // not make this park honoured.
      const openQuestions = deps.storage.listThreadQuestions(row.slug).filter((q) => q.state === "open")
      if (openQuestions.length > 0) {
        if ((row.park_bumps ?? 0) >= PARK_BUMP_MAX) continue
        const fenceId = parkFenceId("question", spokeAt)
        const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
        if (outbox.get(deliveryId)) continue
        const one = openQuestions.length === 1
        const message = [
          `${PARK_CORRECTION_QUESTION_LEAD}${one ? "a question of yours was" : "questions of yours were"} still OPEN, so frizz refused the park — a question outranks a wait, and this thread sits in the human's queue on ${one ? "it" : "them"}.`,
          "",
          ...openQuestions.map((q) => `- \`${q.id}\` — ${questionLine(q.spec)}`),
          "",
          "Never fence ```awaiting while a question stands. Rewrite your sign-off WITHOUT the fence: your",
          "handoff prose — each open question draws its own card at that rest, so write the reasoning",
          "around the ask, never the ask again. Your running work is watched and listed either way: a shell, a",
          "sub-agent, a timer or a registered PR wakes you fence or no fence. A question you no longer need",
          "answered is one you withdraw with `mcp__frizz__unask` — only then can a park take.",
        ].join("\n")
        const item = outbox.enqueue({
          id: deliveryId,
          slug: row.slug,
          sessionId: row.session_id,
          fenceId,
          hintKey: fenceId,
          message: `${message}\n\n${wakeTimeHeader(nowMs, spokeAt)}`,
          reason: `awaiting fence beside ${openQuestions.length} open question(s)`,
        }, nowMs).delivery
        deps.storage.countParkBump(row.slug, fenceId)
        log(`waker: queued ${row.slug} — ${item.reason}`)
        checkpoint("after-enqueue", item)
        continue
      }

      const park = readAwaitingPark(tele.lastFence.hints)
      const live = liveActivityOf(
        tele,
        registeredPrWatchesOf(deps.storage, row.slug),
        armedTimerIdsOf(deps.storage, row.slug),
      )
      const dead = unaccountedItems(park.items, live)
      const expiresAt = parkExpiresAt(park, Date.parse(spokeAt))
      const expired = expiresAt !== null && nowMs >= expiresAt
      // NAMES NOTHING — the loudest case, and it was the silent one. A fence carrying only `for:` and
      // `reason:` is a worker declaring a wait with NOTHING that can wake it: frizz refuses the park, the
      // thread queues, and until 2026-08-16 nobody told the worker why. It was routed to the sign-off
      // nudge, which only fires on a rest carrying NO fence — so this exact shape got nothing at all.
      //
      // Observed in the wild, which is why it is now the most explicit bump of the three: `for: 24h` plus
      // "TypeScript legs still running on 1a5d0804 … waiting on the checks and your merge" — a worker
      // that could have registered a PR watcher and been told the moment CI settled, waiting on nothing
      // for a day instead.
      const nameless = park.items.length === 0
      // HONOURED ⇒ the corrective allowance comes back. A park frizz can actually honour is the one
      // event that proves a correction landed, and — unlike any activity signal — not one frizz can
      // cause by correcting. Guarded on a non-zero count so this is a transition, not a write on every
      // tick, exactly as the sign-off nudge's reset is. It deliberately does NOT `continue`: an honoured
      // park can still have run out, and that bump is owed.
      if (parkIsHonoured(park, live) && (row.park_bumps ?? 0) > 0) deps.storage.resetParkBumps(row.slug)
      if (dead.length === 0 && !expired && !nameless) continue
      // No `for:` at all is a MALFORMED fence rather than a wrong one, and the sign-off nudge teaches the
      // whole grammar in one message — a better teacher than a correction aimed at one line.
      if (park.forMs === null && !nameless) continue

      // FINISHED IS NOT THE SAME AS MISSING, and conflating them is what drove the worst churn observed.
      // `read-the-file-read-up` wrote 284 awaiting fences: it parked on a build, the build FINISHED, and
      // frizz answered "NOT RUNNING" — which reads as "your fence is broken", so the worker relaunched
      // instead of reading the output it was waiting for, and went round again. Frizz knows the
      // difference (the fold retires a shell with its finish instant), so it should say which.
      const finishedHandles = new Set<string>()
      for (const sh of tele.retiredShells ?? []) {
        for (const h of [sh.taskId, sh.id, sh.label]) if (h) finishedHandles.add(h)
      }
      // FINISHED-not-MISSING holds for every kind, not only shells (it shipped shell-only). A sub-agent
      // that RETURNED reads `rested` in telemetry, and a timer that FIRED keeps its settled row — frizz
      // can tell all three apart from a typo'd id, and the note below spends that knowledge. `stale`
      // stays out: it means "completion signal lost", which is genuinely ambiguous, not finished.
      for (const a of tele.subAgents ?? []) {
        if (a.state !== "rested") continue
        for (const h of [a.taskId, a.id, a.label]) if (h) finishedHandles.add(h)
      }
      const firedTimers = new Set(
        deps.storage.listThreadTimers(row.slug).filter((t) => t.state === "fired").map((t) => t.id),
      )
      const finishedItem = (i: { kind: string; value: string }) =>
        finishedHandles.has(i.value) || (i.kind === "timer" && firedTimers.has(i.value))
      const status = park.items.map((i) => {
        const gone = dead.some((d) => d.kind === i.kind && d.value === i.value)
        // AN UNREGISTERED PR GETS ITS OWN NOTE, because "nothing by that name" is true but useless for
        // this one kind. A shell or a sub-agent is unaccounted because it FINISHED or the id is wrong;
        // a PR is unaccounted because the worker never registered it — a different mistake with a
        // different fix, and naming the fix here is the whole basis of the maintainer's 2026-08-24
        // decision to keep declaring and registering separate ("the worker learns to call the tool
        // first"). Without this line the correction sends it to `mcp__frizz__activity`, which will
        // faithfully report that it has no PRs — true, and no help at all.
        const note = !gone
          ? "still running"
          // A fired timer's "result" is the wake itself, already delivered as a user turn — so the
          // note points back at the transcript rather than at a result that is not a thing.
          : i.kind === "timer" && firedTimers.has(i.value)
          ? "already FIRED — its wake was delivered; there is nothing left to wait on"
          : finishedItem(i)
          ? "FINISHED — its result is waiting for you"
          : i.kind === "pr"
          ? "NOT REGISTERED — register it with `mcp__frizz__watch_pr` first, then name it here"
          : "NOT RUNNING (nothing by that name)"
        // The PLURAL key, because that is what the worker has to write. `i.kind` is the internal wire
        // kind and stayed singular through the 2026-08-24 YAML cutover; printing it raw taught a
        // spelling the parser now refuses.
        return `- \`${AWAITING_KEY_OF[i.kind]}: [${i.value}]\` — ${note}`
      })
      // When EVERY dead name simply finished, the news is not "your fence is wrong" — it is "the thing
      // you were waiting for is done". Different fact, different next action.
      const allFinished = dead.length > 0 && dead.every(finishedItem)
      const retired = retiredAwaitingKindsIn(tele.lastFence.body ?? "")
      const head = retired.length > 0
        ? [
          // The LEAD comes from shared so the transcript can recognise this delivery as a correction and
          // drop it (isParkCorrection) — one string, written and read in one place, never two that drift.
          `${PARK_CORRECTION_RETIRED_LEAD}${retired.length === 1 ? "a line kind" : "line kinds"} that no longer exist, so frizz ignored ${retired.length === 1 ? "it" : "them"} — the`,
          "fence named nothing and your thread stayed in the queue.",
          "",
          ...retired.map((k) => `- \`${k}:\` is GONE → ${RETIRED_AWAITING_REPLACEMENT[k]}`),
          "",
          "THE FRONTMATTER IS YAML, and every key is checked against something frizz can see:",
          "",
          "```awaiting",
          "shells: [<runtime task id>]   background shells you launched",
          "agents: [<runtime agent id>]  sub-agents you dispatched",
          "timers: [tmr_…]               timers from `mcp__frizz__timer`",
          "prs:    [owner/repo#123]      PRs registered with `mcp__frizz__watch_pr`",
          "for:    2h                    REQUIRED — a DURATION, never an instant",
          "---",
          "your handoff prose, as much as you want",
          "```",
          "",
          "Keep the keys you need and drop the rest. There is NO prose above the `---`: a colon or a ` #`",
          "in a sentence breaks the YAML, which is why `reason:` is gone.",
          "",
          "`mcp__frizz__activity` lists everything you have running, and prints it back as a ready-to-paste",
          "fence. If you are not waiting on anything, you are not awaiting — end with ```done, or ask a",
          "```question.",
        ].join("\n")
        : nameless
        ? [
          `${PARK_CORRECTION_NAMES_LEAD}nothing to wait on, so it is not a park — your thread is still`,
          "in the queue, and nothing will wake you.",
          "",
          "A wait has to be something frizz can SEE. Register one, then name it:",
          "",
          "- a pull request → `mcp__frizz__watch_pr` (it wakes you on CI going green or red, and on every",
          "  later review and comment) → `prs: [owner/repo#123]`",
          "- a wall-clock check → `mcp__frizz__timer` → `timers: [tmr_…]`",
          "- work you already launched → `shells: [<the id your runtime gave you>]` or `agents: [<id>]`",
          "",
          "The frontmatter is YAML: PLURAL keys, each taking a list, and your prose below the `---`.",
          "Use `mcp__frizz__activity` to read it all back as a ready-to-paste fence.",
          "",
          "AND IF YOU ARE NOT WAITING ON ANYTHING, you are not awaiting — you are done. End with ```done,",
          "or ask a ```question if you need the human.",
        ].join("\n")
        // THESE TWO LIVE IN @frizz/shared, beside the parsers that read them back. Same rule as
        // `limitResumeSteer`: a formatter the chat cannot parse falls through FrizzWake's legacy
        // fallback and prints its agent-facing body verbatim as a bordered card. The wording is
        // unchanged — only its address is.
        : expired
        ? parkExpiredWakeMessage(status)
        : allFinished
        ? parkFinishedWakeMessage(status, dead.length !== 1)
        : [
          `${PARK_CORRECTION_NAMES_LEAD}${dead.length === 1 ? "something that is" : "things that are"} not running, so it is not a park and your thread stayed in the queue.`,
          "",
          ...status,
          "",
          "Use `mcp__frizz__activity` to read back what you actually have out, with the exact id each line",
          "needs, then re-fence naming only those — or end in ```done or a ```question if there is nothing",
          "left to wait for.",
        ].join("\n")

      const cause = retired.length > 0 ? "retired" : nameless ? "nameless" : expired ? "expired" : "dead"
      // THE IDS, INLINE — not a tool name. Every correction here used to end at "use
      // `mcp__frizz__activity`", which a worker dispatched before that tool existed cannot call: its MCP
      // server is frozen at dispatch. Those are precisely the threads still writing fences this check
      // refuses, so the one remedy on offer was unreachable by the population that needed it. The lines
      // below can be copied straight into a fence, and the tool remains the on-demand form of the same
      // list. `expired` is excluded: its status list already names every item, by definition still live.
      const ops = cause === "expired" ? [] : liveOpsLines({
        shells: (tele.bgShells ?? []).filter((sh) => sh.state === "running").map((sh) => ({ id: sh.taskId ?? sh.id, label: sh.label })),
        subAgents: (tele.subAgents ?? []).filter((a) => a.state === "running").map((a) => ({ id: a.taskId ?? a.id, label: a.label })),
        timers: deps.storage.listThreadTimers(row.slug, { armedOnly: true })
          .map((t) => ({ id: t.id, label: t.prompt.trim().replace(/\s+/g, " ").slice(0, 80) })),
        prs: deps.storage.listPrWatches(row.slug, { armedOnly: true })
          .map((w) => ({ id: `${w.owner}/${w.repo}#${w.number}`, label: `${w.owner}/${w.repo}#${w.number}` })),
      })
      // NOTHING RUNNING is itself the answer, and the most common one for a nameless fence: a worker
      // waiting on nothing is not awaiting, it is done. Said plainly rather than left as an empty list.
      // THE CLOCK, on frizz's own correction. A broker-run worker is told neither the date nor the time by
      // its runtime (measured: zero date injections across an entire session), so it cannot tell that the
      // `for: 1h` it keeps writing has never once been reached — its last four parks each lasted minutes.
      // Elapsed is the feedback that turns the next `for:` into a judgement instead of a guess.
      const clock = wakeTimeHeader(nowMs, spokeAt)
      const message = ops.length > 0
        ? `${head}\n${ops.join("\n")}`
        : cause === "expired"
        ? head
        : `${head}\n\nYou have NOTHING running right now — no shell, no sub-agent, no timer, no registered\npull request. There is nothing that could wake you, so this thread is not awaiting: finish in\n\`\`\`done, or ask a \`\`\`question.`
      // THE CONSECUTIVE CAP, and the reason SOURCE 12 needed one. A correction is only worth sending to a
      // worker that can act on it, and a worker whose contract froze before this grammar existed cannot:
      // no fence it knows how to write will pass the check. Uncapped, that is a closed loop — bump, wake,
      // rest on the same bad fence under a new instant, bump — and it ran on the live board for 4h45m at
      // 617 bumps to a single thread, one every ~28 seconds, before anyone counted them (2026-08-17).
      //
      // `expired` is exempt because it is not a correction: the fence was right, the clock ran out, and
      // re-parking on still-running work is unlimited by explicit decision (maintainer 2026-08-15, "a
      // three-hour build under a one-hour estimate is a bad estimate, not a failure").
      if (cause !== "expired" && (row.park_bumps ?? 0) >= PARK_BUMP_MAX) continue
      // Keyed on the REST plus which failure it is, so one fence gets one bump per cause: a park that is
      // bumped for a dead id and later expires is two different pieces of news.
      const fenceId = parkFenceId(cause, spokeAt)
      const messageWithClock = `${message}\n\n${clock}`
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: fenceId,
        message: messageWithClock,
        reason: retired.length > 0 ? `awaiting fence uses retired kind(s): ${retired.join(", ")}` : nameless ? "awaiting park names nothing" : expired ? "awaiting park expired" : `awaiting park named ${dead.length} dead item(s)`,
      }, nowMs).delivery
      // COUNTED AT ENQUEUE, not at delivery — the one place the sign-off nudge's idiom does not transfer.
      // A nudge counts when it lands because it fires on a rest the thread is dispatchable for; a
      // correction is enqueued whenever a bad fence is seen, and that can outrun the delivery loop. Pinned
      // by the loop test: settling on delivery left the cap unreached and 12 unlearning rests drew 12
      // bumps, which is the runaway this exists to stop.
      if (cause !== "expired") deps.storage.countParkBump(row.slug, fenceId)
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- SOURCE 11: THE REGISTERED PR WATCHERS ------------------------------------------------------
  // A worker registers a pull request with `mcp__frizz__watch_pr` and frizz brings it back whenever
  // something happens on it (maintainer 2026-08-14: "The agent should have a tool to register a PR
  // watcher… it should get notified when CI either succeeds or failed and on follow-up reviews and
  // comments").
  //
  // IT REPORTS REPEATEDLY, which is what makes it unlike every other source here. A timer rings once and
  // is spent; this one stays armed across CI going red, a fix, CI going green and a reviewer's comment —
  // four wakes from one registration. So the delivery id carries a REPORT NUMBER: keyed on the watcher
  // id alone, the outbox would dedupe every wake after the first and the watcher would look broken from
  // the second event onward.
  //
  // ONLY A CHANGE FIRES. The cursor holds what has already been reported — the review activity ids, and
  // the last check verdict announced — so a poll that finds the same red CI and the same three comments
  // says nothing. A watcher that re-reported its own last message on every tick is a nag loop with an
  // API bill.
  //
  // THE FENCE IS NOT CONSULTED HERE, deliberately. Registration is a tool call and watching is a fact;
  // the ```awaiting fence separately STATES what the thread waits on, and a thread with no fence at all
  // is woken exactly the same way.
  type PrWatchChecks = NonNullable<Parameters<typeof prWatchWakeMessage>[0]["checks"]>
  /** WHAT THE WATCHER'S LATEST REPORT SAYS, structurally — the inputs its message was built from — so a
   *  poll that finds more news while that report is still waiting can mint one that says all of it
   *  (see the re-mint in evalPrWatches). Written at every mint; read only while a report is undelivered. */
  interface PrWatchHeld { items: GithubWakeItem[]; omitted: number; checks?: PrWatchChecks; changes?: string[] }
  /** `merge`, `labels` and `reviewers` are the PR's own state as of the last poll, and they are a
   *  BASELINE before they are a trigger: absent (a watcher armed before 2026-09-04, or a poll that fell
   *  back to `gh`, which does not fetch them) means "not known", so the next poll records them and says
   *  nothing. Reporting a PR's existing labels as news the first time frizz looks at them would spend a
   *  turn on facts the worker put there itself — the same rule the review baseline already follows. */
  interface PrWatchCursor {
    seen: string[]
    checks?: string
    report?: number
    held?: PrWatchHeld
    merge?: string
    labels?: string[]
    reviewers?: string[]
  }
  const prWatchPolledAt = new Map<string, number>() // refKey → last fetch, shared across threads
  const prStatusFallback = concurrencyGate(PR_STATUS_FALLBACK_LIMIT)

  function readPrWatchHeld(raw: unknown): PrWatchHeld | undefined {
    if (!raw || typeof raw !== "object") return undefined
    const h = raw as Record<string, unknown>
    if (!Array.isArray(h.items)) return undefined
    const items = h.items.flatMap((i: unknown) => (GithubWakeItem.safeParse(i).success ? [i as GithubWakeItem] : []))
    const c = h.checks && typeof h.checks === "object" ? h.checks as Record<string, unknown> : undefined
    const checks: PrWatchChecks | undefined = c && (c.verdict === "passing" || c.verdict === "failing" || c.verdict === "gated")
      ? {
        verdict: c.verdict,
        passed: Number(c.passed) || 0,
        failed: Number(c.failed) || 0,
        failing: Array.isArray(c.failing) ? c.failing.filter((x: unknown): x is string => typeof x === "string") : [],
        // Absent on a report held across the 2026-09-04 upgrade. Read as 0/[] rather than defaulted at
        // the formatter, so a folded-forward report says exactly what its own poll saw and no more.
        skipped: Number(c.skipped) || 0,
        gated: Number(c.gated) || 0,
        gating: Array.isArray(c.gating) ? c.gating.filter((x: unknown): x is string => typeof x === "string") : [],
      }
      : undefined
    const changes = Array.isArray(h.changes) ? h.changes.filter((x: unknown): x is string => typeof x === "string") : undefined
    return { items, omitted: Number(h.omitted) || 0, ...(checks ? { checks } : {}), ...(changes?.length ? { changes } : {}) }
  }

  /** A list of strings off a cursor, or `undefined` for "this poll never knew" — which is a third state
   *  and not the same as an empty list. A PR with no labels and a poll that could not read them must not
   *  compare equal, or the first real reading would announce every label as newly added. */
  const readCursorList = (raw: unknown): string[] | undefined =>
    Array.isArray(raw) ? raw.filter((x: unknown): x is string => typeof x === "string") : undefined

  /** What changed about the PR ITSELF since the last poll — everything the watcher now sees that is
   *  neither CI nor a comment. Each entry is one clause of the wake's own sentence.
   *
   *  ONLY THE DIRECTIONS THAT ARE ACTIONABLE, deliberately. A PR that starts conflicting is work the
   *  worker must do; one that stops conflicting stopped because somebody did that work, and telling them
   *  is a wake spent on their own commit. A review REQUESTED names who is now expected to look; a
   *  request withdrawn does not need a turn. Labels go both ways because on a real project they are the
   *  state machine — `needs-ci`, `blocked`, `author ready`, `commit-queue-failed` — and losing one is as
   *  much news as gaining it. */
  function prStateChanges(
    cursor: PrWatchCursor,
    merge: string | undefined,
    labels: string[] | undefined,
    reviewers: string[] | undefined,
  ): string[] {
    const out: string[] = []
    if (merge === "conflicting" && cursor.merge !== undefined && cursor.merge !== "conflicting") {
      out.push("now CONFLICTS with the base branch")
    }
    if (labels && cursor.labels) {
      const added = labels.filter((l) => !cursor.labels!.includes(l))
      const removed = cursor.labels.filter((l) => !labels.includes(l))
      // The minus is U+2212, matching the plus in width so a list of both reads as one column.
      const parts = [...added.map((l) => `+${l}`), ...removed.map((l) => `−${l}`)]
      if (parts.length) out.push(`labels ${parts.join(", ")}`)
    }
    if (reviewers && cursor.reviewers) {
      const added = reviewers.filter((r) => !cursor.reviewers!.includes(r))
      if (added.length) out.push(`review requested from ${added.join(", ")}`)
    }
    return out
  }

  function readPrWatchCursor(raw: string | null): PrWatchCursor {
    try {
      const parsed = raw ? JSON.parse(raw) : null
      if (!parsed || typeof parsed !== "object") return { seen: [] }
      const seen = Array.isArray(parsed.seen) ? parsed.seen.filter((x: unknown): x is string => typeof x === "string") : []
      const held = readPrWatchHeld(parsed.held)
      const labels = readCursorList(parsed.labels)
      const reviewers = readCursorList(parsed.reviewers)
      return {
        seen,
        checks: typeof parsed.checks === "string" ? parsed.checks : undefined,
        report: Number(parsed.report) || 0,
        ...(held ? { held } : {}),
        ...(typeof parsed.merge === "string" ? { merge: parsed.merge } : {}),
        ...(labels ? { labels } : {}),
        ...(reviewers ? { reviewers } : {}),
      }
    } catch {
      return { seen: [] }
    }
  }

  async function evalPrWatches(nowMs: number): Promise<void> {
    // EXPIRY FIRST, so an expired watcher is never polled again and never fires one last time on its way
    // out. A PR nobody touches would otherwise be polled forever, and a thread parked on it would wait
    // forever with it — the unbounded wait this whole grammar exists to end (maintainer 2026-08-15).
    // The worker is TOLD, because a watcher that vanishes silently is the same stall in a new costume:
    // it would rest believing it is covered.
    //
    // AND THE WAKE STAYS, even though the wake is what the noise was made of. The fix was the CEILING,
    // not this branch: an expiry now means the worker's own chosen duration genuinely ran out, which is
    // real news and rare. Muting it instead would have bought quiet by making the failure silent —
    // exactly the trade the paragraph above refuses.
    for (const w of deps.storage.expiredPrWatches(nowMs)) {
      const row = deps.storage.getSession(w.thread_slug)
      deps.storage.settlePrWatch(w.id, nowMs)
      const ref = `${w.owner}/${w.repo}#${w.number}`
      log(`waker: settled ${w.thread_slug} — pr watcher ${w.id} expired (${ref})`)
      if (!row || row.state === "archived" || row.archived === 1) continue
      const fenceId = prWatchExpiredFenceId(w.id)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: fenceId,
        // In @frizz/shared beside `parsePrWatchExpiredWake`, for the reason above.
        message: prWatchExpiredWakeMessage(ref),
        reason: `pr watcher ${w.id} expired (${ref})`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
    const armed = deps.storage.armedPrWatches()
    if (armed.length === 0) return
    // ONE FETCH PER PR, however many threads watch it. Two workers on the same PR is the ordinary shape
    // of a review round, and paying GitHub twice for one answer is how a rate limit arrives.
    //
    // AND NOT AT ALL FOR AN ARCHIVED THREAD (2026-09-04). The row stays ARMED, deliberately — an archived
    // thread can be reopened and the watch is still the worker's own outstanding intent, which is why the
    // loop below skips rather than settles it. But the fetch that fed that skip was already made: every
    // reading for an archived thread's PR was computed and thrown away. Nothing gates archiving the way
    // `done` is gated (markOwnDone REFUSES while a watcher is armed; archiving does not), so a thread
    // parked on a 180d watcher can be archived and go on polling GitHub for six months for readings no
    // thread can receive. Skipped per WATCHER, not per ref, so a PR a live thread also watches still
    // costs exactly one fetch.
    const threadLive = new Map<string, boolean>()
    const isThreadLive = (slug: string): boolean => {
      const cached = threadLive.get(slug)
      if (cached !== undefined) return cached
      const row = deps.storage.getSession(slug)
      const live = !!row && row.state !== "archived" && row.archived !== 1
      threadLive.set(slug, live)
      return live
    }
    const refs = new Map<string, PrRef>()
    for (const w of armed) {
      if (!isThreadLive(w.thread_slug)) continue
      const key = `${w.owner}/${w.repo}#${w.number}`
      const last = prWatchPolledAt.get(key) ?? 0
      if (nowMs - last < PR_WATCH_POLL_MS) continue
      refs.set(key, { owner: w.owner, repo: w.repo, number: w.number })
    }
    const status = new Map<string, GithubWatchStatus>()
    const activity = new Map<string, GithubReviewActivity[]>()
    /** The PR's own state, which `GithubWatchStatus` does not carry — it is a CI projection, and these
     *  are triggers rather than a readout. `undefined` for a ref the `gh` fallback served, which does not
     *  ask for them; that is the "not known" the baseline rule turns on. */
    const meta = new Map<string, { labels?: string[]; reviewRequests?: string[] }>()
    await Promise.all([...refs].map(async ([key, ref]) => {
      prWatchPolledAt.set(key, nowMs)
      // ONE REQUEST FOR BOTH HALVES (2026-09-04). The review fetch and the status fetch used to be two
      // independent trips per PR — a batched GraphQL query, plus `gh pr view` and `gh run list` as
      // subprocesses — which on this machine's 7 armed watchers meant 14 children a minute for facts that
      // hang off the same pull request and price at the same 1 GraphQL point together as apart. The
      // status now rides the query that was already being made, so a poll of 20 PRs is one HTTP request
      // and no children.
      //
      // `fetchPr` REMAINS THE FALLBACK, and it is not vestigial: an injected fetcher (every scheduler
      // test that predates this) returns activity with no `pr`, and so does a response frizz cannot
      // interpret. Falling back there keeps a watcher polling rather than going quiet on a shape
      // surprise — which is the failure mode this whole source exists to prevent. It runs through
      // `prStatusFallback` because it is the poll's only subprocess and a batch fails all at once; see
      // PR_STATUS_FALLBACK_LIMIT.
      let snapshot: PrStatus | undefined
      let deferred = false
      try {
        const result = normalizeReviewResult(await fetchGithubReview(ref))
        if (result.status === "deferred") deferred = true
        if (result.status === "ok") {
          activity.set(key, result.activity)
          if (result.pr) snapshot = { ...result.pr, rollup: result.pr.rollup as PrStatus["rollup"] }
          // RECOVERY IS SAID OUT LOUD, and it also clears the suppression counter. Without this the
          // failure entry for a ref lives forever, so a PR that failed once and then healed keeps
          // suppressing its own diagnostics and the operator is never told the outage ended.
          recordReviewSuccess(key, "pr-watch registry")
        } else if (result.status === "error") recordReviewFailure(key, "pr-watch registry", result, nowMs)
      } catch (err) {
        recordReviewFailure(key, "pr-watch registry", {
          status: "error",
          failure: { kind: "network", message: err instanceof Error ? err.message : String(err) },
        }, nowMs)
      }
      // A DEFERRED BATCH IS NOT A FALLBACK CASE. `deferred` is the fetcher's rate-limit budget guard
      // saying "do not spend on GitHub this tick" — so shelling out to `gh` for the same PR spends the
      // very allowance the guard just protected, through two subprocesses instead of a share of one
      // batched request. Silence is what a defer is FOR; `st`/`acts` are both absent, the loop below
      // skips the ref, and the next poll asks again once the budget recovers.
      try {
        const pr = snapshot ?? (deferred ? undefined : await prStatusFallback(() => fetchPr(ref)))
        if (pr) {
          status.set(key, githubWatchStatus(pr, new Date(nowMs).toISOString()))
          meta.set(key, { labels: pr.labels, reviewRequests: pr.reviewRequests })
          publishGithubStatus(key, pr, nowMs)
          recordStatusSuccess(key)
        }
      } catch (err) {
        // Once per distinct failure, then a count — the same rule the review check uses, because a
        // status poll that cannot read the PR fails identically every 60s for as long as the cause
        // stands, and a log that repeats it 1,440 times a day is one nobody reads.
        recordStatusFailure(key, err instanceof Error ? err.message : String(err), nowMs)
      }
    }))

    for (const w of armed) {
      const row = deps.storage.getSession(w.thread_slug)
      // No thread, or a shelved one: nothing to wake. The row is left ARMED rather than settled — an
      // archived thread can be reopened, and the watch is still the worker's own outstanding intent.
      if (!row || row.state === "archived" || row.archived === 1) continue
      const key = `${w.owner}/${w.repo}#${w.number}`
      const st = status.get(key)
      const acts = activity.get(key)
      if (!st && !acts) continue // nothing fetched for this PR this tick
      const cursor = readPrWatchCursor(w.cursor)
      // ONE UNDELIVERED REPORT PER WATCHER (2026-08-28). A report is not deliverable mid-turn, so a
      // watcher whose PR kept moving while its thread worked minted one per poll and the outbox held
      // them all: eleven went to one thread within two seconds the moment it rested (thread
      // `yeah-we-definitely-don-t-do-enough`, 2026-08-27 00:53), three of them "CI FAILED" with job
      // lists the later ones had already replaced — the same stale-second-wake shape as the Goal after
      // the sign-off nudge (evalRestPrompts). A merge or close supersedes the waiting report outright,
      // below, because a worker that reads "CI failed" and then "merged" back to back starts fixing a
      // PR that is gone.
      //
      // AND THE WAITING REPORT IS RE-MINTED, NOT HELD (2026-09-03). Until then this poll held the cursor
      // while a report waited and minted nothing, so the report that followed delivery carried the
      // delta — nothing lost, nothing said twice, but TWO TURNS for one stretch of activity, the first of
      // them saying only what it knew when it was minted. With the quiet window (wake-store.ts) a report
      // now routinely waits minutes, which made that second turn the common case rather than the busy-
      // thread edge. So a poll that finds news while a report waits SUPERSEDES it and mints the next
      // number saying everything since the last report the worker actually read: the union of what the
      // waiting one said (`cursor.held`, its own structural inputs) and what is new — the LATEST verdict
      // (a green run on the new head is the news; the red one it replaces is not), every review item
      // either knew, capped the way one poll's burst is capped. The cursor advances on every poll as it
      // always has, so nothing is re-evaluated and the report after delivery starts from what was sent.
      const waiting = undeliveredPrWatchReport(row.slug, w.id)

      // A MERGED OR CLOSED PR ends the watch. Report it once, then settle: there is nothing further to
      // say, and an armed row on a finished PR is a poll that can never produce another wake.
      if (st && st.state !== "open") {
        deps.storage.settlePrWatch(w.id, nowMs)
        if (waiting) outbox.supersede(waiting.id, nowMs, `replaced by the watcher's ${st.state} report`)
        enqueuePrWatchWake(row, w.id, nextReport(cursor), prWatchWakeMessage({
          target: key, merged: st.state === "merged", closed: st.state === "closed",
        }), `pr-watch ${key} ${st.state}`, nowMs)
        continue
      }
      // A waiting report minted BEFORE the re-mint existed carries no `held`, so its words cannot be
      // folded forward; that one is held the old way — no report, no cursor write — until it is sent, and
      // the report after it carries the delta as before. Exactly the pre-upgrade behaviour, for exactly
      // the rows written before the upgrade.
      if (waiting && !cursor.held) continue

      // CI reaching a TERMINAL verdict, and only on the transition to it. `running` and `none` are not
      // news; going from either to green or red is the whole reason CI is watched.
      //
      // KEYED ON THE HEAD COMMIT, not on the verdict word alone — that was a silent miss, reported
      // 2026-08-17 against `investigate-nubjs-nub-728` watching nubjs/nub#761. The cursor held the bare
      // string "failing", so the SECOND failure never fired: CI goes red (reported, cursor = "failing"),
      // the worker pushes a fix, CI runs and goes red AGAIN — same word, `checksChanged` false, nothing
      // said. The worker sat waiting on a watcher that had already spent its only transition, which is
      // the exact class of dead wait this whole grammar exists to make impossible. Red again on a NEW
      // commit is the most actionable news a watcher has, and it was the one thing it could not say.
      //
      // AND `gated` IS A THIRD REPORTABLE STATE (2026-09-04). It is not a verdict — nothing has run — but
      // it is the one CI reading that will never resolve on its own, so silence about it is the dead wait
      // this grammar exists to prevent: the workflows sit unapproved until a maintainer presses the
      // button, and the worker's only move is to go and ask. It ranks BELOW a real verdict: a red job
      // beside a gated workflow is still the news, and `githubWatchStatus` already resolves that.
      const terminal = st && (st.checks === "passing" || st.checks === "failing")
        ? st.checks
        : st && st.gated > 0 ? "gated" as const : undefined
      // `<head>:<verdict>:<failing jobs>`, so EVERY distinct failure speaks and only an unchanged reading
      // is quiet. The commit alone was not enough: a job re-run on the same head, or a slower job going
      // red after the first, is a second failure the worker has to hear about and neither moves the SHA.
      //
      // A LEGACY CURSOR (the bare word, written before this) can never equal a stamp, so every armed
      // watcher re-announces its current verdict ONCE on the first poll after the upgrade and is
      // correctly keyed forever after. That is the whole migration, and it is deliberate rather than
      // tolerated: there were 7 armed watchers in total when this landed, one of them the failing PR that
      // prompted the report. Special-casing the legacy shape to suppress those 7 messages would have left
      // the reported bug live on exactly the thread that reported it, until its CI happened to flip
      // colour — buying silence at the cost of the fix.
      const stamp = terminal !== undefined ? `${st?.head ?? "?"}:${terminal}:${st?.failureSig ?? ""}` : undefined
      const checksChanged = stamp !== undefined && cursor.checks !== stamp
      // NEW review activity, against everything already reported. On the FIRST poll there is nothing
      // reported yet, so the baseline is the REGISTRATION INSTANT: a worker registers when it opens or
      // pushes a PR, so anything already there is its own news and telling it would spend a turn — while
      // anything arriving in the up-to-60s before the first poll is real and must not be swallowed.
      // (Registering on an OLD PR is the same rule read the other way: the review you never read is
      // yours to go and read, and only what lands afterwards is a wake.)
      const seen = new Set(cursor.seen)
      const firstPoll = w.cursor === null
      // NEWEST FIRST, and it is load-bearing twice over: the cap must keep the items that matter MOST,
      // and the steer must then read in the order the conversation was written. The fetcher's own order
      // is neither — `parseGithubReviewActivities` returns every review, then every comment — so slicing
      // its front would enumerate a burst out of order AND, past the cap, drop the newest activity while
      // keeping the oldest. Same three lines as the fence path this replaced, for the same reasons.
      const newestFirst = [...(acts ?? [])].sort((a, b) => {
        const at = Date.parse(b.at ?? "") - Date.parse(a.at ?? "")
        return Number.isFinite(at) && at !== 0 ? at : b.id.localeCompare(a.id)
      })
      // NOISE IS FILTERED HERE, after `seen` and before the steer: a deploy-preview table, a coverage
      // badge, a "trial ended" banner is a poll result, never a wake (`pr-watch-noise.ts` — measured
      // list, 2026-08-28). The cursor below folds in ALL of `acts`, muted included, so a muted item is
      // never re-evaluated; and when a poll finds ONLY muted activity, `reviewSteer` stays undefined,
      // so the existing "nothing to say, but the baseline moved" branch advances the cursor silently.
      const fresh = newestFirst.filter((a) => {
        if (seen.has(a.id) || isNoisePrActivity(a)) return false
        if (!firstPoll) return true
        const landed = Date.parse(a.at ?? "")
        return Number.isFinite(landed) && landed > w.created_at
      })
      const named = fresh.slice(0, REVIEW_STEER_CAP)
      // Oldest first from here on: the steer reads in the order the conversation was written.
      const freshItems: GithubWakeItem[] = [...named].reverse().map((a) => ({
        label: activityLabel(a),
        actor: a.actor,
        bot: isBotGithubActor(a),
        ...(a.at ? { at: a.at } : {}),
        ...(a.url ? { url: a.url } : {}),
      }))

      // THE PR ITSELF — a conflict appearing, a label moving, a reviewer being asked — read against the
      // same baseline discipline as the review activity above. On the FIRST poll, and on the first poll
      // after this landed (an older cursor carries none of these), the reading is RECORDED and nothing is
      // said: a PR's existing labels are not news, and announcing them would spend a turn re-telling the
      // worker what it did itself.
      const prMeta = meta.get(key)
      const changes = firstPoll ? [] : prStateChanges(cursor, st?.merge, prMeta?.labels, prMeta?.reviewRequests)

      const nextCursor: PrWatchCursor = {
        seen: acts ? [...new Set([...cursor.seen, ...acts.map((a) => a.id)])].slice(-REVIEW_SEEN_CAP) : cursor.seen,
        // The STAMP, so the next poll compares against the commit as well as the colour.
        checks: stamp ?? cursor.checks,
        report: cursor.report ?? 0,
        // Each of these advances only when this poll actually READ it. A `gh`-fallback poll knows the
        // merge verdict but not the labels, and overwriting a known baseline with "not known" would make
        // the poll after it announce every label on the PR.
        ...(st?.merge ? { merge: st.merge } : cursor.merge ? { merge: cursor.merge } : {}),
        ...(prMeta?.labels ? { labels: prMeta.labels } : cursor.labels ? { labels: cursor.labels } : {}),
        ...(prMeta?.reviewRequests ? { reviewers: prMeta.reviewRequests } : cursor.reviewers ? { reviewers: cursor.reviewers } : {}),
      }
      if (!checksChanged && fresh.length === 0 && changes.length === 0) {
        // Nothing to say, but the baseline moved: record what was seen so the FIRST poll's backlog is
        // never re-reported, and so a later comment is measured against today rather than against the
        // registration.
        if (JSON.stringify(nextCursor) !== JSON.stringify(cursor)) {
          deps.storage.setPrWatchCursor(w.id, JSON.stringify(nextCursor))
        }
        continue
      }
      // "PR watcher armed": if the human parked this thread's card with a user snooze, news on the PR is
      // exactly the thing it was hiding UNTIL — so clear it here, the moment we enqueue, and the card
      // re-surfaces. A no-op when nothing was snoozed. (Ported from the fence poller this replaced.)
      deps.storage.setSnoozedUntil(row.slug, null)
      // WHAT THIS REPORT SAYS: the fresh news on top of whatever the waiting report it replaces was going
      // to say (nothing, when no report waits). The newest REVIEW_STEER_CAP items are named and the rest
      // counted, exactly as one poll's own burst is.
      const held = waiting ? cursor.held : undefined
      const items = [...(held?.items ?? []), ...freshItems]
      const carried: PrWatchHeld = {
        items: items.slice(-REVIEW_STEER_CAP),
        omitted: (held?.omitted ?? 0) + (fresh.length - named.length) + Math.max(0, items.length - REVIEW_STEER_CAP),
        ...(checksChanged && terminal
          ? {
            checks: {
              verdict: terminal,
              passed: st!.passed,
              failed: st!.failed,
              failing: st!.failing,
              skipped: st!.skipped,
              gated: st!.gated,
              gating: st!.gating,
            },
          }
          : held?.checks ? { checks: held.checks } : {}),
        // The state clauses fold forward the same way the review items do, and are DEDUPED on the way:
        // a report superseded before delivery may already have said "now CONFLICTS", and the poll that
        // replaces it re-derives that clause from a cursor the superseded report never got to advance.
        ...((() => {
          const all = [...(held?.changes ?? []), ...changes]
          const merged = [...new Set(all)]
          return merged.length ? { changes: merged } : {}
        })()),
      }
      const review = carried.items.length > 0
        ? formatGithubWakeSteer({ ref: key, items: carried.items, omitted: carried.omitted })
        : undefined
      const report = nextReport(cursor)
      if (waiting) outbox.supersede(waiting.id, nowMs, `folded into report ${report}, which says this and everything since`)
      enqueuePrWatchWake(row, w.id, report, prWatchWakeMessage({
        target: key,
        ...(carried.checks ? { checks: carried.checks } : {}),
        ...(carried.changes?.length ? { changes: carried.changes } : {}),
        ...(review ? { review } : {}),
      }), `pr-watch ${key}${carried.checks ? ` CI ${carried.checks.verdict}` : ""}${carried.changes?.length ? " state" : ""}${review ? " review" : ""}`, nowMs)
      deps.storage.setPrWatchCursor(w.id, JSON.stringify({ ...nextCursor, report, held: carried }))
    }
  }

  /** The next report number for a watcher — ONE derivation, used both for the delivery id and for the
   *  cursor that records it. They were computed separately at two call sites and had to be kept in step
   *  by hand, which is a silent double-report waiting to happen. */
  function nextReport(cursor: { report?: number }): number {
    return (cursor.report ?? 0) + 1
  }
  /** This watcher's report that is minted but not yet handed to the runtime — pending, or leased and
   *  deferred behind a busy thread. A SENT report (leased with `sentAt`, awaiting confirmation) is not
   *  one: the worker has it, and the next poll may say what happened since. */
  function undeliveredPrWatchReport(slug: string, watchId: string): WakeDelivery | undefined {
    const prefix = `${PR_WATCH_FENCE_PREFIX}:${watchId}:`
    return outbox.listOpen().find((d) => d.slug === slug && d.sentAt === null && d.fenceId.startsWith(prefix))
  }

  function enqueuePrWatchWake(
    row: SessionRow,
    watchId: string,
    report: number,
    message: string,
    reason: string,
    nowMs: number,
  ): void {
    const fenceId = prWatchFenceId(watchId, report)
    const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
    if (outbox.get(deliveryId)) return
    const item = outbox.enqueue({
      id: deliveryId, slug: row.slug, sessionId: row.session_id, fenceId,
      // Frizz's own words about someone else's PR, so the clock rides along: a watcher wake is the one
      // most likely to land on a thread that has been parked for hours without knowing it.
      hintKey: `${PR_WATCH_FENCE_PREFIX}:${watchId}`, message: withClock(message, deps.tailer.get(row.slug)?.lastAssistantAt), reason,
    }, nowMs).delivery
    log(`waker: queued ${row.slug} — ${item.reason}`)
    checkpoint("after-enqueue", item)
  }

  // ---- SOURCE 10: A BACKGROUND SHELL FINISHED WHILE ITS AGENT WAS RESTING -------------------------
  // AUTOMATIC, for every thread, with nothing to register and nothing to declare. Maintainer 2026-08-14:
  // "the agent just uses the built-in tool from the harness to start a background shell. It should be
  // watched automatically: every time a background shell completes, the agent should be woken up. That's
  // how it should always work."
  //
  // It is not redundant with the runtime's own notification, and the split is the entire reason this
  // exists. Measured over this machine's whole session history (3972 shells): all 3011 delivered
  // notifications landed on an assistant record with stop_reason "tool_use" — i.e. MID-TURN — while 1601
  // shells outlived their worker's rest and 1191 of those were never delivered at all, though the session
  // provably kept writing for minutes to days afterwards. The runtime covers the running turn; this
  // covers the rest, and only the rest.
  //
  // WHICH IS EXACTLY WHAT `finishedAt` DECIDES. A shell that finished BEFORE the agent's last word was
  // reported to it by the runtime and folded into that turn; waking again would tell it twice. A shell
  // that finished AFTER it has nobody to tell. So the test is `finishedAt > lastAssistantAt`, and a
  // retirement carrying no instant (an older tail state) never fires — the safe direction.
  //
  // THE AWAITING FENCE HAS NOTHING TO DO WITH THIS. It does not register the wait and never did; it is
  // how an agent comes to REST and states what it is waiting on (see hasDeclaredBackgroundPark). A
  // thread with no fence at all is woken here exactly the same way, which is the point.
  function evalShellCompletions(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele) continue
      // AT REST ONLY. Mid-turn the runtime's own notification is the delivery, and frizz adding a second
      // one would land while the agent is still working — the noise this pass exists to avoid.
      if (tele.turn !== "idle") continue
      // A signed-out provider answers in milliseconds and every reply is a "rest", which makes it a
      // perfect loop generator for anything that re-prompts. Same guard as SOURCES 5 and 9 — and its
      // general form: ANY failed turn is written as an assistant record, so it reads as a rest here too.
      if (tele.authFault || tele.apiFault) continue
      // A THREAD THAT SAID DONE IS NOT WOKEN FOR A SHELL IT WALKED AWAY FROM (2026-08-28). The contract
      // lets a worker sign off with a background process still running — a dev server, a poller it has
      // moved on from — naming it in the body. Waking that thread when the process exits hands a
      // finished worker news it declared it did not need, and it answers the only way it can: by saying
      // done again — a second Done card, and a registered done is un-done by the wake's own user record
      // until it does (registeredDoneFence reads the last user instant). SOURCES 4 and 5 already decline
      // a done thread; this is the same guard. The one exception is a shell the worker REGISTERED a wait
      // on (`mcp__frizz__watch`): a registration trumps a done on the board, so it trumps it here too —
      // the wake is the thing it registered for. Matched by ROW, in any state but dropped, because
      // evalOwnWatches has already settled that row silently by the time this pass runs (it runs first
      // in the tick, and "target ended" is its silent case — the wake is this pass's to send). The
      // human's next word re-opens the thread as ever, and by then the exit is folded into the turn
      // that answers it.
      const walkedAway = threadSaidDone(deps.storage, row.slug, tele)
      const registeredShells = walkedAway ? deps.storage.listThreadWatches(row.slug).filter((w) => w.kind === "shell" && w.state !== "dropped") : []
      const restedAt = Date.parse(tele.lastAssistantAt ?? "")
      if (!Number.isFinite(restedAt)) continue
      for (const shell of tele.retiredShells ?? []) {
        const finishedAt = Date.parse(shell.finishedAt ?? "")
        if (!Number.isFinite(finishedAt) || finishedAt <= restedAt) continue
        if (walkedAway && !registeredShells.some((w) => [shell.id, shell.taskId, shell.label].includes(w.target))) continue
        const fenceId = shellFenceId(shell.id)
        const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
        if (outbox.get(deliveryId)) continue // this shell has already had its one wake
        const item = outbox.enqueue({
          id: deliveryId,
          slug: row.slug,
          sessionId: row.session_id,
          fenceId,
          hintKey: `${SHELL_FENCE_PREFIX}:${shell.id}`,
          message: withClock(shellDoneMessage(shell), tele.lastAssistantAt),
          reason: `background shell finished (${shell.taskId ?? shell.label})`,
        }, nowMs).delivery
        log(`waker: queued ${row.slug} — ${item.reason}`)
        checkpoint("after-enqueue", item)
        return // one durable wake per thread per pass; the next tick takes the next shell
      }
    }
  }

  /** THE REGISTERED-WATCH REGISTRY PASS. Two settle conditions, and only one of them is news.
   *
   *  EXPIRED → settled + a wake. The expiry is the whole reason a registration cannot outlive its own
   *  relevance: the worker chose a duration once, and when it runs out it is put back in front of that
   *  decision rather than left parked on a wait it no longer holds. Told, because a wait that vanishes
   *  silently is the same stall in a new costume — the worker would rest believing it is covered.
   *
   *  TARGET ENDED → settled, SILENTLY. This is the wait completing, which is exactly the thing the
   *  worker asked to be woken for, and evalShellCompletions already delivers that wake off the retired
   *  shell itself. A second one here would be two notifications for one fact. The board stops parking on
   *  the row the moment the target stops resolving (hasRegisteredBackgroundPark), so settling it is
   *  bookkeeping — it keeps the worker's own read-back from listing a wait that is over.
   */
  function evalOwnWatches(nowMs: number): void {
    for (const w of deps.storage.expiredThreadWatches(nowMs)) {
      const row = deps.storage.getSession(w.thread_slug)
      deps.storage.settleThreadWatch(w.id, nowMs, "expired")
      log(`waker: settled ${w.thread_slug} — watch ${w.id} expired (${w.kind}: ${w.target})`)
      if (!row || row.state === "archived" || row.archived === 1) continue
      const fenceId = ownWatchExpiredFenceId(w.id)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: fenceId,
        message: withClock(ownWatchExpiredWakeMessage(w.kind, w.target), deps.tailer.get(row.slug)?.lastAssistantAt),
        reason: `watch ${w.id} expired (${w.kind}: ${w.target})`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
    // The second condition. Read per thread rather than per row so one telemetry lookup covers a
    // thread's whole armed set.
    const bySlug = new Map<string, ReturnType<typeof deps.storage.expiredThreadWatches>>()
    for (const w of deps.storage.armedThreadWatches()) {
      const list = bySlug.get(w.thread_slug) ?? []
      list.push(w)
      bySlug.set(w.thread_slug, list)
    }
    for (const [slug, watches] of bySlug) {
      const tele = deps.tailer.get(slug)
      // NO TELEMETRY IS NOT "NOT LIVE". A thread whose transcript frizz cannot read right now says
      // nothing about its shells, and settling on that reading would cancel a healthy wait — the same
      // shape as `probeShellAlive`'s rule that an undefined verdict is never treated as dead.
      if (!tele) continue
      // The SAME liveness the park integrity pass reads, so a row cannot be settled here while the fence
      // beside it still counts the identical handle as live. (It reads a hair wider than the board's
      // rule — it counts a DESCENDANT sub-agent, where board.resolveLiveWatchTarget counts direct
      // children only. Unreachable in practice: registration goes through the board's rule, so a
      // descendant handle is refused before a row can exist for it.)
      const live = liveActivityOf(tele, new Set(), new Set())
      for (const w of watches) {
        if (live[w.kind === "shell" ? "shells" : "agents"].has(w.target)) continue
        deps.storage.settleThreadWatch(w.id, nowMs)
        log(`waker: settled ${slug} — watch ${w.id} finished (${w.kind}: ${w.target})`)
      }
    }
  }

  /** THE ANSWER DELIVERY PASS. The human answered on the board; this is what puts it in front of the
   *  worker, and it is a separate act from answering on purpose — an answer given while the worker's
   *  process was down has to survive the gap, or it is lost in exactly the silence the fenced question
   *  used to lose the QUESTION in.
   *
   *  ONLY AN ANSWER WAKES. A dismissal is real news ("decide it yourself") but it wakes nobody: the
   *  human dismissing questions is almost always dismissing several in a row and is sitting right there,
   *  so a wake per x would be a turn per click. Dismissals RIDE the next answer's message instead, and
   *  a thread with nothing but dismissals simply keeps them queued — the worker sees them gone in its
   *  own `ask` read-back.
   *
   *  Marked delivered at ENQUEUE, not at receipt, because the outbox is itself durable (wake_delivery in
   *  SQLite) and owns retry from there. "Delivered" here means handed to the channel that cannot lose it.
   */
  function evalQuestionAnswers(nowMs: number): void {
    const bySlug = new Map<string, ThreadQuestionRow[]>()
    for (const q of deps.storage.undeliveredSettlements()) {
      const list = bySlug.get(q.thread_slug) ?? []
      list.push(q)
      bySlug.set(q.thread_slug, list)
    }
    for (const [slug, rows] of bySlug) {
      const row = deps.storage.getSession(slug)
      // An archived thread is told nothing, and its rows stay undelivered: reopening it should still
      // hand the worker what the human said, rather than having spent it on a thread nobody was reading.
      if (!row || row.state === "archived" || row.archived === 1) continue
      const answers: QuestionAnswer[] = []
      const dismissed: QuestionDismissal[] = []
      // The ids are kept alongside for the delivery key ONLY. The MESSAGE names each dismissed question
      // by its text, because the worker never saw an id — frizz minted it — so a list of ids names
      // nothing it can act on, and the human's card would have a blank row where the question goes.
      const dismissedIds: string[] = []
      for (const q of rows) {
        if (q.state === "dismissed") {
          dismissedIds.push(q.id)
          const spec = safeQuestionSpec(q.spec)
          if (spec) dismissed.push({ question: spec.question })
          continue
        }
        const parsed = safeQuestionAnswer(q.answer)
        if (parsed) answers.push(parsed)
      }
      // DISMISSALS ALONE WAKE NOBODY — UNLESS NOTHING ELSE WILL EVER CARRY THEM. The rule exists because
      // a human dismissing questions is almost always dismissing several in a row and is sitting right
      // there, so a wake per x would be a turn per click; they ride the next answer or the next steer.
      //
      // An AUTONOMOUS thread has neither. Its whole premise is that nobody is about to send it anything,
      // and its questions get cancelled wholesale the moment the Goal is armed — so on that thread the
      // "it rides the next steer" half of the rule is a promise nothing keeps, and the worker would
      // simply never learn that questions it is still waiting on have been taken away from it.
      if (answers.length === 0 && !(row.recurring_on_rest === 1 && row.recurring_prompt?.trim())) continue
      // A dismissed row whose spec no longer parses is still real news: it leaves the delivery queue and
      // counts toward the cancellation wake, it just cannot be quoted. Counting from `dismissedIds`
      // rather than `dismissed` is what keeps that row from silently disappearing.
      const cancelledCount = dismissedIds.length
      // One delivery per BATCH, keyed by the ids in it, so a second answer on the same thread is its own
      // piece of news rather than a duplicate deduped away.
      const fenceId = questionAnswerFenceId([...answers.map((a) => a.questionId), ...dismissedIds])
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: fenceId,
        message: withClock(
          answers.length === 0 ? questionsCancelledWakeMessage(cancelledCount) : questionAnswerMessage(answers, dismissed),
          deps.tailer.get(row.slug)?.lastAssistantAt,
        ),
        reason: answers.length === 0
          ? `${cancelledCount} question(s) cancelled — autonomous`
          : `${answers.length} question answer(s)${cancelledCount ? ` + ${cancelledCount} dismissed` : ""}`,
      }, nowMs).delivery
      for (const q of rows) deps.storage.markSettlementDelivered(q.id)
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  function evalTimers(nowMs: number): void {
    for (const timer of deps.storage.dueThreadTimers(nowMs)) {
      const row = deps.storage.getSession(timer.thread_slug)
      // No thread, or a shelved one: nothing to wake. The row is left armed rather than settled — an
      // archived thread can be reopened, and the alarm is still the worker's own outstanding intent.
      if (!row || row.state === "archived" || row.archived === 1) continue
      const fenceId = timerFenceId(timer.id)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue // this alarm already has its one wake
      const fireAt = new Date(timer.fire_at).toISOString()
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: `${TIMER_HINT_PREFIX}${timer.id}`,
        message: timerPromptMessage(timer.prompt, fireAt),
        reason: `one-off timer elapsed (${fireAt})`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // Settle the timer a wake came from — the row's OWN "never again" record, which outlives the pruning
  // of the terminal outbox row that would otherwise dedupe it.
  //
  // Called from every terminal path EXCEPT SUPERSESSION, which is the one distinction that matters here.
  // A timer supersedes for two reasons: its row already left `armed` (the worker cancelled it, or a
  // previous attempt settled it) — where this would be a no-op anyway, since the write is guarded on
  // `armed` — or the SESSION moved underneath the queued delivery. In that second case the alarm has not
  // rung and the thread still exists, so leaving the row armed is what lets the next tick re-queue it
  // against the current session. Settling there would silently swallow the alarm mid-resume.
  //
  // A delivery that exhausted its attempts or was abandoned DOES settle: it has had its one shot, and an
  // alarm resurrected days later when the outbox prunes is worse than one that failed.
  function settleTimer(item: WakeDelivery): void {
    if (!isTimerFenceId(item.fenceId)) return
    deps.storage.markThreadTimerFired(timerIdOf(item.fenceId), now())
  }

  // ---- The ON SCHEDULE pass -----------------------------------------------------------------
  // Like the snooze pass, this does NOT filter on `turn === "idle"`. Unlike the snooze pass, the
  // delivery gate does not hold the result either: a beat due mid-turn goes out mid-turn
  // (`isDeliverableNow`). Being able to reach a thread that is NOT going quiet is the whole point —
  // it is exactly what Claude Code's own cron cannot do (see SOURCE 4 above).
  //
  // At most ONE beat is ever outstanding per thread: a new one is queued only when the previous has
  // reached a terminal state, and the beat clock runs from the last DELIVERED beat. So an interval that
  // elapses while an undelivered beat is still open is skipped rather than stacked — a thread cannot
  // accumulate a backlog and then be handed all of it at once.
  function evalSchedulePrompts(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const armed = armedSchedule(row)
      if (!armed || armed.dueAtMs > nowMs) continue
      // The ONE thing that silences a beat. Everything else about this source is unconditional — rest,
      // sub-agents, shells, all irrelevant — but a worker that has said there is no further work has
      // ended the arrangement, and a "permanently stalled" run that keeps being woken every interval is
      // not stalled at all. Needs no stored state: the flag is folded off the FINAL assistant message,
      // so anything the thread says or receives afterwards reopens it.
      const beatTele = deps.tailer.get(row.slug)
      if (beatTele && threadSaidDone(deps.storage, row.slug, beatTele, armed.armedAt)) continue
      // NOTHING ELSE SILENCES A BEAT — not a pending question, not a rest fence. A beat asks "it has been
      // an hour", which neither of those answers. The operator's question hold used to reach here and was
      // deleted with the switch that armed it (2026-08-16, see the header block).
      // One in flight at a time. Any open scheduled delivery for this thread — whatever its
      // generation — means the previous beat has not landed yet, so this interval is skipped rather
      // than stacked behind it.
      if (openSchedulePrompt(row.slug, row.session_id)) continue
      const beat = beatIndex(row.recurring_schedule_fired_at ?? null, armed)
      const fenceId = heartbeatFenceId(armed.armedAt, beat)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: `${HEARTBEAT_HINT_PREFIX}${armed.intervalMs}`,
        message: schedulePromptMessage(armed.prompt, Math.round(armed.intervalMs / 1000)),
        reason: `recurring prompt every ${Math.round(armed.intervalMs / 1000)}s`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // Is a beat for this thread still open (pending/leased)? Scanning the open set is cheap — the outbox
  // holds only live work — and it is the one check that makes "at most one beat outstanding" true
  // across restarts, since it reads the durable rows rather than in-memory arming.
  function openSchedulePrompt(slug: string, sessionId: string): boolean {
    return outbox.listOpen().some(
      (item) => item.slug === slug && item.sessionId === sessionId && isHeartbeatFenceId(item.fenceId),
    )
  }

  // A monotonic-enough beat number so consecutive beats get distinct delivery ids. Derived from elapsed
  // intervals rather than a stored counter: the row already carries everything needed, and a delivery
  // id only has to be unique per (session, generation), not meaningful.
  function beatIndex(lastFiredAt: string | null, armed: ArmedSchedule): number {
    const armedMs = Date.parse(armed.armedAt)
    const lastMs = Date.parse(lastFiredAt ?? armed.armedAt)
    if (!Number.isFinite(armedMs) || !Number.isFinite(lastMs)) return 0
    return Math.max(0, Math.round((lastMs - armedMs) / armed.intervalMs)) + 1
  }

  // Stamp the beat clock once a beat has genuinely REACHED the worker, so the next one is due an
  // interval after it actually landed. Called only from the three settle points that mean delivery
  // happened (acknowledged, or confirmed by the wake token in the transcript) — deliberately NOT from
  // the superseded/exhausted/abandoned ones the snooze settles on. A beat dropped because the human
  // pressed pause, or one that exhausted its attempts, never fired, and advancing the clock for it
  // would silently swallow the next interval.
  //
  // Guarded on the generation for the same reason as the snooze: a beat that settles after the worker
  // re-armed or switched off the trigger must not write a schedule onto settings it no longer describes.
  function settleSchedulePrompt(item: WakeDelivery): void {
    if (!isHeartbeatFenceId(item.fenceId)) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    const armedAt = row.recurring_armed_at
    if (!armedAt || !item.fenceId.startsWith(`${HEARTBEAT_FENCE_PREFIX}:${armedAt}:`)) return
    deps.storage.stampRecurringScheduleFired(item.slug, armedAt, new Date().toISOString())
  }

  // ---- The ON REST pass -----------------------------------------------------------------------
  // Unlike every other pass here this one DOES filter on `turn === "idle"`, because rest is not a
  // deadline it can queue against — it IS the trigger. Queueing a bump for a busy thread would bind it
  // to an activity stamp that is still moving, and the delivery gate would then supersede it on the
  // very next line the worker wrote.
  function evalRestPrompts(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const armed = armedRest(row)
      if (!armed) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele || tele.turn !== "idle") continue
      // THE AGENT MUST HAVE SPOKEN LAST. `turn === "idle"` alone is not "the agent rested": a thread
      // whose worker is gone is idle forever, and frizz's own bump keeps landing in its transcript. This
      // is the guard that makes the trigger mean "you stopped" rather than "nothing is happening" — see
      // `stopHookFenceId`. It costs the feature nothing: an agent that genuinely takes a turn and rests
      // again produces a NEW assistant timestamp, which is exactly when the Goal should fire.
      const restedAt = tele.lastAssistantAt
      if (!restedAt) continue
      if (tele.lastUserAt && Date.parse(tele.lastUserAt) >= Date.parse(restedAt)) continue
      // A SIGNED-OUT PROVIDER ANSWERS INSTANTLY, and that is a loop this trigger cannot see any other
      // way. The worker replies "Not logged in · Please run /login" in milliseconds, which is a genuine
      // new assistant message and therefore a genuine new rest — so every guard above is satisfied and
      // the bump fires again, ten times in a hundred seconds (measured 2026-08-12). Nothing the operator
      // has not done can change the outcome, so re-prompting is pure burn: the thread already cards its
      // auth fault and the sign-in recovery in the queue.
      if (tele.authFault) continue
      // AND EVERY OTHER FAILED TURN, for the same reason — and here it matters MORE than for the sign-off
      // reminder, because this trigger has no cap of its own. A synthetic API-error record of any kind
      // (a 400 for a conversation that has outgrown the context window, a 500, a dropped connection) is
      // an assistant record, so it advances `lastAssistantAt`: a fresh rest instant, a fresh
      // `stopHookFenceId`, and the per-rest dedupe below never fires. Without this guard a thread with
      // an armed Goal whose every turn fails is bumped once per tick indefinitely, and on a context-window
      // 400 each bump is what keeps the conversation over the limit (the loop measured in the field on
      // the reminder, 2026-08-27, is open here by the same mechanism). The cost is deliberate: a turn
      // that failed TRANSIENTLY is no longer blind-retried by the Goal either — the operator bumps it, or
      // the next real event on the thread does — because this trigger cannot tell the two apart and an
      // unbounded retry of a terminal error is the worse failure.
      if (tele.apiFault) continue
      // WHAT THIS DELIBERATELY DOES NOT CONSULT: live sub-agents and background shells. A hold on them
      // shipped briefly and was removed the same day (maintainer 2026-08-02: "the status of any
      // sub-agents or background shells is irrelevant"). The SCHEDULE trigger is the whole rate story — a
      // thread parked behind children is bumped on the same schedule as any other, which is also what
      // makes this able to rescue one parked behind a child that will never report. A worker that
      // genuinely has nothing to do until something returns says AWAITING — and an AWAITING naming a
      // wait the scheduler itself will fire is honoured, not bumped (`parkedOnAWaitItCannotAdvance`).
      // THE REST ALREADY ANSWERED THIS TRIGGER'S QUESTION — the thread signed off as done, or parked on a
      // wait it cannot advance by working. A ```question fence does NOT answer it: a thread carrying a
      // Goal is not waiting on the human, so the bump fires over it and is worded for it (see
      // `restMessageIsSignedOff` and the header block).
      // Per-rest, and that is what makes it free: every fact it reads rides the FINAL assistant message,
      // so the next word on the thread re-opens the trigger with nothing stored to clear.
      if (restMessageIsSignedOff(deps.storage, row.slug, tele, registeredPrWatchesOf(deps.storage, row.slug), armedTimerIdsOf(deps.storage, row.slug), armed.armedAt)) continue
      // A SETTLEMENT WAKE OWNS THIS REST (2026-09-02). An answer the human just gave, or the questions
      // this very Goal's arming cancelled, is already on its way through evalQuestionAnswers — a wake
      // that ends the rest by itself, and whose message is the news. The Goal firing beside it is the
      // two-deliveries-in-one-tick shape the reminder hold below exists for ("Redundant Dones"), so it
      // stands down the same way and fires on the first rest the worker takes AFTER hearing the news.
      // The flag may be hard true: this pass only runs for rows whose armed rest Goal is exactly the
      // gate evalQuestionAnswers wakes dismissal-only settlements on. Bounded like the answer card is —
      // the wake landing advances `lastUserAt` past the settlement, which both spends this hold and
      // closes the rest above.
      if (answersInFlight(deps.storage.listThreadQuestions(row.slug), tele.lastUserAt, true) !== undefined) continue
      // THE REMINDER TOOK THIS REST (2026-08-28). SOURCE 9 mints before this pass runs, and a rest it
      // claimed gets no Goal on top. The two used to go out in the same tick, 5 ms apart; the runtime
      // queued the second behind the first's turn, so a worker that answered the Goal with a ```done
      // fence then read "you rested without a fence" and fenced again — two Done cards for one sign-off
      // (thread `wrong-agent-id-re-fencing`, maintainer: "Redundant Dones"). The reminder's own
      // supersession check in `deliveryContext` could not catch it: it ran at send, before any reply
      // existed. The reminder already opens by sending a half-finished thread back to the work, so the
      // operator's words lose nothing on that rest; they reach the worker on the first bare rest the
      // reminder does not take (its cap spent, or the setting off). A DELIVERED reminder holds this too,
      // which is what makes it per-rest rather than per-tick — in production its record closes the rest
      // anyway (`lastUserAt` moves past `restedAt`, above). Superseded means the worker moved on and
      // exhausted means the runtime could not be reached; the Goal for that rest is dead or doomed alike,
      // so neither holds it.
      const reminder = outbox.get(wakeDeliveryId(row.slug, row.session_id, signoffFenceId(restedAt)))
      if (reminder && reminder.state !== "superseded" && reminder.state !== "exhausted") continue
      const fenceId = stopHookFenceId(armed.armedAt, restedAt)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      // Terminal rows stay in the store, so this alone is what makes a rest bump EXACTLY once: the same
      // rest yields the same delivery id, whatever happened to the first attempt.
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: STOP_HOOK_HINT_KEY,
        message: restPromptMessage(armed.prompt, { overQuestion: tele.pendingQuestion === true }),
        reason: "recurring prompt at rest",
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- The ON COMPACTION pass -----------------------------------------------------------------
  // Deliberately does NOT filter on `turn === "idle"` (see SOURCE 7): the point is to reach the worker
  // in the emptied window, and a compaction happens while it is working. Nor does it consult whether the
  // thread signed off — a ```done fence answers "you stopped, is there more?", which is not the question
  // a compaction asks. A worker that genuinely wants these to stop clears the Goal, or the operator does
  // it in the footer.
  function evalCompactPrompts(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const armed = armedCompact(row)
      if (!armed) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele?.lastCompactionAt) continue
      // NEVER fire for a compaction that predates the arming. Without this, switching the trigger on for
      // a thread that compacted an hour ago delivers immediately for an event the operator never saw —
      // and a thread that has compacted before is the common case, not the exotic one.
      if (tele.lastCompactionAt <= armed.armedAt) continue
      // NOTHING HOLDS THIS ONE. Re-grounding a worker whose context was just emptied is worth doing
      // whether or not it is mid-turn, whether or not it is waiting on an answer, and a fence it wrote
      // before the compaction says nothing about whether it still remembers what it was doing.
      const fenceId = compactFenceId(armed.armedAt, tele.lastCompactionAt)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      // Terminal rows stay in the store, so this alone is what makes a compaction bump EXACTLY once: the
      // same compaction yields the same delivery id, whatever happened to the first attempt.
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: COMPACT_HINT_KEY,
        message: compactionPromptMessage(armed.prompt),
        reason: "recurring prompt after compaction",
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // Stamp the POST-COMPACTION readout once its delivery is terminal. Cosmetic (the panel's "last sent"),
  // guarded on the generation for the same reason as its siblings: a bump settling after the operator
  // edited the text must not write onto words it no longer describes.
  function settleCompactPrompt(item: WakeDelivery): void {
    if (!isCompactFenceId(item.fenceId)) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    const armedAt = row.recurring_armed_at
    if (!armedAt || !item.fenceId.startsWith(`${COMPACT_FENCE_PREFIX}:${armedAt}:`)) return
    deps.storage.stampRecurringCompactFired(item.slug, armedAt, new Date().toISOString())
  }

  // Stamp the bump clock once a bump has genuinely REACHED the worker — the HEARTBEAT's input, and
  // called only from the settle points that mean delivery genuinely happened.
  // Guarded on the generation so a bump settling after the operator edited the text cannot write onto
  // words it no longer describes.
  function settleRestPrompt(item: WakeDelivery): void {
    if (!isStopHookFenceId(item.fenceId)) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    const armedAt = row.recurring_armed_at
    if (!armedAt || !item.fenceId.startsWith(`${STOP_HOOK_FENCE_PREFIX}:${armedAt}:`)) return
    deps.storage.stampRecurringRestFired(item.slug, armedAt, new Date().toISOString())
  }

  // Disarm the row a snooze wake came from, once that wake is terminal. Guarded on the fence id still
  // matching so a human who re-snoozed (or snoozed again) between enqueue and settlement keeps their
  // NEW deadline — the stale delivery must never erase state it no longer describes.
  function settleSnooze(item: WakeDelivery): void {
    if (!isSnoozeFenceId(item.fenceId)) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    if (armedSnooze(row)?.fenceId !== item.fenceId) return
    deps.storage.setSnoozedUntil(item.slug, null)
  }

  function reconcileOutbox(nowMs: number): void {
    for (const item of outbox.listOpen()) {
      const context = deliveryContext(item)
      if (context === "confirmed") {
        outbox.confirm(item.id, nowMs)
        settleDelivered(item)
        confirmFrame(item, nowMs)
        continue
      }
      if (context === "superseded") {
        outbox.supersede(item.id, nowMs, "the exact awaiting fence or session was superseded")
        settleSnooze(item)
        continue
      }
      if (item.state !== "leased" || item.leaseUntil === null || item.leaseUntil > nowMs) continue
      // A SENT wake whose confirmation window has closed without the token showing up (that case was
      // `confirmed`, above). The runtime that took the frame decides: still alive, it read the wake and
      // the transcript check is merely blind to it (a message the CLI has queued, a text the fold has
      // not reached) — delivered. Dead, and the frame died with it — a lost wake, which goes round
      // again exactly as a lease that expired before delivery does, under the same idle-only rule and
      // the same attempt cap, and is SAID when the cap runs out rather than filed as done.
      if (item.sentAt !== null) {
        const runtime = deps.wakeRuntimeState?.(item.slug, item.sessionId) ?? "unknown"
        if (runtime !== "dead") {
          if (outbox.confirm(item.id, nowMs)) {
            settleSnooze(item)
            settleSchedulePrompt(item)
            settleRestPrompt(item)
            settleCompactPrompt(item)
            settleTimer(item)
            settleSignoffNudge(item)
            log(`waker: delivered ${item.slug} — ${item.reason}${item.attempts > 1 ? ` (on attempt ${item.attempts})` : ""}`)
          }
          continue
        }
        if (context !== "current-idle") continue
        const recovered = outbox.recoverExpired(
          item.id, nowMs, nowMs + retryDelay(item.attempts), maxDeliveryAttempts,
          "the worker's process died before it read this wake",
        )
        if (!recovered) continue
        if (recovered.state === "exhausted") {
          settleSnooze(item)
          settleTimer(item)
          log(`waker: delivery EXHAUSTED for ${item.slug} after ${recovered.attempts} attempts — ${recovered.lastError ?? "unknown error"}`)
        } else {
          log(`waker: wake LOST for ${item.slug} — ${item.reason}: the worker's process died before it read it; sending again (attempt ${item.attempts} of ${maxDeliveryAttempts} spent)`)
        }
        continue
      }
      // An expired lease is an interrupted/uncertain attempt. Re-open it only while the exact session
      // generation is still idly awaiting the exact fence. Busy or not-yet-loaded telemetry is held:
      // retrying there could duplicate an input that crossed the transport just before process death.
      //
      // DELIBERATELY NOT `isDeliverableNow`: a scheduled prompt may be SENT to a busy thread, but not
      // RE-sent to one on a guess. This branch runs precisely when we do not know whether the previous
      // attempt landed, and the transcript check that would tell us (`confirmed`, above) cannot see a
      // message still sitting in the CLI's queue. A beat that arrives one rest late is the old
      // behaviour; a beat that arrives twice mid-turn is a new defect.
      //
      // THE ONE EXCEPTION IS A ROW THIS SCHEDULER DEFERRED and has now held past the ceiling: its
      // `lastError` is the deferral's own text and `sentAt` is null, so nothing ever crossed the
      // transport and re-opening it is not a guess. It is re-opened so `deliverDue` can send it into the
      // busy thread's queue (isDeliverableNow's ceiling), which is the whole point of the bound.
      if (context !== "current-idle" && !heldPastBound(item, context, nowMs)) continue
      const recovered = outbox.recoverExpired(
        item.id,
        nowMs,
        nowMs,
        maxDeliveryAttempts,
        item.lastError ?? "delivery lease expired before acknowledgement",
      )
      if (recovered?.state === "exhausted") {
        settleSnooze(item)
        settleTimer(item)
        log(`waker: delivery EXHAUSTED for ${item.slug} after ${recovered.attempts} attempts — ${recovered.lastError ?? "unknown error"}`)
      }
    }
  }

  // Every settle a DELIVERED wake owes its source. Repeated verbatim at the confirm, ack and frame
  // paths below, so it is one list.
  function settleDelivered(item: WakeDelivery): void {
    settleSnooze(item)
    settleSchedulePrompt(item)
    settleRestPrompt(item)
    settleCompactPrompt(item)
    settleTimer(item)
  }

  // ---- THE MERGE: ONE THREAD, ONE TURN --------------------------------------------------------------
  // A delivery is a turn, and a turn is the expensive unit (wake-store.ts, WAKE_QUIET_WINDOW_MS, for the
  // numbers: $2–3 each at today's context sizes, 32% of a day's spend). The quiet window makes a thread's
  // wakes WAIT together; this is what makes them GO together. When a claim passes its gates, every other
  // pending row for the same thread and session is examined on its own terms — its own `deliveryContext`,
  // so a row whose fence or rest was superseded settles as superseded and one already confirmed by the
  // transcript settles as confirmed, exactly as they would have alone — and every row that could go out
  // right now is LEASED beside the carrier (`adopt`, which ignores the quiet window: the carrier is
  // leaving anyway) and folded into the carrier's message under its own reason line, in creation order.
  //
  // THE ROWS STAY SEPARATE. Only the message is merged: each companion keeps its own row, attempts,
  // lease and terminal state, and every outcome of the one `resume` — deferred, abandoned, sent, acked
  // — is applied to the whole frame, row by row. That is what keeps the two invariants that matter
  // intact without a new state or column: the per-fence dedupe (a merged-away timer's row reaches
  // `delivered` under its own fence id, so `evalTimers` finds it and never re-mints; a merged-away
  // report's row is there for `undeliveredPrWatchReport` to see), and the settle hooks (a merged-away
  // timer is marked fired, a merged-away snooze disarmed, by the same `settleDelivered` the carrier gets).
  // A frame that is LOST — the process died before it read the frame — goes round again row by row and
  // is simply re-merged by the next claim; nothing is delivered on the strength of a message that was
  // composed and never read.
  //
  // AN ANSWER NEVER MERGES, as carrier or as companion. `questionAnswerMessage` is the human's own words
  // in a shape the chat parses by position — its first line must be the answers header and every trailing
  // line is read as the last answer's continuation — so wrapping it in a heading or appending anything
  // after it would render frizz's prose inside the human's answer chip. It is exempt from the quiet
  // window for the same reason it cannot wait: it goes out alone, at once.
  function adoptCompanions(carrier: WakeDelivery, claimedAt: number): WakeDelivery[] {
    if (isQuestionAnswerFenceId(carrier.fenceId)) return []
    const adopted: WakeDelivery[] = []
    for (const sibling of outbox.pendingFor(carrier.slug, carrier.sessionId)) {
      if (sibling.id === carrier.id || isQuestionAnswerFenceId(sibling.fenceId)) continue
      const context = deliveryContext(sibling)
      if (context === "confirmed") {
        outbox.confirm(sibling.id, now())
        settleDelivered(sibling)
        continue
      }
      if (context === "superseded") {
        outbox.supersede(sibling.id, now(), "the exact awaiting fence or session was superseded before delivery")
        settleSnooze(sibling)
        continue
      }
      if (!isDeliverableNow(sibling, context, claimedAt)) continue
      const leased = outbox.adopt(sibling.id, deliveryOwner, claimedAt, claimedAt + deliveryLeaseMs, maxDeliveryAttempts)
      if (leased) adopted.push(leased)
    }
    return adopted
  }

  // The merged body: each wake's own message under its own reason line, oldest first, and ONE clock at
  // the foot in place of the one each frizz-authored part carried (a stamp per section would put five
  // clocks in one message; the display stripper is anchored to a single trailing one). Parts whose
  // reason AND body are identical — the same review event reported by two polls, the same "CI passing"
  // twice — fold into one section that says how many there were, rather than saying the same thing
  // three times to a reader who pays per token to read it.
  function mergedWakeMessage(frame: readonly WakeDelivery[], spokeAt: string | null | undefined): string {
    const sections: { reason: string; body: string; count: number }[] = []
    for (const part of frame) {
      const body = stripWakeTimeHeader(part.message).trim()
      const same = sections.find((s) => s.reason === part.reason && s.body === body)
      if (same) same.count++
      else sections.push({ reason: part.reason, body, count: 1 })
    }
    const lead = `Frizz held ${frame.length} wakes for this thread and is delivering them together, oldest first. Each is under its own heading; read all of them before acting on any.`
    const body = sections.map((s, i) => `### ${i + 1}. ${s.reason}${s.count > 1 ? ` — ${s.count} identical events` : ""}\n\n${s.body}`)
    return `${lead}\n\n${body.join("\n\n")}\n\n${wakeTimeHeader(now(), spokeAt)}`
  }

  // A frame confirmed by its carrier's token is confirmed whole. The merged delivery is ONE user record
  // carrying ONE token — the carrier's — so a companion can never be confirmed by the transcript on its
  // own; left to itself it would wait out the grace and be confirmed by the runtime's survival, or, if
  // the process died inside the grace AFTER reading the frame, be sent again as lost. The companions are
  // the rows still leased and marked sent at the same instant as the carrier: `deliverDue` stamps the
  // whole frame with one `sentAt`.
  function confirmFrame(carrier: WakeDelivery, nowMs: number): void {
    if (carrier.sentAt === null) return
    for (const d of outbox.listOpen()) {
      if (d.id === carrier.id || d.slug !== carrier.slug || d.sessionId !== carrier.sessionId) continue
      if (d.state !== "leased" || d.sentAt !== carrier.sentAt) continue
      if (!outbox.confirm(d.id, nowMs)) continue
      settleDelivered(d)
      log(`waker: delivered ${d.slug} — ${d.reason} (in the same frame as: ${carrier.reason})`)
    }
  }

  async function deliverDue(): Promise<void> {
    for (let delivered = 0; delivered < deliveryBatchSize; delivered++) {
      // Condition polling can take seconds. Never derive a lease from the tick-start timestamp: a
      // sufficiently slow GitHub request would make a brand-new claim already expired to another
      // scheduler process. Every external-delivery boundary gets a fresh clock read instead.
      const claimedAt = now()
      const item = outbox.claim(deliveryOwner, claimedAt, claimedAt + deliveryLeaseMs, maxDeliveryAttempts)
      if (!item) return
      checkpoint("after-claim", item)

      const context = deliveryContext(item)
      if (context === "confirmed") {
        outbox.confirm(item.id, now())
        settleDelivered(item)
        continue
      }
      if (context === "superseded") {
        outbox.supersede(item.id, now(), "the exact awaiting fence or session was superseded before delivery")
        settleSnooze(item)
        continue
      }
      if (!isDeliverableNow(item, context, claimedAt)) {
        const deferredAt = now()
        outbox.deferFailure(
          item.id,
          deliveryOwner,
          deferredAt,
          deferredAt + Math.max(deliveryLeaseMs, retryDelay(item.attempts)),
          WAKE_HOLD_DEFERRAL,
        )
        continue
      }

      // The frame: the carrier plus everything else waiting for this thread that may go out now, in
      // creation order. One `resume`, one turn; see adoptCompanions.
      const companions = adoptCompanions(item, claimedAt)
      const frame = [...companions, item].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      const message = companions.length === 0
        ? item.message
        : mergedWakeMessage(frame, deps.tailer.get(item.slug)?.lastAssistantAt)
      if (companions.length > 0) {
        log(`waker: merged ${frame.length} wakes for ${item.slug} into one delivery — ${frame.map((d) => d.reason).join("; ")}`)
      }

      try {
        // THE CLOCK RIDES ON EVERY DELIVERY. A broker-run worker is told neither the date nor the time
        // by its runtime (measured: zero date injections across a whole session), so it has no way to
        // judge how long its own parks actually last — which is why `for:` values are guesses. This is
        // the one place every frizz wake passes through, so one line here reaches all of them.
        await deps.resume(item.slug, message, item.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failedAt = now()
        // A TERMINAL delivery verdict (a live worker owns this conversation but its exact identity
        // can't be confirmed for safe re-entry) will never change by retrying — retrying only burns
        // every attempt to a silent exhaustion. Abandon the item now, preserving the reason for the
        // human, instead of deferring it back into the retry pool. Duck-typed so the scheduler stays
        // decoupled from resume.ts (see TerminalDeliveryError).
        if ((error as { terminalDelivery?: unknown })?.terminalDelivery === true) {
          for (const d of frame) {
            outbox.supersede(d.id, failedAt, message)
            settleSnooze(d)
            settleTimer(d)
          }
          log(`waker: delivery ABANDONED for ${item.slug} (terminal, no retry): ${message}`)
          continue
        }
        // A thrown non-terminal operation can still be ambiguous (for example, text reached the worker
        // before a later storage write failed). Keep the item leased through a confirmation window; recovery
        // checks the token/fence before making it retryable.
        for (const d of frame) {
          outbox.deferFailure(
            d.id,
            deliveryOwner,
            failedAt,
            failedAt + Math.max(deliveryLeaseMs, retryDelay(d.attempts)),
            message,
          )
        }
        log(`waker: delivery FAILED for ${item.slug} (attempt ${item.attempts} of ${maxDeliveryAttempts}): ${message}`)
        continue
      }

      // SENT IS NOT DELIVERED, when the runtime can tell us which. Reproduced 2026-08-25
      // (scripts/verify-prwatch-wake-cold-resume.mjs) against a real daemon: a thread parked on a PR
      // watcher, its idle daemon long since hibernated, the wake cold-resumes a `claude` that dies at
      // startup — and this branch used to file the wake as delivered the instant the socket write
      // returned. The PR-watch cursor had already moved past the event, so nothing ever said it again;
      // the worker sat 12h+ on a watcher that had "fired". Now the row stays leased as SENT and
      // reconcileOutbox decides: the token in the transcript confirms it, a runtime still alive after
      // the grace confirms it, a runtime that died with no token sends it round again.
      const runtime = deps.wakeRuntimeState?.(item.slug, item.sessionId) ?? "unknown"
      if (runtime !== "unknown") {
        const sentAt = now()
        if (outbox.markSent(item.id, deliveryOwner, sentAt, sentAt + confirmGraceMs)) {
          // The same stamp on every companion — it is what confirmFrame recognises the frame by.
          for (const d of companions) outbox.markSent(d.id, deliveryOwner, sentAt, sentAt + confirmGraceMs)
          // THE NUDGE'S CAP IS SPENT AT SEND, not at confirmation, and this branch is why the cap
          // existed on paper only. Every wake to a live runtime leaves here, so the settle below was
          // unreachable in production — and the confirm path this hands to cannot make up for it,
          // because `deliveryContext` reads a signoff item as SUPERSEDED the instant the agent's next
          // assistant record lands (an API-error record is one), and the superseded branch counts
          // nothing. `signoff_nudges` therefore stayed 0 forever while SIGNOFF_NUDGE_MAX was 2.
          // Counting here is also the honest anchor: the tokens are spent when the message is sent,
          // and confirmation is exactly what a thread failing every turn can never supply.
          for (const d of frame) settleSignoffNudge(d)
          log(`waker: sent ${item.slug} — ${item.reason}; confirming within ${Math.round(confirmGraceMs / 1000)}s`)
          checkpoint("after-delivery", item)
          continue
        }
      }
      // The happy path logs exactly one line, and it CONFIRMS something that already happened. A
      // pre-flight "delivering … (attempt 1)" reads like a retry counter — as if a previous try had
      // failed — on the first-and-only attempt every ordinary wake takes. Attempt counts belong on the
      // failure lines above, where they carry information; here one is worth printing only when the
      // delivery genuinely did take more than one.
      const retried = item.attempts > 1 ? ` (on attempt ${item.attempts})` : ""
      log(`waker: delivered ${item.slug} — ${item.reason}${retried}`)
      checkpoint("after-delivery", item)
      // Each row's ack is guarded on its own lease, so a companion whose lease another process took in
      // the meantime keeps that process's authoritative state, exactly as the carrier does.
      const acked = frame.filter((d) => outbox.acknowledge(d.id, deliveryOwner, now()))
      if (!acked.includes(item)) {
        log(`waker: delivery acknowledgement lost ownership for ${item.slug}; preserving the authoritative terminal state`)
      }
      for (const d of acked) {
        settleDelivered(d)
        settleSignoffNudge(d)
      }
      if (!acked.includes(item)) continue
      const acknowledged = outbox.get(item.id)
      if (acknowledged) checkpoint("after-ack", acknowledged)
    }
  }

  async function runTick(): Promise<void> {
    try {
      await evalLimits(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: limit-resume pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalSnoozes(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: snooze-bump pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalSchedulePrompts(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: recurring-prompt schedule pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    // THE REMINDER MINTS BEFORE THE GOAL'S REST PASS (2026-08-28): SOURCE 5 stands down on a rest the
    // reminder took, and it reads that off the outbox — so the reminder has to be there first. Before
    // this the two went out in one tick, 5 ms apart, and the second arrived stale (see evalRestPrompts).
    try {
      evalSignoffNudges(now())
      // SOURCE 12, beside the nudge because they are the same job from two directions: the nudge catches
      // a rest that declared NOTHING, this catches one whose declaration stopped being true.
      evalParkIntegrity(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: sign-off nudge pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalRestPrompts(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: recurring-prompt rest pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalCompactPrompts(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: recurring-prompt compaction pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      await evalPrWatches(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: pr-watch registry pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalQuestionAnswers(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: question-answer pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalOwnWatches(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: watch registry pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalShellCompletions(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: shell-completion pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalTimers(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: one-off timer pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      repairDroppedReports(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: report-repair pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    reconcileOutbox(now())
    await deliverDue()
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.reject(new ProducerStoppedError("wake scheduler"))
    if (activeTick) return activeTick
    const task = runTick()
    activeTick = task
    task.then(
      () => { if (activeTick === task) activeTick = null },
      () => { if (activeTick === task) activeTick = null },
    )
    return task
  }

  return {
    start() {
      if (timer) return
      if (stopped) throw new ProducerStoppedError("wake scheduler")
      // Derive current state immediately (arms live waits; boot-safe — never fires on first sight).
      void tick().catch((error) => log(`waker: tick failed: ${error instanceof Error ? error.message : String(error)}`))
      timer = setInterval(() => {
        void tick().catch((error) => log(`waker: tick failed: ${error instanceof Error ? error.message : String(error)}`))
      }, tickMs)
      timer.unref?.()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      const draining = activeTick
      if (draining) await draining
    },
    tick,
    kick() {
      if (stopped || !timer) return
      void tick().catch((error) => log(`waker: kick failed: ${error instanceof Error ? error.message : String(error)}`))
    },
  }
}
