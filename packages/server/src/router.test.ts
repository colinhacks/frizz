import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { mountRouter } from "@frizz/rpc/server"
import { DISPATCH_TASK_BANNER_MARKER, type BoardSnapshot, type Settings, type ThreadView, type TranscriptMessage } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import { appendDelivery, parseDeliveryLedger, projectDeliveryLedger } from "./delivery-ledger.ts"
import { Emitter } from "./bus.ts"
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
import { registerProject } from "./project-registry.ts"
import { createStorage, type AdoptionClaimRow, type SessionRow } from "./storage.ts"
import type { AdoptionPaneLookup, PaneIdentity, PaneIdentity as PaneSnapshot } from "./adoption-recovery.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"
import { providerResumeCommand, shellQuote } from "./external-terminal.ts"

test("provider resume command is shell-safe", () => {
  assert.equal(shellQuote("frizz's socket"), "'frizz'\"'\"'s socket'")
  assert.equal(providerResumeCommand("codex", "/work/it's frizz", "session-id"), "cd '/work/it'\"'\"'s frizz' && codex resume 'session-id' --dangerously-bypass-approvals-and-sandbox")
  assert.equal(providerResumeCommand("claude", "/work/frizz", "session-id"), "cd '/work/frizz' && claude --resume 'session-id' --dangerously-skip-permissions")
})

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

function harness(tailer: Tailer = noopTailer) {
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
    currentSeq: () => 0,
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
  // createRouter is lazy: unrelated procedures do not read the omitted context fields. Keep this
  // focused on the permission route's real storage/board/backend dependencies.
  const ctx = {
    project,
    storage,
    board,
    tailer,
    // followUp pushes a transcript frame the moment it opens a ledger entry (the ledger is not JSONL
    // bytes, so nothing else would). Tests only need it to exist; assertions read the ledger itself.
    transcriptChange: new Emitter<string[]>(),
    backendFor: () => backend,
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
  return { dir, ctx, storage, board, snapshot, router: createRouter(ctx), addExitedThread, refreshes: () => refreshes, adoptCalls: () => adoptCalls }
}

test("threadTerminalCommand offers the verified provider resume command in every runtime state", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("codex-resume"))
    h.storage.setBackend("codex-resume", "codex")
    h.storage.setAgentSession("codex-resume", "codex-rollout-id")
    h.addExitedThread("codex-resume")
    h.snapshot.threads.at(-1)!.backend = "codex"

    const expected = { command: `cd '${h.dir}' && codex resume 'codex-rollout-id' --dangerously-bypass-approvals-and-sandbox`, mode: "resume", reason: null }

    h.board.snapshot = async () => {
      throw new Error("the copy path must not rebuild the board")
    }
    assert.deepEqual(
      await h.router.threadTerminalCommand.handler({ input: { slug: "codex-resume" } }),
      expected,
      "Codex resumes its provider rollout ID directly from the owned registry row",
    )

    // The row is exited, so a resume is the honest offer regardless of what the board snapshot says
    // the runtime is — the command is still offered, never gated on "wait for it to exit". A live row
    // gets the same resume: a headless worker has nothing to attach to.
    h.snapshot.threads.at(-1)!.runtime = "turn-idle"
    assert.deepEqual(
      await h.router.threadTerminalCommand.handler({ input: { slug: "codex-resume" } }),
      expected,
      "an exited row yields the resume command",
    )

    // Codex before its rollout id is discovered has no resumable native id — the Frizz UUID would not
    // resume it, so fail closed with an explanatory reason rather than a broken command.
    h.storage.upsertSession(row("codex-pending"))
    h.storage.setBackend("codex-pending", "codex")
    h.addExitedThread("codex-pending")
    h.snapshot.threads.at(-1)!.backend = "codex"
    assert.deepEqual(
      await h.router.threadTerminalCommand.handler({ input: { slug: "codex-pending" } }),
      {
        command: null,
        mode: "unavailable",
        reason: "Codex hasn't reported its resumable session id yet — it appears once the first turn begins.",
      },
    )

    await assert.rejects(
      h.router.threadTerminalCommand.handler({ input: { slug: "foreign-or-legacy" } }),
      /No Frizz-owned terminal session is available/,
    )
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

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
    writeFileSync(
      join(logDir, "sid-rename-src.jsonl"),
      [
        JSON.stringify({ type: "user", timestamp: "2026-08-24T00:00:00.000Z", message: { role: "user", content: envelope } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-08-24T00:01:00.000Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: lastAssistant }] } }),
      ].map((l) => l + "\n").join(""),
    )
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
    /running in your terminal/,
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
  assert.match(result.reason ?? "", /can't be interrupted/)
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
// There is no Reopen verb in frizz: an archived thread's footer states "Done" and the composer under it
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
