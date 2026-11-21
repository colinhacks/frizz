import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { createClaudeBackend, parseClaudeLine } from "./claude.ts"
import { newTailState, computeTurn } from "../tailer.ts"
import { buildClaudeCommand, buildClaudeResumeCommand, claudeWorkerEnvironment, loadWorkerPrompt, WORKER_MAX_CONCURRENT_SUBAGENTS, WORKER_MAX_SUBAGENTS, WORKER_MAX_WEB_SEARCHES, workerPluginDir } from "../dispatch.ts"
import { CLAUDE_WORKER_ENV, claudeCompactionEnv, claudeCompactionWindowOf, claudePromptCacheEnv } from "./types.ts"

// ---- parseClaudeLine: the normalized VIEW of a Claude JSONL line (codex-facing seam; NOT the
// behavior-critical fold — that is foldLine → applyRecord, covered by tailer.test.ts). ----

test("parseClaudeLine: a malformed / non-object / blank line yields no events", () => {
  assert.deepEqual(parseClaudeLine("{not json"), [])
  assert.deepEqual(parseClaudeLine(""), [])
  assert.deepEqual(parseClaudeLine("   "), [])
  assert.deepEqual(parseClaudeLine("5"), [])
})

test("parseClaudeLine: an end_turn assistant emits final assistant-text + a turn-end carrying the final text", () => {
  const evs = parseClaudeLine(JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "all done\n\n```done\nshipped\n```" }] } }))
  assert.deepEqual(evs, [
    { kind: "assistant-text", at: "2026-07-01T00:00:01.000Z", text: "all done\n\n```done\nshipped\n```", final: true },
    { kind: "turn-end", at: "2026-07-01T00:00:01.000Z", finalText: "all done\n\n```done\nshipped\n```" },
  ])
})

test("parseClaudeLine: a tool_use assistant emits COMMENTARY text (final:false) + tool-call, no turn-end", () => {
  const evs = parseClaudeLine(JSON.stringify({ type: "assistant", timestamp: "t", message: { stop_reason: "tool_use", content: [{ type: "text", text: "let me check" }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] } }))
  assert.deepEqual(evs, [
    { kind: "assistant-text", at: "t", text: "let me check", final: false },
    { kind: "tool-call", at: "t", id: "toolu_1", name: "Bash", input: { command: "ls" } },
  ])
})

test("parseClaudeLine: a typed user prompt emits a real (non-synthetic) user-message", () => {
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "user", timestamp: "t", message: { content: "go do the thing" } })), [
    { kind: "user-message", at: "t", text: "go do the thing", synthetic: false },
  ])
})

test("parseClaudeLine: a promptSource:system user message is SYNTHETIC (peer / notification)", () => {
  const evs = parseClaudeLine(JSON.stringify({ type: "user", timestamp: "t", promptSource: "system", message: { content: "<task-notification>…</task-notification>" } }))
  assert.deepEqual(evs, [{ kind: "user-message", at: "t", text: "<task-notification>…</task-notification>", synthetic: true }])
})

test("parseClaudeLine: a slash-command isMeta user reminder is metadata, not a model turn", () => {
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "user", isMeta: true, timestamp: "t", message: { content: "Session title is now Readable" } })), [])
})

test("parseClaudeLine: a tool_result-only user record emits tool-result(s), NOT a user-message", () => {
  const evs = parseClaudeLine(JSON.stringify({ type: "user", timestamp: "t", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }] }] } }))
  assert.deepEqual(evs, [{ kind: "tool-result", at: "t", id: "toolu_1", text: "ok" }])
})

test("parseClaudeLine: a mixed user record (text + tool_result) emits BOTH the tool-result and a real user-message", () => {
  const evs = parseClaudeLine(JSON.stringify({ type: "user", timestamp: "t", message: { content: [{ type: "text", text: "note" }, { type: "tool_result", tool_use_id: "toolu_1", content: "done" }] } }))
  assert.deepEqual(evs, [
    { kind: "tool-result", at: "t", id: "toolu_1", text: "done" },
    { kind: "user-message", at: "t", synthetic: false },
  ])
})

test("parseClaudeLine: ai-title becomes a title event while native custom-title stays observation-only", () => {
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "ai-title", aiTitle: " Refined name " })), [{ kind: "title", title: "Refined name" }])
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "custom-title", customTitle: "machine-generated-slug" })), [])
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "ai-title", aiTitle: "   " })), [])
})

// ---- the ClaudeBackend facade (argv builders + path + fold + perm sniff) ----

test("createClaudeBackend: buildSpawn pins the session id + prompt and clears inherited profile overrides", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "sleep" })
  const { argv, env, prewrite } = backend.buildSpawn({ sessionId: "uuid-1", cwd: "/cwd", prompt: "hello", workerContract: "", extraSystemPrompt: undefined, permissionMode: "acceptEdits" })
  assert.equal(argv[0], "sleep")
  assert.equal(argv[1], "--session-id")
  assert.equal(argv[2], "uuid-1")
  assert.ok(argv.includes("--permission-mode"))
  assert.ok(argv.includes("acceptEdits"))
  assert.equal(argv[argv.length - 1], "hello")
  assert.deepEqual(env, {
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "infinite",
    BASH_MAX_TIMEOUT_MS: String(24 * 60 * 60 * 1000),
    CLAUDE_CODE_FORK_SUBAGENT: "0",
    CLAUDE_CODE_WEB_FETCH_AGENT: "0",
    CLAUDE_CODE_SUBAGENT_MODEL: "",
    CLAUDE_CODE_EFFORT_LEVEL: "",
    CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: String(WORKER_MAX_WEB_SEARCHES),
    CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: String(WORKER_MAX_SUBAGENTS),
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(WORKER_MAX_CONCURRENT_SUBAGENTS),
  })
  assert.deepEqual(prewrite, [])
})

test("createClaudeBackend sanitizes both spawn and resume without replacing Claude auth/config", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "claude" })
  const spawned = backend.buildSpawn({ sessionId: "profile-env-spawn", cwd: "/cwd", prompt: "P", workerContract: "", permissionMode: "auto", model: "opus", effort: "high" })
  const resumed = backend.buildResume({ sessionId: "profile-env-resume", cwd: "/cwd", message: "M", workerContract: "", permissionMode: "auto", model: "opus", effort: "high" })
  for (const built of [spawned, resumed]) {
    assert.deepEqual(built.env, {
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "infinite",
      BASH_MAX_TIMEOUT_MS: String(24 * 60 * 60 * 1000),
      CLAUDE_CODE_FORK_SUBAGENT: "0",
      CLAUDE_CODE_WEB_FETCH_AGENT: "0",
      CLAUDE_CODE_SUBAGENT_MODEL: "",
      CLAUDE_CODE_EFFORT_LEVEL: "",
      CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: String(WORKER_MAX_WEB_SEARCHES),
      CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: String(WORKER_MAX_SUBAGENTS),
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(WORKER_MAX_CONCURRENT_SUBAGENTS),
    })
    assert.equal("CLAUDE_CONFIG_DIR" in built.env, false, "auth/config variables are never replaced")
  }
})

test("Claude worker profile sanitization reaches the launch environment", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "claude" })
  const built = backend.buildSpawn({ sessionId: "profile-env", cwd: "/clean-home/project", prompt: "P", workerContract: "", permissionMode: "auto", model: "opus", effort: "high" })
  // buildSpawn's `env` IS the launch environment now: the broker hands it straight to the SDK query.
  // Every entry is silent when dropped — the worker just quietly quits early, or has a wait it sized
  // itself cut off at Claude Code's ten-minute ceiling — so pin them here.
  for (const [key, value] of Object.entries(CLAUDE_WORKER_ENV)) {
    assert.equal(built.env[key], value, `${key} must reach the launch environment`)
  }
  // The DEFAULT foreground timeout is Claude Code's own: Frizz pinned 60s until 2026-10-10.
  assert.equal("BASH_DEFAULT_TIMEOUT_MS" in built.env, false, "the default Bash timeout is left to Claude Code")
  assert.ok("CLAUDE_CODE_SUBAGENT_MODEL" in built.env)
  assert.ok("CLAUDE_CODE_EFFORT_LEVEL" in built.env)
  assert.equal(built.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION, String(WORKER_MAX_WEB_SEARCHES))
  assert.equal(built.env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION, String(WORKER_MAX_SUBAGENTS))
  assert.equal(built.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, String(WORKER_MAX_CONCURRENT_SUBAGENTS))
  assert.equal("CLAUDE_CONFIG_DIR" in built.env, false)
})

// The three QUIET caps a long-lived worker hits and a chat session does not. All three read
// `Z.<VAR> ?? <default>` through the same `int({min:1,digitsOnly:true})` parser in the real 2.1.220
// binary, so a non-digit override is silently discarded by Claude Code back to ITS default rather
// than honored — which is why frizz only passes an override through in exactly that shape:
//   · WebSearch (200): verified live — with the cap at 1 the second search returned "this session has
//     used its web search budget (1 of 1 WebSearch calls)" instead of results.
//   · Subagent spawns per session (200): past it every Task throws "Subagent spawn limit reached".
//   · Concurrent subagents (20): past it a spawn throws "Concurrent subagent limit reached… Do not
//     retry", so the tail of a wide fan-out is lost rather than queued.
const WORKER_CAPS: readonly (readonly [string, number])[] = [
  ["CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION", WORKER_MAX_WEB_SEARCHES],
  ["CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION", WORKER_MAX_SUBAGENTS],
  ["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", WORKER_MAX_CONCURRENT_SUBAGENTS],
]

test("claudeWorkerEnvironment: every cap clears Claude Code's default and honors only a well-formed override", () => {
  for (const [name, lifted] of WORKER_CAPS) {
    assert.equal(claudeWorkerEnvironment({})[name], String(lifted), `${name} is lifted when unset`)
    assert.ok(lifted > 20, `${name} must clear Claude Code's own default, not sit under it`)
    assert.equal(claudeWorkerEnvironment({ [name]: "750" })[name], "750", `${name}: operator policy wins`)
    // Each of these is rejected by Claude Code's own parser, so passing it through would silently
    // DROP the worker back to ITS default — the frizz value is the safer answer for every one of them.
    for (const bad of ["", "0", "-5", "1_000", "1e5", "20 ", "abc", "12.5", "+7"]) {
      assert.equal(
        claudeWorkerEnvironment({ [name]: bad })[name],
        String(lifted),
        `${name}: malformed override ${JSON.stringify(bad)} must fall back to the frizz default`,
      )
    }
  }
})

// The caps are read off the REAL process environment by default — the injectable arg above is a test
// seam, not the production path, so one var round-trips through process.env to pin that.
test("claudeWorkerEnvironment: lifts the WebSearch budget and honors only a well-formed operator override", () => {
  const original = process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION
  try {
    delete process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION
    assert.equal(claudeWorkerEnvironment().CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION, String(WORKER_MAX_WEB_SEARCHES))
    assert.ok(WORKER_MAX_WEB_SEARCHES > 200, "the whole point is to clear Claude Code's 200 default")

    process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = "750"
    assert.equal(claudeWorkerEnvironment().CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION, "750", "operator policy wins")

    // Each of these is rejected by Claude Code's own parser, so passing it through would silently
    // DROP the worker back to 200 — the frizz default is the safer answer for every one of them.
    for (const bad of ["", "0", "-5", "1_000", "1e5", "20 ", "abc", "12.5", "+7"]) {
      process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = bad
      assert.equal(
        claudeWorkerEnvironment().CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION,
        String(WORKER_MAX_WEB_SEARCHES),
        `malformed override ${JSON.stringify(bad)} must fall back to the frizz default`,
      )
    }
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION
    else process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = original
  }
})

test("createClaudeBackend: buildResume produces `-r <sessionId> <message>` and coerces plan mode to auto", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "claude" })
  const { argv } = backend.buildResume({ sessionId: "sid", cwd: "/cwd", message: "more", workerContract: "", permissionMode: "plan" })
  assert.deepEqual(argv.slice(0, 3), ["claude", "--permission-mode", "auto"]) // plan → auto coercion
  assert.deepEqual(argv.slice(-3), ["-r", "sid", "more"]) // pinned conversation + follow-up at the tail
})

test("createClaudeBackend: reattach forwards model+effort without fabricating a user prompt", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "claude" })
  const { argv } = backend.buildResume({ sessionId: "sid", cwd: "/cwd", workerContract: "", permissionMode: "bypassPermissions", model: "sonnet", effort: "xhigh" })
  assert.deepEqual(argv.slice(0, 3), ["claude", "--permission-mode", "bypassPermissions"])
  assert.deepEqual(argv.slice(-2), ["-r", "sid"], "the session id is the tail; no user prompt follows")
  assert.ok(argv.includes("--model") && argv.includes("sonnet"))
  assert.ok(argv.includes("--effort") && argv.includes("xhigh"))
})

test("createClaudeBackend: an ultracode dispatch spawns as xhigh + the ultracode session setting", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "claude" })
  for (const { label, argv } of [
    { label: "spawn", argv: backend.buildSpawn({ sessionId: "sid", cwd: "/cwd", prompt: "go", workerContract: "", permissionMode: "bypassPermissions", model: "opus", effort: "ultracode" }).argv },
    // Ultracode is SESSION-scoped, so a resume has to re-carry it exactly like the system prompt does.
    { label: "resume", argv: backend.buildResume({ sessionId: "sid", cwd: "/cwd", workerContract: "", permissionMode: "bypassPermissions", model: "opus", effort: "ultracode" }).argv },
  ]) {
    assert.equal(argv.includes("ultracode"), false, `${label}: "ultracode" is not an --effort value; the CLI would warn and drop it`)
    const effortIndex = argv.indexOf("--effort")
    assert.equal(argv[effortIndex + 1], "xhigh", `${label}: ultracode must pin xhigh — any other effort silently discards the setting`)
    const settingsIndex = argv.indexOf("--settings")
    assert.ok(settingsIndex !== -1, `${label}: the ultracode setting must ride the spawn`)
    assert.deepEqual(JSON.parse(argv[settingsIndex + 1]!), { ultracode: true })
  }
})

test("createClaudeBackend: transcriptPath is <logDir>/<sessionId>.jsonl", () => {
  // Spelled with join(), not "/logs/abc-123.jsonl": the backend joins, so the separator is the HOST's.
  assert.equal(createClaudeBackend({ logDir: "/logs" }).transcriptPath("abc-123"), join("/logs", "abc-123.jsonl"))
})

test("createClaudeBackend: foldLine folds a Claude record into the tail state; a bad line is a no-op", () => {
  const backend = createClaudeBackend({ logDir: "/logs" })
  const state = newTailState("t", "sid", "/logs/sid.jsonl")
  backend.foldLine(state, JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "hi there" }] } }))
  assert.equal(state.lastKind, "assistant")
  assert.equal(state.lastStopReason, "end_turn")
  assert.equal(state.lastAssistant, "hi there")
  assert.equal(state.model, "claude-opus-4-6", "assistant.message.model becomes session profile telemetry")
  assert.equal(state.effort, undefined, "Claude transcripts do not claim an unrecorded effort")
  backend.foldLine(state, "{not json") // defensive: never throws, no mutation
  assert.equal(state.lastAssistant, "hi there")
})

// The Phase-1 no-behavior-change guarantee, locked into the suite: the argv the injected backend
// builds (production path) must be BYTE-IDENTICAL to a direct legacy `buildClaude*` call (the path
// dispatch/resume take when no backend is injected). Regression fence against future backend edits.
test("createClaudeBackend: buildSpawn/buildResume argv == the legacy buildClaude* argv (byte-for-byte)", () => {
  // The stub keeps this fence hermetic: the production resolver reads the cwd's `.mcp.json` and the
  // operator's config, and `/cwd` here is not a real project.
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "claude", resolveProjectMcpServers: () => ({}) })
  const spawnCases = [
    { sessionId: "u1", permissionMode: "acceptEdits" as const, model: "opus", effort: "high", extra: "SCRATCHPAD: x" },
    { sessionId: "u2", permissionMode: "auto" as const, model: undefined, effort: undefined, extra: undefined },
    { sessionId: "u3", permissionMode: "plan" as const, model: "sonnet", effort: undefined, extra: "PLAN: y" }, // plan → auto coercion
  ]
  for (const c of spawnCases) {
    const direct = buildClaudeCommand({ sessionId: c.sessionId, permissionMode: c.permissionMode, model: c.model, effort: c.effort, prompt: "P", claudeBin: "claude", pluginDir: workerPluginDir(), extraSystemPrompt: c.extra })
    const built = backend.buildSpawn({ sessionId: c.sessionId, cwd: "/cwd", prompt: "P", workerContract: loadWorkerPrompt(), extraSystemPrompt: c.extra, permissionMode: c.permissionMode, model: c.model, effort: c.effort })
    assert.deepEqual(built.argv, direct, `spawn argv drift for ${c.sessionId}`)
  }
  const resumeCases = [
    { sessionId: "s1", permissionMode: "acceptEdits" as const, extra: "SCRATCHPAD: a" },
    { sessionId: "s2", permissionMode: "plan" as const, extra: undefined }, // plan → auto coercion
  ]
  for (const c of resumeCases) {
    const direct = buildClaudeResumeCommand({ sessionId: c.sessionId, permissionMode: c.permissionMode, message: "M", claudeBin: "claude", pluginDir: workerPluginDir(), extraSystemPrompt: c.extra })
    const built = backend.buildResume({ sessionId: c.sessionId, cwd: "/cwd", message: "M", workerContract: loadWorkerPrompt(), extraSystemPrompt: c.extra, permissionMode: c.permissionMode })
    assert.deepEqual(built.argv, direct, `resume argv drift for ${c.sessionId}`)
  }
})

// The normalized VIEW (parseLine) must not silently drift from the AUTHORITATIVE fold (foldLine →
// applyRecord → computeTurn): a `turn-end` event must appear exactly when the fold lands the turn idle
// on the clear (deterministic) stop_reasons.
test("parseClaudeLine's turn-end signal agrees with the authoritative fold (no drift)", () => {
  const backend = createClaudeBackend({ logDir: "/x" })
  const far = Date.parse("2026-07-01T01:00:00.000Z") // well past the 5s unknown-stop-reason backstop
  const cases = [
    { line: JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }), idle: true },
    { line: JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } }), idle: false },
    { line: JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:01.000Z", message: { content: "go" } }), idle: false },
  ]
  for (const c of cases) {
    const hasTurnEnd = parseClaudeLine(c.line).some((e) => e.kind === "turn-end")
    const st = newTailState("t", "s", "/x")
    backend.foldLine(st, c.line)
    assert.equal(computeTurn(st, far) === "idle", c.idle, `fold idle verdict for ${c.line}`)
    assert.equal(hasTurnEnd, c.idle, `normalized turn-end agrees with fold for ${c.line}`)
  }
})

// Settings.autoCompactWindow reaches a worker as CLAUDE_CODE_AUTO_COMPACT_WINDOW — the one lever that
// stops a `[1m]` worker from growing to 1M before it compacts (see the Settings schema). Unset, zero,
// negative or fractional ⇒ nothing is passed, so the CLI keeps its own per-model default.
test("claudeCompactionEnv: a positive integer window becomes CLAUDE_CODE_AUTO_COMPACT_WINDOW, anything else passes nothing", () => {
  assert.deepEqual(claudeCompactionEnv({ autoCompactWindow: 500_000 }), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" })
  assert.deepEqual(claudeCompactionEnv(undefined), {})
  assert.deepEqual(claudeCompactionEnv({}), {})
  assert.deepEqual(claudeCompactionEnv({ autoCompactWindow: 0 }), {})
  assert.deepEqual(claudeCompactionEnv({ autoCompactWindow: -1 }), {})
  assert.deepEqual(claudeCompactionEnv({ autoCompactWindow: 12.5 }), {})
})

// The cache tier: only the two values the CLI understands are passed, and each goes to the worker AND
// its sub-agents. "auto" and garbage pass nothing, so the CLI keeps its own choice.
test("claudePromptCacheEnv: 5m and 1h reach both the worker and its sub-agents, anything else passes nothing", () => {
  assert.deepEqual(claudePromptCacheEnv({ promptCacheTtl: "5m" }), {
    CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m",
  })
  assert.deepEqual(claudePromptCacheEnv({ promptCacheTtl: "1h" }), {
    CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "1h",
  })
  assert.deepEqual(claudePromptCacheEnv({ promptCacheTtl: "auto" }), {})
  assert.deepEqual(claudePromptCacheEnv({ promptCacheTtl: "10m" }), {})
  assert.deepEqual(claudePromptCacheEnv({}), {})
  assert.deepEqual(claudePromptCacheEnv(undefined), {})
})

// The same ceiling READ BACK OUT of the composed environment, which is how the number reaches the
// board: the daemon stamps it on its record at fork and the bridge lowers the context dial's
// denominator to it. Round-tripping through the env — rather than re-reading Settings when the dial is
// drawn — is the point: Settings moves while a forked daemon keeps what it was forked with.
test("claudeCompactionWindowOf: it round-trips what claudeCompactionEnv wrote, and reads junk as absent", () => {
  assert.equal(claudeCompactionWindowOf(claudeCompactionEnv({ autoCompactWindow: 500_000 })), 500_000)
  assert.equal(claudeCompactionWindowOf(claudeCompactionEnv({ autoCompactWindow: 200_000 })), 200_000)
  assert.equal(claudeCompactionWindowOf(undefined), undefined)
  assert.equal(claudeCompactionWindowOf({}), undefined, "an environment with no ceiling has none")
  for (const raw of ["", "0", "-1", "12.5", "500k", "abc", "Infinity"]) {
    assert.equal(claudeCompactionWindowOf({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: raw }), undefined, `"${raw}" must read as absent`)
  }
})
