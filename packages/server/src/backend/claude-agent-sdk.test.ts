import { createRequire } from "node:module"
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import assert from "node:assert/strict"
import * as claudeRuntime from "@frizz/claude-agent-sdk-runtime"
import { claudeWorkerEnv } from "./types.ts"
import {
  CLAUDE_AGENT_SDK_FOUNDATION_FLAG,
  createClaudeDiagnosticRedactor,
  createClaudeQueryFactory,
  claudeAgentSdkFoundationEnabled,
  sanitizeProviderChildEnvironment,
  mapAssistant,
  mapTask,
  type ClaudeQueryHandle,
} from "./claude-agent-sdk.ts"
import {
  CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES,
  CLAUDE_AGENT_SDK_MAX_INPUT_BYTES,
  ClaudeAgentSdkProtocolError,
  boundedJsonObject,
  utf8Bytes,
  type ClaudeDiagnostic,
  type ClaudeQueryEvent,
} from "./claude-agent-sdk-protocol.ts"
import { CLAUDE_AGENT_SDK_VERSION } from "../runtimes.ts"

/** A flag's value in either spelling the SDK has used: `--flag value` (≤ 0.3.207) or `--flag=value` (0.3.260+). */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index >= 0) return argv[index + 1]
  return argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
}

const serverRequire = createRequire(import.meta.url)
const runtimePackagePath = fileURLToPath(new URL("../../../claude-agent-sdk-runtime/package.json", import.meta.url))
const runtimeRequire = createRequire(runtimePackagePath)
const sdkEntry = runtimeRequire.resolve("@anthropic-ai/claude-agent-sdk")
const sdkPackage = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf8")) as {
  version?: string
  optionalDependencies?: Record<string, string>
}
const runtimePackage = JSON.parse(readFileSync(runtimePackagePath, "utf8")) as { dependencies?: Record<string, string> }
const runtimeZodPackage = JSON.parse(readFileSync(runtimeRequire.resolve("zod/package.json"), "utf8")) as { version?: string }
const serverZodPackage = JSON.parse(readFileSync(serverRequire.resolve("zod/package.json"), "utf8")) as { version?: string }
const fakeExecutable = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const INPUT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

interface CaptureRecord {
  kind: string
  [key: string]: unknown
}

interface Harness {
  dir: string
  capturePath: string
  diagnostics: ClaudeDiagnostic[]
  handle: ClaudeQueryHandle
  close(): Promise<void>
}

test("Agent SDK and its Zod 4 peer are pinned behind a runtime-only membrane while the server remains on Zod 3", () => {
  assert.equal(sdkPackage.version, CLAUDE_AGENT_SDK_VERSION)
  assert.equal(runtimePackage.dependencies?.["@anthropic-ai/claude-agent-sdk"], CLAUDE_AGENT_SDK_VERSION)
  assert.equal(runtimePackage.dependencies?.zod, "4.4.3")
  assert.equal(runtimeZodPackage.version, "4.4.3")
  assert.match(serverZodPackage.version ?? "", /^3\./)
  assert.notEqual(runtimeRequire.resolve("zod"), serverRequire.resolve("zod"))
  assert.deepEqual(Object.keys(claudeRuntime), ["query"], "no Zod schema or provider union crosses the runtime membrane")
  assert.deepEqual(sdkPackage.optionalDependencies, {
    "@anthropic-ai/claude-agent-sdk-linux-x64": CLAUDE_AGENT_SDK_VERSION,
    "@anthropic-ai/claude-agent-sdk-linux-arm64": CLAUDE_AGENT_SDK_VERSION,
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl": CLAUDE_AGENT_SDK_VERSION,
    "@anthropic-ai/claude-agent-sdk-linux-arm64-musl": CLAUDE_AGENT_SDK_VERSION,
    "@anthropic-ai/claude-agent-sdk-darwin-x64": CLAUDE_AGENT_SDK_VERSION,
    "@anthropic-ai/claude-agent-sdk-darwin-arm64": CLAUDE_AGENT_SDK_VERSION,
    "@anthropic-ai/claude-agent-sdk-win32-x64": CLAUDE_AGENT_SDK_VERSION,
    "@anthropic-ai/claude-agent-sdk-win32-arm64": CLAUDE_AGENT_SDK_VERSION,
  })
  assert.equal(claudeAgentSdkFoundationEnabled({}), false)
  assert.equal(claudeAgentSdkFoundationEnabled({ [CLAUDE_AGENT_SDK_FOUNDATION_FLAG]: "true" }), false)
  assert.equal(claudeAgentSdkFoundationEnabled({ [CLAUDE_AGENT_SDK_FOUNDATION_FLAG]: "1" }), true)
  assert.throws(
    () => createClaudeQueryFactory({ executablePath: fakeExecutable }),
    (error: unknown) => error instanceof ClaudeAgentSdkProtocolError && /disabled/.test(error.message),
  )
})

test("real SDK + fake executable: init owns the requested session, input streams, and trailing events follow result", { timeout: 10_000 }, async () => {
  // The four *_Present flags below are now INHERITANCE-dependent (a worker gets the operator's
  // environment — see worker-env.ts), so a developer whose shell exports GITHUB_TOKEN would otherwise
  // flip this assertion. Clearing them through the override path keeps the baseline deterministic AND
  // exercises buildEnvironment's delete branch. The worker caps are the same hazard inverted: in
  // production the BRIDGE spreads claudeWorkerEnv() into the daemon env and the foundation inherits
  // it, so a test process outside a frizz worker has no CLAUDE_CODE_MAX_* at all — until 2026-08-24
  // this test read them from ambient env and only passed INSIDE a dispatched worker (first caught by
  // a suite run on a plain Linux box). claudeWorkerEnv({}) is the bridge's spread at its defaults.
  const harness = startHarness("basic", {
    ANTHROPIC_BASE_URL: "https://api.example.test",
    GITHUB_TOKEN: undefined,
    OPENAI_API_KEY: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    ARBITRARY_SECRET: undefined,
    // The SAME hazard as the caps below, one variable later and from the OTHER direction: the bridge
    // spreads claudeCompactionEnv(settings) into a real daemon's env, so a suite run INSIDE a
    // dispatched frizz worker inherits CLAUDE_CODE_AUTO_COMPACT_WINDOW and captures it here, while a
    // run on a plain box does not. Cleared, so the baseline is the same in both places.
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined,
    ...claudeWorkerEnv({}),
  })
  try {
    const control = await withTimeout(harness.handle.initializationResult(), "initialization result")
    // VERBATIM, trailing "(project)" and all. The initialize mapping is the raw provider surface; the
    // one place a redundant source suffix is dropped is listSkills, which is the only caller that also
    // renders a source column beside it.
    assert.deepEqual(control.commands[0], {
      name: "review",
      description: "Review changes (project)",
      argumentHint: "<path>",
      aliases: ["inspect"],
    })
    assert.equal(control.models[0]?.resolvedModel, "claude-sonnet-test")

    const ready = await withTimeout(harness.handle.ready(), "session init")
    assert.equal(ready.sessionId, SESSION_ID)
    assert.equal(ready.claudeCodeVersion, "2.1.207")
    assert.deepEqual(ready.capabilities, ["interrupt_receipt_v1", "future_unknown_capability"])

    await harness.handle.send({ id: INPUT_ID, text: "hello from streaming input" })
    const events = await collectThrough(harness.handle, "prompt-suggestion")
    assert.deepEqual(events.map((event) => event.kind), ["init", "user", "assistant", "result", "prompt-suggestion"])
    assert.equal(events.find((event) => event.kind === "result")?.kind, "result")
    assert.equal((events.find((event) => event.kind === "result") as Extract<ClaudeQueryEvent, { kind: "result" }>).result, "fake final result")
    assert.equal((events.at(-1) as Extract<ClaudeQueryEvent, { kind: "prompt-suggestion" }>).suggestion, "Run another fake turn")

    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "user-input"))
    const startup = records.find((row) => row.kind === "startup") as CaptureRecord
    const argv = startup.argv as string[]
    assert.deepEqual(argv.slice(0, 5), ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"])
    assert.ok(argv.includes("--no-session-persistence"))
    // EVERY scope, which is what a plain `claude` in the same cwd reads: the repo's own CLAUDE.md /
    // AGENTS.md and .claude/skills, and the operator's own `~/.claude` settings. This pinned the empty
    // (fully hermetic) form until 2026-07-26, when a measured differential showed the broker — by then
    // the DEFAULT Claude transport — was answering `NO-CLAUDE-MD` where a plain `claude -p` in the same
    // cwd read the project's first heading. That fix restored project+local only, so the operator's own
    // scope stayed dark in broker sessions until 2026-08-16; see the factory for that differential.
    assert.ok(argv.includes("--setting-sources=user,project,local"), `argv had: ${argv.filter((a) => a.startsWith("--setting-sources")).join(",") || "no --setting-sources flag"}`)
    assert.equal(flagValue(argv, "--session-id"), SESSION_ID)
    assert.deepEqual(startup.environment, {
      frizzFakeInheritedPresent: false,
      frizzFakeOverridePresent: false,
      clientApp: "frizz/claude-agent-sdk-foundation",
      // The SDK's own marker for how it launched the CLI, observed rather than set: Frizz never reads
      // or writes CLAUDE_CODE_ENTRYPOINT, and the fixture only echoes it back. It rode in this snapshot
      // as `sdk-ts` until the 0.3.261 bump renamed it to `sdk-cli` (2026-09-05). It stays asserted
      // because the value of this deepEqual is that it is TOTAL — every variable the CLI receives is
      // named here, which is what makes "no secret leaked" a proof rather than a spot check — so a
      // vendor rename should land as a visible diff, not be waved through by a loosened matcher.
      entrypoint: "sdk-cli",
      pathPresent: true,
      homePresent: true,
      nodeOptionsPresent: false,
      anthropicApiKeyPresent: false,
      anthropicBaseUrlPresent: true,
      anthropicAuthTokenPresent: false,
      oauthTokenPresent: false,
      githubTokenPresent: false,
      openaiApiKeyPresent: false,
      awsSecretAccessKeyPresent: false,
      frizzSecretPresent: false,
      arbitrarySecretPresent: false,
      // The lifted worker caps, from claudeWorkerEnv() — WORKER_MAX_WEB_SEARCHES /
      // WORKER_MAX_SUBAGENTS / WORKER_MAX_CONCURRENT_SUBAGENTS in types.ts, against provider defaults
      // of 200 / 200 / 20. Asserted by VALUE and inside this exhaustive deepEqual on purpose: the caps
      // reach a worker through the environment and nothing else, so a silently dropped one is invisible
      // until some long session starts refusing to spawn sub-agents hours in.
      maxWebSearches: "10000",
      maxSubagents: "10000",
      maxConcurrentSubagents: "100",
    })
    assert.deepEqual(records.find((row) => row.kind === "user-input"), {
      kind: "user-input",
      uuid: INPUT_ID,
      text: "hello from streaming input",
      // An ordinary send is a MAIN-THREAD turn and must stay one. `null` here is the whole guarantee
      // that adding sub-agent addressing did not quietly re-route every follow-up frizz sends.
      parentToolUseId: null,
    })
  } finally {
    await harness.close()
  }
})

// The same guarantee as the `nodeOptionsPresent: false` / shim-free PATH assertions above, but stated
// against a WINDOWS-SHAPED environment, which no POSIX host can produce for the fixture. Windows spells
// its search path `Path` and matches variable names without case; the plain object buildEnvironment()
// copies out of process.env does NOT emulate that, so a case-sensitive `delete env.NODE_OPTIONS` /
// `env.PATH` filter no-opped there and left nub's `node` shim first on the child's PATH — where it
// rebuilds NODE_OPTIONS for the bare `node` the SDK spawns a script provider with (2026-08-24).
test("host runtime injection is stripped whatever case the OS spells its variables in", () => {
  const shim = join(tmpdir(), "nub-node-shim-4242-deadbeef")
  const real = join(tmpdir(), "real-bin")
  for (const [pathKey, optionsKey] of [["PATH", "NODE_OPTIONS"], ["Path", "Node_Options"]] as const) {
    const sanitized = sanitizeProviderChildEnvironment({
      [pathKey]: [shim, real].join(delimiter),
      [optionsKey]: "--require /nub/preload.cjs",
      HOME: "/home/x",
    })
    assert.equal(sanitized[optionsKey], undefined, `${optionsKey} must never reach a provider child`)
    assert.equal(sanitized[pathKey], real, `${pathKey} must lose the nub node shim, and keep its own spelling`)
    assert.deepEqual(Object.keys(sanitized).sort(), [pathKey, "HOME"].sort(), "no second, differently-cased PATH")
    assert.equal(sanitized.HOME, "/home/x", "nothing else is touched")
  }
})

test("listSkills intersects the initialize command list with the init frame's skills array", { timeout: 10_000 }, async () => {
  const harness = startHarness("basic")
  try {
    await withTimeout(harness.handle.ready(), "session init")
    // The fixture's initialize response carries THREE commands ("review", "compact", "explore") and
    // its init frame names only "review" and "explore" as skills: the built-in stand-in must not
    // surface as a skill. Each carries the source `get_context_usage` reported for it — "review" from
    // a root frizz maps, "explore" from an invented one that must degrade to no label rather than a
    // wrong one. "compact" has a source too and still must not appear.
    const skills = await withTimeout(harness.handle.listSkills(), "skill listing")
    assert.deepEqual(skills, [
      // "review" arrives as "Review changes (project)" and loses the suffix, because the column is
      // about to say the same thing. "explore" keeps "(dynamic workflow)": it is a parenthetical, not
      // a source, and nothing frizz renders would contradict it.
      { name: "review", description: "Review changes", source: "project" },
      { name: "explore", description: "Explore the repository (dynamic workflow)", source: undefined },
    ])
    // The source map is memoized: a second listing must not re-ask for the context usage, which is a
    // real ~1.2s round trip against a live CLI.
    await withTimeout(harness.handle.listSkills(), "second skill listing")
    assert.equal(readCapture(harness.capturePath).filter((row) => row.kind === "context-usage").length, 1)
  } finally {
    await harness.close()
  }
})

test("listSkills still answers when the harness cannot report where its skills came from", { timeout: 10_000 }, async () => {
  const harness = startHarness("context-usage-failure")
  try {
    await withTimeout(harness.handle.ready(), "session init")
    // The source is decoration. Losing it must cost the labels and NOTHING else — a typeahead that
    // fails shut here would read to the operator as a thread with no skills at all.
    const skills = await withTimeout(harness.handle.listSkills(), "skill listing")
    assert.deepEqual(skills, [
      // With no source to render, "(project)" is the only thing telling the operator where this came
      // from — so it stays. The suffix is only redundant next to a column that repeats it.
      { name: "review", description: "Review changes (project)", source: undefined },
      { name: "explore", description: "Explore the repository (dynamic workflow)", source: undefined },
    ])
  } finally {
    await harness.close()
  }
})

test("stopTask reaches the provider control channel with the exact runtime task id", { timeout: 10_000 }, async () => {
  const harness = startHarness("basic")
  try {
    await harness.handle.ready()
    await harness.handle.stopTask("agent-task-123")
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "stop-task"))
    assert.deepEqual(
      records.filter((row) => row.kind === "stop-task").map((row) => row.taskId),
      ["agent-task-123"],
    )
    await assert.rejects(() => harness.handle.stopTask("../unsafe task"), /not a valid opaque id/)
  } finally {
    await harness.close()
  }
})

test("session init mismatch fails ownership before exposing provider events", { timeout: 10_000 }, async () => {
  const harness = startHarness("mismatch")
  try {
    await assert.rejects(harness.handle.initializationResult(), /session ownership mismatch/)
    await assert.rejects(harness.handle.ready(), /session ownership mismatch/)
    await assert.rejects(harness.handle.next(), /session ownership mismatch/)
    assert.ok(harness.diagnostics.some((event) => event.kind === "lifecycle" && event.phase === "crashed"))
  } finally {
    await harness.close()
  }
})

test("resume selection uses the explicit owned UUID and never falls back to a new session", { timeout: 10_000 }, async () => {
  const harness = startHarness("basic", {}, {}, { kind: "resume", sessionId: SESSION_ID })
  try {
    assert.equal((await harness.handle.ready()).sessionId, SESSION_ID)
    await harness.handle.send({ id: INPUT_ID, text: "resume input" })
    await collectThrough(harness.handle, "result")
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "user-input"))
    const argv = records.find((row) => row.kind === "startup")?.argv as string[]
    assert.equal(flagValue(argv, "--resume"), SESSION_ID)
    assert.equal(flagValue(argv, "--session-id"), undefined)
  } finally {
    await harness.close()
  }
})

test("initialization capabilities remain hidden when the provider never establishes session ownership", { timeout: 10_000 }, async () => {
  const harness = startHarness("no-init")
  const initialization = harness.handle.initializationResult()
  try {
    await assert.rejects(withTimeout(initialization, "withheld initialization", 150), /timed out/)
  } finally {
    await harness.close()
  }
  await assert.rejects(initialization)
})

test("a same-session re-init is RELAYED (real claude re-emits init every turn) and the stream continues", { timeout: 10_000 }, async () => {
  const harness = startHarness("duplicate-init")
  try {
    await harness.handle.ready()
    const init = await harness.handle.next()
    assert.equal(init.value?.kind, "init")
    // The provider re-emits init for the SAME session at each turn, and each one is SURFACED: it is the
    // only frame that names the session's resolved model, and that alias is what picks this thread's row
    // out of `result.modelUsage` — the sole source of the context meter's denominator. It used to be
    // swallowed here, which announced the alias once per DAEMON lifetime; a broker daemon outlives the
    // frizz server, so every reattached thread lost its context readout permanently.
    const reinit = await harness.handle.next()
    assert.equal(reinit.value?.kind, "init")
    assert.equal(reinit.value?.kind === "init" && reinit.value.model, "claude-sonnet-test")
    // …and it stays a control marker rather than a new session: the pre-init ownership guard is NOT
    // re-armed, so the substantive event after it is delivered instead of rejected.
    const next = await harness.handle.next()
    assert.equal(next.value?.kind, "result")
  } finally {
    await harness.close()
  }
})

test("control frames that precede the session init are tolerated (same session) and init still owns the stream", { timeout: 10_000 }, async () => {
  const harness = startHarness("preinit-control")
  try {
    const ready = await harness.handle.ready()
    assert.equal(ready.kind, "init") // the pre-init control frame was swallowed; init resolved ready
    const init = await harness.handle.next()
    assert.equal(init.value?.kind, "init") // and init is still the FIRST event a consumer sees
  } finally {
    await harness.close()
  }
})

test("a pre-init control frame from a DIFFERENT session is rejected (ownership before init)", { timeout: 10_000 }, async () => {
  const harness = startHarness("preinit-mismatch")
  try {
    await assert.rejects(harness.handle.ready(), /session ownership mismatch/)
  } finally {
    await harness.close()
  }
})

test("a SUBSTANTIVE event before init is rejected even from the owned session", { timeout: 10_000 }, async () => {
  const harness = startHarness("preinit-substantive")
  try {
    await assert.rejects(harness.handle.ready(), /non-init event before session ownership/)
  } finally {
    await harness.close()
  }
})

test("a re-init that switches to a different session id is rejected", { timeout: 10_000 }, async () => {
  const harness = startHarness("cross-session-reinit")
  try {
    await harness.handle.ready()
    const init = await harness.handle.next()
    assert.equal(init.value?.kind, "init")
    await assert.rejects(harness.handle.next(), /session ownership mismatch/)
  } finally {
    await harness.close()
  }
})

test("every post-init provider event must carry the owned session id", { timeout: 10_000 }, async () => {
  const harness = startHarness("missing-session")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "missing session" })
    const init = await harness.handle.next()
    assert.equal(init.value?.kind, "init")
    await assert.rejects(harness.handle.next(), /missing session ownership/)
  } finally {
    await harness.close()
  }
})

test("a later provider event cannot cross the initialized session boundary", { timeout: 10_000 }, async () => {
  const harness = startHarness("late-mismatch")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "cross session" })
    const init = await harness.handle.next()
    assert.equal(init.value?.kind, "init")
    await assert.rejects(harness.handle.next(), /crossed session ownership/)
  } finally {
    await harness.close()
  }
})

test("canUseTool request and structured allow response traverse the real SDK control channel", { timeout: 10_000 }, async () => {
  let observedRequest: unknown
  const harness = startHarness("permission", {}, {
    canUseTool: async (request) => {
      observedRequest = request
      return {
        behavior: "allow",
        updatedInput: { ...request.input, approvedBy: "frizz-test" },
        updatedPermissions: [{
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "printf *" }],
          behavior: "allow",
          destination: "session",
        }],
      }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "request permission" })
    const events = await collectThrough(harness.handle, "result")
    assert.ok(events.some((event) => event.kind === "user" && event.toolResultIds.includes("tool-use-permission-1")))
    assert.deepEqual(observedRequest, {
      requestId: "permission-request-1",
      toolUseId: "tool-use-permission-1",
      agentId: "agent-main",
      toolName: "Bash",
      input: { command: "printf safe" },
      blockedPath: "/tmp/outside",
      decisionReason: "outside the working directory",
      title: "Run a safe command",
      displayName: "Run command",
      description: "Print a test marker",
      suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "printf *" }], behavior: "allow", destination: "session" }],
    })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "host-response"))
    const response = records.find((row) => row.kind === "host-response")?.response as Record<string, unknown>
    assert.deepEqual(response.response, {
      behavior: "allow",
      updatedInput: { command: "printf safe", approvedBy: "frizz-test" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "printf *" }], behavior: "allow", destination: "session" }],
      toolUseID: "tool-use-permission-1",
    })
  } finally {
    await harness.close()
  }
})

test("AskUserQuestion preserves original questions and returns the exact updatedInput answer contract", { timeout: 10_000 }, async () => {
  const harness = startHarness("ask", {}, {
    canUseTool: async (request) => {
      assert.equal(request.toolName, "AskUserQuestion")
      const questions = request.input.questions
      assert.ok(Array.isArray(questions))
      return {
        behavior: "allow",
        updatedInput: {
          questions,
          answers: { "Which release channel?": "Stable" },
        },
      }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "ask me" })
    await collectThrough(harness.handle, "result")
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.requestId === "ask-request-1" && row.kind === "host-response"))
    const response = records.find((row) => row.requestId === "ask-request-1" && row.kind === "host-response")?.response as {
      response?: { updatedInput?: Record<string, unknown>; toolUseID?: string }
    }
    assert.deepEqual(response.response?.updatedInput, {
      questions: [{
        question: "Which release channel?",
        header: "Channel",
        options: [{ label: "Stable", description: "Use stable" }, { label: "Beta", description: "Use beta" }],
        multiSelect: false,
      }],
      answers: { "Which release channel?": "Stable" },
    })
    assert.equal(response.response?.toolUseID, "tool-use-ask-1")
  } finally {
    await harness.close()
  }
})

test("form and URL MCP elicitation callbacks both traverse the real SDK control channel", { timeout: 10_000 }, async () => {
  const modes: Array<string | undefined> = []
  const harness = startHarness("elicitation", {}, {
    onElicitation: async (request) => {
      modes.push(request.mode)
      if (request.mode === "form") {
        assert.deepEqual(request.requestedSchema, {
          type: "object",
          properties: { region: { type: "string", enum: ["us-west", "eu-central"] } },
          required: ["region"],
        })
        return { action: "accept", content: { region: "us-west" } }
      }
      assert.equal(request.url, "https://example.test/approve?id=safe")
      assert.equal(request.elicitationId, "elicitation-safe-1")
      return { action: "accept" }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "elicit" })
    await collectThrough(harness.handle, "result")
    assert.deepEqual(modes, ["form", "url"])
    const records = await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => row.kind === "host-response").length >= 2)
    const form = records.find((row) => row.requestId === "elicitation-form-1")?.response as { response?: unknown }
    const url = records.find((row) => row.requestId === "elicitation-url-1")?.response as { response?: unknown }
    assert.deepEqual(form.response, { action: "accept", content: { region: "us-west" } })
    assert.deepEqual(url.response, { action: "accept" })
  } finally {
    await harness.close()
  }
})

test("reinitialize reuses the cached decision for a same-id same-payload permission redelivery", { timeout: 10_000 }, async () => {
  const calls: string[] = []
  const harness = startHarness("redelivery", {}, {
    canUseTool: async (request) => {
      calls.push(request.requestId)
      return { behavior: "allow", updatedInput: request.input }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "redeliver" })
    await waitFor(() => calls.length === 1, "first permission callback")
    await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => row.kind === "host-response" && row.requestId === "permission-request-1").length === 1)

    const refreshed = await harness.handle.reinitialize()
    assert.equal(refreshed.outputStyle, "default")
    await collectThrough(harness.handle, "result")
    assert.deepEqual(calls, ["permission-request-1"])
    const records = readCapture(harness.capturePath)
    assert.equal(records.filter((row) => row.kind === "host-response" && row.requestId === "permission-request-1").length, 2)
    assert.equal(records.filter((row) => row.kind === "host-control" && row.subtype === "initialize").length, 2)
  } finally {
    await harness.close()
  }
})

test("same permission request id with a conflicting redelivery payload fails closed", { timeout: 10_000 }, async () => {
  const calls: string[] = []
  const harness = startHarness("conflicting-redelivery", {}, {
    canUseTool: async (request) => {
      calls.push(String(request.input.command))
      return { behavior: "allow", updatedInput: request.input }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "conflict" })
    await waitFor(() => calls.length === 1, "first conflicting permission callback")
    await harness.handle.reinitialize()
    const records = await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => row.kind === "host-response" && row.requestId === "permission-request-1").length >= 2)
    assert.deepEqual(calls, ["printf safe"])
    const second = records.filter((row) => row.kind === "host-response" && row.requestId === "permission-request-1")[1]?.response as { subtype?: string; error?: string }
    assert.equal(second.subtype, "error")
    assert.match(second.error ?? "", /conflict/i)
  } finally {
    await harness.close()
  }
})

test("a permission control request without requestId fails before entering the host callback", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("permission-missing-request-id", {}, {
    canUseTool: async () => {
      calls += 1
      return { behavior: "allow" }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "missing request id" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "host-response"))
    assert.equal(calls, 0)
    const response = records.find((row) => row.kind === "host-response")?.response as { subtype?: string; error?: string }
    assert.equal(response.subtype, "error")
    assert.match(response.error ?? "", /requestId|request id|text/i)
  } finally {
    await harness.close()
  }
})

test("provider-consumed input cannot bypass UUID backpressure or duplicate protection", { timeout: 10_000 }, async () => {
  const harness = startHarness("hold-inputs")
  try {
    await harness.handle.ready()
    for (let index = 0; index < 64; index += 1) {
      await harness.handle.send({ id: inputId(index), text: `queued ${index}` })
    }
    await assert.rejects(harness.handle.send({ id: inputId(0), text: "duplicate" }), /already outstanding/)
    await assert.rejects(harness.handle.send({ id: inputId(64), text: "overflow" }), /outstanding input limit/)
  } finally {
    await harness.close()
  }
})

// The counterpart to the test above, and the reason it has to stay narrow. That one pins the bound
// against a flood inside ONE turn, which is real backpressure; this one pins that the same bound can
// never become a LIFETIME budget, which is what it silently was.
//
// A provider that accepts an input without ever echoing it leaks the slot, and enough leaks wedge the
// session for good: no input → no turn → no `assistant`/`result` → no release → no input. Measured on
// the maintainer's own board 2026-08-05 on thread `are-taking-over-an-in-flight-epic` — the set filled
// at 19:25:05Z and every delivery after it, 21 heartbeats and the operator's own messages alike, was
// refused for the remaining life of the daemon while frizz recorded each one as delivered.
test("inputs the provider will never echo cannot wedge the session for good", { timeout: 20_000 }, async () => {
  const harness = startHarness("unechoed-inputs")
  try {
    await harness.handle.ready()
    // 62 leaked slots: accepted by the provider, never echoed, never releasable by any event.
    for (let index = 0; index < 62; index += 1) {
      await harness.handle.send({ id: inputId(index), text: "hold" })
    }
    // Two completed main-thread turns pass under them. An input queued before a turn boundary is
    // consumed at that boundary, so after two of them an unechoed input's echo is never coming.
    for (const index of [62, 63]) {
      await harness.handle.send({ id: inputId(index), text: "turn" })
      await collectThrough(harness.handle, "result")
    }
    // Each turn's assistant frame released exactly one oldest slot, so the set refills almost at once.
    await harness.handle.send({ id: inputId(64), text: "hold" })
    await harness.handle.send({ id: inputId(65), text: "hold" })
    // Full again — and before the fix this was the send that never came back, for the rest of the
    // session. The stale slots are reclaimed here instead, at SEND time, which is the only point in
    // the cycle the deadlock leaves reachable.
    await harness.handle.send({ id: inputId(66), text: "hold" })
    const reclaimed = harness.diagnostics.find(
      (event) => event.kind === "stderr" && /reclaimed \d+ outstanding input slot/.test(event.message),
    )
    assert.ok(reclaimed, "reclaiming a dead slot is reported, since an unechoed input may never have been read")
    // …and it stays reachable: the recovered budget is the real one, not a single extra send.
    for (let index = 67; index < 100; index += 1) {
      await harness.handle.send({ id: inputId(index), text: "hold" })
    }
  } finally {
    await harness.close()
  }
})

// A SUB-AGENT STEER is one addressed input frame and nothing else — there is no per-agent control
// request in the SDK (`stopTask` / `backgroundTasks` are the whole per-task surface). So the ONE thing
// the adapter must get right is which value lands in `parent_tool_use_id`: null keeps the message on
// the session's main thread (every follow-up frizz has ever sent, which must stay byte-identical), and
// the child's dispatch tool_use id routes it into that child's own conversation. Asserted on the wire
// frame the CLI actually reads, because that is where the routing decision is consumed.
test("addressing an input routes it to the sub-agent; omitting it stays a main-thread turn", { timeout: 10_000 }, async () => {
  const harness = startHarness("hold-inputs")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: inputId(0), text: "main thread" })
    await harness.handle.send({ id: inputId(1), text: "steer the child", parentToolUseId: "toolu_child_01" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => row.kind === "user-input").length === 2)
    const inputs = records.filter((row) => row.kind === "user-input")
    assert.equal(inputs[0]?.parentToolUseId, null, "an unaddressed send is the main turn, exactly as before")
    assert.equal(inputs[1]?.parentToolUseId, "toolu_child_01", "the steer carries the child's dispatch id")
  } finally {
    await harness.close()
  }
})

test("an addressing id is validated as an opaque provider id, never passed through raw", { timeout: 10_000 }, async () => {
  const harness = startHarness("hold-inputs")
  try {
    await harness.handle.ready()
    await assert.rejects(
      harness.handle.send({ id: inputId(2), text: "hostile", parentToolUseId: "toolu bad id" }),
      /not a valid opaque id/,
    )
  } finally {
    await harness.close()
  }
})

test("an exact provider receipt releases an input UUID for deliberate reuse", { timeout: 10_000 }, async () => {
  const harness = startHarness("basic")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "first use" })
    await collectThrough(harness.handle, "user")
    await harness.handle.send({ id: INPUT_ID, text: "second use after receipt" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => row.kind === "user-input" && row.uuid === INPUT_ID).length === 2)
    assert.equal(records.filter((row) => row.kind === "user-input" && row.uuid === INPUT_ID).length, 2)
  } finally {
    await harness.close()
  }
})

test("a synthetic user-role event cannot spoof an outstanding input UUID receipt", { timeout: 10_000 }, async () => {
  const harness = startHarness("synthetic-receipt")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "keep this outstanding" })
    const events = await collectThrough(harness.handle, "user")
    const synthetic = events.find((event) => event.kind === "user") as Extract<ClaudeQueryEvent, { kind: "user" }>
    assert.equal(synthetic.synthetic, true)
    assert.equal(synthetic.messageId, INPUT_ID)
    await assert.rejects(harness.handle.send({ id: INPUT_ID, text: "spoofed duplicate" }), /already outstanding/)
  } finally {
    await harness.close()
  }
})

test("an unmarked tool-result event cannot spoof an outstanding input UUID receipt", { timeout: 10_000 }, async () => {
  const harness = startHarness("tool-result-receipt")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "keep tool result outstanding" })
    const events = await collectThrough(harness.handle, "user")
    const toolResult = events.find((event) => event.kind === "user") as Extract<ClaudeQueryEvent, { kind: "user" }>
    assert.equal(toolResult.synthetic, false)
    assert.deepEqual(toolResult.toolResultIds, ["receipt-tool"])
    await assert.rejects(harness.handle.send({ id: INPUT_ID, text: "tool-result duplicate" }), /already outstanding/)
  } finally {
    await harness.close()
  }
})

test("subagent assistant progress cannot release a main-thread outstanding input", { timeout: 10_000 }, async () => {
  const harness = startHarness("subagent-progress")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "main-thread input" })
    const events = await collectThrough(harness.handle, "assistant")
    const assistant = events.find((event) => event.kind === "assistant") as Extract<ClaudeQueryEvent, { kind: "assistant" }>
    assert.equal(assistant.parentToolUseId, "subagent-parent-tool")
    await assert.rejects(harness.handle.send({ id: INPUT_ID, text: "subagent-spoofed duplicate" }), /already outstanding/)
  } finally {
    await harness.close()
  }
})

test("provider progression without an echo releases only the progressed outstanding input", { timeout: 10_000 }, async () => {
  const harness = startHarness("progress-no-receipt")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "progress" })
    await harness.handle.send({ id: inputId(1), text: "still queued" })
    await collectThrough(harness.handle, "assistant")
    await collectThrough(harness.handle, "result")
    await harness.handle.send({ id: INPUT_ID, text: "reused after progression" })
    await assert.rejects(harness.handle.send({ id: inputId(1), text: "must remain outstanding" }), /already outstanding/)
  } finally {
    await harness.close()
  }
})

test("interrupt receipt and live permission-mode change are capability/control-channel grounded", { timeout: 10_000 }, async () => {
  const harness = startHarness("controls")
  try {
    const init = await harness.handle.ready()
    assert.ok(init.capabilities.includes("interrupt_receipt_v1"))
    assert.deepEqual(await harness.handle.interrupt(), {
      stillQueued: ["11111111-1111-4111-8111-111111111111", "internal-queue-id"],
    })
    await harness.handle.setPermissionMode("auto")
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "host-control" && row.subtype === "set_permission_mode"))
    assert.ok(records.some((row) => row.kind === "host-control" && row.subtype === "interrupt"))
    assert.ok(records.some((row) => row.kind === "host-control" && row.subtype === "set_permission_mode" && row.mode === "auto"))
  } finally {
    await harness.close()
  }
})

test("older/no-receipt capability returns undefined instead of fabricating queue state", { timeout: 10_000 }, async () => {
  const harness = startHarness("controls-no-receipt")
  try {
    const init = await harness.handle.ready()
    assert.deepEqual(init.capabilities, [])
    assert.equal(await harness.handle.interrupt(), undefined)
  } finally {
    await harness.close()
  }
})

test("clean EOF completes the event iterator after result and trailing events", { timeout: 10_000 }, async () => {
  const harness = startHarness("eof")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "finish" })
    await collectThrough(harness.handle, "prompt-suggestion")
    assert.deepEqual(await withTimeout(harness.handle.next(), "EOF"), { done: true, value: undefined })
    assert.ok(harness.diagnostics.some((event) => event.kind === "lifecycle" && event.phase === "closed"))
  } finally {
    await harness.close()
  }
})

test("subprocess crash rejects the iterator without transparent respawn", { timeout: 10_000 }, async () => {
  const harness = startHarness("crash")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "crash" })
    const init = await harness.handle.next()
    assert.equal(init.value?.kind, "init")
    await assert.rejects(withTimeout(harness.handle.next(), "crash"), /Claude SDK process failed/)
    assert.ok(harness.diagnostics.some((event) => event.kind === "lifecycle" && event.phase === "crashed"))
    const starts = readCapture(harness.capturePath).filter((row) => row.kind === "startup")
    assert.equal(starts.length, 1, "the SDK did not silently respawn the fake child")
  } finally {
    await harness.close()
  }
})

test("explicit close ends stdin and cleans up the fake subprocess", { timeout: 10_000 }, async () => {
  const harness = startHarness("close")
  await harness.handle.ready()
  await harness.handle.close()
  try {
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "stdin-end" || row.kind === "signal"))
    assert.ok(records.some((row) => row.kind === "stdin-end" || row.kind === "signal"))
    assert.ok(harness.diagnostics.some((event) => event.kind === "lifecycle" && event.phase === "closed"))
  } finally {
    rmSync(harness.dir, { recursive: true, force: true })
  }
})

test("close is one shared idempotent operation and all send/control entry points fail once closing starts", { timeout: 10_000 }, async () => {
  const harness = startHarness("close")
  await harness.handle.ready()
  const firstClose = harness.handle.close()
  const secondClose = harness.handle.close()
  assert.equal(firstClose, secondClose)
  await Promise.all([firstClose, secondClose])
  await assert.rejects(harness.handle.send({ id: INPUT_ID, text: "too late" }), /closed/)
  await assert.rejects(harness.handle.initializationResult(), /closed/)
  await assert.rejects(harness.handle.reinitialize(), /closed/)
  await assert.rejects(harness.handle.interrupt(), /closed/)
  await assert.rejects(harness.handle.setPermissionMode("auto"), /closed/)
  rmSync(harness.dir, { recursive: true, force: true })
})

test("an in-flight control request cannot win a race with close", { timeout: 10_000 }, async () => {
  const harness = startHarness("hanging-control")
  await harness.handle.ready()
  const interrupt = harness.handle.interrupt()
  await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "host-control" && row.subtype === "interrupt"))
  const close = harness.handle.close()
  await assert.rejects(interrupt, /closed/)
  await withTimeout(close, "close racing control")
  rmSync(harness.dir, { recursive: true, force: true })
})

test("form elicitation rejects secret-like fields before invoking the host callback", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("elicitation-secret", {}, {
    onElicitation: async () => {
      calls += 1
      return { action: "decline" }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "request secret" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "host-response" && row.requestId === "elicitation-secret-1"))
    assert.equal(calls, 0)
    const response = records.find((row) => row.requestId === "elicitation-secret-1")?.response as { subtype?: string; error?: string }
    assert.equal(response.subtype, "error")
    assert.match(response.error ?? "", /secret|sensitive|URL/i)
  } finally {
    await harness.close()
  }
})

test("form elicitation treats authorization-code fields as secret even under an innocuous title", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("elicitation-secret-auth-code", {}, {
    onElicitation: async () => {
      calls += 1
      return { action: "decline" }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "request auth code" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.requestId === "elicitation-secret-auth-code-1"))
    assert.equal(calls, 0)
    const response = records.find((row) => row.requestId === "elicitation-secret-auth-code-1")?.response as { subtype?: string }
    assert.equal(response.subtype, "error")
  } finally {
    await harness.close()
  }
})

test("URL elicitation rejects a confused form schema before invoking the host callback", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("elicitation-url-with-schema", {}, {
    onElicitation: async () => {
      calls += 1
      return { action: "accept" }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "confused elicitation" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.requestId === "elicitation-url-with-schema-1"))
    assert.equal(calls, 0)
    const response = records.find((row) => row.requestId === "elicitation-url-with-schema-1")?.response as { subtype?: string }
    assert.equal(response.subtype, "error")
  } finally {
    await harness.close()
  }
})

test("form elicitation rejects nested provider schemas before invoking the host callback", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("elicitation-nested-schema", {}, {
    onElicitation: async () => {
      calls += 1
      return { action: "decline" }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "nested schema" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.requestId === "elicitation-nested-schema-1"))
    assert.equal(calls, 0)
    const response = records.find((row) => row.requestId === "elicitation-nested-schema-1")?.response as { subtype?: string }
    assert.equal(response.subtype, "error")
  } finally {
    await harness.close()
  }
})

test("form elicitation rejects callback content outside the advertised schema", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("elicitation-invalid-response", {}, {
    onElicitation: async () => {
      calls += 1
      return { action: "accept", content: { region: "north" } }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "invalid response" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.requestId === "elicitation-invalid-response-1"))
    assert.equal(calls, 1)
    const response = records.find((row) => row.requestId === "elicitation-invalid-response-1")?.response as { subtype?: string }
    assert.equal(response.subtype, "error")
  } finally {
    await harness.close()
  }
})

test("hostile permission metadata is rejected without entering the callback", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("permission-hostile", {}, {
    canUseTool: async (request) => {
      calls += 1
      return { behavior: "deny", message: String(request.requestId) }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "hostile request" })
    await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "host-response" && row.requestId === "hostile-request"))
    assert.equal(calls, 0)
  } finally {
    await harness.close()
  }
})

test("permission authority text is rejected rather than sanitized before host review", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("permission-ambiguous-text", {}, {
    canUseTool: async (request) => {
      calls += 1
      return { behavior: "deny", message: request.toolName }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "ambiguous tool" })
    await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.requestId === "ambiguous-text-request"))
    assert.equal(calls, 0)
  } finally {
    await harness.close()
  }
})

test("permission callback idempotency state is bounded under a request flood", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("permission-flood", {}, {
    canUseTool: async (request) => {
      calls += 1
      return { behavior: "allow", updatedInput: request.input }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "flood" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => row.kind === "host-response" && String(row.requestId).startsWith("permission-flood-")).length === 140)
    // The bound is on STATE, not on a session's lifetime allowance. These 140 requests SETTLE as they
    // go, so the map never holds more than the cap while every request is still served.
    //
    // This asserted `calls === 128` with 12 errors until 2026-07-27, which pinned the actual bug: the
    // cache only ever added entries, so after 128 DISTINCT ids a session rejected every further
    // permission for the rest of its life — a long orchestrator thread silently losing the ability to
    // run any approval-gated tool, with nothing the operator could see. The test could not tell a
    // burst from a lifetime, so the defect was protected by a test that looked like it covered it.
    //
    // A genuinely CONCURRENT flood — callbacks that never settle, so nothing can be evicted — must
    // still reject; that is the shape covered by the hanging-callback test below.
    assert.equal(calls, 140, "every settled request is served; the cap is a concurrency budget")
    assert.equal(records.filter((row) => {
      const response = row.response as { subtype?: string } | undefined
      return row.kind === "host-response" && String(row.requestId).startsWith("permission-flood-") && response?.subtype === "error"
    }).length, 0, "and none are refused just because the session has been busy")
  } finally {
    await harness.close()
  }
})

test("hanging elicitation callbacks are concurrency-bounded under a provider flood", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("elicitation-flood", {}, {
    onElicitation: async () => {
      calls += 1
      return new Promise(() => undefined)
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "flood elicitations" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => {
      const response = row.response as { subtype?: string } | undefined
      return row.kind === "host-response" && String(row.requestId).startsWith("elicitation-flood-") && response?.subtype === "error"
    }).length >= 12)
    assert.equal(calls, 128)
    assert.equal(records.filter((row) => {
      const response = row.response as { subtype?: string } | undefined
      return row.kind === "host-response" && String(row.requestId).startsWith("elicitation-flood-") && response?.subtype === "error"
    }).length, 12)
  } finally {
    await harness.close()
  }
})

test("closing aborts and detaches a permission callback that never settles", { timeout: 10_000 }, async () => {
  let callbackStarted = false
  let callbackAborted = false
  const harness = startHarness("permission", {}, {
    canUseTool: async (_request, context) => {
      callbackStarted = true
      context.signal.addEventListener("abort", () => { callbackAborted = true }, { once: true })
      return new Promise(() => undefined)
    },
  })
  await harness.handle.ready()
  await harness.handle.send({ id: INPUT_ID, text: "hang" })
  await waitFor(() => callbackStarted, "hanging callback")
  await withTimeout(harness.handle.close(), "close with hanging callback", 5_000)
  await waitFor(() => callbackAborted, "hanging callback abort")
  rmSync(harness.dir, { recursive: true, force: true })
})

test("a provider event flood trips the bounded output queue instead of retaining unbounded data", { timeout: 10_000 }, async () => {
  const harness = startHarness("event-flood")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "flood events" })
    await waitFor(() => harness.diagnostics.some((event) => event.kind === "lifecycle" && event.phase === "crashed"), "event flood failure")
    await assert.rejects(harness.handle.next(), /queue limit/)
  } finally {
    await harness.close()
  }
})

// A worker INHERITS the operator's environment and is denied only frizz's own control plane. This
// reverses the allowlist this test used to pin (it asserted GITHUB_TOKEN / OPENAI_API_KEY /
// AWS_SECRET_ACCESS_KEY / an arbitrary secret were all withheld); worker-env.ts carries the full
// reasoning, but the short version is that the allowlists had drifted apart between backends — proxy
// and CA variables reached codex workers and not claude ones — while withholding a token from a
// process that can read ~/.config/gh/hosts.yml was never a real boundary.
//
// What this test still guards is the part that IS load-bearing: FRIZZ_* never crosses, so a worker
// dispatched to work on frizz cannot read the broker's daemon payload or the launch identity, and the
// cc-worker hooks cannot pick up the SERVER's thread identity instead of their own.
test("child environment inherits ambient variables and withholds only frizz's own control plane", { timeout: 10_000 }, async () => {
  const ambient = {
    GITHUB_TOKEN: "github-should-cross",
    OPENAI_API_KEY: "openai-should-cross",
    AWS_SECRET_ACCESS_KEY: "aws-should-cross",
    ARBITRARY_SECRET: "arbitrary-should-cross",
    FRIZZ_SHOULD_NOT_LEAK: "frizz-must-not-cross",
  } as const
  const previous = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]))
  Object.assign(process.env, ambient)
  const harness = startHarness("basic", { ANTHROPIC_API_KEY: "explicit-anthropic-test-key" })
  try {
    await harness.handle.ready()
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "startup"))
    const environment = records.find((row) => row.kind === "startup")?.environment as Record<string, unknown>
    assert.equal(environment.anthropicApiKeyPresent, true, "an explicit override still lands")
    // Inherited, because the operator's shell is the worker's shell.
    assert.equal(environment.githubTokenPresent, true)
    assert.equal(environment.openaiApiKeyPresent, true)
    assert.equal(environment.awsSecretAccessKeyPresent, true)
    assert.equal(environment.arbitrarySecretPresent, true)
    // The one thing that must never cross.
    assert.equal(environment.frizzSecretPresent, false, "FRIZZ_* is frizz's control plane, not the operator's environment")
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await harness.close()
  }
})

test("stderr diagnostics are bounded, control-safe, and redact explicit secrets", { timeout: 10_000 }, async () => {
  const secret = "stage-one-secret-value"
  const harness = startHarness("diagnostic", { ANTHROPIC_API_KEY: secret })
  try {
    await harness.handle.ready()
    await waitFor(() => harness.diagnostics.some((event) => event.kind === "stderr"), "stderr diagnostic")
    const stderr = harness.diagnostics.filter((event): event is Extract<ClaudeDiagnostic, { kind: "stderr" }> => event.kind === "stderr")
    assert.ok(stderr.length > 0)
    for (const event of stderr) {
      assert.equal(event.message.includes(secret), false)
      assert.equal(/[\u001b\u202e]/u.test(event.message), false)
      assert.ok(utf8Bytes(event.message) <= CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES)
    }
    assert.ok(stderr.some((event) => event.message.includes("[REDACTED]")))
    assert.ok(stderr.some((event) => event.truncated))
    assert.equal(readFileSync(harness.capturePath, "utf8").includes(secret), false)
  } finally {
    await harness.close()
  }
})

test("thrown errors and stringified metadata redact CLI flags, userinfo, encoded URLs, quoting, and controls", () => {
  const fixtures = {
    user: "fixture-thrown-user-credential",
    password: "fixture thrown password credential",
    token: "fixture-thrown-token-credential",
    encoded: "%66%69%78%74%75%72%65-thrown-url-credential",
  }
  const redact = createClaudeDiagnosticRedactor({})
  const thrown = redact(new Error([
    `curl -u alice:${fixtures.user} --password="${fixtures.password}"`,
    `client --token=${fixtures.token}`,
    `https://bob%3A${fixtures.encoded}@example.test/private`,
    `control=${"\u001b"}[31m`,
  ].join("\n"))).message
  const metadata = redact({
    toString: () => JSON.stringify({
      command: `tool --secret ${fixtures.token}`,
      callback: `https://bob:${fixtures.user}@example.test/callback`,
    }),
  }).message

  for (const fixture of Object.values(fixtures)) {
    assert.equal(thrown.includes(fixture), false, fixture)
    assert.equal(metadata.includes(fixture), false, fixture)
  }
  assert.match(thrown, /curl -u alice:\[REDACTED\] --password=\[REDACTED\]/)
  assert.match(thrown, /--token=\[REDACTED\]/)
  assert.match(thrown, /https:\/\/bob%3A\[REDACTED\]@example\.test/)
  assert.equal(thrown.includes("\u001b"), false)
  assert.match(metadata, /--secret/)
  assert.match(metadata, /\[REDACTED\]/)
})

test("input, JSON, environment, and executable boundaries reject unsafe payloads before provider use", { timeout: 10_000 }, async () => {
  const harness = startHarness("close")
  try {
    await assert.rejects(
      harness.handle.send({ id: INPUT_ID, text: "x".repeat(CLAUDE_AGENT_SDK_MAX_INPUT_BYTES + 1) }),
      /input\.text exceeds/,
    )
    // A C0 control, not a format character. The example here used to be U+061C ARABIC LETTER MARK,
    // which a prompt body now legitimately carries: `validateInputMessage` was narrowed off the
    // display-grade class so that the U+200D every multi-part emoji is built from stops being
    // undeliverable (see claude-agent-sdk-protocol.test.ts). What this boundary still refuses is text
    // that cannot survive the wire, which is what the assertion is here to pin.
    await assert.rejects(
      harness.handle.send({ id: INPUT_ID, text: `unsafe${String.fromCodePoint(27)}input` }),
      /unsafe text/,
    )
    const tooDeep: Record<string, unknown> = {}
    let cursor = tooDeep
    for (let index = 0; index < 20; index += 1) {
      cursor.next = {}
      cursor = cursor.next as Record<string, unknown>
    }
    assert.throws(() => boundedJsonObject(tooDeep, "hostile"), /too complex/)
    const factory = createClaudeQueryFactory({ enabled: true, executablePath: fakeExecutable })
    assert.throws(() => factory.start({
      cwd: harness.dir,
      session: { kind: "new", sessionId: SESSION_ID },
      env: { "INVALID=KEY": "value" },
    }), /invalid key/)
    // No "not allowlisted" case any more: overrides are frizz's own, and the worker inherits the
    // operator's environment by design (worker-env.ts). The remaining guards below are the ones that
    // still catch a frizz BUG rather than an operator's choice — a malformed key, and a sensitive value
    // too short to redact safely.
    assert.throws(() => factory.start({
      cwd: harness.dir,
      session: { kind: "new", sessionId: SESSION_ID },
      env: { ANTHROPIC_API_KEY: "abc" },
    }), /too short/)
    assert.throws(() => factory.start({
      cwd: harness.dir,
      session: { kind: "new", sessionId: SESSION_ID },
      env: { ANTHROPIC_API_KEY: 123 as never },
    }), /must be text/)
    assert.throws(() => factory.start({
      cwd: `${harness.dir}\u061c`,
      session: { kind: "new", sessionId: SESSION_ID },
    }), /unsafe or oversized/)
    assert.throws(() => factory.start({
      cwd: harness.dir,
      session: { kind: "new", sessionId: SESSION_ID },
      permissionMode: { toString: () => "default" } as never,
    }), /unsupported/)
    assert.throws(() => createClaudeQueryFactory({ enabled: true, executablePath: join(harness.dir, "missing") }), /not executable/)
  } finally {
    await harness.close()
  }
})

function startHarness(
  scenario: string,
  env: Record<string, string | undefined> = {},
  callbacks: Pick<Parameters<ReturnType<typeof createClaudeQueryFactory>["start"]>[0], "canUseTool" | "onElicitation"> = {},
  session: Parameters<ReturnType<typeof createClaudeQueryFactory>["start"]>[0]["session"] = { kind: "new", sessionId: SESSION_ID },
  extra: Partial<Parameters<ReturnType<typeof createClaudeQueryFactory>["start"]>[0]> = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "frizz-claude-sdk-"))
  const capturePath = join(dir, "capture.jsonl")
  const executablePath = join(dir, `fake-claude--${scenario}.mjs`)
  copyFileSync(fakeExecutable, executablePath)
  chmodSync(executablePath, 0o700)
  const diagnostics: ClaudeDiagnostic[] = []
  const factory = createClaudeQueryFactory({ enabled: true, executablePath })
  const handle = factory.start({
    cwd: dir,
    session,
    env: {
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ...env,
    },
    ...callbacks,
    ...extra,
    onDiagnostic(event) {
      diagnostics.push(event)
    },
  })
  return {
    dir,
    capturePath,
    diagnostics,
    handle,
    async close() {
      await handle.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function inputId(index: number): string {
  return `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`
}

async function collectThrough(handle: ClaudeQueryHandle, kind: ClaudeQueryEvent["kind"]): Promise<ClaudeQueryEvent[]> {
  const events: ClaudeQueryEvent[] = []
  while (events.length < 32) {
    const next = await withTimeout(handle.next(), `event ${kind}`)
    if (next.done) throw new Error(`event stream ended before ${kind}`)
    events.push(next.value)
    if (next.value.kind === kind) return events
  }
  throw new Error(`event stream exceeded test bound before ${kind}`)
}

function readCapture(path: string): CaptureRecord[] {
  let contents = ""
  try {
    contents = readFileSync(path, "utf8")
  } catch {
    return []
  }
  return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CaptureRecord)
}

async function waitForCapture(path: string, predicate: (rows: CaptureRecord[]) => boolean): Promise<CaptureRecord[]> {
  let rows: CaptureRecord[] = []
  await waitFor(() => {
    rows = readCapture(path)
    return predicate(rows)
  }, "fake capture")
  return rows
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---- Session survival: a telemetry mapping failure must never end a session ----

const ASSISTANT_RAW = (input: Record<string, unknown>) => ({
  session_id: "11111111-2222-3333-4444-555555555555",
  uuid: "66666666-7777-8888-9999-000000000000",
  message: { content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input }] },
})

test("a tool input with a control character DEGRADES instead of killing the session", () => {
  // The live incident, 2026-07-27 07:03:55: a multi-hour orchestrator thread and every one of its
  // sub-agents destroyed by exactly this shape, because the mapper threw, the error propagated out of
  // the event iterator, and the broker daemon's pump treated any iterator error as terminal:
  //   lifecycle:crashed "assistant.content[0].input.command contains unsafe text"
  // A control character in a Bash command is trivially reachable — echoing terminal output, an ANSI
  // escape, anything binary. It must cost the ARGUMENTS of one telemetry event, never the session.
  const esc = String.fromCharCode(27)
  const event = mapAssistant(ASSISTANT_RAW({ command: `printf '${esc}[31mred${esc}[0m'` })) as Extract<ClaudeQueryEvent, { kind: "assistant" }>
  assert.equal(event.kind, "assistant")
  assert.equal(event.toolUses.length, 1, "the tool call is still reported")
  assert.equal(event.toolUses[0]!.name, "Bash", "id and name survive — only the arguments degrade")
  assert.ok("__frizzUnrepresentable" in event.toolUses[0]!.input, `input was ${JSON.stringify(event.toolUses[0]!.input)}`)
})

test("an ordinary tool input is untouched by the degrade path", () => {
  const event = mapAssistant(ASSISTANT_RAW({ command: "ls -la" })) as Extract<ClaudeQueryEvent, { kind: "assistant" }>
  assert.deepEqual(event.toolUses[0]!.input, { command: "ls -la" })
})

test("an UNMAPPABLE frame is dropped and the session keeps running", { timeout: 10_000 }, async () => {
  // The degrade above rescues the input; this rescues everything else. mapSdkMessage can still throw
  // for a frame whose id/name/shape is unrepresentable, and that throw used to reach pump()'s catch —
  // which calls sdkQuery.close(), killing the claude process and every in-flight sub-agent, and
  // reporting lifecycle:crashed. The broker's own error tolerance cannot help: by then the query is
  // already closed. So the skip has to live here, at the mapper call itself.
  //
  // Three real sessions died this way on 2026-07-27 (two "unsafe text", one "oversized text").
  const harness = startHarness("unmappable-event")
  try {
    await harness.handle.ready()
    assert.equal((await harness.handle.next()).value?.kind, "init")
    await harness.handle.send({ id: "11111111-1111-4111-8111-111111111111", text: "go" })
    const kinds: string[] = []
    for (;;) {
      const next = await withTimeout(harness.handle.next(), "unmappable-event stream")
      if (next.done) break
      kinds.push(next.value.kind)
      if (next.value.kind === "result") break
    }
    // The turn completed: the bad frame cost only itself.
    assert.ok(kinds.includes("result"), `stream ended without a result; saw ${kinds.join(",")}`)
    assert.ok(kinds.includes("assistant"), `the assistant text after the bad frame was lost; saw ${kinds.join(",")}`)
    // ...and the drop is reported rather than silent, so an operator can still see it happened.
    assert.ok(
      harness.diagnostics.some((d) => d.kind === "stderr" && /unmappable event dropped/.test(d.message)),
      `no drop diagnostic; saw ${JSON.stringify(harness.diagnostics)}`,
    )
    // The session must NOT have been torn down as a crash.
    assert.ok(
      !harness.diagnostics.some((d) => d.kind === "lifecycle" && d.phase === "crashed"),
      "a dropped telemetry frame reported lifecycle:crashed",
    )
  } finally {
    await harness.close()
  }
})

test("an unrepresentable PERMISSION input is denied, not thrown — content vs protocol", () => {
  // Same class as the assistant crash, on a hotter path: canUseTool fires precisely for risky tool
  // calls, which is exactly where Bash commands (and therefore ANSI escapes) live.
  //
  // The validator stays strict — this decides whether authority is granted, so sanitizing the bytes
  // the provider will act on would be a security bug. What changed is the CONSEQUENCE: an input frizz
  // cannot represent denies that one call instead of rejecting the SDK callback, which is how a
  // formatting problem used to become a dead session.
  const esc = String.fromCharCode(27)
  assert.throws(
    () => boundedJsonObject({ command: `printf '${esc}[31m'` }, "permission.input"),
    (e: unknown) => e instanceof ClaudeAgentSdkProtocolError && /unsafe text/.test((e as Error).message),
    "control bytes are still rejected — that strictness is deliberate and load-bearing",
  )
  // A protocol violation is a DIFFERENT case and must keep failing hard: with no requestId there is
  // no correlation id to answer against, so a deny would go nowhere. Pinned by the
  // "without requestId" test above.
  assert.doesNotThrow(() => boundedJsonObject({ command: "ls -la" }, "permission.input"))
})

// ---- Sub-agent task lifecycle: rich payload, and the same degrade contract ----
// These `system` messages are the ONLY place sub-agent progress exists — they are stream-only, absent
// from the session JSONL — so mapping them is what lets the board say what a child is doing. And they
// arrive carrying agent-authored strings (a description, a summary, a task's error text), which is
// exactly the class of value that killed a session on 2026-07-27. Every one of them degrades.

test("mapTask carries the whole sub-agent payload, not just two strings", () => {
  const event = mapTask({
    session_id: "11111111-2222-3333-4444-555555555555",
    uuid: "66666666-7777-8888-9999-000000000000",
    task_id: "task_abc",
    tool_use_id: "toolu_child",
    description: "Audit the tailer fold",
    subagent_type: "frizz:opus-high",
    last_tool_name: "Bash",
    summary: "running the live harness",
    usage: { total_tokens: 40123, tool_uses: 18, duration_ms: 92_000 },
  }, "progress")
  assert.equal(event.kind, "task")
  assert.equal(event.phase, "progress")
  assert.equal(event.taskId, "task_abc")
  assert.equal(event.toolUseId, "toolu_child")
  assert.equal(event.description, "Audit the tailer fold")
  assert.equal(event.subagentType, "frizz:opus-high")
  assert.equal(event.lastToolName, "Bash")
  assert.equal(event.summary, "running the live harness")
  assert.deepEqual(event.usage, { totalTokens: 40123, toolUses: 18, durationMs: 92_000 })
})

test("mapTask reads task_updated's status out of its patch", () => {
  const event = mapTask({ task_id: "t", patch: { status: "failed", description: "renamed", error: "boom" } }, "updated")
  assert.equal(event.status, "failed")
  assert.equal(event.description, "renamed")
  assert.equal(event.error, "boom")
})

test("mapTask DEGRADES every hostile field instead of throwing", () => {
  // A control character in a summary is the same shape as the control character in a Bash command that
  // destroyed a multi-hour thread — and a sub-agent's summary is agent-authored prose, so it is at
  // least as reachable. Nothing here may throw: `kind` and `phase` survive, bad fields drop out.
  const esc = String.fromCharCode(27)
  const event = mapTask({
    session_id: { not: "a string" },
    uuid: 42,
    description: "x".repeat(200_000), // far past the field cap
    summary: `${esc}[31mred${esc}[0m`, // the 2026-07-27 shape, in agent-authored prose
    last_tool_name: { nope: true }, // wrong type entirely
    usage: "not an object",
    patch: 7,
  }, "progress")
  assert.equal(event.kind, "task")
  assert.equal(event.phase, "progress")
  assert.equal(event.usage, undefined)
  assert.equal(event.lastToolName, undefined)
  assert.equal(event.sessionId, undefined)
  assert.ok((event.description?.length ?? 0) < 200_000, "an oversized description is truncated, not fatal")
  assert.ok(event.summary && !event.summary.includes(esc), "the control byte is sanitized out of the summary")
})

test("mapTask never throws, whatever the frame is", () => {
  // Exhaustive over the shapes a defensive mapper is expected to shrug at. The bar is not "correct
  // output" — it is "the session is still alive".
  for (const raw of [{}, { task_id: null }, { tasks: "no" }, { usage: [] }, { patch: null }, { task_id: [] }]) {
    for (const phase of ["started", "updated", "progress", "notification", "level"] as const) {
      assert.doesNotThrow(() => mapTask(raw as Record<string, unknown>, phase))
    }
  }
})

test("mapTask bounds the background_tasks_changed level set", () => {
  const tasks = Array.from({ length: 8 }, (_, i) => ({ task_id: `k${i}`, task_type: "agent", description: `child ${i}` }))
  const event = mapTask({ tasks }, "level")
  assert.equal(event.tasks?.length, 8)
  assert.equal(event.tasks?.[3]?.taskId, "k3")
  // Past the cap the whole list degrades to absent rather than growing without bound.
  const huge = mapTask({ tasks: Array.from({ length: 400 }, (_, i) => ({ task_id: `k${i}` })) }, "level")
  assert.equal(huge.tasks, undefined)
})

test("strictMcpConfig hands the CLI --strict-mcp-config, and the mounted servers ride --mcp-config", { timeout: 10_000 }, async () => {
  const harness = startHarness("strict-mcp", {}, {}, { kind: "new", sessionId: SESSION_ID }, {
    strictMcpConfig: true,
    mcpServers: { frizz: { command: process.execPath, args: ["/abs/frizz-mcp.mjs"] }, Neon: { type: "http", url: "https://mcp.example/mcp" } },
  })
  try {
    await harness.handle.ready()
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "startup"))
    const argv = (records.find((row) => row.kind === "startup") as CaptureRecord).argv as string[]
    // The flag is the whole point: with it the CLI discovers no `.mcp.json` and no user-scope server.
    assert.ok(argv.includes("--strict-mcp-config"), `argv had: ${argv.join(" ")}`)
    // The SDK may pass the config inline or as a file it wrote; either way the servers we mounted are in it.
    const value = argv[argv.indexOf("--mcp-config") + 1]!
    const cfg = JSON.parse(value.trimStart().startsWith("{") ? value : readFileSync(value, "utf8"))
    assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ["Neon", "frizz"])
  } finally {
    await harness.close()
  }
})
