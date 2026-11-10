// WHAT A TELEMETRY READ COSTS IN SYSTEM CALLS, for the two kinds of thread the board reads on every build.
//
// The board asks the tailer for every thread's telemetry on every build, ten builds a second while a
// worker streams. A thread that ever had a sub-agent is VOLATILE (its sub-agent views read the clock and
// the disk), so each of those reads went to the disk: on a copy of the maintainer's boards with three
// workers busy, the sidecar dir's stat for sixty-odd archived threads a build was the largest system call
// the server made (2026-11-10). These pin what each read may cost, by counting the stats the tailer asks
// its `mtimeMs` for, and that the answers are still the derivation's.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createTailer } from "./tailer.ts"

const SESSION = "11111111-2222-3333-4444-555555555555"
const SLUG = "grain"
const T0 = Date.parse("2026-07-28T18:24:00.000Z")

function assistant(content: unknown[], at = new Date(T0).toISOString()): string {
  return JSON.stringify({ type: "assistant", timestamp: at, message: { id: "m1", stop_reason: "end_turn", content } })
}

// A thread that dispatched one child, which RETIRED while its own fan-out (a grandchild) kept running:
// the shape that keeps a thread volatile with nothing live of its own (tailer.ts anchorRoots).
function fixture(opts: { filedAway: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sidecar-grain-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const subagents = join(dir, SESSION, "subagents")
  mkdirSync(subagents, { recursive: true })
  writeFileSync(join(dir, `${SESSION}.jsonl`), `${assistant([
    { type: "tool_use", id: "toolu_child", name: "Agent", input: { description: "LEVEL-ONE", subagent_type: "general-purpose", run_in_background: true } },
  ])}\n`)
  const sidecar = (agentId: string, body: unknown) => writeFileSync(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify(body))
  const transcript = (agentId: string) => writeFileSync(join(subagents, `agent-${agentId}.jsonl`), `${assistant([{ type: "text", text: agentId }])}\n`)
  sidecar("aChild", { agentType: "general-purpose", description: "LEVEL-ONE", toolUseId: "toolu_child", spawnDepth: 1 })
  transcript("aChild")
  sidecar("aGrand", { agentType: "general-purpose", description: "LEVEL-TWO", toolUseId: "toolu_grand", parentAgentId: "aChild", spawnDepth: 2 })
  transcript("aGrand")
  // The child's terminal notification: it stopped, its grandchild did not.
  appendFileSync(join(dir, `${SESSION}.jsonl`), `${JSON.stringify({
    type: "queue-operation", operation: "enqueue", timestamp: new Date(T0 + 60_000).toISOString(),
    content: "<task-notification>\n<task-id>aChild</task-id>\n<tool-use-id>toolu_child</tool-use-id>\n<status>completed</status>\n<summary>Agent \"LEVEL-ONE\" finished</summary>\n</task-notification>",
  })}\n`)
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `frizz-${SLUG}`, spawned_at: new Date(T0).toISOString(),
    last_read_at: null, unread: 0, exited: opts.filedAway ? 1 : 0, archived: opts.filedAway ? 1 : 0, rested_at: null, title_auto: 1,
    title: SLUG, state: opts.filedAway ? "archived" : "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(SLUG, "claude")
  const clock = { ms: T0 + 120_000 }
  // Every stat the tailer asks for, by path. Every transcript reads as written a second before the
  // fixture's first instant, so the grandchild is live for the whole test; the dir's instant moves when
  // a sidecar is added to it, as a real directory's does.
  const stats = new Map<string, number>()
  const written = T0 + 119_000
  const dirAt = { ms: written }
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => opts.filedAway,
    now: () => clock.ms,
    mtimeMs: (path) => {
      stats.set(path, (stats.get(path) ?? 0) + 1)
      return path === subagents ? dirAt.ms : path.endsWith(".jsonl") ? written : undefined
    },
  })
  tailer.tick()
  return {
    tailer, storage, dir, subagents, clock, stats,
    /** A grandchild spawned under the retired child, as Claude Code writes one: sidecar and transcript. */
    spawn(agentId: string, toolUseId: string) {
      sidecar(agentId, { agentType: "general-purpose", description: agentId, toolUseId, parentAgentId: "aChild", spawnDepth: 2 })
      transcript(agentId)
      dirAt.ms += 1
    },
    dirStats: () => stats.get(subagents) ?? 0,
    close() {
      tailer.stop()
      storage.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("a filed-away thread's sidecar dir is read once a second, not once a read", () => {
  const f = fixture({ filedAway: true })
  try {
    const row = f.storage.getSession(SLUG)!
    const first = f.tailer.get(SLUG, row)!
    assert.deepEqual(first.subAgents.map((v) => [v.id, v.state]), [["toolu_child", "rested"], ["toolu_grand", "running"]], "precondition: a rested child anchoring a live grandchild")
    f.stats.clear()
    for (let i = 0; i < 10; i++) assert.equal(f.tailer.get(SLUG, row), first, "ten builds' worth of reads, the same answer")
    assert.equal(f.dirStats(), 0, "inside the second, the dir is not read again")

    f.clock.ms += 1_000
    // (A new object: a descendant whose sidecar carries no spawn instant is dated by the clock.)
    const next = f.tailer.get(SLUG, row)!
    assert.deepEqual(next.subAgents.map((v) => [v.id, v.state]), [["toolu_child", "rested"], ["toolu_grand", "running"]], "the next second reads the dir again and finds nothing new")
    assert.equal(f.dirStats(), 1, "once")
  } finally { f.close() }
})

test("a grandchild spawned under a retired child reaches a filed-away thread's telemetry when the second turns over", () => {
  const f = fixture({ filedAway: true })
  try {
    const row = f.storage.getSession(SLUG)!
    f.tailer.get(SLUG, row)
    f.spawn("aGrand2", "toolu_grand2")
    f.clock.ms += 1_000
    assert.deepEqual(f.tailer.get(SLUG, row)!.subAgents.map((v) => v.id), ["toolu_child", "toolu_grand", "toolu_grand2"])
  } finally { f.close() }
})

test("a thread that is not filed away still reads its sidecar dir on every read, and sees a new grandchild at once", () => {
  const f = fixture({ filedAway: false })
  try {
    const row = f.storage.getSession(SLUG)!
    f.tailer.get(SLUG, row)
    f.stats.clear()
    for (let i = 0; i < 3; i++) f.tailer.get(SLUG, row)
    assert.equal(f.dirStats(), 3, "one dir read a read")
    f.spawn("aGrand2", "toolu_grand2")
    assert.deepEqual(f.tailer.get(SLUG, row)!.subAgents.map((v) => v.id), ["toolu_child", "toolu_grand", "toolu_grand2"], "no clock needed")
  } finally { f.close() }
})

test("a live child's transcript is stat'd once a read, for both its staleness and its last activity", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sidecar-grain-live-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const output = join(dir, "tasks", "abc123.output")
  writeFileSync(join(dir, `${SESSION}.jsonl`), [
    JSON.stringify({ type: "user", timestamp: new Date(T0).toISOString(), message: { role: "user", content: "go" } }),
    JSON.stringify({ type: "assistant", timestamp: new Date(T0 + 1_000).toISOString(), message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Agent", id: "toolu_ag", input: { description: "Auditing", run_in_background: true, subagent_type: "general-purpose" } }] } }),
    JSON.stringify({ type: "user", timestamp: new Date(T0 + 2_000).toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "toolu_ag", content: [{ type: "text", text: `Async agent launched successfully.\nagentId: abc123\noutput_file: ${output}\n` }] }] } }),
    assistant([{ type: "text", text: "waiting" }], new Date(T0 + 3_000).toISOString()),
  ].map((l) => `${l}\n`).join(""))
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `frizz-${SLUG}`, spawned_at: new Date(T0).toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(SLUG, "claude")
  const clock = { ms: T0 + 10_000 }
  const stats = new Map<string, number>()
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => false,
    now: () => clock.ms,
    mtimeMs: (path) => { stats.set(path, (stats.get(path) ?? 0) + 1); return clock.ms - 500 },
  })
  try {
    tailer.tick()
    const row = storage.getSession(SLUG)!
    const tele = tailer.get(SLUG, row)!
    assert.deepEqual(tele.subAgents.map((v) => [v.id, v.state, v.lastActivityAt]), [["toolu_ag", "running", new Date(clock.ms - 500).toISOString()]])
    stats.clear()
    tailer.get(SLUG, row)
    assert.equal(stats.get(output), 1, "one stat of the child's transcript per read")
  } finally {
    tailer.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
