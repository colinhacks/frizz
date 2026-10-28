// A HANDOFF STAYS IN THE QUEUE UNTIL THE HUMAN REACHES IT (reported 2026-10-27, of a Snoozed thread whose
// PR was green and waiting on their merge: "it looks green to me"). The worker rested `status: needs_input`
// on its registered PR; the watcher then woke it for CI and an approval it had already read, and it re-parked
// `status: watching` with nothing to add. That quiet park took the thread out of the queue, so the handoff it
// replaced was never seen. The rule (board needsInputQueues): a quiet park cannot spend a `needs_input` rest
// the human has not typed past, exactly as it cannot spend an open question. Driven through the real fold
// (both backends' paths) and the real board.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isSnoozed, wakeDeliveryToken, type GithubWatchStatus } from "@frizz/shared"
import { GITHUB_STATUS_SETTING } from "./awaiting.ts"
import { Bus } from "./bus.ts"
import { createBoard } from "./board.ts"
import type { Project } from "./project.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyEvent, applyRecord, newTailState, type SessionTelemetry, type Tailer } from "./tailer.ts"

const T0 = Date.now() + 7 * 86_400_000
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString()
const PR = "acme/app#391"
const READY = "```awaiting\nprs: [acme/app#391]\nstatus: needs_input\nfor: 180d\ntitle: Ready, unmerged\n---\nReady at 0251203e; the merge is the maintainer's.\n```"
const QUIET = "```awaiting\nprs: [acme/app#391]\nstatus: watching\nfor: 180d\n```"
const WAKE = `✅ CI PASSED on ${PR} — 93 checks green, 31 skipped.\n\n${wakeDeliveryToken("wake-ci")}`
const GREEN: GithubWatchStatus = {
  checks: "passing", running: 0, passed: 93, failed: 0, skipped: 31, gated: 0, gating: [], failing: [],
  merge: "mergeable", state: "open", polledAt: at(0),
}

function world(backend: "claude" | "codex") {
  const slug = "t"
  const dir = mkdtempSync(join(tmpdir(), "frizz-handoff-rest-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession({
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: at(-60),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setBackend(slug, backend)
  if (backend === "claude") storage.setClaudeRuntime(slug, "broker")
  else storage.setCodexRuntime(slug, "app-server")
  storage.armPrWatch({ id: "prw_1", slug, owner: "acme", repo: "app", number: 391, createdAtMs: Date.parse(at(0)), expiresAtMs: Date.parse(at(0)) + 180 * 86_400_000 })
  storage.setSetting(GITHUB_STATUS_SETTING, { [PR]: GREEN })
  const s = newTailState(slug, `sid-${slug}`, "/dev/null")
  const tele = (): SessionTelemetry => ({
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], retiredShells: [], retiredSubAgents: [], pendingQuestion: false,
    lastActivityAt: s.lastActivityAt, lastAssistantAt: s.lastAssistantAt, lastAssistant: s.lastAssistant, lastAssistantLine: s.lastAssistantLine,
    lastUserAt: s.lastUserAt, restFromAt: s.restFromAt, handoffAt: s.handoffAt, lastUserText: s.lastUserText, lastFence: s.lastFence,
  } as SessionTelemetry)
  const tailer = {
    get: (x: string) => (x === slug ? tele() : undefined), foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  } as unknown as Tailer
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const board = createBoard(project, storage, new Bus(), tailer, "handoff-rest", { claudeBrokerDaemonAlive: () => true, now: () => Date.parse(at(30)) })
  // Each backend's own shape of "the worker said this and rested" and "a message landed".
  const fold = backend === "claude"
    ? (minute: number, text: string) => applyRecord(s, { type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } } as never)
    : (minute: number, text: string) => {
        applyEvent(s, { kind: "assistant-text", at: at(minute), text, final: true })
        applyEvent(s, { kind: "turn-end", at: at(minute), finalText: text })
      }
  // …and the rest instant the tailer stamps on the row as the turn ends, which a snooze is pinned to.
  const say = (minute: number, text: string) => { fold(minute, text); storage.setRestedAt(slug, at(minute)) }
  // The resting card's Snooze ("Until activity"): parks the CURRENT rest, as router snoozeAwaitingBackground does.
  const snooze = () => assert.ok(storage.setBgSnoozeRestedAtIfCurrent(slug, `sid-${slug}`, 0, storage.getSession(slug)!.rested_at))
  const user = backend === "claude"
    ? (minute: number, text: string) => applyRecord(s, { type: "user", timestamp: at(minute), message: { role: "user", content: text } } as never)
    : (minute: number, text: string) => {
        applyEvent(s, { kind: "user-message", at: at(minute), text, synthetic: false })
        applyEvent(s, { kind: "turn-start", at: at(minute) })
      }
  return {
    say, user, snooze,
    view: () => board.refresh().threads.find((x) => x.id === slug)!,
    close: () => { board.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

for (const backend of ["claude", "codex"] as const) {
  test(`${backend}: a no-news quiet park after a needs_input handoff keeps the thread in the queue`, () => {
    const w = world(backend)
    try {
      w.user(0, "own acme/app#391 and park it for my evaluation when it is ready")
      w.say(1, READY)
      assert.equal(w.view().needsYou, true, "the handoff queues")
      w.user(5, WAKE)
      w.say(6, QUIET)
      const v = w.view()
      assert.equal(v.needsYou, true, "the watcher's wake is not the human reaching the handoff")
      assert.equal(isSnoozed(v), false)
      assert.equal(v.heldHandoff, true, "the surfaces are told to keep the handoff's fence drawn")
    } finally { w.close() }
  })

  test(`${backend}: once the human has typed past the handoff, a quiet park snoozes as before`, () => {
    const w = world(backend)
    try {
      w.user(0, "own acme/app#391")
      w.say(1, READY)
      w.user(5, "keep watching it, I'll merge later")
      w.say(6, QUIET)
      const v = w.view()
      assert.equal(v.needsYou, false)
      assert.equal(v.waitStatus, "watching")
      assert.equal(v.heldHandoff, undefined)
    } finally { w.close() }
  })

  test(`${backend}: a quiet park with no handoff before it snoozes as before`, () => {
    const w = world(backend)
    try {
      w.user(0, "own acme/app#391")
      w.say(1, QUIET)
      w.user(5, WAKE)
      w.say(6, QUIET)
      assert.equal(w.view().needsYou, false)
      assert.equal(w.view().waitStatus, "watching")
    } finally { w.close() }
  })

  test(`${backend}: the human's snooze on the handoff reaches it, so the next quiet park snoozes as before`, () => {
    const w = world(backend)
    try {
      w.user(0, `own ${PR} and park it for my evaluation when it is ready`)
      w.say(1, READY)
      w.snooze()
      assert.equal(w.view().needsYou, false, "the snooze parks the handoff")
      // The snooze held for that one rest; the wake's quiet park is a new rest, which is the worker's to place.
      w.user(5, WAKE)
      w.say(6, QUIET)
      const v = w.view()
      assert.equal(v.needsYou, false, "a handoff the human snoozed is not put back by a no-news park")
      assert.equal(v.waitStatus, "watching")
    } finally { w.close() }
  })

  test(`${backend}: a snooze on a rest before the handoff does not reach it`, () => {
    const w = world(backend)
    try {
      w.user(0, `own ${PR}`)
      w.say(1, QUIET)
      w.snooze()
      w.user(3, WAKE)
      w.say(4, READY)
      assert.equal(w.view().needsYou, true, "the handoff queues")
      assert.equal(w.view().heldHandoff, undefined, "the handoff is the rest itself, drawn as the resting card")
      w.user(5, WAKE)
      w.say(6, QUIET)
      assert.equal(w.view().needsYou, true, "the older snooze was not an answer to this handoff")
      assert.equal(w.view().heldHandoff, true)
    } finally { w.close() }
  })
}
