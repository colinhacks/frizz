import { statSync, openSync, readSync, closeSync, readdirSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { basename, join } from "node:path"
import { homedir, tmpdir } from "node:os"
import type { AskQuestion, AwaitingHint } from "@frizz/shared"
import { insideFence, isAllInjectedNoise, isInterruptMarker, parseAskUserQuestionInput, PermissionMode, saysAllDone, splitAwaitingFrontmatter } from "@frizz/shared"
import type { Bus } from "./bus.ts"
import { permMarkerPath, type Project } from "./project.ts"
import { isBrokerClaudeRow, isHeadlessRow } from "./storage.ts"
import type { Storage, SessionRow } from "./storage.ts"
import { discoverTranscriptDir, discoverTranscriptId, mtimeOfNonEmpty, DISCOVERY_GRACE_MS } from "./discover.ts"
import type { AgentBackend, FoldState, NormalizedEvent, NormalizedTail } from "./backend/types.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"
import { normalizeObservedThreadModel, validateThreadProfile } from "./backend/thread-profiles.ts"
import { dispatchProfileCell } from "./subagent-profile.ts"
import { resolveRuntimeTurn, type ClaudeRuntimeTask } from "./backend/claude-runtime-ingest.ts"
import { classifyLimitRecord } from "./backend/usage-limit.ts"
import { claudeBrokerDiagnosticLogPath } from "./backend/claude-broker-diagnostics.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./backend/claude-broker-host.ts"
import { parseDeliveryLedger, correlateDeliveryRecord, ageDeliveries, serializeDeliveryLedger, type DeliveryLedgerItem } from "./delivery-ledger.ts"
import { createCodexSubAgentTracker, type CodexSubAgentTracker } from "./codex-subagents.ts"
import { defaultCodexHome, readCodexThreadNames, scanForeignRollouts } from "./backend/codex.ts"
import {
  isModelFacingCarrier, reportKind, blockTaskIds, parseReportBlock, relayedTaskIds,
  MAX_TRACKED_REPORTS, type QueuedReport,
} from "./completion-relay.ts"
import {
  createTailStateCache,
  decodeTailState,
  encodeTailState,
  fenceMatches,
  measureFence,
  type TailCacheEntry,
  type TailStateCache,
} from "./tail-cache.ts"
import { log as frizzLog } from "./logging.ts"
import { frizzTempDir } from "./frizz-paths.ts"

// The JSONL tailer: incrementally reads each registered session's Claude Code transcript
// (~/.claude/projects/<cwdSlug>/<session_id>.jsonl) to derive liveness telemetry — last activity
// time, a preview of the last assistant text, and whether the current TURN is in flight or idle.
// Per the architecture invariant, this file is TELEMETRY ONLY: it never gates correctness, parses
// defensively (bad line skipped, unknown type ignored, never throws), and degrades to "unknown"
// on any schema surprise rather than crashing.
//
// ---- TURN-STATE HEURISTIC (chosen empirically) ----
// Investigated the 15 real transcripts in ~/.claude/projects/-Users-colinmcd94-Documents-projects-frizz/.
// Record `type`s observed: assistant, user, attachment, queue-operation, last-prompt, ai-title,
// permission-mode, mode, bridge-session, file-history-snapshot, system. Only `assistant`, `user`,
// and `system` carry a `timestamp`; the rest are sidecar metadata (no timestamp).
//
// The DEFINITIVE turn-end signal is `assistant.message.stop_reason`. Across every transcript, an
// assistant message is split into one JSONL record per content block, and ALL records of a given
// message share the same stop_reason:
//   - "tool_use"  → the model is calling tools; the turn CONTINUES (a tool_result user record and
//                   further assistant records will follow).
//   - "end_turn"  → the model has finished; control returns to the prompt (the agent is IDLE).
// Empirically EVERY completed transcript's last substantive record is an assistant `end_turn`
// (optionally trailed by sidecar `system`/`last-prompt`/`ai-title` records). Counts across the
// corpus: 363 tool_use+tool_use, 209 tool_use+thinking, 117 tool_use+text, 41 end_turn.
//
// Derivation over the "last substantive record" (assistant or user; sidecar types ignored):
//   - assistant, stop_reason "end_turn"  → idle (definitive)
//   - assistant, stop_reason "tool_use"  → in-flight (tool exchange ongoing; DO NOT time out —
//                                          Opus tool latency routinely exceeds 5s)
//   - assistant, stop_reason missing/other → BACKSTOP: idle iff no append for >5s, else in-flight
//   - user (a fresh prompt or a tool_result) → in-flight (the model is about to respond)
//   - no substantive records yet             → in-flight (spawning; the worker is live)
// The 5s backstop only fires for an UNKNOWN stop_reason, so it can never override a clear tool_use.

const IDLE_BACKSTOP_MS = 5000
// How many extra nudge-driven ticks a session may spend waiting for the provider's disk write to
// catch up with its event stream before handing back to the ordinary poll. See chaseRuntime.
const RUNTIME_CHASE_MAX = 20
const POLL_MS = 1000
// How many sessions may run the FULL-TRANSCRIPT prime fold in one tick.
//
// The prime is the expensive half of the tailer by an order of magnitude — measured on real boards:
// a first tick costs 1.5-7.5s while a warm one costs 4-18ms, and start() used to run that prime
// synchronously. One project could stall the loop for seconds at boot; a singleton activating several
// would stall it for the SUM. Bounding the number of newly-primed rows per tick turns that into a few
// short ticks instead, and costs nothing steady-state because an already-primed row is cheap.
//
// A row that does not get primed this tick is simply not in `states` yet, which is the same condition
// as a row dispatched a second from now — the tick already handles that on every poll. That was the
// INTENT from the day this constant landed, and it only became literally true on 2026-09-04: until then
// the loop built the state — and paid everything a state costs — for every row it then declined to
// fold, so the bound covered the fold and nothing around it. See the gate in tick().
const MAX_PRIME_ROWS_PER_TICK = 25
// …and a wall-clock ceiling on the same pass, because per-row prime cost varies by orders of
// magnitude: one enormous transcript costs more than fifty ordinary ones. A row count alone left a
// measured 3853ms tick on a 249-row board. Checked BEFORE each row rather than during, so a single
// pathological transcript can still overrun it — that row is a pre-existing pathology, not something
// the bound introduces — but it can no longer be followed by 24 more like it in the same tick.
const PRIME_BUDGET_MS = 200
/**
 * Bytes converted to a string at once while reading a transcript.
 *
 * Anything comfortably under Node's ~512 MB string cap works; 16 MB keeps the transient allocation
 * small on a cold prime of a huge file while still being one single read for the ordinary delta.
 */
const TRANSCRIPT_READ_WINDOW = 16 * 1024 * 1024
/** Shared empty carry — allocating one per window read is pure garbage. */
const EMPTY_BUFFER = Buffer.alloc(0)
// Ceiling on the adaptive poll (see scheduleTick). A tick this expensive means something is badly
// wrong, but the tailer is still the only source of turn/liveness telemetry — it must keep running.
const MAX_POLL_MS = 10_000
// A tracked background sub-agent whose transcript file has gone this long without an append is
// treated as "stale" — a liveness fallback for a completion record we somehow missed (the child
// died, or the worker session ended before the <task-notification> landed).
//
// The window MUST exceed the longest a LIVE child can legitimately stay silent, and that has a hard
// ceiling: a child writes its tool_use record, then blocks, and Claude's foreground Bash timeout is
// capped at 600000 ms — so one tool call buys at most ~10 minutes of silence. The old 5-minute window
// sat UNDER that ceiling and therefore declared healthy children dead: a child dispatched to own a CI
// wait (the contract's prescribed way to wait) flipped to "stale" at 312s while blocked in its
// watcher, dropping hasLiveBackgroundWork and queueing its parent mid-wait — measured on the live
// board 2026-07-22. 15 minutes clears the ceiling with headroom and still clears a genuinely dead
// child promptly; across 1366 real child transcripts (176k inter-record gaps) only 0.04% exceed it,
// while the p99 gap is 95s.
//
// AGENTS ONLY: a child appends on every step, so silence there is a real (if coarse) liveness signal.
// A background SHELL has no such property and is not judged this way at all — see bgShellViews.
const SUBAGENT_STALE_MS = 15 * 60_000

// IS A BACKGROUND SHELL STILL ALIVE? Asked of the OPERATING SYSTEM, not guessed from age or output.
//
// Frizz spawns none of these processes — Claude/Codex does — and the runtime records no pid anywhere
// frizz can read (measured 2026-08-19: the task dir holds `<taskId>.output` and nothing else). So until
// now the ONLY thing that retired a shell was its `<task-notification>`, and one whose process died
// without emitting one stayed "running" forever: the maintainer's board showed `RUNNING · 2583 MIN` —
// 43 hours — for a process that did not exist.
//
// The correlation key frizz already holds is the OUTPUT PATH. A background shell's stdout and stderr are
// redirected into `<taskId>.output`, so whichever process holds that file open IS the shell. Verified
// against a known-alive control (two holders, fds 1w and 2w, pid visible) and a known-dead one (zero).
// That makes this an exact question with an exact answer, which is what an age threshold could never be —
// and it matters here specifically because frizz's own contract tells workers to wait with
// `until <cond>; do sleep 5; done`, a healthy shell that prints nothing for hours by design.
//
// UNDEFINED means "cannot tell" and is never treated as dead: no probe, no path, or a platform without
// `lsof` all leave the shell exactly as it was.
const SHELL_PROBE_TTL_MS = 30_000
const SHELL_PROBE_GRACE_MS = 60_000 // a just-launched shell is alive by construction; do not pay for it

const execFileAsync = promisify(execFile)

// ASKED OFF THE EVENT LOOP, AND ASKED ONCE FOR EVERY SHELL AT ONCE. `lsof <path>` has to walk every
// process's open-file table on the machine to answer, so it costs the same whether you ask about one
// path or twenty — measured on this machine 2026-09-04: 292-395 ms for a single path, 1102 ms for three
// separate calls, 268 ms for the same three batched into one. It used to run as execFileSync inside the
// 1 s tick, which made that cost a HARD BLOCK on the whole server: a census put it at 24.9 spawns/min,
// and one call in a CPU sample reached 1.88 s. Every RPC the browser had in flight waited behind it.
//
// So the probe is now async and batched, and `shellIsGone` reads only the cache it fills. The verdict
// therefore lands on the NEXT tick rather than this one — at most a second later, and the surrounding
// contract was already built for exactly that: an unknown answer leaves the shell running, so a
// not-yet-probed shell is treated the same as an unprobeable one.
async function probeShellsAlive(outputFiles: readonly string[]): Promise<Map<string, boolean | undefined>> {
  const verdicts = new Map<string, boolean | undefined>()
  // NO FILE, NO VERDICT. `lsof` exits 1 both for "nobody holds this" and for "this path does not exist",
  // so without this check a shell whose output file has not been created yet — or was rotated or cleaned
  // away underneath it — reads as DEAD while it is running. Absence of evidence, not evidence of death.
  const live: Array<{ requested: string; real: string }> = []
  for (const file of outputFiles) {
    if (!existsSync(file)) {
      verdicts.set(file, undefined)
      continue
    }
    // lsof reports the REAL path, so `/tmp/x` comes back as `/private/tmp/x` on macOS and a naive
    // string compare then reads every held shell as dead. Match on what lsof will actually print.
    try {
      live.push({ requested: file, real: realpathSync(file) })
    } catch {
      verdicts.set(file, undefined)
    }
  }
  if (live.length === 0) return verdicts
  let stdout = ""
  try {
    // `-F pn` is lsof's machine-readable form: one `p<pid>` line per holder, then an `n<path>` line per
    // fd it holds. A path that appears is held by somebody; a path absent from the output is held by
    // nobody. That per-path attribution is why this is `-F pn` and not `-t`, which prints bare pids and
    // could not say WHICH of a batch of paths they belong to.
    stdout = (await execFileAsync("lsof", ["-F", "pn", "--", ...live.map((f) => f.real)], { encoding: "utf8", timeout: 8000 })).stdout
  } catch (err) {
    // `code` is the EXIT STATUS when lsof actually ran, and a string errno when it could not be
    // spawned. Telling those apart is the whole correctness of this catch, and getting it wrong is
    // silent: an empty stdout means "nobody holds any of these" when lsof ran, and "no idea" when it
    // did not — read as the latter, every dead shell stays "running" forever.
    const e = err as NodeJS.ErrnoException & { stdout?: string; code?: string | number; killed?: boolean }
    const ran = typeof e.code === "number" && !e.killed
    if (!ran) {
      // No lsof on this platform, or it was killed on the timeout — undefined, not dead, for the batch.
      for (const f of live) verdicts.set(f.requested, undefined)
      return verdicts
    }
    // A BATCH EXITS NON-ZERO AS SOON AS *ANY* PATH IS UNHELD, which is the commonest outcome there is
    // and not an error at all. The answer is in stdout, and an EMPTY stdout is itself the answer when
    // lsof ran: nobody holds any of them.
    stdout = e.stdout ?? ""
  }
  const held = new Set<string>()
  for (const line of stdout.split("\n")) if (line.startsWith("n")) held.add(line.slice(1))
  for (const f of live) verdicts.set(f.requested, held.has(f.real))
  return verdicts
}
// The minute bucket of an ISO instant, for the board signature: a child's "N min ago" reading only
// changes when this changes, so folding this (not the raw mtime) into the sig means a steadily-active
// child re-pushes at most once a minute. "" when absent/unparseable — an absent reading is stable.
function activityMinute(at: string | undefined): string {
  if (!at) return ""
  const ms = Date.parse(at)
  return Number.isFinite(ms) ? String(Math.floor(ms / 60_000)) : ""
}
// Whole-directory FOREIGN-session discovery: a *.jsonl in the log dir with no registry row is a
// maintainer terminal, surfaced as a read-only thread. Only files touched within this window are
// "live" foreign threads (the dir accumulates every session ever); a file that ages past it drops
// out of foreignIds() but keeps its cached tail. Exported so other verticals share the freshness rule.
export const FOREIGN_FRESH_MS = 24 * 60 * 60_000
// Cap on concurrently-surfaced foreign threads (most-recent by mtime) — defensive against a log dir
// holding thousands of historical sessions.
const FOREIGN_MAX = 20
// Foreign discovery is a readdir + per-file stat; too costly per 1s tick, so scan at most every 5th
// tick (~5s) plus the very first tick. Between scans the last fresh set is reused verbatim.
const FOREIGN_SCAN_EVERY = 5
// How often the durable prime cache (tail-cache.ts) is written back for threads whose transcript grew.
// The cache exists to make the NEXT boot cheap, so it only has to be roughly current: this bounds how
// many appended bytes a boot can have to re-fold to at most one interval's worth per thread, while
// keeping the steady-state cost to one small batched transaction per interval instead of one per tick.
const CACHE_FLUSH_MS = 30_000
// How often the FIRST pass reports its position (see Tailer.start). Frequent enough that a launcher
// watching for progress never mistakes a working boot for a wedged one, coarse enough to cost nothing.
const PRIME_PROGRESS_EVERY = 20
// While a thread's transcript is still unresolved (missing past the grace window), re-run discovery at
// most this often — the file may yet appear (a very late boot) or a drifted transcript may materialize.
const DISCOVER_RETRY_MS = 15_000
// …but BACK OFF once a row has missed repeatedly, doubling to this ceiling. A miss costs a full sweep
// of every sibling bucket under ~/.claude/projects plus a head-scan of this project's log dir, and it
// runs SYNCHRONOUSLY on the event loop. That is the right price for a thread that might still be
// booting; it is pure waste for one that never will, and the never-will rows accumulate forever.
// Measured on the maintainer's board 2026-08-16 (464 rows; 39 of them will never bind again — every
// one `exited` AND archived, aged 12–46 days — of which the claude rows reach this path at all, since
// a codex row skips resolveTranscript entirely): a simulated hour of ticks spent 2090ms of blocked
// event loop re-asking a question whose answer had not changed in six weeks, against ~900ms with the
// backoff. Small per tick, but it is pure waste and it grows with every thread ever dispatched.
// The retry never stops, it just becomes rare: a transcript that appears on day 40 is still picked up
// within the ceiling, and any bind resets the row to the base interval. Note this throttles the
// SWEEPS only — a row whose own pinned `<session_id>.jsonl` gets bytes binds on the next tick
// regardless of how deep its miss streak is, which is what makes backing off safe for a live boot.
const DISCOVER_RETRY_MAX_MS = 15 * 60_000
// Per-session sink for a boot-failure stall, so its root cause survives past the worker being gone —
// historically claude's own error text, frozen on the dead worker's last screen, which is where the
// name comes from; today the pointer to whatever evidence that row's runtime does keep (see
// captureStall). Best-effort; inert litter.
// NOTE: per-PROJECT, resolved inside createTailer — the filename is a bare thread slug, so two
// projects with a thread called `fix-auth` overwrite each other's captured agent output. See
// stallLogDir below.

export type TurnState = "in-flight" | "idle"

// A live background sub-agent as surfaced to the board (mirrors @frizz/shared SubAgentView; kept
// as a local shape so the tailer's telemetry stays decoupled from the wire schema).
export interface SubAgentView {
  label: string
  startedAt: string // ISO8601 of the dispatch record
  // "rested" = a DIRECT child whose run ended (the harness reported completed/failed) while the fan-out
  // it dispatched is still running. See anchorRoots below for why `completed` is not "finished".
  state: "running" | "stale" | "rested"
  subagentType?: string // the dispatch's input.subagent_type verbatim (e.g. "frizz:frizz-opus-high"); absent when unset
  id: string // the dispatch tool_use id — the drill-in drawer's stable handle to this exact child
  // The RUNTIME agent id (Claude's `agentId: a01b2d20b32feab11` in the Agent launch ack) — the handle the
  // MODEL was shown, so the one a worker naturally writes in an `agents:` line or a `watch`. Absent until
  // the launch ack (or the SDK's `task_started`) pairs it with the dispatch. Same contract as
  // BgShellView.taskId, and the same bug when it was missing: a worker that named the id it was handed
  // was told "NOT RUNNING (nothing by that name)" (thread review-and-babysit-zod-pr-6471, 2026-08-28).
  taskId?: string
  lastActivityAt?: string // ISO8601 of the child transcript's last append (its output-file mtime)
  // ---- provider-reported progress (broker Claude rows only; see applyRuntimeTasks) ----
  // "there's not really any indication of what they're up to aside from starts and stops" — this is
  // that indication. Every field is ABSENT unless the SDK reported it for this exact child, so a row
  // with no provider event stream (prose-only) and an older claude that emits no task_* events render
  // exactly as before.
  activity?: string // the tool the child is running RIGHT NOW (SDK last_tool_name)
  activityDetail?: string // what that step IS, in words (e.g. "Running Print current date and time")
  summary?: string // the provider's rolling one-line summary of the child's work
  toolUses?: number // tool calls the child has made so far
  tokens?: number // total tokens the child has spent so far
  durationMs?: number // the provider's own measure of working time (excludes paused)
  // ---- NESTING (see the DESCENDANTS note below) ----
  // 1 (or absent, which every reader treats as 1) = a child THIS session dispatched. 2 = a grandchild,
  // 3 = a great-grandchild, … Emitted only from 2 down, so a direct child's view stays byte-identical
  // to what it was before nesting existed.
  depth?: number
  parentId?: string // the dispatch id of the sub-agent that dispatched this one; absent at depth 1
}

// A signal fence parsed from the FINAL assistant message (mirrors @frizz/shared ThreadFence; kept
// as a local shape so the tailer's telemetry stays decoupled from the wire schema). The fence
// language IS the state, the body is the message; `hints` are `<kind>: <value>` lines parsed from an
// awaiting body. Only meaningful while it is the final message — any newer user record clears it.
export interface FenceView {
  kind: "done" | "awaiting"
  body: string
  hints: AwaitingHint[]
  // Set by the board alone, on the fence it synthesizes from a REGISTERED done (board.registeredDoneFence);
  // the tailer never sets it, because everything it parses came from a message.
  registered?: true
}

// Per-session derived telemetry surfaced to the board overlay. Structurally a NormalizedTail (the
// backend-neutral fold-output contract) PLUS `permPrompt` — which is read live off the worker's
// permission marker, not folded from the transcript. `extends` makes tsc enforce that this stays a
// superset of the shared contract.
export interface SessionTelemetry extends NormalizedTail {
  turn: TurnState
  permPrompt: boolean // paused on an interactive permission prompt (from the marker; no jsonl signal)
  // The last allow/deny frizz's permission POLICY made for this thread, and how many denials it has
  // made this session. Purely informational — a policy decision never blocks anyone, which is exactly
  // why it needs surfacing: it is otherwise invisible.
  permPolicy?: PermPolicyView
  permDenies?: number
  // Monotonic within this tail state. The permission controller uses it to distinguish an
  // authoritative profile emitted by the freshly attached backend from the pre-reattach fold.
  permissionModeRevision?: number
  lastActivityAt?: string // ISO8601 of the last timestamped record (ANY record, incl. sub-agent/system)
  lastAssistantAt?: string // ISO8601 of the agent's OWN last output — rest time (excludes sub-agent/system bumps)
  lastAssistant?: string // trimmed preview (~200 chars) of the last assistant text block
  aiTitle?: string // Claude's own auto-generated session title (latest ai-title sidecar record)
  // Claude's native `/rename` is distinguished from ordinary ai-title churn so the control plane can
  // prove that a title record was emitted AFTER its exact command submission.
  customTitle?: string
  customTitleRevision?: number
  subAgents: SubAgentView[] // live background sub-agents this session dispatched (empty when none)
  // Completion reports the runtime accepted into its queue and never put into the model's context.
  // A non-empty list means this agent is missing findings it believes it has. See report-delivery.ts.
  // Optional (absent ⇒ none) to match its neighbours here and to keep every existing telemetry
  // fixture valid — this is an additive observation, not a new required fact about a session.
  droppedReports?: QueuedReport[]
  bgShells: BgShellView[] // live background shells this session launched (empty when none)
  // Background shells that have FINISHED, newest-wins ring (RETAINED_SHELLS_MAX). Server-internal —
  // deliberately not on the board's wire, because no surface draws a finished shell; the scheduler's
  // watcher pass is the only consumer. See retiredShellViews for what it is for.
  retiredShells?: RetiredShellView[]
  pendingAsk?: PendingAskData // a pending native AskUserQuestion the session is frozen on (else absent)
  pendingQuestion: boolean // at rest with an unanswered ```question block as the last assistant message
  lastUserAt?: string // ISO8601 of the newest USER-role record (answer/steer/dispatch) — the listing sort key
  lastFence?: FenceView // done/awaiting excusal fence on the latest assistant message (else absent)
  // The pinned transcript never materialized and discovery found no drifted one either (worker likely
  // failed to boot). Drives the board's degraded/stalled runtime instead of an eternal "Spinning up…".
  noTranscript?: boolean
  contextTokens?: number // tokens the model's last request carried (see FoldState.contextTokens)
  contextWindow?: number // the context size this session RUNS IN (see FoldState.contextWindow)
}

// One tracked live background sub-agent, keyed in TailState by its dispatch tool_use id (the
// correlation key present BOTH on the Agent tool_use block AND in the completion <task-notification>'s
// <tool-use-id>). Registered on the background dispatch, enriched with `outputFile` from the launch
// tool_result, and removed on a terminal completion notification.
interface SubAgentEntry {
  kind: "agent" | "shell" // an Agent sub-agent vs a background Bash/Monitor shell
  toolUseId: string
  label: string // the dispatch's input.description (shell: falls back to the command's first-line summary)
  startedAt: string // ISO8601 — the dispatch record's timestamp
  command?: string // shell only: raw launch command for the read-only output drawer
  subagentType?: string // the dispatch's input.subagent_type verbatim (agents only; may be absent)
  outputFile?: string // the child/shell's output path (from the launch tool_result); its mtime = liveness
  // Transcript SCHEMA of `outputFile` when it isn't Claude's own JSONL. A codex sub-agent's output file
  // is the CHILD's codex rollout, which the drill-in drawer must parse with the codex reader instead.
  outputFormat?: "codex"
  // The RUNTIME task id (Bash "…with ID: <id>", Monitor "(task <id>…)", Agent "agentId: <id>"), parsed
  // from the launch ack. This is the ONE identifier a `TaskStop` references (its `input.task_id`) and
  // it also rides every natural completion notification as `<task-id>` — so it is the correlation key
  // for a MANUAL stop, which carries no tool_use id at all. Absent until the launch ack is seen.
  //
  // On a BROKER row it is also backfilled from the SDK's own `task_started`, which pairs task id and
  // tool_use id directly — so a structured session gets this correlation key without depending on the
  // ack prose parsing above landing.
  taskId?: string
  // What the provider says this child is doing, folded from the SDK `task_*` stream (broker rows only).
  // Purely additive telemetry: absent for every codex row and every row with no provider event stream.
  progress?: SubAgentProgress
}

// Provider-reported progress for one live op — the payload the protocol used to discard. Stored on the
// entry (rather than re-read per view) so it survives in the prime cache alongside the rest of the map.
interface SubAgentProgress {
  activity?: string // SDK last_tool_name — the tool the child is running right now
  activityDetail?: string // SDK task_progress.description — the current step, in words
  summary?: string // the provider's rolling summary of the child's work
  toolUses?: number
  totalTokens?: number
  durationMs?: number
}

// A live background shell as surfaced to the board (mirrors @frizz/shared BgShellView).
export interface BgShellView {
  label: string
  startedAt: string
  state: "running" | "stale"
  id?: string
  /**
   * The tailer's HALF of "can frizz end this shell": we hold a provider task handle for it. The board
   * ANDs it with the thread's transport before an × is offered — see the full contract on the shared
   * schema, which has carried this field since the stop landed. This twin did not, so the tree did
   * not typecheck (`tailer.test.ts` reads it) and no artifact could be built.
   */
  stoppable?: boolean
  lastActivityAt?: string // ISO8601 of the shell output file's last write
  /** The runtime's own background-task handle — the id the MODEL was given, and therefore the one a
   *  `shell` watcher is registered against. Full contract on the shared schema. */
  taskId?: string
}

/** A background shell that has FINISHED, in the shape the scheduler's watcher pass matches against.
 *  Carries the three handles a watcher target can name and nothing else — this never reaches a client. */
export interface RetiredShellView {
  id: string // the launch tool_use id
  taskId?: string // the runtime handle the worker was given
  label: string
  status: "completed" | "failed" | "killed"
  /** When its terminal record landed. Absent on an older tail state, which reads as "cannot tell" and
   *  therefore never fires a wake — the safe direction. */
  finishedAt?: string
}

// A pending native AskUserQuestion (structured, capped). Mirrors @frizz/shared PendingAsk; `id` is
// the tool_use id used to clear it when its tool_result lands.
export interface PendingAskData {
  id: string
  questions: AskQuestion[]
}

// A COMPLETED sub-agent retained for post-hoc review (reviewing a finished child is the main reason to
// open its drawer). On its terminal notification a live SubAgentEntry moves into a bounded ring here —
// EXCLUDED from every live surface (banner / counts / spinner stay live-only), but still resolvable by
// the drill-in drawer via its retained outputFile. The ring caps memory; its file may later be cleaned
// from disk, in which case the drawer degrades to its "transcript unavailable" state.
interface RetiredSubAgent {
  toolUseId: string
  label: string
  subagentType?: string
  outputFile?: string
  outputFormat?: "codex" // see SubAgentEntry.outputFormat
  // ISO8601 of the DISPATCH, carried over from the live entry. A retired row is normally never rendered,
  // but one holding a live fan-out is (see the RESTED anchor in descendantSubtrees), and that row needs
  // the same honest "working for 12m" instant every other child row shows rather than a derived one.
  startedAt?: string
  finishedAt?: string // ISO8601 of the completion notification
  status: "completed" | "failed" | "killed"
  // The RUNTIME task id (Claude's `agentId`) this child ran under — see SubAgentEntry.taskId. Retained
  // because a terminal child is NOT necessarily a finished one: a `SendMessage` RESTARTS a stopped
  // child, and the restart ack names only this id. It is how `trackResumes` matches a revived child
  // back to the row it was retired from, so the board shows one row per child rather than a new one
  // (or, before that path existed, none at all) on every re-steer.
  taskId?: string
}
interface RetiredShell {
  toolUseId: string
  command?: string
  outputFile?: string
  status: "completed" | "failed" | "killed"
  // The handles a fence may NAME this shell by, kept so the board can check a declaration against a
  // shell that has already finished as well as one still running.
  taskId?: string
  label: string
  // WHEN it finished, off its own terminal record. This is what tells the scheduler whether the AGENT
  // was told: the runtime delivers a shell's completion only to a RUNNING turn, so a shell that
  // finished after the agent's last word was never reported to anyone. See the shell-completion wake.
  finishedAt?: string
}
// How many terminal sub-agents to retain per thread for drawer review (newest-wins ring).
const RETAINED_SUBAGENTS_MAX = 20
const RETAINED_SHELLS_MAX = 20
// How many DESCENDANT terminal instants to hold (see TailState.descendantTerminals). Unlike the ring
// above these are 16 bytes apiece and are read, never rendered, so this is sized to the sidecar cap —
// one long orchestrator session in the local corpus accumulated 104 descendants across a day.
const DESCENDANT_TERMINALS_MAX = 512
// How many un-answered `SendMessage` summaries to hold (see TailState.pendingResumes). Each is
// consumed one record after it is recorded, so this only ever bounds the pathological case.
const PENDING_RESUMES_MAX = 32
// How many FOREGROUND `Bash` launches to hold pending their result (see TailState.pendingShells).
// Each is consumed by its own tool_result — usually the very next record — so this bounds nothing but
// the pathological case of a turn whose results never land.
const PENDING_SHELLS_MAX = 32
// How far behind the fold's high-water mark a restart ack may sit and still count as live. Covers
// ordinary out-of-order writes between sibling records; a REPLAYED ack (see trackResumes) carries its
// original timestamp and is stale by minutes to days, so nothing near this boundary is ambiguous.
const RESUME_REPLAY_SLACK_MS = 60_000
// How much of the opening human turn to keep. It is only ever chopped into a row title, and a whole
// first message can be a 20KB paste — this bounds what the fold holds for every session on the board.
const FIRST_USER_TEXT_MAX = 400

// Mutable accumulator for one session's tail. Extends the backend-neutral FoldState (the running
// derivation `applyRecord`/`applyEvent` fold into — turn, lastActivityAt, lastAssistant, aiTitle,
// lastUserAt, lastFence, lastAssistantHasQuestion, sawRecords); adds the tailer's own byte cursor
// (`offset`/`partial`) plus Claude-only tracking the neutral shape doesn't carry.
export interface TailState extends FoldState {
  slug: string
  sessionId: string
  nativeSessionId: string
  runtimeGeneration: number
  path: string
  // The delivery_ledger JSON this tailer last accounted for (pushed a projection for). A ROUTER write
  // (followUp opening a ledger entry) changes the row without any JSONL advance; this drift check is
  // what re-projects the transcript to already-subscribed clients within one tick.
  deliveryLedgerSeen?: string | null
  // A FOREIGN thread (a maintainer terminal discovered from the log dir, no registry row). Structural
  // guarantee that this state does none of the things frizz does to a thread it owns — no permission
  // sniff, no owner-death check, no notify / storage write — since frizz never dispatched it and holds
  // no `frizz-<slug>` runtime for it. Keyed by session id, not slug.
  foreign: boolean
  offset: number
  partial: string
  // Claude's turn model: the kind of the last substantive record + (for assistant) its stop_reason.
  // NOT in the neutral FoldState — codex brackets turns explicitly (applyEvent sets `turn` directly);
  // only Claude's computeTurn reads these two (+ the 5s unknown-stop-reason backstop).
  lastKind?: "assistant" | "user"
  lastStopReason?: string
  // The last substantive record was the runtime's own `[Request interrupted by user]` receipt. It is a
  // `type:"user"` record, so without this it reads as "a prompt landed, the model is about to respond"
  // and pins the turn in-flight FOREVER when nothing follows it — the same trap the isMeta guard in
  // applyRecord already documents, arriving through a different record. See computeTurn.
  interrupted?: boolean
  // ---- provider event stream vs its own disk write (broker Claude rows only) ----
  // `runtimeEventsSeen` is the provider event count this session's fold has already caught up with;
  // `runtimeChase` counts consecutive nudge-driven ticks spent waiting for it to. Both live here
  // rather than in the neutral FoldState because they describe the tailer's READ scheduling, not the
  // derivation. See chaseRuntime for why they exist at all.
  runtimeEventsSeen?: number
  runtimeChase?: number
  // live background OPS (sub-agents AND background shells), keyed by dispatch/launch tool_use id
  // (insertion order = launch order); the `kind` field distinguishes them at the view boundary.
  subAgents: Map<string, SubAgentEntry>
  // completed sub-agents retained for drawer review (bounded ring; NOT surfaced live) — see above
  retiredSubAgents: Map<string, RetiredSubAgent>
  // Completion reports the runtime QUEUED but has not (yet) put into the model's context, keyed by
  // task-id. Filled from a `queue-operation` carrier, cleared by a model-facing one. A survivor is a
  // report the agent provably never read — see report-delivery.ts for the corpus this comes from.
  queuedReports: Map<string, QueuedReport>
  // Task-ids proven to have reached the model. Separate from the map above because the two carriers
  // are NOT written in a fixed order: the queue-operation bookkeeping is FLUSHED and can land at a file
  // position AFTER the inline attachment that delivered it (the same reordering that made carrier (c)
  // load-bearing for background shells, tailer 2026-07-22). Without this set that late queue-op would
  // re-park an already-delivered report and frizz would "repair" a report the agent had read.
  deliveredReports: Set<string>
  // Every `tool_use` id THIS session's own model emitted — the OWNERSHIP key for a completion report.
  //
  // The runtime writes the `queue-operation` bookkeeping for every background op into the ROOT
  // transcript, a descendant's included, and the record names no owner (only `sessionId`, which is the
  // root's for all of them). Meanwhile a CHILD's op is delivered into the CHILD's transcript, which this
  // TailState never reads — so from here a descendant's op looks queued-and-never-delivered forever,
  // which is byte-for-byte the signature of the runtime drop `queuedReports` exists to repair. Without
  // an owner test frizz therefore "repaired" other agents' completions into this one: measured across
  // four real threads, 66% of completed background-op notifications in a parent transcript belong to a
  // descendant (1354 of 2052 on the worst), and on the one thread where the repair was live ALL 283 of
  // its relays were for ops this session never launched.
  //
  // A notification's `<tool-use-id>` is the launching tool call, so "did we emit that id?" answers
  // ownership exactly. Measured on the same four threads: every notification resolved to the parent's
  // tool_use or to a subagent's, 7 of 3734 to neither, and ZERO descendant ops were attributed here.
  //
  // NOT the correlation `reportKind` warns off. That one asks which live dispatch ENTRY a notification
  // belongs to — a lookup in `subAgents`, which misses a re-steered child and a grandchild (76 of 170).
  // This is the weaker, total question: was this id ever ours at all. Membership over the whole
  // transcript needs no live row and cannot be aged out by retirement.
  ownedToolUseIds: Set<string>
  // CODEX rows only: the sub-agent tracker that fills the two maps above from `spawn_agent` /
  // sub_agent_activity / list_agents plus each child rollout's own turn brackets (codex-subagents.ts).
  // Claude fills them from `trackDispatches` instead, so this stays undefined there.
  codexSubAgents?: CodexSubAgentTracker
  // completed shells retained so an already-open output drawer can render the terminal tail.
  retiredShells: Map<string, RetiredShell>
  // Dispatch tool_use ids the operator has RETIRED with the × — read from the registry at prime and
  // added to on every dismiss. The fold consults it before it may mint a live op, which is the ONLY
  // thing that keeps a killed shell dead: the kill leaves no record in the transcript and none on
  // disk, so a re-primed fold would otherwise re-create the row off its dispatch record and keep it
  // "running" forever (the maintainer's real 57-hour phantom, reproduced by one cold fold of their
  // transcript). Empty for a session that has never had an × clicked, which is nearly all of them.
  dismissedOps: Set<string>
  // Ops the fold has just seen RESTART under a dismissed id (trackResumes), queued for the tick to
  // clear from the registry. Absent until one happens, which is nearly always.
  unretiredOps?: Set<string>
  // DESCENDANT agent id → the instant its last TERMINAL <task-notification> was folded, in epoch ms.
  // A descendant (a sub-agent's own sub-agent) is never in `subAgents`, so the notification that
  // retires it correlates to no live entry — but it IS in this thread's transcript, and it is the only
  // prompt rest signal the branch has. See recordDescendantTerminal. Bounded; keyed by task-id, which
  // IS the agent id, so it joins straight onto a sidecar. Absent until the first one lands.
  descendantTerminals?: Map<string, number>
  // SendMessage tool_use id → the `summary` that call carried, held only until its tool_result lands
  // (the very next record). A RESTART ack names the child's runtime id and its output path but nothing
  // about the work, so this is the label of last resort when `trackResumes` has to mint a row for a
  // child whose retired record has already aged out of the ring. Bounded; consumed on use.
  pendingResumes?: Map<string, string>
  // FOREGROUND `Bash` tool_use id → the label/command that call carried, held only until its
  // tool_result lands. A foreground shell is normally none of the board's business (the spinner covers
  // it), but Claude Code AUTO-BACKGROUNDS one that outlives its `timeout` — and it announces that in the
  // RESULT, which carries no command text. Without this the promoted row would have nothing to be
  // labelled with. Bounded; consumed on use. See AUTO_BACKGROUND_ACK_RE.
  pendingShells?: Map<string, { label: string; command?: string; startedAt: string }>
  // MONOTONIC high-water mark over every timestamped record folded so far. `lastActivityAt` cannot
  // serve this purpose: it tracks the LATEST record folded and therefore moves BACKWARD whenever a
  // transcript replays history (which Claude's do — see trackResumes). This only ever advances, and it
  // is what lets a live restart be told apart from a replayed one.
  maxRecordAt?: string
  // a pending native AskUserQuestion the session is frozen on (no tool_result yet), else undefined
  pendingAsk?: PendingAskData
  subAgentsSig?: string // last-emitted signature of the derived background-ops + ask view (dirty-change detection)
  // transition tracking (dedupe)
  primed: boolean // first tick restores state WITHOUT firing transition notifies (boot/restart)
  permPrompt: boolean // last permission-block verdict (see sniffPane / permMarkerBlocks)
  permPolicy?: PermPolicyView // last DENIAL from the worker's permission policy (display only)
  permDenies?: number // how many policy DENIALS this thread has accumulated
  paneDead: boolean
  // ---- read-side transcript discovery (registered rows only; foreign states never touch these) ----
  // The pinned `<session_id>.jsonl` never appeared and discovery found no drifted transcript: a boot
  // failure. Surfaces a degraded runtime rather than an eternal spinner. Cleared if a transcript binds.
  noTranscript: boolean
  // Throttle: next epoch-ms at which discovery may re-run for an unresolved (missing-transcript) row.
  nextDiscoverMs: number
  // Consecutive discovery misses for this row, which set the interval above (see DISCOVER_RETRY_MAX_MS).
  // Reset to 0 the moment anything binds, so a row that heals returns to the responsive base interval.
  discoverMisses: number
  // One-shot guard so a stall's evidence is captured/logged once, not every tick.
  stallLogged: boolean
  customTitle?: string
  customTitleRevision: number
  // HISTORICAL, and the field it documented is already gone: Claude permission sidecars are
  // untimestamped, so an incremental observation used to be held until the worker's redrawn footer
  // proved which generation emitted it, rather than losing a genuine record that arrived a tick before
  // that footer became visible. Nothing renders a footer frizz can read now — the marker file carries
  // its own timestamp (see permMarkerBlocks).
}

// A single parsed JSONL record — only the fields the derivation needs are typed; the rest are
// ignored. `unknown`-shaped so a schema surprise degrades rather than throws.
interface Record {
  type?: string
  timestamp?: string
  isMeta?: boolean // `/rename <title>` reminder record: CLI metadata, not a user/model turn
  isCompactSummary?: boolean // the carry-over summary claude writes as a user record after compacting
  aiTitle?: string // present only on ai-title sidecar records
  customTitle?: string // present only on custom-title records (written by /rename)
  permissionMode?: unknown // present only on Claude permission-mode sidecars
  content?: unknown // top-level string on queue-operation records — carries the <task-notification> XML
  // On `attachment` records (type:"queued_command"): the injected text — a queued human follow-up OR a
  // background op's <task-notification>. This is the notification's INLINE-written carrier, positioned
  // AFTER its launch — unlike the queue-operation bookkeeping, which is flushed and can land BEFORE it.
  attachment?: { type?: string; prompt?: unknown }
  promptSource?: string // on user records: typed/queued (human) · "system" (peer msg / task-notification)
  isApiErrorMessage?: boolean // synthetic assistant record claude writes for a provider API error
  // Structured category claude stamps on that synthetic record: "rate_limit" (subscription window
  // exhausted) · "server_error" (connectivity/5xx) · "unknown" (everything else). This is what makes
  // limit detection structural rather than a text guess — see backend/usage-limit.ts.
  error?: unknown
  apiErrorStatus?: unknown // HTTP status alongside `error` (429 on a limit stop); absent on some errors
  // A SIDECHAIN record belongs to a sub-agent running inside this session, not to the main thread.
  // Modern claude writes children to their own transcripts, so this is currently always absent — it is
  // read only by the context reading, which would otherwise report a child's context as the parent's
  // the moment a build starts inlining them again.
  isSidechain?: boolean
  // `usage` is the API's own accounting for the request this record answered: input + cache-creation +
  // cache-read is exactly what the model's context held. See applyRecord's context reading.
  // NOTE: `Record` here is this module's own transcript-record interface, which SHADOWS the global
  // `Record<K,V>` utility type — so the usage bag is written as an index signature, not Record<…>.
  message?: { stop_reason?: string; content?: unknown; model?: string; usage?: { [key: string]: unknown } }
  // The reasoning effort this turn ran at, stamped by claude alongside `message.model`. Read only by
  // the sub-agent profile cell, for a dispatch whose own profile names no effort to inherit from.
  effort?: string
}

// Narrow text conjunction for a Claude AUTH error (vs other API errors riding the same synthetic
// record — overloaded, rate-limit, 5xx). The canonical observed line is
// "Please run /login · API Error: 401 Invalid authentication credentials".
export function isClaudeAuthErrorText(text: string): boolean {
  if (/Please run \/login/i.test(text)) return true
  return /\b401\b/.test(text) && /authenticat|credential|OAuth/i.test(text)
}

// A fresh, unread tail cursor for a session (exported for tick + tests).
export function newTailState(
  slug: string,
  sessionId: string,
  path: string,
  foreign = false,
  nativeSessionId = sessionId,
  runtimeGeneration = 0,
): TailState {
  return {
    slug,
    sessionId,
    nativeSessionId,
    runtimeGeneration,
    path,
    foreign,
    offset: 0,
    partial: "",
    sawRecords: false,
    lastAssistantHasQuestion: false,
    lastAssistantAllDone: false,
    subAgents: new Map(),
    retiredSubAgents: new Map(),
    queuedReports: new Map(),
    deliveredReports: new Set(),
    ownedToolUseIds: new Set(),
    retiredShells: new Map(),
    dismissedOps: new Set(),
    primed: false,
    turn: "in-flight",
    permPrompt: false,
    paneDead: false,
    noTranscript: false,
    nextDiscoverMs: 0,
    discoverMisses: 0,
    stallLogged: false,
    customTitleRevision: 0,
  }
}

// Defensive JSON parse: a malformed line yields null (skipped), never an exception.
export function parseLine(line: string): Record | null {
  const s = line.trim()
  if (!s) return null
  try {
    const v = JSON.parse(s)
    return v && typeof v === "object" ? (v as Record) : null
  } catch {
    return null
  }
}

// The RAW last text block of an assistant message (newlines intact). Handles the streaming split (one
// block per record) and a defensive multi-block array alike. Kept raw because the question-fence
// detection below needs the line structure the preview collapses away.
function lastTextBlock(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  let text: string | undefined
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: unknown }).text
      if (typeof t === "string") text = t
    }
  }
  return text
}

// The board preview of an assistant text block: whitespace collapsed to single spaces, trimmed, capped
// at ~200 chars. Empty/whitespace-only → undefined (leaves the prior preview in place).
function previewText(raw: string): string | undefined {
  const norm = raw.replace(/\s+/g, " ").trim()
  if (!norm) return undefined
  return norm.length > 200 ? `${norm.slice(0, 200)}…` : norm
}

// Minimal server-side MIRROR of the web's ```question fence convention (web/src/lib/questionBlocks.ts
// QUESTION_BLOCK) — a presence check only, not a full parse: an opening ```question line (optional
// kind info-string like `multi`), its body, then a closing ``` line. Kept in sync BY HAND (the
// architecture forbids importing web code into the server). Drives the derived pending-question safety
// net: a worker that asked the human IN CHAT but never flipped its thread file to blocked.
// Info-string grammar mirrors the web exactly: one or more space-separated tokens (```question
// multi danger) — the old single-token form silently missed multi-token gates the prompt teaches.
// It matches on SHAPE, never on the token set, so a retired token (`approval`) or a future one still
// registers as an ask here exactly as it still renders as a card in the web.
// A QUOTED opener never counts: a worker documenting the protocol wraps its sample in an outer ````
// fence, and flagging that as a live ask parks the thread in "awaiting you" over an example. The
// fenced-interior scan is the one piece genuinely SHARED with the web (@frizz/shared) rather than
// mirrored — the renderer and this flag must agree on what an opener is. `parseSignalFence` needs no
// such guard: its end-anchor already rejects any fence that isn't the final content of the message.
const QUESTION_BLOCK_RE = /^```question(?:[ \t]+[A-Za-z][^\r\n]*?)?[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*$/gm
export function hasQuestionBlock(text: string | undefined): boolean {
  if (typeof text !== "string") return false
  const quoted = insideFence(text)
  QUESTION_BLOCK_RE.lastIndex = 0
  for (let m = QUESTION_BLOCK_RE.exec(text); m !== null; m = QUESTION_BLOCK_RE.exec(text)) {
    if (!quoted(m.index)) return true
    QUESTION_BLOCK_RE.lastIndex = m.index + 1
  }
  return false
}

// ---- signal-fence grammar (maintainer-settled) ----
// Exactly two EXCUSAL fences: ```done and ```awaiting. The fence LANGUAGE is the state; the BODY is
// the message. The opening line is the bare language word (trailing spaces/tabs tolerated, nothing
// else after it); the body runs to a closing ``` line. If a text carries several signal fences the
// LAST wins — and the last fence must be the FINAL NON-WHITESPACE CONTENT of the text (the prompt's
// "at the very end" rule): a fence merely QUOTED mid-message (a worker explaining the protocol to the
// human) must never excuse the thread from the queue. Malformed/unclosed fences never match.
// CRLF-tolerant (normalized before matching).
// ONE implementation so the grammar lives in a single place (mirrors QUESTION_BLOCK_RE's spirit). The
// ```question fence keeps its own separate machinery (hasQuestionBlock) — it is NOT a signal fence.
const SIGNAL_FENCE_RE = /^```(done|awaiting)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm
// An awaiting-body hint line: `<kind>: <value>`. Kind is case-insensitive (lowercased on output); the
// value must start with a non-space char (a bare `pr:` with nothing after is prose, not a hint).
// THREE PLACES SPELL THE VOCABULARY and they must move together: this regex, FenceView["hints"]'s
// `kind` union, and the guard below. A kind added to the union and the guard but NOT here parses as
// prose — which is exactly what happened to the retired `watch:` on 2026-08-14, leaving the whole
// fence-based park inert in production while every unit test passed (they built `hints` by hand).
// Caught only by folding a real transcript: awaiting-watch.e2e.test.ts. Keep an e2e fold in that file
// for any kind you add. If two kinds ever share a prefix, the longer must LEAD the alternation.
// ANY `key: value` line at the top level of the frontmatter. It is deliberately WIDER than the grammar:
// its job is to spot a line that CLAIMS to be structural so an unrecognised key can be refused by name,
// which is the whole point of having a delimiter (2026-08-17). Hyphens are in the class because the
// oldest retired kind is `pr-watch:`, and a regex that could not see it let one pass as prose.
const AWAITING_HINT_RE = /^([a-z][a-z-]*):\s*(\S.*)?$/i
const FENCE_BODY_MAX = 500 // defensive: never let a worker's fence body fatten the snapshot
const HINT_MAX = 8 // defensive cap on parsed hint lines
const HINT_VALUE_MAX = 200 // defensive cap on a single hint value

function capFenceBody(s: string): string {
  return s.length > FENCE_BODY_MAX ? `${s.slice(0, FENCE_BODY_MAX)}…` : s
}

// Parse the done/awaiting signal fence out of an assistant text, or undefined if none. Pure and
// defensive (never throws) so it is unit-testable and degrades on any surprise. For `awaiting`,
// `<kind>: <value>` lines become `hints` in file order and the remaining lines are the prose `body`;
// for `done`, the whole body is the message and hints are empty.
export function parseSignalFence(text: string | undefined): FenceView | undefined {
  if (typeof text !== "string") return undefined
  const norm = text.replace(/\r\n/g, "\n")
  SIGNAL_FENCE_RE.lastIndex = 0
  let kind: "done" | "awaiting" | undefined
  let raw = ""
  let end = 0
  let m: RegExpExecArray | null
  while ((m = SIGNAL_FENCE_RE.exec(norm)) !== null) {
    kind = m[1] as "done" | "awaiting" // last-fence-wins: keep overwriting
    raw = m[2]
    end = m.index + m[0].length
  }
  if (!kind) return undefined
  // End-anchor: the fence only signals when it closes the message (trailing whitespace tolerated).
  // Prose after the last fence means it was quoted/explanatory, not a signal — no excusal.
  if (norm.slice(end).trim() !== "") return undefined
  if (kind === "done") return { kind, body: capFenceBody(raw.trim()), hints: [] }
  // awaiting: YAML frontmatter, then Markdown. The split lives in @frizz/shared because the CLIENT parses
  // the same fence to decide how it RENDERS while this decides whether the thread PARKS — and those were
  // two implementations, each with a comment asking the next reader to keep them in step. The 2026-08-24
  // YAML cutover moved one and not the other, and a correct fence promptly printed its own raw
  // frontmatter at the human in the in-chat card. One function, called twice, is the only thing that
  // actually prevents that. See `splitAwaitingFrontmatter` for the grammar and its failure modes.
  const { body, hints } = splitAwaitingFrontmatter(raw)
  return { kind, body: capFenceBody(body), hints }
}

// A user record is a REAL user interaction (a typed prompt / answer / steer / dispatch) rather than a
// mere tool_result fed back to the model mid-turn. The distinction matters for the chronological
// listing order: only the user's OWN messages should bump a row, never the agent's tool activity.
// Shape: a real prompt's `content` is a STRING (or an array carrying at least one non-tool_result
// block — text/image); a tool exchange's `content` is an array of ONLY tool_result blocks.
export function isRealUserMessage(content: unknown): boolean {
  if (typeof content === "string") return true
  if (!Array.isArray(content)) return false
  return content.some((b) => !(b && typeof b === "object" && (b as { type?: string }).type === "tool_result"))
}

// Did the HUMAN produce this user record, or did the machinery? EVERY `type:"user"` record reaches the
// fold — the human's prompt, a tool_result echoed back mid-turn, a peer's message, a task-notification,
// a wake pulse, the runtime's own interrupt receipt — and only the first is a person taking a turn.
//
// This is the ONE question two derivations were answering two different ways. The chat asks it off
// `isAllInjectedNoise` and renders a bubble only when the answer is yes; the fold asked nothing and read
// EVERY user record as the human moving the conversation on, which erased the evidence that a thread was
// waiting on an answer nobody had given (see the ```question note in applyRecord). Both now call the
// same SHARED classifier, so a record the chat does not even draw can never again change what the board
// says the human owes. The row-order key below wants exactly this predicate too — its own comment
// demanded it, and it was enforcing only the two cases anyone had hit.
function isHumanSpeaking(rec: Record, text: string, system: boolean, compactSummary: boolean): boolean {
  if (system || compactSummary) return false // a peer/notification record, or claude's carry-over summary
  if (!isRealUserMessage(rec.message?.content)) return false // a bare tool_result is agent activity
  return !isAllInjectedNoise(text) && !isInterruptMarker(text)
}

/** The plain text of a user record's content — a bare string, or the text blocks of an array, joined.
 *  Returns "" for a record carrying no text at all (an image-only or tool_result-only turn). */
export function userMessageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; text?: unknown }
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
  }
  return parts.join("\n")
}

// Flatten a tool_result's `content` (an array of {type:"text", text} blocks, or a bare string) into
// one string so we can regex the launch metadata out of it. Defensive: anything unexpected → "".
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: unknown }).text
      if (typeof t === "string") out += t
    }
  }
  return out
}

// One-line summary of a shell command: first non-blank line, whitespace-collapsed, capped. The label
// for a background shell when the model gave no `description`.
function shellSummary(command: unknown): string {
  if (typeof command !== "string") return "background shell"
  const first = (command.split("\n").find((l) => l.trim()) ?? "").trim().replace(/\s+/g, " ")
  if (!first) return "background shell"
  return first.length > 120 ? `${first.slice(0, 119)}…` : first
}

// Register each BACKGROUND OP in an assistant message as a tracked live entry, keyed by tool_use id:
//   • an `Agent` dispatch (unless run_in_background:false — a foreground/blocking child the spinner
//     already covers; Agent defaults to background) → kind "agent" (drill-in + [type] tag).
//   • a `Bash` with run_in_background:true (a persist-across-rest shell — a CI watcher, a long build)
//     → kind "shell" (display-only).
//   • a `Monitor` (always background in Claude Code; finite or session-persistent) → kind "shell" too.
//     Tracking it keeps an off-turn worker in Active while the monitor owns an automatable wait.
// Re-seeing the same id preserves any outputFile already resolved from its launch result.
// A `SendMessage` registers NOTHING here — it addresses a child that already exists — but its recap is
// parked for `trackResumes`, the one path where such a call restarts a stopped child.
function trackDispatches(state: TailState, rec: Record): void {
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; name?: string; id?: unknown; input?: unknown }
    if (b.type !== "tool_use") continue
    const id = typeof b.id === "string" ? b.id : undefined
    if (!id) continue
    // OWNERSHIP, recorded BEFORE any of the filters below. A dismissed op and a foreground Agent are
    // still OURS — the branches under this one decide what to SHOW, which is a different question from
    // whose completion report this is (see TailState.ownedToolUseIds).
    //
    // Narrowed to the three tools that can ever produce a `<task-notification>`, which is exactly the
    // set `reportKind` recognizes (an agent's report, a background command's, a monitor's). Recording
    // every tool call instead would work and would also put the whole transcript's tool ids into the
    // cached tail state on every write. Bash is included REGARDLESS of `run_in_background`: a
    // foreground one that outlives its timeout is auto-backgrounded, and only its result says so.
    if (b.name === "Agent" || b.name === "Bash" || b.name === "Monitor") rememberOwnedToolUse(state, id)
    // The operator RETIRED this op. Its dispatch record is still here and always will be — a killed
    // shell never gets a terminal record — so without this line every re-prime mints the row afresh
    // and it reads "running" forever. See FoldState.dismissedOps.
    if (state.dismissedOps.has(id)) continue
    const input = (b.input ?? {}) as { description?: unknown; run_in_background?: unknown; subagent_type?: unknown; model?: unknown; command?: unknown; summary?: unknown }
    const startedAt = typeof rec.timestamp === "string" ? rec.timestamp : (state.lastActivityAt ?? "")
    const previous = state.subAgents.get(id)
    const outputFile = previous?.outputFile
    const desc = typeof input.description === "string" && input.description.trim() ? input.description.trim() : undefined
    if (b.name === "Agent") {
      if (input.run_in_background === false) continue // foreground (blocking) — visible via the spinner
      // The worker-profile cell (model+effort). Resolved rather than taken verbatim: an effort-only
      // profile (`frizz:high`) carries no model, and the model it inherits is the one THIS record ran
      // at — see subagent-profile.ts, which composes both halves into the one form every surface reads.
      const subagentType = dispatchProfileCell({ subagentType: input.subagent_type, model: input.model, turnModel: rec.message?.model, turnEffort: rec.effort })
      state.subAgents.set(id, { kind: "agent", toolUseId: id, label: desc ?? "sub-agent", startedAt, subagentType, outputFile })
    } else if ((b.name === "Bash" && input.run_in_background === true) || b.name === "Monitor") {
      const command = typeof input.command === "string" ? input.command : previous?.command
      state.subAgents.set(id, { kind: "shell", toolUseId: id, label: desc ?? shellSummary(input.command), startedAt, command, outputFile, taskId: previous?.taskId })
    } else if (b.name === "Bash") {
      // A FOREGROUND Bash — not a background op, and normally none of this map's business. But Claude
      // Code auto-backgrounds one that outlives its `timeout`, and only the RESULT says so, so park the
      // label/command here for trackLaunchResults to promote from. Dropped by the same result when the
      // command simply finished, which is the overwhelmingly common case.
      const pending = (state.pendingShells ??= new Map())
      pending.set(id, { label: desc ?? shellSummary(input.command), command: typeof input.command === "string" ? input.command : undefined, startedAt })
      while (pending.size > PENDING_SHELLS_MAX) {
        const oldest = pending.keys().next().value
        if (oldest === undefined) break
        pending.delete(oldest)
      }
    } else if (b.name === "SendMessage") {
      // NOT a dispatch — a message to an already-dispatched child, which registers nothing here. But it
      // may RESTART a child that has already stopped (see trackResumes), and only this record carries a
      // human-readable recap of the work. Park it for the tool_result one record later; if that result
      // turns out to be an ordinary "queued for delivery" it is simply dropped.
      const summary = typeof input.summary === "string" ? input.summary.trim() : ""
      if (summary) {
        const pending = (state.pendingResumes ??= new Map())
        pending.set(id, summary.length > 160 ? `${summary.slice(0, 159)}…` : summary)
        while (pending.size > PENDING_RESUMES_MAX) {
          const oldest = pending.keys().next().value
          if (oldest === undefined) break
          pending.delete(oldest)
        }
      }
    }
  }
}

// Corpus-verified LAUNCH-ACK shapes (2026-07-09; surveyed across the real transcripts in
// ~/.claude/projects — three Agent ack wordings + the Bash/Monitor shell acks coexist in the wild):
//   • "Async agent launched successfully…"  — older Agent ack; MAY carry "output_file: <path>"
//   • "Spawned successfully…"               — newer mailbox/teammate ack; carries "agentId: <id>", NO path
//   • "Command running in background…"      — Bash shell ack; carries "Output is being written to: <path>"
//   • "Monitor started…"                    — Monitor ack; task id but no output path
// A tracked id's tool_result matching one of these means the child is now RUNNING DETACHED — keep
// tracking. Anything else on a tracked AGENT id is the synchronous (foreground) call's final report —
// its completion (an error/denial result also means the dispatch is over). The earlier discriminator
// ("no output_file: token ⇒ foreground") retired live background children of the two path-less ack
// shapes — including every mailbox-style Agent and every background shell — on their own launch ack.
const LAUNCH_ACK_RE = /^\s*(Async agent launched successfully|Spawned successfully|Command running in background|Monitor started|Command did not complete within its)/

// The FIFTH launch shape, and the only one that arrives for a call nothing registered: Claude Code
// AUTO-BACKGROUNDS a foreground `Bash` that outlives its `timeout` and says so in the result —
//   "Command did not complete within its 590s timeout and was moved to the background (ID: bhlfxzwg1).
//    Output is being written to: …/tasks/bhlfxzwg1.output. You will be notified when it completes."
// From that instant it is an ordinary detached shell: it outlives the turn, it keeps the worker's own
// work live across a rest, and it terminates with the same <task-notification> (carrying the ORIGINAL
// tool_use id, so retirement correlates normally). frizz used to see none of it — `trackDispatches`
// only registers `run_in_background: true` — so such a shell was invisible on every surface, could not
// hold its thread Active, and its completion correlated to nothing. 881 of these acks sit in the local
// transcript corpus; one thread hit it three times in an hour (2026-07-30, reported as "a background
// bash script completed, but it did not resume the agent"). Promoted in trackLaunchResults.
const AUTO_BACKGROUND_ACK_RE = /^\s*Command did not complete within its .{0,40}?and was moved to the background/

// Move a tracked AGENT entry into the bounded retained ring (drawer review), evicting the oldest.
// Shared by the foreground-completion path and the <task-notification> path.
function retireToRing(state: TailState, entry: SubAgentEntry, finishedAt: string | undefined, status: "completed" | "failed" | "killed"): void {
  state.retiredSubAgents.delete(entry.toolUseId)
  state.retiredSubAgents.set(entry.toolUseId, {
    toolUseId: entry.toolUseId,
    label: entry.label,
    subagentType: entry.subagentType,
    outputFile: entry.outputFile,
    outputFormat: entry.outputFormat,
    taskId: entry.taskId,
    startedAt: entry.startedAt,
    finishedAt,
    status,
  })
  while (state.retiredSubAgents.size > RETAINED_SUBAGENTS_MAX) {
    const oldest = state.retiredSubAgents.keys().next().value
    if (oldest === undefined) break
    state.retiredSubAgents.delete(oldest)
  }
}

// Remember that a DESCENDANT reported a terminal status. This is the rest signal the descendant rows
// used to have no access to, and it was hiding in plain sight: when a sub-agent's own sub-agent stops,
// the <task-notification> is enqueued on the ROOT session — the transcript this fold already reads —
// carrying `<task-id>` (the agent id, which is the sidecar's own filename key) and `<tool-use-id>`.
// The notification correlates to no LIVE entry, because a descendant is derived from sidecars and was
// never tracked in `subAgents`, so trackCompletions used to drop it on the floor and descendant
// liveness fell back entirely to SUBAGENT_STALE_MS — 15 minutes of a rested grandchild reading
// "running", its duration counting up from spawn the whole time. Measured on the live board
// (nub session 0bb9560b, 2026-07-30): 36 of 38 depth-2 descendants had a terminal notification sitting
// in the root transcript, each landing 0-13s AFTER the descendant's own last write; the 2 without one
// were the 2 genuinely still running. Reported by the maintainer as "when I click into the
// sub-sub-agents, a lot of them have rested or stopped, even though they're still showing up as
// running actively".
function recordDescendantTerminal(state: TailState, agentId: string, at: number): void {
  const seen = state.descendantTerminals ?? new Map<string, number>()
  state.descendantTerminals = seen
  // Newest-wins, and re-inserted so eviction order stays insertion order. A task-id CAN notify more
  // than once (the notification says so itself — a resumed agent re-notifies), and the LAST one is the
  // reading that matters: see descendantState, which measures the transcript against this instant.
  seen.delete(agentId)
  seen.set(agentId, at)
  while (seen.size > DESCENDANT_TERMINALS_MAX) {
    const oldest = seen.keys().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
}

// Retire a live entry however it was CORRELATED (by tool_use id from a notification, or by runtime
// task id from a manual stop) — the map key is always its tool_use id. Both kinds retain the bounded
// metadata their read-only drawers need. The single exit for every terminal signal.
function retireLive(state: TailState, entry: SubAgentEntry, finishedAt: string | undefined, status: "completed" | "failed" | "killed"): void {
  state.subAgents.delete(entry.toolUseId)
  if (entry.kind === "shell") {
    state.retiredShells.delete(entry.toolUseId)
    state.retiredShells.set(entry.toolUseId, { toolUseId: entry.toolUseId, command: entry.command, outputFile: entry.outputFile, status, taskId: entry.taskId, label: entry.label, finishedAt })
    while (state.retiredShells.size > RETAINED_SHELLS_MAX) {
      const oldest = state.retiredShells.keys().next().value
      if (oldest === undefined) break
      state.retiredShells.delete(oldest)
    }
    return
  }
  retireToRing(state, entry, finishedAt, status)
}

// Find a live tracked op by its RUNTIME task id — the correlation key a manual `TaskStop` carries (it
// has no tool_use id). Maps hold a handful of live ops, so a scan beats a second index that every
// removal path would have to keep in sync (index desync is the exact bug class this change closes).
function findLiveByTaskId(state: TailState, taskId: string): SubAgentEntry | undefined {
  for (const e of state.subAgents.values()) if (e.taskId === taskId) return e
  return undefined
}

// Resolve a tracked child's transcript path from its launch ack, best shape first: an explicit
// "output_file:" (older Agent ack), the shell ack's "Output is being written to:", else DERIVED from
// the mailbox ack's agentId — subagent transcripts live at <session-dir>/subagents/agent-<id>.jsonl
// beside the parent's own jsonl (verified on disk 2026-07-09). Undefined when nothing resolves (the
// entry then simply never goes stale — its completion notification still clears it).
function launchOutputFile(state: TailState, text: string): string | undefined {
  const m = text.match(/output_file:\s*(\S+)/) ?? text.match(/Output is being written to:\s*(\S+)/)
  // The shell ack embeds the path mid-sentence ("… written to: <path>. You will be notified …") —
  // strip the sentence period or the staleness stat hits a nonexistent path and flags every shell stale.
  if (m) return m[1].replace(/\.$/, "")
  const aid = text.match(/agentId:\s*(\S+)/)?.[1]
  if (aid) return `${state.path.replace(/\.jsonl$/, "")}/subagents/agent-${aid}.jsonl`
  return undefined
}

// The RUNTIME task id from a launch ack — the key a later `TaskStop` (and every natural completion
// notification) references. One per corpus-verified ack shape: the Bash background ack, the Monitor
// ack, and the mailbox Agent ack (whose agentId doubles as its TaskStop handle). Undefined for the
// path-only older Agent ack, which has no manual-stop handle and clears on its notification anyway.
// The app-server reports a model-run command as the ARGV it actually spawned —
// `/bin/zsh -lc 'sleep 900'` — while codex's own `backgroundTerminals/list`, the rollout, and therefore
// frizz's transcript-projected row all say `sleep 900`. Two things ride on stripping the wrapper: the
// operator reads the command they asked for rather than the launcher's plumbing, and the board row and
// the transcript row become reconcilable at all (lib/childOps.ts mergeBackgroundShells keys on it —
// without this they render as two rows for one process).
//
// Deliberately narrow: only the exact `<shell> -lc '<cmd>'` / `-c "<cmd>"` shape, only when the quoting
// spans the whole remainder. Anything else is returned untouched — a half-parsed command line is worse
// than a verbose one.
export function unwrapShellCommand(command: string | undefined): string | undefined {
  if (!command) return command
  const match = command.match(/^\S*(?:sh|bash|zsh|fish|dash|ksh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/)
  return match ? match[2] : command
}

function launchTaskId(text: string): string | undefined {
  return (
    text.match(/Command running in background with ID:\s*(\S+)/)?.[1]?.replace(/\.$/, "") ??
    text.match(/was moved to the background \(ID:\s*([^)\s]+)\)/)?.[1] ??
    text.match(/Monitor started \(task\s+(\w+)/)?.[1] ??
    text.match(/agentId:\s*(\S+)/)?.[1]
  )
}

// ---- DESCENDANTS: a sub-agent's sub-agent, and so on down --------------------------------------
//
// A grandchild's DISPATCH is not in this thread's transcript — it is in the CHILD's, because the child
// is the one that ran the Agent tool. So neither `subAgents` nor `retiredSubAgents` can ever hold it,
// and the drill-in drawer's lookup used to bottom out at depth 1 (the drawer then states "unavailable",
// which is honest but is also all it could say).
//
// The provider does record it, twice over. Measured on a real three-level broker session
// (`_live_broker_depth.mts`, 2026-07-28 — read that harness's output before changing anything here):
//
//  1. ON THE STREAM. Everything is ONE session: the grandchild's dispatch arrives as an assistant event
//     whose `parentToolUseId` is the CHILD's dispatch id, and the grandchild gets its own task_started /
//     task_progress / task_notification carrying its own taskId + toolUseId. 33 of 50 assistant+user
//     events in that run carried a parentToolUseId, so the link is populated in practice, not in theory.
//  2. ON DISK, which is what this code uses. Beside every child transcript claude writes a SIDECAR,
//     `<session-dir>/subagents/agent-<agentId>.meta.json`, verbatim from that run:
//       {"agentType":"general-purpose","description":"LEVEL-ONE","toolUseId":"toolu_01Tszn…","spawnDepth":1}
//       {"agentType":"general-purpose","description":"LEVEL-TWO","toolUseId":"toolu_01E6L4…",
//        "parentAgentId":"a40cc1902e8ccba6d","spawnDepth":2}
//
// The disk route is the one to build on because the directory is FLAT: a child, a grandchild and a
// great-grandchild all write into the SAME `subagents/` dir of the ROOT session. So "resolve a
// descendant at any depth" is ONE capped directory read keyed by the very dispatch tool_use id the
// drawer is already holding — there is no tree to walk, hence no recursion to bound and no malformed
// parent link that could loop. `parentAgentId` and `spawnDepth` come along for free and are recorded
// here rather than derived, so nothing downstream has to guess at either.
interface DescendantSidecar {
  agentId: string // from the FILENAME, so it exists even for a sidecar whose body is junk
  toolUseId?: string // the dispatch id — the key the drawer resolves against
  description?: string
  agentType?: string
  parentAgentId?: string // absent at depth 1 (a direct child of the session)
  spawnDepth?: number // 1 for a direct child, 2 for a grandchild, …
  // The sidecar file's own mtime. It is written ONCE at spawn and never rewritten (the same property
  // the index's invalidation relies on), so this IS the dispatch instant — a real reading off disk, not
  // a fabricated one. It gives a surfaced descendant row the same "working for 38s" duration a direct
  // child gets from its dispatch record. Undefined when the file no longer stats.
  spawnedAtMs?: number
}

// How many sidecars one resolution pass will read. A bound, not an opinion: a long orchestrator
// session can accumulate hundreds of descendants and this runs behind a polling drawer.
const DESCENDANT_SIDECAR_MAX = 512

// How far a descendant's transcript may advance PAST its own terminal notification while still reading
// as finished. Two different clocks are being compared — a record's ISO timestamp against a file's
// mtime — and the notification is written a beat AFTER the work it reports, so a bare `mtime > notified`
// would call a settled descendant "resumed" on sub-second skew. Sized off the real distribution (nub
// session 0bb9560b): of 36 notified depth-2 descendants, 34 last wrote 2-609s BEFORE their
// notification, 2 landed inside the same second, and the ONE genuinely resumed descendant wrote again
// 172s after — so anything from ~1s to ~170s separates the two populations. 5s sits in that gap with
// room on both sides, and a resume that IS missed self-heals on the descendant's next write.
const DESCENDANT_NOTIFY_GRACE_MS = 5_000

// Read a session's descendant sidecars. DEGRADES at every level and never throws — a missing dir, an
// unreadable file, half-written JSON, a body that is not an object are each skipped, because this runs
// on the drawer's read path and a throw there is a dead drawer (and, historically in this subsystem, a
// dead thread). A sidecar frizz cannot parse simply does not resolve, which is the state it was in
// before this existed.
function readDescendantSidecars(sessionDir: string, mtimeMs: (path: string) => number | undefined): DescendantSidecar[] {
  let names: string[]
  try {
    names = readdirSync(join(sessionDir, "subagents"))
  } catch {
    return []
  }
  const out: DescendantSidecar[] = []
  for (const name of names) {
    if (out.length >= DESCENDANT_SIDECAR_MAX) break
    const agentId = /^agent-(.+)\.meta\.json$/.exec(name)?.[1]
    if (!agentId) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(sessionDir, "subagents", name), "utf8"))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const meta = parsed as { toolUseId?: unknown; description?: unknown; agentType?: unknown; parentAgentId?: unknown; spawnDepth?: unknown }
    const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined)
    out.push({
      agentId,
      toolUseId: text(meta.toolUseId),
      description: text(meta.description),
      agentType: text(meta.agentType),
      parentAgentId: text(meta.parentAgentId),
      spawnDepth: typeof meta.spawnDepth === "number" && Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : undefined,
      spawnedAtMs: mtimeMs(join(sessionDir, "subagents", name)),
    })
  }
  return out
}

// Process tool_results for tracked background ops: enrich a launch ack with the child's transcript
// path (staleness clock) and keep tracking; retire a tracked AGENT whose tool_result is NOT a launch
// ack (a synchronous call's final report / an error — no task-notification ever fires for those;
// missing this leaked 26 phantom "running" sub-agents on a busy session, found 2026-07-09). A tracked
// SHELL follows the same launch discriminator: a recognized background/Monitor ack stays live; any
// synchronous error/non-ack result means no detached operation exists and is removed immediately.
// Once launched, its terminal signal remains the <task-notification>.
//
// This is ALSO where a foreground `Bash` becomes a background one: its result — not its call — is what
// announces the auto-background handoff, so an id nothing registered can still promote here out of
// `pendingShells`. See AUTO_BACKGROUND_ACK_RE.
function trackLaunchResults(state: TailState, rec: Record): void {
  if (state.subAgents.size === 0 && !state.pendingShells?.size) return
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; tool_use_id?: unknown; content?: unknown; is_error?: unknown }
    if (b.type !== "tool_result") continue
    const id = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined
    if (!id) continue
    const text = toolResultText(b.content)
    let entry = state.subAgents.get(id)
    if (!entry) {
      // A parked FOREGROUND shell's result. Either it was auto-backgrounded — promote it to a live
      // tracked shell, from this instant indistinguishable from one launched with run_in_background —
      // or it simply finished, and the park is over either way. `is_error` guards the (unobserved but
      // cheap to exclude) case of the harness reporting the handoff as a failure.
      const parked = state.pendingShells?.get(id)
      if (!parked) continue
      state.pendingShells?.delete(id)
      if (state.dismissedOps.has(id)) continue // retired by the operator — see FoldState.dismissedOps
      if (b.is_error === true || !AUTO_BACKGROUND_ACK_RE.test(text)) continue
      entry = { kind: "shell", toolUseId: id, label: parked.label, startedAt: parked.startedAt, command: parked.command }
      state.subAgents.set(id, entry)
    }
    if (!entry.outputFile) entry.outputFile = launchOutputFile(state, text)
    if (!entry.taskId) entry.taskId = launchTaskId(text)
    if (LAUNCH_ACK_RE.test(text)) continue // background launch ack — the child/shell is alive, keep tracking
    if (entry.kind === "shell") {
      state.subAgents.delete(id) // synchronous launch failure: no notification will ever arrive
      continue
    }
    // Foreground completion (or a failed dispatch): the tool_result IS the terminal signal.
    state.subAgents.delete(id)
    retireToRing(state, entry, typeof rec.timestamp === "string" ? rec.timestamp : undefined, "completed")
  }
}

// A `SendMessage` aimed at a child that has ALREADY STOPPED does not just deliver a message — it
// RESTARTS that child, detached, exactly as the original dispatch did ("resumed it in the background
// … You'll be notified when it finishes"). Nothing else in the transcript announces that restart: the
// child's terminal notification already fired and retired the row, and no new `Agent` tool_use is ever
// written. That is why a re-steered child vanished from the board while it was demonstrably running —
// reproduced on a real 8668-record session (2026-07-28) where four children hit a session limit, were
// re-steered minutes later, and the fold held all four in `retiredSubAgents` with status "failed".
//
// The discriminator is STRUCTURED, not prose: the tool_result is a JSON object, and `resumedAgentId`
// is present on exactly the shapes that restart something. Corpus-verified over every SendMessage
// result in ~/.claude/projects (705 transcripts, 802 results, 2026-07-28) — four shapes, all
// `success:true`:
//   • "Message queued for delivery to <id> at its next tool round."           466 · NO resumedAgentId
//   • "Agent \"<id>\" had no active task; resumed from transcript …"          230 · resumedAgentId
//   • "Agent \"<id>\" was stopped (completed); resumed it in the background …"  95 · resumedAgentId
//   • "Agent \"<id>\" was stopped (failed); resumed it in the background …"     11 · resumedAgentId
// The first is the child already being alive — reviving on it would DOUBLE a row the fold still holds,
// which is the phantom class this whole path has leaked three times. The other three each promise the
// <task-notification> that will retire the revived row, so nothing minted here can dangle without a
// terminal signal coming for it.
interface ResumeAck {
  agentId: string // the restarted child's runtime task id (`to:` / `resumedAgentId`)
  outputFile?: string // its transcript, re-stated by the ack — the same path the launch ack gave
}
function parseResumeAck(text: string): ResumeAck | undefined {
  if (!text.includes("resumedAgentId")) return undefined // cheap reject before the parse
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined // a shape that only MENTIONS the field is not a restart
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const ack = parsed as { success?: unknown; resumedAgentId?: unknown; message?: unknown }
  if (ack.success !== true) return undefined
  const agentId = typeof ack.resumedAgentId === "string" ? ack.resumedAgentId.trim() : ""
  if (!agentId) return undefined
  const message = typeof ack.message === "string" ? ack.message : ""
  return { agentId, outputFile: message.match(/Output:\s*(\S+)/)?.[1]?.replace(/\.$/, "") }
}

// Correlate a restart ack to a row frizz already holds. The runtime task id is the primary key (both
// the launch ack's `agentId:` and this ack's `resumedAgentId` are that same id); the output path is a
// second, independent key, since both acks state it verbatim. Two keys because a MISS here mints a
// duplicate row for a child that is already on the board — the failure mode that costs the most.
function matchesAgent(candidate: { taskId?: string; outputFile?: string }, ack: ResumeAck): boolean {
  if (candidate.taskId && candidate.taskId === ack.agentId) return true
  return Boolean(ack.outputFile && candidate.outputFile === ack.outputFile)
}

// Revive a child the fold has already retired (or never saw) when its parent re-steers it back to
// life. Keyed by the ORIGINAL dispatch tool_use id whenever the retired row can be found, so the
// child keeps one stable identity across any number of re-steers and an open drill-in drawer keeps
// resolving; only a child whose retired row has aged out of the ring gets a fresh row keyed by the
// SendMessage. Either way `taskId` carries the runtime id, which is what every completion
// notification correlates on (`<task-id>`) — and for the freshly-keyed case the notification's
// `<tool-use-id>` is the SendMessage's own id, so both correlation paths land.
//
// `startedAt` is the RESUME instant, not the original dispatch: this is a new run, and the elapsed
// reading on the board should measure it rather than the dead gap before it.
function trackResumes(state: TailState, rec: Record): void {
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; tool_use_id?: unknown; content?: unknown }
    if (b.type !== "tool_result") continue
    const id = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined
    if (!id) continue
    // Consume the parked summary whatever the result turns out to be — an ordinary delivery must not
    // leave it to be picked up by some later, unrelated resume.
    const summary = state.pendingResumes?.get(id)
    state.pendingResumes?.delete(id)
    const ack = parseResumeAck(toolResultText(b.content))
    if (!ack) continue
    // Already live: the fold never lost this child (its terminal notification has not landed, or the
    // parent re-steered one that was still working). Reviving would double it.
    let live = false
    for (const e of state.subAgents.values()) if (matchesAgent(e, ack)) { live = true; break }
    if (live) continue
    const at = typeof rec.timestamp === "string" ? rec.timestamp : (state.lastActivityAt ?? "")
    // NEWEST match wins. `retireToRing` re-inserts on every retirement, so reverse insertion order is
    // most-recently-retired first — and a child that has been re-steered before can hold more than one
    // retired row (one per run whose original row had already aged out of the ring). Reading the oldest
    // of those would defeat the history guard below, which compares against exactly this row's death.
    const retiredRows = [...state.retiredSubAgents.values()]
    let retired: RetiredSubAgent | undefined
    for (let i = retiredRows.length - 1; i >= 0; i--) if (matchesAgent(retiredRows[i], ack)) { retired = retiredRows[i]; break }
    // REPLAYED HISTORY. A Claude transcript re-emits past records verbatim — the reproduction session
    // carries 65 duplicated uuids and replays five of these very restart acks, with their ORIGINAL
    // timestamps, some 1200 records after the fold already watched those children finish. An ack is
    // only a restart the FIRST time it is folded; folding it again would resurrect a child that
    // finished a day ago and leave it pulsing (then "stale") forever. This is the same class of
    // phantom the notification fold has leaked three times; it does not get to happen a fourth.
    //
    // The test is against the fold's own high-water mark, and deliberately NOT against the retired
    // row's `finishedAt`: that field can be stamped from the RUNTIME event clock (applyRuntimeTasks)
    // rather than from record timestamps, and comparing two clocks silently misfires — it rejected
    // every revival in the integration harness, where the two domains are hours apart. Record
    // timestamps compared to a mark built only from record timestamps is one clock, always. A
    // replayed record keeps its ORIGINAL timestamp so it lands far behind the mark; a genuine ack is
    // AT it. The slack covers ordinary out-of-order writes between sibling records — replays are
    // stale by minutes to days, so nothing near the boundary is ambiguous.
    const ackAt = at ? Date.parse(at) : Number.NaN
    const highWater = state.maxRecordAt ? Date.parse(state.maxRecordAt) : Number.NaN
    if (Number.isFinite(highWater) && Number.isFinite(ackAt) && highWater - ackAt > RESUME_REPLAY_SLACK_MS) continue
    if (retired) state.retiredSubAgents.delete(retired.toolUseId)
    const toolUseId = retired?.toolUseId ?? id
    // A restart SUPERSEDES the operator's retirement of the previous run. `SendMessage` revives a
    // stopped child under the SAME tool_use id, so without this the dismissal would outlive the run it
    // was aimed at: the row comes back here (correctly — it is live work again), and the next re-prime
    // silently deletes it, hiding a child that is genuinely running. The replay guard directly above is
    // what makes this safe to do unconditionally — only a GENUINE ack reaches this line.
    // Queued rather than written here: this is a pure fold function with no storage handle. Every tick
    // drains `unretiredOps` (drainUnretiredOps), which keeps every registry write on the one side of
    // the module that owns them.
    if (state.dismissedOps.delete(toolUseId)) (state.unretiredOps ??= new Set()).add(toolUseId)
    state.subAgents.set(toolUseId, {
      kind: "agent",
      toolUseId,
      label: retired?.label ?? summary ?? "sub-agent",
      startedAt: at,
      subagentType: retired?.subagentType,
      outputFile: ack.outputFile ?? retired?.outputFile,
      outputFormat: retired?.outputFormat,
      taskId: ack.agentId,
    })
  }
}

// RETIRE a tracked sub-agent when its <task-notification> reports a TERMINAL status: move it OUT of the
// live map (so banner/counts/spinner stop showing it) and INTO the bounded retained ring (so the
// drill-in drawer can still resolve its transcript for review). Notifications ride THREE record shapes
// (all must be handled — missing the second leaked 20+ phantom "running" sub-agents on a busy session,
// found 2026-07-09; missing the third leaked a stuck background shell whose completion arrived
// mid-turn, found 2026-07-22): (a) queue-operation records with a top-level `content` string,
// (b) USER records whose message.content (string, or text blocks) embeds the <task-notification> XML —
// the shape newer harness versions emit, and (c) `attachment` records (type:"queued_command") whose
// `attachment.prompt` carries it. Shape (c) is LOAD-BEARING, not redundant with (a): when a shell
// completes MID-TURN the harness enqueues the notification and flushes the queue-operation bookkeeping
// (a) at a FILE POSITION that PRECEDES the launch's own assistant record — so we fold that completion
// before the shell is even registered (no live entry → no-op) and it is lost. The `attachment` (c) is
// written INLINE when the queued item is injected, always AFTER the launch, so it is the only
// reliably-ordered completion carrier for that race. A record can carry multiple notification blocks;
// each is retired independently. A task-id can notify more than once (a resumed background agent
// re-notifies) and a non-terminal "running" ping exists too, so only completed/failed/killed retire
// the entry. Idempotent: a repeat terminal notify (the same completion arriving via both (a) and (c))
// finds nothing live to move (no-op).
function notificationText(rec: Record): string | undefined {
  if (typeof rec.content === "string") return rec.content
  if (typeof rec.attachment?.prompt === "string") return rec.attachment.prompt
  const c = rec.message?.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    const text = c
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .join("\n")
    return text || undefined
  }
  return undefined
}

function trackCompletions(state: TailState, rec: Record): void {
  const raw = notificationText(rec)
  if (!raw || !raw.includes("<task-notification>")) return
  // REPORT-DELIVERY BOOKKEEPING RUNS FIRST, and deliberately BEFORE the early-return below.
  //
  // That guard exists because retiring needs a live/retired row to correlate against. Delivery
  // accounting needs no such row: what it tracks is whether the notification's TEXT ever reached the
  // model, which is true or false regardless of what frizz happens to have in its maps. Running it
  // after the guard would silently skip exactly the notifications that arrive when the maps are empty
  // — which, on a busy orchestrator whose children have all been retired already, is a great many.
  trackReportDelivery(state, rec, raw)
  // A RETIRED child still anchors a live branch (see anchorRoots), and the descendants hanging off it
  // notify through here too — so an empty live map alone no longer means there is nothing to correlate.
  if (state.subAgents.size === 0 && state.retiredSubAgents.size === 0) return
  for (const block of raw.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    const status = block.match(/<status>([^<]*)<\/status>/)?.[1]
    // completed/failed/killed are the natural terminals. `stopped` is the RECOVERY notification a NEW
    // session emits for background ops the PREVIOUS process left with no completion record ("… have been
    // marked stopped") — the owning process is gone, so it is just as terminal; map it to killed.
    // Dropping it (the old guard did) is exactly why an orphaned sub-agent lingered as `stale` and an
    // orphaned background shell — which has NO staleness clock — pulsed "running" forever, re-derived
    // identically on every restart (found 2026-07-23 on real nub threads). A non-terminal "running" ping
    // still retires nothing.
    // A Monitor that hits its timeout_ms emits ONE notification carrying NO <status> (and no
    // <tool-use-id>) — only an <event> with the harness's timeout sentinel. Without this the entry
    // dangles as "running" forever (0 of 2 timeout notifications carried a status, session 54b37ebe).
    // Key STRICTLY on the sentinel: ordinary Monitor progress events also have <event> and no <status>,
    // so "missing status ⇒ terminal" would retire every live monitor on its first event. The sentinel
    // is harness-emitted prose and could drift — same fragility as the launch-ack strings we already
    // depend on ("Command running in background with ID:", "Monitor started (task").
    const monitorTimedOut = block.includes("<event>[Monitor timed out")
    const terminal: "completed" | "failed" | "killed" | undefined =
      status === "completed" || status === "failed" || status === "killed" ? status : status === "stopped" || monitorTimedOut ? "killed" : undefined
    if (!terminal) continue
    // ONE block can list MANY ops — the recovery notification names every orphan at once — and it may
    // carry tool-use-ids, only task-ids, or both (the recovery shape omits tool-use-ids entirely). Retire
    // EVERY correlated live entry, not just the first: the old single-.match() left all-but-one live, so a
    // 3-agent recovery still leaked 2. Dedupe (a tool-use-id and a task-id can name the same entry) and
    // collect before retiring, since retireLive mutates the map findLiveByTaskId scans.
    const doomed = new Set<SubAgentEntry>()
    for (const m of block.matchAll(/<tool-use-id>([^<]*)<\/tool-use-id>/g)) {
      const entry = state.subAgents.get(m[1])
      if (entry) doomed.add(entry)
    }
    const stampedAt = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : Number.NaN
    for (const m of block.matchAll(/<task-id>([^<]*)<\/task-id>/g)) {
      if (m[1].startsWith("__orphan_summary__")) continue // internal scan sentinel — correlates to nothing
      const entry = findLiveByTaskId(state, m[1])
      if (entry) doomed.add(entry)
      // Nothing live under this task id. For a DIRECT child that just means the notify is a repeat of
      // one already folded; for a DESCENDANT it is the branch's only rest signal, and there is no way
      // to tell the two apart from here (a descendant is not tracked, so its absence looks identical).
      // Recording both is safe: only a depth>=2 sidecar is ever measured against this map, and a
      // direct child's id simply never gets looked up in it.
      else if (Number.isFinite(stampedAt)) recordDescendantTerminal(state, m[1], stampedAt)
    }
    for (const entry of doomed) retireLive(state, entry, typeof rec.timestamp === "string" ? rec.timestamp : undefined, terminal)
  }
}

// Account for whether each terminal completion report actually reached the MODEL, as opposed to merely
// being accepted into the runtime's queue. See report-delivery.ts for why those are different things
// and for the corpus that showed a third of them never making the second hop.
//
// Only TERMINAL reports are tracked: a non-terminal "running" ping carries no report to lose, and a
// Monitor progress event is not a sub-agent report at all.
function trackReportDelivery(state: TailState, rec: Record, raw: string): void {
  const modelFacing = isModelFacingCarrier(rec.type)
  const at = typeof rec.timestamp === "string" ? rec.timestamp : undefined
  for (const block of raw.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    const status = block.match(/<status>([^<]*)<\/status>/)?.[1]
    if (status !== "completed" && status !== "failed" && status !== "killed") continue
    // A failed/killed child has no findings to lose — its notification is a status line, not a report
    // (measured: every `failed` in the corpus was 46–384 chars of "the agent errored"). Repairing those
    // would spam the agent with pointers to transcripts that say nothing.
    if (status !== "completed") {
      for (const id of blockTaskIds(block)) state.queuedReports.delete(id)
      continue
    }
    // WHOSE op is this? A descendant's completion is not ours to repair — the agent that is actually
    // blocked on it is the child, and injecting it here tells THIS agent it lost work it never started
    // and re-invokes it for a result it cannot use. Self-healing on purpose: a foreign id already parked
    // (by a build before this gate, or by a block that carried no tool-use-id) is dropped on sight.
    //
    // NO tool-use-id ⇒ treat as ours, deliberately. That is the RECOVERY shape — the notification a new
    // session emits for ops the previous process orphaned — which carries no per-op tool call and is by
    // construction about this session's own work. Measured on the corpus, every ordinary `completed`
    // notification carries one, so this branch costs the gate nothing.
    const owner = block.match(/<tool-use-id>([^<]*)<\/tool-use-id>/)?.[1]?.trim()
    if (owner && !state.ownedToolUseIds.has(owner)) {
      for (const id of blockTaskIds(block)) state.queuedReports.delete(id)
      continue
    }
    const parsed = parseReportBlock(block, at, blockTaskIds(block)[0] ?? "")
    for (const id of blockTaskIds(block)) {
      if (modelFacing) {
        state.deliveredReports.add(id)
        state.queuedReports.delete(id)
        continue
      }
      // Both kinds are tracked. An AGENT's findings exist only inside the notification, so losing it
      // is a total loss of content; a SHELL's output survives on disk, but the WAKE it carries does
      // not — and a rested agent whose build finished and was never told just sits there, which is
      // the louder failure of the two (383 of 421 shell notifications lost on one real thread).
      if (!reportKind(parsed.summary, id)) continue // neither shape — not ours to repair
      if (state.deliveredReports.has(id)) continue // already read it; a late queue-op must not re-park
      state.queuedReports.set(id, { taskId: id, ...parsed })
    }
  }
  boundReportMaps(state)
}

// A repair frizz injected is a plain user record, so the notification fold above never sees it. This is
// what makes the repair idempotent across a re-fold without persisting anything — see report-delivery.
function trackRelayEchoes(state: TailState, rec: Record): void {
  if (!isModelFacingCarrier(rec.type)) return
  const text = notificationText(rec)
  if (!text) return
  for (const id of relayedTaskIds(text)) {
    state.deliveredReports.add(id)
    state.queuedReports.delete(id)
  }
  boundReportMaps(state)
}

// One entry per op-launching tool call this session has ever made, so it grows with the TRANSCRIPT
// rather than with what is live, and it rides the cached tail state on every write. Measured on the
// heaviest thread on this machine (three days, 1466 sub-agents): 8,647 ids ≈ 279 KB encoded, against
// 12,094 ≈ 390 KB had this recorded every tool call.
//
// The cap is ~3x that, because eviction is not free — an evicted id reads as foreign, so the only
// thing a too-small cap can cost is a repair that should have happened. It can never mint a wrong one,
// and that asymmetry is the whole point: a missed repair leaves the agent exactly where it already was,
// while a wrong one hands it another agent's work and re-invokes it to act on it.
const MAX_OWNED_TOOL_USE_IDS = 25_000
function rememberOwnedToolUse(state: TailState, id: string): void {
  state.ownedToolUseIds.add(id)
  while (state.ownedToolUseIds.size > MAX_OWNED_TOOL_USE_IDS) {
    const oldest = state.ownedToolUseIds.values().next().value
    if (oldest === undefined) break
    state.ownedToolUseIds.delete(oldest)
  }
}

// Both structures are unbounded in principle (one entry per child, and a long-running orchestrator
// dispatches hundreds), so trim oldest-first. `queuedReports` is insertion-ordered by queue time.
function boundReportMaps(state: TailState): void {
  while (state.queuedReports.size > MAX_TRACKED_REPORTS) {
    const oldest = state.queuedReports.keys().next().value
    if (oldest === undefined) break
    state.queuedReports.delete(oldest)
  }
  while (state.deliveredReports.size > MAX_TRACKED_REPORTS * 4) {
    const oldest = state.deliveredReports.values().next().value
    if (oldest === undefined) break
    state.deliveredReports.delete(oldest)
  }
}

// A manual `TaskStop` is a first-class STOP event, symmetric with the launch `tool_use` that started
// the op. Its structured result confirms "Successfully stopped task: <id>" and carries the runtime
// `task_id` — the SAME id captured at launch, and the ONLY correlation key a manual stop exposes (it
// has no tool_use id). This is the signal that retires a shell/agent killed by hand — the one the
// board previously never saw, leaving a phantom pulsing row until the process owning it died.
function stoppedTaskId(text: string): string | undefined {
  // Guard on the success confirmation so a failed/no-op stop never retires a still-live row, then read
  // the structured task_id field (the first match is the real field — it precedes `command` in the JSON).
  if (!/Successfully stopped task/.test(text)) return undefined
  return text.match(/"task_id"\s*:\s*"([^"]+)"/)?.[1]
}

function trackStops(state: TailState, rec: Record): void {
  if (state.subAgents.size === 0) return
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; content?: unknown }
    if (b.type !== "tool_result") continue
    const taskId = stoppedTaskId(toolResultText(b.content))
    if (!taskId) continue
    const entry = findLiveByTaskId(state, taskId)
    if (!entry) continue // already retired by its own notification, or never tracked — safe no-op
    retireLive(state, entry, typeof rec.timestamp === "string" ? rec.timestamp : undefined, "killed")
  }
}

// The defensive parse of the untrusted `input.questions` payload lives in @frizz/shared
// (parseAskUserQuestionInput), so this safety net and the transcript projector's read-only question
// card can never cap or shape the same tool call differently.
// Capture a PENDING native AskUserQuestion: an AskUserQuestion tool_use whose tool_result hasn't landed
// yet freezes the session at a TUI dialog. Same correlation pattern as sub-agent tracking (keyed by
// tool_use id). Cleared by clearAskOnResult when the matching tool_result arrives.
function trackAsk(state: TailState, rec: Record): void {
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; name?: string; id?: unknown; input?: unknown }
    if (b.type !== "tool_use" || b.name !== "AskUserQuestion") continue
    const id = typeof b.id === "string" ? b.id : undefined
    if (!id) continue
    const questions = parseAskUserQuestionInput(b.input)
    if (questions.length) state.pendingAsk = { id, questions }
  }
}
// Clear the pending ask once its tool_result lands (the human answered in the terminal).
function clearAskOnResult(state: TailState, rec: Record): void {
  const pending = state.pendingAsk
  if (!pending) return
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; tool_use_id?: unknown }
    if (b.type === "tool_result" && b.tool_use_id === pending.id) {
      state.pendingAsk = undefined
      return
    }
  }
}

// Fold one record into the running derivation. Only assistant/user records are "substantive" (they
// move the turn state); assistant/user/system records with a timestamp advance lastActivityAt.
export function applyRecord(state: TailState, rec: Record): void {
  const type = rec.type
  // A `type:"user"` record with promptSource:"system" is a peer (SendMessage) message or a sub-agent
  // <task-notification> — NOT a human turn. It DOES re-invoke the agent (the model wakes to process
  // it), so it moves the TURN to in-flight (shimmer during the resume) and advances lastActivityAt like
  // any record. What it must NOT do is bump `lastUserAt` — the ROW-ORDER key — because that would jump
  // the row to the top from motion the human didn't cause. (An earlier fix over-suppressed the turn
  // flip too, which made a thread look IDLE/stalled while the agent was actually resuming after a
  // sub-agent returned — no shimmer, then a message appeared out of nowhere. Found 2026-07-09.)
  const systemUserRec = type === "user" && rec.promptSource === "system"
  // Native slash commands can append a type:user,isMeta:true reminder without invoking the model.
  // Treating that as a real user record leaves an idle session falsely in-flight forever because no
  // assistant record follows. It is sidecar metadata: no activity, turn, fence, or row-order change.
  const metaUserRec = type === "user" && rec.isMeta === true
  // After compacting, claude injects the carry-over summary as an ORDINARY user record (no isMeta, no
  // promptSource) — so without this it reads as the human typing a 20 000-character message, which jumps
  // the row to the top of the board on motion the human never caused. It IS a re-invoking record (the
  // model resumes from the summary), so it keeps the in-flight flip; it just may not touch lastUserAt.
  const compactSummaryRec = type === "user" && rec.isCompactSummary === true
  // ...and it is also the ONLY place a Claude transcript says a compaction just happened in a record the
  // fold already reads, which makes it the post-compaction trigger's clock (scheduler SOURCE 7). It moves
  // nothing else — see the flag's own note above for why this record must not read as human motion.
  if (compactSummaryRec && typeof rec.timestamp === "string") state.lastCompactionAt = rec.timestamp
  if (typeof rec.timestamp === "string" && (type === "assistant" || (type === "user" && !metaUserRec) || type === "system")) {
    state.lastActivityAt = rec.timestamp
  }
  // The high-water mark takes EVERY timestamped record and only ever advances (see TailState). A plain
  // string compare, not Date.parse: these are all `toISOString()` output, so lexicographic order IS
  // chronological order, and this runs on every record of every transcript at boot.
  if (typeof rec.timestamp === "string" && (state.maxRecordAt === undefined || rec.timestamp > state.maxRecordAt)) {
    state.maxRecordAt = rec.timestamp
  }
  if (type === "permission-mode") {
    const parsed = PermissionMode.safeParse(rec.permissionMode)
    if (parsed.success) {
      state.permissionMode = parsed.data
      state.permissionModeRevision = (state.permissionModeRevision ?? 0) + 1
    }
  } else if (type === "assistant") {
    state.sawRecords = true
    state.lastKind = "assistant"
    // The model spoke, so whatever was interrupted is history — the stop_reason below is the turn signal
    // again. Cleared here and on any non-interrupt user record so the flag only ever describes the LAST
    // substantive record, exactly like lastKind.
    state.interrupted = undefined
    // The agent's OWN output timestamp = the rest-time key. For an at-rest thread the last assistant
    // record IS its final resting message; unlike lastActivityAt this never moves from a sub-agent's
    // completion notification (a promptSource:system USER record), so the queue never reshuffles on
    // background-child motion. tool_result echoes are `type:user`, not assistant, so they don't bump it.
    if (typeof rec.timestamp === "string") state.lastAssistantAt = rec.timestamp
    state.lastStopReason = typeof rec.message?.stop_reason === "string" ? rec.message.stop_reason : undefined
    // Claude records the actual resolved model on every assistant message. It does NOT record the
    // launch effort, so that half continues to come from the persisted dispatch profile. Ignore the
    // synthetic placeholder some generated/error records use rather than overwriting a real model.
    const observedModel = typeof rec.message?.model === "string" ? rec.message.model.trim() : ""
    if (observedModel && observedModel !== "<synthetic>") {
      state.model = observedModel
      state.profileAt = typeof rec.timestamp === "string" ? rec.timestamp : undefined
      state.profileRevision = (state.profileRevision ?? 0) + 1
    }
    // How full the model's context is, straight off the API's own accounting for this request. The
    // three input components sum to exactly what the request carried: fresh input, the prefix newly
    // written to cache, and the prefix read back from it. Output tokens are excluded — they are not in
    // the context until the NEXT request quotes them back, at which point they arrive inside these
    // three. Guards, in order: a synthetic error record carries no real usage; a sidechain record is a
    // CHILD's context, not this thread's; and a record whose components are all absent must leave the
    // previous reading alone rather than assert zero. A compaction shows up here for free — the next
    // request is genuinely smaller, so the reading simply drops.
    const usage = rec.isApiErrorMessage === true || rec.isSidechain === true ? undefined : rec.message?.usage
    if (usage && typeof usage === "object") {
      const part = (key: string): number | undefined => {
        const value = usage[key]
        return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
      }
      const input = part("input_tokens")
      const created = part("cache_creation_input_tokens")
      const read = part("cache_read_input_tokens")
      if (input !== undefined || created !== undefined || read !== undefined) {
        state.contextTokens = (input ?? 0) + (created ?? 0) + (read ?? 0)
      }
    }
    const raw = lastTextBlock(rec.message?.content)
    // Runtime auth classifier (claude-auth plan): claude records a rejected credential as a SYNTHETIC
    // assistant record (isApiErrorMessage:true, model "<synthetic>") whose text is the 401/login
    // recovery line. Keying on the synthetic flag makes user-authored or quoted "401" text
    // structurally unable to trigger the fault; the text conjunction keeps other API errors
    // (overloaded, rate-limit) from reading as auth. A later REAL assistant text clears it —
    // a genuine response is proof the credential works again.
    if (rec.isApiErrorMessage === true) {
      if (raw !== undefined && isClaudeAuthErrorText(raw)) state.authFault = "authentication_rejected"
    } else if (raw !== undefined) {
      state.authFault = undefined
    }
    // The SAME channel read at its most general: this record is a failed turn, whatever category it
    // falls into. The two classifiers around it are deliberately narrow, so an error that is neither an
    // auth rejection nor a rate limit used to leave no trace at all — and a synthetic error record still
    // advances `lastAssistantAt` above, which is what makes a permanently failing thread look to every
    // consumer like an agent resting after a turn. Cleared by the next real assistant text, exactly as
    // authFault is: a genuine response is proof the turn reached the model.
    if (rec.isApiErrorMessage === true) {
      state.apiFault = true
    } else if (raw !== undefined) {
      state.apiFault = undefined
    }
    // Subscription usage-limit classifier (auto-resume): the SAME synthetic-record channel, keyed on
    // the structured `error:"rate_limit"` category rather than any text match. The limit is what cut
    // this turn off mid-work, so the fault standing on the tail IS "this agent was running when the
    // window ran dry" — the set the scheduler later continues. A REAL assistant text clears it (the
    // provider is serving again); a user record clears it below (the human — or our own delivered
    // "continue" — has already moved the thread on, which is what makes the wake idempotent).
    if (rec.isApiErrorMessage === true) {
      const limit = classifyLimitRecord(rec, raw)
      if (limit && typeof rec.timestamp === "string") {
        state.limitFault = { window: limit.window, at: rec.timestamp, resetClock: limit.resetClock, model: limit.model }
      }
    } else if (raw !== undefined) {
      state.limitFault = undefined
    }
    if (raw !== undefined) {
      const preview = previewText(raw)
      if (preview !== undefined) state.lastAssistant = preview
      // Track whether THIS (now the latest) assistant text carries an unanswered question fence.
      state.lastAssistantHasQuestion = hasQuestionBlock(raw)
      // Same lifecycle for the stop-hook sentinel: it only means "nothing actionable" while it
      // is the FINAL word, so a later assistant text that omits it re-opens the loop by itself.
      state.lastAssistantAllDone = saysAllDone(raw)
      // Recompute the done/awaiting signal fence from THIS text — an assistant text with no fence
      // clears it (the fence only signals while it is the final message). Same lifecycle as the
      // question flag: set per assistant text, cleared by any user record below.
      state.lastFence = parseSignalFence(raw)
    }
    trackDispatches(state, rec) // register any background Agent dispatches + background shells
    trackAsk(state, rec) // capture a pending native AskUserQuestion (frozen at a TUI dialog)
  } else if (type === "user" && !metaUserRec) {
    state.sawRecords = true
    // A user record — human turn, tool_result, OR a re-invoking system record (peer/notification) —
    // flips the turn to IN-FLIGHT: the model is about to respond, so the thread reads as WORKING
    // (shimmer), not idle. This is what shows motion while an agent resumes after a sub-agent returns.
    state.lastKind = "user"
    state.lastStopReason = undefined
    // …with ONE exception, and it is the reason this flag exists: the runtime's own
    // `[Request interrupted by user]` receipt is a user record that means the OPPOSITE of a prompt. The
    // turn it names was cut short and the model will write nothing more until new input arrives, so
    // reading it as "about to respond" left an abandoned thread spinning on the board until the next
    // reboot (maintainer 2026-08-23, on a nub thread interrupted mid-tool and never resumed: "looks
    // frozen" — 23 hours in the Active band with an idle worker behind it).
    const userText = lastTextBlock(rec.message?.content) ?? ""
    state.interrupted = isInterruptMarker(userText) || undefined
    // A newer user record supersedes any pending chat question / excusal fence (they only signal as the
    // FINAL message); the NEXT assistant record recomputes them.
    //
    // …EXCEPT the question, which is a HUMAN GATE and can only be discharged by the human. The other two
    // are the agent's claims about ITSELF — re-invoked, it is no longer done and no longer parked, so any
    // record that wakes it supersedes them honestly. An unanswered question is the opposite: it is an
    // obligation on the reader, and nothing frizz injects on the agent's behalf pays it off. Clearing it
    // on ANY user record meant a task-notification, a wake pulse or a bare tool_result — none of which
    // the chat even renders — silently emptied the queue's evidence that the human was being waited on,
    // while the same record flipped the turn in-flight. The thread then drew its ```question card AND the
    // working shimmer, in the Active rail instead of the queue (maintainer 2026-08-24: "this needs to be
    // structurally impossible"). isHumanSpeaking asks the question the CHAT asks, off the SHARED
    // classifier, so the two projections cannot drift again.
    state.lastAssistantAllDone = false
    state.lastFence = undefined
    const humanSpoke = isHumanSpeaking(rec, userText, systemUserRec, compactSummaryRec)
    if (humanSpoke) state.lastAssistantHasQuestion = false
    // Any user record supersedes a usage-limit pause: the conversation has moved past the point where
    // it was cut off, whether by the human or by the "continue" the wake scheduler delivered. This is
    // precisely what makes the auto-resume one-shot — the delivered message erases the very fault that
    // selected the thread. If the window is still dry, the provider simply writes a NEW limit record
    // (with a NEW, later reset instant), so a re-fire can never tighten into a loop.
    state.limitFault = undefined
    // `lastUserAt` is the ROW-ORDER key — bump it ONLY for a genuine HUMAN interaction. A tool_result
    // is agent activity; a system record (peer/notification), an injected pulse and the runtime's own
    // interrupt receipt are machine motion the human didn't cause — none of them may jump the row to the
    // top (the one part of the earlier over-fix that WAS a real bug). Same predicate as the question
    // gate above, deliberately: "did the human take a turn" has exactly one answer per record.
    if (humanSpoke && typeof rec.timestamp === "string") {
      state.lastUserAt = rec.timestamp
      // SET ONCE. This is what names an external session whose harness never named it, so it has to be
      // the turn the conversation STARTED on, not the newest one.
      if (state.firstUserText === undefined) {
        const text = userMessageText(rec.message?.content).trim()
        if (text) state.firstUserText = text.slice(0, FIRST_USER_TEXT_MAX)
      }
    }
    trackLaunchResults(state, rec) // resolve a background dispatch's transcript path from its launch result
    trackResumes(state, rec) // a SendMessage that RESTARTED a stopped child is a fresh launch — revive it
    trackStops(state, rec) // a manual TaskStop is a terminal signal — retire the op it killed
    clearAskOnResult(state, rec) // the AskUserQuestion answer landed → clear the pending ask
  } else if (type === "ai-title") {
    // Sidecar record carrying Claude's own auto-generated session title. Emitted repeatedly (often
    // identical) as the session evolves — take the latest non-empty. Never touches turn state.
    if (typeof rec.aiTitle === "string" && rec.aiTitle.trim()) state.aiTitle = rec.aiTitle.trim()
  } else if (type === "custom-title") {
    // Written by /rename (bare /rename auto-generates a slug; /rename <name> sets it). Keep it in a
    // dedicated observation slot only: the rename controller must confirm the readable second record
    // and atomically persist it before any board/file surface changes. Promoting an intermediate or
    // mismatched record to aiTitle leaked rejected slugs into the UI and paired .frizz files.
    if (typeof rec.customTitle === "string" && rec.customTitle.trim()) {
      state.customTitle = rec.customTitle.trim()
      state.customTitleRevision++
    }
  }
  // all other types (attachment, queue-operation, last-prompt, mode,
  // bridge-session, file-history-snapshot, system) are sidecar metadata — ignored for turn state.
  // Sub-agent completion rides queue-operation AND attachment records (each a <task-notification>
  // carrier — see notificationText), so it's checked for EVERY record regardless of type (the helper
  // self-guards on shape + tracked ids).
  trackCompletions(state, rec)
  // A repair frizz injected earlier carries no <task-notification>, so it needs its own pass.
  trackRelayEchoes(state, rec)
}

// Derive the final-message-dependent fields (preview + question flag + done/awaiting fence) from the
// text of a FINAL assistant message. Shared by assistant-text{final:true} and turn-end.finalText so
// the same derivation lands whichever event a backend carries the final answer on. Mirrors the
// assistant-text arm of applyRecord — minus Claude's every-block fence recompute (a normalized
// backend fences only on the final message; a codex `commentary` block must never excuse the thread).
function applyFinalText(state: FoldState, text: string): void {
  const preview = previewText(text)
  if (preview !== undefined) state.lastAssistant = preview
  state.lastAssistantHasQuestion = hasQuestionBlock(text)
  state.lastAssistantAllDone = saysAllDone(text)
  state.lastFence = parseSignalFence(text)
}

// Fold one NORMALIZED event into the backend-neutral accumulator — the codex-facing counterpart to
// applyRecord (which folds raw Claude records). A backend whose turn model maps cleanly onto
// NormalizedEvent (codex's explicit task_started/task_complete brackets) drives its fold as
// `for (const ev of parseLine(line)) applyEvent(state, ev)`; it produces the SAME FoldState fields
// applyRecord does, so the tailer/board consume either identically. Claude does NOT use this path —
// its 3-way stop_reason + 5s backstop turn signal can't round-trip through the union without loss
// (see the NOTE on NormalizedEvent in backend/types.ts).
export function applyEvent(state: FoldState, ev: NormalizedEvent): void {
  // Every timestamped event advances the activity clock (events map 1:1 to substantive lines; only the
  // untimestamped `title` lacks an `at`). Folded in file order, so the latest `at` wins. `context-usage`
  // is the exception: it is telemetry that always RIDES a real event which moves the clock itself, so
  // letting it move the clock would only add a way for pure bookkeeping to mask a stall.
  if ("at" in ev && typeof ev.at === "string" && ev.kind !== "context-usage") state.lastActivityAt = ev.at
  switch (ev.kind) {
    case "provider-error":
      state.sawRecords = true
      if (ev.error.retrying) break
      state.turn = "idle"
      state.apiFault = true
      state.providerError = ev.error
      state.lastAssistant = ev.error.message
      state.lastFence = undefined
      state.lastAssistantAllDone = false
      state.lastAssistantHasQuestion = false
      if (typeof ev.at === "string") state.lastAssistantAt = ev.at
      break
    case "turn-start":
      // A turn opened → the agent is working.
      state.sawRecords = true
      state.turn = "in-flight"
      break
    case "turn-end":
      // A turn bracketed closed → idle. finalText (when the backend carries the final message on the
      // bracket) is authoritative: (re)derive preview + question/excusal fence from it. The bracket's
      // `at` is the agent's rest time — the queue/at-rest-label key (see NormalizedTail.lastAssistantAt).
      state.sawRecords = true
      state.turn = "idle"
      if (typeof ev.at === "string") state.lastAssistantAt = ev.at
      if (ev.finalText !== undefined || ev.successful) {
        state.apiFault = undefined
        state.providerError = undefined
      }
      if (ev.finalText !== undefined) applyFinalText(state, ev.finalText)
      break
    case "assistant-text":
      // Streamed assistant text. The FINAL answer sets preview + question/excusal fence; a non-final
      // (commentary) block only refreshes the row preview and must NOT carry a fence. Turn state is
      // untouched — the turn brackets on turn-start/turn-end, not on a text block. A FINAL block's `at`
      // is the agent's own output time → the rest-time key (turn-end usually carries the same instant).
      state.sawRecords = true
      state.apiFault = undefined
      state.providerError = undefined
      if (ev.final) {
        if (typeof ev.at === "string") state.lastAssistantAt = ev.at
        applyFinalText(state, ev.text)
      } else {
        const preview = previewText(ev.text)
        if (preview !== undefined) state.lastAssistant = preview
      }
      break
    case "user-message":
      // A human/peer/notification turn re-opens the turn (the model is about to respond → in-flight)
      // and supersedes the agent's own claims about itself — the excusal fence and the ALLDONE
      // sentinel only signal as the FINAL message, and a re-invoked agent is neither done nor parked.
      // Only a GENUINE human turn bumps lastUserAt — a synthetic one (peer msg / notification /
      // tool-result echo) is machine motion the human didn't cause, so it never jumps the row.
      state.sawRecords = true
      state.turn = "in-flight"
      state.lastAssistantAllDone = false
      state.lastFence = undefined
      if (!ev.synthetic) {
        // …and the QUESTION is the human's to discharge, so it rides the same gate as the row-order
        // key rather than clearing unconditionally. Codex's twin of the claude defect in applyRecord:
        // a synthetic turn that nobody typed was answering the agent's question on the human's behalf,
        // which put the row back in the Active rail with its ```question card still on screen.
        state.lastAssistantHasQuestion = false
        if (typeof ev.at === "string") state.lastUserAt = ev.at
        // Keep the delivery-confirmation pair atomic. A genuine non-text user event may still bump
        // row activity, but its newer timestamp must never retain text from an older human turn.
        state.lastUserText = typeof ev.text === "string" ? ev.text : undefined
        if (state.firstUserText === undefined && typeof ev.text === "string" && ev.text.trim()) {
          state.firstUserText = ev.text.trim().slice(0, FIRST_USER_TEXT_MAX)
        }
      }
      break
    case "tool-call":
    case "tool-result":
      // Agent activity mid-turn: it advanced the activity clock (above) but doesn't move the turn
      // (still bracketed in-flight) or the preview. Codex's sub-agent tracking rides its own per-line
      // seam (codex-subagents.ts) rather than this union, since a CHILD's lifecycle is a different axis
      // from this session's turn — and codex has no background-shell concept at all;
      // Claude's rich tool tracking rides applyRecord, never this path. NOTE (deliberate divergence
      // from applyRecord's user arm): a tool-result does NOT clear lastFence/lastAssistantHasQuestion —
      // tool activity is mid-turn (a user-message re-open already cleared any prior-turn fence, and the
      // final message recomputes it), so a normalized backend must not let tool motion excuse a fence.
      state.sawRecords = true
      break
    case "agent-report":
    case "agent-instruction":
      // A CHILD reported upward, or another agent instructed this one (codex inter-agent
      // agent_message). It is real session motion — the
      // activity-clock bump above is the point, since a parent that spends an hour waiting on children
      // is working, not stalled — but it is inter-agent traffic, so it moves nothing else: not the turn
      // (the arrival does not open one; codex records `trigger_turn:false` and brackets any
      // real wake with its own task_started), not the preview or fence (those belong to THIS agent's
      // final message), and neither rest-time key. The child's own lifecycle rides codex-subagents.ts.
      state.sawRecords = true
      break
    case "title":
      // The backend's own session auto-title (codex thread title / Claude ai-title). Never touches turn.
      state.aiTitle = ev.title
      break
    case "compaction":
      // The harness rewrote the context. It is real session motion (codex spends ~100s in it with no
      // other record, which is exactly the silence a stall read would misjudge — hence the activity-clock
      // bump above), but it is the HARNESS's work, not the agent's: it brackets no turn, produces no
      // text, and must never move the preview, the fence, or the row-order key. Rendering is the
      // transcript projection's job (a compaction divider); the fold only needs to not be fooled by it.
      // The one thing it DOES set is the post-compaction trigger's clock (scheduler SOURCE 7) — codex's
      // half of what `isCompactSummary` gives the Claude fold.
      state.sawRecords = true
      if (typeof ev.at === "string") state.lastCompactionAt = ev.at
      break
    case "context-usage":
      // Pure telemetry — see the activity-clock note above. Read by the transcript projection (which
      // brackets a compaction with the readings either side of it) and by the footer's fullness
      // readout. The window is latched rather than overwritten-to-absent: codex names it on every
      // token_count, but a build that stops doing so must not silently erase a real reading.
      state.contextTokens = ev.tokens
      if (ev.window !== undefined) state.contextWindow = ev.window
      break
  }
}

// Derive the turn state from the folded tail (see the header heuristic). `nowMs` drives only the
// unknown-stop-reason backstop; a clear end_turn/tool_use is time-independent.
// computeTurn's answer PLUS whether the "in-flight" it returned is real evidence or the 5s backstop
// still running out. Only the backstop case is a guess, and it is the only case a runtime turn signal
// is permitted to short-circuit (see resolveRuntimeTurn in backend/claude-runtime-ingest.ts).
export function computeTurnDetailed(state: TailState, nowMs: number): { turn: TurnState; backstopped: boolean } {
  if (state.lastKind === "assistant") {
    if (state.lastStopReason === "end_turn") return { turn: "idle", backstopped: false }
    if (state.lastStopReason === "tool_use") return { turn: "in-flight", backstopped: false }
    // unknown/missing stop_reason: only the 5s-silence backstop can call it idle
    const at = state.lastActivityAt ? Date.parse(state.lastActivityAt) : NaN
    if (Number.isFinite(at) && nowMs - at > IDLE_BACKSTOP_MS) return { turn: "idle", backstopped: false }
    return { turn: "in-flight", backstopped: true }
  }
  return { turn: computeTurn(state, nowMs), backstopped: false }
}

export function computeTurn(state: TailState, nowMs: number): TurnState {
  if (state.lastKind === "assistant") {
    if (state.lastStopReason === "end_turn") return "idle"
    if (state.lastStopReason === "tool_use") return "in-flight"
    // unknown/missing stop_reason: only the 5s-silence backstop can call it idle
    const at = state.lastActivityAt ? Date.parse(state.lastActivityAt) : NaN
    if (Number.isFinite(at) && nowMs - at > IDLE_BACKSTOP_MS) return "idle"
    return "in-flight"
  }
  // A backend that brackets turns EXPLICITLY never sets lastKind (codex: applyEvent writes `state.turn`
  // directly on task_started/task_complete and touches neither lastKind nor lastStopReason) — trust its
  // folded turn verbatim instead of clobbering it back to in-flight. This is BEHAVIOR-NEUTRAL for Claude:
  // applyRecord assigns lastKind on EVERY substantive record (tailer.ts:633/653) and never clears it, so
  // for Claude `lastKind === undefined` holds ONLY before any substantive record — and there `state.turn`
  // is still the newTailState "in-flight" the old fallthrough returned. For codex it makes the explicit
  // task_started/task_complete brackets authoritative (the fix: a folded `idle` survives the tick).
  if (state.lastKind === undefined) return state.turn
  // An INTERRUPT is the one user record that ENDS a turn rather than opening one (see applyRecord).
  // It gets the same 5s-silence treatment the unknown-stop-reason branch above uses, and for the same
  // reason: frizz interrupts as a FEATURE — "send now" cuts the turn short so the worker reads the
  // queue at once — and there the real prompt lands milliseconds later and re-opens the turn. Flipping
  // idle the instant the receipt appears would flash a rest through every send-now, and a rest is not
  // cosmetic here: it cards the row into the queue and can fire the sign-off nudge at a thread that
  // never stopped. An interrupt with NOTHING after it for 5s is what it looks like — a stopped thread.
  if (state.interrupted) {
    const at = state.lastActivityAt ? Date.parse(state.lastActivityAt) : NaN
    if (Number.isFinite(at) && nowMs - at > IDLE_BACKSTOP_MS) return "idle"
  }
  // last substantive record was a user prompt/tool_result → in-flight (the model is about to respond)
  return "in-flight"
}

// A compact change-key for a session's derived sub-agent view — lets the tick mark the board dirty
// on any add / removal / running→stale transition (a completion clears an entry WITHOUT touching
// lastActivityAt, so without this the suffix would linger until the next full reconcile).
function subAgentSignature(views: SubAgentView[]): string {
  return views.map((v) => `${v.label}\u0000${v.state}\u0000${v.startedAt}`).join("\u0001")
}

// Order-sensitive equality of two fresh-foreign sets (id order = mtime desc). A membership OR ordering
// change means the board's foreign rows changed → the tick marks itself dirty.
function sameForeign(a: { id: string }[], b: { id: string }[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false
  return true
}

export interface SubAgentLookup {
  outputFile?: string
  outputFormat?: "codex"
  state: "running" | "stale" | "done"
  direct: boolean
  taskId?: string
  // Lifecycle instants/outcome let the transcript RPC replace an Agent dispatch CALL's latency with
  // the CHILD's real runtime. Optional for descendants, whose sidecars do not carry a terminal row.
  startedAt?: string
  finishedAt?: string
  outcome?: "completed" | "failed" | "killed"
}

export interface Tailer {
  get(slug: string): SessionTelemetry | undefined
  // FOREIGN session ids (JSONL files in the project dir with no registry row — maintainer terminals)
  // whose transcript is FRESH (recent mtime): the board lists these as read-only session threads.
  // Keyed by session id (the thread id for a foreign thread IS its session id).
  foreignIds(): string[]
  // Which agent wrote a foreign thread's transcript. Additive and OPTIONAL so the many narrow fixtures
  // that hand-roll a Tailer keep compiling; absent reads as "claude", which is what every foreign
  // thread was before codex rollouts joined the scan. The board needs it for the row's provider badge —
  // and, more than cosmetically, because a codex session carries NO title record, so the row's name has
  // to fall back rather than wait for an `aiTitle` that is never coming.
  foreignBackend?(id: string): "claude" | "codex" | undefined
  // Drill-in drawer lookup: a tracked or retained sub-agent's transcript path + state, or undefined if
  // unknown (never dispatched, or aged out of the retained ring). The router maps undefined → "gone".
  // `outputFormat` tells the reader which schema the file is: absent = Claude JSONL, "codex" = the
  // child's codex rollout (a codex sub-agent is itself a codex thread).
  // `direct` marks the ONE case frizz can address a steer at: an Agent-tool child THIS thread's own
  // session dispatched and is still tracking live. A background shell, a retired child, and a
  // DESCENDANT (a grandchild, resolved through the sidecar index — its dispatch happened inside
  // another agent's process, so this session's CLI has never heard of its tool_use id) are all
  // readable but not addressable, and each reports direct:false so the router refuses rather than
  // firing a message that would silently land on the main thread instead.
  // `taskId` is the provider's session-wide background-task handle. Unlike `direct`, which controls
  // steer safety, it is available for descendants too and is what the SDK's stopTask accepts.
  subAgent(slug: string, id: string): SubAgentLookup | undefined
  // Resolve a child by its RUNTIME agent id — the identity an upward report names its sender with. The
  // paged transcript RPC folds a bounded window and therefore cannot always translate that id itself;
  // this answers for as long as the tailer tracks the child. Optional so a narrow test stub may omit it
  // (the projection then leaves the report unnamed, exactly as it would with nothing to resolve).
  subAgentByTaskId?(slug: string, taskId: string): { id: string; label: string } | undefined
  // The LIVE descendants of one sub-agent, deepest-first, as the `stopTask` handles that end them.
  // A stop names one task, so ending a sub-agent's work means naming its whole subtree — see the
  // implementation for the orphan-and-report-to-root failure this exists to close. Empty when the id
  // has no live fan-out. Optional for the same reason `dismissOp` is: a narrow test stub need not
  // have it, and a server without it degrades to the old stop-one-row behaviour.
  subAgentDescendantTasks?(slug: string, id: string): string[]
  // Read-only background-shell drawer lookup. Output content stays server-side until the scoped query.
  backgroundShell?(slug: string, id: string): { command?: string; outputFile?: string; state: "running" | "done" } | undefined
  // "Is the process that owned this thread's background ops gone?" — ONE authority for a question three
  // runtimes answer differently, already computed once per tick as `paneDead` (see paneDeadForRow): a
  // broker whose daemon record fails its pid probe, an app-server codex row frizz stopped, or a
  // pre-cutover row with no transport left, which answers dead by default.
  // Exposed because the TRANSCRIPT producers need it too. `bgShellViews` drops a dead owner's shells
  // from the board, but the ops strip is a UNION of that list and the transcript's own pending
  // background cards, so the board dropping a row merely moves it — the transcript side has to hear the
  // same fact (see projectRetiredBackgroundOps' ownerGone arm). Optional like its neighbours; a narrow
  // test stub omits it and every caller degrades to "not gone", which is the pre-existing behaviour.
  ownerGone?(slug: string): boolean
  // Manual dismiss of a live background op (the × on an op row): retire it from tracking as if a
  // terminal signal arrived. Returns false if it is not live (unknown id / already gone). Optional so
  // an older server without it degrades gracefully.
  dismissOp?(slug: string, id: string): boolean
  // Drop a session's in-memory tail state (registered + foreign) — called when its row is hard-deleted
  // (forgetSession) so a stale TailState bound to the gone transcript can't mis-tail a later same-slug
  // re-dispatch. A no-op for an unknown slug.
  forget(slug: string): void
  // Record the launch value after the controller has synchronously folded every sidecar written
  // during the handoff. Any later backend record remains authoritative (for example a model/version
  // that rejects or coerces a requested mode).
  notePermissionMode?(slug: string, permissionMode: PermissionMode): void
  /**
   * Derive current state immediately, then poll every POLL_MS. `onPrimeProgress` observes the FIRST
   * pass only, once per PRIME_PROGRESS_EVERY rows — a cold board of thousands of threads spends real
   * time in here, and the launcher waiting on /health needs to see that it is working, not wedged.
   */
  start(onPrimeProgress?: (done: number, total: number) => void): void
  stop(): void
  tick(): void // exposed for tests + boot; the adaptive poll (scheduleTick) calls it otherwise
  /**
   * "Something changed — re-read now." Coalesced and throttled to the same duty-cycle floor the
   * adaptive poll uses, so it is safe to call on every runtime event. Called by the Claude broker's
   * event ingest (backend/claude-runtime-ingest.ts); a tailer nobody nudges behaves exactly as before.
   * Optional for the same reason `dismissOp` is — a narrow test stub of this interface need not have it.
   */
  nudge?(): void
}

export interface TailerDeps {
  project: Project
  storage: Storage
  bus: Bus
  onChange: () => void // triggers a board rebuild when derived state changes (batched: ≤1/tick)
  // Reports the sessions whose JSONL advanced this tick (bytes consumed) — the exact signal that a
  // thread's rendered transcript may have changed. The /ws transcript producer uses it to push updates
  // to subscribed clients (replacing the client's 1.5s poll). Optional: unset = no transcript push.
  onTranscriptChange?: (slugs: string[]) => void
  now?: () => number // injectable clock (tests)
  // Injectable MONOTONIC clock, distinct from `now` because it measures ELAPSED work rather than
  // naming an instant — it is what PRIME_BUDGET_MS is spent against. Defaults to `performance.now`.
  // A test that asserts WHICH rows a tick primes has to pin this: the budget is real wall time, so on
  // a loaded machine it can pre-empt the very scheduling decision under test and the assertion fails
  // for a reason that has nothing to do with the scheduler.
  monotonicNow?: () => number
  paneDead?: (slug: string) => boolean // injectable liveness (tests)
  // Injectable broker-daemon liveness (tests); defaults to defaultBrokerDaemonAlive, which reads the
  // session's discovery record and probes its pid. A fixture that omits it gets `() => true` when the
  // project has no stateDir, i.e. the pre-existing `exited`-only behavior.
  brokerDaemonAlive?: (sessionId: string) => boolean
  sessionLogDir?: string // injectable transcript dir (tests); defaults to the Claude Code path
  codexHome?: string // injectable $CODEX_HOME (tests); where a codex sub-agent's child rollout is located
  mtimeMs?: (path: string) => number | undefined // injectable file mtime (tests); a sub-agent transcript's staleness clock
  /** Is a background shell still alive? EXACT, not a heuristic: a shell's stdout is redirected to its
   *  `<taskId>.output`, so whichever process holds that file open IS the shell. Returns undefined when
   *  liveness cannot be established (probe unavailable, path unknown) — never a guess. Injectable for
   *  tests; the default shells out to `lsof`. */
  shellAlive?: (outputFile: string) => boolean | undefined
  // The agent backend that locates + folds a session's transcript (Codex-support epic). Injected by
  // the composition layer as a ClaudeBackend; when absent (tests) the tailer folds with its own
  // corpus-verified applyRecord + deterministic Claude path — a byte-identical default.
  backend?: AgentBackend
  // Per-session backend resolver (Codex-support epic, Phase 2): the tailer picks a backend per ROW by
  // its `backend` column so a codex row folds through the codex rollout parser while every claude row
  // (and all foreign maintainer terminals) stays on the corpus-verified Claude fold. Injected by the
  // composition layer; when absent (tests) the single `backend`/default Claude fold covers every row —
  // byte-identical to before. Takes precedence over `backend` when both are set.
  backendFor?: (kind?: string) => AgentBackend
  // The structured PermissionRequest signal (Claude workers with the cc-worker plugin): the worker's
  // perm-observe.mjs hook drops `<stateDir>/perm-requests/<slug>.json` the instant Claude creates a
  // tool-approval prompt. Injectable for tests; the default reads that file. Absent stateDir (narrow
  // test fixtures) → always undefined, which now simply means no permission-block signal: the regex
  // fallback that used to cover it read a screen no runtime renders any more (see sniffPane).
  readPermMarker?: (slug: string) => PermMarker | undefined
  // Durable prime cache (see tail-cache.ts). Defaults to a table in the project's own SQLite DB;
  // pass `null` to disable it entirely, which restores the historical "fold every transcript from
  // byte 0 on every boot" behaviour exactly (that is what the cache-off tests assert against).
  tailCache?: TailStateCache | null
  // The SDK's OWN reading of a headless Claude session, from the broker event stream
  // (backend/claude-runtime-ingest.ts). Two things come off it:
  //   * `turn` — the provider stating outright whether a turn is running, where the fold has to infer
  //     it from `stop_reason` and falls back to a 5s silence guess. Consulted ONLY through
  //     resolveRuntimeTurn, which is forbidden from overriding folded evidence. OPTIONAL: a session
  //     whose events have all been turn-neutral (`init`, `task`, `other`) has no reading at all, and
  //     saying so is the point — inventing one there is what pinned rested threads at "Working…".
  //   * `at` — when the reading was taken, so a `running` that has STOPPED ADVANCING stops outranking
  //     a folded rest (see RUNNING_OVERRIDE_MAX_AGE_MS).
  //   * `events` — how many events this session has produced, which is what lets a tick tell that the
  //     provider has reported activity the transcript has not caught up with yet. See RUNTIME_CHASE_MAX.
  // Absent (codex rows, pre-broker claude rows, tests, bridge-less server) ⇒ the fold decides alone,
  // byte-identical to before.
  runtimeLiveness?: (sessionId: string) => { turn?: "running" | "settled"; at: number; events: number } | undefined
  // The provider's OWN view of a broker session's background tasks (backend/claude-runtime-ingest.ts):
  // what each child is doing right now, and which ones the SDK says are finished. Consulted ONLY
  // through applyRuntimeTasks, which may ENRICH a folded entry and RETIRE one the provider reports
  // terminal — and may never invent an entry the fold does not know about. Absent (codex rows,
  // pre-broker claude rows, tests, bridge-less server) ⇒ the prose fold decides alone, byte-identical
  // to before.
  runtimeTasks?: (sessionId: string) => readonly ClaudeRuntimeTask[]
  // CODEX's live background execs, off the app-server item stream (backend/codex-app-server.ts
  // `backgroundExecs`). The exact counterpart of `runtimeTasks` for the other provider, and the ONLY
  // source there is: a codex background exec's `processId` — the id its × has to address — is on that
  // stream and NOT in the rollout this module folds (measured in backend/_live_codex_bgterm_match.mts,
  // where the rollout-projected row carried no handle at all). Unlike `runtimeTasks` this may CREATE
  // rows the fold knows nothing about, because for codex there is nothing to enrich: the fold has never
  // produced a shell entry for a codex thread. Absent (claude rows, tests, a bridge-less server) ⇒ no
  // codex shell rows, exactly as before.
  codexBackgroundExecs?: (threadSlug: string, sessionId: string) => readonly { processId: string; command?: string; startedAtMs: number }[]
  // The model's context SIZE for a broker Claude session, as the SDK reported it on that session's
  // `result` message (backend/claude-runtime-ingest.ts). It is the only place Claude names the number:
  // the JSONL carries per-request usage (the numerator) and nothing at all about the window. Absent
  // (codex rows — which name their own window on every token_count — pre-broker/foreign Claude rows, tests,
  // a bridge-less server) ⇒ the fold keeps whatever window it already has, and a Claude row that never
  // gets one renders no reading rather than a guessed one.
  runtimeContextWindow?: (sessionId: string) => number | undefined
}

// The durable permission-request marker written by the worker's PermissionRequest hook
// (cc-worker/hooks/perm-policy.mjs). `at` is the ISO time the request was created; the tailer treats
// the marker as an ACTIVE block only while `at` is newer than the last transcript activity (a resolved
// request always advances the transcript past it) AND the policy hook DEFERRED it to a human.
//
// `decision` is what the policy hook did with the request: "allow"/"deny" mean it already resolved it
// unattended and NO human is blocked; only "defer" is a real block. The field is OPTIONAL because a
// marker written by an older plugin build (the observe-only era, which never decided) has none — those
// are read as "defer", preserving the historical behavior exactly. rule/reason/command are display
// provenance for the dashboard: which rule decided, why, and (for Bash) the command it decided about.
export type PermDecision = "allow" | "deny" | "defer"
export interface PermMarker {
  slug: string
  tool: string | null
  promptId: string | null
  permissionMode: string | null
  at: string
  decision?: PermDecision
  rule?: string
  reason?: string
  command?: string
}

// A marker's effective decision. Absent/unrecognized ⇒ "defer": an old or malformed marker must fall
// back to "a human is blocked", never to "already approved" (which would hide a real stall).
export function markerDecision(marker: Pick<PermMarker, "decision">): PermDecision {
  return marker.decision === "allow" || marker.decision === "deny" ? marker.decision : "defer"
}

// The last policy DENIAL frizz observed for a thread, for display. Only denials appear here: a
// deferred request is already fully represented by permPrompt ("Needs you"), and an approval is
// routine — it used to render as a quiet line, which pinned itself to the bottom of the thread
// forever after one unremarkable command and told the maintainer nothing they wanted
// (2026-08-07: "it's fucking useless"). `command` is present for Bash only and is display text,
// not a re-executable string.
export interface PermPolicyView {
  decision: "deny"
  rule: string
  reason: string
  tool: string | null
  at: string
  command?: string
}

function isPermMarker(v: unknown): v is PermMarker {
  if (!v || typeof v !== "object") return false
  const m = v as Partial<PermMarker>
  return typeof m.slug === "string" && typeof m.at === "string"
}

// A sub-agent transcript's mtime in epoch-ms, or undefined if it can't be stat'd (not yet created,
// unreadable). Telemetry-grade: a stat failure degrades to "can't assess staleness", never throws.
function defaultMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

// The Claude Code per-project transcript dir: ~/.claude/projects/<cwdSlug>/. Exported so the
// composition layer can construct the matching ClaudeBackend (its transcriptPath appends the id).
export function defaultLogDir(project: Project): string {
  return join(homedir(), ".claude", "projects", project.cwdSlug)
}

// Reads the worker's PermissionRequest marker from the per-project stateDir. Telemetry-grade: a missing
// stateDir (narrow test fixtures), an absent/half-written/corrupt file all degrade to undefined — the
// thread simply reports no permission block that tick. Never throws.
function defaultReadPermMarker(project: Project): (slug: string) => PermMarker | undefined {
  if (!project.stateDir) return () => undefined
  return (slug) => {
    try {
      const parsed = JSON.parse(readFileSync(permMarkerPath(project, slug), "utf8"))
      return isPermMarker(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
}

// "Is this broker session's daemon still running?" — the honest liveness reading a broker row has, taken
// from the same discovery record the bridge connects through (a `{daemonPid}` JSON under
// <stateDir>/claude-broker) plus a signal-0 probe of that pid.
//
// This exists because `exited` alone is NOT that answer. `exited` is stamped only when frizz DELIBERATELY
// stops a session, so a daemon that dies any other way — SIGKILL, OOM, an idle-timeout, a crash — leaves
// the row reading alive forever. Measured over this machine's whole broker corpus 2026-08-02: 276 daemon
// starts against 223 recorded exits, so ~19% of daemons vanish leaving no breadcrumb at all. That is the
// transcript-side half of a background shell that renders as "running" for seven hours after the process
// owning it is gone (thread invoices-just-went-out-for-august: daemon 71731 killed outright, its bg shell
// still shimmering on the board until the operator's next prompt spawned a successor).
//
// Two rules make this safe to consult from the 1s tick:
//   • FAIL-SAFE IS "ALIVE". No stateDir, an unreadable/absent/corrupt record, a pid we may not signal —
//     every one answers ALIVE, so the worst case is exactly today's behavior. The opposite default is the
//     documented catastrophe here (see paneDeadForRow: a latched dead reading emptied bgShellViews for
//     EVERY broker thread at once), so this never guesses toward death.
//   • Never `liveBrokerRecord`, which UNLINKS a record it judges stale. The tailer only observes; pruning
//     discovery state from a read path would race the bridge that owns it.
// Memoised per session on a short TTL: the answer changes at most once per daemon lifetime, and a board
// of broker rows must not pay a read + syscall per row per second to learn nothing.
const BROKER_LIVENESS_TTL_MS = 5_000

export function defaultBrokerDaemonAlive(project: Project, now: () => number): (sessionId: string) => boolean {
  if (!project.stateDir) return () => true
  const cache = new Map<string, { at: number; alive: boolean }>()
  return (sessionId) => {
    const cached = cache.get(sessionId)
    const at = now()
    if (cached && at - cached.at < BROKER_LIVENESS_TTL_MS) return cached.alive
    let alive = true
    try {
      const path = claudeBrokerRecordPath(project.stateDir!, sessionId)
      const record = readBrokerRecord(path)
      // `readBrokerRecord` collapses "absent" and "unparseable" into the same null, and those two must
      // NOT get the same answer: an absent record is a positive absence (no daemon to discover ⇒ dead),
      // while an unparseable one is a failure to read (⇒ alive). Only the absence may answer dead. A
      // daemon mid-write leaves exactly the unparseable shape, so conflating them would let a routine
      // torn read clear a LIVE thread's background shells — and a test writing `{ not json` caught this
      // implementation doing precisely that.
      if (!record) alive = existsSync(path)
      else if (typeof record.daemonPid !== "number") alive = true
      else {
        try {
          process.kill(record.daemonPid, 0)
        } catch (error) {
          // EPERM ⇒ the pid exists and is not ours to signal. Only ESRCH is "gone".
          alive = (error as NodeJS.ErrnoException).code === "EPERM"
        }
      }
    } catch {
      alive = true // unreadable state ⇒ never claim a death we cannot see
    }
    cache.set(sessionId, { at, alive })
    return alive
  }
}

// The slice of AgentBackend the tailer drives: locate a session's transcript and fold a raw line into
// the accumulator.
type TailBackend = Pick<AgentBackend, "transcriptPath" | "foldLine">

// Fields the durable prime cache must NEVER restore. Identity comes from the live registry row; the
// liveness/discovery fields are re-derived by the prime branch on every boot and a stale value would
// suppress a genuine observation (a stall that must be captured, a discovery that must be retried).
//
// EXPORTED so a test can assert against the real set: the cache codec is deliberately generic (see
// tail-cache.ts — "A hand-written field list is a standing bug"), which means a NEW TailState field is
// restored BY DEFAULT and only an entry here stops it. That default is what made the chase bookkeeping
// below a live bug, so the set is now a tested contract rather than a private detail.
export const UNRESTORED_TAIL_FIELDS: ReadonlySet<string> = new Set([
  "slug", "sessionId", "nativeSessionId", "runtimeGeneration", "path", "foreign",
  "primed", "permPrompt", "paneDead", "subAgentsSig",
  // Marker-DERIVED, exactly like permPrompt above: this cache exists to skip re-folding the
  // TRANSCRIPT, and none of these three come from it. Re-derived from the on-disk
  // marker on the next tick anyway, so dropping them costs nothing and restoring them costs a lot —
  // the fold-schema digest cannot invalidate a stale one, because a promoted artifact ships no .ts
  // sources (verified) and foldSchemaDigest therefore falls back to a FIXED constant that every build
  // shares. A state cached by the build that still retained auto-approvals would otherwise be handed
  // straight back to the build that removed them, resurrecting the note permanently.
  "permPolicy", "permDenies",
  "noTranscript", "nextDiscoverMs", "discoverMisses", "stallLogged",
  "deliveryLedgerSeen",
  // The chase bookkeeping is compared against an IN-MEMORY, per-process counter — the ingest's `live`
  // map is rebuilt empty on every boot (backend/claude-runtime-ingest.ts). A hydrated high-water mark
  // from the PREVIOUS process is therefore measured against a counter that restarted at zero, so
  // `live.events <= runtimeEventsSeen` holds forever and the chase never fires again. Measured on a
  // restart-crossing differential: 968/970/970 ms — the exact poll floor chaseRuntime exists to remove
  // — against 16/22/19 ms with these two fields dropped.
  "runtimeEventsSeen", "runtimeChase",
  // The REGISTRY owns this, not the cache. Both are durable, so the collision is silent and total: the
  // snapshot is written on a tick, an × clicked after that tick is not in it, and restoring the stale
  // copy overwrote the set just read from `retired_op` with an EMPTY one — which then let the cached
  // `subAgents` map, also from before the click, put the killed shell straight back on the board. The
  // fold-side guard never even ran, because a cache hit means nothing is folded at all. Found by the
  // restart test, after the fix looked correct and the row came back anyway.
  "dismissedOps",
])

/**
 * Is this row filed away in the board's Done section?
 *
 * The tailer's read of board.ts's `effectiveSessionState`, minus its third clause — the legacy paired
 * terminal FILE, which is a disk read this loop must not do per row and which only ever classifies
 * pre-session-first rows. The first two clauses are the whole story for anything dispatch created:
 * an explicit `state` write wins, and the legacy `archived` bit answers only for rows that never got
 * one. Keying on `archived` ALONE would be wrong — storage.ts is explicit that it is a legacy column
 * kept only in sync, and an explicit `state: "open"` must beat a stale bit, not lose to it.
 */
function rowIsArchived(row: SessionRow): boolean {
  if (row.state === "open" || row.state === "archived") return row.state === "archived"
  return row.archived === 1
}

export function createTailer(deps: TailerDeps): Tailer {
  const now = deps.now ?? Date.now
  const monotonicNow = deps.monotonicNow ?? (() => performance.now())
  // A row's liveness comes from its runtime (broker daemon / app-server), never from a screen. A
  // PRE-CUTOVER row has no transport left, so the default answers "dead" — the seam stays injectable
  // for fixtures.
  const paneDead = deps.paneDead ?? (() => true)
  const brokerDaemonAlive = deps.brokerDaemonAlive ?? defaultBrokerDaemonAlive(deps.project, now)
  const logDir = deps.sessionLogDir ?? defaultLogDir(deps.project)
  // Keyed on THIS project's state dir: the stall log is named for a thread slug alone, which is not
  // unique across projects (and, in a shared /tmp, not across OS users either).
  const stallLogDir = frizzTempDir("frizz-worker-logs", deps.project.stateDir)
  const mtimeMs = deps.mtimeMs ?? defaultMtimeMs
  const readPermMarker = deps.readPermMarker ?? defaultReadPermMarker(deps.project)
  // The durable prime cache. `undefined` dep ⇒ open the default table in the project DB; `null` ⇒
  // explicitly disabled. A storage stub with no `db` degrades to disabled rather than throwing.
  const tailCache: TailStateCache | null = deps.tailCache === null
    ? null
    : deps.tailCache ?? (() => {
        try {
          return deps.storage.scope ? createTailStateCache(deps.storage.scope) : null
        } catch {
          return null
        }
      })()

  // Resolved at most ONCE per row per tick. Every row asks for its binding at least twice (liveness
  // and the text-capture seam), and each ask is two registry point-queries — 4 queries per row per
  // second that can only ever return the same answer, since a tick describes one instant. Reset at the
  // top of each tick alongside the capture caches.
  let adoptionBindings = new Map<string, ReturnType<typeof adoptionRuntimeBinding>>()

  // The turn a row is IN, folding in the provider's own reading when there is one. For every row
  // without a runtime signal — every codex row, every non-broker claude row, every test fixture —
  // this is exactly `computeTurn(state, nowMs)`.
  function turnFor(row: SessionRow, state: TailState, nowMs: number): TurnState {
    const detailed = computeTurnDetailed(state, nowMs)
    if (!deps.runtimeLiveness || !isBrokerClaudeRow(row)) return detailed.turn
    const live = deps.runtimeLiveness(row.session_id)
    // The reading's AGE, clamped at 0. An injected test clock can sit behind the wall clock the ingest
    // stamps with, and a negative age must read as FRESH — never as an ancient reading to discard.
    const ageMs = live ? Math.max(0, nowMs - live.at) : 0
    return resolveRuntimeTurn(detailed.turn, detailed.backstopped, live?.turn, ageMs)
  }

  // The provider's event stream RUNS AHEAD OF ITS OWN DISK WRITE. Measured against a real broker
  // session (_live_broker_ingest.mts): the SDK emitted `assistant` at t+3225ms and `result` at
  // t+3251ms with the transcript still at 9783 bytes, and the record only landed between t+3340ms and
  // t+3368ms — roughly 100-140ms later. So a nudge fired on the event reads a file that does not yet
  // contain the record it was told about, the tick folds nothing, and the change waits out the next
  // poll anyway. That is exactly what the promoted-artifact measurement showed: ~920ms, the poll
  // cadence, with the nudge doing no good at all.
  //
  // The fix is level-triggered, not a guessed delay: while the provider reports events this session's
  // transcript has not caught up with, ask for another look. The moment the fold advances, the
  // condition clears on its own. Bounded so an event that never produces a record (init, and the
  // system sidecars) costs a fixed number of cheap ticks and then hands back to the poll — at ~25ms
  // per chase this covers ~500ms of write lag, comfortably over the measured ~140ms.
  function chaseRuntime(row: SessionRow, state: TailState, foldAdvanced: boolean): boolean {
    if (!deps.runtimeLiveness || !isBrokerClaudeRow(row)) return false
    const live = deps.runtimeLiveness(row.session_id)
    if (!live || live.events <= (state.runtimeEventsSeen ?? 0)) return false
    if (foldAdvanced || (state.runtimeChase ?? 0) >= RUNTIME_CHASE_MAX) {
      state.runtimeEventsSeen = live.events
      state.runtimeChase = 0
      return false
    }
    state.runtimeChase = (state.runtimeChase ?? 0) + 1
    return true
  }

  // Fold the provider's OWN report of this session's background tasks over the entries the transcript
  // fold already tracks. This is the structured replacement for the prose archaeology above — the SDK
  // states outright which child is running which tool, what it has spent, and when it is done, where
  // `launchOutputFile` / `launchTaskId` / `trackCompletions` have to recognize English sentences
  // ("Command running in background with ID:", "Monitor started (task", "<task-notification>"). Those
  // stay exactly where they are: they are the ONLY signal a session with no provider event stream has,
  // and a broker session that predates these events (or drops one) still folds identically.
  //
  // The authority split mirrors resolveRuntimeTurn's, and the SECOND rule is the load-bearing one:
  //
  //  * ENRICH — freely. Progress is information the fold structurally does not have; there is nothing
  //    to conflict with.
  //  * RETIRE — yes, on a provider-reported terminal status. This is not overriding folded evidence: it
  //    is the SAME terminal signal the `<task-notification>` fold is waiting for, on a channel that
  //    actually carries it. (Those notifications are stream-only — they are NOT in the JSONL — which is
  //    why the prose path has leaked phantoms three separate times.) retireLive is idempotent, so the
  //    prose path re-seeing it later is a no-op.
  //  * CREATE — never. `trackDispatches` deliberately skips a foreground `Agent` (run_in_background:
  //    false) because the spinner already covers it, and the provider reports those tasks too. Minting
  //    entries here would put foreground children on the board's LIVE count and into the completion
  //    hold — inventing exactly the phantoms this change exists to remove.
  // Claude's context WINDOW, latched onto the fold from the broker event stream. One-way and
  // latching by design: the SDK only names the window when a turn ends, so it must survive the
  // in-between ticks, and it lands in TailState (not a side map) so the durable tail cache carries it
  // across a frizz restart — otherwise every resting Claude thread would lose its readout on reload and
  // not get it back until its next turn finished. The tokens half needs none of this: it is on disk.
  //
  // The ingest may answer with a window BORROWED from another session on the same model alias, which is
  // what gives a thread still inside its first turn a readout at all (see ClaudeRuntimeIngest.
  // contextWindow). Latching that is deliberate and safe in both directions: it is the number this
  // account measured for this alias, and this session's own `result` overwrites it the moment one lands.
  function applyRuntimeContextWindow(row: SessionRow, state: TailState): void {
    if (!deps.runtimeContextWindow || !isBrokerClaudeRow(row)) return
    const window = deps.runtimeContextWindow(row.session_id)
    if (window !== undefined && window > 0) state.contextWindow = window
  }

  function applyRuntimeTasks(row: SessionRow, state: TailState, nowMs: number): void {
    if (!deps.runtimeTasks || !isBrokerClaudeRow(row) || state.subAgents.size === 0) return
    const runtime = deps.runtimeTasks(row.session_id)
    if (runtime.length === 0) return
    // Index both ways up front: a handful of live entries against up to a few hundred remembered tasks.
    const byToolUse = new Map<string, ClaudeRuntimeTask>()
    const byTaskId = new Map<string, ClaudeRuntimeTask>()
    for (const task of runtime) {
      if (task.toolUseId) byToolUse.set(task.toolUseId, task)
      byTaskId.set(task.taskId, task)
    }
    const doomed: Array<{ entry: SubAgentEntry; task: ClaudeRuntimeTask }> = []
    for (const entry of state.subAgents.values()) {
      // tool_use id first — it is the key BOTH sides mint at dispatch, so it cannot be confused. The
      // task id is the fallback for a launch ack frizz parsed but an SDK build that omits tool_use_id.
      const task = byToolUse.get(entry.toolUseId) ?? (entry.taskId ? byTaskId.get(entry.taskId) : undefined)
      if (!task) continue
      // Backfill the manual-stop correlation key from the structured pairing, so a `TaskStop` on this
      // child correlates even when the launch ack's prose never yielded one.
      if (!entry.taskId) entry.taskId = task.taskId
      const progress: SubAgentProgress = {
        activity: task.lastToolName,
        activityDetail: task.activityDetail,
        summary: task.summary,
        toolUses: task.toolUses,
        totalTokens: task.totalTokens,
        durationMs: task.durationMs,
      }
      entry.progress = progress
      // A terminal reading from BEFORE this run began cannot end it. A task id outlives the run that
      // created it — `SendMessage` restarts a stopped child under the SAME id — so a row revived by
      // `trackResumes` would otherwise be retired on its first tick by the DEAD run's terminal flag,
      // whichever of the two signals happens to arrive first. The ingest clears that latch on
      // `task_started`, but the stream and the transcript race by design (see chaseRuntime), so the
      // ordering must not be load-bearing: compare instants instead. An unparseable `startedAt` falls
      // through to the old unconditional behaviour rather than pinning a row alive.
      const startedMs = entry.startedAt ? Date.parse(entry.startedAt) : Number.NaN
      const staleTerminal = Number.isFinite(startedMs) && task.updatedAt < startedMs
      if (task.terminal && !staleTerminal) doomed.push({ entry, task })
    }
    // Collected first: retireLive mutates the map being iterated above.
    for (const { entry, task } of doomed) {
      retireLive(state, entry, new Date(task.updatedAt || nowMs).toISOString(), task.outcome ?? "completed")
    }
  }

  function adoptionBinding(row: SessionRow) {
    const cached = adoptionBindings.get(row.slug)
    if (cached) return cached
    const binding = adoptionRuntimeBinding(deps.storage, row)
    adoptionBindings.set(row.slug, binding)
    return binding
  }

  // "Is the process that owns this session's children gone?" — the registry's own exit stamp for a
  // HEADLESS row (broker claude / app-server codex), plus, for a broker row, a probe of its daemon's
  // own pid.
  //
  // HISTORY, because it is the whole reason the guard below exists. Frizz used to run each worker in a
  // terminal of its own and read that terminal's death as the answer. A headless row never had one, so
  // asking that question about one could only ever answer "dead" — the exact trap deriveRuntime
  // (board.ts) and reconcileSessions (context.ts) each refuse by name — and the tailer fell into it at
  // PRIME, where this was called unguarded while the steady tick below guards it with !isHeadlessRow.
  // That latched paneDead=true on every broker thread at first sighting and never revisited it, so
  // bgShellViews returned [] for all of them: a live CI watcher, correctly tracked by the fold,
  // rendered nowhere (measured 2026-07-29 — 13 threads holding live shell entries, the only one with
  // paneDead=false a legacy pre-broker row). `exited` is the headless stand-in: nothing observes a
  // process death to set it, so it is stamped only when frizz genuinely stops the session.
  //
  // Which makes `exited` a FLOOR, not the whole answer — it knows the deliberate stop and no other death.
  // A BROKER claude row can do better, because its daemon publishes a discovery record naming its pid; an
  // app-server codex row still has only the stamp. See the first branch below.
  function paneDeadForRow(row: SessionRow): boolean {
    // A BROKER claude row has a second, honest reading available: its daemon's own discovery record.
    // `exited` covers only the deliberate stop, which is why a daemon killed outright used to leave this
    // false forever — and with it every background shell the dead process owned, rendering as live. See
    // defaultBrokerDaemonAlive; it fails safe to ALIVE, so this can only ever ADD deaths frizz can prove.
    if (isBrokerClaudeRow(row)) return row.exited === 1 || !brokerDaemonAlive(row.session_id)
    if (isHeadlessRow(row)) return row.exited === 1
    const binding = adoptionBinding(row)
    if (binding.kind === "conflict") return true
    return paneDead(row.slug)
  }

  // Default backend = this file's own corpus-verified Claude fold (identical to the injected
  // ClaudeBackend, which reuses the same applyRecord/parseLine). Tests never inject a backend, so
  // this default is the regression-proof path.
  const defaultBackend: TailBackend = {
    transcriptPath: (sessionId) => join(logDir, `${sessionId}.jsonl`),
    foldLine: (state, line) => {
      const rec = parseLine(line)
      // The tailer only ever hands foldLine the concrete TailState it constructs; applyRecord needs
      // Claude's full accumulator (sub-agent/ask tracking, lastKind/lastStopReason) the neutral
      // FoldState doesn't carry, so narrow back to it. Byte-identical to the pre-refactor fold.
      if (rec) applyRecord(state as TailState, rec)
    },
  }
  // Resolve the backend for a row by its `backend` column. Prod injects `backendFor` (claude|codex);
  // a single injected `backend` or the local default covers every row otherwise. For claude (and every
  // foreign maintainer terminal) this is the corpus-verified Claude fold — byte-identical to before.
  function resolveBackend(kind?: string): TailBackend {
    return deps.backendFor?.(kind) ?? deps.backend ?? defaultBackend
  }

  function persistCodexAutoTitle(row: SessionRow, state: TailState, runtimeGeneration: number): boolean {
    if (row.backend !== "codex" || !state.aiTitle?.trim()) return false
    try {
      return deps.storage.setAutoTitleIfCurrent(row.slug, state.aiTitle.trim(), {
        sessionId: row.session_id,
        nativeSessionId: row.agent_session_id ?? null,
        runtimeGeneration,
      })
    } catch {
      // Telemetry still carries the transcript-backed title for this process. A transient registry
      // write failure must not break tailing; the full replay on restart safely retries the same CAS.
      return false
    }
  }

  // Derive the surfaced view of a session's live sub-agents (insertion = dispatch order). A tracked
  // entry whose transcript file hasn't been touched in SUBAGENT_STALE_MS is reported "stale" — a
  // liveness fallback for a completion record we missed; one still being appended to is "running".
  // A tracked child is "stale" once we've resolved its transcript path and that file has gone
  // SUBAGENT_STALE_MS without an append (or no longer stats) — a liveness fallback for a completion we
  // missed. Before the path resolves (fresh dispatch) it stays "running" — it's just starting up.
  //
  // THE ACK IS NOT THE ONLY WAY TO FIND THE FILE (2026-08-26). `outputFile` is parsed out of the launch
  // ack's PROSE (launchOutputFile), so a harness wording change silently un-resolves it — and with no
  // path this returned false on EVERY clock, so such an entry could never go stale at all. That was
  // unbounded, and a child reading "running" forever also excuses its thread from the queue forever
  // (board.ts hasLiveOwnWork). Measured across this machine's whole corpus when the hole was audited
  // (2026-08-02): 61 of 4068 kept-alive dispatches (1.50%) resolved no output file, every one a
  // `Spawned successfully … agent_id: <name>@<session>` mailbox ack whose key is snake_case where this
  // parser reads `agentId:` — and all 61 sat in six session files last written 2026-07-08..13.
  //
  // So the path now falls back to the SIDECAR INDEX, which maps dispatch tool_use id → the descendant's
  // own `agent-<id>.jsonl` and is the same index the drawer and `subAgentDescendantTasks` already
  // resolve through. That was the fix this comment named while the hole stood, and it is the reason the
  // OTHER candidate — a clock on the DISPATCH instant — was tried and reverted: it regresses
  // tailer.descendants.test.ts, whose fixtures encode the case it breaks, a direct child with no
  // ack-named path whose own transcript IS being appended to and which is therefore genuinely running.
  // Through the sidecar that child resolves to its transcript and reads as running, which is what it is.
  //
  // Still biased to "running": a child whose path resolves nowhere at all keeps the old behaviour and
  // is never called stale on a guess. This only ever ADDS a clock where there was none.
  function entryTranscript(state: TailState, e: SubAgentEntry): string | undefined {
    if (e.outputFile) return e.outputFile
    if (e.kind !== "agent") return undefined // a shell's output path is not a sidecar transcript
    const meta = descendantSidecar(state, e.toolUseId)
    return meta ? descendantTranscript(state, meta) : undefined
  }

  function entryStale(state: TailState, e: SubAgentEntry, nowMs: number): boolean {
    const path = entryTranscript(state, e)
    if (!path) return false
    const m = mtimeMs(path)
    return m === undefined || nowMs - m > SUBAGENT_STALE_MS
  }

  // The child's last-append instant (its output file's mtime, the same stat entryStale reads), as ISO
  // for the surfaced view. Undefined before the path resolves or when the file no longer stats — the
  // caller then simply omits lastActivityAt (an absent reading is correct; a fabricated one is not).
  function entryLastActivity(state: TailState, e: SubAgentEntry): string | undefined {
    const path = entryTranscript(state, e)
    if (!path) return undefined
    const m = mtimeMs(path)
    return m === undefined ? undefined : new Date(m).toISOString()
  }

  // Derive the surfaced view of a session's live SUB-AGENTS (kind "agent"; insertion = dispatch order),
  // each followed by its own live DESCENDANTS in depth-first order — so a worker that fanned out through
  // a sub-agent reads as the tree it is, on every surface, instead of as one opaque row.
  //
  // A direct child's view object is deliberately left BYTE-IDENTICAL to what it was before nesting
  // existed: `depth` is emitted only from 2 down, and absent means 1 everywhere it is read.
  function subAgentViews(state: TailState, nowMs: number): SubAgentView[] {
    if (state.subAgents.size === 0 && state.retiredSubAgents.size === 0) return []
    const subtrees = descendantSubtrees(state, nowMs)
    const out: SubAgentView[] = []
    for (const e of state.subAgents.values()) {
      if (e.kind !== "agent") continue
      const lastActivityAt = entryLastActivity(state, e)
      // Each progress field is spread in only when the provider reported it, so a prose-only child's
      // view object is byte-identical to what it was before this existed.
      const p = e.progress
      out.push({
        label: e.label,
        startedAt: e.startedAt,
        state: entryStale(state, e, nowMs) ? "stale" : "running",
        subagentType: e.subagentType,
        id: e.toolUseId,
        ...(e.taskId ? { taskId: e.taskId } : {}),
        ...(lastActivityAt ? { lastActivityAt } : {}),
        ...(p?.activity ? { activity: p.activity } : {}),
        ...(p?.activityDetail ? { activityDetail: p.activityDetail } : {}),
        ...(p?.summary ? { summary: p.summary } : {}),
        ...(p?.toolUses !== undefined ? { toolUses: p.toolUses } : {}),
        ...(p?.totalTokens !== undefined ? { tokens: p.totalTokens } : {}),
        ...(p?.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
      })
      const subtree = subtrees.get(e.toolUseId)
      if (subtree) out.push(...subtree)
    }
    // The RESTED roots (see anchorRoots): a child whose run ended while its own fan-out kept running.
    // Only the ones that actually produced a subtree — a retired child with nothing live under it is
    // finished work and belongs in the ring, off every live surface, exactly as before.
    //
    // Appended AFTER the live rows rather than interleaved by instant: the live map's insertion order IS
    // dispatch order and a good deal of the board's copy leans on it, while the ring is ordered by
    // retirement. Two honest orders beat one invented one, and the rested rows are the smaller set.
    for (const dead of state.retiredSubAgents.values()) {
      const subtree = subtrees.get(dead.toolUseId)
      if (!subtree || subtree.length === 0) continue
      const lastActivityAt = dead.outputFile ? mtimeMs(dead.outputFile) : undefined
      out.push({
        label: dead.label,
        // Its real dispatch instant, so the row's duration keeps reading "how long this branch has been
        // going". `finishedAt` is the fallback for a row retired before this field existed (the durable
        // tail cache can hold those across an upgrade); the oldest live grandchild's spawn is the last
        // resort. Every one of the three is a measured instant — never a fabricated one.
        startedAt: dead.startedAt ?? dead.finishedAt ?? subtree[0].startedAt,
        state: "rested",
        subagentType: dead.subagentType,
        id: dead.toolUseId,
        ...(dead.taskId ? { taskId: dead.taskId } : {}),
        ...(lastActivityAt === undefined ? {} : { lastActivityAt: new Date(lastActivityAt).toISOString() }),
      })
      out.push(...subtree)
    }
    return out
  }

  // Derive the surfaced view of a session's live background SHELLS (kind "shell"; DISPLAY-ONLY — the
  // "background running" chip on the launch record, nothing more). A background Bash/Monitor is a CHILD
  // of the agent process running this session — it cannot outlive it. So the death of that process (it
  // exited/crashed WITHOUT emitting each shell's terminal <task-notification>) means every tracked shell
  // died with it: report none rather than leaving them to read as live (the UI would otherwise show them
  // "alive", quietly breathing, forever). The normal path — a shell exiting while the agent lives —
  // still clears via its terminal notification.
  //
  // `paneDead` is that death, and it is not a fact about any screen: a headless row (broker claude /
  // app-server codex) answers from its exit stamp — plus, for a broker row, a probe of its daemon's own
  // pid. See paneDeadForRow, where asking the old terminal-death question about a screenless row
  // silently emptied this list for every broker thread, and where the stamp ALONE later kept a dead
  // process's shells breathing here for seven hours (2026-08-02).
  //
  // A tracked shell whose owner is alive is simply "running" — there is no age-based staleness. `run_in_background`
  // cannot tell a CI watcher (ends soon) from a vite dev server (runs forever), so NO clock is a correct
  // clock: an mtime rule falsely killed quiet watchers, and an absolute-age cap would falsely kill
  // long-lived servers. None of that can bury a thread: a shell does not excuse a rest from the queue
  // (board.deriveNeedsYou reads hasLiveBackgroundWork, which is sub-agent-only), so the worst a
  // never-clearing entry can do is leave a card saying a shell is running — the thread is queued and in
  // front of the operator either way. It clears on the shell's real terminal signal or on owner death.
  function bgShellViews(state: TailState): BgShellView[] {
    if (state.subAgents.size === 0 || state.paneDead) return []
    const out: BgShellView[] = []
    for (const e of state.subAgents.values()) {
      if (e.kind !== "shell") continue
      const lastActivityAt = entryLastActivity(state, e)
      // `stoppable` is only HALF the answer here — "frizz holds a provider task handle for this shell".
      // board.ts ANDs it with the thread's transport before the × is offered (see BgShellView.stoppable).
      // Emitted only when a handle exists, so the row cannot advertise a control during the window
      // between its tool_use (which creates the entry) and its launch ack (which names the task).
      // `taskId` travels as well as gating `stoppable`: it is the handle the RUNTIME hands the model, so
      // it is the id a worker registers a `shell` watcher against (see BgShellView.taskId).
      // LIVENESS, asked of the OS and cached — see probeShellAlive. A shell inside its grace window, or
      // one we cannot establish an answer for, stays "running": this only ever DEMOTES a shell we have
      // positively confirmed nobody is running. `ToolStatusMeta` and the drawer have rendered a "stale"
      // shell all along; nothing ever produced one, because this was a literal "running".
      const shellState = shellIsGone(e) ? "stale" as const : "running" as const
      out.push({ label: e.label, startedAt: e.startedAt, state: shellState, id: e.toolUseId, ...(e.taskId ? { stoppable: true, taskId: e.taskId } : {}), ...(lastActivityAt ? { lastActivityAt } : {}) })
    }
    return out
  }

  // THE SHELLS THAT HAVE FINISHED, and the reason a watcher needs them at all.
  //
  // `evalWatchers` used to infer "this shell is done" from its ABSENCE, gated on having first observed
  // it ALIVE (seen-then-gone) so that a typo'd target could not report a completion that never happened.
  // That gate is a RACE, because the scheduler ticks every 10s: a shell that finishes inside one tick of
  // its watcher being armed is never observed alive, so its absence never counts and the watcher stays
  // armed forever. Not hypothetical — measured on the thread that started this (2026-08-14): three
  // watched shells lived 0.98s, 16.4s and 19.3s past their arming, and the first could never have fired.
  // Sub-10s background shells are ordinary, so the hole is ordinary too.
  //
  // A RETIREMENT is the positive signal absence was standing in for: the fold saw the shell's own
  // terminal <task-notification>. Matching against it needs no prior sighting, so the race disappears —
  // and it keeps the property seen-then-gone existed to protect, more strongly: a target naming no real
  // shell matches no retirement either, so a typo still never fires.
  function retiredShellViews(state: TailState): RetiredShellView[] {
    const out: RetiredShellView[] = []
    for (const r of state.retiredShells.values()) out.push({ id: r.toolUseId, taskId: r.taskId, label: r.label, status: r.status, finishedAt: r.finishedAt })
    return out
  }

  // CODEX's background shells, which come from the app-server's item stream rather than from the fold.
  // They are a separate function and not a branch inside `bgShellViews` because they share nothing with
  // it: no `subAgents` entry, no output file to stat, no launch ack to parse. What they DO share is the
  // row: same shape, same ×, same `stoppable` contract — so the client cannot tell the two apart, which
  // is the point.
  //
  // The row's `id` is the `processId` itself. Unlike a Claude shell (whose id is the launch tool_use id
  // and whose task id is looked up separately), codex has exactly one handle and it is the one the kill
  // needs, so there is nothing to correlate and no window where the row exists without it.
  function codexBgShellViews(state: TailState): BgShellView[] {
    if (!deps.codexBackgroundExecs || state.foreign || state.paneDead) return []
    const execs = deps.codexBackgroundExecs(state.slug, state.sessionId)
    return execs.map((exec) => ({
      label: unwrapShellCommand(exec.command) ?? "Background command",
      // Carried SEPARATELY from the label even though they are the same string here: it is the client's
      // reconciliation key against the transcript's own copy of this shell, and the label is free to
      // become something friendlier later without silently breaking that.
      ...(unwrapShellCommand(exec.command) ? { command: unwrapShellCommand(exec.command)! } : {}),
      startedAt: new Date(exec.startedAtMs).toISOString(),
      state: "running" as const,
      id: exec.processId,
      stoppable: true,
      // Codex hands a yielded command's output back only when the MODEL polls it — there is no file
      // for frizz to tail, so the row carries its × and no drill-in rather than opening a drawer that
      // could only say "unavailable".
      outputUnavailable: true,
    }))
  }

  // A compact change-key over ALL derived background state — sub-agents + shells + the pending ask —
  // so the tick marks the board dirty on any add/removal, a sub-agent running→stale flip (purely
  // time-based, no new record), or an ask appearing/clearing. Without it those changes would linger to
  // the next reconcile. (Shells no longer have a time-based flip, but their add/removal still counts.)
  //
  // lastActivityAt is folded in at MINUTE granularity, never raw: the reading is displayed as
  // "N min ago", so a running child whose mtime advances every append only needs to re-push when its
  // displayed minute would change — at most once a minute per active child, not once an append.
  //
  // Provider progress joins on the same terms. `activity` and `toolUses` change together, once per tool
  // the child runs — the exact granularity the operator wants to see move. `summary` is folded in too
  // (it changes rarely). Raw TOKEN counts are deliberately NOT here: they can advance on every progress
  // event without the rendered line changing meaningfully, and pushing a board delta for that is churn.
  function derivedSignature(state: TailState, nowMs: number): string {
    const agents = subAgentViews(state, nowMs).map((v) => `A:${v.label}|${v.state}|${v.startedAt}|${activityMinute(v.lastActivityAt)}|${v.activity ?? ""}|${v.activityDetail ?? ""}|${v.toolUses ?? ""}|${v.summary ?? ""}`).join("")
    // Codex's shells join the key on the same terms: they come off a live stream rather than the fold,
    // so an exec starting or ending changes NOTHING on disk and would otherwise wait for the next
    // reconcile to reach the board.
    const shells = [...bgShellViews(state), ...codexBgShellViews(state)].map((v) => `S:${v.label}|${v.state}|${v.startedAt}|${activityMinute(v.lastActivityAt)}`).join("")
    const ask = state.pendingAsk ? `Q:${state.pendingAsk.id}:${state.pendingAsk.questions.length}` : ""
    return `${agents}\n${shells}\n${ask}`
  }

  // ---- descendant resolution (see the DescendantSidecar note above) ------------------------------
  // One directory read per thread per CHANGE to its subagents dir. The drawer POLLS, so re-reading
  // every sidecar per poll would turn an open drawer into a disk loop; and a new descendant at any
  // depth is a new FILE in that flat dir, which is exactly what moves the dir's mtime. A sidecar is
  // written once at spawn and not rewritten, so mtime is a complete invalidation signal here.
  const descendantIndex = new Map<string, { at: number | undefined; all: DescendantSidecar[]; byToolUse: Map<string, DescendantSidecar> }>()
  const subtreeMemo = new Map<string, { at: number | undefined; second: number; live: number; retired: number; terminals: number; value: Map<string, SubAgentView[]> }>()

  function sessionDirOf(state: TailState): string {
    return state.path.replace(/\.jsonl$/, "")
  }

  function descendantSidecars(state: TailState): DescendantSidecar[] {
    const at = mtimeMs(join(sessionDirOf(state), "subagents"))
    const cached = descendantIndex.get(state.slug)
    if (cached && cached.at === at) return cached.all
    const all = readDescendantSidecars(sessionDirOf(state), mtimeMs)
    const byToolUse = new Map<string, DescendantSidecar>()
    for (const meta of all) if (meta.toolUseId) byToolUse.set(meta.toolUseId, meta)
    descendantIndex.set(state.slug, { at, all, byToolUse })
    return all
  }

  function descendantSidecar(state: TailState, id: string): DescendantSidecar | undefined {
    descendantSidecars(state) // refresh the index if the dir moved
    return descendantIndex.get(state.slug)?.byToolUse.get(id)
  }

  // Where the descendant's own transcript sits — the same flat dir, beside its sidecar.
  function descendantTranscript(state: TailState, meta: DescendantSidecar): string {
    return join(sessionDirOf(state), "subagents", `agent-${meta.agentId}.jsonl`)
  }

  // LIVE DESCENDANTS of one sub-agent, as the provider stop handles that end them.
  //
  // `stopTask` ends EXACTLY the task it names. The registry behind it is flat and session-wide, so a
  // sub-agent's own fan-out holds registrations of its own that its parent's id does not cover:
  // stopping the parent leaves every grandchild running, and — because that same flatness routes a
  // completion to the SESSION's main loop rather than to whoever dispatched it — those orphans keep
  // burning tokens and then deliver their reports into the ROOT thread, under an agent the operator
  // watched die. Measured on nub session a0c5fba3 (2026-07-31): the × set `stoppedByUser` on
  // `adabd4aeedf52ef6c`, whose transcript stops at 19:54:22, while its two live children — neither
  // carrying `stoppedByUser` — went on writing until 19:56:09 and 19:56:44 and landed their results in
  // the root transcript. So a stop that means "this work ends" has to name every task in the subtree.
  //
  // Keyed by the row's DISPATCH tool_use id, resolved through the same flat sidecar index the drawer
  // uses; children link upward by the AGENT id their sidecar is named for, not by that dispatch id.
  function subAgentDescendantTasks(slug: string, id: string): string[] {
    const state = states.get(slug)
    if (!state || !registeredStateIsCurrent(state)) return []
    const all = descendantSidecars(state)
    if (all.length === 0) return []
    const rootAgentId = descendantSidecar(state, id)?.agentId
    if (!rootAgentId) return [] // nothing on disk claims this dispatch — no subtree to reach
    const byAgentId = new Map<string, DescendantSidecar>()
    for (const meta of all) byAgentId.set(meta.agentId, meta)

    // Hops from the root, or undefined when this sidecar does not descend from it. Bounded exactly
    // like every other walk over `parentAgentId` here: the links come off an unvalidated flat
    // directory, so a malformed or cyclic one must resolve to nothing rather than spin.
    const depthBelowRoot = (meta: DescendantSidecar): number | undefined => {
      let cur = meta
      for (let hops = 1; hops <= DESCENDANT_DEPTH_MAX; hops++) {
        if (!cur.parentAgentId) return undefined
        if (cur.parentAgentId === rootAgentId) return hops
        const next = byAgentId.get(cur.parentAgentId)
        if (!next) return undefined
        cur = next
      }
      return undefined
    }

    const found: Array<{ agentId: string; depth: number }> = []
    for (const meta of all) {
      if (meta.agentId === rootAgentId) continue
      const depth = depthBelowRoot(meta)
      if (depth === undefined) continue
      // RUNNING only, for the same reason the surfaced tree is running-only: a sidecar is written once
      // and never deleted, so admitting "stale" would fire a stop at every grandchild that ever ran.
      if (descendantState(state, meta) !== "running") continue
      found.push({ agentId: meta.agentId, depth })
    }
    // DEEPEST FIRST. The stops are sequential and a still-running agent can dispatch another child
    // between two of them, so going bottom-up leaves no window where a freshly-spawned grandchild
    // outlives the parent that was already stopped.
    found.sort((a, b) => b.depth - a.depth)
    return found.map((entry) => entry.agentId)
  }

  // A descendant's liveness, in order of authority.
  //
  //  1. The provider's own task table, when it holds the row — its task id IS the agent id, and it says
  //     outright whether the child finished. Broker rows only; a row with no event stream has no table.
  //  2. This thread's own transcript: the descendant's terminal <task-notification>, folded by
  //     trackCompletions into `descendantTerminals`. Available on EVERY backend, because it rides the
  //     file the tailer already reads. See recordDescendantTerminal for why it exists.
  //  3. Silence, the coarse fallback — the same mtime rule every tracked child uses.
  //
  // (2) is measured against the transcript rather than trusted outright, because the same task-id
  // notifies again each time a resumable descendant stops: a transcript still advancing WELL past its
  // last notification is a descendant that was resumed, and it must read running again. "Well past" is
  // the grace below, not zero — the notification is written a beat after the descendant's own final
  // record, and the two instants come from different clocks (a record timestamp vs a file mtime).
  // Deliberately never "done" on a guess: a child that has merely gone quiet, with nothing having
  // reported it finished, still reads "stale".
  function descendantState(state: TailState, meta: DescendantSidecar): "running" | "stale" | "done" {
    const task = deps.runtimeTasks?.(state.sessionId).find((entry) => entry.taskId === meta.agentId)
    if (task?.terminal) return "done"
    const at = mtimeMs(descendantTranscript(state, meta))
    const notified = state.descendantTerminals?.get(meta.agentId)
    if (notified !== undefined && (at === undefined || at <= notified + DESCENDANT_NOTIFY_GRACE_MS)) return "done"
    return at === undefined || now() - at > SUBAGENT_STALE_MS ? "stale" : "running"
  }

  // How deep the surfaced tree goes. A bound, not an opinion: `parentAgentId` comes off an unvalidated
  // flat directory, so a malformed (or cyclic) link must not be able to recurse without end. Real
  // fan-out is 2-3 levels; anything past this is a broken sidecar, not a real orchestration.
  const DESCENDANT_DEPTH_MAX = 16

  // ---- RESTED roots: a child whose run ENDED while its own fan-out kept running -------------------
  //
  // `status: completed` does NOT mean a sub-agent is finished. The harness says so itself, in the very
  // notification that carries it (real bytes, nub session 5258ebe4, 2026-07-29):
  //
  //   <status>completed</status>
  //   <summary>Agent "Sweep corpus for system-library grants" finished</summary>
  //   <note>A task-notification fires each time this agent stops with no live background children of its
  //   own. The user can send it another message and resume it, so the same task-id may notify more than
  //   once.</note>
  //   <result>I've launched five parallel sweep agents … plus a Monitor … I'll continue once that
  //   notification lands.</result>
  //
  // That child had RESTED holding five live grandchildren, and its own transcript kept appending two
  // minutes later. frizz retired it on the notification (correctly — that is the only terminal signal it
  // gets) and the whole branch went dark: the root's row left every surface, and `rootedInAnchor` then
  // dropped its five RUNNING grandchildren too, because a descendant may only hang off a root the thread
  // still tracks. Six rows of live fan-out, invisible under the prompt box — for 107 s in that session,
  // and only because the coordinator happened to re-steer the child (trackResumes revives on the restart
  // ack); with no re-steer the branch stays invisible for as long as it runs. That is the bug this exists
  // to close, reported by the maintainer as "it totally disappeared from the UI".
  //
  // So a retired child STILL ANCHORS its subtree, and is surfaced as `rested` for exactly as long as
  // something under it is running. It self-retires on the same terms every descendant row does — when
  // the last live grandchild goes quiet, `shown` empties, the anchor produces no subtree, and the row
  // goes away. Nothing can dangle.
  //
  // `killed` is deliberately excluded. That status means the OPERATOR dismissed the row (the × says
  // "stop tracking this finished operation"), a `TaskStop` ended it, or the owning process died and a
  // new session swept it — each an explicit "this branch is over", which frizz must honour over any
  // mtime under it. Only the ambiguous terminals (`completed`/`failed`, the ones a resumable rest also
  // emits) keep anchoring.
  //
  // Ordered: live children in dispatch order first, then rested ones in retirement order.
  function anchorRoots(state: TailState): Set<string> {
    const out = new Set<string>()
    for (const entry of state.subAgents.values()) if (entry.kind === "agent") out.add(entry.toolUseId)
    for (const dead of state.retiredSubAgents.values()) if (dead.status !== "killed") out.add(dead.toolUseId)
    return out
  }

  // ---- the surfaced view of DESCENDANTS ----------------------------------------------------------
  //
  // `subAgents` used to be direct children only, so a worker that fanned out THROUGH a sub-agent showed
  // one row and the whole branch under it was invisible on every surface (rail, card, ops strip,
  // completion hold). The sidecars already describe that tree; this turns them into rows.
  //
  // RUNNING-ONLY, deliberately. A descendant's sidecar is written once at spawn and never deleted, so
  // admitting "stale" would pin a phantom row under the thread FOREVER, one per grandchild that ever
  // ran. Running is the only reading that retires itself — and since descendantState folds the
  // descendant's own terminal <task-notification>, a rested one stops reading `running` the tick that
  // notification lands rather than 15 minutes later. The one exception is an ancestor of something
  // running: it keeps its row even when quiet, because otherwise a live great-grandchild would have
  // nothing to indent under and would read as a child of the wrong agent.
  //
  // Returns subtrees keyed by the DIRECT child they hang off, each already in depth-first order, so the
  // caller can splice each one in directly behind its parent's row and get a tree by reading top down.
  // A key may name a RETIRED direct child — see anchorRoots.
  function descendantSubtrees(state: TailState, nowMs: number): Map<string, SubAgentView[]> {
    const empty = new Map<string, SubAgentView[]>()
    // Nothing tracked ⇒ nothing a descendant could hang off. This is the common case for most threads,
    // and returning here keeps the sidecar dir off the tick's disk path entirely. A RETIRED child counts
    // as tracked here (it can still anchor a live branch), which is why the ring is consulted too.
    if (state.subAgents.size === 0 && state.retiredSubAgents.size === 0) return empty
    const all = descendantSidecars(state)
    if (all.length === 0) return empty

    // Every reading below costs a stat per descendant, and this runs from BOTH the projection and the
    // change signature on the same tick. Memo per (sidecar-dir mtime, tracked-child counts, second) so
    // those calls collapse into one pass — a one-second grain is far finer than the staleness window it
    // feeds, so no running→gone transition is held back by it.
    // A newly-folded descendant terminal moves NONE of the other keys — a notification is a record in
    // this thread's transcript, not a file in the sidecar dir — so without counting them here the row
    // it retires would sit on the board until the second ticked over, and a test that ticks twice in
    // one millisecond would never see the retirement at all.
    const second = Math.floor(nowMs / 1000)
    const dirAt = descendantIndex.get(state.slug)?.at
    const terminals = state.descendantTerminals?.size ?? 0
    const memo = subtreeMemo.get(state.slug)
    if (memo && memo.at === dirAt && memo.second === second && memo.live === state.subAgents.size && memo.retired === state.retiredSubAgents.size && memo.terminals === terminals) return memo.value

    const byAgentId = new Map<string, DescendantSidecar>()
    for (const meta of all) byAgentId.set(meta.agentId, meta)
    // One stat per sidecar per pass, not per lookup — `shown` and the emit both need the reading.
    const liveness = new Map<string, "running" | "stale" | "done">()
    const stateOf = (meta: DescendantSidecar): "running" | "stale" | "done" => {
      const cached = liveness.get(meta.agentId)
      if (cached) return cached
      const value = descendantState(state, meta)
      liveness.set(meta.agentId, value)
      return value
    }

    const anchors = anchorRoots(state)

    // Walk to the depth-1 ancestor and check this thread is still tracking it, live or RESTED.
    const rootedInAnchor = (meta: DescendantSidecar): boolean => {
      let cur = meta
      for (let hops = 0; hops <= all.length; hops++) {
        if (!cur.parentAgentId) return Boolean(cur.toolUseId && anchors.has(cur.toolUseId))
        const next = byAgentId.get(cur.parentAgentId)
        if (!next) return false
        cur = next
      }
      return false // a cyclic parent link — resolves to nothing rather than looping
    }

    const shown = new Set<string>()
    for (const meta of all) {
      if ((meta.spawnDepth ?? 1) < 2 || !meta.toolUseId) continue
      if (stateOf(meta) !== "running" || !rootedInAnchor(meta)) continue
      // Mark it and every descendant ancestor above it (the depth-1 root already has its own row).
      let cur: DescendantSidecar | undefined = meta
      for (let hops = 0; cur && (cur.spawnDepth ?? 1) >= 2 && hops <= all.length; hops++) {
        shown.add(cur.agentId)
        cur = cur.parentAgentId ? byAgentId.get(cur.parentAgentId) : undefined
      }
    }
    const remember = (value: Map<string, SubAgentView[]>): Map<string, SubAgentView[]> => {
      subtreeMemo.set(state.slug, { at: dirAt, second, live: state.subAgents.size, retired: state.retiredSubAgents.size, terminals, value })
      return value
    }
    if (shown.size === 0) return remember(empty)

    // Group the shown rows under their parent's DISPATCH id — the same id the parent's own row carries,
    // which is what lets the client join the two without knowing anything about agent ids.
    const kids = new Map<string, DescendantSidecar[]>()
    for (const meta of all) {
      if (!shown.has(meta.agentId)) continue
      const parentId = meta.parentAgentId ? byAgentId.get(meta.parentAgentId)?.toolUseId : undefined
      if (!parentId) continue
      const list = kids.get(parentId)
      if (list) list.push(meta)
      else kids.set(parentId, [meta])
    }
    // Dispatch order, so siblings read the way the parent fanned them out rather than by agent id.
    for (const list of kids.values()) list.sort((a, b) => (a.spawnedAtMs ?? 0) - (b.spawnedAtMs ?? 0))

    const subtrees = new Map<string, SubAgentView[]>()
    for (const rootId of anchors) {
      const out: SubAgentView[] = []
      const walk = (parentId: string, depth: number): void => {
        if (depth > DESCENDANT_DEPTH_MAX) return
        for (const meta of kids.get(parentId) ?? []) {
          const id = meta.toolUseId
          if (!id) continue // unreachable — `shown` requires one — but the row's drill-in handle is not optional
          const activeAt = mtimeMs(descendantTranscript(state, meta))
          out.push({
            label: meta.description ?? "sub-agent",
            // The sidecar's own mtime IS the spawn instant (written once, never rewritten), so the row
            // gets the same real "working for 38s" duration a direct child gets from its dispatch record.
            startedAt: new Date(meta.spawnedAtMs ?? nowMs).toISOString(),
            state: stateOf(meta) === "running" ? "running" : "stale",
            ...(meta.agentType ? { subagentType: meta.agentType } : {}),
            id,
            ...(activeAt === undefined ? {} : { lastActivityAt: new Date(activeAt).toISOString() }),
            depth,
            parentId,
          })
          walk(id, depth + 1)
        }
      }
      walk(rootId, 2)
      if (out.length > 0) subtrees.set(rootId, out)
    }
    return remember(subtrees)
  }

  // Resolve a tracked sub-agent (thread slug + dispatch tool_use id) to its transcript path + state —
  // the drill-in drawer's server-side lookup. Checks the LIVE map first (running/stale), then the
  // RETAINED ring (a completed child kept for review → "done"). Undefined only when the id is unknown
  // to both (never dispatched, or aged out of the ring) → the router maps that to "gone".
  function subAgentLookup(slug: string, id: string): SubAgentLookup | undefined {
    const state = states.get(slug)
    if (!state || !registeredStateIsCurrent(state)) return undefined
    // `outputFormat` is spread in only when set, so a Claude child's lookup shape is byte-identical.
    const live = state.subAgents.get(id)
    // A background SHELL shares this map (see backgroundShellLookup) and is emphatically not an agent:
    // there is nobody in there to read a steer. Only kind "agent" is ever `direct`.
    if (live) return {
      outputFile: live.outputFile,
      ...(live.outputFormat ? { outputFormat: live.outputFormat } : {}),
      state: entryStale(state, live, now()) ? "stale" : "running",
      direct: live.kind === "agent",
      ...(live.taskId ? { taskId: live.taskId } : {}),
      startedAt: live.startedAt,
    }
    const dead = state.retiredSubAgents.get(id)
    if (dead) return {
      outputFile: dead.outputFile,
      ...(dead.outputFormat ? { outputFormat: dead.outputFormat } : {}),
      state: "done",
      direct: false,
      ...(dead.startedAt ? { startedAt: dead.startedAt } : {}),
      ...(dead.finishedAt ? { finishedAt: dead.finishedAt } : {}),
      outcome: dead.status,
    }
    // A DESCENDANT — a child of a child, of a child, at any depth. Its dispatch is in an ANCESTOR's
    // transcript rather than this thread's, so neither map above can hold it; the flat sidecar index
    // resolves it by the same tool_use id. Still undefined when nothing matches, so an id frizz genuinely
    // cannot place keeps degrading to the drawer's stated "unavailable" — this ADDS a resolution, it
    // never invents one.
    const descendant = descendantSidecar(state, id)
    if (!descendant) return undefined
    return {
      outputFile: descendantTranscript(state, descendant),
      state: descendantState(state, descendant),
      direct: false,
      // Claude's sidecar filename is `agent-<agentId>.meta.json`; that agent id is also the
      // provider task id accepted by Query.stopTask. Unlike steering, stopTask's registry is
      // session-wide, so descendants are addressable without pretending their dispatch belonged
      // to the root thread.
      taskId: descendant.agentId,
    }
  }

  // Resolve a child by its RUNTIME agent id (Claude's `agentId`) rather than by its dispatch tool_use
  // id — the identity an upward `SendMessage({to:"main"})` names itself with, and the one the transcript
  // fold can only translate when the dispatch's launch ack happens to sit inside the page it folded.
  //
  // That gap is why this exists. The paged `threadTranscript` RPC folds a BOUNDED window, so a report
  // near the tail whose dispatch scrolled above the page start has no description to wear and reads as
  // its profile cell instead of its work — while the socket's full-transcript read, seeing everything,
  // names it correctly. Same child, two producers, two different labels, which is precisely the
  // "sometimes these later resolve into the actual title" the maintainer saw (2026-08-06). The tailer
  // keeps the pairing for as long as it tracks the child at all, so it can answer where the page cannot.
  //
  // Live map first, then the retained ring, then the descendant sidecars — the same order and the same
  // never-invent-a-resolution rule as subAgentLookup above.
  function subAgentByTaskId(slug: string, taskId: string): { id: string; label: string } | undefined {
    const state = states.get(slug)
    if (!state || !registeredStateIsCurrent(state) || !taskId) return undefined
    for (const entry of state.subAgents.values()) {
      if (entry.kind === "agent" && entry.taskId === taskId) return { id: entry.toolUseId, label: entry.label }
    }
    for (const dead of state.retiredSubAgents.values()) {
      if (dead.taskId === taskId) return { id: dead.toolUseId, label: dead.label }
    }
    // A GRANDCHILD reporting past its own dispatcher: its dispatch lives in an ancestor's transcript, so
    // neither map above holds it, but its sidecar is filed under exactly this agent id.
    for (const meta of descendantSidecars(state)) {
      if (meta.agentId === taskId && meta.toolUseId && meta.description) {
        return { id: meta.toolUseId, label: meta.description }
      }
    }
    return undefined
  }

  /** Has this shell positively been confirmed gone? Cached, grace-windowed, and biased to "no": every
   *  uncertain answer leaves the shell running, so a wrong verdict can only ever under-report. */
  // PER TAILER, deliberately: a DEAD verdict is terminal and never re-probed, so a module-level cache
  // would let one tailer's verdict decide another's shells — and make the whole thing unclearable.
  const shellAliveCache = new Map<string, { at: number; alive: boolean }>()
  // Paths this tick wanted a verdict for and the cache could not answer. Assembly is synchronous, so
  // every shellIsGone call of one tick has landed here by the time the flush below runs — which is what
  // makes ONE lsof per tick enough for all of them, rather than one per shell.
  const shellProbeWanted = new Set<string>()
  let shellProbeInFlight = false
  let shellProbeArmed: ReturnType<typeof setTimeout> | undefined
  /** Arm the flush from whatever filled the queue. `shellIsGone` is reached through board ASSEMBLY, not
   *  through the tick, so hanging the flush off the tick would leave a queue that assembly filled and
   *  nothing drained until the tick after next. A zero timer is enough: assembly is synchronous, so one
   *  pass has queued every path it wants before this can fire. Unref'd so it never holds a test open. */
  function armShellProbeFlush(): void {
    if (shellProbeArmed) return
    shellProbeArmed = setTimeout(() => {
      shellProbeArmed = undefined
      flushShellProbes()
    }, 0)
    shellProbeArmed.unref?.()
  }
  function flushShellProbes(): void {
    if (shellProbeInFlight || shellProbeWanted.size === 0) return
    const batch = [...shellProbeWanted]
    shellProbeWanted.clear()
    shellProbeInFlight = true
    void probeShellsAlive(batch)
      .then((verdicts) => {
        for (const [file, alive] of verdicts) {
          if (alive === undefined) continue // cannot tell ⇒ record nothing, ask again next tick
          shellAliveCache.set(file, { at: now(), alive })
        }
        // A verdict that arrived after assembly changes what the board should say, and nothing else
        // will notice: the next tick reads the cache, so nudge it rather than waiting for one.
        if (verdicts.size > 0) deps.onChange()
      })
      .catch(() => {}) // a failed probe is an unknown verdict, and unknown never demotes a shell
      .finally(() => {
        shellProbeInFlight = false
      })
  }
  function shellIsGone(e: { outputFile?: string; startedAt: string }): boolean {
    if (!e.outputFile) return false
    const started = Date.parse(e.startedAt)
    if (!Number.isFinite(started) || now() - started < SHELL_PROBE_GRACE_MS) return false
    const cached = shellAliveCache.get(e.outputFile)
    // A DEAD verdict is terminal — a process cannot come back — so it is never re-probed.
    if (cached && (cached.alive === false || now() - cached.at < SHELL_PROBE_TTL_MS)) return !cached.alive
    // An INJECTED probe is answered inline. It is the test seam, and a caller who supplies one is
    // saying the answer is cheap; the batching below exists solely because the real one is not.
    if (deps.shellAlive) {
      const alive = deps.shellAlive(e.outputFile)
      if (alive === undefined) return false // cannot tell ⇒ unchanged
      shellAliveCache.set(e.outputFile, { at: now(), alive })
      return !alive
    }
    // The real probe costs ~300ms of blocked event loop, so it does NOT happen here. Queue it and
    // report the shell unchanged; the verdict lands in the cache and this reads it next tick.
    shellProbeWanted.add(e.outputFile)
    armShellProbeFlush()
    return false
  }

  function backgroundShellLookup(slug: string, id: string): { command?: string; outputFile?: string; state: "running" | "done" } | undefined {
    const state = states.get(slug)
    if (!state || !registeredStateIsCurrent(state)) return undefined
    const live = state.subAgents.get(id)
    if (live?.kind === "shell") {
      return { command: live.command, outputFile: live.outputFile, state: state.paneDead ? "done" : "running" }
    }
    const dead = state.retiredShells.get(id)
    if (dead) return { command: dead.command, outputFile: dead.outputFile, state: "done" }
    return undefined
  }

  // Manual DISMISS (the × on a live op row): retire a live sub-agent/shell by its dispatch tool_use id
  // exactly as a real terminal signal would — into the retained ring (so its drawer still resolves),
  // status "killed" — so it leaves every live surface (banner, counts, completion-hold, sidebar) at
  // once, and onChange() reflects that immediately instead of waiting for the next tick. This is the
  // escape hatch for the ONE residual the `stopped` recovery can't reach: a finished op whose completion
  // was never recorded while its parent stays alive. It is NOT a process kill — frizz tracks these by
  // folding the worker's transcript and does not own the child processes, so a genuinely-still-running
  // child ends only when the process owning it dies; the × just stops frizz showing a phantom. Returns whether
  // an entry was actually live to dismiss (a no-op for an unknown/already-gone id).
  function dismissOp(slug: string, id: string): boolean {
    const state = states.get(slug)
    if (!state || !registeredStateIsCurrent(state)) return false
    // DURABLE FIRST, and unconditionally — before the in-memory retirement and regardless of whether
    // anything was live to retire. The in-memory maps do not survive a frizz restart, and the op's
    // dispatch record does; a dismissal that lived only in memory is exactly how a killed shell came
    // back reading "57hr 18m" on the maintainer's board. Recording it for an id that is already gone
    // is harmless (the fold simply never mints it again) and is the honest reading of the click.
    state.dismissedOps.add(id)
    deps.storage.retireOp(slug, state.sessionId, id)
    const entry = state.subAgents.get(id)
    if (entry) {
      retireLive(state, entry, new Date(now()).toISOString(), "killed")
      deps.onChange()
      return true
    }
    // A RESTED root (see anchorRoots): already retired, but still surfaced because live descendants hang
    // off it. The × on that row means the same thing it means anywhere else — stop showing me this — so
    // re-stamp it `killed`, the one status that stops anchoring. The row keeps its place in the ring, so
    // its drawer still resolves; the branch leaves every live surface on the next frame.
    const dead = state.retiredSubAgents.get(id)
    if (!dead || dead.status === "killed") return false
    dead.status = "killed"
    // The subtree memo keys on the sidecar dir's mtime and the two map SIZES, none of which this touches,
    // so drop it explicitly — otherwise the click's own board frame would still carry the branch.
    subtreeMemo.delete(slug)
    deps.onChange()
    return true
  }

  interface PaneSniff {
    permPrompt: boolean
  }

  // A live PermissionRequest marker (Claude workers with the frizz plugin) is an ACTIVE block iff the
  // policy hook DEFERRED it to a human AND its timestamp is newer than the last transcript activity —
  // a resolved request always advances the transcript past it. The caller gates this on
  // turn === "in-flight" (a real block is always mid tool_use) and on the row being non-codex, which
  // both bounds the per-tick file read to actively-working Claude sessions and means a stale marker on
  // a crashed/exited row is inert (deriveRuntime returns "exited" before it ever consults permPrompt).
  function permMarkerBlocks(state: TailState, row: SessionRow): boolean {
    const marker = readPermMarker(row.slug)
    if (!marker) return false
    // Stale-generation guard, shared by BOTH readings below. `spawned_at` is bumped to the current
    // generation on every (re)spawn (storage.beginRuntimeGeneration), so a marker older than it was
    // written by a run that has already ended. This matters more than it looks: the marker file is
    // DURABLE and nothing ever unlinks perm-requests/<slug>.json, so a refusal from a previous run of
    // a thread is still on disk when it is re-dispatched — and the fresh TailState has no permPolicy
    // to dedupe against, so the retention below would re-adopt it and card an ancient refusal as if it
    // had just happened. An unparseable spawned_at skips the guard (never suppress a LIVE block, and
    // never drop a real refusal, on the strength of a timestamp we could not read).
    const spawnedMs = Date.parse(row.spawned_at)
    const priorGeneration = (at: number) => Number.isFinite(spawnedMs) && at < spawnedMs
    // RETAIN a DENIAL for display, separately from the block verdict below. Retained on the state
    // rather than recomputed per tick, so it survives the turn ending — a refusal stays readable after
    // the worker moves on, and it changed what the worker could do.
    // APPROVALS ARE DELIBERATELY NOT RETAINED. They were, on the theory that a silent auto-approval is
    // otherwise invisible (Claude Code reports "Allowed by PermissionRequest hook" in its own UI only
    // and writes nothing about an allow to the transcript). But this state has no clear: the note it fed
    // sat at the bottom of the thread FOREVER, long after the command it described, naming one
    // arbitrary `git status` as though it were the thread's standing condition. An approval is routine,
    // it blocks nobody, and the line answered no question anyone was asking (maintainer 2026-08-07:
    // "This message just showed up randomly, and now it's stuck showing up in the thread forever …
    // it's fucking useless").
    // KNOWN BOUND (documented, not hidden): the hook keeps ONE marker per thread, overwritten by the
    // next request, so this is the LAST denial observed, not a full history. Denials additionally land
    // in the transcript permanently (the model reads the refusal), which is the durable half.
    if (marker.decision === "deny") {
      const at = Date.parse(marker.at)
      if (Number.isFinite(at) && !priorGeneration(at) && at !== Date.parse(state.permPolicy?.at ?? "")) {
        state.permPolicy = {
          decision: "deny",
          rule: marker.rule ?? "unknown",
          reason: marker.reason ?? "",
          tool: marker.tool ?? null,
          at: marker.at,
          ...(marker.command ? { command: marker.command } : {}),
        }
        state.permDenies = (state.permDenies ?? 0) + 1
      }
    }
    // Policy-resolved requests are NOT human blocks. perm-policy.mjs records what it did, so an
    // auto-approved (or auto-denied) request leaves a marker exactly like a deferred one does — without
    // this gate every auto-approval would flash the thread onto "Needs you" for the tick before the
    // transcript advances past it, which is the very stall this hook exists to remove.
    if (markerDecision(marker) !== "defer") return false
    const at = Date.parse(marker.at)
    if (!Number.isFinite(at)) return false
    // A marker written BEFORE this generation's spawn belongs to an already-ended block — e.g. a worker
    // killed while parked on a prompt, then resumed. Without this, priming on the replayed old
    // transcript (lastActivityAt < at) would flash "Needs you" until the resume record lands.
    if (priorGeneration(at)) return false
    const last = state.lastActivityAt ? Date.parse(state.lastActivityAt) : Number.NEGATIVE_INFINITY
    return at > last
  }

  // Perm-blocked verdict for a session, and the structured PermissionRequest marker is now the ONLY
  // source — precise (it fires exactly when Claude created the prompt), so it surfaces immediately with
  // no quiet-gate delay and cannot false-trip on transcript text that merely LOOKS like a prompt. The
  // fallback it used to have read a quiet in-flight turn's rendered screen, which covered the screens
  // that emit no PermissionRequest (pre-boot workspace-trust, /login and other selectors) and
  // plugin-less foreign sessions; a headless worker renders no screen, so that cover went with it. The
  // native structured detector (Codex) rode the same capture; every approval it used to scrape off the
  // TUI now reaches frizz as a typed request on the app-server channel (see codex-app-server.ts —
  // item/commandExecution/requestApproval, item/fileChange/requestApproval,
  // item/permissions/requestApproval and MCP elicitation, each raised through interactionRequest).
  //
  // KNOWN EDGE (accepted): a background sub-agent completing WHILE the parent is blocked appends a
  // system user-record that advances lastActivityAt past the marker, so permMarkerBlocks reads false.
  // That used to degrade to the regex fallback, which re-detected the real modal after a 4s quiet gate;
  // with no fallback left, the block stays unreported until the request resolves or the hook writes a
  // newer marker.
  function sniffPane(
    state: TailState,
    row: SessionRow,
    turn: TurnState,
    nowMs: number,
    backend: TailBackend,
  ): PaneSniff {
    void nowMs; void backend
    if (state.foreign) return { permPrompt: false }
    // The MARKER path is all that is left, and it is the one that always worked headlessly: the
    // cc-worker hook writes a marker into FRIZZ_PERM_DIR when a tool call is waiting on the operator.
    // Below this there used to be a fallback that captured the worker's rendered terminal and matched
    // the TUI's modal chrome by regex — the only way to see a prompt on a screen. No worker renders one
    // now, and a broker thread's approvals arrive as typed permission requests over the control channel
    // anyway.
    if (turn === "in-flight" && row.backend !== "codex" && permMarkerBlocks(state, row)) {
      return { permPrompt: true }
    }
    return { permPrompt: false }
  }

  // Write out the un-retirements the FOLD queued: an op the agent restarted under an id the operator
  // had dismissed is live work again, so the registry row has to go.
  //
  // Called from EVERY tick, not just the prime. It lived inline beside the prime, which ends in
  // `continue` — but a SendMessage restart is folded on an ordinary tick, so its un-retirement was
  // queued and never written. `retired_op` went on asserting a dismissal the fold had already
  // superseded, and the next re-prime deleted a child that was genuinely running. Idempotent (a
  // DELETE by exact key), so running it per tick costs nothing when the set is empty, which is
  // nearly always.
  function drainUnretiredOps(state: TailState, row: SessionRow): void {
    if (!state.unretiredOps?.size) return
    for (const id of state.unretiredOps) deps.storage.unretireOp(row.slug, row.session_id, id)
    state.unretiredOps.clear()
  }

  const states = new Map<string, TailState>()
  // FOREIGN thread tails, keyed by session id (separate map so a session-id key can never collide
  // with or shadow a registered slug's TailState in `states`). Entries persist once discovered — a
  // file that ages out of the fresh set keeps its cached tail here but stops being reported.
  const foreignStates = new Map<string, TailState>()
  // The current fresh foreign set (mtime-desc, capped), refreshed on scan ticks and reused between.
  let foreignFresh: { id: string; path: string; backend: "claude" | "codex"; title?: string }[] = []
  let foreignScanTick = 0
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  // Set for the duration of the FIRST tick only (see start): the launcher's progress signal.
  let primeProgress: ((done: number, total: number) => void) | undefined

  // Every id a registry row OWNS, in any of the three columns a transcript can be keyed by, plus the
  // graveyard. A foreign scan that misses one of these surfaces a DUPLICATE of a thread frizz is
  // already driving — read-only, unsteerable, and sitting in a band that promises the opposite.
  //   • `session_id`       — the frizz-minted id; for Claude it IS the transcript's name.
  //   • `transcript_id`    — a DISCOVERED (drifted) transcript, owned by its row.
  //   • `agent_session_id` — the backend's OWN id where it differs. Codex mints its rollout id itself,
  //                          so this is the ONLY column that names a codex thread's file. Omitting it
  //                          made every dispatched codex thread come back as its own foreign twin.
  function registeredIds(): Set<string> {
    const registered = new Set<string>()
    for (const r of deps.storage.allSessions()) {
      registered.add(r.session_id)
      if (r.transcript_id) registered.add(r.transcript_id)
      if (r.agent_session_id) registered.add(r.agent_session_id)
    }
    // A transcript whose row was hard-deleted via forgetSession must STAY gone — never let a dismissed
    // phantom's file re-surface as a read-only foreign thread on a later rescan.
    for (const id of deps.storage.forgottenIds()) registered.add(id)
    return registered
  }

  // The CODEX half of foreign discovery. Claude shards transcripts by birth cwd, so its scan is one
  // readdir of this project's own directory; codex keeps one global tree for every project on the
  // machine, so the project filter lives inside each rollout and the scan is delegated to the codex
  // backend, which owns that format. See scanForeignRollouts for the cost measurements that make it
  // affordable and for the two filters (sub-agent children, project cwd) it applies.
  //
  // Both cwd spellings are offered because a rollout records the cwd the codex PROCESS had, which on
  // macOS resolves symlinks — a project frizz knows as `/tmp/x` writes `/private/tmp/x`.
  function scanForeignCodex(nowMs: number): { id: string; path: string; title?: string }[] {
    if (!deps.project.dir) return []
    const cwds = new Set<string>([deps.project.dir])
    try {
      cwds.add(realpathSync(deps.project.dir))
    } catch {
      // an unreadable project dir simply contributes no alias
    }
    try {
      const home = deps.codexHome ?? defaultCodexHome()
      const found = scanForeignRollouts(
        { cwds: [...cwds], nowMs, freshMs: FOREIGN_FRESH_MS, exclude: registeredIds(), max: FOREIGN_MAX },
        home,
      )
      // Codex's OWN name for the thread, where it has one. Read only when the scan actually found
      // something, so an ordinary tick on a project with no external codex sessions never opens the
      // sidecar at all.
      const names = found.length ? readCodexThreadNames(home) : undefined
      return found.map((f) => ({ ...f, ...(names?.get(f.id) ? { title: names.get(f.id) } : {}) }))
    } catch {
      return []
    }
  }

  // Discover FOREIGN sessions: *.jsonl in the log dir whose stem is not any registered row's
  // session_id, touched within FOREIGN_FRESH_MS, most-recent-first, capped at FOREIGN_MAX. Registered
  // rows always win. Defensive: any fs error (dir/file) is skipped silently — discovery degrades to
  // "no foreign threads", never throws.
  function scanForeign(nowMs: number): { id: string; path: string }[] {
    let names: string[]
    try {
      names = readdirSync(logDir)
    } catch {
      return []
    }
    const registered = registeredIds()
    const found: { id: string; path: string; mtime: number }[] = []
    for (const name of names) {
      if (name.startsWith(".") || !name.endsWith(".jsonl")) continue
      const id = name.slice(0, -".jsonl".length)
      if (!id || registered.has(id)) continue // registered rows win — never also foreign
      const path = join(logDir, name)
      let mtime: number
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        continue
      }
      if (nowMs - mtime > FOREIGN_FRESH_MS) continue // aged out of the freshness window
      found.push({ id, path, mtime })
    }
    found.sort((a, b) => b.mtime - a.mtime)
    return found.slice(0, FOREIGN_MAX).map(({ id, path }) => ({ id, path }))
  }

  // Tail one FOREIGN state: same fold/derivation as a registered session (consume → computeTurn →
  // derivedSignature, priming the first sighting silently) but with NO permission sniff, NO owner-death
  // check, and NO notify / storage write — frizz never dispatched a foreign thread, so it has no
  // frizz-owned runtime and no registry row.
  // Returns whether its derived telemetry changed (→ board dirty). Pushes to transcriptDirty on bytes.
  function tailForeign(state: TailState, nowMs: number, transcriptDirty: string[], backend: TailBackend): boolean {
    const key = `foreign:${state.slug}`
    if (!state.primed) {
      const primeOffset = state.offset
      consume(state, backend)
      if (state.offset !== primeOffset) transcriptDirty.push(state.slug)
      state.turn = computeTurn(state, nowMs)
      state.subAgentsSig = derivedSignature(state, nowMs)
      state.primed = true
      // Foreign maintainer terminals are the LARGEST transcripts on the board (a day of a human's own
      // Claude session) and there are up to FOREIGN_MAX of them, so they are worth caching for exactly
      // the same reason registered rows are.
      if (state.offset !== primeOffset || !cacheHydrated.has(key)) cacheDirty.add(key)
      cacheHydrated.delete(key)
      return true // surface the newly-discovered thread
    }
    const prevActivity = state.lastActivityAt
    const prevAssistant = state.lastAssistant
    const prevModel = state.model
    const prevEffort = state.effort
    const prevPermissionMode = state.permissionMode
    const prevOffset = state.offset
    consume(state, backend)
    if (state.offset !== prevOffset) {
      transcriptDirty.push(state.slug)
      cacheDirty.add(key)
    }
    let dirty = false
    const nextTurn = computeTurn(state, nowMs)
    if (state.turn !== nextTurn) {
      state.turn = nextTurn // foreign: a turn transition NEVER notifies or writes storage
      dirty = true
    }
    const sig = derivedSignature(state, nowMs)
    if (sig !== state.subAgentsSig) {
      state.subAgentsSig = sig
      dirty = true
    }
    if (
      state.lastActivityAt !== prevActivity ||
      state.lastAssistant !== prevAssistant ||
      state.model !== prevModel ||
      state.effort !== prevEffort ||
      state.permissionMode !== prevPermissionMode
    ) dirty = true
    return dirty
  }

  // Delivery-ledger fold for one registered CLAUDE row's tick: `onLine` correlates each appended JSONL
  // record against the row's pending follow-ups (delivery-ledger.ts); `finish()` ages the items
  // (pending→unconfirmed timeout, unconfirmed drop) and persists any transition, returning true so the
  // caller re-projects the transcript + dirties the board. Rows with an empty ledger cost one null
  // check. CODEX rows fold too now: their ledger entry is a rendering guarantee for the queued bubble
  // (the app-server bridge still owns delivery and dedups on deliveryId), and correlateDeliveryRecord
  // recognises the rollout's own user-message shape so the entry drops the moment codex materialises
  // the message.
  // The delivery-ledger fold and the codex sub-agent tracker were mutually exclusive while the ledger
  // was claude-only; a codex row now runs BOTH, so the single per-line hook `consume` accepts has to
  // carry them together. Returns undefined when neither applies, so the common path is unchanged.
  function chainOnLine(
    a: ((line: string) => void) | undefined,
    b: ((line: string) => void) | undefined,
  ): ((line: string) => void) | undefined {
    if (!a) return b
    if (!b) return a
    return (line: string) => { a(line); b(line) }
  }

  // Drop the sends that died with the process holding them, at the ONE moment that can be said
  // honestly: after this tick's records have been correlated out of `items`, so anything the agent
  // actually read is already gone from the list, and only against a daemon frizz can PROVE is dead.
  //
  // `pending`/`enqueued` are both claims about a live process — one was handed the message, one
  // receipted it into its own queue. When that daemon is gone the claim is false, but the row survives
  // for the rest of UNCONFIRMED_DROP_MS: an hour of a gray "queued" bubble pinned under the transcript
  // for a message nobody will ever read, and the unqueue click cannot clear it either — it asks the
  // CURRENT daemon to cancel a uuid it never heard of, gets `false`, and answers "Too late — that
  // message has already left the queue", which is exactly backwards. Same shape, and the same words, as
  // the restart path's `retireOutstandingDeliveries`; a death is the same positive evidence a restart is.
  //
  // DROPPED, not tombstoned, for that function's reason: a tombstone would suppress a matching JSONL
  // enqueue bubble, hiding a message that DID land in the sliver before the death. This only stops
  // frizz projecting its own synthetic bubble; nothing about the real message is touched.
  //
  // BROKER-ONLY. `paneDeadForRow` is the reading that fails safe to ALIVE (defaultBrokerDaemonAlive
  // answers "dead" only on a positively ABSENT discovery record or an ESRCH pid probe), so this can
  // only ever retire sends frizz can prove are stranded. Observed 2026-08-11 on
  // `in-codex-threads-tool-calls-ike`: receipted 19:45:05.771, daemon dead 760ms later.
  function retireDeliveriesLostWithTheDaemon(
    row: SessionRow,
    items: DeliveryLedgerItem[],
  ): DeliveryLedgerItem[] {
    if (!items.length || !isBrokerClaudeRow(row) || !paneDeadForRow(row)) return items
    const next = items.filter((item) => item.state !== "pending" && item.state !== "enqueued")
    return next.length === items.length ? items : next
  }

  // `state` is read ONLY in finish(), and that is load-bearing: `ageDeliveries` needs the newest user
  // record this thread has produced INCLUDING the lines this very tick just folded, which is what makes a
  // send the correlator failed to attribute drop on the same pass that recorded its delivery.
  function ledgerFold(
    row: SessionRow,
    nowMs: number,
    state: TailState,
  ): { onLine?: (line: string) => void; finish: () => { changed: boolean; value: string | null } } {
    if (!row.delivery_ledger) {
      return { finish: () => ({ changed: false, value: null }) }
    }
    let items: DeliveryLedgerItem[] = parseDeliveryLedger(row.delivery_ledger)
    const before = items
    const nowIso = new Date(nowMs).toISOString()
    return {
      onLine: (line: string) => {
        if (!line.trim() || !items.length) return
        let rec: unknown
        try {
          rec = JSON.parse(line)
        } catch {
          return
        }
        items = correlateDeliveryRecord(items, rec, nowIso)
      },
      finish: () => {
        items = retireDeliveriesLostWithTheDaemon(row, items)
        items = ageDeliveries(items, nowMs, state.lastUserAt)
        if (items === before) return { changed: false, value: null }
        const value = serializeDeliveryLedger(items)
        deps.storage.setDeliveryLedger(row.slug, value)
        return { changed: true, value }
      },
    }
  }

  // The CODEX counterpart of trackDispatches: codex's sub-agent signals (`spawn_agent`,
  // sub_agent_activity, list_agents) live on their own axis rather than in NormalizedEvent, so they
  // ride the same per-line `consume(..., onLine)` seam the delivery ledger uses — and the two never
  // collide, because ledgerFold is claude-only and this is codex-only. The tracker writes straight
  // into this state's live/retired maps, so the board strip, hasLiveOps, the completion-hold dialog
  // and the drill-in drawer all light up for codex with no further plumbing. Returns undefined for a
  // claude row (one string compare) so the claude path is byte-identical.
  function codexSubAgentOnLine(row: SessionRow, state: TailState): ((line: string) => void) | undefined {
    if (row.backend !== "codex") return undefined
    const tracker = (state.codexSubAgents ??= createCodexSubAgentTracker({
      codexHome: deps.codexHome,
      sink: {
        setLive: (id, e) => {
          const previous = state.subAgents.get(id)
          state.subAgents.set(id, {
            kind: "agent",
            toolUseId: id,
            label: e.label,
            startedAt: e.startedAt,
            subagentType: e.subagentType,
            // Only ever set once the child's rollout is located; until then the entry is live with no
            // file, which entryStale correctly reads as "just starting up", not stale.
            outputFile: e.outputFile ?? previous?.outputFile,
            outputFormat: "codex",
          })
        },
        retire: (id, finishedAt, status) => {
          const entry = state.subAgents.get(id)
          if (entry) retireLive(state, entry, finishedAt, status)
        },
      },
    }))
    return (line: string) => tracker.onLine(line)
  }

  // ---- durable prime cache (tail-cache.ts) ------------------------------------------------------
  // Loaded lazily on the first tick, consumed once per slug. Entries that miss their fence are simply
  // never applied: the row then folds from byte 0, exactly as it always did.
  let cacheEntries: Map<string, TailCacheEntry> | null = null
  // Slugs whose cached entry is stale (or absent) and must be (re)written at the next flush.
  const cacheDirty = new Set<string>()
  // Slugs that were restored from the cache on this boot — used to skip rewriting an entry that is
  // already byte-accurate, so a warm boot of thousands of threads writes nothing at all.
  const cacheHydrated = new Set<string>()
  let cachePruned = false
  let lastCacheFlushMs = 0

  // Registered slugs and FOREIGN thread ids live in separate namespaces (the tailer keeps two maps for
  // exactly that reason), so they get separate key spaces in the one cache table too.
  const cacheKey = (state: TailState): string => (state.foreign ? `foreign:${state.slug}` : state.slug)

  // Restore a freshly-created state from the durable cache so the prime below resumes the fold at the
  // cached byte offset instead of at 0. `row` is null for a foreign thread (it has no registry row).
  // Returns true only when EVERY fence held. Any doubt — a different session/generation, a different
  // transcript path, an open delivery ledger, a file whose inode/size/content moved under the cached
  // prefix, an undecodable blob — returns false and leaves the state untouched, which is the full
  // re-read.
  // The cached entry must name the SAME transcript this state is bound to, which is normally string
  // equality. ONE widening: a project directory renamed since the entry was written leaves the same
  // `<sessionId>.jsonl` in a different bucket (see discover.ts), and hydrate runs BEFORE the recovery
  // in resolveTranscript that rebinds to it — so on the directory alone every stranded thread would
  // re-fold from byte 0 on EVERY boot, forever, instead of once. The FILENAME is a strong identity
  // here: it is the pinned session id, and the sessionId / nativeSessionId / generation fences above
  // have already matched. `measureFence(entry.path, …)` below still validates the file that is actually
  // there, and accepting the entry ALSO REBINDS the state to the bucket the transcript really lives in —
  // which is exactly what the recovery would do.
  //
  // That last clause used to read "`path` round-trips through the encoded state", and it was false:
  // `path` is in UNRESTORED_TAIL_FIELDS, so the hydration loop skips it. The rebind is now made
  // explicitly at the end of hydrateFromCache; see the note there for the five-day freeze that cost.
  function samePinnedTranscript(cached: string, bound: string): boolean {
    return cached === bound || basename(cached) === basename(bound)
  }

  function hydrateFromCache(state: TailState, row: SessionRow | null, nativeId: string): boolean {
    if (!tailCache) return false
    if (cacheEntries === null) cacheEntries = tailCache.load()
    const key = cacheKey(state)
    const entry = cacheEntries.get(key)
    if (!entry) return false
    cacheEntries.delete(key) // one shot: a rebind within this process must re-derive, not re-restore
    if (
      entry.sessionId !== (row ? row.session_id : state.sessionId) ||
      entry.nativeSessionId !== nativeId ||
      entry.runtimeGeneration !== (row ? row.runtime_generation ?? 0 : 0) ||
      !samePinnedTranscript(entry.path, state.path)
    ) return false
    // A row with an OPEN delivery ledger has follow-ups whose evidence may still be sitting in the
    // prefix we would skip. Correlating those records is the ledger's whole job, so such a row keeps
    // the full replay — there are only ever a handful, and they are the actively-steered threads.
    if (row?.delivery_ledger) return false
    // A CODEX row keeps the full replay too. This prime cache predates the codex sub-agent tracker
    // (`state.codexSubAgents`, a live object with methods) and cannot round-trip it — a restored plain
    // blob has no `.poll`. And resuming the parent fold mid-file would skip the `spawn_agent` records
    // in [0, offset) the tracker rebuilds itself from. Codex threads full-replay exactly as before.
    if (row?.backend === "codex") return false
    const current = measureFence(entry.path, entry.offset)
    if (!current || !fenceMatches(entry, current)) return false
    const decoded = decodeTailState(entry.state)
    if (!decoded) return false
    if (decoded.offset !== entry.offset || typeof decoded.partial !== "string") return false
    // Lifecycle collections must survive the round trip with their native collection types; a plain
    // object here crashes the incremental fold on the first completion after restart.
    for (const field of ["subAgents", "retiredSubAgents", "queuedReports", "retiredShells"]) {
      if (!(decoded[field] instanceof Map)) return false
    }
    if (!(decoded.deliveredReports instanceof Set)) return false
    // A state cached by a build BEFORE the ownership gate carries no `ownedToolUseIds`, and restoring
    // that would leave the set empty while the fold resumes past every dispatch that filled it — so
    // every op would read as foreign and NO report would ever be repaired again. Reject the cache and
    // re-fold instead; it is one replay, once, per thread across the upgrade.
    if (!(decoded.ownedToolUseIds instanceof Set)) return false
    // `Record` is shadowed in this module by the JSONL record interface — spell the index type out.
    const target = state as unknown as { [key: string]: unknown }
    for (const [key, value] of Object.entries(decoded)) {
      if (UNRESTORED_TAIL_FIELDS.has(key)) continue
      target[key] = value
    }
    // THE REBIND THE WIDENING PROMISES. `samePinnedTranscript` accepts an entry from ANOTHER BUCKET —
    // a renamed checkout — and its note says accepting it "also rebinds the state to the bucket the
    // transcript really lives in". It did not: `path` is in UNRESTORED_TAIL_FIELDS (identity comes from
    // the live row, never the cache), so the loop above skips it and the state keeps the derived path,
    // which for a stranded thread is a file that does not exist. `resolveTranscript` then short-circuits
    // on the restored `offset > 0` — "already bound to a real transcript" — so the recovery that WOULD
    // have rebound it never runs, and every later `consume` reads nothing. The thread goes permanently
    // deaf at the byte it was cached on, with no error anywhere: `i-want-a-way-to-run` sat frozen at
    // 2026-08-19 for five days while its worker went on answering 1.36 MB further down the same file,
    // including a follow-up the operator sent and watched vanish (2026-08-24).
    //
    // Two mechanisms, each right on its own, fatal together. The rebind has to be made HERE, explicitly,
    // because this is the only place that knows the widening fired.
    if (entry.path !== state.path) {
      // …unless the derived path has content of its own. Then there are two real files and the offset
      // was measured against only one of them, so binding either is a guess — take the full re-fold
      // instead, which is what this cache costs at worst.
      let derivedSize = 0
      try {
        derivedSize = statSync(state.path).size
      } catch {
        derivedSize = 0
      }
      if (derivedSize > 0) return false
      state.path = entry.path
    }
    cacheHydrated.add(key)
    return true
  }

  // The durable record of `state` at its current byte cursor, or null when it must not be cached: a
  // state bound to nothing yet, a row with an open delivery ledger, or a file that will not stat/read.
  function cacheSnapshot(state: TailState, row: SessionRow | null): TailCacheEntry | null {
    // Codex rows are never cached — the prime cache predates their live sub-agent tracker and cannot
    // round-trip it (see hydrateFromCache). Never persisting them keeps hydrate a guaranteed miss.
    if (state.offset <= 0 || row?.delivery_ledger || row?.backend === "codex") return null
    const fence = measureFence(state.path, state.offset)
    if (!fence) return null
    return {
      slug: cacheKey(state),
      sessionId: state.sessionId,
      nativeSessionId: state.nativeSessionId,
      runtimeGeneration: state.runtimeGeneration,
      path: state.path,
      state: encodeTailState(state),
      ...fence,
    }
  }

  // Persist every dirty state in one transaction. Best-effort by construction — a failure costs the
  // next boot its speedup and nothing else.
  function flushCache(nowMs: number): void {
    if (!tailCache) return
    lastCacheFlushMs = nowMs
    if (!cachePruned) {
      cachePruned = true
      try {
        const live = new Set<string>()
        for (const row of deps.storage.allSessions()) live.add(row.slug)
        for (const id of foreignStates.keys()) live.add(`foreign:${id}`)
        tailCache.prune(live)
      } catch {
        // a stale row can only ever fail its fence
      }
    }
    if (cacheDirty.size === 0) return
    const entries: TailCacheEntry[] = []
    try {
      for (const key of cacheDirty) {
        const foreign = key.startsWith("foreign:")
        const state = foreign ? foreignStates.get(key.slice("foreign:".length)) : states.get(key)
        if (!state) continue
        const row = foreign ? null : deps.storage.getSession(key) ?? null
        if (!foreign && !row) continue
        const entry = cacheSnapshot(state, row)
        if (entry) entries.push(entry)
      }
    } catch {
      // stop() flushes on the shutdown path; a registry that has already gone away must not turn a
      // clean shutdown into a failed one. Whatever was collected before the fault is still written.
    }
    cacheDirty.clear()
    tailCache.put(entries)
  }

  // Read whatever has been appended since our last offset, folding each complete line into the
  // derivation. Handles: file-not-yet-created (ENOENT → skip), truncation/rotation (size < offset
  // → re-read from 0), and a trailing partial line (buffered until its newline arrives).
  // `onLine` (optional) sees each complete appended line AFTER the fold — the delivery-ledger
  // correlation seam for registered Claude rows; unset everywhere else (zero cost).
  function consume(state: TailState, backend: TailBackend, onLine?: (line: string) => void): void {
    let size: number
    try {
      size = statSync(state.path).size
    } catch {
      return // file not written yet (agent still booting) or transiently unreadable
    }
    if (size < state.offset) {
      // truncated/rotated — restart the derivation from the top of the new file
      state.offset = 0
      state.partial = ""
    }
    if (size <= state.offset) return
    // SPLIT ON THE BUFFER; only a single LINE is ever turned into a string.
    //
    // The read used to do `buf.toString()` over the whole delta. Fine for the incremental case it was
    // written for — a few KB a tick — and silently fatal for a cold prime of a big transcript: Node
    // caps a string at ~512 MB (buffer.constants.MAX_STRING_LENGTH), so a 565 MB file threw
    // ERR_STRING_TOO_LONG, the catch below swallowed it, and the row NEVER primed. Not once, not on a
    // later tick — no ai-title, no sub-agents, no background shells, forever, on the busiest thread on
    // the machine. It hid because a long-lived server primes a transcript while it is still small and
    // only reads the delta afterwards; only a restart re-primes from zero and meets the real size.
    //
    // Splitting on the BUFFER removes the cap entirely rather than working around it: the largest
    // string this function now builds is one JSONL record. Scanning for 0x0A is safe on UTF-8 without
    // any decoder, because every byte of a multi-byte sequence is >= 0x80 — a newline byte can only
    // ever BE a newline, never part of a character. The carry between windows is a Buffer for the same
    // reason, and it is copied because `buf` is reused by the next read.
    let carry = state.partial ? Buffer.from(state.partial, "utf8") : EMPTY_BUFFER
    try {
      const fd = openSync(state.path, "r")
      try {
        const buf = Buffer.allocUnsafe(Math.min(TRANSCRIPT_READ_WINDOW, size - state.offset))
        while (state.offset < size) {
          const read = readSync(fd, buf, 0, Math.min(buf.length, size - state.offset), state.offset)
          if (read <= 0) break
          state.offset += read
          const view = carry.length ? Buffer.concat([carry, buf.subarray(0, read)]) : buf.subarray(0, read)
          let start = 0
          for (;;) {
            const nl = view.indexOf(0x0a, start)
            if (nl === -1) break
            const line = view.toString("utf8", start, nl)
            backend.foldLine(state, line)
            onLine?.(line)
            start = nl + 1
          }
          carry = start < view.length ? Buffer.from(view.subarray(start)) : EMPTY_BUFFER
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      // A read that raced a write/unlink stops here. Whatever was folded stays folded and
      // `state.offset` matches it exactly, so the next tick resumes rather than repeating.
      state.partial = carry.toString("utf8")
      return
    }
    state.partial = carry.toString("utf8") // the (possibly empty) trailing partial line
  }

  // Every OTHER row's pinned + discovered id — the exclude set so discovery never steals a transcript
  // already claimed by a different thread. (Only called on a real discovery attempt, which is rare.)
  function claimedIds(exceptSlug: string): Set<string> {
    const ids = new Set<string>()
    for (const r of deps.storage.allSessions()) {
      if (r.slug === exceptSlug) continue
      ids.add(r.session_id)
      if (r.transcript_id) ids.add(r.transcript_id)
    }
    return ids
  }

  // Record a stalled worker's boot-failure evidence ONCE, to the server console + a per-session sink.
  // This used to capture the dead worker's frozen final screen, which held claude's own error text;
  // with no screen left to read, what survives is a pointer to the evidence that DOES exist for the
  // row's runtime (see `detail` below). Best-effort — the whole point is root-causing the missing
  // transcript, so a failure to write the sink must never break the tick.
  function captureStall(state: TailState, row: SessionRow): void {
    if (state.stallLogged) return
    // "No transcript 60s after dispatch" is a BOOT-FAILURE alarm: it means a worker the operator just
    // started never came up, and it is worth an ERROR. An `exited` AND archived row is neither starting
    // nor watched — it is a thread the operator finished with and filed away, and its missing transcript
    // is settled history. Re-announcing it is pure noise, and because `stallLogged` is deliberately not
    // restored from the tail cache (see UNRESTORED_TAIL_FIELDS) it was re-announced on EVERY boot: 80
    // ERROR lines for 10 threads dead 12–46 days, in the same startup window an operator reads to find
    // out why the server just restarted. The row still flags `noTranscript` in resolveTranscript, so the
    // board's degraded state is unchanged — only the alarm is suppressed.
    //
    // Deliberately BEFORE the one-shot latch, not after: an archived row consumes no alarm. If it is
    // ever reopened and still cannot bind, that is a live problem again and gets its one ERROR then.
    if (row.exited && rowIsArchived(row)) return
    state.stallLogged = true
    // A headless row never had a terminal to capture, so the generic "Pane: (pane empty / unavailable)"
    // line sent whoever read it hunting a terminal multiplexer for a runtime that never had one —
    // measured cost on 2026-07-31, a real boot failure investigated at the wrong layer first. Name the
    // evidence that DOES exist for this runtime instead: for the broker that is the daemon's own
    // diagnostics log, which records the session's lifecycle and any dropped input.
    //
    // This is now the WHOLE detail, because the screen capture that used to precede it is gone: no
    // runtime frizz drives renders a terminal, and nothing wired a capture into the tailer. The
    // boot-failure auth classifier that read the captured text (`isClaudeAuthErrorText` over the frozen
    // final screen, setting authFault="authentication_rejected") went with it — it had been running on
    // the empty string. The fold-side classifier is unaffected and is the live one: applyRecord sets
    // the same authFault from a real isApiErrorMessage 401/login record in the transcript.
    const detail = isBrokerClaudeRow(row) && deps.project.stateDir
      ? `no worker terminal to capture (broker runtime). Daemon diagnostics: ${claudeBrokerDiagnosticLogPath(deps.project.stateDir, row.session_id)}`
      : isHeadlessRow(row)
      ? `no worker terminal to capture (headless ${row.backend === "codex" ? "codex app-server" : "claude broker"} runtime)`
      // Neither runtime above, i.e. a pre-cutover row. Nothing in this build captures anything, so the
      // old "(pane empty / unavailable)" described output that SHOULD have existed and sent the reader
      // hunting for a screen that cannot exist. Say why there is nothing instead.
      : "no worker output captured (this build captures no terminal)"
    frizzLog.error(
      "tailer",
      `thread ${row.slug} (session ${row.session_id}): no transcript ${DISCOVERY_GRACE_MS / 1000}s after dispatch — likely a boot failure. ${detail.slice(0, 4000)}`,
    )
    try {
      mkdirSync(stallLogDir, { recursive: true })
      writeFileSync(join(stallLogDir, `${row.slug}.stall.log`), `session_id: ${row.session_id}\ncaptured_at: ${new Date(now()).toISOString()}\n\n${detail}\n`)
    } catch {
      // best-effort — a missing sink is inert
    }
  }

  // Where a BOUND transcript went when it stopped being where we left it. Two candidates: the file's
  // DETERMINISTIC home under this project's own log dir, and whatever `discoverTranscriptDir` finds in
  // a sibling bucket. The home has to be probed SEPARATELY because that function will never name it —
  // for its original caller `logDir` is the one place already known to have missed — and a transcript
  // can move back as easily as away.
  //
  // Both candidates go through `mtimeOfNonEmpty`, and the NEWEST non-empty one wins. Neither half of
  // that is optional. Emptiness, because a worker can leave a permanent 0-byte `<id>.jsonl` behind and
  // the unbound path 40 lines below already refuses to bind one ("presence alone isn't enough").
  // Freshness, because one session id legitimately names two files at once — a small live one and a
  // large stale one, measured 2026-08-11 and written up at discover.ts:185 — and `discoverTranscriptDir`
  // resolves that same tie the same way precisely because losing the coin flip renders a truncated
  // conversation. Returning `home` on bare existence would have skipped the tie-break for exactly one
  // of the two candidates, which is the coin flip with a thumb on it. Undefined = nothing anywhere else
  // holds a non-empty file for this id.
  function relocatedTranscript(state: TailState): string | undefined {
    const name = `${state.nativeSessionId}.jsonl`
    const home = join(logDir, name)
    const homeAt = home === state.path ? undefined : mtimeOfNonEmpty(home)
    const dir = discoverTranscriptDir(logDir, state.nativeSessionId)
    const sibling = dir ? join(dir, name) : undefined
    const siblingAt = sibling && sibling !== state.path ? mtimeOfNonEmpty(sibling) : undefined
    if (homeAt === undefined) return siblingAt === undefined ? undefined : sibling
    if (siblingAt === undefined) return home
    return siblingAt > homeAt ? sibling : home
  }

  // READ-SIDE TRANSCRIPT DISCOVERY for a registered row whose bound file hasn't produced bytes yet.
  // Byte-identical for the healthy path: a file that is still where we bound it is one stat and out,
  // and a within-grace missing file is left to the ordinary spinning-up spinner. ONLY a past-grace
  // missing file engages discovery (throttled); on a hit it re-links + caches the drifted transcript
  // and replays it silently (primed=false → the next prime adopts it with no notify), on a miss it
  // flags the row no-transcript (a boot failure) so the board shows a degraded state, not an eternal
  // spinner.
  function resolveTranscript(state: TailState, row: SessionRow, nowMs: number): boolean {
    // A BOUND state (offset > 0) is a no-op for as long as its file is still THERE — one `existsSync`
    // per bound row per tick. That is a REAL added syscall, not one `consume` was going to make anyway:
    // `consume` does stat unconditionally, but its ENOENT and its no-new-bytes both leave through the
    // same silent return, so it cannot tell the caller which it saw. Measured at ~1.4µs, so the board
    // this was found on (464 rows) spends ~0.7ms of each 1000ms tick asking. That is the price of the
    // recovery below and it is worth paying, because a relocation announces itself no other way.
    // What must not be a no-op is the file having
    // VANISHED: a worker that changes its cwd (EnterWorktree, and any other move of the checkout under
    // a live session) makes Claude Code re-bucket the session transcript into the log dir for the NEW
    // cwd, and the path we bound then names nothing, forever. Nothing downstream can tell — `consume`
    // skips a missing file silently — so the fold simply STOPS, frozen at whatever turn it last held.
    // Frozen mid-turn that is `in-flight`, which `computeTurn` derives from a trailing user record with
    // no backstop behind it at all, so the board reads "Thinking…" for a thread that is doing nothing
    // and can never be talked out of it. Measured 2026-08-21 on three live threads at once (their
    // `tail_state` rows pinned to three deleted worktree buckets, one frozen 12 h, one reading
    // "Thinking… 1h 1m" against a transcript that had been at rest the whole time).
    //
    // This branch used to be `if (state.offset > 0) return true`, which is what made the `strandedDir`
    // recovery below — written for precisely this "the checkout moved" case — reachable only for a
    // session that had NEVER bound a file.
    if (state.offset > 0) {
      if (existsSync(state.path)) {
        // A HEALTHY BOUND ROW OWES NO THROTTLE. `nextDiscoverMs`/`discoverMisses` are the memory of a
        // sweep that came up empty, and a row reading its own file is the evidence that memory is
        // spent. Nothing else retires them: the unbound path clears the COUNTER on a bind and leaves
        // the DEADLINE behind, so a row that reached its transcript through the sweep — or simply
        // booted before the worker had written one — binds still carrying a deadline up to
        // DISCOVER_RETRY_MAX_MS away. The branch below would then sit out its FIRST relocation for as
        // much as 15 minutes: the same frozen "Thinking…" this function exists to end, merely bounded.
        //
        // THE RULE IS THAT EVERY RESOLUTION RETIRES THE THROTTLE, so it is also applied at each of the
        // four other places a transcript is resolved (the pinned-path bind below and the three
        // rebinds), not only here. It has to be in both kinds of place: this branch can only run on a
        // tick where the file is PRESENT, and a row can bind through the sweep and relocate before any
        // such tick ever happens — which is exactly the husk case in tailer.test.ts.
        state.discoverMisses = 0
        state.nextDiscoverMs = 0
        return true
      }
      if (nowMs < state.nextDiscoverMs) return true
      const moved = relocatedTranscript(state)
      // Nothing claims the id anywhere: the transcript is genuinely gone (deleted, or a log dir the
      // sweep cannot see). Leave the binding exactly as it is and look again later — a bound row must
      // never be flagged `noTranscript`, which means "the worker never wrote one" and cards the thread
      // as a boot failure. This one demonstrably did write one.
      //
      // BACK OFF like the unbound miss below, and for the identical measured reason: a miss costs a
      // full `readdirSync` + one stat per sibling bucket, SYNCHRONOUSLY on the tick, and
      // `strandedLogDirs` memoizes only HITS, so a permanent miss re-pays it every single interval. A
      // deleted worktree bucket is permanent, and it is the exact population this branch was written
      // for — three of them at once on the board that motivated it. Degradation and backoff are
      // separate decisions: this row still never becomes `noTranscript`, it just stops asking so often.
      if (!moved) {
        state.discoverMisses++
        state.nextDiscoverMs = nowMs + Math.min(
          DISCOVER_RETRY_MS * 2 ** (state.discoverMisses - 1),
          DISCOVER_RETRY_MAX_MS,
        )
        return true
      }
      // RE-ADOPT, DO NOT RESUME. The relocated file was selected on its NAME, and a name is not
      // evidence about the bytes below our cursor — `hydrateFromCache` faces this same situation and
      // refuses to trust a cursor without `measureFence`/`fenceMatches`, a rule bought with a
      // five-day silent freeze (see the note above it). Carrying the offset onto a same-named file
      // whose prefix differs would resume the fold mid-record and silently swallow everything before
      // it; carrying it onto a SHORTER one lands in `consume`'s truncation reset, which clears only
      // `offset`/`partial` and leaves `primed` true — so the replay would fire a REAL turn-done notify
      // for a historical record and let `onTurnDone` overwrite `rested_at`. That is the mirror image
      // of the bug this branch exists to fix: a false rest instead of a false "Thinking…".
      //
      // So take the same safe adoption the `strandedDir` path below already performs: replay the file
      // from the top with `primed` false, which is silent by construction. Nothing is lost by it — the
      // rest the thread has been owed since the relocation is stamped by `onPrimedAtRest` off that very
      // prime, so the thread still leaves "Thinking…" and enters the queue. Only the desktop notify is
      // forgone, which is what EVERY silent re-adoption in this function already trades away.
      state.path = moved
      state.offset = 0
      state.partial = ""
      state.primed = false
      state.noTranscript = false
      state.stallLogged = false
      state.discoverMisses = 0
      state.nextDiscoverMs = 0
      return true
    }
    // Presence alone isn't enough: a worker that creates `<id>.jsonl` then crashes before writing a
    // single record leaves a permanent 0-byte file. Treat empty-or-missing alike so a touched-but-never-
    // written transcript can't silently defeat the crash-net (found in review). A stat failure → size 0.
    let size = 0
    try {
      size = statSync(state.path).size
    } catch {
      size = 0
    }
    if (size > 0) {
      // Real content present (or just appeared) — clear any prior degraded state and let consume bind it.
      // The retry DEADLINE goes with the counter: leaving it armed is what made a swept-in row ignore
      // its next relocation for up to the backoff ceiling (see the bound branch above).
      state.noTranscript = false
      state.stallLogged = false
      state.discoverMisses = 0
      state.nextDiscoverMs = 0
      return true
    }
    // Empty/missing but still within the grace window → an ordinary just-spawned session (spinner). Wait.
    const spawnedMs = Date.parse(row.spawned_at)
    if (Number.isFinite(spawnedMs) && nowMs - spawnedMs < DISCOVERY_GRACE_MS) return true
    // Past grace, still missing: attempt discovery (throttled), else declare the transcript missing.
    if (nowMs < state.nextDiscoverMs) return true
    state.nextDiscoverMs = nowMs + DISCOVER_RETRY_MS
    // FIRST, the cheaper and more specific miss: the file is not drifted, it is in ANOTHER LOG DIR,
    // because the operator renamed or moved the checkout and Claude Code pins a session's transcript to
    // the bucket for the cwd it was born in (see discover.ts). The pinned id still names the file, so
    // this is an exact match rather than a content guess — hence it runs before the sentinel scan.
    const strandedDir = discoverTranscriptDir(logDir, row.session_id)
    if (strandedDir) {
      // Same session id, only a different directory: nothing to claim and no `transcript_id` to commit
      // (that column records a DRIFTED id, which this is not). Re-link and replay as a fresh prime.
      state.path = join(strandedDir, `${row.session_id}.jsonl`)
      state.offset = 0
      state.partial = ""
      state.primed = false
      state.noTranscript = false
      state.stallLogged = false
      state.discoverMisses = 0
      state.nextDiscoverMs = 0
      return true
    }
    const found = discoverTranscriptId(logDir, row.session_id, { nowMs, exclude: claimedIds(row.slug) })
    if (found && found !== row.session_id) {
      // Commit ownership before touching the in-memory path. A stale A snapshot must never bind A's
      // discovered transcript under a same-slug replacement B, even transiently between tail ticks.
      let committed = false
      try {
        committed = deps.storage.setTranscriptIdIfCurrent(
          row.slug,
          row.session_id,
          row.runtime_generation ?? 0,
          found,
        )
      } catch {
        committed = false
      }
      if (!committed) return false
      // Re-link to the drifted transcript: rebind the read path, cache it (survives restart + dedupes
      // foreign discovery), and replay it as a fresh prime so no historical turn-done fires spuriously.
      state.path = join(logDir, `${found}.jsonl`)
      state.offset = 0
      state.partial = ""
      state.primed = false
      state.noTranscript = false
      state.stallLogged = false
      state.discoverMisses = 0
      state.nextDiscoverMs = 0
      return true
    }
    // Nothing to bind: the worker never wrote a transcript → degraded/stalled, captured once for triage.
    // Both sweeps above just came up empty, so push the next attempt out exponentially — see
    // DISCOVER_RETRY_MAX_MS for why a board accumulates rows that can never answer this question.
    state.discoverMisses++
    state.nextDiscoverMs = nowMs + Math.min(
      DISCOVER_RETRY_MS * 2 ** (state.discoverMisses - 1),
      DISCOVER_RETRY_MAX_MS,
    )
    state.noTranscript = true
    captureStall(state, row)
    return true
  }

  function tick(): void {
    // Discover sessions from the registry so dispatch/resume/restart all "just work" — a new row
    // starts being tailed on the next tick; a finished row keeps its final derived state.
    let dirty = false
    // Any session whose provider events have outrun its transcript this tick → ask for another look
    // once the tick finishes (see chaseRuntime). One flag for the whole board: the nudge is coalesced
    // anyway, so per-session bookkeeping would buy nothing.
    let chaseWanted = false
    // Slugs whose JSONL advanced this tick (offset moved) → their transcript may have changed. Fed to the
    // /ws transcript producer at the end so it pushes only for genuinely-changed threads.
    const transcriptDirty: string[] = []
    const nowMs = now()
    adoptionBindings = new Map()
    const rows = deps.storage.allSessions()
    // ARCHIVED ROWS PRIME LAST. Priming is bounded per tick, so on a cold board the registry's order
    // decides who converges first — and a long-lived board is overwhelmingly archive. The maintainer's
    // board on 2026-08-16: 464 rows, 459 of them archived, 5 on the live board. Priming in row order
    // spent ~21 consecutive budget-capped ticks (~5.7s of ~99% event-loop occupancy, measured with a
    // real board wired) folding threads filed away in the collapsed Done section, while the five rows
    // actually on screen waited their turn in the same queue. That is the "sidebar won't update for a
    // number of seconds" report from the other end: not a slow tick, a mis-ordered one.
    //
    // Same total work, different order: while ANY visible row is still cold, archived rows yield their
    // slots. The board the operator is looking at converges on the first tick or two; the archive
    // catches up behind it at the same bounded rate. Deferring is safe because a prime is deliberately
    // notify-free (it adopts history as a baseline), so a late one cannot miss an event — it only
    // delays derived telemetry for rows that are collapsed out of sight.
    let coldVisibleRow = false
    for (const row of rows) {
      if (rowIsArchived(row)) continue
      const known = states.get(row.slug)
      if (!known || !known.primed) { coldVisibleRow = true; break }
    }
    let primed = 0
    // Newly-primed rows this tick, and whether the bound cut the pass short (see MAX_PRIME_ROWS_PER_TICK).
    let primedRows = 0
    const tickStartedMs = monotonicNow()
    primeIncomplete = false
    // THE PRIME BOUND. Asked at TWO gates in the loop below — once before a cold row is SET UP at all,
    // and once more where the fold itself begins — so it has to be one predicate rather than two copies
    // that can drift. `primedRows` is read live, not captured.
    //
    // `primedRows > 0` guarantees forward progress: the very first cold row of a tick always primes,
    // however expensive, so a board can never stall by being over budget on entry.
    const primeDeferred = (row: SessionRow): boolean =>
      // Yield the slot to a still-cold visible row — but never at the cost of the forward-progress
      // guarantee above. `primedRows > 0` keeps the archive advancing by at least one row per tick
      // even if a visible row were somehow to stay cold indefinitely, so deferral can never become
      // starvation. The visible row still primes on this same tick; it just is not necessarily first.
      (coldVisibleRow && primedRows > 0 && rowIsArchived(row)) ||
      primedRows >= MAX_PRIME_ROWS_PER_TICK ||
      (primedRows > 0 && monotonicNow() - tickStartedMs > PRIME_BUDGET_MS)
    for (const row of rows) {
      if (primeProgress && primed % PRIME_PROGRESS_EVERY === 0) primeProgress(primed, rows.length)
      primed++
      // Per-row backend + the DISCOVERED transcript stem. Both backends decouple the transcript id from
      // the pinned session_id, via DIFFERENT columns (only one is ever set): codex pins its rollout id on
      // `agent_session_id` (post-dispatch discovery); claude caches a drifted stem on `transcript_id`
      // (read-side discovery). So `agent_session_id ?? transcript_id ?? session_id` is the effective stem
      // for either — a claude row (agent_session_id NULL) falls to transcript_id ?? session_id (its old
      // deterministic path); a codex row (transcript_id NULL) falls to agent_session_id ?? session_id.
      const backend = resolveBackend(row.backend)
      const nativeId = row.agent_session_id ?? row.transcript_id ?? row.session_id
      const known = states.get(row.slug)
      const runtimeGeneration = row.runtime_generation ?? 0
      // The state this row may KEEP: same session, same native transcript stem, same runtime
      // generation. Anything else is a different conversation wearing the same slug, and its state has
      // to be rebuilt from scratch — which costs exactly what never having had one costs.
      const keepable = known !== undefined &&
        known.sessionId === row.session_id &&
        known.nativeSessionId === nativeId &&
        known.runtimeGeneration === runtimeGeneration
      let state = keepable ? known : undefined
      // THE BOUND IS ASKED BEFORE THE SETUP, NOT ONLY BEFORE THE FOLD (2026-09-04).
      //
      // Everything between here and the prime below is PER-ROW work that a deferred row used to pay in
      // full for nothing: a `retiredOps` query, a tail-cache hydrate (a stat, two reads and a hash), and
      // then resolveTranscript — a stat per transcript, and for anything still unbound a whole read-side
      // discovery pass whose `claimedIds` re-reads the entire registry. MAX_PRIME_ROWS_PER_TICK and
      // PRIME_BUDGET_MS bounded only the FOLD, so a cold board ran that setup for every row and folded
      // 25. Measured on a 558-thread board, cold tail cache: the first tick cost 2251ms and primed
      // exactly ONE row — the wall-clock budget was already spent by the time the second cold row
      // reached the gate below (1140ms and one row with the cache warm). That is tenant-prime.ts's
      // "THE COLD PRIME IS ALREADY BOUNDED" bullet being false by an order of magnitude, and the
      // operator felt it as the board taking seconds to appear while the rail opened behind it.
      //
      // A row with no state IS a row that has not been primed — the condition MAX_PRIME_ROWS_PER_TICK
      // already describes ("simply not in `states` yet") — so turning one back here needs no new concept
      // and leaves exactly the state the fold's own deferral leaves. Nothing outside can tell the two
      // apart either: `get` already answers undefined both for a slug with no state and for a stale one
      // (registeredStateIsCurrent), and the scheduler's own seams read that as "unknown", never as idle.
      if (!state && primeDeferred(row)) {
        primeIncomplete = true
        continue
      }
      if (!state) {
        // claude.transcriptPath always returns the logDir join; codex.transcriptPath resolves the
        // date-sharded rollout by id (or undefined before its id is pinned → the join is a harmless
        // placeholder until discovery pins it).
        const path = backend.transcriptPath(nativeId) ?? join(logDir, `${nativeId}.jsonl`)
        state = newTailState(row.slug, row.session_id, path, false, nativeId, runtimeGeneration)
        // BEFORE any fold. This is the durable memory of the operator's × (storage `retired_op`), and
        // the fold consults it as it reads dispatch records — so it has to be populated while the state
        // is still empty, not after. Without it a killed shell is re-minted from a dispatch record that
        // will never get a terminal partner, and the row reads "running" for as long as the thread
        // lives (the maintainer's 57-hour phantom).
        state.dismissedOps = deps.storage.retiredOps(row.slug, row.session_id)
        // Resume the fold at the byte offset the last process reached, when the transcript can be
        // PROVEN to still carry the prefix that produced it. On a miss the state stays fresh and the
        // prime below folds from 0 — the historical path, unchanged.
        hydrateFromCache(state, row, nativeId)
        // AND AGAIN, after the cache. There are TWO ways a retired op comes back and the durable set
        // has to beat both: the fold re-reading its dispatch record (handled inside trackDispatches)
        // and the tail CACHE, which serialises `subAgents` wholesale and restores it without folding
        // anything. The cache is written on a tick, so an × clicked after the last one is simply not in
        // it — the row returned on the next boot looking exactly as live as before the click. Caught by
        // the restart test in tailer.test.ts, not by reasoning.
        for (const id of state.dismissedOps) {
          state.subAgents.delete(id)
          state.pendingShells?.delete(id)
        }
        states.set(row.slug, state)
      }

      // Read-side discovery: rebind a drifted transcript / flag a boot-failure stall. A no-op for a
      // healthy bound session (offset > 0). May rebind + reset primed → the prime branch below replays
      // the discovered file silently. Track noTranscript flips so the degraded runtime surfaces promptly.
      // CLAUDE-ONLY: the discovery scan targets the claude log dir + scratchpad sentinel; a codex row
      // locates its rollout by the agent_session_id pinned at dispatch, so running claude discovery on it
      // would wrongly flag noTranscript (a codex discovery-miss is a separate follow-up).
      const prevNoTranscript = state.noTranscript
      if (row.backend !== "codex" && !resolveTranscript(state, row, nowMs)) continue

      // First sighting of a session (fresh dispatch OR restored after a server restart): read the
      // whole transcript to date and adopt its state as the baseline WITHOUT firing turn-done /
      // exited notifies — those pre-restart events are history, not new activity. The REST ITSELF is
      // not an event though, it is a fact about the thread, and one taken while frizz was not watching
      // still has to be recorded: `onPrimedAtRest` below stamps it, silently. See its own block.
      if (!state.primed) {
        // Bounded so activation never blocks the loop for seconds. The row keeps its place in the
        // registry and primes on a following tick; scheduleTick below re-arms immediately while any
        // remain, so a cold board converges in a few hundred ms of wall time without a long stall.
        //
        // THE SECOND GATE, and it is not redundant with the one above: a row reaches here unprimed with
        // a state ALREADY BUILT in two ways the gate above cannot see. resolveTranscript resets
        // `primed` when it re-links a drifted transcript, so a row that arrived primed leaves cold; and
        // a row whose `setTranscriptIdIfCurrent` lost its race on an earlier tick was left set up and
        // never folded. Both are rare, and both must still respect the budget rather than fold for free.
        if (primeDeferred(row)) {
          primeIncomplete = true
          continue
        }
        primedRows++
        const primeOffset = state.offset
        const primeLedger = ledgerFold(row, nowMs, state)
        consume(state, backend, chainOnLine(primeLedger.onLine, codexSubAgentOnLine(row, state)))
        state.codexSubAgents?.poll(nowMs)
        const primedLedger = primeLedger.finish()
        state.deliveryLedgerSeen = primedLedger.changed ? primedLedger.value : row.delivery_ledger ?? null
        if (primedLedger.changed) transcriptDirty.push(row.slug)
        persistCodexAutoTitle(row, state, runtimeGeneration)
        drainUnretiredOps(state, row)
        if (state.offset !== primeOffset) transcriptDirty.push(row.slug)
        state.turn = turnFor(row, state, nowMs)
        // The turn this prime just adopted may BE a rest frizz never saw happen. Stamped before the
        // board's first assemble, so `rested_at` is already honest by the time anything reads it.
        onPrimedAtRest(row, state)
        const pane = sniffPane(
          state,
          row,
          state.turn,
          nowMs,
          backend,
        )
        state.permPrompt = pane.permPrompt
        state.paneDead = paneDeadForRow(row)
        applyRuntimeTasks(row, state, nowMs)
        applyRuntimeContextWindow(row, state)
        state.subAgentsSig = derivedSignature(state, nowMs)
        state.primed = true
        // Cache what this prime derived, unless it came from the cache and consumed nothing — in which
        // case the stored entry is already byte-accurate and rewriting it is pure work.
        if (state.offset !== primeOffset || !cacheHydrated.has(row.slug)) cacheDirty.add(row.slug)
        cacheHydrated.delete(row.slug)
        if (state.permissionMode) {
          const saved = PermissionMode.safeParse(row.permission_mode)
          const observedAt = state.permissionModeAt ? Date.parse(state.permissionModeAt) : NaN
          const spawnedAt = Date.parse(row.spawned_at)
          // An idle reattach is not guaranteed to append a new profile sidecar before the next turn
          // (verified on both standalone TUIs). Preserve a valid exact launch mode across restart;
          // backfill only unknown legacy rows, or accept a timestamped Codex event from this process
          // generation. Incremental sidecars below still persist genuine live transitions.
          // An app-server thread is the ONE case where the rollout is not evidence about frizz's thread:
          // the same file is written by any terminal `codex resume` (config default `workspace-write`)
          // and by the app-server's own config-defaulted cold resume. Folding that back over the stored
          // mode does not just mis-DISPLAY the thread — `sandboxFor` reads this column, so the next cold
          // resume then REQUESTS the downgraded sandbox, making a transient observation permanent. The
          // bridge is the authority for those rows; only backfill a row whose mode is unknown.
          const observedMayOverwrite = row.backend === "codex" && row.codex_runtime !== "app-server"
          const observedIsCurrent = !saved.success || (observedMayOverwrite && Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt)
          if (observedIsCurrent && (!saved.success || saved.data !== state.permissionMode)) {
            deps.storage.setObservedPermissionIfCurrent(
              row.slug,
              row.session_id,
              runtimeGeneration,
              state.permissionMode,
            )
          }
        }
        dirty = true // surface the restored overlay
        continue
      }

      const prevActivity = state.lastActivityAt
      const prevAssistant = state.lastAssistant
      const prevAiTitle = state.aiTitle
      const prevModel = state.model
      const prevEffort = state.effort
      const prevProfileRevision = state.profileRevision ?? 0
      const prevPermissionMode = state.permissionMode
      const prevPermissionRevision = state.permissionModeRevision ?? 0
      const prevOffset = state.offset
      // Snapshot the turn BEFORE the fold. A codex fold (applyEvent) writes state.turn INLINE on
      // task_started/task_complete, so by the time we diff below state.turn already holds the new value
      // — comparing against it would miss the transition (no turn-done notify). Claude's applyRecord
      // never touches state.turn (computeTurn derives it), so prevTurn === state.turn for claude here:
      // byte-identical. This makes the transition edge backend-agnostic.
      const prevTurn = state.turn
      const rowLedger = row.delivery_ledger ?? null
      const ledgerDrifted = rowLedger !== (state.deliveryLedgerSeen ?? null) // a router write with no JSONL advance
      const ledger = ledgerFold(row, nowMs, state)
      consume(state, backend, chainOnLine(ledger.onLine, codexSubAgentOnLine(row, state)))
      // Child rollouts advance on their OWN clock, so poll every tick — not only when the parent
      // appended. This is what flips a finished codex child out of the live set (and, once every
      // child is done, releases the thread from Active into the queue).
      state.codexSubAgents?.poll(nowMs)
      const ledgerResult = ledger.finish()
      state.deliveryLedgerSeen = ledgerResult.changed ? ledgerResult.value : rowLedger
      if (ledgerDrifted || ledgerResult.changed) {
        transcriptDirty.push(row.slug) // the ledger projection changed even if no renderable record did
        dirty = true
      }
      const profileRecordLanded = (state.profileRevision ?? 0) !== prevProfileRevision
      if (profileRecordLanded && state.model && state.profileAt) {
        const observedAt = Date.parse(state.profileAt)
        const spawnedAt = Date.parse(row.spawned_at)
        const model = normalizeObservedThreadModel(row.backend ?? "claude", state.model)
        const effort = state.effort?.trim() || row.effort?.trim()
        if (model && effort && Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt) {
          try {
            validateThreadProfile(row.backend ?? "claude", model, effort)
            deps.storage.setObservedProfileIfCurrent(
              row.slug,
              { sessionId: row.session_id, generation: runtimeGeneration },
              { model, effort },
            )
          } catch {
            // Unknown/incomplete provider telemetry is visible but never becomes a future launch target.
          }
        }
      }
      if (state.aiTitle !== prevAiTitle) persistCodexAutoTitle(row, state, runtimeGeneration)
      if (state.offset !== prevOffset) {
        transcriptDirty.push(row.slug)
        cacheDirty.add(row.slug) // the cached prefix is short by the bytes we just folded
      }
      // The bytes just folded may have carried a restart that supersedes an operator's ×.
      drainUnretiredOps(state, row)
      if (chaseRuntime(row, state, state.offset !== prevOffset)) chaseWanted = true

      // turn transition (in-flight → idle): a completed turn. Mark unread + notify, gated on
      // last_read_at so a turn the user has already scrolled past doesn't re-badge.
      const nextTurn = turnFor(row, state, nowMs)
      if (prevTurn !== nextTurn) {
        if (prevTurn === "in-flight" && nextTurn === "idle") {
          onTurnDone(row, state)
          dirty = true
        } else {
          dirty = true // idle → in-flight (a new turn started): refresh the overlay badge
        }
        state.turn = nextTurn
      }

      // interactive permission prompt: no jsonl signal, so read the worker's permission marker on a
      // quiet in-flight turn. Cleared automatically once jsonl activity resumes (turn no longer quiet)
      // or the marker stops blocking. Rides the board snapshot only — no notify, no unread (it's not a
      // completed turn).
      // App-server codex sessions are headless: there was never a screen to read, and "no screen" must
      // NOT read as process death. Native approvals arrive via the bridge's
      // InteractionStore (surfaced through interactionPresence), not a scraped modal; rest is stamped
      // by onTurnDone off the rollout, not onPaneDeath.
      // EVERY row, headless included — the prime path has always called this unguarded, and the steady
      // tick must agree or the reading LATCHES at boot. It used to sit inside the `!isHeadlessRow`
      // guard below, on the reasoning quoted there: capturing a screen is meaningless without one. But
      // sniffPane captures nothing now — all that survives is the MARKER read, whose own comment
      // says it "always worked headlessly" — and every live Claude thread is claude_runtime="broker",
      // hence headless. So the guard silently reduced the marker to a once-per-boot reading for the
      // entire Claude fleet: a block or a policy denial that began after prime was never seen, and one
      // already on disk surfaced at the next SERVER RESTART, which is what made the note read as
      // having "just showed up randomly". Harmless for the other headless kind: sniffPane returns
      // false outright for a codex row, exactly as it did at prime.
      const pane = sniffPane(
        state,
        row,
        nextTurn,
        nowMs,
        backend,
      )
      if (pane.permPrompt !== state.permPrompt) dirty = true
      state.permPrompt = pane.permPrompt

      // The OWNER-death half stays guarded — that reasoning is still sound, and it is the half the
      // comment was actually written about.
      if (!isHeadlessRow(row)) {
        // Owner death — the agent process exited. Only a pre-cutover row reaches this arm now, and its
        // transport is gone, so the default liveness seam answers "dead" for it.
        // Asked only while the answer can still change anything. Once a row is stamped exited AND its
        // owner has been observed dead, the death edge has already fired and nothing un-exits a row —
        // so re-observing it every second buys nothing and used to cost a batched process inventory. On
        // a board of finished threads this is what makes an idle tick cost NO subprocess at all.
        if (row.exited !== 1 || !state.paneDead) {
          const dead = paneDeadForRow(row)
          if (dead && !state.paneDead) {
            onPaneDeath(row)
            dirty = true
          }
          state.paneDead = dead
        }
      } else {
        // Nothing to observe a death ON for a headless row, but the "owning process is gone" flag still
        // has to stay CURRENT: it is what clears a headless thread's background shells when frizz stops
        // the session. Assigned without the death EDGE — onPaneDeath stamps `exited` and fires the
        // one-shot notify, and for a headless row `exited` is the input here, not the output. Left out,
        // the prime-time reading would latch for the life of the process.
        state.paneDead = paneDeadForRow(row)
      }

      // The provider's own report of those ops, folded over the entries the transcript fold tracks:
      // progress the JSONL does not carry at all, plus terminal statuses that reach frizz SECONDS before
      // (or, when a notification never lands on disk, INSTEAD of) the prose the fold waits for.
      applyRuntimeTasks(row, state, nowMs)
      applyRuntimeContextWindow(row, state)

      // live background ops + pending ask: a dispatch/completion/launch changes the set, a running→stale
      // flip is purely time-based (no new record), and an ask appears/clears — recompute every tick.
      const sig = derivedSignature(state, nowMs)
      if (sig !== state.subAgentsSig) {
        state.subAgentsSig = sig
        dirty = true
      }

      if (state.lastActivityAt !== prevActivity || state.lastAssistant !== prevAssistant || state.aiTitle !== prevAiTitle) dirty = true
      const permissionRecordLanded = (state.permissionModeRevision ?? 0) !== prevPermissionRevision
      if (permissionRecordLanded && state.permissionMode) {
        if (row.backend === "codex") {
          // Same authority split as the prime path above: for an app-server row the bridge owns the
          // sandbox, and a rollout record written by some other reader of the shared file must not
          // rewrite it. A row with no valid stored mode is still worth backfilling.
          if (row.codex_runtime !== "app-server" || !PermissionMode.safeParse(row.permission_mode).success) {
            deps.storage.setObservedPermissionIfCurrent(row.slug, row.session_id, runtimeGeneration, state.permissionMode)
          }
        }
      }
      if (state.model !== prevModel || state.effort !== prevEffort || state.permissionMode !== prevPermissionMode) dirty = true
      // A no-transcript flip (grace expired with no file / a re-link cleared it) changes the derived
      // runtime but touches no activity/turn — mark dirty so the board rebuilds without waiting for the
      // periodic reconcile.
      if (state.noTranscript !== prevNoTranscript) dirty = true
    }

    // FOREIGN threads: refresh the fresh set on a scan tick (a change in membership/order is itself
    // dirty), then tail every fresh one (reusing the cached set between scans).
    if (foreignScanTick % FOREIGN_SCAN_EVERY === 0) {
      // BOTH agents' terminals, tagged with the backend that has to FOLD each one — a rollout put
      // through the Claude parser yields a silent empty thread, not an error. Claude first so that if
      // the two ever exceed the cap together it is the codex tail that is dropped: Claude's scan is the
      // one that reads a directory frizz itself writes to, so it is never speculative.
      const next = [
        ...scanForeign(nowMs).map((f) => ({ ...f, backend: "claude" as const })),
        ...scanForeignCodex(nowMs).map((f) => ({ ...f, backend: "codex" as const })),
      ].slice(0, FOREIGN_MAX)
      if (!sameForeign(next, foreignFresh)) dirty = true
      foreignFresh = next
    }
    foreignScanTick++
    for (const f of foreignFresh) {
      let state = foreignStates.get(f.id)
      if (!state) {
        state = newTailState(f.id, f.id, f.path, true) // slug = session id = thread id for a foreign thread
        hydrateFromCache(state, null, f.id)
        foreignStates.set(f.id, state)
      }
      // The HARNESS's own name for the thread, which claude records inside the transcript (`ai-title`,
      // folded like any other record) and codex keeps in a sidecar the fold cannot see. Assigning it
      // here puts both backends on the one field the board already reads. Re-applied every tick rather
      // than only on creation, because codex writes the sidecar entry AFTER the rollout exists.
      if (f.title && state.aiTitle !== f.title) state.aiTitle = f.title
      if (tailForeign(state, nowMs, transcriptDirty, resolveBackend(f.backend))) dirty = true
    }

    // Persist the prime cache. The FIRST tick always flushes (that is the boot the next one inherits);
    // afterwards a growing transcript is written at most every CACHE_FLUSH_MS, so an active board costs
    // one small batched transaction per interval rather than one per tick.
    if (tailCache && (lastCacheFlushMs === 0 || nowMs - lastCacheFlushMs >= CACHE_FLUSH_MS)) {
      flushCache(nowMs)
    }

    if (dirty) deps.onChange()
    if (transcriptDirty.length) deps.onTranscriptChange?.(transcriptDirty)

    // A session's provider events have outrun its transcript — look again shortly. Last, so it can
    // never delay this tick's board push.
    if (chaseWanted) nudge()
  }

  // in-flight → idle: the turn finished. Badge unread if this completion post-dates the last read,
  // and fire a one-shot turn-done notify (the transition itself is the dedupe).
  function onTurnDone(row: SessionRow, state: TailState): void {
    const generation = row.runtime_generation ?? 0
    const eventAt = state.lastActivityAt ?? new Date(now()).toISOString()
    // The rest moment drives the nav's most-recently-rested-first order. A DISCRETE event (once
    // per turn end), so rows move rarely and meaningfully — unlike continuous activity sorting.
    if (!deps.storage.setRestedAtIfCurrent(row.slug, row.session_id, generation, eventAt)) return
    if (landsAfterRead(eventAt, row.last_read_at)) {
      deps.storage.setUnreadIfCurrent(row.slug, row.session_id, generation, true)
    }
    deps.bus.publish({
      type: "notify",
      slug: row.slug,
      kind: "turn-done",
      title: row.slug,
      body: state.lastAssistant,
    })
  }

  // THE SAME REST, OBSERVED AT PRIME INSTEAD OF ON THE EDGE.
  //
  // `onTurnDone` above is the only thing that stamps `rested_at`, and it fires on a LIVE in-flight →
  // idle transition. The prime path has no edge to fire: it folds a whole transcript and ADOPTS the
  // turn it finds. So a turn that ended while frizz was not watching was never recorded as a rest at
  // all, and nothing repaired it afterwards — prime runs once per session per process, so the row kept
  // `rested_at` NULL for the rest of its life while sitting visibly at rest on the board.
  //
  // That window is not exotic. A worker is a DETACHED broker daemon in its own process group, so it
  // keeps working across a frizz restart BY DESIGN (ARCHITECTURE.md) — which makes "the turn ended
  // while frizz was down" the ordinary case every time the server bounces, not an edge.
  //
  // The consequences are all downstream of the column simply being WRONG:
  //   • `snoozeAwaitingBackground` refuses the thread outright — "This thread is not at rest; nothing
  //     to snooze" (router.ts) — on a thread that is plainly at rest, so the card's own Snooze throws;
  //   • `bgSnoozeArmed` (board.ts) requires a non-null `rested_at`, so that snooze can never arm;
  //   • the stored answer to "when did this agent last come to rest" is null for a thread whose
  //     transcript answers it precisely.
  // Measured 2026-08-25 on the maintainer's own board: `examine-the-tickets-in-this-issue` ended its
  // turn at 19:19:26Z with a ```question fence, and after the server bounced it carried `turn: "idle"`,
  // `lastAssistantHasQuestion: true` and `rested_at: NULL` — alone among eleven live threads.
  //
  // A REST IS A FACT; A TURN-DONE IS AN EVENT. Prime records the fact and stays SILENT about the
  // event, which is the whole of the difference from `onTurnDone` and the reason this is not simply a
  // call to it. The silence is deliberate and load-bearing at scale: a rebind can bring back hundreds
  // of historical transcripts on one tick (386 of one project's 427 sessions, measured 2026-08-11),
  // and a notify each would be hundreds of alerts for work that finished days ago.
  //
  // THE CLOCK IS `lastAssistantAt`, NOT `lastActivityAt`, and the difference is the whole safety of
  // this function. `lastAssistantAt` is the rest-time key by construction (see its assignment in
  // applyRecord): it moves ONLY on the agent's own final output, never on a sub-agent's completion
  // notification, a Claude `type:"system"` record, a tool_result echo, a codex `agent-report` or a
  // compaction — all of which advance `lastActivityAt` while leaving the turn `idle`.
  //
  // `onTurnDone` reads `lastActivityAt` and gets away with it because it fires on the EDGE, where the
  // turn-ending record is the last record there is. Prime has no such luck: it folds the WHOLE file,
  // so any trailing activity-advancing record would be baked into the stamp. That is not a cosmetic
  // drift — the monotonic guard below only blocks writes BACKWARDS, so a spuriously later value would
  // overwrite a stamp that was already correct, and `bgSnoozeArmed` (board.ts) holds only while
  // `bg_snooze_rested_at === rested_at`. A restart could then silently un-arm a snooze the operator
  // set on an awaiting-background card, re-surfacing it for a condition that has not occurred.
  //
  // Reading the turn-ending record instead makes a bounce IDEMPOTENT, and by CONSTRUCTION rather than
  // by luck. `lastAssistantAt` moves on a strict SUBSET of the records `lastActivityAt` moves on, so a
  // re-derived stamp can only ever land at or BEFORE the one the live edge already wrote — never after
  // it, which is the one direction the guard cannot block. The two DO disagree in the ordinary case
  // where a `type:"system"` sidecar trailed the `end_turn` inside a single 1s poll window: the live
  // edge stamped the sidecar's instant, prime derives the agent's own. The guard then sees
  // `at <= stamped` and writes nothing, which is the right outcome twice over — the bounce changes
  // nothing, and the instant already stored is the more accurate of the two.
  function onPrimedAtRest(row: SessionRow, state: TailState): void {
    // Only a FOLDED rest counts. `sawRecords` keeps a transcript-less session — whose turn reads idle
    // by default rather than by evidence — from minting a rest it never took.
    if (state.turn !== "idle" || !state.sawRecords) return
    const eventAt = state.lastAssistantAt
    if (!eventAt) return // at rest with no output of its own: nothing to date the rest by
    const at = Date.parse(eventAt)
    if (!Number.isFinite(at)) return
    const stamped = row.rested_at ? Date.parse(row.rested_at) : NaN
    if (Number.isFinite(stamped) && at <= stamped) return // already recorded — nothing new to write
    deps.storage.setRestedAtIfCurrent(row.slug, row.session_id, row.runtime_generation ?? 0, eventAt)
  }

  // owner death: stamp exited (keeps the stored column honest for the overlay) + badge unread +
  // one-shot exited notify.
  function onPaneDeath(row: SessionRow): void {
    const generation = row.runtime_generation ?? 0
    const eventAt = new Date(now()).toISOString()
    if (!deps.storage.setRestedAtIfCurrent(row.slug, row.session_id, generation, eventAt)) return
    if (row.exited !== 1) {
      deps.storage.setExitedIfCurrent(row.slug, row.session_id, generation, true)
    }
    if (landsAfterRead(eventAt, row.last_read_at)) {
      deps.storage.setUnreadIfCurrent(row.slug, row.session_id, generation, true)
    }
    deps.bus.publish({ type: "notify", slug: row.slug, kind: "exited", title: row.slug, body: "Agent session ended" })
  }

  // The tick runs SYNCHRONOUSLY on the event loop, so its duration is a hard floor on every RPC reply,
  // board delta and transcript push the server owes a client while it runs. When it exceeds its own poll
  // period the server is, by definition, permanently behind — and the whole UI reads as laggy (the
  // 2026-07-23 report: "I mark something as done and the sidebar won't update for a number of seconds").
  // That regression is invisible without a signal, so say it once per occurrence and name the board size.
  // Silent on a healthy board — this must never become log noise.
  let overBudgetTicks = 0
  // Duration of the most recent tick — read by the self-scheduling poll below so a tick that costs more
  // than its own period yields the event loop for at least as long as it just held it.
  let lastTickMs = 0
  // Set by a tick that hit MAX_PRIME_ROWS_PER_TICK — there are still cold rows waiting. scheduleTick
  // re-arms immediately in that case so a cold board converges in a burst of short ticks rather than
  // one row-block per second.
  let primeIncomplete = false
  function tickWithBudget(): void {
    const started = monotonicNow()
    try {
      tick()
    } finally {
      const elapsed = monotonicNow() - started
      lastTickMs = elapsed
      lastTickEndedAtMs = now()
      if (elapsed > POLL_MS) {
        overBudgetTicks++
        // Log the first, then decimate: a saturated server must not spend its remaining budget logging.
        if (overBudgetTicks === 1 || overBudgetTicks % 30 === 0) {
          frizzLog.warn(
            "tailer",
            `tick took ${Math.round(elapsed)}ms (poll ${POLL_MS}ms, ${states.size} sessions) — ` +
            `the event loop is blocked for that long, so RPCs and board pushes are delayed (occurrence ${overBudgetTicks})`,
          )
        }
      }
    }
  }

  // SELF-SCHEDULING, not a fixed interval. A tick runs synchronously on the event loop, so a tick that
  // costs more than POLL_MS on a fixed interval leaves ZERO idle time between ticks: the loop is held
  // ~100% of the time and every RPC reply, board delta and transcript push queues behind it. That is
  // the "sidebar won't update for a number of seconds" report — the server is not busy, it is starved.
  // Scheduling the NEXT tick after the last one finishes, at a delay of at least what the last tick
  // cost, bounds the tailer's duty cycle at ~50% no matter how slow a tick gets. It degrades to a
  // slower poll under load instead of self-inflicting a stall, and returns to POLL_MS the moment ticks
  // are cheap again — this is level-triggered off measured cost, with no state to get stuck in.
  // A tick that throws is a bug worth seeing, but never worth the loop or the process. Decimated so a
  // persistently failing tick cannot itself become the outage.
  let tickFailures = 0
  function reportTickFailure(error: unknown): void {
    tickFailures++
    if (tickFailures === 1 || tickFailures % 50 === 0) {
      frizzLog.error("tailer", `tick threw (occurrence ${tickFailures}; the loop keeps running): ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
  }

  function scheduleTick(): void {
    // While rows are still cold, come straight back: each pass is bounded, so this is a burst of short
    // ticks, not a stall. setImmediate-scale rather than 0 so I/O and pending RPCs interleave.
    const delay = primeIncomplete
      ? 1
      : Math.min(MAX_POLL_MS, Math.max(POLL_MS, Math.round(lastTickMs)))
    timer = setTimeout(() => {
      timer = null
      // RE-ARM EVEN IF THE TICK THREW. tickWithBudget is try/finally, not try/catch, so an exception
      // out of tick() used to escape a timer callback — which in node means an uncaughtException and,
      // with no process-level handler anywhere in this server, the whole frizz process. The tailer is
      // the only source of turn/liveness telemetry: it must degrade to a logged bad tick, never take
      // the server (or its own loop) down with it.
      try { tickWithBudget() } catch (error) { reportTickFailure(error) }
      if (!stopped) scheduleTick()
    }, delay)
    timer.unref?.()
  }

  // ---- Event-driven nudge (the poll's latency floor, removed) ---------------------------------------
  // The adaptive poll above is level-triggered: it re-reads every session on a 1–10s cadence whether or
  // not anything happened, and a thread that just finished its turn waits out the remainder of that
  // cadence before the board moves. The Claude broker already knows the instant a session changed —
  // it receives the SDK's typed event stream — so a runtime event calls nudge() and the tick runs now.
  //
  // Two properties keep this from becoming its own stability problem:
  //  * COALESCED. A turn emits many events in a burst; one pending nudge covers all of them, because
  //    the tick is whole-board anyway. Cost is bounded by the throttle below, not by event rate.
  //  * DUTY-CYCLE PRESERVING. scheduleTick deliberately bounds the tailer at ~50% of the event loop by
  //    never starting a tick sooner than the last one cost. The nudge inherits that exact floor, so a
  //    chatty session can never starve RPCs and board pushes the way a fixed interval could.
  const NUDGE_MS = 25
  let nudgeTimer: NodeJS.Timeout | null = null
  let lastTickEndedAtMs = 0

  function nudge(): void {
    if (stopped || nudgeTimer) return
    // Same floor scheduleTick uses: at least NUDGE_MS, and never sooner after the previous tick than
    // that tick cost to run.
    const earliest = lastTickEndedAtMs + Math.max(NUDGE_MS, Math.round(lastTickMs))
    const delay = Math.max(NUDGE_MS, earliest - now())
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null
      if (stopped) return
      // Take over the poll's slot rather than running alongside it: clear the pending scheduled tick,
      // run now, then restart the regular cadence from this moment.
      if (timer) { clearTimeout(timer); timer = null }
      // Strictly more dangerous than the poll callback above: this one destroys the poll timer FIRST,
      // so a throwing tick would leave BOTH timers null and the tailer permanently dead — a frozen
      // board with a healthy-looking server. Proven against a real createTailer with an injected
      // storage error: 4 ticks/1.2s before, 0 ticks in the 3s after, revived only by a later nudge.
      try { tickWithBudget() } catch (error) { reportTickFailure(error) }
      if (!stopped) scheduleTick()
    }, delay)
    nudgeTimer.unref?.()
  }

  function registeredStateIsCurrent(state: TailState): boolean {
    const current = deps.storage.getSession(state.slug)
    return Boolean(
      current &&
      current.session_id === state.sessionId &&
      (current.runtime_generation ?? 0) === state.runtimeGeneration,
    )
  }

  return {
    get(slug) {
      // Registered states win the key; a foreign thread resolves by its session id (its thread id).
      const registered = states.get(slug)
      const s = registered && registeredStateIsCurrent(registered)
        ? registered
        : registered ? undefined : foreignStates.get(slug)
      if (!s) return undefined
      // pendingQuestion: the latest assistant message carries a ```question fence and the HUMAN has not
      // answered it. NO REST-GATE, and that is the point. It used to require `turn === "idle"` as well,
      // copied from the `humanBlocked` net where the gate is genuinely needed — that signal is a thread
      // FILE flag written mid-turn, ~150ms after dispatch, long before the ask text exists, so counting
      // it early yields a card with no visible ask. This flag is derived from the ask TEXT ITSELF: by the
      // time it is true the question is on disk and in the chat, so there is nothing to wait for.
      //
      // What the gate did instead was make the ask disappear the instant anything re-opened the turn —
      // and the chat, which reads the transcript rather than the turn, went on drawing the answerable
      // card. One thread showed its ```question card AND the working shimmer, in the Active rail instead
      // of the queue (maintainer 2026-08-24: "this needs to be structurally impossible"). An unanswered
      // question is a claim on the HUMAN; whether the agent happens to be mid-turn is a fact about the
      // agent. The board reports both, and `boardRuntime` decides which one the row is allowed to draw.
      const pendingQuestion = s.lastAssistantHasQuestion
      const nowMs = now()
      return { turn: s.turn, permPrompt: s.permPrompt, permPolicy: s.permPolicy, permDenies: s.permDenies, model: s.model, effort: s.effort, profileAt: s.profileAt, profileRevision: s.profileRevision, permissionMode: s.permissionMode, permissionModeAt: s.permissionModeAt, permissionModeRevision: s.permissionModeRevision, lastActivityAt: s.lastActivityAt, lastAssistantAt: s.lastAssistantAt, lastAssistant: s.lastAssistant, aiTitle: s.aiTitle, customTitle: s.customTitle, customTitleRevision: s.customTitleRevision, subAgents: subAgentViews(s, nowMs), droppedReports: [...s.queuedReports.values()], bgShells: [...bgShellViews(s), ...codexBgShellViews(s)], retiredShells: retiredShellViews(s), pendingAsk: s.pendingAsk, pendingQuestion, lastAssistantAllDone: s.lastAssistantAllDone, lastUserAt: s.lastUserAt, lastUserText: s.lastUserText, firstUserText: s.firstUserText, lastFence: s.lastFence, noTranscript: s.noTranscript, authFault: s.authFault, apiFault: s.apiFault, providerError: s.providerError, limitFault: s.limitFault, contextTokens: s.contextTokens, contextWindow: s.contextWindow, lastCompactionAt: s.lastCompactionAt }
    },
    // The CURRENT fresh foreign session ids (mtime within FOREIGN_FRESH_MS, capped), mtime-desc. Kept
    // as the last scan's result — recomputed at most every FOREIGN_SCAN_EVERY ticks.
    foreignIds: () => foreignFresh.map((f) => f.id),
    foreignBackend: (id) => foreignFresh.find((f) => f.id === id)?.backend,
    subAgent: subAgentLookup,
    subAgentByTaskId,
    subAgentDescendantTasks,
    backgroundShell: backgroundShellLookup,
    // Registered rows only. A FOREIGN thread (a maintainer's own terminal) is not frizz's to declare
    // dead — nothing here owns its process — so it answers false and its cards are left alone.
    ownerGone: (slug) => states.get(slug)?.paneDead ?? false,
    dismissOp,
    forget(slug) {
      states.delete(slug)
      foreignStates.delete(slug)
    },
    notePermissionMode(slug, permissionMode) {
      const state = states.get(slug)
      if (state) {
        state.permissionMode = permissionMode
      }
    },
    start(onPrimeProgress) {
      if (timer) return
      stopped = false
      primeProgress = onPrimeProgress
      try {
        // THROUGH THE BUDGET WRAPPER, like every other tick. This one derives current state immediately
        // (and restores it after a server restart), and it is by far the most expensive tick the tailer
        // ever runs — yet it was the only one with no cost accounting at all, because it called `tick`
        // directly. So the warning that names a loop-blocking tick could not see the tick that blocks
        // the loop longest: a 2251ms activation sat in the boot path for weeks, measured only when
        // somebody went looking (2026-09-04, and see the prime bound in tick). It also seeds
        // `lastTickMs`, so the first SCHEDULED tick honours the duty-cycle floor instead of assuming
        // the boot pass was free.
        tickWithBudget()
      } finally {
        primeProgress = undefined
      }
      scheduleTick()
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      if (nudgeTimer) clearTimeout(nudgeTimer)
      nudgeTimer = null
      // A clean shutdown is the cheapest moment to make the next boot free: write back everything the
      // periodic flush has not reached yet. A hard kill just costs that thread its delta re-read.
      flushCache(now())
    },
    tick,
    nudge,
  }
}

// An event "lands after last_read_at" when there is no prior read, or the event's timestamp is
// strictly newer than it. Bad/absent timestamps fail safe to marking unread.
function landsAfterRead(eventAt: string, lastReadAt: string | null): boolean {
  if (!lastReadAt) return true
  const e = Date.parse(eventAt)
  const r = Date.parse(lastReadAt)
  if (!Number.isFinite(e) || !Number.isFinite(r)) return true
  return e > r
}
