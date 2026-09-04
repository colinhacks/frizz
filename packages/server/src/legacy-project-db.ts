import Database from "./sqlite.ts"
import { slugMintedFromTitle, type SessionRow } from "./storage.ts"

// THE PER-PROJECT FILE'S OWN MIGRATIONS, kept only to read one (2026-08-27).
//
// Until the unified database (see project-scope.ts and frizz-db.ts) every project had its own
// `<stateDir>/ui.db`, and createStorage brought each one up to date on open with the block below:
// the schema as CREATE TABLE IF NOT EXISTS, then a stack of additive ALTERs and idempotent repairs,
// each guarded by its own try/catch or marker. None of that is needed for a database this code
// creates — the unified schema is written complete — but a legacy file is imported by copying its
// rows table by table, and a row can only be copied out of a file whose columns exist. So the block
// lives on here, verbatim, and runs ONCE per legacy file, immediately before its rows are read.
//
// Nothing else may call this. It writes the OLD shape (no project_id), and running it against the
// unified file would add nothing and could re-create a retired table.

export function migrateLegacyProjectDatabase(db: Database): void {
  // THE ORPHAN TABLE THAT OUTLIVED ITS OWN RETIREMENT NOTE (2026-08-27). thread_watch was retired on
  // 2026-08-14 under the note kept below in the schema: "An old DB keeps the orphan table, which costs
  // nothing and is safer than a migration to remove it." That was true for exactly as long as nothing
  // reused the name. 818eeeb3 brought the table back with a DIFFERENT shape, and CREATE TABLE IF NOT
  // EXISTS does not reshape a table that already exists -- so on any database that had run the retired
  // build, the orphan survived the upgrade and the next statement in the schema block, the index on
  // (state, expires_at), threw "no such column: expires_at".
  //
  // That is a STARTUP ABORT, not a degraded feature: createStorage throws, the control plane exits
  // before ready, and the launcher reports only "Frizz did not become healthy". Seven of the fifty-four
  // project databases on the maintainer's own machine could not open at all.
  //
  // DROPPED rather than rebuilt, because the shapes do not reconcile and no live state is lost. The old
  // kinds ('pr', 'ci', 'shell') and states ('armed', 'fired', 'dropped') are not the new table's, so a
  // preserved row could not satisfy its CHECK constraints; the required expires_at has no honest value
  // to backfill; and nothing has read these rows since the day the feature was retired. Every row that
  // survived on this machine was already terminal ('fired' or 'dropped') -- there was no armed wait
  // anywhere to lose.
  //
  // FIRST, above the schema block, unlike the additive migrations below it: the statement that fails is
  // INSIDE that block. Guarded on the missing column rather than on a version, so it fires exactly once
  // per database, no-ops on a table that already has the column, and no-ops on a fresh database whose
  // PRAGMA returns no rows at all.
  const legacyWatchColumns = db.prepare("PRAGMA table_info(thread_watch)").all() as Array<{ name: string }>
  if (legacyWatchColumns.length > 0 && !legacyWatchColumns.some((c) => c.name === "expires_at")) {
    db.exec("DROP TABLE thread_watch")
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      slug        TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      thread_name   TEXT NOT NULL,
      spawned_at  TEXT NOT NULL,
      last_read_at TEXT,
      unread      INTEGER NOT NULL DEFAULT 0,
      exited      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Forgotten-transcript graveyard: a transcript id (a session_id or a discovered transcript_id) whose
    -- registry row was hard-deleted via forgetSession. Foreign-discovery excludes these so a dismissed
    -- phantom can never re-surface as a read-only "foreign" thread on a later log-dir rescan.
    CREATE TABLE IF NOT EXISTS tombstone (
      transcript_id TEXT PRIMARY KEY,
      slug          TEXT NOT NULL,
      forgotten_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS adoption_claim (
      slug                TEXT PRIMARY KEY,
      attempt_token       TEXT NOT NULL UNIQUE,
      session_id          TEXT NOT NULL UNIQUE,
      state               TEXT NOT NULL CHECK (state IN ('reserved', 'spawned', 'recovering', 'finalized')),
      reserved_at_ms      INTEGER NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL,
      recovery_token      TEXT,
      pane_id             TEXT,
      pane_pid            INTEGER,
      session_created     INTEGER,
      finalized_at_ms     INTEGER,
      CHECK (
        (pane_id IS NULL AND pane_pid IS NULL AND session_created IS NULL) OR
        (pane_id IS NOT NULL AND pane_pid IS NOT NULL AND session_created IS NOT NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS adoption_retired_attempt (
      attempt_token TEXT PRIMARY KEY,
      slug          TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      retired_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adoption_retired_attempt_slug_idx
      ON adoption_retired_attempt(slug);
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
      slug       TEXT NOT NULL,
      session_id TEXT NOT NULL,
      op_id      TEXT NOT NULL,
      retired_at TEXT NOT NULL,
      PRIMARY KEY (slug, session_id, op_id)
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
      thread_slug TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      fire_at     INTEGER NOT NULL,
      state       TEXT NOT NULL CHECK (state IN ('armed', 'fired', 'cancelled')),
      created_at  INTEGER NOT NULL,
      settled_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS thread_timer_due
      ON thread_timer(state, fire_at);
    CREATE INDEX IF NOT EXISTS thread_timer_slug
      ON thread_timer(thread_slug, state, fire_at);
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
      -- with it. Nullable in the column only so an older row reads; the tool refuses to arm without one.
      expires_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS pr_watch_armed
      ON pr_watch(state);
    CREATE INDEX IF NOT EXISTS pr_watch_slug
      ON pr_watch(thread_slug, state, created_at);
    -- A worker's registered WATCHES on its own running work (2026-08-26). See
    -- plans/rest-by-registration.md: a wait stops being a line the worker re-writes at every rest and
    -- becomes a row it creates once, which the human sees in the queue and which wakes the thread itself.
    --
    -- This is thread_watch RETURNING, and the note below says why it went away: "The registry existed
    -- because a fence had no identity to drop; the answer turned out to be that a park nobody has to drop
    -- needs none." What that traded away is the thing the maintainer now wants back -- a fence has the
    -- LIFETIME of the message carrying it, so a worker must restate the same wait on every single rest or
    -- lose it. A row does not need restating.
    --
    -- Two columns are the whole difference from the retired table, and both close the hole that made a
    -- durable row dangerous. KIND is stored and checked against the target's own shape at registration,
    -- so a PR ref can never arm as a shell. EXPIRES_AT is REQUIRED, chosen by the worker for this
    -- particular wait: on elapse the row is cancelled and the thread woken, so a registration cannot
    -- outlive its own relevance the way an un-restated fence never could.
    CREATE TABLE IF NOT EXISTS thread_watch (
      id          TEXT PRIMARY KEY,
      thread_slug TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('shell', 'agent')),
      -- The handle the worker was shown: a runtime task id, a launch tool_use id, or the op's label.
      -- Resolved against live telemetry when the row is rendered; an unresolvable one still renders,
      -- naming itself, exactly as the fence-derived row did.
      target      TEXT NOT NULL,
      state       TEXT NOT NULL CHECK (state IN ('armed', 'dropped', 'expired', 'settled')),
      created_at  INTEGER NOT NULL,
      -- REQUIRED at registration, unlike pr_watch's, which is nullable only to read an older row. There
      -- are no older ROWS here -- but there was an older TABLE, which is not the same thing and cost a
      -- startup abort to learn (2026-08-27). A NOT NULL column cannot be added to it by ALTER, so the
      -- legacy table is dropped at the top of createStorage, before this block runs.
      expires_at  INTEGER NOT NULL,
      settled_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS thread_watch_due
      ON thread_watch(state, expires_at);
    CREATE INDEX IF NOT EXISTS thread_watch_slug
      ON thread_watch(thread_slug, state, created_at);
    -- One armed watch per (thread, kind, target): re-registering the same wait is idempotent rather than
    -- a second row that has to be dropped twice. Partial, so a dropped row never blocks a re-arm.
    CREATE UNIQUE INDEX IF NOT EXISTS thread_watch_unique_armed
      ON thread_watch(thread_slug, kind, target) WHERE state = 'armed';
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
      ON thread_question(thread_slug, state, asked_at);
    CREATE INDEX IF NOT EXISTS thread_question_undelivered
      ON thread_question(state, delivered);

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
      thread_slug TEXT PRIMARY KEY,
      -- The markdown the card renders, the same body the fence carried between its backticks.
      body        TEXT NOT NULL,
      done_at     INTEGER NOT NULL
    );
    -- The retirement note for the ORIGINAL thread_watch is kept below as the record of why it left, and
    -- of what had to change before it could come back.
    -- thread_watch WAS HERE and is retired (2026-08-14). A worker's wait is a 'watch:' line in its own
    -- awaiting fence again, which is BOTH the park and the wake -- the scheduler matches the name against
    -- the thread's live shells and its retired-shell ring, so nothing needs registering and nothing can
    -- outlive the fence that declares it. The registry existed because a fence had no identity to drop;
    -- the answer turned out to be that a park nobody has to drop needs none.
    --
    -- This note used to end "an old DB keeps the orphan table, which costs nothing and is safer than a
    -- migration to remove it", and that was the sentence the 2026-08-27 startup abort was hiding behind:
    -- it costs nothing only while nothing reuses the name, and the table came BACK. The drop that the
    -- note talked the reader out of now runs at the top of createStorage. Retiring a table, not just a
    -- column, is what leaves this trap behind -- an orphan is free until the name is claimed again.
    -- (No backticks in this comment: the whole schema is a template literal.)
  `)
  // THE COLUMN THAT OUTLIVED THE MULTIPLEXER (2026-08-19). This held the thread identity string
  // `frizz-<slug>` and was called `tmux_name` for years after the last pane went away, which is most of
  // why every reader kept concluding the agents still live in tmux. It is a plain rename: the VALUE was
  // never a pane name, only a name that happened to be given to one.
  //
  // FIRST, above every statement below, because `CREATE TABLE IF NOT EXISTS` does not reshape a table
  // that already exists — so on any database that has booted before, the column is still `tmux_name`
  // here, and every later statement naming `thread_name` would fail against it. Idempotent by failing:
  // once renamed there is no `tmux_name` left to rename, and a fresh database never had one.
  try {
    db.exec("ALTER TABLE session RENAME COLUMN tmux_name TO thread_name")
  } catch {
    // already renamed, or a database created with the new name
  }
  // THE COLUMNS THE CONFIRMATION RPC LEFT BEHIND (2026-08-24). These held one operator confirmation of
  // one exact awaiting-fence generation, for a "Confirm snooze" affordance that armed a durable park.
  // The 2026-08-15 grammar cut made every hint non-actionable, so nothing has been able to write them
  // since; the scheduler half went in ccbe87e9 and the RPC, its compare-and-swap and its two clears go
  // here. Dropped rather than left declared, because a column no writer can reach is one the next
  // reader has to work out is dead.
  //
  // Same placement and the same idempotence as the rename above: SQLite throws "no such column" on the
  // second run, so a database that has booted since this landed and one that never had the columns both
  // no-op. Unlike the additive ADD COLUMNs below this DOES reshape the table, so an older server process
  // holding the same file open would find its prepared statements invalid — the singleton launcher
  // refuses a second server, which is what keeps that from happening.
  for (const dead of ["awaiting_fence_id", "awaiting_confirmed_at"]) {
    try {
      db.exec(`ALTER TABLE session DROP COLUMN ${dead}`)
    } catch {
      // already dropped, or a database that never had it
    }
  }
  // Best-effort inline migration for older DBs. Session-first/profile columns are nullable ADDs
  // (except the existing boolean/backend defaults) — additive + idempotent, safe while another server
  // process holds the db open (the live server never sees a shape it can't read).
  for (const col of [
    "archived INTEGER NOT NULL DEFAULT 0",
    "title_auto INTEGER NOT NULL DEFAULT 0",
    // Defaults LOCKED so the ADD COLUMN backfill is conservative: every row that predates the split
    // keeps exactly its old behavior, and any write path that forgets the column fails safe (a title
    // that can't be replaced, never one that's silently overwritten). The boot repair below then
    // unlocks the machine-guessed ones.
    "title_locked INTEGER NOT NULL DEFAULT 1",
    "rested_at TEXT",
    "title TEXT",
    "state TEXT",
    "snoozed_until TEXT",
    "snooze_prompt TEXT",
    "bg_snooze_rested_at TEXT",
    "meta TEXT",
    "seen_at TEXT",
    "transcript_id TEXT",
    "backend TEXT NOT NULL DEFAULT 'claude'",
    "agent_session_id TEXT",
    "model TEXT",
    "effort TEXT",
    "profile_pending_model TEXT",
    "profile_pending_effort TEXT",
    "profile_revision INTEGER NOT NULL DEFAULT 0",
    "profile_handoff TEXT",
    "permission_mode TEXT",
    "permission_pending TEXT",
    "permission_set_at TEXT",
    "profile_set_at TEXT",
    "control_error TEXT",
    "delivery_ledger TEXT",
    "runtime_generation INTEGER NOT NULL DEFAULT 0",
    "runtime_control TEXT",
    "runtime_control_revision INTEGER NOT NULL DEFAULT 0",
    // Codex transport discriminator: 'app-server' = a bridge-owned JSON-RPC session (input via
    // turn/start|steer, liveness from the bridge). NULL/'tmux' is the pre-app-server legacy value,
    // still readable on an old database and never written again.
    "codex_runtime TEXT",
    // Claude transport discriminator: 'broker' = a session-broker-owned Agent SDK session (input via
    // the bridge, liveness from it). NULL/'tmux' is the pre-broker legacy value, same story: readable,
    // not creatable.
    "claude_runtime TEXT",
    // The legacy two-feature columns. Superseded 2026-08-03 by the `recurring_*` set below, which
    // merged the stop hook and the heartbeat into ONE prompt with two triggers. They are still declared
    // here (rather than dropped) for exactly one reason: the backfill further down reads them, and it
    // must keep working on a database that has not booted since before the merge. Nothing WRITES them
    // any more — if you find yourself adding a writer, you are re-forking the feature.
    "heartbeat_prompt TEXT",
    "heartbeat_interval_ms INTEGER",
    "heartbeat_enabled INTEGER NOT NULL DEFAULT 0",
    "heartbeat_armed_at TEXT",
    "heartbeat_last_fired_at TEXT",
    "stop_hook TEXT",
    "stop_hook_enabled INTEGER NOT NULL DEFAULT 0",
    "stop_hook_armed_at TEXT",
    "stop_hook_last_fired_at TEXT",
    // THE RECURRING PROMPT (scheduler.ts SOURCES 4, 5 and 7): one text, three independent triggers —
    // every time the thread rests, every N ms on a clock, and/or every time its context is compacted.
    // All flags 0 = off; there is no separate enable column, because another flag could only ever
    // contradict the ones that decide the behaviour.
    "recurring_prompt TEXT",
    "recurring_on_rest INTEGER NOT NULL DEFAULT 0",
    "recurring_on_schedule INTEGER NOT NULL DEFAULT 0",
    "recurring_interval_ms INTEGER",
    "recurring_armed_at TEXT",
    "recurring_rest_fired_at TEXT",
    "recurring_schedule_fired_at TEXT",
    // The post-compaction trigger (2026-08-06). Added as its own ALTER rather than folded into the set
    // above so a database armed before this release picks it up on the next boot with the flag off,
    // which is the correct default: an existing prompt described the triggers its operator chose.
    "recurring_on_compact INTEGER NOT NULL DEFAULT 0",
    "recurring_compact_fired_at TEXT",
    // NO `recurring_pause_on_questions` HERE ANY MORE. It held every trigger while the thread was waiting
    // on the human and the footer showed it inverted as "Autonomous mode"; both were deleted 2026-08-16
    // (see scheduler.ts, "WHAT A PENDING QUESTION DOES TO THE THREE TRIGGERS"). A database created before
    // that release still carries the column — it is `NOT NULL DEFAULT 0`, so nothing needs to write it,
    // and dropping it would cost a table rebuild to reclaim one inert integer per row.
    // THE BUILT-IN SIGN-OFF NUDGE (scheduler SOURCE 9, 2026-08-12). How many times in a row frizz has
    // told this thread how to sign off without a fence appearing. Cleared ONLY when the thread signs
    // off — never by a user record, because frizz's own delivery is one. The second column holds the
    // last-nudged delivery id, for diagnosis.
    "signoff_nudges INTEGER NOT NULL DEFAULT 0",
    "signoff_nudge_anchor TEXT",
    // Cleared by `resetParkBumps` when a park is actually HONOURED — the one event that proves the
    // correction landed, and the one frizz cannot cause by correcting.
    "park_bumps INTEGER NOT NULL DEFAULT 0",
    "park_bump_anchor TEXT",
    // Title provenance for the CURRENT text (2026-08-07): 1 = the worker's own title signal wrote it,
    // 0 = the dispatch seeded it. DEFAULT 0 is the conservative direction — an existing row is assumed
    // to hold its dispatch chop until the repair below (or the next title signal) says otherwise.
    "title_agent INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(`ALTER TABLE session ADD COLUMN ${col}`)
    } catch {
      // column already exists
    }
  }
  // A PR WATCHER'S EXPIRY (2026-08-15), on the same additive terms as the session columns above: the
  // table is created with IF NOT EXISTS, so an existing database never sees the new column otherwise.
  // Left NULL on an already-armed row — the poller treats "no expiry" as the old unbounded behaviour
  // rather than settling a live watcher out from under a thread that is parked on it.
  try {
    db.exec("ALTER TABLE pr_watch ADD COLUMN expires_at INTEGER")
  } catch {
    // column already exists
  }
  // THE REBRAND LEFT THESE ROWS BEHIND (2026-08-06). `thread_name` is re-derived as
  // `frizz-<slug>` and checked on EVERY write by validateSessionIdentity, so a row still holding
  // `fray-<slug>` is a row whose next write is rejected. The one-time migration that fixed this was
  // deleted once the projects in use had been converted — but ten project databases had simply not
  // been opened since, carrying fourteen threads between them, and a project nobody opened for a week
  // is exactly what a machine-wide project grid now invites you to open.
  //
  // It lives here rather than in a migration module because it is idempotent and self-limiting: the
  // LIKE matches nothing once a database has been through it, so it costs one no-op scan per boot and
  // there is nothing left to delete later.
  try {
    db.exec("UPDATE session SET thread_name = 'frizz-' || substr(thread_name, 6) WHERE thread_name LIKE 'fray-%'")
  } catch {
    // A pre-schema database, or one without the column yet. The ALTERs above own that case.
  }
  // ONE-SHOT ADOPTION of the pre-merge two-feature rows (2026-08-03). A thread that had a stop hook, a
  // heartbeat, or both keeps working across the upgrade instead of silently going quiet.
  //
  // GUARDED ON `recurring_armed_at IS NULL`, which is what makes it safe to re-run on every boot: the
  // moment a row has a recurring prompt of its own, this stops touching it. Without that guard it would
  // resurrect a prompt the operator had since cleared, every single restart — the exact failure the
  // 2026-08-02 adoption pass was deleted for.
  //
  // WHERE THE TEXT COMES FROM when both were armed with DIFFERENT words: the stop hook's wins. Merging
  // is inherently lossy in that case (it is the one capability this merge removes), and the stop hook
  // is the more likely to hold the real driving instruction — the heartbeat's tended to be a short
  // "check X" reminder. The triggers and the cadence both carry over regardless, so the thread keeps
  // firing on the same schedule it had.
  try {
    db.exec(`
      UPDATE session SET
        recurring_prompt = COALESCE(stop_hook, heartbeat_prompt),
        recurring_on_rest = CASE WHEN stop_hook IS NOT NULL AND stop_hook_enabled = 1 THEN 1 ELSE 0 END,
        recurring_on_schedule = CASE WHEN heartbeat_prompt IS NOT NULL AND heartbeat_enabled = 1 THEN 1 ELSE 0 END,
        recurring_interval_ms = heartbeat_interval_ms,
        -- The generation is the LATER of the two, so a delivery still in the outbox under either old
        -- generation reads as superseded rather than landing against the merged row.
        recurring_armed_at = CASE
          WHEN stop_hook_armed_at IS NULL THEN heartbeat_armed_at
          WHEN heartbeat_armed_at IS NULL THEN stop_hook_armed_at
          WHEN stop_hook_armed_at > heartbeat_armed_at THEN stop_hook_armed_at
          ELSE heartbeat_armed_at
        END,
        recurring_rest_fired_at = stop_hook_last_fired_at,
        recurring_schedule_fired_at = heartbeat_last_fired_at
      WHERE recurring_armed_at IS NULL
        AND (stop_hook IS NOT NULL OR heartbeat_prompt IS NOT NULL)
    `)
  } catch {
    // A database predating the legacy columns has nothing to adopt.
  }
  // One-time idempotent backfill: rows the user already archived under the boolean flag carry that
  // into the new lifecycle column. Only fills NULLs — an explicit later state write always wins.
  try {
    db.exec("UPDATE session SET state = 'archived' WHERE archived = 1 AND state IS NULL")
    // Unlock the machine-guessed titles the conservative DEFAULT 1 above just locked. Safe to re-run on
    // EVERY boot — not merely at first migration — because every writer that locks a title also clears
    // title_auto, so `title_locked = 1 AND title_auto = 1` is a state nothing can legitimately produce.
    // (A boot repair that re-LOCKED instead would be the dangerous direction: it would silently re-lock
    // each newly dispatched caller-titled row on the next restart.)
    db.exec("UPDATE session SET title_locked = 0 WHERE title_auto = 1")
    // ONE-TIME repair for titles locked by a BUG rather than by a human. From the broker's arrival
    // (2026-07-24) until the fix that ships with this line, the Claude session-broker dispatch path
    // omitted `title_locked` from its registry row, and an absent value on a caller-titled row
    // normalises to LOCKED (see sessionTitleLocked — it fails safe, which here means failing into the
    // bug). So every GitHub-batch and spawn_thread thread froze on its dispatch title
    // (`Investigate acme/app#391`) while the worker's own, far better name was withheld forever.
    // Rows that predate the title_auto/title_locked split carry the same shape, left locked by the
    // deliberately conservative ADD COLUMN backfill above.
    //
    // A human's rename and a stuck dispatch title are indistinguishable by the flags alone, so this
    // asks a sharper question: does the SLUG still read as one this exact title minted? Dispatch is
    // the only writer that derives one from the other, and a rename rewrites the title while leaving
    // the slug untouched — so a renamed thread fails the test, which is what keeps the repair off
    // human names. It runs ONCE (settings marker) because, unlike the invariant-based repairs around
    // it, that test is a heuristic: a human rename after the repair must be the last word.
    const unlockedRepairKey = "repair:unlock-dispatch-minted-titles"
    const repairDone = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
      .get(unlockedRepairKey)
    if (!repairDone) {
      const unlockOne = db.prepare("UPDATE session SET title_locked = 0 WHERE slug = ? AND title_locked = 1")
      const candidates = db.prepare<[], Pick<SessionRow, "slug" | "title">>(`
        SELECT slug, title FROM session
        WHERE title_locked = 1 AND title_auto = 0 AND title IS NOT NULL AND title <> ''
      `).all()
      for (const row of candidates) {
        if (row.title && slugMintedFromTitle(row.slug, row.title)) unlockOne.run(row.slug)
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
        .run(unlockedRepairKey, new Date().toISOString())
    }
    // ONE-TIME backfill of `title_agent` for rows that predate the column. The auto-title CAS has been
    // persisting the codex worker's own title into `title` since the app-server path landed, but until
    // the column shipped nothing recorded that provenance — so once a codex thread's live telemetry
    // went away (rest, archive, restart) the board had no way to tell that title from the dispatch
    // chop and the display fell back to "Untitled thread" for ALL of them. On the maintainer's own
    // board that was every codex thread on it, 29 of 29 (2026-08-07).
    //
    // Same sharper question the repair above asks, in the same direction: dispatch is the only writer
    // that derives the slug and the title from each other, so a codex row whose slug no longer reads
    // as one this title minted is a row whose title has been REPLACED since dispatch — and on an
    // unlocked `title_auto = 1` row the only writer that can have done so is the auto-title CAS.
    // ONCE (settings marker), because it is a heuristic: a row whose title genuinely is still its chop
    // must be free to stay that way, and every title written from here on records its own provenance.
    const agentTitleRepairKey = "repair:mark-agent-written-titles"
    const agentRepairDone = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
      .get(agentTitleRepairKey)
    if (!agentRepairDone) {
      const markOne = db.prepare("UPDATE session SET title_agent = 1 WHERE slug = ? AND title_agent = 0")
      const candidates = db.prepare<[], Pick<SessionRow, "slug" | "title">>(`
        SELECT slug, title FROM session
        WHERE backend = 'codex' AND title_auto = 1 AND title_locked = 0
          AND title IS NOT NULL AND title <> ''
      `).all()
      for (const row of candidates) {
        if (row.title && !slugMintedFromTitle(row.slug, row.title)) markOne.run(row.slug)
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
        .run(agentTitleRepairKey, new Date().toISOString())
    }
    // The interactive Codex composer is gone, and with it every writer AND releaser of its durable
    // 'codex-input' runtime lock. A row that still holds one was locked by the retired subsystem and
    // nothing can ever clear it again: the board reports runtimeControlPending forever, which fences
    // that thread's composer, model, and sandbox controls permanently. Release it once, at boot.
    db.exec("UPDATE session SET runtime_control = NULL WHERE runtime_control = 'codex-input'")
    // Same class, same reasoning, the OTHER purely in-process lock. `resume.ts` takes 'follow-up' for
    // the ~300-800ms an injection needs and releases it in a `finally` — so no process can legitimately
    // still hold one after a restart, and one left by a hard kill inside that window fences the thread's
    // follow-ups permanently ("Another runtime control is in progress" on every later send, forever).
    // Note what is NOT swept: 'profile' is DURABLE by design — profile_handoff rides with it and restart
    // recovery must prove one exact runtime before clearing either (see the codex-only abandon above).
    db.exec("UPDATE session SET runtime_control = NULL WHERE runtime_control = 'follow-up'")
    // Same class, one step further: a CODEX row can also still hold the PROFILE handoff a pre-cutover
    // crash left behind, from when a model/effort change was applied by relaunching an interactive
    // worker. That handoff can never complete now — its recovery step reattached the worker's terminal
    // and read it with the Claude composer parser, which a Codex worker never satisfied, and no such
    // path exists at all any more — so the recovery loop re-blocks the thread on every tick forever.
    // Abandon the pending pair and say why; codex takes model/effort per turn, so nothing is lost but
    // the stuck arming.
    db.exec(`
      UPDATE session
      SET runtime_control = NULL, profile_pending_model = NULL, profile_pending_effort = NULL,
          profile_handoff = NULL,
          control_error = 'A model/effort change armed on the retired Codex interactive path was abandoned; set it again.'
      WHERE backend = 'codex' AND runtime_control = 'profile'
    `)
    // Heal every app-server codex row that was downgraded behind the operator's back. Until the fixes
    // that ship with this line, a cold resume sent no sandbox/approval override, so the app-server
    // applied the config.toml defaults (`workspace-write` + `on-request`) and the tailer then folded
    // that observation back into permission_mode as if the operator had chosen it. `sandboxFor` reads
    // this column, so the downgrade became self-perpetuating: the thread requested workspace-write on
    // every later resume and stalled on an approval nobody was watching. Frizz workers are dispatched
    // non-interactively (WORKER_DISPATCH_PERMISSION.codex) and the per-thread picker was removed from
    // the UI, so there is no operator choice left for this rewrite to overwrite.
    db.exec(`
      UPDATE session SET permission_mode = 'bypassPermissions'
      WHERE backend = 'codex' AND codex_runtime = 'app-server'
        AND (permission_mode IS NULL OR permission_mode <> 'bypassPermissions')
    `)
  } catch {
    // best-effort
  }
  db.exec("CREATE INDEX IF NOT EXISTS session_snoozed_until_idx ON session(snoozed_until)")

  // The interaction journal is an additive, independently-versioned schema in this same project DB.
  // Construct it before session write statements: replacement/delete transactions below close any
  // The wake outbox's late column (wake-store.ts, 2026-08-25) and the codex bridge's rebrand rename
  // (codex-app-server.ts, 2026-08-06), on the same terms: a legacy file that never opened the newer
  // build lacks them, and the import copies only the columns the unified table also has.
  for (const [table, column, decl] of [
    ["wake_delivery", "sent_at", "INTEGER"],
    ["codex_app_server_meta", "daemon_generation", "TEXT NOT NULL DEFAULT ''"],
    ["codex_app_server_session", "auto_resumed_turn_id", "TEXT"],
    ["codex_app_server_session", "auto_resume_count", "INTEGER NOT NULL DEFAULT 0"],
    ["codex_app_server_session", "sandbox", "TEXT"],
    ["codex_app_server_session", "intended_sandbox", "TEXT"],
  ] as const) {
    const columns = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    if (columns.length === 0 || columns.includes(column)) continue
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
    } catch {
      // best-effort: the import copies whatever columns exist
    }
  }
  const codexColumns = db.prepare<[], { name: string }>("PRAGMA table_info(codex_app_server_session)").all().map((c) => c.name)
  if (codexColumns.includes("fray_session_id") && !codexColumns.includes("frizz_session_id")) {
    try {
      db.exec("ALTER TABLE codex_app_server_session RENAME COLUMN fray_session_id TO frizz_session_id")
    } catch {
      // best-effort, as above
    }
  }
}
