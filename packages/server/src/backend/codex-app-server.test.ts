import { EventEmitter } from "node:events"
import { rmSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import assert from "node:assert/strict"
import Database from "../sqlite.ts"
import { createInteractionStore, InteractionStoreError } from "../interaction-store.ts"
import { createStorage, type SessionRow } from "../storage.ts"
import { directChildHost } from "./codex-app-server-host.ts"
import {
  CODEX_APP_SERVER_PROTOCOL_REVISION,
  CODEX_APP_SERVER_SUPPORTED_VERSION,
  CodexAppServerBridge,
  codexAppServerEnvironment,
  codexAppServerBridgeEnabled,
  selectCodexHostKind,
  type CodexAppServerProcess,
  type CodexAppServerSpawn,
} from "./codex-app-server.ts"

type Message = Record<string, unknown>

// Thread/turn ids are minted PROCESS-INDEPENDENTLY because the real app-server mints uuidv7s and never
// reuses one. Per-process counters silently handed a restarted fake the same `codex-turn-1`, which
// makes a restart test pass for the wrong reason (the "new" turn is indistinguishable from the dead one).
let nextProviderId = 0

class FakeAppServerProcess extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly inbound: Message[] = []
  readonly clientRequests: Message[] = []
  readonly clientResponses: Message[] = []
  private buffer = ""
  private activeTurn: { threadId: string; turnId: string } | null = null
  // When set, a turn/steer completes the turn (turn/completed) then rejects — modelling the turn
  // ending in the bridge's read→steer window, which must trigger followUp's start-fallback.
  rejectSteerAsEnded = false
  // How the fake answers turn/interrupt. "accept" is the real behavior (ack, then turn/completed).
  // "reject-ended" models the turn reaching its own ending in the read→RPC window: turn/completed
  // first, then the server rejects an interrupt for a turn it no longer runs. "reject-running"
  // rejects WITHOUT the turn ending — a rejection that must never read as a stop. "accept-no-end"
  // acks but never ends the turn.
  interruptBehavior: "accept" | "reject-ended" | "reject-running" | "accept-no-end" = "accept"
  killed = false
  readonly version: string
  afterInitializeResponse?: () => void
  afterThreadStartResponse?: () => void
  // What `thread/resume` reports about the thread's LIVE state: `{type:"active"}` while a turn is
  // still running inside this app-server, `{type:"idle"}` once it has ended. Left undefined by
  // default so the existing tests keep exercising the pre-status behavior of an older server.
  resumeThreadStatus?: { type: string; activeFlags?: string[] }

  constructor(version = CODEX_APP_SERVER_SUPPORTED_VERSION) {
    super()
    this.version = version
    this.stdin.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")))
  }

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    queueMicrotask(() => this.emit("exit", 0, "SIGTERM"))
    return true
  }

  disconnect(): void {
    if (this.killed) return
    this.killed = true
    this.emit("exit", 1, null)
  }

  send(message: Message): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  sendRaw(value: string | Buffer): void {
    this.stdout.write(value)
  }

  sendBatch(messages: Message[]): void {
    this.sendRaw(messages.map((message) => JSON.stringify(message)).join("\n") + "\n")
  }

  request(id: string | number, method: string, params: unknown): void {
    this.send({ id, method, params })
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params })
  }

  // End the active turn the way a real turn/completed would, clearing the bridge's current_turn_id.
  completeActiveTurn(threadId?: string, turnId?: string): void {
    const active = this.activeTurn
    const id = turnId ?? active?.turnId
    const thread = threadId ?? active?.threadId
    if (!id || !thread) return
    this.activeTurn = null
    this.notify("turn/completed", { threadId: thread, turn: { id } })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line) as Message
      this.inbound.push(message)
      if (typeof message.method === "string" && typeof message.id === "number") {
        this.clientRequests.push(message)
        this.answerClientRequest(message)
      } else if ("id" in message && ("result" in message || "error" in message)) {
        this.clientResponses.push(message)
      }
    }
  }

  private answerClientRequest(message: Message): void {
    const id = message.id as number
    if (message.method === "initialize") {
      this.send({
        id,
        result: {
          userAgent: `frizz/${this.version} (test; bridge)`,
          codexHome: "/tmp/fake-codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      })
      this.afterInitializeResponse?.()
      return
    }
    if (message.method === "thread/start") {
      const params = message.params as { ephemeral?: boolean }
      const suffix = ++nextProviderId
      this.send({
        id,
        result: {
          thread: {
            id: `codex-thread-${suffix}`,
            sessionId: `codex-session-${suffix}`,
            ephemeral: params.ephemeral ?? false,
          },
          model: "gpt-5",
        },
      })
      this.afterThreadStartResponse?.()
      return
    }
    if (message.method === "thread/resume") {
      const params = message.params as { threadId: string }
      this.send({
        id,
        result: {
          thread: {
            id: params.threadId,
            sessionId: `resumed-${params.threadId}`,
            ephemeral: false,
            ...(this.resumeThreadStatus ? { status: this.resumeThreadStatus } : {}),
          },
          model: "gpt-5",
        },
      })
      return
    }
    if (message.method === "turn/start") {
      const params = message.params as { threadId: string }
      const turnId = `codex-turn-${++nextProviderId}`
      this.activeTurn = { threadId: params.threadId, turnId }
      this.notify("turn/started", { threadId: params.threadId, turn: { id: turnId } })
      this.send({ id, result: { turn: { id: turnId } } })
      return
    }
    if (message.method === "turn/steer") {
      const params = message.params as { threadId: string; expectedTurnId: string }
      if (this.rejectSteerAsEnded) {
        // Emit turn/completed FIRST (clears the bridge's current_turn_id) then reject the steer.
        this.completeActiveTurn(params.threadId, params.expectedTurnId)
        this.send({ id, error: { code: -32602, message: "activeTurnNotSteerable" } })
        return
      }
      // Model the real precondition: steer only lands on the currently-active turn; a stale
      // expectedTurnId (turn already ended) is rejected — the signal `followUp` falls back on.
      if (this.activeTurn && this.activeTurn.turnId === params.expectedTurnId) {
        this.send({ id, result: { turnId: this.activeTurn.turnId } })
      } else {
        this.send({ id, error: { code: -32602, message: "activeTurnNotSteerable" } })
      }
      return
    }
    if (message.method === "turn/interrupt") {
      const params = message.params as { threadId: string; turnId: string }
      if (this.interruptBehavior === "reject-ended") {
        this.completeActiveTurn(params.threadId, params.turnId)
        this.send({ id, error: { code: -32602, message: "turn is not running" } })
        return
      }
      if (this.interruptBehavior === "reject-running") {
        this.send({ id, error: { code: -32602, message: "turn is not running" } })
        return
      }
      this.send({ id, result: {} })
      if (this.interruptBehavior !== "accept-no-end") this.completeActiveTurn(params.threadId, params.turnId)
      return
    }
    if (message.method === "skills/list") {
      const params = message.params as { cwds?: string[] }
      this.send({ id, result: { data: (params.cwds ?? []).map((cwd) => ({
        cwd,
        errors: [],
        skills: [
          { name: "frizz-stack", description: "Boot a disposable Frizz", enabled: true, path: `${cwd}/.agents/skills/frizz-stack/SKILL.md`, scope: "repo" },
          { name: "agent-browser", description: "Drive a browser", enabled: true, path: "/home/x/.agents/skills/agent-browser/SKILL.md", scope: "user" },
          { name: "imagegen", description: "Generate an image", enabled: true, path: "/home/x/.codex/skills/.system/imagegen/SKILL.md", scope: "system" },
          { name: "from-the-future", description: "Resolved from a root frizz has no name for", enabled: true, path: "/elsewhere/SKILL.md", scope: "someFutureRoot" },
          { name: "switched-off", description: "Present on disk but disabled", enabled: false, path: `${cwd}/off/SKILL.md`, scope: "user" },
        ],
      })) } })
      return
    }
    this.send({ id, error: { code: -32601, message: "not implemented by fake" } })
  }
}

async function waitFor(predicate: () => boolean, message = "condition", attempts = 100): Promise<void> {
  for (let index = 0; index < attempts; index++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
  }
  assert.fail(`timed out waiting for ${message}`)
}

function harness(
  version = CODEX_APP_SERVER_SUPPORTED_VERSION,
  setupProcess?: (process: FakeAppServerProcess) => void,
  codexAuthAccountId?: () => string | undefined,
  attachmentAccountId?: (requested: string | undefined, attachment: number) => string | undefined,
) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-codex-app-server-"))
  const dbPath = join(dir, "ui.db")
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  const now = new Date("2026-07-13T12:00:00.000Z")
  let interactionId = 0
  let clientId = 0
  const diagnostics: unknown[] = []
  const interactions = createInteractionStore(db, {
    now: () => now,
    id: () => `interaction-${++interactionId}`,
  })
  const processes: FakeAppServerProcess[] = []
  const calls: Array<{ binary: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }> = []
  const spawn: CodexAppServerSpawn = (binary, args, options) => {
    const process = new FakeAppServerProcess(version)
    setupProcess?.(process)
    processes.push(process)
    calls.push({ binary, args, cwd: options.cwd, env: options.env })
    return process
  }
  const bridges: CodexAppServerBridge[] = []
  const directHost = directChildHost(spawn)
  let attachment = 0
  const newBridge = () => {
    const bridge = new CodexAppServerBridge({
      projectId: "project-1",
      projectDir: dir,
      db,
      interactions,
      codexBin: "/opt/codex",
      ...(attachmentAccountId
        ? { host: async (options) => ({
            ...await directHost(options),
            authAccountId: attachmentAccountId(options.authAccountId, attachment++),
          }) }
        : { spawn }),
      now: () => now,
      id: () => `client-message-${++clientId}`,
      requestTimeoutMs: 1_000,
      diagnostic: (event) => diagnostics.push(event),
      codexAuthAccountId: codexAuthAccountId ?? (() => undefined),
    })
    bridges.push(bridge)
    return bridge
  }
  const bridge = newBridge()
  return {
    dir,
    db,
    interactions,
    bridge,
    processes,
    calls,
    diagnostics,
    newBridge,
    close() {
      for (const activeBridge of bridges.reverse()) activeBridge.close()
      interactions.dispose()
      db.close()
    },
  }
}

test("a listener record from before account tracking is replaced once, then upgraded in place", async () => {
  const h = harness(
    CODEX_APP_SERVER_SUPPORTED_VERSION,
    undefined,
    () => "account-one",
    (requested, attachment) => attachment === 0 ? undefined : requested,
  )
  await h.bridge.startDisposableSession({
    threadSlug: "legacy-listener", sessionId: "legacy-listener-session", cwd: h.dir, ephemeral: false,
  })
  assert.equal(h.processes.length, 2, "an unlabelled legacy listener cannot be trusted to hold the active account")
  assert.equal(h.processes[0]!.killed, true)
  assert.equal(h.processes[1]!.killed, false)
  await h.bridge.startTurn({ threadSlug: "legacy-listener", sessionId: "legacy-listener-session", text: "current account" })
  assert.equal(h.processes.length, 2, "the replacement records its account and does not churn again")
  h.close()
})

test("an existing thread uses a newly activated ChatGPT account on its next turn", async () => {
  let accountId = "account-one"
  const h = harness(CODEX_APP_SERVER_SUPPORTED_VERSION, undefined, () => accountId)
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "rotated-account",
    sessionId: "frizz-session-account",
    cwd: h.dir,
    ephemeral: false,
  })
  await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "first" })
  h.processes[0]!.completeActiveTurn()
  await waitFor(() => h.bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === null, "first turn completion")

  accountId = "account-two"
  await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "second" })

  assert.equal(h.processes.length, 2, "the app-server that cached the previous account must be replaced")
  assert.equal(h.processes[0]!.killed, true)
  assert.ok(h.processes[1]!.clientRequests.some((message) => message.method === "thread/resume"), "the existing rollout must survive the replacement")
  assert.ok(h.processes[1]!.clientRequests.some((message) => message.method === "turn/start"), "the follow-up must run on the replacement")
  assert.ok(h.diagnostics.some((event) => (event as { event?: string }).event === "auth-account-refreshed"))

  h.processes[1]!.completeActiveTurn()
  await waitFor(() => h.bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === null, "second turn completion")
  await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "third" })
  assert.equal(h.processes.length, 2, "an unchanged account must not churn the listener")
  h.close()
})

test("an account switch waits for every active turn before replacing the shared app-server", async () => {
  let accountId = "account-one"
  const h = harness(CODEX_APP_SERVER_SUPPORTED_VERSION, undefined, () => accountId)
  const active = await h.bridge.startDisposableSession({
    threadSlug: "active-before-switch", sessionId: "active-session", cwd: h.dir, ephemeral: false,
  })
  const waiting = await h.bridge.startDisposableSession({
    threadSlug: "waiting-after-switch", sessionId: "waiting-session", cwd: h.dir, ephemeral: false,
  })
  await h.bridge.startTurn({ threadSlug: active.threadSlug, sessionId: active.sessionId, text: "still running" })

  accountId = "account-two"
  let settled = false
  const nextTurn = h.bridge.startTurn({ threadSlug: waiting.threadSlug, sessionId: waiting.sessionId, text: "use the new account" })
    .finally(() => { settled = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false, "new work must wait at the safe turn boundary")
  assert.equal(h.processes.length, 1)
  assert.equal(h.processes[0]!.killed, false, "the process running an existing turn must not be killed")

  h.processes[0]!.completeActiveTurn()
  await nextTurn
  assert.equal(h.processes.length, 2)
  assert.equal(h.processes[0]!.killed, true)
  assert.ok(h.processes[1]!.clientRequests.some((message) => message.method === "turn/start"))
  h.close()
})

function commandParams(threadId: string, turnId: string, over: Record<string, unknown> = {}) {
  return {
    threadId,
    turnId,
    itemId: "item-command-1",
    startedAtMs: Date.parse("2026-07-13T12:00:00.000Z"),
    environmentId: null,
    approvalId: null,
    reason: "Tests need to run",
    command: "pnpm test --token secret-that-must-not-be-journaled",
    cwd: "/tmp/project",
    availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    ...over,
  }
}

function sessionRow(slug: string, sessionId: string, backend = "claude"): SessionRow {
  return {
    slug,
    session_id: sessionId,
    thread_name: `frizz-${slug}`,
    spawned_at: "2026-07-13T12:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: null,
    state: null,
    meta: null,
    seen_at: null,
    transcript_id: null,
    backend,
  }
}

test("bridge is the sole codex transport (always enabled) and negotiates exact installed protocol over stdio", async () => {
  // The TUI path is retired: app-server is always the codex transport.
  assert.equal(codexAppServerBridgeEnabled(), true)
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "bridge-thread",
    sessionId: "frizz-session-1",
    cwd: h.dir,
  })
  assert.equal(binding.ephemeral, true)
  assert.equal(h.calls.length, 1)
  // `app-server <mcp -c overrides…> --stdio`. The overrides sit BETWEEN the subcommand and the
  // transport flag, and carrying them is why this is no longer a bare two-element argv: codex has no
  // `--mcp-config`, so frizz's MCP server can only reach a worker as process-level `-c` config on the
  // app-server itself (see codex-mcp.ts). Asserted structurally rather than byte-for-byte so adding an
  // override does not fail this test. This harness supplies NO frizz descriptor, so no `mcp_servers.*`
  // override is expected: frizz mounts the `frizz` server or nothing at all — the always-on
  // chrome-devtools mount was removed 2026-08-26. The frizz mount's own shape is pinned in
  // codex-mcp.test.ts.
  const args = h.calls[0]!.args
  assert.equal(args[0], "app-server")
  assert.equal(args[args.length - 1], "--stdio")
  assert.ok(args.includes("-c"), "app-server argv carries no -c overrides")
  assert.ok(!args.some((a) => a.startsWith("mcp_servers.")), "nothing should be mounted without a descriptor")
  assert.ok(!args.some((a) => a.includes("chrome-devtools")), "frizz must inject no browser")
  assert.ok(args.some((a) => a === 'default_tools_approval_mode="approve"'), "MCP calls would be cancelled at use")
  assert.equal(h.calls[0]!.binary, "/opt/codex")
  assert.deepEqual(CODEX_APP_SERVER_PROTOCOL_REVISION, {
    packageVersion: "0.153.2",
    sourceTag: "rust-v0.153.2",
    sourceCommit: "657a993cbee87acf52d14b758ce49dbd46d1b8eb",
  })
  assert.notEqual(h.calls[0]!.env, process.env, "the child receives a point-in-time environment snapshot")
  // Looked up the way the OS does, because the snapshot is a PLAIN object: `process.env` is a
  // case-insensitive proxy on Windows, where the variable is spelled `Path`, and copying it out through
  // Object.entries (inheritWorkerEnvironment) keeps that spelling. The child inherits it either way —
  // libuv's environment block and node's own win32 env dedupe are both case-insensitive — so pinning
  // the upper-case key would pin a POSIX accident rather than the behaviour this asserts.
  const snapshot = h.calls[0]!.env
  const inherited = (key: string) =>
    Object.entries(snapshot).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
  for (const key of ["HOME", "PATH", "CODEX_HOME", "OPENAI_API_KEY"] as const) {
    assert.equal(inherited(key), process.env[key], `${key} is preserved for first-party Codex auth/config`)
  }
  const initialize = h.processes[0]!.clientRequests.find((message) => message.method === "initialize")!
  assert.deepEqual((initialize.params as Message).capabilities, {
    experimentalApi: true,
    requestAttestation: false,
    mcpServerOpenaiFormElicitation: false,
    optOutNotificationMethods: ["turn/diff/updated"],
  })
  assert.ok(h.processes[0]!.inbound.some((message) => message.method === "initialized"))
  assert.equal(h.processes[0]!.inbound.some((message) => "jsonrpc" in message), false)
  h.close()
})

// The app-server inherits the operator's environment and drops only frizz's OWN control plane. This
// REVERSES a prior ~35-key allowlist (see worker-env.ts for the full reasoning): the curated lists had
// drifted between backends — this one carried HTTP_PROXY/SSL_CERT_FILE and the claude ones did not, so
// the same task succeeded or failed depending on which backend the operator picked — and none of them
// carried SSH_AUTH_SOCK or any toolchain variable, so a build inside a worker diverged from the same
// build in the operator's shell. This is explicitly NOT a secrets boundary: a worker has a shell and
// filesystem read, so anything worth stealing is already on disk.
test("child environment inherits the operator's variables and withholds only frizz's own control plane", () => {
  const source: NodeJS.ProcessEnv = {
    HOME: "/Users/tester",
    PATH: "/opt/codex/bin:/usr/bin",
    LANG: "en_US.UTF-8",
    CODEX_HOME: "/Users/tester/.codex",
    OPENAI_API_KEY: "openai-secret",
    CODEX_ACCESS_TOKEN: "codex-secret",
    HTTPS_PROXY: "http://proxy-secret@example.test",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    NVM_DIR: "/Users/tester/.nvm",
    GITHUB_TOKEN: "github-secret",
    FRIZZ_CLAUDE_BROKER: "frizz-daemon-payload",
    FRIZZ_LAUNCH_OWNER_TOKEN: "frizz-owner-secret",
    UNDEFINED_ENTRY: undefined,
  }
  const environment = codexAppServerEnvironment(source)
  assert.notEqual(environment, source, "the child gets a point-in-time snapshot, not the live object")

  // The two things that must never cross: frizz's daemon payload and its launch identity. Asserted
  // BEFORE the deepEqual below, whose `asserts actual is T` signature narrows `environment` to the
  // literal and would make these lookups a type error.
  assert.equal(environment.FRIZZ_CLAUDE_BROKER, undefined)
  assert.equal(environment.FRIZZ_LAUNCH_OWNER_TOKEN, undefined)
  assert.equal(JSON.stringify(environment).includes("frizz-owner-secret"), false)
  // An undefined value is dropped rather than forwarded as the string "undefined".
  assert.equal("UNDEFINED_ENTRY" in environment, false)

  // Everything that is not frizz's own — including the variables the old allowlist silently dropped.
  assert.deepEqual(environment, {
    HOME: source.HOME,
    PATH: source.PATH,
    LANG: source.LANG,
    CODEX_HOME: source.CODEX_HOME,
    OPENAI_API_KEY: source.OPENAI_API_KEY,
    CODEX_ACCESS_TOKEN: source.CODEX_ACCESS_TOKEN,
    HTTPS_PROXY: source.HTTPS_PROXY,
    SSH_AUTH_SOCK: source.SSH_AUTH_SOCK,
    NVM_DIR: source.NVM_DIR,
    GITHUB_TOKEN: source.GITHUB_TOKEN,
  })
})

test("command response is written once and the journal resolves only after serverRequest/resolved", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "bridge-thread",
    sessionId: "frizz-session-1",
    cwd: h.dir,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Run the tests",
  })
  const process = h.processes[0]!
  process.request("approval-1", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId))
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1, "command interaction")
  const pending = h.interactions.listPending(scope)[0]!
  assert.equal(pending.payload.kind, "command-approval")
  assert.equal(JSON.stringify(pending).includes("secret-that-must-not-be-journaled"), false)
  const queued = await h.bridge.resolveInteraction(scope, {
    slug: binding.threadSlug,
    sessionId: binding.sessionId,
    interactionId: pending.id,
    sessionEpoch: pending.owner.sessionEpoch,
    capabilityRevision: pending.owner.capabilityRevision,
    expectedRecordRevision: pending.recordRevision,
    responseId: "human-response-1",
    decisionId: "accept",
  })
  assert.equal(queued?.effect, "queued")
  await waitFor(() => process.clientResponses.some((message) => message.id === "approval-1"), "provider response")
  assert.deepEqual(process.clientResponses.filter((message) => message.id === "approval-1"), [
    { id: "approval-1", result: { decision: "accept" } },
  ])
  const duplicate = await h.bridge.resolveInteraction(scope, {
    slug: binding.threadSlug,
    sessionId: binding.sessionId,
    interactionId: pending.id,
    sessionEpoch: pending.owner.sessionEpoch,
    capabilityRevision: pending.owner.capabilityRevision,
    expectedRecordRevision: pending.recordRevision,
    responseId: "human-response-1",
    decisionId: "accept",
  })
  assert.equal(duplicate?.effect, "already-sent")
  assert.equal(process.clientResponses.filter((message) => message.id === "approval-1").length, 1)
  assert.equal(h.interactions.get(scope, pending.id)?.lifecycle, "pending", "pipe acceptance is not provider acknowledgement")
  process.notify("serverRequest/resolved", { threadId: binding.codexThreadId, requestId: "approval-1" })
  await waitFor(() => h.interactions.get(scope, pending.id)?.lifecycle === "resolved", "provider acknowledgement")
  process.notify("serverRequest/resolved", { threadId: binding.codexThreadId, requestId: "approval-1" })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(process.clientResponses.filter((message) => message.id === "approval-1").length, 1)
  h.close()
})

test("command approval display preserves complete structural risk while redacting hostile exact protocol fields", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "display-command",
    sessionId: "display-command-session",
    cwd: h.dir,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Show informed consent",
  })
  const process = h.processes[0]!
  const secrets = {
    api: "sk-proj-abcdefghijklmnopqrstuv",
    bearer: "bearerCredential1234567890",
    password: "command-password-123",
    urlPassword: "url-password-123",
    jwt: "abcdefgh.ijklmnop.qrstuvw-",
    pathToken: "path-token-secret-123",
    apiHeader: "header-api-key-secret-123",
    embedded: "embedded-credential-secret-123",
    curlUser: "fixture-curl-user-credential",
    equalsToken: "fixture-equals-token-credential",
    encodedUrl: "%66%69%78%74%75%72%65-url-credential",
  }
  const command = [
    `OPENAI_API_KEY=${secrets.api} rm -rf / --password ${secrets.password}`,
    `curl -H "Authorization: Bearer ${secrets.bearer}" https://alice:${secrets.urlPassword}@packages.example.test/private`,
    `curl -u alice:${secrets.curlUser} --token=${secrets.equalsToken} https://bob:${secrets.encodedUrl}@packages.example.test/encoded`,
    `curl -H "X-Api-Key: ${secrets.apiHeader}" https://packages.example.test && chmod -R 777 /`,
    `danger --password "${secrets.embedded}\$(rm -rf /credential-shadow)" && echo structure-visible`,
    `printf '%s' ${secrets.jwt} && echo '<script>alert(1)</script>' && git push --force`,
    ...Array.from({ length: 100 }, (_, index) => `echo line-${index}`),
  ].join("\n")
  process.request("hostile-command", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, {
    itemId: "hostile-command-item",
    reason: `Need a privileged operation; token=${secrets.pathToken}; callback=https://bob%3A${secrets.encodedUrl}@packages.example.test; **provider markdown** <img src=x onerror=alert(1)>`,
    command,
    cwd: `/tmp/<script>/workspace\u202E\u061C\u{E0001}\uD800/token=${secrets.pathToken}`,
    commandActions: [
      { type: "read", command: `cat --token ${secrets.pathToken} /etc/passwd`, name: "passwd", path: "/etc/passwd" },
      { type: "search", command: "rg --hidden credential", query: "credential", path: "/" },
      { type: "listFiles", command: "find / -maxdepth 2", path: null },
      { type: "unknown", command: "rm -rf /" },
    ],
    networkApprovalContext: { host: "packages.example.test", protocol: "https" },
    additionalPermissions: {
      network: { enabled: true },
      fileSystem: {
        read: ["/etc/passwd"],
        write: [`/tmp/token=${secrets.pathToken}/output`],
        globScanMaxDepth: 0,
        entries: [
          { access: "deny", path: { type: "special", value: { kind: "root" } } },
          { access: "read", path: { type: "glob_pattern", pattern: "/var/**/<script>" } },
        ],
      },
    },
    proposedExecpolicyAmendment: ["git", "push", "--force"],
    proposedNetworkPolicyAmendments: [
      { host: "packages.example.test", action: "allow" },
      { host: "metadata.internal", action: "deny" },
    ],
  }))
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1, "hostile command display")
  const record = h.interactions.listPending(scope)[0]!
  assert.equal(record.payload.kind, "command-approval")
  if (record.payload.kind !== "command-approval") assert.fail("expected command approval")
  const serialized = JSON.stringify(record)
  for (const secret of Object.values(secrets)) assert.equal(serialized.includes(secret), false, `redacts ${secret}`)
  assert.match(record.payload.command.preview, /rm -rf \/.*--password \[REDACTED\]/)
  assert.match(record.payload.command.preview, /curl -u alice:\[REDACTED\] --token=\[REDACTED\]/)
  assert.match(record.payload.command.preview, /https:\/\/\[REDACTED\]@packages\.example\.test\/encoded/)
  assert.match(record.payload.command.preview, /git push --force/)
  assert.match(record.payload.command.preview, /chmod -R 777 \//)
  assert.match(record.payload.command.preview, /embedded executable shell syntax: \$\(rm -rf \/credential-shadow\)/)
  assert.match(record.payload.command.preview, /<script>alert\(1\)<\/script>/)
  assert.match(record.payload.command.preview, /echo line-99/)
  assert.doesNotMatch(record.payload.command.preview, /truncated|omitted/)
  assert.match(record.payload.command.workingDirectoryLabel ?? "", /\[U\+202E\].*\[U\+061C\].*\[U\+E0001\].*\[U\+D800\]/)
  assert.deepEqual(record.payload.command.actions?.map((action) => action.kind), ["read", "search", "list-files", "unknown"])
  assert.match(record.payload.command.actions?.[3]?.commandPreview ?? "", /rm -rf \//)
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "network" && capability.hosts.includes("https: packages.example.test")))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "filesystem" && capability.access === "deny"))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "glob-scan" && capability.depth === 0))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "exec-policy" && capability.prefixes.includes("--force")))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "network-policy" && capability.access === "deny" && capability.hosts.includes("metadata.internal")))
  assert.match(record.payload.message ?? "", /\*\*provider markdown\*\* <img src=x onerror=alert\(1\)>/)
  h.close()
})

test("approval mapping rejects unseen authority instead of truncating commands, actions, policies, resources, or file changes", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "complete-authority",
    sessionId: "complete-authority-session",
    cwd: h.dir,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Reject partial consent",
  })
  const process = h.processes[0]!
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  const rejects = async (id: string, method: string, params: unknown) => {
    process.request(id, method, params)
    await waitFor(() => process.clientResponses.some((message) => message.id === id && "error" in message), `${id} rejection`)
    assert.equal(h.interactions.listPending(scope).length, 0)
  }

  await rejects("oversized-command", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, {
    itemId: "oversized-command-item",
    command: "😀".repeat(8_000),
  }))
  await rejects("too-many-actions", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, {
    itemId: "too-many-actions-item",
    commandActions: Array.from({ length: 17 }, (_, index) => ({ type: "unknown" as const, command: `echo ${index}` })),
  }))
  await rejects("too-many-policy-prefixes", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, {
    itemId: "too-many-policy-prefixes-item",
    proposedExecpolicyAmendment: Array.from({ length: 33 }, (_, index) => `prefix-${index}`),
  }))
  await rejects("too-many-filesystem-resources", "item/permissions/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "too-many-filesystem-resources-item",
    environmentId: null,
    startedAtMs: Date.now(),
    cwd: h.dir,
    reason: "Request many paths",
    permissions: {
      network: null,
      fileSystem: {
        read: Array.from({ length: 33 }, (_, index) => `/tmp/read-${index}`),
        write: [],
        entries: [],
      },
    },
  })

  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "too-many-file-changes-item",
      status: "inProgress",
      changes: Array.from({ length: 17 }, (_, index) => ({
        path: `/tmp/file-${index}`,
        kind: { type: "add" as const },
        diff: `+${index}`,
      })),
    },
  })
  await rejects("too-many-file-changes", "item/fileChange/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "too-many-file-changes-item",
    startedAtMs: Date.now(),
    reason: "Apply all changes",
    grantRoot: null,
  })
  h.close()
})

test("file approval requires exact snapshots and invalidates stale cards across patch, completion, turn, disconnect, and restart", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "file-correlation",
    sessionId: "file-correlation-session",
    cwd: h.dir,
    ephemeral: false,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Prepare a patch",
  })
  const process = h.processes[0]!
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  const approval = (id: string, itemId = "file-item") => process.request(id, "item/fileChange/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId,
    startedAtMs: Date.now(),
    reason: "Apply the exact patch",
    grantRoot: h.dir,
  })

  approval("request-before-item")
  await waitFor(() => process.clientResponses.some((message) => message.id === "request-before-item" && "error" in message), "request-before-item rejection")
  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "different-item",
      status: "inProgress",
      changes: [{ path: "/tmp/different", kind: { type: "add" }, diff: "+different" }],
    },
  })
  approval("wrong-item-correlation")
  await waitFor(() => process.clientResponses.some((message) => message.id === "wrong-item-correlation" && "error" in message), "wrong item rejection")
  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId: "different-turn",
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "file-item",
      status: "inProgress",
      changes: [{ path: "/tmp/different-turn", kind: { type: "add" }, diff: "+different turn" }],
    },
  })
  approval("wrong-turn-correlation")
  await waitFor(() => process.clientResponses.some((message) => message.id === "wrong-turn-correlation" && "error" in message), "wrong turn rejection")
  process.notify("item/fileChange/patchUpdated", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "file-item",
    changes: [{ path: "/tmp/uncorrelated", kind: { type: "add" }, diff: "+must not appear" }],
  })
  approval("patch-before-item")
  await waitFor(() => process.clientResponses.some((message) => message.id === "patch-before-item" && "error" in message), "patch-before-item rejection")

  const diffSecret = "file-diff-token-secret"
  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "file-item",
      status: "inProgress",
      changes: [{ path: "/tmp/original", kind: { type: "update", move_path: null }, diff: "+original" }],
    },
  })
  process.notify("item/fileChange/patchUpdated", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "file-item",
    changes: [
      {
        path: "/tmp/<script>/source\u202E.txt",
        kind: { type: "update", move_path: `/tmp/token=${diffSecret}/destination.txt` },
        diff: [`+API_TOKEN=${diffSecret}`, "+rm -rf /", ...Array.from({ length: 120 }, (_, index) => `+line ${index}`)].join("\n"),
      },
      ...Array.from({ length: 2 }, (_, index) => ({
        path: `/tmp/generated-${index}.txt`,
        kind: { type: index % 2 === 0 ? "add" as const : "delete" as const },
        diff: index % 2 === 0 ? "+created" : "-deleted",
      })),
    ],
  })
  approval("correlated-file")
  await waitFor(() => h.interactions.listPending(scope).length === 1, "correlated file interaction")
  const record = h.interactions.listPending(scope)[0]!
  assert.equal(record.payload.kind, "file-approval")
  if (record.payload.kind !== "file-approval") assert.fail("expected file approval")
  assert.equal(record.payload.changes?.length, 3)
  assert.equal(record.payload.pathLabel, "3 affected paths")
  assert.equal(record.payload.grantRootLabel, h.dir)
  assert.match(record.payload.scopeLabel ?? "", /writes below this root.*current Codex session/)
  assert.equal(JSON.stringify(record).includes(diffSecret), false)
  assert.match(record.payload.changes?.[0]?.pathLabel ?? "", /<script>.*\[U\+202E\]/)
  assert.match(record.payload.changes?.[0]?.diffPreview ?? "", /rm -rf \//)
  assert.match(record.payload.changes?.[0]?.diffPreview ?? "", /\+line 119/)
  assert.doesNotMatch(record.payload.changes?.[0]?.diffPreview ?? "", /truncated|omitted/)

  process.notify("item/fileChange/patchUpdated", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "file-item",
    changes: [{ path: "/tmp/revised", kind: { type: "delete" }, diff: "-revised" }],
  })
  await waitFor(() => h.interactions.get(scope, record.id)?.lifecycle === "cancelled", "old patch cancellation")
  assert.equal(h.interactions.get(scope, record.id)?.cancellationReason, "provider-cancelled")
  await waitFor(() => process.clientResponses.some((message) => message.id === "correlated-file" && "error" in message), "old approval invalidation response")
  assert.equal(h.interactions.listPending(scope).length, 0)
  approval("revised-file")
  await waitFor(() => h.interactions.listPending(scope).length === 1, "revised file interaction")
  const revised = h.interactions.listPending(scope)[0]!
  assert.equal(revised.payload.kind, "file-approval")
  if (revised.payload.kind !== "file-approval") assert.fail("expected revised file approval")
  assert.equal(revised.payload.pathLabel, "/tmp/revised")
  assert.equal(revised.payload.operation, "delete")
  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "file-item",
      status: "inProgress",
      changes: [{ path: "/tmp/revised", kind: { type: "delete" }, diff: "-revised" }],
    },
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(h.interactions.get(scope, revised.id)?.lifecycle, "pending", "identical item replay preserves exact approval")
  assert.equal(process.clientResponses.some((message) => message.id === "revised-file"), false)

  process.notify("item/completed", {
    threadId: binding.codexThreadId,
    turnId,
    completedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "file-item",
      status: "completed",
      changes: [{ path: "/tmp/final", kind: { type: "add" }, diff: "+final" }],
    },
  })
  await waitFor(() => h.interactions.get(scope, revised.id)?.lifecycle === "cancelled", "completed item cancellation")
  await waitFor(() => process.clientResponses.some((message) => message.id === "revised-file" && "error" in message), "completed item invalidation response")
  approval("completed-item")
  await waitFor(() => process.clientResponses.some((message) => message.id === "completed-item" && "error" in message), "completed item rejection")

  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "restart-item",
      status: "inProgress",
      changes: [{ path: "/tmp/restart", kind: { type: "add" }, diff: "+restart" }],
    },
  })
  approval("restart-original", "restart-item")
  await waitFor(() => h.interactions.listPending(scope).some((item) => item.owner.itemId === "restart-item"), "pre-restart file interaction")
  const preRestart = h.interactions.listPending(scope).find((item) => item.owner.itemId === "restart-item")!
  h.bridge.close()
  const restarted = h.newBridge()
  await restarted.resumeOwnedSession(binding.threadSlug, binding.sessionId)
  const second = h.processes[1]!
  // The pre-restart turn died with its connection (measured against the real app-server in
  // scripts/verify-codex-turn-survives-connection.mjs: the rollout never grows again after a resume),
  // so its card is retired at the rebind — it could never be answered, and the provider can only
  // re-ask inside a NEW turn. Everything after the restart therefore rides that new turn.
  assert.equal(h.interactions.get(scope, preRestart.id)?.lifecycle, "cancelled")
  assert.equal(h.interactions.get(scope, preRestart.id)?.cancellationReason, "turn-ended")
  assert.notEqual(h.interactions.providerDelivery(scope, preRestart.id)?.connectionEpoch, restarted.binding(binding.threadSlug, binding.sessionId)?.connectionEpoch)
  const { turnId: restartTurnId } = await restarted.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Continue",
  })
  assert.notEqual(restartTurnId, turnId)
  second.request("restart-without-replay", "item/fileChange/requestApproval", {
    threadId: binding.codexThreadId,
    turnId: restartTurnId,
    itemId: "restart-item",
    startedAtMs: Date.now(),
    reason: "Fresh correlation required",
    grantRoot: null,
  })
  await waitFor(() => second.clientResponses.some((message) => message.id === "restart-without-replay" && "error" in message), "restart cache rejection")
  second.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId: restartTurnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "restart-item",
      status: "inProgress",
      changes: [{ path: "/tmp/replayed", kind: { type: "add" }, diff: "+replayed" }],
    },
  })
  second.request("restart-after-replay", "item/fileChange/requestApproval", {
    threadId: binding.codexThreadId,
    turnId: restartTurnId,
    itemId: "restart-item",
    startedAtMs: Date.now(),
    reason: "Fresh correlation witnessed",
    grantRoot: null,
  })
  await waitFor(() => h.interactions.listPending(scope).some((item) => item.owner.itemId === "restart-item"), "restart replay interaction")
  const postRestart = h.interactions.listPending(scope).find((item) => item.owner.itemId === "restart-item")!
  assert.notEqual(postRestart.id, preRestart.id)
  assert.equal(postRestart.payload.kind, "file-approval")
  if (postRestart.payload.kind !== "file-approval") assert.fail("expected post-restart file approval")
  assert.equal(postRestart.payload.pathLabel, "/tmp/replayed")

  second.notify("turn/completed", { threadId: binding.codexThreadId, turn: { id: restartTurnId, status: "completed" } })
  await waitFor(() => h.interactions.get(scope, postRestart.id)?.lifecycle === "cancelled", "turn completion cancellation")
  assert.equal(h.interactions.get(scope, postRestart.id)?.cancellationReason, "turn-ended")
  await waitFor(() => second.clientResponses.some((message) => message.id === "restart-after-replay" && "error" in message), "turn completion invalidation response")
  h.close()
})

test("permissions approval displays exact filesystem and network capabilities without leaking secret path text", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "permission-display",
    sessionId: "permission-display-session",
    cwd: h.dir,
  })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Request capability" })
  const process = h.processes[0]!
  const pathSecret = "permission-path-secret"
  const requestedPermissions = {
    network: { enabled: true },
    fileSystem: {
      read: ["/etc/hosts"],
      write: [`${h.dir}/token=${pathSecret}/output`],
      globScanMaxDepth: 7,
      entries: [
        { access: "read" as const, path: { type: "special" as const, value: { kind: "project_roots" as const, subpath: "src/<script>" } } },
        { access: "write" as const, path: { type: "glob_pattern" as const, pattern: `${h.dir}/**/*.ts` } },
        { access: "deny" as const, path: { type: "special" as const, value: { kind: "root" as const } } },
        { access: "read" as const, path: { type: "special" as const, value: { kind: "unknown" as const, path: "/provider/root", subpath: "nested" } } },
      ],
    },
  }
  process.request("permission-display-request", "item/permissions/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "permission-display-item",
    environmentId: null,
    startedAtMs: Date.now(),
    cwd: `${h.dir}/token=${pathSecret}`,
    reason: `Need exact roots, password=${pathSecret}`,
    permissions: requestedPermissions,
  })
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1, "permission display")
  const record = h.interactions.listPending(scope)[0]!
  assert.equal(record.payload.kind, "permission-approval")
  if (record.payload.kind !== "permission-approval") assert.fail("expected permission approval")
  assert.equal(JSON.stringify(record).includes(pathSecret), false)
  assert.equal(record.payload.permission, "network+filesystem")
  assert.match(record.payload.scopeLabel ?? "", /turn.*session/)
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "network" && capability.enabled === true))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "filesystem" && capability.access === "read" && capability.resources.some((path) => path.includes("/etc/hosts"))))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "filesystem" && capability.access === "write" && capability.resources.some((path) => path.includes("Glob pattern:"))))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "filesystem" && capability.access === "deny" && capability.resources.some((path) => path.includes("Filesystem root"))))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "glob-scan" && capability.depth === 7))
  assert.match(JSON.stringify(record.payload.capabilities), /src\/<script>/)
  await h.bridge.resolveInteraction(scope, {
    slug: binding.threadSlug,
    sessionId: binding.sessionId,
    interactionId: record.id,
    sessionEpoch: record.owner.sessionEpoch,
    capabilityRevision: record.owner.capabilityRevision,
    expectedRecordRevision: record.recordRevision,
    responseId: "permission-display-response",
    decisionId: "grant-turn",
  })
  await waitFor(() => process.clientResponses.some((message) => message.id === "permission-display-request"), "permission provider response")
  assert.deepEqual(process.clientResponses.find((message) => message.id === "permission-display-request"), {
    id: "permission-display-request",
    result: { permissions: requestedPermissions, scope: "turn" },
  })
  h.close()
})

test("duplicate provider requests deduplicate exactly while conflicting reuse fails closed", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "duplicate-thread", sessionId: "duplicate-session", cwd: h.dir })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Check duplicates" })
  const process = h.processes[0]!
  const params = commandParams(binding.codexThreadId, turnId)
  process.request("duplicate-1", "item/commandExecution/requestApproval", params)
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1)
  process.request("duplicate-1", "item/commandExecution/requestApproval", params)
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(h.interactions.listPending(scope).length, 1)

  process.request("duplicate-conflict", "item/commandExecution/requestApproval", {
    ...params,
    reason: "A materially different request reusing the same authority ids",
  })
  await waitFor(
    () => process.clientResponses.some((message) => message.id === "duplicate-conflict" && "error" in message),
    "conflicting provider request rejection",
  )
  assert.equal(h.interactions.listPending(scope).length, 1)
  h.close()
})

test("provider fingerprints and durable context ignore JSON object insertion order", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "ordered-thread", sessionId: "ordered-session", cwd: h.dir })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Normalize requests" })
  const process = h.processes[0]!
  const base = commandParams(binding.codexThreadId, turnId, {
    additionalPermissions: { fileSystem: null, network: { enabled: true } },
  })
  process.request("ordered-request", "item/commandExecution/requestApproval", base)
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1)
  process.request("ordered-request", "item/commandExecution/requestApproval", {
    ...base,
    additionalPermissions: { network: { enabled: true }, fileSystem: null },
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(h.interactions.listPending(scope).length, 1)
  assert.equal(process.clientResponses.some((message) => message.id === "ordered-request" && "error" in message), false)
  h.close()
})

test("only locally witnessed turn ids may own provider requests and notifications cannot replace them", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "turn-owner", sessionId: "turn-owner-session", cwd: h.dir })
  const process = h.processes[0]!
  process.request("unsolicited", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, "foreign-turn", {
    itemId: "unsolicited-item",
  }))
  await waitFor(() => process.clientResponses.some((message) => message.id === "unsolicited" && "error" in message), "unsolicited turn rejection")
  assert.equal(h.bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId, null)

  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Own one turn" })
  process.notify("turn/started", { threadId: binding.codexThreadId, turn: { id: "replacement-turn" } })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(h.bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId, turnId)
  process.request("owned", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, { itemId: "owned-item" }))
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1, "owned turn request")
  h.close()
})

test("listSkills asks the app-server for the session cwd's skills and drops disabled ones", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "skills-thread", sessionId: "skills-session", cwd: h.dir })
  const skills = await h.bridge.listSkills(binding.threadSlug, binding.sessionId)
  // Codex's own scope vocabulary, normalized: repo→project, user→user, system→builtin. A scope frizz
  // has no mapping for keeps its row and loses only its label — a wrong label is worse than none.
  assert.deepEqual(skills, [
    { name: "frizz-stack", description: "Boot a disposable Frizz", source: "project" },
    { name: "agent-browser", description: "Drive a browser", source: "user" },
    { name: "imagegen", description: "Generate an image", source: "builtin" },
    { name: "from-the-future", description: "Resolved from a root frizz has no name for", source: undefined },
  ])
  const request = h.processes[0]!.clientRequests.find((message) => message.method === "skills/list")!
  assert.deepEqual(request.params, { cwds: [h.dir] })
  await assert.rejects(h.bridge.listSkills("unknown-thread", "unknown-session"), /bridge-owned session/)
  await h.close()
})

test("steerTurn injects into the active turn; interruptTurn cancels it and is a no-op when idle", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "steer-thread", sessionId: "steer-session", cwd: h.dir })
  const process = h.processes[0]!
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Start" })
  await waitFor(() => h.bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === turnId, "turn active")

  const steer = await h.bridge.steerTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "More" })
  assert.equal(steer.turnId, turnId)
  const steerReq = process.clientRequests.find((message) => message.method === "turn/steer")!
  assert.equal((steerReq.params as Message).expectedTurnId, turnId)

  assert.deepEqual(await h.bridge.interruptTurn(binding.threadSlug, binding.sessionId), { interrupted: true })
  await waitFor(() => h.bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === null, "cleared after interrupt")

  assert.deepEqual(await h.bridge.interruptTurn(binding.threadSlug, binding.sessionId), { interrupted: false })
  await assert.rejects(
    h.bridge.steerTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "x" }),
    /requires an active turn/,
  )
  h.close()
})

// interruptTurn is the ONLY thing that stops an app-server Codex worker (there is no pane to kill),
// and since the app-server moved into a detached daemon a turn it fails to stop has no backstop — it
// keeps running with no frizz-side owner. So it must never report a stop that did not happen, and the
// router marks the row exited/done strictly on its word.
test("interruptTurn is honest: a turn that ended under it is 'nothing to stop', a rejection while it still runs is a failure", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "honest-interrupt", sessionId: "honest-session", cwd: h.dir })
  const process = h.processes[0]!
  const scope = [binding.threadSlug, binding.sessionId] as const

  // The turn reaches its own ending in the read→RPC window: the server rejects an interrupt for a turn
  // it no longer runs. Definitive AND corroborated by current_turn_id retiring ⇒ nothing to stop.
  process.interruptBehavior = "reject-ended"
  const ended = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "one" })
  await waitFor(() => h.bridge.binding(...scope)?.currentTurnId === ended.turnId, "first turn active")
  assert.deepEqual(await h.bridge.interruptTurn(...scope), { interrupted: false })
  assert.equal(h.bridge.binding(...scope)?.currentTurnId, null)

  // The same rejection with the turn STILL RUNNING must propagate. Degrading it to "nothing to stop"
  // is exactly how the row gets archived while the worker carries on.
  process.interruptBehavior = "reject-running"
  const running = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "two" })
  await waitFor(() => h.bridge.binding(...scope)?.currentTurnId === running.turnId, "second turn active")
  await assert.rejects(h.bridge.interruptTurn(binding.threadSlug, binding.sessionId, 200), /turn is not running/)
  assert.equal(h.bridge.binding(...scope)?.currentTurnId, running.turnId, "and the turn is left exactly as it was")

  // An ACCEPTED interrupt whose turn never ends is not a stop either. Returning here would let the
  // caller archive a row still carrying a live turn id — which a recycled runtime replays through
  // autoResumeInterruptedTurns, restarting the turn the operator just killed.
  process.interruptBehavior = "accept-no-end"
  await assert.rejects(h.bridge.interruptTurn(binding.threadSlug, binding.sessionId, 200), /has not ended/)
  assert.equal(h.bridge.binding(...scope)?.currentTurnId, running.turnId)
  h.close()
})

test("followUp starts a turn when idle and steers when a turn is live", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "fu-thread", sessionId: "fu-session", cwd: h.dir })
  const idle = await h.bridge.followUp({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "First" })
  assert.equal(idle.mode, "start")
  await waitFor(() => h.bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === idle.turnId, "active after start")
  const live = await h.bridge.followUp({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Second" })
  assert.deepEqual(live, { turnId: idle.turnId, mode: "steer", deduped: false })
  h.close()
})

test("followUp dedupes a repeated deliveryId — the second delivery never opens a second turn", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "fu-dedup", sessionId: "fu-dedup-session", cwd: h.dir })
  const process = h.processes[0]!
  const first = await h.bridge.followUp({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Once", deliveryId: "d1" })
  const startsBefore = process.clientRequests.filter((message) => message.method === "turn/start").length
  const dup = await h.bridge.followUp({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Once", deliveryId: "d1" })
  assert.deepEqual(dup, { turnId: first.turnId, mode: first.mode, deduped: true })
  assert.equal(process.clientRequests.filter((message) => message.method === "turn/start").length, startsBefore)
  h.close()
})

test("followUp falls back to a fresh turn when the live steer is rejected (turn ended in the window)", async () => {
  const h = harness(CODEX_APP_SERVER_SUPPORTED_VERSION, (proc) => { proc.rejectSteerAsEnded = true })
  const binding = await h.bridge.startDisposableSession({ threadSlug: "fu-fallback", sessionId: "fu-fallback-session", cwd: h.dir })
  const process = h.processes[0]!
  const first = await h.bridge.followUp({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "First" })
  assert.equal(first.mode, "start")
  await waitFor(() => h.bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === first.turnId, "active")
  // current_turn_id is set, so followUp tries steer; the fake ends the turn + rejects, so it must
  // recover by STARTING a fresh turn rather than surfacing an error or dropping the message.
  const recovered = await h.bridge.followUp({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Second" })
  assert.equal(recovered.mode, "start")
  assert.notEqual(recovered.turnId, first.turnId)
  assert.equal(process.clientRequests.filter((message) => message.method === "turn/steer").length, 1)
  h.close()
})

// A turn cannot outlive the connection running it: the app-server process that owned it is gone, and
// `thread/resume` (excludeTurns) never resurrects one. Carrying `current_turn_id` across the rebind
// wedged the thread permanently — followUp steered a turn the new process had never heard of, then
// startTurn refused with "already has an active turn", so every later follow-up failed. Observed live
// 2026-07-22: four codex threads died with their app-server at 23:26:33Z and stayed unusable.
test("a turn never survives its connection: rebinding clears the dead turn so follow-ups still land", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "stalled-thread",
    sessionId: "stalled-session",
    cwd: h.dir,
    ephemeral: false,
  })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Work" })
  await waitFor(() => h.bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === turnId, "turn active")

  // The app-server dies mid-turn (no turn/completed ever arrives).
  h.processes[0]!.disconnect()
  await waitFor(() => h.bridge.binding(binding.threadSlug, binding.sessionId)?.state === "detached", "detached on disconnect")

  await h.bridge.resumeOwnedSession(binding.threadSlug, binding.sessionId)
  const rebound = h.bridge.binding(binding.threadSlug, binding.sessionId)!
  assert.equal(rebound.state, "active")
  assert.equal(rebound.currentTurnId, null, "the dead connection's turn must not survive the rebind")

  // The operator's next follow-up must open a fresh turn rather than steering a phantom one.
  const next = await h.bridge.followUp({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Still there?" })
  assert.equal(next.mode, "start")
  assert.notEqual(next.turnId, turnId)
  assert.equal(h.processes[1]!.clientRequests.filter((message) => message.method === "turn/steer").length, 0)
  h.close()
})

// A bridge constructed at server boot owns no connection, so no binding it INHERITS can still be
// active. Without this, a SIGKILLed frizz (close() never ran) left rows claiming `active` at the last
// epoch, and every ownership check — including the board's liveness read — took that at face value.
test("a fresh bridge inherits no active bindings: boot detaches what a SIGKILLed process abandoned", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "killed-thread",
    sessionId: "killed-session",
    cwd: h.dir,
    ephemeral: false,
  })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Work" })
  // Simulate SIGKILL: the process vanishes without close()/handleDisconnect ever running.
  const abandoned = h.db.prepare("SELECT state, current_turn_id FROM codex_app_server_session WHERE project_id = 'project-1' AND thread_slug = ?")
    .get(binding.threadSlug) as { state: string; current_turn_id: string | null }
  assert.equal(abandoned.state, "active")
  assert.equal(abandoned.current_turn_id, turnId)

  const restarted = h.newBridge()
  const inherited = restarted.binding(binding.threadSlug, binding.sessionId)!
  assert.equal(inherited.state, "detached")
  assert.equal(inherited.currentTurnId, turnId, "detach preserves the turn id; the rebind retires it")

  await restarted.resumeOwnedSession(binding.threadSlug, binding.sessionId)
  assert.equal(restarted.binding(binding.threadSlug, binding.sessionId)?.currentTurnId, null)
  h.close()
})

test("startDisposableSession forwards worker-contract/title/config instruction surfaces to thread/start", async () => {
  const h = harness()
  await h.bridge.startDisposableSession({
    threadSlug: "cfg-thread", sessionId: "cfg-session", cwd: h.dir,
    baseInstructions: "WORKER CONTRACT BODY", developerInstructions: "TITLE PROTOCOL",
    config: { model_reasoning_summary: "detailed" },
  })
  const start = h.processes[0]!.clientRequests.find((message) => message.method === "thread/start")!
  const params = start.params as Message
  assert.equal(params.baseInstructions, "WORKER CONTRACT BODY")
  assert.equal(params.developerInstructions, "TITLE PROTOCOL")
  assert.deepEqual(params.config, { model_reasoning_summary: "detailed" })
  h.close()
})

test("unsupported structured command decisions fail closed instead of silently broadening approval", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "structured-decision", sessionId: "structured-session", cwd: h.dir })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Ask for approval" })
  const process = h.processes[0]!
  process.request("structured-request", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, {
    availableDecisions: [
      "accept",
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: [{ program: "git" }] } },
      "decline",
    ],
  }))
  await waitFor(() => process.clientResponses.some((message) => message.id === "structured-request" && "error" in message), "structured decision rejection")
  assert.equal(h.interactions.listPending({
    projectId: "project-1",
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
  }).length, 0)
  h.close()
})

test("missing command decisions fail closed instead of inventing a legacy approval menu", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "missing-decisions", sessionId: "missing-decisions-session", cwd: h.dir })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Ask for approval" })
  const process = h.processes[0]!
  for (const [requestId, availableDecisions] of [["omitted-decisions", undefined], ["null-decisions", null]] as const) {
    process.request(requestId, "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, {
      availableDecisions,
      itemId: `${requestId}-item`,
    }))
  }
  await waitFor(
    () => process.clientResponses.filter((message) => "error" in message).length === 2,
    "missing decision rejection",
  )
  assert.equal(h.interactions.listPending({
    projectId: "project-1",
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
  }).length, 0)
  h.close()
})

test("generated MCP titled multi-select shapes map exactly and enforce item bounds", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "mcp-anyof", sessionId: "mcp-anyof-session", cwd: h.dir })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Map MCP schema" })
  h.processes[0]!.request("mcp-anyof-request", "mcpServer/elicitation/request", {
    threadId: binding.codexThreadId,
    turnId,
    serverName: "tickets",
    mode: "form",
    _meta: null,
    message: "Choose labels",
    requestedSchema: {
      type: "object",
      properties: {
        labels: {
          type: "array",
          title: "Labels",
          minItems: 1,
          maxItems: 2,
          items: { anyOf: [{ const: "bug", title: "Bug" }, { const: "urgent", title: "Urgent" }] },
          default: ["bug"],
        },
      },
      required: ["labels"],
    },
  })
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1, "MCP titled multi-select")
  const record = h.interactions.listPending(scope)[0]!
  assert.equal(record.payload.kind, "mcp-elicitation-form")
  if (record.payload.kind !== "mcp-elicitation-form") assert.fail("unexpected interaction kind")
  assert.deepEqual(record.payload.fields, [{
    id: "labels",
    label: "Labels",
    required: true,
    secret: false,
    input: "multi-select",
    options: [{ value: "bug", label: "Bug" }, { value: "urgent", label: "Urgent" }],
    minItems: 1,
    maxItems: 2,
    default: ["bug"],
  }])
  h.close()
})

test("JSONL parsing preserves partial records and closes on malformed or flooded input", async () => {
  const partial = harness()
  await partial.bridge.startDisposableSession({ threadSlug: "partial-jsonl", sessionId: "partial-jsonl-session", cwd: partial.dir })
  const partialProcess = partial.processes[0]!
  partialProcess.sendRaw('{"method":"unknown/notification","params":')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(partialProcess.killed, false)
  partialProcess.sendRaw('{} }\n')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(partialProcess.killed, false)
  partialProcess.sendRaw("not-json\n")
  await waitFor(() => partialProcess.killed, "malformed JSONL disconnect")
  partial.close()

  const flooded = harness()
  await flooded.bridge.startDisposableSession({ threadSlug: "flood-jsonl", sessionId: "flood-jsonl-session", cwd: flooded.dir })
  const floodProcess = flooded.processes[0]!
  floodProcess.sendBatch(Array.from({ length: 257 }, (_, index) => ({
    method: "unknown/notification",
    params: { index },
  })))
  await waitFor(() => floodProcess.killed, "bounded inbound queue disconnect")
  flooded.close()

  const versioned = harness()
  await versioned.bridge.startDisposableSession({ threadSlug: "versioned-jsonl", sessionId: "versioned-jsonl-session", cwd: versioned.dir })
  const versionedProcess = versioned.processes[0]!
  versionedProcess.send({ jsonrpc: "2.0", method: "unknown/notification", params: {} })
  await waitFor(() => versionedProcess.killed, "versioned envelope disconnect")
  versioned.close()
})

test("stderr diagnostics are byte-only and never retain provider or token text", async () => {
  const h = harness()
  await h.bridge.startDisposableSession({ threadSlug: "stderr-safe", sessionId: "stderr-safe-session", cwd: h.dir })
  const secret = "stderr-secret-token-that-must-not-escape"
  h.processes[0]!.stderr.write(secret)
  h.processes[0]!.stderr.write("x".repeat(20_000))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const serialized = JSON.stringify(h.diagnostics)
  assert.equal(serialized.includes(secret), false)
  assert.ok(h.diagnostics.some((event) => (event as Message).event === "stderr" && (event as Message).truncated === true))
  h.close()
})

test("request acknowledgements cannot cross bridge-owned session boundaries", async () => {
  const h = harness()
  const left = await h.bridge.startDisposableSession({ threadSlug: "left-thread", sessionId: "left-session", cwd: h.dir })
  const right = await h.bridge.startDisposableSession({ threadSlug: "right-thread", sessionId: "right-session", cwd: h.dir })
  await h.bridge.startTurn({ threadSlug: left.threadSlug, sessionId: left.sessionId, text: "Left" })
  const { turnId } = await h.bridge.startTurn({ threadSlug: right.threadSlug, sessionId: right.sessionId, text: "Right" })
  const process = h.processes[0]!
  process.request("right-approval", "item/commandExecution/requestApproval", commandParams(right.codexThreadId, turnId))
  const scope = { projectId: "project-1", threadSlug: right.threadSlug, sessionId: right.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1)
  const pending = h.interactions.listPending(scope)[0]!
  await h.bridge.resolveInteraction(scope, {
    slug: right.threadSlug,
    sessionId: right.sessionId,
    interactionId: pending.id,
    sessionEpoch: pending.owner.sessionEpoch,
    capabilityRevision: pending.owner.capabilityRevision,
    expectedRecordRevision: 0,
    responseId: "right-response",
    decisionId: "accept",
  })
  await waitFor(() => process.clientResponses.some((message) => message.id === "right-approval"))
  process.notify("serverRequest/resolved", { threadId: left.codexThreadId, requestId: "right-approval" })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(h.interactions.get(scope, pending.id)?.lifecycle, "pending")
  process.notify("serverRequest/resolved", { threadId: right.codexThreadId, requestId: "right-approval" })
  await waitFor(() => h.interactions.get(scope, pending.id)?.lifecycle === "resolved")
  h.close()
})

test("restart never blindly replays a sent response, and retires the card whose turn died with the connection", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "persisted-thread",
    sessionId: "frizz-session-persisted",
    cwd: h.dir,
    ephemeral: false,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Run the tests",
  })
  const first = h.processes[0]!
  const params = commandParams(binding.codexThreadId, turnId)
  first.request("approval-old", "item/commandExecution/requestApproval", params)
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1)
  const pending = h.interactions.listPending(scope)[0]!
  await h.bridge.resolveInteraction(scope, {
    slug: binding.threadSlug,
    sessionId: binding.sessionId,
    interactionId: pending.id,
    sessionEpoch: pending.owner.sessionEpoch,
    capabilityRevision: pending.owner.capabilityRevision,
    expectedRecordRevision: 0,
    responseId: "human-response-restart",
    decisionId: "accept",
  })
  await waitFor(() => first.clientResponses.some((message) => message.id === "approval-old"))
  first.disconnect()
  h.bridge.close()
  const restarted = h.newBridge()

  await restarted.resumeOwnedSession(binding.threadSlug, binding.sessionId)
  assert.equal(h.processes.length, 2)
  const second = h.processes[1]!
  assert.ok(second.clientRequests.some((message) => message.method === "thread/resume"))
  assert.equal(second.clientResponses.length, 0, "SENT/unknown response is not replayed during reconnect reconciliation")
  // The decided response went to a connection that is now dead, and no acknowledgement can ever
  // arrive: the turn it belonged to died with that connection (measured against the real app-server in
  // scripts/verify-codex-turn-survives-connection.mjs), and the provider can only re-ask inside a NEW
  // turn — a different logical request by construction, so nothing will ever rebind this one. Retiring
  // it at the rebind is what keeps the thread from dangling on an unanswerable card forever.
  assert.equal(h.interactions.get(scope, pending.id)?.lifecycle, "cancelled")
  assert.equal(h.interactions.get(scope, pending.id)?.cancellationReason, "turn-ended")
  first.request("stale-old-connection", "item/commandExecution/requestApproval", {
    ...params,
    itemId: "item-from-stale-connection",
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(h.interactions.listPending(scope).length, 0, "messages from the disconnected epoch are ignored")

  // A fresh turn on the live connection asks again and is journaled as its own card — the retired one
  // is never resurrected, and the human is asked once, on the turn that is actually running.
  const { turnId: restartTurnId } = await restarted.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Continue",
  })
  assert.notEqual(restartTurnId, turnId)
  second.request("approval-new", "item/commandExecution/requestApproval", {
    ...params,
    turnId: restartTurnId,
    startedAtMs: (params.startedAtMs as number) + 5_000,
  })
  await waitFor(() => h.interactions.listPending(scope).length === 1, "fresh-turn approval card")
  const reasked = h.interactions.listPending(scope)[0]!
  assert.notEqual(reasked.id, pending.id)
  assert.equal(second.clientResponses.length, 0, "a retired decision is never auto-answered on the new turn")
  h.close()
})

test("typed request adapters cover file, permissions, standard MCP form/URL, and experimental user input", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "typed-thread",
    sessionId: "typed-session",
    cwd: h.dir,
  })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Exercise adapters" })
  const process = h.processes[0]!
  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "item-file",
      status: "inProgress",
      changes: [{
        path: join(h.dir, "generated.txt"),
        kind: { type: "add" },
        diff: "+generated output\n",
      }],
    },
  })
  process.request("file-1", "item/fileChange/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "item-file",
    startedAtMs: Date.now(),
    reason: "Write generated output",
    grantRoot: h.dir,
  })
  process.request("permissions-1", "item/permissions/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "item-permissions",
    environmentId: null,
    startedAtMs: Date.now(),
    cwd: h.dir,
    reason: "Reach the package registry",
    permissions: { network: { enabled: true }, fileSystem: null },
  })
  process.request("mcp-form-1", "mcpServer/elicitation/request", {
    threadId: binding.codexThreadId,
    turnId,
    serverName: "github",
    mode: "form",
    _meta: null,
    message: "Choose a repository",
    requestedSchema: {
      type: "object",
      properties: { repo: { type: "string", title: "Repository", minLength: 1 } },
      required: ["repo"],
    },
  })
  process.request("mcp-url-1", "mcpServer/elicitation/request", {
    threadId: binding.codexThreadId,
    turnId,
    serverName: "github",
    mode: "url",
    _meta: null,
    message: "Authorize access",
    url: "https://example.test/authorize?state=opaque",
    elicitationId: "elicit-url-1",
  })
  process.request("question-1", "item/tool/requestUserInput", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "item-question",
    autoResolutionMs: 60_000,
    questions: [{
      id: "choice",
      header: "Choice",
      question: "Which option?",
      isOther: false,
      isSecret: false,
      options: [{ label: "A", description: "Option A" }, { label: "B", description: "Option B" }],
    }],
  })
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 5, "all typed interactions")
  assert.deepEqual(
    h.interactions.listPending(scope).map((record) => record.payload.kind).sort(),
    ["agent-question", "file-approval", "mcp-elicitation-form", "mcp-elicitation-url", "permission-approval"].sort(),
  )
  const pendingByKind = new Map(h.interactions.listPending(scope).map((record) => [record.payload.kind, record]))
  const choices = [
    ["file-approval", "file-response", "acceptForSession", undefined],
    ["permission-approval", "permission-response", "grant-session", undefined],
    ["mcp-elicitation-form", "mcp-form-response", "accept", { repo: "openai/codex" }],
    ["mcp-elicitation-url", "mcp-url-response", "decline", undefined],
    ["agent-question", "question-response", "answer", { choice: "A" }],
  ] as const
  for (const [kind, responseId, decisionId, values] of choices) {
    const record = pendingByKind.get(kind)!
    await h.bridge.resolveInteraction(scope, {
      slug: binding.threadSlug,
      sessionId: binding.sessionId,
      interactionId: record.id,
      sessionEpoch: record.owner.sessionEpoch,
      capabilityRevision: record.owner.capabilityRevision,
      expectedRecordRevision: record.recordRevision,
      responseId,
      decisionId,
      ...(values === undefined ? {} : { values }),
    })
  }
  await waitFor(() => process.clientResponses.length === 5, "all typed provider responses")
  assert.deepEqual(process.clientResponses, [
    { id: "file-1", result: { decision: "acceptForSession" } },
    { id: "permissions-1", result: { permissions: { network: { enabled: true } }, scope: "session" } },
    { id: "mcp-form-1", result: { action: "accept", content: { repo: "openai/codex" }, _meta: null } },
    { id: "mcp-url-1", result: { action: "decline", content: null, _meta: null } },
    { id: "question-1", result: { answers: { choice: { answers: ["A"] } } } },
  ])
  h.close()
})

test("exact 0.144.1 permissions and user-input choices never advertise fabricated cancellation responses", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "response-contract-thread",
    sessionId: "response-contract-session",
    cwd: h.dir,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Exercise exact response contracts",
  })
  const process = h.processes[0]!
  process.request("permission-contract", "item/permissions/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "permission-contract-item",
    environmentId: null,
    startedAtMs: Date.now(),
    cwd: h.dir,
    reason: "Need network",
    permissions: { network: { enabled: true }, fileSystem: null },
  })
  process.request("question-contract", "item/tool/requestUserInput", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "question-contract-item",
    autoResolutionMs: null,
    questions: [{
      id: "choice",
      header: "Choice",
      question: "Which option?",
      isOther: false,
      isSecret: false,
      options: [{ label: "A", description: "Option A" }],
    }],
  })
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 2, "exact response interactions")
  const byKind = new Map(h.interactions.listPending(scope).map((record) => [record.payload.kind, record]))
  const permission = byKind.get("permission-approval")!
  const question = byKind.get("agent-question")!
  assert.deepEqual(permission.allowedDecisions.map(({ id, semantic }) => ({ id, semantic })), [
    { id: "grant-turn", semantic: "approve" },
    { id: "grant-session", semantic: "approve" },
    { id: "deny", semantic: "deny" },
  ])
  assert.deepEqual(question.allowedDecisions.map(({ id, semantic }) => ({ id, semantic })), [
    { id: "answer", semantic: "answer" },
  ])
  for (const [record, decisionId] of [[permission, "cancel"], [question, "decline"], [question, "cancel"]] as const) {
    await assert.rejects(
      h.bridge.resolveInteraction(scope, {
        slug: scope.threadSlug,
        sessionId: scope.sessionId,
        interactionId: record.id,
        sessionEpoch: record.owner.sessionEpoch,
        capabilityRevision: record.owner.capabilityRevision,
        expectedRecordRevision: record.recordRevision,
        responseId: `unsupported-${decisionId}`,
        decisionId,
      }),
      (error: unknown) => error instanceof InteractionStoreError && error.code === "invalid-decision",
    )
  }
  await h.bridge.resolveInteraction(scope, {
    slug: scope.threadSlug,
    sessionId: scope.sessionId,
    interactionId: permission.id,
    sessionEpoch: permission.owner.sessionEpoch,
    capabilityRevision: permission.owner.capabilityRevision,
    expectedRecordRevision: permission.recordRevision,
    responseId: "deny-permissions",
    decisionId: "deny",
  })
  await h.bridge.resolveInteraction(scope, {
    slug: scope.threadSlug,
    sessionId: scope.sessionId,
    interactionId: question.id,
    sessionEpoch: question.owner.sessionEpoch,
    capabilityRevision: question.owner.capabilityRevision,
    expectedRecordRevision: question.recordRevision,
    responseId: "answer-question",
    decisionId: "answer",
    values: { choice: "A" },
  })
  await waitFor(() => process.clientResponses.length === 2, "exact response payloads")
  assert.deepEqual(process.clientResponses, [
    { id: "permission-contract", result: { permissions: {}, scope: "turn" } },
    { id: "question-contract", result: { answers: { choice: { answers: ["A"] } } } },
  ])
  h.close()
})

test("secret user-input capability is unavailable instead of rendering an unusable durable action", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "secret-thread", sessionId: "secret-session", cwd: h.dir })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Ask safely" })
  const process = h.processes[0]!
  process.request("secret-question", "item/tool/requestUserInput", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "item-secret",
    autoResolutionMs: null,
    questions: [{ id: "token", header: "Token", question: "Enter token", isOther: false, isSecret: true, options: null }],
  })
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(
    () => process.clientResponses.some((message) => message.id === "secret-question" && "error" in message),
    "secret capability rejection",
  )
  assert.equal(h.interactions.listPending(scope).length, 0)
  assert.ok(h.diagnostics.some((event) => (
    (event as Message).event === "request-rejected" &&
    (event as Message).method === "item/tool/requestUserInput"
  )))
  h.close()
})

test("an OLDER Codex fails negotiation before any thread is created", async () => {
  // The floor. An older binary may genuinely lack params frizz sends, and that is the direction where
  // proceeding produces silent misbehaviour rather than a loud failure.
  const h = harness("0.143.0")
  await assert.rejects(
    h.bridge.startDisposableSession({ threadSlug: "bad-version", sessionId: "bad-version-session", cwd: h.dir }),
    /older than the audited protocol/,
  )
  assert.equal(h.processes[0]!.clientRequests.some((message) => message.method === "thread/start"), false)
  assert.deepEqual(h.diagnostics, [{
    event: "version-rejected",
    expected: CODEX_APP_SERVER_SUPPORTED_VERSION,
    received: "0.143.0",
  }])
  h.close()
})

/** One minor above the audited pin — always "newer", whatever the pin is re-audited to. */
function aheadOfPin(): string {
  const [major, minor] = CODEX_APP_SERVER_SUPPORTED_VERSION.split(".").map(Number)
  return `${major}.${minor + 1}.0`
}

test("a NEWER Codex RUNS, and records that it is ahead of the audit", async () => {
  // This case used to be a hard refusal, and that made one `npm i -g @openai/codex` a total,
  // permanent Codex outage: no fallback transport, every operation gated behind ensureConnected, recovery
  // only by editing a source constant and rebuilding frizz. codex ships a stable roughly every two
  // days, so the pin is behind a published stable almost immediately after every re-audit.
  // Derived from the pin rather than written as a literal: a re-pin used to silently turn this test's
  // hardcoded "newer" version into an OLDER one, testing the refusal path under the ahead path's name.
  const ahead = aheadOfPin()
  const h = harness(ahead)
  const session = await h.bridge.startDisposableSession({ threadSlug: "newer", sessionId: "newer-session", cwd: h.dir })
  assert.ok(session, "a newer app-server is usable")
  assert.equal(h.processes[0]!.clientRequests.some((message) => message.method === "thread/start"), true)
  assert.ok(
    h.diagnostics.some((d) => (d as { event?: string; received?: string }).event === "version-ahead" && (d as { received?: string }).received === ahead),
    `diagnostics were ${JSON.stringify(h.diagnostics)}`,
  )
  h.close()
})

test("closing during initialize keeps SQLite alive until negotiation unwinds", async () => {
  let bridge: CodexAppServerBridge
  const h = harness(CODEX_APP_SERVER_SUPPORTED_VERSION, (process) => {
    process.afterInitializeResponse = () => queueMicrotask(() => bridge.close())
  })
  bridge = h.bridge
  await assert.rejects(
    bridge.startDisposableSession({ threadSlug: "closing-thread", sessionId: "closing-session", cwd: h.dir }),
    /closed during negotiation|connection is closed|connection closed/,
  )
  assert.equal(h.processes[0]?.killed, true)
  h.close()
})

test("shutdown re-detaches a binding written by an operation already past its RPC await", async () => {
  let bridge: CodexAppServerBridge
  const h = harness(CODEX_APP_SERVER_SUPPORTED_VERSION, (process) => {
    process.afterThreadStartResponse = () => queueMicrotask(() => bridge.close())
  })
  bridge = h.bridge

  await bridge.startDisposableSession({
    threadSlug: "closing-after-response",
    sessionId: "closing-after-response-session",
    cwd: h.dir,
  })
  await bridge.shutdown()
  const row = h.db.prepare<[], { state: string }>(`
    SELECT state FROM codex_app_server_session
    WHERE project_id = 'project-1' AND thread_slug = 'closing-after-response'
  `).get()
  assert.equal(row?.state, "detached", "no operation can leave live native authority after shutdown")
  h.close()
})

test("registry replacement releases only its exact native binding, process requests, and delivery authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-codex-lifecycle-"))
  const storage = createStorage(join(dir, "ui.db"), "project-1")
  const processes: FakeAppServerProcess[] = []
  const bridge = new CodexAppServerBridge({
    projectId: "project-1",
    projectDir: dir,
    db: storage.db,
    interactions: storage.interactions,
    spawn: () => {
      const process = new FakeAppServerProcess()
      processes.push(process)
      return process
    },
    requestTimeoutMs: 1_000,
  })
  storage.subscribeSessionLifecycle((event) => {
    bridge.releaseSession(
      event.previous.slug,
      event.previous.session_id,
      event.type === "replaced" ? "session-replaced" : "session-deleted",
    )
  })
  storage.upsertSession(sessionRow("native-thread", "native-session", "codex-app-server"))
  storage.upsertSession(sessionRow("tui-thread", "tui-session", "codex"))
  const binding = await bridge.startDisposableSession({
    threadSlug: "native-thread",
    sessionId: "native-session",
    cwd: dir,
  })
  const { turnId } = await bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Wait for approval",
  })
  const process = processes[0]!
  process.request("lifecycle-approval", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId))
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => storage.interactions.listPending(scope).length === 1, "lifecycle interaction")
  const pending = storage.interactions.listPending(scope)[0]!

  // A normal Codex TUI registry replacement has no app-server binding and must not touch the child.
  storage.upsertSession(sessionRow("tui-thread", "tui-session-replacement", "codex"))
  assert.equal(process.killed, false)
  assert.equal(bridge.binding(binding.threadSlug, binding.sessionId)?.state, "active")

  storage.upsertSession(sessionRow("native-thread", "native-session-replacement", "codex-app-server"))
  await waitFor(() => process.killed, "native child termination")
  assert.equal(bridge.binding(binding.threadSlug, binding.sessionId), undefined)
  assert.equal(bridge.ownsInteraction(scope, pending.id), false)
  assert.equal(storage.interactions.get(scope, pending.id)?.lifecycle, "cancelled")
  assert.equal(storage.interactions.get(scope, pending.id)?.cancellationReason, "session-replaced")
  assert.equal(storage.interactions.providerDelivery(scope, pending.id)?.state, "cancelled")

  storage.upsertSession(sessionRow("delete-thread", "delete-session", "codex-app-server"))
  const deleteBinding = await bridge.startDisposableSession({
    threadSlug: "delete-thread",
    sessionId: "delete-session",
    cwd: dir,
  })
  const deleteTurn = await bridge.startTurn({
    threadSlug: deleteBinding.threadSlug,
    sessionId: deleteBinding.sessionId,
    text: "Wait for deletion",
  })
  const deleteProcess = processes[1]!
  deleteProcess.request(
    "delete-approval",
    "item/commandExecution/requestApproval",
    commandParams(deleteBinding.codexThreadId, deleteTurn.turnId),
  )
  const deleteScope = {
    projectId: "project-1",
    threadSlug: deleteBinding.threadSlug,
    sessionId: deleteBinding.sessionId,
  }
  await waitFor(() => storage.interactions.listPending(deleteScope).length === 1, "delete interaction")
  const deletePending = storage.interactions.listPending(deleteScope)[0]!
  storage.forgetSession(deleteBinding.threadSlug)
  await waitFor(() => deleteProcess.killed, "deleted native child termination")
  assert.equal(bridge.binding(deleteBinding.threadSlug, deleteBinding.sessionId), undefined)
  assert.equal(storage.interactions.get(deleteScope, deletePending.id)?.cancellationReason, "session-deleted")
  assert.equal(storage.interactions.providerDelivery(deleteScope, deletePending.id)?.state, "cancelled")
  bridge.close()
  storage.close()
})

test("bridge close detaches persisted bindings and makes pending delivery rows non-actionable", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "close-authority-thread",
    sessionId: "close-authority-session",
    cwd: h.dir,
    ephemeral: false,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Wait for close",
  })
  h.processes[0]!.request("close-approval", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId))
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1, "close interaction")
  const pending = h.interactions.listPending(scope)[0]!
  assert.equal(h.bridge.ownsInteraction(scope, pending.id), true)
  h.bridge.close()
  assert.equal(h.processes[0]!.killed, true)
  assert.equal(h.bridge.ownsInteraction(scope, pending.id), false)
  const persisted = h.db.prepare<[string], { state: string; current_turn_id: string | null }>(`
    SELECT state, current_turn_id FROM codex_app_server_session WHERE project_id = 'project-1' AND frizz_session_id = ?
  `).get(binding.sessionId)
  assert.deepEqual(persisted, { state: "detached", current_turn_id: turnId })
  assert.equal(h.interactions.providerDelivery(scope, pending.id)?.state, "awaiting-user")
  h.close()
})

test("bridge persistence refuses malformed or future authority schemas before spawning Codex", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-codex-app-server-corrupt-"))
  const dbPath = join(dir, "ui.db")
  const db = new Database(dbPath)
  const interactions = createInteractionStore(db)
  db.exec("CREATE TABLE codex_app_server_meta (singleton INTEGER PRIMARY KEY)")
  let spawned = false
  assert.throws(
    () => new CodexAppServerBridge({
      projectId: "project-1",
      projectDir: dir,
      db,
      interactions,
      spawn: () => {
        spawned = true
        return new FakeAppServerProcess()
      },
    }),
    (error: unknown) => error instanceof InteractionStoreError && error.code === "schema-version",
  )
  assert.equal(spawned, false)
  interactions.dispose()
  db.close()

  const futurePath = join(dir, "future.db")
  const futureDb = new Database(futurePath)
  const futureInteractions = createInteractionStore(futureDb)
  futureDb.exec(`
    CREATE TABLE codex_app_server_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    INSERT INTO codex_app_server_schema VALUES (1, 2);
  `)
  assert.throws(
    () => new CodexAppServerBridge({
      projectId: "project-1",
      projectDir: dir,
      db: futureDb,
      interactions: futureInteractions,
      spawn: () => {
        spawned = true
        return new FakeAppServerProcess()
      },
    }),
    (error: unknown) => error instanceof InteractionStoreError && error.code === "schema-version",
  )
  assert.equal(futureDb.prepare<[], { count: number }>(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name IN ('codex_app_server_meta', 'codex_app_server_session')
  `).get()?.count, 0, "future schemas are refused before authority tables are mutated")
  futureInteractions.dispose()
  futureDb.close()
})


// ---- daemon lifecycle: what an attachment REPORTS about the stream it just joined ------------------

/** A bridge harness whose host is scripted attachment-by-attachment: it decides `reattached`, the
 *  `generation`, and how many lines the daemon had to drop while nobody was attached. Those three
 *  fields are the entire input to the bridge's "did my turns survive?" decision. */
function scriptedHostHarness(script: () => { generation: string; reattached: boolean; droppedWhileDetached: number }) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-codex-attachment-"))
  const dbPath = join(dir, "ui.db")
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  const now = new Date("2026-07-13T12:00:00.000Z")
  let clientId = 0
  const diagnostics: unknown[] = []
  const interactions = createInteractionStore(db, { now: () => now, id: () => `interaction-${++clientId}` })
  const processes: FakeAppServerProcess[] = []
  const bridges: CodexAppServerBridge[] = []
  let nextResumeThreadStatus: { type: string; activeFlags?: string[] } | undefined
  const newBridge = () => {
    const bridge = new CodexAppServerBridge({
      projectId: "project-1",
      projectDir: dir,
      db,
      interactions,
      codexBin: "/opt/codex",
      host: async (options) => {
        const process_ = new FakeAppServerProcess()
        // Applied at CREATION: the reconnect's process does not exist until the bridge connects, which
        // is the same call whose reconciliation the status has to steer.
        process_.resumeThreadStatus = nextResumeThreadStatus
        processes.push(process_)
        const { generation, reattached, droppedWhileDetached } = script()
        return { process: process_, generation, reattached, daemonPid: 4242, droppedWhileDetached, authAccountId: options.authAccountId }
      },
      now: () => now,
      id: () => `client-message-${++clientId}`,
      requestTimeoutMs: 1_000,
      diagnostic: (event) => diagnostics.push(event),
      codexAuthAccountId: () => undefined,
    })
    bridges.push(bridge)
    return bridge
  }
  return {
    dir,
    processes,
    diagnostics,
    interactions,
    newBridge,
    /** What the NEXT app-server process reports for `thread.status` on `thread/resume`. */
    resumeThreadStatus(status: { type: string; activeFlags?: string[] } | undefined) {
      nextResumeThreadStatus = status
    },
    close() {
      for (const bridge of bridges.reverse()) bridge.close()
      interactions.dispose()
      db.close()
    },
  }
}

// The clean rejoin: same app-server, nothing lost. The turn is still RUNNING inside that process, so
// touching it would be the bug — `thread/resume` against a live turn disturbs it and clearing
// `current_turn_id` would orphan the `turn/completed` still on its way.
test("a lossless reattach to the same app-server keeps the in-flight turn exactly as it was", async () => {
  let plan = { generation: "gen-A", reattached: false, droppedWhileDetached: 0 }
  const h = scriptedHostHarness(() => plan)
  const bridge = h.newBridge()
  const binding = await bridge.startDisposableSession({
    threadSlug: "lossless", sessionId: "lossless-session", cwd: h.dir, ephemeral: false,
  })
  const { turnId } = await bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Work" })
  await waitFor(() => bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === turnId, "turn active")
  bridge.close() // the frizz runtime is recycled; the daemon and the turn keep going

  plan = { generation: "gen-A", reattached: true, droppedWhileDetached: 0 }
  const restarted = h.newBridge()
  await restarted.resumeOwnedSession(binding.threadSlug, binding.sessionId)
  const rejoined = restarted.binding(binding.threadSlug, binding.sessionId)!
  assert.equal(rejoined.state, "active")
  assert.equal(rejoined.currentTurnId, turnId, "the live turn is still ours; nothing was lost")
  assert.equal(
    h.processes[1]!.clientRequests.filter((message) => message.method === "thread/resume").length,
    0,
    "a live turn is never resumed out from under itself",
  )
  h.close()
})

// ---- ground truth beats guessing: the two endings of a lossy rejoin -------------------------------
// A transport that DROPS events while detached (`codex app-server --listen unix://`) can never infer
// from the stream whether the turn it left behind is still running. Both guesses are wrong somewhere,
// so the bridge asks: `thread/resume` reports `thread.status`, and these two tests pin BOTH answers.

// Ending 1 — the turn FINISHED during the gap. Its `turn/completed` was dropped and is never coming,
// so believing the stream would wedge `current_turn_id` forever. That is the 2026-07-22 incident.
test("a lossy rejoin whose turn ended while detached settles the turn instead of wedging on it", async () => {
  let plan = { generation: "gen-A", reattached: false, droppedWhileDetached: 0 }
  const h = scriptedHostHarness(() => plan)
  const bridge = h.newBridge()
  const binding = await bridge.startDisposableSession({
    threadSlug: "ended-in-gap", sessionId: "ended-in-gap-session", cwd: h.dir, ephemeral: false,
  })
  const { turnId } = await bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Work" })
  await waitFor(() => bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === turnId, "turn active")
  bridge.close()

  plan = { generation: "gen-A", reattached: true, droppedWhileDetached: 1 }
  h.resumeThreadStatus({ type: "idle" })   // the app-server: that turn is over
  const restarted = h.newBridge()
  await restarted.resumeOwnedSession(binding.threadSlug, binding.sessionId)
  const rebound = restarted.binding(binding.threadSlug, binding.sessionId)!
  assert.equal(rebound.state, "active")
  assert.equal(rebound.currentTurnId, null, "an ended turn must be retired, not waited on forever")
  h.close()
})

// Ending 2 — the turn is STILL RUNNING. It outlived our restart inside the app-server, so retiring it
// would cancel its cards and nudge a worker that was never interrupted; the reconnect must leave it
// strictly alone beyond the `thread/resume` that re-subscribes this connection to its events.
test("a lossy rejoin whose turn is still running leaves that turn alone and does not nudge it", async () => {
  let plan = { generation: "gen-A", reattached: false, droppedWhileDetached: 0 }
  const h = scriptedHostHarness(() => plan)
  const bridge = h.newBridge()
  const binding = await bridge.startDisposableSession({
    threadSlug: "alive-across-gap", sessionId: "alive-across-gap-session", cwd: h.dir, ephemeral: false,
  })
  const { turnId } = await bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Work" })
  await waitFor(() => bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === turnId, "turn active")
  bridge.close()

  plan = { generation: "gen-A", reattached: true, droppedWhileDetached: 1 }
  h.resumeThreadStatus({ type: "active", activeFlags: [] })   // still running
  const restarted = h.newBridge()
  await restarted.resumeOwnedSession(binding.threadSlug, binding.sessionId)
  const rejoined = restarted.binding(binding.threadSlug, binding.sessionId)!
  assert.equal(rejoined.state, "active")
  assert.equal(rejoined.currentTurnId, turnId, "a turn the server says is RUNNING stays current")
  // The nudge is issued from warmUp(); a live turn must not have been queued for one.
  await restarted.warmUp()
  const nudged = h.processes[1]!.clientRequests.filter((message) => message.method === "turn/start")
  assert.equal(nudged.length, 0, `a running turn must never be nudged — saw ${JSON.stringify(nudged)}`)
  h.close()
})

// The daemon caps its detached queue and reports the overflow in `hello` SPECIFICALLY so the client
// learns it must not trust the stream — and the client used to throw that control line away unread.
// A dropped `turn/completed` under a `sameProcess` rejoin wedges `current_turn_id` forever, waiting on
// an event the daemon already discarded. Losing events makes the rejoin a COLD one, by definition.
test("a reattach that lost events is not a rejoin: the thread resumes instead of trusting the stream", async () => {
  let plan = { generation: "gen-A", reattached: false, droppedWhileDetached: 0 }
  const h = scriptedHostHarness(() => plan)
  const bridge = h.newBridge()
  const binding = await bridge.startDisposableSession({
    threadSlug: "lossy", sessionId: "lossy-session", cwd: h.dir, ephemeral: false,
  })
  const { turnId } = await bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Work" })
  await waitFor(() => bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === turnId, "turn active")
  bridge.close()

  plan = { generation: "gen-A", reattached: true, droppedWhileDetached: 31 }
  const restarted = h.newBridge()
  await restarted.resumeOwnedSession(binding.threadSlug, binding.sessionId)
  const rebound = restarted.binding(binding.threadSlug, binding.sessionId)!
  assert.equal(rebound.state, "active")
  assert.equal(rebound.currentTurnId, null, "a turn whose completion may have been dropped cannot stay current")
  assert.ok(
    h.processes[1]!.clientRequests.some((message) => message.method === "thread/resume"),
    "the honest recovery for a holed stream is the cold path",
  )
  assert.ok(
    h.diagnostics.some((event) => (event as Message).event === "daemon-events-dropped" && (event as Message).dropped === 31),
    `the loss is reported, not swallowed — saw ${JSON.stringify(h.diagnostics)}`,
  )
  h.close()
})

// ---- non-interactive by construction ------------------------------------------------------------
// A frizz worker runs with nobody watching its pane, so an approval request is not a safety gate — it is
// a thread that stops working until a human opens the dashboard hours later. These pin the two wire
// moments where that guarantee is made, because the live incident came from BOTH being wrong: the
// thread was started `on-request`, and its cold resume sent no policy at all.
test("thread/start is non-interactive: approvals never, so a worker cannot stall on a modal", async () => {
  const h = harness()
  await h.bridge.startDisposableSession({
    threadSlug: "never-thread", sessionId: "never-session", cwd: h.dir, sandbox: "danger-full-access",
  })
  const start = h.processes[0]!.clientRequests.find((message) => message.method === "thread/start")!
  assert.equal((start.params as Message).approvalPolicy, "never")
  assert.deepEqual((start.params as Message).sandbox, "danger-full-access")
  h.close()
})

// The exact 2026-07-24 incident. `intended_sandbox` arrived as an additive ALTER, so every thread
// dispatched before it exists with that column NULL. The override used to return `{}` for those, which
// hands the decision to config.toml — whose defaults are `workspace-write` + `on-request`. A thread
// dispatched at full access therefore came back sandboxed AND interactive after its app-server died,
// then stalled on an approval per patch. A resume must always state the policy.
test("a cold resume with NO recorded intent still states full access + approvals never", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "legacy-thread", sessionId: "legacy-session", cwd: h.dir, ephemeral: false,
    sandbox: "danger-full-access",
  })
  // Exactly what a pre-migration row looks like: no intent recorded anywhere.
  h.db.prepare("UPDATE codex_app_server_session SET intended_sandbox = NULL, sandbox = NULL WHERE project_id = 'project-1' AND frizz_session_id = ?")
    .run(binding.sessionId)
  h.processes[0]!.disconnect()
  h.bridge.close()

  const restarted = h.newBridge()
  await restarted.resumeOwnedSession(binding.threadSlug, binding.sessionId)
  const resume = h.processes[1]!.clientRequests.find((message) => message.method === "thread/resume")!
  assert.equal((resume.params as Message).sandbox, "danger-full-access", "a worker with no stated intent is a full-access worker")
  assert.equal((resume.params as Message).approvalPolicy, "never", "config.toml must never get to decide this")
  h.close()
})

// The card that would not go away. A rejoin of the SAME app-server keeps the turn (correctly — it is
// still running in there), but the approval it was blocked on was issued on the client connection we
// just lost: its rpc id means nothing on the new socket, so it can never be answered. Nothing on this
// path retired those cards, so they sat in the queue rendering "Runtime unavailable" forever.
test("a same-process rejoin retires the approval orphaned on the connection it lost", async () => {
  let plan = { generation: "gen-A", reattached: false, droppedWhileDetached: 0 }
  const h = scriptedHostHarness(() => plan)
  const bridge = h.newBridge()
  const binding = await bridge.startDisposableSession({
    threadSlug: "orphan", sessionId: "orphan-session", cwd: h.dir, ephemeral: false,
  })
  const { turnId } = await bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Work" })
  await waitFor(() => bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === turnId, "turn active")
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  h.processes[0]!.request("orphan-approval", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId))
  await waitFor(() => h.interactions.listPending(scope).length === 1, "approval card raised")
  const orphaned = h.interactions.listPending(scope)[0]!
  bridge.close() // frizz restarts; the daemon and its blocked turn keep going

  plan = { generation: "gen-A", reattached: true, droppedWhileDetached: 0 }
  const restarted = h.newBridge()
  await restarted.resumeOwnedSession(binding.threadSlug, binding.sessionId)
  assert.equal(
    restarted.binding(binding.threadSlug, binding.sessionId)?.currentTurnId,
    turnId,
    "the live turn is still ours — retiring its card must not disturb it",
  )
  assert.equal(h.interactions.get(scope, orphaned.id)?.lifecycle, "cancelled")
  assert.equal(h.interactions.listPending(scope).length, 0, "no unanswerable card is left in the queue")
  h.close()
})

// A sub-agent (spawn_agent) child is a turn INSIDE the app-server process, so it dies with it and
// CANNOT be resumed — recovery of the children is the parent model's job. Before the nudge named this,
// it recovered only when the model happened to notice ("three had returned, but six did not", the
// 2026-07-24 loss). The cold-recovery nudge must state the failure mode and point at list_agents so
// re-establishment is reliable rather than lucky.
test("a cold-recovery nudge tells the model its sub-agents died and to re-spawn them", async () => {
  let plan = { generation: "gen-A", reattached: false, droppedWhileDetached: 0 }
  const h = scriptedHostHarness(() => plan)
  const bridge = h.newBridge()
  const binding = await bridge.startDisposableSession({
    threadSlug: "orphaned-children", sessionId: "orphaned-children-session", cwd: h.dir, ephemeral: false,
  })
  const { turnId } = await bridge.startTurn({
    threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Orchestrate six sub-agents",
  })
  await waitFor(() => bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId === turnId, "turn active")
  bridge.close()

  // The app-server DIED and a fresh one replaced it (new generation, fresh fork); its turn is gone.
  plan = { generation: "gen-B", reattached: false, droppedWhileDetached: 0 }
  h.resumeThreadStatus({ type: "idle" }) // the new app-server: that turn is over
  const restarted = h.newBridge()
  await restarted.warmUp()

  const nudge = h.processes[1]!.clientRequests.find((message) => message.method === "turn/start")
  assert.ok(nudge, "a recovery turn was auto-issued")
  const input = (nudge!.params as Message).input as Array<{ text?: string }> | undefined
  const text = input?.[0]?.text ?? ""
  assert.match(text, /sub-agents do NOT survive/i, "the nudge must warn that sub-agents died")
  assert.match(text, /list_agents/, "the nudge must point at list_agents to re-establish them")
  h.close()
})

// Transport selection: native is the default everywhere it works (the app-server owns its socket and
// truly outlives frizz), the --stdio daemon stays the default only on win32 whose named-pipe path native
// does not implement, an injected spawn is always the direct-child test transport, and the flag forces
// either way. This is the flip that made a codex worker's app-server + sub-agents survive a daemon death.
test("selectCodexHostKind: native is the default on macOS/Linux, daemon on Windows", () => {
  assert.equal(selectCodexHostKind(undefined, "darwin", false), "native")
  assert.equal(selectCodexHostKind(undefined, "linux", false), "native")
  assert.equal(selectCodexHostKind(undefined, "win32", false), "daemon")
})

test("selectCodexHostKind: an injected spawn always wins (the test/harness transport)", () => {
  assert.equal(selectCodexHostKind(undefined, "darwin", true), "direct")
  assert.equal(selectCodexHostKind("1", "darwin", true), "direct")
  assert.equal(selectCodexHostKind("0", "win32", true), "direct")
})

test("selectCodexHostKind: the flag forces the transport, and never selects native where it cannot run", () => {
  assert.equal(selectCodexHostKind("0", "darwin", false), "daemon", "0 opts back to the daemon")
  assert.equal(selectCodexHostKind("false", "linux", false), "daemon")
  assert.equal(selectCodexHostKind("1", "linux", false), "native", "1 forces native where supported")
  assert.equal(selectCodexHostKind("true", "darwin", false), "native")
  assert.equal(selectCodexHostKind("1", "win32", false), "daemon", "native is never selected on win32, even forced")
})

// ONE DATABASE, EVERY PROJECT (2026-08-27). Two bridges for two projects share one connection and one
// `codex_app_server_session` table, and a thread slug is only unique WITHIN a project — so the same
// slug bound in both must yield two rows that neither bridge can see across the seam. A scope that
// forgot to name the project on any statement would either refuse to prepare (project-scope.ts) or
// let the second bridge find the first one's binding; this is the net for the second kind.
test("two projects on one connection never see each other's bindings, even for the same thread slug", async () => {
  const h = harness()
  const other = new CodexAppServerBridge({
    projectId: "project-2",
    projectDir: h.dir,
    db: h.db,
    interactions: h.interactions,
    codexBin: "/opt/codex",
    spawn: () => new FakeAppServerProcess(),
    requestTimeoutMs: 1_000,
  })
  try {
    const mine = await h.bridge.startDisposableSession({
      threadSlug: "shared-slug", sessionId: "session-in-project-1", cwd: h.dir, ephemeral: false,
    })
    const theirs = await other.startDisposableSession({
      threadSlug: "shared-slug", sessionId: "session-in-project-2", cwd: h.dir, ephemeral: false,
    })
    assert.notEqual(mine.codexThreadId, theirs.codexThreadId)
    assert.ok(h.bridge.binding("shared-slug", "session-in-project-1"))
    assert.equal(h.bridge.binding("shared-slug", "session-in-project-2"), undefined)
    assert.ok(other.binding("shared-slug", "session-in-project-2"))
    assert.equal(other.binding("shared-slug", "session-in-project-1"), undefined)
    const rows = h.db.prepare<[], { project_id: string; thread_slug: string }>(
      "SELECT project_id, thread_slug FROM codex_app_server_session WHERE thread_slug = 'shared-slug' ORDER BY project_id",
    ).all()
    assert.deepEqual(rows, [
      { project_id: "project-1", thread_slug: "shared-slug" },
      { project_id: "project-2", thread_slug: "shared-slug" },
    ])
    // Each project negotiated its own meta row: two connects, two epochs of 1, not one epoch of 2.
    const epochs = h.db.prepare<[], { project_id: string; connection_epoch: number }>(
      "SELECT project_id, connection_epoch FROM codex_app_server_meta ORDER BY project_id",
    ).all()
    assert.deepEqual(epochs, [
      { project_id: "project-1", connection_epoch: 1 },
      { project_id: "project-2", connection_epoch: 1 },
    ])
    // Releasing in one project leaves the other's row alone.
    assert.equal(other.releaseSession("shared-slug", "session-in-project-2", "session-deleted"), true)
    assert.ok(h.bridge.binding("shared-slug", "session-in-project-1"))
  } finally {
    other.close()
    h.close()
  }
})
