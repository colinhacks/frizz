import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createCodexSubAgentTracker, type CodexSubAgentSink } from "./codex-subagents.ts"

// ---- REAL captured multi-agent rollout (codex, 2026-07-23) ----
// Derived from the rollout that exposed the bug: a codex worker running eleven `spawn_agent` children
// while frizz's board showed none. Trimmed to three children and their list_agents rosters; the fernet
// dispatch blobs are elided and the completed reports clipped to one short line. Everything else —
// record order, envelope shape, field names, call_id↔event_id correlation — is byte-faithful.
const FIXTURE = readFileSync(join(import.meta.dirname, "backend/codex.fixtures/multi-agent.jsonl"), "utf8")
const FIXTURE_LINES = FIXTURE.split("\n").filter((l) => l.trim())

const DOCS = "/root/config_docs_schema"
const DOCS_THREAD = "019f90e0-f995-7eb1-ba93-e330082cadd6"
const BWRAP = "/root/linux_bwrap_review"
const BWRAP_THREAD = "019f90e0-aedc-78d3-b8de-7607e1606425"
const ACTIVATION = "/root/config_activation_review"

// The tracker's sink, recorded as a live map plus an ordered retirement log.
function recorder() {
  const live = new Map<string, { label: string; startedAt: string; subagentType?: string; outputFile?: string }>()
  const retired: { id: string; status: string; at?: string }[] = []
  const sink: CodexSubAgentSink = {
    setLive: (id, e) => void live.set(id, e),
    retire: (id, at, status) => {
      if (!live.delete(id)) return
      retired.push({ id, status, at })
    },
  }
  return { sink, live, retired }
}

// Lines of the fixture up to (and including) the first record whose timestamp is > `at`. Lets a test
// fold the real rollout to a chosen instant instead of hand-writing records.
function linesUntil(at: string): string[] {
  return FIXTURE_LINES.filter((l) => {
    const ts = (JSON.parse(l) as { timestamp?: string }).timestamp ?? ""
    return ts <= at
  })
}

// A child rollout, as codex writes it: session_meta then bracketed turns.
function childRollout(...turns: { start: string; end?: string }[]): string {
  const out = [JSON.stringify({ timestamp: turns[0].start, type: "session_meta", payload: { id: "child" } })]
  for (const t of turns) {
    out.push(JSON.stringify({ timestamp: t.start, type: "event_msg", payload: { type: "task_started" } }))
    if (t.end) out.push(JSON.stringify({ timestamp: t.end, type: "event_msg", payload: { type: "task_complete", last_agent_message: "done" } }))
  }
  return out.join("\n") + "\n"
}

// A tracker wired to in-memory child rollouts. `files` is mutated by tests to simulate a child
// appending; cursors are honored so the fold stays incremental exactly as it is in production.
function harness(files: Map<string, string> = new Map()) {
  const rec = recorder()
  const tracker = createCodexSubAgentTracker({
    sink: rec.sink,
    findRollouts: (ids) => {
      const out = new Map<string, string>()
      for (const id of ids) if (files.has(`/rollouts/${id}.jsonl`)) out.set(id, `/rollouts/${id}.jsonl`)
      return out
    },
    readAppended: (path, offset) => {
      const text = files.get(path)
      if (text === undefined) return undefined
      const restarted = text.length < offset
      const from = restarted ? 0 : offset
      return { text: text.slice(from), offset: text.length, restarted }
    },
  })
  return { ...rec, tracker, files }
}

test("a real spawn_agent + sub_agent_activity pair surfaces a live sub-agent with its model/effort cell", () => {
  const h = harness()
  for (const line of linesUntil("2026-07-23T21:28:12.334Z")) h.tracker.onLine(line)

  assert.equal(h.tracker.liveCount(), 3)
  // Keyed by the spawn's call_id — the same id sub_agent_activity carries as `event_id`, which is what
  // makes the transcript's Spawn agent card and the drill-in drawer resolve the same child.
  const docs = h.live.get("call_BIk9hxjEKDawwE5ic0iHYPM8")
  assert.ok(docs, "the config_docs_schema dispatch is tracked under its spawn call_id")
  assert.equal(docs.label, "config_docs_schema")
  assert.equal(docs.subagentType, "worker gpt-5.6-terra/medium")
  assert.equal(docs.startedAt, "2026-07-23T21:28:12.334Z")
  // No rollout resolved yet — the entry is live with no file, which entryStale reads as "starting up".
  assert.equal(docs.outputFile, undefined)
})

test("a REJECTED spawn_agent (codex answers with a bare sentence) never becomes a sub-agent", () => {
  const h = harness()
  const call = "call_rejected"
  h.tracker.onLine(JSON.stringify({
    timestamp: "2026-07-23T21:27:00.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "spawn_agent", call_id: call, arguments: JSON.stringify({ task_name: "doomed", model: "gpt-5.6-sol", reasoning_effort: "high" }) },
  }))
  h.tracker.onLine(JSON.stringify({
    timestamp: "2026-07-23T21:27:01.000Z",
    type: "response_item",
    payload: { type: "function_call_output", call_id: call, output: "Full-history forked agents inherit the parent agent type, model, and reasoning effort; omit agent_type, model, and reasoning_effort, or spawn without a full-history fork." },
  }))
  h.tracker.poll(Date.parse("2026-07-23T21:27:02.000Z"))

  assert.equal(h.tracker.liveCount(), 0, "no child was created, so nothing may be surfaced")
  assert.equal(h.live.size, 0)
})

test("the child's OWN rollout drives liveness: open turn = running, bracketed closed = retired", () => {
  const files = new Map<string, string>()
  const h = harness(files)
  for (const line of linesUntil("2026-07-23T21:28:12.334Z")) h.tracker.onLine(line)

  // Child is mid-turn: it stays live, and gains its transcript path for the drawer + staleness clock.
  files.set(`/rollouts/${DOCS_THREAD}.jsonl`, childRollout({ start: "2026-07-23T21:28:12.690Z" }))
  h.tracker.poll(Date.parse("2026-07-23T21:29:00.000Z"))
  assert.equal(h.live.get("call_BIk9hxjEKDawwE5ic0iHYPM8")?.outputFile, `/rollouts/${DOCS_THREAD}.jsonl`)
  assert.equal(h.retired.length, 0)

  // It brackets its turn closed → the work it was dispatched for is done, retired at the bracket's own
  // instant (not the tick's) so the finished-state label reads the child's real elapsed time.
  files.set(`/rollouts/${DOCS_THREAD}.jsonl`, childRollout({ start: "2026-07-23T21:28:12.690Z", end: "2026-07-23T21:32:47.666Z" }))
  h.tracker.poll(Date.parse("2026-07-23T21:31:00.000Z"))
  assert.deepEqual(h.retired.find((r) => r.id === "call_BIk9hxjEKDawwE5ic0iHYPM8"), {
    id: "call_BIk9hxjEKDawwE5ic0iHYPM8",
    status: "completed",
    at: "2026-07-23T21:32:47.666Z",
  })
  assert.equal(h.live.has("call_BIk9hxjEKDawwE5ic0iHYPM8"), false)
})

test("a followup_task re-opens a finished child under its ORIGINAL dispatch id", () => {
  const files = new Map<string, string>()
  const h = harness(files)
  for (const line of linesUntil("2026-07-23T21:28:12.334Z")) h.tracker.onLine(line)
  files.set(`/rollouts/${DOCS_THREAD}.jsonl`, childRollout({ start: "2026-07-23T21:28:12.690Z", end: "2026-07-23T21:32:47.666Z" }))
  h.tracker.poll(Date.parse("2026-07-23T21:33:00.000Z"))
  assert.equal(h.tracker.liveCount(), 2)

  // The REAL `interacted` record the parent's followup_task produced at 21:33:14.
  for (const line of FIXTURE_LINES) {
    const rec = JSON.parse(line) as { timestamp?: string; payload?: { type?: string; kind?: string; agent_path?: string } }
    if (rec.payload?.type === "sub_agent_activity" && rec.payload.kind === "interacted" && rec.payload.agent_path === DOCS) h.tracker.onLine(line)
  }
  assert.equal(h.tracker.liveCount(), 3)
  assert.ok(h.live.has("call_BIk9hxjEKDawwE5ic0iHYPM8"), "resurrected under the spawn call_id, not the followup's")

  // The second turn closes → retired again, at the second bracket.
  files.set(`/rollouts/${DOCS_THREAD}.jsonl`, childRollout(
    { start: "2026-07-23T21:28:12.690Z", end: "2026-07-23T21:32:47.666Z" },
    { start: "2026-07-23T21:33:14.182Z", end: "2026-07-23T21:35:25.572Z" },
  ))
  h.tracker.poll(Date.parse("2026-07-23T21:36:00.000Z"))
  assert.equal(h.retired.at(-1)?.at, "2026-07-23T21:35:25.572Z")
})

test("a list_agents roster retires children codex reports terminal — and never INVENTS one", () => {
  const h = harness()
  // Through the real 21:35:33 roster: config_docs_schema {completed}, the other two still running —
  // alongside six children this tracker never saw spawn, which must NOT be surfaced.
  for (const line of linesUntil("2026-07-23T21:35:33.918Z")) h.tracker.onLine(line)

  assert.deepEqual(h.retired.map((r) => r.id), ["call_BIk9hxjEKDawwE5ic0iHYPM8"])
  assert.equal(h.tracker.liveCount(), 2, "an unseen roster entry has no rollout to observe, so it is never surfaced")
  assert.deepEqual([...h.live.values()].map((v) => v.label).sort(), ["config_activation_review", "linux_bwrap_review"])
})

test("sub_agent_activity kind=interrupted retires the child as killed", () => {
  const h = harness()
  for (const line of linesUntil("2026-07-23T21:28:12.334Z")) h.tracker.onLine(line)
  h.tracker.onLine(JSON.stringify({
    timestamp: "2026-07-23T21:40:00.000Z",
    type: "event_msg",
    payload: { type: "sub_agent_activity", event_id: "call_stop", occurred_at_ms: 1784842092333, agent_thread_id: BWRAP_THREAD, agent_path: BWRAP, kind: "interrupted" },
  }))
  assert.deepEqual(h.retired, [{ id: "call_6iibfZNl6BmXLNBl4PV8qXEH", status: "killed", at: "2026-07-23T21:40:00.000Z" }])
})

test("a child whose rollout never appears is retired rather than left running forever", () => {
  const h = harness(new Map()) // no rollout will ever resolve
  for (const line of linesUntil("2026-07-23T21:28:12.334Z")) h.tracker.onLine(line)

  const t0 = Date.parse("2026-07-23T21:28:20.000Z")
  h.tracker.poll(t0)
  assert.equal(h.tracker.liveCount(), 3, "within the resolve grace it keeps trying")
  h.tracker.poll(t0 + 60_000)
  assert.equal(h.tracker.liveCount(), 3)
  // Past the grace: an unobservable child must not pin its thread out of the queue forever.
  h.tracker.poll(t0 + 3 * 60_000)
  assert.equal(h.tracker.liveCount(), 0)
  assert.deepEqual(h.retired.map((r) => r.status), ["completed", "completed", "completed"])
})

test("folding the whole real rollout twice is idempotent (restart replay converges)", () => {
  const files = new Map<string, string>([
    [`/rollouts/${DOCS_THREAD}.jsonl`, childRollout({ start: "2026-07-23T21:28:12.690Z", end: "2026-07-23T21:35:25.572Z" })],
    [`/rollouts/${BWRAP_THREAD}.jsonl`, childRollout({ start: "2026-07-23T21:27:53.000Z" })],
  ])
  const run = () => {
    const h = harness(files)
    for (const line of FIXTURE_LINES) h.tracker.onLine(line)
    h.tracker.poll(Date.parse("2026-07-23T22:40:00.000Z"))
    return h
  }
  const a = run()
  const b = run()
  assert.deepEqual([...a.live.keys()].sort(), [...b.live.keys()].sort())
  // linux_bwrap_review's turn is still open, so it — and only it — is still live.
  assert.deepEqual([...a.live.values()].map((v) => v.label), ["linux_bwrap_review"])
  // config_activation_review is retired by the roster (it reports {completed}), not by a rollout we hold.
  assert.ok(a.retired.some((r) => r.id === "call_wPL1F6wx3qwvRVJFhP4TuCWs" && r.status === "completed"), `${ACTIVATION} retires via the roster`)
})

test("a rotated/truncated child rollout re-reads from the top instead of skipping records", () => {
  const files = new Map<string, string>()
  const h = harness(files)
  for (const line of linesUntil("2026-07-23T21:28:12.334Z")) h.tracker.onLine(line)
  // Two turns, the second still open → live, cursor parked at the end of a 4-record file.
  files.set(`/rollouts/${DOCS_THREAD}.jsonl`, childRollout({ start: "2026-07-23T21:28:12.690Z", end: "2026-07-23T21:29:30.000Z" }, { start: "2026-07-23T21:30:00.000Z" }))
  h.tracker.poll(Date.parse("2026-07-23T21:30:10.000Z"))
  assert.equal(h.tracker.liveCount(), 3)

  // Genuinely SHRUNK on disk. Resuming at the old cursor would land mid-record and miss the bracket;
  // re-reading from the top sees the close and retires at the child's own instant.
  files.set(`/rollouts/${DOCS_THREAD}.jsonl`, childRollout({ start: "2026-07-23T21:28:12.690Z", end: "2026-07-23T21:31:00.000Z" }))
  h.tracker.poll(Date.parse("2026-07-23T21:31:10.000Z"))
  assert.equal(h.retired.find((r) => r.id === "call_BIk9hxjEKDawwE5ic0iHYPM8")?.at, "2026-07-23T21:31:00.000Z")
})

// ---- codex >=0.153: the same three signals, respelled onto `item_completed` ----
// Codex stopped writing the flat `sub_agent_activity` record the fixture above is built on, so on a
// 0.153 rollout the tracker saw a run of `spawn_agent` calls and NOTHING else: no slot was ever
// created, `liveCount` stayed 0, and a worker orchestrating seventeen children showed none on the
// board. The item form also adds a `completed` kind the flat one never had.
const MA0153 = readFileSync(join(import.meta.dirname, "backend/codex.fixtures/multi-agent-0153.jsonl"), "utf8")
const MA0153_LINES = MA0153.split("\n").filter((l) => l.trim())
const BUN = "/root/bun_mechanics"
const BUN_CALL = "call_0m1yOvy72xu8aOT9iq5Uxy3I"

test("0.153: an item_completed/SubAgentActivity `started` surfaces the child under its spawn call_id", () => {
  const h = harness()
  for (const line of MA0153_LINES) {
    // Stop before the `completed`, so this asserts the live half on its own.
    if (line.includes('"kind":"completed"')) break
    h.tracker.onLine(line)
  }

  assert.equal(h.tracker.liveCount(), 1)
  const bun = h.live.get(BUN_CALL)
  assert.ok(bun, "the child is keyed by the spawn's call_id, which the item carries as its own `id`")
  assert.equal(bun.label, "bun_mechanics")
  assert.equal(bun.subagentType, "gpt-6-astra/high")
})

test("0.153: a `completed` kind retires the child directly, without waiting on its rollout", () => {
  const h = harness() // no child rollouts registered at all — the item is the only evidence there is
  for (const line of MA0153_LINES) h.tracker.onLine(line)
  h.tracker.poll(Date.parse("2026-09-04T18:52:00.000Z"))

  assert.equal(h.tracker.liveCount(), 0)
  assert.deepEqual(h.retired.map((r) => ({ id: r.id, status: r.status })), [{ id: BUN_CALL, status: "completed" }])
  // Retired at codex's own instant, not at the poll's.
  assert.equal(h.retired[0].at, JSON.parse(MA0153_LINES.find((l) => l.includes('"kind":"completed"'))!).timestamp)
})

test("0.153: an `interacted` for a child we never saw start is ignored, not invented", () => {
  // The fixture's `interacted` names /root/generated_dispatch, whose `started` is not in this slice.
  // Inventing a slot from a path alone would give a child with no rollout to observe — unretirable,
  // and it would pin the parent out of the queue forever.
  const h = harness()
  for (const line of MA0153_LINES) h.tracker.onLine(line)
  assert.ok(![...h.live.keys(), ...h.retired.map((r) => r.id)].some((id) => id.includes("xCccg87")))
  assert.equal(BUN, "/root/bun_mechanics") // the one child this slice does follow end to end
})
