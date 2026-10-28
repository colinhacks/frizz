import {
  existsSync,
  realpathSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import watcher from "@parcel/watcher"
import type { BoardDelta, BoardSnapshot, ClaudeModel, ThreadView, RuntimeState, ThreadRecurringPrompt, ProviderError } from "@frizz/shared"
import { standingQuestions, type QuestionFenceFault } from "./question-fences.ts"
import { AskedQuestionSchema, BoardDiffer, activeBandThreadAt, PermissionMode, SnoozeUntil, ThreadSlug, awaitingNeedsInput, formatElapsed, awaitingStatus, awaitingSteps, isDirectSubAgent, splitDoneFrontmatter, needsInputRequired, nameQuestionAnswer, questionAnswerMessage, questionsCancelledWakeMessage, type AskedQuestion, type NamedQuestionAnswer, type PermissionMode as PermissionModeValue, type QuestionAnswer, type QuestionDismissal } from "@frizz/shared"
import type { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { isHeadlessRow, isBrokerClaudeRow, sessionTitleLocked, type ThreadQuestionRow } from "./storage.ts"
import type { Storage, SessionRow, PrWatchRow, ThreadTimerRow, ThreadWatchRow, ThreadLinkRow, CommandWatchRow } from "./storage.ts"
import { threadLinkView } from "./thread-links.ts"
import { normalizeObservedThreadModel } from "./backend/thread-profiles.ts"
import { claudeModelStanding } from "./backend/claude-model-upgrade.ts"
import type { Tailer, SessionTelemetry, FenceView } from "./tailer.ts"
import { firstTextLine } from "./tailer.ts"
import type { InteractionChange } from "./interaction-store.ts"
import { frizzDirExists } from "./frizz.ts"
import { githubStatusKey, idlePrsOf, liveActivityOf, needsInputParkHolds, parseIssueRef, parsePrRef, readAwaitingPark, readGithubIssueStatusBook, readGithubStatusBook, GITHUB_ISSUE_STATUS_SETTING, GITHUB_STATUS_SETTING, type GithubIssueStatusBook, type GithubStatusBook } from "./awaiting.ts"
import { findByPath } from "./project-registry.ts"
import { parseDeliveryLedger } from "./delivery-ledger.ts"
import { effectivePermissionMode, fallbackTitle, resolveLegacyThreadFile } from "./dispatch.ts"
import { ProducerStoppedError } from "./shutdown.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"
import { limitPauseIsStale, textResetInstant } from "./backend/usage-limit.ts"
import { getSettings } from "./settings.ts"

// The read model is provenance-bound to the durable session registry. A session row exists only after
// Frizz dispatches or explicitly adopts a thread, so unrelated legacy `.frizz/*.md` files and raw
// terminal transcripts never enter this board (or its queue/error surface). The tailer contributes
// telemetry only for registered rows. Plan documents remain project artifacts and are read separately.

const DEBOUNCE_MS = 150
// Level-triggered reconcile period: a periodic full rebuild that re-publishes if anything drifted.
// NOTE: this bounds SERVER-side staleness, not end-to-end UI staleness. It is the ceiling only WHILE
// the SSE socket is delivering; if the socket dies silently the client keeps its last frame until ITS
// own heartbeat watchdog fires and reconnects — real worst case ≈45-60s (sse.ts HEARTBEAT_TIMEOUT 35s
// + the 10s health tick). See sse.ts.
const RECONCILE_MS = 15_000

// A codex app-server turn that reads in-flight but is driven by NOBODY. The rollout is a lagging log:
// when the app-server process dies mid-turn it simply stops, so the folded turn stays "in-flight"
// forever and the thread spins on `running` — never at rest, so never queued, so invisible (four
// threads sat like this for hours on 2026-07-22). The bridge is the authority on whether a turn is
// actually running; a rollout that has not advanced since frizz took the thread onto its current
// connection is being driven by nobody at all.
//
// Rollout activity AFTER that instant means some OTHER writer is driving the thread — the operator
// running `codex resume` in their own terminal — which is a real live turn frizz is mirroring. Keep it.
//
// The grace exists because the two signals are read from different places: the bridge clears its turn
// on `turn/completed` while the rollout's matching record still has to reach the tailer's next tick.
// Without it, the end of every normal turn could flash "stalled" for a beat. A genuine stall is a rare
// event nobody is watching in real time, so paying half a minute of latency to make a false stall
// impossible is the right trade.
const STALL_GRACE_MS = 30_000
export function appServerTurnStalled(
  liveness: { bridgeTurn: boolean; ownedSince: string } | undefined,
  lastActivityAt: string | undefined,
  nowMs: number,
): boolean {
  // Not bridge-owned — frizz has never held this thread, so it has no standing to call the turn dead.
  if (!liveness) return false
  if (liveness.bridgeTurn) return false
  const ownedSince = Date.parse(liveness.ownedSince)
  if (!Number.isFinite(ownedSince)) return false
  const advanced = lastActivityAt ? Date.parse(lastActivityAt) : NaN
  if (Number.isFinite(advanced) && advanced >= ownedSince) return false
  return nowMs - ownedSince > STALL_GRACE_MS
}

// Runtime derivation: no session row → never spawned (none); a row whose worker is dead/absent →
// exited; a live session paused on a permission prompt → perm-prompt (reported by the bridge, no
// jsonl signal); otherwise the tailer's turn state (running while a turn is in flight, turn-idle
// once it ends).
function deriveRuntime(
  slug: string,
  row: SessionRow | undefined,
  storage: Storage,
  turn: "in-flight" | "idle" | undefined,
  permPrompt: boolean,
  appServerStalled = false,
  // BROKER-ONLY: the daemon is gone AND this thread still tracks live sub-agents. Distinct from
  // appServerStalled, which is a MID-TURN predicate — see the headless branch below.
  headlessLostWork = false,
): RuntimeState {
  if (!row) return "none"
  // App-server codex sessions have NO process of their own for frizz to probe. A persisted bridge
  // thread is always resumable, so liveness is never "is some process alive" — it's the rollout-tailed
  // turn state. Probing for one here would mark every headless thread "exited" (and, mid-turn, trip
  // the crash-net). Never do that.
  if (isHeadlessRow(row)) {
    // ONLY WHILE THE PROCESS IS THERE TO BE ANSWERED. A marker is a file, and it outlives the daemon
    // that was parked on it: a worker whose daemon died mid-request kept reading as a live approval,
    // the operator pressed Grant into a dead socket, the block cleared, and the row turned Stalled —
    // so approving looked like the thing that crashed it. A dead process falls through to the stall.
    if (permPrompt && !appServerStalled) return "perm-prompt"
    // Checked BEFORE the idle branch, which is the whole point. A worker that came to rest holding live
    // sub-agents and whose daemon then died is NOT at rest: an Agent child runs IN-PROCESS inside that
    // `claude` (orphan-reaper.ts: "a worker's only OS-level agent process is its session root — Agent
    // sub-agents are in-process"), so those children died with it, and the worker is parked forever on a
    // wake that can never arrive. Reading `turn === "idle"` first made this thread `turn-idle`, which
    // satisfied deriveNeedsYou's `runtime !== "exited"` guard while the phantom child kept hasLiveOwnWork
    // true — so it was EXCUSED from the queue and, needing "exited", never carded as crashed either.
    // Neither queued nor carded: invisible. The sub-agent twin of the shell phantom fixed in a24d5ec.
    if (headlessLostWork) return "exited"
    if (turn === "idle") return "turn-idle"
    // Mid-turn with nobody driving it: the process that owned this turn is gone. Reuse "exited" so the
    // pair (exited + in-flight) trips the SAME crash-net a dead worker does — the thread cards as
    // "Stalled" and enters the queue instead of spinning forever.
    return appServerStalled ? "exited" : "running"
  }
  // Every live row is headless and returned above. Anything reaching here is a PRE-CUTOVER row whose
  // transport was an interactive terminal — frizz has driven none since the broker landed, so that
  // row's process cannot be alive. Reporting "exited" is what puts it in front of the operator
  // (stalled card + Retry) instead of leaving it spinning against a liveness probe that can never
  // succeed.
  void slug; void permPrompt; void turn
  return "exited"
}

// A worker whose transcript never materialized (a boot failure the tailer flagged noTranscript) would
// otherwise read "running" forever — deriveRuntime sees a bridge-owned row with no telemetry and
// defaults to running, so the row spins with nothing to tail. Downgrade ONLY that spinner to the degraded
// "exited" affordance ("Stalled", a "!" glyph); with the "in-flight" turn a transcript-less session keeps,
// this also trips deriveNeedsYou's crash-net so it cards for the human. Every other runtime is left as-is
// (a dead worker is already "exited"; a healthily-bound session is never noTranscript). Reused "exited" rather
// than minting a new RuntimeState — see session-transcript-drift (a distinct error enum is a follow-up).
export function degradeIfNoTranscript(runtime: RuntimeState, noTranscript: boolean | undefined): RuntimeState {
  return noTranscript && runtime === "running" ? "exited" : runtime
}

// THE INVARIANT: a thread waiting on an answer is never reported as running. One rule, one place, and
// every surface downstream reads the runtime it produces — so the two cannot disagree.
//
// They did. The chat draws its shimmer off `runtime === "running"|"spawning"` and its answerable
// ```question card off the transcript; the rail bands on `needsYou`, which deriveNeedsYou refused to
// grant anything not at rest. So one record that re-opened the turn — a task-notification, a wake
// pulse, an echoed tool_result, none of which the chat even renders — put a thread in the ACTIVE rail,
// shimmering "Thinking…", above a live question card with a Send answers button (maintainer 2026-08-24:
// "this needs to be structurally impossible… it represents a complete failure of frizz").
//
// Fixing the derivations was necessary and not sufficient: a fix inside `pendingQuestion` leaves the
// next signal free to re-open the same gap. Degrading the RUNTIME closes it structurally, because
// `runtime` is the ONE value both surfaces read to decide whether anything is moving. Downgraded to
// "turn-idle", not "exited": the process IS alive, and the agent may well still be mid-turn — this
// says only that the row must not present as motion while it owes the human an answer. The agent's own
// next message clears the ask and the spinner comes straight back.
export function degradeIfAwaitingAnswer(runtime: RuntimeState, pendingQuestion: boolean | undefined): RuntimeState {
  return pendingQuestion && (runtime === "running" || runtime === "spawning") ? "turn-idle" : runtime
}

// Display fields are ONE-LINERS in every surface that renders them — cap them at the server so a
// thread whose agent wrote an essay into status_text can't fatten every snapshot push (on a large
// board these two fields alone were half a megabyte).
const LINE_CAP = 240
function capLine(s: string | undefined | null, cap = LINE_CAP): string | undefined {
  if (!s) return undefined
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s
}

// ---- Session threads (2026-07-09): the working rail's unit — exactly one ThreadView per durable
// registry row. The legacy frizz status vocabulary does not apply: `status` is synthesized "active"
// (the field is required but display keys on kind/state/needsYou), and block/dep fields are inert.

// Parse an ISO time to epoch-ms, or -Infinity when absent/unparseable (a missing clearance never
// beats a real activity time in the needsYou compare below).
function timeOrNegInf(s: string | null | undefined): number {
  if (!s) return -Infinity
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : -Infinity
}

// The best guess at when a thread already in the Running band at boot entered it (stampRunningSince):
// its newest user turn or its dispatch, whichever is later — the key the band sorted by before it had
// an entry instant of its own. Undefined when the thread carries neither.
function enteredBeforeBoot(t: Pick<ThreadView, "lastUserAt" | "spawnedAt">): string | undefined {
  const user = timeOrNegInf(t.lastUserAt)
  const spawned = timeOrNegInf(t.spawnedAt)
  if (user === -Infinity && spawned === -Infinity) return undefined
  return user >= spawned ? t.lastUserAt : t.spawnedAt
}

// EFFECTIVE lifecycle state for a registered session row (open|archived). An explicit state write wins;
// otherwise the historical archived bit migrates older rows without consulting unrelated files.
function effectiveSessionState(row: SessionRow, registeredLegacyTerminal: boolean): "open" | "archived" {
  if (row.state === "open" || row.state === "archived") return row.state
  if (row.archived === 1) return "archived"
  if (registeredLegacyTerminal) return "archived"
  return "open"
}

// Pre-session-first Frizz rows may have state=NULL and derive their archived state from a paired
// terminal thread document. Preserve that migration behavior without scanning the directory: open
// only the canonical filename selected by a durable session row, reject symlinks at open time, and
// read only whether status is `done`/`dismissed`. Malformed or missing files fail open as an active session and never
// contribute a board parser error.
function registeredLegacyFileIsTerminal(projectDir: string, slug: string): boolean {
  const file = resolveLegacyThreadFile(projectDir, slug)
  if (!file) return false
  const frontmatter = file.contents.toString("utf8").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  const raw = frontmatter?.match(/^status:\s*(.*?)\s*$/m)?.[1]
  const status = raw?.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2").trim()
  return status === "done" || status === "dismissed"
}

// WHAT A `.frizz` FILESYSTEM EVENT CAN ACTUALLY CHANGE ABOUT THIS BOARD, and it is one thing:
// `legacyTerminalCache`, whose only input is `.frizz/<slug>.md` — a DIRECT child of `.frizz`
// (resolveLegacyThreadFile opens nothing else and rejects anything whose resolved dirname is not
// `.frizz` itself). Everything else `assemble()` reads is ui.db and tailer state, and both arrive on
// their own edges. So a full rebuild is warranted by a top-level `.md` and by nothing else down there.
//
// That distinction is worth money because `.frizz/` is NOT only board state. Frizz hands every
// dispatched worker `.frizz/threads/<session-id>/` as a free-form scratch directory it may fill as it
// likes (dispatch.ts), and the board CLI keeps a per-session sentinel plus a `.seen` liveness
// heartbeat under `.frizz/.session-state/` (board/config.mjs) — on this checkout, 715 scratch
// directories and 559 sentinels. Watching the whole tree recursively turned every note any agent wrote
// into a full rebuild, and a rebuild is thousands of SYNCHRONOUS node:sqlite queries on the event loop
// (five per thread across 637 threads here). Measured 2026-09-04: the board RPC answers in 4.5-10ms on
// an idle server and in 49-1069ms (median ~270ms) on the maintainer's live one, whose own log carries
// 220 "the event loop is blocked" tick warnings, median 1.5s. Agents were manufacturing the stall that
// made the UI they run under feel slow.
//
// Two filters, deliberately both. `ignore` prunes the noisy subtrees in the native layer, so on inotify
// no watch descriptor is ever spent on those 715 directories and on fs-events the event never reaches
// JS at all. The predicate is the CORRECTNESS half: it is an allow-list of what the board reads, so a
// tree nobody has thought of yet costs one string test rather than a rebuild.
//
// `worktrees` is the largest of them by far: the worker contract puts every git worktree at
// `.frizz/worktrees/<slug>/` (workerPrompt.ts § Git worktrees), and each one is a whole checkout with
// its own `node_modules` and build output. Nothing the board reads is in there, and on inotify an
// unpruned checkout costs a watch descriptor per directory.
const FRIZZ_WATCH_IGNORED_DIRS = ["threads", ".session-state", "worktrees"]

// True when a watcher event names a file the board would actually re-read. `roots` holds every spelling
// the watched `.frizz` may be reported under — see watchFrizzDir for why there is more than one.
//
// FAILING OPEN IS THE RIGHT FAILURE: a spurious rebuild costs milliseconds, a dropped one costs up to
// RECONCILE_MS of a stale sidebar. So this accepts every direct-child `.md`, not only the ones whose
// stem is a live session slug — an unregistered `foo.md` contributes nothing to the board, but keeping
// it out of the predicate would buy a rounding error and put the answer at the mercy of the registry.
export function isBoardRelevantFrizzPath(roots: ReadonlySet<string>, path: string): boolean {
  return path.endsWith(".md") && roots.has(dirname(path))
}

function futureSnooze(row: Pick<SessionRow, "snoozed_until">, nowMs: number): string | undefined {
  const parsed = SnoozeUntil.safeParse(row.snoozed_until)
  return parsed.success && Date.parse(parsed.data) > nowMs ? parsed.data : undefined
}

// The ONE signal that a rested top-level turn is still working: a live dispatched SUB-AGENT. A child
// exists only because this worker asked for it and intends to act on what it returns, so its liveness
// really does mean "not a handoff yet".
//
// A background SHELL deliberately does NOT count (maintainer 2026-07-22). `run_in_background` says
// only "don't block my turn" — it cannot distinguish a CI watcher the worker is parked on from a vite
// dev server it started as infrastructure and moved on from, and a corpus survey found 26% of real
// background launches are the latter (long-lived servers/stacks). Counting them buried a genuinely
// finished thread behind a process that is never going to end. Erring the other way is cheap: a
// spurious queue card costs one click, while a wrongly-held thread is invisible for hours. A worker
// that actually wants to wait dispatches a sub-agent to own the wait — see the worker contract.
//
// DIRECT children only (isDirectSubAgent). `subAgents` also carries the thread's live DESCENDANTS now —
// a sub-agent's own sub-agents — but those are a rendering concern and must never move thread state: a
// descendant's row is derived from a sidecar plus a liveness reading, so counting one would put thread
// state at the mercy of that reading rather than of a signal about this thread's OWN work. A running
// descendant implies a running-or-rested direct child anyway, so nothing is lost by reading only the
// top level.
function hasLiveBackgroundWork(tele: SessionTelemetry | undefined): boolean {
  return Boolean(tele?.subAgents?.some((agent) => isDirectSubAgent(agent) && agent.state === "running"))
}

// The same question asked of a thread whose owning process is PROVABLY GONE, where `stale` stops being
// ambiguous. Everywhere else `stale` means only "we lost this child's completion signal and its
// transcript has been quiet past its window" — 15 minutes, counted from the deadline of the Bash wait it
// declared when it is blocked in one (tailer.ts pendingCallDeadline). It could equally be a finished
// child whose notification never landed, which is why hasLiveBackgroundWork deliberately counts
// `running` alone.
// Against a dead daemon there is nothing left to be ambiguous about: an Agent child ran IN-PROCESS
// inside that `claude`, so a still-unretired child of it was lost, full stop.
//
// This exists because the staleness clock quietly UNDID the stall. Measured on the real fold: a child
// whose owner died reads `running` for 15 minutes and `stale` for ever after — so keying the stall on
// `running` alone carded the thread correctly for 15 minutes and then let it settle into an ordinary
// bare rest, telling the human nothing about the work that died with it. Sizing the widened predicate
// against this machine's real board 2026-08-02: of 35 open broker rows, 14 had a dead daemon and ZERO
// held an unretired dispatch — so it cards nothing extra today, and is here for when it does.
function hasUnretiredOwnAgents(tele: SessionTelemetry | undefined): boolean {
  return Boolean(tele?.subAgents?.some((agent) => isDirectSubAgent(agent) && (agent.state === "running" || agent.state === "stale")))
}

// Whether each live child can ACTUALLY be ended, answered here because this is the only place that
// holds both the session row (which knows the transport) and the tailer's telemetry (which knows the
// children). The client renders the stop × off this and never re-derives it — see SubAgentView.stoppable.
//
// Only a broker-backed Claude thread has a per-child control channel: `Query.stopTask`, whose registry
// is session-wide (so a DESCENDANT is as reachable as a direct child — whether the × is offered on a
// descendant ROW is a separate client-side question about whether the row can then be cleared). A
// legacy pre-broker claude row ran its sub-agents inside the CLI process and a codex thread runs its
// own inside itself; neither exposes anything to address one child with, so those rows must not offer
// a stop at all.
//
// Only RUNNING rows are marked: a stale/rested row's × means "clear this from the list", which needs no
// provider control and works everywhere. The flag answers "can this be KILLED", not "can this be clicked".
// A DEAD BROKER DAEMON TOOK ITS SUB-AGENTS WITH IT — they are in-process children of that process — so a
// child the fold still reads `running` is shown `stale` in the VIEW. The fold only ages one out after
// SUBAGENT_STALE_MS of silence (or that long past the deadline of a Bash wait it declared, which can
// be hours away), and until then the rail spun a child (and offered to stop it) beside a
// thread the same view carded as crashed. View-only on purpose: `crashed`, `headlessLostWork` and the
// queue read the raw telemetry above, which is where that meaning lives. (Shells need none of this:
// bgShellViews already empties on a dead owner.)
function orphanedAgents(agents: ThreadView["subAgents"], ownerGone: boolean): ThreadView["subAgents"] {
  if (!ownerGone) return agents
  return agents.map((agent) => (agent.state === "running" ? { ...agent, state: "stale" } : agent))
}

function stampStoppable(agents: ThreadView["subAgents"], row: SessionRow): ThreadView["subAgents"] {
  if (!isBrokerClaudeRow(row)) return agents
  return agents.map((agent) => (agent.state === "running" ? { ...agent, stoppable: true } : agent))
}

// The same question for a background SHELL, and it is deliberately the other way round: the tailer has
// already said whether frizz holds a handle for each shell (BgShellView.stoppable), so all this adds is
// the TRANSPORT half — and on a thread with no control channel it must REVOKE the tailer's half rather
// than merely decline to add one. A shell on a legacy pre-cutover thread carries a task id in its
// launch ack just the same; nothing outside that worker's own terminal could ever act on it.
//
// BOTH headless runtimes have a per-shell channel, reached differently and verified separately:
//   claude broker    → `Query.stopTask(taskId)`                     (backend/_live_shell_stop.mts)
//   codex app-server → `thread/backgroundTerminals/terminate`       (backend/_live_codex_bgterm.mts)
// so the predicate is "headless", not "broker Claude" — and a codex row's shells, which only exist at
// all because the app-server stream reported them, are never stripped here.
function stampStoppableShells(shells: ThreadView["bgShells"], row: SessionRow): ThreadView["bgShells"] {
  if (isHeadlessRow(row)) return shells
  return shells.map((shell) => (shell.stoppable ? { ...shell, stoppable: false } : shell))
}

// The thread's OWN dispatched work is still live — a sub-agent OR a launched background shell. It drives
// the resting CARD (deriveAwaitingBackground) and its event-snooze, and deliberately NOT the queue
// excusal: hasLiveBackgroundWork (sub-agents only) is what excuses a rest from the queue, because a
// detached shell leaves a thread that is a handoff in substance (see deriveNeedsYou). Shells were folded
// into the excusal on 2026-08-01 and taken back out on 2026-08-04; the CARD spanned both kinds
// throughout, which is why the two predicates exist side by side.
//
// hasLiveBackgroundWork also owns the CRASH bit, where the same distinction is real: a dead worker with
// a child still reading "running" died mid-work, while a dead worker with a shell behind it is just a
// shell whose owner is gone.
// ---- THE DECLARED PARK ---------------------------------------------------------------------------
// A thread is "awaiting background work" when it SAYS SO, naming what it waits on — not when frizz
// notices it happens to have something running. That inference is what put the resting card on a thread
// whose only background work was a dev server nobody ever tore down: true by the letter, useless as a
// signal (maintainer 2026-08-14: "For it to be truly awaiting something, it needs to list it
// explicitly").
//
// THE FENCE REGISTERS NOTHING. It is display-only, and its whole job is to let a worker come to rest
// without being bumped for a handoff. A background shell already wakes its agent when it finishes — the
// harness reports the completion and the transcript carries a `wake` boundary for it, which is the
// hairline you see in chat — and a sub-agent's return re-invokes its parent. Frizz does not need to arm
// anything for either, and an earlier version of this that did was solving a problem that does not
// exist (maintainer 2026-08-14: "Any time a background shell completes, it should notify the agent…
// Both subagents and background shells should be display-only here").
//
// SO THE CHECK IS AN INTEGRITY CHECK, not a registration lookup: every item named must correspond to
// something this thread ACTUALLY has out right now — a running background shell, a running sub-agent, or
// a parked PR watcher (maintainer 2026-08-14: "Make sure that the items therein correspond to actual
// background shells or agents or watchers"). A name that matches nothing is not a park, and the thread
// queues exactly as it would have; a typo must never be a way to disappear from the board.
//
// A FIXED-PERIOD WAIT NEEDS NO SYNTAX EITHER. A worker that wants to wait ten minutes starts a
// background `sleep` and awaits that shell, which is the same mechanism with no new grammar.
const DECLARED_PARK_MAX_MS = 24 * 60 * 60 * 1000

/** The names this fence gives to the thread's OWN RUNNING WORK — its shells and its sub-agents.
 *
 *  Deliberately NOT every item kind. `timer:` and `pr:` name rows in their own registries and are
 *  checked against those; these two name runtime handles and are checked against live telemetry
 *  (liveWaitHandles). Mixing them here would compare a `tmr_…` id against a set of shell handles and
 *  find it missing every time, which reads as "the worker named something dead" for a wait that is
 *  perfectly healthy. */
export function declaredWaitIds(tele: SessionTelemetry | undefined): string[] {
  if (tele?.lastFence?.kind !== "awaiting") return []
  return readAwaitingPark(tele.lastFence.hints).items
    .filter((i) => i.kind === "shell" || i.kind === "agent")
    .map((i) => i.value)
}

/** Everything this thread could legitimately claim to be waiting on, by the handle the worker sees: a
 *  background shell's id or its label, a sub-agent's dispatch id or its label. Labels count because that
 *  is what the worker reads back in its own transcript, and refusing a correct-but-label-shaped name
 *  would make the fence unusable for the case it exists for. */
function liveWaitHandles(tele: SessionTelemetry | undefined): Set<string> {
  const handles = new Set<string>()
  for (const shell of tele?.bgShells ?? []) {
    if (shell.state !== "running") continue
    // THREE HANDLES, and the third is the one that matters most: `taskId` is what the runtime actually
    // told the worker ("Command running in background with ID: bzvtnt3ig"), while `id` is the launch
    // tool_use id and `label` the command summary. A worker naturally names the string it was shown, so
    // omitting it would make the honest fence fail its own integrity check (measured 2026-08-14: every
    // shell watcher armed the obvious way missed its target for exactly this reason).
    if (shell.id) handles.add(shell.id)
    if (shell.taskId) handles.add(shell.taskId)
    if (shell.label) handles.add(shell.label)
  }
  for (const agent of tele?.subAgents ?? []) {
    if (!isDirectSubAgent(agent) || agent.state !== "running") continue
    // The same three, for the same reason: `taskId` is the `agentId` of the Agent launch ack — the only
    // id the model is shown for its child. Until 2026-08-28 a sub-agent answered to two, and a worker that
    // named the id it was handed was refused (thread review-and-babysit-zod-pr-6471).
    handles.add(agent.id)
    if (agent.taskId) handles.add(agent.taskId)
    if (agent.label) handles.add(agent.label)
  }
  return handles
}

/** The same live handles as `liveWaitHandles`, but resolved rather than merely tested — for
 *  `frizzctl watch`, which has to answer three questions the fence's integrity check never asks:
 *  does this handle name anything live, WHICH KIND is it, and what is the work called.
 *
 *  THE KIND IS RESOLVED, NOT TRUSTED. A shell handle and a sub-agent handle are both opaque runtime
 *  strings — `toolu_…` on both sides, a free-text label on both sides — so nothing about the string
 *  itself can tell them apart, and a validator that guessed from shape would guess wrong. Live telemetry
 *  can answer it exactly, which is what lets `watch` refuse `kind: "shell"` on a sub-agent by NAME
 *  ("that is a sub-agent") rather than by silently filing it under a Background shells heading — the
 *  exact miss that put two sub-agents under that heading on 2026-08-26.
 *
 *  RUNNING ONLY, matching liveWaitHandles: registering a watch on work that has already finished would
 *  park a thread on a wake that can never come. The worker is told so and moves on. */
export function resolveLiveWatchTarget(
  tele: SessionTelemetry | undefined,
  target: string,
): { kind: "shell" | "agent"; label?: string } | undefined {
  const wanted = target.trim()
  if (!wanted) return undefined
  for (const shell of tele?.bgShells ?? []) {
    if (shell.state !== "running") continue
    if (shell.id === wanted || shell.taskId === wanted || shell.label === wanted) {
      return { kind: "shell", ...(shell.label ? { label: shell.label } : {}) }
    }
  }
  for (const agent of tele?.subAgents ?? []) {
    if (!isDirectSubAgent(agent) || agent.state !== "running") continue
    if (agent.id === wanted || agent.taskId === wanted || agent.label === wanted) {
      return { kind: "agent", ...(agent.label ? { label: agent.label } : {}) }
    }
  }
  return undefined
}

/** Is this thread parked on its OWN BACKGROUND WORK, named in its fence and still live?
 *
 *  A PR WAIT is deliberately NOT this. It is also a declaration and it also cards — but whether
 *  it parks depends on the PR's own state, which `hasDeclaredWait` handles. Own background work is the
 *  simple case: it reports on its own, and there is nothing for the human to do meanwhile. */
export function hasDeclaredBackgroundPark(
  tele: SessionTelemetry | undefined,
  nowMs: number,
): boolean {
  const named = declaredWaitIds(tele)
  if (named.length === 0) return false
  const live = liveWaitHandles(tele)
  // ALL of them, not any: the thread said it was waiting on every one, so a single dead name means the
  // fence no longer describes reality and frizz should stop believing it.
  if (!named.every((id) => live.has(id))) return false
  // A park with no expiry is the dev-server problem inverted: instead of a card that lies, a thread that
  // disappears. The fence's own instant bounds it without any new syntax.
  const restedMs = Date.parse(tele?.lastAssistantAt ?? "")
  if (Number.isFinite(restedMs) && nowMs - restedMs > DECLARED_PARK_MAX_MS) return false
  return true
}

/** A stored question's spec, or undefined when it no longer parses — a schema change, a hand-written
 *  row. Undefined is DROPPED by every caller rather than thrown on: one unreadable row must not blank a
 *  card carrying three good ones. Duplicated in router.ts for the worker's own read-back, which cannot
 *  reach into the board. */
export function safeQuestionSpec(spec: string): AskedQuestion | undefined {
  try {
    const parsed = AskedQuestionSchema.safeParse(JSON.parse(spec))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** A stored ANSWER, or undefined when it no longer parses. Same drop-don't-throw discipline as the spec
 *  above, and shared with the scheduler so the delivery and the board can never read one row two ways. */
export function safeQuestionAnswer(raw: string | null): QuestionAnswer | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed?.questionId === "string" && typeof parsed?.question === "string" ? parsed as QuestionAnswer : undefined
  } catch {
    return undefined
  }
}

/** A row's stored answer AS A MESSAGE CARRIES IT: each question named by the id the worker asked it
 *  under, read off the row and its spec tree at this moment and never stored (shared
 *  nameQuestionAnswer). The board's in-flight card and the scheduler's delivery both compose from this,
 *  which is what keeps the two byte-identical — and an answer stored before the wake learned the id
 *  (2026-10-13) is named all the same, because nothing about it was missing from the row. */
export function wakeQuestionAnswer(q: Pick<ThreadQuestionRow, "answer" | "spec" | "handle">): NamedQuestionAnswer | undefined {
  const parsed = safeQuestionAnswer(q.answer)
  return parsed && nameQuestionAnswer(parsed, safeQuestionSpec(q.spec), q.handle)
}

/** THE ANSWER THE HUMAN HAS ALREADY SENT, WHICH THE WORKER HAS NOT SEEN YET — as the exact message the
 *  delivery will carry, so the card the chat draws while it is in flight and the card it draws once it
 *  lands are built from the same bytes and the swap is invisible.
 *
 *  Answering and delivering are two acts on purpose: an answer given while the worker's process was down
 *  has to survive the gap. But the gap is a HOLE ON SCREEN — the question card is gone the instant the
 *  answer is stored, and until the wake lands there is nothing in its place, so a thread at rest with
 *  nothing registered any more drew the residual "Rested without a sign-off" card in it (maintainer
 *  2026-08-27). This is what fills it: the human's own answer, from the registry, at 50% until the worker
 *  actually has it.
 *
 *  SPENT BY THE WORKER RECEIVING IT, as the transcript shows it. `delivered` is the OUTBOX's verdict on
 *  the carrying wake (scheduler.evalQuestionAnswers) and can lead the transcript — a daemon's
 *  acknowledgement files the wake before the record lands — so keying on it would reopen the same hole
 *  a moment wide. The transcript is the honest test: the newest USER record, which is what frizz's
 *  delivery becomes at a turn's start, or the `queued_command` attachment it becomes when the worker takes
 *  it mid-turn (`receivedAt` is the later of the two — answersReceivedAt). A dismissal alone shows nothing: nobody is being
 *  woken for it, so there is no arrival to bridge to — UNLESS `wakeOnDismissals` says one is. On an
 *  AUTONOMOUS thread (a Goal armed on rest — the exact gate evalQuestionAnswers wakes on) the
 *  cancellation wake IS coming, and without this the instant between arming the Goal and that wake
 *  landing was the same hole all over again: the question card gone, nothing in its place, and the
 *  residual "Rested without a sign-off" card claiming a bare rest of a thread that had asked
 *  (maintainer 2026-09-02). The message is the wake's own bytes, exactly as for an answer. */
export function answersInFlight(rows: readonly ThreadQuestionRow[], receivedAt: string | undefined, wakeOnDismissals = false): string | undefined {
  const userAt = receivedAt ? Date.parse(receivedAt) : Number.NaN
  const answers: NamedQuestionAnswer[] = []
  const dismissed: QuestionDismissal[] = []
  for (const q of rows) {
    if (q.settled_at == null) continue
    if (Number.isFinite(userAt) && userAt >= q.settled_at) continue
    if (q.state === "dismissed") {
      const spec = safeQuestionSpec(q.spec)
      if (spec) dismissed.push({ question: spec.question, ...(q.handle ? { handle: q.handle } : {}) })
      continue
    }
    if (q.state !== "answered") continue
    const parsed = wakeQuestionAnswer(q)
    if (parsed) answers.push(parsed)
  }
  if (answers.length > 0) return questionAnswerMessage(answers, dismissed)
  // questionAnswerMessage would compose the same cancellation wake for an empty answers list; calling
  // the producer directly keeps this branch readable as what it is — frizz's own "nobody is coming".
  return wakeOnDismissals && dismissed.length > 0 ? questionsCancelledWakeMessage(dismissed.length, dismissed) : undefined
}

/** WHEN THE WORKER LAST RECEIVED ANYTHING, as the two tests above read it: the newest user record, or the
 *  newest delivery it took mid-turn, whichever is later. A delivery queued behind a running turn reaches
 *  the model as a `queued_command` attachment and no user record ever follows it, so reading
 *  `lastUserAt` alone kept those answers "in flight" until the next human message. In that time the
 *  tail drew the board's copy under the transcript's, the sign-off reminder and a Goal's rest prompt
 *  stood down for a delivery that had already landed, and a question dismissed meanwhile drew as an
 *  empty Answers card (thread `abuse-monitor`, 2026-10-19). */
export function answersReceivedAt(tele: { lastUserAt?: string; lastMidTurnDeliveryAt?: string } | undefined): string | undefined {
  const user = tele?.lastUserAt
  const midTurn = tele?.lastMidTurnDeliveryAt
  if (!midTurn) return user
  if (!user) return midTurn
  return Date.parse(midTurn) > Date.parse(user) ? midTurn : user
}

/** How long a stored answer excuses its thread from the queue while the wake carrying it has not landed.
 *  The delivery normally lands within seconds (answerQuestions kicks the scheduler at once); a worker
 *  that has to be resumed first takes longer. The cap is what keeps the excusal honest: a wake the
 *  outbox EXHAUSTS never produces the user record that ends it — the answer stays undelivered and is
 *  offered again later (scheduler ANSWER_REOFFER_BACKOFF_MS), but not soon — and without a bound that
 *  thread would sit out of the queue, answered and unwoken, with nothing on screen to say so. */
export const ANSWER_IN_FLIGHT_EXCUSAL_MS = 60_000

/** Has the human answered a registered question that the worker has not received yet, recently enough
 *  to trust that the wake is still on its way? Answers only: a dismissal wakes nobody on its own. Reads
 *  the same receipt test as answersInFlight, so the two can never disagree on arrival. */
export function answerAwaitingDelivery(rows: readonly ThreadQuestionRow[], receivedAt: string | undefined, nowMs = Date.now()): boolean {
  const userAt = receivedAt ? Date.parse(receivedAt) : Number.NaN
  return rows.some((q) =>
    q.state === "answered" &&
    q.settled_at != null &&
    !(Number.isFinite(userAt) && userAt >= q.settled_at) &&
    nowMs - q.settled_at < ANSWER_IN_FLIGHT_EXCUSAL_MS
  )
}

/** One armed `thread_watch` row, as the board reads it — the registry half of a wait, where
 *  `declaredWaitIds` is the fence half. */
export interface RegisteredWatch {
  id: string
  kind: "shell" | "agent"
  target: string
  createdAt: string
  expiresAt: string
}

/** Is this thread parked on a wait it REGISTERED, rather than one it declared in a fence?
 *
 *  ANY live row parks, where the fence needs ALL of its names live. The two rules differ because the
 *  objects do: a fence is one sentence about every name in it, so a single dead name means the whole
 *  sentence has stopped describing reality. A registration is its own row with its own expiry, made at
 *  its own moment, and one of them settling says nothing about the others.
 *
 *  THE TARGET MUST STILL RESOLVE LIVE, exactly as a `shells:` name must. The row is the worker's claim
 *  that it is waiting; telemetry is whether there is anything left to wait for. Settling a row whose
 *  work has ended is the scheduler's job — a read never mutates — so until it runs, a stale row simply
 *  stops parking.
 *
 *  AND THE EXPIRY IS THE ROW'S OWN, not the fence's blanket DECLARED_PARK_MAX_MS. That was the one thing
 *  an un-restated fence could never get right: one park duration for every wait, chosen by nobody. */
export function hasRegisteredBackgroundPark(
  tele: SessionTelemetry | undefined,
  armedWatches: readonly RegisteredWatch[],
  nowMs: number,
): boolean {
  return armedWatches.some((w) => {
    const expiresAt = Date.parse(w.expiresAt)
    if (Number.isFinite(expiresAt) && nowMs >= expiresAt) return false
    return resolveLiveWatchTarget(tele, w.target)?.kind === w.kind
  })
}

/** COMMAND WATCHES RIDE THE TIMERS' SET (2026-10-11). A `cmw_…` row is the same kind of wait as a
 *  `tmr_…` one for every reading below: a registration the SCHEDULER fires, with no process of the
 *  thread's behind it, that wakes the thread fence or no fence. So the board carries both in one set of
 *  armed ids (sessionThreadView), and splits them back by this prefix only where a fence line's KIND has
 *  to match the row it names — a `timers:` line naming a command watch is a wrong fence, and the
 *  scheduler bumps it, so the board must not honour it either. Ids are minted by the router alone. */
const COMMAND_WATCH_ID_PREFIX = "cmw_"
function isCommandWatchId(id: string): boolean {
  return id.startsWith(COMMAND_WATCH_ID_PREFIX)
}

/** Is the fence parked on a TIMER — or a COMMAND WATCH — that is actually armed? The declaration alone
 *  is not the wait — a `timers:` line naming a fired or cancelled row describes a wake that will never
 *  come, exactly the shell-that-died case one branch up — so the hint is checked against the registry,
 *  which is the same set the scheduler's own integrity pass reads (armedTimerIdsOf, and
 *  armedCommandWatchIdsOf for `commands:`). */
export function hasParkedTimerWatch(
  tele: SessionTelemetry | undefined,
  armedTimerIds: ReadonlySet<string>,
): boolean {
  // REGISTRATION-FIRST (2026-08-27): with no awaiting fence to check the declaration against, the armed
  // timer IS the wait — the row is what wakes the thread, fence or no fence, and a rest on it drew no
  // card at all while the fence was required (the thread fell through to the bare rest). With a fence,
  // the fence is the worker's statement and it has to name an armed one, as before.
  if (tele?.lastFence?.kind !== "awaiting") return armedTimerIds.size > 0
  return tele.lastFence.hints.some((hint) => {
    const id = hint.value.trim()
    if (hint.kind === "timer") return !isCommandWatchId(id) && armedTimerIds.has(id)
    if (hint.kind === "command") return isCommandWatchId(id) && armedTimerIds.has(id)
    return false
  })
}

/** Is the thread's last word a fence handing the HUMAN steps to perform (`steps:`, 2026-10-03)? That
 *  is a wait on them rather than on anything running, and the resting card is where they read it. */
export function hasHumanSteps(tele: SessionTelemetry | undefined): boolean {
  return tele?.lastFence?.kind === "awaiting" && awaitingSteps(tele.lastFence.hints).length > 0
}

/** Does the thread DECLARE a wait of any kind — its own background work, a parked PR watcher, a parked
 *  timer, or steps for the human? This is what the resting card states. It is wider than the queue
 *  excusal above by exactly the PR, timer and steps waits, which card but never park. */
export function hasDeclaredWait(
  tele: SessionTelemetry | undefined,
  nowMs: number,
  armedTimerIds: ReadonlySet<string> = new Set(),
  registeredPrWatches: ReadonlySet<string> = new Set(),
  // This thread's ARMED `thread_watch` rows — the registry a `watch` call writes. Supplied by the caller
  // for the same reason the two sets above are: only it has the storage handle.
  armedWatches: readonly RegisteredWatch[] = [],
): boolean {
  if (hasHumanSteps(tele)) return true
  if (hasDeclaredBackgroundPark(tele, nowMs)) return true
  // A REGISTRATION IS A WAIT WITHOUT A FENCE. It is the same fact the `shells:` line states, made
  // durable: it outlives the message that created it, so it survives the worker saying something else.
  if (hasRegisteredBackgroundPark(tele, armedWatches, nowMs)) return true
  if (hasParkedPrWatch(tele, registeredPrWatches)) return true
  // A TIMER PARK CARDS LIKE A PR PARK (maintainer 2026-08-24: the resting card "enumerates all of the
  // pull requests and the background shells … I don't understand why timer isn't represented in the same
  // way"). Until this limb existed a timer-only park had no resting card at all, so the fence card fell
  // back to reading its machinery at the human — "a timer   for 2h".
  if (hasParkedTimerWatch(tele, armedTimerIds)) return true
  // A RUNNING SUB-AGENT NEEDS NO DECLARATION, and this is the line that keeps the change surgical. The
  // complaint was never about sub-agents — it was "the background work that it is theoretically waiting
  // on is just like a dev server that it never tore down" (maintainer 2026-08-14). A dispatched sub-agent
  // is work this thread ASKED FOR and cannot proceed without, so "resting until it reports" is true
  // whether or not the worker thought to say so.
  //
  // A background SHELL is the case that must be declared, and NOT because nothing wakes the thread —
  // one finishing does notify its agent. It is because a shell is not necessarily work anyone is waiting
  // ON: a dev server, a log tail and a test run are the same row here, and only the worker knows which of
  // them it is actually resting behind. So an undeclared shell says nothing, and a declared one says
  // everything.
  return (tele?.subAgents ?? []).some((a) => isDirectSubAgent(a) && a.state === "running")
}

// IS THE THREAD PARKED BEHIND CI THAT IS STILL RUNNING?
//
// A PR-watching thread is normally a VISIBLE queue handoff, and that is deliberate — a PR whose reviews may
// never arrive must not silently vanish (2026-07-22). But CI running is a wait with a KNOWN TERMINAL
// CONDITION, which review does not have, so it is the one case where hiding the card cannot lose
// anything: the checks finish, and the thread comes straight back (maintainer 2026-08-14: "if there is a
// GitHub watcher registered and the GitHub actions are still running, then that should remain in the
// running active rail. Only if CI has failed or completed successfully should it show up back in the
// queue").
//
// ALL of them, not any. With several PRs watched, one finishing is something the human can act on, so
// the thread queues — the same all-or-nothing reading the declared park uses.
//
// AN UNPOLLED PR DOES NOT HOLD. No reading means frizz does not know, and not-knowing must never be a
// reason a thread leaves the queue; nor does a PR with no checks at all (`none`), which would otherwise
// wait forever for CI that is never coming. Only a live `running` reading holds, and only while the PR
// is still open.
//
// THE REGISTERED WATCH IS THE SIGNAL, NOT THE FENCE (2026-09-20). Until then this read `prs:` hints only
// and required each to be registered too, so a worker that called `frizzctl watch-pr` and rested
// WITHOUT a fence — the shape the worker contract steers toward ("Register FIRST: this line states the
// wait, it does not create one") — was queued while its checks ran, while the rail's own mark
// (groups.prChecksRunning) read the registered rows and called the same thread live. One thread, two
// stories. Every armed GitHub watch on the thread is a declared wait now; the fence adds nothing the
// registry does not already say, and a `prs:` line with no watcher behind it never held (the old rule
// required the registration too), so nothing that held before stops holding.
//
// A GATED PR DOES NOT HOLD. Workflows at GitHub's "Approve and run" gate read `checks: "running"` —
// correctly, nothing has settled — but nothing is moving either, and nothing will until a maintainer
// presses the button. The poller wakes the worker with that fact (`kind: "ci", verdict: "gated"`) so it
// can go and ask; holding the thread in the Running band meanwhile would hide, behind a spinner, the
// one PR wait that never resolves on its own. `running === 0 && gated > 0` is the shape: at least one
// live check run keeps the hold, because a run that is going will finish and requeue the thread.
function heldByRunningChecks(github: GithubStatusBook, registered: ReadonlySet<string>): boolean {
  if (registered.size === 0) return false
  // ALL of them: an issue watch (never in the PR book) or a settled PR beside a running one means the
  // human has something to look at, so the thread queues.
  return [...registered].every((key) => ciInMotion(github[key]))
}

/** CI that will settle BY ITSELF: a live `running` reading on an open PR, not held at the approval gate.
 *  The one reading of "CI is moving" — heldByRunningChecks asks it of every watched PR, deriveWaitStatus
 *  of any. */
function ciInMotion(status: GithubStatusBook[string] | undefined): boolean {
  if (!status || status.checks !== "running" || status.state !== "open") return false
  return !(status.running === 0 && (status.gated ?? 0) > 0)
}

/** What queued a thread, where it is something the surfaces should show (sessionThreadView). Filled in
 *  by needsInputQueues only on the path where that reason is what put the thread in the queue.
 *  `heldHandoff`: a quiet park the board would have honoured, refused because an earlier `needs_input`
 *  handoff still stands (handoffStands). */
export interface QueuedBy { heldHandoff?: boolean }

function hasLiveOwnWork(tele: SessionTelemetry | undefined, registeredPrWatches: ReadonlySet<string>): boolean {
  return Boolean(
    tele?.subAgents?.some((agent) => isDirectSubAgent(agent) && agent.state === "running") ||
    tele?.bgShells?.some((shell) => shell.state === "running") ||
    // A PARKED PR WATCHER COUNTS (2026-08-13). It is the same shape of thing as a detached shell: the
    // worker left it running, it will re-invoke the thread on its own, and until it does there is
    // nothing for the human to do. That makes it eligible for the resting card and — the point of
    // counting it — for that card's event-snooze, which is now the ONE control for hiding a parked
    // watcher (maintainer: "the user can just use the generic snooze card… now GitHub watchers can be
    // included in the ranks of those").
    hasParkedPrWatch(tele, registeredPrWatches),
  )
}

/** A standing PR park the scheduler will actually fire. DECLARED AND REGISTERED, both — the rule
 *  heldByRunningChecks and hasParkedTimerWatch already spell out: the declaration says the thread is
 *  waiting, the registration is what will actually wake it. Until 2026-08-26 this read the declaration
 *  alone, so a `prs:` line naming a PR the worker never registered with `frizzctl watch-pr`
 *  counted as a wait: the resting card showed with NOTHING in it (a `prs:` entry adds no watch row of
 *  its own — see fenceWatchViews), the fence card hid itself behind it, and the ref — the one thing the
 *  wait was about — rendered on no surface at all. Membership is by githubStatusKey, so a fence naming
 *  the PR by URL still matches its normalized registration, exactly as unaccountedItems reads it. */
function hasParkedPrWatch(tele: SessionTelemetry | undefined, registered: ReadonlySet<string>): boolean {
  // Registration-first, same as hasParkedTimerWatch: an armed PR watch with no fence is the wait itself.
  if (tele?.lastFence?.kind !== "awaiting") return registered.size > 0
  // `registered` holds BOTH kinds' refs (see the board's armedPrWatches): an `issues:` entry is the same
  // declared-and-registered check with the issue ref grammar.
  return tele.lastFence.hints.some((hint) => {
    if (hint.kind !== "pr" && hint.kind !== "issue") return false
    const ref = hint.kind === "pr" ? parsePrRef(hint.value) : parseIssueRef(hint.value)
    return ref !== undefined && registered.has(githubStatusKey(ref))
  })
}

// The awaiting-background event-snooze is armed for the CURRENT rest iff the captured rested_at still
// equals the row's rested_at. rested_at only advances when the top-level turn comes to a NEW rest, so
// any advance — the exact event of a sub-agent/shell returning and the worker acting on it — auto-clears
// the snooze and re-surfaces the card. No scheduler, no reaper: the snooze expires itself on next rest.
// That self-clearing IS the promise the card's Snooze button makes to the human ("until one of the
// background shells completes, in which case the agent will resume automatically" — maintainer
// 2026-08-04): a Claude/Codex worker is re-invoked by its own completion notification, and the card comes
// back the moment that turn ends. A shell that never finishes therefore stays snoozed, which is the point.
function bgSnoozeArmed(row: Pick<SessionRow, "bg_snooze_rested_at" | "rested_at">): boolean {
  return row.bg_snooze_rested_at != null && row.rested_at != null && row.bg_snooze_rested_at === row.rested_at
}

/** CAN ANYTHING BUT A PERSON WAKE THIS THREAD? The same event-snooze is also the header's "Until
 *  activity" (2026-10-19), offered on ANY rested thread rather than only on the resting card, and its
 *  promise — back at the next rest — only holds while something of the thread's own is still out to
 *  cause that rest: a running sub-agent or shell, an armed PR or issue watch, an armed timer or command
 *  watch, or a Goal that fires on rest or on a clock. A steer from another thread can wake it too, but
 *  nothing can know one is coming, so it never counts.
 *
 *  Three readers, one answer: the snooze menu greys the option out when this is false (maintainer
 *  2026-10-19: grey it out rather than warn), the RPC refuses it, and deriveNeedsYou stops honouring an
 *  armed snooze the moment it turns false — a thread that lost its last way back returns to the queue
 *  rather than staying hidden until someone happens to look. `registeredWatches` and `armedTimerIds` are
 *  the board's per-thread sets (both GitHub kinds; timers and command watches). */
export function wakesOnItsOwn(
  row: Pick<SessionRow, "recurring_prompt" | "recurring_armed_at" | "recurring_on_rest" | "recurring_on_schedule">,
  tele: SessionTelemetry | undefined,
  registeredWatches: ReadonlySet<string>,
  armedTimerIds: ReadonlySet<string>,
): boolean {
  const goal = Boolean(row.recurring_prompt && row.recurring_armed_at) && (row.recurring_on_rest === 1 || row.recurring_on_schedule === 1)
  return goal || registeredWatches.size > 0 || armedTimerIds.size > 0 || Boolean(
    tele?.subAgents?.some((agent) => isDirectSubAgent(agent) && agent.state === "running") ||
    tele?.bgShells?.some((shell) => shell.state === "running"),
  )
}

// A declared wait excuses an idle thread from the queue only for a specific external-human gate or a
// valid future scheduler instant. Legacy PR/CI/session hints, malformed/elapsed timers, and hintless
// fences are agent-owned work; if the worker nevertheless comes to rest, the queue must surface that
// rest.
//
// A PR WAIT is DELIBERATELY NOT here (maintainer 2026-07-22): the review/approval/comment watcher
// keeps its thread a VISIBLE queue handoff rather than parking it, so a PR whose reviews may never
// arrive can't silently vanish. The scheduler still polls + bumps it on new activity (it keys on the
// hint, not on this excusal); the human hides it on demand via the "PR watcher armed" card's Snooze
// button (a user snooze, cleared by the next activity). Mirrors groups.parkedAwaitingHint — keep the
// two in lockstep.
function hasParkedExternalWait(tele: SessionTelemetry | undefined, _nowMs: number): boolean {
  // NOTHING EXTERNAL PARKS A THREAD ANY MORE. This carried the two hint kinds that took a thread out of
  // the queue on the worker's word alone: `human:`, which parked it in Snoozed and which NOTHING EVER
  // FIRED, and `timer: <instant>`, one of which was written 5h55m in the past and stalled its thread for
  // 5.5 hours. Both are deleted (see the AwaitingHint doc block in @frizz/shared): waiting on a person is
  // a ```question, and a timer is a registered row named by id like every other item. Parking is decided
  // by the structural park alone now — hasDeclaredBackgroundPark — which frizz can actually check.
  return false
}

// Every wait the thread has out, synthesized as watch rows so the ops strip under the prompt box can
// list them beside the sub-agents and background shells the worker also has running (maintainer
// 2026-08-13: "showing the active watchers underneath the prompt box, similar to how subagents work").
//
// DERIVED FROM THE FENCE, and as of 2026-08-14 that is the ONLY source — the `thread_watch` registry is
// retired. A `prs:` entry becomes a github row and a `shells:` entry a shell row, read from exactly the
// hints the scheduler's own passes act on. That coupling is the point: the strip lists precisely what
// will wake the thread, and the two cannot drift into claiming different things.
//
// It therefore has the fence's lifetime: it stands while the park is the worker's last word and
// disappears the moment the worker says anything else, which is correct — that is also the instant the
// scheduler stops watching. The ID is stable across ticks (slug + target) so a row does not remount on
// every board delta, and there is nothing to DROP: the affordance for hiding one is the snooze the
// operator already uses for a thread resting on background work.
export function fenceWatchViews(
  slug: string,
  tele: SessionTelemetry | undefined,
  fenceAt: string | undefined,
  github: GithubStatusBook = {},
  /** This thread's REGISTERED PR and ISSUE watchers — `{ target, kind, createdAt }` per armed row. These
   *  get a row whether or not the fence mentions them: a registration is live work the thread has out,
   *  and the strip's job is to list what will actually wake it. The fence's `prs:` entry is a separate
   *  thing — it states a WAIT, and it is checked against this set elsewhere (heldByRunningChecks). */
  registered: readonly { target: string; kind?: "pull" | "issue"; createdAt: string }[] = [],
  /** This thread's ARMED TIMERS — the `thread_timer` rows a `timers:` fence entry is checked against.
   *  Rows for the same reason the PR registrations above get them, fence or no fence: an armed timer
   *  WILL fire and wake the thread, so it is live work the strip must list. */
  armedTimers: readonly { id: string; prompt: string; fireAt: string; createdAt: string }[] = [],
  /** This thread's ARMED `thread_watch` rows — a wait the worker REGISTERED rather than declared. Rows
   *  for the same reason the two registries above get them: the row outlives the message that made it,
   *  so it is live work the strip must list whether or not any fence still mentions it.
   *
   *  A `shell` row only. An `agent` registration adds none, exactly as an `agents:` fence entry adds
   *  none (see the fence loop below): the sub-agent it names is already a row on every surface that
   *  draws this card, and a second row named by its raw `toolu_…` id is what put two sub-agents under a
   *  "Background shells" heading on 2026-08-26. */
  armedWatches: readonly RegisteredWatch[] = [],
  /** The ISSUE readings, from their own book — the twin of `github` for the rows whose subject is an
   *  issue. Defaulted empty so every caller and test that predates issues reads unchanged. */
  issueBook: GithubIssueStatusBook = {},
  /** This thread's ARMED COMMAND WATCHES (`frizzctl watch-command`). Rows for the timers' reason: the
   *  server re-runs each until it passes and then wakes the thread, so it is live work fence or no fence.
   *  A park on one alone had no row until 2026-10-13, and its card fell through to "Waiting for an
   *  external update." — true of every park and specific to none. */
  armedCommands: readonly CommandWatchRow[] = [],
): ThreadView["watches"] {
  const seen = new Set<string>()
  const out: ThreadView["watches"] = []
  for (const t of armedTimers) {
    if (seen.has(`timer:${t.id}`)) continue
    seen.add(`timer:${t.id}`)
    out.push({
      id: `timer:${slug}:${t.id}`,
      kind: "timer" as const,
      target: t.id,
      state: "armed" as const,
      createdAt: t.createdAt,
      // Always present, unlike the github half above: a timer that exists is fully known — there is no
      // poller to wait for. The prompt is the row's NAME client-side (a `tmr_…` id names nothing).
      timer: { fireAt: t.fireAt, prompt: t.prompt },
    })
  }
  for (const w of armedCommands) {
    if (w.state !== "armed" || seen.has(`command:${w.id}`)) continue
    seen.add(`command:${w.id}`)
    out.push({
      id: `command:${slug}:${w.id}`,
      kind: "command" as const,
      target: w.id,
      state: "armed" as const,
      createdAt: new Date(w.created_at).toISOString(),
      // The same projection as the worker's read-back (router commandWatchView), so the row and
      // `frizzctl watch-command` name one cadence and one last check.
      command: {
        command: w.command,
        every: formatElapsed(w.every_ms),
        expiresAt: new Date(w.expires_at).toISOString(),
        runs: w.runs,
        ...(w.last_run_at !== null && w.last_outcome
          ? { lastRun: { at: new Date(w.last_run_at).toISOString(), outcome: w.last_outcome, exitCode: w.last_exit, output: w.last_output ?? "" } }
          : {}),
      },
    })
  }
  for (const w of registered) {
    const subject = w.kind === "issue" ? "issue" as const : "pull" as const
    // The dedupe key carries the subject, as the poll's own key does: a PR and an issue registered under
    // one number are two rows, because they are two registrations that wake on different things.
    const dedupe = `github:${subject}:${w.target}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    out.push({
      id: `github:${slug}:${subject === "issue" ? "issue:" : ""}${w.target}`,
      kind: "github" as const,
      target: w.target,
      state: "armed" as const,
      createdAt: w.createdAt,
      subject,
      // Absent until the poller's first successful read. The card says "checking…" then, rather than
      // inventing a verdict — an unpolled PR and a PR with no CI are different facts.
      ...(subject === "pull" && github[w.target] ? { github: github[w.target] } : {}),
      ...(subject === "issue" && issueBook[w.target] ? { issue: issueBook[w.target] } : {}),
    })
  }
  for (const w of armedWatches) {
    if (w.kind !== "shell") continue
    const target = w.target.trim()
    // A registration whose work has ended is not a wait — the same rule the fence's names take, and the
    // same rule hasRegisteredBackgroundPark parks on, so the strip and the park cannot disagree.
    if (!target || seen.has(`shell:${target}`) || resolveLiveWatchTarget(tele, target)?.kind !== "shell") continue
    seen.add(`shell:${target}`)
    out.push({ id: `shell:${slug}:${target}`, kind: "shell" as const, target, state: "armed" as const, createdAt: w.createdAt })
  }
  if (tele?.lastFence?.kind !== "awaiting") return out
  // When the worker PARKED — what the strip's duration counts from. Falls back to the thread's last
  // activity when the fold has no fence instant.
  const createdAt = fenceAt ?? tele.lastAssistantAt ?? new Date().toISOString()
  for (const hint of tele.lastFence.hints) {
    // A `prs:` entry adds NO row of its own: the registry above already listed every PR this thread
    // watches, and a line naming an unregistered PR describes a wait nothing will deliver. Listing it
    // would put a row on the strip that nothing behind it can ever fire.
    // AN `agents:` ENTRY ADDS NO ROW EITHER, for the same reason a `prs:` one does not: the sub-agent it
    // names is already a row on every surface that draws this card (AwaitingBackgroundCard's own live-agent
    // group, BackgroundOpsStrip under the prompt box), read straight off `subAgents` and needing no
    // declaration to appear — see hasDeclaredWait. A row here is a SHELL row by construction, so an agent
    // hint listed the same sub-agent a second time under "Background shells", named by its raw `toolu_…`
    // id because resolveShell can find no shell behind it (maintainer 2026-08-26: "why are these
    // background shells showing up in the awaiting block but not underneath the prompt box"). It came in
    // with the `watch:` → `shells:`/`agents:` cutover (5e0baf54), which widened the filter to both new
    // kinds while the push below still emitted one kind.
    if (hint.kind !== "shell") continue
    const target = hint.value.trim()
    // A name matching nothing live is not a wait — the same rule, applied to the shells the thread owns.
    if (!target || seen.has(`shell:${target}`) || !liveWaitHandles(tele).has(target)) continue
    seen.add(`shell:${target}`)
    out.push({ id: `shell:${slug}:${target}`, kind: "shell" as const, target, state: "armed" as const, createdAt })
  }
  return out
}

// SERVER-DERIVED queue membership for a REGISTERED session thread (foreign/archived → false at the
// call site). Every otherwise-unexcused owned/open thread enters Queue when its top-level worker comes
// to rest. A user-owned snooze temporarily suppresses every queue reason—including a concrete ask,
// permission prompt, or crash—then the exact deadline restores the still-current reason. Truthful
// external waits place ordinary rest in Snoozed without writing lifecycle state.
// A follow-up frizz has delivered but the transcript has not yet reflected: it lives in the delivery
// ledger as `pending` (injected, no JSONL evidence yet), `enqueued` (positively receipted by Claude
// Code's own queue) or `delivered` (the transport's receipt proved it went straight into a turn). All
// three mean the human's message is handled and in flight, and so does the write-ahead `sending` (the
// transport is being called right now; it settles or fails within SENDING_STALL_MS). `unconfirmed` is
// NOT fresh — frizz could not confirm that send, so it must stay visible for the human to re-drive — and
// `failed` is not either: the words never reached the worker, so the thread is still waiting on them.
//
// `processGone` is what keeps "in flight" honest, and it is the whole reason this reads a second
// argument. Both live states are claims about a process HOLDING the message: `pending` says a process
// was handed it, `enqueued` says a process receipted it into its own queue. A daemon that has since
// died holds nothing — the message will never be read, and the ledger row ages out only after
// UNCONFIRMED_DROP_MS, so an hour of silent suppression follows a death that took milliseconds.
// Observed 2026-08-11 on `in-codex-threads-tool-calls-ike`: the operator's follow-up was receipted at
// 19:45:05.771 and the daemon died 760ms later (`session-stream-broken` — its cwd had been renamed out
// from under it). The thread's ```done card was already sitting in the queue; this excusal took it
// out, and nothing put it back. Neither queued nor carded: invisible — the delivery twin of the
// sub-agent phantom deriveRuntime's `headlessLostWork` fixed, and the same lesson.
function hasFreshDelivery(row: SessionRow, processGone: boolean): boolean {
  if (processGone) return false
  // `held` counts: Frizz is keeping a message of the human's for exactly this rest and is about to
  // deliver it (releaseHeldFollowUps), so the thread is not waiting on them either.
  return parseDeliveryLedger(row.delivery_ledger).some((d) => d.state === "sending" || d.state === "pending" || d.state === "enqueued" || d.state === "delivered" || d.state === "held")
}

/** How long a message on its way to the worker keeps its row SPINNING (see deriveDeliveryInFlight). A
 *  broker send lands in a second or two and an answer's wake in a few; a codex rollout send can take
 *  minutes to hours to show up in the transcript (board's own measurement: 8 of 75 over 60s), and a
 *  spinner that long is a claim of motion nobody can see. Past this the row keeps its excusal and wears
 *  its true at-rest mark. */
export const DELIVERY_IN_FLIGHT_SPIN_MS = 60_000

/** THE HUMAN'S MESSAGE IS ON ITS WAY AND THE TURN HAS NOT STARTED YET — a follow-up in the delivery
 *  ledger the transcript has not reflected, or a registered answer whose wake has not landed. The queue
 *  already excuses both (deriveNeedsYou); this is the same fact exported, so every tab draws the row as
 *  working rather than as an at-rest thread sitting in the Running band. The browser that SENT the
 *  message already does this for 12s on its own (web lib/steering.ts); this is what reaches every other
 *  tab, a reload, and a delivery slower than that hint. Only at rest and only once the queue has let the
 *  thread go: a crash, a live ask or anything else deriveNeedsYou still queues keeps its own mark. */
export function deriveDeliveryInFlight(
  row: SessionRow,
  runtime: RuntimeState,
  needsYou: boolean,
  deliveryProcessGone: boolean,
  answerInFlight: boolean,
  nowMs = Date.now(),
): boolean {
  if (needsYou || (runtime !== "turn-idle" && runtime !== "exited")) return false
  if (answerInFlight) return true
  if (deliveryProcessGone) return false
  return parseDeliveryLedger(row.delivery_ledger).some((d) =>
    (d.state === "sending" || d.state === "pending" || d.state === "enqueued" || d.state === "delivered") && nowMs - Date.parse(d.at) < DELIVERY_IN_FLIGHT_SPIN_MS
  )
}

export function deriveNeedsYou(
  row: SessionRow,
  tele: SessionTelemetry | undefined,
  runtime: RuntimeState,
  hasActionableInteraction = false,
  nowMs = Date.now(),
  // The RESOLVED pause for this row (resolveLimitPause), not the raw setting, so the queue rule and
  // the card can never disagree about whether a fault stands.
  limitPause: ThreadView["limitPause"] = undefined,
  // deriveAwaitingBackground passes false. The live-own-work excusal below is a QUEUE rule; the card
  // states a FACT about the thread that has to survive it, or the drawer and the full-screen page blank
  // out at rest and read as "the agent died". Every OTHER excusal is still inherited. (Named for
  // sub-agents until 2026-08-01, when background shells joined the same excusal — the flag was never
  // about which KIND of work, only about queue-vs-fact.)
  excuseLiveOwnWork = true,
  // BROKER-ONLY, and supplied by the caller because only it has the daemon probe: the process that
  // received this row's outstanding sends is gone. Read by hasFreshDelivery alone — see there. Defaults
  // false so every other caller (and every test) keeps today's behaviour.
  deliveryProcessGone = false,
  github: GithubStatusBook = {},
  registeredPrWatches: ReadonlySet<string> = new Set(),
  // The scheduler's armed timer rows, so a TIMER park can take the event-snooze below exactly as a PR
  // park does. Supplied by the caller for the same reason `registeredPrWatches` is: only it has the
  // registry, and a declaration alone is not a wait (hasParkedTimerWatch).
  armedTimerIds: ReadonlySet<string> = new Set(),
  // This thread's ARMED `thread_watch` rows. Same reason as the two above — the caller holds storage.
  armedWatches: readonly RegisteredWatch[] = [],
  // How many REGISTERED questions this thread has open (thread_question). A count rather than the rows:
  // the queue rule only asks whether there are any, and the rows themselves travel on the view.
  openQuestions = 0,
  // The human has ANSWERED a registered question and the wake carrying it has not landed yet — see
  // answerAwaitingDelivery, which bounds it. The caller's for the same reason `openQuestions` is.
  answerInFlight = false,
  // Told what queued the thread, where the card should say so — see QueuedBy. Only the view asks.
  queuedBy?: QueuedBy,
): boolean {
  // Snooze is explicit operator lifecycle state. It must be checked before provider/question/crash
  // gates so choosing Snooze from any queue card actually parks that card until its exact deadline.
  // The underlying telemetry remains intact and is re-derived when the scheduler clears the instant.
  if (futureSnooze(row, nowMs)) return false
  // A typed request is already scoped to this exact registered session by the interaction journal.
  // It is a hard human gate even when the provider is mid-turn: the turn cannot advance until the
  // advertised response is delivered, so at-rest transcript heuristics do not apply.
  if (hasActionableInteraction) return true
  if (runtime === "perm-prompt") return true
  if (tele?.pendingAsk) return true
  const atRest = runtime === "turn-idle" || runtime === "exited"
  if (!atRest) return false
  // CRASH/STALL net: the worker EXITED while the turn was still in flight (last record a tool_use, never
  // reached end_turn) — the agent died mid-work. This is a stall the human MUST see, and it is NOT
  // clearable by a prior glance (a dead process produces no new activity to re-arm bare-rest, so
  // interaction-clearance would bury it forever after one view). The legacy needsAction had this net
  // (active/planning + exited/none); deriveNeedsYou dropped it — restored here (found 2026-07-09).
  if (runtime === "exited" && tele?.turn === "in-flight") return true
  // A human follow-up frizz has DELIVERED but the transcript has not YET reflected — the tailer folds
  // JSONL on a poll that runs seconds behind under load — sits in the delivery ledger as pending or
  // enqueued. The human has already responded, so the thread is NOT awaiting them: suppress it here,
  // from SERVER TRUTH, so a card the operator just steered leaves the queue and STAYS gone until the
  // turn is observed — instead of bouncing back when the client's 12s optimism expires first (the
  // "reappears after ~10s, then leaves again" flicker). This is the durable, reload-safe complement to
  // the client's optimistic steer. Placed AFTER the crash net (a delivered follow-up to a worker that
  // then died must still surface) and the hard live asks, but before the at-rest reasons a steer
  // resolves (a question, a done handoff, bare rest). `unconfirmed` is excluded on purpose: a send frizz
  // could not confirm is one the human may need to re-drive, so the ledger's own aging re-surfaces it.
  if (hasFreshDelivery(row, deliveryProcessGone)) return false
  // THE SAME EXCUSAL FOR AN ANSWER. answerQuestions stores the answer and the scheduler delivers it a
  // beat later, so between the two the thread is at rest with no question left open — and it read as a
  // BARE REST: the card stayed in the queue wearing the at-rest ellipsis, for a thread the human had just
  // set back to work (maintainer 2026-09-25: "it switches over … to the three-dot ellipses, but then it
  // doesn't move the card from the queue into the running rail"). The human has responded; nothing here
  // is theirs to do until the worker has read it.
  if (answerInFlight) return false
  // THE EVENT-SNOOZE, ON ANY REST (2026-10-19). It was honoured only inside the per-wait branches below,
  // on the shapes whose resting card carried the button; the header's "Until activity" offers it on
  // every rested thread, so it is honoured here, once, for as long as something can still end it
  // (wakesOnItsOwn). Ahead of a question for the reason the wall-clock snooze is: the human parked the
  // thread knowingly, and the ask stays answerable behind the park. The asks that hold the TURN itself —
  // an actionable interaction, a permission prompt, a native ask — are checked above and still win.
  if (runtime !== "exited" && bgSnoozeArmed(row) && wakesOnItsOwn(row, tele, registeredPrWatches, armedTimerIds)) return false
  if (tele?.providerError && !tele.providerError.retrying) return true
  // An unanswered ```question fence in the last assistant message is an EXPLICIT ask — a hard queue
  // member exactly like a native pendingAsk, NOT subject to interaction-clearance. VIEWING a question
  // is not ANSWERING it, so seen_at must never drop it off the stack (the whole point is that threads
  // needing input surface automatically and STAY until resolved). The tailer clears pendingQuestion the
  // moment a newer user message lands (an answer/steer supersedes the fence), which is what dequeues it.
  if (tele?.pendingQuestion) return true
  // A REGISTERED question is the same hard queue member, and for a stronger reason: it does not depend
  // on the worker having stayed quiet since it asked. The rows are the caller's because only it holds
  // storage. Deliberately NOT wired into degradeIfAwaitingAnswer above — that degrades a RUNNING thread
  // to turn-idle on the strength of the last message being a question, which is right for a fence and
  // wrong for a row: a worker that registers a question KEEPS WORKING, and pinning it to turn-idle
  // would stop its shimmer for as long as the question stood.
  if (openQuestions > 0) return true
  // A LIMIT PAUSE IS A HARD QUEUE MEMBER, exactly like the crash net above: the provider cut this
  // thread off mid-work, so it queues as a failed thread the human must see. This REVERSES the
  // excusal that lived here until 2026-08-31 ("keeps a limit event from dumping the entire running
  // fleet into the queue at once") — a fleet the limit killed showed up as calmly Snoozed hourglasses
  // instead, which is the opposite of what a mass kill should look like (maintainer 2026-08-31: "they
  // should have shown up in the queue, right, as blocked threads, as threads that had failed in some
  // way"). Auto-resume still fires on the window reset (the scheduler reads the fault, not the queue),
  // and delivering that continue — or any human follow-up — clears the fault (tailer), which is what
  // dequeues the card; merely viewing it never does. Ahead of hasParkedExternalWait on purpose: a
  // stale ```awaiting fence from the rest BEFORE the kill must not bury it. The operator's own snooze
  // still wins (futureSnooze, checked first), so a card can be parked deliberately.
  if (limitPause) return true
  // Completion is a handoff even when an older background registration still holds. Keep this
  // above the legacy park/CI excusals; only a newer delivery (checked above) can spend the handoff.
  if (tele?.lastFence?.kind === "done") return true
  // THE WORKER'S OWN ANSWER (2026-10-01). A thread dispatched at or after NEEDS_INPUT_REQUIRED_AT says
  // with `status:` (2026-10-05; `needs_input:` before it, still read) whether its rest needs the human,
  // and every per-wait rule below is the guess that answer replaces — so none of them is consulted for
  // it. Placed after every hard gate above: an ask, a crash, a limit stop and the human's own snooze are
  // facts about the thread, not guesses about a wait. WHICH BAND a rest out of the queue sits in is a
  // separate verdict — deriveWaitStatus — because the queue only asks whether the human is needed.
  //
  // AN ANSWER IS HONOURED FROM ANY THREAD, not only a new-contract one. A cold resume re-applies the
  // CURRENT worker prompt (router followUp / context.ts), so a thread dispatched before the cut can read
  // the key after an upgrade and start writing it — and a `needs_input: true` it wrote must queue it, where
  // the legacy park rule would have excused it. The cut decides only whether the answer is REQUIRED.
  const answered = tele?.lastFence?.kind === "awaiting" && awaitingNeedsInput(tele.lastFence.hints) !== null
  if (answered || needsInputRequired(row.spawned_at)) {
    return needsInputQueues(row, tele, runtime, nowMs, excuseLiveOwnWork, registeredPrWatches, armedTimerIds, github, queuedBy)
  }
  // Declared parks are STRONGER excusals than the awaiting-background card below, so they are checked
  // first: a worker that declared an awaiting-human fence stays held even if a child of its is still
  // live (it explicitly said what it is waiting on).
  if (hasParkedExternalWait(tele, nowMs)) return false
  // A top-level turn that came to rest while a dispatched SUB-AGENT is still running is EXCUSED from
  // the queue for exactly as long as that holds. The rail already shows it in the ACTIVE band (the
  // spinning rows above the rule — see ARCHITECTURE.md § Board nomenclature), and the two surfaces must
  // not both claim it (maintainer 2026-08-01: "if something is listed as currently running, then it
  // should never show up in the queue"). That invariant is what `groups.inActiveBand` is written
  // against — it bands on `isActivelyRunning && !needsYou`, so this excusal is the ONLY thing that puts
  // a rested-with-live-work row in the Active band, and nothing can land there carrying a card.
  //
  // The reason it is a sub-agent excusal (maintainer 2026-07-30): queueing them made the rail row drop
  // out of the running band into the rested band and bounce straight back up when the child returned —
  // "there's too much layout shift as things jump between those two sections … it should only show up
  // in the queue when it's fully rested and it has no running sub-agents". It is bounded by
  // construction: a child whose completion signal is lost goes `stale` at the tailer's 15-min ceiling,
  // and only `running` holds here, so a child that never returns stops excusing its parent.
  //
  // A BACKGROUND SHELL DOES NOT EXCUSE, and the round trip is worth recording. Shells joined this
  // excusal on 2026-08-01 and left it again on 2026-08-04 (maintainer: "if a thread has rested and the
  // only thing remaining is background shells, we should put it into the queue"). The difference from a
  // sub-agent is the same one the rail already draws: a child returns and re-invokes its parent within
  // seconds, so the thread is genuinely mid-flight and there is nothing for the human to do; a shell is
  // DETACHED — 26% of real launches are servers that never exit, and there is no staleness clock — so a
  // thread resting behind one has finished its turn in every sense that matters to the operator, and
  // burying it in the running band means it is never seen again. It is a handoff, so it queues.
  //
  // The layout-shift worry that motivated the 2026-08-01 excusal is answered instead by the SNOOZE on
  // the card (see the branch below): one click parks it until the shell returns and the worker re-rests.
  // That is the human's call to make per thread, which an unconditional excusal took away from them.
  //
  // A DECLARED FENCE outranks the excusal (hence the `!tele?.lastFence` guard), because a fence is the
  // worker's own statement about why it stopped and it earns its own card: a ```done handoff still
  // cards as done, and a non-parked ```awaiting — a PR wait above all — stays a VISIBLE queue handoff
  // even with work out (maintainer 2026-07-24), so a PR watcher can never vanish merely because the
  // worker happens to have something running. Such a thread is NOT in the running band either
  // (deriveAwaitingBackground drops any fenced thread, so the client reads it as a rested-band row),
  // which is exactly why it must keep its card — the invariant above cuts both ways.
  if (excuseLiveOwnWork && runtime !== "exited" && hasLiveBackgroundWork(tele) && !tele?.lastFence) return false
  // THE CARD, AND ITS EVENT-SNOOZE. Three shapes reach here: a SHELL-ONLY rest (the common one since
  // 2026-08-04 — no fence, no live child, a launched shell still going), a fenced thread with live work
  // of either kind, and deriveAwaitingBackground asking for the FACT rather than the queue
  // (excuseLiveOwnWork false, which must never consult the queue-owned snooze — hence the nulled column
  // at its call site). All three card, and all three honour an armed event-snooze for the current rest.
  //
  // An EXITED parent with "running" children is a crash, not this card — the runtime!=="exited" guard
  // drops it to the crash/bare-rest net below (a dead worker's children keep reading "running" until their
  // transcript goes stale; the parent cannot actually still be waiting on them). A done fence outranks
  // this too: respect the worker's completion signal (show the done card).
  // A DECLARED PARK KEEPS THE THREAD OUT OF THE QUEUE. The worker named what it is waiting on and every
  // name still matches something live, so there is nothing for the human to do until one of them reports
  // — which is the difference between this and the line below, where frizz merely NOTICED something
  // running. See `hasDeclaredBackgroundPark`.
  //
  // It rides `excuseLiveOwnWork` for the same reason the line below does: this is a QUEUE rule, and
  // deriveAwaitingBackground opts out of it so the card can still state the fact. Without the opt-out the
  // card would be false for exactly the threads it exists to describe — the drawer and the full-screen
  // page would blank out at rest and read as "the agent died".
  //
  // A REGISTERED park is the same rule with a durable row behind it instead of a sentence: it excuses
  // the thread for as long as the row is armed and its target is live, whether or not any fence says so.
  if (excuseLiveOwnWork && runtime !== "exited" && (hasDeclaredBackgroundPark(tele, nowMs) || hasRegisteredBackgroundPark(tele, armedWatches, nowMs))) return false
  // CI STILL RUNNING ON EVERY WATCHED PR. Ahead of the live-own-work line below, which would otherwise
  // queue the same thread on the strength of the watcher being armed at all. Rides `excuseLiveOwnWork`
  // for the reason that flag exists: the CARD must still state the wait (deriveAwaitingBackground opts
  // out), or the drawer blanks at rest and reads as "the agent died".
  if (excuseLiveOwnWork && runtime !== "exited" && heldByRunningChecks(github, registeredPrWatches)) return false
  // A TIMER PARK TAKES THE SAME SNOOZE (2026-08-25). It queues like a PR park — a visible handoff, never
  // an auto-park — and since 2026-08-24 it cards like one too, with the resting card's event-Snooze as
  // its one control. But it is not "live own work" (nothing of the thread's is running; the clock is),
  // so it fell straight past this line to the bare-rest handoff below, which never reads the snooze:
  // the click was recorded (bg_snooze_rested_at set), the card stayed in the queue, and the client —
  // reading `bgSnoozed` — un-hid the fence card above the still-showing resting card, so the same wait
  // rendered twice on one queue card (maintainer 2026-08-25: "I already hit the snooze button… but it's
  // still in the queue"). Checked against the registry, not the declaration: a fence naming a fired
  // timer is a bare rest, and a bare rest is not snoozable.
  if (runtime !== "exited" && (hasLiveOwnWork(tele, registeredPrWatches) || hasParkedTimerWatch(tele, armedTimerIds))) return !bgSnoozeArmed(row)
  // Bare rest is itself the handoff. It remains queued until the human explicitly sends more work,
  // snoozes it, or archives it; merely opening/seeing the thread cannot silently clear the card.
  return true
}

// THE QUEUE RULE FOR A THREAD THAT ANSWERS FOR ITSELF — the at-rest tail of deriveNeedsYou for a worker
// dispatched under the answer-required contract (NEEDS_INPUT_REQUIRED_AT in @frizz/shared). Three rules,
// where the legacy tail has one per kind of wait:
//
//  1. `status: working` or `status: watching` (or the older `needs_input: false`) on a park frizz can
//     honour keeps the thread OUT of the queue. Which band it then sits in — Running or Snoozed — is
//     deriveWaitStatus's verdict. "Honour" is the scheduler's own reading (awaiting.needsInputParkHolds):
//     every named item live and the `for:` not yet run out — so a wrong answer cannot hide a thread that
//     nothing will wake.
//  2. Any other rest on running work QUEUES, with the resting card and its event-snooze: `needs_input`, a
//     fence with no answer (the scheduler bumps it), and a rest with work out and no fence at all (the
//     sign-off nudge teaches the fence). This is where a live sub-agent, a registered watch and a PR whose
//     CI is still running used to excuse the thread on frizz's guess; the worker says so now, or it queues.
//  3. A `done` handoff and a rest with nothing out queue as they always did.
//
// RULE 1 CANNOT SPEND A HANDOFF THE HUMAN HAS NOT REACHED. A `needs_input` rest put the thread in front
// of the human, and only the human takes it out again: by typing to it (`restFromAt`, the boundary an open
// question stands across) or by snoozing it (handoffStands). A later quiet park does not: a PR watcher's
// wake for news the worker had already read made it re-park `status: watching`, and its "ready, unmerged"
// handoff sat in Snoozed with green CI (reported 2026-10-27: "it looks green to me"). The thread falls
// through to rule 2 instead, so the card keeps its event-snooze.
//
// HONOUR INCLUDES THE PRS THEMSELVES (awaiting.parkWaitsOnThisSide): a park naming nothing but PRs this
// account opened that wait only on this side is refused like a park on a dead name, and the scheduler tells
// the worker why (evalParkIntegrity) — its next act is a fix to push or a merge to hand over, which no
// watcher will ever report.
//
// Where a standing handoff is what queued the thread, `queuedBy` says so, so the surfaces keep that
// handoff drawn (ThreadView.heldHandoff).
//
// `excuseLiveOwnWork` false is deriveAwaitingBackground asking for the FACT, as it does of the legacy
// tail: rule 1 is the queue's alone, so the card can still say what the thread waits on.
function needsInputQueues(
  row: SessionRow,
  tele: SessionTelemetry | undefined,
  runtime: RuntimeState,
  nowMs: number,
  excuseLiveOwnWork: boolean,
  registeredPrWatches: ReadonlySet<string>,
  armedTimerIds: ReadonlySet<string>,
  github: GithubStatusBook,
  queuedBy?: QueuedBy,
): boolean {
  const holds = excuseLiveOwnWork && quietParkHolds(tele, runtime, nowMs, registeredPrWatches, armedTimerIds, github)
  const held = holds && handoffStands(row, tele)
  if (holds && !held) return false
  const queued = runtime !== "exited" && tele?.lastFence?.kind !== "done" && (hasLiveOwnWork(tele, registeredPrWatches) || hasParkedTimerWatch(tele, armedTimerIds))
    ? !bgSnoozeArmed(row)
    : true
  if (held && queued && queuedBy) queuedBy.heldHandoff = true
  return queued
}

/** Rule 1 short of a standing handoff: a working/watching park frizz could honour. */
function quietParkHolds(
  tele: SessionTelemetry | undefined,
  runtime: RuntimeState,
  nowMs: number,
  registeredPrWatches: ReadonlySet<string>,
  armedTimerIds: ReadonlySet<string>,
  github: GithubStatusBook,
): boolean {
  const fence = tele?.lastFence
  return runtime !== "exited" &&
    fence?.kind === "awaiting" &&
    // `registeredPrWatches` carries both kinds' refs (see hasParkedPrWatch), so it answers for `issues:` too.
    // `armedTimerIds` carries the command watches too, split back by kind here (isCommandWatchId).
    needsInputParkHolds(
      fence.hints,
      liveActivityOf(
        tele,
        registeredPrWatches,
        new Set([...armedTimerIds].filter((id) => !isCommandWatchId(id))),
        registeredPrWatches,
        new Set([...armedTimerIds].filter(isCommandWatchId)),
        idlePrsOf(github),
      ),
      Date.parse(tele?.lastAssistantAt ?? ""),
      nowMs,
    )
}

// Whether the newest handoff is still unreached: the human has neither typed to the thread since it
// (`restFromAt`) nor snoozed a rest at or after it (`bg_snooze_rested_at`, stamped by the resting card's
// Snooze and the header's "Until activity"). The snooze counts because it is the human's own answer to the
// card. Without it, a snooze pressed on the handoff lasted one rest (bgSnoozeArmed), and the next no-news
// park put the card straight back, on every wake after it, until the human typed something. Opening the
// thread does not count (router threadSeen: viewing a resting handoff never acknowledges it), and nor does
// a wall-clock snooze, whose point is to bring the card back when it ends.
function handoffStands(row: Pick<SessionRow, "bg_snooze_rested_at">, tele: SessionTelemetry | undefined): boolean {
  const handoffMs = Date.parse(tele?.handoffAt ?? "")
  if (!Number.isFinite(handoffMs)) return false
  const reached = [tele?.restFromAt ?? tele?.lastUserAt, row.bg_snooze_rested_at].map((at) => Date.parse(at ?? ""))
  return !reached.some((ms) => ms >= handoffMs)
}

// Whether a thread is resting while its own background work is still live — the signal the client keys
// the awaiting-background card on, across all THREE surfaces (the queue card, the drawer and the
// full-screen page). True only when it is at rest (turn-idle) with live own work and NO stronger reason
// outranks it (a native/typed ask, permission prompt, chat question, or ANY signal fence all render their
// own card instead). Kept adjacent to deriveNeedsYou and delegating to it so the two never drift.
//
// The QUEUE surface is back as of 2026-08-04, for a SHELL-ONLY rest: those threads queue again
// (deriveNeedsYou excuses live sub-agents only), so the card renders there with its Snooze. A rest on a
// live sub-agent is still excused from the queue, so for that shape the drawer and the full-screen page
// remain the only places this state is stated in words — which is why the card must keep rendering
// without a queue card behind it, and why the snooze below is dropped.
//
// The queue's event-Snooze is deliberately NOT inherited (bg_snooze_rested_at is nulled out below).
// Snoozing is a QUEUE VERB — "stop showing me this card in the queue" — while this flag states a FACT
// about the thread, and AwaitingBackgroundCard renders that fact on the drawer and the standalone page
// too, where there is no Snooze affordance and nothing to dismiss. Inheriting the snooze let one queue
// click blank all three surfaces at once: the drawer then showed NOTHING at rest — the shimmer stops and
// the transcript just ends — which is exactly the "reads as if the agent died" failure the card exists to
// prevent (found 2026-07-29 on a shell-only thread; the report was "there's no card for it in the UI —
// when I click it, it opens it in a drawer"). The queue card itself stays hidden regardless, because the
// queue list gates on needsYou (groups.ts `queued`), which still honours the snooze.
//
// SHELL-ONLY is why this went unnoticed at the time: the client's hasLiveOps then read raw sub-agents,
// so a snoozed thread with a live child kept its spinner in the running band and stayed legibly alive,
// while a snoozed shell-only one fell all the way through to a rested-band row with nothing behind it
// anywhere. hasLiveOps now reads THIS flag, which is what makes a snoozed shell-only rest legible again:
// no queue card, but a running-band row wearing the pulsing dot until the shell returns.
export function deriveAwaitingBackground(
  row: SessionRow,
  tele: SessionTelemetry | undefined,
  runtime: RuntimeState,
  hasActionableInteraction = false,
  nowMs = Date.now(),
  limitPause: ThreadView["limitPause"] = undefined,
  deliveryProcessGone = false,
  github: GithubStatusBook = {},
  registeredPrWatches: ReadonlySet<string> = new Set(),
  armedTimerIds: ReadonlySet<string> = new Set(),
  armedWatches: readonly RegisteredWatch[] = [],
  openQuestions = 0,
): boolean {
  // DECLARED, not inferred. This card used to appear whenever the thread had anything running, which is
  // how it came to announce a wait on a dev server nobody tore down. It now states what the worker said
  // it is waiting on, and says nothing when the worker said nothing.
  if (runtime !== "turn-idle" || !hasDeclaredWait(tele, nowMs, armedTimerIds, registeredPrWatches, armedWatches)) return false
  // A LIMIT FAULT OUTRANKS EVERY DECLARED WAIT: the provider cut the thread off, so its story is the
  // limit card, never "waiting on background work". Until 2026-08-31 this fell out of the final
  // deriveNeedsYou call for free (a limit pause was a queue EXCUSAL, so it returned false); now that a
  // limit fault is a hard queue MEMBER there, it would flip this fact-flag true — and with it
  // hasLiveOps client-side, spinning a dead thread — unless stopped here explicitly.
  if (limitPause || tele?.providerError) return false
  // Any hard human gate or completion signal outranks this reason → the thread cards as THAT, not here.
  // A REGISTERED question outranks this card for the same reason a fenced one does: at rest with both
  // outstanding the human should be looking at the QUESTION, which is the actionable thing, and two
  // expanded surfaces compete for one glance. The waits are not lost with it — BackgroundOpsStrip
  // still lists every live shell, sub-agent and watcher under the prompt box, one compact line each
  // (checked in a browser on registered-question-fixture.html?busy=1). That strip is where they live on
  // an asking card; this card is where they live when there is nothing to ask.
  if (hasActionableInteraction || tele?.pendingAsk || tele?.pendingQuestion || openQuestions > 0) return false
  // A signal fence — ```done OR ```awaiting — is the worker's OWN explicit statement about why it
  // stopped, and it renders its own card in the transcript body. That is strictly more specific than
  // "it has background work running", so it wins: show the fence card ALONE, never both. This is the
  // PR-wait double-card fix (maintainer 2026-07-24): a PR-watching thread with a live sub-agent stays
  // queued (deriveNeedsYou keeps it, since a PR wait is a visible handoff) but cards as its fence rather
  // than as this banner. A parked human/timer fence never reached here anyway (it's Snoozed, not queued).
  //
  // A PR PARK IS NOW THE EXCEPTION, and the exception is what makes it one card again rather than
  // two (maintainer 2026-08-13, choosing this): the awaiting card no longer offers a park action for
  // a PR wait at all — see lib/awaitingPresentation.awaitingParkAction, where the branch that titled it
  // "PR watcher armed" and carried its Snooze is gone. The watcher itself is listed under the prompt box
  // with the sub-agents and shells, and THIS card carries the one snooze. Without this line the parked
  // thread would show a titleless fence card and no snooze anywhere.
  if (tele?.lastFence?.kind === "done") return false
  // A DECLARED BACKGROUND PARK IS THE SAME EXCEPTION as the PR one directly above, for the same
  // reason: its fence has no park action of its own (awaitingParkAction returns null for `watch:`), so
  // suppressing this card would leave the thread stating its wait nowhere and offering no snooze.
  if (
    tele?.lastFence?.kind === "awaiting" &&
    !hasParkedPrWatch(tele, registeredPrWatches) &&
    !hasDeclaredBackgroundPark(tele, nowMs) &&
    // A REGISTERED park is the same exception for the same reason. (A registration with no fence at all
    // never reaches this branch — it is gated on an awaiting fence being the worker's last word.)
    !hasRegisteredBackgroundPark(tele, armedWatches, nowMs) &&
    // A TIMER PARK IS THE SAME EXCEPTION AGAIN (2026-08-24): its fence has no park action either, so
    // suppressing this card left the wait stated nowhere but the fence's own machinery footer.
    !hasParkedTimerWatch(tele, armedTimerIds) &&
    // STEPS FOR THE HUMAN carry the card's own Done, so this card is the one place it can be pressed
    // from — the queue, the drawer and the full-screen page alike.
    !hasHumanSteps(tele)
  ) return false
  // Every OTHER excusal deriveNeedsYou applies still outranks the card (a user wall-clock snooze, a
  // delivered-but-unobserved follow-up); only the queue-owned event-snooze is dropped,
  // and the queue's live-OWN-WORK excusal is opted out of (excuseLiveOwnWork: false). That opt-out is
  // what keeps this flag meaningful at all: the very threads it describes are precisely the ones that
  // excusal removes from the queue, so inheriting it would make this function always false and blank the
  // drawer and full-screen page for a healthy thread resting on its children or on a shell. Since
  // 2026-08-01 that covers a shell-only rest too — it now has NO queue card at all, so this card in the
  // drawer and on the standalone page is the only place that state is stated in words.
  return deriveNeedsYou({ ...row, bg_snooze_rested_at: null }, tele, runtime, hasActionableInteraction, nowMs, limitPause, false, deliveryProcessGone, {}, new Set(), armedTimerIds, armedWatches, openQuestions)
}

// WHICH BAND A REST OUT OF THE QUEUE SITS IN (2026-10-05) — ThreadView.waitStatus. deriveNeedsYou answers
// only whether the human is needed, and "not needed" used to mean Running: the client read
// `awaitingBackground` as motion, so a thread parked for a day on a CI watcher spun in the Running band
// and counted as running work on the project rail (maintainer 2026-10-03: "This doesn't need input, but
// that doesn't mean that it should be marked as currently active. It's just kind of like a watcher
// thread"). Two answers, and the worker gives them in the fence's `status:` line:
//
//  - `working` — the wait finishes BY ITSELF: a benchmark, a test run, a sub-agent doing a job. Running,
//    with a spinner. Believed only while something it names is actually MOVING — a live sub-agent, a
//    shell the fence names or a watch registers, CI that is running and not held at the approval gate —
//    so a `working` park on a timer or a settled PR reads as the watch it is.
//  - `watching` — the wait is on the WORLD: a review, a release, a reporter, a poll for a change. Snoozed,
//    and still. Honoured even beside a live sub-agent, because the contract hands a long wait to a
//    sub-agent; the child keeps its own spinner on its own row.
//
// A fence that answers with the older `needs_input: false`, and a legacy fence with neither line, get
// frizz's reading instead: `working` while a live sub-agent or moving CI is out, `watching` otherwise —
// shells included, since a shell alone cannot say whether it is a test run or a watcher. That is what
// moves the reported thread, a 23h shell watcher on a pre-cut fence, into Snoozed with no fence change.
//
// ABSENT for every other shape, which the client reads as the old placement: a queued rest (it never
// spins), a rest that is not at rest, an archived row, a declared `needs_input` the human event-snoozed
// (the click parks it, not this), and a message on its way to the worker — a follow-up or an answer the
// transcript has not shown yet, whose row keeps its Running placement until the turn starts.
export function deriveWaitStatus(
  tele: SessionTelemetry | undefined,
  runtime: RuntimeState,
  needsYou: boolean,
  awaitingBackground: boolean,
  messageInFlight: boolean,
  nowMs: number,
  github: GithubStatusBook = {},
  registeredPrWatches: ReadonlySet<string> = new Set(),
  armedWatches: readonly RegisteredWatch[] = [],
): ThreadView["waitStatus"] {
  if (runtime !== "turn-idle" || needsYou || messageInFlight) return undefined
  const liveChild = hasLiveBackgroundWork(tele)
  if (!awaitingBackground && !liveChild) return undefined
  const fence = tele?.lastFence?.kind === "awaiting" ? tele.lastFence : undefined
  const declared = fence ? awaitingStatus(fence.hints) : null
  if (declared === "needs_input") return undefined
  if (declared === "watching") return "watching"
  if (liveChild || [...registeredPrWatches].some((key) => ciInMotion(github[key]))) return "working"
  if (declared !== "working") return "watching"
  // A SHELL MOVES ONLY WHEN THE WORKER SAYS SO: named in the fence, or registered with a watch. An
  // unnamed one is as likely a dev server nobody tore down as the job being waited on.
  const namedShell = readAwaitingPark(fence?.hints ?? []).items.some((i) => i.kind === "shell" && resolveLiveWatchTarget(tele, i.value)?.kind === "shell")
  const registeredShell = armedWatches.some((w) => w.kind === "shell" && Date.parse(w.expiresAt) > nowMs && resolveLiveWatchTarget(tele, w.target)?.kind === "shell")
  return namedShell || registeredShell ? "working" : "watching"
}

// A REGISTERED session thread's view (id = row.slug). Runtime via the shared deriveRuntime (transport-aware);
// telemetry fields mirror the legacy path; title provenance is resolved before the snapshot is emitted.
export function resolveSessionProfile(
  row: Pick<SessionRow, "backend" | "model" | "effort" | "spawned_at" | "profile_set_at">,
  tele: Pick<SessionTelemetry, "model" | "effort" | "profileAt"> | undefined,
): { model?: string; effort?: string } {
  const persistedModel = row.model?.trim() || undefined
  const persistedEffort = row.effort?.trim() || undefined
  const observedAt = tele?.profileAt ? Date.parse(tele.profileAt) : NaN
  const spawnedAt = Date.parse(row.spawned_at)
  // A transcript is replayed from byte zero whenever a runtime generation changes. A persisted launch
  // target therefore remains authoritative until a genuinely post-spawn profile record arrives; old
  // turn_context/assistant records must not snap the controls back after reattach or server restart.
  // SIBLING of resolveSessionPermission's set-time rule (permission_set_at): a codex model/effort
  // change made eagerly through setThreadProfile takes effect from the next turn, so no fresh
  // turn_context exists yet and the last one still reports the OLD profile. When the OPERATOR set the
  // profile AFTER that observed reading, prefer the saved intent so the visible composer selector shows
  // the pick immediately; a genuinely newer turn (observedAt > setAt) re-establishes observed authority,
  // so it converges on its own.
  //
  // ON CLAUDE THE PICK NEVER EXPIRES INTO AN OBSERVATION, because there is nothing for it to converge
  // ON. Codex takes model/effort per turn, so a later turn_context is a true reading of the pick having
  // landed. Claude fixes them at FORK time, so a live daemon goes on running what it was forked with and
  // every record it writes reports the OLD model — a reading of a session that structurally cannot have
  // honoured the pick. Converging on that is how a just-made choice silently reverted in the composer
  // seconds after the click (measured 2026-09-03). This mirrors, exactly, the rule the stored row now
  // keeps: observedProfileIfCurrentStmt in storage.ts fences the same case and carries the full account.
  // Both halves say the same thing, so the row and the readout cannot disagree about a thread's target.
  //
  // The trade is stated on that statement: on a claude row with a hand-set profile, a model change frizz
  // never made and cannot see is no longer learned back.
  const setAt = row.profile_set_at ? Date.parse(row.profile_set_at) : NaN
  const operatorSetSticks = (row.backend ?? "claude") !== "codex"
  const supersededByOperatorSet = Number.isFinite(setAt) && (operatorSetSticks || setAt > observedAt)
  const observedIsCurrent = Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt && !supersededByOperatorSet
  const observedModel = tele?.model
    ? normalizeObservedThreadModel(row.backend ?? "claude", tele.model) ?? tele.model.trim()
    : undefined
  const model = (!persistedModel || observedIsCurrent ? observedModel : undefined) || persistedModel
  const effort = (!persistedEffort || observedIsCurrent ? tele?.effort?.trim() : undefined) || persistedEffort
  return { model, effort }
}

export function resolveSessionPermission(
  row: Pick<SessionRow, "backend" | "spawned_at" | "permission_mode" | "permission_pending" | "permission_set_at">,
  tele?: Pick<SessionTelemetry, "permissionMode" | "permissionModeAt">,
): ThreadView["permissionMode"] {
  const saved = PermissionMode.safeParse(row.permission_mode)
  const pending = PermissionMode.safeParse(row.permission_pending)
  const normalize = (mode: PermissionModeValue) => effectivePermissionMode(row.backend === "codex" ? "codex" : "claude", mode)
  // A successful controlled reattach stamps the exact argv mode before its transcript sidecar is
  // tailed. During that short reconciliation window the launched value is already authoritative.
  if (saved.success && pending.success && normalize(saved.data) === normalize(pending.data)) return normalize(saved.data)
  if (row.backend === "codex" && saved.success) {
    // Codex does not append a profile record merely by reopening an idle rollout. Ignore an older
    // turn_context from before this process generation, but accept a later /permissions or turn event.
    const observedAt = tele?.permissionModeAt ? Date.parse(tele.permissionModeAt) : NaN
    const spawnedAt = Date.parse(row.spawned_at)
    if (tele?.permissionMode && Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt) {
      // …EXCEPT when the OPERATOR changed the sandbox eagerly (thread/settings/update) AFTER that
      // observed reading. The change takes effect from the next turn, so no fresh turn_context exists
      // yet and the last one still reports the OLD sandbox — showing it would lie about a change the
      // operator just made. Prefer the saved intent until a genuinely newer turn re-establishes the
      // observed value (then observedAt > setAt and this converges back to telemetry on its own).
      const setAt = row.permission_set_at ? Date.parse(row.permission_set_at) : NaN
      if (Number.isFinite(setAt) && setAt > observedAt) return normalize(saved.data)
      return normalize(tele.permissionMode)
    }
    return normalize(saved.data)
  }
  // The tailer writes every observed Claude permission-mode transition back to this row. Prefer the
  // durable value so a just-reattached process cannot be relabeled by the previous in-memory fold.
  if (saved.success) return normalize(saved.data)
  return tele?.permissionMode ? normalize(tele.permissionMode) : undefined
}

export function resolvePendingPermission(row: Pick<SessionRow, "permission_pending">): ThreadView["permissionPending"] {
  const parsed = PermissionMode.safeParse(row.permission_pending)
  return parsed.success ? parsed.data : undefined
}

// The recurring prompt as BOTH readers see it: the board's Goal panel (through the thread view below)
// and the worker's own `frizzctl goal get` (through the router). One
// projection because they must agree — a worker reading back a different row than the human is editing
// is exactly the confusion the read action exists to end.
//
// Present iff the text and its generation are both set (storage writes and clears them together).
// Projected even with EVERY TRIGGER OFF — that is the state switching them all off leaves, and the text
// and the cadence have to survive it or the panel would open empty.
export function resolveRecurringPrompt(
  row: Pick<
    SessionRow,
    | "recurring_prompt" | "recurring_armed_at" | "recurring_on_rest" | "recurring_on_schedule"
    | "recurring_on_compact" | "recurring_interval_ms" | "recurring_rest_fired_at"
    | "recurring_schedule_fired_at" | "recurring_compact_fired_at"
  >,
): ThreadRecurringPrompt | undefined {
  if (!row.recurring_prompt || !row.recurring_armed_at) return undefined
  return {
    prompt: row.recurring_prompt,
    stopHook: row.recurring_on_rest === 1,
    heartbeat: row.recurring_on_schedule === 1,
    postCompaction: row.recurring_on_compact === 1,
    // Carried whenever a cadence has ever been chosen, INCLUDING while the heartbeat is off — the
    // minutes field has to read back what switching it on again would use.
    intervalSeconds: row.recurring_interval_ms ? Math.round(row.recurring_interval_ms / 1000) : undefined,
    armedAt: row.recurring_armed_at,
    lastRestFiredAt: row.recurring_rest_fired_at ?? undefined,
    lastScheduleFiredAt: row.recurring_schedule_fired_at ?? undefined,
    lastCompactFiredAt: row.recurring_compact_fired_at ?? undefined,
  }
}

// Project a fold-observed limit fault onto the wire view: which window blew, when, when it comes back,
// and whether frizz will deliver its own "continue". `resumesAt` is present only when the provider's
// own reset clock resolves it (a weekly clock never does — see textResetInstant); its ABSENCE does not
// cancel the auto-resume promise, because the scheduler can still resolve a weekly instant from the
// usage endpoint. The card then says "when the window resets" rather than naming a time known nowhere.
//
// Auto-resume is ALWAYS armed — there is no setting to turn it off. `autoResume` is therefore purely a
// staleness verdict: a fault whose window is long past no longer promises a wake it will never deliver.
export function resolveLimitPause(
  row: Pick<SessionRow, "backend">,
  tele: Pick<SessionTelemetry, "limitFault"> | undefined,
  nowMs: number,
): ThreadView["limitPause"] {
  const fault = tele?.limitFault
  if (!fault) return undefined
  // Codex has no trustworthy reset clock. Keep its provider-authored error card (not the timed
  // Claude pause card); recovery is conditional on a fresh live capacity reading in the scheduler.
  if (fault.codex) return undefined
  const at = Date.parse(fault.at)
  const stale = limitPauseIsStale(fault.window, at, nowMs)
  // Resolve the clock relative to the FAULT, never to `now`. "resets 5:50pm" means the first 5:50pm
  // after the provider said it; anchoring on `now` would silently roll the answer to TOMORROW's 5:50pm
  // the moment the real one passed, so the promised time would run away from the reader forever.
  const resumesAtMs = fault.resetClock && Number.isFinite(at)
    ? textResetInstant({ window: fault.window, resetClock: fault.resetClock }, at)
    : undefined
  return {
    backend: row.backend === "codex" ? "codex" : "claude",
    window: fault.window,
    at: fault.at,
    ...(resumesAtMs !== undefined ? { resumesAt: Math.round(resumesAtMs / 1000) } : {}),
    // The promise must match the waker's actual reach. An "unknown" window has NO live trigger — no
    // text clock (textResetInstant is session-only) and no usage-endpoint key (quotaWindowKeyFor) —
    // so limitRecovered stays indeterminate forever and "Continuing automatically" would be false
    // advertising (it WAS, until 2026-08-31: a fleet killed by an unrecognized limit phrasing sat
    // behind that promise for 40+ minutes). session/weekly/model each have at least one trigger.
    autoResume: !stale && fault.window !== "unknown",
  }
}


// Title provenance is resolved server-side as well as in the web display helper. A transcript title is
// eligible while the registry says nothing HUMAN has claimed the name; once a human commits one
// (setTitle atomically locks it), no later tail tick can put aiTitle back on the wire as a competing
// display value. Note the two flags are independent here: a title hard-coded by a dispatch caller is
// not a guess (titleAuto false, so the UI shows it verbatim while the session spins up) yet is still
// unlocked, so the worker's own aiTitle rides the wire and wins the moment it exists.
// The transcript title is LIVE telemetry and only exists while a session is being tailed; the registry
// copy (`title_agent = 1`, written by the auto-title CAS) is the same worker-authored name persisted,
// and it is all that is left once the thread rests, is archived, or the server restarts. Falling back
// to it is what stops a codex thread reading "Untitled thread" for the rest of its life: with no
// aiTitle on the wire the display side cannot tell a persisted worker title from the dispatch chop,
// so it must assume the chop.
//
// THE REGISTRY COPY OUTRANKS TELEMETRY, which is the reverse of the rule here until `frizzctl title`
// existed ("telemetry wins while present — it is the fresher of the two"). Freshness was the right
// tiebreak only while the two could not disagree: both halves were the same codex marker, so the CAS
// either matched telemetry exactly or had not run. A worker registering its own name breaks that tie
// for real — `title_agent = 1` now means a worker DELIBERATELY named the thread after reading the task,
// while `tele.aiTitle` is the spawn-time guess it is correcting, and the guess must not win. For a
// codex row the flip is a no-op by construction: the persisted copy was written FROM telemetry, so it
// is either byte-identical or absent.
export function resolveSessionTitle(
  row: Pick<SessionRow, "title" | "title_auto" | "title_locked" | "title_agent">,
  tele: Pick<SessionTelemetry, "aiTitle"> | undefined,
): Pick<ThreadView, "title" | "titleAuto" | "titleLocked" | "aiTitle"> {
  const locked = sessionTitleLocked(row)
  const persisted = row.title_agent === 1 ? row.title?.trim() || undefined : undefined
  return {
    title: row.title ?? "",
    titleAuto: row.title_auto === 1,
    titleLocked: locked,
    aiTitle: locked ? undefined : (persisted ?? tele?.aiTitle),
  }
}

/** A registered completion as the ```done fence it replaces, or undefined when it no longer stands.
 *
 *  ITS LIFETIME IS "NOTHING NEWER FROM THE HUMAN". A fence is superseded the moment the worker writes
 *  again; a ROW cannot be, so something has to spend it — and the human SENDING MORE WORK is exactly
 *  the moment a completion stops being true. Deciding that by comparing two timestamps means there is
 *  no sweep to forget one, and no window where a thread that was reopened still cards as finished.
 *
 *  The comparison is `<=`, not `<`: the two instants come from different clocks (the row's is frizz's
 *  own `Date.now()`, the telemetry's is the transcript record's), and a same-millisecond tie is the
 *  worker signing off on the turn that user record started, which is the ordinary case. */
export function registeredDoneFence(
  done: { body: string; doneAt: number } | undefined,
  lastUserAt: string | undefined,
): FenceView | undefined {
  if (!done) return undefined
  const userAt = lastUserAt ? Date.parse(lastUserAt) : Number.NaN
  if (Number.isFinite(userAt) && userAt > done.doneAt) return undefined
  // `registered` is the one thing the transcript needs that the fence it replaces never carried: a fenced
  // done is drawn from the message that holds it, and this one is in no message, so the client draws it
  // at the bottom of the thread itself (ChatView, showsRegisteredDoneCard). Every predicate ignores it.
  // The stored body is in the fence's own grammar — `frizzctl done --title` writes `title: …` and `---`
  // above the ledger — so it is split by the fence's own splitter, and the title reaches the card as the
  // same hint a fenced done carries instead of printing as the ledger's first line (2026-10-13).
  const { body, hints } = splitDoneFrontmatter(done.body)
  return { kind: "done", body, hints, registered: true }
}

// Every per-thread REGISTRY the row builder needs, read whole ONCE per build and indexed by slug.
//
// These five used to be five queries per row: `listPrWatches`, `listThreadTimers`,
// `listThreadQuestions`, `listThreadWatches` and `getThreadDone`, each scoped to one slug. That is
// five statements times however many threads the project holds, and node:sqlite is SYNCHRONOUS — the
// whole cost lands on the event loop, which is the same loop every RPC and every board push is waiting
// on. On a copy of the maintainer's own board (558 rows) one rebuild issued 2,794 statements and took
// 30.5ms; 2,790 of those statements were these five. A rebuild fires on a 150ms debounce whenever any
// agent writes into `.frizz`, and unconditionally every RECONCILE_MS — so on a live server with agents
// working it ran continuously, and the board RPC that idles at 4.5-10ms was measured at 49-1069ms
// (median ~270ms) with 220 blocked-loop warnings in the server's own log.
//
// Batched, those five registries issue five statements total; saved links add one more. Each
// batched read carries the identical predicate and ORDER BY as the per-slug one it replaces (see the
// `groupBySlug` note in storage.ts), and a thread with no rows is simply absent from the map, which is
// why every read below spells the fallback `?? []` — the empty array the per-thread call returned.
interface ThreadRegistries {
  links: ReadonlyMap<string, readonly ThreadLinkRow[]>
  prWatches: ReadonlyMap<string, readonly PrWatchRow[]>
  timers: ReadonlyMap<string, readonly ThreadTimerRow[]>
  commandWatches: ReadonlyMap<string, readonly CommandWatchRow[]>
  questions: ReadonlyMap<string, readonly ThreadQuestionRow[]>
  watches: ReadonlyMap<string, readonly ThreadWatchRow[]>
  done: ReadonlyMap<string, { readonly body: string; readonly doneAt: number }>
}

function readThreadRegistries(storage: Storage, previous?: ThreadRegistries): ThreadRegistries {
  const next: ThreadRegistries = {
    links: storage.threadLinksBySlug(),
    prWatches: storage.armedPrWatchesBySlug(),
    timers: storage.armedThreadTimersBySlug(),
    commandWatches: storage.armedCommandWatchesBySlug(),
    questions: storage.threadQuestionsBySlug(),
    watches: storage.armedThreadWatchesBySlug(),
    done: storage.threadDoneBySlug(),
  }
  // The storage hands back the same map while its table is unchanged, so "nothing in any registry
  // moved" is seven identity checks — and then the previous object, which the archived-view memo
  // reads as "every bucket is as it was" (ArchivedViewInputs.confirmedIn).
  if (
    previous &&
    previous.links === next.links &&
    previous.prWatches === next.prWatches &&
    previous.timers === next.timers &&
    previous.commandWatches === next.commandWatches &&
    previous.questions === next.questions &&
    previous.watches === next.watches &&
    previous.done === next.done
  ) return previous
  return next
}

function sessionThreadView(
  projectDir: string,
  storage: Storage,
  row: SessionRow,
  rawTele: SessionTelemetry | undefined,
  registeredLegacyTerminal: boolean,
  interactionPresence: { pending: boolean; needsUser: boolean },
  nowMs: number,
  codexTurnLiveness: CodexTurnLivenessReader,
  claudeBrokerDaemonAlive: ClaudeBrokerLivenessReader,
  // This thread's timers, watchers, watches, questions and completion — read once per build by the
  // caller for the whole project and looked up by slug here. See ThreadRegistries above for why.
  registries: ThreadRegistries,
  // Every watched PR's checks/mergeability as the poller last saw it, read once per build by the caller.
  // It decides a QUEUE RULE (checks still running → the active rail, not the queue) as well as what the
  // card renders, so both read the same book — a card stating check state the board could not see is
  // exactly the drift that once produced two cards disagreeing about one wait.
  github: GithubStatusBook = {},
  // The watched-ISSUE readings, the same way — its own book because the entries have their own shape.
  issueBook: GithubIssueStatusBook = {},
  // The pinned Claude runtime's resolved catalogue (claude-models.ts peekClaudeModels), for the edition a
  // thread runs against the one its family now resolves to. Undefined until the first probe lands.
  claudeCatalogue: readonly ClaudeModel[] | undefined = undefined,
  // The ```question fences this thread's latest sync REFUSED (question-fences.ts QuestionFaultBook), so
  // the web can draw each as the code block it is instead of a card. Undefined when it refused nothing.
  questionFaults: readonly QuestionFenceFault[] | undefined = undefined,
): ThreadView {
  // A REGISTERED completion is presented to everything below as the ```done fence it replaces — same
  // shape, same three predicates, same card — so the two cannot render as two different endings while
  // both are accepted. (plans/rest-by-registration.md: the fence keeps working through the migration.)
  //
  // ITS LIFETIME IS "NOTHING NEWER FROM THE HUMAN". A fence is superseded when the worker writes again;
  // a row cannot be, so the human SENDING MORE WORK is what spends it, and that is exactly the moment a
  // completion stops being true. Comparing timestamps here means there is no sweep to forget one, and
  // no window where an archived-then-reopened thread cards as done on work nobody redid.
  //
  // Only ever LAYERED OVER real telemetry, never fabricated in its absence: an untailed thread has no
  // runtime, no turn and no last activity, and half a SessionTelemetry carrying one fence would put
  // every predicate below on a shape none of them was written for.
  // The PRs this thread has actually REGISTERED, by `owner/repo#N` — what a `prs:` declaration is
  // checked against. Looked up per thread, but READ once for the whole project (ThreadRegistries).
  const armedPrWatches = (registries.prWatches.get(row.slug) ?? []).map((w) => ({
    target: `${w.owner}/${w.repo}#${w.number}`,
    kind: w.kind,
    createdAt: new Date(w.created_at).toISOString(),
  }))
  // BOTH KINDS, by ref. Every reader of this set asks "is there a registration behind this declared
  // wait" (hasParkedPrWatch) or "is CI running on every registered PR" (heldByRunningChecks, which since
  // 2026-09-20 reads this set directly and looks each up in the PR book — an issue ref is never in that
  // book, so an issue watch cannot hold a thread, and beside a running PR it releases one: the human has
  // an issue to look at).
  const registeredPrWatches = new Set(armedPrWatches.map((w) => w.target))
  // This thread's ARMED TIMERS — what a `timers:` declaration is checked against, and rows on the
  // resting card's table beside the PRs and shells (maintainer 2026-08-24). Same per-thread lookup,
  // same ms→ISO mapping as the worker's own tool (router.armedTimerViews).
  const armedTimers = (registries.timers.get(row.slug) ?? []).map((t) => ({
    id: t.id,
    prompt: t.prompt,
    fireAt: new Date(t.fire_at).toISOString(),
    createdAt: new Date(t.created_at).toISOString(),
  }))
  // …and its ARMED COMMAND WATCHES (`frizzctl watch-command`), in the same set: see isCommandWatchId for
  // why one set serves both, and where it is split back by kind.
  const armedCommandWatches = registries.commandWatches.get(row.slug) ?? []
  const armedTimerIds = new Set([...armedTimers.map((t) => t.id), ...armedCommandWatches.map((w) => w.id)])
  // This thread's ARMED WATCHES on its own running work — the `thread_watch` rows `frizzctl watch`
  // creates. Same per-thread lookup as the two registries above, and the same ms→ISO mapping as the
  // worker's own read-back (router.armedOwnWatchViews), so the row, the strip and the tool cannot
  // disagree about one wait.
  // This thread's OPEN REGISTERED QUESTIONS, carried whole rather than as a flag: the card renders from
  // these instead of re-parsing the transcript's prose, which is what gives every question a STABLE id
  // to be answered, withdrawn or dismissed BY. A row whose spec no longer parses is dropped rather than
  // thrown on — one bad row must not blank a card carrying three good ones.
  // ONE read of the thread's questions, both halves derived from it: the OPEN ones the card asks, and
  // the just-answered ones still on their way to the worker (answersInFlight). Unfiltered by state for
  // exactly that reason, which is why the batched read behind it is unfiltered too.
  const questionRows = registries.questions.get(row.slug) ?? []
  // WHICH OF THEM STAND AT THIS REST — asked at it, or referenced by it with an `id:` fence
  // (question-fences.ts). Only those queue the thread (below), and each row says so on the view, because
  // the rail's mark and the ask count are derived from these rows by other readers (web groups.ts
  // sessionIndicatorKind, shared needsAction): told only "open", they marked a parked or finished thread
  // [?] for a question the queue no longer held it on. An older open question stays answerable where it
  // was asked, and on the card, but says nothing about where this rest sits (2026-10-13).
  const standingIds = new Set(standingQuestions(questionRows, rawTele, questionFaults).map((q) => q.id))
  const questions: ThreadView["questions"] = []
  for (const q of questionRows) {
    if (q.state !== "open") continue
    const spec = safeQuestionSpec(q.spec)
    if (spec) questions.push({ id: q.id, spec, askedAt: new Date(q.asked_at).toISOString(), standing: standingIds.has(q.id) })
  }
  // The FENCE-ASKED questions that closed WITHOUT an answer: dismissed (by the human's ×, or by Frizz the
  // moment an autonomous thread wrote one) or withdrawn by the worker. Their fences are still in the
  // transcript, and a fence with no open and no answered row is otherwise drawn as a question about to
  // become answerable — so a Goal thread's cancelled question sat on the page looking asked (seen on a
  // stack, 2026-10-13). Only rows with a handle: a question the `ask` RPC registered has no fence to draw.
  const closedQuestions: NonNullable<ThreadView["closedQuestions"]> = []
  for (const q of questionRows) {
    if ((q.state !== "dismissed" && q.state !== "withdrawn") || !q.handle) continue
    closedQuestions.push({ id: q.id, handle: q.handle, state: q.state, askedAt: new Date(q.asked_at).toISOString() })
  }
  // The dismissal-only case counts as in flight EXACTLY when a cancellation wake is coming — an armed
  // rest Goal with text, the same gate the scheduler's evalQuestionAnswers wakes on. Anything looser
  // would also cover the human's own ×, which deliberately wakes nobody and has no arrival to bridge to.
  const inFlightAnswers = answersInFlight(questionRows, answersReceivedAt(rawTele), row.recurring_on_rest === 1 && Boolean(row.recurring_prompt?.trim()))
  const armedWatches: RegisteredWatch[] = (registries.watches.get(row.slug) ?? []).map((w) => ({
    id: w.id,
    kind: w.kind,
    target: w.target,
    createdAt: new Date(w.created_at).toISOString(),
    expiresAt: new Date(w.expires_at).toISOString(),
  }))
  // …AND A LIVE REGISTRATION OUTRANKS IT (maintainer 2026-08-27: "done always gets trumped by a watcher
  // or a question"). The registering verbs clear the row themselves (router: ask, addOwnWatch,
  // addOwnPrWatch, setOwnThreadTimer) and `done` refuses while any is live, so this is the belt to
  // those braces: whatever path leaves a done row beside an open question or an armed wait, the board
  // presents the wait, never a finished thread that is also asking or waiting.
  const supersededDone = questions.length > 0 || armedWatches.length > 0 || armedPrWatches.length > 0 || armedTimers.length > 0 || armedCommandWatches.length > 0
  const codexLive = row.codex_runtime === "app-server" ? codexTurnLiveness(row.slug, row.session_id) : undefined
  const nativeError = codexLive?.providerError
  // A witnessed failed turn can arrive before the tailer's next read. Do not keep spinning on the
  // older rollout in that gap, or resurrect a native failure after newer successful rollout output.
  const nativeFailure = nativeError && !nativeError.retrying && !codexLive?.bridgeTurn
    && (!rawTele?.lastActivityAt || (nativeError.at !== undefined && nativeError.at >= rawTele.lastActivityAt))
  // Prefer the journal's canonical timestamp when both channels describe the same terminal error.
  const sameError = rawTele?.providerError?.message === nativeError?.message && rawTele?.providerError?.code === nativeError?.code
  const providerError = nativeError?.retrying ? nativeError
    : nativeFailure ? (sameError ? rawTele?.providerError : nativeError) : rawTele?.providerError
  const failedTele: SessionTelemetry | undefined = nativeFailure ? {
    subAgents: [], bgShells: [], ...rawTele,
    turn: "idle", permPrompt: false, pendingQuestion: false, pendingAsk: undefined, apiFault: true, providerError,
    lastAssistant: providerError?.message, lastAssistantLine: firstTextLine(providerError?.message), lastAssistantAt: providerError?.at,
    liveTool: undefined,
    lastFence: undefined, lastAssistantAllDone: false,
  } : rawTele
  const done = supersededDone || providerError ? undefined : registeredDoneFence(registries.done.get(row.slug), rawTele?.lastUserAt)
  const tele: SessionTelemetry | undefined = done && failedTele ? { ...failedTele, lastFence: done } : failedTele
  // A headless thread mid-turn with nobody driving it is a crash/stall, not a rest. For codex that is
  // an app-server that stopped advancing the rollout; for the broker it is a dead ownerless daemon (its
  // liveness is the daemon record, resolved live). Either way the (exited + in-flight) pair trips the
  // crash-net so the thread cards as "Stalled" instead of spinning `running` forever.
  const headlessStalled =
    row.codex_runtime === "app-server"
      ? !nativeFailure && appServerTurnStalled(codexLive, tele?.lastActivityAt, nowMs)
      : isBrokerClaudeRow(row)
      ? !claudeBrokerDaemonAlive(row.session_id)
      : false
  // App-server threads write their rollout synchronously at thread/start, so a transient "no transcript
  // yet" must not degrade a healthy headless thread to the "exited"/stalled crash affordance.
  //
  // That guarantee is CODEX's alone, and blanket-suppressing on isHeadlessRow took the broker with it.
  // A broker claude row writes nothing until the agent processes its first input, so zero transcript
  // bytes past DISCOVERY_GRACE_MS is not a transient — it is precisely the boot failure the tailer has
  // already captured (it sets noTranscript and captureStall together). The headlessStalled probe above
  // does not cover it either: that trips only on a DEAD daemon, and this failure leaves the daemon and
  // its claude child ALIVE and idle. Observed live 2026-07-31 on thread
  // `the-landlock-people-i-m-interested`: the tailer logged the boot failure at 60s, the board threw the
  // flag away here, and the thread spun `running` for 29 minutes on an agent that never received its
  // opening prompt — until a human archived it by hand.
  // A REST that is not one: the daemon is gone and this thread still tracks a live sub-agent, which an
  // in-process child of that dead process cannot be. Deliberately BROKER-ONLY. The codex arm of
  // `headlessStalled` is `appServerTurnStalled`, a mid-turn predicate — a rested rollout stops advancing
  // by definition, so reusing it here would card every quiet codex thread as crashed. The broker arm is a
  // direct pid probe, which means exactly what it says at rest as well as mid-turn.
  const headlessLostWork = isBrokerClaudeRow(row) && headlessStalled && hasUnretiredOwnAgents(tele)
  // The same dead-daemon reading, asked of the DELIVERY ledger instead of the sub-agent map: a send
  // still marked pending/enqueued is a claim that a process is holding it, and that process is gone.
  // BROKER-ONLY for the reason directly above — the codex arm of `headlessStalled` is a mid-turn
  // predicate, and a rested codex thread trips it by definition, which would retire an outstanding
  // rollout send early (8 of 75 measured codex sends took over 60s to materialise; three took minutes
  // to hours). The broker arm is a direct pid probe and means what it says at rest.
  const deliveryProcessGone = isBrokerClaudeRow(row) && headlessStalled
  const runtime = degradeIfAwaitingAnswer(
    degradeIfNoTranscript(
      deriveRuntime(row.slug, row, storage, tele?.turn, tele?.permPrompt ?? false, headlessStalled, headlessLostWork),
      isHeadlessRow(row) && !isBrokerClaudeRow(row) ? false : tele?.noTranscript,
    ),
    // OUTERMOST on purpose: a stalled/transcript-less worker is a HARDER reading than an open ask (it
    // degrades to "exited", which this leaves alone), so the two never fight. Everything below — the
    // row's own runtime, deriveNeedsYou's rest-gate, deriveAwaitingBackground — reads this one value.
    tele?.pendingQuestion,
  )
  const state = effectiveSessionState(row, registeredLegacyTerminal)
  const archived = state === "archived"
  const limitPause = resolveLimitPause(row, tele, nowMs)
  const answerInFlight = answerAwaitingDelivery(questionRows, answersReceivedAt(rawTele), nowMs)
  // Only the questions STANDING at this rest queue the thread (`standingIds`, above).
  const standingCount = standingIds.size
  const queuedBy: QueuedBy = {}
  const needsYou = archived ? false : deriveNeedsYou(row, tele, runtime, interactionPresence.needsUser, nowMs, limitPause, true, deliveryProcessGone, github, registeredPrWatches, armedTimerIds, armedWatches, standingCount, answerInFlight, queuedBy)
  const deliveryInFlight = !archived && deriveDeliveryInFlight(row, runtime, needsYou, deliveryProcessGone, answerInFlight, nowMs)
  const awaitingBackground = archived ? false : deriveAwaitingBackground(row, tele, runtime, interactionPresence.needsUser, nowMs, limitPause, deliveryProcessGone, github, registeredPrWatches, armedTimerIds, armedWatches, standingCount)
  // hasFreshDelivery rather than deliveryInFlight: the spin stops after a minute, and a message still on
  // its way past that keeps its row where it was rather than parking it in Snoozed.
  const waitStatus = archived ? undefined : deriveWaitStatus(tele, runtime, needsYou, awaitingBackground, answerInFlight || hasFreshDelivery(row, deliveryProcessGone), nowMs, github, registeredPrWatches, armedWatches)
  // A worker that exited with work still outstanding — a turn in flight, OR a sub-agent still reading
  // "running" (its parent is gone, so it cannot actually be live) — is a crash/stall, not a clean
  // handoff, so it cards as "stalled" not a bare "rest". Mirrors deriveNeedsYou's surfacing above.
  // hasLiveBackgroundWork keys on sub-agents only (a background shell is never treated as live work);
  // it flips back to bare rest once the child's transcript goes stale.
  // `headlessLostWork` joins the two classic signals rather than relying on them. It is already the
  // thing that made `runtime` "exited" here, and on its own neither of the others fires: the turn ENDED
  // cleanly (that is the whole case), and hasLiveBackgroundWork reads `running` only, so it goes false
  // the moment the 15-minute staleness clock trips. Without this the thread would spend 15 minutes
  // carded as a stall and then silently become an ordinary bare rest — same lost work, no longer
  // mentioned. See hasUnretiredOwnAgents.
  const crashed = runtime === "exited" && (tele?.turn === "in-flight" || hasLiveBackgroundWork(tele) || headlessLostWork)
  const snoozedUntil = futureSnooze(row, nowMs)
  const profile = resolveSessionProfile(row, tele)
  // The Claude EDITION behind the family word — see ThreadView.runningModelLabel. Only when the observed
  // id is the family the readout names: after a model switch the transcript still reports the OLD family
  // until the next turn, and its edition would be a reading of the wrong model.
  const standing = (row.backend ?? "claude") === "claude" ? claudeModelStanding(tele?.model, claudeCatalogue) : undefined
  const edition = standing && standing.running.alias === profile.model ? standing : undefined
  const permissionMode = resolveSessionPermission(row, tele)
  const permissionPending = resolvePendingPermission(row)
  const title = resolveSessionTitle(row, tele)
  return {
    id: row.slug,
    ...title,
    status: "active", // synthesized: the field is required but UNUSED for session rows (see note above)
    hasPlan: false,
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime,
    sessionId: row.session_id,
    threadName: row.thread_name,
    unread: row.unread === 1,
    archived,
    lastAssistant: tele?.lastAssistant,
    lastAssistantLine: tele?.lastAssistantLine,
    liveTool: tele?.liveTool,
    spawnedAt: row.spawned_at,
    lastActivityAt: tele?.lastActivityAt,
    lastAssistantAt: tele?.lastAssistantAt,
    subAgents: stampStoppable(orphanedAgents(tele?.subAgents ?? [], deliveryProcessGone), row),
    bgShells: stampStoppableShells(tele?.bgShells ?? [], row),
    links: (registries.links.get(row.slug) ?? []).map(threadLinkView),
    // ONE SOURCE: the FENCE. Both kinds are derived from what the worker wrote — `prs:` entries
    // become the github rows, `watch:` lines the shell rows — so this strip lists exactly what will
    // actually wake the thread, and the two cannot drift into claiming different things. There is no
    // registry behind either any more (`thread_watch`, retired 2026-08-14).
    watches: fenceWatchViews(row.slug, tele, tele?.lastAssistantAt, github, armedPrWatches, armedTimers, armedWatches, issueBook, armedCommandWatches),
    pendingAsk: tele?.pendingAsk ? { questions: tele.pendingAsk.questions } : undefined,
    pendingQuestion: tele?.pendingQuestion ?? false,
    questions,
    ...(closedQuestions.length > 0 ? { closedQuestions } : {}),
    // Absent unless something was refused.
    ...(questionFaults && questionFaults.length > 0
      ? { questionFaults: questionFaults.map((f) => ({ at: f.at, ...(f.id ? { id: f.id } : {}), faults: [...f.faults] })) }
      : {}),
    answersInFlight: inFlightAnswers,
    deliveryInFlight: deliveryInFlight || undefined,
    lastUserAt: tele?.lastUserAt,
    // Runtime provider-auth rejection (claude-auth plan): only the typed category travels — the raw
    // error/provider text never leaves the server. Drives the trusted sign-in recovery card in ChatView.
    providerFault: tele?.authFault
      ? { backend: row.backend === "codex" ? "codex" as const : "claude" as const, category: tele.authFault }
      : undefined,
    // Subscription window exhausted mid-turn — the credential is fine, so this is a WAIT, not a
    // sign-in. Drives the pause card and (while an auto-resume is promised) the queue excusal above.
    limitPause,
    providerError,
    kind: "session",
    foreign: false,
    lastFence: tele?.lastFence,
    seenAt: row.seen_at ?? undefined,
    state,
    // The two bands' order keys. `archivedAt` only while archived, so a reopened row never carries one;
    // `runningSince` is kept by stampRunningSince (createBoard), which this build's view may still lag.
    archivedAt: state === "archived" ? row.archived_at ?? undefined : undefined,
    runningSince: row.running_since ?? undefined,
    snoozedUntil,
    // Only meaningful while the snooze is still pending — a prompt without a live deadline is an
    // already-delivered (or superseded) bump the row has not been swept clean of yet.
    snoozePrompt: snoozedUntil ? row.snooze_prompt ?? undefined : undefined,
    pinnedAt: row.pinned_at ?? undefined,
    consolePinnedAt: row.console_pinned_at ?? undefined,
    // The event-snooze, as a fact the CHAT can read. `awaitingBackground` still ignores it — that flag
    // states whether the thread is waiting, which the snooze does not change — so the suppression is a
    // presentation rule the client applies, not a second opinion about the thread's state.
    bgSnoozed: bgSnoozeArmed(row) || undefined,
    // Whether "Until activity" can be offered: see wakesOnItsOwn. False on a dead worker and on an archived
    // thread, which nothing wakes.
    wakesOnItsOwn: (!archived && runtime !== "exited" && wakesOnItsOwn(row, tele, registeredPrWatches, armedTimerIds)) || undefined,
    // Only where the handoff is what queued it: the park would otherwise have held (QueuedBy).
    heldHandoff: queuedBy.heldHandoff || undefined,
    claudeRuntime: row.claude_runtime === "broker" ? "broker" as const : undefined,
    // The recurring prompt — the same projection the worker's own `action: "get"` reads back.
    recurringPrompt: resolveRecurringPrompt(row),
    needsYou,
    awaitingBackground,
    waitStatus,
    crashed,
    pendingInteraction: interactionPresence.pending,
    actionableInteraction: interactionPresence.needsUser,
    // Preserve only a durable, canonical backend identity. In particular, Claude is not inferred
    // from today's dispatch preference: unknown/migrated rows remain unmarked, while rows whose
    // database default was explicitly normalized to "claude" get the same per-thread identity as
    // Codex rows.
    backend: row.backend === "claude" || row.backend === "codex" || row.backend === "acp" ? row.backend : undefined,
    // Only a persisted, validated per-session value is exposed. A migrated row stays visibly unknown;
    // never label it with today's global defaults (which may not match its running process).
    permissionMode,
    permissionPending,
    permissionChangePending: row.permission_pending !== null && row.permission_pending !== undefined,
    permPolicy: tele?.permPolicy,
    permDenies: tele?.permDenies,
    profilePendingModel: row.profile_pending_model?.trim() || undefined,
    profilePendingEffort: row.profile_pending_effort?.trim() || undefined,
    profileChangePending:
      row.profile_pending_model !== null && row.profile_pending_model !== undefined ||
      row.profile_pending_effort !== null && row.profile_pending_effort !== undefined,
    runtimeControlPending: row.runtime_control !== null && row.runtime_control !== undefined,
    controlError: row.control_error?.trim() || undefined,
    // Session profile resolved from backend-observed transcript truth first, then pinned launch
    // metadata (which supplies immediate/pre-response values and Claude's unrecorded effort). Never
    // fall back to current Settings; when both durable sources are silent the readout is omitted.
    model: profile.model,
    effort: profile.effort,
    runningModelLabel: edition?.running.label,
    // `staged` reads the daemon's liveness off the same record headlessStalled does: with no live worker,
    // the next turn forks from the current pin and so starts on the newer edition by itself.
    modelUpgrade: edition?.newer && isBrokerClaudeRow(row) ? { label: edition.newer.label, staged: headlessStalled } : undefined,
    // Context fullness. Emitted only when the provider has given BOTH halves — a fraction with a
    // guessed denominator is a fabricated reading, and the client's contract is that absence means no
    // dial rather than an empty one. A Claude row therefore carries no `context` until its first turn
    // has ended; codex carries one from its first token_count.
    //
    // The denominator is the window this session RUNS IN, not the model's size: a Claude worker's
    // auto-compact ceiling has already lowered it upstream (FoldState.contextWindow). Nothing to do
    // here — noted because "of 1,000,000" on a thread that compacts at 500K is exactly the reading
    // that made this wrong, and re-deriving the denominator at this layer would bring it back.
    context: tele?.contextTokens !== undefined && tele?.contextWindow !== undefined && tele.contextWindow > 0
      ? { tokens: tele.contextTokens, window: tele.contextWindow }
      : undefined,
  }
}

// An EXTERNAL session: a transcript the tailer found in the project's agent log dir with no registry
// row behind it — the maintainer's own `claude`/`codex` terminal. Read-only by construction, and
// deliberately THIN: everything a registered row derives from its row (lifecycle state, needs-you,
// snooze, watches, delivery, permission/profile intent) has no source here, and inventing one would be
// a fabricated reading rather than a missing field.
//
// WHAT IS HONEST TO SHOW, measured against three real terminal transcripts through this same tailer
// (2026-08-19): `aiTitle` — Claude titles its own sessions, so these rows carry real names; the rest
// instants; the last assistant line as the preview; the profile chips and the context dial. What is
// structurally ABSENT is `lastFence`: fences come from the worker contract frizz injects at dispatch,
// so a terminal session never writes one. That single absence is why HELD and DONE cannot be derived
// for these rows at all — a park is a fence/timer/snooze and an archive is a human's lifecycle write —
// and why they get their own band instead of being sorted into frizz's.
function foreignThreadView(sessionId: string, tele: SessionTelemetry, backend: "claude" | "codex"): ThreadView {
  return {
    id: sessionId,
    // THE HARNESS'S OWN NAME FIRST, then the conversation's opening turn — which is exactly the order
    // both agents' own resume pickers use, verified by driving each of them 2026-08-24.
    //   • Claude records `ai-title` in the transcript, and does it reliably: 39 of 40 real terminal
    //     transcripts on this machine carried one. The tailer folds it like any other record.
    //   • Codex records nothing in the rollout. Its name lives in `session_index.jsonl`, which the
    //     tailer reads and assigns onto the same field — but that sidecar covered only 4 of the 319
    //     rollouts written here in 30 days, so the fallback is the common case for codex, not the
    //     exception.
    // The FIRST user turn is that fallback, chopped by the same `fallbackTitle` a dispatch uses before
    // its worker names itself — so an external row reads like every other row rather than like a raw
    // prompt. It must be the FIRST turn and not the newest: a session's name is what it was opened to
    // do. The short id survives only for a transcript with no human turn in it at all.
    // Never the frizz "Spinning up…" placeholder, which promises a title that is on its way; for a
    // session frizz did not dispatch, nothing is on its way.
    title: tele.aiTitle ?? (tele.firstUserText ? fallbackTitle(tele.firstUserText) : undefined) ?? `Session ${sessionId.slice(0, 8)}`,
    aiTitle: tele.aiTitle,
    // A harness-given name is a real name; a chop of the opening prompt is a machine guess, and the
    // rail dims a guess. Neither is provisional in the "spinning up" sense — see the title above.
    titleAuto: tele.aiTitle === undefined,
    status: "active", // synthesized: required by the shape, UNUSED for session rows (see sessionThreadView)
    hasPlan: false,
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    // Only RESTED sessions are emitted (see buildForeignThreads), so this is the one truthful value.
    runtime: "turn-idle",
    sessionId,
    unread: false,
    archived: false,
    lastAssistant: tele.lastAssistant,
    lastAssistantLine: tele.lastAssistantLine,
    lastActivityAt: tele.lastActivityAt,
    lastAssistantAt: tele.lastAssistantAt,
    lastUserAt: tele.lastUserAt,
    // Deliberately EMPTY rather than passed through. The tailer does derive a foreign session's
    // sub-agents and shells, but every rendering of them is a control surface (drill in, stop) that a
    // row with no runtime cannot honour — and a rested session's children have finished anyway.
    subAgents: [],
    bgShells: [],
    watches: [],
    // Passed through: an unanswered native ask is a real, transcript-derived fact, and the client
    // renders it read-only with "answer in the terminal" for a foreign row. It never queues here —
    // the interaction surface is the terminal the human is already sitting in (groups.ts).
    pendingAsk: tele.pendingAsk ? { questions: tele.pendingAsk.questions } : undefined,
    // ALWAYS false, and not for want of trying: this is `at rest with an unanswered ```question fence`,
    // and a session frizz did not dispatch has no fence to read.
    pendingQuestion: false,
    questions: [],
    kind: "session",
    foreign: true,
    providerError: tele.providerError,
    needsYou: false,
    awaitingBackground: false,
    crashed: false,
    backend,
    permissionMode: tele.permissionMode,
    model: tele.model,
    effort: tele.effort,
    context: tele.contextTokens !== undefined && tele.contextWindow !== undefined && tele.contextWindow > 0
      ? { tokens: tele.contextTokens, window: tele.contextWindow }
      : undefined,
  }
}

// ---- the archived-view memo (2026-10-14) ----------------------------------------------------------------
// Every refresh used to derive every thread's view from scratch, and a board is mostly HISTORY: on a
// seeded 5,000-thread board (4,995 archived) one refresh after one write cost ~260ms of blocked event
// loop, and every router mutation ends in one. An archived thread's view almost never changes, so the
// board keeps the last one it derived, with everything it was derived from, and hands back the SAME
// object while all of it is unchanged. Identity is the whole comparison: the storage keeps an unchanged
// row and an unchanged registry bucket the same object (change-tracking.ts), the tailer does the same
// for unchanged telemetry (tailer.ts telemetryMemo), and the differ skips serializing a view it has
// already serialized (shared BoardDiffer).
//
// ONLY ARCHIVED THREADS, AND ONLY ONES WHOSE VIEW CANNOT MOVE WITH THE CLOCK. sessionThreadView reads
// `nowMs` in nine places. For an archived thread six of them are dead (needs-you, delivery, wait status,
// awaiting-background and the answer-in-flight excusal are all forced off by `archived`), and the other
// three are excluded here outright rather than modelled: a codex app-server row (its stall grace counts
// from the clock), a row with a snooze instant (futureSnooze compares it to now), and telemetry carrying
// a usage-limit fault (whether its auto-resume is stale is a clock question). fenceWatchViews also falls
// back to the wall clock for a parked fence with no instant; that row is excluded too. An open thread is
// never memoized: the queue's rules are where time lives, and there are only a handful of them.
//
// Everything else the derivation reads is a key below. If sessionThreadView ever reads a new input,
// it has to be added here or the thread excluded — the golden test in board.memo.test.ts compares a
// warm board against a cold one over the same state and is the net for exactly that.
interface ArchivedViewInputs {
  row: SessionRow
  tele: SessionTelemetry | undefined
  legacyTerminal: boolean
  presence: { pending: boolean; needsUser: boolean }
  brokerAlive: boolean | undefined
  // The broker record listing this session was ABSENT from when brokerAlive was read (so it read
  // false with nothing to read). While the build's listing is that same object, the session is still
  // absent and still not alive — exact, and it spares the per-thread probe. Undefined otherwise.
  absentFrom: ReadonlySet<string> | undefined
  links: readonly ThreadLinkRow[] | undefined
  prWatches: readonly PrWatchRow[] | undefined
  timers: readonly ThreadTimerRow[] | undefined
  commandWatches: readonly CommandWatchRow[] | undefined
  questions: readonly ThreadQuestionRow[] | undefined
  watches: readonly ThreadWatchRow[] | undefined
  done: { readonly body: string; readonly doneAt: number } | undefined
  // The registries (all seven maps, by identity) the buckets above were last confirmed against. While
  // the build's registries are that same object, no bucket can have moved, and none is looked up.
  confirmedIn: ThreadRegistries
  github: GithubStatusBook
  issueBook: GithubIssueStatusBook
  catalogue: readonly ClaudeModel[] | undefined
  faults: readonly QuestionFenceFault[] | undefined
}

function archivedViewInputs(
  row: SessionRow,
  tele: SessionTelemetry | undefined,
  legacyTerminal: boolean,
  presence: { pending: boolean; needsUser: boolean },
  brokerAlive: ClaudeBrokerLivenessSnapshot,
  registries: ThreadRegistries,
  github: GithubStatusBook,
  issueBook: GithubIssueStatusBook,
  catalogue: readonly ClaudeModel[] | undefined,
  faults: readonly QuestionFenceFault[] | undefined,
): ArchivedViewInputs | undefined {
  if (effectiveSessionState(row, legacyTerminal) !== "archived") return undefined
  if (row.codex_runtime === "app-server") return undefined
  if (row.snoozed_until !== null && row.snoozed_until !== undefined) return undefined
  if (tele?.limitFault) return undefined
  if (tele?.lastFence?.kind === "awaiting" && !tele.lastAssistantAt) return undefined
  const slug = row.slug
  // The one external fact the derivation reads for a non-codex row (headlessStalled).
  const broker = isBrokerClaudeRow(row)
  const absent = broker && brokerAlive.listing !== undefined && brokerAlive.listed?.(row.session_id) === false
  return {
    row,
    tele,
    legacyTerminal,
    presence,
    brokerAlive: broker ? (absent ? false : brokerAlive(row.session_id)) : undefined,
    absentFrom: absent ? brokerAlive.listing : undefined,
    links: registries.links.get(slug),
    prWatches: registries.prWatches.get(slug),
    timers: registries.timers.get(slug),
    commandWatches: registries.commandWatches.get(slug),
    questions: registries.questions.get(slug),
    watches: registries.watches.get(slug),
    done: registries.done.get(slug),
    confirmedIn: registries,
    github,
    issueBook,
    catalogue,
    faults,
  }
}

// Whether a stored memo's inputs are this build's inputs, compared in place so a hit allocates nothing.
// The two inputs not already in hand — the registry buckets and broker liveness — are only looked up
// when the build-wide object they were confirmed against has changed; a successful look re-confirms.
function memoStillHolds(
  m: ArchivedViewInputs,
  row: SessionRow,
  tele: SessionTelemetry | undefined,
  legacyTerminal: boolean,
  presence: { pending: boolean; needsUser: boolean },
  brokerAlive: ClaudeBrokerLivenessSnapshot,
  registries: ThreadRegistries,
  github: GithubStatusBook,
  issueBook: GithubIssueStatusBook,
  catalogue: readonly ClaudeModel[] | undefined,
  faults: readonly QuestionFenceFault[] | undefined,
): boolean {
  if (
    m.row !== row ||
    m.tele !== tele ||
    m.legacyTerminal !== legacyTerminal ||
    m.presence !== presence ||
    m.github !== github ||
    m.issueBook !== issueBook ||
    m.catalogue !== catalogue ||
    m.faults !== faults
  ) return false
  if (m.confirmedIn !== registries) {
    const slug = row.slug
    if (
      m.links !== registries.links.get(slug) ||
      m.prWatches !== registries.prWatches.get(slug) ||
      m.timers !== registries.timers.get(slug) ||
      m.commandWatches !== registries.commandWatches.get(slug) ||
      m.questions !== registries.questions.get(slug) ||
      m.watches !== registries.watches.get(slug) ||
      m.done !== registries.done.get(slug)
    ) return false
    m.confirmedIn = registries
  }
  if (m.brokerAlive === undefined) return true // not a broker row (row identity covers that it still is not)
  if (m.absentFrom !== undefined && m.absentFrom === brokerAlive.listing) return true
  const absent = brokerAlive.listing !== undefined && brokerAlive.listed?.(row.session_id) === false
  const alive = absent ? false : brokerAlive(row.session_id)
  if (alive !== m.brokerAlive) return false
  m.absentFrom = absent ? brokerAlive.listing : undefined
  return true
}

// A setting read once per distinct VALUE: the same stored value hands back the same parsed object.
// `getSetting` returns freshly parsed JSON every call, so the value is keyed by its serialization —
// a few hundred bytes for the PR books, against re-validating them and losing their identity per build.
function parsedSetting<T>(parse: (raw: unknown) => T): { read(raw: unknown): T } {
  let lastKey: string | undefined
  let last: { value: T } | undefined
  return {
    read(raw) {
      const key = JSON.stringify(raw) ?? ""
      if (last && key === lastKey) return last.value
      last = { value: parse(raw) }
      lastKey = key
      return last.value
    },
  }
}

// THE RECENT DELTAS, so a socket can resume a client from the seq of the board it read over HTTP
// instead of streaming it the whole board (app-socket.ts, the board channel). The ring has to cover two
// gaps: the one between a page's HTTP read and its socket's resume (a few hundred ms, so a handful of
// deltas even with workers streaming), and a short reconnect. A streaming worker publishes about 2.3
// deltas a second (15 over a 6.5s scripted turn, 2026-10-14), so 512 deltas is a minute or more of
// several workers at once; past that, or across a boot, the client reads the board over HTTP again,
// which is always correct and only slower. Bounded by count and by the thread views the entries hold
// (each upsert is a whole ThreadView, ~3KB): a delta that touched every thread — the first build after
// boot — is kept alone at most, and evicted by the next one.
export const RECENT_DELTAS = 512
export const RECENT_DELTA_THREADS = 2048

export class DeltaRing {
  private recent: BoardDelta[] = []
  private threads = 0
  constructor(
    // The seq of the last delta published, which the ring's newest entry must carry.
    private readonly currentSeq: () => number,
    private readonly maxDeltas = RECENT_DELTAS,
    private readonly maxThreads = RECENT_DELTA_THREADS,
  ) {}

  // Every delta, in publish order. A seq that does not follow the newest one (it never happens: the
  // differ counts by one) empties the ring first, so what it holds is always one contiguous run.
  remember(event: BoardDelta): void {
    const last = this.recent.at(-1)
    if (last && event.seq !== last.seq + 1) {
      this.recent = []
      this.threads = 0
    }
    this.recent.push(event)
    this.threads += event.upserts.length
    while (this.recent.length > this.maxDeltas || (this.threads > this.maxThreads && this.recent.length > 1)) {
      this.threads -= this.recent.shift()!.upserts.length
    }
  }

  // The deltas after `seq`, oldest first; [] when `seq` is current. null when they cannot all be
  // produced: `seq` is older than the ring, or newer than anything published.
  since(seq: number): BoardDelta[] | null {
    const current = this.currentSeq()
    if (!Number.isInteger(seq) || seq < 0 || seq > current) return null
    if (seq === current) return []
    const first = this.recent[0]
    const last = this.recent.at(-1)
    if (!first || !last || last.seq !== current || first.seq > seq + 1) return null
    return this.recent.slice(seq + 1 - first.seq)
  }

  get size(): number {
    return this.recent.length
  }
}

export interface BoardManager {
  snapshot(): Promise<BoardSnapshot>
  // The seq the current snapshot corresponds to — the value a connect keyframe must advertise so the
  // client can adopt it and then apply deltas seq+1, seq+2 … (see the /events handler). Read
  // synchronously right after snapshot() so the two are consistent.
  currentSeq(): number
  // The board and the seq it reflects, read in ONE synchronous step (no await between them), so a
  // refresh that lands in a microtask between two reads can never hand a client a board one delta
  // older or newer than the seq it then resumes from. What the `boardState` query serves.
  snapshotState(): Promise<{ board: BoardSnapshot; seq: number }>
  // The deltas published after `seq`, oldest first, from the bounded ring of recent ones; [] when `seq`
  // is current. null when they cannot all be produced — `seq` is older than the ring, or newer than
  // anything published — and the caller must then read the board whole.
  deltasSince(seq: number): BoardDelta[] | null
  // Full: revalidates registered-file migration state.
  rebuild(): Promise<BoardSnapshot>
  // Overlay-only: reuses file-backed caches; cheap + sync. Use for tailer/session changes.
  refresh(): BoardSnapshot
  // A durable typed-interaction transition changes queue membership independently of transcript or
  // .frizz files. The board caches per-session presence and refreshes on the journal's post-commit edge.
  interactionChanged?(change: InteractionChange): void
  start(): Promise<void>
  stop(): Promise<void>
}

// Reads the codex app-server bridge's turn-liveness authority for one thread; undefined for a thread
// the bridge does not own (and for every non-codex row). Injected rather than imported so the board
// keeps no dependency on the bridge — and so a context without one (tests, a bridge-less server)
// simply never downgrades.
export type CodexTurnLivenessReader = (
  slug: string,
  sessionId: string,
) => { bridgeTurn: boolean; ownedSince: string; providerError?: ProviderError } | undefined

// Whether a broker-Claude session's ownerless daemon is running right now — the headless-stall signal
// for a broker row (its parallel of codexTurnLiveness). Absent (tests / bridge-less server) ⇒ assume
// alive, so a healthy broker row is never falsely carded as a crash.
export type ClaudeBrokerLivenessReader = (sessionId: string) => boolean
/** A whole build's liveness (claude-broker-host.ts brokerLivenessSnapshot): the reader plus the record
 *  listing it answers from, the same object while the record directory is unchanged. */
export type ClaudeBrokerLivenessSnapshot = ClaudeBrokerLivenessReader & {
  readonly listing?: ReadonlySet<string>
  listed?(sessionId: string): boolean
}

export interface BoardManagerDeps {
  subscribe?: typeof watcher.subscribe
  now?: () => number
  codexTurnLiveness?: CodexTurnLivenessReader
  claudeBrokerDaemonAlive?: ClaudeBrokerLivenessReader
  /** The same answer for a whole build: called once per assemble, it returns a reader backed by one
   *  snapshot of the broker's record directory (claude-broker-host.ts brokerLivenessSnapshot), so a
   *  board of history does not pay a failed file read per archived thread. Preferred when present. */
  claudeBrokerLiveness?: () => ClaudeBrokerLivenessSnapshot
  /** The pinned Claude runtime's resolved catalogue, read synchronously per build (peekClaudeModels). */
  claudeModels?: () => readonly ClaudeModel[] | undefined
  /** What a thread's latest question-fence sync refused (question-fences.ts QuestionFaultBook). */
  questionFaults?: (slug: string) => readonly QuestionFenceFault[] | undefined
}

export function createBoard(
  project: Project,
  storage: Storage,
  bus: Bus,
  tailer: Tailer,
  bootId: string,
  deps: BoardManagerDeps = {},
): BoardManager {
  const subscribe = deps.subscribe ?? watcher.subscribe
  const now = deps.now ?? Date.now
  const codexTurnLiveness = deps.codexTurnLiveness ?? (() => undefined)
  const claudeBrokerDaemonAlive = deps.claudeBrokerDaemonAlive ?? (() => true)
  const claudeModels = deps.claudeModels ?? (() => undefined)
  const questionFaults = deps.questionFaults ?? (() => undefined)
  let cached: BoardSnapshot | null = null
  let parcelSub: watcher.AsyncSubscription | null = null
  let watchSetup: Promise<void> | null = null
  let bootstrapWatch: FSWatcher | null = null
  let debounce: NodeJS.Timeout | null = null
  let reconcileTimer: NodeJS.Timeout | null = null
  let snoozeTimer: NodeJS.Timeout | null = null
  let interactionRefreshQueued = false
  let snoozeRefreshQueued = false
  let stopped = false
  let stopPromise: Promise<void> | null = null
  const activeRebuilds = new Set<Promise<BoardSnapshot>>()
  // Pending presence and human actionability, keyed by BOTH slug and current session id. Provider
  // responses remain journal-pending until acknowledgement, but QUEUED/SENT is no longer a human ask:
  // keep its thread card readable while dropping it from Needs You. A replacement session therefore
  // cannot inherit either signal from the prior rollout.
  //
  // Held per SLUG, with the session it was read for: a row whose session moved is read again (the
  // entry is replaced), which is the both-keys rule without building a composite string per thread per
  // build.
  const pendingInteractionCache = new Map<string, { sessionId: string; presence: { pending: boolean; needsUser: boolean } }>()
  // Per-slug "was this SESSION thread in the needs-you queue last build?" — drives the needs-decision
  // notify dedupe: we fire only on a false→true edge, and a thread leaving the queue re-arms it.
  //
  // Only threads that WERE in the queue are held, each stamped with the build that last saw it there:
  // absent reads as "was not", exactly as a stored false did, and a board of history no longer writes
  // one entry per archived thread per build to say so.
  const needsYouPrev = new Map<string, number>()
  let needsYouBuild = 0
  // PRIME GUARD: the first assemble after boot records the baseline WITHOUT notifying, so a post-bounce
  // server doesn't fire a storm for every historical resting thread already in the queue.
  let notifyPrimed = false

  // Fire a needs-decision notify for every registered session that newly enters the queue.
  // Edge-triggered + deduped; primed on the first build.
  function notifyNeedsYou(sessionThreads: ThreadView[]): void {
    const build = ++needsYouBuild
    for (const t of sessionThreads) {
      if (!t.needsYou) continue
      const was = needsYouPrev.has(t.id)
      if (notifyPrimed && !was) {
        bus.publish({ type: "notify", slug: t.id, kind: "needs-decision", title: t.aiTitle || t.title || t.id, body: capLine(t.lastAssistant) })
      }
      needsYouPrev.set(t.id, build)
    }
    // Left the queue, or vanished: either way forgotten, so a return to the queue re-notifies.
    for (const [id, seenIn] of needsYouPrev) if (seenIn !== build) needsYouPrev.delete(id)
    notifyPrimed = true
  }

  // THE RUNNING BAND'S ORDER: when each thread last switched INTO it (maintainer 2026-10-23: "The most
  // recent agent to switch back into the running status should be at the top of running").
  //
  // No single transcript event is that switch. A thread enters the band on a human reply, on a wake
  // Frizz delivers, on a sub-agent's report waking a parked thread, on a fresh dispatch — and stays in
  // it across a `working` rest, a mid-turn message or a child returning. The band itself is the one
  // thing that knows, so the board watches it: the first build that finds a thread in the band
  // (shared activeBandThreadAt, the same predicate the rail counts with) stamps the build's instant, and
  // the first that finds it outside clears it. The column is the memory of which threads were in the
  // band, so the comparison needs no state of its own and a restart keeps the order.
  //
  // The row is written and the view replaced together, so this build already ships the stamp; the next
  // build reads it off the row. A write happens only on a band edge, which is a handful per turn.
  //
  // A thread found in the band with no stamp on the first build after boot entered it while the server
  // was down, or before the column existed. It takes its newest user turn (or its dispatch) instead of
  // the boot instant, which is the order the band used before, rather than a tie for every such row.
  let runningPrimed = false
  function stampRunningSince(threads: ThreadView[], assembledAtMs: number): void {
    const at = new Date(assembledAtMs).toISOString()
    for (let i = 0; i < threads.length; i++) {
      const t = threads[i]!
      const stamped = t.runningSince !== undefined
      // A queued thread is never in the band (inActiveBand), and that is most of a board's live rows.
      const inBand = t.needsYou === true ? false : activeBandThreadAt(t, assembledAtMs)
      if (inBand === stamped) continue
      const since = inBand ? (runningPrimed ? at : enteredBeforeBoot(t) ?? at) : null
      storage.setRunningSince(t.id, since)
      threads[i] = { ...t, runningSince: since ?? undefined }
    }
    runningPrimed = true
  }

  // The file-backed migration cache is recomputed only on a full rebuild (the `.frizz` watcher catches
  // changes to the top-level `<slug>.md` files this reads, and only those — see
  // isBoardRelevantFrizzPath). Overlay-only refreshes remain filesystem-free.
  let legacyTerminalCache = new Set<string>()

  // Per-row-object slug validity (see buildSessionThreads), and the parsed GitHub books by the raw
  // setting they were parsed from.
  const rowValidity = new WeakMap<SessionRow, boolean>()
  const validRow = (row: SessionRow): boolean => {
    let valid = rowValidity.get(row)
    if (valid === undefined) {
      valid = ThreadSlug.safeParse(row.slug).success
      rowValidity.set(row, valid)
    }
    return valid
  }
  let validRowsOf: { all: readonly SessionRow[] | undefined; valid: SessionRow[] } = { all: undefined, valid: [] }
  let lastRegistries: ThreadRegistries | undefined
  const githubBook = parsedSetting(readGithubStatusBook)
  const issueStatusBook = parsedSetting(readGithubIssueStatusBook)
  // The last view derived for each ARCHIVED thread, with everything it was derived from.
  const archivedViews = new Map<string, { inputs: ArchivedViewInputs; view: ThreadView }>()

  // Build exactly the session-backed threads recorded by Frizz. The registry is the provenance
  // boundary: historical rows remain valid after migration/restart, and both Claude and Codex use the
  // same durable shape. Raw tailer discoveries never confer ownership.
  function buildSessionThreads(nowMs: number): ThreadView[] {
    // Old/corrupt databases predate the canonical storage guard. Keep such rows inert instead of
    // emitting an invalid board id or allowing it to reach tailer/dispatch consumers. Asked once per
    // row OBJECT: the storage hands back the same object for a row that did not change, and a schema
    // parse per row per build was 5% of a refresh on a 5,000-thread board.
    const all = storage.allSessions()
    if (all !== validRowsOf.all) validRowsOf = { all, valid: all.filter(validRow) }
    const rows = validRowsOf.valid
    // ONE READ PER BUILD, not per thread: the watched-PR book is keyed by ref and shared by every thread
    // watching that PR, and it is parsed on the way in — once per distinct setting value, so an unchanged
    // book is the same object build to build (the archived-view memo keys on it).
    const github = githubBook.read(storage.getSetting(GITHUB_STATUS_SETTING))
    const issueBook = issueStatusBook.read(storage.getSetting(GITHUB_ISSUE_STATUS_SETTING))
    // The same rule, applied to the five per-thread registries: five statements for the whole project
    // instead of five per row. On the maintainer's 558-thread board that is 2,794 statements per
    // rebuild down to 9, all of it on the event loop — see ThreadRegistries.
    const registries = lastRegistries = readThreadRegistries(storage, lastRegistries)
    const brokerAlive: ClaudeBrokerLivenessSnapshot = deps.claudeBrokerLiveness?.() ?? claudeBrokerDaemonAlive
    const catalogue = claudeModels()
    const out: ThreadView[] = []
    for (const row of rows) {
      const cachedPresence = pendingInteractionCache.get(row.slug)
      let interactionPresence = cachedPresence?.sessionId === row.session_id ? cachedPresence.presence : undefined
      if (interactionPresence === undefined) {
        try {
          const scope = {
            projectId: project.id,
            threadSlug: row.slug,
            sessionId: row.session_id,
          }
          const pending = storage.interactions.listPending(scope)
          interactionPresence = {
            pending: pending.length > 0,
            needsUser: pending.some((interaction) => {
              const delivery = storage.interactions.providerDelivery(scope, interaction.id)
              return !delivery || (delivery.state !== "queued" && delivery.state !== "sent")
            }),
          }
        } catch {
          // Fail visible. A corrupt/unreadable journal must not silently hide a request that may hold
          // provider authority; the queue card will surface the scoped RPC error instead.
          interactionPresence = { pending: true, needsUser: true }
        }
        pendingInteractionCache.set(row.slug, { sessionId: row.session_id, presence: interactionPresence })
      }
      const tele = tailer.get(row.slug, row)
      const legacyTerminal = legacyTerminalCache.has(row.slug)
      const faults = questionFaults(row.slug)
      // THE ARCHIVED-VIEW MEMO. See ArchivedViewInputs for what a memoized view is keyed on and why a
      // thread outside it is always derived afresh. A memo is only ever stored for an eligible thread,
      // so identical inputs are an eligible thread: the hit path is identity checks and nothing else.
      const memo = archivedViews.get(row.slug)
      if (memo && memoStillHolds(memo.inputs, row, tele, legacyTerminal, interactionPresence, brokerAlive, registries, github, issueBook, catalogue, faults)) {
        out.push(memo.view)
        continue
      }
      const inputs = archivedViewInputs(row, tele, legacyTerminal, interactionPresence, brokerAlive, registries, github, issueBook, catalogue, faults)
      const view = sessionThreadView(
        project.dir,
        storage,
        row,
        tele,
        legacyTerminal,
        interactionPresence,
        nowMs,
        codexTurnLiveness,
        brokerAlive,
        registries,
        github,
        issueBook,
        catalogue,
        faults,
      )
      if (inputs) archivedViews.set(row.slug, { inputs, view })
      else archivedViews.delete(row.slug)
      out.push(view)
    }
    // Forget threads that are gone. Only a slug that left the registry can leave an entry behind (a
    // moved session replaces its slug's entry above), so there is nothing to sweep unless a cache holds
    // more slugs than the registry does.
    if (pendingInteractionCache.size > rows.length || archivedViews.size > rows.length) {
      const present = new Set(rows.map((row) => row.slug))
      for (const slug of pendingInteractionCache.keys()) if (!present.has(slug)) pendingInteractionCache.delete(slug)
      for (const slug of archivedViews.keys()) if (!present.has(slug)) archivedViews.delete(slug)
    }
    return out
  }

  // The project's EXTERNAL sessions: transcripts the tailer discovered with no registry row behind
  // them. They are their own rail band, never part of the registered set — see foreignThreadView for
  // why they cannot be sorted into frizz's own bands at all.
  //
  // RESTED ONLY, by explicit decision (maintainer 2026-08-19): "if something is currently running,
  // then presumably the user already has that open in Claude Code." A spinning terminal session is one
  // the human is watching in the window it belongs to, so listing it here is noise at best and an
  // invitation to double-drive one transcript at worst. `turn === "idle"` is the tailer's own rest
  // reading and is the SAME derivation a registered row's rest uses, so the two can never disagree.
  //
  // The tailer already bounds this set (a 24h freshness window and a cap of 20, newest first), so
  // there is no second cap here — one would only be able to disagree with that one.
  function buildForeignThreads(): ThreadView[] {
    const out: ThreadView[] = []
    for (const id of tailer.foreignIds()) {
      // A discovered id is a session id, and a session id satisfies the slug contract (lowercase hex +
      // hyphens). Checked anyway: the id comes off a FILENAME, and an invalid board id must never ship.
      if (!ThreadSlug.safeParse(id).success) continue
      const tele = tailer.get(id)
      if (!tele || tele.turn !== "idle") continue
      // Absent (an older tailer, or a narrow fixture) reads as claude — what every foreign thread was
      // before codex rollouts joined the scan.
      out.push(foreignThreadView(id, tele, tailer.foreignBackend?.(id) ?? "claude"))
    }
    return out
  }

  // Assemble a snapshot from registered sessions + external sessions. Unregistered legacy files are
  // excluded before any legacy parser is invoked, so they cannot contribute a row, queue card,
  // warning, or error. `.frizz/` presence is deliberately NOT reported: it gates only scratchpad
  // storage (probed locally where that matters), never whether this project has a board.
  function assemble(): BoardSnapshot {
    // One clock sample owns every snooze decision in this snapshot: expiry clearing, visibility,
    // needs-you derivation, and timer selection cannot disagree at a deadline boundary.
    const assembledAtMs = now()
    // Canonical UTC strings sort chronologically, so one indexed write clears every elapsed snooze.
    // This runs on every edge-triggered refresh as well as the level-triggered reconcile.
    storage.clearExpiredSnoozes(new Date(assembledAtMs).toISOString())
    // The URL slug comes from the machine-wide registry, not from `project` — the same lookup every
    // other link goes through, so the board can never name itself differently from the rail.
    const base = {
      projectDir: project.dir,
      projectName: project.name,
      projectLabel: project.label,
      ...(project.githubRepo ? { githubRepo: project.githubRepo } : {}),
      projectSlug: findByPath(project.dir)?.slug,
      // So the client can expand a `~` a worker wrote in prose (see BoardSnapshot.homeDir).
      homeDir: homedir(),
    }
    const sessionThreads = buildSessionThreads(assembledAtMs)
    stampRunningSince(sessionThreads, assembledAtMs)
    // REGISTERED ROWS ONLY reach these two, and that is the point rather than an oversight. A snooze
    // is a durable column on a row a foreign session does not have, and a needs-decision notification
    // is frizz telling you a WORKER is waiting on you — a terminal session is waiting on you in the
    // window you opened it in, and pushing a notification for it would be frizz claiming an ask it
    // neither received nor can answer.
    armSnoozeWake(sessionThreads, assembledAtMs)
    notifyNeedsYou(sessionThreads)
    return {
      ...base,
      threads: [...sessionThreads, ...buildForeignThreads()],
      errors: [],
      warnings: [],
      errorItems: [],
    }
  }

  // Schedule the exact next user-snooze deadline instead of relying on the 15s reconciliation ceiling.
  // Long waits are chunked at Node's safe timeout limit; restart re-arms from the durable DB value.
  function queueSnoozeRefresh(): void {
    if (snoozeRefreshQueued) return
    snoozeRefreshQueued = true
    queueMicrotask(() => {
      snoozeRefreshQueued = false
      if (stopped) return
      refresh()
    })
  }

  function armSnoozeWake(threads: readonly ThreadView[], assembledAtMs: number): void {
    if (snoozeTimer) clearTimeout(snoozeTimer)
    snoozeTimer = null
    if (stopped) return
    let next = Infinity
    for (const thread of threads) {
      if (!thread.snoozedUntil) continue
      const at = Date.parse(thread.snoozedUntil)
      if (Number.isFinite(at) && at > assembledAtMs) next = Math.min(next, at)
    }
    if (!Number.isFinite(next)) return
    // Assembly can take long enough to cross the selected deadline. Rebuild immediately in that case
    // instead of dropping the now-due deadline and waiting for the 15s reconcile sweep.
    const schedulingNowMs = now()
    if (next <= schedulingNowMs) {
      queueSnoozeRefresh()
      return
    }
    const delay = Math.max(1, Math.min(next - schedulingNowMs + 1, 2_147_000_000))
    snoozeTimer = setTimeout(() => {
      snoozeTimer = null
      if (!stopped) queueSnoozeRefresh()
    }, delay)
    snoozeTimer.unref?.()
  }

  function recomputeLegacyTerminalState(): void {
    legacyTerminalCache = new Set(
      storage.allSessions()
        // Auto-titled UI rows are session-first authority: a matching legacy filename is untrusted and
        // must not even be opened. Only a non-auto historical row can use the narrow terminal-status
        // migration bridge while its explicit lifecycle state is still absent.
        .filter((row) => row.state == null && row.archived !== 1 && row.title_auto !== 1 && registeredLegacyFileIsTerminal(project.dir, row.slug))
        .map((row) => row.slug),
    )
  }

  // Publish only what CHANGED. The differ holds the last-broadcast per-thread JSON; on each snapshot it
  // returns just the changed/added/removed threads (+ board-level meta when it moved), or null when
  // nothing moved — which is the dedupe that keeps the 1s tailer tick and 15s reconcile from streaming
  // identical multi-hundred-KB frames. A one-thread status change now ships ONE ThreadView, not 310KB.
  // Clients get the full board as their connect keyframe (see the /events handler), then these deltas.
  const differ = new BoardDiffer()
  function publish(snapshot: BoardSnapshot): void {
    const d = differ.diff(snapshot)
    if (!d) return
    const event: BoardDelta = { type: "board-delta", seq: d.seq, bootId, upserts: d.upserts, removed: d.removed, ...(d.meta ? { meta: d.meta } : {}) }
    remember(event)
    bus.publish(event)
  }

  // The recent deltas, so a socket can resume a client from the board it read over HTTP (DeltaRing).
  const recent = new DeltaRing(() => differ.currentSeq())
  const remember = (event: BoardDelta) => recent.remember(event)
  const deltasSince = (seq: number) => recent.since(seq)

  // FULL rebuild: recompute registered-file migration metadata, then assemble.
  async function rebuildOnce(): Promise<BoardSnapshot> {
    if (stopped) throw new ProducerStoppedError("board")
    // One indexed expiry sweep per level-triggered reconcile keeps queue membership truthful even
    // with no browser mounted. Any transitions publish normal journal invalidations.
    storage.interactions.expireDue()
    recomputeLegacyTerminalState()
    cached = assemble()
    publish(cached)
    return cached
  }

  function rebuild(): Promise<BoardSnapshot> {
    if (stopped) return Promise.reject(new ProducerStoppedError("board"))
    const task = rebuildOnce()
    activeRebuilds.add(task)
    task.then(
      () => activeRebuilds.delete(task),
      () => activeRebuilds.delete(task),
    )
    return task
  }

  // OVERLAY-ONLY rebuild: reuse the cached frizz data. For tailer/session-registry changes.
  function refresh(): BoardSnapshot {
    if (stopped) throw new ProducerStoppedError("board")
    cached = assemble()
    publish(cached)
    return cached
  }

  function interactionChanged(change: InteractionChange): void {
    if (stopped) return
    // Delivery-only transitions keep lifecycle/revision unchanged, so always evict and re-read the
    // durable join. This prevents awaiting→queued→sent→acknowledged from oscillating the queue based on
    // whichever layer happened to notify last.
    if (pendingInteractionCache.get(change.threadSlug)?.sessionId === change.sessionId) pendingInteractionCache.delete(change.threadSlug)
    // Store observers may fire from within a surrounding SQLite transaction or while listPending is
    // expiring records during assembly. Defer and coalesce the refresh to avoid re-entrant builds.
    if (interactionRefreshQueued) return
    interactionRefreshQueued = true
    queueMicrotask(() => {
      interactionRefreshQueued = false
      if (stopped) return
      refresh()
    })
  }

  function scheduleRebuild() {
    if (stopped) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => void rebuild().catch(() => {}), DEBOUNCE_MS)
  }

  function watchFrizzDir(): Promise<void> {
    if (parcelSub || stopped) return Promise.resolve()
    if (watchSetup) return watchSetup
    const setup = (async () => {
      const dir = join(project.dir, ".frizz")
      // @parcel/watcher reports every event under the REALPATH of the watched root rather than the
      // string it was handed: subscribing to `/tmp/x/.frizz` on macOS yields `/private/tmp/x/.frizz/…`
      // (probed 2026-09-04 against the pinned 2.5.6, which is also how the fs-events backend spells its
      // own backfill). Carry both spellings, or a project reached through any symlinked path — every
      // sandbox under /tmp, and plenty of real checkouts — filters to nothing and never rebuilds again.
      const roots = new Set([dir])
      try {
        roots.add(realpathSync(dir))
      } catch {
        // The directory raced away between the existence probe and here. The literal spelling still
        // matches if it comes back, and the level-triggered reconcile covers the gap either way.
      }
      const next = await subscribe(
        dir,
        (err, events) => {
          // An errored callback carries no paths to test, so there is nothing to filter on. Rebuild:
          // this filter is an optimisation and must never be the reason the sidebar goes stale.
          if (err || !events) {
            scheduleRebuild()
            return
          }
          if (events.some((event) => isBoardRelevantFrizzPath(roots, event.path))) scheduleRebuild()
        },
        { ignore: FRIZZ_WATCH_IGNORED_DIRS.map((name) => join(dir, name)) },
      )
      if (stopped) {
        await next.unsubscribe()
        return
      }
      parcelSub = next
    })()
    watchSetup = setup
    void setup.then(
      () => { if (watchSetup === setup) watchSetup = null },
      () => { if (watchSetup === setup) watchSetup = null },
    )
    return setup
  }

  return {
    snapshot: async () => {
      if (stopped) throw new ProducerStoppedError("board")
      return cached ?? (await rebuild())
    },
    currentSeq: () => differ.currentSeq(),
    snapshotState: async () => {
      if (stopped) throw new ProducerStoppedError("board")
      if (!cached) await rebuild()
      // Both read here, in one synchronous step: `cached` and the differ move together inside
      // refresh()/rebuildOnce(), so whatever ran while the rebuild was awaited, this pair agrees.
      return { board: cached!, seq: differ.currentSeq() }
    },
    deltasSince,
    rebuild,
    refresh,
    interactionChanged,
    async start() {
      if (stopped) throw new ProducerStoppedError("board")
      await rebuild()
      if (stopped) return
      // LEVEL-TRIGGERED reconciliation: a periodic full rebuild guarantees convergence even if every
      // edge (watcher event, SSE push, mutation hook) is missed or fails — the UI can lag one period,
      // never forever. Edge-triggered paths above make it feel instant; this makes it CORRECT.
      reconcileTimer = setInterval(() => void rebuild().catch(() => {}), RECONCILE_MS)
      if (frizzDirExists(project.dir)) {
        await watchFrizzDir()
      } else {
        // .frizz/ not created yet — watch the repo root (non-recursive) for its appearance,
        // then hand off to the .frizz watcher. Avoids recursively watching the whole repo.
        try {
          bootstrapWatch = fsWatch(project.dir, (_e, name) => {
            if (name === ".frizz" && frizzDirExists(project.dir)) {
              bootstrapWatch?.close()
              bootstrapWatch = null
              void watchFrizzDir().catch(() => {})
              scheduleRebuild()
            }
          })
        } catch {
          // repo root unwatchable — board still serves on-demand via snapshot()
        }
      }
    },
    stop() {
      if (stopPromise) return stopPromise
      stopped = true
      stopPromise = (async () => {
        if (debounce) clearTimeout(debounce)
        debounce = null
        if (reconcileTimer) clearInterval(reconcileTimer)
        reconcileTimer = null
        if (snoozeTimer) clearTimeout(snoozeTimer)
        snoozeTimer = null
        bootstrapWatch?.close()
        bootstrapWatch = null
        const subscription = parcelSub
        parcelSub = null
        const pendingWatchSetup = watchSetup
        await Promise.all([
          pendingWatchSetup ?? Promise.resolve(),
          subscription?.unsubscribe() ?? Promise.resolve(),
        ])
        // Rebuilds are registry reads only, but still drain them so a replacement generation never
        // publishes a stale delta after shutdown begins.
        await Promise.allSettled([...activeRebuilds])
      })()
      return stopPromise
    },
  }
}
