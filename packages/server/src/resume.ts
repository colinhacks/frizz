import { writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import {
  PermissionMode,
  type PermissionMode as PermissionModeValue,
  type Settings,
} from "@frizz/shared"
import { PERM_DIR_ENV, permRequestDir, type Project } from "./project.ts"
import {
  isBrokerClaudeRow,
  type ProfileChangeExpectation,
  type ProfileHandoffBinding,
  type ProfileHandoffJournal,
  type SessionRow,
  type Storage,
} from "./storage.ts"
import type { BoardManager } from "./board.ts"
import type { SessionTelemetry } from "./tailer.ts"
import type { AgentBackend } from "./backend/types.ts"
import { encodeDeliveryMarker } from "./delivery-marker.ts"
import {
  buildClaudeResumeCommand,
  claudeWorkerEnvironment,
  effectivePermissionMode,
  workerPluginDir,
  resolveFrizzMcp,
  scratchpadOrientation,
  frizzConfigBlock,
  loadWorkerPrompt,
} from "./dispatch.ts"
import {
  ADOPTION_ATTEMPT_LEASE_MS,
  abandonAdoptionAttempt,
  adoptionRuntimeBinding,
  type AdoptionRecoveryRuntime,
  type PaneIdentity,
} from "./adoption-recovery.ts"

/**
 * A follow-up/wake that cannot be delivered AND must not be retried. Raised when a live worker owns
 * this conversation on a legacy socket but its exact identity could not be confirmed for safe
 * injection, so spawning a duplicate is refused. The identity verdict is stable — retrying only defers
 * a silent exhaustion — so the wakers scheduler abandons the outbox item terminally (surfacing the
 * reason) rather than burning every delivery attempt. The `terminalDelivery` marker is duck-typed so
 * the scheduler need not import this module (it receives `resume` by injection).
 */
export class TerminalDeliveryError extends Error {
  readonly terminalDelivery = true
  constructor(message: string) {
    super(message)
    this.name = "TerminalDeliveryError"
  }
}

/**
 * A follow-up/wake that was refused BEFORE any byte of it could reach a worker, by a contention gate
 * that a later attempt can find open: a permission/profile handoff owning the runtime, a lost
 * runtime-control CAS (two follow-ups racing the same row), an adoption identity frizz could not verify
 * this instant, or a lifecycle CAS that moved under us.
 *
 * The distinction that matters is DELIVERY SAFETY, not the sentence: every site raising this sits
 * strictly upstream of the first byte written toward the worker, so a caller retrying it CANNOT
 * double-send. That is the entire licence for `sendEagerFollowUp` to retry instead of handing the
 * operator's message back — an ambiguous failure (the text may already have reached the worker before
 * a later step threw) must stay an ordinary Error so it is never replayed. `retryableDelivery` is duck-typed for the same reason
 * `terminalDelivery` is: the RPC layer reads it without importing this module.
 */
export class RetryableDeliveryError extends Error {
  readonly retryableDelivery = true
  constructor(message: string) {
    super(message)
    this.name = "RetryableDeliveryError"
  }
}

/**
 * A bump/resume REACTIVATES an archived thread: the maintainer messaging an Inactive (archived) thread
 * expects it back in Active. There is deliberately no Reopen verb anywhere in frizz — the composer under
 * the "Done" readout IS the reopen affordance (see web ThreadLifecycle.tsx, DoneReadout) — so this un-archive is
 * the entire mechanism behind that promise, and every runtime has to honour it.
 *
 * It lives HERE, above `resumeThreadOwned`, because that function only ever served the retired
 * inject-into-a-live-CLI path. A broker-backed Claude row (detached daemon) and an app-server Codex
 * row (bridge) both branch away in the followUp RPC long before it, so while this lived inside
 * `resumeThreadOwned` those two reopened their WORKER without reopening their ROW: the daemon
 * cold-resumed and started executing while the board still read `state='archived'`, which renders the
 * thread as Done and — because an archived thread has no lifecycle verbs — leaves it with no
 * Mark-as-done button to stop it with. Observed
 * 2026-07-31 on a live broker thread: `claude --resume` running for minutes against a row still
 * carrying `exited=1, state='archived'`.
 *
 * Called UP FRONT, above the runtime branches, so a still-LIVE archived thread reactivates too rather
 * than being stranded in Inactive by a delivery path that returns from its own branch. Touch the row only when it is
 * actually archived, so an ordinary live steer emits no needless per-keystroke delta. Session-guarded:
 * a row that was re-dispatched under us is a CAS miss, not a reopen. (The wakers scheduler never
 * reaches this — it filters archived threads out — so this only ever un-hides a thread on an EXPLICIT
 * human bump, never auto-resurrects a deliberately-shelved one.)
 */
export function reopenArchivedThreadForFollowUp(
  deps: { storage: Pick<Storage, "setStateIfCurrent">; board: Pick<BoardManager, "refresh"> },
  row: Pick<SessionRow, "slug" | "session_id" | "runtime_generation" | "state" | "archived">,
): void {
  if (row.state !== "archived" && row.archived !== 1) return
  if (!deps.storage.setStateIfCurrent(row.slug, row.session_id, row.runtime_generation ?? 0, "open")) {
    throw new RetryableDeliveryError("This thread changed before it could be reopened; no worker was contacted")
  }
  deps.board.refresh()
}

/**
 * A follow-up UN-PARKS the thread: reprompting IS re-engagement, so it disables whatever snooze the row
 * was holding — the wall-clock park and any bump that park owed at its deadline.
 *
 * This reverses the older rule that a follow-up preserved the park (maintainer 2026-08-03: "reprompting
 * a thread that snoozed should disable the snooze"). That rule read a snooze as a standing display
 * preference — shelve until Friday, and typing into the thread must not drag it out of Snoozed. In practice
 * it does the opposite of what the operator wants: the turn you just sent runs in Active, then re-parks
 * the moment it rests, so the ANSWER to your own prompt drops back out of the queue unseen. A park says
 * "not now"; a follow-up says "now", and the later instruction wins.
 *
 * Nothing is disarmed silently. The park is visible on the row (the sidebar's snoozed sentence) and in
 * the thread (the header's amber snooze clock), so a bump that goes away leaves the surface it lived on
 * empty — and re-arming it is the same two clicks that armed it. `Wake now` remains the un-park verb for
 * an operator who wants the card back WITHOUT sending a turn.
 *
 * Cleared through `setSnoozedUntil(slug, null, null)`, the same call Wake now makes: the instant and the
 * prompt it armed are ONE fact, so dropping the deadline drops the bump with it. Unlike the un-archive
 * above this needs no CAS and aborts nothing — the caller has already proved it owns this session, and
 * refusing a steer over stale park bookkeeping would be worse than the stale row itself.
 *
 * Deliberately NOT reached by the wakers scheduler, which resumes through `resumeThread` directly: a
 * snooze bump must not clear the very park it was fired from (the scheduler settles that itself, guarded
 * on the fence id it armed — see scheduler.ts SOURCE 3).
 */
export function wakeParkedThreadForFollowUp(
  deps: { storage: Pick<Storage, "setSnoozedUntil">; board: Pick<BoardManager, "refresh"> },
  row: Pick<SessionRow, "slug" | "snoozed_until" | "snooze_prompt">,
): void {
  // Touch the row only when something is actually parked, so an ordinary steer emits no needless delta.
  if (!row.snoozed_until && !row.snooze_prompt) return
  deps.storage.setSnoozedUntil(row.slug, null, null)
  deps.board.refresh()
}

// The ONE resume/steer path, shared by the followUp RPC (a human steer) and the wakers scheduler (a
// fired machine-wait). Kept in its own module so the scheduler can reuse it without importing the RPC
// router. What it still does is the OWNERSHIP fencing: refuse a row with a permission/profile change or
// another runtime control in flight, take `runtime_control='follow-up'` under a CAS, and release it on
// the way out. Throws if no row exists.
//
// It no longer DELIVERS anything. A broker-backed Claude row and an app-server Codex row are both routed
// to their bridge by the caller, and `resumeThreadOwned` throws for everything else (see below). It used
// to be the delivery too: a live session took the message injected straight into the running `claude` (a
// paste buffer for multiline so newlines survived, a literal key-send for a single line), and a dead one
// was cold-resumed on the pinned conversation (`claude -r <sessionId>`) in a fresh terminal session of
// the same name, killing the dead remain-on-exit worker first and re-carrying the scratchpad orientation
// at SYSTEM level — a resume rebuilds the system prompt from scratch, so without that the worker forgets
// its scratchpad. The broker replaced both halves; the SYSTEM-level re-carry survives in the bridge's
// cold resume (context.ts `deliverClaudeBrokerWake`).

// The surface resumeThread touches — injected by the composition layer (context.ts) and by tests, which
// exercise the un-archive/section logic without any real worker.
export interface ResumeDeps {
  project: Project
  storage: Storage
  board: BoardManager
  getSettings: () => Settings
  // Per-session agent-backend resolver that builds the dead-session resume argv (Codex-support epic).
  // Injected by the composition layer; when absent (tests) resume falls back to the local Claude resume
  // builder. Resolved by the row's `backend` column so a codex row resumes via `codex resume`.
  backendFor?: (kind?: string) => AgentBackend
  // Tests can replace the bounded post-spawn liveness probe. Production waits across a short
  // stability window so a CLI that rejects its resume/auth arguments cannot masquerade as applied.
  permissionReady?: (slug: string) => Promise<boolean>
}

function permissionModeForRow(row: SessionRow, settings: Settings): PermissionModeValue {
  const pending = PermissionMode.safeParse(row.permission_pending)
  if (pending.success) return effectivePermissionMode(row.backend === "codex" ? "codex" : row.backend === "opencode" ? "opencode" : "claude", pending.data)
  const saved = PermissionMode.safeParse(row.permission_mode)
  const requested = saved.success ? saved.data : settings.permissionMode
  return effectivePermissionMode(row.backend === "codex" ? "codex" : row.backend === "opencode" ? "opencode" : "claude", requested)
}

// Build + spawn the backend-native resume invocation. `message` omitted means REATTACH ONLY: open the
// saved conversation at an idle prompt without fabricating a user message or starting an agent turn.
export type ProfileReattachPhase =
  | "target-starting" | "target-spawned" | "target-ready"
  | "rollback-starting" | "rollback-spawned" | "rollback-ready"

export interface ProfileReattachCheckpoint {
  phase: ProfileReattachPhase
  generation: number
  handoffToken: string
  identity?: PaneIdentity
  adoptionAttemptToken?: string
}

interface ProfileTransition {
  current: { model: string; effort: string }
  requested: { model: string; effort: string }
  onCheckpoint?: (checkpoint: ProfileReattachCheckpoint) => void
  rollbackOnFailure?: boolean
}

type PermissionProcessProbe = "ready" | "exited" | "replaced" | "unready"

function samePaneIdentity(a: PaneIdentity | undefined, b: PaneIdentity | null | undefined): boolean {
  if (!a || !b) return a === undefined && b === undefined
  return a.paneId === b.paneId && a.panePid === b.panePid && a.sessionCreated === b.sessionCreated
}

class PermissionHandoffAbortedError extends Error {}
class ProfileCheckpointAbortedError extends Error {}

function emitProfileCheckpoint(profiles: ProfileTransition | undefined, checkpoint: ProfileReattachCheckpoint): void {
  if (!profiles?.onCheckpoint) return
  try {
    profiles.onCheckpoint(checkpoint)
  } catch (error) {
    throw new ProfileCheckpointAbortedError(error instanceof Error ? error.message : String(error))
  }
}

function assertPermissionGenerationCurrent(
  deps: ResumeDeps,
  row: SessionRow,
  generation: number,
  pending: string | null,
  runtimeControl: string | null,
): SessionRow {
  const current = deps.storage.getSession(row.slug)
  if (
    !current ||
    current.session_id !== row.session_id ||
    (current.runtime_generation ?? 0) !== generation ||
    (current.permission_pending ?? null) !== pending ||
    (current.runtime_control ?? null) !== runtimeControl
  ) {
    throw new PermissionHandoffAbortedError("Permission change canceled because this thread or process generation was deleted or replaced during startup")
  }
  return current
}

function commitPermissionRuntime(
  deps: ResumeDeps,
  row: SessionRow,
  generation: number,
  expectedPending: string | null,
  permissionMode: PermissionModeValue,
  permissionPending: PermissionModeValue | null,
  exited: boolean,
  runtimeControl: string | null,
): void {
  if (!deps.storage.setPermissionStateIfCurrent(row.slug, {
    sessionId: row.session_id,
    generation,
    permissionPending: expectedPending,
    runtimeControl,
  }, {
    exited,
    permissionMode,
    permissionPending,
    controlError: null,
  })) {
    throw new PermissionHandoffAbortedError("Permission change canceled because this thread or process generation was deleted or replaced during startup")
  }
}


// Claude's idle composer is the last `❯` row immediately above its footer divider. A trust prompt,
// selector, or other modal may also use `❯`, but always carries text and therefore fails closed as a
// nonempty input. This check exists only to protect unsent drafts before a controlled idle reattach;
// it never drives menu navigation or submits terminal input.

// Change a live standalone TUI's launch-time permission profile without fabricating a user turn.
// Callers must first prove the conversation is idle, has no running children, and has an empty native
// composer. Neither backend exposes a supported control channel for mutating an arbitrary live TUI;
// reopening the persisted conversation with its documented CLI flag is the truthful, deterministic
// transition. A failed target launch immediately restores the prior mode.

function profileExpectedFromRow(row: SessionRow): ProfileChangeExpectation {
  if (!row.profile_pending_model || !row.profile_pending_effort || !row.profile_handoff) {
    throw new Error("profile handoff ownership is incomplete")
  }
  return {
    sessionId: row.session_id,
    nativeSessionId: row.agent_session_id ?? null,
    generation: row.runtime_generation ?? 0,
    profileRevision: row.profile_revision ?? 0,
    controlRevision: row.runtime_control_revision ?? 0,
    model: row.profile_pending_model,
    effort: row.profile_pending_effort,
    profileHandoff: row.profile_handoff,
  }
}

// Restart recovery for a durable profile journal. Every destructive action is preceded by a SQLite
// checkpoint carrying an unguessable handoff token — planted in the relaunched worker's environment,
// so the exact process could be re-identified after a crash; every successful outcome returns only
// after the exact token+tuple runtime has been proven. The controller performs the final atomic
// commit/restore and otherwise deliberately leaves runtime_control='profile'.
/** Per-call shaping for a resume. See `freshProcess` — the usage-limit latch escape hatch. */
export interface ResumeOptions {
  /**
   * Relaunch the worker instead of injecting into the one that is already running.
   *
   * Set for a usage-limit resume fired before the provider's stated reset: the `claude` process behind
   * that thread latched on its 429 and refuses every input until then, so handing it the message is a
   * guaranteed no-op (see usage-limit.ts `limitResumeNeedsFreshProcess`). The broker path expresses the
   * same thing as `followUp({freshProcess})`.
   */
  freshProcess?: boolean
}

function resumeThreadOwned(deps: ResumeDeps, slug: string, message: string, deliveryId?: string, opts: ResumeOptions = {}): void {
  void deps; void message; void deliveryId; void opts
  // There is no local-CLI transport any more: every claude thread is broker-backed and every caller
  // (the followUp RPC, the wake scheduler) routes such a row to the bridge before reaching here. This
  // remains as the loud backstop so a future caller that forgets can never silently try to resume a
  // worker that does not exist, rather than as a path anything is expected to take.
  throw new Error(`${slug} must resume through the session broker; frizz has no other claude transport`)
}

export function resumeThread(deps: ResumeDeps, slug: string, message: string, deliveryId?: string, opts: ResumeOptions = {}): void {
  const initial = deps.storage.getSession(slug)
  if (!initial) throw new Error(`no session registered for ${slug}`)
  // Preserve the specific, actionable errors from the inner path before trying the durable claim.
  // These checks are repeated after claiming; the SQLite CAS is still the actual race barrier.
  if (initial.permission_pending !== null && initial.permission_pending !== undefined) {
    throw new RetryableDeliveryError("A permission change is in progress; wait for it to finish before sending a follow-up")
  }
  if (initial.profile_pending_model !== null && initial.profile_pending_model !== undefined ||
      initial.profile_pending_effort !== null && initial.profile_pending_effort !== undefined) {
    throw new RetryableDeliveryError("A model/effort change is in progress; wait for it to finish before sending a follow-up")
  }
  if (adoptionRuntimeBinding(deps.storage, initial).kind === "conflict") {
    throw new RetryableDeliveryError("This thread has a competing adoption attempt; no worker was contacted")
  }
  if (initial.runtime_control !== null && initial.runtime_control !== undefined) {
    throw new RetryableDeliveryError("Another runtime control is in progress; wait for it to finish before sending a follow-up")
  }
  const controlRevision = deps.storage.beginRuntimeControl(slug, {
    sessionId: initial.session_id,
    nativeSessionId: initial.agent_session_id ?? null,
    generation: initial.runtime_generation ?? 0,
  }, "follow-up")
  if (controlRevision === null) {
    // The exact race the client's per-slug FIFO cannot cover: a SECOND writer (the wakers scheduler,
    // another tab, the submit-confirmer) held the row for the ~300-800ms this injection needed. Nothing
    // was sent, so the operator's message is replayable — see RetryableDeliveryError.
    throw new RetryableDeliveryError("This thread changed or another runtime control started; no follow-up was sent")
  }
  try {
    resumeThreadOwned(deps, slug, message, deliveryId, opts)
  } finally {
    const current = deps.storage.getSession(slug)
    if (current?.session_id === initial.session_id && deps.storage.releaseRuntimeControl(slug, {
      sessionId: initial.session_id,
      generation: current.runtime_generation ?? 0,
      kind: "follow-up",
      revision: controlRevision,
    })) deps.board.refresh()
  }
}
