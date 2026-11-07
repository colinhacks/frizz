// The in-process integration harness: a REAL frizz server graph — storage, tailer, board, runtime
// ingest — booted against a temp project, driven by a scripted provider, with no LLM, no daemon and
// no browser.
//
// This is plans/t3code-adoption-spike.md item 4, and it exists because of the cost asymmetry the
// briefing names: frizz's only gate for orchestration logic today is "launch a promoted artifact,
// drive real Chrome, screenshot". That is exactly right for UI and ruinously expensive for the
// question "when the SDK says the turn is over before the transcript says so, does the board queue
// the thread with the right final message?" — which is a pure orchestration question, and which is
// where this spike's risk actually lives.
//
// Determinism comes from the two primitives in @frizz/shared rather than from sleeping:
//   * `ingest.drain()` — every event handed in has been folded and its nudge issued.
//   * `receipts.waitFor(…, { since })` — the exact milestone, matched even if it landed before the
//     await. Capture `receipts.cursor()` BEFORE playing a script.
// No assertion in a test built on this may wait on wall-clock time.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReceiptBus, type ReceiptBus } from "@frizz/shared"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import { createStorage, type SessionRow, type Storage } from "../storage.ts"
import { createBoard, type BoardManager } from "../board.ts"
import type { ThreadView } from "@frizz/shared"
import { createTailer, type SessionTelemetry, type Tailer } from "../tailer.ts"
import { createClaudeBackend } from "../backend/claude.ts"
import { createCodexBackend } from "../backend/codex.ts"
import { createAcpBackend } from "../backend/acp-transcript.ts"
import { createOpencodeBackend } from "../backend/opencode-transcript.ts"
import type { AgentBackend } from "../backend/types.ts"
import {
  createClaudeRuntimeIngest,
  type ClaudeRuntimeIngest,
  type ClaudeRuntimeReceipt,
} from "../backend/claude-runtime-ingest.ts"
import { createScriptedClaudeSession, type ScriptedClaudeSession } from "./scripted-claude.ts"

export interface IntegrationHarness {
  project: Project
  storage: Storage
  bus: Bus
  tailer: Tailer
  board: BoardManager
  ingest: ClaudeRuntimeIngest
  receipts: ReceiptBus<ClaudeRuntimeReceipt>
  /** Advance the injected clock the tailer and board both read. */
  advance(ms: number): void
  clockMs(): number
  /**
   * Register a broker-backed Claude thread exactly as dispatch.ts does (backend=claude,
   * claude_runtime=broker ⇒ isBrokerClaudeRow / isHeadlessRow both true), and return a scripted
   * session bound to its transcript path and the ingest.
   */
  dispatch(slug: string, sessionId?: string): ScriptedClaudeSession & { slug: string; sessionId: string }
  /** Run the tailer's real tick and return this thread's derived telemetry. */
  telemetry(slug: string): SessionTelemetry | undefined
  /** The thread AS THE DASHBOARD SEES IT — through the real board assembly, not the tailer directly. */
  boardThread(slug: string): ThreadView | undefined
  /** Wait for the nudge-driven tick to have run, then read telemetry. Never sleeps a fixed time. */
  settle(): Promise<void>
  /** How many times the tailer asked the board to refresh — the "did the board move" signal. */
  boardRefreshes(): number
  close(): void
}

export function createIntegrationHarness(): IntegrationHarness {
  const dir = mkdtempSync(join(tmpdir(), "frizz-integration-"))
  const logDir = join(dir, "claude-logs")
  mkdirSync(logDir, { recursive: true })
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  const storage = createStorage(join(dir, "ui.db"), "integration")
  const bus = new Bus()
  const project: Project = { dir, id: "integration", name: "integration", label: "o/integration", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const receipts = createReceiptBus<ClaudeRuntimeReceipt>()
  const clock = { ms: Date.parse("2026-07-01T00:00:00.000Z") }
  let refreshes = 0

  // The real backends, so the fold under test is the corpus-verified one — not a stand-in.
  const claudeBackend = createClaudeBackend({ logDir })
  const codexBackend = createCodexBackend({})
  const acpBackend = createAcpBackend({ stateDir: dir })
  const opencodeBackend = createOpencodeBackend({ stateDir: dir })
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : kind === "acp" ? acpBackend : kind === "opencode" ? opencodeBackend : claudeBackend)

  // Late-bound exactly as context.ts binds it: the ingest is constructed before the tailer because in
  // production the broker bridge (which takes the ingest's handler) is constructed first.
  let tailer!: Tailer
  const ingest = createClaudeRuntimeIngest({ nudge: () => tailer.nudge?.(), receipts })

  tailer = createTailer({
    project,
    storage,
    bus,
    backendFor,
    sessionLogDir: logDir,
    now: () => clock.ms,
    // Every row this harness dispatches is headless, so paneDeadForRow answers from `exited` / the
    // broker daemon probe and never reaches this seam. Pinned anyway so a row that somehow arrives
    // non-headless reads as LIVE rather than taking the production default's "dead".
    paneDead: () => false,
    onChange: () => { refreshes++; board.refresh() },
    runtimeLiveness: (sessionId) => ingest.liveness(sessionId),
    runtimeTasks: (sessionId) => ingest.tasks(sessionId),
  })

  const board = createBoard(project, storage, bus, tailer, "integration-boot", {
    now: () => clock.ms,
    subscribe: (async () => ({ unsubscribe: async () => {} })) as never, // no filesystem watcher
  })

  return {
    project,
    storage,
    bus,
    get tailer() { return tailer },
    board,
    ingest,
    receipts,
    advance(ms) { clock.ms += ms },
    clockMs: () => clock.ms,

    dispatch(slug, sessionId = `sid-${slug}`) {
      const row: SessionRow = {
        slug,
        session_id: sessionId,
        thread_name: `frizz-${slug}`,
        spawned_at: new Date(clock.ms).toISOString(),
        last_read_at: null,
        unread: 0,
        exited: 0,
        archived: 0,
        rested_at: null,
        title_auto: 1,
        title: slug,
        state: "open",
        meta: null,
        seen_at: null,
        transcript_id: null,
      }
      storage.upsertSession(row)
      storage.setBackend(slug, "claude")
      storage.setClaudeRuntime(slug, "broker")
      const session = createScriptedClaudeSession({
        transcriptPath: join(logDir, `${sessionId}.jsonl`),
        onEvent: (e) => ingest.onEvent(slug, sessionId, e),
      })
      return Object.assign(session, { slug, sessionId })
    },

    telemetry(slug) {
      tailer.tick()
      return tailer.get(slug)
    },

    boardThread(slug) {
      tailer.tick()
      return board.refresh().threads?.find((t) => t.id === slug)
    },

    async settle() {
      // Every enqueued event folded (and therefore every nudge requested)…
      await ingest.drain()
      // …then run the tick synchronously rather than waiting out the nudge's own timer. The nudge is
      // deliberately throttled to the poll's duty-cycle floor, and a test asserting DERIVATION must
      // not also be asserting that throttle — ../tailer.nudge.test.ts covers that separately.
      tailer.tick()
    },

    boardRefreshes: () => refreshes,

    close() {
      tailer.stop()
      ingest.close()
      receipts.close()
      storage.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
