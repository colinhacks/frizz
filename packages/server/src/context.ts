import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  PermissionMode,
  wakeDeliveryToken,
  type CodexModel,
  type DispatchPreferences,
  type SetDispatchPreferenceInput,
  type Settings,
} from "@frizz/shared"
import { Bus, Emitter } from "./bus.ts"
import { resolveProject, permRequestDir, type Project } from "./project.ts"
import { createStorage, isBrokerClaudeRow, isHeadlessRow, type Storage } from "./storage.ts"
import type Database from "./sqlite.ts"
import { getSettings, setSettings, resetSettings } from "./settings.ts"
import { getDispatchPreferences, setDispatchPreference } from "./dispatch-preferences.ts"
import { readQuota } from "./quota.ts"
import { refreshClaudeQuotaInBackground } from "./backend/claude-quota.ts"
import { createBoard, type BoardManager } from "./board.ts"
import { createTailer, defaultLogDir, type Tailer } from "./tailer.ts"
import { createDispatcher, loadWorkerPrompt, scratchpadOrientation, frizzConfigBlock, claudeMcpConfig, resolveFrizzMcp, workerPluginDir, coldResumePermission, type Dispatcher, type FrizzMcpTarget } from "./dispatch.ts"
import { createScheduler, type Scheduler, probePrReadable, type PrRef, type PrProbe } from "./scheduler.ts"
import {
resumeThread,
} from "./resume.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { createCodexBackend, codexSandbox } from "./backend/codex.ts"
import { readClaudePreflightAuth, readCodexAuthState, readCodexBinaryState } from "./backend/auth-status.ts"
import { createLoginUtility, type LoginUtility } from "./login-utility.ts"
import type { AgentBackend } from "./backend/types.ts"
import { needsFreshProcessForLimit } from "./backend/usage-limit.ts"
import { detectGithub, type GithubDetection } from "./github.ts"
import type { InteractionStore } from "./interaction-store.ts"
import {
  codexAppServerBridgeEnabled,
  createCodexAppServerBridge,
  type CodexAppServerBridge,
  type CodexSandboxMode,
} from "./backend/codex-app-server.ts"
import { createCodexDiagnosticSink } from "./backend/codex-app-server-diagnostics.ts"
import {
  claudeBrokerBridgeEnabled,
  createClaudeAgentBrokerBridge,
  type ClaudeAgentBrokerBridge,
} from "./backend/claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest, type ClaudeRuntimeIngest } from "./backend/claude-runtime-ingest.ts"
import { describeClaudeBrokerDiagnostic, droppedDeliveryId } from "./backend/claude-broker-diagnostics.ts"
import { cancelDelivery } from "./delivery-ledger.ts"
import {
  ADOPTION_RECONCILE_INTERVAL_MS,
  adoptionRuntimeBinding,
  reconcileAdoptionClaims,
} from "./adoption-recovery.ts"
import { startOrphanReaper } from "./orphan-reaper.ts"
import { hibernationEnabled, startThreadHibernator } from "./thread-hibernation.ts"
import { liveBrokerRecords } from "./backend/claude-broker-host.ts"
import {
  createRetryableCleanup,
  createShutdownBarrier,
  DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
  type ShutdownBarrier,
  type ShutdownBarrierOptions,
  type ShutdownDiagnostic,
} from "./shutdown.ts"
import { log as frizzLog } from "./logging.ts"
import { projectScopedEnvironment } from "./project-launch.ts"
import { homedir } from "node:os"

export const CONTEXT_STARTUP_CLEANUP_TIMEOUT_MS = 4_000

// How often the server proactively refreshes the shared Claude quota cache (see the heartbeat wired
// below). One cheap endpoint GET every two minutes per account keeps the sidebar chip reading fresh.
const QUOTA_REFRESH_INTERVAL_MS = 2 * 60_000

export type ContextStartupPhase =
  | "storage"
  | "interaction expiry"
  | "adoption reconcile"
  | "orphan reaper"
  | "session reconcile"
  | "subscriptions"
  | "Codex app-server bridge"
  | "Claude broker bridge"
  | "tailer"
  | "board watcher"
  | "permission producer"
  | "profile producer"
  | "wake scheduler"
  | "thread hibernation"

export interface ContextStartupFence {
  whenSafe(): Promise<void>
  recover(): Promise<void>
}

export class ContextStartupError extends Error {
  readonly startupError: unknown
  readonly cleanupError: unknown
  readonly diagnostics: readonly ShutdownDiagnostic[]
  readonly fence: ContextStartupFence

  constructor(options: {
    startupError: unknown
    cleanupError: unknown
    diagnostics: readonly ShutdownDiagnostic[]
    fence: ContextStartupFence
  }) {
    const startupMessage = options.startupError instanceof Error ? options.startupError.message : String(options.startupError)
    const cleanupMessage = options.cleanupError instanceof Error ? options.cleanupError.message : String(options.cleanupError)
    super(`Frizz context initialization failed: ${startupMessage}; partial-context cleanup failed: ${cleanupMessage}`, {
      cause: options.startupError,
    })
    this.name = "ContextStartupError"
    this.startupError = options.startupError
    this.cleanupError = options.cleanupError
    this.diagnostics = [...options.diagnostics]
    this.fence = options.fence
  }
}

// The wired singletons every request handler shares. Built once at boot in createContext.
export interface AppContext {
  // Random per-process id minted at boot. It rides every board/board-delta SSE frame and the
  // `x-frizz-boot` header on /rpc responses; a client that sees it CHANGE knows the server restarted
  // under a possibly-stale page and hard-reloads once. Closes the stale-bundle / zombie-reconnect class.
  bootId: string
  project: Project
  bus: Bus
  // Internal (non-wire) per-tick signal: the batch of thread slugs whose session JSONL advanced this
  // tailer tick. The /ws transcript producer subscribes to it to PUSH updated transcripts to subscribed
  // clients (replacing the client's 1.5s poll). Kept off the wire ServerEvent bus deliberately.
  transcriptChange: Emitter<string[]>
  storage: Storage
  // Durable runtime-neutral interaction journal. Default TUI backends do not publish into it; the
  // disabled-by-default app-server foundation below is the only current provider adapter.
  interactions: InteractionStore
  // Experimental foundation for NEW bridge-owned Codex sessions only. Undefined by default; it is
  // never selected by backendFor and therefore cannot migrate or control an existing TUI session.
  codexAppServer?: CodexAppServerBridge
  // Session-broker bridge for Claude: the detached daemon that owns every claude thread's SDK session.
  // Undefined only under the FRIZZ_CLAUDE_BROKER_BRIDGE="0" kill switch, which leaves claude no transport.
  claudeBroker?: ClaudeAgentBrokerBridge
  board: BoardManager
  tailer: Tailer
  dispatcher: Dispatcher
  // Per-session agent-backend resolver behind the spawn/resume/transcript seam (Codex-support epic).
  // Maps a row's `backend` column (claude|codex) to its AgentBackend; DEFAULTS to claude for any unset/
  // unknown kind, so every existing session and all current behavior are unchanged until a dispatch
  // explicitly selects codex. Shared by the dispatcher, the tailer, and every resumeThread call.
  backendFor: (kind?: string) => AgentBackend
  // Durable timer scheduler (plus legacy pr/ci compatibility): resumes a rested `awaiting` session
  // on a witnessed transition. Human gates are descriptive. Started alongside the tailer; boot-safe.
  scheduler: Scheduler
  // Can the server's own `gh` read this PR? Asked by addOwnPrWatch before it arms a watcher, so a PR
  // the poll could never read is refused with the reason instead of armed in silence. Production wires
  // `probePrReadable` (one `gh pr view`); a test context injects its own answer.
  probePr: (ref: PrRef) => Promise<PrProbe>
  // Per-thread permission changes. Idle standalone TUIs are reopened on the same persisted
  // conversation with backend-native launch flags; busy/ambiguous states fail explicitly.
  // Proves an injected Claude follow-up was actually SUBMITTED, and re-presses Enter when the TUI
  // Detach storage-owned observers before board/storage teardown. Idempotent and synchronous so a
  // deferred interaction notification cannot enqueue fresh board work during the shutdown drain.
  stopSubscriptions(): void
  getSettings: () => Settings
  setSettings: (s: Settings) => Settings
  resetSettings: () => Settings
  // The prompt box's model + effort profile. Machine-level like `font` — one record for every project
  // this server serves (dispatch-preferences.ts) — which is why these close over `home` here rather
  // than the router reaching for it.
  getDispatchPreferences: (codexModels?: readonly CodexModel[]) => DispatchPreferences
  setDispatchPreference: (update: SetDispatchPreferenceInput, codexModels?: readonly CodexModel[]) => DispatchPreferences
  /**
   * Every project this PROCESS has open, with its board — the launching project and each tenant
   * activated since. Machine-wide reads (the rail's per-project queue counts) go through this rather
   * than opening databases: a count is a board fact (`needsYou` needs the tailer's runtime view), so a
   * project nobody has opened has no honest count, and this deliberately does not activate one to get
   * it. Absent under a test context or a one-project server, which read as "only this project".
   */
  activeTenants?: () => ReadonlyArray<{ project: Project; board: BoardManager }>
  /**
   * Take ONE project apart while every other project keeps serving — the resource half of deleting a
   * project (router `projectRemove`). The registry half is a machine-level index file the router
   * writes itself, which is why the two are split here rather than done in one place.
   *
   * It closes that project's transports, tailer, scheduler, board and storage and drops it from the
   * tenant map. `stopWorkers` additionally kills its live worker daemons: they are DETACHED by design,
   * so closing a tenant does not touch one — right for a shutdown, wrong for a delete, where a daemon
   * left running against a state directory that is about to be unlinked writes into files nobody can
   * see and can no longer be stopped from a UI whose board is gone. `deleteState` then removes
   * `~/.frizz/projects/<id>/`, which is everything Frizz holds for it.
   *
   * `closed` is false when the project was not open here — which does not stop `deleteState`, since a
   * project that failed to open still has a state directory. Supplied by the server, which owns the
   * tenant map; absent under a test context or a one-project server.
   */
  teardownProject?: (
    projectId: string,
    options?: { stopWorkers?: boolean; deleteState?: boolean },
  ) => Promise<{ closed: boolean; stoppedWorkers: number }>
  /**
   * The project this server was LAUNCHED from, which is the one project it cannot let go of.
   *
   * Its `<stateDir>/server.lock` is the only status file this process publishes, and every worker on
   * the machine resolves the port out of it (`serverLockPathFor`, index.ts) — so removing that project
   * is not one card disappearing, it is every live worker losing the server. Undefined under a test
   * context, where there is no launcher to protect.
   */
  launchProjectId?: string
  // GitHub detection (installed/inRepo/nameWithOwner) resolved ONCE at boot via initGithub() — stable
  // for the process lifetime. `authed` is NOT cached here; the githubStatus query re-checks it live so
  // a mid-session `gh auth login` reflects immediately. Undefined until initGithub() resolves (the
  // githubStatus handler falls back to a live detect during that ~30ms window). Kept OUT of the board
  // snapshot deliberately — no gh shell-out on every board delta.
  github?: GithubDetection
  // The dispatch Claude executable (tests use a stand-in). The account logout action runs the SAME
  // binary so sign-out targets the credential the workers actually use.
  claudeBin?: string
  // Same seam for Codex: the resolved app-server/backend executable, so codex login/logout target
  // the binary frizz actually runs rather than whatever "codex" is first on PATH.
  codexBin?: string
  // Slice B account utility: the restricted short-lived `claude auth login` terminal behind the
  // sign-in modal's primary action. Attempts ride the /term transport via slug-shaped opaque ids.
  loginUtility: LoginUtility
}

export interface ContextOptions {
  claudeBin?: string // injectable dispatch executable (tests use a stand-in)
  codexBin?: string // injectable app-server executable; unused unless the bridge flag is enabled
  // startServer pins the owner-verified project before any SQLite/tailer/scheduler initialization.
  project?: Project
  /**
   * The home whose `~/.frizz` holds the machine-level settings. Injectable so a test can point at a
   * sandbox: these were pure storage reads before machine settings existed, and a defaulted home is
   * exactly how a test run silently rewrote the maintainer's own `notifications` flag.
   */
  home?: string
  /**
   * The `server.lock` THIS PROCESS publishes — the launching project's, since that is the only one
   * written. Threaded to every tenant so a worker in a project the server did not launch from can
   * still find the port; omitted ⇒ the frizz MCP server falls back to this project's own state dir,
   * which is right for a one-project server and is all a pre-singleton build ever passed.
   */
  serverLockPath?: string
  /**
   * The unified database every project shares (frizz-db.ts), opened once by the server and closed by
   * it after the last tenant. Omitted ⇒ this context opens a PRIVATE file at `<stateDir>/ui.db` and
   * owns it — the shape a test wants, and one the next real boot folds in through the legacy import.
   */
  database?: Database
  /** See AppContext.activeTenants — supplied by the server, which owns the tenant map. */
  activeTenants?: AppContext["activeTenants"]
  /** See AppContext.teardownProject — supplied by the server, which owns the tenant map. */
  teardownProject?: AppContext["teardownProject"]
  /** See AppContext.launchProjectId — supplied by the server, which knows which project launched it. */
  launchProjectId?: string
  /** Internal deterministic construction/rollback seam. */
  startup?: {
    afterPhase?: (phase: ContextStartupPhase) => void
    cleanupTimeoutMs?: number
    cleanupDiagnostic?: (event: ShutdownDiagnostic) => void
    cleanupDeadline?: ShutdownBarrierOptions["deadline"]
  }
}

// Boot reconcile: a session row whose worker is no longer live was orphaned by a prior server exit
// (or the agent finished/was killed) — stamp exited so the registry doesn't show a forever-running
// ghost. Runtime is also derived live on each board build; this keeps the stored column honest too.
//
// It spawns nothing and asks the OS nothing, because both answers below are decidable from the row
// itself. It used to probe a live inventory of the machine's worker terminals — one subprocess per
// row, run synchronously, before the server could listen: 165 rows measured 5.2-6.3s of pure
// process-spawn on the maintainer's board and grew linearly with thread count, the larger half of the
// "context" boot phase. Batching that inventory into one ≤900ms-old snapshot removed the cost; the
// transport cutover removed the question.
export function reconcileSessions(storage: Storage) {
  for (const row of storage.allSessions()) {
    // A headless thread (codex app-server OR broker Claude) has NO process of frizz's own to look at by
    // construction — it lives in a detached daemon that OUTLIVES frizz. Reading its absence from this
    // process as death would stamp `exited` on every healthy headless thread at every boot — the exact
    // trap deriveRuntime() in board.ts refuses to fall into, and for the broker it would destroy the
    // whole ownerless-reconnect premise. Its liveness is resolved live on each board build (the bridge's
    // turn state / the daemon record); leave the stored column alone.
    if (isHeadlessRow(row)) continue
    // A non-headless row is PRE-CUTOVER: its transport was an interactive terminal session, and frizz
    // has not launched one since, so it cannot be alive. Mark it exited once at boot rather than
    // probing for a runtime that cannot exist.
    if (row.exited !== 1) {
      storage.setExitedIfCurrent(row.slug, row.session_id, row.runtime_generation ?? 0, true)
    }
  }
}

// Resolve the stable GitHub detection triple once and cache it on ctx.github. Never throws
// (detectGithub swallows every gh failure), so it is safe to fire-and-forget at boot: a broken or
// absent gh just leaves the feature off. Called from startServer without blocking the listen — the
// githubStatus handler live-detects during the brief pre-cache window.
export async function initGithub(ctx: AppContext): Promise<void> {
  ctx.github = await detectGithub(ctx.project.dir)
}

interface PartialContextResources {
  storage?: Storage
  stopSubscriptions?: () => void
  codexAppServer?: CodexAppServerBridge
  claudeBroker?: ClaudeAgentBrokerBridge
  claudeRuntimeIngest?: ClaudeRuntimeIngest
  board?: BoardManager
  tailer?: Tailer
  scheduler?: Scheduler
}

interface PartialContextCleanup {
  tailer(): Promise<void>
  subscriptions(): Promise<void>
  scheduler(): Promise<void>
  board(): Promise<void>
  codexAppServer(): Promise<void>
  claudeBroker(): Promise<void>
  storage(): Promise<void>
}

function partialContextCleanup(resources: PartialContextResources): PartialContextCleanup {
  return {
    tailer: createRetryableCleanup(() => resources.tailer?.stop()),
    subscriptions: createRetryableCleanup(() => resources.stopSubscriptions?.()),
    scheduler: createRetryableCleanup(async () => { await resources.scheduler?.stop() }),
    board: createRetryableCleanup(async () => { await resources.board?.stop() }),
    codexAppServer: createRetryableCleanup(async () => { await resources.codexAppServer?.shutdown() }),
    claudeBroker: createRetryableCleanup(async () => { resources.claudeBroker?.close(); resources.claudeRuntimeIngest?.close() }),
    storage: createRetryableCleanup(() => resources.storage?.close()),
  }
}

function contextCleanupBarrier(
  cleanup: PartialContextCleanup,
  opts: ContextOptions,
  diagnostic: (event: ShutdownDiagnostic) => void,
): ShutdownBarrier {
  return createShutdownBarrier({
    timeoutMs: opts.startup?.cleanupTimeoutMs ?? CONTEXT_STARTUP_CLEANUP_TIMEOUT_MS,
    // Bound + name each producer so a wedged one cannot stall startup-rollback cleanup indefinitely.
    phaseTimeoutMs: DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
    diagnostic,
    deadline: opts.startup?.cleanupDeadline,
    phases: [
      { name: "context tailer", run: cleanup.tailer },
      { name: "context subscriptions", run: cleanup.subscriptions },
      { name: "context wake scheduler", run: cleanup.scheduler },
      { name: "context board watcher", run: cleanup.board },
      {
        name: "context Codex app-server bridge",
        run: cleanup.codexAppServer,
      },
      {
        name: "context Claude broker bridge",
        run: cleanup.claudeBroker,
      },
    ],
    closeStorage: cleanup.storage,
  })
}

/**
 * Deliver a scheduler wake to a CODEX thread over the app-server bridge — adopting a legacy TUI-era
 * rollout first, then reactivating the persisted thread — exactly like the followUp RPC.
 *
 * Extracted from the scheduler `resume` closure so the promise contract below is directly testable.
 * It MUST return the promise rather than detaching it: the scheduler AWAITS `resume` and owns the
 * retry/supersede policy on rejection (scheduler.ts `deliverDue`). It previously ran this work in a
 * `void (async () => …)().catch(() => {})` IIFE and returned `undefined` synchronously, so the
 * scheduler saw an instant success and ACKED the delivery, while the real bridge failure landed
 * seconds later into a bare catch and vanished — no log, no retry, the wake lost permanently.
 * Claude's synchronous `resumeThread` throws straight into that same catch and retries correctly, so
 * the defect was CODEX-ONLY and silent: an `awaiting timer:` or limit-auto-resume codex thread could
 * simply never wake. See context.codex-wake.test.ts.
 */
export function deliverCodexWake(deps: {
  bridge: Pick<CodexAppServerBridge, "adoptExternalRollout" | "binding" | "resumeOwnedSession" | "followUp">
  storage: Pick<Storage, "setCodexRuntime">
  cwd: string
  row: { session_id: string; agent_session_id?: string | null; codex_runtime?: string | null }
  slug: string
  deliveryMessage: string
  deliveryId: string
}): Promise<void> {
  const { bridge, storage, cwd, row, slug, deliveryMessage, deliveryId } = deps
  return (async () => {
    if (row.codex_runtime !== "app-server" && row.agent_session_id) {
      await bridge.adoptExternalRollout({ threadSlug: slug, sessionId: row.session_id, codexThreadId: row.agent_session_id, cwd })
      storage.setCodexRuntime(slug, "app-server")
    }
    const binding = bridge.binding(slug, row.session_id)
    if (!binding || binding.state !== "active") await bridge.resumeOwnedSession(slug, row.session_id)
    await bridge.followUp({ threadSlug: slug, sessionId: row.session_id, text: deliveryMessage, deliveryId })
  })()
}

/**
 * A scheduled wake (awaiting-timer, limit-auto-resume) for a broker-backed Claude thread. The broker
 * has no local process to inject into, so the legacy `resumeThread` path would misfire (it throws
 * outright now); route through the bridge, which reconnects the live daemon's socket or cold-resumes a
 * dead one. Returns the promise so the scheduler owns the retry/supersede policy (see
 * deliverCodexWake for why detaching it loses the wake silently).
 * The worker system prompt is rebuilt so a cold resume re-applies it (ignored when the daemon is live).
 */
export function deliverClaudeBrokerWake(deps: {
  bridge: Pick<ClaudeAgentBrokerBridge, "followUp">
  slug: string
  cwd: string
  row: { session_id: string; model?: string | null; effort?: string | null; permission_mode?: string | null }
  /** The operator's Settings, for the floor a row with NO persisted mode cold-resumes at (coldResumePermission). */
  settings: Pick<Settings, "permissionMode">
  deliveryMessage: string
  /** Retire the live daemon first — see the bridge's followUp contract and needsFreshProcessForLimit. */
  freshProcess?: boolean
}): Promise<void> {
  const { bridge, slug, cwd, row, settings, deliveryMessage, freshProcess } = deps
  const appendSystemPrompt = [
    loadWorkerPrompt("claude"),
    scratchpadOrientation(row.session_id, "claude"),
    frizzConfigBlock(cwd),
  ].filter(Boolean).join("\n\n")
  return bridge.followUp({
    threadSlug: slug,
    sessionId: row.session_id,
    cwd,
    text: deliveryMessage,
    permissionMode: coldResumePermission(row, settings),
    appendSystemPrompt,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    freshProcess,
  })
}

/**
 * Context construction is atomic to startServer: if any constructor/reconciliation step throws,
 * every already-created timer, observer, bridge, watcher and storage handle drains behind the same
 * bounded lifecycle barrier before the error crosses the ownership boundary.
 */
/**
 * The per-PROJECT half of a shutdown, named so a caller can order it against its own phases.
 *
 * Process-level transports — the HTTP server, the terminal socket, the app socket, Vite — belong to
 * the server, not to any one project, and stay with startServer. Everything here belongs to a single
 * AppContext, which is what makes it reusable: today startServer runs these once at exit, and a
 * tenant lifecycle runs the same set when one project is deactivated while others keep serving.
 *
 * Every entry tolerates a MISSING context on purpose. Each shutdown phase is requiredForStorage by
 * default, so a TypeError here would not merely log — it would fail the whole barrier with "could not
 * safely close storage", turning a recoverable startup failure into a wedged one.
 */
export function projectContextCleanups(get: () => AppContext | undefined): {
  tailer: () => void
  loginUtility: () => void
  subscriptions: () => void
  scheduler: () => Promise<void>
  board: () => Promise<void>
  bridge: () => Promise<void>
  storage: () => void
} {
  return {
    tailer: () => get()?.tailer.stop(),
    loginUtility: () => get()?.loginUtility?.stop(),
    subscriptions: () => get()?.stopSubscriptions(),
    scheduler: async () => { await get()?.scheduler.stop() },
    board: async () => { await get()?.board.stop() },
    bridge: async () => { await get()?.codexAppServer?.shutdown() },
    storage: () => get()?.storage.close(),
  }
}

export async function createContext(opts: ContextOptions = {}): Promise<AppContext> {
  const resources: PartialContextResources = {}
  const cleanup = partialContextCleanup(resources)
  try {
    return createContextUnchecked(opts, resources)
  } catch (startupError) {
    const diagnostics: ShutdownDiagnostic[] = []
    const diagnostic = (event: ShutdownDiagnostic) => {
      diagnostics.push(event)
      opts.startup?.cleanupDiagnostic?.(event)
    }
    let barrier = contextCleanupBarrier(cleanup, opts, diagnostic)
    let activeSafety = barrier.whenDrained()
    void activeSafety.catch(() => undefined)
    let cleanupError: unknown
    try {
      await barrier.close()
      await activeSafety
    } catch (error) {
      cleanupError = error
    }
    if (!cleanupError) throw startupError

    let recovery: Promise<void> | null = null
    const fence: ContextStartupFence = {
      whenSafe: () => activeSafety,
      recover: () => {
        if (recovery) return recovery
        barrier = contextCleanupBarrier(cleanup, opts, diagnostic)
        activeSafety = barrier.whenDrained()
        void activeSafety.catch(() => undefined)
        const attempt = barrier.close().then(() => activeSafety)
        recovery = attempt
        void attempt.catch(() => {
          if (recovery === attempt) recovery = null
        })
        return attempt
      },
    }
    throw new ContextStartupError({ startupError, cleanupError, diagnostics, fence })
  }
}

function createContextUnchecked(opts: ContextOptions, resources: PartialContextResources): AppContext {
  const home = opts.home ?? homedir()
  const project = opts.project ?? resolveProject()
  // Per-PROJECT isolation (C3): two frizz instances must never see each other's workers. Everything
  // that could collide now keys on the resolved project's own state dir — this registry DB, the broker
  // daemon's record under `<stateDir>/claude-broker/` and the socket path hashed from it, the
  // app-server record — so isolation follows from resolving the project and there is no separate
  // per-instance runtime identity to derive. (There was one: workers ran under a shared multiplexer
  // server keyed by socket name, whose sessions were all called `frizz-<slug>`, so the socket had to be
  // derived from the stable project id before anything touched it, and a disposable child that re-read
  // it from the environment could move live workers onto another server mid-run.) The launcher/project
  // resolver still performs the crash-safe legacy migration exactly once and pins the result through
  // supervisor/child/reexec ownership.
  const storage = createStorage(opts.database ?? join(project.stateDir, "ui.db"), project.id)
  resources.storage = storage
  const bus = new Bus()
  const transcriptChange = new Emitter<string[]>()
  const bootId = randomUUID()
  // Late-bound for the journal observer and tailer callbacks; boot expiry runs before assignment and
  // needs no board edge because the first build reads authoritative pending state directly.
  let board!: BoardManager
  const contextUnsubscribers: (() => void)[] = []
  let subscriptionsStopped = false
  const stopSubscriptions = () => {
    if (subscriptionsStopped) return
    const failures: { unsubscribe: () => void; error: unknown }[] = []
    for (const unsubscribe of contextUnsubscribers.splice(0).reverse()) {
      try {
        unsubscribe()
      } catch (error) {
        failures.push({ unsubscribe, error })
      }
    }
    if (failures.length > 0) {
      // Preserve failed observers for an explicit recover() attempt while still trying every sibling.
      contextUnsubscribers.push(...failures.map(({ unsubscribe }) => unsubscribe).reverse())
      throw new AggregateError(
        failures.map(({ error }) => error),
        `could not detach ${failures.length} context subscription${failures.length === 1 ? "" : "s"}`,
      )
    }
    subscriptionsStopped = true
  }
  resources.stopSubscriptions = stopSubscriptions
  opts.startup?.afterPhase?.("storage")

  contextUnsubscribers.push(storage.interactions.subscribe((change) => {
    // The DB is project-local, but still verify the explicit protocol owner before publishing. A
    // malformed/future adapter can never leak another project's invalidation onto this server.
    if (change.projectId !== project.id) return
    bus.publish({
      type: "interactions-invalidated",
      slug: change.threadSlug,
      sessionId: change.sessionId,
      interactionId: change.interactionId,
      lifecycle: change.lifecycle,
      recordRevision: change.recordRevision,
    })
    board?.interactionChanged?.(change)
  }))
  storage.interactions.expireDue()
  opts.startup?.afterPhase?.("interaction expiry")

  reconcileAdoptionClaims({ storage, projectDir: project.dir })
  opts.startup?.afterPhase?.("adoption reconcile")
  // Permanent retired tokens are an active fence for pre-upgrade actors only if enforcement is
  // level-triggered. Sweep the durable claim/token ledger periodically so a stale claim is retired
  // within a bounded window even when no restart or new adoption occurs. (The sweep also asks the
  // recovery runtime whether a late token ever materialized as a worker to kill; the production
  // runtime answers "absent" to every such lookup since the cutover, so the ledger is the whole fence.)
  const adoptionReconcileTimer = setInterval(() => {
    try {
      reconcileAdoptionClaims({ storage, projectDir: project.dir, includeFinalized: false })
    } catch {
      // Retain every claim/tombstone and retry next tick; recovery is deliberately fail-closed.
    }
  }, ADOPTION_RECONCILE_INTERVAL_MS)
  adoptionReconcileTimer.unref?.()
  contextUnsubscribers.push(() => clearInterval(adoptionReconcileTimer))

  // Keep the shared Claude quota cache warm on a fixed 2-minute cadence, independent of any browser
  // poll, so the sidebar chip (and the scheduler's weekly-reset check) always reads a recent value
  // rather than the multi-minute-stale reading a purely read-driven cache served during a fast
  // fleet burn. One cheap endpoint GET, on the same non-blocking background path a stale read kicks;
  // the cross-process lock keeps N Frizz windows to ~one request every two minutes per account. Gated on the
  // same FRIZZ_WAKERS_OFF flag as the scheduler so a disposable adhoc/test stack never touches the real
  // account with the real credential.
  if (process.env.FRIZZ_WAKERS_OFF !== "1") {
    void refreshClaudeQuotaInBackground(opts.claudeBin) // warm immediately so the first read is fresh
    const quotaRefreshTimer = setInterval(() => {
      void refreshClaudeQuotaInBackground(opts.claudeBin)
    }, QUOTA_REFRESH_INTERVAL_MS)
    quotaRefreshTimer.unref?.()
    contextUnsubscribers.push(() => clearInterval(quotaRefreshTimer))
  }

  // Reap this machine's leaked worker aux — verification browsers (agent-browser/chrome-devtools/
  // puppeteer) and MCP/dev servers that daemonized out of a stopped worker's process tree, so nothing
  // else ever collects them. A sweep on startup clears accumulated leaks; the interval catches new
  // orphans (a stopped/crashed thread's browsers) within a bounded window. Reaps ONLY processes whose
  // FRIZZ_THREAD slug has no live claude/codex root; never a session root, never frizz itself, and
  // never a leftover multiplexer server from a pre-cutover frizz (orphan-reaper.ts keeps that one
  // guard deliberately — an operator may still be reading those panes).
  // FRIZZ_ORPHAN_REAPER_OFF disables it for disposable adhoc/test stacks (mirrors FRIZZ_WAKERS_OFF) so a
  // throwaway instance never reaps the real machine's processes.
  if (!process.env.FRIZZ_ORPHAN_REAPER_OFF) {
    contextUnsubscribers.push(startOrphanReaper({ log: (m) => frizzLog.info("reaper", m) }))
  }
  opts.startup?.afterPhase?.("orphan reaper")
  reconcileSessions(storage)
  opts.startup?.afterPhase?.("session reconcile")
  opts.startup?.afterPhase?.("subscriptions")

  // The agent backends behind the spawn/resume/transcript seam (Codex-support epic). The ClaudeBackend's
  // transcript dir matches the tailer's (defaultLogDir) so foreign-scan + per-session path stay
  // consistent; the CodexBackend uses $CODEX_HOME (default ~/.codex). `backendFor` maps a row's `backend`
  // column to the right one, DEFAULTING to claude for any unset/unknown kind — so a session is codex ONLY
  // when it was dispatched codex, and every claude path is byte-identical to before.
  // Where a worker of THIS project reaches the server, and whose board its frizz tools act on. One
  // process serves N projects but publishes ONE `server.lock` (the launcher's), and an unprefixed
  // `/_frizz/rpc/…` is the launching project by definition — so a tenant's workers need both halves
  // spelled out or their tools either cannot find the port at all or act on the wrong board.
  const frizzMcpTarget: FrizzMcpTarget = {
    stateDir: project.stateDir,
    ...(opts.serverLockPath ? { serverLock: opts.serverLockPath } : {}),
    projectId: project.id,
  }
  const claudeBackend = createClaudeBackend({ logDir: defaultLogDir(project), claudeBin: opts.claudeBin })
  const codexBackend = createCodexBackend({})
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : claudeBackend)
  const codexAppServer = codexAppServerBridgeEnabled()
    ? createCodexAppServerBridge({
        projectId: project.id,
        projectDir: project.dir,
        // The detached app-server daemon's socket + record live under the project state dir, so a
        // later frizz generation can find the app-server this one left running.
        stateDir: project.stateDir,
        // Codex's MCP servers mount PROCESS-wide on the app-server, not per thread, so the descriptor
        // is resolved once here — the codex twin of the per-dispatch resolveFrizzMcp on the claude side.
        frizzMcp: resolveFrizzMcp(frizzMcpTarget),
        db: storage.db,
        interactions: storage.interactions,
        codexBin: opts.codexBin,
        // Persist the bridge's lifecycle events so a mid-turn daemon death is diagnosable after the
        // fact. Before this the diagnostic sink was unset and every death — the six-sub-agent loss
        // included — was an unattributable "the thread went quiet." See codex-app-server-diagnostics.ts.
        diagnostic: createCodexDiagnosticSink(project.stateDir, project.id),
        // Never wake a thread the human has already put away: a restart-recovery nudge is only for a
        // thread that is still open and still theirs to come back to.
        shouldAutoResume: (slug) => {
          const row = storage.getSession(slug)
          return Boolean(row) && row?.state !== "archived" && row?.archived !== 1
        },
        // The operator's sandbox intent, so a COLD `thread/resume` carries it. frizz's registry is the
        // single authority here — `setThreadPermission` persists `permission_mode` on every change,
        // including the ones the eager apply could not deliver — which is what finally makes the
        // "saved for the next resume" copy true. Scoped by session id so a stale binding for a
        // replaced session can never pull a newer row's permission.
        sandboxFor: (slug, sessionId) => {
          const row = storage.getSession(slug)
          if (!row || row.backend !== "codex" || row.session_id !== sessionId) return undefined
          const mode = PermissionMode.safeParse(row.permission_mode)
          // No recorded intent (a row from before permission_mode was stamped) ⇒ send no override at
          // all, so the resume behaves exactly as it did before this existed.
          if (!mode.success) return undefined
          return codexSandbox(mode.data) as CodexSandboxMode
        },
      })
    : undefined
  resources.codexAppServer = codexAppServer
  if (codexAppServer) {
    contextUnsubscribers.push(storage.subscribeSessionLifecycle((event) => {
      codexAppServer.releaseSession(
        event.previous.slug,
        event.previous.session_id,
        event.type === "replaced" ? "session-replaced" : "session-deleted",
      )
    }))
  }
  // Rejoin the detached app-server daemon now rather than on first use. A turn that outlived our
  // restart is still running in there, and until we attach its `turn/completed` sits queued and the
  // board's stall grace would card the thread as crashed. Fire-and-forget: codex being unavailable
  // must never hold up (or fail) a boot.
  void codexAppServer?.warmUp()
  opts.startup?.afterPhase?.("Codex app-server bridge")

  // The consumer for the broker's structured event stream. Until this existed the bridge forwarded
  // every SDK event to a `deps.onEvent` nobody supplied, so the whole stream was dropped and the
  // tailer re-derived the same state by polling the SDK's JSONL off disk on a 1–10s tick. The ingest
  // does not replace that fold — it nudges it (re-read NOW, not on the next tick) and supplies the
  // provider's own turn reading, which the fold may consult but never be overridden by. See
  // backend/claude-runtime-ingest.ts. Created BEFORE the bridge because the bridge takes its handler;
  // its nudge target is the tailer, created below, so `tailer` is late-bound the same way `board` is.
  const claudeRuntimeIngest = claudeBrokerBridgeEnabled() ? createClaudeRuntimeIngest({ nudge: () => tailer.nudge?.() }) : undefined
  resources.claudeRuntimeIngest = claudeRuntimeIngest

  // Claude session-broker bridge — the detached daemon that owns every claude thread's SDK session,
  // and the only claude transport. FRIZZ_CLAUDE_BROKER_BRIDGE="0" turns it off, which leaves a claude
  // dispatch with nothing to run on rather than a second path. Permissions auto-allow for
  // now (matching today's `--permission-mode auto`); dashboard approval routing is the next slice.
  const claudeBroker = claudeBrokerBridgeEnabled()
    ? createClaudeAgentBrokerBridge({
        onEvent: (slug, sessionId, event) => claudeRuntimeIngest?.onEvent(slug, sessionId, event),
        // The ceiling this thread's daemon actually runs under, which is what the footer's context dial
        // has to divide by: a `[1m]` worker forked at the shipped 500K compacts at 500K, and reading its
        // fullness against 1M reported a comfortable 25% for a session that was half full.
        onCompactionWindow: (sessionId, window) => claudeRuntimeIngest?.noteCompactionWindow(sessionId, window),
        stateDir: project.stateDir,
        executablePath: opts.claudeBin ?? "claude",
        // Scoped to THIS project, not to whichever one launched the server — see
        // projectScopedEnvironment. A raw process.env spread is how project A identity would reach
        // project B agent once one process holds both.
        env: projectScopedEnvironment(process.env, {
          projectId: project.id,
          projectDir: project.dir,
          stateDir: project.stateDir,
          ...(project.identityScope ? { identityScope: project.identityScope } : {}),
        }),
        // Route Claude tool-permission escalations to the dashboard approval UI (provider-neutral
        // InteractionStore; the same store + web cards codex approvals use).
        interactions: storage.interactions,
        projectId: project.id,
        // The frizz worker environment — the SDK equivalent of the CLI argv's --plugin-dir / --mcp-config.
        // Computed ONCE here (constant per project) and applied on every broker fork so a broker worker
        // gets the frizz sub-agent profiles, the frizz MCP server (the only one frizz mounts), and the
        // cc-worker hooks. The project's own `.mcp.json` servers are merged in by the broker daemon at each
        // fork (project-mcp-servers.ts): under `--strict-mcp-config` nothing mounts that frizz did not hand over.
        workerEnv: {
          pluginDir: workerPluginDir(),
          ...claudeMcpConfig(resolveFrizzMcp(frizzMcpTarget)),
          permDir: permRequestDir(project),
        },
        // Read at every fork, not captured once: the compaction window is a Settings value the drawer
        // can change while the server runs, and the next dispatch or cold resume should carry it.
        getSettings: () => getSettings(storage, home),
        // Which broker threads warmUp() may reattach at boot. Same predicate codex's shouldAutoResume
        // applies: never wake a thread the human has already put away — a boot reattach is only for a
        // thread that is still open and still theirs to come back to. Broker-backed rows only; a
        // pre-cutover claude row has no daemon and a codex row is the other bridge's business.
        ownedSessions: () =>
          storage.allSessions()
            .filter((row) => isBrokerClaudeRow(row) && row.state !== "archived" && row.archived !== 1)
            .map((row) => ({ threadSlug: row.slug, sessionId: row.session_id, cwd: project.dir })),
        // The server log is the right surface for the two diagnostics worth a line — a daemon that died
        // (invisible to the live relay, so the bridge synthesizes it from the dead daemon's own exit
        // record) and an input the daemon threw away. It is what an operator, and the next agent
        // debugging a lost thread, already greps when a thread goes quiet. Which diagnostics qualify and
        // how they read is describeClaudeBrokerDiagnostic's business, so it stays testable on its own.
        onDiagnostic: (slug, _sessionId, diagnostic) => {
          const line = describeClaudeBrokerDiagnostic(diagnostic)
          if (line) frizzLog.warn("broker", `claude broker ${slug}: ${line}`)
          // A LOG LINE IS NOT ENOUGH, and this is where that was learned twice. The line above turned a
          // silent afternoon into one grep; it still left the operator staring at eight gray bubbles with
          // no way to move them. `ageDeliveries` holds an `enqueued` row for a full hour on the premise
          // that "an enqueue record is positive evidence Claude Code holds the message in its own queue"
          // — true of every other enqueue, and precisely false of a REFUSED one, which no one holds.
          //
          // So retire the row the instant the daemon says it threw the message away. Clicking the bubble
          // could not do it: unqueue asks the CURRENT daemon to cancel the id, and the daemon that
          // refused it is by then dead, so the answer is `false` and the operator gets "Too late — that
          // message has already left the queue", which is exactly backwards (maintainer 2026-08-05: "If
          // they've been dequeued and swallowed, then they shouldn't be showing up in the fucking UI").
          //
          // Tombstoning is SAFE here for the very reason the unqueue path is otherwise careful: the whole
          // content of this diagnostic is the provider stating it never received the message, so there is
          // no chance of hiding words the agent is about to read. cancelDelivery also drops the orphaned
          // JSONL enqueue bubble, and hands the text back for a re-send.
          const dropped = droppedDeliveryId(diagnostic)
          if (dropped) {
            cancelDelivery(storage, slug, dropped)
            resources.board?.refresh()
          }
        },
      })
    : undefined
  resources.claudeBroker = claudeBroker
  if (claudeBroker) {
    contextUnsubscribers.push(storage.subscribeSessionLifecycle((event) => {
      claudeBroker.releaseSession(
        event.previous.slug,
        event.previous.session_id,
        event.type === "replaced" ? "session-replaced" : "session-deleted",
      )
      // Drop the runtime turn reading with the session it described. A replaced session reuses the
      // slug, so a stale "running" left behind here would be consulted for the NEW session's row.
      claudeRuntimeIngest?.release(event.previous.session_id)
    }))
  }
  // Rejoin every broker daemon this project left running, now rather than on the next dispatch or
  // follow-up. The broker adopted purely lazily, so after a restart a turn still running inside a
  // detached daemon had nobody observing it: its queued events went unread (no ingest reading, no
  // tailer nudge), and — the real bug — a tool-permission escalation raised while frizz was down stayed
  // held in the daemon, so no approval card appeared and the thread read as hung until a human poked
  // it. The daemon re-delivers those pending requests on reconnect; this is what reconnects.
  // Fire-and-forget, exactly like codex's above: a broker being unavailable must never fail or delay a
  // boot.
  void claudeBroker?.warmUp()
  opts.startup?.afterPhase?.("Claude broker bridge")

  // The tailer derives turn/liveness telemetry and, on a state change, asks the board for an
  // OVERLAY-ONLY refresh (tailer changes never alter .frizz content — the full shell-out rebuild
  // here was the source of multi-second RPC stalls). Late-bound `board` breaks the cycle.
  // It ALSO reports, per tick, which sessions' JSONL advanced → fanned out on transcriptChange so the
  // /ws transcript producer can push (no board dependency; the two signals are independent).
  const tailer = createTailer({
    project,
    storage,
    bus,
    backendFor,
    onChange: () => board.refresh(),
    onTranscriptChange: (slugs) => transcriptChange.emit(slugs),
    // The SDK's own reading of a headless broker session: its turn (so the fold's 5s unknown-stop_reason
    // guess need not run out before a finished turn reaches the queue) and its event count (so a tick
    // can tell the provider has reported activity its own disk write has not caught up with yet).
    runtimeLiveness: claudeRuntimeIngest ? (sessionId) => claudeRuntimeIngest.liveness(sessionId) : undefined,
    // The provider's own report of what each sub-agent/background op is doing, and which ones it says
    // are finished — the payload the protocol used to discard, which is why the tailer had to
    // reconstruct child lifecycle from English prose. See applyRuntimeTasks for the authority split.
    runtimeTasks: claudeRuntimeIngest ? (sessionId) => claudeRuntimeIngest.tasks(sessionId) : undefined,
    // The model's context SIZE for a broker Claude session. Claude names it nowhere on disk, so this
    // is the only path to the footer readout's denominator for a Claude row (codex names its own on
    // every token_count and needs nothing here).
    runtimeContextWindow: claudeRuntimeIngest ? (sessionId) => claudeRuntimeIngest.contextWindow(sessionId) : undefined,
    // Codex's live background execs, off the app-server item stream. The counterpart of runtimeTasks
    // for the other provider — and the only source there is, since a codex exec's `processId` (the id
    // its × addresses) never reaches the rollout the tailer folds.
    codexBackgroundExecs: codexAppServer ? (slug, sessionId) => codexAppServer.backgroundExecs(slug, sessionId) : undefined,
  })
  resources.tailer = tailer
  opts.startup?.afterPhase?.("tailer")
  // The bridge is the authority on whether a codex app-server TURN is actually running — a rollout
  // frozen by a dead app-server reads "in-flight" forever on its own. Without this the board spins
  // such a thread on `running` and never queues it (live stall 2026-07-22).
  board = createBoard(project, storage, bus, tailer, bootId, {
    codexTurnLiveness: (slug, sessionId) => codexAppServer?.turnLiveness(slug, sessionId),
    // Headless-stall signal for a broker row: the ownerless daemon's record. Absent bridge ⇒ default
    // "alive" so a bridge-less server never falsely crash-cards a broker row (there are none anyway).
    claudeBrokerDaemonAlive: claudeBroker ? (sessionId) => claudeBroker.isDaemonAlive(sessionId) : undefined,
  })
  resources.board = board
  opts.startup?.afterPhase?.("board watcher")
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => getSettings(storage, home),
    claudeBin: opts.claudeBin,
    backendFor,
    codexAppServer,
    claudeBroker,
    // Auth preflight (claude-auth plan, Slice A): Claude reads its local credential and confirms only
    // a positive signed-out against its CLI (readClaudePreflightAuth — the comment there records why
    // the CLI must not sit on the signed-in path); Codex reads the local auth.json/env. Both block
    // only on a positive "signed-out" — everything else fails open.
    preflightAuth: (kind) =>
      kind === "codex"
        ? Promise.resolve(readCodexAuthState())
        : readClaudePreflightAuth({ claudeBin: opts.claudeBin, cwd: project.dir }),
    preflightCodexBinary: () => readCodexBinaryState(opts.codexBin ?? "codex"),
  })

  // Durable timer waker + legacy pr/ci compatibility. Reuses the SAME resume path as followUp;
  // boot-safe because it only fires on a condition it witnesses cross.
  const scheduler = createScheduler({
    storage,
    tailer,
    // Second wake source: every thread a subscription window cut off mid-turn gets its own "continue"
    // once that window rolls, over this same delivery path. The quota reader supplies the fallback
    // instant for a weekly limit, whose message text carries a clock but no date; readQuota memoizes,
    // so consulting it per tick costs a live request only every few minutes.
    readQuota,
    // The only runtime that can answer is the broker: its daemon record is on disk while the daemon
    // lives and is unlinked when it dies (liveBrokerRecords checks the pid), so "did the process that
    // took this wake survive" is one directory read. Codex and any row whose session moved on answer
    // "unknown", which keeps their wakes on the delivered-on-return path they always had.
    wakeRuntimeState: (slug, sessionId) => {
      const row = storage.getSession(slug)
      if (!row || row.session_id !== sessionId || row.backend !== "claude" || row.claude_runtime !== "broker" || !claudeBroker) return "unknown"
      return liveBrokerRecords(project.stateDir).some((r) => r.sessionId === sessionId) ? "alive" : "dead"
    },
    resume: (slug, message, deliveryId) => {
      const deliveryMessage = `${message}\n\n${wakeDeliveryToken(deliveryId)}`
      const row = storage.getSession(slug)
      // Codex wake: deliver over the app-server bridge (adopting a legacy TUI-era rollout first, then
      // reactivating the persisted thread), exactly like the followUp RPC. Codex never used the legacy
      // `resumeThread` path — it is CLAUDE-only, so a codex row must never reach it even when the
      // bridge is absent (only possible in a test context): drop the wake loudly instead of degrading.
      if (row?.backend === "codex") {
        const bridge = codexAppServer
        if (!bridge) {
          process.stderr.write(`[frizz] codex wake for ${slug} dropped: the app-server bridge is unavailable\n`)
          return
        }
        return deliverCodexWake({ bridge, storage, cwd: project.dir, row, slug, deliveryMessage, deliveryId })
      }
      // Broker Claude wake: no local process to inject into — deliver over the bridge (reconnect the
      // live daemon or cold-resume a dead one), exactly like the followUp RPC. Never reaches the legacy
      // `resumeThread` path.
      if (row?.backend === "claude" && row.claude_runtime === "broker") {
        if (!claudeBroker) {
          process.stderr.write(`[frizz] claude-broker wake for ${slug} dropped: the session broker is unavailable\n`)
          return
        }
        return deliverClaudeBrokerWake({
          bridge: claudeBroker,
          slug,
          cwd: project.dir,
          row,
          settings: getSettings(storage, home),
          deliveryMessage,
          // Recomputed here rather than carried on the delivery: the outbox stores a message, not a
          // runtime decision, and the tail is the live answer to "is this thread still behind a wall
          // its own process is enforcing".
          freshProcess: needsFreshProcessForLimit(
            tailer.get(slug)?.limitFault,
            Date.now(),
            (tailer.get(slug)?.subAgents ?? []).some((agent) => agent.state === "running"),
          ),
        }).then(() => {
          // A delivered wake resumed the worker (warm or cold), so a deliberate stop the row still
          // records is over — the same correction the followUp RPC makes, for the same reason: no
          // other path ever wrote `exited = 0` back, and a woken thread ran for hours under a column
          // that called it exited (2026-09-03).
          if (row.exited === 1) storage.setExitedIfCurrent(slug, row.session_id, row.runtime_generation ?? 0, false)
        })
      }
      resumeThread(
        { project, storage, board, getSettings: () => getSettings(storage, home), backendFor },
        slug,
        deliveryMessage,
        undefined,
        // Same latch, other transport: a pre-cutover worker that hit the wall needed a relaunch, not a
        // message injected into a process that was refusing input. Nothing reaches this arm with a live
        // transport any more — `resumeThread` throws for every row that can get here — so the flag is
        // carried for the shape of the call, not for a path that runs.
        {
          freshProcess: needsFreshProcessForLimit(
            tailer.get(slug)?.limitFault,
            Date.now(),
            (tailer.get(slug)?.subAgents ?? []).some((agent) => agent.state === "running"),
          ),
        },
      )
    },
  })
  resources.scheduler = scheduler
  opts.startup?.afterPhase?.("wake scheduler")

  // Reclaim the memory an IDLE broker thread holds — the `claude` CLI, the broker daemon, the frizz MCP
  // server, and whatever MCP servers the PROJECT itself configured — by retiring the daemon of a thread
  // that has rested past the prompt-cache TTL and has nothing outstanding. The 504 MB figure that
  // motivated this was measured 2026-08-19, when frizz auto-mounted chrome-devtools into every worker
  // (159 MB of that total); frizz mounts no browser since 2026-08-26, so a thread in a project that
  // brings none rests nearer ~345 MB and one that brings a browser is back at the old number. It is not an end: the transcript
  // is on disk and the next input (an operator message, a fired timer, a recurring prompt, a PR event —
  // all of which route through the bridge's followUp) cold-resumes it with `resume: true`. Above the TTL
  // that resume costs no extra tokens, because the cache is already gone.
  //
  // Wired here, after the tailer, because the sweep's whole safety predicate is read off it. Requires
  // the bridge for the same reason: without one there is no daemon to retire.
  // FRIZZ_HIBERNATE_OFF=1 disables it (mirrors FRIZZ_ORPHAN_REAPER_OFF); FRIZZ_HIBERNATE_IDLE_MINUTES
  // moves the threshold.
  if (claudeBroker && hibernationEnabled()) {
    contextUnsubscribers.push(startThreadHibernator({
      liveDaemons: () => liveBrokerRecords(project.stateDir).map((r) => ({ sessionId: r.sessionId, createdAt: r.createdAt })),
      rows: () => storage.allSessions(),
      telemetry: (slug) => tailer.get(slug),
      pendingInteractions: (threadSlug, sessionId) =>
        storage.interactions.listPending({ projectId: project.id, threadSlug, sessionId }).length,
      retire: (input) => claudeBroker.retireDaemon(input),
      log: (m) => frizzLog.info("hibernate", m),
    }))
  }
  opts.startup?.afterPhase?.("thread hibernation")

  return {
    bootId,
    project,
    bus,
    transcriptChange,
    storage,
    interactions: storage.interactions,
    codexAppServer,
    claudeBroker,
    board,
    tailer,
    dispatcher,
    scheduler,
    probePr: probePrReadable,
    stopSubscriptions,
    backendFor,
    getSettings: () => getSettings(storage, home),
    setSettings: (s) => setSettings(storage, s, home),
    resetSettings: () => resetSettings(storage, home),
    getDispatchPreferences: (codexModels) => getDispatchPreferences(storage, getSettings(storage, home), home, codexModels),
    setDispatchPreference: (update, codexModels) =>
      setDispatchPreference(storage, getSettings(storage, home), home, update, codexModels),
    activeTenants: opts.activeTenants,
    teardownProject: opts.teardownProject,
    launchProjectId: opts.launchProjectId,
    claudeBin: opts.claudeBin,
    codexBin: opts.codexBin,
    loginUtility: createLoginUtility({ claudeBin: opts.claudeBin, codexBin: opts.codexBin, cwd: project.dir }),
  }
}
