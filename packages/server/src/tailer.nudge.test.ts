// The nudge's SAFETY properties, separate from what it derives (that is covered end-to-end in
// integration/claude-runtime.integration.test.ts). A push signal wired to a provider's event stream
// is only an improvement if it cannot become its own stability problem: a turn emits events in
// bursts, and one whole-board tick per event is how you starve the event loop.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createTailer, newTailState, UNRESTORED_TAIL_FIELDS } from "./tailer.ts"
import { decodeTailState, encodeTailState } from "./tail-cache.ts"

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Ticks are counted through the registry read every tick begins with. That is deliberate: the nudge
// timer calls the tailer's INTERNAL tick, so wrapping the returned object's `tick` property would
// count nothing and every assertion here would pass vacuously.
//
// The count is a tight upper BOUND on ticks rather than an exact equality — a steady-state tick costs
// one registry read, and the every-fifth-tick foreign scan costs a second. That is more than enough
// resolution for what these tests are actually claiming: fifty events must not mean fifty ticks.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-nudge-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const reads = { n: 0 }
  const allSessions = storage.allSessions.bind(storage)
  storage.allSessions = ((...args: Parameters<typeof allSessions>) => {
    reads.n++
    return allSessions(...args)
  }) as typeof storage.allSessions
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage,
    bus: new Bus(),
    sessionLogDir: dir,
    onChange: () => {},
    paneDead: () => false,
  })
  tailer.tick() // prime, so the counter below measures steady-state ticks only
  reads.n = 0
  return { tailer, storage, reads }
}

test("nudge: a burst of fifty events collapses into one tick", async () => {
  const { tailer, storage, reads } = fixture()
  try {
    for (let i = 0; i < 50; i++) tailer.nudge?.()
    await wait(150)
    assert.ok(reads.n >= 1, "the burst did produce a tick")
    assert.ok(reads.n <= 2, `fifty events must not mean fifty whole-board ticks (registry reads: ${reads.n})`)
  } finally {
    tailer.stop()
    storage.close()
  }
})

test("nudge: coalescing is per-burst, not a permanent latch", async () => {
  const { tailer, storage, reads } = fixture()
  try {
    tailer.nudge?.()
    await wait(150)
    const afterFirst = reads.n
    assert.ok(afterFirst >= 1)
    tailer.nudge?.()
    await wait(150)
    assert.ok(reads.n > afterFirst, "a later event still gets its own tick")
  } finally {
    tailer.stop()
    storage.close()
  }
})

test("nudge: stop() cancels a pending nudge", async () => {
  const { tailer, storage, reads } = fixture()
  try {
    tailer.nudge?.()
    tailer.stop() // before the nudge timer could fire
    await wait(150)
    assert.equal(reads.n, 0, "a stopped tailer must not tick from a queued nudge")
  } finally {
    storage.close()
  }
})

test("chase bookkeeping is never restored from the durable cache", () => {
  // The chase counter is compared against an IN-MEMORY, per-process event count that restarts at zero
  // on every boot. Hydrating the previous process's high-water mark makes `live.events <=
  // runtimeEventsSeen` true forever, so the chase never fires again and the board silently falls back
  // to the 1s poll — measured at 968/970/970 ms against 16/22/19 ms once the field is dropped. That is
  // the whole latency win, reverted by a restart, with every existing test still green.
  //
  // Asserted against the REAL encode/decode round trip rather than by eyeballing the set, because the
  // cache codec is deliberately generic ("A hand-written field list is a standing bug") — so a new
  // TailState field is restored by DEFAULT, and only this exclusion stops it.
  const state = newTailState("t", "sid", "/x")
  state.runtimeEventsSeen = 1247
  state.runtimeChase = 19
  state.lastAssistant = "carried through"

  // The real codec, exercised the way hydrateFromCache does it: encode, decode, then copy back every
  // key the exclusion set does not stop.
  const decoded = decodeTailState(encodeTailState(state))!
  const restored = newTailState("t", "sid", "/x") as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(decoded)) {
    if (UNRESTORED_TAIL_FIELDS.has(k)) continue
    restored[k] = v
  }
  assert.equal(restored.lastAssistant, "carried through", "ordinary fold state still round-trips")
  assert.equal(restored.runtimeEventsSeen, undefined, "a previous process's event count must not survive a restart")
  assert.equal(restored.runtimeChase, undefined, "a mid-chase counter must not survive a restart")
})

// ---- A nudge that names its thread reads that thread ---------------------------------------------
// The broker's ingest nudges with the slug of the session whose event arrived. A whole-board tick per
// event made every row of a busy project re-derive on the event rate; these pin that a named nudge reads
// its thread alone, and that the rows it leaves are still the poll's.
const at = (second: number) => `2026-07-01T00:00:${String(second).padStart(2, "0")}.000Z`
const prompt = (second: number, text = "go") => JSON.stringify({ type: "user", timestamp: at(second), message: { role: "user", content: text } })
const reply = (second: number, text: string) => JSON.stringify({ type: "assistant", timestamp: at(second), message: { stop_reason: "end_turn", content: [{ type: "text", text }] } })

function boardFixture() {
  const root = mkdtempSync(join(tmpdir(), "frizz-nudge-board-"))
  const logDir = join(root, "-a-project")
  mkdirSync(logDir)
  const storage = createStorage(join(root, "ui.db"), "p")
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage,
    bus: new Bus(),
    onChange: () => {},
    sessionLogDir: logDir,
    brokerDaemonAlive: () => true,
    shellAlive: () => true,
  })
  return {
    storage, tailer,
    thread(slug: string, lines: string[]) {
      const sessionId = `sid-${slug}`
      storage.upsertSession({ slug, session_id: sessionId, thread_name: `frizz-${slug}`, spawned_at: at(0), last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: null, meta: null, seen_at: null, transcript_id: null })
      storage.setBackend(slug, "claude")
      storage.setClaudeRuntime(slug, "broker")
      writeFileSync(join(logDir, `${sessionId}.jsonl`), lines.map((line) => line + "\n").join(""))
    },
    append(slug: string, line: string) {
      appendFileSync(join(logDir, `sid-${slug}.jsonl`), line + "\n")
    },
    close() {
      tailer.stop()
      storage.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test("nudge: a nudge naming a thread reads that thread and no other", async () => {
  const f = boardFixture()
  try {
    f.thread("working", [prompt(0)])
    f.thread("elsewhere", [prompt(0), reply(1, "first")])
    f.tailer.tick()
    f.tailer.tick()
    f.append("working", reply(5, "the event's record"))
    f.append("elsewhere", reply(6, "written meanwhile"))

    f.tailer.nudge?.("working")
    await wait(150)
    assert.equal(f.tailer.get("working")?.lastAssistant, "the event's record", "the named thread is read now")
    assert.equal(f.tailer.get("elsewhere")?.lastAssistant, "first", "no event named this one, so it waits for the poll")

    f.tailer.tick()
    assert.equal(f.tailer.get("elsewhere")?.lastAssistant, "written meanwhile", "…which reads it")
  } finally { f.close() }
})

test("nudge: a steady stream of named nudges never holds off the poll", async () => {
  // A whole-board nudge takes over the poll's slot; a named one must run beside it, or a thread that
  // never stops sending events would keep every other row from ever being read again.
  const f = boardFixture()
  try {
    f.thread("chatty", [prompt(0)])
    f.thread("quiet-neighbour", [prompt(0), reply(1, "before")])
    f.tailer.start()
    f.append("quiet-neighbour", reply(7, "after"))
    const started = Date.now()
    let line = 10
    while (Date.now() - started < 3000 && f.tailer.get("quiet-neighbour")?.lastAssistant !== "after") {
      f.append("chatty", prompt(line++ % 60, "more"))
      f.tailer.nudge?.("chatty")
      await wait(20)
    }
    assert.equal(f.tailer.get("quiet-neighbour")?.lastAssistant, "after", "the poll read the row no event named, while the events kept coming")
  } finally { f.close() }
})

test("nudge: a nudge naming no thread is still a whole-board tick", async () => {
  const f = boardFixture()
  try {
    f.thread("one", [prompt(0), reply(1, "a")])
    f.thread("two", [prompt(0), reply(1, "b")])
    f.tailer.tick()
    f.tailer.tick()
    f.append("one", reply(5, "a2"))
    f.append("two", reply(5, "b2"))
    f.tailer.nudge?.("one")
    f.tailer.nudge?.() // inside the same window: the pending look widens to the board
    await wait(150)
    assert.equal(f.tailer.get("one")?.lastAssistant, "a2")
    assert.equal(f.tailer.get("two")?.lastAssistant, "b2")
  } finally { f.close() }
})

test("nudge: nudging a stopped tailer is inert", async () => {
  const { tailer, storage, reads } = fixture()
  try {
    tailer.nudge?.()
    await wait(150)
    const afterFirst = reads.n
    tailer.stop()
    tailer.nudge?.()
    await wait(150)
    assert.equal(reads.n, afterFirst)
  } finally {
    storage.close()
  }
})
