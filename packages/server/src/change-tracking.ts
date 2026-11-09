import type Database from "./sqlite.ts"

// WHICH ROWS MOVED — per-connection change tracking through TEMP triggers (2026-10-14).
//
// The memoised whole-table session read (storage.ts allSessions) knew only THAT this project had
// written something, never WHAT, so any write — one `setState`, one read mark — re-materialised every
// row the project has ever had. On a 5,000-thread board (4,995 of them archived) that re-read was 24-29%
// of every board refresh in a CPU profile, and the refresh as a whole cost ~260ms of blocked event loop
// per write. The registry tables the board batches (thread_done, thread_question, …) had the same
// shape one level down: re-read whole on every build whether or not anything in them had changed.
//
// SQLite will say exactly what changed if asked, and TEMP triggers are how to ask without touching the
// persistent schema. A TEMP trigger lives in this connection's `temp` schema only: it is never written
// to `ui.db`, an older build opening the same file sees nothing new, and it fires for every write made
// THROUGH THIS CONNECTION — whatever statement made it, including one added next year that nobody
// remembered to route through a cache. That last property is the point: a hand-maintained "I wrote
// slug X" call at each of the ~40 statements that write `session` is exactly the kind of list that goes
// stale silently (storage.ts says so about its own version counter).
//
// Two shapes, one per need:
//   * `frizz_session_change` — an append-only log of (project, slug) for every session row inserted,
//     updated or deleted. The session cache replays the entries past its watermark and re-reads only
//     those rows, so a refresh after one write reads one row instead of the table.
//   * `frizz_table_rev` — one counter per registry table, bumped by any write to it. A registry read is
//     redone only when its counter moved.
//
// WHAT THIS CANNOT SEE, and how each gap is covered:
//   * Another CONNECTION's writes (another process, or a second handle on the same file): its own temp
//     schema logs them, not ours. `PRAGMA data_version` moves on exactly those commits, and every
//     consumer treats a moved data_version as "everything changed".
//   * A ROLLBACK: temp tables are part of the transaction, so the log entries and counter bumps of a
//     rolled-back write are rolled back with it — the log stays an exact record of committed rows. Which
//     is also why no consumer may cache anything it read inside an open transaction: that read would be
//     stored under a watermark the rollback then rewinds (AUTOINCREMENT's counter rolls back too).
//   * The triggers going away: a TEMP trigger on a table is dropped with the table. Nothing in Frizz
//     rebuilds these tables, but `trackingIntact` is checked on every slow path, and a consumer that
//     finds a trigger missing reinstalls it and re-reads from scratch rather than trusting a silent log.
//
// The log is pruned (`pruneSessionChanges`) and a consumer whose watermark predates the pruned range
// re-reads from scratch, so a storage that was not asked for a while can never replay a gap.

/** The registry tables the board reads whole and keys by slug (board.ts ThreadRegistries). */
export const TRACKED_REGISTRY_TABLES = [
  "thread_link",
  "pr_watch",
  "thread_timer",
  "command_watch",
  "thread_question",
  "thread_watch",
  "thread_done",
  "thread_human_todo",
] as const
export type TrackedRegistryTable = (typeof TRACKED_REGISTRY_TABLES)[number]

const SESSION_TRIGGERS = ["frizz_track_session_ins", "frizz_track_session_upd", "frizz_track_session_upd_old", "frizz_track_session_del"]
const EXPECTED_TRIGGERS = SESSION_TRIGGERS.length + TRACKED_REGISTRY_TABLES.length * 3

// Log entries kept after a prune — far more than any consumer replays between two reads; one that
// falls behind it re-reads the table (see sessionChangesSince).
const SESSION_LOG_KEEP = 4096
const SESSION_LOG_PRUNE_AT = SESSION_LOG_KEEP * 2

interface Tracking {
  maxSeq: ReturnType<Database["prepare"]>
  changesSince: ReturnType<Database["prepare"]>
  revision: ReturnType<Database["prepare"]>
  triggers: ReturnType<Database["prepare"]>
  prune: ReturnType<Database["prepare"]>
  /** Every entry at or below this was deleted by a prune; a watermark below it cannot be replayed. */
  prunedThrough: number
}

const tracking = new WeakMap<Database, Tracking>()

function install(db: Database): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS frizz_session_change (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL
    );
    CREATE TEMP TABLE IF NOT EXISTS frizz_table_rev (name TEXT PRIMARY KEY, rev INTEGER NOT NULL);
    CREATE TEMP TRIGGER IF NOT EXISTS frizz_track_session_ins AFTER INSERT ON main.session BEGIN
      INSERT INTO frizz_session_change (project_id, slug) VALUES (NEW.project_id, NEW.slug);
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS frizz_track_session_upd AFTER UPDATE ON main.session BEGIN
      INSERT INTO frizz_session_change (project_id, slug) VALUES (NEW.project_id, NEW.slug);
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS frizz_track_session_upd_old AFTER UPDATE ON main.session
      WHEN OLD.project_id IS NOT NEW.project_id OR OLD.slug IS NOT NEW.slug BEGIN
      INSERT INTO frizz_session_change (project_id, slug) VALUES (OLD.project_id, OLD.slug);
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS frizz_track_session_del AFTER DELETE ON main.session BEGIN
      INSERT INTO frizz_session_change (project_id, slug) VALUES (OLD.project_id, OLD.slug);
    END;
  `)
  for (const table of TRACKED_REGISTRY_TABLES) {
    // Table names come from the constant above, never from input.
    db.exec(`
      INSERT OR IGNORE INTO frizz_table_rev (name, rev) VALUES ('${table}', 0);
      CREATE TEMP TRIGGER IF NOT EXISTS frizz_track_${table}_ins AFTER INSERT ON main.${table} BEGIN
        UPDATE frizz_table_rev SET rev = rev + 1 WHERE name = '${table}';
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS frizz_track_${table}_upd AFTER UPDATE ON main.${table} BEGIN
        UPDATE frizz_table_rev SET rev = rev + 1 WHERE name = '${table}';
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS frizz_track_${table}_del AFTER DELETE ON main.${table} BEGIN
        UPDATE frizz_table_rev SET rev = rev + 1 WHERE name = '${table}';
      END;
    `)
  }
}

/**
 * Install the triggers on this connection (idempotent) and return its handles. Called by every
 * storage over the connection, after the schema exists.
 */
export function ensureChangeTracking(db: Database): void {
  if (tracking.has(db)) return
  install(db)
  tracking.set(db, {
    maxSeq: db.prepare("SELECT seq FROM temp.sqlite_sequence WHERE name = 'frizz_session_change'"),
    changesSince: db.prepare("SELECT DISTINCT slug FROM temp.frizz_session_change WHERE seq > ? AND project_id = ?"),
    revision: db.prepare("SELECT rev FROM temp.frizz_table_rev WHERE name = ?"),
    triggers: db.prepare("SELECT count(*) AS n FROM temp.sqlite_master WHERE type = 'trigger' AND name GLOB 'frizz_track_*'"),
    prune: db.prepare("DELETE FROM temp.frizz_session_change WHERE seq <= ?"),
    prunedThrough: 0,
  })
}

function handles(db: Database): Tracking {
  let t = tracking.get(db)
  if (!t) {
    ensureChangeTracking(db)
    t = tracking.get(db)!
  }
  return t
}

/**
 * Whether every trigger is still in place. False means a table was dropped and recreated under the
 * log; it is reinstalled here, and the caller must treat everything it cached as unknown.
 */
export function trackingIntact(db: Database): boolean {
  const t = handles(db)
  const n = Number((t.triggers.get() as { n: number } | undefined)?.n ?? 0)
  if (n === EXPECTED_TRIGGERS) return true
  install(db)
  return false
}

/** The newest session-log sequence number on this connection (0 before the first write). */
export function sessionLogHead(db: Database): number {
  return Number((handles(db).maxSeq.get() as { seq: number } | undefined)?.seq ?? 0)
}

/**
 * The project's slugs whose session row was written after `watermark`, or `null` when that range can
 * no longer be replayed (pruned) and the caller must re-read the table. Never call inside a
 * transaction: see the file header.
 */
export function sessionChangesSince(db: Database, projectId: string, watermark: number): string[] | null {
  const t = handles(db)
  if (watermark < t.prunedThrough) return null
  return (t.changesSince.all(watermark, projectId) as { slug: string }[]).map((row) => row.slug)
}

/** Drop old log entries once the log is long. A consumer behind the cut re-reads (sessionChangesSince). */
export function pruneSessionChanges(db: Database): void {
  const t = handles(db)
  const head = sessionLogHead(db)
  if (head - t.prunedThrough < SESSION_LOG_PRUNE_AT) return
  const cut = head - SESSION_LOG_KEEP
  t.prune.run(cut)
  t.prunedThrough = cut
}

/** A tracked registry table's write counter on this connection. */
export function registryRevision(db: Database, table: TrackedRegistryTable): number {
  return Number((handles(db).revision.get(table) as { rev: number } | undefined)?.rev ?? -1)
}
