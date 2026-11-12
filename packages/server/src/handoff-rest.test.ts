// A HANDOFF STAYS IN THE QUEUE UNTIL THE HUMAN REACHES IT (reported 2026-10-27, of a Snoozed thread whose
// PR was green and waiting on their merge: "it looks green to me"). The worker rested `status: needs_input`
// on its registered PR; the watcher then woke it for CI and an approval it had already read, and it re-parked
// `status: watching` with nothing to add. That quiet park took the thread out of the queue, so the handoff it
// replaced was never seen. The rule (board needsInputQueues): a quiet park cannot spend `steps:` or a question
// the human has not reached, by typing past it, snoozing it or settling a question. A plain `needs_input`
// report is the worker's to hand off again (2026-11-06), so a quiet park after one does leave the queue.
// Driven through the real fold (both backends' paths) and the real board.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boardQueuedThread, isSnoozed, wakeDeliveryToken, type GithubWatchStatus } from "@frizz/shared"
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
// The same handoff as the contract now has it written: the merge is the human's act, so it is a step.
const MERGE = "```awaiting\nprs: [acme/app#391]\nfor: 180d\ntitle: Ready, unmerged\nsteps:\n  - Merge [acme/app#391](https://github.com/acme/app/pull/391).\n---\nReady at 0251203e.\n```"
const WAKE = `✅ CI PASSED on ${PR} — 93 checks green, 31 skipped.\n\n${wakeDeliveryToken("wake-ci")}`
// Two steps, and the reply the to-do list's send composes for one of them ticked (web withStepsReport).
const TWO_STEPS = "```awaiting\nprs: [acme/app#391]\nfor: 180d\ntitle: Ready, unmerged\nsteps:\n  - Merge [acme/app#391](https://github.com/acme/app/pull/391).\n  - Delete the old branch.\n---\nReady at 0251203e.\n```"
const ONE_OF_TWO = "Done 1 of 2:\n- [x] Merge [acme/app#391](https://github.com/acme/app/pull/391).\n- [ ] Delete the old branch."
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
    lastUserAt: s.lastUserAt, restFromAt: s.restFromAt, handoffAt: s.handoffAt, stepsDoneAt: s.stepsDoneAt, lastUserText: s.lastUserText, lastFence: s.lastFence,
    humanSteps: s.humanSteps,
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
  // A registered question, asked and settled the way the board reads them: the row is all it consults.
  const ask = (id: string, minute: number) => {
    storage.askThreadQuestion({ id, slug, spec: JSON.stringify({ question: "Fix it in a follow-up?", kind: "question", options: [{ label: "Yes" }, { label: "No" }] }), askedAtMs: Date.parse(at(minute)), handle: id })
  }
  // Claude's record shapes for a fence written mid-turn: the text before a tool call, and the call's result.
  const midTurn = (minute: number, text: string) => applyRecord(s, { type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "tool_use" } } as never)
  const toolResult = (minute: number) => applyRecord(s, { type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } } as never)
  return {
    say, user, snooze, ask, midTurn, toolResult,
    pin: () => storage.setPinnedAt(slug, at(-1)),
    answer: (id: string, minute: number) => assert.ok(storage.answerThreadQuestion(id, JSON.stringify({ [id]: "Yes" }), Date.parse(at(minute)))),
    dismiss: (id: string, minute: number) => assert.ok(storage.dismissThreadQuestion(id, Date.parse(at(minute)))),
    withdraw: (id: string, minute: number) => assert.ok(storage.withdrawThreadQuestion(slug, id, Date.parse(at(minute)))),
    view: () => board.refresh().threads.find((x) => x.id === slug)!,
    close: () => { board.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

for (const backend of ["claude", "codex"] as const) {
  test(`${backend}: a no-news quiet park after a needs_input handoff keeps the thread in the queue`, () => {
    const w = world(backend)
    try {
      w.user(0, "own acme/app#391 and park it for my evaluation when it is ready")
      w.say(1, MERGE)
      assert.equal(w.view().needsYou, true, "the handoff queues")
      w.user(5, WAKE)
      w.say(6, QUIET)
      const v = w.view()
      assert.equal(v.needsYou, true, "the watcher's wake is not the human reaching the handoff")
      assert.equal(isSnoozed(v), false)
      assert.equal(v.heldHandoff, true, "the surfaces are told to keep the handoff's fence drawn")
    } finally { w.close() }
  })

  // A pinned thread drops a plain REPORT from the queue (shared boardQueuedThread), and the held steps
  // came out as one because the last fence is the quiet park. What the human must do still queues.
  test(`${backend}: on a pinned thread, the steps a quiet park could not take back still queue`, () => {
    const w = world(backend)
    try {
      w.pin()
      w.user(0, "own acme/app#391 and park it for my evaluation when it is ready")
      w.say(1, MERGE)
      w.user(5, WAKE)
      w.say(6, QUIET)
      const v = w.view()
      assert.equal(v.heldHandoff, true)
      assert.equal(v.plainReport, undefined, "steps owed are not a report the human only had to read")
      assert.equal(boardQueuedThread(v), true)
    } finally { w.close() }
  })

  test(`${backend}: a quiet park after a plain needs_input report leaves the queue, since the worker's newest answer decides`, () => {
    const w = world(backend)
    try {
      w.user(0, `own ${PR} and tell me where it stands`)
      w.say(1, READY)
      assert.equal(w.view().needsYou, true, "the report queues at its own rest")
      w.user(5, WAKE)
      w.say(6, QUIET)
      const v = w.view()
      assert.equal(v.needsYou, false, "a report holds nothing once the worker says it is only watching")
      assert.equal(v.waitStatus, "watching")
      assert.equal(v.heldHandoff, undefined)
    } finally { w.close() }
  })

  test(`${backend}: steps written after a report still hold, and a report after steps does not release them`, () => {
    const w = world(backend)
    try {
      w.user(0, `own ${PR}`)
      w.say(1, MERGE)
      w.user(2, WAKE)
      w.say(3, READY)
      w.user(5, WAKE)
      w.say(6, QUIET)
      assert.equal(w.view().needsYou, true, "the merge step is still the human's")
      assert.equal(w.view().heldHandoff, true)
    } finally { w.close() }
  })

  test(`${backend}: once the human has typed past the handoff, a quiet park snoozes as before`, () => {
    const w = world(backend)
    try {
      w.user(0, "own acme/app#391")
      w.say(1, MERGE)
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
      w.say(1, MERGE)
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
      w.say(4, MERGE)
      assert.equal(w.view().needsYou, true, "the handoff queues")
      assert.equal(w.view().heldHandoff, undefined, "the handoff is the rest itself, drawn as the resting card")
      w.user(5, WAKE)
      w.say(6, QUIET)
      assert.equal(w.view().needsYou, true, "the older snooze was not an answer to this handoff")
      assert.equal(w.view().heldHandoff, true)
    } finally { w.close() }
  })

  // ANSWERING A QUESTION REACHES THE HANDOFF (reported 2026-11-06, of a thread back in the queue on a card
  // with nothing to do: "there's nothing actionable for me"). The human typed, the worker handed off
  // `status: needs_input` with a question, the human answered it, and the worker set off on the answer. An
  // answer is not typing (shared isHumanTypedMessage), so every quiet park of that new work queued again.
  test(`${backend}: answering a question reaches the handoff that asked it, so the next quiet park snoozes as before`, () => {
    const w = world(backend)
    try {
      w.user(0, `what is going on with ${PR}?`)
      w.say(1, MERGE)
      w.ask("qst_followup", 1)
      assert.equal(w.view().needsYou, true, "the handoff and its question queue")
      w.answer("qst_followup", 5)
      w.user(5, `Answers to earlier questions:\n1. Fix it in a follow-up? → Yes\n\n${wakeDeliveryToken("wake-answer")}`)
      w.say(6, QUIET)
      const v = w.view()
      assert.equal(v.needsYou, false, "the worker is on the answer, and nothing here is the human's")
      assert.equal(v.waitStatus, "watching")
      assert.equal(v.heldHandoff, undefined)
    } finally { w.close() }
  })

  test(`${backend}: dismissing a question reaches the handoff too`, () => {
    const w = world(backend)
    try {
      w.user(0, `own ${PR}`)
      w.say(1, MERGE)
      w.ask("qst_followup", 1)
      w.dismiss("qst_followup", 5)
      w.user(5, WAKE)
      w.say(6, QUIET)
      assert.equal(w.view().needsYou, false)
      assert.equal(w.view().heldHandoff, undefined)
    } finally { w.close() }
  })

  test(`${backend}: an answer given before the handoff does not reach it`, () => {
    const w = world(backend)
    try {
      w.user(0, `own ${PR}`)
      w.say(1, QUIET)
      w.ask("qst_earlier", 1)
      w.answer("qst_earlier", 2)
      w.user(2, `Answers to earlier questions:\n1. Fix it in a follow-up? → Yes\n\n${wakeDeliveryToken("wake-answer")}`)
      w.say(3, MERGE)
      w.user(5, WAKE)
      w.say(6, QUIET)
      assert.equal(w.view().needsYou, true, "the handoff came after the answer, so nothing has reached it")
      assert.equal(w.view().heldHandoff, true)
    } finally { w.close() }
  })

  test(`${backend}: a question the worker withdrew does not reach the handoff`, () => {
    const w = world(backend)
    try {
      w.user(0, `own ${PR}`)
      w.say(1, MERGE)
      w.ask("qst_followup", 1)
      w.withdraw("qst_followup", 5)
      w.user(5, WAKE)
      w.say(6, QUIET)
      assert.equal(w.view().needsYou, true, "a withdrawal is the worker's own act, and the human has done nothing")
      assert.equal(w.view().heldHandoff, true)
    } finally { w.close() }
  })

  test(`${backend}: answering one of two questions leaves the thread queued on the other`, () => {
    const w = world(backend)
    try {
      w.user(0, `own ${PR}`)
      w.say(1, MERGE)
      w.ask("qst_first", 1)
      w.ask("qst_second", 1)
      w.answer("qst_first", 5)
      w.user(5, `Answers to earlier questions:\n1. Fix it in a follow-up? → Yes\n\n${wakeDeliveryToken("wake-answer")}`)
      w.say(6, QUIET)
      assert.equal(w.view().needsYou, true, "the other question still stands")
    } finally { w.close() }
  })

  // A STEPS REPORT IS AN ANSWER, NOT TYPING (shared isHumanTypedMessage). Ticking boxes and pressing Send
  // is to the to-do card what picking an option is to a question card.
  test(`${backend}: a partial steps report leaves the step it calls not done holding the next quiet park`, () => {
    const w = world(backend)
    try {
      w.user(0, `own ${PR}`)
      w.say(1, TWO_STEPS)
      w.user(5, ONE_OF_TWO)
      w.user(6, WAKE)
      w.say(7, QUIET)
      const v = w.view()
      assert.equal(v.needsYou, true, "the report said the second step is not done")
      assert.equal(v.heldHandoff, true)
      assert.equal(isSnoozed(v), false)
    } finally { w.close() }
  })

  test(`${backend}: a report of every step done reaches the handoff, so the next quiet park snoozes`, () => {
    const w = world(backend)
    try {
      w.user(0, `own ${PR}`)
      w.say(1, TWO_STEPS)
      w.user(5, "Done")
      w.user(6, WAKE)
      w.say(7, QUIET)
      const v = w.view()
      assert.equal(v.needsYou, false)
      assert.equal(isSnoozed(v), true)
    } finally { w.close() }
  })

  test(`${backend}: a steps report sent with nothing typed leaves a question asked beside the steps standing`, () => {
    const w = world(backend)
    try {
      w.user(0, `own ${PR}`)
      w.say(1, TWO_STEPS)
      w.ask("qst_beside", 1)
      w.user(5, "Done")
      w.say(7, QUIET)
      const v = w.view()
      assert.equal(v.needsYou, true, "the human answered the to-do card, not the question")
      assert.deepEqual((v.questions ?? []).map((q) => [q.id, q.standing]), [["qst_beside", true]])
    } finally { w.close() }
  })

  test(`${backend}: words typed under a report are typing, and reach the handoff as typing does`, () => {
    const w = world(backend)
    try {
      w.user(0, `own ${PR}`)
      w.say(1, TWO_STEPS)
      w.user(5, `${ONE_OF_TWO}\n\nSkip the second one, the branch is protected.`)
      w.say(7, QUIET)
      assert.equal(w.view().needsYou, false)
    } finally { w.close() }
  })
}

// A Claude turn reads a fence off every text block, so a steps fence can be written and then followed by a
// tool call or more text. It was never a rest, and must not hold the next quiet park over steps that never
// reached the list. (A normalized backend fences only on its final message.)
test("claude: a steps fence the worker went on past in the same turn holds nothing", () => {
  for (const goOn of ["tool result", "more text"] as const) {
    const w = world("claude")
    try {
      w.user(0, `own ${PR}`)
      w.midTurn(1, TWO_STEPS)
      if (goOn === "tool result") w.toolResult(2)
      else w.midTurn(2, "Checking one more thing first.")
      w.say(3, QUIET)
      const v = w.view()
      assert.equal(v.needsYou, false, goOn)
      assert.equal(isSnoozed(v), true, goOn)
    } finally { w.close() }
  }
})

test("claude: an earlier handoff a mid-turn fence stamped over still holds, once the worker goes on past it", () => {
  const w = world("claude")
  try {
    w.user(0, `own ${PR}`)
    w.say(1, MERGE)
    w.user(5, WAKE)
    w.midTurn(6, TWO_STEPS)
    w.toolResult(7)
    w.say(8, QUIET)
    assert.equal(w.view().needsYou, true, "the merge handed over at minute 1 is still unreached")
  } finally { w.close() }
})
