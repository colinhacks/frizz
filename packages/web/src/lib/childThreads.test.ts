import { test } from "node:test"
import assert from "node:assert/strict"
import { activeBandThread, boardAskThread, drawnUnderParent, isChildThread, sectionOf, threadBandAt, type ThreadView } from "@frizz/shared"
import { isConsolePinned, isPinned, queued, sectionThreads } from "../groups.ts"
import { consoleDone, consolePinned, consoleQueue, consoleRunning, consoleSnoozed } from "./consoleBoard.ts"
import { phoneQueue } from "./mobileTriage.ts"
import { settledThread } from "./boardPartition.ts"
import { childThreadIndex, childThreadsOf, childThreadStartedAt, childThreadState } from "./childThreads.ts"
import { queueOpsCounts } from "./queueOpsCounts.ts"
import { threadOps } from "./threadOps.ts"

// CHILD THREADS ON THE BOARD (2026-11-04): a child is no row of its own — no band, no count, no pin, no
// Done — and is drawn under its parent instead (lib/childThreads). The one exception is a child the
// server queued for the human at a hard gate (needsYou), which queues as any thread does.

function thread(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return {
    id,
    title: id,
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
    state: "open",
    spawnedAt: "2026-11-04T10:00:00.000Z",
    ...over,
  } as ThreadView
}

const NOW = Date.parse("2026-11-04T12:00:00.000Z")
const ids = (xs: readonly ThreadView[]) => xs.map((t) => t.id)

// Every way a child can sit, each of which would put an ordinary thread in some band.
const parent = thread("parent", { runtime: "running" })
const childShapes: ThreadView[] = [
  thread("c-running", { parentSlug: "parent", runtime: "running" }),
  thread("c-handoff", { parentSlug: "parent", handoffToParent: true, needsYou: false }),
  thread("c-quiet-park", { parentSlug: "parent", waitStatus: "watching", awaitingBackground: true }),
  thread("c-snoozed", { parentSlug: "parent", snoozedUntil: "2026-11-05T00:00:00.000Z" as ThreadView["snoozedUntil"] }),
  thread("c-pinned", { parentSlug: "parent", pinnedAt: "2026-11-04T09:00:00.000Z", consolePinnedAt: "2026-11-04T09:00:00.000Z" }),
  thread("c-archived", { parentSlug: "parent", state: "archived", archived: true, archivedAt: "2026-11-04T11:00:00.000Z" }),
  thread("c-archived-pinned", { parentSlug: "parent", state: "archived", archived: true, pinnedAt: "2026-11-04T09:00:00.000Z" }),
  thread("c-crashed", { parentSlug: "parent", runtime: "exited", crashed: true }),
]
const gated = thread("c-perm-prompt", { parentSlug: "parent", runtime: "perm-prompt", needsYou: true })

test("the shared predicates: a child is a thread with a parent; only a hard gate brings it onto the board", () => {
  assert.equal(isChildThread(parent), false)
  assert.equal(isChildThread(thread("x", { parentSlug: "" })), false, "an empty slug names no parent")
  for (const c of childShapes) {
    assert.equal(isChildThread(c), true)
    assert.equal(drawnUnderParent(c), true, `${c.id} is drawn under its parent only`)
  }
  assert.equal(drawnUnderParent(gated), false, "a child the human must answer queues as any thread does")
  // An archive the board has not echoed yet can still carry needsYou: it is finished, so under the parent.
  assert.equal(drawnUnderParent({ ...gated, state: "archived" }), true)
})

test("a child drawn under its parent is in no band, no count and no pin, on any board", () => {
  for (const c of childShapes) {
    assert.equal(sectionOf(c), null, `${c.id}: no section`)
    assert.equal(threadBandAt(c, NOW), null, `${c.id}: no band for frizzctl threads`)
    assert.equal(activeBandThread(c), false, `${c.id}: not counted as running`)
    assert.equal(boardAskThread(c), false, `${c.id}: not an ask`)
    assert.equal(queued(c), false, `${c.id}: not queued`)
    assert.equal(isPinned(c), false, `${c.id}: no board pin`)
    assert.equal(isConsolePinned(c), false, `${c.id}: no Console pin`)
    assert.equal(settledThread(c), false, `${c.id}: never filed as Done by the partition`)
  }
  const board = [parent, ...childShapes]
  const sections = sectionThreads(board)
  for (const key of ["pinned", "active", "snoozed", "inactive"] as const) {
    assert.deepEqual(ids(sections[key]).filter((id) => id !== "parent"), [], `no child in ${key}`)
  }
  assert.deepEqual(ids(sections.active), ["parent"])
  assert.deepEqual(ids(phoneQueue(board, "fifo")), ["parent"], "the phone board rows the parent alone")
  assert.deepEqual(ids(consoleQueue(board, "fifo")), [])
  assert.deepEqual(ids(consoleRunning(board)), ["parent"])
  assert.deepEqual(ids(consolePinned(board)), [])
  assert.deepEqual(ids(consoleSnoozed(board)), [])
  assert.deepEqual(ids(consoleDone(board)), [])
})

test("a child at a hard gate queues as a card of its own, and counts as the ask it is", () => {
  const board = [parent, gated]
  assert.equal(queued(gated), true)
  assert.equal(sectionOf(gated), "active")
  assert.equal(threadBandAt(gated, NOW), "rested")
  assert.deepEqual(ids(sectionThreads(board).active).sort(), ["c-perm-prompt", "parent"])
  assert.deepEqual(ids(consoleQueue(board, "fifo")), ["c-perm-prompt"])
})

test("childThreadIndex lists a parent's open children, oldest dispatch first, and skips the archived", () => {
  const older = thread("c-older", { parentSlug: "parent", spawnedAt: "2026-11-04T09:00:00.000Z" })
  const archivedRunning = thread("c-archived-running", { parentSlug: "parent", state: "archived", archived: true, runtime: "running" })
  const board = [parent, ...childShapes, older, gated, archivedRunning, thread("other-child", { parentSlug: "other" })]
  assert.deepEqual(ids(childThreadsOf(board, "parent")), [
    "c-older",
    "c-archived-running",
    "c-crashed",
    "c-handoff",
    "c-perm-prompt",
    "c-pinned",
    "c-quiet-park",
    "c-running",
    "c-snoozed",
  ], "an archived child is finished and not listed — unless it is running; the gated child is listed AND queued")
  assert.deepEqual(ids(childThreadsOf(board, "other")), ["other-child"])
  assert.deepEqual(childThreadsOf(board, "nobody"), [])
  assert.equal(childThreadIndex(board), childThreadIndex(board), "built once per board array")
})

test("a child's row state and clock", () => {
  const running = thread("r", { parentSlug: "p", runtime: "running", lastUserAt: "2026-11-04T11:50:00.000Z" })
  assert.equal(childThreadState(running), "running")
  assert.equal(childThreadStartedAt(running), "2026-11-04T11:50:00.000Z", "the current stretch of work, not the dispatch")
  const subAgentOut = thread("s", { parentSlug: "p", subAgents: [{ id: "a", label: "a", state: "running", startedAt: "2026-11-04T11:00:00.000Z" }] as ThreadView["subAgents"] })
  assert.equal(childThreadState(subAgentOut), "running", "at rest with its own sub-agent still going is still working")
  const rested = thread("z", { parentSlug: "p", handoffToParent: true })
  assert.equal(childThreadState(rested), "rested")
  assert.equal(childThreadStartedAt(rested), undefined, "a rested child carries no running clock")
  assert.equal(childThreadState(thread("c", { parentSlug: "p", runtime: "exited", crashed: true })), "stale")
  assert.equal(childThreadState(gated), "rested")
})

test("the ops over a prompt box count the children threadOps lists, beside the sub-agents", () => {
  const children = [childShapes[0]!, childShapes[1]!]
  assert.deepEqual(ids(threadOps(parent, [], children).children), ids(children))
  assert.deepEqual(threadOps(parent).children, [], "no children unless the caller reads them")
  const counts = queueOpsCounts(parent, [], children)
  const child = counts.find((c) => c.key === "child")
  assert.ok(child)
  assert.equal(child.n, 2)
  assert.equal(`${child.n} ${child.many}`, "2 child threads")
  assert.deepEqual(child.states, ["running", "rested"])
  assert.equal(queueOpsCounts(parent).some((c) => c.key === "child"), false, "an empty kind is dropped")
})
