import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  sweepIdleTranscriptFolds,
  TRANSCRIPT_FOLD_IDLE_MS,
  createTranscriptFold,
  parseTranscript,
  projectClaudeTranscript,
  readTranscript,
  __clearTranscriptCacheForTests,
} from "./transcript.ts"
import type { Project } from "./project.ts"

// ── realistic multi-record fixtures (shapes reused from transcript.test.ts) ──────────────────────────
const PREFIX = "claude:incr"
const userLine = (text: string, ts = "2026-07-01T00:00:00.000Z") =>
  JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: text } })
const asstText = (mid: string, text: string, ts = "2026-07-01T00:00:00.000Z") =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id: mid, content: [{ type: "text", text }] } })
const asstTool = (mid: string, id: string, name: string, input: unknown, ts = "2026-07-01T00:00:00.000Z") =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id: mid, content: [{ type: "tool_use", id, name, input }] } })
const toolResult = (id: string, content: unknown, ts = "2026-07-01T00:00:01.000Z") =>
  JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } })
const enqueue = (content: string, ts = "2026-07-01T00:00:02.000Z") =>
  JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: ts, content })
const deliver = (prompt: string, ts = "2026-07-01T00:00:03.000Z") =>
  JSON.stringify({ type: "attachment", timestamp: ts, attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind: "human" } } })
const agentLaunch = (id: string, description: string, ts = "2026-07-01T00:00:04.000Z") =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id: "m-agent", content: [{ type: "tool_use", id, name: "Agent", input: { description, subagent_type: "claude", prompt: "do the sub-task" } }] } })
const taskNotification = (id: string, status: string, ts = "2026-07-01T00:00:09.000Z") =>
  JSON.stringify({ type: "queue-operation", timestamp: ts, content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>` })

// Fixture A: a full turn with an in-place tool_result back-fill, a queued enqueue→delivery pair (the
// delivery un-grays the earlier bubble IN PLACE), and a following assistant turn. The enqueue and its
// delivering attachment are separate records — a chunk split between them exercises a mutation that
// crosses the boundary.
const FIXTURE_A = [
  userLine("kick off the work"),
  asstTool("m1", "bash-1", "Bash", { command: "npm test", description: "Run tests" }),
  toolResult("bash-1", "42 passing"),
  enqueue("actually, also lint"),
  deliver("actually, also lint"),
  asstText("m2", "On it — running the linter now."),
].join("\n")

// Fixture B: an Agent dispatch whose completion notification arrives later, back-filling the launch card
// AND emitting an inline completion card. The launch and notification are separated by other records so a
// split lands between them.
const FIXTURE_B = [
  userLine("delegate the audit"),
  agentLaunch("agent-1", "Audit the auth flow"),
  toolResult("agent-1", "launched"),
  asstText("m-mid", "Dispatched a sub-agent; continuing."),
  taskNotification("agent-1", "completed"),
  asstText("m-after", "Sub-agent finished; wrapping up."),
].join("\n")

// Feed `raw` to a fresh fold split into the given consecutive byte-slices, finalize, and return the
// capped projection. Mirrors how the cache would feed appended bytes, but for arbitrary split points.
function foldChunks(raw: string, splits: number[]): ReturnType<typeof parseTranscript> {
  const fold = createTranscriptFold(PREFIX)
  let prev = 0
  for (const s of [...splits, raw.length]) {
    fold.ingest(raw.slice(prev, s))
    prev = s
  }
  fold.finalize()
  return fold.messages()
}

test("chunked ingest at EVERY byte boundary equals the one-shot parse (fixture A: in-place un-gray)", () => {
  const oneShot = JSON.stringify(parseTranscript(FIXTURE_A, PREFIX))
  for (let i = 1; i < FIXTURE_A.length; i++) {
    assert.equal(JSON.stringify(foldChunks(FIXTURE_A, [i])), oneShot, `split at ${i} diverged`)
  }
})

test("chunked ingest at EVERY byte boundary equals the one-shot parse (fixture B: agent back-fill)", () => {
  const oneShot = JSON.stringify(parseTranscript(FIXTURE_B, PREFIX))
  for (let i = 1; i < FIXTURE_B.length; i++) {
    assert.equal(JSON.stringify(foldChunks(FIXTURE_B, [i])), oneShot, `split at ${i} diverged`)
  }
})

test("a split landing BETWEEN the enqueue and its delivery still resolves the bubble in place", () => {
  // Locate the exact byte offset of the newline separating the enqueue record from its delivery.
  const between = FIXTURE_A.indexOf(deliver("actually, also lint"))
  assert.ok(between > 0, "delivery record must be present in the fixture")
  const chunked = foldChunks(FIXTURE_A, [between])
  const oneShot = parseTranscript(FIXTURE_A, PREFIX)
  assert.equal(JSON.stringify(chunked), JSON.stringify(oneShot))
  // The delivered follow-up renders exactly once, un-grayed (queued:false).
  const delivered = chunked.filter((m) => m.role === "user" && m.text === "actually, also lint")
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].queued, false)
})

test("three-way and mid-record splits over both fixtures stay identical to one-shot", () => {
  for (const raw of [FIXTURE_A, FIXTURE_B]) {
    const oneShot = JSON.stringify(parseTranscript(raw, PREFIX))
    const a = Math.floor(raw.length / 3)
    const b = Math.floor((raw.length * 2) / 3)
    assert.equal(JSON.stringify(foldChunks(raw, [a, b])), oneShot)
    // Single-byte dribble — the most adversarial framing (every char is its own chunk).
    const everyByte = Array.from({ length: raw.length - 1 }, (_, i) => i + 1)
    assert.equal(JSON.stringify(foldChunks(raw, everyByte)), oneShot)
  }
})

test("trailing partial that PARSES is rendered once optimistically and never double-processed", () => {
  const head = [userLine("first"), asstText("m1", "hello")].join("\n")
  const last = userLine("second-and-final", "2026-07-01T00:00:05.000Z")
  const withoutNl = `${head}\n${last}` // no trailing newline → `last` is a trailing partial

  const fold = createTranscriptFold(PREFIX)
  fold.ingest(withoutNl) // optimistic consume: `last` parses, so it renders immediately
  // Incremental (no finalize) matches the one-shot, which finalizes the partial.
  assert.equal(JSON.stringify(fold.messages()), JSON.stringify(parseTranscript(withoutNl, PREFIX)))
  const afterFirstIngest = fold.messages().filter((m) => m.text === "second-and-final").length
  assert.equal(afterFirstIngest, 1, "optimistically-consumed partial rendered exactly once")

  // More data arrives: the newline that terminates `last`, then a new record. `last` must NOT re-render.
  const next = asstText("m2", "third", "2026-07-01T00:00:06.000Z")
  fold.ingest(`\n${next}\n`)
  const lastCount = fold.messages().filter((m) => m.text === "second-and-final").length
  assert.equal(lastCount, 1, "the trailing partial was not double-processed once its newline arrived")
  assert.equal(fold.messages().filter((m) => m.text === "third").length, 1)
  // Equivalent to a one-shot parse of the whole completed stream.
  assert.equal(JSON.stringify(fold.messages()), JSON.stringify(parseTranscript(`${withoutNl}\n${next}\n`, PREFIX)))
})

test("trailing partial that does NOT parse stays buffered until its bytes complete", () => {
  const head = [userLine("alpha"), asstText("m1", "beta")].join("\n")
  const full = userLine("gamma", "2026-07-01T00:00:07.000Z")
  const cut = Math.floor(full.length / 2)
  const torn = full.slice(0, cut) // a mid-record cut — invalid JSON

  const fold = createTranscriptFold(PREFIX)
  fold.ingest(`${head}\n${torn}`)
  assert.equal(fold.messages().filter((m) => m.text === "gamma").length, 0, "an unparseable partial does not render")
  assert.equal(JSON.stringify(fold.messages()), JSON.stringify(parseTranscript(`${head}\n`, PREFIX)))

  // The rest of the record arrives; now the line completes and renders.
  fold.ingest(`${full.slice(cut)}\n`)
  assert.equal(fold.messages().filter((m) => m.text === "gamma").length, 1)
  assert.equal(JSON.stringify(fold.messages()), JSON.stringify(parseTranscript([userLine("alpha"), asstText("m1", "beta"), full].join("\n") + "\n", PREFIX)))
})

test("consumedBytes is monotonic and reaches the full stream length after finalize", () => {
  const fold = createTranscriptFold(PREFIX)
  const total = Buffer.byteLength(FIXTURE_A)
  let last = fold.consumedBytes()
  assert.equal(last, 0)
  // Dribble in 7-byte chunks; consumedBytes never decreases.
  for (let i = 0; i < FIXTURE_A.length; i += 7) {
    fold.ingest(FIXTURE_A.slice(i, i + 7))
    const now = fold.consumedBytes()
    assert.ok(now >= last, `consumedBytes went backwards: ${now} < ${last}`)
    last = now
  }
  fold.finalize()
  assert.equal(fold.consumedBytes(), total, "after finalize the fold has consumed the whole stream")
})

// ── cache behavior via readTranscript (real ~/.claude/projects/<slug>/<id>.jsonl layout) ─────────────
function cacheHarness() {
  const slug = `-tmp-frizz-incr-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const logDir = join(homedir(), ".claude", "projects", slug)
  mkdirSync(logDir, { recursive: true })
  const sessionId = "sess"
  const path = join(logDir, `${sessionId}.jsonl`)
  const project = { cwdSlug: slug } as unknown as Project
  const write = (lines: string[]) => writeFileSync(path, lines.map((l) => l + "\n").join(""))
  const append = (lines: string[]) => appendFileSync(path, lines.map((l) => l + "\n").join(""))
  const cleanup = () => { try { rmSync(logDir, { recursive: true, force: true }) } catch { /* best-effort */ } }
  return { slug, sessionId, path, project, write, append, cleanup }
}

test("readTranscript cache: append reflects, no-op read is stable, truncation forces a clean re-fold", () => {
  __clearTranscriptCacheForTests()
  const h = cacheHarness()
  try {
    // 1) initial read parses the whole file
    h.write([userLine("q1"), asstText("m1", "a1")])
    let msgs = readTranscript(h.project, h.sessionId)
    assert.equal(msgs.length, 2)
    assert.equal(msgs[0].text, "q1")

    // 2) a no-op read (no growth) returns the same content — and a fresh array each call (defensive slice)
    const again = readTranscript(h.project, h.sessionId)
    assert.equal(JSON.stringify(again), JSON.stringify(msgs))
    assert.notStrictEqual(again, msgs, "each read returns a defensive shallow copy, not the retained array")

    // 3) appending records reflects on the next read (incremental fold of the appended bytes only)
    h.append([asstText("m2", "a2"), userLine("q2", "2026-07-01T00:00:05.000Z")])
    msgs = readTranscript(h.project, h.sessionId)
    assert.deepEqual(msgs.map((m) => m.text), ["q1", "a1", "a2", "q2"])
    // The incremental result must equal a from-scratch parse of the current file.
    assert.equal(JSON.stringify(msgs), JSON.stringify(projectClaudeTranscript(readFileWhole(h.path), `claude:${h.sessionId}`)))

    // 4) an in-place mutation delivered via appended bytes (enqueue then delivery on a later read).
    // A LIVE timestamp, unlike every other fixture line here: readTranscript applies the clock backstop
    // (retireStaleQueuedBubbles), which correctly refuses to render a bubble enqueued in 2026-07-01 as
    // still-waiting. What this step tests is the in-place un-graying, so the bubble has to be gray first.
    const justNow = new Date().toISOString()
    h.append([enqueue("steer it", justNow)])
    msgs = readTranscript(h.project, h.sessionId)
    assert.equal(msgs.filter((m) => m.queued === true && m.text === "steer it").length, 1, "enqueue → gray bubble")
    h.append([deliver("steer it", justNow)])
    msgs = readTranscript(h.project, h.sessionId)
    const steer = msgs.filter((m) => m.text === "steer it")
    assert.equal(steer.length, 1)
    assert.equal(steer[0].queued, false, "delivery un-grays the earlier bubble IN PLACE across reads")

    // 5) truncate the file to something SHORTER → size < consumedBytes → drop + full re-fold, no stale rows
    h.write([userLine("only line now")])
    msgs = readTranscript(h.project, h.sessionId)
    assert.deepEqual(msgs.map((m) => m.text), ["only line now"], "truncation re-folds from scratch; no stale rows survive")
  } finally {
    h.cleanup()
  }
})

test("readTranscript: a long-stale enqueue is never rendered as still-waiting, whatever its delivery looked like", () => {
  // The reader-level guarantee, exercised through the REAL funnel rather than the pure helper: the fold
  // recognizes a delivery by record SHAPE, so a shape a future harness version invents strands its bubble
  // — and the FIFO backstop can't help the NEWEST message, because nothing later ever resolves. This is
  // what stops that from being visible forever. The fixture's enqueue has no delivery record AT ALL,
  // which is the worst case: unrecognized and last.
  __clearTranscriptCacheForTests()
  const h = cacheHarness()
  try {
    h.write([userLine("q1"), enqueue("a delivery shape from a future release", "2026-07-01T00:00:02.000Z")])
    const msgs = readTranscript(h.project, h.sessionId)
    const stranded = msgs.filter((m) => m.text === "a delivery shape from a future release")
    assert.equal(stranded.length, 1, "the message must still be rendered — never spliced, it is the human's own words")
    assert.equal(stranded[0].queued, false, "but not as a gray bubble, hours after it was sent")
  } finally {
    h.cleanup()
  }
})

test("readTranscript: a missing file returns [] (agent still booting)", () => {
  __clearTranscriptCacheForTests()
  const project = { cwdSlug: `-tmp-frizz-incr-missing-${process.pid}` } as unknown as Project
  assert.deepEqual(readTranscript(project, "nope"), [])
})

// ── perf proof: 20 appended-then-read cycles, whole-file re-parse (before) vs retained fold (after) ──
function readFileWhole(path: string): string {
  return readFileSync(path, "utf8")
}

test("perf: retained fold is dramatically cheaper than re-parsing the whole file per read", () => {
  __clearTranscriptCacheForTests()
  // Build a ~2MB / ~2000-record synthetic transcript: distinct assistant turns (~1KB text each) so no
  // record merges and the projection is large.
  const body = "x".repeat(950)
  const rec = (n: number) => asstText(`m${n}`, `${body} #${n}`, `2026-07-01T00:00:00.000Z`)
  const RECORDS = 2000

  // BEFORE: parseTranscript over the entire file each read.
  const hBefore = cacheHarness()
  // AFTER: readTranscript (retained incremental fold).
  const hAfter = cacheHarness()
  try {
    const base = Array.from({ length: RECORDS }, (_, i) => rec(i))
    hBefore.write(base)
    hAfter.write(base)
    const bytes = Buffer.byteLength(base.map((l) => l + "\n").join(""))

    const ITERS = 20
    // BEFORE
    const t0 = performance.now()
    for (let i = 0; i < ITERS; i++) {
      appendFileSync(hBefore.path, rec(RECORDS + i) + "\n")
      parseTranscript(readFileWhole(hBefore.path), `claude:${hBefore.sessionId}`)
    }
    const beforeMs = performance.now() - t0

    // AFTER — prime the cache once (full fold), then 20 appended-byte reads.
    readTranscript(hAfter.project, hAfter.sessionId)
    const t1 = performance.now()
    for (let i = 0; i < ITERS; i++) {
      appendFileSync(hAfter.path, rec(RECORDS + i) + "\n")
      readTranscript(hAfter.project, hAfter.sessionId)
    }
    const afterMs = performance.now() - t1

    // Correctness: after 20 appends both paths agree on the final projection.
    const finalBefore = parseTranscript(readFileWhole(hBefore.path), `claude:${hBefore.sessionId}`)
    const finalAfter = readTranscript(hAfter.project, hAfter.sessionId)
    assert.equal(JSON.stringify(finalAfter), JSON.stringify(finalBefore), "incremental and whole-file parse agree after 20 appends")

    // eslint-disable-next-line no-console
    console.log(
      `[perf] transcript ~${(bytes / 1e6).toFixed(2)}MB / ${RECORDS} records, ${ITERS} appended reads:\n` +
        `        BEFORE (whole-file re-parse): ${beforeMs.toFixed(1)}ms total, ${(beforeMs / ITERS).toFixed(2)}ms/read\n` +
        `        AFTER  (retained fold)      : ${afterMs.toFixed(1)}ms total, ${(afterMs / ITERS).toFixed(2)}ms/read`,
    )
    // The incremental fold reads O(appended) bytes, not O(whole file), so it must be materially cheaper.
    assert.ok(afterMs < beforeMs, `expected retained fold (${afterMs.toFixed(1)}ms) < whole-file re-parse (${beforeMs.toFixed(1)}ms)`)
  } finally {
    hBefore.cleanup()
    hAfter.cleanup()
  }
})

// A FOLD NOBODY READS FOR TRANSCRIPT_FOLD_IDLE_MS IS DROPPED, and a reader that comes back gets the same
// messages from a fresh fold.
test("readTranscript cache: an idle fold is swept, a recent one is kept, and a later read re-folds it whole", () => {
  __clearTranscriptCacheForTests()
  const h = cacheHarness()
  try {
    h.write([userLine("q1"), asstText("m1", "a1")])
    const first = readTranscript(h.project, h.sessionId)
    const readAt = Date.now()
    assert.equal(sweepIdleTranscriptFolds(readAt + TRANSCRIPT_FOLD_IDLE_MS - 1_000), 0, "a fold read inside the window stays")
    assert.equal(sweepIdleTranscriptFolds(readAt + TRANSCRIPT_FOLD_IDLE_MS + 1_000), 1, "a fold idle past the window goes")
    assert.equal(sweepIdleTranscriptFolds(readAt + TRANSCRIPT_FOLD_IDLE_MS + 1_000), 0, "and is gone")
    h.append([asstText("m2", "a2")])
    const again = readTranscript(h.project, h.sessionId)
    assert.deepEqual(again.map((m) => m.text), [...first.map((m) => m.text), "a2"])
  } finally {
    h.cleanup()
  }
})
