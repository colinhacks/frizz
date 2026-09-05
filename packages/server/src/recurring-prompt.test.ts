// The stop hook's two SERVER-side invariants (scheduler.ts SOURCE 5), each of which is a way the
// feature could silently loop forever or silently stop:
//
//   1. the fold's sentinel lifecycle — ALLDONE only means "nothing actionable" while it is the FINAL
//      word, so a later message that omits it must re-open the loop by itself;
//   2. the row's GENERATION — editing the text supersedes a bump already queued for the old words,
//      while merely toggling off and on must NOT (that would re-send a bump the operator watched land).
//
// The end-to-end proof that a real agent is bumped at rest, bumped again at its NEXT rest, and left
// alone once it answers ALLDONE lives in backend/_live_recurring_prompt.mts — a live probe, not a unit
// test, because the only thing worth asserting there is what a real worker does.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyEvent, applyRecord, newTailState, type FenceView, type SessionTelemetry, type Tailer } from "./tailer.ts"
import { createScheduler } from "./scheduler.ts"

const assistant = (text: string, at = "2026-08-02T00:00:01.000Z") => ({
  type: "assistant",
  timestamp: at,
  message: { stop_reason: "end_turn", content: [{ type: "text", text }] },
})

test("fold: ALLDONE on the final assistant message sets the flag; the next message without it clears it", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, assistant("Checked the queue — nothing to pick up.\n\nALLDONE"))
  assert.equal(s.lastAssistantAllDone, true)
  // The loop re-opens purely from the fold: a later rest message that does not carry the sentinel is
  // an agent that has something to say again, and nothing had to be stored or cleared to notice.
  applyRecord(s, assistant("Actually the build just broke — looking at it.", "2026-08-02T00:00:02.000Z"))
  assert.equal(s.lastAssistantAllDone, false)
})

test("fold: any user record supersedes a standing ALLDONE — the operator's next word re-opens the loop", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, assistant("ALLDONE"))
  assert.equal(s.lastAssistantAllDone, true)
  applyRecord(s, {
    type: "user",
    timestamp: "2026-08-02T00:00:03.000Z",
    message: { content: [{ type: "text", text: "one more thing" }] },
  })
  assert.equal(s.lastAssistantAllDone, false)
})

// The normalized (codex) path folds the same fact off its own event union, so a codex thread must not
// be a thread whose stop hook can never be closed.
test("fold: the normalized event path derives ALLDONE from the final text too", () => {
  const s = newTailState("t", "sid", "/x")
  applyEvent(s, { kind: "turn-end", at: "2026-08-02T00:00:01.000Z", finalText: "Nothing to do here.\nALLDONE" })
  assert.equal(s.lastAssistantAllDone, true)
  applyEvent(s, { kind: "user-message", at: "2026-08-02T00:00:02.000Z", text: "go on", synthetic: false })
  assert.equal(s.lastAssistantAllDone, false)
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-stophook-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "stophook-t"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  return {
    storage, slug,
    row: () => storage.getSession(slug)!,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("storage: toggling off and on KEEPS the generation and the last-fired stamp", () => {
  const f = fixture()
  try {
    assert.equal(f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" }), true)
    const armedAt = f.row().recurring_armed_at
    assert.equal(armedAt, "2026-08-02T00:00:00.000Z")
    f.storage.stampRecurringRestFired(f.slug, armedAt!, "2026-08-02T00:05:00.000Z")

    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "keep going", stopHook: false, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:10:00.000Z" })
    assert.equal(f.row().recurring_on_rest, 0)
    assert.equal(f.row().recurring_armed_at, armedAt, "an off/on flip is not a re-arming")
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:11:00.000Z" })
    assert.equal(f.row().recurring_on_rest, 1)
    assert.equal(f.row().recurring_armed_at, armedAt)
    // The rate floor survives the flip too — otherwise toggling would be a way to bypass it.
    assert.equal(f.row().recurring_rest_fired_at, "2026-08-02T00:05:00.000Z")
  } finally {
    f.close()
  }
})

test("storage: EDITING the text mints a new generation and drops the last-fired stamp", () => {
  const f = fixture()
  try {
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" })
    f.storage.stampRecurringRestFired(f.slug, f.row().recurring_armed_at!, "2026-08-02T00:05:00.000Z")
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "do something else", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:10:00.000Z" })
    assert.equal(f.row().recurring_armed_at, "2026-08-02T00:10:00.000Z", "new words are a new generation")
    assert.equal(f.row().recurring_rest_fired_at, null, "and the new words have never fired")
  } finally {
    f.close()
  }
})

test("storage: a null prompt clears the whole row, and a stale session/generation writes nothing", () => {
  const f = fixture()
  try {
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" })
    assert.equal(
      f.storage.setRecurringPromptIfCurrent(f.slug, "other-sid", 0, { prompt: "hijack", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:01:00.000Z" }),
      false,
      "a tab looking at a superseded session fails closed",
    )
    assert.equal(f.row().recurring_prompt, "keep going")
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: null, stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:02:00.000Z" })
    assert.equal(f.row().recurring_prompt, null)
    assert.equal(f.row().recurring_armed_at, null)
    assert.equal(f.row().recurring_on_rest, 0, "a cleared row can never read as enabled")
  } finally {
    f.close()
  }
})

// ---- The worker's own path to the same row ------------------------------------------------------
// `mcp__frizz__goal` writes by SLUG ALONE, with no session/generation guard, because the MCP server
// cannot satisfy one: it is spawned with its thread's slug and keeps it across every resume while the
// session id bumps underneath. These pin that the unguarded path behaves identically to the operator's
// on everything EXCEPT the guard — same generation semantics, same clear.
test("storage: the worker path writes by slug alone, across a session change the operator path rejects", () => {
  const f = fixture()
  try {
    // A resume: the row now belongs to a new session and generation, exactly as after a restart.
    f.storage.upsertSession({
      slug: f.slug, session_id: "sid-2", thread_name: `frizz-${f.slug}`, spawned_at: new Date().toISOString(),
      last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
      title: f.slug, state: "open", meta: null, seen_at: null, transcript_id: null,
    } as SessionRow)

    // The operator path, holding the OLD session id, correctly fails closed.
    assert.equal(
      f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "stale tab", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" }),
      false,
      "a browser tab that has fallen behind must not write",
    )
    // The worker path, which only ever knew the slug, still reaches its own row.
    assert.equal(
      f.storage.setRecurringPromptBySlug(f.slug, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:01:00.000Z" }),
      true,
      "the tool must survive the resume it was armed before",
    )
    assert.equal(f.row().recurring_prompt, "keep going")
    assert.equal(f.row().recurring_on_rest, 1)
  } finally {
    f.close()
  }
})

test("storage: the worker path keeps the generation on a re-arm with the SAME text, and clears on null", () => {
  const f = fixture()
  try {
    f.storage.setRecurringPromptBySlug(f.slug, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" })
    const armedAt = f.row().recurring_armed_at
    f.storage.stampRecurringRestFired(f.slug, armedAt!, "2026-08-02T00:05:00.000Z")

    // A worker that re-registers on resume must not supersede a bump already queued for those words.
    f.storage.setRecurringPromptBySlug(f.slug, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:10:00.000Z" })
    assert.equal(f.row().recurring_armed_at, armedAt, "same text ⇒ same generation")
    assert.equal(f.row().recurring_rest_fired_at, "2026-08-02T00:05:00.000Z", "and the rate floor survives")

    // New words ARE a new generation, same as the operator path.
    f.storage.setRecurringPromptBySlug(f.slug, { prompt: "do something else", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:11:00.000Z" })
    assert.equal(f.row().recurring_armed_at, "2026-08-02T00:11:00.000Z")
    assert.equal(f.row().recurring_rest_fired_at, null)

    // `action: "stop"` — the worker ending its own loop deliberately.
    f.storage.setRecurringPromptBySlug(f.slug, { prompt: null, stopHook: false, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:12:00.000Z" })
    assert.equal(f.row().recurring_prompt, null)
    assert.equal(f.row().recurring_armed_at, null)
    assert.equal(f.row().recurring_on_rest, 0)
  } finally {
    f.close()
  }
})

// ---- The heartbeat, and what holds a bump ------------------------------------------------------
// The firing rule in full: a bump fires as soon as the thread RESTS, and firing starts a fixed timer;
// nothing fires again until it completes. These drive the REAL scheduler pass over REAL storage with
// only the tailer stubbed (it is the input being varied), and `now` injected so the clock is exact.
const HEARTBEAT_MS = 10 * 60_000

function scheduler(
  tele: Partial<SessionTelemetry>,
  opts: { lastFiredAt?: string; now?: () => number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-hb-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "hooked"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  // Frizz's built-in sign-off reminder (SOURCE 9) now fires on EVERY fenceless rest, independently of
  // the Goal — so it would add a second delivery to every count in this file. Silenced so these stay
  // about the Goal; the reminder has signoff-nudge.test.ts.
  storage.setSetting("signoffNudge", "off")
  storage.setRecurringPromptBySlug(slug, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" })
  if (opts.lastFiredAt) storage.stampRecurringRestFired(slug, storage.getSession(slug)!.recurring_armed_at!, opts.lastFiredAt)
  const delivered: string[] = []
  const s = createScheduler({
    // No quiet window here: this file pins its SOURCE, and hands one thread several wakes within a few
    // clock minutes. The window and the merge are pinned in scheduler.test.ts.
    wakeQuietWindowMs: 0,
    storage,
    ...(opts.now ? { now: opts.now } : {}),
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: "2026-08-02T00:00:00.000Z",
        // The AGENT spoke last — the shape of a real rest, and the one thing frizz cannot fake, since
        // frizz only ever speaks as the user. Without it the trigger cannot tell "you stopped" from
        // "nothing is happening", which is how a worker-less thread was bumped every tick.
        lastAssistantAt: "2026-08-02T00:00:00.000Z",
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
    // The awaiting poller runs on the same tick as the Goal, so a `pr-watch:` hint in any fence below
    // would otherwise shell out to `gh`. Stubbed to "reachable, nothing new", which is the state a
    // freshly parked PR watcher is actually in.
    fetchPr: async () => undefined,
    fetchGithubReview: async () => [],
  })
  // DELIVERIES FROM THE GOAL ALONE. `delivered` is every wake the scheduler sent, and on a rest the
  // scheduler is correcting, SOURCE 12 legitimately speaks too — so "the Goal held" has to be asked of
  // the Goal's own namespace rather than of an empty array. (It was asked of the empty array while
  // SOURCE 12 could not deliver at all, which made the weaker assertion look identical to this one.)
  const goalBumps = () => storage.db
    .prepare("SELECT message FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE 'stophook:%' AND state = 'delivered'")
    .all(slug) as { message: string }[]
  return { s, storage, slug, delivered, goalBumps, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const at = (iso: string) => () => Date.parse(iso)
// Every fence built here carries the REQUIRED `for:` unless a case overrides it — the 2026-08-15
// grammar treats a fence with no duration as not-a-park, which is a different thing from the thing most
// of these cases are about.
const awaiting = (...hints: FenceView["hints"]): FenceView =>
  ({ kind: "awaiting", body: "", hints: hints.length ? [...hints, { kind: "for" as const, value: "2h" }] : [] })
const child = (state: "running" | "stale" | "rested") =>
  ({ label: "worker", startedAt: "2026-08-02T00:00:00.000Z", state, id: `t-${state}` })

test("heartbeat: the FIRST rest after arming is bumped at once — nothing has fired yet", async () => {
  const h = scheduler({}, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /keep going/)
  } finally { h.close() }
})

// It fires on EVERY rest, with no floor of its own: "the stop hook is also pretty simple in that it
// fires whenever the agent rests. That's it." There is a natural limit anyway — producing a new rest
// costs the worker a whole turn, and one rest yields exactly one bump (the delivery id is bound to the
// thread's activity stamp), so it cannot spin faster than the agent can actually run.
test("stop hook: a second rest is bumped again immediately — no interval of its own", async () => {
  const first = scheduler({}, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await first.s.tick()
    assert.equal(first.delivered.length, 1)
  } finally { first.close() }

  // The same thread having just been bumped seconds ago, resting again: bumped again.
  const again = scheduler({}, { lastFiredAt: "2026-08-02T00:00:05.000Z", now: at("2026-08-02T00:00:20.000Z") })
  try {
    await again.s.tick()
    assert.equal(again.delivered.length, 1, "no floor holds a stop hook back")
  } finally { again.close() }
})

// Removed the same day it shipped (maintainer: "the status of any sub-agents or background shells is
// irrelevant"). The heartbeat is the whole rate story, and consulting child liveness is also what would
// stop this rescuing a thread parked behind a child that never reports.
test("heartbeat: live sub-agents and background shells are IRRELEVANT to firing", async () => {
  for (const state of ["running", "stale", "rested"] as const) {
    const h = scheduler({ subAgents: [child(state)] as SessionTelemetry["subAgents"] }, { now: at("2026-08-02T00:00:05.000Z") })
    try {
      await h.s.tick()
      assert.equal(h.delivered.length, 1, `a ${state} child must not hold the bump`)
    } finally { h.close() }
  }
  const shell = scheduler({
    bgShells: [{ label: "vite dev", startedAt: "2026-08-02T00:00:00.000Z", state: "running", id: "s1" }] as SessionTelemetry["bgShells"],
  }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await shell.s.tick()
    assert.equal(shell.delivered.length, 1, "a live shell must not hold the bump either")
  } finally { shell.close() }
})

// THE LOOP THIS TRIGGER SHIPPED WITH FOR MONTHS, and which only became dangerous when every dispatched
// thread started carrying a Goal. Frizz speaks as the USER, so its own bump lands in the transcript and
// advances `lastActivityAt` — the field the delivery id used to key on — minting a "rest" nobody rested.
// A thread whose worker is gone stays idle forever, so it was bumped every tick: 10 in 100 seconds,
// measured on a real stack. `turn === "idle"` cannot tell "you stopped" from "nothing is happening";
// only the agent having spoken LAST can.
test("a thread whose last word is frizz's own bump is not bumped again", async () => {
  const h = scheduler({
    lastAssistantAt: "2026-08-02T00:00:00.000Z",
    lastUserAt: "2026-08-02T00:00:30.000Z", // the bump landed after the agent's last word
    lastActivityAt: "2026-08-02T00:00:30.000Z",
  }, { now: at("2026-08-02T00:01:00.000Z") })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "it has not answered the last one yet")
  } finally { h.close() }
})

test("ALLDONE holds the bump for that rest only, and nothing is stored to undo", async () => {
  const held = scheduler({ lastAssistantAllDone: true }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await held.s.tick()
    assert.deepEqual(held.delivered, [])
  } finally { held.close() }

  // The same thread one rest later, having said something else: bumped as normal.
  const resumed = scheduler({ lastAssistantAllDone: false }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await resumed.s.tick()
    assert.equal(resumed.delivered.length, 1)
  } finally { resumed.close() }
})

// ---- The PARK (`parkedOnAWaitItCannotAdvance`) --------------------------------------------------
// THE LOOP THE MAINTAINER WATCHED, 2026-08-12, on the zod board. A worker parked on
// `pr-watch: colinhacks/zod#6382` was bumped 7 times in 46 minutes: each bump cost a whole turn whose
// only product was the same fence reworded, because "keep going" has no answer while a PR sits
// unreviewed. A second thread wrote `human: Colin to merge — the task barred me from merging` and was
// bumped anyway, until it took the only exit the trailer had ever shown it and signed off ```done on an
// unmerged PR. These pin both halves: the Goal does not bump a wait somebody else owns, and it still
// rescues a park nothing will ever fire.
test("an awaiting fence on a PR the scheduler is watching holds the bump", async () => {
  const h = scheduler({ lastFence: awaiting({ kind: "pr", value: "colinhacks/zod#6382" }) }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    // REGISTERED, which is what makes a wake actually coming. Since 2026-08-14 the fence line alone arms
    // nothing — `mcp__frizz__watch_pr` does — so the hold reads the registry rather than the hint.
    h.storage.armPrWatch({ id: "prw_1", slug: h.slug, owner: "colinhacks", repo: "zod", number: 6382, createdAtMs: 1, expiresAtMs: Date.parse("2099-01-01T00:00:00.000Z") })
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "the waker already owns this thread's next wake")
  } finally { h.close() }
})

// ---- The HEARTBEAT (scheduler SOURCE 4) ----------------------------------------------------------
// The dumb sibling. Everything the stop hook consults, this ignores — that is its entire contract, and
// these are the tests that would catch it quietly growing a condition.
function heartbeatScheduler(
  tele: Partial<SessionTelemetry>,
  opts: { intervalMs?: number; armedAt?: string; lastFiredAt?: string; now?: () => number; tailerMiss?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-beat-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "beating"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setSetting("signoffNudge", "off")
  storage.setRecurringPromptBySlug(slug, { prompt: "check the deploy", stopHook: false, heartbeat: true, postCompaction: false, intervalMs: opts.intervalMs ?? 3_600_000, armedAt: opts.armedAt ?? "2026-08-02T00:00:00.000Z" })
  if (opts.lastFiredAt) storage.stampRecurringScheduleFired(slug, storage.getSession(slug)!.recurring_armed_at!, opts.lastFiredAt)
  const delivered: string[] = []
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage,
    ...(opts.now ? { now: opts.now } : {}),
    tailer: {
      get: () => opts.tailerMiss ? undefined : ({
        turn: "idle", lastActivityAt: "2026-08-02T00:00:00.000Z",
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  return { s, storage, slug, delivered, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("heartbeat: nothing before the interval elapses, then the beat with its trailer", async () => {
  const early = heartbeatScheduler({}, { now: at("2026-08-02T00:30:00.000Z") })
  try {
    await early.s.tick()
    assert.deepEqual(early.delivered, [], "half an hour into an hourly beat")
  } finally { early.close() }

  const due = heartbeatScheduler({}, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await due.s.tick()
    assert.equal(due.delivered.length, 1)
    assert.ok(due.delivered[0].startsWith("check the deploy"), "the operator's text leads, verbatim")
    assert.match(due.delivered[0], /Goal — sent every 1h/, "and the trailer names the cadence")
    assert.match(due.delivered[0], /ONLY when the work is genuinely finished/, "and warns about the opt-out it offers")
  } finally { due.close() }
})

// The ONE thing that stops a beat. Everything else about this source is unconditional, but a worker
// that has declared there is no further work has ended the arrangement — and a run described as
// "permanently stalled" that keeps being woken every interval is not stalled at all.
test("heartbeat: ALLDONE suppresses a beat — it is the opt-out from BOTH sources", async () => {
  const h = heartbeatScheduler({ lastAssistantAllDone: true }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "the opt-out has to reach the clock, or it is not an opt-out")
  } finally { h.close() }
})

test("heartbeat: live sub-agents and background shells do not suppress a beat either", async () => {
  const h = heartbeatScheduler({
    subAgents: [{ label: "w", startedAt: "2026-08-02T00:00:00.000Z", state: "running", id: "t1" }] as SessionTelemetry["subAgents"],
    bgShells: [{ label: "vite", startedAt: "2026-08-02T00:00:00.000Z", state: "running", id: "s1" }] as SessionTelemetry["bgShells"],
  }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.ok(h.delivered[0].startsWith("check the deploy"))
  } finally { h.close() }
})

// THE POINT OF THE FEATURE (maintainer 2026-08-03: "my intention was for the heartbeat to fire on its
// regular cadence, regardless of whether the agent is currently running or not"). Every other wake
// source is held by the delivery gate until the thread rests; this one is not, because a beat that
// waits for a rest is a stop hook wearing a clock — and a thread that never stops never hears it.
test("heartbeat: a beat due MID-TURN is delivered mid-turn, not held until rest", async () => {
  const h = heartbeatScheduler({ turn: "in-flight" }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "a busy thread must not hold the beat back")
    assert.ok(h.delivered[0].startsWith("check the deploy"))
  } finally { h.close() }
})

// And the cadence is REAL after a mid-turn delivery: the clock stamps from the beat that landed, so the
// next one is due an interval later. Before this, a thread busy across several intervals collected one
// stale catch-up beat at its next rest and the operator's schedule described nothing.
test("heartbeat: a mid-turn beat advances the clock, so the schedule keeps running through a long turn", async () => {
  const h = heartbeatScheduler({ turn: "in-flight" }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.equal(
      h.storage.getSession(h.slug)!.recurring_schedule_fired_at !== null,
      true,
      "the beat that landed mid-turn is what the next interval is measured from",
    )
    // Still inside the same turn, still inside the same interval: no second beat.
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "the interval still governs — mid-turn is not a free-for-all")
  } finally { h.close() }
})

// The exception is scoped to the heartbeat's fence, not widened into "deliver to busy threads". A
// SNOOZE also queues without consulting rest (its pass deliberately does not filter on idle), and it
// must still be held: a human's scheduled bump is about a thread that stopped.
test("the mid-turn exception is the HEARTBEAT's alone — a due snooze is still held while busy", async () => {
  const h = heartbeatScheduler({ turn: "in-flight" }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: null, stopHook: false, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" })
    h.storage.setSnoozedUntil(h.slug, "2026-08-02T00:30:00.000Z", "back to it")
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "a snooze waits for the thread to come to rest, as it always did")
  } finally { h.close() }
})

// `unknown` telemetry is not a thread we can safely address, heartbeat or not — the exception is for a
// thread we can SEE is busy, never for one we cannot read at all.
test("heartbeat: a beat is still held when the thread's telemetry cannot be read", async () => {
  const h = heartbeatScheduler({}, { now: at("2026-08-02T01:00:00.000Z"), tailerMiss: true })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "no telemetry, no delivery")
  } finally { h.close() }
})

// SWITCHING A TRIGGER OFF MUST NOT DESTROY THE CADENCE. This shipped broken for an afternoon and was
// caught by opening the panel in a browser, not by a test: the footer omitted `intervalSeconds` from the
// write whenever the schedule trigger was off, storage cleared the column, and the panel came back
// showing the 10-minute default — so an operator's 30 was silently discarded the moment they parked it.
// Pinned at the storage level, which is where "off keeps the settings" actually has to be true.
test("recurring prompt: switching the schedule trigger OFF keeps the cadence for switching it back on", async () => {
  // The clock sits AFTER the re-arm plus one interval, so the last assertion is about the cadence
  // surviving rather than about how far the fixed clock happens to have advanced.
  const h = heartbeatScheduler({}, { now: at("2026-08-02T02:30:02.000Z") })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "check the deploy", stopHook: false, heartbeat: false, postCompaction: false, intervalMs: 1_800_000, armedAt: "2026-08-02T02:00:00.000Z" })
    const off = h.storage.getSession(h.slug)!
    assert.equal(off.recurring_on_schedule, 0, "the trigger is off")
    assert.equal(off.recurring_interval_ms, 1_800_000, "and the 30 minutes the operator chose is still there")
    assert.equal(off.recurring_prompt, "check the deploy", "as is the text")

    // Back on, at the SAME cadence, with no re-entry.
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "check the deploy", stopHook: false, heartbeat: true, postCompaction: false, intervalMs: 1_800_000, armedAt: "2026-08-02T02:00:01.000Z" })
    assert.equal(h.storage.getSession(h.slug)!.recurring_interval_ms, 1_800_000)
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "and it fires again on that cadence")
  } finally { h.close() }
})

test("heartbeat: a DISABLED heartbeat fires nothing but keeps its schedule and text", async () => {
  const h = heartbeatScheduler({}, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "check the deploy", stopHook: false, heartbeat: false, postCompaction: false, intervalMs: 3_600_000, armedAt: "2026-08-02T00:00:00.000Z" })
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
    const row = h.storage.getSession(h.slug)!
    assert.equal(row.recurring_prompt, "check the deploy", "the text survives the toggle")
    assert.equal(row.recurring_interval_ms, 3_600_000, "and so does the schedule")
  } finally { h.close() }
})

// The generation rule, which is what stops a re-arming worker from stacking beats or resetting its own
// clock on every resume.
test("heartbeat: the generation survives a bare toggle flip and is minted by a schedule change", async () => {
  const h = heartbeatScheduler({})
  try {
    const gen = h.storage.getSession(h.slug)!.recurring_armed_at
    h.storage.stampRecurringScheduleFired(h.slug, gen!, "2026-08-02T00:05:00.000Z")

    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "check the deploy", stopHook: false, heartbeat: false, postCompaction: false, intervalMs: 3_600_000, armedAt: "2026-08-02T02:00:00.000Z" })
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "check the deploy", stopHook: false, heartbeat: true, postCompaction: false, intervalMs: 3_600_000, armedAt: "2026-08-02T02:00:01.000Z" })
    assert.equal(h.storage.getSession(h.slug)!.recurring_armed_at, gen, "off/on is not a re-arming")
    assert.equal(h.storage.getSession(h.slug)!.recurring_schedule_fired_at, "2026-08-02T00:05:00.000Z", "so the clock is not reset either")

    // Same text, NEW schedule: a real change, so a new generation and a fresh clock.
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "check the deploy", stopHook: false, heartbeat: true, postCompaction: false, intervalMs: 900_000, armedAt: "2026-08-02T03:00:00.000Z" })
    assert.equal(h.storage.getSession(h.slug)!.recurring_armed_at, "2026-08-02T03:00:00.000Z")
    assert.equal(h.storage.getSession(h.slug)!.recurring_schedule_fired_at, null)

    // Clearing empties the row.
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: null, stopHook: false, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T04:00:00.000Z" })
    const cleared = h.storage.getSession(h.slug)!
    assert.equal(cleared.recurring_prompt, null)
    assert.equal(cleared.recurring_armed_at, null)
    assert.equal(cleared.recurring_interval_ms, null)
  } finally { h.close() }
})

// ---- POST-COMPACTION (scheduler SOURCE 7) --------------------------------------------------------
// The trigger that replaced a worker-side hook splicing a canonical scratchpad into the emptied window.
// Its contract is narrow and every clause of it is load-bearing: it fires on a compaction NEWER than the
// arming, exactly once per compaction, and — unlike the rest trigger — it does not wait for the thread
// to stop, because a compaction happens while the worker is still working.
function compactScheduler(
  tele: Partial<SessionTelemetry>,
  opts: { armedAt?: string; now?: () => number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-compact-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "compacting"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setSetting("signoffNudge", "off")
  storage.setRecurringPromptBySlug(slug, {
    prompt: "Re-read .frizz/threads/sid/plan.md before continuing",
    stopHook: false, heartbeat: false, postCompaction: true,
    intervalMs: null, armedAt: opts.armedAt ?? "2026-08-02T00:00:00.000Z",
  })
  const delivered: string[] = []
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage,
    ...(opts.now ? { now: opts.now } : {}),
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: "2026-08-02T00:00:00.000Z",
        // The AGENT spoke last — the shape of a real rest, and the one thing frizz cannot fake, since
        // frizz only ever speaks as the user. Without it the trigger cannot tell "you stopped" from
        // "nothing is happening", which is how a worker-less thread was bumped every tick.
        lastAssistantAt: "2026-08-02T00:00:00.000Z",
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  return { s, storage, slug, delivered, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("post-compaction: a compaction after arming delivers the linked doc, once, with its own trailer", async () => {
  const h = compactScheduler({ lastCompactionAt: "2026-08-02T01:00:00.000Z" })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /Re-read \.frizz\/threads\/sid\/plan\.md before continuing/)
    // The trailer is what tells the worker WHERE it is; the rest trigger's "sent each time you come to
    // rest" would be a lie here, and the chat parses these two apart into different dividers.
    assert.match(h.delivered[0], /your context was just compacted/)
    // The SAME compaction never fires twice, however many ticks run over it.
    await h.s.tick()
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "one delivery per compaction, not per tick")
  } finally { h.close() }
})

test("post-compaction: a SECOND compaction fires again, and the stamp reads back for the panel", async () => {
  let compactedAt = "2026-08-02T01:00:00.000Z"
  const h = compactScheduler({ get lastCompactionAt() { return compactedAt } } as Partial<SessionTelemetry>)
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.ok(h.storage.getSession(h.slug)!.recurring_compact_fired_at, "the panel's last-sent readout")
    compactedAt = "2026-08-02T02:00:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 2, "a new compaction is a new event")
  } finally { h.close() }
})

// The case that would otherwise make switching the toggle on feel broken-in-reverse: a thread that
// compacted an hour ago is the COMMON case, and delivering for an event the operator never saw is not
// what "send it when my context is compacted" asked for.
test("post-compaction: a compaction that PREDATES the arming never fires", async () => {
  const h = compactScheduler(
    { lastCompactionAt: "2026-08-01T12:00:00.000Z" },
    { armedAt: "2026-08-02T00:00:00.000Z" },
  )
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// THE ONE PLACE IT PARTS COMPANY WITH THE REST TRIGGER. A compaction lands mid-turn, and a re-grounding
// that waits for the worker to stop has missed the window it was written for.
test("post-compaction: it fires MID-TURN, where the rest trigger would hold", async () => {
  const busy = compactScheduler({ turn: "in-flight", lastCompactionAt: "2026-08-02T01:00:00.000Z" })
  try {
    await busy.s.tick()
    assert.equal(busy.delivered.length, 1, "a busy thread is exactly the one that needs re-grounding")
  } finally { busy.close() }

  // ...and the rest trigger genuinely does hold on the same telemetry, which is what makes this a
  // difference in the scheduler rather than in this test's setup.
  const resting = scheduler({ turn: "in-flight" })
  try {
    await resting.s.tick()
    assert.deepEqual(resting.delivered, [], "the rest trigger waits for rest")
  } finally { resting.close() }
})

// Switching it off must drop a delivery the outbox is still holding — the same supersession rule its two
// siblings follow, and the reason an operator's "off" is immediate rather than one-more-time.
test("post-compaction: switching the trigger off supersedes a queued delivery", async () => {
  const h = compactScheduler({ lastCompactionAt: "2026-08-02T01:00:00.000Z" })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, {
      prompt: "Re-read .frizz/threads/sid/plan.md before continuing",
      stopHook: false, heartbeat: false, postCompaction: false,
      intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z",
    })
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// ---- A PENDING QUESTION HOLDS NOTHING ------------------------------------------------------------
// The stop hook asks a thread "you stopped — is there more?", and a ```question fence used to be read as
// an answer to it: there is more, and it needs the human. That reading was switchable — the panel showed
// a `pause_on_questions` column inverted as "Autonomous mode" — and on 2026-08-16 the switch AND the
// reading went, so every trigger now fires while the thread is waiting on a human, by any means.
//
// Maintainer: "the stop hook should just fire even when there are open questions, unconditionally, and we
// could just drop the AutonomousMode toggle… If somebody enables the stop hook goal, then that kind of
// implies to me that they don't really want to answer any more questions."
//
// WHAT SURVIVES is the fence rule and only the fence rule: a ```done, or an ```awaiting on a wake frizz
// itself will deliver, still holds the stop hook — pinned by the test below, which is also this section's
// failing control. Without it these tests would pass against a scheduler that had simply started firing
// at everything.
const nativeAsk = { id: "ask-1", questions: [{ question: "Which one?", header: "Pick", multiSelect: false, options: [] }] } as SessionTelemetry["pendingAsk"]

// The maintainer's report, 2026-08-14: a thread with a Goal armed at rest came to rest on a ```question
// and was never bumped. It was a settings-dependent bug then; it is unconditional behaviour now.
test("stop hook: a rest that ends in a question fence is bumped", async () => {
  const asking = scheduler({ pendingQuestion: true }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await asking.s.tick()
    assert.equal(asking.delivered.length, 1, "an armed Goal is the operator saying they are not coming to answer it")
    // And the delivery is WORDED for it. Handed the bare goal on top of its own unanswered question, the
    // honest move for a worker is to ask again — which is the duplicate card the old hold existed to
    // prevent, so the crossing has to say that no answer is coming.
    assert.match(asking.delivered[0], /not waiting\s+to answer it/)
    assert.match(asking.delivered[0], /Do NOT re-ask it/)
  } finally { asking.close() }
})

// The extra clause is for the crossing ONLY. A worker bumped on an ordinary rest is mid-work and has no
// question outstanding; telling it not to re-ask one would be frizz inventing a state it is not in.
test("stop hook: an ordinary rest is bumped with the plain trailer", async () => {
  const quiet = scheduler({ pendingQuestion: false }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await quiet.s.tick()
    assert.equal(quiet.delivered.length, 1)
    assert.doesNotMatch(quiet.delivered[0], /Do NOT re-ask it/)
  } finally { quiet.close() }
})

// THE FENCE RULE IS UNTOUCHED, and this is the section's failing control: `done` is the loop's off switch,
// and a park on a wake frizz itself will deliver is a duplicate wake rather than a rescue. Neither became
// negotiable when the question hold was deleted — they answer the trigger's own question rather than
// saying who is waiting on whom.
test("stop hook: dropping the question hold does NOT reopen the done fence or a scheduler-owned park", async () => {
  const done = scheduler({ lastFence: { kind: "done", body: "shipped", hints: [] }, pendingQuestion: false }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await done.s.tick()
    assert.deepEqual(done.delivered, [], "a finished thread is finished")
  } finally { done.close() }

  // A REAL park: the fence names a shell this thread actually has running, so frizz can see the wait is
  // honest. (It used to name a `human:` gate — that kind is deleted, and a name matching nothing live is
  // no longer a park at all, so the case has to be built out of something checkable.)
  const parked = scheduler({
    lastFence: awaiting({ kind: "shell", value: "bzvtnt3ig" }),
    bgShells: [{ label: "the suite", startedAt: "2026-08-02T00:00:00.000Z", state: "running", id: "toolu_x", taskId: "bzvtnt3ig" }],
    pendingQuestion: false,
  }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await parked.s.tick()
    assert.deepEqual(parked.delivered, [], "bumping a park frizz can verify is measured harm")
  } finally { parked.close() }
})

// THE VERB IS THE FENCE'S EQUAL HERE, and it has to be. Since 2026-08-27 a worker signs off by calling
// `mcp__frizz__done`, and a tool call cannot write the tailer's `lastFence` — so without the registry
// read in `threadSaidDone` the arrangement outlived the sign-off it exists to end, and a worker that
// used the verb instead of the fence was woken at every rest forever by a Goal it had finished with.
test("stop hook: a REGISTERED done ends the arrangement exactly as the fence does", async () => {
  const h = scheduler({ pendingQuestion: false }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    h.storage.markThreadDone(h.slug, "- **Shipped** it", Date.parse("2026-08-02T00:00:01.000Z"))
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "a thread that CALLED done is as finished as one that fenced it")
  } finally { h.close() }

  // And it reopens on the human's next word, by the same "nothing newer from the human" rule the board
  // reads it by — otherwise a completion would silence a thread the human has since sent more work to.
  // The human spoke at :02 and the worker answered at :03, so this IS a rest — the ordering matters,
  // because a thread whose LAST word is the human's is not resting and the trigger holds for that
  // reason instead, which would have made this pass for the wrong one.
  const reopened = scheduler(
    { pendingQuestion: false, lastUserAt: "2026-08-02T00:00:02.000Z", lastAssistantAt: "2026-08-02T00:00:03.000Z", lastActivityAt: "2026-08-02T00:00:03.000Z" },
    { now: at("2026-08-02T00:00:05.000Z") },
  )
  try {
    reopened.storage.markThreadDone(reopened.slug, "- **Shipped** it", Date.parse("2026-08-02T00:00:01.000Z"))
    await reopened.s.tick()
    assert.equal(reopened.delivered.length, 1, "new work from the human spends the completion")
  } finally { reopened.close() }
})

// RE-ARMING THE GOAL IS NEW WORK FROM THE HUMAN, and it was the one form of it the sign-off reading
// could not see: `threadSaidDone` dates the human's last word off the TRANSCRIPT, and arming writes no
// transcript record. So a human who armed a Goal on a thread that had already signed off got a panel
// reading "Goal (on)" over a trigger that could never fire, with nothing in the UI saying why and no way
// out but to type a message. Observed 2026-09-05 on `design-nub-static-server` — the worker registered a
// done at 23:00:44Z, the human re-armed at 23:20:54Z, and the thread sat there reading as frozen.
test("stop hook: a Goal armed AFTER the sign-off reopens the loop; one armed before it does not", async () => {
  // THE FAILING CONTROL, and the property that keeps the loop terminable: the ordinary case is a worker
  // signing off under a Goal armed long before, and that done still ends the arrangement.
  const before = scheduler({ pendingQuestion: false }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    before.storage.markThreadDone(before.slug, "- **Shipped** it", Date.parse("2026-08-02T00:00:01.000Z"))
    await before.s.tick()
    assert.deepEqual(before.delivered, [], "the arm predates the done, so the done still stands")
  } finally { before.close() }

  const after = scheduler({ pendingQuestion: false }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    after.storage.markThreadDone(after.slug, "- **Shipped** it", Date.parse("2026-08-02T00:00:01.000Z"))
    // New words mint a new generation — the operator re-arming the Goal after reading the done card.
    after.storage.setRecurringPromptBySlug(after.slug, { prompt: "keep going, there is more", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:00:02.000Z" })
    await after.s.tick()
    assert.equal(after.delivered.length, 1, "arming after the sign-off is the human reopening the loop")
    assert.match(after.delivered[0], /keep going, there is more/)
  } finally { after.close() }

  // And the FENCED sign-off obeys the same rule, dated by the message that carries it: the fence has no
  // instant of its own, so the arm is compared against the final assistant word it rides on.
  const fenced = scheduler(
    { pendingQuestion: false, lastFence: { kind: "done", body: "shipped", hints: [] }, lastAssistantAt: "2026-08-02T00:00:01.000Z", lastActivityAt: "2026-08-02T00:00:01.000Z" },
    { now: at("2026-08-02T00:00:05.000Z") },
  )
  try {
    await fenced.s.tick()
    assert.deepEqual(fenced.delivered, [], "the arm predates the fence")
    fenced.storage.setRecurringPromptBySlug(fenced.slug, { prompt: "keep going, there is more", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-02T00:00:02.000Z" })
    await fenced.s.tick()
    assert.equal(fenced.delivered.length, 1, "a fenced done reopens on a later arm too")
  } finally { fenced.close() }
})

// The BEAT reads the same sign-off, so it takes the same reopening — an operator who re-arms an hourly
// Goal on a finished thread means it to beat again.
test("heartbeat: a Goal armed after the sign-off beats again", async () => {
  const silenced = heartbeatScheduler({ lastFence: { kind: "done", body: "shipped", hints: [] } }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await silenced.s.tick()
    assert.deepEqual(silenced.delivered, [], "a done thread is not beaten")
  } finally { silenced.close() }

  // The clock is read past the re-arm plus the interval, because a new generation restarts the beat's
  // own countdown from the instant it was armed.
  const rearmed = heartbeatScheduler(
    { lastFence: { kind: "done", body: "shipped", hints: [] }, lastAssistantAt: "2026-08-02T00:00:00.000Z" },
    { now: at("2026-08-02T01:00:05.000Z") },
  )
  try {
    rearmed.storage.setRecurringPromptBySlug(rearmed.slug, { prompt: "check the deploy again", stopHook: false, heartbeat: true, postCompaction: false, intervalMs: 3_600_000, armedAt: "2026-08-02T00:00:01.000Z" })
    await rearmed.s.tick()
    assert.equal(rearmed.delivered.length, 1, "the re-arm outranks the sign-off it was written over")
  } finally { rearmed.close() }
})

// The other three ways a thread waits on a human. None of them is a fence, none of them ever held the
// stop hook by itself, and there is no longer a setting that makes any of them hold it.
test("stop hook: a native ask, a permission prompt and a pending question all fire", async () => {
  for (const [what, tele] of [
    ["a native ask", { pendingAsk: nativeAsk }],
    ["a permission prompt", { permPrompt: true }],
    ["a question fence", { pendingQuestion: true }],
  ] as const) {
    const h = scheduler(tele, { now: at("2026-08-02T00:00:05.000Z") })
    try {
      await h.s.tick()
      assert.equal(h.delivered.length, 1, `${what} does not hold the stop hook`)
    } finally { h.close() }
  }
})

// The heartbeat is the trigger that consults NOTHING — rest, sub-agents, shells, questions, all
// irrelevant. Only a ```done fence silences it, and that is pinned elsewhere in this file.
test("a pending question does not suppress the HEARTBEAT", async () => {
  const fenced = heartbeatScheduler({ pendingQuestion: true }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await fenced.s.tick()
    assert.equal(fenced.delivered.length, 1, "the beat asks a different question")
  } finally { fenced.close() }
})

// Nor post-compaction, which asks a third question again — "your context is gone" — that an unanswered
// question answers least of all.
test("a pending question does not suppress POST-COMPACTION", async () => {
  const h = compactScheduler({ lastCompactionAt: "2026-08-02T01:00:00.000Z", pendingQuestion: true })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "a compaction does not wait for an answer")
  } finally { h.close() }
})

// A SIGNED-OUT PROVIDER answers in milliseconds, so the auth failure is a real assistant message and
// therefore a real rest — which satisfies every other guard. Measured on a live stack: the bump fired
// ten times in a hundred seconds against a thread whose worker could only ever reply "Not logged in".
// Re-prompting cannot help; the thread already cards its auth fault and the sign-in recovery.
test("an auth-faulted thread is never re-prompted — the Goal cannot fix a signed-out provider", async () => {
  const h = scheduler({ authFault: "authentication_rejected" } as never)
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// AND THE GENERAL CASE OF IT (PR #26). A failed turn of ANY kind — a context-window 400, a 500, a dropped
// connection — is written as a synthetic assistant record, so it advances the rest instant: a fresh
// `stopHookFenceId` per failure, which is exactly what defeats the per-rest dedupe. This trigger has NO
// cap of its own (the sign-off reminder's SIGNOFF_NUDGE_MAX has no counterpart here), so before the
// guard a thread with an armed Goal whose every turn failed was bumped once per tick indefinitely — and
// on a context-window 400 each bump is what keeps the conversation over the limit. The control below is
// the same thread WITHOUT the fault: the advancing rest instant must draw a bump, or this assertion is
// vacuous.
test("a thread whose every turn fails is never re-prompted — the Goal has no cap, so the guard is the bound", async () => {
  // One clock for both threads: each tick is a fresh failed turn, read through the getter every time
  // the stub is consulted (the harness re-spreads it per `get()`).
  let failedAt = "2026-08-02T00:01:00.000Z"
  const faulted = scheduler({ apiFault: true, get lastAssistantAt() { return failedAt } } as Partial<SessionTelemetry>)
  const control = scheduler({ get lastAssistantAt() { return failedAt } } as Partial<SessionTelemetry>)
  try {
    for (let i = 2; i <= 21; i++) {
      await faulted.s.tick()
      await control.s.tick()
      failedAt = `2026-08-02T00:${String(i).padStart(2, "0")}:00.000Z`
    }
    assert.deepEqual(faulted.delivered, [], "twenty consecutive failed turns draw no Goal bump")
    assert.equal(control.delivered.length, 20, "the control: without the fault, every new rest instant is a bump — the loop this guard closes")
  } finally { faulted.close(); control.close() }
})
// THE GOAL NO LONGER BUMPS AN UNFIREABLE AWAITING FENCE, and two tests that pinned the opposite were
// removed here (2026-08-17). It was not a rescue, it was a LOOP: the Goal's text is a generic "keep
// going" that says nothing about fence grammar, so a worker whose fence could not be honoured re-wrote
// the same dead fence every ~6 seconds. That correction belongs to scheduler SOURCE 12, whose message
// names what is wrong and which tool fixes it — covered in declared-park.test.ts, which asserts the
// nameless and dead-item bumps directly.

// AN UNHONOURABLE AWAITING FENCE STILL HOLDS THE GOAL — and this is the fix for a measured LOOP, not a
// tidiness rule (2026-08-17, thread `we-need-to-unify-some-development`).
//
// A worker on the OLD contract wrote `pr-watch: pullfrog/app#1221`, a kind the grammar cut deleted. Zero
// hints parse, so the park could never be honoured, so the Goal's stop hook fired ~6 seconds after every
// rest — three identical fences in 40 seconds, each re-writing the same dead line, because the Goal's
// text is a generic "keep going" that says nothing about fence grammar.
//
// The scheduler owns an awaiting rest in BOTH directions: honoured needs nothing, unhonourable gets
// SOURCE 12, whose message names exactly what is wrong and which tool fixes it. So the Goal holds either
// way, and the worker hears the one voice that can get it out.
test("an awaiting fence the scheduler cannot honour STILL holds the Goal — SOURCE 12 owns that rest", async () => {
  // The exact shape: a deleted kind, so the tailer parses NO hints and the body carries the prose.
  const deadKind = { kind: "awaiting" as const, body: "Drift check re-run: CI green. #1221 needs your merge click.", hints: [] }
  const h = scheduler({ lastFence: deadKind, pendingQuestion: false }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await h.s.tick()
    assert.deepEqual(h.goalBumps(), [], "the Goal must not bump a rest the scheduler is already correcting")
    // …and the correcting voice DOES speak, which is the half of the arrangement that makes holding the
    // Goal safe rather than silencing.
    assert.equal(h.delivered.length, 1, "SOURCE 12 owns the rest — it must actually take it")
    assert.match(h.delivered[0], /names nothing to wait on/)
  } finally { h.close() }
})

// …and the honoured park keeps holding it, which is the case that always worked.
test("an honoured park holds the Goal too", async () => {
  const h = scheduler({
    lastFence: awaiting({ kind: "shell", value: "bzvtnt3ig" }),
    bgShells: [{ label: "the suite", startedAt: "2026-08-02T00:00:00.000Z", state: "running", id: "toolu_x", taskId: "bzvtnt3ig" }],
    pendingQuestion: false,
  }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "an honest park is not interrupted")
  } finally { h.close() }
})
