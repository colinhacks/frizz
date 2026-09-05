import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { threadIdentityName } from "@frizz/shared"
import Database from "./sqlite.ts"
import { STORAGE_TABLES, createStorage, type SessionRow, type Storage } from "./storage.ts"

// THE NET UNDER project-scope.ts. Its `prepare` refuses a statement that never names @project_id,
// but it cannot see a subquery that forgot the scope — `NOT EXISTS (SELECT 1 FROM session WHERE slug =
// @slug)` inside a statement whose outer WHERE is scoped passes the check and reads every project.
// So this file builds two projects in ONE database with IDENTICAL rows, runs every mutating method
// against one of them, and asserts the other is byte-for-byte untouched and never visible.

const row = (slug: string, sessionId: string): SessionRow => ({
  slug,
  session_id: sessionId,
  thread_name: threadIdentityName(slug),
  spawned_at: "2026-08-27T00:00:00.000Z",
  last_read_at: null,
  unread: 1,
  exited: 0,
  archived: 0,
  rested_at: null,
  title_auto: 1,
  title_locked: 0,
  title: `Title of ${slug}`,
  state: "open",
  snoozed_until: null,
  snooze_prompt: null,
  meta: null,
  seen_at: null,
  transcript_id: null,
  model: "opus",
  effort: "high",
  profile_pending_model: null,
  profile_pending_effort: null,
  profile_revision: 0,
  profile_handoff: null,
  permission_mode: null,
  permission_pending: null,
  control_error: null,
  runtime_generation: 0,
  runtime_control: null,
  runtime_control_revision: 0,
})

const SLUGS = ["alpha-thread", "beta-thread"]
const UUID = "0f7b8b3a-2a5d-4c2b-9e7a-1f2c3d4e5f60"

function seed(storage: Storage): void {
  for (const slug of SLUGS) storage.upsertSession(row(slug, `sess-${slug}`))
  storage.setSetting("font", "mono")
  storage.retireOp("alpha-thread", "sess-alpha-thread", "op-1")
  storage.armThreadTimer({ id: `${storage.projectId}-timer`, slug: "alpha-thread", prompt: "ping", fireAtMs: 9e12, createdAtMs: 1 })
  storage.armPrWatch({ id: `${storage.projectId}-pr`, slug: "alpha-thread", owner: "acme", repo: "app", number: 1, createdAtMs: 1, expiresAtMs: 9e12 })
  storage.armThreadWatch({ id: `${storage.projectId}-watch`, slug: "alpha-thread", kind: "shell", target: "sh1", createdAtMs: 1, expiresAtMs: 9e12 })
  storage.askThreadQuestion({ id: `${storage.projectId}-q`, slug: "alpha-thread", spec: "{}", askedAtMs: 1 })
  storage.markThreadDone("alpha-thread", "done body", 1)
  storage.recordSubAgentSteer({
    slug: "alpha-thread",
    subAgentId: "child",
    deliveryId: `${storage.projectId}-steer`,
    message: `steer from ${storage.projectId}`,
    sentAtMs: 1,
  })
  storage.reserveAdoptionClaim({ slug: "gamma-thread", attemptToken: UUID, sessionId: `adopt-${storage.projectId}`, reservedAtMs: 1, leaseExpiresAtMs: 2 })
}

/** Every row of every storage table for one project, in a stable order. */
function snapshot(db: Database, projectId: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const table of STORAGE_TABLES) {
    const columns = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    out[table] = db.prepare(`SELECT * FROM ${table} WHERE project_id = ? ORDER BY ${columns.join(", ")}`).all(projectId)
  }
  return out
}

function twoProjects(): { db: Database; a: Storage; b: Storage } {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "frizz-isolation-")), "ui.db"))
  const a = createStorage(db, "project-a")
  const b = createStorage(db, "project-b")
  seed(a)
  seed(b)
  return { db, a, b }
}

test("two projects in one database never see each other's rows", () => {
  const { db, a, b } = twoProjects()
  assert.deepEqual(a.allSessions().map((r) => r.session_id).sort(), ["sess-alpha-thread", "sess-beta-thread"])
  assert.equal(a.getSession("alpha-thread")!.session_id, "sess-alpha-thread")
  assert.equal(b.getSession("alpha-thread")!.session_id, "sess-alpha-thread")
  assert.deepEqual(a.listThreadTimers("alpha-thread").map((t) => t.id), ["project-a-timer"])
  assert.deepEqual(b.listThreadTimers("alpha-thread").map((t) => t.id), ["project-b-timer"])
  assert.deepEqual(a.armedPrWatches().map((w) => w.id), ["project-a-pr"])
  assert.deepEqual(a.armedThreadWatches().map((w) => w.id), ["project-a-watch"])
  assert.deepEqual(a.openThreadQuestions().map((q) => q.id), ["project-a-q"])
  assert.equal(a.getThreadTimer("project-b-timer"), undefined, "an id lookup is scoped too")
  assert.equal(a.getPrWatch("project-b-pr"), undefined)
  assert.equal(a.getThreadWatch("project-b-watch"), undefined)
  assert.equal(a.getThreadQuestion("project-b-q"), undefined)
  assert.deepEqual(a.listSubAgentSteers("alpha-thread", "child").map((s) => s.delivery_id), ["project-a-steer"])
  assert.equal(a.dueThreadTimers(1e13).length, 1)
  assert.equal(a.expiredPrWatches(1e13).length, 1)
  assert.equal(a.expiredThreadWatches(1e13).length, 1)
  assert.equal(a.getAdoptionClaim("gamma-thread")!.session_id, "adopt-project-a")
  assert.equal(a.allAdoptionClaims().length, 1)
  assert.deepEqual([...a.retiredOps("alpha-thread", "sess-alpha-thread")], ["op-1"])
  // A slug with the same name in the other project is not "taken" here.
  assert.equal(
    a.reserveAdoptionClaim({ slug: "beta-thread", attemptToken: "1f7b8b3a-2a5d-4c2b-9e7a-1f2c3d4e5f61", sessionId: "x", reservedAtMs: 1, leaseExpiresAtMs: 2 }),
    false,
    "a slug this project already registered cannot be reserved",
  )
  assert.equal(
    a.reserveAdoptionClaim({ slug: "delta-thread", attemptToken: "2f7b8b3a-2a5d-4c2b-9e7a-1f2c3d4e5f62", sessionId: "y", reservedAtMs: 1, leaseExpiresAtMs: 2 }),
    true,
  )
  a.close()
  b.close()
  db.close()
})

test("every mutating method touches only its own project", () => {
  const { db, a, b } = twoProjects()
  const before = snapshot(db, "project-b")
  const gen = { sessionId: "sess-alpha-thread", generation: 0 }
  const mutations: Array<[string, () => unknown]> = [
    ["markRead", () => a.markRead("alpha-thread")],
    ["setUnread", () => a.setUnread("alpha-thread", false)],
    ["setUnreadIfCurrent", () => a.setUnreadIfCurrent("alpha-thread", gen.sessionId, gen.generation, true)],
    ["setExited", () => a.setExited("alpha-thread", true)],
    ["setExitedIfCurrent", () => a.setExitedIfCurrent("beta-thread", "sess-beta-thread", 0, true)],
    ["setRestedAt", () => a.setRestedAt("alpha-thread", "2026-08-27T01:00:00.000Z")],
    ["setSeenAt", () => a.setSeenAt("alpha-thread", "2026-08-27T01:00:00.000Z")],
    ["setTranscriptId", () => a.setTranscriptId("alpha-thread", "t1")],
    ["setState", () => a.setState("alpha-thread", "archived")],
    ["setStateIfCurrent", () => a.setStateIfCurrent("beta-thread", "sess-beta-thread", 0, "archived")],
    ["setSnoozedUntil", () => a.setSnoozedUntil("alpha-thread", "2026-09-01T00:00:00.000Z", "wake")],
    ["setRecurringPromptBySlug", () => a.setRecurringPromptBySlug("alpha-thread", { prompt: "go", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-27T00:00:00.000Z" })],
    ["stampRecurringRestFired", () => a.stampRecurringRestFired("alpha-thread", "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:01.000Z")],
    ["countSignoffNudge", () => a.countSignoffNudge("alpha-thread", "d1")],
    ["resetSignoffNudges", () => a.resetSignoffNudges("alpha-thread")],
    ["countParkBump", () => a.countParkBump("alpha-thread", "d1")],
    ["resetParkBumps", () => a.resetParkBumps("alpha-thread")],
    ["setTitle", () => a.setTitle("alpha-thread", "Renamed")],
    ["setTitleIfCurrent", () => a.setTitleIfCurrent("beta-thread", "Renamed too", { sessionId: "sess-beta-thread", title: "Title of beta-thread", titleAuto: 1 })],
    ["setBackend", () => a.setBackend("alpha-thread", "codex")],
    ["setAgentSession", () => a.setAgentSession("alpha-thread", "native-1")],
    ["setCodexRuntime", () => a.setCodexRuntime("alpha-thread", "app-server")],
    ["setClaudeRuntime", () => a.setClaudeRuntime("alpha-thread", "broker")],
    ["setProfile", () => a.setProfile("alpha-thread", "sonnet", "low")],
    ["setPermissionMode", () => a.setPermissionMode("alpha-thread", "auto")],
    ["setPermissionPending", () => a.setPermissionPending("alpha-thread", "plan")],
    ["setControlError", () => a.setControlError("alpha-thread", "boom")],
    ["setDeliveryLedger", () => a.setDeliveryLedger("alpha-thread", "{}")],
    ["clearExpiredSnoozes", () => a.clearExpiredSnoozes("2099-01-01T00:00:00.000Z")],
    ["cancelThreadTimer", () => a.cancelThreadTimer("alpha-thread", "project-a-timer", 5)],
    ["markThreadTimerFired", () => a.markThreadTimerFired("project-b-timer", 5)],
    ["dropPrWatch", () => a.dropPrWatch("alpha-thread", "project-a-pr", 5)],
    ["settlePrWatch", () => a.settlePrWatch("project-b-pr", 5)],
    ["setPrWatchCursor", () => a.setPrWatchCursor("project-b-pr", "c")],
    ["dropThreadWatch", () => a.dropThreadWatch("alpha-thread", "project-a-watch", 5)],
    ["settleThreadWatch", () => a.settleThreadWatch("project-b-watch", 5)],
    ["answerThreadQuestion", () => a.answerThreadQuestion("project-b-q", "{}", 5)],
    ["dismissThreadQuestion", () => a.dismissThreadQuestion("project-a-q", 5)],
    ["markSettlementDelivered", () => a.markSettlementDelivered("project-a-q")],
    ["withdrawThreadQuestion", () => a.withdrawThreadQuestion("alpha-thread", "project-b-q", 5)],
    ["clearThreadDone", () => a.clearThreadDone("alpha-thread")],
    ["markThreadDone", () => a.markThreadDone("beta-thread", "b", 2)],
    ["recordSubAgentSteer", () => a.recordSubAgentSteer({ slug: "beta-thread", subAgentId: "child", deliveryId: "project-a-steer-2", message: "new", sentAtMs: 2 })],
    ["retireOp", () => a.retireOp("beta-thread", "sess-beta-thread", "op-2")],
    ["unretireOp", () => a.unretireOp("alpha-thread", "sess-alpha-thread", "op-1")],
    ["setSetting", () => a.setSetting("font", "sans")],
    ["deleteSetting", () => a.deleteSetting("font")],
    ["abandonAdoptionClaim", () => a.abandonAdoptionClaim("gamma-thread", UUID)],
    ["upsertSession (replace)", () => a.upsertSession(row("alpha-thread", "sess-alpha-thread-2"))],
    ["insertSessionIfAbsent", () => a.insertSessionIfAbsent(row("delta-thread", "sess-delta"))],
    ["forgetSession", () => a.forgetSession("beta-thread")],
    ["forgetSessionIfCurrent", () => a.forgetSessionIfCurrent("delta-thread", { sessionId: "sess-delta", runtimeGeneration: 0, adoptionAttemptToken: null })],
  ]
  for (const [name, run] of mutations) {
    run()
    assert.deepEqual(snapshot(db, "project-b"), before, `${name} reached into project-b`)
  }
  // Every one of those was a real write here: the twin's snapshot is not just untouched because the
  // method quietly did nothing.
  assert.notDeepEqual(snapshot(db, "project-a"), before)
  assert.equal(b.getSession("beta-thread")!.session_id, "sess-beta-thread")
  assert.equal(b.getThreadDone("alpha-thread")!.body, "done body")
  assert.equal(b.getSetting("font"), "mono")
  a.close()
  b.close()
  db.close()
})

test("the memoised whole-table read is not invalidated by another project's writes", () => {
  const { db, a, b } = twoProjects()
  const first = a.allSessions()
  b.setTitle("alpha-thread", "B renamed")
  assert.equal(a.allSessions(), first, "same array: project-b's write did not re-read project-a")
  a.setTitle("alpha-thread", "A renamed")
  assert.notEqual(a.allSessions(), first, "own write re-reads")
  assert.equal(a.getSession("alpha-thread")!.title, "A renamed")
  assert.equal(b.getSession("alpha-thread")!.title, "B renamed")
  a.close()
  b.close()
  db.close()
})
