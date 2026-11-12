import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { sectionThreads } from "../groups.ts"
import { nextThreadNeedingYou, phoneBands, phoneQueue } from "./mobileTriage.ts"

// Rows the way the board sends them. `needsYou` is the server's queue bit (a queue card); an ask also
// carries `pendingAsk`, which is what needsAction — and so the phone's asks-first order — keys on.
const row = (id: string, over: Partial<ThreadView> = {}) => ({
  id,
  kind: "session",
  state: "open",
  runtime: "turn-idle",
  needsYou: true,
  lastActivityAt: "2026-09-30T10:00:00.000Z",
  subAgents: [],
  bgShells: [],
  ...over,
} as unknown as ThreadView)

const ask = (id: string, at: string) => row(id, { pendingAsk: { questions: [{ question: "?", options: [] }] }, lastActivityAt: at })
const rested = (id: string, at: string) => row(id, { lastActivityAt: at })
const running = (id: string) => row(id, { runtime: "running", needsYou: false })

test("the phone's Queue and Running tabs are the rail's two bands: nothing spinning in the Queue", () => {
  const threads = [running("w1"), rested("r1", "2026-09-30T09:00:00.000Z"), ask("a1", "2026-09-30T09:30:00.000Z"), running("w2")]
  const { queue, running: spinning } = phoneBands(sectionThreads(threads, "fifo"))
  assert.deepEqual(queue.map((t) => t.id), ["a1", "r1"], "asks first, then the handoffs")
  assert.deepEqual(spinning.map((t) => t.id).sort(), ["w1", "w2"])
  assert.deepEqual(phoneQueue(threads, "fifo"), queue, "the triage loop walks the tab the board shows")
})

test("an ask the queue bit leaves under Running is still listed in the Queue, where it is counted", () => {
  // A thread frozen at a native question dialog while its turn reads running: an ask by needsAction,
  // with no queue card from the server yet.
  const frozen = row("frozen", { runtime: "running", needsYou: false, pendingAsk: { questions: [{ question: "?", options: [] }] } } as never)
  const { queue, running: spinning } = phoneBands(sectionThreads([frozen, running("w1")], "fifo"))
  assert.deepEqual(queue.map((t) => t.id), ["frozen"])
  assert.deepEqual(spinning.map((t) => t.id), ["w1"])
})

test("Done opens the next ask before any rested handoff, as the phone board lists them", () => {
  const threads = [rested("r1", "2026-09-30T09:00:00.000Z"), ask("a1", "2026-09-30T09:30:00.000Z"), rested("current", "2026-09-30T08:00:00.000Z")]
  assert.deepEqual(phoneQueue(threads).slice(0, 1).map((t) => t.id), ["a1"])
  assert.equal(nextThreadNeedingYou(threads, "current", "fifo", {})?.id, "a1")
})

test("a running thread never needs you, so the loop skips it; with nothing left it is undefined", () => {
  const threads = [running("w1"), rested("current", "2026-09-30T08:00:00.000Z")]
  assert.equal(nextThreadNeedingYou(threads, "current", "fifo", {}), undefined)
})

test("the thread being filed is never its own next", () => {
  const threads = [ask("current", "2026-09-30T08:00:00.000Z"), rested("r1", "2026-09-30T09:00:00.000Z")]
  assert.equal(nextThreadNeedingYou(threads, "current", "fifo", {})?.id, "r1")
})

test("a thread marked done a moment ago, not yet echoed by the board, is not landed on again", () => {
  const threads = [ask("just-done", "2026-09-30T08:00:00.000Z"), rested("r1", "2026-09-30T09:00:00.000Z"), rested("current", "2026-09-30T07:00:00.000Z")]
  assert.equal(nextThreadNeedingYou(threads, "current", "fifo", {})?.id, "just-done", "control: without the overlay it would be next")
  assert.equal(nextThreadNeedingYou(threads, "current", "fifo", { "just-done": Date.now() })?.id, "r1")
})
