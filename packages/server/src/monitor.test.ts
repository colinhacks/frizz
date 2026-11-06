// MONITORS (`frizzctl watch-command add --persistent`, 2026-11-02): one registered script, many wakes.
//
// Three layers, each against the real thing where the real thing is cheap:
//   - the PROCESS — a real `/bin/sh`: lines batched into events, blank lines dropped, stderr kept for the
//     exit report but never an event, an overlong line cut, the group killed on stop, a stale group from
//     a dead server reaped only when it is provably ours;
//   - the SCHEDULER (SOURCE 13) — the real service and a real script, real SQLite, an injected clock for
//     the expiry and flood bounds. Every wake is asserted DELIVERED (`resume` ran), not merely queued;
//   - the RPC — the real router: the gate first, a script that cannot run refused, idempotency.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MONITOR_FLOOD_MAX_EVENTS, MONITOR_LINE_MAX_CHARS, parseMergedWake, parseMonitorWake, type BoardSnapshot, type Settings } from "@frizz/shared"
import { createCommandWatchService, MONITOR_OUTPUT_KEEP_MS, monitorOutputPath, monitorOutputSink, pruneMonitorOutputs, psElapsedMs, reapStaleMonitor, startMonitorProcess, type CommandWatchService, type MonitorEvent } from "./command-watch.ts"
import { createScheduler } from "./scheduler.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"
import type { BoardManager } from "./board.ts"
import type { Project } from "./project.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---- THE PROCESS ---------------------------------------------------------------------------------

test("a monitor's stdout lines arrive as batched events; blank lines are dropped; stderr is only in the exit tail", async () => {
  const events: MonitorEvent[] = []
  const proc = startMonitorProcess({
    command: "printf 'one\\ntwo\\n\\n   \\n'; echo oops >&2; sleep 0.4; printf 'three\\nfour-without-newline'; exit 3",
    cwd: tmpdir(), env: process.env, onEvent: (e) => events.push(e), batchMs: 100,
  })
  const run = await proc.done
  assert.deepEqual(events, [{ lines: ["one", "two"], more: 0 }, { lines: ["three", "four-without-newline"], more: 0 }])
  assert.equal(run.outcome, "exit")
  assert.equal(run.exitCode, 3)
  assert.match(run.output, /oops/, "stderr is reported in the tail")
})

test("an overlong line is cut and marked; a flood inside one batch is counted, not delivered", async () => {
  const events: MonitorEvent[] = []
  const long = MONITOR_LINE_MAX_CHARS + 500
  const proc = startMonitorProcess({
    command: `head -c ${long} /dev/zero | tr '\\0' a; echo; i=0; while [ $i -lt 60 ]; do echo line$i; i=$((i+1)); done`,
    cwd: tmpdir(), env: process.env, onEvent: (e) => events.push(e), batchMs: 300,
  })
  await proc.done
  const lines = events.flatMap((e) => e.lines)
  assert.equal(lines[0].length, MONITOR_LINE_MAX_CHARS + 1, "cut to the limit, plus the mark")
  assert.ok(lines[0].endsWith("…"))
  const more = events.reduce((n, e) => n + e.more, 0)
  assert.equal(lines.length + more, 61, "every line is either delivered or counted")
  assert.ok(more > 0)
})

test("stop() kills the script's whole group, a background child included", async () => {
  const events: MonitorEvent[] = []
  const proc = startMonitorProcess({
    command: "sleep 30 & echo child=$!; wait",
    cwd: tmpdir(), env: process.env, onEvent: (e) => events.push(e), batchMs: 20,
  })
  await until(() => events.length > 0, "the child's pid")
  const child = Number(/child=(\d+)/.exec(events[0].lines[0])![1])
  assert.ok(alive(child))
  proc.stop()
  const run = await proc.done
  assert.equal(run.outcome, "signal")
  await until(() => !alive(child), "the background child to die")
})

test("a stale group is reaped only when its pid still leads its group AND started when the row says", async () => {
  // ONE simple command, which `/bin/sh` replaces itself with: what `ps` reads is `sleep 31`, never the
  // `/bin/sh -c …` the server spawned. The first reaper matched on that command line, and missed exactly
  // this shape — the commonest monitor there is (`node watch.mjs`, `tail -F x`).
  const child = spawn("/bin/sh", ["-c", "sleep 31"], { detached: true, stdio: "ignore" })
  const pid = child.pid!
  const startedAt = Date.now()
  try {
    await until(() => alive(pid), "the stale script")
    assert.equal(reapStaleMonitor(pid, startedAt - 60_000), false, "a pid that started a minute after the row's instant is somebody else's")
    assert.equal(reapStaleMonitor(pid, startedAt, () => `${pid + 1} 00:01`), false, "not a group leader")
    assert.equal(reapStaleMonitor(pid, startedAt, () => undefined), false, "gone")
    assert.equal(reapStaleMonitor(pid, startedAt, () => `${pid} garbage`), false, "an unreadable start")
    assert.ok(alive(pid))
    assert.equal(reapStaleMonitor(pid, startedAt), true, "the real `ps` reading matches")
    await until(() => child.exitCode !== null || child.signalCode !== null, "the stale group to die")
  } finally {
    try { process.kill(-pid, "SIGKILL") } catch {}
  }
})

test("ps's elapsed time reads in every shape it prints", () => {
  assert.equal(psElapsedMs("00:07"), 7_000)
  assert.equal(psElapsedMs(" 12:34"), 754_000)
  assert.equal(psElapsedMs("01:02:03"), 3_723_000)
  assert.equal(psElapsedMs("2-01:02:03"), 176_523_000)
  assert.equal(psElapsedMs("soon"), undefined)
})

// ---- THE SCHEDULER --------------------------------------------------------------------------------

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-11-02T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
    backend: "claude", permission_mode: "bypassPermissions", ...over,
  }
}

/** The real service — real `/bin/sh`, real batching — with the gate held by the test. */
function realService(dir: string, gate: { refusal?: string }): CommandWatchService {
  const real = createCommandWatchService({ cwd: dir, env: () => process.env, monitorBatchMs: 50, monitorOutputDir: join(dir, "monitors") })
  return { ...real, refusal: () => gate.refusal }
}

function harness(opts: { wakeQuietWindowMs?: number; storage?: Storage; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "frizz-monitor-"))
  const storage: Storage = opts.storage ?? createStorage(join(dir, "ui.db"), "p")
  const tele: SessionTelemetry = { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false } as unknown as SessionTelemetry
  const tailer: Tailer = {
    get: () => tele, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const resumes: { slug: string; message: string }[] = []
  // The clock FOLLOWS real time — events arrive from a real script — and a test moves it forward for the
  // expiry and the gate's re-check.
  const clock = { offset: 0, get ms() { return Date.now() + this.offset }, set ms(v: number) { this.offset = v - Date.now() } }
  const gate: { refusal?: string } = {}
  const s = createScheduler({
    storage, tailer, now: () => clock.ms, log: () => {}, wakeQuietWindowMs: opts.wakeQuietWindowMs ?? 0,
    resume: (slug, message) => void resumes.push({ slug, message }),
    fetchPr: async () => undefined, fetchGithubReview: async () => [],
    commandWatches: realService(dir, gate),
  })
  let seq = 0
  const arm = (slug: string, command: string, over: { forMs?: number; description?: string } = {}) => {
    const id = `cmw_${String(++seq).padStart(12, "0")}`
    storage.armMonitor({ id, slug, command, description: over.description, createdAtMs: clock.ms, expiresAtMs: clock.ms + (over.forMs ?? 3600_000) })
    return id
  }
  // Every wake, in order — a delivery that MERGED several (anything pending for the thread at once goes
  // out as one message) is cut back into its parts first, as the chat cuts it.
  const wakes = () => resumes.flatMap((r) => (parseMergedWake(r.message)?.map((p) => p.body) ?? [r.message]).map(parseMonitorWake))
  return { dir, storage, resumes, wakes, clock, gate, s, arm }
}

test("a monitor's output log keeps what it printed, marks a fresh start, and stays under its cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-monitor-log-"))
  try {
    const path = monitorOutputPath(join(dir, "monitors"), "cmw_0a1b2c3d4e5f")
    assert.equal(path, join(dir, "monitors", "cmw_0a1b2c3d4e5f.log"))
    assert.equal(monitorOutputPath(dir, "../../etc/passwd"), join(dir, "etcpasswd.log"), "an id can never name a path")
    const first = monitorOutputSink(path, 64, () => "T1")
    first(Buffer.from("tick-1\n"))
    first(Buffer.from("oops\n"))
    assert.equal(readFileSync(path, "utf8"), "tick-1\noops\n")
    // The server restarted and runs the script again: the log goes on, with the seam marked.
    const second = monitorOutputSink(path, 64, () => "T2")
    second(Buffer.from("tick-2\n"))
    assert.equal(readFileSync(path, "utf8"), "tick-1\noops\n\n[Frizz started the script again at T2]\ntick-2\n")
    // Past the cap it keeps its newest half.
    second(Buffer.from("x".repeat(40) + "\n"))
    assert.ok(statSync(path).size <= 64)
    assert.match(readFileSync(path, "utf8"), /x{20,}\n$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("registration hands back what the script printed in its window; later lines wake, one wake per event", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  const id = h.arm("t", "echo baseline; sleep 0.6; echo 'ERROR one'; sleep 0.4; echo 'ERROR two'; sleep 30", { description: "errors in app.log" })
  try {
    const started = await h.s.startMonitor!(id, 300)
    assert.equal(started.running, true)
    assert.deepEqual(started.events, ["baseline"], "the window's event is in the reply")
    await h.s.tick()
    assert.equal(h.resumes.length, 0, "and it never wakes the thread")

    await until(() => h.storage.getCommandWatch(id)!.events >= 3, "two more events")
    await h.s.tick()
    assert.deepEqual(h.wakes().map((w) => w && [w.kind, w.id, w.label, w.output]), [
      ["event", id, "errors in app.log", "ERROR one"],
      ["event", id, "errors in app.log", "ERROR two"],
    ])
    const w = h.storage.getCommandWatch(id)!
    assert.deepEqual([w.state, w.kind, w.events, w.last_event, w.runs], ["armed", "monitor", 3, "ERROR two", 1])
    assert.ok(w.pid && alive(w.pid), "the group it leads is on the row")

    // A drop kills the script at once (releaseMonitor), and nothing more wakes.
    const pid = w.pid!
    assert.equal(h.storage.dropCommandWatch("t", id, h.clock.ms), true)
    await h.s.releaseMonitor!(id)
    await until(() => !alive(pid), "the dropped script to die")
    assert.equal(h.storage.getCommandWatch(id)!.pid, null)
    await h.s.tick()
    assert.equal(h.wakes().length, 2, "no wake for the drop, nor for the killed script")
    // Its output log outlives it for a day (a drawer open at the drop still reads it), then the
    // scheduler's sweep removes it.
    const log = monitorOutputPath(join(h.dir, "monitors"), id)
    assert.match(readFileSync(log, "utf8"), /ERROR two/)
    h.clock.ms += MONITOR_OUTPUT_KEEP_MS + 61_000
    await h.s.tick()
    assert.equal(existsSync(log), false, "the sweep removed the ended monitor's log")
  } finally { await h.s.stop() }
})

test("a script that ENDS on its own wakes once with its code and tail, and settles", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  const id = h.arm("t", "sleep 0.4; echo 'run 42 failed'; echo 'boom' >&2; exit 2")
  try {
    const started = await h.s.startMonitor!(id, 100)
    assert.equal(started.running, true)
    await until(() => h.storage.getCommandWatch(id)!.state !== "armed", "the script to end")
    await h.s.tick()
    const parsed = h.wakes()
    assert.deepEqual(parsed.map((w) => w?.kind), ["event", "exited"])
    assert.equal(parsed[1]!.summary, "The script exited 2 after 1 event.")
    assert.match(parsed[1]!.output ?? "", /boom/)
    const w = h.storage.getCommandWatch(id)!
    assert.deepEqual([w.state, w.last_outcome, w.last_exit, w.pid], ["passed", "exit", 2, null])
  } finally { await h.s.stop() }
})

test("a script that exits inside the registration window is reported in the reply, settled, and wakes nobody", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  const id = h.arm("t", "echo hi; no-such-binary-xyz")
  try {
    const started = await h.s.startMonitor!(id, 2_000)
    assert.equal(started.running, false)
    assert.deepEqual(started.events, ["hi"])
    assert.equal(started.exited?.exitCode, 127)
    assert.match(started.exited!.output, /no-such-binary-xyz/)
    assert.equal(h.storage.getCommandWatch(id)!.state, "passed")
    await h.s.tick()
    assert.equal(h.resumes.length, 0)
  } finally { await h.s.stop() }
})

test("expiry kills the script and wakes once; a closed gate cancels it with the reason", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.storage.upsertSession(row("u"))
  const expiring = h.arm("t", "sleep 30", { forMs: 60_000 })
  const gated = h.arm("u", "sleep 31")
  try {
    await h.s.tick()
    const pids = [h.storage.getCommandWatch(expiring)!.pid!, h.storage.getCommandWatch(gated)!.pid!]
    assert.ok(pids.every(alive), "both started by the pass")

    h.clock.ms += 61_000
    h.gate.refusal = "this thread runs in `default` permission mode. Run the check in a background shell instead."
    await h.s.tick()
    await until(() => pids.every((p) => !alive(p)), "both scripts to die")
    await h.s.tick()
    const byId = new Map(h.wakes().map((w) => [w!.id, w!]))
    assert.equal(byId.get(expiring)?.kind, "expired")
    assert.equal(byId.get(gated)?.kind, "cancelled")
    assert.match(byId.get(gated)!.summary, /default permission mode/)
    assert.equal(h.storage.getCommandWatch(expiring)!.state, "expired")
    assert.equal(h.storage.getCommandWatch(gated)!.state, "cancelled")
    assert.equal(h.resumes.length, 2, "the kill is not also reported as an exit")
  } finally { await h.s.stop() }
})

test("a FLOOD stops the monitor and says to tighten the filter", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  const id = h.arm("t", `i=0; while [ $i -lt ${MONITOR_FLOOD_MAX_EVENTS + 10} ]; do echo tick$i; sleep 0.08; i=$((i+1)); done; sleep 30`)
  try {
    await h.s.startMonitor!(id, 1)
    await until(() => h.storage.getCommandWatch(id)!.state === "cancelled", "the flood bound", 15_000)
    await h.s.tick()
    const parsed = h.wakes()
    assert.equal(parsed.filter((w) => w?.kind === "event").length, MONITOR_FLOOD_MAX_EVENTS)
    const last = parsed.at(-1)!
    assert.equal(last.kind, "cancelled")
    assert.match(last.summary, /tighter filter/)
  } finally { await h.s.stop() }
})

test("a server that stops kills the script and leaves the row armed; the next server starts it again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-monitor-restart-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const first = harness({ storage, dir })
  storage.upsertSession(row("t"))
  const id = first.arm("t", "echo started-$$; sleep 30")
  await first.s.tick()
  await until(() => storage.getCommandWatch(id)!.events === 1, "the first start's line")
  const firstPid = storage.getCommandWatch(id)!.pid!
  await first.s.stop()
  assert.ok(!alive(firstPid), "stop() kills it")
  let w = storage.getCommandWatch(id)!
  assert.deepEqual([w.state, w.pid, w.runs], ["armed", null, 1])

  const second = harness({ storage, dir })
  try {
    await second.s.tick()
    await until(() => storage.getCommandWatch(id)!.events === 2, "the restarted script's line")
    w = storage.getCommandWatch(id)!
    assert.equal(w.runs, 2, "a start per server")
    assert.ok(w.pid && w.pid !== firstPid && alive(w.pid))
  } finally { await second.s.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test("a crashed server's group is killed before the next server starts a fresh one", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  // A single command, which the shell execs into — the shape the first reaper missed under load.
  const command = "sleep 32"
  const id = h.arm("t", command)
  // What a SIGKILLed server leaves: a live group, and its pid and start on an armed row.
  const orphan = spawn("/bin/sh", ["-c", command], { detached: true, stdio: "ignore" })
  const startedAt = Date.now()
  try {
    await until(() => alive(orphan.pid!), "the orphan")
    // Past the shell's exec, so `ps` reads `sleep 32`, as it does on a loaded machine.
    await sleep(300)
    h.storage.noteMonitorStart(id, orphan.pid!, startedAt)
    await h.s.tick()
    await until(() => orphan.exitCode !== null || orphan.signalCode !== null, "the orphan to be reaped")
    const w = h.storage.getCommandWatch(id)!
    assert.ok(w.pid && w.pid !== orphan.pid && alive(w.pid), "a fresh one runs")
  } finally {
    try { process.kill(-orphan.pid!, "SIGKILL") } catch {}
    await h.s.stop()
  }
})

test("events ride the quiet window and merge; the ending skips it", async () => {
  const h = harness({ wakeQuietWindowMs: 5 * 60_000 })
  h.storage.upsertSession(row("t"))
  const id = h.arm("t", "echo a; sleep 0.4; echo b; sleep 0.4; exit 0")
  try {
    await h.s.startMonitor!(id, 1)
    await until(() => h.storage.getCommandWatch(id)!.events >= 1, "the first event")
    await h.s.tick()
    assert.equal(h.resumes.length, 1, "the first event goes out at once")
    await until(() => h.storage.getCommandWatch(id)!.state === "passed", "the end")
    await h.s.tick()
    assert.equal(h.resumes.length, 2, "the end is not held; the second event rides it")
    assert.match(h.resumes[1].message, /printed 1 line \(event 2\)/)
    assert.match(h.resumes[1].message, /exited 0 after 2 events/)
  } finally { await h.s.stop() }
})

// ---- THE RPC ------------------------------------------------------------------------------------

function rpcHarness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-monitor-rpc-"))
  const project: Project = { dir, id: "mon", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0, deltasSince: () => null, snapshotState: async () => ({ board: ({}) as never, seq: 0 }),
    rebuild: async () => snapshot, refresh: () => snapshot, start: async () => {}, stop: async () => {},
  }
  // An idle worker, so a wake the test causes is delivered on the next tick.
  const tele = { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false } as unknown as SessionTelemetry
  const tailer: Tailer = {
    get: () => tele, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const gate: { refusal?: string } = {}
  const commandWatches = realService(dir, gate)
  const resumes: string[] = []
  const scheduler = createScheduler({
    storage, tailer, log: () => {}, wakeQuietWindowMs: 0, resume: (_slug, message) => void resumes.push(message),
    fetchPr: async () => undefined, fetchGithubReview: async () => [], commandWatches,
  })
  const ctx = {
    project, storage, board, tailer, commandWatches, scheduler,
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
  } as unknown as AppContext
  return {
    storage, gate, scheduler, resumes, router: createRouter(ctx),
    close: async () => { await scheduler.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("add: the gate first; then the script starts, and its first lines come back in the reply", async () => {
  const h = rpcHarness()
  try {
    h.storage.upsertSession(row("t"))
    h.gate.refusal = "this thread runs in `default` permission mode. Run the check in a background shell instead."
    const refused = await h.router.addOwnMonitor.handler({ input: { slug: "t", command: "echo hi; sleep 30", description: "greetings", for: "1h" } })
    assert.match(refused.refused!, /^Frizz will not run a persistent command watch for this thread: this thread runs in `default`/)
    assert.match(refused.refused!, /Monitor tool, or in a background shell, instead\.$/)
    assert.deepEqual(h.storage.listCommandWatches("t"), [], "a refusal stores nothing")

    delete h.gate.refusal
    const added = await h.router.addOwnMonitor.handler({ input: { slug: "t", command: "  echo hi; sleep 30  ", description: "  greetings \n from   sh ", for: "30d" } })
    assert.equal(added.refused, undefined)
    assert.equal(added.running, true)
    assert.deepEqual(added.events, ["hi"])
    assert.deepEqual(added.clamped, { for: "30d" }, "the week's ceiling is reported")
    assert.equal(added.watches.length, 1)
    assert.deepEqual(added.watches[0].monitor, { description: "greetings from sh", events: 1, lastEvent: added.watches[0].monitor!.lastEvent })
    assert.equal(added.watches[0].monitor!.lastEvent!.text, "hi")

    const again = await h.router.addOwnMonitor.handler({ input: { slug: "t", command: "echo hi; sleep 30", description: "greetings", for: "1h" } })
    assert.equal(again.alreadyArmed, true)
    assert.equal(again.id, added.id)

    const dropped = await h.router.dropOwnCommandWatch.handler({ input: { slug: "t", id: added.id! } })
    assert.equal(dropped.dropped, true)
    assert.deepEqual(dropped.watches, [])
  } finally { await h.close() }
})

test("add: a script the server cannot run (127) is refused, with its output, and nothing stays armed", async () => {
  const h = rpcHarness()
  try {
    h.storage.upsertSession(row("t"))
    const added = await h.router.addOwnMonitor.handler({ input: { slug: "t", command: "my-local-only-tool --watch", description: "greetings", for: "1h" } })
    assert.match(added.refused!, /could not run here \(`\/bin\/sh` exited 127\)/)
    assert.equal(added.exited?.exitCode, 127)
    assert.deepEqual(h.storage.listCommandWatches("t", { armedOnly: true }), [])
  } finally { await h.close() }
})

test("a monitor's drawer reads its script and everything it printed; the human's stop kills it and tells the worker", async () => {
  const h = rpcHarness()
  try {
    h.storage.upsertSession(row("t"))
    const added = await h.router.addOwnMonitor.handler({ input: { slug: "t", command: "echo hi; echo 'not an event' >&2; sleep 30", description: "Greetings", for: "1h" } })
    assert.equal(added.running, true)
    const id = added.id!
    const open = await h.router.monitorOutput.handler({ input: { slug: "t", id } })
    assert.equal(open.state, "running")
    assert.equal(open.command, "echo hi; echo 'not an event' >&2; sleep 30")
    assert.equal(open.description, "Greetings")
    assert.equal(open.events, 1)
    assert.equal(open.stoppable, true)
    assert.match(open.output, /^hi\n/)
    assert.match(open.output, /not an event/, "stderr is in the drawer, though it never wakes anyone")
    assert.equal((await h.router.monitorOutput.handler({ input: { slug: "other", id } })).state, "gone", "never another thread's")

    const pid = h.storage.getCommandWatch(id)!.pid!
    assert.deepEqual(await h.router.stopMonitor.handler({ input: { slug: "t", id } }), { stopped: true })
    assert.equal(alive(pid), false, "the script is dead before the stop answers")
    const ended = await h.router.monitorOutput.handler({ input: { slug: "t", id } })
    assert.deepEqual([ended.state, ended.ended, ended.stoppable], ["ended", "stopped", false])
    assert.match(ended.output, /^hi\n/, "and its output stays readable")
    await h.scheduler.tick()
    const wake = parseMonitorWake(h.resumes.at(-1) ?? "")
    assert.deepEqual([wake?.kind, wake?.by, wake?.label, wake?.summary], ["cancelled", "human", "Greetings", "You stopped it from the board after 1 event."])
    assert.match(h.resumes.at(-1) ?? "", /^🛑 The human stopped your command watch `cmw_[a-z0-9]+` from the board after 1 event — Greetings\n\nRegister it again only if they ask for it\.\n/m, "the worker is told who stopped it, and what to do")
    assert.deepEqual(await h.router.stopMonitor.handler({ input: { slug: "t", id } }), { stopped: false }, "a second stop finds nothing armed")
  } finally { await h.close() }
})

test("an ended monitor's output log is removed a day after it ended, and an armed one's never", () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-prune-"))
  try {
    const now = Date.parse("2026-11-03T12:00:00.000Z")
    const rows: Record<string, { state: "armed" | "cancelled" | "passed"; settled_at: number | null }> = {
      cmw_armed: { state: "armed", settled_at: null },
      cmw_recent: { state: "cancelled", settled_at: now - MONITOR_OUTPUT_KEEP_MS + 60_000 },
      cmw_old: { state: "passed", settled_at: now - MONITOR_OUTPUT_KEEP_MS - 60_000 },
    }
    for (const id of [...Object.keys(rows), "cmw_orphan"]) writeFileSync(monitorOutputPath(dir, id), "x\n")
    writeFileSync(join(dir, "notes.txt"), "not a monitor's")
    assert.deepEqual(pruneMonitorOutputs(dir, (id) => rows[id], now).sort(), ["cmw_old", "cmw_orphan"])
    assert.deepEqual(["cmw_armed", "cmw_recent", "cmw_old", "cmw_orphan"].map((id) => existsSync(monitorOutputPath(dir, id))), [true, true, false, false])
    assert.ok(existsSync(join(dir, "notes.txt")), "only a monitor's log is ever removed")
    assert.deepEqual(pruneMonitorOutputs(join(dir, "missing"), () => undefined, now), [], "no directory, nothing to do")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
