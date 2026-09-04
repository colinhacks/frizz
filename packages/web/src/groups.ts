import { isDirectSubAgent, queuedThread, type AwaitingHint, type ThreadView } from "@frizz/shared"
import { canRetry } from "./lib/status.ts"

// Shared listing logic: the queue definition (needsAction), the sidebar's status-keyed sections
// (sectionThreads), and the interaction-recency ordering both surfaces use.

// The title to SHOW for a thread: prefer trustworthy backend title telemetry once it exists, else the
// provenance-aware stored title. One place so every render site (sidebar, palette, header) agrees.
// The narrow Pick accepts a valtio readonly snapshot as readily as a plain ThreadView.
export function displayTitle(t: Pick<ThreadView, "title" | "aiTitle" | "id" | "titleAuto" | "titleLocked" | "spawnedAt" | "backend" | "runtime" | "foreign">): string {
  // An EXTERNAL row is already named. The server resolves it in foreignThreadView — the harness's own
  // name, else a chop of the opening human turn, else a short id — which is the order both agents'
  // resume pickers use, and it stores the result in `title`. Every rule below is about a row frizz
  // DISPATCHED: a placeholder for a name that is on its way, a raw prompt frizz seeded and must never
  // show. Neither describes a terminal session, and the codex rule in particular replaced every
  // external codex row's resolved name with "Untitled thread" the day the server learned to name them
  // (maintainer 2026-08-24: "for my externals all the codexes show up as 'untitled thread'").
  if (t.foreign === true && t.title.trim()) return t.title.trim()
  // A machine-guessed dispatch title (titleAuto) with no aiTitle yet is NOT a real name — show the
  // "Spinning up…" placeholder while the session is genuinely just spinning up (maintainer 2026-07-10:
  // "do not try to guess at the thread title"). But that's BOUNDED (see titleIsProvisional): a session
  // Claude that never yields an aiTitle falls back after its bounded window; Codex gets a shorter
  // grace and then the neutral fallback below.
  if (titleIsProvisional(t)) return SPINNING_UP_TITLE
  // The worker's OWN name for its task wins over whatever the row was seeded with — unless a human has
  // claimed the name, in which case a stale/slug-shaped backend record must never displace it.
  if (t.aiTitle?.trim() && !titleIsHumanOwned(t)) return readableMachineTitle(t.aiTitle)
  // Codex's TUI has no native automatic naming event. Frizz asks the first finalized response for a
  // hidden title signal; omission or malformed syntax must stay neutral rather than exposing either
  // the stored legacy prompt heuristic or a provider-recorded raw initial prompt.
  if (t.backend === "codex" && t.titleAuto === true && !t.aiTitle?.trim()) return UNTITLED_THREAD_TITLE
  // `titleAuto === false` means the stored title is a real name, not the prompt chop — a human rename,
  // or a caller's dispatch title standing in until the worker names the thread itself. Unknown legacy
  // rows retain the historical aiTitle-first fallback because their provenance is unavailable.
  if (t.titleAuto === false && t.title.trim()) return t.title
  // For machine-titled rows, an internal slug is not a display title. This is especially important
  // around native `/rename`: if Claude fails to emit a custom title, the header must keep a neutral
  // name rather than presenting the session identifier as though rename succeeded. Legacy rows
  // (unknown titleAuto) retain the historical id fallback.
  if (t.title.trim() && !(t.titleAuto === true && t.title.trim() === t.id)) {
    return t.titleAuto === true ? readableMachineTitle(t.title) : t.title.trim()
  }
  return t.titleAuto === true ? UNTITLED_THREAD_TITLE : t.id
}

// Has a HUMAN claimed this thread's name? Only then does the stored title outrank the backend's own
// aiTitle. Mirrors the server's `sessionTitleLocked` exactly, including its fallback: a row with no
// `titleLocked` predates the split, so any non-guessed title there is read as the human's. That
// fallback is what keeps a legacy rename safe, and what makes `titleLocked: false` — written only by a
// dispatch whose title a CALLER hard-coded — the sole way a real-looking title stays replaceable.
function titleIsHumanOwned(t: Pick<ThreadView, "titleAuto" | "titleLocked">): boolean {
  return t.titleLocked ?? t.titleAuto === false
}

// Backend-generated titles are not human metadata. Claude's native auto-rename currently reports a
// semantic kebab slug; humanize that immediately so even the short generate→confirm interval can
// never paint an internal identifier. Explicit/manual titles bypass this helper above and stay exact.
// SENTENCE case (capitalize only the first word) — thread titles follow the repo copy rule (see
// AGENTS.md), never Title Case; mirrors the server's humanizeClaudeTitle so the generate→confirm
// interval and the persisted rename read identically.
export function readableMachineTitle(raw: string): string {
  const title = raw.trim()
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(title)) return title
  const words = title.split(/[-_]+/).filter(Boolean)
  if (words.length === 0) return title
  const joined = words.join(" ").toLowerCase()
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

// The placeholder shown (dimmed) while a freshly-dispatched thread has only a machine-guessed title.
export const SPINNING_UP_TITLE = "Spinning up a thread…"
export const UNTITLED_THREAD_TITLE = "Untitled thread"

// Both backends are bounded by a TIME window — Codex's is shorter because its title signal rides the
// first finalized response rather than a separate naming event. (This once read "Codex uses its
// concrete spawning runtime state"; nothing ever emitted that state. See titleIsProvisional.)
const SPIN_UP_MS = 60_000
const CODEX_TITLE_SIGNAL_GRACE_MS = 15_000

// A title is PROVISIONAL when it's the auto-guessed dispatch slug, Claude hasn't named the session yet
// (titleAuto && no aiTitle), AND the dispatch is still WITHIN the spin-up window. The time bound is
// load-bearing: a long session that compacts gets a NEW transcript id, so frizz (still tracking the
// pinned id) loses the transcript and never sees an aiTitle — without the bound the row would stick on
// "Spinning up…" forever (maintainer 2026-07-10). After the window it falls back to the dispatch title.
// Root cause of the lost transcript is tracked separately ([[session-transcript-drift]]).
export function titleIsProvisional(t: Pick<ThreadView, "aiTitle" | "titleAuto" | "spawnedAt" | "backend" | "runtime">): boolean {
  if (!t.titleAuto || t.aiTitle) return false
  // Codex now emits its title in the first assistant commentary, normally a couple seconds after the
  // rollout starts. Keep the neutral startup label through that short, bounded title-signal grace so
  // the row never flashes "Untitled thread" between task_started and the comment. A noncompliant or
  // failed worker still degrades to the neutral fallback after the grace; it can never stick here.
  if (t.backend === "codex") {
    // DEAD BRANCH, kept deliberately. `deriveRuntime` (board.ts) has no `"spawning"` return — the
    // state is on the wire enum and nothing emits it — so the grace below is what actually bounds a
    // codex row, and a dispatch whose title signal lands after it flashes "Untitled thread". Waking
    // this branch means making the server emit `spawning`, which changes what every other reader of
    // `runtime` sees; it is not a comment fix. Left as the honest record of the intended shape.
    if (t.runtime === "spawning") return true
    const spawned = Date.parse(t.spawnedAt ?? "")
    return Number.isFinite(spawned) && Date.now() - spawned < CODEX_TITLE_SIGNAL_GRACE_MS
  }
  const spawned = Date.parse(t.spawnedAt ?? "")
  return Number.isFinite(spawned) && Date.now() - spawned < SPIN_UP_MS
}

// A thread "needs action" when it is genuinely waiting on the human — and ONLY once the agent has
// actually come to rest on that wait. A mid-turn thread is still working; surfacing it as a card
// gives an empty "no ask" card because the ask text lands only when the turn ends. These sort to top.
export function needsAction(t: ThreadView): boolean {
  // A TERMINAL thread (done/dismissed) NEVER cards — no exceptions. The thread file is the source
  // of truth, and a thread whose own status says the work is over has by definition nothing waiting
  // on the human. (An earlier "done-but-unread = card until acknowledged" rule violated this and
  // was explicitly overruled by the maintainer: a done thread must never appear in the queue.)
  if (t.status === "done" || t.status === "dismissed") return false
  // THE OPERATOR'S OWN PARK COMES FIRST, exactly as the server orders it (deriveNeedsYou checks
  // futureSnooze ahead of every ask gate). Without it this predicate promoted rows the server had
  // already dequeued — a snoozed thread with an unanswered ask sorted to the top of the attention order
  // and led the mobile asks-first list, with no card behind it to open. Same pair of guards as
  // sessionIndicatorKind, for the same reasons.
  if (futureSnoozedUntil(t) !== undefined && isSnoozed(t)) return false
  // Paused on an interactive permission prompt: the process is parked waiting on the human's answer.
  if (t.runtime === "perm-prompt") return true
  // Frozen at a native AskUserQuestion TUI dialog (safety net for pre-contract / adopted sessions that
  // bypass the thread-file ask channel). Unlike the chat/needs-human nets below, NO rest-gate: the ask
  // text lives in the tool_use input (tailer-captured) and is available even while the turn reads
  // "running" (the session is blocked mid-tool_use), so it should card the moment it appears.
  if (t.pendingAsk) return true
  // The DECLARED awaiting-you channel: humanBlocked is re-derived server-side from `status:
  // needs-human` — the first-class "awaiting a human" state and THE queue definition. TWO gates:
  //   • NOT mid-turn (running/spawning): the worker writes needs-human MID-TURN (~150ms after the
  //     file hits disk), but the visible ask text lands with the final message only when the turn
  //     comes to rest — counting it early yields a card with no visible ask.
  //   • A SESSION EXISTS (runtime !== "none"): the queue is strictly "agent work paused on the
  //     human" (maintainer, 2026-07-09: with no agent it makes no sense for a thread to ever show
  //     up inside the queue). A needs-human thread worked OUTSIDE frizz (frizz classic, hand
  //     edits) has no transcript to card — it stays visible in the SIDEBAR (yellow awaiting-you
  //     dot), and its click-through composite (doc + kick-off composer) is where it gets read and
  //     acted on. `exited` still cards: that agent RAN and asked here — the ask is in its transcript.
  if (t.humanBlocked && t.runtime !== "none" && t.runtime !== "running" && t.runtime !== "spawning") return true
  // DERIVED safety net behind the declared needs-human channel: a worker that asked the human a
  // question IN CHAT (a ```question block in its final message) but never flipped its thread file to
  // needs-human — the board would otherwise see {active, humanBlocked:false, turn-idle} and show
  // nothing. Same rest-gate: only once the agent is off-turn (else the ask text hasn't landed).
  if (t.pendingQuestion && t.runtime !== "running" && t.runtime !== "spawning") return true
  // A REGISTERED question (open thread_question rows on the view) is the same ask through the durable
  // channel — the server queues it once at rest (deriveNeedsYou's openQuestions), and this predicate
  // must agree so the mobile asks-first ordering and the attention sort count it. Same rest-gate as the
  // fence net above: the worker keeps working after registering, and the card lands at its rest.
  if ((t.questions?.length ?? 0) > 0 && t.runtime !== "running" && t.runtime !== "spawning") return true
  // CRASH / STALL net (replaces the old `unread`-gated clause — `unread` no longer drives anything).
  // A thread whose status still claims WORK IN FLIGHT (active or planning) but whose backing agent
  // PROCESS is gone — `exited` (session row present, worker process dead) or `none` (registry lost the row)
  // — is a crash/stall the human must see. Deliberately SCOPED to the in-flight work statuses, because
  // "an agent died MID-WORK" is exactly active/planning:
  //   • `blocked` is a MACHINE-wait — its agent is LEGITIMATELY absent (waiting on revalidate_at /
  //     blocking_threads), and a killed/rebooted session (the workers die → every spawned thread goes
  //     exited/none) must NOT card it or steal its timer/threads glyph (Nav short-circuits on
  //     needsAction before those glyphs). blocked never cards — that's the spec.
  //   • `needs-human` with a session already cards via the humanBlocked clause above (session-less
  //     needs-human deliberately does NOT card — see that clause); `done`/`dismissed` are excluded
  //     by the terminal guard; `planned` is not-yet-started backlog.
  // No fight with the humanBlocked clause: this net requires status active/planning, which
  // needs-human never is; and its `none` case requires spawnedAt (a session RAN then vanished from
  // the registry — a real crash), which a never-spawned thread lacks.
  // Also gated on `spawnedAt` (a NEVER-spawned item never "died mid-work") and `!archived` (a hidden
  // thread never cards, even if its archive→done write lost a race).
  if (
    (t.status === "active" || t.status === "planning") &&
    (t.runtime === "exited" || t.runtime === "none") &&
    t.spawnedAt &&
    !t.archived
  )
    return true
  return false
}

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
// a steer flips the thread to running, and only its next REST re-times it. A RUNNING row is not in the
// queue/rested band — it belongs to the active rail, ordered by user recency — so it keeps
// `interactionAt` (max lastUserAt/spawnedAt), which also guards against mid-turn churn. Missing rest
// time (never produced output yet) → `interactionAt` (spawn/last-user). `isActivelyRunning` is hoisted.
function lastActiveAt(t: ThreadView): number {
  if (isActivelyRunning(t)) return interactionAt(t)
  const rest = Date.parse(t.lastAssistantAt ?? "")
  return Number.isFinite(rest) ? rest : interactionAt(t)
}

// The timestamp the "Last active" label should DISPLAY, kept in lockstep with the order key so the
// queue's labels read monotonically and never lie. A RUNNING row shows its live activity
// (`lastActivityAt` — "just now" while it works); an AT-REST row shows its rest time (`lastAssistantAt`),
// so a background sub-agent completing can never flip a rested row's label to "just now". Falls back to
// lastActivityAt then spawn when a backend never recorded the rest instant (legacy/foreign rows).
export function lastActiveLabelAt(t: Pick<ThreadView, "runtime" | "lastActivityAt" | "lastAssistantAt" | "spawnedAt" | "subAgents" | "bgShells">): string | undefined {
  if (isActivelyRunning(t as ThreadView)) return t.lastActivityAt ?? t.spawnedAt
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
// running band and the Snoozed/Inactive sections — surfaces where newest-on-top is always wanted (the
// FIFO/LIFO preference governs only the queue/rested band via orderQueue). A running row keys off its
// stable user-interaction time (lastActiveAt's churn guard), so live agent motion never reshuffles it;
// an at-rest row keys off when it came to rest, matching its "Last active" label. New array; input
// untouched.
export function orderByInteraction(threads: readonly ThreadView[]): ThreadView[] {
  return [...threads].sort((a, b) => {
    const d = lastActiveAt(b) - lastActiveAt(a)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
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
  const dir = direction === "lifo" ? -1 : 1
  return [...threads].sort((a, b) => {
    const age = (lastActiveAt(a) - lastActiveAt(b)) * dir
    return age !== 0 ? age : a.id.localeCompare(b.id)
  })
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
  return threads.filter((t) => t.kind === "session" && t.foreign === true)
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
//                        blocked+timer status) AND no live background op. Its own DIMMED band between
//                        the rested rows and Done. The glyph and section share isSnoozed(), so a row can
//                        never show a clock/hourglass while sitting in the Active/Rested section.
//   • inactive         — state === "archived" (the only archiver is an explicit Archive / done-card
//                        button). Rendered under the label DONE — the key and the label differ.
//   • legacy           — kind !== "session": vestigial .frizz-file rows, hidden entirely (null).
// A FOREIGN session row (a maintainer terminal — no registry row, so no state/needsYou) is dropped
// entirely (never rows). Order within a section is interaction recency.
export type SectionKey = "active" | "snoozed" | "inactive"
// Thread-derived buckets, in render order.
export const SECTION_ORDER: readonly SectionKey[] = ["active", "snoozed", "inactive"]

// PINNED — the human lifted this thread out of the band system entirely (maintainer 2026-09-02). Not a
// SectionKey on purpose: sectionOf stays the pure state-derivation it is, and the pin is a human
// override applied ABOVE it (sectionThreads diverts these rows before sectionOf runs), the same
// altitude as the foreign drop. Deliberately ignores state: the pin outranks Done, Snoozed and the
// queue alike — that is the whole feature.
export function isPinned(t: ThreadView): boolean {
  return t.kind === "session" && t.foreign !== true && typeof t.pinnedAt === "string"
}

// A session process is "at rest" (off-turn) when the pane is idle or the session has exited — the gate
// an awaiting excusal needs (a mid-turn worker is still working, never awaiting).
function atRest(t: ThreadView): boolean {
  return t.runtime === "turn-idle" || t.runtime === "exited"
}

// DECLARED PARK: at rest behind an ```awaiting fence — the thread ITSELF declared it is parked, not
// still working. The current contract reserves this for a human gate/timer; legacy hints remain readable. The
// RAW signal; the banding below refines it into external-vs-internal. NB: this requires the worker to
// actually emit the fence — a thread that rests bare (prose only) reads as idle/waiting, not declared.
function isDeclaredAwaiting(t: ThreadView): boolean {
  return atRest(t) && t.lastFence?.kind === "awaiting"
}

// INTERNAL WORK: a thread with a LIVE sub-agent is awaiting its OWN dispatched child — not an external
// event — so it is a fully ACTIVE thread and must never be dimmed (maintainer 2026-07-10: "when an
// agent is merely awaiting its own sub-agents, we should NOT dim it — that's the differentiator").
// Direct children only, matching the server's hasLiveBackgroundWork: `subAgents` also carries the live
// DESCENDANTS under those children so the rows can nest, and those are a rendering concern that must
// never move thread state (see isDirectSubAgent). A running descendant sits under a running direct child
// anyway, so the reading is unchanged — this keeps it that way by construction rather than by luck.
function hasLiveSubAgents(t: ThreadView): boolean {
  return (t.subAgents ?? []).some((s) => isDirectSubAgent(s) && s.state === "running")
}

// A background Bash/Monitor does NOT make its thread live (maintainer 2026-07-22). `run_in_background`
// means only "don't block my turn": a vite dev server and a CI watcher are indistinguishable through
// it, and 26% of real background launches are long-lived servers that will never end. Treating them
// as live work spun a finished thread forever and kept it out of the queue. `bgShells` stays as
// transcript-level telemetry (the "background running" chip) — it just no longer speaks for the
// THREAD. A worker that genuinely wants to wait dispatches a sub-agent to own the wait.
//
// `awaitingBackground` is the ONE exception, and it is not `bgShells` by another name: it is SERVER
// truth (board.deriveAwaitingBackground) meaning "at rest, its own dispatched work is still live, and
// nothing harder outranks that". Reading it here is what keeps the bands honest for a thread with no
// queue card behind it — the server excuses a rest on a live SUB-AGENT from the queue (2026-07-30), so
// without this a live-but-cardless row would fall into the RESTED band, which is the queue-ordered band,
// with nothing behind it: the exact 2026-07-29 report, "showing up as a rested thread in my sidebar, yet
// there's no card for it". (That report was an EVENT-SNOOZED shell-only rest, which is cardless too; since
// 2026-08-28 that one parks in Snoozed instead — isSnoozed reads `bgSnoozed` ahead of this flag — so this
// flag no longer bands it. An UNsnoozed shell-only rest DOES card since 2026-08-04, and `needsYou` then
// bands it below the rule regardless — see inActiveBand. This flag decides nothing for it beyond keeping
// it out of Snoozed.)
//
// It does NOT re-spin finished threads. What the row reads as is a separate decision made downstream in
// sessionIndicatorKind, and a shell-only rest gets the quiet pulsing dot there, never the spinner — the
// 2026-07-22 worry (a dev server spinning its thread forever) is answered by the GLYPH.
//
// AND THE FLAG NO LONGER MEANS WHAT THE PARAGRAPH ABOVE SAYS, WHICH IS WHY THE TIMER CARVE-OUT EXISTS.
// `awaitingBackground` was "its own dispatched work is still live" when this read it, and the sentence
// that made that safe — deriveAwaitingBackground drops any fenced thread — stopped being true in three
// steps: a parked PR watch (2026-08-13), a declared background park, and an ARMED TIMER (2026-08-24,
// f50f9e60). The flag now means "at rest behind a declared wait the resting card should state", which
// includes a park with NOTHING running behind it at all. See parkedOnArmedTimerAlone.
function hasLiveOps(t: ThreadView): boolean {
  if (hasLiveSubAgents(t)) return true
  return t.awaitingBackground === true && !parkedOnArmedTimerAlone(t)
}

// AN ARMED TIMER IS A PARK, NOT LIVE WORK — it is the archetypal Snoozed row, and it was the one park that
// could never reach the band. A `timers:` fence names a future wake and launches nothing, so when the
// server widened `awaitingBackground` to cover it (f50f9e60, so the resting card could state the wait),
// hasLiveOps read that through its old meaning and isSnoozed's very FIRST gate threw the thread into the
// Active band — the band ARCHITECTURE.md reserves for rows with no queue card and something in flight,
// against its own definition of Snoozed: "a declared `human:` gate, a valid future `timer:`, a user
// wall-clock snooze, or a limit pause frizz will auto-resume". Reported 2026-08-26 on a thread parked on
// a Sept-2 timer: "showing up in a separate rail that isn't held".
//
// ALONE is the whole predicate. Anything else behind the same fence keeps the row visible and undimmed,
// exactly as it is today: a live child or shell is own work in flight (maintainer 2026-07-10, "when an
// agent is merely awaiting its own sub-agents, we should NOT dim it"), and a PR watcher is a handoff
// that must never vanish into the dimmed band (see parkedAwaitingHint, maintainer 2026-07-22). Reading
// raw `bgShells` is safe in that direction where it would not be in hasLiveOps: this is already gated on
// the server's own verdict and only ever keeps a thread OUT of Snoozed, so a stale shell costs a dimming,
// never a disappearance — the same argument restingOnLiveBackgroundWork makes below.
function parkedOnArmedTimerAlone(t: ThreadView): boolean {
  if (t.awaitingBackground !== true) return false
  const watches = t.watches ?? []
  if (!watches.some((w) => w.kind === "timer" && w.state === "armed")) return false
  if (hasLiveSubAgents(t) || (t.bgShells ?? []).some((s) => s.state === "running")) return false
  return !watches.some((w) => w.kind === "github" && w.state === "armed")
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

export function futureSnoozedUntil(
  t: Pick<ThreadView, "snoozedUntil">,
  nowMs = Date.now(),
): string | undefined {
  const at = Date.parse(t.snoozedUntil ?? "")
  return Number.isFinite(at) && at > nowMs ? t.snoozedUntil : undefined
}

// HELD: one semantic predicate owns both classification and presentation. Only a specific external
// human/review gate or a valid FUTURE timestamp belongs in the dimmed Snoozed band. Legacy automated
// waits (pr/ci/session), malformed/elapsed timers, and hintless fences stay OUT of it — rested (in the
// queue) if their turn is over, Active if it isn't — so they cannot hide work an agent should own
// through an in-band watcher. A canonical blocked+timer status remains a compatibility path only when
// it carries the same explicit future ISO instant. A live child/Monitor wins, and archived rows go Done.
export function isSnoozed(t: ThreadView, nowMs = Date.now()): boolean {
  const userSnooze = futureSnoozedUntil(t, nowMs) !== undefined
  if (t.state === "archived") return false
  // THE RESTING CARD'S EVENT-SNOOZE IS A PARK THE HUMAN MADE, and it parks into Snoozed exactly as the
  // wall-clock snooze does. It arrives as `bgSnoozed` (server truth: bg_snooze_rested_at equals the
  // current rest) on a thread resting behind a shell, a PR watch or a timer — the three shapes whose
  // queue card carries that snooze. Until 2026-08-28 the gate below read `hasLiveOps` alone, and that
  // predicate reads `awaitingBackground`, which the server keeps TRUE across the snooze (the flag states
  // what the thread waits on, and a snooze does not change that) — so the click took the card away and
  // left the row in the Active band, undimmed, wearing an at-rest mark. Reported on a thread parked on a
  // green PR (maintainer 2026-08-28: "It's resting and snoozed, and for some reason it's in the actively
  // running rail instead of a snoozed rail"). A live SUB-AGENT still wins, as it does over every park:
  // a child's return re-invokes the parent within seconds, so that row keeps spinning in Active
  // (maintainer 2026-07-10, "when an agent is merely awaiting its own sub-agents, we should NOT dim it").
  const eventSnooze = t.bgSnoozed === true && t.runtime === "turn-idle"
  if (hasLiveSubAgents(t) || (hasLiveOps(t) && !eventSnooze)) return false
  // A user-owned snooze deliberately wins over a concrete ask, permission prompt, or crash. Those
  // states still exist in the transcript/runtime and re-enter Queue at the exact wake deadline; the
  // snooze merely parks their presentation until then. Mid-turn work keeps spinning in the Active band,
  // while a provider permission prompt is itself parked and may therefore move to Snoozed.
  if (userSnooze) return t.runtime !== "running" && t.runtime !== "spawning"
  // A LIMIT KILL OUTRANKS EVERY PARK BELOW (2026-08-31). The fault postdates any ```awaiting fence the
  // worker left at its LAST rest, so letting `declaredWait` below claim the row would park a killed
  // thread on a stale story. The server already queues it (needsYou, next line), but the mark and the
  // band must not hinge on that flag arriving: a limit-killed thread is never Snoozed unless the
  // OPERATOR snoozed it (userSnooze above, which wins by design). PRESENCE, not `autoResume`: a fault
  // frizz cannot promise to resume (an unknown phrasing, an aged-out pause) is MORE the human's
  // problem, not less.
  if (t.limitPause && t.foreign !== true) return false
  // Without an explicit user snooze, higher-priority attention states render ?, !, or a native
  // prompt—not a wait glyph—so a stale awaiting fence cannot demote them out of Queue.
  if (t.needsYou || t.pendingAsk || t.runtime === "perm-prompt") return false
  if (!atRest(t)) return false
  // (A limit pause used to return true here — "parked on the clock with a wake already armed" — until
  // 2026-08-31. It is now the hard NON-snooze gate above, and the queue's problem: see deriveNeedsYou.)
  // The event-snooze needs no fence behind it: a shell-only rest cards without one and its snooze is the
  // same click. It expires by itself at the thread's next rest, which is the wake the human asked for.
  if (eventSnooze) return true
  // THE SERVER ALREADY DECIDED THIS, and the client must not re-derive it. A park is honoured only when
  // every item the fence names is still live — checked against telemetry and the registries, which the
  // browser cannot see (board.hasDeclaredBackgroundPark). What reaches here is that verdict: the server
  // excuses an honoured park from the queue, so by this line `!t.needsYou` and `atRest(t)` already hold,
  // and an `awaiting` fence on top of them means the park was checked and stood.
  //
  // Reading the HINTS instead is what the deleted grammar did, and it is exactly why a worker could park
  // itself on `human: Alice` or an instant already in the past: the client believed the assertion.
  const declaredWait = t.lastFence?.kind === "awaiting"
  return userSnooze || declaredWait
}

// ACTIVELY RUNNING: a live session with work in flight — running/spawning, or turn-idle while a
// dispatched sub-agent is still going. NOT the same as the ACTIVE band, and the gap is the whole reason
// `inActiveBand` exists: this is true of a queued thread too, and a queued thread belongs to Rested no
// matter how much live work it has out. Read this as "has motion", and `inActiveBand` as "is Active".
// A running thread must NEVER be filed under Done, even when its row is archived (maintainer
// 2026-07-10, hit 3×: a bumped-then-resumed archived thread showed a spinner under the archived band).
export function isActivelyRunning(t: ThreadView): boolean {
  if (t.runtime === "running" || t.runtime === "spawning") return true
  return t.runtime === "turn-idle" && hasLiveOps(t)
}

// A QUEUE HANDOFF THAT HAS ALREADY COME TO REST: the server queued it (`needsYou`) and the thread's
// OWN turn is over (turn-idle/exited). It must not make the PARENT's rail mark claim motion the parent
// does not have (maintainer 2026-07-27: "when an agent comes to rest and shows up in the queue, it
// should get the ellipsis indicator in the sidebar, even though its sub-agents are still spinning").
// The children keep their own spinners on their own indented rows (Sidebar SubAgentRows → ChildOpRow);
// the parent's indicator speaks for the parent. A queued row therefore sits in the rested band AND
// reads as rested.
//
// SINCE 2026-07-30 the live-SUB-AGENT case no longer reaches here at all: the server now excuses such a
// thread from the queue entirely (board.deriveNeedsYou), so `needsYou` is false and the row keeps its
// spinner in the running band — which is the point, since a row that never leaves that band never
// churns between the two. The maintainer's ellipsis rule was scoped to a row that "shows up in the
// queue", and one that no longer does has no reason to change appearance on resting.
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
  // AN ARMED TIMER IS MOTION THE SAME WAY RUNNING CI IS: a wake with a known terminal instant that
  // frizz itself delivers. Timer watch rows landed 2026-08-24 (f50f9e60), after this predicate was last
  // touched, so a timer park wore the bare-rest ellipsis — the mark reserved for "NOTHING it launched
  // still running". Only ARMED rows count: the board only synthesizes armed timer rows today, but a
  // fired or cancelled one, should it ever reach here, is settled — not motion — like a green PR below.
  //
  // A FENCED timer park no longer reaches this line at all: it is Snoozed now (parkedOnArmedTimerAlone) and
  // takes the hourglass two branches up, which is a strictly better mark than the dot. What still lands
  // here is a timer armed WITHOUT an ```awaiting fence naming it — a thread that set an alarm and kept
  // going, then came to rest — where the dot is exactly right: nothing is parked, but a wake is coming.
  if ((t.watches ?? []).some((w) => w.kind === "timer" && w.state === "armed")) return true
  return (t.watches ?? []).some(
    (w) => w.kind === "github" && w.state === "armed" && w.github?.checks === "running" && w.github.state === "open",
  )
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
 *  THE REGISTERED WATCH IS THE PRIMARY SIGNAL, not the fence. `mcp__frizz__watch_pr` creates the row
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
  return t.lastFence?.kind === "awaiting" && t.lastFence.hints.some((h) => h.kind === "pr" && h.value.trim() !== "")
}

// One status-priority decision shared by the sidebar renderer and its tests. The order is important:
// an archived row at rest stays archived even if stale attention metadata lingers; a real human ask
// stays a question after the worker exits; live work stays working; and a completed handoff stays a
// check instead of being mislabelled as a crash merely because `needsYou` also puts it in the queue.
export type SessionIndicatorKind = "archived" | "needs-input" | "working" | "background" | "pr" | "done" | "stalled" | "limit" | "snoozed" | "rest"

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
// The footer's RecurringPromptControl carries the state instead, where it is legible and editable.

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
  // futureSnoozedUntil so ONLY the operator's own wall-clock park takes this branch: a declared wait or
  // an event-snooze leaves the thread QUEUED server-side, where the ask is reachable and the [?] is true.
  if (futureSnoozedUntil(t) !== undefined && isSnoozed(t)) return "snoozed"

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
  if ((t.questions?.length ?? 0) > 0) return "needs-input"

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
  if (t.lastFence?.kind === "done" && atRest(t)) return "done"
  // AWAITING A PR — GitHub's own mark, in whichever band the row sits (awaitingPrWatch). ABOVE the
  // background dot because a watched PR is not this machine's work: a dev server the thread also left
  // running is not what it is waiting FOR, and the dot said "something here is alive" about a wait whose
  // subject is a review queue somewhere else. BELOW the done fence and the limit kill, which are both
  // later facts than the park — a killed or dismissed thread is not awaiting anything.
  if (awaitingPrWatch(t)) return "pr"
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

export function sectionOf(t: ThreadView): SectionKey | null {
  // MAINTAINER 2026-07-09 (v2 sections): ONE section for open work — anything running, awaiting the
  // human, or machine-awaiting lands here (the split sections made seen-clearance visibly shuffle rows
  // between Needs-you and Working on click, which read as an unread feature). It is the Active AND
  // Rested bands together; the rule between them is drawn downstream (partitionActive), and the
  // needs-you/awaiting distinction renders as the row INDICATOR and the queue cards, not as sections.
  // Legacy (.frizz-file) rows are HIDDEN entirely (null; not even a shelf). Foreign never rows.
  if (t.kind !== "session") return null
  // Archived → Done, UNLESS it's actively running: a live, in-flight session must never sit under Done
  // (maintainer, hit 3×). It shows in the Active band with its spinner while it works, and drops back
  // to Done only once it comes to rest still-archived. (A user BUMP un-archives it for good via
  // resume; this is the display safety net for a running-yet-archived session.)
  if (t.state === "archived" && !isActivelyRunning(t)) return "inactive"
  // Only truthful human/future-timer waiters split into the labeled, dimmed Snoozed band. Everything else
  // open — running, needs-you, bare rest, done-fenced, awaiting-its-own-subs, or an awaiting
  // `session`/hintless wait — belongs to the Active/Rested section, which band decided downstream.
  if (isSnoozed(t)) return "snoozed"
  return "active"
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
// no queue card, so their interaction-recency order never affects the marker — grouping them below just
// keeps everything that isn't waiting on the human out of the rested run.
//
// This ORDER IS THE RENDER ORDER: the Sidebar splits the result with partitionActive and draws the two
// bands in the order they come out of here, so the array and the rail can never disagree about which
// band is on top.
export function orderActive(threads: readonly ThreadView[], direction: QueueDirection = "fifo"): ThreadView[] {
  const running = threads.filter(inActiveBand)
  const rested = threads.filter((t) => !inActiveBand(t))
  return [...orderQueue(rested, direction), ...orderByInteraction(running)]
}

// THE RULE THE CUE IS DRAWN ON: a row belongs above it EXACTLY WHEN it has a queue card. Everything
// else in this section — spinning or not — belongs below, in the Active band.
//
// THE INVARIANT, both directions (maintainer 2026-08-01: "if something is listed as currently running,
// then it should never show up in the queue"): nothing in this band has a card, and every card has a row
// in the cue above the rule. `needsYou` IS the queue (see `queued`, which within this section reduces to
// exactly this field — foreign rows never section, and the server clears needsYou on an archived row),
// so keying the split on it alone is what makes both halves true by construction rather than by every
// upstream excusal remembering to band its own threads.
//
// It used to read `isActivelyRunning(t) && t.needsYou !== true`, which enforced only the first half. The
// second half was left to the SERVER: a thread it excused from the queue was expected to be either Snoozed
// or visibly alive (`awaitingBackground`, which is what puts a shell-only or CI-holding rest in this
// band). Every excusal that forgot dropped its thread into the cue with nothing behind it — a row that
// looks queued, has no card, and opens a DRAWER on click instead of scrolling to one. Reported
// 2026-07-29 on a snoozed shell-only rest ("there's no card for it in the UI — when I click it, it opens
// it in a drawer") and again 2026-08-14 on a stale delivery ledger, which is a queue excusal with no
// banding of its own at all (board.ts hasFreshDelivery). Two different upstream bugs, one symptom,
// because the rule the maintainer actually reads the rail by was never written down here.
//
// A cardless row below the rule states the truth in every case that reaches it: the human has nothing to
// answer, and something — a child, a shell, CI, a follow-up in flight — is between this thread and its
// next rest. It wears its own at-rest mark there (sessionIndicatorKind), so it never fakes a spinner.
function inActiveBand(t: ThreadView): boolean {
  return t.needsYou !== true
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
// is banded by orderActive (spinning rows first, then the queue's own order); Snoozed and Done are plain
// interaction recency.
// `pinned` rides beside the three SectionKey buckets rather than inside them (see isPinned): a pinned
// row must be claimable by NO band, and keeping it out of the Record is what makes that true by
// construction instead of by every band remembering to exclude it.
export type SectionedThreads = Record<SectionKey, ThreadView[]> & { pinned: ThreadView[] }
export function sectionThreads(threads: readonly ThreadView[], direction: QueueDirection = "fifo"): SectionedThreads {
  const out: SectionedThreads = { pinned: [], active: [], snoozed: [], inactive: [] }
  for (const t of threads) {
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
  out.active = orderActive(out.active, direction)
  out.snoozed = orderByInteraction(out.snoozed)
  out.inactive = orderByInteraction(out.inactive)
  return out
}
