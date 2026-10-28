// A PARK THAT NOTHING WILL WAKE IS NOT A PARK (reported 2026-10-25: "The snoozed items are often frozen
// waiting for something that will never happen"). Of fourteen Snoozed threads in one project, five were PR
// parks with green CI and only the maintainer's merge left, and two were PR parks on red CI their workers had
// chosen not to fix. The rule (awaiting parkWaitsOnThisSide): a park naming nothing but PRs that wait on this
// side is not honoured, so the board queues the thread and the scheduler tells the worker why, exactly as it
// does a park on a dead name. Driven through the real fold (both backends' paths), the real board and the
// real scheduler.
//
// A run of quiet timer parks is deliberately NOT one of these: see parkWaitsOnThisSide for the replay that
// ruled it out.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isParkCorrection, isSnoozed, NEEDS_INPUT_REQUIRED_AT, type GithubWatchStatus } from "@frizz/shared"
import { GITHUB_STATUS_SETTING, parkIsHonoured, readAwaitingPark, type LiveActivity } from "./awaiting.ts"
import { Bus } from "./bus.ts"
import { createBoard } from "./board.ts"
import type { Project } from "./project.ts"
import { createScheduler } from "./scheduler.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyEvent, applyRecord, newTailState, type FenceView, type SessionTelemetry, type Tailer } from "./tailer.ts"

const T0 = Date.now() + 7 * 86_400_000
const at = (minute: number, ms = 0) => new Date(T0 + minute * 60_000 + ms).toISOString()
const PR = "acme/app#412"
const PR_PARK = "```awaiting\nprs: [acme/app#412]\nstatus: watching\nfor: 180d\n```"
const READY: GithubWatchStatus = {
  checks: "passing", running: 0, passed: 85, failed: 0, skipped: 30, gated: 0, gating: [], failing: [],
  merge: "mergeable", state: "open", polledAt: at(0), mergePath: "none", viewerAuthored: true, viewerCanMerge: true, reviewRequested: false,
}
const RED: GithubWatchStatus = { ...READY, checks: "failing", passed: 80, failed: 2, failing: ["lint"], merge: "blocked" }
// Each of these is a PR that someone or something else will move, so a park on it is a real wait.
const MOVED_ELSEWHERE: [GithubWatchStatus, string][] = [
  [{ ...READY, viewerCanMerge: false }, "a maintainer of someone else's repo merges it"],
  [{ ...READY, viewerAuthored: false }, "its author merges their own PR"],
  [{ ...RED, viewerAuthored: false }, "its author pushes the fix"],
  [{ ...READY, reviewRequested: true }, "a requested reviewer has not answered"],
  [{ ...READY, mergePath: "auto" }, "auto-merge lands it"],
  [{ ...READY, mergePath: "queued" }, "the merge queue lands it"],
  [{ ...READY, checks: "running", running: 3, passed: 82 }, "CI is still running"],
  [{ ...RED, running: 3 }, "a job has failed but others are still running"],
  [{ ...READY, merge: "blocked" }, "a required review is outstanding"],
  [{ checks: "passing", running: 0, passed: 85, failed: 0, skipped: 30, gated: 0, gating: [], failing: [], merge: "mergeable", state: "open", polledAt: at(0) }, "a reading that does not say who it waits on"],
]

// ---- honour ----

test("a park on nothing but PRs that wait on this side is not honoured; anything else beside them is", () => {
  const live = (idle: string[]): LiveActivity => ({
    shells: new Set(["bzvtnt3ig"]), agents: new Set(), timers: new Set(), prs: new Set([PR, "acme/app#9"]), idlePrs: new Set(idle),
  })
  const park = (hints: FenceView["hints"]) => readAwaitingPark([...hints, { kind: "for", value: "180d" }])
  const pr = (value: string) => ({ kind: "pr" as const, value })
  assert.equal(parkIsHonoured(park([pr(PR)]), live([PR])), false, "the PR waits on this side")
  assert.equal(parkIsHonoured(park([pr("https://github.com/acme/app/pull/412")]), live([PR])), false, "named by URL, read the same")
  assert.equal(parkIsHonoured(park([pr(PR), pr("acme/app#9")]), live([PR])), true, "the other PR is a real wait")
  assert.equal(parkIsHonoured(park([pr(PR), { kind: "shell", value: "bzvtnt3ig" }]), live([PR])), true, "the shell will wake it")
  assert.equal(parkIsHonoured(park([pr(PR), { kind: "step", value: "Merge [acme/app#412](https://github.com/acme/app/pull/412)" }]), live([PR])), true,
    "steps beside it ARE the handoff this rule asks for")
  assert.equal(parkIsHonoured(park([pr(PR)]), { ...live([]), idlePrs: undefined }), true, "no reading is never read as nobody")
})

// ---- the board ----

function world(backend: "claude" | "codex", github: GithubWatchStatus) {
  const slug = "t"
  const dir = mkdtempSync(join(tmpdir(), "frizz-stalled-park-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession({
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: at(-60),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setBackend(slug, backend)
  if (backend === "claude") storage.setClaudeRuntime(slug, "broker")
  else storage.setCodexRuntime(slug, "app-server")
  storage.armPrWatch({ id: "prw_1", slug, owner: "acme", repo: "app", number: 412, createdAtMs: Date.parse(at(0)), expiresAtMs: Date.parse(at(0)) + 180 * 86_400_000 })
  storage.setSetting(GITHUB_STATUS_SETTING, { [PR]: github })
  const s = newTailState(slug, `sid-${slug}`, "/dev/null")
  const tele = (): SessionTelemetry => ({
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], retiredShells: [], retiredSubAgents: [], pendingQuestion: false,
    lastActivityAt: s.lastActivityAt, lastAssistantAt: s.lastAssistantAt, lastAssistant: s.lastAssistant, lastAssistantLine: s.lastAssistantLine,
    lastUserAt: s.lastUserAt, restFromAt: s.restFromAt, handoffAt: s.handoffAt, lastUserText: s.lastUserText, lastFence: s.lastFence,
    questionSightings: s.questionSightings,
  } as SessionTelemetry)
  const tailer = {
    get: (x: string) => (x === slug ? tele() : undefined), foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  } as unknown as Tailer
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const board = createBoard(project, storage, new Bus(), tailer, "stalled-park", { claudeBrokerDaemonAlive: () => true, now: () => Date.parse(at(2)) })
  // Codex folds a final message twice — as the final text and again on `task_complete` a moment later —
  // so its `turn-end` lands at its own instant here, as it does in a real rollout.
  const say = backend === "claude"
    ? (minute: number, text: string) => applyRecord(s, { type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } } as never)
    : (minute: number, text: string) => {
        applyEvent(s, { kind: "assistant-text", at: at(minute), text, final: true })
        applyEvent(s, { kind: "turn-end", at: at(minute, 109), finalText: text })
      }
  const user = backend === "claude"
    ? (minute: number, text: string) => applyRecord(s, { type: "user", timestamp: at(minute), message: { role: "user", content: text } } as never)
    : (minute: number, text: string) => {
        applyEvent(s, { kind: "user-message", at: at(minute), text, synthetic: false })
        applyEvent(s, { kind: "turn-start", at: at(minute) })
      }
  return {
    say, user,
    // The resting card's "until activity" (router snoozeAwaitingBackground): the snooze captures the rest.
    snoozeUntilActivity: () => {
      storage.setRestedAt(slug, s.lastAssistantAt!)
      assert.equal(storage.setBgSnoozeRestedAtIfCurrent(slug, `sid-${slug}`, 0, s.lastAssistantAt!), true)
    },
    view: () => board.refresh().threads.find((x) => x.id === slug)!,
    close: () => { board.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

for (const backend of ["claude", "codex"] as const) {
  test(`${backend}: a PR park waiting only on our own merge or our own fix queues`, () => {
    for (const status of [READY, RED, { ...READY, merge: "conflicting" as const }]) {
      const w = world(backend, status)
      try {
        w.user(0, "own acme/app#412")
        w.say(1, PR_PARK)
        const v = w.view()
        assert.equal(v.needsYou, true)
        assert.equal(isSnoozed(v), false)
      } finally { w.close() }
    }
  })

  test(`${backend}: a PR park that someone or something else will move stays snoozed`, () => {
    for (const [status, why] of MOVED_ELSEWHERE) {
      const w = world(backend, status)
      try {
        w.user(0, "own acme/app#412")
        w.say(1, PR_PARK)
        assert.equal(w.view().needsYou, false, why)
      } finally { w.close() }
    }
  })

  test(`${backend}: the human's "until activity" on such a park holds it in Snoozed`, () => {
    const w = world(backend, READY)
    try {
      w.user(0, "own acme/app#412")
      w.say(1, PR_PARK)
      assert.equal(w.view().needsYou, true)
      w.snoozeUntilActivity()
      assert.equal(w.view().needsYou, false)
    } finally { w.close() }
  })
}

// ---- the worker is told ----

const NEW_CONTRACT = new Date(Date.parse(NEEDS_INPUT_REQUIRED_AT) + 60_000).toISOString()
const QUIET: FenceView["hints"] = [{ kind: "pr", value: PR }, { kind: "status", value: "watching" }, { kind: "for", value: "180d" }]

function schedulerWorld(github: GithubWatchStatus, hints: FenceView["hints"] = QUIET, spawnedAt = NEW_CONTRACT) {
  const slug = "parked"
  const dir = mkdtempSync(join(tmpdir(), "frizz-stalled-park-sched-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.setSetting("signoffNudge", "off")
  const restedAt = new Date(Date.now() - 60_000).toISOString()
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `frizz-${slug}`, spawned_at: spawnedAt,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: restedAt, title_auto: 0,
    title: null, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.armPrWatch({
    id: "prw_park0000001", slug, owner: "acme", repo: "app", number: 412,
    createdAtMs: Date.parse(restedAt), expiresAtMs: Date.parse(restedAt) + 365 * 86_400_000,
  })
  storage.setSetting(GITHUB_STATUS_SETTING, { [PR]: github })
  const sent: string[] = []
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage,
    // Stubbed so the armed watcher never reaches the real `gh`, and the reading above stays the one read.
    fetchPr: async () => undefined,
    fetchGithubReview: async () => [],
    tailer: {
      get: () => ({
        turn: "idle", lastAssistantAt: restedAt, lastActivityAt: restedAt, subAgents: [], bgShells: [], retiredShells: [],
        pendingQuestion: false, permPrompt: false, lastFence: { kind: "awaiting", body: "", hints },
      }),
    } as never,
    resume: async (_slug, message) => { sent.push(message) },
    log: () => {},
  })
  const queued = () => storage.db.prepare("SELECT fence_id, message FROM wake_delivery WHERE thread_slug = ?").all(slug) as { fence_id: string; message: string }[]
  return { s, queued, sent, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("a park on our own green PR tells the worker the merge is left, and to hand it over", async () => {
  const h = schedulerWorld(READY)
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1, "refused, and never silently")
    assert.match(rows[0].fence_id, /^park:pr-idle:/)
    assert.ok(isParkCorrection(rows[0].message), "the transcript reads it as frizz's correction")
    assert.match(rows[0].message, /`prs: \[acme\/app#412\]` — .*only the merge is left/)
    assert.match(rows[0].message, /`steps:`/, "names the way out")
    assert.equal(h.sent.length, 1, "and it is delivered, not just queued")
  } finally { h.close() }
})

test("a park on our own red PR says the fix is left", async () => {
  const h = schedulerWorld(RED)
  try {
    await h.s.tick()
    assert.match(h.queued()[0]?.message ?? "", /CI FAILED, and nobody else will push the fix/)
  } finally { h.close() }
})

// The correction follows the board exactly: it reads the PRs only on a quiet park, and on any thread that
// wrote one, whatever contract it was dispatched under.
test("an older thread that answers `status: watching` is told too, as the board refuses it", async () => {
  const h = schedulerWorld(READY, QUIET, "2026-08-15T11:00:00.000Z")
  try {
    await h.s.tick()
    assert.equal(h.queued().filter((r) => r.fence_id.startsWith("park:pr-idle:")).length, 1)
  } finally { h.close() }
})

test("no correction where someone else will move the PR, where the rest hands it over, or with no answer", async () => {
  const cases: [GithubWatchStatus, FenceView["hints"], string, string][] = [
    ...MOVED_ELSEWHERE.map(([status, why]) => [status, QUIET, NEW_CONTRACT, why] as [GithubWatchStatus, FenceView["hints"], string, string]),
    [READY, [{ kind: "pr", value: PR }, { kind: "step", value: "Merge [acme/app#412](https://github.com/acme/app/pull/412)" }], NEW_CONTRACT, "the steps are the handoff"],
    [READY, [{ kind: "pr", value: PR }, { kind: "status", value: "needs_input" }, { kind: "for", value: "180d" }], NEW_CONTRACT, "a needs_input handoff on its own green PR is the rest this asks for"],
    [READY, [{ kind: "pr", value: PR }, { kind: "for", value: "180d" }], "2026-08-15T11:00:00.000Z", "a legacy park with no answer is read by rules that never see the PR readings"],
  ]
  for (const [status, hints, spawnedAt, why] of cases) {
    const h = schedulerWorld(status, hints, spawnedAt)
    try {
      await h.s.tick()
      assert.deepEqual(h.queued().map((r) => r.fence_id).filter((id) => id.startsWith("park:pr-idle:")), [], why)
    } finally { h.close() }
  }
})
