import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { sectionThreads } from "../groups.ts"
import { nextThreadNeedingYou, phoneBands, phoneQueue } from "./mobileTriage.ts"

// Rows the way the board sends them: `needsYou` means a queue card; `pendingAsk` also covers native asks.
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

const pendingAsk = { questions: [{ question: "?", options: [] }] } as ThreadView["pendingAsk"]
const ask = (id: string, at: string) => row(id, { pendingAsk, lastAssistantAt: at })
const rested = (id: string, at: string) => row(id, { lastAssistantAt: at })
const running = (id: string) => row(id, { runtime: "running", needsYou: false })

test("the phone Queue sorts asks and handoffs together in either direction, below pins", () => {
  const older = ask("project-a~question", "2026-10-18T09:00:00Z")
  const newer = rested("project-b~handoff", "2026-11-18T09:00:00Z")
  const pin = row("project-b~pin", { pinnedAt: "2026-10-15T09:00:00Z" })
  const worker = running("project-a~running")
  const threads = [older, worker, pin, newer]
  const fifo = phoneBands(sectionThreads(threads, "fifo"), "fifo")
  const lifo = phoneBands(sectionThreads(threads, "lifo"), "lifo")
  assert.deepEqual(fifo.queue, [pin, older, newer])
  assert.deepEqual(lifo.queue, [pin, newer, older])
  assert.deepEqual(lifo.running, [worker])
  assert.deepEqual(phoneQueue(threads, "lifo"), lifo.queue, "the triage loop walks the tab the board shows")
})

test("a native ask from Running still appears in the Queue at its sorted position", () => {
  // A thread frozen at a native question dialog while its turn reads running: an ask by needsAction,
  // with no queue card from the server yet.
  const frozen = row("frozen", { runtime: "running", needsYou: false, pendingAsk, lastUserAt: "2026-09-30T09:00:00Z" })
  const older = rested("older", "2026-09-30T08:00:00Z")
  const newer = rested("newer", "2026-09-30T10:00:00Z")
  const { queue, running: spinning } = phoneBands(sectionThreads([older, newer, frozen, running("w1")], "lifo"), "lifo")
  assert.deepEqual(queue, [newer, frozen, older])
  assert.deepEqual(spinning.map((t) => t.id), ["w1"])
})

test("Done opens the next queue card in the selected time order", () => {
  const threads = [rested("r1", "2026-09-30T09:00:00.000Z"), ask("a1", "2026-09-30T09:30:00.000Z"), rested("current", "2026-09-30T08:00:00.000Z")]
  assert.equal(nextThreadNeedingYou(threads, "current", "fifo", {})?.id, "r1")
  assert.equal(nextThreadNeedingYou(threads, "current", "lifo", {})?.id, "a1")
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
