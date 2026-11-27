import assert from "node:assert/strict"
import test from "node:test"
import {
  clearRememberedTranscriptScroll,
  hasRememberedTranscriptAnchor,
  rememberedTranscriptOpenFolds,
  rememberTranscriptOpenFold,
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

test("a thread the reader never moved in uses the cold-open landing", () => {
  clearRememberedTranscriptScroll()
  const epoch = transcriptLandingEpoch([human("u1"), work("a1"), work("a2")])
  assert.equal(resolveRememberedTranscriptScroll("t", epoch, ROWS), null)
  assert.equal(hasRememberedTranscriptAnchor("t"), false)
})

test("a reader who scrolled or jumped to the tail returns to the tail, even as new work messages arrive", () => {
  clearRememberedTranscriptScroll()
  const initial = [human("u1"), work("a1"), work("a2")]
  const epoch = transcriptLandingEpoch(initial)
  rememberTranscriptScroll("t", { epoch, followingTail: true, anchor: null })

  // Switching away and back while the worker appends more tool calls and quiet-park wakes keeps the same
  // landing epoch (same human turn, still no new sign-off), so the reader stays attached to the tail.
  const grown = [...initial, wake("w1"), work("a3"), work("a4")]
  const grownRows = [...ROWS.slice(0, -1), { key: "w1" }, { key: "a3" }, { key: "a4" }, { key: "runtime-status" }]
  assert.deepEqual(
    resolveRememberedTranscriptScroll("t", transcriptLandingEpoch(grown), grownRows),
    { kind: "tail" },
  )
  assert.equal(hasRememberedTranscriptAnchor("t"), false)
})

test("a reader parked mid-thread returns to the same row and viewport offset across session switches", () => {
  clearRememberedTranscriptScroll()
  const messages = [human("u1"), work("a1"), signOff("s1")]
  const epoch = transcriptLandingEpoch(messages)
  rememberTranscriptScroll("t", {
    epoch,
    followingTail: false,
    anchor: { rowKey: "a1", viewportTop: -24 },
  })

  assert.equal(hasRememberedTranscriptAnchor("t"), true)
  assert.deepEqual(
    resolveRememberedTranscriptScroll("t", epoch, ROWS),
    { kind: "anchor", index: 2, anchor: { rowKey: "a1", viewportTop: -24 } },
  )
  // Reading does not consume the memory: switching A -> B -> A -> C -> A preserves the place.
  assert.deepEqual(
    resolveRememberedTranscriptScroll("t", epoch, ROWS),
    { kind: "anchor", index: 2, anchor: { rowKey: "a1", viewportTop: -24 } },
  )
})

test("a new sign-off or a new human steer invalidates the old scroll memory so the thread lands on the new handoff", () => {
  clearRememberedTranscriptScroll()
  const before = [human("u1"), work("a1"), work("a2")]
  rememberTranscriptScroll("t", {
    epoch: transcriptLandingEpoch(before),
    followingTail: true,
    anchor: null,
  })
  rememberTranscriptOpenFold("t", transcriptLandingEpoch(before), "fold:a1")

  // A new sign-off lands while the reader is viewing another thread.
  const withSignOff = [...before, signOff("s1")]
  const nextEpoch = transcriptLandingEpoch(withSignOff)
  assert.equal(resolveRememberedTranscriptScroll("t", nextEpoch, ROWS), null)
  assert.equal(rememberedTranscriptOpenFolds("t", nextEpoch).size, 0)

  // Same when a new human steer begins a fresh stretch.
  rememberTranscriptScroll("t", {
    epoch: nextEpoch,
    followingTail: false,
    anchor: { rowKey: "a1", viewportTop: 12 },
  })
  const withNewSteer = [...withSignOff, human("u2"), work("a5")]
  assert.equal(resolveRememberedTranscriptScroll("t", transcriptLandingEpoch(withNewSteer), ROWS), null)
})

test("expanded folds are remembered per thread for the duration of the landing epoch", () => {
  clearRememberedTranscriptScroll()
  const epoch = transcriptLandingEpoch([human("u1"), work("a1"), signOff("s1")])
  rememberTranscriptOpenFold("t", epoch, "fold:a1")
  rememberTranscriptScroll("t", {
    epoch,
    followingTail: false,
    anchor: { rowKey: "a1", viewportTop: 18 },
  })
  assert.deepEqual([...rememberedTranscriptOpenFolds("t", epoch)], ["fold:a1"])
})
