import { test } from "node:test"
import assert from "node:assert/strict"
import { QueryClient } from "@tanstack/react-query"
import { diffJson, type BoardDelta, type ThreadView, type TranscriptMessage } from "@frizz/shared"
import { cachedMessages, expandBoardDelta, TranscriptTails } from "./wirePatch.ts"
import { keyThread, unkeyThread } from "./consoleFeed.ts"
import { writeTranscriptPush } from "./transcript-push.ts"

const msg = (text: string): TranscriptMessage => ({ role: "assistant", text, tools: [], parts: [] })
const thread = (id: string, over: Partial<ThreadView> = {}): ThreadView =>
  ({ id, title: id, status: "active", runtime: "turn-idle", dependsOn: [], ...over }) as unknown as ThreadView

test("a tail is spliced onto the window this socket last received, and refused against any other", () => {
  const tails = new TranscriptTails()
  const first = [msg("a"), msg("b"), msg("c")]
  tails.whole("t", first)
  const rebuilt = tails.tail({ t: "transcript-tail", slug: "t", from: 3, drop: 1, keep: 2, messages: [msg("d")] })
  assert.deepEqual(rebuilt, [msg("b"), msg("c"), msg("d")])
  assert.equal(rebuilt![0], first[1], "a kept message is the object already held")
  assert.deepEqual(tails.tail({ t: "transcript-tail", slug: "t", from: 3, drop: 0, keep: 3, messages: [msg("e")] }), [msg("b"), msg("c"), msg("d"), msg("e")])
  // Made against a window of another length: refused, and the slug is held no longer.
  assert.equal(tails.tail({ t: "transcript-tail", slug: "t", from: 9, drop: 0, keep: 1, messages: [] }), null)
  assert.equal(tails.tail({ t: "transcript-tail", slug: "t", from: 4, drop: 0, keep: 1, messages: [] }), null)
  assert.equal(tails.tail({ t: "transcript-tail", slug: "never", from: 0, drop: 0, keep: 0, messages: [] }), null)
  tails.whole("u", [msg("x")])
  tails.forget("u")
  assert.equal(tails.size, 0)
})

test("the window held for the next tail is the cache's own messages, not a second copy of them", () => {
  // The cache keeps the previous object of every unchanged message (preserveMessageIdentity), so a window
  // held as the socket parsed it was the whole transcript twice over for every live thread.
  const src = (id: string, text: string): TranscriptMessage => ({ ...msg(text), sourceId: id })
  const qc = new QueryClient()
  qc.setQueryData(["transcript", "t"], { messages: [src("1", "a"), src("2", "b"), src("3", "c")] })
  const read = cachedMessages(qc, "t")!
  const tails = new TranscriptTails()
  const wire = [src("1", "a"), src("2", "b"), src("3", "c")]
  tails.whole("t", wire)
  writeTranscriptPush(qc, "t", { t: "transcript", slug: "t", messages: wire })
  assert.equal(cachedMessages(qc, "t")![1], read[1], "precondition: the cache kept its own object for an unchanged message")
  tails.adopt("t", cachedMessages(qc, "t"))

  const rebuilt = tails.tail({ t: "transcript-tail", slug: "t", from: 3, drop: 1, keep: 2, messages: [src("4", "d")] })!
  assert.deepEqual(rebuilt, [src("2", "b"), src("3", "c"), src("4", "d")], "the splice reads positions, which adopting kept")
  assert.equal(rebuilt[0], read[1], "a kept message is the cache's object")
  assert.equal(rebuilt[1], read[2])

  // A message the cache holds with other content keeps the window's own object: only an equal one is swapped.
  const held = tails.tail({ t: "transcript-tail", slug: "t", from: 3, drop: 0, keep: 3, messages: [] })!
  tails.adopt("t", [held[0]!, { ...held[1]!, text: "edited" }, held[2]!])
  const after = tails.tail({ t: "transcript-tail", slug: "t", from: 3, drop: 0, keep: 3, messages: [] })!
  assert.equal(after[1], held[1])
})

test("a patched delta is expanded into whole upserts against the views held, or refused", () => {
  const before = thread("a", { activity: "Reading", agents: [] } as Partial<ThreadView>)
  const after = thread("a", { activity: "Writing", agents: [] } as Partial<ThreadView>)
  const fresh = thread("b")
  const event: BoardDelta = { type: "board-delta", seq: 2, bootId: "x", upserts: [fresh], removed: [], patches: [{ id: "a", ops: diffJson(before, after) as unknown[][] }] }
  const whole = expandBoardDelta(event, (id) => (id === "a" ? before : undefined))
  assert.ok(whole)
  assert.equal(whole.patches, undefined)
  assert.deepEqual(whole.upserts, [fresh, after])
  assert.equal(expandBoardDelta(event, () => undefined), null, "no view held: the board is read again")
  const plain: BoardDelta = { type: "board-delta", seq: 2, bootId: "x", upserts: [fresh], removed: [] }
  assert.equal(expandBoardDelta(plain, () => undefined), plain)
})

test("on the Console a patch is applied to the thread as its project holds it, then keyed again", () => {
  const before = thread("a", { dependsOn: ["b"], parentSlug: "p", activity: "Reading" } as Partial<ThreadView>)
  const after = thread("a", { dependsOn: ["b", "c"], parentSlug: "p", activity: "Writing" } as Partial<ThreadView>)
  const keyed = keyThread("proj", before)
  assert.deepEqual(unkeyThread(keyed), before)
  const event: BoardDelta = { type: "board-delta", seq: 2, bootId: "x", upserts: [], removed: [], patches: [{ id: "a", ops: diffJson(before, after) as unknown[][] }] }
  const whole = expandBoardDelta(event, (slug) => (slug === "a" ? unkeyThread(keyed) : undefined))
  assert.ok(whole)
  assert.deepEqual(keyThread("proj", whole.upserts[0]!), keyThread("proj", after))
})
