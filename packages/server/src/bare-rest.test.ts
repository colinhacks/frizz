// A REST WITH NO SIGN-OFF IS THE WORKER'S REPLY (2026-11-19). Frizz told a worker that rested with no fence
// and no registration how to sign off (scheduler SOURCE 9) from 2026-08-12 until the maintainer accepted
// that rest as what it is: the worker's message, waiting on the human. Every test here pins a way the
// retired reminder could still reach a worker: a pass that still fires, a row an older server left in the
// outbox, or the Goal standing down for a reminder that never comes.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { NEEDS_INPUT_REQUIRED_AT } from "@frizz/shared"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import { newTailState } from "./tailer.ts"
import { createScheduler } from "./scheduler.ts"
import { createCodexBackend } from "./backend/codex.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"

const LEGACY_SPAWN = new Date(Date.parse(NEEDS_INPUT_REQUIRED_AT) - 86_400_000).toISOString()
const REST = "2026-08-12T00:01:00.000Z"

function restingThread(tele: Partial<SessionTelemetry>, opts: { runtime?: "alive" | "dead"; spawnedAt?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-bare-rest-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "resting"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `frizz-${slug}`, spawned_at: opts.spawnedAt ?? new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  const delivered: string[] = []
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage,
    tailer: {
      get: () => ({
        // The AGENT spoke last and wrote no fence: the shape of a bare rest.
        turn: "idle", lastActivityAt: REST, lastAssistantAt: REST, lastUserAt: "2026-08-12T00:00:00.000Z",
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    ...(opts.runtime ? { wakeRuntimeState: () => opts.runtime! } : {}),
    log: () => {},
  })
  const rows = () => storage.db.prepare("SELECT fence_id, state FROM wake_delivery ORDER BY id").all() as { fence_id: string; state: string }[]
  return { s, storage, slug, delivered, rows, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const goal = { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-12T00:00:00.000Z" }

test("a bare rest draws no delivery, under either contract, with or without work still running", async () => {
  const shapes: [string, Partial<SessionTelemetry>, string | undefined][] = [
    ["a reply on the answer-required contract", {}, undefined],
    ["a reply on the legacy contract", {}, LEGACY_SPAWN],
    ["a rest beside a running shell", { bgShells: [{ id: "toolu_1", taskId: "bzvtnt3ig", label: "nub run test", state: "running" }] as SessionTelemetry["bgShells"] }, undefined],
    ["a message whose fence did not end it", { strayFence: true }, undefined],
  ]
  for (const [what, tele, spawnedAt] of shapes) {
    for (const runtime of [undefined, "alive"] as const) {
      const h = restingThread(tele, { spawnedAt, runtime })
      try {
        for (let i = 0; i < 3; i++) await h.s.tick()
        assert.deepEqual(h.delivered, [], `${what} (runtime ${runtime ?? "unknown"})`)
        assert.deepEqual(h.rows(), [], `${what}: nothing is even queued`)
      } finally { h.close() }
    }
  }
})

test("a sign-off reminder an older server queued is superseded unsent, though its rest is still current", async () => {
  const h = restingThread({}, { runtime: "alive" })
  try {
    const outbox = createWakeDeliveryStore(h.storage.scope, { quietWindowMs: 0 })
    outbox.enqueue({ id: "old", slug: h.slug, sessionId: "sid", fenceId: `signoff:${REST}`, hintKey: "signoff:rest", message: "You rested without a fence", reason: "rested without signing off" }, Date.parse(REST))
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
    assert.deepEqual(h.rows(), [{ fence_id: `signoff:${REST}`, state: "superseded" }])
  } finally { h.close() }
})

// The Goal stood down for the reminder on a rest the reminder took (2026-08-28, "Redundant Dones"). With no
// reminder, the Goal is the one voice a bare rest on a Goal thread draws, once per rest.
test("on a thread with a Goal, a bare rest draws the Goal and nothing else, once", async () => {
  let fence: SessionTelemetry["lastFence"]
  const h = restingThread({ get lastFence() { return fence } } as Partial<SessionTelemetry>)
  try {
    h.storage.setRecurringPromptBySlug(h.slug, goal)
    for (let i = 0; i < 3; i++) await h.s.tick()
    assert.equal(h.delivered.length, 1, "one wake for one rest")
    assert.match(h.delivered[0], /^keep going/, "the operator's words")
    assert.doesNotMatch(h.delivered[0], /without a fence/)
    fence = { kind: "done", body: "shipped it", hints: [] }
    for (let i = 0; i < 2; i++) await h.s.tick()
    assert.equal(h.delivered.length, 1, "a done still ends the Goal's business with the rest")
  } finally { h.close() }
})

test("Codex failed turns cannot trigger an armed rest Goal", async () => {
  const fold = newTailState("resting", "sid", "/fixture")
  createCodexBackend().foldLine(fold, JSON.stringify({ timestamp: "2026-09-06T15:31:27.526Z", type: "event_msg", payload: {
    type: "task_complete", last_agent_message: null, error: { message: "Rejected", codex_error_info: "cyber_policy" },
  } }))
  const h = restingThread({ apiFault: fold.apiFault, lastAssistantAt: fold.lastAssistantAt, lastActivityAt: fold.lastActivityAt }, { runtime: "alive" })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, { ...goal, armedAt: "2026-09-06T15:00:00.000Z" })
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
    assert.deepEqual(h.rows(), [])
  } finally { h.close() }
})

test("provider failures supersede a rest Goal delivery queued before the failure was decoded", async () => {
  const h = restingThread({ apiFault: true, lastAssistantAt: "2026-08-12T00:00:00.000Z", lastUserAt: undefined }, { runtime: "alive" })
  try {
    const at = "2026-08-12T00:00:00.000Z"
    h.storage.setRecurringPromptBySlug(h.slug, { ...goal, armedAt: at })
    const outbox = createWakeDeliveryStore(h.storage.scope, { quietWindowMs: 0 })
    outbox.enqueue({ id: "stophook", slug: h.slug, sessionId: "sid", fenceId: `stophook:${at}:${at}`, hintKey: "stophook", message: "Do not deliver", reason: "Pre-upgrade failure misread as a rest" }, Date.parse(at))
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
    assert.deepEqual(h.rows().map((r) => r.state), ["superseded"])
  } finally { h.close() }
})
