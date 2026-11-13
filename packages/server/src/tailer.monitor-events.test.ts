import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { applyRecord, monitorEventsOf, newTailState, parseLine, unescapeNotificationText, type TailState } from "./tailer.ts"
import { decodeTailState, encodeTailState } from "./tail-cache.ts"

// A real Claude Code Monitor, trimmed out of a reylo thread (2026-10-22, task b1zy0xrln): the launch,
// its ack, and every record that carried one of its notifications — 26 carrier copies of 10 blocks, in
// the order the transcript wrote them. Paths in the events are rewritten to /work and /tmp.
const FIXTURE = readFileSync(join(import.meta.dirname, "tailer.fixtures/monitor-events.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim())
const TOOL_USE = "toolu_01M7TP1j2E4HYtoqFaNk5g2C"
const TASK = "b1zy0xrln"

function fold(lines: readonly string[], state: TailState = newTailState("t", "sid", "/x")): TailState {
  for (const line of lines) {
    const rec = parseLine(line)
    if (rec) applyRecord(state, rec)
  }
  return state
}

const texts = (state: TailState, taskId = TASK) => monitorEventsOf(state, taskId).events.map((e) => e.text)

test("a real Monitor's events are collected once each, in order, across all three carriers", () => {
  const s = fold(FIXTURE)
  const { events, dropped } = monitorEventsOf(s, TASK)
  assert.equal(dropped, 0)
  // The Monitor's own expiry notice counts 9 delivered events; it is the tenth, and the last.
  assert.equal(events.length, 10)
  assert.equal(events.at(-1)?.text, "[Monitor expired after 30m with 9 events delivered. Re-arm it if you still need the watch.]")
  assert.deepEqual(events.slice(1, 5).map((e) => e.text.replace(/\s+/g, " ")), ["pass lab-sqlite 1s", "pass lab-jest 4s", "pass lab-driver-matrix 61s", "pass lab-drivers 3s"])
  // The notification escapes its text; the drawer shows what the script printed.
  assert.match(events[0].text, /^==> \/work\/gates-fts5\.log <==\npass {2}prepare/)
  assert.ok(!events.some((e) => e.text.includes("&lt;") || e.text.includes("&gt;")))
  // Each carries the instant its first copy was written, and they read in that order.
  assert.equal(events[1].at, "2026-10-22T20:40:37.834Z")
  assert.deepEqual(events.map((e) => e.at), [...events.map((e) => e.at)].sort())
  // The expiry retired the row, and the retired row still names its task, so the drawer resolves it.
  assert.equal(s.subAgents.has(TOOL_USE), false)
  assert.equal(s.retiredShells.get(TOOL_USE)?.monitor, true)
  assert.equal(s.retiredShells.get(TOOL_USE)?.taskId, TASK)
})

test("a queue-operation written BEFORE the Monitor's launch is still collected", () => {
  // The flush race (trackCompletions): the first event's enqueue lands ahead of the launch record, and
  // its inline attachment never comes. Only the queue-operation copies carry it.
  const firstEnqueue = FIXTURE.findIndex((l) => l.includes('"enqueue"'))
  const firstAttachment = FIXTURE.findIndex((l) => l.includes('"attachment"'))
  const reordered = [FIXTURE[firstEnqueue], ...FIXTURE.filter((_, i) => i !== firstEnqueue && i !== firstAttachment)]
  assert.ok(JSON.parse(reordered[0]).type === "queue-operation" && JSON.parse(reordered[1]).type === "assistant")
  const s = fold(reordered)
  assert.equal(texts(s).length, 10)
  assert.match(texts(s)[0], /pass {2}prepare/)
})

// ---- synthetic carriers, in the real shapes ----

const block = (taskId: string, event: string, summary = 'Monitor event: "watch"') =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<summary>${summary}</summary>\n<event>${event}</event>\n</task-notification>`
const enqueue = (at: string, content: string) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: at, content })
const remove = (at: string, content: string) => JSON.stringify({ type: "queue-operation", operation: "remove", timestamp: at, content })
const attachment = (at: string, prompt: string) => JSON.stringify({ type: "attachment", timestamp: at, attachment: { type: "queued_command", prompt } })
const userRecord = (at: string, content: string) => JSON.stringify({ type: "user", timestamp: at, promptSource: "system", message: { role: "user", content } })
const launch = (id: string, taskId: string) => [
  JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Monitor", id, input: { command: "tail -f log", description: "watch" } }] } }),
  JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.500Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: `Monitor started (task ${taskId}, timeout 300s). You will be notified on each event.` }] } }),
]

test("the same line printed twice is two events; one event's three copies are one", () => {
  const b = block("bmon1", "pass")
  const s = fold([
    ...launch("toolu_m", "bmon1"),
    enqueue("2026-07-01T00:00:01.000Z", b),
    attachment("2026-07-01T00:00:01.000Z", b),
    enqueue("2026-07-01T00:00:02.000Z", b),
    attachment("2026-07-01T00:00:02.000Z", b),
    // Removes are batched, so both copies share one instant; the enqueues still tell them apart.
    remove("2026-07-01T00:00:03.000Z", b),
    remove("2026-07-01T00:00:03.000Z", b),
    userRecord("2026-07-01T00:00:04.000Z", block("bmon1", "done")),
  ])
  assert.deepEqual(texts(s, "bmon1"), ["pass", "pass", "done"])
})

test("a replayed record (same carrier, same timestamp) is not a second event", () => {
  const b = block("bmon1", "only once")
  const s = fold([...launch("toolu_m", "bmon1"), userRecord("2026-07-01T00:00:01.000Z", b), userRecord("2026-07-01T00:00:01.000Z", b)])
  assert.deepEqual(texts(s, "bmon1"), ["only once"])
})

test("an event whose copy lands late in the file still reads in timestamp order", () => {
  const s = fold([
    ...launch("toolu_m", "bmon1"),
    userRecord("2026-07-01T00:00:05.000Z", block("bmon1", "second")),
    enqueue("2026-07-01T00:00:02.000Z", block("bmon1", "first")),
  ])
  assert.deepEqual(texts(s, "bmon1"), ["first", "second"])
})

test("the stream-ended notification's last output is an event, and it retires the row", () => {
  // Real shape (reylo 778aef07, task bdbi1lkig): a <status>, an <output-file>, and the last lines printed.
  const ended = `<task-notification>\n<task-id>bmon1</task-id>\n<tool-use-id>toolu_m</tool-use-id>\n<output-file>/tmp/tasks/bmon1.output</output-file>\n<status>completed</status>\n<summary>Monitor "watch" stream ended</summary>\n<event>Build\tpass\t2m29s</event>\n</task-notification>`
  const s = fold([...launch("toolu_m", "bmon1"), attachment("2026-07-01T00:00:09.000Z", ended)])
  assert.deepEqual(texts(s, "bmon1"), ["Build\tpass\t2m29s"])
  assert.equal(s.retiredShells.get("toolu_m")?.status, "completed")
  // A stream that ended with nothing left to say carries no <event>, and adds none.
  const quiet = fold([...launch("toolu_m", "bmon2"), enqueue("2026-07-01T00:00:09.000Z", `<task-notification>\n<task-id>bmon2</task-id>\n<tool-use-id>toolu_m</tool-use-id>\n<status>completed</status>\n<summary>Monitor "watch" stream ended</summary>\n</task-notification>`)])
  assert.deepEqual(texts(quiet, "bmon2"), [])
})

test("a background Bash's completion keeps no events", () => {
  const done = `<task-notification>\n<task-id>bsh1</task-id>\n<tool-use-id>toolu_b</tool-use-id>\n<output-file>/tmp/tasks/bsh1.output</output-file>\n<status>completed</status>\n<summary>Background command "build" completed (exit code 0)</summary>\n</task-notification>`
  const s = fold([enqueue("2026-07-01T00:00:09.000Z", done)])
  assert.equal(s.monitorEvents, undefined)
})

test("the caps: 200 events per Monitor, a long event cut, and the count of what was let go", () => {
  const lines = [...launch("toolu_m", "bmon1")]
  for (let i = 0; i < 250; i++) lines.push(enqueue(new Date(Date.UTC(2026, 6, 1, 1, 0, i)).toISOString(), block("bmon1", `line ${i}`)))
  const s = fold(lines)
  const { events, dropped } = monitorEventsOf(s, "bmon1")
  assert.equal(events.length, 200)
  assert.equal(dropped, 50)
  assert.equal(events[0].text, "line 50", "the oldest go first")
  assert.equal(events.at(-1)?.text, "line 249")

  const long = fold([...launch("toolu_m", "bmon2"), enqueue("2026-07-01T00:00:01.000Z", block("bmon2", "x".repeat(10_000)))])
  const [cut] = texts(long, "bmon2")
  assert.ok(cut.length < 4100)
  assert.match(cut, /\n… 6000 more characters not kept$/)

  // A Monitor's events together stay under the character budget, whatever their count.
  const bulky = [...launch("toolu_m", "bmon3")]
  for (let i = 0; i < 40; i++) bulky.push(enqueue(new Date(Date.UTC(2026, 6, 1, 1, 0, i)).toISOString(), block("bmon3", `${i} ${"y".repeat(3000)}`)))
  const kept = monitorEventsOf(fold(bulky), "bmon3")
  assert.ok(kept.events.reduce((n, e) => n + e.text.length, 0) <= 48_000)
  assert.equal(kept.events.length + kept.dropped, 40)
})

test("over the per-thread cap, a sub-agent's Monitor log is evicted before this thread's own", () => {
  const lines = [...launch("toolu_m", "bown"), enqueue("2026-07-01T00:00:01.000Z", block("bown", "mine"))]
  // A sub-agent's Monitors notify through the root transcript's queue-operations too.
  for (let i = 0; i < 12; i++) lines.push(enqueue(new Date(Date.UTC(2026, 6, 1, 1, 0, i)).toISOString(), block(`bchild${i}`, "theirs")))
  const s = fold(lines)
  assert.equal(s.monitorEvents?.size, 8)
  assert.deepEqual(texts(s, "bown"), ["mine"], "this thread's Monitor survives though it was heard from least recently")
})

test("the notification's escaping is undone once, never twice", () => {
  assert.equal(unescapeNotificationText("&lt;== a &amp;&amp; b &gt; c &quot;d&quot; &#39;e&#39; &amp;lt;"), `<== a && b > c "d" 'e' &lt;`)
})

test("the events survive the prime cache's round trip, and the fold resumes on them without duplicating", () => {
  const half = Math.floor(FIXTURE.length / 2)
  const restored = newTailState("t", "sid", "/x")
  Object.assign(restored, decodeTailState(encodeTailState(fold(FIXTURE.slice(0, half)))))
  assert.ok(restored.monitorEvents instanceof Map)
  fold(FIXTURE.slice(half - 3), restored) // three records re-read across the boundary
  assert.deepEqual(texts(restored), texts(fold(FIXTURE)))
})
