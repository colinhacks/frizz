import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { resolveThreadRoute } from "./threadRouteState.ts"

function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: "owned",
    title: "Owned",
    status: "active",
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "turn-idle",
    unread: false,
    archived: false,
    hasPlan: false,
    subAgents: [],
    bgShells: [],
    watches: [],
    pendingQuestion: false,
    questions: [],
    kind: "session",
    foreign: false,
    ...over,
  }
}

function board(threads: ThreadView[]): BoardSnapshot {
  return { threads } as BoardSnapshot
}

test("resolveThreadRoute distinguishes hydration from an authoritative missing slug", () => {
  assert.deepEqual(resolveThreadRoute(null, "owned"), { kind: "loading" })
  assert.deepEqual(resolveThreadRoute(board([]), "owned"), { kind: "missing" })
})

test("resolveThreadRoute preserves owned, foreign, and legacy ownership", () => {
  assert.equal(resolveThreadRoute(board([thread()]), "owned").kind, "found")
  assert.deepEqual(resolveThreadRoute(board([thread({ id: "foreign", foreign: true })]), "foreign"), {
    kind: "found",
    ownership: "foreign",
    thread: thread({ id: "foreign", foreign: true }),
  })
  assert.deepEqual(resolveThreadRoute(board([thread({ id: "legacy", kind: "legacy" })]), "legacy"), {
    kind: "found",
    ownership: "legacy",
    thread: thread({ id: "legacy", kind: "legacy" }),
  })
})

test("resolveThreadRoute looks the row up with the finder it is handed, and classifies what it finds", () => {
  const foreign = thread({ id: "f", foreign: true })
  const asked: string[] = []
  const find = (_b: BoardSnapshot, slug: string) => (asked.push(slug), slug === "f" ? foreign : undefined)
  const b = board([thread()])
  assert.deepEqual(resolveThreadRoute(b, "f", find), { kind: "found", ownership: "foreign", thread: foreign })
  assert.deepEqual(resolveThreadRoute(b, "owned", find), { kind: "missing" }, "the finder's answer, not a walk of the board")
  assert.deepEqual(asked, ["f", "owned"])
})
