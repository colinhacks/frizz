import {
  atRest,
  futureSnoozedUntil,
  hasLiveOps,
  hasLiveSubAgents,
  hasStandingQuestion,
  inActiveBand,
  isActivelyRunning,
  isDeclaredAwaiting,
  isSnoozed,
  needsAction,
  queuedThread,
  drawnUnderParent,
  sectionOf,
  type AwaitingHint,
  type SectionKey,
  type ThreadView,
  githubReadingStale,
} from "@frizz/shared"

// The band predicates live in @frizz/shared so the server counts the rail's running badge with the
// same rule the sidebar bands on. Re-exported here, where every web caller already imports them.
// `needsAction` (the queue's ask definition) moved there too, so the server can count a project's asks.
export { futureSnoozedUntil, isActivelyRunning, isSnoozed, needsAction, sectionOf, type SectionKey }
import { canRetry } from "./lib/status.ts"
import { partitionBoard, settledThread } from "./lib/boardPartition.ts"

// Shared listing logic: the queue definition (needsAction), the sidebar's status-keyed sections
// (sectionThreads), and the interaction-recency ordering both surfaces use.

// The title ladder lives in @frizz/shared so the server names a thread the way the sidebar does
// (`frizzctl threads`). Re-exported here, where every web caller already imports it.
export { displayTitle, readableMachineTitle, SPINNING_UP_TITLE, titleIsProvisional, UNTITLED_THREAD_TITLE } from "@frizz/shared"

// USER-INTERACTION key (ms): the newest REAL USER INTERACTION on the thread — an answer, a steer, or
// the dispatch itself — falling back to spawn time when there's been no later interaction (a dispatch
// IS an interaction). `lastUserAt` is server-derived to EXCLUDE tool_results, so it never moves from
// AGENT motion. This is the stable base folded into `lastActiveAt` below (and the churn-free fallback
// a still-running row uses). Neither timestamp present → 0 (sinks to the bottom, id-tiebroken).
function interactionAt(t: ThreadView): number {
  const u = Date.parse(t.lastUserAt ?? "")
  const s = Date.parse(t.spawnedAt ?? "")
  const max = Math.max(Number.isFinite(u) ? u : -Infinity, Number.isFinite(s) ? s : -Infinity)
  return Number.isFinite(max) ? max : 0
}

// THE at-rest listing sort key: "last active" = when the thread's OWN agent last came to REST — its
// `lastAssistantAt` (last assistant output). NOT `lastActivityAt`: that is bumped by a background
// sub-agent's completion notification (a promptSource:system record) and by tool_results, so keying on
// it let a CHILD finishing reshuffle the parent (maintainer 2026-07-16: "it should just be based on
// when the agent rested … user turns don't actually factor in"). User turns don't factor in either:
// a steer flips the thread to running, and only its next REST re-times it. A TURN IN FLIGHT keeps
// `interactionAt` (max lastUserAt/spawnedAt), because its `lastAssistantAt` moves with every message it
// writes and would churn the row. Missing rest time (never produced output yet) → `interactionAt`.
//
// A THREAD RESTING WITH LIVE WORK IS AT REST, so this asks `turnInFlight` and not `isActivelyRunning`,
// which also answers true for it. Such a thread can sit in the queue — its handoff still stands, or its
// live work is a shell — and it sorted from its last user message while its row printed its rest time
// (2026-11-05: Reylo's Kyber thread read 35m and sorted from 15 hours earlier, ahead of threads that
// had really been waiting for hours).
function lastActiveAt(t: ThreadView): number {
  if (turnInFlight(t)) return interactionAt(t)
  const rest = Date.parse(t.lastAssistantAt ?? "")
  return Number.isFinite(rest) ? rest : interactionAt(t)
}

function turnInFlight(t: Pick<ThreadView, "runtime">): boolean {
  return t.runtime === "running" || t.runtime === "spawning"
}

// The timestamp the "Last active" label should DISPLAY, kept in lockstep with the order key so the
// queue's labels read monotonically and never lie. A TURN IN FLIGHT shows its live activity
// (`lastActivityAt` — "just now" while it works); an AT-REST row shows its rest time (`lastAssistantAt`),
// so a background sub-agent completing can never flip a rested row's label to "just now". Falls back to
// lastActivityAt then spawn when a backend never recorded the rest instant (legacy/foreign rows).
export function lastActiveLabelAt(t: Pick<ThreadView, "runtime" | "lastActivityAt" | "lastAssistantAt" | "spawnedAt">): string | undefined {
  if (turnInFlight(t)) return t.lastActivityAt ?? t.spawnedAt
  return t.lastAssistantAt ?? t.lastActivityAt ?? t.spawnedAt
}

// The listing DIRECTION the queue/rested band orders by (a per-browser view preference — see
// lib/prefs.ts). FIFO (default) surfaces the longest-waiting item first so the human cycles through
// all work; LIFO surfaces the most-recently-active first.
export type QueueDirection = "fifo" | "lifo"

// Attention first (needsAction), then most-recent LAST-ACTIVE first within each band (see
// lastActiveAt). id-tiebroken so equal-time rows hold a stable order. New array; input untouched.
export function sortThreads(threads: readonly ThreadView[]): ThreadView[] {
  return [...threads].sort((a, b) => {
    const aa = needsAction(a)
    const bb = needsAction(b)
    if (aa !== bb) return aa ? -1 : 1
    const d = lastActiveAt(b) - lastActiveAt(a)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
}

// Order a thread set by most-recent LAST-ACTIVE first (lastActiveAt), id-tiebroken. Used for the
// Snoozed and External bands — surfaces where newest-on-top is always wanted (the FIFO/LIFO preference
// governs only the queue/rested band via orderQueue). A running row keys off its stable user-interaction
// time (lastActiveAt's churn guard), so live agent motion never reshuffles it; an at-rest row keys off
// when it came to rest, matching its "Last active" label. Running and Done have keys of their own:
// orderRunning and orderDone. New array; input untouched.
export function orderByInteraction(threads: readonly ThreadView[]): ThreadView[] {
  return byKey(threads, lastActiveAt, -1)
}

// THE RUNNING BAND: the thread that most recently switched INTO it first (maintainer 2026-10-23: "The
// most recent agent to switch back into the running status should be at the top of running"). The key
// is `runningSince`, which the server stamps on the first board build that finds the thread in the band
// and keeps until it leaves (board.ts stampRunningSince) — so a row moves when it ENTERS the band and
// never while it is in it: not on a working rest, a mid-turn message or a child returning. A row with
// no stamp (a server that predates it) falls back to the band's old key, lastActiveAt. New array.
export function orderRunning(threads: readonly ThreadView[]): ThreadView[] {
  return byKey(threads, runningAt, -1)
}

function runningAt(t: ThreadView): number {
  const at = Date.parse(t.runningSince ?? "")
  return Number.isFinite(at) ? at : lastActiveAt(t)
}

// THE DONE BAND'S KEY: when the thread was marked done (`archivedAt`, stamped by the server's archiving
// write), so the thread marked done most recently is at the top (maintainer 2026-10-23). A thread
// archived before that stamp existed falls back to its rest time, which a later archive always passes:
// a thread is marked done after it last rested. Reads only the thread itself, never the clock — the
// Done band's order memo (orderDone) depends on that.
function doneAt(t: ThreadView): number {
  const at = Date.parse(t.archivedAt ?? "")
  return Number.isFinite(at) ? at : lastActiveAt(t)
}

// Sort by `key` with each thread's key read ONCE. The comparator used to derive it — a runtime check
// and a Date.parse per side — on every comparison, which for the Done band of a long-lived board is ten
// thousand derivations to order a thousand rows (12ms of a 32ms rail render, production bundle,
// 2026-10-13). `dir` 1 = oldest first, -1 = newest first; ties break on the slug, ascending, either way.
function byKey(threads: readonly ThreadView[], key: (t: ThreadView) => number, dir: 1 | -1): ThreadView[] {
  const keyed = threads.map((t) => ({ t, at: key(t) }))
  keyed.sort((a, b) => {
    const d = (a.at - b.at) * dir
    return d !== 0 ? d : a.t.id.localeCompare(b.t.id)
  })
  return keyed.map((k) => k.t)
}

// The queue is a SINGLE strictly time-ordered list — no priority band. Every waiting card orders by
// DIRECTION (a per-browser view preference — see lib/prefs.ts) alone, so the visible "oldest first"
// rule is literally true across every card, attention and passive alike (maintainer 2026-07-21:
// removed the hidden hard-attention band — "too confusing"; a fresh crash/permission-prompt no longer
// floats above an older done card):
//   • FIFO (default): the thread gone LONGEST without activity surfaces first (oldest lastActiveAt =
//     ascending), so answering it sends it to the BACK of the line and the next-oldest rises — the
//     human cycles through every waiting item instead of endlessly re-triaging whatever rested most
//     recently (maintainer 2026-07-15: "first in first out is a better system… you are not constantly
//     cycling through all of the tasks").
//   • LIFO: the most-recently-active first (descending) — the older last-in-first-out feel.
// lastActiveAt keys off when an AT-REST thread came to rest (matching its "Last active" label) and off
// the stable user-interaction time for a running row, so agent tool churn never reorders a card.
// id-tiebroken for a stable order among equal-age rows.
export function orderQueue(threads: readonly ThreadView[], direction: QueueDirection = "fifo"): ThreadView[] {
  return byKey(threads, lastActiveAt, direction === "lifo" ? -1 : 1)
}

// ── SESSION-FIRST QUEUE ──────────────────────────────────────────────────────────────────────────
// The Needs-you queue (the cards surface) is EXACTLY the session threads the SERVER derived as needing
// the human (t.needsYou — explicit questions, checked/done handoffs, and process-level blocks a view
// can't clear). Do NOT re-derive it client-side for session rows. Legacy .frizz-file rows
// never card anymore. An archived thread is out of the queue regardless (belt-and-suspenders — the
// server already drops needsYou when archived). Pre-restart snapshots carry no kind/needsYou → false →
// an empty queue, the accepted degrade.
export function queued(t: ThreadView): boolean {
  // Foreign (terminal-originated) sessions never queue: their interaction surface is the terminal
  // the human is already sitting in — frizz can't be "awaiting" them here. The predicate itself is
  // shared with the server, which counts it per project for the rail's badges.
  return queuedThread(t)
}

// EXTERNAL SESSIONS — agent sessions discovered in the project's transcript dir that frizz did NOT
// originate (the human's own terminals). They are NOT part of the four frizz bands and never can be
// while they stay external: such a session writes no ```awaiting fence and has no lifecycle row, so
// Snoozed and Done have nothing to derive from (see the server's foreignThreadView). So they get their
// own collapsible section at the bottom of the rail — one the reader can ignore wholesale.
//
// ONE NAME, TWO SPELLINGS, on purpose. The WIRE field is `foreign`, which is what the tailer has
// called an unregistered transcript since long before this band existed and what the server still
// calls it. Everything the HUMAN sees says EXTERNAL (maintainer 2026-08-24), so the web says external
// too and the boundary between the two vocabularies is exactly this predicate.
//
// The server emits only RESTED ones (maintainer 2026-08-19: a spinning terminal session is one you
// already have open), so this is a plain partition rather than a second opinion about rest. A session
// stops being external the moment you STEER it — the first message promotes it to an ordinary thread.
export function externalThreads(threads: readonly ThreadView[]): ThreadView[] {
  // A settled thread is never foreign, so only the live ones are asked (lib/boardPartition).
  return partitionBoard(threads).live.filter((t) => t.kind === "session" && t.foreign === true)
}

// ── SIDEBAR SECTIONS (session-first) ───────────────────────────────────────────────────────────────
// THE VOCABULARY, because the `"active"` key below does NOT mean what the maintainer means by Active
// (2026-08-05: "when I say active, I'm only referring to the things that are currently spinning; the
// things beneath that I would refer to as rested, or just items in the queue"). Written out in full in
// ARCHITECTURE.md § Board nomenclature; the short form, top of the rail to the bottom:
//   RESTED   — the cue: the same set as "the queue", exactly one row per card. It sits DIRECTLY UNDER
//              THE PROMPT BOX (maintainer 2026-08-08) — what is waiting on the human is what the human
//              came to read, so it gets the rail's best position.
//   ACTIVE   — below the rule, in practice the rows currently SPINNING. Never carries a queue card, and
//              that is the actual rule of the split — see inActiveBand for the rows it also takes.
//   HELD     — the dimmed, labeled park band.
//   DONE     — the collapsed archived section.
// Say "rested" or "in the queue" for a card's row. NEVER call it active merely because this key does.
//
// The rail's THREAD-derived sections, keyed on the session-first model (NOT frizz status). Every thread
// row lands in exactly one of these.
//   • active           — the SECTION holding the Active AND Rested bands (partitionActive splits it):
//                        open session work — running, needs-you, bare rest, done-fenced, OR owning a
//                        live sub-agent/background shell/Monitor. Never dimmed as a band.
//   • held             — open, AT REST behind ANY declared ```awaiting fence (or the canonical
//                        blocked+timer status) AND no live background op — or behind a rest its worker
//                        called `watching`, live op or not (2026-10-05). Its own DIMMED band between
//                        the rested rows and Done. The glyph and section share isSnoozed(), so a row can
//                        never read as "snoozed" while sitting in the Active/Rested section. (The
//                        hourglass GLYPH is not Snoozed's alone since 2026-09-07: a queued wait on a
//                        timer wears it too — awaitingTimerWatch — the way a queued PR wait wears the
//                        octocat. The band says parked; the mark says what it waits on.)
//   • inactive         — state === "archived" (the only archiver is an explicit Archive / done-card
//                        button). Rendered under the label DONE — the key and the label differ.
//   • legacy           — kind !== "session": vestigial .frizz-file rows, hidden entirely (null).
// A FOREIGN session row (a maintainer terminal — no registry row, so no state/needsYou) is dropped
// entirely (never rows). Order within a section is interaction recency.
// Thread-derived buckets, in render order.
export const SECTION_ORDER: readonly SectionKey[] = ["active", "snoozed", "inactive"]

// PINNED — the human lifted this thread out of the band system entirely (maintainer 2026-09-02). Not a
// SectionKey on purpose: sectionOf stays the pure state-derivation it is, and the pin is a human
// override applied ABOVE it (sectionThreads diverts these rows before sectionOf runs), the same
// altitude as the foreign drop. Deliberately ignores state: the pin outranks Done, Snoozed and the
// queue alike — that is the whole feature.
//
// A CHILD THREAD's pin is not honoured while the board draws it under its parent (shared
// drawnUnderParent): the shelf is a band like any other, and a child is a row of none of them.
export function isPinned(t: ThreadView): boolean {
  return t.kind === "session" && t.foreign !== true && typeof t.pinnedAt === "string" && !drawnUnderParent(t)
}

// PINNED ON THE CONSOLE — the "By status" view's own shelf (maintainer 2026-10-19: "a separate pin
// system specifically for the By Status page"). Independent of isPinned: a thread pinned on its
// project's board is not pinned on the Console, nor the other way round, and each shelf has its own
// order. Same eligibility as the board's pin, and it outranks state the same way.
export function isConsolePinned(t: ThreadView): boolean {
  return t.kind === "session" && t.foreign !== true && typeof t.consolePinnedAt === "string" && !drawnUnderParent(t)
}

/** A PINNED ROW'S UNREAD MARK: is the report it is resting on newer than the human's last look? A report
 *  on a pin has no card to be seen on, so the shelf row is where it says so. `seenAt` is written by opening
 *  the thread (router threadSeen), by its drawer and its full-screen page, and again each time a rest lands
 *  while one of them is open, so a report read as it arrives is never marked. A thread nobody has opened
 *  since it was dispatched reads as unread. */
export function unreadReport(t: Pick<ThreadView, "needsYou" | "plainReport" | "lastAssistantAt" | "seenAt">): boolean {
  if (t.needsYou !== true || t.plainReport !== true) return false
  if (!t.seenAt) return true
  return Date.parse(t.lastAssistantAt ?? "") > Date.parse(t.seenAt)
}

/** Which shelf a row's pin speaks for: its project board's, or the Console's "By status" view's. */
export type PinShelf = "board" | "console"

export function pinnedOn(t: ThreadView, shelf: PinShelf): boolean {
  return shelf === "console" ? isConsolePinned(t) : isPinned(t)
}

// The wait kinds that truthfully earn the parked/hourglass presentation. A timer is only a park while
// its valid scheduler instant is still in the future; malformed or elapsed timer prose must not
// advertise a durable future wake. Legacy machine waits (pr/ci/session) intentionally do not qualify.
//
// A PR WAIT IS DELIBERATELY ABSENT: the review/approval/comment watcher must NOT park in Snoozed. A worker
// that opens a PR and watches it stays a VISIBLE queue handoff (a PR whose reviews may never arrive must
// not silently vanish into the dimmed band — maintainer 2026-07-22); the scheduler still polls and bumps
// it, and the human opts into hiding it via the RESTING card's event-snooze, which drops the card until
// the thread comes to a new rest (2026-08-13 — that card is where a parked watcher is now stated and
// controlled; the awaiting card no longer offers a park action for it). Admitting one here would
// re-introduce exactly the auto-Snoozed danger this split was built to remove. (The key is `prs:` since the
// 2026-08-24 YAML cutover; both spellings this paragraph was written against — the singular `pr:`, and the
// `pr-watch:` before it — are retired, see RETIRED_AWAITING_KINDS. The WIRE kind stays singular, which is
// why the code below still reads `hint.kind === "pr"`.)
// NOTHING HERE PARKS A THREAD ANY MORE (2026-08-15). This returned the two hint kinds that dimmed a
// thread into Snoozed on the worker's word alone: `human:`, which NOTHING EVER FIRED, and a future
// `timer: <instant>`, one of which was published 5h55m in the PAST — it parsed, armed nothing, and left
// its thread parked for 5.5 hours. Both kinds are deleted. A park is now a structural declaration the
// SERVER checks against live telemetry and the registries (board.hasDeclaredBackgroundPark), which is
// not something the client can or should re-derive from hints alone.
export function parkedAwaitingHint(_hints: readonly AwaitingHint[], _nowMs = Date.now()): AwaitingHint | undefined {
  return undefined
}

// A QUEUE HANDOFF THAT HAS ALREADY COME TO REST: the server queued it (`needsYou`) and the thread's
// OWN turn is over (turn-idle/exited). It must not make the PARENT's rail mark claim motion the parent
// does not have (maintainer 2026-07-27: "when an agent comes to rest and shows up in the queue, it
// should get the ellipsis indicator in the sidebar, even though its sub-agents are still spinning").
// The children keep their own spinners on their own indented rows (Sidebar SubAgentRows → ChildOpRow);
// the parent's indicator speaks for the parent. A queued row therefore sits in the rested band AND
// reads as rested.
//
// From 2026-07-30 the live-SUB-AGENT case did not reach here at all: the server excused such a thread
// from the queue entirely (board.deriveNeedsYou), so `needsYou` was false and the row kept its spinner in
// the running band. That still holds for a thread dispatched before the answer-required cut, and for a
// later one whose fence answers `status: working`. It reaches here AGAIN (2026-10-01) for a worker that
// answers `needs_input` with a child still out, or rests on one with no fence: it asked for the human, so
// it sits in the rested band with this ellipsis, and the child keeps its own spinner on its indented row.
//
// Still load-bearing for the EXITED parent whose children keep reading "running" until their transcript
// goes stale. Without this it would resolve to "working" and hide the [!] stall mark behind a spinner
// for a pane that is already dead. (The other case it used to cover — a shell-only rest, which queues
// again since 2026-08-04 — now has its own mark; see restingOnBackgroundWork, which is checked first
// and gives it the dot rather than this ellipsis.)
function restedQueueHandoff(t: ThreadView): boolean {
  return t.needsYou === true && atRest(t)
}

// RESTING ON BACKGROUND WORK, AND NOTHING ELSE: the thread's own turn is OVER (turn-idle) and the only
// thing it still has out is something it launched or parked on — a background shell/Monitor, or (since
// 2026-08-13) a PR watcher. That earns its own mark — the pulsing blue dot in the rail's rounded box
// (maintainer 2026-08-01: "if a thread has rested but it still has background work going, like
// background shells, we should keep it in the actively running rail, but we should stop the spinner and
// put a pulsing blue dot in the middle of the rounded circle shape").
//
// The MARK outlived the band. Since 2026-08-04 such a thread carries a queue card again (maintainer:
// "if a thread has rested and the only thing remaining is background shells, we should put it into the
// queue"), so `needsYou` drops its row below the rule into the rested band — and the dot stays, because
// it is the one thing that tells that row apart from an ordinary bare rest at a glance. Snoozing the
// card parks it in the dimmed Snoozed band (isSnoozed reads `bgSnoozed`). Until 2026-08-28 the snooze
// sent it back to the running band with the same dot — "still alive, no longer asking" — and the
// maintainer read that as a row the snooze had not touched at all.
//
// A LIVE SUB-AGENT IS DELIBERATELY EXCLUDED (maintainer, same day: "this should not show up if there
// are sub-agents"), and the two are genuinely different states rather than two flavours of one. A
// dispatched child is work the parent is WAITING ON: its return re-invokes the parent within seconds,
// so the thread is mid-flight in substance even though its own turn ended, and the spinner tells the
// truth. A background shell is DETACHED — the worker launched it and moved on, and 26% of real launches
// are servers that never exit — so nothing about that thread is in motion. Hence: spinner while
// something will come back to you, dot while something merely runs on. A thread with BOTH keeps the
// spinner, because the sub-agent is the stronger fact.
//
// Gated on `turn-idle`, never `exited`: a dead pane cannot be waiting on anything, and that parent must
// keep its [!] stall mark rather than advertise live work behind a dot. `awaitingBackground` is server
// truth — see hasLiveOps for why a raw `bgShells` read would be wrong. (It once ALSO excluded every
// fenced thread, which is no longer so: a parked PR watch, a declared background park and an armed timer
// each set it on an ```awaiting fence. Nothing here depended on that; hasLiveOps did.)
//
// This is only HALF the dot's gate: whether any of that work is still MOVING is the next question, and
// `restingOnLiveBackgroundWork` below answers it. The broad reading survives here because the `working`
// branch needs it — a thread at rest behind its own declared work must never spin, moving or not.
function restingOnBackgroundWork(t: ThreadView): boolean {
  return t.runtime === "turn-idle" && t.awaitingBackground === true && !hasLiveSubAgents(t)
}

// …AND IS ANY OF IT ACTUALLY MOVING? The dot says "alive, not moving"; it must never say that about a
// thread where nothing is running at all. A registered PR watcher joined `awaitingBackground` on
// 2026-08-13 (it earns the resting card and that card's snooze), and it brought a shape a shell never
// has: a wait whose subject has ALREADY FINISHED. A green PR is not background work in flight — it is a
// handoff sitting on the human's merge, and the row wore the same live blue dot as a running dev server
// (maintainer 2026-08-19, on an ```awaiting fence naming a PR — `pr:` in the grammar of that day, `prs:`
// since 2026-08-24 — whose card read "10 successful · no
// conflicts": "this task should not be listed as in the actively running rail if it's only awaiting a PR
// with green CI").
//
// So the dot needs motion, and this is the SAME rule the band already draws server-side — CI still
// running holds the thread out of the queue (board.heldByRunningChecks, maintainer 2026-08-14: "only if
// CI has failed or completed successfully should it show up back in the queue"). The mark simply never
// got it, so the two disagreed about one thread: banded as a handoff, marked as live work.
//
// ANY watched PR still running counts, where the band's excusal needs ALL of them. The two questions are
// different: the band asks "is there anything for the human to do yet" (one PR going green is), the mark
// asks "is anything still in motion" (the other one is). A settled watcher — passing, failing, no checks
// at all, closed, or never polled — is not motion, and falls through to the at-rest ellipsis.
//
// Reading raw `bgShells` here is safe where hasLiveOps could not: this is already gated on the server's
// own `awaitingBackground` verdict, so a stale shell cannot pull a thread into the state — it only picks
// which mark a thread the server already called at-rest-with-work wears.
function restingOnLiveBackgroundWork(t: ThreadView): boolean {
  if (!restingOnBackgroundWork(t)) return false
  if ((t.bgShells ?? []).some((s) => s.state === "running")) return true
  // AN ARMED TIMER IS NOT THE DOT'S BUSINESS ANY MORE (2026-09-07). From 2026-08-24 this counted an armed
  // timer as motion "the same way running CI is" — a wake with a known instant — so a QUEUED rest on a
  // timer wore the shell's blue dot, the mark for "something it launched is still running". Nothing is
  // running behind a timer; the clock is. The maintainer read the dot as a claim of live work
  // (2026-09-07: "an item in the queue that's awaiting a timer should show up with the hourglass icon in
  // the sidebar, not with the flashing blue dot"), so the timer wait is now its own kind — awaitingTimerWatch,
  // resolved ABOVE this predicate in sessionIndicatorKind — and this one is back to what its name says:
  // a shell that is still running, or CI that is. A settled watcher — passing, failing, no checks at all,
  // closed, or never polled — is not motion, and falls through to the at-rest ellipsis.
  return prChecksRunning(t)
}

/** IS CI RUNNING ON A PULL REQUEST THIS THREAD WATCHES? The one reading of a PR wait that is MOTION —
 *  something is happening somewhere, and its finish is a wake frizz delivers — as opposed to the settled
 *  readings (green, red, no checks, merged, closed, never polled), which are a handoff sitting on a
 *  human. It picks the rail's mark for the `pr` kind: the octocat inside the spinner while checks run,
 *  the static octocat once they settle (maintainer 2026-09-20: a PR wait "should just stay in the running
 *  rail if it's actively waiting on checks"). Exported for the Sidebar arm and pinned by its tests.
 *
 *  GATED CI IS NOT RUNNING. Workflows held at GitHub's "Approve and run" gate read `checks: "running"`
 *  (nothing has settled), but nothing is moving either: a maintainer has to press a button. The PR row's
 *  own checks glyph already refuses to spin for that shape (AwaitingBackgroundCard ChecksGlyph), and the
 *  rail follows it — a spinner over a gate would promise motion for as long as nobody notices.
 *
 *  NOR IS A STALE READING (2026-11-06), for the reason the server's ciInMotion gives: "running" read an
 *  hour ago says nothing about now. */
export function prChecksRunning(t: Pick<ThreadView, "watches">, nowMs = Date.now()): boolean {
  return (t.watches ?? []).some(
    (w) =>
      w.kind === "github" && w.state === "armed" && w.github?.checks === "running" && w.github.state === "open" &&
      !(w.github.running === 0 && (w.github.gated ?? 0) > 0) && !githubReadingStale(w.github, nowMs),
  )
}

/** DOES THIS REST SPIN? Only when its worker called it `working` and the server found the work moving —
 *  ThreadView.waitStatus (board.deriveWaitStatus, 2026-10-05). The spinner means that and nothing else:
 *  a QUEUED rest never carries the field, so a queue row never spins, and a `watching` rest is Snoozed
 *  and still. Each at-rest arm that used to spin on its own reading — the shell's dot, the octocat over
 *  running checks — keeps its glyph and asks this whether the frame around it moves (maintainer
 *  2026-10-03: a watcher thread "shouldn't show up as actively running"). */
export function restIsWorking(t: Pick<ThreadView, "waitStatus" | "runtime">): boolean {
  return t.waitStatus === "working" && t.runtime === "turn-idle"
}

/** A PARENT THAT HAS RESTED WHILE ITS SUB-AGENTS ARE STILL OUT — its own turn is over (turn-idle) and a
 *  direct child is running. The thread still resolves to `working` (the child's return re-invokes it, so
 *  the motion is real and the row keeps its place in the Running band), but since 2026-09-20 the mark
 *  inside the spinner is the ELLIPSIS rather than an empty box: the parent itself is at rest, and the
 *  children carry their own spinners on their own indented rows (maintainer 2026-09-19: "the three
 *  ellipses for the top-level parent agent with the spinner, and then the sub-agents can have their own
 *  spinners"). A parent whose OWN turn is running keeps the empty spinner even with children out. */
export function restingOnSubAgents(t: ThreadView): boolean {
  return t.runtime === "turn-idle" && hasLiveSubAgents(t)
}

/** A RUNNING THREAD THAT IS ALSO WAITING ON AN ANSWER — it registered a question (an open
 *  thread_question row, arriving as `questions`) and kept working, as the worker contract tells it to.
 *  sessionIndicatorKind deliberately resolves this to `working`, and the server keeps it out of the queue
 *  until it rests, so before 2026-10-08 the ask was visible only to someone who opened the thread: the
 *  rail drew the plain spinner for the whole stretch the worker spent on work that did not depend on the
 *  answer (reported 2026-10-08: "There were questions I could answer to influence the agent but it
 *  looks like it is still working on other things in the bg"). The `working` arm now draws the "?"
 *  INSIDE the spinner — the motion is real and the band does not change, only the mark inside it says
 *  that an answer would steer the work. Outranks the sub-agent ellipsis: the ask is what the human can act on. */
export function workingWithOpenQuestion(t: ThreadView): boolean {
  return (t.questions?.length ?? 0) > 0 && sessionIndicatorKind(t) === "working"
}

/** AWAITING A PULL REQUEST — the one wait whose subject is not on this machine at all, and since
 *  2026-09-04 a mark of its own wherever it lands.
 *
 *  GitHub's mark used to render in exactly ONE place: the Snoozed band, for a parked row whose fence
 *  happened to name `prs:`. Every other PR wait wore something that said nothing about GitHub — a
 *  watched PR with CI still running drew the shell's blue dot (restingOnLiveBackgroundWork below counts
 *  running checks as motion), and one whose checks had SETTLED fell all the way through to the bare-rest
 *  ellipsis. So the rail drew three different marks for one state, and the only one that named the state
 *  was the one behind a park (maintainer 2026-09-04: "it's kind of weird that this only shows up on a
 *  snoozed card … the GitHub icon should show up anytime that an agent is awaiting a PR").
 *
 *  THE REGISTERED WATCH IS THE PRIMARY SIGNAL, not the fence. `frizzctl watch-pr` creates the row
 *  the scheduler actually polls, and it is what survives a compaction and a restart; the `prs:` fence
 *  line only ECHOES it (the worker contract: "Register FIRST: this line states the wait, it does not
 *  create one"). Reading the fence alone — which is all the Snoozed arm ever did — therefore misses a
 *  worker that registered a watch and then rested without fencing, which is the shape the contract now
 *  steers workers toward. Both are read here so neither shape loses the mark.
 *
 *  Gated on `turn-idle` so it means AWAITING and nothing else: a thread mid-turn keeps its spinner (a
 *  watch does not stop the work), and an EXITED one stays a stall — its process is gone, Retry is the
 *  next action, and offersRetry reads this same ladder, so taking the stall would silently strip the
 *  recovery verb off the row.
 *
 *  NO SUB-AGENT CARVE-OUT, deliberately, and it took a wrong assertion to see why. `working` is resolved
 *  ABOVE this, so a thread with a live child already spins before it can get here — the ONLY shape that
 *  reaches this line with a child still out is the rested QUEUE HANDOFF (restedQueueHandoff: the server
 *  queued it and its own turn is over), which by long-standing rule reads as rested rather than as
 *  motion. For that row "awaiting a PR" is simply the truer of the two rests, and the children keep
 *  their own spinners on their own indented rows. Excluding them here bought nothing and cost the mark
 *  exactly where it says the most. */
export function awaitingPrWatch(t: ThreadView): boolean {
  if (t.runtime !== "turn-idle") return false
  return waitNamesPr(t)
}

/** Does this thread's wait name a PULL REQUEST at all — the question ALONE, with no opinion about
 *  whether the thread is otherwise free to wear GitHub's mark. Split out because the Snoozed arm asks
 *  exactly this and nothing more: a parked row has already earned its band, and all the rail is
 *  choosing there is hourglass-or-octocat. Keeping one answer is what stops the two surfaces drawing
 *  different marks for one thread — the Snoozed arm read only the fence until 2026-09-04, so a row
 *  parked on a REGISTERED watch it never fenced wore the clock. */
export function waitNamesPr(t: Pick<ThreadView, "watches" | "lastFence">): boolean {
  if ((t.watches ?? []).some((w) => w.kind === "github" && w.state === "armed")) return true
  return t.lastFence?.kind === "awaiting" && t.lastFence.hints.some((h) => (h.kind === "pr" || h.kind === "issue") && h.value.trim() !== "")
}

/** AWAITING A TIMER — parked on the clock, and since 2026-09-07 the hourglass wherever the row lands,
 *  the way the octocat above is GitHub's mark wherever a PR wait lands.
 *
 *  A timer park QUEUES (board.deriveNeedsYou: "a visible handoff, never an auto-park"), so most timer
 *  waits sit in the Rested band rather than in Snoozed — and there the row wore the shell's blue dot,
 *  because restingOnLiveBackgroundWork counted an armed timer as motion. The dot is the rail's word for
 *  "a process it launched is still running", and nothing is running behind a timer; the maintainer read
 *  it as exactly that claim (2026-09-07: "an item in the queue that's awaiting a timer should show up
 *  with the hourglass icon in the sidebar, not with the flashing blue dot"). The hourglass is the mark
 *  the rail already uses for "parked on the clock" — the Snoozed band's park, the limit kill's accent
 *  twin — so a queued timer wait joins that family instead of the shell's.
 *
 *  THE REGISTERED ROW IS THE SIGNAL, not the fence. The board synthesizes a `timer` watch row for every
 *  ARMED `thread_timer` (fenceWatchViews), fence or no fence, and only for armed ones — a `timers:` line
 *  naming a fired or cancelled id has no row, and the server treats that fence as a bare rest
 *  (hasParkedTimerWatch). Reading the rows alone therefore never advertises a wake that will not come,
 *  which is the trap the deleted `timer: <instant>` grammar fell into (one was written 5h55m in the past).
 *
 *  Gated on `turn-idle` for the reason awaitingPrWatch is: mid-turn keeps its spinner, and EXITED stays a
 *  stall so the row keeps its Retry (offersRetry reads the resolved kind). Ranked BELOW the PR mark in
 *  sessionIndicatorKind — a thread watching a PR with a timer as its backstop is waiting on GitHub, and
 *  the clock is only how long it will wait — and ABOVE the dot, for the same reason the octocat is: a dev
 *  server the thread also left running is not what it is waiting FOR. */
export function awaitingTimerWatch(t: ThreadView): boolean {
  if (t.runtime !== "turn-idle") return false
  return (t.watches ?? []).some((w) => w.kind === "timer" && w.state === "armed")
}

/** AWAITING A MONITOR (`frizzctl monitor`) — a thread at rest with an armed monitor: a script the server
 *  keeps running, every line it prints a wake. It earns its own mark (Sidebar.tsx monitorMark) in
 *  whichever band the row sits, for the reason a PR and a timer have theirs: until 2026-11-03 a monitor
 *  park wore the hourglass in Snoozed, which promised a clock nothing had set, and the bare-rest
 *  ellipsis in the queue, which said nothing would wake it at all. REGISTERED rows, fence or no fence,
 *  like awaitingTimerWatch: an armed monitor wakes the thread whether or not the worker named it. */
export function awaitingMonitor(t: Pick<ThreadView, "runtime" | "watches">): boolean {
  if (t.runtime !== "turn-idle") return false
  return (t.watches ?? []).some((w) => w.kind === "command" && w.state === "armed" && Boolean(w.command?.monitor))
}

// One status-priority decision shared by the sidebar renderer and its tests. The order is important:
// an archived row at rest stays archived even if stale attention metadata lingers; a real human ask
// stays a question after the worker exits; live work stays working; and a completed handoff stays a
// check instead of being mislabelled as a crash merely because `needsYou` also puts it in the queue.
export type SessionIndicatorKind = "archived" | "needs-input" | "working" | "background" | "pr" | "monitor" | "timer" | "done" | "stalled" | "limit" | "snoozed" | "rest"

// NO RAIL MARK FOR AN ARMED STOP HOOK, and the reason is worth keeping because one shipped briefly
// (2026-08-02, removed the same day — maintainer: "the whole point of a stop hook is that it means the
// agent never stops, so it should always just be loading").
//
// The rail's marks are mutually exclusive and `working` outranks everything below it, so a mark for
// "this thread has a hook" could only ever render in the gap where the thread is at REST — and a live
// hook has almost no such gap: the thread works, stops, and is bumped again within a tick. What it DID
// render on was the one at-rest state that lasts, the thread whose agent answered AWAITING — where the
// mark said "frizz will act on this" about a loop that had just closed itself. It was invisible when
// true and wrong when visible.
//
// The prompt box's RecurringPromptControl carries the state instead, where it is legible and editable.

export function sessionIndicatorKind(t: ThreadView): SessionIndicatorKind {
  const activelyRunning = isActivelyRunning(t)
  if (t.state === "archived" && !activelyRunning) return "archived"

  // A PARK THE OPERATOR SET OUTRANKS EVERY ASK MARK BELOW IT — the order the SERVER already derives the
  // queue in (deriveNeedsYou checks futureSnooze before pendingAsk, pendingQuestion and the registered
  // rows), and the order isSnoozed itself states in prose: "a user-owned snooze deliberately wins over a
  // concrete ask, permission prompt, or crash". Only the MARK disagreed, and the disagreement was
  // visible: a snoozed thread carrying an unanswered ```question sat in the dimmed Snoozed band wearing
  // the [?] of a queue member while the server had dequeued it, so NOTHING anywhere drew the question the
  // mark advertised (maintainer 2026-08-31: "marked as a question status, but there is no question
  // rendering"). Measured on this machine that day: 3 of the 37 threads the rail marked [?] had no card
  // on any surface, on three different projects, and all three were user-snoozed with a pending ask.
  // Gated on isSnoozed so its carve-outs still hold — a running turn and a live sub-agent keep their
  // spinner, because motion is a fact about the process that a park does not change — and on
  // the OPERATOR'S OWN parks, so only they take this branch: a declared wait leaves the thread QUEUED
  // server-side, where the ask is reachable and the [?] is true. The event-snooze joined the wall-clock
  // one on 2026-10-19, when "Until activity" put it in the header menu and the server started honouring
  // it ahead of a question too (deriveNeedsYou) — until then it left the asking thread queued as well.
  if ((futureSnoozedUntil(t) !== undefined || t.bgSnoozed === true) && isSnoozed(t)) return "snoozed"

  const explicitlyNeedsInput = Boolean(
    t.actionableInteraction ||
      t.pendingAsk ||
      t.pendingQuestion ||
      t.runtime === "perm-prompt" ||
      t.humanBlocked ||
      t.status === "needs-human",
  )
  if (explicitlyNeedsInput) return "needs-input"
  // "Working" is motion the thread genuinely has: its own turn in flight (running/spawning), or a live
  // SUB-AGENT whose return will re-invoke it, while the parent is NOT yet a handoff. A rested, queued
  // thread falls through to the at-rest ellipsis below no matter how many sub-agents it still has out —
  // see restedQueueHandoff. A shell-only rest is carved out because it is never motion at all; the dot
  // below is its mark, and without this clause an event-snoozed one would still spin.
  if (activelyRunning && !restedQueueHandoff(t) && !restingOnBackgroundWork(t)) return "working"
  // A REGISTERED question (an open thread_question row, arriving as `questions`) is as concrete an ask
  // as any of the explicit flags above, but it deliberately sits BELOW the working branch: a worker
  // that registers a question keeps working, and the ask must not stop its spinner (the same reason
  // board.ts keeps these rows out of degradeIfAwaitingAnswer). Once the thread is at rest the server
  // queues it (deriveNeedsYou's openQuestions) and the card renders the ask — so the rail must say "?"
  // rather than the bare-rest ellipsis it wore before this branch existed (maintainer 2026-08-31: a
  // queue card showing a question beside a row marked […]). Above "snoozed" and "stalled" on purpose:
  // an ask outranks a park, and a real human ask stays a question after the worker exits.
  //
  // ONLY A QUESTION THAT STANDS AT THIS REST (shared hasStandingQuestion, 2026-10-13). The server queues
  // on those alone, so an older open question the worker has rested past is not this row's state: read
  // off `questions.length`, a thread parked on `status: watching` sat dimmed in Snoozed wearing the [?],
  // and one handed off with a ```done fence wore it in place of its check — with no question card at
  // that rest in either case. The older question keeps its card where it was asked.
  if (hasStandingQuestion(t)) return "needs-input"

  if (isSnoozed(t)) return "snoozed"
  // KILLED BY A USAGE LIMIT. Its own attention mark — the yellow hourglass — because it is BOTH things
  // at once: dead like a stall (hence yellow, and the same one-click Retry), and a wait on provider
  // capacity rather than a crash (hence the hourglass, not the [!]). It wore the muted Snoozed
  // hourglass until 2026-08-31 (maintainer: killed threads "showed up and fucking snoozed … they're
  // not showing up as yellow in the sidebar"). Below isSnoozed so the operator's own wall-clock snooze
  // still parks the row; above the done fence and the background dot, both of which would be a STALE
  // story from before the kill (the fault postdates any fence, and nothing of the thread's is coming
  // back until the window resets). PRESENCE, not `autoResume`: a pause frizz will not resume by itself
  // (an unknown phrasing, an aged-out fault) is still a limit kill, and the tip says which story holds.
  if (t.limitPause && t.foreign !== true) return "limit"
  // A cardless rest can be a follow-up whose delivery spinner has expired before the transcript
  // catches up. Its fence still describes the PREVIOUS turn: keep the queue excusal, not its checkmark.
  if (t.lastFence?.kind === "done" && atRest(t)) return t.foreign !== true && t.needsYou === false ? "rest" : "done"
  // AWAITING A PR — GitHub's own mark, in whichever band the row sits (awaitingPrWatch). ABOVE the
  // background dot because a watched PR is not this machine's work: a dev server the thread also left
  // running is not what it is waiting FOR, and the dot said "something here is alive" about a wait whose
  // subject is a review queue somewhere else. BELOW the done fence and the limit kill, which are both
  // later facts than the park — a killed or dismissed thread is not awaiting anything.
  if (awaitingPrWatch(t)) return "pr"
  // AWAITING A MONITOR — the radio, in whichever band the row sits (awaitingMonitor). Below the PR, which
  // is the subject of any wait it is part of; above the timer, which beside a monitor is its backstop.
  // NOT FOR A `working` REST, for the timer's reason: the board reads a monitor alone as `watching`, so a
  // `working` rest here is spinning for a shell the worker named, and that shell is the motion.
  if (awaitingMonitor(t) && !restIsWorking(t)) return "monitor"
  // AWAITING A TIMER — the hourglass, in whichever band the row sits (awaitingTimerWatch). Below the
  // PR mark: a timer beside a PR watch is the watch's backstop, not the subject. Above the dot: a timer
  // park in the QUEUE wore the shell's blue dot until 2026-09-07, which claimed live work behind a
  // thread whose only pending event is a wake frizz will deliver. NOT FOR A `working` REST: the timer
  // there is the backstop of a shell the worker named, and that shell is the motion the row spins for.
  if (awaitingTimerWatch(t) && !restIsWorking(t)) return "timer"
  // Below the two DECLARED states on purpose. A worker that fenced ```done while a server it never
  // killed keeps running is a one-click dismissal, not live work (FRIZZ.md: "name it in the body and
  // fence anyway"), and a parked ```awaiting is the human's gate — either story outranks "something it
  // launched is still going". The ordering is LOAD-BEARING now rather than merely declarative: it used
  // to be unreachable because deriveAwaitingBackground dropped any fenced thread, and since a timer park
  // sets the flag ON its ```awaiting fence (f50f9e60), a real production row reaches both — the fenced
  // timer park, which takes "snoozed" here and the dimmed band in sectionOf.
  if (restingOnLiveBackgroundWork(t)) return "background"
  // STALLED = this thread's PROCESS IS GONE with the work unfinished. That is exactly `canRetry`: an
  // OWNED (non-foreign) session row whose runtime is `exited`. It deliberately does NOT consult the
  // server's `crashed` bit (= exited AND turn-in-flight/live-background-work). `crashed` says only HOW
  // it stopped; a worker that exited at BARE REST — no done fence, turn not in flight — is just as
  // dead and just as unable to move without a nudge, so it earns the same [!] mark. Gating the mark on
  // `crashed` while the Retry verb gated on the process being gone is precisely what let the queue
  // card and the rail row disagree about ONE thread (maintainer 2026-07-23: "the card in the queue has
  // a retry button, but it's not marked as stalled in the sidebar with the yellow and the exclamation
  // point"). The tooltip still names the distinction; the glyph and the verb no longer care about it.
  // Every branch ABOVE wins first, so an archived / needs-input / working / held / done-fenced row
  // keeps its own better-suited mark and affordance even when its process happens to be gone.
  if (canRetry(t)) return "stalled"
  // Bare rest with a LIVE process (turn-idle, nothing pending, NOTHING it launched still running): it
  // can simply be typed at, so it stays the quiet […] and never advertises a recovery verb.
  return "rest"
}

// Whether a thread offers the Retry verb — on EVERY surface: the sidebar rail row, the queue card,
// AND the full thread drawer's header. The load-bearing invariant is that all three surfaces read
// THIS ONE predicate, so no two of them can ever drift apart about a single thread (each time a
// surface kept its own gate, one ended up showing Retry while reading as calm at-rest elsewhere —
// maintainer 2026-07-23, twice).
//
// Two states earn Retry, and they wear DIFFERENT sidebar marks — the verb is shared, the glyph is not:
//   • STALLED — the process is gone with the work unfinished (yellow [!]). The classic case.
//   • KILLED BY A USAGE LIMIT frizz will auto-resume (the yellow hourglass — the "limit" kind). It
//     queues as a failed thread (deriveNeedsYou, 2026-08-31) and frizz continues it itself once the
//     window resets, but the operator with capacity elsewhere shouldn't have to wait, so it gets the
//     same one-click Retry: the same verb, message and RPC as a stall (retrySession sends the very
//     "Continue exactly where you left off." the in-drawer LimitPauseCard already offers) — a faster
//     door from the rail (maintainer 2026-07-23: limit-killed rows want the same one-click retry as
//     stalled rows). This is why offersRetry is NOT simply `kind === "stalled"`. The invariant the
//     maintainer reads the rail by (2026-08-31): EVERY YELLOW ROW carries the hover Retry.
// The "limit" kind keys on the fault's PRESENCE, so a pause frizz will not resume by itself (an
// unknown phrasing, an aged-out fault) still wears the yellow hourglass and this same Retry — for
// that row the Retry is not a shortcut but the only way back.
//
// The drawer used to be deliberately broader — raw `canRetry` (ANY exited owned session) — on the
// theory that the full view should show every recovery option. That was wrong twice over, and it is
// the bug the maintainer hit (2026-07-23, second report): `canRetry` does not consult `state`, so all
// 158 ARCHIVED-and-exited threads on the real board opened with a Retry pill while their rail row
// showed the muted [✓] — "a thread that appears to have just come to rest, with a retry button, not
// yellow, no exclamation point". Nothing is lost by narrowing: the drawer has a composer, and sending
// an archived or done thread a message is already how you reopen it (see StateButton).
export function offersRetry(t: ThreadView): boolean {
  const kind = sessionIndicatorKind(t)
  // Gated on the RESOLVED kinds (never raw limitPause/canRetry) so a higher-priority state that stole
  // the row — a fresh ask, live work, the operator's own snooze — never sprouts a Retry. Both kinds
  // are non-foreign by construction, so each stays a session frizz can actually restart.
  return kind === "stalled" || kind === "limit"
}

// This section is TWO rule-separated bands (the Sidebar draws the rule): the RESTED band (a.k.a. the
// queue, a.k.a. the cue) on TOP, directly beneath the prompt box, then the ACTIVE band — everything the
// human has nothing to answer, spinning or merely in flight — BELOW it. Rested is ordered by the EXACT
// queue comparator (orderQueue), so the rested rows and the queue cards share ONE order. That shared
// order is what makes the scroll-position marker monotonic: scrolling the queue down walks the marker
// straight down the rail instead of hopping around (maintainer 2026-07-15: the queue/sidebar mismatch
// "totally defeats the purpose of the scroll position indicator"; running agents "should not render in
// the queue at all"). Putting the cue first (maintainer 2026-08-08) aligns the rail's top with the
// workpane's top: the first card in the queue is now opposite the first row in the rail. Active rows have
// no queue card, so their own order (orderRunning: newest entry into the band first) never affects the
// marker — grouping them below just
// keeps everything that isn't waiting on the human out of the rested run.
//
// This ORDER IS THE RENDER ORDER: the Sidebar splits the result with partitionActive and draws the two
// bands in the order they come out of here, so the array and the rail can never disagree about which
// band is on top.
export function orderActive(threads: readonly ThreadView[], direction: QueueDirection = "fifo"): ThreadView[] {
  const running = threads.filter(inActiveBand)
  const rested = threads.filter((t) => !inActiveBand(t))
  return [...orderQueue(rested, direction), ...orderRunning(running)]
}

// Split an ALREADY-ordered list (see orderActive) into its Active/Rested bands WITHOUT re-sorting —
// filter() preserves orderActive's order — so the Sidebar can render the separating rule. `.running` is
// the ACTIVE band (spinning, plus the handful of rows that are in flight without a card of their own);
// `.rested` is the queue's rows, exactly one per card. The key is named for the spinner that dominates
// it, the band is named for the maintainer's word — see the vocabulary at the top of this section.
export function partitionActive(active: readonly ThreadView[]): { running: ThreadView[]; rested: ThreadView[] } {
  return {
    running: active.filter(inActiveBand),
    rested: active.filter((t) => !inActiveBand(t)),
  }
}

// Partition threads into the thread-derived sidebar sections. `active` is the Active+Rested section and
// is banded by orderActive (the queue's own order, then the Running band newest entry first); Snoozed
// is plain interaction recency and Done is newest marked done first (orderDone).
// `pinned` rides beside the three SectionKey buckets rather than inside them (see isPinned): a pinned
// row must be claimable by NO band, and keeping it out of the Record is what makes that true by
// construction instead of by every band remembering to exclude it.
export type SectionedThreads = Record<SectionKey, ThreadView[]> & { pinned: ThreadView[] }
export function sectionThreads(threads: readonly ThreadView[], direction: QueueDirection = "fifo"): SectionedThreads {
  const out: SectionedThreads = { pinned: [], active: [], snoozed: [], inactive: [] }
  // Only the threads that can still move are classified; every SETTLED thread is a Done row
  // (lib/boardPartition), and on a long-lived board that is nearly all of them.
  const { live, settled } = partitionBoard(threads)
  for (const t of live) {
    if (t.kind === "session" && t.foreign === true) continue // foreign sessions never row (nor strip — dropped)
    if (isPinned(t)) {
      out.pinned.push(t)
      continue
    }
    const k = sectionOf(t)
    if (k) out[k].push(t)
  }
  // Pin order, oldest pin first: the band is a shelf the human arranged, so nothing about the threads'
  // own activity may reorder it. Slug tiebreak keeps two same-instant pins stable across renders.
  out.pinned.sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? "") || a.id.localeCompare(b.id))
  // The Done band in BOARD order, as the sort below has always received it (its ties keep that order).
  // Almost always the settled list itself; a live thread classified Done (archived with a delivery in
  // flight, say) is rare enough to merge by walking the board.
  if (out.inactive.length === 0) out.inactive = settled as ThreadView[]
  else {
    const liveDone = new Set(out.inactive)
    out.inactive = threads.filter((t) => liveDone.has(t) || settledThread(t))
  }
  out.active = orderActive(out.active, direction)
  out.snoozed = orderByInteraction(out.snoozed)
  out.inactive = orderDone(out.inactive)
  return out
}

// THE DONE BAND'S ORDER, KEPT while its members are the same objects. The band holds every thread the
// project ever finished and almost never changes, but sectionThreads runs on every board delta — a
// worker streaming its turn moves one thread, and the Done band was sorted again each time: a key and a
// Date.parse per thread, then the sort, ~2.4ms of every delta at 5,000 threads (CPU profile, production
// bundle). The band arrives in board order, which a delta never reorders, so "the same members" is one
// identity check per slot; a thread archived, reopened or replaced misses and sorts afresh.
//
// The same-objects rule is what makes the reuse exact: a Done row's sort key (doneAt) reads only
// the thread itself, never the clock. Two entries, because the rail and the phone board each section
// the same board with their own overlays in between.
const doneOrders: { input: readonly ThreadView[]; out: ThreadView[] }[] = []
export function orderDone(input: ThreadView[]): ThreadView[] {
  for (const hit of doneOrders) {
    if (hit.input === input) return hit.out
    if (hit.input.length !== input.length) continue
    let same = true
    for (let i = 0; i < input.length; i++) {
      if (hit.input[i] !== input[i]) {
        same = false
        break
      }
    }
    if (same) return hit.out
  }
  const out = byKey(input, doneAt, -1)
  doneOrders.unshift({ input, out })
  doneOrders.length = Math.min(doneOrders.length, 2)
  return out
}
