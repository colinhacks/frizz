import type { ProjectScope } from "./project-scope.ts"
import type Database from "./sqlite.ts"

export type WakeDeliveryState = "pending" | "leased" | "delivered" | "superseded" | "exhausted"

// ---- THE QUIET WINDOW ---------------------------------------------------------------------------
// EVERY WAKE IS A NEW TURN, and a turn is the expensive unit. A wake lands as a fresh user message in a
// Claude Code session whose context runs 150k–450k tokens; the turn re-reads all of it on every API call
// and typically makes 10–40 calls, so one wake costs $2–3 at list price before the worker has done
// anything useful. Measured on the maintainer's board 2026-09-03: wake-triggered turns were 32% of the
// day's spend (pull-request watchers 20%, the worker's own shell/watch wakes 6%, usage-limit resumes
// 6%), and the outbox showed the shape of the waste — one thread woken SIX times in 40 minutes by one
// PR's review comments (13:08, 13:16, 13:25, 13:39, 13:44, …), each a turn; two threads watching the
// same PR each woken on all eight of an hour's pushes; the limit resume restarting five threads within
// twelve seconds.
//
// So a wake enqueued for a thread that was handed a wake less than this long ago is not claimable until
// the window has elapsed: `next_attempt_at` is pushed out to `lastHandoff + window`, and everything that
// arrives for the thread in the meantime waits beside it and is MERGED into the same delivery when the
// window opens (scheduler.deliverDue). A burst then costs one turn instead of one per event. The
// window is measured from the last HANDOFF — sent or delivered, whichever the store recorded — because
// that is the instant the thread's turn began, and the turn is what is being rationed.
//
// Five minutes is the tradeoff between a worker hearing news promptly and a worker paying a turn per
// event: a PR watcher's poll is already 60s, so news arrives at most four polls late, and a review
// burst (the six-in-40-minutes case above) collapses into one or two turns instead of six.
export const WAKE_QUIET_WINDOW_MS = 5 * 60_000

/** Hint-key prefixes the quiet window does NOT hold. An answer from the human (`answers:`) is the one
 *  delivery a worker is actually waiting on, and the human is sitting right there; a usage-limit
 *  resume (`limit:`) is the thread coming back from a wall it did not choose, and holding it would
 *  only lengthen the outage. Both still merge with anything already pending for the thread.
 *
 *  THE SIGN-OFF NUDGE AND THE FENCE CORRECTIONS answer the worker's OWN rest, and that rest is the card
 *  the human is reading in the queue right now: a bare rest nobody can triage, or a park frizz refused.
 *  Holding the fix for five minutes leaves that card on the board for five minutes, which is the whole
 *  failure the nudge exists to prevent — observed 2026-09-25, a Codex thread's bare rest landing 9s after
 *  its PR-merged wake, its nudge queued 2s later and held until 4m51s after that, by which point the
 *  maintainer had opened it and asked how it stopped without a sign-off. Neither can burst, which is what
 *  the window rations: both are capped per consecutive rest (scheduler SIGNOFF_NUDGE_MAX, PARK_BUMP_MAX).
 *  An EXPIRED park stays held — it is a scheduled re-check, uncapped, and a `for: 30s` re-park would
 *  otherwise wake every 30 seconds.
 *
 *  A ```done FENCE OVER AN OPEN QUESTION (`park:done-open-question:`, 2026-10-13) is the same case with a
 *  shorter fuse: its usual rest comes a minute or two after the wake that let the worker finish, so the
 *  window would hold the correction for most of five minutes while the human looks at a done card with a
 *  live "Mark as done" over a question nobody answered. Archiving there is what the correction is for.
 *
 *  THE LIST NAMES EVERY COUNTED CORRECTION BY ITS CAUSE, and two were missing until 2026-10-13 because
 *  each was added to the scheduler after this list was written. `park:question-fence:` (a ```question
 *  fence that could not register) was held for up to five minutes, measured: minted 45s after the
 *  thread's last wake, sent at 5m 15s — while the worker believed it had asked and the human's queue
 *  showed a rest with a code block in it. `park:needs-input:` (a park with no `status:` Frizz can read)
 *  is a park Frizz refused, which is this comment's own second example, and is counted against
 *  PARK_BUMP_MAX like the rest. `park:question:` left the list the same day: it was the cause of the
 *  open-question refusal, which the ```question fence retired, and nothing has minted it since.
 *
 *  A COMMAND WATCH'S WAKES (`cmdwatch:`, `cmdwatch-expired:`, `cmdwatch-cancelled:`, 2026-11-02) end the
 *  very park that named them. The watch leaves `armed` the moment its wake is queued (scheduler
 *  evalCommandWatches: wake THEN settle), so the board stops honouring a `commands:` park at once and
 *  queues the thread — under an awaiting card with no row left to draw, which says only "Waiting for an
 *  external update." Held, that card stood in the queue for the rest of the window: observed 2026-10-29,
 *  a Vercel check that passed 2m 31s after the thread's last wake, its wake sent 2m 30s later, the
 *  maintainer asking what the card meant in between. Each wake ends its watch, so none can burst.
 *  TIMERS STAY HELD, and need to: a timer row stays `armed` until its wake is delivered (scheduler
 *  settleTimer), so a park on one keeps holding through the window and the card keeps its row. */
export const WAKE_QUIET_EXEMPT_HINT_PREFIXES = [
  "answers:", "limit:", "interrupt-ended:",
  "signoff:", "park:retired:", "park:nameless:", "park:dead:", "park:needs-input:",
  "park:question-fence:", "park:done-open-question:",
  "cmdwatch:", "cmdwatch-expired:", "cmdwatch-cancelled:",
  // A MONITOR's three endings (2026-11-02), for the same reason: each settles the row and ends the park.
  // Its EVENTS (`cmdmon:`) are NOT here — the row stays armed under them, so the park keeps holding, and a
  // monitor printing every minute is exactly the burst the window exists to merge into one turn.
  "cmdmon-exited:", "cmdmon-expired:", "cmdmon-cancelled:",
] as const

export function isQuietWindowExempt(hintKey: string): boolean {
  return WAKE_QUIET_EXEMPT_HINT_PREFIXES.some((prefix) => hintKey.startsWith(prefix))
}

export interface WakeDeliveryStoreOptions {
  /** How long after a handoff the thread's next wake waits; `WAKE_QUIET_WINDOW_MS` unless a test says
   *  otherwise. Zero disables the hold (a wake is claimable the instant it is enqueued). */
  quietWindowMs?: number
}

export interface WakeDeliveryInput {
  id: string
  slug: string
  sessionId: string
  fenceId: string
  hintKey: string
  message: string
  reason: string
}

export interface WakeDelivery extends WakeDeliveryInput {
  state: WakeDeliveryState
  attempts: number
  nextAttemptAt: number
  leaseOwner: string | null
  leaseUntil: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
  deliveredAt: number | null
  terminalAt: number | null
  /** When the wake was last handed to the worker's runtime and is awaiting confirmation — see
   *  `markSent`. Null while pending, and cleared by every fresh claim. */
  sentAt: number | null
}

interface WakeDeliveryRow {
  id: string
  thread_slug: string
  session_id: string
  fence_id: string
  hint_key: string
  message: string
  reason: string
  state: WakeDeliveryState
  attempts: number
  next_attempt_at: number
  lease_owner: string | null
  lease_until: number | null
  last_error: string | null
  created_at: number
  updated_at: number
  delivered_at: number | null
  terminal_at: number | null
  sent_at: number | null
}

export interface WakeDeliveryStore {
  /** Idempotent on the unique key (project, slug, session, fence id): a second enqueue of the same fence
   *  returns the row that is already there, in whatever state it reached, and touches nothing — which is
   *  what lets every source dedupe by fence id. A NEW row's `nextAttemptAt` is `now`, or the end of the
   *  thread's quiet window if a wake was handed to it more recently than that (see WAKE_QUIET_WINDOW_MS). */
  enqueue(input: WakeDeliveryInput, now: number): { effect: "created" | "existing"; delivery: WakeDelivery }
  get(id: string): WakeDelivery | undefined
  list(): WakeDelivery[]
  listOpen(): WakeDelivery[]
  /** The thread's pending rows in creation order, whether or not their `nextAttemptAt` has come — the
   *  scheduler's merge reads this after a claim to find what else is waiting for the same thread. */
  pendingFor(slug: string, sessionId: string): WakeDelivery[]
  claim(owner: string, now: number, leaseUntil: number, maxAttempts: number): WakeDelivery | undefined
  /** Lease ONE NAMED pending row, exactly as `claim` would, except that its `nextAttemptAt` is not
   *  consulted: the caller already holds a claimed wake for the same thread and is folding this one into
   *  the same delivery, so the quiet window that was holding it has nothing left to hold it for. */
  adopt(id: string, owner: string, now: number, leaseUntil: number, maxAttempts: number): WakeDelivery | undefined
  deferFailure(id: string, owner: string, now: number, retryAt: number, error: string): boolean
  /** Hand a claimed row back UNSENT, due again at `retryAt`, WITHOUT the claim counting as an attempt.
   *  For a precondition the caller could not confirm before sending (a quota it could not read): that
   *  says nothing about whether delivery works, and the attempt cap exists to stop retrying a delivery
   *  that fails. A row that has been sent is never released. */
  release(id: string, owner: string, now: number, retryAt: number, error: string): boolean
  recoverExpired(id: string, now: number, retryAt: number, maxAttempts: number, error: string): WakeDelivery | undefined
  acknowledge(id: string, owner: string, now: number): boolean
  /** SENT, NOT DELIVERED. The transport accepted the wake (for a broker thread, a socket frame the daemon
   *  acknowledged — or, from a daemon older than input-ack-v1, merely wrote), and whether the
   *  worker ever reads it is decided later — by the token showing up in its transcript, or by its
   *  process outliving `confirmUntil`. The row stays leased to the owner until then, so a dead process
   *  can send it round again instead of filing a lost wake as done. */
  markSent(id: string, owner: string, now: number, confirmUntil: number): boolean
  confirm(id: string, now: number): boolean
  supersede(id: string, now: number, reason: string): boolean
}

const OUTBOX_CAP = 2_000

function delivery(row: WakeDeliveryRow): WakeDelivery {
  return {
    id: row.id,
    slug: row.thread_slug,
    sessionId: row.session_id,
    fenceId: row.fence_id,
    hintKey: row.hint_key,
    message: row.message,
    reason: row.reason,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    terminalAt: row.terminal_at,
    sentAt: row.sent_at ?? null,
  }
}

/** The outbox table, idempotent; frizz-db.ts creates it ahead of a legacy import. */
export const WAKE_DELIVERY_TABLES = ["wake_delivery"] as const
export function ensureWakeDeliverySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wake_delivery (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      thread_slug     TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      fence_id        TEXT NOT NULL,
      hint_key        TEXT NOT NULL,
      message         TEXT NOT NULL,
      reason          TEXT NOT NULL,
      state           TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'delivered', 'superseded', 'exhausted')),
      attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at INTEGER NOT NULL,
      lease_owner     TEXT,
      lease_until     INTEGER,
      last_error      TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      delivered_at   INTEGER,
      terminal_at    INTEGER,
      sent_at        INTEGER,
      UNIQUE(project_id, thread_slug, session_id, fence_id)
    );
    CREATE INDEX IF NOT EXISTS wake_delivery_due
      ON wake_delivery(project_id, state, next_attempt_at, created_at);
  `)
}

export function createWakeDeliveryStore(scope: ProjectScope, options: WakeDeliveryStoreOptions = {}): WakeDeliveryStore {
  const db = scope.db
  ensureWakeDeliverySchema(db)
  const quietWindowMs = Math.max(0, options.quietWindowMs ?? WAKE_QUIET_WINDOW_MS)

  const byId = scope.prepare<[string], WakeDeliveryRow>("SELECT * FROM wake_delivery WHERE project_id = @project_id AND id = ?")
  const all = scope.prepare<[], WakeDeliveryRow>("SELECT * FROM wake_delivery WHERE project_id = @project_id ORDER BY created_at, id")
  const open = scope.prepare<[], WakeDeliveryRow>(
    "SELECT * FROM wake_delivery WHERE project_id = @project_id AND state IN ('pending', 'leased') ORDER BY created_at, id",
  )
  const pendingForStmt = scope.prepare<[string, string], WakeDeliveryRow>(
    "SELECT * FROM wake_delivery WHERE project_id = @project_id AND thread_slug = ? AND session_id = ? AND state = 'pending' ORDER BY created_at, id",
  )
  // The thread's last HANDOFF: the newest instant any of its rows was sent to the runtime or filed as
  // delivered. `sent_at` survives confirmation and supersession, and `delivered_at` is only ever set at
  // or after it, so the scalar max of the pair per row, aggregated, is the instant the thread's most
  // recent wake-turn began. Keyed on the slug alone: a session change is the same thread restarting, and
  // it is the thread's turns that are being rationed.
  const lastHandoffStmt = scope.prepare<[string], { at: number | null }>(`
    SELECT MAX(MAX(COALESCE(delivered_at, 0), COALESCE(sent_at, 0))) AS at
    FROM wake_delivery WHERE project_id = @project_id AND thread_slug = ?
  `)
  const insert = scope.prepare(`
    INSERT INTO wake_delivery (
      project_id, id, thread_slug, session_id, fence_id, hint_key, message, reason, state, attempts,
      next_attempt_at, lease_owner, lease_until, last_error, created_at, updated_at,
      delivered_at, terminal_at
    ) VALUES (
      @project_id, @id, @slug, @sessionId, @fenceId, @hintKey, @message, @reason, 'pending', 0,
      @notBefore, NULL, NULL, NULL, @now, @now, NULL, NULL
    )
    ON CONFLICT DO NOTHING
  `)
  const terminalCount = scope.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM wake_delivery WHERE project_id = @project_id AND state IN ('delivered', 'superseded', 'exhausted')",
  )
  const pruneTerminal = scope.prepare(`
    DELETE FROM wake_delivery WHERE project_id = @project_id AND id IN (
      SELECT id FROM wake_delivery
      WHERE project_id = @project_id AND state IN ('delivered', 'superseded', 'exhausted')
      ORDER BY terminal_at, created_at, id
      LIMIT ?
    )
  `)
  const due = scope.prepare<[number, number], WakeDeliveryRow>(`
    SELECT * FROM wake_delivery
    WHERE project_id = @project_id AND state = 'pending' AND next_attempt_at <= ? AND attempts < ?
    ORDER BY next_attempt_at, created_at, id
    LIMIT 1
  `)
  const claimStmt = scope.prepare(`
    UPDATE wake_delivery SET
      state = 'leased', attempts = attempts + 1, lease_owner = @owner, lease_until = @leaseUntil,
      last_error = NULL, sent_at = NULL, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state = 'pending' AND next_attempt_at <= @now AND attempts < @maxAttempts
  `)
  // `claim` minus the due check — see `adopt` on the interface.
  const adoptStmt = scope.prepare(`
    UPDATE wake_delivery SET
      state = 'leased', attempts = attempts + 1, lease_owner = @owner, lease_until = @leaseUntil,
      last_error = NULL, sent_at = NULL, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state = 'pending' AND attempts < @maxAttempts
  `)
  const deferFailureStmt = scope.prepare(`
    UPDATE wake_delivery SET
      lease_until = @retryAt, last_error = @error, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state = 'leased' AND lease_owner = @owner
  `)
  const releaseStmt = scope.prepare(`
    UPDATE wake_delivery SET
      state = 'pending', attempts = MAX(attempts - 1, 0), lease_owner = NULL, lease_until = NULL,
      next_attempt_at = @retryAt, last_error = @error, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state = 'leased' AND lease_owner = @owner AND sent_at IS NULL
  `)
  const markSentStmt = scope.prepare(`
    UPDATE wake_delivery SET
      sent_at = @now, lease_until = @confirmUntil, last_error = NULL, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state = 'leased' AND lease_owner = @owner
  `)
  const recoverExpiredStmt = scope.prepare(`
    UPDATE wake_delivery SET
      state = CASE WHEN attempts >= @maxAttempts THEN 'exhausted' ELSE 'pending' END,
      next_attempt_at = @retryAt,
      lease_owner = NULL,
      lease_until = NULL,
      last_error = @error,
      updated_at = @now,
      terminal_at = CASE WHEN attempts >= @maxAttempts THEN @now ELSE NULL END
    WHERE project_id = @project_id AND id = @id AND state = 'leased' AND lease_until <= @now
  `)
  const acknowledgeStmt = scope.prepare(`
    UPDATE wake_delivery SET
      state = 'delivered', lease_owner = NULL, lease_until = NULL, last_error = NULL,
      delivered_at = @now, terminal_at = @now, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state = 'leased' AND lease_owner = @owner
  `)
  const confirmStmt = scope.prepare(`
    UPDATE wake_delivery SET
      state = 'delivered', lease_owner = NULL, lease_until = NULL, last_error = NULL,
      delivered_at = @now, terminal_at = @now, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state IN ('pending', 'leased')
  `)
  const supersedeStmt = scope.prepare(`
    UPDATE wake_delivery SET
      state = 'superseded', lease_owner = NULL, lease_until = NULL, last_error = @reason,
      terminal_at = @now, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state IN ('pending', 'leased')
  `)

  const enqueueTxn = db.transaction((input: WakeDeliveryInput, now: number) => {
    // The quiet window, applied at enqueue and carried by `next_attempt_at` so `claim`'s due check and
    // the durable-outbox invariants need no new state. Exempt keys are due at once; everything else is
    // due at once too unless the thread was handed a wake inside the window, in which case it waits for
    // the window to end — and is merged into whatever else waited with it when it does.
    let notBefore = now
    if (quietWindowMs > 0 && !isQuietWindowExempt(input.hintKey)) {
      const lastHandoff = lastHandoffStmt.get(input.slug)?.at ?? 0
      if (lastHandoff > 0) notBefore = Math.max(now, lastHandoff + quietWindowMs)
    }
    const created = insert.run({ ...input, now, notBefore }).changes === 1
    const row = byId.get(input.id)
    if (!row) throw new Error("wake delivery disappeared while it was being enqueued")
    if (
      row.thread_slug !== input.slug ||
      row.session_id !== input.sessionId ||
      row.fence_id !== input.fenceId ||
      row.hint_key !== input.hintKey ||
      row.message !== input.message ||
      row.reason !== input.reason
    ) {
      throw new Error(`wake delivery id collision for ${input.id}`)
    }
    const count = terminalCount.get()?.count ?? 0
    if (count > OUTBOX_CAP) pruneTerminal.run(count - OUTBOX_CAP)
    return { effect: created ? "created" as const : "existing" as const, delivery: delivery(row) }
  })

  const claimTxn = db.transaction((owner: string, now: number, leaseUntil: number, maxAttempts: number) => {
    const candidate = due.get(now, maxAttempts)
    if (!candidate) return undefined
    if (claimStmt.run({ id: candidate.id, owner, now, leaseUntil, maxAttempts }).changes !== 1) return undefined
    return delivery(byId.get(candidate.id)!)
  })
  const adoptTxn = db.transaction((id: string, owner: string, now: number, leaseUntil: number, maxAttempts: number) => {
    if (adoptStmt.run({ id, owner, now, leaseUntil, maxAttempts }).changes !== 1) return undefined
    return delivery(byId.get(id)!)
  })

  return {
    enqueue: (input, now) => enqueueTxn.immediate(input, now),
    get: (id) => {
      const row = byId.get(id)
      return row ? delivery(row) : undefined
    },
    list: () => all.all().map(delivery),
    listOpen: () => open.all().map(delivery),
    pendingFor: (slug, sessionId) => pendingForStmt.all(slug, sessionId).map(delivery),
    claim: (owner, now, leaseUntil, maxAttempts) => claimTxn.immediate(owner, now, leaseUntil, maxAttempts),
    adopt: (id, owner, now, leaseUntil, maxAttempts) => adoptTxn.immediate(id, owner, now, leaseUntil, maxAttempts),
    deferFailure: (id, owner, now, retryAt, error) => deferFailureStmt.run({
      id,
      owner,
      retryAt,
      error: error.slice(0, 500),
      now,
    }).changes === 1,
    release: (id, owner, now, retryAt, error) => releaseStmt.run({ id, owner, retryAt, error: error.slice(0, 500), now }).changes === 1,
    recoverExpired: (id, now, retryAt, maxAttempts, error) => {
      if (recoverExpiredStmt.run({ id, now, retryAt, maxAttempts, error: error.slice(0, 500) }).changes !== 1) return undefined
      const row = byId.get(id)
      return row ? delivery(row) : undefined
    },
    acknowledge: (id, owner, now) => acknowledgeStmt.run({ id, owner, now }).changes === 1,
    markSent: (id, owner, now, confirmUntil) => markSentStmt.run({ id, owner, now, confirmUntil }).changes === 1,
    confirm: (id, now) => confirmStmt.run({ id, now }).changes === 1,
    supersede: (id, now, reason) => supersedeStmt.run({ id, now, reason: reason.slice(0, 500) }).changes === 1,
  }
}
