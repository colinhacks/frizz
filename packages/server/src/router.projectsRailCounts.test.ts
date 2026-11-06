import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import test from "node:test"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"
import type { BoardManager } from "./board.ts"
import type { Project } from "./project.ts"

// The rail's badges: each open project's queue and Active band, plus the asks the phone's projects list shows. Handlers are lazy, so the stub carries only what `createRouter` resolves up
// front plus this procedure's one dependency: `activeTenants`, the server's view of which projects are
// open in this process and their boards.
function harness(activeTenants: AppContext["activeTenants"], own?: { project: Project; board: BoardManager }) {
  const ctx = {
    project: own?.project ?? { dir: tmpdir(), stateDir: tmpdir(), id: "own" },
    storage: {},
    board: own?.board ?? {},
    tailer: {},
    activeTenants,
  } as unknown as AppContext
  return createRouter(ctx)
}

const project = (id: string): Project => ({ id, dir: tmpdir(), stateDir: tmpdir(), name: id, label: id, cwdSlug: id })
const board = (threads: Partial<ThreadView>[]): BoardManager =>
  ({ snapshot: async () => ({ threads }) as unknown as BoardSnapshot }) as unknown as BoardManager
const session = (needsYou: boolean, extra: Partial<ThreadView> = {}): Partial<ThreadView> =>
  ({ kind: "session", state: "open", needsYou, ...extra })

test("counts the queue of every open project, keyed by id, and leaves out one that will not answer", async () => {
  const router = harness(() => [
    { project: project("a"), board: board([session(true), session(true), session(false, { runtime: "running" })]) },
    // Archived, foreign and legacy rows never queue, whatever `needsYou` says — the same predicate the
    // web's sidebar bands on (groups.ts `queued`), so the badge and the rail cannot disagree.
    { project: project("b"), board: board([session(true, { state: "archived" }), session(true, { foreign: true }), { kind: "legacy", needsYou: true }, session(true)]) },
    { project: project("c"), board: board([]) },
    // A board mid-deactivation throws from snapshot(); that project has no count this round, and the
    // others still do.
    { project: project("d"), board: { snapshot: async () => { throw new Error("board stopped") } } as unknown as BoardManager },
  ])
  assert.deepEqual(await router.projectsRailCounts.handler({ input: undefined }), {
    a: { queued: 2, running: 1, asks: 0 },
    b: { queued: 1, running: 0, asks: 0 },
    c: { queued: 0, running: 0, asks: 0 },
  })
})

test("counts the Active band as running — the rows the sidebar spins below the rule, and nothing else", async () => {
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const router = harness(() => [
    {
      project: project("p"),
      board: board([
        session(false, { runtime: "running" }), // mid-turn
        session(false, { runtime: "spawning" }), // starting
        session(false, { runtime: "turn-idle", subAgents: [{ state: "running" }] } as Partial<ThreadView>), // resting on its own sub-agent
        // Not Active: queued (the badge's other half, even with a live child), snoozed by the operator,
        // parked behind an awaiting fence the server honoured, archived, and a terminal the human owns.
        session(true, { runtime: "turn-idle", subAgents: [{ state: "running" }] } as Partial<ThreadView>),
        session(false, { runtime: "turn-idle", snoozedUntil: future }),
        session(false, { runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [] } }),
        session(false, { runtime: "exited", state: "archived" }),
        session(false, { runtime: "running", foreign: true }),
      ]),
    },
  ])
  assert.deepEqual(await router.projectsRailCounts.handler({ input: undefined }), { p: { queued: 1, running: 3, asks: 0 } })
})

test("without a tenant map (a test context, a one-project server) it answers for its own project alone", async () => {
  const router = harness(undefined, { project: project("solo"), board: board([session(true), session(false, { runtime: "running" })]) })
  assert.deepEqual(await router.projectsRailCounts.handler({ input: undefined }), { solo: { queued: 1, running: 1, asks: 0 } })
})

// The phone's projects list shows ASKS in the accent — the board header's "N need you" — not the queue,
// which also counts a rested handoff that asks the human nothing.
test("counts asks with the board's own rule: waiting on an answer, at rest, in the queue", async () => {
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const question = [{ id: "q1", askedAt: future, spec: { question: "SQLite or JSON?", kind: "question" } }]
  const router = harness(() => [
    {
      project: project("p"),
      board: board([
        session(true, { status: "active", runtime: "turn-idle", questions: question } as Partial<ThreadView>), // a registered question
        session(true, { status: "active", runtime: "turn-idle", pendingAsk: { questions: [] } } as Partial<ThreadView>), // a native ask
        session(true, { status: "active", runtime: "perm-prompt" }), // a permission prompt
        session(true, { status: "active", runtime: "turn-idle", pinnedAt: future, questions: question } as Partial<ThreadView>), // pinned still asks
        // Not asks: a rested handoff (queued, but it asks nothing), a question still mid-turn, a question
        // the operator snoozed, one on an archived thread, and a terminal the human owns.
        session(true, { status: "active", runtime: "turn-idle" }),
        session(false, { status: "active", runtime: "running", questions: question } as Partial<ThreadView>),
        session(false, { status: "active", runtime: "turn-idle", snoozedUntil: future, questions: question } as Partial<ThreadView>),
        session(false, { status: "active", runtime: "exited", state: "archived", questions: question } as Partial<ThreadView>),
        session(true, { status: "active", runtime: "turn-idle", foreign: true, questions: question } as Partial<ThreadView>),
      ]),
    },
  ])
  const counts = await router.projectsRailCounts.handler({ input: undefined })
  assert.equal(counts.p?.asks, 4)
  assert.equal(counts.p?.queued, 5, "the queue is wider than the asks")
})

// A pinned thread's plain report has no card on its board, so the badge beside that board does not count one.
test("a pinned thread's plain report leaves the queue's count, and its question does not", async () => {
  const at = "2026-11-06T10:00:00.000Z"
  const question = [{ id: "q1", askedAt: at, spec: { question: "SQLite or JSON?", kind: "question" } }]
  const router = harness(() => [
    {
      project: project("p"),
      board: board([
        session(true, { status: "active", runtime: "turn-idle", pinnedAt: at, plainReport: true } as Partial<ThreadView>),
        session(true, { status: "active", runtime: "turn-idle", pinnedAt: at, questions: question } as Partial<ThreadView>),
        session(true, { status: "active", runtime: "turn-idle", plainReport: true } as Partial<ThreadView>),
      ]),
    },
  ])
  const counts = await router.projectsRailCounts.handler({ input: undefined })
  assert.equal(counts.p?.queued, 2)
  assert.equal(counts.p?.asks, 1)
})
