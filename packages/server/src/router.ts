import { readFileSync, statSync, type Stats } from "node:fs"

import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { query, mutation } from "@frizz/rpc/server"
import {
  BoardSnapshot,
  BoardState,
  BoardDeltasInput,
  BoardDeltasResult,
  AdoptThreadInput,
  AdoptThreadResult,
  DispatchInput,
  FollowUpInput,
  questionAnswerMessage,
  nameQuestionAnswer,
  type NamedQuestionAnswer,
  withAnswersNote,
  type QuestionAnswer,
  SteerThreadInput,
  SteerThreadResult,
  SpawnThreadInput,
  SpawnThreadResult,
  type ThreadMessageSender,
  formatThreadMessage,
  spawnedThreadFooter,
  parseThreadMessage,
  UnqueueFollowUpInput,
  DismissFailedFollowUpInput,
  DismissFailedFollowUpResult,
  UnqueueFollowUpResult,
  DeliverQueuedNowInput,
  CompactThreadInput,
  DeliverQueuedNowResult,
  SetThreadRecurringPromptInput,
  SetOwnThreadRecurringPromptInput,
  SetOwnThreadRecurringPromptResult,
  GetOwnThreadRecurringPromptInput,
  OwnThreadRecurringPromptResult,
  SetOwnThreadStopHookInput,
  SetOwnThreadHeartbeatInput,
  SetOwnThreadTimerInput,
  SetOwnThreadTimerResult,
  CancelOwnThreadTimerInput,
  CancelOwnThreadTimerResult,
  ListOwnThreadTimersInput,
  ListOwnThreadActivityInput,
  OwnThreadActivityResult,
  UpsertOwnLinkInput,
  UpsertOwnLinkResult,
  DropOwnLinkInput,
  DropOwnLinkResult,
  OwnThreadTimersResult,
  TIMER_MAX_ARMED,
  type ThreadTimerView,
  SetThreadPinnedInput,
  ReorderPinnedThreadsInput,
  SetThreadConsolePinnedInput,
  ReorderConsolePinnedThreadsInput,
  SetThreadSnoozeInput,
  GithubStatus,
  GithubListInput,
  GithubRefPreviewInput,
  GithubRefPreviewResult,
  GithubListResult,
  GithubBatchInput,
  GithubBatchResult,
  Settings,
  TranscriptMessage,
  TranscriptPage,
  TranscriptEarlierInput,
  ClaudeModel,
  CodexModel,
  QuotaSnapshot,
  AuthSnapshot,
  AccountLogoutInput,
  AccountLogoutResult,
  RenameThreadInput,
  AiRenameThreadInput,
  AiRenameThreadResult,
  SetThreadPermissionInput,
  SetThreadPermissionResult,
  ThreadProfileOptionsInput,
  ThreadProfileOptionsResult,
  ThreadSkillsInput,
  ThreadSkillsResult,
  McpStatusInput,
  McpStatusResult,
  McpSignInInput,
  McpSignInResult,
  McpSignInAttemptInput,
  McpSignInPollResult,
  McpSignInFinishInput,
  type ThreadSkill,
  SetThreadProfileInput,
  SetThreadProfileResult,
  UpgradeThreadModelInput,
  UpgradeThreadModelResult,
  DispatchPreferences,
  SetDispatchPreferenceInput,
  ListInteractionsInput,
  ListInteractionsResult,
  GetInteractionInput,
  GetInteractionResult,
  ResolveInteractionInput,
  ResolveInteractionResult,
  CancelInteractionInput,
  CancelInteractionResult,
  CompletionHold,
  type InteractionRecord,
  type ThreadView,
  ThreadSlug,
  isDirectSubAgent,
  DirectoryPickResult,
  ThreadLocation,
  parseAwaitingDurationRaw,
  AWAITING_FOR_MAX_MS,
  AddOwnPrWatchInput,
  AddOwnCommandWatchInput,
  AddOwnCommandWatchResult,
  DropOwnCommandWatchInput,
  DropOwnCommandWatchResult,
  ListOwnCommandWatchesInput,
  OwnCommandWatchesResult,
  type CommandWatchView,
  type CommandWatchRun,
  COMMAND_WATCH_EVERY_MIN_MS,
  COMMAND_WATCH_EVERY_MAX_MS,
  COMMAND_WATCH_FOR_MAX_MS,
  COMMAND_WATCH_MAX_ARMED,
  formatElapsed as formatCommandWatchDuration,
  AddOwnPrWatchResult,
  DropOwnPrWatchInput,
  DropOwnPrWatchResult,
  ListOwnPrWatchesInput,
  MarkOwnDoneInput,
  MarkOwnDoneResult,
  OwnPrWatchesResult,
  PR_WATCH_MAX_ARMED,
  PR_WATCH_DEFAULT_FOR_MS,
  PR_WATCH_FOR_MAX_MS,
  type PrWatchView,
  AddOwnWatchInput,
  AddOwnWatchResult,
  AskInput,
  AskResult,
  UnaskInput,
  UnaskResult,
  AnswerQuestionsInput,
  AnswerQuestionsResult,
  DismissQuestionsInput,
  DismissQuestionsResult,
  ThreadSettledQuestionsResult,
  QuestionAnswerSchema,
  type SettledQuestionView,
  AskedQuestionSchema,
  askedQuestionFaults,
  secretAnswerText,
  type AskedQuestion,
  questionHandles,
  type RegisteredQuestionView,
  DropOwnWatchInput,
  DropOwnWatchResult,
  OWN_WATCH_MAX_ARMED,
  type OwnWatchView,
  humanGapNote,
  SetOwnThreadTitleInput,
  SetOwnThreadTitleResult,
  AcpAgent,
  acpAgentIdFromModel,
  acpModelIdFromModel,
  AcpAgentModels,
  AcpAgentModelsInput,
} from "@frizz/shared"
import { type AppContext, type ThreadInbox, type ThreadSpawner } from "./context.ts"
import { secretFilePath, serveSecret } from "./secret-files.ts"
import { listAcpAgents } from "./backend/acp-agents.ts"
import { sessionTitleLocked } from "./storage.ts"
import { mayHaveLiveBackgroundWork, needsFreshProcessForLimit } from "./backend/usage-limit.ts"
import { appServerTurnStalled, resolveLiveWatchTarget, resolveRecurringPrompt, resolveSessionTitle } from "./board.ts"
import { runThreadUpdate } from "./frizz.ts"
import { repairThreadFile } from "./repair.ts"
import { reopenArchivedThreadForFollowUp, resumeThread, wakeParkedThreadForFollowUp } from "./resume.ts"
import { appendDelivery, beginDelivery, cancelDelivery, deliverOutstandingDeliveries, deliveryItem, dismissFailedDelivery, dropHeldDelivery, forgetDelivery, heldDeliveries, heldSendMustWait, holdDelivery, nextHeldRelease, parseDeliveryLedger, recordDeliveryFailure, retireOutstandingDeliveries } from "./delivery-ledger.ts"
import { noteSubAgentsEndedByInterrupt, runningSubAgentsOf } from "./interrupt-ended.ts"
import {
  readEarlierThreadTranscriptPage,
  readLatestThreadTranscriptPage,
  readTranscript,
  readTranscriptFile,
  readCodexTranscriptFile,
  projectTranscriptPageAgentLifecycles,
} from "./transcript.ts"
import { readSubAgentContextUsage, readSubAgentLastActivityAt } from "./subagent-facts.ts"
import { openExternalUrl } from "./open-external.ts"
import { openLocalFile, readLocalMarkdown, resolveOpenableFile, readLocalTextFile } from "./local-file.ts"
import { openableFileRoots } from "./project.ts"
import { resolveThreadLink, threadLinkView } from "./thread-links.ts"
import { ghInstalled, ghAuthed, ghRepo, gitGithubRemote, listItems, hydrateIssue, hydratePr, renderGithubPrompt, effectiveTemplate, DEFAULT_GITHUB_PROMPT } from "./github.ts"
import { createGithubHovercardService } from "./github-hovercard.ts"
import { slugify, resolveSlug, resolveLegacyThreadFile, claudeWorkerSystemPrompt, coldResumePermission } from "./dispatch.ts"
import { readCodexModels } from "./backend/codex-models.ts"
import { peekClaudeModels, readClaudeModels } from "./backend/claude-models.ts"
import { deliverableInputText } from "./backend/claude-agent-sdk-protocol.ts"
import { claudeModelStanding, claudeModelUpgradeBlock, claudeModelUpgradeDue, claudeModelUpgradeRefusal, claudeUpgradeCandidate, SERVER_STARTED_AT_MS } from "./backend/claude-model-upgrade.ts"
import { log as frizzLog } from "./logging.ts"
import { audited, textDigest, type AuditAction, type AuditFields } from "./audit.ts"
import { codexSandbox } from "./backend/codex.ts"
import type { CodexSandboxMode } from "./backend/codex-app-server.ts"
import { readQuota } from "./quota.ts"
import { readAuthSnapshot } from "./backend/auth-status.ts"
import { liveThreadsForBackend, runProviderLogout } from "./backend/account-actions.ts"
import { threadProfileOptions, validateThreadProfile } from "./backend/thread-profiles.ts"
import { adoptionRuntimeBinding, type AdoptionPaneLookup, type ExpectedAdoptionPane } from "./adoption-recovery.ts"
import { parseIssueRef, parsePrRef, readGithubIssueStatusBook, readGithubStatusBook, GITHUB_ISSUE_STATUS_SETTING, GITHUB_STATUS_SETTING } from "./awaiting.ts"
import { isBrokerClaudeRow, type CommandWatchRow, type SessionRow, type Storage, type SubAgentSteerRow, type ThreadQuestionRow } from "./storage.ts"
import { syncQuestionFences } from "./question-fences.ts"
import type { SessionTelemetry } from "./tailer.ts"
import { backgroundShellLineCount, readBackgroundShellOutput } from "./background-shell-output.ts"
import { projectRetiredBackgroundOps, retiredOpsFor } from "./transcript.ts"
import { clearProjectIcon, customIconPath, findById, findProjectBySegment, forgetProject, listProjects, moveProjectDirectory, projectIconStatus, renameProject, reorderProjects, resolveProjectIcon, setProjectIcon, type RegistryEntry } from "./project-registry.ts"
import { basename, dirname } from "node:path"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { activeBandThread, boardAskThread, COMMAND_WATCH_FALLBACK, ProjectCard, ProjectRailCounts, PROJECT_ICON_EXTENSIONS, PROJECT_ICON_MAX_BASE64_CHARS, queuedThread } from "@frizz/shared"
import { imageDimensions } from "./image-header.ts"
import { homedir } from "node:os"
import { chosenProjectRoot, ensureProjectIdFile, existingProjectId, isHomeDirectory, writeProjectIdFile } from "./project-root.ts"
import { resolveProjectLabel } from "./project-identity.ts"
import { registerProject } from "./project-registry.ts"
import { detectProjectIcon } from "./project-icon.ts"
import { pickDirectory, pickImageFile, warmDirectoryPicker, warmImagePicker } from "./directory-picker.ts"
import Database from "./sqlite.ts"
import { projectStateDir } from "./frizz-paths.ts"

const SlugInput = z.object({ slug: ThreadSlug }).strict()

// GitHub is a delayed confirmation flow, so validate its captured tuple again at the final server
// boundary. This intentionally rejects stale model/effort pairs; neither is normalized, clamped, or
// replaced with Settings defaults. Permission is NOT part of the tuple: dispatch stamps it server-side
// (workerDispatchPermission — the non-interactive floor, raised to bypass only when Settings asks).
export function validateGithubDispatchProfile(
  input: z.infer<typeof GithubBatchInput>,
  codexModels?: readonly z.infer<typeof CodexModel>[],
): void {
  // An ACP profile carries no effort, and its "model" is an `acp:<agent>` slug the dispatcher resolves
  // itself (refusing an agent that is not on PATH) — there is no model/effort catalogue to check.
  if (input.backend === "acp") return
  if (input.effort === undefined) throw new Error(`Unsupported ${input.backend} model/effort pair: ${input.model} / (no effort)`)
  validateThreadProfile(input.backend, input.model, input.effort, codexModels)
}

export function githubDispatcherRequest(
  input: z.infer<typeof GithubBatchInput>,
  item: { prompt: string; title: string; slug: string },
): {
  payload: z.infer<typeof DispatchInput>
  options: { backend: z.infer<typeof GithubBatchInput>["backend"] }
} {
  return {
    payload: {
      ...item,
      backend: input.backend,
      model: input.model,
      effort: input.effort,
    },
    options: { backend: input.backend },
  }
}

export function hasUnresolvedBackgroundOps(thread: {
  subAgents: readonly { state: string; depth?: number }[]
  bgShells: readonly { state: string }[]
}): boolean {
  // Direct children only — a descendant row is surfaced for rendering and never moves thread state
  // (see isDirectSubAgent). Its ancestor's row already represents the same unresolved work.
  return thread.subAgents.some((op) => isDirectSubAgent(op) && (op.state === "running" || op.state === "stale")) ||
    thread.bgShells.some((op) => op.state === "running" || op.state === "stale")
}

export function hasPendingPermissionChange(row: { permission_pending?: unknown } | undefined): boolean {
  return row?.permission_pending !== null && row?.permission_pending !== undefined
}

interface RegisteredRuntimeTerminator {
  findExpectedAdoptionPane(expected: ExpectedAdoptionPane): AdoptionPaneLookup
  killExpectedAdoptionPane(expected: ExpectedAdoptionPane): boolean
  killSession(slug: string): void
  isLive(slug: string): boolean
}

// The terminator completeThread runs on, and today it answers nothing. Every live row is headless and
// is handled by the codex/claude branches in stopThreadRuntime; a pre-cutover row's worker is long gone,
// so there is nothing left here to probe or to stop, and every lookup is simply absent.
//
// It stays a seam rather than an inlined `false` because of what it used to carry and because the
// invariant that shape defended still binds. Liveness was once a per-request probe of an external
// process table, and the naive form — one uncached exec before AND after the kill — is exactly what
// starved the event loop and pushed Mark-as-done latency to seconds while an agent streamed (see the
// liveness cache in `tmux.ts`, deleted 2026-08-02 in 05996657). The fix was to trust a BATCHED cache
// (one query answered every session) for a "live" verdict — the common resting-shell path — and to
// CONFIRM a "dead" one with a single fresh uncached check, because that cache latched an all-dead map
// for its 900ms TTL after a transient throw and archiving a still-live worker without stopping it would
// orphan it. So live→fast, dead→verified; killSession invalidated the cache so the post-kill re-check
// read fresh too. What survives all of it is the rule the branches below still keep: prove the runtime
// stopped before recording Done.
const cachedLivenessTerminator: RegisteredRuntimeTerminator = {
  findExpectedAdoptionPane: () => ({ kind: "absent" }),
  killExpectedAdoptionPane: () => true,
  killSession: () => {},
  isLive: () => false,
}

// The other terminator. An app-server Codex thread has NO runtime of its own to kill: its worker is a
// TURN running inside the shared codex app-server, which now lives in a DETACHED daemon that
// deliberately outlives the frizz runtime. Routed through the registered-runtime terminator it takes
// stopRegisteredRuntime's `unbound` branch, kills a session that never existed, and reports "stopped" —
// while the turn keeps running, burning tokens and touching the repo with no frizz-side owner and no UI
// trace. Before the daemon worked this was masked, because the app-server died with the runtime.
// `turn/interrupt` over the bridge is the only thing that actually stops it. (Subset of
// CodexAppServerBridge so the router does not depend on the whole bridge and a test can substitute a
// stub.)
export interface CodexTurnTerminator {
  turnLiveness(threadSlug: string, sessionId: string): { bridgeTurn: boolean } | undefined
  interruptTurn(threadSlug: string, sessionId: string): Promise<{ interrupted: boolean }>
}

// The ACP bridge's slice of the same contract: a turn is live only while its `session/prompt` is in
// flight, and interruptTurn resolves once that prompt has returned (or the child was killed).
export interface AcpTurnTerminator {
  turnLiveness(threadSlug: string, sessionId: string): { turnActive: boolean } | undefined
  interruptTurn(threadSlug: string, sessionId: string): Promise<{ interrupted: boolean }>
  /** End the agent itself — its daemon outlives frizz (acp-host.ts), so a stop that only cancelled
   *  the turn would leave the agent running for nobody. */
  releaseSession(threadSlug: string, sessionId: string, reason: "session-replaced" | "session-deleted"): void
  /** Whether an agent process exists for this session at all — attached or not, mid-turn or idle. The
   *  Claude broker's `isDaemonAlive` twin: an idle daemon is still a live worker to end. */
  isAgentAlive(threadSlug: string, sessionId: string): boolean
}

// Which rows the bridge owns. A LEGACY Codex row — dispatched pre-cutover, `codex_runtime` NULL,
// migrated only when a follow-up first touches it (see followUp) — was never an app-server thread, so it
// keeps the registered-runtime terminator, which finds nothing to stop because that row's pre-cutover
// worker is long gone. This is deliberately the OPPOSITE test from setThreadPermission /
// setThreadProfile: those branch on the BACKEND alone because the controller they avoided was Claude-only
// and would have parsed a legacy Codex TUI as a Claude composer, so a legacy row must not reach it. Here
// the legacy path is CORRECT for a legacy row and wrong only for a migrated app-server one, so the
// runtime column — the thing that actually says where the worker lives — is the right discriminator.
export function isAppServerCodexRow(row: Pick<SessionRow, "backend" | "codex_runtime">): boolean {
  return row.backend === "codex" && row.codex_runtime === "app-server"
}

// The Claude twin of the codex turn terminator. A broker-backed Claude row also has NO runtime of its
// own to kill: its worker is a Claude session owned by a DETACHED daemon that outlives frizz. Routed
// through the registered-runtime terminator it would take stopRegisteredRuntime's `unbound` branch, kill
// a session that never existed, and report "stopped" while the ownerless daemon keeps running — the same
// phantom-stop the codex terminator exists to prevent. releaseSession SIGTERMs the daemon by record
// (even when this frizz process holds no live socket, e.g. after a restart); isDaemonAlive reports
// whether one was there to stop. (Subset of ClaudeAgentBrokerBridge so the router needn't depend on the
// whole bridge.)
export interface ClaudeBrokerTerminator {
  isDaemonAlive(sessionId: string): boolean
  releaseSession(threadSlug: string, sessionId: string, reason: "session-replaced" | "session-deleted"): boolean
}


// The bridge is already the board's authority on whether a codex turn is live (context.ts wires
// turnLiveness into createBoard for exactly that reason); make it the termination authority too, so the
// two can never disagree. `bridgeTurn` false means there is nothing to interrupt — a resting codex thread
// then costs no bridge round-trip and never spawns an app-server just to be told "nothing to stop".
export function appServerCodexTurnLive(
  codex: CodexTurnTerminator | undefined,
  row: Pick<SessionRow, "slug" | "session_id">,
): boolean {
  return codex?.turnLiveness(row.slug, row.session_id)?.bridgeTurn === true
}

// THE seam every "stop this thread's worker" verb goes through, so a new verb cannot silently
// reacquire the hole this closed: a stop that only knew how to kill a REGISTERED runtime, and so
// reported success for a headless row whose daemon it never touched. Returns "stopped" only for a
// termination that actually landed; an interrupt that could not be delivered THROWS rather than
// degrading to "stopped", because the caller's next act is to record the worker as exited/done and that
// record must not outrun the truth.
export async function stopThreadRuntime(
  storage: Pick<Storage, "getAdoptionClaim"> & Partial<Pick<Storage, "getSession" | "getAdoptionRuntimeSnapshot">>,
  row: SessionRow,
  runtime: RegisteredRuntimeTerminator = cachedLivenessTerminator,
  codex?: CodexTurnTerminator,
  claudeBroker?: ClaudeBrokerTerminator,
  acp?: AcpTurnTerminator,
): Promise<"absent" | "stopped"> {
  if (row.backend === "acp") {
    // The bridge answers both questions: is a turn running, and stop it (session/cancel, then wait for
    // the prompt to return). Then END the agent: it lives in a detached daemon that would otherwise sit
    // idle for hours after the thread is put away. A resting thread with no daemon costs nothing here.
    if (!acp) return "absent"
    const alive = acp.isAgentAlive(row.slug, row.session_id)
    const turnActive = acp.turnLiveness(row.slug, row.session_id)?.turnActive === true
    if (turnActive) await acp.interruptTurn(row.slug, row.session_id)
    acp.releaseSession(row.slug, row.session_id, "session-deleted")
    return alive ? "stopped" : "absent"
  }
  if (isAppServerCodexRow(row)) {
    if (!appServerCodexTurnLive(codex, row)) return "absent"
    if (!codex) throw new Error("The Codex app-server is unavailable; nothing was stopped")
    // interruptTurn resolves only once the turn is proved retired (see its contract), so by the time
    // this returns the caller may record the stop without racing the turn's own ending.
    return (await codex.interruptTurn(row.slug, row.session_id)).interrupted ? "stopped" : "absent"
  }
  if (isBrokerClaudeRow(row)) {
    if (!claudeBroker) throw new Error("The Claude session broker is unavailable; nothing was stopped")
    // Kill the ownerless daemon. Unlike a codex turn-interrupt (session survives), a broker daemon owns
    // exactly ONE session, so this terminates the worker outright — the same all-or-nothing stop a Claude
    // worker has always had, where ending the process ends the session with it. isDaemonAlive is read
    // FIRST so we report "absent" for an already-dead one.
    const wasAlive = claudeBroker.isDaemonAlive(row.session_id)
    claudeBroker.releaseSession(row.slug, row.session_id, "session-deleted")
    return wasAlive ? "stopped" : "absent"
  }
  return stopRegisteredRuntime(storage, row, runtime)
}

// A finalized cold adoption is permanently bound to one exact runtime generation. Destructive UI
// actions must never fall back to the reusable session name: another process may already occupy it
// after the owner exited. Verify token + full tuple, kill that tuple only, then prove it disappeared
// before deleting registry ownership or reporting the worker stopped. Adoption spawns through the broker
// now, so a live claim carries no runtime tuple and every lookup answers "absent" (see
// adoption-recovery.ts); the protocol is kept because a claim written by a PRE-cutover frizz still has
// to be refused safely rather than resolved to a name someone else may hold.
export function stopRegisteredRuntime(
  storage: Pick<Storage, "getAdoptionClaim"> & Partial<Pick<Storage, "getSession" | "getAdoptionRuntimeSnapshot">>,
  row: Pick<SessionRow, "slug" | "session_id" | "runtime_generation">,
  runtime: RegisteredRuntimeTerminator = cachedLivenessTerminator,
): "absent" | "stopped" {
  const binding = adoptionRuntimeBinding(storage, row)
  if (binding.kind === "conflict") {
    throw new Error("This thread has a competing adoption attempt; nothing was stopped")
  }
  if (binding.kind === "unbound") {
    runtime.killSession(row.slug)
    return "stopped"
  }

  const claim = binding.claim
  const current = runtime.findExpectedAdoptionPane(claim)
  if (current.kind === "absent") return "absent"
  if (current.kind !== "found") {
    throw new Error("The adopted worker's exact runtime identity is unavailable; nothing was stopped")
  }
  if (!runtime.killExpectedAdoptionPane(claim)) {
    const afterMiss = runtime.findExpectedAdoptionPane(claim)
    if (afterMiss.kind !== "absent") {
      throw new Error("The adopted worker changed before it could be stopped; nothing was stopped")
    }
    return "absent"
  }
  if (runtime.findExpectedAdoptionPane(claim).kind !== "absent") {
    throw new Error("The adopted worker could not be confirmed stopped")
  }
  return "stopped"
}

export async function stopRuntimeBySlug(
  storage: Pick<Storage, "getAdoptionClaim" | "getSession">,
  slug: string,
  runtime: RegisteredRuntimeTerminator = cachedLivenessTerminator,
  codex?: CodexTurnTerminator,
  claudeBroker?: ClaudeBrokerTerminator,
  acp?: AcpTurnTerminator,
): Promise<{ outcome: "absent" | "stopped"; row?: SessionRow }> {
  const row = storage.getSession(slug)
  if (row) return { outcome: await stopThreadRuntime(storage, row, runtime, codex, claudeBroker, acp), row }
  if (storage.getAdoptionClaim(slug)) throw new Error("An adoption attempt is in progress; nothing was stopped")
  // A rowless thread name has no durable owner identity. Even a DB lock cannot make a detached worker
  // crash-safe after this process dies, so never issue a reusable-name kill without a row.
  throw new Error("No registered runtime identity is available; nothing was stopped")
}

// A live provider shell is deliberately not synonymous with a live *turn*. Providers keep their
// session resident at an idle prompt so a later steer can reuse it. Marking that resting shell
// done is safe to perform immediately (and must still terminate it so it is not orphaned). We ask
// only when the server can see work still being executed. Missing telemetry is intentionally
// conservative: a live, unobservable runtime may still be in the middle of a turn.
// The evidence itself, not just the verdict: the dialog has to be able to say WHICH work it refused
// to kill silently. Returns undefined when the completion may proceed immediately.
export function completionConfirmationHold(telemetry: SessionTelemetry | undefined): CompletionHold | undefined {
  const empty = { turnInFlight: false, subAgents: [], subAgentCount: 0, bgShells: [], bgShellCount: 0 }
  if (!telemetry) return { ...empty, unobservable: true }

  // These are paused waiting for a person, not churning. They are safe to stop as part of an
  // immediate Done transition; neither is evidence of an executing model/tool turn.
  if (telemetry.permPrompt || telemetry.pendingAsk) return undefined

  // Only ACTIVELY-running work holds Done back. A `stale` sub-agent — its completion signal lost AND its
  // transcript silent 15 min past its last write, or past the deadline of a Bash wait it declared
  // (tailer `quietPastWindow`) — is far closer to finished/dead than to working, and counting it here
  // contradicted the queue:
  // hasLiveBackgroundWork (board.ts) holds a thread out of the queue on `running` ONLY, so a stale-only
  // parent read as at-rest in the rail yet Mark-as-done warned it was busy. The two must agree, so match
  // it — running only. (The parenthetical here read "bgShells have no stale state; this narrows
  // sub-agents, leaves shells unchanged" until 2026-08-27, and both halves have been false since
  // `shellIsGone` landed: BgShellView.state is `running | stale`, so this filter drops a stale SHELL
  // too — which is the behaviour that agrees with the queue, and the reason to say so accurately.
  // `isDirectSubAgent` reads `depth ?? 1`, and a shell carries no depth, so it passes that half
  // untouched — the narrowing a shell actually gets is the state check alone.)
  // The real orphan case that used to strand stale rows here now retires at its `stopped` recovery
  // notification (see trackCompletions), so those never reach this filter at all.
  // DIRECT children only, for the same reason hasLiveBackgroundWork reads only those: the two must
  // agree, and a descendant (a sub-agent's own sub-agent) is surfaced for RENDERING. A running
  // descendant always sits under a running-or-rested direct child, so the work it represents is
  // already held by that child's row.
  // A type guard, so the filtered lists carry "running" into holdOps below rather than the wider view
  // union (a sub-agent can also read `rested` — its run over, its own fan-out still going — which is not
  // work this hold may claim is running).
  const busy = <T extends { state: string; depth?: number }>(op: T): op is T & { state: "running" } =>
    op.state === "running" && isDirectSubAgent(op)
  const subAgents = telemetry.subAgents.filter(busy)
  const bgShells = telemetry.bgShells.filter(busy)
  const turnInFlight = telemetry.turn === "in-flight"
  if (!turnInFlight && subAgents.length === 0 && bgShells.length === 0) return undefined
  return {
    turnInFlight,
    unobservable: false,
    subAgents: holdOps(subAgents),
    subAgentCount: subAgents.length,
    bgShells: holdOps(bgShells),
    bgShellCount: bgShells.length,
  }
}

// How long an input the broker bridge took may stand in for a turn the tailer has not folded yet (see
// `inputAhead` in the Claude follow-up). An input's record reaches the JSONL in tens of ms on a live
// daemon and in a few seconds through a cold resume; past this the transcript is the better witness.
const INPUT_AHEAD_MAX_MS = 30_000

// Worker-authored labels, so cap both the list and each string before they cross the wire — the same
// defensive discipline every other foreign-payload surface here follows. The untruncated counts ride
// alongside (see CompletionHold), so a capped list is reported as "+N more", never silently shortened.
const HOLD_OPS_MAX = 8
const HOLD_LABEL_MAX = 100
function holdOps(ops: readonly { label: string; state: "running" | "stale" }[]): CompletionHold["subAgents"] {
  return ops.slice(0, HOLD_OPS_MAX).map((op) => ({
    label: op.label.trim().slice(0, HOLD_LABEL_MAX) || "(unnamed)",
    state: op.state,
  }))
}

export function completionNeedsConfirmation(telemetry: SessionTelemetry | undefined): boolean {
  return !!completionConfirmationHold(telemetry)
}

// The other half of the live guard above. A worker that is DEAD but whose recorded turn never ended was
// CUT OFF — a reboot, a SIGTERM, a crash mid-tool-call — and its thread reads exactly like the executing
// one: the same half-finished transcript, the same trailing tool call. `live` is false there, so the
// live hold was never consulted and Mark-as-done archived it in ONE click with no dialog: the queue's
// Stalled card, whose verb is Retry, became a ✓ Done row. Observed 2026-09-03: a reboot cut eight nub
// workers off mid-turn and one was filed under Done with its last Bash call still open (maintainer:
// "a lot of cancelled sessions got incorrectly marked as Done").
//
// The hold says only that the turn never finished. It names no ops, because a dead daemon's children
// cannot be running and listing them as such would be a lie; and nothing is terminated on this path,
// because there is nothing left to terminate — `terminateLive` is simply the human's confirmation, the
// same word it is for the live case. `turn` is the transcript's own reading (computeTurn): a tool call
// with no result, or a user record nothing answered, stays in-flight indefinitely — which is exactly the
// evidence that the worker did not finish. A dead worker at REST (end_turn) holds nothing and archives
// as before.
export function cutOffHold(telemetry: SessionTelemetry | undefined): CompletionHold | undefined {
  if (telemetry?.turn !== "in-flight") return undefined
  return { turnInFlight: true, cutOff: true, unobservable: false, subAgents: [], subAgentCount: 0, bgShells: [], bgShellCount: 0 }
}

// A completion is intentionally stronger than an archive toggle. It first establishes whether the
// *registered* runtime is still executing, and it only records Done after any necessary termination
// has been proved. A live resting shell is stopped and archived in one click; an executing or
// unobservable runtime requires explicit confirmation. Adopted workers stay bound to their exact
// runtime tuple; a same-name replacement is never killed or mistaken for the original worker.
export async function completeRegisteredThread(
  storage: Pick<Storage,
    "getAdoptionClaim" | "getAdoptionRuntimeSnapshot" | "getSession" | "completeIfCurrent"
  >,
  row: SessionRow,
  terminateLive: boolean,
  runtime: RegisteredRuntimeTerminator = cachedLivenessTerminator,
  telemetry?: SessionTelemetry,
  codex?: CodexTurnTerminator,
  claudeBroker?: ClaudeBrokerTerminator,
  acp?: AcpTurnTerminator,
): Promise<{ needsConfirmation: boolean; hold?: CompletionHold }> {
  const binding = adoptionRuntimeBinding(storage, row)
  if (binding.kind === "conflict") {
    throw new Error("This thread has a competing adoption attempt; nothing was changed")
  }
  // An app-server Codex row is never "live" to the registered-runtime probe — it has no runtime of its
  // own — so asking that probe made Mark-as-done on a RUNNING codex thread archive it silently: no
  // confirmation dialog (live was false, so the hold was never computed) and no termination. The bridge
  // answers for it instead, which restores BOTH halves: an executing turn now earns the same "End this
  // session?" confirmation a Claude shell does, and confirming it actually interrupts the turn.
  const appServerCodex = isAppServerCodexRow(row)
  const brokerClaude = isBrokerClaudeRow(row)
  // A broker Claude row is "live" iff its ownerless daemon is running — never a registered runtime.
  // Without this, Mark-as-done on a running broker thread would archive it silently (live=false → no
  // confirmation, no termination) and orphan the daemon, the exact codex bug this branch mirrors.
  // A pre-cutover row has no transport left, so it can never be live; every current row is one of the
  // two headless kinds above.
  // An ACP row is live while its prompt is in flight — the bridge's own reading, same as codex.
  const live = brokerClaude
    ? (claudeBroker?.isDaemonAlive(row.session_id) ?? false)
    : appServerCodex
    ? appServerCodexTurnLive(codex, row)
    // An ACP row is live while its agent's daemon exists — idle or mid-turn — exactly as a broker Claude
    // row is. Reading only the TURN here left Mark as done on an idle ACP thread skipping the stop, so
    // the daemon and its agent outlived the archived thread (found on the promoted-artifact run,
    // 2026-09-24: two `opencode acp` processes still up after both threads were marked done).
    : row.backend === "acp"
    ? (acp?.isAgentAlive(row.slug, row.session_id) ?? false)
    : false

  // A live runtime is asked about when it is still working; a dead one when it never finished. The
  // human's confirmation (`terminateLive`) clears both.
  const hold = terminateLive ? undefined : live ? completionConfirmationHold(telemetry) : cutOffHold(telemetry)
  if (hold) return { needsConfirmation: true, hold }
  if (live) {
    // Ordering, both paths: TERMINATE FIRST, record Done only after. A stop that throws must leave the
    // row exactly as it was — an archived row whose worker is still running is the failure this whole
    // change exists to remove, and for codex it is unrecoverable from the UI (the daemon outlives us
    // and an archived thread has no card left to act on).
    await stopThreadRuntime(storage, row, runtime, codex, claudeBroker, acp)
    // For a standalone registered session this is the postcondition that turns an idempotent kill into
    // a safe completion operation. An adopted binding is already verified by stopRegisteredRuntime, an
    // app-server codex turn by interruptTurn's own proof that the turn retired, and a broker Claude
    // session by releaseSession's SIGTERM-by-record (there is no separate runtime left to re-probe).
    if (!appServerCodex && !brokerClaude && binding.kind === "unbound" && runtime.isLive(row.slug)) {
      throw new Error("The session could not be confirmed stopped; it was not marked done")
    }
  }

  const generation = row.runtime_generation ?? 0
  if (!storage.completeIfCurrent(row.slug, row.session_id, generation)) {
    throw new Error("This thread resumed or was replaced while it was being completed; the new worker was preserved")
  }
  return { needsConfirmation: false }
}

export async function stopAndForgetRegisteredRuntime(
  storage: Pick<Storage,
    "getAdoptionClaim" | "getAdoptionRuntimeSnapshot" | "getSession" | "forgetSessionIfCurrent"
  >,
  row: SessionRow,
  runtime: RegisteredRuntimeTerminator = cachedLivenessTerminator,
  codex?: CodexTurnTerminator,
  claudeBroker?: ClaudeBrokerTerminator,
  acp?: AcpTurnTerminator,
): Promise<SessionRow> {
  const binding = adoptionRuntimeBinding(storage, row)
  if (binding.kind === "conflict") {
    throw new Error("This thread changed while it was being dismissed; nothing was removed")
  }
  const expected = {
    sessionId: row.session_id,
    runtimeGeneration: row.runtime_generation ?? 0,
    adoptionAttemptToken: binding.kind === "bound" ? binding.claim.attempt_token : null,
  }
  await stopThreadRuntime(storage, row, runtime, codex, claudeBroker, acp)
  const forgotten = storage.forgetSessionIfCurrent(row.slug, expected)
  if (!forgotten) {
    throw new Error("This thread resumed or was replaced while it was being dismissed; the new worker was preserved")
  }
  return forgotten
}

// The typed RPC surface. Every handler is thin: state mutations go through frizz scripts
// (thread files) or a worker daemon's bridge (agents), then rebuild the board so a fresh snapshot fans
// out on SSE.
/**
 * Register a folder as a project: the one implementation behind both the picker and a typed path.
 *
 * Almost everything it does is what the CLI already does on every launch — mint or adopt
 * `.frizz/.id`, write the index — and it dispatches nothing, which is what makes it a strictly
 * smaller authority than running `frizz` in that directory. The one deliberate divergence is the
 * root: an explicit choice resolves through chosenProjectRoot, not the launcher's cwd walk-up.
 */
/**
 * A registry entry as the grid and the rail see it.
 *
 * One mapper for all four routes that return a card (`projectsList`, `projectAdd`, `projectPick`, and
 * both icon mutations): they went out of sync the moment the icon fields arrived, and a card whose
 * `iconVersion` is missing is a square that silently keeps showing the icon it just replaced.
 */
function projectCard(entry: RegistryEntry, stale: boolean): ProjectCard {
  return {
    id: entry.id,
    slug: entry.slug,
    name: entry.name ?? basename(entry.path) ?? entry.path,
    path: entry.path,
    lastOpenedAt: entry.lastOpenedAt,
    stale,
    // The picture's own hash where it is known, so the URL changes when the picture does and never
    // otherwise. A miss has no hash, and takes the scan time: an old miss must be a NEW url, because
    // the request for it is what runs the rescan (see iconStatus below).
    iconVersion: entry.iconHash ?? entry.iconScannedAt,
    // `iconScannedAt` alone cannot answer this: it is stamped whenever a scan RAN, found or not. See
    // ProjectCard.iconStatus for why the never-scanned case has to stay distinguishable.
    //
    // AND a miss is only `none` while the server would itself still trust it — from the CURRENT
    // scanner, and recent. The client suppresses the icon request for a `none`, and the server can only
    // rescan when a request arrives, so a `none` the server no longer trusts is a miss that is never
    // re-asked. Twice measured on the real registry: nub's `site/public/icon.svg` behind a
    // pre-versioning miss (2026-08-08), and three projects' new `logo.svg` behind a miss from that
    // morning (2026-10-11). `projectIconStatus` shares its predicate with the route's for that reason.
    iconStatus: projectIconStatus(entry),
    iconIsCustom: entry.iconSource === "custom" ? true : undefined,
  }
}

export function addProjectAtPath(input: string, home = homedir()): ProjectCard {
  const typed = input.trim()
  if (!typed) throw new Error("Enter a folder path.")
  // `~` is what a person types; it is not a path any filesystem call understands.
  const expanded = typed === "~" || typed.startsWith("~/") ? join(home, typed.slice(1)) : typed
  const absolute = resolve(expanded)
  let stats: Stats
  try {
    stats = statSync(absolute)
  } catch {
    throw new Error(`No folder at ${absolute}`)
  }
  if (!stats.isDirectory()) throw new Error(`That is a file, not a folder: ${absolute}`)
  // A folder INSIDE a checkout still adds the checkout, but an explicitly chosen folder is otherwise
  // the project itself — an adopted plain-directory ancestor does not capture it (chosenProjectRoot).
  const root = chosenProjectRoot(absolute, home)
  // Minting an id in $HOME writes a project into ~/.frizz — Frizz's own state root — and every
  // unmarked directory under home then resolves to it. The launcher refuses this; so does the grid.
  if (isHomeDirectory(root, home)) throw new Error("The home folder cannot be a project — choose a folder inside it.")
  // SEEDED, exactly as the launcher seeds it: an established repository whose id lives only in
  // `git config frizz.id` keeps that id, so adding it from the grid finds its existing board instead
  // of minting a fresh one and orphaning every thread on it.
  const id = ensureProjectIdFile(root, home, existingProjectId(root))
  const remoteOwner = resolveProjectLabel(root)?.split("/")[0]
  let registered = registerProject({ dir: root, id, remoteOwner }, home)
  if (registered.action === "duplicate") {
    // A copied checkout brought another project's `.frizz/.id` with it; give it one of its own
    // rather than letting it adopt the original's threads.
    registered = registerProject({ dir: root, id: writeProjectIdFile(root, randomUUID()), remoteOwner }, home)
  }
  if (!registered.entry) throw new Error("Could not register that folder.")
  return projectCard(registered.entry, false)
}

/** The audit fields for a project the add or the pick registered: the card names the real root. */
function addedProject(card: ProjectCard): AuditFields {
  return { project: { id: card.id, dir: card.path } }
}

/**
 * Store an icon's BYTES for a project, whatever chose them.
 *
 * Shared by the browser file input (projectIconSet) and the native picker (projectIconPick) so the
 * validation cannot drift between the two ways in — the magic-byte check especially, which is what
 * keeps a file the browser will not render from becoming a permanently broken square.
 */
function storeProjectIcon(id: string, name: string, bytes: Buffer): ProjectCard {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1]
  if (!extension || !(PROJECT_ICON_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new Error(`Choose a ${PROJECT_ICON_EXTENSIONS.join(", ")} image.`)
  }
  const entry = listProjects().find((project) => project.id === id)
  if (!entry) throw new Error("No such project.")
  if (bytes.length === 0) throw new Error("That file is empty.")
  const path = customIconPath(id, `.${extension}`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  if (!imageDimensions(path)) {
    rmSync(path, { force: true })
    throw new Error("That file does not look like an image Frizz can draw.")
  }
  // A previous upload in a DIFFERENT format would otherwise sit beside this one and win nothing, but
  // it would linger forever; the registry only ever points at the newest.
  for (const stale of PROJECT_ICON_EXTENSIONS) {
    const other = customIconPath(id, `.${stale}`)
    if (other !== path) rmSync(other, { force: true })
  }
  const updated = setProjectIcon(id, path)
  if (!updated) throw new Error("No such project.")
  return projectCard(updated, entry.stale)
}

/**
 * Where a project's icon picker opens, and what it asks. Shared by the pick and the build ahead of it,
 * because a panel built in any other directory is not the one the pick shows.
 */
function iconPicker(id: string): { startIn: string | undefined; prompt: string } {
  const entry = listProjects().find((project) => project.id === id)
  if (!entry) throw new Error("No such project.")
  // A directory that has since been moved or deleted is not a reason to refuse the dialog — it just
  // opens wherever the OS would have opened it anyway.
  return { startIn: entry.stale ? undefined : entry.path, prompt: `Choose an icon for ${entry.name ?? entry.slug}` }
}

/** The picked FILE's bytes, read from disk — the native picker hands back a path, not an upload. */
function setProjectIconFromFile(id: string, file: string): ProjectCard {
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  } catch {
    throw new Error("That file could not be read.")
  }
  // The upload path's cap is in base64 CHARS; 4 of those encode 3 bytes, so the same ceiling in
  // raw bytes keeps the two entry points on one limit rather than two that drift.
  if (bytes.length > (PROJECT_ICON_MAX_BASE64_CHARS / 4) * 3) throw new Error("That image is too large.")
  return storeProjectIcon(id, file, bytes)
}

// MODULE level, not per-router: one Frizz serves N projects, each with its own router instance, and
// every cache key here is a fully-qualified `owner/repo#N` — so sharing the cache across tenants is
// both safe and the point (a monorepo's threads and a sibling project's threads referencing the same
// upstream issue pay for it once).
const githubHovercards = createGithubHovercardService()

function mergeSubAgentSteers(messages: TranscriptMessage[], steers: SubAgentSteerRow[]): TranscriptMessage[] {
  if (!steers.length) return messages
  const merged = [...messages]
  for (const steer of steers) {
    const at = new Date(steer.sent_at).toISOString()
    // Future broker versions may start persisting addressed input. Prefer the provider's native record
    // when the same text appears at the same instant rather than rendering Frizz's journal copy too.
    const duplicate = messages.some((message) => {
      if (message.role !== "user" || message.text.trim() !== steer.message.trim() || !message.at) return false
      return Math.abs(Date.parse(message.at) - steer.sent_at) <= 5_000
    })
    if (duplicate) continue
    const message: TranscriptMessage = {
      sourceId: `subagent-steer:${steer.delivery_id}`,
      role: "user",
      text: steer.message,
      agentInstruction: true,
      tools: [],
      parts: [{ kind: "text", text: steer.message }],
      at,
    }
    const next = merged.findIndex((candidate) => candidate.at !== undefined && Date.parse(candidate.at) > steer.sent_at)
    if (next === -1) merged.push(message)
    else merged.splice(next, 0, message)
  }
  return merged
}

export function createRouter(ctx: AppContext) {
  const frizzDir = join(ctx.project.dir, ".frizz")
  // Roots for the file-OPEN action + the inline-code path classifier (see openableFileRoots): shared so
  // a path the resolver blesses is exactly a path the open action will accept.
  const openRoots = openableFileRoots(ctx.project)

  // THE AUDIT TRAIL (audit.ts): every procedure that adds or removes a project, starts a worker, or
  // puts words in front of one records who asked — through this, so each records the same way. This
  // project is the one whose board answered; an add or a remove names the project it acted on instead.
  const thisProject = { id: ctx.project.id, dir: ctx.project.dir }
  const audit = <T>(
    action: AuditAction,
    base: AuditFields | (() => AuditFields),
    run: () => T | Promise<T>,
    onResult?: (result: T) => AuditFields,
  ): Promise<T> => audited(ctx.audit, action, base, run, { onResult, servedBy: ctx.project.id })

  // An auto-titled registry row is session-first authority. A same-slug `.frizz/<slug>.md` may have
  // been planted independently and is never a readable or writable extension of that session.
  function isAutoTitledSession(slug: string): boolean {
    return ctx.storage.getSession(slug)?.title_auto === 1
  }

  function assertLegacyMutationAllowed(slug: string): void {
    if (isAutoTitledSession(slug)) {
      throw new Error("session-first auto-titled threads do not own a legacy thread file")
    }
  }

  // Bind a mutation to the session the CALLER was looking at. A stale tab holding a replaced session
  // id fails closed rather than acting on whatever now owns the slug (merged from origin/main).
  /** Register an EXTERNAL session on its first steer, so the follow-up that triggered it lands on a
   *  real thread. A no-op for every ordinary send.
   *
   *  The three conditions are all necessary. There must be NO ROW (else this is an ordinary thread, or
   *  a stale tab, and the ownership guard below owns that case). The slug must EQUAL the session id,
   *  because that is the only shape an external row ever has — a promoted thread keeps the id it was
   *  discovered under, so a request naming two different values did not come from this band. And the
   *  tailer must still be listing it as external RIGHT NOW, which is what makes this un-forgeable:
   *  the caller cannot talk frizz into adopting an arbitrary uuid, only a transcript the server can
   *  see for itself in this project's own log directory. */
  async function promoteExternalSession(slug: string, sessionId: string): Promise<boolean> {
    if (slug !== sessionId) return false
    if (ctx.storage.getSession(slug)) return false
    if (!ctx.tailer.foreignIds().includes(slug)) return false
    const tele = ctx.tailer.get(slug)
    await ctx.dispatcher.adoptSession({
      sessionId: slug,
      backend: ctx.tailer.foreignBackend?.(slug) ?? "claude",
      // The session's own name (Claude's ai-title) when it has one. Codex writes no title record, so
      // that row keeps the short-id name the band showed — the same string, not a second guess.
      ...(tele?.aiTitle ? { title: tele.aiTitle.slice(0, 200) } : {}),
    })
    return true
  }

  function currentOwnedSession(slug: string, sessionId: string) {
    const row = ctx.storage.getSession(slug)
    if (!row || row.session_id !== sessionId) {
      throw new Error("This thread was replaced; refresh before acting on its current session")
    }
    return row
  }

  // The title a thread is known by on its board — what a `<thread-message>` names its sender with, and
  // what a steer's receipt names its target with.
  function threadTitleOf(row: SessionRow): string {
    const shown = resolveSessionTitle(row, ctx.tailer.get(row.slug))
    return shown.aiTitle || shown.title || row.slug
  }

  // THE RECEIVING HALF OF `frizzctl steer`: one `<thread-message>` into a thread of THIS project. The
  // sender is the caller's to have verified — this project's own `steerThread` for a sender here, the
  // sending project's for one elsewhere, which reaches this through `ctx.threadInbox` below.
  async function receiveThreadMessage(sent: Parameters<ThreadInbox>[0]): Promise<SteerThreadResult> {
    const target = ctx.storage.getSession(sent.to)
    if (!target) throw new Error(`no thread \`${sent.to}\` in this project`)
    const delivery: SteerThreadResult["delivery"] =
      target.state === "archived" || target.archived === 1 ? "reopened"
      : ctx.tailer.get(sent.to)?.turn === "in-flight" ? "running"
      : "resting"
    await deliverFollowUp({ slug: sent.to, sessionId: target.session_id, message: formatThreadMessage(sent.from, sent.message) })
    return { slug: target.slug, title: threadTitleOf(target), delivery }
  }
  ctx.threadInbox = receiveThreadMessage

  // THE RECEIVING HALF OF `frizzctl spawn-thread --project`: this project's own dispatch, for a worker in
  // another project (or this one, naming it). Audited HERE as a `dispatch` naming the spawner, because
  // this is the board the thread lands on, and so the log a reader of this project checks first.
  function spawnForThread({ from, input }: Parameters<ThreadSpawner>[0]): Promise<{ slug: string; sessionId: string }> {
    return audit(
      "dispatch",
      {
        project: thisProject,
        detail: {
          prompt: textDigest(input.prompt), backend: input.backend ?? "claude", model: input.model ?? null, effort: input.effort ?? null,
          spawnedBy: { thread: from.slug, ...(from.project ? { project: from.project } : {}) },
        },
      },
      () => ctx.dispatcher.dispatch(input, { backend: input.backend }),
      (result) => ({ thread: result.slug, detail: { sessionId: result.sessionId } }),
    )
  }
  ctx.threadSpawner = spawnForThread

  type OpenProject = ReturnType<NonNullable<AppContext["activeTenants"]>>[number]
  const projectSlugOf = (id: string) => findById(id)?.slug ?? id
  const otherOpenProjects = (): OpenProject[] => (ctx.activeTenants?.() ?? []).filter((open) => open.project.id !== ctx.project.id)

  /**
   * The project a worker's `--project` names, for a steer or a spawn: `undefined` for THIS project, else
   * that project's entry among the open ones. By URL slug or registry id. Throws, with the fix in the
   * message, when no project has that name or when it is registered but not open; `unreachable` says
   * what that costs the caller.
   *
   * Only projects this process has OPEN can be reached, because delivery needs that project's live
   * board and runtimes. Every registered project is opened shortly after boot (tenant-prime.ts), so a
   * closed one is a folder that is gone, a project another Frizz serves, or one that would not open.
   */
  function openProjectNamed(project: string, unreachable: string): OpenProject | undefined {
    const entry = findProjectBySegment(project)
    const id = entry?.id ?? project
    if (id === ctx.project.id) return undefined
    const open = otherOpenProjects().find((candidate) => candidate.project.id === id)
    if (open) return open
    if (!entry) {
      const known = listProjects().filter((p) => !p.archived).map((p) => `\`${p.slug}\``)
      throw new Error(
        `no project \`${project}\` on this machine. Name it by the slug its board URL shows (\`/project/<slug>/…\`)` +
        (known.length ? `; the projects are ${known.join(", ")}` : ""),
      )
    }
    throw new Error(
      `project \`${entry.slug}\` is registered but not open in this Frizz — its folder may be gone, another ` +
      `Frizz may be serving it, or it failed to open — so ${unreachable}`,
    )
  }

  /**
   * Where a `frizzctl steer` target lives: `undefined` for THIS project, else the other project's URL
   * slug and the inbox that delivers there. Throws, with the fix in the message, when it is nowhere.
   *
   *   · `project` named (a `--project`, or the `/project/<slug>/` of a link the command was handed):
   *     that project and only that one (openProjectNamed).
   *   · none: this project first — so a slug that is ALSO taken elsewhere still means the thread
   *     beside the sender, as it did before steer crossed projects — then every other open project. A
   *     slug only one of them has is that thread; one several have is refused rather than guessed.
   */
  function resolveSteerTarget(to: string, project: string | undefined): { project: string; inbox: ThreadInbox } | undefined {
    const reachable = (open: OpenProject) => {
      if (!open.threadInbox) {
        throw new Error(`project \`${projectSlugOf(open.project.id)}\` is open in Frizz but not taking messages yet; retry in a moment`)
      }
      return { project: projectSlugOf(open.project.id), inbox: open.threadInbox }
    }
    if (project) {
      const open = openProjectNamed(project, "none of its threads can be reached from here")
      if (!open) {
        if (!ctx.storage.getSession(to)) throw new Error(`no thread \`${to}\` in this project (\`${project}\`)`)
        return undefined
      }
      if (!open.storage?.getSession(to)) {
        throw new Error(`no thread \`${to}\` in project \`${projectSlugOf(open.project.id)}\`. Pass the slug exactly as a thread link names it (\`/thread/<slug>\`)`)
      }
      return reachable(open)
    }
    if (ctx.storage.getSession(to)) return undefined
    const holders = otherOpenProjects().filter((open) => open.storage?.getSession(to))
    if (holders.length === 1) return reachable(holders[0])
    if (holders.length > 1) {
      throw new Error(
        `no thread \`${to}\` in this project, and ${holders.length} other projects have one ` +
        `(${holders.map((open) => `\`${projectSlugOf(open.project.id)}\``).join(", ")}). Pass \`--project <slug>\` to say which`,
      )
    }
    throw new Error(
      `no thread \`${to}\` in this project or any other open one. Pass the slug exactly as a thread link names ` +
      "it (`/thread/<slug>`), or the thread's full link, which names its project too",
    )
  }

  // THE FOLLOW-UP DELIVERY, shared by the operator's `followUp` and a worker's `steerThread` (one thread
  // messaging another): both are a message into a thread's next turn, and a second copy of this path
  // would be a second set of runtime branches to keep in step.
  function deliverFollowUp(sent: z.infer<typeof FollowUpInput>, opts: { release?: boolean } = {}): Promise<void> {
    // A character no provider can be handed (a control code, half of a surrogate pair) is taken out
    // HERE, before the ledger entry opens, and for every runtime. The Claude bridge removes it from the
    // worker's copy regardless; the ledger then has to hold the same words, because a delivery is
    // matched to its transcript record by text wherever no id survives, and a ledger entry that kept
    // the character would draw a second bubble beside the delivered one.
    //
    // EVERY SEND GETS A LEDGER ENTRY, opened before the un-park below. A caller that brought no
    // delivery id (a peer thread's `steerThread`; any follow-up that did not mint one) gets one minted
    // here and marked `silent` (delivery-ledger.ts): it draws no bubble, and a failure keeps nothing,
    // which is how such a send has always rendered. What it does buy is the board's reading of the
    // thread as a message on its way. Without it, a snoozed thread a peer messaged was un-parked as a
    // rest waiting on the human: the un-park's delta read needsYou=true for the ~40ms until the turn was
    // observed, which fired a "needs you" notification and dropped the snooze card before the message
    // landed (scripted broker stack, 2026-10-14). The id is a UUID because the broker hands it to the
    // SDK as the input's uuid, which is what retires the entry when the record lands.
    const silent = !sent.deliveryId
    const input = { ...sent, message: deliverableInputText(sent.message), deliveryId: sent.deliveryId ?? randomUUID() }
    return keepFailedFollowUp(input, { ...opts, silent }, async (openWriteAhead) => {
      // Every follow-up crosses a TYPED CONTROL CHANNEL now, never a terminal: a codex row goes to the
      // app-server bridge and a claude row to the session broker, each of which owns its own
      // steer-vs-start decision and reconnects or cold-resumes a dead session itself. Nothing types
      // into a provider TUI any more, so the capture-gated atomic paste-and-key this used to open with
      // — which existed only because Codex's TUI dropped Enter when it followed literal text in the
      // same instant — went with the transport that needed it.
      //
      // A follow-up DISABLES any snooze on this row — see wakeParkedThreadForFollowUp, which owns the
      // rule and the reasoning. Short version: re-parking after the turn you just asked for would hide
      // its own answer from the queue, so the later instruction ("now") wins over the earlier park.
      //
      // The row is bound to the CALLER's session id (origin/main's staleness guard): a stale tab must
      // not deliver a follow-up into a thread that has since been re-dispatched.
      // PROMOTION. Steering an EXTERNAL session — one of the human's own terminals, listed in the
      // rail's External band — is what turns it into a frizz thread (maintainer 2026-08-24). It runs
      // here, inside the follow-up, rather than behind a button of its own: one round trip, so the
      // message and the row it belongs to can never end up on opposite sides of a failure.
      //
      // Below `currentOwnedSession` because that guard is what an ORDINARY follow-up needs and this
      // is the case where it cannot yet pass — there is no row. `promoteExternalSession` returns
      // false for every ordinary send, so the guard still runs first for everything else.
      await promoteExternalSession(input.slug, input.sessionId)
      const row = currentOwnedSession(input.slug, input.sessionId)
      if (hasPendingPermissionChange(row)) {
        throw new Error("Wait for the current permission change to finish before sending a follow-up")
      }
      // The operator's "Restart worker" verb, enforced HERE and not only in the UI that offers it: a
      // stale tab holds a button whose preconditions may have expired since it rendered.
      //
      // Both refusals THROW rather than degrading to an ordinary follow-up, because a restart that
      // quietly becomes a plain message is the worst outcome — the operator believes their worker came
      // back on the new build when it is still the old process.
      if (input.freshProcess) {
        if (!(row?.backend === "claude" && row.claude_runtime === "broker")) {
          throw new Error("Only a broker-backed Claude worker can be restarted in place")
        }
        // Running sub-agents do NOT refuse this. They used to: the completion invariant says an agent
        // runs to its terminal return, and a restart kills the parent's in-memory children. But that
        // invariant binds frizz's OWN initiative — needsFreshProcessForLimit below still declines to
        // kill a live child when FRIZZ is the one deciding to restart — and `freshProcess` is not frizz
        // deciding, it is the operator instructing. Refusing it made the recovery verb unavailable in
        // precisely the state that motivates it: a worker wedged behind background work that will not
        // finish (maintainer 2026-08-01: "do not disable the button when there are sub-agents
        // running"). The children die; that is what the operator asked for and already knows.
      }
      // Every refusal above is a send that never started. From here on the server holds the text —
      // the write-ahead entry opens BEFORE the reopen and un-park below (the reopen's CAS can throw a
      // RetryableDeliveryError) and before any transport. A deliveryId already accounted for is a
      // replay: answer success and deliver nothing (see beginDelivery for which states count).
      if (!openWriteAhead()) return
      // Reopen an archived thread HERE, above the runtime branches, because only the LEGACY
      // fall-through reaches resumeThread (where this used to live alone). A broker-backed Claude row
      // and an app-server Codex row both return from their own branch below, so sending them a
      // follow-up used to resume the WORKER while leaving the ROW archived: the thread executed away
      // while the board read Done, and — an archived thread having no lifecycle verbs — offered no
      // Mark-as-done button to stop it. That is the state the "send a message to reopen it" readout
      // promises against, so it has to hold for every runtime. Raised 2026-07-31 against a live broker
      // thread ("showing up as done… but it is actually running actively").
      // THE GAP THE HUMAN LEFT, appended to what the worker receives — and to that ONLY. A worker has no
      // clock of its own, so an answer arriving after four hours is indistinguishable from one arriving
      // after four seconds; it will resume on a stale premise and re-run work whose result went cold.
      //
      // The BUBBLE and the delivery LEDGER keep the human's text untouched (see the `input.message`
      // uses below): what the human typed is what the board shows. Only the copy handed to the worker
      // carries the note, and the note names frizz as its author because the message it rides on is
      // not frizz's.
      // A message from another THREAD (`steerThread`) carries no such note: the gap it would measure is
      // the human's, and the receiver's next turn opens on the peer's words, not on a human returning.
      const gapNote = parseThreadMessage(input.message) ? undefined : humanGapNote(Date.now(), ctx.tailer.get(input.slug)?.lastAssistantAt)
      const messageForWorker = gapNote ? `${input.message}\n\n${gapNote}` : input.message
      if (row) reopenArchivedThreadForFollowUp(ctx, row)
      // Un-park HERE, above the runtime branches, for the same reason the reopen is here: a broker
      // Claude row and an app-server Codex row both return from their own branch below, so anything
      // that must hold for every runtime has to run before the split.
      if (row) wakeParkedThreadForFollowUp(ctx, row)
      // Every Codex follow-up flows through the app-server bridge — no terminal composer, no queue, no
      // stale-draft class. The bridge owns the steer-vs-start decision atomically and dedups on
      // deliveryId. A LEGACY Codex row (dispatched before the cutover) is migrated on its first
      // follow-up by adopting its rollout; from then on it is an ordinary app-server thread.
      // An ACP follow-up goes to the bridge, which delivers it now, queues it behind a running turn
      // (ACP has no steer), or re-opens the session first when the child is gone (a restart). The
      // ledger entry is `delivered` or `enqueued` accordingly; a fresh ACP session id is re-pinned.
      if (row?.backend === "acp") {
        const bridge = ctx.acpBridge
        if (!bridge) throw new Error("The ACP bridge is unavailable; cannot deliver this follow-up")
        const result = await bridge.followUp({
          threadSlug: input.slug, sessionId: row.session_id, cwd: ctx.project.dir,
          agentId: row.acp_agent ?? "", modelId: acpModelIdFromModel(row.model), acpSessionId: row.agent_session_id,
          text: messageForWorker, ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
        })
        if (result.acpSessionId !== row.agent_session_id) ctx.storage.setAgentSession(input.slug, result.acpSessionId)
        if (row.exited === 1) ctx.storage.setExitedIfCurrent(input.slug, row.session_id, row.runtime_generation ?? 0, false)
        if (input.deliveryId) {
          appendDelivery(ctx.storage, input.slug, { id: input.deliveryId, text: input.message, state: result.state === "queued" ? "enqueued" : "delivered" })
          ctx.transcriptChange.emit([input.slug])
        }
        ctx.board.refresh()
        return
      }
      if (row?.backend === "codex") {
        const bridge = ctx.codexAppServer
        if (!bridge) throw new Error("Codex app-server is unavailable; cannot deliver this follow-up")
        if (row.codex_runtime !== "app-server") {
          if (!row.agent_session_id) throw new Error("This legacy Codex thread has no resumable rollout id yet")
          await bridge.adoptExternalRollout({ threadSlug: input.slug, sessionId: row.session_id, codexThreadId: row.agent_session_id, cwd: ctx.project.dir })
          ctx.storage.setCodexRuntime(input.slug, "app-server")
        }
        const binding = bridge.binding(input.slug, row.session_id)
        // Writer-yield: if the rollout shows an in-flight turn the bridge does NOT hold (it has no
        // current turn of its own), someone is driving this thread in their own terminal via
        // `codex resume`. Frizz keeps MIRRORING that turn (the tailer follows the same rollout), but it
        // must not start/steer a second turn and race two writers. Yield until the external turn rests.
        // A turn the app-server opens on its own — a codex thread goal's continuation — is NOT this
        // case: the bridge adopts it from `turn/started` (codex-app-server.ts), so it holds a current
        // turn and the follow-up steers it like any other.
        //
        // "In flight" must mean the rollout is ACTUALLY ADVANCING, not merely that it stopped
        // mid-turn: a rollout frozen by a dead app-server looks identical to an external writer from
        // here, and yielding to it left the operator unable to answer their own stalled thread at all.
        // appServerTurnStalled tells the two apart — see board.ts.
        const stalled = appServerTurnStalled(
          bridge.turnLiveness(input.slug, row.session_id),
          ctx.tailer.get(input.slug)?.lastActivityAt,
          Date.now(),
        )
        const turnLive = ctx.tailer.get(input.slug)?.turn === "in-flight" && !stalled
        if (turnLive && (!binding || binding.currentTurnId === null)) {
          // Under 160 characters: sendEagerFollowUp toasts this after "Steer failed — " and cuts the rest.
          throw new Error("This thread is being driven outside Frizz. Wait for that turn to end, then resend.")
        }
        if (!binding || binding.state !== "active") {
          await bridge.resumeOwnedSession(input.slug, row.session_id)
        }
        await bridge.followUp({
          threadSlug: input.slug,
          sessionId: row.session_id,
          text: messageForWorker,
          deliveryId: input.deliveryId,
          model: row.model ?? undefined,
          effort: row.effort ?? undefined,
        })
        // Codex gets a ledger entry too — as SERVER TRUTH for the just-sent bubble, not as a delivery
        // guess: the bridge already dedups on deliveryId and its return IS the receipt. Without it the
        // ONLY thing rendering a just-sent codex steer is the client's optimistic bubble, and
        // mergeOptimistic's ghost floor retires that once the transcript advances 60s past it —
        // measured against frizz's own delivery records, 8 of 75 codex sends took longer than that to
        // appear in the rollout (steers at 71s, 212s and 4.6h), so the message could vanish from the
        // drawer entirely. The tailer drops the item the moment the rollout materialises the message.
        //
        // `delivered`, not `enqueued`: the receipt names the turn this message steered or STARTED, so
        // by the time followUp returns the model is already working on it — codex has no queue for it
        // to sit in. Rendering it gray for the rollout's whole materialization window (p50 3.3s,
        // tails past an hour) is exactly the "still looks enqueued while the agent is answering it"
        // report. `delivered` also never ages into the amber "no receipt" warning, which would be
        // meaningless on a thread whose transport acknowledges every send.
        if (input.deliveryId) {
          appendDelivery(ctx.storage, input.slug, { id: input.deliveryId, text: input.message, state: "delivered" })
          // The ledger is not JSONL bytes, so nothing else pushes a transcript frame for it — emit one
          // now so the bubble (and its un-grayed state) reaches subscribed tabs immediately instead of
          // riding the next byte-driven refresh.
          ctx.transcriptChange.emit([input.slug])
        }
        ctx.board.refresh()
        return
      }
      // Claude session-broker follow-up: a broker-backed claude row owns a DETACHED daemon, so its
      // follow-up is a message on that daemon's own control channel and nothing else can reach it.
      // Route through the bridge — it reconnects the live daemon's socket (context intact) or
      // cold-resumes a dead one. Branch on the ROW's runtime (not the flag): a row dispatched via the
      // broker must always be served via the broker. The worker system prompt is rebuilt so a cold
      // resume re-applies it (ignored when the daemon is still alive).
      if (row?.backend === "claude" && row.claude_runtime === "broker") {
        const bridge = ctx.claudeBroker
        if (!bridge) throw new Error("Claude session broker is unavailable; cannot deliver this follow-up")
        // Replay guard: `openWriteAhead` above already answered success for a deliveryId the ledger
        // accounts for. This branch once had no guard at all — a replayed deliveryId sent the message
        // a SECOND time — and it matters more now that the deliveryId IS the SDK input uuid: the SDK
        // rejects an id that is still outstanding, so a replay would surface as an error on the
        // operator's send instead of the no-op it should be.
        const appendSystemPrompt = claudeWorkerSystemPrompt(row.session_id, ctx.project.dir)
        // Is this thread MID-TURN right now? Sampled BEFORE the bridge call on purpose: a cold resume
        // takes seconds, and by the time it returns the turn this very message started reads as
        // in-flight — which would gray the one send that is provably being read. The tailer's `turn`
        // already folds in the runtime's own liveness. Unknown telemetry (a row not yet primed after a
        // server boot) defaults to mid-turn — the conservative direction, since the gray bubble is
        // honest for a queued send and merely late for a delivered one.
        //
        // …OR SOMETHING ELSE JUST OPENED THE TURN AND THE TRANSCRIPT HAS NOT SAID SO YET. The tailer reads
        // the turn off the JSONL, and for the tens of ms between an input being handed to the broker and
        // its record landing it still reads `idle`. A send that arrives in that gap — the human pressing
        // Send on a rested thread as a wake fires, or as another tab's send goes out — is queued by the
        // worker behind the turn the first input opened, yet it opened `delivered` here, and
        // projectDeliveryLedger un-grays a `delivered` send's bubble: for the whole of that turn the chat
        // drew a message the worker had not read as read, and placed it above the Working row, then moved
        // it under the reply at the handover (measured 2026-10-13, 11 of 12 scripted-broker recordings of
        // a send 10ms behind another). The bridge knows when it last took an input for this session, so
        // an input newer than anything the tailer has folded means this message has one ahead of it.
        // Bounded, so an input whose record never lands cannot gray every later send.
        const telemetry = ctx.tailer.get(input.slug)
        const inputAheadAt = bridge.lastInputAt?.(row.session_id)
        const foldedThroughMs = Date.parse(telemetry?.lastActivityAt ?? "")
        const inputAhead = inputAheadAt !== undefined
          && Date.now() - inputAheadAt < INPUT_AHEAD_MAX_MS
          && !(Number.isFinite(foldedThroughMs) && foldedThroughMs >= inputAheadAt)
        const midTurn = (telemetry?.turn ?? "in-flight") === "in-flight" || inputAhead
        // THE UPGRADE AT COMPACTION (claude-model-upgrade.ts): a thread that compacted on an edition its
        // family has since moved past takes this message in a fresh process, forked from the current pin.
        // Only at rest — the gate refuses a turn in flight, a sub-agent, a shell, an approval or an
        // undelivered send, so a steer never restarts anything.
        const upgradeCandidate = claudeUpgradeCandidate({ stateDir: ctx.project.stateDir, projectId: ctx.project.id, storage: ctx.storage, telemetry: ctx.tailer.get(input.slug) }, row)
        const upgrade = upgradeCandidate
          ? claudeModelUpgradeDue(upgradeCandidate, { catalogue: peekClaudeModels(), nowMs: Date.now(), serverStartedAtMs: SERVER_STARTED_AT_MS })
          : undefined
        if (upgrade?.due) frizzLog.info("server", `${input.slug}: compacted on ${upgrade.from}; this follow-up starts a fresh worker on ${upgrade.to}`)
        await bridge.followUp({
          threadSlug: input.slug,
          sessionId: row.session_id,
          cwd: ctx.project.dir,
          text: messageForWorker,
          // A PERSON'S message says so to the runtime, which is what lets "send now" move a running call
          // aside for it instead of aborting the turn (see the interrupt below). Everything this route
          // carries is the operator's own typing except a peer thread's message — the same line the gap
          // note above is drawn on.
          human: !parseThreadMessage(input.message),
          // Rides through to the SDK as this input's uuid, which the SDK echoes back on the record
          // that delivers it — the ledger then correlates by identity rather than by text.
          deliveryId: input.deliveryId,
          // A persisted per-thread mode, or the dispatch floor for a row that has none — see
          // coldResumePermission for why a legacy row must not fall through to the bridge's `"default"`.
          permissionMode: coldResumePermission(row, ctx.getSettings()),
          appendSystemPrompt,
          model: row.model ?? undefined,
          effort: row.effort ?? undefined,
          // The pause card's "Continue now" is the same act as the scheduler's auto-resume, so it
          // needs the same treatment: while the process is still latched on its own 429, delivering
          // into it does nothing at all. Restart it instead — otherwise the button is a no-op and
          // reads as frizz having ignored the click.
          //
          // `input.freshProcess` is the operator asking for it OUTRIGHT (the "Restart worker" verb),
          // which the server cannot derive: only the human knows they want the worker back on a newer
          // build. It is OR'd in rather than replacing the derivation, so a restart clicked on a
          // limit-latched thread still behaves. The live-sub-agent refusal above applies to both.
          freshProcess: input.freshProcess === true || upgrade?.due === true || needsFreshProcessForLimit(
            ctx.tailer.get(input.slug)?.limitFault,
            Date.now(),
            mayHaveLiveBackgroundWork(ctx.tailer.get(input.slug)),
          ),
        })
        // `exited` records a deliberate stop (a dismiss, a retire, a hibernation). The bridge just
        // accepted this send — it reconnected the live daemon or cold-resumed a dead one — so the stop
        // is over, and the column has to say so. Nothing cleared it before: `beginRuntimeGeneration`
        // is the only other writer of `exited = 0` and no path calls it, so a thread resumed by a
        // follow-up kept `exited = 1` for as long as it then ran (four of them on 2026-09-03, each
        // hours into a resumed task). The board derives a broker row's liveness live and never
        // showed it, but every direct reader of the row — the CLI, a diagnostic, the next
        // engineer — believed the column. Same CAS as every other row write: a replaced owner
        // observes zero changes.
        if (row.exited === 1) ctx.storage.setExitedIfCurrent(input.slug, row.session_id, row.runtime_generation ?? 0, false)
        // The ledger's RELIABILITY half died with the terminal transport — the stuck-composer flush and
        // the screen-inspected receipt were the only things it bought, and both were skipped for a
        // headless row even then; no delivery marker is stamped either, because nothing rewrites bytes
        // on the way to the SDK. But its RENDERING half applies here exactly as it does to codex:
        // until the JSONL carries the message, the only thing showing the human their own just-sent
        // steer is the client's optimistic bubble, and mergeOptimistic's ghost floor retires that once
        // the transcript advances 60s past it. So the write-ahead entry settles here into a receipted
        // state; the SDK call returning IS the receipt, which also keeps it out of the amber "no receipt" state that would be meaningless
        // on a thread whose transport acknowledges every send. The tailer drops it as soon as the
        // record lands.
        //
        // WHICH state depends on whether anything was ahead of it. Mid-turn, the SDK genuinely queues
        // the message until the next sampling boundary — that is what the gray bubble is FOR, so it
        // opens `enqueued`. With no turn in flight (a rested thread, above all one whose hibernated
        // daemon this send just cold-resumed) the message is what STARTS the next turn, and graying
        // it renders the one send the agent is provably reading as "still enqueued" for the whole
        // resume-and-first-record window (~3s on a small session, longer on a big one). It opens
        // `delivered` and renders as an ordinary bubble — which also keeps the daemon-death retire
        // sweeps from dropping it mid-cold-resume, a race that made a just-sent message vanish from
        // the chat for the resume's whole duration (observed live: rendered at +0.2s, gone from
        // +0.3s to +2.3s, back at +2.3s). A `freshProcess` restart is delivered by the same logic:
        // the old process's turn died with it and this message opens the new one's first turn.
        // A restart RETIRED the process every earlier outstanding send was handed to, so those sends
        // are dead and their queued bubbles are now claims about a process that no longer exists.
        // Clear them here, BEFORE this restart's own entry is opened, so the continuation is the only
        // thing left queued. Without this they linger the rest of the hour and cannot be dismissed by
        // hand — the unqueue click asks the NEW daemon about a uuid it never heard of and answers
        // "Too late — that message has already left the queue", which is exactly backwards.
        if (input.freshProcess) retireOutstandingDeliveries(ctx.storage, input.slug)
        // "SEND NOW" (⌘⏎): the worker reads this NOW rather than when whatever it is doing ends.
        // Strictly AFTER the delivery above, and that order is the whole mechanism — the runtime is
        // asked to push a WAITING message through, and asked with nothing waiting it does nothing.
        //
        // What it does to the work in flight (bridge.interruptTurn has the detail): a running Bash or
        // Agent call is moved to the background and keeps going, and the turn takes the message in on
        // the spot. Only when nothing can be moved — the model is mid-answer, or a wake Frizz wrote is
        // waiting too — is the turn aborted, which is all this did until 2026-10-13: the queued message
        // then opens the next turn.
        //
        // Measured live against a real tool call in flight: 94.4s to be read without it and seconds
        // with it, either way (_live_broker_interrupt_send.mts for the abort; _live_broker_send_now.mts
        // for the move, where the 45s build the message arrived under also finished, once, on time).
        //
        // AN ABORT CAN END BACKGROUND SUB-AGENTS, and the runtime tells the worker nothing
        // (interrupt-ended.ts). Snapshot the running children BEFORE the frame goes out, so the note can
        // name exactly the ones the tailer then sees end — fire-and-forget, after the send succeeded. A
        // send-now that moved the call aside ends none, and the note then has nothing to say.
        const childrenBefore = input.interrupt === true ? runningSubAgentsOf(ctx.tailer.get(input.slug)) : []
        const preempted = input.interrupt === true && bridge.interruptTurn({ threadSlug: input.slug, sessionId: row.session_id, deliveryId: input.deliveryId })
        if (preempted) {
          void noteSubAgentsEndedByInterrupt(
            { tailer: ctx.tailer, storage: ctx.storage, log: (line) => frizzLog.info("interrupt", line) },
            { slug: input.slug, sessionId: row.session_id, before: childrenBefore, interruptedAtMs: Date.now() },
          )
        }
        if (input.deliveryId) {
          appendDelivery(ctx.storage, input.slug, {
            id: input.deliveryId,
            text: input.message,
            state: midTurn && input.freshProcess !== true ? "enqueued" : "delivered",
          })
        }
        // A landed send-now frees the WHOLE queue — the turn takes it in, or the next turn opens on it —
        // so nothing outstanding is still waiting to be read, this send included. Flipping it here
        // rather than in the `state` above is what covers the sends already queued AHEAD of this one,
        // which the same send-now also delivers.
        if (preempted) deliverOutstandingDeliveries(ctx.storage, input.slug)
        // The ledger is not JSONL bytes, so nothing else pushes a transcript frame for it — emit one
        // now so the bubble (gray or delivered) reaches subscribed tabs immediately instead of
        // riding the next byte-driven refresh.
        if (input.deliveryId || preempted) ctx.transcriptChange.emit([input.slug])
        ctx.board.refresh()
        return
      }
      // Idempotency for a REPLAYED deliveryId is `openWriteAhead` above: an accepted send answers
      // success and injects nothing.
      //
      // What actually guarantees the retry loop cannot double-send is the CLASSIFICATION, not that
      // check: the client only replays an error typed RetryableDeliveryError, and every such throw is
      // raised strictly upstream of the first write to the worker, so a replayed send never had a first
      // copy to duplicate — which is also the only reason beginDelivery lets a `retryable` entry be
      // re-opened under the same id. A throw misclassified as retryable AFTER an injection would
      // therefore double-send on the replay. Keeping every retryable throw pre-injection is
      // load-bearing, not optional.
      // The LEGACY fall-through: a claude row that is not broker-backed, i.e. one dispatched before the
      // cutover. The deliveryId rides along because the old terminal transport stamped each send with
      // an invisible marker (delivery-marker.ts) — that is what let the tailer confirm delivery by
      // IDENTITY instead of by comparing prose a paste channel was free to rewrite. Codex never takes
      // this path, and frizz has no transport left for the rows that do: resumeThread refuses every one
      // of them by design (see resume.ts), so this is a loud backstop, not a delivery.
      resumeThread({ project: ctx.project, storage: ctx.storage, board: ctx.board, getSettings: ctx.getSettings, backendFor: ctx.backendFor }, input.slug, messageForWorker,
        input.deliveryId && row?.backend !== "codex" ? input.deliveryId : undefined,
        // "Continue now" on a limit-paused legacy thread relaunches it, for the same reason the broker
        // branch above swaps its process: the running one is not listening.
        {
          freshProcess: needsFreshProcessForLimit(
            ctx.tailer.get(input.slug)?.limitFault,
            Date.now(),
            mayHaveLiveBackgroundWork(ctx.tailer.get(input.slug)),
          ),
        })
      // Injection accepted → open a delivery-ledger entry (Claude rows only; Codex has its own durable
      // queue above). From here the send is a tracked state machine: the tailer correlates the JSONL
      // evidence and the transcript projection renders the queued bubble as SERVER truth — reload-safe,
      // consumed by the client's optimistic copy via this deliveryId instead of by text match.
      if (input.deliveryId && row?.backend !== "codex") {
        appendDelivery(ctx.storage, input.slug, { id: input.deliveryId, text: input.message })
      }
      ctx.board.refresh()
    })
  }

  // THE SERVER OWNS A STEER'S TEXT FROM THE MOMENT IT ARRIVES (delivery-ledger.ts, "WRITE-AHEAD").
  //
  // `deliver` runs the whole follow-up. Once its guards have passed it calls `open()`, which writes the
  // `sending` entry BEFORE any transport is touched and answers false for a deliveryId that is already
  // accounted for (the replay no-op every branch used to spell as its own `hasDelivery` check). From
  // then on a throw can no longer take the words with it: the entry turns `failed` with the error, and
  // the error is tagged `deliveryKept` so the client knows the server has them and does not ALSO push
  // them back into the prompt box — whose draft, sessionStorage at the time, is exactly the copy a
  // browser restart destroyed (2026-09-30: a ~4,000-character dictated steer, lost when a cold resume
  // threw and Chrome then restarted). The draft is localStorage since 2026-10-11 and survives that
  // restart, but it is still one browser's copy; the server's is the one every device can reach.
  //
  // A throw BEFORE `open()` — a stale session, a pending permission change, a refused restart — leaves
  // nothing on the server. Those are clean refusals of a send that never started, and the client hands
  // the text back to the prompt box as it always has.
  async function keepFailedFollowUp(
    input: z.infer<typeof FollowUpInput>,
    opts: { release?: boolean; silent?: boolean },
    deliver: (open: () => boolean) => Promise<void>,
  ): Promise<void> {
    let opened = false
    const open = (): boolean => {
      if (!input.deliveryId) return true
      if (beginDelivery(ctx.storage, input.slug, { id: input.deliveryId, text: input.message, supersedes: input.supersedes, release: opts.release, silent: opts.silent }) === "duplicate") return false
      opened = true
      // The ledger is not JSONL bytes: push the frame now, so the server's own bubble (and the removal
      // of a superseded failed one) reaches every tab before the transport is even called.
      ctx.transcriptChange.emit([input.slug])
      return true
    }
    try {
      await deliver(open)
    } catch (error) {
      // A silent send keeps nothing here: its words stay with the caller, whose call this throw fails
      // (DeliveryLedgerItem.silent). Its entry only ever stood for "a message is on its way".
      if (opened && input.deliveryId && opts.silent) {
        forgetDelivery(ctx.storage, input.slug, input.deliveryId)
        ctx.board.refresh()
        throw error
      }
      if (opened && input.deliveryId) {
        const retryable = (error as { retryableDelivery?: unknown } | null)?.retryableDelivery === true
        const message = error instanceof Error ? error.message : String(error)
        if (recordDeliveryFailure(ctx.storage, input.slug, input.deliveryId, { error: message, retryable })) {
          frizzLog.warn("server", `${input.slug}: follow-up ${input.deliveryId} failed and is kept for the operator: ${message}`)
          ctx.transcriptChange.emit([input.slug])
          ctx.board.refresh()
          if (error && typeof error === "object") Object.defineProperty(error, "deliveryKept", { value: true, enumerable: false })
        }
      }
      throw error
    }
  }

  // SETTLE REGISTERED ANSWERS — the row write `answerQuestions` and the prompt box's Send share. Returns
  // what was stored for each question that was still open, in the order given; a question that was
  // already settled (a second tab, a replay) contributes nothing.
  //
  // A SECRET'S VALUE STOPS HERE. It is served once, from memory, through its pipe (secret-files.ts), and
  // the row — which the settled card, the in-flight card and the worker's message all read — keeps only
  // the path. Nothing below this ever holds the value. A blank one answers nothing: the request stays
  // open rather than handing the worker an empty read.
  //
  // `delivered` says the CALLER is delivering these itself, in the same call (the follow-up path), so
  // the scheduler's answer wake must not also carry them.
  //
  // WHAT COMES BACK IS NAMED; WHAT IS STORED IS NOT. Each returned answer carries the id its question
  // was asked under (shared nameQuestionAnswer), so the message the follow-up path composes from it
  // names the question exactly as the scheduler's wake would. The row keeps the answer as the browser
  // sent it: the id is read off the row whenever a message is composed, and never from the request.
  function settleQuestionAnswers(slug: string, answers: readonly QuestionAnswer[], now: number, opts: { delivered?: boolean } = {}): NamedQuestionAnswer[] {
    const settled: NamedQuestionAnswer[] = []
    for (const answer of answers) {
      // Scoped by reading the row first: an id belonging to another thread answers nothing here.
      const q = ctx.storage.getThreadQuestion(answer.questionId)
      if (!q || q.thread_slug !== slug || q.state !== "open") continue
      let stored = answer
      const spec = parseQuestionSpec(q.spec)
      if (spec?.secret) {
        const value = answer.text?.trim() ?? ""
        if (!value) continue
        const path = serveSecret(ctx.project.stateDir, slug, q.id, value)
        stored = { questionId: answer.questionId, question: answer.question, chosen: [], text: secretAnswerText(path) }
      }
      if (!ctx.storage.answerThreadQuestion(answer.questionId, JSON.stringify(stored), now)) continue
      if (opts.delivered) ctx.storage.markSettlementDelivered(answer.questionId)
      settled.push(nameQuestionAnswer(stored, spec, q.handle))
    }
    return settled
  }

  // THE PROMPT BOX'S ONE SEND (maintainer 2026-10-11). Three things the operator's follow-up can now be,
  // all of which end in the same deliverFollowUp:
  //
  //  • WITH ANSWERS — the staged answers to registered questions travel in this message. They are
  //    settled first and composed above the typed text, so the worker reads one turn: what was asked,
  //    what was answered, and the note that came with it.
  //  • TO THE QUEUE (`hold`) — mid-turn, the message is written to the ledger as `held` and nothing is
  //    handed to any transport; releaseHeldFollowUps delivers it when the thread rests. At rest there is
  //    nothing to wait for and it is an ordinary send.
  //  • neither — exactly the follow-up it always was.
  //
  // A REPLAY of the same deliveryId must deliver the SAME words, and by then the questions are settled
  // and would compose to nothing. The ledger entry the first attempt opened holds the composed text, so
  // a replay reads it from there instead of composing again.
  async function sendFollowUp(input: z.infer<typeof FollowUpInput>): Promise<void> {
    const answers = input.answers ?? []
    let message = input.message
    const replay = input.deliveryId ? deliveryItem(ctx.storage, input.slug, input.deliveryId) : null
    if (replay) {
      message = replay.text
      // A held entry is already where a replayed "Send to queue" wanted it.
      if (replay.state === "held") return
    } else if (answers.length > 0) {
      // The refusals deliverFollowUp opens with, run BEFORE the rows are settled: a send it would refuse
      // must not leave the questions answered with nothing on its way to the worker.
      const row = currentOwnedSession(input.slug, input.sessionId)
      if (hasPendingPermissionChange(row)) {
        throw new Error("Wait for the current permission change to finish before sending a follow-up")
      }
      const settled = settleQuestionAnswers(input.slug, answers, Date.now(), { delivered: true })
      if (settled.length > 0) {
        message = withAnswersNote(questionAnswerMessage(settled), input.message)
        ctx.board.refresh()
      }
    }
    // Before the emptiness check and before the hold below, which writes its own ledger entry: see
    // deliverFollowUp for why the ledger holds the cleaned words.
    message = deliverableInputText(message)
    // Nothing typed and every question already settled elsewhere (a second tab beat this one): the
    // answers are with the worker, and there is nothing left to say.
    if (!message.trim()) {
      if (answers.length > 0) return
      throw new Error("There is nothing to send")
    }
    const send: z.infer<typeof FollowUpInput> = { ...input, message, answers: undefined, hold: undefined }
    if (input.hold && !input.interrupt && !input.freshProcess && !replay) {
      const row = ctx.storage.getSession(input.slug)
      // Only something the server can SEE is worth waiting behind: a turn the tailer reads as running,
      // messages already held (the queue is FIFO, so a send must not overtake them on a rest), or a send
      // whose turn has not ended (the queue goes out one turn at a time). Unknown telemetry sends now: a
      // message delivered early is a steer, a message held for a rest that never registers is lost time.
      const inFlight = ctx.tailer.get(input.slug)?.turn === "in-flight"
      const items = row ? parseDeliveryLedger(row.delivery_ledger) : []
      if (row && row.session_id === input.sessionId && (inFlight || heldSendMustWait(items))) {
        const id = input.deliveryId ?? randomUUID()
        if (holdDelivery(ctx.storage, input.slug, { id, text: message })) {
          watchHeld(input.slug)
          ctx.transcriptChange.emit([input.slug])
          ctx.board.refresh()
          // At rest, whatever it waits behind may already be clear: ask now rather than at the next sweep.
          if (!inFlight) setTimeout(() => void releaseHeldFollowUps(input.slug), 0).unref?.()
          return
        }
      }
    }
    return deliverFollowUp(send)
  }

  // RELEASE WHAT FRIZZ IS HOLDING FOR THIS THREAD'S REST, oldest first, through the ordinary follow-up
  // path and under each message's own id — so the gray bubble the operator has been looking at is the
  // one that becomes the delivered message. ONE per rest: the oldest opens the next turn, and the one
  // after it waits until that turn has ended, so each message sent to the queue is a turn of its own
  // (nextHeldRelease, which also says how "ended" is read).
  //
  // `force` is the operator's "send now" on a held bubble: the turn is still running and they want it
  // read anyway, so it goes in as the steer it would have been. It too hands over the next message, not
  // the whole queue.
  //
  // A release that throws leaves that message `failed` with its words kept (keepFailedFollowUp), which
  // is the same Retry / Edit / Dismiss the operator gets for any send that did not land.
  const releasingHeld = new Set<string>()
  async function releaseHeldFollowUps(slug: string, opts: { force?: boolean } = {}): Promise<number> {
    if (releasingHeld.has(slug)) return 0
    const row = ctx.storage.getSession(slug)
    if (!row) { heldSlugs.delete(slug); return 0 }
    const items = parseDeliveryLedger(row.delivery_ledger)
    if (!items.some((item) => item.state === "held")) { heldSlugs.delete(slug); return 0 }
    if (!opts.force && ctx.tailer.get(slug)?.turn === "in-flight") return 0
    if (hasPendingPermissionChange(row)) return 0 // the sweep comes back for it
    const item = nextHeldRelease(items, { force: opts.force })
    if (!item) return 0 // the turn ahead of it is not over yet
    releasingHeld.add(slug)
    try {
      await deliverFollowUp({ slug, sessionId: row.session_id, message: item.text, deliveryId: item.id }, { release: true })
      return 1
    } catch (error) {
      frizzLog.warn("server", `${slug}: releasing held follow-up ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      return 0
    } finally {
      releasingHeld.delete(slug)
    }
  }

  // WHEN a held message is released. The tailer's in-flight → idle edge is the moment the operator
  // asked for, and it is published on the bus as the turn-done notification — deferred one macrotask
  // here because the tailer publishes it BEFORE it writes the new turn state the release reads.
  //
  // The edge alone is not enough: a server restart during the hold comes back to a thread that may
  // already be at rest, with no edge left to fire. So every thread with something held is also swept
  // on a slow clock — seeded from the rows at boot, and running only while anything is held.
  const heldSlugs = new Set<string>()
  let heldSweep: ReturnType<typeof setInterval> | null = null
  const HELD_SWEEP_MS = 5_000
  function watchHeld(slug: string): void {
    heldSlugs.add(slug)
    if (heldSweep) return
    heldSweep = setInterval(() => {
      for (const held of [...heldSlugs]) void releaseHeldFollowUps(held)
      if (heldSlugs.size === 0 && heldSweep) { clearInterval(heldSweep); heldSweep = null }
    }, HELD_SWEEP_MS)
    heldSweep.unref?.()
  }
  // createRouter reads its context lazily everywhere else, and a focused test harness builds a partial
  // one; this is its only eager read, so it tolerates these two pieces being absent or inert (app.test.ts
  // hands in a stub whose every method answers nothing).
  const bootRows: unknown = typeof ctx.storage?.allSessions === "function" ? ctx.storage.allSessions() : null
  for (const row of Array.isArray(bootRows) ? (bootRows as ReturnType<typeof ctx.storage.allSessions>) : []) {
    if (row.delivery_ledger?.includes('"held"') && heldDeliveries(ctx.storage, row.slug).length > 0) watchHeld(row.slug)
  }
  ctx.bus?.subscribe((event) => {
    if (event.type !== "notify" || event.kind !== "turn-done" || !heldSlugs.has(event.slug)) return
    setTimeout(() => void releaseHeldFollowUps(event.slug), 0).unref?.()
  })

  // The two checks both recurring-prompt writers owe, shared so the operator's path and the worker's
  // can never disagree about what a valid arming is.
  //
  // A cadence is required when — and only when — the HEARTBEAT is on: a schedule nobody chose is
  // exactly the ambiguity the minutes field exists to remove, while a prompt that only fires on rest has
  // no cadence to name. Arming an ARCHIVED thread is refused, but only when a mechanism is actually on;
  // clearing one, or parking the text with both mechanisms off, stays allowed on a shelved thread.
  interface RecurringPromptWrite {
    prompt: string | null
    stopHook: boolean
    heartbeat: boolean
    postCompaction: boolean
    intervalSeconds?: number
  }
  function assertRecurringPromptArmable(
    input: RecurringPromptWrite,
    row: Pick<SessionRow, "state" | "archived">,
  ): void {
    if (input.prompt === null) return
    if (input.heartbeat && input.intervalSeconds === undefined) {
      throw new Error("`intervalSeconds` is required when the heartbeat is on")
    }
    if ((input.stopHook || input.heartbeat || input.postCompaction) && (row.state === "archived" || row.archived === 1)) {
      throw new Error("Reopen this thread before arming a recurring prompt")
    }
  }
  // The stored cadence. Dropped when the prompt is cleared, and KEPT when only the heartbeat is off —
  // the panel has to read back the interval that switching it on again would use.
  function recurringIntervalMs(input: RecurringPromptWrite): number | null {
    if (input.prompt === null || input.intervalSeconds === undefined) return null
    return input.intervalSeconds * 1000
  }

  // A thread's ARMED one-off timers, in the shape the worker's tool reads back. Instants are epoch ms in
  // the table and ISO on the wire, converted here so the row, the delivered trailer and the tool's own
  // output all name the same string.
  // A thread's ARMED PR watchers, in the shape the worker's tool and the board both read. Each carries
  // the PR's last-polled checks/mergeability, so the tool's read-back and the resting card's row cannot
  // disagree about the same PR — they are one projection of one book.
  /** One command watch as the worker reads it back. Its last check rides along, because "armed, 14 checks,
   *  last one exited 127" is the difference between a wait that is healthy and one that never will pass. */
  function commandWatchView(w: CommandWatchRow): CommandWatchView {
    return {
      id: w.id,
      command: w.command,
      every: formatCommandWatchDuration(w.every_ms),
      state: w.state,
      createdAt: new Date(w.created_at).toISOString(),
      expiresAt: new Date(w.expires_at).toISOString(),
      runs: w.runs,
      ...(w.last_run_at !== null && w.last_outcome
        ? { lastRun: { at: new Date(w.last_run_at).toISOString(), outcome: w.last_outcome, exitCode: w.last_exit, output: w.last_output ?? "" } }
        : {}),
    }
  }
  function armedCommandWatchViews(slug: string): CommandWatchView[] {
    return ctx.storage.listCommandWatches(slug, { armedOnly: true }).map(commandWatchView)
  }

  function armedPrWatchViews(slug: string): PrWatchView[] {
    const github = readGithubStatusBook(ctx.storage.getSetting(GITHUB_STATUS_SETTING))
    const issues = readGithubIssueStatusBook(ctx.storage.getSetting(GITHUB_ISSUE_STATUS_SETTING))
    return ctx.storage.listPrWatches(slug, { armedOnly: true }).map((w) => {
      const target = `${w.owner}/${w.repo}#${w.number}`
      const kind = w.kind === "issue" ? "issue" as const : "pull" as const
      return {
        id: w.id,
        target,
        kind,
        state: w.state,
        createdAt: new Date(w.created_at).toISOString(),
        ...(kind === "pull" && github[target] ? { github: github[target] } : {}),
        ...(kind === "issue" && issues[target] ? { issue: issues[target] } : {}),
      }
    })
  }

  // A thread's ARMED watches on its own running work, in the shape `watch`/`unwatch` read back.
  //
  // The LABEL is re-resolved from live telemetry on every read rather than stored beside the row. A
  // stored label would be a copy of a name the runtime owns, and it would go stale the moment the op
  // it names ends — leaving a read-back that confidently names work that is over. Re-resolving means
  // the label is either current or absent, and absent is the honest answer.
  // A stored question's spec, or undefined when the row predates a schema change or was written by
  // hand. Undefined is rendered as "unreadable" rather than thrown: one bad row must not blank a card
  // carrying three good ones.
  function parseQuestionSpec(spec: string): AskedQuestion | undefined {
    try {
      const parsed = AskedQuestionSchema.safeParse(JSON.parse(spec))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  // One answer as the audit trail records it (audit.ts): what was chosen and typed, as digests. A
  // SECRET's value is not recorded at all, not even hashed — a short credential's SHA-256 would only
  // hand whoever reads the log something to brute-force.
  function answerDigest(slug: string, answer: AnswerQuestionsInput["answers"][number]): Record<string, unknown> {
    const q = ctx.storage.getThreadQuestion(answer.questionId)
    if (q?.thread_slug === slug && parseQuestionSpec(q.spec)?.secret) return { questionId: answer.questionId, secret: true }
    return {
      questionId: answer.questionId,
      ...(answer.chosen.length > 0 ? { chosen: textDigest(answer.chosen.join("\n")) } : {}),
      ...(answer.text ? { text: textDigest(answer.text) } : {}),
      ...(answer.followUps?.length ? { followUps: answer.followUps.length } : {}),
    }
  }

  function parseStoredAnswer(raw: string | null): SettledQuestionView["answer"] | undefined {
    if (!raw) return undefined
    try {
      const parsed = QuestionAnswerSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  /** Bring this thread's ```question fences up to date BEFORE a call that reads its questions. The
   *  registrar normally runs on the tailer's next poll, which can be a second behind a worker that wrote a
   *  fence and then, in the same message, ran `frizzctl done` or `frizzctl unask` — the gate would judge a
   *  question set the worker has already changed. So read the transcript now and register what it holds. */
  function catchUpQuestionFences(slug: string): void {
    const row = ctx.storage.getSession(slug)
    if (!row) return
    try {
      ctx.tailer.tick()
    } catch {
      // the tailer reports its own tick failures; the registrar still reads whatever it already folded
    }
    syncQuestionFences(ctx.storage, {
      slug,
      spawnedAt: row.spawned_at,
      sightings: ctx.tailer.get(slug)?.questionSightings,
      autonomousGoal: autonomousGoal(row),
      faultBook: ctx.questionFaults,
    })
  }

  /** A question by the id the worker knows it by: its own fence id (a follow-up's resolves to the root it
   *  rides in), or the `qst_…` an `ask` minted. */
  function findOwnQuestion(slug: string, id: string): ThreadQuestionRow | undefined {
    const want = id.trim().toLowerCase()
    return ctx.storage.listThreadQuestions(slug).find((q) => {
      if (q.id.toLowerCase() === want || q.handle?.toLowerCase() === want) return true
      const spec = parseQuestionSpec(q.spec)
      return spec ? questionHandles(spec).some((h) => h.toLowerCase() === want) : false
    })
  }

  // This thread's OPEN questions, in the shape the worker's read-back, the board and the card all use.
  function openQuestionViews(slug: string): RegisteredQuestionView[] {
    const out: RegisteredQuestionView[] = []
    for (const q of ctx.storage.listThreadQuestions(slug, { openOnly: true })) {
      const spec = parseQuestionSpec(q.spec)
      if (!spec) continue
      out.push(questionView(slug, q.id, spec, q.asked_at))
    }
    return out
  }

  function questionView(slug: string, id: string, spec: AskedQuestion, askedAtMs: number): RegisteredQuestionView {
    return {
      id,
      ...(spec.handle ? { handle: spec.handle } : {}),
      spec,
      askedAt: new Date(askedAtMs).toISOString(),
      ...(spec.secret ? { secretPath: secretFilePath(ctx.project.stateDir, slug, id) } : {}),
    }
  }

  /** Arming a Goal is the human (or the worker) saying "decide the rest yourself", so anything still
   *  waiting on an answer is now the worker's to settle. Dismissing them here rather than leaving them
   *  on the board is what stops a thread from being autonomous and blocked at the same time — a card
   *  nobody will answer, on a thread nobody is watching.
   *
   *  A DANGER-TAGGED QUESTION SURVIVES IT, exactly as it survives the human's x. Autonomy is consent to
   *  decide ordinary things; it is not consent to a force-push. `dismissThreadQuestion` is reached
   *  through the same path the x uses, so the rule lives in one place.
   *
   *  Returns how many were cancelled, so the caller can say so. */
  function cancelQuestionsForAutonomy(slug: string): number {
    const now = Date.now()
    let cancelled = 0
    for (const q of ctx.storage.listThreadQuestions(slug, { openOnly: true })) {
      const spec = parseQuestionSpec(q.spec)
      // A SECRET REQUEST SURVIVES IT TOO, for a plainer reason: there is nothing to decide. The worker
      // cannot invent a one-time code, so cancelling the request strands the work it was for.
      if (spec?.danger || spec?.secret) continue
      if (ctx.storage.dismissThreadQuestion(q.id, now)) cancelled++
    }
    return cancelled
  }

  /** Is this thread running AUTONOMOUSLY — told to keep going and decide for itself?
   *
   *  IT IS THE ARMED GOAL, and there is no separate switch. There WAS one: a `recurring_pause_on_questions`
   *  column shown in the footer as "Autonomous mode", deleted 2026-08-16 because arming a Goal already IS
   *  that consent (maintainer: "If somebody enables the stop hook goal, then that kind of implies to me
   *  that they don't really want to answer any more questions"). Collecting it twice only bought a way to
   *  get it wrong, and plans/rest-by-registration.md keeps that shape — one control, the prompt as its
   *  payload — rather than restoring the switch.
   *
   *  THE REST TRIGGER SPECIFICALLY, not any armed prompt. Its whole semantic is "you stopped — is there
   *  more?", which is the sentence that makes a worker keep going on its own. A heartbeat says "it has
   *  been an hour" and a compaction prompt says "here is what you forgot"; neither tells anybody to
   *  decide anything, so neither should silence a question. */
  function autonomousGoal(row: SessionRow): string | undefined {
    if (row.recurring_on_rest !== 1) return undefined
    const prompt = row.recurring_prompt?.trim()
    return prompt ? prompt : undefined
  }

  function armedOwnWatchViews(slug: string): OwnWatchView[] {
    const tele = ctx.tailer.get(slug)
    return ctx.storage.listThreadWatches(slug, { armedOnly: true }).map((w) => {
      const live = resolveLiveWatchTarget(tele, w.target)
      return {
        id: w.id,
        kind: w.kind,
        target: w.target,
        ...(live?.label ? { label: live.label } : {}),
        createdAt: new Date(w.created_at).toISOString(),
        expiresAt: new Date(w.expires_at).toISOString(),
      }
    })
  }

  function armedTimerViews(slug: string): ThreadTimerView[] {
    return ctx.storage.listThreadTimers(slug, { armedOnly: true }).map((t) => ({
      id: t.id,
      prompt: t.prompt,
      fireAt: new Date(t.fire_at).toISOString(),
      state: t.state,
      createdAt: new Date(t.created_at).toISOString(),
    }))
  }

  // Fold ONE superseded single-trigger worker write onto the merged recurring-prompt row, PRESERVING the
  // trigger it does not own. The old stop hook and heartbeat were independent features, so a worker still
  // driving the old tools has to be able to arm or stop either one without silently disarming the other —
  // and it cannot see the merged row to know it is doing so. The single shared TEXT is the one thing the
  // merge cannot preserve: whichever legacy call last supplied words wins. That is the documented cost of
  // collapsing two texts into one, not a defect of this alias.
  function applyLegacyWorkerTrigger(
    slug: string,
    trigger: "rest" | "schedule",
    write: { prompt: string | null; enabled: boolean; intervalSeconds?: number },
  ): void {
    const row = ctx.storage.getSession(slug)
    if (!row) throw new Error(`thread ${slug} is not registered`)

    const otherOn = trigger === "rest" ? row.recurring_on_schedule === 1 : row.recurring_on_rest === 1
    // The post-compaction trigger is preserved verbatim across a legacy write. These aliases exist for
    // workers running the PRE-MERGE two-feature tools, which predate SOURCE 7 entirely — such a call
    // cannot have an opinion about a trigger it has never heard of, so it must not switch one off.
    const compactOn = row.recurring_on_compact === 1
    // The cadence the row already carries, in the seconds the shared validator speaks. Read back even
    // while the HEARTBEAT is off, because arming the stop hook must not drop the interval the panel
    // needs to switch the heartbeat back on.
    const storedSeconds = row.recurring_interval_ms ? Math.round(row.recurring_interval_ms / 1000) : undefined
    const on = write.enabled && write.prompt !== null

    // Keep the parked text when this mechanism goes off but the other is still armed: clearing the row
    // there would disarm a mechanism this call never mentioned.
    const prompt = on ? write.prompt : otherOn || compactOn ? row.recurring_prompt ?? null : null
    const next: RecurringPromptWrite = prompt === null
      // No text, no mechanisms — one armed over an empty prompt is a row the scheduler cannot fire.
      ? { prompt: null, stopHook: false, heartbeat: false, postCompaction: false }
      : {
        prompt,
        stopHook: trigger === "rest" ? on : otherOn,
        heartbeat: trigger === "schedule" ? on : otherOn,
        postCompaction: compactOn,
        intervalSeconds: trigger === "schedule" && on ? write.intervalSeconds : storedSeconds,
      }

    assertRecurringPromptArmable(next, row)
    if (!ctx.storage.setRecurringPromptBySlug(slug, {
      prompt: next.prompt,
      stopHook: next.stopHook,
      heartbeat: next.heartbeat,
      postCompaction: next.postCompaction,
      intervalMs: recurringIntervalMs(next),
      armedAt: new Date().toISOString(),
    })) {
      throw new Error(`thread ${slug} could not be updated`)
    }
    ctx.board.refresh()
  }

  // Can this exact sub-agent be steered RIGHT NOW? Returns the session to address, or null. Every
  // condition below is load-bearing and each was measured rather than assumed:
  //
  //  - the row must be a BROKER-backed claude thread. Steering rides an addressed input message on
  //    the live SDK stream, which only the broker daemon has. A LEGACY (pre-cutover) claude row has no
  //    such channel; a codex row's children are spawned inside codex's own process and the app-server
  //    protocol exposes no per-child address at all (`turn/steer` addresses a THREAD, and a codex
  //    child's thread is not one this app-server connection started).
  //  - the child must be DIRECT (this session's own Agent-tool dispatch, not a grandchild resolved
  //    through the descendant sidecar and not a background shell) — the CLI only knows tool_use ids
  //    its own main thread issued. MEASURED, not assumed (`_live_broker_steer_depth.mts`, 2026-07-30):
  //    an input frame addressed to a GRANDCHILD's dispatch id is not routed to it and does not fail —
  //    the unknown `parent_tool_use_id` is silently ignored and the frame lands on the top-level
  //    session's MAIN thread as an ordinary `promptSource:"sdk"` user turn. Lifting this gate would
  //    therefore not steer the grandchild; it would HIJACK THE WORKER'S TURN with text meant for
  //    someone else. (In that run the token did reach the grandchild — because the root model read the
  //    misdelivered steer and chose to relay it down with SendMessage, root → child → grandchild. A
  //    model being helpful is not a transport, and nothing may be built on it.)
  //  - the child must be RUNNING. `stale` means frizz has seen no output for a long while and the
  //    completion record was probably missed; addressing a finished child MISDELIVERS to the parent's
  //    main thread rather than failing, so "probably finished" has to be treated as finished.
  //  - the PARENT's own main-thread turn must be IDLE. The CLI's addressed routing only exists at the
  //    input boundary: an input frame arriving while a main-thread turn is IN FLIGHT is enqueued on
  //    the main input queue — addressing and all — and then absorbed into the PARENT's running turn
  //    (`queue-operation` enqueue → remove `reason:"absorbed_mid_turn"` in the session JSONL), so the
  //    parent obeys text aimed at its child. Measured both ways on claude 2.1.251
  //    (_live_broker_steer.mts: parent idle → the child and only the child obeyed;
  //    _live_broker_steer_busy.mts: parent mid-turn → the parent absorbed it and the child never saw
  //    it — the exact misdelivery the operator hit 2026-09-02). The fold's `turn` reading is the same
  //    authority the board's working shimmer reads; "in-flight" here means a steer would be absorbed.
  //
  // A residual race remains and cannot be closed from outside the CLI: a child may settle between
  // this check and the daemon's read of the frame, and there is no receipt to tell us — and the same
  // race exists in miniature for the turn gate (the parent may START a turn between this check and
  // the daemon's read; the window is sub-second where the misdelivery it closes was open-ended). It is narrow
  // (a broker row retires a child on the SDK's own task_notification, not on a mtime timeout) and it
  // is the reason the drawer's composer disappears the instant the child stops running.
  // `note` is the sentence the drawer shows in place of the prompt box, and it is composed HERE —
  // next to the code that knows the actual reason — rather than re-derived from a boolean by a client
  // that would have to guess. Null note = nothing worth saying (a settled child's transcript already
  // reads as finished; a banner there would be noise).
  function subAgentSteerable(slug: string, id: string): { sessionId: string } | { sessionId: null; note: string | null } {
    const blocked = (note: string | null) => ({ sessionId: null, note })
    const info = ctx.tailer.subAgent(slug, id)
    if (!info) return blocked(null)
    if (info.state !== "running") return blocked(null)
    if (!info.direct) return blocked("Only sub-agents this thread dispatched itself can be steered — this one belongs to another agent.")
    const row = ctx.storage.getSession(slug)
    if (!row) return blocked(null)
    if (row.backend === "codex") return blocked("Codex runs its sub-agents inside its own process and exposes no way to address one, so this child can't be steered from here.")
    if (row.claude_runtime !== "broker" || !ctx.claudeBroker) {
      return blocked("Steering a sub-agent needs the Claude session broker; this thread predates it.")
    }
    // LAST, because it is the one transient refusal: the structural notes above are permanent facts
    // about the child, while this one clears on its own the moment the thread rests — and the drawer
    // re-reads steerability on every transcript push, so the prompt box comes back by itself.
    if (ctx.tailer.get(slug)?.turn === "in-flight") {
      return blocked("The thread is working on its own turn right now, and a steer sent mid-turn is delivered to the thread instead of this sub-agent. The box comes back when the thread rests.")
    }
    return { sessionId: row.session_id }
  }

  // Can frizz END this live op, and if not, why not — for a sub-agent AND for a background shell.
  //
  // A SHELL used to be refused here categorically: "frizz tracks a background shell by reading the
  // worker's transcript and holds no handle on its process". That was measured wrong. A background
  // `Bash` is a TASK in the very registry `Query.stopTask` addresses — the SDK's own
  // `backgroundTasks()` says as much ("Bash commands and subagents") — and frizz has been recording its
  // task id all along, off the launch ack ("Command running in background with ID: …") and off the
  // `task_started` stream. `backend/_live_shell_stop.mts` drove the production path end to end: the
  // shell's OS process was gone within a second of the stop and the row left the board on its own.
  // The maintainer's case for this is the 24-hour wedged watcher with no way to clear it.
  //
  // Only two things differ between the two kinds, and both are handled below rather than by forking
  // the function: the LIVENESS reading, and the noun in every refusal.
  // A CODEX background exec, resolved by the id its row carries — which for codex IS the `processId`
  // the kill needs (see tailer.ts codexBgShellViews: there is exactly one handle and no correlation
  // step). Undefined for every other kind of row, so the Claude path below is reached unchanged.
  //
  // It reads the BOARD's live shell list rather than the fold, because that list IS the app-server's
  // item stream — a codex exec's processId never reaches the rollout frizz folds (measured in
  // backend/_live_codex_bgterm_match.mts, where the rollout-projected row carried no handle at all).
  function codexShellTarget(slug: string, id: string): { sessionId: string; processId: string; label: string } | undefined {
    if (!ctx.codexAppServer) return undefined
    const row = ctx.storage.getSession(slug)
    if (!row || row.backend !== "codex" || row.codex_runtime !== "app-server") return undefined
    const shell = ctx.tailer.get(slug)?.bgShells?.find((entry) => entry.id === id && entry.state === "running")
    if (!shell) return undefined
    return { sessionId: row.session_id, processId: id, label: shell.label }
  }

  // What the codex worker is told when frizz kills one of its background commands. Same sentence as the
  // Claude one and for the same measured reason — neither provider tells its agent. Codex's silence is
  // structural: completion there is POLLED, never pushed, so a killed exec's next `wait` reads
  // "Script completed / output:''", which is indistinguishable from a clean finish (verified in
  // backend/_live_codex_bgterm.mts). Delivered through `thread/inject_items`, the one channel that
  // appends to the model's visible history without starting a turn.
  function shellStopNotice(label: string): string {
    return `[frizz] The operator stopped your background command ${JSON.stringify(label)} from the Frizz dashboard. It is no longer running and will never report a result — do not wait on it or poll it again.`
  }

  // Apply the operator's retirements to a transcript page. Two surfaces render a background op and BOTH
  // have to hear about the ×: the board row (the tailer drops it on the click and remembers it durably)
  // and the transcript, which is derived from a `tool_use` whose terminal partner never arrives. Miss
  // this one and the ops strip simply redraws the row from the transcript side — with no × on it,
  // because a transcript-only row has nothing to address a stop at.
  function retireOpsInPage(slug: string, page: TranscriptPage): TranscriptPage {
    const retired = retiredOpsFor(ctx.storage, slug)
    // A dead OWNER retires every still-pending background card on the thread, for the same reason and
    // more strongly than the × retires one: those ops are children of the process that is gone. Read
    // from the tailer, which already answers this once per tick for all three runtimes — a legacy row's
    // long-gone worker as well as a dead broker daemon. Asking the broker bridge directly, as this first
    // did, was both a second implementation of the same question and blind to every non-broker row.
    const gone = ctx.tailer.ownerGone?.(slug) ?? false
    if (retired.size === 0 && !gone) return page
    return { ...page, messages: projectRetiredBackgroundOps(page.messages, retired, gone) }
  }

  function subAgentStoppable(slug: string, id: string): { sessionId: string; taskId: string; shell: boolean } | { sessionId: null; note: string | null } {
    const blocked = (note: string | null) => ({ sessionId: null, note })
    const info = ctx.tailer.subAgent(slug, id)
    if (!info) return blocked(null)
    const shell = ctx.tailer.backgroundShell?.(slug, id)
    const noun = shell ? "background shell" : "sub-agent"
    // A shell has NO staleness ceiling — its entry clears on a terminal notification, so a watcher that
    // has printed nothing for a day is still `running`, not `stale`. Read the shell's own state, which
    // says exactly that; `info.state` runs it through the sub-agent staleness rule and would report
    // "stale" for precisely the wedged shell this control exists to kill.
    //
    // What a shell DOES have is the OS's verdict (tailer shellIsGone, since 2026-08-19): one nobody holds
    // open is gone, and the board's row for it reads `stale`. The lookup above does not carry that
    // verdict, so a dead shell passed as running and the × attempted a real stop — which threw when no
    // daemon held the session (leaving the row the × exists to clear), and otherwise told the worker a
    // kill that never happened. Nothing is running to stop, so the × CLEARS it, as the client promises
    // for a stale row (lib/dismissChildOp.ts).
    const shellGone = shell !== undefined && ctx.tailer.get(slug)?.bgShells?.find((s) => s.id === id)?.state === "stale"
    if (!(shell ? shell.state === "running" && !shellGone : info.state === "running")) return blocked(null)
    const row = ctx.storage.getSession(slug)
    if (!row) return blocked(null)
    if (row.backend === "codex") {
      return blocked(shell
        ? "Codex runs its background commands inside its own process and exposes no way to end one, so this shell can't be stopped from here."
        : "Codex does not expose per-sub-agent interruption to Frizz, so this child can't be stopped from here.")
    }
    if (row.claude_runtime !== "broker" || !ctx.claudeBroker) {
      return blocked(`Stopping a ${noun} needs the Claude session broker; this thread predates it.`)
    }
    if (!info.taskId) return blocked(`This ${noun} did not publish the task identifier needed to stop it.`)
    return { sessionId: row.session_id, taskId: info.taskId, shell: Boolean(shell) }
  }

  // TELL THE WORKER ITS SHELL WAS KILLED — the half the provider does not do for us.
  //
  // Measured (backend/_live_shell_stop_notice.mts, 2026-08-01) on a real session: stopping a SUB-AGENT
  // injects a `<task-notification>` user record the model reads and acts on ("the sub-agent was stopped
  // before it finished, so it never reported back"). Stopping a background SHELL injects NOTHING — the
  // transcript gains not one record — and asked afterwards the model still believed its shell was
  // "presumably still running … I have received no completion notification". A worker left waiting on a
  // watcher frizz already killed is the exact stall the × is meant to end, so frizz supplies the missing
  // notice itself. Shell-only, deliberately: adding one on the sub-agent path would say it twice.
  //
  // `[frizz]` is the established prefix for a machine notice to a worker — transcript.ts NOISE_PREFIXES
  // keeps it out of the human's chat, so this reaches the model without becoming a bubble the operator
  // never typed.
  //
  // NEVER cold-starts a process. `stopSubAgent` already requires a daemon this bridge holds live, but a
  // daemon can die in the gap, and `followUp` would then resume a whole `claude` from disk purely to
  // announce a kill. The liveness check keeps the worst case at "nobody was there to tell", which is
  // reported rather than hidden.
  //
  // `label` is read BEFORE the kill by the caller: the worker's own description of the shell ("Watching
  // CI") is what it will recognise, and the row it comes from is retired moments later.
  async function noticeShellStopped(slug: string, label: string): Promise<string | null> {
    const bridge = ctx.claudeBroker
    const row = ctx.storage.getSession(slug)
    if (!bridge || !row) return "The worker could not be told — the Claude session broker is unavailable."
    if (!bridge.isDaemonAlive(row.session_id)) return "The worker was not told — its session is no longer running."
    try {
      await bridge.followUp({
        threadSlug: slug,
        sessionId: row.session_id,
        cwd: ctx.project.dir,
        text: `${shellStopNotice(label)} Whatever it wrote before the kill is still readable in its output file.`,
        // `isDaemonAlive` above is a check, not a hold: the daemon can exit before this frame lands,
        // and followUp then COLD-RESUMES rather than failing. Take the same floor every other fork
        // takes, so a notice that loses the race cannot be the thing that rebuilds the worker at
        // Claude's `default` — see coldResumePermission — or rebuilds it with no worker contract,
        // which the daemon it forks would then keep for every later message.
        permissionMode: coldResumePermission(row, ctx.getSettings()),
        appendSystemPrompt: claudeWorkerSystemPrompt(row.session_id, ctx.project.dir),
        model: row.model ?? undefined,
        effort: row.effort ?? undefined,
        // Frizz's own notice, not the operator's reply to anything: an open card stays open.
        keepOpenCards: true,
      })
      return null
    } catch (error) {
      return `The worker could not be told: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  // STOP A SUBTREE, NOT A ROW — the shared body behind both stop paths (the drawer's button and the ×).
  //
  // `stopTask` ends exactly the task it names, and the registry behind it is flat and session-wide, so
  // a sub-agent's own fan-out is NOT covered by its parent's id. Stopping only the named agent leaves
  // its children running, and that same flatness delivers their completions to the SESSION's main loop
  // — so the orphans keep spending tokens and then report into the ROOT thread, attributed to an agent
  // the operator watched die (maintainer, 2026-07-31, on nub session a0c5fba3: "Two orphaned
  // grandchildren of the killed agent just reported"). The subtree walk is the fix; the ORDER is the
  // rest of it.
  //
  //  · DEEPEST FIRST, then the target last. A still-running agent can dispatch another child between
  //    two sequential stops, so bottom-up leaves no window in which a fresh grandchild outlives an
  //    already-stopped parent.
  //  · A DESCENDANT stop that throws is COUNTED, never swallowed and never fatal. The common cause is
  //    benign — it settled between the sidecar read and the stop — but a genuine failure means live
  //    work frizz failed to end, and the operator has to hear that rather than read "stopped" over it.
  //  · The TARGET's stop still throws through to the caller, which is what keeps `stopBackgroundOp`
  //    from retiring a row whose work is still going.
  //  · A SHELL has no subtree — its dispatch leaves no sidecar, so `subAgentDescendantTasks` answers
  //    empty and the loop is skipped. What it has instead is the NOTICE, fired here rather than at each
  //    call site so no stop path can ever kill a shell silently.
  async function stopSubAgentSubtree(
    slug: string,
    id: string,
    target: { sessionId: string; taskId: string; shell?: boolean },
  ): Promise<{ descendantsStopped: number; descendantsFailed: number; noticeFailed: string | null }> {
    const bridge = ctx.claudeBroker
    if (!bridge) throw new Error("Claude session broker is unavailable; cannot stop this sub-agent")
    // Read the shell's own name for itself while its row is still live — the notice below is delivered
    // after the kill, by which point the row it came from is on its way out of tracking.
    const shellLabel = target.shell
      ? ctx.tailer.get(slug)?.bgShells?.find((s) => s.id === id)?.label ?? ctx.tailer.backgroundShell?.(slug, id)?.command ?? "(unnamed)"
      : undefined
    let descendantsStopped = 0
    let descendantsFailed = 0
    for (const taskId of ctx.tailer.subAgentDescendantTasks?.(slug, id) ?? []) {
      try {
        await bridge.stopSubAgent({ threadSlug: slug, sessionId: target.sessionId, taskId })
        descendantsStopped++
      } catch {
        descendantsFailed++
      }
    }
    await bridge.stopSubAgent({ threadSlug: slug, sessionId: target.sessionId, taskId: target.taskId })
    // AFTER the kill, never before: the notice states the shell is already dead, and a stop that throws
    // must not leave a worker believing work ended that is still burning. A notice that fails to land
    // is reported, not thrown — the process IS dead by this line, and turning that into an error the
    // client reads as "the stop failed" would leave the row on the board over a delivery problem.
    const noticeFailed = shellLabel === undefined ? null : await noticeShellStopped(slug, shellLabel)
    return { descendantsStopped, descendantsFailed, noticeFailed }
  }

  // FAILURE ONLY. A successful fan-out is already fully described by `descendantsStopped`, and saying
  // it twice on the wire invites the two to drift; the note exists for the one thing a count cannot
  // express — a descendant frizz asked to stop and could not, which is live work the operator is about
  // to lose sight of when the row leaves the board. A shell notice that did not land joins it on the
  // same terms: the operator believes the worker was told, and only this says otherwise.
  function subtreeNote(result: { descendantsFailed: number; noticeFailed?: string | null }): string | null {
    const { descendantsFailed, noticeFailed } = result
    const parts: string[] = []
    if (descendantsFailed > 0) parts.push(`${descendantsFailed} descendant${descendantsFailed === 1 ? "" : "s"} could not be stopped and may still be running.`)
    if (noticeFailed) parts.push(noticeFailed)
    return parts.length > 0 ? parts.join(" ") : null
  }

  // Every interaction RPC re-derives the project from this server and binds the requested slug to the
  // CURRENT registered session id. Foreign transcripts have no registry row; a stale page holding a
  // replaced session id fails closed instead of reading or answering the replacement's requests.
  function interactionScope(slug: string, sessionId: string) {
    const row = ctx.storage.getSession(slug)
    if (!row || row.session_id !== sessionId) throw new Error("interaction is not available for this project session")
    return { projectId: ctx.project.id, threadSlug: slug, sessionId }
  }

  // Add only the provider-neutral action effect needed by a client. Adapter delivery rows contain
  // transport ids, durable provider responses, and context that must never cross the RPC boundary.
  // A terminal journal row wins and carries no delivery effect; pending/terminal disagreement fails
  // closed as reconnect-required rather than resurrecting buttons.
  function interactionForRead(
    scope: ReturnType<typeof interactionScope>,
    interaction: InteractionRecord,
  ): InteractionRecord {
    if (interaction.lifecycle !== "pending") return interaction
    const delivery = ctx.interactions.providerDelivery(scope, interaction.id)
    if (!delivery) return interaction
    const effect = delivery.state === "queued" || delivery.state === "sent"
      ? "sending" as const
      : delivery.state === "awaiting-user" &&
          ctx.codexAppServer?.ownsInteraction(scope, interaction.id) === true
        ? "awaiting-user" as const
        : "reconnect-required" as const
    return { ...interaction, delivery: { effect } }
  }

  // Resolve the repo owner/name for a GitHub call. A POSITIVE boot cache short-circuits (stable, no
  // gh call — the common path). A null/absent cache is NOT trusted: it can be the boot race (cache not
  // resolved yet) OR an unauthed-at-boot detection (`gh repo view` needs auth), so fall back to a live
  // ghRepo and WARM the cache on success — this makes a post-boot `gh auth login` light up the feature
  // without a server restart. Never throws (ghRepo swallows failures → null).
  // `installed` is boot-cached like the repo — and, like the repo, a cached NEGATIVE is not trusted.
  // A `gh --version` that timed out at boot (busy machine, cold keyring), or a gh installed after
  // frizz started, would otherwise hide the whole GitHub feature for the process lifetime with no way
  // back but a restart. A positive is stable, so this re-probes only while the answer is still no —
  // and a missing binary fails as an instant ENOENT spawn, not a network call.
  async function resolveInstalled(): Promise<boolean> {
    if (ctx.github?.installed) return true
    const live = await ghInstalled()
    if (live) ctx.github = { inRepo: false, nameWithOwner: null, ...ctx.github, installed: true }
    return live
  }

  async function resolveRepo(): Promise<string | null> {
    const cached = ctx.github?.nameWithOwner
    if (cached) return cached
    const live = await ghRepo(ctx.project.dir)
    if (live) {
      if (ctx.github) {
        ctx.github.inRepo = true
        ctx.github.nameWithOwner = live
      } else {
        ctx.github = { installed: true, inRepo: true, nameWithOwner: live }
      }
      return live
    }
    // gh could not answer. That is USUALLY "not a GitHub repo", but it is also what a network blip
    // looks like — `gh repo view` is a GraphQL call — so fall back to the local git remote before
    // hiding the feature. Deliberately NOT cached: gh stays the authority, and the next query
    // re-probes it, so an outage never freezes a locally-derived name onto the process.
    return await gitGithubRemote(ctx.project.dir)
  }

  return {
    board: query({
      output: BoardSnapshot,
      handler: () => ctx.board.snapshot(),
    }),

    // The board AS OF a point in its delta stream — what a page reads before asking /ws for the deltas
    // after `seq` (app-socket.ts, the board topic). HTTP rather than the socket because the board is the
    // one big payload: gzipped here, and received by the browser off the main thread, where the same
    // 14MB as one socket message cost ~350ms of it (2026-10-14).
    boardState: query({
      output: BoardState,
      handler: async () => {
        const { board, seq } = await ctx.board.snapshotState()
        return { board, seq, bootId: ctx.bootId }
      },
    }),

    // The deltas after a board the client holds, from the ring a socket's resume replays — what the
    // Console polls for a project whose /ws never opened (@frizz/shared BoardDeltasResult has the why).
    boardDeltas: query({
      input: BoardDeltasInput,
      output: BoardDeltasResult,
      handler: async ({ input }): Promise<BoardDeltasResult> => {
        if (input.bootId !== ctx.bootId) return { bootId: ctx.bootId, resync: "boot" as const }
        const deltas = ctx.board.deltasSince(input.seq)
        if (!deltas) return { bootId: ctx.bootId, resync: input.seq > ctx.board.currentSeq() ? ("ahead" as const) : ("expired" as const) }
        return { bootId: ctx.bootId, deltas }
      },
    }),

    threadBody: query({
      input: SlugInput,
      output: z.object({ markdown: z.string() }),
      handler: async ({ input }) => {
        if (isAutoTitledSession(input.slug)) return { markdown: "" }
        const file = resolveLegacyThreadFile(ctx.project.dir, input.slug)
        if (!file) return { markdown: "" }
        // Use the bytes read under the resolver's before/after lstat checks. Reopening `file.path`
        // here would reintroduce a symlink-swap window after containment had already succeeded.
        return { markdown: file.contents.toString("utf8") }
      },
    }),

    // The full conversation, parsed mechanically from the session JSONL. Chat-first UI renders
    // this by default; the raw terminal is the power-user toggle.
    threadTranscript: query({
      input: SlugInput,
      output: TranscriptPage,
      handler: async ({ input }) => {
        // Registry row → its session's transcript; foreign slug (a session id) → resolved directly; else [].
        // backendFor routes a codex thread through the codex rollout reader (else it renders empty).
        const page = readLatestThreadTranscriptPage(ctx.project, ctx.storage, input.slug, ctx.backendFor)
        return retireOpsInPage(input.slug, projectTranscriptPageAgentLifecycles(page, (id) => ctx.tailer.subAgent(input.slug, id), (taskId) => ctx.tailer.subAgentByTaskId?.(input.slug, taskId), ctx.sessionPeerThread))
      },
    }),

    // One bounded backward step through the canonical projected transcript. The cursor excludes the
    // already-visible anchor and is rejected on session/runtime/transcript replacement.
    threadTranscriptEarlier: query({
      input: TranscriptEarlierInput,
      output: TranscriptPage,
      handler: async ({ input }) => {
        const page = readEarlierThreadTranscriptPage(ctx.project, ctx.storage, input.slug, input.cursor, ctx.backendFor)
        return retireOpsInPage(input.slug, projectTranscriptPageAgentLifecycles(page, (id) => ctx.tailer.subAgent(input.slug, id), (taskId) => ctx.tailer.subAgentByTaskId?.(input.slug, taskId), ctx.sessionPeerThread))
      },
    }),

    // The thread's ANSWERED registered questions, each with its answer, so the transcript can keep the
    // card in the slot it stood in — greyed, showing only what was picked — instead of the ask vanishing
    // the instant it is sent. Per thread, not on the board: see SettledQuestionView. A row whose spec or
    // answer no longer parses is dropped, the same drop-don't-throw rule as the open list.
    threadSettledQuestions: query({
      input: SlugInput,
      output: ThreadSettledQuestionsResult,
      handler: async ({ input }) => {
        const questions: SettledQuestionView[] = []
        for (const q of ctx.storage.listThreadQuestions(input.slug)) {
          if (q.state !== "answered" || q.settled_at == null) continue
          const spec = parseQuestionSpec(q.spec)
          const answer = parseStoredAnswer(q.answer)
          if (!spec || !answer) continue
          questions.push({ id: q.id, spec, askedAt: new Date(q.asked_at).toISOString(), settledAt: new Date(q.settled_at).toISOString(), answer })
        }
        return { questions }
      },
    }),

    // Runtime adapters create interactions internally. React gets only scoped reads and terminal
    // transitions; there is deliberately no public/provider-spoofable create RPC.
    pendingInteractions: query({
      input: ListInteractionsInput,
      output: ListInteractionsResult,
      handler: async ({ input }) => {
        const scope = interactionScope(input.slug, input.sessionId)
        return { interactions: ctx.interactions.listPending(scope).map((interaction) => interactionForRead(scope, interaction)) }
      },
    }),

    interactionGet: query({
      input: GetInteractionInput,
      output: GetInteractionResult,
      handler: async ({ input }) => {
        const scope = interactionScope(input.slug, input.sessionId)
        const interaction = ctx.interactions.get(scope, input.interactionId)
        if (!interaction) throw new Error("interaction is not available for this project session")
        return { interaction: interactionForRead(scope, interaction) }
      },
    }),

    interactionResolve: mutation({
      input: ResolveInteractionInput,
      output: ResolveInteractionResult,
      handler: ({ input }) => audit(
        "interactionResolve",
        {
          project: thisProject,
          thread: input.slug,
          // The decision the operator picked and how many values rode with it — never the values, which
          // can be a secret the interaction asked for.
          detail: { interactionId: input.interactionId, decisionId: input.decisionId, values: Object.keys(input.values ?? {}).length },
        },
        async () => {
          const scope = interactionScope(input.slug, input.sessionId)
          const delivery = ctx.interactions.providerDelivery(scope, input.interactionId)
          let result
          if (delivery) {
            if (!ctx.codexAppServer || !ctx.codexAppServer.ownsInteraction(scope, input.interactionId)) {
              throw new Error("provider-backed interaction is unavailable until its provider bridge reconnects")
            }
            const providerResult = await ctx.codexAppServer.resolveInteraction(scope, input)
            if (!providerResult) throw new Error("provider-backed interaction lost its durable delivery owner")
            result = {
              effect: providerResult.effect === "already-sent" ? "already-queued" as const : providerResult.effect,
              interaction: providerResult.interaction,
            }
          } else {
            result = ctx.interactions.resolve(scope, input)
          }
          // The journal result contains only the persisted/redacted response. Secret input values are
          // never echoed by this RPC (and are absent from SQLite before this function returns). Re-read
          // after provider I/O: its acknowledgement may have won the race and terminalized the journal
          // while the bridge still holds the pending object returned by its earlier queue transaction.
          const latest = ctx.interactions.get(scope, result.interaction.id) ?? result.interaction
          return {
            effect: latest.lifecycle === "resolved" &&
                (result.effect === "queued" || result.effect === "already-queued")
              ? "resolved" as const
              : result.effect,
            interaction: interactionForRead(scope, latest),
          }
        },
        (result) => ({ detail: { effect: result.effect } }),
      ),
    }),

    interactionCancel: mutation({
      input: CancelInteractionInput,
      output: CancelInteractionResult,
      handler: async ({ input }) => {
        const scope = interactionScope(input.slug, input.sessionId)
        if (ctx.interactions.providerDelivery(scope, input.interactionId)) {
          // Provider cancellation is an advertised decision that must traverse the acknowledged
          // delivery path. A local-only terminal transition would strand the app-server request.
          throw new Error("provider-backed interaction must use its advertised cancel decision")
        }
        const result = ctx.interactions.cancel(scope, input)
        return { effect: result.effect, interaction: result.interaction }
      },
    }),

    // A live/stale background sub-agent's OWN transcript, for the drill-in drawer that overlays the
    // thread. Resolves the tracked child (thread slug + dispatch tool_use id) to its output JSONL, then
    // parses it with the same mechanical extractor. Never throws: an unknown/dropped id (completed
    // children leave tracking on their terminal notification) or an unreadable file → an empty
    // transcript with state "gone", which the drawer renders as its quiet "unavailable" state.
    subAgentTranscript: query({
      input: z.object({ slug: ThreadSlug, id: z.string() }).strict(),
      output: z.object({
        messages: z.array(TranscriptMessage),
        state: z.enum(["running", "stale", "done", "gone"]),
        // Whether THIS child can be steered right now. Computed server-side, never re-derived by the
        // client: the drawer renders a prompt box if and only if this is true, because the codebase
        // rule is "absent ⇒ no affordance, never a fabricated one" and an input that silently drops a
        // steer is worse than no input. See subAgentSteer for every condition folded in here.
        steerable: z.boolean(),
        // Why not, when the reason is worth stating (a RUNNING child that still can't be reached).
        steerNote: z.string().nullable(),
        stoppable: z.boolean(),
        stopNote: z.string().nullable(),
        // THE DRAWER HEADER'S FACTS, the child's own counterparts of a thread header's "Last active ·
        // ◔ 74% context" line (subagent-facts.ts). Each is absent when it is not known, and the header
        // then draws nothing for it — the same no-fabricated-reading rule as ThreadView.context.
        lastActivityAt: z.string().optional(),
        context: z.object({ tokens: z.number(), window: z.number() }).optional(),
        // How a SETTLED child ended, from the provider's terminal notification; the header states it
        // where a running child's stop control stands. Absent for a descendant, whose sidecar carries
        // no terminal row, so the header claims nothing it does not know.
        outcome: z.enum(["completed", "failed", "killed"]).optional(),
        startedAt: z.string().optional(),
        finishedAt: z.string().optional(),
      }),
      handler: async ({ input }) => {
        const info = ctx.tailer.subAgent(input.slug, input.id)
        if (!info) return { messages: [], state: "gone" as const, steerable: false, steerNote: null, stoppable: false, stopNote: null }
        const usage = info.outputFile ? readSubAgentContextUsage(info.outputFile, info.outputFormat) : undefined
        const window = usage?.window ?? (usage?.model ? ctx.tailer.subAgentContextWindow?.(input.slug, usage.model) : undefined)
        const lastActivityAt = info.outputFile ? readSubAgentLastActivityAt(info.outputFile) : undefined
        // A CODEX sub-agent is itself a codex thread, so its "output file" is a rollout in codex's own
        // schema — parse it with the codex reader or the drawer renders empty.
        const read = info.outputFormat === "codex" ? readCodexTranscriptFile : readTranscriptFile
        const messages = mergeSubAgentSteers(
          info.outputFile ? read(info.outputFile) : [],
          ctx.storage.listSubAgentSteers(input.slug, input.id),
        )
        const steer = subAgentSteerable(input.slug, input.id)
        const stop = subAgentStoppable(input.slug, input.id)
        return {
          messages,
          state: info.state,
          steerable: steer.sessionId !== null,
          steerNote: steer.sessionId === null ? steer.note : null,
          stoppable: stop.sessionId !== null,
          stopNote: stop.sessionId === null ? stop.note : null,
          ...(lastActivityAt ? { lastActivityAt } : {}),
          ...(usage && window !== undefined && window > 0 ? { context: { tokens: usage.tokens, window } } : {}),
          ...(info.state === "done" && info.outcome ? { outcome: info.outcome } : {}),
          ...(info.startedAt ? { startedAt: info.startedAt } : {}),
          ...(info.state === "done" && info.finishedAt ? { finishedAt: info.finishedAt } : {}),
        }
      },
    }),

    // Steer ONE running sub-agent: deliver the operator's text into the CHILD's own conversation
    // rather than the thread's main turn. The maintainer's question — "don't we have the ability to
    // steer them with prompts?" — turned out to be yes, but only through one narrow channel: an input
    // message addressed with the child's dispatch tool_use id (`parent_tool_use_id`). There is no
    // control request for STEERING. Stopping is separate and does use the SDK's `stopTask` control.
    //
    // WHY THE GATE IS STRICT. Measured live: addressing a child that has ALREADY SETTLED does not
    // error and does not vanish — the CLI falls the message back onto the MAIN thread, where the
    // parent obeys it as if the operator had typed it into the thread composer — re-measured on
    // 2.1.295 by backend/_live_broker_steer_rested.mts, with both the dispatch tool_use id and the
    // runtime agent id as the address, and neither one resumes the child. A steer sent while
    // the parent's own turn is IN FLIGHT misdelivers the same way (absorbed into that turn — see the
    // predicate). So an ungated steer is not a no-op, it is a misdelivery. `subAgentSteerable` is the
    // single predicate that decides, and the drawer's prompt box is rendered off the same answer.
    subAgentSteer: mutation({
      input: z.object({ slug: ThreadSlug, id: z.string(), message: z.string().min(1), deliveryId: z.string().min(1).max(200).optional() }).strict(),
      output: z.object({ delivered: z.boolean() }),
      handler: ({ input }) => audit(
        "subAgentSteer",
        { project: thisProject, thread: input.slug, detail: { subAgent: input.id, message: textDigest(input.message) } },
        async () => {
          const target = subAgentSteerable(input.slug, input.id)
          if (target.sessionId === null) {
            throw new Error(target.note ?? "This sub-agent is no longer running, so it can't be steered")
          }
          const bridge = ctx.claudeBroker
          if (!bridge) throw new Error("Claude session broker is unavailable; cannot steer this sub-agent")
          const deliveryId = input.deliveryId ?? randomUUID()
          const sentAtMs = Date.now()
          // The words the child receives are the words journaled below — see deliverFollowUp.
          const message = deliverableInputText(input.message)
          if (!message.trim()) throw new Error("There is nothing to send")
          await bridge.steerSubAgent({
            threadSlug: input.slug,
            sessionId: target.sessionId,
            subAgentId: input.id,
            text: message,
            deliveryId,
          })
          // The provider deliberately does not write addressed input into the child's transcript. Frizz
          // has the plaintext here, so journal it only after delivery succeeds and merge it into future
          // drawer reads. INSERT OR IGNORE makes a retried transport id one visible message.
          ctx.storage.recordSubAgentSteer({
            slug: input.slug,
            subAgentId: input.id,
            deliveryId,
            message,
            sentAtMs,
          })
          ctx.board.refresh()
          return { delivered: true }
        },
      ),
    }),

    subAgentStop: mutation({
      input: z.object({ slug: ThreadSlug, id: z.string() }).strict(),
      output: z.object({ stopped: z.boolean(), descendantsStopped: z.number(), note: z.string().nullable() }),
      handler: async ({ input }) => {
        const target = subAgentStoppable(input.slug, input.id)
        if (target.sessionId === null) {
          throw new Error(target.note ?? "This sub-agent is no longer running, so it can't be stopped")
        }
        const result = await stopSubAgentSubtree(input.slug, input.id, target)
        ctx.board.refresh()
        return { stopped: true, descendantsStopped: result.descendantsStopped, note: subtreeNote(result) }
      },
    }),

    // A live/recent background shell's command and combined process output. The tailer supplies the
    // scoped path; the reader caps the response so long-lived watchers/dev servers stay cheap.
    backgroundShellOutput: query({
      input: z.object({ slug: ThreadSlug, id: z.string() }).strict(),
      output: z.object({
        command: z.string().nullable(),
        output: z.string(),
        truncated: z.boolean(),
        state: z.enum(["running", "done", "gone"]),
        // The same pair `subAgentTranscript` carries, for the same reason: the drawer renders a Stop
        // button if and only if this is true, and states `stopNote` in its place when a running shell
        // still cannot be reached. Never re-derived client-side — see subAgentStoppable.
        stoppable: z.boolean(),
        stopNote: z.string().nullable(),
      }),
      handler: async ({ input }) => {
        const info = ctx.tailer.backgroundShell?.(input.slug, input.id)
        if (!info) return { command: null, output: "", truncated: false, state: "gone" as const, stoppable: false, stopNote: null }
        const content = info.outputFile ? readBackgroundShellOutput(info.outputFile) : { output: "", truncated: false }
        const stop = subAgentStoppable(input.slug, input.id)
        return {
          command: info.command ?? null,
          ...content,
          state: info.state,
          stoppable: stop.sessionId !== null,
          stopNote: stop.sessionId === null ? stop.note : null,
        }
      },
    }),

    // THE LIVE COUNTER on a background shell row: how many lines of output each named shell has
    // produced so far. Elapsed time already rides that row and it cannot answer the question the
    // operator actually has about a watcher — "is this thing still doing anything, or is it wedged?".
    // A number that climbs answers it at a glance; one that has sat still for ten minutes answers it
    // the other way.
    //
    // A CLIENT POLL, deliberately NOT a board field. Output growth happens in a file the board's
    // derived signature does not read, and folding it in would push a board delta per append for every
    // thread on the machine whether or not a human is looking at one — the same churn the signature
    // already refuses raw token counts for (tailer.ts, derivedSignature). Polled here, the cost lands
    // only while a thread with live shells is actually on screen.
    //
    // BATCHED over ids because the ops strip renders them as a group: one request per poll for the
    // whole strip, not one per row.
    //
    // Every id the tailer still tracks comes back, and `lines: null` — NOT an omission — is how "there
    // is no readable output yet" is said. The distinction is what keeps the poll alive: a shell's row
    // appears at its `tool_use` and its output path only arrives seconds later with the launch ack, so
    // for that window the shell has no file at all. Omitting it read as "nothing here is running", the
    // client stopped polling, and the counter never appeared for the rest of the view's life.
    // An id the tailer no longer knows is genuinely gone and IS omitted.
    backgroundShellActivity: query({
      input: z.object({ slug: ThreadSlug, ids: z.array(z.string()).max(64) }).strict(),
      output: z.object({
        shells: z.array(z.object({
          id: z.string(),
          lines: z.number().nullable(),
          // Whether the count can still move. The client stops polling once every named shell has
          // settled, so a finished strip does not keep a timer alive for a number that cannot change.
          running: z.boolean(),
        })),
      }),
      handler: async ({ input }) => {
        const shells: { id: string; lines: number | null; running: boolean }[] = []
        for (const id of input.ids) {
          const info = ctx.tailer.backgroundShell?.(input.slug, id)
          if (!info) continue
          const lines = info.outputFile ? backgroundShellLineCount(info.outputFile) : undefined
          shells.push({ id, lines: lines ?? null, running: info.state === "running" })
        }
        return { shells }
      },
    }),

    // THE × ON A LIVE CHILD ROW. It means STOP, and it now tries to actually stop.
    //
    // It used to mean only "retire this op from tracking", which is what the maintainer hit
    // (2026-07-30): "The fucking X button didn't actually kill the sub-agent. it removed it from my UI,
    // but then I click on the title and it's still running." A control that clears the row while the
    // work keeps burning tokens is worse than no control — it hides live work behind a gesture that
    // reads as a kill. So the order here is stop FIRST, retire second:
    //
    //  1. STOPPABLE (a broker-backed claude row's live child — sub-agent OR background shell — with a
    //     task id) → the real provider control, `Query.stopTask`, awaited to the daemon's answer. Then
    //     retire, so the row leaves every live surface on this click's own board frame instead of
    //     waiting for the fold. A SHELL additionally gets the notice the provider does not send (see
    //     noticeShellStopped), so the worker is not left waiting on a watcher frizz already killed.
    //  2. The stop THREW → do NOT retire. A failed stop means the child is still working, and hiding
    //     it is exactly the bug above; the row stays and the error reaches the operator.
    //  3. NOT stoppable (a legacy claude thread, a codex thread, a stale/finished op) → retire anyway,
    //     because clearing a phantom is the escape hatch the × was built for and is still the only way
    //     to unstick a finished op whose completion was never recorded. But return the REASON, so the
    //     client can say plainly that the work may still be running rather than letting the row vanish
    //     silently. `note` is null when there is nothing worth saying — a stale/gone op is already
    //     finished as far as anything can tell.
    //
    // `dismissed:false` when the id was not live to retire (already gone / unknown) — the UI refreshes.
    stopBackgroundOp: mutation({
      input: z.object({ slug: ThreadSlug, id: z.string() }).strict(),
      output: z.object({ stopped: z.boolean(), dismissed: z.boolean(), note: z.string().nullable(), descendantsStopped: z.number() }),
      handler: async ({ input }) => {
        // CODEX takes its own route, not a branch inside the Claude one: its shells never enter the
        // fold's op map, so neither `tailer.subAgent` nor `tailer.backgroundShell` can see them, and
        // its kill is a different protocol call against a different bridge. It shares the SHAPE — stop
        // first, then let the row go — and the row leaves without `dismissOp` because the bridge drops
        // it from the live level the board reads.
        const codex = codexShellTarget(input.slug, input.id)
        if (codex) {
          const result = await ctx.codexAppServer!.terminateBackgroundExec({
            threadSlug: input.slug,
            sessionId: codex.sessionId,
            processId: codex.processId,
            notice: shellStopNotice(codex.label),
          })
          ctx.board.refresh()
          // `terminated:false` is the app-server saying the PTY was already gone. Nothing was killed and
          // nothing may claim it was — but the phantom row does clear, which is the ×'s other honest job.
          return { stopped: result.terminated, dismissed: true, note: result.noticeFailed, descendantsStopped: 0 }
        }
        const target = subAgentStoppable(input.slug, input.id)
        let stopped = false
        let note: string | null = null
        let descendantsStopped = 0
        if (target.sessionId !== null) {
          // The × ends the whole subtree, not just this row — see stopSubAgentSubtree. A descendant
          // that could not be stopped rides back in `note`, because the row is about to leave every
          // live surface and that is the operator's only chance to hear that work is still running.
          const result = await stopSubAgentSubtree(input.slug, input.id, target)
          descendantsStopped = result.descendantsStopped
          note = subtreeNote(result)
          stopped = true
        } else {
          note = target.note
        }
        const dismissed = ctx.tailer.dismissOp?.(input.slug, input.id) ?? false
        ctx.board.refresh()
        return { stopped, dismissed, note, descendantsStopped }
      },
    }),

    dispatch: mutation({
      input: DispatchInput,
      output: z.object({ slug: ThreadSlug, sessionId: z.string() }),
      // Forward the picker-selected backend into the dispatch opts seam (Codex-support epic, Phase 3).
      // Omitted ⇒ the dispatcher defaults to "claude", so an old client (no backend field) is
      // byte-identical. The resume path needs NO analog — resume reads the backend from the row's
      // `backend` column (backendFor(row.backend)), which dispatch already stamped for a codex thread.
      handler: ({ input }) => audit(
        "dispatch",
        {
          project: thisProject,
          detail: { prompt: textDigest(input.prompt), backend: input.backend ?? "claude", model: input.model ?? null, effort: input.effort ?? null },
        },
        () => ctx.dispatcher.dispatch(input, { backend: input.backend }),
        (result) => ({ thread: result.slug, detail: { sessionId: result.sessionId } }),
      ),
    }),

    // Cold-adopt a pre-existing thread (no session row): spawn a fresh worker on its file.
    adoptThread: mutation({
      input: AdoptThreadInput,
      output: AdoptThreadResult,
      handler: ({ input }) => audit(
        "adoptThread",
        { project: thisProject, thread: input.slug, detail: input.message ? { message: textDigest(input.message) } : undefined },
        () => ctx.dispatcher.adopt(input.slug, input.message),
        (result) => ({ detail: { sessionId: result.sessionId } }),
      ),
    }),

    followUp: mutation({
      input: FollowUpInput,
      // Wrapped so a delivery that throws keeps the operator's words — see keepFailedFollowUp.
      handler: ({ input }) => audit("followUp", {
        project: thisProject,
        thread: input.slug,
        detail: {
          sessionId: input.sessionId,
          message: textDigest(input.message),
          ...(input.freshProcess ? { freshProcess: true } : {}),
          ...(input.interrupt ? { interrupt: true } : {}),
          ...(input.hold ? { hold: true } : {}),
          ...(input.answers?.length ? { answers: input.answers.map((answer) => answerDigest(input.slug, answer)) } : {}),
        },
      }, () => sendFollowUp(input)),
    }),

    // ONE WORKER MESSAGING ANOTHER THREAD — `frizzctl steer`. Claude Code's own cross-session
    // `SendMessage` reaches only a session whose process is live, so before this a worker told to hand its
    // results to a resting thread went looking for the board's `followUp` route and curled it by hand.
    // This is that delivery, with the board's own bookkeeping: the target's CURRENT session is read where
    // it lives (the staleness guard a browser tab passes is the caller's to know, and a worker cannot), the
    // body is wrapped so the receiver and the chat both see whose it is, and the sender's identity comes
    // from the calling worker's env (the command reads it), never from the model.
    //
    // No deliveryId, so no ledger BUBBLE: that bubble exists to keep a HUMAN's words on screen through a
    // failure, and here the words stay with the sender, whose tool call fails loudly instead. The send
    // still gets a silent ledger entry, minted in deliverFollowUp, which is what lets it un-park a
    // snoozed thread as a message on its way rather than as a rest waiting on the human.
    //
    // ANY PROJECT THIS FRIZZ SERVES (maintainer 2026-10-26: "frizz threads need the ability to steer
    // other frizz threads regardless of project"). The call always lands on the SENDER's project — the
    // command addresses its own — and that is where the sender is verified. The target is then found by
    // resolveSteerTarget, and one in another project is delivered by THAT project's router
    // (AppContext.threadInbox): wake, queue, reopen and the ledger behave exactly as within one project,
    // and the wrapper names the sender's project so the reply finds its way back. Starting a thread on
    // another board is `spawnThread`, below.
    steerThread: mutation({
      input: SteerThreadInput,
      output: SteerThreadResult,
      handler: ({ input }) => audit("steerThread", {
        project: thisProject,
        thread: input.to,
        detail: { from: input.from, ...(input.project ? { toProject: input.project } : {}), message: textDigest(input.message) },
      }, async () => {
        const sender = ctx.storage.getSession(input.from)
        if (!sender) throw new Error(`the calling thread ${input.from} is not registered in this project`)
        const target = resolveSteerTarget(input.to, input.project)
        if (!target) {
          if (input.from === input.to) {
            throw new Error("That is your own thread. `frizzctl steer` messages ANOTHER thread; to keep a note for yourself, write it to your scratch directory")
          }
          return receiveThreadMessage({ from: { slug: sender.slug, title: threadTitleOf(sender) }, to: input.to, message: input.message })
        }
        const from = { slug: sender.slug, title: threadTitleOf(sender), project: projectSlugOf(ctx.project.id) }
        const receipt = await target.inbox({ from, to: input.to, message: input.message })
        return { ...receipt, project: target.project }
      }),
    }),

    // ONE WORKER STARTING A THREAD ON ANOTHER PROJECT'S BOARD — `frizzctl spawn-thread --project`
    // (maintainer 2026-10-28, after steer had crossed projects and spawn had not). A spawn with no
    // project still goes straight to this project's `dispatch`. This one lands on the SENDER's project, as
    // a steer does, which verifies the sender and finds the named project (openProjectNamed); that
    // project's router then dispatches it (AppContext.threadSpawner), so the thread, its worker's cwd, its
    // board and its audit record are all that project's. The footer telling the new thread how to steer
    // back is written HERE because only the server knows the sender's project slug — the worker holds its
    // registry id. The same-project footer is the command's own (frizz-tools.mjs `spawnThread`), and the
    // two say the same sentence.
    spawnThread: mutation({
      input: SpawnThreadInput,
      output: SpawnThreadResult,
      handler: ({ input }) => audit("spawnThread", {
        project: thisProject,
        thread: input.from,
        detail: { toProject: input.project, prompt: textDigest(input.prompt), backend: input.backend ?? "claude", model: input.model ?? null, effort: input.effort ?? null },
      }, async () => {
        const sender = ctx.storage.getSession(input.from)
        if (!sender) throw new Error(`the calling thread ${input.from} is not registered in this project`)
        // A registered project nobody has opened yet is opened now, as a request addressed to it would
        // be: a steer needs a thread that already exists, but a spawn exists to start work there.
        const named = findProjectBySegment(input.project)
        if (named && named.id !== ctx.project.id && !otherOpenProjects().some((open) => open.project.id === named.id)) {
          await ctx.openProject?.(named.id)
        }
        const open = openProjectNamed(input.project, "no thread can be started there from here")
        if (open && !open.threadSpawner) {
          throw new Error(`project \`${projectSlugOf(open.project.id)}\` is open in Frizz but not taking new threads yet; retry in a moment`)
        }
        const from: ThreadMessageSender = { slug: sender.slug, title: threadTitleOf(sender), ...(open ? { project: projectSlugOf(ctx.project.id) } : {}) }
        const { from: _from, project: _project, ...rest } = input
        const dispatch = { ...rest, prompt: input.prompt + spawnedThreadFooter(from) }
        if (!open) return spawnForThread({ from, input: dispatch })
        const made = await open.threadSpawner!({ from, input: dispatch })
        return { ...made, project: projectSlugOf(open.project.id) }
      }, (result: SpawnThreadResult) => ({ detail: { spawned: result.slug, ...(result.project ? { spawnedIn: result.project } : {}) } })),
    }),

    // The × on a FAILED send's bubble, and the second half of its Edit (the client has already put the
    // words back into the prompt box). The only way a failed entry leaves the ledger by hand — nothing
    // ages it, so without this a failure the operator has dealt with would sit at the tail for good.
    // No session guard: the entry is inert text on this slug's row, and dismissing it touches no worker.
    dismissFailedFollowUp: mutation({
      input: DismissFailedFollowUpInput,
      output: DismissFailedFollowUpResult,
      handler: async ({ input }) => {
        const dismissed = dismissFailedDelivery(ctx.storage, input.slug, input.deliveryId)
        if (dismissed) ctx.transcriptChange.emit([input.slug])
        return { dismissed }
      },
    }),

    // Take a queued follow-up BACK — the operator clicked their own gray bubble to unqueue it and get
    // the words back in the prompt box. The whole value of this is that it is TRUTHFUL: it reports
    // whether the provider actually removed the message, and never claims a retraction it did not get.
    //
    // Only a broker-backed Claude row can do it, because only there does frizz hold a control channel
    // into a queue that still exists. A LEGACY row's text was typed into Claude Code's own TUI composer
    // back when frizz drove one, and a codex app-server steer goes straight into the running turn — in
    // both cases the message has left every surface frizz can address, and the honest answer is
    // "too late", not a silent no-op.
    unqueueFollowUp: mutation({
      input: UnqueueFollowUpInput,
      output: UnqueueFollowUpResult,
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        if (!row) throw new Error("This thread is no longer the session this tab is looking at")
        // A message Frizz is HOLDING for the agent's rest was never handed to any runtime, so taking it
        // back is Frizz's alone to do, on every backend: drop the entry and the words go back to the
        // prompt box. A null here means it was released in the meantime, and the ordinary rules below
        // decide what can still be done about it.
        if (dropHeldDelivery(ctx.storage, input.slug, input.deliveryId) !== null) {
          ctx.transcriptChange.emit([input.slug])
          ctx.board.refresh()
          return { unqueued: true }
        }
        if (row.backend !== "claude" || row.claude_runtime !== "broker") {
          return { unqueued: false, reason: "This thread's runtime can't take a message back once it's been sent" }
        }
        const bridge = ctx.claudeBroker
        if (!bridge) throw new Error("Claude session broker is unavailable; cannot unqueue this follow-up")
        // ONE refusal sentence for every way this can be too late — and it deliberately does NOT claim
        // the message was DELIVERED, which is what it used to say.
        //
        // `cancelled: false` proves exactly one thing: the message is not in the queue any more. The
        // obvious reading is "the agent picked it up", and that is what happens in every state frizz has
        // been able to reach. But the SDK documents another: once a batch is dequeued and coalesced,
        // cancelling a member answers false whether its content still runs or the whole batch was
        // dropped. Probed hard for that (_live_sdk_cancel_coalesced.mts) and could not reach it — which
        // is not the same as proving it absent, so the wording must not depend on the answer. What frizz
        // knows is that the message left the queue and is beyond its reach; the bubbles it could not
        // retract stay gray rather than flipping to delivered, so an undelivered message keeps LOOKING
        // undelivered whichever reading is true.
        const tooLate = { unqueued: false, reason: "Too late — that message has already left the queue, so frizz can't take it back" }
        const item = deliveryItem(ctx.storage, input.slug, input.deliveryId)
        // Already retracted — a double click, or a second tab clicking the same bubble. Idempotent
        // rather than "too late": the message really is gone, and saying otherwise would be a lie in
        // the dangerous direction.
        if (item?.state === "cancelled") return { unqueued: true }
        // A write-ahead entry is not in any provider queue yet (or never reached one), so there is
        // nothing to cancel at the daemon, and asking it would answer "too late" — the wrong story.
        if (item?.state === "sending") return { unqueued: false, reason: "That message is still being sent — try again in a moment" }
        if (item?.state === "failed") return { unqueued: false, reason: "That message was never delivered — use Edit on it to get the text back" }
        // A retired ledger row means the tailer already correlated this send's delivery evidence — the
        // agent has it. It is also where a deliveryId frizz never sent lands, which the UI cannot
        // produce (every clickable bubble is one frizz itself projected from a ledger row).
        //
        // The row is also what makes a successful cancel SAFE to perform: without it there is nothing
        // to tombstone, and the orphaned JSONL enqueue bubble would stay on screen — which reads
        // exactly like the cancel failed.
        if (!item) return tooLate
        const cancelled = await bridge.cancelFollowUp({
          threadSlug: input.slug,
          sessionId: row.session_id,
          deliveryId: input.deliveryId,
        })
        // ORDER: tombstone only AFTER the provider confirms. Recording a cancellation frizz did not get
        // would hide a message the agent is about to read — the one failure this feature must not have.
        if (!cancelled) return tooLate
        cancelDelivery(ctx.storage, input.slug, input.deliveryId)
        ctx.board.refresh()
        return { unqueued: true }
      },
    }),

    // PUSH IT THROUGH NOW — the ↑ that appears left of a queued bubble on hover. The message is already
    // in the daemon's queue, so this sends nothing: it is the second half of `followUp`'s `interrupt`
    // flag with the delivery half already done. The runtime moves a running call to the background and
    // takes the queue in, or aborts the turn when it has nothing it can move, and the queue then opens
    // the next one (see the ORDER IS THE CONTRACT note on interruptTurn) — either way what is queued is
    // read now, which is exactly what the operator is asking for.
    //
    // Same gates as unqueueFollowUp, and for the same reason: only a broker-backed Claude row gives frizz
    // a control channel into a live turn. A legacy row and a codex steer have no interrupt frizz can
    // send, and the honest answer is to say so rather than no-op.
    deliverQueuedNow: mutation({
      input: DeliverQueuedNowInput,
      output: DeliverQueuedNowResult,
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        if (!row) throw new Error("This thread is no longer the session this tab is looking at")
        // The next message Frizz was HOLDING for the rest goes to the runtime first — the operator has just
        // said not to wait — and then the interrupt below pushes the runtime's queue through, it included.
        // One message, as a rest would hand over: the queue goes out one at a time (nextHeldRelease). On a
        // runtime with no interrupt the release is the entire act, and it is a steer there, read at the
        // agent's next step.
        const released = await releaseHeldFollowUps(input.slug, { force: true })
        if (input.releaseOnly) {
          return released > 0 ? { interrupted: false, released } : { interrupted: false, reason: "That message has already been sent" }
        }
        if (row.backend !== "claude" || row.claude_runtime !== "broker") {
          return released > 0
            ? { interrupted: false, released }
            : { interrupted: false, reason: "Send now isn't available on this thread's runtime" }
        }
        const bridge = ctx.claudeBroker
        if (!bridge) throw new Error("Claude session broker is unavailable; cannot interrupt this turn")
        // false = no live daemon to interrupt. Not an error and not a lost message: the send is still
        // queued and gets read the ordinary way, so the refusal says "no faster", never "gone".
        // Same snapshot-then-note as followUp's interrupt: when this ends in an abort that kills
        // background children, the worker is told which (interrupt-ended.ts). A send-now that moved
        // the running call aside ends none.
        const childrenBefore = runningSubAgentsOf(ctx.tailer.get(input.slug))
        if (!bridge.interruptTurn({ threadSlug: input.slug, sessionId: row.session_id })) {
          return released > 0
            ? { interrupted: false, released }
            : { interrupted: false, reason: "This thread has no turn running, so nothing is ahead of that message" }
        }
        void noteSubAgentsEndedByInterrupt(
          { tailer: ctx.tailer, storage: ctx.storage, log: (line) => frizzLog.info("interrupt", line) },
          { slug: input.slug, sessionId: row.session_id, before: childrenBefore, interruptedAtMs: Date.now() },
        )
        // The next turn opens on the queue, so those messages are read rather than waiting — say so now
        // instead of leaving them gray until their delivery records reach disk, which is the entire wait
        // this button exists to end. The ledger is not JSONL bytes, so the frame has to be emitted here.
        if (deliverOutstandingDeliveries(ctx.storage, input.slug)) ctx.transcriptChange.emit([input.slug])
        return { interrupted: true, ...(released > 0 ? { released } : {}) }
      },
    }),

    // COMPACT NOW — the button in the context meter's hover panel (CompactThreadInput). Each harness
    // already has its own manual compaction, so this only reaches it: a broker Claude row is sent the
    // literal `/compact`, which the Agent SDK runs as a local slash command (probed against the pinned
    // SDK 2026-09-26: `system/compact_boundary` with trigger "manual", then a `Compacted` local-command
    // record — no model turn), and an app-server codex row gets `thread/compact/start`.
    //
    // NOT a follow-up, although the Claude half travels the same channel: no ledger entry (the
    // transcript's own compaction divider is the receipt), no gap note (Claude Code reads text after
    // `/compact` as summarization instructions, so the note would steer the summary), and no reopen or
    // un-park — tidying a thread's context says nothing about whether it should wake.
    //
    // Refused mid-turn. A queued `/compact` did wait for a plain turn to end in the probe, but a turn
    // with tool calls can splice queued input in between them, where the text is no longer a command;
    // the panel offers the button only at rest, and this is the same rule for a stale tab.
    compactThread: mutation({
      input: CompactThreadInput,
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        if (!row) throw new Error("This thread is no longer the session this tab is looking at")
        if (hasPendingPermissionChange(row)) throw new Error("Wait for the current permission change to finish, then compact")
        const telemetry = ctx.tailer.get(input.slug)
        if (telemetry?.turn === "in-flight") throw new Error("Wait for the current turn to end, then compact")
        if (row.backend === "codex") {
          const bridge = ctx.codexAppServer
          if (!bridge) throw new Error("Codex app-server is unavailable; cannot compact this thread")
          if (row.codex_runtime !== "app-server") throw new Error("Send this thread a message first — it predates the Codex app-server")
          const binding = bridge.binding(input.slug, row.session_id)
          if (!binding || binding.state !== "active") await bridge.resumeOwnedSession(input.slug, row.session_id)
          await bridge.compactThread(input.slug, row.session_id)
          ctx.board.refresh()
          return
        }
        if (row.backend !== "claude" || row.claude_runtime !== "broker") {
          throw new Error("This thread's runtime can't be compacted from Frizz")
        }
        const bridge = ctx.claudeBroker
        if (!bridge) throw new Error("Claude session broker is unavailable; cannot compact this thread")
        // The same cold-resume inputs a follow-up carries: a hibernated daemon is resumed to run the
        // command, and it must come back as the worker it was.
        const appendSystemPrompt = claudeWorkerSystemPrompt(row.session_id, ctx.project.dir)
        await bridge.followUp({
          threadSlug: input.slug,
          sessionId: row.session_id,
          cwd: ctx.project.dir,
          text: "/compact",
          permissionMode: coldResumePermission(row, ctx.getSettings()),
          appendSystemPrompt,
          model: row.model ?? undefined,
          effort: row.effort ?? undefined,
          // A process latched on its own usage-limit 429 cannot summarize any more than it can answer.
          freshProcess: needsFreshProcessForLimit(telemetry?.limitFault, Date.now(), mayHaveLiveBackgroundWork(telemetry)),
        })
        // The bridge accepted the command, so a deliberate stop is over — see followUp's same write.
        if (row.exited === 1) ctx.storage.setExitedIfCurrent(input.slug, row.session_id, row.runtime_generation ?? 0, false)
        ctx.board.refresh()
      },
    }),

    // Per-thread permission/sandbox control. Idle conversations reattach with backend-native launch
    // flags; active work, pending approvals, and unsent native drafts fail closed with a precise error.
    setThreadPermission: mutation({
      input: SetThreadPermissionInput,
      output: SetThreadPermissionResult,
      handler: async ({ input }) => {
        const thread = (await ctx.board.snapshot()).threads.find((t) => t.id === input.slug)
        if (!thread || thread.foreign || thread.kind !== "session") throw new Error(`thread ${input.slug} is not editable`)
        // EVERY codex thread persists its sandbox and applies it on the next turn: there is no separate
        // worker process to reattach. Keying this on `codex_runtime === "app-server"` instead of the
        // backend let a LEGACY codex row (dispatched pre-cutover, codex_runtime NULL, not yet migrated)
        // fall into the CLAUDE-only permission controller that used to follow, which would have read its
        // Codex TUI as a Claude composer. That controller is gone (see the Claude branch below), but the
        // BACKEND test stays: followUp branches the same way and migrates such a row on contact.
        const permRow = ctx.storage.getSession(input.slug)
        if (permRow?.backend === "acp") throw new Error("An ACP agent enforces its own permissions; Frizz has no mode to set on it")
        if (permRow?.backend === "codex") {
          // Persist FIRST and unconditionally: the registry is the operator's stated intent, it is what
          // every later cold resume now carries (resumeSandboxOverride), and it must survive even if the
          // eager apply below cannot reach the app-server.
          ctx.storage.setPermissionMode(input.slug, input.permissionMode)
          ctx.board.refresh()
          // Then apply it to the LIVE thread. Before this the handler stopped at the line above and told
          // the operator "saved for the next resume" — a promise nothing kept, because no resume path
          // sent a sandbox at all. `thread/settings/update` retunes a loaded thread in place, and the
          // bridge only reports `applied` once the app-server's own `thread/settings/updated`
          // notification confirms the new policy.
          const bridge = ctx.codexAppServer
          const sandbox = codexSandbox(input.permissionMode) as CodexSandboxMode
          if (bridge && bridge.binding(input.slug, permRow.session_id)) {
            try {
              const applied = await bridge.setSandbox({ threadSlug: input.slug, sessionId: permRow.session_id, sandbox })
              // A change made against a RUNNING turn is accepted and durable, but the running turn keeps
              // the policy it started under — so say "next turn", never "applied to the live session".
              if (applied.applied) return { effect: applied.turnInFlight ? "next-turn" as const : "applied" as const }
            } catch {
              // A bridge that cannot reach the app-server (or a thread it no longer holds) is not an
              // error the operator needs to see: the intent is already persisted and the next resume
              // carries it. Fall through to the pre-existing "next-resume" answer.
            }
          }
          return { effect: "next-resume" as const }
        }
        // Claude: persist the operator's intent, then RETIRE THE WORKER PROCESS so the next turn starts
        // under the new launch flag.
        //
        // Retiring it is not a heavy-handed reading of "change the mode" — it is the only reading real
        // `claude` allows. A live session cannot be moved to bypass at all: the SDK's `setPermissionMode`
        // is refused with "Cannot set permission mode to bypassPermissions because the session was not
        // launched with --dangerously-skip-permissions", measured against the real binary in
        // `_live_sdk_mode_switch.mts` (the session survives the refusal; it simply stays as it was). And
        // a daemon idles for six hours before it exits on its own, so a mode that waits for the process
        // to die naturally is a mode the operator does not get today.
        //
        // Nothing durable is lost. This is the Restart worker verb's mechanism — the transcript is on
        // disk and the next follow-up cold-resumes it with the worker contract rebuilt — and its cost is
        // the in-memory sub-agents. That cost is why the client fences this control on a thread that is
        // idle and has no unresolved background operation (threadPermissions.ts), and why the effect
        // reported below is `next-turn` rather than `applied`: no turn is running to apply it TO.
        //
        // This used to branch — a broker row persisted and reported next-resume, while a TERMINAL-backed
        // row went through the permission controller, which inspected the live TUI's composer to protect
        // an unsent draft and then relaunched the conversation with a different launch flag. No row runs
        // in a terminal any more, so that whole apparatus (permission-controller.ts, 421 lines of screen
        // scraping) went with the transport it served and this is the only path left.
        ctx.storage.setPermissionMode(input.slug, input.permissionMode)
        ctx.board.refresh()
        // `next-resume` is the honest answer when there was no process to retire: the intent is stored
        // and the next start — whenever that is — reads it.
        const retired = permRow?.session_id !== undefined && ctx.claudeBroker?.retireDaemon({
          threadSlug: input.slug,
          sessionId: permRow.session_id,
        }) === true
        return { effect: retired ? "next-turn" as const : "next-resume" as const }
      },
    }),

    threadProfileOptions: query({
      input: ThreadProfileOptionsInput,
      output: ThreadProfileOptionsResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not editable`)
        const claudeModels = row.backend === "claude"
          ? await readClaudeModels({ claudeBin: ctx.claudeBin, cwd: ctx.project.dir })
          : undefined
        return threadProfileOptions(row.backend, claudeModels, readCodexModels(undefined, ctx.codexVersion))
      },
    }),

    // The composer's `/` typeahead asks the thread's HARNESS for its skills — the broker daemon's
    // `supportedCommands()` for Claude, the app-server's `skills/list` for Codex. Frizz owns no skill
    // discovery of its own, on purpose: the harness already resolves plugins, project and global roots
    // and enable state, and a frizz-side scan could only drift from what the session actually loaded.
    // Unavailability (no live daemon, a legacy row, an old broker) THROWS with a reason; the web treats
    // any failure as "no suggestions" rather than surfacing an error.
    threadSkills: query({
      input: ThreadSkillsInput,
      output: ThreadSkillsResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} has no session to ask for skills`)
        let skills: ThreadSkill[]
        if (row.backend === "acp") {
          skills = [] // an ACP agent's skills are its own; the protocol lists commands, not skills
        } else if (row.backend === "codex") {
          if (!isAppServerCodexRow(row) || !ctx.codexAppServer) {
            throw new Error("This Codex thread has no app-server session to ask for skills")
          }
          skills = await ctx.codexAppServer.listSkills(input.slug, row.session_id)
        } else {
          if (row.claude_runtime !== "broker" || !ctx.claudeBroker) {
            throw new Error("This Claude thread has no broker session to ask for skills")
          }
          skills = await ctx.claudeBroker.listSkills({ threadSlug: input.slug, sessionId: row.session_id })
        }
        return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)) }
      },
    }),

    // The prompt box's MCP menu — the plug in its icon row. mcp-status.ts decides where a reading comes
    // from (a thread's live session, the project's Claude probe, the Codex app-server) and owns the
    // sign-in attempts. Unavailability THROWS with a reason, which the menu shows in place of the list.
    mcpStatus: query({
      input: McpStatusInput,
      output: McpStatusResult,
      handler: async ({ input }) => {
        if (!ctx.mcp) throw new Error("MCP status is not available on this server")
        return await ctx.mcp.status(input)
      },
    }),

    mcpSignIn: mutation({
      input: McpSignInInput,
      output: McpSignInResult,
      handler: async ({ input }) => {
        if (!ctx.mcp) throw new Error("MCP sign-in is not available on this server")
        return await ctx.mcp.signIn(input.target, input.server)
      },
    }),

    mcpSignInPoll: query({
      input: McpSignInAttemptInput,
      output: McpSignInPollResult,
      handler: async ({ input }) => {
        if (!ctx.mcp) throw new Error("MCP sign-in is not available on this server")
        return ctx.mcp.poll(input.attemptId)
      },
    }),

    // The paste box: the address a sign-in's last page landed on, from a browser that could not reach this
    // machine's `localhost`. Delivered only to the loopback port that attempt's own redirect named.
    mcpSignInFinish: mutation({
      input: McpSignInFinishInput,
      output: McpSignInPollResult,
      handler: async ({ input }) => {
        if (!ctx.mcp) throw new Error("MCP sign-in is not available on this server")
        return await ctx.mcp.finish(input.attemptId, input.callbackUrl)
      },
    }),

    mcpSignInCancel: mutation({
      input: McpSignInAttemptInput,
      output: McpSignInPollResult,
      handler: async ({ input }) => {
        if (!ctx.mcp) throw new Error("MCP sign-in is not available on this server")
        return ctx.mcp.cancel(input.attemptId)
      },
    }),

    setThreadProfile: mutation({
      input: SetThreadProfileInput,
      output: SetThreadProfileResult,
      handler: async ({ input }) => {
        const thread = (await ctx.board.snapshot()).threads.find((candidate) => candidate.id === input.slug)
        if (!thread || thread.foreign || thread.kind !== "session") throw new Error(`thread ${input.slug} is not editable`)
        // Codex takes model/effort per turn (turn/start) — no process handoff at all. Persist them; the
        // next follow-up turn picks them up. Branch on the BACKEND, not codex_runtime: the profile
        // controller that used to follow was Claude-only, so a legacy (unmigrated) codex row must not
        // reach its reattach.
        const profRow = ctx.storage.getSession(input.slug)
        if (profRow?.backend === "acp") {
          // The model rides the row's slug (`acp:<agent>@<model>`) and has no effort axis. The AGENT
          // cannot change under a session — the ACP session belongs to the process that opened it —
          // so a slug naming another agent is refused. A live session takes the model now through
          // session/set_config_option; otherwise the slug is applied when the session next opens.
          if (acpAgentIdFromModel(input.model) !== acpAgentIdFromModel(profRow.model ?? "")) {
            throw new Error("An ACP thread's agent cannot change; pick a model of the same agent")
          }
          ctx.storage.setProfile(input.slug, input.model, "")
          const live = ctx.acpBridge ? await ctx.acpBridge.setModel(input.slug, profRow.session_id, acpModelIdFromModel(input.model)) : { applied: false }
          ctx.board.refresh()
          return { effect: live.applied ? "applied" as const : "next-resume" as const }
        }
        if (!input.effort) throw new Error(`effort is required for a ${profRow?.backend ?? "claude"} thread`)
        if (profRow?.backend === "codex") {
          ctx.storage.setProfile(input.slug, input.model, input.effort)
          ctx.board.refresh()
          return { effect: "next-resume" as const }
        }
        // Claude: model/effort are fixed at fork time (the SDK takes them at query start), so a live
        // daemon cannot retune mid-session. Persist the intent and let the next cold-resume fork carry
        // it. The terminal-backed branch that used to follow — profile-controller relaunching the
        // conversation under new flags after inspecting the composer for an unsent draft — went with the
        // transport it served.
        validateThreadProfile("claude", input.model, input.effort)
        ctx.storage.setProfile(input.slug, input.model, input.effort)
        ctx.board.refresh()
        return { effect: "next-resume" as const }
      },
    }),

    // The composer's one-click model upgrade: move a Claude thread whose worker runs an older edition of
    // its family ("Opus 5") onto the one the pinned runtime resolves the family to now ("Opus 5.5"). The
    // row keeps its alias — `opus` is already right — so there is nothing to persist; the act is retiring
    // the daemon, and the next turn cold-resumes the transcript in a process forked from the current pin.
    // See claude-model-upgrade.ts. Refused unless the thread is at rest with nothing in flight, the same
    // gate the upgrade at compaction uses, because a retire kills a running turn and its sub-agents.
    upgradeThreadModel: mutation({
      input: UpgradeThreadModelInput,
      output: UpgradeThreadModelResult,
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        if (!row || !isBrokerClaudeRow(row)) throw new Error("Only a Claude thread Frizz runs can be upgraded")
        const telemetry = ctx.tailer.get(input.slug)
        const newer = claudeModelStanding(telemetry?.model, peekClaudeModels())?.newer
        if (!newer) throw new Error("This thread already runs the newest edition of its model")
        const candidate = claudeUpgradeCandidate({ stateDir: ctx.project.stateDir, projectId: ctx.project.id, storage: ctx.storage, telemetry }, row)
        // No live worker: the next turn already forks from the current pin. Nothing to retire.
        if (!candidate) return { effect: "next-turn" as const, label: newer.label }
        const blockedBy = claudeModelUpgradeBlock(candidate, Date.now())
        if (blockedBy) throw new Error(claudeModelUpgradeRefusal(blockedBy))
        ctx.claudeBroker?.retireDaemon({ threadSlug: input.slug, sessionId: row.session_id })
        ctx.board.refresh()
        return { effect: "next-turn" as const, label: newer.label }
      },
    }),

    // Archive = hide the row (UI flag) AND settle the frizz doc: a non-terminal thread gets
    // status: done written to its frontmatter. Respawn/resume un-archives the row.
    archiveThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        // `setState`, NOT the legacy `setArchived`. The two are not synonyms: `setArchived` writes only
        // the historical `archived` column, and `effectiveSessionState` (board.ts) consults that column
        // ONLY when `state` is NULL — "an explicit state write wins". Every row the current dispatch
        // path creates has `state = "open"` written explicitly, so this RPC set a bit nothing reads and
        // answered success while the card stayed exactly where it was. Caught 2026-08-08 archiving a
        // thread over the RPC: `archived = 1` in SQLite, `archived: false` on the board, forever.
        ctx.storage.setState(input.slug, "archived")
        const t = (await ctx.board.snapshot()).threads.find((x) => x.id === input.slug)
        if (!isAutoTitledSession(input.slug) && t && t.status !== "done" && t.status !== "dismissed") {
          await runThreadUpdate(ctx.project.dir, input.slug, ["--status", "done"]).catch(() => {})
        }
        void ctx.board.rebuild().catch(() => {}) // .frizz changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    markRead: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        ctx.storage.markRead(input.slug)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // Read/seen telemetry only: opening a thread records both seen_at and last_read_at. Queue
    // membership is lifecycle-driven, so viewing a resting handoff never acknowledges or removes it.
    // No-op for a foreign thread (no registry row — foreign threads never enter the queue).
    threadSeen: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        if (!ctx.storage.getSession(input.slug)) return
        const at = new Date().toISOString()
        ctx.storage.setSeenAt(input.slug, at)
        ctx.storage.markRead(input.slug, at)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // Explicit lifecycle write for session threads: Archive (the done-card button / row action) and
    // Reopen. This is the ONLY writer of state='archived' — the done fence itself mutates nothing
    // (maintainer-settled). Touches only ui.db; never the .frizz legacy files.
    setThreadState: mutation({
      input: z.object({ slug: ThreadSlug, state: z.enum(["open", "archived"]) }).strict(),
      handler: async ({ input }) => {
        if (!ctx.storage.getSession(input.slug)) throw new Error(`no session registered for ${input.slug}`)
        ctx.storage.setState(input.slug, input.state)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // “Mark as done” stops a resting provider shell and archives in one action. The server—not the
    // client—asks for confirmation only when current telemetry shows an executing/ambiguous turn.
    completeThread: mutation({
      input: z.object({ slug: ThreadSlug, sessionId: z.string().min(1), terminateLive: z.boolean().default(false) }).strict(),
      // `hold` rides along only with needsConfirmation:true — it is the evidence the dialog names.
      output: z.object({ needsConfirmation: z.boolean(), hold: CompletionHold.optional() }),
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        const result = await completeRegisteredThread(
          ctx.storage, row, input.terminateLive, cachedLivenessTerminator, ctx.tailer.get(input.slug), ctx.codexAppServer, ctx.claudeBroker, ctx.acpBridge,
        )
        if (!result.needsConfirmation) ctx.board.refresh()
        return result
      },
    }),

    // Durable manual snooze. The client sends one exact UTC instant derived from its local picker;
    // Archive clears it, Wake now (`until: null`) is the explicit un-park, and a follow-up clears it too
    // (see followUp) — Wake now is for un-parking WITHOUT sending a turn. The operator may deliberately
    // park any queue reason—including an unresolved ask, permission prompt, or crash—until this deadline.
    //
    // An optional `prompt` upgrades the park into a SCHEDULED BUMP: at the deadline the wake scheduler
    // resumes this thread with that text over the same durable outbox a worker's `awaiting timer:` uses
    // (scheduler.ts, SOURCE 3). Without one the snooze stays what it always was — the card re-surfaces
    // and the human acts. `until: null` (wake now) clears both halves.
    setThreadSnooze: mutation({
      input: SetThreadSnoozeInput,
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        const thread = (await ctx.board.snapshot()).threads.find((candidate) => candidate.id === input.slug)
        if (!thread || thread.kind !== "session" || thread.foreign) throw new Error(`thread ${input.slug} is not editable`)
        if (input.until !== null) {
          if (thread.state === "archived") throw new Error("Reopen this thread before snoozing it")
          if (Date.parse(input.until) <= Date.now()) throw new Error("Snooze time must be in the future")
        }
        // `until: null` is Wake now: setSnoozedUntil clears the instant and the bump it owed together.
        ctx.storage.setSnoozedUntil(input.slug, input.until, input.prompt ?? null)
        // …and either way the event-snooze ("Until activity") goes with it: Wake now wakes the thread
        // from whichever park it is in, and a clock picked over an activity snooze replaces it rather
        // than sitting beside it (see snoozeAwaitingBackground).
        if (row.bg_snooze_rested_at != null) ctx.storage.setBgSnoozeRestedAtIfCurrent(input.slug, row.session_id, row.runtime_generation ?? 0, null)
        ctx.board.refresh()
      },
    }),

    // Pin/unpin: the human lifts a thread out of the rail's band system into the pinned band at the
    // very top (or drops it back in). Same editability gate as the snooze, but NO archived refusal —
    // the pin deliberately outranks Done, so a pinned thread that finishes stays pinned until unpinned.
    setThreadPinned: mutation({
      input: SetThreadPinnedInput,
      handler: async ({ input }) => {
        currentOwnedSession(input.slug, input.sessionId)
        const thread = (await ctx.board.snapshot()).threads.find((candidate) => candidate.id === input.slug)
        if (!thread || thread.kind !== "session" || thread.foreign) throw new Error(`thread ${input.slug} is not editable`)
        ctx.storage.setPinnedAt(input.slug, input.pinned ? new Date().toISOString() : null)
        ctx.board.refresh()
      },
    }),

    // A drag in the pinned band: the band's new order, top first. Storage re-deals the pin instants the
    // band is sorted by (storage.ts reorderPinned), so the order survives a reload and reaches every tab
    // and the phone board through the same board refresh a pin does.
    reorderPinnedThreads: mutation({
      input: ReorderPinnedThreadsInput,
      handler: async ({ input }) => {
        ctx.storage.reorderPinned(input.slugs)
        ctx.board.refresh()
      },
    }),

    // The CONSOLE's pin — the "By status" view's own shelf, kept apart from the project board's pin
    // above (ThreadView.consolePinnedAt). Same gate as the project pin: a session Frizz owns, in any
    // state, so the Console's pin outranks Done as the board's does.
    setThreadConsolePinned: mutation({
      input: SetThreadConsolePinnedInput,
      handler: async ({ input }) => {
        currentOwnedSession(input.slug, input.sessionId)
        const thread = (await ctx.board.snapshot()).threads.find((candidate) => candidate.id === input.slug)
        if (!thread || thread.kind !== "session" || thread.foreign) throw new Error(`thread ${input.slug} is not editable`)
        ctx.storage.setConsolePinnedAt(input.slug, input.pinned ? new Date().toISOString() : null)
        ctx.board.refresh()
      },
    }),

    // A drag in the Console's pinned band, as THIS project's share of it: the new instants of its own
    // threads that moved. The browser deals them, because the band spans every project and no one
    // project's storage holds the whole shelf (shared ReorderConsolePinnedThreadsInput).
    reorderConsolePinnedThreads: mutation({
      input: ReorderConsolePinnedThreadsInput,
      handler: async ({ input }) => {
        ctx.storage.placeConsolePins(input.pins)
        ctx.board.refresh()
      },
    }),

    // THE RECURRING PROMPT (scheduler.ts SOURCES 4 and 5), from the Goal panel. One mutation for the
    // text, both triggers and the cadence, because they are all views of one row: split apart, a tab
    // holding a stale copy of one field would clobber the rest on save.
    //
    // Storage decides whether this is a fresh arming or an edit (it keeps the generation when the text
    // and the interval are both unchanged), so flipping a trigger off and on cannot supersede a delivery
    // already in flight for those same words, while editing the words does exactly that.
    setThreadRecurringPrompt: mutation({
      input: SetThreadRecurringPromptInput,
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        assertRecurringPromptArmable(input, row)
        if (!ctx.storage.setRecurringPromptIfCurrent(input.slug, row.session_id, row.runtime_generation ?? 0, {
          prompt: input.prompt,
          stopHook: input.stopHook,
          heartbeat: input.heartbeat,
          postCompaction: input.postCompaction,
          intervalMs: recurringIntervalMs(input),
          armedAt: new Date().toISOString(),
        })) {
          throw new Error("This thread moved on; reopen it and try again")
        }
        // TURNING IT ON CANCELS WHAT THE THREAD WAS WAITING TO BE TOLD. Checked as a TRANSITION, not as
        // a state: every edit in the Goal panel rewrites this whole row (the text, the three triggers
        // and the cadence are one save), so re-firing on an unrelated cadence edit would quietly bin a
        // question the worker registered a moment ago.
        //
        // AND THE CANCELLATION WAKE GOES NOW, for answerQuestions' reason exactly: the human is right
        // here, and up to a whole tick of the question card gone with nothing in its place read as a
        // thread that rested without saying anything (maintainer 2026-09-02). The durable path is
        // unchanged — the sweep just runs immediately.
        if (input.stopHook && input.prompt?.trim() && autonomousGoal(row) === undefined) {
          if (cancelQuestionsForAutonomy(input.slug) > 0) ctx.scheduler.kick()
        }
        ctx.board.refresh()
      },
    }),

    // The WORKER arming its own, from `frizzctl goal`. Same row the Goal panel writes;
    // different caller, and therefore a different guard.
    //
    // Unguarded on session/generation ON PURPOSE — see SetOwnThreadRecurringPromptInput. The MCP server
    // knows only its slug, which frizz stamped into its env at spawn and which survives every resume,
    // while the session id underneath it does not. It is not attacker-supplied: a model can choose the
    // TEXT but never the thread, so there is deliberately no slug parameter it could aim elsewhere. One
    // agent making a DIFFERENT thread loop forever is not a capability frizz hands out.
    setOwnThreadRecurringPrompt: mutation({
      input: SetOwnThreadRecurringPromptInput,
      output: SetOwnThreadRecurringPromptResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not registered`)
        assertRecurringPromptArmable(input, row)
        // Read off the row we already hold, BEFORE the write — so the tool can name what it superseded
        // without a second call and without a race against a footer edit landing in between.
        const replaced = resolveRecurringPrompt(row) ?? null
        if (!ctx.storage.setRecurringPromptBySlug(input.slug, {
          prompt: input.prompt,
          stopHook: input.stopHook,
          heartbeat: input.heartbeat,
          postCompaction: input.postCompaction,
          intervalMs: recurringIntervalMs(input),
          armedAt: new Date().toISOString(),
        })) {
          throw new Error(`thread ${input.slug} could not be updated`)
        }
        // Same transition, same consequence: a worker arming its own Goal has said it will decide the
        // rest, and leaving its own questions on the human's board would be asking for answers it just
        // announced it no longer needs. Same immediate sweep, too — the cancellation wake is what tells
        // the worker its questions are gone, and it should not sit a tick away.
        if (input.stopHook && input.prompt?.trim() && autonomousGoal(row) === undefined) {
          if (cancelQuestionsForAutonomy(input.slug) > 0) ctx.scheduler.kick()
        }
        ctx.board.refresh()
        return { replaced }
      },
    }),

    // The READ. A worker had no way to see the row it was writing: not after a compaction took the text
    // with it, and not after the human edited it in the Goal panel — so every arming was blind, and a
    // `start` meant to adjust one trigger silently rewrote the human's words. This answers with the same
    // projection the board shows, so the two readers can never disagree.
    //
    // A MUTATION despite reading nothing, for `listOwnThreadTimers`'s reason exactly: the worker's MCP
    // server POSTs every call through one `callRpc` helper, and a procedure declared as a query answers
    // only GET. That helper ships inside every dispatched session and cannot be updated under a live
    // worker, so the shape that ages best is the one it already speaks.
    getOwnThreadRecurringPrompt: mutation({
      input: GetOwnThreadRecurringPromptInput,
      output: OwnThreadRecurringPromptResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not registered`)
        return { recurringPrompt: resolveRecurringPrompt(row) ?? null }
      },
    }),

    // ---- THE WORKER'S ONE-OFF TIMERS (scheduler SOURCE 6) ----------------------------------------
    // Three mutations, from `frizzctl timer`. Same caller as the recurring prompt above and therefore
    // the same guard: keyed on the slug alone, because the MCP server keeps its slug across every resume
    // while the session id underneath it bumps.
    //
    // `listOwnThreadTimers` is a MUTATION despite reading nothing, and that is transport, not taxonomy:
    // the worker's MCP server POSTs every call through one `callRpc` helper, and a procedure declared as
    // a query answers only GET. It is also the shape that ages best — that helper ships inside every
    // dispatched session and cannot be updated under a live worker.
    //
    // All three answer with the thread's CURRENT armed set, so a worker never needs a second call to see
    // what it now holds.
    setOwnThreadTimer: mutation({
      input: SetOwnThreadTimerInput,
      output: SetOwnThreadTimerResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not registered`)
        if (row.state === "archived" || row.archived === 1) {
          throw new Error("Reopen this thread before setting a timer on it")
        }
        const armed = ctx.storage.listThreadTimers(input.slug, { armedOnly: true })
        // The cap is what makes "arbitrarily many" safe to offer: a tool call in a loop cannot fill the
        // table, and the refusal names the ceiling so the worker cancels rather than retrying.
        if (armed.length >= TIMER_MAX_ARMED) {
          throw new Error(`this thread already has ${armed.length} armed timers (the limit is ${TIMER_MAX_ARMED}) — cancel one first`)
        }
        const id = `tmr_${randomUUID().replace(/-/g, "").slice(0, 12)}`
        // A REGISTRATION TRUMPS A DONE (maintainer 2026-08-27: "done always gets trumped by a watcher or a
        // question"). `done` refuses while any of these is live, so the only way both can exist is a
        // worker that signed off and then armed something — and a thread with a wait ahead of it is not
        // finished. Clearing the row here, at the registering verb, is what keeps the board from ever
        // holding a done card and a live wait about the same rest.
        ctx.storage.clearThreadDone(input.slug)
        ctx.storage.armThreadTimer({
          id,
          slug: input.slug,
          prompt: input.prompt,
          fireAtMs: Date.parse(input.fireAt),
          createdAtMs: Date.now(),
        })
        // So the rail shows the new timer at once, as addOwnPrWatch does for a PR, rather than at the
        // next tailer change or the board's 15s reconcile.
        ctx.board.refresh()
        return { id, fireAt: input.fireAt, timers: armedTimerViews(input.slug) }
      },
    }),

    cancelOwnThreadTimer: mutation({
      input: CancelOwnThreadTimerInput,
      output: CancelOwnThreadTimerResult,
      handler: async ({ input }) => {
        // Scoped to the caller's own slug in storage, so an id belonging to another thread cannot be
        // cancelled even if a worker somehow learned it.
        const cancelled = ctx.storage.cancelThreadTimer(input.slug, input.id, Date.now())
        if (cancelled) ctx.board.refresh()
        return { cancelled, timers: armedTimerViews(input.slug) }
      },
    }),

    listOwnThreadTimers: mutation({
      input: ListOwnThreadTimersInput,
      output: OwnThreadTimersResult,
      handler: async ({ input }) => ({ timers: armedTimerViews(input.slug) }),
    }),

    // EVERY kind of background work this thread has out, with the id its awaiting fence names it by.
    //
    // The fence is structural — it references live things by id — so a worker that no longer has those
    // ids to hand cannot write a correct fence at all, and the failure is silent: it names something
    // wrong, frizz refuses the park, and the thread queues. That is the exact stall the grammar exists
    // to prevent, so the ids have to be RETRIEVABLE rather than remembered. Same list the sign-off nudge
    // prints, from the same source, so the two can never tell a worker different things.
    //
    // A shell is keyed by its RUNTIME task id ("Command running in background with ID: bzvtnt3ig"),
    // never its launch tool_use id: that is the string the worker was actually shown and the one it will
    // reach for. Falls back to the launch id only when the ack has not landed yet.
    listOwnThreadActivity: mutation({
      input: ListOwnThreadActivityInput,
      output: OwnThreadActivityResult,
      handler: async ({ input }) => {
        const tele = ctx.tailer.get(input.slug)
        const activity: OwnThreadActivityResult["activity"] = []
        // The armed watches, keyed by every handle they could have been registered against, so an item
        // below can name the `wch_…` id that holds it without a second lookup per row.
        const watchOf = new Map<string, string>()
        for (const w of ctx.storage.listThreadWatches(input.slug, { armedOnly: true })) watchOf.set(`${w.kind}:${w.target}`, w.id)
        const watchFor = (kind: "shell" | "agent", handles: readonly (string | undefined)[]) => {
          for (const h of handles) {
            const hit = h ? watchOf.get(`${kind}:${h}`) : undefined
            if (hit) return { watchId: hit }
          }
          return {}
        }
        for (const sh of tele?.bgShells ?? []) {
          if (sh.state !== "running") continue
          const id = sh.taskId ?? sh.id
          if (id) activity.push({ kind: "shell", id, label: sh.label, since: sh.startedAt, ...watchFor("shell", [sh.taskId, sh.id, sh.label]) })
        }
        for (const a of tele?.subAgents ?? []) {
          if (a.state !== "running") continue
          if (a.id) activity.push({ kind: "agent", id: a.taskId ?? a.id, label: a.label, since: a.startedAt, ...watchFor("agent", [a.taskId, a.id, a.label]) })
        }
        for (const t of ctx.storage.listThreadTimers(input.slug, { armedOnly: true })) {
          activity.push({
            kind: "timer", id: t.id, label: t.prompt.trim().replace(/\s+/g, " ").slice(0, 120),
            since: new Date(t.created_at).toISOString(), until: new Date(t.fire_at).toISOString(),
          })
        }
        for (const w of ctx.storage.listPrWatches(input.slug, { armedOnly: true })) {
          activity.push({
            kind: w.kind === "issue" ? "issue" : "pr", id: `${w.owner}/${w.repo}#${w.number}`, label: `${w.owner}/${w.repo}#${w.number}`,
            since: new Date(w.created_at).toISOString(),
            ...(w.expires_at ? { until: new Date(w.expires_at).toISOString() } : {}),
          })
        }
        for (const w of ctx.storage.listCommandWatches(input.slug, { armedOnly: true })) {
          activity.push({
            kind: "command", id: w.id, label: w.command.trim().replace(/\s+/g, " ").slice(0, 120),
            since: new Date(w.created_at).toISOString(), until: new Date(w.expires_at).toISOString(),
          })
        }
        // The WATCHES are already readable: each armed one rides its live item as `watchId`, and the
        // scheduler settles a watch the tick its target stops being live, so an armed row always has an
        // item to ride. The QUESTIONS had nowhere at all — hence their own list.
        return { activity, questions: openQuestionViews(input.slug), links: ctx.storage.listThreadLinks(input.slug).map(threadLinkView) }
      },
    }),

    // THE WATCHER REGISTRY WAS DELETED ON 2026-08-14 AND CAME BACK ON 2026-08-26, under two narrow verbs
    // rather than the four it had. It was removed because a wait had become a `watch:` line in the
    // worker's own ```awaiting fence, which was BOTH the park and the wake — leaving nothing to register.
    // The fence turned out to be the wrong object for a wait: it has the lifetime of the message carrying
    // it, so the worker had to restate every wait at every rest, and it was wrong the moment anything
    // changed. See plans/rest-by-registration.md, and addOwnWatch/dropOwnWatch below.
    //
    // The OLD procedure names are not aliased. A session dispatched before 2026-08-14 still holds an MCP
    // binary naming them and gets a 404, which is the honest answer: its arguments do not fit this
    // registry (there is no `for:` in them at all), so an alias would have to invent the one field that
    // must not be guessed at.

    upsertOwnLink: mutation({
      input: UpsertOwnLinkInput,
      output: UpsertOwnLinkResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not registered`)
        if (row.state === "archived" || row.archived === 1) throw new Error("Reopen this thread before registering a link")
        const destination = resolveThreadLink(input.target, ctx.project.dir, openRoots)
        const link = ctx.storage.upsertThreadLink({
          id: `lnk_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
          slug: input.slug, label: input.label, ...destination, createdAtMs: Date.now(),
        })
        // Unlike a watch or question, a saved destination does not revoke a completion.
        ctx.board.refresh()
        return { link: threadLinkView(link) }
      },
    }),
    dropOwnLink: mutation({
      input: DropOwnLinkInput,
      output: DropOwnLinkResult,
      handler: async ({ input }) => {
        const dropped = ctx.storage.dropThreadLink(input.slug, input.id)
        if (dropped) ctx.board.refresh()
        return { dropped }
      },
    }),

    // ---- REGISTERED PR WATCHERS (add / drop / list) ---------------------------------------------
    // The worker's own PR watchers, from `frizzctl watch-pr`. Same caller and therefore the same rules
    // as the timers above: slug-only (the MCP server outlives the session ids underneath it), and no
    // thread parameter a model could aim elsewhere.
    addOwnPrWatch: mutation({
      input: AddOwnPrWatchInput,
      output: AddOwnPrWatchResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not registered`)
        if (row.state === "archived" || row.archived === 1) {
          throw new Error("Reopen this thread before registering a watcher on it")
        }
        // A PULL REQUEST unless the caller says `issue` (2026-09-14, `frizzctl watch-issue`). Same
        // registry and same rules below; the ref grammar, the probe and the refusal wording branch.
        const kind = input.kind ?? "pull"
        const noun = kind === "issue" ? "issue" : "pull request"
        // REFUSED, not stored. A watcher on a ref frizz cannot parse is one that can never fire, and a
        // worker that registers one comes to rest believing it is covered.
        const ref = kind === "issue" ? parseIssueRef(input.target) : parsePrRef(input.target)
        if (!ref) {
          throw new Error(`\`${input.target}\` is not ${kind === "issue" ? "an issue" : "a pull request"} I can watch — give owner/repo#123 or ${kind === "issue" ? "an issue" : "a PR"} URL`)
        }
        const armed = ctx.storage.listPrWatches(input.slug, { armedOnly: true })
        // IDEMPOTENT ON THE PR. Re-registering after a compaction is the COMMON case — the worker has
        // forgotten what it holds and is being careful — and a duplicate would mean two wakes per event,
        // which reads to the operator as the watcher misfiring. Per KIND as well as ref: an issue and a
        // PR cannot share a number in one repo, so the same number registered both ways is a mistake
        // the probe catches on whichever one is wrong, never two watchers on one thing. CASE-BLIND on
        // owner and repo, as GitHub is: `acme/app#391` and `Acme/App#391` are one PR, and matching them
        // exactly put two rows on the rail and two wakes on every event.
        const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
        const existing = armed.find((w) => w.kind === kind && sameName(w.owner, ref.owner) && sameName(w.repo, ref.repo) && w.number === ref.number)
        const target = `${ref.owner}/${ref.repo}#${ref.number}`
        if (existing) {
          // The ORIGINAL expiry, which this call left alone — the re-registration is a no-op and must
          // read back as one, not as the duration it happened to pass.
          const expiresAt = new Date(existing.expires_at ?? Date.now()).toISOString()
          return { id: existing.id, target, alreadyArmed: true, expiresAt, watches: armedPrWatchViews(input.slug) }
        }
        if (armed.length >= PR_WATCH_MAX_ARMED) {
          throw new Error(`this thread already watches ${armed.length} pull requests and issues (the limit is ${PR_WATCH_MAX_ARMED}) — drop one first`)
        }
        // A MISSING `for` IS AN OLD WORKER, not a bad one — its MCP binary predates the field and
        // cannot send it (see AddOwnPrWatchInput). It gets a bounded default rather than an error,
        // because refusing would break `watch_pr` for every session already running. A PRESENT-but-
        // unparseable one IS a bad one and is refused: the worker tried to choose and got it wrong,
        // and silently substituting a number would hide that.
        const asked = input.for === undefined ? PR_WATCH_DEFAULT_FOR_MS : parseAwaitingDurationRaw(input.for)
        if (asked === null) {
          throw new Error(`\`for: ${input.for}\` is not a duration — give one like \`2h\`, \`3d\` or \`180d\` (max 365d)`)
        }
        // CLAMPED, NOT REFUSED — a fat-fingered `9999d` should still watch the PR. But the clamp is
        // REPORTED: a worker told nothing rests believing it holds a year of coverage it does not have.
        const forMs = Math.min(asked, PR_WATCH_FOR_MAX_MS)
        const clampedFrom = input.for !== undefined && asked > PR_WATCH_FOR_MAX_MS ? { clampedFrom: input.for } : {}
        // REFUSED IF THE SERVER CANNOT READ IT — the same rule as an unparseable ref, for the same
        // reason: the poll runs the server's own `gh`, and a PR it cannot see (signed out, an SSO-gated
        // org, no such repo, no `gh` on its PATH) is a watcher that fails every minute in silence while
        // the worker rests believing it is covered (a user's board, 2026-08-25: 12h+). Checked after the
        // idempotent short-circuit above, so a re-registration during a GitHub blip still answers.
        const probe = kind === "issue" ? await ctx.probeIssue(ref) : await ctx.probePr(ref)
        if (!probe.ok) {
          throw new Error(
            `\`${target}\` cannot be watched as ${kind === "issue" ? "an issue" : "a pull request"} — the server's \`gh\` could not read it: ${probe.reason}. ` +
            "Frizz polls with the `gh` of the process it runs as, not yours: check `gh auth status` there and that the repo is " +
            "reachable, then register again. If GitHub itself was briefly down, registering again in a minute is enough.",
          )
        }
        const now = Date.now()
        // The id prefix names the kind, so a `drop` id in a transcript reads as what it dropped.
        const id = `${kind === "issue" ? "isw" : "prw"}_${randomUUID().replace(/-/g, "").slice(0, 12)}`
        // A registration trumps a done — see setOwnThreadTimer.
        ctx.storage.clearThreadDone(input.slug)
        ctx.storage.armPrWatch({ id, slug: input.slug, kind, owner: ref.owner, repo: ref.repo, number: ref.number, createdAtMs: now, expiresAtMs: now + forMs })
        ctx.board.refresh()
        return { id, target, alreadyArmed: false, expiresAt: new Date(now + forMs).toISOString(), ...clampedFrom, watches: armedPrWatchViews(input.slug) }
      },
    }),

    dropOwnPrWatch: mutation({
      input: DropOwnPrWatchInput,
      output: DropOwnPrWatchResult,
      handler: async ({ input }) => {
        // Scoped to the caller's own slug in storage, so an id belonging to another thread cannot be
        // dropped even if a worker somehow learned it.
        const dropped = ctx.storage.dropPrWatch(input.slug, input.id, Date.now())
        if (dropped) ctx.board.refresh()
        return { dropped, watches: armedPrWatchViews(input.slug) }
      },
    }),

    // ---- REGISTERED COMMAND WATCHES (add / drop / list) -------------------------------------------
    // `frizzctl watch-command`: a shell command the SERVER re-runs on a cadence until it exits 0 (scheduler
    // SOURCE 13, command-watch.ts). Slug-only like every worker registry. The GATE runs before anything
    // else, the idempotent short-circuit included: whether Frizz may run commands for this thread at all
    // is the first question, and a thread that has lost the right must not be told its old watch stands.
    addOwnCommandWatch: mutation({
      input: AddOwnCommandWatchInput,
      output: AddOwnCommandWatchResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not registered`)
        if (row.state === "archived" || row.archived === 1) {
          throw new Error("Reopen this thread before registering a command watch on it")
        }
        const service = ctx.commandWatches
        const refusal = service ? service.refusal(row) : `this server cannot run command watches. ${COMMAND_WATCH_FALLBACK}`
        if (refusal) {
          return { refused: `Frizz will not run a command watch for this thread: ${refusal}`, alreadyArmed: false, passed: false, watches: armedCommandWatchViews(input.slug) }
        }
        const command = input.command.trim()
        const armed = ctx.storage.listCommandWatches(input.slug, { armedOnly: true })
        // IDEMPOTENT ON THE COMMAND TEXT, for the PR watcher's reason: re-registering after a compaction
        // is the careful case, and a second row would run the same check twice and wake twice.
        const existing = armed.find((w) => w.command === command)
        if (existing) {
          return {
            id: existing.id, alreadyArmed: true, passed: false,
            expiresAt: new Date(existing.expires_at).toISOString(), every: formatCommandWatchDuration(existing.every_ms),
            watches: armedCommandWatchViews(input.slug),
          }
        }
        if (armed.length >= COMMAND_WATCH_MAX_ARMED) {
          throw new Error(`this thread already has ${armed.length} command watches armed (the limit is ${COMMAND_WATCH_MAX_ARMED}) — drop one first`)
        }
        const everyAsked = parseAwaitingDurationRaw(input.every)
        if (everyAsked === null) throw new Error(`\`--every ${input.every}\` is not a duration — give one like \`5m\` or \`1h\` (min 1m, max 24h)`)
        const forAsked = parseAwaitingDurationRaw(input.for)
        if (forAsked === null) throw new Error(`\`--for ${input.for}\` is not a duration — give one like \`2h\` or \`3d\` (max 7d)`)
        // CLAMPED, NOT REFUSED, and REPORTED — every `for` in the product follows that rule.
        const everyMs = Math.min(COMMAND_WATCH_EVERY_MAX_MS, Math.max(COMMAND_WATCH_EVERY_MIN_MS, everyAsked))
        const forMs = Math.min(forAsked, COMMAND_WATCH_FOR_MAX_MS)
        const clamped = {
          ...(everyMs !== everyAsked ? { every: input.every } : {}),
          ...(forMs !== forAsked ? { for: input.for } : {}),
        }
        // THE FIRST CHECK, before anything is stored. Exit 0 means the condition already holds: nothing
        // is armed, and the worker carries on now instead of resting a whole cadence to be told so.
        const first = await service!.probe(input.slug, command)
        const firstRun: CommandWatchRun | undefined = first
          ? { at: new Date(first.finishedAtMs).toISOString(), outcome: first.outcome, exitCode: first.exitCode, output: first.output }
          : undefined
        if (first?.outcome === "exit" && first.exitCode === 0) {
          return { alreadyArmed: false, passed: true, firstRun, watches: armedCommandWatchViews(input.slug) }
        }
        // A COMMAND THAT CANNOT RUN HERE is refused, not armed: it would fail every check for a week while
        // the worker rests believing it waits on the condition. 127 and 126 are the shell's own "not
        // found" and "not executable" — almost always a binary on the worker's PATH and not the
        // server's. An `error` is a shell that never started.
        if (first && (first.outcome === "error" || (first.outcome === "exit" && (first.exitCode === 126 || first.exitCode === 127)))) {
          return {
            refused:
              `Frizz ran your command once to check it, and it could not run here (${first.outcome === "error" ? "the shell did not start" : `\`/bin/sh\` exited ${first.exitCode}`}). ` +
              `The server runs it with \`/bin/sh -c\` in ${ctx.project.dir}, with the server's own PATH, not your shell's: ` +
              `use absolute paths, or ${COMMAND_WATCH_FALLBACK.charAt(0).toLowerCase()}${COMMAND_WATCH_FALLBACK.slice(1)}`,
            alreadyArmed: false, passed: false, firstRun, watches: armedCommandWatchViews(input.slug),
          }
        }
        const now = Date.now()
        const id = `cmw_${randomUUID().replace(/-/g, "").slice(0, 12)}`
        // A registration trumps a done — see setOwnThreadTimer.
        ctx.storage.clearThreadDone(input.slug)
        ctx.storage.armCommandWatch({
          id, slug: input.slug, command, everyMs, createdAtMs: now, expiresAtMs: now + forMs,
          // A first check cut short by the registration's own short timeout is NOT recorded: the
          // scheduler runs it again at once with the full timeout, rather than a cadence from now.
          ...(first && first.outcome !== "timeout"
            ? { firstRun: { atMs: first.finishedAtMs, outcome: first.outcome, exitCode: first.exitCode, output: first.output } }
            : {}),
        })
        ctx.board.refresh()
        return {
          id, alreadyArmed: false, passed: false, ...(firstRun ? { firstRun } : {}),
          expiresAt: new Date(now + forMs).toISOString(), every: formatCommandWatchDuration(everyMs),
          ...(Object.keys(clamped).length ? { clamped } : {}),
          watches: armedCommandWatchViews(input.slug),
        }
      },
    }),

    dropOwnCommandWatch: mutation({
      input: DropOwnCommandWatchInput,
      output: DropOwnCommandWatchResult,
      handler: async ({ input }) => {
        // Scoped to the caller's own slug in storage, like every drop.
        const dropped = ctx.storage.dropCommandWatch(input.slug, input.id, Date.now())
        if (dropped) ctx.board.refresh()
        return { dropped, watches: armedCommandWatchViews(input.slug) }
      },
    }),

    listOwnCommandWatches: mutation({
      input: ListOwnCommandWatchesInput,
      output: OwnCommandWatchesResult,
      handler: async ({ input }) => ({ watches: armedCommandWatchViews(input.slug) }),
    }),

    // ---- THE WORKER'S OWN WATCHES on its own running work (add / drop) --------------------------
    // `frizzctl watch` and `frizzctl unwatch`. A wait stops being a line the worker restates in a
    // fence at every rest and becomes a row it creates once — see plans/rest-by-registration.md. Same
    // caller and therefore the same rules as the PR watchers above: slug-only, no thread parameter.
    addOwnWatch: mutation({
      input: AddOwnWatchInput,
      output: AddOwnWatchResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not registered`)
        if (row.state === "archived" || row.archived === 1) {
          throw new Error("Reopen this thread before registering a watch on it")
        }
        const target = input.target.trim()
        // IDEMPOTENT ON (kind, target), and checked BEFORE liveness — the same order the PR watcher
        // uses, for the same reason. Re-registering after a compaction is the common, careful case, and
        // a re-arm must never be able to move an expiry the human is already reading.
        const already = ctx.storage.listThreadWatches(input.slug, { armedOnly: true })
          .find((w) => w.kind === input.kind && w.target === target)
        if (already) {
          return { id: already.id, kind: already.kind, target, alreadyArmed: true, watches: armedOwnWatchViews(input.slug) }
        }
        // REFUSED, not stored, on both counts below. A watch that can never fire is worse than no watch,
        // because the worker rests believing it is covered.
        const live = resolveLiveWatchTarget(ctx.tailer.get(input.slug), target)
        if (!live) {
          throw new Error(
            `nothing running on this thread answers to \`${target}\` — a watch only ever names work that is ` +
            "already live, and work that has already finished needs no watch at all. Run `frizzctl activity` for the " +
            "exact ids of everything you have running.",
          )
        }
        // THE KIND IS RESOLVED FROM TELEMETRY, so a mismatch is NAMED rather than guessed at: the handles
        // are opaque on both sides and shape could never have told them apart. This is the miss that filed
        // two sub-agents under a "Background shells" heading on 2026-08-26.
        if (live.kind !== input.kind) {
          const said = input.kind === "agent" ? "sub-agent" : "background shell"
          const is = live.kind === "agent" ? "sub-agent" : "background shell"
          throw new Error(`\`${target}\` is a ${is}, not a ${said} — register it with \`frizzctl watch ${live.kind}\`.`)
        }
        const armed = ctx.storage.listThreadWatches(input.slug, { armedOnly: true })
        if (armed.length >= OWN_WATCH_MAX_ARMED) {
          throw new Error(`this thread already holds ${armed.length} watches (the limit is ${OWN_WATCH_MAX_ARMED}) — drop one first`)
        }
        // REQUIRED, and unparseable is an ERROR — unlike the PR watcher's optional `for`, which is optional
        // only for sessions whose MCP binary predates the field. This RPC has no such sessions.
        const asked = parseAwaitingDurationRaw(input.for)
        if (asked === null) {
          throw new Error(`\`for: ${input.for}\` is not a duration — give one like \`30m\`, \`2h\` or \`3d\` (max 24h)`)
        }
        // Clamped, not refused, and REPORTED — the same rule as the PR watcher above. The ceiling stays a
        // day here because this names a shell or a sub-agent, which does not outlive its session.
        const forMs = Math.min(asked, AWAITING_FOR_MAX_MS)
        const clampedFrom = asked > AWAITING_FOR_MAX_MS ? { clampedFrom: input.for } : {}
        const now = Date.now()
        const id = `wch_${randomUUID().replace(/-/g, "").slice(0, 12)}`
        // A registration trumps a done — see setOwnThreadTimer.
        ctx.storage.clearThreadDone(input.slug)
        ctx.storage.armThreadWatch({ id, slug: input.slug, kind: input.kind, target, createdAtMs: now, expiresAtMs: now + forMs })
        ctx.board.refresh()
        return { id, kind: input.kind, target, alreadyArmed: false, ...clampedFrom, watches: armedOwnWatchViews(input.slug) }
      },
    }),

    dropOwnWatch: mutation({
      input: DropOwnWatchInput,
      output: DropOwnWatchResult,
      handler: async ({ input }) => {
        // Scoped to the caller's own slug in storage, so an id belonging to another thread cannot be
        // dropped even if a worker somehow learned it.
        const dropped = ctx.storage.dropThreadWatch(input.slug, input.id, Date.now())
        if (dropped) ctx.board.refresh()
        return { dropped, watches: armedOwnWatchViews(input.slug) }
      },
    }),

    // ---- THE WORKER'S REGISTERED QUESTIONS (ask / unask) + the human's answer -------------------
    // `frizzctl ask` and `frizzctl unask`, plus the two the CARD calls. See
    // plans/rest-by-registration.md: a question stops being a fenced block with the lifetime of the
    // message carrying it and becomes a row that survives the worker saying anything else.
    //
    // NOT AN INTERACTION, deliberately. The typed `agent-question` interaction beside this one has the
    // durability and the server-minted id — but it is created by a RUNTIME ADAPTER and never by an RPC,
    // precisely so a model cannot mint one ("there is deliberately no public/provider-spoofable create
    // RPC", above). `ask` IS a model-callable RPC, so it gets its own registry rather than a hole in
    // that rule. The two converge again at the CARD, which reads both through one adapter.
    ask: mutation({
      input: AskInput,
      output: AskResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not registered`)
        if (row.state === "archived" || row.archived === 1) {
          throw new Error("Reopen this thread before asking a question on it")
        }
        // AUTONOMOUS MODE REFUSES THE ASK, and the refusal lands at the exact moment of temptation —
        // which no amount of contract text read hours earlier can do. The tool stays PRESENT rather than
        // being hidden: a worker that wants to ask and finds nowhere to put it fakes a question in prose
        // that nothing parses, and the human never sees it at all.
        const goal = autonomousGoal(row)
        // A batch of SECRET requests is exempt: a credential is not a call the worker can decide, it is
        // a value only the human holds — the same footing as `steps:`, which autonomous mode allows.
        if (goal && !input.questions.every((q) => q.secret)) {
          throw new Error(
            "This thread is running autonomously — decide it yourself and proceed. Its standing " +
            `instruction is:\n\n${goal}\n\nSay which way you went and why in your write-up, so the ` +
            "human can course-correct. If the call is genuinely theirs — something destructive or " +
            "irreversible — say so in your final message instead; a thread on autonomous mode is not a " +
            "thread with no human reading it. An ACT only the human can perform (a sign-in, an approval, " +
            "a button you may not press) is not a call: list it under `steps:` in an ```awaiting fence, " +
            "which autonomous mode allows.",
          )
        }
        // REFUSED, not stored, and named one fault at a time in the worker's own vocabulary — a shape
        // zod accepts can still be a question nobody can answer (a `multi` with no options renders as a
        // free-text box, silently).
        const faults = input.questions.flatMap((q) => askedQuestionFaults(q))
        if (faults.length > 0) throw new Error(faults.join("\n"))
        // NO CAP ON THE OPEN SET. Twelve was refused here until 2026-09-03 ("a worker holding more than
        // this is refusing to decide"); the maintainer had it removed with the tool's other count caps.
        const now = Date.now()
        const registered = input.questions.map((spec) => {
          const id = `qst_${randomUUID().replace(/-/g, "").slice(0, 12)}`
          // A question trumps a done — see setOwnThreadTimer.
          ctx.storage.clearThreadDone(input.slug)
          ctx.storage.askThreadQuestion({ id, slug: input.slug, spec: JSON.stringify(spec), askedAtMs: now })
          return questionView(input.slug, id, spec, now)
        })
        ctx.board.refresh()
        return { registered, open: openQuestionViews(input.slug) }
      },
    }),

    unask: mutation({
      input: UnaskInput,
      output: UnaskResult,
      handler: async ({ input }) => {
        catchUpQuestionFences(input.slug)
        // Slug-scoped in storage, so one thread can never withdraw another's question. Named by the
        // worker's own fence id since 2026-10-13, or by a legacy `qst_…`.
        const target = findOwnQuestion(input.slug, input.id)
        // A FOLLOW-UP'S ID WITHDRAWS NOTHING. It rides inside its parent's row, so the only thing this
        // call could take back is the whole parent — a question the worker did not name and may still
        // want answered. It did exactly that until 2026-10-13, and the first fix only said so afterwards;
        // refusing costs the worker one more command and loses nobody's question.
        const want = input.id.trim().toLowerCase()
        const named = target !== undefined && (target.id.toLowerCase() === want || target.handle?.toLowerCase() === want)
        const withdrawn = target && named ? ctx.storage.withdrawThreadQuestion(input.slug, target.id, Date.now()) : false
        if (withdrawn) ctx.board.refresh()
        // NAMED BACK, by the worker's own id for the row: `sqlite-path` resolves to the `settings-store`
        // it is a follow-up of, which is the id the worker has to pass to withdraw the pair. The state is
        // the row's as the call found it — why nothing was withdrawn, when nothing was.
        return {
          withdrawn,
          ...(target ? { id: target.handle ?? target.id, state: target.state } : {}),
          open: openQuestionViews(input.slug),
        }
      },
    }),

    // ---- and the two the CARD calls -------------------------------------------------------------
    answerQuestions: mutation({
      input: AnswerQuestionsInput,
      output: AnswerQuestionsResult,
      handler: ({ input }) => audit(
        "answerQuestions",
        () => ({ project: thisProject, thread: input.slug, detail: { answers: input.answers.map((answer) => answerDigest(input.slug, answer)) } }),
        async () => {
          const answered = settleQuestionAnswers(input.slug, input.answers, Date.now()).map((answer) => answer.questionId)
          // ANSWERING IS NOT DELIVERING. The row is stored answered-but-undelivered and the scheduler
          // hands it over (evalQuestionAnswers), so an answer given while the worker's process is down
          // survives the gap instead of being lost in the same silence the fence lost the question in.
          //
          // BUT THE HUMAN IS RIGHT HERE, so the sweep runs NOW rather than up to a whole tick from now.
          // Waiting for it cost a mean five seconds in which the question card was already gone and the
          // answer had not arrived, and the thread — at rest, with nothing registered any more — drew the
          // residual "Rested without a sign-off" card in the hole (maintainer 2026-08-27: "I get a little
          // card that, for like 5+ seconds, just says that the thread rested without a sign-off before it
          // shows up my answer"). The durable path is unchanged: this only skips the wait.
          if (answered.length > 0) {
            ctx.board.refresh()
            ctx.scheduler.kick()
          }
          return { answered, open: openQuestionViews(input.slug) }
        },
        (result) => ({ detail: { answered: result.answered } }),
      ),
    }),

    dismissQuestions: mutation({
      input: DismissQuestionsInput,
      output: DismissQuestionsResult,
      handler: async ({ input }) => {
        const now = Date.now()
        const dismissed: string[] = []
        for (const id of input.ids) {
          const q = ctx.storage.getThreadQuestion(id)
          if (!q || q.thread_slug !== input.slug || q.state !== "open") continue
          // A DANGER-TAGGED QUESTION CANNOT BE DISMISSED, and the refusal lives here rather than only in
          // the card: a generic close icon is not consent for something irreversible, and declining is a
          // real option INSIDE the question. Skipped rather than thrown — the card does not offer the x
          // on one of these, so reaching this line at all means something other than the card called.
          if (parseQuestionSpec(q.spec)?.danger) continue
          if (ctx.storage.dismissThreadQuestion(id, now)) dismissed.push(id)
        }
        // NO WAKE. The human dismissing questions is almost always dismissing several in a row and is
        // sitting right there, so a wake per x would be a turn per click. The worker is told at its next
        // wake, in the same message as any answers (questionAnswerMessage).
        if (dismissed.length > 0) ctx.board.refresh()
        return { dismissed, open: openQuestionViews(input.slug) }
      },
    }),

    // ---- `done`: the completion verb, and the one call frizz can REFUSE --------------------------
    markOwnDone: mutation({
      input: MarkOwnDoneInput,
      output: MarkOwnDoneResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not registered`)
        // THE GATE. A worker must resolve or drop what it REGISTERED before it can claim to be
        // finished: an unanswered question dies with the done card, and a live wait means the thing it
        // was waiting for has not happened yet. Both are refusals a fence could never make — a fence is
        // a sentence in a message, so by the time anything could object the card has already rendered.
        //
        // REGISTRATIONS ONLY, deliberately. A background shell or a sub-agent the worker never
        // registered does not block this: frizz cannot tell a build from a dev server, only the worker
        // can, and the registration IS that judgement. Gating on raw liveness would make `done`
        // unreachable for any thread that left a log tail running.
        // A fence written in the same message as this call must count — catch the registrar up first.
        catchUpQuestionFences(input.slug)
        const blockingQuestions = ctx.storage.listThreadQuestions(input.slug, { openOnly: true }).flatMap((q) => {
          const spec = parseQuestionSpec(q.spec)
          // Named the way the worker knows it, so `frizzctl unask <id>` takes the id the refusal printed.
          return spec ? [{ id: q.handle ?? q.id, question: spec.question }] : []
        })
        const blockingWatches = [
          ...armedOwnWatchViews(input.slug).map((w) => ({
            id: w.id,
            what: `${w.kind === "agent" ? "sub-agent" : "shell"}: ${w.label ? `${w.label} (${w.target})` : w.target}`,
          })),
          ...armedPrWatchViews(input.slug).map((w) => ({ id: w.id, what: `${w.kind === "issue" ? "issue" : "pull request"}: ${w.target}` })),
          ...ctx.storage
            .listThreadTimers(input.slug, { armedOnly: true })
            .map((t) => ({ id: t.id, what: `timer, fires ${new Date(t.fire_at).toISOString()}` })),
          ...ctx.storage
            .listCommandWatches(input.slug, { armedOnly: true })
            .map((w) => ({ id: w.id, what: `command watch: ${w.command.trim().replace(/\s+/g, " ").slice(0, 120)}` })),
        ]
        if (blockingQuestions.length > 0 || blockingWatches.length > 0) {
          return { done: false, blockingQuestions, blockingWatches }
        }
        ctx.storage.markThreadDone(input.slug, input.body, Date.now())
        ctx.board.refresh()
        return { done: true, blockingQuestions: [], blockingWatches: [] }
      },
    }),

    listOwnPrWatches: mutation({
      input: ListOwnPrWatchesInput,
      output: OwnPrWatchesResult,
      handler: async ({ input }) => ({ watches: armedPrWatchViews(input.slug) }),
    }),

    // The SUPERSEDED worker procedures, aliased onto the row above — see SetOwnThreadStopHookInput for
    // why they cannot simply be deleted. A worker's MCP server outlives every server restart, so these
    // three names are still arriving from sessions dispatched before the merge; without them those
    // workers get a bare 404 from the one tool that keeps a long effort moving.
    //
    // `setOwnThreadStopHook` owned the ON-REST trigger.
    setOwnThreadStopHook: mutation({
      input: SetOwnThreadStopHookInput,
      handler: async ({ input }) => {
        applyLegacyWorkerTrigger(input.slug, "rest", { prompt: input.prompt, enabled: input.enabled })
      },
    }),

    // `setOwnThreadHeartbeat` owned the ON-SCHEDULE trigger, and `setThreadHeartbeat` is the older build's
    // name for the same call — it omitted `enabled` entirely, so a non-null prompt IS the arming.
    setOwnThreadHeartbeat: mutation({
      input: SetOwnThreadHeartbeatInput,
      handler: async ({ input }) => {
        applyLegacyWorkerTrigger(input.slug, "schedule", {
          prompt: input.prompt,
          enabled: input.enabled ?? input.prompt !== null,
          intervalSeconds: input.intervalSeconds,
        })
      },
    }),
    setThreadHeartbeat: mutation({
      input: SetOwnThreadHeartbeatInput,
      handler: async ({ input }) => {
        applyLegacyWorkerTrigger(input.slug, "schedule", {
          prompt: input.prompt,
          enabled: input.enabled ?? input.prompt !== null,
          intervalSeconds: input.intervalSeconds,
        })
      },
    }),

    // Event-snooze the awaiting-background card: capture the CURRENT rest instant so the board hides the
    // card until rested_at advances — the exact moment the thread's own sub-agent/shell returns and the
    // worker comes to a new rest. No deadline, no scheduler, no reaper: the session stays alive (it is
    // ALREADY resting) and the snooze expires itself on the next rest. Session-guarded so a stale tab
    // cannot snooze whatever now owns the slug.
    //
    // ALSO THE HEADER'S "UNTIL ACTIVITY" (SnoozeMenu, 2026-10-19), which offers the same park on any rested
    // thread. It is refused when nothing but a person could end it (board.wakesOnItsOwn — the menu greys
    // the row out on the same reading), and it REPLACES a wall-clock snooze rather than stacking on one:
    // the two are one choice in one menu, and a clock left armed underneath would keep the thread parked
    // past the rest this one promises.
    snoozeAwaitingBackground: mutation({
      input: z.object({ slug: ThreadSlug, sessionId: z.string().min(1) }).strict(),
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        if (!row.rested_at) throw new Error("This thread is not at rest; nothing to snooze")
        const thread = (await ctx.board.snapshot()).threads.find((candidate) => candidate.id === input.slug)
        if (thread?.wakesOnItsOwn !== true) throw new Error("Nothing can wake this thread on its own")
        if (!ctx.storage.setBgSnoozeRestedAtIfCurrent(input.slug, row.session_id, row.runtime_generation ?? 0, row.rested_at)) {
          throw new Error("This thread changed before it could be snoozed")
        }
        if (row.snoozed_until) ctx.storage.setSnoozedUntil(input.slug, null)
        ctx.board.refresh()
      },
    }),

    // Dismiss/forget: the HARD-DELETE verb for a stalled/exited phantom the user wants GONE, not merely
    // shelved (Archive = state='archived', still listed in Inactive). Removes the registry row AND
    // tombstones its transcript id so a log-dir rescan / foreign-discovery can never resurrect it, then
    // drops the tailer's in-memory state. GATED on a NOT-live row: only a thread whose derived runtime is
    // "exited" (a dead worker, or a boot-failure "Stalled" session degradeIfNoTranscript flags) can be
    // forgotten — a genuinely-live session (running / turn-idle / perm-prompt) is refused so it can't be
    // yanked out from under itself. Idempotent: an already-forgotten slug no-ops.
    forgetThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) {
          if (ctx.storage.getAdoptionClaim(input.slug)) {
            throw new Error("An adoption attempt is in progress; nothing was dismissed")
          }
          return // already gone — idempotent
        }
        const t = (await ctx.board.snapshot()).threads.find((x) => x.id === input.slug)
        if (t && t.runtime !== "exited") {
          throw new Error("only a stalled or exited session can be dismissed — archive a live one instead")
        }
        await stopAndForgetRegisteredRuntime(ctx.storage, row, cachedLivenessTerminator, ctx.codexAppServer, ctx.claudeBroker, ctx.acpBridge)
        ctx.tailer.forget(input.slug)
        ctx.board.refresh() // storage-only change — the removed row fans out as a delete delta on SSE
      },
    }),

    // Route a link clicked inside the chromeless Chrome --app window to the OS default browser.
    // Without this, http(s) links open within our dedicated user-data-dir profile — the
    // "anonymous Chrome window" the user reported. Validation lives in open-external.ts, which
    // rejects any non-http(s) scheme and spawns `open`/`xdg-open` with an args array (no shell).
    openExternal: mutation({
      input: z.object({ url: z.string() }),
      handler: async ({ input }) => {
        // Awaited so a dead opener (no `xdg-open` on Windows, an editor that is not installed) is
        // the caller's error instead of a swallowed log line (Windows audit 2026-09-11).
        const result = await openExternalUrl(input.url)
        if (!result.opened) throw new Error(result.error)
      },
    }),

    // A local file can be opened only after its canonical real path is contained by the openable roots
    // (home-and-below + temp + project). The HTTP layer already rejects non-local/mismatched origins;
    // this gate means the endpoint never becomes arbitrary remote-origin or whole-filesystem access.
    openLocalFile: mutation({
      input: z.object({ path: z.string(), image: z.boolean().optional() }).strict(),
      output: z.object({ action: z.enum(["opened", "copy"]), path: z.string() }),
      handler: async ({ input }) => openLocalFile(
        input.path,
        ctx.getSettings().localFileOpener ?? "system",
        openRoots,
        { forceSystem: input.image === true },
      ),
    }),

    // A local Markdown file's source, for the built-in reader. Same openable-root gate as openLocalFile
    // — the click that reaches here already had to pass it — plus an extension check on BOTH the
    // requested and the canonical path, so this route reads Markdown or nothing. It is the only local
    // gate whose bytes enter the page, which is exactly what a reader is: a link the user clicked,
    // rendered here instead of thrown at the desktop opener.
    localMarkdown: query({
      input: z.object({ path: z.string().max(4096) }).strict(),
      output: z.object({ path: z.string(), markdown: z.string(), truncated: z.boolean() }),
      handler: async ({ input }) => readLocalMarkdown(input.path, openRoots),
    }),

    // A file's SOURCE, for the fullscreen page's file viewer. The SAME openable roots as the Markdown
    // reader — see readLocalTextFile for why the project-directory-only gate this replaced refused 41%
    // of the rail's own rows (a worker's checkout is very often a worktree outside the project dir).
    localFile: query({
      input: z.object({ path: z.string().max(4096) }).strict(),
      output: z.object({ path: z.string(), text: z.string(), truncated: z.boolean(), binary: z.boolean(), modifiedAt: z.number() }),
      handler: async ({ input }) => readLocalTextFile(input.path, openRoots),
    }),

    // Batch-classify path REFERENCES (as they appear in inline code) → their canonical openable path, or
    // null when a candidate doesn't resolve to a real file under the openable roots. The client renders
    // resolved ones as clickable inline code (opened via openLocalFile). Pure read: it only realpath-
    // resolves + stats within the gate, never opening a file nor revealing existence outside it.
    resolveLocalPaths: query({
      input: z.object({ paths: z.array(z.string().max(1024)).max(128) }).strict(),
      output: z.object({ resolved: z.array(z.object({ input: z.string(), path: z.string().nullable() })) }),
      handler: async ({ input }) => {
        const memo = new Map<string, string | null>()
        const resolved = input.paths.map((raw) => {
          if (!memo.has(raw)) memo.set(raw, resolveOpenableFile(raw, ctx.project.dir, openRoots))
          return { input: raw, path: memo.get(raw) ?? null }
        })
        return { resolved }
      },
    }),

    markComplete: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        assertLegacyMutationAllowed(input.slug)
        await runThreadUpdate(ctx.project.dir, input.slug, ["--status", "done"])
        ctx.storage.markRead(input.slug)
        void ctx.board.rebuild().catch(() => {}) // .frizz changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    // Assign ANY status (the "Mark as <status>" split button): the exact frizz status the human picks.
    // Dismissing also ends the live agent session (same side-effect the Dismiss verb carries).
    setThreadStatus: mutation({
      input: z.object({ slug: ThreadSlug, status: z.enum(["active", "planning", "planned", "needs-human", "blocked", "done", "dismissed"]) }).strict(),
      handler: async ({ input }) => {
        assertLegacyMutationAllowed(input.slug)
        if (input.status === "dismissed") {
          const stopped = await stopRuntimeBySlug(ctx.storage, input.slug, cachedLivenessTerminator, ctx.codexAppServer, ctx.claudeBroker, ctx.acpBridge)
          if (stopped.row && !ctx.storage.setExitedIfCurrent(
            stopped.row.slug,
            stopped.row.session_id,
            stopped.row.runtime_generation ?? 0,
            true,
          )) {
            throw new Error("This thread resumed or was replaced while it was being stopped; the new worker was preserved")
          }
        }
        await runThreadUpdate(ctx.project.dir, input.slug, ["--status", input.status])
        if (input.status === "done" || input.status === "dismissed") ctx.storage.markRead(input.slug)
        void ctx.board.rebuild().catch(() => {}) // .frizz changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    // One-click recovery for a malformed thread file: PREPEND minimal frontmatter to a thread .md that
    // has none (see repair.ts for the guards + why it's deliberately conservative), then rebuild the
    // board so the healed thread appears in the queue/status system. Repairs the missing-frontmatter
    // case ONLY — the write hook already blocks compliant workers; this catches the stragglers.
    repairThread: mutation({
      input: z.object({ file: z.string() }),
      output: z.object({ slug: ThreadSlug }),
      handler: async ({ input }) => {
        const candidate = input.file.match(/^([a-z0-9][a-z0-9-]*)\.md$/)?.[1]
        if (candidate) assertLegacyMutationAllowed(candidate)
        const { slug } = repairThreadFile(frizzDir, input.file)
        void ctx.board.rebuild().catch(() => {}) // .frizz changed; respond now, fresh snapshot fans out on SSE (watcher also fires)
        return { slug }
      },
    }),

    dismissThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        assertLegacyMutationAllowed(input.slug)
        await runThreadUpdate(ctx.project.dir, input.slug, ["--status", "dismissed"])
        void ctx.board.rebuild().catch(() => {}) // .frizz changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    // Persist a HUMAN display title in Frizz's session registry. This deliberately does not inject a
    // backend slash command: Codex and Claude expose different rename behavior, the process need not
    // be idle/live, and transcript ai-title records must never be allowed to replace explicit intent.
    renameThread: mutation({
      input: RenameThreadInput,
      handler: async ({ input }) => {
        if (!ctx.storage.getSession(input.slug)) throw new Error(`thread ${input.slug} is not editable`)
        ctx.storage.setTitle(input.slug, input.title)
        ctx.board.refresh() // storage-only overlay; publishes an immediate board delta to every client
      },
    }),

    // The WORKER naming its own thread, from `frizzctl title`. Same row `renameThread` writes;
    // different caller, and therefore a weaker claim: this name is machine-authored, so it does NOT
    // lock, and a human rename outranks it both before and after.
    //
    // Unguarded on session/generation ON PURPOSE, exactly as `setOwnThreadRecurringPrompt` is: the MCP
    // server knows only the slug frizz stamped into its env, and a model may choose the TEXT but never
    // the thread — there is deliberately no slug parameter it could aim at someone else's row.
    setOwnThreadTitle: mutation({
      input: SetOwnThreadTitleInput,
      output: SetOwnThreadTitleResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not registered`)
        // A human who has renamed the thread owns its name. Report that as a REFUSAL rather than a
        // throw: the worker did nothing wrong, and an error is the one answer it would retry.
        const lockedByHuman = sessionTitleLocked(row)
        const accepted = lockedByHuman ? false : ctx.storage.setAgentTitle(input.slug, input.title)
        if (accepted) ctx.board.refresh()
        return {
          accepted,
          title: accepted ? input.title : (ctx.storage.getSession(input.slug)?.title?.trim() || input.slug),
          lockedByHuman,
        }
      },
    }),

    // Ask the provider to name this thread — the "Rename with Claude" verb in the drawer header.
    //
    // This used to type `/rename` into the session's terminal and scrape the result back out. It now
    // goes through the broker's typed control channel to the SDK's own `generateSessionTitle`, which is
    // the same call the daemon already makes to seed a title on the first message. The scraping path was
    // not merely legacy: it threw on every broker-backed thread, i.e. on every thread dispatched since
    // the broker cutover, so this verb was dead in the UI until now.
    aiRenameThread: mutation({
      input: AiRenameThreadInput,
      output: AiRenameThreadResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not editable`)
        const bridge = ctx.claudeBroker
        if (!bridge || row.claude_runtime !== "broker") {
          throw new Error("Only a running broker-backed Claude thread can be renamed by the provider")
        }
        // What to name it FROM: the thread's own opening request, which is what the daemon seeds from.
        // The live tail would name the session after whatever was said most recently, which for a long
        // thread is a side conversation rather than the work — until 2026-08-24 this read the tail's
        // `lastAssistant` (a ~200-char preview of the NEWEST reply), which is how issue #22's titles
        // came out naming "the very last agent action". `displayText` is the opening prompt with
        // frizz's dispatch envelope peeled off, so the titler summarizes the operator's task rather
        // than boilerplate shared by every dispatched thread.
        const opening = readTranscript(ctx.project, row.session_id).find((m) => m.role === "user")
        const description =
          opening?.displayText?.trim() || opening?.text?.trim() || row.title?.trim() || input.slug
        const title = await bridge.renameSession({ threadSlug: input.slug, sessionId: row.session_id, description })
        if (!title?.trim()) throw new Error("Claude did not return a title for this thread")
        ctx.storage.setTitle(input.slug, title.trim())
        ctx.board.refresh()
        return { title: title.trim() }
      },
    }),

    killAgent: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        // Termination goes through stopRuntimeBySlug's seam, so an app-server Codex thread is stopped
        // with turn/interrupt rather than a kill aimed at a registered runtime it never had. A stop that
        // could not be delivered throws out of here BEFORE setExitedIfCurrent, so the row is never
        // marked exited on the strength of a termination that did not happen.
        const stopped = await stopRuntimeBySlug(ctx.storage, input.slug, cachedLivenessTerminator, ctx.codexAppServer, ctx.claudeBroker, ctx.acpBridge)
        if (stopped.row && !ctx.storage.setExitedIfCurrent(
          stopped.row.slug,
          stopped.row.session_id,
          stopped.row.runtime_generation ?? 0,
          true,
        )) {
          throw new Error("This thread resumed or was replaced while it was being stopped; the new worker was preserved")
        }
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // The selectable Codex models + PER-MODEL effort options, read fresh (short TTL) from the
    // authoritative ~/.codex/models_cache.json so the picker tracks codex's own catalogue instead of a
    // hand-maintained list. Degrades to a minimal fallback (never throws) when the cache is absent.
    codexModels: query({
      output: z.array(CodexModel),
      handler: async () => readCodexModels(undefined, ctx.codexVersion),
    }),

    // The Claude aliases with the EDITION the pinned runtime resolves each to ("Opus 5.5"), asked of the
    // runtime itself once per server life; the bare family words while it answers (claude-models.ts).
    claudeModels: query({
      output: z.array(ClaudeModel),
      handler: async () => readClaudeModels({ claudeBin: ctx.claudeBin, cwd: ctx.project.dir, log: (message) => frizzLog.warn("server", message) }),
    }),

    // The ACP agents Frizz knows how to launch, with `available` for the ones on this machine's PATH.
    // The composer lists the available ones as `acp:<id>` models (plans/acp-backend.md, decision 9).
    acpAgents: query({
      output: z.array(AcpAgent),
      handler: async () => listAcpAgents(ctx.getSettings().acpAgents).map((a) => ({ id: a.id, label: a.label, command: a.command, available: a.bin !== undefined })),
    }),
    // The models one ACP agent advertises — read by opening a throwaway session in the project dir
    // (cached in the bridge), so it is a separate query the composer asks only once a model picker
    // needs it, never on every board load.
    acpAgentModels: query({
      input: AcpAgentModelsInput,
      output: AcpAgentModels,
      handler: async ({ input }) => ctx.acpBridge
        ? ctx.acpBridge.agentModels(input.agentId, ctx.project.dir, { refresh: input.refresh === true })
        : { agentId: input.agentId, models: [], error: "The ACP bridge is unavailable", probedAt: new Date().toISOString() },
    }),

    // Provider subscription quota (5h + weekly rate-limit windows) for the sidebar status bar. Codex
    // reads live from the app-server's `account/rateLimits/read`, falling back to the rollout JSONL
    // frizz already tails; Claude reads the OAuth usage endpoint with the machine's own credential
    // (claude-quota.ts — which also says when, and how rarely, it may start Claude Code instead).
    // Never throws — degrades to per-provider "unavailable".
    quota: query({
      input: z.object({ force: z.union([z.boolean(), z.enum(["claude", "codex"])]).optional() }).strict().optional(),
      output: QuotaSnapshot,
      handler: async ({ input }) => readQuota({ claudeBin: ctx.claudeBin, codexBin: ctx.codexBin, force: input?.force }),
    }),

    // Per-provider LOCAL credential presence for the new-thread dispatch gate. Distinct from `quota`
    // (whose "unavailable" is overloaded with transient endpoint failures): this reports only whether a
    // credential exists, so a dispatch can be blocked on a genuine "signed-out" without false-blocking
    // on a network blip. Never throws — degrades to per-provider "unknown", on which the gate fails open.
    // `fresh` is a person saying "I've signed in, look again": it re-asks the Claude CLI at once
    // instead of serving the verdict readAuthSnapshot remembers between polls.
    authStatus: query({
      input: z.object({ fresh: z.boolean().optional() }).strict().optional(),
      output: AuthSnapshot,
      handler: async ({ input }) => readAuthSnapshot({ claudeBin: ctx.claudeBin, fresh: input?.fresh }),
    }),

    // Typed provider account action behind the `/logout` alias + confirm dialog (claude-auth plan).
    // Refuses to race a live turn for that provider (account state is process-global), then runs the
    // exact provider CLI argv without a shell and reports the post-attempt credential state.
    accountLogout: mutation({
      input: AccountLogoutInput,
      output: AccountLogoutResult,
      handler: async ({ input }) => {
        const snapshot = await ctx.board.snapshot()
        return runProviderLogout({
          backend: input.backend,
          claudeBin: ctx.claudeBin,
          codexBin: ctx.codexBin,
          liveThreads: liveThreadsForBackend(snapshot.threads, input.backend),
        })
      },
    }),

    /**
     * Every project this machine knows about, most recently opened first.
     *
     * Machine-scoped, so which project's app answers it does not matter — the registry is one file
     * and the grid is the same grid from every board.
     */
    projectsList: query({
      output: z.array(ProjectCard),
      handler: async () =>
        listProjects().map((entry) => projectCard(entry, entry.stale)),
    }),

    /**
     * Each project's queue size and Active-band size, keyed by project id — the rail's counts — plus its
     * ask count (`boardAskThread`), which only the phone's projects list reads.
     *
     * The rail draws one yellow badge per project whose number is `queued`, and names `running` beside
     * it in the square's tooltip (issue #41: which projects still have work in flight). `running` is
     * `activeBandThread` — the rows the sidebar draws below the rule — so the rail and the sidebar
     * beside it count with one rule.
     *
     * MACHINE-WIDE, answered from the boards this process has OPEN. A queue count is a board fact:
     * `needsYou` is derived from the tailer's live view of each session, so a project with no board
     * here has no honest count, and it is left out rather than guessed at. Absent ⇒ no badge; the
     * project the operator is looking at is always present, and the client draws THAT one from its own
     * live board anyway.
     *
     * Every registered project IS opened, so absent is the exception rather than the rule: the server
     * primes the ones the operator has not visited within about a second of boot (tenant-prime.ts), which is
     * what stopped the badges from appearing only after you clicked into each square. What stays absent
     * is a project another live Frizz is serving, one whose directory is gone, and one that would not
     * open — plus every project for the first seconds of a boot, before the pass reaches it.
     *
     * Kept OFF `projectsList` on purpose: that list is one registry-file read, cheap enough to be the
     * home page with forty projects, and this is a walk over live boards. The cached snapshot makes
     * it cheap too — but cheap-and-polled is a different budget from cheap-and-once.
     */
    projectsRailCounts: query({
      output: z.record(z.string(), ProjectRailCounts),
      handler: async () => {
        const counts: Record<string, ProjectRailCounts> = {}
        const open = ctx.activeTenants?.() ?? [{ project: ctx.project, board: ctx.board }]
        for (const { project, board } of open) {
          try {
            const { threads } = await board.snapshot()
            counts[project.id] = {
              queued: threads.filter(queuedThread).length,
              running: threads.filter(activeBandThread).length,
              asks: threads.filter(boardAskThread).length,
            }
          } catch {
            // A board that is stopping mid-walk (its project is being deactivated) is a project with
            // no count this round, not a failed request for every other project.
          }
        }
        return counts
      },
    }),

    /**
     * Pin the rail's order.
     *
     * The whole list of ids, not a (from, to) pair: the client has just laid the squares out and knows
     * exactly what it means, whereas an index pair has to be replayed against whatever the server
     * believes the order is — and those disagree the moment a project is registered mid-drag.
     */
    projectsReorder: mutation({
      input: z.object({ ids: z.array(z.string().min(1)).max(500) }),
      output: z.array(ProjectCard),
      handler: async ({ input }) => {
        reorderProjects(input.ids)
        return listProjects().map((entry) => projectCard(entry, entry.stale))
      },
    }),

    /**
     * Delete a project — Frizz's record of it, never the folder it names.
     *
     * TWO LEVELS, and the difference is the whole design. The default forgets the registry entry and
     * closes the tenant: the project leaves the grid and the rail, and everything it ever held is
     * still sitting in `~/.frizz/projects/<id>/`, so adding the folder back restores the same board
     * under the same id. `deleteData` is the irreversible one — it stops that project's live workers
     * and removes that directory.
     *
     * WHAT IS NEVER TOUCHED is the project's own directory. Not its files, not its `.frizz/.id`.
     * Frizz is an index over folders somebody else owns, and a "delete" that reached into a working
     * tree would be a different product.
     *
     * THE LAUNCHING PROJECT CAN BE FORGOTTEN, BUT ITS DATA CANNOT BE DELETED. This process publishes
     * exactly one `server.lock` — that project's — and it is the address every worker daemon on the
     * machine resolves the port out of (see AppContext.launchProjectId); the launcher's own lease and
     * sign-in sessions sit beside it. Removing that directory is not one card disappearing; it is
     * every live worker losing the server, so `deleteData` is refused there.
     *
     * Forgetting it was refused too until 2026-10-10, and the operator could not act on the refusal:
     * a `frizz` run from `$HOME` or an unadopted folder was then hosted on the most recently opened
     * project (launcher.ts `resolveLaunchIntent`; Frizz's own folder since 2026-10-11), so "the
     * launching project" was routinely one nobody chose, and "restart from another folder" picked the
     * same one again. Forgetting needs none of what the
     * refusal protects — only the registry entry goes. The tenant itself stays open until the process
     * ends, because it is also the app every unprefixed request is answered by: its card and its URL
     * are gone at once, and its tailer and timers stop with the server rather than with the click.
     *
     * Idempotent: an id the registry has already forgotten reports `removed: false` rather than
     * failing, so a double-click and a stale tab both land softly.
     */
    projectRemove: mutation({
      input: z.object({ id: z.string().min(1), deleteData: z.boolean().optional() }).strict(),
      output: z.object({
        removed: z.boolean(),
        deletedData: z.boolean(),
        /** Live worker daemons this actually killed — 0 unless `deleteData`. Reported, not guessed at. */
        stoppedWorkers: z.number().int().nonnegative(),
      }),
      handler: async ({ input }) => audit(
        "projectRemove",
        // Read BEFORE the removal, which forgets the very entry that names the folder.
        () => ({ project: { id: input.id, dir: findById(input.id)?.path ?? null }, detail: { deleteData: input.deleteData === true } }),
        async () => {
          const entry = findById(input.id)
          if (!entry) return { removed: false, deletedData: false, stoppedWorkers: 0 }
          const deleteData = input.deleteData === true
          if (ctx.launchProjectId === entry.id) {
            // The message deliberately does NOT name the project: the confirmation's title already
            // does, and naming it here reads "Frizz is running from frizz" in this very repository.
            // It names another PROJECT's folder because any other folder is hosted on the most
            // recently opened project, which is this one.
            if (deleteData) {
              throw new Error("Frizz keeps its own running state with this project, so its threads and history cannot be deleted right now. Delete it without them, or quit Frizz and start it from inside another project's folder.")
            }
            // No teardown: the tenant is the server's own (see above), and the state dir is kept.
            return { removed: forgetProject(entry.id), deletedData: false, stoppedWorkers: 0 }
          }
          // The resources go FIRST and in one call, because their order matters and the server owns it:
          // a worker is stopped through its own tenant's broker, and `ui.db` is released before the
          // directory holding it is unlinked (see AppContext.teardownProject).
          const { stoppedWorkers } = (await ctx.teardownProject?.(entry.id, { stopWorkers: deleteData, deleteState: deleteData }))
            ?? { closed: false, stoppedWorkers: 0 }
          // The registry entry goes LAST, and deliberately: it is how anything finds this project again,
          // so dropping it first would strand whatever the teardown above missed.
          return { removed: forgetProject(entry.id), deletedData: deleteData, stoppedWorkers }
        },
        (result) => ({ detail: result }),
      ),
    }),

    /**
     * Give a project an icon of the operator's choosing.
     *
     * The bytes land in the project's STATE DIR, never in the repository: a picture chosen for a rail
     * square is Frizz's business, and writing one into someone's working tree would show up in their
     * `git status` for a UI preference they set in another app.
     *
     * Same trust gates as `/attach` — an extension allowlist and a size cap, and the on-disk name is
     * ours rather than the client's. `icon<ext>` is a fixed name, so re-uploading replaces rather than
     * accumulating; the registry's version stamp is what makes the new bytes visible past the cache.
     */
    /**
     * Choose this project's icon from a native dialog ALREADY STANDING IN THE PROJECT.
     *
     * A browser file input cannot be aimed anywhere — the OS picks, and it lands wherever you last
     * were. A project's icon is nearly always inside the project (a logo in the repo, a screenshot of
     * it), so the picker should open where Frizz already knows the project lives. The browser input
     * stays as the fallback for a platform with no native dialog.
     */
    projectIconPick: mutation({
      input: z.object({ id: z.string().min(1) }),
      output: DirectoryPickResult,
      handler: async ({ input }) => {
        const { startIn, prompt } = iconPicker(input.id)
        const picked = await pickImageFile(startIn, prompt)
        if (picked.kind !== "picked") return picked
        return { kind: "picked" as const, project: setProjectIconFromFile(input.id, picked.path) }
      },
    }),

    /**
     * Build that image picker now: the project's icon menu has opened, and "Choose an icon…" is one
     * move away. The same split as `projectPickWarm` — on macOS the click then only shows a panel that
     * is already built (see directory-picker.ts); everywhere else this answers `false`.
     */
    projectIconPickWarm: mutation({
      input: z.object({ id: z.string().min(1) }),
      output: z.object({ warming: z.boolean() }),
      handler: async ({ input }) => ({ warming: warmImagePicker(iconPicker(input.id).startIn) }),
    }),

    projectIconSet: mutation({
      input: z.object({
        id: z.string().min(1),
        /** The file's name, for its extension only. */
        name: z.string().min(1),
        data: z.string().max(PROJECT_ICON_MAX_BASE64_CHARS),
      }),
      output: ProjectCard,
      handler: async ({ input }) =>
        storeProjectIcon(input.id, input.name, Buffer.from(input.data, "base64")),
    }),

    /**
     * Drop the operator's icon and let the scan decide again.
     *
     * One action, not two: "remove this picture" and "go and look for one" are the same wish, because
     * a project with no icon at all falls back to its monogram either way.
     *
     * The scan runs HERE, and the card carries its answer. Clearing alone left the looking to the
     * square's image request, and the square makes none once its last request failed — so "Look for an
     * icon again" did nothing at all after a miss earlier in the same page (2026-10-11). A fresh
     * `iconVersion` is also a fresh URL, which no earlier failure or browser cache entry answers for.
     */
    projectIconClear: mutation({
      input: z.object({ id: z.string().min(1) }),
      output: ProjectCard,
      handler: async ({ input }) => {
        for (const extension of PROJECT_ICON_EXTENSIONS) {
          rmSync(customIconPath(input.id, `.${extension}`), { force: true })
        }
        if (!clearProjectIcon(input.id)) throw new Error("No such project.")
        resolveProjectIcon(input.id, (root) => detectProjectIcon(root)?.path)
        const updated = findById(input.id)
        if (!updated) throw new Error("No such project.")
        return projectCard(updated, !existsSync(updated.path))
      },
    }),

    /**
     * Rename a project — the name Frizz shows and the URL it answers on, and, only when asked, the
     * folder itself.
     *
     * The name is the registry's display override, cleared again when it matches the folder so the
     * card keeps following a later `mv`. The slug follows the name on purpose: a rename is the one
     * time an operator has said what this project is called, and `deriveSlug`'s never-re-derive rule
     * exists to protect bookmarks from SILENT changes, not from this one. A taken or reserved slug is
     * refused with the registry's own message, and nothing is written.
     *
     * `renameDirectory` is opt-in and the dialog only offers it when the folder is already named after
     * the project (maintainer 2026-09-18: "without actually changing the directory name by default").
     * It moves the folder to a sibling of the same name and re-registers the id there, then closes
     * the tenant so the next request reopens it at the new path — a context built on the old one
     * would spawn every worker into a directory that no longer exists. The launching project is
     * refused: this process is standing in it, and its context is pinned to the old path.
     */
    projectRename: mutation({
      input: z.object({
        id: z.string().min(1),
        name: z.string().trim().min(1).max(120),
        renameDirectory: z.boolean().optional(),
      }).strict(),
      output: ProjectCard,
      handler: async ({ input }) => {
        const entry = findById(input.id)
        if (!entry) throw new Error("No such project.")
        const name = input.name.trim()
        let path = entry.path
        if (input.renameDirectory && name !== basename(entry.path)) {
          if (ctx.launchProjectId === entry.id) {
            throw new Error("Frizz is running from this project's folder, so the folder cannot be renamed right now. Quit Frizz and start it from inside another project's folder first.")
          }
          path = moveProjectDirectory(entry.id, name).path
          // Detached workers keep running through the rename (their cwd follows the inode); only
          // Frizz's own view of the project has to be rebuilt, and the slug route does that lazily.
          await ctx.teardownProject?.(entry.id, {})
        }
        const updated = renameProject(entry.id, { name: name === basename(path) ? null : name, slug: name })
        if (!updated) throw new Error("No such project.")
        return projectCard(updated, !existsSync(updated.path))
      },
    }),

    /**
     * Open the machine's own folder picker, and add whatever comes back.
     *
     * The SERVER opens it. That is not a shortcut: the browser's File System Access API deliberately
     * withholds the absolute path, and a project IS a path (see directory-picker.ts). One round trip
     * rather than pick-then-add, because someone who has chosen a folder has already said yes.
     */
    projectPick: mutation({
      input: z.object({}),
      output: DirectoryPickResult,
      handler: async () => {
        const picked = await pickDirectory()
        // Folders tend to be added several at a time (2026-10-03: three dialogs inside 33 seconds), so
        // the next panel is built while this one's board loads. One that is never asked for dies idle.
        if (picked.kind !== "unavailable") warmDirectoryPicker()
        if (picked.kind !== "picked") return picked
        const project = await audit(
          "projectPick",
          { project: { id: null, dir: picked.path }, detail: { path: picked.path } },
          () => addProjectAtPath(picked.path),
          addedProject,
        )
        return { kind: "picked" as const, project }
      },
    }),

    /**
     * Build the folder picker now: the pointer or keyboard focus has reached "Add a project", and the
     * click is a moment away. On macOS a cold panel takes ~0.9s to draw and a built one ~0.09s (see
     * directory-picker.ts); everywhere else nothing is built ahead and this answers `false`.
     */
    projectPickWarm: mutation({
      input: z.object({}),
      output: z.object({ warming: z.boolean() }),
      handler: async () => ({ warming: warmDirectoryPicker() }),
    }),

    /**
     * Register a directory as a project, from the grid's phantom card.
     *
     * The same authority as running `frizz` in that directory, and strictly less: this registers and
     * resolves an id, it dispatches nothing. The root comes from chosenProjectRoot — a folder inside
     * a checkout adds the checkout, but an adopted plain-directory ancestor never captures the pick.
     */
    projectAdd: mutation({
      input: z.object({ path: z.string().min(1) }),
      output: ProjectCard,
      handler: async ({ input }) =>
        audit("projectAdd", { project: { id: null, dir: input.path }, detail: { path: input.path } }, () => addProjectAtPath(input.path), addedProject),
    }),

    /**
     * Find which project owns a thread slug.
     *
     * EVERY URL FROM THE PER-PROJECT ERA IS UNPREFIXED. `localhost:4917/thread/fix-auth/full` used
     * to be unambiguous because the PORT named the project; one server for the machine makes that
     * same path resolve against whichever project happened to launch it, so a bookmark that worked
     * yesterday reports "not found" today. It is not lost — it is one directory over, and this is how
     * the page finds it instead of blaming the operator.
     *
     * Runs only on a miss: one indexed lookup in the unified database, then the registry names the
     * projects it found (2026-08-27 — until then this opened each project's own file read-only).
     */
    threadLocate: query({
      input: z.object({ slug: z.string().min(1) }),
      output: z.array(ThreadLocation),
      handler: async ({ input }) => {
        const owners = new Set(
          ctx.storage.db.prepare<[string], { project_id: string }>(
            "SELECT DISTINCT project_id FROM session WHERE slug = ?",
          ).all(input.slug).map((row) => row.project_id),
        )
        const found: ThreadLocation[] = []
        for (const entry of listProjects()) {
          if (entry.stale || !owners.has(entry.id)) continue
          found.push({ projectSlug: entry.slug, projectName: entry.name ?? entry.slug })
        }
        return found
      },
    }),

    settingsGet: query({
      output: Settings,
      handler: async () => ctx.getSettings(),
    }),

    settingsSet: mutation({
      input: Settings,
      output: Settings,
      handler: async ({ input }) => ctx.setSettings(input),
    }),

    // Clear the stored settings blob so defaults (incl. the shipped default preamble) apply again.
    settingsReset: mutation({
      input: z.object({}),
      output: Settings,
      handler: async () => ctx.resetSettings(),
    }),

    dispatchPreferencesGet: query({
      output: DispatchPreferences,
      handler: async () => ctx.getDispatchPreferences(readCodexModels(undefined, ctx.codexVersion)),
    }),

    dispatchPreferenceSet: mutation({
      input: SetDispatchPreferenceInput,
      output: DispatchPreferences,
      handler: async ({ input }) => ctx.setDispatchPreference(input, readCodexModels(undefined, ctx.codexVersion)),
    }),

    // The shipped GitHub batch-dispatch prompt template (single source of truth: server/github.ts).
    // The Settings UI reads it to prefill the editor and to power "reset to default"; an empty/unset
    // githubPrompt setting means the server uses exactly this. One template serves issues AND PRs.
    githubPromptDefaults: query({
      output: z.object({ prompt: z.string() }),
      handler: async () => ({ prompt: DEFAULT_GITHUB_PROMPT }),
    }),

    // ---- GitHub-first batch dispatch ----

    // gh availability: installed (cache-warmed resolveInstalled) + inRepo/nameWithOwner (cache-warmed
    // resolveRepo) + a LIVE authed re-check (never cached — a mid-session `gh auth login` reflects on
    // the next query). The repo is resolved only when authed (gh repo view needs auth), so a
    // cached-negative inRepo from an unauthed/racy boot never sticks; neither does a cached-negative
    // installed. Never throws (all probes degrade to false/null).
    githubStatus: query({
      output: GithubStatus,
      handler: async () => {
        const installed = await resolveInstalled()
        if (!installed) return { installed: false, inRepo: false, nameWithOwner: null, authed: false }
        const authed = await ghAuthed()
        const nameWithOwner = authed ? await resolveRepo() : (ctx.github?.nameWithOwner ?? null)
        return { installed: true, inRepo: nameWithOwner !== null, nameWithOwner, authed }
      },
    }),

    // ONE PAGE of the repo's issues or PRs, search-sorted (recency or reactions), plus the totals the
    // picker's pager renders. Empty when this isn't a GitHub repo. resolveRepo warms/uses the cache
    // with a live fallback (so a post-boot sign-in works). A gh error (rate limit / network)
    // propagates → surfaced to the client as a failed query (risk 7), rather than silently reading as
    // "no items".
    githubList: query({
      input: GithubListInput,
      output: GithubListResult,
      handler: async ({ input }) => {
        const repo = await resolveRepo()
        if (!repo) return { items: [], total: 0, page: 1, pageCount: 1 }
        return await listItems(repo, input.kind, input.sort, input.page, input.perPage)
      },
    }),

    // Hovercard data for every GitHub reference the client autolinked into the prose on screen —
    // ONE request for a whole page of refs, answered from a process-lifetime cache (see
    // github-hovercard.ts). The client asks as the prose renders, so the hover itself never waits on
    // the network; `refresh` is its revalidation of the handful it is actually pointing at.
    //
    // Never throws: a missing gh, an unauthenticated one, a rate limit and a network stall all come
    // back as `error` with whatever cards the cache already holds, and the anchor stays a plain link.
    githubRefPreview: query({
      input: GithubRefPreviewInput,
      output: GithubRefPreviewResult,
      handler: async ({ input }) => await githubHovercards.preview(input.refs, { refresh: input.refresh }),
    }),

    // Spin up one frizz thread per checked item: hydrate each fresh from gh, template a server-side
    // prompt (single source of truth, unit-tested), then REUSE ctx.dispatcher.dispatch (no new spawn
    // logic). SEQUENTIAL — a burst of 20 concurrent worker spawns would hammer the box (risk 5). A
    // per-item failure is captured in `failed[]` and never aborts the rest of the batch.
    githubDispatchBatch: mutation({
      input: GithubBatchInput,
      output: GithubBatchResult,
      handler: async ({ input }) => {
        validateGithubDispatchProfile(input, readCodexModels(undefined, ctx.codexVersion))
        const repo = await resolveRepo()
        if (!repo) throw new Error("not a GitHub repo")
        // Read the template ONCE per batch: the user's Settings override (githubPrompt) when non-blank,
        // else the exported default (effectiveTemplate decides). One template serves both kinds, so this
        // no longer varies per item — renderGithubPrompt still gets the kind for the lead and the body
        // truncation pointer.
        const template = effectiveTemplate(ctx.getSettings().githubPrompt)
        const dispatched: { number: number; kind: string; slug: string }[] = []
        const failed: { number: number; kind: string; error: string }[] = []
        for (const it of input.items) {
          try {
            // Explicit title skips the fallback-chop so the slug reads investigate-owner-repo-N. RESERVE
            // the slug here with the SAME predicate dispatch uses (existing .frizz file / registry row)
            // and pass it EXPLICITLY, so the prompt's THREAD tag equals the real dispatched slug even on
            // a collision (re-dispatch / duplicate items) — otherwise the worker would write a ghost
            // .frizz/<base>.md disjoint from the -2 registry row (resolveSlug is idempotent on a free slug).
            const title = `${it.kind === "issue" ? "Investigate" : "Review"} ${repo}#${it.number}`
            const slug = resolveSlug(frizzDir, slugify(title), (s) => ctx.storage.getSession(s) !== undefined)
            const hydrated = it.kind === "issue" ? await hydrateIssue(repo, it.number) : await hydratePr(repo, it.number)
            const prompt = renderGithubPrompt(template, repo, hydrated, slug, it.kind)
            const request = githubDispatcherRequest(input, { prompt, title, slug })
            // One record per thread the batch starts, so each reads like an ordinary dispatch.
            const res = await audit(
              "githubDispatch",
              { project: thisProject, detail: { repo, kind: it.kind, number: it.number, prompt: textDigest(prompt) } },
              () => ctx.dispatcher.dispatch(request.payload, request.options),
              (result) => ({ thread: result.slug, detail: { sessionId: result.sessionId } }),
            )
            dispatched.push({ number: it.number, kind: it.kind, slug: res.slug })
          } catch (e) {
            failed.push({ number: it.number, kind: it.kind, error: (e as Error).message.slice(0, 120) })
          }
        }
        return { dispatched, failed }
      },
    }),
  }
}

export type AppRouter = ReturnType<typeof createRouter>
