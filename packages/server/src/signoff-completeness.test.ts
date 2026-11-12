// A SIGN-OFF IS THE WHOLE HANDOFF (scheduler SOURCE 18, signoff-completeness.ts) — the real fold
// (applyRecord), the real scheduler and the real board over real SQLite, with the worker simulated rest by
// rest, in the manner of question-done.test.ts (whose harness this copies).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isParkCorrection, SIGNOFF_CORRECTION_LEAD, shellDoneMessage, wakeDeliveryToken } from "@frizz/shared"
import { Bus } from "./bus.ts"
import { createBoard } from "./board.ts"
import type { Project } from "./project.ts"
import { createQuestionFaultBook } from "./question-fences.ts"
import { createScheduler } from "./scheduler.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyRecord, newTailState, type SessionTelemetry, type Tailer } from "./tailer.ts"

// A week ahead of the real clock, as question-done.test.ts explains.
const T0 = Date.now() + 7 * 86_400_000
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString()
const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``
const choice = (id: string, question = "SQLite or a JSON file?") => fence("question", `id: ${id}\nkind: choice\nquestion: ${question}\noptions:\n  - label: SQLite\n  - label: JSON file`)
const ref = (id: string) => fence("question", `id: ${id}`)
const needsInput = fence("awaiting", "status: needs_input\nfor: 1h")
const watching = fence("awaiting", "status: watching\nfor: 1d")
const wake = (message: string, id = "d1") => `${message}\n\n${wakeDeliveryToken(id)}`
const SIGNOFF = (minute: number) => `park:signoff-incomplete:${at(minute)}`

function world(opts: { rulesFrom?: number } = {}) {
  const slug = "t"
  const dir = mkdtempSync(join(tmpdir(), "frizz-signoff-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession({
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-10-15T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")
  const s = newTailState(slug, `sid-${slug}`, "/dev/null")
  const tele = (): SessionTelemetry => ({
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], retiredShells: [], retiredSubAgents: [],
    lastActivityAt: s.lastActivityAt, lastAssistantAt: s.lastAssistantAt, lastAssistant: s.lastAssistant,
    lastAssistantLine: s.lastAssistantLine, questionSightings: s.questionSightings, pendingQuestion: false,
    lastAssistantAllDone: s.lastAssistantAllDone, lastAssistantFenceAlone: s.lastAssistantFenceAlone, lastAssistantFencesOnly: s.lastAssistantFencesOnly, lastUserAt: s.lastUserAt,
    restFromAt: s.restFromAt, questionCorrectedAt: s.questionCorrectedAt, repairAskedAt: s.repairAskedAt, lastUserText: s.lastUserText, lastFence: s.lastFence,
  } as SessionTelemetry)
  const tailer = {
    get: (x: string) => (x === slug ? tele() : undefined), foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  } as unknown as Tailer
  const sent: string[] = []
  let clock = Date.parse(at(0))
  const questionFaults = createQuestionFaultBook()
  const scheduler = createScheduler({
    wakeQuietWindowMs: 0, storage, fetchPr: async () => undefined, fetchGithubReview: async () => [], questionFaults,
    signOffRulesFromMs: opts.rulesFrom ?? 0,
    tailer, resume: async (_slug: string, message: string, deliveryId: string) => { sent.push(`${message}\n\n${wakeDeliveryToken(deliveryId)}`) }, log: () => {}, now: () => clock,
  } as never)
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const board = createBoard(project, storage, new Bus(), tailer, "signoff", { claudeBrokerDaemonAlive: () => true, questionFaults: (x) => questionFaults.of(x) })
  let tools = 0
  return {
    storage, sent, board,
    tick: async (minute: number) => { clock = Date.parse(at(minute)); await scheduler.tick() },
    user: (minute: number, text: string) => applyRecord(s, { type: "user", timestamp: at(minute), message: { role: "user", content: text } } as never),
    say: (minute: number, text: string) => applyRecord(s, { type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } } as never),
    /** Mid-turn prose with a tool call after it, and the call's result. */
    narrate: (minute: number, text: string) => {
      const id = `tu${tools++}`
      applyRecord(s, { type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "text", text }, { type: "tool_use", id, name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" } } as never)
      applyRecord(s, { type: "user", timestamp: at(minute + 0.1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } } as never)
    },
    deliveries: () => storage.db.prepare("SELECT fence_id FROM wake_delivery WHERE thread_slug = ? ORDER BY rowid").all(slug).map((r) => (r as { fence_id: string }).fence_id),
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

/** Asked at a sign-off, then woken by a finished build before the human has seen it. */
async function askedThenWoken() {
  const w = world()
  w.user(0, "move the settings into a real store")
  w.say(1, `The store is the one call left; everything else is ready.\n\n${choice("store")}`)
  await w.tick(2)
  w.user(3, wake(shellDoneMessage({ taskId: "bzvt", label: "the migration", status: "completed" })))
  return w
}

// With nothing running, the question that sign-off asked is the one thing the fence waits on, and a fence
// naming nothing else is honoured for it (SOURCE 12's onQuestion).
test("woken with nothing new, a rest on the fence alone draws no correction and leaves the question's card standing", async () => {
  const w = await askedThenWoken()
  try {
    w.say(4, needsInput)
    await w.tick(5)
    // A quiet park says the same: nothing new.
    w.user(6, wake("✅ CI PASSED on acme/app#391", "d2"))
    w.say(7, watching)
    await w.tick(8)
    assert.deepEqual(w.deliveries(), [])
  } finally { w.close() }
})

test("a message that only re-lists an open question draws ONE correction naming it", async () => {
  const w = await askedThenWoken()
  try {
    w.say(4, `${ref("store")}\n\n${needsInput}`)
    await w.tick(5)
    assert.deepEqual(w.deliveries(), [SIGNOFF(4)])
    const message = w.sent[0].split("\n\n⏱")[0]
    assert.ok(message.startsWith(`${SIGNOFF_CORRECTION_LEAD}only re-lists \`store\`, with nothing written around it.`), message)
    assert.match(message, /rest on your signal fence alone/)
    assert.equal(isParkCorrection(w.sent[0]), true, "folded out of the chat like every other fence correction")
    // Once per rest, however many ticks pass.
    await w.tick(6)
    await w.tick(7)
    assert.deepEqual(w.deliveries(), [SIGNOFF(4)])
  } finally { w.close() }
})

test("a new sign-off that leaves out an open question draws a correction listing it; naming it passes", async () => {
  const missing = await askedThenWoken()
  try {
    missing.say(4, `The migration finished cleanly; 312 rows moved.\n\n${needsInput}`)
    await missing.tick(5)
    assert.deepEqual(missing.deliveries(), [SIGNOFF(4)])
    const message = missing.sent[0].split("\n\n⏱")[0]
    assert.ok(message.startsWith(`${SIGNOFF_CORRECTION_LEAD}leaves out a question still open on this thread.`), message)
    assert.match(message, /- `store` — SQLite or a JSON file\?/)
    assert.match(message, /withdraw with `frizzctl unask <id>` first/)
  } finally { missing.close() }

  const whole = await askedThenWoken()
  try {
    whole.say(4, `The migration finished cleanly; 312 rows moved. The store is still the one call left:\n\n${ref("store")}\n\n${needsInput}`)
    await whole.tick(5)
    assert.deepEqual(whole.deliveries(), [], whole.sent.join("\n---\n"))
  } finally { whole.close() }
})

test("a question the human typed past is still owed in the next sign-off, and a withdrawn one is not", async () => {
  const typedPast = world()
  try {
    typedPast.user(0, "move the settings into a real store")
    typedPast.say(1, `One call first.\n\n${choice("store")}`)
    await typedPast.tick(2)
    typedPast.user(3, "also rename the config file")
    typedPast.say(4, `Renamed it to \`frizz.config.json\`.\n\n${needsInput}`)
    await typedPast.tick(5)
    assert.deepEqual(typedPast.deliveries(), [SIGNOFF(4)])
  } finally { typedPast.close() }

  const withdrawn = world()
  try {
    withdrawn.user(0, "move the settings into a real store")
    withdrawn.say(1, `One call first.\n\n${choice("store")}`)
    await withdrawn.tick(2)
    withdrawn.user(3, "also rename the config file")
    const [q] = withdrawn.storage.listThreadQuestions("t")
    assert.equal(withdrawn.storage.withdrawThreadQuestion("t", q.id, Date.parse(at(3.5))), true)
    withdrawn.say(4, `Renamed it, and went with SQLite. One more call:\n\n${choice("alias", "Keep the old name as an alias?")}`)
    await withdrawn.tick(5)
    assert.deepEqual(withdrawn.deliveries(), [])
  } finally { withdrawn.close() }
})

test("a question asked earlier in the sign-off's own turn counts as named", async () => {
  const w = world()
  try {
    w.user(0, "move the settings into a real store")
    w.narrate(1, `Asking now so the answer can come while I work.\n\n${choice("store")}`)
    w.say(2, `Everything but the store is in.\n\n${needsInput}`)
    await w.tick(3)
    assert.deepEqual(w.deliveries(), [])
  } finally { w.close() }
})

test("a rest written before the rules took effect is never corrected", async () => {
  const w = world({ rulesFrom: Date.parse(at(10)) })
  try {
    w.user(0, "move the settings into a real store")
    w.say(1, `One call first.\n\n${choice("store")}`)
    await w.tick(2)
    w.user(3, wake("✅ CI PASSED on acme/app#391"))
    w.say(4, `${ref("store")}\n\n${needsInput}`)
    await w.tick(11)
    assert.deepEqual(w.deliveries(), [])
  } finally { w.close() }
})
