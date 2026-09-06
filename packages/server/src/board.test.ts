import { test } from "node:test"
import assert from "node:assert/strict"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { questionAnswerMessage, questionsCancelledWakeMessage, type InteractionRequest } from "@frizz/shared"
import { answersInFlight, appServerTurnStalled, createBoard, deriveAwaitingBackground, deriveNeedsYou, degradeIfAwaitingAnswer, degradeIfNoTranscript, fenceWatchViews, hasDeclaredWait, hasParkedTimerWatch, hasRegisteredBackgroundPark, isBoardRelevantFrizzPath, registeredDoneFence, resolveLimitPause, resolveSessionPermission, resolveSessionProfile, resolveSessionTitle, type RegisteredWatch } from "./board.ts"
import { Bus } from "./bus.ts"
import { createStorage, type ThreadQuestionRow } from "./storage.ts"
import type { Project } from "./project.ts"
import type { SessionRow } from "./storage.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

// The QUEUE DEFINITION is deriveNeedsYou — the single server-side source of truth for "this thread
// needs the human, put it on the stack." These tests pin every queue-worthy state, because a hole
// here means a thread that needs input silently never surfaces (2026-07-09: pendingQuestion was
// omitted, so a chat ```question the human had glanced at dropped off the stack — the exact failure
// the whole product exists to prevent).

const T0 = "2026-07-09T10:00:00.000Z"
const LATER = "2026-07-09T11:00:00.000Z"

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "s", thread_name: "frizz-t", spawned_at: T0, last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}
function tele(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, ...over }
}

test("resolveSessionProfile: only post-spawn telemetry can supersede a pinned launch profile", () => {
  // Claude: transcript gives the actual resolved model, while persisted launch metadata supplies the
  // effort Claude does not record.
  assert.deepEqual(
    resolveSessionProfile(row({ model: "opus", effort: "high" }), tele({ model: "claude-opus-4-6", profileAt: LATER })),
    { model: "opus", effort: "high" },
  )
  // Codex turn_context carries both, allowing a fully trustworthy pre-migration backfill.
  assert.deepEqual(
    resolveSessionProfile(row({ model: null, effort: null }), tele({ model: "gpt-5.5", effort: "xhigh" })),
    { model: "gpt-5.5", effort: "xhigh" },
  )
  assert.deepEqual(resolveSessionProfile(row(), undefined), { model: undefined, effort: undefined })
  assert.deepEqual(
    resolveSessionProfile(
      row({ model: "opus", effort: "high", spawned_at: LATER }),
      tele({ model: "claude-sonnet-4-6", profileAt: T0 }),
    ),
    { model: "opus", effort: "high" },
    "replayed telemetry from the previous generation cannot snap the target back",
  )
})

test("resolveSessionProfile: an eager operator model/effort change shows immediately, then converges", () => {
  const LATEST = "2026-07-09T12:00:00.000Z"
  const EVEN_LATER = "2026-07-09T13:00:00.000Z"

  // THE FIX (sibling of the sandbox pill): the operator picked low at LATEST — AFTER the last observed
  // turn_context (LATER, still reporting the OLD xhigh). The visible composer selector must show the
  // just-saved pick, not the stale observed reading, instead of snapping back for a full turn.
  assert.deepEqual(
    resolveSessionProfile(
      row({ backend: "codex", model: "gpt-5.6-sol", effort: "low", spawned_at: T0, profile_set_at: LATEST }),
      tele({ model: "gpt-5.6-sol", effort: "xhigh", profileAt: LATER }),
    ),
    { model: "gpt-5.6-sol", effort: "low" },
    "a just-picked codex model/effort outranks an older observed turn_context",
  )

  // CONVERGENCE: a genuinely newer turn (EVEN_LATER > LATEST) re-establishes observed authority.
  assert.deepEqual(
    resolveSessionProfile(
      row({ backend: "codex", model: "gpt-5.6-sol", effort: "low", spawned_at: T0, profile_set_at: LATEST }),
      tele({ model: "gpt-5.6-sol", effort: "xhigh", profileAt: EVEN_LATER }),
    ),
    { model: "gpt-5.6-sol", effort: "xhigh" },
    "a newer turn re-establishes observed authority",
  )

  // NO REGRESSION: a stale set-time (before the observed reading) must NOT resurrect the saved value
  // over a fresh turn — this is the reattach/idle case the observed-wins rule exists for.
  assert.deepEqual(
    resolveSessionProfile(
      row({ backend: "codex", model: "gpt-5.6-sol", effort: "high", spawned_at: T0, profile_set_at: T0 }),
      tele({ model: "gpt-5.6-sol", effort: "xhigh", profileAt: LATER }),
    ),
    { model: "gpt-5.6-sol", effort: "xhigh" },
    "a stale set-time does not resurrect the saved profile over a newer observed turn",
  )
})

test("resolveSessionProfile: a claude pick does not converge away, because there is nothing to converge on", () => {
  const LATEST = "2026-07-09T12:00:00.000Z"
  const EVEN_LATER = "2026-07-09T13:00:00.000Z"

  // Claude fixes model/effort at FORK time, so a live daemon keeps running what it was forked with and
  // every record it writes still reports the old model. Converging on those readings is what silently
  // reverted a just-made pick in the composer seconds after the click (2026-09-03) — the codex rule
  // above leaking onto a runtime whose next turn cannot honour the pick at all.
  assert.deepEqual(
    resolveSessionProfile(
      row({ backend: "claude", model: "opus", effort: "xhigh", spawned_at: T0, profile_set_at: LATEST }),
      tele({ model: "fable", effort: "xhigh", profileAt: EVEN_LATER }),
    ),
    { model: "opus", effort: "xhigh" },
    "a newer record from the daemon still running the old model cannot take the pick back",
  )

  // An UNLABELLED row is claude by the same `row.backend ?? "claude"` convention every other reader uses.
  assert.deepEqual(
    resolveSessionProfile(
      row({ model: "opus", effort: "xhigh", spawned_at: T0, profile_set_at: T0 }),
      tele({ model: "fable", effort: "high", profileAt: EVEN_LATER }),
    ),
    { model: "opus", effort: "xhigh" },
    "a migrated row with no backend is fenced as claude, not converged as codex",
  )

  // UNCHANGED where nobody chose: with no set-time the observation is the only reading there is, and it
  // still supplies a profile the row never pinned.
  assert.deepEqual(
    resolveSessionProfile(
      row({ backend: "claude", model: null, effort: null, spawned_at: T0 }),
      tele({ model: "fable", effort: "high", profileAt: LATEST }),
    ),
    { model: "fable", effort: "high" },
    "an unchosen claude profile is still filled in from what the transcript reports",
  )
})

test("resolveSessionPermission: exposes only a persisted valid per-thread mode; legacy/unknown stays unknown", () => {
  assert.equal(resolveSessionPermission(row({ permission_mode: "bypassPermissions" })), "bypassPermissions")
  assert.equal(resolveSessionPermission(row({ permission_mode: null })), undefined)
  assert.equal(resolveSessionPermission(row({ permission_mode: "future-mode" })), undefined)
  assert.equal(
    resolveSessionPermission(row({ backend: "codex", permission_mode: "acceptEdits" })),
    "default",
    "legacy Codex workspace-write aliases are normalized at the backend boundary",
  )
  assert.equal(
    resolveSessionPermission(row({ backend: "claude", permission_mode: "bypassPermissions" }), tele({ permissionMode: "auto" })),
    "bypassPermissions",
    "a pre-reattach in-memory fold cannot relabel the newly launched Claude process",
  )
  assert.equal(
    resolveSessionPermission(
      row({ backend: "codex", spawned_at: LATER, permission_mode: "bypassPermissions" }),
      tele({ permissionMode: "default", permissionModeAt: T0 }),
    ),
    "bypassPermissions",
    "an old Codex turn_context cannot overwrite the new -s launch mode",
  )
  assert.equal(
    resolveSessionPermission(
      row({ backend: "codex", spawned_at: T0, permission_mode: "default" }),
      tele({ permissionMode: "bypassPermissions", permissionModeAt: LATER }),
    ),
    "bypassPermissions",
    "a later backend-observed Codex transition wins",
  )
})

test("resolveSessionPermission: an eager operator sandbox change shows immediately, then converges to telemetry", () => {
  const LATEST = "2026-07-09T12:00:00.000Z"
  const EVEN_LATER = "2026-07-09T13:00:00.000Z"

  // THE FIX: the operator flipped the sandbox at LATEST — AFTER the last observed turn_context (LATER,
  // still reporting the OLD value). The pill must show the operator's just-saved intent, not the stale
  // observed reading, instead of lagging a full turn.
  assert.equal(
    resolveSessionPermission(
      row({ backend: "codex", spawned_at: T0, permission_mode: "bypassPermissions", permission_set_at: LATEST }),
      tele({ permissionMode: "default", permissionModeAt: LATER }),
    ),
    "bypassPermissions",
    "a just-set operator sandbox outranks an older observed turn_context",
  )

  // CONVERGENCE: once a genuinely newer turn emits a fresh turn_context (EVEN_LATER > LATEST), the
  // observed value is authoritative again — the display converges, it does not diverge forever.
  assert.equal(
    resolveSessionPermission(
      row({ backend: "codex", spawned_at: T0, permission_mode: "bypassPermissions", permission_set_at: LATEST }),
      tele({ permissionMode: "bypassPermissions", permissionModeAt: EVEN_LATER }),
    ),
    "bypassPermissions",
    "a newer turn re-establishes observed authority",
  )

  // NO REGRESSION: an OLD operator set-time (before the observed reading) must NOT override a fresh
  // turn — this is the reattach/idle case the observed-wins rule exists for.
  assert.equal(
    resolveSessionPermission(
      row({ backend: "codex", spawned_at: T0, permission_mode: "default", permission_set_at: T0 }),
      tele({ permissionMode: "bypassPermissions", permissionModeAt: LATER }),
    ),
    "bypassPermissions",
    "a stale set-time does not resurrect the saved value over a newer observed turn",
  )

  // CLAUDE UNAFFECTED: the set-time logic lives entirely inside the codex branch; Claude's telemetry
  // stays authoritative-and-timely and its rules are unchanged even with a set-time present.
  assert.equal(
    resolveSessionPermission(
      row({ backend: "claude", spawned_at: T0, permission_mode: "auto", permission_set_at: LATEST }),
      tele({ permissionMode: "acceptEdits", permissionModeAt: LATER }),
    ),
    "auto",
    "the durable saved Claude value wins regardless of set-time (Claude path untouched)",
  )
})

test("resolveSessionTitle: a human title suppresses stale transcript names; generated fallbacks may use them", () => {
  assert.deepEqual(
    resolveSessionTitle(row({ title: "Human-readable thread title", title_auto: 0, title_locked: 1 }), tele({ aiTitle: "generated-slug" })),
    { title: "Human-readable thread title", titleAuto: false, titleLocked: true, aiTitle: undefined },
  )
  assert.deepEqual(
    resolveSessionTitle(row({ title: "generated-slug", title_auto: 1 }), tele({ aiTitle: "Useful backend title" })),
    { title: "generated-slug", titleAuto: true, titleLocked: false, aiTitle: "Useful backend title" },
  )
  assert.deepEqual(
    resolveSessionTitle(
      row({ title: "Original fallback", title_auto: 1 }),
      tele({ customTitle: "rejected-native-slug", customTitleRevision: 1 }),
    ),
    { title: "Original fallback", titleAuto: true, titleLocked: false, aiTitle: undefined },
    "an unconfirmed custom-title cannot reach board display/notification or paired-file sync",
  )
  // The point of the split: a title a dispatch CALLER hard-coded reads as a real name (titleAuto false,
  // so no "Spinning up…"/"Untitled" placeholder) yet still carries the worker's aiTitle on the wire.
  assert.deepEqual(
    resolveSessionTitle(row({ title: "Investigate acme/app#391", title_auto: 0, title_locked: 0 }), tele({ aiTitle: "Cache key collides on normalized ids" })),
    { title: "Investigate acme/app#391", titleAuto: false, titleLocked: false, aiTitle: "Cache key collides on normalized ids" },
  )
  // A row written before the split has no title_locked at all. Its non-guessed title must keep reading
  // as the human's, or every legacy rename would silently reopen to backend telemetry.
  assert.deepEqual(
    resolveSessionTitle(row({ title: "Legacy renamed thread", title_auto: 0 }), tele({ aiTitle: "generated-slug" })),
    { title: "Legacy renamed thread", titleAuto: false, titleLocked: true, aiTitle: undefined },
  )
})

test("resolveSessionTitle: a PERSISTED worker title survives the loss of its telemetry", () => {
  // The whole point of title_agent. Telemetry only exists while a session is tailed, so a rested,
  // archived or post-restart codex thread arrives with `tele` empty — and with no aiTitle on the wire
  // the display side cannot tell the worker's own name from the dispatch chop, so it showed "Untitled
  // thread" for every one of them (maintainer 2026-08-07).
  assert.deepEqual(
    resolveSessionTitle(row({ title: "Build minimal tool renderer", title_auto: 1, title_locked: 0, title_agent: 1 }), undefined),
    { title: "Build minimal tool renderer", titleAuto: true, titleLocked: false, aiTitle: "Build minimal tool renderer" },
  )
  // Without the flag the same row IS just its chop, and must stay unnamed rather than exposing it.
  assert.deepEqual(
    resolveSessionTitle(row({ title: "i want to start working", title_auto: 1, title_locked: 0, title_agent: 0 }), undefined),
    { title: "i want to start working", titleAuto: true, titleLocked: false, aiTitle: undefined },
  )
  // THE REGISTRY COPY OUTRANKS TELEMETRY. This assertion read the other way ("live telemetry is the
  // FRESHER of the two") until `mcp__frizz__title` existed, and freshness was the right tiebreak only
  // while the two could not disagree: the persisted copy was written FROM telemetry on the same fold
  // tick, so it was byte-identical or absent. A worker registering its own name breaks the tie for
  // real — the row now holds the name it chose after reading the task, and the wire still holds the
  // spawn-time guess it is correcting, which must not win.
  assert.deepEqual(
    resolveSessionTitle(row({ title: "Named after reading the issue", title_auto: 1, title_locked: 0, title_agent: 1 }), tele({ aiTitle: "Spawn-time guess" })),
    { title: "Named after reading the issue", titleAuto: true, titleLocked: false, aiTitle: "Named after reading the issue" },
  )
  // Telemetry still covers the row the CAS never reached: no flag, so nothing persisted to prefer.
  assert.deepEqual(
    resolveSessionTitle(row({ title: "i want to start working", title_auto: 1, title_locked: 0, title_agent: 0 }), tele({ aiTitle: "Live worker name" })),
    { title: "i want to start working", titleAuto: true, titleLocked: false, aiTitle: "Live worker name" },
  )
  // A human's name still outranks both, exactly as it does the live one.
  assert.deepEqual(
    resolveSessionTitle(row({ title: "Named by hand", title_auto: 0, title_locked: 1, title_agent: 1 }), undefined),
    { title: "Named by hand", titleAuto: false, titleLocked: true, aiTitle: undefined },
  )
})

test("deriveNeedsYou: a perm-prompt process block always queues (a view can't clear it)", () => {
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ lastActivityAt: T0 }), "perm-prompt"), true)
})

test("deriveNeedsYou: a native pendingAsk always queues, even if seen", () => {
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ pendingAsk: { id: "x", questions: [] }, lastActivityAt: T0 }), "turn-idle"), true)
})

test("deriveNeedsYou: a scoped typed interaction queues immediately, independent of turn state", () => {
  assert.equal(deriveNeedsYou(row(), tele({ turn: "in-flight" }), "running", true), true)
  assert.equal(deriveNeedsYou(row(), tele({ turn: "idle" }), "turn-idle", true), true)
  assert.equal(deriveNeedsYou(row(), tele({ turn: "idle" }), "exited", true), true)
  assert.equal(deriveNeedsYou(row(), tele({ turn: "in-flight" }), "running", false), false)
})

// A delivered-but-unobserved human follow-up (delivery ledger pending/enqueued) means the human just
// responded, so the thread must leave the queue from SERVER TRUTH — this is what stops a steered card
// bouncing back when the client's 12s optimism expires before the tailer catches up under load.
const ledger = (state: "pending" | "enqueued" | "unconfirmed") =>
  JSON.stringify([{ id: "d1", text: "keep going", state, at: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() }])

test("deriveNeedsYou: a fresh delivered follow-up dequeues a question the tailer has not yet cleared", () => {
  const asking = tele({ pendingQuestion: true, lastActivityAt: T0 })
  assert.equal(deriveNeedsYou(row(), asking, "turn-idle"), true, "baseline: an unanswered question queues")
  assert.equal(deriveNeedsYou(row({ delivery_ledger: ledger("pending") }), asking, "turn-idle"), false, "a pending delivery is the human's answer")
  assert.equal(deriveNeedsYou(row({ delivery_ledger: ledger("enqueued") }), asking, "turn-idle"), false, "Claude Code's own queue holds it")
})

test("deriveNeedsYou: an UNCONFIRMED delivery does not dequeue — the human may need to re-drive it", () => {
  assert.equal(deriveNeedsYou(row({ delivery_ledger: ledger("unconfirmed") }), tele({ pendingQuestion: true }), "turn-idle"), true)
})

// The suppression above is a claim that some PROCESS is holding the message. When the broker daemon
// that receipted it has died, nothing holds it: the row ages out only after UNCONFIRMED_DROP_MS, so
// without this the thread spends an hour excused from the queue over a message that will never be
// read. Observed 2026-08-11 on `in-codex-threads-tool-calls-ike` — a follow-up receipted at
// 19:45:05.771, the daemon dead 760ms later, and the ```done card that was already in the queue gone
// with it.
test("deriveNeedsYou: a dead daemon's outstanding delivery stops excusing the thread from the queue", () => {
  const done = tele({ lastFence: { kind: "done", body: "landed", hints: [] } })
  for (const state of ["pending", "enqueued"] as const) {
    const withSend = row({ delivery_ledger: ledger(state) })
    assert.equal(
      deriveNeedsYou(withSend, done, "turn-idle", false, Date.parse(T0), undefined, true, false),
      false,
      `${state}: a live daemon is holding it, so the thread stays out of the queue`,
    )
    assert.equal(
      deriveNeedsYou(withSend, done, "turn-idle", false, Date.parse(T0), undefined, true, true),
      true,
      `${state}: the daemon is gone, so the done card comes back`,
    )
  }
})

test("deriveNeedsYou: a fresh delivery never hides a crash or a hard live ask", () => {
  // A follow-up delivered to a worker that then died mid-turn is still a stall the human must see.
  assert.equal(deriveNeedsYou(row({ delivery_ledger: ledger("pending") }), tele({ turn: "in-flight" }), "exited"), true)
  // A native pendingAsk outranks a delivery (the gate sits above it) — the ask is a different channel.
  assert.equal(deriveNeedsYou(row({ delivery_ledger: ledger("pending") }), tele({ pendingAsk: { id: "x", questions: [] } }), "turn-idle"), true)
})

test("board interaction presence cache follows the exact session and rechecks after terminal edges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-interactions-"))
  const project: Project = {
    dir,
    id: "project-board",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession(row({ slug: "typed", session_id: "session-a", thread_name: "frizz-typed" }))
  const tailer = {
    get: () => undefined,
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "test-boot")
  const unsubscribe = storage.interactions.subscribe((change) => board.interactionChanged?.(change))
  const request = (providerRequestId: string, sessionId = "session-a"): InteractionRequest => ({
    protocolVersion: 1,
    contentFormat: "plain-text",
    provider: { kind: "frizz" },
    source: { kind: "frizz", id: "board-test" },
    owner: {
      projectId: project.id,
      threadSlug: "typed",
      sessionId,
      turnId: "turn",
      itemId: providerRequestId,
      sessionEpoch: 1,
      capabilityRevision: 1,
    },
    providerRequestId,
    allowedDecisions: [{ id: "accept", semantic: "approve", label: "provider label" }],
    payload: {
      kind: "command-approval",
      title: "Command",
      command: { summary: "Test", preview: "pnpm test", redacted: true },
    },
    expiresAt: null,
  })
  const current = () => board.refresh().threads.find((thread) => thread.id === "typed")!

  try {
    assert.equal(current().pendingInteraction, false)
    assert.equal(current().actionableInteraction, false)
    const first = storage.interactions.create(request("first")).interaction
    const second = storage.interactions.create(request("second")).interaction
    assert.equal(current().pendingInteraction, true)
    assert.equal(current().actionableInteraction, true)
    assert.equal(current().needsYou, true)

    const scope = { projectId: project.id, threadSlug: "typed", sessionId: "session-a" }
    storage.interactions.resolve(scope, {
      slug: "typed",
      sessionId: "session-a",
      interactionId: first.id,
      sessionEpoch: 1,
      capabilityRevision: 1,
      expectedRecordRevision: 0,
      responseId: "response-first",
      decisionId: "accept",
    })
    assert.equal(current().pendingInteraction, true, "one terminal edge must recheck for a sibling request")
    assert.equal(current().actionableInteraction, true)
    storage.interactions.resolve(scope, {
      slug: "typed",
      sessionId: "session-a",
      interactionId: second.id,
      sessionEpoch: 1,
      capabilityRevision: 1,
      expectedRecordRevision: 0,
      responseId: "response-second",
      decisionId: "accept",
    })
    assert.equal(current().pendingInteraction, false)
    assert.equal(current().actionableInteraction, false)

    storage.interactions.create(request("old-session-request")).interaction
    assert.equal(current().pendingInteraction, true)
    assert.equal(current().actionableInteraction, true)
    storage.upsertSession(row({ slug: "typed", session_id: "session-b", thread_name: "frizz-typed" }))
    assert.equal(current().pendingInteraction, false, "a replacement session cannot inherit the old journal scope")
    assert.equal(current().actionableInteraction, false, "a replacement session cannot inherit the old actionability bit")
  } finally {
    unsubscribe()
    await Promise.resolve()
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("board keeps provider delivery visible while ordinary resting-thread queue membership survives response delivery and restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-provider-delivery-"))
  const project: Project = {
    dir,
    id: "project-provider-board",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const tailer = {
    get: () => undefined,
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const dbPath = join(dir, "ui.db")
  let storage = createStorage(dbPath, "p")
  storage.upsertSession(row({ slug: "provider", session_id: "provider-session", thread_name: "frizz-provider" }))
  let board = createBoard(project, storage, new Bus(), tailer, "provider-boot-1")
  let unsubscribe = storage.interactions.subscribe((change) => board.interactionChanged?.(change))
  const request: InteractionRequest = {
    protocolVersion: 1,
    contentFormat: "plain-text",
    provider: { kind: "codex" },
    source: { kind: "runtime", id: "provider-runtime" },
    owner: {
      projectId: project.id,
      threadSlug: "provider",
      sessionId: "provider-session",
      turnId: "turn",
      itemId: "item",
      sessionEpoch: 1,
      capabilityRevision: 1,
    },
    providerRequestId: "provider-board-request",
    allowedDecisions: [{ id: "accept", semantic: "approve", label: "provider label" }],
    payload: {
      kind: "command-approval",
      title: "Command",
      command: { summary: "Test", preview: "pnpm test", redacted: true },
    },
    expiresAt: null,
  }
  const scope = { projectId: project.id, threadSlug: "provider", sessionId: "provider-session" }
  const current = () => board.refresh().threads.find((thread) => thread.id === "provider")!

  try {
    const pending = storage.interactions.createProviderRequest(request, {
      provider: "codex-app-server",
      logicalRequestId: "provider-board-logical",
      method: "item/commandExecution/requestApproval",
      connectionEpoch: 1,
      rpcRequestId: "provider-board-rpc",
    }).interaction
    assert.equal(current().pendingInteraction, true)
    assert.equal(current().actionableInteraction, true)
    assert.equal(current().needsYou, true)

    storage.interactions.queueProviderResponse(scope, {
      slug: "provider",
      sessionId: "provider-session",
      interactionId: pending.id,
      sessionEpoch: 1,
      capabilityRevision: 1,
      expectedRecordRevision: 0,
      responseId: "provider-board-response",
      decisionId: "accept",
    }, { decision: "accept" })
    assert.equal(current().pendingInteraction, true, "queued delivery stays readable in the thread")
    assert.equal(current().actionableInteraction, false, "the human already answered; only provider delivery remains")
    assert.equal(current().needsYou, true, "delivery is no longer a hard interaction, but the owned worker is still at rest")

    storage.interactions.claimProviderResponseForSend(pending.id, 1, "provider-board-rpc")
    assert.equal(current().pendingInteraction, true)
    assert.equal(current().actionableInteraction, false, "sent-but-unacknowledged provider delivery is not actionable")
    assert.equal(current().needsYou, true, "the ambiguous send boundary does not hide an otherwise-resting thread")

    unsubscribe()
    await board.stop()
    storage.close()
    storage = createStorage(dbPath, "p")
    board = createBoard(project, storage, new Bus(), tailer, "provider-boot-2")
    unsubscribe = storage.interactions.subscribe((change) => board.interactionChanged?.(change))
    assert.equal(current().pendingInteraction, true)
    assert.equal(current().actionableInteraction, false, "restart re-derives provider delivery separately from actionability")
    assert.equal(current().needsYou, true, "a fresh process re-derives ordinary rest from durable session ownership")

    storage.interactions.acknowledgeProviderResponse(
      "codex-app-server",
      1,
      "provider-board-rpc",
      scope,
    )
    assert.equal(current().pendingInteraction, false)
    assert.equal(current().actionableInteraction, false)
    assert.equal(current().needsYou, true)
  } finally {
    unsubscribe()
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("deriveNeedsYou: an unanswered ```question at rest queues EVEN IF SEEN (viewing ≠ answering)", () => {
  // THE regression: seen_at newer than the last activity must NOT drop a pending question off the stack.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ pendingQuestion: true, lastActivityAt: T0 }), "turn-idle"), true)
  // Also queues on an exited (crashed/ended) pane that left a question, seen or not.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ pendingQuestion: true, lastActivityAt: T0 }), "exited"), true)
})

test("deriveNeedsYou: a ```question MID-TURN does not queue (ask text hasn't landed)", () => {
  assert.equal(deriveNeedsYou(row(), tele({ pendingQuestion: true, lastActivityAt: LATER }), "running"), false)
  assert.equal(deriveNeedsYou(row(), tele({ pendingQuestion: true }), "spawning"), false)
})

test("deriveNeedsYou: a checked ```done fence at rest queues until archived, even if seen", () => {
  const done = tele({ lastFence: { kind: "done", body: "shipped", hints: [] }, lastActivityAt: LATER })
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), done, "turn-idle"), true)
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), done, "exited"), true)
  // A stale final fence never queues during a newer in-flight turn.
  assert.equal(deriveNeedsYou(row({ seen_at: T0 }), done, "running"), false)
})

// THIS TEST USED TO PIN THE OPPOSITE, and the inversion is the point. A `human: Alice must approve`
// line and a future `timer: <instant>` each took a thread OUT of the operator queue on the worker's
// word alone. Nothing ever fired a human gate, and one timer was published 5h55m in the PAST — it
// parsed, armed nothing, and parked its thread for 5.5 hours. Both kinds are deleted (2026-08-15).
// A fence now has to NAME something frizz can find, and neither of these does.
test("deriveNeedsYou: an unverifiable awaiting fence does NOT leave the operator queue", () => {
  const noSuchShell = tele({ lastFence: { kind: "awaiting", body: "", hints: [{ kind: "shell", value: "Alice must approve" }] }, lastActivityAt: LATER })
  const noSuchTimer = tele({ lastFence: { kind: "awaiting", body: "", hints: [{ kind: "timer", value: "tmr_nosuchtimer" }] }, lastActivityAt: LATER })
  assert.equal(deriveNeedsYou(row({ seen_at: T0 }), noSuchShell, "turn-idle"), true, "a shell name matching nothing live is not a park")
  assert.equal(deriveNeedsYou(row({ seen_at: T0 }), noSuchTimer, "turn-idle"), true, "a timer id matching no armed row is not a park")
  // …and a pending QUESTION still outranks any fence, parked or not.
  const both = tele({ pendingQuestion: true, lastFence: { kind: "awaiting", body: "", hints: [{ kind: "shell", value: "Alice must approve" }] } })
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), both, "turn-idle"), true)
})

test("deriveNeedsYou: every owned bare rest queues; a live SUB-AGENT excuses it, a background shell does not", () => {
  assert.equal(deriveNeedsYou(row({ seen_at: null, last_read_at: null }), tele({ lastActivityAt: LATER }), "turn-idle"), true)
  assert.equal(deriveNeedsYou(row({ seen_at: T0 }), tele({ lastActivityAt: LATER }), "turn-idle"), true, "viewing cannot clear rest")
  assert.equal(deriveNeedsYou(row({ seen_at: null }), tele({ turn: "idle", lastActivityAt: LATER }), "exited"), true)
  // A rested turn with a live dispatched SUB-AGENT is EXCUSED from the queue (maintainer 2026-07-30):
  // it is awaiting its own child, not the human, and queueing it dropped its rail row out of the Active
  // running band and back again on the child's return. It re-queues on its own once the child is done.
  assert.equal(deriveNeedsYou(row({ seen_at: null, rested_at: T0 }), tele({ subAgents: [{ label: "c", startedAt: T0, state: "running", id: "a1" }], lastActivityAt: LATER }), "turn-idle"), false)
  // The excusal is bounded by the tailer's staleness ceiling: only "running" holds, so a child whose
  // completion signal was lost stops excusing its parent rather than burying it.
  assert.equal(deriveNeedsYou(row({ seen_at: null, rested_at: T0 }), tele({ subAgents: [{ label: "c", startedAt: T0, state: "stale", id: "a1" }], lastActivityAt: LATER }), "turn-idle"), true, "a stale child no longer excuses")
  // A live background SHELL does NOT excuse the rest (maintainer 2026-08-04: "if a thread has rested and
  // the only thing remaining is background shells, we should put it into the queue"). Shells were briefly
  // excused on the sub-agent's terms (2026-08-01) and this is the reversal: a detached shell — 26% of
  // real launches are servers that never exit, and there is no staleness clock to bound the excusal —
  // leaves a thread that has finished its turn in every sense the operator cares about, so it is a
  // handoff and it queues. What answers the layout-shift worry instead is the card's own Snooze.
  assert.equal(deriveNeedsYou(row({ rested_at: T0 }), tele({ bgShells: [{ label: "watch", startedAt: T0, state: "running" }] }), "turn-idle"), true)
  // A live child ALONGSIDE the shell still excuses: "the only thing remaining is background shells" is
  // the whole condition, and the sub-agent is the stronger fact (it will return and re-invoke the parent).
  assert.equal(
    deriveNeedsYou(row({ rested_at: T0 }), tele({ subAgents: [{ label: "c", startedAt: T0, state: "running", id: "a1" }], bgShells: [{ label: "watch", startedAt: T0, state: "running" }] }), "turn-idle"),
    false,
    "a live child outranks the shell beside it",
  )
  // Nothing live behind it at all is the same ordinary bare rest. A finished shell does not linger in a
  // terminal state here: tailer.bgShellViews drops it from the list entirely (and empties the list
  // outright on pane death), so "the shell ended" IS the empty list.
  assert.equal(deriveNeedsYou(row({ rested_at: T0 }), tele({ bgShells: [] }), "turn-idle"), true)
})

test("deriveNeedsYou: a live sub-agent excuses the rest only while the worker declared NO fence", () => {
  const child = [{ label: "c", startedAt: T0, state: "running" as const, id: "a1" }]
  // A ```done handoff still cards as done — the worker's completion signal outranks the excusal.
  assert.equal(deriveNeedsYou(row({ rested_at: T0 }), tele({ subAgents: child, lastFence: { kind: "done", body: "", hints: [] }, lastActivityAt: LATER }), "turn-idle"), true, "done fence still queues")
  // A non-parked ```awaiting — pr-watch above all — stays a VISIBLE queue handoff even with a child out
  // (maintainer 2026-07-24), so a PR watcher can never vanish because a sub-agent happens to be running.
  const prWatch = { kind: "awaiting" as const, body: "", hints: [{ kind: "pr" as const, value: "acme/app#1" }] }
  assert.equal(deriveNeedsYou(row({ rested_at: T0 }), tele({ subAgents: child, lastFence: prWatch, lastActivityAt: LATER }), "turn-idle"), true, "pr-watch still queues")
  // A fence naming a shell nothing matches is NOT a park either, so the live child does not rescue it:
  // an unverifiable declaration queues however much work the thread has out (2026-08-15).
  const unverifiable = { kind: "awaiting" as const, body: "", hints: [{ kind: "shell" as const, value: "Alice must approve" }] }
  assert.equal(deriveNeedsYou(row({ rested_at: T0 }), tele({ subAgents: child, lastFence: unverifiable, lastActivityAt: LATER }), "turn-idle"), true)
})

// THE EVENT-SNOOZE, WHICH THE SHELL-ONLY REST PUT BACK IN REACH. It hides the awaiting-background QUEUE
// CARD until the parent comes to a NEW rest — the exact promise the button's caption makes to the human
// (maintainer 2026-08-04: "remove the item from the queue until one of the background shells completes,
// in which case the agent will resume automatically"). It was stranded for three days while a shell-only
// rest had no queue card to snooze; the whole mechanism — RPC, column, branch — survived intact, which is
// why re-queueing shells needed nothing new.
test("deriveNeedsYou: the event-snooze parks a shell-only rest for exactly the current rest", () => {
  const shell = tele({ bgShells: [{ label: "watch", startedAt: T0, state: "running" }], lastActivityAt: LATER })
  assert.equal(deriveNeedsYou(row({ rested_at: T0 }), shell, "turn-idle"), true, "unsnoozed, a shell-only rest queues")
  assert.equal(deriveNeedsYou(row({ rested_at: T0, bg_snooze_rested_at: T0 }), shell, "turn-idle"), false, "snoozed for this rest")
  // THE SELF-CLEARING HALF, and it is the whole promise: rested_at only advances when the top-level turn
  // comes to a NEW rest, i.e. the shell finished, notified its worker and the worker acted on it. The
  // card is back in the queue at that exact moment, with no scheduler and no reaper.
  assert.equal(deriveNeedsYou(row({ rested_at: LATER, bg_snooze_rested_at: T0 }), shell, "turn-idle"), true, "a NEW rest re-surfaces the card")
  // A row with no rest instant at all cannot match a captured one, so an armed snooze cannot leak onto it.
  assert.equal(deriveNeedsYou(row({ rested_at: null, bg_snooze_rested_at: T0 }), shell, "turn-idle"), true)

  // The other branch bgSnoozeArmed governs: a non-done FENCE with live work of either kind. A fenced
  // thread is never excused, so it keeps its card — and an armed snooze still parks that card.
  const prWatch = { kind: "awaiting" as const, body: "", hints: [{ kind: "pr" as const, value: "acme/app#1" }] }
  const fenced = tele({ bgShells: [{ label: "watch", startedAt: T0, state: "running" }], lastFence: prWatch, lastActivityAt: LATER })
  assert.equal(deriveNeedsYou(row({ rested_at: T0 }), fenced, "turn-idle"), true, "a pr-watch handoff stays visible")
  assert.equal(deriveNeedsYou(row({ rested_at: T0, bg_snooze_rested_at: T0 }), fenced, "turn-idle"), false, "…unless snoozed for this exact rest")
})

test("deriveAwaitingBackground: true only when own-work rest is the SOLE reason for the card", () => {
  const child = tele({ subAgents: [{ label: "c", startedAt: T0, state: "running", id: "a1" }], lastActivityAt: LATER })
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), child, "turn-idle"), true)
  // A SHELL-ONLY REST NO LONGER QUALIFIES ON ITS OWN (2026-08-14). A shell is not necessarily work anyone
  // is waiting ON — a dev server, a log tail and a test run are the same row here — so an undeclared one
  // is not evidence of a wait, and this card spent months announcing a wait on dev servers nobody tore
  // down. It has to be DECLARED now: an ```awaiting fence naming the shell, checked against the live
  // ones (declared-park.test.ts).
  const shellOnly = tele({ bgShells: [{ label: "w", startedAt: T0, state: "running" }] })
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), shellOnly, "turn-idle"), false, "an undeclared shell is not a wait")
  const declaredShell = tele({
    bgShells: [{ label: "w", startedAt: T0, state: "running" }],
    lastAssistantAt: LATER,
    lastFence: { kind: "awaiting", body: "Waiting on the suite.", hints: [{ kind: "shell", value: "w" }] },
  })
  assert.equal(
    deriveAwaitingBackground(row({ rested_at: T0 }), declaredShell, "turn-idle", false, Date.parse(LATER) + 1000),
    true,
    "…and it does once the worker names the shell it is parked on",
  )
  // Any stronger reason renders its OWN card instead → not awaiting-background.
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), tele({ ...child, pendingQuestion: true }), "turn-idle"), false, "a question outranks it")
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), tele({ ...child, pendingAsk: { id: "x", questions: [] } }), "turn-idle"), false, "a native ask outranks it")
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), tele({ ...child, lastFence: { kind: "done", body: "", hints: [] } }), "turn-idle"), false, "a done fence outranks it")
  // A NON-pr-watch awaiting fence still outranks the banner: it renders its own titled card with its own
  // park control, so showing both would be the double-card this rule exists to prevent.
  const humanPark = tele({ ...child, lastFence: { kind: "awaiting", body: "", hints: [{ kind: "shell", value: "Alice" }] } })
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), humanPark, "turn-idle"), false, "an awaiting fence outranks it → no double-card")
  // A pr-watch PARK IS THE EXCEPTION (2026-08-13). Its fence card no longer offers a park action at all
  // (lib/awaitingPresentation), so this banner is the only place the wait is stated in words AND the only
  // place its snooze lives. Suppressing it would leave a titleless fence card with no control anywhere.
  // DECLARED AND REGISTERED, both (2026-08-26): the declaration alone stopped counting, matching the
  // timer park below and heldByRunningChecks — a `prs:` line with no watcher behind it produced a
  // resting card with NOTHING in it (a prs: entry adds no watch row), while the fence card hid.
  const registeredPr = new Set(["acme/app#1"])
  const prWatch = tele({ ...child, lastFence: { kind: "awaiting", body: "PR up.", hints: [{ kind: "pr", value: "acme/app#1" }] } })
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), prWatch, "turn-idle", false, Date.parse(LATER), undefined, false, {}, registeredPr), true, "the pr-watch park cards here now")
  assert.equal(deriveNeedsYou(row({ rested_at: T0 }), prWatch, "turn-idle"), true, "…and the thread still queues")
  // …and it qualifies on the WATCHER ALONE, with no sub-agent or shell out — which is the common shape.
  const watcherOnly = tele({ lastActivityAt: LATER, lastFence: { kind: "awaiting", body: "PR up.", hints: [{ kind: "pr", value: "acme/app#1" }] } })
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), watcherOnly, "turn-idle", false, Date.parse(LATER), undefined, false, {}, registeredPr), true, "a watcher is live own work")
  // A URL-form fence still matches its normalized registration — the same githubStatusKey read
  // unaccountedItems uses, so the board and the scheduler agree about one spelling.
  const urlForm = tele({ lastActivityAt: LATER, lastFence: { kind: "awaiting", body: "", hints: [{ kind: "pr", value: "https://github.com/acme/app/pull/1" }] } })
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), urlForm, "turn-idle", false, Date.parse(LATER), undefined, false, {}, registeredPr), true, "a URL names the same watcher")
  // Declared but NEVER REGISTERED → no watcher exists, nothing will wake it: not a wait, no card — the
  // thread is a bare rest whose fence card (with its ref links) states the handoff instead.
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), watcherOnly, "turn-idle", false, Date.parse(LATER)), false, "an unregistered declaration conjures no card")
  // An unparseable ref arms nothing, so it is not live work and must not conjure a card.
  const bogus = tele({ lastActivityAt: LATER, lastFence: { kind: "awaiting", body: "", hints: [{ kind: "pr", value: "the auth PR" }] } })
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), bogus, "turn-idle", false, Date.parse(LATER), undefined, false, {}, registeredPr), false, "no parseable ref, no watcher")
  // An EXITED parent with a 'running' child is a crash, not this card.
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), child, "exited"), false)
  // No live own work → not this card.
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0 }), tele({ lastActivityAt: LATER }), "turn-idle"), false)
  // A user WALL-CLOCK snooze is a park on the whole thread, not a queue-card verb → no card.
  assert.equal(deriveAwaitingBackground(row({ rested_at: T0, snoozed_until: LATER }), child, "turn-idle", false, Date.parse(T0)), false)
})

// The queue's event-Snooze must NOT blank the drawer / full-screen page. `awaitingBackground` states a
// FACT about the thread and drives all three surfaces; only the QUEUE honours the snooze, and it does so
// through needsYou (groups.ts `queued`). Inheriting it here meant one queue click left the drawer showing
// nothing at rest — the "reads as if the agent died" state this card exists to prevent.
// A TIMER PARK CARDS LIKE A PR PARK (maintainer 2026-08-24: the resting card "enumerates all of the
// pull requests and the background shells … I don't understand why timer isn't represented in the same
// way"). Until this, a timer-only park had NO resting card at all, so the fence card fell back to
// reading its machinery footer at the human — "a timer   for 2h".
test("deriveAwaitingBackground: a timer park cards, checked against the armed registry", () => {
  const timerPark = tele({ lastActivityAt: LATER, lastFence: { kind: "awaiting", body: "Holding for the hourly re-check.", hints: [{ kind: "timer", value: "tmr_1" }] } })
  assert.equal(
    deriveAwaitingBackground(row({ rested_at: T0 }), timerPark, "turn-idle", false, Date.parse(LATER), undefined, false, {}, new Set(), new Set(["tmr_1"])),
    true,
    "an armed timer park cards here, like a PR park",
  )
  // The declaration alone is not the wait: a fence naming a fired or cancelled timer describes a wake
  // that will never come, so it must not conjure a card — same rule as the unparseable PR ref above.
  assert.equal(
    deriveAwaitingBackground(row({ rested_at: T0 }), timerPark, "turn-idle", false, Date.parse(LATER), undefined, false, {}, new Set(), new Set()),
    false,
    "a dead timer is not a wait",
  )
  // …and the thread still QUEUES — a timer park is a visible handoff, never an auto-park.
  const armed = new Set(["tmr_1"])
  assert.equal(deriveNeedsYou(row({ rested_at: T0 }), timerPark, "turn-idle", false, Date.parse(LATER), undefined, true, false, {}, new Set(), armed), true, "the timer park still queues")
  // …and, queued like a PR park, it takes the resting card's event-Snooze like one: the click used to be
  // recorded and ignored, leaving the card in the queue with the fence card un-hidden above it
  // (2026-08-25). The snooze hides the QUEUE card only — the fact still cards.
  const snoozed = row({ rested_at: T0, bg_snooze_rested_at: T0 })
  assert.equal(deriveNeedsYou(snoozed, timerPark, "turn-idle", false, Date.parse(LATER), undefined, true, false, {}, new Set(), armed), false, "snoozed → out of the queue")
  assert.equal(deriveAwaitingBackground(snoozed, timerPark, "turn-idle", false, Date.parse(LATER), undefined, false, {}, new Set(), armed), true, "…but the card still states the wait")
  // A NEW rest re-surfaces it, and a dead timer is a bare rest, which the event-snooze never hides.
  assert.equal(deriveNeedsYou(row({ rested_at: LATER, bg_snooze_rested_at: T0 }), timerPark, "turn-idle", false, Date.parse(LATER), undefined, true, false, {}, new Set(), armed), true, "a new rest re-surfaces the card")
  assert.equal(deriveNeedsYou(snoozed, timerPark, "turn-idle", false, Date.parse(LATER), undefined, true, false, {}, new Set(), new Set()), true, "a dead timer is a bare rest — not snoozable")
})

test("deriveAwaitingBackground: the event-snooze hides the QUEUE card, never the fact", () => {
  const child = tele({ subAgents: [{ label: "c", startedAt: T0, state: "running", id: "a1" }], lastActivityAt: LATER })
  const shell = tele({ bgShells: [{ label: "Poll CI to terminal", startedAt: T0, state: "running" }], lastActivityAt: LATER })
  // The SHELL case now needs a declaration to card at all (see the note in the test above), so the
  // snooze's own invariant — it hides the QUEUE card, never the fact — is exercised on the two shapes
  // that still state a fact without one: a running sub-agent, and a declared park.
  const declared = tele({
    bgShells: [{ label: "Poll CI to terminal", startedAt: T0, state: "running" }],
    lastAssistantAt: LATER,
    lastFence: { kind: "awaiting", body: "Waiting on CI.", hints: [{ kind: "shell", value: "Poll CI to terminal" }] },
  })
  void shell
  for (const [what, t] of [["sub-agent", child], ["declared shell", declared]] as const) {
    const snoozed = row({ rested_at: T0, bg_snooze_rested_at: T0 })
    assert.equal(deriveNeedsYou(snoozed, t, "turn-idle"), false, `${what}: snoozed → out of the queue`)
    assert.equal(
      deriveAwaitingBackground(snoozed, t, "turn-idle", false, Date.parse(LATER) + 1000),
      true,
      `${what}: …but the card still states the rest`,
    )
  }
})

test("deriveNeedsYou: mid-turn never queues; once runtime reports rest the session is presented", () => {
  assert.equal(deriveNeedsYou(row(), tele({ lastActivityAt: LATER }), "running"), false)
  assert.equal(deriveNeedsYou(row(), tele({ lastActivityAt: LATER }), "spawning"), false)
  assert.equal(deriveNeedsYou(row(), tele({ lastActivityAt: undefined }), "turn-idle"), true)
})

test("deriveNeedsYou: crash net — pane EXITED while the turn was in-flight queues, even after a glance", () => {
  // Agent died mid tool_use (turn still in-flight) then the pane exited; you'd already viewed it
  // (seen_at newer than its last activity). Interaction-clearance must NOT bury a dead-mid-work agent.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ turn: "in-flight", lastActivityAt: T0 }), "exited"), true)
  // A cleanly-ended exited thread also queues, but without the crash presentation bit on ThreadView.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ turn: "idle", lastActivityAt: T0 }), "exited"), true)
})

test("deriveNeedsYou: an EXITED parent surfaces even when a SUB-AGENT still reads 'running' (crash mid-background-work)", () => {
  // A sub-agent cannot outlive its parent pane. A crashed/slept worker that rested on a sub-agent leaves
  // it "running" in telemetry (subAgentViews has no paneDead guard, unlike bgShellViews) until it goes
  // stale — or forever if its output file never resolved. The dead parent MUST still surface. This once
  // silently dangled: hasLiveBackgroundWork buried the exited row instead of queuing it (found 2026-07-21).
  const childRunning = tele({ subAgents: [{ label: "c", startedAt: T0, state: "running", id: "a1" }], lastActivityAt: LATER })
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), childRunning, "exited"), true, "dead parent w/ 'running' sub-agent surfaces")
  // The LIVE parent (turn-idle) resting on the same running child is EXCUSED from the queue and holds
  // its place in the rail's Active band; the `runtime !== "exited"` guard is exactly what keeps the
  // EXITED crash case above distinct from it, so a dead pane can never borrow that excusal.
  assert.equal(deriveNeedsYou(row({ seen_at: T0, rested_at: T0 }), childRunning, "turn-idle"), false)
  assert.equal(deriveAwaitingBackground(row({ seen_at: T0, rested_at: T0 }), childRunning, "turn-idle"), true)
  assert.equal(deriveAwaitingBackground(row({ seen_at: LATER }), childRunning, "exited"), false, "the exited crash is not an awaiting-background card")
  // A dead parent whose child has already gone STALE also surfaces — via bare rest, not the bgwork arm
  // (stale ≠ "running", so hasLiveBackgroundWork never buries it and it is not counted as live work).
  const childStale = tele({ subAgents: [{ label: "c", startedAt: T0, state: "stale", id: "a1" }], lastActivityAt: LATER })
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), childStale, "exited"), true, "dead parent w/ stale child surfaces via bare rest")
})

test("board: an EXITED parent resting on a 'running' sub-agent surfaces as a stalled crash, not buried", async () => {
  // End-to-end through board assembly: a dead worker (no live process → runtime 'exited') whose telemetry still
  // reports a running sub-agent must enter Queue (needsYou) AND card as a crash/stall (crashed), so the
  // human sees it instead of it silently dangling under stale child liveness.
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-crash-bgwork-"))
  const project: Project = { dir, id: "board-crash-bgwork", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession(row({ slug: "dead-parent", thread_name: "frizz-dead-parent", seen_at: LATER }))
  // Sibling with an already-STALE child: it must still surface, but as a bare rest, NOT a stalled crash.
  storage.upsertSession(row({ slug: "dead-parent-stale", thread_name: "frizz-dead-parent-stale", seen_at: LATER }))
  const tailer = {
    get: (slug: string) => tele({
      turn: "idle",
      subAgents: [{ label: "child", startedAt: T0, state: slug === "dead-parent-stale" ? "stale" : "running", id: "a1" }],
      lastActivityAt: LATER,
    }),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "crash-bgwork-boot")
  try {
    const snap = await board.snapshot()
    const running = snap.threads.find((candidate) => candidate.id === "dead-parent")!
    assert.equal(running.runtime, "exited", "no live pane derives to exited")
    assert.equal(running.needsYou, true, "the dead parent surfaces instead of being buried by stale child liveness")
    assert.equal(running.crashed, true, "a running sub-agent on a dead pane cards as a stall, not a bare rest")
    const stale = snap.threads.find((candidate) => candidate.id === "dead-parent-stale")!
    assert.equal(stale.needsYou, true, "a dead parent whose child went stale still surfaces")
    assert.equal(stale.crashed, false, "but a stale child is not live work, so it cards as bare rest")
  } finally {
    board.stop()
  }
})

test("board: native Codex failures settle a lagging rollout, converge without duplicates, and cannot replace recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-codex-error-"))
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession(row({ slug: "failed", session_id: "sid", thread_name: "frizz-failed" }))
  storage.setBackend("failed", "codex")
  storage.setCodexRuntime("failed", "app-server")
  const error = { message: "Request rejected", code: "cyber_policy", at: LATER }
  let current = tele({ turn: "in-flight", lastActivityAt: T0 })
  let live: { bridgeTurn: boolean; ownedSince: string; providerError: import("@frizz/shared").ProviderError } = { bridgeTurn: false, ownedSince: T0, providerError: error }
  const tailer = { get: () => current, foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {} } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "errors", { codexTurnLiveness: () => live })
  try {
    let thread = (await board.snapshot()).threads[0]!
    assert.equal(thread.runtime, "turn-idle")
    assert.equal(thread.crashed, false)
    assert.equal(thread.needsYou, true)
    assert.deepEqual(thread.providerError, error)
    const journalError = { ...error, at: T0 }
    current = tele({ providerError: journalError, apiFault: true, lastActivityAt: T0 })
    thread = board.refresh().threads[0]!
    assert.deepEqual(thread.providerError, journalError, "the journal timestamp wins when both channels describe the same error")
    current = tele({ lastActivityAt: "2026-07-10T00:00:00.000Z" })
    assert.equal(board.refresh().threads[0]!.providerError, undefined, "newer successful journal activity defeats a stale native failure")
    live = { ...live, bridgeTurn: true, providerError: { ...error, retrying: true } }
    current = tele({ turn: "in-flight", lastActivityAt: LATER })
    thread = board.refresh().threads[0]!
    assert.equal(thread.runtime, "running")
    assert.equal(thread.providerError?.retrying, true)
    assert.equal(thread.needsYou, false)
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("board: a codex app-server thread whose turn died with its app-server cards as a stall, not a spinner", async () => {
  // The live 2026-07-22 failure, end-to-end through board assembly: an app-server thread runs its turn
  // inside the shared codex daemon and has no process of its own to probe, so its runtime comes only
  // from the rollout — which froze mid-turn when the process died and therefore reads "in-flight" forever. The bridge's liveness answer is what makes the difference
  // between a thread that spins on `running` and never queues, and one the human actually sees.
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-appserver-stall-"))
  const project: Project = { dir, id: "board-appserver-stall", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  for (const slug of ["stalled", "driving", "mirrored"]) {
    storage.upsertSession(row({ slug, session_id: `${slug}-s`, thread_name: `frizz-${slug}`, seen_at: LATER }))
    storage.setBackend(slug, "codex")
    storage.setCodexRuntime(slug, "app-server")
  }
  const ownedSince = "2026-07-09T10:00:00.000Z"
  const tailer = {
    // Every one of them reads in-flight off the rollout — that is exactly why the rollout alone
    // cannot tell them apart.
    get: (slug: string) => tele({
      turn: "in-flight",
      lastActivityAt: slug === "mirrored" ? "2026-07-09T10:00:30.000Z" : "2026-07-09T09:59:00.000Z",
    }),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "appserver-stall-boot", {
    now: () => Date.parse(ownedSince) + 120_000,
    codexTurnLiveness: (slug) => ({ bridgeTurn: slug === "driving", ownedSince }),
  })
  try {
    const snap = await board.snapshot()
    const stalled = snap.threads.find((candidate) => candidate.id === "stalled")!
    assert.equal(stalled.runtime, "exited", "nobody is driving this turn")
    assert.equal(stalled.crashed, true, "it cards as a stall, not a bare rest")
    assert.equal(stalled.needsYou, true, "and it reaches the human instead of spinning invisibly")

    const driving = snap.threads.find((candidate) => candidate.id === "driving")!
    assert.equal(driving.runtime, "running", "the bridge is driving this turn right now")
    assert.equal(driving.needsYou, false)

    // An external `codex resume` in the operator's terminal keeps appending after frizz took the
    // thread: a real live turn frizz is mirroring, so it must not be declared dead.
    const mirrored = snap.threads.find((candidate) => candidate.id === "mirrored")!
    assert.equal(mirrored.runtime, "running")
    assert.equal(mirrored.needsYou, false)
  } finally {
    board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("deriveNeedsYou: manual snooze suppresses every queue reason until its exact deadline", () => {
  const now = Date.parse("2026-07-13T12:00:00.000Z")
  const snoozed = row({ snoozed_until: "2026-07-14T12:00:00.000Z" })
  assert.equal(deriveNeedsYou(snoozed, tele(), "turn-idle", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele({ lastFence: { kind: "done", body: "done", hints: [] } }), "turn-idle", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele({ pendingQuestion: true }), "turn-idle", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele({ pendingAsk: { id: "ask", questions: [] } }), "turn-idle", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele({ turn: "in-flight" }), "exited", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele(), "turn-idle", true, now), false, "typed interaction is parked too")
  assert.equal(deriveNeedsYou(snoozed, tele(), "perm-prompt", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele(), "turn-idle", false, Date.parse("2026-07-14T12:00:00.001Z")), true, "due snooze requeues")
})

// NOTHING A WORKER MERELY ASSERTS TAKES ITS THREAD OUT OF THE QUEUE ANY MORE (2026-08-15).
//
// This test used to pin the opposite: `human: Alice review` and a future `timer: <instant>` each
// excused a rest, on the worker's word alone. Both were ways to stall silently. Nothing ever fired a
// `human:` gate — it parked the thread in Snoozed and waited for the operator to notice. And a `timer:`
// was an absolute instant the worker computed: one was published 5h55m in the past, parsed fine, armed
// nothing, and left its thread parked for 5.5 hours with no wake possible.
//
// Both kinds are deleted. A park is now a STRUCTURAL declaration naming things frizz can look up
// (hasDeclaredBackgroundPark), so what this pins is that the assertions alone no longer buy anything.
test("deriveNeedsYou: an awaiting fence alone never excuses a rest — only a checkable park does", () => {
  const now = Date.parse("2026-07-13T12:00:00.000Z")
  const waiting = (kind: "shell" | "agent" | "timer" | "pr" | "for", value: string) =>
    tele({ lastFence: { kind: "awaiting", body: "", hints: [{ kind, value }] } })
  // Each of these NAMES something, but nothing in this thread's telemetry or registries backs it, so
  // none of them is a park and every one queues.
  for (const [kind, value] of [
    ["shell", "bnotrunning"],
    ["agent", "agent-that-finished"],
    ["timer", "tmr_nosuchtimer"],
    ["pr", "wpr_nosuchwatcher"],
  ] as [Parameters<typeof waiting>[0], string][]) {
    assert.equal(deriveNeedsYou(row(), waiting(kind, value), "turn-idle", false, now), true, `${kind} naming nothing live must queue`)
  }
  // A duration describes the park; on its own it names nothing to wait for. (`reason:` used to sit
  // beside it here and was retired with the 2026-08-24 YAML cutover — prose lives in the fence BODY now,
  // and a body has never been a wait either, which the empty-hints case below covers.)
  assert.equal(deriveNeedsYou(row(), waiting("for", "2h"), "turn-idle", false, now), true, "a bare for: is not a wait")
  assert.equal(
    deriveNeedsYou(row(), tele({ lastFence: { kind: "awaiting", body: "waiting on the build", hints: [] } }), "turn-idle", false, now),
    true,
    "prose is not a wait",
  )
  // An awaiting fence naming NOTHING is a worker claiming to wait with no way to be woken.
  assert.equal(deriveNeedsYou(row(), tele({ lastFence: { kind: "awaiting", body: "", hints: [] } }), "turn-idle", false, now), true)
})

test("board arms the exact durable snooze deadline, clears it, and requeues ordinary rest without browser activity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-snooze-wake-"))
  const project: Project = {
    dir,
    id: "project-snooze-wake",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const until = new Date(Date.now() + 120).toISOString()
  storage.upsertSession(row({
    slug: "snooze-wake",
    session_id: "snooze-session",
    thread_name: "frizz-snooze-wake",
    snoozed_until: until,
  }))
  const tailer = {
    get: () => tele({ turn: "idle", lastActivityAt: new Date().toISOString() }),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "snooze-wake-boot")
  try {
    await board.start()
    const first = (await board.snapshot()).threads.find((thread) => thread.id === "snooze-wake")!
    assert.equal(first.needsYou, false)
    assert.equal(first.snoozedUntil, until)
    const deadline = Date.now() + 1_500
    let woke = first
    while (Date.now() < deadline && !woke.needsYou) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      woke = (await board.snapshot()).threads.find((thread) => thread.id === "snooze-wake")!
    }
    assert.equal(woke.needsYou, true, "the otherwise-resting thread re-enters Queue at its deadline")
    assert.equal(woke.snoozedUntil, undefined)
    assert.equal(storage.getSession("snooze-wake")?.snoozed_until, null)
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("board immediately expires a snooze whose deadline passes between assembly and timer scheduling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-snooze-race-"))
  const base = Date.parse("2026-07-13T12:00:00.000Z")
  const until = new Date(base + 10).toISOString()
  let clockReads = 0
  const project: Project = {
    dir,
    id: "project-snooze-race",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession(row({
    slug: "snooze-race",
    session_id: "snooze-race-session",
    thread_name: "frizz-snooze-race",
    snoozed_until: until,
  }))
  const tailer = {
    get: () => tele({ turn: "idle", lastActivityAt: new Date(base).toISOString() }),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  // First read is the coherent assembly instant (deadline still future); the scheduler read crosses
  // it. Every later rebuild sees the crossed instant. No real timer or 15s reconcile is involved.
  const board = createBoard(project, storage, new Bus(), tailer, "snooze-race-boot", {
    now: () => clockReads++ === 0 ? base : base + 20,
  })
  try {
    await board.start()
    await Promise.resolve()
    const woke = (await board.snapshot()).threads.find((thread) => thread.id === "snooze-race")!
    assert.ok(clockReads >= 3, "deadline crossing queues a second assembly immediately")
    assert.equal(woke.needsYou, true)
    assert.equal(woke.snoozedUntil, undefined)
    assert.equal(storage.getSession("snooze-race")?.snoozed_until, null)
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- missing-transcript degraded runtime (session-transcript-drift) ----

test("degradeIfNoTranscript: only a live-pane spinner (running) downgrades to the stalled 'exited' affordance", () => {
  // The eternal-spinner case: a boot-failed worker whose pane still reads live → deriveRuntime = running.
  assert.equal(degradeIfNoTranscript("running", true), "exited")
  // A present transcript (noTranscript false/undefined) is NEVER downgraded — the normal path is untouched.
  assert.equal(degradeIfNoTranscript("running", false), "running")
  assert.equal(degradeIfNoTranscript("running", undefined), "running")
  // Every other runtime is left exactly as-is (a dead pane is already exited; idle/perm/none are real).
  for (const r of ["none", "turn-idle", "perm-prompt", "exited", "spawning"] as const) {
    assert.equal(degradeIfNoTranscript(r, true), r)
  }
})

// ---- the ask outranks the spinner (2026-08-24) ----
// THE INVARIANT, stated as a test: a row that owes the human an answer never reports motion. The chat
// draws its shimmer off exactly this value, and the rail bands off the `needsYou` that deriveNeedsYou
// grants only at rest — so one thread showed a live ```question card AND "Thinking…", in the Active
// rail, because a single re-invoking record had re-opened the turn.

test("degradeIfAwaitingAnswer: an open question downgrades the spinner, and nothing else", () => {
  assert.equal(degradeIfAwaitingAnswer("running", true), "turn-idle")
  assert.equal(degradeIfAwaitingAnswer("spawning", true), "turn-idle")
  // "turn-idle", never "exited": the process is alive and may well still be mid-turn. This says only
  // that the row must not PRESENT as motion while the human owes it an answer.
  assert.equal(degradeIfAwaitingAnswer("running", false), "running")
  assert.equal(degradeIfAwaitingAnswer("running", undefined), "running")
  // A harder reading of the same row wins: a stalled/dead worker stays stalled even with an ask on it.
  for (const r of ["none", "turn-idle", "perm-prompt", "exited"] as const) {
    assert.equal(degradeIfAwaitingAnswer(r, true), r)
  }
})

// The half deriveNeedsYou owns. Its rest-gate (`turn-idle`/`exited` only) is what kept an open ask out
// of the queue whenever anything re-opened the turn; with the runtime degraded above, the gate is
// satisfied by construction and the ask cards. Pinned here as a pair so neither half can drift back.
test("deriveNeedsYou: a degraded ask-row cards — the pair is what puts it in the queue", () => {
  const row = { slug: "t", session_id: "sid", thread_name: "frizz-t", spawned_at: "2026-08-24T00:00:00.000Z", last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: null, meta: null, seen_at: null, transcript_id: null } as never
  const tele = { turn: "in-flight", pendingQuestion: true } as never
  const nowMs = Date.parse("2026-08-24T00:10:00.000Z")
  assert.equal(deriveNeedsYou(row, tele, "running", false, nowMs), false, "un-degraded, the rest-gate swallows the ask — the state the maintainer saw")
  assert.equal(deriveNeedsYou(row, tele, degradeIfAwaitingAnswer("running", true), false, nowMs), true, "degraded, it cards")
})

// A broker claude thread whose agent never received its opening prompt writes ZERO transcript bytes,
// which the tailer flags noTranscript (with captureStall) once DISCOVERY_GRACE_MS passes. The board used
// to discard that flag for every headless row — a suppression whose stated reason is CODEX's alone
// (an app-server writes its rollout synchronously at thread/start, so "no transcript yet" is transient
// there). A broker row has no such guarantee, and the other broker stall probe (headlessStalled) only
// trips on a DEAD daemon — so a thread with a LIVE, idle daemon and no transcript spun `running`
// forever. Live on 2026-07-31 that was 29 minutes on `the-landlock-people-i-m-interested` before a human
// archived it by hand.
// A worker that RESTED holding live sub-agents, whose broker daemon then died. An Agent sub-agent is an
// IN-PROCESS child of the `claude` process (orphan-reaper.ts states this outright: "a worker's only
// OS-level agent process is its session root — Agent sub-agents are in-process"), so a dead daemon means
// those children are categorically gone. Yet the thread was invisible:
//   deriveRuntime's headless branch returns "turn-idle" for a rested row BEFORE consulting the daemon —
//   the stall probe only ever fired mid-turn. "turn-idle" then satisfied deriveNeedsYou's
//   `runtime !== "exited"` guard, hasLiveOwnWork saw the phantom child still reading "running", and the
//   thread was EXCUSED from the queue. `crashed` needs runtime === "exited", so it did not fire either.
// Neither queued nor carded: a worker whose children can never return, waiting forever for a wake that
// cannot come. This is the sub-agent twin of the background-shell phantom fixed in a24d5ec, and it is
// the worse of the two — a shell does not excuse a rest on its own, a sub-agent does.
test("a rested broker thread whose daemon died holding live sub-agents surfaces instead of vanishing", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-deaddaemon-"))
  const project: Project = { dir, id: "project-dd", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession(row({ slug: "orphaned", session_id: "sess-orphaned", thread_name: "frizz-orphaned", rested_at: T0 }))
  storage.setBackend("orphaned", "claude")
  storage.setClaudeRuntime("orphaned", "broker")

  // The worker's own turn ENDED cleanly (turn idle, no fence) with one child still tracked as running.
  const tailer = {
    get: () =>
      tele({
        turn: "idle",
        subAgents: [{ label: "Watch CI", startedAt: T0, state: "running", id: "toolu_a" }],
      }),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {},
    start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer

  const live = createBoard(project, storage, new Bus(), tailer, "dd-live", { claudeBrokerDaemonAlive: () => true })
  const healthy = live.refresh().threads.find((t) => t.id === "orphaned")!
  assert.equal(healthy.runtime, "turn-idle", "control: a LIVE daemon keeps the rested row idle")
  assert.equal(healthy.needsYou, false, "control: and its running child rightly excuses it from the queue")

  const dead = createBoard(project, storage, new Bus(), tailer, "dd-dead", { claudeBrokerDaemonAlive: () => false })
  const orphaned = dead.refresh().threads.find((t) => t.id === "orphaned")!
  assert.equal(orphaned.runtime, "exited", "a dead daemon holding work is a stall, not an idle rest")
  assert.equal(orphaned.needsYou, true, "so the thread reaches the human instead of being excused forever")
  assert.equal(orphaned.crashed, true, "and it cards as stalled — its children died with the process")

  // AND IT MUST NOT WEAR OFF. Measured against the real fold: a child whose owner died reads `running`
  // for SUBAGENT_STALE_MS and `stale` for ever after. Keying the stall on `running` alone therefore
  // carded this thread correctly for 15 minutes and then let it settle into an ordinary bare rest —
  // same lost work, no longer mentioned. `stale` is ambiguous only while the worker is alive; against a
  // dead daemon an unretired in-process child is simply lost.
  const stale = {
    get: () =>
      tele({
        turn: "idle",
        subAgents: [{ label: "Watch CI", startedAt: T0, state: "stale", id: "toolu_a" }],
      }),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {},
    start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer
  const later = createBoard(project, storage, new Bus(), stale, "dd-stale", { claudeBrokerDaemonAlive: () => false })
  const aged = later.refresh().threads.find((t) => t.id === "orphaned")!
  assert.equal(aged.runtime, "exited", "15 minutes on, the work is no less lost")
  assert.equal(aged.needsYou, true)
  assert.equal(aged.crashed, true, "the stall does not expire into a clean handoff")

  // The same stale child on a LIVE daemon stays ambiguous and must NOT card as a crash — that is the
  // reading hasLiveBackgroundWork is deliberately narrow for.
  const staleAlive = createBoard(project, storage, new Bus(), stale, "dd-stale-live", { claudeBrokerDaemonAlive: () => true })
  const ambiguous = staleAlive.refresh().threads.find((t) => t.id === "orphaned")!
  assert.equal(ambiguous.crashed, false, "a stale child of a LIVE worker is not evidence of a crash")

  storage.close()
  rmSync(dir, { recursive: true, force: true })
})

// A dead daemon with NOTHING outstanding is the ordinary resting state of every broker thread: the
// daemon exits (idle-timeout, or frizz stopping it) and the next prompt forks a successor. That must stay
// a clean `turn-idle` rest, or the fix above would card the entire board as crashed.
test("a rested broker thread whose daemon died with NO outstanding work stays an ordinary rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-quietdaemon-"))
  const project: Project = { dir, id: "project-qd", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession(row({ slug: "quiet", session_id: "sess-quiet", thread_name: "frizz-quiet", rested_at: T0 }))
  storage.setBackend("quiet", "claude")
  storage.setClaudeRuntime("quiet", "broker")

  const tailer = {
    get: () => tele({ turn: "idle" }),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {},
    start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "qd", { claudeBrokerDaemonAlive: () => false })
  const quiet = board.refresh().threads.find((t) => t.id === "quiet")!

  assert.equal(quiet.runtime, "turn-idle", "a finished thread whose daemon idled out is NOT a crash")
  assert.equal(quiet.crashed, false, "nothing was lost, so nothing to card")

  storage.close()
  rmSync(dir, { recursive: true, force: true })
})

// The plumbing, not just the predicate: the daemon probe the board already runs for `headlessStalled`
// has to reach the delivery gate, or a follow-up receipted by a daemon that then died keeps the
// thread's own ```done card out of the queue for the rest of UNCONFIRMED_DROP_MS.
test("a broker thread whose daemon died still holding a follow-up returns to the queue", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-deadsend-"))
  const project: Project = { dir, id: "project-ds", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession(row({ slug: "stranded", session_id: "sess-stranded", thread_name: "frizz-stranded", rested_at: T0 }))
  storage.setBackend("stranded", "claude")
  storage.setClaudeRuntime("stranded", "broker")
  storage.setDeliveryLedger("stranded", ledger("enqueued"))

  const tailer = {
    get: () => tele({ turn: "idle", lastFence: { kind: "done", body: "landed", hints: [] } }),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {},
    start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer

  const live = createBoard(project, storage, new Bus(), tailer, "ds-live", { claudeBrokerDaemonAlive: () => true })
  assert.equal(live.refresh().threads.find((t) => t.id === "stranded")!.needsYou, false, "a live daemon really is holding it")

  const dead = createBoard(project, storage, new Bus(), tailer, "ds-dead", { claudeBrokerDaemonAlive: () => false })
  assert.equal(dead.refresh().threads.find((t) => t.id === "stranded")!.needsYou, true, "a dead daemon holds nothing — the done card is owed to the human")

  storage.close()
  rmSync(dir, { recursive: true, force: true })
})

test("a broker claude thread with no transcript reads as stalled, while a codex app-server thread does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-notranscript-"))
  const project: Project = { dir, id: "project-nt", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession(row({ slug: "broker", session_id: "sess-broker", thread_name: "frizz-broker" }))
  storage.setBackend("broker", "claude")
  storage.setClaudeRuntime("broker", "broker")
  storage.upsertSession(row({ slug: "codex", session_id: "sess-codex", thread_name: "frizz-codex" }))
  storage.setBackend("codex", "codex")
  storage.setCodexRuntime("codex", "app-server")

  // Both are mid-turn with no transcript — the identical telemetry the tailer produces for a boot
  // failure. Only the runtime kind may distinguish them.
  const tailer = {
    get: () => tele({ turn: "in-flight", noTranscript: true }),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {},
    start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "notranscript-boot")
  const threads = board.refresh().threads
  const broker = threads.find((t) => t.id === "broker")!
  const codex = threads.find((t) => t.id === "codex")!

  assert.equal(broker.runtime, "exited", "the broker thread surfaces the stall instead of spinning `running`")
  assert.notEqual(codex.runtime, "exited", "a codex app-server thread keeps its transient-rollout grace")
  storage.close()
  rmSync(dir, { recursive: true, force: true })
})

// ---- codex app-server stall detection (four threads spun on `running` for hours, 2026-07-22) ----

test("appServerTurnStalled: only a turn nobody is driving, and only once the read-skew grace has passed", () => {
  const owned = "2026-07-09T10:00:00.000Z"
  const ownedMs = Date.parse(owned)
  const wellPast = ownedMs + 120_000
  // The live incident: the app-server died mid-turn, so the rollout froze BEFORE frizz last took the
  // thread and nothing has advanced it since. That is a stall.
  assert.equal(appServerTurnStalled({ bridgeTurn: false, ownedSince: owned }, "2026-07-09T09:59:00.000Z", wellPast), true)
  // A rollout with no activity at all behaves the same — there is nothing to argue it is alive.
  assert.equal(appServerTurnStalled({ bridgeTurn: false, ownedSince: owned }, undefined, wellPast), true)
  // The bridge is driving a turn right now: never stalled, however quiet the rollout is (a long tool
  // call legitimately writes nothing for minutes).
  assert.equal(appServerTurnStalled({ bridgeTurn: true, ownedSince: owned }, undefined, wellPast), false)
  // Someone else is driving it — a `codex resume` in the operator's own terminal keeps appending after
  // frizz took the thread. frizz is mirroring a genuinely live turn; leave it running.
  assert.equal(appServerTurnStalled({ bridgeTurn: false, ownedSince: owned }, "2026-07-09T10:00:30.000Z", wellPast), false)
  // Read skew at the end of a normal turn: the bridge has cleared its turn but the rollout's matching
  // record has not reached the tailer yet. The grace makes that flash impossible.
  assert.equal(appServerTurnStalled({ bridgeTurn: false, ownedSince: owned }, undefined, ownedMs + 1_000), false)
  // Not bridge-owned (no binding, or a non-codex row): the board has no standing to call it dead.
  assert.equal(appServerTurnStalled(undefined, undefined, wellPast), false)
  assert.equal(appServerTurnStalled({ bridgeTurn: false, ownedSince: "not-a-date" }, undefined, wellPast), false)
})

test("deriveNeedsYou: a stalled app-server turn queues via the crash-net rather than spinning forever", () => {
  // deriveRuntime maps a stalled app-server turn onto "exited"; paired with the in-flight turn the
  // frozen rollout keeps, that is exactly the crash-net pair — so the thread cards for the human.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ turn: "in-flight" }), "exited"), true)
  // While it is genuinely running it must stay OUT of the queue (not at rest).
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ turn: "in-flight" }), "running"), false)
})

test("deriveNeedsYou: a missing-transcript row cards — degraded to exited, its turn stays in-flight (crash-net)", () => {
  // The tailer keeps a transcript-less session's turn "in-flight" (no records → in-flight); the board
  // degrades its runtime to "exited" (degradeIfNoTranscript). That pair trips the crash-net → it queues,
  // so a boot-failed worker surfaces to the human instead of spinning silently forever.
  const runtime = degradeIfNoTranscript("running", true)
  assert.equal(runtime, "exited")
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ turn: "in-flight", noTranscript: true, lastActivityAt: T0 }), runtime), true)
})

test("registered auto-titles stay in SQLite/transcript and never sync into a planted legacy file", async () => {
  // Structural guard: the board must not regain the legacy updater as an auto-title side channel.
  const boardSource = readFileSync(new URL("./board.ts", import.meta.url), "utf8")
  assert.doesNotMatch(boardSource, /\brunThreadUpdate\b/)

  const dir = mkdtempSync(join(tmpdir(), "frizz-board-auto-title-"))
  mkdirSync(join(dir, ".frizz"))
  const regular = join(dir, ".frizz", "auto-regular.md")
  const external = join(dir, "outside.md")
  const linked = join(dir, ".frizz", "auto-linked.md")
  // A terminal-looking planted file would archive this state=NULL row if the legacy reader opened it.
  writeFileSync(regular, "---\ntitle: Planted\nstatus: done\n---\nregular sentinel\n")
  writeFileSync(external, "external sentinel\n")
  symlinkSync(external, linked)
  const project: Project = {
    dir,
    id: "project-auto-title",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const storage = createStorage(join(dir, "ui.db"), "p")
  for (const slug of ["auto-regular", "auto-linked"]) {
    storage.upsertSession(row({
      slug,
      session_id: `session-${slug}`,
      thread_name: `frizz-${slug}`,
      title: "Stored fallback",
      title_auto: 1,
      state: null,
    }))
  }
  const tailer = {
    get: (slug: string) => slug.startsWith("auto-") ? tele({ aiTitle: `Transcript title for ${slug}` }) : undefined,
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "auto-title-boot")

  try {
    const snapshot = await board.snapshot()
    assert.deepEqual(
      snapshot.threads
        .map((thread) => ({ id: thread.id, aiTitle: thread.aiTitle }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: "auto-linked", aiTitle: "Transcript title for auto-linked" },
        { id: "auto-regular", aiTitle: "Transcript title for auto-regular" },
      ],
    )
    assert.equal(storage.getSession("auto-regular")?.title, "Stored fallback")
    assert.equal(storage.getSession("auto-linked")?.title, "Stored fallback")
    assert.equal(snapshot.threads.find((thread) => thread.id === "auto-regular")?.state, "open")
    assert.equal(snapshot.threads.find((thread) => thread.id === "auto-linked")?.state, "open")
    assert.equal(
      readFileSync(regular, "utf8"),
      "---\ntitle: Planted\nstatus: done\n---\nregular sentinel\n",
    )
    assert.equal(lstatSync(linked).isSymbolicLink(), true)
    assert.equal(readFileSync(external, "utf8"), "external sentinel\n")
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("board provenance excludes legacy files, keeps a foreign transcript read-only, and survives restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-provenance-"))
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  const reportedInvalidFiles = [
    "nubx-dashdash-A-conformance",
    "bun-1.4-lockfile-v2-research",
    "coffeescript-bench-v0.2.9",
    "deno-2.9-steal",
    "pnpm-11.9-audit",
    "release-v0.1.10",
  ]
  for (const slug of [...reportedInvalidFiles, "valid-external-legacy"]) {
    // Deliberately malformed: if the legacy parser sees any of these, the snapshot gains an error.
    writeFileSync(join(dir, ".frizz", `${slug}.md`), "not frontmatter\n")
  }
  writeFileSync(
    join(dir, ".frizz", "migrated-ui-done.md"),
    "---\ntitle: Migrated UI thread\nstatus: done\n---\n",
  )
  const project: Project = {
    dir,
    id: "project-board-provenance",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const dbPath = join(dir, "ui.db")
  let storage = createStorage(dbPath, "p")
  storage.upsertSession(row({
    slug: "ui-claude",
    session_id: "claude-session",
    thread_name: "frizz-ui-claude",
    title: "Claude UI thread",
    title_auto: 0,
    state: null,
  }))
  storage.upsertSession(row({
    slug: "ui-codex",
    session_id: "codex-session",
    thread_name: "frizz-ui-codex",
    title: "Codex UI thread",
    backend: "codex",
    state: "archived",
    archived: 1,
  }))
  storage.upsertSession(row({
    slug: "migrated-ui-done",
    session_id: "migrated-session",
    thread_name: "frizz-migrated-ui-done",
    title: "Migrated UI thread",
    state: null,
    archived: 0,
  }))
  // The normal upsert deliberately leaves backend ownership untouched; dispatch/adoption pins it
  // separately. Exercise the durable values the board projection actually receives.
  storage.setBackend("ui-codex", "codex")
  storage.setBackend("migrated-ui-done", "future-provider")
  const telemetry = new Map<string, SessionTelemetry>([
    ["ui-claude", tele({ lastFence: { kind: "done", body: "complete", hints: [] } })],
    ["foreign-terminal-origin", tele({ lastFence: { kind: "done", body: "foreign", hints: [] } })],
  ])
  const tailer = {
    get: (slug: string) => telemetry.get(slug),
    foreignIds: () => ["foreign-terminal-origin"],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  let board = createBoard(project, storage, new Bus(), tailer, "provenance-boot-1")

  try {
    let snapshot = await board.snapshot()
    assert.deepEqual(snapshot.threads.map((thread) => thread.id).sort(), ["foreign-terminal-origin", "migrated-ui-done", "ui-claude", "ui-codex"])
    // LEGACY provenance is still absolute: an unregistered `.frizz` file never becomes a row. A FOREIGN
    // transcript now does — the External sessions band (2026-08-19) — but it arrives read-only and
    // carries none of the row-derived state it has no source for.
    assert.equal(snapshot.threads.some((thread) => thread.kind === "legacy"), false)
    const foreignRow = snapshot.threads.find((thread) => thread.id === "foreign-terminal-origin")
    assert.equal(foreignRow?.foreign, true)
    assert.equal(foreignRow?.kind, "session")
    // It never enters the queue, whatever its transcript says. The fixture deliberately hands this one
    // a `done` FENCE — a thing a terminal session cannot actually write — to prove the row is built
    // from the foreign projection rather than from the registered one.
    assert.equal(foreignRow?.needsYou, false)
    assert.equal(foreignRow?.lastFence, undefined)
    assert.equal(foreignRow?.state, undefined)
    assert.equal(snapshot.threads.find((thread) => thread.id === "ui-claude")?.needsYou, true)
    assert.equal(snapshot.threads.find((thread) => thread.id === "ui-claude")?.backend, "claude")
    assert.equal(snapshot.threads.find((thread) => thread.id === "ui-codex")?.backend, "codex")
    assert.equal(snapshot.threads.find((thread) => thread.id === "migrated-ui-done")?.backend, undefined)
    assert.equal(snapshot.threads.find((thread) => thread.id === "migrated-ui-done")?.state, "archived")
    assert.deepEqual(snapshot.errors, [])
    assert.deepEqual(snapshot.warnings, [])
    assert.deepEqual(snapshot.errorItems, [])

    // Finalized adoption writes the same durable session row as dispatch. Once that explicit boundary
    // exists, a formerly external legacy file is represented as an owned session—not as a legacy row.
    writeFileSync(join(dir, ".frizz", "adopted-through-ui.md"), "still not parsed\n")
    storage.upsertSession(row({
      slug: "adopted-through-ui",
      session_id: "adopted-session",
      thread_name: "frizz-adopted-through-ui",
      title: "Adopted through UI",
      state: "open",
    }))
    snapshot = board.refresh()
    assert.equal(snapshot.threads.find((thread) => thread.id === "adopted-through-ui")?.kind, "session")

    storage.setState("ui-codex", "open")
    assert.equal(board.refresh().threads.find((thread) => thread.id === "ui-codex")?.state, "open")

    // Reopening the exact database is the migration/restart boundary: no new provenance column is
    // required, and older state=NULL session rows remain owned and open.
    await board.stop()
    storage.close()
    storage = createStorage(dbPath, "p")
    board = createBoard(project, storage, new Bus(), tailer, "provenance-boot-2")
    snapshot = await board.snapshot()
    assert.deepEqual(snapshot.threads.map((thread) => thread.id).sort(), [
      "adopted-through-ui",
      "foreign-terminal-origin",
      "migrated-ui-done",
      "ui-claude",
      "ui-codex",
    ])
    assert.equal(snapshot.threads.find((thread) => thread.id === "ui-claude")?.state, "open")
    assert.equal(snapshot.threads.find((thread) => thread.id === "ui-codex")?.state, "open")
    assert.equal(snapshot.threads.find((thread) => thread.id === "migrated-ui-done")?.state, "archived")
    assert.deepEqual(snapshot.errorItems, [])
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// A row in this band must carry a NAME, not a uuid. Both harnesses name their own threads and both
// fall back to the opening human turn when they have not — verified by driving each of their resume
// pickers on 2026-08-24 — so frizz reads them in that same order.
test("an external row is named by its harness, else by the turn the conversation opened on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-external-title-"))
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  const project: Project = { dir, id: "p", name: "f", label: "f", stateDir: dir, cwdSlug: "f" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const telemetry = new Map<string, SessionTelemetry>([
    // Claude records `ai-title`; codex's own name is read from its sidecar index and assigned onto the
    // same field by the tailer. Either way the harness's name wins outright.
    ["named-by-harness", tele({ aiTitle: "Debug a flaky test", firstUserText: "the sandbox tests keep flaking on CI, can you look" })],
    // No name from the harness → the FIRST human turn, chopped exactly as a dispatch title is, so the
    // row reads like every other row instead of like a raw prompt.
    ["named-by-prompt", tele({ firstUserText: "please look at why the sandbox conformance suite keeps flaking on the windows runner" })],
    // Nothing at all — a transcript with no human turn in it. Only here does a uuid show.
    ["nameless", tele({})],
  ])
  const tailer = {
    get: (slug: string) => telemetry.get(slug),
    foreignIds: () => ["named-by-harness", "named-by-prompt", "nameless"],
    subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "external-title-boot")

  try {
    const rows = new Map((await board.snapshot()).threads.map((t) => [t.id, t]))
    assert.equal(rows.get("named-by-harness")?.title, "Debug a flaky test")
    assert.equal(rows.get("named-by-harness")?.aiTitle, "Debug a flaky test", "the harness's name is a real name, not a guess")
    assert.equal(rows.get("named-by-harness")?.titleAuto, false)

    // Six words of substance, the topic-free lead-in dropped, ellipsis for the rest — `fallbackTitle`.
    assert.equal(rows.get("named-by-prompt")?.title, "look at why the sandbox conformance…")
    assert.equal(rows.get("named-by-prompt")?.aiTitle, undefined)
    assert.equal(rows.get("named-by-prompt")?.titleAuto, true, "a chop of the prompt IS a machine guess")

    // NEVER the "Spinning up a thread…" placeholder: that promises a title on its way, and for a
    // session frizz did not dispatch nothing is on its way.
    assert.equal(rows.get("nameless")?.title, "Session nameless")
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// The band's ONE selection rule, and the reason it exists (maintainer 2026-08-19): "they should only
// be showing the rested ones because if something is currently running, then presumably the user
// already has that open in Claude Code." A spinning terminal session is one the human is watching in
// the window it belongs to; listing it here would be noise, and clicking into it would invite two
// drivers on one transcript.
test("the External band lists only RESTED foreign sessions, and drops one the moment its turn starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-foreign-band-"))
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  const project: Project = {
    dir,
    id: "project-board-foreign-band",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const telemetry = new Map<string, SessionTelemetry>([
    ["rested-terminal", tele({ turn: "idle", aiTitle: "Debug a flaky test", lastAssistant: "done for now", lastAssistantAt: LATER })],
    ["spinning-terminal", tele({ turn: "in-flight", aiTitle: "Refactor the parser" })],
  ])
  const tailer = {
    get: (slug: string) => telemetry.get(slug),
    foreignIds: () => ["rested-terminal", "spinning-terminal"],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "foreign-band-boot")

  try {
    const snapshot = await board.snapshot()
    assert.deepEqual(snapshot.threads.map((thread) => thread.id), ["rested-terminal"], "the spinning terminal is not listed")
    const rested = snapshot.threads[0]
    assert.equal(rested?.foreign, true)
    assert.equal(rested?.kind, "session")
    // Claude titles its own sessions, so a real terminal row carries a real name rather than a slug.
    assert.equal(rested?.title, "Debug a flaky test")
    assert.equal(rested?.aiTitle, "Debug a flaky test")
    assert.equal(rested?.lastAssistant, "done for now")
    // Only rested rows are emitted, so this is the only truthful runtime.
    assert.equal(rested?.runtime, "turn-idle")
    // None of the row-derived state exists for a session with no row, and none of it is invented.
    assert.equal(rested?.needsYou, false)
    assert.equal(rested?.awaitingBackground, false)
    assert.equal(rested?.pendingQuestion, false)
    assert.equal(rested?.state, undefined)
    assert.equal(rested?.snoozedUntil, undefined)
    assert.deepEqual(rested?.subAgents, [])
    assert.deepEqual(rested?.watches, [])

    // The turn STARTS: the human went back to their terminal. The row leaves the band on the next build.
    telemetry.set("rested-terminal", tele({ turn: "in-flight", aiTitle: "Debug a flaky test" }))
    assert.deepEqual(board.refresh().threads.map((thread) => thread.id), [], "a foreign session that starts working drops out")

    // And a title-less session still rows, under a short-id name rather than a spinning-up placeholder
    // (nothing is on its way — no titler runs for a session frizz did not dispatch).
    telemetry.set("rested-terminal", tele({ turn: "idle" }))
    const untitled = board.refresh().threads.find((thread) => thread.id === "rested-terminal")
    assert.equal(untitled?.title, "Session rested-t")
    assert.equal(untitled?.titleAuto, true)
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("board stop drains a watcher setup that races shutdown and immediately unsubscribes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-watch-shutdown-"))
  mkdirSync(join(dir, ".frizz"))
  const project: Project = {
    dir,
    id: "project-board-watch-shutdown",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const tailer = {
    get: () => undefined,
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  let markSubscribeStarted!: () => void
  const subscribeStarted = new Promise<void>((resolve) => { markSubscribeStarted = resolve })
  let releaseSubscribe!: () => void
  const subscribeGate = new Promise<void>((resolve) => { releaseSubscribe = resolve })
  let unsubscribes = 0
  const board = createBoard(project, storage, new Bus(), tailer, "watch-shutdown-boot", {
    subscribe: async () => {
      markSubscribeStarted()
      await subscribeGate
      return { unsubscribe: async () => { unsubscribes++ } }
    },
  })
  const starting = board.start()
  await subscribeStarted
  let stopSettled = false
  const stopping = board.stop().then(() => { stopSettled = true })

  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(stopSettled, false)
    releaseSubscribe()
    await Promise.all([starting, stopping])
    assert.equal(unsubscribes, 1, "a watcher acquired after the stop gate is torn down before drain completes")
  } finally {
    releaseSubscribe()
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// THE WATCH SCOPE. `.frizz/` is a shared directory, not a board directory: every dispatched worker owns
// `.frizz/threads/<session-id>/` as free-form scratch, and the board CLI churns sentinels under
// `.frizz/.session-state/`. A rebuild is thousands of synchronous node:sqlite queries on the event loop,
// so a recursive watch over the lot let any agent's note stall every RPC the browser had in flight
// (measured 2026-09-04: 4.5-10ms board RPC idle, 49-1069ms on the live server). These pin the narrowing
// in both directions, because the failure mode of over-narrowing — a sidebar that stops updating — is
// far worse than the slowness it fixes.
test("the .frizz watch predicate admits a top-level thread document and nothing else", () => {
  const roots = new Set(["/repo/.frizz", "/private/repo/.frizz"])
  assert.equal(isBoardRelevantFrizzPath(roots, "/repo/.frizz/my-thread.md"), true, "the one file the board re-reads")
  // The realpath spelling is the one @parcel/watcher actually reports for a symlinked root.
  assert.equal(isBoardRelevantFrizzPath(roots, "/private/repo/.frizz/my-thread.md"), true)
  assert.equal(isBoardRelevantFrizzPath(roots, "/repo/.frizz/threads/2f0a/scratch.md"), false, "worker scratch")
  assert.equal(isBoardRelevantFrizzPath(roots, "/repo/.frizz/.session-state/2f0a.seen"), false, "CLI liveness sidecar")
  assert.equal(isBoardRelevantFrizzPath(roots, "/repo/.frizz/plans/design.md"), false, "a .md one level down is not a thread file")
  assert.equal(isBoardRelevantFrizzPath(roots, "/repo/.frizz/config.yml"), false, "nothing the board projection reads")
  assert.equal(isBoardRelevantFrizzPath(roots, "/elsewhere/.frizz/my-thread.md"), false, "another project's tree")
})

test("a worker scratch write triggers no board rebuild, while a top-level .md still does", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-watch-scope-"))
  mkdirSync(join(dir, ".frizz"))
  const project: Project = {
    dir, id: "project-board-watch-scope", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture",
  }
  const storage = createStorage(join(dir, "ui.db"), "p")
  // assemble() calls foreignIds() exactly once per build, which makes it an honest rebuild counter.
  let builds = 0
  const tailer = {
    get: () => undefined,
    foreignIds: () => { builds++; return [] },
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  let fire!: (paths: string[]) => void
  let fail!: () => void
  let ignored: string[] = []
  const board = createBoard(project, storage, new Bus(), tailer, "watch-scope-boot", {
    subscribe: async (_dir, fn, opts) => {
      ignored = [...(opts?.ignore ?? [])] as string[]
      fire = (paths) => fn(null, paths.map((path) => ({ path, type: "update" as const })))
      fail = () => fn(new Error("watcher backend gave up"), [])
      return { unsubscribe: async () => {} }
    },
  })
  // Long enough to clear the 150ms rebuild debounce with margin, short enough to stay far under the 15s
  // level-triggered reconcile — so anything counted below is the edge, never the safety net.
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 400))
  try {
    await board.start()
    const afterStart = builds
    assert.ok(afterStart >= 1, "the initial build ran")
    assert.deepEqual(ignored, [join(dir, ".frizz", "threads"), join(dir, ".frizz", ".session-state")])

    // NEGATIVE: the scratch directory Frizz hands every worker, and the CLI's sentinel dir.
    fire([join(dir, ".frizz", "threads", "2f0a", "scratch.md"), join(dir, ".frizz", ".session-state", "2f0a.seen")])
    await settle()
    assert.equal(builds, afterStart, "worker scratch must not rebuild the board")

    // POSITIVE, and the control that proves the counter above can move at all.
    fire([join(dir, ".frizz", "my-thread.md")])
    await settle()
    assert.equal(builds, afterStart + 1, "a top-level thread document still rebuilds promptly")

    fire([])
    await settle()
    assert.equal(builds, afterStart + 1, "an empty batch is still no rebuild")

    // An errored callback carries no paths to test, so the filter has nothing to decide on and must
    // fail OPEN. The cost of a wrong guess is asymmetric: a spare rebuild is milliseconds, a dropped
    // one is up to RECONCILE_MS of a stale sidebar.
    fail()
    await settle()
    assert.equal(builds, afterStart + 2, "a watcher error rebuilds rather than going quiet")
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("board exposes a typed providerFault from tailer auth telemetry — category only, no raw text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-auth-fault-"))
  const project: Project = { dir, id: "board-auth-fault", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession(row({ slug: "auth-fault", thread_name: "frizz-auth-fault", backend: "claude" }))
  const tailer = {
    get: (slug: string) => (slug === "auth-fault" ? tele({ authFault: "authentication_rejected" }) : undefined),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "auth-fault-boot")
  try {
    const thread = (await board.snapshot()).threads.find((candidate) => candidate.id === "auth-fault")!
    assert.deepEqual(thread.providerFault, { backend: "claude", category: "authentication_rejected" })
    const clean = (await board.snapshot()).threads.find((candidate) => candidate.id === "auth-fault")!
    assert.equal(JSON.stringify(clean).includes("401"), false, "no raw provider text rides the snapshot")
  } finally {
    board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- fenceWatchViews ----
//
// The strip under the prompt box lists what this thread has OUT — the same place its sub-agents and
// background shells are listed (maintainer 2026-08-13: "showing the active watchers underneath the
// prompt box, similar to how subagents work"). Its two kinds come from two different places, and that
// split is the thing to hold on to:
//
//   • a GITHUB row is one REGISTERED PR watcher (`mcp__frizz__watch_pr`). It stands whether or not the
//     fence mentions it, because a registration is live work regardless of what the worker wrote.
//   • a SHELL row is a `watch:` line in the standing fence, checked against a live shell. It is a
//     DECLARATION, so it lives and dies with the fence.
//
// A `pr-watch:` fence line produces NO row of its own. It states a wait the tool created; the registry
// above has already listed it, and a line naming a PR nobody registered describes a wake that will never
// arrive.
const FENCE_AT = "2026-08-13T04:00:00.000Z"
const REGISTERED_PRS = ["colinhacks/zod#6382", "acme/app#1", "acme/app#2"]
  .map((target) => ({ target, createdAt: FENCE_AT }))
const registeredOf = (...targets: string[]) => REGISTERED_PRS.filter((w) => targets.includes(w.target))
const parked = (...hints: { kind: string; value: string }[]) =>
  tele({ lastFence: { kind: "awaiting", body: "", hints } as SessionTelemetry["lastFence"], lastAssistantAt: FENCE_AT })

test("every registered PR watcher gets a row, with the instant it was registered", () => {
  const views = fenceWatchViews("t", parked({ kind: "pr", value: "colinhacks/zod#6382" }), FENCE_AT, {}, registeredOf("colinhacks/zod#6382"))
  assert.deepEqual(views, [{
    id: "github:t:colinhacks/zod#6382",
    kind: "github",
    target: "colinhacks/zod#6382",
    state: "armed",
    createdAt: FENCE_AT,
  }])
})

// THE ROW FOLLOWS THE REGISTRATION, NOT THE FENCE. A worker that registered a PR and has not written (or
// has since replaced) its fence still has that watcher out, and the strip's job is to say so.
test("a registered watcher shows with no fence at all", () => {
  assert.deepEqual(
    fenceWatchViews("t", tele({ lastFence: { kind: "done", body: "landed", hints: [] } }), FENCE_AT, {}, registeredOf("acme/app#1")).map((w) => w.target),
    ["acme/app#1"],
  )
  assert.deepEqual(fenceWatchViews("t", tele(), FENCE_AT, {}, registeredOf("acme/app#1")).map((w) => w.target), ["acme/app#1"])
})

// …AND A DECLARATION WITH NOTHING BEHIND IT SHOWS NOTHING. The fence can name any PR it likes; only a
// registration makes frizz watch one, so an unregistered line would put a row on the strip that nothing
// can ever fire.
test("a pr-watch line with no registration behind it yields no row", () => {
  assert.deepEqual(fenceWatchViews("t", parked({ kind: "pr", value: "colinhacks/zod#6382" }), FENCE_AT, {}, []), [])
  assert.deepEqual(fenceWatchViews("t", parked({ kind: "pr", value: "the auth PR" }), FENCE_AT, {}, []), [])
})

test("several registered PRs each get a row, and a repeat of one does not", () => {
  const views = fenceWatchViews("t", parked(), FENCE_AT, {}, [...registeredOf("acme/app#1", "acme/app#2"), { target: "acme/app#1", createdAt: FENCE_AT }])
  assert.deepEqual(views.map((w) => w.target), ["acme/app#1", "acme/app#2"])
})

// ---- timer rows (2026-08-24) ----
// The third kind, and it follows the GITHUB half of the split above: an ARMED `thread_timer` row gets a
// row whether or not the fence mentions it — a registration is live work that WILL wake the thread —
// while a `timers:` line naming nothing armed yields no row, because it describes a wake that will
// never come. The row carries the timer's own prompt and fire instant, because those are the whole
// rendering: the id names nothing to a human (maintainer 2026-08-24, on the fence card printing
// "a timer   for 2h": the resting card "enumerates all of the pull requests and the background shells …
// I don't understand why timer isn't represented in the same way").
const ARMED_TIMER = { id: "tmr_a1b2c3", prompt: "Re-check: tip quiet, install green", fireAt: "2026-08-13T05:00:00.000Z", createdAt: FENCE_AT }

test("an armed timer gets a row carrying its prompt and fire instant, fence or no fence", () => {
  assert.deepEqual(fenceWatchViews("t", parked({ kind: "timer", value: "tmr_a1b2c3" }), FENCE_AT, {}, [], [ARMED_TIMER]), [{
    id: "timer:t:tmr_a1b2c3",
    kind: "timer",
    target: "tmr_a1b2c3",
    state: "armed",
    createdAt: FENCE_AT,
    timer: { fireAt: "2026-08-13T05:00:00.000Z", prompt: "Re-check: tip quiet, install green" },
  }])
  // The row follows the REGISTRATION, exactly like a PR watcher's: no fence, same row.
  assert.deepEqual(fenceWatchViews("t", tele(), FENCE_AT, {}, [], [ARMED_TIMER]).map((w) => w.target), ["tmr_a1b2c3"])
})

test("a timers: line with nothing armed behind it yields no row", () => {
  assert.deepEqual(fenceWatchViews("t", parked({ kind: "timer", value: "tmr_dead" }), FENCE_AT, {}, [], []), [])
})

// ---- a `shells:` entry rows, an `agents:` entry does NOT (2026-08-26) ----
// The two look symmetrical in the fence and are not symmetrical here, because a row emitted by this loop
// is a SHELL row by construction. A sub-agent already has a row on every surface that draws one — the
// resting card's own live-agent group and the strip under the prompt box, both read straight off
// `subAgents` and neither needing a declaration — so an agent hint listed the same child a SECOND time
// under "Background shells", named by its raw `toolu_…` id because no shell exists behind it to resolve
// a name from (maintainer 2026-08-26: "why are these background shells showing up in the awaiting block
// but not underneath the prompt box"). Introduced by the `watch:` → `shells:`/`agents:` cutover
// (5e0baf54), which widened the filter to both new kinds while the push stayed one kind.
const LIVE_SHELL = { label: "gh run watch 1842", startedAt: FENCE_AT, state: "running" as const, id: "toolu_shell", taskId: "bzvtnt3ig" }
const LIVE_AGENT = { label: "Auditing token overhead", startedAt: FENCE_AT, state: "running" as const, id: "toolu_agent" }

test("a shells: entry naming a live shell gets a shell row", () => {
  const parkedOnShell = tele({
    lastFence: { kind: "awaiting", body: "", hints: [{ kind: "shell", value: "bzvtnt3ig" }] } as SessionTelemetry["lastFence"],
    lastAssistantAt: FENCE_AT,
    bgShells: [LIVE_SHELL],
  })
  assert.deepEqual(fenceWatchViews("t", parkedOnShell, FENCE_AT, {}, []), [{
    id: "shell:t:bzvtnt3ig",
    kind: "shell",
    target: "bzvtnt3ig",
    state: "armed",
    createdAt: FENCE_AT,
  }])
})

test("an agents: entry naming a live sub-agent gets no row of its own", () => {
  const parkedOnAgent = tele({
    lastFence: { kind: "awaiting", body: "", hints: [{ kind: "agent", value: "toolu_agent" }] } as SessionTelemetry["lastFence"],
    lastAssistantAt: FENCE_AT,
    subAgents: [LIVE_AGENT],
  })
  assert.deepEqual(fenceWatchViews("t", parkedOnAgent, FENCE_AT, {}, []), [], "the sub-agent is not a background shell")
})

test("hints that are neither pr-watch nor watch never produce a row", () => {
  assert.deepEqual(fenceWatchViews("t", parked(
    { kind: "shell", value: "Alice must approve" },
    { kind: "timer", value: "2099-07-15T17:00:00Z" },
    { kind: "session", value: "the reviewer's thread" },
  ), FENCE_AT, {}, []), [])
})

test("nothing registered and nothing declared, no rows", () => {
  assert.deepEqual(fenceWatchViews("t", undefined, FENCE_AT), [])
})

// ---- REGISTERED WATCHES (2026-08-26) ----
//
// The registry half of the same split, and the one the fence never had: a `thread_watch` row created by
// `mcp__frizz__watch`. It follows the GITHUB/TIMER side — the row outlives the message that made it, so
// it stands fence or no fence — and it parks the thread on its own, which is the whole point of
// plans/rest-by-registration.md: a wait stops being a line the worker has to restate at every rest.
const NOW = Date.parse(FENCE_AT) + 60_000 // a minute into the rest
const registeredWatch = (over: Partial<RegisteredWatch> = {}): RegisteredWatch => ({
  id: "wch_a1b2c3", kind: "shell", target: "bzvtnt3ig", createdAt: FENCE_AT, expiresAt: "2999-01-01T00:00:00.000Z", ...over,
})

test("a registered shell watch parks the thread with no fence at all", () => {
  const live = tele({ bgShells: [LIVE_SHELL] })
  assert.equal(hasRegisteredBackgroundPark(live, [registeredWatch()], NOW), true)
  // …and it is a WAIT for every surface that asks, not just the queue rule.
  assert.equal(hasDeclaredWait(live, NOW, new Set(), new Set(), [registeredWatch()]), true)
  // The registration alone, with nothing behind it, is not a wait: a row whose work has ended describes
  // a wake that can never come — the same rule a `shells:` name takes.
  assert.equal(hasRegisteredBackgroundPark(tele(), [registeredWatch()], NOW), false)
})

test("ANY live registered watch parks, where a fence needs ALL of its names live", () => {
  // The two rules differ because the objects do. A fence is one sentence about every name in it, so one
  // dead name means the sentence has stopped describing reality. A registration is its own row, made at
  // its own moment, and one settling says nothing about the others.
  const live = tele({ bgShells: [LIVE_SHELL] })
  const watches = [registeredWatch(), registeredWatch({ id: "wch_dead", target: "gone" })]
  assert.equal(hasRegisteredBackgroundPark(live, watches, NOW), true)
})

test("an EXPIRED row stops parking on its own clock, without waiting for the scheduler", () => {
  // The expiry is the ROW's, not the fence's blanket DECLARED_PARK_MAX_MS — one park duration for every
  // wait, chosen by nobody, is the thing an un-restated fence could never get right. Settling the row is
  // the scheduler's job; a read never mutates, so until then it simply stops parking.
  const live = tele({ bgShells: [LIVE_SHELL] })
  const expired = registeredWatch({ expiresAt: new Date(NOW - 1).toISOString() })
  assert.equal(hasRegisteredBackgroundPark(live, [expired], NOW), false)
  assert.equal(hasRegisteredBackgroundPark(live, [registeredWatch({ expiresAt: new Date(NOW + 1).toISOString() })], NOW), true)
})

test("a KIND that disagrees with live telemetry does not park", () => {
  // The registration says shell; the handle resolves to a sub-agent. The RPC refuses that pairing at
  // registration, so a row like this can only come from work that changed shape underneath it — and a
  // park on a mis-kinded row is exactly the reading that filed two sub-agents under "Background shells".
  const agentOnly = tele({ subAgents: [LIVE_AGENT] })
  assert.equal(hasRegisteredBackgroundPark(agentOnly, [registeredWatch({ target: "toolu_agent" })], NOW), false)
  assert.equal(hasRegisteredBackgroundPark(agentOnly, [registeredWatch({ kind: "agent", target: "toolu_agent" })], NOW), true)
})

test("a registered shell gets a strip row, and an agent registration gets none", () => {
  const live = tele({ bgShells: [LIVE_SHELL], subAgents: [LIVE_AGENT] })
  const views = fenceWatchViews("t", live, FENCE_AT, {}, [], [], [registeredWatch(), registeredWatch({ id: "wch_ag", kind: "agent", target: "toolu_agent" })])
  // The sub-agent is already a row on every surface that draws this card, read straight off `subAgents`.
  // A second row here would name it by its raw `toolu_…` id under a "Background shells" heading.
  assert.deepEqual(views, [{
    id: "shell:t:bzvtnt3ig",
    kind: "shell",
    target: "bzvtnt3ig",
    state: "armed",
    createdAt: FENCE_AT,
  }])
})

test("a registered shell and a fence naming the same shell are ONE row", () => {
  const live = { ...parked({ kind: "shell", value: "bzvtnt3ig" }), bgShells: [LIVE_SHELL] }
  const views = fenceWatchViews("t", live, FENCE_AT, {}, [], [], [registeredWatch()])
  assert.deepEqual(views.map((w) => w.target), ["bzvtnt3ig"])
})

test("a registration whose shell has ended yields no strip row, exactly as a dead fence name does", () => {
  assert.deepEqual(fenceWatchViews("t", tele(), FENCE_AT, {}, [], [], [registeredWatch()]), [])
})

test("a registered park excuses the thread from the queue and still states itself on the card", () => {
  const live = tele({ turn: "idle", bgShells: [LIVE_SHELL], lastAssistantAt: FENCE_AT })
  const watches = [registeredWatch()]
  // The QUEUE rule: there is nothing for the human to do until the shell reports.
  assert.equal(deriveNeedsYou(row(), live, "turn-idle", false, NOW, undefined, true, false, {}, new Set(), new Set(), watches), false)
  // The CARD must still say so — without the opt-out the drawer blanks at rest and reads as "the agent
  // died", which is the failure that card exists to prevent.
  assert.equal(deriveAwaitingBackground(row(), live, "turn-idle", false, NOW, undefined, false, {}, new Set(), new Set(), watches), true)
  // With no registration the same thread is an ordinary bare rest, and queues.
  assert.equal(deriveNeedsYou(row(), live, "turn-idle", false, NOW, undefined, true, false, {}, new Set(), new Set(), []), true)
})

// ---- LIMIT FAULTS QUEUE (2026-08-31) ----
//
// A usage-limit kill is a HARD queue member, like the crash net: it was a queue EXCUSAL until a quota
// limit killed a whole fleet and every thread showed up calmly Snoozed (maintainer: "they should have
// shown up in the queue, right, as blocked threads, as threads that had failed in some way").
const LIMIT_PAUSE = { backend: "claude", window: "session", at: new Date(NOW - 60_000).toISOString(), autoResume: true } as const

test("deriveNeedsYou: a limit fault queues — auto-resume promised or not", () => {
  assert.equal(deriveNeedsYou(row(), tele({ turn: "idle" }), "turn-idle", false, NOW, LIMIT_PAUSE), true)
  // A STALE pause (autoResume false) queues too — it always did, via the bare-rest handoff.
  assert.equal(deriveNeedsYou(row(), tele({ turn: "idle" }), "exited", false, NOW, { ...LIMIT_PAUSE, autoResume: false }), true)
})

test("deriveNeedsYou: a limit fault outranks the stale park the worker declared BEFORE the kill", () => {
  // Same registered-park shape that excuses a healthy rest above — the limit must queue it anyway,
  // because the fence/registration predates the kill and the shell is not what stopped this thread.
  const live = tele({ turn: "idle", bgShells: [LIVE_SHELL], lastAssistantAt: FENCE_AT })
  const watches = [registeredWatch()]
  assert.equal(deriveNeedsYou(row(), live, "turn-idle", false, NOW, LIMIT_PAUSE, true, false, {}, new Set(), new Set(), watches), true)
})

test("deriveNeedsYou: the operator's own snooze still parks a limit-killed thread", () => {
  assert.equal(deriveNeedsYou(row({ snoozed_until: new Date(NOW + 60 * 60_000).toISOString() }), tele({ turn: "idle" }), "turn-idle", false, NOW, LIMIT_PAUSE), false)
})

test("resolveLimitPause: the auto-resume promise matches the waker's actual reach", () => {
  const at = new Date(NOW - 60_000).toISOString()
  const pause = (window: "session" | "weekly" | "model" | "unknown") =>
    resolveLimitPause(row(), tele({ limitFault: { window, at } }), NOW)
  // session/weekly/model each have at least one live trigger (text clock, static quota key, scoped
  // quota window), so the promise stands while the fault is fresh…
  assert.equal(pause("session")?.autoResume, true)
  assert.equal(pause("weekly")?.autoResume, true)
  assert.equal(pause("model")?.autoResume, true)
  // …but an UNKNOWN window has none — limitRecovered stays indeterminate forever — so promising
  // "Continuing automatically" was false advertising (2026-08-31: a fleet killed by an unrecognized
  // phrasing sat behind exactly that card).
  assert.equal(pause("unknown")?.autoResume, false)
})

test("deriveAwaitingBackground: a limit fault silences the declared-wait card — the limit card is the story", () => {
  // Without the explicit stop, the 2026-08-31 queue flip would have made this TRUE (the flag ends on
  // deriveNeedsYou) and hasLiveOps would spin a dead thread client-side.
  const live = tele({ turn: "idle", bgShells: [LIVE_SHELL], lastAssistantAt: FENCE_AT })
  const watches = [registeredWatch()]
  assert.equal(deriveAwaitingBackground(row(), live, "turn-idle", false, NOW, LIMIT_PAUSE, false, {}, new Set(), new Set(), watches), false)
})

// ---- REGISTERED QUESTIONS (2026-08-26) ----
//
// The queue half of the question registry. What it must NOT do is as important as what it does: a
// registered question is a hard queue member, and it is deliberately NOT wired into
// degradeIfAwaitingAnswer, which pins a RUNNING thread to turn-idle. That is right for a fence (the
// question was the last thing said) and wrong for a row (the worker asked and kept working).
test("an open registered question is a hard queue member, and outranks the awaiting card", () => {
  const live = tele({ turn: "idle", bgShells: [LIVE_SHELL], lastAssistantAt: FENCE_AT })
  const watches = [registeredWatch()]
  // Without a question the registered park excuses the thread from the queue.
  assert.equal(deriveNeedsYou(row(), live, "turn-idle", false, NOW, undefined, true, false, {}, new Set(), new Set(), watches, 0), false)
  // WITH one, the human owes an answer — so it queues, park or no park.
  assert.equal(deriveNeedsYou(row(), live, "turn-idle", false, NOW, undefined, true, false, {}, new Set(), new Set(), watches, 1), true)
  // …and the awaiting card stands down, because at rest with both outstanding the human should be
  // looking at the QUESTION. Two expanded surfaces compete for one glance; the watches collapse behind
  // a count on the question card instead.
  assert.equal(deriveAwaitingBackground(row(), live, "turn-idle", false, NOW, undefined, false, {}, new Set(), new Set(), watches, 1), false)
  assert.equal(deriveAwaitingBackground(row(), live, "turn-idle", false, NOW, undefined, false, {}, new Set(), new Set(), watches, 0), true)
})

test("a registered question does NOT degrade a running thread to turn-idle", () => {
  // degradeIfAwaitingAnswer exists for the FENCE: a ```question in the last assistant message means the
  // worker stopped, so a stale `running` has to be corrected. A row makes no such claim — the worker
  // registers and keeps going — and pinning it to turn-idle would stop its shimmer for as long as the
  // question stood. The function still takes only the tailer's boolean; this pins that it was not
  // widened to the registry along the way.
  assert.equal(degradeIfAwaitingAnswer("running", false), "running")
  assert.equal(degradeIfAwaitingAnswer("running", true), "turn-idle")
  assert.equal(degradeIfAwaitingAnswer("turn-idle", true), "turn-idle")
})

// ---- THE ANSWER ALREADY SENT, NOT YET RECEIVED -----------------------------------------------------
//
// Answering stores the row; a wake hands it to the worker a moment later, deliberately — an answer given
// while the worker's process was down has to survive the gap. But the gap is a HOLE ON SCREEN: the
// question card goes the instant the answer is stored, and until the delivery lands nothing stands in
// its place, so the thread drew the residual "Rested without a sign-off" card in it (maintainer
// 2026-08-27). This is what fills it, and its whole subtlety is WHEN IT STOPS.

const askedRow = (over: Partial<ThreadQuestionRow> = {}): ThreadQuestionRow => ({
  id: "qst_1", thread_slug: "t", state: "answered", delivered: 0, asked_at: 1000, settled_at: 2000,
  spec: JSON.stringify({ question: "SQLite or a JSON file?", kind: "question", options: [{ label: "SQLite" }] }),
  answer: JSON.stringify({ questionId: "qst_1", question: "SQLite or a JSON file?", chosen: ["SQLite"] }),
  ...over,
})

test("an answered row in flight composes the exact message the delivery will carry", () => {
  // THE SAME BYTES, so the card drawn while it is in flight and the card drawn once it lands are the
  // same card and the swap between them is invisible.
  assert.equal(
    answersInFlight([askedRow()], undefined),
    questionAnswerMessage([{ questionId: "qst_1", question: "SQLite or a JSON file?", chosen: ["SQLite"] }]),
  )
})

test("the WORKER RECEIVING it spends it — not the outbox claiming it", () => {
  // `delivered` is set at ENQUEUE, a whole delivery ahead of the transcript, so keying on it would
  // reopen the same hole a second wide. The newest user record is the honest test: frizz's delivery IS
  // a user record, so the moment the worker has it, the card the transcript draws takes over.
  assert.ok(answersInFlight([askedRow({ delivered: 1 })], new Date(1999).toISOString()), "enqueued is not received")
  assert.equal(answersInFlight([askedRow()], new Date(2000).toISOString()), undefined, "the record landed")
  assert.equal(answersInFlight([askedRow()], new Date(9000).toISOString()), undefined, "…and stays spent")
})

test("nothing in flight for a question nobody answered, or for a dismissal alone", () => {
  assert.equal(answersInFlight([askedRow({ state: "open", settled_at: null, answer: null })], undefined), undefined)
  assert.equal(answersInFlight([askedRow({ state: "withdrawn", answer: null })], undefined), undefined)
  // A DISMISSAL WAKES NOBODY, so there is no arrival to bridge to — showing a card for one would leave
  // it on screen until the next unrelated turn.
  assert.equal(answersInFlight([askedRow({ state: "dismissed", answer: null })], undefined), undefined)
})

test("…UNLESS a wake is coming for the dismissals — the autonomy cancellation is in flight like an answer", () => {
  // Arming a rest Goal cancels the open questions and evalQuestionAnswers wakes on exactly that shape,
  // so on an autonomous thread the gap between arming and the wake landing is the same hole an answer
  // in flight fills — the question card gone, the residual "Rested without a sign-off" card in its
  // place (maintainer 2026-09-02). Same bytes as that wake, same spend: the worker receiving it.
  const dismissed = askedRow({ state: "dismissed", answer: null })
  assert.equal(answersInFlight([dismissed], undefined, true), questionsCancelledWakeMessage(1))
  assert.equal(answersInFlight([dismissed], new Date(2000).toISOString(), true), undefined, "the wake landed")
  // The flag widens ONLY the dismissal-alone case; answers keep their message with or without it.
  assert.equal(answersInFlight([askedRow()], undefined, true), answersInFlight([askedRow()], undefined))
})

test("a dismissal RIDES an answer, and is named by its question rather than its id", () => {
  const wire = answersInFlight([
    askedRow(),
    askedRow({ id: "qst_2", state: "dismissed", answer: null, spec: JSON.stringify({ question: "Name the flag?", kind: "question" }) }),
  ], undefined)
  assert.match(wire ?? "", /“Name the flag\?” → \(dismissed/)
})

test("one unreadable row never blanks the card the others earned", () => {
  const wire = answersInFlight([askedRow(), askedRow({ id: "qst_2", answer: "{not json" })], undefined)
  assert.match(wire ?? "", /“SQLite or a JSON file\?” → SQLite/)
})

// ---- A REGISTERED COMPLETION -----------------------------------------------------------------------
//
// `done` is a tool now, not a fence (plans/rest-by-registration.md), and a tool cannot write the
// tailer's `lastFence` — that is derived from the transcript. So the row is PRESENTED as the fence it
// replaces, which is what keeps the two from carding as two different endings while both are accepted.
// The risk is not in the presentation, it is in the LIFETIME: a fence is superseded when the worker
// writes again, and a row has to be spent by something.

test("a registered done presents as the ```done fence it replaces", () => {
  assert.deepEqual(registeredDoneFence({ body: "- **Fixed** it", doneAt: 1000 }, undefined), {
    kind: "done", body: "- **Fixed** it", hints: [], registered: true,
  })
})

test("no row, no fence", () => {
  assert.equal(registeredDoneFence(undefined, "2026-08-27T00:00:00.000Z"), undefined)
})

test("the human SENDING MORE WORK spends it — that is when a completion stops being true", () => {
  const done = { body: "done", doneAt: Date.parse("2026-08-27T01:00:00.000Z") }
  // Their last word came BEFORE the sign-off: the completion is the newer statement and it stands.
  assert.equal(registeredDoneFence(done, "2026-08-27T00:59:00.000Z")?.kind, "done")
  // Their last word came AFTER it: there is new work, so the thread is not finished any more. No sweep
  // clears the row — it simply stops being honoured, which is also what makes reopening one free.
  assert.equal(registeredDoneFence(done, "2026-08-27T01:00:01.000Z"), undefined)
})

test("a same-instant tie stands, because the two instants come off DIFFERENT clocks", () => {
  // The row's instant is frizz's own Date.now(); the telemetry's is the transcript record's. A worker
  // signing off on the turn a user record started is the ordinary case, not a reopening.
  const at = Date.parse("2026-08-27T01:00:00.000Z")
  assert.equal(registeredDoneFence({ body: "done", doneAt: at }, "2026-08-27T01:00:00.000Z")?.kind, "done")
})

test("an unparseable user instant cannot silently revoke a completion", () => {
  // `Date.parse` returns NaN, and every comparison against NaN is false — so a naive `>` would have
  // left the done standing by accident rather than on purpose. It stands ON PURPOSE: a timestamp frizz
  // cannot read is not evidence that the human said anything.
  assert.equal(registeredDoneFence({ body: "done", doneAt: 1000 }, "not-a-date")?.kind, "done")
})

// REGISTRATION-FIRST WAITS (2026-08-27). A PR watch or a timer used to count as a wait only when an
// awaiting fence named it, so a worker that registered one and rested on prose fell through to the bare
// rest and drew no card. With no fence the registration IS the wait; with a fence, the fence still has
// to name an armed one (the declaration is the worker's statement, checked against the registry).
test("an armed PR watch or timer with no fence is a declared wait; a fence must still name one", () => {
  const idle = tele({ turn: "idle" })
  assert.equal(hasDeclaredWait(idle, NOW, new Set(), new Set(["acme/app#1"]), []), true)
  assert.equal(hasDeclaredWait(idle, NOW, new Set(["tmr_a1"]), new Set(), []), true)
  assert.equal(hasDeclaredWait(idle, NOW, new Set(), new Set(), []), false)
  // An awaiting fence that names shells only, beside an armed timer nobody declared: the fence rules.
  const shellsOnly = parked({ kind: "shell", value: "bzvtnt3ig" })
  assert.equal(hasParkedTimerWatch(shellsOnly, new Set(["tmr_a1"])), false)
  assert.equal(hasParkedTimerWatch(parked({ kind: "timer", value: "tmr_a1" }), new Set(["tmr_a1"])), true)
  assert.equal(hasParkedTimerWatch(idle, new Set(["tmr_a1"])), true)
})

// A `watch` names whichever handle the worker has. For a sub-agent that is the Agent launch ack's
// `agentId` — the dispatch tool_use id never reaches the model — so the resolver must answer to it
// exactly as it answers to a shell's `taskId` (see liveWaitHandles for the 2026-08-28 miss).
test("resolveLiveWatchTarget: a sub-agent resolves by its runtime agentId as well as its tool_use id and label", async () => {
  const { resolveLiveWatchTarget } = await import("./board.ts")
  const tele = {
    bgShells: [],
    subAgents: [{ id: "toolu_A", taskId: "a01b2d20b32feab11", label: "the reviewer", startedAt: "2026-08-28T14:41:41.000Z", state: "running" }],
  } as unknown as SessionTelemetry
  assert.deepEqual(resolveLiveWatchTarget(tele, "a01b2d20b32feab11"), { kind: "agent", label: "the reviewer" })
  assert.deepEqual(resolveLiveWatchTarget(tele, "toolu_A"), { kind: "agent", label: "the reviewer" })
  assert.equal(resolveLiveWatchTarget(tele, "bGHOST"), undefined)
})
