import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TranscriptMessage } from "@frizz/shared"
import { applyEvent } from "../tailer.ts"
import { parseAcpLine, parseAcpRecord, projectAcpTranscript, type AcpUserRecordProjector } from "./acp-transcript.ts"
import { frizzToolDialect, type OpencodeToolCardBuilder } from "./opencode-transcript.ts"
import type { AgentBackend, BuiltCommand, FoldState, ResumeOpts, SpawnOpts } from "./types.ts"

// An Antigravity thread's transcript: a file FRIZZ writes at `<stateDir>/antigravity/<frizz session
// id>.jsonl`, because `agy acp` streams `session/update` notifications and keeps its history to itself.
// It is the ACP file format (acp-transcript.ts): one `acp-session` header, `acp-note`s, then
// NormalizedEvents, so the fold and the rest of the board need nothing new. Its tool records are written
// in the vocabulary Claude's are (antigravity-types.ts `antigravityToolShape`), and drawn by the same
// card builder, which is how OpenCode's file is read too.

export const ANTIGRAVITY_TRANSCRIPT_DIR = "antigravity"

export function antigravityTranscriptPath(stateDir: string, sessionId: string): string {
  return join(stateDir, ANTIGRAVITY_TRANSCRIPT_DIR, `${sessionId}.jsonl`)
}

export function createAntigravityBackend(opts: { stateDir: string }): AgentBackend {
  return {
    kind: "antigravity",
    buildSpawn(_o: SpawnOpts): BuiltCommand { throw new Error("antigravity runs through its ACP bridge; this argv builder has no live caller") },
    buildResume(_o: ResumeOpts): BuiltCommand { throw new Error("antigravity runs through its ACP bridge; this argv builder has no live caller") },
    transcriptPath(sessionId: string): string | undefined { return antigravityTranscriptPath(opts.stateDir, sessionId) },
    parseLine: parseAcpLine,
    foldLine(state: FoldState, line: string): void {
      const rec = parseAcpRecord(line)
      if (!rec) return
      if (rec.kind === "acp-session") {
        if (rec.model) { state.model = rec.model; state.profileAt = rec.at; state.profileRevision = (state.profileRevision ?? 0) + 1 }
        return
      }
      // The bridge flushes a message's text as it streams, so an `assistant-text` record is a PIECE.
      const messageId = (rec as { messageId?: unknown }).messageId
      for (const ev of parseAcpLine(line)) {
        applyEvent(state, ev.kind === "assistant-text" ? { ...ev, streamed: typeof messageId === "string" ? { messageId } : {} } : ev)
      }
    },
  }
}

export interface AntigravityKnownCalls {
  /** Calls that have their result, oldest first. */
  settled: string[]
  /** Calls with no result yet. `inOpenTurn`: made in the turn the file leaves open. */
  open: Array<{ id: string; name: string; background: boolean; inOpenTurn: boolean }>
}

/** The tool calls a transcript already holds. A bridge reattaching to a running agent starts from
 *  these: a call that spans the restart is settled where it was written, and a closing frame the daemon
 *  replays for a call that has its result is not a new call. */
export function antigravityToolCalls(path: string): AntigravityKnownCalls {
  let text: string
  try { text = readFileSync(path, "utf8") } catch { return { settled: [], open: [] } }
  const settled: string[] = []
  const open = new Map<string, { id: string; name: string; background: boolean; turn: number }>()
  let turn = 0
  let turnOpen = false
  for (const line of text.split("\n")) {
    if (!line.includes('"tool-call"') && !line.includes('"tool-result"') && !line.includes('"turn-start"') && !line.includes('"turn-end"')) continue
    const rec = parseAcpRecord(line)
    if (!rec) continue
    if (rec.kind === "turn-start") { turn++; turnOpen = true }
    else if (rec.kind === "turn-end") turnOpen = false
    else if (rec.kind === "tool-call") open.set(rec.id, { id: rec.id, name: rec.name, background: (rec.input as { run_in_background?: unknown } | null | undefined)?.run_in_background === true, turn })
    else if (rec.kind === "tool-result") { open.delete(rec.id); settled.push(rec.id) }
  }
  return { settled, open: [...open.values()].map(({ turn: madeIn, ...call }) => ({ ...call, inOpenTurn: turnOpen && madeIn === turn })) }
}

export function projectAntigravityTranscript(raw: string, identityPrefix: string, buildCards: OpencodeToolCardBuilder, userProjector?: AcpUserRecordProjector): TranscriptMessage[] {
  return projectAcpTranscript(raw, identityPrefix, userProjector, frizzToolDialect(buildCards))
}

export function readAntigravityTranscriptFile(absPath: string, buildCards: OpencodeToolCardBuilder, nativeId = absPath, userProjector?: AcpUserRecordProjector): TranscriptMessage[] {
  try { return projectAntigravityTranscript(readFileSync(absPath, "utf8"), `antigravity:${nativeId}`, buildCards, userProjector) } catch { return [] }
}
