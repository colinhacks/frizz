#!/usr/bin/env node
// A fake `agy acp` for the antigravity-bridge tests: newline-delimited JSON-RPC on stdio in the dialect
// agy 1.5.12 was measured to speak (plans/antigravity-backend.md), frame for frame where the bridge
// reads one. It is run as `node fake-agy.mjs acp [--dangerously-skip-permissions]`.
//
// FAKE_AGY_MODE picks one misbehaviour:
//   (unset)     well-behaved
//   no-auth     `session/new` and `session/resume` fail with the protocol's auth-required error
//   no-resume   `session/resume` fails, so the bridge has to start a fresh session
//
// A prompt's text picks what the turn does:
//   SLOW          streams numbers until cancelled, or until a later prompt says STOP_NOW
//   BACKGROUND    starts a daemon command, ends the turn, then reports the command and speaks UNPROMPTED
//   RUN: <cmd>    asks permission for `run_command <cmd>` and runs nothing; the reply says what was decided
//   ASK           asks a two-question form through `elicitation/create`
//   /compact      returns `end_turn` with no frames, as agy's own does
//   anything else a thought, one `run_command`, the answer "PONG", a usage reading
//
// A prompt that arrives while another is in flight STEERS it: the earlier prompt's response returns at
// once and the later one's is the turn's end.
//
// FAKE_AGY_LOG, when set, receives one JSON line per inbound frame (and one for the launch arguments), so
// a test can assert what the bridge actually sent.

import { appendFileSync } from "node:fs"

const mode = process.env.FAKE_AGY_MODE ?? ""
const logPath = process.env.FAKE_AGY_LOG
const record = (entry) => { if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n") }
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\n")
const notify = (sessionId, update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const text = (value) => ({ type: "text", text: value })

record({ argv: process.argv.slice(2) })

let nextOutId = 1
const pendingOut = new Map()
const ask = (method, params) => {
  const id = `agy-${nextOutId++}`
  out({ jsonrpc: "2.0", id, method, params })
  return new Promise((resolve) => pendingOut.set(id, resolve))
}

// The free plan's shape: one Gemini model with thinking levels, one third-party model with none.
const MODELS = {
  "gem-flash": { name: "Gem Flash", levels: ["low", "medium", "high"], level: "high" },
  "third-party": { name: "Third Party", levels: [] },
}
const MODES = ["default", "accept-edits", "auto", "plan"]

const sessions = new Map() // sessionId -> { model, level, mode, promptId, cancelled, stop }
let sessionSeq = 0
let callSeq = 0

function configOptions(s) {
  const model = MODELS[s.model]
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: Object.entries(MODELS).map(([value, m]) => ({ value, name: m.name })) },
    ...(model.levels.length ? [{ id: "thought_level", name: "Thinking level", category: "thought_level", type: "select", currentValue: s.level, options: model.levels.map((value) => ({ value, name: value })) }] : []),
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: MODES.map((value) => ({ value, name: value })) },
  ]
}

const freshSession = () => ({ model: "gem-flash", level: "high", mode: "default", promptId: undefined, cancelled: false, stop: false })
const commandOutput = (output, exit = 0) => ({ output: `Created At: 2026-11-20T10:00:00Z\nCompleted At: 2026-11-20T10:00:01Z\nExit code: ${exit}\nCommand output:\n${output}`, exit_code: exit })

/** The current prompt's response. A steer moves `promptId` on, so this always answers the LAST prompt. */
function endTurn(sessionId, s, result) {
  const id = s.promptId
  s.promptId = undefined
  if (id !== undefined) out({ jsonrpc: "2.0", id, result })
}

async function runPrompt(sessionId, s, prompt) {
  if (prompt.trim() === "/compact") return endTurn(sessionId, s, { stopReason: "end_turn" })
  if (prompt.includes("SLOW")) {
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_slow", name: "run_command", title: "sleep 60", kind: "execute", status: "in_progress", rawInput: { CommandLine: "sleep 60", WaitMsBeforeAsync: 60000, toolSummary: "Waiting" } })
    for (let i = 1; i <= 400; i++) {
      if (s.cancelled || s.stop) break
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: text(`${i}\n`) })
      await sleep(20)
    }
    if (s.cancelled) {
      notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_slow", name: "run_command", status: "failed", rawOutput: { output: "" } })
      return endTurn(sessionId, s, { stopReason: "cancelled" })
    }
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_slow", name: "run_command", status: "completed", rawOutput: commandOutput("") })
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: text("STOPPED") })
    notify(sessionId, { sessionUpdate: "usage_update", used: 2000, size: 1000000 })
    return endTurn(sessionId, s, { stopReason: "end_turn" })
  }
  if (prompt.includes("BACKGROUND")) {
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_bg", name: "run_command", title: "sleep 1; echo late", kind: "execute", status: "in_progress", rawInput: { CommandLine: "sleep 1; echo late", IsDaemon: true, WaitMsBeforeAsync: 0 } })
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: text("Started it.") })
    notify(sessionId, { sessionUpdate: "usage_update", used: 1500, size: 1000000 })
    endTurn(sessionId, s, { stopReason: "end_turn" })
    // The wake: no prompt is outstanding, and nothing marks where what follows ends.
    await sleep(120)
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_bg", name: "run_command", status: "completed", rawOutput: commandOutput("late\r\n") })
    await sleep(60)
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: text("\n\nThe background command printed late.") })
    notify(sessionId, { sessionUpdate: "usage_update", used: 1700, size: 1000000 })
    return
  }
  const run = /^RUN: (.+)$/m.exec(prompt)?.[1]
  if (run) {
    // A call's id is its own: the bridge reads a second closing frame for one as a repeat, not a new call.
    const callId = `call_run_${++callSeq}`
    const toolCall = { toolCallId: callId, name: "run_command", title: run, kind: "execute", status: "pending", rawInput: { CommandLine: run, WaitMsBeforeAsync: 5000, toolSummary: "Running a command" } }
    notify(sessionId, { sessionUpdate: "tool_call", ...toolCall, status: "in_progress" })
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: callId, name: "run_command", status: "pending" })
    const answer = await ask("session/request_permission", { sessionId, toolCall, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] })
    const outcome = answer.result?.outcome
    record({ permissionOutcome: outcome })
    const allowed = outcome?.outcome === "selected" && outcome.optionId === "allow"
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: callId, name: "run_command", status: allowed ? "completed" : "failed", rawOutput: allowed ? commandOutput("ran\r\n") : { output: "" } })
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: text(allowed ? "ALLOWED" : "DENIED") })
    notify(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 1000000 })
    return endTurn(sessionId, s, { stopReason: "end_turn" })
  }
  if (prompt.includes("ASK")) {
    const questions = [{ question: "Which store?", is_multi_select: false, options: ["SQLite", "JSON file"] }, { question: "Which days?", is_multi_select: true, options: ["Mon", "Tue", "Wed"] }]
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_ask", name: "ask_question", title: "Asking", kind: "other", status: "in_progress", rawInput: { questions } })
    const answer = await ask("elicitation/create", {
      sessionId,
      toolCallId: "call_ask",
      mode: "form",
      message: "Two questions",
      requestedSchema: {
        type: "object",
        properties: {
          q1: { type: "string", title: "Which store?", oneOf: [{ const: "1", title: "SQLite" }, { const: "2", title: "JSON file" }] },
          q1_other: { type: "string", title: "Other" },
          q2: { type: "array", title: "Which days?", items: { anyOf: [{ const: "1", title: "Mon" }, { const: "2", title: "Tue" }, { const: "3", title: "Wed" }] } },
        },
      },
    })
    record({ elicitationResult: answer.result })
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_ask", name: "ask_question", status: "completed", content: [{ type: "content", content: text(JSON.stringify(answer.result ?? null)) }] })
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: text(`ANSWERED ${answer.result?.action}`) })
    notify(sessionId, { sessionUpdate: "usage_update", used: 1300, size: 1000000 })
    return endTurn(sessionId, s, { stopReason: "end_turn" })
  }
  notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: text("thinking about ") })
  notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: text("it") })
  notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", name: "run_command", title: "echo hi", kind: "execute", status: "in_progress", rawInput: { CommandLine: "echo hi", WaitMsBeforeAsync: 5000, toolSummary: "Saying hi" } })
  notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_1", name: "run_command", status: "completed", rawOutput: commandOutput("hi\r\n"), content: [{ type: "content", content: text(commandOutput("hi\r\n").output) }] })
  // agy repeats a call's closing frame; the bridge must not read it as a second call.
  notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_1", name: "run_command", status: "completed", rawOutput: commandOutput("hi\r\n") })
  notify(sessionId, { sessionUpdate: "agent_message_chunk", content: text("P") })
  notify(sessionId, { sessionUpdate: "agent_message_chunk", content: text("ONG") })
  notify(sessionId, { sessionUpdate: "usage_update", used: 1234, size: 1000000 })
  endTurn(sessionId, s, { stopReason: "end_turn" })
}

async function handle(msg) {
  record(msg)
  if (msg.id !== undefined && msg.method === undefined) {
    pendingOut.get(msg.id)?.(msg)
    pendingOut.delete(msg.id)
    return
  }
  const reply = (result) => out({ jsonrpc: "2.0", id: msg.id, result })
  const fail = (code, message) => out({ jsonrpc: "2.0", id: msg.id, error: { code, message } })
  const p = msg.params ?? {}
  switch (msg.method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true, image: true }, sessionCapabilities: { list: {}, resume: {}, close: {} } },
        authMethods: [{ id: "oauth", name: "Sign in with Google" }],
        agentInfo: { name: "antigravity", version: "9.9.9" },
      })
      return
    case "session/new": {
      if (mode === "no-auth") return fail(-32000, "Authentication required")
      const sessionId = `agy_${process.pid}_${++sessionSeq}`
      const s = freshSession()
      sessions.set(sessionId, s)
      reply({ sessionId, configOptions: configOptions(s), _meta: { antigravity: { tier: { id: "free-tier", name: "Free" } } } })
      notify(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact the conversation" }, { name: "usage", description: "Show quota" }] })
      return
    }
    case "session/resume": {
      if (mode === "no-auth") return fail(-32000, "Authentication required")
      if (mode === "no-resume") return fail(-32603, "session not found")
      // History is kept; the config options are NOT (measured): every reopen is back on the defaults.
      const s = freshSession()
      sessions.set(p.sessionId, s)
      reply({ configOptions: configOptions(s) })
      return
    }
    case "session/close":
      sessions.delete(p.sessionId)
      return reply({})
    case "session/set_config_option": {
      const s = sessions.get(p.sessionId)
      if (!s) return fail(-32602, "unknown session")
      if (p.configId === "model") {
        if (!MODELS[p.value]) return fail(-32602, `Unknown model "${p.value}"`)
        s.model = p.value
        s.level = MODELS[p.value].level // a model change resets the level to that model's own default
      } else if (p.configId === "thought_level") {
        if (!MODELS[s.model].levels.includes(p.value)) return fail(-32602, `Thinking level "${p.value}" is not offered for model "${s.model}"`)
        s.level = p.value
      } else if (p.configId === "mode") {
        if (!MODES.includes(p.value)) return fail(-32602, `Unknown mode "${p.value}"`)
        s.mode = p.value
        notify(p.sessionId, { sessionUpdate: "current_mode_update", currentModeId: p.value })
      } else {
        return fail(-32602, `unknown config option ${p.configId}`)
      }
      reply({ configOptions: configOptions(s) })
      return
    }
    case "session/prompt": {
      const s = sessions.get(p.sessionId)
      if (!s) return fail(-32602, "unknown session")
      const prompt = (p.prompt ?? []).map((b) => b.text ?? "").join("")
      if (s.promptId !== undefined) {
        // A steer: the earlier prompt returns now, the work goes on, and this prompt's response ends it.
        out({ jsonrpc: "2.0", id: s.promptId, result: { stopReason: "end_turn" } })
        s.promptId = msg.id
        if (prompt.includes("STOP_NOW")) s.stop = true
        return
      }
      s.promptId = msg.id
      s.cancelled = false
      s.stop = false
      await runPrompt(p.sessionId, s, prompt)
      return
    }
    case "session/cancel": {
      const s = sessions.get(p.sessionId)
      if (s) s.cancelled = true
      return
    }
    default:
      if (msg.id !== undefined) fail(-32601, "Method not found")
  }
}

let buf = ""
process.stdin.on("data", (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    void handle(msg)
  }
})
process.stdin.on("end", () => process.exit(0))
