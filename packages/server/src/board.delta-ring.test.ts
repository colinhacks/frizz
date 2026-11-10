import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardDelta, ThreadView } from "@frizz/shared"
import { DeltaRing } from "./board.ts"

// The ring a socket resumes a client from (board.ts DeltaRing, app-socket.ts the board channel). What it
// promises: the deltas after a seq exactly, in order, or null — never a run with a hole in it.

function delta(seq: number, upserts = 1): BoardDelta {
  return {
    type: "board-delta",
    seq,
    bootId: "b",
    upserts: Array.from({ length: upserts }, (_, i) => ({ id: `t${seq}-${i}` }) as unknown as ThreadView),
    removed: [],
  }
}

function ring(maxDeltas?: number, maxThreads?: number) {
  let seq = 0
  const r = new DeltaRing(() => seq, maxDeltas, maxThreads)
  return {
    r,
    publish(upserts = 1) {
      r.remember(delta(++seq, upserts))
    },
    seqs: (since: number) => r.since(since)?.map((d) => d.seq) ?? null,
  }
}

test("delta ring: the deltas after a seq, exactly and in order; [] when current", () => {
  const { publish, seqs } = ring()
  for (let i = 0; i < 5; i++) publish()
  assert.deepEqual(seqs(2), [3, 4, 5])
  assert.deepEqual(seqs(0), [1, 2, 3, 4, 5])
  assert.deepEqual(seqs(5), [])
})

test("delta ring: a seq it cannot cover is null — older than the ring, ahead of the server, or not a seq", () => {
  const { publish, seqs } = ring(3)
  for (let i = 0; i < 6; i++) publish()
  assert.deepEqual(seqs(3), [4, 5, 6], "the oldest seq it can serve from")
  assert.equal(seqs(2), null, "seq 3 has rolled out of a 3-delta ring")
  assert.equal(seqs(7), null, "ahead of the server")
  assert.equal(seqs(-1), null)
  assert.equal(seqs(1.5), null)
})

test("delta ring: bounded by the thread views it holds, keeping at least the newest delta", () => {
  const { r, publish, seqs } = ring(512, 10)
  publish(4)
  publish(4)
  assert.deepEqual(seqs(0), [1, 2])
  publish(4) // 12 views held: the oldest goes
  assert.equal(r.size, 2)
  assert.equal(seqs(0), null)
  assert.deepEqual(seqs(1), [2, 3])
  publish(50) // one delta over the cap on its own (the first build after a boot) is kept alone
  assert.equal(r.size, 1)
  assert.deepEqual(seqs(3), [4])
  assert.equal(seqs(2), null)
})

test("delta ring: a seq that does not follow the last one starts the ring over rather than holding a hole", () => {
  let seq = 0
  const r = new DeltaRing(() => seq)
  r.remember(delta(++seq))
  r.remember(delta(++seq))
  seq = 5
  r.remember(delta(5))
  assert.equal(r.since(2), null, "3 and 4 were never remembered")
  assert.deepEqual(r.since(4)?.map((d) => d.seq), [5])
})

test("delta ring: a ring that is behind the server's seq serves nothing rather than a stale run", () => {
  let seq = 0
  const r = new DeltaRing(() => seq)
  r.remember(delta(++seq))
  r.remember(delta(++seq))
  seq = 3 // published without being remembered
  assert.equal(r.since(1), null)
  assert.deepEqual(r.since(3), [])
})

// AND BY AGE (RECENT_DELTA_MAX_AGE_MS). Count bounds alone kept a quiet project's last 512 deltas —
// superseded ThreadViews no client could still ask for — for the life of the server.
test("delta ring: deltas older than the age bound are dropped, on publish and on prune, and resume falls back to a read", () => {
  let seq = 0
  let now = 1_000_000
  const r = new DeltaRing(() => seq, 512, 2048, 120_000, () => now)
  const publish = () => r.remember(delta(++seq))
  for (let i = 0; i < 3; i++) publish() // seqs 1..3 at t0
  now += 90_000
  publish() // seq 4 at t0+90s
  assert.deepEqual(r.since(0)?.map((d) => d.seq), [1, 2, 3, 4], "everything is younger than two minutes")
  now += 60_000 // seqs 1..3 are now 150s old, seq 4 is 60s old
  r.prune()
  assert.equal(r.size, 1)
  assert.equal(r.since(0), null, "a resume from before the ring is a full read, never a replay with a hole")
  assert.deepEqual(r.since(3)?.map((d) => d.seq), [4])
  now += 120_001
  r.prune()
  assert.equal(r.size, 0, "a quiet project's ring empties")
  assert.deepEqual(r.since(4), [], "a client at the current seq still resumes")
  assert.equal(r.since(3), null)
  publish() // seq 5: the ring starts again from what it is handed
  assert.deepEqual(r.since(4)?.map((d) => d.seq), [5])
})

test("delta ring: control — without a clock that moves, nothing is aged out", () => {
  let seq = 0
  const r = new DeltaRing(() => seq, 512, 2048, 120_000, () => 0)
  for (let i = 0; i < 10; i++) r.remember(delta(++seq))
  r.prune()
  assert.equal(r.size, 10)
})
