import type { AntigravityModel, AntigravityModels, PermissionMode } from "@frizz/shared"
import type { InteractionSessionScope, InteractionStore } from "../interaction-store.ts"
import { log } from "../logging.ts"
import { frizzGithubWorkerEnv } from "../github-credential.ts"
import { findOnPath } from "./acp-agents.ts"
import { buildAcpPermissionInteraction } from "./acp-bridge.ts"
import { daemonAcpHost, directAcpHost, liveAcpDaemonRecord, stopAcpDaemon, type AcpHost } from "./acp-host.ts"
import { AcpConnection, AcpConnectionClosed, AcpRemoteError, AcpRequestError, spawnAcpChild, type AcpSpawn } from "./acp-rpc.ts"
import { AcpTranscriptWriter } from "./acp-transcript.ts"
import {
  ACP_ERROR_AUTH_REQUIRED, ACP_ERROR_INTERNAL, ACP_ERROR_METHOD_NOT_FOUND, ACP_PROTOCOL_VERSION,
  AcpInitializeResult, AcpNewSessionResult, AcpPromptResult, AcpRequestPermissionParams, AcpSessionNotification, AcpSetConfigOptionResult,
  contentText, parseSessionUpdate,
  type AcpConfigOption, type AcpInitializeResult as AcpInitializeResultType, type AcpRequestPermissionResult, type AcpToolCallUpdate,
} from "./acp-types.ts"
import { antigravityTranscriptPath, antigravityTurnOpen } from "./antigravity-transcript.ts"
import {
  ANTIGRAVITY_COMMAND, ANTIGRAVITY_LABEL, AntigravityElicitationParams,
  antigravityAnswerLabels, antigravityCommandLine, antigravityLaunchArgs, antigravityOption, antigravityPermissionParams, antigravityQuestionAnswer,
  antigravitySessionMode, antigravityTier, antigravityToolShape, buildAntigravityQuestionInteraction, isPlainFrizzctlCommand,
  type AntigravityElicitationResult, type AntigravityQuestionField,
} from "./antigravity-types.ts"
import { frizzCliEnv, withFrizzCliOnPath, type FrizzCli } from "./types.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"

// The Antigravity backend's bridge: one `agy acp` child per thread, in the same detached daemon an ACP
// agent gets (acp-daemon.ts), writing the thread's transcript itself (antigravity-transcript.ts). It
// speaks the Agent Client Protocol and reuses that transport whole (acp-rpc.ts, acp-host.ts), and it is
// its own bridge rather than a mode of acp-bridge.ts because what Antigravity adds to the protocol
// changes the shape of a turn (plans/antigravity-backend.md has every frame, measured on agy 1.5.12):
//
//   - STEER. A `session/prompt` sent while a turn runs joins that turn: the earlier prompt's response
//     returns at once and the work carries on, and the LAST prompt's response is the turn's end. So a
//     turn counts the prompts it has in flight, and a follow-up never queues.
//   - TURNS THE AGENT STARTS. A background command that finishes, a sub-agent that reports back and a
//     schedule that fires all wake the agent with no prompt outstanding, and nothing marks the end of
//     what it then does. The bridge opens a turn on the first frame of such a stretch and closes it when
//     a usage reading (the last frame of every model step) is followed by silence.
//   - THE CONTRACT IS A SYSTEM PROMPT. `session/new` takes `_meta.antigravity.systemPrompt.append`, and
//     the session keeps it across `session/resume` and `/compact`. Nothing is prepended to a prompt and
//     nothing is re-sent, where acp-bridge.ts has to do both.
//   - PROFILE. Model, thinking level and mode are session config options the agent does NOT keep across
//     a reopen, so every open applies all three. Bypass is not a mode but a launch flag
//     (`--dangerously-skip-permissions`): it is the only setting that takes the agent's shell out of
//     its sandbox, which otherwise cuts it off from `frizzctl`.
//   - QUESTIONS. `ask_question` reaches a client that advertises `elicitation.form` as an
//     `elicitation/create` request, which becomes a question card.

export interface AntigravityBridgeOptions {
  projectId: string
  stateDir: string
  /** Present ⇒ the agent's shell can run `frizzctl`: its directory goes on PATH and the agent's
   *  environment names the server, the project and the calling thread. */
  frizzCli?: FrizzCli
  interactions?: InteractionStore
  /** The operator's environment; filtered through inheritWorkerEnvironment before the child sees it. */
  env?: NodeJS.ProcessEnv
  /** Where `agy` is. Default: found on PATH at each open. */
  bin?: () => string | undefined
  /** Test seam: a plain child per open, no daemon, no reattach (wrapped as `directAcpHost`). */
  spawn?: AcpSpawn
  host?: AcpHost
  onDiagnostic?: (d: { threadSlug: string; kind: string; message: string }) => void
  /** The worker contract for a thread, appended to the system prompt of the session it starts. */
  contractFor?: (threadSlug: string, sessionId: string) => string | undefined
  /** Called whenever a turn starts or ends, so the board can refresh without polling. */
  onStatusChange?: () => void
  now?: () => Date
  initializeTimeoutMs?: number
  /** How long streamed text sits before it is flushed as a transcript record. */
  flushMs?: number
  /** How long a turn the agent started must stay silent, after a usage reading, to count as over. */
  quietMs?: number
  /** The same turn's last resort: silent this long with no card open, it is over whatever came last. */
  idleMs?: number
}

/** What a thread runs on. Each is applied at every open, and may be changed on a live session. */
export interface AntigravityProfile {
  modelId?: string | null
  /** The thinking level, in Frizz's effort words. Ignored for a model that takes none. */
  effort?: string | null
  permissionMode?: PermissionMode | null
}

export interface AntigravityOpenInput extends AntigravityProfile {
  threadSlug: string
  sessionId: string
  cwd: string
  /** Antigravity's own session id pinned on the row, for a resume after the agent has gone. */
  agySessionId?: string | null
}

export interface AntigravitySpawnDispatchInput extends AntigravityOpenInput {
  /** The first prompt: orientation, then the task. The contract is NOT in it (it is the system prompt). */
  prompt: string
  /** What the human actually wrote: the transcript records this. */
  userText: string
}

export interface AntigravityFollowUpInput extends AntigravityOpenInput {
  text: string
  deliveryId?: string
}

export interface AntigravitySessionInfo {
  agySessionId: string
  version?: string
  model?: string
  effort?: string
  mode?: string
}

export interface AntigravityFollowUpResult extends AntigravitySessionInfo {
  /** `steered`: a turn was running and the message joined it. */
  state: "delivered" | "steered"
  /** How the session was reached: already live, re-opened with its history, or started fresh. */
  resumed: "live" | "resumed" | "fresh"
}

export interface AntigravityTurnLiveness {
  sessionLive: boolean
  turnActive: boolean
  /** True for a turn the agent started itself (a background task or sub-agent woke it). */
  autonomous: boolean
}

type PendingCard =
  | { kind: "permission"; resolve: (result: AcpRequestPermissionResult) => void; optionByDecision: Map<string, string>; scope: InteractionSessionScope }
  | { kind: "question"; resolve: (result: AntigravityElicitationResult) => void; params: AntigravityElicitationParams; fields: AntigravityQuestionField[]; toolCallId?: string; scope: InteractionSessionScope }

interface Turn {
  startedAt: string
  /** `session/prompt` requests not yet answered. Zero only on a turn the agent started. */
  outstanding: number
  autonomous: boolean
  /** Streamed text not yet written to the transcript. */
  text: string
  messageId: string
  /** Everything the CURRENT agent message has said, flushed or not: the turn's final text. */
  messageText: string
  thought: string
  flushTimer?: NodeJS.Timeout
  quietTimer?: NodeJS.Timeout
  idleTimer?: NodeJS.Timeout
  cancelRequested: boolean
  /** The agent has said something during this turn, so a prompt reached it. */
  heard: boolean
  /** A prompt of this turn was `/compact` and has not returned yet. */
  compacting: boolean
  done: Promise<void>
  finish: () => void
}

interface ToolMeta { name: string; done: boolean; background?: boolean }

interface Live {
  slug: string
  sessionId: string
  cwd: string
  conn: AcpConnection
  init: AcpInitializeResultType
  agySessionId: string
  writer: AcpTranscriptWriter
  /** Launched with `--dangerously-skip-permissions`. */
  bypass: boolean
  /** The profile last asked for, so a restart for a bypass change can reopen on it. */
  wanted: AntigravityProfile
  model?: string
  effort?: string
  mode?: string
  turn?: Turn
  messageSeq: number
  cards: Map<string, PendingCard>
  tools: Map<string, ToolMeta>
  /** The slash commands the agent last listed for this session (`available_commands_update`). */
  commands: Array<{ name: string; description: string }>
  /** Calls whose result is written, newest last and bounded: a repeated closing frame is not a new call. */
  settled: string[]
  /** What a question card answered, by the `ask_question` call it belongs to, for that call's result row. */
  answers: Map<string, Array<string | null>>
  exited: boolean
  /** True from `shutdown()` on: the socket is being DETACHED from a daemon that keeps running. */
  detaching: boolean
  /** True from the moment the session is being ended: nothing more goes out on it. */
  ending: boolean
  /** The launch flag no longer matches the thread's mode; the agent restarts once its turn is over. */
  restartOwed: boolean
}

const AUTH_HINT = `${ANTIGRAVITY_LABEL} needs a sign-in first: run \`agy\` in a terminal and sign in, then send this again. `
const MODEL_CACHE_MS = 10 * 60_000
const DEFAULT_QUIET_MS = 2_000
const DEFAULT_IDLE_MS = 5 * 60_000
const SETTLED_KEPT = 400
const WAKE_TEXT = "Antigravity carried on by itself: a background task, a sub-agent or a schedule reported back."

function clip(text: string, max: number): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text }

/** A tool call's own name. `agy` sends it beside the protocol's fields, on every frame of the call. */
function toolName(tc: AcpToolCallUpdate): string | undefined {
  const name = (tc as { name?: unknown }).name
  return typeof name === "string" && name ? name : undefined
}

/** The text a tool call's result carries. A command's is `agy`'s own report (start and finish stamps,
 *  the exit code, then `Command output:`), of which only the output is the command's. */
function toolResultText(tc: AcpToolCallUpdate): string {
  const parts: string[] = []
  for (const c of tc.content ?? []) {
    if (c.type === "content") { const t = contentText((c as { content: Parameters<typeof contentText>[0] }).content); if (t) parts.push(t) }
    else if (c.type === "diff") parts.push(`--- ${(c as { path: string }).path}\n${(c as { newText: string }).newText}`)
  }
  const raw = tc.rawOutput as { output?: unknown } | undefined
  let text = parts.length ? parts.join("\n") : raw && typeof raw === "object" && typeof raw.output === "string" ? raw.output : typeof tc.rawOutput === "string" ? tc.rawOutput : ""
  const marker = "Command output:\n"
  const at = text.indexOf(marker)
  if (at !== -1 && /^Created At: /.test(text)) text = text.slice(at + marker.length)
  return text.replace(/\r\n/g, "\n")
}

function exitCode(tc: AcpToolCallUpdate): number | undefined {
  const code = (tc.rawOutput as { exit_code?: unknown } | undefined)?.exit_code
  return typeof code === "number" ? code : undefined
}

export class AntigravityBridge {
  private readonly sessions = new Map<string, Live>()
  // Opens in flight, by Frizz session id: one open per session at a time (acp-bridge.ts `openOnce`).
  private readonly opening = new Map<string, Promise<{ live: Live; resumed: "resumed" | "fresh" | "reattached" }>>()
  private readonly ending = new Map<string, Promise<void>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly unsubscribe: (() => void) | undefined
  private closed = false

  constructor(private readonly options: AntigravityBridgeOptions) {
    // A resolved (or cancelled, or expired) card answers the agent. The store holds the card; this map
    // only knows which live request it belongs to.
    this.unsubscribe = options.interactions?.subscribe((change) => {
      if (change.lifecycle === "pending") return
      for (const live of this.sessions.values()) {
        const card = live.cards.get(change.interactionId)
        if (!card) continue
        live.cards.delete(change.interactionId)
        const record = options.interactions!.get(card.scope, change.interactionId)
        const resolution = change.lifecycle === "resolved" ? record?.resolution : undefined
        if (card.kind === "permission") {
          const optionId = resolution?.decisionId ? card.optionByDecision.get(resolution.decisionId) : undefined
          card.resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } })
        } else if (resolution?.decisionId === "answer") {
          const content = antigravityQuestionAnswer(card.fields, resolution.values as Record<string, unknown> | undefined)
          if (card.toolCallId) live.answers.set(card.toolCallId, antigravityAnswerLabels(card.params, card.fields, content))
          card.resolve({ action: "accept", content })
        } else {
          card.resolve(resolution ? { action: "decline" } : { action: "cancel" })
        }
        this.options.onStatusChange?.()
      }
    })
  }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString() }

  private diagnostic(slug: string, kind: string, message: string): void {
    this.options.onDiagnostic?.({ threadSlug: slug, kind, message })
    if (kind !== "stderr") log.debug("antigravity", `[${slug}] ${kind}: ${message}`)
  }

  /** Where `agy` is, or undefined when it is not installed. */
  bin(): string | undefined {
    return this.options.bin ? this.options.bin() : findOnPath(ANTIGRAVITY_COMMAND, this.options.env ?? process.env)
  }

  private requireBin(): string {
    const bin = this.bin()
    if (!bin) throw new Error(`${ANTIGRAVITY_LABEL} is not installed: \`${ANTIGRAVITY_COMMAND}\` is not on PATH. Install the Antigravity CLI (https://antigravity.google/docs/cli), sign in by running \`agy\`, and send this again.`)
    return bin
  }

  private host(): AcpHost {
    return this.options.host ?? (this.options.spawn ? directAcpHost(this.options.spawn) : daemonAcpHost)
  }

  private workerEnv(slug: string): Record<string, string> {
    const cli = this.options.frizzCli
    const inherited = { ...inheritWorkerEnvironment(this.options.env ?? process.env), ...frizzGithubWorkerEnv(this.options.env ?? process.env) }
    return cli ? withFrizzCliOnPath({ ...inherited, ...frizzCliEnv(cli, slug) }, cli) : inherited
  }

  // ---- session lifecycle --------------------------------------------------------------------------

  /** Spawn (or reattach to) the agent, initialize, and resume or create the session, then put the
   *  thread's profile on it. Throws an actionable error on any failure and leaves nothing behind. */
  private async open(input: AntigravityOpenInput): Promise<{ live: Live; resumed: "resumed" | "fresh" | "reattached" }> {
    const { threadSlug: slug, sessionId, cwd } = input
    const bin = this.requireBin()
    await this.sessionEnded(sessionId)
    const bypass = input.permissionMode === "bypassPermissions"
    const attachment = await this.host()({ stateDir: this.options.stateDir, threadSlug: slug, sessionId, command: bin, args: antigravityLaunchArgs(input.permissionMode), cwd, env: this.workerEnv(slug) })
    const writer = new AcpTranscriptWriter(antigravityTranscriptPath(this.options.stateDir, sessionId))
    // Read BEFORE this open writes anything: a turn the previous runtime left open in the file.
    const turnLeftOpen = antigravityTurnOpen(writer.path)
    let live: Live | undefined
    // Traffic that arrives before the session is READY is held, not dropped or refused: on a reattach
    // the daemon replays what the agent said while Frizz was away the instant the socket opens.
    let isReady = false
    const held: Array<() => void> = []
    const ready = (): void => { isReady = true; for (const run of held.splice(0)) run() }
    const conn = new AcpConnection(attachment.process, {
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
      await stopAcpDaemon(this.options.stateDir, sessionId).catch(() => {})
      const stderr = conn.recentStderr.slice(-3).join(" | ")
      const e = err instanceof Error ? err : new Error(String(err))
      throw new Error(`${e.message}${stderr ? ` (agy stderr: ${clip(stderr, 400)})` : ""}`)
    }
    let init: AcpInitializeResultType
    try {
      init = AcpInitializeResult.parse(await conn.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // `elicitation.form` is what makes `ask_question` arrive as a request Frizz can answer.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
        clientInfo: { name: "frizz", version: "0" },
      }))
    } catch (err) { return fail(err instanceof Error ? new Error(`${ANTIGRAVITY_LABEL} did not complete the ACP handshake: ${err.message}`) : err) }
    live = {
      slug, sessionId, cwd, conn, init, agySessionId: "", writer, bypass,
      wanted: { modelId: input.modelId ?? null, effort: input.effort ?? null, permissionMode: input.permissionMode ?? null },
      messageSeq: 0, cards: new Map(), tools: new Map(), commands: [], settled: [], answers: new Map(), exited: false, detaching: false, ending: false, restartOwed: false,
    }
    const current = live
    void conn.exited.then(() => this.onExit(current))

    // REATTACHED to an agent that outlived a Frizz restart: the session is open (the daemon reports its
    // id) and prompts may still be running. Adopt every one of them as the live turn. With none in
    // flight but a turn left open in the file, the agent finished (or is still working by itself) while
    // nobody listened: the replayed frames land in that turn, and the quiet rule closes it.
    if (attachment.reattached && attachment.hello.acpSessionId) {
      live.agySessionId = attachment.hello.acpSessionId
      writer.append({ kind: "acp-note", at: this.now(), text: `Reattached to the running ${ANTIGRAVITY_LABEL} session after a Frizz restart.` })
      if (attachment.hello.droppedWhileDetached > 0) {
        writer.append({ kind: "acp-note", at: this.now(), text: `${attachment.hello.droppedWhileDetached} message(s) from the agent were lost while Frizz was away; the transcript may have gaps.` })
      }
      this.sessions.set(sessionId, live)
      const prompts = attachment.hello.outstanding.filter((o) => o.method === "session/prompt")
      if (prompts.length) {
        const turn = this.newTurn(live, false)
        live.turn = turn
        for (const prompt of prompts) {
          turn.outstanding++
          void this.awaitPrompt(live, turn, conn.adoptPending("session/prompt", (id) => attachment.adopt(prompt.daemonId, id)), false)
        }
      } else if (turnLeftOpen) {
        const turn = this.newTurn(live, true)
        live.turn = turn
        this.armQuiet(live, turn)
      }
      this.options.onStatusChange?.()
      ready()
      return { live, resumed: "reattached" }
    }
    ready()
    // A turn left open by an agent that is gone will never be closed by it.
    if (turnLeftOpen) {
      const at = this.now()
      writer.append({ kind: "turn-end", at, successful: false })
      writer.append({ kind: "acp-note", at, text: `The ${ANTIGRAVITY_LABEL} agent stopped while this turn was running.` })
    }

    const authError = (err: AcpRemoteError): Error => new Error(`${AUTH_HINT}(${err.error.message})`)
    let resumed: "resumed" | "fresh" = "fresh"
    if (input.agySessionId && init.agentCapabilities?.sessionCapabilities?.resume !== undefined) {
      try {
        // `session/resume`, not `session/load`: Frizz holds the transcript, and a load replays all of it.
        const result = AcpSetConfigOptionResult.parse(await conn.request("session/resume", { sessionId: input.agySessionId, cwd, mcpServers: [] }))
        live.agySessionId = input.agySessionId
        this.adoptConfig(live, result.configOptions)
        resumed = "resumed"
      } catch (err) {
        if (err instanceof AcpRemoteError && err.error.code === ACP_ERROR_AUTH_REQUIRED) return fail(authError(err))
        this.diagnostic(slug, "protocol", `session/resume ${input.agySessionId} failed (${(err as Error).message}); starting a fresh session`)
      }
    }
    if (!live.agySessionId) {
      const contract = this.options.contractFor?.(slug, sessionId)
      try {
        const created = AcpNewSessionResult.parse(await conn.request("session/new", {
          cwd, mcpServers: [],
          ...(contract ? { _meta: { antigravity: { systemPrompt: { append: contract } } } } : {}),
        }))
        live.agySessionId = created.sessionId
        this.adoptConfig(live, created.configOptions)
      } catch (err) {
        if (err instanceof AcpRemoteError && err.error.code === ACP_ERROR_AUTH_REQUIRED) return fail(authError(err))
        return fail(err instanceof Error ? new Error(`${ANTIGRAVITY_LABEL} could not open a session: ${err.message}`) : err)
      }
    }
    // The thread's profile, applied before the header so the header records what is in effect.
    const problems = await this.applyProfile(live, input)
    if (resumed === "fresh") {
      writer.append({ kind: "acp-session", at: this.now(), agent: { id: "antigravity", name: ANTIGRAVITY_LABEL, ...(init.agentInfo?.version ? { version: init.agentInfo.version } : {}) }, acpSessionId: live.agySessionId, cwd, ...(live.model ? { model: live.model } : {}) })
      if (input.agySessionId) writer.append({ kind: "acp-note", at: this.now(), text: `Resumed with a fresh ${ANTIGRAVITY_LABEL} session: the previous one (${input.agySessionId}) could not be resumed, so the agent no longer has the earlier conversation.` })
    }
    for (const problem of problems) writer.append({ kind: "acp-note", at: this.now(), text: problem })
    this.sessions.set(sessionId, live)
    return { live, resumed }
  }

  private openOnce(input: AntigravityOpenInput): Promise<{ live: Live; resumed: "resumed" | "fresh" | "reattached" }> {
    const inflight = this.opening.get(input.sessionId)
    if (inflight) return inflight
    const opening = this.open(input).finally(() => { if (this.opening.get(input.sessionId) === opening) this.opening.delete(input.sessionId) })
    this.opening.set(input.sessionId, opening)
    return opening
  }

  private adoptConfig(live: Live, configOptions: readonly AcpConfigOption[] | null | undefined): void {
    if (!configOptions?.length) return
    const read = (id: "model" | "thought_level" | "mode"): string | undefined => {
      const value = antigravityOption(configOptions, id)?.currentValue
      return typeof value === "string" ? value : undefined
    }
    live.model = read("model") ?? live.model
    // A model with no thinking levels has no such option at all, so its absence is the reading.
    live.effort = read("thought_level")
    live.mode = read("mode") ?? live.mode
  }

  private async setOption(live: Live, configId: "model" | "thought_level" | "mode", value: string): Promise<readonly AcpConfigOption[] | undefined> {
    const result = AcpSetConfigOptionResult.parse(await live.conn.request("session/set_config_option", { sessionId: live.agySessionId, configId, value }))
    this.adoptConfig(live, result.configOptions)
    return result.configOptions ?? undefined
  }

  /** Put the thread's model, thinking level and mode on the session, in that order: changing the model
   *  resets the level to that model's own default. Returns a note for each one the agent refused; the
   *  thread runs on, on what the agent kept, and the note says what that is. */
  private async applyProfile(live: Live, profile: AntigravityProfile): Promise<string[]> {
    const problems: string[] = []
    const attempt = async (configId: "model" | "thought_level" | "mode", value: string, describe: (message: string) => string): Promise<void> => {
      try { await this.setOption(live, configId, value) } catch (err) {
        const message = err instanceof AcpRemoteError ? err.error.message : (err as Error).message
        this.diagnostic(live.slug, "protocol", `session/set_config_option ${configId}=${value} failed: ${message}`)
        problems.push(describe(clip(message, 200)))
      }
    }
    if (profile.modelId && profile.modelId !== live.model) {
      await attempt("model", profile.modelId, (m) => `${ANTIGRAVITY_LABEL} could not switch to ${profile.modelId} (${m}); the session runs on ${live.model ?? "its own default model"}.`)
    }
    // A level the model does not take is not asked for: the option is absent on a model with none.
    if (profile.effort && live.effort !== undefined && profile.effort !== live.effort) {
      await attempt("thought_level", profile.effort, (m) => `${ANTIGRAVITY_LABEL} could not set the thinking level to ${profile.effort} (${m}); the session runs at ${live.effort ?? "the model's default"}.`)
    }
    const mode = antigravitySessionMode(profile.permissionMode)
    if (mode !== live.mode) {
      await attempt("mode", mode, (m) => `${ANTIGRAVITY_LABEL} could not switch to its ${mode} mode (${m}); the session stays in ${live.mode ?? "its default mode"}.`)
    }
    return problems
  }

  private onExit(live: Live): void {
    if (live.exited) return
    live.exited = true
    this.retireCards(live, "provider-cancelled")
    const turn = live.turn
    // A turn with a prompt in flight is ended by that prompt's rejection (`awaitPrompt`). One the agent
    // started has no such request, so its ending is written here.
    if (turn && turn.outstanding === 0 && !live.detaching) this.endTurn(live, turn, { successful: false, note: `The ${ANTIGRAVITY_LABEL} agent stopped.` })
    if (this.sessions.get(live.sessionId) === live) this.sessions.delete(live.sessionId)
    this.options.onStatusChange?.()
  }

  // ---- public API ---------------------------------------------------------------------------------

  async spawnDispatch(input: AntigravitySpawnDispatchInput): Promise<AntigravitySessionInfo> {
    if (this.closed) throw new Error("Antigravity bridge is closed")
    const { live } = await this.openOnce(input)
    this.sendPrompt(live, input.prompt, input.userText)
    return this.info(live)
  }

  /** Deliver a follow-up: to the live session (joining its turn when one is running), or to a re-opened
   *  one. Returns the (possibly new) Antigravity session id so the caller can re-pin it. */
  async followUp(input: AntigravityFollowUpInput): Promise<AntigravityFollowUpResult> {
    if (this.closed) throw new Error("Antigravity bridge is closed")
    await this.sessionEnded(input.sessionId)
    let live = this.sessions.get(input.sessionId)
    const pinned = input.agySessionId ?? live?.agySessionId ?? null
    // The launch flag is stale and nothing is running: this is the moment to restart on the right one.
    if (live && live.restartOwed && !live.turn) {
      await this.endSession(input.threadSlug, input.sessionId)
      live = undefined
    }
    let resumed: AntigravityFollowUpResult["resumed"] = "live"
    if (!live || live.exited || live.conn.closed) {
      const opened = await this.openOnce({ ...input, agySessionId: pinned })
      live = opened.live
      resumed = opened.resumed === "reattached" ? "live" : opened.resumed
    }
    const steered = live.turn !== undefined
    this.sendPrompt(live, input.text, input.text)
    return { ...this.info(live), state: steered ? "steered" : "delivered", resumed }
  }

  /** `session/cancel`, then wait (bounded) for the turn to end. `interrupted: false` when none ran. */
  async interruptTurn(threadSlug: string, sessionId: string): Promise<{ interrupted: boolean }> {
    const live = this.sessions.get(sessionId)
    const turn = live?.turn
    if (!live || live.slug !== threadSlug || !turn) return { interrupted: false }
    turn.cancelRequested = true
    live.conn.notify("session/cancel", { sessionId: live.agySessionId })
    // A turn the agent started has no prompt whose return would end it: give the cancel a moment to
    // land (a cancelled call reports `failed` within a couple of seconds), then end it here.
    if (turn.outstanding === 0) {
      await Promise.race([turn.done, new Promise<void>((r) => setTimeout(r, 2_500).unref?.())])
      if (live.turn === turn) this.endTurn(live, turn, { successful: false, note: "Turn cancelled." })
      return { interrupted: true }
    }
    const settled = await Promise.race([turn.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000).unref?.())])
    if (!settled) await live.conn.close(1_000)
    return { interrupted: true }
  }

  /** STOP the worker: cancel its turn, wait for it, and end the agent. Until the daemon is gone a
   *  follow-up waits (`sessionEnded`), so it opens a new agent rather than joining the old one's ending. */
  endSession(threadSlug: string, sessionId: string): Promise<void> {
    const inflight = this.ending.get(sessionId)
    if (inflight) return inflight
    const live = this.sessions.get(sessionId)
    if (live && live.slug === threadSlug) live.ending = true
    const run = Promise.resolve().then(async () => {
      if (live && live.slug === threadSlug && live.turn) await this.interruptTurn(threadSlug, sessionId)
      this.releaseSession(threadSlug, sessionId)
      await this.stopping.get(sessionId)
    }).finally(() => { if (this.ending.get(sessionId) === run) this.ending.delete(sessionId) })
    this.ending.set(sessionId, run)
    return run
  }

  isEnding(sessionId: string): boolean { return this.ending.has(sessionId) || this.stopping.has(sessionId) }

  private async sessionEnded(sessionId: string): Promise<void> {
    await this.ending.get(sessionId)?.catch(() => {})
    await this.stopping.get(sessionId)
  }

  /** END the session's agent: cancel its turn, drop its cards, and stop the daemon holding it. The
   *  teardown for a thread that is dismissed, replaced or marked done, never for a restart (`shutdown`). */
  releaseSession(threadSlug: string, sessionId: string): void {
    const live = this.sessions.get(sessionId)
    if (live && live.slug === threadSlug) {
      this.sessions.delete(sessionId)
      live.ending = true
      this.retireCards(live, "provider-cancelled")
      const turn = live.turn
      if (turn) {
        turn.cancelRequested = true
        live.conn.notify("session/cancel", { sessionId: live.agySessionId })
        if (turn.outstanding === 0) this.endTurn(live, turn, { successful: false, note: "Turn cancelled." })
      }
      void live.conn.close(3_000)
    }
    const stopped = stopAcpDaemon(this.options.stateDir, sessionId).catch(() => {}).finally(() => { if (this.stopping.get(sessionId) === stopped) this.stopping.delete(sessionId) })
    this.stopping.set(sessionId, stopped)
  }

  /** Boot-time reattach: every session in `rows` whose daemon is still running is re-opened now, so a
   *  turn that survived the restart is live on the board before the next input rather than after it. */
  async warmUp(rows: ReadonlyArray<AntigravityOpenInput>): Promise<void> {
    for (const row of rows) {
      if (this.closed) return
      if (!liveAcpDaemonRecord(this.options.stateDir, row.sessionId)) continue
      if (this.sessions.has(row.sessionId)) continue
      try { await this.openOnce(row) } catch (err) {
        this.diagnostic(row.threadSlug, "reattach", `could not reattach to the running agent: ${(err as Error).message}`)
      }
    }
  }

  /**
   * Change a LIVE session's model, thinking level or mode. `applied: false` when the session is not
   * open: the caller's stored profile reaches the agent at the next open. A change to or from Bypass
   * cannot be made on a running agent (it is a launch flag), so the agent is restarted: at once when it
   * is idle, and when its turn ends otherwise. The session resumes with its history either way.
   */
  async setProfile(threadSlug: string, sessionId: string, profile: AntigravityProfile): Promise<{ applied: boolean; restarting?: boolean; model?: string; effort?: string }> {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug || live.exited || live.conn.closed) return { applied: false }
    live.wanted = { modelId: profile.modelId ?? null, effort: profile.effort ?? null, permissionMode: profile.permissionMode ?? null }
    const problems = await this.applyProfile(live, profile)
    for (const problem of problems) live.writer.append({ kind: "acp-note", at: this.now(), text: problem })
    const wantsBypass = profile.permissionMode === "bypassPermissions"
    if (wantsBypass !== live.bypass) {
      live.restartOwed = true
      if (!live.turn) await this.endSession(threadSlug, sessionId)
      return { applied: true, restarting: true, ...(live.model ? { model: live.model } : {}), ...(live.effort ? { effort: live.effort } : {}) }
    }
    live.restartOwed = false
    return { applied: true, ...(live.model ? { model: live.model } : {}), ...(live.effort ? { effort: live.effort } : {}) }
  }

  /** An agent process exists for the session: attached here, or held by a daemon not yet reattached to. */
  isAgentAlive(threadSlug: string, sessionId: string): boolean {
    const live = this.sessions.get(sessionId)
    if (live && live.slug === threadSlug && !live.exited && !live.conn.closed) return true
    return liveAcpDaemonRecord(this.options.stateDir, sessionId) !== null
  }

  turnLiveness(threadSlug: string, sessionId: string): AntigravityTurnLiveness | undefined {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug) return undefined
    return { sessionLive: !live.exited && !live.conn.closed, turnActive: live.turn !== undefined, autonomous: live.turn?.autonomous === true }
  }

  session(threadSlug: string, sessionId: string): AntigravitySessionInfo | undefined {
    const live = this.sessions.get(sessionId)
    return live && live.slug === threadSlug ? this.info(live) : undefined
  }

  /** The session's slash commands, for the composer's `/` list. Empty until a session is live. */
  commands(threadSlug: string, sessionId: string): Array<{ name: string; description: string }> {
    const live = this.sessions.get(sessionId)
    return live && live.slug === threadSlug ? [...live.commands] : []
  }

  ownsInteraction(scope: InteractionSessionScope, interactionId: string): boolean {
    const live = this.sessions.get(scope.sessionId)
    return live !== undefined && live.slug === scope.threadSlug && live.cards.has(interactionId)
  }

  /** DETACH from every agent: the daemons and their turns keep running for the next runtime to reattach
   *  to. Open cards are cancelled on OUR side only; the agent's request stays unanswered in its daemon,
   *  which sends it again on reattach, so the card is raised afresh. */
  async shutdown(): Promise<void> {
    this.closed = true
    this.unsubscribe?.()
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map(async (live) => {
      live.detaching = true
      if (live.turn) this.clearTimers(live.turn)
      if (live.cards.size) {
        live.cards.clear()
        try { this.options.interactions?.cancelForSession(live.slug, live.sessionId, "provider-cancelled") } catch { /* hygiene */ }
      }
      await live.conn.close(1_000)
    }))
  }

  private info(live: Live): AntigravitySessionInfo {
    return {
      agySessionId: live.agySessionId,
      ...(live.init.agentInfo?.version ? { version: live.init.agentInfo.version } : {}),
      ...(live.model ? { model: live.model } : {}),
      ...(live.effort ? { effort: live.effort } : {}),
      ...(live.mode ? { mode: live.mode } : {}),
    }
  }

  // ---- the model catalogue --------------------------------------------------------------------------

  private modelProbe: Promise<AntigravityModels> | undefined
  private modelCache: { at: number; value: AntigravityModels } | undefined

  /** The models the signed-in account is offered, each with its own thinking levels, read from a
   *  throwaway session (there is no other way to ask) by selecting each model in turn, which costs no
   *  tokens. Cached for ten minutes; a probe that cannot open a session yields an empty list with the
   *  reason, never a throw, so the composer says what to do. */
  models(cwd: string, opts: { refresh?: boolean } = {}): Promise<AntigravityModels> {
    if (this.modelCache && !opts.refresh && Date.now() - this.modelCache.at < MODEL_CACHE_MS) return Promise.resolve(this.modelCache.value)
    if (this.modelProbe) return this.modelProbe
    const probe = this.probeModels(cwd).then((value) => {
      if (!value.error) this.modelCache = { at: Date.now(), value }
      return value
    }).finally(() => { this.modelProbe = undefined })
    this.modelProbe = probe
    return probe
  }

  private async probeModels(cwd: string): Promise<AntigravityModels> {
    const bin = this.bin()
    if (!bin) return { available: false, models: [], error: `${ANTIGRAVITY_LABEL} is not installed: \`${ANTIGRAVITY_COMMAND}\` is not on PATH.` }
    const empty = (error: string, version?: string): AntigravityModels => ({ available: true, ...(version ? { version } : {}), models: [], error: clip(error, 400) })
    const spawn = this.options.spawn ?? spawnAcpChild
    let proc: ReturnType<typeof spawnAcpChild>
    try { proc = spawn({ command: bin, args: antigravityLaunchArgs(null), cwd, env: inheritWorkerEnvironment(this.options.env ?? process.env) }) } catch (err) { return empty(`${ANTIGRAVITY_LABEL} could not start: ${(err as Error).message}`) }
    const conn = new AcpConnection(proc, {
      onRequest: () => Promise.reject(new AcpRequestError(ACP_ERROR_METHOD_NOT_FOUND, "probe session takes no requests")),
      onNotification: () => {},
      onDiagnostic: (d) => this.diagnostic("probe", d.kind, d.message),
      requestTimeoutMs: this.options.initializeTimeoutMs ?? 60_000,
    })
    let version: string | undefined
    try {
      const init = AcpInitializeResult.parse(await conn.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "frizz", version: "0" },
      }))
      version = init.agentInfo?.version
      const created = AcpNewSessionResult.parse(await conn.request("session/new", { cwd, mcpServers: [] }))
      const modelOption = antigravityOption(created.configOptions, "model")
      const defaultModel = typeof modelOption?.currentValue === "string" ? modelOption.currentValue : undefined
      const levelsOf = (configOptions: readonly AcpConfigOption[] | null | undefined): Pick<AntigravityModel, "efforts" | "defaultEffort"> => {
        const option = antigravityOption(configOptions, "thought_level")
        return { efforts: (option?.options ?? []).map((o) => o.value), ...(typeof option?.currentValue === "string" ? { defaultEffort: option.currentValue } : {}) }
      }
      const models: AntigravityModel[] = []
      for (const entry of modelOption?.options ?? []) {
        let levels = entry.value === defaultModel ? levelsOf(created.configOptions) : { efforts: [] as string[] }
        if (entry.value !== defaultModel) {
          try {
            const switched = AcpSetConfigOptionResult.parse(await conn.request("session/set_config_option", { sessionId: created.sessionId, configId: modelOption?.id ?? "model", value: entry.value }))
            levels = levelsOf(switched.configOptions)
          } catch (err) { this.diagnostic("probe", "protocol", `could not read ${entry.value}'s thinking levels: ${(err as Error).message}`) }
        }
        models.push({ id: entry.value, name: entry.name ?? entry.value, ...levels })
      }
      const tier = antigravityTier(created)
      if (init.agentCapabilities?.sessionCapabilities?.close !== undefined) await conn.request("session/close", { sessionId: created.sessionId }).catch(() => {})
      return { available: true, ...(version ? { version } : {}), ...(defaultModel ? { defaultModel } : {}), ...(tier?.name ? { tier: tier.name } : {}), models }
    } catch (err) {
      const message = err instanceof AcpRemoteError && err.error.code === ACP_ERROR_AUTH_REQUIRED
        ? `${ANTIGRAVITY_LABEL} is not signed in. Run \`agy\` in a terminal and sign in.`
        : `${ANTIGRAVITY_LABEL}: ${(err as Error).message}`
      return empty(message, version)
    } finally {
      await conn.close(500)
    }
  }

  // ---- the turn -------------------------------------------------------------------------------------

  private newTurn(live: Live, autonomous: boolean): Turn {
    let finish!: () => void
    const done = new Promise<void>((r) => { finish = r })
    return { startedAt: this.now(), outstanding: 0, autonomous, text: "", messageId: `m${++live.messageSeq}`, messageText: "", thought: "", cancelRequested: false, heard: false, compacting: false, done, finish }
  }

  /** Send one prompt: it starts a turn, or joins the one running (a steer). The transcript records the
   *  words either way, and a turn the agent had started by itself becomes the prompt's from here on. */
  private sendPrompt(live: Live, sendText: string, recordText: string): void {
    const at = this.now()
    let turn = live.turn
    if (turn) {
      // What the agent said before these words is commentary on the turn so far, not the answer to them.
      this.flushThought(live)
      this.flushText(live, false)
      this.nextMessage(live, turn)
      live.writer.append({ kind: "user-message", at, text: recordText, synthetic: false })
      if (turn.autonomous) { turn.autonomous = false; this.clearTimers(turn) }
    } else {
      turn = this.newTurn(live, false)
      live.turn = turn
      live.writer.append({ kind: "user-message", at: turn.startedAt, text: recordText, synthetic: false })
      live.writer.append({ kind: "turn-start", at: turn.startedAt })
    }
    turn.outstanding++
    const compact = /^\/compact(?:\s|$)/.test(sendText.trimStart())
    if (compact) turn.compacting = true
    this.options.onStatusChange?.()
    void this.awaitPrompt(live, turn, live.conn.requestOpenEnded("session/prompt", { sessionId: live.agySessionId, prompt: [{ type: "text", text: sendText }] }), compact)
  }

  /** Wait for one `session/prompt`. Only the LAST one in flight ends the turn: an earlier one returns
   *  the moment a later one steers it, with the work still going. */
  private async awaitPrompt(live: Live, turn: Turn, response: Promise<unknown>, compact: boolean): Promise<void> {
    let raw: unknown
    let failure: unknown
    try { raw = await response } catch (err) { failure = err ?? new Error("prompt failed") }
    turn.outstanding = Math.max(0, turn.outstanding - 1)
    // DETACHING, not ending: `shutdown()` closed the socket to a daemon whose agent is still running
    // this turn. Leave the turn OPEN in the file; the next runtime reattaches, adopts it and ends it.
    if (failure && live.detaching && failure instanceof AcpConnectionClosed) {
      if (turn.outstanding === 0) { this.clearTimers(turn); this.flushThought(live); this.flushText(live, false); turn.finish() }
      return
    }
    if (live.turn !== turn) return // already ended (a stop, the agent's exit)
    if (failure) {
      const abortedByUs = turn.cancelRequested && (failure instanceof AcpConnectionClosed || (failure instanceof AcpRemoteError && failure.error.code === ACP_ERROR_INTERNAL))
      if (abortedByUs) {
        if (turn.outstanding === 0) this.endTurn(live, turn, { successful: false, note: "Turn cancelled." })
        return
      }
      const message = failure instanceof AcpRemoteError
        ? (failure.error.code === ACP_ERROR_AUTH_REQUIRED ? `${AUTH_HINT}(${failure.error.message})` : failure.error.message)
        : (failure as Error).message
      const unread = failure instanceof AcpConnectionClosed && !turn.heard
      this.flushThought(live)
      this.flushText(live, false)
      live.writer.append({ kind: "provider-error", at: this.now(), error: { message: clip(message, 2_000), ...(failure instanceof AcpRemoteError ? { code: String(failure.error.code) } : {}), ...(unread ? { details: "The agent did not read this message. Send it again to restart the agent." } : {}) } })
      if (turn.outstanding === 0) this.endTurn(live, turn, { successful: false })
      return
    }
    const result = AcpPromptResult.safeParse(raw)
    const stopReason = result.success ? result.data.stopReason : "end_turn"
    if (compact && stopReason === "end_turn") {
      turn.compacting = false
      this.flushThought(live)
      this.flushText(live, false)
      live.writer.append({ kind: "compaction", at: this.now() })
    }
    if (turn.outstanding > 0) return
    if (stopReason === "cancelled") { this.endTurn(live, turn, { successful: false, note: "Turn cancelled." }); return }
    this.endTurn(live, turn, { successful: stopReason !== "refusal" })
  }

  /** Write the turn's ending and let go of it. */
  private endTurn(live: Live, turn: Turn, outcome: { successful: boolean; note?: string }): void {
    if (live.turn !== turn) return
    this.clearTimers(turn)
    this.flushThought(live)
    const finalText = this.flushText(live, true)
    const at = this.now()
    live.writer.append({ kind: "turn-end", at, ...(finalText !== undefined ? { finalText } : {}), successful: outcome.successful })
    if (outcome.note) live.writer.append({ kind: "acp-note", at, text: outcome.note })
    this.retireCards(live, "turn-ended")
    live.turn = undefined
    turn.finish()
    this.options.onStatusChange?.()
    // The mode changed to or from Bypass while this turn ran: restart on the right launch flag now.
    if (live.restartOwed && !live.ending && !live.exited) void this.endSession(live.slug, live.sessionId)
  }

  private clearTimers(turn: Turn): void {
    if (turn.flushTimer) { clearTimeout(turn.flushTimer); turn.flushTimer = undefined }
    if (turn.quietTimer) { clearTimeout(turn.quietTimer); turn.quietTimer = undefined }
    if (turn.idleTimer) { clearTimeout(turn.idleTimer); turn.idleTimer = undefined }
  }

  /** The agent is doing something with no prompt in flight: a turn of its own starts here. */
  private openAutonomousTurn(live: Live): Turn {
    const turn = this.newTurn(live, true)
    live.turn = turn
    live.writer.append({ kind: "user-message", at: turn.startedAt, text: WAKE_TEXT, synthetic: true })
    live.writer.append({ kind: "turn-start", at: turn.startedAt })
    this.options.onStatusChange?.()
    return turn
  }

  /** A usage reading ended a model step of a turn the agent started. If nothing follows it, that step
   *  was the last: a step that calls a tool sends the call within milliseconds of its reading. */
  private armQuiet(live: Live, turn: Turn): void {
    if (turn.quietTimer) clearTimeout(turn.quietTimer)
    turn.quietTimer = setTimeout(() => {
      turn.quietTimer = undefined
      if (live.turn !== turn || !turn.autonomous || turn.outstanding > 0) return
      // A card is open: the agent is waiting on a person, not finished.
      if (live.cards.size) return
      this.endTurn(live, turn, { successful: true })
    }, this.options.quietMs ?? DEFAULT_QUIET_MS)
    turn.quietTimer.unref?.()
  }

  /** Every frame of a turn the agent started pushes its last-resort ending back. */
  private touchAutonomous(live: Live, turn: Turn, endsStep: boolean): void {
    if (!turn.autonomous) return
    if (turn.quietTimer) { clearTimeout(turn.quietTimer); turn.quietTimer = undefined }
    if (turn.idleTimer) clearTimeout(turn.idleTimer)
    turn.idleTimer = setTimeout(() => {
      turn.idleTimer = undefined
      if (live.turn !== turn || !turn.autonomous || turn.outstanding > 0 || live.cards.size) return
      this.endTurn(live, turn, { successful: true })
    }, this.options.idleMs ?? DEFAULT_IDLE_MS)
    turn.idleTimer.unref?.()
    if (endsStep) this.armQuiet(live, turn)
  }

  /** A new agent message begins: what was said so far is no longer the turn's final text. */
  private nextMessage(live: Live, turn: Turn): void {
    turn.messageText = ""
    turn.messageId = `m${++live.messageSeq}`
  }

  /** Write the buffered text as one record. Returns, for a FINAL flush, the whole text of the agent's
   *  last message (every partial flush included): what the turn-end carries as `finalText`. */
  private flushText(live: Live, final: boolean): string | undefined {
    const turn = live.turn
    if (!turn) return undefined
    if (turn.flushTimer) { clearTimeout(turn.flushTimer); turn.flushTimer = undefined }
    if (turn.text) {
      const text = turn.text
      turn.text = ""
      live.writer.append({ kind: "assistant-text", at: this.now(), text, final, messageId: turn.messageId })
    }
    return final && turn.messageText.trim() ? turn.messageText : undefined
  }

  private flushThought(live: Live): void {
    const turn = live.turn
    if (!turn?.thought.trim()) { if (turn) turn.thought = ""; return }
    live.writer.append({ kind: "reasoning", at: this.now(), text: turn.thought })
    turn.thought = ""
  }

  private scheduleFlush(live: Live): void {
    const turn = live.turn
    if (!turn || turn.flushTimer) return
    turn.flushTimer = setTimeout(() => { turn.flushTimer = undefined; this.flushText(live, false) }, this.options.flushMs ?? 1_000)
    turn.flushTimer.unref?.()
  }

  private handleNotification(live: Live, params: unknown): void {
    const parsed = AcpSessionNotification.safeParse(params)
    if (!parsed.success) { this.diagnostic(live.slug, "protocol", "malformed session/update"); return }
    const update = parseSessionUpdate(parsed.data.update)
    switch (update.sessionUpdate) {
      case "agent_thought_chunk": {
        const t = contentText(update.content)
        if (!t) return
        const turn = live.turn ?? this.openAutonomousTurn(live)
        turn.heard = true
        this.touchAutonomous(live, turn, false)
        turn.thought += t
        return
      }
      case "agent_message_chunk": {
        const t = contentText(update.content)
        if (!t) return
        const turn = live.turn ?? this.openAutonomousTurn(live)
        turn.heard = true
        this.touchAutonomous(live, turn, false)
        this.flushThought(live)
        // A message that picks up after a pause opens with blank lines of its own.
        const piece = turn.messageText ? t : t.trimStart()
        if (!piece) return
        turn.text += piece
        turn.messageText += piece
        this.scheduleFlush(live)
        return
      }
      case "tool_call":
      case "tool_call_update": {
        if (live.settled.includes(update.toolCallId)) return
        const known = live.tools.get(update.toolCallId)
        const settles = update.status === "completed" || update.status === "failed"
        // A call from an earlier turn that only now settles (a background command) is not the agent
        // starting anything: its result is recorded where the call is, and no turn opens for it.
        if (known && !live.turn) {
          if (settles) this.recordToolResult(live, update, known)
          return
        }
        const turn = live.turn ?? this.openAutonomousTurn(live)
        turn.heard = true
        this.touchAutonomous(live, turn, false)
        let meta = known
        if (!meta) {
          this.flushThought(live)
          this.flushText(live, false)
          // Text before a tool call is commentary, not the answer.
          this.nextMessage(live, turn)
          const shaped = antigravityToolShape(toolName(update) ?? update.title ?? update.kind ?? "tool", update.rawInput)
          meta = { name: shaped.name, done: false, ...(shaped.input.run_in_background === true ? { background: true } : {}) }
          live.tools.set(update.toolCallId, meta)
          live.writer.append({ kind: "tool-call", at: this.now(), id: update.toolCallId, name: shaped.name, input: shaped.input })
        }
        if (settles) this.recordToolResult(live, update, meta)
        return
      }
      case "usage_update": {
        // Keep the file in reading order: the text this reading follows goes first.
        this.flushText(live, false)
        if (update.used > 0) live.writer.append({ kind: "context-usage", at: this.now(), tokens: update.used, window: update.size })
        if (live.turn) this.touchAutonomous(live, live.turn, true)
        return
      }
      case "session_info_update":
        if (update.title) live.writer.append({ kind: "title", title: clip(update.title, 200) })
        return
      case "config_option_update":
        this.adoptConfig(live, update.configOptions)
        return
      case "compaction_update":
        if (update.status === "completed" && !live.turn?.compacting) {
          this.flushThought(live)
          this.flushText(live, false)
          live.writer.append({ kind: "compaction", at: this.now() })
        }
        return
      case "plan":
      case "user_message_chunk":
      case "compaction_summary_chunk":
        return
      case "unknown": {
        const kind = String((update.raw as { sessionUpdate?: unknown } | undefined)?.sessionUpdate)
        if (kind === "current_mode_update") {
          const mode = (update.raw as { currentModeId?: unknown }).currentModeId
          if (typeof mode === "string") live.mode = mode
        } else if (kind === "available_commands_update") {
          const list = (update.raw as { availableCommands?: unknown }).availableCommands
          if (Array.isArray(list)) {
            live.commands = list.flatMap((raw) => {
              const c = raw as { name?: unknown; description?: unknown } | null
              return c && typeof c.name === "string" && c.name ? [{ name: clip(c.name, 512), description: clip(typeof c.description === "string" ? c.description : "", 1_024) }] : []
            })
          }
        } else {
          this.diagnostic(live.slug, "update", `unhandled session/update ${kind}`)
        }
        return
      }
    }
  }

  private recordToolResult(live: Live, tc: AcpToolCallUpdate, meta: ToolMeta): void {
    if (meta.done) return
    meta.done = true
    const code = exitCode(tc)
    const cancelled = tc.status === "failed" && live.turn?.cancelRequested === true
    const failed = tc.status === "failed" || (code !== undefined && code !== 0)
    const answers = live.answers.get(tc.toolCallId)
    live.answers.delete(tc.toolCallId)
    live.writer.append({
      kind: "tool-result", at: this.now(), id: tc.toolCallId, text: clip(toolResultText(tc), 20_000),
      ...(cancelled ? { cancelled: true } : failed ? { failed: true } : {}),
      ...(answers ? { answers } : {}),
    } as Parameters<AcpTranscriptWriter["append"]>[0])
    // A call is tracked only until it settles; a long thread would otherwise hold every call it made.
    live.tools.delete(tc.toolCallId)
    live.settled.push(tc.toolCallId)
    if (live.settled.length > SETTLED_KEPT) live.settled.splice(0, live.settled.length - SETTLED_KEPT)
  }

  // ---- the agent asking us ---------------------------------------------------------------------------

  private async handleRequest(live: Live, method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") return this.handlePermission(live, params)
    if (method === "elicitation/create") return this.handleQuestion(live, params)
    // fs/* and terminal/* were not advertised in clientCapabilities; an agent that calls them anyway
    // gets the spec's answer and does its own I/O.
    throw new AcpRequestError(ACP_ERROR_METHOD_NOT_FOUND, `frizz does not implement ${method}`)
  }

  private scope(live: Live): InteractionSessionScope {
    return { projectId: this.options.projectId, threadSlug: live.slug, sessionId: live.sessionId }
  }

  private handlePermission(live: Live, params: unknown): Promise<AcpRequestPermissionResult> {
    const parsed = AcpRequestPermissionParams.safeParse(params)
    const cancelled: AcpRequestPermissionResult = { outcome: { outcome: "cancelled" } }
    if (!parsed.success) return Promise.resolve(cancelled)
    const options = parsed.data.options
    const reject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always")
    const failClosed: AcpRequestPermissionResult = reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : cancelled
    // `frizzctl` is how the worker talks to Frizz, and every harness pre-approves it.
    const command = antigravityCommandLine(toolName(parsed.data.toolCall), parsed.data.toolCall.rawInput)
    const allow = options.find((o) => o.kind === "allow_once")
    if (command && allow && isPlainFrizzctlCommand(command)) return Promise.resolve({ outcome: { outcome: "selected", optionId: allow.optionId } })
    const store = this.options.interactions
    if (!store) { this.diagnostic(live.slug, "permission", "no interaction store; denying the request"); return Promise.resolve(failClosed) }
    const built = buildAcpPermissionInteraction(antigravityPermissionParams(parsed.data), { projectId: this.options.projectId, threadSlug: live.slug, sessionId: live.sessionId, cwd: live.cwd }, { id: "antigravity", label: ANTIGRAVITY_LABEL, provider: "antigravity" })
    if (!built) { this.diagnostic(live.slug, "permission", "request could not be represented as a card; denying"); return Promise.resolve(failClosed) }
    let id: string
    try { id = store.create(built.request).interaction.id } catch (err) {
      this.diagnostic(live.slug, "permission", `could not record the approval: ${(err as Error).message}`)
      return Promise.resolve(failClosed)
    }
    return new Promise<AcpRequestPermissionResult>((resolve) => {
      live.cards.set(id, { kind: "permission", resolve, optionByDecision: built.optionByDecision, scope: this.scope(live) })
      this.options.onStatusChange?.()
    })
  }

  private handleQuestion(live: Live, params: unknown): Promise<AntigravityElicitationResult> {
    const parsed = AntigravityElicitationParams.safeParse(params)
    const cancel: AntigravityElicitationResult = { action: "cancel" }
    if (!parsed.success) return Promise.resolve(cancel)
    const store = this.options.interactions
    if (!store) { this.diagnostic(live.slug, "question", "no interaction store; cancelling the question"); return Promise.resolve(cancel) }
    const requestId = parsed.data.toolCallId ?? `question-${live.messageSeq}-${Date.now()}`
    const built = buildAntigravityQuestionInteraction(parsed.data, { projectId: this.options.projectId, threadSlug: live.slug, sessionId: live.sessionId, turnId: clip(requestId, 500), itemId: clip(requestId, 500), sessionEpoch: 0, capabilityRevision: 0 }, requestId)
    if (!built) { this.diagnostic(live.slug, "question", "a question could not be shown as a card; cancelling it"); return Promise.resolve(cancel) }
    let id: string
    try { id = store.create(built.request).interaction.id } catch (err) {
      this.diagnostic(live.slug, "question", `could not record the question: ${(err as Error).message}`)
      return Promise.resolve(cancel)
    }
    return new Promise<AntigravityElicitationResult>((resolve) => {
      live.cards.set(id, { kind: "question", resolve, params: parsed.data, fields: built.fields, ...(parsed.data.toolCallId ? { toolCallId: parsed.data.toolCallId } : {}), scope: this.scope(live) })
      this.options.onStatusChange?.()
    })
  }

  /** Cancel every open card for a session that can no longer answer one, answering the agent for each.
   *  Hygiene, so it never throws. */
  private retireCards(live: Live, reason: "turn-ended" | "provider-cancelled"): void {
    if (!live.cards.size) return
    const pending = [...live.cards.values()]
    live.cards.clear()
    try { this.options.interactions?.cancelForSession(live.slug, live.sessionId, reason) } catch { /* hygiene */ }
    for (const card of pending) {
      if (card.kind === "permission") card.resolve({ outcome: { outcome: "cancelled" } })
      else card.resolve({ action: "cancel" })
    }
  }
}

export function createAntigravityBridge(options: AntigravityBridgeOptions): AntigravityBridge { return new AntigravityBridge(options) }
