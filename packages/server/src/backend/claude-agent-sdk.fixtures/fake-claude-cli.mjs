#!/usr/bin/env node

// Deterministic Claude CLI protocol stand-in used only by the Agent SDK contract tests. It speaks
// stream-json over stdio, performs no network access, and records only the explicit safe evidence
// fields the tests need (never credential values).

import { appendFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)
const executablePath = process.argv[1] ?? ""
const pathScenario = /^fake-claude--([a-z0-9-]+)(?:\.mjs)?$/i.exec(basename(executablePath))?.[1]
const scenario = process.env.FRIZZ_FAKE_CLAUDE_SCENARIO ?? pathScenario ?? "basic"
const capturePath = process.env.FRIZZ_FAKE_CLAUDE_CAPTURE ?? (pathScenario ? join(dirname(executablePath), "capture.jsonl") : undefined)
const requestedSessionId = optionValue("--session-id") ?? optionValue("--resume") ?? "00000000-0000-4000-8000-000000000001"
const sessionId = scenario === "mismatch" ? "00000000-0000-4000-8000-000000000099" : requestedSessionId
const eventSessionId = scenario === "late-mismatch" ? "00000000-0000-4000-8000-000000000098" : sessionId
const permissionRequest = {
  type: "control_request",
  request_id: "permission-request-1",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "printf safe" },
    permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "printf *" }], behavior: "allow", destination: "session" }],
    blocked_path: "/tmp/outside",
    decision_reason: "outside the working directory",
    title: "Run a safe command",
    display_name: "Run command",
    description: "Print a test marker",
    tool_use_id: "tool-use-permission-1",
    agent_id: "agent-main",
  },
}

let initializeCount = 0
let systemInitSent = false
let elicitationStep = 0
let permissionResponses = 0
let resultNumber = 0
let userInputCount = 0
// Input uuids sitting in the command queue, unanswered — the only ones a cancel can take back.
const queuedInputs = new Set()

record({
  kind: "startup",
  argv: args,
  cwd: process.cwd(),
  environment: {
    frizzFakeInheritedPresent: process.env.FRIZZ_FAKE_INHERITED !== undefined,
    frizzFakeOverridePresent: process.env.FRIZZ_FAKE_OVERRIDE !== undefined,
    clientApp: process.env.CLAUDE_AGENT_SDK_CLIENT_APP,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    pathPresent: typeof process.env.PATH === "string" && process.env.PATH.length > 0,
    homePresent: typeof process.env.HOME === "string" && process.env.HOME.length > 0,
    nodeOptionsPresent: process.env.NODE_OPTIONS !== undefined,
    anthropicApiKeyPresent: process.env.ANTHROPIC_API_KEY !== undefined,
    anthropicBaseUrlPresent: process.env.ANTHROPIC_BASE_URL !== undefined,
    anthropicAuthTokenPresent: process.env.ANTHROPIC_AUTH_TOKEN !== undefined,
    oauthTokenPresent: process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined,
    githubTokenPresent: process.env.GITHUB_TOKEN !== undefined,
    openaiApiKeyPresent: process.env.OPENAI_API_KEY !== undefined,
    awsSecretAccessKeyPresent: process.env.AWS_SECRET_ACCESS_KEY !== undefined,
    frizzSecretPresent: process.env.FRIZZ_SHOULD_NOT_LEAK !== undefined,
    arbitrarySecretPresent: process.env.ARBITRARY_SECRET !== undefined,
    // The lifted worker caps, captured as the values that ACTUALLY reached the process. They spent
    // their whole life set on a spawn path nothing called, so every reader believed they were applied
    // while a real worker ran on Claude Code's own defaults. Reported from here because this is the
    // only place that can prove otherwise: the process itself.
    maxWebSearches: process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION,
    maxSubagents: process.env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION,
    maxConcurrentSubagents: process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS,
    // Settings.autoCompactWindow, the ceiling that stops a `[1m]` worker growing to 1M before it
    // compacts. Same reason as the caps: only the forked process can prove it arrived.
    autoCompactWindow: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  },
})

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on("line", (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stderr.write("fake protocol received malformed JSON\n")
    return
  }
  if (message.type === "control_request") handleHostControl(message)
  else if (message.type === "control_response") handleHostResponse(message)
  else if (message.type === "user") handleUserMessage(message)
})

lines.on("close", () => {
  record({ kind: "stdin-end" })
  process.exit(0)
})

process.on("SIGTERM", () => {
  record({ kind: "signal", signal: "SIGTERM" })
  process.exit(0)
})

// Both spellings: the SDK passed `--session-id <id>` through 0.3.207 and `--session-id=<id>` from
// 0.3.260 (measured 2026-09-04). The real CLI accepts either; a fixture that read only the two-token
// form fell back to its default session id and every daemon test failed on session ownership.
function optionValue(flag) {
  const index = args.indexOf(flag)
  if (index >= 0) return args[index + 1]
  return args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
}

function handleHostControl(message) {
  const request = message.request ?? {}
  record({ kind: "host-control", requestId: message.request_id, subtype: request.subtype, mode: request.mode })
  if (request.subtype === "initialize") {
    initializeCount += 1
    const pending = (scenario === "redelivery" || scenario === "conflicting-redelivery") && initializeCount > 1
      ? { pending_permission_requests: [scenario === "conflicting-redelivery"
        ? { ...permissionRequest, request: { ...permissionRequest.request, input: { command: "printf conflict" } } }
        : permissionRequest] }
      : {}
    respond(message.request_id, initializationPayload(), pending)
    if (!systemInitSent) {
      systemInitSent = true
      // Frames that precede the session init (real claude brackets each turn with control frames).
      if (scenario === "preinit-control") emitControlFrame(sessionId) // benign: same session, kind "other"
      if (scenario === "preinit-mismatch") emitControlFrame("00000000-0000-4000-8000-000000000097") // foreign session
      if (scenario === "preinit-substantive") emitAssistant("premature assistant before init") // anomalous, must reject
      if (scenario !== "no-init") emitSystemInit()
      // Real claude re-emits init at the start of every streaming turn (same session), then keeps
      // streaming — model that: a benign re-init followed by a normal result the consumer still sees.
      if (scenario === "duplicate-init") setTimeout(() => { emitSystemInit(); emitResult("survived the re-init") }, 25)
      // A re-init that switches to a DIFFERENT session id is a session-crossing attempt and must reject.
      if (scenario === "cross-session-reinit") setTimeout(() => emitRawInit("00000000-0000-4000-8000-000000000096"), 25)
      if (scenario === "diagnostic") emitHostileDiagnostic()
    }
    return
  }
  if (request.subtype === "interrupt") {
    if (scenario === "hanging-control") return
    respond(message.request_id, scenario === "controls-no-receipt" ? {} : {
      still_queued: ["11111111-1111-4111-8111-111111111111", "internal-queue-id"],
    })
    return
  }
  if (request.subtype === "set_permission_mode") {
    respond(message.request_id, {})
    return
  }
  // The ONLY place real claude reports where a skill was resolved from — `SlashCommand` carries no
  // source at all. Shaped like 2.1.246's answer: "projectSettings" is a root frizz maps, the invented
  // root proves an unmapped one leaves its row unlabelled rather than mislabelled, and "compact" is a
  // frontmatter entry that is NOT a skill, so it must never reach the listing.
  if (request.subtype === "get_context_usage") {
    record({ kind: "context-usage" })
    if (scenario === "context-usage-failure") return respondError(message.request_id, "context usage unavailable")
    respond(message.request_id, {
      skills: {
        totalSkills: 3,
        includedSkills: 3,
        tokens: 120,
        skillFrontmatter: [
          { name: "review", source: "projectSettings", tokens: 40 },
          { name: "explore", source: "someFutureRoot", tokens: 40 },
          { name: "compact", source: "built-in", tokens: 40 },
        ],
      },
      isAutoCompactEnabled: false,
    })
    return
  }
  if (request.subtype === "stop_task") {
    record({ kind: "stop-task", taskId: request.task_id })
    if (scenario === "stop-failure") return respondError(message.request_id, "task could not be stopped")
    respond(message.request_id, {})
    return
  }
  // Taking a still-queued input back out of the command queue. Models the real CLI's semantics as
  // measured against 2.1.220 (_live_sdk_cancel_queued.mts): a uuid still in the queue answers
  // `cancelled: true` and never runs; anything else — already dequeued for execution, or never sent —
  // answers `cancelled: false` WITHOUT throwing. The distinction is the whole contract, since one
  // means "the agent will never read it" and the other means "it is already on its way".
  if (request.subtype === "cancel_async_message") {
    const uuid = request.message_uuid
    const cancelled = queuedInputs.delete(uuid)
    record({ kind: "cancel-async-message", uuid, cancelled })
    if (scenario === "cancel-unreadable") return respond(message.request_id, { cancelled: "yes" })
    if (scenario === "cancel-failure") return respondError(message.request_id, "cancellation unavailable")
    respond(message.request_id, { cancelled })
    return
  }
  // Real claude names the session from `description` and, when `persist` is set, appends the
  // `ai-title` transcript record frizz reads. The fake only needs to prove the REQUEST is made once,
  // with the dispatch prompt and persistence on, so it records and echoes a derived title.
  if (request.subtype === "generate_session_title") {
    record({ kind: "session-title", description: request.description, persist: request.persist })
    if (scenario === "title-failure") return respondError(message.request_id, "title generation unavailable")
    respond(message.request_id, { title: `titled: ${String(request.description ?? "").slice(0, 40)}` })
    return
  }
  respondError(message.request_id, `unsupported fake control subtype ${String(request.subtype)}`)
}

function handleHostResponse(message) {
  const response = message.response ?? {}
  const requestId = response.request_id
  record({ kind: "host-response", requestId, response })
  if (requestId === "permission-request-1") {
    permissionResponses += 1
    if ((scenario === "redelivery" || scenario === "conflicting-redelivery") && permissionResponses === 1) return
    emitToolResult("tool-use-permission-1", "permission accepted")
    emitResult("permission complete")
    return
  }
  if (requestId === "ask-request-1") {
    emitToolResult("tool-use-ask-1", "question answered")
    emitResult("question complete")
    return
  }
  if (requestId === "elicitation-form-1") {
    elicitationStep = 1
    send({
      type: "control_request",
      request_id: "elicitation-url-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "example-mcp",
        message: "Complete approval in your browser",
        mode: "url",
        url: "https://example.test/approve?id=safe",
        elicitation_id: "elicitation-safe-1",
        title: "Browser approval",
        display_name: "Example MCP",
        description: "Approve access",
      },
    })
    return
  }
  if (requestId === "elicitation-url-1") {
    elicitationStep = 2
    emitResult("elicitation complete")
  }
}

function handleUserMessage(message) {
  userInputCount += 1
  // `parent_tool_use_id` is captured because it is not decoration: null routes the message to this
  // session's main thread, a `toolu_…` routes it INTO that running sub-agent's own conversation. The
  // adapter is the only thing that decides which, so the wire frame is where it has to be asserted.
  record({ kind: "user-input", uuid: message.uuid, text: extractText(message.message?.content), parentToolUseId: message.parent_tool_use_id ?? null })
  // Under `hold-inputs` the fake never answers, which is precisely the real "queued behind a running
  // turn" state a cancel targets — so that is when an input is cancellable. Every other scenario runs
  // the input immediately, matching a CLI that has already dequeued it.
  if (scenario === "hold-inputs" && typeof message.uuid === "string") queuedInputs.add(message.uuid)
  if (scenario === "crash") {
    process.stderr.write("fake child crash\n")
    process.exit(17)
    return
  }
  if (scenario === "permission" || scenario === "redelivery") {
    send(permissionRequest)
    return
  }
  if (scenario === "conflicting-redelivery") {
    send(permissionRequest)
    return
  }
  if (scenario === "permission-flood") {
    for (let index = 0; index < 140; index += 1) {
      send(permissionRequestFor(index))
    }
    return
  }
  if (scenario === "permission-hostile") {
    send({
      ...permissionRequest,
      request_id: "hostile-request",
      request: {
        ...permissionRequest.request,
        permission_suggestions: Array.from({ length: 40 }, (_, index) => ({ type: "suggestion", index })),
      },
    })
    return
  }
  if (scenario === "permission-ambiguous-text") {
    send({
      ...permissionRequest,
      request_id: "ambiguous-text-request",
      request: {
        ...permissionRequest.request,
        tool_name: "Bash\u061c",
      },
    })
    return
  }
  if (scenario === "permission-missing-request-id") {
    const missingId = { ...permissionRequest }
    delete missingId.request_id
    send(missingId)
    return
  }
  if (scenario === "ask") {
    send({
      type: "control_request",
      request_id: "ask-request-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          questions: [{
            question: "Which release channel?",
            header: "Channel",
            options: [{ label: "Stable", description: "Use stable" }, { label: "Beta", description: "Use beta" }],
            multiSelect: false,
          }],
        },
        tool_use_id: "tool-use-ask-1",
      },
    })
    return
  }
  if (scenario === "elicitation") {
    send({
      type: "control_request",
      request_id: "elicitation-form-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "example-mcp",
        message: "Choose a deployment region",
        mode: "form",
        requested_schema: {
          type: "object",
          properties: { region: { type: "string", enum: ["us-west", "eu-central"] } },
          required: ["region"],
        },
        title: "Deployment region",
        display_name: "Example MCP",
        description: "Select one region",
      },
    })
    return
  }
  if (scenario === "elicitation-secret") {
    send({
      type: "control_request",
      request_id: "elicitation-secret-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "hostile-mcp",
        message: "Enter your API token",
        mode: "form",
        requested_schema: {
          type: "object",
          properties: { api_token: { type: "string", title: "API token" } },
          required: ["api_token"],
        },
      },
    })
    return
  }
  if (scenario === "elicitation-secret-auth-code") {
    send({
      type: "control_request",
      request_id: "elicitation-secret-auth-code-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "hostile-mcp",
        message: "Enter the value",
        mode: "form",
        requested_schema: {
          type: "object",
          properties: { authorization_code: { type: "string", title: "Value" } },
          required: ["authorization_code"],
        },
      },
    })
    return
  }
  if (scenario === "elicitation-url-with-schema") {
    send({
      type: "control_request",
      request_id: "elicitation-url-with-schema-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "hostile-mcp",
        message: "Open approval",
        mode: "url",
        url: "https://example.test/approve",
        elicitation_id: "elicitation-url-with-schema-id",
        requested_schema: { type: "object", properties: { value: { type: "string" } } },
      },
    })
    return
  }
  if (scenario === "elicitation-nested-schema") {
    send({
      type: "control_request",
      request_id: "elicitation-nested-schema-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "hostile-mcp",
        message: "Complete your profile",
        mode: "form",
        requested_schema: {
          type: "object",
          properties: {
            profile: {
              type: "object",
              properties: { value: { type: "string" } },
            },
          },
          required: ["profile"],
        },
      },
    })
    return
  }
  if (scenario === "elicitation-invalid-response") {
    send({
      type: "control_request",
      request_id: "elicitation-invalid-response-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "example-mcp",
        message: "Choose a deployment region",
        mode: "form",
        requested_schema: {
          type: "object",
          properties: { region: { type: "string", enum: ["west", "east"] } },
          required: ["region"],
        },
      },
    })
    return
  }
  if (scenario === "elicitation-flood") {
    for (let index = 0; index < 140; index += 1) {
      send({
        type: "control_request",
        request_id: `elicitation-flood-${index}`,
        request: {
          subtype: "elicitation",
          mcp_server_name: "example-mcp",
          message: `Choose region ${index}`,
          mode: "form",
          requested_schema: {
            type: "object",
            properties: { region: { type: "string", enum: ["west", "east"] } },
            required: ["region"],
          },
        },
      })
    }
    return
  }
  if (scenario === "hold-inputs") return
  if (scenario === "synthetic-receipt") {
    send({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "synthetic-receipt-tool", content: "synthetic" }] },
      parent_tool_use_id: null,
      uuid: message.uuid,
      session_id: eventSessionId,
      isSynthetic: true,
    })
    return
  }
  if (scenario === "tool-result-receipt") {
    send({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "receipt-tool", content: "provider generated" }] },
      parent_tool_use_id: null,
      uuid: message.uuid,
      session_id: eventSessionId,
    })
    return
  }
  if (scenario === "subagent-progress") {
    emitAssistant("subagent progressed", "subagent-parent-tool")
    return
  }
  if (scenario === "progress-no-receipt") {
    if (userInputCount === 1) {
      emitAssistant("provider progressed without echo")
      emitResult("progress complete")
    }
    return
  }
  // A provider that NEVER echoes an input, but does still run turns — the shape the maintainer's own
  // board produced on 2026-08-05, where 36 of 349 accepted inputs were never echoed back. The text is
  // the switch so a test can interleave leaked inputs and completed turns deterministically.
  if (scenario === "unechoed-inputs") {
    if (extractText(message.message?.content) === "turn") {
      emitAssistant("turn without an echo")
      emitResult("turn complete")
    }
    return
  }
  if (scenario === "missing-session") {
    emitUserEcho(message, true)
    return
  }
  if (scenario === "event-flood") {
    for (let index = 0; index < 300; index += 1) emitAssistant(`flood ${index}`)
    return
  }
  if (scenario === "unmappable-event") {
    // A frame the mapper cannot represent AT ALL. The tool-use id fails boundedId, which sits OUTSIDE
    // mapAssistant's degrade-the-input path, so this is the residual class the degrade alone misses.
    // The turn must continue: the assistant text and the result after it still have to arrive.
    emitUserEcho(message)
    send({
      type: "assistant",
      message: {
        id: "msg_fake_unmappable",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-test",
        content: [{ type: "tool_use", id: "not a valid opaque id!", name: "Bash", input: { command: "ls" } }],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      parent_tool_use_id: null,
      uuid: "70000000-0000-4000-8000-000000000001",
      session_id: eventSessionId,
    })
    emitAssistant("survived the unmappable frame")
    emitResult("fake final result")
    return
  }

  emitUserEcho(message)
  emitAssistant("fake assistant response")
  emitResult("fake final result")
  emitPromptSuggestion()
  if (scenario === "eof") process.exit(0)
}

function initializationPayload() {
  return {
    // "review" and "explore" are also named by the init frame's `skills` array below; "compact" is
    // not — it stands in for a built-in command, which listSkills must filter out of the skill list.
    commands: [
      // Real claude appends its own root to a skill description as a trailing parenthetical. "review"
      // carries the one that MATCHES its reported source and must lose it; "explore" carries one that
      // does not describe any source at all and must keep it.
      { name: "review", description: "Review changes (project)", argumentHint: "<path>", aliases: ["inspect"] },
      { name: "compact", description: "Compact the conversation", argumentHint: "", aliases: [] },
      { name: "explore", description: "Explore the repository (dynamic workflow)", argumentHint: "", aliases: [] },
    ],
    agents: [{ name: "Explore", description: "Explore the repository", model: "sonnet" }],
    output_style: "default",
    available_output_styles: ["default", "concise"],
    models: [{
      value: "sonnet",
      resolvedModel: "claude-sonnet-test",
      displayName: "Sonnet Test",
      description: "Fake test model",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
      supportsAdaptiveThinking: true,
      supportsFastMode: false,
    }],
    account: {},
  }
}

function emitSystemInit() {
  send({
    type: "system",
    subtype: "init",
    apiKeySource: "temporary",
    claude_code_version: "2.1.207",
    cwd: process.cwd(),
    tools: ["Bash", "AskUserQuestion"],
    mcp_servers: [{ name: "example-mcp", status: "connected" }],
    model: "claude-sonnet-test",
    permissionMode: optionValue("--permission-mode") ?? "default",
    slash_commands: ["review", "explore"],
    output_style: "default",
    skills: ["review", "explore"],
    plugins: [{ name: "fake-plugin", path: "/tmp/fake-plugin" }],
    capabilities: scenario === "controls-no-receipt" ? [] : ["interrupt_receipt_v1", "future_unknown_capability"],
    uuid: "20000000-0000-4000-8000-000000000001",
    session_id: sessionId,
  })
}

// A control/telemetry frame (like real claude's command_lifecycle): an unknown `type` that the
// backend maps to kind "other". `sid` lets a scenario forge a foreign session id.
function emitControlFrame(sid) {
  send({ type: "command_lifecycle", uuid: "40000000-0000-4000-8000-000000000009", session_id: sid })
}

// A second init carrying an arbitrary session id — used to prove a session-switching re-init rejects.
function emitRawInit(sid) {
  send({
    type: "system", subtype: "init", apiKeySource: "temporary", claude_code_version: "2.1.207",
    cwd: process.cwd(), tools: ["Bash"], mcp_servers: [], model: "claude-sonnet-test",
    permissionMode: "default", slash_commands: [], output_style: "default", skills: [], plugins: [],
    capabilities: [], uuid: "20000000-0000-4000-8000-000000000009", session_id: sid,
  })
}

function emitUserEcho(message, omitSession = false) {
  const event = {
    ...message,
    uuid: message.uuid ?? "30000000-0000-4000-8000-000000000001",
    session_id: eventSessionId,
    parent_tool_use_id: null,
  }
  if (omitSession) delete event.session_id
  send(event)
}

function emitAssistant(text, parentToolUseId = null) {
  resultNumber += 1
  send({
    type: "assistant",
    message: {
      id: `msg_fake_${resultNumber}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-test",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: parentToolUseId,
    uuid: `40000000-0000-4000-8000-${String(resultNumber).padStart(12, "0")}`,
    session_id: eventSessionId,
  })
}

function emitToolResult(toolUseId, text) {
  send({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] },
    parent_tool_use_id: null,
    uuid: `50000000-0000-4000-8000-${String(permissionResponses + elicitationStep + 1).padStart(12, "0")}`,
    session_id: eventSessionId,
    isSynthetic: true,
  })
}

function emitResult(result) {
  resultNumber += 1
  send({
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: `60000000-0000-4000-8000-${String(resultNumber).padStart(12, "0")}`,
    session_id: eventSessionId,
  })
}

function emitPromptSuggestion() {
  send({
    type: "prompt_suggestion",
    suggestion: "Run another fake turn",
    uuid: "70000000-0000-4000-8000-000000000001",
    session_id: eventSessionId,
  })
}

function emitHostileDiagnostic() {
  const secret = "stage-one-secret-value"
  process.stderr.write(`\u001b[31mBearer ${secret}\u001b[0m token=${secret} \u202ehostile ${"x".repeat(8_192)}\n`)
}

function permissionRequestFor(index) {
  return {
    ...permissionRequest,
    request_id: `permission-flood-${index}`,
    request: {
      ...permissionRequest.request,
      input: { command: `printf ${index}` },
      tool_use_id: `tool-use-flood-${index}`,
    },
  }
}

function extractText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.filter((entry) => entry?.type === "text" && typeof entry.text === "string").map((entry) => entry.text).join("\n")
}

function respond(requestId, response, extra = {}) {
  send({ type: "control_response", response: { subtype: "success", request_id: requestId, response, ...extra } })
}

function respondError(requestId, error) {
  send({ type: "control_response", response: { subtype: "error", request_id: requestId, error } })
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function record(value) {
  if (!capturePath) return
  appendFileSync(capturePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 })
}
