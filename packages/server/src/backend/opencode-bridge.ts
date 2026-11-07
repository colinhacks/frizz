import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { INTERACTION_PROTOCOL_VERSION, InteractionRequest, NOTES_FIELD_SUFFIX, opencodeModelSlug, type InteractionField, type OpencodeModels, type InteractionRequest as InteractionRequestType } from "@frizz/shared"
import { redactCredentialSyntax } from "../credential-redaction.ts"
import { frizzGithubWorkerEnv } from "../github-credential.ts"
import type { InteractionSessionScope, InteractionStore } from "../interaction-store.ts"
import { log } from "../logging.ts"
import { parseAcpRecord } from "./acp-transcript.ts"
import { OpencodeHttpError, type ModelRef, type OpencodeClient } from "./opencode-client.ts"
import { OpencodeHub, sharedOpencodeHub, type OpencodeHubListener } from "./opencode-hub.ts"
import { OPENCODE_MIN_VERSION, opencodeNativeAvailable, opencodeVersionAtLeast } from "./opencode-service.ts"
import { OpencodeTranscriptWriter, opencodeChildTranscriptPath, opencodeTranscriptPath, type OpencodeSubAgentRecord } from "./opencode-transcript.ts"
import {
  asArray, asNumber, asObject, asString, errorMessage, eventSessionId, frizzToolShape, opencodeRulesOf, opencodeSessionRules, subagentResultText, toolContentText,
  type Json, type OpencodeEvent, type OpencodeMode, type OpencodeRule,
} from "./opencode-types.ts"
import { frizzCliEnv, withFrizzCliOnPath, type FrizzCli } from "./types.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"

// The native OpenCode backend's bridge, one per project context, all of them on one shared service and
// one event stream (opencode-hub.ts).
//
// There is no process to hold and nothing to reattach: a thread is a session id in the service. The
// stream has no replay, so the bridge's one recovery move is RECONCILE, run on every `server.connected`
// (first connect, a dropped stream, a service restart, a Frizz restart): read the session's messages,
// append what the transcript is missing keyed by message and tool id, close a turn that ended in the gap,
// raise any card still open. Everything a live event writes goes through the same idempotent writers, so
// the two paths cannot double a record.
//
// A session's shell environment is held in the service's memory, per exact session id: it is gone after
// a service restart and a child session does not inherit it (core/src/session/environment.ts), so it is
// put again on every connect and on every child's `session.created`.

export const OPENCODE_CONTRACT_KEY = "frizz.contract"

export interface OpencodeBridgeOptions {
  projectId: string
  stateDir: string
  frizzCli?: FrizzCli
  interactions?: InteractionStore
  env?: NodeJS.ProcessEnv
  hub?: OpencodeHub
  /** The worker contract for a thread (dispatch.ts `opencodeWorkerContract`). */
  contractFor?: (threadSlug: string, sessionId: string) => string | undefined
  /** A delivery item has reached the transcript, or was taken back by something other than Frizz. */
  onDelivered?: (threadSlug: string, deliveryId: string) => void
  onStatusChange?: () => void
  now?: () => Date
  flushMs?: number
  /** How long a turn the service no longer lists stays open, in case the service is about to resume it. */
  settleMs?: number
  /** How long an open turn waits for an unreachable service before it is written off. */
  unreachableMs?: number
}

export interface OpencodeSpawnInput {
  threadSlug: string
  sessionId: string
  cwd: string
  model?: ModelRef
  mode: OpencodeMode
  /** The first prompt. The contract rides an instruction entry, not this text. */
  prompt: string
}

export interface OpencodeFollowUpInput {
  threadSlug: string
  sessionId: string
  cwd: string
  opencodeSessionId?: string | null
  model?: ModelRef
  mode: OpencodeMode
  text: string
  deliveryId?: string
  delivery: "steer" | "queue"
  /** Stop the running step so the message is read now rather than at the next safe boundary. */
  interrupt?: boolean
}

export interface OpencodeThreadRef { threadSlug: string; sessionId: string; cwd: string; opencodeSessionId: string; mode: OpencodeMode; model?: ModelRef }

export interface OpencodeTurnLiveness { sessionLive: boolean; turnActive: boolean; queued: number }

const DENIED_FEEDBACK = "The person using Frizz denied this call. Do not retry it: adapt, or say what is blocked in your final message."
const AUTH_HINT = "OpenCode needs a provider login: run `opencode auth login`, then send again."

function clip(text: string, max: number): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text }
function isoFrom(ms: unknown, fallback: string): string { return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : fallback }

/** The inbox id a delivery goes out under, so a retry is idempotent and a take-back can name it. */
export function opencodeInboxId(sessionId: string, deliveryId: string): string {
  return `msg_frizz_${sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}_${deliveryId.replace(/[^A-Za-z0-9]/g, "")}`
}

// ---- one session's transcript, root or child -------------------------------------------------------

/** Writes one session's records, and remembers what it has written, so that a live event and a reconcile
 *  of the same item land once. Rebuilt from the file itself, which is what makes that true across a
 *  Frizz restart. */
class SessionStream {
  turnOpen = false
  /** The last finished step stopped on its own: a user message delivered now starts a new turn. */
  lastStepStopped = false
  /** A person pressed Stop on this turn (interruptTurn): the turn's end is written as theirs, which keeps
   *  the sign-off reminder and the "Rested without a sign-off" card off it (FoldState.operatorStopped). */
  stopRequested = false
  readonly textWritten = new Map<string, number>()
  readonly reasoningSeen = new Set<string>()
  readonly toolNames = new Map<string, string>()
  /** A shell call's command as the agent wrote it, for its permission card: OpenCode's request lists the
   *  command split at every pipe and `&&` (one resource per sub-command). Dropped once the call ends. */
  readonly toolCommands = new Map<string, string>()
  readonly toolCalled = new Set<string>()
  readonly toolDone = new Set<string>()
  readonly usersSeen = new Set<string>()
  readonly compactionsSeen = new Set<string>()
  readonly errorsSeen = new Set<string>()
  readonly enqueued = new Map<string, { type: string; text: string }>()
  readonly writer: OpencodeTranscriptWriter
  private readonly buffers = new Map<string, string>()
  private readonly streaming = new Set<string>()
  private flushTimer: NodeJS.Timeout | undefined
  private finalMessage: string | undefined
  private finalText = ""
  private reasoningOpen = 0
  /** The newest error written this turn, so the execution's copy of a step's error is not written twice. */
  private lastError: string | undefined
  /** A settle check is armed for a turn the service stopped listing. */
  settleTimer: NodeJS.Timeout | undefined

  constructor(
    readonly opencodeId: string,
    readonly path: string,
    private readonly now: () => string,
    private readonly flushMs: number,
    private readonly hooks: {
      onUser?: (inboxId: string, text: string, at: string) => string | undefined
      onTurnClosed?: (stream: SessionStream) => void
      onDelivered?: (inboxId: string) => void
      onError?: (message: string) => void
    } = {},
  ) {
    this.writer = new OpencodeTranscriptWriter(path)
    this.rebuild()
  }

  private rebuild(): void {
    let text = ""
    try { text = readFileSync(this.path, "utf8") } catch { return }
    for (const line of text.split("\n")) {
      const rec = parseAcpRecord(line) as (Json & { kind: string }) | undefined
      if (!rec) continue
      switch (rec.kind) {
        case "turn-start": this.turnOpen = true; break
        case "turn-end": this.turnOpen = false; this.finalText = ""; this.finalMessage = undefined; break
        case "assistant-text": {
          const key = asString(rec.messageId)
          const piece = asString(rec.text) ?? ""
          if (key) {
            this.textWritten.set(key, (this.textWritten.get(key) ?? 0) + piece.length)
            const message = key.split(":")[0]
            if (message !== this.finalMessage) { this.finalMessage = message; this.finalText = "" }
          }
          this.finalText += piece
          break
        }
        case "reasoning": if (asString(rec.oc)) this.reasoningSeen.add(rec.oc as string); break
        case "tool-call": if (asString(rec.id)) { this.toolCalled.add(rec.id as string); this.toolNames.set(rec.id as string, asString(rec.name) ?? "tool"); const command = asString(asObject(rec.input)?.command); if (command) this.toolCommands.set(rec.id as string, command) } this.finalText = ""; break
        case "tool-result": if (asString(rec.id)) { this.toolDone.add(rec.id as string); this.toolCommands.delete(rec.id as string) } break
        case "user-message": if (asString(rec.inboxId)) this.usersSeen.add(rec.inboxId as string); break
        case "compaction": if (asString(rec.oc)) this.compactionsSeen.add(rec.oc as string); break
        case "provider-error": if (asString(rec.oc)) this.errorsSeen.add(rec.oc as string); break
      }
    }
  }

  private flushBuffers(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined }
    for (const [key, text] of this.buffers) {
      if (text) this.writeText(key, text, this.now())
      this.buffers.delete(key)
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.reasoningOpen) return
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flushBuffers() }, this.flushMs)
    this.flushTimer.unref?.()
  }

  private writeText(key: string, text: string, at: string): void {
    if (!text) return
    const message = key.split(":")[0]
    if (message !== this.finalMessage) { this.finalMessage = message; this.finalText = "" }
    this.finalText += text
    this.textWritten.set(key, (this.textWritten.get(key) ?? 0) + text.length)
    this.writer.append({ kind: "assistant-text", at, text, final: false, messageId: key })
  }

  /** A whole text part is known: write whatever of it has not been, unless a thought is still open. */
  private settleText(key: string, full: string, at: string): void {
    this.streaming.delete(key)
    const rest = full.slice(this.textWritten.get(key) ?? 0)
    if (this.reasoningOpen) { this.buffers.set(key, rest); return }
    this.buffers.delete(key)
    this.writeText(key, rest, at)
  }

  private writeReasoning(key: string, text: string, at: string): void {
    if (this.reasoningSeen.has(key)) return
    this.reasoningSeen.add(key)
    if (text.trim()) this.writer.append({ kind: "reasoning", at, text, oc: key })
  }

  private writeToolCall(id: string, rawName: string, input: unknown, at: string): void {
    if (this.toolCalled.has(id)) return
    this.toolCalled.add(id)
    this.flushBuffers()
    this.finalText = ""
    const shaped = frizzToolShape(rawName, input)
    this.toolNames.set(id, shaped.name)
    const command = shaped.name === "Bash" ? asString(asObject(shaped.input)?.command) : undefined
    if (command) this.toolCommands.set(id, command)
    this.writer.append({ kind: "tool-call", at, id, name: shaped.name, input: shaped.input })
  }

  private writeToolResult(id: string, content: unknown, metadata: Json | undefined, failed: boolean, at: string, errorText?: string, cancelled = false): void {
    if (this.toolDone.has(id) || !this.toolCalled.has(id)) return
    this.toolDone.add(id)
    this.toolCommands.delete(id)
    this.flushBuffers()
    let text = toolContentText(content) || errorText || ""
    if (this.toolNames.get(id) === "Agent") text = subagentResultText(text)
    const answers = asArray(metadata?.answers)
    this.writer.append({
      kind: "tool-result", at, id, text,
      ...(cancelled ? { cancelled: true } : failed ? { failed: true } : {}),
      ...(answers.length ? { answers: answers.map((a) => { const list = asArray(a).filter((v): v is string => typeof v === "string"); return list.length ? list.join(", ") : null }) } : {}),
    })
  }

  private writeError(oc: string, err: unknown, at: string): void {
    if (this.errorsSeen.has(oc)) return
    this.errorsSeen.add(oc)
    this.flushBuffers()
    const e = errorMessage(err)
    // A step cut short by a stop or a declined call. Nothing went wrong, so there is no card to draw.
    if (e.code === "aborted") return
    // A failed execution repeats the error of the step that failed it.
    if (this.lastError === e.message) return
    this.lastError = e.message
    const message = e.authNeeded ? `${AUTH_HINT}\n\n${e.message}` : e.message
    this.writer.append({ kind: "provider-error", at, oc, error: { message: clip(message, 2_000), ...(e.code ? { code: e.code } : {}) } })
    this.hooks.onError?.(message)
  }

  private openTurn(at: string): void {
    if (this.turnOpen) return
    this.lastError = undefined
    this.turnOpen = true
    this.lastStepStopped = false
    this.stopRequested = false
    this.writer.append({ kind: "turn-start", at })
  }

  closeTurn(successful: boolean, at: string): void {
    this.reasoningOpen = 0
    this.flushBuffers()
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = undefined }
    if (!this.turnOpen) return
    this.turnOpen = false
    const finalText = this.finalText
    this.finalText = ""
    this.finalMessage = undefined
    this.lastStepStopped = false
    const stopped = this.stopRequested && !successful
    this.stopRequested = false
    this.writer.append({ kind: "turn-end", at, ...(finalText ? { finalText } : {}), successful, ...(stopped ? { stoppedBy: "operator" as const } : {}) })
    this.hooks.onTurnClosed?.(this)
  }

  private deliverUser(inboxId: string, eventText: string, at: string): void {
    if (this.usersSeen.has(inboxId)) return
    this.usersSeen.add(inboxId)
    // A queued message delivers inside the same execution as the turn before it, with no terminal event
    // between them (measured on 2.2.5: a queue of two ran in one execution). To Frizz they are separate
    // turns, each with its own rest and its own fences, so the boundary is written here.
    if (this.turnOpen && this.lastStepStopped) {
      this.closeTurn(true, at)
      this.openTurn(at)
    }
    this.flushBuffers()
    this.lastStepStopped = false
    const text = this.hooks.onUser?.(inboxId, eventText, at) ?? eventText
    this.writer.append({ kind: "user-message", at, text, synthetic: false, inboxId })
    this.hooks.onDelivered?.(inboxId)
  }

  private writeUsage(tokens: unknown, window: number | undefined, at: string): void {
    const t = asObject(tokens)
    if (!t) return
    const cache = asObject(t.cache)
    const used = (asNumber(t.input) ?? 0) + (asNumber(t.output) ?? 0) + (asNumber(cache?.read) ?? 0) + (asNumber(cache?.write) ?? 0)
    if (used > 0) this.writer.append({ kind: "context-usage", at, tokens: used, ...(window ? { window } : {}) })
  }

  note(text: string): void {
    this.writer.append({ kind: "opencode-note", at: this.now(), text })
  }

  /** One live event. Returns whether a turn's state moved. */
  ingest(ev: OpencodeEvent, window: () => number | undefined): boolean {
    const d = ev.data
    const at = isoFrom(ev.created, this.now())
    const message = asString(d.assistantMessageID)
    const partKey = message !== undefined ? `${message}:${asNumber(d.ordinal) ?? 0}` : undefined
    switch (ev.type) {
      case "session.execution.started": {
        if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = undefined }
        const was = this.turnOpen
        this.openTurn(at)
        return !was
      }
      case "session.execution.succeeded": this.closeTurn(true, at); return true
      case "session.execution.failed":
        this.writeError(asString(ev.id) ?? `exec:${at}`, d.error, at)
        this.closeTurn(false, at)
        return true
      case "session.execution.interrupted": {
        // `shutdown` is not an ending: the managed service resumes a claimed session when it comes back, and
        // records no idle message. It is also the reason OpenCode gives for a turn a declined call or a
        // cancelled question ended, with no message either (execution.ts `terminal`). So the turn stays
        // open and the bridge arms a check: if the service does not list it shortly, it is over.
        const reason = asString(d.reason)
        this.flushBuffers()
        if (reason === "shutdown" || reason === "superseded") return false
        this.closeTurn(false, at)
        this.note("Turn cancelled.")
        return true
      }
      case "session.inbox.enqueued": {
        const item = asObject(d.item)
        const payload = asObject(item?.payload)
        if (asString(d.inboxID)) this.enqueued.set(d.inboxID as string, { type: asString(item?.type) ?? "user", text: asString(payload?.text) ?? "" })
        return false
      }
      case "session.inbox.delivered": {
        const inboxId = asString(d.inboxID)
        if (!inboxId) return false
        const item = this.enqueued.get(inboxId)
        this.enqueued.delete(inboxId)
        if (item && item.type !== "user") { this.lastStepStopped = false; return false }
        this.deliverUser(inboxId, item?.text ?? "", at)
        return true
      }
      case "session.inbox.cancelled":
        if (asString(d.inboxID)) this.enqueued.delete(d.inboxID as string)
        return false
      case "session.step.started": this.lastStepStopped = false; return false
      case "session.step.ended":
        this.lastStepStopped = asString(d.finish) === "stop"
        // `session.usage.updated` is the session's cumulative spend. What fills the context is the
        // step's own request, which only this event states.
        this.writeUsage(d.tokens, window(), at)
        return false
      case "session.step.failed":
        this.writeError(`step:${message ?? ev.id ?? at}`, d.error, at)
        return false
      case "session.reasoning.started":
        // A thought draws where it began, so text already buffered goes first, and text that starts while
        // it runs waits for it (its summary only arrives at `.ended`).
        this.flushBuffers()
        this.reasoningOpen++
        return false
      case "session.text.started":
        if (partKey) this.streaming.add(partKey)
        return false
      case "session.text.delta": {
        // Only a part whose start this connection saw: after a dropped stream the deltas pick up mid-part,
        // and `.ended` has the whole text to write instead.
        if (!partKey || !this.streaming.has(partKey)) return false
        const delta = asString(d.delta)
        if (delta) { this.buffers.set(partKey, (this.buffers.get(partKey) ?? "") + delta); this.scheduleFlush() }
        return false
      }
      case "session.text.ended":
        if (partKey) this.settleText(partKey, asString(d.text) ?? "", at)
        return false
      case "session.reasoning.ended":
        this.reasoningOpen = Math.max(0, this.reasoningOpen - 1)
        if (partKey) this.writeReasoning(partKey, asString(d.text) ?? "", at)
        if (!this.reasoningOpen && this.buffers.size) this.flushBuffers()
        return false
      case "session.tool.input.started":
        if (asString(d.id)) this.toolNames.set(d.id as string, asString(d.name) ?? "tool")
        return false
      case "session.tool.called":
        if (asString(d.id)) this.writeToolCall(d.id as string, this.toolNames.get(d.id as string) ?? asString(d.name) ?? "tool", d.input, at)
        return false
      case "session.tool.success":
        if (asString(d.id)) this.writeToolResult(d.id as string, d.content, asObject(d.metadata), false, at)
        return false
      case "session.tool.failed":
        if (asString(d.id)) {
          const e = errorMessage(d.error)
          this.writeToolResult(d.id as string, d.content, asObject(d.metadata), true, at, e.message, e.code === "aborted")
        }
        return false
      case "session.compaction.ended": {
        const key = asString(ev.id) ?? `compaction:${at}`
        if (!this.compactionsSeen.has(key)) {
          this.compactionsSeen.add(key)
          this.flushBuffers()
          this.writer.append({ kind: "compaction", at, oc: key })
        }
        return false
      }
      case "session.compaction.failed":
        this.note(`Compaction failed: ${errorMessage(d.error).message}`)
        return false
      case "session.retry.scheduled":
        this.note(`Retrying after an error: ${errorMessage(d.error).message}`)
        return false
      default:
        return false
    }
  }

  /** The newest message this transcript already knows about, walking newest first. */
  private known(msg: Json): boolean {
    const id = asString(msg.id)
    if (!id) return false
    if (msg.type === "user") return this.usersSeen.has(id)
    if (msg.type === "assistant") {
      let ordinal = 0
      for (const raw of asArray(msg.content)) {
        const part = asObject(raw)
        if (part?.type === "tool" && asString(part.id) && this.toolCalled.has(part.id as string)) return true
        if (part?.type === "text") { if (this.textWritten.has(`${id}:${ordinal}`)) return true; ordinal++ }
      }
    }
    return false
  }

  /** Bring the file up to date from the session's own message list. */
  async reconcile(client: OpencodeClient, directory: string, window: () => number | undefined, findChild: (toolId: string, part: Json) => void): Promise<void> {
    const walked: Json[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const { data, cursor: next } = await client.messages(this.opencodeId, { ...(cursor ? { cursor } : {}), directory })
      let anchored = false
      for (const msg of data) {
        walked.push(msg)
        if (this.known(msg)) { anchored = true; break }
      }
      if (anchored || !next || !data.length) break
      cursor = next
    }
    // Oldest first, and once the delivery order is restored the same writers as the live path apply.
    for (const msg of walked.reverse()) {
      const id = asString(msg.id) ?? ""
      const time = asObject(msg.time)
      const at = isoFrom(time?.created, this.now())
      switch (msg.type) {
        case "user":
          this.openTurn(at)
          this.deliverUser(id, asString(msg.text) ?? asString(asObject(msg.payload)?.text) ?? "", at)
          break
        case "assistant": {
          let textOrdinal = 0
          let reasoningOrdinal = 0
          for (const raw of asArray(msg.content)) {
            const part = asObject(raw)
            if (!part) continue
            if (part.type === "text") {
              this.settleText(`${id}:${textOrdinal++}`, asString(part.text) ?? "", at)
            } else if (part.type === "reasoning") {
              this.writeReasoning(`${id}:${reasoningOrdinal++}`, asString(part.text) ?? "", at)
            } else if (part.type === "tool" && asString(part.id)) {
              const toolId = part.id as string
              const state = asObject(part.state)
              const status = asString(state?.status)
              if (status === "streaming") continue
              this.writeToolCall(toolId, asString(part.name) ?? "tool", state?.input, at)
              findChild(toolId, part)
              if (status === "completed") this.writeToolResult(toolId, state?.content, asObject(state?.metadata), false, at)
              else if (status === "error") {
                const e = errorMessage(state?.error)
                this.writeToolResult(toolId, state?.content, asObject(state?.metadata), true, at, e.message, e.code === "aborted")
              }
            }
          }
          if (msg.finish !== undefined) this.lastStepStopped = msg.finish === "stop"
          if (msg.tokens) this.writeUsage(msg.tokens, window(), at)
          if (msg.error) this.writeError(`step:${id}`, msg.error, at)
          break
        }
        case "compaction":
          if (!this.compactionsSeen.has(id) && (msg.status === "completed" || msg.status === "done" || asString(msg.summary) || asString(msg.text))) {
            this.compactionsSeen.add(id)
            this.writer.append({ kind: "compaction", at, oc: id })
          }
          break
        case "idle":
          if (this.turnOpen) {
            if (msg.outcome === "failed" && msg.error) this.writeError(`idle:${id}`, msg.error, at)
            this.closeTurn(msg.outcome === "succeeded", at)
            if (msg.outcome === "interrupted") this.note("Turn cancelled.")
          }
          break
      }
    }
  }
}

// ---- a thread --------------------------------------------------------------------------------------

interface ChildSession {
  stream: SessionStream
  /** The `subagent` call that started it, once seen. */
  toolId?: string
  label: string
  agent?: string
  startedAt: string
  state: OpencodeSubAgentRecord["state"]
  finishedAt?: string
}

/** A sub-agent the parent's `subagent` call is still waiting on. Interrupting the parent cancels that call
 *  and the child with it (`jobs.block(…).pipe(Effect.onInterrupt(…))` in OpenCode's tool/plugin/subagent.ts),
 *  so an interrupting send leaves its steer to the next boundary instead. A background child, whose call
 *  has already returned, is not cancelled by it. */
function foregroundChildRunning(live: { children: Map<string, ChildSession>; stream: SessionStream }): boolean {
  for (const child of live.children.values()) {
    if (child.state === "running" && (!child.toolId || !live.stream.toolDone.has(child.toolId))) return true
  }
  return false
}

interface AgentCatalog {
  defaultAgent: string
  rules: Map<string, OpencodeRule[]>
}

const UNREAD_RULES_NOTE = "Frizz could not read OpenCode's agents, so this thread follows your OpenCode settings until the permission control is set again."

interface Card {
  interactionId: string
  ownerSessionId: string
  kind: "permission" | "form"
  providerId: string
  scope: InteractionSessionScope
  /** Only for a form: its fields, to turn the card's values back into an answer. */
  fields?: Array<{ key: string; multi: boolean }>
  /** A question whose every field takes free text, so a decline can be said in words. */
  declinable?: boolean
}

interface Live {
  slug: string
  sessionId: string
  opencodeId: string
  cwd: string
  mode: OpencodeMode
  model?: ModelRef
  stream: SessionStream
  children: Map<string, ChildSession>
  cards: Map<string, Card>
  byProviderId: Map<string, string>
  /** Permission requests whose card waits on a read of the call's message, and those answered meanwhile. */
  raising: Set<string>
  raisingGone: Set<string>
  pendingSends: Map<string, { recordText: string; deliveryId?: string }>
  /** Delivered before the send's own POST returned. */
  deliveredEarly: Set<string>
  window?: number
  /** Worth the requests of a reconcile on the next connect or the next message. */
  stale: boolean
  /** The instruction route refused: the contract goes in prompts, as it does on ACP. */
  contractInPrompt: boolean
  contractOwed: boolean
  reconciling?: Promise<void>
  reconcileAgain?: boolean
  unreachableTimer?: NodeJS.Timeout
}

export class OpencodeBridge implements OpencodeHubListener {
  private readonly sessions = new Map<string, Live>()
  private readonly byOpencodeId = new Map<string, { live: Live; stream: SessionStream }>()
  private readonly hub: OpencodeHub
  private detachHub: (() => void) | undefined
  private readonly unsubscribeInteractions: (() => void) | undefined
  private closed = false

  constructor(private readonly options: OpencodeBridgeOptions) {
    this.hub = options.hub ?? sharedOpencodeHub(options.env ?? process.env)
    this.unsubscribeInteractions = options.interactions?.subscribe((change) => {
      if (change.lifecycle === "pending") return
      for (const live of this.sessions.values()) {
        const card = live.cards.get(change.interactionId)
        if (card) { void this.answerCard(live, card) ; break }
      }
    })
  }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString() }
  private get env(): NodeJS.ProcessEnv { return this.options.env ?? process.env }

  private attachHub(): void {
    if (!this.detachHub) this.detachHub = this.hub.attach(this)
    this.hub.wake()
  }

  // ---- hub listener ----------------------------------------------------------------------------

  needsService(): boolean {
    for (const live of this.sessions.values()) if (live.stream.turnOpen) return true
    return false
  }

  onDisconnected(): void {
    for (const live of this.sessions.values()) {
      live.stale = true
      if (!live.stream.turnOpen || live.unreachableTimer) continue
      // The service is gone with a turn open. The hub keeps trying to bring it back, so this only fires
      // when that has failed for long enough that the board should stop reading as working.
      live.unreachableTimer = setTimeout(() => {
        live.unreachableTimer = undefined
        if (this.hub.client || !live.stream.turnOpen) return
        live.stream.writer.append({ kind: "provider-error", at: this.now(), error: { message: "Lost the OpenCode service, and it did not come back. Send a message to try again." } })
        live.stream.closeTurn(false, this.now())
        this.options.onStatusChange?.()
      }, this.options.unreachableMs ?? 120_000)
      live.unreachableTimer.unref?.()
    }
  }

  onConnected(_client: OpencodeClient): void {
    for (const live of this.sessions.values()) {
      if (live.unreachableTimer) { clearTimeout(live.unreachableTimer); live.unreachableTimer = undefined }
      live.stale = true
      if (live.stream.turnOpen || live.cards.size || [...live.children.values()].some((c) => c.state === "running")) void this.reconcile(live)
    }
  }

  onEvent(ev: OpencodeEvent): void {
    if (ev.type === "session.created") {
      const parent = asString(ev.data.parentID)
      const owner = parent ? this.byOpencodeId.get(parent) : undefined
      const childId = asString(ev.data.sessionID)
      if (owner && childId) this.adoptChild(owner.live, childId, { label: asString(ev.data.title), agent: asString(ev.data.agent), createdAt: ev.created })
      return
    }
    const id = eventSessionId(ev)
    const target = id ? this.byOpencodeId.get(id) : undefined
    if (!target) return
    const { live, stream } = target
    if (ev.type === "session.renamed" && stream === live.stream) {
      const title = asString(ev.data.title)
      if (title) stream.writer.append({ kind: "title", title })
      return
    }
    if (ev.type === "permission.asked") { this.raisePermission(live, stream, ev.data); return }
    if (ev.type === "permission.replied") { this.retireProvider(live, asString(ev.data.requestID)); return }
    if (ev.type === "form.created") { const form = asObject(ev.data.form); if (form) this.raiseForm(live, stream, form); return }
    if (ev.type === "form.replied" || ev.type === "form.cancelled") { this.retireProvider(live, asString(ev.data.id)); return }
    if (ev.type === "session.tool.progress" && stream === live.stream) {
      const child = asString(asObject(ev.data.metadata)?.sessionID)
      if (child && asString(ev.data.id)) this.linkChild(live, child, ev.data.id as string, ev.created)
    }
    if (ev.type === "session.step.started") this.learnWindow(live, ev.data.model)
    const moved = stream.ingest(ev, () => live.window)
    if (stream !== live.stream) this.childEventSettled(live, stream, ev)
    if (ev.type === "session.execution.interrupted" && stream.turnOpen) this.armSettle(live, stream)
    if (moved) this.options.onStatusChange?.()
  }

  // ---- sub-agents ------------------------------------------------------------------------------

  private adoptChild(live: Live, childId: string, facts: { label?: string; agent?: string; createdAt?: number }): ChildSession {
    const existing = live.children.get(childId)
    if (existing) return existing
    const at = isoFrom(facts.createdAt, this.now())
    const stream = new SessionStream(childId, opencodeChildTranscriptPath(this.options.stateDir, live.sessionId, childId), () => this.now(), this.options.flushMs ?? 1_000)
    const child: ChildSession = { stream, label: facts.label || "Sub-agent", ...(facts.agent ? { agent: facts.agent } : {}), startedAt: at, state: "running" }
    live.children.set(childId, child)
    this.byOpencodeId.set(childId, { live, stream })
    // Before its first shell can run: a child does not inherit its parent's environment.
    const client = this.hub.client
    if (client) void client.putEnvironment(childId, this.workerEnv(live.slug), live.cwd).catch((err) => this.diagnostic(live.slug, `could not set a sub-agent's environment: ${(err as Error).message}`))
    // It copied its parent's session rules, which end with the PARENT agent's kept denies. Its own agent's
    // (a `general` sub-agent may not ask questions or start sub-agents of its own) go back on now.
    if (client) void this.applyChildRules(client, live, childId, child).catch((err) => this.diagnostic(live.slug, `could not set a sub-agent's rules: ${(err as Error).message}`))
    return child
  }

  private writeSubAgent(live: Live, childId: string, child: ChildSession): void {
    if (!child.toolId) return
    live.stream.writer.append({
      kind: "opencode-subagent", at: this.now(), id: child.toolId, childSessionId: childId, label: child.label,
      ...(child.agent ? { agent: child.agent } : {}), state: child.state, outputFile: child.stream.path, startedAt: child.startedAt,
      ...(child.finishedAt ? { finishedAt: child.finishedAt } : {}),
    })
    this.options.onStatusChange?.()
  }

  private linkChild(live: Live, childId: string, toolId: string, created?: number): void {
    const child = this.adoptChild(live, childId, { createdAt: created })
    if (child.toolId === toolId && child.state === "running") return
    child.toolId = toolId
    child.state = "running"
    delete child.finishedAt
    this.writeSubAgent(live, childId, child)
  }

  private childEventSettled(live: Live, stream: SessionStream, ev: OpencodeEvent): void {
    const child = live.children.get(stream.opencodeId)
    if (!child) return
    const terminal = ev.type === "session.execution.succeeded" ? "completed"
      : ev.type === "session.execution.failed" ? "failed"
      : ev.type === "session.execution.interrupted" && !["shutdown", "superseded"].includes(asString(ev.data.reason) ?? "") ? "killed"
      : undefined
    if (terminal) {
      child.state = terminal
      child.finishedAt = isoFrom(ev.created, this.now())
      this.writeSubAgent(live, stream.opencodeId, child)
    } else if (ev.type === "session.execution.started" && child.state !== "running") {
      child.state = "running"
      delete child.finishedAt
      this.writeSubAgent(live, stream.opencodeId, child)
    }
  }

  // ---- opening a thread ------------------------------------------------------------------------

  private workerEnv(slug: string): Record<string, string> {
    const env = this.env
    const inherited = { ...inheritWorkerEnvironment(env), ...frizzGithubWorkerEnv(env) }
    const cli = this.options.frizzCli
    return cli ? withFrizzCliOnPath({ ...inherited, ...frizzCliEnv(cli, slug) }, cli) : inherited
  }

  private register(ref: OpencodeThreadRef): Live {
    const existing = this.sessions.get(ref.sessionId)
    if (existing) return existing
    const hooks = {
      onUser: (inboxId: string, eventText: string) => {
        const pending = live.pendingSends.get(inboxId)
        return pending?.recordText ?? eventText
      },
      onDelivered: (inboxId: string) => {
        const pending = live.pendingSends.get(inboxId)
        live.pendingSends.delete(inboxId)
        live.deliveredEarly.add(inboxId)
        if (pending?.deliveryId) this.options.onDelivered?.(live.slug, pending.deliveryId)
      },
      onTurnClosed: () => { this.retireCardsOf(live, live.stream.opencodeId) },
    }
    const stream: SessionStream = new SessionStream(ref.opencodeSessionId, opencodeTranscriptPath(this.options.stateDir, ref.sessionId), () => this.now(), this.options.flushMs ?? 1_000, hooks)
    const live: Live = {
      slug: ref.threadSlug, sessionId: ref.sessionId, opencodeId: ref.opencodeSessionId, cwd: ref.cwd, mode: ref.mode, ...(ref.model ? { model: ref.model } : {}),
      stream, children: new Map(), cards: new Map(), byProviderId: new Map(), raising: new Set(), raisingGone: new Set(), pendingSends: new Map(), deliveredEarly: new Set(), stale: true, contractInPrompt: false, contractOwed: false,
    }
    this.sessions.set(ref.sessionId, live)
    this.byOpencodeId.set(ref.opencodeSessionId, { live, stream })
    this.restoreChildren(live)
    this.attachHub()
    return live
  }

  /** The sub-agent rows this transcript already holds: their newest record each. */
  private restoreChildren(live: Live): void {
    let text = ""
    try { text = readFileSync(live.stream.path, "utf8") } catch { return }
    for (const line of text.split("\n")) {
      if (!line.includes('"opencode-subagent"')) continue
      const rec = parseAcpRecord(line) as unknown as OpencodeSubAgentRecord | undefined
      if (rec?.kind !== "opencode-subagent") continue
      const child = live.children.get(rec.childSessionId) ?? this.adoptChild(live, rec.childSessionId, { label: rec.label, agent: rec.agent })
      child.toolId = rec.id
      child.state = rec.state
      child.startedAt = rec.startedAt
      if (rec.finishedAt) child.finishedAt = rec.finishedAt; else delete child.finishedAt
    }
  }

  private async pushContract(client: OpencodeClient, live: Live): Promise<void> {
    const contract = this.options.contractFor?.(live.slug, live.sessionId)
    if (!contract) return
    try {
      await client.putInstruction(live.opencodeId, OPENCODE_CONTRACT_KEY, contract, live.cwd)
      live.contractInPrompt = false
    } catch (err) {
      // The instruction entry route is under /api/experimental, so a later release may move it. Then the
      // contract rides a prompt, as on ACP, and again after each compaction.
      live.contractInPrompt = true
      this.diagnostic(live.slug, `instruction entry refused, falling back to a prompt: ${(err as Error).message}`)
    }
  }

  /** Bring one thread up to date. Serialized per thread, with one rerun if asked again while running. */
  private reconcile(live: Live): Promise<void> {
    if (live.reconciling) { live.reconcileAgain = true; return live.reconciling }
    live.reconciling = this.reconcileOnce(live)
      .catch((err) => { this.diagnostic(live.slug, `reconcile failed: ${(err as Error).message}`) })
      .finally(() => {
        live.reconciling = undefined
        if (live.reconcileAgain) { live.reconcileAgain = false; void this.reconcile(live) }
      })
    return live.reconciling
  }

  private async reconcileOnce(live: Live): Promise<void> {
    const client = this.hub.client
    if (!client) return
    const env = this.workerEnv(live.slug)
    const { cwd } = live
    await client.putEnvironment(live.opencodeId, env, cwd)
    await this.pushContract(client, live)
    const session = await client.getSession(live.opencodeId, cwd).catch(() => undefined)
    this.learnWindow(live, session?.model)
    const window = () => live.window
    const onTool = (toolId: string, part: Json) => {
      const metadata = asObject(asObject(part.state)?.metadata)
      const child = asString(metadata?.sessionID)
      if (part.name === "subagent" && child) this.linkChild(live, child, toolId)
    }
    await live.stream.reconcile(client, cwd, window, onTool)

    const children = await client.childSessions(live.opencodeId, cwd).catch(() => [] as Json[])
    for (const raw of children) {
      const id = asString(raw.id)
      if (id) this.adoptChild(live, id, { label: asString(raw.title), agent: asString(raw.agent) })
    }
    const active = await client.active()
    for (const [childId, child] of live.children) {
      await client.putEnvironment(childId, env, cwd).catch(() => {})
      await child.stream.reconcile(client, cwd, window, () => {})
      const running = active.has(childId)
      if (running && !child.stream.turnOpen) child.stream.ingest({ type: "session.execution.started", data: {} }, window)
      if (running && child.state !== "running") { child.state = "running"; delete child.finishedAt; this.writeSubAgent(live, childId, child) }
      if (!running && child.state === "running") {
        child.stream.closeTurn(true, this.now())
        child.state = "completed"
        child.finishedAt = this.now()
        this.writeSubAgent(live, childId, child)
      }
    }
    if (active.has(live.opencodeId)) {
      if (!live.stream.turnOpen) { live.stream.ingest({ type: "session.execution.started", data: {} }, window); this.options.onStatusChange?.() }
    } else if (live.stream.turnOpen) {
      this.armSettle(live, live.stream)
    }
    await this.syncCards(client, live)
    live.stale = false
    this.options.onStatusChange?.()
  }

  /** The service does not list a turn the transcript has open. A service that just restarted resumes it
   *  within a second or two, so wait before believing that, then close it on what the messages say. */
  private armSettle(live: Live, stream: SessionStream): void {
    if (stream.settleTimer) return
    stream.settleTimer = setTimeout(() => {
      stream.settleTimer = undefined
      void (async () => {
        const client = this.hub.client
        if (!client || !stream.turnOpen) return
        const active = await client.active().catch(() => undefined)
        if (!active || active.has(stream.opencodeId)) return
        await stream.reconcile(client, live.cwd, () => live.window, () => {}).catch(() => {})
        if (stream.turnOpen) { stream.closeTurn(false, this.now()); stream.note("The turn ended without an answer.") }
        const child = live.children.get(stream.opencodeId)
        if (child?.state === "running") {
          child.state = "killed"
          child.finishedAt = this.now()
          this.writeSubAgent(live, stream.opencodeId, child)
        }
        this.options.onStatusChange?.()
      })()
    }, this.options.settleMs ?? 10_000)
    stream.settleTimer.unref?.()
  }

  private learnWindow(live: Live, modelRaw: unknown): void {
    const model = asObject(modelRaw)
    const provider = asString(model?.providerID)
    const id = asString(model?.id)
    if (!provider || !id) return
    const key = `${provider}/${id}`
    const known = this.windows.get(key)
    if (known !== undefined) { live.window = known; return }
    const client = this.hub.client
    if (!client) return
    void client.models(live.cwd).then((models) => {
      for (const m of models) {
        const context = asNumber(asObject(m.limit)?.context)
        if (context) this.windows.set(`${asString(m.providerID)}/${asString(m.id)}`, context)
      }
      live.window = this.windows.get(key)
    }).catch(() => {})
  }
  private readonly windows = new Map<string, number>()

  private diagnostic(slug: string, message: string): void {
    log.warn("opencode", `[${slug}] ${message}`)
  }

  // ---- cards -----------------------------------------------------------------------------------

  private scopeOf(live: Live): InteractionSessionScope {
    return { projectId: this.options.projectId, threadSlug: live.slug, sessionId: live.sessionId }
  }

  private owner(live: Live, itemId: string) {
    return { projectId: this.options.projectId, threadSlug: live.slug, sessionId: live.sessionId, turnId: clip(itemId, 500), itemId: clip(itemId, 500), sessionEpoch: 0, capabilityRevision: 0 }
  }

  private raisePermission(live: Live, stream: SessionStream, data: Json): void {
    const requestId = asString(data.id)
    const store = this.options.interactions
    if (!requestId || live.byProviderId.has(requestId) || live.raising.has(requestId)) return
    const client = this.hub.client
    if (!store) {
      if (client) void client.replyPermission(stream.opencodeId, requestId, "reject", live.cwd).catch(() => {})
      return
    }
    const source = asObject(data.source)
    const callId = asString(source?.id)
    const messageId = asString(source?.messageID)
    const known = callId ? stream.toolCommands.get(callId) : undefined
    // OpenCode's request lists a shell command split at every `|` and `&&`. When this bridge never saw
    // the call (raised again by a reconcile, or asked while Frizz was down), its input is in the message.
    if (asString(data.action) === "shell" && !known && callId && messageId && client) {
      live.raising.add(requestId)
      void client.message(stream.opencodeId, messageId, live.cwd)
        .then((message) => opencodeCallCommand(message, callId))
        .catch(() => undefined)
        .then((command) => {
          live.raising.delete(requestId)
          // Answered elsewhere while the message was read: no card for a request that is gone.
          if (live.raisingGone.delete(requestId)) return
          this.createPermissionCard(live, stream, data, requestId, command, command === undefined)
        })
      return
    }
    this.createPermissionCard(live, stream, data, requestId, known, false)
  }

  private createPermissionCard(live: Live, stream: SessionStream, data: Json, requestId: string, command: string | undefined, split: boolean): void {
    const store = this.options.interactions
    if (!store || live.byProviderId.has(requestId)) return
    const client = this.hub.client
    const child = stream === live.stream ? undefined : live.children.get(stream.opencodeId)
    const request = buildOpencodePermissionInteraction(data, this.owner(live, requestId), live.cwd, child?.label, command, split)
    if (!request) {
      this.diagnostic(live.slug, "a permission request could not be shown as a card; rejecting it")
      if (client) void client.replyPermission(stream.opencodeId, requestId, "reject", live.cwd).catch(() => {})
      return
    }
    const id = store.create(request).interaction.id
    live.cards.set(id, { interactionId: id, ownerSessionId: stream.opencodeId, kind: "permission", providerId: requestId, scope: this.scopeOf(live) })
    live.byProviderId.set(requestId, id)
    this.options.onStatusChange?.()
  }

  private raiseForm(live: Live, stream: SessionStream, form: Json): void {
    const formId = asString(form.id)
    const store = this.options.interactions
    if (!formId || live.byProviderId.has(formId)) return
    const client = this.hub.client
    if (!store) {
      if (client) void client.cancelForm(stream.opencodeId, formId, live.cwd).catch(() => {})
      return
    }
    const built = buildOpencodeFormInteraction(form, this.owner(live, formId), stream === live.stream ? undefined : live.children.get(stream.opencodeId)?.label)
    if (!built) {
      this.diagnostic(live.slug, "a form could not be shown as a card; cancelling it")
      if (client) void client.cancelForm(stream.opencodeId, formId, live.cwd).catch(() => {})
      return
    }
    const id = store.create(built.request).interaction.id
    live.cards.set(id, { interactionId: id, ownerSessionId: stream.opencodeId, kind: "form", providerId: formId, scope: this.scopeOf(live), fields: built.fields, declinable: built.declinable })
    live.byProviderId.set(formId, id)
    this.options.onStatusChange?.()
  }

  /** The operator answered, or the store cancelled the card: tell the service. */
  private async answerCard(live: Live, card: Card): Promise<void> {
    live.cards.delete(card.interactionId)
    live.byProviderId.delete(card.providerId)
    const record = this.options.interactions?.get(card.scope, card.interactionId)
    const resolution = record?.lifecycle === "resolved" ? record.resolution : undefined
    const client = this.hub.client
    if (!client) { live.stale = true; return }
    try {
      if (card.kind === "permission") {
        const decision = resolution?.decisionId
        // A rejection with words fails that one call and the model reads them and carries on; one without
        // ends the whole turn (permission.ts CorrectedError, DeclinedError). A card the person answered
        // says no to the call, not to the turn. A card nobody answered, because the thread went away,
        // has no one to carry on for.
        if (decision === "accept" || decision === "grant-turn") await client.replyPermission(card.ownerSessionId, card.providerId, "once", live.cwd)
        else if (decision === "acceptForSession" || decision === "grant-session") await client.replyPermission(card.ownerSessionId, card.providerId, "always", live.cwd)
        else await client.replyPermission(card.ownerSessionId, card.providerId, "reject", live.cwd, resolution ? DENIED_FEEDBACK : undefined)
      } else if (resolution && (resolution.decisionId === "answer" || resolution.decisionId === "accept")) {
        await client.replyForm(card.ownerSessionId, card.providerId, opencodeFormAnswer(card.fields ?? [], resolution.values as Record<string, unknown> | undefined), live.cwd)
      } else if (resolution && card.declinable) {
        // Cancelling a question ends the turn too, where the card promises the agent decides for itself.
        await client.replyForm(card.ownerSessionId, card.providerId, opencodeFormDecline(card.fields ?? []), live.cwd)
      } else {
        await client.cancelForm(card.ownerSessionId, card.providerId, live.cwd)
      }
    } catch (err) {
      // Not found: another client answered it first, or the turn it belonged to is over.
      if (!(err instanceof OpencodeHttpError && err.status === 404)) {
        this.diagnostic(live.slug, `could not send an answer: ${(err as Error).message}`)
        live.stale = true
        void this.reconcile(live)
      }
    }
    this.options.onStatusChange?.()
  }

  /** Something other than the card answered (another client, the turn ending): take the card away. */
  private retireProvider(live: Live, providerId: string | undefined): void {
    if (!providerId) return
    if (live.raising.has(providerId)) live.raisingGone.add(providerId)
    const id = live.byProviderId.get(providerId)
    if (!id) return
    this.retireCard(live, id)
  }

  private retireCard(live: Live, interactionId: string): void {
    const card = live.cards.get(interactionId)
    if (!card) return
    // Out of the maps FIRST, so the store's cancellation event finds nothing to answer.
    live.cards.delete(interactionId)
    live.byProviderId.delete(card.providerId)
    try { this.options.interactions?.withdraw(card.scope, interactionId) } catch { /* hygiene */ }
    this.options.onStatusChange?.()
  }

  private retireCardsOf(live: Live, ownerSessionId: string): void {
    for (const card of [...live.cards.values()]) if (card.ownerSessionId === ownerSessionId) this.retireCard(live, card.interactionId)
  }

  private async syncCards(client: OpencodeClient, live: Live): Promise<void> {
    const open = new Set<string>()
    let complete = true
    for (const [id, stream] of [[live.opencodeId, live.stream] as const, ...[...live.children].map(([cid, c]) => [cid, c.stream] as const)]) {
      const perms = await client.permissions(id, live.cwd).catch(() => { complete = false; return [] as Json[] })
      for (const p of perms) { if (asString(p.id)) open.add(p.id as string); this.raisePermission(live, stream, p) }
      const forms = await client.forms(id, live.cwd).catch(() => { complete = false; return [] as Json[] })
      for (const f of forms) { if (asString(f.id)) open.add(f.id as string); this.raiseForm(live, stream, f) }
    }
    if (!complete) return
    for (const card of [...live.cards.values()]) if (!open.has(card.providerId)) this.retireCard(live, card.interactionId)
  }

  ownsInteraction(scope: InteractionSessionScope, interactionId: string): boolean {
    const live = this.sessions.get(scope.sessionId)
    return live !== undefined && live.slug === scope.threadSlug && live.cards.has(interactionId)
  }

  // ---- what the router calls ---------------------------------------------------------------------

  async spawnDispatch(input: OpencodeSpawnInput): Promise<{ opencodeSessionId: string; version?: string }> {
    if (this.closed) throw new Error("OpenCode bridge is closed")
    const client = await this.connect()
    await this.locationReady(client, input.cwd, input.model)
    // Read fresh at a thread's start: the person may have edited `opencode.json` since the last one.
    const catalog = await this.agentCatalog(client, input.cwd, true)
    const agent = this.agentFor(catalog, input.mode)
    const { rules: permissions, unread } = this.rulesFor(catalog, input.mode, agent)
    const session = await client.createSession({
      directory: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      agent,
      metadata: { frizz: { sessionId: input.sessionId, slug: input.threadSlug, projectId: this.options.projectId } },
      permissions,
    })
    const opencodeId = session.id as string
    // A session reports no version of its own; the service's `/api/info` does.
    const version = asString(session.version) ?? this.hub.version
    const live = this.register({ threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd, opencodeSessionId: opencodeId, mode: input.mode, ...(input.model ? { model: input.model } : {}) })
    live.stream.writer.append({ kind: "opencode-session", at: this.now(), opencodeSessionId: opencodeId, cwd: input.cwd, ...(input.model ? { model: opencodeModelSlug(input.model) } : {}), ...(version ? { version } : {}) })
    if (unread) live.stream.note(UNREAD_RULES_NOTE)
    await client.putEnvironment(opencodeId, this.workerEnv(input.threadSlug), input.cwd)
    await this.pushContract(client, live)
    live.stale = false
    this.learnWindow(live, session.model ?? input.model)
    const contract = live.contractInPrompt ? this.options.contractFor?.(input.threadSlug, input.sessionId) : undefined
    const inboxId = opencodeInboxId(input.sessionId, randomUUID())
    live.pendingSends.set(inboxId, { recordText: input.prompt })
    await client.prompt(opencodeId, { id: inboxId, text: contract ? `${contract}\n\n${input.prompt}` : input.prompt }, input.cwd)
    return { opencodeSessionId: opencodeId, ...(version ? { version } : {}) }
  }

  /** A service that has just started, or a directory it has not served yet, activates its plugins first,
   *  and until then answers `/api/model` with 503 ("Location plugins did not finish activating") and fails a
   *  prompt with "Model unavailable" (`provider.no-route`, measured on 2.0.27 a moment after `service
   *  start`). So the first dispatch to a directory on each service waits for its catalogue, and for the model
   *  it names, for up to 30s. A model still missing then is a real no-route and fails as one. */
  private readonly readyLocations = new WeakMap<OpencodeClient, Set<string>>()
  private async locationReady(client: OpencodeClient, cwd: string, model?: { providerID: string; id: string }): Promise<void> {
    let ready = this.readyLocations.get(client)
    if (!ready) { ready = new Set(); this.readyLocations.set(client, ready) }
    if (ready.has(cwd)) return
    const deadline = Date.now() + 30_000
    for (;;) {
      const models = await withStartupRetry(() => client.models(cwd)).catch(() => undefined)
      const listed = models && (!model || models.some((m) => asString(m.providerID) === model.providerID && asString(m.id) === model.id))
      if (listed) { ready.add(cwd); return }
      if (Date.now() > deadline) return
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  private connect(): Promise<OpencodeClient> {
    this.attachHub()
    return this.hub.connect()
  }

  /** A thread this runtime has not opened yet, or one whose picture may be stale. */
  private async attached(ref: OpencodeThreadRef): Promise<{ client: OpencodeClient; live: Live }> {
    const client = await this.connect()
    const live = this.register(ref)
    live.cwd = ref.cwd
    if (live.stale) await this.reconcile(live)
    return { client, live }
  }

  async followUp(input: OpencodeFollowUpInput): Promise<{ opencodeSessionId: string; state: "queued" | "delivered" }> {
    if (this.closed) throw new Error("OpenCode bridge is closed")
    if (!input.opencodeSessionId) throw new Error("This OpenCode thread has no session id.")
    const { client, live } = await this.attached({ threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd, opencodeSessionId: input.opencodeSessionId, mode: input.mode, ...(input.model ? { model: input.model } : {}) })
    // After a service restart the client is new, and the directory activates again (locationReady).
    await this.locationReady(client, live.cwd)
    const inboxId = opencodeInboxId(input.sessionId, input.deliveryId ?? randomUUID())
    live.pendingSends.set(inboxId, { recordText: input.text, ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}) })
    const contract = live.contractOwed ? this.options.contractFor?.(input.threadSlug, input.sessionId) : undefined
    try {
      await client.prompt(live.opencodeId, { id: inboxId, text: contract ? `${contract}\n\n${input.text}` : input.text, delivery: input.delivery }, live.cwd)
    } catch (err) {
      live.pendingSends.delete(inboxId)
      throw err
    }
    if (contract) { live.contractOwed = false; live.stream.writer.append({ kind: "acp-contract", at: this.now(), reason: "compaction" }) }
    if (input.interrupt && live.stream.turnOpen && !foregroundChildRunning(live)) await client.interrupt(live.opencodeId, { resume: true, directory: live.cwd }).catch(() => {})
    const delivered = live.deliveredEarly.delete(inboxId)
    return { opencodeSessionId: live.opencodeId, state: delivered ? "delivered" : "queued" }
  }

  /** Stop the running turn. Pending input stays in the inbox and goes out, as on every other backend. */
  async interruptTurn(threadSlug: string, sessionId: string, opencodeSessionId?: string | null, cwd?: string): Promise<{ interrupted: boolean }> {
    const live = this.sessions.get(sessionId)
    if (live && live.slug !== threadSlug) return { interrupted: false }
    const id = live?.opencodeId ?? opencodeSessionId
    if (!id) return { interrupted: false }
    if (live && !live.stream.turnOpen) return { interrupted: false }
    const client = this.hub.client ?? await this.connect()
    const directory = live?.cwd ?? cwd
    const pending = await client.inbox(id, directory).catch(() => [] as Json[])
    // Marked before the call: the interrupted event can arrive before it returns.
    if (live) live.stream.stopRequested = true
    try {
      await client.interrupt(id, { resume: pending.length > 0, ...(directory ? { directory } : {}) })
    } catch (error) {
      if (live) live.stream.stopRequested = false
      throw error
    }
    return { interrupted: true }
  }

  /** Stop this runtime tracking a session and stop its turn. The session stays in OpenCode, where the
   *  person's other clients can still open it: Frizz never deletes one. */
  releaseSession(threadSlug: string, sessionId: string, _reason: "session-replaced" | "session-deleted"): void {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug) return
    const client = this.hub.client
    if (client && live.stream.turnOpen) void client.interrupt(live.opencodeId, { directory: live.cwd }).catch(() => {})
    if (live.stream.settleTimer) clearTimeout(live.stream.settleTimer)
    if (live.unreachableTimer) clearTimeout(live.unreachableTimer)
    for (const card of [...live.cards.values()]) {
      if (client) {
        if (card.kind === "permission") void client.replyPermission(card.ownerSessionId, card.providerId, "reject", live.cwd).catch(() => {})
        else void client.cancelForm(card.ownerSessionId, card.providerId, live.cwd).catch(() => {})
      }
      this.retireCard(live, card.interactionId)
    }
    if (live.stream.turnOpen) { live.stream.closeTurn(false, this.now()) }
    for (const [childId, child] of live.children) {
      if (child.stream.turnOpen) child.stream.closeTurn(false, this.now())
      this.byOpencodeId.delete(childId)
    }
    this.byOpencodeId.delete(live.opencodeId)
    this.sessions.delete(sessionId)
    this.options.onStatusChange?.()
  }

  /** At boot: every thread whose transcript says something is running. A thread at rest opens on its
   *  next message, so a Frizz restart wakes no service for someone who is not using OpenCode right now. */
  warmUp(rows: ReadonlyArray<OpencodeThreadRef>): void {
    for (const row of rows) {
      if (this.closed) return
      try {
        if (!transcriptHasOpenWork(opencodeTranscriptPath(this.options.stateDir, row.sessionId))) continue
        this.register(row)
      } catch (err) {
        this.diagnostic(row.threadSlug, `could not reattach: ${(err as Error).message}`)
      }
    }
    if (this.sessions.size) this.hub.wake()
  }

  async setModel(ref: OpencodeThreadRef, model: ModelRef): Promise<void> {
    const { client, live } = await this.attached(ref)
    await client.selectModel(live.opencodeId, model, live.cwd)
    live.model = model
    this.learnWindow(live, model)
  }

  async setPermission(ref: OpencodeThreadRef, mode: OpencodeMode): Promise<void> {
    const { client, live } = await this.attached(ref)
    // Read fresh on every change, for the same reason as at a thread's start.
    const catalog = await this.agentCatalog(client, live.cwd, true)
    const agent = this.agentFor(catalog, mode)
    await client.selectAgent(live.opencodeId, agent, live.cwd)
    const { rules, unread } = this.rulesFor(catalog, mode, agent)
    await client.patchSession(live.opencodeId, { permissions: rules }, live.cwd)
    if (unread) live.stream.note(UNREAD_RULES_NOTE)
    live.mode = mode
    // A child took its parent's rules when it was created, and only then. Each gets its OWN agent's kept
    // rules: a sub-agent's agent (`general`, `explore`) carries denies the parent's does not.
    for (const [childId, child] of live.children) {
      await this.applyChildRules(client, live, childId, child, catalog).catch(() => {})
    }
  }

  /** What OpenCode resolved for every agent in a directory, read at most every 30s unless `fresh`. */
  private readonly catalogs = new WeakMap<OpencodeClient, Map<string, { at: number; catalog: AgentCatalog }>>()
  private async agentCatalog(client: OpencodeClient, cwd: string, fresh = false): Promise<AgentCatalog | undefined> {
    let byDir = this.catalogs.get(client)
    if (!byDir) { byDir = new Map(); this.catalogs.set(client, byDir) }
    const cached = byDir.get(cwd)
    if (cached && !fresh && Date.now() - cached.at < 30_000) return cached.catalog
    try {
      const agents = await withStartupRetry(() => client.agents(cwd))
      const rules = new Map<string, OpencodeRule[]>()
      for (const agent of agents) { const id = asString(agent.id); if (id) rules.set(id, opencodeRulesOf(agent.permissions)) }
      const primary = agents.find((a) => a.mode !== "subagent" && a.hidden !== true)
      const catalog: AgentCatalog = { defaultAgent: asString(primary?.id) ?? "build", rules }
      byDir.set(cwd, { at: Date.now(), catalog })
      return catalog
    } catch (err) {
      log.warn("opencode", `could not read OpenCode's agents for ${cwd}: ${(err as Error).message}`)
      return undefined
    }
  }

  /** The agent a mode runs: OpenCode's `plan`, or the person's default primary agent (`build` unless their
   *  configuration names another), which the agent list puts first. */
  private agentFor(catalog: AgentCatalog | undefined, mode: OpencodeMode): string {
    if (mode === "plan") return "plan"
    return catalog?.defaultAgent ?? "build"
  }

  /** A session's rules for a mode. When OpenCode's agents could not be read, a mode that adds rules adds
   *  NONE: without the person's denies Frizz cannot put them back, and no rules is their own behaviour. */
  private rulesFor(catalog: AgentCatalog | undefined, mode: OpencodeMode, agent: string): { rules: OpencodeRule[]; unread: boolean } {
    const plain = opencodeSessionRules(mode)
    if (plain.length === 0) return { rules: [], unread: false }
    if (!catalog) return { rules: [], unread: true }
    return { rules: opencodeSessionRules(mode, catalog.rules.get(agent) ?? []), unread: false }
  }

  private async applyChildRules(client: OpencodeClient, live: Live, childId: string, child: ChildSession, catalog?: AgentCatalog): Promise<void> {
    const agent = child.agent ?? asString((await client.getSession(childId, live.cwd))?.agent)
    if (agent && !child.agent) child.agent = agent
    const { rules } = this.rulesFor(catalog ?? await this.agentCatalog(client, live.cwd), live.mode, agent ?? "general")
    await client.patchSession(childId, { permissions: rules }, live.cwd)
  }

  async compact(ref: OpencodeThreadRef): Promise<void> {
    const { client, live } = await this.attached(ref)
    await client.compact(live.opencodeId, live.cwd)
  }

  async rename(ref: OpencodeThreadRef, title: string): Promise<void> {
    const { client, live } = await this.attached(ref)
    await client.patchSession(live.opencodeId, { title }, live.cwd)
  }

  /** Take a queued message back. `false` means it was already delivered. */
  async cancelQueued(ref: OpencodeThreadRef, deliveryId: string): Promise<boolean> {
    const { client, live } = await this.attached(ref)
    const inboxId = opencodeInboxId(ref.sessionId, deliveryId)
    const before = await client.inbox(live.opencodeId, live.cwd)
    if (!before.some((item) => item.id === inboxId)) return false
    await client.cancelInbox(live.opencodeId, inboxId, live.cwd)
    const after = await client.inbox(live.opencodeId, live.cwd)
    if (after.some((item) => item.id === inboxId) || live.stream.usersSeen.has(inboxId)) return false
    live.pendingSends.delete(inboxId)
    return true
  }

  /** Promote a queued message to a steer, so it is read at the next safe boundary. */
  /** Send now: the steers waiting in OpenCode's inbox for the next step boundary are read at once, by
   *  interrupting the running step with `resume`, which starts the execution again on them. Refused while a
   *  foreground sub-agent runs (interrupting would cancel it) and when nothing is waiting. */
  async pushSteers(ref: OpencodeThreadRef): Promise<"pushed" | "nothing" | "subagent"> {
    const { client, live } = await this.attached(ref)
    if (!live.stream.turnOpen) return "nothing"
    const items = await client.inbox(live.opencodeId, live.cwd)
    if (!items.some((item) => asString(item.delivery) !== "queue")) return "nothing"
    if (foregroundChildRunning(live)) return "subagent"
    await client.interrupt(live.opencodeId, { resume: true, directory: live.cwd })
    return "pushed"
  }

  /** Stop one sub-agent. */
  async stopChild(threadSlug: string, sessionId: string, childId: string): Promise<boolean> {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug || !live.children.has(childId)) return false
    const client = this.hub.client
    if (!client) return false
    await client.interrupt(childId, { directory: live.cwd })
    return true
  }

  /** Speak to one sub-agent: its own session takes a prompt like any other. */
  async steerChild(threadSlug: string, sessionId: string, childId: string, text: string): Promise<boolean> {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug || !live.children.has(childId)) return false
    const client = this.hub.client
    if (!client) return false
    await client.prompt(childId, { text, delivery: "steer" }, live.cwd)
    return true
  }

  childRunning(threadSlug: string, sessionId: string, childId: string): boolean {
    const live = this.sessions.get(sessionId)
    return live?.slug === threadSlug && live.children.get(childId)?.state === "running"
  }

  /** Whether Frizz holds this thread right now: its turn is running, or a card of its is open. */
  isAgentAlive(threadSlug: string, sessionId: string): boolean {
    const live = this.sessions.get(sessionId)
    return live !== undefined && live.slug === threadSlug && (live.stream.turnOpen || live.cards.size > 0)
  }

  turnLiveness(threadSlug: string, sessionId: string): OpencodeTurnLiveness | undefined {
    const live = this.sessions.get(sessionId)
    if (!live || live.slug !== threadSlug) return undefined
    return { sessionLive: this.hub.client !== undefined, turnActive: live.stream.turnOpen, queued: live.pendingSends.size }
  }

  /** What the composer's picker shows. Starts the service, so only the picker for OpenCode asks. */
  async models(cwd: string): Promise<OpencodeModels> {
    const available = await opencodeNativeAvailable(this.env)
    if (!available.available) return { available: false, ...(available.version ? { version: available.version } : {}), models: [], ...(available.reason ? { error: available.reason } : {}) }
    try {
      const client = await this.connect()
      const [models, fallback] = await Promise.all([withStartupRetry(() => client.models(cwd)), withStartupRetry(() => client.defaultModel(cwd)).catch(() => undefined)])
      const listed: OpencodeModels["models"] = []
      for (const m of models) {
        const providerID = asString(m.providerID)
        const id = asString(m.id)
        if (!providerID || !id || m.enabled === false || m.type === "image" || m.status === "deprecated") continue
        const context = asNumber(asObject(m.limit)?.context)
        if (context) this.windows.set(`${providerID}/${id}`, context)
        listed.push({
          providerID, id, name: asString(m.name) ?? id,
          variants: asArray(m.variants).map((v) => asString(asObject(v)?.id)).filter((v): v is string => !!v),
          ...(context ? { context } : {}),
        })
      }
      const defaultModel = fallback && asString(fallback.providerID) && asString(fallback.id) ? opencodeModelSlug({ providerID: fallback.providerID as string, id: fallback.id as string }) : undefined
      return { available: true, ...(available.version ? { version: available.version } : {}), models: listed, ...(defaultModel ? { defaultModel } : {}) }
    } catch (err) {
      return { available: true, ...(available.version ? { version: available.version } : {}), models: [], error: (err as Error).message }
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true
    this.unsubscribeInteractions?.()
    // Detach only: the turns are the service's and carry on, and the next runtime reconciles them. Cards
    // go, without an answer, because nothing here could deliver one; the service still holds the request
    // and the reconcile raises it again.
    for (const live of this.sessions.values()) {
      if (live.stream.settleTimer) clearTimeout(live.stream.settleTimer)
      if (live.unreachableTimer) clearTimeout(live.unreachableTimer)
      for (const card of [...live.cards.values()]) this.retireCard(live, card.interactionId)
    }
    this.sessions.clear()
    this.byOpencodeId.clear()
    this.detachHub?.()
    this.detachHub = undefined
  }
}

/** A location the service has just opened answers 503 until its plugins activate, which takes seconds on
 *  a first run. Measured on 2.2.5: "Location plugins did not finish activating". */
async function withStartupRetry<T>(read: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      return await read()
    } catch (err) {
      if (!(err instanceof OpencodeHttpError && err.status === 503) || Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

/** One session's transcript writer, exported for the recorded-stream test. */
export { SessionStream as OpencodeSessionStream }

export function createOpencodeBridge(options: OpencodeBridgeOptions): OpencodeBridge { return new OpencodeBridge(options) }

/** Whether a transcript ends with a turn open or a sub-agent still running. */
export function transcriptHasOpenWork(path: string): boolean {
  let text: string
  try { text = readFileSync(path, "utf8") } catch { return false }
  let open = false
  const running = new Map<string, boolean>()
  for (const line of text.split("\n")) {
    if (line.includes('"turn-start"')) { const rec = parseAcpRecord(line); if (rec?.kind === "turn-start") open = true }
    else if (line.includes('"turn-end"')) { const rec = parseAcpRecord(line); if (rec?.kind === "turn-end") open = false }
    else if (line.includes('"opencode-subagent"')) {
      const rec = parseAcpRecord(line) as unknown as OpencodeSubAgentRecord | undefined
      if (rec?.kind === "opencode-subagent") running.set(rec.childSessionId, rec.state === "running")
    }
  }
  return open || [...running.values()].some(Boolean)
}

// ---- building cards ---------------------------------------------------------------------------------

const APPROVAL_DECISIONS = {
  once: { id: "accept", semantic: "approve" as const, label: "Allow once", description: "Allow this once." },
  always: { id: "acceptForSession", semantic: "approve" as const, label: "Always allow", description: "OpenCode remembers this for the project, in every session." },
  reject: { id: "decline", semantic: "deny" as const, label: "Deny", description: "Block this tool call." },
}

export function buildOpencodePermissionInteraction(
  data: Json,
  owner: { projectId: string; threadSlug: string; sessionId: string; turnId: string; itemId: string; sessionEpoch: number; capabilityRevision: number },
  cwd: string,
  childLabel: string | undefined,
  /** The whole command of the shell call asking, from the call itself. */
  command?: string,
  /** The call's input could not be read: what shows is OpenCode's sub-commands, and the card says so. */
  split = false,
): InteractionRequestType | null {
  const action = asString(data.action) ?? "tool"
  const resources = asArray(data.resources).filter((r): r is string => typeof r === "string")
  const metadata = asObject(data.metadata)
  const source = asObject(data.source)
  const toolId = asString(source?.id) ?? (asString(data.id) as string)
  const canAlways = asArray(data.save).length > 0
  const who = childLabel ? `Sub-agent "${childLabel}": ` : ""
  const summary = action === "shell" && command ? command : resources.join("\n")
  const splitNote = action === "shell" && !command && split && resources.length > 1
  const preview = clip(redactCredentialSyntax(summary), 6_000)
  const label = clip(redactCredentialSyntax(summary.replace(/\s+/g, " ")), 150)
  const allowedDecisions = [APPROVAL_DECISIONS.once, ...(canAlways ? [APPROVAL_DECISIONS.always] : []), APPROVAL_DECISIONS.reject]
  const base = {
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    contentFormat: "plain-text" as const,
    provider: { kind: "opencode" as const, name: "OpenCode" },
    source: { kind: "tool" as const, id: clip(toolId, 500), label: clip(action, 150) },
    owner,
    providerRequestId: clip(asString(data.id) ?? toolId, 500),
    expiresAt: null,
  }
  let payload: unknown
  if (action === "shell") {
    // Sub-commands joined with a space read as one command that was never asked for (`git status --short
    // head -5`). When the call's own input could not be read, they show one per line under a label.
    const shownSummary = splitNote ? clip(`${resources.length} commands: ${resources.map((r) => redactCredentialSyntax(r)).join(" ; ")}`, 150) : label
    const shownPreview = splitNote ? clip(`OpenCode split this command into ${resources.length} parts; the whole command could not be read:\n${preview}`, 6_000) : preview
    payload = { kind: "command-approval", title: clip(`${who}run a command?`, 150).replace(/^./, (c) => c.toUpperCase()), command: { summary: shownSummary || "command", preview: shownPreview || "command", redacted: true, workingDirectoryLabel: clip(cwd, 1_000) } }
  } else if (action === "edit" || action === "write" || action === "patch") {
    const diff = asString(metadata?.diff) ?? asString(metadata?.patch)
    payload = { kind: "file-approval", title: clip(`${who}edit a file?`, 150).replace(/^./, (c) => c.toUpperCase()), operation: "write", pathLabel: clip(redactCredentialSyntax(resources[0] ?? cwd), 1_000), ...(diff ? { diffPreview: clip(redactCredentialSyntax(diff), 6_000) } : {}) }
  } else {
    const decisions = allowedDecisions.map((d) => (d === APPROVAL_DECISIONS.once ? { ...d, id: "grant-turn" } : d === APPROVAL_DECISIONS.always ? { ...d, id: "grant-session" } : { ...d, id: "deny" }))
    const parsed = InteractionRequest.safeParse({ ...base, allowedDecisions: decisions, payload: { kind: "permission-approval", title: clip(`${who}allow ${action}?`, 150).replace(/^./, (c) => c.toUpperCase()), permission: clip(action, 250), ...(preview ? { preview } : {}), workingDirectoryLabel: clip(cwd, 1_000) } })
    return parsed.success ? parsed.data : null
  }
  const parsed = InteractionRequest.safeParse({ ...base, allowedDecisions, payload })
  return parsed.success ? parsed.data : null
}

/** A shell call's command from its message's tool part. */
export function opencodeCallCommand(message: Json | undefined, callId: string): string | undefined {
  const parts = asArray(message?.content ?? message?.parts)
  for (const raw of parts) {
    const part = asObject(raw)
    if (!part || asString(part.id) !== callId) continue
    const input = asObject(asObject(part.state)?.input) ?? asObject(part.input)
    return asString(input?.command)
  }
  return undefined
}

const QUESTION_DECISIONS = [
  { id: "answer", semantic: "answer" as const, label: "Send answer", description: "Send these answers back to the agent." },
  { id: "decline", semantic: "decline" as const, label: "Decline", description: "Tell the agent nobody answered, so it decides for itself." },
]
const FORM_DECISIONS = [
  { id: "accept", semantic: "accept" as const, label: "Send" },
  { id: "decline", semantic: "decline" as const, label: "Decline" },
]

export function buildOpencodeFormInteraction(
  form: Json,
  owner: { projectId: string; threadSlug: string; sessionId: string; turnId: string; itemId: string; sessionEpoch: number; capabilityRevision: number },
  childLabel: string | undefined,
): { request: InteractionRequestType; fields: Array<{ key: string; multi: boolean }>; declinable: boolean } | null {
  const isQuestion = asObject(form.metadata)?.kind === "question"
  const rawFields = asArray(form.fields).map((f) => asObject(f)).filter((f): f is Json => !!f && !!asString(f.key))
  if (!rawFields.length) return null
  const out: InteractionField[] = []
  const fields: Array<{ key: string; multi: boolean }> = []
  for (const f of rawFields) {
    const key = f.key as string
    const multi = f.type === "multiselect"
    fields.push({ key, multi })
    const options = asArray(f.options).map((o) => asObject(o)).filter((o): o is Json => !!o && !!asString(o.value)).map((o) => {
      const optLabel = asString(o.label) ?? (o.value as string)
      return { value: o.value as string, label: clip(asString(o.description) ? `${optLabel} — ${o.description}` : optLabel, 160) }
    })
    const base = {
      id: key,
      label: clip(asString(f.title) ?? "Question", 160),
      ...(asString(f.description) ? { description: clip(f.description as string, 4_000) } : {}),
      required: false,
      secret: false,
    }
    if (options.length) {
      out.push({ ...base, input: multi ? "multi-select" : "select", options } as InteractionField)
      if (f.custom === true) out.push({ id: `${key}${NOTES_FIELD_SUFFIX}`, label: base.label, input: "multiline", required: false, secret: false, maxLength: 4_000 } as InteractionField)
    } else {
      out.push({ ...base, input: "multiline", maxLength: 4_000 } as InteractionField)
    }
  }
  const title = clip(`${childLabel ? `Sub-agent "${childLabel}": ` : ""}${rawFields.length === 1 ? asString(rawFields[0]!.title) ?? asString(form.title) ?? "OpenCode question" : asString(form.title) ?? "OpenCode questions"}`, 150)
  const formId = asString(form.id) as string
  const parsed = InteractionRequest.safeParse({
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    contentFormat: "plain-text",
    provider: { kind: "opencode", name: "OpenCode" },
    source: { kind: "agent", id: clip(formId, 500), label: "OpenCode" },
    owner,
    providerRequestId: clip(formId, 500),
    allowedDecisions: isQuestion ? QUESTION_DECISIONS : FORM_DECISIONS,
    payload: { kind: isQuestion ? "agent-question" : "mcp-elicitation-form", title, fields: out },
    expiresAt: null,
  })
  return parsed.success ? { request: parsed.data, fields, declinable: isQuestion && rawFields.every((f) => f.custom === true) } : null
}

/** A card's values, as the answer the form expects: a string, or an array for a multi-select, with free
 *  text in place of (or beside) the picked option, because every question field takes `custom`. */
export function opencodeFormAnswer(fields: ReadonlyArray<{ key: string; multi: boolean }>, values: Record<string, unknown> | undefined): Json {
  const answer: Json = {}
  for (const { key, multi } of fields) {
    const raw = values?.[key]
    const notes = values?.[`${key}${NOTES_FIELD_SUFFIX}`]
    const typed = typeof notes === "string" && notes.trim() ? notes.trim() : undefined
    const picked = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : typeof raw === "string" && raw ? [raw] : []
    if (multi) {
      if (picked.length || typed) answer[key] = [...picked, ...(typed ? [typed] : [])]
    } else if (picked.length || typed) {
      answer[key] = [picked[0], typed].filter(Boolean).join(" — ")
    }
  }
  return answer
}

const DECLINED_ANSWER = "The person declined to answer. Decide for yourself."

export function opencodeFormDecline(fields: ReadonlyArray<{ key: string; multi: boolean }>): Json {
  return Object.fromEntries(fields.map(({ key, multi }) => [key, multi ? [DECLINED_ANSWER] : DECLINED_ANSWER]))
}

export { OPENCODE_MIN_VERSION, opencodeVersionAtLeast }
