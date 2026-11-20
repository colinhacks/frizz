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

/** Whether the file's last turn was never closed: a `turn-start` with no `turn-end` after it. What a
 *  bridge reattaching to an agent with no prompt in flight asks, so that turn gets its ending. */
export function antigravityTurnOpen(path: string): boolean {
  let text: string
  try { text = readFileSync(path, "utf8") } catch { return false }
  let open = false
  for (const line of text.split("\n")) {
    if (!line.includes('"turn-start"') && !line.includes('"turn-end"')) continue
    const rec = parseAcpRecord(line)
    if (rec?.kind === "turn-start") open = true
    else if (rec?.kind === "turn-end") open = false
  }
  return open
}

export function projectAntigravityTranscript(raw: string, identityPrefix: string, buildCards: OpencodeToolCardBuilder, userProjector?: AcpUserRecordProjector): TranscriptMessage[] {
  return projectAcpTranscript(raw, identityPrefix, userProjector, frizzToolDialect(buildCards))
}

export function readAntigravityTranscriptFile(absPath: string, buildCards: OpencodeToolCardBuilder, nativeId = absPath, userProjector?: AcpUserRecordProjector): TranscriptMessage[] {
  try { return projectAntigravityTranscript(readFileSync(absPath, "utf8"), `antigravity:${nativeId}`, buildCards, userProjector) } catch { return [] }
}
