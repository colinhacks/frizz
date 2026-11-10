import assert from "node:assert/strict"
import { test } from "node:test"
import { emptyTranscriptState } from "./emptyTranscript.ts"

const loaded = { pending: false, failed: false }
const failed = { pending: false, failed: true }
const resting = { running: false, adoptable: false }

test("a failed read is drawn as a failed read, whatever the thread is doing", () => {
  // The three things this used to say instead, each a statement about the thread the read cannot support.
  assert.equal(emptyTranscriptState(failed, resting), "failed", "not: No conversation yet.")
  assert.equal(emptyTranscriptState(failed, { running: true, adoptable: false }), "failed", "not: Session starting…")
  assert.equal(emptyTranscriptState(failed, { running: false, adoptable: true }), "failed", "not: an offer to start a session")
})

test("a read still in flight is loading, and has not failed yet", () => {
  assert.equal(emptyTranscriptState({ pending: true, failed: false }, resting), "loading")
  assert.equal(emptyTranscriptState({ pending: true, failed: false }, { running: true, adoptable: false }), "loading")
})

test("a read that came back empty says what the thread is", () => {
  assert.equal(emptyTranscriptState(loaded, { running: true, adoptable: false }), "starting")
  assert.equal(emptyTranscriptState(loaded, { running: false, adoptable: true }), "adopt")
  assert.equal(emptyTranscriptState(loaded, resting), "empty")
})
