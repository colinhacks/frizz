import assert from "node:assert/strict"
import test from "node:test"
import {
  clearRememberedTranscriptScroll,
  MAX_REMEMBERED_THREADS,
  rememberedTranscriptOpenFolds,
  rememberTranscriptScroll,
  resolveRememberedTranscriptScroll,
  transcriptLandingEpoch,
  type TranscriptEpochMsgLike,
} from "./transcriptScrollMemory.ts"

const human = (sourceId: string, text = "do it"): TranscriptEpochMsgLike => ({ role: "user", sourceId, text })
const work = (sourceId: string, text = "working"): TranscriptEpochMsgLike => ({ role: "assistant", sourceId, text })
const signOff = (sourceId: string, text = "done"): TranscriptEpochMsgLike => ({ role: "assistant", sourceId, text, signOff: true })
const wake = (sourceId: string): TranscriptEpochMsgLike => ({ role: "user", sourceId, text: "wake", wake: true })

const ROWS = [{ key: "head-anchor" }, { key: "u1" }, { key: "a1" }, { key: "a2" }, { key: "runtime-status" }]
const NONE: ReadonlySet<string> = new Set()
const AT = "2026-11-27T10:00:00.000Z"
const LATER = "2026-11-27T10:05:00.000Z"

test("a thread the reader never moved in uses the cold-open landing", () => {
  clearRememberedTranscriptScroll()
  const epoch = transcriptLandingEpoch([human("u1"), work("a1"), work("a2")], AT)
  assert.equal(resolveRememberedTranscriptScroll("t", epoch, ROWS), null)
})

test("a reader who scrolled or jumped to the tail returns to the tail", () => {
  clearRememberedTranscriptScroll()
  const epoch = transcriptLandingEpoch([human("u1"), work("a1"), work("a2")], AT)
  rememberTranscriptScroll("t", { epoch, followingTail: true, anchor: null, openFolds: NONE })
  assert.deepEqual(resolveRememberedTranscriptScroll("t", epoch, ROWS), { kind: "tail" })
})

test("a reader parked mid-thread returns to the same row and viewport offset across session switches", () => {
  clearRememberedTranscriptScroll()
  const epoch = transcriptLandingEpoch([human("u1"), work("a1"), signOff("s1")], AT)
  rememberTranscriptScroll("t", { epoch, followingTail: false, anchor: { rowKey: "a1", viewportTop: -24 }, openFolds: NONE })
  const place = { kind: "anchor", index: 2, anchor: { rowKey: "a1", viewportTop: -24 } }
  assert.deepEqual(resolveRememberedTranscriptScroll("t", epoch, ROWS), place)
  // Reading does not consume the memory: switching A -> B -> A -> C -> A preserves the place.
  assert.deepEqual(resolveRememberedTranscriptScroll("t", epoch, ROWS), place)
})

test("a thread that moved while the reader was away opens on its landing, whatever its cached transcript says", () => {
  clearRememberedTranscriptScroll()
  const before = [human("u1"), work("a1"), signOff("s1")]
  rememberTranscriptScroll("t", { epoch: transcriptLandingEpoch(before, AT), followingTail: true, anchor: null, openFolds: new Set(["fold:a1"]) })

  // The revisit paints the transcript the tab cached when it left, and the board says the thread has moved.
  const stale = transcriptLandingEpoch(before, LATER)
  assert.equal(resolveRememberedTranscriptScroll("t", stale, ROWS), null)
  assert.equal(rememberedTranscriptOpenFolds("t", stale).size, 0)
  // A new sign-off, and a new steer, once the transcript has them.
  assert.equal(resolveRememberedTranscriptScroll("t", transcriptLandingEpoch([...before, wake("w1"), signOff("s2")], LATER), ROWS), null)
  assert.equal(resolveRememberedTranscriptScroll("t", transcriptLandingEpoch([...before, human("u2"), work("a5")], LATER), ROWS), null)
})

test("a place the reader moved to after the thread moved under them belongs to the thread as it is now", () => {
  clearRememberedTranscriptScroll()
  const now = transcriptLandingEpoch([human("u1"), work("a1"), signOff("s1"), wake("w1"), signOff("s2")], LATER)
  rememberTranscriptScroll("t", { epoch: transcriptLandingEpoch([human("u1"), work("a1"), signOff("s1")], AT), followingTail: true, anchor: null, openFolds: NONE })
  rememberTranscriptScroll("t", { epoch: now, followingTail: false, anchor: { rowKey: "a2", viewportTop: 12 }, openFolds: NONE })
  assert.deepEqual(resolveRememberedTranscriptScroll("t", now, ROWS), { kind: "anchor", index: 3, anchor: { rowKey: "a2", viewportTop: 12 } })
})

test("the folds the reader had open come back with the place", () => {
  clearRememberedTranscriptScroll()
  const epoch = transcriptLandingEpoch([human("u1"), work("a1"), signOff("s1")], AT)
  rememberTranscriptScroll("t", { epoch, followingTail: false, anchor: { rowKey: "a1", viewportTop: 18 }, openFolds: new Set(["fold:a1"]) })
  assert.deepEqual([...rememberedTranscriptOpenFolds("t", epoch)], ["fold:a1"])
})

function withPathname<T>(pathname: string, body: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location")
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname } })
  try {
    return body()
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous)
    else Reflect.deleteProperty(globalThis, "location")
  }
}

test("a thread's place belongs to its project: the same slug in another project opens on its own landing", () => {
  clearRememberedTranscriptScroll()
  const epoch = transcriptLandingEpoch([human("u1"), work("a1"), signOff("s1")], AT)
  withPathname("/project/acme/thread/fix-auth", () => rememberTranscriptScroll("fix-auth", { epoch, followingTail: true, anchor: null, openFolds: NONE }))
  assert.equal(withPathname("/project/other/thread/fix-auth", () => resolveRememberedTranscriptScroll("fix-auth", epoch, ROWS)), null)
  assert.deepEqual(withPathname("/project/acme", () => resolveRememberedTranscriptScroll("fix-auth", epoch, ROWS)), { kind: "tail" })
})

test("only the threads read most recently are remembered", () => {
  clearRememberedTranscriptScroll()
  const epoch = transcriptLandingEpoch([human("u1"), work("a1"), signOff("s1")], AT)
  const tail = { epoch, followingTail: true, anchor: null, openFolds: NONE }
  for (let i = 0; i < MAX_REMEMBERED_THREADS; i++) rememberTranscriptScroll(`t${i}`, tail)
  // Reading t0 again moves it to the front, so the next thread pushes out t1, the one read longest ago.
  rememberTranscriptScroll("t0", tail)
  rememberTranscriptScroll("one-more", tail)
  assert.equal(resolveRememberedTranscriptScroll("t1", epoch, ROWS), null)
  assert.deepEqual(resolveRememberedTranscriptScroll("t0", epoch, ROWS), { kind: "tail" })
  assert.deepEqual(resolveRememberedTranscriptScroll("one-more", epoch, ROWS), { kind: "tail" })
})

test("an anchor row the transcript no longer draws falls back to the landing", () => {
  clearRememberedTranscriptScroll()
  const epoch = transcriptLandingEpoch([human("u1"), work("a1"), signOff("s1")], AT)
  rememberTranscriptScroll("t", { epoch, followingTail: false, anchor: { rowKey: "gone", viewportTop: 0 }, openFolds: NONE })
  assert.equal(resolveRememberedTranscriptScroll("t", epoch, ROWS), null)
})
