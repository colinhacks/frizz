import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { TranscriptMessage, TranscriptToolCall } from "@frizz/shared"
import type { AgentBackend, BuiltCommand, FoldState, NormalizedEvent, ResumeOpts, SpawnOpts } from "./types.ts"
import { applyEvent } from "../tailer.ts"

// The ACP backend's transcript: a JSONL file FRIZZ writes, one per thread, at
// `<stateDir>/acp/<frizzSessionId>.jsonl`.
//
// Claude and Codex tail a transcript the PROVIDER writes (a Claude Code JSONL, a Codex rollout). An ACP
// agent keeps its history wherever it likes and only streams `session/update` notifications at us, so
// the bridge (acp-bridge.ts) turns that stream into this file. Its records ARE `NormalizedEvent`s — the
// backend-neutral vocabulary the tailer already folds — plus one header record. That is the whole point
// of the shape: `createAcpBackend().foldLine` is `applyEvent` over each line, so board telemetry, the
// rest/turn detection, the queue's rest time, the preview and the delivery ledger all work without a
// third fold, and `projectAcpTranscript` below turns the same file into the drawer's messages.
//
// Two extra fields ride on a record and are stripped before `applyEvent`: `messageId` on a streamed
// text block (so several partial flushes of one agent message render as one bubble) and `acp` on a
// tool call (its ACP `kind`, `title` and `locations`, which the drawer shows and the fold ignores).

//
// OpenCode's native backend writes the same kind of file for the same reason (opencode-transcript.ts):
// a record whose kind starts `opencode-` is its transcript-only header, note or sub-agent row, and the
// fold and projection below skip it the way they skip an `acp-` one. The projection takes the one thing
// that differs, how a tool call becomes a card, as `toolCall`.

export const ACP_TRANSCRIPT_DIR = "acp"

export interface AcpSessionHeader {
  kind: "acp-session"
  at: string
  agent: { id: string; name?: string; version?: string }
  acpSessionId: string
  cwd: string
  model?: string
}

export interface AcpNote { kind: "acp-note"; at: string; text: string }

/** The worker contract went out again, prepended to the prompt the next `user-message` records. Written
 *  so the debt survives a restart: a compaction record with none of these after it is a session that
 *  no longer holds its contract (`acpContractOwed`). Neither the fold nor the drawer reads it. */
export interface AcpContractRecord { kind: "acp-contract"; at: string; reason: AcpContractReason }
export type AcpContractReason = "compaction" | "fresh-session"

/** A tool call learned its input after the call was recorded: opencode's `tool_call` carries `{cwd}` and
 *  the command arrives on an `in_progress` update. Only the drawer's projection reads it; the fold has no
 *  use for a tool's input, and a second `tool-call` record would count as a second call. */
export interface AcpToolInputRecord { kind: "acp-tool-input"; at: string; id: string; input: unknown; acp?: { title?: string; locations?: string[] } }

export type AcpRecord =
  | AcpSessionHeader
  | AcpNote
  | AcpContractRecord
  | AcpToolInputRecord
  | (NormalizedEvent & { messageId?: string; acp?: { kind?: string; title?: string; locations?: string[]; input?: unknown } })

const EVENT_KINDS: ReadonlySet<string> = new Set([
  "turn-start", "turn-end", "provider-error", "assistant-text", "user-message", "tool-call", "tool-result",
  "reasoning", "agent-report", "agent-instruction", "title", "compaction", "context-usage",
])

export function acpTranscriptPath(stateDir: string, sessionId: string): string {
  return join(stateDir, ACP_TRANSCRIPT_DIR, `${sessionId}.jsonl`)
}

/** Parse one line into the record it is, or undefined for junk. */
export function parseAcpRecord(line: string): AcpRecord | undefined {
  if (!line.trim()) return undefined
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return undefined }
  if (!raw || typeof raw !== "object" || typeof (raw as { kind?: unknown }).kind !== "string") return undefined
  const kind = (raw as { kind: string }).kind
  if (kind === "acp-session" || kind === "acp-note" || kind === "acp-contract" || kind === "acp-tool-input" || kind.startsWith("opencode-") || EVENT_KINDS.has(kind)) return raw as AcpRecord
  return undefined
}

/** The tailer's view: only the events, with the transcript-only fields stripped. */
export function parseAcpLine(line: string): NormalizedEvent[] {
  const rec = parseAcpRecord(line)
  if (!rec || rec.kind === "acp-session" || rec.kind === "acp-note" || rec.kind === "acp-contract" || rec.kind === "acp-tool-input" || rec.kind.startsWith("opencode-")) return []
  const { messageId: _m, acp: _a, ...ev } = rec as NormalizedEvent & { messageId?: string; acp?: unknown }
  return [ev as NormalizedEvent]
}

/**
 * Whether the session this transcript belongs to has compacted since its worker contract last went out —
 * the dispatch's first prompt, or an `acp-contract` re-send. The bridge keeps that debt in memory while
 * it is attached; this is how a re-open (reattach, `session/load`) learns it, so a compaction that landed
 * just before a Frizz restart is still answered on the next prompt.
 */
export function acpContractOwed(path: string): boolean {
  let text: string
  try { text = readFileSync(path, "utf8") } catch { return false }
  let owed = false
  for (const line of text.split("\n")) {
    // A cheap prefilter: a long thread's transcript is mostly text and tool records.
    if (!line.includes('"compaction"') && !line.includes('"acp-contract"')) continue
    const rec = parseAcpRecord(line)
    if (rec?.kind === "compaction") owed = true
    else if (rec?.kind === "acp-contract") owed = false
  }
  return owed
}

/** Appends records; creates the directory and file on first write so the tailer can find it at once. */
export class AcpTranscriptWriter {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    if (!existsSync(path)) appendFileSync(path, "")
  }
  append(record: AcpRecord): void {
    appendFileSync(this.path, JSON.stringify(record) + "\n")
  }
}

export interface AcpBackendOptions { stateDir: string }

export function createAcpBackend(opts: AcpBackendOptions): AgentBackend {
  return {
    kind: "acp",
    buildSpawn(_o: SpawnOpts): BuiltCommand { throw new Error("acp runs via the ACP bridge; this argv builder has no live caller") },
    buildResume(_o: ResumeOpts): BuiltCommand { throw new Error("acp runs via the ACP bridge; this argv builder has no live caller") },
    // Deterministic: the bridge names the file after the frizz session id, so no discovery step.
    transcriptPath(sessionId: string): string | undefined { return acpTranscriptPath(opts.stateDir, sessionId) },
    parseLine: parseAcpLine,
    foldLine(state: FoldState, line: string): void {
      const rec = parseAcpRecord(line)
      if (!rec) return
      if (rec.kind === "acp-session") {
        if (rec.model) { state.model = rec.model; state.profileAt = rec.at; state.profileRevision = (state.profileRevision ?? 0) + 1 }
        return
      }
      // The bridge flushes a message's text as it streams (acp-bridge.ts flushText), so an
      // `assistant-text` record here is a PIECE; say so, with the message it belongs to, and the fold
      // reads its question fences off the joined message instead of the piece (NormalizedEvent).
      const messageId = (rec as { messageId?: unknown }).messageId
      for (const ev of parseAcpLine(line)) {
        applyEvent(state, ev.kind === "assistant-text" ? { ...ev, streamed: typeof messageId === "string" ? { messageId } : {} } : ev)
      }
    },
  }
}

// ---- drawer projection --------------------------------------------------------------------------

const TOOL_TEXT_MAX = 12_000

function clip(text: string, max: number): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text }

type AcpToolMeta = { kind?: string; title?: string; locations?: string[]; input?: unknown }

/** The command or path a tool call is ABOUT, from its input first and its ACP locations second. */
function toolTarget(rawInput: unknown, acp: AcpToolMeta | undefined): { command?: string; path?: string; input?: Record<string, unknown> } {
  const input = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : undefined
  const command = typeof input?.command === "string" ? input.command : undefined
  const path = typeof input?.filePath === "string" ? input.filePath
    : typeof input?.file_path === "string" ? input.file_path
    : typeof input?.path === "string" ? input.path
    : acp?.locations?.[0]
  return { command, path, input }
}

function toolCallFor(ev: Extract<NormalizedEvent, { kind: "tool-call" }>, acp: AcpToolMeta | undefined): TranscriptToolCall {
  const { command, path, input } = toolTarget(ev.input, acp)
  const detail = command ?? path ?? acp?.title ?? ""
  const call: TranscriptToolCall = { name: ev.name, status: "pending" }
  if (detail) call.detail = clip(detail, 500)
  if (command) call.command = command
  else if (input && Object.keys(input).length) call.input = clip(JSON.stringify(input, null, 2), TOOL_TEXT_MAX)
  return call
}

/** A result that learned the target the call did not know (opencode reports `locations`/`rawInput`
 *  only on the completing update) upgrades the call's detail from the tool's title to its target. */
function upgradeToolTarget(call: TranscriptToolCall, acp: AcpToolMeta | undefined): void {
  if (!acp || call.command || (call.detail && call.detail !== call.name)) return
  const { command, path, input } = toolTarget(acp.input, acp)
  const detail = command ?? path
  if (!detail) return
  call.detail = clip(detail, 500)
  if (command) call.command = command
  else if (input && Object.keys(input).length && !call.input) call.input = clip(JSON.stringify(input, null, 2), TOOL_TEXT_MAX)
}

/** The input a later update carried replaces what the call was first recorded with: what it runs is now
 *  known, so the row names that rather than the path or title it started on. */
function applyToolInput(call: TranscriptToolCall, rawInput: unknown, acp: AcpToolMeta | undefined): void {
  const { command, path, input } = toolTarget(rawInput, acp)
  const detail = command ?? path
  if (detail) call.detail = clip(detail, 500)
  if (command) { call.command = command; delete call.input }
  else if (input && Object.keys(input).length) call.input = clip(JSON.stringify(input, null, 2), TOOL_TEXT_MAX)
}

/**
 * How a `user-message` record becomes the message(s) the chat draws. transcript.ts supplies it, built
 * around the SAME `pushUserRecord` the Claude and Codex projectors use; it cannot be imported from here,
 * because transcript.ts imports this file.
 *
 * It is not optional in practice. The bridge records every follow-up verbatim, and a follow-up is very
 * often FRIZZ speaking: a scheduler wake (a shell finished, a timer, a PR watch, a sign-off nudge) with
 * its `<!-- frizz-wake:… -->` delivery token, a fence correction, or a human's own words with the
 * gap note Frizz appended for the worker. Pushed raw, every one of those rendered as the operator's own
 * bubble, worker-facing instructions and literal token included (the bridge writes `synthetic: false`
 * for all of them — it cannot tell a wake from a human). The factory takes the projection's `out` so
 * its per-fold state (the correction sink, which marks the fence a correction refused) walks the
 * messages this projection already built. Absent, a record is pushed raw, as it was before.
 */
export type AcpUserRecordProjector = (out: TranscriptMessage[]) => (sourceId: string, text: string, at: string | undefined) => void

/** What another writer of this file shape does differently. Absent ⇒ ACP's readings. */
export interface WrittenTranscriptDialect {
  toolCall?: (rec: Extract<NormalizedEvent, { kind: "tool-call" }>) => TranscriptToolCall
  toolResult?: (call: TranscriptToolCall, rec: Extract<NormalizedEvent, { kind: "tool-result" }>) => void
}

/** The drawer's messages from the raw file. `identityPrefix` seeds `sourceId`s the client keys on. */
export function projectAcpTranscript(raw: string, identityPrefix = "acp", userProjector?: AcpUserRecordProjector, dialect?: WrittenTranscriptDialect): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  const pushUser = userProjector?.(out)
  let current: TranscriptMessage | undefined // the open assistant message
  let currentMessageId: string | undefined
  const openTools = new Map<string, TranscriptToolCall>()
  const lines = raw.split("\n")

  const close = () => { current = undefined; currentMessageId = undefined }
  const openAssistant = (i: number, at: string | undefined): TranscriptMessage => {
    if (!current) {
      current = { sourceId: `${identityPrefix}:${i}`, role: "assistant", text: "", tools: [], parts: [], ...(at ? { at } : {}) }
      out.push(current)
    }
    return current
  }
  const appendText = (msg: TranscriptMessage, text: string) => {
    const last = msg.parts[msg.parts.length - 1]
    if (last?.kind === "text") last.text += text
    else msg.parts.push({ kind: "text", text })
    msg.text = msg.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("\n\n")
  }
  const appendTool = (msg: TranscriptMessage, tool: TranscriptToolCall) => {
    const last = msg.parts[msg.parts.length - 1]
    if (last?.kind === "tools") last.tools.push(tool)
    else msg.parts.push({ kind: "tools", tools: [tool] })
    msg.tools.push(tool)
  }

  for (let i = 0; i < lines.length; i++) {
    const rec = parseAcpRecord(lines[i]!)
    if (!rec || rec.kind.startsWith("opencode-")) continue
    switch (rec.kind) {
      case "acp-session":
      case "acp-note":
      case "acp-contract":
      case "title":
      case "context-usage":
      case "compaction":
      case "agent-report":
      case "agent-instruction":
        break
      case "user-message": {
        close()
        const text = rec.text ?? ""
        if (!pushUser) {
          out.push({ sourceId: `${identityPrefix}:${i}`, role: "user", text, tools: [], parts: [], ...(rec.at ? { at: rec.at } : {}), ...(rec.synthetic ? { wake: true } : {}) })
          break
        }
        // The projector may push nothing (a correction, relay plumbing) or several messages (coalesced
        // deliveries), so everything it pushed is what this record became. A record the transcript
        // itself calls synthetic is Frizz's whatever its text says, so each of them is a wake.
        const from = out.length
        pushUser(`${identityPrefix}:${i}`, text, rec.at)
        for (let j = from; j < out.length; j++) {
          const m = out[j]!
          if (rec.synthetic) m.wake = true
          // The shared push always writes the `at` key; every other ACP message omits it when unknown.
          if (m.at === undefined) delete m.at
        }
        break
      }
      case "turn-start":
        break
      case "turn-end":
        close()
        break
      case "reasoning": {
        close()
        out.push({ sourceId: `${identityPrefix}:${i}`, role: "assistant", kind: "reasoning", text: rec.text, tools: [], parts: [], ...(rec.at ? { at: rec.at } : {}) })
        break
      }
      case "assistant-text": {
        // Partial flushes of one agent message share a messageId → one bubble. A different message (or
        // none) after tools still continues the same assistant turn as a new text part.
        const msg = openAssistant(i, rec.at)
        const mid = (rec as { messageId?: string }).messageId
        if (mid && mid === currentMessageId) {
          const last = msg.parts[msg.parts.length - 1]
          if (last?.kind === "text") { last.text += rec.text; msg.text = msg.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("\n\n"); break }
        }
        currentMessageId = mid
        appendText(msg, rec.text)
        break
      }
      case "tool-call": {
        const msg = openAssistant(i, rec.at)
        currentMessageId = undefined
        const call = dialect?.toolCall?.(rec) ?? toolCallFor(rec, (rec as { acp?: AcpToolMeta }).acp)
        openTools.set(rec.id, call)
        appendTool(msg, call)
        break
      }
      case "acp-tool-input": {
        const call = openTools.get(rec.id)
        if (call) applyToolInput(call, rec.input, rec.acp)
        break
      }
      case "tool-result": {
        const call = openTools.get(rec.id)
        if (!call) break
        openTools.delete(rec.id)
        if (dialect?.toolResult) { dialect.toolResult(call, rec); break }
        const failed = (rec as { acp?: { status?: string } }).acp?.status === "failed" || (rec as { acp?: { kind?: string } }).acp?.kind === "failed"
        call.status = failed ? "failed" : "completed"
        upgradeToolTarget(call, (rec as { acp?: AcpToolMeta }).acp)
        if (rec.text) call.output = clip(rec.text, TOOL_TEXT_MAX)
        break
      }
      // Its own message, the shape the Codex projector gives one (transcript.ts). Hung on the open
      // assistant message it replaced that message's text and tools when drawn, and on an empty one it
      // drew nothing at all, so the card vanished as soon as the board's copy of the error cleared and
      // the message that failed read as delivered (2026-11-06).
      case "provider-error": {
        close()
        out.push({ sourceId: `${identityPrefix}:${i}`, role: "assistant", kind: "event", text: rec.error.message, providerError: rec.error, tools: [], parts: [], ...(rec.at ? { at: rec.at } : {}) })
        break
      }
    }
  }
  return out
}

export function readAcpTranscriptFile(absPath: string, nativeId = absPath, userProjector?: AcpUserRecordProjector): TranscriptMessage[] {
  try { return projectAcpTranscript(readFileSync(absPath, "utf8"), `acp:${nativeId}`, userProjector) } catch { return [] }
}
