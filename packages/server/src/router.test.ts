import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { mountRouter } from "@frizz/rpc/server"
import { DISPATCH_TASK_BANNER_MARKER, formatThreadMessage, parseThreadMessage, type BoardSnapshot, type Settings, type ThreadView, type TranscriptMessage } from "@frizz/shared"
import type { AuditRecord } from "./audit.ts"
import { deriveDeliveryInFlight, deriveNeedsYou, type BoardManager } from "./board.ts"
import { appendDelivery, holdDelivery, parseDeliveryLedger, projectDeliveryLedger, serializeDeliveryLedger, ticksOnTheirWay } from "./delivery-ledger.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"
import { Bus, Emitter } from "./bus.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import {
  addProjectAtPath,
  createRouter,
  completeRegisteredThread,
  completionConfirmationHold,
  completionNeedsConfirmation,
  githubDispatcherRequest,
  hasPendingPermissionChange,
  hasUnresolvedBackgroundOps,
  isAppServerCodexRow,
  stopAndForgetRegisteredRuntime,
  stopRegisteredRuntime,
  stopRuntimeBySlug,
  stopThreadRuntime,
  validateGithubDispatchProfile,
} from "./router.ts"
import { projectTranscriptPageAgentLifecycles } from "./transcript.ts"
import { readProjectIdFile, writeProjectIdFile } from "./project-root.ts"
import { listProjects, registerProject } from "./project-registry.ts"
import { createStorage, type AdoptionClaimRow, type SessionRow } from "./storage.ts"
import type { AdoptionPaneLookup, PaneIdentity, PaneIdentity as PaneSnapshot } from "./adoption-recovery.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"
const noopTailer: Tailer = {
  get: () => undefined,
  foreignIds: () => [],
  subAgent: () => undefined,
  forget: () => {},
  start: () => {},
  stop: () => {},
  tick: () => {},
}

test("agent lifecycle overlay replaces spawn latency with the retained child runtime", () => {
  const dispatch = {
    name: "Spawn agent",
    detail: "review-runtime",
    agentId: "call_child",
    status: "completed" as const,
    durationMs: 533,
  }
  const page = {
    messages: [{ role: "assistant" as const, text: "", tools: [dispatch], parts: [{ kind: "tools" as const, tools: [dispatch] }] }],
    beforeCursor: null,
    hasEarlier: false,
    reachedTurnBoundary: true,
    transcriptKey: "test-key",
  }
  const projected = projectTranscriptPageAgentLifecycles(page, (id) => id === "call_child" ? {
    startedAt: "2026-07-31T14:50:00.000Z",
    finishedAt: "2026-07-31T15:03:00.000Z",
    outcome: "completed",
  } : undefined)
  const expected = { ...dispatch, agentStatus: "completed" as const, agentElapsedMs: 13 * 60_000 }
  assert.deepEqual(projected.messages[0].tools[0], expected)
  assert.deepEqual(projected.messages[0].parts[0], { kind: "tools", tools: [expected] }, "ordered parts receive the same overlay")
  assert.equal("agentStatus" in page.messages[0].tools[0], false, "the transcript cache projection is not mutated")
})

test("a dispatch card on another family than its parent's reads its edition off the child's own transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-card-edition-"))
  try {
    const childFile = join(dir, "agent-aCross.jsonl")
    writeFileSync(childFile, `${JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", model: "claude-sonnet-5-5", content: [] } })}\n`)
    const cross = { name: "Agent", detail: "Summarize the changelog", agentId: "toolu_cross", subagentType: "frizz:sonnet-medium", status: "completed" as const }
    // The parent's record already stated this one's edition, so nothing is read for it.
    const inherited = { name: "Agent", detail: "Run the matrix", agentId: "toolu_inherit", subagentType: "frizz:claude-opus-5-5-xhigh", status: "completed" as const }
    const page = {
      messages: [{ role: "assistant" as const, text: "", tools: [cross, inherited], parts: [{ kind: "tools" as const, tools: [cross, inherited] }] }],
      beforeCursor: null,
      hasEarlier: false,
      reachedTurnBoundary: true,
      transcriptKey: "test-key",
    }
    const projected = projectTranscriptPageAgentLifecycles(page, (id) => ({ outputFile: id === "toolu_cross" ? childFile : join(dir, "never-read.jsonl") }))
    assert.equal(projected.messages[0].tools[0].subagentType, "frizz:claude-sonnet-5-5-medium")
    assert.equal(projected.messages[0].tools[1].subagentType, "frizz:claude-opus-5-5-xhigh")
    const part = projected.messages[0].parts[0]
    assert.equal(part.kind === "tools" ? part.tools[0].subagentType : undefined, "frizz:claude-sonnet-5-5-medium", "ordered parts receive the same refinement")
    assert.equal(page.messages[0].tools[0].subagentType, "frizz:sonnet-medium", "the transcript cache projection is not mutated")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("GitHub dispatch payload preserves the exact captured backend profile (no permission passthrough)", () => {
  const batch = {
    items: [{ kind: "pr" as const, number: 91 }],
    backend: "codex" as const,
    model: "gpt-5.6-sol",
    effort: "ultra" as const,
  }
  assert.deepEqual(
    githubDispatcherRequest(batch, { prompt: "review", title: "Review owner/repo#91", slug: "review-owner-repo-91" }),
    {
      payload: {
        prompt: "review",
        title: "Review owner/repo#91",
        slug: "review-owner-repo-91",
        backend: "codex",
        model: "gpt-5.6-sol",
        effort: "ultra",
      },
      options: { backend: "codex" },
    },
  )
})

test("GitHub dispatch validation rejects invalid pairs visibly and ignores permission entirely", () => {
  const base = {
    items: [{ kind: "issue" as const, number: 1 }],
    backend: "claude" as const,
    model: "opus",
    effort: "high" as const,
  }
  assert.doesNotThrow(() => validateGithubDispatchProfile(base))
  assert.throws(
    () => validateGithubDispatchProfile({ ...base, effort: "ultra" }),
    /Unsupported claude model\/effort pair: opus \/ ultra/,
  )
  // Permission is not part of the captured tuple: dispatch stamps the fixed non-interactive mode
  // server-side, so even a stale client-sent value passes validation untouched.
  assert.doesNotThrow(() => validateGithubDispatchProfile({ ...base, permissionMode: "plan" }))
})

function row(slug: string): SessionRow {
  return {
    slug,
    session_id: `sid-${slug}`,
    thread_name: `frizz-${slug}`,
    spawned_at: "2026-07-12T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 1,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: slug,
    state: "open",
    meta: null,
    seen_at: null,
    transcript_id: null,
    permission_mode: null,
  }
}

function harness(tailer: Tailer = noopTailer, acpBridge?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-router-permission-"))
  const project: Project = { dir, id: "router-permission", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = {
    projectDir: dir,
    projectName: "test",
    projectLabel: "test",
    threads: [],
    errors: [],
    warnings: [],
  }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0, deltasSince: () => null, snapshotState: async () => ({ board: ({}) as never, seq: 0 }),
    rebuild: async () => snapshot,
    refresh: () => {
      refreshes++
      return snapshot
    },
    start: async () => {},
    stop: async () => {},
  }
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  const settings = { permissionMode: "auto" } as unknown as Settings
  let adoptCalls = 0
  // What the router asks to have ended with its context: its sweep for held messages. A real context
  // runs these in stopSubscriptions, before its storage closes. Every test here ends on
  // `h.storage.close()`, so that is where they run, and a test that leaves a message held leaves no
  // five-second clock reading a closed database behind it.
  const ending: (() => void)[] = []
  const endContext = () => { for (const end of ending.splice(0)) end() }
  const closeStorage = storage.close
  storage.close = () => { endContext(); closeStorage() }
  // createRouter is lazy: unrelated procedures do not read the omitted context fields. Keep this
  // focused on the permission route's real storage/board/backend dependencies.
  const ctx = {
    project,
    storage,
    board,
    tailer,
    ...(acpBridge ? { acpBridge } : {}),
    // followUp pushes a transcript frame the moment it opens a ledger entry (the ledger is not JSONL
    // bytes, so nothing else would). Tests only need it to exist; assertions read the ledger itself.
    transcriptChange: new Emitter<string[]>(),
    // The tailer's turn-done notification rides this, and a held ("Send to queue") message is released on it.
    bus: new Bus(),
    backendFor: () => backend,
    endWithContext: (end: () => void) => void ending.push(end),
    getSettings: () => settings,
    dispatcher: {
      dispatch: async () => ({ slug: "dispatched", sessionId: "sid-dispatched" }),
      adopt: async (slug: string) => {
        adoptCalls++
        return { slug, sessionId: `sid-${slug}` }
      },
    },
  } as unknown as AppContext
  const addExitedThread = (slug: string) =>
    snapshot.threads.push({
      id: slug,
      title: slug,
      status: "active",
      hasPlan: false,
      mechanism: null,
      humanBlocked: false,
      ready: false,
      dependsOn: [],
      externalDeps: [],
      agents: [],
      errors: [],
      warnings: [],
      runtime: "exited",
      unread: false,
      archived: false,
      subAgents: [],
      bgShells: [],
      watches: [],
      pendingQuestion: false,
      questions: [],
      kind: "session",
      foreign: false,
    } satisfies ThreadView)
  // `ctx` is exposed so a test can install an optional collaborator (e.g. codexAppServer) after
  // construction; createRouter closes over the object and reads those fields per-call, not at build time.
  return { dir, ctx, storage, board, snapshot, router: createRouter(ctx), addExitedThread, refreshes: () => refreshes, adoptCalls: () => adoptCalls, endContext }
}

// `archived` is a LEGACY column, and writing it is not archiving. `effectiveSessionState` (board.ts)
// reads it only when `state` is NULL — "an explicit state write wins" — and every row the dispatch path
// creates has `state = "open"` written explicitly. So an archiveThread that only set the column answered
// success while the card sat exactly where it was, which is what it did until 2026-08-08.
test("archiveThread archives the row a dispatch actually creates, not just the legacy bit", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("live-row"))          // state: "open", as dispatch writes it
    assert.equal(h.storage.getSession("live-row")?.state, "open")

    await h.router.archiveThread.handler({ input: { slug: "live-row" } })

    const after = h.storage.getSession("live-row")
    assert.equal(after?.state, "archived", "the state is what the board reads — setting `archived` alone is a no-op")
    assert.equal(after?.archived, 1, "and the legacy column stays in sync for pre-restart readers")
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("auto-titled sessions never read or mutate a same-slug legacy file through RPCs", async () => {
  const h = harness()
  const frizz = join(h.dir, ".frizz")
  const regular = join(frizz, "auto-file.md")
  const repair = join(frizz, "auto-repair.md")
  const external = join(h.dir, "outside.md")
  const linked = join(frizz, "auto-link.md")
  const regularBody = "---\ntitle: Planted\nstatus: active\n---\nregular sentinel\n"
  try {
    mkdirSync(frizz)
    writeFileSync(regular, regularBody)
    writeFileSync(repair, "repair sentinel\n")
    writeFileSync(external, "external sentinel\n")
    symlinkSync(external, linked)
    for (const slug of ["auto-file", "auto-repair", "auto-link"]) {
      h.storage.upsertSession({ ...row(slug), title_auto: 1 })
    }
    h.addExitedThread("auto-file")

    assert.deepEqual(await h.router.threadBody.handler({ input: { slug: "auto-file" } }), { markdown: "" })
    assert.deepEqual(await h.router.threadBody.handler({ input: { slug: "auto-link" } }), { markdown: "" })

    await h.router.archiveThread.handler({ input: { slug: "auto-file" } })
    for (const mutation of [
      () => h.router.markComplete.handler({ input: { slug: "auto-file" } }),
      () => h.router.setThreadStatus.handler({ input: { slug: "auto-file", status: "done" } }),
      () => h.router.dismissThread.handler({ input: { slug: "auto-file" } }),
      () => h.router.repairThread.handler({ input: { file: "auto-repair.md" } }),
    ]) {
      await assert.rejects(mutation, /session-first auto-titled threads do not own a legacy thread file/)
    }

    assert.equal(readFileSync(regular, "utf8"), regularBody)
    assert.equal(readFileSync(repair, "utf8"), "repair sentinel\n")
    assert.equal(readFileSync(external, "utf8"), "external sentinel\n")
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("renameThread RPC: commits a trimmed human title for Codex without touching the running agent", async () => {
  const h = harness()
  h.storage.upsertSession({ ...row("generated-slug"), title: "generated-slug", title_auto: 1, exited: 0 })
  h.storage.setBackend("generated-slug", "codex")
  const proc = h.router.renameThread
  const input = proc.input.parse({ slug: "generated-slug", title: "  Human-readable thread title  " })

  await proc.handler({ input })

  const saved = h.storage.getSession("generated-slug")!
  assert.equal(saved.title, "Human-readable thread title")
  assert.equal(saved.title_auto, 0)
  assert.equal(saved.exited, 0, "renaming metadata must not stop or reattach the live process")
  assert.equal(saved.backend, "codex")
  assert.equal(h.refreshes(), 1, "the saved title is published immediately through a board delta")
  h.storage.close()
})

test("adoptThread RPC rejects malformed or extended identities before handler dispatch", () => {
  const h = harness()
  const proc = h.router.adoptThread
  assert.equal(proc.input.safeParse({ slug: "valid-thread", message: "continue" }).success, true)
  for (const slug of ["../escape", "/absolute", ".", "%2e%2e", "Ünicode", "line\nbreak", "-option", "a".repeat(201)]) {
    assert.equal(proc.input.safeParse({ slug }).success, false, JSON.stringify(slug))
  }
  assert.equal(proc.input.safeParse({ slug: "valid-thread", unexpected: true }).success, false)
  h.storage.close()
})

test("mounted adoptThread HTTP RPC returns 400 with zero dispatcher calls for hostile input", async () => {
  const h = harness()
  const app = new Hono()
  mountRouter(app, "/_frizz/rpc", h.router)
  for (const input of [{ slug: "../escape" }, { slug: "safe", extra: true }, { slug: "a".repeat(201) }]) {
    const response = await app.request("http://localhost/_frizz/rpc/adoptThread", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    assert.equal(response.status, 400, JSON.stringify(input))
  }
  assert.equal(h.adoptCalls(), 0)
  h.storage.close()
})

test("renameThread RPC: empty titles are rejected and rowless/foreign threads remain read-only", async () => {
  const h = harness()
  const proc = h.router.renameThread
  assert.equal(proc.input.safeParse({ slug: "t", title: "   " }).success, false)
  assert.equal(proc.input.safeParse({ slug: "t", title: "x".repeat(201) }).success, false)
  await assert.rejects(proc.handler({ input: { slug: "external", title: "No row" } }), /not editable/)
  assert.equal(h.refreshes(), 0)
  h.storage.close()
})

// Provider rename now goes through the Claude broker's typed control channel (the SDK's
// `generateSessionTitle`) rather than typing `/rename` into a terminal, so the refusal a non-Claude
// or non-broker thread gets names the transport rather than the backend.
test("aiRenameThread RPC: only a running broker-backed Claude thread can be renamed by the provider", async () => {
  const h = harness()
  h.storage.upsertSession({ ...row("codex-title"), exited: 0 })
  h.storage.setBackend("codex-title", "codex")
  await assert.rejects(h.router.aiRenameThread.handler({ input: { slug: "codex-title" } }), /broker-backed Claude thread/)
  assert.equal(h.storage.getSession("codex-title")?.title, "codex-title")
  assert.equal(h.refreshes(), 0)
  h.storage.close()
})

// The provider titles a thread from its OPENING request, never from the newest reply: sourcing the
// tail's `lastAssistant` named long threads after "the very last agent action" (issue #22). The
// description must also be the operator's task alone — the dispatch envelope above the banner is
// boilerplate shared by every dispatched thread, so the titler must not see it.
test("aiRenameThread RPC: the title request carries the opening task, not the last assistant reply", async () => {
  const cwdSlug = `-tmp-frizz-rename-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const logDir = join(homedir(), ".claude", "projects", cwdSlug)
  mkdirSync(logDir, { recursive: true })
  const lastAssistant = "Ran the focused tests; all green."
  const tailWithRecentReply = {
    ...noopTailer,
    get: () => ({ lastAssistant }) as unknown as ReturnType<Tailer["get"]>,
  } as Tailer
  const h = harness(tailWithRecentReply)
  try {
    ;(h.ctx.project as { cwdSlug: string }).cwdSlug = cwdSlug
    h.storage.upsertSession({ ...row("rename-src"), exited: 0 })
    h.storage.setBackend("rename-src", "claude")
    h.storage.setClaudeRuntime("rename-src", "broker")
    const task = "Investigate the flaky resume test and fix it"
    const envelope = `orientation the operator never wrote${DISPATCH_TASK_BANNER_MARKER}${task}`
    // A LONG thread: 400 exchanges after the opening, so the latest window (300 messages) starts in the
    // middle of the conversation, on a later message from the human. The title is still named from the
    // opening. (Until 2026-11-10 it was named from the window's first user message.)
    const later = Array.from({ length: 400 }, (_, i) => [
      JSON.stringify({ type: "user", timestamp: "2026-08-24T00:02:00.000Z", message: { role: "user", content: `a side question, number ${i}` } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-08-24T00:03:00.000Z", message: { id: `side-${i}`, role: "assistant", content: [{ type: "text", text: `an answer to it, number ${i}` }] } }),
    ]).flat()
    const transcript = [
      JSON.stringify({ type: "user", timestamp: "2026-08-24T00:00:00.000Z", message: { role: "user", content: envelope } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-08-24T00:01:00.000Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: lastAssistant }] } }),
      ...later,
    ].map((l) => l + "\n").join("")
    writeFileSync(join(logDir, "sid-rename-src.jsonl"), transcript)
    const described: string[] = []
    ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = {
      renameSession: async (input: { description: string }) => {
        described.push(input.description)
        return "Fix the flaky resume test"
      },
    }
    const result = await h.router.aiRenameThread.handler({ input: { slug: "rename-src" } })
    assert.deepEqual(result, { title: "Fix the flaky resume test" })
    assert.deepEqual(described, [task])
    assert.equal(h.storage.getSession("rename-src")?.title, "Fix the flaky resume test")

    // A thread whose transcript was found under another id (transcript_id) is read from that file, as
    // every other reader reads it: the pinned session id names a file that holds something else, or nothing.
    rmSync(join(logDir, "sid-rename-src.jsonl"))
    writeFileSync(join(logDir, "found-rename-src.jsonl"), transcript)
    h.storage.setTranscriptId("rename-src", "found-rename-src")
    await h.router.aiRenameThread.handler({ input: { slug: "rename-src" } })
    assert.deepEqual(described, [task, task])
    h.storage.close()
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})

test("setThreadPermission RPC: validates input and persists an exited thread override for next resume", async () => {
  const h = harness()
  h.storage.upsertSession(row("rpc-permission"))
  h.addExitedThread("rpc-permission")
  const proc = h.router.setThreadPermission
  assert.equal(proc.input.safeParse({ slug: "rpc-permission", permissionMode: "bogus" }).success, false)
  const result = await proc.handler({ input: { slug: "rpc-permission", permissionMode: "bypassPermissions" } })
  assert.deepEqual(result, { effect: "next-resume" })
  assert.equal(h.storage.getSession("rpc-permission")?.permission_mode, "bypassPermissions")
  h.storage.close()
})

// The permission/profile controllers are CLAUDE-only since the codex TUI composer was removed (they
// parse the pane with inspectClaudeComposer). A LEGACY codex row — dispatched before the app-server
// cutover, so codex_runtime is still NULL — must therefore persist like any other codex row instead of
// being handed to them, which is what gating on `codex_runtime === "app-server"` used to do.
test("setThreadPermission/setThreadProfile RPC: every row persists intent and reports next-resume", async () => {
  const h = harness()
  const slug = "legacy-codex-row"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex") // codex_runtime deliberately left NULL
  h.addExitedThread(slug)

  assert.deepEqual(
    await h.router.setThreadPermission.handler({ input: { slug, permissionMode: "bypassPermissions" } }),
    { effect: "next-resume" },
  )
  assert.deepEqual(
    await h.router.setThreadProfile.handler({ input: { slug, model: "gpt-5.6-sol", effort: "high" } }),
    { effect: "next-resume" },
  )
  const saved = h.storage.getSession(slug)!
  assert.equal(saved.permission_mode, "bypassPermissions")
  assert.equal(saved.model, "gpt-5.6-sol")
  assert.equal(saved.effort, "high")
  assert.equal(saved.runtime_control ?? null, null, "no durable runtime control was armed")
  h.storage.close()
})

// A stolen full session moved a thread to bypass and then messaged it, and the log held only the message
// (security audit 2026-11-09). Both ways of raising what threads may do now leave a line.
test("setThreadPermission and settingsSet each write an audit record: what changed, from what, to what", async () => {
  const h = harness()
  const records: AuditRecord[] = []
  h.ctx.audit = { append: (record) => void records.push(record) }
  h.storage.upsertSession(row("audited-permission"))
  h.storage.setPermissionMode("audited-permission", "default")
  h.addExitedThread("audited-permission")

  await h.router.setThreadPermission.handler({ input: { slug: "audited-permission", permissionMode: "bypassPermissions" } })
  assert.deepEqual(records.map(({ action, outcome, thread, detail }) => ({ action, outcome, thread, detail })), [{
    action: "setThreadPermission", outcome: "ok", thread: "audited-permission",
    detail: { from: "default", to: "bypassPermissions", effect: "next-resume" },
  }])

  // A refusal is on record too, with the mode that was asked for.
  await assert.rejects(h.router.setThreadPermission.handler({ input: { slug: "external", permissionMode: "bypassPermissions" } }), /not editable/)
  assert.deepEqual([records[1]!.action, records[1]!.outcome, records[1]!.detail], ["setThreadPermission", "refused", { from: null, to: "bypassPermissions" }])

  let stored = { permissionMode: "auto", localFileOpener: "system", preamble: "the operator's own words" } as unknown as Settings
  h.ctx.getSettings = () => stored
  h.ctx.setSettings = (next) => (stored = next)
  h.ctx.resetSettings = () => (stored = { permissionMode: "auto" } as unknown as Settings)
  await h.router.settingsSet.handler({ input: { ...stored, permissionMode: "bypassPermissions", preamble: "new words" } as Settings })
  assert.deepEqual([records[2]!.action, records[2]!.outcome, records[2]!.detail], ["settingsSet", "ok", {
    changed: ["permissionMode", "preamble"],
    permissionMode: { from: "auto", to: "bypassPermissions" },
  }])
  await h.router.settingsReset.handler({ input: {} })
  assert.deepEqual(records[3]!.detail, {
    reset: true,
    changed: ["localFileOpener", "permissionMode", "preamble"],
    localFileOpener: { from: "system", to: null },
    permissionMode: { from: "bypassPermissions", to: "auto" },
  })
  assert.ok(!JSON.stringify(records).includes("words"), "settings text is never written to the audit log")
  h.storage.close()
})

test("setThreadPermission RPC: rowless/foreign-style threads are read-only", async () => {
  const h = harness()
  await assert.rejects(
    h.router.setThreadPermission.handler({ input: { slug: "external", permissionMode: "bypassPermissions" } }),
    /not editable/,
  )
  h.storage.close()
})

test("setThreadSnooze RPC validates canonical future UTC and persists any owned open queue card", async () => {
  const h = harness()
  const slug = "rpc-snooze"
  h.storage.upsertSession(row(slug))
  h.addExitedThread(slug)
  const thread = h.snapshot.threads.at(-1)!
  thread.needsYou = true // ordinary clean rest is queue-worthy but still snoozable
  thread.crashed = false
  const proc = h.router.setThreadSnooze
  for (const until of ["tomorrow", "2026-07-14T08:45:00Z", "2026-07-14 08:45:00.000Z", "2026-07-14T08:45:00.000+00:00", "2099-02-31T08:45:00.000Z"]) {
    assert.equal(proc.input.safeParse({ slug, sessionId: `sid-${slug}`, until }).success, false, until)
  }
  assert.equal(proc.input.safeParse({ slug, sessionId: `sid-${slug}`, until: "2099-07-14T08:45:00.000Z", extra: true }).success, false)
  await assert.rejects(
    proc.handler({ input: { slug, sessionId: `sid-${slug}`, until: "2000-01-01T00:00:00.000Z" } }),
    /future/,
  )

  const exact = "2099-07-14T08:45:00.000Z"
  await proc.handler({ input: { slug, sessionId: `sid-${slug}`, until: exact } })
  assert.equal(h.storage.getSession(slug)?.snoozed_until, exact)
  assert.equal(h.refreshes(), 1)

  thread.pendingQuestion = true
  const replacement = "2099-07-15T08:45:00.000Z"
  await proc.handler({ input: { slug, sessionId: `sid-${slug}`, until: replacement } })
  assert.equal(h.storage.getSession(slug)?.snoozed_until, replacement, "an unresolved question remains explicitly snoozable")

  await proc.handler({ input: { slug, sessionId: `sid-${slug}`, until: null } })
  assert.equal(h.storage.getSession(slug)?.snoozed_until, null, "wake-now remains available with the same validation contract")
  h.storage.close()
})

// The writer-yield guard exists to avoid racing an operator driving the thread from their own
// terminal. A rollout FROZEN by a dead app-server looks identical from the rollout alone, and yielding
// to it left the operator unable to answer their own stalled thread at all — the second half of the
// 2026-07-22 stall (the first was the board showing it as forever-running).
test("followUp yields to a live external writer but still answers a thread whose turn died", async () => {
  const h = harness()
  const ownedSince = "2026-07-09T10:00:00.000Z"
  const install = (liveness: { bridgeTurn: boolean; ownedSince: string } | undefined, sent: string[]) => {
    ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
      binding: () => ({ state: "active", currentTurnId: null }),
      turnLiveness: () => liveness,
      resumeOwnedSession: async () => {},
      followUp: async ({ text }: { text: string }) => void sent.push(text),
    }
  }
  // Both threads read in-flight off their rollout; only the timestamps differ.
  const external = "external-writer"
  const stalled = "stalled-writer"
  for (const slug of [external, stalled]) {
    h.storage.upsertSession(row(slug))
    h.storage.setBackend(slug, "codex")
    h.storage.setCodexRuntime(slug, "app-server")
  }
  h.ctx.tailer = {
    ...noopTailer,
    get: (slug: string) => ({
      turn: "in-flight" as const,
      permPrompt: false,
      subAgents: [],
      bgShells: [],
      watches: [],
      pendingQuestion: false,
      // The external writer is still appending; the stalled one froze before frizz took the thread.
      lastActivityAt: slug === external ? new Date().toISOString() : "2026-07-09T09:59:00.000Z",
    }),
  }

  const yielded: string[] = []
  install({ bridgeTurn: false, ownedSince: new Date().toISOString() }, yielded)
  await assert.rejects(
    h.router.followUp.handler({ input: { slug: external, sessionId: `sid-${external}`, message: "hello" } }),
    /driven outside Frizz/,
  )
  assert.deepEqual(yielded, [], "frizz must not race a second writer onto a live external turn")

  const delivered: string[] = []
  install({ bridgeTurn: false, ownedSince }, delivered)
  await h.router.followUp.handler({ input: { slug: stalled, sessionId: `sid-${stalled}`, message: "still there?" } })
  assert.deepEqual(delivered, ["still there?"], "a stalled thread stays answerable")
  h.storage.close()
})

// Reprompting IS re-engagement, so it disables the park: without this the answer to the turn you just
// sent re-parks the moment it rests and drops back out of your queue unseen. Driven through the codex
// app-server branch because it is the one followUp path that reaches a stubbable bridge instead of a
// real worker; the un-park runs above the runtime split, so the invariant is branch-independent.
test("followUp wakes a snoozed thread and disarms the bump it owed", async () => {
  const h = harness()
  const slug = "snoozed-followup"
  const until = "2099-07-14T08:45:00.000Z"
  const bump = "Check whether CI went green and land it if so."
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.storage.setCodexRuntime(slug, "app-server")
  h.storage.setSnoozedUntil(slug, until, bump)

  const sent: string[] = []
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: null }),
    turnLiveness: () => undefined,
    resumeOwnedSession: async () => {},
    followUp: async ({ text }: { text: string }) => void sent.push(text),
  }

  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "also use a squash merge" } })

  assert.deepEqual(sent, ["also use a squash merge"], "the message still reaches the worker")
  assert.equal(h.storage.getSession(slug)?.snoozed_until, null, "the park is disabled by the follow-up")
  assert.equal(h.storage.getSession(slug)?.snooze_prompt, null, "and so is the bump it owed at that deadline")
  h.storage.close()
})
// ONE THREAD MESSAGING ANOTHER (`mcp__frizz__steer`). Same codex app-server stub as above, because the
// delivery IS followUp's; what is pinned here is what steerThread adds on top of it: the sender's name
// stamped from its own row, the target's current session read server-side, no gap note on a peer's
// words, and the refusals a worker can trip over.
test("steerThread delivers a wrapped, attributed message through the follow-up path", async () => {
  const lastAssistantAt = "2026-01-01T00:00:00.000Z" // hours ago: a HUMAN's message would carry a gap note
  const h = harness({ ...noopTailer, get: () => ({ lastAssistantAt, turn: "idle" }) } as unknown as Tailer)
  h.storage.upsertSession(row("fresh-archive-audit"))
  h.storage.setTitle("fresh-archive-audit", "Audit the fresh archive")
  for (const slug of ["back-up-the-mac", "finished-thread"]) {
    h.storage.upsertSession(row(slug))
    h.storage.setBackend(slug, "codex")
    h.storage.setCodexRuntime(slug, "app-server")
  }
  h.storage.setState("finished-thread", "archived")
  const sent: Array<{ threadSlug: string; sessionId: string; text: string }> = []
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: null }),
    turnLiveness: () => undefined,
    resumeOwnedSession: async () => {},
    followUp: async (input: { threadSlug: string; sessionId: string; text: string }) => void sent.push(input),
  }

  const receipt = await h.router.steerThread.handler({ input: { from: "fresh-archive-audit", to: "back-up-the-mac", message: "Three folders are missing from the archive." } })
  assert.deepEqual(receipt, { slug: "back-up-the-mac", title: "back-up-the-mac", delivery: "resting" })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].threadSlug, "back-up-the-mac")
  assert.equal(sent[0].sessionId, "sid-back-up-the-mac", "the target's CURRENT session, read server-side")
  assert.deepEqual(parseThreadMessage(sent[0].text), {
    slug: "fresh-archive-audit",
    title: "Audit the fresh archive",
    body: "Three folders are missing from the archive.",
  })
  assert.doesNotMatch(sent[0].text, /⏱ Frizz/, "the human's gap note is not stamped on a peer's message")
  assert.match(sent[0].text, /run `frizzctl steer fresh-archive-audit`\./, "the receiver is told how to answer")
  assert.doesNotMatch(sent[0].text, /from-project=/, "a same-project message names no project")

  // A thread marked done is reopened by the message, as a human's follow-up would reopen it.
  const reopened = await h.router.steerThread.handler({ input: { from: "fresh-archive-audit", to: "finished-thread", message: "One more thing." } })
  assert.equal(reopened.delivery, "reopened")
  assert.equal(h.storage.getSession("finished-thread")?.state, "open")

  await assert.rejects(
    h.router.steerThread.handler({ input: { from: "fresh-archive-audit", to: "fresh-archive-audit", message: "note to self" } }),
    /That is your own thread/,
  )
  await assert.rejects(
    h.router.steerThread.handler({ input: { from: "fresh-archive-audit", to: "no-such-thread", message: "hello" } }),
    /no thread `no-such-thread` in this project/,
  )
  assert.equal(sent.length, 2, "a refused steer reaches no worker")
  h.storage.close()
})

// A PEER'S MESSAGE TO A SNOOZED THREAD un-parks it like a human's does, and the board must read the
// un-parked row as a thread with a message on its way, not as a rest waiting on the human. A tab's
// follow-up gets that from its write-ahead ledger entry, opened before the un-park; steerThread had
// none, so the delta the un-park published read needsYou=true for the ~40ms until the turn was
// observed, which fired a "needs you" notification for a thread a peer had just set to work and dropped
// its snooze card before the message landed (scripted broker stack, 2026-10-14). Pinned at the board
// refresh the un-park publishes: whatever the board derives there is what every tab is sent.
test("steerThread to a snoozed thread un-parks it as a delivery in flight, never as a thread awaiting the human", async () => {
  const tele = { lastAssistantAt: "2026-01-01T00:00:00.000Z", turn: "idle" }
  const h = harness({ ...noopTailer, get: () => tele } as unknown as Tailer)
  h.storage.upsertSession(row("sender-thread"))
  const slug = "parked-thread"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.storage.setCodexRuntime(slug, "app-server")
  h.storage.setSnoozedUntil(slug, "2099-07-14T08:45:00.000Z", null)
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: null }),
    turnLiveness: () => undefined,
    resumeOwnedSession: async () => {},
    followUp: async () => {},
  }
  // Every refresh: what the board would derive for the target at that instant, at rest.
  const seen: Array<{ parked: boolean; needsYou: boolean; inFlight: boolean }> = []
  const refresh = h.ctx.board.refresh
  h.ctx.board.refresh = () => {
    const now = h.storage.getSession(slug)!
    const needsYou = deriveNeedsYou(now, tele as never, "turn-idle")
    seen.push({ parked: now.snoozed_until !== null, needsYou, inFlight: deriveDeliveryInFlight(now, "turn-idle", needsYou, false, false) })
    return refresh()
  }

  await h.router.steerThread.handler({ input: { from: "sender-thread", to: slug, message: "The archive is ready for you." } })

  assert.equal(h.storage.getSession(slug)?.snoozed_until, null, "the message un-parks the thread")
  const unparked = seen.filter((s) => !s.parked)
  assert.ok(unparked.length > 0, "the un-park is published")
  assert.deepEqual(unparked[0], { parked: false, needsYou: false, inFlight: true }, "the first un-parked reading is a delivery in flight")
  // …and the ledger entry that says so draws nothing: the peer's words are not the human's, and a
  // failure stays with the sender's tool call.
  const ledger = parseDeliveryLedger(h.storage.getSession(slug)?.delivery_ledger)
  assert.equal(projectDeliveryLedger([], ledger).length, 0, "no ghost bubble for a peer's message")

  // A transport that throws fails the SENDER's call and leaves nothing behind on the target: no failed
  // bubble for this thread's human to retry, and no entry claiming a message is still on its way.
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: null }),
    turnLiveness: () => undefined,
    resumeOwnedSession: async () => {},
    followUp: async () => { throw new Error("app-server went away") },
  }
  const before = parseDeliveryLedger(h.storage.getSession(slug)?.delivery_ledger).length
  await assert.rejects(h.router.steerThread.handler({ input: { from: "sender-thread", to: slug, message: "Second note." } }), /app-server went away/)
  assert.equal(parseDeliveryLedger(h.storage.getSession(slug)?.delivery_ledger).length, before, "the failed peer send leaves no entry")
  h.storage.close()
})

// (A test for a deleted awaiting-hint kind was removed here on 2026-08-15. See the AwaitingHint doc
// block in @frizz/shared for why `human:`, `timer: <instant>` and `pr-watch:` no longer exist.)

test("setThreadPermission RPC safety: running and stale background entries are unresolved", () => {
  assert.equal(hasUnresolvedBackgroundOps({ subAgents: [{ state: "stale" }], bgShells: [{ state: "stale" }] }), true)
  assert.equal(hasUnresolvedBackgroundOps({ subAgents: [{ state: "running" }], bgShells: [] }), true)
  assert.equal(hasUnresolvedBackgroundOps({ subAgents: [], bgShells: [{ state: "running" }] }), true)
  assert.equal(hasUnresolvedBackgroundOps({ subAgents: [], bgShells: [] }), false)
})

test("follow-up safety: a durable permission handoff blocks every composer surface", () => {
  assert.equal(hasPendingPermissionChange({ permission_pending: "bypassPermissions" }), true)
  assert.equal(hasPendingPermissionChange({ permission_pending: null }), false)
  assert.equal(hasPendingPermissionChange({ permission_pending: "future-mode" }), true, "unknown durable state fails closed")
})

function finalizedClaim(slug: string): AdoptionClaimRow {
  return {
    slug,
    attempt_token: "11111111-1111-4111-8111-111111111111",
    session_id: `sid-${slug}`,
    state: "finalized",
    reserved_at_ms: 1,
    lease_expires_at_ms: 2,
    recovery_token: null,
    pane_id: "%41",
    pane_pid: 4241,
    session_created: 741,
    finalized_at_ms: 3,
  }
}

function terminatorHarness(initial: AdoptionPaneLookup) {
  let pane = initial
  const killedPanes: PaneIdentity[] = []
  const killedSessions: string[] = []
  return {
    runtime: {
      findExpectedAdoptionPane: () => pane,
      killExpectedAdoptionPane: (expected: AdoptionClaimRow) => {
        if (
          pane.kind !== "found" || pane.pane.adoptionAttemptToken !== expected.attempt_token ||
          pane.pane.paneId !== expected.pane_id || pane.pane.panePid !== expected.pane_pid ||
          pane.pane.sessionCreated !== expected.session_created
        ) return false
        killedPanes.push({
          paneId: pane.pane.paneId,
          panePid: pane.pane.panePid,
          sessionCreated: pane.pane.sessionCreated,
        })
        pane = { kind: "absent" }
        return true
      },
      killPane: (identity: PaneIdentity) => {
        killedPanes.push(identity)
        pane = { kind: "absent" }
      },
      killSession: (slug: string) => killedSessions.push(slug),
      isLive: () => pane.kind === "found" && !pane.pane.dead,
    },
    killedPanes,
    killedSessions,
  }
}

// The verdict alone left the dialog saying "this thread is still running", which answers nothing the
// human can act on — they clicked Done because they believed it was finished. The hold carries the
// server's actual evidence so the confirmation can name the executing turn and every child it is
// about to kill, by count and by label.
test("completionConfirmationHold names WHY it declined: the executing turn plus every live child", () => {
  const base = { turn: "idle" as const, permPrompt: false, pendingQuestion: false, subAgents: [], bgShells: [] }
  assert.equal(completionConfirmationHold({ ...base }), undefined, "a resting session with no children holds nothing")
  assert.equal(
    completionConfirmationHold({ ...base, turn: "in-flight", permPrompt: true }),
    undefined,
    "a verified permission pause is a human wait, not executing work",
  )

  const at = "2026-07-15T00:00:00.000Z"
  const hold = completionConfirmationHold({
    ...base,
    turn: "in-flight",
    subAgents: [
      { id: "a1", label: "Audit the resolver", startedAt: at, state: "running" as const },
      // A STALE child: its completion signal was lost AND its transcript has been silent past the
      // 15-min ceiling. That reads as finished/dead, not working — and hasLiveBackgroundWork already
      // keeps such a parent IN the queue as at-rest, so the Done dialog must not contradict it.
      { id: "a2", label: "Silent past the staleness ceiling", startedAt: at, state: "stale" as const },
    ],
    bgShells: [
      { label: "Watch CI", startedAt: at, state: "running" as const },
    ],
  })
  // Mid-turn AND owning RUNNING children is one honest reading, not two competing ones — both travel.
  // The stale sub-agent is NOT named: it is not something Done meaningfully still has to kill.
  assert.deepEqual(hold, {
    turnInFlight: true,
    unobservable: false,
    subAgents: [{ label: "Audit the resolver", state: "running" }],
    subAgentCount: 1,
    bgShells: [{ label: "Watch CI", state: "running" }],
    bgShellCount: 1,
  }, "only ACTIVELY-running ops are named; a stale child no longer holds Done, matching the queue rule")
})

test("completionConfirmationHold caps worker-authored labels but reports the untruncated count", () => {
  const at = "2026-07-15T00:00:00.000Z"
  const hold = completionConfirmationHold({
    turn: "idle",
    permPrompt: false,
    pendingQuestion: false,
    subAgents: Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, label: `child ${i}`, startedAt: at, state: "running" as const })),
    bgShells: [{ label: "x".repeat(500), startedAt: at, state: "running" as const }],
  })
  assert.equal(hold?.turnInFlight, false, "an idle parent with live children is held by the children alone")
  assert.equal(hold?.subAgents.length, 8, "the named list is capped")
  assert.equal(hold?.subAgentCount, 11, "the count is NOT capped — the dialog says '+3 more', never a silent truncation")
  assert.equal(hold?.bgShells[0].label.length, 100, "a runaway label cannot blow out the dialog")
})

test("completion only trusts known resting telemetry; a live unobservable runtime remains protected", () => {
  assert.equal(completionNeedsConfirmation(undefined), true)
  assert.equal(completionNeedsConfirmation({
    turn: "in-flight",
    permPrompt: true,
    pendingQuestion: false,
    subAgents: [],
    bgShells: [],
  }), false, "a verified native permission pause is not executing work")
})

test("completeRegisteredThread archives an inactive session without a confirmation or termination", async () => {
  const h = harness()
  const slug = "inactive-complete"
  const saved = row(slug)
  let kills = 0
  try {
    h.storage.upsertSession(saved)
    assert.deepEqual(await completeRegisteredThread(h.storage, saved, false, {
      findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
      killExpectedAdoptionPane: () => false,
      killSession: () => { kills++ },
      isLive: () => false,
    }), { needsConfirmation: false })
    assert.equal(kills, 0)
    assert.equal(h.storage.getSession(slug)?.state, "archived")
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

// A worker that is DEAD but whose recorded turn never ended was cut off — a reboot, a signal, a crash
// mid-tool-call. Its thread reads like the executing one, yet `live` is false, so the live hold was never
// consulted and one click filed it under Done with its last tool call still open (2026-09-03: a reboot
// cut eight nub workers off mid-turn and one of them was archived as ✓ Done — "a lot of cancelled sessions
// got incorrectly marked as Done"). It is asked about now, and only the confirmation archives it.
test("completeRegisteredThread asks before filing a cut-off worker as Done; the confirmation archives it", async () => {
  const h = harness()
  const slug = "cut-off-complete"
  const saved = row(slug)
  const dead = {
    findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
    killExpectedAdoptionPane: () => false,
    killSession: () => { throw new Error("a dead runtime must never be terminated") },
    isLive: () => false,
  }
  const tele = { permPrompt: false, pendingQuestion: false, subAgents: [], bgShells: [] }
  try {
    h.storage.upsertSession(saved)
    // The transcript's own reading: a tool call with no result stays in-flight, so the worker did not finish.
    const asked = await completeRegisteredThread(h.storage, saved, false, dead, { ...tele, turn: "in-flight" })
    assert.equal(asked.needsConfirmation, true, "a cut-off worker is asked about, exactly like an executing one")
    assert.equal(asked.hold?.cutOff, true, "…and the dialog is told WHY: the worker is gone, not busy")
    assert.equal(asked.hold?.turnInFlight, true)
    assert.deepEqual([asked.hold?.subAgentCount, asked.hold?.bgShellCount], [0, 0], "a dead daemon's children are never claimed to be running")
    assert.equal(h.storage.getSession(slug)?.state, "open", "nothing was archived on the refusal")

    // The human's confirmation is the same word it is for the live case, and there is nothing to kill.
    assert.deepEqual(await completeRegisteredThread(h.storage, saved, true, dead, { ...tele, turn: "in-flight" }), { needsConfirmation: false })
    assert.equal(h.storage.getSession(slug)?.state, "archived")

    // A dead worker at REST is finished business and archives in one click, as it always has.
    const rested = row("rested-dead")
    h.storage.upsertSession(rested)
    assert.deepEqual(await completeRegisteredThread(h.storage, rested, false, dead, { ...tele, turn: "idle" }), { needsConfirmation: false })
    assert.equal(h.storage.getSession("rested-dead")?.state, "archived")
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("adoption teardown: forget/dismiss/stop kill only the finalized token + exact tuple", () => {
  const slug = "adopted-owner"
  const claim = finalizedClaim(slug)
  const pane: PaneSnapshot = {
    paneId: claim.pane_id!,
    panePid: claim.pane_pid!,
    sessionCreated: claim.session_created!,
    adoptionAttemptToken: claim.attempt_token,
    dead: true,
  }
  const h = terminatorHarness({ kind: "found", pane })

  assert.equal(stopRegisteredRuntime({ getAdoptionClaim: () => claim }, row(slug), h.runtime), "stopped")
  assert.deepEqual(h.killedPanes, [{ paneId: "%41", panePid: 4241, sessionCreated: 741 }])
  assert.deepEqual(h.killedSessions, [], "a finalized adoption never falls back to reusable slug teardown")
})

test("adoption teardown cannot kill a pane retokened between proof and the atomic action", () => {
  const slug = "adopted-retoken-race"
  const claim = finalizedClaim(slug)
  const competitorToken = "55555555-5555-4555-8555-555555555555"
  let pane: PaneSnapshot = {
    paneId: claim.pane_id!, panePid: claim.pane_pid!, sessionCreated: claim.session_created!,
    adoptionAttemptToken: claim.attempt_token, dead: false,
  }
  let kills = 0
  const runtime = {
    findExpectedAdoptionPane: (expected: AdoptionClaimRow): AdoptionPaneLookup =>
      pane.adoptionAttemptToken === expected.attempt_token
        ? { kind: "found", pane }
        : { kind: "unknown" },
    killExpectedAdoptionPane: (expected: AdoptionClaimRow) => {
      // Deterministically inject the ABA at the exact proof→action boundary. The atomic helper sees
      // the new token and must decline even though pane id/pid/session-created are unchanged.
      pane = { ...pane, adoptionAttemptToken: competitorToken }
      if (pane.adoptionAttemptToken !== expected.attempt_token) return false
      kills++
      return true
    },
    killSession: () => { throw new Error("must not name-kill") },
    isLive: () => true,
  }
  assert.throws(
    () => stopRegisteredRuntime({ getAdoptionClaim: () => claim }, row(slug), runtime),
    /changed before it could be stopped/,
  )
  assert.equal(kills, 0)
  assert.equal(pane.adoptionAttemptToken, competitorToken)
})

test("legacy teardown retains name behavior while an absent finalized owner is a safe no-op", () => {
  const slug = "legacy-owner"
  const legacy = terminatorHarness({ kind: "absent" })
  assert.equal(stopRegisteredRuntime({ getAdoptionClaim: () => undefined }, row(slug), legacy.runtime), "stopped")
  assert.deepEqual(legacy.killedSessions, [slug])

  const adopted = terminatorHarness({ kind: "absent" })
  assert.equal(
    stopRegisteredRuntime({ getAdoptionClaim: () => finalizedClaim(slug) }, row(slug), adopted.runtime),
    "absent",
  )
  assert.deepEqual(adopted.killedSessions, [])
  assert.deepEqual(adopted.killedPanes, [])
})

test("router teardown never downgrades a stale replaced row to reusable-name control", () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "frizz-router-aba-")), "ui.db"), "p")
  const slug = "router-stale-row"
  const stale = row(slug)
  storage.upsertSession(stale)
  storage.upsertSession({ ...stale, session_id: "replacement", runtime_generation: 0 })
  const h = terminatorHarness({ kind: "absent" })
  assert.throws(() => stopRegisteredRuntime(storage, stale, h.runtime), /competing adoption attempt/)
  assert.deepEqual(h.killedSessions, [])
  assert.deepEqual(h.killedPanes, [])
})

test("rowless reserved/spawned adoption claims fail closed without a name or exact kill", async () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "frizz-rowless-adopt-")), "ui.db"), "p")
  const slug = "rowless-adoption"
  assert.equal(storage.reserveAdoptionClaim({
    slug,
    attemptToken: "33333333-3333-4333-8333-333333333333",
    sessionId: "reserved-owner",
    reservedAtMs: 1,
    leaseExpiresAtMs: 100,
  }), true)
  const h = terminatorHarness({ kind: "absent" })
  await assert.rejects(() => stopRuntimeBySlug(storage, slug, h.runtime), /adoption attempt is in progress/i)
  assert.deepEqual(h.killedSessions, [])
  assert.deepEqual(h.killedPanes, [])
})

test("rowless name teardown is fenced against a claim appearing after the optimistic read", async () => {
  const h = terminatorHarness({ kind: "absent" })
  const storage = {
    getSession: () => undefined,
    getAdoptionClaim: () => undefined,
    withUnclaimedRuntimeFence: () => ({ acquired: false as const }),
  }
  await assert.rejects(() => stopRuntimeBySlug(storage, "rowless-race", h.runtime), /nothing was stopped/)
  assert.deepEqual(h.killedSessions, [])
  assert.deepEqual(h.killedPanes, [])
})

test("rowless adoption claim blocks kill, dismiss-status, and forget RPC handlers before the terminator", async () => {
  const h = harness()
  const slug = "rowless-rpc-adoption"
  assert.equal(h.storage.reserveAdoptionClaim({
    slug,
    attemptToken: "66666666-6666-4666-8666-666666666666",
    sessionId: "rowless-rpc-owner",
    reservedAtMs: 1,
    leaseExpiresAtMs: 100,
  }), true)
  await assert.rejects(h.router.killAgent.handler({ input: { slug } }), /adoption attempt is in progress/i)
  await assert.rejects(
    h.router.setThreadStatus.handler({ input: { slug, status: "dismissed" } }),
    /adoption attempt is in progress/i,
  )
  await assert.rejects(h.router.forgetThread.handler({ input: { slug } }), /adoption attempt is in progress/i)
  assert.equal(h.storage.getAdoptionClaim(slug)?.state, "reserved")
})

test("stale forget loses to a finalized successor token and preserves its row and pane binding", async () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "frizz-forget-rotation-")), "ui.db"), "p")
  const slug = "forget-successor"
  const original = finalizedClaim(slug)
  const saved = row(slug)
  assert.equal(storage.reserveAdoptionClaim({
    slug,
    attemptToken: original.attempt_token,
    sessionId: saved.session_id,
    reservedAtMs: 1,
    leaseExpiresAtMs: 2,
  }), true)
  assert.equal(storage.recordAdoptionPane(slug, original.attempt_token, {
    paneId: original.pane_id!, panePid: original.pane_pid!, sessionCreated: original.session_created!,
  }, 2), true)
  assert.equal(storage.finalizeAdoptionClaim(slug, original.attempt_token, saved, 2), true)

  const successorToken = "44444444-4444-4444-8444-444444444444"
  let rotated = false
  const originalPane: PaneSnapshot = {
    paneId: original.pane_id!, panePid: original.pane_pid!, sessionCreated: original.session_created!,
    adoptionAttemptToken: original.attempt_token, dead: true,
  }
  const runtime = {
    findExpectedAdoptionPane: (expected: AdoptionClaimRow): AdoptionPaneLookup => {
      if (!rotated && expected.attempt_token === original.attempt_token) return { kind: "found", pane: originalPane }
      if (rotated && expected.attempt_token === successorToken) return { kind: "found", pane: {
        paneId: "%99", panePid: 9900, sessionCreated: 99000,
        adoptionAttemptToken: successorToken, dead: false,
      } }
      return { kind: "absent" }
    },
    killExpectedAdoptionPane: () => {
    assert.equal(storage.rearmFinalizedAdoptionClaim({
      slug,
      attemptToken: successorToken,
      sessionId: saved.session_id,
      reservedAtMs: 3,
      leaseExpiresAtMs: 4,
    }, original.attempt_token), true)
    assert.equal(storage.recordAdoptionPane(slug, successorToken, {
      paneId: "%99", panePid: 9900, sessionCreated: 99000,
    }, 4), true)
    assert.equal(storage.finalizeAdoptionRespawnClaim(slug, successorToken, saved.session_id, 4), true)
    rotated = true
    return true
    },
    killPane: () => {},
    killSession: () => {},
    isLive: () => false,
  }

  await assert.rejects(
    () => stopAndForgetRegisteredRuntime(storage, saved, runtime),
    /new worker was preserved/,
  )
  assert.equal(storage.getSession(slug)?.session_id, saved.session_id)
  assert.equal(storage.getAdoptionClaim(slug)?.attempt_token, successorToken)
})

// ── Stopping an app-server Codex thread (2026-07-23) ───────────────────────────────────────────────
// An app-server Codex thread has NO worker process of its own: its worker is a turn inside the shared
// codex app-server, which now lives in a DETACHED daemon that outlives the frizz runtime. Routed through
// the registered-runtime terminator every stop verb took stopRegisteredRuntime's `unbound` branch, issued kill-session
// for a session that never existed, and reported "stopped" — while the turn kept running, burning
// tokens and touching the repo with no frizz-side owner. Before the daemon worked this was masked,
// because the app-server died with the runtime.
function codexSessionRow(
  storage: ReturnType<typeof createStorage>,
  slug: string,
  runtime: "app-server" | "pre-app-server",
): SessionRow {
  storage.upsertSession({ ...row(slug), exited: 0 })
  storage.setBackend(slug, "codex")
  if (runtime === "app-server") storage.setCodexRuntime(slug, "app-server")
  return storage.getSession(slug)!
}

function bridgeStub(options: { turnLive: boolean; interrupt?: () => Promise<{ interrupted: boolean }> }) {
  const interrupts: string[] = []
  return {
    interrupts,
    bridge: {
      turnLiveness: () => ({ bridgeTurn: options.turnLive, ownedSince: "2026-07-23T00:00:00.000Z" }),
      interruptTurn: async (slug: string, sessionId: string) => {
        interrupts.push(`${slug}/${sessionId}`)
        return options.interrupt ? options.interrupt() : { interrupted: true }
      },
    },
  }
}

test("killAgent interrupts a live app-server Codex turn instead of killing a worker process it never had", async () => {
  const h = harness()
  const slug = "codex-kill"
  codexSessionRow(h.storage, slug, "app-server")
  const stub = bridgeStub({ turnLive: true })
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = stub.bridge

  await h.router.killAgent.handler({ input: { slug } })

  assert.deepEqual(stub.interrupts, [`${slug}/sid-${slug}`], "the turn is stopped where it actually lives")
  assert.equal(h.storage.getSession(slug)?.exited, 1, "and only then is the row recorded as stopped")
  h.storage.close()
})

test("a Codex interrupt that could not be delivered never records the worker as stopped", async () => {
  const h = harness()
  const slug = "codex-kill-fails"
  codexSessionRow(h.storage, slug, "app-server")
  const stub = bridgeStub({
    turnLive: true,
    interrupt: async () => { throw new Error("Codex app-server session detached; cannot interrupt") },
  })
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = stub.bridge

  await assert.rejects(h.router.killAgent.handler({ input: { slug } }), /cannot interrupt/)
  assert.equal(h.storage.getSession(slug)?.exited, 0, "the row must not claim a stop that did not happen")
  assert.equal(h.storage.getSession(slug)?.state, "open")
  h.storage.close()
})

test("stopping a Codex thread with no active turn is a no-op, not an error", async () => {
  const h = harness()
  const slug = "codex-kill-idle"
  codexSessionRow(h.storage, slug, "app-server")
  const stub = bridgeStub({
    turnLive: false,
    // Reaching the bridge at all here would spawn/attach an app-server just to be told there is
    // nothing to stop; turnLiveness is a pure read and already answers that.
    interrupt: async () => { throw new Error("interruptTurn must not be reached for a resting thread") },
  })
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = stub.bridge

  await h.router.killAgent.handler({ input: { slug } })
  assert.deepEqual(stub.interrupts, [])
  assert.equal(h.storage.getSession(slug)?.exited, 1, "a resting thread still settles as stopped")
  h.storage.close()
})

test("a LEGACY pre-app-server Codex row keeps the registered-runtime terminator and never reaches the bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-legacy-codex-stop-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "legacy-codex"
  // Dispatched pre-cutover: backend=codex but codex_runtime is NULL, so it really does own a pane and
  // is migrated only when a follow-up first touches it. followUp/setThreadPermission branch on the
  // BACKEND because the controller they avoid is Claude-only; termination is the opposite case.
  const saved = codexSessionRow(storage, slug, "pre-app-server")
  assert.equal(isAppServerCodexRow(saved), false)
  const killed: string[] = []
  const outcome = await stopThreadRuntime(
    storage,
    saved,
    {
      findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
      killExpectedAdoptionPane: () => false,
      killSession: (target: string) => killed.push(target),
      isLive: () => false,
    },
    {
      turnLiveness: () => { throw new Error("a legacy pre-app-server row must not consult the bridge") },
      interruptTurn: async () => { throw new Error("a legacy pre-app-server row must not be interrupted") },
    },
  )
  assert.equal(outcome, "stopped")
  assert.deepEqual(killed, [slug])
  storage.close()
  rmSync(dir, { recursive: true, force: true })
})

test("Mark as done asks before ending a running Codex turn, then actually interrupts it", async () => {
  const h = harness()
  const slug = "codex-done"
  codexSessionRow(h.storage, slug, "app-server")
  const stub = bridgeStub({ turnLive: true })
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = stub.bridge

  // Before this change the registered-runtime terminator answered "not live" for every app-server codex row, so the
  // hold was never computed: a running codex thread archived silently, unasked and uninterrupted.
  const asked = await h.router.completeThread.handler({ input: { slug, sessionId: `sid-${slug}`, terminateLive: false } })
  assert.equal(asked.needsConfirmation, true)
  assert.deepEqual(stub.interrupts, [])
  assert.equal(h.storage.getSession(slug)?.state, "open")

  const done = await h.router.completeThread.handler({ input: { slug, sessionId: `sid-${slug}`, terminateLive: true } })
  assert.equal(done.needsConfirmation, false)
  assert.deepEqual(stub.interrupts, [`${slug}/sid-${slug}`])
  assert.equal(h.storage.getSession(slug)?.state, "archived")
  assert.equal(h.storage.getSession(slug)?.exited, 1)
  h.storage.close()
})

test("Mark as done on a Codex thread whose interrupt fails leaves it open, not archived", async () => {
  const h = harness()
  const slug = "codex-done-fails"
  codexSessionRow(h.storage, slug, "app-server")
  const stub = bridgeStub({
    turnLive: true,
    interrupt: async () => { throw new Error("Codex accepted the interrupt but the turn has not ended; nothing was stopped") },
  })
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = stub.bridge

  await assert.rejects(
    h.router.completeThread.handler({ input: { slug, sessionId: `sid-${slug}`, terminateLive: true } }),
    /nothing was stopped/,
  )
  assert.equal(h.storage.getSession(slug)?.state, "open", "an archived row whose turn still runs has no card left to act on")
  h.storage.close()
})

test("dismissing a Codex thread stops its turn through the bridge", async () => {
  const h = harness()
  const slug = "codex-dismiss"
  codexSessionRow(h.storage, slug, "app-server")
  mkdirSync(join(h.dir, ".frizz"), { recursive: true })
  writeFileSync(join(h.dir, ".frizz", `${slug}.md`), `---\nstatus: active\n---\n\n# ${slug}\n`)
  const stub = bridgeStub({ turnLive: true })
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = stub.bridge

  await h.router.setThreadStatus.handler({ input: { slug, status: "dismissed" } })
  assert.deepEqual(stub.interrupts, [`${slug}/sid-${slug}`])
  assert.equal(h.storage.getSession(slug)?.exited, 1)
  h.storage.close()
})

// ── Restart worker (the operator-driven freshProcess) ────────────────────────────────────────────
// A worker reads its plugin (hooks) and system prompt ONCE, at process start, so the only way to move a
// running one onto a newer frizz build is to replace the process. `freshProcess` is how the operator
// asks; these pin the two refusals, because a restart that quietly degrades to an ordinary follow-up is
// worse than an error — the operator would believe their worker came back on the new build when it is
// still the old process.
function restartHarness(subAgents: { state: string }[] = []) {
  const tailer = { ...noopTailer, get: () => ({ turn: "idle", subAgents }) as never }
  const h = harness(tailer)
  const slug = "restart-me"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "claude")
  h.storage.setClaudeRuntime(slug, "broker")
  const calls: { text: string; freshProcess?: boolean; permissionMode?: string }[] = []
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = {
    followUp: async (input: { text: string; freshProcess?: boolean; permissionMode?: string }) => void calls.push(input),
  }
  return { h, slug, calls }
}

// A row promoted from the External band by a build that stamped NO permission mode used to hand the
// bridge `undefined`, which a cold attach turns into Claude's `default` — the prompt-on-everything mode
// the worker's perm-policy hook defers call by call, so every Edit parked on a card (observed
// 2026-09-03). The follow-up substitutes the dispatch floor for such a row. It shapes the FORK only: a
// daemon that outlived the upgrade is rebound as it is (the bridge ignores launch options for a held
// daemon), and only a process replacement moves it. The stub here stands in for a bridge with no held
// daemon, which is the case the substitute can reach.
test("a follow-up on a row with no recorded permission mode cold-resumes at the dispatch floor", async () => {
  const { h, slug, calls } = restartHarness()
  assert.equal(h.storage.getSession(slug)?.permission_mode, null, "the legacy row carries no mode")
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "carry on" } })
  // This harness's Settings ask for `auto`, so `auto` is the dispatch floor here — and NOT undefined.
  assert.equal(calls[0]?.permissionMode, "auto", "the dispatch floor, not undefined → default")
  h.storage.close()
})

// …and a mode the operator persisted on the thread always wins over that floor.
test("a follow-up on a row with a persisted permission mode carries that mode", async () => {
  const { h, slug, calls } = restartHarness()
  h.storage.setPermissionMode(slug, "bypassPermissions")
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "carry on" } })
  assert.equal(calls[0]?.permissionMode, "bypassPermissions")
  h.storage.close()
})

test("Restart worker retires the live process, carrying the continuation into the fresh one", async () => {
  const { h, slug, calls } = restartHarness()
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "come back on current tooling", freshProcess: true },
  })
  assert.equal(calls.length, 1, "the message still reaches the worker")
  assert.equal(calls[0].freshProcess, true, "and it lands in a process that has just started")
  h.storage.close()
})

// `exited` records a deliberate stop, and a follow-up ends it: the bridge reconnects or cold-resumes
// the worker, so a row that still read `exited = 1` afterwards was lying about a thread that then ran
// for hours (four of them on 2026-09-03, resumed by a typed "continue"). The board never showed it —
// a broker row's liveness is derived live — but the column is what every direct reader believes.
test("followUp clears a stale `exited` stamp once the bridge has accepted the send", async () => {
  const { h, slug, calls } = restartHarness()
  h.storage.setExited(slug, true)
  assert.equal(h.storage.getSession(slug)?.exited, 1, "precondition: the row records a deliberate stop")
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "continue" } })
  assert.equal(calls.length, 1, "the message reached the worker")
  assert.equal(h.storage.getSession(slug)?.exited, 0, "and the stop it records is over")
  h.storage.close()
})

// THE WRITE-AHEAD (delivery-ledger.ts). A ~4,000-character dictated steer was lost on 2026-09-30: the
// cold resume threw, the ledger entry was written only AFTER a successful bridge call, and the browser's
// draft — the only copy left — died with a Chrome restart. The server now holds the text before it
// touches the transport, and a throw leaves it as a failed entry the operator can retry, edit or dismiss.
test("a follow-up whose delivery throws keeps its full text on the server as a failed send", async () => {
  const { h, slug } = restartHarness()
  const dictated = "Please restructure the release notes so that each package gets its own section. ".repeat(50)
  let ledgerAtCall: string | null | undefined
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = {
    followUp: async () => {
      ledgerAtCall = h.storage.getSession(slug)?.delivery_ledger
      throw new Error("cold resume failed: the broker daemon exited during startup")
    },
  }
  const error = await h.router.followUp
    .handler({ input: { slug, sessionId: `sid-${slug}`, message: dictated, deliveryId: "d-dictated" } })
    .then(() => null, (e: unknown) => e)
  assert.ok(error instanceof Error, "the operator still hears that the send failed")
  assert.equal((error as { deliveryKept?: unknown }).deliveryKept, true, "…and that the server kept the words")
  assert.deepEqual(parseDeliveryLedger(ledgerAtCall).map((i) => [i.id, i.state]), [["d-dictated", "sending"]], "written BEFORE the transport was touched")
  const [kept] = parseDeliveryLedger(h.storage.getSession(slug)?.delivery_ledger)
  assert.equal(kept.state, "failed")
  assert.equal(kept.text, dictated)
  assert.equal(kept.error, "cold resume failed: the broker daemon exited during startup")
  // Never retried on its own: a replay of the same id is answered without touching the transport.
  let calls = 0
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = { followUp: async () => void calls++ }
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: dictated, deliveryId: "d-dictated" } })
  assert.equal(calls, 0, "an ambiguous failure is never re-sent under its own id")
  // The operator's Retry — a new id that supersedes it — delivers and replaces the failed entry.
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: dictated, deliveryId: "d-retry", supersedes: "d-dictated" } })
  assert.equal(calls, 1)
  assert.deepEqual(parseDeliveryLedger(h.storage.getSession(slug)?.delivery_ledger).map((i) => [i.id, i.state]), [["d-retry", "delivered"]])
  h.storage.close()
})

// TWO SENDS A FEW MS APART ON A RESTED THREAD. The tailer still reads `idle` when the second arrives — the
// first one's record is not on disk yet — so both used to open `delivered`, and the chat drew the second
// as read, above the Working row, for the whole turn the worker actually kept it queued behind. The bridge
// knows it took an input the transcript has not shown, and that is what makes the second one wait.
test("a send that arrives behind another the transcript has not shown yet opens enqueued, not delivered", async () => {
  let folded: string | undefined
  const tailer = { ...noopTailer, get: () => ({ turn: "idle", subAgents: [], lastActivityAt: folded }) as never }
  const h = harness(tailer)
  const slug = "two-at-once"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "claude")
  h.storage.setClaudeRuntime(slug, "broker")
  let handedAt: number | undefined
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = {
    followUp: async () => { handedAt = Date.now() },
    lastInputAt: () => handedAt,
  }
  const states = () => parseDeliveryLedger(h.storage.getSession(slug)?.delivery_ledger).map((i) => [i.id, i.state])
  folded = new Date(Date.now() - 60_000).toISOString() // the rest's own last record, a minute old
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "go on", deliveryId: "d-first" } })
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "and also this", deliveryId: "d-second" } })
  assert.deepEqual(states(), [["d-first", "delivered"], ["d-second", "enqueued"]], "the first opens the turn; the second is behind it")
  // Once the tailer has folded past that input its own reading stands again: at rest, a send opens the turn.
  folded = new Date(Date.now() + 1_000).toISOString()
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "next", deliveryId: "d-third" } })
  assert.deepEqual(states().at(-1), ["d-third", "delivered"])
  h.storage.close()
})

test("a refusal BEFORE the write-ahead records nothing — the send never started", async () => {
  const { h, slug } = restartHarness()
  await assert.rejects(
    h.router.followUp.handler({ input: { slug, sessionId: "sid-someone-else", message: "stale tab", deliveryId: "d-stale" } }),
    (error: unknown) => (error as { deliveryKept?: unknown }).deliveryKept !== true,
  )
  assert.equal(h.storage.getSession(slug)?.delivery_ledger ?? null, null)
  h.storage.close()
})

test("dismissFailedFollowUp removes a failed send and nothing else", async () => {
  const { h, slug } = restartHarness()
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = { followUp: async () => { throw new Error("boom") } }
  await assert.rejects(h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "x", deliveryId: "d-1" } }))
  assert.deepEqual(await h.router.dismissFailedFollowUp.handler({ input: { slug, deliveryId: "d-1" } }), { dismissed: true })
  assert.deepEqual(await h.router.dismissFailedFollowUp.handler({ input: { slug, deliveryId: "d-1" } }), { dismissed: false })
  assert.equal(h.storage.getSession(slug)?.delivery_ledger ?? null, null)
  h.storage.close()
})

// Codex shared the gap: its ledger entry, too, was written only after `bridge.followUp` returned. The
// write-ahead wraps every runtime branch, so a codex send that throws is kept exactly like a Claude one.
test("a codex follow-up whose delivery throws is kept as a failed send too", async () => {
  const h = harness()
  const slug = "codex-kept"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.storage.setCodexRuntime(slug, "app-server")
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: null }),
    turnLiveness: () => undefined,
    resumeOwnedSession: async () => {},
    followUp: async () => { throw new Error("turn/start timed out") },
  }
  const error = await h.router.followUp
    .handler({ input: { slug, sessionId: `sid-${slug}`, message: "rebase and push", deliveryId: "d-codex" } })
    .then(() => null, (e: unknown) => e)
  assert.equal((error as { deliveryKept?: unknown }).deliveryKept, true)
  const [kept] = parseDeliveryLedger(h.storage.getSession(slug)?.delivery_ledger)
  assert.deepEqual([kept.state, kept.text, kept.error], ["failed", "rebase and push", "turn/start timed out"])
  h.storage.close()
})

test("followUp leaves `exited` alone when the bridge refuses the send", async () => {
  const { h, slug } = restartHarness()
  h.storage.setExited(slug, true)
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = {
    followUp: async () => { throw new Error("the session broker is unavailable") },
  }
  await assert.rejects(h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "continue" } }))
  assert.equal(h.storage.getSession(slug)?.exited, 1, "nothing resumed, so the stop still stands")
  h.storage.close()
})

// A restart RETIRES the sends the dead process was still holding. Reported 2026-08-01 by the
// maintainer, who restarted a worker whose follow-ups had stopped arriving and found them still on
// screen afterwards: "the old messages are still showing up as ghost bubbles". They are unreachable
// by hand too — the unqueue click asks the NEW daemon about a uuid it never heard of and answers
// "Too late — that message has already left the queue", the exact opposite of what happened — so
// without this they sit there for the rest of the hour. `cancelled` tombstones are left ALONE: they
// suppress a real JSONL bubble and retiring one would un-hide a message the operator retracted.
test("Restart worker clears the sends the retired process was still holding", async () => {
  const { h, slug, calls } = restartHarness()
  appendDelivery(h.storage, slug, { id: "d-stuck-1", text: "never arrived", state: "enqueued" })
  appendDelivery(h.storage, slug, { id: "d-stuck-2", text: "also never arrived", state: "pending" })
  appendDelivery(h.storage, slug, { id: "d-taken-back", text: "retracted on purpose", state: "cancelled" })

  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "restarted, carry on", deliveryId: "d-restart", freshProcess: true },
  })

  const after = parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)
  assert.deepEqual(
    after.map((i) => i.id).sort(),
    ["d-restart", "d-taken-back"],
    "both stranded sends are gone; the restart's own entry and the tombstone remain",
  )
  assert.equal(calls.length, 1, "and the restart itself still went through")
  h.storage.close()
})

// An ORDINARY follow-up must not clear them: the process holding those sends is still alive, so they
// may yet be read. Only the restart is evidence of death.
test("an ordinary follow-up leaves earlier outstanding sends queued", async () => {
  const { h, slug } = restartHarness()
  appendDelivery(h.storage, slug, { id: "d-waiting", text: "still in flight", state: "enqueued" })

  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "one more thing", deliveryId: "d-next" },
  })

  const after = parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)
  assert.ok(after.some((i) => i.id === "d-waiting" && i.state === "enqueued"), "the in-flight send is untouched")
  h.storage.close()
})

// Running sub-agents do NOT refuse the operator's restart. This asserted the OPPOSITE until
// 2026-08-01: the completion invariant (an agent runs to its terminal return) was read as covering an
// explicit human instruction, so the verb threw whenever a child was live — which fenced off the one
// recovery affordance in exactly the state that motivates reaching for it, a worker stuck behind
// background work that will not finish. The invariant governs frizz's own initiative
// (needsFreshProcessForLimit still spares a live child when FRIZZ chooses the restart); an operator
// asking outright is not that.
test("Restart worker proceeds even while sub-agents are still running", async () => {
  const { h, slug, calls } = restartHarness([{ state: "running" }])
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "restart please", freshProcess: true },
  })
  assert.equal(calls.length, 1, "the restart is delivered, not refused")
  assert.equal(calls[0].freshProcess, true, "and it retires the live process as asked")
  h.storage.close()
})

// An ordinary follow-up on that same thread does NOT restart anything: only the explicit verb does.
test("a plain follow-up still reaches a worker whose sub-agents are running", async () => {
  const { h, slug, calls } = restartHarness([{ state: "running" }])
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "extra context" } })
  assert.equal(calls.length, 1)
  assert.notEqual(calls[0].freshProcess, true, "and it does NOT restart the process behind their backs")
  h.storage.close()
})

// ── Interrupt and send ──────────────────────────────────────────────────────────────────────────
// The operator's "this can't wait" verb. Claude Code already dequeues at the first sampling boundary
// that exists, so the wait is the remaining time of whatever was in flight — measured over 14 days of
// this repo's transcripts, mid-turn operator prose waited p50 13.8s / p90 49s / p99 2.5m. Preempting
// is the only lever, and ORDER is the entire mechanism: the SDK's interrupt aborts the turn WITHOUT
// discarding queued inputs, so the message must already be queued when the interrupt lands. Reversed,
// the interrupt would abort into an empty queue and the message would merely open an ordinary turn —
// i.e. exactly the latency this verb exists to remove, with the in-flight work destroyed for nothing.
function interruptHarness() {
  const tailer = { ...noopTailer, get: () => ({ turn: "in-flight", subAgents: [] }) as never }
  const h = harness(tailer)
  const slug = "interrupt-me"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "claude")
  h.storage.setClaudeRuntime(slug, "broker")
  const order: string[] = []
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = {
    followUp: async () => void order.push("followUp"),
    interruptTurn: () => { order.push("interruptTurn"); return true },
  }
  return { h, slug, order }
}

test("interrupt and send preempts the turn, and only AFTER the message is queued", async () => {
  const { h, slug, order } = interruptHarness()
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "stop, read this", deliveryId: "d-int", interrupt: true },
  })
  assert.deepEqual(order, ["followUp", "interruptTurn"], "queued first, preempted second")
  const after = parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)
  // Mid-turn, and still `delivered` — the landed interrupt IS the receipt. This used to open
  // `enqueued` "like any other send", which rendered the one message the operator paid a turn abort
  // to be read NOW as a gray bubble pinned under the working indicator answering it, for the whole
  // window before the delivery record reached disk (maintainer 2026-08-24: "I hate that there is
  // always a delay after I force push a message").
  assert.ok(after.some((i) => i.id === "d-int" && i.state === "delivered"), "and the preempted send is not still waiting")
  h.storage.close()
})

// The interrupt preempts the TURN, not one message, and the queue behind it is FIFO — so the sends
// already waiting are read by that same next turn. Leaving them gray while the message that triggered
// the interrupt goes solid would say the opposite of what happens.
test("interrupt and send frees the sends already queued ahead of it too", async () => {
  const { h, slug } = interruptHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "first", deliveryId: "d-first" } })
  assert.equal(parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)[0].state, "enqueued", "waiting, as it should be")
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "and now this", deliveryId: "d-second", interrupt: true },
  })
  const after = parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)
  assert.deepEqual(after.map((i) => i.state), ["delivered", "delivered"])
  h.storage.close()
})

// What "send now" hands the bridge, since the bridge turns it into the runtime's own send-now: WHO
// typed the message (the runtime moves a running call aside only for a person's, and aborts the turn
// for anything else) and WHICH message it is for.
test("send now tells the runtime a person typed the message, and names it", async () => {
  const { h, slug } = interruptHarness()
  const deliveryId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
  const sent: Array<{ human?: boolean; deliveryId?: string }> = []
  const pushed: Array<{ deliveryId?: string }> = []
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = {
    followUp: async (input: { human?: boolean; deliveryId?: string }) => void sent.push({ human: input.human, deliveryId: input.deliveryId }),
    interruptTurn: (input: { deliveryId?: string }) => { pushed.push({ deliveryId: input.deliveryId }); return true },
  }
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "read this", deliveryId, interrupt: true } })
  assert.deepEqual(sent, [{ human: true, deliveryId }])
  assert.deepEqual(pushed, [{ deliveryId }])
  // A peer thread's message arrives by the same route and is nobody's typing.
  sent.length = 0
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: formatThreadMessage({ slug: "other-thread", title: "Other thread" }, "the audit is done") },
  })
  assert.deepEqual(sent.map((entry) => entry.human), [false])
  h.storage.close()
})

test("an ordinary follow-up never preempts the turn", async () => {
  const { h, slug, order } = interruptHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "whenever you get to it" } })
  assert.deepEqual(order, ["followUp"], "the running command is left alone unless the operator asked")
  h.storage.close()
})

// ── Pushing an ALREADY-queued message through (the ↑ on the queued bubble) ───────────────────────
// The same preemption, asked for after the fact instead of at send time. The message is already in the
// daemon's queue, so this route sends nothing at all — it is the interrupt half on its own, which works
// only because the SDK's interrupt leaves queued input intact for the next turn to open on.
test("push-it-now interrupts the turn and delivers no second copy of the message", async () => {
  const { h, slug, order } = interruptHarness()
  const result = await h.router.deliverQueuedNow.handler({ input: { slug, sessionId: `sid-${slug}` } })
  assert.deepEqual(result, { interrupted: true })
  assert.deepEqual(order, ["interruptTurn"], "no followUp — the words are already queued")
  h.storage.close()
})

// What the ↑ is FOR. The words were already queued, so the only observable outcome of the click is that
// they stop reading as "still waiting" — and that has to be server truth, or it dies on the next
// transcript push and does not survive a reload or reach a second tab.
test("push-it-now stops the queue it freed from rendering as queued", async () => {
  const { h, slug } = interruptHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "waiting", deliveryId: "d-wait" } })
  assert.equal(parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)[0].state, "enqueued")
  await h.router.deliverQueuedNow.handler({ input: { slug, sessionId: `sid-${slug}` } })
  assert.equal(parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)[0].state, "delivered")
  h.storage.close()
})

// The JOIN, because a ledger state nobody renders differently would be a no-op: the SAME flip, put back
// through the projection that owns the transcript, un-grays the fold's own gray bubble for that send.
// This is the whole observable effect of the gesture — everything above it is bookkeeping.
test("push-it-now un-grays the bubble the operator was looking at", async () => {
  const { h, slug } = interruptHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "read this now", deliveryId: "d-join" } })
  const fold = (): TranscriptMessage[] => [{ sourceId: "fold-1", role: "user", text: "read this now", tools: [], parts: [], queued: true }]
  const before = projectDeliveryLedger(fold(), parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger))
  assert.equal(before[0].queued, true, "gray while it waits behind the turn")
  await h.router.deliverQueuedNow.handler({ input: { slug, sessionId: `sid-${slug}` } })
  const after = projectDeliveryLedger(fold(), parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger))
  assert.equal(after[0].queued, false, "solid the moment the turn in front of it is preempted")
  assert.equal(after.length, 1, "and no second copy of it")
  h.storage.close()
})

// A refusal must change nothing: the send is still sitting in a queue nobody preempted, and un-graying
// it there would claim a turn abort that never happened.
test("push-it-now leaves the queue alone when there was nothing to interrupt", async () => {
  const { h, slug } = interruptHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "waiting", deliveryId: "d-wait" } })
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = { interruptTurn: () => false }
  await h.router.deliverQueuedNow.handler({ input: { slug, sessionId: `sid-${slug}` } })
  assert.equal(parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)[0].state, "enqueued")
  h.storage.close()
})

// "No live daemon" is the ordinary resting case, not a failure: the queued send is still queued and is
// read at the ordinary time. Reporting it as an error would tell the operator their message was lost.
test("push-it-now reports a thread with no running turn instead of throwing", async () => {
  const { h, slug } = interruptHarness()
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = { interruptTurn: () => false }
  const result = await h.router.deliverQueuedNow.handler({ input: { slug, sessionId: `sid-${slug}` } })
  assert.equal(result.interrupted, false)
  assert.match(result.reason ?? "", /no turn running/)
  h.storage.close()
})

// A pre-broker Claude row's follow-up was typed into Claude Code's own TUI composer and a codex steer
// went straight into the running turn — neither leaves frizz a turn it can preempt.
test("push-it-now refuses a runtime frizz holds no control channel into", async () => {
  const { h, slug } = interruptHarness()
  h.storage.setClaudeRuntime(slug, "legacy")
  const result = await h.router.deliverQueuedNow.handler({ input: { slug, sessionId: `sid-${slug}` } })
  assert.equal(result.interrupted, false)
  assert.match(result.reason ?? "", /isn't available on this thread's runtime/)
  h.storage.close()
})

// The same staleness guard every session-scoped mutation carries: a tab left open across a re-dispatch
// must not interrupt whatever now owns the slug.
test("push-it-now fails closed for a stale session id", async () => {
  const { h, slug } = interruptHarness()
  await assert.rejects(
    () => h.router.deliverQueuedNow.handler({ input: { slug, sessionId: "sid-from-a-dead-session" } }),
    /replaced; refresh before acting/,
  )
  h.storage.close()
})

// ── Reopening an archived thread by messaging it (every runtime) ─────────────────────────────────
// There is no Reopen verb in frizz: an archived thread's header states "Done" and the composer under it
// IS the reopen affordance ("Marked done — send a message to reopen it"). The un-archive that backs that
// promise lived inside resumeThread, which ONLY the spawned-CLI path reaches — so a broker-backed Claude row
// and an app-server Codex row resumed their WORKER and left their ROW archived. The thread then executed
// away while the board rendered it Done, and an archived thread has no lifecycle verbs, so there was no
// Mark-as-done button left to stop it with. Observed 2026-07-31 on a live broker thread: a `--resume`
// process running for minutes against a row still reading `exited=1, state='archived'`.
test("a follow-up reopens an archived BROKER-backed Claude thread, not just its worker", async () => {
  const { h, slug, calls } = restartHarness()
  h.storage.setState(slug, "archived")
  assert.equal(h.storage.getSession(slug)?.state, "archived")

  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "continue" } })

  assert.equal(calls.length, 1, "the message still reaches the worker")
  const reopened = h.storage.getSession(slug)
  assert.equal(reopened?.state, "open", "and the row it woke is Active again, not stranded in Done")
  assert.equal(reopened?.archived, 0, "including the legacy flag the board also honors")
  h.storage.close()
})

test("a follow-up reopens an archived app-server CODEX thread, not just its worker", async () => {
  const h = harness()
  const slug = "archived-codex"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.storage.setCodexRuntime(slug, "app-server")
  h.storage.setState(slug, "archived")

  const sent: string[] = []
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: null }),
    turnLiveness: () => undefined,
    resumeOwnedSession: async () => {},
    followUp: async ({ text }: { text: string }) => void sent.push(text),
  }

  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "continue" } })

  assert.deepEqual(sent, ["continue"], "the message still reaches the worker")
  const reopened = h.storage.getSession(slug)
  assert.equal(reopened?.state, "open")
  assert.equal(reopened?.archived, 0)
  h.storage.close()
})

// The reopen is session-guarded, so it cannot resurrect a row that was re-dispatched under a stale tab —
// and it is a NO-OP on an open thread, so an ordinary live steer writes nothing per keystroke.
test("a follow-up to an already-open thread writes no lifecycle change", async () => {
  const { h, slug, calls } = restartHarness()
  const before = h.storage.getSession(slug)

  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "more context" } })

  assert.equal(calls.length, 1)
  const after = h.storage.getSession(slug)
  assert.equal(after?.state, before?.state, "the lifecycle column is untouched")
  assert.equal(after?.archived, before?.archived)
  h.storage.close()
})

test("Restart worker is refused on a thread that is not a broker-backed Claude worker", async () => {
  const h = harness()
  const slug = "codex-restart"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.storage.setCodexRuntime(slug, "app-server")
  await assert.rejects(
    h.router.followUp.handler({
      input: { slug, sessionId: `sid-${slug}`, message: "restart please", freshProcess: true },
    }),
    /broker-backed Claude worker/,
  )
  h.storage.close()
})

// ---- The superseded worker procedures ------------------------------------------------------------
// A worker's `frizz-mcp.mjs` is spawned once from the build its session was dispatched with and outlives
// every server restart, so `/_frizz/rpc` is a versioned contract between two independently-updated processes.
// Merging the old `stop_hook` + `heartbeat` tools into `recurring_prompt` renamed the procedure and gave
// every in-flight worker a bare 404 from the one tool that keeps a long effort moving. These pin that
// each superseded name still lands on the merged row.

test("superseded worker procedures still route, and each writes only the trigger it owns", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("legacy-thread"))

    // The old ON-REST feature.
    await h.router.setOwnThreadStopHook.handler({
      input: { slug: "legacy-thread", prompt: "keep the migration moving", enabled: true },
    })
    let saved = h.storage.getSession("legacy-thread")!
    assert.equal(saved.recurring_prompt, "keep the migration moving")
    assert.equal(saved.recurring_on_rest, 1)
    assert.equal(saved.recurring_on_schedule, 0)

    // The old ON-SCHEDULE feature, arriving second. It must NOT disarm the rest trigger it never
    // mentions — under the old server those were two independent features, and a worker driving the old
    // tools cannot see the merged row to know it would be clobbering one with the other.
    await h.router.setOwnThreadHeartbeat.handler({
      input: { slug: "legacy-thread", prompt: "check the deploy", intervalSeconds: 600, enabled: true },
    })
    saved = h.storage.getSession("legacy-thread")!
    assert.equal(saved.recurring_on_rest, 1, "arming the heartbeat leaves the stop hook armed")
    assert.equal(saved.recurring_on_schedule, 1)
    assert.equal(saved.recurring_interval_ms, 600_000)
    // The single shared TEXT is the one thing the merge cannot preserve — last words supplied win.
    assert.equal(saved.recurring_prompt, "check the deploy")

    // Stopping ONE leaves the other running, still carrying the text it needs to fire.
    await h.router.setOwnThreadHeartbeat.handler({
      input: { slug: "legacy-thread", prompt: null, enabled: false },
    })
    saved = h.storage.getSession("legacy-thread")!
    assert.equal(saved.recurring_on_schedule, 0)
    assert.equal(saved.recurring_on_rest, 1, "stopping the heartbeat must not silently stop the stop hook")
    assert.equal(saved.recurring_prompt, "check the deploy")
    assert.equal(saved.recurring_interval_ms, 600_000, "the cadence is kept so the panel can switch it back on")

    // Stopping the LAST one clears the row outright, exactly as the current tool's `stop` does.
    await h.router.setOwnThreadStopHook.handler({
      input: { slug: "legacy-thread", prompt: null, enabled: false },
    })
    saved = h.storage.getSession("legacy-thread")!
    assert.equal(saved.recurring_prompt, null)
    assert.equal(saved.recurring_on_rest, 0)
    assert.equal(saved.recurring_on_schedule, 0)
  } finally {
    h.storage.close()
  }
})

test("the OLDEST heartbeat shape arms without an `enabled` field — a non-null prompt is the arming", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("oldest-thread"))

    // `setThreadHeartbeat` is the name the pre-merge builds POST, and it carried no `enabled` at all.
    await h.router.setThreadHeartbeat.handler({
      input: { slug: "oldest-thread", prompt: "poll the corpus", intervalSeconds: 900 },
    })
    let saved = h.storage.getSession("oldest-thread")!
    assert.equal(saved.recurring_prompt, "poll the corpus")
    assert.equal(saved.recurring_on_schedule, 1)
    assert.equal(saved.recurring_interval_ms, 900_000)

    // Its stop signalled with `prompt: null` alone.
    await h.router.setThreadHeartbeat.handler({ input: { slug: "oldest-thread", prompt: null } })
    saved = h.storage.getSession("oldest-thread")!
    assert.equal(saved.recurring_prompt, null)
    assert.equal(saved.recurring_on_schedule, 0)
  } finally {
    h.storage.close()
  }
})

test("a superseded worker procedure refuses an unregistered thread rather than writing nothing quietly", async () => {
  const h = harness()
  try {
    await assert.rejects(
      h.router.setOwnThreadStopHook.handler({ input: { slug: "never-dispatched", prompt: "go", enabled: true } }),
      /not registered/,
    )
  } finally {
    h.storage.close()
  }
})

test("an unknown RPC procedure answers 404 NAMING it, so the next version skew diagnoses itself", async () => {
  const h = harness()
  try {
    const app = new Hono()
    mountRouter(app, "/_frizz/rpc", h.router)
    const res = await app.request("/_frizz/rpc/setOwnThreadPreviousName", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "legacy-thread" }),
    })
    assert.equal(res.status, 404)
    const body = await res.json() as { error: string }
    // A bare `404 Not Found` naming nothing is what cost a live worker three silent retries.
    assert.match(body.error, /setOwnThreadPreviousName/)
    assert.match(body.error, /different version of frizz/)

    // And the catch-all must not shadow a real procedure registered before it.
    const real = await app.request("/_frizz/rpc/setOwnThreadStopHook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "never-dispatched", prompt: "go", enabled: true }),
    })
    assert.equal(real.status, 500, "a routed procedure reports ITS failure, not a routing miss")
  } finally {
    h.storage.close()
  }
})

// ---- PROMOTION: steering an EXTERNAL session turns it into a frizz thread ----
//
// The External band's rows carry an ordinary composer, and sending the first message is the whole
// ceremony (maintainer 2026-08-24). It runs inside followUp rather than behind a verb of its own so
// that one round trip covers both halves — the message and the row it belongs to can never end up on
// opposite sides of a failure.
test("followUp on an EXTERNAL session registers it first, keeping its id, then delivers", async () => {
  const EXTERNAL = "6543d3fb-e38e-461a-b10a-9c78261b67b2"
  let listed = [EXTERNAL]
  const h = harness({
    ...noopTailer,
    foreignIds: () => listed,
    get: () => ({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, aiTitle: "Debug a flaky test" }),
    foreignBackend: () => "claude",
  } as unknown as Tailer)
  const promoted: unknown[] = []
  const delivered: string[] = []
  ;(h.ctx as unknown as { dispatcher: Record<string, unknown> }).dispatcher.adoptSession = async (input: { sessionId: string; backend: string; title?: string }) => {
    promoted.push(input)
    // The real dispatcher writes the row; the fake writes the same one, because everything after the
    // promotion in this handler reads the REGISTRY, not the return value.
    h.storage.upsertSession({
      slug: input.sessionId, session_id: input.sessionId, thread_name: `frizz-${input.sessionId}`,
      spawned_at: "2026-08-24T00:00:00.000Z", last_read_at: null, unread: 0, exited: 0, archived: 0,
      rested_at: null, title_auto: 0, title: input.title ?? null, transcript_id: null, state: "open",
      meta: null, seen_at: null,
    })
    // The real dispatcher stamps the transport too; without it the follow-up falls through to the
    // retired legacy path and throws instead of reaching the broker.
    h.storage.setBackend(input.sessionId, input.backend)
    h.storage.setClaudeRuntime(input.sessionId, "broker")
    listed = [] // the foreign scan stops listing it the moment a row owns the id
    return { slug: input.sessionId, sessionId: input.sessionId }
  }
  ;(h.ctx as unknown as { claudeBroker: unknown }).claudeBroker = {
    followUp: async ({ text }: { text: string }) => void delivered.push(text),
  }

  try {
    // The client sends slug === sessionId, which is the only shape an external row ever has.
    await h.router.followUp.handler({ input: { slug: EXTERNAL, sessionId: EXTERNAL, message: "carry on from here" } })
    assert.deepEqual(promoted, [{ sessionId: EXTERNAL, backend: "claude", title: "Debug a flaky test" }])
    assert.deepEqual(delivered, ["carry on from here"], "the message that triggered the promotion is still delivered")
    // The id is unchanged, which is what lets the composer that sent this stay mounted.
    assert.equal(h.storage.getSession(EXTERNAL)?.session_id, EXTERNAL)

    // A SECOND message is an ordinary follow-up: the row exists, so nothing is promoted again.
    await h.router.followUp.handler({ input: { slug: EXTERNAL, sessionId: EXTERNAL, message: "and again" } })
    assert.equal(promoted.length, 1)
    assert.deepEqual(delivered, ["carry on from here", "and again"])
  } finally {
    h.storage.close()
  }
})

// The promotion is UN-FORGEABLE by construction: it adopts only a transcript the server can see for
// itself in this project's own log directory, right now. Without that check a crafted request could
// talk frizz into minting a row for any uuid at all.
test("followUp refuses an unregistered slug the tailer does not currently list as external", async () => {
  const h = harness()
  const promoted: unknown[] = []
  ;(h.ctx as unknown as { dispatcher: Record<string, unknown> }).dispatcher.adoptSession = async (input: unknown) => {
    promoted.push(input)
    return { slug: "x", sessionId: "x" }
  }
  try {
    const UNKNOWN = "11111111-1111-4111-8111-111111111111"
    await assert.rejects(
      () => h.router.followUp.handler({ input: { slug: UNKNOWN, sessionId: UNKNOWN, message: "hi" } }),
      /replaced/,
      "an id nothing has seen is the ordinary stale-thread refusal, not a promotion",
    )
    assert.deepEqual(promoted, [])
  } finally {
    h.storage.close()
  }
})

// A request naming two different values did not come from this band — a promoted thread keeps the id it
// was discovered under, so slug and sessionId are equal for the whole life of an external row.
test("followUp does not promote when the slug and session id disagree", async () => {
  const EXTERNAL = "6543d3fb-e38e-461a-b10a-9c78261b67b2"
  const h = harness({ ...noopTailer, foreignIds: () => [EXTERNAL] } as unknown as Tailer)
  const promoted: unknown[] = []
  ;(h.ctx as unknown as { dispatcher: Record<string, unknown> }).dispatcher.adoptSession = async (input: unknown) => {
    promoted.push(input)
    return { slug: "x", sessionId: "x" }
  }
  try {
    await assert.rejects(
      () => h.router.followUp.handler({ input: { slug: EXTERNAL, sessionId: "some-other-session", message: "hi" } }),
      /replaced/,
    )
    assert.deepEqual(promoted, [])
  } finally {
    h.storage.close()
  }
})

// ── The state a follow-up's ledger entry opens in ───────────────────────────────────────────────
// `enqueued` is a claim that something is AHEAD of the message; `delivered` says the provider took it
// straight into a turn. Rendering a delivered send gray is how a message "still looks enqueued while
// the agent is answering it" — for codex, for the whole rollout-materialization window; for Claude,
// for a cold resume's whole spin-up.
test("a follow-up to an idle Claude thread opens the ledger entry delivered", async () => {
  const { h, slug } = restartHarness() // its tailer reports turn "idle"
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "new task", deliveryId: "d-idle" },
  })
  const after = parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)
  assert.equal(after.find((i) => i.id === "d-idle")?.state, "delivered")
  h.storage.close()
})

test("a follow-up to a mid-turn Claude thread opens the ledger entry enqueued", async () => {
  const { h, slug } = interruptHarness() // its tailer reports turn "in-flight"
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "while you work", deliveryId: "d-mid" },
  })
  const after = parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)
  assert.equal(after.find((i) => i.id === "d-mid")?.state, "enqueued")
  h.storage.close()
})

test("a freshProcess restart's own message opens delivered even mid-turn", async () => {
  // The old process's turn dies with it; this message opens the new process's first turn.
  const { h, slug } = interruptHarness()
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "come back", deliveryId: "d-fresh", freshProcess: true },
  })
  const after = parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)
  assert.equal(after.find((i) => i.id === "d-fresh")?.state, "delivered")
  h.storage.close()
})

test("a codex follow-up opens the ledger entry delivered — its receipt names the turn", async () => {
  const h = harness()
  const slug = "codex-delivered"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.storage.setCodexRuntime(slug, "app-server")
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: null }),
    turnLiveness: () => undefined,
    resumeOwnedSession: async () => {},
    followUp: async () => ({ turnId: "t-1", mode: "start", deduped: false }),
  }
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "go", deliveryId: "d-cdx" },
  })
  const after = parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)
  assert.equal(after.find((i) => i.id === "d-cdx")?.state, "delivered")
  h.storage.close()
})

// A CHARACTER NO PROVIDER CAN BE HANDED. The send used to be refused outright ("This message holds a
// control or incomplete character frizz can't send. Edit and resend.", maintainer 2026-10-13: "wtf why
// not strip this?"). It is taken out instead — and from the LEDGER's copy too, not only the worker's:
// a delivery is matched to its transcript record by text, so an entry that kept the character would
// never match the record of what was actually sent and would draw a second bubble beside it.
test("a follow-up carrying undeliverable characters is sent without them, and recorded that way", async () => {
  const pasted = `first line${String.fromCodePoint(0x2028)}second ${String.fromCodePoint(27)}[1mline${String.fromCharCode(0xd83d)}`
  const cleaned = "first line\nsecond [1mline"
  const { h, slug, calls } = restartHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: pasted, deliveryId: "d-pasted" } })
  assert.equal(calls[0]?.text, cleaned, "the worker receives the message with those characters taken out")
  assert.equal(parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger).find((i) => i.id === "d-pasted")?.text, cleaned, "…and the ledger holds the same words")
  // Nothing but such characters is nothing to send, and says so rather than delivering an empty turn.
  await assert.rejects(
    h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: String.fromCodePoint(0, 27, 127), deliveryId: "d-empty" } }),
    /There is nothing to send/,
  )
  assert.equal(calls.length, 1)
  h.storage.close()

  // "Send to queue" writes its own ledger entry before any transport is called: the same words there.
  const mid = interruptHarness()
  await mid.h.router.followUp.handler({ input: { slug: mid.slug, sessionId: `sid-${mid.slug}`, message: pasted, deliveryId: "d-held", hold: true } })
  const held = parseDeliveryLedger(mid.h.storage.getSession(mid.slug)!.delivery_ledger).find((i) => i.id === "d-held")
  assert.deepEqual([held?.state, held?.text], ["held", cleaned])
  mid.h.storage.close()
})

// The kirby bug (2026-09-02): ~/Documents was itself an adopted project, so picking a brand-new
// empty folder under it "added" documents — the picker navigated to another project's board, and no
// flow could create the new project at all.
test("projectAdd: a picked folder under an adopted plain directory becomes its own project", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-add-"))
  try {
    const umbrella = join(home, "Documents")
    const picked = join(umbrella, "projects", "kirby")
    mkdirSync(picked, { recursive: true })
    writeProjectIdFile(umbrella, "88abce4f-16e9-42b3-899d-2576382b2ff3")
    registerProject({ dir: umbrella, id: "88abce4f-16e9-42b3-899d-2576382b2ff3" }, home)
    const card = addProjectAtPath(picked, home)
    assert.equal(card.path, realpathSync(picked))
    assert.equal(card.slug, "kirby")
    // The pick minted the folder's OWN id — it did not reopen or touch the umbrella's.
    assert.ok(readProjectIdFile(picked))
    assert.notEqual(readProjectIdFile(picked), readProjectIdFile(umbrella))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// Minting an id in $HOME writes a project into ~/.frizz, Frizz's own state root, and every unmarked
// directory under home then resolves to it. The launcher refuses this (2026-08-06); the grid must too.
test("projectAdd: the home directory itself is refused, and nothing is written", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-add-home-"))
  try {
    assert.throws(() => addProjectAtPath(home, home), /home folder/u)
    assert.equal(existsSync(join(home, ".frizz", ".id")), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// A folder's mode says nothing about whether it may be a project. Such folders were refused from
// 2026-10-09 to 2026-10-11, after a stolen board session added `/private/tmp`; the refusal did not
// stop that session, which could add any other folder or dispatch into an existing project. It did
// refuse every repo on a Windows drive under WSL, where a folder shows one set of bits for user,
// group and other (Microsoft, "File Permissions for WSL").
test("projectAdd: a folder every account can write to is an ordinary project", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-add-shared-"))
  try {
    const shared = join(home, "shared")
    mkdirSync(shared)
    chmodSync(shared, 0o777)
    const card = addProjectAtPath(shared, home)
    assert.equal(card.path, realpathSync(shared))
    assert.ok(readProjectIdFile(shared))
    assert.equal(listProjects(home).length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── The interrupt's collateral: background sub-agents ─────────────────────────────────────────────
// The SDK's interrupt aborts every background task the turn owned, and the runtime tells the worker
// nothing — so the worker goes on believing the child is live and parks on its id (nub thread
// `looks-like-my-github-account-was`, 2026-09-24, twice). The router snapshots the running children
// before the frame goes out and, once the tailer stops listing them, queues ONE note naming them.
test("interrupt and send queues a note naming the sub-agents the tailer then sees killed", async () => {
  let interrupted = false
  const running = { subAgents: [{ id: "toolu_child", taskId: "abc9b9b5f0da4c677", label: "Implementing four Keyward daemon changes", state: "running", startedAt: "2026-09-24T03:00:00.000Z" }] }
  const killed = { subAgents: [], retiredSubAgents: [{ id: "toolu_child", taskId: "abc9b9b5f0da4c677", label: "Implementing four Keyward daemon changes", status: "killed" }] }
  const tailer = { ...noopTailer, get: () => ({ turn: "in-flight", ...(interrupted ? killed : running) }) as never }
  const h = harness(tailer)
  const slug = "interrupt-kills"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "claude")
  h.storage.setClaudeRuntime(slug, "broker")
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = {
    followUp: async () => {},
    interruptTurn: () => { interrupted = true; return true },
  }
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "it keeps focusing spontaneously", deliveryId: "d-kill", interrupt: true },
  })
  const rows = createWakeDeliveryStore(h.storage.scope).list()
  assert.equal(rows.length, 1, "one note for one interrupt")
  assert.equal(rows[0].fenceId.startsWith("interrupt-ended:"), true)
  assert.match(rows[0].message, /`abc9b9b5f0da4c677` — Implementing four Keyward daemon changes/)
  // And it is claimable NOW, not after the quiet window: the worker is mid-turn on the very send that
  // killed the child, and that turn is where it decides what to wait on.
  assert.ok(rows[0].nextAttemptAt <= Date.now())
  h.storage.close()
})

test("an ordinary follow-up beside running sub-agents queues no such note", async () => {
  const running = { subAgents: [{ id: "toolu_child", taskId: "abc9b9b5f0da4c677", label: "child", state: "running", startedAt: "2026-09-24T03:00:00.000Z" }] }
  const tailer = { ...noopTailer, get: () => ({ turn: "in-flight", ...running }) as never }
  const h = harness(tailer)
  const slug = "no-interrupt"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "claude")
  h.storage.setClaudeRuntime(slug, "broker")
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = { followUp: async () => {}, interruptTurn: () => true }
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "whenever", deliveryId: "d-plain" } })
  assert.deepEqual(createWakeDeliveryStore(h.storage.scope).list(), [])
  h.storage.close()
})

// ---- THE INTERRUPT FLAG NEVER REACHES A CODEX OR ACP RUNTIME ----
// ⌘-Enter's "interrupt and send" is a Claude-broker verb. On Codex the message STEERS the running turn
// (the app-server owns steer-vs-start), on an ACP agent it QUEUES behind the turn (ACP has no steer),
// and `turn/interrupt` / `session/cancel` are reserved for ending the thread. A client that sends the
// flag anyway must get an ordinary delivery — never an interrupt that would end that turn's sub-agents
// with it (maintainer 2026-09-24: "make sure that we don't kill subagents unnecessarily for Codex
// either. Or any of the ACPs").

test("followUp with interrupt:true on an app-server Codex row steers the turn and never interrupts it", async () => {
  const h = harness()
  const slug = "codex-steer-not-interrupt"
  codexSessionRow(h.storage, slug, "app-server")
  const delivered: string[] = []
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: "turn-1" }),
    turnLiveness: () => ({ bridgeTurn: true, ownedSince: "2026-09-24T00:00:00.000Z" }),
    followUp: async ({ text }: { text: string }) => void delivered.push(text),
    interruptTurn: async () => { throw new Error("a Codex turn must never be interrupted for a follow-up") },
  }
  try {
    await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "also check the tests", interrupt: true } })
    assert.deepEqual(delivered, ["also check the tests"], "the message steers the running turn")
  } finally {
    h.storage.close()
  }
})

test("followUp with interrupt:true on an ACP row queues behind the turn and never cancels it", async () => {
  const h = harness()
  const slug = "acp-queue-not-cancel"
  h.storage.upsertSession({ ...row(slug), exited: 0 })
  h.storage.setBackend(slug, "acp")
  h.storage.setAcpAgent(slug, "gemini")
  const delivered: string[] = []
  ;(h.ctx as { acpBridge?: unknown }).acpBridge = {
    followUp: async ({ text }: { text: string }) => {
      delivered.push(text)
      return { acpSessionId: "acp-1", state: "queued", sessionLive: true, turnActive: true, queued: 1, resumed: false }
    },
    interruptTurn: async () => { throw new Error("an ACP turn must never be cancelled for a follow-up") },
  }
  try {
    await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "also check the tests", interrupt: true, deliveryId: "d-1" } })
    assert.deepEqual(delivered, ["also check the tests"], "the message queues behind the running turn")
    assert.equal(h.storage.getSession(slug)?.agent_session_id, "acp-1", "the bridge's session id is pinned on the row")
  } finally {
    h.storage.close()
  }
})

// ---- MARK AS DONE ENDS AN IDLE ACP AGENT ----
// An ACP agent lives in a detached daemon (acp-host.ts) that outlives frizz, so "live" for Mark as done
// is "an agent process exists", idle or mid-turn — the broker Claude reading. Reading only the turn
// let an idle agent outlive its archived thread (promoted-artifact run, 2026-09-24).
test("Mark as done on an idle ACP thread whose agent is alive asks first, then releases the agent", async () => {
  const h = harness()
  const slug = "acp-idle-done"
  h.storage.upsertSession({ ...row(slug), exited: 0 })
  h.storage.setBackend(slug, "acp")
  h.storage.setAcpAgent(slug, "gemini")
  const released: string[] = []
  ;(h.ctx as { acpBridge?: unknown }).acpBridge = {
    isAgentAlive: () => released.length === 0,
    turnLiveness: () => ({ sessionLive: true, turnActive: false, queued: 0 }),
    endSession: async (s: string, sid: string) => void released.push(`${s}/${sid}`),
  }
  try {
    const asked = await h.router.completeThread.handler({ input: { slug, sessionId: `sid-${slug}`, terminateLive: false } })
    assert.equal(asked.needsConfirmation, true, "an idle agent is still a worker to end, so it asks")
    assert.deepEqual(released, [])
    const done = await h.router.completeThread.handler({ input: { slug, sessionId: `sid-${slug}`, terminateLive: true } })
    assert.equal(done.needsConfirmation, false)
    assert.deepEqual(released, [`${slug}/sid-${slug}`], "the daemon and its agent are ended")
    assert.equal(h.storage.getSession(slug)?.state, "archived")
  } finally { h.storage.close() }
})

// ---- A MESSAGE WAITING ON AN ACP THREAD ----
// ACP has no steer, so a message sent mid-turn waits, and it has to survive whatever ends that turn:
// a stop opens the next turn on a new agent, and Mark as done leaves it visibly failed.
function acpQueueHarness(turn: "idle" | "in-flight") {
  const tailer = { ...noopTailer, get: () => ({ turn, subAgents: [], lastAssistantAt: "2026-01-01T00:00:00.000Z" }) as never }
  const sent: string[] = []
  let stranded: ((event: unknown) => void) | undefined
  const bridge = {
    followUp: async ({ text }: { text: string }) => { sent.push(text); return { acpSessionId: "acp-1", state: "delivered", resumed: "loaded" } },
    onFollowUpsStranded: (listener: (event: unknown) => void) => { stranded = listener; return () => {} },
    isEnding: () => false,
    isAgentAlive: () => false,
    turnLiveness: () => undefined,
    endSession: async () => {},
  }
  const h = harness(tailer, bridge)
  const slug = "acp-queued"
  h.storage.upsertSession({ ...row(slug), exited: 0 })
  h.storage.setBackend(slug, "acp")
  h.storage.setAcpAgent(slug, "opencode")
  const ledger = () => parseDeliveryLedger(h.storage.getSession(slug)?.delivery_ledger).map((item) => [item.id, item.state])
  return { h, slug, sent, bridge, ledger, strand: (id: string, text: string) => stranded!({ threadSlug: slug, sessionId: `sid-${slug}`, followUps: [{ text, deliveryId: id }] }) }
}

test("a message sent mid-turn on an ACP thread is held by Frizz, whoever sends it, and Send now refuses to pretend", async () => {
  const { h, slug, sent, ledger } = acpQueueHarness("in-flight")
  try {
    await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "cherry", deliveryId: "d-1" } })
    assert.deepEqual(sent, [], "no transport has it")
    assert.deepEqual(ledger(), [["d-1", "held"]])
    const now = await h.router.deliverQueuedNow.handler({ input: { slug, sessionId: `sid-${slug}`, releaseOnly: true } })
    assert.equal(now.released, undefined)
    assert.match(now.reason ?? "", /when its turn ends/)
    assert.deepEqual(ledger(), [["d-1", "held"]])
  } finally { h.storage.close() }
})

test("a message the ACP bridge stranded goes out on a new agent once the thread is at rest", async () => {
  const { h, slug, sent, ledger, strand } = acpQueueHarness("idle")
  try {
    appendDelivery(h.storage, slug, { id: "d-1", text: "cherry", state: "enqueued" })
    strand("d-1", "cherry")
    assert.deepEqual(ledger(), [["d-1", "held"]])
    await h.router.killAgent.handler({ input: { slug } })
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise((res) => setTimeout(res, 10))
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /^cherry/)
  } finally { h.storage.close() }
})

test("Mark as done with a message waiting on an ACP thread leaves it failed with its words, and does not reopen the thread", async () => {
  const { h, slug, sent, ledger, strand } = acpQueueHarness("idle")
  try {
    appendDelivery(h.storage, slug, { id: "d-1", text: "cherry", state: "enqueued" })
    strand("d-1", "cherry")
    const done = await h.router.completeThread.handler({ input: { slug, sessionId: `sid-${slug}`, terminateLive: true } })
    assert.equal(done.needsConfirmation, false)
    for (let i = 0; i < 50 && ledger()[0]?.[1] !== "failed"; i++) await new Promise((res) => setTimeout(res, 10))
    assert.deepEqual(ledger(), [["d-1", "failed"]])
    assert.deepEqual(sent, [], "nothing went to an agent")
    assert.equal(h.storage.getSession(slug)?.state, "archived")
    const item = parseDeliveryLedger(h.storage.getSession(slug)?.delivery_ledger)[0]!
    assert.equal(item.text, "cherry")
    assert.match(item.error ?? "", /session ended/)
  } finally { h.storage.close() }
})

// ── Compact now (the context meter's hover panel) ───────────────────────────────────────────────
// The button reaches each harness's own manual compaction. The Claude half rides the follow-up channel
// but is NOT a follow-up: the text must arrive as the bare `/compact` (Claude Code reads anything after
// it as summarization instructions, so a gap note appended there would steer the summary), and it must
// leave no delivery-ledger entry behind, because no bubble is drawn for it.
function compactHarness(turn: "idle" | "in-flight" = "idle") {
  const tailer = { ...noopTailer, get: () => ({ turn, subAgents: [], lastAssistantAt: "2026-01-01T00:00:00.000Z" }) as never }
  const h = harness(tailer)
  const slug = "compact-me"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "claude")
  h.storage.setClaudeRuntime(slug, "broker")
  const calls: { text: string; deliveryId?: string }[] = []
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = {
    followUp: async (input: { text: string; deliveryId?: string }) => void calls.push(input),
  }
  return { h, slug, calls }
}

test("Compact now sends a broker Claude worker the bare /compact, with no ledger entry", async () => {
  const { h, slug, calls } = compactHarness()
  await h.router.compactThread.handler({ input: { slug, sessionId: `sid-${slug}` } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, "/compact", "no gap note, even on a thread that rested long ago")
  assert.equal(calls[0].deliveryId, undefined)
  assert.equal(h.storage.getSession(slug)?.delivery_ledger ?? null, null, "no bubble to project")
  h.storage.close()
})

test("Compact now refuses a turn in flight rather than splicing /compact into it", async () => {
  const { h, slug, calls } = compactHarness("in-flight")
  await assert.rejects(h.router.compactThread.handler({ input: { slug, sessionId: `sid-${slug}` } }), /current turn to end/)
  assert.equal(calls.length, 0)
  h.storage.close()
})

test("Compact now refuses a runtime Frizz cannot compact", async () => {
  const { h, slug, calls } = compactHarness()
  h.storage.setBackend(slug, "acp")
  await assert.rejects(h.router.compactThread.handler({ input: { slug, sessionId: `sid-${slug}` } }), /can't be compacted/)
  assert.equal(calls.length, 0)
  h.storage.close()
})

test("Compact now asks an app-server codex thread for thread/compact/start", async () => {
  const { h, slug } = compactHarness()
  h.storage.setBackend(slug, "codex")
  h.storage.setCodexRuntime(slug, "app-server")
  const compacted: string[] = []
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: null }),
    resumeOwnedSession: async () => { throw new Error("an active binding needs no resume") },
    compactThread: async (threadSlug: string, sessionId: string) => void compacted.push(`${threadSlug}/${sessionId}`),
  }
  await h.router.compactThread.handler({ input: { slug, sessionId: `sid-${slug}` } })
  assert.deepEqual(compacted, [`${slug}/sid-${slug}`])
  h.storage.close()
})

// ── "Send to queue": Frizz HOLDS the message until the agent rests ───────────────────────────────
// The prompt box's Send menu has two rows (maintainer 2026-10-11): "Send as steer", which is the
// follow-up above, and "Send to queue" — "Frizz maintains that in memory until the agent comes to rest,
// and then it pushes it". Held means no transport has been handed anything, so these pin both halves:
// nothing reaches the runtime while the turn runs, and the same send — same id, same bubble — is what
// goes out when it ends.
function holdHarness() {
  let turn: "in-flight" | "idle" = "in-flight"
  const tailer = { ...noopTailer, get: () => ({ turn, subAgents: [] }) as never }
  const h = harness(tailer)
  const slug = "hold-me"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "claude")
  h.storage.setClaudeRuntime(slug, "broker")
  const sent: { text: string; deliveryId?: string }[] = []
  const order: string[] = []
  const cancelled: string[] = []
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = {
    followUp: async (input: { text: string; deliveryId?: string }) => { sent.push({ text: input.text, deliveryId: input.deliveryId }); order.push("followUp") },
    interruptTurn: () => { order.push("interruptTurn"); return true },
    cancelFollowUp: async (input: { deliveryId: string }) => { cancelled.push(input.deliveryId); return true },
  }
  const ledger = () => parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)
  // The tailer's in-flight → idle edge, as the router sees it: the turn-done notification on the bus.
  // The release is deferred a macrotask behind it and then awaits its delivery, so give it two.
  const rest = async () => {
    turn = "idle"
    ;(h.ctx as unknown as { bus: Bus }).bus.publish({ type: "notify", slug, kind: "turn-done", title: slug, body: "" })
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const sid = `sid-${slug}`
  return { h, slug, sid, sent, order, cancelled, ledger, rest, setTurn: (next: "in-flight" | "idle") => { turn = next } }
}

test("a message sent to the queue mid-turn is held, and the rest delivers that same send", async () => {
  const { h, slug, sid, sent, ledger, rest } = holdHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: "after this, rebase", deliveryId: "d-hold", hold: true } })
  assert.equal(sent.length, 0, "nothing is handed to the runtime while the turn runs")
  assert.deepEqual(ledger().map((i) => [i.id, i.state, i.text]), [["d-hold", "held", "after this, rebase"]])
  // A replayed call (the client's retry) must not deliver early, and must not hold a second copy.
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: "after this, rebase", deliveryId: "d-hold", hold: true } })
  assert.equal(sent.length, 0)
  assert.equal(ledger().length, 1)
  await rest()
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-hold"], "the same id: the bubble on screen becomes the delivered message")
  assert.match(sent[0].text, /^after this, rebase/)
  assert.deepEqual(ledger().map((i) => [i.id, i.state]), [["d-hold", "delivered"]], "it opened the next turn, so it is read, not waiting")
  // …and the instant the human sent it outlives the ledger entry, so the record it lands as is not read as
  // a reply to whatever the rest it was released into handed over (tailer heldTypedAt).
  const releases: { id: string; heldAt: number }[] = JSON.parse(h.storage.getSession(slug)?.held_releases ?? "[]")
  assert.deepEqual(releases.map((r) => r.id), ["d-hold"])
  assert.ok(releases[0].heldAt <= Date.now(), "the instant it was sent, not the release")
  h.storage.close()
})

// A held send's steps report is told to the worker when the send is released, never at the hold: a send
// taken back, or whose release failed, left the box reading done and heard while the worker had heard
// nothing, and the next report left it out (2026-11-11).
test("a held send's ticks are reported when it is released, not when it is held", async () => {
  const { h, slug, sid, rest } = holdHarness()
  const tick = () => h.storage.humanTodoTicksBySlug().get(slug)?.find((t) => t.item_id === "step-1")
  h.storage.setHumanTodo(slug, "step-1", true, Date.now())
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: "Done 1 of 2:\n- [x] Sign in\n- [ ] Approve", deliveryId: "d-report", hold: true, todos: [{ id: "step-1", done: true }] } })
  assert.equal(tick()?.reported_at, null, "nothing is told to the worker while the message waits")
  // …and nothing is owed about it either: the board reads it as on its way, so the boxes do not stage
  // again for the next send to report a second time.
  assert.deepEqual([...(ticksOnTheirWay(h.storage.getSession(slug)?.delivery_ledger) ?? [])], [["step-1", true]])
  await rest()
  assert.equal(typeof tick()?.reported_at, "number", "told once it is handed over")
  h.storage.close()
})

test("the Retry of a failed send reports the ticks it carried; a failed send's ticks are not on their way", async () => {
  const { h, slug, sid, setTurn } = holdHarness()
  setTurn("idle")
  const tick = () => h.storage.humanTodoTicksBySlug().get(slug)?.find((t) => t.item_id === "step-1")
  h.storage.setHumanTodo(slug, "step-1", true, Date.now())
  const broker = h.ctx as { claudeBroker?: unknown }
  const working = broker.claudeBroker
  broker.claudeBroker = { followUp: async () => { throw new Error("boom") } }
  const report = "Done 1 of 2:\n- [x] Sign in\n- [ ] Approve"
  await assert.rejects(h.router.followUp.handler({ input: { slug, sessionId: sid, message: report, deliveryId: "d-fail", todos: [{ id: "step-1", done: true }] } }))
  assert.equal(tick()?.reported_at, null)
  assert.equal(ticksOnTheirWay(h.storage.getSession(slug)?.delivery_ledger), undefined, "a failed send's ticks stage again")
  // The bubble's Retry: the kept words under a new id, and no ticks of its own.
  broker.claudeBroker = working
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: report, deliveryId: "d-retry", supersedes: "d-fail" } })
  assert.equal(typeof tick()?.reported_at, "number", "the retry told the worker, so the tick is reported")
  h.storage.close()
})

test("at rest, sending to the queue is an ordinary send: there is nothing to wait for", async () => {
  const { h, slug, sid, sent, ledger, setTurn } = holdHarness()
  setTurn("idle")
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: "go", deliveryId: "d-now", hold: true } })
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-now"])
  assert.equal(ledger()[0].state, "delivered")
  h.storage.close()
})

// A steer sent WHILE a message is held goes straight through, and the user record it produces must not
// be read as the held message's delivery — the FIFO rule that retires an outstanding send on a later
// user turn is about sends a provider queue holds, and no queue has seen this one.
test("steering past a held message leaves it held", async () => {
  const { h, slug, sid, sent, ledger } = holdHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: "later", deliveryId: "d-hold", hold: true } })
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: "now", deliveryId: "d-steer" } })
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-steer"])
  assert.deepEqual(ledger().map((i) => [i.id, i.state]), [["d-hold", "held"], ["d-steer", "enqueued"]])
  h.storage.close()
})

// The sweep is the clock that releases a held message when no rest edge is left to do it. It belongs to
// the context the router was built on, and until it ended with that context it outlived it: this file's
// own tests left thirteen of them reading closed databases.
test("the sweep for held messages ends with its context, and nothing is released after", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] })
  const { h, slug, sid, sent, ledger, setTurn } = holdHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: "after this", deliveryId: "d-hold", hold: true } })
  let reads = 0
  const getSession = h.storage.getSession
  h.storage.getSession = (...args: Parameters<typeof getSession>) => { reads++; return getSession(...args) }
  // The control: while the context lives, the sweep looks at the thread every five seconds.
  t.mock.timers.tick(5_000)
  assert.ok(reads >= 1, "the sweep is running")
  assert.equal(sent.length, 0, "and the turn is still in flight, so nothing goes")

  h.endContext()
  reads = 0
  setTurn("idle")
  ;(h.ctx as unknown as { bus: Bus }).bus.publish({ type: "notify", slug, kind: "turn-done", title: slug, body: "" })
  t.mock.timers.tick(20_000)
  await Promise.resolve()
  assert.equal(reads, 0, "neither the clock nor a rest reads the project again")
  assert.equal(sent.length, 0, "and the held message is not delivered into a project that is closing")
  h.storage.getSession = getSession
  assert.deepEqual(ledger().map((i) => [i.id, i.state]), [["d-hold", "held"]], "it is still held, for the next time the project opens")
  // A send that arrives after the end arms nothing either.
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: "and this", deliveryId: "d-late", hold: true } }).catch(() => {})
  reads = 0
  h.storage.getSession = (...args: Parameters<typeof getSession>) => { reads++; return getSession(...args) }
  t.mock.timers.tick(20_000)
  assert.equal(reads, 0, "a late send does not start the clock again")
  h.storage.getSession = getSession
  h.storage.close()
})

test("a held message is taken back without asking the runtime, on any backend", async () => {
  const { h, slug, sid, cancelled, ledger, sent, rest } = holdHarness()
  h.storage.setBackend(slug, "codex") // a runtime whose own queue Frizz cannot reach into
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: "never mind", deliveryId: "d-hold", hold: true } })
  const result = await h.router.unqueueFollowUp.handler({ input: { slug, sessionId: sid, deliveryId: "d-hold" } })
  assert.deepEqual(result, { unqueued: true })
  assert.deepEqual(cancelled, [], "the runtime never had it")
  assert.deepEqual(ledger(), [], "dropped outright: there is no provider record to keep a tombstone for")
  await rest()
  assert.equal(sent.length, 0, "and the rest delivers nothing")
  h.storage.close()
})

test("push-it-now hands over what was held, then preempts the turn", async () => {
  const { h, slug, sid, order, sent, ledger } = holdHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: "read this now after all", deliveryId: "d-hold", hold: true } })
  const result = await h.router.deliverQueuedNow.handler({ input: { slug, sessionId: sid } })
  assert.deepEqual(result, { interrupted: true, released: 1 })
  assert.deepEqual(order, ["followUp", "interruptTurn"], "queued first, preempted second — the same contract as interrupt and send")
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-hold"])
  assert.equal(ledger()[0].state, "delivered")
  h.storage.close()
})

// "Send now" under a held bubble: the operator stopped waiting, and did NOT ask for an interrupt.
test("releasing a held message on request delivers it as a steer and preempts nothing", async () => {
  const { h, slug, sid, order, ledger } = holdHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: "actually, now is fine", deliveryId: "d-hold", hold: true } })
  const result = await h.router.deliverQueuedNow.handler({ input: { slug, sessionId: sid, releaseOnly: true } })
  assert.deepEqual(result, { interrupted: false, released: 1 })
  assert.deepEqual(order, ["followUp"], "no interruptTurn")
  assert.equal(ledger()[0].state, "enqueued", "in the provider's queue now, read at the agent's next step")
  h.storage.close()
})

// ── The queue goes out ONE MESSAGE PER TURN ─────────────────────────────────────────────────────────
// Maintainer 2026-10-20: "Items in the queue should always DQ one at a time." Each rest hands over the
// oldest held message alone, and the next waits until that message's turn has ended. `land` is the
// correlator seeing a released message's record reach the transcript, which drops it from the ledger —
// the moment its turn has started.
function oneAtATimeHarness() {
  const harnessed = holdHarness()
  const { h, slug, ledger } = harnessed
  const land = (id: string) => h.storage.setDeliveryLedger(slug, serializeDeliveryLedger(ledger().filter((i) => i.id !== id)))
  const queue = (id: string, message: string) =>
    h.router.followUp.handler({ input: { slug, sessionId: harnessed.sid, message, deliveryId: id, hold: true } })
  return { ...harnessed, land, queue }
}

test("queued messages go out one per turn, in order, each after the turn before it has ended", async () => {
  const { h, sent, ledger, rest, land, queue, setTurn } = oneAtATimeHarness()
  await queue("d-1", "fix the parser")
  await queue("d-2", "then add tests")
  await queue("d-3", "then update the docs")
  assert.equal(sent.length, 0, "nothing goes out while the turn runs")
  await rest()
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-1"], "the rest hands over the oldest alone")
  assert.deepEqual(ledger().map((i) => [i.id, i.state]), [["d-1", "delivered"], ["d-2", "held"], ["d-3", "held"]])
  // The second or two between the release and its turn starting: the thread still reads idle, and the
  // sweep (or a late edge) must not hand the next one into the same turn.
  await rest()
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-1"], "the next waits while the first has not landed")
  land("d-1")
  setTurn("in-flight")
  await rest()
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-1", "d-2"], "its turn ended, so the next one opens a turn of its own")
  land("d-2")
  setTurn("in-flight")
  await rest()
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-1", "d-2", "d-3"])
  h.storage.close()
})

test("sent to the queue at rest, it goes now when nothing is ahead and is held when something is", async () => {
  const { h, sent, ledger, rest, queue, setTurn } = oneAtATimeHarness()
  setTurn("idle")
  await queue("d-now", "nothing ahead of me")
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-now"], "at rest with nothing ahead, it is an ordinary send")
  // d-now is delivered but its turn has not shown up yet: the next must wait for that turn.
  await queue("d-next", "after that one")
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-now"])
  assert.deepEqual(ledger().map((i) => [i.id, i.state]), [["d-now", "delivered"], ["d-next", "held"]])
  await rest()
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-now"])
  h.storage.close()
})

test("a send to the queue at rest never overtakes a message already held", async () => {
  const { h, slug, sent, land, queue, rest, setTurn } = oneAtATimeHarness()
  // A message held from before a server restart, with the thread already at rest and no sweep yet.
  holdDelivery(h.storage, slug, { id: "d-old", text: "from before" })
  setTurn("idle")
  await queue("d-new", "and now this")
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-old"], "the held one goes first, and alone")
  land("d-old")
  setTurn("in-flight")
  await rest()
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-old", "d-new"], "the new one follows once that turn has ended")
  h.storage.close()
})

test("Send now under queued messages hands over the next one, not the whole queue", async () => {
  const { h, slug, sid, sent, ledger, order, queue } = oneAtATimeHarness()
  await queue("d-1", "first")
  await queue("d-2", "second")
  await queue("d-3", "third")
  assert.deepEqual(await h.router.deliverQueuedNow.handler({ input: { slug, sessionId: sid, releaseOnly: true } }), { interrupted: false, released: 1 })
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-1"])
  // The operator said not to wait, so a second press does not wait for the first one's turn either.
  assert.deepEqual(await h.router.deliverQueuedNow.handler({ input: { slug, sessionId: sid, releaseOnly: true } }), { interrupted: false, released: 1 })
  assert.deepEqual(sent.map((s) => s.deliveryId), ["d-1", "d-2"])
  assert.deepEqual(ledger().map((i) => [i.id, i.state]), [["d-1", "enqueued"], ["d-2", "enqueued"], ["d-3", "held"]])
  assert.deepEqual(order, ["followUp", "followUp"], "and nothing was interrupted")
  h.storage.close()
})

// A release that throws must leave the operator's words as a failed send they can retry, never drop them.
test("a held message whose release fails is kept as a failed send", async () => {
  const { h, slug, sid, ledger, rest } = holdHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: sid, message: "do not lose me", deliveryId: "d-hold", hold: true } })
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = { followUp: async () => { throw new Error("boom") } }
  await rest()
  assert.deepEqual(ledger().map((i) => [i.id, i.state, i.text]), [["d-hold", "failed", "do not lose me"]])
  h.storage.close()
})

// ── Answers and the typed note leave as ONE turn ─────────────────────────────────────────────────
// "It's very annoying to me that I can't send my answers and submit an additional steer at the same
// time, so we need to unify them" (maintainer 2026-10-11). The staged answers ride the follow-up: the
// questions settle, the scheduler's own answer wake is told not to carry them as well, and the worker
// reads the answers with the note under them.
const ask = (h: ReturnType<typeof harness>, slug: string, id: string, question: string) =>
  h.storage.askThreadQuestion({ id, slug, spec: JSON.stringify({ question, kind: "question", options: [{ label: "SQLite" }, { label: "JSON file" }] }), askedAtMs: Date.now() })

test("answers sent with a follow-up settle their questions and travel in the same message as the note", async () => {
  const { h, slug, sid, sent, ledger, setTurn } = holdHarness()
  setTurn("idle")
  ask(h, slug, "qst_store", "Which store?")
  const input = {
    slug, sessionId: sid, deliveryId: "d-answers", message: "and keep the migration small",
    answers: [{ questionId: "qst_store", question: "Which store?", chosen: ["SQLite"] }],
  }
  await h.router.followUp.handler({ input })
  const wire = "Answers to earlier questions:\n1. “Which store?” → SQLite\n\nSent with these answers:\nand keep the migration small"
  assert.equal(sent.length, 1, "one turn, not an answer wake and a steer")
  assert.ok(sent[0].text.startsWith(wire), sent[0].text)
  assert.equal(ledger()[0].text, wire, "and the bubble shows the same words")
  assert.equal(h.storage.getThreadQuestion("qst_store")?.state, "answered")
  assert.deepEqual(h.storage.undeliveredSettlements(), [], "the scheduler's answer wake must not send them a second time")
  // The client's replay of the same call finds the questions already settled. It must not compose a
  // different (answerless) message, and it must not deliver twice.
  await h.router.followUp.handler({ input })
  assert.equal(sent.length, 1)
  h.storage.close()
})

// A FENCE-ASKED question's answer names it by the worker's own id (2026-10-13), on this path as on the
// scheduler's: the id is read off the row and its spec tree, never off the request.
test("answers sent with a follow-up name a fence-asked question, and its follow-up, by the worker's own ids", async () => {
  const { h, slug, sid, sent, ledger, setTurn } = holdHarness()
  setTurn("idle")
  h.storage.askThreadQuestion({
    id: "qst_fence", slug, handle: "store", askedAtMs: Date.now(),
    spec: JSON.stringify({
      handle: "store", question: "Which store?", kind: "question",
      options: [{ label: "SQLite", followUps: [{ handle: "sqlite-path", question: "Which path?", kind: "question" }] }, { label: "JSON file" }],
    }),
  })
  ask(h, slug, "qst_plain", "Which path?")
  await h.router.followUp.handler({
    input: {
      slug, sessionId: sid, deliveryId: "d-named", message: "`store` “Which store?” → JSON file",
      answers: [
        { questionId: "qst_fence", question: "Which store?", chosen: ["SQLite"], followUps: [{ questionId: "qst_fence", question: "Which path?", chosen: [], text: "/tmp" }] },
        { questionId: "qst_plain", question: "Which path?", chosen: ["SQLite"] },
      ],
    },
  })
  const wire = [
    "Answers to earlier questions:",
    "1. `store` “Which store?” → SQLite",
    "2. ⤷ `sqlite-path` “Which path?” → /tmp",
    "3. “Which path?” → SQLite",
    "",
    "Sent with these answers:",
    "`store` “Which store?” → JSON file",
  ].join("\n")
  assert.ok(sent[0].text.startsWith(wire), sent[0].text)
  assert.equal(ledger()[0].text, wire, "and the bubble shows the same words")
  assert.equal(h.storage.getThreadQuestion("qst_fence")?.answer?.includes("sqlite-path"), false, "the row keeps the answer as it was sent: no id is stored")
  h.storage.close()
})

test("answers alone are a message: an empty prompt box still sends them", async () => {
  const { h, slug, sid, sent, setTurn } = holdHarness()
  setTurn("idle")
  ask(h, slug, "qst_store", "Which store?")
  await h.router.followUp.handler({
    input: { slug, sessionId: sid, deliveryId: "d-bare", message: "", answers: [{ questionId: "qst_store", question: "Which store?", chosen: ["JSON file"] }] },
  })
  assert.ok(sent[0].text.startsWith("Answers to earlier questions:\n1. “Which store?” → JSON file"))
  assert.ok(!sent[0].text.includes("Sent with these answers:"), "no note header over an empty note")
  h.storage.close()
})

test("answers sent to the queue settle at once and wait with the note for the rest", async () => {
  const { h, slug, sid, sent, ledger, rest } = holdHarness()
  ask(h, slug, "qst_store", "Which store?")
  await h.router.followUp.handler({
    input: { slug, sessionId: sid, deliveryId: "d-held-answers", message: "no rush", hold: true, answers: [{ questionId: "qst_store", question: "Which store?", chosen: ["SQLite"] }] },
  })
  assert.equal(sent.length, 0)
  assert.equal(h.storage.getThreadQuestion("qst_store")?.state, "answered", "the card settles when the human sends, not when the agent rests")
  assert.deepEqual(h.storage.undeliveredSettlements(), [])
  assert.equal(ledger()[0].state, "held")
  await rest()
  assert.ok(sent[0].text.startsWith("Answers to earlier questions:\n1. “Which store?” → SQLite\n\nSent with these answers:\nno rush"))
  h.storage.close()
})

test("a follow-up carrying neither words nor answers is refused", async () => {
  const { h, slug, sid } = holdHarness()
  await assert.rejects(h.router.followUp.handler({ input: { slug, sessionId: sid, message: "  " } }), /nothing to send/i)
  h.storage.close()
})

// A send the follow-up path refuses outright must not leave the questions answered with nothing on its
// way to the worker — the refusals run before the rows are touched.
test("a stale tab's answers settle nothing", async () => {
  const { h, slug } = holdHarness()
  ask(h, slug, "qst_store", "Which store?")
  await assert.rejects(h.router.followUp.handler({
    input: { slug, sessionId: "sid-someone-else", message: "", deliveryId: "d-stale", answers: [{ questionId: "qst_store", question: "Which store?", chosen: ["SQLite"] }] },
  }))
  assert.equal(h.storage.getThreadQuestion("qst_store")?.state, "open")
  h.storage.close()
})

// ── The human's × reaches the worker on their next send ──────────────────────────────────────────
// A dismissal wakes nobody, and is promised to "ride the next answer or the next steer". Only the
// scheduler's answer wake attached them, and the prompt box's Send settles its answers itself, so until
// 2026-11-11 no dismissal sent from a desktop board ever reached its worker: all three on the
// maintainer's Mac sat undelivered while later answers on the same threads went through.
const DISMISSED = "(dismissed — decide it yourself; do not re-ask)"

test("a dismissed question rides the next answers the human sends, and is delivered once", async () => {
  const { h, slug, sid, sent, ledger, setTurn } = holdHarness()
  setTurn("idle")
  ask(h, slug, "qst_store", "Which store?")
  ask(h, slug, "qst_name", "Which name?")
  await h.router.dismissQuestions.handler({ input: { slug, ids: ["qst_name"] } })
  assert.equal(sent.length, 0, "a dismissal wakes nobody by itself")
  await h.router.followUp.handler({
    input: { slug, sessionId: sid, deliveryId: "d-1", message: "", answers: [{ questionId: "qst_store", question: "Which store?", chosen: ["SQLite"] }] },
  })
  const wire = `Answers to earlier questions:\n1. “Which store?” → SQLite\n2. “Which name?” → ${DISMISSED}`
  assert.equal(sent[0].text.startsWith(wire), true, sent[0].text)
  assert.equal(ledger()[0].text, wire)
  assert.deepEqual(h.storage.undeliveredSettlements(), [], "nothing is left for the scheduler to send again")
  await h.router.followUp.handler({ input: { slug, sessionId: sid, deliveryId: "d-2", message: "and one more thing" } })
  assert.equal(sent[1].text.includes("Which name?"), false, "told once, not on every later send")
  h.storage.close()
})

test("a dismissed question rides a plain typed steer, under the human's own words", async () => {
  const { h, slug, sid, sent, setTurn } = holdHarness()
  setTurn("idle")
  h.storage.askThreadQuestion({ id: "qst_fence", slug, handle: "store", askedAtMs: Date.now(), spec: JSON.stringify({ handle: "store", question: "Which store?", kind: "question", options: [{ label: "SQLite" }, { label: "JSON file" }] }) })
  await h.router.dismissQuestions.handler({ input: { slug, ids: ["qst_fence"] } })
  await h.router.followUp.handler({ input: { slug, sessionId: sid, deliveryId: "d-steer", message: "carry on with the tests" } })
  assert.equal(
    sent[0].text.startsWith(`Answers to earlier questions:\n1. \`store\` “Which store?” → ${DISMISSED}\n\nSent with these answers:\ncarry on with the tests`),
    true,
    sent[0].text,
  )
  assert.equal(h.storage.getThreadQuestion("qst_fence")?.delivered, 1)
  h.storage.close()
})

test("a dismissal a scheduler wake is already carrying is left to that wake", async () => {
  const { h, slug, sid, sent, setTurn } = holdHarness()
  setTurn("idle")
  ask(h, slug, "qst_name", "Which name?")
  await h.router.dismissQuestions.handler({ input: { slug, ids: ["qst_name"] } })
  h.storage.assignSettlementDelivery("qst_name", "wake-1")
  await h.router.followUp.handler({ input: { slug, sessionId: sid, deliveryId: "d-steer", message: "carry on" } })
  assert.equal(sent[0].text.startsWith("carry on"), true, sent[0].text)
  assert.equal(h.storage.getThreadQuestion("qst_name")?.delivered, 0, "still that wake's to deliver")
  h.storage.close()
})

// A send carrying answers that fails is kept as a failed bubble, with the answers already settled and
// marked delivered. Dismissing that bubble used to leave the cards reading answered for answers nobody
// received; the rows come back instead (2026-11-11).
test("dismissing a failed send gives back the answers and dismissals it carried", async () => {
  const { h, slug, sid, setTurn } = holdHarness()
  setTurn("idle")
  ask(h, slug, "qst_store", "Which store?")
  ask(h, slug, "qst_path", "Which path?")
  ask(h, slug, "qst_name", "Which name?")
  await h.router.dismissQuestions.handler({ input: { slug, ids: ["qst_name"] } })
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = { followUp: async () => { throw new Error("boom") } }
  await assert.rejects(h.router.followUp.handler({
    input: {
      slug, sessionId: sid, deliveryId: "d-fail", message: "and keep it small",
      answers: [{ questionId: "qst_store", question: "Which store?", chosen: ["SQLite"] }, { questionId: "qst_path", question: "Which path?", chosen: ["JSON file"] }],
    },
  }))
  assert.equal(h.storage.getThreadQuestion("qst_store")?.state, "answered", "the send settled them before it failed")
  assert.deepEqual(await h.router.dismissFailedFollowUp.handler({ input: { slug, deliveryId: "d-fail" } }), { dismissed: true })
  assert.equal(h.storage.getThreadQuestion("qst_store")?.state, "open", "the card is answerable again")
  assert.equal(h.storage.getThreadQuestion("qst_path")?.state, "open", "every answer, not only the first")
  assert.equal(h.storage.getThreadQuestion("qst_store")?.answer, null)
  assert.equal(h.storage.getThreadQuestion("qst_name")?.state, "dismissed")
  assert.equal(h.storage.getThreadQuestion("qst_name")?.delivered, 0, "the dismissal rides the next send")
  h.storage.close()
})
