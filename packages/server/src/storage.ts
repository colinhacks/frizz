import Database from "./sqlite.ts"
import { ThreadSlug, slugify, threadIdentityName } from "@frizz/shared"
import { createInteractionStore, type InteractionStore } from "./interaction-store.ts"
import { scopeDatabase, type ProjectScope } from "./project-scope.ts"
import { log } from "./logging.ts"

// The UI-state store (never .frizz/): session registry + settings. ONE SQLite file for the whole
// machine, `<data>/ui.db` (frizz-db.ts), every row tagged with its project and every statement here
// scoped to one (project-scope.ts) — it was one file per project until 2026-08-27. WAL for concurrent
// read while the watcher writes. Frizz thread files stay the source of truth for STATUS; this DB
// holds only runtime overlay (which worker session backs a thread, unread, last-read) and settings.

export interface SessionRow {
  slug: string
  session_id: string
  /**
   * The thread's IDENTITY STRING, `frizz-<slug>`, re-derived and checked on every write by
   * validateSessionIdentity (see threadIdentityName). The column was called `tmux_name` and is
   * renamed in place on first boot — see THE COLUMN THAT OUTLIVED THE MULTIPLEXER below. The VALUE
   * never named a multiplexer pane, only a name that happened to be given to one, and no worker has
   * run in one since the broker landed; see the "there is no tmux" invariant in ARCHITECTURE.md.
   */
  thread_name: string
  spawned_at: string // ISO8601
  last_read_at: string | null // ISO8601
  unread: number // 0 | 1
  exited: number // 0 | 1
  archived: number // 0 | 1 — user hid the row from the nav; any respawn/resume un-archives
  rested_at: string | null // ISO8601 — when the agent last came to REST (turn end / worker exit); drives nav order
  // 0 | 1 — the stored `title` is a machine GUESS (the prompt chop), not a real name. Display-only:
  // it is what makes the UI show "Spinning up…"/"Untitled thread" instead of an internal-looking slug.
  // It does NOT decide whether a later machine title may land — that is `title_locked` below.
  title_auto: number
  // 0 | 1 — a HUMAN named this thread (explicit rename, native /rename, or an adopted `.frizz/<slug>.md`
  // heading), so no backend auto-title may ever replace it. A title HARD-CODED by a dispatch CALLER is
  // NOT this: `Investigate acme/app#391` from the GitHub batch, or a parent agent's guess through
  // `mcp__frizz__spawn_thread`, is shown as a real name (title_auto = 0) yet stays replaceable, because
  // the worker's own title for the task is nearly always the more informative one. The human-facing
  // new-thread composer has no title field at all, so a dispatch title never means "a human typed this".
  // INVARIANT, relied on by the idempotent boot repair: title_locked = 1 ⇒ title_auto = 0.
  // Optional in the TS shape so the many pre-existing row literals keep their old semantics — absent
  // reads as "locked unless the title was a machine guess" (see sessionTitleLocked).
  title_locked?: number
  // 0 | 1 — the text currently in `title` is the WORKER's own name for its task (persisted from its
  // title signal by the auto-title CAS), not the dispatch chop the row was seeded with. `title_auto`
  // cannot answer this: it records how the row was SEEDED and is deliberately left alone when a
  // machine title lands, so a codex row reads `title_auto = 1` whether its title is still the prompt
  // chop or the worker's real name. The display side needs exactly that distinction — without it the
  // codex fallback had to assume the worst and showed "Untitled thread" for every rested codex thread,
  // discarding a perfectly good persisted title (maintainer 2026-08-07). Cleared by every other title
  // writer (human rename, re-dispatch) so it always describes the CURRENT text.
  // Optional in the TS shape for the same reason as `title_locked`: pre-existing row literals.
  title_agent?: number
  // ---- session-first columns (2026-07-09; all nullable — additive migration under a live server) ----
  title: string | null // dispatch title (new dispatches have no thread FILE to hold it); display prefers aiTitle
  // The filename stem of the DISCOVERED transcript when it drifted off the pinned `<session_id>.jsonl`
  // (a worker whose real transcript lives at a different id). NULL in the normal case — the read side
  // then binds `<session_id>.jsonl` directly. Cached by the tailer's discovery fallback so the drifted
  // path survives restarts AND so foreign-discovery doesn't surface the re-linked transcript as a
  // duplicate thread. See tailer.ts / discover.ts. session_id stays the pinned resume/scratchpad key.
  transcript_id: string | null
  // Lifecycle: 'open' | 'archived'. NULL = never explicitly set (pre-migration row) — the board derives
  // an effective state (archived flag ⇒ archived; paired legacy .frizz file with terminal status ⇒
  // archived; else open) so historical sessions don't flood the working rail. Written ONLY by explicit
  // Archive/Reopen (the done FENCE mutates nothing — maintainer-settled).
  state: string | null
  // Exact UTC instant chosen by the human. This is lifecycle metadata (like Archive), never inferred
  // from an agent fence. Optional keeps old fixtures/source-compatible; SQLite always returns null or
  // a concrete value after the additive migration.
  snoozed_until?: string | null
  // The follow-up this snooze owes at its deadline. NULL = a plain reminder snooze (the card just
  // re-surfaces, which is all a snooze ever did before). Non-NULL = the scheduler owns the expiry: it
  // bumps the thread with exactly this text, so the board must NOT clear such a row on elapse.
  snooze_prompt?: string | null
  // Event-snooze for the awaiting-background card: the `rested_at` value captured when the human snoozed
  // a "resting while its own sub-agents/shells run" card. The board hides that card while this equals the
  // CURRENT rested_at (the same rest), and re-surfaces it the moment rested_at advances — i.e. the parent
  // came to a new rest because a sub-agent/shell returned. NULL = no event-snooze armed. Distinct from
  // snoozed_until (a wall-clock park owned by the scheduler); this one clears itself on the next rest.
  bg_snooze_rested_at?: string | null
  // The instant the human PINNED this thread out of the rail's band system (null/absent = not pinned).
  // Like Archive and the snooze it is lifecycle metadata the human owns — never inferred from a fence —
  // and the instant doubles as the pinned band's order. It survives every state change (a pinned thread
  // that finishes stays pinned); only the unpin verb clears it.
  pinned_at?: string | null
  // The thread's RECURRING PROMPT — one piece of text with up to three independent triggers
  // (scheduler.ts SOURCES 4, 5 and 7). `recurring_armed_at` is the GENERATION: editing the text or the
  // cadence mints a new one, so a delivery already queued under the old settings reads as superseded.
  recurring_prompt?: string | null
  // The three mechanisms. ALL 0 is the off state — the text and the cadence are kept so re-arming costs
  // no retyping, and there is deliberately no fourth `enabled` column that could disagree with these.
  //
  // NAME MAPPING, stated once: `recurring_on_rest` is the STOP HOOK, `recurring_on_schedule` is the
  // HEARTBEAT and `recurring_on_compact` is POST-COMPACTION — the names the panel, the API and the MCP
  // tool all use. The columns keep their trigger-shaped names because renaming them would mean
  // migrating rows that are armed right now, for no user-visible gain; everything above the storage
  // boundary speaks stopHook/heartbeat/postCompaction.
  recurring_on_rest?: number
  recurring_on_schedule?: number
  // POST-COMPACTION (scheduler SOURCE 7, added 2026-08-06). The trigger that exists because a worker's
  // context is emptiest exactly when nobody is there to re-orient it: the operator (or the worker)
  // links whatever doc it wrote in its scratch directory, and this hands that link back the moment the
  // window is summarized away. It replaced a hook that spliced a canonical scratchpad's head into the
  // context — the durable row is visible and editable in the thread footer, where a hook was neither.
  recurring_on_compact?: number
  // The built-in sign-off nudge's consecutive counter, and the last delivery id it counted (diagnosis
  // only). See the ALTER list for what clears the count.
  signoff_nudges?: number
  signoff_nudge_anchor?: string | null
  // SOURCE 12's CORRECTIVE bumps (a fence naming nothing, a retired kind, a dead id), capped the same
  // way and for the same reason: a correction a worker cannot act on repeats forever. Measured
  // 2026-08-17 on the live board — one thread had taken 617 of them in 4h45m, one every ~28s, because
  // its contract was frozen before this grammar existed and no fence it could write would satisfy the
  // check. The `expired` cause is NOT counted here; re-parking on still-running work is unlimited by
  // explicit decision (maintainer 2026-08-15).
  park_bumps?: number
  park_bump_anchor?: string | null
  // The ON SCHEDULE trigger's cadence. Kept even while that trigger is off, so switching it back on
  // does not lose the interval the operator chose.
  recurring_interval_ms?: number | null
  recurring_armed_at?: string | null
  // Terminal-delivery stamps, ONE PER TRIGGER. They are separate because they answer different
  // questions: the schedule's is load-bearing (the next delivery is due an interval after THIS, so a
  // thread cannot accumulate a backlog), while the rest and post-compaction triggers' are only the
  // panel's "last sent" readout — they have no floor and fire on every rest / every compaction.
  recurring_rest_fired_at?: string | null
  recurring_schedule_fired_at?: string | null
  recurring_compact_fired_at?: string | null
  meta: string | null // JSON blob for future annotations (unparsed here)
  seen_at: string | null // ISO8601 — interaction clearance: recorded when the human opens the thread
  // Which agent backend serves this session (Codex-support epic). Optional in the TS shape (older rows
  // + the many test-fixture literals predate it); the SQLite column carries a "claude" DEFAULT so every
  // existing row and all current behavior are unchanged. Phase 1 only ever writes "claude".
  backend?: string
  // The backend's OWN native session id when it differs from the frizz-minted session_id (Codex-support
  // epic, Phase 2). Claude pins session_id via --session-id, so its native id IS session_id and this
  // stays NULL. Codex mints its OWN rollout id (discovered post-spawn), so session_id remains the frizz
  // UUID (the sentinel + scratchpad key) and the discovered codex id is pinned HERE — the id the tailer
  // locates the rollout with and resume re-attaches. Readers use `agent_session_id ?? session_id`, so a
  // claude row (NULL) is byte-identical to before.
  agent_session_id?: string | null
  // The resolved model + reasoning-effort values this session was STARTED with. These are deliberately
  // session metadata, not a live read of Settings: changing the global dispatch defaults later must not
  // relabel an existing thread. Nullable/optional keeps migrated, adopted-old, and foreign sessions honest
  // when frizz never observed a concrete CLI value.
  model?: string | null
  effort?: string | null
  // A live profile request is armed as one complete pair. The committed model/effort stay visible
  // and rollback-safe until the replacement generation reaches a proven idle composer.
  profile_pending_model?: string | null
  profile_pending_effort?: string | null
  // When the OPERATOR last set model/effort (ISO). Sibling of permission_set_at: only setProfile stamps
  // it — never the tailer's observed write-back. Its PRESENCE is what separates a chosen pair from an
  // observed one, and both readers turn on that: the board keeps the composer selector on the pick
  // (resolveSessionProfile) and the write-back stays off the row entirely (observedProfileIfCurrentStmt).
  // Both backends' setThreadProfile paths stamp it — the "codex-only" this used to claim was never true
  // of the shipped router, and reading it that way is what let a claude pick be silently overwritten.
  // Null on pre-migration rows and on any row whose profile nobody has set by hand.
  profile_set_at?: string | null
  profile_revision?: number
  // Versioned crash journal for an in-flight model/effort reattach. This remains populated while
  // runtime_control='profile'; restart recovery must prove one exact runtime before clearing either.
  profile_handoff?: string | null
  // The concrete permission mode / codex-sandbox mapping selected for THIS session. NULL means a
  // migrated row whose launch argv predates persistence; once explicitly set it always wins over
  // mutable global Settings on every later resume.
  permission_mode?: string | null
  // A requested live permission change that has not yet been observed in backend telemetry. Kept
  // separately from permission_mode so the board never presents an optimistic selection as actual.
  permission_pending?: string | null
  // When the OPERATOR last set permission_mode (ISO). Only setPermissionMode stamps it — never the
  // tailer's observed write-back. The board prefers the saved value over an older observed telemetry
  // reading when this is newer, so a codex sandbox change shows in the pill immediately instead of
  // lagging until the next turn emits a fresh turn_context. Null on pre-migration and never-set rows.
  permission_set_at?: string | null
  // An actionable reason a runtime control failed closed and cannot safely advance right now.
  control_error?: string | null
  // Durable Claude follow-up delivery ledger (delivery-ledger.ts): small JSON array of not-yet-
  // delivered sends, correlated by the tailer and projected into the rendered transcript.
  delivery_ledger?: string | null
  // Monotonic process incarnation for this Frizz session. Incremented atomically before every
  // respawn/reattach so output or async completion from an older process cannot mutate the new one.
  runtime_generation?: number
  // Durable, mutually-exclusive native runtime control. The revision prevents ABA when one control
  // finishes and another starts with the same kind while an async runtime operation is still returning.
  runtime_control?: string | null
  runtime_control_revision?: number
  // Codex transport: 'app-server' = a bridge-owned JSON-RPC session, and the only value frizz writes.
  // NULL/'tmux' is the PRE-APP-SERVER legacy value, left on rows that have not been dispatched since
  // the cutover; no code path can create one now. Only meaningful for backend='codex' rows.
  codex_runtime?: string | null
  // Claude transport: 'broker' = a session-broker-owned Agent SDK session, and the only value frizz
  // writes. NULL/'tmux' is the PRE-BROKER legacy value, readable on an old database and never written
  // again. Only meaningful for backend='claude' rows.
  claude_runtime?: string | null
}

/**
 * A HEADLESS thread has no terminal of its own: input goes through a bridge, liveness comes from the
 * bridge / the on-disk transcript, and there is no interactive UI for anything to read back. Both
 * bridge-owned transports are headless — codex over its app-server, claude over its session broker —
 * which between them is every row frizz creates. Use this wherever the intent is "is this row
 * bridge-owned?" rather than a codex- or claude-specific branch; the false side is only ever a
 * legacy row left by the pre-cutover interactive path.
 */
export function isHeadlessRow(row: Pick<SessionRow, "backend" | "codex_runtime" | "claude_runtime">): boolean {
  return (row.backend === "codex" && row.codex_runtime === "app-server") ||
    (row.backend === "claude" && row.claude_runtime === "broker")
}

/** A Claude row whose session lives in the detached broker daemon, not in any terminal. Stamped
 *  claude_runtime="broker" at dispatch and never migrated, so — unlike legacy codex rows — the runtime
 *  column is authoritative from birth. The Claude twin of isAppServerCodexRow. */
export function isBrokerClaudeRow(row: Pick<SessionRow, "backend" | "claude_runtime">): boolean {
  return row.backend === "claude" && row.claude_runtime === "broker"
}

// Is this row's title off-limits to the backend's own auto-title? The column is authoritative once
// written; an ABSENT value (a pre-migration row read through a partial Pick, or one of the many test
// row literals) falls back to the pre-`title_locked` rule — every non-guessed title was locked — so
// nothing that predates the split silently loosens. The registry, the board's aiTitle overlay, and the
// auto-title CAS all decide through this one predicate.
export function sessionTitleLocked(row: Pick<SessionRow, "title_auto" | "title_locked">): boolean {
  return (row.title_locked ?? (row.title_auto === 1 ? 0 : 1)) === 1
}

// Does this slug read as one DISPATCH minted from this exact title? Only dispatch derives the two
// from each other — `slugify(title)`, plus the `-2`/`-3` suffix resolveSlug appends on a collision —
// so an affirmative means the stored title is still the one the thread was spawned with. Every human
// title writer (rename, native /rename) rewrites the title and leaves the slug alone, so a renamed
// thread answers NO. That asymmetry is the whole basis of the boot repair that unlocks titles a
// dispatch-path bug froze; it is a heuristic, never an invariant, so nothing but that one-time repair
// may decide anything on it.
export function slugMintedFromTitle(slug: string, title: string): boolean {
  const derived = slugify(title)
  return derived === slug || derived === slug.replace(/-\d+$/, "")
}

export interface RuntimeExpectation {
  sessionId: string
  generation: number
  permissionPending: string | null
  runtimeControl?: string | null
}

// ONE recurring-prompt write, for both the operator's session-guarded path and the worker's by-slug one.
// An OBJECT rather than a positional list because the triggers are same-typed booleans: with two of them
// `("keep going", true, false, null, at)` was already unreadable at the call site, and a third made a
// silently transposed pair a question of when rather than whether. `prompt: null` clears the row, which
// forces every trigger off regardless of what is passed here (see recurringArgs).
export interface RecurringWrite {
  prompt: string | null
  stopHook: boolean // scheduler SOURCE 5 — on every rest
  heartbeat: boolean // scheduler SOURCE 4 — every intervalMs on a clock
  postCompaction: boolean // scheduler SOURCE 7 — on every context compaction
  intervalMs: number | null
  armedAt: string
}

export type RuntimeControlKind = "permission" | "profile" | "resume" | "follow-up" | "ai-rename"

export type ProfileHandoffPhase =
  | "armed"
  | "target-starting"
  | "target-spawned"
  | "target-ready"
  | "rollback-starting"
  | "rollback-spawned"
  | "rollback-ready"

export interface ProfileHandoffBinding {
  kind: "standalone" | "adopted"
  paneId: string
  panePid: number
  sessionCreated: number
  adoptionAttemptToken?: string
  handoffToken?: string
}

export interface ProfileHandoffLeg {
  generation: number
  handoffToken: string
  binding?: ProfileHandoffBinding
}

export interface ProfileHandoffJournal {
  version: 1
  phase: ProfileHandoffPhase
  nativeSessionId: string
  previous: { model: string; effort: string; binding: ProfileHandoffBinding }
  requested: { model: string; effort: string }
  target?: ProfileHandoffLeg
  rollback?: ProfileHandoffLeg
}

export interface ProfileChangeExpectation {
  sessionId: string
  nativeSessionId: string | null
  generation: number
  profileRevision: number
  controlRevision: number
  model: string
  effort: string
  profileHandoff: string
}

export interface AutoTitleExpectation {
  sessionId: string
  nativeSessionId: string | null
  runtimeGeneration: number
}

export type AdoptionClaimState = "reserved" | "spawned" | "recovering" | "finalized"

// A cold-adoption attempt owns its slug in SQLite before it is allowed to start a worker at all.
// The pane_* tuple below is LEGACY. When adoption spawned an interactive multiplexer session, that
// tuple was filled immediately after the session was created and the attempt token was embedded in
// the session's environment, which let restart recovery identify the otherwise tiny window between
// the spawn and this row update without guessing from a reusable slug or PID. Adoption spawns
// through the broker now, so those three columns stay NULL and the reservation itself is the claim
// (see finalizeAdoptionClaimTxn).
export interface AdoptionClaimRow {
  slug: string
  attempt_token: string
  session_id: string
  state: AdoptionClaimState
  reserved_at_ms: number
  lease_expires_at_ms: number
  recovery_token: string | null
  pane_id: string | null
  pane_pid: number | null
  session_created: number | null
  finalized_at_ms: number | null
}

export interface AdoptionPaneIdentity {
  paneId: string
  panePid: number
  sessionCreated: number
}

export interface AdoptionReservation {
  slug: string
  attemptToken: string
  sessionId: string
  reservedAtMs: number
  leaseExpiresAtMs: number
}

// Tokens are never reusable after an attempt gives up ownership. Keeping the retirement ledger
// durable lets boot recovery find a worker started by an old process that resumed after its lease
// was recovered. New processes are additionally fenced under SQLite's writer lock before spawning.
export interface RetiredAdoptionAttemptRow {
  attempt_token: string
  slug: string
  session_id: string
  retired_at_ms: number
}

export interface ForgetSessionExpectation {
  sessionId: string
  runtimeGeneration: number
  adoptionAttemptToken: string | null
}

export type AdoptionSpawnFenceResult<T> =
  | { acquired: false }
  | { acquired: true; value: T }

/** One row of `thread_timer` — a worker's one-off alarm. Instants are epoch ms in the table (they are
 *  only ever compared against `Date.now()`); the ISO string the worker and the delivered trailer see is
 *  derived at the boundary. */
export interface ThreadTimerRow {
  id: string
  thread_slug: string
  prompt: string
  fire_at: number
  state: "armed" | "fired" | "cancelled"
  created_at: number
  settled_at: number | null
}

/** One row of `pr_watch` — a PR this thread asked to be told about, registered by tool call.
 *
 *  UNLIKE EVERY OTHER REGISTRY HERE IT DOES NOT FIRE ONCE. A timer rings and is spent; this one stays
 *  armed and reports repeatedly — CI turning green or red or being held for an approval, every later
 *  review or comment, and since 2026-09-04 the PR's own state moving (a label, a conflict, a review
 *  request) — until the worker drops it or the PR merges. The cursor below carries the baseline for all
 *  of them. That is the whole ask (maintainer 2026-08-14: "it should get
 *  notified when CI either succeeds or failed and on follow-up reviews and comments"), and it is why the
 *  row carries a CURSOR rather than a settled flag: the question is never "has it happened" but "has
 *  anything happened since I last said so". */
export interface PrWatchRow {
  id: string
  thread_slug: string
  owner: string
  repo: string
  number: number
  /** Epoch ms after which this watcher settles itself. Null only on a row written before it was
   *  required — the registration path rejects a missing one. */
  expires_at: number | null
  state: "armed" | "dropped" | "settled"
  created_at: number
  settled_at: number | null
  /** JSON: `{ seen: string[]; checks?: string }` — the review activity already reported, and the last
   *  check verdict reported, so only a CHANGE fires. Opaque to storage; the scheduler owns its grammar. */
  cursor: string | null
}

/** A worker's registered WATCH on its own running work — a background shell it launched or a sub-agent
 *  it dispatched (plans/rest-by-registration.md, 2026-08-26).
 *
 *  ONE-SHOT, unlike PrWatchRow: the thing it names either finishes, in which case the runtime's own
 *  completion notification wakes the thread and the row settles, or the row's own timeout elapses and
 *  frizz wakes the thread to re-decide. There is no cursor because there is no stream of events to be
 *  caught up on — a shell finishes once. */
export interface ThreadWatchRow {
  id: string
  thread_slug: string
  kind: "shell" | "agent"
  /** The handle the worker was shown — a runtime task id, a launch tool_use id, or the op's label. */
  target: string
  /** Epoch ms at which this watch cancels itself and wakes the thread. Never null: the registering tool
   *  refuses without one, which is the whole difference from a fence that could park indefinitely. */
  expires_at: number
  state: "armed" | "dropped" | "expired" | "settled"
  created_at: number
  settled_at: number | null
}

/** A worker's registered QUESTION for the human — one row per ROOT question, its follow-up tree inside
 *  `spec` (plans/rest-by-registration.md, 2026-08-26).
 *
 *  IT HAS NO EXPIRY, which is the one real difference from ThreadWatchRow. A watch waits on WORK, and
 *  work ends; a question waits on a PERSON, and a person owes an answer until they give one. A question
 *  that timed out would either re-ask as noise or silently drop something the human still owed. */
export interface ThreadQuestionRow {
  id: string
  thread_slug: string
  /** The question tree as JSON, validated at the RPC boundary and stored verbatim (AskedQuestion). */
  spec: string
  state: "open" | "answered" | "withdrawn" | "dismissed"
  /** The structured answer as JSON — keyed by question id and restating each question's text, because
   *  the worker never saw the id. Null until the human sends, and forever on a settled-unanswered row. */
  answer: string | null
  /** 0 until the worker has been handed the answer. Answering and DELIVERING are separate, exactly as
   *  they are for a wake: an answer given while the worker's process was down must survive the gap. */
  delivered: number
  asked_at: number
  settled_at: number | null
}

// ---- THE PER-THREAD REGISTRIES, READ WHOLE -------------------------------------------------------
// Five little tables hang off a thread — its timers, its PR watchers, its watches, its questions, its
// completion — and the board reads all five for EVERY row it assembles. One query per thread per table
// is fine at ten threads and is not fine at six hundred: measured on a copy of the maintainer's own
// board (558 rows), a single rebuild issued 2,794 statements, of which 2,790 were exactly these five
// asked 558 times each, and took 30.5ms. node:sqlite is SYNCHRONOUS, so that is 30.5ms of blocked event
// loop — and a rebuild fires on a 150ms debounce whenever any agent writes into `.frizz`, plus every
// 15s regardless. On the live server that landed as a board RPC answering in 49-1069ms (median ~270ms)
// against 4.5-10ms on an idle one, and 220 "tick took Nms" warnings in a day.
//
// So the board asks each table ONCE and indexes the answer by slug. These readers are the batched half;
// the per-thread `listX(slug)` calls remain for the worker tools and the scheduler, which genuinely
// want one thread. Each batched statement carries the SAME predicate and the SAME ORDER BY as the
// per-thread one it replaces — that is what makes the two byte-identical, and it is the thing to
// re-check if either statement is ever edited.
//
// Insertion order is what makes the grouping faithful: a Map preserves it, and so does an array push,
// so each bucket comes out in exactly the order the global ORDER BY produced — which is the per-slug
// ORDER BY restricted to that slug, because every one of these orders on columns the slug does not
// participate in.
function groupBySlug<Row extends { thread_slug: string }>(rows: Row[]): Map<string, Row[]> {
  const bySlug = new Map<string, Row[]>()
  for (const row of rows) {
    const bucket = bySlug.get(row.thread_slug)
    if (bucket) bucket.push(row)
    else bySlug.set(row.thread_slug, [row])
  }
  return bySlug
}

export interface Storage {
  /** The SHARED connection — raw, unscoped. Prefer `scope`; see project-scope.ts. */
  db: Database
  /** Every statement bound to this project. What wake-store.ts and tail-cache.ts build on. */
  scope: ProjectScope
  projectId: string
  interactions: InteractionStore
  getSession(slug: string): SessionRow | undefined
  // Every registered row, newest schema first. The array and the rows in it are SHARED and CACHED
  // between callers (see the cache note at the implementation) — read them, never mutate them.
  allSessions(): readonly SessionRow[]
  subscribeSessionLifecycle(listener: (event: SessionLifecycleEvent) => void): () => void
  upsertSession(row: SessionRow): void
  // Claim a previously-unowned slug without ever replacing its current owner. This is the registry
  // compare-and-swap used by cold adoption after spawn: a competing writer either wins atomically or
  // leaves its row byte-for-byte untouched. Unlike the legacy upsert, identity columns are part of the
  // same INSERT so backend/native-session ownership can never be partially updated across backends.
  insertSessionIfAbsent(row: SessionRow): boolean
  getAdoptionClaim(slug: string): AdoptionClaimRow | undefined
  getAdoptionRuntimeSnapshot(slug: string): {
    session: SessionRow | undefined
    claim: AdoptionClaimRow | undefined
  }
  allAdoptionClaims(): AdoptionClaimRow[]
  allRetiredAdoptionAttempts(): RetiredAdoptionAttemptRow[]
  // INSERT ... WHERE no session owner exists. The slug PK and token UNIQUE constraint serialize
  // separate Frizz processes/connections; a loser never reaches the spawn.
  reserveAdoptionClaim(reservation: AdoptionReservation): boolean
  recordAdoptionPane(
    slug: string,
    attemptToken: string,
    identity: AdoptionPaneIdentity,
    leaseExpiresAtMs: number,
  ): boolean
  // Revalidate the exact token while holding SQLite's write lock across the spawn and its first
  // identity bind. Recovery on another connection cannot retire the token in the validation→spawn
  // gap. LEGACY SHAPE: only the multiplexer-era adoption spawn bound an identity here — a
  // broker-backed adoption reserves and finalizes without one, so nothing outside the tests reaches
  // this today.
  withAdoptionSpawnFence<T>(
    slug: string,
    attemptToken: string,
    leaseExpiresAtMs: number,
    spawn: (bindPane: (identity: AdoptionPaneIdentity, leaseExpiresAtMs: number) => boolean) => T,
  ): AdoptionSpawnFenceResult<T>
  // The session INSERT and claim finalization are one SQLite transaction. False means another row
  // won; the spawned attempt remains recoverable and its owner/restart must clean it up against the
  // exact identity it recorded, never by name.
  finalizeAdoptionClaim(slug: string, attemptToken: string, row: SessionRow, finalizedAtMs: number): boolean
  // Reuse the durable binding for a legitimate resume without an unbound gap. While reserved/spawned,
  // every reader sees a conflict and fails closed; recovery restores a finalized binding with the
  // identity columns cleared.
  rearmFinalizedAdoptionClaim(reservation: AdoptionReservation, previousAttemptToken: string): boolean
  finalizeAdoptionRespawnClaim(
    slug: string,
    attemptToken: string,
    sessionId: string,
    finalizedAtMs: number,
  ): boolean
  // The live owner may abandon only its own non-finalized token after proving nothing still runs
  // under it.
  abandonAdoptionClaim(slug: string, attemptToken: string): boolean
  // Lease takeover is itself CAS + leased, so two booting servers cannot both clean one attempt and
  // a recovery process killed midway can be safely superseded after its recovery lease expires.
  beginAdoptionRecovery(
    slug: string,
    attemptToken: string,
    recoveryToken: string,
    nowMs: number,
    leaseExpiresAtMs: number,
  ): AdoptionClaimRow | undefined
  finishAdoptionRecovery(slug: string, attemptToken: string, recoveryToken: string): boolean
  retireFinalizedAdoptionClaim(slug: string, sessionId: string, attemptToken: string): boolean
  markRead(slug: string, at?: string): void
  setUnread(slug: string, unread: boolean): void
  setUnreadIfCurrent(slug: string, sessionId: string, generation: number, unread: boolean): boolean
  setExited(slug: string, exited: boolean): void
  setExitedIfCurrent(slug: string, sessionId: string, generation: number, exited: boolean): boolean
  // Completion is one CAS write: a verified stopped runtime becomes exited + Done together, while
  // clearing stale attention/wake state. A replaced owner/generation observes zero changes.
  completeIfCurrent(slug: string, sessionId: string, generation: number): boolean
  setRestedAt(slug: string, at: string): void
  setRestedAtIfCurrent(slug: string, sessionId: string, generation: number, at: string): boolean
  setSeenAt(slug: string, at: string): void
  // Cache/clear the discovered transcript filename stem (the read-side discovery fallback's result).
  setTranscriptId(slug: string, transcriptId: string | null): void
  setTranscriptIdIfCurrent(
    slug: string,
    sessionId: string,
    generation: number,
    transcriptId: string | null,
  ): boolean
  // Explicit lifecycle write (Archive button / Reopen), and the ONLY way to archive. Keeps the legacy
  // `archived` flag in sync so pre-restart readers of that column stay honest; archiving also clears
  // unread (never badge a deliberately-shelved thread).
  //
  // There was a `setArchived` beside this that wrote ONLY that legacy column. It is gone, because the
  // column is no longer what anything reads: `effectiveSessionState` (board.ts) consults it only when
  // `state` is NULL, and every row the dispatch path creates has an explicit `state`. So the legacy
  // setter's one caller (the archiveThread RPC) reported success while the card never moved.
  setState(slug: string, state: "open" | "archived"): void
  setStateIfCurrent(
    slug: string,
    sessionId: string,
    generation: number,
    state: "open" | "archived",
  ): boolean
  // `prompt` arms the deadline as a scheduled BUMP: the waker resumes the thread with exactly this
  // text when the instant crosses. Omitted/null keeps the historical reminder behavior (the card
  // simply re-surfaces). Clearing the instant always clears the prompt with it.
  setSnoozedUntil(slug: string, until: string | null, prompt?: string | null): void
  // Session-guarded park: writes only while the row is still this session+generation, so a stale card
  // cannot re-park a thread that has since been re-dispatched.
  setSnoozedUntilIfCurrent(slug: string, sessionId: string, generation: number, until: string | null): boolean
  // Pin/unpin: the instant is the pinned band's order, null clears it. Unguarded like setSnoozedUntil —
  // the RPC resolves the owning session first.
  setPinnedAt(slug: string, at: string | null): void
  // Arm/clear the awaiting-background event-snooze. Session-guarded like the park above. `restedAt` is
  // the rest instant the card is snoozed FOR; the board re-surfaces it once rested_at moves past this.
  setBgSnoozeRestedAtIfCurrent(slug: string, sessionId: string, generation: number, restedAt: string | null): boolean
  // Arm / edit / clear the thread's RECURRING PROMPT in ONE write, because the popover's textarea, its
  // two trigger toggles and its minutes field are all views of one row — split into separate writes, a
  // tab holding a stale copy of one of them would clobber the rest.
  //
  // GENERATION DISCIPLINE: a change to the TEXT or the INTERVAL mints a fresh `armed_at`, superseding
  // any delivery already queued under the old settings; a bare trigger flip preserves it, so switching
  // a trigger off and on cannot re-run a delivery the operator just watched land. A null prompt clears
  // the row outright.
  //
  // Session-guarded: this comes from a browser tab that may be looking at a thread which has since been
  // re-dispatched.
  setRecurringPromptIfCurrent(slug: string, sessionId: string, generation: number, write: RecurringWrite): boolean
  // The WORKER's path to the same row, from `mcp__frizz__goal`. Deliberately keyed on the
  // slug ALONE, with no session/generation guard, because the MCP server cannot satisfy one: it is
  // spawned with its thread's slug and keeps it across a resume, while the session id and generation
  // bump underneath it — so a guard here would fail exactly on the long-lived thread this exists for.
  // The slug is stamped into that server's env by frizz itself and is not attacker-controlled.
  setRecurringPromptBySlug(slug: string, write: RecurringWrite): boolean
  // ---- ONE-OFF TIMERS (scheduler SOURCE 6) -------------------------------------------------------
  // Arm one. `id` is minted by the caller so the row and the scheduler's delivery id agree without a
  // read-back. Slug-keyed for the same reason the recurring prompt's worker path is.
  armThreadTimer(timer: { id: string; slug: string; prompt: string; fireAtMs: number; createdAtMs: number }): void
  // A thread's timers, newest deadline last. `armedOnly` is what the worker's tool reads back; the full
  // set is for tests and diagnostics.
  listThreadTimers(slug: string, opts?: { armedOnly?: boolean }): ThreadTimerRow[]
  /** Every thread's ARMED timers at once, keyed by slug — the board's read (see groupBySlug above).
   *  Same predicate and same `fire_at, id` order as `listThreadTimers(slug, { armedOnly: true })`; a
   *  thread with none is ABSENT from the map, so a caller reads `?? []` for the empty array. */
  armedThreadTimersBySlug(): Map<string, ThreadTimerRow[]>
  getThreadTimer(id: string): ThreadTimerRow | undefined
  // Every armed timer that is due, across all threads — the scheduler's one read per tick.
  dueThreadTimers(nowMs: number): ThreadTimerRow[]
  // Withdraw one. Scoped to the slug so a worker can only ever cancel its OWN, and only an ARMED timer
  // moves: cancelling one that already fired is a no-op, not a rewrite of history.
  cancelThreadTimer(slug: string, id: string, settledAtMs: number): boolean
  // Terminal for the scheduler: this timer's delivery has settled, so it must never be queued again.
  // Guarded on `armed` so a cancel that raced the delivery keeps its own verdict.
  markThreadTimerFired(id: string, settledAtMs: number): boolean
  // ---- REGISTERED PR WATCHERS --------------------------------------------------------------------
  // The same shape as the timers above and for the same reason: a thread may hold many, each with its own
  // identity, so the record of intent is a TABLE. `id` is minted by the caller so the row and the
  // scheduler's delivery ids agree without a read-back.
  armPrWatch(watch: { id: string; slug: string; owner: string; repo: string; number: number; createdAtMs: number; expiresAtMs: number }): void
  /** Every armed watcher whose expiry has passed — settled by the scheduler, not polled again. */
  expiredPrWatches(nowMs: number): PrWatchRow[]
  // A thread's watchers, oldest first. `armedOnly` is what the worker's tool reads back and what the
  // board lists; the full set is for diagnostics.
  listPrWatches(slug: string, opts?: { armedOnly?: boolean }): PrWatchRow[]
  /** Every thread's ARMED watchers at once, keyed by slug — the board's read (see groupBySlug above).
   *  Same predicate and same `created_at, id` order as `listPrWatches(slug, { armedOnly: true })`;
   *  a thread with none is ABSENT from the map. */
  armedPrWatchesBySlug(): Map<string, PrWatchRow[]>
  getPrWatch(id: string): PrWatchRow | undefined
  // Every armed watcher across all threads — the scheduler's one read per tick.
  armedPrWatches(): PrWatchRow[]
  // Withdraw one. Scoped to the slug so a worker can only ever drop its OWN, and only an ARMED row moves.
  dropPrWatch(slug: string, id: string, settledAtMs: number): boolean
  // Terminal, and NOT the ordinary path: a watcher settles only when its PR is merged or closed, because
  // there is nothing further to report. Everything else leaves it armed.
  settlePrWatch(id: string, settledAtMs: number): boolean
  // Persist what has already been reported. Guarded on `armed` so a cursor written after the worker
  // dropped the row cannot resurrect it.
  setPrWatchCursor(id: string, cursor: string): boolean
  /** Register a watch, or return the armed one already covering this (thread, kind, target). Idempotent
   *  by that triple, so a worker re-registering the same wait after a wake gets one row, not two. */
  armThreadWatch(watch: { id: string; slug: string; kind: "shell" | "agent"; target: string; createdAtMs: number; expiresAtMs: number }): ThreadWatchRow
  listThreadWatches(slug: string, opts?: { armedOnly?: boolean }): ThreadWatchRow[]
  /** Every thread's ARMED watches at once, keyed by slug — the board's read (see groupBySlug above).
   *  Same predicate and same `created_at, id` order as `listThreadWatches(slug, { armedOnly: true })`;
   *  a thread with none is ABSENT from the map. */
  armedThreadWatchesBySlug(): Map<string, ThreadWatchRow[]>
  getThreadWatch(id: string): ThreadWatchRow | undefined
  /** Every armed watch whose timeout has elapsed — the scheduler cancels these and wakes their threads. */
  expiredThreadWatches(nowMs: number): ThreadWatchRow[]
  /** Every armed watch on the machine, across threads — the scheduler's own sweep, which has to ask
   *  each one whether the work it names is still running. */
  armedThreadWatches(): ThreadWatchRow[]
  /** The worker's own unwatch. Scoped to the thread so one thread can never drop another's row. */
  dropThreadWatch(slug: string, id: string, settledAtMs: number): boolean
  /** The watched thing finished on its own — the runtime already woke the thread, so this only records
   *  that the row is no longer a reason to wait. */
  settleThreadWatch(id: string, settledAtMs: number, state?: "expired" | "settled"): boolean
  // ---- THE WORKER'S REGISTERED QUESTIONS -----------------------------------------------------------
  /** Register one root question. Never idempotent, unlike a watch: two identically-worded questions are
   *  two things the human owes an answer to, and collapsing them would silently drop one. */
  askThreadQuestion(q: { id: string; slug: string; spec: string; askedAtMs: number }): ThreadQuestionRow
  listThreadQuestions(slug: string, opts?: { openOnly?: boolean }): ThreadQuestionRow[]
  /** Every thread's questions at once, keyed by slug — the board's read (see groupBySlug above).
   *  UNFILTERED, matching the board's own `listThreadQuestions(slug)` with no `openOnly`: the card
   *  renders the OPEN ones and `answersInFlight` reads the just-ANSWERED ones off the same list, so
   *  narrowing this to open rows here would silently drop the in-flight half. Same `asked_at, rowid`
   *  order; a thread with none is ABSENT from the map. */
  threadQuestionsBySlug(): Map<string, ThreadQuestionRow[]>
  getThreadQuestion(id: string): ThreadQuestionRow | undefined
  /** Every OPEN question on the machine — what the `done` gate and the board both read. */
  openThreadQuestions(): ThreadQuestionRow[]
  /** The human's answer. Stored, not delivered: `undeliveredSettlements` finds it on the next pass. */
  answerThreadQuestion(id: string, answer: string, atMs: number): boolean
  /** Settled but not yet told to the worker — the scheduler's delivery queue. Answers AND dismissals,
   *  because a dismissal is news the worker needs ("decide it yourself") even though it wakes nobody on
   *  its own: it rides the next answer's wake. A withdrawal is absent because the worker DID that. */
  undeliveredSettlements(): ThreadQuestionRow[]
  markSettlementDelivered(id: string): boolean
  /** The worker's own `unask`, thread-scoped so one thread can never withdraw another's question. */
  withdrawThreadQuestion(slug: string, id: string, atMs: number): boolean
  /** The human's x. Distinct from `withdrawn` on purpose: the two states answer different questions
   *  about what happened, and the worker is told which. */
  dismissThreadQuestion(id: string, atMs: number): boolean
  // ---- THE WORKER'S OWN COMPLETION ----------------------------------------------------------------
  /** Record this thread as done, replacing any earlier record — a worker declaring itself done twice
   *  has not finished two things. The GATE (open questions, live registrations) lives at the RPC, not
   *  here: storage records what happened, it does not decide whether it was allowed. */
  markThreadDone(slug: string, body: string, atMs: number): void
  /** The thread's completion, or undefined. It is the CALLER's job to check `doneAt` against the newest
   *  user record — a done row is spent by the human sending more work, and this returns it either way. */
  getThreadDone(slug: string): { body: string; doneAt: number } | undefined
  /** Every thread's completion at once, keyed by slug — the board's read (see groupBySlug above). One
   *  row per thread is the table's PRIMARY KEY, so this is a Map of VALUES rather than of arrays, and
   *  a thread with none is ABSENT — the same `undefined` `getThreadDone` returns. */
  threadDoneBySlug(): Map<string, { body: string; doneAt: number }>
  /** Forget it, so the thread is no longer done. */
  clearThreadDone(slug: string): boolean
  // ---- THE BUILT-IN SIGN-OFF NUDGE ----------------------------------------------------------------
  // Count one delivered nudge against this thread. It only ever INCREMENTS — the count is cleared by
  // `resetSignoffNudges` when the thread signs off, and by nothing else. It used to reset whenever a
  // supplied anchor changed, which was wrong twice over: anchored on the human's last word, frizz's own
  // delivery (a user record) reset it; anchored on the rest, every new rest reset it. Either way the cap
  // never bit. `anchor` is the delivery id being counted, and counting the SAME one twice is a no-op —
  // one rest yields one delivery id, so a repeat is always a double count rather than a second rest.
  countSignoffNudge(slug: string, anchor: string | null): void
  // Give the allowance back. Called when the thread SIGNS OFF — the only event that proves the nudge
  // worked, and the only one frizz cannot cause by nudging.
  resetSignoffNudges(slug: string): void
  // The same pair for SOURCE 12's corrective bumps. Counted on delivery; the allowance comes back only
  // when the thread rests on a park frizz can actually honour.
  countParkBump(slug: string, anchor: string | null): void
  resetParkBumps(slug: string): void
  // Stamp a delivered ON REST prompt, guarded on the generation so one settling after an edit cannot
  // write onto words it no longer describes.
  stampRecurringRestFired(slug: string, armedAt: string, firedAt: string): boolean
  // Stamp a delivered ON SCHEDULE prompt. Same guard, and load-bearing rather than cosmetic: the next
  // one is due an interval after THIS stamp.
  stampRecurringScheduleFired(slug: string, armedAt: string, firedAt: string): boolean
  // Stamp a delivered POST-COMPACTION prompt. Same guard; cosmetic like the rest trigger's, since a
  // compaction is an event rather than a deadline and every one of them fires.
  stampRecurringCompactFired(slug: string, armedAt: string, firedAt: string): boolean
  // Clears elapsed PROMPTLESS values atomically and returns the number changed. The board calls this at
  // each refresh and at its exact wake timer so restart/reload cannot leave a stale Snoozed marker behind.
  // A snooze carrying a prompt survives its deadline until the scheduler has delivered its bump.
  clearExpiredSnoozes(now: string): number
  // Persist an EXPLICIT human title and LOCK it against every backend auto-title. The flag flips are
  // atomic with the text write so no board refresh, transcript ai-title, resume upsert, or server
  // restart can see the new title as machine-generated or still replaceable.
  setTitle(slug: string, title: string): void
  // Persist the WORKER's own considered name (`mcp__frizz__title`), marked `title_agent = 1` so the
  // display can trust it once live telemetry is gone. Refused — `false`, not a throw — when a human has
  // claimed the name, because that is a legitimate answer the worker should be told rather than an
  // error it will retry. Never touches `title_auto`: which machine wrote the current text does not
  // change the row's display provenance, and leaving it set is what keeps a human rename outranking.
  setAgentTitle(slug: string, title: string): boolean
  // AI rename is asynchronous. Commit only if this is still the same session with the same title
  // provenance captured at start, so a later manual rename/re-dispatch always wins.
  setTitleIfCurrent(
    slug: string,
    title: string,
    expected: { sessionId: string; title: string | null; titleAuto: number },
  ): boolean
  // Persist an automatically-derived title without changing its display provenance. The full runtime
  // identity and the title_locked guard make a late transcript fold harmless after manual rename,
  // resume, or same-slug replacement; a later trustworthy native auto-title may still supersede this
  // fallback. Deliberately NOT gated on title_auto: an uninformative title hard-coded by a dispatch
  // CALLER is displayable-but-replaceable, and this is the write that replaces it.
  setAutoTitleIfCurrent(slug: string, title: string, expected: AutoTitleExpectation): boolean
  // Hard-delete a session row — the "Dismiss/forget" verb for a phantom the user wants GONE, not merely
  // shelved (Archive only sets state='archived'). DELETEs the registry row AND records a TOMBSTONE on its
  // session_id + transcript_id, so foreign-discovery (which surfaces any fresh unregistered *.jsonl in the
  // log dir) can never resurrect the same transcript as a read-only "foreign" thread after the row is
  // gone. Idempotent: forgetting an absent/already-forgotten slug is a no-op. A fresh dispatch mints a NEW
  // session_id (never tombstoned), so re-dispatching the same slug still works — the tombstone keys on the
  // OLD session id only. Returns the forgotten row (for the caller to tear down its tailer state), or
  // undefined when nothing was there.
  forgetSession(slug: string): SessionRow | undefined
  // Forget only the row/runtime generation and finalized adoption owner the caller stopped. A
  // concurrent resume/replacement wins without having its new row or claim deleted by stale work.
  forgetSessionIfCurrent(slug: string, expected: ForgetSessionExpectation): SessionRow | undefined
  // Every tombstoned transcript id (session_id + any discovered transcript_id of a forgotten row). The
  // tailer's foreign-discovery consults this so a forgotten phantom's transcript stays excluded forever.
  forgottenIds(): Set<string>
  // ---- RETIRED BACKGROUND OPS — the × the operator clicked, remembered across restarts ----
  //
  // The tailer folds a background op into existence from its DISPATCH record and retires it on a
  // TERMINAL one. A killed shell never gets the terminal record — measured, twice: the provider writes
  // nothing to the transcript when it stops one (backend/_live_shell_stop_notice.mts) and leaves no
  // disk trace either (backend/_live_shell_stop_trace.mts, whose control shows a normally-finished
  // shell keeps its output file exactly as a killed one does). So the fold has no way to learn the op
  // ended, and any re-prime — a frizz restart above all — re-creates it as LIVE off a tool_use that
  // will never get a result.
  //
  // That is not hypothetical: the maintainer's own board carried a killed shell reading "57hr 18m",
  // and one cold fold of their real transcript reproduced it exactly. This table is the missing
  // memory, and it is the ONLY thing standing between a dismissed row and its own resurrection.
  retireOp(slug: string, sessionId: string, opId: string): void
  /** Every op id retired for this exact (slug, session) — consulted by the fold, so an id in here can
   *  never become a live row again. Empty for a session that has never had an × clicked. */
  retiredOps(slug: string, sessionId: string): Set<string>
  /** Lift a retirement, because the op RESTARTED under the same id. The dismissal was aimed at the run
   *  that ended; keeping it would silently hide the new one on the next prime. */
  unretireOp(slug: string, sessionId: string, opId: string): void
  // Codex-support epic (Phase 2): pin the agent backend + its native session id on a row AFTER
  // dispatch. Kept OFF the shared upsert (whose named-param statement every claude caller + test
  // fixture feeds) so the codex path is purely additive — a claude dispatch never calls these, so its
  // `backend` stays the column DEFAULT 'claude' and `agent_session_id` stays NULL.
  setBackend(slug: string, backend: string): void
  setAgentSession(slug: string, agentSessionId: string): void
  setCodexRuntime(slug: string, runtime: string): void
  setClaudeRuntime(slug: string, runtime: string): void
  setProfile(slug: string, model: string, effort: string): void
  setPermissionMode(slug: string, permissionMode: string): void
  setPermissionPending(slug: string, permissionMode: string | null): void
  beginRuntimeControl(
    slug: string,
    expected: { sessionId: string; nativeSessionId: string | null; generation: number },
    kind: RuntimeControlKind,
  ): number | null
  releaseRuntimeControl(
    slug: string,
    expected: { sessionId: string; generation: number; kind: RuntimeControlKind; revision: number },
  ): boolean
  setProfileTargetIfCurrent(
    slug: string,
    expected: { sessionId: string; nativeSessionId: string | null; generation: number },
    profile: { model: string; effort: string },
  ): boolean
  armProfileChange(
    slug: string,
    expected: { sessionId: string; nativeSessionId: string | null; generation: number },
    profile: { model: string; effort: string },
    handoff: ProfileHandoffJournal,
  ): { profileRevision: number; controlRevision: number; profileHandoff: string } | null
  checkpointProfileChange(
    slug: string,
    expected: ProfileChangeExpectation,
    handoff: ProfileHandoffJournal,
  ): string | null
  commitProfileChange(slug: string, expected: ProfileChangeExpectation): boolean
  restoreProfileChange(
    slug: string,
    expected: ProfileChangeExpectation,
    previous: { model: string; effort: string },
    error: string,
  ): boolean
  blockProfileChange(slug: string, expected: ProfileChangeExpectation, error: string): boolean
  failProfileChange(slug: string, expected: ProfileChangeExpectation, error: string): boolean
  setObservedProfileIfCurrent(
    slug: string,
    expected: { sessionId: string; generation: number },
    profile: { model: string; effort: string },
  ): boolean
  // Stamp a new process generation BEFORE spawn. The expected pending value is part of ownership:
  // a different/recovered permission request cannot be overtaken by a late starter.
  beginRuntimeGeneration(slug: string, expected: RuntimeExpectation, spawnedAt: string): number | null
  setPermissionStateIfCurrent(
    slug: string,
    expected: RuntimeExpectation,
    state: { exited: boolean; permissionMode: string; permissionPending: string | null; controlError: string | null },
  ): boolean
  setObservedPermissionIfCurrent(slug: string, sessionId: string, generation: number, permissionMode: string): boolean
  setControlErrorIfCurrent(slug: string, sessionId: string, generation: number, error: string | null): boolean
  setControlError(slug: string, error: string | null): void
  setDeliveryLedger(slug: string, ledger: string | null): void
  getSetting(key: string): unknown
  setSetting(key: string, value: unknown): void
  deleteSetting(key: string): void
  close(): void
}

export type SessionLifecycleEvent =
  | { type: "replaced"; previous: SessionRow; current: SessionRow }
  | { type: "deleted"; previous: SessionRow }

/**
 * Every table Frizz keeps for a project, in ONE database shared by every project (2026-08-27).
 *
 * Complete AS OF the 2026-08-27 unification: this schema is only ever created by this code, into a
 * file this code owns, so there is no PRE-unification shape to reconcile with. Columns added since
 * ride the short additive ALTER list in ensureStorageSchema below — an existing unified file cannot
 * gain a column any other way. A project's pre-unification file is read by `legacy-project-db.ts`,
 * which still carries the old ALTER stack, and imported row by row by `frizz-db.ts`. Every table's first column is `project_id`, every
 * natural key is prefixed with it, and every index leads with it — a tenant only ever asks for its
 * own rows (project-scope.ts), so that is the prefix every lookup has.
 *
 * `title_locked` defaults to 1 for the reason the old ADD COLUMN did: a writer that forgets the
 * column fails safe, into a title that cannot be replaced rather than one silently overwritten.
 */
export const STORAGE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS session (
      project_id  TEXT NOT NULL,
      slug        TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      thread_name TEXT NOT NULL,
      spawned_at  TEXT NOT NULL,
      last_read_at TEXT,
      unread      INTEGER NOT NULL DEFAULT 0,
      exited      INTEGER NOT NULL DEFAULT 0,
      archived    INTEGER NOT NULL DEFAULT 0,
      title_auto  INTEGER NOT NULL DEFAULT 0,
      title_locked INTEGER NOT NULL DEFAULT 1,
      rested_at   TEXT,
      title       TEXT,
      state       TEXT,
      snoozed_until TEXT,
      snooze_prompt TEXT,
      bg_snooze_rested_at TEXT,
      pinned_at   TEXT,
      meta        TEXT,
      seen_at     TEXT,
      transcript_id TEXT,
      backend     TEXT NOT NULL DEFAULT 'claude',
      agent_session_id TEXT,
      model       TEXT,
      effort      TEXT,
      profile_pending_model TEXT,
      profile_pending_effort TEXT,
      profile_revision INTEGER NOT NULL DEFAULT 0,
      profile_handoff TEXT,
      permission_mode TEXT,
      permission_pending TEXT,
      permission_set_at TEXT,
      profile_set_at TEXT,
      control_error TEXT,
      delivery_ledger TEXT,
      runtime_generation INTEGER NOT NULL DEFAULT 0,
      runtime_control TEXT,
      runtime_control_revision INTEGER NOT NULL DEFAULT 0,
      -- Codex transport discriminator: 'app-server' = a bridge-owned JSON-RPC session. NULL/'tmux' is
      -- the pre-app-server legacy value, still readable on an imported row and never written again.
      codex_runtime TEXT,
      -- Claude transport discriminator: 'broker' = a session-broker-owned Agent SDK session; NULL/'tmux'
      -- is the pre-broker legacy value, same story.
      claude_runtime TEXT,
      -- THE RECURRING PROMPT (scheduler.ts SOURCES 4, 5 and 7): one text, three independent triggers —
      -- every time the thread rests, every N ms on a clock, and/or every time its context is compacted.
      -- All flags 0 = off; there is no separate enable column, because another flag could only ever
      -- contradict the ones that decide the behaviour.
      recurring_prompt TEXT,
      recurring_on_rest INTEGER NOT NULL DEFAULT 0,
      recurring_on_schedule INTEGER NOT NULL DEFAULT 0,
      recurring_on_compact INTEGER NOT NULL DEFAULT 0,
      recurring_interval_ms INTEGER,
      recurring_armed_at TEXT,
      recurring_rest_fired_at TEXT,
      recurring_schedule_fired_at TEXT,
      recurring_compact_fired_at TEXT,
      -- THE BUILT-IN SIGN-OFF NUDGE (scheduler SOURCE 9): how many times in a row frizz has told this
      -- thread how to sign off without a fence appearing, and the last-nudged delivery id.
      signoff_nudges INTEGER NOT NULL DEFAULT 0,
      signoff_nudge_anchor TEXT,
      -- Cleared by resetParkBumps when a park is actually HONOURED.
      park_bumps INTEGER NOT NULL DEFAULT 0,
      park_bump_anchor TEXT,
      -- Title provenance for the CURRENT text: 1 = the worker's own title signal wrote it.
      title_agent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, slug)
    );
    CREATE INDEX IF NOT EXISTS session_snoozed_until_idx ON session(project_id, snoozed_until);
    CREATE TABLE IF NOT EXISTS settings (
      project_id TEXT NOT NULL,
      key   TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (project_id, key)
    );
    -- Forgotten-transcript graveyard: a transcript id (a session_id or a discovered transcript_id) whose
    -- registry row was hard-deleted via forgetSession. Foreign-discovery excludes these so a dismissed
    -- phantom can never re-surface as a read-only "foreign" thread on a later log-dir rescan.
    CREATE TABLE IF NOT EXISTS tombstone (
      project_id    TEXT NOT NULL,
      transcript_id TEXT NOT NULL,
      slug          TEXT NOT NULL,
      forgotten_at  TEXT NOT NULL,
      PRIMARY KEY (project_id, transcript_id)
    );
    CREATE TABLE IF NOT EXISTS adoption_claim (
      project_id          TEXT NOT NULL,
      slug                TEXT NOT NULL,
      attempt_token       TEXT NOT NULL,
      session_id          TEXT NOT NULL,
      state               TEXT NOT NULL CHECK (state IN ('reserved', 'spawned', 'recovering', 'finalized')),
      reserved_at_ms      INTEGER NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL,
      recovery_token      TEXT,
      pane_id             TEXT,
      pane_pid            INTEGER,
      session_created     INTEGER,
      finalized_at_ms     INTEGER,
      PRIMARY KEY (project_id, slug),
      UNIQUE (project_id, attempt_token),
      UNIQUE (project_id, session_id),
      CHECK (
        (pane_id IS NULL AND pane_pid IS NULL AND session_created IS NULL) OR
        (pane_id IS NOT NULL AND pane_pid IS NOT NULL AND session_created IS NOT NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS adoption_retired_attempt (
      project_id    TEXT NOT NULL,
      attempt_token TEXT NOT NULL,
      slug          TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      retired_at_ms INTEGER NOT NULL,
      PRIMARY KEY (project_id, attempt_token)
    );
    CREATE INDEX IF NOT EXISTS adoption_retired_attempt_slug_idx
      ON adoption_retired_attempt(project_id, slug);
    -- A background op the operator RETIRED (the × on its row), by its dispatch tool_use id.
    --
    -- This has to be durable, and the reason is measured rather than defensive. Killing a background
    -- shell writes NOTHING anywhere frizz can re-read: not a tool_result in the session JSONL (verified
    -- in backend/_live_shell_stop_notice.mts — the transcript gains not one record), and not on disk
    -- (backend/_live_shell_stop_trace.mts — the output file survives the kill exactly as a normally
    -- finished shell's does, so file-absence proves nothing). The tailer's retirement therefore lived
    -- only in memory, and ANY re-prime re-created the row as live off a tool_use that will never get a
    -- result — forever. Reproduced from the maintainer's own 57-hour phantom: one cold fold of their
    -- real transcript brings the killed shell straight back.
    --
    -- Keyed by SESSION as well as slug: a re-dispatched slug is a different conversation whose ids
    -- come from a different transcript, and it must not inherit this one's retirements.
    CREATE TABLE IF NOT EXISTS retired_op (
      project_id TEXT NOT NULL,
      slug       TEXT NOT NULL,
      session_id TEXT NOT NULL,
      op_id      TEXT NOT NULL,
      retired_at TEXT NOT NULL,
      PRIMARY KEY (project_id, slug, session_id, op_id)
    );
    -- A worker's ONE-OFF TIMERS (scheduler SOURCE 6): text to hand back at one instant, once.
    --
    -- A TABLE rather than more recurring_* columns on the session, because the feature's whole premise
    -- is that a thread may hold ARBITRARILY MANY at a time — a row can hold one arrangement, and "check
    -- the deploy in 10 min AND re-read the spec in an hour" is two.
    --
    -- Keyed by SLUG, not by session: a timer is armed by the worker's MCP server, which keeps its slug
    -- across every resume while the session id underneath it bumps (the same reason
    -- setRecurringPromptBySlug is slug-keyed). A resumed thread is still the thread that set the alarm.
    --
    -- state is the whole lifecycle: 'armed' until the scheduler's delivery reaches a terminal state,
    -- then 'fired' — which is what stops a second delivery once the outbox has pruned the terminal row
    -- that would otherwise dedupe it — or 'cancelled' when the worker withdraws it.
    CREATE TABLE IF NOT EXISTS thread_timer (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      thread_slug TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      fire_at     INTEGER NOT NULL,
      state       TEXT NOT NULL CHECK (state IN ('armed', 'fired', 'cancelled')),
      created_at  INTEGER NOT NULL,
      settled_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS thread_timer_due
      ON thread_timer(project_id, state, fire_at);
    CREATE INDEX IF NOT EXISTS thread_timer_slug
      ON thread_timer(project_id, thread_slug, state, fire_at);
    -- A worker's registered PR WATCHERS (2026-08-14). Registered by tool call, never by a fence: the
    -- fence states what a thread is waiting on, and watching is a separate, orthogonal thing that
    -- happens whether or not anything is written down (maintainer: "We should have a tool for this. The
    -- agent should have a tool to register a PR watcher").
    --
    -- REPEATING, not one-shot. It reports CI turning green or red (or being held for an approval),
    -- every later review or comment, and the PR's own state moving — a label, a conflict, a review
    -- request — so it stays armed and carries a cursor; only a merge or a close settles it.
    CREATE TABLE IF NOT EXISTS pr_watch (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      thread_slug TEXT NOT NULL,
      owner       TEXT NOT NULL,
      repo        TEXT NOT NULL,
      number      INTEGER NOT NULL,
      state       TEXT NOT NULL CHECK (state IN ('armed', 'dropped', 'settled')),
      created_at  INTEGER NOT NULL,
      settled_at  INTEGER,
      cursor      TEXT,
      -- When this watcher stops polling by itself. REQUIRED at registration (2026-08-15): a PR nobody
      -- ever touches would otherwise be polled forever, and the thread parked on it would wait forever
      -- with it. Nullable in the column only so an imported older row reads; the tool refuses to arm
      -- without one.
      expires_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS pr_watch_armed
      ON pr_watch(project_id, state);
    CREATE INDEX IF NOT EXISTS pr_watch_slug
      ON pr_watch(project_id, thread_slug, state, created_at);
    -- A worker's registered WATCHES on its own running work (2026-08-26). See
    -- plans/rest-by-registration.md: a wait stops being a line the worker re-writes at every rest and
    -- becomes a row it creates once, which the human sees in the queue and which wakes the thread itself.
    --
    -- KIND is stored and checked against the target's own shape at registration, so a PR ref can never
    -- arm as a shell. EXPIRES_AT is REQUIRED, chosen by the worker for this particular wait: on elapse
    -- the row is cancelled and the thread woken, so a registration cannot outlive its own relevance the
    -- way an un-restated fence never could. (An earlier thread_watch, retired 2026-08-14 with different
    -- kinds and no expiry, is dropped from a legacy file before import — see legacy-project-db.ts.)
    CREATE TABLE IF NOT EXISTS thread_watch (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      thread_slug TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('shell', 'agent')),
      -- The handle the worker was shown: a runtime task id, a launch tool_use id, or the op's label.
      -- Resolved against live telemetry when the row is rendered; an unresolvable one still renders,
      -- naming itself, exactly as the fence-derived row did.
      target      TEXT NOT NULL,
      state       TEXT NOT NULL CHECK (state IN ('armed', 'dropped', 'expired', 'settled')),
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      settled_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS thread_watch_due
      ON thread_watch(project_id, state, expires_at);
    CREATE INDEX IF NOT EXISTS thread_watch_slug
      ON thread_watch(project_id, thread_slug, state, created_at);
    -- One armed watch per (thread, kind, target): re-registering the same wait is idempotent rather than
    -- a second row that has to be dropped twice. Partial, so a dropped row never blocks a re-arm.
    CREATE UNIQUE INDEX IF NOT EXISTS thread_watch_unique_armed
      ON thread_watch(project_id, thread_slug, kind, target) WHERE state = 'armed';
    -- A worker's registered QUESTIONS for the human (2026-08-26). The other half of
    -- plans/rest-by-registration.md, and the same argument as thread_watch directly above: a fenced
    -- question block has the LIFETIME OF THE MESSAGE CARRYING IT, so the stop hook clobbers it, a
    -- follow-up turn buries it, and the one copy the human owes an answer to is gone. A row is not.
    --
    -- ONE ROW PER ROOT QUESTION, not per ask CALL and not per node. The root is the unit the human
    -- acts on: it is what the x dismisses and what unask withdraws, so it is what needs an id. An ask
    -- naming three questions writes three rows; the follow-ups hanging off an option live inside this
    -- row's spec column, because a branch nobody took is not a question anybody owes an answer to.
    --
    -- NO EXPIRY COLUMN, deliberately, and the one real difference from thread_watch. A watch waits on
    -- work, which ends; a question waits on a PERSON, and a person owes an answer until they give one.
    -- A timing-out question either re-asks as noise or silently drops something a human still owed.
    CREATE TABLE IF NOT EXISTS thread_question (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      thread_slug TEXT NOT NULL,
      -- The question TREE as the worker submitted it, validated at the RPC boundary and stored verbatim
      -- (AskedQuestion in @frizz/shared). JSON rather than columns because the shape is recursive: an
      -- option may carry follow-ups, three levels deep.
      spec        TEXT NOT NULL,
      state       TEXT NOT NULL CHECK (state IN ('open', 'answered', 'withdrawn', 'dismissed')),
      -- The structured answer, keyed by question id and RESTATING each question's text, because the
      -- worker never saw the id -- frizz minted it -- so an id alone cannot be correlated back. Null
      -- until the human sends; null forever on a withdrawn or dismissed row.
      answer      TEXT,
      -- Has the worker been handed this answer yet? A question is answered by the human and DELIVERED
      -- separately, exactly as a wake is: the row must survive the gap, or an answer given while the
      -- worker's process was down is lost in the same silence the fence used to lose the question in.
      delivered   INTEGER NOT NULL DEFAULT 0,
      asked_at    INTEGER NOT NULL,
      settled_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS thread_question_slug
      ON thread_question(project_id, thread_slug, state, asked_at);
    CREATE INDEX IF NOT EXISTS thread_question_undelivered
      ON thread_question(project_id, state, delivered);
    -- THE WORKER'S OWN COMPLETION, as a row (2026-08-27). The 'done' FENCE said the same thing and had
    -- the same weakness every fence has: it is a sentence in a message, so nothing can refuse it. A
    -- gate can refuse a TOOL CALL -- before the card renders -- while a fence can only be bumped after
    -- the fact, by which time the human has already read a completion the worker did not earn.
    --
    -- ONE ROW PER THREAD, replaced on each call: a worker declaring itself done twice has not finished
    -- two things. There is no state column and no settled_at, because a done row is spent by the human
    -- SENDING MORE WORK rather than by anything frizz does -- board.ts compares done_at against the
    -- newest user record and simply stops honouring an older one. That mirrors the fence exactly (the
    -- next assistant message replaced it) without a sweep to forget one.
    CREATE TABLE IF NOT EXISTS thread_done (
      project_id  TEXT NOT NULL,
      thread_slug TEXT NOT NULL,
      -- The markdown the card renders, the same body the fence carried between its backticks.
      body        TEXT NOT NULL,
      done_at     INTEGER NOT NULL,
      PRIMARY KEY (project_id, thread_slug)
    );
`

/** Every table this module owns, for the importer and the project purge. */
export const STORAGE_TABLES = [
  "session", "settings", "tombstone", "adoption_claim", "adoption_retired_attempt", "retired_op",
  "thread_timer", "pr_watch", "thread_watch", "thread_question", "thread_done",
] as const

/** Idempotent; run by every createStorage and by frizz-db.ts before an import. */
export function ensureStorageSchema(db: Database): void {
  db.exec(STORAGE_SCHEMA)
  // Columns added AFTER the 2026-08-27 unification. CREATE TABLE IF NOT EXISTS cannot add a column to
  // a file that already exists, and every live install predates any column below — so each rides one
  // additive ALTER here, exactly the stack the schema comment above says the unified file was born
  // without. Keep the list append-only; the try/catch is the "already there" case.
  for (const column of ["pinned_at TEXT"]) {
    try {
      db.exec(`ALTER TABLE session ADD COLUMN ${column}`)
    } catch {
      // duplicate column — the file already has it
    }
  }
}

/**
 * A project's view of the registry.
 *
 * `source` is either the SHARED connection (production: one file, every project — see frizz-db.ts),
 * in which case `close()` releases only this project's listeners and leaves the connection to its
 * owner, or a PATH (tests, and any caller that wants a private file), in which case the connection is
 * this storage's own and `close()` closes it. Either way every statement below is prepared through the
 * project scope, so it can only ever see `projectId`'s rows.
 */
export function createStorage(source: string | Database, projectId: string): Storage {
  const owned = typeof source === "string"
  const db = owned ? new Database(source) : source
  if (owned) {
    db.pragma("busy_timeout = 5000")
    db.pragma("journal_mode = WAL")
  }
  ensureStorageSchema(db)
  const scope = scopeDatabase(db, projectId)

  const interactions = createInteractionStore(db)
  const lifecycleListeners = new Set<(event: SessionLifecycleEvent) => void>()
  let closed = false
  const emitSessionLifecycle = (event: SessionLifecycleEvent) => {
    for (const listener of [...lifecycleListeners]) listener(event)
  }

  const selOne = scope.prepare<[string], SessionRow>("SELECT * FROM session WHERE project_id = @project_id AND slug = ?")
  const selAll = scope.prepare<[], SessionRow>("SELECT * FROM session WHERE project_id = @project_id")

  // ---- the whole-table read, memoised --------------------------------------------------------------
  // `allSessions()` is the single hottest operation in the server. It is not a background chore: the
  // tailer calls it TWICE per tick (once at the top of tick(), once inside scanForeign), and the tick
  // is nudge-driven, so on a busy board it runs tens of times a second. A live CPU profile of the
  // maintainer's own server (290 rows, 60 columns) put it at 32% of the entire process — more than half
  // of all tailer time — with node:sqlite's row→object conversion (`plainRow`) alone at 24%. Every tick
  // was re-materialising ~17,000 cells that had not changed, and because a tick runs SYNCHRONOUSLY on
  // the event loop, that cost lands directly on RPC latency and board pushes. The cost also grows with
  // HISTORY, not with live work: 267 of those 290 rows were archived threads nobody was watching.
  //
  // So keep the last read and re-run the query only when the database actually moved. Two cheap probes
  // decide that, and they are deliberately BOTH here:
  //   * `total_changes()` (~0.3µs) counts rows this connection has inserted/updated/deleted. It moves
  //     for any write we made, whatever table — over-invalidating (a `tail_state` flush re-reads the
  //     sessions) but never under-invalidating, which is the only direction that could serve stale rows.
  //     A no-op UPDATE that matches nothing does not move it, so the per-assemble snooze sweep is free.
  //   * `PRAGMA data_version` (~1.8µs) changes only when ANOTHER connection commits. Today one process
  //     owns each project DB, so this never fires; it is here so that if that ever stops being true the
  //     failure mode is a re-read rather than a board frozen forever.
  // Both are read on every call rather than trusting a hand-maintained version counter: there are ~40
  // statements that write this table, and a new one added later must not be able to silently serve
  // stale rows to the board.
  //
  // The returned array is SHARED, hence `readonly SessionRow[]` on the interface — the compiler is what
  // keeps a caller from sorting or splicing the cache out from under the next one.
  const dataVersionStmt = db.prepare<[], { data_version: number }>("PRAGMA data_version")
  let cachedSessions: SessionRow[] | null = null
  let cachedBySlug: Map<string, SessionRow> | null = null
  let cachedAtChanges = -1
  let cachedAtDataVersion = -1
  const readAllSessions = () => selAll.all().filter((row) => ThreadSlug.safeParse(row.slug).success)
  // True while the memoised snapshot is still the database's current state. Both probes are read every
  // time; see the note above for why neither alone is enough.
  const cacheIsCurrent = (): boolean => {
    if (db.inTransaction) return false
    const changes = scope.writes()
    const dataVersion = dataVersionStmt.get()?.data_version ?? -1
    if (cachedSessions && changes === cachedAtChanges && dataVersion === cachedAtDataVersion) return true
    cachedSessions = null
    cachedBySlug = null
    cachedAtChanges = changes
    cachedAtDataVersion = dataVersion
    return false
  }
  const allSessions = (): readonly SessionRow[] => {
    // NEVER cache a read taken inside an open transaction. `total_changes()` counts statements as they
    // execute and a ROLLBACK does not wind it back, so a mid-transaction read stored under the
    // post-write watermark would survive the rollback as a view of data that no longer exists. Nothing
    // on the hot path (the tick, board assembly) runs inside a transaction, so this costs nothing.
    if (db.inTransaction) return readAllSessions()
    if (cacheIsCurrent() && cachedSessions) return cachedSessions
    cachedSessions = readAllSessions()
    return cachedSessions
  }
  // The single-row read rides the SAME snapshot, for the same reason. `tailer.get()` asks
  // `registeredStateIsCurrent` for every row the board assembles, so a 427-row board ran 427 of these
  // per build on top of the whole-table read — the residual `plainRow`/`get` cost left over once
  // allSessions stopped dominating. A slug lookup is answered off a Map built once per snapshot; a MISS
  // still hits the database, because a row this connection has not read is not a row this cache can
  // speak for. Freshness is identical to allSessions() by construction: same probes, same invalidation.
  const getSession = (slug: string): SessionRow | undefined => {
    if (!ThreadSlug.safeParse(slug).success) return undefined
    if (db.inTransaction) return selOne.get(slug)
    if (!cacheIsCurrent() || !cachedSessions) return selOne.get(slug)
    if (!cachedBySlug) cachedBySlug = new Map(cachedSessions.map((row) => [row.slug, row]))
    return cachedBySlug.get(slug) ?? selOne.get(slug)
  }
  const upsertStmt = scope.prepare(`
    INSERT INTO session (project_id, slug, session_id, thread_name, spawned_at, last_read_at, unread, exited, title_auto, title_locked, title, state, snoozed_until, snooze_prompt, meta, seen_at, transcript_id, model, effort, profile_pending_model, profile_pending_effort, profile_revision, profile_handoff, permission_mode, permission_pending, control_error, runtime_generation, runtime_control, runtime_control_revision)
    VALUES (@project_id, @slug, @session_id, @thread_name, @spawned_at, @last_read_at, @unread, @exited, @title_auto, @title_locked, @title, @state, @snoozed_until, @snooze_prompt, @meta, @seen_at, @transcript_id, @model, @effort, @profile_pending_model, @profile_pending_effort, @profile_revision, @profile_handoff, @permission_mode, @permission_pending, @control_error, @runtime_generation, @runtime_control, @runtime_control_revision)
    ON CONFLICT(project_id, slug) DO UPDATE SET
      session_id = excluded.session_id,
      thread_name  = excluded.thread_name,
      spawned_at = excluded.spawned_at,
      last_read_at = excluded.last_read_at,
      unread = excluded.unread,
      exited = excluded.exited,
      title_auto = excluded.title_auto,
      title_locked = excluded.title_locked,
      title = excluded.title,
      -- This statement REPLACES the title text, so the provenance of the old one cannot survive it: a
      -- re-dispatch over a slug whose worker had already named itself would otherwise keep reading as
      -- agent-written while displaying the fresh dispatch chop. The next title signal sets it again.
      title_agent = 0,
      snoozed_until = excluded.snoozed_until,
      -- Always moves WITH the instant: a spread row carries both, a re-dispatch clears both. An armed
      -- prompt outliving its deadline would be a wake nothing can ever fire.
      snooze_prompt = excluded.snooze_prompt,
      model = excluded.model,
      effort = excluded.effort,
      profile_pending_model = excluded.profile_pending_model,
      profile_pending_effort = excluded.profile_pending_effort,
      profile_revision = excluded.profile_revision,
      profile_handoff = excluded.profile_handoff,
      permission_mode = excluded.permission_mode,
      permission_pending = excluded.permission_pending,
      control_error = excluded.control_error,
      runtime_generation = CASE
        WHEN session.session_id = excluded.session_id THEN MAX(session.runtime_generation, excluded.runtime_generation)
        ELSE excluded.runtime_generation
      END,
      runtime_control = excluded.runtime_control,
      runtime_control_revision = excluded.runtime_control_revision,
      -- A re-dispatch/adopt carries a FRESH session_id, so the old discovered path is stale → adopt the
      -- incoming value (NULL for a fresh spawn); a resume spreads the existing row, preserving its cache.
      transcript_id = excluded.transcript_id,
      archived = 0,
      state = 'open'
  `)
  const insertSessionIfAbsentStmt = scope.prepare(`
    INSERT INTO session (
      project_id, slug, session_id, thread_name, spawned_at, last_read_at, unread, exited, archived, rested_at,
      title_auto, title_locked, title, transcript_id, state, snoozed_until, snooze_prompt,
      meta, seen_at, backend, agent_session_id,
      model, effort, profile_pending_model, profile_pending_effort, profile_revision, profile_handoff,
      permission_mode, permission_pending, control_error,
      runtime_generation, runtime_control, runtime_control_revision
    )
    VALUES (
      @project_id, @slug, @session_id, @thread_name, @spawned_at, @last_read_at, @unread, @exited, @archived,
      @rested_at, @title_auto, @title_locked, @title, @transcript_id, @state, @snoozed_until, @snooze_prompt,
      @meta, @seen_at,
      @backend, @agent_session_id, @model, @effort, @profile_pending_model,
      @profile_pending_effort, @profile_revision, @profile_handoff, @permission_mode, @permission_pending,
      @control_error, @runtime_generation, @runtime_control,
      @runtime_control_revision
    )
    ON CONFLICT(project_id, slug) DO NOTHING
  `)
  const selAdoptionClaim = scope.prepare<[string], AdoptionClaimRow>(
    "SELECT * FROM adoption_claim WHERE project_id = @project_id AND slug = ?",
  )
  const selAllAdoptionClaims = scope.prepare<[], AdoptionClaimRow>("SELECT * FROM adoption_claim WHERE project_id = @project_id")
  const selAllRetiredAdoptionAttempts = scope.prepare<[], RetiredAdoptionAttemptRow>(
    "SELECT * FROM adoption_retired_attempt WHERE project_id = @project_id ORDER BY retired_at_ms, attempt_token",
  )
  const selRetiredAdoptionAttempt = scope.prepare<[string], RetiredAdoptionAttemptRow>(
    "SELECT * FROM adoption_retired_attempt WHERE project_id = @project_id AND attempt_token = ?",
  )
  const putRetiredAdoptionAttempt = scope.prepare(`
    INSERT OR IGNORE INTO adoption_retired_attempt (project_id, attempt_token, slug, session_id, retired_at_ms)
    VALUES (@project_id, ?, ?, ?, ?)
  `)
  const reserveAdoptionClaimStmt = scope.prepare(`
    INSERT INTO adoption_claim (
      project_id, slug, attempt_token, session_id, state, reserved_at_ms, lease_expires_at_ms,
      recovery_token, pane_id, pane_pid, session_created, finalized_at_ms
    )
    SELECT @project_id, @slug, @attempt_token, @session_id, 'reserved', @reserved_at_ms, @lease_expires_at_ms,
           NULL, NULL, NULL, NULL, NULL
    WHERE NOT EXISTS (SELECT 1 FROM session WHERE project_id = @project_id AND slug = @slug)
      AND NOT EXISTS (
        SELECT 1 FROM adoption_retired_attempt WHERE project_id = @project_id AND attempt_token = @attempt_token
      )
    ON CONFLICT DO NOTHING
  `)
  const recordAdoptionPaneStmt = scope.prepare(`
    UPDATE adoption_claim
    SET state = 'spawned', pane_id = @pane_id, pane_pid = @pane_pid,
        session_created = @session_created, lease_expires_at_ms = @lease_expires_at_ms
    WHERE project_id = @project_id AND slug = @slug AND attempt_token = @attempt_token
      AND state IN ('reserved', 'spawned')
      AND (
        pane_id IS NULL OR
        (pane_id = @pane_id AND pane_pid = @pane_pid AND session_created = @session_created)
      )
  `)
  const renewAdoptionSpawnFenceStmt = scope.prepare(`
    UPDATE adoption_claim
    SET lease_expires_at_ms = ?
    WHERE project_id = @project_id AND slug = ? AND attempt_token = ? AND state IN ('reserved', 'spawned')
      AND recovery_token IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM adoption_retired_attempt
        WHERE adoption_retired_attempt.project_id = adoption_claim.project_id AND attempt_token = adoption_claim.attempt_token
      )
  `)
  const finalizeAdoptionClaimStmt = scope.prepare(`
    UPDATE adoption_claim
    SET state = 'finalized', finalized_at_ms = ?, recovery_token = NULL
    WHERE project_id = @project_id AND slug = ? AND attempt_token = ? AND session_id = ? AND state IN ('reserved', 'spawned')
  `)
  const rearmFinalizedAdoptionClaimStmt = scope.prepare(`
    UPDATE adoption_claim
    SET attempt_token = @attempt_token, state = 'reserved', reserved_at_ms = @reserved_at_ms,
        lease_expires_at_ms = @lease_expires_at_ms, recovery_token = NULL,
        pane_id = NULL, pane_pid = NULL, session_created = NULL, finalized_at_ms = NULL
    WHERE project_id = @project_id AND slug = @slug AND session_id = @session_id AND attempt_token = @previous_attempt_token
      AND state = 'finalized'
      AND EXISTS (
        SELECT 1 FROM session
        WHERE session.project_id = adoption_claim.project_id AND session.slug = adoption_claim.slug AND session.session_id = adoption_claim.session_id
      )
  `)
  const finalizeAdoptionRespawnClaimStmt = scope.prepare(`
    UPDATE adoption_claim
    SET state = 'finalized', finalized_at_ms = ?, recovery_token = NULL
    WHERE project_id = @project_id AND slug = ? AND attempt_token = ? AND session_id = ? AND state IN ('reserved', 'spawned')
      AND EXISTS (
        SELECT 1 FROM session
        WHERE session.project_id = adoption_claim.project_id AND session.slug = adoption_claim.slug AND session.session_id = adoption_claim.session_id
      )
  `)
  const restoreAdoptionNoPaneStmt = scope.prepare(`
    UPDATE adoption_claim
    SET state = 'finalized', recovery_token = NULL,
        pane_id = NULL, pane_pid = NULL, session_created = NULL,
        finalized_at_ms = COALESCE(finalized_at_ms, reserved_at_ms)
    WHERE project_id = @project_id AND slug = ? AND attempt_token = ? AND state IN ('reserved', 'spawned')
      AND EXISTS (
        SELECT 1 FROM session
        WHERE session.project_id = adoption_claim.project_id AND session.slug = adoption_claim.slug AND session.session_id = adoption_claim.session_id
      )
  `)
  const deleteAbandonedAdoptionClaimStmt = scope.prepare(`
    DELETE FROM adoption_claim
    WHERE project_id = @project_id AND slug = ? AND attempt_token = ? AND state IN ('reserved', 'spawned')
  `)
  const beginAdoptionRecoveryStmt = scope.prepare(`
    UPDATE adoption_claim
    SET state = 'recovering', recovery_token = ?, lease_expires_at_ms = ?
    WHERE project_id = @project_id AND slug = ? AND attempt_token = ? AND state != 'finalized' AND lease_expires_at_ms <= ?
  `)
  const restoreRecoveredAdoptionNoPaneStmt = scope.prepare(`
    UPDATE adoption_claim
    SET state = 'finalized', recovery_token = NULL,
        pane_id = NULL, pane_pid = NULL, session_created = NULL,
        finalized_at_ms = COALESCE(finalized_at_ms, reserved_at_ms)
    WHERE project_id = @project_id AND slug = ? AND attempt_token = ? AND state = 'recovering' AND recovery_token = ?
      AND EXISTS (
        SELECT 1 FROM session
        WHERE session.project_id = adoption_claim.project_id AND session.slug = adoption_claim.slug AND session.session_id = adoption_claim.session_id
      )
  `)
  const deleteRecoveredAdoptionClaimStmt = scope.prepare(`
    DELETE FROM adoption_claim
    WHERE project_id = @project_id AND slug = ? AND attempt_token = ? AND state = 'recovering' AND recovery_token = ?
  `)
  const delFinalizedAdoptionClaim = scope.prepare(`
    DELETE FROM adoption_claim WHERE project_id = @project_id AND slug = ? AND session_id = ? AND state = 'finalized'
  `)
  const retireFinalizedAdoptionClaimStmt = scope.prepare(`
    DELETE FROM adoption_claim
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND attempt_token = ? AND state = 'finalized'
  `)
  const readStmt = scope.prepare("UPDATE session SET last_read_at = ?, unread = 0 WHERE project_id = @project_id AND slug = ?")
  const unreadStmt = scope.prepare("UPDATE session SET unread = ? WHERE project_id = @project_id AND slug = ?")
  const unreadIfCurrentStmt = scope.prepare(`
    UPDATE session SET unread = ?
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const exitedStmt = scope.prepare("UPDATE session SET exited = ? WHERE project_id = @project_id AND slug = ?")
  const exitedIfCurrentStmt = scope.prepare(`
    UPDATE session SET exited = ?
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const completeIfCurrentStmt = scope.prepare(`
    UPDATE session
    SET exited = 1, state = 'archived', archived = 1, unread = 0, snoozed_until = NULL, snooze_prompt = NULL
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const restedStmt = scope.prepare("UPDATE session SET rested_at = ? WHERE project_id = @project_id AND slug = ?")
  const restedIfCurrentStmt = scope.prepare(`
    UPDATE session SET rested_at = ?
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const seenStmt = scope.prepare("UPDATE session SET seen_at = ? WHERE project_id = @project_id AND slug = ?")
  const transcriptIdStmt = scope.prepare("UPDATE session SET transcript_id = ? WHERE project_id = @project_id AND slug = ?")
  const transcriptIdIfCurrentStmt = scope.prepare(`
    UPDATE session SET transcript_id = ?
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const stateStmt = scope.prepare(
    "UPDATE session SET state = ?, archived = ?, unread = CASE WHEN ? = 1 THEN 0 ELSE unread END, snoozed_until = CASE WHEN ? = 1 THEN NULL ELSE snoozed_until END, snooze_prompt = CASE WHEN ? = 1 THEN NULL ELSE snooze_prompt END WHERE project_id = @project_id AND slug = ?",
  )
  const stateIfCurrentStmt = scope.prepare(`
    UPDATE session SET state = ?, archived = ?,
      unread = CASE WHEN ? = 1 THEN 0 ELSE unread END,
      snoozed_until = CASE WHEN ? = 1 THEN NULL ELSE snoozed_until END,
      snooze_prompt = CASE WHEN ? = 1 THEN NULL ELSE snooze_prompt END
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const snoozedUntilStmt = scope.prepare("UPDATE session SET snoozed_until = ?, snooze_prompt = ? WHERE project_id = @project_id AND slug = ?")
  const pinnedAtStmt = scope.prepare("UPDATE session SET pinned_at = ? WHERE project_id = @project_id AND slug = ?")
  // The session-guarded park. Deliberately leaves snooze_prompt alone: it parks an instant without
  // arming a scheduled bump, so a caller that wants both writes both.
  const snoozedUntilIfCurrentStmt = scope.prepare(`
    UPDATE session SET snoozed_until = ?
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const bgSnoozeRestedAtIfCurrentStmt = scope.prepare(`
    UPDATE session SET bg_snooze_rested_at = ?
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  // Every SET expression here reads the ORIGINAL row (SQLite evaluates the whole SET list against the
  // pre-update values), which is what lets one statement decide whether this write is a new arming or
  // an edit of the existing one. The generation — and with it the last-fired stamp — is preserved
  // exactly when the TEXT is unchanged, so toggling off and on again does not supersede a bump already
  // in flight for those same words, while editing the text does.
  // THE RECURRING PROMPT'S SET LIST, shared verbatim by the session-guarded and the by-slug statements
  // so the operator's path and the worker's path can never drift in behaviour — only in their WHERE.
  //
  // Every expression on the right reads the ORIGINAL row, so ONE statement decides whether this write is
  // a fresh arming or an edit: the generation survives exactly when the text AND the interval are both
  // unchanged. That is what makes a bare trigger flip non-destructive.
  //
  // The three fired-stamps clear ASYMMETRICALLY, and deliberately. A prompt edit invalidates all three
  // (the words that fired are gone). An interval-only change invalidates only the SCHEDULE's clock — the
  // rest and post-compaction triggers have no cadence for the interval to describe, so wiping their
  // "last sent" readout would be a lie about when the operator's text last reached the worker.
  const RECURRING_SET = `
      recurring_prompt = ?,
      recurring_interval_ms = CASE WHEN ? IS NULL THEN NULL ELSE ? END,
      recurring_on_rest = ?,
      recurring_on_schedule = ?,
      recurring_on_compact = ?,
      recurring_armed_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN recurring_armed_at IS NOT NULL AND recurring_prompt IS ? AND recurring_interval_ms IS ? THEN recurring_armed_at
        ELSE ? END,
      recurring_rest_fired_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN recurring_armed_at IS NOT NULL AND recurring_prompt IS ? THEN recurring_rest_fired_at
        ELSE NULL END,
      recurring_schedule_fired_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN recurring_armed_at IS NOT NULL AND recurring_prompt IS ? AND recurring_interval_ms IS ? THEN recurring_schedule_fired_at
        ELSE NULL END,
      recurring_compact_fired_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN recurring_armed_at IS NOT NULL AND recurring_prompt IS ? THEN recurring_compact_fired_at
        ELSE NULL END`
  // The 17 bound values RECURRING_SET consumes, in order. Factored out for the same reason the SET list
  // is: writing this argument list twice is how the two paths silently diverge.
  const recurringArgs = ({ prompt, stopHook, heartbeat, postCompaction, intervalMs, armedAt }: RecurringWrite) => {
    // A cleared row keeps nothing: no cadence, and every trigger off. No trigger can be left on over a
    // null prompt, or the scheduler would hold an armed row with nothing to say.
    const ms = prompt === null ? null : intervalMs
    const flag = (on: boolean) => (prompt === null || !on ? 0 : 1)
    return [
      prompt,
      ms, ms,
      flag(stopHook),
      flag(heartbeat),
      flag(postCompaction),
      prompt, prompt, ms, armedAt,
      prompt, prompt,
      prompt, prompt, ms,
      prompt, prompt,
    ] as const
  }
  const recurringStmt = scope.prepare(`UPDATE session SET ${RECURRING_SET}
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ?`)
  const recurringBySlugStmt = scope.prepare(`UPDATE session SET ${RECURRING_SET} WHERE project_id = @project_id AND slug = ?`)
  const recurringRestFiredStmt = scope.prepare(`
    UPDATE session SET recurring_rest_fired_at = ?
    WHERE project_id = @project_id AND slug = ? AND recurring_armed_at = ?
  `)
  const recurringScheduleFiredStmt = scope.prepare(`
    UPDATE session SET recurring_schedule_fired_at = ?
    WHERE project_id = @project_id AND slug = ? AND recurring_armed_at = ?
  `)
  const recurringCompactFiredStmt = scope.prepare(`
    UPDATE session SET recurring_compact_fired_at = ?
    WHERE project_id = @project_id AND slug = ? AND recurring_armed_at = ?
  `)
  // ---- ONE-OFF TIMERS ----------------------------------------------------------------------------
  const armTimerStmt = scope.prepare(`
    INSERT INTO thread_timer (project_id, id, thread_slug, prompt, fire_at, state, created_at, settled_at)
    VALUES (@project_id, @id, @slug, @prompt, @fireAtMs, 'armed', @createdAtMs, NULL)
  `)
  const timersBySlugStmt = scope.prepare<[string], ThreadTimerRow>(
    "SELECT * FROM thread_timer WHERE project_id = @project_id AND thread_slug = ? ORDER BY fire_at, id",
  )
  const armedTimersBySlugStmt = scope.prepare<[string], ThreadTimerRow>(
    "SELECT * FROM thread_timer WHERE project_id = @project_id AND thread_slug = ? AND state = 'armed' ORDER BY fire_at, id",
  )
  // The board's batched read of the same rows: every armed timer this project holds, in the SAME
  // `fire_at, id` order the per-slug statement above uses, so grouping it by slug reproduces that
  // statement's answer for every thread at once. Distinct from `dueTimersStmt` directly below, which
  // is the scheduler's and carries a deadline predicate this one must not.
  const armedTimersStmt = scope.prepare<[], ThreadTimerRow>(
    "SELECT * FROM thread_timer WHERE project_id = @project_id AND state = 'armed' ORDER BY fire_at, id",
  )
  const timerByIdStmt = scope.prepare<[string], ThreadTimerRow>("SELECT * FROM thread_timer WHERE project_id = @project_id AND id = ?")
  const dueTimersStmt = scope.prepare<[number], ThreadTimerRow>(
    "SELECT * FROM thread_timer WHERE project_id = @project_id AND state = 'armed' AND fire_at <= ? ORDER BY fire_at, id",
  )
  const cancelTimerStmt = scope.prepare(`
    UPDATE thread_timer SET state = 'cancelled', settled_at = ?
    WHERE project_id = @project_id AND id = ? AND thread_slug = ? AND state = 'armed'
  `)
  const fireTimerStmt = scope.prepare(`
    UPDATE thread_timer SET state = 'fired', settled_at = ?
    WHERE project_id = @project_id AND id = ? AND state = 'armed'
  `)
  const delThreadTimers = scope.prepare("DELETE FROM thread_timer WHERE project_id = @project_id AND thread_slug = ?")
  // IDEMPOTENT PER ANCHOR, which is what `settleSignoffNudge` has always claimed ("a retry of the same
  // delivery cannot count twice while a genuinely new fenceless rest does") and what the statement did
  // not do — it incremented unconditionally. That gap was harmless only while exactly one call site
  // counted; a nudge is now counted when it is SENT, and the confirm path that runs later for the same
  // item would otherwise count it a second time. `IS NOT` rather than `<>` so a NULL anchor (a fresh row,
  // or one just cleared by `resetSignoffNudges`) still counts.
  const countNudgeStmt = scope.prepare(`
    UPDATE session SET signoff_nudges = signoff_nudges + 1, signoff_nudge_anchor = ?
    WHERE project_id = @project_id AND slug = ? AND signoff_nudge_anchor IS NOT ?
  `)
  const resetNudgesStmt = scope.prepare(`
    UPDATE session SET signoff_nudges = 0, signoff_nudge_anchor = NULL
    WHERE project_id = @project_id AND slug = ? AND signoff_nudges > 0
  `)
  const countParkBumpStmt = scope.prepare(`
    UPDATE session SET park_bumps = park_bumps + 1, park_bump_anchor = ?
    WHERE project_id = @project_id AND slug = ?
  `)
  const resetParkBumpsStmt = scope.prepare(`
    UPDATE session SET park_bumps = 0, park_bump_anchor = NULL
    WHERE project_id = @project_id AND slug = ? AND park_bumps > 0
  `)
  const armPrWatchStmt = scope.prepare(`
    INSERT INTO pr_watch (project_id, id, thread_slug, owner, repo, number, state, created_at, settled_at, cursor, expires_at)
    VALUES (@project_id, @id, @slug, @owner, @repo, @number, 'armed', @createdAtMs, NULL, NULL, @expiresAtMs)
  `)
  const expiredPrWatchesStmt = scope.prepare<[number], PrWatchRow>(
    "SELECT * FROM pr_watch WHERE project_id = @project_id AND state = 'armed' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at, id",
  )
  const prWatchesBySlugStmt = scope.prepare<[string], PrWatchRow>(
    "SELECT * FROM pr_watch WHERE project_id = @project_id AND thread_slug = ? ORDER BY created_at, id",
  )
  const armedPrWatchesBySlugStmt = scope.prepare<[string], PrWatchRow>(
    "SELECT * FROM pr_watch WHERE project_id = @project_id AND thread_slug = ? AND state = 'armed' ORDER BY created_at, id",
  )
  const prWatchByIdStmt = scope.prepare<[string], PrWatchRow>("SELECT * FROM pr_watch WHERE project_id = @project_id AND id = ?")
  const armedPrWatchesStmt = scope.prepare<[], PrWatchRow>(
    "SELECT * FROM pr_watch WHERE project_id = @project_id AND state = 'armed' ORDER BY created_at, id",
  )
  const dropPrWatchStmt = scope.prepare(`
    UPDATE pr_watch SET state = 'dropped', settled_at = ?
    WHERE project_id = @project_id AND id = ? AND thread_slug = ? AND state = 'armed'
  `)
  const settlePrWatchStmt = scope.prepare(`
    UPDATE pr_watch SET state = 'settled', settled_at = ?
    WHERE project_id = @project_id AND id = ? AND state = 'armed'
  `)
  const prWatchCursorStmt = scope.prepare("UPDATE pr_watch SET cursor = ? WHERE project_id = @project_id AND id = ? AND state = 'armed'")
  const delPrWatches = scope.prepare("DELETE FROM pr_watch WHERE project_id = @project_id AND thread_slug = ?")
  const armThreadWatchStmt = scope.prepare(`
    INSERT INTO thread_watch (project_id, id, thread_slug, kind, target, state, created_at, expires_at, settled_at)
    VALUES (@project_id, @id, @slug, @kind, @target, 'armed', @createdAtMs, @expiresAtMs, NULL)
  `)
  const armedThreadWatchStmt = scope.prepare<[string, string, string], ThreadWatchRow>(
    "SELECT * FROM thread_watch WHERE project_id = @project_id AND thread_slug = ? AND kind = ? AND target = ? AND state = 'armed'",
  )
  const threadWatchesBySlugStmt = scope.prepare<[string], ThreadWatchRow>(
    "SELECT * FROM thread_watch WHERE project_id = @project_id AND thread_slug = ? ORDER BY created_at, id",
  )
  const armedThreadWatchesBySlugStmt = scope.prepare<[string], ThreadWatchRow>(
    "SELECT * FROM thread_watch WHERE project_id = @project_id AND thread_slug = ? AND state = 'armed' ORDER BY created_at, id",
  )
  const threadWatchByIdStmt = scope.prepare<[string], ThreadWatchRow>("SELECT * FROM thread_watch WHERE project_id = @project_id AND id = ?")
  const armedThreadWatchesStmt = scope.prepare<[], ThreadWatchRow>(
    "SELECT * FROM thread_watch WHERE project_id = @project_id AND state = 'armed' ORDER BY created_at, id",
  )
  const expiredThreadWatchesStmt = scope.prepare<[number], ThreadWatchRow>(
    "SELECT * FROM thread_watch WHERE project_id = @project_id AND state = 'armed' AND expires_at <= ? ORDER BY expires_at, id",
  )
  const dropThreadWatchStmt = scope.prepare(`
    UPDATE thread_watch SET state = 'dropped', settled_at = ?
    WHERE project_id = @project_id AND id = ? AND thread_slug = ? AND state = 'armed'
  `)
  const settleThreadWatchStmt = scope.prepare(`
    UPDATE thread_watch SET state = ?, settled_at = ?
    WHERE project_id = @project_id AND id = ? AND state = 'armed'
  `)
  const delThreadWatches = scope.prepare("DELETE FROM thread_watch WHERE project_id = @project_id AND thread_slug = ?")
  const askThreadQuestionStmt = scope.prepare(`
    INSERT INTO thread_question (project_id, id, thread_slug, spec, state, answer, delivered, asked_at, settled_at)
    VALUES (@project_id, @id, @slug, @spec, 'open', NULL, 0, @askedAtMs, NULL)
  `)
  // TIEBREAK ON ROWID, NOT ID. Every question of one `ask` call shares its `asked_at` — the router stamps
  // one `now` for the batch — and `qst_…` is random, so ordering by id read a batch back SHUFFLED: the
  // worker's own first/second was lost, on the card stack and in the `activity` readout alike. rowid is
  // insertion order, which is the order the worker wrote them (2026-08-28).
  const threadQuestionsBySlugStmt = scope.prepare<[string], ThreadQuestionRow>(
    "SELECT * FROM thread_question WHERE project_id = @project_id AND thread_slug = ? ORDER BY asked_at, rowid",
  )
  const openThreadQuestionsBySlugStmt = scope.prepare<[string], ThreadQuestionRow>(
    "SELECT * FROM thread_question WHERE project_id = @project_id AND thread_slug = ? AND state = 'open' ORDER BY asked_at, rowid",
  )
  const threadQuestionByIdStmt = scope.prepare<[string], ThreadQuestionRow>("SELECT * FROM thread_question WHERE project_id = @project_id AND id = ?")
  const openThreadQuestionsStmt = scope.prepare<[], ThreadQuestionRow>(
    "SELECT * FROM thread_question WHERE project_id = @project_id AND state = 'open' ORDER BY asked_at, rowid",
  )
  // The board's batched read. UNFILTERED by state, unlike the statement directly above: the board takes
  // both halves off one list — the open questions the card asks, and the just-answered ones still on
  // their way to the worker — so this is the whole-project twin of `threadQuestionsBySlugStmt`, right
  // down to the rowid tiebreak that keeps one ask's questions in the order the worker wrote them.
  const allThreadQuestionsStmt = scope.prepare<[], ThreadQuestionRow>(
    "SELECT * FROM thread_question WHERE project_id = @project_id ORDER BY asked_at, rowid",
  )
  const answerThreadQuestionStmt = scope.prepare(`
    UPDATE thread_question SET state = 'answered', answer = ?, settled_at = ?
    WHERE project_id = @project_id AND id = ? AND state = 'open'
  `)
  // Settled but not yet told to the worker. ANSWERED and DISMISSED, never WITHDRAWN: a withdrawal is the
  // worker's own act, so telling it about one would be reading its own move back to it.
  //
  // ASKED order, not settled order — the same trap as the rowid tiebreak above, one statement over. The
  // delivery composes the Answers card the human reads back, and the question cards rendered in asked
  // order; answering a card stamps ONE `settled_at` for the whole batch (router.answerQuestions) and
  // `qst_…` is random, so `ORDER BY settled_at, id` read a batch back SHUFFLED against the questions —
  // and against the board's in-flight copy of the same card, which composes from the asked-ordered
  // listThreadQuestions (2026-09-02).
  const undeliveredSettlementsStmt = scope.prepare<[], ThreadQuestionRow>(
    "SELECT * FROM thread_question WHERE project_id = @project_id AND state IN ('answered', 'dismissed') AND delivered = 0 ORDER BY asked_at, rowid",
  )
  const markSettlementDeliveredStmt = scope.prepare(
    "UPDATE thread_question SET delivered = 1 WHERE project_id = @project_id AND id = ? AND delivered = 0",
  )
  const withdrawThreadQuestionStmt = scope.prepare(`
    UPDATE thread_question SET state = 'withdrawn', settled_at = ?
    WHERE project_id = @project_id AND id = ? AND thread_slug = ? AND state = 'open'
  `)
  const dismissThreadQuestionStmt = scope.prepare(`
    UPDATE thread_question SET state = 'dismissed', settled_at = ?
    WHERE project_id = @project_id AND id = ? AND state = 'open'
  `)
  const delThreadQuestions = scope.prepare("DELETE FROM thread_question WHERE project_id = @project_id AND thread_slug = ?")
  const delThreadDone = scope.prepare("DELETE FROM thread_done WHERE project_id = @project_id AND thread_slug = ?")
  const markThreadDoneStmt = scope.prepare(`
    INSERT INTO thread_done (project_id, thread_slug, body, done_at) VALUES (@project_id, ?, ?, ?)
    ON CONFLICT(project_id, thread_slug) DO UPDATE SET body = excluded.body, done_at = excluded.done_at
  `)
  const getThreadDoneStmt = scope.prepare("SELECT body, done_at FROM thread_done WHERE project_id = @project_id AND thread_slug = ?")
  // The board's batched read. No ORDER BY to match: the table's primary key is (project_id,
  // thread_slug), so a slug selects at most one row and there is nothing for an order to decide.
  const allThreadDoneStmt = scope.prepare<[], { thread_slug: string; body: string; done_at: number }>(
    "SELECT thread_slug, body, done_at FROM thread_done WHERE project_id = @project_id",
  )
  const clearThreadDoneStmt = scope.prepare("DELETE FROM thread_done WHERE project_id = @project_id AND thread_slug = ?")
  // Only a PROMPTLESS snooze expires here. One that carries a prompt still owes the thread a bump, and
  // the scheduler — not the board — clears it once that wake reaches a terminal state. Erasing it on
  // elapse (the board refreshes far more often than the waker ticks) would drop the follow-up entirely.
  const clearExpiredSnoozesStmt = scope.prepare(`
    UPDATE session SET snoozed_until = NULL
    WHERE project_id = @project_id AND snoozed_until IS NOT NULL AND snoozed_until <= ? AND snooze_prompt IS NULL
  `)
  // Both human-title writers LOCK as they write: the text, the "not a guess" flag, and the lock move in
  // one statement, so no concurrent tail tick can land a backend auto-title between them.
  const titleStmt = scope.prepare("UPDATE session SET title = ?, title_auto = 0, title_locked = 1, title_agent = 0 WHERE project_id = @project_id AND slug = ?")
  const titleCasStmt = scope.prepare(
    "UPDATE session SET title = ?, title_auto = 0, title_locked = 1, title_agent = 0 WHERE project_id = @project_id AND slug = ? AND session_id = ? AND title IS ? AND title_auto = ?",
  )
  // Gated on the LOCK, not on title_auto: a caller-supplied dispatch title (`Investigate acme/app#391`,
  // a parent agent's guess) is unlocked, so the worker's own title supersedes it. title_auto is left
  // alone — the row's DISPLAY provenance is unchanged by which machine produced the current text.
  // `title_agent` IS moved, because it describes the text this statement is writing: the worker's own
  // name. It is what lets the display trust a persisted codex title once the live telemetry is gone.
  const autoTitleCasStmt = scope.prepare(`
    UPDATE session SET title = ?, title_agent = 1
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND agent_session_id IS ?
      AND runtime_generation = ? AND title_locked = 0
  `)
  // The WORKER's own considered name for its thread, from `mcp__frizz__title`. Writes exactly what the
  // auto-title CAS writes — the text plus `title_agent = 1`, gated on the LOCK so a human rename always
  // outranks it — but keyed on the SLUG alone. The caller is the live worker's own MCP server, which
  // knows the slug frizz stamped into its env and nothing about the session id underneath it; that env
  // survives every resume, while the session id does not.
  const agentTitleStmt = scope.prepare(`
    UPDATE session SET title = ?, title_agent = 1
    WHERE project_id = @project_id AND slug = ? AND title_locked = 0
  `)
  const delSession = scope.prepare("DELETE FROM session WHERE project_id = @project_id AND slug = ?")
  const putRetiredOp = scope.prepare("INSERT OR IGNORE INTO retired_op (project_id, slug, session_id, op_id, retired_at) VALUES (@project_id, ?, ?, ?, ?)")
  const getRetiredOps = scope.prepare<[string, string], { op_id: string }>("SELECT op_id FROM retired_op WHERE project_id = @project_id AND slug = ? AND session_id = ?")
  const delRetiredOps = scope.prepare("DELETE FROM retired_op WHERE project_id = @project_id AND slug = ?")
  const delRetiredOp = scope.prepare("DELETE FROM retired_op WHERE project_id = @project_id AND slug = ? AND session_id = ? AND op_id = ?")
  const putTomb = scope.prepare("INSERT OR IGNORE INTO tombstone (project_id, transcript_id, slug, forgotten_at) VALUES (@project_id, ?, ?, ?)")
  const allTombs = scope.prepare<[], { transcript_id: string }>("SELECT transcript_id FROM tombstone WHERE project_id = @project_id")
  // Storage is constructed before the disabled app-server bridge, so this table may appear later in
  // the process. Resolve it lazily inside the same registry transaction. Detaching first makes a
  // matching native binding non-actionable even if the post-commit process cleanup is interrupted.
  const detachCodexBinding = (threadSlug: string, sessionId: string, at: string) => {
    const exists = db.prepare<[], { present: number }>(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'codex_app_server_session'
    `).get()
    if (!exists) return
    scope.prepare(`
      UPDATE codex_app_server_session
      SET state = 'detached', current_turn_id = NULL, updated_at = ?
      WHERE project_id = @project_id AND thread_slug = ? AND frizz_session_id = ?
    `).run(at, threadSlug, sessionId)
  }
  const forgetOwnedRow = (existing: SessionRow): SessionRow => {
    const at = new Date().toISOString()
    interactions.cancelForSession(existing.slug, existing.session_id, "session-deleted")
    detachCodexBinding(existing.slug, existing.session_id, at)
    putTomb.run(existing.session_id, existing.slug, at)
    if (existing.transcript_id) putTomb.run(existing.transcript_id, existing.slug, at)
    if (existing.agent_session_id) putTomb.run(existing.agent_session_id, existing.slug, at)
    const claim = selAdoptionClaim.get(existing.slug)
    if (claim?.state === "finalized" && claim.session_id === existing.session_id) {
      retireAdoptionAttempt(claim)
      delFinalizedAdoptionClaim.run(existing.slug, existing.session_id)
    }
    // Retirements are scoped to a session that no longer exists. Dropping them with the row keeps the
    // table from growing forever across re-dispatches of a busy slug; the (slug, session_id) key means
    // a replacement session could never have read them anyway.
    delRetiredOps.run(existing.slug)
    // Same reasoning for the thread's one-off timers: an alarm set for a thread that no longer exists
    // has nothing to wake, and the scheduler would otherwise carry the armed row for up to thirty days.
    delThreadTimers.run(existing.slug)
    // And its PR watchers, for the same reason: a watcher on a thread that no longer exists has nothing
    // to wake, and the scheduler polls every armed row.
    delPrWatches.run(existing.slug)
    delThreadWatches.run(existing.slug)
    delThreadQuestions.run(existing.slug)
    delThreadDone.run(existing.slug)
    delSession.run(existing.slug)
    return existing
  }

  // One transaction: drop the row and graveyard its transcript id(s), so a rescan mid-delete can never see
  // a half-forgotten state (row gone but transcript un-tombstoned, or vice-versa).
  const forget = db.transaction((slug: string): SessionRow | undefined => {
    const existing = selOne.get(slug)
    return existing ? forgetOwnedRow(existing) : undefined
  })

  const forgetIfCurrent = db.transaction(
    (slug: string, expected: ForgetSessionExpectation): SessionRow | undefined => {
      const existing = selOne.get(slug)
      if (
        !existing ||
        existing.session_id !== expected.sessionId ||
        (existing.runtime_generation ?? 0) !== expected.runtimeGeneration
      ) return undefined
      const claim = selAdoptionClaim.get(slug)
      if (expected.adoptionAttemptToken === null) {
        if (claim) return undefined
      } else if (
        !claim || claim.state !== "finalized" || claim.session_id !== expected.sessionId ||
        claim.attempt_token !== expected.adoptionAttemptToken
      ) {
        return undefined
      }
      return forgetOwnedRow(existing)
    },
  )
  const backendStmt = scope.prepare("UPDATE session SET backend = ? WHERE project_id = @project_id AND slug = ?")
  const agentSessionStmt = scope.prepare("UPDATE session SET agent_session_id = ? WHERE project_id = @project_id AND slug = ?")
  const codexRuntimeStmt = scope.prepare("UPDATE session SET codex_runtime = ? WHERE project_id = @project_id AND slug = ?")
  const claudeRuntimeStmt = scope.prepare("UPDATE session SET claude_runtime = ? WHERE project_id = @project_id AND slug = ?")
  // Stamps profile_set_at alongside model/effort: the OPERATOR's set-time. Both backends' setThreadProfile
  // paths write through here, and the stamp is what marks the pair as CHOSEN rather than observed — the
  // board reads it to keep the composer selector on the pick (resolveSessionProfile), and the observed
  // write-back reads it to stay off a row the operator has claimed (observedProfileIfCurrentStmt, which
  // carries the account of what happened when it did not). Sibling of permissionModeStmt.
  const profileStmt = scope.prepare("UPDATE session SET model = ?, effort = ?, profile_set_at = ? WHERE project_id = @project_id AND slug = ?")
  // Stamps permission_set_at alongside the mode: this is the OPERATOR's set-time, which the board uses
  // to outrank an older observed telemetry reading (see resolveSessionPermission). The tailer's
  // observed write-back uses observedPermissionIfCurrentStmt and deliberately does NOT touch it.
  const permissionModeStmt = scope.prepare("UPDATE session SET permission_mode = ?, permission_set_at = ? WHERE project_id = @project_id AND slug = ?")
  const permissionPendingStmt = scope.prepare("UPDATE session SET permission_pending = ? WHERE project_id = @project_id AND slug = ?")
  const beginRuntimeControlStmt = scope.prepare(`
    UPDATE session
    SET runtime_control = ?, runtime_control_revision = runtime_control_revision + 1
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND runtime_control IS NULL AND permission_pending IS NULL
      AND profile_pending_model IS NULL AND profile_pending_effort IS NULL
  `)
  const releaseRuntimeControlStmt = scope.prepare(`
    UPDATE session SET runtime_control = NULL
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ?
      AND runtime_control = ? AND runtime_control_revision = ?
  `)
  const profileTargetIfCurrentStmt = scope.prepare(`
    UPDATE session
    SET model = ?, effort = ?, profile_revision = profile_revision + 1, control_error = NULL
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND runtime_control IS NULL AND permission_pending IS NULL
      AND profile_pending_model IS NULL AND profile_pending_effort IS NULL
  `)
  const armProfileChangeStmt = scope.prepare(`
    UPDATE session
    SET profile_pending_model = ?, profile_pending_effort = ?,
        profile_revision = profile_revision + 1,
        profile_handoff = ?,
        runtime_control = 'profile', runtime_control_revision = runtime_control_revision + 1,
        control_error = NULL
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND runtime_control IS NULL AND permission_pending IS NULL
      AND profile_pending_model IS NULL AND profile_pending_effort IS NULL
  `)
  const checkpointProfileChangeStmt = scope.prepare(`
    UPDATE session SET profile_handoff = ?, control_error = NULL
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const commitProfileChangeStmt = scope.prepare(`
    UPDATE session
    SET model = ?, effort = ?, profile_pending_model = NULL, profile_pending_effort = NULL,
        profile_handoff = NULL, runtime_control = NULL, control_error = NULL
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const restoreProfileChangeStmt = scope.prepare(`
    UPDATE session
    SET model = ?, effort = ?, profile_pending_model = NULL, profile_pending_effort = NULL,
        profile_handoff = NULL, runtime_control = NULL, control_error = ?
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const blockProfileChangeStmt = scope.prepare(`
    UPDATE session SET control_error = ?
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const failProfileChangeStmt = scope.prepare(`
    UPDATE session
    SET profile_pending_model = NULL, profile_pending_effort = NULL,
        profile_handoff = NULL, runtime_control = NULL, control_error = ?
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  // ON A CLAUDE ROW THE WRITE-BACK ONLY EVER FILLS IN A PROFILE NOBODY CHOSE — it must never overwrite
  // one the operator did choose, which is what the `profile_set_at IS NULL OR backend = 'codex'` clause
  // fences. (`backend = 'codex'` is false for a NULL backend, so a migrated row is treated as claude —
  // the same `row.backend ?? "claude"` convention every other reader uses.)
  //
  // THE ASYMMETRY IS THE WHOLE POINT, and it is about WHEN each backend can honour a pick. Codex takes
  // model/effort per turn, so the very next turn runs on the new pair and the turn_context it writes is
  // a true reading of the operator's choice having landed — observed authority is meaningful there, and
  // the convergence it buys is deliberate (see resolveSessionProfile's tests). Claude fixes them at FORK
  // time: the SDK takes them at query start, so setThreadProfile persists the intent and a live daemon
  // goes on running what it was forked with (router.ts, and the bridge's `held ?? attach`). Every record
  // that daemon writes carries the OLD model and is therefore a reading of a session that STRUCTURALLY
  // cannot have honoured the pick — converging on it overwrites an instruction with a stale fact.
  //
  // Which is what it did, silently, until 2026-09-03: `opus` set on a live thread at 22:36:28 was back
  // to `fable` before 22:40 (`profile_revision` 0 → 1), and the composer's selector reads the same row,
  // so the pick simply vanished with nothing said. The identical write to the same thread once it had
  // stopped emitting held indefinitely — which is the tell that the guard cannot be a timestamp test.
  // "Skip while the pick is newer than the observation" lapses on the very next record a mid-turn thread
  // writes, and the clobber lands anyway.
  //
  // COST, stated because it is real: on a claude row whose profile was set by hand, a model change frizz
  // never made and cannot see — a worker's own `/model`, a provider substituting silently — is no longer
  // learned back. The scheduler's model-scoped fallback is unaffected: it goes through setProfile
  // (evalLimits), which re-stamps the target rather than needing to be observed.
  const observedProfileIfCurrentStmt = scope.prepare(`
    UPDATE session
    SET model = ?, effort = ?, profile_revision = profile_revision + 1
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ?
      AND runtime_control IS NULL AND profile_pending_model IS NULL AND profile_pending_effort IS NULL
      AND (profile_set_at IS NULL OR backend = 'codex')
      AND (model IS NOT ? OR effort IS NOT ?)
  `)
  const beginRuntimeGenerationStmt = scope.prepare(`
    UPDATE session
    SET runtime_generation = runtime_generation + 1, spawned_at = ?, exited = 0
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ? AND permission_pending IS ?
      AND runtime_control IS ?
  `)
  const permissionStateIfCurrentStmt = scope.prepare(`
    UPDATE session
    SET exited = ?, permission_mode = ?, permission_pending = ?, control_error = ?,
        runtime_control = CASE
          WHEN ? IS NULL AND runtime_control = 'permission' THEN NULL
          ELSE runtime_control
        END
    WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ? AND permission_pending IS ?
      AND runtime_control IS ?
  `)
  const observedPermissionIfCurrentStmt = scope.prepare(
    "UPDATE session SET permission_mode = ? WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ? AND permission_mode IS NOT ?",
  )
  const controlErrorIfCurrentStmt = scope.prepare(
    "UPDATE session SET control_error = ? WHERE project_id = @project_id AND slug = ? AND session_id = ? AND runtime_generation = ?",
  )
  const controlErrorStmt = scope.prepare("UPDATE session SET control_error = ? WHERE project_id = @project_id AND slug = ?")
  const deliveryLedgerStmt = scope.prepare("UPDATE session SET delivery_ledger = ? WHERE project_id = @project_id AND slug = ?")
  const getSet = scope.prepare<[string], { value: string }>("SELECT value FROM settings WHERE project_id = @project_id AND key = ?")
  const putSet = scope.prepare(
    "INSERT INTO settings (project_id, key, value) VALUES (@project_id, ?, ?) ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value",
  )
  const delSet = scope.prepare("DELETE FROM settings WHERE project_id = @project_id AND key = ?")

  const normalizeSessionRow = (row: SessionRow) => ({
    ...row,
    title_locked: sessionTitleLocked(row) ? 1 : 0,
    backend: row.backend ?? "claude",
    agent_session_id: row.agent_session_id ?? null,
    model: row.model ?? null,
    effort: row.effort ?? null,
    profile_pending_model: row.profile_pending_model ?? null,
    profile_pending_effort: row.profile_pending_effort ?? null,
    profile_set_at: row.profile_set_at ?? null,
    profile_revision: row.profile_revision ?? 0,
    profile_handoff: row.profile_handoff ?? null,
    permission_mode: row.permission_mode ?? null,
    permission_pending: row.permission_pending ?? null,
    permission_set_at: row.permission_set_at ?? null,
    snoozed_until: row.snoozed_until ?? null,
    snooze_prompt: row.snooze_prompt ?? null,
    control_error: row.control_error ?? null,
    delivery_ledger: row.delivery_ledger ?? null,
    runtime_generation: row.runtime_generation ?? 0,
    runtime_control: row.runtime_control ?? null,
    runtime_control_revision: row.runtime_control_revision ?? 0,
    codex_runtime: row.codex_runtime ?? null,
    claude_runtime: row.claude_runtime ?? null,
  })

  const getAdoptionRuntimeSnapshot = db.transaction((slug: string) => ({
    // Claim first is intentional: a finalized claim disappearing before the current-row validation
    // must never make a stale adopted row look like an unbound legacy runtime.
    claim: selAdoptionClaim.get(slug),
    session: selOne.get(slug),
  }))

  const validateSessionIdentity = (row: SessionRow) => {
    const slug = ThreadSlug.parse(row.slug)
    if (row.thread_name !== threadIdentityName(slug)) throw new Error("invalid session thread identity")
  }

  const validateAdoptionReservation = (reservation: AdoptionReservation) => {
    ThreadSlug.parse(reservation.slug)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservation.attemptToken)) {
      throw new Error("invalid adoption attempt token")
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(reservation.sessionId)) {
      throw new Error("invalid adoption session id")
    }
    if (
      !Number.isSafeInteger(reservation.reservedAtMs) ||
      !Number.isSafeInteger(reservation.leaseExpiresAtMs) ||
      reservation.leaseExpiresAtMs <= reservation.reservedAtMs
    ) {
      throw new Error("invalid adoption lease")
    }
  }

  const validateAdoptionPane = (identity: AdoptionPaneIdentity) => {
    if (
      !/^%\d+$/.test(identity.paneId) ||
      !Number.isSafeInteger(identity.panePid) ||
      identity.panePid <= 0 ||
      !Number.isSafeInteger(identity.sessionCreated) ||
      identity.sessionCreated <= 0
    ) {
      throw new Error("invalid adoption pane identity")
    }
  }

  const retireAdoptionAttempt = (claim: AdoptionClaimRow, retiredAtMs = Date.now()): void => {
    putRetiredAdoptionAttempt.run(claim.attempt_token, claim.slug, claim.session_id, retiredAtMs)
  }

  const withAdoptionSpawnFence = <T>(
    slug: string,
    attemptToken: string,
    leaseExpiresAtMs: number,
    spawn: (bindPane: (identity: AdoptionPaneIdentity, leaseExpiresAtMs: number) => boolean) => T,
  ): AdoptionSpawnFenceResult<T> => {
    ThreadSlug.parse(slug)
    if (!Number.isSafeInteger(leaseExpiresAtMs)) return { acquired: false }
    db.exec("BEGIN IMMEDIATE")
    let bound = false
    try {
      const claim = selAdoptionClaim.get(slug)
      if (
        !claim ||
        claim.attempt_token !== attemptToken ||
        (claim.state !== "reserved" && claim.state !== "spawned") ||
        claim.recovery_token !== null ||
        selRetiredAdoptionAttempt.get(attemptToken)
      ) {
        db.exec("ROLLBACK")
        return { acquired: false }
      }
      if (renewAdoptionSpawnFenceStmt.run(leaseExpiresAtMs, slug, attemptToken).changes !== 1) {
        db.exec("ROLLBACK")
        return { acquired: false }
      }
      // Hold BEGIN IMMEDIATE only through the spawn itself. The spawn calls bindPane the moment the
      // runtime exists, which commits the exact tuple and releases the recovery fence BEFORE the rest
      // of that runtime's setup continues. Thus a pre-bind SIGKILL rolls back to the durable
      // token-only reservation, while every later setup crash retains the exact tuple instead of
      // rolling it back with the spawn fence. (The multiplexer-era shape: a broker-backed adoption
      // binds no tuple at all — see finalizeAdoptionClaimTxn below.)
      const bindPane = (identity: AdoptionPaneIdentity, nextLeaseExpiresAtMs: number): boolean => {
        if (bound || !db.inTransaction) return false
        validateAdoptionPane(identity)
        if (!Number.isSafeInteger(nextLeaseExpiresAtMs)) return false
        const changed = recordAdoptionPaneStmt.run({
          slug,
          attempt_token: attemptToken,
          pane_id: identity.paneId,
          pane_pid: identity.panePid,
          session_created: identity.sessionCreated,
          lease_expires_at_ms: nextLeaseExpiresAtMs,
        }).changes === 1
        if (!changed) return false
        db.exec("COMMIT")
        bound = true
        return true
      }
      const value = spawn(bindPane)
      if (!bound) {
        if (db.inTransaction) db.exec("ROLLBACK")
        throw new Error("adoption spawn returned without binding its exact pane")
      }
      return { acquired: true, value }
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK")
      throw error
    }
  }


  const finalizeAdoptionClaimTxn = db.transaction(
    (slug: string, attemptToken: string, row: SessionRow, finalizedAtMs: number): boolean => {
      const claim = selAdoptionClaim.get(slug)
      if (
        !claim ||
        claim.attempt_token !== attemptToken ||
        claim.session_id !== row.session_id ||
        // A broker-backed adoption never binds a pane, so the old 'spawned'+pane-columns gate is gone:
        // the reservation IS the claim and the broker session is the identity.
        (claim.state !== "reserved" && claim.state !== "spawned")
      ) {
        return false
      }
      if (insertSessionIfAbsentStmt.run(normalizeSessionRow(row)).changes !== 1) return false
      if (finalizeAdoptionClaimStmt.run(finalizedAtMs, slug, attemptToken, row.session_id).changes !== 1) {
        throw new Error("adoption claim changed during finalization")
      }
      return true
    },
  )

  const rearmFinalizedAdoptionClaimTxn = db.transaction(
    (reservation: AdoptionReservation, previousAttemptToken: string): boolean => {
      const claim = selAdoptionClaim.get(reservation.slug)
      if (
        !claim ||
        claim.state !== "finalized" ||
        claim.session_id !== reservation.sessionId ||
        claim.attempt_token !== previousAttemptToken ||
        Boolean(selRetiredAdoptionAttempt.get(reservation.attemptToken))
      ) return false
      retireAdoptionAttempt(claim, reservation.reservedAtMs)
      return rearmFinalizedAdoptionClaimStmt.run({
        slug: reservation.slug,
        session_id: reservation.sessionId,
        attempt_token: reservation.attemptToken,
        previous_attempt_token: previousAttemptToken,
        reserved_at_ms: reservation.reservedAtMs,
        lease_expires_at_ms: reservation.leaseExpiresAtMs,
      }).changes === 1
    },
  )

  const abandonAdoptionClaimTxn = db.transaction((slug: string, attemptToken: string): boolean => {
    const claim = selAdoptionClaim.get(slug)
    if (!claim || claim.attempt_token !== attemptToken || (claim.state !== "reserved" && claim.state !== "spawned")) {
      return false
    }
    retireAdoptionAttempt(claim)
    if (restoreAdoptionNoPaneStmt.run(slug, attemptToken).changes === 1) return true
    return deleteAbandonedAdoptionClaimStmt.run(slug, attemptToken).changes === 1
  })

  const finishAdoptionRecoveryTxn = db.transaction(
    (slug: string, attemptToken: string, recoveryToken: string): boolean => {
      const claim = selAdoptionClaim.get(slug)
      if (
        !claim ||
        claim.attempt_token !== attemptToken ||
        claim.state !== "recovering" ||
        claim.recovery_token !== recoveryToken
      ) return false
      retireAdoptionAttempt(claim)
      if (restoreRecoveredAdoptionNoPaneStmt.run(slug, attemptToken, recoveryToken).changes === 1) return true
      return deleteRecoveredAdoptionClaimStmt.run(slug, attemptToken, recoveryToken).changes === 1
    },
  )

  const retireFinalizedAdoptionClaimTxn = db.transaction(
    (slug: string, sessionId: string, attemptToken: string): boolean => {
      const claim = selAdoptionClaim.get(slug)
      if (
        !claim || claim.state !== "finalized" || claim.session_id !== sessionId ||
        claim.attempt_token !== attemptToken
      ) return false
      retireAdoptionAttempt(claim)
      return retireFinalizedAdoptionClaimStmt.run(slug, sessionId, attemptToken).changes === 1
    },
  )

  const beginAdoptionRecoveryTxn = db.transaction(
    (
      slug: string,
      attemptToken: string,
      recoveryToken: string,
      nowMs: number,
      leaseExpiresAtMs: number,
    ): AdoptionClaimRow | undefined => {
      const changed = beginAdoptionRecoveryStmt.run(
        recoveryToken,
        leaseExpiresAtMs,
        slug,
        attemptToken,
        nowMs,
      ).changes === 1
      return changed ? selAdoptionClaim.get(slug) : undefined
    },
  )

  const upsertSessionTxn = db.transaction((row: SessionRow): SessionLifecycleEvent | undefined => {
    const existing = selOne.get(row.slug)
    upsertStmt.run(normalizeSessionRow(row))
    if (existing && existing.session_id !== row.session_id) {
      interactions.cancelForSession(existing.slug, existing.session_id, "session-replaced")
      detachCodexBinding(existing.slug, existing.session_id, new Date().toISOString())
      const replacedClaim = selAdoptionClaim.get(existing.slug)
      if (replacedClaim?.state === "finalized" && replacedClaim.session_id === existing.session_id) {
        retireAdoptionAttempt(replacedClaim)
      }
      delFinalizedAdoptionClaim.run(existing.slug, existing.session_id)
      return { type: "replaced", previous: existing, current: selOne.get(row.slug)! }
    }
    return undefined
  })

  const upsertSession = (row: SessionRow) => {
    validateSessionIdentity(row)
    const event = upsertSessionTxn(row)
    if (event) emitSessionLifecycle(event)
  }

  const forgetSession = (slug: string) => {
    const previous = forget(slug)
    if (previous) emitSessionLifecycle({ type: "deleted", previous })
    return previous
  }

  return {
    db,
    scope,
    projectId,
    interactions,
    // Databases created before the canonical guard may contain an overlong or otherwise unsafe id.
    // Keep those legacy/corrupt rows inert so boot reconciliation and pollers never feed them to
    // spawn, filesystem, transcript, or event boundaries.
    getSession,
    allSessions,
    subscribeSessionLifecycle(listener) {
      lifecycleListeners.add(listener)
      return () => lifecycleListeners.delete(listener)
    },
    retireOp: (slug, sessionId, opId) => void putRetiredOp.run(slug, sessionId, opId, new Date().toISOString()),
    retiredOps: (slug, sessionId) => new Set(getRetiredOps.all(slug, sessionId).map((r) => r.op_id)),
    unretireOp: (slug, sessionId, opId) => void delRetiredOp.run(slug, sessionId, opId),
    // Profile fields are optional in SessionRow so pre-migration fixtures/callers still typecheck;
    // normalize them for better-sqlite3, whose named statement requires every referenced parameter.
    upsertSession: (row) => void upsertSession(row),
    insertSessionIfAbsent: (row) => {
      validateSessionIdentity(row)
      return insertSessionIfAbsentStmt.run(normalizeSessionRow(row)).changes === 1
    },
    getAdoptionClaim: (slug) => ThreadSlug.safeParse(slug).success ? selAdoptionClaim.get(slug) : undefined,
    getAdoptionRuntimeSnapshot: (slug) => ThreadSlug.safeParse(slug).success
      ? getAdoptionRuntimeSnapshot.deferred(slug)
      : { session: undefined, claim: undefined },
    allAdoptionClaims: () => selAllAdoptionClaims.all().filter((claim) => ThreadSlug.safeParse(claim.slug).success),
    allRetiredAdoptionAttempts: () => selAllRetiredAdoptionAttempts.all()
      .filter((attempt) => ThreadSlug.safeParse(attempt.slug).success),
    reserveAdoptionClaim: (reservation) => {
      validateAdoptionReservation(reservation)
      return reserveAdoptionClaimStmt.run({
        slug: reservation.slug,
        attempt_token: reservation.attemptToken,
        session_id: reservation.sessionId,
        reserved_at_ms: reservation.reservedAtMs,
        lease_expires_at_ms: reservation.leaseExpiresAtMs,
      }).changes === 1
    },
    recordAdoptionPane: (slug, attemptToken, identity, leaseExpiresAtMs) => {
      ThreadSlug.parse(slug)
      validateAdoptionPane(identity)
      if (!Number.isSafeInteger(leaseExpiresAtMs)) throw new Error("invalid adoption lease")
      return recordAdoptionPaneStmt.run({
        slug,
        attempt_token: attemptToken,
        pane_id: identity.paneId,
        pane_pid: identity.panePid,
        session_created: identity.sessionCreated,
        lease_expires_at_ms: leaseExpiresAtMs,
      }).changes === 1
    },
    withAdoptionSpawnFence,
    finalizeAdoptionClaim: (slug, attemptToken, row, finalizedAtMs) => {
      ThreadSlug.parse(slug)
      validateSessionIdentity(row)
      if (row.slug !== slug || !Number.isSafeInteger(finalizedAtMs)) return false
      return finalizeAdoptionClaimTxn(slug, attemptToken, row, finalizedAtMs)
    },
    rearmFinalizedAdoptionClaim: (reservation, previousAttemptToken) => {
      validateAdoptionReservation(reservation)
      return rearmFinalizedAdoptionClaimTxn(reservation, previousAttemptToken)
    },
    finalizeAdoptionRespawnClaim: (slug, attemptToken, sessionId, finalizedAtMs) =>
      ThreadSlug.safeParse(slug).success &&
      Number.isSafeInteger(finalizedAtMs) &&
      finalizeAdoptionRespawnClaimStmt.run(finalizedAtMs, slug, attemptToken, sessionId).changes === 1,
    abandonAdoptionClaim: (slug, attemptToken) =>
      ThreadSlug.safeParse(slug).success && abandonAdoptionClaimTxn(slug, attemptToken),
    beginAdoptionRecovery: (slug, attemptToken, recoveryToken, nowMs, leaseExpiresAtMs) => {
      if (
        !ThreadSlug.safeParse(slug).success ||
        !/^[0-9a-f-]{36}$/i.test(recoveryToken) ||
        !Number.isSafeInteger(nowMs) ||
        !Number.isSafeInteger(leaseExpiresAtMs) ||
        leaseExpiresAtMs <= nowMs
      ) {
        return undefined
      }
      return beginAdoptionRecoveryTxn(slug, attemptToken, recoveryToken, nowMs, leaseExpiresAtMs)
    },
    finishAdoptionRecovery: (slug, attemptToken, recoveryToken) =>
      ThreadSlug.safeParse(slug).success &&
      finishAdoptionRecoveryTxn(slug, attemptToken, recoveryToken),
    retireFinalizedAdoptionClaim: (slug, sessionId, attemptToken) =>
      ThreadSlug.safeParse(slug).success &&
      retireFinalizedAdoptionClaimTxn(slug, sessionId, attemptToken),
    markRead: (slug, at = new Date().toISOString()) => void readStmt.run(at, slug),
    setUnread: (slug, unread) => void unreadStmt.run(unread ? 1 : 0, slug),
    setUnreadIfCurrent: (slug, sessionId, generation, unread) =>
      unreadIfCurrentStmt.run(unread ? 1 : 0, slug, sessionId, generation).changes === 1,
    setExited: (slug, exited) => void exitedStmt.run(exited ? 1 : 0, slug),
    setExitedIfCurrent: (slug, sessionId, generation, exited) =>
      exitedIfCurrentStmt.run(exited ? 1 : 0, slug, sessionId, generation).changes === 1,
    completeIfCurrent: (slug, sessionId, generation) =>
      completeIfCurrentStmt.run(slug, sessionId, generation).changes === 1,
    // Four flags: archived, then the unread / snoozed_until / snooze_prompt CASE guards, in
    // statement order.
    setRestedAt: (slug, at) => void restedStmt.run(at, slug),
    setRestedAtIfCurrent: (slug, sessionId, generation, at) =>
      restedIfCurrentStmt.run(at, slug, sessionId, generation).changes === 1,
    setSeenAt: (slug, at) => void seenStmt.run(at, slug),
    setTranscriptId: (slug, transcriptId) => void transcriptIdStmt.run(transcriptId, slug),
    setTranscriptIdIfCurrent: (slug, sessionId, generation, transcriptId) =>
      transcriptIdIfCurrentStmt.run(transcriptId, slug, sessionId, generation).changes === 1,
    setState: (slug, state) =>
      void stateStmt.run(
        state,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        slug,
      ),
    setStateIfCurrent: (slug, sessionId, generation, state) =>
      stateIfCurrentStmt.run(
        state,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        slug,
        sessionId,
        generation,
      ).changes === 1,
    // The instant and its follow-up are ONE fact: clearing the snooze (wake-now, archive, and a human
    // follow-up — see resume.wakeParkedThreadForFollowUp) always disarms the prompt, and a prompt can
    // never be written without a deadline to fire it.
    setSnoozedUntil: (slug, until, prompt = null) =>
      void snoozedUntilStmt.run(until, until === null ? null : prompt, slug),
    setSnoozedUntilIfCurrent: (slug, sessionId, generation, until) =>
      snoozedUntilIfCurrentStmt.run(until, slug, sessionId, generation).changes === 1,
    setPinnedAt: (slug, at) => void pinnedAtStmt.run(at, slug),
    setBgSnoozeRestedAtIfCurrent: (slug, sessionId, generation, restedAt) =>
      bgSnoozeRestedAtIfCurrentStmt.run(restedAt, slug, sessionId, generation).changes === 1,
    setRecurringPromptIfCurrent: (slug, sessionId, generation, write) =>
      recurringStmt.run(...recurringArgs(write), slug, sessionId, generation).changes === 1,
    setRecurringPromptBySlug: (slug, write) =>
      recurringBySlugStmt.run(...recurringArgs(write), slug).changes === 1,
    countSignoffNudge: (slug, anchor) => void countNudgeStmt.run(anchor, slug, anchor),
    resetSignoffNudges: (slug) => void resetNudgesStmt.run(slug),
    countParkBump: (slug, anchor) => void countParkBumpStmt.run(anchor, slug),
    resetParkBumps: (slug) => void resetParkBumpsStmt.run(slug),
    armPrWatch: (watch) => void armPrWatchStmt.run(watch),
    listPrWatches: (slug, opts) =>
      (opts?.armedOnly ? armedPrWatchesBySlugStmt : prWatchesBySlugStmt).all(slug),
    // Grouped off `armedPrWatchesStmt` — the scheduler's own whole-project read, which already carries
    // the identical `state = 'armed'` predicate and `created_at, id` order the per-slug statement uses.
    armedPrWatchesBySlug: () => groupBySlug(armedPrWatchesStmt.all()),
    getPrWatch: (id) => prWatchByIdStmt.get(id),
    armedPrWatches: () => armedPrWatchesStmt.all(),
    expiredPrWatches: (nowMs) => expiredPrWatchesStmt.all(nowMs),
    dropPrWatch: (slug, id, settledAtMs) => dropPrWatchStmt.run(settledAtMs, id, slug).changes === 1,
    settlePrWatch: (id, settledAtMs) => settlePrWatchStmt.run(settledAtMs, id).changes === 1,
    setPrWatchCursor: (id, cursor) => prWatchCursorStmt.run(cursor, id).changes === 1,
    // IDEMPOTENT BY (thread, kind, target), which is what the partial unique index enforces. A worker
    // woken by an expiry re-registers the same wait, and a worker that simply calls twice must not end
    // up with two rows to drop — so an existing armed row is RETURNED rather than replaced. Replacing
    // would silently move an expiry the human may already be reading on the card.
    armThreadWatch: (w) => {
      const existing = armedThreadWatchStmt.get(w.slug, w.kind, w.target)
      if (existing) return existing
      armThreadWatchStmt.run(w)
      return threadWatchByIdStmt.get(w.id)!
    },
    listThreadWatches: (slug, opts) =>
      (opts?.armedOnly ? armedThreadWatchesBySlugStmt : threadWatchesBySlugStmt).all(slug),
    // Grouped off `armedThreadWatchesStmt`, for the same reason as the PR watchers above: it is already
    // the identical predicate and order, asked of the whole project instead of one slug.
    armedThreadWatchesBySlug: () => groupBySlug(armedThreadWatchesStmt.all()),
    getThreadWatch: (id) => threadWatchByIdStmt.get(id),
    expiredThreadWatches: (nowMs) => expiredThreadWatchesStmt.all(nowMs),
    armedThreadWatches: () => armedThreadWatchesStmt.all(),
    askThreadQuestion: (q) => {
      askThreadQuestionStmt.run(q)
      return threadQuestionByIdStmt.get(q.id)!
    },
    listThreadQuestions: (slug, opts) =>
      (opts?.openOnly ? openThreadQuestionsBySlugStmt : threadQuestionsBySlugStmt).all(slug),
    threadQuestionsBySlug: () => groupBySlug(allThreadQuestionsStmt.all()),
    getThreadQuestion: (id) => threadQuestionByIdStmt.get(id),
    openThreadQuestions: () => openThreadQuestionsStmt.all(),
    answerThreadQuestion: (id, answer, atMs) => answerThreadQuestionStmt.run(answer, atMs, id).changes === 1,
    undeliveredSettlements: () => undeliveredSettlementsStmt.all(),
    markSettlementDelivered: (id) => markSettlementDeliveredStmt.run(id).changes === 1,
    withdrawThreadQuestion: (slug, id, atMs) => withdrawThreadQuestionStmt.run(atMs, id, slug).changes === 1,
    dismissThreadQuestion: (id, atMs) => dismissThreadQuestionStmt.run(atMs, id).changes === 1,
    markThreadDone: (slug, body, atMs) => { markThreadDoneStmt.run(slug, body, atMs) },
    getThreadDone: (slug) => {
      const row = getThreadDoneStmt.get(slug) as { body: string; done_at: number } | undefined
      return row ? { body: row.body, doneAt: row.done_at } : undefined
    },
    // The same ms→`doneAt` mapping as `getThreadDone`, applied once per row instead of once per call,
    // so the board reads the identical shape out of the map that it read out of the single-row call.
    threadDoneBySlug: () => {
      const bySlug = new Map<string, { body: string; doneAt: number }>()
      for (const row of allThreadDoneStmt.all()) bySlug.set(row.thread_slug, { body: row.body, doneAt: row.done_at })
      return bySlug
    },
    clearThreadDone: (slug) => clearThreadDoneStmt.run(slug).changes > 0,
    dropThreadWatch: (slug, id, settledAtMs) => dropThreadWatchStmt.run(settledAtMs, id, slug).changes === 1,
    settleThreadWatch: (id, settledAtMs, state = "settled") => settleThreadWatchStmt.run(state, settledAtMs, id).changes === 1,
    armThreadTimer: (timer) => void armTimerStmt.run(timer),
    listThreadTimers: (slug, opts) =>
      (opts?.armedOnly ? armedTimersBySlugStmt : timersBySlugStmt).all(slug),
    armedThreadTimersBySlug: () => groupBySlug(armedTimersStmt.all()),
    getThreadTimer: (id) => timerByIdStmt.get(id),
    dueThreadTimers: (nowMs) => dueTimersStmt.all(nowMs),
    cancelThreadTimer: (slug, id, settledAtMs) =>
      cancelTimerStmt.run(settledAtMs, id, slug).changes === 1,
    markThreadTimerFired: (id, settledAtMs) => fireTimerStmt.run(settledAtMs, id).changes === 1,
    stampRecurringRestFired: (slug, armedAt, firedAt) =>
      recurringRestFiredStmt.run(firedAt, slug, armedAt).changes === 1,
    stampRecurringScheduleFired: (slug, armedAt, firedAt) =>
      recurringScheduleFiredStmt.run(firedAt, slug, armedAt).changes === 1,
    stampRecurringCompactFired: (slug, armedAt, firedAt) =>
      recurringCompactFiredStmt.run(firedAt, slug, armedAt).changes === 1,
    clearExpiredSnoozes: (now) => clearExpiredSnoozesStmt.run(now).changes,
    setTitle: (slug, title) => void titleStmt.run(title, slug),
    setAgentTitle: (slug, title) => agentTitleStmt.run(title, slug).changes === 1,
    setTitleIfCurrent: (slug, title, expected) =>
      titleCasStmt.run(title, slug, expected.sessionId, expected.title, expected.titleAuto).changes === 1,
    setAutoTitleIfCurrent: (slug, title, expected) =>
      autoTitleCasStmt.run(
        title,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.runtimeGeneration,
      ).changes === 1,
    forgetSession,
    forgetSessionIfCurrent: (slug, expected) => {
      if (!ThreadSlug.safeParse(slug).success || !Number.isSafeInteger(expected.runtimeGeneration)) return undefined
      const previous = forgetIfCurrent(slug, expected)
      if (previous) emitSessionLifecycle({ type: "deleted", previous })
      return previous
    },
    forgottenIds: () => new Set(allTombs.all().map((r) => r.transcript_id)),
    setBackend: (slug, backend) => void backendStmt.run(backend, slug),
    setAgentSession: (slug, agentSessionId) => void agentSessionStmt.run(agentSessionId, slug),
    setCodexRuntime: (slug, runtime) => void codexRuntimeStmt.run(runtime, slug),
    setClaudeRuntime: (slug, runtime) => void claudeRuntimeStmt.run(runtime, slug),
    setProfile: (slug, model, effort) => void profileStmt.run(model, effort, new Date().toISOString(), slug),
    setPermissionMode: (slug, permissionMode) => void permissionModeStmt.run(permissionMode, new Date().toISOString(), slug),
    setPermissionPending: (slug, permissionMode) => void permissionPendingStmt.run(permissionMode, slug),
    beginRuntimeControl: (slug, expected, kind) => {
      const changed = beginRuntimeControlStmt.run(
        kind,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
      ).changes === 1
      if (!changed) return null
      const current = selOne.get(slug)
      return current?.runtime_control === kind ? current.runtime_control_revision ?? null : null
    },
    releaseRuntimeControl: (slug, expected) =>
      releaseRuntimeControlStmt.run(
        slug,
        expected.sessionId,
        expected.generation,
        expected.kind,
        expected.revision,
      ).changes === 1,
    setProfileTargetIfCurrent: (slug, expected, profile) =>
      profileTargetIfCurrentStmt.run(
        profile.model,
        profile.effort,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
      ).changes === 1,
    armProfileChange: (slug, expected, profile, handoff) => {
      const serialized = JSON.stringify(handoff)
      const changed = armProfileChangeStmt.run(
        profile.model,
        profile.effort,
        serialized,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
      ).changes === 1
      if (!changed) return null
      const current = selOne.get(slug)
      if (!current || current.runtime_control !== "profile") return null
      return {
        profileRevision: current.profile_revision ?? 0,
        controlRevision: current.runtime_control_revision ?? 0,
        profileHandoff: serialized,
      }
    },
    checkpointProfileChange: (slug, expected, handoff) => {
      const serialized = JSON.stringify(handoff)
      const changed = checkpointProfileChangeStmt.run(
        serialized,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1
      return changed ? serialized : null
    },
    commitProfileChange: (slug, expected) =>
      commitProfileChangeStmt.run(
        expected.model,
        expected.effort,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1,
    restoreProfileChange: (slug, expected, previous, error) =>
      restoreProfileChangeStmt.run(
        previous.model,
        previous.effort,
        error,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1,
    blockProfileChange: (slug, expected, error) =>
      blockProfileChangeStmt.run(
        error,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1,
    failProfileChange: (slug, expected, error) =>
      failProfileChangeStmt.run(
        error,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1,
    setObservedProfileIfCurrent: (slug, expected, profile) =>
      observedProfileIfCurrentStmt.run(
        profile.model,
        profile.effort,
        slug,
        expected.sessionId,
        expected.generation,
        profile.model,
        profile.effort,
      ).changes === 1,
    beginRuntimeGeneration: (slug, expected, spawnedAt) => {
      const changed = beginRuntimeGenerationStmt.run(
        spawnedAt,
        slug,
        expected.sessionId,
        expected.generation,
        expected.permissionPending,
        expected.runtimeControl ?? null,
      ).changes === 1
      return changed ? expected.generation + 1 : null
    },
    setPermissionStateIfCurrent: (slug, expected, state) =>
      permissionStateIfCurrentStmt.run(
        state.exited ? 1 : 0,
        state.permissionMode,
        state.permissionPending,
        state.controlError,
        state.permissionPending,
        slug,
        expected.sessionId,
        expected.generation,
        expected.permissionPending,
        expected.runtimeControl ?? null,
      ).changes === 1,
    setObservedPermissionIfCurrent: (slug, sessionId, generation, permissionMode) =>
      observedPermissionIfCurrentStmt.run(permissionMode, slug, sessionId, generation, permissionMode).changes === 1,
    setControlErrorIfCurrent: (slug, sessionId, generation, error) =>
      controlErrorIfCurrentStmt.run(error, slug, sessionId, generation).changes === 1,
    setControlError: (slug, error) => void controlErrorStmt.run(error, slug),
    setDeliveryLedger: (slug, ledger) => void deliveryLedgerStmt.run(ledger, slug),
    getSetting: (key) => {
      const row = getSet.get(key)
      if (!row) return undefined
      try {
        return JSON.parse(row.value)
      } catch {
        return undefined
      }
    },
    setSetting: (key, value) => void putSet.run(key, JSON.stringify(value)),
    deleteSetting: (key) => void delSet.run(key),
    close: () => {
      if (closed) return
      closed = true
      lifecycleListeners.clear()
      interactions.dispose()
      // A shared connection belongs to frizz-db.ts, which closes it once every tenant is gone.
      if (owned) db.close()
    },
  }
}
