// WHAT THE SERVER'S LONG-LIVED STRUCTURES KEEP ALIVE, measured on the heap.
//
// An excerpt cut with `slice` (or built as `slice + marker`) points into the string it was cut from, so a
// 4000-character Edit preview kept the whole file it previewed, and a 400-character first-prompt preview
// the whole prompt (detached-string.ts). These tests build a source far bigger than anything else in the
// process, keep only what the server keeps, collect garbage, and read how much of the source survived.
// Each asserts a ceiling far below the source size, so heap noise cannot pass a regression.
import assert from "node:assert/strict"
import { test } from "node:test"
import v8 from "node:v8"
import vm from "node:vm"
import { detached } from "./detached-string.ts"
import { createTranscriptFold } from "./transcript.ts"
import { applyRecord, newTailState } from "./tailer.ts"

v8.setFlagsFromString("--expose-gc")
const gc = vm.runInNewContext("gc") as () => void

const MB = 1024 * 1024
// A one-byte string of `bytes` characters on the V8 heap, flat, and not shared with anything: JSON.parse
// copies, where `repeat` would build a rope and a Buffer decode an external string off the heap.
function bigText(bytes: number, seed: string): string {
  return JSON.parse(JSON.stringify(seed.repeat(Math.ceil(bytes / seed.length)).slice(0, bytes))) as string
}

async function heapUsed(): Promise<number> {
  // V8 keeps the subject of the LAST regexp match alive (RegExp.lastMatch and friends), one string per
  // context. Match a tiny one so that slot never charges a payload to the structure under test.
  /x/.exec("x")
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    gc()
  }
  return process.memoryUsage().heapUsed
}

/** Bytes still on the heap after `build` returns, with what it returned kept alive. */
async function retainedBy<T>(build: () => T): Promise<{ bytes: number; kept: T }> {
  const before = await heapUsed()
  const kept = build()
  const after = await heapUsed()
  return { bytes: after - before, kept }
}

test("detached: an excerpt keeps none of the string it was cut from", async () => {
  const cut = await retainedBy(() => {
    const kept: string[] = []
    for (let i = 0; i < 4; i++) kept.push(detached(bigText(8 * MB, `source ${i} `).slice(0, 4000) + "\n… (truncated)"))
    return kept
  })
  assert.ok(cut.bytes < 4 * MB, `4 detached excerpts kept ${(cut.bytes / MB).toFixed(1)} MB`)
  assert.equal(cut.kept[0]!.length, 4000 + "\n… (truncated)".length)
  assert.ok(cut.kept[0]!.startsWith("source 0 source 0"))

  // NEGATIVE CONTROL, in the same process: the same excerpts without `detached` keep every source.
  const sliced = await retainedBy(() => {
    const kept: string[] = []
    for (let i = 0; i < 4; i++) kept.push(bigText(8 * MB, `source ${i} `).slice(0, 4000) + "\n… (truncated)")
    return kept
  })
  assert.ok(sliced.bytes > 24 * MB, `the control kept only ${(sliced.bytes / MB).toFixed(1)} MB: this harness cannot see the leak`)
})

test("detached: an all-Latin-1 excerpt of a two-byte string is stored one byte per character", async () => {
  // A reply that holds one "→" is two-byte throughout, and so is every slice of it, ASCII or not.
  const ascii = (i: number) => `line ${i} of a tool output, plain ASCII\n`.repeat(400).slice(0, 10_000)
  const cutFromWide = (i: number) => ("→" + ascii(i)).slice(1)
  const narrowed = await retainedBy(() => Array.from({ length: 200 }, (_, i) => detached(cutFromWide(i))))
  const perChar = narrowed.bytes / (200 * 10_000)
  assert.ok(perChar < 1.3, `stored at ${perChar.toFixed(2)} bytes per character`)
  assert.equal(narrowed.kept[7], ascii(7), "the content is unchanged")
  // NEGATIVE CONTROL: a plain copy keeps the two-byte representation.
  const copied = await retainedBy(() => Array.from({ length: 200 }, (_, i) => (" " + cutFromWide(i)).slice(1)))
  assert.ok(copied.bytes / (200 * 10_000) > 1.8, "the control was not two-byte: this harness cannot see the difference")
  // A string that does hold a wider character keeps it.
  assert.equal(detached("wide → kept, and long enough"), "wide → kept, and long enough")
  assert.equal(detached("Latin-1 é ü ñ survive the round trip"), "Latin-1 é ü ñ survive the round trip")
})

test("detached: short strings and undefined pass through unchanged", () => {
  assert.equal(detached(undefined), undefined)
  assert.equal(detached(""), "")
  assert.equal(detached("short"), "short")
  const long = "a string longer than thirteen"
  assert.equal(detached(long), long)
})

test("a retained transcript fold keeps its capped previews, not the tool payloads they were cut from", async () => {
  const at = "2026-11-09T00:00:00.000Z"
  const record = (id: string, name: string, input: Record<string, unknown>) => JSON.stringify({
    type: "assistant", uuid: `u-${id}`, timestamp: at,
    message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id: `t-${id}`, name, input }] },
  })
  const { bytes, kept } = await retainedBy(() => {
    const fold = createTranscriptFold("claude:retention")
    // Four payloads the fold caps: a Write's content, an Edit's new side, a Bash command, an Agent prompt.
    fold.ingest(record("w", "Write", { file_path: "/tmp/a.ts", content: bigText(6 * MB, "write ") }) + "\n")
    fold.ingest(record("e", "Edit", { file_path: "/tmp/b.ts", old_string: "x", new_string: bigText(6 * MB, "edit ") }) + "\n")
    fold.ingest(record("b", "Bash", { command: bigText(6 * MB, "echo ") }) + "\n")
    fold.ingest(record("a", "Agent", { description: "d", prompt: bigText(6 * MB, "prompt ") }) + "\n")
    return fold
  })
  const tools = kept.allMessages().flatMap((m) => m.tools ?? [])
  assert.equal(tools.length, 4, "every call drew its card")
  assert.ok(tools.every((t) => (t.edit?.new ?? t.command ?? t.prompt ?? "").includes("(truncated)")), "each payload was capped")
  assert.ok(bytes < 6 * MB, `the fold kept ${(bytes / MB).toFixed(1)} MB of 24 MB of payloads`)
})

test("a tail state keeps its previews, not the messages they were cut from", async () => {
  const { bytes, kept } = await retainedBy(() => {
    const s = newTailState("t", "sid", "/x")
    applyRecord(s, { type: "user", timestamp: "2026-11-09T00:00:00.000Z", message: { content: bigText(8 * MB, "the task ") } })
    applyRecord(s, {
      type: "assistant",
      timestamp: "2026-11-09T00:00:01.000Z",
      message: { stop_reason: "end_turn", content: [{ type: "text", text: bigText(8 * MB, "a long reply ") }] },
    })
    return s
  })
  assert.ok(kept.firstUserText?.startsWith("the task"), "the first prompt was noted")
  assert.ok(kept.lastAssistant?.startsWith("a long reply"), "the reply was previewed")
  assert.ok(bytes < 4 * MB, `the tail state kept ${(bytes / MB).toFixed(1)} MB of 16 MB of messages`)
})
