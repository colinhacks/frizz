import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { createScheduler } from "./scheduler.ts"
import type { Tailer, SessionTelemetry } from "./tailer.ts"

// ---- THE ONE-OFF TIMER (scheduler SOURCE 6) ------------------------------------------------------
// A worker's own alarm clock: text handed back at ONE instant, once. These drive the REAL scheduler
// pass over REAL storage with only the tailer stubbed (it is the input being varied) and `now`
// injected, exactly as the recurring-prompt tests do.
//
// The three properties worth pinning, because each is a deliberate DIFFERENCE from a sibling source:
//   - it fires MID-TURN (the heartbeat's gate, not the snooze's) — a promise for 15:00 kept at 15:50 is
//     not the feature that was asked for;
//   - it fires EXACTLY ONCE, and the guarantee lives on the row (`state`), not on the outbox, whose
//     terminal rows are pruned past a cap;
//   - a thread may hold MANY, which is why they are a table at all.

const SLUG = "alarmed"
const T0 = "2026-08-04T12:00:00.000Z"

function fixture(tele: Partial<SessionTelemetry> = {}, opts: { now?: string; archived?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-timer-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  // Frizz's built-in sign-off nudge (scheduler SOURCE 9) fires on any FENCELESS rest with no Goal stop
  // hook armed, which every thread in this harness is. Silenced so each test counts only the deliveries
  // it is about; the nudge has its own file.
  storage.setSetting("signoffNudge", "off")
  storage.upsertSession({
    slug: SLUG, session_id: "sid", thread_name: `frizz-${SLUG}`, spawned_at: T0,
    last_read_at: null, unread: 0, exited: 0, archived: opts.archived ? 1 : 0, rested_at: null,
    title_auto: 1, title: SLUG, state: opts.archived ? "archived" : "open", meta: null, seen_at: null,
    transcript_id: null,
  } as SessionRow)
  const delivered: string[] = []
  const s = createScheduler({
    // No quiet window here: this file pins its SOURCE, and hands one thread several wakes within a few
    // clock minutes. The window and the merge are pinned in scheduler.test.ts.
    wakeQuietWindowMs: 0,
    storage,
    now: () => Date.parse(opts.now ?? T0),
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: T0,
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  const arm = (id: string, fireAt: string, prompt = "check the deploy") => storage.armThreadTimer({
    id, slug: SLUG, prompt, fireAtMs: Date.parse(fireAt), createdAtMs: Date.parse(T0),
  })
  return {
    storage, s, delivered, arm,
    armed: () => storage.listThreadTimers(SLUG, { armedOnly: true }),
    close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("storage: timers are many per thread, cancel is slug-scoped, and firing is one-way", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-timer-store-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  // Frizz's built-in sign-off nudge (scheduler SOURCE 9) fires on any FENCELESS rest with no Goal stop
  // hook armed, which every thread in this harness is. Silenced so each test counts only the deliveries
  // it is about; the nudge has its own file.
  storage.setSetting("signoffNudge", "off")
  try {
    for (const slug of ["mine", "yours"]) {
      storage.upsertSession({
        slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: T0,
        last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
        title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
      } as SessionRow)
    }
    const arm = (id: string, slug: string, fireAt: string) =>
      storage.armThreadTimer({ id, slug, prompt: `p-${id}`, fireAtMs: Date.parse(fireAt), createdAtMs: Date.parse(T0) })
    arm("a", "mine", "2026-08-04T12:10:00.000Z")
    arm("b", "mine", "2026-08-04T12:05:00.000Z")
    arm("c", "yours", "2026-08-04T12:01:00.000Z")

    // MANY per thread, ordered by deadline — the whole reason this is a table.
    assert.deepEqual(storage.listThreadTimers("mine", { armedOnly: true }).map((t) => t.id), ["b", "a"])
    assert.deepEqual(storage.dueThreadTimers(Date.parse("2026-08-04T12:06:00.000Z")).map((t) => t.id), ["c", "b"])

    // A worker can only ever cancel its OWN, even holding another thread's id.
    assert.equal(storage.cancelThreadTimer("mine", "c", Date.parse(T0)), false)
    assert.equal(storage.getThreadTimer("c")?.state, "armed")
    assert.equal(storage.cancelThreadTimer("mine", "b", Date.parse(T0)), true)
    assert.equal(storage.getThreadTimer("b")?.state, "cancelled")

    // Both terminal states are one-way: a cancelled timer never becomes fired, and vice versa.
    assert.equal(storage.markThreadTimerFired("b", Date.parse(T0)), false, "a cancelled timer cannot fire")
    assert.equal(storage.markThreadTimerFired("a", Date.parse(T0)), true)
    assert.equal(storage.cancelThreadTimer("mine", "a", Date.parse(T0)), false, "a fired timer cannot be cancelled")

    // Forgetting a thread takes its alarms with it — nothing is left to wake a session that is gone.
    storage.forgetSession("mine")
    assert.deepEqual(storage.listThreadTimers("mine"), [])
    assert.equal(storage.getThreadTimer("c")?.state, "armed", "another thread's timers are untouched")
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a due timer is delivered VERBATIM, with a trailer naming its instant", async () => {
  const f = fixture({}, { now: "2026-08-04T12:00:30.000Z" })
  try {
    f.arm("tmr_1", "2026-08-04T12:00:20.000Z", "re-read the CI log")
    await f.s.tick()
    assert.equal(f.delivered.length, 1)
    assert.match(f.delivered[0], /^re-read the CI log\n\n\(One-off timer, set for 2026-08-04T12:00:20\.000Z\./)
    assert.equal(f.storage.getThreadTimer("tmr_1")?.state, "fired")
    assert.deepEqual(f.armed(), [], "a fired timer leaves nothing armed to clean up")
  } finally { f.close() }
})

// The gate that distinguishes this source from the snooze. A snooze bump waits for rest because it is
// answering a question about a thread that stopped; an alarm is obeying an instruction with an instant
// in it, and holding it until rest would silently turn "in ten minutes" into "whenever you next stop".
test("a timer fires MID-TURN — a busy thread is not a reason to hold it", async () => {
  const f = fixture({ turn: "in-flight" }, { now: "2026-08-04T12:00:30.000Z" })
  try {
    f.arm("tmr_busy", "2026-08-04T12:00:20.000Z")
    await f.s.tick()
    assert.equal(f.delivered.length, 1, "a mid-turn thread still gets its alarm")
  } finally { f.close() }
})

// ALLDONE ends a RECURRING arrangement, which is an infinite bump generator. A one-off has exactly one
// delivery in it, so there is nothing to end — and a worker that scheduled an alarm and then said
// "nothing further right now" still wants the alarm.
test("ALLDONE does not silence a one-off timer", async () => {
  const f = fixture({ lastAssistantAllDone: true }, { now: "2026-08-04T12:00:30.000Z" })
  try {
    f.arm("tmr_done", "2026-08-04T12:00:20.000Z")
    await f.s.tick()
    assert.equal(f.delivered.length, 1)
  } finally { f.close() }
})

test("a timer that is not due yet does not fire, and a cancelled one never does", async () => {
  const f = fixture({}, { now: "2026-08-04T12:00:30.000Z" })
  try {
    f.arm("tmr_later", "2026-08-04T13:00:00.000Z")
    f.arm("tmr_gone", "2026-08-04T12:00:10.000Z")
    f.storage.cancelThreadTimer(SLUG, "tmr_gone", Date.parse(T0))
    await f.s.tick()
    assert.deepEqual(f.delivered, [])
  } finally { f.close() }
})

// The one-shot guarantee has to survive the outbox, not depend on it: terminal delivery rows are pruned
// past a cap, so if `state` were not the record, an old alarm would ring again months later.
test("a fired timer is never delivered twice, on any later tick", async () => {
  const f = fixture({}, { now: "2026-08-04T12:00:30.000Z" })
  try {
    f.arm("tmr_once", "2026-08-04T12:00:20.000Z")
    await f.s.tick()
    await f.s.tick()
    await f.s.tick()
    assert.equal(f.delivered.length, 1)
  } finally { f.close() }
})

test("several due timers all fire, each with its own text — in ONE delivery", async () => {
  const f = fixture({}, { now: "2026-08-04T12:30:00.000Z" })
  try {
    f.arm("tmr_a", "2026-08-04T12:10:00.000Z", "first thing")
    f.arm("tmr_b", "2026-08-04T12:20:00.000Z", "second thing")
    await f.s.tick()
    // Two alarms due in the same tick are two independent promises, and since 2026-09-03 they ride in
    // one delivery (scheduler.deliverDue's merge): a turn is the expensive unit, and what matters is that
    // both texts went out intact and both rows settled.
    assert.equal(f.delivered.length, 1)
    assert.match(f.delivered[0], /first thing/)
    assert.match(f.delivered[0], /second thing/)
    assert.deepEqual(f.armed(), [])
  } finally { f.close() }
})

// An archived thread has nothing to wake. The row deliberately stays ARMED rather than being settled:
// the thread can be reopened, and the alarm is still the worker's own outstanding intent.
test("an archived thread is skipped, and its timer is left armed rather than burned", async () => {
  const f = fixture({}, { now: "2026-08-04T12:00:30.000Z", archived: true })
  try {
    f.arm("tmr_shelved", "2026-08-04T12:00:20.000Z")
    await f.s.tick()
    assert.deepEqual(f.delivered, [])
    assert.equal(f.storage.getThreadTimer("tmr_shelved")?.state, "armed")
  } finally { f.close() }
})

// The snooze pass's rule, for the same reason: the row IS the durable registration, so "you asked to be
// woken at 15:00" does not stop being true because the server was restarted at 14:59.
test("an alarm that came due while frizz was down still fires when it comes back", async () => {
  const f = fixture({}, { now: "2026-08-05T09:00:00.000Z" })
  try {
    f.arm("tmr_stale", "2026-08-04T12:05:00.000Z", "the deploy finished hours ago")
    await f.s.tick()
    assert.equal(f.delivered.length, 1)
  } finally { f.close() }
})
