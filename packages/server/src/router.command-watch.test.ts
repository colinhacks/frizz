// THE COMMAND WATCH REGISTRY at the RPC boundary — the real router against real SQLite, with the gate
// and the runner injected. (The runner and the gate are tested for real in command-watch.test.ts; the
// scheduler's half in command-watch.scheduler.test.ts.)
//
// What is pinned here is ORDER and CONSEQUENCE: the gate is asked before anything else, a refusal stores
// nothing, a first check that already passes arms nothing, a command the server cannot run is refused
// rather than armed to fail for a week, and every clamp is reported.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, Settings } from "@frizz/shared"
import { COMMAND_WATCH_EVERY_MIN_MS, COMMAND_WATCH_FOR_MAX_MS, COMMAND_WATCH_MAX_ARMED } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import type { CommandRunResult, CommandWatchService } from "./command-watch.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"

function result(over: Partial<CommandRunResult> = {}): CommandRunResult {
  return { outcome: "exit", exitCode: 1, output: "not yet", startedAtMs: 1_000, finishedAtMs: Date.now(), ...over }
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-cmw-rpc-"))
  const project: Project = { dir, id: "cmw", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0, deltasSince: () => null, snapshotState: async () => ({ board: ({}) as never, seq: 0 }),
    rebuild: async () => snapshot,
    refresh: () => { refreshes++; return snapshot },
    start: async () => {},
    stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => undefined, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const gate: { refusal?: string } = {}
  const probes: { slug: string; command: string }[] = []
  let probeResult: CommandRunResult | undefined = result()
  const commandWatches: CommandWatchService = {
    refusal: () => gate.refusal,
    run: async () => result(),
    probe: async (slug, command) => {
      probes.push({ slug, command })
      return probeResult
    },
  }
  const ctx = {
    project, storage, board, tailer, commandWatches,
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
  } as unknown as AppContext
  return {
    storage,
    router: createRouter(ctx),
    gate,
    probes,
    setProbe: (r: CommandRunResult | undefined) => { probeResult = r },
    refreshes: () => refreshes,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-10-11T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
    backend: "claude", permission_mode: "bypassPermissions", ...over,
  }
}

const NPM = "npm view frizz@0.13.12 version"

test("add runs a first check, arms the watch with that check on it, and answers with the armed set", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.markThreadDone("t", "earlier", 1)
    const added = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: `  ${NPM}  `, every: "5m", for: "6h" } })
    assert.equal(added.refused, undefined)
    assert.equal(added.passed, false)
    assert.match(added.id!, /^cmw_[0-9a-f]{12}$/)
    assert.equal(added.every, "5m")
    assert.equal(added.clamped, undefined)
    assert.deepEqual(h.probes, [{ slug: "t", command: NPM }], "the command is trimmed and checked once, for the caller")
    assert.equal(added.firstRun?.exitCode, 1)
    const [stored] = h.storage.listCommandWatches("t", { armedOnly: true })
    assert.equal(stored.id, added.id)
    assert.equal(stored.command, NPM)
    assert.equal(stored.every_ms, 5 * 60_000)
    assert.equal(stored.runs, 1, "the first check counts")
    assert.equal(stored.last_exit, 1)
    assert.ok(stored.last_run_at, "the cadence starts from the first check")
    assert.ok(Math.abs(stored.expires_at - (stored.created_at + 6 * 3600_000)) < 5)
    assert.deepEqual(added.watches.map((w) => [w.id, w.runs, w.lastRun?.exitCode]), [[added.id, 1, 1]])
    assert.equal(h.storage.getThreadDone("t"), undefined, "a registration trumps a done")
    assert.ok(h.refreshes() > 0)
  } finally { h.close() }
})

test("a REFUSAL is asked first, stores nothing, runs nothing, and names the background shell", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.gate.refusal = "this thread runs in `default` permission mode. Run the check in a background shell instead."
    const refused = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: NPM, every: "5m", for: "6h" } })
    assert.match(refused.refused!, /^Frizz will not run a command watch for this thread: this thread runs in `default`/)
    assert.match(refused.refused!, /background shell instead\.$/)
    assert.equal(refused.id, undefined)
    assert.deepEqual(h.probes, [], "a refused command is never run, not even once")
    assert.deepEqual(h.storage.listCommandWatches("t"), [])
  } finally { h.close() }
})

test("the gate outranks idempotency: a thread that lost the right is not told its old watch stands", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: NPM, every: "5m", for: "6h" } })
    h.gate.refusal = "nope. Run the check in a background shell instead."
    const again = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: NPM, every: "5m", for: "6h" } })
    assert.ok(again.refused)
    assert.equal(again.alreadyArmed, false)
  } finally { h.close() }
})

test("a first check that already PASSES arms nothing — the worker carries on now", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.setProbe(result({ exitCode: 0, output: "0.13.12\n" }))
    const added = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: NPM, every: "5m", for: "6h" } })
    assert.equal(added.passed, true)
    assert.equal(added.id, undefined)
    assert.equal(added.firstRun?.output, "0.13.12\n")
    assert.deepEqual(h.storage.listCommandWatches("t"), [])
  } finally { h.close() }
})

test("a command the server cannot run (127, 126, a shell that never started) is refused, not armed to fail for a week", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    for (const probe of [result({ exitCode: 127, output: "sh: nub: command not found" }), result({ exitCode: 126 }), result({ outcome: "error", exitCode: null, output: "could not start /bin/sh" })]) {
      h.setProbe(probe)
      const added = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: "nub --version", every: "5m", for: "6h" } })
      assert.match(added.refused!, /could not run here/)
      assert.match(added.refused!, /server's own PATH/)
      assert.match(added.refused!, /background shell instead\.$/)
      assert.equal(added.firstRun?.outcome, probe.outcome)
    }
    assert.deepEqual(h.storage.listCommandWatches("t"), [])
  } finally { h.close() }
})

test("a first check cut short by its own short timeout arms with NO check recorded, so the scheduler runs it now", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.setProbe(result({ outcome: "timeout", exitCode: null }))
    const added = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: "slow-check", every: "5m", for: "6h" } })
    assert.ok(added.id)
    assert.equal(added.firstRun?.outcome, "timeout", "the worker is told")
    const stored = h.storage.getCommandWatch(added.id!)!
    assert.equal(stored.runs, 0)
    assert.equal(stored.last_run_at, null)
    // …and with no slot for a first check at all, the same.
    h.setProbe(undefined)
    const unprobed = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: "other-check", every: "5m", for: "6h" } })
    assert.ok(unprobed.id)
    assert.equal(unprobed.firstRun, undefined)
    assert.equal(h.storage.getCommandWatch(unprobed.id!)!.last_run_at, null)
  } finally { h.close() }
})

test("every and for are clamped, never refused, and the clamp is REPORTED", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const added = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: NPM, every: "10s", for: "30d" } })
    assert.deepEqual(added.clamped, { every: "10s", for: "30d" })
    assert.equal(added.every, "1m")
    const stored = h.storage.getCommandWatch(added.id!)!
    assert.equal(stored.every_ms, COMMAND_WATCH_EVERY_MIN_MS)
    assert.equal(stored.expires_at - stored.created_at, COMMAND_WATCH_FOR_MAX_MS)
    await assert.rejects(h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: "x", every: "soon", for: "1h" } }), /`--every soon` is not a duration/)
    await assert.rejects(h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: "x", every: "5m", for: "2026-10-12" } }), /`--for 2026-10-12` is not a duration/)
  } finally { h.close() }
})

test("the same text as a check and as a persistent watch are two waits", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.armMonitor({ id: "cmw_persistent", slug: "t", command: NPM, description: "x", createdAtMs: Date.now(), expiresAtMs: Date.now() + 3_600_000 })
    const check = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: NPM, every: "5m", for: "6h" } })
    assert.equal(check.alreadyArmed, false)
    assert.notEqual(check.id, "cmw_persistent")
    assert.equal(check.every, "5m", "not the persistent watch's absent cadence")
  } finally { h.close() }
})

test("registering is idempotent on the exact command, and capped per thread", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const first = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: NPM, every: "5m", for: "6h" } })
    const second = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: NPM, every: "1m", for: "7d" } })
    assert.equal(second.alreadyArmed, true)
    assert.equal(second.id, first.id)
    assert.equal(second.every, "5m", "the original cadence stands")
    assert.equal(h.probes.length, 1, "the re-registration ran nothing")
    for (let i = 1; i < COMMAND_WATCH_MAX_ARMED; i++) {
      await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: `test -f /tmp/cmw-${i}`, every: "5m", for: "6h" } })
    }
    await assert.rejects(
      h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: "one-too-many", every: "5m", for: "6h" } }),
      new RegExp(`the limit is ${COMMAND_WATCH_MAX_ARMED}`),
    )
  } finally { h.close() }
})

test("drop is scoped to the caller's own thread; list reads back only what is armed", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.upsertSession(row("other"))
    const mine = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: NPM, every: "5m", for: "6h" } })
    const theirs = await h.router.addOwnCommandWatch.handler({ input: { slug: "other", command: NPM, every: "5m", for: "6h" } })
    const stolen = await h.router.dropOwnCommandWatch.handler({ input: { slug: "t", id: theirs.id! } })
    assert.equal(stolen.dropped, false)
    assert.equal(h.storage.getCommandWatch(theirs.id!)!.state, "armed")
    const dropped = await h.router.dropOwnCommandWatch.handler({ input: { slug: "t", id: mine.id! } })
    assert.equal(dropped.dropped, true)
    assert.deepEqual(dropped.watches, [])
    assert.equal(h.storage.getCommandWatch(mine.id!)!.state, "dropped")
    assert.deepEqual((await h.router.listOwnCommandWatches.handler({ input: { slug: "other" } })).watches.map((w) => w.id), [theirs.id])
  } finally { h.close() }
})

test("an armed command watch is listed by `activity` under its id, and blocks `done`", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const added = await h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: NPM, every: "5m", for: "6h" } })
    const activity = await h.router.listOwnThreadActivity.handler({ input: { slug: "t" } })
    assert.deepEqual(activity.activity.map((a) => [a.kind, a.id, a.label]), [["command", added.id, NPM]])
    const done = await h.router.markOwnDone.handler({ input: { slug: "t", body: "finished" } })
    assert.equal(done.done, false)
    assert.deepEqual(done.blockingWatches.map((w) => [w.id, w.what]), [[added.id, `command watch: ${NPM}`]])
  } finally { h.close() }
})

test("an archived or unknown thread cannot register one", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t", { state: "archived" }))
    await assert.rejects(h.router.addOwnCommandWatch.handler({ input: { slug: "t", command: NPM, every: "5m", for: "6h" } }), /Reopen this thread/)
    await assert.rejects(h.router.addOwnCommandWatch.handler({ input: { slug: "nobody", command: NPM, every: "5m", for: "6h" } }), /not registered/)
  } finally { h.close() }
})
