import { test } from "node:test"
import assert from "node:assert/strict"
import { mergeOptimistic, preserveMessageIdentity, isTranscriptStale, newestRenderedAt, sameContent, type QueuedMessage } from "./transcript-sync.ts"

const user = (text: string, opts: { queued?: boolean; at?: string; sourceId?: string } = {}): QueuedMessage => ({
  role: "user",
  text,
  tools: [],
  parts: [],
  ...(opts.queued ? { queued: true } : {}),
  ...(opts.at ? { at: opts.at } : {}),
  ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
})

// ---- mergeOptimistic (S1: preserve unconsumed optimistic sends across a cache overwrite) ----
test("mergeOptimistic: an optimistic bubble not yet in server truth is preserved (re-appended)", () => {
  const old = user("old", { sourceId: "old-turn" })
  const out = mergeOptimistic([old, user("pending send", { queued: true })], [old])
  assert.equal(out.length, 2)
  assert.equal(out[1].text, "pending send")
})

test("mergeOptimistic: an optimistic bubble now present in server truth is dropped (no duplicate)", () => {
  const old = user("old", { sourceId: "old-turn" })
  const out = mergeOptimistic(
    [old, user("landed", { queued: true })],
    [old, user("landed", { sourceId: "landed-turn" })],
  )
  assert.equal(out.length, 2)
  assert.equal(out.filter((m) => m.text === "landed").length, 1)
})

test("mergeOptimistic: the server's OWN queued copy also consumes the optimistic bubble", () => {
  const out = mergeOptimistic(
    [user("landed", { queued: true })],
    [user("landed", { queued: true, sourceId: "server-queued-turn" })],
  )
  assert.equal(out.length, 1)
})

// FRIZZ'S OWN RIDERS MUST NOT DEFEAT CONSUMPTION. The copy handed to the worker carries the clock note
// and the wake token, and the transcript is read from the WORKER's record — so the server's report of the
// human's send is their text PLUS those. Compared raw it consumed nothing and the optimistic bubble was
// re-appended: two identical gray bubbles of the operator's own message (reported 2026-09-01, alongside
// the answers-card twin). The server hit the same thing in its ledger projection — see renderMatchKey.
const GAP_NOTE = "⏱ Frizz: the message above arrived 4h 9m after your last one. It is now 2026-09-01 07:09."
const WAKE_TOKEN = `<!-- frizz-wake:${"a".repeat(64)} -->`

test("mergeOptimistic: the clock note frizz appends does not stop the server's copy consuming the bubble", () => {
  const typed = "please also handle the empty case"
  const out = mergeOptimistic(
    [user(typed, { queued: true })],
    [user(`${typed}\n\n${GAP_NOTE}`, { queued: true, sourceId: "server-queued-turn" })],
  )
  assert.equal(out.length, 1, "the optimistic copy must not survive beside the server's own record")
})

test("mergeOptimistic: a coalesced run is reconstructed through the riders too", () => {
  const first = "first send"
  const second = "second send"
  const out = mergeOptimistic(
    [user("old", { sourceId: "old-turn" }), user(first, { queued: true }), user(second, { queued: true })],
    [user("old", { sourceId: "old-turn" }), user(`${first}\n\n${second}\n\n${WAKE_TOKEN}`, { sourceId: "landed-turn" })],
  )
  assert.equal(out.length, 2)
})

test("mergeOptimistic: an unchanged server queued copy is not appended beside itself", () => {
  const serverQueued = user("landed", { queued: true, sourceId: "server-queued-turn" })
  const incoming = [serverQueued]
  assert.equal(mergeOptimistic([serverQueued], incoming), incoming)
})

test("mergeOptimistic: one landed turn consumes consecutive optimistic messages it coalesces", () => {
  const first = '"Add inter-thread spawning and internal linking"'
  const second = "The agent received both messages, but they still look enqueued."
  const landed = `${first}\n\n${second}`
  const out = mergeOptimistic(
    [user("old", { sourceId: "old-turn" }), user(first, { queued: true }), user(second, { queued: true })],
    [user("old", { sourceId: "old-turn" }), user(landed, { sourceId: "landed-turn" })],
  )
  assert.deepEqual(out.map((message) => message.text), ["old", landed])
})

test("mergeOptimistic: a historical coalesced turn is not fresh delivery evidence", () => {
  const first = "repeat first"
  const second = "repeat second"
  const landed = `${first}\n\n${second}`
  const old = user(landed, { sourceId: "old-turn" })
  const out = mergeOptimistic(
    [old, user(first, { queued: true }), user(second, { queued: true })],
    [old],
  )
  assert.deepEqual(out.map((message) => message.text), [landed, first, second])
})

test("mergeOptimistic: a repeated coalesced turn with a new source id consumes the new sends", () => {
  const first = "repeat first"
  const second = "repeat second"
  const landed = `${first}\n\n${second}`
  const old = user(landed, { sourceId: "old-turn" })
  const fresh = user(landed, { sourceId: "new-turn" })
  const out = mergeOptimistic(
    [old, user(first, { queued: true }), user(second, { queued: true })],
    [old, fresh],
  )
  assert.deepEqual(out, [old, fresh])
})

test("mergeOptimistic: one coalesced turn consumes only the first of two repeated queued runs", () => {
  const landed = user("a\n\nb", { sourceId: "landed-turn" })
  const out = mergeOptimistic(
    [user("a", { queued: true }), user("b", { queued: true }), user("a", { queued: true }), user("b", { queued: true })],
    [landed],
  )
  assert.deepEqual(out.map((message) => message.text), [landed.text, "a", "b"])
})

test("mergeOptimistic: two fresh coalesced turns consume two repeated queued runs", () => {
  const first = user("a\n\nb", { sourceId: "landed-turn-1" })
  const second = user("a\n\nb", { sourceId: "landed-turn-2" })
  const out = mergeOptimistic(
    [user("a", { queued: true }), user("b", { queued: true }), user("a", { queued: true }), user("b", { queued: true })],
    [first, second],
  )
  assert.deepEqual(out, [first, second])
})

test("mergeOptimistic: one overlapping coalesced turn cannot consume the same evidence twice", () => {
  const landed = user("a\n\na", { sourceId: "landed-turn" })
  const out = mergeOptimistic(
    [user("a", { queued: true }), user("a", { queued: true }), user("a", { queued: true })],
    [landed],
  )
  assert.deepEqual(out.map((message) => message.text), [landed.text, "a"])
})

test("mergeOptimistic: a single optimistic paragraph is not consumed by incidental landed prose", () => {
  const pending = user("shared paragraph", { queued: true })
  const landed = user("An unrelated introduction.\n\nshared paragraph", { sourceId: "landed-turn" })
  const out = mergeOptimistic([pending], [landed])
  assert.deepEqual(out.map((message) => message.text), [landed.text, pending.text])
})

test("mergeOptimistic: id-less input is not accepted as fresh delivery evidence", () => {
  const pending = user("landed", { queued: true })
  const out = mergeOptimistic([pending], [user("landed")])
  assert.deepEqual(out.map((message) => message.text), ["landed", "landed"])
  assert.equal(out[1].queued, true)
})

test("mergeOptimistic: no optimistic entries → returns the incoming array unchanged (identity)", () => {
  const incoming = [user("a"), user("b")]
  assert.equal(mergeOptimistic([user("a")], incoming), incoming)
})

test("mergeOptimistic: empty/whitespace optimistic text is ignored", () => {
  const incoming = [user("real")]
  assert.equal(mergeOptimistic([user("  ", { queued: true })], incoming), incoming)
})

// ---- the ghost floor: an optimistic bubble must not outlive the conversation ----
// Reproduced against the real session JSONL of `this-nub-thread-is-unsteerable-why`: two optimistic
// "continue" bubbles, ONE server record — the surplus bubble used to survive every later merge forever.
test("mergeOptimistic: a surplus optimistic bubble is retired once the transcript advances past it", () => {
  const landed = user("continue", { sourceId: "landed-turn", at: "2026-07-21T22:30:55.878Z" })
  // The server only ever recorded ONE "continue"; the client is holding two bubbles for it.
  const first = mergeOptimistic(
    [user("continue", { queued: true }), user("continue", { queued: true })],
    [landed],
  )
  assert.deepEqual(first.map((message) => message.text), ["continue", "continue"], "one consumed, one anchored")
  const later = user("later", { sourceId: "later-turn", at: "2026-07-21T22:39:08.806Z" })
  assert.deepEqual(mergeOptimistic(first, [landed, later]), [landed, later])
})

test("mergeOptimistic: a bubble is kept while the transcript stays within the grace window", () => {
  const landed = user("a", { sourceId: "landed-turn", at: "2026-07-21T22:30:00.000Z" })
  const pending = user("pending", { queued: true })
  const first = mergeOptimistic([pending], [landed])
  const soon = user("soon", { sourceId: "soon-turn", at: "2026-07-21T22:30:59.000Z" }) // +59s
  assert.deepEqual(mergeOptimistic(first, [landed, soon]).map((m) => m.text), ["a", "soon", "pending"])
})

test("mergeOptimistic: a quiet transcript never advances the anchor, so an in-flight send is never dropped", () => {
  const landed = user("a", { sourceId: "landed-turn", at: "2026-07-21T22:30:00.000Z" })
  const pending = user("pending", { queued: true })
  let merged = mergeOptimistic([pending], [landed])
  for (let push = 0; push < 50; push++) merged = mergeOptimistic(merged, [landed])
  assert.deepEqual(merged.map((message) => message.text), ["a", "pending"])
})

test("mergeOptimistic: timestamp-less server truth cannot retire a bubble", () => {
  const landed = user("a", { sourceId: "landed-turn" })
  const pending = user("pending", { queued: true })
  const first = mergeOptimistic([pending], [landed])
  assert.deepEqual(mergeOptimistic(first, [landed]).map((message) => message.text), ["a", "pending"])
})

test("mergeOptimistic: the server's own pending bubble is never retired by the floor", () => {
  const serverQueued = user("still queued", { queued: true, sourceId: "enqueue-turn", at: "2026-07-21T22:30:00.000Z" })
  const later = user("later", { sourceId: "later-turn", at: "2026-07-21T23:30:00.000Z" }) // +1h
  const incoming = [serverQueued, later]
  assert.equal(mergeOptimistic([serverQueued], incoming), incoming)
})

// ---- isTranscriptStale (level-triggered watchdog decision) ----
test("isTranscriptStale: activity leading the rendered tail by > threshold is stale", () => {
  assert.equal(isTranscriptStale("2026-07-01T00:00:10.000Z", "2026-07-01T00:00:00.000Z", 5000), true)
})
test("isTranscriptStale: within threshold is fresh", () => {
  assert.equal(isTranscriptStale("2026-07-01T00:00:03.000Z", "2026-07-01T00:00:00.000Z", 5000), false)
})
test("isTranscriptStale: no activity marker → never stale", () => {
  assert.equal(isTranscriptStale(undefined, "2026-07-01T00:00:00.000Z", 5000), false)
})
test("isTranscriptStale: activity present but nothing rendered yet → stale", () => {
  assert.equal(isTranscriptStale("2026-07-01T00:00:10.000Z", undefined, 5000), true)
})
test("isTranscriptStale: unparseable timestamps don't thrash", () => {
  assert.equal(isTranscriptStale("not-a-date", "2026-07-01T00:00:00.000Z", 5000), false)
  assert.equal(isTranscriptStale("2026-07-01T00:00:10.000Z", "not-a-date", 5000), false)
})

// ---- newestRenderedAt ----
test("newestRenderedAt: returns the last message carrying an `at`, scanning from the tail", () => {
  const msgs = [user("a", { at: "2026-07-01T00:00:00.000Z" }), user("b", { at: "2026-07-01T00:00:05.000Z" }), user("c")]
  assert.equal(newestRenderedAt(msgs), "2026-07-01T00:00:05.000Z") // trailing at-less message doesn't mask it
})
test("newestRenderedAt: undefined when nothing has a timestamp", () => {
  assert.equal(newestRenderedAt([user("a"), user("b")]), undefined)
  assert.equal(newestRenderedAt(undefined), undefined)
})

// ---- preserveMessageIdentity (per-push identity reuse so memoized rows bail out) ----
test("preserveMessageIdentity: an unchanged message keeps the PREVIOUS object identity", () => {
  const prev = [user("a", { sourceId: "s:1", at: "2026-07-01T00:00:00.000Z" }), user("b", { sourceId: "s:2" })]
  const incoming = [user("a", { sourceId: "s:1", at: "2026-07-01T00:00:00.000Z" }), user("b", { sourceId: "s:2" }), user("c", { sourceId: "s:3" })]
  const out = preserveMessageIdentity(prev, incoming)
  assert.equal(out[0], prev[0])
  assert.equal(out[1], prev[1])
  assert.equal(out[2], incoming[2]) // genuinely new tail keeps the fresh object
})

test("preserveMessageIdentity: a changed message takes the FRESH object (queued→delivered flip re-renders)", () => {
  const prev = [user("landed", { sourceId: "s:1", queued: true })]
  const incoming = [user("landed", { sourceId: "s:1" })] // same text, queued flag cleared
  const out = preserveMessageIdentity(prev, incoming)
  assert.equal(out[0], incoming[0])
})

test("preserveMessageIdentity: id-less (optimistic) entries are never matched or replaced", () => {
  const optimistic = user("pending", { queued: true })
  const prev = [user("a", { sourceId: "s:1" }), optimistic]
  const incoming = [user("a", { sourceId: "s:1" }), optimistic] // mergeOptimistic re-appended the same object
  const out = preserveMessageIdentity(prev, incoming)
  assert.equal(out[0], prev[0])
  assert.equal(out[1], optimistic)
})

test("preserveMessageIdentity: no previous window → incoming unchanged", () => {
  const incoming = [user("a", { sourceId: "s:1" })]
  assert.equal(preserveMessageIdentity(undefined, incoming), incoming)
  assert.equal(preserveMessageIdentity([], incoming), incoming)
})

// ---- sameContent: the structural compare preserveMessageIdentity reuses objects on ----
test("sameContent: equal content in fresh objects is the same; any differing leaf is not", () => {
  const a = { role: "assistant", text: "x", tools: [{ name: "Bash", output: "ok", status: "completed" }], parts: [{ kind: "text", text: "x" }] }
  const b = structuredClone(a)
  assert.equal(sameContent(a, b), true)
  b.tools[0]!.status = "running"
  assert.equal(sameContent(a, b), false)
  assert.equal(sameContent([1, 2], [1, 2, 3]), false)
  assert.equal(sameContent({ a: [1] }, { a: { 0: 1 } }), false)
  assert.equal(sameContent({ a: 1 }, { a: 1, b: 2 }), false)
  assert.equal(sameContent(null, {}), false)
})

test("sameContent: a key holding undefined reads as absent, as the JSON compare it replaced did", () => {
  assert.equal(sameContent({ a: 1, queued: undefined }, { a: 1 }), true)
  assert.equal(sameContent({ a: 1 }, { a: 1, deliveryId: undefined }), true)
  assert.equal(sameContent({ a: 1, queued: undefined }, { a: 1, queued: true }), false)
})

// The compare used to cache a JSON signature of every message it saw, in a WeakMap keyed by the message:
// a second, serialized copy of every transcript the query cache held, alive as long as the transcript.
// Measured with the real heap: compare a transcript of big tool outputs, keep it, collect, and see what the
// compare left behind. The serialized copy would be at least the outputs' size; a walk leaves ~nothing.
test("preserveMessageIdentity keeps no copy of the messages it compared", async () => {
  const { setFlagsFromString } = await import("node:v8")
  const { runInNewContext } = await import("node:vm")
  setFlagsFromString("--expose-gc")
  const gc = runInNewContext("gc") as () => void
  const big = (i: number, salt: string): QueuedMessage => ({
    role: "assistant", text: `turn ${i}`, sourceId: `s:${i}`, parts: [],
    // Through JSON.parse so the string is flat: comparing a rope would flatten it, which is the
    // engine's allocation, not the compare's.
    tools: [{ name: "Bash", output: JSON.parse(JSON.stringify(`${salt}${i}:`.padEnd(50_000, "o"))) as string }],
  } as unknown as QueuedMessage)
  // Distinct strings per side, so a cache could not share them with the messages themselves.
  const prev = Array.from({ length: 120 }, (_, i) => big(i, "p"))
  const incoming = Array.from({ length: 120 }, (_, i) => big(i, "p"))
  gc()
  const before = process.memoryUsage().heapUsed
  const out = preserveMessageIdentity(prev, incoming)
  gc()
  const grown = process.memoryUsage().heapUsed - before
  assert.equal(out[0], prev[0]) // still reuses the previous object
  // 120 messages × 50 KB = 6 MB of output; a signature cache keeps at least that.
  assert.ok(grown < 1_000_000, `the compare left ${(grown / 1e6).toFixed(1)} MB behind`)
  assert.equal(prev.length + incoming.length, 240) // both sides stay alive across the reading
})
