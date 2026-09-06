import { accessSync, constants as fsConstants } from "node:fs"
import { delimiter, isAbsolute } from "node:path"
import {
  query,
  type CanUseTool as SdkCanUseTool,
  type ElicitationRequest as SdkElicitationRequest,
  type ElicitationResult as SdkElicitationResult,
  type PermissionResult as SdkPermissionResult,
  type Query as SdkQuery,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@frizz/claude-agent-sdk-runtime"
import { claudeUltracodeSettings, resolveClaudeEffort } from "./claude-effort.ts"
import { resolveClaudeLaunchModel } from "./claude-context-window.ts"
import {
  CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES,
  CLAUDE_AGENT_SDK_MAX_EVENT_TEXT_BYTES,
  CLAUDE_AGENT_SDK_MAX_QUEUED_EVENTS,
  CLAUDE_AGENT_SDK_MAX_QUEUED_INPUTS,
  CLAUDE_AGENT_SDK_PROTOCOL_VERSION,
  ClaudeAgentSdkProtocolError,
  boundedId,
  boundedJsonObject,
  boundedOptionalId,
  boundedStringArray,
  safeText,
  utf8Bytes,
  validateElicitationResult,
  validateInputMessage,
  validatePermissionDecision,
  validatePermissionMode,
  type ClaudeAgentCapability,
  type ClaudeCanUseTool,
  type ClaudeCommandCapability,
  type ClaudeControlInitialization,
  type ClaudeDiagnostic,
  type ClaudeElicitationRequest,
  type ClaudeInputMessage,
  type ClaudeInterruptReceipt,
  type ClaudeModelCapability,
  type ClaudeOnElicitation,
  type ClaudePermissionMode,
  type ClaudePermissionRequest,
  type ClaudePluginReload,
  type ClaudeSkillInfo,
  type ClaudeQueryEvent,
  type ClaudeSessionInitEvent,
  type ClaudeTaskEvent,
  type ClaudeTaskUsage,
} from "./claude-agent-sdk-protocol.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"
import type { WorkerMcpServers } from "./project-mcp-servers.ts"
import { redactCredentialSyntax } from "../credential-redaction.ts"
import type { ThreadSkillSource } from "@frizz/shared"

export const CLAUDE_AGENT_SDK_FOUNDATION_FLAG = "FRIZZ_CLAUDE_AGENT_SDK_FOUNDATION"
export const CLAUDE_AGENT_SDK_CLIENT_APP = "frizz/claude-agent-sdk-foundation"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// The SDK `Query` method that drops a still-queued input, named ONCE so the code that calls it and the
// canary that guards it cannot drift apart. It is real at runtime but missing from the SDK's `.d.ts`,
// so nothing in the type system would notice it disappearing — see claude-agent-sdk.cancel.test.ts.
export const CLAUDE_SDK_CANCEL_METHOD = "cancelAsyncMessage"
// What the OS can carry in an environment block: a non-empty name with no `=` and no NUL. NOT a POSIX
// shell identifier, which is what this was until 2026-09-01 (`/^[A-Za-z_][A-Za-z0-9_]*$/`). Every
// 64-bit Windows environment contains `ProgramFiles(x86)` and `CommonProgramFiles(x86)`, and the
// broker daemon passes the whole inherited environment to buildEnvironment() as overrides — so on
// Windows the daemon threw here on startup, never published its record, and every Claude dispatch
// timed out with "did not become ready" (measured on Windows Server 2022, frizz 0.8.1: three broker
// deaths in a row, each `uncaught-exception: Claude environment contains an invalid key`). Node
// itself spawns a child with such a key without complaint; only this check refused it. cmd.exe's
// hidden `=C:` drive variables never reach process.env (node drops them), so a leading `=` needs no
// special case.
const ENV_KEY_PATTERN = /^[^=\0]+$/
const SENSITIVE_ENV_KEY = /(?:API_KEY|AUTH|BASE_URL|BEARER|COOKIE|CREDENTIAL|OAUTH|PASSWORD|PRIVATE|SECRET|TOKEN)/i
const MAX_ENV_ENTRIES = 512
const MAX_ENV_VALUE_BYTES = 128 * 1024
const MAX_ENV_TOTAL_BYTES = 1024 * 1024
const MAX_PERMISSION_REQUESTS = 128
const MAX_ELICITATION_CALLBACKS = 128
const MAX_SESSION_TITLE_DESCRIPTION_BYTES = 64 * 1024
const MAX_SESSION_TITLE_BYTES = 2 * 1024
// How many completed main-thread turns must pass under an unechoed input before its outstanding slot
// is presumed dead and reclaimed. ONE is the honest floor — an input sent mid-turn is consumed at that
// turn's end, so its echo lands after exactly one `result` — and TWO leaves a whole turn of slack for
// an echo frizz simply failed to match, which is a cheaper mistake than reclaiming a live slot.
const UNECHOABLE_AFTER_RESULTS = 2
const NUB_NODE_SHIM_PATH_SEGMENT = /(?:^|[\\/])nub-node-shim-[^\\/]+$/

export type ClaudeSessionSelection =
  | { kind: "new"; sessionId: string }
  | { kind: "resume"; sessionId: string }

export interface ClaudeQueryStartOptions {
  cwd: string
  session: ClaudeSessionSelection
  permissionMode?: ClaudePermissionMode
  env?: Readonly<Record<string, string | undefined>>
  canUseTool?: ClaudeCanUseTool
  onElicitation?: ClaudeOnElicitation
  onDiagnostic?: (event: ClaudeDiagnostic) => void
  // When true, claude writes its transcript to ~/.claude/projects/<cwdSlug>/<sessionId>.jsonl — the
  // exact file the tailer reads for liveness + the UI transcript. The broker sets this; the default
  // stays false so nothing that used this as a standalone foundation starts persisting unexpectedly.
  persistSession?: boolean
  // Text APPENDED to Claude's default (preset) system prompt — how the frizz worker contract rides the
  // SDK path, the equivalent of the retired argv path's --append-system-prompt-file.
  appendSystemPrompt?: string
  model?: string
  effort?: string
  // The frizz WORKER ENVIRONMENT — the SDK equivalents of the argv path's --plugin-dir / --mcp-config /
  // --allowedTools. Without these a broker session is a bare SDK worker: no frizz:<effort>
  // sub-agent profiles, no frizz MCP (spawn_thread), and none of the cc-worker hooks
  // (deny-ask/deny-plan/agent-bind). `pluginDir` loads the local cc-worker plugin
  // (agents + hooks); `mcpServers` mounts the stdio MCP servers; `allowedTools` pre-approves them so a
  // headless worker never blocks on a tool it has nobody to approve.
  pluginDir?: string
  mcpServers?: WorkerMcpServers
  allowedTools?: string[]
  // Hand the CLI ONLY `mcpServers` (plus whatever the loaded plugin declares): it discovers no `.mcp.json`
  // and no user-scope server by itself. This is just the seam; WHICH servers a worker gets is decided in
  // project-mcp-servers.ts and applied by the broker daemon.
  strictMcpConfig?: boolean
  // Tools taken away from the session outright — the SDK equivalent of the argv path's
  // `--disallowedTools=`. NOTHING passes it today: the broker deliberately keeps AskUserQuestion (it can
  // render the question as a dashboard card), which is the only tool that argv drops. Kept as the
  // plumbed seam so a future prohibition does not have to be argued for AND wired in the same change.
  disallowedTools?: readonly string[]
  // Which of Claude Code's own settings layers the session loads — and, critically, whether it reads
  // the PROJECT's `CLAUDE.md` / `AGENTS.md` and `.claude/skills` at all.
  //
  // Default `["user", "project", "local"]` — every scope, which is what a plain `claude` in the same
  // cwd reads. A frizz thread is the operator's OWN session on their OWN machine, so anything they
  // configured for `claude` has to reach it: `env` (an API-proxy front-end writes its base-URL/token
  // pair there, so dropping the scope authenticates a worker differently from the CLI beside it),
  // `autoCompactWindow`, permissions, hooks and enabled plugins. `cc-worker/DECISIONS.md` already
  // states the policy this restores: frizz deliberately does not isolate `HOME`, `CLAUDE_CONFIG_DIR`
  // or Claude's settings sources, because doing so silently changes auth, user-approved permissions,
  // MCP config and plugin behavior.
  //
  // Pass `[]` for a hermetic session that sees no config at all (what the standalone SDK foundation
  // used before the broker became a real worker transport).
  settingSources?: Array<"user" | "project" | "local">
}

export interface ClaudeQueryHandle extends AsyncIterable<ClaudeQueryEvent> {
  readonly sessionId: string
  next(): Promise<IteratorResult<ClaudeQueryEvent>>
  ready(): Promise<ClaudeSessionInitEvent>
  send(message: ClaudeInputMessage): Promise<void>
  initializationResult(): Promise<ClaudeControlInitialization>
  reinitialize(): Promise<ClaudeControlInitialization>
  interrupt(): Promise<ClaudeInterruptReceipt | undefined>
  /**
   * Take one still-QUEUED input back out of the CLI's command queue, by the uuid `send` supplied.
   * Resolves true only when the CLI positively removed it — i.e. the agent will never read it. False
   * means it had already been dequeued for execution (or was never queued): the message is on its way
   * and nothing was undone. Never guesses; the caller renders the difference to the operator.
   */
  cancelInput(id: string): Promise<boolean>
  /** Stop the background task identified by the provider's task-notification id. */
  stopTask(taskId: string): Promise<void>
  /**
   * Re-read the worker plugin closure from disk IN PLACE — hooks, skills, agent profiles and MCP
   * servers — without restarting the session. This is what `/reload-plugins` drives interactively.
   * Returns what changed so the operator can see their edit landed.
   */
  reloadPlugins(): Promise<ClaudePluginReload>
  /**
   * The session's invocable skills, as the harness itself reports them — names from the init frame,
   * descriptions from `supportedCommands()`. Frizz deliberately implements NO skill discovery of its
   * own: the CLI already resolves plugins, project and global skill roots and their enable state, and
   * a frizz-side re-implementation could only ever drift from it.
   */
  listSkills(): Promise<ClaudeSkillInfo[]>
  setPermissionMode(mode: ClaudePermissionMode): Promise<void>
  // Ask the provider to name the session from `description` and PERSIST the name as the `ai-title`
  // record frizz's tailer reads. See CLAUDE_TITLE_NEEDS_EXPLICIT_REQUEST below for why the broker has
  // to ask instead of letting Claude title the session on its own.
  generateSessionTitle(description: string): Promise<string | undefined>
  close(): Promise<void>
}

export interface ClaudeQueryFactory {
  start(options: ClaudeQueryStartOptions): ClaudeQueryHandle
}

export interface CreateClaudeQueryFactoryOptions {
  // No composition layer enables this yet. Tests opt in explicitly while production callers must
  // pass the exact disabled-by-default flag verdict.
  enabled?: boolean
  executablePath: string
}

export function claudeAgentSdkFoundationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLAUDE_AGENT_SDK_FOUNDATION_FLAG] === "1"
}

export function createClaudeQueryFactory(options: CreateClaudeQueryFactoryOptions): ClaudeQueryFactory {
  if (options.enabled !== true) {
    throw new ClaudeAgentSdkProtocolError("Claude Agent SDK foundation is disabled")
  }
  const executablePath = validateExecutablePath(options.executablePath)
  return {
    start(startOptions) {
      return startClaudeQuery(executablePath, startOptions)
    },
  }
}

class BoundedAsyncQueue<T> implements AsyncIterator<T>, AsyncIterable<T> {
  private readonly buffered: T[] = []
  private readonly waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void }> = []
  private ended = false
  private failure: Error | undefined
  private readonly limit: number
  private readonly label: string

  constructor(limit: number, label: string) {
    this.limit = limit
    this.label = label
  }

  push(value: T): void {
    if (this.ended || this.failure) throw new ClaudeAgentSdkProtocolError(`${this.label} is closed`)
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ done: false, value })
      return
    }
    if (this.buffered.length >= this.limit) throw new ClaudeAgentSdkProtocolError(`${this.label} exceeded its queue limit`)
    this.buffered.push(value)
  }

  end(): void {
    if (this.ended || this.failure) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  fail(error: Error): void {
    if (this.ended || this.failure) return
    this.failure = error
    this.buffered.splice(0)
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.buffered.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.failure) return Promise.reject(this.failure)
    if (this.ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}

class ClaudeInputQueue extends BoundedAsyncQueue<SDKUserMessage> {
  constructor() {
    super(CLAUDE_AGENT_SDK_MAX_QUEUED_INPUTS, "Claude input queue")
  }
}

/**
 * De-duplicates a provider request id, bounded so a flood cannot grow the map without limit.
 *
 * The bound used to be a LIFETIME budget: entries were only ever added, so once `limit` distinct ids
 * had been seen the cache rejected EVERY further request for the rest of the session. For permissions
 * (limit 128) that meant a long orchestrator thread silently lost the ability to run any
 * approval-gated tool — no error the operator can see, the agent just stops being able to use Bash.
 * 128 escalations is very reachable on a multi-hour thread.
 *
 * It is now a CONCURRENCY budget, which is what the bound was actually protecting: a settled entry is
 * evicted (oldest first, Map preserves insertion order) to make room. Idempotency is preserved where
 * it is needed, because the daemon only ever re-delivers requests that are still PENDING — an answered
 * one is deleted from its map before the socket reconnects. A flood of genuinely CONCURRENT requests
 * still rejects, which is the case the "bounded under a flood" test pins.
 */
class BoundedIdempotencyCache<T> {
  private readonly entries = new Map<string, { fingerprint: string; result: Promise<T>; settled: boolean }>()
  private readonly limit: number
  private readonly label: string

  constructor(limit: number, label: string) {
    this.limit = limit
    this.label = label
  }

  /** Drop settled entries, oldest first, until there is room. Returns whether room now exists. */
  private evictSettled(): boolean {
    for (const [id, entry] of this.entries) {
      if (this.entries.size < this.limit) break
      if (entry.settled) this.entries.delete(id)
    }
    return this.entries.size < this.limit
  }

  resolve(id: string, fingerprint: string, create: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(id)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new ClaudeAgentSdkProtocolError(`${this.label} received a conflicting payload for request id ${id}`))
      }
      return existing.result
    }
    if (this.entries.size >= this.limit && !this.evictSettled()) {
      // Every slot is an IN-FLIGHT request — a real flood, not an old session. Reject as before.
      return Promise.reject(new ClaudeAgentSdkProtocolError(`${this.label} exceeded its request limit`))
    }
    const result = Promise.resolve().then(create)
    const entry = { fingerprint, result, settled: false }
    this.entries.set(id, entry)
    result.then(() => { entry.settled = true }, () => { entry.settled = true })
    return result
  }
}

class BoundedCallbackGate {
  private active = 0
  private readonly limit: number
  private readonly label: string

  constructor(limit: number, label: string) {
    this.limit = limit
    this.label = label
  }

  run<T>(callback: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      return Promise.reject(new ClaudeAgentSdkProtocolError(`${this.label} exceeded its callback limit`))
    }
    this.active += 1
    return Promise.resolve()
      .then(callback)
      .finally(() => { this.active -= 1 })
  }
}

class RealClaudeQueryHandle implements ClaudeQueryHandle {
  readonly sessionId: string
  private readonly output = new BoundedAsyncQueue<ClaudeQueryEvent>(CLAUDE_AGENT_SDK_MAX_QUEUED_EVENTS, "Claude event queue")
  private readonly redactor: (value: unknown) => { message: string; truncated: boolean }
  private readonly readyPromise: Promise<ClaudeSessionInitEvent>
  private resolveReady!: (event: ClaudeSessionInitEvent) => void
  private rejectReady!: (error: Error) => void
  private readonly pumpPromise: Promise<void>
  private closing = false
  private closed = false
  private initialized = false
  private initSkills: string[] = []
  private readonly sdkQuery: SdkQuery
  private readonly input: ClaudeInputQueue
  private readonly diagnostic?: (event: ClaudeDiagnostic) => void
  private readonly lifecycleAbort: AbortController
  // id → the main-thread turn count at the moment it was sent. A Map rather than a Set plus a
  // parallel order array because insertion order IS send order, which is all the oldest-first
  // fallback release ever wanted, and the recorded turn count is what makes the bound reclaimable
  // (see pruneUnechoableInputs).
  private readonly outstandingInputs = new Map<string, number>()
  private mainThreadResults = 0
  private providerProgressCovered = false
  private closePromise: Promise<void> | undefined

  constructor(
    sdkQuery: SdkQuery,
    input: ClaudeInputQueue,
    sessionId: string,
    lifecycleAbort: AbortController,
    redactor: (value: unknown) => { message: string; truncated: boolean },
    diagnostic?: (event: ClaudeDiagnostic) => void,
  ) {
    this.sdkQuery = sdkQuery
    this.input = input
    this.sessionId = sessionId
    this.lifecycleAbort = lifecycleAbort
    this.redactor = redactor
    this.diagnostic = diagnostic
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // The promise is also surfaced through ready(); suppress process-level unhandled-rejection noise
    // for callers that only consume the event iterator.
    void this.readyPromise.catch(() => undefined)
    this.diagnostic?.({ kind: "lifecycle", phase: "started" })
    this.pumpPromise = this.pump()
  }

  ready(): Promise<ClaudeSessionInitEvent> {
    return this.readyPromise
  }

  async send(message: ClaudeInputMessage): Promise<void> {
    this.assertOpen()
    const parsed = validateInputMessage(message)
    if (!UUID_PATTERN.test(parsed.id)) throw new ClaudeAgentSdkProtocolError("input.id must be a UUID")
    if (this.outstandingInputs.has(parsed.id)) throw new ClaudeAgentSdkProtocolError("input UUID is already outstanding")
    // Prune HERE, not on an incoming event, and that placement is the whole fix. Every release path
    // this class had ran out of `observeProviderProgress`, so a session whose set had filled could
    // only drain by receiving an event — and it could only receive an event by running a turn, which
    // it could only do by accepting an input. Measured on the maintainer's own board 2026-08-05
    // (thread `are-taking-over-an-in-flight-epic`): the set filled at 19:25:05Z, the agent finished
    // its last turn at 19:56:48Z, and every input after that — 21 heartbeats and the operator's own
    // messages alike — was refused, silently, for the rest of the daemon's life. Draining at send
    // time is the only point in the cycle that deadlock leaves reachable.
    if (this.outstandingInputs.size >= CLAUDE_AGENT_SDK_MAX_QUEUED_INPUTS) this.pruneUnechoableInputs()
    if (this.outstandingInputs.size >= CLAUDE_AGENT_SDK_MAX_QUEUED_INPUTS) {
      throw new ClaudeAgentSdkProtocolError("Claude outstanding input limit exceeded")
    }
    this.outstandingInputs.set(parsed.id, this.mainThreadResults)
    try {
      this.input.push({
        type: "user",
        message: { role: "user", content: parsed.text },
        // null = the session's main thread (every follow-up). A sub-agent STEER carries the child's
        // dispatch tool_use id here, which is the CLI's only addressing channel into a running child.
        parent_tool_use_id: parsed.parentToolUseId ?? null,
        uuid: parsed.id as `${string}-${string}-${string}-${string}-${string}`,
      })
    } catch (error) {
      this.outstandingInputs.delete(parsed.id)
      throw error
    }
  }

  async initializationResult(): Promise<ClaudeControlInitialization> {
    this.assertOpen()
    const providerResult = this.sdkQuery.initializationResult()
    await this.ready()
    this.assertOpen()
    const result = await this.awaitOpenControl(providerResult)
    return mapControlInitialization(result)
  }

  async reinitialize(): Promise<ClaudeControlInitialization> {
    this.assertOpen()
    await this.ready()
    this.assertOpen()
    const result = await this.awaitOpenControl(this.sdkQuery.reinitialize())
    return mapControlInitialization(result)
  }

  async interrupt(): Promise<ClaudeInterruptReceipt | undefined> {
    this.assertOpen()
    await this.ready()
    this.assertOpen()
    const receipt = await this.awaitOpenControl(this.sdkQuery.interrupt())
    if (!receipt) return undefined
    return { stillQueued: boundedStringArray(receipt.still_queued, "interrupt.stillQueued", 256, 512).map((id, index) => boundedId(id, `interrupt.stillQueued[${index}]`)) }
  }

  async stopTask(taskId: string): Promise<void> {
    this.assertOpen()
    const parsed = boundedId(taskId, "stopTask.taskId")
    await this.ready()
    this.assertOpen()
    await this.awaitOpenControl(this.sdkQuery.stopTask(parsed))
  }

  // Reload the plugin closure in place. Unlike cancelAsyncMessage this IS in the SDK's `.d.ts`, so it
  // is called directly rather than probed — but it is still checked before use, because the failure a
  // missing method produces ("not a function") surfaces as an opaque throw out of an operator click
  // rather than as something they can act on.
  async reloadPlugins(): Promise<ClaudePluginReload> {
    this.assertOpen()
    if (typeof this.sdkQuery.reloadPlugins !== "function") {
      throw new Error("this Claude Agent SDK build has no reloadPlugins(); frizz cannot reload plugins in place")
    }
    await this.ready()
    this.assertOpen()
    const result = await this.awaitOpenControl(this.sdkQuery.reloadPlugins())
    // A reload is the one moment a skill's source can change under a live session — a plugin appears,
    // a project skill is added — so the memoized source map is dropped here and re-fetched on the next
    // listing. Dropped AFTER the reload lands: an in-flight fetch racing a reload would otherwise be
    // re-cached stale.
    this.skillSourcesPromise = null
    // Everything crossing back is bounded: this is provider-shaped data heading for a toast, and the
    // server must not relay an unbounded array of names it never sized.
    return {
      plugins: Array.isArray(result?.plugins) ? result.plugins.length : 0,
      commands: Array.isArray(result?.commands) ? result.commands.length : 0,
      agents: Array.isArray(result?.agents) ? result.agents.length : 0,
      mcpServers: boundedStringArray(
        (Array.isArray(result?.mcpServers) ? result.mcpServers : []).map((s: { name?: unknown }) => String(s?.name ?? "")),
        "reloadPlugins.mcpServers",
        64,
        128,
      ).filter(Boolean),
      errorCount: Number.isFinite(result?.error_count) ? Number(result.error_count) : 0,
    }
  }

  // The session's invocable skills: the initialize handshake already carries every slash entry WITH
  // its description (mapped and bounded above in mapControlInitialization — the same data the SDK's
  // `supportedCommands()` would re-serve from its cache), and the init frame's `skills` array is the
  // harness's own verdict on which of those are skills rather than built-in commands. The intersection
  // is exactly "what `/name` invokes a skill", with descriptions, and zero frizz-side discovery.
  //
  // Where each one CAME FROM is a second question, and claude answers it in exactly one place:
  // `getContextUsage().skills.skillFrontmatter[].source`. Not in `SlashCommand`, which carries only
  // {name, description, argumentHint, aliases}. The tempting free alternative — the CLI appends the
  // source to the description as a parenthetical, " (user)" / " (project)" — was measured and rejected:
  // it names only those two of the four roots, and the same regex false-positives on descriptions that
  // legitimately end in a parenthetical (`/deep-research` ends "(dynamic workflow)", `/clear`
  // "(resumable with /resume)", `/fast` "(Opus 4.8)"). A wrong label is worse than none.
  async listSkills(): Promise<ClaudeSkillInfo[]> {
    const initialization = await this.initializationResult()
    const sources = await this.skillSources()
    const skillNames = new Set(this.initSkills)
    const skills: ClaudeSkillInfo[] = []
    for (const command of initialization.commands) {
      if (!command.name || !skillNames.has(command.name)) continue
      const source = sources.get(command.name)
      // The wire cap for a typeahead row is tighter than the 4KB the initialize mapper allows a
      // command description — the shared ThreadSkill schema rejects anything past 1024.
      skills.push({ name: command.name, description: withoutRedundantSource(command.description, source).slice(0, 1024), source })
    }
    return skills
  }

  // The name→source map behind listSkills, fetched ONCE per session and memoized on the promise.
  //
  // `getContextUsage()` is a real control round trip that re-counts tokens every time — measured at
  // 1222ms then 1105ms against claude 2.1.246, so the CLI does not cache it either. Paying that on
  // every `/` would be felt; paying it once, lazily, on the first `/` a thread ever opens is not, and
  // the web caches the finished listing per slug on top of that. Deliberately NOT prefetched at init:
  // most threads never open the menu, and taxing every session start for a menu nobody asked for is
  // the wrong trade.
  //
  // A failure resolves to an EMPTY map rather than rejecting: the source is decoration, and losing it
  // must never cost the operator the listing itself.
  private skillSourcesPromise: Promise<Map<string, ThreadSkillSource>> | null = null
  private skillSources(): Promise<Map<string, ThreadSkillSource>> {
    this.skillSourcesPromise ??= this.fetchSkillSources().catch(() => new Map<string, ThreadSkillSource>())
    return this.skillSourcesPromise
  }

  private async fetchSkillSources(): Promise<Map<string, ThreadSkillSource>> {
    this.assertOpen()
    // Deliberately NOT gated on ready(), unlike the mutating verbs above. listSkills has always
    // answered from the initialize handshake alone, and real claude emits the session's first init
    // FRAME only once a turn starts — so awaiting ready here would newly block a listing that used to
    // succeed, on a session that has not run yet. get_context_usage rides the same control channel as
    // initialize, so it needs no more than an open one.
    const usage = await this.awaitOpenControl(this.sdkQuery.getContextUsage())
    const rows = boundedArray(usage?.skills?.skillFrontmatter, "contextUsage.skills.skillFrontmatter", 1024)
    const sources = new Map<string, ThreadSkillSource>()
    for (const [index, entry] of rows.entries()) {
      // Per-row DEGRADE, not throw: one malformed entry costs its own label, never the whole map. The
      // rest of this adapter is strict because a bad frame there means a corrupt session; here it means
      // one typeahead row renders without a tag.
      try {
        const row = objectValue(entry, `contextUsage.skills.skillFrontmatter[${index}]`)
        const name = safeText(row.name, `contextUsage.skills.skillFrontmatter[${index}].name`, 512)
        const source = claudeSkillSource(safeText(row.source, `contextUsage.skills.skillFrontmatter[${index}].source`, 64))
        if (name && source) sources.set(name, source)
      } catch { continue }
    }
    return sources
  }

  // Unqueue a follow-up the operator has taken back.
  //
  // `cancelAsyncMessage` is present at runtime in @anthropic-ai/claude-agent-sdk 0.3.207 but absent
  // from its `.d.ts` `Query` interface, so — exactly like generateSessionTitle above — the capability
  // is PROBED rather than assumed, and an SDK bump that drops it fails loudly here instead of throwing
  // an opaque "not a function" out of the operator's click. See CLAUDE_SDK_CANCEL_METHOD, which is the
  // CI canary for precisely that: it needs no auth and no process, because query() hands back a Query
  // before the CLI is ever spawned.
  //
  // Deliberately the SDK's own method rather than its private `request` + a hand-parsed
  // `{response:{cancelled}}` envelope, which is what this first shipped as. The envelope is
  // undocumented, and mis-reading it would silently degrade to `false` — reporting "too late" for a
  // message the CLI had in fact dropped, which leaves the retracted send rendering as one the human
  // sent (the exact lie the delivery-ledger tombstone exists to prevent). Letting the SDK own the
  // envelope means a protocol change moves with the SDK instead of rotting here.
  //
  // Measured live against claude 2.1.220 / SDK 0.3.207 (_live_sdk_cancel_queued.mts): a still-queued
  // uuid answers true and the message never reaches the model — no assistant acknowledgement, no
  // `queued_command` attachment, no user record — while a co-queued SIBLING is untouched and runs
  // normally. An unknown/already-dequeued uuid answers false without throwing, which is the honest
  // "too late" the caller surfaces.
  async cancelInput(id: string): Promise<boolean> {
    this.assertOpen()
    const messageUuid = boundedId(id, "cancelInput.id")
    if (!UUID_PATTERN.test(messageUuid)) throw new ClaudeAgentSdkProtocolError("cancelInput.id must be a UUID")
    await this.ready()
    this.assertOpen()
    const provider = this.sdkQuery as unknown as {
      [CLAUDE_SDK_CANCEL_METHOD]?: (messageUuid: string) => Promise<unknown>
    }
    if (typeof provider[CLAUDE_SDK_CANCEL_METHOD] !== "function") {
      throw new ClaudeAgentSdkProtocolError("Claude queued-input cancellation is unavailable")
    }
    const answer = await this.awaitOpenControl(provider[CLAUDE_SDK_CANCEL_METHOD](messageUuid))
    // STRICT, and never coerced. Anything but a boolean means frizz cannot tell whether the provider
    // dropped the message, and the two readings have opposite consequences — so refuse to guess and
    // let the caller surface a failure instead of inventing a verdict.
    if (typeof answer !== "boolean") {
      throw new ClaudeAgentSdkProtocolError("Claude queued-input cancellation returned an unreadable answer")
    }
    // A cancelled input will never be echoed back, so observeProviderProgress can never release its
    // slot — without this it would hold one of the 64 outstanding-input slots for the life of the
    // session, and a thread the operator unqueues from often would eventually refuse new sends.
    if (answer) this.outstandingInputs.delete(messageUuid)
    return answer
  }

  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    this.assertOpen()
    const parsedMode = validatePermissionMode(mode)
    await this.ready()
    this.assertOpen()
    await this.awaitOpenControl(this.sdkQuery.setPermissionMode(parsedMode))
  }

  async generateSessionTitle(description: string): Promise<string | undefined> {
    this.assertOpen()
    // The titler summarizes the text it is given; a whole dispatch prompt is fine (and is what makes
    // the title about the TASK) but it must not become an unbounded control frame.
    const text = safeText(description, "sessionTitle.description", MAX_SESSION_TITLE_DESCRIPTION_BYTES).trim()
    if (!text) throw new ClaudeAgentSdkProtocolError("sessionTitle.description must not be empty")
    await this.ready()
    this.assertOpen()
    const provider = this.sdkQuery as unknown as {
      generateSessionTitle?: (description: string, options?: { persist?: boolean }) => Promise<string | null | undefined>
    }
    // Present at runtime in @anthropic-ai/claude-agent-sdk 0.3.207 but absent from its .d.ts, so the
    // capability is probed rather than assumed — an SDK bump that drops it must fail loudly here, not
    // throw an opaque "not a function" out of a background title request.
    if (typeof provider.generateSessionTitle !== "function") {
      throw new ClaudeAgentSdkProtocolError("Claude session-title generation is unavailable")
    }
    const title = await this.awaitOpenControl(provider.generateSessionTitle(text, { persist: true }))
    if (typeof title !== "string") return undefined
    const clean = safeText(title, "sessionTitle.title", MAX_SESSION_TITLE_BYTES).trim()
    return clean === "" ? undefined : clean
  }

  close(): Promise<void> {
    this.closePromise ??= this.performClose()
    return this.closePromise
  }

  private async performClose(): Promise<void> {
    this.closing = true
    this.lifecycleAbort.abort()
    this.input.end()
    this.clearOutstandingInputs()
    this.sdkQuery.close()
    try {
      await this.pumpPromise
    } catch {
      // pump() already normalized and published any failure.
    }
  }

  next(): Promise<IteratorResult<ClaudeQueryEvent>> {
    return this.output.next()
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeQueryEvent> {
    return this
  }

  private async pump(): Promise<void> {
    try {
      for await (const raw of this.sdkQuery) {
        // MAPPING is not OWNERSHIP. A frame frizz cannot represent in its typed shape is a TELEMETRY
        // loss; a frame that names someone else's session is a breach. Only the second may be fatal.
        //
        // These were conflated, and the conflation cost hours of live work. `mapSdkMessage` throwing
        // lands in this method's catch, which calls `sdkQuery.close()` — killing the claude process
        // and every in-flight sub-agent — and reports `lifecycle:crashed`. Three sessions died this
        // way on 2026-07-27 alone: two on `input.command contains unsafe text` (one control character
        // inside a Bash command) and one on `input.content contains oversized text` (a Write over the
        // validator's 16 KiB per-string cap). Ordinary agent behaviour, total session loss.
        //
        // Note the broker's own error tolerance (claude-agent-broker.ts) CANNOT save the session from
        // here: by the time an error surfaces to it, this catch has already closed the query. The
        // chokepoint is here, so the repair belongs here — drop the frame and keep going.
        //
        // Dropping is cheap precisely because this stream is not frizz's system of record: the tailer
        // reads the session JSONL directly, so the board still sees what the agent did. Ownership
        // checks below stay fatal, unchanged.
        let event: ClaudeQueryEvent
        try {
          event = mapSdkMessage(raw)
        } catch (error) {
          this.diagnostic?.({
            kind: "stderr",
            message: `unmappable event dropped (session continues): ${error instanceof Error ? error.message : String(error)}`,
            truncated: false,
          })
          continue
        }
        // Session OWNERSHIP is the invariant to protect: every event that names a session must name
        // OURS. What the earlier rules got wrong — because they were calibrated to the fake test CLI,
        // not a real claude — is TWO benign things real claude does in streaming mode: it re-emits
        // `init` at the start of EVERY turn (same session id), and it brackets turns with control
        // frames (`command_lifecycle`, `rate_limit_event`) that can precede the first init. Both carry
        // the owned session id, so they are safe to accept; only a genuinely cross-session or
        // unattributed event is rejected.
        if (event.kind === "init") {
          if (event.sessionId !== this.sessionId) throw new ClaudeAgentSdkProtocolError("Claude session ownership mismatch")
          // Latch the harness's own skill list from EVERY init (real claude re-emits init per turn, and
          // a turn can discover new skills). `listSkills` intersects this with `supportedCommands()`,
          // which also returns built-in commands — the init `skills` array is what tells them apart.
          this.initSkills = event.skills
          // A per-turn re-init of the SAME session is a control marker, not a new session: it must not
          // re-resolve `ready` or re-arm the pre-init guard below. It IS still relayed, because it is the
          // only place the session's resolved model is named — and that alias is what picks this thread's
          // row out of `result.modelUsage`, the sole source of the context meter's denominator
          // (claude-runtime-ingest.ts pickWindow). Swallowing it announced the alias exactly ONCE per
          // DAEMON lifetime, to whichever frizz process happened to be attached at the time; since a broker
          // daemon OUTLIVES the frizz server, every thread frizz reattached after a restart could never
          // relearn it, and a turn that bills more than one model (any sub-agent on another model) then has
          // no denominator that pickWindow is willing to name. Measured on the maintainer's own board:
          // 42 of 323 claude threads carried a reading, and the split was exactly which frizz process had
          // forked the daemon. `sessionModel` is a plain overwrite of an unchanged value, so relaying it
          // every turn costs one map write per turn.
          if (this.initialized) {
            this.output.push(event)
            continue
          }
          this.initialized = true
          this.resolveReady(event)
          this.output.push(event)
          continue
        }
        if (!this.initialized) {
          // ONLY control/telemetry frames (command_lifecycle, rate_limit_event → kind "other", and the
          // sub-agent task lifecycle → kind "task") legitimately precede the session init. Anything
          // substantive (assistant/user/result) before init is anomalous and still rejected, exactly as
          // before — and the frame must prove ownership.
          //
          // `task` is listed here because it was CARVED OUT of `other`: those frames have always been
          // tolerated pre-init, and giving them their own kind without widening this guard would have
          // converted a swallowed telemetry frame into a session kill. That is the same
          // telemetry-loss-treated-as-fatal conflation the pump's own comment above is about.
          if (event.kind !== "other" && event.kind !== "task") throw new ClaudeAgentSdkProtocolError("Claude emitted a non-init event before session ownership")
          if (event.sessionId === undefined) throw new ClaudeAgentSdkProtocolError("Claude emitted a non-init event before session ownership")
          if (event.sessionId !== this.sessionId) throw new ClaudeAgentSdkProtocolError("Claude session ownership mismatch")
          continue // swallow so the first event a consumer sees is still the init
        }
        if (event.sessionId === undefined) throw new ClaudeAgentSdkProtocolError("Claude event is missing session ownership")
        if (event.sessionId !== this.sessionId) throw new ClaudeAgentSdkProtocolError("Claude event crossed session ownership")
        this.observeProviderProgress(event)
        this.output.push(event)
      }
      if (!this.initialized) throw new ClaudeAgentSdkProtocolError("Claude ended before session initialization")
      this.closed = true
      this.lifecycleAbort.abort()
      this.clearOutstandingInputs()
      this.output.end()
      this.diagnostic?.({ kind: "lifecycle", phase: "closed" })
    } catch (rawError) {
      const normalized = this.protocolError(rawError)
      this.rejectReady(normalized)
      this.closed = true
      this.lifecycleAbort.abort()
      this.input.end()
      this.clearOutstandingInputs()
      if (this.closing) {
        this.output.end()
        this.diagnostic?.({ kind: "lifecycle", phase: "closed" })
      } else {
        this.output.fail(normalized)
        this.diagnostic?.({ kind: "lifecycle", phase: "crashed", message: normalized.message })
        this.sdkQuery.close()
      }
    }
  }

  private protocolError(rawError: unknown): Error {
    if (rawError instanceof ClaudeAgentSdkProtocolError) return rawError
    const { message } = this.redactor(rawError)
    return new ClaudeAgentSdkProtocolError(`Claude SDK process failed: ${message}`)
  }

  private observeProviderProgress(event: ClaudeQueryEvent): void {
    // Synthetic user-role tool results are provider-generated and do not prove that a host input
    // UUID was consumed. Only a genuine user echo may release the exact outstanding UUID.
    if (
      event.kind === "user" &&
      !event.synthetic &&
      event.toolResultIds.length === 0 &&
      event.messageId &&
      this.outstandingInputs.delete(event.messageId)
    ) {
      this.providerProgressCovered = true
      return
    }
    // A subagent assistant frame can arrive independently of the main-thread input queue. Only
    // main-thread assistant/result progression is a safe fallback when an older provider omits the
    // exact user echo.
    const mainThreadProgress = (event.kind === "assistant" && event.parentToolUseId === undefined) || event.kind === "result"
    if (mainThreadProgress) {
      if (!this.providerProgressCovered && this.releaseOldestOutstandingInput()) this.providerProgressCovered = true
      // A `result` carries no parentToolUseId (see ClaudeResultEvent) — it is the END OF A MAIN-THREAD
      // TURN and nothing else, which is what makes it the clock pruneUnechoableInputs counts in.
      if (event.kind === "result") {
        this.providerProgressCovered = false
        this.mainThreadResults += 1
      }
    }
  }

  private releaseOldestOutstandingInput(): boolean {
    const oldest = this.outstandingInputs.keys().next()
    if (oldest.done === true) return false
    this.outstandingInputs.delete(oldest.value)
    return true
  }

  /**
   * Reclaim the slots of inputs the provider can no longer echo.
   *
   * The CLI consumes a queued input at a TURN BOUNDARY: send it to an idle session and the echo comes
   * back on the turn that starts immediately; send it mid-turn and it is consumed when that turn ends.
   * So an input still unechoed after TWO main-thread `result` frames have passed under it was either
   * consumed without an echo frizz could match or lost outright — either way its echo is never coming,
   * and holding its slot for the life of the session is a pure leak. Measured on the session in the
   * `send` comment: 349 inputs accepted in one daemon generation, 36 of them never echoed.
   *
   * Deliberately NOT a "just evict the oldest to make room" eviction, which would also throw away the
   * genuinely-queued. A flood of 64 sends inside a single turn prunes nothing and still rejects, which
   * is the backpressure this bound exists for: `ClaudeInputQueue` cannot supply it, because the SDK
   * drains that queue eagerly and its buffer therefore sits near empty however hard the host sends.
   */
  private pruneUnechoableInputs(): void {
    let reclaimed = 0
    for (const [id, resultsAtSend] of this.outstandingInputs) {
      if (this.mainThreadResults - resultsAtSend < UNECHOABLE_AFTER_RESULTS) continue
      this.outstandingInputs.delete(id)
      reclaimed += 1
    }
    if (reclaimed === 0) return
    // Worth a line even though it is recovery rather than failure: an unechoed input is a message the
    // agent may never have read, and the count is the only trace that it happened.
    this.diagnostic?.({
      kind: "stderr",
      message: `reclaimed ${reclaimed} outstanding input slot(s) the provider never echoed`,
      truncated: false,
    })
  }

  private clearOutstandingInputs(): void {
    this.outstandingInputs.clear()
    this.mainThreadResults = 0
    this.providerProgressCovered = false
  }

  private async awaitOpenControl<T>(operation: Promise<T>): Promise<T> {
    try {
      const result = await operation
      this.assertOpen()
      return result
    } catch (error) {
      if (this.closing || this.closed) throw new ClaudeAgentSdkProtocolError("Claude query is closed")
      throw this.protocolError(error)
    }
  }

  private assertOpen(): void {
    if (this.closing || this.closed) throw new ClaudeAgentSdkProtocolError("Claude query is closed")
  }
}

function startClaudeQuery(executablePath: string, options: ClaudeQueryStartOptions): ClaudeQueryHandle {
  const cwd = validateAbsolutePath(options.cwd, "cwd")
  const sessionId = validateSessionId(options.session.sessionId)
  const environment = buildEnvironment(options.env)
  const redact = createClaudeDiagnosticRedactor(environment)
  const diagnostic = guardDiagnosticCallback(options.onDiagnostic)
  const permissionMode = validatePermissionMode(options.permissionMode ?? "default")
  const lifecycleAbort = new AbortController()
  const permissionRequests = new BoundedIdempotencyCache<SdkPermissionResult>(MAX_PERMISSION_REQUESTS, "Claude permission request cache")
  const elicitationCallbacks = new BoundedCallbackGate(MAX_ELICITATION_CALLBACKS, "Claude elicitation callbacks")

  const input = new ClaudeInputQueue()
  const canUseTool = options.canUseTool
    ? async (toolName: string, rawInput: Record<string, unknown>, context: Parameters<SdkCanUseTool>[2]): Promise<SdkPermissionResult> => {
      // Representing the request is STRICT on purpose (see mapPermissionRequest: this decides whether
      // authority is granted, so ambiguous bytes are rejected rather than sanitized). But rejecting
      // must mean DENY THIS TOOL CALL, never "reject the callback" — this used to be called outside
      // the guard below, so an unrepresentable input rejected the SDK's canUseTool instead.
      //
      // That is the same shape as the incident that destroyed a thread and all its sub-agents on
      // 2026-07-27 (a control character in a Bash `command`; see mapAssistant), and it lands on a
      // HOTTER path: canUseTool fires precisely for risky tool calls, which is exactly where Bash
      // commands — and therefore ANSI escapes and other control bytes — actually live.
      //
      // Fail closed AND alive. It also matches what the bridge already does one layer up when it
      // cannot build an approval card: deny with a plain message rather than take anything down.
      // CONTENT vs PROTOCOL, and the distinction is the whole point:
      //  - an INPUT frizz cannot represent is a content problem. Deny this one call; the session lives.
      //  - a malformed control frame (no requestId, no toolUseId) is a protocol violation. There is no
      //    correlation id to answer against, so a deny would go nowhere — that still fails hard, and
      //    the "without requestId" test pins it.
      // Guard the WHOLE representation, not just `input`. The first cut pre-checked only rawInput, but
      // mapPermissionRequest applies equally strict validators to `title`, `description`,
      // `decisionReason`, `blockedPath` and `suggestions[]` — all derived from the same tool text, and
      // all capped at 8 KB where the input cap is 64 KB. So a 10 KB Bash command with no control
      // characters at all passed the input pre-check and still threw on the title.
      //
      // Protocol failures (a frame with no requestId to answer against) are still hard: they are
      // detected before this, and the "without requestId fails before entering the host callback"
      // test pins that they stay that way.
      let request: ClaudePermissionRequest
      try {
        request = mapPermissionRequest(toolName, rawInput, context)
      } catch (error) {
        // No correlation id to answer against ⇒ a deny would go nowhere; that stays fatal, and the
        // ORIGINAL error is re-thrown so the diagnostic still names the actual missing field.
        if (!context.requestId || !context.toolUseID) throw error
        return { behavior: "deny", message: "This tool call could not be represented for approval, so frizz denied it." } as SdkPermissionResult
      }
      const fingerprint = canonicalFingerprint(request)
      return permissionRequests.resolve(request.requestId, fingerprint, async () => {
        const signal = AbortSignal.any([context.signal, lifecycleAbort.signal])
        try {
          const pending = Promise.resolve().then(() => options.canUseTool!(request, { signal }))
          return validatePermissionDecision(await abortableCallback(pending, signal, "Claude permission callback")) as SdkPermissionResult
        } catch (error) {
          if (error instanceof ClaudeAgentSdkProtocolError) throw error
          throw new ClaudeAgentSdkProtocolError("Claude permission callback failed")
        }
      })
    }
    : undefined

  const onElicitation = options.onElicitation
    ? async (rawRequest: SdkElicitationRequest, context: { signal: AbortSignal }): Promise<SdkElicitationResult> => {
      const request = mapElicitationRequest(rawRequest)
      try {
        const signal = AbortSignal.any([context.signal, lifecycleAbort.signal])
        return await elicitationCallbacks.run(async () => {
          const pending = Promise.resolve().then(() => options.onElicitation!(request, { signal }))
          const result = validateElicitationResult(await abortableCallback(pending, signal, "Claude elicitation callback"))
          validateElicitationResponse(request, result)
          return result as SdkElicitationResult
        })
      } catch (error) {
        if (error instanceof ClaudeAgentSdkProtocolError) throw error
        throw new ClaudeAgentSdkProtocolError("Claude elicitation callback failed")
      }
    }
    : undefined

  const claudeEffort = resolveClaudeEffort(options.effort)
  const launchModel = resolveClaudeLaunchModel(options.model)

  const raw = query({
    prompt: input,
    options: {
      cwd,
      env: sanitizeProviderChildEnvironment(environment),
      pathToClaudeCodeExecutable: executablePath,
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(options.session.kind === "new" ? { sessionId } : { resume: sessionId }),
      canUseTool,
      onElicitation,
      // EVERY scope by default — see ClaudeQueryStartOptions.settingSources. `[]` was correct while this
      // was a standalone foundation nothing dispatched through; once the broker became the DEFAULT
      // Claude transport it silently stopped every worker from seeing the repo's own `CLAUDE.md` /
      // `AGENTS.md` and its `.claude/skills`. Measured differential in the frizz repo, one variable:
      // this factory answered `NO-CLAUDE-MD` where a plain `claude -p` in the same cwd answered
      // "# No pull requests — land on local `main`". That fix restored PROJECT + LOCAL and left USER
      // out, which kept a second, quieter half of the same regression: the retired transport ran plain
      // `claude` and got all three scopes, so a broker session was the only place the operator's
      // `~/.claude/settings.json` stopped applying. Measured 2026-08-16 against the maintainer's real
      // config, one variable: `--setting-sources=project,local` reported their `env` block UNSET where
      // `user,project,local` reported it applied.
      settingSources: options.settingSources ?? ["user", "project", "local"],
      // The frizz worker environment (see ClaudeQueryStartOptions): load the local cc-worker plugin so a
      // broker session gets the frizz sub-agent profiles + hooks, mount the frizz MCP server, and
      // pre-approve it. EMPTY is skipped, not passed: since frizz stopped mounting a browser (2026-08-26)
      // a resolved-nothing worker env is a real state, and `{}`/`[]` are truthy — handing the SDK an
      // empty allowlist is not the same as handing it none. The project's own `.mcp.json` servers arrive
      // INSIDE `mcpServers` — the broker daemon merges them (project-mcp-servers.ts) — because
      // `strictMcpConfig` stops the CLI discovering any MCP scope by itself.
      ...(options.pluginDir ? { plugins: [{ type: "local" as const, path: options.pluginDir }] } : {}),
      ...(options.mcpServers && Object.keys(options.mcpServers).length > 0 ? { mcpServers: options.mcpServers } : {}),
      ...(options.strictMcpConfig ? { strictMcpConfig: true } : {}),
      ...(options.allowedTools?.length ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools?.length ? { disallowedTools: [...options.disallowedTools] } : {}),
      persistSession: options.persistSession ?? false,
      // Keep Claude's default (preset) system prompt and APPEND the frizz worker contract, the SDK
      // equivalent of the argv path's --append-system-prompt-file.
      ...(options.appendSystemPrompt ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: options.appendSystemPrompt } } : {}),
      // The 1M context window rides the MODEL value as a `[1m]` suffix, always paired with the bare
      // alias as `fallbackModel` — an unavailable long-context beta is a hard 400 that kills the
      // session, and the fallback is what makes asking for it safe on every subscription. See
      // claude-context-window.ts for the measurements.
      ...(launchModel ? { model: launchModel.model } : {}),
      ...(launchModel?.fallbackModel ? { fallbackModel: launchModel.fallbackModel } : {}),
      // "ultracode" is not an `effort` value — it resolves to xhigh plus a session setting, and the two
      // must travel TOGETHER or the setting is silently ignored (see resolveClaudeEffort). `settings` is
      // an additional highest-precedence settings source, layered over `settingSources` above.
      ...(claudeEffort.effort ? { effort: claudeEffort.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
      ...(claudeEffort.ultracode ? { settings: claudeUltracodeSettings() } : {}),
      stderr(data) {
        const redacted = redact(data)
        diagnostic?.({ kind: "stderr", ...redacted })
      },
    },
  })

  return new RealClaudeQueryHandle(raw, input, sessionId, lifecycleAbort, redact, diagnostic)
}

function mapPermissionRequest(
  toolName: string,
  rawInput: Record<string, unknown>,
  context: {
    signal: AbortSignal
    suggestions?: unknown[]
    blockedPath?: string
    decisionReason?: string
    title?: string
    displayName?: string
    description?: string
    toolUseID: string
    agentID?: string
    requestId: string
  },
): ClaudePermissionRequest {
  return {
    requestId: boundedId(context.requestId, "permission.requestId"),
    toolUseId: boundedId(context.toolUseID, "permission.toolUseId"),
    agentId: boundedOptionalId(context.agentID, "permission.agentId"),
    // Callback inputs determine whether authority is granted. Reject ambiguous bytes instead of
    // showing the host a sanitized/truncated value while the provider acts on the original one.
    toolName: exactText(toolName, "permission.toolName", 512),
    input: boundedJsonObject(rawInput, "permission.input"),
    blockedPath: optionalExactText(context.blockedPath, "permission.blockedPath", 8 * 1024),
    decisionReason: optionalExactText(context.decisionReason, "permission.decisionReason", 8 * 1024),
    title: optionalExactText(context.title, "permission.title", 8 * 1024),
    displayName: optionalExactText(context.displayName, "permission.displayName", 2 * 1024),
    description: optionalExactText(context.description, "permission.description", 8 * 1024),
    suggestions: boundedArray(context.suggestions ?? [], "permission.suggestions", 32)
      .map((entry, index) => boundedJsonObject(entry, `permission.suggestions[${index}]`, 16 * 1024)),
  }
}

function mapElicitationRequest(request: SdkElicitationRequest): ClaudeElicitationRequest {
  const mode = request.mode === undefined ? undefined : request.mode
  if (mode !== undefined && mode !== "form" && mode !== "url") throw new ClaudeAgentSdkProtocolError("elicitation mode is unsupported")
  const url = request.url === undefined || request.url === null
    ? undefined
    : exactText(request.url, "elicitation.url", 2_048)
  if (url !== undefined) validateElicitationUrl(url)
  const elicitationId = boundedOptionalId(request.elicitationId, "elicitation.elicitationId")
  if (mode === "url" && (url === undefined || elicitationId === undefined)) {
    throw new ClaudeAgentSdkProtocolError("MCP URL elicitation requires a URL and elicitation id")
  }
  if (mode !== "url" && url !== undefined) throw new ClaudeAgentSdkProtocolError("MCP form elicitation must not carry a URL")
  const requestedSchema = request.requestedSchema === undefined
    ? undefined
    : boundedJsonObject(request.requestedSchema, "elicitation.requestedSchema")
  if (mode === "url" && requestedSchema !== undefined) {
    throw new ClaudeAgentSdkProtocolError("MCP URL elicitation must not carry a form schema")
  }
  if (mode !== "url" && elicitationId !== undefined) {
    throw new ClaudeAgentSdkProtocolError("MCP form elicitation must not carry a URL elicitation id")
  }
  if (mode !== "url") {
    if (requestedSchema === undefined) throw new ClaudeAgentSdkProtocolError("MCP form elicitation requires a requested schema")
    validateMcpFormSchema(requestedSchema)
  }
  const message = exactText(request.message, "elicitation.message", 8 * 1024)
  const title = optionalExactText(request.title, "elicitation.title", 8 * 1024)
  const displayName = optionalExactText(request.displayName, "elicitation.displayName", 2 * 1024)
  const description = optionalExactText(request.description, "elicitation.description", 8 * 1024)
  if (mode !== "url" && (
    [message, title, displayName, description].some((value) => value !== undefined && secretLikeLabel(value))
    || (requestedSchema !== undefined && schemaContainsSecretLikeField(requestedSchema))
  )) {
    throw new ClaudeAgentSdkProtocolError("Sensitive elicitation fields require MCP URL mode")
  }
  return {
    serverName: exactText(request.serverName, "elicitation.serverName", 512),
    message,
    mode,
    url,
    elicitationId,
    requestedSchema,
    title,
    displayName,
    description,
  }
}

function schemaContainsSecretLikeField(value: unknown): boolean {
  if (typeof value === "string") return secretLikeLabel(value)
  if (Array.isArray(value)) return value.some(schemaContainsSecretLikeField)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, entry]) => secretLikeLabel(key) || schemaContainsSecretLikeField(entry))
}

function validateMcpFormSchema(schema: Record<string, unknown>): void {
  assertOnlyKeys(schema, new Set(["$schema", "type", "properties", "required"]), "MCP form schema")
  if (schema.$schema !== undefined && typeof schema.$schema !== "string") {
    throw new ClaudeAgentSdkProtocolError("MCP form schema $schema must be text")
  }
  if (schema.type !== "object") throw new ClaudeAgentSdkProtocolError("MCP form schema must be a flat object")
  const properties = strictObject(schema.properties, "MCP form schema properties")
  const propertyEntries = Object.entries(properties)
  if (propertyEntries.length > 32) throw new ClaudeAgentSdkProtocolError("MCP form schema has too many fields")
  for (const [, rawField] of propertyEntries) validateMcpPrimitiveSchema(strictObject(rawField, "MCP form field"))

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.length > propertyEntries.length) {
      throw new ClaudeAgentSdkProtocolError("MCP form required fields are invalid")
    }
    const required = new Set<string>()
    for (const field of schema.required) {
      if (typeof field !== "string" || required.has(field) || !Object.hasOwn(properties, field)) {
        throw new ClaudeAgentSdkProtocolError("MCP form required fields are invalid")
      }
      required.add(field)
    }
  }
}

function validateMcpPrimitiveSchema(field: Record<string, unknown>): void {
  validateOptionalFieldText(field.title, "MCP form field title", 512)
  validateOptionalFieldText(field.description, "MCP form field description", 8 * 1024)
  if (field.type === "string") {
    if (field.enum !== undefined) {
      assertOnlyKeys(field, new Set(["type", "title", "description", "enum", "enumNames", "default"]), "MCP enum field")
      const values = nonEmptyUniqueStrings(field.enum, "MCP enum values")
      if (field.enumNames !== undefined) {
        const names = nonEmptyUniqueStrings(field.enumNames, "MCP enum names")
        if (names.length !== values.length) throw new ClaudeAgentSdkProtocolError("MCP enum names do not match its values")
      }
      if (field.default !== undefined && (typeof field.default !== "string" || !values.includes(field.default))) {
        throw new ClaudeAgentSdkProtocolError("MCP enum default is not advertised")
      }
      return
    }
    if (field.oneOf !== undefined) {
      assertOnlyKeys(field, new Set(["type", "title", "description", "oneOf", "default"]), "MCP titled enum field")
      const values = titledOptions(field.oneOf, "oneOf")
      if (field.default !== undefined && (typeof field.default !== "string" || !values.includes(field.default))) {
        throw new ClaudeAgentSdkProtocolError("MCP titled enum default is not advertised")
      }
      return
    }
    assertOnlyKeys(field, new Set(["type", "title", "description", "minLength", "maxLength", "format", "default"]), "MCP string field")
    const minimum = optionalBoundedInteger(field.minLength, "MCP string minLength", 4_000)
    const maximum = optionalBoundedInteger(field.maxLength, "MCP string maxLength", 4_000)
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new ClaudeAgentSdkProtocolError("MCP string minLength exceeds maxLength")
    }
    if (field.format !== undefined && !["email", "uri", "date", "date-time"].includes(String(field.format))) {
      throw new ClaudeAgentSdkProtocolError("MCP string format is unsupported")
    }
    if (field.default !== undefined) validateMcpFieldValue(field, field.default)
    return
  }
  if (field.type === "number" || field.type === "integer") {
    assertOnlyKeys(field, new Set(["type", "title", "description", "minimum", "maximum", "default"]), "MCP number field")
    const minimum = optionalFiniteNumber(field.minimum, "MCP number minimum")
    const maximum = optionalFiniteNumber(field.maximum, "MCP number maximum")
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new ClaudeAgentSdkProtocolError("MCP number minimum exceeds maximum")
    }
    if (field.default !== undefined) validateMcpFieldValue(field, field.default)
    return
  }
  if (field.type === "boolean") {
    assertOnlyKeys(field, new Set(["type", "title", "description", "default"]), "MCP boolean field")
    if (field.default !== undefined && typeof field.default !== "boolean") {
      throw new ClaudeAgentSdkProtocolError("MCP boolean default is invalid")
    }
    return
  }
  if (field.type === "array") {
    assertOnlyKeys(field, new Set(["type", "title", "description", "minItems", "maxItems", "items", "default"]), "MCP multi-select field")
    const minimum = optionalBoundedInteger(field.minItems, "MCP multi-select minItems", 32)
    const maximum = optionalBoundedInteger(field.maxItems, "MCP multi-select maxItems", 32)
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new ClaudeAgentSdkProtocolError("MCP multi-select minItems exceeds maxItems")
    }
    const items = strictObject(field.items, "MCP multi-select items")
    let values: string[]
    if (items.enum !== undefined) {
      assertOnlyKeys(items, new Set(["type", "enum"]), "MCP multi-select items")
      if (items.type !== "string") throw new ClaudeAgentSdkProtocolError("MCP multi-select items must be strings")
      values = nonEmptyUniqueStrings(items.enum, "MCP multi-select values")
    } else {
      assertOnlyKeys(items, new Set(["anyOf"]), "MCP titled multi-select items")
      values = titledOptions(items.anyOf, "anyOf")
    }
    if (field.default !== undefined) validateMcpMultiSelect(field.default, values, minimum, maximum)
    return
  }
  throw new ClaudeAgentSdkProtocolError("MCP form field type is unsupported")
}

function validateElicitationResponse(request: ClaudeElicitationRequest, result: ReturnType<typeof validateElicitationResult>): void {
  if (request.mode === "url") {
    if (result.action === "accept" && result.content !== undefined) {
      throw new ClaudeAgentSdkProtocolError("MCP URL elicitation response must not contain form content")
    }
    return
  }
  if (result.action !== "accept") return
  if (result.content === undefined) throw new ClaudeAgentSdkProtocolError("accepted MCP form elicitation requires content")
  const schema = request.requestedSchema!
  const properties = schema.properties as Record<string, Record<string, unknown>>
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : [])
  for (const key of Object.keys(result.content)) {
    if (!Object.hasOwn(properties, key)) throw new ClaudeAgentSdkProtocolError("MCP form response contains an unadvertised field")
  }
  for (const [key, field] of Object.entries(properties)) {
    const value = result.content[key]
    if (value === undefined) {
      if (required.has(key)) throw new ClaudeAgentSdkProtocolError("MCP form response is missing a required field")
      continue
    }
    validateMcpFieldValue(field, value)
  }
}

function validateMcpFieldValue(field: Record<string, unknown>, value: unknown): void {
  if (field.type === "string") {
    if (typeof value !== "string") throw new ClaudeAgentSdkProtocolError("MCP form response field must be text")
    if (Array.isArray(field.enum) && !(field.enum as unknown[]).includes(value)) {
      throw new ClaudeAgentSdkProtocolError("MCP form response contains an unadvertised option")
    }
    if (Array.isArray(field.oneOf) && !field.oneOf.some((entry) => strictObject(entry, "MCP titled option").const === value)) {
      throw new ClaudeAgentSdkProtocolError("MCP form response contains an unadvertised option")
    }
    if (typeof field.minLength === "number" && value.length < field.minLength) {
      throw new ClaudeAgentSdkProtocolError("MCP form response is shorter than minLength")
    }
    if (typeof field.maxLength === "number" && value.length > field.maxLength) {
      throw new ClaudeAgentSdkProtocolError("MCP form response is longer than maxLength")
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new ClaudeAgentSdkProtocolError("MCP form response is not an email address")
    }
    if (field.format === "uri") {
      try { new URL(value) } catch { throw new ClaudeAgentSdkProtocolError("MCP form response is not a URI") }
    }
    if (field.format === "date" && !validIsoDate(value)) throw new ClaudeAgentSdkProtocolError("MCP form response is not a date")
    if (field.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) {
      throw new ClaudeAgentSdkProtocolError("MCP form response is not a date-time")
    }
    return
  }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) {
      throw new ClaudeAgentSdkProtocolError("MCP form response number is invalid")
    }
    if (typeof field.minimum === "number" && value < field.minimum) throw new ClaudeAgentSdkProtocolError("MCP form response is below minimum")
    if (typeof field.maximum === "number" && value > field.maximum) throw new ClaudeAgentSdkProtocolError("MCP form response is above maximum")
    return
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new ClaudeAgentSdkProtocolError("MCP form response boolean is invalid")
    return
  }
  if (field.type === "array") {
    const items = field.items as Record<string, unknown>
    const values = Array.isArray(items.enum)
      ? items.enum as string[]
      : (items.anyOf as Array<Record<string, string>>).map((option) => option.const)
    validateMcpMultiSelect(value, values, field.minItems as number | undefined, field.maxItems as number | undefined)
    return
  }
  throw new ClaudeAgentSdkProtocolError("MCP form response field type is unsupported")
}

function validateMcpMultiSelect(value: unknown, advertised: string[], minimum?: number, maximum?: number): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ClaudeAgentSdkProtocolError("MCP form multi-select response is invalid")
  }
  const values = value as string[]
  if (new Set(values).size !== values.length || values.some((entry) => !advertised.includes(entry))) {
    throw new ClaudeAgentSdkProtocolError("MCP form multi-select response contains an unadvertised option")
  }
  if (minimum !== undefined && values.length < minimum) throw new ClaudeAgentSdkProtocolError("MCP form multi-select response has too few items")
  if (maximum !== undefined && values.length > maximum) throw new ClaudeAgentSdkProtocolError("MCP form multi-select response has too many items")
}

function strictObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClaudeAgentSdkProtocolError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ClaudeAgentSdkProtocolError(`${label} contains unsupported fields`)
}

function validateOptionalFieldText(value: unknown, label: string, maxBytes: number): void {
  if (value !== undefined) exactText(value, label, maxBytes)
}

function optionalBoundedInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum) {
    throw new ClaudeAgentSdkProtocolError(`${label} is invalid`)
  }
  return value
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ClaudeAgentSdkProtocolError(`${label} is invalid`)
  return value
}

function nonEmptyUniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 || value.some((entry) => typeof entry !== "string")) {
    throw new ClaudeAgentSdkProtocolError(`${label} are invalid`)
  }
  const values = value as string[]
  if (new Set(values).size !== values.length) throw new ClaudeAgentSdkProtocolError(`${label} contain duplicates`)
  return values
}

function titledOptions(value: unknown, keyword: "oneOf" | "anyOf"): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new ClaudeAgentSdkProtocolError(`MCP ${keyword} options are invalid`)
  const values = value.map((raw) => {
    const option = strictObject(raw, `MCP ${keyword} option`)
    assertOnlyKeys(option, new Set(["const", "title"]), `MCP ${keyword} option`)
    if (typeof option.const !== "string") throw new ClaudeAgentSdkProtocolError(`MCP ${keyword} option value is invalid`)
    exactText(option.title, `MCP ${keyword} option title`, 512)
    return option.const
  })
  if (new Set(values).size !== values.length) throw new ClaudeAgentSdkProtocolError(`MCP ${keyword} options contain duplicates`)
  return values
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function secretLikeLabel(value: string): boolean {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const joined = words.join("")
  return words.some((word) => [
    "auth",
    "authorization",
    "authenticator",
    "bearer",
    "cookie",
    "credential",
    "cvv",
    "otp",
    "passphrase",
    "passwd",
    "password",
    "pin",
    "recovery",
    "secret",
    "sensitive",
    "ssn",
    "token",
  ].includes(word))
    || ["apikey", "privatekey", "accesskey", "clientsecret", "securitycode", "onetimepassword", "writeonly"].some((marker) => joined.includes(marker))
}

// The `system` subtypes that carry SUB-AGENT / BACKGROUND-TASK lifecycle, and the phase each maps to.
// Everything here used to collapse into `kind:"other"` (type + subtype, payload dropped on the floor),
// which is precisely why the tailer has to reconstruct child lifecycle from English prose. See
// ClaudeTaskEvent for the probe that established these are stream-only.
const TASK_PHASES: Record<string, ClaudeTaskEvent["phase"]> = {
  task_started: "started",
  task_updated: "updated",
  task_progress: "progress",
  task_notification: "notification",
  background_tasks_changed: "level",
}

function mapSdkMessage(message: SDKMessage): ClaudeQueryEvent {
  const raw = message as unknown as Record<string, unknown>
  const type = safeText(raw.type, "event.type", 256)
  if (type === "system" && raw.subtype === "init") return mapSessionInit(raw)
  if (type === "system" && typeof raw.subtype === "string" && TASK_PHASES[raw.subtype]) {
    // Belt AND braces. mapTask degrades every field internally, so this catch should be unreachable —
    // but "should be unreachable" is exactly what was believed about mapAssistant on 2026-07-26, and a
    // day later one control character in a Bash command took down a multi-hour thread. A telemetry
    // frame falling back to the old `other` shape costs a progress line; it must never cost a session.
    try {
      return mapTask(raw, TASK_PHASES[raw.subtype]!)
    } catch {
      // fall through to the generic `other` mapping below
    }
  }
  if (type === "assistant") return mapAssistant(raw)
  if (type === "user") return mapUser(raw)
  if (type === "result") return mapResult(raw)
  if (type === "prompt_suggestion") {
    return {
      kind: "prompt-suggestion",
      sessionId: boundedId(raw.session_id, "promptSuggestion.sessionId"),
      messageId: boundedId(raw.uuid, "promptSuggestion.messageId"),
      suggestion: safeText(raw.suggestion, "promptSuggestion.suggestion"),
    }
  }
  return {
    kind: "other",
    type,
    subtype: optionalText(raw.subtype, "event.subtype", 256),
    sessionId: boundedOptionalId(raw.session_id, "event.sessionId"),
    messageId: boundedOptionalId(raw.uuid, "event.messageId"),
  }
}

/** Read a value, or fall back — never let an informational field cost the frame it rides on. */
function softList<T>(read: () => T[], fallback: T[]): T[] { try { return read() } catch { return fallback } }

/** Read a value, or report ABSENT. The degrade primitive for wholly informational fields. */
function softValue<T>(read: () => T): T | undefined { try { return read() } catch { return undefined } }

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Exported as a test seam for the same reason `mapAssistant` is: the degrade-don't-throw contract is
 * what keeps a malformed telemetry frame from killing an operator's session.
 *
 * NOTHING in this mapper is allowed to throw. Every value it reads is INFORMATIONAL — a description, a
 * tool name, a token count, a summary — and the child's real work has already happened either way. The
 * strict validators still run (they are what bounds what reaches the wire); a rejection just drops
 * that ONE field to `undefined` instead of taking the frame, and therefore the session, down with it.
 *
 * Note the deliberate absence of `boundedId`. A task id / tool_use id whose shape frizz's opaque-id
 * pattern rejects costs this event its CORRELATION — the board shows an unenriched child — and not one
 * thing more. `boundedId` throws, so it must not be on this path.
 */
export function mapTask(raw: Record<string, unknown>, phase: ClaudeTaskEvent["phase"]): ClaudeTaskEvent {
  // `task_updated` carries its changes under `patch` rather than at the top level; read both so one
  // shape of field lookup covers every subtype.
  const patch = softValue(() => objectValue(raw.patch, "task.patch")) ?? {}
  const usageRaw = softValue(() => objectValue(raw.usage, "task.usage"))
  const usage: ClaudeTaskUsage | undefined = usageRaw
    ? {
        totalTokens: finiteNumber(usageRaw.total_tokens),
        toolUses: finiteNumber(usageRaw.tool_uses),
        durationMs: finiteNumber(usageRaw.duration_ms),
      }
    : undefined
  // The REPLACE-semantics live set. Bounded hard: this is the one repeated-structure field here, and
  // an unbounded provider array is how a telemetry channel becomes a memory problem.
  const tasks = phase !== "level" ? undefined : softValue(() =>
    boundedArray(raw.tasks, "task.tasks", 256).map((entry, index) => {
      const item = objectValue(entry, `task.tasks[${index}]`)
      return {
        taskId: safeText(item.task_id, `task.tasks[${index}].task_id`, 512),
        taskType: optionalText(item.task_type, `task.tasks[${index}].task_type`, 512),
        description: optionalText(item.description, `task.tasks[${index}].description`, 4 * 1024),
      }
    }))
  return {
    kind: "task",
    phase,
    sessionId: softValue(() => boundedOptionalId(raw.session_id, "task.sessionId")),
    messageId: softValue(() => boundedOptionalId(raw.uuid, "task.messageId")),
    taskId: softValue(() => optionalText(raw.task_id, "task.taskId", 512)),
    toolUseId: softValue(() => optionalText(raw.tool_use_id, "task.toolUseId", 512)),
    description: softValue(() => optionalText(raw.description ?? patch.description, "task.description", 4 * 1024)),
    status: softValue(() => optionalText(raw.status ?? patch.status, "task.status", 256)),
    summary: softValue(() => optionalText(raw.summary, "task.summary", 8 * 1024)),
    lastToolName: softValue(() => optionalText(raw.last_tool_name, "task.lastToolName", 512)),
    subagentType: softValue(() => optionalText(raw.subagent_type, "task.subagentType", 512)),
    taskType: softValue(() => optionalText(raw.task_type, "task.taskType", 512)),
    outputFile: softValue(() => optionalText(raw.output_file, "task.outputFile", 8 * 1024)),
    error: softValue(() => optionalText(patch.error, "task.error", 4 * 1024)),
    ...(usage ? { usage } : {}),
    ...(tasks ? { tasks } : {}),
  }
}

function mapSessionInit(raw: Record<string, unknown>): ClaudeSessionInitEvent {
  // Informational too — degrade rather than lose the frame (see the note on the return below).
  const mcpServers = softList(() => boundedArray(raw.mcp_servers, "init.mcpServers", 512).map((entry, index) => {
    const object = objectValue(entry, `init.mcpServers[${index}]`)
    return {
      name: safeText(object.name, `init.mcpServers[${index}].name`, 512),
      status: safeText(object.status, `init.mcpServers[${index}].status`, 512),
    }
  }), [])
  const plugins = softList(() => boundedArray(raw.plugins, "init.plugins", 512).map((entry, index) => {
    const object = objectValue(entry, `init.plugins[${index}]`)
    return {
      name: safeText(object.name, `init.plugins[${index}].name`, 512),
      path: safeText(object.path, `init.plugins[${index}].path`, 8 * 1024),
    }
  }), [])
  // `init` is the ONE frame that must never be dropped: the ownership state machine is built on it, so
  // a session that loses it dies at birth — the next event trips "non-init event before session
  // ownership", which fails the output and closes the query. Dropping it therefore costs the whole
  // session AND misattributes the cause, because the accurate message is one log line earlier.
  //
  // So exactly one field stays strict: `sessionId`, which is what ownership is checked against and the
  // only field where a wrong value would be unsafe. Everything else here is INFORMATIONAL — a version
  // string, a tool list, a mode name — and is degraded rather than allowed to take the session down.
  //
  // Two triggers were proven against the real daemon before this was written, each with a one-variable
  // control: `init.tools` of 129 entries (the default boundedStringArray cap is 128, and frizz dispatches
  // into arbitrary repos where one MCP server of the Neon/better-stack size clears it on its own), and a
  // permissionMode string outside the six frizz currently knows — `dontAsk` and `auto` are recent
  // additions to that list, so the NEXT one claude ships would otherwise be a fleet-wide outage on
  // upgrade. That is the same failure mode as the codex version pin, on the Claude side.
  const soft = <T,>(read: () => T, fallback: T): T => { try { return read() } catch { return fallback } }
  return {
    kind: "init",
    protocolVersion: CLAUDE_AGENT_SDK_PROTOCOL_VERSION,
    sessionId: boundedId(raw.session_id, "init.sessionId"), // ownership — strict on purpose
    messageId: soft(() => boundedId(raw.uuid, "init.messageId"), ""),
    claudeCodeVersion: soft(() => safeText(raw.claude_code_version, "init.claudeCodeVersion", 512), ""),
    cwd: soft(() => safeText(raw.cwd, "init.cwd", 8 * 1024), ""),
    model: soft(() => safeText(raw.model, "init.model", 512), ""),
    // An unknown mode reports as "default" rather than killing the session. frizz never ACTS on this
    // value — it sends the mode it wants; this is the provider's echo, for display.
    permissionMode: soft(() => validatePermissionMode(raw.permissionMode), "default"),
    tools: soft(() => boundedStringArray(raw.tools, "init.tools", 4096), []),
    mcpServers,
    slashCommands: soft(() => boundedStringArray(raw.slash_commands, "init.slashCommands", 1024), []),
    skills: soft(() => boundedStringArray(raw.skills, "init.skills", 1024), []),
    plugins,
    capabilities: raw.capabilities === undefined ? [] : soft(() => boundedStringArray(raw.capabilities, "init.capabilities", 1024), []),
  }
}

/** Exported as a test seam: the degrade-don't-throw contract below is load-bearing for session survival. */
export function mapAssistant(raw: Record<string, unknown>): ClaudeQueryEvent {
  const apiMessage = objectValue(raw.message, "assistant.message")
  const blocks = boundedArray(apiMessage.content, "assistant.content", 64)
  const text: string[] = []
  const toolUses: Array<{ id: string; name: string; input: ReturnType<typeof boundedJsonObject> }> = []
  let textBytes = 0
  for (const [index, entry] of blocks.entries()) {
    const block = objectValue(entry, `assistant.content[${index}]`)
    if (block.type === "text") {
      const value = safeText(block.text, `assistant.content[${index}].text`)
      textBytes += utf8Bytes(value)
      if (textBytes > CLAUDE_AGENT_SDK_MAX_EVENT_TEXT_BYTES) throw new ClaudeAgentSdkProtocolError("assistant text exceeds its aggregate limit")
      text.push(value)
    } else if (block.type === "tool_use") {
      // A tool input frizz cannot REPRESENT must never be a fatal error. This is outbound TELEMETRY —
      // frizz's own view of what the agent is doing — and the agent's actual tool call has already been
      // made either way. Throwing here propagates out of the event iterator, and the broker daemon's
      // pump treats any iterator error as terminal (claude-agent-broker.ts), so it kills the daemon,
      // the `claude` process, and every in-flight sub-agent with it.
      //
      // That is not hypothetical. Live, 2026-07-27 07:03:55, on a multi-hour orchestrator thread:
      //   lifecycle:crashed "assistant.content[0].input.command contains unsafe text"
      // A single control character inside a Bash `command` — trivially reachable the moment an agent
      // echoes terminal output, writes an ANSI escape, or handles binary — destroyed the whole thread
      // and all of its sub-agents. The operator saw a frozen card with no explanation.
      //
      // So: keep the strict validator (it is what stops unbounded/unsafe values reaching the wire),
      // but on rejection emit the tool call with a PLACEHOLDER input rather than taking the session
      // down. The id and name still identify the call; only the arguments degrade. This is the same
      // "parse defensively, degrade to unknown, never throw" discipline the tailer already documents.
      let input: ReturnType<typeof boundedJsonObject>
      try {
        input = boundedJsonObject(block.input, `assistant.content[${index}].input`)
      } catch (error) {
        input = { __frizzUnrepresentable: error instanceof Error ? safeText(error.message, "unrepresentable", 512) : "tool input could not be represented" }
      }
      toolUses.push({
        id: boundedId(block.id, `assistant.content[${index}].id`),
        name: safeText(block.name, `assistant.content[${index}].name`, 512),
        input,
      })
    }
  }
  return {
    kind: "assistant",
    sessionId: boundedId(raw.session_id, "assistant.sessionId"),
    messageId: boundedId(raw.uuid, "assistant.messageId"),
    parentToolUseId: boundedOptionalId(raw.parent_tool_use_id, "assistant.parentToolUseId"),
    text,
    toolUses,
    supersedes: raw.supersedes === undefined ? [] : boundedStringArray(raw.supersedes, "assistant.supersedes", 128).map((id, index) => boundedId(id, `assistant.supersedes[${index}]`)),
  }
}

function mapUser(raw: Record<string, unknown>): ClaudeQueryEvent {
  const apiMessage = objectValue(raw.message, "user.message")
  const content = apiMessage.content
  const text: string[] = []
  const toolResultIds: string[] = []
  let textBytes = 0
  if (typeof content === "string") {
    const value = safeText(content, "user.content")
    textBytes = utf8Bytes(value)
    text.push(value)
  }
  else {
    for (const [index, entry] of boundedArray(content, "user.content", 64).entries()) {
      const block = objectValue(entry, `user.content[${index}]`)
      if (block.type === "text") {
        const value = safeText(block.text, `user.content[${index}].text`)
        textBytes += utf8Bytes(value)
        if (textBytes > CLAUDE_AGENT_SDK_MAX_EVENT_TEXT_BYTES) {
          throw new ClaudeAgentSdkProtocolError("user text exceeds its aggregate limit")
        }
        text.push(value)
      }
      if (block.type === "tool_result") toolResultIds.push(boundedId(block.tool_use_id, `user.content[${index}].toolUseId`))
    }
  }
  return {
    kind: "user",
    sessionId: boundedOptionalId(raw.session_id, "user.sessionId"),
    messageId: boundedOptionalId(raw.uuid, "user.messageId"),
    parentToolUseId: boundedOptionalId(raw.parent_tool_use_id, "user.parentToolUseId"),
    text,
    toolResultIds,
    synthetic: raw.isSynthetic === true,
  }
}

function mapResult(raw: Record<string, unknown>): ClaudeQueryEvent {
  const subtype = safeText(raw.subtype, "result.subtype", 256)
  if (!["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"].includes(subtype)) {
    throw new ClaudeAgentSdkProtocolError("result subtype is unsupported")
  }
  const windows = mapModelContextWindows(raw.modelUsage)
  return {
    kind: "result",
    sessionId: boundedId(raw.session_id, "result.sessionId"),
    messageId: boundedId(raw.uuid, "result.messageId"),
    subtype: subtype as "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries",
    isError: raw.is_error === true,
    stopReason: optionalText(raw.stop_reason, "result.stopReason", 512),
    result: optionalText(raw.result, "result.result", CLAUDE_AGENT_SDK_MAX_EVENT_TEXT_BYTES),
    errors: raw.errors === undefined ? [] : boundedStringArray(raw.errors, "result.errors", 32, 8 * 1024),
    ...(windows === undefined ? {} : { modelContextWindows: windows }),
  }
}

// `modelUsage` → {alias: contextWindow}, defensively. Everything here degrades to "no reading": this
// is the footer's denominator, and a malformed/absent field must cost the readout, never the result
// event (mapAssistant's incident note is the standing rule — a telemetry field may not kill a session).
// Bounded at 32 aliases so a pathological payload cannot grow the per-turn event.
function mapModelContextWindows(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  let count = 0
  for (const [alias, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 32) break
    if (!entry || typeof entry !== "object") continue
    const value = (entry as Record<string, unknown>).contextWindow
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue
    let key: string
    try {
      key = safeText(alias, "result.modelUsage.alias", 256)
    } catch {
      continue
    }
    out[key] = value
    count += 1
  }
  return count === 0 ? undefined : out
}

// Claude appends its own source to a skill's description as a trailing parenthetical — measured on
// 2.1.246, ` (user)` on 24 of 77 commands and ` (project)` on 6. Once frizz renders the source as its
// own column that suffix is not just redundant but CONTRADICTORY, because the column says "global"
// where the sentence says "(user)".
//
// Dropped only when the suffix and the source frizz is about to render are the SAME claim — the
// parenthetical must match the very root `getContextUsage` reported for that skill. That is what makes
// this safe where a bare regex is not: `/deep-research` ends "(dynamic workflow)" and `/fast` ends
// "(Opus 4.8)", and neither is a source, so neither can match. The one measured case where the two
// disagree — a plugin skill whose description still ends "(user)" — keeps its text untouched, which is
// the right answer for a claim frizz cannot confirm.
const CLAUDE_SOURCE_SUFFIX: Partial<Record<ThreadSkillSource, string>> = { user: " (user)", project: " (project)" }
function withoutRedundantSource(description: string, source: ThreadSkillSource | undefined): string {
  const suffix = source && CLAUDE_SOURCE_SUFFIX[source]
  if (!suffix || !description.endsWith(suffix)) return description
  return description.slice(0, -suffix.length).trimEnd()
}

// Claude's skill-source vocabulary → frizz's. Measured against claude 2.1.246 / SDK 0.3.207, where
// `getContextUsage().skills.skillFrontmatter[].source` reported exactly these four across 48 skills.
// Anything else answers undefined, so a CLI that grows a fifth root leaves the row unlabelled rather
// than mislabelled — which is the whole point of the source being optional on the wire.
function claudeSkillSource(source: string): ThreadSkillSource | undefined {
  if (source === "projectSettings") return "project"
  if (source === "userSettings") return "user"
  if (source === "built-in") return "builtin"
  if (source === "plugin") return "plugin"
  return undefined
}

function mapControlInitialization(raw: SDKControlInitializeResponse): ClaudeControlInitialization {
  const commands: ClaudeCommandCapability[] = boundedArray(raw.commands, "initialization.commands", 256).map((entry, index) => {
    const command = objectValue(entry, `initialization.commands[${index}]`)
    return {
      name: safeText(command.name, `initialization.commands[${index}].name`, 512),
      description: safeText(command.description, `initialization.commands[${index}].description`, 4 * 1024),
      argumentHint: safeText(command.argumentHint, `initialization.commands[${index}].argumentHint`, 2 * 1024),
      aliases: command.aliases === undefined ? [] : boundedStringArray(command.aliases, `initialization.commands[${index}].aliases`, 32),
    }
  })
  // The init `agents` array shape varies by claude version: newer builds emit a bare string per agent
  // name (e.g. "frizz:haiku"), older ones an object {name, description, model}. Handle both, or a
  // string-shaped build silently reports 16 empty-name agents (which is exactly what masked the loaded
  // frizz sub-agent profiles during the broker worker-environment bring-up).
  const agents: ClaudeAgentCapability[] = boundedArray(raw.agents, "initialization.agents", 128).map((entry, index) => {
    if (typeof entry === "string") {
      return { name: safeText(entry, `initialization.agents[${index}]`, 512), description: "", model: undefined }
    }
    const agent = objectValue(entry, `initialization.agents[${index}]`)
    return {
      name: safeText(agent.name, `initialization.agents[${index}].name`, 512),
      description: safeText(agent.description, `initialization.agents[${index}].description`, 4 * 1024),
      model: optionalText(agent.model, `initialization.agents[${index}].model`, 512),
    }
  })
  const models: ClaudeModelCapability[] = boundedArray(raw.models, "initialization.models", 128).map((entry, index) => {
    const model = objectValue(entry, `initialization.models[${index}]`)
    return {
      value: safeText(model.value, `initialization.models[${index}].value`, 512),
      resolvedModel: optionalText(model.resolvedModel, `initialization.models[${index}].resolvedModel`, 512),
      displayName: safeText(model.displayName, `initialization.models[${index}].displayName`, 512),
      description: safeText(model.description, `initialization.models[${index}].description`, 4 * 1024),
      supportsEffort: model.supportsEffort === true,
      supportedEffortLevels: model.supportedEffortLevels === undefined ? [] : boundedStringArray(model.supportedEffortLevels, `initialization.models[${index}].supportedEffortLevels`, 8),
      supportsAdaptiveThinking: model.supportsAdaptiveThinking === true,
      supportsFastMode: model.supportsFastMode === true,
    }
  })
  return {
    commands,
    agents,
    outputStyle: safeText(raw.output_style, "initialization.outputStyle", 512),
    availableOutputStyles: boundedStringArray(raw.available_output_styles, "initialization.availableOutputStyles", 64),
    models,
  }
}

function buildEnvironment(overrides: Readonly<Record<string, string | undefined>> | undefined): Record<string, string | undefined> {
  // Inherit frizz's environment minus frizz's own control plane — see worker-env.ts for why this is a
  // denylist rather than the allowlist it replaced. The caps below DEGRADE (skip the offending entry)
  // instead of throwing: this runs inside the broker daemon during startup, and a throw here kills it
  // before it publishes its record, which the operator sees only as every dispatch timing out "did not
  // become ready". A fat shell environment must not be able to do that.
  const env: Record<string, string | undefined> = {}
  let budget = MAX_ENV_TOTAL_BYTES
  for (const [key, value] of Object.entries(inheritWorkerEnvironment())) {
    if (utf8Bytes(value) > MAX_ENV_VALUE_BYTES) continue
    if (Object.keys(env).length >= MAX_ENV_ENTRIES) break
    const cost = utf8Bytes(key) + utf8Bytes(value)
    if (cost > budget) continue
    budget -= cost
    env[key] = value
  }
  // Frizz's OWN overrides are applied unconditionally and after the caps: they are a bounded handful
  // (the plugin dir, this thread's slug, the perm dir) and a worker that silently lost one is broken in
  // ways far harder to diagnose than a dropped ambient variable. A malformed KEY still throws — that is
  // a frizz bug, not operator input, and it should be loud.
  const overrideEntries = Object.entries(overrides ?? {})
  if (overrideEntries.length > MAX_ENV_ENTRIES) throw new ClaudeAgentSdkProtocolError("Claude environment has too many overrides")
  for (const [key, value] of overrideEntries) {
    if (!ENV_KEY_PATTERN.test(key)) throw new ClaudeAgentSdkProtocolError("Claude environment contains an invalid key")
    if (value === undefined) delete env[key]
    else {
      if (typeof value !== "string") throw new ClaudeAgentSdkProtocolError("Claude environment value must be text")
      if (utf8Bytes(value) > MAX_ENV_VALUE_BYTES) throw new ClaudeAgentSdkProtocolError("Claude environment value is too large")
      // Very short credential values are invalid in practice and cannot be safely substituted in
      // diagnostics without turning common one-character strings into an amplification vector.
      if (SENSITIVE_ENV_KEY.test(key) && value.length > 0 && value.length < 4) {
        throw new ClaudeAgentSdkProtocolError("Claude sensitive environment value is too short")
      }
      env[key] = value
    }
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = CLAUDE_AGENT_SDK_CLIENT_APP
  return env
}

// The SDK strips NODE_OPTIONS before it spawns Claude, but Nub's temporary `node` shim can
// reconstruct its loader flags when a provider executable uses `#!/usr/bin/env node`. Provider
// children must not receive either form of host runtime injection.
//
// MATCHED WITHOUT CASE, because Windows environment variables are case-INSENSITIVE and it spells the
// search path `Path`. Only `process.env` itself emulates that; the plain object buildEnvironment()
// copies out of it does not, so `sanitized.PATH` read `undefined` on win32 and the shim filter below
// silently did nothing — leaving nub's shim first on the child's PATH, where it rebuilds NODE_OPTIONS
// for anything spawned as a bare `node`. That is exactly how the Agent SDK launches a script provider
// executable (`executable: "node"`, resolved through PATH), and it is what the fake-CLI fixture saw as
// `nodeOptionsPresent: true` on the first Windows suite run (2026-08-24).
export function sanitizeProviderChildEnvironment(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  const sanitized = { ...environment }
  for (const key of Object.keys(sanitized)) {
    if (/^NODE_OPTIONS$/i.test(key)) {
      delete sanitized[key]
      continue
    }
    // Rewritten under the key the OS actually gave us: adding a second "PATH" beside a "Path" would
    // hand the child two search paths and let the wrong one win.
    const value = sanitized[key]
    if (/^PATH$/i.test(key) && value !== undefined) {
      sanitized[key] = value
        .split(delimiter)
        .filter((entry) => !NUB_NODE_SHIM_PATH_SEGMENT.test(entry))
        .join(delimiter)
    }
  }
  return sanitized
}

export function createClaudeDiagnosticRedactor(
  env: Record<string, string | undefined>,
): (value: unknown) => { message: string; truncated: boolean } {
  const secrets = Object.entries(env)
    .filter(([key, value]) => SENSITIVE_ENV_KEY.test(key) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length)
  return (value) => {
    let raw: string
    try {
      raw = value instanceof Error ? value.message : String(value)
    } catch {
      raw = "unprintable provider diagnostic"
    }
    // Bound provider-controlled diagnostics before applying replacement patterns so a single
    // pathological thrown value cannot turn error normalization into an unbounded CPU operation.
    const oversizedInput = utf8Bytes(raw) > CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES * 4
    let redacted = redactCredentialSyntax(
      safeText(raw, "diagnostic", CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES * 4),
      { replacement: "[REDACTED]" },
    )
    for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]")
    redacted = redacted
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-ant-[A-Za-z0-9_-]+/gi, "[REDACTED]")
      .replace(/([?&](?:api[_-]?key|auth|password|secret|token)=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/("(?:api[_-]?key|auth|password|secret|token)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
      .replace(/\b((?:api[_-]?key|auth|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    const truncated = oversizedInput || utf8Bytes(redacted) > CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES
    return { message: safeText(redacted, "diagnostic", CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES), truncated }
  }
}

function canonicalFingerprint(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalFingerprint).join(",")}]`
  if (value && typeof value === "object") {
    const fields = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalFingerprint(entry)}`)
    return `{${fields.join(",")}}`
  }
  throw new ClaudeAgentSdkProtocolError("Claude request fingerprint contains a non-JSON value")
}

function abortableCallback<T>(promise: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new ClaudeAgentSdkProtocolError(`${label} aborted`))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ClaudeAgentSdkProtocolError(`${label} aborted`))
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

function guardDiagnosticCallback(
  callback: ((event: ClaudeDiagnostic) => void) | undefined,
): ((event: ClaudeDiagnostic) => void) | undefined {
  if (!callback) return undefined
  return (event) => {
    try {
      callback(event)
    } catch {
      // Diagnostics are observational and must never gain control over the provider lifecycle.
    }
  }
}

function validateExecutablePath(value: string): string {
  const path = validateAbsolutePath(value, "executablePath")
  try {
    accessSync(path, fsConstants.X_OK)
  } catch {
    throw new ClaudeAgentSdkProtocolError("Claude executable is not executable")
  }
  return path
}

function validateAbsolutePath(value: unknown, label: string): string {
  const path = exactText(value, label, 8 * 1024)
  if (!isAbsolute(path)) throw new ClaudeAgentSdkProtocolError(`${label} must be absolute`)
  return path
}

function validateSessionId(value: unknown): string {
  const id = boundedId(value, "sessionId")
  if (!UUID_PATTERN.test(id)) throw new ClaudeAgentSdkProtocolError("sessionId must be a UUID")
  return id
}

function validateElicitationUrl(value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ClaudeAgentSdkProtocolError("elicitation URL is invalid")
  }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)
  if (parsed.protocol !== "https:" && !localHttp) throw new ClaudeAgentSdkProtocolError("elicitation URL must use HTTPS")
  if (parsed.username || parsed.password) throw new ClaudeAgentSdkProtocolError("elicitation URL must not contain credentials")
}

function optionalText(value: unknown, label: string, maxBytes: number): string | undefined {
  return value === undefined || value === null ? undefined : safeText(value, label, maxBytes)
}

function optionalExactText(value: unknown, label: string, maxBytes: number): string | undefined {
  return value === undefined || value === null ? undefined : exactText(value, label, maxBytes)
}

function exactText(value: unknown, label: string, maxBytes: number): string {
  const text = safeText(value, label, maxBytes)
  if (text !== value) throw new ClaudeAgentSdkProtocolError(`${label} contains unsafe or oversized text`)
  return text
}

function boundedArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new ClaudeAgentSdkProtocolError(`${label} must be a bounded list`)
  return value
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClaudeAgentSdkProtocolError(`${label} must be an object`)
  return value as Record<string, unknown>
}
