import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { childThreadFooter, type BoardSnapshot, type DispatchInput, type ThreadMessageSender } from "@frizz/shared"
import type { AuditRecord } from "./audit.ts"
import { createBoard, deriveChildHandoff, type BoardManager } from "./board.ts"
import { Bus, Emitter } from "./bus.ts"
import { liveChildThreads } from "./child-threads.ts"
import type { AppContext } from "./context.ts"
import type { DispatchOptions } from "./dispatch.ts"
import type { Project } from "./project.ts"
import { syncQuestionFences } from "./question-fences.ts"
import { createRouter } from "./router.ts"
import { createScheduler } from "./scheduler.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import { buildWorkerPrompt } from "./workerPrompt.ts"

// CHILD THREADS (Settings.childThreads, 2026-11-04): a thread spawned with `frizzctl spawn-child` reports to
// the thread that spawned it. Each rule is pinned at the level it lives — the queue verdict in the board,
// the liveness a `threads:` park reads, the spawn in the router, the refusal at the fence — and one case
// runs the real board and the real scheduler together, because the seam between the board's verdict and
// the scheduler's delivery is where this feature could quietly do nothing.

const T0 = "2026-11-04T10:00:00.000Z"
const T1 = "2026-11-04T10:05:00.000Z"
const T2 = "2026-11-04T10:20:00.000Z"

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: T0, last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: slug,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

function tele(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, ...over }
}

function tailerOf(map: Map<string, SessionTelemetry>): Tailer {
  return {
    get: (slug: string) => map.get(slug),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  } as unknown as Tailer
}

function sandbox(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-child-threads-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  t.after(() => {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  return { dir, storage, project }
}

test("a child's rest that would have queued is its parent's; approvals, asks, secrets and limit stops stay with the human", () => {
  const base = {
    parentSlug: "parent", queuesForHuman: true, runtime: "turn-idle" as const, actionableInteraction: false,
    pendingAsk: false, limitPause: false, secretStanding: false,
  }
  assert.equal(deriveChildHandoff(base), true)
  assert.equal(deriveChildHandoff({ ...base, parentSlug: undefined }), false, "an orphan, or no child at all, queues as any thread does")
  assert.equal(deriveChildHandoff({ ...base, queuesForHuman: false }), false, "a quiet park tells nobody anything")
  for (const gate of [
    { runtime: "perm-prompt" as const }, { actionableInteraction: true }, { pendingAsk: true }, { limitPause: true }, { secretStanding: true },
  ]) assert.equal(deriveChildHandoff({ ...base, ...gate }), false, JSON.stringify(gate))
})

test("a parent waits on a child until the child's latest rest has been reported to it", () => {
  const children = [
    row("working"),
    row("parked"),
    row("reported", { child_reported_at: T1 }),
    row("rested-again", { child_reported_at: T1 }),
    row("archived", { state: "archived", archived: 1 }),
  ]
  const map = new Map<string, SessionTelemetry>([
    ["working", tele({ turn: "in-flight", lastAssistantAt: T1 })],
    ["parked", tele({ lastAssistantAt: T1 })],
    ["reported", tele({ lastAssistantAt: T1 })],
    ["rested-again", tele({ lastAssistantAt: T2 })],
    ["archived", tele({ lastAssistantAt: T1 })],
  ])
  assert.deepEqual([...liveChildThreads(children, (slug) => map.get(slug))].sort(), ["parked", "rested-again", "working"])
})

test("a child's done reaches its parent once, through the board's own verdict, and never enters the human's queue", async (t) => {
  const { storage, project } = sandbox(t)
  storage.upsertSession(row("parent"))
  storage.upsertSession(row("child"))
  storage.setParentSlug("child", "parent")
  const map = new Map<string, SessionTelemetry>([
    ["parent", tele({ turn: "in-flight", lastUserAt: T0 })],
    ["child", tele({ lastUserAt: T0, lastAssistantAt: T1, lastFence: { kind: "done", body: "- Fixed the resolver.", hints: [] } })],
  ])
  const tailer = tailerOf(map)
  const board: BoardManager = createBoard(project, storage, new Bus(), tailer, "boot")
  const viewOf = async (slug: string) => (await board.rebuild()).threads.find((v) => v.id === slug)!

  const child = await viewOf("child")
  assert.equal(child.parentSlug, "parent")
  assert.equal(child.needsYou, false, "a child handing off is out of the queue")
  assert.equal(child.handoffToParent, true)
  assert.equal(child.handoffRestAt, T1)

  const delivered: { from: ThreadMessageSender; to: string; message: string }[] = []
  const corrected: string[] = []
  const scheduler = createScheduler({
    storage, tailer, resume: (slug) => void corrected.push(slug), log: () => {}, wakeQuietWindowMs: 0,
    now: () => Date.parse(T2),
    boardThreads: async () => (await board.rebuild()).threads,
    lastAssistantText: () => "Fixed the resolver; `npm test` green.",
    deliverToThread: async (sent) => void delivered.push(sent),
  })
  await scheduler.tick()
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]!.to, "parent")
  assert.equal(delivered[0]!.from.slug, "child")
  assert.match(delivered[0]!.message, /came to rest: it signed off as done/)
  assert.match(delivered[0]!.message, /Fixed the resolver; `npm test` green\./)
  assert.equal(storage.getSession("child")!.child_reported_at, T1, "the reported rest is remembered on the row")

  await scheduler.tick()
  assert.equal(delivered.length, 1, "the same rest is never reported twice")

  // A later rest is a new handoff.
  map.set("child", tele({ lastUserAt: T1, lastAssistantAt: T2, lastFence: { kind: "awaiting", body: "Which name should the flag take?", hints: [{ kind: "status", value: "needs_input" }] } }))
  await scheduler.tick()
  assert.equal(delivered.length, 2, "a child's needs_input names its parent, so it is a handoff and not a fence to correct")
  assert.match(delivered[1]!.message, /it is waiting on you/)
  assert.deepEqual(corrected, [], "nothing was sent back to the child")
  await scheduler.stop()
})

test("a child rest Frizz is still nudging is not reported until the child has answered", async (t) => {
  const { storage, project } = sandbox(t)
  // Dispatched after the cut that requires a `status:` answer, so a bare rest earns the sign-off nudge.
  storage.upsertSession(row("parent", { spawned_at: new Date().toISOString() }))
  storage.upsertSession(row("child", { spawned_at: new Date().toISOString() }))
  storage.setParentSlug("child", "parent")
  const now = Date.now()
  const map = new Map<string, SessionTelemetry>([
    ["parent", tele({ turn: "in-flight" })],
    ["child", tele({ lastUserAt: new Date(now - 120_000).toISOString(), lastAssistantAt: new Date(now - 60_000).toISOString(), lastAssistant: "Looked into it." })],
  ])
  const tailer = tailerOf(map)
  const board = createBoard(project, storage, new Bus(), tailer, "boot")
  const delivered: unknown[] = []
  const resumes: string[] = []
  const scheduler = createScheduler({
    storage, tailer, log: () => {}, wakeQuietWindowMs: 0, now: () => now,
    resume: (slug) => void resumes.push(slug),
    boardThreads: async () => (await board.rebuild()).threads,
    lastAssistantText: () => "Looked into it.",
    deliverToThread: async (sent) => void delivered.push(sent),
  })
  await scheduler.tick()
  assert.deepEqual(resumes, ["child"], "the child is nudged to sign off")
  assert.equal(delivered.length, 0, "and its parent hears nothing while that nudge is out")
  await scheduler.stop()
})

/** A router over one real storage whose dispatcher records what it is asked to start. */
function routerHarness(t: { after: (fn: () => void) => void }, childThreads: boolean) {
  const { storage, project } = sandbox(t)
  const snapshot = { threads: [] } as unknown as BoardSnapshot
  const dispatched: { input: DispatchInput; opts: DispatchOptions | undefined }[] = []
  const ctx = {
    project, storage,
    board: { refresh: () => snapshot, snapshot: async () => snapshot } as unknown as BoardManager,
    tailer: tailerOf(new Map()),
    transcriptChange: new Emitter<string[]>(),
    bus: new Bus(),
    getSettings: () => ({ childThreads }),
    dispatcher: {
      dispatch: async (input: DispatchInput, opts?: DispatchOptions) => {
        dispatched.push({ input, opts })
        return { slug: "new-child", sessionId: "sid-new-child" }
      },
    },
    audit: { append: (_record: AuditRecord) => {} },
  } as unknown as AppContext
  return { storage, router: createRouter(ctx), dispatched }
}

const ask = { model: "opus", effort: "high" as const, prompt: "Fix the resolver and shepherd its PR." }

test("spawn-child is refused while the experiment is off", async (t) => {
  const h = routerHarness(t, false)
  h.storage.upsertSession(row("parent"))
  const made = await h.router.spawnChild.handler({ input: { ...ask, from: "parent" } })
  assert.ok("refused" in made)
  assert.match(made.refused, /switched off/)
  assert.equal(h.dispatched.length, 0)
})

test("spawn-child links the child, tells it whose it is, and starts it in its parent's mode on the same harness only", async (t) => {
  const h = routerHarness(t, true)
  h.storage.upsertSession(row("parent", { title: "Triage the issues", permission_mode: "auto" }))

  const made = await h.router.spawnChild.handler({ input: { ...ask, from: "parent" } })
  assert.deepEqual(made, { slug: "new-child", sessionId: "sid-new-child" })
  const [same] = h.dispatched
  assert.deepEqual(same!.opts, { backend: "claude", parentSlug: "parent", permissionMode: "auto" })
  assert.equal(same!.input.prompt, ask.prompt + childThreadFooter({ slug: "parent", title: "Triage the issues" }))

  await h.router.spawnChild.handler({ input: { ...ask, model: "gpt-5.6-sol", backend: "codex", from: "parent" } })
  assert.deepEqual(h.dispatched[1]!.opts, { backend: "codex", parentSlug: "parent" }, "a mode does not cross harnesses")
})

test("a child cannot start children of its own", async (t) => {
  const h = routerHarness(t, true)
  h.storage.upsertSession(row("parent"))
  h.storage.upsertSession(row("child"))
  h.storage.setParentSlug("child", "parent")
  const made = await h.router.spawnChild.handler({ input: { ...ask, from: "child" } })
  assert.ok("refused" in made)
  assert.match(made.refused, /children cannot start children/)
  assert.equal(h.dispatched.length, 0)
})

test("a child's question fence is refused toward its parent, and only a secret still reaches the human", (t) => {
  const { storage } = sandbox(t)
  storage.upsertSession(row("child"))
  const at = new Date(Date.now() + 7 * 86_400_000).toISOString()
  const fence = (body: string) => `\`\`\`question\n${body}\n\`\`\``
  const sightings = [{
    at,
    text: [
      fence("id: flag-name\nkind: choice\nquestion: Which name should the flag take?\noptions:\n  - label: --child\n    recommended: true\n  - label: --report-to"),
      fence("id: npm-otp\nkind: secret\nquestion: The npm one-time code"),
    ].join("\n\n"),
  }]
  const out = syncQuestionFences(storage, { slug: "child", spawnedAt: T0, sightings, childOf: { slug: "parent", title: "Triage the issues" } })
  assert.deepEqual(out.faults.map((f) => f.id), ["flag-name"])
  assert.match(out.faults[0]!.faults[0]!, /child thread of «Triage the issues»/)
  assert.deepEqual(storage.listThreadQuestions("child").map((q) => q.handle), ["npm-otp"])
})

test("the contract teaches child threads only while the experiment is on", () => {
  for (const kind of ["claude", "codex", "acp"] as const) {
    assert.doesNotMatch(buildWorkerPrompt(kind), /## Child threads/, kind)
    assert.match(buildWorkerPrompt(kind, { childThreads: true }), /## Child threads \(an experiment the operator switched on\)/, kind)
  }
})

// Keep the type import honest: the harness's storage is the real one.
void (null as unknown as Storage)
