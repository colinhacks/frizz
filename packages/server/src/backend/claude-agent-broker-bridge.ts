// The frizz-side bridge for the Claude session broker — the Claude twin of CodexAppServerBridge, but
// leaner because the broker DAEMON owns the session state (and the transcript lands on disk via
// persistSession, read by the tailer like any Claude thread). The bridge forks/adopts a broker per
// thread, connects a typed client, routes tool-permission requests to a decision hook (default:
// auto-allow, honoring the thread's permission mode — matching the retired argv path's
// `--permission-mode auto`), and sends follow-up turns.
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { adoptOrForkBroker, brokerLivenessSnapshot, killBroker, lastKnownBrokerDaemon, liveBrokerRecord, liveBrokerRecords, claudeBrokerRecordPath, resolveClaudeExecutableAbsolute, takeBrokerRetirement, type BrokerRetirementMark, type BrokerRetirementReason } from "./claude-broker-host.ts"
import { connectClaudeBroker, type ClaudeBrokerClient } from "./claude-broker-client.ts"
import { describeClaudeBrokerExit, readClaudeBrokerExit, type ClaudeBrokerExitRecord } from "./claude-broker-diagnostics.ts"
import type { ClaudeDiagnostic, ClaudeMcpServerReading, ClaudePermissionDecision, ClaudePermissionRequest, ClaudeQueryEvent, ClaudeSkillInfo } from "./claude-agent-sdk-protocol.ts"
import { CLAUDE_AGENT_SDK_MAX_INPUT_BYTES, CLAUDE_BROKER_CAPABILITY_CANCEL_INPUT, CLAUDE_BROKER_CAPABILITY_INPUT_ACK, CLAUDE_BROKER_CAPABILITY_LIST_SKILLS, CLAUDE_BROKER_CAPABILITY_MCP, CLAUDE_BROKER_CAPABILITY_RENAME, CLAUDE_BROKER_CAPABILITY_STOP_TASK, CLAUDE_BROKER_CAPABILITY_SUBAGENT_STEER, deliverableInputText, validateInputMessage } from "./claude-agent-sdk-protocol.ts"
import type { BrokerRecord, ClaudeBrokerConfig } from "./claude-agent-broker.ts"
import type { InteractionSessionScope, InteractionStore } from "../interaction-store.ts"
import {
  CLAUDE_ASK_DENY_MESSAGE,
  CLAUDE_ASK_USER_QUESTION_TOOL,
  CLAUDE_ASK_WITHDRAWN_MESSAGE,
  buildClaudePermissionInteraction,
  buildClaudeQuestionInteraction,
  claudePermissionDecisionFor,
  claudeQuestionDecisionFor,
  parseClaudeAskUserQuestion,
  type ClaudeAskSpec,
} from "./claude-permission-interactions.ts"
import { FRIZZ_MCP, claudeCompactionEnv, claudeCompactionWindowOf, claudePromptCacheEnv, claudeWorkerEnv, frizzCliEnv, type FrizzCli } from "./types.ts"
import type { WorkerMcpServers } from "./project-mcp-servers.ts"
import { launchPrefixArgv } from "./launch-prefix.ts"

type BrokerMcpServers = NonNullable<ClaudeBrokerConfig["mcpServers"]>

// Stamp the calling thread's slug into the frizz MCP server's env, leaving any other mounted server
// untouched. Frizz injects only the frizz server today (it mounted chrome-devtools alongside it until
// 2026-08-26), so the map is usually a single entry — but the copy stays general, because a project's
// own servers may reach this map through a future path. Returns the input unchanged when there is no
// frizz mount, so a project whose plugin dir did not resolve behaves exactly as before.
function withFrizzThreadSlug(servers: BrokerMcpServers | undefined, slug: string): BrokerMcpServers | undefined {
  const frizz = servers?.[FRIZZ_MCP.name]
  if (!frizz || !("command" in frizz)) return servers // only ever the stdio frizz mount; a remote entry has no env
  return { ...servers, [FRIZZ_MCP.name]: { ...frizz, env: { ...frizz.env, FRIZZ_THREAD_SLUG: slug } } }
}

/** Gate for routing Claude dispatch through the session broker rather than launching an interactive
 *  `claude` process (the retired path). Default ON
 *  (opt out with FRIZZ_CLAUDE_BROKER_BRIDGE=0). Verified end-to-end on a real PROMOTED ARTIFACT (not just
 *  the dev stack): a dispatched broker thread starts its daemon and the agent replies. The promoted-
 *  artifact regression was the SDK requiring an absolute claude executable (a bare "claude" crashed the
 *  daemon before it published its record) — fixed in resolveClaudeExecutableAbsolute. */
export function claudeBrokerBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FRIZZ_CLAUDE_BROKER_BRIDGE !== "0"
}

export interface ClaudeBrokerBinding {
  threadSlug: string
  sessionId: string
  cwd: string
  generation: string
  state: "active" | "detached"
}

export interface ClaudeBrokerBridgeDeps {
  stateDir: string
  /** Path to the `claude` executable. */
  executablePath: string
  /** Base env; the broker forwards only the SDK-allowlisted subset to claude. */
  env: Record<string, string>
  /** The frizz WORKER ENVIRONMENT — constant per project, applied on every fork so a dispatch AND a
   *  dead-daemon cold-resume both rebuild it. `pluginDir` loads the cc-worker plugin (frizz sub-agent
   *  profiles + hooks); `mcpServers`/`allowedTools` mount + pre-approve the frizz MCP server;
   *  `permDir` is the per-project perm-marker dir the hooks write to (paired with the per-thread slug at
   *  attach time). Absent ⇒ a bare SDK worker (the pre-cutover behavior). */
  workerEnv?: {
    pluginDir?: string
    mcpServers?: WorkerMcpServers
    allowedTools?: string[]
    permDir?: string
    /** Present ⇒ the worker's shell is told where `frizzctl` finds the server (frizzCliEnv). The
     *  command itself needs no PATH entry here: Claude Code puts the plugin's `bin/` on its Bash PATH. */
    cli?: FrizzCli
  }
  /** The live Settings, read at every fork so the auto-compact window (Settings.autoCompactWindow →
   *  CLAUDE_CODE_AUTO_COMPACT_WINDOW) follows the drawer without a restart. Only the fork reads it: a
   *  daemon already running keeps the value it was forked with. Absent ⇒ the CLI's own default. */
  getSettings?: () => { autoCompactWindow?: number; promptCacheTtl?: string; launchPrefix?: { claude?: string } }
  /** The dashboard InteractionStore + this project's id. When present, a Claude tool-permission
   *  escalation (canUseTool, which under "auto" fires only for classifier-flagged risky calls) is
   *  journaled as an approval interaction and gated on the human's dashboard decision. Absent ⇒ the
   *  `decidePermission` hook (default auto-allow) decides — the pre-cutover behavior. */
  interactions?: InteractionStore
  projectId?: string
  /** Decide a tool-permission request when NOT routing to the dashboard (tests / interactions absent).
   *  Defaults to auto-allow, honoring the thread's permission mode — matching the retired argv path's
   *  `--permission-mode auto`. */
  decidePermission?: (slug: string, sessionId: string, request: ClaudePermissionRequest) => Promise<ClaudePermissionDecision>
  /** Observe the session/transcript event stream (board liveness / telemetry). Optional. */
  onEvent?: (slug: string, sessionId: string, event: ClaudeQueryEvent) => void
  /** The auto-compact ceiling the session's daemon is running under, reported at every attach — off the
   *  daemon's own record, so an ADOPTED daemon reports the value it was forked with rather than the one
   *  `getSettings` would hand a fork today. Undefined ⇒ this daemon has no ceiling and runs on the
   *  model's whole window. The board lowers its context denominator to it; see
   *  ClaudeRuntimeIngest.noteCompactionWindow for why that is one number rather than two. */
  onCompactionWindow?: (sessionId: string, window: number | undefined) => void
  /** Observe daemon lifecycle/stderr diagnostics from a LIVE socket. The durable copy is written by
   *  the daemon itself (claude-broker-diagnostics.ts) precisely because this relay only reaches a frizz
   *  that is attached at the time — which a crash during a restart is not. Optional; for a live
   *  consumer, not for forensics.
   *
   *  The bridge ALSO synthesizes a `{lifecycle, crashed}` diagnostic here the moment it discovers a
   *  daemon that died while nobody was attached, carrying the dead daemon's own recorded exit reason —
   *  the one death this live relay structurally cannot observe on its own. */
  onDiagnostic?: (slug: string, sessionId: string, diagnostic: ClaudeDiagnostic) => void
  /** The broker-backed threads this frizz owns and may reattach at boot — supplied by context.ts from
   *  the registry, already filtered to rows that are still OPEN and not archived (the same predicate
   *  codex's `shouldAutoResume` applies). Absent ⇒ `warmUp()` is a no-op, which is what every test and
   *  every registry-less harness wants. */
  ownedSessions?: () => Array<{ threadSlug: string; sessionId: string; cwd: string }>
}

export interface ClaudeSpawnDispatchInput {
  threadSlug: string
  sessionId: string
  cwd: string
  prompt: string
  permissionMode?: ClaudeBrokerConfig["permissionMode"]
  /** Appended to Claude's default system prompt — the frizz worker contract + scratchpad orientation. */
  appendSystemPrompt?: string
  model?: string
  effort?: string
}

// The uuid to hand the SDK for one input. frizz's own deliveryId when it is UUID-shaped (the browser
// mints one with crypto.randomUUID), because the SDK ECHOES this id back on the record that
// materializes the input — as the delivered `user` record's `uuid`, or as the `queued_command`
// attachment's `source_uuid` — which is what lets the delivery ledger correlate by IDENTITY instead of
// by comparing prose (see the identity path in delivery-ledger.ts). The SDK rejects a non-UUID id
// outright, and eagerComposerSubmission has a non-UUID fallback for browsers without crypto.randomUUID,
// so anything else degrades to a fresh uuid and the text path — never a throw on the operator's send.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function inputIdFor(deliveryId: string | undefined): string {
  return deliveryId && UUID_SHAPE.test(deliveryId) ? deliveryId : randomUUID()
}

// Options that shape a FORK (only consulted when attach cold-starts a daemon; ignored when it reattaches
// to a live one — the running session already carries them). `resume` picks up the on-disk transcript.
type ForkOpts = Pick<ClaudeSpawnDispatchInput, "appendSystemPrompt" | "model" | "effort"> & { resume?: boolean }


interface ActiveSession {
  slug: string
  sessionId: string
  cwd: string
  generation: string
  client: ClaudeBrokerClient
  /** The daemon answers an input frame (input-ack-v1, read off its record at bind). An older daemon
   *  forked before the capability existed does not, and is held to "written to a connected socket". */
  acksInput: boolean
}

export interface ClaudeAgentBrokerBridge {
  spawnDispatch(input: ClaudeSpawnDispatchInput): Promise<{ binding: ClaudeBrokerBinding }>
  /** Deliver a follow-up turn. If the daemon is live we reattach its socket (context intact); if it
   *  died, we cold-start a fresh daemon that RESUMES the on-disk transcript — so the resume context
   *  (worker system prompt + profile) must be re-supplied, exactly like a `claude -r` invocation. */
  /**
   * `freshProcess` retires a LIVE daemon before delivering, so the text lands in a `claude` that has
   * just started. Set it when the running process cannot act on the message no matter what it says —
   * today that is exactly one case, a usage-limit resume fired before the provider's stated reset
   * instant, because the process latched on its 429 and refuses every input until then (see
   * usage-limit.ts `limitResumeNeedsFreshProcess`). Costs the in-memory sub-agents, which is why it is
   * opt-in per call rather than the default.
   *
   * `keepOpenCards` is for a message NOBODY TYPED — a scheduled wake, a notice frizz writes itself. A
   * follow-up from the operator supersedes an open approval or question card (they typed instead of
   * clicking, so the card is denied and the turn reads their message). A machine's message must not:
   * a timer coming due is not the operator declining a command. With it set the cards stay open and the
   * message waits in the daemon's queue behind the parked turn, to be read once the operator answers.
   *
   * `human` says a PERSON typed the text, and reaches the runtime as the message's origin. It is what
   * lets `sendNow` move a running call aside for this message instead of aborting the turn
   * (ClaudeInputMessage.human), so it is set on the operator's own sends and on nothing Frizz writes.
   */
  followUp(input: { threadSlug: string; sessionId: string; cwd: string; text: string; deliveryId?: string; permissionMode?: ClaudeBrokerConfig["permissionMode"]; appendSystemPrompt?: string; model?: string; effort?: string; freshProcess?: boolean; keepOpenCards?: boolean; human?: boolean }): Promise<void>
  /**
   * Steer ONE running Agent-tool sub-agent: deliver `text` into the child's own conversation rather
   * than the thread's main turn. `subAgentId` is the dispatch tool_use id — the same id the board's
   * SubAgentView carries and the drill-in drawer is keyed by.
   *
   * DELIBERATELY UNLIKE `followUp`: this NEVER attaches and NEVER cold-resumes. A child exists only
   * inside the live CLI process that dispatched it — it has no transcript of its own to resume, no
   * socket, and no PID. Cold-starting a daemon and addressing a message at a `toolu_…` it has never
   * heard of does not steer anything; at best the steer evaporates, at worst it lands on the main
   * thread as an out-of-context instruction the operator never aimed there. So a steer requires a
   * daemon this bridge is holding LIVE (same generation, per holdsLiveDaemon) and throws otherwise.
   * The caller turns that into "this sub-agent can no longer be reached", which is the truth.
   */
  steerSubAgent(input: { threadSlug: string; sessionId: string; subAgentId: string; text: string; deliveryId?: string }): Promise<void>
  /** Stop one running Claude background task through the provider's task control API. */
  stopSubAgent(input: { threadSlug: string; sessionId: string; taskId: string }): Promise<void>
  /**
   * The session's invocable skills, as the harness itself reports them — the composer typeahead's
   * data source. Requires a live daemon: the list is the SDK's own resolution of plugins, project and
   * global skills, and frizz deliberately has no discovery of its own to fall back on.
   */
  listSkills(input: { threadSlug: string; sessionId: string }): Promise<ClaudeSkillInfo[]>
  /**
   * The LIVE session's MCP servers, as its CLI reports them. Throws when there is no live daemon for
   * the thread or it predates `mcp-v1`; the caller then reads what the thread's next session would get.
   */
  mcpServerStatus(input: { threadSlug: string; sessionId: string }): Promise<ClaudeMcpServerReading[]>
  /** Ask one live session to reconnect an MCP server. Same refusals as mcpServerStatus. */
  reconnectMcpServer(input: { threadSlug: string; sessionId: string; name: string }): Promise<void>
  /**
   * Ask EVERY live session this bridge holds to reconnect `name` — how a sign-in saved once (the token
   * store is shared by every Claude session on the machine) reaches the threads already running.
   * Best effort: a session that refuses or predates `mcp-v1` is skipped. Resolves with how many did it.
   */
  reconnectMcpServerEverywhere(name: string): Promise<number>
  /**
   * Re-title the LIVE session through the provider — the replacement for typing `/rename` at an
   * interactive `claude` prompt.
   * Resolves with the provider's chosen title, or undefined when it declined to name the session.
   */
  renameSession(input: { threadSlug: string; sessionId: string; description: string }): Promise<string | undefined>
  /**
   * Take a follow-up BACK out of the session's command queue — the operator clicked their own queued
   * bubble to unqueue it. `deliveryId` is the id `followUp` handed the SDK, which is the uuid the CLI
   * queued the message under.
   *
   * Resolves TRUE only when the CLI positively removed it: the agent will never read that message.
   * FALSE means it had already been dequeued for execution — nothing was undone and the operator must
   * be told so, because a message they believe they retracted is the worst possible outcome here.
   *
   * NEVER attaches and never cold-resumes, for the same reason steerSubAgent doesn't: a queue lives
   * inside a running CLI process. A daemon that died took its queue with it (the message was never
   * read), and forking a fresh one to cancel a uuid it has never heard of would answer `false` — the
   * one answer that means "your message is on its way". Requires a daemon this bridge holds LIVE.
   */
  cancelFollowUp(input: { threadSlug: string; sessionId: string; deliveryId: string }): Promise<boolean>
  /**
   * SEND NOW: have a follow-up already handed to the CLI's queue read at once, instead of when the
   * operation running right now ends.
   *
   * WHY THIS EXISTS. Claude Code is not slow to dequeue — measured across 14 days of this project's
   * own transcripts, it drains the queue at the FIRST sampling boundary that exists. The wait an
   * operator feels is the remaining time of whatever was already in flight: a long `Bash` (62–105s in
   * the worst real cases) or a single reasoning+answer generation (73–133s). Mid-turn operator prose
   * therefore waited p50 13.8s, p90 49s, p99 2.5m. Nothing but getting that operation out of the way
   * can beat it.
   *
   * HOW IT GETS OUT OF THE WAY, since 2026-10-13: the runtime is asked to push the waiting message
   * through (ClaudeInterruptOptions). A foreground Bash or Agent call is MOVED TO THE BACKGROUND and
   * keeps running, and the turn takes the message in at once — nothing is killed, and the call's result
   * says what happened. Only when the runtime has nothing it can move (the model is mid-answer; a
   * message Frizz wrote is waiting too; the CLI or the daemon predates send-now) is the turn ABORTED,
   * which is all this did before: the running call then ends on Claude Code's stock rejection
   * paragraph (workerPrompt.ts CLAUDE_INTERRUPTED_CALL), and the next turn opens on the queue.
   * `deliveryId` names the message this is for, when the caller has just sent one.
   *
   * ORDER IS THE CONTRACT: the caller must have delivered the message BEFORE calling this. Both forms
   * act on what is QUEUED — a send-now does nothing at all when nothing is waiting, and the abort
   * leaves queued input intact (its receipt reports `still_queued`) for the next turn to open on.
   *
   * Returns false when there is no live daemon to ask. That is not an error: the follow-up has
   * already been delivered by then and will be read the ordinary way. This never attaches and never
   * cold-resumes — a turn only exists inside a running process.
   */
  interruptTurn(input: { threadSlug: string; sessionId: string; deliveryId?: string }): boolean
  /**
   * Reattach at boot to every broker daemon this project left running, without waiting for someone to
   * touch the thread.
   *
   * The codex bridge has done this since its daemon started outliving frizz, and its doc comment names
   * the bug: a turn still running inside a detached daemon has nobody observing it, so a perfectly
   * healthy surviving turn cards as stalled. The broker adopted LAZILY — only `spawnDispatch` and
   * `followUp` ever called `attach` — so after a frizz restart:
   *
   *  - the daemon's event backlog (queued, not dropped, while detached) sits unread, so the runtime
   *    ingest has no reading of the turn and never nudges the tailer;
   *  - a tool-permission escalation raised while frizz was down stays held in the daemon. It IS
   *    re-delivered on reconnect, but nothing reconnects — so no approval card appears, the turn stays
   *    blocked on a promise nobody can answer, and the thread reads as hung until a human pokes it.
   *
   * Fire-and-forget by contract: a broker that cannot be reached must never fail or delay a boot, so
   * every step here swallows its own failure and the next real dispatch/follow-up retries exactly as
   * it did before. Only ADOPTS — it never forks. A daemon that died between the record enumeration and
   * the connect must cold-start under a real dispatch that supplies the resume context, never here.
   */
  warmUp(): Promise<void>
  binding(threadSlug: string, sessionId: string): ClaudeBrokerBinding | undefined
  /**
   * When the newest input was handed to this bridge for the session (ms epoch), or undefined if none
   * was since this server started. Stamped the moment `followUp` takes the message, before any resume
   * or socket write, and withdrawn if that delivery throws.
   *
   * It exists for ONE reader: the router deciding whether a follow-up is the message that opens the
   * next turn or one queued behind a turn something else just opened. The tailer answers that from the
   * transcript, and for the tens of ms between an input being handed over and its record reaching the
   * JSONL the transcript still says "at rest" — so a human's send racing a wake, or another tab's send,
   * was recorded as `delivered` while the worker had queued it (see the router's `midTurn`).
   */
  lastInputAt(sessionId: string): number | undefined
  /** Whether an ownerless daemon for this session is running right now — the board's liveness/stall
   *  signal for a headless broker row (the parallel of codex's turnLiveness), independent of whether
   *  THIS frizz process currently holds a live socket to it. */
  isDaemonAlive(sessionId: string): boolean
  /** `isDaemonAlive` for many sessions at once — one directory listing, then a record read only for a
   *  session that has one (claude-broker-host.ts brokerLivenessSnapshot). The board's per-build reader. */
  daemonLiveness?(): (sessionId: string) => boolean
  /** What the daemon for this session recorded on its way out, when one is not running now. The
   *  attribution behind a headless stall: `isDaemonAlive` says the thread is dead, this says why
   *  (idle-timeout / signal-SIGTERM / self-collected-record-reassigned / …). `null` means it left no
   *  record at all — killed outright, or a daemon older than exit breadcrumbs. */
  daemonExit(sessionId: string): ClaudeBrokerExitRecord | null
  /**
   * Retire this thread's daemon WITHOUT ending the conversation: the `claude` process goes away, the
   * transcript stays on disk, and the next follow-up cold-resumes it in a freshly started one. Answers
   * whether a live daemon was actually taken down (false ⇒ there was nothing running to retire).
   *
   * The one thing a running session can NEVER change about itself is the flag it was launched with, so
   * this is how a permission-mode change is applied: measured against real `claude`, a live
   * `setPermissionMode("bypassPermissions")` on a session launched under `auto` is REFUSED outright —
   * "Cannot set permission mode to bypassPermissions because the session was not launched with
   * --dangerously-skip-permissions" (`_live_sdk_mode_switch.mts`). Same shape as `freshProcess` on
   * followUp and as the Restart worker verb; the cost is the in-memory sub-agents, which is why the
   * caller must not reach for this while any of them is running.
   *
   * `reason` (default `"retire"`) only names the teardown on the mark it leaves for the cold resume
   * that follows — it changes nothing about what is torn down. HIBERNATION is the same act with a
   * different motive: reclaim ~504 MB from a thread that has rested past the prompt-cache TTL, where
   * the resume costs no extra tokens because the cache is already gone (thread-hibernation.ts).
   */
  retireDaemon(input: { threadSlug: string; sessionId: string; reason?: BrokerRetirementReason }): boolean
  releaseSession(threadSlug: string, sessionId: string, reason: "session-replaced" | "session-deleted"): boolean
  close(): void
}

/**
 * Validate a message BEFORE it becomes a socket frame, and say why in the operator's language.
 *
 * The `input` frame had no reply until input-ack-v1, so the daemon was the only place a rejection could be
 * noticed and it had no channel to answer on — every send that reached it and failed was simply gone
 * (a daemon forked by an older build still behaves that way, which is why this stays). Running the same pure
 * validator on this side turns that into a thrown RPC the composer can roll back and toast, which is the
 * whole difference between "frizz refused my message" and "frizz ate my message".
 *
 * A CHARACTER THE WIRE CANNOT CARRY IS TAKEN OUT, NOT REFUSED (`deliverableInputText`): a stray control
 * code or half of a surrogate pair is nothing the worker could have read, and refusing the send for it
 * made a human hunt an invisible character through their own paste. It happens here because this is
 * the one place every input to a Claude worker passes — a dispatch, a follow-up, a sub-agent steer, a
 * wake — and before the frame, so it also holds against a daemon an older build left running. The
 * router cleans an operator's follow-up earlier still, so the delivery ledger records these same words.
 *
 * The protocol error's own wording is a boundary label (`input.text exceeds 65536 bytes`) aimed at a
 * developer reading a stack trace. This is the string a human reads in a toast after pressing Enter, so
 * it names the problem and what to do about it — and it has to FIT: sendEagerFollowUp renders it as
 * `Steer failed — ${message.slice(0, 160)}`, so anything longer is cut off mid-sentence (measured in the
 * browser when the cap was 90: a 150-char version rendered as "…or h"). Keep each of these well under
 * 160 characters.
 */
export function validatedInput(message: { id: string; text: string; parentToolUseId?: string; human?: boolean }): ReturnType<typeof validateInputMessage> {
  try {
    return validateInputMessage({ ...message, text: deliverableInputText(message.text) })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/exceeds/.test(detail)) {
      throw new Error(`This message is too long to send (the limit is ${CLAUDE_AGENT_SDK_MAX_INPUT_BYTES / 1024}KB). Shorten it and resend.`)
    }
    throw new Error(`frizz could not send this message: ${detail}`)
  }
}

export function createClaudeAgentBrokerBridge(deps: ClaudeBrokerBridgeDeps): ClaudeAgentBrokerBridge {
  const sessions = new Map<string, ActiveSession>() // keyed by slug — one active session per thread
  // Resolve the claude executable to an ABSOLUTE path ONCE: the SDK the forked daemon runs rejects a bare
  // name (unlike an execvp of the CLI, which resolves it on PATH), and a bare "claude" is the default
  // on a promoted artifact.
  const executablePath = resolveClaudeExecutableAbsolute(deps.executablePath, deps.env)

  // Pending tool-permission escalations awaiting a human dashboard decision, keyed by interaction id.
  // The daemon holds the actual canUseTool promise (and re-delivers it on reconnect), so this only needs
  // the live client + the daemon's requestId to answer against once the human resolves the interaction.
  // `ask` is present for an AskUserQuestion card: the parsed question spec, needed to turn the operator's
  // field values back into the tool's `{questions, answers}` updatedInput. It is re-derived from the
  // re-delivered request on reconnect, so it survives a frizz restart with the question still open.
  const pendingPerms = new Map<string, { client: ClaudeBrokerClient; requestId: string; scope: InteractionSessionScope; ask?: ClaudeAskSpec }>()

  // Route a Claude tool-permission escalation to the dashboard: reuse the still-pending journal entry on
  // a reconnect re-delivery, else journal a fresh approval interaction. Failure to represent/journal fails
  // CLOSED (deny) — a permission we can't put in front of a human must not silently run.
  //
  // AskUserQuestion forks here. It rides the same canUseTool channel but is not an authorization request:
  // it is the agent asking the operator to CHOOSE, and the SDK expects the chosen labels back inside the
  // decision. So it becomes an `agent-question` interaction — the exact payload kind codex's
  // item/tool/requestUserInput already produces, so one web card renders both providers — rather than an
  // "Approve AskUserQuestion?" card over raw JSON, whose bare allow the model reads as "not answered".
  const routePermissionToDashboard = (slug: string, sessionId: string, cwd: string, requestId: string, request: ClaudePermissionRequest, client: ClaudeBrokerClient): void => {
    const store = deps.interactions!, projectId = deps.projectId!
    const scope: InteractionSessionScope = { projectId, threadSlug: slug, sessionId }
    const owner = { projectId, threadSlug: slug, sessionId, cwd }
    const ask = request.toolName === CLAUDE_ASK_USER_QUESTION_TOOL ? parseClaudeAskUserQuestion(request.input) : null
    const existing = store.listPending(scope).find((r) => r.providerRequestId === requestId)
    if (existing) { pendingPerms.set(existing.id, { client, requestId, scope, ...(ask ? { ask } : {}) }); return }
    // A question we cannot represent EXACTLY is denied with a redirect rather than downgraded to an
    // approval card: an approximate answer (a clipped label, a dropped question) reads to the model as
    // freeform prose or as no answer at all, and it would ask again — the loop this whole path removes.
    if (request.toolName === CLAUDE_ASK_USER_QUESTION_TOOL && !ask) {
      client.answerPermission(requestId, { behavior: "deny", message: CLAUDE_ASK_DENY_MESSAGE })
      return
    }
    const req = ask
      ? buildClaudeQuestionInteraction(ask, request, owner)
      : buildClaudePermissionInteraction(request, owner)
    if (!req) { client.answerPermission(requestId, { behavior: "deny", message: "This tool call could not be represented for approval." }); return }
    let id: string
    try { id = store.create(req).interaction.id } catch { client.answerPermission(requestId, { behavior: "deny", message: "The approval request could not be recorded." }); return }
    pendingPerms.set(id, { client, requestId, scope, ...(ask ? { ask } : {}) })
  }

  // The daemon took a request back (a worker hook settled it, or the turn was interrupted): retire its
  // card. Dropped from `pendingPerms` FIRST, so the observer below does not answer a request that no
  // longer exists. Before this frame existed nothing retired such a card until the turn's `result`.
  const withdrawPermission = (slug: string, sessionId: string, requestId: string): void => {
    if (!deps.interactions) return
    // By the DAEMON's request id, which is what `pendingPerms` holds and what the frame carries — the
    // journal's own `providerRequestId` is the SDK's id for the same request, a different string.
    for (const [interactionId, pending] of pendingPerms) {
      if (pending.requestId !== requestId || pending.scope.threadSlug !== slug || pending.scope.sessionId !== sessionId) continue
      pendingPerms.delete(interactionId)
      // Hygiene, never fatal: the turn-ended sweep still retires a card this could not.
      try { deps.interactions.withdraw(pending.scope, interactionId) } catch {}
    }
  }

  // A resolved/cancelled/expired interaction → the decision the daemon applies. The daemon is the durable
  // holder of the canUseTool promise, so this simply relays the answer over the live socket.
  //
  // ABORT-AWARENESS lives here too. A cancelled or expired entry is never a silent no-op: the turn being
  // interrupted, the session being stopped or replaced, or the operator dismissing the card all land as a
  // non-"resolved" lifecycle (storage.ts cancels every pending interaction for a session on replace or
  // delete), and each one answers the still-blocked daemon with a deny so the tool call unwinds instead
  // of holding the session forever.
  const unsubInteractions = deps.interactions?.subscribe((change) => {
    const pending = pendingPerms.get(change.interactionId)
    if (!pending || change.lifecycle === "pending") return
    const record = deps.interactions!.get(pending.scope, change.interactionId)
    const decision = pending.ask
      ? (change.lifecycle === "resolved"
        ? claudeQuestionDecisionFor(pending.ask, record?.resolution?.decisionId, record?.resolution?.values)
        : { behavior: "deny" as const, message: CLAUDE_ASK_WITHDRAWN_MESSAGE })
      : (change.lifecycle === "resolved"
        ? claudePermissionDecisionFor(record?.resolution?.decisionId)
        : { behavior: "deny" as const, message: "This approval was withdrawn." })
    pending.client.answerPermission(pending.requestId, decision)
    pendingPerms.delete(change.interactionId)
  })

  // Terminalize every interaction still pending for a session that can no longer answer one.
  //
  // A CARD NOTHING EVER TERMINALIZES IS A CARD THAT NEVER LEAVES THE QUEUE. Until 2026-08-02 the Claude
  // side had no sweep at all: `cancelForSession` was reached only from storage.ts (session replaced or
  // deleted) and from the codex bridge, which retires its own on `turn/completed` and on a rebind onto a
  // dead turn. So a Claude interaction that outlived its answerability just stayed `pending` — forever.
  // A live one: a `claude`/`agent-question` row journaled 2026-08-02T02:23:52Z on
  // `https-varlock-dev-integrations-overview-can`, still pending a day later, rendering an answerable
  // question card at the tail of a thread whose turn had long since moved past it.
  //
  // It renders as FULLY LIVE, which is the part that makes this worse than untidy. Codex requests carry a
  // provider delivery row, so `interactionForRead` can fail them closed as `reconnect-required`; these are
  // journaled with a plain `store.create`, carry no delivery row, and therefore get no effect at all. The
  // operator sees working buttons, and answering routes through `interactionResolve`'s non-provider branch
  // — the journal flips to resolved and no daemon is ever told, because `pendingPerms` is process memory
  // that did not survive the restart.
  //
  // `user-cancelled` is the THIRD caller, and the one that makes a native question safe to ship at all.
  // An AskUserQuestion PARKS the turn inside canUseTool, so an operator who types a follow-up instead of
  // answering the card gets nothing: `sendInput` writes the frame, the parked turn never reaches the
  // point of consuming it, and the message sits queued and unread. That is exactly how
  // `https-varlock-dev-integrations-overview-can` stranded two operator messages for 90 minutes. Retiring
  // the card on the way past denies the still-blocked daemon, the tool call unwinds, the turn resumes and
  // eats the queued input — so a follow-up steers a question-blocked thread the same way it steers any
  // other one, which is the property a ```question fence has for free.
  const retirePendingFor = (slug: string, sessionId: string, reason: Parameters<InteractionStore["cancelForSession"]>[2]): void => {
    if (!deps.interactions) return
    let cancelled: ReturnType<InteractionStore["cancelForSession"]> = []
    // Never let a sweep fail a turn ending, a boot, or a daemon teardown — it is hygiene, not the work.
    try { cancelled = deps.interactions.cancelForSession(slug, sessionId, reason) } catch { return }
    // The subscriber above already denied and dropped every entry that was still live in this process.
    // Sweep the map anyway: an interaction journaled by a PREVIOUS frizz has no entry to fire against.
    for (const record of cancelled) pendingPerms.delete(record.id)
  }

  // The daemon deaths already reported through onDiagnostic, keyed by session id + the dead daemon's
  // generation. A death is a one-time fact; re-announcing it on every later follow-up would turn an
  // attribution into noise.
  const reportedDeaths = new Set<string>()
  const reportDeath = (slug: string, sessionId: string, retirement: BrokerRetirementMark | null, lostGeneration: string): void => {
    if (!deps.onDiagnostic) return
    // Ask the log about the daemon we actually lost, never merely about its newest entry — see
    // readClaudeBrokerExit. A session log holds every generations death, so the newest one describes
    // THIS death only when this daemon managed to write it, and the deaths worth investigating are the
    // ones where it did not.
    let exit: ClaudeBrokerExitRecord | null = null
    try { exit = readClaudeBrokerExit(deps.stateDir, sessionId, lostGeneration) } catch { /* forensics degrade, never throw */ }
    // A teardown FRIZZ PERFORMED is not a death to report. Four paths retire a daemon on purpose while
    // the conversation carries on — a launch-flag change (retireDaemon), a usage-limit resume
    // (freshProcess), hibernation (thread-hibernation.ts) and a folder rename (project-relocation.ts) —
    // and every one of them ends with exactly the cold resume this function was written to attribute.
    // Without the mark each of them told the operator their thread had crashed, in the same words a
    // real crash uses.
    //
    // Narrow on PURPOSE, so genuine crash detection is untouched: the mark is one-shot (takeBrokerRetirement
    // consumed it before this call), and it only explains the daemon it actually named. A death whose exit
    // record carries a DIFFERENT generation is a different daemon, and is still reported.
    if (retirement && (!exit || exit.generation === retirement.generation)) return
    const key = `${sessionId}\0${exit?.generation ?? ""}\0${exit?.at ?? ""}`
    if (reportedDeaths.has(key)) return
    reportedDeaths.add(key)
    try { deps.onDiagnostic(slug, sessionId, { kind: "lifecycle", phase: "crashed", message: describeClaudeBrokerExit(exit) }) } catch { /* informational */ }
  }

  // Wire a client onto a broker record and register the session. Shared by the fork/adopt path
  // (`attach`) and the boot reattach (`warmUp`), which must NEVER fork.
  const bind = (slug: string, sessionId: string, cwd: string, record: BrokerRecord): ActiveSession => {
    const client = connectClaudeBroker(record.socketPath, {
      onEvent: (event) => {
        // A `result` ENDS the turn, so nothing the turn was blocked on can be answered after it. A
        // permission escalation holds the turn open by construction — `canUseTool` blocks the tool call,
        // which blocks the turn — so a `result` arriving while one is still pending proves that request
        // was abandoned rather than awaited: an interrupt unwound it, or it was denied out of band (the
        // cc-worker PreToolUse hook and the AskUserQuestion refusal both answer the daemon directly,
        // leaving any card already journaled for it with nothing left to resolve it). Codex retires its
        // own on `turn/completed` for exactly this reason; this is the Claude counterpart.
        if (event.kind === "result") retirePendingFor(slug, sessionId, "turn-ended")
        deps.onEvent?.(slug, sessionId, event)
      },
      onDiagnostic: (diagnostic) => deps.onDiagnostic?.(slug, sessionId, diagnostic),
      onPermissionRequest: (requestId, request) => {
        // Dashboard routing when the store is wired; else the decision hook / auto-allow (tests).
        if (deps.interactions && deps.projectId) {
          try { routePermissionToDashboard(slug, sessionId, cwd, requestId, request, client) }
          catch { client.answerPermission(requestId, { behavior: "deny", message: "permission routing failed" }) }
          return
        }
        void (deps.decidePermission?.(slug, sessionId, request) ?? Promise.resolve<ClaudePermissionDecision>({ behavior: "allow" }))
          .then((decision) => client.answerPermission(requestId, decision))
          .catch(() => client.answerPermission(requestId, { behavior: "deny", message: "permission decision failed" }))
      },
      onPermissionWithdrawn: (requestId) => withdrawPermission(slug, sessionId, requestId),
    })
    const session: ActiveSession = { slug, sessionId, cwd, generation: record.generation, client, acksInput: record.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_INPUT_ACK) === true }
    sessions.set(slug, session)
    // The auto-compact ceiling THIS daemon runs under, taken off its own record so an ADOPTED daemon
    // reports the value it was forked with rather than whatever Settings says now — the board divides
    // the context reading by it, and a running thread keeps its ceiling while the drawer moves. Reported
    // from `bind` and not from `attach` because `warmUp` is the case that most needs it: a daemon that
    // outlived frizz is exactly the one whose ceiling nothing else remembers.
    //
    // A record written by a daemon that predates the field says nothing, and the environment frizz would
    // compose for it now is then the closest true statement there is — exact on a fresh fork (`attach`
    // spreads this same value), and on an adopted pre-field daemon the value it would have been forked
    // with unless the drawer moved since. See ClaudeRuntimeIngest.noteCompactionWindow.
    deps.onCompactionWindow?.(sessionId, record.compactionWindow ?? claudeCompactionWindowOf(claudeCompactionEnv(deps.getSettings?.())))
    return session
  }

  const attach = async (slug: string, sessionId: string, cwd: string, permissionMode: ClaudeBrokerConfig["permissionMode"], fork: ForkOpts = {}): Promise<ActiveSession> => {
    // fork opts (system prompt / model / effort / resume) AND the worker environment apply only when this
    // call FORKS a fresh daemon; when it adopts a live one (frizz restart), the running session already
    // carries them. FRIZZ_THREAD is per-thread (the slug), so it's stamped here, not in deps.workerEnv.
    const we = deps.workerEnv
    const workerEnv: Record<string, string> = {
      // Where `frizzctl`, run from this worker's shell, finds the server and its own project. The
      // caller's identity is FRIZZ_THREAD below, which every worker shell has had all along.
      ...(we?.cli ? frizzCliEnv(we.cli) : {}),
      FRIZZ_THREAD: slug,
      // Every Claude worker's environment — the token budget, the bash timeout ceiling, and the lifted
      // web-search / sub-agent caps — as ONE record, so a cap added there cannot miss this path. It
      // used to spread CLAUDE_WORKER_ENV, which carried the first two and not the caps, and since the
      // broker is the only transport that meant no worker ever received a lift (fixed 2026-08-19; see
      // claudeWorkerEnv). Spread here rather than inherited, which is what gives these per-thread
      // values priority over anything in the environment frizz itself was launched with.
      ...claudeWorkerEnv(),
      // The auto-compact ceiling, from Settings (500K by default). Without it a `[1m]` worker compacts
      // only near 1M, re-sending up to 5x a TUI session's conversation on every turn past 200K.
      ...claudeCompactionEnv(deps.getSettings?.()),
      ...claudePromptCacheEnv(deps.getSettings?.()),
      ...(we?.permDir ? { FRIZZ_PERM_DIR: we.permDir } : {}),
      // The cc-worker plugin's PreToolUse hook DENIES AskUserQuestion, because without frizz in the
      // loop a blocking question freezes a headless worker where nobody can answer it. On the broker path
      // frizz CAN answer it — the call becomes a dashboard question card — so the hook is told to stand
      // down, but only when a store is actually wired to render and resolve the card.
      ...(deps.interactions && deps.projectId ? { FRIZZ_NATIVE_ASK: "1" } : {}),
    }
    // deps.workerEnv.mcpServers is computed ONCE per project, so the frizz MCP server it describes has
    // no idea which thread it will serve. A tool that acts on its OWN thread would need that, and
    // nothing in the MCP protocol carries a caller identity — so the slug is stamped into that
    // server's env HERE, where it is finally known. No shipped tool reads it today (see dispatch.ts). Deliberately not left to FRIZZ_THREAD
    // inheritance: whether Claude Code passes its own env down to an MCP subprocess is its business,
    // not a contract frizz should depend on.
    const mcpServers = withFrizzThreadSlug(we?.mcpServers, slug)
    // WHICH daemon we are about to lose, resolved BEFORE adoptOrForkBroker — once it forks, both the
    // record and the last-known breadcrumb name the NEW daemon and the question is unanswerable. The
    // in-memory session is the freshest source but only while frizz has been up continuously, and a
    // restart is exactly when a death goes unwatched; lastKnownBrokerDaemon is the copy that outlives
    // both the restart and the record's deletion. Empty ⇒ we genuinely cannot say, and reportDeath
    // declines to guess rather than quoting a predecessor.
    const lostGeneration = sessions.get(slug)?.generation ?? lastKnownBrokerDaemon(deps.stateDir, sessionId)?.generation ?? ""
    const { record, reattached } = await adoptOrForkBroker({
      stateDir: deps.stateDir, cwd, sessionId, executablePath, permissionMode, env: deps.env,
      pluginDir: we?.pluginDir, mcpServers, allowedTools: we?.allowedTools, workerEnv,
      // The operator's launch prefix (Settings.launchPrefix.claude), read at every fork like the
      // compaction window: the next dispatch or cold resume carries an edit, a running daemon keeps the
      // prefix it was forked with. `~/` resolves against the HOME the worker itself will see.
      launchPrefix: () => launchPrefixArgv(deps.getSettings?.(), "claude", { home: deps.env.HOME || homedir(), cwd, env: deps.env }),
      ...fork,
    })
    // A RESUME that had to cold-start is the moment frizz discovers a daemon died while nobody was
    // watching — the one death the live diagnostic relay structurally cannot see. Attribute it from the
    // dead daemon's own exit record now, while the record is still on disk, rather than leaving the
    // operator with "the thread went quiet". A fresh dispatch (no resume) is not a death: there was
    // never a daemon to lose.
    //
    // …unless frizz itself retired that daemon, which is what the mark says. Consumed UNCONDITIONALLY
    // here rather than inside the branch: this fork is the cold resume the mark was left for, so it has
    // done its job either way and must not survive to explain some later death.
    if (!reattached) {
      const retirement = takeBrokerRetirement(deps.stateDir, sessionId)
      if (fork.resume) reportDeath(slug, sessionId, retirement, lostGeneration)
    }
    return bind(slug, sessionId, cwd, record)
  }

  // SINGLE-FLIGHT per session: every caller that needs this session's daemon while one attach is
  // already running for it awaits THAT attach instead of starting its own.
  //
  // Without it two inputs arriving together for a daemon-less thread each ran `adoptOrForkBroker`, each
  // found no live record, and each FORKED. That is not a hypothetical interleaving — it is what a
  // hibernated thread does every time the operator answers its questions: the waker's delivery of the
  // answers and the operator's own send land in the same instant. On 2026-09-30 it put daemons 51062
  // and 51063 (consecutive pids: two spawns back to back) on `we-ve-got-to-start-working`, both
  // resuming one transcript and binding one socket path. The second took the record and the path; the
  // first self-collected a minute later and its teardown deleted the survivor's socket file (see the
  // daemon's shutdown), and every send after that — "GO!!" included — went to a daemon nobody could
  // reach. The forker whose own daemon lost can also simply fail, with "exited before it became ready"
  // (reproduced in scripts/verify-broker-resume-race.mjs), which is how an operator's send can vanish
  // with no ledger entry at all.
  //
  // Keyed by SESSION, not slug: the socket, the record and the transcript are all per session, and a
  // dispatch racing a follow-up on one session id is the same race. A rejection is shared by every
  // caller that joined — each of them needed this daemon, so each send fails and rolls back, and the
  // next one starts a fresh attempt because the entry is removed as the attempt settles.
  const attaching = new Map<string, Promise<ActiveSession>>()
  // Keyed by session id — see `lastInputAt` on the interface.
  const inputHandedAt = new Map<string, number>()
  const attachOnce = (...args: Parameters<typeof attach>): Promise<ActiveSession> => {
    const sessionId = args[1]
    const inFlight = attaching.get(sessionId)
    if (inFlight) return inFlight
    const attempt: Promise<ActiveSession> = attach(...args).finally(() => {
      if (attaching.get(sessionId) === attempt) attaching.delete(sessionId)
    })
    attaching.set(sessionId, attempt)
    return attempt
  }

  // Hand the operator's message to the session and return only once it is provably there. See
  // ClaudeBrokerClient.deliverInput: acknowledged by the daemon when it advertises input-ack-v1, else
  // written to a connected socket. A throw here reaches the caller's RPC, which rolls the send back —
  // the whole point, since the alternative is a `delivered` ledger row for a message no agent will see.
  const deliver = (session: ActiveSession, message: ReturnType<typeof validateInputMessage>): Promise<void> =>
    session.client.deliverInput(message, { acknowledged: session.acksInput })

  const current = (slug: string, sessionId: string): ActiveSession | undefined => {
    const s = sessions.get(slug)
    return s && s.sessionId === sessionId ? s : undefined
  }

  // Is the daemon behind a session we HOLD still the one we are holding?
  //
  // The client reconnects forever by design (that is what carries frizz across a daemon socket blip),
  // so a held ActiveSession outlives the daemon it points at: `client.connected()` goes false, the
  // session stays in the map, and `sendInput` queues the message in `outbound` where it waits for a
  // socket that will never come back. A follow-up sent to a thread whose daemon died therefore
  // vanished silently — the thread simply never answered, which is precisely the "went quiet" this
  // work exists to eliminate. Keyed on the daemon RECORD and its generation rather than on socket
  // connectivity: a LIVE daemon whose socket is momentarily flapping must be kept (the client
  // reconnects to it), while a dead daemon — or a successor that took the record — must not be.
  //
  // The record check alone is NOT enough, and the gap is the case this comment did not consider: a
  // LIVE daemon whose CLIENT has permanently given up. `connectClaudeBroker` closes for good when it
  // never lands a first connection inside its deadline, and from then on it reconnects to nothing —
  // yet the record is still valid and the generation still matches, so this returned true and every
  // later follow-up was handed to the corpse. Consulting `isClosed()` (not `connected()`, which reads
  // false during the very blip we must tolerate) closes it: the session is dropped and re-attached,
  // which is what the daemon-died path already does.
  const holdsLiveDaemon = (session: ActiveSession): boolean => {
    if (session.client.isClosed()) return false
    const record = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, session.sessionId))
    return record !== null && record.generation === session.generation
  }

  // The held client of a LIVE daemon that speaks `mcp-v1`, or a throw saying why not. Unlike listSkills
  // this never closes the held session: an MCP read is a background poll from the plug, and a stale
  // session is dropped by the verbs that act on the thread.
  const liveMcpClient = async (threadSlug: string, sessionId: string): Promise<ClaudeBrokerClient> => {
    const held = current(threadSlug, sessionId)
    if (!held || !holdsLiveDaemon(held)) throw new Error("This thread's Claude session is not running")
    const record = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, held.sessionId))
    if (!record?.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_MCP)) throw new Error("This thread's Claude session predates MCP status")
    return held.client
  }

  return {
    async spawnDispatch(input) {
      // A new dispatch replaces any prior session on the slug.
      const prior = sessions.get(input.threadSlug)
      if (prior) { prior.client.close(); killBroker(deps.stateDir, prior.sessionId); sessions.delete(input.threadSlug) }
      // VALIDATED BEFORE THE SOCKET, for the reason spelled out on followUp below: a frame the daemon
      // refuses is discarded there with nobody to tell, and for a DISPATCH that means a worker that
      // boots, receives no task at all, and sits idle looking frozen from birth.
      const message = validatedInput({ id: randomUUID(), text: input.prompt })
      const session = await attachOnce(input.threadSlug, input.sessionId, input.cwd, input.permissionMode ?? "default", { appendSystemPrompt: input.appendSystemPrompt, model: input.model, effort: input.effort })
      // Acknowledged like a follow-up: a dispatch whose opening prompt never arrived is a worker that
      // boots with no task and looks frozen from birth, so it must fail the dispatch instead.
      await deliver(session, message)
      return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd, generation: session.generation, state: "active" } }
    },

    async followUp(input) {
      // VALIDATE HERE, not only in the daemon — the same reason steerSubAgent does, and it turned out to
      // matter just as much on this path. `sendInput` writes a socket frame and returns; the frame has no
      // reply; the daemon calls `handle.send(...)` and used to swallow its rejection. So a message the
      // protocol validator refused was discarded THERE with nobody to tell, while this function returned
      // normally, the router opened an `enqueued` ledger item (which by design never times out) and the
      // operator watched their own message sit in the transcript as delivered, forever.
      //
      // Measured against a real daemon in `_live_broker_input_drop.mts`: one sentence delivered, the same
      // sentence with a single emoji appended vanished with zero diagnostics. Most of that class is now
      // deliverable (validateInputMessage no longer applies the display-grade class to a prompt body),
      // and a C0 control or a lone surrogate is taken out of the text rather than refused (see
      // validatedInput). The residue — an oversized body, a replayed uuid — must FAIL THE OPERATOR'S
      // SEND rather than evaporate. Running the validator before the frame is what makes that happen:
      // the throw reaches the RPC, which rolls the optimistic bubble back and toasts.
      //
      // FIRST, before any process state is touched: a message that cannot be delivered must not cost a
      // cold resume, and must certainly not cost the `freshProcess` daemon retirement below — killing the
      // operator's worker on the way to refusing their message is the worst possible order.
      const message = validatedInput({ id: inputIdFor(input.deliveryId), text: input.text, ...(input.human ? { human: true } : {}) })
      // Stamped before anything can await, so a second follow-up racing this one already sees it (see
      // `lastInputAt`); withdrawn if the message never reaches the daemon.
      const handedBefore = inputHandedAt.get(input.sessionId)
      const handedAt = Date.now()
      inputHandedAt.set(input.sessionId, handedAt)
      try {
        // A resume another caller already started for this session is the one this message rides — see
        // attachOnce. Waited out BEFORE reading `current`, so the checks below see the daemon it produced
        // (and a `freshProcess` caller retires THAT one, rather than racing it). A failed attempt is not
        // this caller's failure: it falls through and starts its own.
        const inFlight = attaching.get(input.sessionId)
        if (inFlight) await inFlight.catch(() => undefined)
        // Reattach if we don't already hold this session live (frizz restarted, or it was detached). The
        // fork opts carry resume:true + the rebuilt system prompt so a DEAD daemon cold-resumes with the
        // worker contract re-applied; when the daemon is still alive they are ignored (socket reconnect).
        //
        // "Hold it live" means the DAEMON is still there, not merely that this bridge has an entry for the
        // slug — see holdsLiveDaemon. A held session whose daemon died is dropped (and its endlessly
        // retrying client closed) so this cold-resumes instead of queueing the operator's message into a
        // socket that never returns.
        let held = current(input.threadSlug, input.sessionId)
        if (held && !holdsLiveDaemon(held)) { held.client.close(); sessions.delete(input.threadSlug); held = undefined }
        // A caller that asked for a FRESH process is telling us the live one cannot act on this message.
        // Retire the daemon so the attach below cold-resumes instead of reconnecting: the new `claude`
        // re-reads the credential and carries no usage-limit latch. Nothing durable is lost — the
        // transcript is on disk and `resume: true` reads it back — beyond the in-memory sub-agents, and a
        // latched parent's children are already dead by the same 429 that latched it.
        if (input.freshProcess && held) {
          held.client.close()
          killBroker(deps.stateDir, held.sessionId, "fresh-process")
          sessions.delete(input.threadSlug)
          held = undefined
        }
        const session = held ?? await attachOnce(
          input.threadSlug, input.sessionId, input.cwd, input.permissionMode ?? "default",
          { resume: true, appendSystemPrompt: input.appendSystemPrompt, model: input.model, effort: input.effort },
        )
        // A message the operator sends INSTEAD of answering an open card supersedes it. Retire before the
        // input frame, not after: while the card is pending the turn is parked inside canUseTool and will
        // never consume what we send, so the deny has to be in flight first for the frame to land on a turn
        // that can actually read it. Ordering aside, this is also the answer to "they typed instead of
        // clicking" — see retirePendingFor.
        if (!input.keepOpenCards) retirePendingFor(input.threadSlug, input.sessionId, "user-cancelled")
        // AWAITED, and that is the fix for the other half of 2026-09-30: this used to be `sendInput`, which
        // buffers the frame while the socket is down and returns — so a follow-up bound to a socket that
        // never came back resolved, the router recorded "GO!!" as delivered, and the client dropped the
        // frame on its 30s give-up. Now the RPC answers success only for a message the daemon took.
        await deliver(session, message)
      } catch (error) {
        // Only our own stamp: a later input that got through keeps the one it set.
        if (inputHandedAt.get(input.sessionId) === handedAt) {
          if (handedBefore === undefined) inputHandedAt.delete(input.sessionId)
          else inputHandedAt.set(input.sessionId, handedBefore)
        }
        throw error
      }
    },

    interruptTurn(input) {
      const held = current(input.threadSlug, input.sessionId)
      if (!held || !holdsLiveDaemon(held)) return false
      // Fire-and-forget by design, and it is why this needs no capability gate: the daemon's frame
      // handler answers nothing, so there is nothing to wait for and nothing to time out on. A daemon
      // too old to know the frame ignores it, and the follow-up — already delivered above — is simply
      // read at the ordinary time. The degradation is "no faster", never "lost". The same goes for the
      // send-now it now carries: a daemon older than the field reads a plain interrupt.
      //
      // The message is named only when its id IS the uuid the CLI queued it under (see cancelFollowUp):
      // a name the CLI has never heard answers "nothing waiting" and does nothing, so an id that is not
      // one is left out and the send-now speaks for whatever is waiting.
      const named = input.deliveryId !== undefined && inputIdFor(input.deliveryId) === input.deliveryId
      held.client.interrupt({ sendNow: named ? { messageId: input.deliveryId } : {} })
      return true
    },

    async cancelFollowUp(input) {
      const held = current(input.threadSlug, input.sessionId)
      if (!held || !holdsLiveDaemon(held)) {
        if (held) { held.client.close(); sessions.delete(input.threadSlug) }
        throw new Error("This thread's Claude session is no longer running, so nothing is queued to take back")
      }
      // Same shape as the sub-agent-steer capability gate: a detached daemon outlives frizz upgrades by
      // six hours, so the process on the other end may predate the `cancel-input` frame entirely. It
      // would answer NOTHING, and this call would hang to its deadline and then read as a wedged
      // session — when the truth is simply "this session is too old to unqueue from".
      const record = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, held.sessionId))
      if (!record?.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_CANCEL_INPUT)) {
        throw new Error("This thread's Claude session predates unqueueing — its next turn will restart on a session that supports it")
      }
      // `inputIdFor` is what followUp used to mint the SDK uuid, so passing the SAME deliveryId
      // reproduces the SAME uuid — as long as it is uuid-shaped. When it is NOT, followUp substituted a
      // random uuid that nothing recorded, so there is no id to cancel and a fresh one would answer a
      // misleading `false`. Refuse instead of guessing.
      if (inputIdFor(input.deliveryId) !== input.deliveryId) {
        throw new Error("This message was sent without a cancellable id, so it can no longer be taken back")
      }
      return await held.client.cancelInput(input.deliveryId)
    },

    async steerSubAgent(input) {
      // No attach, no resume — see the interface doc. `holdsLiveDaemon` is the same generation check
      // followUp uses to notice a daemon died under a held session; here a miss is terminal rather
      // than a cue to cold-start, because there is no such thing as resuming a sub-agent.
      const held = current(input.threadSlug, input.sessionId)
      if (!held || !holdsLiveDaemon(held)) {
        if (held) { held.client.close(); sessions.delete(input.threadSlug) }
        throw new Error("This sub-agent's session is no longer running, so it cannot be steered")
      }
      // A DETACHED daemon outlives frizz upgrades by design (six-hour idle timeout), so the process on
      // the other end of this socket may well have been forked by the previous build — whose input
      // validator drops the addressing field entirely. That would not fail; it would deliver the
      // operator's steer to the thread's MAIN turn, where the parent obeys it. Refuse instead, and say
      // what fixes it. A daemon forked by this build advertises the capability in its record.
      const record = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, held.sessionId))
      if (!record?.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_SUBAGENT_STEER)) {
        throw new Error("This thread's Claude session predates sub-agent steering — its next turn will restart on a session that supports it")
      }
      // VALIDATE HERE, not only in the daemon. `sendInput` writes a socket frame and returns; the
      // daemon calls `handle.send(...).catch(() => {})`, so a message the protocol validator rejects
      // (a control byte, an over-long body) is discarded THERE with nobody to tell. For a STEER that
      // is unacceptable: the RPC would answer `delivered: true` for a message that never reached the
      // child, which is exactly the "an input that silently drops a steer is worse than no input"
      // failure the prompt box is gated on. Measured on the promoted artifact: an ESC/BEL steer was
      // accepted and vanished. `validatedInput` takes those characters out and delivers the rest, and
      // turns what it still cannot send into an error the operator actually sees.
      const message = validatedInput({ id: inputIdFor(input.deliveryId), text: input.text, parentToolUseId: input.subAgentId })
      // Acknowledged for the same reason a follow-up is: `delivered: true` must mean the daemon has it.
      await deliver(held, message)
    },

    async stopSubAgent(input) {
      const held = current(input.threadSlug, input.sessionId)
      if (!held || !holdsLiveDaemon(held)) {
        if (held) { held.client.close(); sessions.delete(input.threadSlug) }
        throw new Error("This sub-agent's session is no longer running, so it cannot be stopped")
      }
      const record = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, held.sessionId))
      if (!record?.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_STOP_TASK)) {
        throw new Error("This thread's Claude session predates sub-agent stopping — its next turn will restart on a session that supports it")
      }
      await held.client.stopTask(input.taskId)
    },

    // Ask the provider to re-title this session. Same live-daemon + capability discipline as the
    // reload above: never cold-starts a process, because re-titling a session that has to be started
    // first would title a fresh one.
    async renameSession(input) {
      const held = current(input.threadSlug, input.sessionId)
      if (!held || !holdsLiveDaemon(held)) {
        if (held) { held.client.close(); sessions.delete(input.threadSlug) }
        throw new Error("This thread's Claude session is not running, so it cannot be renamed")
      }
      const record = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, held.sessionId))
      if (!record?.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_RENAME)) {
        throw new Error("This thread's Claude session predates in-place rename — its next turn will restart on a session that supports it")
      }
      return await held.client.renameSession(input.description)
    },

    // Ask the LIVE session for its skills. Same capability discipline as the verbs above: an older
    // surviving daemon ignores the unknown frame, and the client would time out reporting "did not
    // answer" — which reads as a wedged agent rather than an out-of-date one.
    async listSkills(input) {
      const held = current(input.threadSlug, input.sessionId)
      if (!held || !holdsLiveDaemon(held)) {
        if (held) { held.client.close(); sessions.delete(input.threadSlug) }
        throw new Error("This thread's Claude session is not running, so there is no skill list to ask it for")
      }
      const record = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, held.sessionId))
      if (!record?.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_LIST_SKILLS)) {
        throw new Error("This thread's Claude session predates skill listing — its next turn will restart on a session that supports it")
      }
      return await held.client.listSkills()
    },

    async mcpServerStatus(input) {
      return await (await liveMcpClient(input.threadSlug, input.sessionId)).mcpServerStatus()
    },

    async reconnectMcpServer(input) {
      await (await liveMcpClient(input.threadSlug, input.sessionId)).reconnectMcpServer(input.name)
    },

    async reconnectMcpServerEverywhere(name) {
      const held = [...sessions.values()].filter((session) => holdsLiveDaemon(session)
        && liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, session.sessionId))?.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_MCP))
      const results = await Promise.allSettled(held.map((session) => session.client.reconnectMcpServer(name)))
      return results.filter((result) => result.status === "fulfilled").length
    },

    async warmUp() {
      let owned: Array<{ threadSlug: string; sessionId: string; cwd: string }>
      try { owned = deps.ownedSessions?.() ?? [] } catch { return }
      if (owned.length === 0) return
      // Enumerate the LIVE daemons once and index them, rather than stat-ing a record per registry row:
      // a project accumulates hundreds of rows and runs a handful of daemons.
      let live: Map<string, BrokerRecord>
      try { live = new Map(liveBrokerRecords(deps.stateDir).map((record) => [record.sessionId, record])) } catch { return }
      for (const target of owned) {
        const record = live.get(target.sessionId)
        if (!record) {
          // No daemon to adopt; a follow-up cold-resumes and attributes the death. Whatever that dead
          // daemon left pending dies WITH it, and this boot is the only thing that will ever notice: the
          // canUseTool promise lived in that process, `pendingPerms` is memory this frizz never had, and a
          // cold resume re-asks inside a NEW turn under a new request id. Leaving the row pending is what
          // pinned an unanswerable card to a transcript tail for a day. `provider-cancelled`, not
          // `turn-ended` — the turn's fate is unknown here; the PROVIDER is what is provably gone.
          retirePendingFor(target.threadSlug, target.sessionId, "provider-cancelled")
          continue
        }
        if (current(target.threadSlug, target.sessionId)) continue // already held (a re-entrant warmUp)
        if (attaching.has(target.sessionId)) continue // a follow-up is attaching it right now; binding too would leave two clients
        // `bind`, not `attach`: adopting must never be able to FORK. Between the enumeration above and
        // here the daemon could have exited, and adoptOrForkBroker would then cold-start a `{kind:"new"}`
        // session on the same id — a fresh empty session writing over a real thread's transcript, at
        // boot, with nobody asking for it. Connecting to a socket that has since gone away simply fails
        // and retries, which is the harmless direction.
        try { bind(target.threadSlug, target.sessionId, target.cwd, record) } catch { /* a boot never fails on a broker */ }
      }
    },

    binding(threadSlug, sessionId) {
      const s = current(threadSlug, sessionId)
      return s ? { threadSlug, sessionId, cwd: s.cwd, generation: s.generation, state: s.client.connected() ? "active" : "detached" } : undefined
    },

    lastInputAt(sessionId) {
      return inputHandedAt.get(sessionId)
    },

    isDaemonAlive(sessionId) {
      return liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, sessionId)) !== null
    },

    daemonLiveness() {
      return brokerLivenessSnapshot(deps.stateDir)
    },

    daemonExit(sessionId) {
      // Scoped to the daemon frizz last knew for this session — the live one if we hold it, else the one
      // its on-disk record names. A session log accumulates every generation, so an unscoped read answers
      // "the newest death here", which is a different question and is wrong exactly when this daemon left
      // no record of its own. No identity ⇒ null, never a predecessor's cause (see readClaudeBrokerExit).
      try {
        const held = [...sessions.values()].find((s) => s.sessionId === sessionId)?.generation
        const generation = held ?? lastKnownBrokerDaemon(deps.stateDir, sessionId)?.generation ?? ""
        return readClaudeBrokerExit(deps.stateDir, sessionId, generation)
      } catch { return null }
    },

    retireDaemon(input) {
      // Killed BY RECORD, exactly like releaseSession, rather than only when this bridge holds the
      // session live: after a frizz restart the daemon is running and unattached, and that is precisely
      // the session whose launch flags are stale. `isDaemonAlive` is read FIRST so the answer describes
      // what was actually retired — the caller turns it into "takes effect on the next turn" versus
      // "saved for the next resume", and those must not be interchangeable.
      const alive = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, input.sessionId)) !== null
      const held = current(input.threadSlug, input.sessionId)
      if (held) { held.client.close(); sessions.delete(input.threadSlug) }
      killBroker(deps.stateDir, input.sessionId, input.reason ?? "retire")
      // NOTHING is terminalized here — no `retirePendingFor`, no pendingPerms sweep. This is not the end
      // of a session, it is the end of a PROCESS, and the conversation carries on in the next one. (The
      // caller refuses to run while a turn, a sub-agent or an approval is outstanding, so there is
      // nothing in flight for this to have orphaned.)
      return alive
    },

    releaseSession(threadSlug, sessionId, reason) {
      // Kill the daemon UNCONDITIONALLY (by record), even when we don't currently hold it live — after a
      // frizz restart the ownerless daemon is still running but unattached, and a stop/complete must not
      // leak it. The return value reports only whether we held a live binding to tear down first.
      const s = current(threadSlug, sessionId)
      if (s) { s.client.close(); sessions.delete(threadSlug) }
      killBroker(deps.stateDir, sessionId)
      // Terminalize the JOURNAL, not just this process's memory of it. When the caller is the lifecycle
      // subscriber, storage.ts has already cancelled these and this is a no-op (an already-terminal
      // record is not returned). When it is router.stopThreadRuntime — Stop, or "Mark as done" — it is
      // the only sweep there is: a completion UPDATEs the row to state='archived' rather than deleting
      // or replacing it, so storage cancels nothing, and `ownedSessions` filters archived rows out of
      // the boot sweep by design. Claude's create sites journal `expiresAt: null`, so expireDue never
      // reaches them either. Without this the card outlives its daemon forever and still renders with
      // working buttons. `reason` was accepted and dropped here for exactly as long as that was true.
      retirePendingFor(threadSlug, sessionId, reason)
      // Belt and braces for the entry whose interaction was ALREADY terminal: it is returned by no
      // cancel, gets no change event, and there is no daemon left to answer it against.
      for (const [id, pending] of pendingPerms) if (pending.scope.sessionId === sessionId) pendingPerms.delete(id)
      return s !== undefined
    },

    close() { unsubInteractions?.(); pendingPerms.clear(); for (const s of sessions.values()) s.client.close(); sessions.clear() },
  }
}
