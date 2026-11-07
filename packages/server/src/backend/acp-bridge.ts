import { INTERACTION_PROTOCOL_VERSION, InteractionRequest, type InteractionRequest as InteractionRequestType } from "@frizz/shared"
import type { InteractionSessionScope, InteractionStore } from "../interaction-store.ts"
import { redactCredentialSyntax } from "../credential-redaction.ts"
import { log } from "../logging.ts"
import { acpAgentSpecs, resolveAcpAgent, type AcpAgentInput, type AcpAgentSpec, type ResolvedAcpAgent } from "./acp-agents.ts"
import { AcpConnection, AcpConnectionClosed, AcpRemoteError, AcpRequestError, spawnAcpChild, type AcpSpawn } from "./acp-rpc.ts"
import { daemonAcpHost, directAcpHost, liveAcpDaemonRecord, stopAcpDaemon, type AcpHost } from "./acp-host.ts"
import { AcpTranscriptWriter, acpContractOwed, acpTranscriptPath, type AcpContractReason, type AcpRecord } from "./acp-transcript.ts"
import {
  ACP_ERROR_AUTH_REQUIRED, ACP_ERROR_INTERNAL, ACP_ERROR_METHOD_NOT_FOUND, ACP_PROTOCOL_VERSION,
  AcpInitializeResult, AcpLoadSessionResult, AcpNewSessionResult, AcpPromptResult, AcpRequestPermissionParams, AcpSessionNotification, AcpSetConfigOptionResult, type AcpConfigOption,
  contentText, isAcpChildUpdate, parseSessionUpdate,
  type AcpInitializeResult as AcpInitializeResultType, type AcpMcpServerStdio, type AcpRequestPermissionResult, type AcpToolCallUpdate,
} from "./acp-types.ts"
import { FRIZZ_MCP, frizzCliEnv, frizzMcpEnv, withFrizzCliOnPath, type FrizzCli, type FrizzMcp } from "./types.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"
import { frizzGithubWorkerEnv } from "../github-credential.ts"
import type { AcpAgentModels } from "@frizz/shared"

// The ACP backend's bridge: one live agent child per thread, driven over acp-rpc.ts, writing the
// thread's transcript through acp-transcript.ts. It is the third of three transports and deliberately
// the shallowest (plans/acp-backend.md): no daemon, no sub-agents, no quota, no steer.
//
// What it owns per session:
//   - the child (spawn → initialize → session/new or session/load with the frizz MCP server mounted);
//   - the turn: `session/prompt` is long-lived and its response IS the end of the turn, so exactly one
//     is in flight at a time and a follow-up that arrives mid-turn QUEUES and goes out the moment the
//     current one returns (ACP has no steer; plan decision 8);
//   - the transcript: every `session/update` becomes a NormalizedEvent record the tailer folds and the
//     drawer projects, with text buffered and flushed as whole blocks rather than per token;
//   - permission cards: `session/request_permission` → an InteractionRequest, answered when the operator
//     resolves it and CANCELLED (fail closed) when the turn ends, the session is released or nobody can
//     answer — the Claude bridge's contract, because a card nothing terminalizes never leaves the queue.
//
// The agent runs inside a DETACHED DAEMON (acp-daemon.ts, attached through acp-host.ts), so a Frizz
// restart or crash only drops the socket: the agent, its running turn and every sub-agent inside it keep
// going, and `warmUp()` reattaches at the next boot — adopting the in-flight `session/prompt` as the live
// turn and raising afresh any permission card the dead runtime was holding. Until 2026-09-24 the agent
// was a plain child whose stdin closed with the server, and a running turn died with it; that was the
// stated difference from the broker and the app-server, and it is gone. A session whose daemon has
// actually died is re-opened on the next input: `session/load` when the agent advertised `loadSession`,
// else a fresh session with a transcript note saying so.
//
// The worker contract rides a PROMPT, because ACP has no system-prompt channel, so the session holds it
// only as long as its history does. Two things end that, and after either the next prompt carries the
// contract again (`contractFor`, prepended once, recorded as an `acp-contract` record):
//   - the agent COMPACTS. Measured 2026-10-12 against opencode 2.0.27 with a recording fake model: the
//     request after `/compact` was `[system][checkpoint summary][new message]`, the contract gone, and
//     opencode's summary prompt asks the model to leave out "instructions and setup the assistant was
//     given". A compaction in the middle of a turn is answered at the turn after it: ACP has no steer.
//   - a FRESH session replaces one the agent could not load. It has no history at all.

export interface AcpBridgeOptions {
  projectId: string
  stateDir: string
  /** The frizz MCP descriptor; absent ⇒ the worker simply lacks the frizz tools. */
  frizzMcp?: FrizzMcp
  /** Which threads get that mount. Absent ⇒ every thread. An ACP thread's contract is its first prompt,
   *  so one started under the `frizzctl` contract is given no MCP server, and one that predates it
   *  keeps the server it was told about at every re-open. */
  mountsMcp?: (threadSlug: string) => boolean
  /** Present ⇒ the agent's shell can run `frizzctl`: its directory goes on PATH and the agent's
   *  environment names the server, the project and — one daemon per thread — the calling thread. */
  frizzCli?: FrizzCli
  interactions?: InteractionStore
  /** The operator's environment; filtered through inheritWorkerEnvironment before the child sees it. */
  env?: NodeJS.ProcessEnv
  /** The operator's own agent entries (settings.acpAgents), re-read on every spawn. */
  customAgents?: () => readonly AcpAgentInput[] | undefined
  /** Test seam: a plain child per open, no daemon, no reattach (wrapped as `directAcpHost`). */
  spawn?: AcpSpawn
  /** How an agent process is obtained. Default: the detached daemon host (`daemonAcpHost`). */
  host?: AcpHost
  onDiagnostic?: (d: { threadSlug: string; kind: string; message: string }) => void
  /** The worker contract for a thread (dispatch.ts `acpWorkerContract`), sent again when the session has
   *  lost it — see the header. Absent ⇒ nothing is re-sent, which is what the tests that predate it get. */
  contractFor?: (threadSlug: string, sessionId: string) => string | undefined
  /** Called whenever a turn starts or ends, so the board can refresh without polling. */
  onStatusChange?: () => void
  now?: () => Date
  initializeTimeoutMs?: number
  /** How long streamed text sits before it is flushed as a transcript record. */
  flushMs?: number
}

export interface AcpSpawnDispatchInput {
  threadSlug: string
  sessionId: string
  cwd: string
  agentId: string
  /** One of the agent's advertised model ids (`acp:<agent>@<model>`), or nothing for the agent's own default. */
  modelId?: string | null
  /** The full first prompt: worker contract, orientation, then the task. */
  prompt: string
  /** What the human actually wrote — the transcript records this, not the contract. */
  userText: string
}

export interface AcpSessionInfo {
  acpSessionId: string
  agent: { id: string; name?: string; version?: string }
  model?: string
}

export interface AcpFollowUpInput {
  threadSlug: string
  sessionId: string
  cwd: string
  agentId: string
  modelId?: string | null
  /** The ACP session id pinned on the row, for a resume after a restart. */
  acpSessionId?: string | null
  text: string
  deliveryId?: string
}

export interface AcpFollowUpResult extends AcpSessionInfo {
  state: "delivered" | "queued"
  /** How the session was reached: already live, re-opened via session/load, or started fresh. */
  resumed: "live" | "loaded" | "fresh"
}

export interface AcpTurnLiveness {
  sessionLive: boolean
  turnActive: boolean
  queued: number
}

type PermissionDecisionId = "grant-turn" | "grant-session" | "deny" | "accept" | "acceptForSession" | "decline"

interface PendingPermission {
  resolve: (result: AcpRequestPermissionResult) => void
  /** Canonical card decision id → the agent's own optionId, echoed verbatim on the answer. */
  optionByDecision: Map<string, string>
  scope: InteractionSessionScope
}

export interface QueuedFollowUp { text: string; deliveryId?: string }

/** Follow-ups this bridge was holding for a turn's end that can no longer go out on this session. */
export interface StrandedFollowUps { threadSlug: string; sessionId: string; followUps: QueuedFollowUp[] }

interface Turn {
  startedAt: string
  deliveryId?: string
  /** Streamed text not yet written to the transcript. */
  text: string
  messageId?: string
  /** Everything the CURRENT agent message has said, flushed or not — the turn's final text. */
  messageText: string
  thought: string
  flushTimer?: NodeJS.Timeout
  cancelRequested: boolean
  /** The agent has said something during this turn, so the prompt reached it. */
  heard: boolean
  done: Promise<void>
  finish: () => void
}

/** The turn's outcome record, shared by a turn this bridge started and one it adopted after a restart. */
type TurnOutcome = { kind: "ended"; raw: unknown } | { kind: "failed"; err: unknown }

interface ToolMeta { kind?: string; title?: string; locations?: string[]; written: boolean; status?: string; inputJson?: string }

function nonEmptyInputJson(rawInput: unknown): string | undefined {
  return rawInput && typeof rawInput === "object" && Object.keys(rawInput).length ? JSON.stringify(rawInput) : undefined
}

interface LiveSession {
  slug: string
  sessionId: string
  cwd: string
  agent: ResolvedAcpAgent
  conn: AcpConnection
  init: AcpInitializeResultType
  acpSessionId: string
  model?: string
  /** The config option id the agent files its model under (`model` for every agent seen so far). */
  modelOptionId?: string
  writer: AcpTranscriptWriter
  /** True while `session/load` replays history — those updates are already in the file. */
  loading: boolean
  turn?: Turn
  queue: QueuedFollowUp[]
  pendingPerms: Map<string, PendingPermission>
  tools: Map<string, ToolMeta>
  exited: boolean
  /** True from `shutdown()` on: the connection is being DETACHED from a daemon that keeps running, so
   *  a rejected prompt is not the turn ending and must not be recorded as one. */
  detaching: boolean
  /** True from the moment the session is being ended (`endSession`, `releaseSession`): its next prompt
   *  would be written into a closing connection, so nothing more goes out on it. */
  ending: boolean
  /** Set when the session no longer holds the worker contract; the next prompt carries it and clears it. */
  contractOwed?: AcpContractReason
}

const AUTH_HINT = "The agent needs a login first. "
const ACP_MODEL_CACHE_MS = 10 * 60_000

function clip(text: string, max: number): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text }

// A slash command is parsed off the START of the prompt (opencode's `/compact`, `/review`), so text put
// in front of one turns it into a plain message. A contract that is owed waits for the next prompt that
// is not one. `/Users/…` is a path, not a command: the name must end at whitespace or the end.
function isSlashCommand(text: string): boolean { return /^\/[\w-]+(?:\s|$)/.test(text.trimStart()) }

/** `_meta["opencode/compaction"]` on a `session_info_update`: how opencode reports a compaction to a
 *  client that did not advertise `session.compaction` (cli/src/acp/compaction.ts, v2.0.27). */
function opencodeCompactionStatus(update: unknown): string | undefined {
  const meta = (update as { _meta?: Record<string, unknown> } | undefined)?._meta?.["opencode/compaction"]
  const status = (meta as { status?: unknown } | undefined)?.status
  return typeof status === "string" ? status : undefined
}

function frizzMcpServer(mcp: FrizzMcp | undefined, slug: string): AcpMcpServerStdio[] {
  if (!mcp) return []
  return [{
    name: FRIZZ_MCP.name,
    command: process.execPath,
    args: [mcp.scriptPath],
    env: Object.entries(frizzMcpEnv({ ...mcp, slug })).map(([name, value]) => ({ name, value })),
  }]
}

/** The text a tool call's result carries, from `content` blocks first and `rawOutput` second. */
function toolResultText(tc: AcpToolCallUpdate): string {
  const parts: string[] = []
  for (const c of tc.content ?? []) {
    if (c.type === "content") { const t = contentText((c as { content: Parameters<typeof contentText>[0] }).content); if (t) parts.push(t) }
    else if (c.type === "diff") parts.push(`--- ${(c as { path: string }).path}\n${(c as { newText: string }).newText}`)
  }
  if (parts.length) return parts.join("\n")
  const raw = tc.rawOutput as { output?: unknown } | undefined
  if (raw && typeof raw === "object" && typeof raw.output === "string") return raw.output
  if (typeof tc.rawOutput === "string") return tc.rawOutput
  return ""
}

/** An ACP permission request as a Frizz card. The card's decision ids are the CANONICAL ones the web
 *  renders buttons for (typedInteractions.ts `specFor`); the agent's own optionIds are kept beside the
 *  pending entry and echoed back verbatim on the answer. */
export function buildAcpPermissionInteraction(
  params: AcpRequestPermissionParams,
  owner: { projectId: string; threadSlug: string; sessionId: string; cwd: string },
  agent: { id: string; label: string },
): { request: InteractionRequestType; optionByDecision: Map<string, string> } | null {
  const tc = params.toolCall
  const input = tc.rawInput && typeof tc.rawInput === "object" ? tc.rawInput as Record<string, unknown> : undefined
  const command = typeof input?.command === "string" ? input.command : ""
  const isCommand = tc.kind === "execute" && command !== ""
  const isFile = (tc.kind === "edit" || tc.kind === "delete" || tc.kind === "move") && (tc.locations?.[0]?.path || typeof input?.filePath === "string" || typeof input?.path === "string")
  const payloadKind = isCommand ? "command-approval" : isFile ? "file-approval" : "permission-approval"

  const optionByDecision = new Map<string, string>()
  const allowedDecisions: InteractionRequestType["allowedDecisions"] = []
  const add = (id: PermissionDecisionId, semantic: "approve" | "deny", label: string, optionId: string, description?: string) => {
    if (optionByDecision.has(id)) return
    optionByDecision.set(id, optionId)
    allowedDecisions.push({ id, semantic, label: clip(label, 150), ...(description ? { description: clip(description, 500) } : {}) })
  }
  for (const opt of params.options) {
    const label = opt.name ?? opt.kind ?? opt.optionId
    const once = payloadKind === "permission-approval" ? "grant-turn" : "accept"
    const always = payloadKind === "permission-approval" ? "grant-session" : "acceptForSession"
    const deny = payloadKind === "permission-approval" ? "deny" : "decline"
    if (opt.kind === "allow_once") add(once, "approve", label, opt.optionId, "Allow this once.")
    else if (opt.kind === "allow_always") add(always, "approve", label, opt.optionId, "Allow for the rest of this session.")
    else if (opt.kind === "reject_once" || opt.kind === "reject_always") add(deny, "deny", label, opt.optionId, "Block this tool call.")
  }
  if (!allowedDecisions.some((d) => d.semantic === "deny")) return null // nothing safe to press
  const title = clip(tc.title ?? (isCommand ? "Run a command?" : "Approve a tool call?"), 150)
  const previewLines = [command || "", ...Object.entries(input ?? {}).filter(([k, v]) => k !== "command" && v !== "" && v !== null).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)].filter(Boolean)
  const preview = clip(redactCredentialSyntax(previewLines.join("\n\n")), 6_000)
  const pathLabel = clip(tc.locations?.[0]?.path ?? (typeof input?.filePath === "string" ? input.filePath : typeof input?.path === "string" ? input.path : ""), 1_000)
  const base = {
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    contentFormat: "plain-text" as const,
    provider: { kind: "acp" as const, name: agent.label },
    source: { kind: "tool" as const, id: clip(tc.toolCallId, 500), label: clip(tc.title ?? tc.kind ?? "tool", 150) },
    owner: { projectId: owner.projectId, threadSlug: owner.threadSlug, sessionId: owner.sessionId, turnId: clip(tc.toolCallId, 500), itemId: clip(tc.toolCallId, 500), sessionEpoch: 0, capabilityRevision: 0 },
    providerRequestId: clip(tc.toolCallId, 500),
    allowedDecisions,
    expiresAt: null,
  }
  const payload = payloadKind === "command-approval"
    ? { kind: "command-approval" as const, title, command: { summary: clip(command.replace(/\s+/g, " "), 150), preview, redacted: true as const, workingDirectoryLabel: clip(owner.cwd, 1_000) } }
    : payloadKind === "file-approval"
      ? { kind: "file-approval" as const, title, operation: (tc.kind === "delete" ? "delete" : tc.kind === "move" ? "move" : "write") as "delete" | "move" | "write", pathLabel: pathLabel || "(unknown path)", ...(preview ? { diffPreview: preview } : {}) }
      : { kind: "permission-approval" as const, title, permission: clip(tc.kind ?? "tool", 250), ...(preview ? { preview } : {}), workingDirectoryLabel: clip(owner.cwd, 1_000) }
  const parsed = InteractionRequest.safeParse({ ...base, payload })
  return parsed.success ? { request: parsed.data, optionByDecision } : null
}

export class AcpBridge {
  private readonly sessions = new Map<string, LiveSession>()
  // Opens in flight, by Frizz session id. See `openOnce`.
  private readonly opening = new Map<string, ReturnType<AcpBridge["open"]>>()
  // Sessions being ended, and daemons being stopped, by Frizz session id. See `endSession`.
  private readonly ending = new Map<string, Promise<void>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly strandedListeners = new Set<(event: StrandedFollowUps) => void>()
  private readonly unsubscribe: (() => void) | undefined
  private closed = false

  constructor(private readonly options: AcpBridgeOptions) {
    // A resolved (or cancelled/expired) card answers the agent. The store is the durable holder; this
    // map only knows which live request each card is attached to.
    this.unsubscribe = options.interactions?.subscribe((change) => {
      for (const live of this.sessions.values()) {
        const pending = live.pendingPerms.get(change.interactionId)
        if (!pending || change.lifecycle === "pending") continue
        live.pendingPerms.delete(change.interactionId)
        const record = options.interactions!.get(pending.scope, change.interactionId)
        const decisionId = change.lifecycle === "resolved" ? record?.resolution?.decisionId : undefined
        const optionId = decisionId ? pending.optionByDecision.get(decisionId) : undefined
        pending.resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } })
      }
    })
  }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString() }

  private diagnostic(slug: string, kind: string, message: string): void {
    this.options.onDiagnostic?.({ threadSlug: slug, kind, message })
    if (kind !== "stderr") log.debug("acp", `[${slug}] ${kind}: ${message}`)
  }

  /** The agents this bridge can launch, with the operator's own entries merged in. */
  agents(): AcpAgentSpec[] { return acpAgentSpecs(this.options.customAgents?.()) }

  private resolveAgent(agentId: string): ResolvedAcpAgent {
    const agent = resolveAcpAgent(agentId, this.options.customAgents?.(), this.options.env ?? process.env)
    if (!agent) throw new Error(`Unknown ACP agent "${agentId}". Add it under settings.acpAgents or pick one of: ${this.agents().map((a) => a.id).join(", ")}.`)
    if (!agent.bin) throw new Error(`The ACP agent "${agent.label}" is not installed: \`${agent.command}\` is not on PATH. Install it, or point settings.acpAgents at its executable.`)
    return agent
  }

  // ---- session lifecycle ----------------------------------------------------------------------

  /** Spawn the agent, initialize, and open (or load) a session. Throws an actionable error on any
   *  failure and leaves nothing behind. */
  private host(): AcpHost {
    return this.options.host ?? (this.options.spawn ? directAcpHost(this.options.spawn) : daemonAcpHost)
  }

  /** `dispatch` marks the open that starts a brand-new thread, whose first prompt already IS the contract. */
  private async open(input: { threadSlug: string; sessionId: string; cwd: string; agentId: string; modelId?: string | null; acpSessionId?: string | null; dispatch?: boolean }): Promise<{ live: LiveSession; resumed: "loaded" | "fresh" | "reattached" }> {
    const { threadSlug: slug, sessionId, cwd } = input
    const agent = this.resolveAgent(input.agentId)
    await this.sessionEnded(sessionId)
    // An ACP agent is one detached daemon PER THREAD (acp-host.ts), so its environment can say who is
    // calling — which is all `frizzctl`, run from the agent's own shell, needs. Applied when the daemon
    // is forked; one that survived a Frizz restart keeps the environment it was born with.
    const cli = this.options.frizzCli
    // Plain `gh` reads with Frizz's read-only credential where Keyward takes the writes.
    const inherited = { ...inheritWorkerEnvironment(this.options.env ?? process.env), ...frizzGithubWorkerEnv(this.options.env ?? process.env) }
    const env = cli ? withFrizzCliOnPath({ ...inherited, ...frizzCliEnv(cli, slug) }, cli) : inherited
    const attachment = await this.host()({ stateDir: this.options.stateDir, threadSlug: slug, sessionId, command: agent.bin!, args: agent.args, cwd, env })
    const proc = attachment.process
    const writer = new AcpTranscriptWriter(acpTranscriptPath(this.options.stateDir, sessionId))
    // Read BEFORE this open writes anything: a compaction the previous runtime recorded and never answered.
    const owedFromTranscript = acpContractOwed(writer.path)
    let live: LiveSession | undefined
    // Traffic from the agent that arrives before the session is READY is held, not dropped or refused.
    // On a reattach the daemon replays everything the agent said while Frizz was away — the running
    // turn's chunks, and any permission request it re-sends — the instant the socket opens, before
    // `initialize` has even been answered. Refusing a request then ("session not ready") would be taken
    // by the daemon as THE answer, and a dropped chunk is a hole in the transcript. `ready()` flips at
    // the point the handlers can act: right after the session exists on a fresh open (so session/load's
    // own replay is still governed by `loading`), and after the in-flight turn is adopted on a reattach.
    let isReady = false
    const held: Array<() => void> = []
    const ready = (): void => { isReady = true; for (const run of held.splice(0)) run() }
    const conn = new AcpConnection(proc, {
      onRequest: (method, params) => {
        if (isReady && live) return this.handleRequest(live, method, params)
        return new Promise((resolve, reject) => { held.push(() => { this.handleRequest(live!, method, params).then(resolve, reject) }) })
      },
      onNotification: (method, params) => {
        if (method !== "session/update") return
        if (isReady && live) this.handleNotification(live, params)
        else held.push(() => this.handleNotification(live!, params))
      },
      onDiagnostic: (d) => this.diagnostic(slug, d.kind, d.message),
      requestTimeoutMs: this.options.initializeTimeoutMs ?? 60_000,
    })
    const fail = async (err: unknown): Promise<never> => {
      await conn.close(500)
      // An agent that cannot complete the handshake or open a session is no use alive in a daemon.
      await stopAcpDaemon(this.options.stateDir, sessionId).catch(() => {})
      const stderr = conn.recentStderr.slice(-3).join(" | ")
      const e = err instanceof Error ? err : new Error(String(err))
      throw new Error(`${e.message}${stderr ? ` (agent stderr: ${clip(stderr, 400)})` : ""}`)
    }
    let init: AcpInitializeResultType
    try {
      init = AcpInitializeResult.parse(await conn.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // `session.compaction` asks for the standard `compaction_update`; without it opencode reports a
        // compaction only through `_meta` on a `session_info_update` (both are handled below).
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} } },
        clientInfo: { name: "frizz", version: "0" },
      }))
    } catch (err) { return fail(err instanceof Error ? new Error(`${agent.label} did not complete the ACP handshake: ${err.message}`) : err) }
    const mcpServers = this.options.mountsMcp?.(slug) === false ? [] : frizzMcpServer(this.options.frizzMcp, slug)
    live = { slug, sessionId, cwd, agent, conn, init, acpSessionId: "", writer, loading: false, queue: [], pendingPerms: new Map(), tools: new Map(), exited: false, detaching: false, ending: false, ...(owedFromTranscript ? { contractOwed: "compaction" as const } : {}) }
    void conn.exited.then(() => { if (live) this.onExit(live) })

    // REATTACHED to an agent that outlived a frizz restart: the session is already open (the daemon
    // reports its id) and a `session/prompt` may still be running. Adopt both — no session/new, no
    // session/load, and the in-flight prompt becomes the live turn so it ends in the transcript exactly
    // as it would have had nothing happened.
    if (attachment.reattached && attachment.hello.acpSessionId) {
      live.acpSessionId = attachment.hello.acpSessionId
      writer.append({ kind: "acp-note", at: this.now(), text: `Reattached to the running ${agent.label} session after a Frizz restart.` })
      if (attachment.hello.droppedWhileDetached > 0) {
        writer.append({ kind: "acp-note", at: this.now(), text: `${attachment.hello.droppedWhileDetached} message(s) from the agent were lost while Frizz was away; the transcript may have gaps.` })
      }
      this.sessions.set(sessionId, live)
      const prompt = attachment.hello.outstanding.find((o) => o.method === "session/prompt")
      if (prompt) {
        const current = live
        const turn = this.newTurn(undefined)
        current.turn = turn
        this.options.onStatusChange?.()
        void this.awaitTurn(current, turn, conn.adoptPending("session/prompt", (id) => attachment.adopt(prompt.daemonId, id)))
      }
      ready()
      return { live, resumed: "reattached" }
    }
    ready()

    const authError = (err: AcpRemoteError): Error => {
      const hint = (init.authMethods ?? []).map((m) => m.description ?? m.name ?? m.id).filter(Boolean).join("; ")
      return new Error(`${AUTH_HINT}${agent.label} refused to open a session: ${err.error.message}.${hint ? ` ${hint}.` : ""}`)
    }
    let resumed: "loaded" | "fresh" = "fresh"
    if (input.acpSessionId && init.agentCapabilities?.loadSession) {
      live.loading = true
      try {
        const loaded = AcpLoadSessionResult.parse(await conn.request("session/load", { sessionId: input.acpSessionId, cwd, mcpServers }))
        live.acpSessionId = input.acpSessionId
        this.adoptModel(live, loaded.configOptions)
        resumed = "loaded"
      } catch (err) {
        if (err instanceof AcpRemoteError && err.error.code === ACP_ERROR_AUTH_REQUIRED) return fail(authError(err))
        this.diagnostic(slug, "protocol", `session/load ${input.acpSessionId} failed (${(err as Error).message}); starting a fresh session`)
      } finally { live.loading = false }
    }
    if (!live.acpSessionId) {
      try {
        const created = AcpNewSessionResult.parse(await conn.request("session/new", { cwd, mcpServers }))
        live.acpSessionId = created.sessionId
        this.adoptModel(live, created.configOptions)
      } catch (err) {
        if (err instanceof AcpRemoteError && err.error.code === ACP_ERROR_AUTH_REQUIRED) return fail(authError(err))
        return fail(err instanceof Error ? new Error(`${agent.label} could not open a session: ${err.message}`) : err)
      }
    }
    // The thread's chosen model, applied before the header so the header records what is in effect.
    const modelProblem = await this.applyModel(live, input.modelId)
    if (resumed === "fresh") {
      writer.append({ kind: "acp-session", at: this.now(), agent: { id: agent.id, ...(init.agentInfo?.name ? { name: init.agentInfo.name } : {}), ...(init.agentInfo?.version ? { version: init.agentInfo.version } : {}) }, acpSessionId: live.acpSessionId, cwd, ...(live.model ? { model: live.model } : {}) })
      if (input.acpSessionId) writer.append({ kind: "acp-note", at: this.now(), text: `Resumed with a fresh ${agent.label} session: the previous one (${input.acpSessionId}) could not be loaded, so the agent no longer has the earlier conversation.` })
      // Every fresh open but a dispatch's replaces a session this thread already had, so it starts with
      // nothing — not even the contract the dispatch's first prompt carried. Keyed on the dispatch, not
      // on `acpSessionId`: a row whose session id was never pinned is just as much a re-open.
      if (!input.dispatch) live.contractOwed = "fresh-session"
    }
    if (modelProblem) writer.append({ kind: "acp-note", at: this.now(), text: modelProblem })
    this.sessions.set(sessionId, live)
    return { live, resumed }
  }

  /**
   * ONE open per session at a time; every concurrent caller shares it. The session's daemon is keyed by
   * session id — one record path, one socket path — so two opens racing for a session with no live
   * agent (the waker delivering answers while the operator sends, a boot `warmUp` under a follow-up)
   * each found no daemon and FORKED one. The second took the record and the socket path, and the two
   * attaches could reach the SAME daemon, which serves one client at a time: the later one hung up the
   * earlier, whose next stdin write failed with EPIPE — an unhandled stream error that took the whole
   * process down until acp-rpc.ts listened for it. Short of that, a failed open `stopAcpDaemon`s
   * whatever the record names (the other caller's agent), and the loser of the two `sessions.set`s
   * runs its turn on a second agent nobody tracks, appending to the same transcript.
   * The same race forked two Claude daemons on 2026-09-30 (claude-agent-broker-bridge.ts `attachOnce`);
   * scripts/verify-daemon-socket-takeover.mjs, scenario D, reproduces it here.
   */
  private openOnce(input: Parameters<AcpBridge["open"]>[0]): ReturnType<AcpBridge["open"]> {
    const inflight = this.opening.get(input.sessionId)
    if (inflight) return inflight
    const opening = this.open(input).finally(() => { if (this.opening.get(input.sessionId) === opening) this.opening.delete(input.sessionId) })
    this.opening.set(input.sessionId, opening)
    return opening
  }

  /** The agent's model option (`category: "model"`, else the one literally named `model`). */
  private modelOption(configOptions: AcpNewSessionResult["configOptions"]): AcpConfigOption | undefined {
    return configOptions?.find((o) => o.category === "model") ?? configOptions?.find((o) => o.id === "model")
  }

  private adoptModel(live: LiveSession, configOptions: AcpNewSessionResult["configOptions"]): void {
    const option = this.modelOption(configOptions)
    if (!option) return
    live.modelOptionId = option.id
    if (typeof option.currentValue === "string") live.model = option.currentValue
  }

  /** Ask the agent for the thread's model when it is not already the one in effect. Returns the note
   *  to write when the agent refused — the thread runs on, on the agent's own model, and says so. */
  private async applyModel(live: LiveSession, modelId: string | null | undefined): Promise<string | undefined> {
    if (!modelId || modelId === live.model) return undefined
    try {
      const res = AcpSetConfigOptionResult.parse(await live.conn.request("session/set_config_option", { sessionId: live.acpSessionId, configId: live.modelOptionId ?? "model", value: modelId }))
      this.adoptModel(live, res.configOptions)
      if (live.model !== modelId && res.configOptions?.length) return `${live.agent.label} did not switch to ${modelId}; the session runs on ${live.model ?? "its own default model"}.`
      if (!res.configOptions?.length) live.model = modelId
      return undefined
    } catch (err) {
      const message = err instanceof AcpRemoteError ? err.error.message : (err as Error).message
      this.diagnostic(live.slug, "protocol", `session/set_config_option ${modelId} failed: ${message}`)
      return `${live.agent.label} could not switch to ${modelId} (${clip(message, 200)}); the session runs on ${live.model ?? "its own default model"}.`
    }
  }

  // ---- the model catalogue an agent advertises -----------------------------------------------------

  private readonly modelProbes = new Map<string, Promise<AcpAgentModels>>()
  private readonly modelCache = new Map<string, AcpAgentModels>()

  /** The models an agent offers, read by opening a throwaway session (there is no other way to ask:
   *  ACP advertises models only in a session's config options). Cached per agent for ten minutes; a
   *  probe that cannot open a session (not installed, not logged in) yields an empty list with the
   *  reason, never a throw, so the composer degrades to the agent's own default. */
  agentModels(agentId: string, cwd: string, opts: { refresh?: boolean } = {}): Promise<AcpAgentModels> {
    const cached = this.modelCache.get(agentId)
    if (cached && !opts.refresh && Date.now() - Date.parse(cached.probedAt) < ACP_MODEL_CACHE_MS) return Promise.resolve(cached)
    const inflight = this.modelProbes.get(agentId)
    if (inflight) return inflight
    const probe = this.probeModels(agentId, cwd).then((result) => {
      if (!result.error) this.modelCache.set(agentId, result)
      return result
    }).finally(() => this.modelProbes.delete(agentId))
    this.modelProbes.set(agentId, probe)
    return probe
  }

  private async probeModels(agentId: string, cwd: string): Promise<AcpAgentModels> {
    const probedAt = this.now()
    const empty = (error: string): AcpAgentModels => ({ agentId, models: [], error, probedAt })
    let agent: ResolvedAcpAgent
    try { agent = this.resolveAgent(agentId) } catch (err) { return empty((err as Error).message) }
    const env = inheritWorkerEnvironment(this.options.env ?? process.env)
    const spawn = this.options.spawn ?? spawnAcpChild
    let proc: ReturnType<typeof spawnAcpChild>
    try { proc = spawn({ command: agent.bin!, args: agent.args, cwd, env }) } catch (err) { return empty(`${agent.label} could not start: ${(err as Error).message}`) }
    const conn = new AcpConnection(proc, {
      onRequest: () => Promise.reject(new AcpRequestError(ACP_ERROR_METHOD_NOT_FOUND, "probe session takes no requests")),
      onNotification: () => {},
      onDiagnostic: (d) => this.diagnostic(`probe:${agentId}`, d.kind, d.message),
      requestTimeoutMs: this.options.initializeTimeoutMs ?? 60_000,
    })
    try {
      const init = AcpInitializeResult.parse(await conn.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "frizz", version: "0" },
      }))
      const created = AcpNewSessionResult.parse(await conn.request("session/new", { cwd, mcpServers: [] }))
      const option = this.modelOption(created.configOptions)
      const current = typeof option?.currentValue === "string" ? option.currentValue : undefined
      void init
      return {
        agentId,
        models: (option?.options ?? []).map((o) => ({ id: o.value, name: o.name ?? o.value })),
        ...(current ? { current } : {}),
        probedAt,
      }
    } catch (err) {
      const message = err instanceof AcpRemoteError && err.error.code === ACP_ERROR_AUTH_REQUIRED
        ? `${AUTH_HINT}${agent.label} refused to open a session: ${err.error.message}`
        : `${agent.label}: ${(err as Error).message}`
      return empty(clip(message, 400))
    } finally {
      await conn.close(500)
    }
  }

  private onExit(live: LiveSession): void {
    if (live.exited) return
    live.exited = true
    this.retirePermissions(live, "provider-cancelled")
    if (live.turn) {
      // The child died under a turn: the prompt request already rejected (AcpConnectionClosed) and the
      // turn's own handler writes the error; nothing more to do here.
    }
    if (this.sessions.get(live.sessionId) === live) this.sessions.delete(live.sessionId)
    this.options.onStatusChange?.()
  }

  // ---- public API --------------------------------------------------------------------------------

  async spawnDispatch(input: AcpSpawnDispatchInput): Promise<AcpSessionInfo> {
    if (this.closed) throw new Error("ACP bridge is closed")
    const { live } = await this.openOnce({ ...input, dispatch: true })
    void this.runTurn(live, input.prompt, input.userText, undefined)
    return this.info(live)
  }

  /** Deliver a follow-up: to the live session, to a re-opened one (load or fresh), or into the queue
   *  when a turn is running. Returns the (possibly new) ACP session id so the caller can re-pin it. */
  async followUp(input: AcpFollowUpInput): Promise<AcpFollowUpResult> {
    if (this.closed) throw new Error("ACP bridge is closed")
    // A send that arrives while the session is being ended waits for that, then opens the session again.
    await this.sessionEnded(input.sessionId)
    let live = this.sessions.get(input.sessionId)
    let resumed: AcpFollowUpResult["resumed"] = "live"
    if (!live || live.exited || live.conn.closed) {
      // Shared with any open already in flight for this session. The first caller to resume runs its
      // turn (runTurn claims `live.turn` before its first await); every other one then queues behind it.
      const opened = await this.openOnce(input)
      live = opened.live
      // A reattach IS the live session — the agent never went away, only the socket did.
      resumed = opened.resumed === "reattached" ? "live" : opened.resumed
    }
    if (live.turn) {
      live.queue.push({ text: input.text, ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}) })
      return { ...this.info(live), state: "queued", resumed }
    }
    void this.runTurn(live, input.text, input.text, input.deliveryId)
    return { ...this.info(live), state: "delivered", resumed }
  }

  /** `session/cancel`, then wait (bounded) for the prompt to return. `interrupted: false` when no turn
   *  was running. The queue is NOT discarded — a follow-up typed during the turn still goes out on this
   *  same agent. A stop that ends the agent as well is `endSession`, which takes the queue off first. */
  async interruptTurn(threadSlug: string, sessionId: string): Promise<{ interrupted: boolean }> {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug || !live.turn) return { interrupted: false }
    live.turn.cancelRequested = true
    live.conn.notify("session/cancel", { sessionId: live.acpSessionId })
    const settled = await Promise.race([live.turn.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000).unref?.())])
    if (!settled) { await live.conn.close(1_000); return { interrupted: true } }
    return { interrupted: true }
  }

  /**
   * STOP the worker: cancel its turn, wait for it, and end the agent. The queue comes off FIRST. A cancel
   * returns the prompt, the prompt's return drains the queue, and the next message then went out on a
   * connection about to be closed: `session/prompt: agent connection closed (stdin: write EPIPE)` on a
   * message the agent never read (2026-11-06). What was queued is handed to `onFollowUpsStranded`, whose
   * owner decides what becomes of it. Until the daemon is gone a follow-up waits (`sessionEnded`), so it
   * opens a new agent rather than joining the old one's ending.
   */
  endSession(threadSlug: string, sessionId: string): Promise<void> {
    const inflight = this.ending.get(sessionId)
    if (inflight) return inflight
    const live = this.sessions.get(sessionId)
    if (live && live.slug === threadSlug) live.ending = true
    const run = Promise.resolve().then(async () => {
      if (live && live.slug === threadSlug) {
        this.strand(live)
        if (live.turn) await this.interruptTurn(threadSlug, sessionId)
      }
      this.releaseSession(threadSlug, sessionId, "session-deleted")
      await this.stopping.get(sessionId)
    }).finally(() => { if (this.ending.get(sessionId) === run) this.ending.delete(sessionId) })
    this.ending.set(sessionId, run)
    return run
  }

  /** Is this session on its way down? While it is, nothing should be handed to it. */
  isEnding(sessionId: string): boolean { return this.ending.has(sessionId) || this.stopping.has(sessionId) }

  private async sessionEnded(sessionId: string): Promise<void> {
    await this.ending.get(sessionId)?.catch(() => {})
    await this.stopping.get(sessionId)
  }

  /** END the session's agent: cancel its turn, drop its cards, and stop the daemon holding it. This is
   *  the teardown for a thread that is dismissed, replaced or marked done — never for a restart, which
   *  is `shutdown()`. Inert when nothing is live AND no daemon exists for the session. */
  releaseSession(threadSlug: string, sessionId: string, reason: "session-replaced" | "session-deleted"): void {
    const live = this.sessions.get(sessionId)
    if (live && live.slug === threadSlug) {
      this.sessions.delete(sessionId)
      live.ending = true
      this.strand(live)
      this.retirePermissions(live, "provider-cancelled")
      if (live.turn) {
        live.turn.cancelRequested = true
        live.conn.notify("session/cancel", { sessionId: live.acpSessionId })
      }
      void live.conn.close(3_000)
    }
    void reason
    const stopped = stopAcpDaemon(this.options.stateDir, sessionId).catch(() => {}).finally(() => { if (this.stopping.get(sessionId) === stopped) this.stopping.delete(sessionId) })
    this.stopping.set(sessionId, stopped)
  }

  /** Hear about follow-ups that were queued on a session that can no longer send them. */
  onFollowUpsStranded(listener: (event: StrandedFollowUps) => void): () => void {
    this.strandedListeners.add(listener)
    return () => { this.strandedListeners.delete(listener) }
  }

  private strand(live: LiveSession): void {
    const followUps = live.queue.splice(0)
    if (!followUps.length) return
    for (const listener of this.strandedListeners) {
      try { listener({ threadSlug: live.slug, sessionId: live.sessionId, followUps }) } catch (err) { this.diagnostic(live.slug, "queue", `stranded follow-ups: ${(err as Error).message}`) }
    }
  }

  /** Boot-time reattach: every session in `rows` whose daemon is still running is re-opened NOW, so a
   *  turn that survived the restart is live on the board (and its in-flight prompt adopted) before the
   *  next input rather than after it. Fire-and-forget per row: one agent's trouble never blocks a boot. */
  async warmUp(rows: ReadonlyArray<{ threadSlug: string; sessionId: string; cwd: string; agentId: string; modelId?: string | null; acpSessionId?: string | null }>): Promise<void> {
    for (const row of rows) {
      if (this.closed) return
      if (!liveAcpDaemonRecord(this.options.stateDir, row.sessionId)) continue
      if (this.sessions.has(row.sessionId)) continue
      try {
        await this.openOnce(row)
      } catch (err) {
        this.diagnostic(row.threadSlug, "reattach", `could not reattach to the running agent: ${(err as Error).message}`)
      }
    }
  }

  /** Switch a LIVE session's model (`session/set_config_option`); `applied: false` when the session is
   *  not open, in which case the caller's stored slug reaches the agent on the next open. A refusal is
   *  written to the transcript as a note, exactly as on open, and still counts as applied: the agent
   *  answered, and the note says what it runs on. */
  async setModel(threadSlug: string, sessionId: string, modelId: string | null | undefined): Promise<{ applied: boolean; model?: string }> {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug || live.exited || live.conn.closed) return { applied: false }
    const problem = await this.applyModel(live, modelId)
    if (problem) live.writer.append({ kind: "acp-note", at: this.now(), text: problem })
    return { applied: true, ...(live.model ? { model: live.model } : {}) }
  }

  /** An agent process exists for the session: attached here, or held by a daemon nobody has reattached
   *  to yet. What "live" means to Mark as done and dismiss — an idle agent is still one to end. */
  isAgentAlive(threadSlug: string, sessionId: string): boolean {
    const live = this.sessions.get(sessionId)
    if (live && live.slug === threadSlug && !live.exited && !live.conn.closed) return true
    return liveAcpDaemonRecord(this.options.stateDir, sessionId) !== null
  }

  turnLiveness(threadSlug: string, sessionId: string): AcpTurnLiveness | undefined {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug) return undefined
    return { sessionLive: !live.exited && !live.conn.closed, turnActive: live.turn !== undefined, queued: live.queue.length }
  }

  session(threadSlug: string, sessionId: string): AcpSessionInfo | undefined {
    const live = this.sessions.get(sessionId)
    return live && live.slug === threadSlug ? this.info(live) : undefined
  }

  ownsInteraction(scope: InteractionSessionScope, interactionId: string): boolean {
    const live = this.sessions.get(scope.sessionId)
    return live !== undefined && live.slug === scope.threadSlug && live.pendingPerms.has(interactionId)
  }

  /** DETACH from every agent — the daemons and their turns keep running for the next runtime to
   *  reattach to. Open cards are cancelled on OUR side only (the answer would have nowhere to go); the
   *  agent's request stays unanswered in its daemon, which re-sends it on reattach so the card is raised
   *  afresh. A plain-child session (test seam) simply ends here, as it always did. */
  async shutdown(): Promise<void> {
    this.closed = true
    this.unsubscribe?.()
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map(async (live) => {
      live.detaching = true
      // The queue is this process's memory: the daemon carries on with the turn, and nobody is left to
      // send what was waiting behind it.
      this.strand(live)
      this.dropPermissionCards(live)
      await live.conn.close(1_000)
    }))
  }

  /** Cancel a session's open cards without answering the agent. The pending entries go FIRST, so the
   *  store's cancellation event (which resolves a pending entry with `cancelled`) finds none to answer. */
  private dropPermissionCards(live: LiveSession): void {
    if (!live.pendingPerms.size) return
    live.pendingPerms.clear()
    try { this.options.interactions?.cancelForSession(live.slug, live.sessionId, "provider-cancelled") } catch { /* hygiene */ }
  }

  private info(live: LiveSession): AcpSessionInfo {
    return {
      acpSessionId: live.acpSessionId,
      agent: { id: live.agent.id, ...(live.init.agentInfo?.name ? { name: live.init.agentInfo.name } : {}), ...(live.init.agentInfo?.version ? { version: live.init.agentInfo.version } : {}) },
      ...(live.model ? { model: live.model } : {}),
    }
  }

  // ---- the turn ---------------------------------------------------------------------------------

  private newTurn(deliveryId: string | undefined): Turn {
    let finish!: () => void
    const done = new Promise<void>((r) => { finish = r })
    return { startedAt: this.now(), ...(deliveryId ? { deliveryId } : {}), text: "", messageText: "", thought: "", cancelRequested: false, heard: false, done, finish }
  }

  private async runTurn(live: LiveSession, sendText: string, recordText: string, deliveryId: string | undefined): Promise<void> {
    const turn = this.newTurn(deliveryId)
    live.turn = turn
    // The contract goes out in front of the operator's words, once, and only when the session lost it —
    // the block is ~60K characters (60,670 with no FRIZZ.md, 2026-10-12), a tax no follow-up should pay
    // while the session still holds it. The transcript records the operator's words, not the contract.
    const owed = live.contractOwed
    const contract = owed && !isSlashCommand(sendText) ? this.options.contractFor?.(live.slug, live.sessionId) : undefined
    if (owed && contract) {
      sendText = `${contract}\n\n${sendText}`
      live.contractOwed = undefined
      live.writer.append({ kind: "acp-contract", at: turn.startedAt, reason: owed })
    }
    live.writer.append({ kind: "user-message", at: turn.startedAt, text: recordText, synthetic: false })
    live.writer.append({ kind: "turn-start", at: turn.startedAt })
    this.options.onStatusChange?.()
    await this.awaitTurn(live, turn, live.conn.requestOpenEnded("session/prompt", { sessionId: live.acpSessionId, prompt: [{ type: "text", text: sendText }] }))
  }

  /** Wait for a `session/prompt` — one this bridge sent, or one adopted from a daemon after a restart —
   *  and write the turn's ending. */
  private async awaitTurn(live: LiveSession, turn: Turn, response: Promise<unknown>): Promise<void> {
    let outcome: TurnOutcome
    try { outcome = { kind: "ended", raw: await response } } catch (err) { outcome = { kind: "failed", err } }
    // DETACHING, not ending: `shutdown()` closed the socket to a daemon whose agent is still running
    // this very turn. Leave the turn OPEN in the transcript — the next runtime reattaches and adopts it,
    // and its real ending is written then. Nothing else in `finally` applies either: the cards are the
    // daemon's to re-raise, and the queue was never the agent's.
    if (outcome.kind === "failed" && live.detaching && outcome.err instanceof AcpConnectionClosed) {
      if (turn.flushTimer) { clearTimeout(turn.flushTimer); turn.flushTimer = undefined }
      this.flushThought(live)
      this.flushText(live, false)
      turn.finish()
      return
    }
    try {
      if (outcome.kind === "failed") throw outcome.err
      const result = AcpPromptResult.parse(outcome.raw)
      this.flushThought(live)
      const finalText = this.flushText(live, true)
      // A cancelled turn is not a success: the tailer clears provider faults on a successful bracket,
      // and an operator's stop must not read as the agent having finished cleanly.
      live.writer.append({ kind: "turn-end", at: this.now(), ...(finalText !== undefined ? { finalText } : {}), successful: result.stopReason !== "refusal" && result.stopReason !== "cancelled" })
      if (result.stopReason === "cancelled") live.writer.append({ kind: "acp-note", at: this.now(), text: "Turn cancelled." })
    } catch (err) {
      this.flushThought(live)
      const finalText = this.flushText(live, true)
      const at = this.now()
      // Some agents (Gemini) answer a cancel with -32603 "aborted" instead of stopReason cancelled.
      // Or the connection goes first, because the session is being ended under the turn.
      const abortedByUs = turn.cancelRequested && (err instanceof AcpConnectionClosed || (err instanceof AcpRemoteError && err.error.code === ACP_ERROR_INTERNAL))
      if (abortedByUs) {
        live.writer.append({ kind: "turn-end", at, ...(finalText !== undefined ? { finalText } : {}), successful: false })
        live.writer.append({ kind: "acp-note", at, text: "Turn cancelled." })
      } else {
        const message = err instanceof AcpRemoteError
          ? (err.error.code === ACP_ERROR_AUTH_REQUIRED ? `${AUTH_HINT}${err.error.message}` : err.error.message)
          : (err as Error).message
        // The prompt went into a connection that was already gone, with no word from the agent since: the
        // bubble above this card is a message it never read, and only the card can say so.
        const unread = err instanceof AcpConnectionClosed && !turn.heard
        live.writer.append({ kind: "provider-error", at, error: { message: clip(message, 2_000), ...(err instanceof AcpRemoteError ? { code: String(err.error.code) } : {}), ...(unread ? { details: "The agent did not read this message. Send it again to restart the agent." } : {}) } })
        live.writer.append({ kind: "turn-end", at, ...(finalText !== undefined ? { finalText } : {}), successful: false })
      }
    } finally {
      this.retirePermissions(live, "turn-ended")
      if (live.turn === turn) live.turn = undefined
      turn.finish()
      this.options.onStatusChange?.()
      if (live.ending || live.exited || live.conn.closed) this.strand(live)
      else {
        const next = live.queue.shift()
        if (next) void this.runTurn(live, next.text, next.text, next.deliveryId)
      }
    }
  }

  /** Write the buffered text as one record. Returns, for a FINAL flush, the whole text of the agent's
   *  last message (every partial flush included) — what the turn-end carries as `finalText`, so the
   *  fold's preview and fence parsing see the complete message, never the last chunk. */
  private flushText(live: LiveSession, final: boolean): string | undefined {
    const turn = live.turn
    if (!turn) return undefined
    if (turn.flushTimer) { clearTimeout(turn.flushTimer); turn.flushTimer = undefined }
    if (turn.text) {
      const text = turn.text
      turn.text = ""
      live.writer.append({ kind: "assistant-text", at: this.now(), text, final, ...(turn.messageId ? { messageId: turn.messageId } : {}) })
    }
    return final && turn.messageText ? turn.messageText : undefined
  }

  private flushThought(live: LiveSession): void {
    const turn = live.turn
    if (!turn?.thought.trim()) { if (turn) turn.thought = ""; return }
    live.writer.append({ kind: "reasoning", at: this.now(), text: turn.thought })
    turn.thought = ""
  }

  private scheduleFlush(live: LiveSession): void {
    const turn = live.turn
    if (!turn || turn.flushTimer) return
    turn.flushTimer = setTimeout(() => { turn.flushTimer = undefined; this.flushText(live, false) }, this.options.flushMs ?? 1_000)
    turn.flushTimer.unref?.()
  }

  private handleNotification(live: LiveSession, params: unknown): void {
    if (live.loading) return
    const parsed = AcpSessionNotification.safeParse(params)
    if (!parsed.success) { this.diagnostic(live.slug, "protocol", "malformed session/update"); return }
    const update = parseSessionUpdate(parsed.data.update)
    const turn = live.turn
    // Only what a prompt produces. A session's own housekeeping (its command list) can land mid-turn too.
    if (turn && ["agent_thought_chunk", "agent_message_chunk", "tool_call", "tool_call_update", "plan"].includes(update.sessionUpdate)) turn.heard = true
    // A SUB-AGENT'S session, forwarded on this one. Its tool calls stay in the transcript as flat rows
    // (the parent's `subagent` row carries its result). Everything else describes the child: its text and
    // reasoning joined the parent's message and could become the thread's final text, and its usage,
    // title and compaction would be read as the thread's own.
    const child = isAcpChildUpdate(update)
    if (child && update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return
    switch (update.sessionUpdate) {
      case "agent_thought_chunk": {
        if (!turn) return
        const t = contentText(update.content)
        if (t) turn.thought += t
        return
      }
      case "agent_message_chunk": {
        if (!turn) return
        this.flushThought(live)
        const t = contentText(update.content)
        if (!t) return
        if (update.messageId && turn.messageId && update.messageId !== turn.messageId) { this.flushText(live, false); turn.messageText = "" }
        if (update.messageId) turn.messageId = update.messageId
        turn.text += t
        turn.messageText += t
        this.scheduleFlush(live)
        return
      }
      case "tool_call": {
        this.flushThought(live)
        this.flushText(live, false)
        // Text before a tool call is commentary, not the answer. A child's call says nothing about that.
        if (turn && !child) turn.messageText = ""
        const inputJson = nonEmptyInputJson(update.rawInput)
        const meta: ToolMeta = { ...(update.kind ? { kind: update.kind } : {}), ...(update.title ? { title: update.title } : {}), locations: (update.locations ?? []).map((l) => l.path), written: true, ...(inputJson ? { inputJson } : {}) }
        live.tools.set(update.toolCallId, meta)
        live.writer.append({ kind: "tool-call", at: this.now(), id: update.toolCallId, name: update.title ?? update.kind ?? "tool", input: update.rawInput ?? {}, acp: { ...(meta.kind ? { kind: meta.kind } : {}), ...(meta.title ? { title: meta.title } : {}), locations: meta.locations ?? [] } })
        if (update.status === "completed" || update.status === "failed") this.recordToolResult(live, update)
        return
      }
      case "tool_call_update": {
        let meta = live.tools.get(update.toolCallId)
        if (!meta) {
          // An update-first agent (or v2): the first sighting creates the call.
          meta = { written: false }
          live.tools.set(update.toolCallId, meta)
        }
        if (update.kind) meta.kind = update.kind
        if (update.title) meta.title = update.title
        if (update.locations?.length) meta.locations = update.locations.map((l) => l.path)
        if (!meta.written) {
          this.flushThought(live)
          this.flushText(live, false)
          meta.written = true
          const inputJson = nonEmptyInputJson(update.rawInput)
          if (inputJson) meta.inputJson = inputJson
          live.writer.append({ kind: "tool-call", at: this.now(), id: update.toolCallId, name: meta.title ?? meta.kind ?? "tool", input: update.rawInput ?? {}, acp: { ...(meta.kind ? { kind: meta.kind } : {}), ...(meta.title ? { title: meta.title } : {}), locations: meta.locations ?? [] } })
        }
        // A later update can carry what the first frame did not: opencode's `tool_call` has `{cwd}`, its
        // first `in_progress` update `{command, cwd}`, and the completing one no input at all.
        const inputJson = nonEmptyInputJson(update.rawInput)
        if (inputJson && inputJson !== meta.inputJson) {
          meta.inputJson = inputJson
          live.writer.append({ kind: "acp-tool-input", at: this.now(), id: update.toolCallId, input: update.rawInput, acp: { ...(meta.title ? { title: meta.title } : {}), ...(meta.locations ? { locations: meta.locations } : {}) } })
        }
        if (update.status === "completed" || update.status === "failed") this.recordToolResult(live, update)
        return
      }
      case "usage_update":
        // Keep the file in reading order: the text this usage reading follows goes first.
        this.flushText(live, false)
        // opencode reports `used: 0` on a cancelled turn (live 2026-09-15); a zero reading is not a
        // measurement and would drop the context dial to empty, so only a positive one is recorded.
        if (update.used > 0) live.writer.append({ kind: "context-usage", at: this.now(), tokens: update.used, window: update.size })
        return
      case "session_info_update":
        if (update.title) live.writer.append({ kind: "title", title: clip(update.title, 200) })
        if (opencodeCompactionStatus(update) === "completed") this.compacted(live)
        return
      case "config_option_update":
        this.adoptModel(live, update.configOptions)
        return
      case "compaction_update":
        // `in_progress`, then one of `completed` / `cancelled` / `failed`; only a completed one rewrote
        // the history the contract lived in.
        if (update.status === "completed") this.compacted(live)
        return
      case "plan":
      case "user_message_chunk":
      case "compaction_summary_chunk":
        return
      case "unknown":
        this.diagnostic(live.slug, "update", `unhandled session/update ${String((update.raw as { sessionUpdate?: unknown })?.sessionUpdate)}`)
        return
    }
  }

  /** The agent rewrote its history. The `compaction` record is the fold's (it sets `lastCompactionAt`,
   *  which the post-compaction Goal trigger reads, and the activity clock); the debt is this bridge's.
   *  A `session/load` replays old compactions too, but `handleNotification` drops replays (`loading`). */
  private compacted(live: LiveSession): void {
    this.flushThought(live)
    this.flushText(live, false)
    live.writer.append({ kind: "compaction", at: this.now() })
    live.contractOwed = "compaction"
  }

  private recordToolResult(live: LiveSession, tc: AcpToolCallUpdate): void {
    const meta = live.tools.get(tc.toolCallId)
    if (meta?.status === "completed" || meta?.status === "failed") return // already recorded
    if (meta) meta.status = tc.status
    // opencode 1.18's `tool_call` carried neither `rawInput` nor `locations`; both arrived on the completing
    // `tool_call_update` (live 2026-09-15). The result record carries them so the drawer's "edited N
    // files" can name the file instead of the tool. 2.0 sends the input earlier (`acp-tool-input`).
    const input = tc.rawInput && typeof tc.rawInput === "object" ? tc.rawInput as Record<string, unknown> : undefined
    live.writer.append({ kind: "tool-result", at: this.now(), id: tc.toolCallId, text: clip(toolResultText(tc), 20_000), acp: { ...(tc.status ? { kind: tc.status } : {}), ...(meta?.locations?.length ? { locations: meta.locations } : {}), ...(input && Object.keys(input).length ? { input } : {}) } })
  }

  // ---- the agent asking us ------------------------------------------------------------------------

  private async handleRequest(live: LiveSession, method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") return this.handlePermission(live, params)
    // fs/* and terminal/* were not advertised in clientCapabilities; an agent that calls them anyway
    // gets the spec's answer and does its own I/O.
    throw new AcpRequestError(ACP_ERROR_METHOD_NOT_FOUND, `frizz does not implement ${method}`)
  }

  private handlePermission(live: LiveSession, params: unknown): Promise<AcpRequestPermissionResult> {
    const parsed = AcpRequestPermissionParams.safeParse(params)
    const cancelled: AcpRequestPermissionResult = { outcome: { outcome: "cancelled" } }
    if (!parsed.success) return Promise.resolve(cancelled)
    const store = this.options.interactions
    const reject = parsed.data.options.find((o) => o.kind === "reject_once") ?? parsed.data.options.find((o) => o.kind === "reject_always")
    const failClosed: AcpRequestPermissionResult = reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : cancelled
    if (!store) { this.diagnostic(live.slug, "permission", "no interaction store; denying the request"); return Promise.resolve(failClosed) }
    const built = buildAcpPermissionInteraction(parsed.data, { projectId: this.options.projectId, threadSlug: live.slug, sessionId: live.sessionId, cwd: live.cwd }, { id: live.agent.id, label: live.agent.label })
    if (!built) { this.diagnostic(live.slug, "permission", "request could not be represented as a card; denying"); return Promise.resolve(failClosed) }
    const scope: InteractionSessionScope = { projectId: this.options.projectId, threadSlug: live.slug, sessionId: live.sessionId }
    let id: string
    try { id = store.create(built.request).interaction.id } catch (err) {
      this.diagnostic(live.slug, "permission", `could not record the approval: ${(err as Error).message}`)
      return Promise.resolve(failClosed)
    }
    return new Promise<AcpRequestPermissionResult>((resolve) => {
      live.pendingPerms.set(id, { resolve, optionByDecision: built.optionByDecision, scope })
      this.options.onStatusChange?.()
    })
  }

  /** Cancel every open card for a session that can no longer answer one, answering the agent
   *  `cancelled` for each. Hygiene, so it never throws. */
  private retirePermissions(live: LiveSession, reason: "turn-ended" | "provider-cancelled"): void {
    if (!live.pendingPerms.size) return
    const store = this.options.interactions
    let swept: Array<{ id: string }> = []
    try { swept = store?.cancelForSession(live.slug, live.sessionId, reason) ?? [] } catch { /* hygiene */ }
    for (const record of swept) live.pendingPerms.get(record.id)?.resolve({ outcome: { outcome: "cancelled" } })
    for (const [id, pending] of live.pendingPerms) { pending.resolve({ outcome: { outcome: "cancelled" } }); live.pendingPerms.delete(id) }
  }
}

export function createAcpBridge(options: AcpBridgeOptions): AcpBridge { return new AcpBridge(options) }
