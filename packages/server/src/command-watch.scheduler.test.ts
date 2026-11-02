// SOURCE 13 — the scheduler's half of a command watch, with an injected clock and an injected runner.
// Plus the two readings that make a rest on one a real park: the integrity check (SOURCE 12) and the
// board's queue rule.
//
// Every wake below is asserted DELIVERED (`resume` ran), not merely queued: a new wake prefix with no
// deliveryContext branch is silently superseded, and its enqueue-side tests stay green (scheduler.ts,
// the comment above the `park:` branch).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NEEDS_INPUT_REQUIRED_AT, parseCommandWatchWake } from "@frizz/shared"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import { createScheduler, MID_TURN_HOLD_MAX_MS } from "./scheduler.ts"
import { WAKE_QUIET_WINDOW_MS } from "./wake-store.ts"
import { deriveAwaitingBackground, deriveNeedsYou, deriveWaitStatus } from "./board.ts"
import { parkForMaxMs, readAwaitingPark } from "./awaiting.ts"
import type { CommandRunResult, CommandWatchService } from "./command-watch.ts"
import type { FenceView, SessionTelemetry, Tailer, TurnState } from "./tailer.ts"

const T0 = Date.parse("2026-10-11T12:00:00.000Z")
// Which wake a delivery is, and for which watch. The parse also carries what the chat discloses; that
// half is pinned beside the composers in packages/shared.
const wakeHead = (message: string) => {
  const wake = parseCommandWatchWake(message)
  return wake && { kind: wake.kind, id: wake.id }
}
const NEW_CONTRACT = new Date(Date.parse(NEEDS_INPUT_REQUIRED_AT) + 60_000).toISOString()

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-10-11T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
    backend: "claude", permission_mode: "bypassPermissions", ...over,
  }
}

function tele(turn: TurnState = "idle", fence?: FenceView, over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn, permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastFence: fence, ...over } as SessionTelemetry
}

interface Deferred { resolve(r: Partial<CommandRunResult>): void; signal?: AbortSignal; command: string }

/** A runner the test drives: each call is held until the test resolves it, or answered at once from
 *  `script` when one is queued. An abort resolves it as a signal, as the real runner does. */
function fakeService() {
  const calls: Deferred[] = []
  const script: Partial<CommandRunResult>[] = []
  const gate: { refusal?: string } = {}
  const service: CommandWatchService = {
    refusal: () => gate.refusal,
    probe: async () => undefined,
    run: (_slug, command, opts) =>
      new Promise((resolve) => {
        const finish = (r: Partial<CommandRunResult>) =>
          resolve({ outcome: "exit", exitCode: 1, output: "", startedAtMs: 0, finishedAtMs: 0, ...r })
        const d: Deferred = { resolve: finish, signal: opts?.signal, command }
        calls.push(d)
        opts?.signal?.addEventListener("abort", () => finish({ outcome: "signal", exitCode: null }), { once: true })
        const next = script.shift()
        if (next) finish(next)
      }),
  }
  return { service, calls, script, gate }
}

// No quiet window unless a test asks for one: most of this file hands one thread several wakes within a
// minute, and pins the source, not the window.
function harness(opts: { wakeQuietWindowMs?: number } = {}) {
  const storage: Storage = createStorage(join(mkdtempSync(join(tmpdir(), "frizz-cmw-sched-")), "ui.db"), "p")
  const teleMap = new Map<string, SessionTelemetry>()
  const tailer: Tailer = {
    get: (slug: string) => teleMap.get(slug), foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const resumes: { slug: string; message: string; deliveryId: string }[] = []
  const clock = { ms: T0 }
  const fake = fakeService()
  const s = createScheduler({
    storage, tailer, now: () => clock.ms, log: () => {}, wakeQuietWindowMs: opts.wakeQuietWindowMs ?? 0,
    resume: (slug, message, deliveryId) => void resumes.push({ slug, message, deliveryId }),
    fetchPr: async () => undefined, fetchGithubReview: async () => [],
    commandWatches: fake.service,
  })
  let seq = 0
  const arm = (slug: string, over: { command?: string; everyMs?: number; forMs?: number; firstRunAtMs?: number } = {}) => {
    const id = `cmw_${String(++seq).padStart(12, "0")}`
    storage.armCommandWatch({
      id, slug, command: over.command ?? "test -f /tmp/released", everyMs: over.everyMs ?? 60_000,
      createdAtMs: clock.ms, expiresAtMs: clock.ms + (over.forMs ?? 3600_000),
      ...(over.firstRunAtMs !== undefined ? { firstRun: { atMs: over.firstRunAtMs, outcome: "exit" as const, exitCode: 1, output: "" } } : {}),
    })
    return id
  }
  /** One pass, then let every check it started finish and record, then one more pass to deliver. */
  const cycle = async () => {
    await s.tick()
    await s.commandRunsIdle!()
    await s.tick()
  }
  return { storage, tele: teleMap, resumes, clock, fake, s, arm, cycle }
}

test("a failing check is recorded and wakes nobody; a passing one wakes ONCE, with the output, and settles", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele())
  const id = h.arm("t")
  h.fake.script.push({ exitCode: 1, output: "not yet" })
  await h.cycle()
  assert.equal(h.fake.calls.length, 1, "no check recorded yet ⇒ due at once")
  assert.equal(h.resumes.length, 0)
  let w = h.storage.getCommandWatch(id)!
  assert.deepEqual([w.state, w.runs, w.last_exit, w.last_output, w.last_run_at], ["armed", 1, 1, "not yet", T0])

  // The cadence runs from the FINISH of the last check: nothing is due until `every` has passed.
  h.clock.ms += 30_000
  await h.cycle()
  assert.equal(h.fake.calls.length, 1)

  h.clock.ms += 30_000
  h.fake.script.push({ exitCode: 0, output: "0.13.12\n" })
  await h.cycle()
  assert.equal(h.fake.calls.length, 2)
  w = h.storage.getCommandWatch(id)!
  assert.deepEqual([w.state, w.runs, w.last_exit], ["passed", 2, 0])
  assert.equal(h.resumes.length, 1, "the pass is DELIVERED")
  assert.deepEqual(wakeHead(h.resumes[0].message), { kind: "passed", id })
  assert.match(h.resumes[0].message, /exited 0 on check 2 \(2 checks over 1m\)/)
  assert.match(h.resumes[0].message, /test -f \/tmp\/released/)
  assert.match(h.resumes[0].message, /0\.13\.12/)

  // Settled: never run again, never woken again.
  h.clock.ms += 10 * 60_000
  await h.cycle()
  assert.equal(h.fake.calls.length, 2)
  assert.equal(h.resumes.length, 1)
})

test("never two checks of one watch at once, however long one takes", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele())
  const id = h.arm("t")
  await h.s.tick()
  assert.equal(h.fake.calls.length, 1)
  for (let i = 0; i < 5; i++) {
    h.clock.ms += 5 * 60_000
    await h.s.tick()
  }
  assert.equal(h.fake.calls.length, 1, "a check still running is not started again")
  h.fake.calls[0].resolve({ exitCode: 1 })
  await h.s.commandRunsIdle!()
  assert.equal(h.storage.getCommandWatch(id)!.runs, 1)
  await h.s.tick()
  assert.equal(h.fake.calls.length, 1, "and the next one is due `every` after THAT one finished")
  h.clock.ms += 60_000
  await h.s.tick()
  assert.equal(h.fake.calls.length, 2)
  h.fake.calls[1].resolve({ exitCode: 1 })
  await h.s.commandRunsIdle!()
})

test("expiry kills a check in flight, settles the watch and wakes the worker once to re-decide", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele())
  const id = h.arm("t", { forMs: 90_000, firstRunAtMs: T0 })
  h.storage.recordCommandWatchRun(id, { atMs: T0, outcome: "exit", exitCode: 1, output: "npm error 404" })
  h.clock.ms += 60_000
  await h.s.tick()
  assert.equal(h.fake.calls.length, 1)
  h.clock.ms += 60_000
  await h.s.tick()
  assert.equal(h.fake.calls[0].signal?.aborted, true, "the check in flight is killed")
  await h.s.commandRunsIdle!()
  await h.s.tick()
  assert.equal(h.storage.getCommandWatch(id)!.state, "expired")
  assert.equal(h.resumes.length, 1)
  assert.deepEqual(wakeHead(h.resumes[0].message), { kind: "expired", id })
  assert.match(h.resumes[0].message, /Its last check exited 1, ending:/)
  assert.match(h.resumes[0].message, /npm error 404/)
  assert.match(h.resumes[0].message, /`frizzctl watch-command add`/)
  h.clock.ms += 60_000
  await h.cycle()
  assert.equal(h.resumes.length, 1)
  assert.equal(h.fake.calls.length, 1)
})

test("a gate that closes after registration cancels the watch before it runs, and says why", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele())
  const id = h.arm("t")
  h.fake.gate.refusal = "this thread runs in `default` permission mode. Run the check in a background shell instead."
  await h.cycle()
  assert.equal(h.fake.calls.length, 0, "a refused thread's command is never run")
  assert.equal(h.storage.getCommandWatch(id)!.state, "cancelled")
  assert.equal(h.resumes.length, 1)
  assert.deepEqual(wakeHead(h.resumes[0].message), { kind: "cancelled", id })
  assert.match(h.resumes[0].message, /`default` permission mode/)
  assert.match(h.resumes[0].message, /background shell instead/)
})

test("a dropped watch's check in flight is killed, and what it found is never recorded or reported", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele())
  const id = h.arm("t")
  await h.s.tick()
  assert.ok(h.storage.dropCommandWatch("t", id, h.clock.ms))
  await h.s.tick()
  assert.equal(h.fake.calls[0].signal?.aborted, true)
  await h.s.commandRunsIdle!()
  await h.s.tick()
  const w = h.storage.getCommandWatch(id)!
  assert.deepEqual([w.state, w.runs], ["dropped", 0])
  assert.equal(h.resumes.length, 0)
})

test("an archived thread's watch stays ARMED and is not run; its `for` still runs out, silently", async () => {
  const h = harness()
  h.storage.upsertSession(row("t", { state: "archived" }))
  h.tele.set("t", tele())
  const id = h.arm("t", { forMs: 120_000 })
  await h.cycle()
  assert.equal(h.fake.calls.length, 0)
  assert.equal(h.storage.getCommandWatch(id)!.state, "armed")
  h.clock.ms += 180_000
  await h.cycle()
  assert.equal(h.storage.getCommandWatch(id)!.state, "expired")
  assert.equal(h.resumes.length, 0, "nobody to wake")
})

test("a pass while the worker is mid-turn is HELD until it rests (or the mid-turn ceiling)", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele("in-flight"))
  h.arm("t")
  h.fake.script.push({ exitCode: 0, output: "up" })
  await h.cycle()
  assert.equal(h.resumes.length, 0, "news about the world waits for the worker to stop")
  // A held wake is retried after its deferral lease, not on the very next tick.
  h.tele.set("t", tele("idle"))
  h.clock.ms += 60_000
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  assert.ok(MID_TURN_HOLD_MAX_MS > 60_000)
})

test("a watch survives a restart: a new scheduler over the same rows keeps the cadence, then fires", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele())
  const id = h.arm("t", { everyMs: 5 * 60_000, firstRunAtMs: T0 })
  await h.s.stop()
  // The next server: same storage, fresh scheduler and runner.
  const fake = fakeService()
  const resumes: string[] = []
  const tailer: Tailer = {
    get: (slug: string) => h.tele.get(slug), foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const next = createScheduler({
    storage: h.storage, tailer, now: () => h.clock.ms, log: () => {}, wakeQuietWindowMs: 0,
    resume: (_slug, message) => void resumes.push(message), fetchPr: async () => undefined, fetchGithubReview: async () => [],
    commandWatches: fake.service,
  })
  h.clock.ms += 4 * 60_000
  await next.tick()
  assert.equal(fake.calls.length, 0, "4m into a 5m cadence nothing is due, whoever is running the server")
  h.clock.ms += 60_000
  fake.script.push({ exitCode: 0, output: "" })
  await next.tick()
  await next.commandRunsIdle!()
  await next.tick()
  assert.equal(h.storage.getCommandWatch(id)!.state, "passed")
  assert.equal(resumes.length, 1)
  assert.match(resumes[0], /It printed nothing\./)
  await next.stop()
})

test("stop() kills every check in flight and leaves the row armed for the next server", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele())
  const id = h.arm("t")
  await h.s.tick()
  assert.equal(h.fake.calls.length, 1)
  await h.s.stop()
  assert.equal(h.fake.calls[0].signal?.aborted, true)
  const w = h.storage.getCommandWatch(id)!
  assert.deepEqual([w.state, w.runs], ["armed", 0])
})

// ---- the park ------------------------------------------------------------------------------------

function parkedOn(hints: FenceView["hints"], restedAt: string): SessionTelemetry {
  return tele("idle", { kind: "awaiting", body: "", hints }, { lastAssistantAt: restedAt, lastActivityAt: restedAt })
}

test("a rest on `commands:` naming an ARMED watch is honoured; an unknown id is bumped with how to register one", async () => {
  const h = harness()
  h.storage.setSetting("signoffNudge", "off")
  h.storage.upsertSession(row("t"))
  const id = h.arm("t", { firstRunAtMs: T0 })
  const restedAt = new Date(h.clock.ms - 60_000).toISOString()
  h.tele.set("t", parkedOn([{ kind: "command", value: id }, { kind: "status", value: "watching" }, { kind: "for", value: "6h" }], restedAt))
  await h.s.tick()
  assert.equal(h.resumes.length, 0, "an honest park is left alone")

  h.tele.set("t", parkedOn([{ kind: "command", value: "cmw_000000000bad" }, { kind: "status", value: "watching" }, { kind: "for", value: "6h" }], new Date(h.clock.ms - 30_000).toISOString()))
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /`commands: \[cmw_000000000bad\]` — NOT REGISTERED — register it with `frizzctl watch-command add` first/)
  // …and the correction hands back the id it should have named.
  assert.ok(h.resumes[0].message.includes(id))
  await h.s.stop()
})

// Measured in the e2e before this was fixed: SOURCE 12 saw the fence name a row that had just left
// `armed` and queued "the work you parked on has FINISHED" beside the pass wake, and the two went out
// merged — the worker told twice, in one message, that its watch had passed.
test("a watch that passes under a rest on it sends ONE wake — no park correction beside it", async () => {
  const h = harness()
  h.storage.setSetting("signoffNudge", "off")
  h.storage.upsertSession(row("t"))
  const id = h.arm("t", { firstRunAtMs: T0 - 60_000 })
  h.tele.set("t", parkedOn([{ kind: "command", value: id }, { kind: "status", value: "watching" }, { kind: "for", value: "6h" }], new Date(h.clock.ms - 30_000).toISOString()))
  h.fake.script.push({ exitCode: 0, output: "0.13.12" })
  await h.cycle()
  assert.equal(h.resumes.length, 1)
  assert.deepEqual(wakeHead(h.resumes[0].message), { kind: "passed", id })
  assert.doesNotMatch(h.resumes[0].message, /held 2 wakes|FINISHED/)
  // The wake lands as a user record, which is the worker moving past this rest.
  const landed = h.tele.get("t")!
  h.tele.set("t", { ...landed, lastUserAt: new Date(h.clock.ms).toISOString() })
  h.clock.ms += 60_000
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  const parks = h.storage.db.prepare("SELECT fence_id FROM wake_delivery WHERE fence_id LIKE 'park:%'").all()
  assert.deepEqual(parks, [])
  await h.s.stop()
})

// THE 2026-10-29 CARD. A thread woken at 21:10:12 parked on a Vercel check; the check passed at 21:12:43,
// which settled the watch and with it the park, and the wake waited behind the quiet window until
// 21:15:12. In between the thread sat in the queue under an awaiting card with nothing left to name:
// "Waiting for an external update." The pass is not held now, and a wake the window WAS holding leaves
// with it rather than being stranded behind it.
test("a pass inside the quiet window is delivered at once, carrying what the window held", async () => {
  const h = harness({ wakeQuietWindowMs: WAKE_QUIET_WINDOW_MS })
  h.storage.setSetting("signoffNudge", "off")
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele())
  // A wake handed over opens the thread's window…
  h.storage.armThreadTimer({ id: "tmr_first", slug: "t", prompt: "Check the deploy.", fireAtMs: T0, createdAtMs: T0 })
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  // …and the window is live in this harness: an alarm thirty seconds on is held.
  h.clock.ms = T0 + 30_000
  h.storage.armThreadTimer({ id: "tmr_second", slug: "t", prompt: "Re-read the build log.", fireAtMs: h.clock.ms, createdAtMs: h.clock.ms })
  await h.s.tick()
  assert.equal(h.resumes.length, 1, "the timer waits for the window")

  // The worker registers a check, sees it fail once, and parks on it.
  h.clock.ms = T0 + 60_000
  const id = h.arm("t", { firstRunAtMs: h.clock.ms })
  h.tele.set("t", parkedOn([{ kind: "command", value: id }, { kind: "status", value: "watching" }, { kind: "for", value: "1h" }], new Date(h.clock.ms + 1_000).toISOString()))
  // It passes 2m 31s after the first wake, inside the window.
  h.clock.ms = T0 + 151_000
  h.fake.script.push({ exitCode: 0, output: "success" })
  await h.cycle()
  assert.equal(h.storage.getCommandWatch(id)!.state, "passed")
  assert.equal(h.resumes.length, 2, "delivered on the pass, not when the window ends")
  const sent = h.resumes[1].message
  assert.match(sent, new RegExp(`command watch \`${id}\` PASSED`))
  assert.match(sent, /held 2 wakes/)
  assert.ok(sent.indexOf("Re-read the build log.") < sent.indexOf(id), "the held timer rides along, oldest first")

  // The wake lands as a user record, which is the worker moving past this rest.
  h.tele.set("t", { ...h.tele.get("t")!, lastUserAt: new Date(h.clock.ms).toISOString() })
  h.clock.ms = T0 + WAKE_QUIET_WINDOW_MS
  await h.s.tick()
  assert.equal(h.resumes.length, 2, "nothing is left for the window to release")
  await h.s.stop()
})

test("a rest on a command watch that already PASSED is told so, not that its fence is wrong", async () => {
  const h = harness()
  h.storage.setSetting("signoffNudge", "off")
  h.storage.upsertSession(row("t"))
  const id = h.arm("t", { firstRunAtMs: T0 })
  h.storage.settleCommandWatch(id, "passed", T0)
  h.tele.set("t", parkedOn([{ kind: "command", value: id }, { kind: "for", value: "6h" }], new Date(h.clock.ms - 60_000).toISOString()))
  await h.s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /already PASSED — its wake was delivered/)
  await h.s.stop()
})

test("a park naming only command watches (and PRs) runs to a week; beside a shell, a day", () => {
  const week = parkForMaxMs(readAwaitingPark([{ kind: "command", value: "cmw_x" }, { kind: "for", value: "7d" }]))
  assert.equal(week, 7 * 24 * 3600_000)
  assert.equal(parkForMaxMs(readAwaitingPark([{ kind: "command", value: "cmw_x" }, { kind: "pr", value: "a/b#1" }, { kind: "for", value: "7d" }])), week)
  assert.equal(parkForMaxMs(readAwaitingPark([{ kind: "command", value: "cmw_x" }, { kind: "shell", value: "b1" }, { kind: "for", value: "7d" }])), 24 * 3600_000)
})

test("the board: `status: watching` on an armed command watch keeps the thread out of the queue, in Snoozed", () => {
  const now = T0
  const restedAt = new Date(now - 60_000).toISOString()
  const r = row("t", { spawned_at: NEW_CONTRACT })
  const parked = parkedOn([{ kind: "command", value: "cmw_0123456789ab" }, { kind: "status", value: "watching" }, { kind: "for", value: "6h" }], restedAt)
  const armed = new Set(["cmw_0123456789ab"])
  const needsYou = deriveNeedsYou(r, parked, "turn-idle", false, now, undefined, true, false, {}, new Set(), armed)
  assert.equal(needsYou, false)
  const background = deriveAwaitingBackground(r, parked, "turn-idle", false, now, undefined, false, {}, new Set(), armed)
  assert.equal(background, true, "the resting card states the wait")
  assert.equal(deriveWaitStatus(parked, "turn-idle", needsYou, background, false, now), "watching")

  // The same fence after the watch settled names nothing armed: back in the queue.
  assert.equal(deriveNeedsYou(r, parked, "turn-idle", false, now, undefined, true, false, {}, new Set(), new Set()), true)
  // And a `timers:` line cannot borrow a command watch's id — the kinds are checked apart.
  const wrongKey = parkedOn([{ kind: "timer", value: "cmw_0123456789ab" }, { kind: "status", value: "watching" }, { kind: "for", value: "6h" }], restedAt)
  assert.equal(deriveNeedsYou(r, wrongKey, "turn-idle", false, now, undefined, true, false, {}, new Set(), armed), true)
})
