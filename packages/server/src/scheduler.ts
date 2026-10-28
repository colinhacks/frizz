import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, randomUUID } from "node:crypto"
import { awaitingNeedsInput, needsInputRequired, DONE_FENCE_CORRECTION_LEAD, doneOverOpenQuestionsBody, type DoneBlockingQuestion, questionFencesLive, PARK_CORRECTION_NAMES_LEAD, PARK_CORRECTION_NEEDS_INPUT_LEAD, PARK_CORRECTION_RETIRED_LEAD, interruptEndedSubAgentsMessage, type InterruptEndedSubAgent, parkExpiredWakeMessage, parkFinishedWakeMessage, prWatchExpiredWakeMessage, ownWatchExpiredWakeMessage, commandWatchPassedWakeMessage, commandWatchExpiredWakeMessage, commandWatchCancelledWakeMessage, questionAnswerMessage, questionsCancelledWakeMessage, type QuestionAnswer, type QuestionDismissal, RETIRED_AWAITING_REPLACEMENT, retiredAwaitingKindsIn, compactionPromptMessage, limitResumeSteer, limitModelSwitchSteer, formatGithubWakeSteer, GithubWakeItem, type GithubWatchStatus, type GithubIssueStatus, prWatchWakeMessage, prWatchGoneWakeMessage, issueWatchWakeMessage, shellDoneMessage, restPromptMessage, schedulePromptMessage, timerPromptMessage, signoffNudgeMessage, type SignoffLiveOps, liveOpsLines, mergedWakeMessage, type OffMergePath, wakeDeliveryToken, wakeTimeHeader, stripWakeTimeHeader, type QuotaSnapshot } from "@frizz/shared"
import { autonomousGoalOf, questionFenceCorrection, QUESTION_FAULTS_OUTLIVE_HUMAN_FROM, QUESTION_FENCES_REGISTER_FROM, standingQuestions, syncQuestionFences, type QuestionFaultBook } from "./question-fences.ts"
import { GITHUB_ISSUE_STATUS_SETTING, GITHUB_STATUS_SETTING, githubStatusKey, idlePrsOf, liveActivityOf, parkExpiresAt, parkIsHonoured, parkOnHuman, parkWaitsOnThisSide, readAwaitingPark, readGithubStatusBook, unaccountedItems, type AwaitingPark, type GithubStatusBook } from "./awaiting.ts"
import type { CommandWatchRow, PrWatchRow, SessionRow, Storage, ThreadQuestionRow } from "./storage.ts"
import type { CommandRunResult, CommandWatchService } from "./command-watch.ts"
import type { Tailer } from "./tailer.ts"
import type { SessionTelemetry } from "./tailer.ts"
import type { LimitFault } from "./backend/types.ts"
import { codexLimitFault, codexLimitRecovery } from "./backend/codex-usage-limit.ts"
import type { ProviderError } from "@frizz/shared"
import { limitFaultResetKey, limitPauseIsStale, mayHaveLiveBackgroundWork, quotaWindowKeyFor, quotaWindowRecovered, scopedQuotaWindow, scopedQuotaWindowRecovered, textResetInstant } from "./backend/usage-limit.ts"
import { claudeFallbackModel, claudeModelFromLimitName, claudeProfile, normalizeObservedThreadModel } from "./backend/thread-profiles.ts"
import { createWakeDeliveryStore, WAKE_QUIET_WINDOW_MS, type WakeDelivery } from "./wake-store.ts"
// The board owns the registered-done lifetime rule, and the waker must read it by exactly the same rule
// or the two disagree about whether a thread is finished.
import { answersInFlight, answersReceivedAt, registeredDoneFence, safeQuestionSpec, wakeQuestionAnswer } from "./board.ts"
import { ProducerStoppedError } from "./shutdown.ts"
import { completionsDueForRelay, relayMessage } from "./completion-relay.ts"
import {
  createGithubReviewFetcher,
  isBotGithubActor,
  parseGithubReviewActivities,
  type GithubReviewActivity,
  type GithubReviewFetchResult,
  type GithubIssueSnapshot,
  type GithubPrMergeExit,
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
// (`frizzctl timer`), a `pr_watch` row (`frizzctl watch-pr`, SOURCE 11), a background shell's own
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
  isDraft?: boolean
  /** In the merge queue now (`{position}`), not in it (`null`), or not asked (absent). */
  queued?: { position?: number } | null
  /** Exits from the merge path that were not a merge — the queue dropping the PR, auto-merge going off.
   *  Absent on the `gh` fallback, which does not read the timeline. */
  mergeExits?: GithubPrMergeExit[]
  /** Who the PR waits on — see GithubPrSnapshot. Absent on the `gh` fallback, which does not ask. */
  autoMerge?: boolean
  viewerDidAuthor?: boolean
  viewerPermission?: string
  reviewRequestCount?: number
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
//
// READ IN GRAPHQL'S CASING, WHICHEVER FETCH PRODUCED THE RUN (2026-09-11). The batched poll's check
// suites conclude `ACTION_REQUIRED`; the `gh run list` fallback's runs conclude `action_required`,
// because that command prints the REST shape. Both readers here compared the raw string against the
// upper-case word, so a poll served by the fallback saw NO gated workflow and NO failed run at all — and
// a fork PR whose one rollup entry was a green `license/cla` CheckRun read as "✅ CI PASSED — 1 check
// green" on exactly the ticks the GraphQL batch failed. A batch fails as a unit (`fetch failed` on one
// request sends every armed ref down the fallback at once), and the next GraphQL poll read the same PR as
// gated again: two wakes per blip on every gated watcher, one of them false. microsoft/TypeScript#64172
// collected four such pairs in a week; typeorm/typeorm#12842 and Unitech/pm2#6151 flipped together at
// six instants over three days.
function runConclusion(run: WorkflowRun): string | undefined {
  return typeof run.conclusion === "string" ? run.conclusion.toUpperCase() : undefined
}

export function gatedWorkflowNames(runs: WorkflowRun[] = [], cap = 8): { names: string[]; total: number } {
  const names: string[] = []
  const seen = new Set<string>()
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== "object") continue
    if (runConclusion(run) !== "ACTION_REQUIRED") continue
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
    const conclusion = runConclusion(run)
    if (conclusion === "ACTION_REQUIRED") continue
    if (!rollupEntryFailed(conclusion, undefined)) continue
    push(run.workflowName ?? run.name)
  }
  return { names: names.slice(0, cap), omitted: Math.max(0, names.length - cap) }
}

/** Least specific first: the paragraph for a later one says everything an earlier one's does. */
const OFF_MERGE_PATHS: readonly OffMergePath[] = ["auto-merge-off", "dequeued", "queue-failed"]
function mostSpecificOffMergePath(paths: (OffMergePath | undefined)[]): OffMergePath | undefined {
  return paths.reduce<OffMergePath | undefined>(
    (best, p) => (p && (best === undefined || OFF_MERGE_PATHS.indexOf(p) > OFF_MERGE_PATHS.indexOf(best)) ? p : best),
    undefined,
  )
}

/** One clause of the state line for a merge-path exit — what happened, who did it when it was not GitHub
 *  itself, GitHub's reason, and for a queue that failed the PR, the merge-group checks that failed. The
 *  names are the point: they ran on the `gh-readonly-queue/…` commit, so nothing on the PR names them. */
export function mergeExitClause(exit: GithubPrMergeExit, queued: { position?: number } | null | undefined): string {
  const by = exit.actor && !/^github-merge-queue(\[bot\])?$/.test(exit.actor) ? ` by @${exit.actor}` : ""
  const reason = exit.reason?.toLowerCase().replace(/_/g, " ")
  const failed = mergeGroupFailures(exit)
  const detail = failed.names.length
    ? `${reason ?? "failed checks"}: ${failed.names.join(", ")}${failed.omitted ? `, +${failed.omitted} more` : ""}`
    : reason
  const what = exit.kind === "dequeued" ? "REMOVED from the merge queue" : "auto-merge turned OFF"
  const back = queued ? `, and is back in the queue${queued.position ? ` at position ${queued.position}` : ""}` : ""
  return `${what}${by}${detail ? ` (${detail})` : ""}${back}`
}

/** Which next step an exit calls for — see `OffMergePath`. A queue exit counts as failed on GitHub's own
 *  reason or on a failed check in its merge group (a PR removed by hand while a job was red). */
export function offMergePathOf(exit: GithubPrMergeExit): OffMergePath {
  if (exit.kind !== "dequeued") return "auto-merge-off"
  return exit.reason?.toLowerCase() === "failed_checks" || mergeGroupFailures(exit).names.length > 0 ? "queue-failed" : "dequeued"
}

function mergeGroupFailures(exit: GithubPrMergeExit): { names: string[]; omitted: number } {
  // The jobs that FAILED before the ones that were CANCELLED, which `failedCheckNames` counts as failed
  // too. A merge group fails fast — one job goes red and the queue cancels the rest — so in rollup order
  // the cancellations fill the cap and the cause is counted in "+N more": bytecodealliance/wasmtime#14375
  // (2026-09-22) had 26 cancelled jobs and 1 failure, listed 14th.
  const rollup = (exit.rollup ?? []) as RollupEntry[]
  const cancelled = (c: RollupEntry) => c?.conclusion === "CANCELLED"
  return exit.kind === "dequeued"
    ? failedCheckNames([...rollup.filter((c) => !cancelled(c)), ...rollup.filter(cancelled)])
    : { names: [], omitted: 0 }
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
    ...githubWaitingOn(pr),
  }
}

// WHO A PR IS WAITING ON, in the facts awaiting.prWaitsOnNoOne reads. Each is left out unless the
// poll actually said: a guess of "nobody" would pull a thread out of Snoozed that something will wake.
function githubWaitingOn(pr: PrStatus): Pick<GithubWatchStatus, "mergePath" | "viewerAuthored" | "viewerCanMerge" | "reviewRequested"> {
  const mergePath = pr.queued ? "queued" as const
    : pr.autoMerge ? "auto" as const
    : pr.queued === null && pr.autoMerge === false ? "none" as const
    : undefined
  return {
    ...(mergePath ? { mergePath } : {}),
    ...(pr.viewerDidAuthor !== undefined ? { viewerAuthored: pr.viewerDidAuthor } : {}),
    ...(pr.viewerPermission !== undefined ? { viewerCanMerge: MERGING_PERMISSIONS.has(pr.viewerPermission) } : {}),
    // The raw count, not `reviewRequests`: that list keeps only the reviewers with a name, and a request to
    // an unnamed one (a team the token cannot see) is still a wait on someone.
    ...(pr.reviewRequestCount !== undefined ? { reviewRequested: pr.reviewRequestCount > 0 } : {}),
  }
}

const MERGING_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE"])

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
 *  (`frizzctl watch-pr`) will fire, so the Goal holds; a `prs:` entry with no registration behind it
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
  return new Set(storage.listPrWatches(slug, { armedOnly: true }).filter((w) => w.kind !== "issue").map((w) => `${w.owner}/${w.repo}#${w.number}`))
}

/** The ISSUES a thread has registered (`frizzctl watch-issue`), by the same `owner/repo#N` — what an
 *  `issues:` fence entry is checked against. */
function registeredIssueWatchesOf(storage: Storage, slug: string): ReadonlySet<string> {
  return new Set(storage.listPrWatches(slug, { armedOnly: true }).filter((w) => w.kind === "issue").map((w) => `${w.owner}/${w.repo}#${w.number}`))
}

/** This thread's ARMED command watch ids (`frizzctl watch-command`) — what a `commands:` entry is
 *  checked against. Only ARMED: a watch that passed has delivered its wake, and one that expired or was
 *  cancelled will never send one, so a park naming either is waiting on nothing. */
function armedCommandWatchIdsOf(storage: Storage, slug: string): ReadonlySet<string> {
  return new Set(storage.listCommandWatches(slug, { armedOnly: true }).map((w) => w.id))
}

/** The same set as the nudge and the corrections print it: the id, and the command as its label. */
function commandWatchOps(storage: Storage, slug: string): { id: string; label: string }[] {
  return storage.listCommandWatches(slug, { armedOnly: true })
    .map((w) => ({ id: w.id, label: w.command.trim().replace(/\s+/g, " ").slice(0, 80) }))
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
// the context is gone. The row is durable, it is visible in the thread's Goal panel, and the operator can edit
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

/** The delivery namespace of an INTERRUPT that ended background sub-agents (SOURCE 10). Keyed on the
 *  interrupt's own instant: one interrupt, one note, however many children it took with it. The router
 *  enqueues it (followUp `interrupt` / deliverQueuedNow) once the tailer has confirmed the children are
 *  gone; the scheduler only delivers. Bound to a FACT, like a shell completion — nothing the thread
 *  writes can make "those sub-agents ended" untrue — and deliverable INTO the busy turn, because the
 *  worker is mid-turn on the very follow-up that killed them and would otherwise rest on a dead id. */
const INTERRUPT_ENDED_FENCE_PREFIX = "interrupt-ended"
function isInterruptEndedFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${INTERRUPT_ENDED_FENCE_PREFIX}:`)
}

export function enqueueInterruptEndedWake(
  storage: Storage,
  input: { slug: string; sessionId: string; interruptedAtMs: number; agents: readonly InterruptEndedSubAgent[]; nowMs?: number },
): void {
  if (input.agents.length === 0) return
  const fenceId = `${INTERRUPT_ENDED_FENCE_PREFIX}:${input.interruptedAtMs}`
  createWakeDeliveryStore(storage.scope).enqueue({
    id: wakeDeliveryId(input.slug, input.sessionId, fenceId),
    slug: input.slug,
    sessionId: input.sessionId,
    fenceId,
    hintKey: fenceId,
    message: interruptEndedSubAgentsMessage(input.agents),
    reason: `an interrupt ended ${input.agents.length} background sub-agent(s)`,
  }, input.nowMs ?? Date.now())
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

/** A COMMAND WATCH's wakes (SOURCE 13), one namespace per piece of news: it PASSED, its `for` ran out,
 *  or Frizz stopped it because the thread may no longer have commands run for it. Each is one-shot — the
 *  row is settled by the time the wake is sent — so the id alone is the key, and three prefixes rather
 *  than one so a watch that is cancelled and later re-registered under the same id (it cannot be; ids are
 *  random) could never dedupe against the wrong news. Checked as THREE spellings for the reason
 *  isPrWatchFenceId is: `cmdwatch-expired:` does not start with `cmdwatch:`. */
const COMMAND_WATCH_FENCE_PREFIX = "cmdwatch"
const COMMAND_WATCH_EXPIRED_FENCE_PREFIX = "cmdwatch-expired"
const COMMAND_WATCH_CANCELLED_FENCE_PREFIX = "cmdwatch-cancelled"
function isCommandWatchFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${COMMAND_WATCH_FENCE_PREFIX}:`)
    || fenceId.startsWith(`${COMMAND_WATCH_EXPIRED_FENCE_PREFIX}:`)
    || fenceId.startsWith(`${COMMAND_WATCH_CANCELLED_FENCE_PREFIX}:`)
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

/** HOW LONG A FAILED BATCH OF ANSWERS WAITS before it is offered again with nothing to say the worker can
 *  take it now. An answer is only `delivered` once the wake carrying it lands (evalQuestionAnswers), so a
 *  wake that exhausts its attempts leaves the answer undelivered rather than spent — and something has to
 *  decide when to try again. A restart of this server or a turn the worker ran since the failure opens
 *  the gate at once (each is evidence the runtime that refused it has changed); this is the floor for a
 *  thread where neither happens, so a transient failure — the 2026-09-30 broker resume race was one —
 *  costs the human half an hour rather than the answer. One retry round is the outbox's own attempt cap
 *  (`maxDeliveryAttempts`), so a permanently broken runtime pays that many attempts per window, not a
 *  loop on every tick. */
export const ANSWER_REOFFER_BACKOFF_MS = 30 * 60_000

/** The reason the outbox records on a row `deliveryContext` superseded — the session moved, or the thread
 *  was archived — as opposed to a delivery `resume` abandoned. evalQuestionAnswers reads it: a batch of
 *  answers superseded this way before anything crossed the transport is re-offered at once, because
 *  nothing about the runtime refused it. */
const CONTEXT_SUPERSEDED = "the exact awaiting fence or session was superseded"

/** How often a registered watcher re-reads GitHub, per PR. The fence poller's floor, for the same
 *  reason: this is somebody else's API and the answer changes on a human's timescale. */
const PR_WATCH_POLL_MS = 60_000
/** How long GitHub must keep answering NOT_FOUND for a watched PR or issue before its watcher settles and
 *  tells its worker. Long enough that no blip ends a watch; short against a `for:` that can run a year. */
const PR_WATCH_GONE_MS = 30 * 60_000

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
 *  uncounted — re-parking on still-running work is unlimited by explicit decision (2026-08-15).
 *  The count comes back for an honoured park, a ```question fence that registers, and a message the
 *  human types (evalParkBumpRelease). */
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


/** SOURCE 12's delivery namespace — `park:<cause>:<the rest it corrects>`. The cause is in the key so a
 *  fence bumped for a dead id and later for expiry is two pieces of news rather than one deduped away. */
const PARK_FENCE_PREFIX = "park"
/** The cause a ```question fence correction rides under: `park:question-fence:<rest>`. A park cause so it
 *  shares the corrective cap and the superseded-by-a-newer-rest check every fence correction has. */
const QUESTION_FENCE_CAUSE = "question-fence"
/** The cause a ```done fence's correction rides under when it closed a rest over an open question
 *  (SOURCE 15): `park:done-open-question:<rest>`. A park cause for the same two reasons. */
const DONE_OVER_QUESTION_CAUSE = "done-open-question"
/** No ```done fence written before this instant is corrected for an open question. The gate arrived with
 *  the ```question fence's own cutover, and a refold of an older transcript must not wake a thread that
 *  has rested on a done card for a week to tell it about a rule it was never under. */
const DONE_GATE_FROM_MS = Date.parse(QUESTION_FENCES_REGISTER_FROM)
/** From this instant a refused ```question fence stays owed its correction across the human's typed
 *  messages (SOURCE 14). */
const FAULTS_OUTLIVE_HUMAN_FROM_MS = Date.parse(QUESTION_FAULTS_OUTLIVE_HUMAN_FROM)
/** The correction for a park parkWaitsOnThisSide refused: each PR with what is left to do on it, read off
 *  the same reading that refused it, then the two ways out. */
function prsWaitOnThisSideMessage(park: AwaitingPark, github: GithubStatusBook): string {
  const lines = park.items.map((i) => {
    const ref = parsePrRef(i.value)
    const status = ref ? github[githubStatusKey(ref)] : undefined
    const left = status?.checks === "failing" ? "CI FAILED, and nobody else will push the fix"
      : status?.merge === "conflicting" ? "it CONFLICTS with its base, and nobody else will resolve it"
      : "green and mergeable, no review requested and nothing set to merge it: only the merge is left"
    return `- \`prs: [${i.value}]\` — opened by the signed-in GitHub account; ${left}`
  })
  return [
    `${PARK_CORRECTION_NAMES_LEAD}only pull requests that wait on this side, so it is not a park and your thread is in the human's queue.`,
    "",
    ...lines,
    "",
    "A PR watcher reports change, and none is coming. Push the fix, or hand the merge to the human with",
    "`steps:` (one step, linking the PR). If it waits on someone GitHub does not show, say who in a",
    "`needs_input` handoff.",
  ].join("\n")
}

function parkFenceId(cause: string, spokeAt: string): string {
  return `${PARK_FENCE_PREFIX}:${cause}:${spokeAt}`
}
function isParkFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${PARK_FENCE_PREFIX}:`)
}
/**
 * Is this thread's corrective allowance spent, as far as a correction for `restedAt` is concerned?
 *
 * ONE REST SPENDS ONE BUMP (2026-10-13). Every counted correction anchors its count on the REST it
 * corrects (storage countParkBump is a no-op for an anchor it has already counted), so a rest with two
 * things wrong costs what a rest with one does. Until then each correction counted for itself: a broken
 * ```question fence beside an ```awaiting fence naming a dead shell drew SOURCE 14's correction and
 * SOURCE 12's, spent two of the three bumps, and a second such rest silenced the thread.
 *
 * The rest that took the LAST bump is therefore not spent for its own second correction: the count says
 * three rests were corrected, and this is still the third. A rest draws at most one correction per cause
 * (the delivery id), so that is bounded by the handful of causes there are.
 */
function parkCapSpent(row: Pick<SessionRow, "park_bumps" | "park_bump_anchor">, restedAt: string): boolean {
  return (row.park_bumps ?? 0) >= PARK_BUMP_MAX && row.park_bump_anchor !== restedAt
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

/** The issue twin of `probePrReadable`: one `gh issue view`, asked at registration, so a
 *  `watch_issue` on something the server's own `gh` cannot see is refused rather than armed.
 *
 *  AND A PULL REQUEST NUMBER IS REFUSED HERE TOO. `gh issue view` answers for a PR number (measured
 *  2026-09-14 against colinhacks/zod#6382: `{"state":"CLOSED","url":".../pull/6382"}`), while the poll's
 *  `issue(number:)` GraphQL field does not — so a PR registered as an issue would pass a bare probe and
 *  then fail every poll in silence, the exact dead watcher the probe exists to prevent. The URL is the
 *  tell, and the refusal names the right tool. */
export async function probeIssueReadable(ref: PrRef): Promise<PrProbe> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["issue", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", "state,url"],
      { timeout: 15_000, maxBuffer: 1_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    const url = (JSON.parse(stdout) as { url?: unknown })?.url
    if (typeof url === "string" && /\/pull\/\d+$/.test(url)) {
      return { ok: false, reason: `#${ref.number} is a pull request, not an issue — register it with \`frizzctl watch-pr add\`` }
    }
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
  /** Where every question-fence sync records what it refused, for the board (question-fences.ts
   *  QuestionFaultBook) — the same book the registrar and the router write, so the correction this
   *  scheduler sends and the refusal the board shows are one reading. */
  questionFaults?: QuestionFaultBook
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
  codexTurnLiveness?: (slug: string, sessionId: string) => { bridgeTurn: boolean; providerError?: ProviderError } | undefined
  fetchPr?: (ref: PrRef) => Promise<PrStatus | undefined>
  // Tests may keep injecting the historical bare array/undefined result. Production uses the
  // structured result so the scheduler can distinguish auth, timeout, network, API, and shape faults.
  fetchGithubReview?: (ref: PrRef) => Promise<GithubReviewActivity[] | GithubReviewFetchResult | undefined>
  // SOURCE 13's runner and gate (command-watch.ts), bound to this project. Absent ⇒ no command watch is
  // ever RUN (expiry still settles and wakes), which is what a test that is not about them wants.
  commandWatches?: CommandWatchService
  log?: (msg: string) => void
  // After `resume` has handed a wake to the worker's runtime: is the process that took it still there?
  // A broker daemon now ACKNOWLEDGES the input (input-ack-v1), so `resume` returning means the session
  // queued it — but a daemon forked by an older build only proves the frame was written, and a cold
  // resume that dies at startup takes its queued input with it either way — so "resume returned" is
  // still SENT, not delivered. Answering "alive" or "dead" lets the
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
  /** Resolves once every command-watch check in flight has finished and been recorded (SOURCE 13 starts
   *  them without awaiting, so a two-minute check never holds up the tick). Tests await it between ticks. */
  commandRunsIdle?(): Promise<void>
}

/** The FENCE key a wire kind is written as. The wire kinds stayed SINGULAR through the 2026-08-24 YAML
 *  cutover; the grammar the worker writes did not, so every message that quotes a fence line back at a
 *  worker has to translate — printing `i.kind` raw teaches a spelling the parser now refuses. */
const AWAITING_KEY_OF: Record<"shell" | "agent" | "timer" | "pr" | "issue" | "command", string> = {
  shell: "shells", agent: "agents", timer: "timers", pr: "prs", issue: "issues", command: "commands",
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
  // When this scheduler came up: a failed delivery older than this was refused by a previous process, and
  // a restart is the usual place a broken runtime gets fixed (answerReofferDue).
  const startedAtMs = now()
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

  /** The issue twin of `publishGithubStatus`, into its own book (see GITHUB_ISSUE_STATUS_SETTING). */
  function publishGithubIssueStatus(key: string, issue: GithubIssueSnapshot, nowMs: number): void {
    const raw = deps.storage.getSetting(GITHUB_ISSUE_STATUS_SETTING)
    const book = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
    const reading: GithubIssueStatus = {
      state: issue.state.toUpperCase() === "CLOSED" ? "closed" : "open",
      ...(issue.stateReason ? { stateReason: issue.stateReason.toLowerCase() } : {}),
      ...(issue.title ? { title: issue.title } : {}),
      comments: issue.comments,
      polledAt: new Date(nowMs).toISOString(),
    }
    book[key] = reading
    const keys = Object.keys(book)
    for (const stale of keys.slice(0, Math.max(0, keys.length - GITHUB_STATUS_CAP))) delete book[stale]
    deps.storage.setSetting(GITHUB_ISSUE_STATUS_SETTING, book)
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

  function limitTelemetry(row: SessionRow): SessionTelemetry | undefined {
    const tele = deps.tailer.get(row.slug)
    const live = row.backend === "codex" ? deps.codexTurnLiveness?.(row.slug, row.session_id) : undefined
    if (live?.bridgeTurn) return tele ? { ...tele, turn: "in-flight" } : undefined
    const error = live?.providerError
    if (!error || error.retrying || !error.at || (tele?.lastActivityAt && error.at < tele.lastActivityAt)) return tele
    // Same canonical timestamp as the board: the app-server echo and rollout record describe ONE
    // interruption, not two opportunities to wake it. Newer user/output records supersede either.
    const same = tele?.providerError?.message === error.message && tele?.providerError?.code === error.code
    const at = same ? tele?.providerError?.at ?? error.at : error.at
    return {
      subAgents: [], bgShells: [], ...tele, turn: "idle", permPrompt: false, pendingQuestion: false,
      limitFault: codexLimitFault(error, at),
    }
  }

  function deliveryContext(item: WakeDelivery): DeliveryContext {
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return "superseded"
    if (row.state === "archived" || row.archived === 1) return "superseded"
    const tele = isLimitFenceId(item.fenceId) ? limitTelemetry(row) : deps.tailer.get(item.slug)
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
    // The interrupt note is the same shape: sub-agents that ended have ended, whatever the thread says next.
    if (isInterruptEndedFenceId(item.fenceId)) {
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
    // A COMMAND WATCH's wake is bound to a check that already ran (or a clock that already ran out, or a
    // gate that already closed) — and its row is settled before the wake can be sent, so the worker has
    // nothing left to withdraw. No fence, rest or edit makes it untrue. Same branch, same reason, and
    // the same silent never-delivered bug if it is missing.
    if (isCommandWatchFenceId(item.fenceId)) {
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
      if (tele.authFault || tele.apiFault) return "superseded"
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
      if (tele.authFault || tele.apiFault) return "superseded"
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
      // THE ONE CORRECTION WHOSE FAULT CAN END WITHOUT THE WORKER (SOURCE 15). A ```done fence is wrong only
      // while a question is open, and the human closes a question from the card: an answer is its own wake,
      // a press of the × is no record at all. Told afterwards that a question is open, a finished thread
      // would be woken to withdraw something that is no longer there. Re-reading the rows cannot race the
      // worker's own fix, which takes a turn and so a new rest, caught by the line above.
      if (item.fenceId === parkFenceId(DONE_OVER_QUESTION_CAUSE, tele.lastAssistantAt ?? "") && !deps.storage.listThreadQuestions(item.slug).some((q) => q.state === "open")) return "superseded"
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
    // The interrupt note too: the worker is BUSY precisely because the interrupt just opened a turn on
    // the human's follow-up, and that turn is where it decides to wait on the child that no longer exists.
    if (isInterruptEndedFenceId(item.fenceId)) return true
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
      const tele = limitTelemetry(row)
      const fault = tele?.limitFault
      const spent = spentCodexResume.get(row.slug)
      if (!fault && spent && !tele?.apiFault && Date.parse(tele?.lastAssistantAt ?? "") > spent.at) {
        spentCodexResume.delete(row.slug) // real successful output, not just a retry request
      }
      if (!fault || tele?.turn !== "idle") continue
      // The boot guard, and the same age policy the board renders — so a card never promises a wake
      // the waker has already written off. A Codex fault names no window, but Codex meters a weekly
      // one (on a Pro account it is the only one reported, 2026-10-21), so its bound is the weekly
      // span: the unknown window's 5h would write off every weekly cap more than 41h from its reset.
      // The live capacity reading, not this clock, decides when it wakes.
      if (limitPauseIsStale(fault.codex ? "weekly" : fault.window, Date.parse(fault.at), nowMs)) continue
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
  const spentCodexResume = new Map<string, { key: string; at: number }>()

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

    if (c.backend === "codex") {
      // Unknown Codex windows never borrow Claude's reset-clock heuristic. The live read must
      // postdate the failure and the minimum age also lets pre-failure quota memo entries expire.
      if (!Number.isFinite(faultAtMs) || nowMs - faultAtMs < LIMIT_HEADROOM_MIN_FAULT_AGE_MS) return undefined
      const recovery = codexLimitRecovery(c.fault, provider, nowMs)
      if (recovery === "blocked") {
        spentCodexResume.delete(c.slug)
        return false
      }
      if (!recovery || spentCodexResume.get(c.slug)?.key === recovery.key) return undefined
      spentCodexResume.set(c.slug, { key: recovery.key, at: nowMs })
      return true
    }

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
      // The awaited live request may have STARTED after this tick's original clock sample. Compare
      // its freshness against the current clock, or valid post-tick evidence reads as future data.
      if (!fallback && limitRecovered(c, quota, now()) !== true) continue
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
          : c.backend === "codex" ? `Codex capacity recovered (interrupted ${c.fault.at})`
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
      //
      // EXCEPT A WATCH, UNDER THE ANSWER-REQUIRED CONTRACT (2026-10-01). A registration says WHEN the
      // worker wakes; it cannot say where the rest sits meanwhile, and on a thread dispatched at or after
      // NEEDS_INPUT_REQUIRED_AT that answer (`status:`) lives only in the fence. So a rest behind a `watch`
      // with no fence is a bare rest there — it queues (board.needsInputQueues), and this teaches the
      // fence that would have kept it out.
      //
      // AN OPEN QUESTION SIGNS OFF ONLY THE REST IT STANDS AT (2026-10-05, narrowed 2026-10-13): the rest
      // that asked it, or a later one whose message references it with an `id:` fence (standingQuestions).
      // An older question nobody referenced says nothing about THIS rest — it stays answerable where it was
      // asked — so a rest that says nothing else is a bare one. From 2026-10-05 to 2026-10-13 such a rest
      // drew a carried-question nudge demanding the worker name or withdraw every old question; the
      // maintainer dropped that rule with the ```question fence ("questions may get registered and never
      // answered, and then they just sort of fade away. I think it's probably fine"), so this is the plain
      // sign-off nudge like any other bare rest.
      //
      // A FENCE THAT COULD NOT REGISTER is answered by its own correction (evalQuestionFences, which runs
      // first in the tick), not by this: telling the worker it signed off with nothing while its question
      // is being corrected would be two contradictory messages about one rest.
      //
      // …AND BY NOTHING ONCE THAT CORRECTION'S CAP IS SPENT (2026-10-13). This used to stand down only for
      // a correction that was actually in the outbox, so the rest the cap silenced fell through to here:
      // a worker that kept writing the same broken ```question fence got three corrections and then this
      // reminder twice, opening "You rested without a fence" to a worker whose message was a fence. The
      // sentence was false, and the two extra wakes were the cap being spent a second time under another
      // name. Keyed on the FAULT (questionFaultRests, rebuilt by evalQuestionFences just before this pass,
      // whether or not it could still correct), exactly as SOURCE 12's reset is. Saying something true
      // instead was the alternative, and it is a fourth and fifth correction: the worker has been told
      // three times what is wrong with that fence. The thread stays where the board already has it, a
      // rest with its refused fence drawn as the code block it is, for the human to read. (Below the
      // sign-off test on purpose: a rest that ALSO carries a fence Frizz honours is signed off as before.)
      const needsInput = needsInputRequired(row.spawned_at)
      const questionRows = deps.storage.listThreadQuestions(row.slug)
      const standing = standingQuestions(questionRows, tele, deps.questionFaults?.of(row.slug))
      if (outbox.get(wakeDeliveryId(row.slug, row.session_id, parkFenceId(QUESTION_FENCE_CAUSE, spokeAt)))) continue
      if (
        tele.lastFence ||
        tele.pendingQuestion ||
        registeredDoneFence(deps.storage.getThreadDone(row.slug), tele.lastUserAt) !== undefined ||
        standing.length > 0 ||
        answersInFlight(questionRows, answersReceivedAt(tele), row.recurring_on_rest === 1 && Boolean(row.recurring_prompt?.trim())) !== undefined ||
        (!needsInput && deps.storage.listThreadWatches(row.slug, { armedOnly: true }).length > 0)
      ) {
        if ((row.signoff_nudges ?? 0) > 0) deps.storage.resetSignoffNudges(row.slug)
        continue
      }
      // The rest's ```question fence failed and its correction is capped: nothing to say (see above).
      if (questionFaultRests.get(row.slug) === spokeAt) continue
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
      // THIS THREAD's live ops and their ids, so the agent can write a correct fence without going
      // looking for an id it cannot see. Shells are named by `taskId` — the handle the runtime actually
      // showed the worker — because that is the string it will naturally reach for, and the one the
      // fence's own integrity check matches on.
      const ops: SignoffLiveOps = {
        shells: (tele.bgShells ?? []).filter((sh) => sh.state === "running").map((sh) => ({ id: sh.taskId ?? sh.id, label: sh.label })),
        subAgents: (tele.subAgents ?? []).filter((a) => a.state === "running").map((a) => ({ id: a.taskId ?? a.id, label: a.label })),
        // The other two registries, so the nudge lists EVERY kind an awaiting fence can name rather
        // than the two the fold happens to know about — a worker told about half its work writes half
        // a fence, and the half it left out is not what gets it bumped.
        timers: deps.storage.listThreadTimers(row.slug, { armedOnly: true })
          .map((t) => ({ id: t.id, label: t.prompt.trim().replace(/\s+/g, " ").slice(0, 80) })),
        prs: deps.storage.listPrWatches(row.slug, { armedOnly: true }).filter((w) => w.kind !== "issue")
          .map((w) => ({ id: `${w.owner}/${w.repo}#${w.number}`, label: `${w.owner}/${w.repo}#${w.number}` })),
        issues: deps.storage.listPrWatches(row.slug, { armedOnly: true }).filter((w) => w.kind === "issue")
          .map((w) => ({ id: `${w.owner}/${w.repo}#${w.number}`, label: `${w.owner}/${w.repo}#${w.number}` })),
        commands: commandWatchOps(deps.storage, row.slug),
      }
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: SIGNOFF_HINT_KEY,
        message: withClock(signoffNudgeMessage(ops, needsInput), spokeAt),
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


  // ---- THE HUMAN TYPING HANDS THE CORRECTIVE ALLOWANCE BACK (2026-10-13) ----------------------------
  //
  // PARK_BUMP_MAX exists to break a closed loop between Frizz and a worker: correct, wake, the same
  // mistake under a new instant, correct. Its count came back for two things only, both of them things
  // Frizz cannot cause by correcting: a park it could honour, and a ```question fence that registered.
  // So a worker that used up its three corrections and did neither was never corrected again, for
  // anything, for the life of the thread — whatever the human said to it afterwards. Driven through a
  // real broker (verify-question-fence-wakes, case L): a fence with no `kind:` at every rest, three
  // corrections, a silent fourth rest as intended; the human replies, the worker writes the same fence,
  // and nothing was ever queued for it again. `park_bumps` 3, with an anchor three rests old.
  //
  // A MESSAGE THE HUMAN TYPES IS THE THIRD THING FRIZZ CANNOT CAUSE, and it is the one that ends the
  // episode the count was about: they have seen the thread, and what the worker does next is a new
  // attempt in front of them, not another lap of the loop. Every count is anchored on the REST it
  // corrected (countParkBump), so a `restFromAt` later than the anchor means the human has typed since
  // the last correction was counted, and the allowance is handed back — for every counted correction
  // alike: a dead, nameless or retired park, a missing `status:`, a ```question fence, a ```done fence.
  // Reset in storage, so the row says what the scheduler acts on, and here, ahead of the three passes
  // that read the cap, so none of them reads a stale one. (The per-cause budgets of SOURCES 14 and 15
  // key on the same boundary and come back in the same instant: correctionAllowedSinceHuman.)
  //
  // `restFromAt` AND NOTHING ELSE. It moves only on a message the human typed (shared
  // isHumanTypedMessage): not on a wake, not on a correction, not on Retry's fixed sentence, not on
  // answers sent with nothing typed beside them. `lastUserAt` moves on every one of those, Frizz's own
  // corrections included, and a reset keyed on it would be the correction resetting its own cap. A tail
  // folded before `restFromAt` existed therefore hands nothing back until its human next types.
  //
  // AN ANCHOR WRITTEN BEFORE THIS DATE IS A FENCE ID, `park:<cause>:<rest>`, not an instant: the rest is
  // read out of it, so a thread already stuck at the cap comes back when its human has typed since.
  // Anything else an anchor might hold parses to no instant and simply never matches.
  //
  // THE SIGN-OFF REMINDER'S CAP DOES NOT DO THIS, AND THE DIFFERENCE IS DELIBERATE — do not make either
  // match the other. SIGNOFF_NUDGE_MAX comes back only when the thread signs off (see "ONLY A FENCE
  // GIVES THE ALLOWANCE BACK" in the SOURCE 9 header, and the test that pins it). That comment names its
  // reason: the human's word was the original intent and could not be honoured, because Frizz's own
  // nudge lands as a user record and "the human spoke" was a condition the nudge satisfied by nudging.
  // It was written before `restFromAt` could tell the two apart. Whether the reminder's cap should now
  // follow is a decision about that cap, recorded there and not reopened here.
  function evalParkBumpRelease(): void {
    for (const row of deps.storage.allSessions()) {
      if ((row.park_bumps ?? 0) <= 0 || !row.park_bump_anchor) continue
      if (row.state === "archived" || row.archived === 1) continue
      const typedAt = Date.parse(deps.tailer.get(row.slug)?.restFromAt ?? "")
      const anchor = row.park_bump_anchor
      const countedAt = Date.parse(isParkFenceId(anchor) ? parkFenceRestOf(anchor) : anchor)
      if (!Number.isFinite(typedAt) || !Number.isFinite(countedAt) || typedAt <= countedAt) continue
      deps.storage.resetParkBumps(row.slug)
      log(`waker: ${row.slug} — corrective allowance handed back: the human has typed since the last correction`)
    }
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

  // ---- SOURCE 14: A ```question FENCE THAT COULD NOT REGISTER ----------------------------------------
  //
  // The registrar (question-fences.ts) runs on the tailer's clock and mints rows as fences land; this pass
  // re-reads the same sightings — a no-op for every fence that registered — to find the ones that could
  // not, and tells the worker at rest. Its question never reached the human, and nothing else would say
  // so: a malformed fence draws as an inert block, and the rest reads as signed off.
  //
  // ONE CORRECTION PER REST, at rest only, for the faults the worker has NOT BEEN TOLD ABOUT: the ones in
  // messages newer than the last correction of this kind Frizz delivered (`questionCorrectedAt`) — older
  // than that, it was in that correction. A refold after a restart replays the whole ring, and the instant
  // comes from the transcript, so it reads the same window. A fault the worker already fixed later — the
  // same id registered or referenced after it — is not news.
  //
  // THE HUMAN TYPING IS NOT THE WORKER BEING TOLD (2026-10-21). Until then the window also closed at the
  // human's last typed message (`restFromAt`), on the reading that the human had moved the thread on and
  // the mistake was moot. It is not moot: the worker still believes what its fence said. A pullfrog worker
  // rested on two `id:` references to questions no fence had ever asked, and the human's next message
  // landed 150ms after each rest — the queue delivered it as the turn ended, before a tick could see the
  // thread idle — so both faults fell outside the window untold. The worker kept writing "signing in waits
  // on the two cards I posted earlier", its compaction summary listed both as open, and the human saw two
  // bare `id:` code blocks where the cards should have been. So a fault now waits for the worker's next
  // rest, whatever the human wrote in between, and the correction says that the human has written since
  // (their message may already settle it). A fault from before QUESTION_FAULTS_OUTLIVE_HUMAN_FROM keeps
  // the old boundary, so the change does not wake every resting thread with an old untold fault.
  //
  // Until 2026-10-13 the window opened at the newest USER RECORD of any kind, so a broken fence written
  // mid-turn was forgotten if a timer or another wake landed before the worker went idle: its question
  // never reached the human and nothing said so. Counted against PARK_BUMP_MAX with the other fence
  // corrections; a fence that registers gives the allowance back (syncQuestionFences) — which is why this
  // correction is ALSO bounded by the human's last typed message (correctionAllowedSinceHuman).
  /** Each thread whose CURRENT rest wrote a ```question fence that could not register, keyed to that
   *  rest's instant — rebuilt by evalQuestionFences on every tick, corrected or not (the cap may have
   *  silenced it). SOURCE 12 reads it so an honoured park beside such a fence does not hand back the
   *  allowance the fence is spending. */
  const questionFaultRests = new Map<string, string>()
  function evalQuestionFences(nowMs: number): void {
    questionFaultRests.clear()
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele?.questionSightings?.length) continue
      const sync = syncQuestionFences(deps.storage, {
        slug: row.slug,
        spawnedAt: row.spawned_at,
        sightings: tele.questionSightings,
        autonomousGoal: autonomousGoalOf(row),
        faultBook: deps.questionFaults,
      })
      if (sync.registered.length > 0) log(`waker: ${row.slug} registered question(s) ${sync.registered.map((q) => q.handle).join(", ")}`)
      if (sync.faults.length === 0 || tele.turn !== "idle") continue
      // The agent must have spoken last, and the turn must have reached the model — SOURCE 9's guards.
      const spokeAt = tele.lastAssistantAt
      if (!spokeAt) continue
      if (tele.lastUserAt && Date.parse(spokeAt) <= Date.parse(tele.lastUserAt)) continue
      if (tele.authFault || tele.apiFault) continue
      const instant = (at: string | undefined) => (at ? Date.parse(at) : Number.NEGATIVE_INFINITY)
      const humanAt = instant(tele.restFromAt ?? tele.lastUserAt)
      const correctedAt = instant(tele.questionCorrectedAt)
      const untold = (at: string): boolean => {
        const atMs = Date.parse(at)
        return atMs > correctedAt && (atMs >= FAULTS_OUTLIVE_HUMAN_FROM_MS || atMs > humanAt)
      }
      const rows = deps.storage.listThreadQuestions(row.slug)
      const fixedAfter = (id: string | undefined, at: string): boolean => {
        if (!id) return false
        const atMs = Date.parse(at)
        const fixedByRow = rows.some((q) => q.handle === id && q.asked_at > atMs)
        const fixedByRef = sync.refs.some((r) => Date.parse(r.at) > atMs && rows.some((q) => q.id === r.rowId && q.handle === id))
        return fixedByRow || fixedByRef
      }
      const faults = sync.faults.filter((f) => untold(f.at) && !fixedAfter(f.id, f.at))
      if (faults.length === 0) continue
      const typedPast = faults.some((f) => Date.parse(f.at) < humanAt)
      // Only a fault written at THIS rest withholds the allowance: that is the worker repeating the
      // mistake. An older one still waiting to be told (the cap silenced it) must not also pin the count.
      if (faults.some((f) => Date.parse(f.at) > instant(tele.lastUserAt))) questionFaultRests.set(row.slug, spokeAt)
      // …AND THREE SINCE THE HUMAN LAST TYPED (2026-10-13), beside the shared cap, because the shared cap
      // can be handed back by the very rest being corrected: a fence that registers resets the count
      // (syncQuestionFences), so a worker that wrote one NEW valid question beside the same broken fence
      // at every rest was at zero again before each correction was counted. Measured: 8 identical rests,
      // 8 corrections, `park_bumps` never above 1. See correctionAllowedSinceHuman.
      if (parkCapSpent(row, spokeAt) || !correctionAllowedSinceHuman(row.slug, QUESTION_FENCE_CAUSE, tele)) continue
      const fenceId = parkFenceId(QUESTION_FENCE_CAUSE, spokeAt)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      // A ```done FENCE OVER A QUESTION THAT IS OPEN RIDES IN THIS MESSAGE (SOURCE 15), as a second
      // paragraph, when the same rest has both wrong: a fence that could not register, and a done fence
      // signing off over another question that did. One rest, one message, one bump — SOURCE 15 stands
      // down for a rest this correction took, and this is why it can.
      const underDone = correctionAllowedSinceHuman(row.slug, DONE_OVER_QUESTION_CAUSE, tele) ? questionsUnderDoneFence(row, tele, rows) : []
      // WITH NOTHING ELSE OPEN, THE DONE FENCE IS NOT YET WRONG — and it is about to be. The worker's fix
      // for this message is the same message with the fence repaired, done fence and all, which SOURCE 15
      // then corrects at the next rest. So the correction says so now, in one sentence, for exactly the
      // rest that closed on a done fence; every other rest gets the text unchanged.
      const closedOnDone = underDone.length === 0 && tele.lastFence?.kind === "done"
      const correction = underDone.length > 0
        ? `${questionFenceCorrection(faults, { typedPast })}\n\nSeparately, your \`\`\`done fence ${doneOverOpenQuestionsBody(underDone)}`
        : questionFenceCorrection(faults, { closedOnDone, typedPast })
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: fenceId,
        message: `${correction}\n\n${wakeTimeHeader(nowMs, spokeAt)}`,
        reason: `${faults.length} question fence(s) could not register`,
      }, nowMs).delivery
      deps.storage.countParkBump(row.slug, spokeAt)
      noteCorrectionSinceHuman(row.slug, QUESTION_FENCE_CAUSE, tele)
      if (underDone.length > 0) noteCorrectionSinceHuman(row.slug, DONE_OVER_QUESTION_CAUSE, tele)
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- SOURCE 15: A ```done FENCE OVER AN OPEN QUESTION ----------------------------------------------
  //
  // A worker signs off as finished two ways. `frizzctl done` is REFUSED while any question of the thread
  // is open (router markOwnDone), each one named by the worker's own id. The ```done fence cannot be
  // refused — it is a sentence in a message already written — so until 2026-10-13 the gate bound only the
  // workers that used the better command. With the fence the question still outranked the done on the
  // board, in the queue and on the mark, and the page drew the question with a done card and a live "Mark
  // as done" under it. Two outcomes, both bad: the worker had decided the question itself and forgotten to
  // withdraw it, so the human was asked something moot; or the human archived on the done card and the
  // question died unread. A question standing across every Frizz wake made the sequence ordinary: asked,
  // woken by a finished build, finished the rest, signed off done.
  //
  // So the fence is held to the same gate after the fact: ONE correction for the rest, naming each open
  // question by the worker's own id, with the two ways out the command's refusal gives (the paragraph is
  // one function in @frizz/shared, read by both). Nothing the board or the page draws changes.
  //
  // WHICH QUESTIONS: EVERY OPEN ONE, as the command — a question the human has typed past included. The two
  // sign-offs are taught as one thing, and "dies unread with a done card" is as true of a faded question
  // as of a standing one: it is still answerable on the page, and archiving still ends it. (Blocking only
  // on standing questions was the alternative. It would let a worker that was told "leave that for now"
  // finish and leave the question open under a done card for good, which is the first bad outcome above
  // with nobody left to notice.) A question written in the SAME message as the done fence is the same
  // case: the sync registers it before this reads the rows.
  //
  // WHICH RESTS: an idle rest whose sign-off is a done FENCE (`lastFence`: the fence that closes the
  // agent's last message — a done fence with a question fence under it is not a sign-off to Frizz and never
  // was), on a thread past the ```question cutover, in a message written since registration began. A
  // registered done cannot be here: `done` refuses while a question is open, and a question registering
  // clears the row.
  //
  // ON AN AUTONOMOUS (GOAL) THREAD a non-secret question is cancelled on the record, so the only question
  // that can be open is a `secret`, and the correction is as right there: a credential nobody supplied is
  // not a call the worker made by signing off. The Goal's own rest prompt already declines a rest that
  // said done; where it has been re-armed since, it stands down for this correction (evalRestPrompts).
  //
  // ONE VOICE PER REST. The sign-off reminder (SOURCE 9) never fires on a rest that carries a fence, and
  // park integrity (SOURCE 12) reads only an ```awaiting fence, so neither can share this rest. A
  // ```question fence that could not register (SOURCE 14) can: that correction runs first and carries this
  // one as its second paragraph, and this pass stands down for the rest it took. An ANSWER on its way
  // takes the rest too — its wake ends the rest by itself, and the worker's next sign-off is judged then.
  //
  // CAPPED TWICE. It counts against PARK_BUMP_MAX with every other fence correction, and it is bounded
  // by the human's last typed message (correctionAllowedSinceHuman, below): a worker can answer this
  // correction with a NEW question and another done fence, and the new question registering hands the
  // shared count back.

  // ---- THE SECOND BOUND ON SOURCES 14 AND 15: THREE PER CAUSE SINCE THE HUMAN LAST TYPED ---------------
  //
  // PARK_BUMP_MAX exists to break a closed loop — correct, wake, the same mistake under a new instant,
  // correct — and it rests on the count coming back only for something Frizz cannot cause by correcting.
  // A ```question fence registering is one of the things that gives it back, and both of these
  // corrections can be answered with exactly that: a new valid question beside the same broken fence
  // (SOURCE 14: 8 rests, 8 corrections, the count never above 1), or a new question beside another done
  // fence (SOURCE 15, the same arithmetic). So each also stops at PARK_BUMP_MAX corrections since the
  // human last typed to the thread — `restFromAt`, the one boundary nothing Frizz delivers can move. The
  // human typing hands it back: they have seen the thread.
  //
  // ONE BUDGET PER CAUSE, not one for both. They are different mistakes with different fixes, and a
  // thread that has used up its three corrections for done fences has been told nothing about question
  // grammar: sharing the budget would leave its next broken fence unreported, a question that never
  // reached the human with nobody told. Kept apart, the worst a thread can draw between two human
  // messages is three of each.
  //
  // WHAT IT COSTS: a worker that writes four broken fences between two human messages, and fixes each
  // one when told, is not told about the fourth. Refunding on a fix would close that and reopen the loop
  // (fix one, break another), so it is not refunded; the fourth draws as the code block it is, in a rest
  // the human's queue already holds.
  //
  // In memory: a restart hands back three, which is still a bound.
  const correctionsSinceHuman = new Map<string, { since: string; counts: Map<string, number> }>()
  function correctionAllowedSinceHuman(slug: string, cause: string, tele: Pick<SessionTelemetry, "restFromAt">): boolean {
    const sent = correctionsSinceHuman.get(slug)
    return !(sent && sent.since === (tele.restFromAt ?? "") && (sent.counts.get(cause) ?? 0) >= PARK_BUMP_MAX)
  }
  function noteCorrectionSinceHuman(slug: string, cause: string, tele: Pick<SessionTelemetry, "restFromAt">): void {
    const since = tele.restFromAt ?? ""
    const known = correctionsSinceHuman.get(slug)
    const sent = known && known.since === since ? known : { since, counts: new Map<string, number>() }
    sent.counts.set(cause, (sent.counts.get(cause) ?? 0) + 1)
    correctionsSinceHuman.set(slug, sent)
  }

  /** The open questions a ```done fence closed this rest over, by the worker's own ids — empty unless the
   *  rest is that shape. The caller has already established an idle rest the agent ended. */
  function questionsUnderDoneFence(row: SessionRow, tele: SessionTelemetry, rows: readonly ThreadQuestionRow[]): DoneBlockingQuestion[] {
    if (tele.lastFence?.kind !== "done") return []
    // A thread on the legacy contract keeps the free-form question fence and was never under this gate.
    if (questionFencesLive(row.spawned_at)) return []
    const spokeAt = tele.lastAssistantAt
    if (!spokeAt || !(Date.parse(spokeAt) >= DONE_GATE_FROM_MS)) return []
    if (answersInFlight(rows, answersReceivedAt(tele), autonomousGoalOf(row) !== undefined) !== undefined) return []
    // Named as `frizzctl done` names them (router markOwnDone), unreadable rows left out as there.
    return rows.flatMap((q) => {
      if (q.state !== "open") return []
      const spec = safeQuestionSpec(q.spec)
      return spec ? [{ id: q.handle ?? q.id, question: spec.question }] : []
    })
  }

  function evalDoneOverQuestions(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele || tele.turn !== "idle" || tele.lastFence?.kind !== "done") continue
      // The agent must have spoken last, and the turn must have reached the model — SOURCE 9's guards.
      const spokeAt = tele.lastAssistantAt
      if (!spokeAt) continue
      if (tele.lastUserAt && Date.parse(tele.lastUserAt) >= Date.parse(spokeAt)) continue
      if (tele.authFault || tele.apiFault) continue
      const blocking = questionsUnderDoneFence(row, tele, deps.storage.listThreadQuestions(row.slug))
      if (blocking.length === 0) continue
      // SOURCE 14 took this rest, and its message carried this one (see there). Whatever became of that
      // delivery, the rest has had its correction.
      if (outbox.get(wakeDeliveryId(row.slug, row.session_id, parkFenceId(QUESTION_FENCE_CAUSE, spokeAt)))) continue
      if (parkCapSpent(row, spokeAt) || !correctionAllowedSinceHuman(row.slug, DONE_OVER_QUESTION_CAUSE, tele)) continue
      const fenceId = parkFenceId(DONE_OVER_QUESTION_CAUSE, spokeAt)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: fenceId,
        message: `${DONE_FENCE_CORRECTION_LEAD}${doneOverOpenQuestionsBody(blocking)}\n\n${wakeTimeHeader(nowMs, spokeAt)}`,
        reason: `done fence over ${blocking.length} open question(s)`,
      }, nowMs).delivery
      deps.storage.countParkBump(row.slug, spokeAt)
      noteCorrectionSinceHuman(row.slug, DONE_OVER_QUESTION_CAUSE, tele)
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  function evalParkIntegrity(nowMs: number): void {
    // Read once per pass: which watched PRs wait on nothing but their own thread (parkWaitsOnThisSide).
    const github = readGithubStatusBook(deps.storage.getSetting(GITHUB_STATUS_SETTING))
    const idlePrs = idlePrsOf(github)
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

      // NO QUESTION CHECK HERE ANY MORE (2026-10-13). From 2026-08-28 an open registered question refused
      // the park — first any open question, then (2026-10-05) one the fence did not name under
      // `questions:`. The ```question fence retired that rule: an older question stands only where it was
      // asked or referenced (question-fences.ts standingQuestions) and never decides whether a park takes,
      // and a question asked or referenced at THIS rest queues the thread on the board whatever the fence
      // says (deriveNeedsYou reads it ahead of every park excusal). `questions:` is still READ, for a
      // worker whose contract predates the fence, as a claim on the named cards.
      const park = readAwaitingPark(tele.lastFence.hints)

      const live = liveActivityOf(
        tele,
        registeredPrWatchesOf(deps.storage, row.slug),
        armedTimerIdsOf(deps.storage, row.slug),
        registeredIssueWatchesOf(deps.storage, row.slug),
        armedCommandWatchIdsOf(deps.storage, row.slug),
        // Only on a QUIET park (`working` or `watching`), which is the one place the board reads it
        // (needsInputParkHolds). A `needs_input` handoff naming its own green PR is exactly the rest this
        // asks for, and a fence with no answer is judged by rules that never see the PR readings.
        awaitingNeedsInput(tele.lastFence.hints) === false ? idlePrs : undefined,
      )
      // A command watch's settled rows, by id: one that PASSED has already woken the thread, the way a
      // fired timer has, and one that expired or was cancelled is a wait that is over for another reason.
      const settledCommands = new Map(
        deps.storage.listCommandWatches(row.slug).filter((w) => w.state !== "armed").map((w) => [w.id, w.state] as const),
      )
      const deadAll = unaccountedItems(park.items, live)
      // A COMMAND WATCH THAT SETTLED UNDER THIS REST HAS ITS OWN WAKE ON THE WAY (2026-10-11). SOURCE 13
      // enqueues the pass / expiry / cancellation wake before it settles the row, so the moment the row
      // leaves `armed` the news is already queued — and a correction here would repeat it. Measured in the
      // e2e: the two went out merged as ONE delivery, the second half telling the worker "already PASSED —
      // its wake was delivered" in the same breath as the wake itself. So a settled watch whose own wake is
      // still in flight counts as accounted. Once that wake lands the worker's turn moves past this rest,
      // and a later fence naming the spent id is corrected as usual.
      const ownWakeInFlight = (i: { kind: string; value: string }): boolean => {
        if (i.kind !== "command") return false
        const settled = settledCommands.get(i.value)
        const prefix = settled === "passed" ? COMMAND_WATCH_FENCE_PREFIX
          : settled === "expired" ? COMMAND_WATCH_EXPIRED_FENCE_PREFIX
          : settled === "cancelled" ? COMMAND_WATCH_CANCELLED_FENCE_PREFIX
          : undefined
        if (!prefix) return false
        const wake = outbox.get(wakeDeliveryId(row.slug, row.session_id, `${prefix}:${i.value}`))
        return wake?.state === "pending" || wake?.state === "leased"
      }
      const dead = deadAll.filter((i) => !ownWakeInFlight(i))
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
      //
      // `steps:` NAME THE HUMAN (2026-10-03), so a fence carrying only steps is not this case: it waits on
      // the one party whose reply wakes the thread, from the queue it is already in. With no `for:` it
      // falls through the malformed-fence skip below and is simply honoured; with one, it expires.
      // `questions:` name the human the same way (2026-10-05), and the answer is the wake.
      const nameless = park.items.length === 0 && !parkOnHuman(park)
      // HONOURED ⇒ the corrective allowance comes back. A park frizz can actually honour is the one
      // event that proves a correction landed, and — unlike any activity signal — not one frizz can
      // cause by correcting. Guarded on a non-zero count so this is a transition, not a write on every
      // tick, exactly as the sign-off nudge's reset is. It deliberately does NOT `continue`: an honoured
      // park can still have run out, and that bump is owed.
      //
      // NO ANSWER (2026-10-01). A worker dispatched under the answer-required contract owes every park an
      // answer to "where does this rest sit?" (NEEDS_INPUT_REQUIRED_AT in @frizz/shared) — `status:` since
      // 2026-10-05, `needs_input:` before it and still read. A fence without one — or with a value frizz
      // cannot read — is not a park frizz may honour (the board queues the thread: needsInputParkHolds), so
      // it does not give the allowance back either: a worker that keeps leaving the line out would
      // otherwise reset its own cap on every rest.
      const unanswered = needsInputRequired(row.spawned_at) && awaitingNeedsInput(tele.lastFence.hints) === null
      // NOT ON A REST WHOSE ```question FENCE FAILED (2026-10-13). That fence's correction (SOURCE 14) counts
      // against this same cap, and evalQuestionFences runs first in the tick — so a broken question fence
      // written beside a valid park was counted and then handed straight back here, and a worker that kept
      // rewriting both was corrected on every rest without end (measured: six identical rests, six
      // corrections, the count never off zero). Keyed on the FAULT, not on a correction having gone out:
      // keyed on the correction, the rest the cap silenced reset the count and the loop resumed three
      // rests later. An honoured park proves the PARK is right, not the other fence in the same message.
      const questionFaulted = questionFaultRests.get(row.slug) === spokeAt
      if (parkIsHonoured(park, live) && !unanswered && !questionFaulted && (row.park_bumps ?? 0) > 0) deps.storage.resetParkBumps(row.slug)
      if (dead.length === 0 && !expired && !nameless) {
        // EVERY PR IT NAMES WAITS ON THIS SIDE (parkWaitsOnThisSide). Each is registered and its watcher
        // armed, so nothing above caught it, but the watcher reports CHANGE and none is coming: the next
        // act is a fix this thread pushes or a merge it hands over. Before 2026-10-28 the board queued this
        // park without telling the worker, which is the silent refusal the nameless note above records.
        if (!parkOnHuman(park) && parkWaitsOnThisSide(park, live)) {
          if (parkCapSpent(row, spokeAt)) continue
          const fenceId = parkFenceId("pr-idle", spokeAt)
          const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
          if (outbox.get(deliveryId)) continue
          const item = outbox.enqueue({
            id: deliveryId,
            slug: row.slug,
            sessionId: row.session_id,
            fenceId,
            hintKey: fenceId,
            message: `${prsWaitOnThisSideMessage(park, github)}\n\n${wakeTimeHeader(nowMs, spokeAt)}`,
            reason: "awaiting park names only PRs that wait on this side",
          }, nowMs).delivery
          deps.storage.countParkBump(row.slug, spokeAt)
          log(`waker: queued ${row.slug} — ${item.reason}`)
          checkpoint("after-enqueue", item)
          continue
        }
        // The answer is corrected only once the ITEMS are right. A fence that names dead work or none is
        // told about that first — adding `status:` would not make it a park, and a worker waiting on
        // nothing should end in ```done or a question, not be taught one more line of a fence it should
        // not be writing. Counted against PARK_BUMP_MAX like every other correction, keyed on the rest.
        if (!unanswered || parkCapSpent(row, spokeAt)) continue
        const fenceId = parkFenceId("needs-input", spokeAt)
        const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
        if (outbox.get(deliveryId)) continue
        // Quoted back when the worker wrote SOMETHING, so it sees the exact value frizz could not read —
        // the `status:` line it wrote, or else the older `needs_input:` one.
        const written = [...tele.lastFence.hints].reverse().find((h) => h.kind === "status") ?? [...tele.lastFence.hints].reverse().find((h) => h.kind === "needs_input")
        const message = [
          `${PARK_CORRECTION_NEEDS_INPUT_LEAD}\`status:\` that frizz can read — \`working\`, \`watching\` or \`needs_input\`${written ? ` (it says \`${written.kind}: ${written.value}\`)` : ""} — so frizz did not park it, and your thread is in the human's queue.`,
          "",
          "Every ```awaiting fence answers one question: where does this rest sit while the work runs?",
          "",
          "- `status: working` — the work finishes by itself: a test run, a build, CI, a sub-agent doing a job.",
          "  The thread shows as running until the work wakes you.",
          "- `status: watching` — the wait is on something outside the thread: a review, a release, a",
          "  reporter, another agent's merge. The thread is snoozed until the watch wakes you.",
          "- `status: needs_input` — the human can act on something now while the work runs. The thread goes",
          "  into their queue, and the prose under `---` says what to look at.",
          "",
          "With `working` or `watching` the fence alone is the whole message: no write-up.",
          "",
          "Re-send the same fence with that line added.",
        ].join("\n")
        const item = outbox.enqueue({
          id: deliveryId,
          slug: row.slug,
          sessionId: row.session_id,
          fenceId,
          hintKey: fenceId,
          message: `${message}\n\n${wakeTimeHeader(nowMs, spokeAt)}`,
          reason: "awaiting fence gives no status answer",
        }, nowMs).delivery
        deps.storage.countParkBump(row.slug, spokeAt)
        log(`waker: queued ${row.slug} — ${item.reason}`)
        checkpoint("after-enqueue", item)
        continue
      }
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
      // A DEMOTED shell is a third case, neither finished nor missing: frizz has its launch, saw no
      // completion notice, and can no longer find its process (tailer.ts probeShellsAlive). Calling that
      // "nothing by that name" sent a worker hunting for a typo in an id it had copied exactly — and,
      // before 2026-10-05, said so of a shell that was still running.
      const staleShellHandles = new Set<string>()
      for (const sh of tele.bgShells ?? []) {
        if (sh.state !== "stale") continue
        for (const h of [sh.taskId, sh.id, sh.label]) if (h) staleShellHandles.add(h)
      }
      const firedTimers = new Set(
        deps.storage.listThreadTimers(row.slug).filter((t) => t.state === "fired").map((t) => t.id),
      )
      const finishedItem = (i: { kind: string; value: string }) =>
        finishedHandles.has(i.value) || (i.kind === "timer" && firedTimers.has(i.value)) ||
        (i.kind === "command" && settledCommands.get(i.value) === "passed")
      const status = park.items.map((i) => {
        const gone = deadAll.some((d) => d.kind === i.kind && d.value === i.value)
        // AN UNREGISTERED PR GETS ITS OWN NOTE, because "nothing by that name" is true but useless for
        // this one kind. A shell or a sub-agent is unaccounted because it FINISHED or the id is wrong;
        // a PR is unaccounted because the worker never registered it — a different mistake with a
        // different fix, and naming the fix here is the whole basis of the maintainer's 2026-08-24
        // decision to keep declaring and registering separate ("the worker learns to call the tool
        // first"). Without this line the correction sends it to `frizzctl activity`, which will
        // faithfully report that it has no PRs — true, and no help at all.
        const note = !gone
          ? "still running"
          // A fired timer's "result" is the wake itself, already delivered as a user turn — so the
          // note points back at the transcript rather than at a result that is not a thing.
          : i.kind === "timer" && firedTimers.has(i.value)
          ? "already FIRED — its wake was delivered; there is nothing left to wait on"
          : i.kind === "command" && settledCommands.get(i.value) === "passed"
          ? "already PASSED — its wake was delivered; there is nothing left to wait on"
          : i.kind === "command" && settledCommands.has(i.value)
          ? `no longer armed (${settledCommands.get(i.value)}) — register it again with \`frizzctl watch-command add\` if you still need the wait`
          : finishedItem(i)
          ? "FINISHED — its result is waiting for you"
          : i.kind === "shell" && staleShellHandles.has(i.value)
          ? "GONE WITHOUT A COMPLETION NOTICE — frizz knows this shell, but nothing holds its output file and no process it could be is still running; read its output to see how it ended"
          : i.kind === "pr"
          ? "NOT REGISTERED — register it with `frizzctl watch-pr add` first, then name it here"
          : i.kind === "issue"
          ? "NOT REGISTERED — register it with `frizzctl watch-issue add` first, then name it here"
          : i.kind === "command"
          ? "NOT REGISTERED — register it with `frizzctl watch-command add` first, then name the id it gives you here"
          : "NOT RUNNING (nothing by that name)"
        // The PLURAL key, because that is what the worker has to write. `i.kind` is the internal wire
        // kind and stayed singular through the 2026-08-24 YAML cutover; printing it raw taught a
        // spelling the parser now refuses.
        return `- \`${AWAITING_KEY_OF[i.kind]}: [${i.value}]\` — ${note}`
      })
      // A park on `steps:` that ran out is the only status line here frizz cannot read off a registry:
      // the human may have done the steps without pressing anything, so the line sends the worker to
      // check the world rather than to re-post the same steps blind.
      if (park.steps.length > 0) {
        status.push(`- \`steps:\` (${park.steps.length}) — the human has not replied; check whether they were done anyway before you post them again`)
      }
      if (park.questions.length > 0) {
        status.push(`- \`questions:\` (${park.questions.length}) — not answered yet; a rest that still needs one references it with an \`id:\`-only \`\`\`question fence, and \`frizzctl unask <id>\` withdraws the rest`)
      }
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
          "timers: [tmr_…]               timers from `frizzctl timer set`",
          "prs:    [owner/repo#123]      PRs registered with `frizzctl watch-pr add`",
          "issues: [owner/repo#45]       GitHub issues registered with `frizzctl watch-issue add`",
          "commands: [cmw_…]             command watches from `frizzctl watch-command add`",
          "for:    2h                    REQUIRED — a DURATION, never an instant",
          "---",
          "your handoff prose, as much as you want",
          "```",
          "",
          "Keep the keys you need and drop the rest. There is NO prose above the `---`: a colon or a ` #`",
          "in a sentence breaks the YAML, which is why `reason:` is gone.",
          "",
          "`frizzctl activity` lists everything you have running, and prints it back as a ready-to-paste",
          "fence. If you are not waiting on anything, you are not awaiting — end with ```done, or ask the",
          "human in a ```question fence.",
        ].join("\n")
        : nameless
        ? [
          `${PARK_CORRECTION_NAMES_LEAD}nothing to wait on, so it is not a park — your thread is still`,
          "in the queue, and nothing will wake you.",
          "",
          "A wait has to be something frizz can SEE. Register one, then name it:",
          "",
          "- a pull request → `frizzctl watch-pr add` (it wakes you on CI going green or red, and on every",
          "  later review and comment) → `prs: [owner/repo#123]`",
          "- a GitHub issue → `frizzctl watch-issue add` (every later comment, a label or assignee moving,",
          "  and the close) → `issues: [owner/repo#45]`",
          "- a wall-clock check → `frizzctl timer set` → `timers: [tmr_…]`",
          "- an outside condition a command can check (a package version, a release run, a URL coming up)",
          "  → `frizzctl watch-command add` → `commands: [cmw_…]`",
          "- work you already launched → `shells: [<the id your runtime gave you>]` or `agents: [<id>]`",
          "",
          "The frontmatter is YAML: PLURAL keys, each taking a list, and your prose below the `---`.",
          "Use `frizzctl activity` to read it all back as a ready-to-paste fence.",
          "",
          "AND IF YOU ARE NOT WAITING ON ANYTHING, you are not awaiting — you are done. End with ```done,",
          "or ask the human in a ```question fence if you need them.",
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
          "Use `frizzctl activity` to read back what you actually have out, with the exact id each line",
          "needs, then re-fence naming only those — or end in ```done or a ```question fence if there is",
          "nothing left to wait for.",
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
        prs: deps.storage.listPrWatches(row.slug, { armedOnly: true }).filter((w) => w.kind !== "issue")
          .map((w) => ({ id: `${w.owner}/${w.repo}#${w.number}`, label: `${w.owner}/${w.repo}#${w.number}` })),
        issues: deps.storage.listPrWatches(row.slug, { armedOnly: true }).filter((w) => w.kind === "issue")
          .map((w) => ({ id: `${w.owner}/${w.repo}#${w.number}`, label: `${w.owner}/${w.repo}#${w.number}` })),
        commands: commandWatchOps(deps.storage, row.slug),
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
        : `${head}\n\nYou have NOTHING running right now — no shell, no sub-agent, no timer, no registered\npull request. There is nothing that could wake you, so this thread is not awaiting: finish in\n\`\`\`done, or ask the human in a \`\`\`question fence.`
      // THE CONSECUTIVE CAP, and the reason SOURCE 12 needed one. A correction is only worth sending to a
      // worker that can act on it, and a worker whose contract froze before this grammar existed cannot:
      // no fence it knows how to write will pass the check. Uncapped, that is a closed loop — bump, wake,
      // rest on the same bad fence under a new instant, bump — and it ran on the live board for 4h45m at
      // 617 bumps to a single thread, one every ~28 seconds, before anyone counted them (2026-08-17).
      //
      // `expired` is exempt because it is not a correction: the fence was right, the clock ran out, and
      // re-parking on still-running work is unlimited by explicit decision (maintainer 2026-08-15, "a
      // three-hour build under a one-hour estimate is a bad estimate, not a failure").
      // (`parkCapSpent`: a rest that already took a bump for another correction is not spent for this one.)
      if (cause !== "expired" && parkCapSpent(row, spokeAt)) continue
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
      // ANCHORED ON THE REST, not on this correction: one rest spends one bump however many things are
      // wrong with it (see parkCapSpent).
      if (cause !== "expired") deps.storage.countParkBump(row.slug, spokeAt)
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- SOURCE 11: THE REGISTERED PR WATCHERS ------------------------------------------------------
  // A worker registers a pull request with `frizzctl watch-pr` and frizz brings it back whenever
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
  interface PrWatchHeld { items: GithubWakeItem[]; omitted: number; checks?: PrWatchChecks; changes?: string[]; offMergePath?: OffMergePath }
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
    /** Issue watchers only: who was assigned as of the last poll, the same baseline rule as `labels`. */
    assignees?: string[]
    draft?: boolean
    /** Merge-path exits already reported (`GithubPrMergeExit.id`). Kept apart from `seen`, whose cap
     *  evicts its oldest ids first: the poll re-reads the same last few exits every minute, and an exit
     *  evicted while still in that window would be announced a second time. */
    exits?: string[]
  }
  const prWatchPolledAt = new Map<string, number>() // refKey → last fetch, shared across threads
  /** refKey → the first poll of an unbroken run in which GitHub said the PR or issue does not exist. Any
   *  other outcome breaks the run, a deferred or failed read included: neither is a second NOT_FOUND. */
  const prWatchMissingSince = new Map<string, number>()
  /** The poll's key for a row — the ref, prefixed for an issue (see the refs loop in evalPrWatches). */
  const watchKey = (w: Pick<PrWatchRow, "kind" | "owner" | "repo" | "number">): string =>
    `${w.kind === "issue" ? "issue:" : ""}${w.owner}/${w.repo}#${w.number}`
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
    return {
      items, omitted: Number(h.omitted) || 0, ...(checks ? { checks } : {}), ...(changes?.length ? { changes } : {}),
      ...((OFF_MERGE_PATHS as readonly unknown[]).includes(h.offMergePath) ? { offMergePath: h.offMergePath as OffMergePath } : {}),
    }
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
    draft: boolean | undefined,
  ): string[] {
    const out: string[] = []
    if (merge === "conflicting" && cursor.merge !== undefined && cursor.merge !== "conflicting") {
      out.push("now CONFLICTS with the base branch")
    }
    // Back to a draft is the other way a PR stops being mergeable without any of its checks moving.
    if (draft === true && cursor.draft === false) out.push("converted back to a DRAFT")
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
      const assignees = readCursorList(parsed.assignees)
      const exits = readCursorList(parsed.exits)
      return {
        seen,
        checks: typeof parsed.checks === "string" ? parsed.checks : undefined,
        report: Number(parsed.report) || 0,
        ...(held ? { held } : {}),
        ...(typeof parsed.merge === "string" ? { merge: parsed.merge } : {}),
        ...(labels ? { labels } : {}),
        ...(reviewers ? { reviewers } : {}),
        ...(assignees ? { assignees } : {}),
        ...(typeof parsed.draft === "boolean" ? { draft: parsed.draft } : {}),
        ...(exits ? { exits } : {}),
      }
    } catch {
      return { seen: [] }
    }
  }

  /** The verdict word a checks stamp carries — `<head>:<verdict>:<failing jobs>` — or the bare word a
   *  pre-stamp cursor holds. Only the gated rule in `evalPrWatches` reads it; every other verdict
   *  compares the whole stamp, head and all. */
  function stampVerdict(stamp: string | undefined): string | undefined {
    if (!stamp) return undefined
    const parts = stamp.split(":")
    return parts.length >= 2 ? parts[1] : parts[0]
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
      log(`waker: settled ${w.thread_slug} — ${w.kind === "issue" ? "issue" : "pr"} watcher ${w.id} expired (${ref})`)
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
        message: prWatchExpiredWakeMessage(ref, w.kind === "issue" ? "issue" : "pull"),
        reason: `${w.kind === "issue" ? "issue" : "pr"} watcher ${w.id} expired (${ref})`,
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
    const refs = new Map<string, PrRef & { kind: "pull" | "issue" }>()
    for (const w of armed) {
      if (!isThreadLive(w.thread_slug)) continue
      // An ISSUE's key carries its kind (2026-09-14), so an issue and a PR that happen to share a number
      // in one repo — impossible on GitHub, but a worker can register #7 both ways — are two fetches
      // with two answers, and neither reading is ever filed under the other.
      const key = watchKey(w)
      const last = prWatchPolledAt.get(key) ?? 0
      if (nowMs - last < PR_WATCH_POLL_MS) continue
      refs.set(key, { owner: w.owner, repo: w.repo, number: w.number, kind: w.kind === "issue" ? "issue" : "pull" })
    }
    const status = new Map<string, GithubWatchStatus>()
    const activity = new Map<string, GithubReviewActivity[]>()
    /** The ISSUE's own reading, for the refs that are issues. Nothing else in this poll touches them:
     *  the CI status book, the `gh` fallback and the merge/reviewer baselines are all PR facts. */
    const issues = new Map<string, GithubIssueSnapshot>()
    /** The PR's own state, which `GithubWatchStatus` does not carry — it is a CI projection, and these
     *  are triggers rather than a readout. `undefined` for a ref the `gh` fallback served, which does not
     *  ask for them; that is the "not known" the baseline rule turns on. */
    const meta = new Map<string, Pick<PrStatus, "labels" | "reviewRequests" | "isDraft" | "queued" | "mergeExits">>()
    await Promise.all([...refs].map(async ([key, ref]) => {
      prWatchPolledAt.set(key, nowMs)
      if (ref.kind === "issue") {
        // AN ISSUE RIDES THE SAME BATCHED REQUEST as the PRs beside it and has no `gh` fallback: it was
        // born on the GraphQL path, so a shape surprise is logged through the same failure ledger and
        // the next poll simply asks again.
        try {
          const result = normalizeReviewResult(await fetchGithubReview(ref))
          trackMissing(key, result, nowMs)
          if (result.status === "ok") {
            activity.set(key, result.activity)
            if (result.issue) {
              issues.set(key, result.issue)
              publishGithubIssueStatus(`${ref.owner}/${ref.repo}#${ref.number}`, result.issue, nowMs)
            }
            recordReviewSuccess(key, "issue-watch registry")
          } else if (result.status === "error") recordReviewFailure(key, "issue-watch registry", result, nowMs)
        } catch (err) {
          prWatchMissingSince.delete(key)
          recordReviewFailure(key, "issue-watch registry", {
            status: "error",
            failure: { kind: "network", message: err instanceof Error ? err.message : String(err) },
          }, nowMs)
        }
        return
      }
      // ONE REQUEST FOR BOTH HALVES (2026-09-04). The review fetch and the status fetch used to be two
      // independent trips per PR — a batched GraphQL query, plus `gh pr view` and `gh run list` as
      // subprocesses — which on this machine's 7 armed watchers meant 14 children a minute for facts that
      // hang off the same pull request and price at the same 1 GraphQL point together as apart. The
      // status now rides the query that was already being made, so a poll of 20 PRs is one HTTP request
      // and no children.
      //
      // `fetchPr` REMAINS THE FALLBACK, and it is not vestigial: an injected fetcher (every scheduler
      // test that predates this) returns activity with no `pr`, and so does a response frizz cannot
      // interpret, or a rollup longer than one page that it could not read to the end. Falling back
      // there keeps a watcher polling rather than going quiet on a shape
      // surprise — which is the failure mode this whole source exists to prevent. It runs through
      // `prStatusFallback` because it is the poll's only subprocess and a batch fails all at once; see
      // PR_STATUS_FALLBACK_LIMIT.
      let snapshot: PrStatus | undefined
      let deferred = false
      try {
        const result = normalizeReviewResult(await fetchGithubReview(ref))
        trackMissing(key, result, nowMs)
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
        prWatchMissingSince.delete(key)
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
          // Read, by either transport, so whatever GitHub's GraphQL said about it, it is not gone.
          prWatchMissingSince.delete(key)
          status.set(key, githubWatchStatus(pr, new Date(nowMs).toISOString()))
          meta.set(key, { labels: pr.labels, reviewRequests: pr.reviewRequests, isDraft: pr.isDraft, queued: pr.queued, mergeExits: pr.mergeExits })
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
      const key = watchKey(w)
      // GONE: deleted, transferred, or no longer visible. Settled and said once, like a merge or a close —
      // the one other ending a watcher can reach, and the one it had no way to say.
      const missingSince = prWatchMissingSince.get(key)
      if (missingSince !== undefined && nowMs - missingSince >= PR_WATCH_GONE_MS) {
        deps.storage.settlePrWatch(w.id, nowMs)
        const waiting = undeliveredPrWatchReport(row.slug, w.id)
        if (waiting) outbox.supersede(waiting.id, nowMs, "replaced by the watcher's not-found report")
        const kind = w.kind === "issue" ? "issue" as const : "pull" as const
        enqueuePrWatchWake(row, w.id, nextReport(readPrWatchCursor(w.cursor)), prWatchGoneWakeMessage(
          `${w.owner}/${w.repo}#${w.number}`, kind, Math.round(PR_WATCH_GONE_MS / 60_000),
        ), `${kind === "issue" ? "issue" : "pr"}-watch ${key} not found`, nowMs)
        continue
      }
      if (w.kind === "issue") {
        evalIssueWatch(row, w, issues.get(key), activity.get(key), nowMs)
        continue
      }
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
      // EXCEPT THAT A GATE IS THE SAME GATE ON ANY COMMIT (2026-09-11). `passing` and `failing` are keyed
      // on the head because a verdict is reached per commit, and a new commit's verdict is new news. A
      // gated reading is not a verdict: it says the workflows have not been allowed to start, and the
      // worker's move — ask a maintainer for the approval — is identical whatever the head is. A worker
      // that force-pushes a fork PR moves the head while the gate stays shut, and the watcher said
      // "WAITING FOR APPROVAL" again for the new SHA one poll after saying it for the old one
      // (microsoft/TypeScript#64248: registered 18:21:20Z, reported 18:21:27Z, force-pushed 18:22:47Z,
      // reported again 18:24:30Z; the worker's reply to the second: "same wake as before, nothing
      // changed"). So gated-after-gated is quiet on any commit, while gated after a REAL verdict still
      // speaks — that worker pushed onto a PR whose last run was approved, and is otherwise waiting on
      // CI it believes is running. The stamp keeps its shape and the cursor still advances to the new
      // head; only the comparison relaxes, so a cursor written before this reads exactly the same way.
      const checksChanged = stamp !== undefined && cursor.checks !== stamp
        && !(terminal === "gated" && stampVerdict(cursor.checks) === "gated")
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
      const changes = firstPoll ? [] : prStateChanges(cursor, st?.merge, prMeta?.labels, prMeta?.reviewRequests, prMeta?.isDraft)
      // LEAVING THE MERGE PATH WITHOUT MERGING (2026-10-14). These are timeline EVENTS, not a reading, so
      // they take the review activity's rule rather than the baseline's: news when not yet reported and
      // newer than the registration — on every poll, not only the first, so a watcher armed before this
      // landed still hears about the bounce it slept through.
      const reportedExits = new Set(cursor.exits ?? [])
      const freshExits = (prMeta?.mergeExits ?? []).filter((e) => {
        if (reportedExits.has(e.id)) return false
        const at = Date.parse(e.at ?? "")
        return Number.isFinite(at) && at > w.created_at
      })
      changes.push(...freshExits.map((e) => mergeExitClause(e, prMeta?.queued)))
      // WHICH road it left, because the next step differs: only a queue that FAILED the PR has a merge group
      // whose failed checks the PR head does not show. A conflict, a removal by hand, or auto-merge going
      // off in a repo with no queue has none, and saying "those failures" there points at nothing.
      const offMergePath = prMeta?.queued ? undefined : mostSpecificOffMergePath(freshExits.map(offMergePathOf))

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
        ...(typeof prMeta?.isDraft === "boolean" ? { draft: prMeta.isDraft } : typeof cursor.draft === "boolean" ? { draft: cursor.draft } : {}),
        ...(prMeta?.mergeExits || cursor.exits
          ? { exits: [...new Set([...(prMeta?.mergeExits ?? []).map((e) => e.id), ...(cursor.exits ?? [])])].slice(0, 20) }
          : {}),
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
        // The most specific exit in either report decides the paragraph: each says what the ones below it do.
        ...((() => {
          const off = mostSpecificOffMergePath([offMergePath, held?.offMergePath])
          return off ? { offMergePath: off } : {}
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
        ...(carried.offMergePath ? { offMergePath: carried.offMergePath } : {}),
        ...(review ? { review } : {}),
      }), `pr-watch ${key}${carried.checks ? ` CI ${carried.checks.verdict}` : ""}${carried.offMergePath ? " left merge path" : carried.changes?.length ? " state" : ""}${review ? " review" : ""}`, nowMs)
      deps.storage.setPrWatchCursor(w.id, JSON.stringify({ ...nextCursor, report, held: carried }))
    }
  }

  /** An ISSUE's own state moving — labels either way, for the reason `prStateChanges` gives, and a new
   *  assignee, which on an issue is the "someone picked this up" event a worker waiting on triage wants.
   *  An unassignment is quiet, as a withdrawn review request is. */
  function issueStateChanges(cursor: PrWatchCursor, labels: string[] | undefined, assignees: string[] | undefined): string[] {
    const out: string[] = []
    if (labels && cursor.labels) {
      const added = labels.filter((l) => !cursor.labels!.includes(l))
      const removed = cursor.labels.filter((l) => !labels.includes(l))
      const parts = [...added.map((l) => `+${l}`), ...removed.map((l) => `−${l}`)]
      if (parts.length) out.push(`labels ${parts.join(", ")}`)
    }
    if (assignees && cursor.assignees) {
      const added = assignees.filter((a) => !cursor.assignees!.includes(a))
      if (added.length) out.push(`assigned to ${added.map((a) => `@${a}`).join(", ")}`)
    }
    return out
  }

  /** The issue half of the poll loop above — one registered ISSUE watcher, given what this tick fetched
   *  for it. Same cursor, same report numbering, same one-undelivered-report rule and the same re-mint as
   *  the PR path, because the row IS a `pr_watch` row; what differs is what can move (comments, labels,
   *  assignees, the close) and what is said about it (`issueWatchWakeMessage`). Kept as its own function
   *  rather than folded into the PR loop with `if (issue)` guards, because the PR loop's shape is its CI
   *  verdict and an issue has none. */
  function evalIssueWatch(
    row: SessionRow,
    w: PrWatchRow,
    snap: GithubIssueSnapshot | undefined,
    acts: GithubReviewActivity[] | undefined,
    nowMs: number,
  ): void {
    if (!snap && !acts) return // nothing fetched for this issue this tick
    const target = `${w.owner}/${w.repo}#${w.number}`
    const cursor = readPrWatchCursor(w.cursor)
    const waiting = undeliveredPrWatchReport(row.slug, w.id)
    // A CLOSED ISSUE ends the watch, as a merged or closed PR does. Reported once with GitHub's reason —
    // "not planned" is a different next step from "completed" — then settled.
    if (snap && snap.state.toUpperCase() === "CLOSED") {
      deps.storage.settlePrWatch(w.id, nowMs)
      if (waiting) outbox.supersede(waiting.id, nowMs, "replaced by the watcher's closed report")
      const reason = snap.stateReason ? snap.stateReason.toLowerCase().replace(/_/g, " ") : undefined
      enqueuePrWatchWake(row, w.id, nextReport(cursor), issueWatchWakeMessage({
        target, closed: reason ? { reason } : {},
      }), `issue-watch ${target} closed`, nowMs)
      return
    }
    if (waiting && !cursor.held) return
    const seen = new Set(cursor.seen)
    const firstPoll = w.cursor === null
    const newestFirst = [...(acts ?? [])].sort((a, b) => {
      const at = Date.parse(b.at ?? "") - Date.parse(a.at ?? "")
      return Number.isFinite(at) && at !== 0 ? at : b.id.localeCompare(a.id)
    })
    // The registration-instant baseline and the noise filter, exactly as the PR path reads them: a
    // worker registers an issue it has just read, so what is already there is not news.
    const fresh = newestFirst.filter((a) => {
      if (seen.has(a.id) || isNoisePrActivity(a)) return false
      if (!firstPoll) return true
      const landed = Date.parse(a.at ?? "")
      return Number.isFinite(landed) && landed > w.created_at
    })
    const named = fresh.slice(0, REVIEW_STEER_CAP)
    const freshItems: GithubWakeItem[] = [...named].reverse().map((a) => ({
      label: activityLabel(a),
      actor: a.actor,
      bot: isBotGithubActor(a),
      ...(a.at ? { at: a.at } : {}),
      ...(a.url ? { url: a.url } : {}),
    }))
    const changes = firstPoll ? [] : issueStateChanges(cursor, snap?.labels, snap?.assignees)
    const nextCursor: PrWatchCursor = {
      seen: acts ? [...new Set([...cursor.seen, ...acts.map((a) => a.id)])].slice(-REVIEW_SEEN_CAP) : cursor.seen,
      report: cursor.report ?? 0,
      ...(snap?.labels ? { labels: snap.labels } : cursor.labels ? { labels: cursor.labels } : {}),
      ...(snap?.assignees ? { assignees: snap.assignees } : cursor.assignees ? { assignees: cursor.assignees } : {}),
    }
    if (fresh.length === 0 && changes.length === 0) {
      if (JSON.stringify(nextCursor) !== JSON.stringify(cursor)) {
        deps.storage.setPrWatchCursor(w.id, JSON.stringify(nextCursor))
      }
      return
    }
    deps.storage.setSnoozedUntil(row.slug, null)
    const held = waiting ? cursor.held : undefined
    const items = [...(held?.items ?? []), ...freshItems]
    const mergedChanges = [...new Set([...(held?.changes ?? []), ...changes])]
    const carried: PrWatchHeld = {
      items: items.slice(-REVIEW_STEER_CAP),
      omitted: (held?.omitted ?? 0) + (fresh.length - named.length) + Math.max(0, items.length - REVIEW_STEER_CAP),
      ...(mergedChanges.length ? { changes: mergedChanges } : {}),
    }
    const review = carried.items.length > 0
      ? formatGithubWakeSteer({ ref: target, items: carried.items, omitted: carried.omitted })
      : undefined
    const report = nextReport(cursor)
    if (waiting) outbox.supersede(waiting.id, nowMs, `folded into report ${report}, which says this and everything since`)
    enqueuePrWatchWake(row, w.id, report, issueWatchWakeMessage({
      target,
      ...(carried.changes?.length ? { changes: carried.changes } : {}),
      ...(review ? { review } : {}),
    }), `issue-watch ${target}${carried.changes?.length ? " state" : ""}${review ? " comment" : ""}`, nowMs)
    deps.storage.setPrWatchCursor(w.id, JSON.stringify({ ...nextCursor, report, held: carried }))
  }

  function trackMissing(key: string, result: GithubReviewFetchResult, nowMs: number): void {
    if (result.status === "error" && result.failure.kind === "not-found") {
      if (!prWatchMissingSince.has(key)) prWatchMissingSince.set(key, nowMs)
    } else prWatchMissingSince.delete(key)
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
      // on (`frizzctl watch`): a registration trumps a done on the board, so it trumps it here too —
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

  // ---- SOURCE 13: THE WORKER'S COMMAND WATCHES ------------------------------------------------------
  // `frizzctl watch-command add` (2026-10-11): a shell command the server re-runs every `every` until it
  // exits 0, so a wait on an outside condition holds nothing in the thread's own process tree and the
  // thread can hibernate under it. See command-watch.ts for the process and the gate.
  //
  // ONE-SHOT, like a timer and unlike a PR watcher: the first passing check settles the row and wakes the
  // thread once. Expiry settles it and wakes the thread to re-decide. A gate that closes (the thread left
  // `bypassPermissions`, the sandbox came on) cancels it and wakes the thread to use a background shell.
  //
  // RUNS ARE STARTED, NOT AWAITED. A check may take two minutes and the tick is serialized: awaiting it
  // would hold every other source behind somebody's `curl`. So the pass starts what is due and returns;
  // each check records itself when it finishes and kicks the next tick, which delivers the wake.
  //
  // NEVER TWO CHECKS OF ONE WATCH AT ONCE: `commandRuns` holds the one in flight, and a watch with a
  // check in flight is not due. The SERVER-WIDE bound on checks at once lives in the service
  // (command-watch.ts), shared by every project's scheduler.
  //
  // CADENCE FROM THE FINISH: the next check is due `every` after the last one ENDED, so a check slower
  // than its cadence cannot stack up behind itself.
  //
  // THE FENCE IS NOT CONSULTED, as with a PR watcher: registration is the fact, and a thread that is not
  // resting on the watch is woken exactly the same way (held until it rests, like every non-clock wake).
  const commandRuns = new Map<string, { abort: AbortController; done: Promise<void> }>()

  function kick(): void {
    if (stopped || !timer) return
    void tick().catch((error) => log(`waker: kick failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  async function commandRunsIdle(): Promise<void> {
    while (commandRuns.size > 0) await Promise.all([...commandRuns.values()].map((r) => r.done))
  }

  function threadIsLive(row: SessionRow | undefined): row is SessionRow {
    return !!row && row.state !== "archived" && row.archived !== 1
  }

  function enqueueCommandWatchWake(row: SessionRow, fenceId: string, message: string, reason: string, nowMs: number): void {
    const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
    if (outbox.get(deliveryId)) return
    const item = outbox.enqueue({
      id: deliveryId,
      slug: row.slug,
      sessionId: row.session_id,
      fenceId,
      hintKey: fenceId,
      message: withClock(message, deps.tailer.get(row.slug)?.lastAssistantAt),
      reason,
    }, nowMs).delivery
    log(`waker: queued ${row.slug} — ${item.reason}`)
    checkpoint("after-enqueue", item)
  }

  function lastRunOf(w: CommandWatchRow): { outcome: "exit" | "timeout" | "signal" | "error"; exitCode: number | null; output: string } | undefined {
    if (w.last_run_at === null || !w.last_outcome) return undefined
    return { outcome: w.last_outcome, exitCode: w.last_exit, output: w.last_output ?? "" }
  }

  function evalCommandWatches(nowMs: number): void {
    // EXPIRY FIRST, so an expired watch never runs once more on its way out. Wake THEN settle: a crash
    // between the two leaves the row armed and expired, and the next pass re-enqueues under the same
    // delivery id, which the outbox dedupes — so the wake goes out exactly once either way.
    for (const w of deps.storage.expiredCommandWatches(nowMs)) {
      commandRuns.get(w.id)?.abort.abort()
      const row = deps.storage.getSession(w.thread_slug)
      if (threadIsLive(row)) {
        enqueueCommandWatchWake(
          row,
          `${COMMAND_WATCH_EXPIRED_FENCE_PREFIX}:${w.id}`,
          commandWatchExpiredWakeMessage({ id: w.id, command: w.command, lastRun: lastRunOf(w) }),
          `command watch ${w.id} expired after ${w.runs} check(s)`,
          nowMs,
        )
      }
      deps.storage.settleCommandWatch(w.id, "expired", nowMs)
      log(`waker: settled ${w.thread_slug} — command watch ${w.id} expired`)
    }
    const armed = deps.storage.armedCommandWatches()
    // A check whose row left `armed` under it — dropped by the worker, or the thread forgotten — is
    // killed now rather than left to finish a question nobody is asking.
    const armedIds = new Set(armed.map((w) => w.id))
    for (const [id, run] of commandRuns) if (!armedIds.has(id)) run.abort.abort()
    const service = deps.commandWatches
    if (!service) return
    for (const w of armed) {
      if (commandRuns.has(w.id)) continue
      const dueAt = w.last_run_at !== null ? w.last_run_at + w.every_ms : w.created_at
      if (nowMs < dueAt) continue
      const row = deps.storage.getSession(w.thread_slug)
      // AN ARCHIVED THREAD's watch stays ARMED and is not run, the PR watcher's rule: it can be reopened,
      // and the watch is still its worker's outstanding intent — but no check runs for a thread nothing
      // can wake. Its `for` still runs out above.
      if (!threadIsLive(row)) continue
      // THE GATE, AGAIN, AT EVERY CHECK. Registration asked it once; a thread whose permission mode or
      // sandbox changed since must stop getting commands run for it, and must be told — a watch that
      // silently stops is a worker resting on coverage it does not have.
      const refusal = service.refusal(row)
      if (refusal) {
        enqueueCommandWatchWake(
          row,
          `${COMMAND_WATCH_CANCELLED_FENCE_PREFIX}:${w.id}`,
          commandWatchCancelledWakeMessage({ id: w.id, command: w.command, reason: refusal }),
          `command watch ${w.id} cancelled: ${refusal}`,
          nowMs,
        )
        deps.storage.settleCommandWatch(w.id, "cancelled", nowMs)
        log(`waker: settled ${w.thread_slug} — command watch ${w.id} cancelled: ${refusal}`)
        continue
      }
      startCommandRun(service, w)
    }
  }

  function startCommandRun(service: CommandWatchService, w: CommandWatchRow): void {
    const abort = new AbortController()
    const done = (async () => {
      let result: Pick<CommandRunResult, "outcome" | "exitCode" | "output">
      try {
        result = await service.run(w.thread_slug, w.command, { signal: abort.signal })
      } catch (err) {
        result = { outcome: "error", exitCode: null, output: err instanceof Error ? err.message : String(err) }
      }
      // Aborted ⇒ the row left `armed`, ran out, or the server is stopping. Nothing is recorded: the
      // first two have nothing to record onto, and the third leaves the row for the next server to run.
      if (abort.signal.aborted || stopped) return
      finishCommandRun(w, result)
    })()
      .catch((err) => log(`waker: command watch ${w.id} check failed to record: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { if (commandRuns.get(w.id)?.done === done) commandRuns.delete(w.id) })
    commandRuns.set(w.id, { abort, done })
  }

  function finishCommandRun(w: CommandWatchRow, result: Pick<CommandRunResult, "outcome" | "exitCode" | "output">): void {
    const atMs = now()
    // Recorded only onto a row still ARMED (the statement's own guard): a drop that landed while this
    // check ran wins, and nothing it found is reported.
    if (!deps.storage.recordCommandWatchRun(w.id, { atMs, outcome: result.outcome, exitCode: result.exitCode, output: result.output })) return
    if (result.outcome !== "exit" || result.exitCode !== 0) return
    const current = deps.storage.getCommandWatch(w.id)
    const row = deps.storage.getSession(w.thread_slug)
    // PASSED. Wake THEN settle, for the expiry's reason: a crash between leaves the row armed, the next
    // server runs the check again, and the second pass's wake dedupes against the first by its id.
    if (threadIsLive(row)) {
      enqueueCommandWatchWake(
        row,
        `${COMMAND_WATCH_FENCE_PREFIX}:${w.id}`,
        commandWatchPassedWakeMessage({
          id: w.id,
          command: w.command,
          output: result.output,
          runs: current?.runs ?? w.runs + 1,
          armedMs: Math.max(0, atMs - w.created_at),
        }),
        `command watch ${w.id} passed`,
        atMs,
      )
    }
    deps.storage.settleCommandWatch(w.id, "passed", atMs)
    log(`waker: settled ${w.thread_slug} — command watch ${w.id} passed`)
    kick()
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
   *  MARKED DELIVERED WHEN THE WORKER HAS IT, not when the outbox does (2026-10-01). This used to flip
   *  `delivered` at ENQUEUE, on the reasoning that the outbox is durable and owns retry from there — but
   *  the outbox's retry is capped, and a wake that exhausts its attempts is filed and forgotten. On
   *  2026-09-30 four answers on one thread were flagged delivered and never reached its worker (a broker
   *  resume race, fixed in 0dc073b7); had every attempt failed, nothing anywhere would ever have offered
   *  them again. Now each settlement records the wake carrying it (`delivery_id`), `delivered` flips only
   *  when that wake reaches the outbox's `delivered` state (settleQuestionAnswers), and a settlement whose
   *  wake ended any other way is offered again:
   *    - IN FLIGHT (its wake pending or leased): skipped, so a second answer on the same thread is its
   *      own wake and never re-carries the first — the double-send the enqueue-time flag used to prevent.
   *    - LANDED but not yet marked (a process that died between the outbox's confirm and the mark): marked
   *      here.
   *    - FAILED (exhausted, abandoned, or superseded): offered again under a NEW fence id (the old one
   *      is spent — the outbox dedupes on it), when there is a reason to think it can land now. A wake
   *      superseded before it crossed the transport (the session moved; the thread was archived and is
   *      back) goes at once; a wake the runtime refused waits for this process to be newer than the
   *      failure, for the worker to have run a turn since, or for ANSWER_REOFFER_BACKOFF_MS. A brand-new
   *      settlement on the thread is a delivery opportunity too: the failed ones ride it.
   */
  function evalQuestionAnswers(nowMs: number): void {
    const bySlug = new Map<string, ThreadQuestionRow[]>()
    for (const q of deps.storage.undeliveredSettlements()) {
      const list = bySlug.get(q.thread_slug) ?? []
      list.push(q)
      bySlug.set(q.thread_slug, list)
    }
    for (const [slug, settled] of bySlug) {
      const row = deps.storage.getSession(slug)
      // An archived thread is told nothing, and its rows stay undelivered: reopening it should still
      // hand the worker what the human said, rather than having spent it on a thread nobody was reading.
      if (!row || row.state === "archived" || row.archived === 1) continue
      // Sort each settlement by what its last offer came to. `rows` is what this pass may offer.
      const rows: ThreadQuestionRow[] = []
      const failed: WakeDelivery[] = []
      let fresh = false
      let reofferDue = false
      for (const q of settled) {
        if (!q.delivery_id) {
          rows.push(q)
          fresh = true
          continue
        }
        const carrier = outbox.get(q.delivery_id)
        if (carrier?.state === "pending" || carrier?.state === "leased") continue
        if (carrier?.state === "delivered") {
          deps.storage.markSettlementDelivered(q.id)
          continue
        }
        rows.push(q)
        if (carrier && !failed.some((d) => d.id === carrier.id)) failed.push(carrier)
        if (!carrier || answerReofferDue(carrier, row, nowMs)) reofferDue = true
      }
      if (rows.length === 0 || (!fresh && !reofferDue)) continue
      const answers: QuestionAnswer[] = []
      const dismissed: QuestionDismissal[] = []
      // The MINTED ids are kept alongside for the delivery key ONLY. The MESSAGE names each dismissed
      // question by its text, and by the worker's own id when a fence asked it: the worker never saw a
      // minted id, so a list of those names nothing it can act on. (The human's Answers card leaves these rows out — see answersForDisplay.)
      const dismissedIds: string[] = []
      for (const q of rows) {
        if (q.state === "dismissed") {
          dismissedIds.push(q.id)
          const spec = safeQuestionSpec(q.spec)
          if (spec) dismissed.push({ question: spec.question, ...(q.handle ? { handle: q.handle } : {}) })
          continue
        }
        // Named by the worker's own id where it has one — the same stamp the board's in-flight card
        // composes from (board wakeQuestionAnswer), so the card and this delivery are one message.
        const parsed = wakeQuestionAnswer(q)
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
      // piece of news rather than a duplicate deduped away. A RE-OFFER keys on the failed deliveries too:
      // the outbox dedupes on the fence id, and the failed row still holds the plain one.
      const fenceId = questionAnswerFenceId([
        ...answers.map((a) => a.questionId), ...dismissedIds,
        ...rows.flatMap((q) => (q.delivery_id ? [`after:${q.delivery_id}`] : [])),
      ])
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      // CLAIM THE ROWS BEFORE THE WAKE EXISTS. A process that dies between the two leaves rows naming a
      // delivery the outbox never had — read above as a failed one that never crossed the transport,
      // and re-offered at once. The other order would leave a wake whose landing marks nothing.
      for (const q of rows) deps.storage.assignSettlementDelivery(q.id, deliveryId)
      const reoffer = failed.length > 0 || rows.some((q) => q.delivery_id)
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: fenceId,
        message: withClock(
          answers.length === 0 ? questionsCancelledWakeMessage(cancelledCount, dismissed) : questionAnswerMessage(answers, dismissed),
          deps.tailer.get(row.slug)?.lastAssistantAt,
        ),
        reason: (answers.length === 0
          ? `${cancelledCount} question(s) cancelled — autonomous`
          : `${answers.length} question answer(s)${cancelledCount ? ` + ${cancelledCount} dismissed` : ""}`)
          + (reoffer ? " — offered again: the last wake carrying them did not land" : ""),
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  /** May a batch of answers whose last wake FAILED be offered again now? See evalQuestionAnswers. */
  function answerReofferDue(carrier: WakeDelivery, row: SessionRow, nowMs: number): boolean {
    // Nothing crossed the transport and nothing about the runtime refused it: the session moved under
    // the queued wake, or the thread was archived and is back (the caller already skips archived rows).
    if (carrier.state === "superseded" && carrier.sentAt === null && carrier.lastError?.startsWith(CONTEXT_SUPERSEDED)) return true
    const failedAt = carrier.terminalAt ?? carrier.updatedAt
    // This process never tried it. A restart is where a broken binary, credential or config gets fixed.
    if (failedAt < startedAtMs) return true
    // The worker ran a turn after the failure — a human steer reached it, say — so the runtime that
    // refused the wake takes input again.
    const tele = deps.tailer.get(row.slug)
    const ranAt = Math.max(Date.parse(tele?.lastAssistantAt ?? "") || 0, Date.parse(tele?.lastUserAt ?? "") || 0)
    if (ranAt > failedAt) return true
    return nowMs - failedAt >= ANSWER_REOFFER_BACKOFF_MS
  }

  // Mark the settlements an answers wake carried as RECEIVED — the one place `thread_question.delivered`
  // flips (evalQuestionAnswers). Called from every path that files a wake as delivered.
  function settleQuestionAnswers(item: WakeDelivery): void {
    if (!isQuestionAnswerFenceId(item.fenceId)) return
    deps.storage.markSettlementsDeliveredBy(item.id)
  }

  // Said, because nothing else says it: the outbox files a failed wake and moves on, and the answers it
  // carried now wait for evalQuestionAnswers to offer them again.
  function noteAnswersUndelivered(item: WakeDelivery): void {
    if (!isQuestionAnswerFenceId(item.fenceId)) return
    log(`waker: answers for ${item.slug} stay UNDELIVERED — offered again once this server restarts, the worker runs a turn, or ${Math.round(ANSWER_REOFFER_BACKOFF_MS / 60_000)}m pass`)
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
      // closes the rest above. A wake the worker took MID-TURN leaves no user record, so the hold reads
      // answersReceivedAt: on `lastUserAt` alone it never spent, and the Goal never fired again.
      if (answersInFlight(deps.storage.listThreadQuestions(row.slug), answersReceivedAt(tele), true) !== undefined) continue
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
      // …AND SO DID A ```question FENCE'S CORRECTION (SOURCE 14, 2026-10-13), for the same reason. On a
      // Goal thread every non-secret question is refused with "decide it yourself and proceed", so a rest
      // that asked one drew that correction AND this prompt, handed over together as "Frizz held 2 wakes"
      // — two voices for one rest, the shape the reminder hold above exists to prevent and the one an
      // ```awaiting fence's correction already holds the Goal for (restMessageIsSignedOff). The correction
      // is the voice that says what went wrong; the Goal speaks at the worker's next rest.
      const questionCorrection = outbox.get(wakeDeliveryId(row.slug, row.session_id, parkFenceId(QUESTION_FENCE_CAUSE, restedAt)))
      if (questionCorrection && questionCorrection.state !== "superseded" && questionCorrection.state !== "exhausted") continue
      // …AND A ```done FENCE'S (SOURCE 15), which reaches this line only on a Goal re-armed after the done
      // it corrects (a done that still stands has already ended the Goal's business with the rest, above).
      // The question open there is a secret, and the correction is about exactly that.
      const doneCorrection = outbox.get(wakeDeliveryId(row.slug, row.session_id, parkFenceId(DONE_OVER_QUESTION_CAUSE, restedAt)))
      if (doneCorrection && doneCorrection.state !== "superseded" && doneCorrection.state !== "exhausted") continue
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
  // it in the Goal panel.
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
        outbox.supersede(item.id, nowMs, CONTEXT_SUPERSEDED)
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
            settleQuestionAnswers(item)
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
          noteAnswersUndelivered(item)
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
        noteAnswersUndelivered(item)
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
    settleQuestionAnswers(item)
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
      // Codex limit wakes must pass their asynchronous live-capacity check as a carrier, never slip
      // into a timer/report frame on an earlier quota reading.
      if (isLimitFenceId(sibling.fenceId) && deps.storage.getSession(sibling.slug)?.backend === "codex") continue
      const context = deliveryContext(sibling)
      if (context === "confirmed") {
        outbox.confirm(sibling.id, now())
        settleDelivered(sibling)
        continue
      }
      if (context === "superseded") {
        outbox.supersede(sibling.id, now(), `${CONTEXT_SUPERSEDED} before delivery`)
        settleSnooze(sibling)
        continue
      }
      if (!isDeliverableNow(sibling, context, claimedAt)) continue
      const leased = outbox.adopt(sibling.id, deliveryOwner, claimedAt, claimedAt + deliveryLeaseMs, maxDeliveryAttempts)
      if (leased) adopted.push(leased)
    }
    return adopted
  }

  // The merged body is composed by `mergedWakeMessage` in @frizz/shared, beside the splitter the chat
  // reads it back with. Same rule as `limitResumeSteer` and the park wakes: a formatter the chat cannot
  // parse falls through FrizzWake's fallback and prints its agent-facing body verbatim as a bordered
  // card, and this one did for five weeks.

  // A LONE wake's clock is re-read at SEND, for the same reason the merged one is: the stamp was taken at
  // enqueue, and the quiet window can hold a row for five minutes, across a turn the worker finished in
  // the meantime. Observed 2026-09-25: a PR-merged wake queued at 14:55 went out at 14:59 still saying
  // "you last spoke 14m ago" to a worker that had spoken 39 seconds earlier. Only a message that ends in
  // a clock gets a new one; the token is appended downstream, so this cannot disturb confirmation.
  function restampedWakeMessage(message: string, spokeAt: string | null | undefined): string {
    const bare = stripWakeTimeHeader(message)
    return bare === message ? message : `${bare}\n\n${wakeTimeHeader(now(), spokeAt)}`
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
        outbox.supersede(item.id, now(), `${CONTEXT_SUPERSEDED} before delivery`)
        settleSnooze(item)
        continue
      }
      let codexCapacity = true
      const row = deps.storage.getSession(item.slug)
      if (isLimitFenceId(item.fenceId) && row?.backend === "codex") {
        const fault = limitTelemetry(row)?.limitFault
        try {
          const recovery = fault && codexLimitRecovery(fault, (await deps.readQuota?.())?.codex, now())
          codexCapacity = !!recovery && recovery !== "blocked"
        } catch {
          codexCapacity = false
        }
      }
      // The live read awaited above can race a manual follow-up, archival, or a new turn. Re-read
      // supersession/busy state at the actual delivery boundary, not from before that await.
      if (!codexCapacity || !isDeliverableNow(item, deliveryContext(item), claimedAt)) {
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
        ? restampedWakeMessage(item.message, deps.tailer.get(item.slug)?.lastAssistantAt)
        : mergedWakeMessage(frame, now(), deps.tailer.get(item.slug)?.lastAssistantAt)
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
          for (const d of frame) noteAnswersUndelivered(d)
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
      // Before any pass that reads the corrective cap: a message the human typed since the last counted
      // correction hands the allowance back.
      evalParkBumpRelease()
      // SOURCE 14 first: a rest whose question fence failed is answered by that correction, and the
      // sign-off nudge reads the outbox to stand down for it.
      evalQuestionFences(now())
      // SOURCE 15 after it, for the same reason: a rest that has both wrong gets SOURCE 14's message with
      // this one's paragraph in it, and this pass reads the outbox to stand down.
      evalDoneOverQuestions(now())
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
      evalCommandWatches(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: command-watch pass failed: ${err instanceof Error ? err.message : String(err)}`)
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
      // A check in flight is killed, group and all, and its result discarded: the row stays armed with
      // its last recorded check, so the next server runs it again on the same cadence.
      for (const run of commandRuns.values()) run.abort.abort()
      await commandRunsIdle()
    },
    tick,
    kick,
    commandRunsIdle,
  }
}
