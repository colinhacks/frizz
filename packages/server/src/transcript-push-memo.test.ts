import { test } from "node:test"
import assert from "node:assert/strict"
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { __clearTranscriptCacheForTests, readLatestThreadTranscriptPage, projectRetiredBackgroundOps, projectTranscriptAgentLifecycles, readEarlierThreadTranscriptPage } from "./transcript.ts"
import type { TranscriptMessage } from "@frizz/shared"
import { makeTranscriptReader, type TranscriptPush } from "./app-socket.ts"
import { MessageJsonMemo } from "./message-json-memo.ts"
import { createStorage } from "./storage.ts"
import type { Project } from "./project.ts"

// A SUBSCRIBED thread's push is read from the retained fold and encoded from the subscription's JSON memo
// (message-json-memo.ts), so a read costs what changed. What it sends must still be EXACTLY what a cold read
// of the same bytes sends: a fold from byte 0, no memo, plain JSON.stringify. Each test grows or rewrites a
// real JSONL on disk and, after every change, compares the two — the same comparison the socket's
// FRIZZ_TRANSCRIPT_PUSH_VERIFY net makes on a running server.

const TS = "2026-07-01T00:00:00.000Z"
const user = (text: string) => JSON.stringify({ type: "user", timestamp: TS, message: { role: "user", content: text } })
const say = (mid: string, text: string) => JSON.stringify({ type: "assistant", timestamp: TS, message: { id: mid, content: [{ type: "text", text }] } })
const tool = (mid: string, id: string, name: string, input: unknown) =>
  JSON.stringify({ type: "assistant", timestamp: TS, message: { id: mid, content: [{ type: "tool_use", id, name, input }] } })
const result = (id: string, content: string) =>
  JSON.stringify({ type: "user", timestamp: TS, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } })
const enqueue = (content: string) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: TS, content })
const deliver = (prompt: string) =>
  JSON.stringify({ type: "attachment", timestamp: TS, attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind: "human" } } })
const notify = (id: string, status: string) =>
  JSON.stringify({ type: "queue-operation", timestamp: TS, content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>` })
const compactBoundary = () => JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: TS })

// A long, live-shaped session: tool results that land a few records after their call (a back-fill behind
// the tail), queued sends delivered later (an un-gray in place), an Agent and a background Monitor whose
// completions arrive hundreds of records on — the Monitor scrolls out of the window first, so it rides as a
// pinned row until it ends — and a compaction in the middle. 360 tool exchanges put the window's head well
// past message 0, so every page carries a cursor.
function sessionLines(tag: string): string[] {
  const lines = [user(`${tag}: start the work`), tool("m-mon", `${tag}-mon`, "Monitor", { command: "tail -f log", description: "watch the log" }), result(`${tag}-mon`, "Monitor started (task t1)")]
  lines.push(tool("m-agent", `${tag}-agent`, "Agent", { description: "Audit the flow", subagent_type: "claude", prompt: "audit" }), result(`${tag}-agent`, "launched"))
  const late: string[] = []
  for (let i = 0; i < 360; i++) {
    lines.push(tool(`m${i}`, `${tag}-b${i}`, "Bash", { command: `step ${i}`, description: `Step ${i}` }))
    // Every third result is a long capture (what a real Read or test run returns), the kind of message the
    // memo keeps a shadow for; the rest are short, and are serialized afresh each read.
    late.push(result(`${tag}-b${i}`, `ok ${i} ${"y".repeat(i % 3 === 0 ? 3000 : i % 7 * 30)}`))
    if (late.length > 3) lines.push(late.shift()!)
    if (i % 40 === 5) lines.push(enqueue(`${tag} follow-up ${i}`))
    if (i % 40 === 9) lines.push(deliver(`${tag} follow-up ${i - 4}`))
    if (i % 50 === 20) lines.push(say(`s${i}`, `progress ${i}`))
    // A long reply written as two records of one message: the second is merged into the first IN PLACE,
    // after a read may already have kept the first's JSON.
    if (i % 25 === 12) lines.push(say(`long${i}`, `${"r".repeat(2500)} part one`), say(`long${i}`, "part two"))
    if (i === 180) lines.push(compactBoundary())
    if (i === 250) lines.push(notify(`${tag}-agent`, "completed"))
  }
  lines.push(...late, notify(`${tag}-mon`, "completed"), say("end", "done"))
  return lines
}

function harness() {
  const cwdSlug = `-tmp-frizz-push-memo-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const logDir = join(homedir(), ".claude", "projects", cwdSlug)
  mkdirSync(logDir, { recursive: true })
  const sid = `push-memo-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const store = createStorage(join(mkdtempSync(join(tmpdir(), "frizz-push-memo-")), "ui.db"), "p")
  const row = { slug: "t", session_id: sid, thread_name: "frizz-t", spawned_at: new Date().toISOString(), last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: "open", meta: null, seen_at: null, transcript_id: null as string | null }
  store.upsertSession(row)
  const project = { cwdSlug } as unknown as Project
  return {
    sid,
    row,
    store,
    project,
    logDir,
    path: join(logDir, `${sid}.jsonl`),
    read: makeTranscriptReader(project, store),
    cleanup: () => rmSync(logDir, { recursive: true, force: true }),
  }
}

/** The push a memo'd warm read encodes, against a cold read of the same bytes. */
function assertPushIsCold(h: ReturnType<typeof harness>, memo: MessageJsonMemo, label: string): TranscriptPush {
  memo.rotate()
  const warm = h.read("t", memo)!
  assert.ok(warm.bytes !== undefined, `${label}: the warm read names its size`)
  const warmParts = warm.messages.map((m) => memo.json(m))
  const cold = h.read("t", undefined, warm.bytes)
  assert.ok(cold, `${label}: a cold read of the same ${warm.bytes} bytes`)
  assert.deepEqual(warmParts, cold.messages.map((m) => JSON.stringify(m)), `${label}: messages`)
  assert.equal(JSON.stringify(warm.page), JSON.stringify(cold.page), `${label}: page envelope`)
  return warm
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

test("a live transcript appended in arbitrary byte slices pushes, at every read, exactly what a cold read of those bytes does", () => {
  __clearTranscriptCacheForTests()
  const h = harness()
  try {
    const raw = sessionLines("live").map((l) => l + "\n").join("")
    const r = rng(7)
    const memo = new MessageJsonMemo()
    writeFileSync(h.path, "")
    let at = 0
    let reads = 0
    let pinnedSeen = false
    while (at < raw.length) {
      // Slices from a few bytes to a few records, cut anywhere, mid-line and mid-character included.
      const next = Math.min(raw.length, at + 1 + Math.floor(r() * (r() < 0.2 ? 4000 : 400)))
      appendFileSync(h.path, raw.slice(at, next))
      at = next
      const push = assertPushIsCold(h, memo, `after ${at} of ${raw.length} bytes`)
      if (push.messages.some((m) => m.pinnedFromSourceId)) pinnedSeen = true
      reads++
    }
    assert.ok(reads > 100, `${reads} reads`)
    assert.ok(pinnedSeen, "the Monitor rode as a pinned row once it left the window")
    assert.ok(memo.size > 50, `the memo kept the long messages across reads (${memo.size})`)
    assert.ok(memo.hits > memo.misses, `${memo.hits} hits, ${memo.misses} misses`)
  } finally {
    h.cleanup()
  }
})

test("a transcript truncated and rewritten under the same path pushes what a cold read does, before and after it grows again", () => {
  __clearTranscriptCacheForTests()
  const h = harness()
  try {
    const memo = new MessageJsonMemo()
    const first = sessionLines("one").map((l) => l + "\n").join("")
    writeFileSync(h.path, first)
    assertPushIsCold(h, memo, "first file")
    // Shorter, different content, the same sourceIds at the same byte offsets for its first records.
    const second = sessionLines("two").slice(0, 400).map((l) => l + "\n").join("")
    writeFileSync(h.path, second)
    assertPushIsCold(h, memo, "rewritten shorter")
    appendFileSync(h.path, sessionLines("two").slice(400, 500).map((l) => l + "\n").join(""))
    assertPushIsCold(h, memo, "rewritten, then grown")
  } finally {
    h.cleanup()
  }
})

test("a resumed session that writes a new file pushes what a cold read of the new file does", () => {
  __clearTranscriptCacheForTests()
  const h = harness()
  try {
    const memo = new MessageJsonMemo()
    writeFileSync(h.path, sessionLines("old").map((l) => l + "\n").join(""))
    assertPushIsCold(h, memo, "old file")
    const resumed = `${h.sid}-resumed`
    writeFileSync(join(h.logDir, `${resumed}.jsonl`), sessionLines("old").slice(0, 300).map((l) => l + "\n").join(""))
    h.store.upsertSession({ ...h.row, transcript_id: resumed })
    assertPushIsCold(h, memo, "rebound to the new file")
    appendFileSync(join(h.logDir, `${resumed}.jsonl`), [compactBoundary(), user("after the resume"), say("r1", "resumed")].map((l) => l + "\n").join(""))
    assertPushIsCold(h, memo, "the new file grown, past a compaction")
  } finally {
    h.cleanup()
  }
})

test("loading an earlier page between pushes changes nothing the next push sends", () => {
  __clearTranscriptCacheForTests()
  const h = harness()
  try {
    const memo = new MessageJsonMemo()
    const lines = sessionLines("pages")
    writeFileSync(h.path, lines.slice(0, 700).map((l) => l + "\n").join(""))
    let push = assertPushIsCold(h, memo, "before")
    for (let i = 700; i < lines.length; i += 37) {
      let cursor = push.page?.beforeCursor ?? null
      for (let pages = 0; cursor && pages < 3; pages++) cursor = readEarlierThreadTranscriptPage(h.project, h.store, "t", cursor).beforeCursor
      appendFileSync(h.path, lines.slice(i, i + 37).map((l) => l + "\n").join(""))
      push = assertPushIsCold(h, memo, `after ${i + 37} records`)
    }
  } finally {
    h.cleanup()
  }
})

test("the socket's tool projections copy only the messages they change, and change none of the JSON", () => {
  const plain = { sourceId: "a", role: "assistant", text: "x", tools: [{ name: "Bash", status: "completed" }], parts: [{ kind: "text", text: "x" }] } as unknown as TranscriptMessage
  const call = { name: "Agent", agentId: "child", status: "pending" }
  const dispatch = { sourceId: "b", role: "assistant", text: "", tools: [call], parts: [{ kind: "tools", tools: [call] }] } as unknown as TranscriptMessage
  const shell = { name: "Bash", shellId: "sh1", status: "pending", backgroundState: "background" }
  const launch = { sourceId: "c", role: "assistant", text: "", tools: [shell], parts: [{ kind: "tools", tools: [shell] }] } as unknown as TranscriptMessage
  const window = [plain, dispatch, launch]
  // What the projections did before: a spread copy of every message, every read.
  const copyAll = (messages: TranscriptMessage[], project: (c: any) => any) =>
    messages.map((m) => ({ ...m, tools: m.tools.map(project), parts: m.parts.map((p) => p.kind === "tools" ? { ...p, tools: p.tools.map(project) } : p) }))

  const none = projectTranscriptAgentLifecycles(window, () => undefined)
  assert.deepEqual(none.map((m, i) => m === window[i]), [true, true, true], "nothing to project: every message is handed on as it is")
  const done = projectTranscriptAgentLifecycles(window, () => ({ outcome: "completed", startedAt: TS, finishedAt: "2026-07-01T00:00:05.000Z" }) as any)
  assert.deepEqual(done.map((m, i) => m === window[i]), [true, false, true], "only the dispatch is copied")
  assert.equal(JSON.stringify(done[1]), JSON.stringify(copyAll([dispatch], (c) => c.agentId ? { ...c, agentStatus: "completed", agentElapsedMs: 5000 } : c)[0]))
  assert.equal(call.status, "pending", "the fold's own call is never written")

  const retired = projectRetiredBackgroundOps(window, new Set(["sh1"]))
  assert.deepEqual(retired.map((m, i) => m === window[i]), [true, true, false], "only the retired launch is copied")
  assert.equal(JSON.stringify(retired), JSON.stringify(copyAll(window, (c) => c.shellId === "sh1" ? { ...c, status: "cancelled" } : c)))
  assert.equal(shell.status, "pending")
})

test("a read of a live transcript opens the file once, however many ranges it reads", () => {
  __clearTranscriptCacheForTests()
  const h = harness()
  try {
    const lines = sessionLines("opens")
    writeFileSync(h.path, lines.slice(0, 600).map((l) => l + "\n").join(""))
    readLatestThreadTranscriptPage(h.project, h.store, "t")
    appendFileSync(h.path, lines.slice(600, 620).map((l) => l + "\n").join(""))
    const realOpen = fs.openSync
    const realClose = fs.closeSync
    let opens = 0
    let closes = 0
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) === h.path) opens++
      return realOpen(...args)
    }) as typeof fs.openSync
    fs.closeSync = ((fd: number) => {
      closes++
      return realClose(fd)
    }) as typeof fs.closeSync
    syncBuiltinESMExports()
    let page
    try {
      page = readLatestThreadTranscriptPage(h.project, h.store, "t")
    } finally {
      fs.openSync = realOpen
      fs.closeSync = realClose
      syncBuiltinESMExports()
    }
    assert.ok(page.beforeCursor, "the read minted a cursor, so it read the appended bytes twice: for the fold and for the digest")
    assert.equal(opens, 1, "one open for the snapshot, its range reads through the same descriptor")
    assert.equal(closes, opens, "and every descriptor is closed when the read returns")
  } finally {
    h.cleanup()
  }
})
