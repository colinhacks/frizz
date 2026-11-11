import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { DELIVERY_RETRY_BACKOFF_MS, beginEagerSubmission, enqueueThreadSend, reanchorsOnLanding, sendFollowUpAttempt, withDeliveryRetry } from "./eagerComposerSubmission.ts"
import { isOptimisticallySteering, optimisticallySteered } from "./steering.ts"
import { partitionActive } from "../groups.ts"

test("eager composer submission clears and paints before its request settles", async () => {
  const order: string[] = []
  let resolve!: () => void
  const request = new Promise<void>((done) => { resolve = done })
  beginEagerSubmission({
    optimistic: () => order.push("cleared-and-queued"),
    request: () => { order.push("request-started"); return request },
    success: () => order.push("success"),
    failure: () => order.push("failure"),
  })
  assert.deepEqual(order, ["cleared-and-queued", "request-started"])
  resolve()
  await request
  await Promise.resolve()
  assert.deepEqual(order, ["cleared-and-queued", "request-started", "success"])
})

test("eager composer submission rolls back after a rejected request", async () => {
  const order: string[] = []
  beginEagerSubmission({
    optimistic: () => order.push("cleared-and-queued"),
    request: async () => { throw new Error("offline") },
    failure: (error) => order.push(`rolled-back:${error.message}`),
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(order, ["cleared-and-queued", "rolled-back:offline"])
})

// The composer no longer locks during a send, so nothing in the UI stops a second steer landing
// mid-flight. These pin the invariant that replaced the lock: one request at a time per thread, in
// the order the human committed them.
test("thread sends run one at a time, in submission order", async () => {
  const events: string[] = []
  const gates: Array<() => void> = []
  const start = (label: string) => enqueueThreadSend("alpha", () => {
    events.push(`start:${label}`)
    return new Promise<void>((resolve) => gates.push(() => { events.push(`end:${label}`); resolve() }))
  })

  const first = start("one")
  const second = start("two")
  const third = start("three")
  await Promise.resolve()
  // Only the head is in flight: the two behind it have not touched the network.
  assert.deepEqual(events, ["start:one"])

  gates[0]()
  await first
  await Promise.resolve()
  assert.deepEqual(events, ["start:one", "end:one", "start:two"])

  gates[1]()
  await second
  await Promise.resolve()
  gates[2]()
  await third
  assert.deepEqual(events, ["start:one", "end:one", "start:two", "end:two", "start:three", "end:three"])
})

test("a failed send rejects to its own caller without stranding the sends behind it", async () => {
  const delivered: string[] = []
  const failing = enqueueThreadSend("beta", async () => { throw new Error("runtime control busy") })
  const following = enqueueThreadSend("beta", async () => { delivered.push("after") })

  await assert.rejects(failing, /runtime control busy/)
  await following
  assert.deepEqual(delivered, ["after"])
})

test("separate threads do not queue behind each other", async () => {
  const events: string[] = []
  let releaseAlpha!: () => void
  const alpha = enqueueThreadSend("gamma", () => new Promise<void>((resolve) => {
    events.push("gamma-start")
    releaseAlpha = () => { resolve() }
  }))
  const beta = enqueueThreadSend("delta", async () => { events.push("delta-done") })

  await beta
  // delta finished while gamma is still in flight — one blocked thread must not stall the board.
  assert.deepEqual(events, ["gamma-start", "delta-done"])
  releaseAlpha()
  await alpha
})

// ── delivery retry ───────────────────────────────────────────────────────────────────────────────
// A follow-up refused by a contention gate provably never reached the worker, so it is waited out
// rather than handed back to the composer. These pin the two halves of that: what may be replayed,
// and what must never be.
const retryable = (message: string): Error =>
  Object.assign(new Error(message), { retryableRpc: true })

const instant = async (): Promise<void> => {}

test("a contention refusal is retried in place instead of surfacing", async () => {
  const attempts: number[] = []
  let calls = 0
  await withDeliveryRetry(
    async () => {
      attempts.push(++calls)
      if (calls < 3) throw retryable("Another runtime control is in progress")
    },
    () => {},
    instant,
  )
  assert.deepEqual(attempts, [1, 2, 3], "the send should land on the third attempt")
})

test("an AMBIGUOUS failure is never replayed — the text may already have reached the worker", async () => {
  let calls = 0
  await assert.rejects(
    withDeliveryRetry(async () => { calls++; throw new Error("network died mid-flight") }, () => {}, instant),
    /network died mid-flight/,
  )
  assert.equal(calls, 1, "an unmarked failure must be surfaced, not re-sent")
})

test("retries are bounded — the composer gets the message back once they are exhausted", async () => {
  let calls = 0
  await assert.rejects(
    withDeliveryRetry(async () => { calls++; throw retryable("still contended") }, () => {}, instant),
    /still contended/,
  )
  assert.equal(calls, DELIVERY_RETRY_BACKOFF_MS.length + 1, "one initial attempt plus one per backoff step")
})

// The regression the operator saw as a queue card leaving, bouncing back, then leaving again: the
// steer optimism was stamped once at Enter, so a delivery delayed by contention outlived its own hint.
test("the steer optimism is re-anchored on every attempt, not just at submit", async () => {
  let calls = 0
  let anchors = 0
  await withDeliveryRetry(
    async () => { if (++calls < 3) throw retryable("contended") },
    () => { anchors++ },
    instant,
  )
  assert.equal(anchors, 3, "two backoff re-anchors plus one when the send finally landed")
})

test("the re-anchor is told which boundary it is on: a refusal, or the send that landed", async () => {
  let calls = 0
  const seen: boolean[] = []
  await withDeliveryRetry(
    async () => { if (++calls < 3) throw retryable("contended") },
    (landed) => { seen.push(landed) },
    instant,
  )
  assert.deepEqual(seen, [false, false, true])
})

// A FAST TURN ENDS BEFORE ITS OWN followUp RETURNS. The reply is already written; re-stamping the steer at
// the call's return claimed "working" over it for the stamp's whole 12s cap — the row in the Running band,
// the card frozen on the transcript from before the send (recorded 3 of 3 against the scripted Claude,
// replythink=0 disklag=25). The board and the call's answer arrive in either order, so both are pinned.
test("a turn that ends before its own followUp returns is not re-anchored: the row rests and the card thaws", () => {
  const SENT = 1_000_000
  const LANDED = SENT + 300
  const rested = (lastActivityAt: number | undefined) => ({
    id: "t", kind: "session", state: "open", status: "active", runtime: "turn-idle", needsYou: true,
    spawnedAt: new Date(SENT - 600_000).toISOString(),
    lastUserAt: new Date(SENT + 20).toISOString(),
    lastAssistantAt: lastActivityAt === undefined ? undefined : new Date(lastActivityAt).toISOString(),
    lastActivityAt: lastActivityAt === undefined ? undefined : new Date(lastActivityAt).toISOString(),
  }) as unknown as ThreadView
  // The reply was written 160ms after the send.
  const done = rested(SENT + 160)
  const before = rested(SENT - 5_000)

  // ORDER 1 — the board reported the reply before the call answered.
  assert.equal(reanchorsOnLanding(done, SENT, SENT, LANDED), false)
  // ORDER 2 — the call answered first: the board still shows the rest from before the send, and the reply
  // it is about to report is stamped BEFORE this instant. The live stamp keeps the send's instant.
  assert.equal(reanchorsOnLanding(before, SENT, SENT, LANDED), false)

  // Either way the stamp is still the send's, so once the board reports the reply it yields: at +600ms and
  // at +3s the row is the board's own (the Queue band).
  for (const now of [SENT + 600, SENT + 3_000]) {
    assert.equal(isOptimisticallySteering(done, SENT, now), false)
    const row = optimisticallySteered(done, SENT, now)
    assert.equal(row, done, "the board's row, by identity")
    assert.deepEqual(partitionActive([row]).rested.map((t) => t.id), ["t"])
  }
  // The control: the same thread under a stamp moved to the call's return is the defect, pinned.
  assert.equal(isOptimisticallySteering(done, LANDED, SENT + 3_000), true)
  assert.deepEqual(partitionActive([optimisticallySteered(done, LANDED, SENT + 3_000)]).running.map((t) => t.id), ["t"])
})

test("a landed send re-anchors only a hint that lapsed mid-flight, and never past the board's answer", () => {
  const SENT = 1_000_000
  const at = (ms: number | undefined) => ({ lastActivityAt: ms === undefined ? undefined : new Date(ms).toISOString() })
  const SLOW = SENT + 20_000
  // A delivery slower than the cap: the hint is gone (its timer deleted it), and the tailer still has to
  // observe the turn. Stamped again — with no board activity, activity from before the send, or a thread
  // the board does not hold.
  assert.equal(reanchorsOnLanding(at(SENT - 5_000), SENT, undefined, SLOW), true)
  assert.equal(reanchorsOnLanding(at(undefined), SENT, undefined, SLOW), true)
  assert.equal(reanchorsOnLanding(undefined, SENT, undefined, SLOW), true)
  // …and a stamp left standing past its cap counts as lapsed too.
  assert.equal(reanchorsOnLanding(at(SENT - 5_000), SENT, SENT, SLOW), true)
  // But not when the board has reported anything since the send, however slow the delivery was.
  assert.equal(reanchorsOnLanding(at(SENT + 15_000), SENT, undefined, SLOW), false)
  // A refusal moved the stamp 4s in; the send lands 2s later. Live, so it stays where the refusal put it.
  assert.equal(reanchorsOnLanding(at(SENT - 5_000), SENT, SENT + 4_000, SENT + 6_000), false)
})

// ── the send deadline ────────────────────────────────────────────────────────────────────────────
// The FIFO above is what makes an unanswered send catastrophic rather than merely lost: its links are
// `tail.then(run, run)`, so a request that never settles holds every later steer on that thread behind
// it, forever, with no toast and no rollback. That is what "my steers were not reopening the thread"
// looked like from the operator's side on 2026-09-05 — the server had one `turn/start` blocked for
// 1h 18m, and every steer typed after it went nowhere and said nothing.
test("a send the server never answers gives up, so the steers behind it still go", async () => {
  const originalFetch = globalThis.fetch
  const aborted: string[] = []
  // A server that accepts the request and then never answers — the shape that wedged the chain.
  globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted.push("first")
      reject(new Error("aborted"))
    })
  })) as typeof fetch
  try {
    const order: string[] = []
    const wedged = enqueueThreadSend("deadline", () =>
      sendFollowUpAttempt("deadline", "the first steer", "delivery-1", undefined, undefined, 20)
        .then(() => { order.push("first-ok") }, () => { order.push("first-failed") }))
    const behind = enqueueThreadSend("deadline", async () => { order.push("second-ran") })

    await wedged
    await behind
    assert.deepEqual(aborted, ["first"], "the deadline fires on the request itself, not just locally")
    assert.deepEqual(order, ["first-failed", "second-ran"], "the send behind a dead one is not stranded")
  } finally {
    globalThis.fetch = originalFetch
  }
})

// The deadline must never fire on a send that IS being answered — a cold session resume plus a turn
// start is seconds, and a false abort would roll back a message the worker has already read.
test("a send that answers within the deadline is untouched by it", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ result: null }), {
    status: 200, headers: { "content-type": "application/json" },
  }))) as typeof fetch
  try {
    await sendFollowUpAttempt("deadline", "a healthy steer", "delivery-2", undefined, undefined, 60_000)
  } finally {
    globalThis.fetch = originalFetch
  }
})
