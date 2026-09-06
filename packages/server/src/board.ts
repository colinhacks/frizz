import {
  existsSync,
  realpathSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import watcher from "@parcel/watcher"
import type { BoardSnapshot, ThreadView, RuntimeState, ThreadRecurringPrompt, ProviderError } from "@frizz/shared"
import { AskedQuestionSchema, BoardDiffer, PermissionMode, SnoozeUntil, ThreadSlug, isDirectSubAgent, questionAnswerMessage, questionsCancelledWakeMessage, type AskedQuestion, type PermissionMode as PermissionModeValue, type QuestionAnswer, type QuestionDismissal } from "@frizz/shared"
import type { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { isHeadlessRow, isBrokerClaudeRow, sessionTitleLocked, type ThreadQuestionRow } from "./storage.ts"
import type { Storage, SessionRow, PrWatchRow, ThreadTimerRow, ThreadWatchRow } from "./storage.ts"
import { normalizeObservedThreadModel } from "./backend/thread-profiles.ts"
import type { Tailer, SessionTelemetry, FenceView } from "./tailer.ts"
import type { InteractionChange } from "./interaction-store.ts"
import { frizzDirExists } from "./frizz.ts"
import { githubStatusKey, parsePrRef, readAwaitingPark, readGithubStatusBook, GITHUB_STATUS_SETTING, type GithubStatusBook } from "./awaiting.ts"
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
    if (permPrompt) return "perm-prompt"
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
const FRIZZ_WATCH_IGNORED_DIRS = ["threads", ".session-state"]

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
// transcript has been quiet past the 15-minute ceiling" — it could equally be a finished child whose
// notification never landed, which is why hasLiveBackgroundWork deliberately counts `running` alone.
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
 *  `mcp__frizz__watch`, which has to answer three questions the fence's integrity check never asks:
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
 *  SPENT BY THE WORKER RECEIVING IT, not by the outbox claiming it. `delivered` is set at ENQUEUE, which
 *  is a whole delivery ahead of the transcript, so keying on it would reopen the same hole a second
 *  wide. The newest USER record is the honest test — frizz's delivery IS one — and it is the same test
 *  `registeredDoneFence` uses for the same reason. A dismissal alone shows nothing: nobody is being
 *  woken for it, so there is no arrival to bridge to — UNLESS `wakeOnDismissals` says one is. On an
 *  AUTONOMOUS thread (a Goal armed on rest — the exact gate evalQuestionAnswers wakes on) the
 *  cancellation wake IS coming, and without this the instant between arming the Goal and that wake
 *  landing was the same hole all over again: the question card gone, nothing in its place, and the
 *  residual "Rested without a sign-off" card claiming a bare rest of a thread that had asked
 *  (maintainer 2026-09-02). The message is the wake's own bytes, exactly as for an answer. */
export function answersInFlight(rows: readonly ThreadQuestionRow[], lastUserAt: string | undefined, wakeOnDismissals = false): string | undefined {
  const userAt = lastUserAt ? Date.parse(lastUserAt) : Number.NaN
  const answers: QuestionAnswer[] = []
  const dismissed: QuestionDismissal[] = []
  for (const q of rows) {
    if (q.settled_at == null) continue
    if (Number.isFinite(userAt) && userAt >= q.settled_at) continue
    if (q.state === "dismissed") {
      const spec = safeQuestionSpec(q.spec)
      if (spec) dismissed.push({ question: spec.question })
      continue
    }
    if (q.state !== "answered") continue
    const parsed = safeQuestionAnswer(q.answer)
    if (parsed) answers.push(parsed)
  }
  if (answers.length > 0) return questionAnswerMessage(answers, dismissed)
  // questionAnswerMessage would compose the same cancellation wake for an empty answers list; calling
  // the producer directly keeps this branch readable as what it is — frizz's own "nobody is coming".
  return wakeOnDismissals && dismissed.length > 0 ? questionsCancelledWakeMessage(dismissed.length) : undefined
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

/** Is the fence parked on a TIMER that is actually armed? The declaration alone is not the wait — a
 *  `timers:` line naming a fired or cancelled row describes a wake that will never come, exactly the
 *  shell-that-died case one branch up — so the hint is checked against the registry, which is the same
 *  set the scheduler's own integrity pass reads (armedTimerIdsOf). */
export function hasParkedTimerWatch(
  tele: SessionTelemetry | undefined,
  armedTimerIds: ReadonlySet<string>,
): boolean {
  // REGISTRATION-FIRST (2026-08-27): with no awaiting fence to check the declaration against, the armed
  // timer IS the wait — the row is what wakes the thread, fence or no fence, and a rest on it drew no
  // card at all while the fence was required (the thread fell through to the bare rest). With a fence,
  // the fence is the worker's statement and it has to name an armed one, as before.
  if (tele?.lastFence?.kind !== "awaiting") return armedTimerIds.size > 0
  return tele.lastFence.hints.some((hint) => hint.kind === "timer" && armedTimerIds.has(hint.value.trim()))
}

/** Does the thread DECLARE a wait of any kind — its own background work, a parked PR watcher, or a
 *  parked timer? This is what the resting card states. It is wider than the queue excusal above by
 *  exactly the PR and timer waits, which card but never park. */
export function hasDeclaredWait(
  tele: SessionTelemetry | undefined,
  nowMs: number,
  armedTimerIds: ReadonlySet<string> = new Set(),
  registeredPrWatches: ReadonlySet<string> = new Set(),
  // This thread's ARMED `thread_watch` rows — the registry a `watch` call writes. Supplied by the caller
  // for the same reason the two sets above are: only it has the storage handle.
  armedWatches: readonly RegisteredWatch[] = [],
): boolean {
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
function heldByRunningChecks(
  tele: SessionTelemetry | undefined,
  github: GithubStatusBook,
  registered: ReadonlySet<string>,
): boolean {
  if (tele?.lastFence?.kind !== "awaiting") return false
  const refs: string[] = []
  for (const hint of tele.lastFence.hints) {
    if (hint.kind !== "pr") continue
    const ref = parsePrRef(hint.value)
    // DECLARED AND REGISTERED, both. The declaration is what says the thread is waiting; the
    // registration is what will actually wake it. A line with no watcher behind it is neither.
    // A PR watcher is keyed by its REF (`owner/repo#N`), not by a minted id — so the ref IS the
    // reference, and it is checkable precisely because the registration is what it is checked against.
    if (ref && registered.has(githubStatusKey(ref))) refs.push(githubStatusKey(ref))
  }
  if (refs.length === 0) return false
  return refs.every((key) => {
    const status = github[key]
    return status?.checks === "running" && status.state === "open"
  })
}

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
 *  alone, so a `prs:` line naming a PR the worker never registered with `mcp__frizz__watch_pr`
 *  counted as a wait: the resting card showed with NOTHING in it (a `prs:` entry adds no watch row of
 *  its own — see fenceWatchViews), the fence card hid itself behind it, and the ref — the one thing the
 *  wait was about — rendered on no surface at all. Membership is by githubStatusKey, so a fence naming
 *  the PR by URL still matches its normalized registration, exactly as unaccountedItems reads it. */
function hasParkedPrWatch(tele: SessionTelemetry | undefined, registered: ReadonlySet<string>): boolean {
  // Registration-first, same as hasParkedTimerWatch: an armed PR watch with no fence is the wait itself.
  if (tele?.lastFence?.kind !== "awaiting") return registered.size > 0
  return tele.lastFence.hints.some((hint) => {
    if (hint.kind !== "pr") return false
    const ref = parsePrRef(hint.value)
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
  /** This thread's REGISTERED PR watchers — `{ target, createdAt }` per armed row. These get a row
   *  whether or not the fence mentions them: a registration is live work the thread has out, and the
   *  strip's job is to list what will actually wake it. The fence's `prs:` entry is a separate
   *  thing — it states a WAIT, and it is checked against this set elsewhere (heldByRunningChecks). */
  registered: readonly { target: string; createdAt: string }[] = [],
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
  for (const w of registered) {
    if (seen.has(`github:${w.target}`)) continue
    seen.add(`github:${w.target}`)
    out.push({
      id: `github:${slug}:${w.target}`,
      kind: "github" as const,
      target: w.target,
      state: "armed" as const,
      createdAt: w.createdAt,
      // Absent until the poller's first successful read. The card says "checking…" then, rather than
      // inventing a verdict — an unpolled PR and a PR with no CI are different facts.
      ...(github[w.target] ? { github: github[w.target] } : {}),
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
// three mean the human's message is handled and in flight. `unconfirmed` is NOT fresh — frizz could not
// confirm that send, so it must stay visible for the human to re-drive.
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
  return parseDeliveryLedger(row.delivery_ledger).some((d) => d.state === "pending" || d.state === "enqueued" || d.state === "delivered")
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
  if (excuseLiveOwnWork && runtime !== "exited" && heldByRunningChecks(tele, github, registeredPrWatches)) return false
  // A TIMER PARK TAKES THE SAME SNOOZE (2026-08-25). It queues like a PR park — a visible handoff, never
  // an auto-park — and since 2026-08-24 it cards like one too, with the resting card's event-Snooze as
  // its one control. But it is not "live own work" (nothing of the thread's is running; the clock is),
  // so it fell straight past this line to the bare-rest handoff below, which never reads the snooze:
  // the click was recorded (bg_snooze_rested_at set), the card stayed in the queue, and the client —
  // reading `bgSnoozed` — un-hid the fence card above the still-showing resting card, so the same wait
  // rendered twice on one queue card (maintainer 2026-08-25: "I already hit the snooze button… but it's
  // still in the queue"). Checked against the registry, not the declaration: a fence naming a fired
  // timer is a bare rest, and a bare rest is not snoozable.
  if (runtime !== "exited" && (hasLiveOwnWork(tele, registeredPrWatches) || hasParkedTimerWatch(tele, armedTimerIds)) && tele?.lastFence?.kind !== "done") return !bgSnoozeArmed(row)
  // A final ```done fence is a CHECKED completion handoff: show its success card in the queue until the
  // human explicitly Archives the thread. Like a question, merely viewing it does not resolve it. The
  // at-rest gate above prevents a stale fence from carding while a follow-up turn is still running.
  if (tele?.lastFence?.kind === "done") return true
  // Bare rest is itself the handoff. It remains queued until the human explicitly sends more work,
  // snoozes it, or archives it; merely opening/seeing the thread cannot silently clear the card.
  return true
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
    !hasParkedTimerWatch(tele, armedTimerIds)
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

// The recurring prompt as BOTH readers see it: the board's footer panel (through the thread view below)
// and the worker's own `mcp__frizz__goal` with `action: "get"` (through the router). One
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
// THE REGISTRY COPY OUTRANKS TELEMETRY, which is the reverse of the rule here until `mcp__frizz__title`
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
  return { kind: "done", body: done.body, hints: [], registered: true }
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
// Batched, the same rebuild issues FIVE statements total. Nothing about the projection changes: each
// batched read carries the identical predicate and ORDER BY as the per-slug one it replaces (see the
// `groupBySlug` note in storage.ts), and a thread with no rows is simply absent from the map, which is
// why every read below spells the fallback `?? []` — the empty array the per-thread call returned.
interface ThreadRegistries {
  prWatches: Map<string, PrWatchRow[]>
  timers: Map<string, ThreadTimerRow[]>
  questions: Map<string, ThreadQuestionRow[]>
  watches: Map<string, ThreadWatchRow[]>
  done: Map<string, { body: string; doneAt: number }>
}

function readThreadRegistries(storage: Storage): ThreadRegistries {
  return {
    prWatches: storage.armedPrWatchesBySlug(),
    timers: storage.armedThreadTimersBySlug(),
    questions: storage.threadQuestionsBySlug(),
    watches: storage.armedThreadWatchesBySlug(),
    done: storage.threadDoneBySlug(),
  }
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
    createdAt: new Date(w.created_at).toISOString(),
  }))
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
  const armedTimerIds = new Set(armedTimers.map((t) => t.id))
  // This thread's ARMED WATCHES on its own running work — the `thread_watch` rows `mcp__frizz__watch`
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
  const questions: ThreadView["questions"] = []
  for (const q of questionRows) {
    if (q.state !== "open") continue
    const spec = safeQuestionSpec(q.spec)
    if (spec) questions.push({ id: q.id, spec, askedAt: new Date(q.asked_at).toISOString() })
  }
  // The dismissal-only case counts as in flight EXACTLY when a cancellation wake is coming — an armed
  // rest Goal with text, the same gate the scheduler's evalQuestionAnswers wakes on. Anything looser
  // would also cover the human's own ×, which deliberately wakes nobody and has no arrival to bridge to.
  const inFlightAnswers = answersInFlight(questionRows, rawTele?.lastUserAt, row.recurring_on_rest === 1 && Boolean(row.recurring_prompt?.trim()))
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
  const supersededDone = questions.length > 0 || armedWatches.length > 0 || armedPrWatches.length > 0 || armedTimers.length > 0
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
    lastAssistant: providerError?.message, lastAssistantAt: providerError?.at,
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
  const needsYou = archived ? false : deriveNeedsYou(row, tele, runtime, interactionPresence.needsUser, nowMs, limitPause, true, deliveryProcessGone, github, registeredPrWatches, armedTimerIds, armedWatches, questions.length)
  const awaitingBackground = archived ? false : deriveAwaitingBackground(row, tele, runtime, interactionPresence.needsUser, nowMs, limitPause, deliveryProcessGone, github, registeredPrWatches, armedTimerIds, armedWatches, questions.length)
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
    spawnedAt: row.spawned_at,
    lastActivityAt: tele?.lastActivityAt,
    lastAssistantAt: tele?.lastAssistantAt,
    subAgents: stampStoppable(tele?.subAgents ?? [], row),
    bgShells: stampStoppableShells(tele?.bgShells ?? [], row),
    // ONE SOURCE: the FENCE. Both kinds are derived from what the worker wrote — `prs:` entries
    // become the github rows, `watch:` lines the shell rows — so this strip lists exactly what will
    // actually wake the thread, and the two cannot drift into claiming different things. There is no
    // registry behind either any more (`thread_watch`, retired 2026-08-14).
    watches: fenceWatchViews(row.slug, tele, tele?.lastAssistantAt, github, armedPrWatches, armedTimers, armedWatches),
    pendingAsk: tele?.pendingAsk ? { questions: tele.pendingAsk.questions } : undefined,
    pendingQuestion: tele?.pendingQuestion ?? false,
    questions,
    answersInFlight: inFlightAnswers,
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
    snoozedUntil,
    // Only meaningful while the snooze is still pending — a prompt without a live deadline is an
    // already-delivered (or superseded) bump the row has not been swept clean of yet.
    snoozePrompt: snoozedUntil ? row.snooze_prompt ?? undefined : undefined,
    pinnedAt: row.pinned_at ?? undefined,
    // The event-snooze, as a fact the CHAT can read. `awaitingBackground` still ignores it — that flag
    // states whether the thread is waiting, which the snooze does not change — so the suppression is a
    // presentation rule the client applies, not a second opinion about the thread's state.
    bgSnoozed: bgSnoozeArmed(row) || undefined,
    claudeRuntime: row.claude_runtime === "broker" ? "broker" as const : undefined,
    // The recurring prompt — the same projection the worker's own `action: "get"` reads back.
    recurringPrompt: resolveRecurringPrompt(row),
    needsYou,
    awaitingBackground,
    crashed,
    pendingInteraction: interactionPresence.pending,
    actionableInteraction: interactionPresence.needsUser,
    // Preserve only a durable, canonical backend identity. In particular, Claude is not inferred
    // from today's dispatch preference: unknown/migrated rows remain unmarked, while rows whose
    // database default was explicitly normalized to "claude" get the same per-thread identity as
    // Codex rows.
    backend: row.backend === "claude" || row.backend === "codex" ? row.backend : undefined,
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

export interface BoardManager {
  snapshot(): Promise<BoardSnapshot>
  // The seq the current snapshot corresponds to — the value a connect keyframe must advertise so the
  // client can adopt it and then apply deltas seq+1, seq+2 … (see the /events handler). Read
  // synchronously right after snapshot() so the two are consistent.
  currentSeq(): number
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

export interface BoardManagerDeps {
  subscribe?: typeof watcher.subscribe
  now?: () => number
  codexTurnLiveness?: CodexTurnLivenessReader
  claudeBrokerDaemonAlive?: ClaudeBrokerLivenessReader
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
  const pendingInteractionCache = new Map<string, { pending: boolean; needsUser: boolean }>()
  const interactionKey = (slug: string, sessionId: string) => `${slug}\u0000${sessionId}`
  // Per-slug "was this SESSION thread in the needs-you queue last build?" — drives the needs-decision
  // notify dedupe: we fire only on a false→true edge, and a thread leaving the queue re-arms it.
  const needsYouPrev = new Map<string, boolean>()
  // PRIME GUARD: the first assemble after boot records the baseline WITHOUT notifying, so a post-bounce
  // server doesn't fire a storm for every historical resting thread already in the queue.
  let notifyPrimed = false

  // Fire a needs-decision notify for every registered session that newly enters the queue.
  // Edge-triggered + deduped; primed on the first build.
  function notifyNeedsYou(sessionThreads: ThreadView[]): void {
    const seen = new Set<string>()
    for (const t of sessionThreads) {
      seen.add(t.id)
      const now = t.needsYou ?? false
      const was = needsYouPrev.get(t.id) ?? false
      if (notifyPrimed && now && !was) {
        bus.publish({ type: "notify", slug: t.id, kind: "needs-decision", title: t.aiTitle || t.title || t.id, body: capLine(t.lastAssistant) })
      }
      needsYouPrev.set(t.id, now)
    }
    // forget threads that vanished so a reappearance re-notifies
    for (const id of [...needsYouPrev.keys()]) if (!seen.has(id)) needsYouPrev.delete(id)
    notifyPrimed = true
  }

  // The file-backed migration cache is recomputed only on a full rebuild (the `.frizz` watcher catches
  // changes to the top-level `<slug>.md` files this reads, and only those — see
  // isBoardRelevantFrizzPath). Overlay-only refreshes remain filesystem-free.
  let legacyTerminalCache = new Set<string>()

  // Build exactly the session-backed threads recorded by Frizz. The registry is the provenance
  // boundary: historical rows remain valid after migration/restart, and both Claude and Codex use the
  // same durable shape. Raw tailer discoveries never confer ownership.
  function buildSessionThreads(nowMs: number): ThreadView[] {
    // Old/corrupt databases predate the canonical storage guard. Keep such rows inert instead of
    // emitting an invalid board id or allowing it to reach tailer/dispatch consumers.
    const rows = storage.allSessions().filter((row) => ThreadSlug.safeParse(row.slug).success)
    // ONE READ PER BUILD, not per thread: the watched-PR book is keyed by ref and shared by every thread
    // watching that PR, and it is parsed on the way in.
    const github = readGithubStatusBook(storage.getSetting(GITHUB_STATUS_SETTING))
    // The same rule, applied to the five per-thread registries: five statements for the whole project
    // instead of five per row. On the maintainer's 558-thread board that is 2,794 statements per
    // rebuild down to 9, all of it on the event loop — see ThreadRegistries.
    const registries = readThreadRegistries(storage)
    const currentInteractionKeys = new Set<string>()
    const out: ThreadView[] = []
    for (const row of rows) {
      const key = interactionKey(row.slug, row.session_id)
      currentInteractionKeys.add(key)
      let interactionPresence = pendingInteractionCache.get(key)
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
        pendingInteractionCache.set(key, interactionPresence)
      }
      out.push(sessionThreadView(
        project.dir,
        storage,
        row,
        tailer.get(row.slug),
        legacyTerminalCache.has(row.slug),
        interactionPresence,
        nowMs,
        codexTurnLiveness,
        claudeBrokerDaemonAlive,
        registries,
        github,
      ))
    }
    for (const key of pendingInteractionCache.keys()) {
      if (!currentInteractionKeys.has(key)) pendingInteractionCache.delete(key)
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
      const at = Date.parse(thread.snoozedUntil ?? "")
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
    bus.publish({ type: "board-delta", seq: d.seq, bootId, upserts: d.upserts, removed: d.removed, ...(d.meta ? { meta: d.meta } : {}) })
  }

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
    const key = interactionKey(change.threadSlug, change.sessionId)
    // Delivery-only transitions keep lifecycle/revision unchanged, so always evict and re-read the
    // durable join. This prevents awaiting→queued→sent→acknowledged from oscillating the queue based on
    // whichever layer happened to notify last.
    pendingInteractionCache.delete(key)
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
