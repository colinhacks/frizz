import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createTailer, tornUtf8Tail } from "./tailer.ts"
import { createTranscriptFold } from "./transcript.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { captureLogRecords } from "./logging.ts"

// WHAT ONE BAD READ COSTS. Each case here used to be silent and permanent for the thread it hit: the
// reader had already moved its cursor past bytes it then failed to fold, so nothing read them again.
// They are rare (a fold bug, a record shape nobody has seen, a read that lands inside a character, a
// file put back from a backup), which is why each is pinned on the real tailer and the real fold.

const at = (s: number) => `2026-07-01T00:00:${String(s).padStart(2, "0")}.000Z`
const user = (text: string, s: number) => JSON.stringify({ type: "user", timestamp: at(s), message: { role: "user", content: text } })
const assistant = (text: string, s: number, id = `msg_${s}`) =>
  JSON.stringify({ type: "assistant", timestamp: at(s), message: { id, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } })
const lines = (...records: string[]) => records.map((record) => record + "\n").join("")

function harness(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "frizz-read-faults-"))
  const dir = join(root, "-a-project")
  mkdirSync(dir, { recursive: true })
  const storage = createStorage(join(dir, "ui.db"), "p")
  t.after(() => {
    storage.close()
    rmSync(root, { recursive: true, force: true })
  })
  const bus = new Bus()
  const events: { type?: string; kind?: string }[] = []
  bus.subscribe((event) => events.push(event as { type?: string; kind?: string }))
  const clock = { ms: Date.parse(at(59)) }
  storage.upsertSession({
    slug: "t", session_id: "sid", thread_name: "frizz-t", spawned_at: at(0), last_read_at: null, unread: 0, exited: 0, archived: 0,
    rested_at: null, title_auto: 0, title: null, state: null, meta: null, seen_at: null, transcript_id: null,
  } as unknown as SessionRow)
  const make = (over: object = {}) =>
    createTailer({ project: { cwdSlug: "x" } as Project, storage, bus, onChange: () => {}, now: () => clock.ms, paneDead: () => false, sessionLogDir: dir, ...over })
  return { dir, events, clock, make, file: join(dir, "sid.jsonl") }
}

test("tornUtf8Tail counts the bytes of a character a buffer ends inside, at every width", () => {
  for (const char of ["ï", "—", "😀"]) {
    const bytes = Buffer.from(`ab${char}`, "utf8")
    const width = Buffer.byteLength(char)
    assert.equal(tornUtf8Tail(bytes), 0, `${char} whole`)
    for (let kept = 1; kept < width; kept++) {
      assert.equal(tornUtf8Tail(bytes.subarray(0, 2 + kept)), kept, `${char} cut after ${kept} of its ${width} bytes`)
    }
  }
  assert.equal(tornUtf8Tail(Buffer.from("plain")), 0)
  assert.equal(tornUtf8Tail(Buffer.alloc(0)), 0)
  // Continuation bytes with no lead in reach are not a character this could finish: left as they are.
  assert.equal(tornUtf8Tail(Buffer.from([0x80, 0x80, 0x80])), 0)
})

test("a record still being written, read up to the middle of a character, folds whole once the rest arrives", (t) => {
  const text = "naïve café — done 😀"
  const record = Buffer.from(assistant(text, 2) + "\n", "utf8")
  // Every byte position inside a multi-byte character of the record.
  const cuts: number[] = []
  for (let i = 1; i < record.length; i++) if ((record[i]! & 0xc0) === 0x80) cuts.push(i)
  assert.equal(cuts.length, 7, "one cut inside each two-byte character, two inside the dash, three inside the emoji")
  for (const cut of cuts) {
    const h = harness(t)
    writeFileSync(h.file, Buffer.concat([Buffer.from(user("hi", 1) + "\n"), record.subarray(0, cut)]))
    const tailer = h.make()
    tailer.tick()
    tailer.tick() // nothing new: the bytes handed back are read again and handed back again
    assert.notEqual(tailer.get("t")?.lastAssistant, text, "the record is not whole yet")
    appendFileSync(h.file, record.subarray(cut))
    tailer.tick()
    assert.equal(tailer.get("t")?.lastAssistant, text, `cut at byte ${cut} of the record`)
    tailer.stop()
  }
})

test("a record the fold throws on costs that record: the ones after it are folded, and the log says which was skipped", (t) => {
  const h = harness(t)
  const real = createClaudeBackend({ logDir: h.dir })
  const backend = {
    ...real,
    foldLine: (state: never, line: string) => {
      if (line.includes("POISON")) throw new Error("a fold bug on one record")
      real.foldLine(state, line)
    },
  }
  const head = lines(user("first ask", 1), assistant("first answer", 2))
  writeFileSync(h.file, head + lines(user("POISON", 3), user("second ask", 4), assistant("second answer", 5)))
  const log = captureLogRecords()
  try {
    const tailer = h.make({ backend })
    tailer.tick()
    tailer.tick()
    assert.equal(tailer.get("t")?.lastAssistant, "second answer", "the records after the bad one were read")
    assert.equal(tailer.get("t")?.lastUserAt, at(4), "and so was the human's message between them")
    const said = log.records.filter((record) => record.scope === "tailer" && record.message.includes("threw on the record"))
    assert.equal(said.length, 1, "said once, not once a tick")
    assert.equal(said[0]!.level, "error")
    assert.match(said[0]!.message, new RegExp(`thread t: the fold threw on the record at byte ${Buffer.byteLength(head)} of `))
    assert.match(said[0]!.message, /a fold bug on one record/)
    assert.doesNotMatch(said[0]!.message, /POISON/, "nothing of the record is logged")

    appendFileSync(h.file, lines(assistant("third answer", 9)))
    tailer.tick()
    assert.equal(tailer.get("t")?.lastAssistant, "third answer")
    tailer.stop()
  } finally {
    log.restore()
  }
})

test("a transcript replaced in place by a shorter one is adopted afresh: nothing of the old thread stays, and nothing is announced", (t) => {
  const h = harness(t)
  const dispatch = JSON.stringify({ type: "assistant", timestamp: at(2), message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_old", name: "Agent", input: { description: "old child", prompt: "p", run_in_background: true, subagent_type: "frizz:high" } }] } })
  const launch = JSON.stringify({ type: "user", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "Async agent launched successfully.\nagentId: aaaa1111 (internal ID)\noutput_file: /tmp/none.output" }] }, toolUseResult: { agentId: "aaaa1111" } })
  writeFileSync(h.file, lines(user("the old conversation, with a first message long enough to make the file the bigger one. ".repeat(8), 1), dispatch, launch))
  const tailer = h.make()
  tailer.tick()
  const before = tailer.get("t")
  assert.equal(before?.subAgents.length, 1)
  assert.match(before?.firstUserText ?? "", /^the old conversation/)
  const oldSize = statSync(h.file).size

  writeFileSync(h.file, lines(user("new", 10), assistant("new answer", 11)))
  assert.ok(statSync(h.file).size < oldSize)
  h.events.length = 0
  h.clock.ms = Date.parse(at(40))
  tailer.tick()
  tailer.tick()
  const after = tailer.get("t")
  assert.equal(after?.lastAssistant, "new answer")
  assert.equal(after?.firstUserText, "new", "the first message is the new file's")
  assert.equal(after?.subAgents.length, 0, "the old file's sub-agent is not carried onto the new one")
  assert.deepEqual(h.events.filter((event) => event.type === "notify"), [], "a replay of history announces nothing")
  tailer.stop()
})

test("the transcript fold skips a line that parses to something that is not a record, and loses nothing after it", () => {
  const fold = createTranscriptFold("claude:probe")
  const head = lines(user("first ask", 1), assistant("first answer", 2))
  const junk = lines("null", "7", '"a string"', "[null]", "true")
  fold.ingest(head + junk + lines(user("second ask", 4), assistant("second answer", 5)))
  fold.ingest(lines(assistant("third answer", 9)))
  const messages = fold.allMessages().filter((message) => !message.kind)
  assert.deepEqual(messages.map((message) => message.text), ["first ask", "first answer", "second ask", "second answer", "third answer"])
  // Offsets count the skipped lines' bytes: a record after them is where it is in the file.
  assert.equal(messages[2]!.sourceId, `claude:probe:${Buffer.byteLength(head + junk)}`)
})

test("a record the transcript fold throws on costs that record, and the log says where it was", () => {
  // No record shape makes today's fold throw, so the fault is put there: `Array.isArray` is what the
  // fold asks of an assistant record's content, and for one marked record it throws.
  const real = Array.isArray
  const poisoned = (value: unknown): value is unknown[] => {
    if (real(value) && value.some((block) => (block as { text?: unknown } | null)?.text === "POISON")) throw new Error("a fold bug on one record")
    return real(value)
  }
  const head = lines(user("first ask", 1), assistant("first answer", 2))
  const raw = head + lines(assistant("POISON", 3), user("second ask", 4), assistant("second answer", 5))
  const log = captureLogRecords()
  const fold = createTranscriptFold("claude:probe")
  try {
    Array.isArray = poisoned as typeof Array.isArray
    fold.ingest(raw)
  } finally {
    Array.isArray = real
    log.restore()
  }
  fold.ingest(lines(assistant("third answer", 9)))
  const messages = fold.allMessages().filter((message) => !message.kind)
  assert.deepEqual(messages.map((message) => message.text), ["first ask", "first answer", "second ask", "second answer", "third answer"])
  assert.equal(fold.consumedBytes(), Buffer.byteLength(raw + lines(assistant("third answer", 9))))
  const said = log.records.filter((record) => record.scope === "transcript")
  assert.equal(said.length, 1)
  assert.equal(said[0]!.level, "warn")
  assert.match(said[0]!.message, new RegExp(`^claude:probe: the record at byte ${Buffer.byteLength(head)} could not be folded and was skipped \\(1 so far in this fold\\): a fold bug on one record`))
  assert.doesNotMatch(said[0]!.message, /POISON/)
})
