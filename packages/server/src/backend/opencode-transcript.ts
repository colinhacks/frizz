import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TranscriptMessage, TranscriptToolCall } from "@frizz/shared"
import { applyEvent } from "../tailer.ts"
import { AcpTranscriptWriter, parseAcpLine, parseAcpRecord, projectAcpTranscript, type AcpRecord, type AcpUserRecordProjector, type WrittenTranscriptDialect } from "./acp-transcript.ts"
import type { AgentBackend, BuiltCommand, FoldState, NormalizedEvent, ResumeOpts, SpawnOpts } from "./types.ts"

// A native OpenCode thread's transcript: a file FRIZZ writes at `<stateDir>/opencode/<frizz session id>.jsonl`,
// because the server's event stream has no replay and its message list has no NormalizedEvent shape. It
// is the ACP file format (acp-transcript.ts), one header then NormalizedEvents, so the fold and the rest
// of the board need nothing new. A child session's file is the same format at
// `<stateDir>/opencode/<frizz session id>/<child session id>.jsonl`.

export const OPENCODE_TRANSCRIPT_DIR = "opencode"

export interface OpencodeSessionHeader {
  kind: "opencode-session"
  at: string
  opencodeSessionId: string
  cwd: string
  model?: string
  version?: string
}
export interface OpencodeNote { kind: "opencode-note"; at: string; text: string }
/** The state of one sub-agent row. The newest record per `id` wins, so a replay rebuilds the rows. */
export interface OpencodeSubAgentRecord {
  kind: "opencode-subagent"
  at: string
  /** The `subagent` tool call in the parent: what the card and the row share. */
  id: string
  /** The child session, the id a worker names in `agents:`. */
  childSessionId: string
  label: string
  agent?: string
  state: "running" | "completed" | "failed" | "killed"
  outputFile: string
  startedAt: string
  finishedAt?: string
}

export type OpencodeRecord = AcpRecord | OpencodeSessionHeader | OpencodeNote | OpencodeSubAgentRecord

export function opencodeTranscriptPath(stateDir: string, sessionId: string): string {
  return join(stateDir, OPENCODE_TRANSCRIPT_DIR, `${sessionId}.jsonl`)
}
export function opencodeChildTranscriptPath(stateDir: string, sessionId: string, childSessionId: string): string {
  return join(stateDir, OPENCODE_TRANSCRIPT_DIR, sessionId, `${childSessionId}.jsonl`)
}

/** The writer: the ACP one, typed for this file's extra records. */
export class OpencodeTranscriptWriter {
  private readonly writer: AcpTranscriptWriter
  constructor(readonly path: string) { this.writer = new AcpTranscriptWriter(path) }
  append(record: OpencodeRecord | (NormalizedEvent & Record<string, unknown>)): void { this.writer.append(record as AcpRecord) }
}

/** The sub-agent record a transcript line is, or undefined. The tailer's one question of this file. */
export function parseOpencodeSubAgentLine(line: string): OpencodeSubAgentRecord | undefined {
  if (!line.includes('"opencode-subagent"')) return undefined
  const rec = parseAcpRecord(line) as OpencodeRecord | undefined
  return rec?.kind === "opencode-subagent" ? rec : undefined
}

export function createOpencodeBackend(opts: { stateDir: string }): AgentBackend {
  return {
    kind: "opencode",
    buildSpawn(_o: SpawnOpts): BuiltCommand { throw new Error("opencode runs through its server API; this argv builder has no live caller") },
    buildResume(_o: ResumeOpts): BuiltCommand { throw new Error("opencode runs through its server API; this argv builder has no live caller") },
    transcriptPath(sessionId: string): string | undefined { return opencodeTranscriptPath(opts.stateDir, sessionId) },
    parseLine: parseAcpLine,
    foldLine(state: FoldState, line: string): void {
      const rec = parseAcpRecord(line) as OpencodeRecord | undefined
      if (!rec) return
      if (rec.kind === "opencode-session") {
        if (rec.model) { state.model = rec.model; state.profileAt = rec.at; state.profileRevision = (state.profileRevision ?? 0) + 1 }
        return
      }
      const messageId = (rec as { messageId?: unknown }).messageId
      for (const ev of parseAcpLine(line)) {
        applyEvent(state, ev.kind === "assistant-text" ? { ...ev, streamed: typeof messageId === "string" ? { messageId } : {} } : ev)
      }
    },
  }
}

export type OpencodeToolCardBuilder = (block: { id: string; name: string; input: unknown }) => TranscriptToolCall[]

const TOOL_TEXT_MAX = 12_000
const clip = (text: string): string => (text.length > TOOL_TEXT_MAX ? `${text.slice(0, TOOL_TEXT_MAX - 1)}…` : text)

/** How this file's tool records become cards: through the one block mapper Claude's calls go through
 *  (transcript.ts passes it, since that file imports this one), because the bridge wrote them in that
 *  vocabulary (`frizzToolShape`). */
function dialectFor(buildCards: OpencodeToolCardBuilder): WrittenTranscriptDialect {
  return {
    toolCall: (rec) => {
      const call: TranscriptToolCall = buildCards({ id: rec.id, name: rec.name, input: rec.input })[0] ?? { name: rec.name }
      call.status = "pending"
      return call
    },
    toolResult: (call, rec) => {
      const meta = rec as { failed?: boolean; cancelled?: boolean; answers?: Array<string | null> }
      call.status = meta.cancelled ? "cancelled" : meta.failed ? "failed" : "completed"
      if (call.ask) {
        if (meta.answers) call.askAnswers = meta.answers
        return
      }
      if (rec.text && (!call.edit || call.status !== "completed")) {
        if (call.name === "Read") call.read = clip(rec.text)
        else call.output = clip(rec.text)
      }
    },
  }
}

export function projectOpencodeTranscript(raw: string, identityPrefix: string, buildCards: OpencodeToolCardBuilder, userProjector?: AcpUserRecordProjector): TranscriptMessage[] {
  return projectAcpTranscript(raw, identityPrefix, userProjector, dialectFor(buildCards))
}

export function readOpencodeTranscriptFile(absPath: string, buildCards: OpencodeToolCardBuilder, nativeId = absPath, userProjector?: AcpUserRecordProjector): TranscriptMessage[] {
  try { return projectOpencodeTranscript(readFileSync(absPath, "utf8"), `opencode:${nativeId}`, buildCards, userProjector) } catch { return [] }
}
