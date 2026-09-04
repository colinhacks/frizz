import { createHash, randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import type { Readable, Writable } from "node:stream"
import type Database from "../sqlite.ts"
import { scopeDatabase, type ProjectScope } from "../project-scope.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"
import { z } from "zod"
import {
  INTERACTION_PROTOCOL_VERSION,
  InteractionRequest,
  ThreadSlug,
  type InteractionCapability,
  type InteractionCommandAction,
  type InteractionField,
  type InteractionFileChangeDisplay,
  type InteractionRecord,
  type InteractionRequest as InteractionRequestType,
  type ResolveInteractionInput,
  type ThreadSkillSource,
} from "@frizz/shared"
import {
  InteractionStoreError,
  type InteractionSessionScope,
  type InteractionStore,
  type ProviderDelivery,
  type QueueProviderResponseResult,
} from "../interaction-store.ts"
import { redactCredentialSyntax } from "../credential-redaction.ts"
import {
  daemonCodexAppServerHost,
  directChildHost,
  readDaemonExitBreadcrumb,
  stopCodexAppServerDaemon,
  type CodexAppServerHost,
} from "./codex-app-server-host.ts"
import { nativeListenCodexAppServerHost } from "./codex-app-server-native.ts"
import { codexThreadMcpConfig } from "./codex-mcp.ts"
import type { FrizzMcp } from "./types.ts"
import { log as frizzLog } from "../logging.ts"

// Foundation-only bridge. It is deliberately not an AgentBackend: no current/default Codex TUI
// session can accidentally cross this boundary. Context now wires it unconditionally
// (codexAppServerBridgeEnabled() returns true) — Codex runs exclusively through this bridge.
export const CODEX_APP_SERVER_PROVIDER = "codex-app-server"
// Opt-in transport switch. Off = the hand-written daemon; on = `codex app-server --listen unix://`.
// Read at construction, per process, so a restart is all it takes to move a project either way.
export const CODEX_NATIVE_LISTEN_FLAG = "FRIZZ_CODEX_NATIVE_LISTEN"

export type CodexHostKind = "native" | "daemon" | "direct"

/**
 * Which app-server transport a bridge uses.
 *
 * The DEFAULT is the native listener (`codex app-server --listen unix://`): the app-server owns its own
 * socket, so it genuinely outlives every frizz process and there is no frizz-authored daemon in the middle
 * that could die and take the app-server — and every sub-agent turn inside it — down with it. The
 * hand-rolled `--stdio` daemon can only broker survival across a frizz restart; across its OWN death
 * (idle expiry, reachability self-collection, a signal, its child crashing) it kills the app-server. It
 * stays the default ONLY on win32, whose named-pipe socket path the native transport does not implement.
 *
 * Overrides: an injected `spawn` is always the direct-child test transport; `FRIZZ_CODEX_NATIVE_LISTEN`
 * forces the choice (`1`/`true` → native where supported, `0`/`false` → the daemon).
 */
export function selectCodexHostKind(
  flagValue: string | undefined,
  platform: NodeJS.Platform,
  hasSpawn: boolean,
): CodexHostKind {
  if (hasSpawn) return "direct"
  const nativeSupported = platform !== "win32"
  if (flagValue === "0" || flagValue === "false") return "daemon"
  if (flagValue === "1" || flagValue === "true") return nativeSupported ? "native" : "daemon"
  return nativeSupported ? "native" : "daemon"
}
export const CODEX_APP_SERVER_SUPPORTED_VERSION = "0.153.2"
// Upgrade policy: the AUDITED version is an exact coordinate — changing it requires a fresh
// generated-protocol audit plus a source audit at the matching immutable Rust tag/commit, then a new
// fingerprint and contract fixtures. These coordinates are intentionally runtime-visible diagnostics,
// but contain no host paths or credentials.
//
// The ACCEPTANCE RULE is deliberately not that exact coordinate — see codexVersionVerdict below.
export const CODEX_APP_SERVER_PROTOCOL_REVISION = Object.freeze({
  packageVersion: CODEX_APP_SERVER_SUPPORTED_VERSION,
  sourceTag: "rust-v0.153.2",
  sourceCommit: "657a993cbee87acf52d14b758ce49dbd46d1b8eb",
})
/** Numeric semver compare; a version that will not parse sorts BELOW everything (fails closed). */
export function compareCodexVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1]
  }
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

export type CodexVersionVerdict =
  | { kind: "audited" }
  | { kind: "ahead"; message: string }
  | { kind: "refused"; message: string }

/**
 * Whether to talk to this app-server, given the version its handshake reported.
 *
 * This was exact string equality against the audited version. That is unsafe-CLOSED, and it is the
 * single most dangerous property in the whole Codex integration: `codex` ships a stable release about
 * every two days, frizz has no second transport for it (dispatch.ts throws), and `ensureConnected` gates
 * ALL EIGHT operation entry points — dispatch, follow-up, steer, interrupt, resume, warm-up, settings.
 * So one `npm i -g @openai/codex` turned every Codex thread into a permanent hard failure recoverable
 * only by editing a source constant and rebuilding frizz. The drift is continuous: the pin was 0.144.6
 * on 2026-07-27 with `@openai/codex@0.145.0` already published, and by 2026-07-31 the installed stable
 * was 0.146.0 — the re-audit the pin recorded until 2026-09-04, when it moved to 0.153.2: the first
 * codex whose catalogue carries `gpt-6-astra` (`minimal_client_version: "0.153.0"` — the catalogue
 * server omits the model for older clients, so an older pin could never offer it). The conformance
 * test passed against that binary's own generated schema before the pin moved.
 *
 * The rule now: a FLOOR that refuses, and a CEILING that only warns.
 *  - BELOW the audited version → refuse. An older binary may genuinely lack params frizz sends, and
 *    that is the direction where proceeding produces silent misbehaviour.
 *  - AT it → the audited path, unchanged.
 *  - ABOVE it → run, and say so loudly once. Codex's protocol is additive in practice and unknown
 *    fields are ignored, so "newer" is overwhelmingly compatible — and frizz already owns a REAL drift
 *    detector that does not depend on guessing from a version number: codex-protocol-conformance.test.ts
 *    asks the INSTALLED binary for its own JSON schema and asserts every param frizz sends still exists.
 *    That test, not a string compare, is what should fail when the protocol actually moves.
 *
 * An unparseable version sorts below everything, so it is refused.
 */
export function codexVersionVerdict(
  received: string | undefined,
  audited: string = CODEX_APP_SERVER_SUPPORTED_VERSION,
): CodexVersionVerdict {
  if (!received) {
    return { kind: "refused", message: `Codex app-server did not report a parseable frizz/<version> user agent; expected ${audited}` }
  }
  const cmp = compareCodexVersions(received, audited)
  if (cmp === 0) return { kind: "audited" }
  if (cmp < 0) {
    return {
      kind: "refused",
      message: `Codex app-server ${received} is older than the audited protocol ${audited}. Upgrade codex (\`npm i -g @openai/codex\`) — frizz sends parameters this build may not accept.`,
    }
  }
  return {
    kind: "ahead",
    message: `Codex app-server ${received} is NEWER than frizz's audited protocol ${audited} — running anyway (the protocol is additive and unknown fields are ignored). If Codex threads misbehave, re-audit and re-pin. Run \`npm test -- codex-protocol-conformance\` to check frizz's params against this binary's own schema.`,
  }
}

// Latched per process: the "running ahead of the audit" warning must not repeat on every reconnect.
let aheadVersionWarned: string | undefined

const PROTOCOL_FINGERPRINT = [
  CODEX_APP_SERVER_PROTOCOL_REVISION.sourceTag,
  CODEX_APP_SERVER_PROTOCOL_REVISION.sourceCommit,
  "experimental:user-input-answer-only:permissions-grant-or-deny:mcp-standard",
].join(":")
// The handshake identity. Shared with the daemon host, which performs `initialize` on our behalf and
// serves the cached response to every later attachment — so the version gate below still reads the
// REAL app-server userAgent, not something the daemon invented.
export const CLIENT_INFO = Object.freeze({ name: "frizz", title: "Frizz", version: "0.0.1" })
export const CLIENT_CAPABILITIES = Object.freeze({
  experimentalApi: true,
  requestAttestation: false,
  mcpServerOpenaiFormElicitation: false,
})
// ---- sandbox: the app-server spells the SAME axis two different ways ----
// `thread/start` and `thread/resume` take the plain `sandbox: SandboxMode` string frizz already uses.
// `thread/settings/update` and `turn/start` take `sandboxPolicy: SandboxPolicy`, a TAGGED OBJECT, and
// there is NO string shorthand on those methods. Worse, the params structs are not
// `deny_unknown_fields`: sending the thread-level `sandbox: "danger-full-access"` spelling to
// `thread/settings/update` returns `{"result":{}}` and does NOTHING, with no notification (verified
// live against codex-cli 0.144.6, 2026-07-23). A successful-looking response is therefore NOT proof
// the change applied — only the `thread/settings/updated` notification is.
//
// The tagged values below are not invented: they are what the app-server itself derives from each
// SandboxMode at `thread/start`, read back off the `thread/settings/updated` notification it emits for
// such a thread (codex-cli 0.144.6, 2026-07-23):
//   read-only          -> { type: "readOnly", networkAccess: false }
//   workspace-write    -> { type: "workspaceWrite", writableRoots: [], networkAccess: false,
//                           excludeTmpdirEnvVar: false, excludeSlashTmp: false }
//   danger-full-access -> { type: "dangerFullAccess" }
// `writableRoots: []` is the observed default — the thread's own cwd is writable implicitly and is NOT
// listed, so mirroring the server means sending an EMPTY array, not [cwd].
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access"
export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "externalSandbox"; networkAccess: "restricted" | "enabled" }
  | {
      type: "workspaceWrite"
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

export const CODEX_SANDBOX_MODES: readonly CodexSandboxMode[] = Object.freeze([
  "read-only", "workspace-write", "danger-full-access",
] as const)

export function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return typeof value === "string" && (CODEX_SANDBOX_MODES as readonly string[]).includes(value)
}

export function codexSandboxPolicy(mode: CodexSandboxMode): CodexSandboxPolicy {
  switch (mode) {
    case "read-only":
      return { type: "readOnly", networkAccess: false }
    case "danger-full-access":
      return { type: "dangerFullAccess" }
    default:
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
  }
}

// The inverse, used to CONFIRM a reported policy against the mode we asked for. Deliberately compares
// only the variant tag: frizz's axis is the mode, and the server is free to normalize the workspaceWrite
// detail fields (e.g. add a writable root of its own) without that meaning our request was refused.
// `externalSandbox` — a variant frizz never requests — maps to undefined so it can never read as a match.
export function codexSandboxModeOfPolicy(policy: { type?: unknown } | null | undefined): CodexSandboxMode | undefined {
  switch (policy?.type) {
    case "readOnly": return "read-only"
    case "workspaceWrite": return "workspace-write"
    case "dangerFullAccess": return "danger-full-access"
    default: return undefined
  }
}

// The approval policy frizz establishes at `thread/start` (see startDisposableSession) and re-asserts on
// every `thread/resume`. `never` is the ONLY correct value for a frizz worker: the worker runs headless
// inside a detached daemon with nobody watching, so an approval request is not a safety gate — it is a
// thread that stops working until a human happens to open the dashboard. Under `never` a sandbox-denied action fails back to the model, which
// can then adapt, say so, or ask the human in its own words; the sandbox stays the actual boundary.
//
// It has to be re-sent alongside `sandbox` on a COLD `thread/resume`, because those two params are
// coupled there: passing only one resets the OTHER to the config.toml default (which is how threads
// silently drifted back to `on-request` + `workspace-write` and then stalled on the very prompts this
// value exists to prevent). `thread/settings/update` does NOT have that coupling — sending
// `sandboxPolicy` alone leaves `approvalPolicy` untouched (verified live: a thread started
// `approvalPolicy: "untrusted"` still reported `"untrusted"` in the `thread/settings/updated` payload
// after a sandboxPolicy-only update).
const CODEX_APPROVAL_POLICY = "never"
// The sandbox a frizz-owned codex thread runs under when nothing narrower was explicitly recorded. Every
// frizz-CREATED worker is dispatched at this level (WORKER_DISPATCH_PERMISSION.codex), and a resume that
// cannot find a stated intent must land here rather than fall through to the config.toml default —
// letting config.toml decide is what downgraded live threads mid-flight.
const CODEX_DEFAULT_SANDBOX: CodexSandboxMode = "danger-full-access"
// How long a confirmed sandbox change may take to come back as a notification, and how long we wait
// for a notification we do NOT expect (the requested policy already being current emits nothing).
const SANDBOX_CONFIRM_TIMEOUT_MS = 8_000
const SANDBOX_NOOP_GRACE_MS = 750

const MAX_JSONL_BYTES = 256 * 1024
const MAX_INBOUND_RECORDS = 256
const MAX_INBOUND_QUEUED_BYTES = MAX_JSONL_BYTES * 2
const MAX_OUTBOUND_REQUESTS = 128
const MAX_STDERR_BYTES = 16 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
const BRIDGE_DB_SCHEMA_VERSION = 1

// The app-server inherits frizz's environment minus frizz's own control plane — see worker-env.ts. This
// was a ~35-key allowlist until 2026-08-02; it is a denylist now because the curated lists across the
// codex and claude transports had drifted (this one carried HTTP_PROXY/SSL_CERT_FILE, the claude ones
// did not, so the same task succeeded or failed by backend) and because neither carried SSH_AUTH_SOCK
// or any toolchain variable, which made builds inside a worker diverge from the operator's own shell.
export function codexAppServerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return inheritWorkerEnvironment(source);
}

type RpcId = string | number
type JsonObject = Record<string, unknown>

const RpcIdSchema = z.union([z.string().min(1).max(256), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
const Opaque = z.string().min(1).max(256)
const SafeTimestampMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const NullableString = z.string().max(16_000).nullable()

const CommandAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("read"), command: z.string().max(16_000), name: z.string().max(2_048), path: z.string().max(8_192) }).strict(),
  z.object({ type: z.literal("listFiles"), command: z.string().max(16_000), path: z.string().max(8_192).nullable() }).strict(),
  z.object({
    type: z.literal("search"),
    command: z.string().max(16_000),
    query: z.string().max(8_192).nullable(),
    path: z.string().max(8_192).nullable(),
  }).strict(),
  z.object({ type: z.literal("unknown"), command: z.string().max(16_000) }).strict(),
])
const NetworkApprovalContext = z.object({
  host: z.string().min(1).max(8_192),
  protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"]),
}).strict()
const FileSystemSpecialPath = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(),
  z.object({ kind: z.literal("minimal") }).strict(),
  z.object({ kind: z.literal("project_roots"), subpath: z.string().max(8_192).nullable() }).strict(),
  z.object({ kind: z.literal("tmpdir") }).strict(),
  z.object({ kind: z.literal("slash_tmp") }).strict(),
  z.object({ kind: z.literal("unknown"), path: z.string().max(8_192), subpath: z.string().max(8_192).nullable() }).strict(),
])
const FileSystemPath = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), path: z.string().max(8_192) }).strict(),
  z.object({ type: z.literal("glob_pattern"), pattern: z.string().max(8_192) }).strict(),
  z.object({ type: z.literal("special"), value: FileSystemSpecialPath }).strict(),
])
const FileSystemSandboxEntry = z.object({
  path: FileSystemPath,
  access: z.enum(["read", "write", "deny"]),
}).strict()
const NetworkPermissions = z.object({ enabled: z.boolean().nullable() }).strict()
const FileSystemPermissions = z.object({
  read: z.array(z.string().max(8_192)).max(256).nullable(),
  write: z.array(z.string().max(8_192)).max(256).nullable(),
  globScanMaxDepth: z.number().int().nonnegative().max(256).optional(),
  entries: z.array(FileSystemSandboxEntry).max(256).optional(),
}).strict()
const RequestedPermissions = z.object({
  network: NetworkPermissions.nullable(),
  fileSystem: FileSystemPermissions.nullable(),
}).strict()
const NetworkPolicyAmendment = z.object({
  host: z.string().min(1).max(8_192),
  action: z.enum(["allow", "deny"]),
}).strict()

const CommandApprovalParams = z.object({
  threadId: Opaque,
  turnId: Opaque,
  itemId: Opaque,
  startedAtMs: SafeTimestampMs,
  approvalId: Opaque.nullable().optional(),
  environmentId: Opaque.nullable(),
  reason: NullableString.optional(),
  networkApprovalContext: NetworkApprovalContext.nullable().optional(),
  command: NullableString.optional(),
  cwd: z.string().max(8_192).nullable().optional(),
  commandActions: z.array(CommandAction).max(128).nullable().optional(),
  additionalPermissions: RequestedPermissions.nullable().optional(),
  proposedExecpolicyAmendment: z.array(z.string().max(8_192)).max(128).nullable().optional(),
  proposedNetworkPolicyAmendments: z.array(NetworkPolicyAmendment).max(128).nullable().optional(),
  availableDecisions: z.array(z.enum(["accept", "acceptForSession", "decline", "cancel"])).max(16).nullable().optional(),
}).strict()

const FileApprovalParams = z.object({
  threadId: Opaque,
  turnId: Opaque,
  itemId: Opaque,
  startedAtMs: SafeTimestampMs,
  reason: NullableString.optional(),
  grantRoot: z.string().max(8_192).nullable().optional(),
}).strict()

const PatchChangeKind = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add") }).strict(),
  z.object({ type: z.literal("delete") }).strict(),
  z.object({ type: z.literal("update"), move_path: z.string().max(8_192).nullable() }).strict(),
])
const FileUpdateChange = z.object({
  path: z.string().max(8_192),
  kind: PatchChangeKind,
  diff: z.string().max(MAX_JSONL_BYTES),
}).strict()
const FileChangeItem = z.object({
  type: z.literal("fileChange"),
  id: Opaque,
  changes: z.array(FileUpdateChange).max(128),
  status: z.enum(["inProgress", "completed", "failed", "declined"]),
}).strict()
// A model-run shell command, as the app-server reports it on the item stream. Deliberately NOT
// `.strict()`: this is a large, evolving item type and frizz reads three fields off it — adding
// `deny_unknown_fields` semantics here would make every codex release that grows the item silently
// stop reporting background execs.
//
// `processId` is the whole reason this schema exists. It is codex's LOGICAL PTY handle (verified live
// in backend/_live_codex_bgterm.mts: `osPid` came back null every time and the value never equalled a
// real OS pid), and it is the only thing `thread/backgroundTerminals/terminate` accepts. It appears
// ONLY on an exec that yielded — the deliberate background handoff — which is exactly the set frizz
// wants, and it is absent from the rollout frizz folds, so this stream is the only place to get it
// (`_live_codex_bgterm_match.mts`: the projected background row carried no handle at all).
const CommandExecutionItem = z.object({
  type: z.literal("commandExecution"),
  id: Opaque,
  command: z.string().max(8_192).optional(),
  processId: z.union([z.string().max(128), z.number()]).nullish(),
  status: z.string().max(64).optional(),
  exitCode: z.number().nullish(),
})
/** One live codex background exec — what the ops-strip row is built from, and what its × addresses. */
export interface LiveBackgroundExec {
  /** Codex's logical PTY handle. The ONLY id `thread/backgroundTerminals/terminate` accepts. */
  processId: string
  command?: string
  startedAtMs: number
}
const ItemStartedNotification = z.object({
  item: z.unknown(),
  threadId: Opaque,
  turnId: Opaque,
  startedAtMs: SafeTimestampMs,
}).strict()
const ItemCompletedNotification = z.object({
  item: z.unknown(),
  threadId: Opaque,
  turnId: Opaque,
  completedAtMs: SafeTimestampMs,
}).strict()
const FileChangePatchUpdatedNotification = z.object({
  threadId: Opaque,
  turnId: Opaque,
  itemId: Opaque,
  changes: z.array(FileUpdateChange).max(128),
}).strict()

const PermissionsApprovalParams = z.object({
  threadId: Opaque,
  turnId: Opaque,
  itemId: Opaque,
  environmentId: Opaque.nullable(),
  startedAtMs: SafeTimestampMs,
  cwd: z.string().max(8_192),
  reason: NullableString,
  permissions: RequestedPermissions,
}).strict()

const UserInputQuestion = z.object({
  id: z.string().min(1).max(128),
  header: z.string().min(1).max(160),
  question: z.string().min(1).max(4_000),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(z.object({
    label: z.string().min(1).max(1_000),
    description: z.string().max(2_000),
  }).strict()).max(64).nullable(),
}).strict()
const UserInputParams = z.object({
  threadId: Opaque,
  turnId: Opaque,
  itemId: Opaque,
  questions: z.array(UserInputQuestion).min(1).max(32),
  autoResolutionMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1_000).nullable(),
}).strict()

const McpBase = {
  threadId: Opaque,
  turnId: Opaque.nullable(),
  serverName: z.string().min(1).max(160),
}
const McpElicitationParams = z.discriminatedUnion("mode", [
  z.object({
    ...McpBase,
    mode: z.literal("form"),
    _meta: z.unknown().nullable(),
    message: z.string().min(1).max(4_000),
    requestedSchema: z.unknown(),
  }).strict(),
  z.object({
    ...McpBase,
    mode: z.literal("openai/form"),
    _meta: z.unknown().nullable(),
    message: z.string().min(1).max(4_000),
    requestedSchema: z.unknown(),
  }).strict(),
  z.object({
    ...McpBase,
    mode: z.literal("url"),
    _meta: z.unknown().nullable(),
    message: z.string().min(1).max(4_000),
    url: z.string().min(1).max(2_048),
    elicitationId: Opaque,
  }).strict(),
])

const ResolvedNotification = z.object({ threadId: Opaque, requestId: RpcIdSchema }).strict()

export interface CodexAppServerProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

export type CodexAppServerSpawn = (
  binary: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => CodexAppServerProcess

export type CodexAppServerDiagnostic =
  | { event: "connected"; version: string; connectionEpoch: number }
  | { event: "disconnected"; connectionEpoch: number; reason: "exit" | "error" | "closed" | "protocol" }
  | { event: "version-rejected"; expected: string; received: string }
  // The app-server is NEWER than the audited protocol. Not a failure — frizz runs anyway; this is the
  // breadcrumb that says which build was actually driving if something later looks wrong.
  | { event: "version-ahead"; expected: string; received: string }
  | { event: "stderr"; bytes: number; truncated: boolean }
  | { event: "request-rejected"; method: string; code: number }
  | { event: "turn-auto-resumed"; threadSlug: string; interruptedTurnId: string }
  | { event: "daemon-reforked"; reason: string }
  | { event: "daemon-events-dropped"; dropped: number }
  // The app-server this bridge had been talking to is gone and a fresh one replaced it — every turn
  // that was running inside it (parents AND their sub-agents) died. `deathReason` is the dead daemon's
  // own exit breadcrumb when it left one (`app-server-exited-code-*`, `self-collected-*`, `signal-*`,
  // …), or "unknown" when it vanished without writing one. This is the event that finally makes a
  // mid-turn daemon death attributable instead of an opaque disconnect.
  | { event: "daemon-replaced"; previousGeneration: string; deathReason: string; deathAt: string | undefined }

class RpcProtocolError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

class JsonlRpcConnection {
  private readonly pending = new Map<number, PendingRpc>()
  private readonly decoder = new StringDecoder("utf8")
  private nextId = 1
  private buffer = ""
  private closed = false
  private stderrBytes = 0
  private stderrReported = false
  private stderrTruncationReported = false
  private readonly inboundQueue: Array<{ message: unknown; bytes: number }> = []
  private inboundQueuedBytes = 0
  private draining = false
  private readonly idleWaiters = new Set<() => void>()
  private readonly child: CodexAppServerProcess
  private readonly timeoutMs: number
  private readonly onRequest: (method: string, id: RpcId, params: unknown) => Promise<void>
  private readonly onNotification: (method: string, params: unknown) => Promise<void>
  private readonly onClosed: (reason: "exit" | "error" | "protocol") => void
  private readonly diagnostic?: (event: CodexAppServerDiagnostic) => void

  constructor(
    child: CodexAppServerProcess,
    timeoutMs: number,
    onRequest: (method: string, id: RpcId, params: unknown) => Promise<void>,
    onNotification: (method: string, params: unknown) => Promise<void>,
    onClosed: (reason: "exit" | "error" | "protocol") => void,
    diagnostic?: (event: CodexAppServerDiagnostic) => void,
  ) {
    this.child = child
    this.timeoutMs = timeoutMs
    this.onRequest = onRequest
    this.onNotification = onNotification
    this.onClosed = onClosed
    this.diagnostic = diagnostic
    child.stdout.on("data", (chunk: Buffer | string) => this.consume(chunk))
    child.stdout.on("end", () => this.fail("protocol", new Error("Codex app-server stdout ended")))
    child.stdout.on("error", () => this.fail("protocol", new Error("Codex app-server stdout failed")))
    child.stdin.on("error", () => this.fail("error", new Error("Codex app-server stdin failed")))
    child.stderr.on("data", (chunk: Buffer | string) => {
      const size = Buffer.byteLength(chunk)
      this.stderrBytes = Math.min(MAX_STDERR_BYTES + 1, this.stderrBytes + size)
      if (!this.stderrReported) {
        this.stderrReported = true
        this.diagnostic?.({ event: "stderr", bytes: Math.min(this.stderrBytes, MAX_STDERR_BYTES), truncated: false })
      }
      if (this.stderrBytes > MAX_STDERR_BYTES && !this.stderrTruncationReported) {
        this.stderrTruncationReported = true
        this.diagnostic?.({ event: "stderr", bytes: MAX_STDERR_BYTES, truncated: true })
      }
    })
    child.on("exit", () => this.fail("exit", new Error("Codex app-server exited")))
    child.on("error", () => this.fail("error", new Error("Codex app-server process failed")))
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error("Codex app-server connection is closed")
    if (this.pending.size >= MAX_OUTBOUND_REQUESTS) throw new Error("Codex app-server outbound request queue is full")
    if (!Number.isSafeInteger(this.nextId)) throw new Error("Codex app-server request id space is exhausted")
    const id = this.nextId++
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    try {
      await this.write({ id, method, params })
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(error instanceof Error ? error : new Error("Codex app-server write failed"))
      }
    }
    return result
  }

  notification(method: string, params?: unknown): Promise<void> {
    return this.write(params === undefined ? { method } : { method, params })
  }

  response(id: RpcId, result: unknown): Promise<void> {
    return this.write({ id, result })
  }

  errorResponse(id: RpcId, code: number, message: string): Promise<void> {
    return this.write({ id, error: { code, message } })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Codex app-server connection closed"))
    }
    this.pending.clear()
    this.inboundQueue.length = 0
    this.inboundQueuedBytes = 0
    this.child.kill("SIGTERM")
  }

  whenIdle(): Promise<void> {
    if (!this.draining) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  private consume(chunk: Buffer | string): void {
    if (this.closed) return
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk)
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_JSONL_BYTES * 2) {
      this.fail("protocol", new Error("Codex app-server JSONL buffer exceeded its limit"))
      return
    }
    while (true) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim().length === 0) continue
      if (Buffer.byteLength(line, "utf8") > MAX_JSONL_BYTES) {
        this.fail("protocol", new Error("Codex app-server JSONL message exceeded its limit"))
        return
      }
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.fail("protocol", new Error("Codex app-server emitted invalid JSONL"))
        return
      }
      const bytes = Buffer.byteLength(line, "utf8")
      if (
        this.inboundQueue.length >= MAX_INBOUND_RECORDS ||
        this.inboundQueuedBytes + bytes > MAX_INBOUND_QUEUED_BYTES
      ) {
        this.fail("protocol", new Error("Codex app-server inbound queue exceeded its limit"))
        return
      }
      this.inboundQueue.push({ message, bytes })
      this.inboundQueuedBytes += bytes
      if (!this.draining) {
        this.draining = true
        queueMicrotask(() => void this.drain())
      }
    }
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed) {
        const next = this.inboundQueue.shift()
        if (!next) return
        this.inboundQueuedBytes -= next.bytes
        await this.dispatch(next.message)
      }
    } catch {
      this.fail("protocol", new Error("Codex app-server inbound dispatch failed"))
    } finally {
      this.draining = false
      if (this.closed) {
        this.inboundQueue.length = 0
        this.inboundQueuedBytes = 0
      } else if (this.inboundQueue.length > 0) {
        this.draining = true
        queueMicrotask(() => void this.drain())
      }
      if (!this.draining) {
        for (const resolve of this.idleWaiters) resolve()
        this.idleWaiters.clear()
      }
    }
  }

  private async dispatch(raw: unknown): Promise<void> {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      this.fail("protocol", new Error("Codex app-server emitted a non-object message"))
      return
    }
    const message = raw as JsonObject
    if ("jsonrpc" in message) {
      this.fail("protocol", new Error("Codex app-server emitted a JSON-RPC version envelope on the unversioned wire"))
      return
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      if (typeof message.method === "string" || ("result" in message && "error" in message)) {
        this.fail("protocol", new Error("Codex app-server emitted an ambiguous response envelope"))
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if ("error" in message) {
        // Preserve the server's JSON-RPC error code + message so callers can discriminate expected,
        // recoverable failures (e.g. a stale `turn/steer` precondition) from real protocol faults.
        const raw = (message as { error?: unknown }).error
        const code = typeof (raw as { code?: unknown })?.code === "number" ? (raw as { code: number }).code : -32603
        const detail = typeof (raw as { message?: unknown })?.message === "string"
          ? (raw as { message: string }).message
          : "Codex app-server rejected a client request"
        pending.reject(new RpcProtocolError(code, detail))
      } else pending.resolve(message.result)
      return
    }
    if (typeof message.method !== "string") {
      this.fail("protocol", new Error("Codex app-server message has no method"))
      return
    }
    if ("id" in message) {
      const parsedId = RpcIdSchema.safeParse(message.id)
      if (!parsedId.success) {
        this.fail("protocol", new Error("Codex app-server request id is invalid"))
        return
      }
      try {
        await this.onRequest(message.method, parsedId.data, message.params)
      } catch (error) {
        const rpcError = error instanceof RpcProtocolError ? error : new RpcProtocolError(-32603, "Frizz could not stage the provider request")
        await this.errorResponse(parsedId.data, rpcError.code, rpcError.message).catch(() => undefined)
      }
      return
    }
    await this.onNotification(message.method, message.params).catch(() => undefined)
  }

  private write(value: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex app-server connection is closed"))
    let line: string
    try {
      line = `${JSON.stringify(value)}\n`
    } catch {
      return Promise.reject(new Error("Codex app-server message is not JSON serializable"))
    }
    if (Buffer.byteLength(line, "utf8") > MAX_JSONL_BYTES) {
      return Promise.reject(new Error("Codex app-server outbound message exceeded its limit"))
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(line, "utf8", (error?: Error | null) => error ? reject(error) : resolve())
    })
  }

  private fail(reason: "exit" | "error" | "protocol", error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.inboundQueue.length = 0
    this.inboundQueuedBytes = 0
    this.onClosed(reason)
    this.child.kill("SIGTERM")
  }
}

interface BindingRow {
  frizz_session_id: string
  project_id: string
  thread_slug: string
  codex_thread_id: string
  codex_session_id: string
  session_epoch: number
  capability_revision: number
  connection_epoch: number
  current_turn_id: string | null
  cwd: string
  ephemeral: number
  state: "active" | "detached"
  created_at: string
  updated_at: string
  /** The dead turn a restart-recovery nudge has already been issued for; never nudged twice. */
  auto_resumed_turn_id: string | null
  /** Consecutive restart-recovery nudges; reset by a turn that actually completes. */
  auto_resume_count: number
  /**
   * What the app-server is believed to have as this thread's sandbox RIGHT NOW — a cache of observed
   * server state, not of operator intent (intent lives in frizz's own `sessions.permission_mode`). It is
   * written only from authoritative reads: the mode we passed to `thread/start`, the `sandbox` the
   * `thread/resume` RESPONSE reports back, and a `thread/settings/updated` notification. NULL means
   * "unknown" (a row migrated from an older Frizz), which makes setSandbox demand a notification rather
   * than assume a no-op.
   */
  sandbox: string | null
  /**
   * The operator's last EXPLICIT sandbox intent for this thread, as issued through frizz. Distinct from
   * `sandbox` (what the server is believed to hold): this one is forward-looking and is what every cold
   * `thread/resume` carries.
   *
   * It exists because frizz's registry cannot be trusted to hold that intent for a codex row. The tailer
   * writes the ROLLOUT-OBSERVED mode back over `sessions.permission_mode` whenever a permission record
   * lands (tailer.ts, setObservedPermissionIfCurrent) — and since a mid-turn change only takes effect on
   * the NEXT turn, the very next record still describes the OLD policy and reverts the row. Observed live
   * on 2026-07-23: a mid-turn change to `plan` was confirmed by the app-server and cached here as
   * `read-only`, while `sessions.permission_mode` went straight back to `default` seconds later. Reading
   * the intent off that row would have made the next cold resume silently undo the operator's change.
   */
  intended_sandbox: string | null
}

const BindingRowSchema = z.object({
  frizz_session_id: Opaque,
  project_id: z.string().min(1),
  thread_slug: ThreadSlug,
  codex_thread_id: Opaque,
  codex_session_id: Opaque,
  session_epoch: z.number().int().min(1),
  capability_revision: z.number().int().min(1),
  connection_epoch: z.number().int().min(1),
  current_turn_id: Opaque.nullable(),
  cwd: z.string().min(1).max(8_192),
  ephemeral: z.union([z.literal(0), z.literal(1)]),
  state: z.enum(["active", "detached"]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  auto_resumed_turn_id: Opaque.nullable(),
  auto_resume_count: z.number().int().nonnegative(),
  // Bounded string rather than an enum: a value this Frizz does not recognise (a newer sandbox mode
  // written by a later build) must degrade to "unknown", never poison the row as corrupt.
  sandbox: z.string().max(64).nullable(),
  intended_sandbox: z.string().max(64).nullable(),
}).strict()
const BridgeMetaRowSchema = z.object({
  project_id: z.string().min(1),
  connection_epoch: z.number().int().nonnegative(),
  capability_revision: z.number().int().nonnegative(),
  protocol_fingerprint: z.string().max(1_024),
  daemon_generation: z.string().max(256),
}).strict()

function checkedBindingRow(raw: unknown): BindingRow {
  const parsed = BindingRowSchema.safeParse(raw)
  if (!parsed.success) throw new InteractionStoreError("corrupt-journal", "Codex app-server session binding is corrupt")
  return parsed.data
}

// `thread/resume` answers with the thread's EFFECTIVE `sandbox` as a tagged SandboxPolicy (the
// response field is named `sandbox` but is a SandboxPolicy, not a SandboxMode — the two spellings
// again). Undefined when the server did not report a policy we recognise.
function effectiveResumeSandbox(rawResponse: unknown): CodexSandboxMode | undefined {
  const parsed = ThreadResumeSandbox.safeParse(rawResponse)
  return parsed.success ? codexSandboxModeOfPolicy(parsed.data.sandbox) : undefined
}

function turnKey(row: Pick<BindingRow, "thread_slug" | "frizz_session_id" | "connection_epoch">): string {
  return `${row.thread_slug}\u0000${row.frizz_session_id}\u0000${row.connection_epoch}`
}

export interface CodexAppServerSessionBinding {
  threadSlug: string
  sessionId: string
  codexThreadId: string
  codexSessionId: string
  sessionEpoch: number
  capabilityRevision: number
  connectionEpoch: number
  currentTurnId: string | null
  cwd: string
  ephemeral: boolean
  state: "active" | "detached"
  /** Last sandbox mode OBSERVED from the app-server for this thread; undefined when unknown. */
  sandbox?: CodexSandboxMode
}

// Whether a TURN is genuinely in flight for a bridge-owned thread. The rollout cannot answer this on
// its own: it is a lagging log that simply FREEZES mid-turn when the app-server dies, leaving the
// tailer's folded turn "in-flight" forever (the live 2026-07-22 stall — four threads read `running`
// for hours). The bridge is the authority, so it publishes both halves of the answer.
export interface CodexAppServerTurnLiveness {
  /** The bridge is driving a turn for this thread on the CURRENT connection right now. */
  bridgeTurn: boolean
  /**
   * When frizz last took this thread onto a connection. Nothing the rollout wrote BEFORE this instant
   * can belong to a live turn — the connection that wrote it is gone. Rollout activity AFTER it means
   * some other writer (a `codex resume` in the operator's own terminal) is driving the thread, which
   * is a real live turn frizz is merely mirroring.
   */
  ownedSince: string
}

export interface StartCodexAppServerSessionInput {
  threadSlug: string
  sessionId: string
  cwd: string
  model?: string
  approvalPolicy?: "untrusted" | "on-request" | "never"
  sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  permissions?: string
  // The foundation defaults to disposable sessions. A later opt-in UI may explicitly request a
  // persisted bridge-owned session; existing TUI sessions are never imported into this table.
  ephemeral?: boolean
  // Session-scoped instruction surfaces. The retired interactive-CLI path expressed these by inlining
  // them into the prompt and through `-c` flags; the app-server takes them as typed fields instead:
  //   baseInstructions   — the worker contract (~18KB; the CLI path inlined it into the prompt).
  //   developerInstructions — the one-shot title protocol (the CLI path passed `-c developer_instructions`).
  //   config             — arbitrary codex config overrides (e.g. { model_reasoning_summary: "detailed" }),
  //                        the app-server equivalent of the CLI's `-c key=value` flags.
  baseInstructions?: string
  developerInstructions?: string
  config?: Record<string, unknown>
}

export interface StartCodexAppServerTurnInput {
  threadSlug: string
  sessionId: string
  text: string
  model?: string
  effort?: string
}

export interface CodexAppServerBridgeOptions {
  projectId: string
  projectDir: string
  /** The unified database (see project-scope.ts) — shared with every other store and every other
   *  project. The bridge scopes its own rows to `projectId` and NEVER closes this connection. */
  db: Database
  interactions: InteractionStore
  codexBin?: string
  /** Legacy/test seam: a direct child per connect. Ignored when `host` is given. */
  spawn?: CodexAppServerSpawn
  /** How the app-server process is obtained. Defaults to the detached per-project daemon, which is
   *  what makes an in-flight turn survive Update & Restart. */
  host?: CodexAppServerHost
  /** Where the daemon's record/socket live. Required for the default daemon host. */
  stateDir?: string
  /** Mounts the unified `frizz` MCP server into this project's app-server. Absent ⇒ frizz mounts
   *  nothing, and a worker sees only what the operator's own codex config configured. MCP servers are
   *  PROCESS-level, so this is resolved once here rather than per thread. */
  frizzMcp?: FrizzMcp
  now?: () => Date
  id?: () => string
  requestTimeoutMs?: number
  diagnostic?: (event: CodexAppServerDiagnostic) => void
  /**
   * Gate for the auto-resume nudge (B): a thread the human has archived or retired must not be woken
   * by a turn it never asked for. Defaults to allowing every rebind.
   */
  shouldAutoResume?: (threadSlug: string, sessionId: string) => boolean
  /**
   * The operator's CURRENT sandbox intent for a thread, read from frizz's own registry
   * (`sessions.permission_mode` → codexSandbox()). Consulted on every COLD `thread/resume` so a
   * sandbox the operator changed while the thread was detached actually takes effect — before this
   * existed, `setPermissionMode` wrote the row and nothing ever read it back, so "saved for the next
   * resume" was a promise the resume path never kept. Undefined ⇒ send no sandbox override at all
   * (exactly the pre-existing behaviour).
   */
  sandboxFor?: (threadSlug: string, sessionId: string) => CodexSandboxMode | undefined
}

function bindingFromRow(row: BindingRow): CodexAppServerSessionBinding {
  return {
    threadSlug: row.thread_slug,
    sessionId: row.frizz_session_id,
    codexThreadId: row.codex_thread_id,
    codexSessionId: row.codex_session_id,
    sessionEpoch: row.session_epoch,
    capabilityRevision: row.capability_revision,
    connectionEpoch: row.connection_epoch,
    currentTurnId: row.current_turn_id,
    cwd: row.cwd,
    ephemeral: row.ephemeral === 1,
    state: row.state,
    ...(isCodexSandboxMode(row.sandbox) ? { sandbox: row.sandbox } : {}),
  }
}

function cleanText(raw: string | null | undefined, maxChars: number, fallback: string): string {
  if (!raw) return fallback
  const cleaned = redactDisplaySecrets(
    raw.replace(/[\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " "),
  )
    .slice(0, maxChars)
    .trim()
  return cleaned || fallback
}

const DISPLAY_REDACTION = "[REDACTED]"
const UNSAFE_DISPLAY_TEXT = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu
const SECRET_NAME = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|credential|private[_-]?key)/iu

interface DisplayTextLimits {
  maxChars: number
  maxBytes: number
  maxLines: number
  fallback: string
}

function visibleControls(raw: string): string {
  return raw
    .replace(/\r\n?/gu, "\n")
    .replace(UNSAFE_DISPLAY_TEXT, (value) => `[U+${value.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`)
}

function redactedSecretValue(raw: string): string {
  const quote = raw.length >= 2 && (raw[0] === "\"" || raw[0] === "'") && raw.at(-1) === raw[0]
    ? raw[0]
    : ""
  const content = quote ? raw.slice(1, -1) : raw
  // A credential-shaped value may itself contain executable shell substitution. Keep that authority
  // visible while replacing the opaque credential material.
  const executable = content.match(/\$\([^\r\n)]{0,4096}\)|`[^`\r\n]{0,4096}`|[<>]\([^\r\n)]{0,4096}\)/gu) ?? []
  const replacement = executable.length === 0
    ? DISPLAY_REDACTION
    : `${DISPLAY_REDACTION} [embedded executable shell syntax: ${executable.join(" ")}]`
  return replacement
}

function redactDisplaySecrets(raw: string): string {
  let value = redactCredentialSyntax(raw, { replacement: redactedSecretValue })
  value = value.replace(
    /-----BEGIN [^-\r\n]{0,80}PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]{0,80}PRIVATE KEY-----/giu,
    DISPLAY_REDACTION,
  )
  value = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/giu, `$1${DISPLAY_REDACTION}@`)
  value = value.replace(
    /\b(authorization|proxy-authorization)(\s*[:=]\s*)(bearer|basic)(\s+)([^\s'";|]+)/giu,
    (_whole, name: string, separator: string, scheme: string, whitespace: string, secret: string) =>
      `${name}${separator}${scheme}${whitespace}${redactedSecretValue(secret)}`,
  )
  value = value.replace(/\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/giu, `$1$2${DISPLAY_REDACTION}`)
  value = value.replace(
    /(^|[\s;&|([{])((?:--?|\/)(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|passwd|credential|private[-_]?key)(?:\s*=\s*|\s+))("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/gimu,
    (_whole, boundary: string, flag: string, secret: string) => `${boundary}${flag}${redactedSecretValue(secret)}`,
  )
  value = value.replace(
    /\b([A-Za-z_][A-Za-z0-9_.-]{0,127})(\s*=\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/gu,
    (whole, name: string, separator: string, secret: string) => SECRET_NAME.test(name)
      ? `${name}${separator}${redactedSecretValue(secret)}`
      : whole,
  )
  value = value.replace(
    /(^|[\s;&|([{])((?:--?|\/)(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|passwd|credential|private[-_]?key)(?:\s*=\s*|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/gimu,
    `$1$2${DISPLAY_REDACTION}`,
  )
  value = value.replace(
    /\b([A-Za-z_][A-Za-z0-9_.-]{0,127})(\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/gu,
    (whole, name: string, separator: string) => SECRET_NAME.test(name) ? `${name}${separator}${DISPLAY_REDACTION}` : whole,
  )
  value = value.replace(
    /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,127})\1(\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*')/gu,
    (whole, quote: string, name: string, separator: string) => SECRET_NAME.test(name)
      ? `${quote}${name}${quote}${separator}"${DISPLAY_REDACTION}"`
      : whole,
  )
  value = value.replace(
    /\b([A-Za-z_][A-Za-z0-9_.-]{0,127})(\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;|}\]]+)/gu,
    (whole, name: string, separator: string) => SECRET_NAME.test(name)
      ? `${name}${separator}${DISPLAY_REDACTION}`
      : whole,
  )
  value = value.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu, DISPLAY_REDACTION)
  value = value.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, DISPLAY_REDACTION)
  value = value.replace(
    /(?<![A-Za-z0-9_-])(?:AIza[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9_-]{12,}|(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,})(?![A-Za-z0-9_-])/gu,
    DISPLAY_REDACTION,
  )
  value = value.replace(
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/gu,
    DISPLAY_REDACTION,
  )
  return value
}

function completeDisplayText(
  raw: string | null | undefined,
  limits: DisplayTextLimits,
  field: string,
): string {
  if (raw === null || raw === undefined || raw.length === 0) return limits.fallback
  const value = redactDisplaySecrets(visibleControls(raw))
  if (
    value.split("\n").length > limits.maxLines ||
    value.length > limits.maxChars ||
    Buffer.byteLength(value, "utf8") > limits.maxBytes
  ) {
    // Approval text is authority-bearing. A visible truncation marker still asks the user to approve
    // unseen content, so reject the provider request instead of staging a partial consent card.
    throw new RpcProtocolError(-32602, `Codex ${field} cannot be completely represented for approval`)
  }
  return value.trim().length === 0 ? limits.fallback : value
}

function displayLabel(
  raw: string | null | undefined,
  fallback: string,
  maxChars = 1_024,
  maxBytes = 2_048,
  field = "label",
): string {
  return completeDisplayText(
    raw?.replace(/\r\n?|\n/gu, " ⏎ "),
    { maxChars, maxBytes, maxLines: 1, fallback },
    field,
  )
}

function displayDescription(raw: string | null | undefined, fallback: string): string {
  return completeDisplayText(raw, { maxChars: 4_000, maxBytes: 8_000, maxLines: 256, fallback }, "approval reason")
}

function displayPreview(raw: string | null | undefined, fallback: string): string {
  return completeDisplayText(raw, { maxChars: 16_000, maxBytes: 24_000, maxLines: 256, fallback }, "command")
}

function displayActionPreview(raw: string): string {
  return completeDisplayText(
    raw,
    { maxChars: 16_000, maxBytes: 24_000, maxLines: 256, fallback: "Command detail unavailable" },
    "parsed command action",
  )
}

function displayDiff(raw: string): string | undefined {
  if (!raw) return undefined
  return completeDisplayText(
    raw,
    { maxChars: 16_000, maxBytes: 24_000, maxLines: 256, fallback: "Diff detail unavailable" },
    "file diff",
  )
}

type RequestedPermissionsType = z.infer<typeof RequestedPermissions>
type FileSystemPathType = z.infer<typeof FileSystemPath>

function fileSystemPathLabel(path: FileSystemPathType): string {
  if (path.type === "path") return displayLabel(path.path, "Filesystem path unavailable", 2_048, 4_096)
  if (path.type === "glob_pattern") return displayLabel(`Glob pattern: ${path.pattern}`, "Glob pattern unavailable", 2_048, 4_096)
  if (path.value.kind === "root") return "Filesystem root (/)"
  if (path.value.kind === "minimal") return "Minimal filesystem set"
  if (path.value.kind === "tmpdir") return "System temporary directory"
  if (path.value.kind === "slash_tmp") return "/tmp"
  if (path.value.kind === "project_roots") {
    return path.value.subpath
      ? displayLabel(`Project roots, subpath: ${path.value.subpath}`, "Project roots", 2_048, 4_096)
      : "Project roots"
  }
  return displayLabel(
    path.value.subpath ? `${path.value.path}, subpath: ${path.value.subpath}` : path.value.path,
    "Provider-defined filesystem path",
    2_048,
    4_096,
  )
}

function permissionCapabilities(permissions: RequestedPermissionsType | null | undefined): InteractionCapability[] {
  if (!permissions) return []
  const capabilities: InteractionCapability[] = []
  if (permissions.network) capabilities.push({ kind: "network", enabled: permissions.network.enabled, hosts: [] })
  if (permissions.fileSystem) {
    const byAccess: Record<"read" | "write" | "deny", string[]> = { read: [], write: [], deny: [] }
    for (const path of permissions.fileSystem.read ?? []) byAccess.read.push(displayLabel(path, "Read path unavailable", 2_048, 4_096))
    for (const path of permissions.fileSystem.write ?? []) byAccess.write.push(displayLabel(path, "Write path unavailable", 2_048, 4_096))
    for (const entry of permissions.fileSystem.entries ?? []) byAccess[entry.access].push(fileSystemPathLabel(entry.path))
    for (const access of ["read", "write", "deny"] as const) {
      const resources = byAccess[access]
      if (resources.length > 32) {
        throw new RpcProtocolError(-32602, `Codex filesystem ${access} scope has too many resources to display completely`)
      }
      if (resources.length > 0) capabilities.push({ kind: "filesystem", access, resources })
    }
    if (permissions.fileSystem.globScanMaxDepth !== undefined) {
      capabilities.push({ kind: "glob-scan", depth: permissions.fileSystem.globScanMaxDepth })
    }
  }
  return capabilities
}

function commandActions(actions: z.infer<typeof CommandAction>[] | null | undefined): InteractionCommandAction[] | undefined {
  if (!actions?.length) return undefined
  if (actions.length > 16) {
    throw new RpcProtocolError(-32602, "Codex command approval has too many parsed actions to display completely")
  }
  return actions.map((action) => {
    if (action.type === "read") {
      return {
        kind: "read",
        commandPreview: displayActionPreview(action.command),
        resourceLabel: displayLabel(`${action.path} (${action.name})`, "Read target unavailable", 2_048, 4_096),
      }
    }
    if (action.type === "listFiles") {
      return {
        kind: "list-files",
        commandPreview: displayActionPreview(action.command),
        resourceLabel: action.path !== null
          ? displayLabel(action.path, "List target unavailable", 2_048, 4_096)
          : "Current working directory",
      }
    }
    if (action.type === "search") {
      return {
        kind: "search",
        commandPreview: displayActionPreview(action.command),
        ...(action.path !== null ? { resourceLabel: displayLabel(action.path, "Search target unavailable", 2_048, 4_096) } : {}),
        ...(action.query !== null ? { queryLabel: displayLabel(action.query, "Search query unavailable") } : {}),
      }
    }
    return { kind: "unknown", commandPreview: displayActionPreview(action.command) }
  })
}

function commandCapabilities(params: z.infer<typeof CommandApprovalParams>): InteractionCapability[] | undefined {
  const capabilities = permissionCapabilities(params.additionalPermissions)
  if (params.networkApprovalContext) {
    const host = displayLabel(
      `${params.networkApprovalContext.protocol}: ${params.networkApprovalContext.host}`,
      "Network host unavailable",
      2_048,
      4_096,
    )
    const network = capabilities.find((capability): capability is Extract<InteractionCapability, { kind: "network" }> => capability.kind === "network")
    if (network) network.hosts = [...network.hosts, host]
    else capabilities.unshift({ kind: "network", enabled: null, hosts: [host] })
  }
  if (params.proposedExecpolicyAmendment?.length) {
    if (params.proposedExecpolicyAmendment.length > 32) {
      throw new RpcProtocolError(-32602, "Codex execution policy amendment has too many prefix tokens to display completely")
    }
    capabilities.push({
      kind: "exec-policy",
      prefixes: params.proposedExecpolicyAmendment.map((part) =>
        displayLabel(part, "Command prefix token unavailable", 2_048, 4_096, "execution policy prefix")),
    })
  }
  for (const action of ["allow", "deny"] as const) {
    const matching = (params.proposedNetworkPolicyAmendments ?? []).filter((amendment) => amendment.action === action)
    if (matching.length > 24) {
      throw new RpcProtocolError(-32602, `Codex ${action} network policy has too many hosts to display completely`)
    }
    const hosts = matching.map((amendment) =>
      displayLabel(amendment.host, "Network host unavailable", 2_048, 4_096, "network policy host"))
    if (hosts.length) capabilities.push({ kind: "network-policy", access: action, hosts })
  }
  return capabilities.length ? capabilities : undefined
}

interface FileChangeDisplaySnapshot {
  changes: InteractionFileChangeDisplay[]
  totalChanges: number
}

function fileChangeDisplays(changes: z.infer<typeof FileUpdateChange>[]): FileChangeDisplaySnapshot {
  if (changes.length > 16) {
    throw new RpcProtocolError(-32602, "Codex file approval has too many changes to display completely")
  }
  return {
    totalChanges: changes.length,
    changes: changes.map((change) => {
      const diffPreview = displayDiff(change.diff)
      const base = {
        pathLabel: displayLabel(change.path, "Affected path unavailable", 2_048, 4_096),
        ...(diffPreview ? { diffPreview } : {}),
      }
      if (change.kind.type === "add") return { ...base, operation: "create" as const }
      if (change.kind.type === "delete") return { ...base, operation: "delete" as const }
      if (change.kind.move_path !== null) {
        return {
          ...base,
          operation: "move" as const,
          destinationLabel: displayLabel(change.kind.move_path, "Destination path unavailable", 2_048, 4_096),
        }
      }
      return { ...base, operation: "write" as const }
    }),
  }
}

function canonicalJson(value: unknown): string {
  const visiting = new WeakSet<object>()
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("non-finite JSON number")
      return candidate
    }
    if (typeof candidate !== "object") throw new Error("non-JSON value")
    if (visiting.has(candidate)) throw new Error("cyclic JSON value")
    visiting.add(candidate)
    try {
      if (Array.isArray(candidate)) return candidate.map((item) => item === undefined ? null : normalize(item))
      const object = candidate as JsonObject
      return Object.fromEntries(Object.keys(object).sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => [key, normalize(object[key])]))
    } finally {
      visiting.delete(candidate)
    }
  }
  return JSON.stringify(normalize(value))
}

function logicalRequestId(method: string, parts: readonly (string | null | undefined)[]): string {
  const digest = createHash("sha256").update(JSON.stringify([method, ...parts])).digest("hex")
  return `codex-${digest}`
}

function requestFingerprint(value: unknown): string {
  const normalized = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as JsonObject) }
    : value
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    // Delivery timing is not part of the requested authority and may be recomputed when app-server
    // reissues a still-pending request after reconnect.
    const record = normalized as JsonObject
    delete record.startedAtMs
    delete record.autoResolutionMs
  }
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex")
}

function decision(
  id: string,
  semantic: "approve" | "deny" | "cancel" | "accept" | "decline" | "answer",
  label: string,
) {
  return { id, semantic, label }
}

const commandDecisionMap = {
  accept: decision("accept", "approve", "Approve once"),
  acceptForSession: decision("acceptForSession", "approve", "Approve for this session"),
  decline: decision("decline", "deny", "Deny"),
  cancel: decision("cancel", "cancel", "Cancel"),
} as const

function commandDecisions(raw: unknown[] | null | undefined) {
  // The pinned 0.144.1 app-server always emits its computed, context-sensitive decision set. A
  // missing list is therefore a malformed authority request, not permission to synthesize a broader
  // legacy menu (for example, additional-permission requests intentionally omit session approval).
  if (!raw) throw new RpcProtocolError(-32602, "Codex command approval omitted its available decisions")
  const advertised = raw
  if (advertised.some((value) => typeof value !== "string" || !(value in commandDecisionMap))) {
    throw new RpcProtocolError(-32602, "Codex advertised an unsupported structured command decision")
  }
  const result = advertised.map((value) => commandDecisionMap[value as keyof typeof commandDecisionMap])
  if (result.length === 0) throw new RpcProtocolError(-32602, "Codex advertised no supported command decisions")
  return result
}

function fileDecisions() {
  return [
    decision("accept", "approve", "Approve once"),
    decision("acceptForSession", "approve", "Approve for this session"),
    decision("decline", "deny", "Deny"),
    decision("cancel", "cancel", "Cancel"),
  ]
}

function permissionDecisions() {
  return [
    decision("grant-turn", "approve", "Grant for this turn"),
    decision("grant-session", "approve", "Grant for this session"),
    decision("deny", "deny", "Deny"),
  ]
}

function elicitationDecisions() {
  return [
    decision("accept", "accept", "Accept"),
    decision("decline", "decline", "Decline"),
    decision("cancel", "cancel", "Cancel"),
  ]
}

function questionDecisions() {
  return [decision("answer", "answer", "Answer")]
}

function mcpField(id: string, raw: unknown, required: boolean): InteractionField {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcProtocolError(-32602, "MCP elicitation contains an invalid field schema")
  }
  const schema = raw as JsonObject
  const label = cleanText(typeof schema.title === "string" ? schema.title : id, 160, id)
  const description = typeof schema.description === "string" ? cleanText(schema.description, 4_000, "Field requested by MCP") : undefined
  const base = { id, label, description, required, secret: false }

  if (schema.type === "array") {
    if (schema.items === null || typeof schema.items !== "object" || Array.isArray(schema.items)) {
      throw new RpcProtocolError(-32602, "MCP multi-select field has invalid items")
    }
    const items = schema.items as JsonObject
    const values = Array.isArray(items.enum)
      ? items.enum
      : Array.isArray(items.anyOf)
        ? items.anyOf.map((candidate) => candidate && typeof candidate === "object" ? (candidate as JsonObject).const : undefined)
        : null
    if (!values || values.length === 0 || values.length > 64 || values.some((value) => typeof value !== "string")) {
      throw new RpcProtocolError(-32602, "MCP multi-select field has unsupported options")
    }
    const labels = Array.isArray(items.enumNames) ? items.enumNames : null
    const anyOf = Array.isArray(items.anyOf) ? items.anyOf : null
    const itemBound = (value: unknown): number | undefined => {
      if (value === undefined) return undefined
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 32) {
        throw new RpcProtocolError(-32602, "MCP multi-select bounds exceed the supported interaction contract")
      }
      return value
    }
    const minItems = itemBound(schema.minItems)
    const maxItems = itemBound(schema.maxItems)
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
      throw new RpcProtocolError(-32602, "MCP multi-select minimum exceeds its maximum")
    }
    return {
      ...base,
      input: "multi-select",
      options: values.map((value, index) => ({
        value: value as string,
        label: cleanText(
          typeof labels?.[index] === "string"
            ? labels[index]
            : anyOf?.[index] && typeof anyOf[index] === "object" && typeof (anyOf[index] as JsonObject).title === "string"
              ? (anyOf[index] as JsonObject).title as string
              : value as string,
          160,
          value as string,
        ),
      })),
      minItems,
      maxItems,
      default: Array.isArray(schema.default) ? schema.default.filter((value): value is string => typeof value === "string").slice(0, 32) : undefined,
    }
  }

  if (schema.type === "string" && (Array.isArray(schema.enum) || Array.isArray(schema.oneOf))) {
    const values = Array.isArray(schema.enum)
      ? schema.enum
      : (schema.oneOf as unknown[]).map((candidate) => candidate && typeof candidate === "object" ? (candidate as JsonObject).const : undefined)
    if (values.length === 0 || values.length > 64 || values.some((value) => typeof value !== "string")) {
      throw new RpcProtocolError(-32602, "MCP select field has unsupported options")
    }
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : null
    const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : null
    return {
      ...base,
      input: "select",
      options: values.map((value, index) => ({
        value: value as string,
        label: cleanText(
          typeof names?.[index] === "string"
            ? names[index]
            : oneOf?.[index] && typeof oneOf[index] === "object" && typeof (oneOf[index] as JsonObject).title === "string"
              ? (oneOf[index] as JsonObject).title as string
              : value as string,
          160,
          value as string,
        ),
      })),
      default: typeof schema.default === "string" ? schema.default : undefined,
    }
  }

  if (schema.type === "string") {
    const format = ["email", "uri", "date", "date-time"].includes(String(schema.format))
      ? schema.format as "email" | "uri" | "date" | "date-time"
      : undefined
    return {
      ...base,
      input: "text",
      minLength: typeof schema.minLength === "number" ? Math.max(0, Math.min(4_000, Math.trunc(schema.minLength))) : undefined,
      maxLength: typeof schema.maxLength === "number" ? Math.max(0, Math.min(4_000, Math.trunc(schema.maxLength))) : undefined,
      format,
      default: typeof schema.default === "string" ? schema.default.slice(0, 4_000) : undefined,
    }
  }
  if (schema.type === "number" || schema.type === "integer") {
    return {
      ...base,
      input: schema.type,
      minimum: typeof schema.minimum === "number" && Number.isFinite(schema.minimum) ? schema.minimum : undefined,
      maximum: typeof schema.maximum === "number" && Number.isFinite(schema.maximum) ? schema.maximum : undefined,
      default: typeof schema.default === "number" && Number.isFinite(schema.default) ? schema.default : undefined,
    }
  }
  if (schema.type === "boolean") {
    return { ...base, input: "boolean", default: typeof schema.default === "boolean" ? schema.default : undefined }
  }
  throw new RpcProtocolError(-32602, "MCP elicitation contains an unsupported field type")
}

function mcpFields(raw: unknown): InteractionField[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcProtocolError(-32602, "MCP elicitation schema must be an object")
  }
  const schema = raw as JsonObject
  if (schema.type !== "object" || schema.properties === null || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    throw new RpcProtocolError(-32602, "MCP elicitation schema must describe object properties")
  }
  const entries = Object.entries(schema.properties as JsonObject)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  if (entries.length > 32) throw new RpcProtocolError(-32602, "MCP elicitation has too many fields")
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [])
  return entries.map(([id, field]) => mcpField(id, field, required.has(id)))
}

function userInputFields(questions: z.infer<typeof UserInputQuestion>[]): InteractionField[] {
  return questions.map((question) => {
    const base = {
      id: question.id,
      label: cleanText(question.header, 160, "Question"),
      description: cleanText(
        question.isOther && question.options
          ? `${question.question}\nSuggested answers: ${question.options.map((option) => option.label).join(", ")}`
          : question.question,
        4_000,
        "Codex requested input",
      ),
      required: true,
      secret: question.isSecret,
    }
    if (question.options && !question.isOther) {
      return {
        ...base,
        input: "select" as const,
        options: question.options.map((option) => ({ value: option.label, label: option.label })),
      }
    }
    return { ...base, input: "multiline" as const, maxLength: 4_000 }
  })
}

const InitializeResponse = z.object({
  userAgent: z.string().min(1).max(2_048),
  codexHome: z.string().min(1).max(8_192),
  platformFamily: z.string().min(1).max(128),
  platformOs: z.string().min(1).max(128),
}).strict()
const ThreadResponse = z.object({
  thread: z.object({
    id: Opaque,
    sessionId: Opaque,
    ephemeral: z.boolean(),
  }).passthrough(),
}).passthrough()
const TurnResponse = z.object({ turn: z.object({ id: Opaque }).passthrough() }).strict()
// turn/steer returns a FLAT { turnId }, unlike turn/start's nested { turn: { id } }.
const TurnSteerResponse = z.object({ turnId: Opaque }).passthrough()
// `skills/list` — the app-server's OWN skill discovery (system/user/repo roots, enable state), so frizz
// never re-implements or drifts from it. Loose by design: only the fields the composer typeahead needs
// are read, and an unknown extra field must not fail the listing.
const SkillsListResponse = z.object({
  data: z.array(z.object({
    skills: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      enabled: z.boolean().optional(),
      // The root the app-server resolved this skill from — measured against codex-cli 0.146.0 as
      // `repo` (`<cwd>/.agents/skills/…`), `user` (`~/.agents/skills/…`) and `system`
      // (`~/.codex/skills/.system/…`). Kept as a free string, not an enum: an unmapped value must
      // leave the row unlabelled, never fail the listing (see codexSkillSource).
      scope: z.string().optional(),
    }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough()

// Codex's scope vocabulary → frizz's. `system` is the app-server's own bundled set, which is the same
// thing Claude calls `built-in`. Anything unrecognized answers undefined, so a newer codex that grows
// a fourth root renders an unlabelled row rather than a wrong one.
function codexSkillSource(scope: string | undefined): ThreadSkillSource | undefined {
  if (scope === "repo") return "project"
  if (scope === "user") return "user"
  if (scope === "system") return "builtin"
  return undefined
}
// `thread/resume` reports the thread's EFFECTIVE sandbox back as a tagged SandboxPolicy — the one
// authoritative read of live server state frizz gets, and what keeps the binding's sandbox cache honest
// whether the resume was cold (our override applied) or a live rejoin (our override was ignored).
const ThreadResumeSandbox = z.object({ sandbox: z.object({ type: z.string().max(64) }).passthrough() }).passthrough()
// GROUND TRUTH on a rejoin: `thread/resume` reports whether a turn is running RIGHT NOW.
// `{"type":"active"}` while one is in flight — with `activeFlags:["waitingOnApproval"]` when it is
// parked on an approval, which is still very much running — and `{"type":"idle"}` once it has ended.
// Verified live against 0.144.6 in all three states (scripts/research/native-listen-detached.mjs).
// This is what lets a reattaching bridge STOP GUESSING whether an in-flight turn survived: a transport
// that drops events while detached (the native unix listener does; the daemon queues instead) cannot
// infer it from the stream, but it can always just ask. Optional: a server that does not report a
// status reads as "not provably live", which keeps the pre-existing conservative behavior.
const ThreadResumeStatus = z.object({
  thread: z.object({ status: z.object({ type: z.string().max(64) }).passthrough() }).passthrough(),
}).passthrough()

function resumedThreadHasLiveTurn(rawResponse: unknown): boolean {
  const parsed = ThreadResumeStatus.safeParse(rawResponse)
  return parsed.success && parsed.data.thread.status.type === "active"
}
// The ONLY reliable confirmation that a sandbox change took effect. Emitted after
// `thread/settings/update` — but only when the settings ACTUALLY CHANGED.
const ThreadSettingsUpdated = z.object({
  threadId: Opaque,
  threadSettings: z.object({
    sandboxPolicy: z.object({ type: z.string().max(64) }).passthrough(),
    approvalPolicy: z.unknown().optional(),
  }).passthrough(),
}).passthrough()
const TurnStarted = z.object({ threadId: Opaque, turn: z.object({ id: Opaque }).passthrough() }).strict()
const TurnCompleted = z.object({ threadId: Opaque, turn: z.object({ id: Opaque }).passthrough() }).strict()
const MAX_CORRELATED_FILE_ITEMS = 128

interface ObservedThreadSettings {
  sandbox: CodexSandboxMode | undefined
  approvalPolicy: unknown
}

export interface CodexSandboxChangeResult {
  /** True only when the app-server is KNOWN to hold the requested sandbox. Never inferred from `{}`. */
  applied: boolean
  sandbox: CodexSandboxMode
  /**
   * `notification` — a `thread/settings/updated` reported the requested policy (a real change).
   * `already-current` — the thread already held it, so no notification was due and none arrived.
   * `unconfirmed`     — a change was expected and no notification arrived in time. NOT applied.
   */
  confirmedBy: "notification" | "already-current" | "unconfirmed"
  /** The approvalPolicy the server reported alongside the change; undefined on the other two paths. */
  approvalPolicy?: unknown
  /**
   * A turn was already in flight when the change was accepted. The app-server takes the update
   * mid-turn — it does NOT reject it — but the running turn keeps the policy it started with:
   * verified live that a turn which attempted a write AFTER the flip to danger-full-access was still
   * refused, and reported the failure itself. So this is next-TURN, not next-resume, and the UI must
   * say so rather than claim the change reached work already executing.
   */
  turnInFlight: boolean
}

interface CorrelatedFileItem extends FileChangeDisplaySnapshot {
  threadId: string
  turnId: string
  itemId: string
  connectionEpoch: number
  snapshotFingerprint: string
  interactionId?: string
  rpcRequestId?: RpcId
}

function correlatedFileItemKey(threadId: string, turnId: string, itemId: string): string {
  return `${threadId}\u0000${turnId}\u0000${itemId}`
}

// A cwd is absolute on POSIX when it starts with "/" and on Windows when it carries a drive letter
// (`C:\\…` or `C:/…`) — the same test `frizz-paths.ts` applies to an XDG variable. Checking only for a
// leading slash rejected EVERY Windows path, which failed 41 tests on a real Windows Server 2022 host.
function isAbsoluteBoundedPath(value: string): boolean {
  if (value.length === 0 || value.length > 8_192) return false
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)
}

/** The bridge's tables, in the order the unified-database importer copies them (frizz-db.ts). */
export const CODEX_APP_SERVER_TABLES = ["codex_app_server_meta", "codex_app_server_session", "codex_app_server_delivery"] as const

/**
 * The bridge's schema, written COMPLETE and idempotent (2026-08-27). Every table carries `project_id`
 * and one file holds every project — see project-scope.ts. The additive ALTER stack that used to
 * follow the CREATEs (daemon_generation, auto-resume, sandbox, the `fray_session_id` rename) is gone
 * from here: a database this code creates is born with every column, and a legacy per-project file
 * gets those migrations from legacy-project-db.ts immediately before its rows are imported.
 *
 * The version marker is checked BEFORE any authority table is created, so a file written by a future
 * schema is refused untouched. The required-columns assertion at the end is what catches a table that
 * already existed with the wrong shape — CREATE TABLE IF NOT EXISTS silently keeps whatever is there.
 */
export function ensureCodexAppServerSchema(db: Database): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_app_server_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version   INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO codex_app_server_schema (singleton, version)
        VALUES (1, ${BRIDGE_DB_SCHEMA_VERSION});
    `)
  } catch {
    throw new InteractionStoreError("schema-version", "Codex app-server bridge schema marker is invalid")
  }
  const schemaVersion = db.prepare<[], { version: number }>(
    "SELECT version FROM codex_app_server_schema WHERE singleton = 1",
  ).get()?.version
  if (schemaVersion !== BRIDGE_DB_SCHEMA_VERSION) {
    throw new InteractionStoreError("schema-version", `unsupported Codex app-server bridge schema ${String(schemaVersion)}`)
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_app_server_meta (
        project_id            TEXT PRIMARY KEY,
        connection_epoch      INTEGER NOT NULL CHECK (connection_epoch >= 0),
        capability_revision   INTEGER NOT NULL CHECK (capability_revision >= 0),
        protocol_fingerprint  TEXT NOT NULL,
        daemon_generation     TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS codex_app_server_session (
        frizz_session_id      TEXT PRIMARY KEY,
        project_id            TEXT NOT NULL,
        thread_slug           TEXT NOT NULL,
        codex_thread_id       TEXT NOT NULL,
        codex_session_id      TEXT NOT NULL,
        session_epoch         INTEGER NOT NULL CHECK (session_epoch >= 1),
        capability_revision   INTEGER NOT NULL CHECK (capability_revision >= 1),
        connection_epoch      INTEGER NOT NULL CHECK (connection_epoch >= 1),
        current_turn_id       TEXT,
        cwd                   TEXT NOT NULL,
        ephemeral             INTEGER NOT NULL CHECK (ephemeral IN (0, 1)),
        state                 TEXT NOT NULL CHECK (state IN ('active', 'detached')),
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        auto_resumed_turn_id  TEXT,
        auto_resume_count     INTEGER NOT NULL DEFAULT 0,
        sandbox               TEXT,
        intended_sandbox      TEXT,
        UNIQUE (project_id, thread_slug),
        UNIQUE (project_id, codex_thread_id)
      );
      CREATE INDEX IF NOT EXISTS codex_app_server_session_thread
        ON codex_app_server_session (project_id, codex_thread_id, state);

      CREATE TABLE IF NOT EXISTS codex_app_server_delivery (
        delivery_id           TEXT PRIMARY KEY,
        project_id            TEXT NOT NULL,
        thread_slug           TEXT NOT NULL,
        turn_id               TEXT NOT NULL,
        mode                  TEXT NOT NULL CHECK (mode IN ('steer', 'start')),
        created_at            TEXT NOT NULL
      );
    `)
  } catch {
    throw new InteractionStoreError("schema-version", "Codex app-server bridge schema could not be created safely")
  }
  const columns = (table: (typeof CODEX_APP_SERVER_TABLES)[number]) => new Set(
    db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((column) => column.name),
  )
  const requiredMeta = ["project_id", "connection_epoch", "capability_revision", "protocol_fingerprint", "daemon_generation"]
  const requiredSession = [
    "frizz_session_id", "project_id", "thread_slug", "codex_thread_id", "codex_session_id", "session_epoch",
    "capability_revision", "connection_epoch", "current_turn_id", "cwd", "ephemeral", "state",
    "created_at", "updated_at", "auto_resumed_turn_id", "auto_resume_count", "sandbox", "intended_sandbox",
  ]
  const requiredDelivery = ["delivery_id", "project_id", "thread_slug", "turn_id", "mode", "created_at"]
  if (requiredMeta.some((column) => !columns("codex_app_server_meta").has(column)) ||
    requiredSession.some((column) => !columns("codex_app_server_session").has(column)) ||
    requiredDelivery.some((column) => !columns("codex_app_server_delivery").has(column))) {
    throw new InteractionStoreError("schema-version", "Codex app-server bridge schema is missing required columns")
  }
}

export class CodexAppServerBridge {
  private readonly db: Database
  private readonly scope: ProjectScope
  private readonly now: () => Date
  private readonly makeId: () => string
  private readonly host: CodexAppServerHost
  private readonly codexBin: string
  private readonly timeoutMs: number
  /** Identity of the app-server PROCESS behind the current connection (see CodexAppServerAttachment). */
  private daemonGeneration = ""
  /**
   * The handshake a FRESHLY FORKED daemon already gave us and we already rejected — i.e. what the
   * codex binary on disk actually reports. Once we have heard it from a new process there is nothing
   * left to blame on a stale cache, so a reattach that reports the same thing must fail LOUDLY rather
   * than buy another refork. Without this the recovery is a machine for killing daemons: every
   * connect would reattach, reject, refork, reject, and leave a fresh daemon behind to do it again.
   */
  private reforkRejectedHandshake: string | null = null
  private connection: JsonlRpcConnection | null = null
  private openingConnection: JsonlRpcConnection | null = null
  private connecting: Promise<JsonlRpcConnection> | null = null
  private connectionEpoch = 0
  private capabilityRevision = 0
  private closed = false
  private dbReleased = false
  private readonly options: CodexAppServerBridgeOptions
  private readonly startingSessions = new Set<string>()
  private readonly startingTurns = new Set<string>()
  private readonly pendingTurnStarts = new Set<string>()
  /** Threads the last reconcile found dead mid-turn, awaiting warmUp()'s recovery sweep. */
  private readonly pendingAutoResume = new Map<string, { row: BindingRow; interruptedTurn: string }>()
  /** One-shot `thread/settings/updated` listeners, keyed by codex thread id. See setSandbox(). */
  private readonly settingsWaiters = new Map<string, Set<(observed: ObservedThreadSettings | undefined) => void>>()
  private readonly correlatedFileItems = new Map<string, CorrelatedFileItem>()
  // Codex's LIVE background execs, keyed codexThreadId → processId. Folded off the item stream because
  // nothing else can supply it: the rollout frizz reads records the exec but not its `processId`, so the
  // ops-strip row it projects has no handle to address a kill with. This map is what gives a codex
  // shell row an id, and the id it gives is exactly what `backgroundTerminals/terminate` accepts.
  //
  // A LEVEL, not an edge log: `item/started` adds, any terminal `item/*` removes, and the whole
  // per-thread entry is dropped when the session is released or the process goes away. Nothing here is
  // durable, and it must not be — a processId belongs to one app-server process, so a stale one
  // surviving a restart would offer an × that addresses a PTY that no longer exists.
  private readonly liveExecs = new Map<string, Map<string, LiveBackgroundExec>>()
  private activeOperations = 0
  private readonly operationWaiters = new Set<() => void>()
  private shutdownPromise: Promise<void> | null = null

  constructor(options: CodexAppServerBridgeOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.makeId = options.id ?? randomUUID
    this.codexBin = options.codexBin ?? "codex"
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    // Production hosts the app-server on its OWN unix listener (codex-app-server-native.ts) so it
    // outlives this runtime with no frizz-authored daemon that could kill it — see selectCodexHostKind
    // for the per-platform default and the overrides. An injected `spawn` — every unit test and the
    // live harnesses — keeps the historical direct-child behavior, where each connect is a new process.
    const hostKind = selectCodexHostKind(process.env[CODEX_NATIVE_LISTEN_FLAG], process.platform, Boolean(options.spawn))
    this.host = options.host ?? (
      hostKind === "direct" ? directChildHost(options.spawn!)
      : hostKind === "native" ? nativeListenCodexAppServerHost
      : daemonCodexAppServerHost)
    this.db = options.db
    this.scope = scopeDatabase(options.db, options.projectId)
    ensureCodexAppServerSchema(this.db)
    // One meta row per project, seeded on first use. Everything the handshake negotiates (the
    // connection epoch, the capability revision, the daemon generation) lives in this row, so it must
    // exist before the first connect reads it.
    this.scope.prepare(`
      INSERT OR IGNORE INTO codex_app_server_meta (
        project_id, connection_epoch, capability_revision, protocol_fingerprint
      ) VALUES (@project_id, 0, 0, '')
    `).run()
    // A bridge that has just been constructed holds NO connection, so no binding it inherits from the
    // previous process can still be active. close()/handleDisconnect normally assert that, but a
    // SIGKILLed frizz runs neither — leaving rows claiming `active` at the last epoch, which every
    // ownership check (and the board's liveness read) would take at face value. Reassert the invariant
    // here so the registry is honest before anything reads it. `current_turn_id` is deliberately left
    // in place: detach preserves it for diagnosis, and updateResumedBinding retires it — together with
    // the cards scoped to it — at the one edge that can do so coherently.
    this.scope.prepare(`
      UPDATE codex_app_server_session SET state = 'detached', updated_at = ?
      WHERE project_id = @project_id AND state = 'active'
    `).run(this.now().toISOString())
  }

  async startDisposableSession(input: StartCodexAppServerSessionInput): Promise<CodexAppServerSessionBinding> {
    if (!ThreadSlug.safeParse(input.threadSlug).success) throw new Error("invalid Frizz thread slug")
    if (!input.sessionId || input.sessionId.length > 256) throw new Error("invalid Frizz session id")
    if (!isAbsoluteBoundedPath(input.cwd)) throw new Error("Codex app-server cwd must be an absolute bounded path")
    if (input.permissions && input.sandbox) throw new Error("Codex app-server permissions and sandbox are mutually exclusive")
    const startKeys = [`slug:${input.threadSlug}`, `session:${input.sessionId}`]
    if (startKeys.some((key) => this.startingSessions.has(key))) {
      throw new Error("Codex app-server session start is already in progress")
    }
    const releaseOperation = this.beginOperation()
    for (const key of startKeys) this.startingSessions.add(key)
    try {
      if (this.bindingForScope(input.threadSlug, input.sessionId)) {
        throw new Error("Codex app-server session is already owned by this bridge")
      }
      if (this.scope.prepare("SELECT 1 FROM codex_app_server_session WHERE project_id = @project_id AND (thread_slug = ? OR frizz_session_id = ?)").get(input.threadSlug, input.sessionId)) {
        throw new Error("Codex app-server thread slug or session id is already bound")
      }

      const connection = await this.ensureConnected()
      const ephemeral = input.ephemeral ?? true
      const startedSandbox = input.permissions ? null : (input.sandbox ?? "read-only")
      const response = ThreadResponse.parse(await connection.request("thread/start", {
        cwd: input.cwd,
        model: input.model ?? null,
        approvalPolicy: input.approvalPolicy ?? CODEX_APPROVAL_POLICY,
        approvalsReviewer: "user",
        ...(input.permissions
          ? { permissions: input.permissions }
          : { sandbox: startedSandbox }),
        ...(input.baseInstructions ? { baseInstructions: input.baseInstructions } : {}),
        ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
        ...this.threadConfig(input.threadSlug, input.config),
        ephemeral,
      }))
      if (response.thread.ephemeral !== ephemeral) throw new Error("Codex app-server returned an incompatible persistence mode")
      const at = this.now().toISOString()
      this.scope.prepare(`
        INSERT INTO codex_app_server_session (
          project_id, frizz_session_id, thread_slug, codex_thread_id, codex_session_id,
          session_epoch, capability_revision, connection_epoch, current_turn_id,
          cwd, ephemeral, state, created_at, updated_at, sandbox, intended_sandbox
        ) VALUES (@project_id, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, 'active', ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.threadSlug,
        response.thread.id,
        response.thread.sessionId,
        this.capabilityRevision,
        this.connectionEpoch,
        input.cwd,
        ephemeral ? 1 : 0,
        at,
        at,
        startedSandbox,
        startedSandbox,
      )
      return bindingFromRow(this.bindingForScope(input.threadSlug, input.sessionId)!)
    } finally {
      for (const key of startKeys) this.startingSessions.delete(key)
      releaseOperation()
    }
  }

  async resumeOwnedSession(threadSlug: string, sessionId: string): Promise<CodexAppServerSessionBinding> {
    const releaseOperation = this.beginOperation()
    try {
      let binding = this.bindingForScope(threadSlug, sessionId)
      if (!binding) throw new Error("Codex app-server resume requires a bridge-owned session; TUI/default sessions are not migrated")
      const connection = await this.ensureConnected()
      binding = this.bindingForScope(threadSlug, sessionId)!
      if (binding.ephemeral === 1 && (binding.state !== "active" || binding.connection_epoch !== this.connectionEpoch)) {
        throw new Error("disposable Codex app-server sessions cannot be resumed after their owning process disconnects")
      }
      if (binding.state === "active" && binding.connection_epoch === this.connectionEpoch) return bindingFromRow(binding)
      if (binding.ephemeral === 1) throw new Error("disposable Codex app-server session is detached")

      const rawResponse = await connection.request("thread/resume", {
        threadId: binding.codex_thread_id,
        excludeTurns: true,
        approvalsReviewer: "user",
        ...this.resumeSandboxOverride(binding),
        // A resume by an app-server that ALREADY holds this thread keeps the MCP child it started
        // with, so this changes nothing there. It matters on a resume by a FRESH app-server — the
        // one after a daemon death or a frizz restart — which is exactly when the thread would
        // otherwise come back with no caller identity for the rest of its life.
        ...this.threadConfig(threadSlug),
      })
      const response = ThreadResponse.parse(rawResponse)
      if (response.thread.id !== binding.codex_thread_id || response.thread.ephemeral) {
        throw new Error("Codex app-server resumed a different or disposable thread")
      }
      this.updateResumedBinding(binding, response.thread.sessionId, effectiveResumeSandbox(rawResponse))
      return bindingFromRow(this.bindingForScope(threadSlug, sessionId)!)
    } finally {
      releaseOperation()
    }
  }

  // Adopt a rollout this bridge did NOT create — a legacy Codex thread from before the app-server
  // cutover, dispatched as its own `codex` process (its `agent_session_id` is the on-disk rollout id).
  // `thread/resume` reads that rollout by id (verified live: the app-server resumes an external
  // `codex exec`/TUI rollout), so such a row migrates to the app-server on its next follow-up and every
  // subsequent turn/steer/interrupt flows through here. Idempotent: an already
  // bound scope returns its binding.
  async adoptExternalRollout(input: {
    threadSlug: string
    sessionId: string
    codexThreadId: string
    cwd: string
  }): Promise<CodexAppServerSessionBinding> {
    if (!ThreadSlug.safeParse(input.threadSlug).success) throw new Error("invalid Frizz thread slug")
    if (!input.sessionId || input.sessionId.length > 256) throw new Error("invalid Frizz session id")
    if (!input.codexThreadId || input.codexThreadId.length > 256) throw new Error("invalid Codex rollout id")
    if (!isAbsoluteBoundedPath(input.cwd)) throw new Error("Codex app-server cwd must be an absolute bounded path")
    const releaseOperation = this.beginOperation()
    try {
      const existing = this.bindingForScope(input.threadSlug, input.sessionId)
      if (existing) return bindingFromRow(existing)
      if (this.scope.prepare("SELECT 1 FROM codex_app_server_session WHERE project_id = @project_id AND (thread_slug = ? OR frizz_session_id = ? OR codex_thread_id = ?)")
        .get(input.threadSlug, input.sessionId, input.codexThreadId)) {
        throw new Error("Codex app-server thread slug, session id, or rollout is already bound")
      }
      const connection = await this.ensureConnected()
      // A legacy row's sandbox is whatever its CLI was launched with; frizz's registry is the
      // operator's stated intent, so adoption is the moment the two are unified.
      const adoptionOverride = this.resumeSandboxOverride({
        thread_slug: input.threadSlug, frizz_session_id: input.sessionId, sandbox: null, intended_sandbox: null,
      })
      const rawResponse = await connection.request("thread/resume", {
        threadId: input.codexThreadId,
        excludeTurns: true,
        approvalsReviewer: "user",
        ...adoptionOverride,
        // Adoption is the first time frizz owns this rollout, so it is also the first chance to give
        // the thread a frizz MCP mount that knows its slug. Same reasoning as the resume above.
        ...this.threadConfig(input.threadSlug),
      })
      const response = ThreadResponse.parse(rawResponse)
      if (response.thread.id !== input.codexThreadId || response.thread.ephemeral) {
        throw new Error("Codex app-server resumed a different or disposable thread")
      }
      const at = this.now().toISOString()
      this.scope.prepare(`
        INSERT INTO codex_app_server_session (
          project_id, frizz_session_id, thread_slug, codex_thread_id, codex_session_id,
          session_epoch, capability_revision, connection_epoch, current_turn_id,
          cwd, ephemeral, state, created_at, updated_at, sandbox, intended_sandbox
        ) VALUES (@project_id, ?, ?, ?, ?, 1, ?, ?, NULL, ?, 0, 'active', ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.threadSlug,
        response.thread.id,
        response.thread.sessionId,
        this.capabilityRevision,
        this.connectionEpoch,
        input.cwd,
        at,
        at,
        effectiveResumeSandbox(rawResponse) ?? null,
        adoptionOverride.sandbox ?? null,
      )
      return bindingFromRow(this.bindingForScope(input.threadSlug, input.sessionId)!)
    } finally {
      releaseOperation()
    }
  }

  async startTurn(input: StartCodexAppServerTurnInput): Promise<{ turnId: string }> {
    if (!input.text || Buffer.byteLength(input.text, "utf8") > 64 * 1024) throw new Error("Codex app-server turn text is empty or too large")
    const startKey = `${input.threadSlug}\u0000${input.sessionId}`
    if (this.startingTurns.has(startKey)) throw new Error("Codex app-server turn start is already in progress")
    const releaseOperation = this.beginOperation()
    this.startingTurns.add(startKey)
    try {
      const connection = await this.ensureConnected()
      let binding = this.bindingForScope(input.threadSlug, input.sessionId)
      if (!binding) throw new Error("Codex app-server turn requires a bridge-owned session")
      if (binding.connection_epoch !== this.connectionEpoch || binding.state !== "active") {
        await this.resumeOwnedSession(input.threadSlug, input.sessionId)
        binding = this.bindingForScope(input.threadSlug, input.sessionId)!
      }
      if (binding.current_turn_id !== null) throw new Error("Codex app-server session already has an active turn")
      const pendingKey = turnKey(binding)
      this.pendingTurnStarts.add(pendingKey)
      try {
        const response = TurnResponse.parse(await connection.request("turn/start", {
          threadId: binding.codex_thread_id,
          clientUserMessageId: this.makeId(),
          input: [{ type: "text", text: input.text, text_elements: [] }],
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        }))
        const witnessed = this.bindingForScope(input.threadSlug, input.sessionId)
        if (!witnessed || witnessed.connection_epoch !== this.connectionEpoch || witnessed.state !== "active") {
          throw new Error("Codex app-server session detached during turn start")
        }
        if (witnessed.current_turn_id !== null && witnessed.current_turn_id !== response.turn.id) {
          throw new Error("Codex app-server turn/start response disagreed with the witnessed turn")
        }
        const changed = this.scope.prepare(`
          UPDATE codex_app_server_session SET current_turn_id = ?, updated_at = ?
          WHERE project_id = @project_id AND frizz_session_id = ? AND thread_slug = ? AND connection_epoch = ? AND state = 'active'
            AND (current_turn_id IS NULL OR current_turn_id = ?)
        `).run(response.turn.id, this.now().toISOString(), input.sessionId, input.threadSlug, this.connectionEpoch, response.turn.id).changes
        if (changed !== 1) throw new Error("Codex app-server turn ownership changed during start")
        return { turnId: response.turn.id }
      } finally {
        this.pendingTurnStarts.delete(pendingKey)
      }
    } finally {
      this.startingTurns.delete(startKey)
      releaseOperation()
    }
  }

  // Inject input into the ACTIVE turn without starting a new one. `expectedTurnId` is a hard
  // precondition: the server rejects the steer when it does not match the currently-running turn
  // (e.g. the turn just ended), which lets `followUp` fall back to `startTurn` atomically at the
  // protocol level rather than racing on our locally-cached `current_turn_id`.
  async steerTurn(input: StartCodexAppServerTurnInput): Promise<{ turnId: string }> {
    if (!input.text || Buffer.byteLength(input.text, "utf8") > 64 * 1024) throw new Error("Codex app-server steer text is empty or too large")
    const releaseOperation = this.beginOperation()
    try {
      const connection = await this.ensureConnected()
      const binding = this.bindingForScope(input.threadSlug, input.sessionId)
      if (!binding) throw new Error("Codex app-server steer requires a bridge-owned session")
      if (binding.connection_epoch !== this.connectionEpoch || binding.state !== "active") {
        throw new Error("Codex app-server session detached; cannot steer")
      }
      const expectedTurnId = binding.current_turn_id
      if (!expectedTurnId) throw new Error("Codex app-server steer requires an active turn")
      const response = TurnSteerResponse.parse(await connection.request("turn/steer", {
        threadId: binding.codex_thread_id,
        clientUserMessageId: this.makeId(),
        expectedTurnId,
        input: [{ type: "text", text: input.text, text_elements: [] }],
      }))
      return { turnId: response.turnId }
    } finally {
      releaseOperation()
    }
  }

  // Gracefully cancel the active turn. Returns { interrupted: false } when no turn is running (a
  // no-op, not an error). The turn ends server-side with status "interrupted"; `current_turn_id` is
  // cleared by the ensuing turn/completed notification.
  //
  // This is a TERMINATOR — for an app-server Codex thread it is the ONLY thing that stops the worker
  // (the turn runs inside the daemon, so there is no worker process of frizz's own to kill), and since
  // the app-server moved into a detached daemon the turn
  // outlives the frizz runtime, so a stop that did not happen has no backstop. It therefore resolves
  // only once the stop is PROVED, and never reports one that did not land:
  //
  //   • A definitive server rejection (RpcProtocolError) means the turn reached its own ending in the
  //     read→RPC window — the same race followUp resolves for steer. That is "nothing to stop", not a
  //     failed stop, but only once `current_turn_id` actually retires; if it does not, the rejection
  //     stands and we throw. Any AMBIGUOUS failure (timeout, closed connection) always throws: the
  //     caller must be free to leave the row alone rather than record a stop it cannot vouch for.
  //   • On acceptance we wait for the `turn/completed` that retires `current_turn_id`. Returning
  //     earlier would let a caller archive the row while the binding still carries a live turn id, and
  //     a runtime recycled in that window replays exactly that id through `autoResumeInterruptedTurns`
  //     — restarting, with the recovery nudge, a turn the operator had just killed.
  async interruptTurn(
    threadSlug: string,
    sessionId: string,
    settleMs = 20_000,
  ): Promise<{ interrupted: boolean }> {
    const releaseOperation = this.beginOperation()
    try {
      const connection = await this.ensureConnected()
      const binding = this.bindingForScope(threadSlug, sessionId)
      if (!binding) throw new Error("Codex app-server interrupt requires a bridge-owned session")
      if (binding.connection_epoch !== this.connectionEpoch || binding.state !== "active") {
        throw new Error("Codex app-server session detached; cannot interrupt")
      }
      const turnId = binding.current_turn_id
      if (!turnId) return { interrupted: false }
      const stillRunning = () => this.bindingForScope(threadSlug, sessionId)?.current_turn_id === turnId
      try {
        await connection.request("turn/interrupt", { threadId: binding.codex_thread_id, turnId })
      } catch (error) {
        if (!(error instanceof RpcProtocolError)) throw error
        await this.waitForTurnRetired(threadSlug, sessionId, turnId, settleMs)
        if (stillRunning()) throw error
        return { interrupted: false }
      }
      await this.waitForTurnRetired(threadSlug, sessionId, turnId, settleMs)
      if (stillRunning()) {
        throw new Error("Codex accepted the interrupt but the turn has not ended; nothing was stopped")
      }
      return { interrupted: true }
    } finally {
      releaseOperation()
    }
  }

  // The thread's invocable skills, asked of the app-server itself (`skills/list` scoped to the
  // session's cwd). Read-only and cheap — the server caches its scan — so unlike interruptTurn it
  // needs no binding state beyond the cwd, and a detached binding can still be listed for.
  async listSkills(
    threadSlug: string,
    sessionId: string,
  ): Promise<Array<{ name: string; description: string; source: ThreadSkillSource | undefined }>> {
    const releaseOperation = this.beginOperation()
    try {
      const connection = await this.ensureConnected()
      const binding = this.bindingForScope(threadSlug, sessionId)
      if (!binding) throw new Error("Codex app-server skill listing requires a bridge-owned session")
      const response = SkillsListResponse.parse(await connection.request("skills/list", { cwds: [binding.cwd] }))
      const skills: Array<{ name: string; description: string; source: ThreadSkillSource | undefined }> = []
      const seen = new Set<string>()
      for (const entry of response.data ?? []) {
        for (const skill of entry.skills ?? []) {
          // `enabled: false` is the server saying the skill exists but is switched off — not invocable.
          if (skill.enabled === false) continue
          if (skills.length >= 1024) return skills
          if (seen.has(skill.name)) continue
          seen.add(skill.name)
          skills.push({
            name: skill.name.slice(0, 512),
            description: (skill.description ?? "").slice(0, 1024),
            source: codexSkillSource(skill.scope),
          })
        }
      }
      return skills
    } finally {
      releaseOperation()
    }
  }

  // The single entry point the dispatcher/router uses to deliver a human follow-up. It owns the
  // steer-vs-start decision ATOMICALLY so callers never race on `current_turn_id`: a live turn is
  // steered; an idle session starts a fresh turn. A server rejection of the steer (RpcProtocolError —
  // e.g. the turn ended in the read→RPC window) definitively means "not applied", so we start instead.
  // `deliveryId` makes redelivery idempotent: a repeat returns the original outcome, never a 2nd turn.
  async followUp(
    input: StartCodexAppServerTurnInput & { deliveryId?: string },
  ): Promise<{ turnId: string; mode: "steer" | "start"; deduped: boolean }> {
    if (input.deliveryId) {
      const prior = this.scope.prepare<{ turn_id: string; mode: string }>(
        "SELECT turn_id, mode FROM codex_app_server_delivery WHERE project_id = @project_id AND delivery_id = ?",
      ).get(input.deliveryId)
      if (prior) return { turnId: prior.turn_id, mode: prior.mode === "steer" ? "steer" : "start", deduped: true }
    }
    const binding = this.bindingForScope(input.threadSlug, input.sessionId)
    if (!binding) throw new Error("Codex app-server follow-up requires a bridge-owned session")
    let result: { turnId: string; mode: "steer" | "start" }
    if (binding.current_turn_id) {
      try {
        result = { turnId: (await this.steerTurn(input)).turnId, mode: "steer" }
      } catch (error) {
        // Only a definitive server rejection is safe to convert into a fresh turn. Any ambiguous
        // failure (timeout / closed connection) might have landed the input, so never auto-start a
        // second turn on it — propagate and let the operator/UI retry deliberately.
        if (!(error instanceof RpcProtocolError)) throw error
        await this.waitForTurnCleared(input.threadSlug, input.sessionId, 8_000)
        result = { turnId: (await this.startTurn(input)).turnId, mode: "start" }
      }
    } else {
      result = { turnId: (await this.startTurn(input)).turnId, mode: "start" }
    }
    if (input.deliveryId) {
      this.scope.prepare(
        "INSERT OR IGNORE INTO codex_app_server_delivery (project_id, delivery_id, thread_slug, turn_id, mode, created_at) VALUES (@project_id, ?, ?, ?, ?, ?)",
      ).run(input.deliveryId, input.threadSlug, result.turnId, result.mode, this.now().toISOString())
    }
    return { ...result, deduped: false }
  }

  // Like waitForTurnCleared but scoped to ONE turn id: a different id already means the turn we were
  // watching is retired (something else legitimately opened the next one), so this must not keep
  // waiting for a null it will never see. Same real-wall-clock rationale as waitForTurnCleared.
  private async waitForTurnRetired(threadSlug: string, sessionId: string, turnId: string, ms: number): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const row = this.bindingForScope(threadSlug, sessionId)
      if (!row || row.current_turn_id !== turnId) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  private async waitForTurnCleared(threadSlug: string, sessionId: string, ms: number): Promise<void> {
    // Real wall-clock on purpose: turn/completed clears current_turn_id asynchronously, and tests
    // inject a FIXED `this.now()` that would never advance a timeout.
    const start = Date.now()
    while (Date.now() - start < ms) {
      const row = this.bindingForScope(threadSlug, sessionId)
      if (!row || row.current_turn_id === null) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  // Dispatch entry: create a PERSISTED (ephemeral:false, restart-resumable) session with the worker
  // instruction surfaces, then send the dispatch prompt as its first turn. Returns the binding (whose
  // codexSessionId matches the on-disk rollout filename the tailer already locates) + the first turn id.
  async spawnDispatch(input: {
    threadSlug: string
    sessionId: string
    cwd: string
    prompt: string
    model?: string
    effort?: string
    sandbox?: "read-only" | "workspace-write" | "danger-full-access"
    baseInstructions?: string
    developerInstructions?: string
    config?: Record<string, unknown>
  }): Promise<{ binding: CodexAppServerSessionBinding; turnId: string }> {
    const binding = await this.startDisposableSession({
      threadSlug: input.threadSlug,
      sessionId: input.sessionId,
      cwd: input.cwd,
      ephemeral: false,
      model: input.model,
      sandbox: input.sandbox ?? CODEX_DEFAULT_SANDBOX,
      baseInstructions: input.baseInstructions,
      developerInstructions: input.developerInstructions,
      config: input.config,
    })
    const { turnId } = await this.startTurn({
      threadSlug: input.threadSlug,
      sessionId: input.sessionId,
      text: input.prompt,
      model: input.model,
      effort: input.effort,
    })
    return { binding, turnId }
  }

  /**
   * Reattach at boot, without waiting for someone to touch a codex thread.
   *
   * This is not an optimization — it is required for correctness now that the app-server outlives us.
   * A turn still running inside the daemon keeps emitting `turn/completed` and approval requests, and
   * those queue in the daemon until a client attaches. Worse, an unconnected bridge has
   * `connectionEpoch = 0`, so `turnLiveness` reports `bridgeTurn: false` and the board's stall grace
   * expires 30 s later — a perfectly healthy surviving turn would card as "Stalled". Connecting here
   * makes the rejoin (and the auto-resume of anything that genuinely died) happen at boot instead.
   *
   * Skipped entirely when this project has never bound a codex thread, so a claude-only board never
   * pays for a codex process it will not use.
   */
  async warmUp(): Promise<void> {
    if (this.closed || this.dbReleased) return
    const bound = this.scope.prepare<{ n: number }>(
      "SELECT COUNT(*) AS n FROM codex_app_server_session WHERE project_id = @project_id AND ephemeral = 0",
    ).get()?.n ?? 0
    if (bound === 0) return
    const releaseOperation = this.beginOperation()
    try {
      await this.ensureConnected()
      await this.autoResumeInterruptedTurns()
    } catch {
      // A boot must never fail because codex is unavailable. The next real operation retries.
    } finally {
      releaseOperation()
    }
  }

  binding(threadSlug: string, sessionId: string): CodexAppServerSessionBinding | undefined {
    if (this.dbReleased) return undefined
    const row = this.bindingForScope(threadSlug, sessionId)
    return row ? bindingFromRow(row) : undefined
  }

  // The turn-liveness authority for a bridge-owned thread (see CodexAppServerTurnLiveness). Undefined
  // when this thread is not bound at all — callers must not infer anything about a thread the bridge
  // has never owned. `pendingTurnStarts` counts as a live turn: between `turn/start`'s request and its
  // response the turn is genuinely running, it just has no provider-issued id to persist yet.
  turnLiveness(threadSlug: string, sessionId: string): CodexAppServerTurnLiveness | undefined {
    if (this.dbReleased) return undefined
    const row = this.bindingForScope(threadSlug, sessionId)
    if (!row) return undefined
    const onThisConnection = row.state === "active" && row.connection_epoch === this.connectionEpoch
    return {
      bridgeTurn: onThisConnection && (row.current_turn_id !== null || this.pendingTurnStarts.has(turnKey(row))),
      ownedSince: row.updated_at,
    }
  }

  /**
   * Cancel this thread's pending interactions that were delivered on a connection we no longer hold.
   *
   * `ownsInteraction` already fails them closed for the UI (they render "Runtime unavailable"), but a
   * fail-closed card that nothing ever terminalizes is a card that never leaves the queue. A request
   * whose connection is gone can never be answered: the response would be addressed to a dead socket,
   * and the provider can only re-ask inside a new turn, whose logical request id differs by
   * construction. Same reasoning as updateResumedBinding's turn-ended sweep, for the path that keeps
   * the turn alive.
   */
  private retireOrphanedInteractions(row: BindingRow): void {
    const scope = {
      projectId: this.options.projectId,
      threadSlug: row.thread_slug,
      sessionId: row.frizz_session_id,
    }
    for (const pending of this.options.interactions.listPending(scope)) {
      const delivery = this.options.interactions.providerDelivery(scope, pending.id)
      if (!delivery || delivery.provider !== CODEX_APP_SERVER_PROVIDER) continue
      if (delivery.connectionEpoch === this.connectionEpoch) continue
      this.options.interactions.invalidateProviderRequest(scope, pending.id, "provider-cancelled")
    }
  }

  ownsInteraction(scope: InteractionSessionScope, interactionId: string): boolean {
    if (this.closed || this.dbReleased || !this.connection) return false
    const delivery = this.options.interactions.providerDelivery(scope, interactionId)
    if (
      !delivery ||
      delivery.provider !== CODEX_APP_SERVER_PROVIDER ||
      delivery.connectionEpoch !== this.connectionEpoch
    ) return false
    const binding = this.bindingForScope(scope.threadSlug, scope.sessionId)
    return binding?.state === "active" && binding.connection_epoch === this.connectionEpoch
  }

  // Called only from the registry's exact old-session lifecycle event. It is intentionally scoped by
  // both slug and Frizz session id, so replacing/deleting a TUI session cannot touch this bridge. The
  // registry transaction has already terminalized delivery rows and detached any matching binding;
  // this hook removes that binding and terminates the shared child so no native server request can
  // remain waiting in a process Frizz no longer owns.
  releaseSession(
    threadSlug: string,
    sessionId: string,
    reason: "session-replaced" | "session-deleted",
  ): boolean {
    if (this.closed || this.dbReleased) return false
    const row = this.bindingForScope(threadSlug, sessionId)
    if (!row) return false
    const ownsCurrentProcess = row.connection_epoch === this.connectionEpoch || this.openingConnection !== null
    try {
      this.forgetCorrelatedFileItems(row.codex_thread_id)
      this.options.interactions.cancelForSession(threadSlug, sessionId, reason)
      this.scope.prepare(`
        DELETE FROM codex_app_server_session
        WHERE project_id = @project_id AND thread_slug = ? AND frizz_session_id = ?
      `).run(threadSlug, sessionId)
    } finally {
      if (ownsCurrentProcess) this.disconnectOwnedProcess()
    }
    return true
  }

  async resolveInteraction(
    scope: InteractionSessionScope,
    input: ResolveInteractionInput,
  ): Promise<QueueProviderResponseResult | undefined> {
    const releaseOperation = this.beginOperation()
    try {
      const record = this.options.interactions.get(scope, input.interactionId)
      if (!record) return undefined
      const delivery = this.options.interactions.providerDelivery(scope, input.interactionId)
      if (!delivery || delivery.provider !== CODEX_APP_SERVER_PROVIDER) return undefined
      const providerResponse = this.providerResponse(record, delivery, input)
      const result = this.options.interactions.queueProviderResponse(scope, input, providerResponse)
      await this.flushDelivery(result.delivery)
      return result
    } finally {
      releaseOperation()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.forgetCorrelatedFileItems()
    let detachError: unknown
    try {
      if (!this.dbReleased) {
        // A clean Frizz shutdown may later resume a persisted native session, but no binding may stay
        // active against the process being killed. Preserve current_turn_id for witnessed replay/rebind.
        this.scope.prepare(`
          UPDATE codex_app_server_session SET state = 'detached', updated_at = ?
          WHERE project_id = @project_id AND state = 'active'
        `).run(this.now().toISOString())
      }
    } catch (error) {
      detachError = error
    }
    const drainingConnections = new Set<JsonlRpcConnection>()
    if (this.connection) {
      const epoch = this.connectionEpoch
      drainingConnections.add(this.connection)
      this.connection.close()
      this.connection = null
      this.options.diagnostic?.({ event: "disconnected", connectionEpoch: epoch, reason: "closed" })
    }
    if (this.openingConnection) drainingConnections.add(this.openingConnection)
    this.openingConnection?.close()
    this.openingConnection = null
    const connecting = this.connecting
    this.shutdownPromise = (async () => {
      await Promise.allSettled([
        ...[...drainingConnections].map((connection) => connection.whenIdle()),
        ...(connecting ? [connecting.then(() => undefined, () => undefined)] : []),
        this.whenOperationsIdle(),
      ])
      // A public operation that had already crossed its RPC await can finish a binding write after
      // the eager detach above. Reassert the closed-state invariant only after every operation and
      // inbound dispatch is idle, then close the bridge connection. This is the authoritative edge.
      let finalDetachError: unknown
      try {
        if (!this.dbReleased) {
          this.scope.prepare(`
            UPDATE codex_app_server_session SET state = 'detached', updated_at = ?
            WHERE project_id = @project_id AND state = 'active'
          `).run(this.now().toISOString())
        }
      } catch (error) {
        finalDetachError = error
      }
      this.releaseDatabase()
      if (detachError ?? finalDetachError) throw detachError ?? finalDetachError
    })()
    // Legacy callers use close() synchronously. Observe the async drain here; lifecycle shutdown calls
    // shutdown() below to receive the authoritative result.
    void this.shutdownPromise.catch(() => undefined)
    if (detachError) throw detachError
  }

  async shutdown(): Promise<void> {
    if (!this.closed) this.close()
    await this.shutdownPromise
  }

  private beginOperation(): () => void {
    if (this.closed || this.dbReleased) throw new Error("Codex app-server bridge is closed")
    this.activeOperations++
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeOperations--
      if (this.activeOperations === 0) {
        for (const resolve of this.operationWaiters) resolve()
        this.operationWaiters.clear()
      }
    }
  }

  private whenOperationsIdle(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.operationWaiters.add(resolve))
  }

  /** The connection is shared with every other store (and every other project), so the bridge only
   *  stops USING it — closing it is its owner's job. Every read after this returns nothing. */
  private releaseDatabase(): void {
    if (this.dbReleased) return
    this.dbReleased = true
  }

  private disconnectOwnedProcess(): void {
    if (this.dbReleased) return
    const epoch = this.connectionEpoch
    this.forgetCorrelatedFileItems()
    try {
      this.scope.prepare(`
        UPDATE codex_app_server_session SET state = 'detached', updated_at = ?
        WHERE project_id = @project_id AND state = 'active'
      `).run(this.now().toISOString())
    } finally {
      if (this.connection) {
        const connection = this.connection
        this.connection = null
        connection.close()
        this.options.diagnostic?.({ event: "disconnected", connectionEpoch: epoch, reason: "closed" })
      }
      if (this.openingConnection) {
        this.openingConnection.close()
        this.openingConnection = null
      }
    }
  }

  private bindingForScope(threadSlug: string, sessionId: string): BindingRow | undefined {
    const row = this.scope.prepare<BindingRow>(`
      SELECT * FROM codex_app_server_session WHERE project_id = @project_id AND thread_slug = ? AND frizz_session_id = ?
    `).get(threadSlug, sessionId)
    return row ? checkedBindingRow(row) : undefined
  }

  private bindingForCodexThread(threadId: string): BindingRow | undefined {
    const row = this.scope.prepare<BindingRow>(`
      SELECT * FROM codex_app_server_session WHERE project_id = @project_id AND codex_thread_id = ?
    `).get(threadId)
    return row ? checkedBindingRow(row) : undefined
  }

  private async ensureConnected(): Promise<JsonlRpcConnection> {
    if (this.closed) throw new Error("Codex app-server bridge is closed")
    if (this.connection) return this.connection
    if (this.connecting) return this.connecting
    this.connecting = this.connect()
    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  /**
   * Attach to an app-server and negotiate.
   *
   * `refork` is the version-skew recovery, and it is the ONLY thing in frizz that ever ends a Codex
   * daemon's life. The daemon performs `initialize` once and caches the answer for as long as it
   * lives (up to six hours idle, unbounded while a client keeps reattaching). Bump
   * CODEX_APP_SERVER_SUPPORTED_VERSION and Update & Restart — the ordinary upgrade path — and the
   * surviving daemon happily serves the STALE userAgent to every new generation, so the gate below
   * rejects every connect and every Codex operation fails, forever, with no way out. Recovery is:
   * the handshake failed against a daemon we REATTACHED to, so the cache is the suspect; kill that
   * daemon, fork a fresh one, and ask the real binary. Exactly once — see `reforkRejectedHandshake`
   * for why a genuinely unsupported codex still fails loudly instead of reforking in a loop.
   */
  private async connect(refork = false): Promise<JsonlRpcConnection> {
    const attachment = await this.host({
      projectId: this.options.projectId,
      stateDir: this.options.stateDir ?? this.options.projectDir,
      cwd: this.options.projectDir,
      codexBin: this.codexBin,
      // Preserve only the audited Codex runtime/auth surface. Values stay in the app-server's
      // environment; no value is copied into argv, SQLite, diagnostics, or logs.
      env: codexAppServerEnvironment(),
      clientInfo: CLIENT_INFO,
      capabilities: CLIENT_CAPABILITIES,
      frizzMcp: this.options.frizzMcp,
    })
    const child = attachment.process
    let connection!: JsonlRpcConnection
    connection = new JsonlRpcConnection(
      child,
      this.timeoutMs,
      (method, id, params) => this.handleServerRequest(connection, method, id, params),
      (method, params) => this.handleNotification(connection, method, params),
      (reason) => this.handleDisconnect(connection, reason),
      this.options.diagnostic,
    )
    this.openingConnection = connection
    // True only while the handshake itself is in flight. A failure AFTER it (corrupt metadata, a
    // disconnect during reconciliation) says nothing about the daemon's cached version, and killing a
    // daemon over one would destroy live turns for an unrelated reason.
    let handshaking = true
    let handshakeVersion: string | undefined
    try {
      const initialized = InitializeResponse.parse(await connection.request("initialize", {
        clientInfo: CLIENT_INFO,
        capabilities: CLIENT_CAPABILITIES,
      }))
      // Exact 0.144.1 source sets our initialized client name as the originator, yielding
      // `frizz/<package-version> ...`. Do not accept an expected-looking version buried elsewhere in
      // an incompatible user agent.
      const version = initialized.userAgent.match(/^frizz\/(\d+\.\d+\.\d+)(?:\s|\()/u)?.[1]
      handshakeVersion = version
      const verdict = codexVersionVerdict(version)
      // `!version` is already the refused case inside codexVersionVerdict; naming it here too is what
      // lets the compiler see that `version` is a string for the rest of the handshake.
      if (verdict.kind === "refused" || !version) {
        this.options.diagnostic?.({
          event: "version-rejected",
          expected: CODEX_APP_SERVER_SUPPORTED_VERSION,
          received: version ?? "unparseable",
        })
        throw new Error(verdict.kind === "refused" ? verdict.message : `Codex app-server did not report a parseable version; expected ${CODEX_APP_SERVER_SUPPORTED_VERSION}`)
      }
      if (verdict.kind === "ahead") {
        // The DIAGNOSTIC is per connection — it is the durable breadcrumb saying which build was
        // actually driving. The console warning is latched to once per distinct version per process,
        // because a warning that repeats on every reconnect is a warning nobody reads.
        this.options.diagnostic?.({
          event: "version-ahead",
          expected: CODEX_APP_SERVER_SUPPORTED_VERSION,
          received: version,
        })
        if (version !== aheadVersionWarned) {
          aheadVersionWarned = version
          frizzLog.warn("codex", verdict.message)
        }
      }
      handshaking = false
      const negotiated = this.db.transaction(() => {
        const rawMeta = this.scope.prepare<Record<string, unknown>>(
          "SELECT * FROM codex_app_server_meta WHERE project_id = @project_id",
        ).get()
        const parsedMeta = BridgeMetaRowSchema.safeParse(rawMeta)
        if (!parsedMeta.success) throw new InteractionStoreError("corrupt-journal", "Codex app-server bridge metadata is corrupt")
        const meta = parsedMeta.data
        const capabilityRevision = meta.protocol_fingerprint === PROTOCOL_FINGERPRINT
          ? Math.max(1, meta.capability_revision)
          : meta.capability_revision + 1
        const connectionEpoch = meta.connection_epoch + 1
        // Did we rejoin the SAME app-server process, or is this a new one? That single fact decides
        // whether in-flight turns are still running (rejoin) or died and need recovering (new).
        //
        // `droppedWhileDetached` demotes a rejoin to "new". The daemon caps its detached queue and
        // reports the overflow precisely so the client learns the stream has HOLES in it; a
        // `turn/completed` may simply be gone, and `sameProcess` would then keep `current_turn_id`
        // forever waiting on an event that was already discarded. Falling through to the cold path
        // (`thread/resume` + the auto-resume nudge) is the honest reading of "we lost events".
        const sameProcess = attachment.reattached
          && meta.daemon_generation === attachment.generation
          && attachment.droppedWhileDetached === 0
        this.scope.prepare(`
          UPDATE codex_app_server_meta
          SET connection_epoch = ?, capability_revision = ?, protocol_fingerprint = ?, daemon_generation = ?
          WHERE project_id = @project_id
        `).run(connectionEpoch, capabilityRevision, PROTOCOL_FINGERPRINT, attachment.generation)
        return { connectionEpoch, capabilityRevision, sameProcess, previousGeneration: meta.daemon_generation }
      })()
      this.connectionEpoch = negotiated.connectionEpoch
      this.capabilityRevision = negotiated.capabilityRevision
      this.daemonGeneration = attachment.generation
      if (this.closed) throw new Error("Codex app-server bridge closed during negotiation")
      this.connection = connection
      this.openingConnection = null
      await connection.notification("initialized")
      this.options.diagnostic?.({ event: "connected", version, connectionEpoch: this.connectionEpoch })
      if (attachment.droppedWhileDetached > 0) {
        this.options.diagnostic?.({ event: "daemon-events-dropped", dropped: attachment.droppedWhileDetached })
      }
      // A NEW app-server took the place of the one we were bound to: the previous generation — and every
      // turn inside it — is gone. Attribute it from the dead daemon's own exit breadcrumb so the death
      // is diagnosable instead of an opaque disconnect. Only when a prior generation actually existed
      // and it genuinely changed; a first-ever connect (previousGeneration === "") is not a death.
      if (!negotiated.sameProcess && negotiated.previousGeneration && negotiated.previousGeneration !== attachment.generation) {
        const breadcrumb = readDaemonExitBreadcrumb(this.options.stateDir ?? this.options.projectDir, this.options.projectId)
        const matched = breadcrumb?.generation === negotiated.previousGeneration ? breadcrumb : undefined
        this.options.diagnostic?.({
          event: "daemon-replaced",
          previousGeneration: negotiated.previousGeneration,
          deathReason: matched?.reason ?? "unknown",
          deathAt: matched?.at || undefined,
        })
      }
      await this.reconcileOwnedSessions(connection, negotiated.sameProcess)
      if (this.connection !== connection) throw new Error("Codex app-server disconnected during session reconciliation")
      return connection
    } catch (error) {
      connection.close()
      if (this.openingConnection === connection) this.openingConnection = null
      if (this.connection === connection) this.connection = null
      if (!handshaking) throw error
      // A fresh fork just told us this. It is the REAL binary talking, not a cache, so no amount of
      // reforking will change the answer — remember it, and never spend another daemon on it.
      const handshakeKey = handshakeVersion ?? "unhandshakeable"
      if (!attachment.reattached) this.reforkRejectedHandshake = handshakeKey
      const recoverable = attachment.reattached
        && !refork
        && !this.closed
        && this.reforkRejectedHandshake !== handshakeKey
      if (!recoverable) throw error
      this.options.diagnostic?.({ event: "daemon-reforked", reason: (error as Error).message })
      await stopCodexAppServerDaemon(this.options.stateDir ?? this.options.projectDir, this.options.projectId)
      return await this.connect(true)
    }
  }

  private handleDisconnect(connection: JsonlRpcConnection, reason: "exit" | "error" | "protocol"): void {
    if (this.connection !== connection) return
    const epoch = this.connectionEpoch
    this.connection = null
    this.forgetCorrelatedFileItems()
    // No notification can ever arrive on a dead connection, so release every settings waiter now
    // rather than stranding an eager sandbox change until its own timeout. Resolving with `undefined`
    // makes setSandbox report `unconfirmed` — honest: we do not know that it took.
    this.releaseSettingsWaiters()
    if (this.closed || this.dbReleased) return
    this.scope.prepare(`
      UPDATE codex_app_server_session SET state = 'detached', updated_at = ?
      WHERE project_id = @project_id AND connection_epoch = ? AND state = 'active'
    `).run(this.now().toISOString(), epoch)
    this.options.diagnostic?.({ event: "disconnected", connectionEpoch: epoch, reason })
  }

  /**
   * Take this generation's bindings onto the connection we just opened.
   *
   * The selection used to be `WHERE state = 'active'`, which found NOTHING after a restart: close()
   * and handleDisconnect both mark every binding `detached` on their way out, and the constructor
   * re-asserts that for a SIGKILLed predecessor. So the one set of threads that most needed
   * reconciling — the ones killed mid-turn — was the one set that was never looked at. Select the
   * mid-turn detached rows too; idle detached rows stay lazily rebound on next use, which keeps this
   * bounded on a board with a long history.
   *
   * `sameProcess` says we rejoined the very app-server that owned these turns (it outlived our
   * restart inside the daemon). Then the turns are STILL RUNNING and the only correct action is to
   * re-mark the binding active and keep `current_turn_id`: issuing `thread/resume` against a live
   * turn would disturb it, and clearing the id would orphan the `turn/completed` still to come.
   */
  private async reconcileOwnedSessions(connection: JsonlRpcConnection, sameProcess: boolean): Promise<void> {
    const rows = this.scope.prepare<BindingRow>(`
      SELECT * FROM codex_app_server_session
      WHERE project_id = @project_id AND (state = 'active' OR (state = 'detached' AND current_turn_id IS NOT NULL))
    `).all().map(checkedBindingRow)
    const detach = (row: BindingRow): void => {
      this.scope.prepare("UPDATE codex_app_server_session SET state = 'detached', updated_at = ? WHERE project_id = @project_id AND frizz_session_id = ?")
        .run(this.now().toISOString(), row.frizz_session_id)
    }
    for (const row of rows) {
      if (row.ephemeral === 1) { detach(row); continue }
      if (sameProcess) {
        this.scope.prepare(`
          UPDATE codex_app_server_session SET state = 'active', connection_epoch = ?, updated_at = ?
          WHERE project_id = @project_id AND frizz_session_id = ?
        `).run(this.connectionEpoch, this.now().toISOString(), row.frizz_session_id)
        // The TURN survived our restart, but its in-flight approval did not: that request was issued on
        // the client connection we just lost, and its rpc id means nothing on this new socket. Nothing
        // retires those cards on this path — the thread stays bound and never takes the resume branch
        // below — so they sat in the queue forever, rendering "Runtime unavailable" with no way to
        // answer or dismiss them (live incident 2026-07-24: `we-need-to-revisit-the-sandboxing`). Retire
        // them here, where we learn their connection is gone.
        this.retireOrphanedInteractions(row)
        continue
      }
      try {
        const rawResponse = await connection.request("thread/resume", {
          threadId: row.codex_thread_id,
          excludeTurns: true,
          approvalsReviewer: "user",
          ...this.resumeSandboxOverride(row),
        })
        const response = ThreadResponse.parse(rawResponse)
        if (response.thread.id !== row.codex_thread_id || response.thread.ephemeral) throw new Error("resume ownership mismatch")
        const interruptedTurn = row.current_turn_id
        // The resume RESPONSE settles what the stream could not: is that turn still running?
        //
        // A transport that DROPS events while nobody is attached (the native unix listener) cannot
        // tell a completed turn from a live one by waiting — the `turn/completed` may already have
        // been discarded. Guessing is wrong in both directions: assume live and a finished turn wedges
        // `current_turn_id` forever; assume dead and a still-running turn gets its cards cancelled and
        // a "your previous turn was interrupted" nudge it never earned. So ask. `thread/resume` is
        // also the call that re-subscribes THIS connection to the thread's events (subscriptions are
        // per-connection over the native listener), so the answer arrives on the one request that had
        // to be made anyway.
        //
        // Only for a turn we still believe in, and only on unchanged capabilities — a capability
        // revision bump means a different app-server binary, where nothing can still be running.
        if (
          interruptedTurn
          && row.capability_revision === this.capabilityRevision
          && resumedThreadHasLiveTurn(rawResponse)
        ) {
          this.scope.prepare(`
            UPDATE codex_app_server_session SET
              codex_session_id = ?, connection_epoch = ?, state = 'active', updated_at = ?, sandbox = ?
            WHERE project_id = @project_id AND frizz_session_id = ?
          `).run(
            response.thread.sessionId,
            this.connectionEpoch,
            this.now().toISOString(),
            effectiveResumeSandbox(rawResponse) ?? row.sandbox,
            row.frizz_session_id,
          )
          continue
        }
        this.updateResumedBinding(row, response.thread.sessionId, effectiveResumeSandbox(rawResponse))
        // Record, don't nudge. Recovery is issued by warmUp() — see autoResumeInterruptedTurns().
        if (interruptedTurn) this.pendingAutoResume.set(row.frizz_session_id, { row, interruptedTurn })
      } catch {
        detach(row)
      }
    }
  }

  // The nudge a thread gets when its app-server really died (not merely our own restart). Deliberately
  // NOT a replay of the original prompt: the dead turn may have half-applied a patch or half-run a
  // command, so re-running it could duplicate side effects. Tell the worker what happened and let it
  // re-establish its own footing.
  //
  // The sub-agent paragraph is load-bearing. A `spawn_agent` child is a turn INSIDE the same
  // app-server process, so it died with it — and frizz cannot resume it (thread/resume never revives a
  // running turn). Recovery of the children is therefore the PARENT model's job, and before this it
  // depended on the model happening to notice: the 2026-07-24 loss ("three had returned, but six did
  // not") only recovered because the model, on its own, thought to re-spawn. Naming the failure mode
  // explicitly makes that re-establishment reliable instead of lucky. `list_agents` is codex's own
  // authoritative snapshot, so it is the correct thing to point at.
  private static readonly RESTART_RECOVERY_NUDGE = [
    "[frizz] Your previous turn was interrupted: the Codex app-server process running it exited (a Frizz",
    "restart or a crash). This was not a decision by you or the human, and nothing you had already done",
    "was rolled back — but any command or edit that was in flight at that moment may not have finished.",
    "Re-check the state of your work before trusting it, then continue from where you left off.",
    "",
    "IMPORTANT — sub-agents do NOT survive this. Any agents you had dispatched with spawn_agent were",
    "running inside that same process and died with it; their in-flight work is gone and cannot be",
    "resumed. If you were orchestrating sub-agents, call list_agents to see which are actually still",
    "alive, then re-spawn every one you still need before continuing. Do not assume a child is running",
    "just because you dispatched it earlier.",
  ].join("\n")

  private static readonly MAX_AUTO_RESUMES = 3

  /**
   * (B) Re-issue a turn for every thread whose turn died with its app-server.
   *
   * Deliberately driven from warmUp() and NOT from connect(). connect() runs for two very different
   * reasons: the boot reattach (nobody asked — recovery is exactly what is wanted) and an operator
   * action like a follow-up (in which case THEIR message is the recovery, and injecting a synthetic
   * turn first would race their `startTurn` into "already has an active turn"). Splitting it this way
   * lets the boot path recover silently while a human interaction always wins.
   *
   * Guarded three ways: never twice for the same dead turn, never past MAX_AUTO_RESUMES in a row (a
   * crash-looping app-server must not become an infinite nudge machine — the counter resets on any
   * turn that actually completes), and never for a thread that already picked up a turn in the
   * meantime.
   */
  private async autoResumeInterruptedTurns(): Promise<void> {
    const pending = [...this.pendingAutoResume.values()]
    this.pendingAutoResume.clear()
    for (const { row, interruptedTurn } of pending) {
      if (this.closed || this.dbReleased) return
      if (row.auto_resumed_turn_id === interruptedTurn) continue
      if (row.auto_resume_count >= CodexAppServerBridge.MAX_AUTO_RESUMES) continue
      if (this.options.shouldAutoResume && !this.options.shouldAutoResume(row.thread_slug, row.frizz_session_id)) continue
      // Re-read: an operator follow-up may have opened a turn between the rebind and here, in which
      // case their message already IS the continuation and a nudge would be noise.
      const current = this.bindingForScope(row.thread_slug, row.frizz_session_id)
      if (!current || current.state !== "active" || current.current_turn_id !== null) continue
      this.scope.prepare(`
        UPDATE codex_app_server_session SET auto_resumed_turn_id = ?, auto_resume_count = auto_resume_count + 1, updated_at = ?
        WHERE project_id = @project_id AND frizz_session_id = ?
      `).run(interruptedTurn, this.now().toISOString(), row.frizz_session_id)
      try {
        await this.startTurn({
          threadSlug: row.thread_slug,
          sessionId: row.frizz_session_id,
          text: CodexAppServerBridge.RESTART_RECOVERY_NUDGE,
        })
        this.options.diagnostic?.({ event: "turn-auto-resumed", threadSlug: row.thread_slug, interruptedTurnId: interruptedTurn })
      } catch {
        // A thread that will not take a turn right now is left exactly as the rebind left it: detached
        // from its dead turn, visible to the human, and answerable by hand. Never fail the boot.
      }
    }
  }

  // Rebind a thread onto the CURRENT connection. `current_turn_id` is cleared here because a turn
  // cannot outlive the connection running it: the app-server process that owned it is gone, and
  // `thread/resume` (excludeTurns) never brings one back. Carrying it across wedged the thread
  // permanently — followUp steered a turn the new process had never heard of, and the fallback
  // startTurn then refused with "already has an active turn" (live incident 2026-07-22: four codex
  // threads died with their app-server and could never be answered again). detach PRESERVES the id for
  // replay/diagnosis; taking the thread onto a live connection is the edge that retires it.
  private updateResumedBinding(row: BindingRow, codexSessionId: string, effectiveSandbox?: CodexSandboxMode): void {
    if (row.capability_revision !== this.capabilityRevision) {
      this.options.interactions.cancelForSession(row.thread_slug, row.frizz_session_id, "capabilities-changed")
    } else if (row.current_turn_id !== null) {
      // Everything scoped to the dead turn dies with it. An approval still pending for it can never be
      // answered — its response would be written to a connection that no longer exists, and the provider
      // can only re-ask inside a NEW turn (whose logical request id differs by construction), so no
      // rebind can ever reach it. `turn/completed` retires these cards on a normal ending; a turn that
      // died with its connection never sends one, so retire them here on the same grounds.
      this.options.interactions.cancelForSession(row.thread_slug, row.frizz_session_id, "turn-ended")
    }
    // `sandbox` is taken from the resume RESPONSE, which reports the thread's effective policy — the
    // one read that is right whether our override applied (cold resume from disk) or was ignored (a
    // rejoin of a thread the server still had loaded). Recording anything else would let setSandbox
    // report a false no-op success later. `null` when the server did not report one → "unknown".
    this.scope.prepare(`
      UPDATE codex_app_server_session SET
        codex_session_id = ?, capability_revision = ?, connection_epoch = ?, state = 'active',
        current_turn_id = NULL, updated_at = ?, sandbox = ?
      WHERE project_id = @project_id AND frizz_session_id = ? AND thread_slug = ? AND codex_thread_id = ?
    `).run(
      codexSessionId,
      this.capabilityRevision,
      this.connectionEpoch,
      this.now().toISOString(),
      effectiveSandbox ?? null,
      row.frizz_session_id,
      row.thread_slug,
      row.codex_thread_id,
    )
  }

  /**
   * The `sandbox` + `approvalPolicy` pair to attach to a `thread/resume`. ALWAYS a concrete pair.
   *
   * This is what finally makes "saved for the next resume" TRUE. Both params go together on purpose:
   * on a cold resume the app-server couples them — passing only `sandbox` resets `approvalPolicy` to
   * the config.toml default (and vice versa) — so sending one alone would silently retune approvals.
   * On a live rejoin the app-server ignores both, which is why the caller re-reads the effective
   * policy off the response instead of assuming this took.
   *
   * Sending NOTHING is not an option, and that was the bug. A resume with no override hands the
   * decision to config.toml, whose defaults are `workspace-write` + `on-request` — so a thread
   * dispatched at full access came back sandboxed AND interactive after its app-server died. It then
   * hit an approval on its next write, and frizz's observed-permission writeback recorded the
   * downgrade as if it were the operator's own choice, making it permanent.
   *
   * The observed `sandbox` cache is deliberately NOT an intent source for the same reason: it records
   * what some process (a terminal `codex resume`, a config default) last did to the SHARED rollout,
   * never what frizz asked for.
   */
  /**
   * The `config` bag for one thread's `thread/start` / `thread/resume`: frizz's MCP server mounted
   * PER THREAD so it knows who is calling, plus whatever the caller passed.
   *
   * This is the only channel that can carry a caller identity on codex. The argv mount on the
   * app-server is process-wide and serves every thread in the project, so `FRIZZ_THREAD_SLUG` was
   * simply absent and every tool that acts on the caller's own thread failed at the moment of use —
   * see `codexThreadMcpConfig` for the list and the measurement. Returns `{}` when there is nothing
   * to send, so a caller with no config and no resolved MCP descriptor sends no `config` key at all,
   * exactly as before.
   *
   * The caller's own config wins on a key collision: this is a default, not an override.
   */
  private threadConfig(threadSlug: string, callerConfig?: Record<string, unknown>): { config?: Record<string, unknown> } {
    const config = { ...codexThreadMcpConfig(this.options.frizzMcp, threadSlug), ...callerConfig }
    return Object.keys(config).length ? { config } : {}
  }

  private resumeSandboxOverride(
    row: Pick<BindingRow, "thread_slug" | "frizz_session_id" | "sandbox" | "intended_sandbox">,
  ): { sandbox: CodexSandboxMode; approvalPolicy: string } {
    // `intended_sandbox` wins because it is the only record of an explicit narrowing (setSandbox writes
    // it before the wire call, so it survives a change that could not be delivered). `sandboxFor` is the
    // registry's stated intent for rows written before that column existed. Everything else is a frizz
    // worker, and a frizz worker runs at CODEX_DEFAULT_SANDBOX.
    const intent = (isCodexSandboxMode(row.intended_sandbox) ? row.intended_sandbox : undefined)
      ?? this.options.sandboxFor?.(row.thread_slug, row.frizz_session_id)
      ?? CODEX_DEFAULT_SANDBOX
    return { sandbox: intent, approvalPolicy: CODEX_APPROVAL_POLICY }
  }

  /**
   * Change a LIVE thread's sandbox, eagerly, without waiting for a resume.
   *
   * The wire call is `thread/settings/update` with the TAGGED `sandboxPolicy` — never the thread-level
   * `sandbox` string, which those params silently ignore. `approvalPolicy` is deliberately NOT sent:
   * verified live that a sandboxPolicy-only update leaves it exactly as it was (a thread started
   * `approvalPolicy: "untrusted"` still reported `"untrusted"` in the resulting `thread/settings/updated`
   * payload), so sending it would only risk overwriting an approval posture nobody asked to change.
   *
   * Success is NEVER inferred from the `{}` response — an ignored param produces the identical `{}`.
   * The confirmation is the `thread/settings/updated` notification, which the server emits only when
   * the settings ACTUALLY CHANGED. So a request for the policy the thread already holds legitimately
   * produces no notification; the binding's `sandbox` cache (written only from authoritative reads)
   * tells the two apart, and an unknown cache falls to the strict "wait for the notification" branch.
   */
  /**
   * The live background execs frizz is tracking for one thread — the source of its background-shell
   * rows. Empty for a thread with none, for a session this bridge does not own, and for the whole
   * lifetime of a codex older than the experimental API (nothing ever emits a `processId`).
   *
   * Cheap and synchronous by design: the board asks this on every build, so it reads the folded level
   * rather than making a `backgroundTerminals/list` round trip per thread per tick.
   */
  backgroundExecs(threadSlug: string, sessionId: string): readonly LiveBackgroundExec[] {
    if (this.closed || this.dbReleased) return []
    const binding = this.bindingForScope(threadSlug, sessionId)
    if (!binding) return []
    const byProcess = this.liveExecs.get(binding.codex_thread_id)
    return byProcess ? [...byProcess.values()] : []
  }

  /**
   * KILL ONE background exec, and tell the worker frizz did.
   *
   * `thread/backgroundTerminals/terminate` is gated on `capabilities.experimentalApi`, which frizz has
   * always sent (CLIENT_CAPABILITIES) — so no handshake change was needed to reach it. Verified live
   * against codex-cli 0.146.0 (backend/_live_codex_bgterm.mts): the call answers `{terminated:true}`,
   * the exec flips to `status:"failed" exitCode:-1`, and the real OS process — a descendant of the
   * app-server frizz spawned — is gone.
   *
   * The NOTICE is not optional politeness. The same probe measured codex's silence: after a terminate,
   * the model's own account was that the command "was running when I returned control … no exit code",
   * because completion in codex is POLLED, never pushed — the `exitCode:-1` goes to the CLIENT and
   * never enters model context. `thread/inject_items` ("Raw Responses API items to append to the
   * thread's model-visible history") is the channel that fixes it, and with the notice injected the
   * model instead said the command "is stopped and will never report a result, because the Frizz
   * operator explicitly terminated it from the dashboard".
   *
   * A notice that fails to land is REPORTED, never thrown: the process is already dead by then, and
   * turning a delivery problem into a failed stop would leave the row on the board over a message.
   */
  async terminateBackgroundExec(input: {
    threadSlug: string
    sessionId: string
    processId: string
    /** What to tell the worker. Absent ⇒ kill silently (nothing in frizz asks for that today). */
    notice?: string
  }): Promise<{ terminated: boolean; noticeFailed: string | null }> {
    const releaseOperation = this.beginOperation()
    try {
      const connection = await this.ensureConnected()
      let binding = this.bindingForScope(input.threadSlug, input.sessionId)
      if (!binding) throw new Error("Stopping a background command requires a bridge-owned Codex session")
      if (binding.state !== "active" || binding.connection_epoch !== this.connectionEpoch) {
        // Same reason setSandbox resumes first: a detached thread has to be back on this connection
        // before the server will accept anything addressed at it.
        await this.resumeOwnedSession(input.threadSlug, input.sessionId)
        binding = this.bindingForScope(input.threadSlug, input.sessionId)
        if (!binding) throw new Error("Codex app-server session disappeared while stopping a background command")
      }
      const threadId = binding.codex_thread_id
      const raw = await connection.request("thread/backgroundTerminals/terminate", { threadId, processId: input.processId })
      const terminated = (raw as { terminated?: unknown } | null)?.terminated === true
      if (!terminated) {
        // The app-server answering "no" means the PTY was already gone — nothing was killed, and the
        // caller must not report one. It still drops from the level so the phantom row clears.
        this.liveExecs.get(threadId)?.delete(input.processId)
        return { terminated: false, noticeFailed: null }
      }
      this.liveExecs.get(threadId)?.delete(input.processId)
      let noticeFailed: string | null = null
      if (input.notice) {
        try {
          await connection.request("thread/inject_items", {
            threadId,
            items: [{ type: "message", role: "user", content: [{ type: "input_text", text: input.notice }] }],
          })
        } catch (error) {
          noticeFailed = `The worker could not be told: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      return { terminated: true, noticeFailed }
    } finally {
      releaseOperation()
    }
  }

  async setSandbox(input: {
    threadSlug: string
    sessionId: string
    sandbox: CodexSandboxMode
  }): Promise<CodexSandboxChangeResult> {
    if (!isCodexSandboxMode(input.sandbox)) throw new Error("unknown Codex sandbox mode")
    const releaseOperation = this.beginOperation()
    try {
      if (!this.bindingForScope(input.threadSlug, input.sessionId)) {
        throw new Error("Codex app-server sandbox change requires a bridge-owned session")
      }
      const connection = await this.ensureConnected()
      let binding = this.bindingForScope(input.threadSlug, input.sessionId)
      if (!binding) throw new Error("Codex app-server sandbox change requires a bridge-owned session")
      if (binding.state !== "active" || binding.connection_epoch !== this.connectionEpoch) {
        // A detached thread has to be back on this connection before the server will accept settings
        // for it. The resume carries frizz's intent itself, so this frequently applies the change on
        // its own — the update below then confirms (or no-ops, which the cache reports honestly).
        await this.resumeOwnedSession(input.threadSlug, input.sessionId)
        binding = this.bindingForScope(input.threadSlug, input.sessionId)
        if (!binding) throw new Error("Codex app-server session disappeared during sandbox change")
      }
      const threadId = binding.codex_thread_id
      // Record the INTENT before the wire call, and independently of whether it lands. Even a change
      // the app-server never confirms must survive to the next cold resume — that is the whole promise
      // behind "saved for the next resume", and frizz's own registry cannot hold it for a codex row.
      this.scope.prepare("UPDATE codex_app_server_session SET intended_sandbox = ?, updated_at = ? WHERE project_id = @project_id AND frizz_session_id = ? AND thread_slug = ?")
        .run(input.sandbox, this.now().toISOString(), input.sessionId, input.threadSlug)
      // Sampled BEFORE the update: whether the operator's change was made against a running turn is
      // what decides the wording, and the turn can end while we wait for the confirmation.
      const turnInFlight = binding.current_turn_id !== null || this.pendingTurnStarts.has(turnKey(binding))
      const expectNotification = binding.sandbox !== input.sandbox
      const observedPromise = this.awaitSettingsUpdate(
        threadId,
        expectNotification ? SANDBOX_CONFIRM_TIMEOUT_MS : SANDBOX_NOOP_GRACE_MS,
      )
      try {
        await connection.request("thread/settings/update", {
          threadId,
          sandboxPolicy: codexSandboxPolicy(input.sandbox),
        })
      } catch (error) {
        observedPromise.cancel()
        throw error
      }
      const observed = await observedPromise.promise
      if (observed) {
        if (observed.sandbox !== input.sandbox) {
          throw new Error(
            `Codex app-server reported sandbox ${String(observed.sandbox ?? "unknown")} after a request for ${input.sandbox}`,
          )
        }
        return { applied: true, sandbox: input.sandbox, confirmedBy: "notification", approvalPolicy: observed.approvalPolicy, turnInFlight }
      }
      if (!expectNotification) return { applied: true, sandbox: input.sandbox, confirmedBy: "already-current", turnInFlight }
      return { applied: false, sandbox: input.sandbox, confirmedBy: "unconfirmed", turnInFlight }
    } finally {
      releaseOperation()
    }
  }

  private awaitSettingsUpdate(threadId: string, timeoutMs: number): {
    promise: Promise<ObservedThreadSettings | undefined>
    cancel: () => void
  } {
    let settle: ((observed: ObservedThreadSettings | undefined) => void) | undefined
    let listener: ((observed: ObservedThreadSettings | undefined) => void) | undefined
    let timer: NodeJS.Timeout | undefined
    const detach = (): void => {
      if (timer) clearTimeout(timer)
      const set = this.settingsWaiters.get(threadId)
      if (set && listener) {
        set.delete(listener)
        if (set.size === 0) this.settingsWaiters.delete(threadId)
      }
    }
    const promise = new Promise<ObservedThreadSettings | undefined>((resolve) => {
      settle = resolve
      listener = (observed) => { detach(); resolve(observed) }
      const set = this.settingsWaiters.get(threadId) ?? new Set()
      set.add(listener)
      this.settingsWaiters.set(threadId, set)
      // Real wall-clock: tests inject a fixed `this.now()` that would never advance a deadline.
      timer = setTimeout(() => { detach(); resolve(undefined) }, timeoutMs)
      timer.unref?.()
    })
    return { promise, cancel: () => { detach(); settle?.(undefined) } }
  }

  private releaseSettingsWaiters(): void {
    const waiters = [...this.settingsWaiters.values()].flatMap((set) => [...set])
    this.settingsWaiters.clear()
    for (const waiter of waiters) waiter(undefined)
  }

  private ownedBinding(threadId: string, turnId: string | null): BindingRow {
    const row = this.bindingForCodexThread(threadId)
    if (!row || row.state !== "active" || row.connection_epoch !== this.connectionEpoch) {
      throw new RpcProtocolError(-32602, "Codex request is not owned by this Frizz bridge connection")
    }
    if (turnId !== null) {
      if (row.current_turn_id !== null && row.current_turn_id !== turnId) {
        throw new RpcProtocolError(-32602, "Codex request belongs to a stale or different turn")
      }
      if (row.current_turn_id === null) {
        if (!this.pendingTurnStarts.has(turnKey(row))) {
          throw new RpcProtocolError(-32602, "Codex request has no witnessed locally-started turn")
        }
        // A server request may race the turn/start response. The provider-issued turn id is the
        // authority; pin it before journaling rather than inventing a client-side id.
        this.scope.prepare(`
          UPDATE codex_app_server_session SET current_turn_id = ?, updated_at = ?
          WHERE project_id = @project_id AND frizz_session_id = ? AND connection_epoch = ? AND current_turn_id IS NULL
        `).run(turnId, this.now().toISOString(), row.frizz_session_id, this.connectionEpoch)
        return this.bindingForCodexThread(threadId)!
      }
    }
    return row
  }

  private notificationOwnsTurn(threadId: string, turnId: string): boolean {
    const row = this.bindingForCodexThread(threadId)
    if (!row || row.state !== "active" || row.connection_epoch !== this.connectionEpoch) return false
    if (row.current_turn_id === turnId) return true
    return row.current_turn_id === null && this.pendingTurnStarts.has(turnKey(row))
  }

  private rememberFileItem(threadId: string, turnId: string, itemId: string, changes: z.infer<typeof FileUpdateChange>[]): void {
    if (!this.notificationOwnsTurn(threadId, turnId)) return
    const key = correlatedFileItemKey(threadId, turnId, itemId)
    this.correlatedFileItems.delete(key)
    this.correlatedFileItems.set(key, {
      threadId,
      turnId,
      itemId,
      connectionEpoch: this.connectionEpoch,
      snapshotFingerprint: requestFingerprint(changes),
      ...fileChangeDisplays(changes),
    })
    while (this.correlatedFileItems.size > MAX_CORRELATED_FILE_ITEMS) {
      const oldest = this.correlatedFileItems.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.correlatedFileItems.delete(oldest)
    }
  }

  private correlatedFileItem(threadId: string, turnId: string, itemId: string): CorrelatedFileItem | undefined {
    const item = this.correlatedFileItems.get(correlatedFileItemKey(threadId, turnId, itemId))
    if (!item || item.connectionEpoch !== this.connectionEpoch || item.changes.length === 0) return undefined
    if (!this.notificationOwnsTurn(threadId, turnId)) return undefined
    return item
  }

  // The live background-exec level rides the same lifecycle as the correlated file items — a released
  // session and a lost process both invalidate it — but for a different reason. A `processId` names a
  // PTY inside ONE app-server process, so a surviving entry after that process goes away would put an ×
  // on the board that addresses a handle nothing can honour. The next connection's item stream
  // repopulates it, exactly as the SDK's `background_tasks_changed` level does on the Claude side.
  private forgetCorrelatedFileItems(threadId?: string, turnId?: string): void {
    if (threadId === undefined) {
      this.correlatedFileItems.clear()
      this.liveExecs.clear()
      return
    }
    // Only on a whole-thread forget: a per-TURN invalidation (a patch that changed) says nothing about
    // a background exec, which by definition outlives the turn that launched it.
    if (turnId === undefined) this.liveExecs.delete(threadId)
    for (const [key, item] of this.correlatedFileItems) {
      if (item.threadId === threadId && (turnId === undefined || item.turnId === turnId)) {
        this.correlatedFileItems.delete(key)
      }
    }
  }

  private async invalidateCorrelatedFileApproval(
    connection: JsonlRpcConnection,
    item: CorrelatedFileItem,
    reason: "provider-cancelled" | "turn-ended",
    message: string,
  ): Promise<boolean> {
    if (!item.interactionId || item.rpcRequestId === undefined) return true
    const binding = this.bindingForCodexThread(item.threadId)
    if (!binding || binding.connection_epoch !== item.connectionEpoch || binding.state !== "active") return false
    const result = this.options.interactions.invalidateProviderRequest(
      { projectId: this.options.projectId, threadSlug: binding.thread_slug, sessionId: binding.frizz_session_id },
      item.interactionId,
      reason,
    )
    if (result.effect === "cancelled") {
      try {
        await connection.errorResponse(item.rpcRequestId, -32602, message)
      } catch {
        connection.close()
        this.handleDisconnect(connection, "protocol")
        return false
      }
      return true
    }
    if (result.effect === "response-in-flight") {
      // The provider may already have observed the old decision. Killing the exact shared pipe is the
      // only available fail-closed action; every binding on that process is detached before resume.
      connection.close()
      this.handleDisconnect(connection, "protocol")
      return false
    }
    return true
  }

  private interactionRequest(
    row: BindingRow,
    providerRequestId: string,
    turnId: string,
    itemId: string,
    source: InteractionRequestType["source"],
    allowedDecisions: InteractionRequestType["allowedDecisions"],
    payload: InteractionRequestType["payload"],
    expiresAt: string | null = null,
  ): InteractionRequestType {
    const parsed = InteractionRequest.safeParse({
      protocolVersion: INTERACTION_PROTOCOL_VERSION,
      contentFormat: "plain-text",
      provider: { kind: "codex", name: "Codex app-server", version: CODEX_APP_SERVER_SUPPORTED_VERSION },
      source,
      owner: {
        projectId: this.options.projectId,
        threadSlug: row.thread_slug,
        sessionId: row.frizz_session_id,
        turnId,
        itemId,
        sessionEpoch: row.session_epoch,
        capabilityRevision: row.capability_revision,
      },
      providerRequestId,
      allowedDecisions,
      payload,
      expiresAt,
    })
    if (!parsed.success) throw new RpcProtocolError(-32602, "Codex request cannot be represented by the Frizz interaction protocol")
    return parsed.data
  }

  private async handleServerRequest(
    connection: JsonlRpcConnection,
    method: string,
    id: RpcId,
    rawParams: unknown,
  ): Promise<void> {
    let request: InteractionRequestType
    let logicalId: string
    let providerContext: unknown | undefined
    let fileCorrelation: CorrelatedFileItem | undefined

    if (method === "item/commandExecution/requestApproval") {
      const parsed = CommandApprovalParams.safeParse(rawParams)
      if (!parsed.success) throw new RpcProtocolError(-32602, "Invalid Codex command approval request")
      const params = parsed.data
      providerContext = { fingerprint: requestFingerprint(params) }
      const row = this.ownedBinding(params.threadId, params.turnId)
      const actions = commandActions(params.commandActions)
      const capabilities = commandCapabilities(params)
      logicalId = logicalRequestId(method, [params.threadId, params.turnId, params.itemId, params.approvalId ?? null])
      request = this.interactionRequest(
        row,
        logicalId,
        params.turnId,
        params.itemId,
        { kind: "tool", id: "codex-command-execution", label: "Codex command execution" },
        commandDecisions(params.availableDecisions),
        {
          kind: "command-approval",
          title: "Command approval",
          message: displayDescription(params.reason, "Codex requested permission to run a command."),
          command: {
            summary: "Run a command requested by Codex",
            preview: displayPreview(params.command, "Command text was not provided by Codex."),
            redacted: true,
            ...(params.cwd !== null && params.cwd !== undefined
              ? { workingDirectoryLabel: displayLabel(params.cwd, "Working directory unavailable") }
              : {}),
            ...(actions ? { actions } : {}),
          },
          ...(capabilities ? { capabilities } : {}),
        },
      )
    } else if (method === "item/fileChange/requestApproval") {
      const parsed = FileApprovalParams.safeParse(rawParams)
      if (!parsed.success) throw new RpcProtocolError(-32602, "Invalid Codex file approval request")
      const params = parsed.data
      const row = this.ownedBinding(params.threadId, params.turnId)
      const correlated = this.correlatedFileItem(params.threadId, params.turnId, params.itemId)
      if (!correlated) {
        throw new RpcProtocolError(-32602, "Codex file approval has no active correlated file-change item")
      }
      fileCorrelation = correlated
      providerContext = {
        fingerprint: requestFingerprint(params),
        fileSnapshotFingerprint: correlated.snapshotFingerprint,
      }
      // The item id alone is not a stable authority identity: patchUpdated may replace its paths,
      // operations, or diff before Codex asks again. Bind dedupe/reconnect to the exact raw snapshot
      // fingerprint without persisting the raw (potentially secret-bearing) patch in provider context.
      logicalId = logicalRequestId(method, [params.threadId, params.turnId, params.itemId, correlated.snapshotFingerprint])
      const scope = { projectId: this.options.projectId, threadSlug: row.thread_slug, sessionId: row.frizz_session_id }
      for (const stale of this.options.interactions.listPending(scope)) {
        if (
          stale.provider.kind !== "codex" ||
          stale.payload.kind !== "file-approval" ||
          stale.owner.turnId !== params.turnId ||
          stale.owner.itemId !== params.itemId ||
          stale.providerRequestId === logicalId
        ) continue
        const staleDelivery = this.options.interactions.providerDelivery(scope, stale.id)
        const invalidated = this.options.interactions.invalidateProviderRequest(scope, stale.id, "provider-cancelled")
        if (invalidated.effect === "response-in-flight" && staleDelivery?.connectionEpoch === this.connectionEpoch) {
          connection.close()
          this.handleDisconnect(connection, "protocol")
          throw new RpcProtocolError(-32603, "A previous file approval response raced a changed patch")
        }
      }
      const onlyChange = correlated.totalChanges === 1 ? correlated.changes[0] : undefined
      const grantRootLabel = params.grantRoot !== null && params.grantRoot !== undefined
        ? displayLabel(params.grantRoot, "Requested workspace root unavailable", 2_048, 4_096, "session write root")
        : undefined
      request = this.interactionRequest(
        row,
        logicalId,
        params.turnId,
        params.itemId,
        { kind: "tool", id: "codex-file-change", label: "Codex file change" },
        fileDecisions(),
        {
          kind: "file-approval",
          title: "File change approval",
          message: displayDescription(params.reason, "Codex requested permission to change workspace files."),
          operation: onlyChange?.operation ?? "write",
          pathLabel: onlyChange?.pathLabel ?? `${correlated.totalChanges} affected paths`,
          ...(onlyChange?.destinationLabel ? { destinationLabel: onlyChange.destinationLabel } : {}),
          ...(grantRootLabel ? {
            grantRootLabel,
            scopeLabel: "Approving for this session authorizes writes below this root for the remainder of the current Codex session.",
          } : {}),
          changes: correlated.changes,
        },
      )
    } else if (method === "item/permissions/requestApproval") {
      const parsed = PermissionsApprovalParams.safeParse(rawParams)
      if (!parsed.success) throw new RpcProtocolError(-32602, "Invalid Codex permissions approval request")
      const params = parsed.data
      const row = this.ownedBinding(params.threadId, params.turnId)
      logicalId = logicalRequestId(method, [params.threadId, params.turnId, params.itemId])
      const permissionKinds = [params.permissions.network ? "network" : null, params.permissions.fileSystem ? "filesystem" : null]
        .filter(Boolean)
        .join("+") || "additional"
      const capabilities = permissionCapabilities(params.permissions)
      if (capabilities.length === 0) {
        throw new RpcProtocolError(-32602, "Codex permission approval contains no displayable requested capability")
      }
      providerContext = { fingerprint: requestFingerprint(params), permissions: params.permissions }
      request = this.interactionRequest(
        row,
        logicalId,
        params.turnId,
        params.itemId,
        { kind: "runtime", id: "codex-permissions", label: "Codex permissions" },
        permissionDecisions(),
        {
          kind: "permission-approval",
          title: "Additional permission request",
          message: displayDescription(params.reason, "Codex requested additional runtime permissions."),
          permission: permissionKinds,
          workingDirectoryLabel: displayLabel(params.cwd, "Working directory unavailable"),
          scopeLabel: "Approval can be granted for this turn or for the current Codex session.",
          capabilities,
        },
      )
    } else if (method === "item/tool/requestUserInput") {
      const parsed = UserInputParams.safeParse(rawParams)
      if (!parsed.success) throw new RpcProtocolError(-32602, "Invalid Codex user-input request")
      const params = parsed.data
      if (params.questions.some((question) => question.isSecret)) {
        // The exact protocol can carry secret answers, but Frizz's durable provider outbox cannot do
        // so without retaining plaintext. Keep this capability unavailable until transient encrypted
        // delivery exists; do not render an action that will inevitably fail. Turn interruption is a
        // separate `turn/interrupt` client request, never a fabricated user-input response.
        this.options.diagnostic?.({ event: "request-rejected", method, code: -32601 })
        throw new RpcProtocolError(-32601, "Secret Codex user input requires unavailable transient delivery")
      }
      providerContext = { fingerprint: requestFingerprint(params) }
      const row = this.ownedBinding(params.threadId, params.turnId)
      logicalId = logicalRequestId(method, [params.threadId, params.turnId, params.itemId])
      request = this.interactionRequest(
        row,
        logicalId,
        params.turnId,
        params.itemId,
        { kind: "agent", id: "codex-request-user-input", label: "Codex" },
        questionDecisions(),
        {
          kind: "agent-question",
          title: params.questions.length === 1
            ? cleanText(params.questions[0]!.header, 160, "Codex question")
            : "Codex questions",
          fields: userInputFields(params.questions),
        },
        // Codex owns this relative timer and will emit serverRequest/resolved on auto-resolution.
        // Persisting a locally recomputed absolute deadline would make reconnect dedupe unstable.
        null,
      )
    } else if (method === "mcpServer/elicitation/request") {
      const parsed = McpElicitationParams.safeParse(rawParams)
      if (!parsed.success) throw new RpcProtocolError(-32602, "Invalid Codex MCP elicitation request")
      const params = parsed.data
      providerContext = { fingerprint: requestFingerprint(params) }
      if (params.mode === "openai/form") {
        // The initialize capability explicitly disables this opaque, vendor-extended form contract.
        throw new RpcProtocolError(-32601, "OpenAI extended MCP forms are not supported by this Frizz bridge")
      }
      const row = this.ownedBinding(params.threadId, params.turnId)
      const ownerTurnId = params.turnId ?? `mcp-unscoped-${params.threadId}`
      if (params.mode === "url") {
        logicalId = logicalRequestId(method, [params.threadId, params.turnId, params.serverName, params.elicitationId])
        request = this.interactionRequest(
          row,
          logicalId,
          ownerTurnId,
          `mcp-${logicalId.slice(-32)}`,
          { kind: "mcp-server", id: cleanText(params.serverName, 256, "mcp-server"), label: cleanText(params.serverName, 160, "MCP server") },
          elicitationDecisions(),
          {
            kind: "mcp-elicitation-url",
            title: cleanText(params.serverName, 160, "MCP authorization"),
            message: cleanText(params.message, 4_000, "The MCP server requested authorization."),
            protocolVersion: "2025-11-25",
            elicitationId: params.elicitationId,
            url: params.url,
          },
        )
      } else {
        // Standard MCP form requests currently lack a protocol-stable elicitation id. Include the
        // witnessed connection/request ids so repeated identical forms are never conflated. This is
        // intentionally not replayable across reconnect unless Codex provides a new request.
        logicalId = logicalRequestId(method, [
          params.threadId,
          params.turnId,
          params.serverName,
          String(this.connectionEpoch),
          `${typeof id}:${String(id)}`,
        ])
        request = this.interactionRequest(
          row,
          logicalId,
          ownerTurnId,
          `mcp-${logicalId.slice(-32)}`,
          { kind: "mcp-server", id: cleanText(params.serverName, 256, "mcp-server"), label: cleanText(params.serverName, 160, "MCP server") },
          elicitationDecisions(),
          {
            kind: "mcp-elicitation-form",
            title: cleanText(params.serverName, 160, "MCP form"),
            message: cleanText(params.message, 4_000, "The MCP server requested information."),
            protocolVersion: "2025-11-25",
            fields: mcpFields(params.requestedSchema),
          },
        )
      }
    } else {
      this.options.diagnostic?.({ event: "request-rejected", method: cleanText(method, 128, "unknown"), code: -32601 })
      throw new RpcProtocolError(-32601, "Unsupported Codex app-server request method")
    }

    const created = this.options.interactions.createProviderRequest(request, {
      provider: CODEX_APP_SERVER_PROVIDER,
      logicalRequestId: logicalId,
      method,
      connectionEpoch: this.connectionEpoch,
      rpcRequestId: id,
      providerContext,
    })
    if (fileCorrelation) {
      // Dispatch is serialized per connection, so the exact snapshot cannot be replaced between the
      // correlation check, durable create, and this attachment.
      fileCorrelation.interactionId = created.interaction.id
      fileCorrelation.rpcRequestId = id
    }
    await this.flushDelivery(created.delivery, connection)
  }

  // Fold one `item/*` notification into the live background-exec level. Called from the three item
  // methods BEFORE their file-change handling, because those all `return` early on a non-fileChange
  // item and a commandExecution is exactly that.
  //
  // Only an exec carrying a `processId` is tracked at all: the app-server sets it on the yielded/PTY
  // execs and leaves it off ordinary foreground commands, which is the same distinction frizz's own
  // `codexExplicitBackground()` draws in the rollout. So this level lands on the background set
  // without frizz having to classify anything itself.
  private foldExecItem(threadId: string, rawItem: unknown, startedAtMs?: number): void {
    const parsed = CommandExecutionItem.safeParse(rawItem)
    if (!parsed.success) return
    const item = parsed.data
    const processId = item.processId == null ? undefined : String(item.processId)
    if (!processId) return
    // Anything but "still going" retires it. Read as a NEGATIVE test so an unfamiliar status from a
    // newer codex leaves the row up rather than silently clearing live work: a phantom row the operator
    // can dismiss beats a live shell that vanished from the board.
    const live = item.status === "inProgress" && item.exitCode == null
    let byProcess = this.liveExecs.get(threadId)
    if (!live) {
      byProcess?.delete(processId)
      if (byProcess && byProcess.size === 0) this.liveExecs.delete(threadId)
      return
    }
    if (!byProcess) { byProcess = new Map(); this.liveExecs.set(threadId, byProcess) }
    const existing = byProcess.get(processId)
    byProcess.set(processId, {
      processId,
      command: item.command ?? existing?.command,
      // The FIRST sighting's instant, so the row's "running for 4h" does not reset on every update.
      startedAtMs: existing?.startedAtMs ?? startedAtMs ?? this.now().getTime(),
    })
  }

  private async handleNotification(connection: JsonlRpcConnection, method: string, rawParams: unknown): Promise<void> {
    if (method === "item/started") {
      const envelope = ItemStartedNotification.safeParse(rawParams)
      if (!envelope.success) return
      this.foldExecItem(envelope.data.threadId, envelope.data.item, envelope.data.startedAtMs)
      const item = FileChangeItem.safeParse(envelope.data.item)
      if (!item.success || item.data.status !== "inProgress") return
      const key = correlatedFileItemKey(envelope.data.threadId, envelope.data.turnId, item.data.id)
      const current = this.correlatedFileItems.get(key)
      const nextFingerprint = requestFingerprint(item.data.changes)
      if (current?.snapshotFingerprint === nextFingerprint) return
      if (current) {
        const active = await this.invalidateCorrelatedFileApproval(
          connection,
          current,
          "provider-cancelled",
          "Codex file approval was invalidated because its item snapshot changed",
        )
        this.correlatedFileItems.delete(key)
        if (!active) return
      }
      this.rememberFileItem(envelope.data.threadId, envelope.data.turnId, item.data.id, item.data.changes)
      return
    }
    if (method === "item/fileChange/patchUpdated") {
      const parsed = FileChangePatchUpdatedNotification.safeParse(rawParams)
      if (!parsed.success) return
      const key = correlatedFileItemKey(parsed.data.threadId, parsed.data.turnId, parsed.data.itemId)
      const current = this.correlatedFileItems.get(key)
      if (!current) return
      if (current.snapshotFingerprint === requestFingerprint(parsed.data.changes)) return
      const active = await this.invalidateCorrelatedFileApproval(
        connection,
        current,
        "provider-cancelled",
        "Codex file approval was invalidated because its patch changed",
      )
      this.correlatedFileItems.delete(key)
      if (!active) return
      this.rememberFileItem(parsed.data.threadId, parsed.data.turnId, parsed.data.itemId, parsed.data.changes)
      return
    }
    if (method === "item/completed") {
      const envelope = ItemCompletedNotification.safeParse(rawParams)
      if (!envelope.success) return
      this.foldExecItem(envelope.data.threadId, envelope.data.item)
      const item = FileChangeItem.safeParse(envelope.data.item)
      if (!item.success) return
      const key = correlatedFileItemKey(envelope.data.threadId, envelope.data.turnId, item.data.id)
      const current = this.correlatedFileItems.get(key)
      if (current) {
        await this.invalidateCorrelatedFileApproval(
          connection,
          current,
          "provider-cancelled",
          "Codex file approval was invalidated because its file-change item completed",
        )
      }
      this.correlatedFileItems.delete(key)
      return
    }
    if (method === "serverRequest/resolved") {
      const parsed = ResolvedNotification.safeParse(rawParams)
      if (!parsed.success) throw new RpcProtocolError(-32602, "Invalid Codex request-resolved notification")
      const binding = this.bindingForCodexThread(parsed.data.threadId)
      if (!binding || binding.connection_epoch !== this.connectionEpoch || binding.state !== "active") return
      const result = this.options.interactions.acknowledgeProviderResponse(
        CODEX_APP_SERVER_PROVIDER,
        this.connectionEpoch,
        parsed.data.requestId,
        { projectId: this.options.projectId, threadSlug: binding.thread_slug, sessionId: binding.frizz_session_id },
      )
      if (result && (
        result.interaction.owner.threadSlug !== binding.thread_slug ||
        result.interaction.owner.sessionId !== binding.frizz_session_id
      )) {
        throw new Error("Codex request acknowledgement crossed an owned session boundary")
      }
      return
    }
    if (method === "thread/settings/updated") {
      // The ONLY trustworthy evidence that a settings change took effect: the app-server emits this
      // exclusively when the settings actually changed, and it carries the FULL effective ThreadSettings.
      const parsed = ThreadSettingsUpdated.safeParse(rawParams)
      if (!parsed.success) return
      const observed: ObservedThreadSettings = {
        sandbox: codexSandboxModeOfPolicy(parsed.data.threadSettings.sandboxPolicy),
        approvalPolicy: parsed.data.threadSettings.approvalPolicy,
      }
      // Keep the cache honest for EVERY thread, including ones changed by someone else's client.
      const binding = this.bindingForCodexThread(parsed.data.threadId)
      if (binding) {
        this.scope.prepare("UPDATE codex_app_server_session SET sandbox = ?, updated_at = ? WHERE project_id = @project_id AND codex_thread_id = ?")
          .run(observed.sandbox ?? null, this.now().toISOString(), parsed.data.threadId)
      }
      for (const waiter of [...(this.settingsWaiters.get(parsed.data.threadId) ?? [])]) waiter(observed)
      return
    }
    if (method === "turn/started") {
      const parsed = TurnStarted.safeParse(rawParams)
      if (!parsed.success) return
      const binding = this.bindingForCodexThread(parsed.data.threadId)
      if (!binding || binding.connection_epoch !== this.connectionEpoch || binding.state !== "active") return
      if (binding.current_turn_id !== null) {
        // Duplicate notification for the witnessed turn is harmless. A different id must never
        // overwrite the authority already pinned to this Frizz-owned session.
        return
      }
      if (!this.pendingTurnStarts.has(turnKey(binding))) return
      this.scope.prepare(`
        UPDATE codex_app_server_session SET current_turn_id = ?, updated_at = ?
        WHERE project_id = @project_id AND codex_thread_id = ? AND connection_epoch = ? AND current_turn_id IS NULL
      `).run(parsed.data.turn.id, this.now().toISOString(), parsed.data.threadId, this.connectionEpoch)
      return
    }
    if (method === "turn/completed") {
      const parsed = TurnCompleted.safeParse(rawParams)
      if (!parsed.success) return
      for (const item of [...this.correlatedFileItems.values()]) {
        if (item.threadId !== parsed.data.threadId || item.turnId !== parsed.data.turn.id) continue
        const active = await this.invalidateCorrelatedFileApproval(
          connection,
          item,
          "turn-ended",
          "Codex file approval was invalidated because its turn completed",
        )
        if (!active) break
      }
      this.forgetCorrelatedFileItems(parsed.data.threadId, parsed.data.turn.id)
      // A turn that reaches its own ending proves the thread is healthy again, so the restart-recovery
      // budget is restored. Without this reset a thread that had been nudged MAX_AUTO_RESUMES times
      // over its whole life could never be auto-recovered again, however long ago those were.
      this.scope.prepare(`
        UPDATE codex_app_server_session SET current_turn_id = NULL, auto_resume_count = 0, updated_at = ?
        WHERE project_id = @project_id AND codex_thread_id = ? AND connection_epoch = ? AND current_turn_id = ?
      `).run(this.now().toISOString(), parsed.data.threadId, this.connectionEpoch, parsed.data.turn.id)
    }
  }

  private providerResponse(
    record: InteractionRecord,
    delivery: ProviderDelivery,
    input: ResolveInteractionInput,
  ): JsonObject {
    if (delivery.method === "item/commandExecution/requestApproval" || delivery.method === "item/fileChange/requestApproval") {
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(input.decisionId)) {
        throw new InteractionStoreError("invalid-decision", "unsupported Codex approval decision")
      }
      return { decision: input.decisionId }
    }
    if (delivery.method === "item/permissions/requestApproval") {
      const context = z.object({ fingerprint: z.string().length(64), permissions: RequestedPermissions }).strict().safeParse(delivery.providerContext)
      if (!context.success) throw new InteractionStoreError("corrupt-journal", "Codex permission delivery lost its requested profile")
      const permissions = input.decisionId === "grant-turn" || input.decisionId === "grant-session"
        ? {
            ...(context.data.permissions.network === null ? {} : { network: context.data.permissions.network }),
            ...(context.data.permissions.fileSystem === null ? {} : { fileSystem: context.data.permissions.fileSystem }),
          }
        : {}
      if (!["grant-turn", "grant-session", "deny"].includes(input.decisionId)) {
        throw new InteractionStoreError("invalid-decision", "unsupported Codex permission decision")
      }
      return { permissions, scope: input.decisionId === "grant-session" ? "session" : "turn" }
    }
    if (delivery.method === "mcpServer/elicitation/request") {
      if (!["accept", "decline", "cancel"].includes(input.decisionId)) {
        throw new InteractionStoreError("invalid-decision", "unsupported MCP elicitation decision")
      }
      return {
        action: input.decisionId,
        content: input.decisionId === "accept" && record.payload.kind === "mcp-elicitation-form"
          ? input.values ?? {}
          : null,
        _meta: null,
      }
    }
    if (delivery.method === "item/tool/requestUserInput") {
      if (input.decisionId !== "answer") {
        throw new InteractionStoreError("invalid-decision", "unsupported Codex user-input decision")
      }
      const answers: Record<string, { answers: string[] }> = {}
      for (const [id, value] of Object.entries(input.values ?? {})) {
        if (typeof value === "string") answers[id] = { answers: [value] }
        else if (Array.isArray(value)) answers[id] = { answers: value }
        else throw new InteractionStoreError("invalid-response", "Codex user-input answers must be text")
      }
      return { answers }
    }
    throw new InteractionStoreError("invalid-response", "interaction is not owned by a supported Codex request method")
  }

  private async flushDelivery(delivery: ProviderDelivery, explicitConnection?: JsonlRpcConnection): Promise<void> {
    if (delivery.state !== "queued" || delivery.connectionEpoch !== this.connectionEpoch) return
    const connection = explicitConnection ?? this.connection
    if (!connection || connection !== this.connection) return
    let claimed: ProviderDelivery
    try {
      // Claim before writing. A crash after this point leaves SENT/unknown and is never blindly
      // replayed; only a newly witnessed provider request can rebind it to QUEUED.
      claimed = this.options.interactions.claimProviderResponseForSend(
        delivery.interactionId,
        delivery.connectionEpoch,
        delivery.rpcRequestId,
      )
    } catch (error) {
      if (error instanceof InteractionStoreError && (error.code === "not-pending" || error.code === "stale-revision")) return
      throw error
    }
    try {
      await connection.response(claimed.rpcRequestId, claimed.providerResponse)
    } catch (error) {
      connection.close()
      this.handleDisconnect(connection, "error")
      throw error
    }
  }
}

export function createCodexAppServerBridge(options: CodexAppServerBridgeOptions): CodexAppServerBridge {
  return new CodexAppServerBridge(options)
}

// The Codex app-server bridge is the SOLE transport for codex threads (the interactive-CLI path is
// retired). Always enabled. If `codex app-server` can't be reached (or its protocol drifted from the
// pinned revision), a codex dispatch fails LOUDLY with a re-pin hint rather than silently degrading —
// there is no second transport to fall back to. Kept as a function so callers/tests have a single
// source of truth.
export function codexAppServerBridgeEnabled(): boolean {
  return true
}
