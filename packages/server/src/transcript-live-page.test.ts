import { test } from "node:test"
import assert from "node:assert/strict"
import fs, { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import {
  __clearTranscriptCacheForTests,
  __setTranscriptCacheBudgetForTests,
  catchUpTranscriptFold,
  latestTranscriptWindow,
  latestWindowStart,
  readEarlierThreadTranscriptPage,
  readLatestThreadTranscriptPage,
  readLatestThreadTranscriptPageWithFiles,
  projectClaudeTranscript,
  readClaudeTranscriptOpening,
  readLastAssistantText,
  readThreadTranscript,
  transcriptFoldCaughtUp,
} from "./transcript.ts"
import { createStorage } from "./storage.ts"
import { captureLogRecords } from "./logging.ts"
import type { Project } from "./project.ts"

// What the latest-page read costs on a LIVE transcript: the /ws producer runs it after every append of
// every subscribed working thread, so anything it does over the WHOLE file is paid once per push.

const USER = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-07-10T18:00:00.000Z", message: { role: "user", content: text } })
const ASSISTANT = (id: string, text: string) =>
  JSON.stringify({ type: "assistant", timestamp: "2026-07-10T18:00:01.000Z", message: { id, content: [{ type: "text", text }] } })
// One exchange is two projected messages; 160 of them put the latest window's head past message 0, so
// every page carries a cursor — the case that hashes the transcript.
const exchanges = (from: number, n: number) => {
  const lines: string[] = []
  for (let i = from; i < from + n; i++) lines.push(USER(`user-${i}`), ASSISTANT(`a-${i}`, `assistant-${i} ${"x".repeat(200)}`))
  return lines.map((line) => line + "\n").join("")
}

function harness() {
  const slug = `-tmp-frizz-live-page-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const logDir = join(homedir(), ".claude", "projects", slug)
  mkdirSync(logDir, { recursive: true })
  // A session id of its own: a reader that finds no file in its bucket searches every bucket under
  // ~/.claude/projects for one of the same name, so a shared "sid" here answers another suite's read.
  const sid = `live-page-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const store = createStorage(join(mkdtempSync(join(tmpdir(), "frizz-live-page-")), "ui.db"), "p")
  store.upsertSession({ slug: "t", session_id: sid, thread_name: "frizz-t", spawned_at: new Date().toISOString(), last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: "open", meta: null, seen_at: null, transcript_id: null })
  const project = { cwdSlug: slug } as unknown as Project
  const path = join(logDir, `${sid}.jsonl`)
  return { sid, store, project, path, cleanup: () => rmSync(logDir, { recursive: true, force: true }) }
}

const cursorOf = (cursor: string) => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { prefixDigest: string; snapshotBytes: number }
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("base64url")

/** Bytes `fs.readSync` returns while `fn` runs — transcript.ts reads every file through it. */
function bytesRead(fn: () => void): number {
  const real = fs.readSync
  let total = 0
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const n = (real as (...a: Parameters<typeof fs.readSync>) => number)(...args)
    total += n
    return n
  }) as typeof fs.readSync
  syncBuiltinESMExports()
  try {
    fn()
  } finally {
    fs.readSync = real
    syncBuiltinESMExports()
  }
  return total
}

test("a live transcript's page cursor hashes only the bytes appended since the last read, and still names the whole prefix", () => {
  const h = harness()
  try {
    writeFileSync(h.path, exchanges(0, 160))
    const first = readLatestThreadTranscriptPage(h.project, h.store, "t")
    assert.ok(first.beforeCursor, "160 exchanges put the window head past the start, so the page carries a cursor")
    assert.equal(cursorOf(first.beforeCursor!).prefixDigest, sha256(readFileSync(h.path)))

    for (let round = 0; round < 3; round++) {
      const delta = exchanges(1000 + round, 1)
      appendFileSync(h.path, delta)
      let page!: ReturnType<typeof readLatestThreadTranscriptPage>
      const read = bytesRead(() => { page = readLatestThreadTranscriptPage(h.project, h.store, "t") })
      const whole = readFileSync(h.path)
      const cursor = cursorOf(page.beforeCursor!)
      assert.equal(cursor.snapshotBytes, whole.length)
      assert.equal(cursor.prefixDigest, sha256(whole), `round ${round}: the running digest is the digest of the whole file`)
      // The retained fold reads the delta once and the digest reads it once. It used to re-read the
      // whole file for the digest on every append, because its memo was keyed on the file's length.
      assert.ok(read <= 2 * Buffer.byteLength(delta), `round ${round}: read ${read} bytes for a ${Buffer.byteLength(delta)}-byte append of a ${whole.length}-byte file`)
    }

    // And the cursor it minted pages back exactly as before.
    const latest = readLatestThreadTranscriptPage(h.project, h.store, "t")
    const earlier = readEarlierThreadTranscriptPage(h.project, h.store, "t", latest.beforeCursor!)
    assert.ok(earlier.messages.length > 0)
  } finally {
    h.cleanup()
  }
})

test("a transcript rewritten SHORTER in place starts its digest over", () => {
  const h = harness()
  try {
    writeFileSync(h.path, exchanges(0, 170))
    readLatestThreadTranscriptPage(h.project, h.store, "t")
    // Same inode, fewer bytes: the hashed prefix is no longer this file's.
    writeFileSync(h.path, exchanges(500, 160))
    const page = readLatestThreadTranscriptPage(h.project, h.store, "t")
    assert.equal(cursorOf(page.beforeCursor!).prefixDigest, sha256(readFileSync(h.path)))
  } finally {
    h.cleanup()
  }
})

test("a cursor whose prefix changed is still refused — the validation re-reads the prefix it names", () => {
  const h = harness()
  try {
    writeFileSync(h.path, exchanges(0, 160))
    const page = readLatestThreadTranscriptPage(h.project, h.store, "t")
    // Rewrite one byte inside the prefix without changing the length (same inode, same size).
    const bytes = readFileSync(h.path)
    const at = bytes.indexOf("user-3")
    bytes[at] = "U".charCodeAt(0)
    writeFileSync(h.path, bytes)
    assert.throws(() => readEarlierThreadTranscriptPage(h.project, h.store, "t", page.beforeCursor!), /prior transcript bytes changed/)
  } finally {
    h.cleanup()
  }
})

test("latestTranscriptWindow given the head it would compute returns the identical window", () => {
  const all = projectClaudeTranscript(exchanges(0, 450))
  const start = latestWindowStart(all)
  assert.ok(start > 0)
  assert.deepEqual(latestTranscriptWindow(all, start), latestTranscriptWindow(all))
})

test("a cold fold runs in slices with the event loop between them, and the read after it sees what one whole fold would", async () => {
  const h = harness()
  try {
    // A record far longer than a slice, in multi-byte text, so slices cut it and cut characters. Eight
    // megabytes, because a slice is a time budget: an idle machine folds two in two slices.
    const body = exchanges(0, 16000) + ASSISTANT("long", "é".repeat(300_000)) + "\n" + exchanges(16000, 100)
    writeFileSync(h.path, body)
    __clearTranscriptCacheForTests()

    const folding = catchUpTranscriptFold(h.project, h.store, "t")
    assert.ok(folding, "eight megabytes of cold transcript is worth slicing")
    assert.equal(catchUpTranscriptFold(h.project, h.store, "t"), folding, "a second reader shares the fold in progress")

    let turns = 0
    let turning = true
    const turn = () => { if (turning) { turns++; setImmediate(turn) } }
    setImmediate(turn)
    await folding
    turning = false
    assert.ok(turns >= 3, `the event loop only came round ${turns} times`)

    assert.equal(catchUpTranscriptFold(h.project, h.store, "t"), undefined, "caught up, so the read goes ahead")
    const whole = latestTranscriptWindow(projectClaudeTranscript(body, `claude:${h.sid}`))
    assert.deepEqual(readLatestThreadTranscriptPage(h.project, h.store, "t").messages, whole)

    // What a retained fold has left to do is one appended record: nothing to slice.
    appendFileSync(h.path, exchanges(16100, 1))
    assert.equal(catchUpTranscriptFold(h.project, h.store, "t"), undefined)

    // A large append is sliced the same way, from where the fold had got to.
    const appended = exchanges(16101, 2000)
    appendFileSync(h.path, appended)
    const more = catchUpTranscriptFold(h.project, h.store, "t")
    assert.ok(more)
    await more
    assert.deepEqual(
      readLatestThreadTranscriptPage(h.project, h.store, "t").messages,
      latestTranscriptWindow(projectClaudeTranscript(body + exchanges(16100, 1) + appended, `claude:${h.sid}`)),
    )
  } finally {
    __clearTranscriptCacheForTests()
    h.cleanup()
  }
})

test("a thread's opening message is read off the head of its transcript, however long the thread has run", () => {
  const h = harness()
  try {
    // 3,000 exchanges after the opening: the latest window starts thousands of messages in.
    writeFileSync(h.path, USER("the task the thread was opened with") + "\n" + exchanges(0, 3000))
    __clearTranscriptCacheForTests()
    const size = fs.statSync(h.path).size
    assert.ok(size > 1024 * 1024, "the transcript must be several steps long")
    const windowed = readLatestThreadTranscriptPage(h.project, h.store, "t").messages.find((m) => m.role === "user")
    assert.match(windowed!.text, /^user-\d+$/, "the window's first user message is from the middle of the thread")

    let opening: ReturnType<typeof readClaudeTranscriptOpening>
    const read = bytesRead(() => { opening = readClaudeTranscriptOpening(h.project, h.sid) })
    assert.equal(opening!.text, "the task the thread was opened with")
    assert.ok(read <= 256 * 1024, `the opening is in the first step, and ${read} of ${size} bytes were read`)
  } finally {
    __clearTranscriptCacheForTests()
    h.cleanup()
  }
})

test("a thread's opening message is found past the first step: a long one, and one still queued in the first", () => {
  const h = harness()
  try {
    // Longer than two steps, in two-byte characters, so the steps cut the record and cut characters.
    const long = "é".repeat(300_000)
    writeFileSync(h.path, USER(long) + "\n" + exchanges(0, 50))
    assert.equal(readClaudeTranscriptOpening(h.project, h.sid)?.text, long)

    // A send the runtime has not handed over yet is a queued bubble. Its delivery is a later record, and
    // that is the message the thread opened with: a step that ends between the two must read on.
    const enqueued = JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-07-10T18:00:00.000Z", content: "queued, then delivered" })
    const sidecar = JSON.stringify({ type: "attachment", timestamp: "2026-07-10T18:00:00.500Z", attachment: { type: "hook_additional_context", content: "x".repeat(300_000) } })
    const delivered = JSON.stringify({ type: "attachment", timestamp: "2026-07-10T18:00:01.000Z", attachment: { type: "queued_command", prompt: "queued, then delivered", commandMode: "prompt", origin: { kind: "human" } } })
    writeFileSync(h.path, [enqueued, sidecar, delivered].join("\n") + "\n" + exchanges(0, 50))
    const opening = readClaudeTranscriptOpening(h.project, h.sid)
    assert.equal(opening?.text, "queued, then delivered")
    assert.ok(!opening?.queued, "the delivered message, not the bubble that was waiting for it")

    // Only ever queued: that is still what the thread was asked.
    writeFileSync(h.path, enqueued + "\n")
    assert.equal(readClaudeTranscriptOpening(h.project, h.sid)?.text, "queued, then delivered")

    // Nothing from the human at all, and no file.
    writeFileSync(h.path, ASSISTANT("a-0", "spoke first") + "\n")
    assert.equal(readClaudeTranscriptOpening(h.project, h.sid), undefined)
    assert.equal(readClaudeTranscriptOpening(h.project, `absent-${h.sid}`), undefined)
  } finally {
    h.cleanup()
  }
})

test("a thread's last words are read with the event loop running, and are what the whole-file reader would say", async () => {
  const h = harness()
  try {
    // Eight megabytes nobody has opened: no fold of it is retained, which is how a child thread's
    // transcript stands when its rest is handed to its parent.
    const last = `the handoff, ${"é".repeat(2000)}`
    writeFileSync(h.path, exchanges(0, 16000) + ASSISTANT("long", "é".repeat(300_000)) + "\n" + USER("one more thing") + "\n" + ASSISTANT("final", last) + "\n")
    __clearTranscriptCacheForTests()

    let turns = 0
    let turning = true
    const turn = () => { if (turning) { turns++; setImmediate(turn) } }
    setImmediate(turn)
    const said = await readLastAssistantText(h.project, h.store, "t")
    turning = false
    assert.equal(said, last)
    assert.ok(turns >= 3, `the event loop only came round ${turns} times while the transcript was folded`)
    // The fold it waited for is the one the reader uses: nothing is left to read.
    assert.equal(bytesRead(() => { readThreadTranscript(h.project, h.store, "t") }), 0)

    assert.equal(await readLastAssistantText(h.project, h.store, "no-such-thread"), undefined)
  } finally {
    __clearTranscriptCacheForTests()
    h.cleanup()
  }
})

test("a small cold transcript, and a thread with no transcript, have nothing to wait for", () => {
  const h = harness()
  try {
    assert.equal(catchUpTranscriptFold(h.project, h.store, "t"), undefined, "no file yet")
    assert.equal(catchUpTranscriptFold(h.project, h.store, "no-such-thread"), undefined)
    writeFileSync(h.path, exchanges(0, 10))
    __clearTranscriptCacheForTests()
    assert.equal(catchUpTranscriptFold(h.project, h.store, "t"), undefined)
  } finally {
    __clearTranscriptCacheForTests()
    h.cleanup()
  }
})

test("many cold threads at once all finish, whatever order they queue in", async () => {
  const h = harness()
  try {
    // Terminal sessions Frizz did not start: their ids are their slugs, and no row is needed.
    const threads = Array.from({ length: 12 }, (_, i) => `aaaaaaaa-${String(i).padStart(4, "0")}`)
    for (const id of threads) writeFileSync(join(h.path, "..", `${id}.jsonl`), exchanges(0, 1500))
    __clearTranscriptCacheForTests()
    await Promise.all(threads.map((id) => transcriptFoldCaughtUp(h.project, h.store, id)))
    for (const id of threads) assert.equal(catchUpTranscriptFold(h.project, h.store, id), undefined, id)
  } finally {
    __clearTranscriptCacheForTests()
    h.cleanup()
  }
})

test("a board of forty threads keeps a fold for each: reading them all again reads nothing from disk", () => {
  const h = harness()
  try {
    // Terminal sessions Frizz did not start: their ids are their slugs, and no row is needed. Short
    // enough that a page has no cursor, so a read of a thread whose fold is retained touches no file.
    const threads = Array.from({ length: 40 }, (_, i) => `bbbbbbbb-${String(i).padStart(4, "0")}`)
    for (const id of threads) writeFileSync(join(h.path, "..", `${id}.jsonl`), exchanges(0, 20))
    __clearTranscriptCacheForTests()
    const readAll = () => { for (const id of threads) assert.equal(readLatestThreadTranscriptPage(h.project, h.store, id).messages.length, 40, id) }
    assert.ok(bytesRead(readAll) > 0, "the first pass folds every file")
    // Sixteen folds were kept, whatever they held, so twenty-four of these were folded again on every pass.
    assert.equal(bytesRead(readAll), 0, "the second pass finds every fold where it left it")
  } finally {
    __clearTranscriptCacheForTests()
    h.cleanup()
  }
})

test("over their byte budget the retained folds go least recently read first, never below sixteen, and a large one is logged", async () => {
  const h = harness()
  const log = captureLogRecords()
  try {
    const big = "cccccccc-b190" // hex, as a terminal session's id is: anything else is not a thread at all
    const small = Array.from({ length: 20 }, (_, i) => `cccccccc-${String(i).padStart(4, "0")}`)
    // Nine megabytes: past the size at which losing a fold is worth a line in the log.
    writeFileSync(join(h.path, "..", `${big}.jsonl`), exchanges(0, 18000) + ASSISTANT("long", "é".repeat(400_000)) + "\n")
    for (const id of small) writeFileSync(join(h.path, "..", `${id}.jsonl`), exchanges(0, 20))
    __clearTranscriptCacheForTests()
    __setTranscriptCacheBudgetForTests(1) // any two folds are over it
    await transcriptFoldCaughtUp(h.project, h.store, big)
    const read = (id: string) => bytesRead(() => { readLatestThreadTranscriptPage(h.project, h.store, id) })
    assert.ok(readLatestThreadTranscriptPage(h.project, h.store, big).messages.length > 0, "the large thread is folded and held")
    for (const id of small.slice(0, 15)) read(id)
    assert.equal(log.records.filter((record) => record.scope === "transcript").length, 0, "sixteen folds are always kept")
    // The seventeenth pushes out the least recently read, which is the large one.
    read(small[15]!)
    const said = log.records.filter((record) => record.scope === "transcript" && record.message.startsWith("dropped the retained fold"))
    assert.equal(said.length, 1)
    assert.match(said[0]!.message, new RegExp(`^dropped the retained fold of ${big}\\.jsonl \\(about \\d+ MB held, 8 MB of transcript read\\)`))
    assert.equal(said[0]!.level, "info")
    // The sixteen most recently read are still held; a small one going is not worth a line.
    for (const id of small.slice(0, 16)) assert.equal(read(id), 0, id)
    assert.ok(read(small[16]!) > 0)
    assert.ok(read(small[16]!) === 0 && read(small[0]!) > 0, "the one just read stayed; the least recently read went to make room")
    assert.equal(log.records.filter((record) => record.scope === "transcript").length, 1)
  } finally {
    log.restore()
    __setTranscriptCacheBudgetForTests()
    __clearTranscriptCacheForTests()
    h.cleanup()
  }
})

test("only the read that asks for the rail's files pays for git, and git drops what the repository would not carry", async () => {
  const h = harness()
  const dir = mkdtempSync(join(tmpdir(), "frizz-page-files-"))
  try {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
    run("init", "-q")
    writeFileSync(join(dir, ".gitignore"), "out/\n")
    mkdirSync(join(dir, "out"))
    const kept = join(dir, "kept.ts")
    const dropped = join(dir, "out", "dropped.js")
    writeFileSync(kept, "x")
    writeFileSync(dropped, "x")
    const write = (id: string, file_path: string) => JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T18:00:01.000Z",
      message: { id, content: [{ type: "tool_use", id: `tu-${id}`, name: "Write", input: { file_path, content: "x" } }] },
    })
    writeFileSync(h.path, [USER("go"), write("a", kept), write("b", dropped)].join("\n") + "\n")
    const project = { ...h.project, dir } as Project
    assert.equal(readLatestThreadTranscriptPage(project, h.store, "t").editedFiles, undefined)
    const page = await readLatestThreadTranscriptPageWithFiles(project, h.store, "t")
    assert.deepEqual(page.editedFiles?.map((f) => f.path), [kept])
  } finally {
    __clearTranscriptCacheForTests()
    rmSync(dir, { recursive: true, force: true })
    h.cleanup()
  }
})
