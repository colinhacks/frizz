import { test } from "node:test"
import assert from "node:assert/strict"
import { createCodexBackend, parseCodexLine } from "./codex.ts"
import { newTailState } from "../tailer.ts"
import { parseCodexTranscript } from "../transcript.ts"
import { codexProviderError } from "./codex-error.ts"

const at = "2026-09-06T15:31:27.526Z"
const record = (payload: object, timestamp = at) => JSON.stringify({ timestamp, type: "event_msg", payload })
const failure = (code: unknown, message = "The provider rejected this request.") => record({
  type: "task_complete", last_agent_message: null, error: { message, codex_error_info: code },
})

test("provider error presentation redacts credential syntax and marks truncation", () => {
  const error = codexProviderError({ message: "Authorization: Bearer secret-value", additionalDetails: "x".repeat(33_000) })
  assert.doesNotMatch(error.message, /secret-value/)
  assert.match(error.details!, /\[truncated\]$/)
})

for (const code of ["cyber_policy", "usage_limit_exceeded", "rate_limit_exceeded", "context_window_exceeded", "session_budget_exceeded", "unauthorized", "bad_request", "internal_server_error", "server_overloaded", "sandbox_error", "misalignment_policy_violation", "unknown_future_error", { response_stream_disconnected: { http_status_code: 503 } }]) {
  test(`Codex reports terminal failure ${JSON.stringify(code)}`, () => {
    const line = failure(code)
    const state = newTailState("errors", "sid", "/fixture")
    createCodexBackend().foldLine(state, line)
    assert.equal(state.turn, "idle")
    assert.equal(state.apiFault, true)
    assert.equal(state.providerError?.message, "The provider rejected this request.")
    assert.equal(state.providerError?.code, typeof code === "string" ? code : "response_stream_disconnected")
    assert.equal(state.lastAssistantAt, at)
    const messages = parseCodexTranscript(line)
    assert.deepEqual(messages[0]?.providerError, state.providerError)
    assert.equal(messages[1]?.boundary, "rest")
  })
}

test("Codex policy failure preserves the captured provider message and never treats it as a sign-off", () => {
  // Captured from the failing Nub thread on 2026-09-06. The error rode only task_complete.error.
  const message = "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber"
  const state = newTailState("errors", "sid", "/fixture")
  const backend = createCodexBackend()
  backend.foldLine(state, record({ type: "agent_message", phase: "final_answer", message: "```done\nfinished\n```" }))
  backend.foldLine(state, failure("cyber_policy", message))
  assert.equal(state.providerError?.message, message)
  assert.equal(state.lastFence, undefined)
  assert.equal(state.lastAssistantAllDone, false)
  backend.foldLine(state, failure("other", "```done\nnot an agent answer\n```"))
  assert.equal(state.lastFence, undefined)
})

test("Codex keeps a failure across a retry request, clears it only on real assistant output", () => {
  const state = newTailState("errors", "sid", "/fixture")
  const backend = createCodexBackend()
  backend.foldLine(state, failure("unauthorized"))
  backend.foldLine(state, record({ type: "user_message", message: "try again" }))
  backend.foldLine(state, record({ type: "task_started" }))
  assert.equal(state.apiFault, true)
  assert.ok(state.providerError)
  backend.foldLine(state, record({ type: "agent_message", phase: "commentary", message: "Working again." }))
  assert.equal(state.apiFault, undefined)
  assert.equal(state.providerError, undefined)
  backend.foldLine(state, failure("other"))
  backend.foldLine(state, record({ type: "task_complete", last_agent_message: "Recovered." }))
  assert.equal(state.apiFault, undefined)
  assert.equal(state.providerError, undefined)
  backend.foldLine(state, failure("other"))
  backend.foldLine(state, record({ type: "task_complete", error: null, last_agent_message: null }))
  assert.equal(state.apiFault, undefined, "an explicitly successful empty turn clears the error too")
  assert.equal(state.providerError, undefined)
})

test("Codex standalone errors close a turn, while retry notices leave it running", () => {
  const backend = createCodexBackend()
  const state = newTailState("errors", "sid", "/fixture")
  backend.foldLine(state, record({ type: "task_started" }))
  const retry = record({ type: "stream_error", message: "Reconnecting… 1/5", codex_error_info: "response_stream_connection_failed" })
  backend.foldLine(state, retry)
  assert.equal(state.turn, "in-flight")
  assert.equal(state.apiFault, undefined)
  assert.equal(parseCodexTranscript(retry)[0]?.providerError?.retrying, true)
  const error = record({ type: "error", message: "Reconnection failed", codex_error_info: "response_too_many_failed_attempts" })
  backend.foldLine(state, error)
  assert.equal(state.turn, "idle")
  assert.equal(state.apiFault, true)
  assert.equal(state.providerError?.message, "Reconnection failed")
})

test("Codex errors deduplicate their turn-end echo, but remain visible on a later failed turn", () => {
  const error = { message: "Rejected", codex_error_info: "other" }
  const raw = [
    record({ type: "task_started" }),
    record({ type: "error", ...error }),
    record({ type: "task_complete", error }, "2026-09-06T15:31:28.000Z"),
    record({ type: "task_started" }),
    record({ type: "task_complete", error }),
  ].join("\n")
  const errors = parseCodexTranscript(raw).filter((m) => m.providerError)
  assert.equal(errors.length, 2)
  assert.equal(errors[0]?.providerError?.at, "2026-09-06T15:31:28.000Z", "the deduplicated card uses the fold's terminal timestamp")
})

test("Codex future and malformed failure payloads degrade visibly; null errors and quoted errors do not fail", () => {
  for (const error of [{}, { message: "" }, 1, "Failed"]) {
    const events = parseCodexLine(record({ type: "task_complete", error }))
    assert.equal(events[0]?.kind, "provider-error")
  }
  const events = parseCodexLine(record({ type: "error", error: { message: "Failed", codexErrorInfo: "cyberPolicy", additionalDetails: "Details" } }))
  assert.equal(events[0]?.kind, "provider-error")
  if (events[0]?.kind === "provider-error") assert.deepEqual(events[0].error, { message: "Failed", code: "cyber_policy", details: "Details", at })
  const state = newTailState("errors", "sid", "/fixture")
  const backend = createCodexBackend()
  backend.foldLine(state, record({ type: "task_complete", error: null, last_agent_message: "cyber_policy is an error code" }))
  assert.equal(state.apiFault, undefined)
  assert.equal(parseCodexTranscript(record({ type: "agent_message", message: "cyber_policy", phase: "final_answer" }))[0]?.providerError, undefined)
  backend.foldLine(state, record({ type: "turn_aborted" }))
  assert.equal(state.apiFault, undefined, "a deliberate stop is not a provider failure")
})
