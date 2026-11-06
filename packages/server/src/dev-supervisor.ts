import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { createServer as createNetServer } from "node:net"
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import watcher, {
  type AsyncSubscription,
  type Event as WatchEvent,
  type Options as WatchOptions,
  type SubscribeCallback,
} from "@parcel/watcher"
import {
  currentProcessGeneration,
  projectLaunchEnvironment,
  projectLaunchRecordHasGeneration,
  readProjectLaunchOwner,
  removeProjectStatus,
  verifyProjectLaunchDelegate,
  writeProjectStatus,
  type ProjectLaunchTarget,
} from "./project-launch.ts"
import type { SessionDirectory } from "./access-codes.ts"
import type { RelayAccess } from "@frizz/shared"
import { auditLogPathForStateDir, fileAuditLog } from "./audit.ts"
import { RestartSupervisorProxy, type RestartResult } from "./restart-supervisor.ts"
import { log as frizzLog } from "./logging.ts"
import { BOOT_HARD_TIMEOUT_MS, BOOT_STALL_TIMEOUT_MS, readBootProgress } from "./boot-progress.ts"

export const DEV_RESTART_DEBOUNCE_MS = 180
export const DEV_CRASH_STABLE_MS = 5000
export const DEV_CRASH_RETRY_BASE_MS = 500
export const DEV_CRASH_RETRY_MAX_MS = 10_000
// A server's public shutdown deadline is diagnostic, not proof that its ownership fence is safe to
// abandon. Leave enough room for the child to finish that late drain before escalating to a signal.
const CHILD_STOP_TIMEOUT_MS = 15_000
/** A candidate's advancing boot progress renews this stall window, just like an ordinary launch. */
export const STABLE_UPDATE_READY_TIMEOUT_MS = BOOT_STALL_TIMEOUT_MS
/** Reject a ready-then-immediately-dead candidate before making its artifact durable. */
export const STABLE_UPDATE_STABILIZE_MS = 1_000
// POSIX only: how long a child that ignored the IPC ask gets to answer SIGTERM before SIGKILL. A
// child whose event loop is wedged answers neither, so this is the bound on a wedged child's life,
// not a second drain budget (its own force timer already fired at CHILD_STOP_TIMEOUT_MS).
const CHILD_KILL_GRACE_MS = 5_000
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"])
const CONFIG_NAMES = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"])
const CHILD_RUNTIME_PACKAGES = new Set(["server", "shared", "rpc", "claude-agent-sdk-runtime"])
const CHILD_PACKAGE_METADATA = new Set(["claude-agent-sdk-runtime"])
const GENERATED_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".vite",
])
// The watch root is the repo root now that the workspace is hoisted there, and the repo root holds
// far more than source: `.frizz/worktrees` (where the worker contract sends every git worktree) and
// `.claude/worktrees` contain entire sibling checkouts that other agents edit constantly. Those are
// never frizz source, so keep the recursive watcher out of them rather than paying to walk them and
// filtering the events afterwards. The globs below are matched RELATIVE to the watch root, so a dev
// server started from inside one of those checkouts still watches its own source (probed 2026-10-11
// from a worktree at `.frizz/worktrees/<slug>`).
const NON_SOURCE_ROOT_DIRS = new Set([
  ".claude",
  ".agents",
  ".frizz",
  "artifacts",
  "attachments",
  "qa-evidence",
  "scratch",
  "tmp",
])
const DEV_WATCH_IGNORE = [...GENERATED_DIRS, ...NON_SOURCE_ROOT_DIRS].map((dir) => `**/${dir}/**`)

export type DevChangeKind = "child" | "launcher"

/** Exponential retry prevents a ready-then-crash generation from spinning a fork/Vite loop. */
export function devCrashRetryDelay(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  return Math.min(DEV_CRASH_RETRY_BASE_MS * 2 ** exponent, DEV_CRASH_RETRY_MAX_MS)
}

export interface DevBoot {
  pid: number
  port: number
  bootId: string
}

/**
 * A lifecycle beat the FOREGROUND launcher prints in the operator's terminal.
 *
 * Deliberately NOT the same channel as `log`/`error`, which carry the run log's full record: this is
 * the short list of moments a person watching the launcher must not miss, and every one of them is a
 * state change they did not start from that terminal. Restart Frizz and Update Frizz are clicked in a
 * browser, and a control-plane crash is nobody's click at all — before this, all three left the
 * foreground process silent while the board went down and came back, so the terminal that owns the
 * board said less about it than the tab did.
 *
 * `ms` is present only on the beat that ENDS a restart, so a launcher can say how long it took.
 */
export interface SupervisorActivity {
  kind: "restarting" | "updating" | "ready" | "failed"
  /** One line, sentence case, already stripped of the "[frizz] " framing. */
  message: string
  /** Wall time of the restart this beat ends. */
  ms?: number
}

export interface DevSupervisorOptions {
  port: number
  /**
   * Bind address for the PUBLIC port only. Defaults to loopback. The disposable control-plane child
   * always stays on 127.0.0.1 regardless — the proxy is what the network reaches.
   */
  host?: string
  /** DNS names a browser may use as this server's authority once `host` is not loopback. */
  allowedHosts?: readonly string[]
  /** Serialized origin of a proxy/tunnel fronting the public port (`--public-origin`). */
  publicOrigin?: string
  /** Fired when an access code is redeemed, so the launcher can repaint a spent QR. */
  onCodeConsumed?: () => void
  /** A new device just signed in. See RestartSupervisorProxyOptions. */
  onDeviceSignedIn?: (device: { label: string; devices: number }) => void
  /** Persisted session-signing key, so devices stay signed in across restarts. */
  sessionKey?: Buffer
  /** Persists a replacement for `sessionKey` when every device is signed out. See RestartSupervisorProxyOptions. */
  rotateSessionKey?: () => Buffer
  /** Forwarded to the proxy so a sign-out survives a restart. See RestartSupervisorProxyOptions. */
  sessionDirectory?: SessionDirectory
  launchTarget: ProjectLaunchTarget
  launchOwnerToken: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  stateDir?: string
  watchRoots?: string[]
  /** Stable artifact mode disables source watching and Vite/HMR child boot. */
  watch?: boolean
  /** Additional child-only environment, read again for every controlled replacement. */
  childEnvironment?: () => NodeJS.ProcessEnv
  debounceMs?: number
  childEntry?: string
  /** Allows stable mode to fork the selected artifact runtime on every replacement. */
  childEntryProvider?: () => string
  /**
   * Select one immutable child launch snapshot immediately before each replacement. The entry and
   * environment must describe the same verified artifact; this is intentionally distinct from a
   * pair of independently-evaluated providers so a pointer change cannot split a generation.
   */
  childLaunchProvider?: () => { entry: string; environment: NodeJS.ProcessEnv }
  childArgs?: string[]
  /** Stable-mode only: build/preflight a candidate before the controlled child restart. */
  updateRestart?: () => Promise<RestartResult>
  /**
   * Source-backed artifacts replace the durable supervisor as well as its child. The registry
   * launcher's `child` mode retains this proxy/launcher, proves one candidate child, then commits it.
   */
  updateMode?: "durableReexec" | "child"
  /** Commit the prepared child selection only after that child is ready and remains alive briefly. */
  commitUpdate?: () => Promise<void> | void
  /** Candidate boot stall window for `updateMode: "child"`; injectable for real-child fixtures. */
  updateReadyTimeoutMs?: number
  /** Hard ceiling even if candidate boot progress keeps advancing. */
  updateHardTimeoutMs?: number
  /** Required healthy interval before committing a child update; injectable for real-child fixtures. */
  updateStabilizeMs?: number
  /** Cheap CACHED "is a newer artifact actually available" read; see RestartSupervisorProxy. */
  updateAvailable?: () => boolean
  /** The active application-server version. Registry launcher only; see RestartSupervisorProxy. */
  version?: string | (() => string | undefined)
  /** Stable launcher package version, exposed only as a diagnostic beside the server version. */
  launcherVersion?: string
  /** Cheap CACHED read of the newer registry version, when observed; see RestartSupervisorProxy. */
  updateVersion?: () => string | undefined
  /** Launched from a source checkout (frizz-dev / `pnpm dev`)? See RestartSupervisorProxy. */
  dev?: boolean
  /** Restore the known-good artifact selection if its replacement cannot become ready. */
  rollbackUpdate?: () => Promise<void> | void
  /**
   * Replace the durable owner after a successful immutable update.  This is deliberately separate
   * from a child recycle: a promoted artifact also contains the CLI/supervisor implementation.
   * The callback must preserve the tokenized project owner in its environment and never return on
   * success (normally it calls execve).
   */
  durableReexec?: () => Promise<void> | void
  /** Deterministic test seam. Production subscribes through @parcel/watcher. */
  watchSubscribe?: (root: string, callback: SubscribeCallback, options: WatchOptions) => Promise<AsyncSubscription>
  /** Test seam. Production uses process.execve so the launcher keeps its pid, cwd and stdio. */
  reexec?: (request: { executable: string; argv: string[]; env: Record<string, string> }) => void
  log?: (line: string) => void
  error?: (line: string) => void
  /** Lifecycle beats for the foreground launcher's terminal. See SupervisorActivity. */
  onActivity?: (event: SupervisorActivity) => void
  /**
   * A control-plane child exited, for any reason. The child shares the launcher's terminal, and Node
   * resets that terminal to the settings it saw at its own start as it exits — so a launcher holding
   * raw mode has to put it back here (PaneHost.reclaim).
   */
  onChildExit?: () => void
}

export interface DevSupervisor {
  readonly port: number
  /** Mint a single-use access link for the public origin, or null when none is declared. */
  issueAccessLink(): { code: string; url: string; expiresAt: number } | null
  /** Declare (or clear) the public origin on the running board; the gate follows at once. */
  setPublicOrigin(origin: string | undefined): void
  /** What a session through the relay may do. See RestartSupervisorProxy.setRelayAccess. */
  setRelayAccess(access: RelayAccess | undefined): void
  /** The port the relay agent dials, on which every request is public. See RestartSupervisorProxy.relayListener. */
  relayListener(): Promise<number>
  readonly firstBoot: Promise<DevBoot>
  readonly stopRequested: Promise<void>
  currentBoot(): DevBoot | null
  close(): Promise<void>
  /** Abandon a graceful drain and reclaim the control-plane child by force. */
  forceStop(): void
}

export interface SupervisorShutdownHandlerOptions {
  close: () => Promise<void>
  release: () => void
  exit: (code: number) => void
  error?: (line: string) => void
  /** Reclaim the control-plane child by force when the operator refuses to wait for the drain. */
  force?: () => void
  /**
   * Runs once, synchronously, when the FIRST signal starts the drain — before close() is called.
   * The launcher acknowledges the stop on the terminal here. Without it a Ctrl-C printed nothing
   * until the whole drain had finished, and a slow drain was indistinguishable from a dead key.
   */
  onStop?: () => void
  /**
   * How long the graceful drain may run before the supervisor gives up on it by itself. Every step
   * of close() is meant to be bounded (a child gets CHILD_STOP_TIMEOUT_MS, the proxy destroys its
   * connections), so this is the guarantee behind those bounds: a drain that does not finish is
   * forced, exactly as a second signal would force it, rather than holding the operator's terminal.
   */
  drainDeadlineMs?: number
  /** Deterministic test seam over setTimeout for the drain deadline. */
  scheduleForce?: (callback: () => void, delayMs: number) => { unref?: () => unknown }
  /**
   * How long after the first signal a repeat is still treated as the SAME stop rather than as an
   * impatient operator. One Ctrl-C is delivered to every process in the foreground group, and a shell
   * or npm-script wrapper forwards it again within the same tick — escalating on that would turn every
   * ordinary graceful stop into a forced kill. See SUPERVISOR_ESCALATE_GRACE_MS.
   */
  escalateAfterMs?: number
  /** Deterministic test seam. Production reads the monotonic clock. */
  now?: () => number
}

/** A human cannot withdraw their patience in under half a second; a forwarded signal always does. */
export const SUPERVISOR_ESCALATE_GRACE_MS = 500

/**
 * The drain's own bound: the child's whole stop budget (the ask, then SIGTERM, then SIGKILL) plus
 * room for the proxy to close. A drain still running past this has wedged somewhere no per-step
 * bound covers, and the operator gets the terminal back without having to find the second Ctrl-C.
 */
export const SUPERVISOR_DRAIN_DEADLINE_MS = CHILD_STOP_TIMEOUT_MS + CHILD_KILL_GRACE_MS + 5_000

/**
 * Idempotent, permanently-installed signal/control handler for the durable supervisor owner.
 *
 * The FIRST signal starts exactly one graceful close, however many arrive. A SECOND signal is the
 * operator saying they will not wait: escalate instead of swallowing it, so a wedged control-plane
 * child (whose reclaim is otherwise bounded only by CHILD_STOP_TIMEOUT_MS) can never look like a
 * launcher that ignores Ctrl-C. Escalation still releases the tokenized launch owner — a forced exit
 * must not strand the project — and reports a non-zero code because the drain did not complete.
 */
/** Call sites still build "[frizz] …" strings; the logger owns that framing now. */
function stripPrefix(line: string): string {
  return line.startsWith("[frizz] ") ? line.slice("[frizz] ".length) : line
}

export function createSupervisorShutdownHandler(options: SupervisorShutdownHandlerOptions): () => void {
  const now = options.now ?? (() => Date.now())
  const escalateAfterMs = options.escalateAfterMs ?? SUPERVISOR_ESCALATE_GRACE_MS
  const drainDeadlineMs = options.drainDeadlineMs ?? SUPERVISOR_DRAIN_DEADLINE_MS
  const scheduleForce = options.scheduleForce ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  let startedAt = 0
  let stopping = false
  let decided = false
  const decide = (code: number) => {
    if (decided) return
    decided = true
    try {
      options.release()
    } catch (error) {
      // An abandoned drain can still hold the project's ownership guard. Releasing is best-effort;
      // a failure here must never replace the exit with an unhandled stack over the operator's prompt.
      options.error?.(`[frizz] could not release launch ownership: ${error instanceof Error ? error.message : error}`)
    }
    options.exit(code)
  }
  const abandon = (reason: string) => {
    options.error?.(`[frizz] ${reason} — abandoning the graceful drain`)
    try {
      options.force?.()
    } catch (error) {
      options.error?.(`[frizz] forced supervisor stop failed: ${error instanceof Error ? error.message : error}`)
    }
    decide(1)
  }
  return () => {
    if (stopping) {
      // Same stop, delivered twice (process group + a forwarding wrapper) — not an impatient operator.
      if (decided || now() - startedAt < escalateAfterMs) return
      abandon("second stop signal")
      return
    }
    stopping = true
    startedAt = now()
    options.onStop?.()
    // unref'd: the deadline must never be what keeps a finished process alive.
    scheduleForce(() => {
      if (!decided) abandon(`graceful stop did not finish in ${drainDeadlineMs}ms`)
    }, drainDeadlineMs).unref?.()
    void options.close().then(
      () => decide(0),
      (error) => {
        options.error?.(`[frizz] supervisor shutdown failed: ${error instanceof Error ? error.message : error}`)
        decide(1)
      },
    )
  }
}

const packagesDir = resolve(import.meta.dirname, "..", "..")
const workspaceDir = resolve(packagesDir, "..")

/** The one "restart" that is not a restart: the very first boot. Worded differently for humans. */
const INITIAL_BOOT_REASON = "initial boot"

/** Runtime source trees that can change the server-side API/control plane. Web source stays on Vite HMR. */
export function defaultDevWatchRoots(): string[] {
  return [workspaceDir]
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** `relPath` is relative to the watch root that admitted the event, so only segments INSIDE the checkout
 *  can mark it generated. A checkout that itself lives under one of these names — a worktree in
 *  `~/.cache/…` — is still source; judged on the absolute path, every file in it was ignored. */
function ignoredDevPath(relPath: string): boolean {
  const parts = relPath.split(sep)
  const name = parts.at(-1) ?? ""
  return parts.some((part) => GENERATED_DIRS.has(part) || part === "fixtures" || part.endsWith(".fixtures"))
    || /\.(?:test|spec)\.[^.]+$/.test(name)
    || name.includes(".golden.")
}

/**
 * Pure watch classifier. Runtime source can use a cheap disposable-child recycle. Launcher, CLI,
 * dependency and compiler/startup config changes require a validated in-place parent re-exec too.
 */
export function classifyDevChange(path: string, roots = defaultDevWatchRoots()): DevChangeKind | null {
  const absolute = resolve(path)
  const root = roots.find((candidate) => isWithin(absolute, resolve(candidate)))
  if (!root) return null
  // `watchRoots` is a public test/embedding seam. Resolve package ownership against the root that
  // actually admitted this event rather than the source checkout captured at module-import time.
  const relToWorkspace = relative(resolve(root), absolute)
  if (ignoredDevPath(relToWorkspace)) return null

  const name = basename(absolute)
  const parts = relToWorkspace.split(sep)
  const packageName = parts[0] === "packages" ? parts[1] : undefined
  if (name === "package.json" && parts.length === 3 && packageName && CHILD_PACKAGE_METADATA.has(packageName)) {
    // This private dependency membrane is loaded only by the disposable control-plane child. Its
    // exports/dependencies must be revalidated, but replacing the stable launcher would buy nothing.
    return "child"
  }
  if (CONFIG_NAMES.has(name) || /^tsconfig(?:\.[^.]+)?\.json$/.test(name) || /^vite(?:\.[^.]+)?\.config\.[cm]?[jt]s$/.test(name)) {
    return "launcher"
  }
  if (!SOURCE_EXTENSIONS.has(extname(name))) return null

  // The CLI is the published root package, so its source is `src/` at the workspace root rather than
  // a member of `packages/`. It is the launcher itself: an edit here cannot be picked up by recycling
  // the disposable child, only by re-execing the parent. This branch must come BEFORE the
  // packages/-shaped check below, which would otherwise drop every launcher edit on the floor — and
  // do it silently, leaving a dev server serving code the developer had already changed.
  if (parts[0] === "src") return "launcher"

  if (parts[0] !== "packages" || parts[2] !== "src") return null
  const pkg = packageName
  if (pkg === "server") {
    if (name === "dev-supervisor.ts" || name === "dev.ts") return "launcher"
    return "child"
  }
  if (pkg && CHILD_RUNTIME_PACKAGES.has(pkg)) return "child"
  // Web source remains Vite HMR's responsibility. Its package/vite/tsconfig files matched above.
  return null
}

/** Back-compatible boolean used by focused tests and callers that only care whether a recycle occurs. */
export function isDevServerSource(path: string, roots = defaultDevWatchRoots()): boolean {
  return classifyDevChange(path, roots) !== null
}

/** Syntax-check config formats that a plain Node child boot does not necessarily consume itself. */
export function devConfigSyntaxError(path: string): string | null {
  const name = basename(path)
  const isTsconfig = /^tsconfig(?:\.[^.]+)?\.json$/.test(name)
  if (name !== "package.json" && !isTsconfig) return null
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    return `${name}: ${err instanceof Error ? err.message : err}`
  }
  if (name === "package.json") {
    try {
      JSON.parse(text)
      return null
    } catch (err) {
      return `${name}: ${err instanceof Error ? err.message : err}`
    }
  }
  if (isTsconfig) {
    try {
      // This is a dev-only preflight, not a compiler invocation. Supporting comments and trailing
      // commas here keeps a stable bundled runtime free of TypeScript and its build-only closure.
      JSON.parse(text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/,\s*([}\]])/g, "$1"))
      return null
    } catch (err) {
      return `${name}: ${err instanceof Error ? err.message : err}`
    }
  }
  return null
}

/** A child gets a copy of the caller's complete environment; only the private dev port marker is added. */
export function devChildEnv(env: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  return { ...env, FRIZZ_DEV_PORT: String(port), FRIZZ_DEV_CHILD: "1" }
}

/** Allocate a disposable control-plane port. The durable proxy keeps the public port throughout. */
async function allocatePrivateDevPort(publicPort: number): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = await new Promise<number>((resolvePort, rejectPort) => {
      const listener = createNetServer()
      listener.once("error", rejectPort)
      listener.listen(0, "127.0.0.1", () => {
        const address = listener.address()
        listener.close((error) => error ? rejectPort(error) : resolvePort(typeof address === "object" && address ? address.port : 0))
      })
    })
    // Vite's legacy source-only HMR companion is still private to the disposable child. Stable
    // artifacts do not create it, but reserving the pair keeps the legacy escape hatch coherent.
    const hmrPort = candidate + 39_000 <= 65_535 ? candidate + 39_000 : candidate - 1000
    if (candidate > 0 && candidate !== publicPort && await canBindPrivatePort(hmrPort)) return candidate
  }
  throw new Error("could not allocate a private Frizz control-plane port")
}

async function canBindPrivatePort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolveBind) => {
    const listener = createNetServer()
    listener.once("error", () => resolveBind(false))
    listener.listen(port, "127.0.0.1", () => listener.close(() => resolveBind(true)))
  })
}

export function devReexecEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const next = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  delete next.FRIZZ_DEV_CHILD
  delete next.FRIZZ_DEV_PORT
  next.FRIZZ_DEV_REEXEC = "1"
  return next
}

type ReadyMessage = { type: "frizz-ready"; pid: number; processStart: string; port: number; bootId: string }
function readyMessage(value: unknown): value is ReadyMessage {
  if (!value || typeof value !== "object") return false
  const msg = value as Partial<ReadyMessage>
  return msg.type === "frizz-ready"
    && typeof msg.pid === "number"
    && typeof msg.processStart === "string"
    && typeof msg.port === "number"
    && typeof msg.bootId === "string"
}

type StopOwnerMessage = { type: "frizz-stop-owner"; token: string }
function stopOwnerMessage(value: unknown): value is StopOwnerMessage {
  if (!value || typeof value !== "object") return false
  const msg = value as Partial<StopOwnerMessage>
  return msg.type === "frizz-stop-owner" && typeof msg.token === "string"
}

class Supervisor implements DevSupervisor {
  readonly port: number
  readonly firstBoot: Promise<DevBoot>
  readonly stopRequested: Promise<void>
  private resolveFirstBoot!: (boot: DevBoot) => void
  private resolveStopRequested!: () => void
  private child: ChildProcess | null = null
  private boot: DevBoot | null = null
  private subscriptions: AsyncSubscription[] = []
  private debounce: ReturnType<typeof setTimeout> | null = null
  private restartRunning = false
  private restartAgain = false
  /** Resolves when a pre-existing watcher restart has released the one child slot. */
  private restartCompletion: Promise<void> | null = null
  /** Serializes an update candidate with watcher/browser restart requests. */
  private updateChildRunning = false
  /** A candidate never joins crash-retry until its selection has committed. */
  private updateCandidate: ChildProcess | null = null
  private reloadLauncher = false
  private crashAttempts = 0
  private crashStableTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private stopping: ChildProcess | null = null
  private childPort: number | undefined
  private browserRestart: Promise<RestartResult> | null = null
  private readonly cwd: string
  private readonly parentEnv: NodeJS.ProcessEnv
  private readonly roots: string[]
  private readonly watchEnabled: boolean
  private readonly childEnvironment: () => NodeJS.ProcessEnv
  private readonly debounceMs: number
  private readonly childEntry: string
  private readonly childEntryProvider?: () => string
  private readonly childLaunchProvider?: () => { entry: string; environment: NodeJS.ProcessEnv }
  private readonly childArgs: string[]
  private readonly watchSubscribe: NonNullable<DevSupervisorOptions["watchSubscribe"]>
  private readonly reexec: DevSupervisorOptions["reexec"]
  private readonly supervisorLock: string | null
  private readonly statusPublisherToken = randomUUID()
  private readonly processGeneration = currentProcessGeneration()
  private readonly ownerToken: string
  private readonly launchTarget: ProjectLaunchTarget
  private readonly logLine: (line: string) => void
  private readonly errorLine: (line: string) => void
  private readonly onActivity?: (event: SupervisorActivity) => void
  private readonly onChildExit?: () => void
  /** Suppresses activity beats until the first boot has settled; until then the readout owns the terminal. */
  private booted = false
  /** When the restart currently in flight began, so its "ready" beat can report a duration. */
  private restartStartedAt: number | undefined
  /** Last beat emitted, so a transition reported twice is printed once. */
  private lastActivity: string | undefined
  private readonly publicProxy: RestartSupervisorProxy
  private readonly updateRestart?: () => Promise<RestartResult>
  private readonly updateMode: "durableReexec" | "child"
  private readonly commitUpdate?: () => Promise<void> | void
  private readonly updateReadyTimeoutMs: number
  private readonly updateHardTimeoutMs: number
  private readonly updateStabilizeMs: number
  private readonly rollbackUpdate?: () => Promise<void> | void
  private readonly durableReexec?: () => Promise<void> | void
  /** Environment of the generation that actually reached ready, never merely the latest pointer. */
  private activeChildEnvironment: NodeJS.ProcessEnv = {}
  private lastRestartFailure: string | undefined
  /**
   * True from the moment an update starts draining the old child until that update has settled.
   * Before it — the prepare phase — the old child is untouched and serving, and the status delegate
   * says so; during it the child bookkeeping reads as "failed" (no child, no boot), which is not
   * what a poll during those seconds should learn.
   */
  private handoffDraining = false

  constructor(opts: DevSupervisorOptions) {
    const launchOwner = verifyProjectLaunchDelegate(opts.launchTarget, opts.launchOwnerToken)
    const callerGeneration = currentProcessGeneration()
    if (
      launchOwner.pid !== callerGeneration.pid ||
      launchOwner.processStart !== callerGeneration.processStart
    ) throw new Error("dev supervisor caller is not the exact project launch owner")
    this.port = opts.port
    this.launchTarget = opts.launchTarget
    this.cwd = resolve(opts.cwd ?? opts.launchTarget.projectDir)
    if (this.cwd !== opts.launchTarget.projectDir) throw new Error("dev supervisor cwd does not match its owned project")
    this.parentEnv = projectLaunchEnvironment(opts.env ?? process.env, opts.launchTarget, opts.launchOwnerToken)
    this.roots = (opts.watchRoots ?? defaultDevWatchRoots()).map((root) => resolve(root))
    this.watchEnabled = opts.watch !== false
    this.childEnvironment = opts.childEnvironment ?? (() => ({}))
    this.debounceMs = opts.debounceMs ?? DEV_RESTART_DEBOUNCE_MS
    // EXEMPT from the sibling-.ts ban (detached-daemons.test.ts allowlists this line). The dev
    // supervisor is the SOURCE launcher: `frizz-dev` always runs from a checkout, where this file is
    // really on disk. Emitting dev-bootstrap.js into artifacts to "fix" the dangling path made things
    // strictly worse — it woke a control-plane fork that had been failing fast in every artifact ever
    // built, and the woken path crashed on an unguarded IPC send (EPIPE) and left delegates
    // registered against the developer's live project, wedging two repos (2026-07-23). Leave it
    // dangling in artifacts until that path is made safe to run there; failing fast is the better bug.
    this.childEntry = opts.childEntry ?? fileURLToPath(new URL("./dev-bootstrap.ts", import.meta.url))
    this.childEntryProvider = opts.childEntryProvider
    this.childLaunchProvider = opts.childLaunchProvider
    this.childArgs = opts.childArgs ?? []
    this.watchSubscribe = opts.watchSubscribe ?? ((root, callback, options) => watcher.subscribe(root, callback, options))
    // Not `typeof process.execve === "function"`: Node 24 on Windows exports it and throws
    // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM on the call (measured 2026-09-11), so the platform decides.
    this.reexec = opts.reexec ?? (process.platform !== "win32" && typeof process.execve === "function"
      ? (request) => process.execve!(request.executable, request.argv, request.env)
      : undefined)
    if (opts.stateDir && resolve(opts.stateDir) !== opts.launchTarget.stateDir) {
      throw new Error("dev supervisor state directory does not match its owned project")
    }
    this.supervisorLock = resolve(opts.launchTarget.stateDir, "dev-supervisor.lock")
    this.ownerToken = opts.launchOwnerToken
    // Default to the run log, NOT the terminal. The launcher repaints a region there and cannot
    // clear writes it did not make; every supervisor record the operator actually needs is either
    // surfaced through the readout or streamed by `--debug`.
    this.logLine = opts.log ?? ((line) => frizzLog.info("supervisor", stripPrefix(line)))
    this.errorLine = opts.error ?? ((line) => frizzLog.error("supervisor", stripPrefix(line)))
    this.onActivity = opts.onActivity
    this.onChildExit = opts.onChildExit
    this.updateRestart = opts.updateRestart
    this.updateMode = opts.updateMode ?? "durableReexec"
    this.commitUpdate = opts.commitUpdate
    this.updateReadyTimeoutMs = Math.max(1, opts.updateReadyTimeoutMs ?? STABLE_UPDATE_READY_TIMEOUT_MS)
    this.updateHardTimeoutMs = Math.max(1, opts.updateHardTimeoutMs ?? BOOT_HARD_TIMEOUT_MS)
    this.updateStabilizeMs = Math.max(0, opts.updateStabilizeMs ?? STABLE_UPDATE_STABILIZE_MS)
    this.rollbackUpdate = opts.rollbackUpdate
    this.durableReexec = opts.durableReexec
    this.publicProxy = new RestartSupervisorProxy({
      port: opts.port,
      host: opts.host,
      allowedHosts: opts.allowedHosts,
      publicOrigin: opts.publicOrigin,
      onCodeConsumed: opts.onCodeConsumed,
      onDeviceSignedIn: opts.onDeviceSignedIn,
      sessionKey: opts.sessionKey,
      rotateSessionKey: opts.rotateSessionKey,
      sessionDirectory: opts.sessionDirectory,
      audit: fileAuditLog(auditLogPathForStateDir(opts.launchTarget.stateDir)),
      childPort: () => this.childPort,
      restart: () => this.restartFromBrowser(),
      updateRestart: this.updateRestart ? () => this.updateFromBrowser() : undefined,
      updateAvailable: opts.updateAvailable,
      version: opts.version,
      launcherVersion: opts.launcherVersion,
      updateVersion: opts.updateVersion,
      dev: opts.dev,
      status: () => {
        // The proxy reports THIS answer, not its own acknowledged transition, while an update is in
        // flight: only this supervisor knows when the prepare phase ends and the drain begins.
        if (this.handoffDraining || this.browserRestart || this.restartRunning) return { state: "restarting" as const }
        const failed = this.child === null && this.boot === null
        const artifactDigest = this.activeChildEnvironment.FRIZZ_STABLE_ARTIFACT
        return failed
          ? { state: "failed" as const, message: "Frizz application server is not ready", ...(artifactDigest ? { artifactDigest } : {}) }
          : { state: "ready" as const, ...(artifactDigest ? { artifactDigest } : {}) }
      },
    })
    this.firstBoot = new Promise<DevBoot>((resolveFirstBoot) => {
      this.resolveFirstBoot = resolveFirstBoot
    })
    this.stopRequested = new Promise<void>((resolveStopRequested) => {
      this.resolveStopRequested = resolveStopRequested
    })
  }

  currentBoot(): DevBoot | null {
    return this.boot
  }

  /** Mint a single-use access link for the public origin, or null when none is declared. */
  setPublicOrigin(origin: string | undefined): void {
    this.publicProxy.setPublicOrigin(origin)
  }

  setRelayAccess(access: RelayAccess | undefined): void {
    this.publicProxy.setRelayAccess(access)
  }

  relayListener(): Promise<number> {
    return this.publicProxy.relayListener()
  }

  issueAccessLink(): { code: string; url: string; expiresAt: number } | null {
    const code = this.publicProxy.issueAccessCode()
    if (!code) return null
    const url = this.publicProxy.accessUrl(code.code)
    return url ? { code: code.code, url, expiresAt: code.expiresAt } : null
  }

  async start(): Promise<void> {
    if (this.supervisorLock) {
      mkdirSync(dirname(this.supervisorLock), { recursive: true })
      this.writeStatus("starting", "watcher initializing")
    }

    try {
      await this.publicProxy.listen()
      if (this.watchEnabled) {
        const settled = await Promise.allSettled(
          this.roots.filter(existsSync).map((root) => this.watchSubscribe(root, (err, events) => this.onWatch(err, events), {
            ignore: DEV_WATCH_IGNORE,
          })),
        )
        for (const result of settled) {
          if (result.status === "fulfilled") this.subscriptions.push(result.value)
          else this.errorLine(`[frizz] dev watch failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`)
        }
        if (this.subscriptions.length === 0) throw new Error("no Frizz server source tree could be watched")
      }
    } catch (err) {
      await this.publicProxy.close().catch(() => undefined)
      this.removeStatus()
      throw err
    }

    this.requestRestart(INITIAL_BOOT_REASON, true)
  }

  private onWatch(err: Error | null, events: WatchEvent[]): void {
    if (err) {
      this.errorLine(`[frizz] dev watch error: ${err.message}`)
      this.writeStatus("degraded", `watch error: ${err.message}`)
      return
    }
    let relevant: WatchEvent | undefined
    let kind: DevChangeKind | null = null
    const configPaths = new Set<string>()
    for (const event of events) {
      const candidate = classifyDevChange(event.path, this.roots)
      if (!candidate) continue
      configPaths.add(event.path)
      if (candidate === "launcher") {
        if (kind !== "launcher") relevant = event
        kind = "launcher"
      } else if (!kind) {
        relevant = event
        kind = "child"
      }
    }
    if (relevant && kind) {
      for (const path of configPaths) {
        const syntaxError = devConfigSyntaxError(path)
        if (!syntaxError) continue
        const message = `dev config invalid: ${syntaxError}; watching for a corrective edit`
        this.errorLine(`[frizz] dev ${message}`)
        this.writeStatus("failed", message)
        return
      }
      // A source edit is an explicit corrective generation, not another attempt in the prior crash run.
      this.crashAttempts = 0
      this.requestRestart(relative(workspaceDir, relevant.path), false, kind === "launcher")
    }
  }

  private requestRestart(reason: string, immediate = false, reloadLauncher = false, delayMs = this.debounceMs): void {
    if (this.closed) return
    // A candidate has exclusive ownership of the child slot. Preserve a watcher-triggered restart
    // for after the update resolves instead of allowing a second `fork()` beside the candidate.
    if (this.updateChildRunning) {
      this.restartAgain = true
      return
    }
    this.reloadLauncher ||= reloadLauncher
    if (this.debounce) clearTimeout(this.debounce)
    const run = () => {
      this.debounce = null
      const scope = this.reloadLauncher ? "control plane + launcher" : "control plane"
      // "restarting (initial boot)" is a contradiction the operator has to decode mid-startup, and it
      // reads like something already went wrong. On the first boot there is nothing to restart.
      this.logLine(
        reason === INITIAL_BOOT_REASON
          ? `[frizz] starting Frizz`
          : `[frizz] restarting ${scope} — ${reason}`,
      )
      this.writeStatus("restarting", reason)
      void this.restart()
    }
    if (immediate) run()
    else this.debounce = setTimeout(run, delayMs)
  }

  private async restart(): Promise<void> {
    if (this.updateChildRunning) {
      this.restartAgain = true
      return
    }
    if (this.restartRunning) {
      this.restartAgain = true
      return
    }
    this.restartRunning = true
    let completeRestart!: () => void
    const completion = new Promise<void>((resolveCompletion) => { completeRestart = resolveCompletion })
    this.restartCompletion = completion
    try {
      let shouldReloadLauncher = false
      do {
        this.restartAgain = false
        shouldReloadLauncher ||= this.reloadLauncher
        this.reloadLauncher = false
        await this.stopChild()
        // An update can arrive while a watcher restart is between its drain and spawn. It owns the
        // next child slot, so this older restart must finish without creating another generation.
        if (!this.closed && !this.updateChildRunning) {
          const ready = await this.spawnChild()
          // Keep the old watcher alive after a syntax/import/start failure. The next relevant edit is
          // another retry; crucially, a broken launcher never strands the running shell with no watcher.
          if (!ready) return
        }
      } while (this.restartAgain && !this.closed)
      if (shouldReloadLauncher && !this.closed) await this.reexecLauncher()
    } finally {
      this.restartRunning = false
      completeRestart()
      if (this.restartCompletion === completion) this.restartCompletion = null
    }
  }

  /**
   * A restart or an update drains the running child and forks its replacement in the project the
   * server is hosted on. Once that folder is deleted the fork fails with ENOENT, and a child given
   * any other cwd refuses to boot without its project — and so does the one that would put the old
   * child back, so the click meant to refresh the board stops it. The running child is unharmed by
   * the missing folder, so refuse before draining and leave it serving.
   *
   * Measured 2026-10-11 on a board hosted on a folder deleted a day later: its Update failed one
   * step earlier, on npm dying with `uv_cwd ENOENT`, and that accident was all that kept it up.
   */
  private missingLaunchFolder(): string | undefined {
    if (existsSync(this.cwd)) return undefined
    return `Frizz is running on ${this.cwd}, which no longer exists, so a new server cannot start there. Stop Frizz and start it again.`
  }

  /** Called only by the public supervisor control endpoint, never by ordinary document reloads. */
  private restartFromBrowser(): Promise<RestartResult> {
    if (this.browserRestart) return this.browserRestart
    const missing = this.missingLaunchFolder()
    if (missing) return Promise.resolve({ state: "failed", message: missing })
    const previousBoot = this.boot?.bootId
    const work = (async (): Promise<RestartResult> => {
      this.lastRestartFailure = undefined
      this.requestRestart("Restart Frizz requested from browser", true)
      const deadline = Date.now() + 30_000
      while (!this.closed && Date.now() < deadline) {
        const boot = this.boot
        if (boot && (!previousBoot || boot.bootId !== previousBoot)) return { state: "ready" }
        if (this.lastRestartFailure) {
          this.writeStatus("failed", this.lastRestartFailure, null)
          return { state: "failed", message: this.lastRestartFailure }
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      }
      const message = this.closed
        ? "Frizz supervisor stopped while restarting"
        : "Frizz application server did not become ready within 30 seconds"
      this.writeStatus("failed", message)
      return { state: "failed", message }
    })().finally(() => { this.browserRestart = null })
    this.browserRestart = work
    return work
  }

  private async updateFromBrowser(): Promise<RestartResult> {
    if (!this.updateRestart) return { state: "failed", message: "Update & Restart is unavailable in this launcher mode" }
    // Before preparing anything: both update modes end in a fork inside the launch folder.
    const missing = this.missingLaunchFolder()
    if (missing) return { state: "failed", message: missing }
    if (this.updateMode === "child") return this.updateChildFromBrowser()
    // The candidate is built and validated while the known-good child stays live. Only a successful
    // candidate reaches the controlled restart path, so a failed build never takes the board down.
    //
    // Announced BEFORE the await, not through writeStatus like every other beat: preparing a
    // candidate is the longest step of an update (a source build in frizz-dev, an npm install in the
    // registry launcher) and it writes no status at all, so the terminal would otherwise sit silent
    // for a minute and then jump straight to "restarting". The copy names neither, because this
    // beat cannot know which: it read "preparing the new build" for the registry launcher's npm
    // install (audit 2026-09-11, finding 6). The hook's own message, which does know, follows it.
    this.emitActivity("updating", "preparing the update — the running Frizz is untouched until it is ready")
    const candidate = await this.updateRestart()
    if (candidate.state !== "ready") {
      this.emitActivity("failed", candidate.message ?? "the update could not be prepared")
      return candidate
    }
    if (candidate.message) this.emitActivity("updating", candidate.message)
    if (!this.durableReexec) {
      return this.failDurableUpdate(
        "Update & Restart requires a durable supervisor handoff; the current supervisor was left running",
        false,
      )
    }
    // The child must be cleanly drained before exec.  The owner token, project database and the
    // detached worker daemons holding the provider sessions are not child resources and deliberately
    // survive this handoff.
    let handoffPreparationStarted = false
    try {
      handoffPreparationStarted = true
      await this.prepareDurableReexec()
      await this.durableReexec()
      return this.failDurableUpdate("durable supervisor handoff returned unexpectedly", true)
    } catch (error) {
      const message = `durable supervisor handoff failed: ${error instanceof Error ? error.message : error}`
      return this.failDurableUpdate(message, handoffPreparationStarted)
    } finally {
      // Only a failed handoff gets here (a successful one never returns from exec). The proxy has
      // this update's "failed" verdict in hand by the time a poll can next be served, so the
      // delegate may go back to describing the restored child.
      this.handoffDraining = false
    }
  }

  /**
   * Update only the disposable application server while retaining the public listener and launcher.
   * There is deliberately no blue/green overlap: a Frizz child opens SQLite, tailers and schedulers
   * before it can report ready, so a candidate is started only after the old child is fully gone.
   */
  private async updateChildFromBrowser(): Promise<RestartResult> {
    if (!this.commitUpdate || !this.rollbackUpdate) {
      return { state: "failed", message: "child-only Update & Restart requires commit and rollback callbacks" }
    }
    // This covers preparation too: source-watch restarts must not replace the old child while the
    // update callback is selecting a candidate for it.
    this.updateChildRunning = true
    try {
      // A watcher restart already in flight may be awaiting a private-port allocation. Let it drain
      // out under the exclusive update flag before selecting/spawning the candidate.
      await this.restartCompletion
      this.emitActivity("updating", "preparing the new build — the running one is untouched until it is ready")
      let prepared: RestartResult
      try {
        prepared = await this.updateRestart!()
      } catch (error) {
        return this.failChildUpdate(`the update could not be prepared: ${error instanceof Error ? error.message : error}`, false)
      }
      if (prepared.state !== "ready") {
        return this.failChildUpdate(prepared.message ?? "the update could not be prepared", false)
      }
      if (this.closed) return this.failChildUpdate("Frizz supervisor stopped while preparing the update", false)
      if (prepared.message) this.emitActivity("updating", prepared.message)
      // Do not run two server children. The old generation owns the shared runtime resources until
      // this exact drain completes; only then may the prepared launch provider select its candidate.
      this.handoffDraining = true
      await this.stopChild()
      if (this.closed) return this.failChildUpdate("Frizz supervisor stopped while starting the update", true)
      const ready = await this.spawnChild({
        updateCandidate: true,
        readinessTimeoutMs: this.updateReadyTimeoutMs,
        hardTimeoutMs: this.updateHardTimeoutMs,
      })
      const candidate = this.child
      if (!ready || !candidate) {
        return this.failChildUpdate(this.lastRestartFailure ?? "the update candidate did not become ready", true)
      }
      if (!await this.stabilizeUpdateCandidate(candidate)) {
        return this.failChildUpdate("the update candidate stopped before it became stable", true)
      }
      try {
        await this.commitUpdate()
      } catch (error) {
        return this.failChildUpdate(`the update could not be committed: ${error instanceof Error ? error.message : error}`, true)
      }
      // `close()` can race a synchronous store commit. Restore the prior selection rather than
      // leaving a dead launcher pointing at an update it never got to serve.
      if (this.closed || this.child !== candidate || candidate.exitCode !== null || candidate.signalCode !== null) {
        return this.failChildUpdate("the update candidate stopped while committing the update", true)
      }
      this.updateCandidate = null
      this.lastRestartFailure = undefined
      return { state: "ready" }
    } finally {
      this.updateChildRunning = false
      this.handoffDraining = false
      // A source edit that arrived during preparation is meaningful, but it must run only after the
      // candidate has either committed or the prior selection has been restored.
      if (this.restartAgain && !this.closed) {
        this.restartAgain = false
        this.requestRestart("changes received while updating", true)
      }
    }
  }

  /** Wait past a ready event so an immediate post-boot crash cannot be made durable. */
  private async stabilizeUpdateCandidate(candidate: ChildProcess): Promise<boolean> {
    if (this.child !== candidate || candidate.exitCode !== null || candidate.signalCode !== null) return false
    if (this.updateStabilizeMs === 0) return true
    return new Promise<boolean>((resolveStable) => {
      let settled = false
      const finish = (stable: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        candidate.removeListener("exit", exited)
        resolveStable(stable)
      }
      const exited = () => finish(false)
      const timer = setTimeout(() => finish(this.child === candidate && !this.closed), this.updateStabilizeMs)
      timer.unref()
      candidate.once("exit", exited)
    })
  }

  /** Restore the prepared selection and, if it was drained, put the known-good child back. */
  private async failChildUpdate(message: string, restoreChild: boolean): Promise<RestartResult> {
    const failures: string[] = []
    // Never let an uncommitted candidate run after an update failure. Its exit handler is explicitly
    // retry-suppressed, so this also cannot turn a bad candidate into a watchdog restart loop.
    const candidate = this.updateCandidate
    if (candidate && this.child === candidate) await this.stopChild()
    this.updateCandidate = null
    let rolledBack = false
    if (!this.rollbackUpdate) failures.push("rollback callback is unavailable")
    else {
      try {
        await this.rollbackUpdate()
        rolledBack = true
      } catch (error) {
        failures.push(`rollback failed: ${error instanceof Error ? error.message : error}`)
      }
    }
    // The provider resolves from its current mutable selection. If rollback did not put that
    // selection back, spawning here could resurrect the very candidate we just rejected.
    if (restoreChild && rolledBack && !this.closed) {
      try {
        const restored = await this.spawnChild()
        if (!restored) failures.push(`control plane recovery failed: ${this.lastRestartFailure ?? "the previous child did not become ready"}`)
      } catch (error) {
        failures.push(`control plane recovery failed: ${error instanceof Error ? error.message : error}`)
      }
    } else if (restoreChild && !rolledBack) {
      failures.push("control plane was not restarted because rollback did not restore a known-good selection")
    }
    const detail = failures.length > 0 ? `${message}; ${failures.join("; ")}` : message
    this.errorLine(`[frizz] ${detail}`)
    // `close()` has removed the owner status and public listener. A late prepare/commit completion
    // must not resurrect either observability state or a child after that shutdown boundary.
    if (!this.closed) this.writeStatus("failed", detail, this.boot)
    return { state: "failed", message: detail }
  }

  /**
   * A promoted pointer is not committed until its durable owner has actually been replaced.  If
   * that handoff cannot happen, put the previous pointer back before reporting the failure.  When
   * draining has already started, rebuild this same owner in place so a thrown/injected exec does
   * not leave a lease-holding but closed supervisor behind.
   */
  private async failDurableUpdate(message: string, restoreSupervisor: boolean): Promise<RestartResult> {
    const failures: string[] = []
    if (!this.rollbackUpdate) {
      failures.push("rollback callback is unavailable")
    } else {
      try {
        await this.rollbackUpdate()
      } catch (error) {
        failures.push(`rollback failed: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (restoreSupervisor) {
      try {
        await this.restoreAfterFailedDurableUpdate()
      } catch (error) {
        failures.push(`supervisor recovery failed: ${error instanceof Error ? error.message : error}`)
      }
    }

    const detail = failures.length > 0 ? `${message}; ${failures.join("; ")}` : message
    this.errorLine(`[frizz] ${detail}`)
    this.writeStatus("failed", detail, this.boot)
    return { state: "failed", message: detail }
  }

  /** Restore this exact lease-owning supervisor after prepare/re-exec failed before replacement. */
  private async restoreAfterFailedDurableUpdate(): Promise<void> {
    this.closed = false
    await this.publicProxy.listen()
    const ready = await this.spawnChild()
    if (!ready) throw new Error("the recovered control plane did not become ready")
  }

  private async prepareDurableReexec(): Promise<void> {
    // The drain starts HERE, not when the update was accepted: everything before this line left the
    // old child serving, and the status delegate reported it so.
    this.handoffDraining = true
    this.closed = true
    this.clearCrashStability()
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    await Promise.allSettled(this.subscriptions.map((sub) => sub.unsubscribe()))
    this.subscriptions = []
    await this.stopChild()
    // Do not release the tokenized project lease or delete the owner status.  exec replaces this
    // PID; the successor proves and adopts that exact lease before it opens a replacement proxy.
    await this.publicProxy.close()
    this.writeStatus("restarting", "immutable artifact promoted; re-executing durable supervisor", null)
  }

  private async spawnChild(options: { updateCandidate?: boolean; readinessTimeoutMs?: number; hardTimeoutMs?: number } = {}): Promise<boolean> {
    const privatePort = await allocatePrivateDevPort(this.port)
    let launch: { entry: string; environment: NodeJS.ProcessEnv } | undefined
    try {
      launch = this.childLaunchProvider?.()
    } catch (error) {
      const message = `child launch selection failed: ${error instanceof Error ? error.message : error}; watching for a corrective edit`
      this.lastRestartFailure = message
      this.errorLine(`[frizz] ${message}`)
      this.writeStatus("failed", message, null)
      return false
    }
    return new Promise((settled) => {
      if (this.closed) return settled(false)
      let child: ChildProcess
      try {
        child = fork(launch?.entry ?? this.childEntryProvider?.() ?? this.childEntry, this.childArgs, {
          cwd: this.cwd,
          env: devChildEnv({ ...this.parentEnv, ...(launch?.environment ?? this.childEnvironment()) }, privatePort),
          // The supervisor may itself run under `node --input-type`, `--test`, an inspector, etc. Those
          // parent-only flags are invalid or dangerous for a file-backed control-plane child.
          execArgv: [],
          stdio: ["inherit", "inherit", "inherit", "ipc"],
          // A registry update leaves this supervisor with no console on Windows (its successor starts
          // detached). A console program forked from a console-less parent gets a new, VISIBLE console
          // window, and closing that window would stop the board. `windowsHide` keeps the window from
          // appearing (measured 2026-09-07: hwnd 0 for the child and its children). No effect elsewhere.
          // `fork` passes it to `spawn` at runtime; `ForkOptions` in @types/node 24 does not declare it.
          ...({ windowsHide: true } as object),
        })
      } catch (error) {
        const message = `child spawn failed: ${error instanceof Error ? error.message : error}; watching for a corrective edit`
        this.lastRestartFailure = message
        this.errorLine(`[frizz] ${message}`)
        this.writeStatus("failed", message, null)
        settled(false)
        return
      }
      this.child = child
      if (options.updateCandidate) this.updateCandidate = child
      this.childPort = privatePort
      this.boot = null
      let started = false
      let ownershipRejected = false
      let spawnSettled = false
      let readinessTimer: ReturnType<typeof setTimeout> | undefined
      const settleSpawn = (ready: boolean) => {
        if (spawnSettled) return
        spawnSettled = true
        if (readinessTimer) clearTimeout(readinessTimer)
        settled(ready)
      }
      if (options.readinessTimeoutMs !== undefined) {
        // Updating can provision a new provider pin (hundreds of MB) before the server is ready.
        // A flat 30s cutoff killed healthy downloads. Only this candidate's advancing counter buys
        // more time; a stale/foreign progress file must never keep a stuck candidate alive.
        const stallMs = options.readinessTimeoutMs
        const hardMs = options.hardTimeoutMs ?? BOOT_HARD_TIMEOUT_MS
        const hardDeadline = Date.now() + hardMs
        let stallDeadline = Date.now() + stallMs
        let lastStep = -1
        let lastPhase: string | undefined
        const checkProgress = () => {
          if (spawnSettled) return
          const now = Date.now()
          const progress = readBootProgress(this.launchTarget.stateDir)
          if (progress && progress.pid === child.pid && progress.step > lastStep) {
            lastStep = progress.step
            lastPhase = progress.phase
            stallDeadline = now + stallMs
          }
          if (now < stallDeadline && now < hardDeadline) {
            readinessTimer = setTimeout(checkProgress, Math.min(250, stallDeadline - now, hardDeadline - now))
            readinessTimer.unref()
            return
          }
          const reason = now >= hardDeadline
            ? `update candidate did not become ready within ${hardMs}ms`
            : `update candidate made no boot progress for ${stallMs}ms`
          const message = lastPhase ? `${reason}; last boot step: ${lastPhase}` : reason
          this.lastRestartFailure = message
          this.errorLine(`[frizz] ${message}`)
          this.writeStatus("failed", message, null)
          try { child.kill("SIGTERM") } catch { /* exit handler owns cleanup */ }
          settleSpawn(false)
        }
        checkProgress()
      }

      child.on("message", (message) => {
        if (stopOwnerMessage(message) && message.token === this.ownerToken) {
          this.resolveStopRequested()
          return
        }
        if (!readyMessage(message) || child !== this.child) return
        const owner = readProjectLaunchOwner(this.launchTarget.stateDir)
        if (
          !owner ||
          owner.token !== this.ownerToken ||
          owner.projectId !== this.launchTarget.projectId ||
          owner.projectDir !== this.launchTarget.projectDir ||
          message.pid !== child.pid ||
          message.port !== privatePort ||
          !projectLaunchRecordHasGeneration(owner, { pid: message.pid, processStart: message.processStart })
        ) {
          const detail = "control plane reported ready without a registered owner-bound generation"
          ownershipRejected = true
          this.errorLine(`[frizz] dev ${detail}`)
          this.writeStatus("failed", detail)
          child.kill("SIGTERM")
          settleSpawn(false)
          return
        }
        started = true
        const boot = { pid: message.pid, port: this.port, bootId: message.bootId }
        this.boot = boot
        this.activeChildEnvironment = launch?.environment ?? this.childEnvironment()
        this.lastRestartFailure = undefined
        this.resolveFirstBoot(boot)
        this.logLine(`[frizz] dev control plane ready (pid ${boot.pid}, boot ${boot.bootId.slice(0, 8)})`)
        this.writeStatus("ready", "control plane ready", boot)
        this.armCrashStability(child)
        settleSpawn(true)
      })
      child.once("error", (err) => {
        const message = `child spawn failed: ${err.message}; watching for a corrective edit`
        this.lastRestartFailure = message
        this.errorLine(`[frizz] ${message}`)
        this.writeStatus("failed", message)
        settleSpawn(false)
      })
      child.once("exit", (code, signal) => {
        try {
          this.onChildExit?.()
        } catch {
          // A launcher whose terminal is gone must never take the board down with it.
        }
        if (this.child === child) {
          this.child = null
          this.childPort = undefined
          this.boot = null
          this.activeChildEnvironment = {}
        }
        // A prepared update has not committed its launch selection yet. It may fail or exit, but it
        // must never enter the normal crash watchdog (which would fork it again against a rollback).
        const expected = this.closed || this.stopping === child || ownershipRejected || this.updateCandidate === child
        this.clearCrashStability()
        if (!expected) {
          const why = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`
          const retryDelay = started ? devCrashRetryDelay(++this.crashAttempts) : 0
          const message = started
            ? `control plane stopped (${why}); retry ${this.crashAttempts} in ${retryDelay}ms`
            : `control plane stopped (${why}) before ready; watching for a corrective edit`
          if (!started) this.lastRestartFailure = message
          this.errorLine(`[frizz] dev ${message}`)
          this.writeStatus("failed", message)
          // A previously-ready control plane crash is transient until proved otherwise. Restart it;
          // pre-ready syntax/import failures stay quiet under the healthy old watcher until an edit.
          if (started) this.requestRestart("unexpected control-plane exit", false, false, retryDelay)
        }
        if (this.stopping === child) this.stopping = null
        settleSpawn(false)
      })
    })
  }

  /**
   * One beat to the foreground terminal, deduped.
   *
   * Every transition already funnels through writeStatus, so this hangs off that single point rather
   * than off the dozen call sites that report one — a path added later cannot forget to announce
   * itself. The dedupe matters because a failure is often written twice (the crash handler, then the
   * browser-restart waiter that observed it), and the operator should read that once.
   */
  private emitActivity(kind: SupervisorActivity["kind"], message: string, ms?: number): void {
    if (!this.onActivity) return
    const signature = `${kind}\u0000${message}`
    if (signature === this.lastActivity) return
    this.lastActivity = signature
    try {
      this.onActivity({ kind, message, ...(ms === undefined ? {} : { ms }) })
    } catch {
      // A launcher whose terminal write fails must never take the board down with it.
    }
  }

  private writeStatus(state: "starting" | "restarting" | "ready" | "failed" | "degraded", message: string, boot = this.boot): void {
    // Before the first ready the launcher's own boot readout is painting the terminal, and a beat
    // printed into that region would be erased by the next repaint anyway.
    if (state === "ready" && !this.booted) this.booted = true
    else if (this.booted) {
      if (state === "restarting") {
        this.restartStartedAt = Date.now()
        this.emitActivity("restarting", message)
      } else if (state === "ready") {
        const startedAt = this.restartStartedAt
        this.restartStartedAt = undefined
        this.emitActivity("ready", message, startedAt === undefined ? undefined : Date.now() - startedAt)
      } else if (state === "failed" || state === "degraded") {
        this.emitActivity("failed", message)
      }
    }
    if (!this.supervisorLock) return
    try {
      writeProjectStatus(this.supervisorLock, {
        pid: this.processGeneration.pid,
        processStart: this.processGeneration.processStart,
        publisherToken: this.statusPublisherToken,
        ownerToken: this.ownerToken,
        projectId: this.launchTarget.projectId,
        projectDir: this.launchTarget.projectDir,
        port: this.port,
        cwd: this.cwd,
        state,
        message,
        updatedAt: new Date().toISOString(),
        ...(this.activeChildEnvironment.FRIZZ_STABLE_ARTIFACT ? { artifactDigest: this.activeChildEnvironment.FRIZZ_STABLE_ARTIFACT } : {}),
        ...(boot ? { childPid: boot.pid, bootId: boot.bootId } : {}),
      })
    } catch (err) {
      this.errorLine(`[frizz] could not write dev status: ${err instanceof Error ? err.message : err}`)
    }
  }

  private removeStatus(): void {
    if (!this.supervisorLock) return
    removeProjectStatus(this.supervisorLock, {
      pid: this.processGeneration.pid,
      processStart: this.processGeneration.processStart,
      publisherToken: this.statusPublisherToken,
      ownerToken: this.ownerToken,
    })
  }

  private armCrashStability(child: ChildProcess): void {
    this.clearCrashStability()
    this.crashStableTimer = setTimeout(() => {
      this.crashStableTimer = null
      if (this.child === child) this.crashAttempts = 0
    }, DEV_CRASH_STABLE_MS)
    this.crashStableTimer.unref()
  }

  private clearCrashStability(): void {
    if (this.crashStableTimer) clearTimeout(this.crashStableTimer)
    this.crashStableTimer = null
  }

  private async reexecLauncher(): Promise<void> {
    if (!this.reexec) {
      const message = "launcher source changed, but this Node runtime cannot re-exec; restart Frizz once"
      this.errorLine(`[frizz] ${message}`)
      this.writeStatus("degraded", message)
      return
    }
    this.logLine(`[frizz] dev launcher validated; reloading in place (pid ${process.pid})`)
    this.closed = true
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    await Promise.allSettled(this.subscriptions.map((sub) => sub.unsubscribe()))
    this.subscriptions = []
    await this.stopChild()
    // Keep the same-PID launch owner across execve. This replaceable status is only observability;
    // the tokenized owner remains authoritative while the new executable validates and republishes.
    this.writeStatus("restarting", "launcher validated; reloading parent in place", null)
    try {
      this.reexec({ executable: process.execPath, argv: process.argv, env: devReexecEnv(this.parentEnv) })
    } catch (error) {
      this.errorLine(`[frizz] dev launcher re-exec failed: ${error instanceof Error ? error.message : error}`)
    }
    // execve never returns. A failed/injected return must release ownership through the caller's one
    // shutdown path; otherwise this live but watcherless PID would strand the project indefinitely.
    this.removeStatus()
    this.errorLine("[frizz] dev launcher re-exec returned unexpectedly; restart Frizz once")
    this.resolveStopRequested()
  }

  /**
   * Drain the control-plane child: ASK first, signal only a child that did not answer.
   *
   * The ask is `child.disconnect()` — closing the IPC channel — because dev-child already treats a
   * lost supervisor as an order to shut down (`process.once("disconnect")`), so it needs no second
   * protocol and it works on every platform. The ask used to be `kill("SIGTERM")`, which on POSIX
   * runs the same shutdown handler but on Windows is a TerminateProcess: Node maps EVERY signal it
   * can send to a hard kill there, so the child's `server.close()`, its shutdown fence and its
   * delegate release never ran, and every Restart and every update on Windows cut open RPCs and
   * socket writes mid-flight (audit 2026-09-11, finding 3). Only a child that has not exited within
   * CHILD_STOP_TIMEOUT_MS is signalled — SIGTERM then, CHILD_KILL_GRACE_MS later, SIGKILL on POSIX,
   * where a wedged event loop ignores the first; a single kill() on win32, where the first is final.
   * A child with no channel to ask over (already gone, or never had one) gets the signal at once,
   * which is exactly what it got before.
   */
  private async stopChild(): Promise<void> {
    this.clearCrashStability()
    const child = this.child
    if (!child) return
    this.stopping = child
    await new Promise<void>((resolveStop) => {
      let done = false
      const timers: ReturnType<typeof setTimeout>[] = []
      const finish = () => {
        if (done) return
        done = true
        for (const timer of timers) clearTimeout(timer)
        resolveStop()
      }
      const later = (callback: () => void, delayMs: number) => {
        const timer = setTimeout(callback, delayMs)
        timer.unref()
        timers.push(timer)
      }
      const who = `dev child ${child.pid ?? "?"}`
      // kill() is false once the process has already exited; the 'exit' listener below then never
      // fires (it already did), so a false return is the signal to finish here.
      const signal = (name: NodeJS.Signals | undefined, why: string) => {
        this.errorLine(`[frizz] ${who} ${why}; ${name === "SIGTERM" ? "sending SIGTERM to" : "killing"} the control plane only`)
        if (!child.kill(name)) finish()
      }
      const escalate = (why: string) => {
        if (process.platform === "win32") {
          signal(undefined, why)
          return
        }
        signal("SIGTERM", why)
        later(() => signal("SIGKILL", `ignored SIGTERM for ${CHILD_KILL_GRACE_MS}ms`), CHILD_KILL_GRACE_MS)
      }
      child.once("exit", finish)
      if (!child.connected) {
        escalate("has no IPC channel to ask over")
        return
      }
      later(() => escalate(`did not close in ${CHILD_STOP_TIMEOUT_MS}ms`), CHILD_STOP_TIMEOUT_MS)
      child.disconnect()
    })
    if (this.child === child) this.child = null
    if (this.childPort !== undefined) this.childPort = undefined
    if (this.stopping === child) this.stopping = null
    this.boot = null
    this.activeChildEnvironment = {}
  }

  /**
   * Second-Ctrl-C escalation. `stopChild` waits up to CHILD_STOP_TIMEOUT_MS for a clean drain; an
   * operator who signals again has withdrawn that patience, so take the control plane down now. The
   * child owns only Frizz's own handles — the detached worker daemons (a Claude thread's session
   * broker, the Codex app-server) are keyed project resources in their own process groups and
   * deliberately survive this.
   */
  forceStop(): void {
    this.closed = true
    const child = this.child
    if (!child) return
    this.errorLine(`[frizz] force-stopping control plane (pid ${child.pid ?? "?"})`)
    try {
      child.kill("SIGKILL")
    } catch {
      // Already gone; the exit handler has done, or will do, the bookkeeping.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearCrashStability()
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    await Promise.allSettled(this.subscriptions.map((sub) => sub.unsubscribe()))
    this.subscriptions = []
    await this.stopChild()
    await this.publicProxy.close()
    this.removeStatus()
  }
}

export async function startDevSupervisor(opts: DevSupervisorOptions): Promise<DevSupervisor> {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error(`invalid dev supervisor port: ${opts.port}`)
  const supervisor = new Supervisor(opts)
  await supervisor.start()
  return supervisor
}

/** Loaded by every disposable generation so supervisor-module edits are compile/start validated. */
export async function runDevControlPlaneChild(): Promise<void> {
  await import("./dev-child.ts")
}
