import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, appendFileSync, utimesSync, readFileSync, rmSync, openSync, closeSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createStorage, type Storage, type SessionRow } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { ServerEvent } from "@frizz/shared"
import { AwaitingHint } from "@frizz/shared"
import { permMarkerPath, type Project } from "./project.ts"
import { parseLine, applyRecord, applyEvent, computeTurn, newTailState, createTailer, defaultBrokerDaemonAlive, hasQuestionBlock, isClaudeAuthErrorText, isRealUserMessage, parseSignalFence, markerDecision, unwrapShellCommand, FOREIGN_FRESH_MS } from "./tailer.ts"
import { claudeBrokerRecordPath } from "./backend/claude-broker-host.ts"
import type { AgentBackend, NormalizedEvent } from "./backend/types.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { createCodexBackend } from "./backend/codex.ts"
import { mkdirSync } from "node:fs"
import { frizzTempDir } from "./frizz-paths.ts"

function tmp(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ---- pure parsing / derivation ----

test("parseLine: object → record; blank/garbage/non-object → null", () => {
  assert.deepEqual(parseLine('{"type":"assistant"}'), { type: "assistant" })
  assert.equal(parseLine(""), null)
  assert.equal(parseLine("   "), null)
  assert.equal(parseLine("{not json"), null)
  assert.equal(parseLine("5"), null) // valid JSON, not an object
  assert.equal(parseLine('"a string"'), null)
})

// A record's assistant text (last text block) becomes the preview; thinking/tool_use ignored.
test("applyRecord: extracts trimmed assistant preview + advances activity", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, {
    type: "assistant",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { stop_reason: "end_turn", content: [{ type: "text", text: "  hello   world \n" }] },
  })
  assert.equal(s.lastAssistant, "hello world")
  assert.equal(s.lastActivityAt, "2026-07-01T00:00:01.000Z")
  assert.equal(s.lastKind, "assistant")
  assert.equal(s.lastStopReason, "end_turn")
})

test("applyRecord: a system-origin user record (peer / task-notification) RE-INVOKES (in-flight) but never reorders the row", () => {
  const s = newTailState("t", "sid", "/x")
  // Agent comes to rest with an unanswered ```question.
  applyRecord(s, {
    type: "assistant",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { stop_reason: "end_turn", content: [{ type: "text", text: "```question\nA or B?\n```" }] },
  })
  assert.equal(s.lastAssistantHasQuestion, true)
  const restedUserAt = s.lastUserAt
  // A sub-agent <task-notification> lands as a user record with promptSource:"system". It RE-INVOKES
  // the agent, so the turn flips to in-flight (the agent is resuming → shimmer, not idle) — but it must
  // NOT bump lastUserAt (that would reorder the row from motion the human didn't cause), and it must not
  // touch the QUESTION either. This assertion used to read `lastAssistantHasQuestion === false`,
  // "superseded" — and that was the bug: nobody answered anything. The chat kept drawing the answerable
  // card off the transcript while the board, having thrown the flag away, banded the row as ACTIVE and
  // shimmered at it (maintainer 2026-08-24). Superseding is the HUMAN's to do.
  applyRecord(s, {
    type: "user",
    timestamp: "2026-07-01T00:00:05.000Z",
    promptSource: "system",
    message: { content: "<task-notification>…done</task-notification>" },
  })
  assert.equal(s.lastKind, "user") // in-flight: the agent is resuming
  assert.equal(s.lastAssistantHasQuestion, true, "the machinery cannot answer a question on the human's behalf")
  assert.equal(s.lastActivityAt, "2026-07-01T00:00:05.000Z") // transcript grew
  assert.equal(s.lastUserAt, restedUserAt) // ROW ORDER unchanged — a notification never jumps the row
  // …and the HUMAN speaking does discharge it, which is what dequeues the row.
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:09.000Z", message: { content: "B" } })
  assert.equal(s.lastAssistantHasQuestion, false)
  assert.equal(s.lastUserAt, "2026-07-01T00:00:09.000Z")
})

test("applyRecord: claude's post-compaction carry-over summary re-invokes but never reorders the row", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: [{ type: "text", text: "keep going" }] } })
  assert.equal(s.lastUserAt, "2026-07-01T00:00:00.000Z")
  applyRecord(s, { type: "system", timestamp: "2026-07-01T00:05:00.000Z" })
  // The recap claude writes to ITSELF after compacting: an ordinary-looking user record (no isMeta, no
  // promptSource) carrying ~20 000 characters. Read as a human turn it jumps the thread to the top of
  // the board on motion the human never caused.
  applyRecord(s, {
    type: "user",
    timestamp: "2026-07-01T00:05:01.000Z",
    isCompactSummary: true,
    message: { content: [{ type: "text", text: "This session is being continued from a previous conversation…" }] },
  })
  assert.equal(s.lastKind, "user") // still re-invoking: the model resumes from the summary → shimmer
  assert.equal(s.lastActivityAt, "2026-07-01T00:05:01.000Z") // the transcript did grow
  assert.equal(s.lastUserAt, "2026-07-01T00:00:00.000Z") // ROW ORDER unchanged
  // …and it is ALSO the only place a Claude transcript says a compaction just happened, which makes it
  // the post-compaction trigger's clock (scheduler SOURCE 7). Without this the trigger never fires on
  // Claude at all — it would arm cleanly, report armed in the footer, and silently do nothing.
  assert.equal(s.lastCompactionAt, "2026-07-01T00:05:01.000Z")
})

// The CONTROL for the line above. If an ordinary user record set the clock, every human steer would
// re-fire the post-compaction prompt — which is worse than the trigger not working, because it looks
// like it does.
test("applyRecord: an ordinary user record does NOT set the post-compaction clock", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: [{ type: "text", text: "a normal steer" }] } })
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:05.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } })
  assert.equal(s.lastCompactionAt, undefined)
})

test("applyRecord: caps preview at 200 chars with an ellipsis", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "x".repeat(500) }] } })
  assert.equal(s.lastAssistant?.length, 201) // 200 + ellipsis
  assert.ok(s.lastAssistant?.endsWith("…"))
})

test("computeTurn: end_turn=idle, tool_use=in-flight, user=in-flight", () => {
  const now = Date.parse("2026-07-01T00:00:10.000Z")

  const endTurn = newTailState("t", "s", "/x")
  applyRecord(endTurn, { type: "assistant", timestamp: "2026-07-01T00:00:09.000Z", message: { stop_reason: "end_turn", content: [] } })
  assert.equal(computeTurn(endTurn, now), "idle")

  const toolUse = newTailState("t", "s", "/x")
  applyRecord(toolUse, { type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { stop_reason: "tool_use", content: [] } })
  // even though >5s stale, a clear tool_use is NEVER timed out to idle
  assert.equal(computeTurn(toolUse, now), "in-flight")

  const user = newTailState("t", "s", "/x")
  applyRecord(user, { type: "user", timestamp: "2026-07-01T00:00:09.500Z", message: { content: [] } })
  assert.equal(computeTurn(user, now), "in-flight")

  const empty = newTailState("t", "s", "/x")
  assert.equal(computeTurn(empty, now), "in-flight") // nothing substantive yet
})

test("computeTurn: unknown stop_reason uses the 5s silence backstop", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { content: [] } })
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:00:03.000Z")), "in-flight") // 3s: still in flight
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:00:06.000Z")), "idle") // 6s: backstop fires
})

// THE INTERRUPT RECEIPT IS THE ONE `user` RECORD THAT ENDS A TURN. Claude narrates its own abort as a
// bare `[Request interrupted by user]` user record, and "user record → the model is about to respond"
// read that as a prompt: a thread stopped mid-tool and never resumed sat in the Active band spinning
// for 23 hours behind an idle worker (maintainer 2026-08-23, on a nub thread: "looks frozen"). Nothing
// timed it out either — the 5s backstop above only guards the ASSISTANT branch.
test("computeTurn: an interrupt receipt with nothing after it settles the turn", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { stop_reason: "tool_use", content: [] } })
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:01.000Z", message: { content: [{ type: "tool_result" }] } })
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:02.000Z", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } })
  assert.equal(s.lastKind, "user", "still a substantive record — it moves the clock and the row like any other")
  assert.equal(s.interrupted, true)
  // SEND NOW is the common case and it must not flash a rest: frizz interrupts the running turn so the
  // worker reads the queue at once, and the real prompt lands milliseconds later.
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:00:04.000Z")), "in-flight", "2s on: the pushed-through prompt is still arriving")
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:00:08.000Z")), "idle", "6s of silence after an abort is a stopped thread, not a spinner")
})

test("computeTurn: the very next record after an interrupt re-opens the turn", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } })
  assert.equal(s.interrupted, true, "both markers count")
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:01.000Z", message: { content: [{ type: "text", text: "actually, do this instead" }] } })
  assert.equal(s.interrupted, undefined, "a real prompt clears it — the flag only ever describes the LAST record")
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:01:00.000Z")), "in-flight")
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:01:01.000Z", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } })
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:01:02.000Z", message: { stop_reason: "tool_use", content: [] } })
  assert.equal(s.interrupted, undefined, "…and so does the model speaking again")
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:02:00.000Z")), "in-flight", "a live tool_use is never timed out")
})

// A human message that QUOTES the marker is a human message. Exact match on the trimmed text is what
// keeps that true — the same rule that keeps its bubble in the chat (transcript.ts).
test("computeTurn: a message that merely quotes the marker is an ordinary prompt", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: [{ type: "text", text: "[Request interrupted by user] — why does this keep showing up?" }] } })
  assert.equal(s.interrupted, undefined)
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:01:00.000Z")), "in-flight")
})

// ---- applyEvent: the backend-NEUTRAL fold over NormalizedEvents (the codex-facing seam) ----
// applyEvent is what a codex backend drives its foldLine off (`for (ev of parseLine(line)) applyEvent`),
// so these tests pin the same FoldState fields the tailer/board consume — with turn driven by explicit
// turn-start/turn-end brackets, NOT Claude's stop_reason vocab. `pendingQuestion` is derived exactly as
// get() derives it: an idle turn whose final message still carries an unanswered ```question fence.
const pendingQuestion = (s: { turn: string; lastAssistantHasQuestion: boolean }) => s.turn === "idle" && s.lastAssistantHasQuestion

test("applyEvent: a full codex-style turn folds to idle with the final preview + parsed done fence", () => {
  const s = newTailState("t", "s", "/x")
  const seq: NormalizedEvent[] = [
    { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" },
    { kind: "assistant-text", at: "2026-07-01T00:00:01.000Z", text: "I'll read hello.txt to check.", final: false }, // commentary
    { kind: "tool-call", at: "2026-07-01T00:00:02.000Z", id: "call_1", name: "exec_command", input: { cmd: "cat hello.txt" } },
    { kind: "tool-result", at: "2026-07-01T00:00:03.000Z", id: "call_1", text: "hello world" },
    { kind: "assistant-text", at: "2026-07-01T00:00:04.000Z", text: "All set — shipped it.\n\n```done\nread the file\n```", final: true },
    { kind: "turn-end", at: "2026-07-01T00:00:05.000Z" },
  ]
  for (const ev of seq) applyEvent(s, ev)
  assert.equal(s.turn, "idle") // bracketed closed by turn-end, no stop_reason heuristic
  assert.equal(s.lastActivityAt, "2026-07-01T00:00:05.000Z") // latest event's timestamp
  assert.equal(s.lastAssistant, "All set — shipped it. ```done read the file ```") // final preview (whitespace-collapsed)
  assert.deepEqual(s.lastFence, { kind: "done", body: "read the file", hints: [] }) // parsed off the FINAL message
  assert.equal(s.lastAssistantHasQuestion, false)
  assert.equal(pendingQuestion(s), false)
  assert.equal(s.lastUserAt, undefined) // no human turn in this sequence
})

test("applyEvent: commentary refreshes the preview but NEVER carries a fence; only the final answer does", () => {
  const s = newTailState("t", "s", "/x")
  // A commentary block that literally contains a done-shaped fence must NOT excuse the thread.
  applyEvent(s, { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" })
  applyEvent(s, { kind: "assistant-text", at: "2026-07-01T00:00:01.000Z", text: "working on it\n\n```done\nnot really\n```", final: false })
  assert.equal(s.lastAssistant, "working on it ```done not really ```") // preview updated
  assert.equal(s.lastFence, undefined) // commentary carries NO fence
  assert.equal(s.lastAssistantHasQuestion, false)
})

test("applyEvent: turn-end.finalText derives the fence when the backend brackets the final message on task_complete", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" })
  // No assistant-text{final} — the final message rides task_complete.last_agent_message instead.
  applyEvent(s, { kind: "turn-end", at: "2026-07-01T00:00:02.000Z", finalText: "Need your call.\n\n```awaiting\nprs: [owner/repo#7]\nshould I merge?\n```" })
  assert.equal(s.turn, "idle")
  assert.deepEqual(s.lastFence, { kind: "awaiting", body: "should I merge?", hints: [{ kind: "pr", value: "owner/repo#7" }] })
  assert.equal(s.lastAssistant, "Need your call. ```awaiting prs: [owner/repo#7] should I merge? ```")
})

test("applyEvent: an idle turn ending on a ```question fence surfaces pendingQuestion", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" })
  applyEvent(s, { kind: "assistant-text", at: "2026-07-01T00:00:01.000Z", text: "```question\nWhich option do you want?\n```", final: true })
  assert.equal(pendingQuestion(s), false) // still in-flight — not yet at rest
  applyEvent(s, { kind: "turn-end", at: "2026-07-01T00:00:02.000Z" })
  assert.equal(s.turn, "idle")
  assert.equal(s.lastAssistantHasQuestion, true)
  assert.equal(pendingQuestion(s), true) // idle + unanswered question → pending
})

test("applyEvent: only a GENUINE user-message bumps lastUserAt; a synthetic one never does", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "user-message", at: "2026-07-01T00:00:00.000Z", text: "go do the thing", synthetic: false })
  assert.equal(s.turn, "in-flight") // a user turn re-opens → the model is about to respond
  assert.equal(s.lastUserAt, "2026-07-01T00:00:00.000Z")
  // A synthetic user-message (peer msg / notification) re-invokes the model (in-flight) but is machine
  // motion the human didn't cause — it must NOT jump the row, so lastUserAt is left untouched.
  applyEvent(s, { kind: "user-message", at: "2026-07-01T00:00:05.000Z", synthetic: true })
  assert.equal(s.turn, "in-flight")
  assert.equal(s.lastUserAt, "2026-07-01T00:00:00.000Z") // NOT bumped to 00:05
  assert.equal(s.lastActivityAt, "2026-07-01T00:00:05.000Z") // but activity clock did advance
})

// The codex twin of the claude defect: `synthetic` already knew the difference, and only the row-order
// key was reading it. An open ```question is a claim on the HUMAN, so machine motion cannot discharge it
// — otherwise the row leaves the queue and returns to the Active rail with its ask still on screen.
test("applyEvent: a synthetic turn cannot answer the agent's question; a genuine one does", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "assistant-text", at: "2026-07-01T00:00:01.000Z", text: "```question\nA or B?\n```", final: true })
  assert.equal(s.lastAssistantHasQuestion, true)
  applyEvent(s, { kind: "user-message", at: "2026-07-01T00:00:05.000Z", synthetic: true })
  assert.equal(s.lastAssistantHasQuestion, true, "a peer message / notification answers nothing")
  applyEvent(s, { kind: "user-message", at: "2026-07-01T00:00:09.000Z", text: "B", synthetic: false })
  assert.equal(s.lastAssistantHasQuestion, false, "the human answered — the row leaves the queue")
})

test("applyEvent: a compaction is harness motion — it advances the clock but moves no turn, preview or fence", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" })
  applyEvent(s, { kind: "assistant-text", at: "2026-07-01T00:00:01.000Z", text: "still working", final: false })
  // Codex spends ~100s inside a compaction writing no other record — the exact silence a stall read
  // would misjudge — so the event has to advance the activity clock without ending the turn.
  applyEvent(s, { kind: "compaction", at: "2026-07-01T00:01:41.000Z" })
  assert.equal(s.turn, "in-flight")
  assert.equal(s.lastActivityAt, "2026-07-01T00:01:41.000Z")
  assert.equal(s.lastAssistant, "still working") // the preview is untouched by harness work
  assert.equal(s.lastUserAt, undefined)
  // Usage telemetry rides real events that move the clock themselves, so it never moves it alone.
  applyEvent(s, { kind: "context-usage", at: "2026-07-01T00:02:00.000Z", tokens: 37045 })
  assert.equal(s.lastActivityAt, "2026-07-01T00:01:41.000Z")
  assert.equal(s.turn, "in-flight")
})

// ---- context fullness: both halves are READINGS, and an absent one must render nothing ----

test("applyEvent: context-usage carries the reading AND latches the provider's window", () => {
  const s = newTailState("t", "s", "/x")
  assert.equal(s.contextTokens, undefined, "no reading before any telemetry — the footer renders nothing")
  assert.equal(s.contextWindow, undefined)
  applyEvent(s, { kind: "context-usage", at: "2026-07-01T00:00:00.000Z", tokens: 25026, window: 258400 })
  assert.equal(s.contextTokens, 25026)
  assert.equal(s.contextWindow, 258400)
  // A compaction genuinely SHRINKS the context, so the reading must be allowed to fall.
  applyEvent(s, { kind: "context-usage", at: "2026-07-01T00:01:00.000Z", tokens: 9000, window: 258400 })
  assert.equal(s.contextTokens, 9000)
  // A later event that omits the window must not erase a real one — losing the denominator would blank
  // a readout the operator is already reading, and the window of a running session does not change.
  applyEvent(s, { kind: "context-usage", at: "2026-07-01T00:02:00.000Z", tokens: 9500 })
  assert.equal(s.contextTokens, 9500)
  assert.equal(s.contextWindow, 258400)
})

test("applyRecord: Claude's context reading is the request's own input accounting, and only the main thread's", () => {
  const s = newTailState("t", "s", "/x")
  const assistant = (usage: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
    type: "assistant", timestamp: "2026-07-01T00:00:00.000Z",
    message: { stop_reason: "end_turn", model: "claude-opus-5", content: [{ type: "text", text: "hi" }], usage },
    ...extra,
  })
  const fold = (line: string) => { const r = parseLine(line); assert.ok(r); applyRecord(s, r) }
  // input + cache-creation + cache-read is exactly what the request carried. output_tokens is NOT in
  // the context yet — it arrives inside those three on the next request.
  fold(assistant({ input_tokens: 2, cache_creation_input_tokens: 2858, cache_read_input_tokens: 16344, output_tokens: 123 }))
  assert.equal(s.contextTokens, 2 + 2858 + 16344)
  // Claude names no window on disk, so the numerator alone must never imply a fraction.
  assert.equal(s.contextWindow, undefined, "the disk fold cannot invent a denominator")
  // A SIDECHAIN record is a child's context, not this thread's.
  fold(assistant({ input_tokens: 1, cache_read_input_tokens: 999 }, { isSidechain: true }))
  assert.equal(s.contextTokens, 19204, "a sub-agent's reading may not overwrite the parent's")
  // A synthetic API-error record carries no real usage.
  fold(assistant({ input_tokens: 0, cache_read_input_tokens: 0 }, { isApiErrorMessage: true }))
  assert.equal(s.contextTokens, 19204, "an error record must not zero a real reading")
  // A record with no usage at all leaves the previous reading alone rather than asserting zero.
  fold(assistant(undefined))
  assert.equal(s.contextTokens, 19204)
})

test("applyEvent: lastUserText and lastUserAt stay paired when a genuine user event has no text", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "user-message", at: "2026-07-01T00:00:00.000Z", text: "older exact text", synthetic: false })
  applyEvent(s, { kind: "user-message", at: "2026-07-01T00:00:05.000Z", synthetic: false })
  assert.equal(s.lastUserAt, "2026-07-01T00:00:05.000Z")
  assert.equal(s.lastUserText, undefined, "a newer non-text event cannot lend its timestamp to stale matching text")
})

test("applyEvent: a later user-message clears a prior excusal fence + pending question", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" })
  applyEvent(s, { kind: "assistant-text", at: "2026-07-01T00:00:01.000Z", text: "Done.\n\n```done\nshipped\n```", final: true })
  applyEvent(s, { kind: "turn-end", at: "2026-07-01T00:00:02.000Z" })
  assert.deepEqual(s.lastFence, { kind: "done", body: "shipped", hints: [] })
  // A fresh human turn supersedes the fence (it only signals while it is the final message).
  applyEvent(s, { kind: "user-message", at: "2026-07-01T00:00:03.000Z", text: "one more thing", synthetic: false })
  assert.equal(s.lastFence, undefined)
  assert.equal(s.lastAssistantHasQuestion, false)
  assert.equal(s.turn, "in-flight")
  assert.equal(s.lastUserAt, "2026-07-01T00:00:03.000Z")
})

test("applyEvent: a title event sets aiTitle and never disturbs turn state", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" })
  applyEvent(s, { kind: "title", title: "Codex thread title" })
  assert.equal(s.aiTitle, "Codex thread title")
  assert.equal(s.turn, "in-flight") // title is a sidecar — turn untouched
  assert.equal(s.lastActivityAt, "2026-07-01T00:00:00.000Z") // a title has no `at`, so the clock is unmoved
})

// ai-title is a sidecar record carrying Claude's own session name; the LATEST non-empty wins and it
// never disturbs turn state.
test("applyRecord: ai-title captures latest non-empty title without moving turn state", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } })
  applyRecord(s, { type: "ai-title", aiTitle: "First guess at a name" })
  applyRecord(s, { type: "ai-title", aiTitle: "Refined session title" }) // latest wins
  applyRecord(s, { type: "ai-title", aiTitle: "  " }) // blank ignored — keeps the last good one
  applyRecord(s, { type: "ai-title" }) // missing field ignored
  assert.equal(s.aiTitle, "Refined session title")
  assert.equal(s.lastKind, "assistant") // turn state untouched
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:00:01.000Z")), "idle")
})

test("applyRecord: custom-title carries a monotonic native /rename revision separate from ai-title churn", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "ai-title", aiTitle: "Automatic title" })
  assert.equal(s.customTitleRevision, 0)
  assert.equal(s.customTitle, undefined)
  applyRecord(s, { type: "custom-title", customTitle: "First native rename" })
  applyRecord(s, { type: "custom-title", customTitle: "Second native rename" })
  applyRecord(s, { type: "custom-title", customTitle: "   " })
  assert.equal(s.customTitleRevision, 2)
  assert.equal(s.customTitle, "Second native rename")
  assert.equal(s.aiTitle, "Automatic title", "unconfirmed native rename records never reach board/file title surfaces")
})

test("applyRecord: /rename's isMeta user reminder does not wake an idle model turn", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } })
  const activity = s.lastActivityAt
  applyRecord(s, { type: "user", isMeta: true, timestamp: "2026-07-01T00:00:01.000Z", message: { content: "Session title is now Readable" } })
  assert.equal(s.lastKind, "assistant")
  assert.equal(s.lastActivityAt, activity)
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:00:02.000Z")), "idle")
})

test("applyRecord: sidecar metadata records never move turn state", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } })
  applyRecord(s, { type: "ai-title" })
  applyRecord(s, { type: "last-prompt" })
  applyRecord(s, { type: "attachment", timestamp: "2026-07-01T00:00:05.000Z" })
  assert.equal(s.lastKind, "assistant")
  assert.equal(s.lastStopReason, "end_turn")
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:00:01.000Z")), "idle")
})

test("applyRecord: Claude permission-mode sidecars update the observed mode without moving turn state", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { stop_reason: "end_turn", content: [] } })
  applyRecord(s, { type: "permission-mode", permissionMode: "auto" })
  assert.equal(s.permissionMode, "auto")
  applyRecord(s, { type: "permission-mode", permissionMode: "bypassPermissions" })
  assert.equal(s.permissionMode, "bypassPermissions")
  applyRecord(s, { type: "permission-mode", permissionMode: "not-a-real-mode" })
  assert.equal(s.permissionMode, "bypassPermissions", "malformed sidecars never erase the last authoritative value")
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:00:01.000Z")), "idle")
})

// ---- live background sub-agent tracking (Agent dispatches + task-notifications) ----

// A background Agent dispatch (verified shape: tool_use name:"Agent", input.description +
// run_in_background). Registers a live sub-agent keyed by the tool_use id. (Return type left to
// inference so it stays structurally compatible with applyRecord's internal Record interface.)
// `subagentType: null` omits the field entirely (undefined would trip the default-param rule).
function dispatch(id: string, description: string, background = true, subagentType: string | null = "frizz:frizz-opus-high") {
  return {
    type: "assistant",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Agent", id, input: { description, run_in_background: background, ...(subagentType != null ? { subagent_type: subagentType } : {}) } }] },
  }
}
// The launch tool_result (a user record) carries the child's output_file path.
function launch(id: string, outputFile: string) {
  return {
    type: "user",
    timestamp: "2026-07-01T00:00:01.500Z",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: `Async agent launched successfully.\nagentId: abc123\noutput_file: ${outputFile}\nDo not read this file.` }] }] },
  }
}
// A completion <task-notification> rides a queue-operation record's top-level `content` string.
function taskNotification(id: string, status: string) {
  return {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-07-01T00:00:09.000Z",
    content: `<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`,
  }
}
// A BACKGROUND Bash launch (run_in_background:true) — a persist-across-rest shell.
function bashBg(id: string, description: string | null, command: string) {
  return {
    type: "assistant",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", id, input: { command, run_in_background: true, ...(description != null ? { description } : {}) } }] },
  }
}
// A FOREGROUND Bash launch (no run_in_background) — the shape the harness may auto-background later.
function bashFg(id: string, description: string | null, command: string) {
  return {
    type: "assistant",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", id, input: { command, ...(description != null ? { description } : {}) } }] },
  }
}
// The harness's auto-background handoff, verbatim (reproduced live 2026-07-30 with timeout: 5000).
function autoBackgroundAck(taskId: string, seconds = 590) {
  return `Command did not complete within its ${seconds}s timeout and was moved to the background (ID: ${taskId}). Output is being written to: /tmp/tasks/${taskId}.output. You will be notified when it completes. To check interim output, use Read on that file path.`
}
// A Claude Code Monitor is inherently a background watcher; persistent=true removes its timeout.
function monitorUse(id: string, description: string, command: string, persistent = true) {
  return {
    type: "assistant",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Monitor", id, input: { command, description, persistent } }] },
  }
}
// A native AskUserQuestion tool_use (the safety-net trigger).
function askUse(id: string, questions: unknown) {
  return {
    type: "assistant",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "AskUserQuestion", id, input: { questions } }] },
  }
}
// A bare tool_result user record (answers/clears a pending ask).
function toolResult(id: string) {
  return { type: "user", timestamp: "2026-07-01T00:00:05.000Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "answered" }] }] } }
}

// ---- a re-steered child (SendMessage restart) ----
// Shapes copied from the real corpus (705 transcripts under ~/.claude/projects, 2026-07-28). The
// launch ack states `agentId:` and `output_file:`; the restart ack is a JSON tool_result whose
// `resumedAgentId` is that SAME agent id, and whose `message` restates the output path.
function agentDispatch(id: string, description: string, at: string, subagentType = "frizz:opus-high") {
  return {
    type: "assistant",
    timestamp: at,
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Agent", id, input: { description, run_in_background: true, subagent_type: subagentType } }] },
  }
}
function agentLaunch(id: string, agentId: string, outputFile: string, at: string) {
  return {
    type: "user",
    timestamp: at,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.)\noutput_file: ${outputFile}\nDo NOT Read or tail this file.` }] }] },
  }
}
function notify(toolUseId: string, agentId: string, status: string, at: string) {
  return {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: at,
    content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`,
  }
}
function sendMessage(id: string, to: string, summary: string, at: string) {
  return {
    type: "assistant",
    timestamp: at,
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "SendMessage", id, input: { to, summary, message: "Resume. You were terminated by an API error." } }] },
  }
}
// The two result shapes that matter, verbatim from the corpus: a RESTART carries `resumedAgentId`, an
// ordinary delivery to a still-live child does not.
function resumeAck(id: string, agentId: string, outputFile: string, at: string, stopped = "failed") {
  const text = JSON.stringify({
    success: true,
    message: `Agent "${agentId}" was stopped (${stopped}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${outputFile}`,
    resumedAgentId: agentId,
    pin: { id: agentId, name: agentId, ref: "e8f1bb" },
  })
  return { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } }
}
function queuedAck(id: string, agentId: string, at: string) {
  const text = JSON.stringify({ success: true, message: `Message queued for delivery to ${agentId} at its next tool round.`, pin: { id: agentId, name: agentId, ref: "e8f1bb" } })
  return { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } }
}

const OUT = "/tmp/tasks/a0b15ec8029fe3830.output"

test("applyRecord: a child that FAILED and was re-steered comes back live under its original identity", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, agentDispatch("toolu_dispatch", "Fix the node-shim abort", "2026-07-28T18:14:02.743Z"))
  applyRecord(s, agentLaunch("toolu_dispatch", "a0b15ec8029fe3830", OUT, "2026-07-28T18:14:02.926Z"))
  assert.equal(s.subAgents.size, 1)
  // The child hits a session limit. Its terminal notification retires it — correct at that instant.
  applyRecord(s, notify("toolu_dispatch", "a0b15ec8029fe3830", "failed", "2026-07-28T18:26:53.757Z"))
  assert.equal(s.subAgents.size, 0, "a failed child is retired")
  assert.equal(s.retiredSubAgents.get("toolu_dispatch")?.status, "failed")
  // The maintainer re-steers it. THIS is the signal the board used to have no way of seeing.
  applyRecord(s, sendMessage("toolu_send", "a0b15ec8029fe3830", "Resume shim fix", "2026-07-28T18:36:36.963Z"))
  applyRecord(s, resumeAck("toolu_send", "a0b15ec8029fe3830", OUT, "2026-07-28T18:36:36.974Z"))
  assert.equal(s.subAgents.size, 1, "the re-steered child is live again")
  const e = s.subAgents.get("toolu_dispatch")
  assert.ok(e, "it keeps the ORIGINAL dispatch tool_use id, so an open drawer keeps resolving")
  assert.equal(e?.label, "Fix the node-shim abort", "and its original label, not the steer's recap")
  assert.equal(e?.subagentType, "frizz:opus-high", "and its worker-profile tag")
  assert.equal(e?.taskId, "a0b15ec8029fe3830", "keyed to the runtime id, which is stable across restarts")
  assert.equal(e?.startedAt, "2026-07-28T18:36:36.974Z", "elapsed measures THIS run, not the dead gap")
  assert.equal(s.retiredSubAgents.has("toolu_dispatch"), false, "and it is no longer in the retired ring")
  // The resumed run's own completion notification names the SENDMESSAGE tool_use id, never the
  // original — the `<task-id>` is what correlates it back.
  applyRecord(s, notify("toolu_send", "a0b15ec8029fe3830", "completed", "2026-07-28T18:50:00.000Z"))
  assert.equal(s.subAgents.size, 0, "the resumed run retires on its own notification")
  assert.equal(s.retiredSubAgents.get("toolu_dispatch")?.status, "completed")
})

test("applyRecord: an ordinary SendMessage to a LIVE child neither duplicates it nor invents one", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, agentDispatch("toolu_dispatch", "Still working", "2026-07-28T18:14:02.743Z"))
  applyRecord(s, agentLaunch("toolu_dispatch", "a0b15ec8029fe3830", OUT, "2026-07-28T18:14:02.926Z"))
  applyRecord(s, sendMessage("toolu_send", "a0b15ec8029fe3830", "One more thing", "2026-07-28T18:20:00.000Z"))
  applyRecord(s, queuedAck("toolu_send", "a0b15ec8029fe3830", "2026-07-28T18:20:00.100Z"))
  assert.equal(s.subAgents.size, 1, "the queued-delivery shape restarts nothing")
  assert.ok(s.subAgents.has("toolu_dispatch"))
  // Even a RESTART ack for a child frizz still holds live must not double the row.
  applyRecord(s, resumeAck("toolu_send2", "a0b15ec8029fe3830", OUT, "2026-07-28T18:21:00.000Z"))
  assert.equal(s.subAgents.size, 1, "a restart ack for an already-live child is a no-op")
})

test("applyRecord: a REPLAYED restart ack can never resurrect a child that already finished", () => {
  // Claude transcripts re-emit past records verbatim (65 duplicated uuids in the reproduction
  // session). A restart ack is only a restart the first time it is folded.
  const s = newTailState("t", "s", "/x")
  applyRecord(s, agentDispatch("toolu_dispatch", "Long done", "2026-07-27T11:00:00.000Z"))
  applyRecord(s, agentLaunch("toolu_dispatch", "a776b185bf27ce789", OUT, "2026-07-27T11:00:00.500Z"))
  applyRecord(s, notify("toolu_dispatch", "a776b185bf27ce789", "failed", "2026-07-27T11:22:27.842Z"))
  applyRecord(s, sendMessage("toolu_send", "a776b185bf27ce789", "Resume tooldir-fix", "2026-07-27T11:29:05.830Z"))
  applyRecord(s, resumeAck("toolu_send", "a776b185bf27ce789", OUT, "2026-07-27T11:29:05.853Z"))
  assert.equal(s.subAgents.size, 1, "the genuine restart revives it")
  applyRecord(s, notify("toolu_send", "a776b185bf27ce789", "completed", "2026-07-27T11:58:10.271Z"))
  assert.equal(s.subAgents.size, 0)
  // …now the SAME ack replays, carrying its ORIGINAL timestamp, long after the child finished.
  applyRecord(s, resumeAck("toolu_send", "a776b185bf27ce789", OUT, "2026-07-27T11:29:05.853Z"))
  assert.equal(s.subAgents.size, 0, "replayed history is not a restart — the retired row's death is newer")
  // And the same replay once the retired row has aged out of the bounded ring, where the guard above
  // has nothing to compare against: the fold's monotonic high-water mark still rejects it.
  s.retiredSubAgents.clear()
  applyRecord(s, resumeAck("toolu_send", "a776b185bf27ce789", OUT, "2026-07-27T11:29:05.853Z"))
  assert.equal(s.subAgents.size, 0, "a stale ack cannot revive a child whose retired row is gone")
})

test("applyRecord: a restart whose retired row aged out still surfaces, labelled from the steer", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-28T18:30:00.000Z", message: { content: [{ type: "text", text: "working" }] } })
  applyRecord(s, sendMessage("toolu_send", "a0b15ec8029fe3830", "Resume shim fix from the preload gap", "2026-07-28T18:36:36.963Z"))
  applyRecord(s, resumeAck("toolu_send", "a0b15ec8029fe3830", OUT, "2026-07-28T18:36:36.974Z"))
  const e = s.subAgents.get("toolu_send")
  assert.equal(s.subAgents.size, 1, "a running child is surfaced even with no provenance in the fold")
  assert.equal(e?.label, "Resume shim fix from the preload gap", "labelled from the steer's own recap")
  assert.equal(e?.taskId, "a0b15ec8029fe3830")
  assert.equal(e?.outputFile, OUT, "its transcript resolves, so the staleness clock works")
})

test("applyRecord: a BACKGROUND Bash registers a SHELL op; a FOREGROUND Bash does not", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Watch origin/main CI", "gh run watch"))
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:02.000Z", message: { content: [{ type: "tool_use", name: "Bash", id: "toolu_fg", input: { command: "ls" } }] } })
  assert.equal(s.subAgents.size, 1)
  const e = s.subAgents.get("toolu_sh")
  assert.equal(e?.kind, "shell")
  assert.equal(e?.label, "Watch origin/main CI")
})

test("applyRecord: a Monitor registers the same live SHELL op and clears only on terminal notification", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, monitorUse("toolu_mon", "Watch PR checks", "gh pr checks 443 --watch"))
  assert.equal(s.subAgents.get("toolu_mon")?.kind, "shell")
  assert.equal(s.subAgents.get("toolu_mon")?.label, "Watch PR checks")
  applyRecord(s, resultText("toolu_mon", "Monitor started with ID: mon-12. You will be notified when events arrive."))
  assert.equal(s.subAgents.size, 1, "a Monitor launch ack must not retire the live watcher")
  applyRecord(s, taskNotification("toolu_mon", "completed"))
  assert.equal(s.subAgents.size, 0)
  assert.equal(s.retiredShells.size, 1, "the output drawer remains resolvable after completion")
})

test("applyRecord: a background shell without a description labels from the command's first line", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", null, "gh run watch 123\necho more"))
  assert.equal(s.subAgents.get("toolu_sh")?.label, "gh run watch 123")
})

test("applyRecord: a shell leaves the live view on completion and retains bounded drawer metadata", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Watch CI", "gh run watch"))
  applyRecord(s, taskNotification("toolu_sh", "completed"))
  assert.equal(s.subAgents.size, 0)
  // `label` and `taskId` are here so a fence's DECLARATION can be checked against a shell that has
  // already finished; `finishedAt` is here for the wake itself, which compares it against the agent's own
  // last word to decide whether the runtime already reported this shell (mid-turn) or nobody did (at
  // rest). `taskId` is undefined because this fixture retires the shell without a launch ack; the ack
  // path is covered by the auto-background case below, which asserts the id is captured.
  assert.deepEqual(s.retiredShells.get("toolu_sh"), { toolUseId: "toolu_sh", command: "gh run watch", outputFile: undefined, status: "completed", label: "Watch CI", taskId: undefined, finishedAt: "2026-07-01T00:00:09.000Z" })
})

// The pairing that matters for the watcher: a shell retired AFTER its launch ack keeps the runtime
// handle the worker was given, so `bzvtnt3ig` is still matchable once the shell itself is gone.
test("applyRecord: a retired shell keeps the runtime task id its launch ack named", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Running a larger spot-check batch", "node spotcheck.mjs"))
  applyRecord(s, resultText("toolu_sh", "Command running in background with ID: bzvtnt3ig. Output is being written to: /tmp/tasks/bzvtnt3ig.output."))
  applyRecord(s, taskNotification("toolu_sh", "completed"))
  const dead = s.retiredShells.get("toolu_sh")
  assert.equal(dead?.taskId, "bzvtnt3ig", "the handle a watcher is armed against survives the shell")
  assert.equal(dead?.label, "Running a larger spot-check batch")
})

test("applyRecord: a manual TaskStop clears a background Bash shell (the phantom-row leak fix)", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Boot isolated stack", "nub scripts/adhoc-stack.mjs"))
  applyRecord(s, resultText("toolu_sh", "Command running in background with ID: ba3y11c3t. Output is being written to: /tmp/tasks/ba3y11c3t.output. You will be notified when it completes."))
  assert.equal(s.subAgents.get("toolu_sh")?.taskId, "ba3y11c3t", "the runtime task id is captured from the launch ack")
  // TaskStop references the RUNTIME task id, which carries no tool_use id — the signal the board used to miss.
  applyRecord(s, taskStopResult("ba3y11c3t"))
  assert.equal(s.subAgents.size, 0, "a TaskStop retires the shell it killed")
  assert.equal(s.retiredSubAgents.size, 0, "shells are display-only — nothing to retain")
})

test("applyRecord: a Monitor timeout notification (no <status>, no <tool-use-id>) retires the watcher; a progress event does NOT", () => {
  // Corpus-real shapes (session 54b37ebe / bnmdbtlwx): a monitor that hits timeout_ms emits ONE
  // notification carrying only <task-id> + the "[Monitor timed out" <event> sentinel — no status.
  const monitorEvent = (taskId: string, event: string) => ({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-07-01T00:00:09.000Z",
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<summary>Monitor event: "wait for agent sweep"</summary>\n<event>${event}</event>\n</task-notification>`,
  })
  const s = newTailState("t", "s", "/x")
  applyRecord(s, monitorUse("toolu_mon", "wait for agent sweep", "test -f /tmp/marker", false))
  applyRecord(s, resultText("toolu_mon", "Monitor started (task bnmdbtlwx, timeout 300s). You will be notified on each event."))
  assert.equal(s.subAgents.get("toolu_mon")?.taskId, "bnmdbtlwx")
  // An ordinary progress event ALSO has <event> and no <status> — it must never retire the watcher
  // (the "missing status ⇒ terminal" trap would kill every live monitor on its first event).
  applyRecord(s, monitorEvent("bnmdbtlwx", "DISK READY"))
  assert.equal(s.subAgents.size, 1, "a status-less progress event must not retire a live monitor")
  applyRecord(s, monitorEvent("bnmdbtlwx", "[Monitor timed out — re-arm if needed.]"))
  assert.equal(s.subAgents.size, 0, "the timeout sentinel is terminal even with no <status>")
  assert.equal(s.retiredShells.get("toolu_mon")?.status, "killed")
})

test("applyRecord: a manual TaskStop clears a Monitor (task-id parsed from the real '(task <id>' ack)", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, monitorUse("toolu_mon", "Watch PR checks", "gh pr checks 443 --watch"))
  applyRecord(s, resultText("toolu_mon", "Monitor started (task b1ew0iy19, persistent — runs until TaskStop or session end). You will be notified on each event."))
  assert.equal(s.subAgents.get("toolu_mon")?.taskId, "b1ew0iy19")
  applyRecord(s, taskStopResult("b1ew0iy19", "gh pr checks 443 --watch"))
  assert.equal(s.subAgents.size, 0)
})

test("applyRecord: a manual TaskStop RETAINS an Agent for drawer review with status 'killed'", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_ag", "review the diff"))
  applyRecord(s, launch("toolu_ag", "/tmp/tasks/abc.output")) // ack carries "agentId: abc123"
  assert.equal(s.subAgents.get("toolu_ag")?.taskId, "abc123", "the agentId doubles as the TaskStop handle")
  applyRecord(s, taskStopResult("abc123", "agent"))
  assert.equal(s.subAgents.size, 0)
  assert.equal(s.retiredSubAgents.size, 1, "an agent stays drillable after a manual stop")
  assert.equal(s.retiredSubAgents.get("toolu_ag")?.status, "killed")
})

test("applyRecord: a completion notification lacking <tool-use-id> resolves by the captured <task-id>", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Watch CI", "gh run watch"))
  applyRecord(s, resultText("toolu_sh", "Command running in background with ID: bxyz9. Output is being written to: /tmp/tasks/bxyz9.output."))
  applyRecord(s, taskNotificationByTaskId("bxyz9", "completed"))
  assert.equal(s.subAgents.size, 0, "task-id is a valid fallback correlation key when tool-use-id is absent")
})

test("applyRecord: an attachment record carrying a <task-notification> retires a live shell", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Watch CI", "gh run watch"))
  applyRecord(s, taskNotificationAttachment("toolu_sh", "completed"))
  assert.equal(s.subAgents.size, 0, "the inline attachment carrier is a valid completion signal")
  assert.equal(s.retiredShells.get("toolu_sh")?.status, "completed")
})

test("applyRecord: a shell whose completion RACES ahead of its launch is retired by the inline attachment", () => {
  // Real 2026-07-22 leak (session 6dfa3c7c, shell b9br679ws): a background shell completed MID-TURN,
  // so the harness flushed its queue-operation completion bookkeeping at a FILE POSITION PRECEDING the
  // launch's own assistant record. Folding that first finds no live entry (no-op) — the queue-operation
  // path can never retire the shell. The launch then registers it, and the SAME completion arrives a
  // second time, inline, on an `attachment` record positioned AFTER the launch. Without reading the
  // attachment carrier the shell leaked as a phantom "active background shell" forever.
  const s = newTailState("t", "s", "/x")
  // (a) completion folded BEFORE the launch: no live entry, so the queue-operation path is a no-op.
  applyRecord(s, taskNotification("toolu_race", "completed"))
  assert.equal(s.subAgents.size, 0)
  assert.equal(s.retiredShells.size, 0, "a completion for a not-yet-registered id retires nothing")
  // launch + ack registers the shell and captures its runtime task id.
  applyRecord(s, bashBg("toolu_race", "Create retirement worktree + install deps", "git worktree add ../wt -b slug"))
  applyRecord(s, resultText("toolu_race", "Command running in background with ID: b9br679ws. Output is being written to: /tmp/tasks/b9br679ws.output."))
  assert.equal(s.subAgents.size, 1, "the shell is live after its launch")
  // (c) the same completion, delivered inline on the attachment record AFTER the launch — retires it.
  applyRecord(s, taskNotificationAttachment("toolu_race", "completed"))
  assert.equal(s.subAgents.size, 0, "the inline attachment completion retires the raced shell")
  assert.equal(s.retiredShells.get("toolu_race")?.status, "completed")
})

test("applyRecord: a background AGENT hit by the SAME race is retired by the inline attachment (symmetric with shells)", () => {
  // The race is not shell-specific: background Agent dispatches ride the exact same
  // notificationText/trackCompletions path, so a sub-agent completing mid-turn (queue-op completion
  // flushed BEFORE its launch, recovered by the inline attachment AFTER it) must retire too — into the
  // drawer ring, with status "completed".
  const s = newTailState("t", "s", "/x")
  applyRecord(s, taskNotification("toolu_ag", "completed")) // folded before launch — no live entry, no-op
  assert.equal(s.subAgents.size, 0)
  applyRecord(s, dispatch("toolu_ag", "review the diff")) // background Agent
  applyRecord(s, launch("toolu_ag", "/tmp/tasks/abc.output"))
  assert.equal(s.subAgents.size, 1, "the agent is live after its launch")
  applyRecord(s, taskNotificationAttachment("toolu_ag", "completed"))
  assert.equal(s.subAgents.size, 0, "the inline attachment completion retires the raced agent")
  assert.equal(s.retiredSubAgents.get("toolu_ag")?.status, "completed", "an agent stays drillable in the ring")
})

test("applyRecord: a `stopped` RECOVERY notification retires EVERY orphaned sub-agent it names", () => {
  // Real 2026-07-23 leak (nub thread review-nubjs-nub-500-2): a turn was interrupted with 3 background
  // agents in flight, so no `completed` ever arrived. The NEXT session emitted ONE `stopped` recovery
  // notification naming all 3 by their runtime task-id (agentId) with NO tool-use-id. The old guard
  // dropped `stopped` outright — and even had it not, the single-.match() would have freed only the
  // first id — so 2 of 3 leaked as `stale` sub-agents forever, and re-derived identically on every restart.
  const s = newTailState("t", "sid-1", "/logs/sid-1.jsonl")
  const agents: [string, string, string][] = [
    ["toolu_a1", "aeb3c7711a80cb53d", "Empirical differential probe of PR 500"],
    ["toolu_a2", "a46a90cfaf25b6264", "Impact analysis of PR 500 hook sites"],
    ["toolu_a3", "a389ac8bce4621e32", "Decision-record cross-check for PR 500"],
  ]
  for (const [id, aid, desc] of agents) {
    applyRecord(s, dispatch(id, desc))
    // The mailbox ack captures the agentId as the entry's runtime task id — the ONLY key the recovery
    // notification carries for it.
    applyRecord(s, resultText(id, `Spawned successfully.\nagentId: ${aid}\nThe agent is now running.`))
  }
  assert.equal(s.subAgents.size, 3, "three live background agents after their launches")
  applyRecord(s, stoppedRecovery(["aeb3c7711a80cb53d", "a46a90cfaf25b6264", "a389ac8bce4621e32"]))
  assert.equal(s.subAgents.size, 0, "ALL three retire on the single stopped recovery notification")
  assert.equal(s.retiredSubAgents.get("toolu_a1")?.status, "killed")
  assert.equal(s.retiredSubAgents.get("toolu_a3")?.status, "killed", "not just the FIRST id in the block")
})

test("applyRecord: a `stopped` RECOVERY notification retires orphaned background SHELLS (which have no staleness clock)", () => {
  // Real 2026-07-23 leak (nub thread cpu-and-memory-usage-is-insanely): background Bash shells that
  // finished with no completion record showed "running" for 8+ HOURS. A shell has NO staleness fallback
  // (run_in_background can't tell a CI watcher from a vite dev server), so ONLY a terminal signal clears
  // it — and the `stopped` recovery IS that signal. The real block also carries an
  // `__orphan_summary__:shell` sentinel task-id that must be SKIPPED, never mis-correlated.
  const s = newTailState("t", "s", "/x")
  const shells: [string, string][] = [["toolu_s1", "bet4w4tnm"], ["toolu_s2", "bjp84skrl"], ["toolu_s3", "bnj12ktmw"]]
  for (const [id, tid] of shells) {
    applyRecord(s, bashBg(id, "probe process tree", "ps aux"))
    applyRecord(s, resultText(id, `Command running in background with ID: ${tid}. Output is being written to: /tmp/tasks/${tid}.output.`))
  }
  assert.equal(s.subAgents.size, 3, "three live background shells after their launches")
  applyRecord(s, stoppedRecovery(["bet4w4tnm", "bjp84skrl", "bnj12ktmw"], "shell"))
  assert.equal(s.subAgents.size, 0, "every orphaned shell retires; the __orphan_summary__ sentinel is a harmless skip")
  assert.equal(s.retiredShells.get("toolu_s1")?.status, "killed")
  assert.equal(s.retiredShells.get("toolu_s3")?.status, "killed")
})

test("applyRecord: a `stopped` recovery whose ids match nothing live is a no-op (never throws)", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_live", "Watch CI", "gh run watch"))
  applyRecord(s, resultText("toolu_live", "Command running in background with ID: bkeep. Output is being written to: /tmp/tasks/bkeep.output."))
  applyRecord(s, stoppedRecovery(["bgone1", "bgone2"], "shell")) // ids for ops this session never tracked
  assert.equal(s.subAgents.size, 1, "an unrelated recovery leaves a genuinely-live shell untouched")
})

test("applyRecord: a TaskStop that did NOT confirm success never retires a live op", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Watch CI", "gh run watch"))
  applyRecord(s, resultText("toolu_sh", "Command running in background with ID: bfail1. Output is being written to: /tmp/tasks/bfail1.output."))
  // A failed/no-op stop: the result carries a task_id but no "Successfully stopped task" confirmation.
  applyRecord(s, resultText("toolu_stop", JSON.stringify({ error: "No running task with id bfail1", task_id: "bfail1" })))
  assert.equal(s.subAgents.size, 1, "an unconfirmed stop must leave the live op untouched")
})

test("applyRecord: a TaskStop for an UNRELATED task id leaves every tracked op alone", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Watch CI", "gh run watch"))
  applyRecord(s, resultText("toolu_sh", "Command running in background with ID: bmine1. Output is being written to: /tmp/tasks/bmine1.output."))
  applyRecord(s, taskStopResult("bother2")) // stops some other session's task
  assert.equal(s.subAgents.size, 1, "only the op whose captured task id matches is retired")
})

// A tool_result user record with arbitrary text for a given tool_use id (ack/report shapes below).
function resultText(id: string, text: string) {
  return { type: "user", timestamp: "2026-07-01T00:00:02.000Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } }
}
// A TaskStop tool_result — the REAL structured shape (content is a JSON STRING carrying `task_id` and
// the "Successfully stopped task:" confirmation). This is the terminal signal for a manually-killed op.
function taskStopResult(taskId: string, command = "gh run watch") {
  return {
    type: "user",
    timestamp: "2026-07-01T00:00:08.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_stop", content: JSON.stringify({ message: `Successfully stopped task: ${taskId} (${command})`, task_id: taskId, task_type: "local_bash", command }) }] },
  }
}
// A `stopped` RECOVERY notification: a NEW session's report for background ops the PREVIOUS process left
// with no completion record. Corpus-real shape (nub sessions ccf8cda0 / 54b37ebe, 2026-07-23): ONE block
// listing EVERY orphan's runtime task-id, NO tool-use-id, status "stopped" — and for shells an
// `__orphan_summary__:shell` sentinel task-id (which correlates to nothing and must be skipped).
function stoppedRecovery(taskIds: string[], kind: "agent" | "shell" = "agent") {
  const ids = kind === "shell" ? [...taskIds, "__orphan_summary__:shell"] : taskIds
  const body = ids.map((t) => `<task-id>${t}</task-id>`).join("\n")
  return {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-07-01T00:05:00.000Z",
    content: `<task-notification>\n${body}\n<status>stopped</status>\n<summary>These ops have no completion record and have been marked stopped. Task ids: ${taskIds.join(", ")}.</summary>\n</task-notification>`,
  }
}
// A completion notification that OMITS <tool-use-id> (some emitters do) — only the runtime <task-id>.
function taskNotificationByTaskId(taskId: string, status: string) {
  return {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-07-01T00:00:09.000Z",
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`,
  }
}
// A completion <task-notification> delivered INLINE on an `attachment` record (type:"queued_command",
// carried in `attachment.prompt`). This is the carrier that survives the mid-turn race: the
// queue-operation bookkeeping (above) can be flushed BEFORE the launch, but the attachment is written
// inline when the queued item is injected — always AFTER the launch that was in flight.
function taskNotificationAttachment(id: string, status: string, taskId = "abc123") {
  return {
    type: "attachment",
    timestamp: "2026-07-01T00:00:10.000Z",
    attachment: { type: "queued_command", prompt: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>Shell finished</summary>\n</task-notification>` },
  }
}

test("applyRecord: a shell's REAL launch ack ('Command running in background…') keeps it tracked + resolves its output path", () => {
  // Regression: the corpus shell ack carries NO `output_file:` token — an earlier discriminator
  // retired the shell on its own ack, killing the bgShells feature one tick after launch.
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Watch CI", "gh run watch"))
  applyRecord(s, resultText("toolu_sh", "Command running in background with ID: b8p363n40. Output is being written to: /tmp/tasks/b8p363n40.output. You will be notified when it completes."))
  assert.equal(s.subAgents.size, 1, "the launch ack must never retire a background shell")
  assert.equal(s.subAgents.get("toolu_sh")?.outputFile, "/tmp/tasks/b8p363n40.output", "sentence period stripped from the captured path")
})

test("applyRecord: a FOREGROUND Bash auto-backgrounded on timeout becomes a tracked live shell", () => {
  // The regression this closes: the harness moves a foreground Bash that outlives its `timeout` into
  // the background and says so ONLY in the result. `trackDispatches` registers nothing for a foreground
  // Bash, so the detached shell was invisible on every surface, could not hold its thread Active, and
  // its completion notification correlated to nothing. Real shape, 2026-07-30 pullfrog session.
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashFg("toolu_fg", "Wait for the backfill to finish", "until grep -q '^TOTALS' log; do sleep 25; done"))
  assert.equal(s.subAgents.size, 0, "a foreground Bash is not a background op while it is still foreground")
  applyRecord(s, resultText("toolu_fg", autoBackgroundAck("bhlfxzwg1")))
  assert.equal(s.subAgents.size, 1, "the auto-background handoff must promote it to a live shell")
  const entry = s.subAgents.get("toolu_fg")
  assert.equal(entry?.kind, "shell")
  assert.equal(entry?.label, "Wait for the backfill to finish", "the label comes from the parked launch, not the ack")
  assert.equal(entry?.taskId, "bhlfxzwg1", "the runtime task id must be captured for TaskStop correlation")
  assert.equal(entry?.outputFile, "/tmp/tasks/bhlfxzwg1.output", "sentence period stripped from the captured path")
  assert.equal(s.pendingShells?.size ?? 0, 0, "the park is consumed by the result that promoted it")
})

test("applyRecord: an auto-backgrounded shell retires on its own <task-notification>", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashFg("toolu_fg", "Run the full production backfill", "nub reap.ts"))
  applyRecord(s, resultText("toolu_fg", autoBackgroundAck("b2hk8870c", 600)))
  assert.equal(s.subAgents.size, 1)
  applyRecord(s, taskNotificationAttachment("toolu_fg", "completed", "b2hk8870c"))
  assert.equal(s.subAgents.size, 0, "the completion notification must clear the promoted shell")
  assert.equal(s.retiredShells.get("toolu_fg")?.status, "completed")
})

test("applyRecord: an ORDINARY foreground Bash result leaves nothing tracked and nothing parked", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashFg("toolu_fg", "List files", "ls"))
  assert.equal(s.pendingShells?.size, 1, "parked only until its result lands")
  applyRecord(s, resultText("toolu_fg", "a.txt\nb.txt"))
  assert.equal(s.subAgents.size, 0, "a command that simply finished is not a background op")
  assert.equal(s.pendingShells?.size ?? 0, 0, "the park is released either way")
})

test("applyRecord: pendingShells is bounded — a turn of foreground Bash calls cannot grow it without limit", () => {
  const s = newTailState("t", "s", "/x")
  for (let i = 0; i < 100; i++) applyRecord(s, bashFg(`toolu_fg_${i}`, `probe ${i}`, "true"))
  assert.equal(s.pendingShells?.size, 32, "capped at PENDING_SHELLS_MAX, newest-wins")
  assert.ok(s.pendingShells?.has("toolu_fg_99"), "the newest launch survives the cap")
})

test("applyRecord: a non-ack shell tool_result retires a failed synchronous launch (no phantom live op)", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Watch CI", "gh run watch"))
  applyRecord(s, resultText("toolu_sh", "Error: Monitor is unavailable"))
  assert.equal(s.subAgents.size, 0)
  assert.equal(s.retiredSubAgents.size, 0)
})

test("applyRecord: the mailbox agent ack ('Spawned successfully…', no path) keeps tracking + derives the subagents path from agentId", () => {
  const s = newTailState("t", "sid-1", "/logs/sid-1.jsonl")
  applyRecord(s, dispatch("toolu_bg", "researcher"))
  applyRecord(s, resultText("toolu_bg", "Spawned successfully. (This tool result is internal metadata — never quote it.)\nagentId: aXYZ-123\nThe agent is now running and will receive instructions via mailbox."))
  assert.equal(s.subAgents.size, 1, "a mailbox launch ack must never retire a live background agent")
  assert.equal(s.subAgents.get("toolu_bg")?.outputFile, "/logs/sid-1/subagents/agent-aXYZ-123.jsonl")
})

test("applyRecord: the path-less 'Async agent launched' ack keeps tracking (no retire, path from agentId)", () => {
  const s = newTailState("t", "sid-1", "/logs/sid-1.jsonl")
  applyRecord(s, dispatch("toolu_bg", "researcher"))
  applyRecord(s, resultText("toolu_bg", "Async agent launched successfully.\nagentId: abc9\nDo not mention this."))
  assert.equal(s.subAgents.size, 1)
  assert.equal(s.subAgents.get("toolu_bg")?.outputFile, "/logs/sid-1/subagents/agent-abc9.jsonl")
})

test("applyRecord: a FOREGROUND agent's tool_result (its final report — not an ack) retires it into the ring", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_fg2", "quick check"))
  applyRecord(s, resultText("toolu_fg2", "Here are my findings: the flag is unused.\n\n1. …"))
  assert.equal(s.subAgents.size, 0, "a synchronous completion must retire the tracked entry")
  assert.equal(s.retiredSubAgents.get("toolu_fg2")?.status, "completed")
})

test("applyRecord: an AskUserQuestion sets pendingAsk (structured); its tool_result clears it", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, askUse("toolu_ask", [{ question: "Which package manager?", header: "PM", multiSelect: false, options: [{ label: "pnpm", description: "fast" }, { label: "npm" }] }]))
  assert.ok(s.pendingAsk)
  assert.equal(s.pendingAsk?.id, "toolu_ask")
  assert.equal(s.pendingAsk?.questions[0].question, "Which package manager?")
  assert.equal(s.pendingAsk?.questions[0].header, "PM")
  assert.equal(s.pendingAsk?.questions[0].options.length, 2)
  assert.equal(s.pendingAsk?.questions[0].options[0].description, "fast")
  applyRecord(s, toolResult("toolu_ask")) // the human answered in the terminal
  assert.equal(s.pendingAsk, undefined)
})

test("applyRecord: a malformed AskUserQuestion input is ignored (no pendingAsk, no throw)", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, askUse("toolu_ask", "not-an-array"))
  assert.equal(s.pendingAsk, undefined)
})

test("applyRecord: a BACKGROUND Agent dispatch registers a live sub-agent; foreground is ignored", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_bg", "Investigate issue 376"))
  applyRecord(s, dispatch("toolu_fg", "Blocking child", false)) // run_in_background:false → skipped
  assert.equal(s.subAgents.size, 1)
  const e = s.subAgents.get("toolu_bg")
  assert.equal(e?.label, "Investigate issue 376")
  assert.equal(e?.startedAt, "2026-07-01T00:00:01.000Z")
  assert.equal(e?.subagentType, "frizz:opus-high") // the RESOLVED profile cell, not input.subagent_type verbatim
  assert.equal(e?.outputFile, undefined) // not yet enriched
})

test("applyRecord: a dispatch WITHOUT subagent_type registers with an undefined type (no tag)", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_bg", "child", true, null)) // null → omit subagent_type entirely
  assert.equal(s.subAgents.size, 1)
  assert.equal(s.subAgents.get("toolu_bg")?.subagentType, undefined)
})

test("applyRecord: the launch tool_result enriches the sub-agent with its output_file", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_bg", "child"))
  applyRecord(s, launch("toolu_bg", "/tmp/tasks/abc123.output"))
  assert.equal(s.subAgents.get("toolu_bg")?.outputFile, "/tmp/tasks/abc123.output")
  // a launch result for an UNTRACKED id is ignored (no phantom entry)
  applyRecord(s, launch("toolu_unknown", "/tmp/tasks/zzz.output"))
  assert.equal(s.subAgents.size, 1)
})

test("applyRecord: a TERMINAL task-notification removes the sub-agent; a running ping does not", () => {
  for (const status of ["completed", "failed", "killed"]) {
    const s = newTailState("t", "s", "/x")
    applyRecord(s, dispatch("toolu_bg", "child"))
    applyRecord(s, taskNotification("toolu_bg", "running")) // non-terminal — kept
    assert.equal(s.subAgents.size, 1, `running ping keeps the entry (status under test: ${status})`)
    applyRecord(s, taskNotification("toolu_bg", status)) // terminal — removed
    assert.equal(s.subAgents.size, 0, `${status} clears the entry`)
    // a repeat terminal notify is idempotent (a resumed task-id may notify twice)
    applyRecord(s, taskNotification("toolu_bg", status))
    assert.equal(s.subAgents.size, 0)
  }
})

test("applyRecord: a terminal task-notification RETAINS the sub-agent for drawer review", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_bg", "child"))
  applyRecord(s, launch("toolu_bg", "/tmp/tasks/abc123.output"))
  applyRecord(s, taskNotification("toolu_bg", "completed"))
  assert.equal(s.subAgents.size, 0, "removed from the LIVE set (banner/counts stay live-only)")
  const dead = s.retiredSubAgents.get("toolu_bg")
  assert.equal(dead?.status, "completed")
  assert.equal(dead?.label, "child")
  assert.equal(dead?.outputFile, "/tmp/tasks/abc123.output", "retains the output path so the drawer resolves")
})

test("applyRecord: sub-agent tracking never disturbs turn state", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_bg", "child")) // an assistant tool_use record
  assert.equal(s.lastKind, "assistant")
  assert.equal(s.lastStopReason, "tool_use")
  applyRecord(s, taskNotification("toolu_bg", "completed")) // a queue-operation record
  assert.equal(s.lastKind, "assistant", "a queue-operation record is sidecar — turn state untouched")
})

test("tailer: surfaces running vs stale sub-agents (via injected mtime) and clears on completion", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const dispatchLine = JSON.stringify(dispatch("toolu_bg", "child"))
  const launchLine = JSON.stringify(launch("toolu_bg", "/tmp/tasks/abc123.output"))
  fixture(h.logDir, "sid", [IN_FLIGHT, dispatchLine, launchLine])
  // child transcript last written at t=00:00:02; the tailer's clock advances below.
  const childMtime = Date.parse("2026-07-01T00:00:02.000Z")
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    sessionLogDir: h.logDir,
    mtimeMs: () => childMtime,
  })

  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z") // <15min since child mtime → running
  t.tick() // prime
  assert.deepEqual(t.get("t")?.subAgents, [{ label: "child", startedAt: "2026-07-01T00:00:01.000Z", state: "running", subagentType: "frizz:opus-high", id: "toolu_bg", taskId: "abc123", lastActivityAt: "2026-07-01T00:00:02.000Z" }])

  h.clock.ms = Date.parse("2026-07-01T00:20:00.000Z") // >15min since child mtime (SUBAGENT_STALE_MS) → stale
  const before = h.changes.n
  t.tick()
  assert.equal(t.get("t")?.subAgents[0].state, "stale")
  assert.ok(h.changes.n > before, "a running→stale transition marks the board dirty")

  // completion notification clears the sub-agent
  appendFileSync(join(h.logDir, "sid.jsonl"), JSON.stringify(taskNotification("toolu_bg", "completed")) + "\n")
  const before2 = h.changes.n
  t.tick()
  assert.deepEqual(t.get("t")?.subAgents, [])
  assert.ok(h.changes.n > before2, "clearing a sub-agent marks the board dirty")
})

test("tailer: a `stopped` recovery notification clears EVERY orphaned sub-agent through the real tick loop", () => {
  // Integration form of the orphan-retirement fix, driven through createTailer.tick() (not applyRecord
  // in isolation): three background agents left with no completion record, then the real multi-id
  // `stopped` recovery notification appended — the whole live set must drain to empty and the board dirty.
  const h = harness()
  h.storage.upsertSession(row())
  const agents: [string, string][] = [["toolu_a1", "aeb3c7711a80cb53d"], ["toolu_a2", "a46a90cfaf25b6264"], ["toolu_a3", "a389ac8bce4621e32"]]
  const seeded: string[] = [IN_FLIGHT]
  for (const [id, aid] of agents) {
    seeded.push(JSON.stringify(dispatch(id, `orphan ${aid}`)))
    seeded.push(JSON.stringify(resultText(id, `Spawned successfully.\nagentId: ${aid}\nThe agent is now running.`)))
  }
  fixture(h.logDir, "sid", seeded)
  const childMtime = Date.parse("2026-07-01T00:00:02.000Z")
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    sessionLogDir: h.logDir,
    mtimeMs: () => childMtime,
  })

  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick() // prime
  assert.equal(t.get("t")?.subAgents.length, 3, "three live background agents after prime")

  appendFileSync(join(h.logDir, "sid.jsonl"), JSON.stringify(stoppedRecovery(["aeb3c7711a80cb53d", "a46a90cfaf25b6264", "a389ac8bce4621e32"])) + "\n")
  const before = h.changes.n
  t.tick()
  assert.deepEqual(t.get("t")?.subAgents, [], "the single stopped recovery drains ALL three, not just the first")
  assert.ok(h.changes.n > before, "clearing the orphans marks the board dirty")
})

test("tailer: dismissOp retires a live sub-agent AND a live shell by id, immediately, and is a no-op otherwise", () => {
  // The manual × escape hatch: retire a signal-less op the human decided is finished, without waiting
  // for a terminal record. Drives the real tailer so the removal reflects through get()/onChange.
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [
    IN_FLIGHT,
    JSON.stringify(dispatch("toolu_ag", "orphan agent")),
    JSON.stringify(resultText("toolu_ag", "Spawned successfully.\nagentId: aOrphan\nThe agent is now running.")),
    JSON.stringify(bashBg("toolu_sh", "wait for a signal that never comes", "sleep 99999")),
    JSON.stringify(resultText("toolu_sh", "Command running in background with ID: bOrphan. Output is being written to: /tmp/tasks/bOrphan.output.")),
  ])
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage, bus: h.bus, onChange: () => h.changes.n++,
    now: () => h.clock.ms, paneDead: () => h.dead.v,
    sessionLogDir: h.logDir, mtimeMs: () => Date.parse("2026-07-01T00:00:02.000Z"),
  })
  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick() // prime
  assert.equal(t.get("t")?.subAgents.length, 1, "one live sub-agent")
  assert.equal(t.get("t")?.bgShells.length, 1, "one live background shell")

  assert.equal(t.dismissOp?.("nope", "toolu_ag"), false, "unknown slug → no-op")
  assert.equal(t.dismissOp?.("t", "toolu_missing"), false, "unknown id → no-op")

  const before = h.changes.n
  assert.equal(t.dismissOp?.("t", "toolu_ag"), true, "dismissing the live agent reports success")
  assert.ok(h.changes.n > before, "a dismiss reflects immediately (onChange), not only on the next tick")
  assert.deepEqual(t.get("t")?.subAgents, [], "the agent leaves the live view at once")
  assert.equal(t.subAgent("t", "toolu_ag")?.state, "done", "…and stays resolvable in the retained ring for its drawer")

  assert.equal(t.dismissOp?.("t", "toolu_sh"), true, "dismissing the live shell reports success")
  assert.deepEqual(t.get("t")?.bgShells, [], "the shell leaves the live view too")
  assert.equal(t.dismissOp?.("t", "toolu_ag"), false, "a second dismiss of an already-retired op is a no-op")
})

test("tailer: a shell whose task id has not arrived yet is NOT marked stoppable", () => {
  // The window this closes: a shell's row is minted at its `tool_use` record, but the task id frizz
  // would stop it with only arrives at the LAUNCH ACK one record later. `stoppable` is what the client
  // renders the × off, so advertising it before the handle exists puts a control on the row that would
  // fail on click — "We shouldn't show the X if it doesn't fucking work" (maintainer 2026-07-30).
  const h = harness()
  h.storage.upsertSession(row())
  const shellLine = JSON.stringify(bashBg("toolu_sh", "Watch CI", "gh run watch"))
  fixture(h.logDir, "sid", [IN_FLIGHT, shellLine]) // the tool_use, and deliberately NO ack
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    sessionLogDir: h.logDir,
    mtimeMs: () => Date.parse("2026-07-01T00:00:02.000Z"),
  })
  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick()
  const shell = t.get("t")?.bgShells[0]
  assert.equal(shell?.id, "toolu_sh", "the row still appears — live work is never hidden")
  assert.equal(shell?.state, "running")
  assert.equal(shell?.stoppable, undefined, "…but it advertises no stop until frizz holds the handle")
  assert.equal(shell?.taskId, undefined, "…and names no task id it does not yet have")
})

// THE ID THE WORKER WAS HANDED has to reach the view, because a `shell` watcher is registered against it
// — "Command running in background with ID: bzvtnt3ig" is the only handle the runtime ever shows a model,
// and the scheduler matches its watchers on this field (scheduler.evalWatchers). While `taskId` was
// captured but kept private to the fold, every such watcher was unfireable (maintainer 2026-08-14).
test("tailer: a shell's view carries the runtime's own background-task id, not just its launch id", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const shellLine = JSON.stringify(bashBg("toolu_sh", "Watch CI", "gh run watch"))
  const ackLine = JSON.stringify(resultText("toolu_sh", "Command running in background with ID: bzvtnt3ig. Output is being written to: /tmp/tasks/bzvtnt3ig.output. You will be notified when it completes."))
  fixture(h.logDir, "sid", [IN_FLIGHT, shellLine, ackLine])
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    sessionLogDir: h.logDir,
    mtimeMs: () => Date.parse("2026-07-01T00:00:02.000Z"),
  })
  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick()
  const shell = t.get("t")?.bgShells[0]
  assert.equal(shell?.taskId, "bzvtnt3ig", "the runtime handle a watcher is armed against")
  assert.equal(shell?.id, "toolu_sh", "…alongside the launch id, which is what the two copies of a row reconcile on")
})

test("tailer: a dead pane clears its background shells — a shell cannot outlive the agent process", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const shellLine = JSON.stringify(bashBg("toolu_sh", "Watch CI", "gh run watch"))
  const ackLine = JSON.stringify(resultText("toolu_sh", "Command running in background with ID: b8p. Output is being written to: /tmp/tasks/b8p.output. You will be notified when it completes."))
  fixture(h.logDir, "sid", [IN_FLIGHT, shellLine, ackLine])
  const shellMtime = Date.parse("2026-07-01T00:00:02.000Z")
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    sessionLogDir: h.logDir,
    mtimeMs: () => shellMtime,
  })

  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z") // <5min since shell output → live
  t.tick()
  assert.deepEqual(t.get("t")?.bgShells, [{ id: "toolu_sh", label: "Watch CI", startedAt: "2026-07-01T00:00:01.000Z", state: "running", stoppable: true, taskId: "b8p", lastActivityAt: "2026-07-01T00:00:02.000Z" }])

  // The agent process dies WITHOUT a terminal notification landing for the
  // shell. The shell is a child of that process, so it died with it — the board must stop reporting it
  // as live (otherwise it would breathe "alive" forever).
  h.dead.v = true
  const before = h.changes.n
  t.tick()
  assert.deepEqual(t.get("t")?.bgShells, [], "a dead pane owns no live background shells")
  assert.ok(h.changes.n > before, "the shell vanishing marks the board dirty")
})

// A HEADLESS row (broker claude / app-server codex) has NO pane at all, so the pane probe can only ever
// answer "dead" for it — and the prime path asked anyway, latching paneDead=true at first sighting while
// the steady tick (guarded by !isHeadlessRow) never revisited it. Every broker thread therefore reported
// bgShells:[] for the life of the process, however many shells the fold was tracking. Measured on the
// real board 2026-07-29: 174 threads, 13 holding live shell entries, ZERO rendering one — the sole
// paneDead=false row was a legacy pre-broker thread. The pane probe must not be consulted at all here.
test("tailer: a BROKER (headless) thread reports its live background shells — the pane probe is never asked", () => {
  const h = harness()
  h.storage.upsertSession(row())
  h.storage.setBackend("t", "claude")
  h.storage.setClaudeRuntime("t", "broker")
  const shellLine = JSON.stringify(bashBg("toolu_sh", "Watch CI on PR 604", "nub scripts/ci-watch.ts --pr 604"))
  const ackLine = JSON.stringify(resultText("toolu_sh", "Command running in background with ID: b63. Output is being written to: /tmp/tasks/b63.output. You will be notified when it completes."))
  fixture(h.logDir, "sid", [IN_FLIGHT, shellLine, ackLine])
  const shellMtime = Date.parse("2026-07-01T00:00:02.000Z")
  const deadCalls: string[] = []
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    // The real pane probe's answer for a slug with no pane, which is EVERY headless row: dead.
    paneDead: (slug) => { deadCalls.push(slug); return true },
    sessionLogDir: h.logDir,
    mtimeMs: () => shellMtime,
  })

  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick() // prime — the tick that used to latch paneDead=true
  assert.deepEqual(t.get("t")?.bgShells, [{ id: "toolu_sh", label: "Watch CI on PR 604", startedAt: "2026-07-01T00:00:01.000Z", state: "running", stoppable: true, taskId: "b63", lastActivityAt: "2026-07-01T00:00:02.000Z" }])
  t.tick() // and the steady tick keeps it, rather than latching on a stale prime reading
  assert.equal(t.get("t")?.bgShells.length, 1, "the shell survives the steady tick")
  assert.deepEqual(deadCalls, [], "a paneless row is never sniffed for pane death")
  // The drill-in drawer reads the same fact and must agree — it reported "done" for a live shell.
  assert.equal(t.backgroundShell?.("t", "toolu_sh")?.state, "running")
})

// The other half of the same contract: a headless thread has no pane to die, so its shells clear on the
// registry's exit stamp instead — and on the TICK, not only at prime, or the reading latches forever.
test("tailer: stopping a BROKER thread clears its live background shells (the headless pane-death)", () => {
  const h = harness()
  h.storage.upsertSession(row())
  h.storage.setBackend("t", "claude")
  h.storage.setClaudeRuntime("t", "broker")
  const shellLine = JSON.stringify(bashBg("toolu_sh", "Watch CI on PR 604", "nub scripts/ci-watch.ts --pr 604"))
  const ackLine = JSON.stringify(resultText("toolu_sh", "Command running in background with ID: b63. Output is being written to: /tmp/tasks/b63.output. You will be notified when it completes."))
  fixture(h.logDir, "sid", [IN_FLIGHT, shellLine, ackLine])
  const shellMtime = Date.parse("2026-07-01T00:00:02.000Z")
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => false,
    sessionLogDir: h.logDir,
    mtimeMs: () => shellMtime,
  })

  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick()
  assert.equal(t.get("t")?.bgShells.length, 1, "live before the session is stopped")

  h.storage.setExited("t", true) // frizz stopped the broker session — its children went with it
  const before = h.changes.n
  t.tick()
  assert.deepEqual(t.get("t")?.bgShells, [], "a stopped headless session owns no live background shells")
  assert.ok(h.changes.n > before, "the shell vanishing marks the board dirty")
})

// The seven-hour phantom (thread invoices-just-went-out-for-august, 2026-08-02). A broker daemon that
// dies WITHOUT frizz stopping it — SIGKILL, OOM, its own 6h idle-timeout — never gets `exited` stamped,
// because that column records only a deliberate stop. paneDeadForRow read `exited` alone, so the row
// stayed "alive" and every background shell the dead process owned kept shimmering on the board. The
// operator came back after seven hours to a background shell still rendering as running; its owning
// process had been gone for most of that, and its script had never completed at all. Nothing cleared it
// until the next prompt spawned a successor daemon, whose resume-time reconciliation finally emitted the
// terminal notification the fold had been waiting on. The daemon's own discovery record is the reading
// that was available the whole time.
test("tailer: a broker daemon that dies UNSTOPPED clears its shells — `exited` is not the only death", () => {
  const h = harness()
  h.storage.upsertSession(row())
  h.storage.setBackend("t", "claude")
  h.storage.setClaudeRuntime("t", "broker")
  const shellLine = JSON.stringify(bashBg("toolu_sh", "Watch CI on PR 604", "nub scripts/ci-watch.ts --pr 604"))
  const ackLine = JSON.stringify(resultText("toolu_sh", "Command running in background with ID: b63. Output is being written to: /tmp/tasks/b63.output. You will be notified when it completes."))
  fixture(h.logDir, "sid", [IN_FLIGHT, shellLine, ackLine])
  const shellMtime = Date.parse("2026-07-01T00:00:02.000Z")
  const daemon = { alive: true }
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => false,
    sessionLogDir: h.logDir,
    mtimeMs: () => shellMtime,
    brokerDaemonAlive: () => daemon.alive,
  })

  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick()
  assert.equal(t.get("t")?.bgShells.length, 1, "live while the daemon is running")

  daemon.alive = false // killed outright: no exit record, no terminal notification, `exited` still 0
  const before = h.changes.n
  t.tick()
  assert.equal(h.storage.getSession("t")?.exited ?? 0, 0, "the row was never deliberately stopped")
  assert.deepEqual(t.get("t")?.bgShells, [], "a dead daemon owns no live background shells")
  assert.ok(h.changes.n > before, "the shell vanishing marks the board dirty")
})

// The DELIVERY twin of the test above, and the same reading answers both. An outstanding send is a claim
// that a live process is holding the operator's message; a daemon that has died holds nothing, and the
// row otherwise survives UNCONFIRMED_DROP_MS — an hour of a gray "queued" bubble for a message nobody
// will read, which the unqueue click cannot clear either. Observed 2026-08-11 on
// `in-codex-threads-tool-calls-ike`: receipted at 19:45:05.771, daemon dead 760ms later.
test("tailer: a broker daemon that dies holding a follow-up retires it instead of pinning it for an hour", () => {
  const h = harness()
  h.storage.upsertSession(row())
  h.storage.setBackend("t", "claude")
  h.storage.setClaudeRuntime("t", "broker")
  fixture(h.logDir, "sid", [IN_FLIGHT])
  const at = "2026-07-01T00:00:30.000Z"
  h.storage.setDeliveryLedger("t", JSON.stringify([
    { id: "d-live", text: "keep going", state: "enqueued", at, updatedAt: at },
    { id: "d-warn", text: "an older send frizz could not confirm", state: "unconfirmed", at, updatedAt: at },
  ]))
  const daemon = { alive: true }
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => false,
    sessionLogDir: h.logDir,
    brokerDaemonAlive: () => daemon.alive,
  })

  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick()
  const held = JSON.parse(h.storage.getSession("t")?.delivery_ledger ?? "[]") as Array<{ id: string }>
  assert.deepEqual(held.map((d) => d.id), ["d-live", "d-warn"], "a live daemon really is holding the send")

  daemon.alive = false
  const before = h.changes.n
  t.tick()
  const left = JSON.parse(h.storage.getSession("t")?.delivery_ledger ?? "[]") as Array<{ id: string }>
  assert.deepEqual(left.map((d) => d.id), ["d-warn"], "the stranded send goes; the unconfirmed warning the human may re-drive stays")
  assert.ok(h.changes.n > before, "retiring it marks the board dirty so the queue card comes back at once")
})

// The OTHER way a send outlives its own delivery: the daemon is alive and the message really did land,
// but the correlator could not attribute the record that carried it (2026-08-14, nub
// `idea-from-jdx-creator-of-mise` — two queued follow-ups submitted as one composed record, the first
// left `enqueued`). The ledger then claims the human's message is still in flight, which takes the thread
// OUT of the queue (board.ts hasFreshDelivery) for the full hour before UNCONFIRMED_DROP_MS: it answered,
// asked a fresh question, and showed a rested rail row with no card behind it the whole time.
//
// The wiring under test is that `finish()` reads the tail state AFTER this tick's lines are folded, so
// the send drops on the very pass that records the user turn superseding it — not a tick later.
test("tailer: a follow-up the correlator missed drops on the user turn that superseded it", () => {
  const h = harness()
  h.storage.upsertSession(row())
  h.storage.setBackend("t", "claude")
  fixture(h.logDir, "sid", [IN_FLIGHT, DONE])
  const at = "2026-07-01T00:00:30.000Z"
  h.storage.setDeliveryLedger("t", JSON.stringify([
    { id: "d-stranded", text: "text the channel mangled beyond recognition", state: "enqueued", at, updatedAt: at },
  ]))
  const t = makeTailer(h)

  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick() // prime: the only user turn on file is the one this send is answering
  assert.equal(t.get("t")?.lastUserAt, "2026-07-01T00:00:00.000Z")
  assert.equal(JSON.parse(h.storage.getSession("t")?.delivery_ledger ?? "[]").length, 1, "an unanswered send is left alone")

  // The delivery lands as a record the correlator cannot attribute to the item.
  appendFileSync(join(h.logDir, "sid.jsonl"), JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:45.000Z",
    message: { role: "user", content: "text the channel mangled — but into different WORDS" },
  }) + "\n")
  const before = h.changes.n
  t.tick()
  assert.equal(t.get("t")?.lastUserAt, "2026-07-01T00:00:45.000Z")
  assert.equal(h.storage.getSession("t")?.delivery_ledger, null, "the queue moved past it — it is not in flight")
  assert.ok(h.changes.n > before, "dropping it marks the board dirty so the queue card comes back at once")
})

// Nothing injected: a real stateDir, a real record file naming a real (dead) pid, the real default probe,
// through the real read→fold→view. The two tests above each prove one half — that paneDeadForRow consumes
// the answer, and that the answer is right — and they meet at a single line. This is the whole path.
test("tailer: end-to-end, a real broker record naming a dead pid clears the shell (nothing stubbed)", () => {
  const h = harness()
  const stateDir = mkdtempSync(join(tmpdir(), "brokere2e-"))
  mkdirSync(join(stateDir, "claude-broker"), { recursive: true })
  h.storage.upsertSession(row())
  h.storage.setBackend("t", "claude")
  h.storage.setClaudeRuntime("t", "broker")
  const shellLine = JSON.stringify(bashBg("toolu_sh", "Watch CI on PR 604", "nub scripts/ci-watch.ts --pr 604"))
  const ackLine = JSON.stringify(resultText("toolu_sh", "Command running in background with ID: b63. Output is being written to: /tmp/tasks/b63.output. You will be notified when it completes."))
  fixture(h.logDir, "sid", [IN_FLIGHT, shellLine, ackLine])
  const recordPath = claudeBrokerRecordPath(stateDir, "sid")
  writeFileSync(recordPath, JSON.stringify({ daemonPid: process.pid, sessionId: "sid" }))
  const t = createTailer({
    project: { cwdSlug: "x", stateDir } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => false,
    sessionLogDir: h.logDir,
    mtimeMs: () => Date.parse("2026-07-01T00:00:02.000Z"),
  })

  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick()
  assert.equal(t.get("t")?.bgShells.length, 1, "a record naming a running pid keeps the shell live")

  // The daemon dies outright: its record survives (nothing wrote an exit, nothing pruned it) and naming
  // a pid that no longer exists is the only trace left. This is the seven-hour phantom's exact on-disk
  // shape — measured on the maintainer's machine 2026-08-02 as 9 such records across 19.
  writeFileSync(recordPath, JSON.stringify({ daemonPid: 2 ** 30, sessionId: "sid" }))
  h.clock.ms += 60_000 // past BROKER_LIVENESS_TTL_MS, so the tick re-probes
  t.tick()
  assert.deepEqual(t.get("t")?.bgShells, [], "the shell clears without frizz ever stopping the session")
  assert.equal(h.storage.getSession("t")?.exited ?? 0, 0, "and without inventing a deliberate stop")

  rmSync(stateDir, { recursive: true, force: true })
})

// The SEAM the two tests around this one stub out: the real record read and the real pid probe. Injecting
// `brokerDaemonAlive` proves paneDeadForRow consumes the answer; only this proves the answer is right.
// Every case runs against a real file on disk and a real pid.
test("defaultBrokerDaemonAlive: reads a real record and probes a real pid, failing safe to ALIVE", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "brokerlive-"))
  mkdirSync(join(stateDir, "claude-broker"), { recursive: true })
  const project = { cwdSlug: "x", stateDir } as Project
  // A fresh probe per case: the real one memoises for BROKER_LIVENESS_TTL_MS, which would otherwise
  // serve case N-1's answer to case N.
  const probe = () => defaultBrokerDaemonAlive(project, () => Date.now())
  const write = (sessionId: string, body: string) =>
    writeFileSync(claudeBrokerRecordPath(stateDir, sessionId), body)

  write("live", JSON.stringify({ daemonPid: process.pid }))
  assert.equal(probe()("live"), true, "our own pid is alive")

  // A pid that cannot exist: kill(0) gives ESRCH, the one error that means "gone".
  write("dead", JSON.stringify({ daemonPid: 2 ** 30 }))
  assert.equal(probe()("dead"), false, "a record naming a vanished pid is a death frizz can prove")

  assert.equal(probe()("never-ran"), false, "no record at all ⇒ no daemon to discover")

  write("corrupt", "{ not json")
  assert.equal(probe()("corrupt"), true, "an unreadable record must NEVER be read as a death")

  write("pidless", JSON.stringify({ generation: "g" }))
  assert.equal(probe()("pidless"), true, "a record with no pid names nothing to probe — fail safe")

  // No stateDir is the narrow-fixture case, and the one that must reproduce the old behavior exactly.
  assert.equal(defaultBrokerDaemonAlive({ cwdSlug: "x" } as Project, () => Date.now())("live"), true)

  rmSync(stateDir, { recursive: true, force: true })
})

test("defaultBrokerDaemonAlive: memoises within the TTL and re-probes after it", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "brokerttl-"))
  mkdirSync(join(stateDir, "claude-broker"), { recursive: true })
  const path = claudeBrokerRecordPath(stateDir, "s")
  writeFileSync(path, JSON.stringify({ daemonPid: process.pid }))
  let ms = 1_000_000
  const alive = defaultBrokerDaemonAlive({ cwdSlug: "x", stateDir } as Project, () => ms)

  assert.equal(alive("s"), true)
  rmSync(path) // the record is gone, but the cached answer must still stand
  assert.equal(alive("s"), true, "within the TTL the tick pays no read and sees no change")
  ms += 5_001
  assert.equal(alive("s"), false, "past the TTL it re-probes and sees the daemon is gone")

  rmSync(stateDir, { recursive: true, force: true })
})

// `ownerGone` is the ONE authority the transcript producers read, and it has to answer for all three
// runtimes — the board's own shell list already does (bgShellViews drops them on paneDead), but the ops
// strip is a UNION of that list and the transcript's pending background cards, so dropping the board row
// only MOVES the phantom unless the transcript hears the same fact. Scoping that to broker rows, as the
// first cut did, left every NON-BROKER thread's dead-pane shells still rendering "running".
test("tailer: ownerGone answers for a pane death on a non-broker row, not just a dead broker daemon", () => {
  const h = harness()
  h.storage.upsertSession(row()) // a plain pre-broker row — no broker runtime
  fixture(h.logDir, "sid", [IN_FLIGHT])
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    sessionLogDir: h.logDir,
  })

  h.dead.v = false
  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick()
  assert.equal(t.ownerGone?.("t"), false, "a live pane owns its ops")

  h.dead.v = true
  t.tick()
  assert.equal(t.ownerGone?.("t"), true, "a dead pane is a dead owner, exactly as a dead daemon is")

  // A thread frizz has never tailed cannot be declared dead — the fail-safe every caller relies on.
  assert.equal(t.ownerGone?.("never-seen"), false, "an unknown slug is never reported gone")
})

// The guard on the fix above. A non-broker row has no broker record to read, and a probe that answered "dead"
// for one would empty its shells wholesale — the exact shape of the 2026-07-29 regression this file
// already pins from the other direction (a pane sniff wrongly applied to a headless row).
test("tailer: broker-daemon liveness is never consulted for a non-broker row", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const shellLine = JSON.stringify(bashBg("toolu_sh", "Watch CI on PR 604", "nub scripts/ci-watch.ts --pr 604"))
  const ackLine = JSON.stringify(resultText("toolu_sh", "Command running in background with ID: b63. Output is being written to: /tmp/tasks/b63.output. You will be notified when it completes."))
  fixture(h.logDir, "sid", [IN_FLIGHT, shellLine, ackLine])
  let asked = 0
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => false,
    sessionLogDir: h.logDir,
    mtimeMs: () => Date.parse("2026-07-01T00:00:02.000Z"),
    brokerDaemonAlive: () => { asked++; return false },
  })

  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick()
  assert.equal(asked, 0, "a non-broker row never asks about a broker daemon")
  assert.equal(t.get("t")?.bgShells.length, 1, "and its live shell is untouched")
})

test("tailer: a manual TaskStop clears a live background shell from the board view (real read→fold→view)", () => {
  // End-to-end through createTailer (file → parseLine → applyRecord → bgShellViews), the pipeline that
  // produced the phantom pulsing row: a shell TaskStop'd instead of allowed to exit had NO terminal
  // signal the tailer recognized, so bgShells reported it live until the pane died.
  const h = harness()
  h.storage.upsertSession(row())
  const shellLine = JSON.stringify(bashBg("toolu_sh", "Boot isolated stack", "nub scripts/adhoc-stack.mjs"))
  const ackLine = JSON.stringify(resultText("toolu_sh", "Command running in background with ID: ba3y11c3t. Output is being written to: /tmp/tasks/ba3y11c3t.output. You will be notified when it completes."))
  fixture(h.logDir, "sid", [IN_FLIGHT, shellLine, ackLine])
  const shellMtime = Date.parse("2026-07-01T00:00:02.000Z")
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v, // pane STAYS ALIVE — the stop, not pane death, must clear the row
    sessionLogDir: h.logDir,
    mtimeMs: () => shellMtime,
  })

  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick()
  assert.deepEqual(t.get("t")?.bgShells, [{ id: "toolu_sh", label: "Boot isolated stack", startedAt: "2026-07-01T00:00:01.000Z", state: "running", stoppable: true, taskId: "ba3y11c3t", lastActivityAt: "2026-07-01T00:00:02.000Z" }])

  // The worker TaskStops the shell (pane still alive). Its structured result is the terminal signal.
  appendFileSync(join(h.logDir, "sid.jsonl"), JSON.stringify(taskStopResult("ba3y11c3t", "nub scripts/adhoc-stack.mjs")) + "\n")
  const before = h.changes.n
  t.tick()
  assert.deepEqual(t.get("t")?.bgShells, [], "a manual TaskStop clears the live shell — no phantom pulsing row")
  assert.ok(h.changes.n > before, "the shell vanishing marks the board dirty")
})

test("tailer: subAgent() resolves a LIVE child, then its RETAINED completion, then undefined for unknown", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, JSON.stringify(dispatch("toolu_bg", "child")), JSON.stringify(launch("toolu_bg", "/tmp/tasks/abc123.output"))])
  const childMtime = Date.parse("2026-07-01T00:00:02.000Z")
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    sessionLogDir: h.logDir,
    mtimeMs: () => childMtime,
  })
  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z") // < 5min since child mtime → running
  t.tick()
  // `direct` = this session's OWN live Agent-tool child, i.e. the one case a steer can be addressed
  // at. Everything else the lookup can resolve is readable but not addressable.
  assert.deepEqual(t.subAgent("t", "toolu_bg"), { outputFile: "/tmp/tasks/abc123.output", state: "running", direct: true, taskId: "abc123", startedAt: "2026-07-01T00:00:01.000Z" })
  assert.equal(t.subAgent("t", "toolu_unknown"), undefined, "an id we never dispatched → undefined (router maps to gone)")

  // completion retains the child as "done" — still resolvable for review after it leaves the live set
  appendFileSync(join(h.logDir, "sid.jsonl"), JSON.stringify(taskNotification("toolu_bg", "completed")) + "\n")
  t.tick()
  assert.deepEqual(t.get("t")?.subAgents, [], "gone from the LIVE surface")
  // RETAINED, so still readable — but never steerable: a finished child cannot receive anything, and
  // addressing one MISDELIVERS to the parent's main thread rather than failing (measured live).
  assert.deepEqual(t.subAgent("t", "toolu_bg"), {
    outputFile: "/tmp/tasks/abc123.output",
    state: "done",
    direct: false,
    startedAt: "2026-07-01T00:00:01.000Z",
    finishedAt: "2026-07-01T00:00:09.000Z",
    outcome: "completed",
  })
})

test("tailer: a resolved-but-missing output file (deleted child transcript) degrades to stale", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, JSON.stringify(dispatch("toolu_bg", "child")), JSON.stringify(launch("toolu_bg", "/tmp/tasks/gone.output"))])
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    sessionLogDir: h.logDir,
    mtimeMs: () => undefined, // the child's transcript no longer stats (deleted / bridged elsewhere)
  })
  t.tick()
  // outputFile was resolved from the launch result, so an un-stattable path is a missed completion → stale
  assert.equal(t.get("t")?.subAgents[0].state, "stale")
})

// A background shell is DISPLAY-ONLY and never ages out on a clock: `run_in_background` can't tell a
// CI watcher (ends soon) from a vite dev server (runs forever), so no age is a correct age. It stays
// "running" while tracked + pane-alive, however long it's quiet, and clears only on its real terminal
// signal (task-notification / TaskStop) or pane death. Nothing here can bury a thread — a shell no
// longer excuses a rest (that's board.ts hasLiveBackgroundWork, now sub-agent-only).
test("tailer: a background shell stays running however long it is quiet; only its terminal signal clears it", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [
    IN_FLIGHT,
    JSON.stringify(bashBg("toolu_srv", "Run vite dev server", "npx vite --port 5231")),
    JSON.stringify(resultText("toolu_srv", "Command running in background with ID: ba3y11c3t. Output is being written to: /tmp/tasks/ba3y11c3t.output. You will be notified when it completes.")),
  ])
  const t = makeTailer(h, { mtimeMs: () => Date.parse("2026-07-01T00:00:02.000Z") }) // output never advances

  h.clock.ms = Date.parse("2026-07-01T00:40:00.000Z") // 40min quiet — an ordinary CI wait
  t.tick()
  assert.deepEqual(t.get("t")?.bgShells, [{ id: "toolu_srv", label: "Run vite dev server", startedAt: "2026-07-01T00:00:01.000Z", state: "running", stoppable: true, taskId: "ba3y11c3t", lastActivityAt: "2026-07-01T00:00:02.000Z" }])

  h.clock.ms = Date.parse("2026-07-01T08:00:00.000Z") // 8h quiet — a dev server left running; still "running"
  t.tick()
  assert.equal(t.get("t")?.bgShells[0].state, "running", "no age-based staleness for shells")

  // The real terminal signal still clears it outright.
  appendFileSync(join(h.logDir, "sid.jsonl"), JSON.stringify(taskNotification("toolu_srv", "completed")) + "\n")
  t.tick()
  assert.deepEqual(t.get("t")?.bgShells, [])
  assert.deepEqual(t.backgroundShell?.("t", "toolu_srv"), { command: "npx vite --port 5231", outputFile: "/tmp/tasks/ba3y11c3t.output", state: "done" })
})

// ---- derived pending-question detection (chat-only ```question the worker didn't encode as blocked) ----

test("hasQuestionBlock: detects a fenced ```question block; rejects prose and a plain code fence", () => {
  assert.equal(hasQuestionBlock("intro\n\n```question\nWhich one?\n\n- A. x\n- B. y\n```"), true)
  assert.equal(hasQuestionBlock("```question danger\nShip it?\n```"), true) // kind info-string
  // Multi-token info-strings the prompt teaches (```question multi danger) — plus the RETIRED
  // `approval` token, which must still register as an ask so a legacy transcript is not silently
  // demoted (the check is on SHAPE, never on the token set) —
  // the old single-token grammar silently missed them and broke the pendingQuestion safety net.
  assert.equal(hasQuestionBlock("```question multi danger\nForce-merge?\n\n- A. Do it\n```"), true)
  assert.equal(hasQuestionBlock("```question approval danger\nForce-merge?\n\n- A. Do it\n```"), true)
  assert.equal(hasQuestionBlock("```question multi\nWhich?\n\n- A. x\n- B. y\n```"), true)
  assert.equal(hasQuestionBlock("just prose, no fence at all"), false)
  assert.equal(hasQuestionBlock("```js\nconst q = 'question'\n```"), false) // a plain code fence is not a question
  assert.equal(hasQuestionBlock(undefined), false)
  // A worker DOCUMENTING the protocol wraps its sample in an outer ```` fence. That is a quotation, not
  // an ask — flagging it parks the thread in "awaiting you" over an example.
  const t4 = "`".repeat(4)
  assert.equal(hasQuestionBlock(`Write it like this:\n\n${t4}\n\`\`\`question\nShip it?\n\n- A. Yes\n\`\`\`\n${t4}\n\nThat's the grammar.`), false)
  // …and a real ask alongside the quoted sample still counts.
  assert.equal(
    hasQuestionBlock(`${t4}\n\`\`\`question\nExample?\n\`\`\`\n${t4}\n\n\`\`\`question\nSo: ship it?\n\n- A. Yes\n\`\`\``),
    true,
  )
})

test("applyRecord: a ```question block sets lastAssistantHasQuestion; a real user reply clears it", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:02.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "context\n\n```question\nWhich default?\n\n- A. Foo\n- B. Bar\n```" }] } })
  assert.equal(s.lastAssistantHasQuestion, true)
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:20.000Z", message: { content: "Answers:\n1. A" } })
  assert.equal(s.lastAssistantHasQuestion, false, "a user reply supersedes the pending question")
})

test("tailer: derives pendingQuestion at rest, then clears it on the user's answer", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const QUESTION = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:02.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "ctx\n\n```question\nWhich default?\n\n- A. Foo\n- B. Bar\n```" }] } })
  fixture(h.logDir, "sid", [IN_FLIGHT, QUESTION])
  const t = makeTailer(h)
  h.clock.ms = Date.parse("2026-07-01T00:00:10.000Z")
  t.tick() // prime: idle with an unanswered chat question
  assert.equal(t.get("t")?.turn, "idle")
  assert.equal(t.get("t")?.pendingQuestion, true)

  const ANSWER = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:20.000Z", message: { role: "user", content: "Answers:\n1. A" } })
  appendFileSync(join(h.logDir, "sid.jsonl"), ANSWER + "\n")
  t.tick()
  assert.equal(t.get("t")?.pendingQuestion, false, "the answer flips the turn in-flight and clears the flag")
})

// ---- chronological listing key: newest REAL user interaction (tool_results excluded) ----

test("isRealUserMessage: a typed prompt / text message counts; a tool_result-only record does not", () => {
  assert.equal(isRealUserMessage("go do the thing"), true) // a typed prompt (string content)
  assert.equal(isRealUserMessage([{ type: "text", text: "hi" }]), true) // a text message
  assert.equal(isRealUserMessage([{ type: "text", text: "note" }, { type: "tool_result", tool_use_id: "x" }]), true) // mixed → real
  assert.equal(isRealUserMessage([{ type: "tool_result", tool_use_id: "x", content: "ok" }]), false) // tool exchange only → not
  assert.equal(isRealUserMessage([]), false)
  assert.equal(isRealUserMessage(undefined), false)
})

test("tailer: lastUserAt tracks the newest REAL user message; a tool_result does not advance it", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL]) // dispatch prompt "go" @ 00:00:00, then a tool_use turn
  const t = makeTailer(h)
  t.tick() // prime
  assert.equal(t.get("t")?.lastUserAt, "2026-07-01T00:00:00.000Z", "the dispatch prompt is the first interaction")

  // a tool_result is a USER-role record but AGENT activity — must not bump the interaction key
  const TOOLRESULT = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:05.000Z", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } })
  appendFileSync(join(h.logDir, "sid.jsonl"), TOOLRESULT + "\n")
  t.tick()
  assert.equal(t.get("t")?.lastUserAt, "2026-07-01T00:00:00.000Z", "a tool_result does not advance lastUserAt")

  // a real steer/answer does
  const STEER = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:30.000Z", message: { role: "user", content: "actually, do X instead" } })
  appendFileSync(join(h.logDir, "sid.jsonl"), STEER + "\n")
  t.tick()
  assert.equal(t.get("t")?.lastUserAt, "2026-07-01T00:00:30.000Z", "a real user steer bumps the interaction key")
})

// ---- integration: tick loop over a fixture transcript ----

// A couple of real-shaped lines (copied from the corpus schema) plus sidecar noise.
const IN_FLIGHT = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { role: "user", content: "go" } })
const TOOL = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash" }] } })
const DONE = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:02.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "all done" }] } })
const TITLE = JSON.stringify({ type: "ai-title", aiTitle: "x" })
const PERMISSION_AUTO = JSON.stringify({ type: "permission-mode", permissionMode: "auto", sessionId: "sid" })
const PERMISSION_DEFAULT = JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: "sid" })
const PERMISSION_BYPASS = JSON.stringify({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId: "sid" })

function fixture(dir: string, sessionId: string, lines: string[]) {
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => l + "\n").join(""))
}

interface Harness {
  storage: Storage
  bus: Bus
  events: ServerEvent[]
  logDir: string
  changes: { n: number }
  clock: { ms: number }
  dead: { v: boolean }
}

function harness(): Harness {
  // The log dir is nested one level, mirroring the real `~/.claude/projects/<cwdSlug>/` layout, because
  // the tailer's cross-dir recovery (discover.ts discoverTranscriptDir) sweeps `dirname(logDir)` for a
  // transcript stranded by a renamed project. Rooted straight at `tmpdir()` its siblings would be every
  // other test's fixture dir, and a case asserting "no transcript → degraded" would find some other
  // case's `sid.jsonl` and bind it. Each harness gets its OWN projects root, so the sweep sees only
  // what the case put there.
  const dir = join(tmp("frizz-tail-"), "-a-project")
  mkdirSync(dir, { recursive: true })
  const storage = createStorage(join(dir, "ui.db"), "p")
  const bus = new Bus()
  const events: ServerEvent[] = []
  bus.subscribe((e) => events.push(e))
  return { storage, bus, events, logDir: dir, changes: { n: 0 }, clock: { ms: 1000 }, dead: { v: false } }
}

function makeTailer(h: Harness, over: Partial<Parameters<typeof createTailer>[0]> = {}) {
  return createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    sessionLogDir: h.logDir,
    ...over,
  })
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  const result = { slug: "t", session_id: "sid", thread_name: "frizz-t", spawned_at: "2026-07-01T00:00:00.000Z", last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: null, meta: null, seen_at: null, transcript_id: null, ...over }
  if (over.slug !== undefined && over.thread_name === undefined) result.thread_name = `frizz-${result.slug}`
  return result
}

test("tailer: primes an already-finished transcript WITHOUT a turn-done notify", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE, TITLE])
  const t = makeTailer(h)

  t.tick() // prime
  assert.equal(h.events.length, 0, "boot prime must not notify")
  assert.equal(h.storage.getSession("t")?.unread, 0)
  const tele = t.get("t")
  assert.equal(tele?.turn, "idle")
  assert.equal(tele?.lastAssistant, "all done")
  assert.equal(tele?.lastActivityAt, "2026-07-01T00:00:02.000Z")
  assert.equal(tele?.aiTitle, "x") // ai-title sidecar surfaces through telemetry
})

// THE FREEZE, THROUGH THE TICK. The shape that produced it verbatim: an unresolved tool_use, its
// tool_result, then Claude's own abort receipt and nothing more, ever. The row spun in the Active band
// for 23 hours behind an idle worker until the operator asked what was happening (2026-08-23). The
// tick is where it has to settle — computeTurn alone is covered above, but `runtime: "running"` is
// derived from the turn this loop publishes.
const INTERRUPTED = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } })

test("tailer: a transcript abandoned on an interrupt receipt settles through the tick", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL, INTERRUPTED])
  h.clock.ms = Date.parse("2026-07-01T00:00:04.000Z") // 2s on — a "send now" prompt would still be landing
  const t = makeTailer(h)
  t.tick()
  assert.equal(t.get("t")?.turn, "in-flight", "the push-through window is held open")
  h.clock.ms = Date.parse("2026-07-01T00:00:20.000Z") // …and nothing ever came
  t.tick()
  assert.equal(t.get("t")?.turn, "idle", "an abandoned interrupt is a stopped thread, not a permanent spinner")
})

// THE ASK SURVIVES THE MACHINERY, THROUGH THE TICK. The reported shape verbatim: the agent rests on a
// ```question, then frizz's own plumbing lands one record the CHAT does not render — a background
// child's <task-notification>. That record re-opens the turn, and it used to take the question with it,
// so the board reported {pendingQuestion:false, runtime:"running"} for a thread whose chat was still
// drawing an answerable card with a Send answers button (maintainer 2026-08-24).
const ASK = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:02.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Verdict: duplicate.\n\n```question\nHow should PRD-8263 be dispatched?\n\n- A. Fix now (recommended)\n- B. File only\n```" }] } })
const NOTIFICATION = JSON.stringify({ type: "user", promptSource: "system", timestamp: "2026-07-01T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>" }] } })

test("tailer: a record the chat never draws cannot answer the human's question", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, ASK])
  h.clock.ms = Date.parse("2026-07-01T00:00:10.000Z")
  const t = makeTailer(h)
  t.tick()
  assert.equal(t.get("t")?.turn, "idle")
  assert.equal(t.get("t")?.pendingQuestion, true, "the agent asked and nobody has answered")

  fixture(h.logDir, "sid", [IN_FLIGHT, ASK, NOTIFICATION]) // a child returns; frizz injects the receipt
  h.clock.ms = Date.parse("2026-07-01T00:00:11.000Z")
  t.tick()
  assert.equal(t.get("t")?.turn, "in-flight", "the notification DOES re-invoke the agent — that part was never wrong")
  assert.equal(t.get("t")?.pendingQuestion, true, "…and the question it never answered still stands")

  // Only the human discharges it. (The agent's own next message replaces it — covered by the fence
  // recompute on every assistant text.)
  const ANSWER = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:12.000Z", message: { role: "user", content: "A" } })
  fixture(h.logDir, "sid", [IN_FLIGHT, ASK, NOTIFICATION, ANSWER])
  h.clock.ms = Date.parse("2026-07-01T00:00:13.000Z")
  t.tick()
  assert.equal(t.get("t")?.pendingQuestion, false, "answered — the row leaves the queue")
})

// ---- PermissionRequest marker (structured perm-blocked signal; primary over the pane regex) ----

// An in-flight turn: user "go" then an unresolved Bash tool_use. lastActivityAt = the tool_use at
// 00:00:01. A worker parked on a permission prompt writes no further records, so a marker stamped
// AFTER that (00:00:05) is an active block; one stamped before it is already superseded.
const permMarker = (at: string, over: Record<string, unknown> = {}) => ({ slug: "t", tool: "Bash", promptId: "p1", permissionMode: "default", at, ...over })

test("tailer: a fresh PermissionRequest marker sets permPrompt immediately (no quiet-gate delay)", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL]) // in-flight, unresolved tool_use
  // Only 0.5s since the last record. The pane-sniff fallback this replaced was gated on 4s of quiet,
  // so it could not have fired here at all; the marker must.
  h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z")
  const t = makeTailer(h, { readPermMarker: () => permMarker("2026-07-01T00:00:05.000Z") })
  t.tick()
  assert.equal(t.get("t")?.turn, "in-flight")
  assert.equal(t.get("t")?.permPrompt, true, "the structured marker blocks the thread on the human")
})

// The policy hook (cc-worker/hooks/perm-policy.mjs) records what it DID with the request. A request it
// resolved itself never blocked a human, so it must not card as "Needs you" — otherwise every
// auto-approval would flash the thread onto the queue for the tick before the transcript advances.
for (const decision of ["allow", "deny"] as const) {
  test(`tailer: a policy-${decision} marker is NOT a human block (nobody was ever asked)`, () => {
    const h = harness()
    h.storage.upsertSession(row())
    fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
    h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z") // fresh marker, would block if deferred
    const t = makeTailer(h, { readPermMarker: () => permMarker("2026-07-01T00:00:05.000Z", { decision }) })
    t.tick()
    assert.equal(t.get("t")?.permPrompt, false, `a ${decision} decision resolved the request unattended`)
  })
}

test("tailer: a policy-defer marker IS a human block (the prompt was left for a person)", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z")
  const t = makeTailer(h, { readPermMarker: () => permMarker("2026-07-01T00:00:05.000Z", { decision: "defer" }) })
  t.tick()
  assert.equal(t.get("t")?.permPrompt, true)
})

// BACK-COMPAT: markers written by the observe-only plugin build carry no `decision`. Those must keep
// blocking exactly as they always did — falling back to "already approved" would hide a real stall.
test("tailer: a decision-less marker (older plugin build) still blocks", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z")
  const t = makeTailer(h, { readPermMarker: () => permMarker("2026-07-01T00:00:05.000Z") })
  t.tick()
  assert.equal(t.get("t")?.permPrompt, true, "no decision ⇒ treat as deferred, exactly as before")
})

// An approval is NOT retained. It used to be, so the dashboard could say what frizz approved on the
// human's behalf — but permPolicy has no clear, so the note it fed sat at the bottom of the thread
// forever, naming one routine command as though it were the thread's standing condition. It blocks
// nobody and answered no question anyone was asking; only the denial half survives.
test("tailer: an allow decision is NOT retained (it would pin a stale note to the thread forever)", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z")
  const t = makeTailer(h, {
    readPermMarker: () => permMarker("2026-07-01T00:00:05.000Z", {
      decision: "allow", rule: "worker-autonomy", reason: "unattended", command: "git push origin HEAD:main",
    }),
  })
  t.tick()
  assert.equal(t.get("t")?.permPrompt, false, "an approval never blocks")
  assert.equal(t.get("t")?.permPolicy, undefined, "nothing to display, and nothing to get stuck")
  assert.equal(t.get("t")?.permDenies, undefined, "an approval is not a denial")
})

// The retained denial must not be WIPED by the routine approvals that follow it either: the marker
// file holds one decision, so the next auto-approved command overwrites it, and re-deriving state from
// that marker would silently drop the refusal the human still needs to see.
test("tailer: a later allow does not clear a retained denial", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z")
  let marker = permMarker("2026-07-01T00:00:05.000Z", {
    decision: "deny", rule: "catastrophic-delete", reason: "unrecoverable", command: "rm -rf ~",
  })
  const t = makeTailer(h, { readPermMarker: () => marker })
  t.tick()
  assert.equal(t.get("t")?.permPolicy?.decision, "deny")
  marker = permMarker("2026-07-01T00:00:06.000Z", {
    decision: "allow", rule: "worker-autonomy", reason: "unattended", command: "git status --short",
  })
  t.tick()
  assert.equal(t.get("t")?.permPolicy?.rule, "catastrophic-delete", "the denial still stands")
  assert.equal(t.get("t")?.permDenies, 1)
})

// SAME stale-generation rule the BLOCK verdict has always had, applied to the retained denial. The
// marker file is durable and is never deleted — nothing unlinks perm-requests/<slug>.json — so a
// denial from a PREVIOUS run of this thread is still sitting on disk when it is re-dispatched. The
// fresh TailState has no permPolicy to dedupe against, so without this guard the first in-flight tick
// of the new generation re-adopts an ancient refusal and cards it as if it had just happened.
test("tailer: a denial predating the current spawn is NOT re-adopted by the new generation", () => {
  const h = harness()
  h.storage.upsertSession(row({ spawned_at: "2026-07-01T00:00:03.000Z" })) // re-dispatched at :03
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  h.clock.ms = Date.parse("2026-07-01T00:00:03.500Z")
  const t = makeTailer(h, {
    readPermMarker: () => permMarker("2026-07-01T00:00:02.000Z", { // prior gen
      decision: "deny", rule: "catastrophic-delete", reason: "unrecoverable", command: "rm -rf ~",
    }),
  })
  t.tick()
  assert.equal(t.get("t")?.permPolicy, undefined, "a previous run's refusal is not this run's")
  assert.equal(t.get("t")?.permDenies, undefined, "and it must not inflate the denial count either")
})

// EVERY live Claude thread is claude_runtime="broker" ⇒ isHeadlessRow, and the steady tick's marker
// read used to sit inside `if (!isHeadlessRow(row))`. So the marker was consulted exactly once, at
// PRIME — meaning a block or a denial that began after boot was never seen at all, and one that was
// already on disk surfaced at the next server restart instead. That is the "just showed up randomly"
// half of the original report. The guard's own comment justifies itself entirely on pane capture, and
// sniffPane no longer captures anything: its remaining marker path "always worked headlessly".
test("tailer: a headless broker row sees a denial that lands AFTER prime", () => {
  const h = harness()
  h.storage.upsertSession(row({ backend: "claude" }))
  h.storage.setClaudeRuntime("t", "broker")
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z")
  let marker: ReturnType<typeof permMarker> | undefined
  const t = makeTailer(h, { readPermMarker: () => marker })
  t.tick() // prime, with nothing on disk yet
  assert.equal(t.get("t")?.permPolicy, undefined, "nothing to see at prime")

  marker = permMarker("2026-07-01T00:00:05.000Z", {
    decision: "deny", rule: "catastrophic-delete", reason: "unrecoverable", command: "rm -rf ~",
  })
  t.tick()
  assert.equal(t.get("t")?.permPolicy?.rule, "catastrophic-delete", "the refusal must not wait for a restart")
  assert.equal(t.get("t")?.permDenies, 1)
})

// The same gap, on the BLOCK verdict: a headless thread parked on a deferred request must card as
// "Needs you" on the tick it happens, not at the next boot.
test("tailer: a headless broker row blocks on a deferred marker that lands AFTER prime", () => {
  const h = harness()
  h.storage.upsertSession(row({ backend: "claude" }))
  h.storage.setClaudeRuntime("t", "broker")
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z")
  let marker: ReturnType<typeof permMarker> | undefined
  const t = makeTailer(h, { readPermMarker: () => marker })
  t.tick()
  assert.equal(t.get("t")?.permPrompt, false)

  marker = permMarker("2026-07-01T00:00:05.000Z", { decision: "defer" })
  t.tick()
  assert.equal(t.get("t")?.permPrompt, true, "a live block on a headless row is still a block")
})

test("tailer: a deny decision is retained and counted", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z")
  const t = makeTailer(h, {
    readPermMarker: () => permMarker("2026-07-01T00:00:05.000Z", {
      decision: "deny", rule: "catastrophic-delete", reason: "unrecoverable", command: "rm -rf ~",
    }),
  })
  t.tick()
  assert.equal(t.get("t")?.permPrompt, false, "a policy denial never blocks a human either")
  assert.equal(t.get("t")?.permPolicy?.decision, "deny")
  assert.equal(t.get("t")?.permDenies, 1)
  // Re-ticking the SAME marker must not inflate the count — the tick rate would otherwise turn one
  // denial into dozens.
  t.tick()
  assert.equal(t.get("t")?.permDenies, 1, "the same decision is counted once, not once per tick")
})

// A DEFERRED request is already fully represented by permPrompt/"Needs you". Repeating it as a policy
// note would double-report the same event in two different voices.
test("tailer: a deferred request produces no policy note", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z")
  const t = makeTailer(h, { readPermMarker: () => permMarker("2026-07-01T00:00:05.000Z", { decision: "defer" }) })
  t.tick()
  assert.equal(t.get("t")?.permPrompt, true)
  assert.equal(t.get("t")?.permPolicy, undefined)
})

test("markerDecision: unrecognized values degrade to defer, never to allow", () => {
  assert.equal(markerDecision({ decision: undefined }), "defer")
  assert.equal(markerDecision({ decision: "wat" as never }), "defer")
  assert.equal(markerDecision({ decision: "allow" }), "allow")
  assert.equal(markerDecision({ decision: "deny" }), "deny")
})

test("tailer: a marker older than the last transcript activity is superseded (request resolved)", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z")
  const t = makeTailer(h, { readPermMarker: () => permMarker("2026-07-01T00:00:00.500Z") })
  t.tick()
  assert.equal(t.get("t")?.permPrompt, false, "a marker behind the transcript is a resolved request")
})

test("tailer: an idle turn never consults the marker (a real block is always mid-tool_use)", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE]) // turn ended
  let reads = 0
  const t = makeTailer(h, { readPermMarker: () => { reads++; return permMarker("2026-07-01T00:00:09.000Z") } })
  t.tick()
  assert.equal(t.get("t")?.turn, "idle")
  assert.equal(t.get("t")?.permPrompt, false)
  assert.equal(reads, 0, "an idle turn short-circuits before the marker read")
})

test("tailer: a codex row never consults the Claude marker", () => {
  const h = harness()
  h.storage.upsertSession(row())
  h.storage.setBackend("t", "codex") // the shared upsert never writes backend; use the dedicated setter
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z")
  let reads = 0
  const t = makeTailer(h, { readPermMarker: () => { reads++; return permMarker("2026-07-01T00:00:05.000Z") } })
  t.tick()
  assert.equal(reads, 0, "codex owns native input detection; the Claude marker is skipped")
})

// A marker written BEFORE this generation's spawn is stale — a worker killed while blocked, then
// resumed, must not flash Needs-you off the prior block's marker while the resume boots.
test("tailer: a marker predating the current spawn is stale (resume of a killed-while-blocked thread)", () => {
  const h = harness()
  h.storage.upsertSession(row({ spawned_at: "2026-07-01T00:00:03.000Z" })) // resumed at :03
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL]) // replayed old transcript, lastActivity :01
  h.clock.ms = Date.parse("2026-07-01T00:00:03.500Z")
  const t = makeTailer(h, { readPermMarker: () => permMarker("2026-07-01T00:00:02.000Z") }) // prior gen
  t.tick()
  assert.equal(t.get("t")?.permPrompt, false, "a pre-spawn marker belongs to an already-ended block")
})

// Exercises the REAL defaultReadPermMarker + isPermMarker (no injected reader) over a marker file on
// disk at the project stateDir — the exact production read path the hook writes to.
test("tailer: the default reader round-trips a real on-disk marker (blocked → superseded)", () => {
  const h = harness()
  const stateDir = tmp("frizz-state-")
  mkdirSync(join(stateDir, "perm-requests"), { recursive: true })
  const project = { cwdSlug: "x", stateDir } as Project
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL]) // in-flight, lastActivity :01
  writeFileSync(permMarkerPath(project, "t"), JSON.stringify(permMarker("2026-07-01T00:00:05.000Z")))
  h.clock.ms = Date.parse("2026-07-01T00:00:01.500Z")
  // No readPermMarker injected → the real defaultReadPermMarker reads the file above.
  const t = makeTailer(h, { project })
  t.tick()
  assert.equal(t.get("t")?.permPrompt, true, "the real reader surfaces the on-disk marker")

  // Resolution appends a record AFTER the marker (:09 > :05) → superseded. Same IN_FLIGHT/TOOL prefix
  // keeps the tailer's byte offset valid; the new trailing line is the only thing consumed.
  const resolved = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:09.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } })
  writeFileSync(join(h.logDir, "sid.jsonl"), [IN_FLIGHT, TOOL, resolved].map((l) => l + "\n").join(""))
  t.tick()
  assert.equal(t.get("t")?.permPrompt, false, "a transcript record after the marker supersedes it")
})

test("tailer rejects a stale row snapshot without name-dead checks", () => {
  const h = harness()
  const stale = row({ session_id: "owner-a", runtime_generation: 4 })
  h.storage.upsertSession(stale)
  h.storage.upsertSession(row({ session_id: "owner-b", runtime_generation: 0 }))
  fixture(h.logDir, stale.session_id, [IN_FLIGHT])
  const staleStorage = new Proxy(h.storage, {
    get(target, property, receiver) {
      if (property === "allSessions") return () => [stale]
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  let nameDeadChecks = 0
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: staleStorage,
    bus: h.bus,
    onChange: () => {},
    now: () => h.clock.ms,
    paneDead: () => { nameDeadChecks++; return false },
    sessionLogDir: h.logDir,
  })
  t.tick()
  h.clock.ms += 10_000
  t.tick()
  assert.equal(nameDeadChecks, 0)
  assert.equal(t.get(stale.slug), undefined, "cached telemetry for stale A is never exposed under replacement B")
})

test("tailer: Claude permission mode initializes from the transcript", () => {
  const h = harness()
  h.storage.upsertSession(row({ backend: "claude", permission_mode: null }))
  fixture(h.logDir, "sid", [PERMISSION_AUTO, IN_FLIGHT, DONE])
  const t = makeTailer(h)
  t.tick()
  assert.equal(t.get("t")?.permissionMode, "auto")
  assert.equal(h.storage.getSession("t")?.permission_mode, "auto", "hard reload starts from the observed runtime mode")

  // The pane-footer confirmation poll that used to drive a live transition went with the pre-broker
  // transport; a headless row takes its mode from the transcript sidecar alone.
  appendFileSync(join(h.logDir, "sid.jsonl"), PERMISSION_BYPASS + "\n")
  t.tick()
  assert.equal(t.get("t")?.permissionMode, "bypassPermissions")
})

test("tailer: restart replay cannot clobber a newer persisted Claude reattach mode with an old sidecar", () => {
  const h = harness()
  h.storage.upsertSession(row({ backend: "claude", permission_mode: "bypassPermissions" }))
  fixture(h.logDir, "sid", [PERMISSION_AUTO, IN_FLIGHT, DONE])
  const t = makeTailer(h)
  t.tick()
  assert.equal(t.get("t")?.permissionMode, "auto", "the historical fold remains observable")
  assert.equal(h.storage.getSession("t")?.permission_mode, "bypassPermissions", "the exact newer launch flag remains authoritative")
})

test("tailer: a new runtime generation resets its byte cursor before reading replacement output", () => {
  const h = harness()
  h.storage.upsertSession(row({ backend: "claude", permission_mode: "auto" }))
  fixture(h.logDir, "sid", [IN_FLIGHT, DONE])
  const t = makeTailer(h)
  t.tick()
  assert.equal(t.get("t")?.lastAssistant, "all done")

  const saved = h.storage.getSession("t")!
  assert.equal(
    h.storage.beginRuntimeGeneration(
      "t",
      { sessionId: saved.session_id, generation: saved.runtime_generation ?? 0, permissionPending: null },
      "2026-07-01T00:00:03.000Z",
    ),
    1,
  )
  const replacementText = "replacement generation output is deliberately longer than the old transcript cursor"
  fixture(h.logDir, "sid", [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-01T00:00:04.000Z",
      message: { stop_reason: "end_turn", content: [{ type: "text", text: replacementText }] },
    }),
  ])
  t.tick()
  assert.equal(t.get("t")?.lastAssistant, replacementText)
  assert.equal(h.events.length, 0, "generation replacement primes silently instead of emitting historical completion")
})

test("tailer: a permanently mismatched Claude sidecar expires without a write/change hot loop", () => {
  const h = harness()
  h.storage.upsertSession(row({ backend: "claude", permission_mode: "bypassPermissions" }))
  fixture(h.logDir, "sid", [PERMISSION_BYPASS, IN_FLIGHT, DONE])
  const t = makeTailer(h)
  t.tick()

  let writes = 0
  const persistObserved = h.storage.setObservedPermissionIfCurrent.bind(h.storage)
  h.storage.setObservedPermissionIfCurrent = (...args) => {
    writes++
    return persistObserved(...args)
  }
  appendFileSync(join(h.logDir, "sid.jsonl"), PERMISSION_DEFAULT + "\n")
  t.tick() // arrival poll: old footer still wins
  t.tick() // redraw opportunity one
  t.tick() // redraw opportunity two: stable mismatch expires

  const changesAfterExpiry = h.changes.n
  t.tick()
  t.tick()
  assert.equal(writes, 0, "an unchanged authoritative footer never causes a SQLite write")
  assert.equal(h.changes.n, changesAfterExpiry, "expired candidates stop producing board changes")
  assert.equal(h.storage.getSession("t")?.permission_mode, "bypassPermissions")
})

test("tailer: in-flight → idle fires exactly one turn-done + sets unread", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL]) // mid-turn
  const t = makeTailer(h)

  t.tick() // prime: in-flight
  assert.equal(t.get("t")?.turn, "in-flight")
  assert.equal(h.events.length, 0)

  appendFileSync(join(h.logDir, "sid.jsonl"), DONE + "\n")
  t.tick() // turn completes
  const notifies = h.events.filter((e) => e.type === "notify")
  assert.equal(notifies.length, 1)
  assert.equal(notifies[0].type === "notify" && notifies[0].kind, "turn-done")
  assert.equal(notifies[0].type === "notify" && notifies[0].body, "all done")
  assert.equal(h.storage.getSession("t")?.unread, 1)

  t.tick() // no new bytes → no duplicate notify (dedupe by transition)
  assert.equal(h.events.filter((e) => e.type === "notify").length, 1)
})

// A TURN THAT ENDED WHILE FRIZZ WAS NOT WATCHING IS STILL A REST.
//
// `rested_at` was written by `onTurnDone` alone, which fires on the LIVE in-flight → idle edge. Prime
// has no edge — it folds a whole transcript and adopts the turn it finds — so a turn that completed
// while the server was down was never recorded as a rest at all, and never would be: prime runs once
// per session per process. A worker is a detached broker daemon that keeps working across a frizz
// restart by design, so this is the ordinary case on every bounce, not an edge.
//
// The column being wrong is not cosmetic: `snoozeAwaitingBackground` (router.ts) refuses a row with a
// null `rested_at` — "This thread is not at rest; nothing to snooze" — and `bgSnoozeArmed` (board.ts)
// can never arm one. Found 2026-08-25 on the maintainer's own board: a thread that ended its turn with
// a ```question fence carried `turn: "idle"` and `rested_at: NULL` after a restart, alone among eleven
// live threads.
test("tailer: a prime that lands on a finished turn stamps rested_at (the rest is a FACT, not an event)", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE]) // the whole turn completed while nothing was watching
  const t = makeTailer(h)

  t.tick() // prime
  assert.equal(t.get("t")?.turn, "idle")
  assert.equal(
    h.storage.getSession("t")?.rested_at,
    "2026-07-01T00:00:02.000Z",
    "the rest instant is the folded end-of-turn record, exactly as onTurnDone would have stamped it",
  )
  // ...and the EVENT stays suppressed. A rebind can bring back hundreds of historical transcripts on
  // one tick; a notify each would be hundreds of alerts for work that finished days ago.
  assert.equal(h.events.filter((e) => e.type === "notify").length, 0, "a silent prime stays silent")
  assert.equal(h.storage.getSession("t")?.unread, 0, "and does not badge history unread")
})

test("tailer: a prime never writes the rest BACKWARDS over a newer stamp", () => {
  const h = harness()
  h.storage.upsertSession(row())
  // The row already carries a LATER rest than anything in this transcript — the state a restart
  // inherits when nothing happened while frizz was down. Seeded through the setter that owns the
  // column: `upsertSession` deliberately does not write `rested_at`.
  h.storage.setRestedAt("t", "2026-07-01T00:05:00.000Z")
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE])
  const t = makeTailer(h)

  t.tick()
  assert.equal(h.storage.getSession("t")?.rested_at, "2026-07-01T00:05:00.000Z", "the stored stamp wins")
})

test("tailer: a prime mid-turn stamps nothing — there is no rest to record", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL]) // still working
  const t = makeTailer(h)

  t.tick()
  assert.equal(t.get("t")?.turn, "in-flight")
  assert.equal(h.storage.getSession("t")?.rested_at ?? null, null)

  // ...and the live edge that follows still owns the stamp + the notify, unchanged.
  appendFileSync(join(h.logDir, "sid.jsonl"), DONE + "\n")
  t.tick()
  assert.equal(h.storage.getSession("t")?.rested_at, "2026-07-01T00:00:02.000Z")
  assert.equal(h.events.filter((e) => e.type === "notify").length, 1, "the live transition still notifies")
})

test("tailer: a session with no transcript records mints no rest", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", []) // the file exists and is empty
  const t = makeTailer(h)

  t.tick()
  assert.equal(h.storage.getSession("t")?.rested_at ?? null, null, "idle-by-default is not evidence of a rest")
})

test("tailer: unread is gated on last_read_at (a read-past turn does not re-badge)", () => {
  const h = harness()
  // user already read at a time AFTER the (only) turn-end record's timestamp
  h.storage.upsertSession(row({ last_read_at: "2026-07-01T00:00:05.000Z" }))
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  const t = makeTailer(h)
  t.tick() // prime in-flight

  appendFileSync(join(h.logDir, "sid.jsonl"), DONE + "\n") // end_turn ts = 00:00:02, before last_read
  t.tick()
  // notify still fires (it's a real transition) but unread stays cleared
  assert.equal(h.events.filter((e) => e.type === "notify").length, 1)
  assert.equal(h.storage.getSession("t")?.unread, 0)
})

test("tailer: pane death fires one exited notify + stamps exited (and not at boot)", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE])
  h.dead.v = true // already dead at boot
  const t = makeTailer(h)

  t.tick() // prime: adopts dead state silently
  assert.equal(h.events.length, 0, "a session already dead at boot must not notify")

  // now simulate a live→dead transition observed by the tailer
  h.dead.v = false
  const t2 = makeTailer(h) // fresh tailer, session now live
  h.storage.markRead("t") // clear any prior unread
  t2.tick() // prime live
  h.dead.v = true
  t2.tick() // observe death
  const exited = h.events.filter((e) => e.type === "notify" && e.kind === "exited")
  assert.equal(exited.length, 1)
  assert.equal(h.storage.getSession("t")?.exited, 1)

  t2.tick() // still dead → no duplicate
  assert.equal(h.events.filter((e) => e.type === "notify" && e.kind === "exited").length, 1)
})

test("tailer: incremental read handles a trailing partial line across ticks", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const path = join(h.logDir, "sid.jsonl")
  writeFileSync(path, IN_FLIGHT + "\n")
  const t = makeTailer(h)
  t.tick() // prime: in-flight

  // write a record WITHOUT its terminating newline — must be buffered, not mis-parsed
  appendFileSync(path, DONE)
  t.tick()
  assert.equal(t.get("t")?.turn, "in-flight", "a partial (unterminated) line is not yet a record")

  appendFileSync(path, "\n") // complete the line
  t.tick()
  assert.equal(t.get("t")?.turn, "idle")
})

// ---- signal-fence grammar (done/awaiting excusal fences) ----

test("parseSignalFence: a done fence captures the trimmed body, no hints", () => {
  assert.deepEqual(parseSignalFence("intro line\n\n```done\nShipped and merged.\n```"), { kind: "done", body: "Shipped and merged.", hints: [] })
})

test("parseSignalFence: END-ANCHORED — a fence with prose after it is quoted/explanatory, never an excusal", () => {
  // A worker EXPLAINING the protocol must not silently drop out of the Needs-you queue.
  assert.equal(parseSignalFence("```done\nexample fence\n```\n\nSo: should I use this format going forward?"), undefined)
  // Trailing whitespace after the closing fence is fine.
  assert.deepEqual(parseSignalFence("all done\n\n```done\nShipped.\n```\n  \n"), { kind: "done", body: "Shipped.", hints: [] })
})

test("parseSignalFence: an awaiting fence parses every sequence kind in file order; the remaining lines are the body", () => {
  const f = parseSignalFence("```awaiting\nshells: [bzvtnt3ig]\nagents: [a247b4470c]\ntimers: [tmr_a1b2c3d4e5f6]\nprs: [acme/app#391]\nfor: 2h\nWaiting on a named gate.\n```")
  assert.equal(f?.kind, "awaiting")
  assert.equal(f?.body, "Waiting on a named gate.")
  // The WIRE SHAPE did not move with the grammar: consumers still read a flat list of SINGULAR kinds.
  assert.deepEqual(f?.hints, [
    { kind: "shell", value: "bzvtnt3ig" },
    { kind: "agent", value: "a247b4470c" },
    { kind: "timer", value: "tmr_a1b2c3d4e5f6" },
    { kind: "pr", value: "acme/app#391" },
    { kind: "for", value: "2h" },
  ])
})

// A SEQUENCE IS THE POINT OF THE 2026-08-24 CUTOVER: YAML has no repeated keys, so three shells that used
// to be three `shell:` lines are one list. Block and flow both, and a bare scalar where a list is expected
// — which is what a worker with exactly one item reaches for.
test("parseSignalFence: a sequence takes many items, in block or flow form, and a lone scalar counts", () => {
  const block = parseSignalFence("```awaiting\nprs:\n  - acme/app#1\n  - acme/app#2\nfor: 2h\n```")
  assert.deepEqual(block?.hints, [
    { kind: "pr", value: "acme/app#1" },
    { kind: "pr", value: "acme/app#2" },
    { kind: "for", value: "2h" },
  ])
  const flow = parseSignalFence("```awaiting\nshells: [a1, b2]\nfor: 2h\n```")
  assert.deepEqual(flow?.hints, [
    { kind: "shell", value: "a1" },
    { kind: "shell", value: "b2" },
    { kind: "for", value: "2h" },
  ])
  const scalar = parseSignalFence("```awaiting\nprs: acme/app#391\nfor: 2h\n```")
  assert.deepEqual(scalar?.hints, [{ kind: "pr", value: "acme/app#391" }, { kind: "for", value: "2h" }])
})

// A `#` IN A PR REF IS NOT A YAML COMMENT, and this is the single measurement the cutover turned on: a
// comment needs whitespace before the `#`, and `owner/repo#123` has none. An unquoted ref survives.
test("parseSignalFence: a PR ref keeps its `#`, which YAML would only eat after a space", () => {
  const f = parseSignalFence("```awaiting\nprs: [colinhacks/zod#6440]\nfor: 24h\n```")
  assert.deepEqual(f?.hints, [{ kind: "pr", value: "colinhacks/zod#6440" }, { kind: "for", value: "24h" }])
})

// FRONTMATTER FRIZZ CANNOT PARSE MUST NEVER LOOK LIKE A PARK. A tab is the likeliest way in — YAML refuses
// tabs as indentation outright — and the fence then names nothing, so the scheduler bumps rather than
// parking. The worker's own lines survive in the BODY, or the correction is about a fence it cannot see.
test("parseSignalFence: unparseable YAML names nothing, and the lines survive in the body", () => {
  const f = parseSignalFence("```awaiting\nprs:\n\t- acme/app#1\nfor: 2h\n```")
  assert.deepEqual(f?.hints, [])
  assert.match(f?.body ?? "", /acme\/app#1/, "the worker has to be able to read back what it wrote")
})

test("parseSignalFence: a `word:` line outside the vocabulary is PROSE — including every retired kind", () => {
  // A stray colon-line must not mint a phantom hint that then glosses as leaked internals. Since the
  // 2026-08-24 cutover the retired list includes the SINGULAR item keys (`pr:`, `shell:`, …) and
  // `reason:`, alongside the older `pr-watch:`/`human:`/`ci:`/`session:`. All of them land in the body,
  // which is where the scheduler reads them back to name what replaced each one.
  const f = parseSignalFence("```awaiting\nnote: not a hint\npr-watch: acme/app#7\nhuman: Alice must approve\npr: 391\nreason: because\nprs: [acme/app#8]\n```")
  assert.deepEqual(f?.hints, [{ kind: "pr", value: "acme/app#8" }])
  assert.equal(f?.body, "note: not a hint\npr-watch: acme/app#7\nhuman: Alice must approve\npr: 391\nreason: because")
})

test("parseSignalFence: a key is case-insensitive, lowercased on output; a frontmatter-only body is empty", () => {
  // YAML itself is case-SENSITIVE, so without the fold a shouted key would parse and then match nothing
  // — a fence that reads correct to its author and names nothing to frizz.
  const f = parseSignalFence("```awaiting\nSHELLS: [bzvtnt3ig]\nTiMeRs: [tmr_a1b2c3d4e5f6]\nPRS: [acme/app#391]\nFor: 2h\n```")
  assert.deepEqual(f?.hints, [
    { kind: "shell", value: "bzvtnt3ig" },
    { kind: "timer", value: "tmr_a1b2c3d4e5f6" },
    { kind: "pr", value: "acme/app#391" },
    { kind: "for", value: "2h" },
  ])
  assert.equal(f?.body, "")
})

test("parseSignalFence: the LAST signal fence in a text wins", () => {
  const f = parseSignalFence("```awaiting\npr: 1\n```\n\nnever mind\n\n```done\nactually finished\n```")
  assert.deepEqual(f, { kind: "done", body: "actually finished", hints: [] })
})

test("parseSignalFence: an unclosed / mis-worded / trailing-junk fence is ignored", () => {
  assert.equal(parseSignalFence("```done\nno closing fence here"), undefined) // unclosed
  assert.equal(parseSignalFence("```shipped\nwrong language word\n```"), undefined) // not done/awaiting
  assert.equal(parseSignalFence("```done extra stuff\nbody\n```"), undefined) // junk after the language word
  assert.equal(parseSignalFence(undefined), undefined)
})

test("parseSignalFence: a ```question fence is NOT a signal fence", () => {
  assert.equal(parseSignalFence("```question\nWhich one?\n\n- A. x\n- B. y\n```"), undefined)
})

test("parseSignalFence: tolerates CRLF line endings", () => {
  assert.deepEqual(parseSignalFence("```done\r\nWindows body\r\n```"), { kind: "done", body: "Windows body", hints: [] })
})

test("parseSignalFence: the body is capped at 500 chars with a trailing ellipsis", () => {
  const f = parseSignalFence("```done\n" + "x".repeat(900) + "\n```")
  assert.equal(f?.body.length, 501) // 500 + the ellipsis char
  assert.ok(f?.body.endsWith("…"))
})

// ---- signal-fence lifecycle (set by final assistant text, cleared by newer activity) ----

test("applyRecord: a signal fence is set by the final assistant text and cleared by a later user record", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "shipped it\n\n```done\nMerged PR 391\n```" }] } })
  assert.deepEqual(s.lastFence, { kind: "done", body: "Merged PR 391", hints: [] })
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:20.000Z", message: { content: "thanks, next task" } })
  assert.equal(s.lastFence, undefined, "a newer user record clears the excusal fence")
})

test("applyRecord: a later assistant text without a fence clears it; with a fence replaces it", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "```awaiting\npr: 391\nwatching CI\n```" }] } })
  assert.equal(s.lastFence?.kind, "awaiting")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:05.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "actually still working on it" }] } })
  const cleared = s.lastFence // snapshot: assert on a local so the strict-equal narrowing doesn't poison s.lastFence below
  assert.equal(cleared, undefined, "a fence-less assistant text clears it — the fence only signals as the final message")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:09.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "```done\nall set\n```" }] } })
  assert.equal(s.lastFence?.kind, "done", "a fresh fence replaces the cleared one")
})

test("applyRecord: an assistant record with no text block leaves the fence intact", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "```done\nfinished\n```" }] } })
  assert.equal(s.lastFence?.kind, "done")
  applyRecord(s, { type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash" }] } })
  assert.equal(s.lastFence?.kind, "done", "a text-less assistant record does not recompute the fence (mirrors the question flag)")
})

test("tailer: surfaces a signal fence through get()", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const FENCED = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:02.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "```awaiting\nprs: [391]\nWaiting on CI.\n```" }] } })
  fixture(h.logDir, "sid", [IN_FLIGHT, FENCED])
  const t = makeTailer(h)
  t.tick()
  assert.deepEqual(t.get("t")?.lastFence, { kind: "awaiting", body: "Waiting on CI.", hints: [{ kind: "pr", value: "391" }] })
})

// ---- whole-directory FOREIGN session discovery (maintainer terminals: read-only threads) ----

// A tailer whose paneDead is a SPY — records every slug it's asked about, so a test can prove a
// foreign thread never triggers a liveness probe.
function foreignTailer(h: Harness) {
  const deadCalls: string[] = []
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: (slug) => { deadCalls.push(slug); return h.dead.v },
    sessionLogDir: h.logDir,
  })
  return { t, deadCalls }
}

// Write a foreign transcript with a controlled mtime (drives the freshness window against now()).
function foreignFile(dir: string, id: string, lines: string[], mtimeMs: number) {
  const p = join(dir, `${id}.jsonl`)
  writeFileSync(p, lines.map((l) => l + "\n").join(""))
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
}

const FCLOCK = Date.parse("2026-07-01T12:00:00.000Z")
const FRESH_MTIME = FCLOCK - 60 * 60_000 // 1h before the injected clock → within the 24h window
const STALE_MTIME = FCLOCK - (FOREIGN_FRESH_MS + 60 * 60_000) // just past the window → aged out

test("tailer: a FRESH unregistered .jsonl surfaces as a foreign thread with derived telemetry", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  const { t } = foreignTailer(h)
  foreignFile(h.logDir, "foreign-1", [IN_FLIGHT, TOOL, DONE], FRESH_MTIME)
  t.tick()
  assert.deepEqual(t.foreignIds(), ["foreign-1"])
  const tele = t.get("foreign-1")
  assert.equal(tele?.turn, "idle")
  assert.equal(tele?.lastAssistant, "all done")
  assert.equal(tele?.permPrompt, false)
})

test("tailer: a REGISTERED session_id's file is never foreign (registered rows win)", () => {
  const h = harness()
  h.storage.upsertSession(row()) // session_id "sid"
  h.clock.ms = FCLOCK
  const { t } = foreignTailer(h)
  foreignFile(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE], FRESH_MTIME) // fresh, but registered
  foreignFile(h.logDir, "foreign-2", [IN_FLIGHT], FRESH_MTIME)
  t.tick()
  assert.deepEqual(t.foreignIds(), ["foreign-2"], "the registered session_id is excluded; only the unregistered file is foreign")
})

// `firstUserText` is what NAMES an external session whose harness never named it, so it has to be the
// turn the conversation opened on and it has to survive every later turn. `lastUserText` tracks the
// newest turn for wake confirmation; if this drifted with it, a row's name would change every time the
// human said something.
test("tailer: firstUserText is the OPENING human turn and never drifts to a later one", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  const { t } = foreignTailer(h)
  const user = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-08-24T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } })
  const assistant = JSON.stringify({ type: "assistant", timestamp: "2026-08-24T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } })
  foreignFile(h.logDir, "opener", [user("look at the flaky windows runner"), assistant, user("now try the linux one")], FRESH_MTIME)
  // A tool_result is agent activity, not a human turn, so it can never become a session's name.
  // Both fixtures exist before the first tick: foreign DISCOVERY re-scans only every fifth one.
  foreignFile(h.logDir, "toolfirst", [
    JSON.stringify({ type: "user", timestamp: "2026-08-24T00:00:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }] } }),
    user("the real question"),
  ], FRESH_MTIME)
  t.tick()
  assert.equal(t.get("opener")?.firstUserText, "look at the flaky windows runner")
  assert.equal(t.get("toolfirst")?.firstUserText, "the real question")
})

// The exclusion that a CODEX row depends on entirely. Frizz mints `session_id` itself, but codex mints
// its own rollout id and frizz pins it in `agent_session_id` — so for a codex thread that column is the
// ONLY one naming the file on disk. Missing it, every codex thread frizz dispatched came back as its own
// read-only external twin in the External band, which promises the opposite of a thread frizz drives.
test("tailer: a registered row's agent_session_id is excluded from foreign discovery too", () => {
  const h = harness()
  h.storage.upsertSession(row({ slug: "codex-thread", session_id: "frizz-minted-id" }))
  // Pinned AFTER dispatch by its own setter — the shared upsert deliberately leaves it alone, which is
  // exactly why it is easy to forget on the read side.
  h.storage.setAgentSession("codex-thread", "codex-rollout-id")
  h.clock.ms = FCLOCK
  const { t } = foreignTailer(h)
  foreignFile(h.logDir, "codex-rollout-id", [IN_FLIGHT, TOOL, DONE], FRESH_MTIME) // the backend's own id
  foreignFile(h.logDir, "frizz-minted-id", [IN_FLIGHT], FRESH_MTIME)              // the frizz-minted id
  foreignFile(h.logDir, "genuinely-foreign", [IN_FLIGHT], FRESH_MTIME)
  t.tick()
  assert.deepEqual(t.foreignIds(), ["genuinely-foreign"], "neither id a row owns may surface as a foreign thread")
})

test("tailer: a FORGOTTEN phantom's transcript is never re-added by foreign discovery (tombstone)", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  // A phantom whose (drifted) transcript file lives on disk. While registered it's owned by its row; the
  // maintainer then Dismisses it — forgetSession deletes the row and tombstones its ids.
  h.storage.upsertSession(row({ slug: "phantom", session_id: "phantom-sid", transcript_id: "phantom-drift" }))
  foreignFile(h.logDir, "phantom-drift", [IN_FLIGHT, TOOL, DONE], FRESH_MTIME) // fresh, would-be foreign after delete
  foreignFile(h.logDir, "genuine-foreign", [IN_FLIGHT], FRESH_MTIME)
  h.storage.forgetSession("phantom")

  const { t } = foreignTailer(h)
  t.tick()
  assert.deepEqual(
    t.foreignIds(),
    ["genuine-foreign"],
    "the forgotten phantom's fresh transcript stays excluded; only the genuine unregistered file is foreign",
  )
})

test("tailer: a STALE (>24h mtime) foreign file ages out of foreignIds()", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  const { t } = foreignTailer(h)
  foreignFile(h.logDir, "fresh-one", [IN_FLIGHT], FRESH_MTIME)
  foreignFile(h.logDir, "stale-one", [IN_FLIGHT], STALE_MTIME)
  t.tick()
  assert.deepEqual(t.foreignIds(), ["fresh-one"], "only the fresh file is a live foreign thread")
})

test("tailer: foreign ids are ordered most-recent-mtime first", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  const { t } = foreignTailer(h)
  foreignFile(h.logDir, "older", [IN_FLIGHT], FCLOCK - 6 * 60 * 60_000) // 6h ago
  foreignFile(h.logDir, "newer", [IN_FLIGHT], FCLOCK - 1 * 60 * 60_000) // 1h ago
  t.tick()
  assert.deepEqual(t.foreignIds(), ["newer", "older"])
})

test("tailer: NEVER perm-sniffs or pane-death-checks a foreign thread (structural)", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  const { t, deadCalls } = foreignTailer(h)
  foreignFile(h.logDir, "foreign-q", [IN_FLIGHT, TOOL], FRESH_MTIME) // in-flight, then quiet
  t.tick() // prime
  h.clock.ms = FCLOCK + 60_000 // a long quiet gap with no new bytes
  t.tick()
  assert.equal(t.get("foreign-q")?.turn, "in-flight")
  assert.equal(t.get("foreign-q")?.permPrompt, false, "a foreign thread's perm-prompt is structurally false")
  assert.ok(!deadCalls.includes("foreign-q"), "paneDead is never called for a foreign id")
})

test("tailer: a foreign turn derives in-flight vs idle and transitions WITHOUT notify or storage write", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  const { t } = foreignTailer(h)
  const path = join(h.logDir, "f-turn.jsonl")
  writeFileSync(path, [IN_FLIGHT, TOOL].map((l) => l + "\n").join("")) // in-flight
  utimesSync(path, new Date(FRESH_MTIME), new Date(FRESH_MTIME))
  t.tick() // prime
  assert.equal(t.get("f-turn")?.turn, "in-flight")

  appendFileSync(path, DONE + "\n") // complete the turn (scan is cached this tick — still tailed)
  h.clock.ms = FCLOCK + 5000
  t.tick()
  assert.equal(t.get("f-turn")?.turn, "idle", "the foreign turn transitions like a registered one")
  assert.equal(h.events.length, 0, "a foreign turn-done NEVER notifies")
  assert.equal(h.storage.getSession("f-turn"), undefined, "no storage row is created for a foreign thread")
})

// ---- read-side transcript DISCOVERY + missing-transcript hardening (session-transcript-drift) ----

const SPAWN = "2026-07-01T00:00:00.000Z"
const PAST_GRACE = Date.parse("2026-07-01T00:01:01.000Z") // 61s after SPAWN (> DISCOVERY_GRACE_MS)

// A drifted transcript: lives at `fileId`.jsonl but carries `ownerId`'s scratchpad sentinel in content.
function driftedFixture(dir: string, fileId: string, ownerId: string, tail: string[] = [DONE]) {
  const sentinel = JSON.stringify({ type: "user", timestamp: SPAWN, message: { role: "user", content: `Your scratchpad is \`.frizz/threads/${ownerId}/scratch.md\` — keep state here.` } })
  fixture(dir, fileId, [sentinel, ...tail])
}

test("tailer: a PRESENT transcript binds directly — no discovery, transcript_id stays null (normal path unchanged)", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE])
  const t = makeTailer(h)
  h.clock.ms = Date.parse("2026-07-01T00:05:00.000Z") // WELL past grace, but the pinned file is present
  t.tick()
  assert.equal(t.get("t")?.turn, "idle")
  assert.equal(t.get("t")?.lastAssistant, "all done")
  assert.equal(t.get("t")?.noTranscript ?? false, false, "a present transcript is never degraded")
  assert.equal(h.storage.getSession("t")?.transcript_id ?? null, null, "no drift → transcript_id never written")
})

test("tailer: a transcript missing past the grace window → noTranscript degraded state (not an eternal spinner)", () => {
  const slug = "stall-thread"
  const h = harness()
  // Per-project now — keyed on the tailer's project.stateDir. This fixture project has none, so both
  // sides fall back to the per-install directory; ask for it the same way or this looks in an empty one.
  const stallLog = join(frizzTempDir("frizz-worker-logs"), `${slug}.stall.log`)
  try { rmSync(stallLog) } catch { /* not there */ }
  h.storage.upsertSession(row({ slug, thread_name: `frizz-${slug}` }))
  const t = makeTailer(h)

  h.clock.ms = Date.parse(SPAWN)
  t.tick() // prime WITHIN grace: pinned file absent → still spinning, not yet degraded
  assert.equal(t.get(slug)?.noTranscript ?? false, false)

  h.clock.ms = PAST_GRACE
  const before = h.changes.n
  t.tick()
  assert.equal(t.get(slug)?.noTranscript, true, "past grace + no transcript + no discovery hit → degraded")
  assert.ok(h.changes.n > before, "the degraded flip marks the board dirty (no waiting for the reconcile)")
  // The boot-failure evidence is persisted to disk for root-causing (point 5). Nothing captures a
  // worker's screen any more, so what the sink carries is the pointer to the evidence that DOES
  // exist for this row's runtime — deliberately worded (2026-07-31) to stop a reader hunting for
  // terminal output that cannot exist.
  const log = readFileSync(stallLog, "utf8")
  assert.match(log, /no worker output captured/, "the boot-failure evidence is persisted for triage")
  try { rmSync(stallLog) } catch { /* cleanup */ }
})

// The regression this fixes: a worker wedged on a startup modal has no transcript, so `turn` and
// `lastActivityAt` never satisfy sniffPane's quiet gate — the pane was never captured and the row
// carded as a bare "Stalled" while the reason sat unread in the stall log.
test("tailer: a present-but-EMPTY (0-byte) transcript past grace is treated as MISSING → degraded (0-byte crash-net hole closed)", () => {
  const slug = "empty-thread"
  const stallLog = join(frizzTempDir("frizz-worker-logs"), `${slug}.stall.log`)
  try { rmSync(stallLog) } catch { /* not there */ }
  const h = harness()
  h.storage.upsertSession(row({ slug, thread_name: `frizz-${slug}` }))
  fixture(h.logDir, "sid", []) // <sid>.jsonl EXISTS but is 0 bytes (worker created it then crashed)
  const t = makeTailer(h)

  h.clock.ms = Date.parse(SPAWN)
  t.tick() // within grace: an empty file is still "just spinning up", not yet degraded
  assert.equal(t.get(slug)?.noTranscript ?? false, false)

  h.clock.ms = PAST_GRACE
  t.tick()
  assert.equal(t.get(slug)?.noTranscript, true, "a 0-byte file past grace is missing content, not bound — must degrade")
  try { rmSync(stallLog) } catch { /* cleanup */ }
})

test("tailer: an empty transcript that LATER gets its first record binds normally (self-heals)", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", []) // starts empty
  const t = makeTailer(h)
  h.clock.ms = PAST_GRACE
  t.tick() // empty past grace → degraded
  assert.equal(t.get("t")?.noTranscript, true)
  appendFileSync(join(h.logDir, "sid.jsonl"), DONE + "\n") // the worker finally writes a record
  t.tick()
  assert.equal(t.get("t")?.noTranscript ?? false, false, "content arrived → clears degraded and binds")
  assert.equal(t.get("t")?.turn, "idle")
})

test("tailer: discovers a drifted transcript by sentinel, re-links + caches transcript_id, replays it SILENTLY", () => {
  const h = harness()
  h.storage.upsertSession(row()) // session_id "sid"
  driftedFixture(h.logDir, "forked-id", "sid", [DONE]) // real transcript at forked-id.jsonl, ends idle
  const t = makeTailer(h)

  h.clock.ms = Date.parse(SPAWN)
  t.tick() // prime within grace: <sid>.jsonl absent → no discovery yet
  assert.equal(h.storage.getSession("t")?.transcript_id ?? null, null)
  const before = h.events.length

  h.clock.ms = PAST_GRACE
  t.tick() // discovery re-links forked-id and replays it as a silent prime
  assert.equal(h.storage.getSession("t")?.transcript_id, "forked-id", "the discovered id is cached")
  assert.equal(t.get("t")?.noTranscript ?? false, false, "re-linked → not degraded")
  assert.equal(t.get("t")?.turn, "idle", "the discovered transcript's derivation now drives telemetry")
  assert.equal(t.get("t")?.lastAssistant, "all done")
  assert.equal(h.events.length, before, "a discovered transcript replays as a SILENT prime — no spurious turn-done notify")
})

// THE RENAMED CHECKOUT (maintainer, 2026-08-11: "all of these threads in /project/frizz are frozen and
// Retry doesn't work and I can't do a hard restart on the threads"). Claude Code shards its transcript
// store by the cwd a session was BORN in and a resumed session keeps writing to its birth bucket
// forever, so renaming `.../projects/fray` to `.../projects/frizz` left 417 transcripts one directory
// over from where frizz looked. Every one of them read as "no transcript 60s after dispatch" → degraded
// → board.ts degradeIfNoTranscript turned that into runtime "exited" → the yellow [!] plus a Retry that
// could only ever start MORE work frizz could not see, while RestartWorkerButton hid itself because the
// runtime read as exited. One missing file, all three symptoms.
//
// The session id is deliberately unique to this case: `discoverTranscriptDir` memoizes a hit dir
// process-wide, and every other case here reuses the id "sid".
test("tailer: a transcript stranded in a SIBLING log dir (the project was renamed) rebinds instead of degrading", () => {
  const h = harness()
  const slug = "renamed-project-thread"
  h.storage.upsertSession(row({ slug, session_id: "born-before-the-rename" }))
  // The bucket the checkout used to be called, beside the one frizz now derives from the current path.
  const preRename = join(dirname(h.logDir), "-Users-me-projects-fray")
  mkdirSync(preRename, { recursive: true })
  fixture(preRename, "born-before-the-rename", [IN_FLIGHT, TOOL, DONE])
  const t = makeTailer(h)

  h.clock.ms = Date.parse(SPAWN)
  t.tick() // within grace, the pinned file is simply absent — an ordinary spin-up, nothing to recover yet
  assert.equal(t.get(slug)?.noTranscript ?? false, false)

  h.clock.ms = PAST_GRACE
  const before = h.events.length
  t.tick()
  assert.equal(t.get(slug)?.noTranscript ?? false, false, "found one directory over — NOT a boot failure")
  assert.equal(t.get(slug)?.turn, "idle", "the stranded transcript's own derivation drives the board")
  assert.equal(t.get(slug)?.lastAssistant, "all done")
  // Same session, different directory: nothing drifted, so the DRIFTED-id column must stay clean.
  assert.equal(h.storage.getSession(slug)?.transcript_id ?? null, null, "a moved dir is not a drifted id")
  // SILENT, and this one is load-bearing at scale rather than merely tidy: on the real board 386 of the
  // frizz project's 427 sessions were stranded by one rename (measured 2026-08-11), so they all bind on
  // the same tick the operator restarts. A notify per historical turn-done would be 386 notifications
  // for work that finished days ago. Same discipline as the drifted-id re-link above.
  assert.equal(h.events.length, before, "a recovered transcript replays as a SILENT prime — no historical notify")
})

test("tailer: a genuinely missing transcript still degrades — the sibling sweep is a recovery, not a mask", () => {
  const h = harness()
  const slug = "really-a-boot-failure"
  h.storage.upsertSession(row({ slug, session_id: "never-written-anywhere" }))
  mkdirSync(join(dirname(h.logDir), "-Users-me-projects-fray"), { recursive: true }) // a sibling, but empty
  const t = makeTailer(h)
  h.clock.ms = PAST_GRACE
  t.tick()
  assert.equal(t.get(slug)?.noTranscript, true, "no transcript in ANY bucket is still a boot failure")
})

// THE ONE THAT SHOWS "Thinking…" FOREVER. Discovery used to be gated behind `state.offset > 0` — it
// only ran for a session that had NEVER bound a file — so the sibling-bucket recovery above, written
// for exactly this "the checkout moved" case, could not help a session that moved AFTER binding. And
// a worker moves its own checkout routinely: `EnterWorktree` changes the cwd, and Claude Code
// re-buckets the live session's transcript into the log dir for the new one. From that instant the
// bound path names nothing; `consume` skips a missing file silently, so the fold FREEZES at whatever
// turn it last held, with no signal anywhere that it has stopped reading.
//
// Frozen mid-turn that reading is "in-flight", and `computeTurn` derives it from a trailing user
// record with NO backstop behind it (unlike the 5s one for an unknown stop_reason), so the board sits
// on "Thinking…" for a thread that has been at rest for hours and cannot be talked out of it.
// Measured 2026-08-21 on three live threads at once — three `tail_state` rows pinned to three deleted
// worktree buckets, one of them reading "Thinking… 1h 1m" against a transcript whose last record was
// an `end_turn` from the moment the clock started.
test("tailer: a transcript that moves AFTER binding (the worker changed its cwd) is re-found mid-turn", () => {
  const h = harness()
  const slug = "moved-under-a-live-session"
  const sid = "relocated-mid-turn"
  h.storage.upsertSession(row({ slug, session_id: sid }))
  fixture(h.logDir, sid, [IN_FLIGHT, TOOL])
  const t = makeTailer(h)

  h.clock.ms = PAST_GRACE
  t.tick()
  assert.equal(t.get(slug)?.turn, "in-flight", "bound and mid tool_use — the healthy path, untouched")

  // The worker enters a worktree: same session, same file, a different bucket — and the turn it was
  // in the middle of finishes THERE, where the old binding can never see it.
  const worktree = join(dirname(h.logDir), "-a-project--claude-worktrees-a-branch")
  mkdirSync(worktree, { recursive: true })
  fixture(worktree, sid, [IN_FLIGHT, TOOL, DONE])
  rmSync(join(h.logDir, `${sid}.jsonl`))

  h.clock.ms = PAST_GRACE + 1000
  t.tick()
  assert.equal(t.get(slug)?.turn, "idle", "the fold follows the file and reads the rest it slept through")
  assert.equal(t.get(slug)?.lastAssistant, "all done")
  // A bound row has demonstrably written a transcript, so it must never be flagged as one that never
  // did: `noTranscript` is what degradeIfNoTranscript turns into runtime "exited" — a yellow [!] and a
  // Retry — and a thread that merely moved is not a boot failure.
  assert.equal(t.get(slug)?.noTranscript ?? false, false, "moved is not missing")
})

test("tailer: a bound transcript that vanishes with nowhere to go keeps its binding rather than degrading", () => {
  // The other half of the branch above, and the reason it does not simply reuse the unbound path: a
  // stat that fails on a file which is still there (a read racing a write, a bucket briefly gone) must
  // cost nothing but a retry. Flagging `noTranscript` here would card a healthy thread "Stalled".
  const h = harness()
  const slug = "vanished-with-no-sibling"
  const sid = "no-bucket-claims-this-one"
  h.storage.upsertSession(row({ slug, session_id: sid }))
  fixture(h.logDir, sid, [IN_FLIGHT, TOOL, DONE])
  const t = makeTailer(h)
  h.clock.ms = PAST_GRACE
  t.tick()
  assert.equal(t.get(slug)?.turn, "idle")

  rmSync(join(h.logDir, `${sid}.jsonl`))
  h.clock.ms = PAST_GRACE + 1000
  t.tick()
  assert.equal(t.get(slug)?.noTranscript ?? false, false, "a bound row is never a boot failure")
  assert.equal(t.get(slug)?.turn, "idle", "and its last real derivation stands")
})

// ── the relocation shapes that are NOT a clean hop ────────────────────────────────────────────────
//
// The two tests above move a file once, into a bucket whose contents are a strict superset of the old
// one — the shape where preserving a byte cursor is trivially correct. These are the shapes where it
// is not, and they are why the branch re-adopts from the top instead of resuming (raised in review of
// #24). A name is not evidence about the bytes below the cursor.

// A relocated file is chosen by matching `<id>.jsonl` and nothing else. If its prefix is NOT what we
// already folded, resuming at the cursor starts the fold mid-file and silently swallows every record
// below it — the same hazard `hydrateFromCache` refuses to take without `measureFence`/`fenceMatches`.
test("tailer: a relocated file whose prefix DIFFERS is re-adopted from the top, not resumed at the cursor", () => {
  const h = harness()
  const slug = "relocated-onto-a-different-file"
  const sid = "divergent-prefix"
  h.storage.upsertSession(row({ slug, session_id: sid }))
  fixture(h.logDir, sid, [IN_FLIGHT, TOOL])
  const t = makeTailer(h)
  h.clock.ms = PAST_GRACE
  t.tick()
  assert.equal(t.get(slug)?.turn, "in-flight", "bound, mid-turn")
  const cursor = statSync(join(h.logDir, `${sid}.jsonl`)).size

  // A DIFFERENT transcript now claims this id one bucket over: its own opening user turn, then enough
  // padding that the file is comfortably longer than our cursor, then its own rest.
  const openedLater = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:10.000Z", message: { role: "user", content: "a different conversation" } })
  const padding = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:11.000Z", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", input: { command: "x".repeat(cursor + 400) } }] } })
  const restedLater = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:12.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "the other file's answer" }] } })
  const elsewhere = join(dirname(h.logDir), "-a-project--claude-worktrees-elsewhere")
  mkdirSync(elsewhere, { recursive: true })
  fixture(elsewhere, sid, [openedLater, padding, restedLater])
  rmSync(join(h.logDir, `${sid}.jsonl`))
  // The precondition the assertion below rests on: the opening record sits BELOW our cursor, so a
  // resume-at-cursor could not see it, and the file is long enough that `consume` would not truncation-
  // reset its way out of the problem either.
  assert.ok(openedLater.length + 1 < cursor, "the divergent opening record is below the old cursor")
  assert.ok(statSync(join(elsewhere, `${sid}.jsonl`)).size > cursor, "and the file is longer than it")

  h.clock.ms = PAST_GRACE + 1000
  t.tick()
  assert.equal(t.get(slug)?.turn, "idle")
  assert.equal(t.get(slug)?.lastAssistant, "the other file's answer")
  assert.equal(
    t.get(slug)?.lastUserAt,
    "2026-07-01T00:00:10.000Z",
    "the record below the cursor was FOLDED — a resume would have skipped it and kept the old file's user turn",
  )
})

// The mirror-image failure, and the one the branch's original comment got wrong: `consume`'s truncation
// path resets `offset` and `partial` but leaves `primed` TRUE, so a shorter relocated file would replay
// into a primed state — firing a real turn-done notify for a historical record and letting `onTurnDone`
// write `rested_at` off it. A false rest, where the bug being fixed was a false "Thinking…".
test("tailer: a relocated file SHORTER than the cursor replays SILENTLY, with no historical notify", () => {
  const h = harness()
  const slug = "relocated-onto-a-shorter-file"
  const sid = "shorter-than-the-cursor"
  h.storage.upsertSession(row({ slug, session_id: sid }))
  const long = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { role: "user", content: "g".repeat(4000) } })
  fixture(h.logDir, sid, [long, TOOL])
  const t = makeTailer(h)
  h.clock.ms = PAST_GRACE
  t.tick()
  const cursor = statSync(join(h.logDir, `${sid}.jsonl`)).size
  const before = h.events.length

  const elsewhere = join(dirname(h.logDir), "-a-project--claude-worktrees-shorter")
  mkdirSync(elsewhere, { recursive: true })
  fixture(elsewhere, sid, [IN_FLIGHT, TOOL, DONE]) // a complete, at-rest transcript — just a small one
  rmSync(join(h.logDir, `${sid}.jsonl`))
  assert.ok(statSync(join(elsewhere, `${sid}.jsonl`)).size < cursor, "shorter than where we were reading")

  h.clock.ms = PAST_GRACE + 1000
  t.tick()
  assert.equal(t.get(slug)?.turn, "idle", "the shorter file's own derivation stands")
  assert.equal(t.get(slug)?.lastAssistant, "all done")
  assert.equal(h.events.length, before, "a re-adoption is a SILENT prime — no turn-done for a historical record")
})

// One session id legitimately naming two files at once is measured CLI behaviour (discover.ts:185), and
// `discoverTranscriptDir` breaks that tie on newest-NON-EMPTY for a reason its own note spells out:
// losing the coin flip renders a truncated conversation. The home candidate has to obey the same rule,
// or a 0-byte husk sitting at the deterministic path wins on position alone.
test("tailer: a 0-byte husk at the home path never beats a live sibling", () => {
  const h = harness()
  const slug = "husk-at-home"
  const sid = "two-files-one-id"
  h.storage.upsertSession(row({ slug, session_id: sid }))
  // Born in a sibling bucket, so the bound path is NOT the home path and `home` is a real candidate.
  const born = join(dirname(h.logDir), "-a-project--claude-worktrees-born-here")
  mkdirSync(born, { recursive: true })
  fixture(born, sid, [IN_FLIGHT, TOOL])
  const t = makeTailer(h)
  h.clock.ms = PAST_GRACE
  t.tick()
  assert.equal(t.get(slug)?.turn, "in-flight", "bound in the sibling it was born in")

  // It moves on again — and a 0-byte file appears at the home path at the same moment.
  const moved = join(dirname(h.logDir), "-a-project--claude-worktrees-moved-on")
  mkdirSync(moved, { recursive: true })
  fixture(moved, sid, [IN_FLIGHT, TOOL, DONE])
  writeFileSync(join(h.logDir, `${sid}.jsonl`), "")
  rmSync(join(born, `${sid}.jsonl`))

  h.clock.ms = PAST_GRACE + 1000
  t.tick()
  assert.equal(t.get(slug)?.turn, "idle", "the live sibling won; the husk would have read as an empty conversation")
  assert.equal(t.get(slug)?.lastAssistant, "all done")
})

// A miss on this branch costs a full readdir + one stat per sibling bucket, synchronously on the tick,
// and `strandedLogDirs` memoizes only hits — so a permanently deleted bucket re-pays it every interval
// forever. That is the exact cost the unbound path's backoff was measured and written to bound.
test("tailer: a bound row that keeps missing backs OFF rather than sweeping every interval", () => {
  const h = harness()
  const slug = "permanently-gone"
  const sid = "no-bucket-will-ever-claim-this"
  h.storage.upsertSession(row({ slug, session_id: sid }))
  fixture(h.logDir, sid, [IN_FLIGHT, TOOL, DONE])
  const t = makeTailer(h)
  h.clock.ms = PAST_GRACE
  t.tick()
  assert.equal(t.get(slug)?.turn, "idle")

  rmSync(join(h.logDir, `${sid}.jsonl`))
  // Three consecutive misses: 15s, then 30s, then 60s.
  h.clock.ms = PAST_GRACE + 1_000
  t.tick()
  h.clock.ms += 15_000
  t.tick()
  h.clock.ms += 30_000
  t.tick()

  // The file comes back one bucket over. A flat 15s retry would find it on the next quarter-minute;
  // the backed-off row is not due for another 60s, and must still be waiting at 30s.
  const elsewhere = join(dirname(h.logDir), "-a-project--claude-worktrees-late")
  mkdirSync(elsewhere, { recursive: true })
  fixture(elsewhere, sid, [IN_FLIGHT, TOOL, DONE, TITLE])
  h.clock.ms += 30_000
  t.tick()
  assert.equal(t.get(slug)?.aiTitle, undefined, "still inside the backed-off window — no sweep was paid")
  h.clock.ms += 31_000
  t.tick()
  assert.equal(t.get(slug)?.aiTitle, "x", "and once it IS due, the re-link happens exactly as before")
  assert.equal(t.get(slug)?.noTranscript ?? false, false, "backing off is not degrading — a bound row is never a boot failure")
})

// A bind is what RETIRES the discovery throttle, and until this it retired only half of it: the unbound
// path cleared `discoverMisses` and left `nextDiscoverMs` armed. A row that reached its transcript
// through the sweep — or simply booted a few seconds before the worker wrote one — therefore carried a
// deadline up to DISCOVER_RETRY_MAX_MS (15m) into its healthy life, and slept through its FIRST
// relocation for the remainder of it. That is this branch's own bug arriving by the back door: the same
// frozen "Thinking…", merely bounded (raised in review of #24; the husk case above had to skip 16s of
// clock to work around it).
test("tailer: a bind retires the discovery throttle, so the next relocation is caught on the next tick", () => {
  const h = harness()
  const slug = "slow-to-write-then-moved"
  const sid = "bound-through-the-sweep"
  h.storage.upsertSession(row({ slug, session_id: sid }))
  const t = makeTailer(h)

  // Six past-grace misses with nothing on disk anywhere: 15s, 30s, 60s, 120s, 240s, 480s.
  h.clock.ms = PAST_GRACE
  t.tick()
  for (const step of [15_000, 30_000, 60_000, 120_000, 240_000]) {
    h.clock.ms += step
    t.tick()
  }
  assert.equal(t.get(slug)?.noTranscript, true, "no transcript anywhere yet — the row is degraded and deep in backoff")

  // The worker finally writes its transcript at the pinned path. Binding is NOT throttled (a row whose
  // own file gets bytes binds on the next tick however deep its miss streak), so this is unchanged.
  fixture(h.logDir, sid, [IN_FLIGHT, TOOL])
  h.clock.ms += 1000
  t.tick()
  assert.equal(t.get(slug)?.turn, "in-flight", "bound")
  assert.equal(t.get(slug)?.noTranscript, false, "and no longer degraded")

  // Now it enters a worktree: Claude Code re-buckets the transcript and the bound path names nothing.
  const worktree = join(dirname(h.logDir), "-a-project--claude-worktrees-entered")
  mkdirSync(worktree, { recursive: true })
  fixture(worktree, sid, [IN_FLIGHT, TOOL, DONE])
  rmSync(join(h.logDir, `${sid}.jsonl`))

  h.clock.ms += 1000
  t.tick()
  assert.equal(t.get(slug)?.turn, "idle", "found on the NEXT tick, not 480s later behind a throttle the bind should have retired")
  assert.equal(t.get(slug)?.lastAssistant, "all done")
})

// ── the rest instant is the TURN's clock, not the file's ───────────────────────────────────────────

// `lastActivityAt` moves on records that leave the turn idle — a Claude `type:"system"` sidecar, a
// sub-agent's completion notification, a codex agent-report or compaction. `onTurnDone` reads it safely
// only because it fires on the EDGE, where the turn-ending record is the last one there is; prime folds
// the whole file, so the stamp has to come from `lastAssistantAt` or a trailing sidecar inflates it.
// That matters beyond tidiness: the guard blocks BACKWARD writes only, so an inflated stamp overwrites a
// correct one, and `bgSnoozeArmed` holds only while `bg_snooze_rested_at === rested_at` — a restart
// could silently un-arm an operator's snooze (raised in review of #24).
test("tailer: a trailing system record does not inflate the rest stamp a prime writes", () => {
  const h = harness()
  const trailing = JSON.stringify({ type: "system", timestamp: "2026-07-01T00:00:09.000Z", content: "a background child reported in" })
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE, trailing])
  const t = makeTailer(h)

  t.tick()
  assert.equal(t.get("t")?.turn, "idle", "the sidecar leaves the turn where the end_turn put it")
  assert.equal(t.get("t")?.lastActivityAt, "2026-07-01T00:00:09.000Z", "…while advancing the activity clock")
  assert.equal(
    h.storage.getSession("t")?.rested_at,
    "2026-07-01T00:00:02.000Z",
    "the rest is dated by the record that ENDED the turn, not by the sidecar that trailed it",
  )
})

test("tailer: re-priming the same rest is idempotent — the stamp an operator's snooze is pinned to holds", () => {
  const h = harness()
  h.storage.upsertSession(row())
  // The rest was already observed live and stamped; a snooze is armed against that exact instant.
  h.storage.setRestedAt("t", "2026-07-01T00:00:02.000Z")
  const trailing = JSON.stringify({ type: "system", timestamp: "2026-07-01T00:00:09.000Z", content: "still chattering" })
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE, trailing])
  const t = makeTailer(h)

  t.tick() // the bounce
  assert.equal(
    h.storage.getSession("t")?.rested_at,
    "2026-07-01T00:00:02.000Z",
    "unchanged — so bg_snooze_rested_at still matches and the snooze stays armed",
  )
})

test("tailer: a replacement during transcript discovery cannot inherit or transiently expose the stale transcript", () => {
  const h = harness()
  const stale = row({ session_id: "owner-a", runtime_generation: 3 })
  h.storage.upsertSession(stale)
  driftedFixture(h.logDir, "owner-a-drifted", stale.session_id, [DONE])
  let replaced = false
  const racingStorage = new Proxy(h.storage, {
    get(target, property, receiver) {
      if (property === "setTranscriptIdIfCurrent") {
        return (slug: string, sessionId: string, generation: number, transcriptId: string | null) => {
          if (!replaced) {
            replaced = true
            target.upsertSession(row({ slug, session_id: "owner-b", runtime_generation: 0, transcript_id: null }))
          }
          return target.setTranscriptIdIfCurrent(slug, sessionId, generation, transcriptId)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: racingStorage,
    bus: h.bus,
    onChange: () => {},
    now: () => PAST_GRACE,
    paneDead: () => false,
    sessionLogDir: h.logDir,
  })

  t.tick()
  assert.equal(replaced, true)
  assert.equal(h.storage.getSession(stale.slug)?.session_id, "owner-b")
  assert.equal(h.storage.getSession(stale.slug)?.transcript_id, null)
  assert.equal(t.get(stale.slug), undefined, "stale A telemetry is hidden until B gets its own tail state")

  t.tick()
  assert.notEqual(t.get(stale.slug)?.lastAssistant, "all done")
  assert.equal(h.storage.getSession(stale.slug)?.transcript_id, null)
})

test("tailer: a row with a cached transcript_id binds THAT file, not <session_id>.jsonl", () => {
  const h = harness()
  h.storage.upsertSession(row({ transcript_id: "forked-id" })) // <sid>.jsonl does NOT exist
  fixture(h.logDir, "forked-id", [IN_FLIGHT, TOOL, DONE])
  const t = makeTailer(h)
  t.tick()
  assert.equal(t.get("t")?.turn, "idle")
  assert.equal(t.get("t")?.lastAssistant, "all done")
  assert.equal(t.get("t")?.noTranscript ?? false, false)
})

test("tailer: a cached transcript_id is excluded from FOREIGN discovery (the re-linked file is not a duplicate thread)", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  h.storage.upsertSession(row({ transcript_id: "forked-id" }))
  const { t } = foreignTailer(h)
  foreignFile(h.logDir, "forked-id", [IN_FLIGHT, DONE], FRESH_MTIME) // the re-linked transcript
  foreignFile(h.logDir, "stranger", [IN_FLIGHT], FRESH_MTIME) // a genuinely-unregistered terminal
  t.tick()
  assert.equal(t.foreignIds().includes("forked-id"), false, "the row's discovered transcript is NOT surfaced as foreign")
  assert.equal(t.foreignIds().includes("stranger"), true, "an unrelated fresh file still surfaces as foreign (control)")
})

// ---- codex: a rollout folds THROUGH THE TICK to idle (the computeTurn regression) ----
// Codex brackets turns EXPLICITLY (task_started .. task_complete → applyEvent writes state.turn) and
// never sets lastKind. BEFORE the computeTurn patch, the tick's computeTurn — which reads only Claude's
// lastKind/lastStopReason (undefined for codex) — fell through to "in-flight", CLOBBERING the `idle`
// applyEvent set, so a wired codex row was stuck in-flight forever. These drive a REAL CodexBackend
// through the tick (not applyEvent directly — codex.test.ts covers that) so computeTurn actually runs.

// Codex rollout record builders (real 0.144.1 schema — see backend/codex.fixtures/*.jsonl).
const cxMeta = (codexId: string, cwd: string) => JSON.stringify({ timestamp: "2026-07-10T21:58:43.000Z", type: "session_meta", payload: { session_id: codexId, cwd } })
const cxTaskStarted = JSON.stringify({ timestamp: "2026-07-10T21:58:43.255Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } })
const cxAgentFinal = (text: string) => JSON.stringify({ timestamp: "2026-07-10T21:58:50.000Z", type: "event_msg", payload: { type: "agent_message", message: text, phase: "final_answer" } })
const cxTaskComplete = (last: string) => JSON.stringify({ timestamp: "2026-07-10T21:59:00.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: last } })
const CX_DONE = "All wired.\n\n```done\nwired\n```"
const PANE_CODEX_GITHUB_APPROVAL = [
  "Field 1/1",
  "Allow GitHub to create a Git blob?",
  "Repository: a/repository-name-that-must-not-leak",
  "Content: a-secret-payload-that-must-not-leak",
  "encoding: base64",
  "› 1. Allow                   Run the tool and continue.",
  "  2. Allow for this session  Allow this tool for the rest of the session.",
  "  3. Always allow            Always allow this tool.",
  "  4. Cancel                  Cancel this tool call.",
  "enter to submit | esc to cancel",
].join("\n")
const PANE_CODEX_PERMISSION_MENU = [
  "Update Model Permissions",
  "› 1. Ask for approval",
  "  2. Approve for me",
  "  3. Full Access",
  "Press enter to confirm or esc to go back",
].join("\n")

// Write a rollout into a $CODEX_HOME date-sharded sessions dir (filename suffix = the codex id, which
// findRolloutById locates by). Returns the path so the test can append to it mid-tick.
function writeCodexRollout(codexHome: string, codexId: string, lines: string[]): string {
  const dir = join(codexHome, "sessions", "2026", "07", "10")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-07-10T21-58-43-${codexId}.jsonl`)
  writeFileSync(path, lines.map((l) => l + "\n").join(""))
  return path
}

// A tailer whose backendFor routes codex rows to a real CodexBackend (tmp $CODEX_HOME) and everything
// else to a real ClaudeBackend — mirroring context.ts's resolver.
function codexTailer(h: Harness, codexHome: string) {
  const codexBackend = createCodexBackend({ codexHome })
  const claudeBackend = createClaudeBackend({ logDir: h.logDir })
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : claudeBackend)
  return createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    sessionLogDir: h.logDir,
    backendFor,
  })
}

// Pin a codex row the way dispatch does: backend + the discovered rollout id land via the dedicated
// setters (the shared upsert never writes them), leaving session_id as the frizz-minted key.
function pinCodexRow(h: Harness, codexId: string) {
  h.storage.upsertSession(row({ session_id: "frizz-uuid" }))
  h.storage.setBackend("t", "codex")
  h.storage.setAgentSession("t", codexId)
}

test("tailer: a codex rollout primes to in-flight, then transitions to idle+fence THROUGH the tick", () => {
  const h = harness()
  const codexHome = tmp("frizz-codexhome-")
  const codexId = "019f4e0a-42cb-7891-9cbf-325e93ae587c"
  const path = writeCodexRollout(codexHome, codexId, [cxMeta(codexId, "/x"), cxTaskStarted]) // turn open
  pinCodexRow(h, codexId)
  const t = codexTailer(h, codexHome)

  h.clock.ms = Date.parse("2026-07-10T21:58:45.000Z")
  t.tick() // prime while the turn is open
  assert.equal(t.get("t")?.turn, "in-flight", "an open codex turn (task_started, no task_complete) is in-flight")
  assert.equal(h.events.length, 0, "priming an in-flight codex turn never notifies")

  // The turn brackets closed with a done fence on the final message.
  appendFileSync(path, cxAgentFinal(CX_DONE) + "\n" + cxTaskComplete(CX_DONE) + "\n")
  h.clock.ms = Date.parse("2026-07-10T21:59:05.000Z")
  t.tick()
  const tele = t.get("t")
  // THE REGRESSION: without the patch computeTurn clobbers this back to "in-flight".
  assert.equal(tele?.turn, "idle", "task_complete's explicit bracket survives the tick's computeTurn")
  assert.deepEqual(tele?.lastFence, { kind: "done", body: "wired", hints: [] }, "the done fence is derived from the final message")
  assert.equal(tele?.lastAssistant, "All wired. ```done wired ```", "the final answer is the preview")
  const notifies = h.events.filter((e) => e.type === "notify")
  assert.equal(notifies.length, 1, "the in-flight→idle transition fires exactly one turn-done notify")
  assert.equal(notifies[0].type === "notify" && notifies[0].kind, "turn-done")
  assert.equal(h.storage.getSession("t")?.unread, 1, "a completed codex turn badges unread")
})

test("tailer: a codex rollout already at task_complete PRIMES straight to idle (not clobbered to in-flight)", () => {
  const h = harness()
  const codexHome = tmp("frizz-codexhome-")
  const codexId = "019f4e0b-1111-2222-3333-444455556666"
  writeCodexRollout(codexHome, codexId, [cxMeta(codexId, "/x"), cxTaskStarted, cxAgentFinal(CX_DONE), cxTaskComplete(CX_DONE)])
  pinCodexRow(h, codexId)
  const t = codexTailer(h, codexHome)

  h.clock.ms = Date.parse("2026-07-10T22:05:00.000Z")
  t.tick() // prime a fully-bracketed rollout
  assert.equal(t.get("t")?.turn, "idle", "a primed, fully-bracketed codex rollout is idle — computeTurn respects it")
  assert.equal(h.events.length, 0, "priming never notifies (the completion pre-dates first sight)")
})

test("tailer: a real-shaped first Codex title comment persists its title and replay never restores the transport", () => {
  const h = harness()
  const codexHome = tmp("frizz-codexhome-")
  const codexId = "019f4e0c-1111-2222-3333-444455556666"
  const final = '<!-- frizz title="Fix queue focus" -->\nVisible answer'
  writeCodexRollout(codexHome, codexId, [
    cxMeta(codexId, "/x"),
    cxTaskStarted,
    cxAgentFinal(final),
    cxTaskComplete(final),
  ])
  h.storage.upsertSession(row({
    session_id: "frizz-uuid",
    title: "raw initial prompt",
    title_auto: 1,
  }))
  h.storage.setBackend("t", "codex")
  h.storage.setAgentSession("t", codexId)

  const first = codexTailer(h, codexHome)
  first.tick()
  assert.equal(first.get("t")?.aiTitle, "Fix queue focus")
  assert.equal(first.get("t")?.lastAssistant, "Visible answer")
  assert.equal(h.storage.getSession("t")?.title, "Fix queue focus", "prime persists the transcript-backed title")
  assert.equal(h.storage.getSession("t")?.title_auto, 1, "automatic provenance remains distinct from a human rename")

  const restarted = codexTailer(h, codexHome)
  restarted.tick()
  assert.equal(restarted.get("t")?.aiTitle, "Fix queue focus")
  assert.equal(restarted.get("t")?.lastAssistant, "Visible answer", "full replay keeps the transport line hidden")
  assert.equal(h.storage.getSession("t")?.title, "Fix queue focus")
})

test("tailer: an omitted real-shaped Codex final retains the bounded dispatch fallback rather than an internal slug", () => {
  const h = harness()
  const codexHome = tmp("frizz-codexhome-")
  const codexId = "019f4e0d-1111-2222-3333-444455556666"
  const final = "`hello.txt` says: tui file.\n\n```done\ntui-ok\n```"
  writeCodexRollout(codexHome, codexId, [
    cxMeta(codexId, "/x"),
    cxTaskStarted,
    cxAgentFinal(final),
    cxTaskComplete(final),
  ])
  h.storage.upsertSession(row({ session_id: "frizz-uuid", title: "Fix queue focus…", title_auto: 1 }))
  h.storage.setBackend("t", "codex")
  h.storage.setAgentSession("t", codexId)

  codexTailer(h, codexHome).tick()
  assert.equal(h.storage.getSession("t")?.title, "Fix queue focus…")
  assert.equal(h.storage.getSession("t")?.title_auto, 1)
})

test("tailer: a later Codex marker cannot overwrite a manual title after an omitted-marker dispatch fallback", () => {
  const h = harness()
  const codexHome = tmp("frizz-codexhome-")
  const codexId = "019f4e0e-1111-2222-3333-444455556666"
  const path = writeCodexRollout(codexHome, codexId, [cxMeta(codexId, "/x"), cxTaskStarted])
  h.storage.upsertSession(row({ session_id: "frizz-uuid", title: "Audit registry auth…", title_auto: 1 }))
  h.storage.setBackend("t", "codex")
  h.storage.setAgentSession("t", codexId)
  const t = codexTailer(h, codexHome)
  t.tick()

  const omitted = "Completed the requested check."
  appendFileSync(path, cxAgentFinal(omitted) + "\n" + cxTaskComplete(omitted) + "\n")
  t.tick()
  assert.equal(h.storage.getSession("t")?.title, "Audit registry auth…")

  h.storage.setTitle("t", "Manual title wins")
  const later = "# Recovered generated title\nSecond response"
  appendFileSync(path, cxTaskStarted + "\n" + cxAgentFinal(later) + "\n" + cxTaskComplete(later) + "\n")
  t.tick()

  assert.equal(t.get("t")?.aiTitle, "Recovered generated title", "live telemetry may observe the later signal")
  assert.equal(h.storage.getSession("t")?.title, "Manual title wins")
  assert.equal(h.storage.getSession("t")?.title_auto, 0, "the storage CAS preserves explicit provenance")
})

// ---- Runtime auth classifier (claude-auth plan, Slice A) ----

const AUTH_401_TEXT = "Please run /login · API Error: 401 Invalid authentication credentials"

test("authFault: a synthetic isApiErrorMessage 401 record sets authentication_rejected", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, {
    type: "assistant",
    isApiErrorMessage: true,
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { model: "<synthetic>", content: [{ type: "text", text: AUTH_401_TEXT }] },
  })
  assert.equal(s.authFault, "authentication_rejected")
})

test("authFault: a NON-auth API error (overloaded) neither sets nor clears the fault", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, {
    type: "assistant",
    isApiErrorMessage: true,
    message: { model: "<synthetic>", content: [{ type: "text", text: AUTH_401_TEXT }] },
  })
  applyRecord(s, {
    type: "assistant",
    isApiErrorMessage: true,
    message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 529 Overloaded" }] },
  })
  assert.equal(s.authFault, "authentication_rejected", "an unrelated later API error keeps the last auth verdict")
  const fresh = newTailState("t2", "sid2", "/y")
  applyRecord(fresh, {
    type: "assistant",
    isApiErrorMessage: true,
    message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 529 Overloaded" }] },
  })
  assert.equal(fresh.authFault, undefined, "a non-auth API error never sets the fault")
})

test("authFault: user-authored or assistant-quoted 401 text can NEVER set the fault", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, {
    type: "user",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { content: [{ type: "text", text: AUTH_401_TEXT }] },
  })
  assert.equal(s.authFault, undefined)
  applyRecord(s, {
    type: "assistant",
    message: { content: [{ type: "text", text: `The observed failure was: ${AUTH_401_TEXT} — fixing now.` }] },
  })
  assert.equal(s.authFault, undefined, "a real assistant message quoting the line lacks isApiErrorMessage")
})

test("authFault: cleared by the next REAL assistant text, kept across an intervening user retry", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, {
    type: "assistant",
    isApiErrorMessage: true,
    message: { model: "<synthetic>", content: [{ type: "text", text: AUTH_401_TEXT }] },
  })
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:02.000Z", message: { content: [{ type: "text", text: "retry please" }] } })
  assert.equal(s.authFault, "authentication_rejected", "a user retry alone is not proof auth recovered")
  applyRecord(s, {
    type: "assistant",
    timestamp: "2026-07-01T00:00:03.000Z",
    message: { model: "claude-opus-4-8", content: [{ type: "text", text: "On it." }] },
  })
  assert.equal(s.authFault, undefined, "a genuine response proves the credential works")
})

// ---- The GENERAL fault: any failed turn (PR #26) ----
// The two classifiers above recognise an auth rejection (by text) and a usage limit (by category); every
// other API error used to leave no trace, and a synthetic error record still advances `lastAssistantAt`,
// so a thread failing every turn read as an agent resting after each one. Measured in the field before
// the flag existed: ~5,700 sign-off reminders to one session, one per scheduler tick, until every turn
// failed with a context-window 400 that the reminders themselves kept permanent. These pin the seam the
// scheduler guards depend on — the record raises the flag, a real reply clears it, and the value reaches
// `telemetry()` (deleting either site has to fail a test here, not only a stub-driven scheduler test).

const ERROR_400_TEXT = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Prompt is too long"}}'
const error400 = (at: string) => ({
  type: "assistant", isApiErrorMessage: true, error: "invalid_request", apiErrorStatus: 400, timestamp: at,
  message: { model: "<synthetic>", content: [{ type: "text", text: ERROR_400_TEXT }] },
})

test("apiFault: a synthetic error record of a category NO classifier recognises sets the flag", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, error400("2026-07-01T00:00:01.000Z"))
  assert.equal(s.apiFault, true)
  assert.equal(s.authFault, undefined, "not an auth rejection")
  assert.equal(s.limitFault, undefined, "not a usage limit")
  assert.equal(s.lastAssistantAt, "2026-07-01T00:00:01.000Z", "the record still advances the rest instant — which is why the flag is needed")
})

test("apiFault: the categories the narrow classifiers DO recognise raise it too", () => {
  const auth = newTailState("t", "sid", "/x")
  applyRecord(auth, { type: "assistant", isApiErrorMessage: true, message: { model: "<synthetic>", content: [{ type: "text", text: AUTH_401_TEXT }] } })
  assert.equal(auth.apiFault, true)
  assert.equal(auth.authFault, "authentication_rejected")
  const limit = newTailState("t2", "sid2", "/y")
  applyRecord(limit, {
    type: "assistant", isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, timestamp: "2026-07-01T00:00:01.000Z",
    message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit" }] },
  })
  assert.equal(limit.apiFault, true)
  assert.ok(limit.limitFault, "the specific classifier still fires beside it")
})

test("apiFault: user-authored or assistant-quoted error text can NEVER set it", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:01.000Z", message: { content: [{ type: "text", text: ERROR_400_TEXT }] } })
  assert.equal(s.apiFault, undefined)
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:02.000Z", message: { content: [{ type: "text", text: `The last turn failed with: ${ERROR_400_TEXT} — retrying.` }] } })
  assert.equal(s.apiFault, undefined, "a real assistant message quoting the error lacks isApiErrorMessage")
})

test("apiFault: cleared by the next REAL assistant text, kept across an intervening user retry", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, error400("2026-07-01T00:00:01.000Z"))
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:02.000Z", message: { content: [{ type: "text", text: "try again" }] } })
  assert.equal(s.apiFault, true, "a retry alone is not proof the turn reached the model")
  applyRecord(s, error400("2026-07-01T00:00:03.000Z"))
  assert.equal(s.apiFault, true, "a second failure keeps it raised")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:04.000Z", message: { model: "claude-opus-4-8", stop_reason: "end_turn", content: [{ type: "text", text: "On it." }] } })
  assert.equal(s.apiFault, undefined, "a genuine response proves the turn reached the model")
})

// The value the SCHEDULER reads is the telemetry projection, not TailState — a flag the fold sets but
// `telemetry()` omits makes every guard on it dead in production while every fold test stays green.
test("apiFault: reaches telemetry() through the real tailer, and clears there too", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, JSON.stringify(error400("2026-07-01T00:00:01.000Z"))])
  const t = makeTailer(h)
  t.tick()
  assert.equal(t.get("t")?.apiFault, true)
  assert.equal(t.get("t")?.lastAssistantAt, "2026-07-01T00:00:01.000Z")
  appendFileSync(join(h.logDir, "sid.jsonl"), DONE + "\n")
  t.tick()
  assert.equal(t.get("t")?.apiFault, undefined)
})

test("isClaudeAuthErrorText: narrow conjunction", () => {
  assert.equal(isClaudeAuthErrorText(AUTH_401_TEXT), true)
  assert.equal(isClaudeAuthErrorText("Please run /login"), true)
  assert.equal(isClaudeAuthErrorText("401 invalid authentication"), true)
  assert.equal(isClaudeAuthErrorText("OAuth token 401"), true)
  assert.equal(isClaudeAuthErrorText("fix the 401 handling in api.ts"), false)
  assert.equal(isClaudeAuthErrorText("API Error: 529 Overloaded"), false)
  assert.equal(isClaudeAuthErrorText("HTTP 4010 items"), false)
})

// The app-server reports a model-run command as the ARGV it spawned, while codex's own
// `backgroundTerminals/list`, the rollout, and frizz's transcript-projected row all say the bare
// command. Stripping the wrapper is what lets the board row and the transcript row reconcile at all
// (lib/childOps.ts keys on it) — and it is what the operator reads.
test("tailer: a codex exec's launcher wrapper is stripped, and nothing else is", () => {
  assert.equal(unwrapShellCommand("/bin/zsh -lc 'sleep 900'"), "sleep 900")
  assert.equal(unwrapShellCommand("/bin/bash -c \"npm run dev\""), "npm run dev")
  assert.equal(unwrapShellCommand("bash -lc 'gh run watch && echo done'"), "gh run watch && echo done")
  // NOT unwrapped: the quoting does not span the whole remainder, so a naive strip would silently drop
  // the trailing redirect and show the operator a command that is not the one running.
  assert.equal(unwrapShellCommand("/bin/zsh -lc 'sleep 900' > /tmp/out"), "/bin/zsh -lc 'sleep 900' > /tmp/out")
  // NOT a shell invocation at all — returned untouched rather than half-parsed.
  assert.equal(unwrapShellCommand("sleep 900"), "sleep 900")
  assert.equal(unwrapShellCommand("python -c 'print(1)'"), "python -c 'print(1)'")
  assert.equal(unwrapShellCommand(undefined), undefined)
})

// ── A DISMISSED OP STAYS DISMISSED ACROSS A RESTART ──────────────────────────────────────────────
//
// THE BUG, from the maintainer's own board: they killed a background shell, it left the board, and it
// came back reading "57hr 18m". Reproduced by one cold fold of their real transcript — because the
// kill leaves NO record anywhere the fold can read. Measured twice, and both negatives matter:
//   · the provider writes nothing to the session JSONL when it stops a shell
//     (backend/_live_shell_stop_notice.mts), so the tool_use never gets its terminal partner;
//   · the output file SURVIVES the kill exactly as a normally-finished shell's does
//     (backend/_live_shell_stop_trace.mts), so file-absence cannot stand in for one either.
// The retirement therefore has to be durable, and this is the test that says so.
test("tailer: a killed shell does NOT come back when the fold re-primes from scratch", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const shellLine = JSON.stringify(bashBg("toolu_sh", "Restart the census sweep", "node census.ts"))
  const ackLine = JSON.stringify(resultText("toolu_sh", "Command running in background with ID: bhq. Output is being written to: /tmp/tasks/bhq.output. You will be notified when it completes."))
  // NOTE what is deliberately absent: any terminal record for toolu_sh. That is the real transcript's
  // shape after a kill, and it is why the dispatch record alone must not be enough to mint the row.
  fixture(h.logDir, "sid", [IN_FLIGHT, shellLine, ackLine])

  const first = makeTailer(h, { mtimeMs: () => Date.parse("2026-07-01T00:00:02.000Z") })
  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  first.tick()
  assert.equal(first.get("t")?.bgShells.length, 1, "the shell is live before the ×")
  assert.equal(first.dismissOp?.("t", "toolu_sh"), true)
  assert.deepEqual(first.get("t")?.bgShells, [], "and it leaves at once")

  // THE RESTART. A brand-new tailer over the SAME registry and the SAME transcript — every byte of the
  // dispatch and its launch ack still there, nothing terminal ever written. Before the retirement was
  // durable this re-minted the row and it pulsed "running" for as long as the thread lived.
  const second = makeTailer(h, { mtimeMs: () => Date.parse("2026-07-01T00:00:02.000Z") })
  second.tick()
  assert.deepEqual(second.get("t")?.bgShells, [], "a frizz restart must not resurrect what the operator killed")
  assert.deepEqual(second.get("t")?.subAgents, [], "…and it is gone from every live surface, not just the shell list")
})

// …AND IT STAYS KILLED ON A BOARD BIG ENOUGH TO DEFER ITS PRIME, which is every board this bug was
// ever reported from. The prime bound now turns a cold row back BEFORE its state is built at all (a
// row with no state IS an unprimed row), because the setup — the `retiredOps` read, the tail-cache
// hydrate, a stat per transcript, read-side discovery — used to run for all 558 rows of a real board
// on a tick that folded one of them. Every fence that makes a dismissal durable lives inside that
// setup, so a bound that skipped it rather than deferring it would resurrect the killed shell on
// exactly the boards large enough to matter. The one-row test above cannot see that: nothing defers.
test("tailer: a killed shell stays killed on a board big enough to defer its prime", () => {
  const h = harness()
  // Registered FIRST and VISIBLE, so registry order alone puts the row under test past the per-tick
  // bound — more than MAX_PRIME_ROWS_PER_TICK of them, and none archived, so the archive-yield rule
  // never fires and the count is the only thing deferring anybody.
  for (let i = 0; i < 60; i++) {
    const slug = `filler-${i}`
    h.storage.upsertSession(row({ slug, thread_name: `frizz-${slug}`, session_id: `filler-sid-${i}` }))
    fixture(h.logDir, `filler-sid-${i}`, [IN_FLIGHT, DONE])
  }
  h.storage.upsertSession(row())
  const shellLine = JSON.stringify(bashBg("toolu_sh", "Restart the census sweep", "node census.ts"))
  const ackLine = JSON.stringify(resultText("toolu_sh", "Command running in background with ID: bhq. Output is being written to: /tmp/tasks/bhq.output. You will be notified when it completes."))
  fixture(h.logDir, "sid", [IN_FLIGHT, shellLine, ackLine])

  // A FROZEN monotonic clock, for the same reason the archived-yield test freezes it: what is under
  // test is the deferral, and PRIME_BUDGET_MS is real wall time that would make WHICH tick primes this
  // row depend on how loaded the machine is.
  const opts = { mtimeMs: () => Date.parse("2026-07-01T00:00:02.000Z"), monotonicNow: () => 0 }
  const first = makeTailer(h, opts)
  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  first.tick()
  // THE CONTROL. Without this the test proves nothing: if the row primed on tick one, the deferral
  // path it exists to cover never ran. Undefined, not empty — a deferred row is not set up at all.
  assert.equal(first.get("t"), undefined, "the row under test really was deferred, setup and all")
  for (let i = 0; i < 5; i++) first.tick()
  assert.equal(first.get("t")?.bgShells.length, 1, "…and it folds on a later tick, shell and all")
  assert.equal(first.dismissOp?.("t", "toolu_sh"), true)

  // THE RESTART, over the same registry — and the same deferral, so the row is rebuilt on a tick that
  // is nowhere near the one that read the registry's `retired_op` rows into anything else.
  const second = makeTailer(h, opts)
  for (let i = 0; i < 6; i++) second.tick()
  assert.deepEqual(second.get("t")?.bgShells, [], "a deferred prime must not resurrect what the operator killed")
  assert.deepEqual(second.get("t")?.subAgents, [], "…on every live surface, exactly as an undeferred one does not")
})

// …AND A REVIVED OP STOPS BEING DISMISSED — on the tick the revival lands, not at the next boot.
//
// trackResumes queues the un-retirement (a pure fold function holds no storage handle), and the drain
// that writes it lived ONLY in the prime branch, which ends in `continue`. A SendMessage restart is
// folded on a STEADY tick, so its un-retirement was queued and never written: `retired_op` kept
// asserting a dismissal the fold had already superseded. The row is back on the board — correctly, it
// is live work again — and the NEXT frizz restart silently deletes it, hiding a child that is
// genuinely running. That is verbatim the failure the un-retire exists to prevent.
test("tailer: a restart on a STEADY tick clears the dismissal, not just the board", () => {
  const h = harness()
  h.storage.upsertSession(row({ backend: "claude" }))
  const OUT = "/tmp/tasks/a0b.output"
  fixture(h.logDir, "sid", [
    JSON.stringify(agentDispatch("toolu_dispatch", "Fix the node-shim abort", "2026-07-28T18:14:02.743Z")),
    JSON.stringify(agentLaunch("toolu_dispatch", "a0b15ec8029fe3830", OUT, "2026-07-28T18:14:02.926Z")),
  ])
  h.clock.ms = Date.parse("2026-07-28T18:14:03.000Z")
  const t = makeTailer(h, { mtimeMs: () => h.clock.ms })
  t.tick() // prime
  assert.deepEqual(t.get("t")?.subAgents.map((a) => a.id), ["toolu_dispatch"], "the child is live before the ×")

  // It fails; the operator clicks ×.
  appendFileSync(join(h.logDir, "sid.jsonl"), JSON.stringify(notify("toolu_dispatch", "a0b15ec8029fe3830", "failed", "2026-07-28T18:26:53.757Z")) + "\n")
  h.clock.ms = Date.parse("2026-07-28T18:27:00.000Z")
  t.tick()
  assert.equal(t.dismissOp?.("t", "toolu_dispatch"), true)
  assert.deepEqual([...h.storage.retiredOps("t", "sid")], ["toolu_dispatch"], "the × is durable, as it must be")

  // The agent RESTARTS it with SendMessage — folded on a steady tick, never a prime.
  appendFileSync(join(h.logDir, "sid.jsonl"), [
    JSON.stringify(sendMessage("toolu_send", "a0b15ec8029fe3830", "Resume shim fix", "2026-07-28T18:36:36.963Z")),
    JSON.stringify(resumeAck("toolu_send", "a0b15ec8029fe3830", OUT, "2026-07-28T18:36:36.974Z")),
  ].map((l) => l + "\n").join(""))
  h.clock.ms = Date.parse("2026-07-28T18:36:37.000Z")
  t.tick()

  assert.deepEqual(t.get("t")?.subAgents.map((a) => a.id), ["toolu_dispatch"], "the revived child is back on the board")
  assert.deepEqual([...h.storage.retiredOps("t", "sid")], [], "and the registry no longer calls it dismissed")

  // The consequence, made explicit: a frizz restart over the same registry must not re-hide it.
  t.stop()
  const second = makeTailer(h, { mtimeMs: () => h.clock.ms })
  second.tick()
  assert.deepEqual(second.get("t")?.subAgents.map((a) => a.id), ["toolu_dispatch"], "a restart must not delete a running child")
})

test("tailer: dismissing scopes to the SESSION — a re-dispatched slug starts clean", () => {
  // The durable key is (slug, session_id) on purpose. A replacement session is a different
  // conversation whose tool_use ids come from a different transcript; inheriting the old one's
  // retirements could hide live work under an id collision that means nothing.
  const h = harness()
  h.storage.upsertSession(row())
  const shellLine = JSON.stringify(bashBg("toolu_sh", "Watch CI", "gh run watch"))
  const ackLine = JSON.stringify(resultText("toolu_sh", "Command running in background with ID: b8p. Output is being written to: /tmp/tasks/b8p.output. You will be notified when it completes."))
  fixture(h.logDir, "sid", [IN_FLIGHT, shellLine, ackLine])
  const t = makeTailer(h, { mtimeMs: () => Date.parse("2026-07-01T00:00:02.000Z") })
  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z")
  t.tick()
  assert.equal(t.dismissOp?.("t", "toolu_sh"), true)
  assert.deepEqual(h.storage.retiredOps("t", "sid"), new Set(["toolu_sh"]))
  assert.deepEqual(h.storage.retiredOps("t", "a-different-session"), new Set(), "another session inherits nothing")
})

// ---- discovery BACKOFF + boot-failure alarm scope (the 2026-08-16 tick-cost investigation) ----
//
// A miss costs a full sweep of every sibling bucket under ~/.claude/projects plus a head-scan of this
// project's log dir, synchronously on the event loop. Rows that can never bind accumulate forever (the
// maintainer's board: 39 of them, every one `exited` AND `archived`, aged 12-46 days), so a flat retry
// spends that cost again every 15s for the life of the server.

test("tailer: repeated discovery misses back OFF, and a late drifted transcript is still found", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const t = makeTailer(h)

  h.clock.ms = Date.parse(SPAWN)
  t.tick() // within grace — no discovery yet

  // Four misses past grace, each at the interval the PREVIOUS miss asked for: 15s, 30s, 60s, 120s.
  h.clock.ms = PAST_GRACE
  t.tick()
  assert.equal(t.get("t")?.noTranscript, true, "past grace with nothing to bind → degraded")
  for (const step of [15_000, 30_000, 60_000]) {
    h.clock.ms += step
    t.tick()
  }

  // The transcript finally appears — drifted, so ONLY a discovery sweep can find it.
  driftedFixture(h.logDir, "late-id", "sid", [DONE])

  // The base interval is no longer enough: four misses have pushed the next attempt out to 120s.
  h.clock.ms += 15_000
  t.tick()
  assert.equal(h.storage.getSession("t")?.transcript_id ?? null, null, "backoff holds: no sweep at the base interval")
  assert.equal(t.get("t")?.noTranscript, true, "still degraded while the backoff is in effect")

  // But the retry never STOPS — it only becomes rare. Past the backed-off deadline it binds.
  h.clock.ms += 120_000
  t.tick()
  assert.equal(h.storage.getSession("t")?.transcript_id, "late-id", "the backed-off retry still discovers it")
  assert.equal(t.get("t")?.noTranscript ?? false, false, "re-linked → no longer degraded")
  assert.equal(t.get("t")?.turn, "idle", "and its derivation drives telemetry as usual")
})

test("tailer: the BACKOFF never delays a transcript that appears at the pinned path", () => {
  // The throttle gates the discovery SWEEPS only. A row whose own `<session_id>.jsonl` finally gets
  // bytes must bind on the very next tick however long its miss streak — that check runs before the
  // throttle. This is the guarantee that makes backing off safe for a row that is genuinely booting.
  const h = harness()
  h.storage.upsertSession(row())
  const t = makeTailer(h)

  h.clock.ms = PAST_GRACE
  t.tick()
  for (const step of [15_000, 30_000, 60_000, 120_000]) {
    h.clock.ms += step
    t.tick()
  }
  assert.equal(t.get("t")?.noTranscript, true, "five misses deep — well past the base interval")

  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE])
  h.clock.ms += 1_000 // one second later, far inside the backed-off window
  t.tick()
  assert.equal(t.get("t")?.noTranscript ?? false, false, "the pinned path binds immediately, backoff or not")
  assert.equal(t.get("t")?.lastAssistant, "all done", "and it folds on that same tick")
})

test("tailer: an exited+archived row flags noTranscript but raises NO boot-failure alarm", () => {
  const h = harness()
  const slug = "filed-away"
  const stallLog = join(frizzTempDir("frizz-worker-logs"), `${slug}.stall.log`)
  try { rmSync(stallLog) } catch { /* not there */ }
  // A thread the operator finished with and archived. Its transcript never existed and never will.
  // `archived` is a legacy column upsertSession does not even write — setState is the only way to
  // archive, and it is what the board reads. Archive it the way the Archive button does.
  h.storage.upsertSession(row({ slug, thread_name: `frizz-${slug}`, exited: 1 }))
  h.storage.setState(slug, "archived")
  const t = makeTailer(h)

  h.clock.ms = PAST_GRACE
  t.tick()
  // The BOARD still learns the row is degraded — only the ERROR-level alarm and its sink are skipped.
  assert.equal(t.get(slug)?.noTranscript, true, "the degraded flag is unchanged: the board still knows")
  assert.throws(() => readFileSync(stallLog, "utf8"), "no stall sink written for an archived, exited row")
})

test("tailer: a LIVE row still raises the boot-failure alarm (the archived skip is not a blanket mute)", () => {
  const h = harness()
  const slug = "really-stalled"
  const stallLog = join(frizzTempDir("frizz-worker-logs"), `${slug}.stall.log`)
  try { rmSync(stallLog) } catch { /* not there */ }
  h.storage.upsertSession(row({ slug, thread_name: `frizz-${slug}`, exited: 0, archived: 0 }))
  const t = makeTailer(h)

  h.clock.ms = PAST_GRACE
  t.tick()
  assert.equal(t.get(slug)?.noTranscript, true)
  assert.match(readFileSync(stallLog, "utf8"), /no worker output captured/, "a worker that failed to boot is still recorded")
  try { rmSync(stallLog) } catch { /* cleanup */ }
})

// Priming is bounded per tick, so on a cold board the ORDER decides who converges first. A long-lived
// board is overwhelmingly archive (464 rows, 459 archived, on the maintainer's machine), and priming in
// registry order made the five rows actually on screen wait ~20 ticks behind the collapsed Done section.
test("tailer: cold ARCHIVED rows yield their prime slots until every visible row has folded", () => {
  const h = harness()
  // Enough archived rows to exhaust the per-tick prime bound several times over, registered FIRST so
  // registry order alone would starve the visible row.
  for (let i = 0; i < 60; i++) {
    const slug = `archived-${i}`
    h.storage.upsertSession(row({ slug, thread_name: `frizz-${slug}`, session_id: `arch-sid-${i}`, exited: 1 }))
    h.storage.setState(slug, "archived")
    fixture(h.logDir, `arch-sid-${i}`, [IN_FLIGHT, DONE])
  }
  const slug = "on-screen"
  h.storage.upsertSession(row({ slug, thread_name: `frizz-${slug}`, session_id: "visible-sid" }))
  h.storage.setState(slug, "open")
  fixture(h.logDir, "visible-sid", [IN_FLIGHT, TOOL, DONE, TITLE])

  // PIN THE PRIME BUDGET. What is under test is the SCHEDULING rule — a cold visible row takes its
  // slot ahead of sixty archived ones — and PRIME_BUDGET_MS is real wall time spent against
  // performance.now(). On a loaded machine priming the first row alone can exceed it, and then the
  // visible row is deferred and this reads "in-flight", failing for a reason that has nothing to do
  // with the scheduler. Seen twice on the Windows box under full-suite load, green standalone; latent
  // on every platform. A frozen monotonic clock takes the budget out of the assertion entirely.
  const t = makeTailer(h, { monotonicNow: () => 0 })
  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z") // clear of the fold's unknown-stop_reason guess
  t.tick() // ONE tick

  assert.equal(t.get(slug)?.turn, "idle", "the visible row folded on the first tick, not the twentieth")
  assert.equal(t.get(slug)?.lastAssistant, "all done")
  assert.equal(t.get(slug)?.aiTitle, "x")
  // …and the archive is still deferred, which is exactly what bought that slot.
  assert.equal(t.get("archived-59")?.lastAssistant ?? null, null, "archived rows wait their turn")

  // They are deferred, never dropped: once nothing visible is cold they prime at the ordinary bound.
  for (let i = 0; i < 5; i++) t.tick()
  assert.equal(t.get("archived-0")?.lastAssistant, "all done", "the archive converges behind the visible board")
})

// FRONTMATTER, THEN MARKDOWN (2026-08-17). `reason:` was one LINE, and workers were visibly straining
// against it — the fence that prompted this crammed a known-answer-control rationale, two conditions and a
// commitment into a single sentence. A handoff is prose; forcing it through a key/value slot made it worse
// prose. A `---` line now ends the structure and everything after it is ordinary Markdown.
test("parseSignalFence: a `---` line ends the frontmatter and everything after it is prose", () => {
  const fence = ["```awaiting", "shells: [bb4sns0ye]", "for: 20m", "---", "Known-answer control on the detector.", "", "- angular must report clean", "- puppeteer must be flagged", "```"].join("\n")
  const parsed = parseSignalFence(fence)
  assert.deepEqual(parsed?.hints, [{ kind: "shell", value: "bb4sns0ye" }, { kind: "for", value: "20m" }])
  // The prose survives INTACT — blank line and list markers included. Flattening it is what the old
  // one-line `reason:` did.
  assert.equal(parsed?.body, "Known-answer control on the detector.\n\n- angular must report clean\n- puppeteer must be flagged")
})

// `title:` — the resting card's heading in the worker's own words (2026-08-26). It rides the frontmatter
// as an ordinary scalar beside `for:`, which is what puts it on `FenceView.hints` and therefore on the
// ThreadView the card reads. It is capped HERE, at the parse, so the hint on the wire is already the
// string the card draws and no surface can render a longer one.
test("parseSignalFence: a title: rides the frontmatter, trimmed to the cap", () => {
  const parsed = parseSignalFence("```awaiting\nagents: [toolu_01A]\nfor: 2h\ntitle: Three-platform CI run\n---\nThe macOS leg is the flaky one.\n```")
  assert.deepEqual(parsed?.hints, [
    { kind: "agent", value: "toolu_01A" },
    { kind: "for", value: "2h" },
    { kind: "title", value: "Three-platform CI run" },
  ])
  assert.equal(parsed?.body, "The macOS leg is the flaky one.", "a title is structure, never prose")
  // Over the cap ⇒ trimmed on a word boundary, at the parse rather than at the card.
  const long = parseSignalFence("```awaiting\nfor: 2h\ntitle: Waiting on the three-platform CI run before porting the v2 drivers\n```")
  assert.deepEqual(long?.hints.find((h) => h.kind === "title"), { kind: "title", value: "Waiting on the three-platform CI run…" })
  // …and the wire schema takes the kind, which is what carries it to the client at all.
  assert.deepEqual(AwaitingHint.parse({ kind: "title", value: "Three-platform CI run" }), { kind: "title", value: "Three-platform CI run" })
})

// With no `---` the whole fence is frontmatter — and `reason:` is now RETIRED there. It was the last prose
// in the frontmatter and the one thing that made real YAML impossible (a colon or a ` #` in a handoff
// sentence breaks the parse or eats half the line), so it moved below the delimiter where it always
// belonged. A worker still writing it is told so rather than having the line silently swallowed.
test("parseSignalFence: with no `---`, the whole fence is frontmatter and `reason:` falls to the body", () => {
  const parsed = parseSignalFence("```awaiting\nshells: [bb4sns0ye]\nfor: 20m\nreason: one line as before\n```")
  assert.deepEqual(parsed?.hints, [
    { kind: "shell", value: "bb4sns0ye" },
    { kind: "for", value: "20m" },
  ])
  assert.equal(parsed?.body, "reason: one line as before")
})

// The exact sentence the 2026-08-17 measurement recorded as unparseable YAML. It never reaches the parser
// now — `reason:` is peeled off as retired before the frontmatter is handed to `yaml` — so the fence still
// yields its real hints instead of collapsing into a parse error.
test("parseSignalFence: a `reason:` carrying a colon cannot break the YAML parse", () => {
  const parsed = parseSignalFence("```awaiting\nshells: [bb4sns0ye]\nfor: 20m\nreason: waiting on your merge: the propKeys revert\n```")
  assert.deepEqual(parsed?.hints, [{ kind: "shell", value: "bb4sns0ye" }, { kind: "for", value: "20m" }])
  assert.match(parsed?.body ?? "", /the propKeys revert/)
})

// THE DELIMITER IS WHAT MAKES A BAD LINE REFUSABLE. Before it, a `word:` line is a CLAIM to be structural,
// so a retired kind there is an error the worker gets told about; after it, the same characters are prose.
// Previously the two were indistinguishable and a `pr-watch:` line quietly became body text.
test("parseSignalFence: a retired kind in frontmatter falls to the body, where the scheduler can name it", () => {
  const parsed = parseSignalFence("```awaiting\npr-watch: acme/app#1\nfor: 2h\n---\nthe handoff\n```")
  assert.deepEqual(parsed?.hints, [{ kind: "for", value: "2h" }])
  assert.match(parsed?.body ?? "", /pr-watch: acme\/app#1/, "the offending line is still visible to SOURCE 12")
  assert.match(parsed?.body ?? "", /the handoff/)
})

// A structural line AFTER the delimiter is prose, not a hint — otherwise a worker quoting the grammar in
// its own handoff would arm a wait by accident.
test("parseSignalFence: a `shell:` line after the delimiter is prose, not a wait", () => {
  const parsed = parseSignalFence("```awaiting\nfor: 2h\n---\nI considered `shell: bnope` but it had already finished.\n```")
  assert.deepEqual(parsed?.hints, [{ kind: "for", value: "2h" }])
  assert.match(parsed?.body ?? "", /shell: bnope/)
})

// A BACKGROUND SHELL'S LIVENESS IS ASKED OF THE OS, not guessed from age or output.
//
// Frizz spawns none of these processes and the runtime records no pid it can read, so before this the
// ONLY thing that retired a shell was its `<task-notification>` — and one whose process died without
// emitting one stayed "running" forever (the maintainer's board: `RUNNING · 2583 MIN`, 43 hours, for a
// process that did not exist).
//
// The key frizz already holds is the OUTPUT PATH: a shell's stdout is redirected into `<taskId>.output`,
// so whoever holds that file open IS the shell. An age threshold could not do this job — frizz's own
// contract tells workers to wait with `until <cond>; do sleep 5; done`, which prints nothing for hours by
// design, so silence and death look identical there and only the OS can tell them apart.
test("tailer: a shell the OS says nobody is running goes stale; alive and unknown both stay running", () => {
  const run = (alive: boolean | undefined, elapsedMs: number) => {
    const h = harness()
    h.storage.upsertSession(row())
    fixture(h.logDir, "sid", [
      IN_FLIGHT,
      JSON.stringify(bashBg("toolu_sh", "Waiting for the verification and suite", "until grep -q done out; do sleep 5; done")),
      JSON.stringify(resultText("toolu_sh", "Command running in background with ID: bQuiet. Output is being written to: /tmp/tasks/bQuiet.output.")),
    ])
    const t = createTailer({
      project: { cwdSlug: "x" } as Project,
      storage: h.storage, bus: h.bus, onChange: () => h.changes.n++,
      now: () => h.clock.ms, paneDead: () => h.dead.v,
      sessionLogDir: h.logDir,
      shellAlive: () => alive,
    })
    h.clock.ms = Date.parse("2026-07-01T00:00:01.000Z") + elapsedMs
    t.tick()
    return t.get("t")?.bgShells[0]?.state
  }

  // CONFIRMED GONE — the only case that demotes a shell.
  assert.equal(run(false, 10 * 60_000), "stale", "nobody holds its output open ⇒ it is not running")
  // ALIVE, however long and however quiet: the healthy `until` loop the contract recommends.
  assert.equal(run(true, 48 * 60 * 60_000), "running", "two days of silence is fine while the OS says it lives")
  // CANNOT TELL (no lsof, file not created yet, path cleaned away) is NEVER read as dead.
  assert.equal(run(undefined, 48 * 60 * 60_000), "running", "an unavailable probe must not invent a verdict")
  // INSIDE THE GRACE WINDOW a just-launched shell is alive by construction and is not probed at all.
  assert.equal(run(false, 5_000), "running", "a shell launched seconds ago is not interrogated")
})

// The case above injects `shellAlive`, which is answered inline — so it pins the VERDICT MAPPING and
// nothing about the real probe. This one takes the injection away and drives the production path: a
// real `lsof` against a real file, held open by a real fd. That probe is async and batched (it blocked
// the event loop for ~300ms per shell before 2026-09-04), so its verdict lands one tick later, and that
// one-tick lag is precisely what needs pinning.
test("tailer: the real shell probe is async — the verdict lands on the NEXT tick, never inside one", { skip: process.platform === "win32" ? "lsof is POSIX" : false }, async () => {
  const openTicks = async (outputFile: string) => {
    const h = harness()
    h.storage.upsertSession(row())
    fixture(h.logDir, "sid", [
      IN_FLIGHT,
      JSON.stringify(bashBg("toolu_sh", "Waiting for the verification and suite", "until grep -q done out; do sleep 5; done")),
      JSON.stringify(resultText("toolu_sh", `Command running in background with ID: bReal. Output is being written to: ${outputFile}.`)),
    ])
    // No shellAlive: this is the real lsof path.
    const t = makeTailer(h)
    h.clock.ms = Date.parse("2026-07-01T00:00:01.000Z") + 10 * 60_000
    t.tick()
    // The read is what queues the probe — `shellIsGone` is reached through assembly, not through tick.
    const first = t.get("t")?.bgShells[0]?.state
    // Let the batched probe run and land in the cache, then read it again.
    await new Promise((r) => setTimeout(r, 2000))
    return { first, second: t.get("t")?.bgShells[0]?.state }
  }

  const dir = tmp("frizz-shell-probe-")
  const dead = join(dir, "dead.output")
  const alive = join(dir, "alive.output")
  writeFileSync(dead, "")
  writeFileSync(alive, "")
  // Hold `alive` open from THIS process, so lsof has a real holder to find. That fd is the whole
  // control: without it both files are identical on disk and the test could not tell the two apart.
  const held = openSync(alive, "r")
  try {
    const gone = await openTicks(dead)
    assert.equal(gone.first, "running", "the first tick must not block on lsof, so it cannot yet know")
    assert.equal(gone.second, "stale", "the batched verdict must land in the cache for the next tick")

    const living = await openTicks(alive)
    assert.equal(living.first, "running")
    assert.equal(living.second, "running", "a file this process holds open must never read as gone")
  } finally {
    closeSync(held)
  }
})
