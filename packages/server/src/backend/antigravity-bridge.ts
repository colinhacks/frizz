import { spawn as spawnProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { AntigravityModel, AntigravityModels, PermissionMode, ProviderQuota } from "@frizz/shared"
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
import { antigravityToolCalls, antigravityTranscriptPath, antigravityTurnOpen } from "./antigravity-transcript.ts"
import {
  ANTIGRAVITY_BYPASS_FLAG, ANTIGRAVITY_COMMAND, ANTIGRAVITY_LABEL, AntigravityElicitationParams, AntigravityUsage,
  antigravityAnswerLabels, antigravityCommandLine, antigravityLaunchArgs, antigravityOption, antigravityPermissionParams, antigravityQuestionAnswer,
  antigravityQuotaFromUsage, antigravitySessionMode, antigravityTier, antigravityToolShape, buildAntigravityQuestionInteraction, isPlainFrizzctlCommand,
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
//     what it then does. The bridge opens a turn on the first frame of such a stretch and closes it on
//     silence once a usage reading has ended a model step and no tool call has started since.
//   - RESTARTS. The daemon keeps the agent, so the next runtime finds it mid-turn, between turns, or
//     waiting on a card, and learns the rest from the transcript and the daemon's record: which calls
//     are already written, and which flag the agent was launched with.
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
  /** How long a stop waits for the agent to act on `session/cancel` before the agent itself is ended. */
  cancelWaitMs?: number
  /** Test seam: runs `agy -p "/usage" --output-format json` and resolves with what it printed. */
  runUsage?: (input: AntigravityUsageRun) => Promise<string>
}

export interface AntigravityUsageRun { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }

/** One `agy -p "/usage"` run: no session, no tokens, about three seconds. Its stdin is closed, so a CLI
 *  that asks for anything gets no answer and is stopped at the timeout. */
export function runAntigravityUsage({ command, args, cwd, env, timeoutMs }: AntigravityUsageRun): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)}s`)) }, timeoutMs)
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (out.length < 1_000_000) out += chunk })
    child.on("error", (err) => { clearTimeout(timer); reject(err) })
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`it exited with code ${code}`)) })
  })
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
  /** A usage reading has closed a model step and no tool call has started since: on a turn the agent
   *  started, silence from here on means the turn is over. */
  stepOver: boolean
  done: Promise<void>
  finish: () => void
}

interface ToolMeta {
  name: string
  done: boolean
  background?: boolean
  /** The turn the call was made in. A turn the agent started is not over while one of its own
   *  foreground calls is still running, however quiet the agent is meanwhile. */
  turn?: Turn
}

interface Live {
  slug: string
  sessionId: string
  cwd: string
  conn: AcpConnection
  init: AcpInitializeResultType
  agySessionId: string
  writer: AcpTranscriptWriter
  /** This attachment's own mark, in every id that must not be taken for one a previous runtime wrote:
   *  a streamed message's id, and the id a card is journaled under. */
  nonce: string
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
// Every limit `agy` reports is a weekly one, so a reading is held five minutes; the gauge's click skips
// the hold. A refresh that fails keeps the last reading for half an hour before it says so.
const QUOTA_CACHE_MS = 5 * 60_000
const QUOTA_KEPT_MS = 30 * 60_000
const USAGE_TIMEOUT_MS = 20_000
// A reading that could not be had is held too, so a gauge standing on a signed-out account does not
// start `agy` at every poll. Short for the model list, which someone who has just signed in is waiting on.
const MODEL_FAILURE_MS = 30_000
const QUOTA_FAILURE_MS = 2 * 60_000
const DEFAULT_CANCEL_WAIT_MS = 15_000
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
      slug, sessionId, cwd, conn, init, agySessionId: "", writer, nonce: randomUUID().slice(0, 8), bypass,
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
      // The flag the RUNNING agent was launched with. The thread's mode may have moved to or from Bypass
      // while it worked, and that move is still owed a restart: the mode alone would say it was made.
      if (attachment.launchArgs) live.bypass = attachment.launchArgs.includes(ANTIGRAVITY_BYPASS_FLAG)
      if (live.bypass !== bypass) live.restartOwed = true
      if (this.closed) return this.refuseClosed(live)
      writer.append({ kind: "acp-note", at: this.now(), text: `Reattached to the running ${ANTIGRAVITY_LABEL} session after a Frizz restart.` })
      if (attachment.hello.droppedWhileDetached > 0) {
        writer.append({ kind: "acp-note", at: this.now(), text: `${attachment.hello.droppedWhileDetached} message(s) from the agent were lost while Frizz was away; the transcript may have gaps.` })
      }
      // The calls the file already holds. One still running gets its result where it was written, not
      // a second row; a closing frame the daemon replays for one that has its result is a repeat.
      const calls = antigravityToolCalls(writer.path)
      live.settled = calls.settled.slice(-SETTLED_KEPT)
      this.sessions.set(sessionId, live)
      const prompts = attachment.hello.outstanding.filter((o) => o.method === "session/prompt")
      let turn: Turn | undefined
      if (prompts.length) {
        turn = this.newTurn(live, false)
        // A prompt in flight whose turn the file does not hold open: give it one, so its ending has a start.
        if (!turnLeftOpen) writer.append({ kind: "turn-start", at: turn.startedAt })
        for (const prompt of prompts) {
          turn.outstanding++
          void this.awaitPrompt(live, turn, conn.adoptPending("session/prompt", (id) => attachment.adopt(prompt.daemonId, id)), false)
        }
      } else if (turnLeftOpen) {
        turn = this.newTurn(live, true)
        // Whatever the agent did while nobody listened is in the replay below. If that was all of it,
        // nothing follows, and the silence is this turn's ending, whichever frame the replay ends on.
        turn.stepOver = true
      }
      live.turn = turn
      for (const call of calls.open) {
        live.tools.set(call.id, { name: call.name, done: false, ...(call.background ? { background: true } : {}), ...(turn && call.inOpenTurn ? { turn } : {}) })
      }
      this.options.onStatusChange?.()
      ready()
      if (turn && live.turn === turn && turn.autonomous && turn.stepOver) this.armQuiet(live, turn)
      // The agent kept its options, and the thread's may have changed while it ran unattended. Not
      // waited for: a busy agent may take its time to answer, and nothing here depends on the answer.
      void this.applyProfile(current, input).then((problems) => { for (const problem of problems) this.diagnostic(slug, "protocol", problem) }, () => {})
      return { live, resumed: "reattached" }
    }
    ready()
    // A turn left open by an agent that is gone will never be closed by it.
    if (turnLeftOpen) this.closeAbandonedTurn(writer)

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
    if (this.closed) return this.refuseClosed(live)
    this.sessions.set(sessionId, live)
    return { live, resumed }
  }

  /** The bridge shut down while this open was under way. Let go of the agent (a daemon's keeps running,
   *  for the next runtime to reattach to) rather than hold a session nothing will ever close. */
  private async refuseClosed(live: Live): Promise<never> {
    live.detaching = true
    await live.conn.close(1_000)
    throw new Error("Antigravity bridge is closed")
  }

  /** A turn the file leaves open whose agent is gone will never be closed by it: write its ending. */
  private closeAbandonedTurn(writer: AcpTranscriptWriter): void {
    const at = this.now()
    writer.append({ kind: "turn-end", at, successful: false })
    writer.append({ kind: "acp-note", at, text: `The ${ANTIGRAVITY_LABEL} agent stopped while this turn was running.` })
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
    const mode = antigravitySessionMode(profile.permissionMode)
    // A reattached session's options were told to the runtime before this one. Asking for the mode is
    // how they are read: the answer lists all three, and what follows then changes only what differs.
    if (live.model === undefined && live.mode === undefined) {
      await attempt("mode", mode, (m) => `${ANTIGRAVITY_LABEL} could not switch to its ${mode} mode (${m}).`)
    }
    if (profile.modelId && profile.modelId !== live.model) {
      await attempt("model", profile.modelId, (m) => `${ANTIGRAVITY_LABEL} could not switch to ${profile.modelId} (${m}); the session runs on ${live.model ?? "its own default model"}.`)
    }
    // A level the model does not take is not asked for: the option is absent on a model with none.
    if (profile.effort && live.effort !== undefined && profile.effort !== live.effort) {
      await attempt("thought_level", profile.effort, (m) => `${ANTIGRAVITY_LABEL} could not set the thinking level to ${profile.effort} (${m}); the session runs at ${live.effort ?? "the model's default"}.`)
    }
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
    // A turn being stopped takes no more prompts: one sent now would join work that is about to be
    // cancelled, and go with it. The message waits for the stop and starts a turn of its own.
    const stopping = live?.turn?.cancelRequested ? live.turn : undefined
    if (stopping) {
      await stopping.done
      await this.sessionEnded(input.sessionId)
      if (this.closed) throw new Error("Antigravity bridge is closed")
      live = this.sessions.get(input.sessionId)
    }
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
    const settled = await Promise.race([turn.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), this.options.cancelWaitMs ?? DEFAULT_CANCEL_WAIT_MS).unref?.())])
    if (!settled && this.sessions.get(sessionId) === live) {
      // The agent did not act on the cancel. Letting go of the connection would stop nothing: from a
      // daemon it only detaches, and the agent works on with nobody watching. End the agent instead;
      // the session resumes, with its history, at the next message.
      this.diagnostic(threadSlug, "protocol", "the agent did not act on session/cancel; ending it")
      this.releaseSession(threadSlug, sessionId)
      await this.stopping.get(sessionId)
      await Promise.race([turn.done, new Promise<void>((r) => setTimeout(r, 5_000).unref?.())])
    }
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
      if (this.sessions.has(row.sessionId) || this.opening.has(row.sessionId)) continue
      if (!liveAcpDaemonRecord(this.options.stateDir, row.sessionId)) {
        // No agent to reattach to (a reboot, a daemon that died): a turn it left open is over, and
        // nothing else would say so until the thread's next message.
        const path = antigravityTranscriptPath(this.options.stateDir, row.sessionId)
        if (antigravityTurnOpen(path)) { this.closeAbandonedTurn(new AcpTranscriptWriter(path)); this.options.onStatusChange?.() }
        continue
      }
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
    // A session being opened right now would take the profile it was opened with and never hear of this one.
    await this.opening.get(sessionId)?.catch(() => {})
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
  private modelFailure: { at: number; value: AntigravityModels } | undefined

  /** The models the signed-in account is offered, each with its own thinking levels, read from a
   *  throwaway session (there is no other way to ask) by selecting each model in turn, which costs no
   *  tokens. Cached for ten minutes; a probe that cannot open a session yields an empty list with the
   *  reason, never a throw, so the composer says what to do, and that answer is held half a minute. */
  models(cwd: string, opts: { refresh?: boolean } = {}): Promise<AntigravityModels> {
    if (this.modelCache && !opts.refresh && Date.now() - this.modelCache.at < MODEL_CACHE_MS) return Promise.resolve(this.modelCache.value)
    if (this.modelFailure && !opts.refresh && Date.now() - this.modelFailure.at < MODEL_FAILURE_MS) return Promise.resolve(this.modelFailure.value)
    if (this.modelProbe) return this.modelProbe
    const probe = this.probeModels(cwd).then((value) => {
      if (value.error) this.modelFailure = { at: Date.now(), value }
      else { this.modelCache = { at: Date.now(), value }; this.modelFailure = undefined }
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

  // ---- quota ----------------------------------------------------------------------------------------

  private quotaRead: Promise<ProviderQuota> | undefined
  private quotaCache: { at: number; value: ProviderQuota } | undefined
  private quotaFailure: { at: number; value: ProviderQuota } | undefined

  /** What the signed-in account has left of each limit, from `agy`'s own `/usage` report. Never a throw:
   *  a reading that cannot be had is "unavailable" with the reason, and the gauge draws nothing. */
  quota(cwd: string, opts: { force?: boolean } = {}): Promise<ProviderQuota> {
    if (this.quotaCache && !opts.force && Date.now() - this.quotaCache.at < QUOTA_CACHE_MS) return Promise.resolve(this.quotaCache.value)
    if (this.quotaFailure && !opts.force && Date.now() - this.quotaFailure.at < QUOTA_FAILURE_MS) return Promise.resolve(this.keptQuota() ?? this.quotaFailure.value)
    if (this.quotaRead) return this.quotaRead
    const read = this.readQuota(cwd).then((value) => {
      if (value.status === "ok") { this.quotaCache = { at: Date.now(), value }; this.quotaFailure = undefined; return value }
      this.quotaFailure = { at: Date.now(), value }
      return this.keptQuota() ?? value
    }).finally(() => { this.quotaRead = undefined })
    this.quotaRead = read
    return read
  }

  /** The last good reading, for as long as it is worth showing in place of a failed refresh. */
  private keptQuota(): ProviderQuota | undefined {
    return this.quotaCache && Date.now() - this.quotaCache.at < QUOTA_KEPT_MS ? this.quotaCache.value : undefined
  }

  private async readQuota(cwd: string): Promise<ProviderQuota> {
    const unavailable = (detail: string): ProviderQuota => ({ status: "unavailable", windows: [], detail: clip(detail, 200) })
    const bin = this.bin()
    if (!bin) return unavailable(`${ANTIGRAVITY_LABEL} is not installed`)
    // The model list comes first, and not only for its names: it is read over ACP, which answers a
    // signed-out account with an error. `agy -p` has never been seen signed out, so it runs only for an
    // account ACP has just vouched for, and is never the command that finds out.
    const account = await this.models(cwd)
    if (account.error) return unavailable(account.error)
    let printed: string
    try {
      printed = await (this.options.runUsage ?? runAntigravityUsage)({
        command: bin, args: ["-p", "/usage", "--output-format", "json"], cwd,
        env: inheritWorkerEnvironment(this.options.env ?? process.env), timeoutMs: USAGE_TIMEOUT_MS,
      })
    } catch (err) {
      this.diagnostic("quota", "process", (err as Error).message)
      return unavailable(`${ANTIGRAVITY_LABEL} did not report its usage: ${(err as Error).message}`)
    }
    try {
      return antigravityQuotaFromUsage(AntigravityUsage.parse(JSON.parse(printed)), account)
    } catch {
      this.diagnostic("quota", "protocol", `unreadable /usage report: ${clip(printed, 200)}`)
      return unavailable(`${ANTIGRAVITY_LABEL} reported its usage in a shape Frizz does not read`)
    }
  }

  // ---- the turn -------------------------------------------------------------------------------------

  private newTurn(live: Live, autonomous: boolean): Turn {
    let finish!: () => void
    const done = new Promise<void>((r) => { finish = r })
    return { startedAt: this.now(), outstanding: 0, autonomous, text: "", messageId: this.messageId(live), messageText: "", thought: "", cancelRequested: false, heard: false, compacting: false, stepOver: false, done, finish }
  }

  /** A streamed message's id. The fold joins the pieces that share one, so it carries this attachment's
   *  mark: the first message after a restart is not the first message before it. */
  private messageId(live: Live): string {
    return `${live.nonce}.${++live.messageSeq}`
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
    if (turn.outstanding > 0) {
      // A later prompt steered this one, and its return is the agent saying it has read those words.
      // What was said up to here was said before it had: commentary, not the answer to them.
      this.flushThought(live)
      this.flushText(live, false)
      this.nextMessage(live, turn)
      return
    }
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

  /** One of the turn's own foreground calls has no result yet: the agent is working, however quiet. */
  private callRunning(live: Live, turn: Turn): boolean {
    for (const meta of live.tools.values()) if (!meta.done && !meta.background && meta.turn === turn) return true
    return false
  }

  /** A model step of a turn the agent started is over. If nothing follows, that step was the last: a
   *  step that calls a tool sends the call within milliseconds of its reading. */
  private armQuiet(live: Live, turn: Turn): void {
    if (turn.quietTimer) clearTimeout(turn.quietTimer)
    turn.quietTimer = setTimeout(() => {
      turn.quietTimer = undefined
      if (live.turn !== turn || !turn.autonomous || turn.outstanding > 0) return
      // A card is open, or a command of the turn's is still running: the agent is waiting, not finished.
      if (live.cards.size || this.callRunning(live, turn)) return
      this.endTurn(live, turn, { successful: true })
    }, this.options.quietMs ?? DEFAULT_QUIET_MS)
    turn.quietTimer.unref?.()
  }

  /** The last resort for a turn the agent started: silent this long with nothing of its own running,
   *  it is over whatever came last. */
  private armIdle(live: Live, turn: Turn): void {
    if (turn.idleTimer) clearTimeout(turn.idleTimer)
    turn.idleTimer = setTimeout(() => {
      turn.idleTimer = undefined
      if (live.turn !== turn || !turn.autonomous || turn.outstanding > 0) return
      // Waiting on a person or on its own command is not idling. Look again later.
      if (live.cards.size || this.callRunning(live, turn)) { this.armIdle(live, turn); return }
      this.endTurn(live, turn, { successful: true })
    }, this.options.idleMs ?? DEFAULT_IDLE_MS)
    turn.idleTimer.unref?.()
  }

  /**
   * A frame of a turn the agent started. Each one pushes the last resort back, and they decide between
   * them whether silence now means the turn is over: a usage reading closes a model step, a tool call
   * (or a foreground call's result, which the model goes on to read) opens the next, and text leaves
   * that as it was. The order within a step is not relied on: `agy` sends a step's reading before its
   * message in a turn a prompt started, and after it in one it started itself.
   */
  private touchAutonomous(live: Live, turn: Turn, frame: "usage" | "tool" | "other"): void {
    if (!turn.autonomous) return
    this.armIdle(live, turn)
    if (frame === "usage") turn.stepOver = true
    else if (frame === "tool") turn.stepOver = false
    if (turn.stepOver) this.armQuiet(live, turn)
    else if (turn.quietTimer) { clearTimeout(turn.quietTimer); turn.quietTimer = undefined }
  }

  /** A new agent message begins: what was said so far is no longer the turn's final text. */
  private nextMessage(live: Live, turn: Turn): void {
    turn.messageText = ""
    turn.messageId = this.messageId(live)
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
        this.touchAutonomous(live, turn, "other")
        turn.thought += t
        return
      }
      case "agent_message_chunk": {
        const t = contentText(update.content)
        if (!t) return
        const turn = live.turn ?? this.openAutonomousTurn(live)
        turn.heard = true
        this.touchAutonomous(live, turn, "other")
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
        let meta = known
        if (!meta) {
          this.flushThought(live)
          this.flushText(live, false)
          // Text before a tool call is commentary, not the answer.
          this.nextMessage(live, turn)
          const shaped = antigravityToolShape(toolName(update) ?? update.title ?? update.kind ?? "tool", update.rawInput)
          meta = { name: shaped.name, done: false, turn, ...(shaped.input.run_in_background === true ? { background: true } : {}) }
          live.tools.set(update.toolCallId, meta)
          live.writer.append({ kind: "tool-call", at: this.now(), id: update.toolCallId, name: shaped.name, input: shaped.input })
        }
        // A background call that reports back has not, by that alone, put the agent back to work.
        this.touchAutonomous(live, turn, settles && meta.background ? "other" : "tool")
        if (settles) this.recordToolResult(live, update, meta)
        return
      }
      case "usage_update": {
        // Keep the file in reading order: the text this reading follows goes first.
        this.flushText(live, false)
        if (update.used > 0) live.writer.append({ kind: "context-usage", at: this.now(), tokens: update.used, window: update.size })
        if (live.turn) this.touchAutonomous(live, live.turn, "usage")
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

  /**
   * Journal a card and return its id. The agent names a request by its tool call, and the store keeps
   * one record per name: a request the daemon sends AGAIN after a Frizz restart would be handed the
   * record the previous runtime cancelled on its way out, and wait on it for good. So the name carries
   * this attachment's mark, and a record that is not pending is never waited on.
   */
  private journal(live: Live, store: InteractionStore, request: Parameters<InteractionStore["create"]>[0]): string {
    const created = store.create({ ...request, providerRequestId: `${clip(request.providerRequestId, 480)}#${live.nonce}` }).interaction
    if (created.lifecycle !== "pending") throw new Error(`the request is already ${created.lifecycle}`)
    return created.id
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
    try { id = this.journal(live, store, built.request) } catch (err) {
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
    try { id = this.journal(live, store, built.request) } catch (err) {
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
