import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { nextThreadNeedingYou, phoneQueue } from "./mobileTriage.ts"

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
