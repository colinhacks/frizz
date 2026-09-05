import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import Database from "./sqlite.ts"
import { createStorage, sessionTitleLocked, STORAGE_SCHEMA, type ProfileHandoffJournal, type Storage, type SessionRow } from "./storage.ts"

function profileHandoff(
  nativeSessionId: string,
  previous: { model: string; effort: string },
  requested: { model: string; effort: string },
): ProfileHandoffJournal {
  return {
    version: 1,
    phase: "armed",
    nativeSessionId,
    previous: {
      ...previous,
      binding: { kind: "standalone", paneId: "%1", panePid: 101, sessionCreated: 1_750_000_000 },
    },
    requested,
  }
}

function store(): Storage {
  return createStorage(join(mkdtempSync(join(tmpdir(), "frizz-storage-")), "ui.db"), "p")
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  const result = {
    slug: "t",
    session_id: "sid",
    thread_name: "frizz-t",
    spawned_at: "2026-07-01T00:00:00.000Z",
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
    ...over,
  }
  if (over.slug !== undefined && over.thread_name === undefined) result.thread_name = `frizz-${result.slug}`
  return result
}

test("storage close is idempotent", () => {
  const s = store()
  s.upsertSession(row())
  assert.doesNotThrow(() => s.close())
  assert.doesNotThrow(() => s.close(), "competing shutdown paths cannot close SQLite twice")
})

test("sub-agent drawer steers are durable, idempotent, ordered, and project-scoped", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-storage-steers-"))
  const path = join(dir, "ui.db")
  const first = createStorage(path, "first")
  const second = createStorage(path, "second")
  try {
    first.recordSubAgentSteer({ slug: "thread", subAgentId: "child", deliveryId: "b", message: "second", sentAtMs: 20 })
    first.recordSubAgentSteer({ slug: "thread", subAgentId: "child", deliveryId: "a", message: "first", sentAtMs: 10 })
    first.recordSubAgentSteer({ slug: "thread", subAgentId: "child", deliveryId: "a", message: "duplicate", sentAtMs: 30 })
    second.recordSubAgentSteer({ slug: "thread", subAgentId: "child", deliveryId: "a", message: "other project", sentAtMs: 5 })

    assert.deepEqual(first.listSubAgentSteers("thread", "child").map((r) => [r.delivery_id, r.message]), [
      ["a", "first"],
      ["b", "second"],
    ])
    assert.deepEqual(second.listSubAgentSteers("thread", "child").map((r) => r.message), ["other project"])
  } finally {
    first.close()
    second.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("insertSessionIfAbsent atomically preserves the winner and writes backend identity in one claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-storage-claim-"))
  const path = join(dir, "ui.db")
  const first = createStorage(path, "p")
  const second = createStorage(path, "p")

  assert.equal(first.insertSessionIfAbsent(row({
    slug: "claimed",
    session_id: "codex-owner",
    backend: "codex",
    agent_session_id: "codex-native-id",
    exited: 1,
    archived: 1,
    state: "archived",
  })), true)

  // A second connection simulates another server/process winning or losing the same registry CAS.
  // It must not partially convert a Codex owner into Claude or clear its native-session identity.
  assert.equal(second.insertSessionIfAbsent(row({
    slug: "claimed",
    session_id: "claude-loser",
    backend: "claude",
    agent_session_id: null,
    exited: 0,
    archived: 0,
    state: "open",
  })), false)
  assert.deepEqual(
    {
      sessionId: second.getSession("claimed")?.session_id,
      backend: second.getSession("claimed")?.backend,
      agentSessionId: second.getSession("claimed")?.agent_session_id,
      exited: second.getSession("claimed")?.exited,
      archived: second.getSession("claimed")?.archived,
      state: second.getSession("claimed")?.state,
    },
    {
      sessionId: "codex-owner",
      backend: "codex",
      agentSessionId: "codex-native-id",
      exited: 1,
      archived: 1,
      state: "archived",
    },
  )

  // A genuinely fresh Claude claim writes both identity fields explicitly in the same statement.
  assert.equal(second.insertSessionIfAbsent(row({ slug: "fresh-claude", session_id: "claude-owner" })), true)
  assert.equal(first.getSession("fresh-claude")?.backend, "claude")
  assert.equal(first.getSession("fresh-claude")?.agent_session_id, null)

  second.close()
  first.close()
})

test("adoption finalization atomically publishes the session and exact binding; replacement retires it", () => {
  const s = store()
  const slug = "atomic-adoption"
  const sessionId = randomUUID()
  const token = randomUUID()
  assert.equal(s.reserveAdoptionClaim({
    slug,
    attemptToken: token,
    sessionId,
    reservedAtMs: 100,
    leaseExpiresAtMs: 200,
  }), true)
  assert.equal(s.getSession(slug), undefined)
  assert.equal(s.recordAdoptionPane(slug, token, { paneId: "%7", panePid: 700, sessionCreated: 7000 }, 200), true)
  assert.equal(s.finalizeAdoptionClaim(slug, token, row({ slug, session_id: sessionId }), 150), true)
  assert.equal(s.getSession(slug)?.session_id, sessionId)
  assert.deepEqual(
    {
      state: s.getAdoptionClaim(slug)?.state,
      paneId: s.getAdoptionClaim(slug)?.pane_id,
      panePid: s.getAdoptionClaim(slug)?.pane_pid,
      sessionCreated: s.getAdoptionClaim(slug)?.session_created,
    },
    { state: "finalized", paneId: "%7", panePid: 700, sessionCreated: 7000 },
  )

  s.upsertSession(row({ slug, session_id: "replacement" }))
  assert.equal(s.getAdoptionClaim(slug), undefined)
  assert.equal(s.getSession(slug)?.session_id, "replacement")
  assert.ok(s.allRetiredAdoptionAttempts().some((attempt) => attempt.attempt_token === token))
})

test("forgetSession removes only the matching finalized adoption binding", () => {
  const s = store()
  const slug = "forget-adoption"
  const sessionId = randomUUID()
  const token = randomUUID()
  assert.equal(s.reserveAdoptionClaim({ slug, attemptToken: token, sessionId, reservedAtMs: 100, leaseExpiresAtMs: 200 }), true)
  assert.equal(s.recordAdoptionPane(slug, token, { paneId: "%8", panePid: 800, sessionCreated: 8000 }, 200), true)
  assert.equal(s.finalizeAdoptionClaim(slug, token, row({ slug, session_id: sessionId }), 150), true)
  assert.ok(s.forgetSession(slug))
  assert.equal(s.getSession(slug), undefined)
  assert.equal(s.getAdoptionClaim(slug), undefined)
  assert.ok(s.allRetiredAdoptionAttempts().some((attempt) => attempt.attempt_token === token))
})

test("adopted respawn rotates its claim without an unbound window and failed setup restores a bound no-pane marker", () => {
  const s = store()
  const slug = "adoption-respawn"
  const sessionId = randomUUID()
  const original = randomUUID()
  assert.equal(s.reserveAdoptionClaim({ slug, attemptToken: original, sessionId, reservedAtMs: 100, leaseExpiresAtMs: 200 }), true)
  assert.equal(s.recordAdoptionPane(slug, original, { paneId: "%9", panePid: 900, sessionCreated: 9000 }, 200), true)
  assert.equal(s.finalizeAdoptionClaim(slug, original, row({ slug, session_id: sessionId }), 150), true)

  const failed = randomUUID()
  assert.equal(s.rearmFinalizedAdoptionClaim({
    slug,
    attemptToken: failed,
    sessionId,
    reservedAtMs: 300,
    leaseExpiresAtMs: 400,
  }, original), true)
  assert.equal(s.getAdoptionClaim(slug)?.state, "reserved")
  assert.equal(s.getSession(slug)?.session_id, sessionId, "the registry owner remains present while readers fail closed")
  assert.equal(s.abandonAdoptionClaim(slug, failed), true)
  assert.ok(s.allRetiredAdoptionAttempts().some((attempt) => attempt.attempt_token === original))
  assert.ok(s.allRetiredAdoptionAttempts().some((attempt) => attempt.attempt_token === failed))
  assert.deepEqual(
    {
      state: s.getAdoptionClaim(slug)?.state,
      token: s.getAdoptionClaim(slug)?.attempt_token,
      pane: s.getAdoptionClaim(slug)?.pane_id,
    },
    { state: "finalized", token: failed, pane: null },
  )

  const successful = randomUUID()
  assert.equal(s.rearmFinalizedAdoptionClaim({
    slug,
    attemptToken: successful,
    sessionId,
    reservedAtMs: 500,
    leaseExpiresAtMs: 600,
  }, failed), true)
  assert.equal(s.recordAdoptionPane(slug, successful, { paneId: "%10", panePid: 1000, sessionCreated: 10000 }, 600), true)
  assert.equal(s.finalizeAdoptionRespawnClaim(slug, successful, sessionId, 550), true)
  assert.deepEqual(
    {
      state: s.getAdoptionClaim(slug)?.state,
      token: s.getAdoptionClaim(slug)?.attempt_token,
      pane: s.getAdoptionClaim(slug)?.pane_id,
    },
    { state: "finalized", token: successful, pane: "%10" },
  )
})

test("adoption spawn fence revalidates and binds under one SQLite writer lock; retired tokens cannot spawn", () => {
  const s = store()
  const slug = "spawn-fence"
  const sessionId = randomUUID()
  const token = randomUUID()
  assert.equal(s.reserveAdoptionClaim({ slug, attemptToken: token, sessionId, reservedAtMs: 10, leaseExpiresAtMs: 20 }), true)
  let spawns = 0
  const fenced = s.withAdoptionSpawnFence(slug, token, 100, (bindPane) => {
    spawns++
    const identity = { paneId: "%70", panePid: 7000, sessionCreated: 70000 }
    assert.equal(bindPane(identity, 100), true)
    return identity
  })
  assert.deepEqual(fenced, {
    acquired: true,
    value: { paneId: "%70", panePid: 7000, sessionCreated: 70000 },
  })
  assert.equal(s.abandonAdoptionClaim(slug, token), true)
  assert.equal(s.withAdoptionSpawnFence(slug, token, 200, () => void spawns++).acquired, false)
  assert.equal(spawns, 1, "a retired stale actor never reaches external new-session")
})

test("forgetSessionIfCurrent loses safely to an adoption-token rotation and preserves the successor", () => {
  const s = store()
  const slug = "forget-rotation"
  const sessionId = randomUUID()
  const oldToken = randomUUID()
  assert.equal(s.reserveAdoptionClaim({ slug, attemptToken: oldToken, sessionId, reservedAtMs: 10, leaseExpiresAtMs: 20 }), true)
  assert.equal(s.recordAdoptionPane(slug, oldToken, { paneId: "%71", panePid: 7100, sessionCreated: 71000 }, 20), true)
  assert.equal(s.finalizeAdoptionClaim(slug, oldToken, row({ slug, session_id: sessionId, runtime_generation: 4 }), 15), true)

  const newToken = randomUUID()
  assert.equal(s.rearmFinalizedAdoptionClaim({
    slug,
    attemptToken: newToken,
    sessionId,
    reservedAtMs: 30,
    leaseExpiresAtMs: 40,
  }, oldToken), true)
  assert.equal(s.recordAdoptionPane(slug, newToken, { paneId: "%72", panePid: 7200, sessionCreated: 72000 }, 40), true)
  assert.equal(s.finalizeAdoptionRespawnClaim(slug, newToken, sessionId, 35), true)

  assert.equal(s.forgetSessionIfCurrent(slug, {
    sessionId,
    runtimeGeneration: 4,
    adoptionAttemptToken: oldToken,
  }), undefined)
  assert.equal(s.getSession(slug)?.session_id, sessionId)
  assert.equal(s.getAdoptionClaim(slug)?.attempt_token, newToken)
})

test("session profile: model/effort round-trip and survive a resume-style upsert", () => {
  const s = store()
  s.upsertSession(row({ slug: "profiled", model: "gpt-5.6-sol", effort: "ultra" }))
  let saved = s.getSession("profiled")!
  assert.equal(saved.model, "gpt-5.6-sol")
  assert.equal(saved.effort, "ultra")

  // resumeThread spreads the existing row through upsertSession; the original launch profile must
  // survive instead of being replaced by whatever Settings say at resume time.
  s.upsertSession({ ...saved, spawned_at: "2026-07-01T01:00:00.000Z", exited: 0 })
  saved = s.getSession("profiled")!
  assert.equal(saved.model, "gpt-5.6-sol")
  assert.equal(saved.effort, "ultra")
})

test("profile target/pending/revision and runtime control commit as one exact-owned CAS", () => {
  const s = store()
  s.upsertSession(row({
    slug: "profile-control",
    model: "gpt-5.5",
    effort: "high",
  }))
  s.setBackend("profile-control", "codex")
  s.setAgentSession("profile-control", "native-a")
  const initial = s.getSession("profile-control")!
  const armed = s.armProfileChange("profile-control", {
    sessionId: initial.session_id,
    nativeSessionId: "native-a",
    generation: 0,
  }, { model: "gpt-5.6-sol", effort: "ultra" }, profileHandoff(
    "native-a",
    { model: "gpt-5.5", effort: "high" },
    { model: "gpt-5.6-sol", effort: "ultra" },
  ))
  assert.ok(armed)
  assert.deepEqual(
    {
      model: s.getSession("profile-control")?.model,
      effort: s.getSession("profile-control")?.effort,
      pendingModel: s.getSession("profile-control")?.profile_pending_model,
      pendingEffort: s.getSession("profile-control")?.profile_pending_effort,
      control: s.getSession("profile-control")?.runtime_control,
    },
    { model: "gpt-5.5", effort: "high", pendingModel: "gpt-5.6-sol", pendingEffort: "ultra", control: "profile" },
  )
  assert.equal(s.beginRuntimeControl("profile-control", {
    sessionId: initial.session_id,
    nativeSessionId: "native-a",
    generation: 0,
  }, "ai-rename"), null, "every competing runtime controller loses while the profile claim is armed")

  const generation = s.beginRuntimeGeneration("profile-control", {
    sessionId: initial.session_id,
    generation: 0,
    permissionPending: null,
    runtimeControl: "profile",
  }, "2026-07-01T00:01:00.000Z")
  assert.equal(generation, 1)
  assert.equal(s.commitProfileChange("profile-control", {
    sessionId: initial.session_id,
    nativeSessionId: "native-a",
    generation: 0,
    profileRevision: armed!.profileRevision,
    controlRevision: armed!.controlRevision,
    model: "gpt-5.6-sol",
    effort: "ultra",
    profileHandoff: armed!.profileHandoff,
  }), false, "an old generation cannot commit after the replacement spawn")
  assert.equal(s.commitProfileChange("profile-control", {
    sessionId: initial.session_id,
    nativeSessionId: "native-a",
    generation: 1,
    profileRevision: armed!.profileRevision,
    controlRevision: armed!.controlRevision,
    model: "gpt-5.6-sol",
    effort: "ultra",
    profileHandoff: armed!.profileHandoff,
  }), true)
  const committed = s.getSession("profile-control")!
  assert.equal(committed.model, "gpt-5.6-sol")
  assert.equal(committed.effort, "ultra")
  assert.equal(committed.profile_pending_model, null)
  assert.equal(committed.runtime_control, null)
  s.close()
})

test("observed runtime profiles persist only for the current generation outside a control handoff", () => {
  const s = store()
  s.upsertSession(row({ slug: "observed-profile", model: "opus", effort: "high" }))
  assert.equal(s.beginRuntimeGeneration("observed-profile", {
    sessionId: "sid",
    generation: 0,
    permissionPending: null,
    runtimeControl: null,
  }, "2026-07-01T00:01:00.000Z"), 1)
  assert.equal(s.setObservedProfileIfCurrent("observed-profile", {
    sessionId: "sid",
    generation: 0,
  }, { model: "sonnet", effort: "max" }), false)
  assert.equal(s.setObservedProfileIfCurrent("observed-profile", {
    sessionId: "sid",
    generation: 1,
  }, { model: "sonnet", effort: "max" }), true)
  const current = s.getSession("observed-profile")!
  const armed = s.armProfileChange("observed-profile", {
    sessionId: current.session_id,
    nativeSessionId: current.agent_session_id ?? null,
    generation: 1,
  }, { model: "haiku", effort: "low" }, profileHandoff(
    current.agent_session_id ?? current.session_id,
    { model: "sonnet", effort: "max" },
    { model: "haiku", effort: "low" },
  ))
  assert.ok(armed)
  assert.equal(s.setObservedProfileIfCurrent("observed-profile", {
    sessionId: "sid",
    generation: 1,
  }, { model: "opus", effort: "high" }), false)
  s.close()
})

test("session permission actual/pending values round-trip independently and survive reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-storage-permission-"))
  const path = join(dir, "ui.db")
  const s = createStorage(path, "p")
  s.upsertSession(row({ slug: "permissioned", permission_mode: "auto" }))
  assert.equal(s.getSession("permissioned")?.permission_mode, "auto")
  s.setPermissionMode("permissioned", "bypassPermissions")
  assert.equal(s.getSession("permissioned")?.permission_mode, "bypassPermissions")
  s.setPermissionPending("permissioned", "default")
  assert.equal(s.getSession("permissioned")?.permission_pending, "default")
  s.setControlError("permissioned", "existing draft")
  s.close()

  const reopened = createStorage(path, "p")
  assert.equal(reopened.getSession("permissioned")?.permission_mode, "bypassPermissions")
  assert.equal(reopened.getSession("permissioned")?.permission_pending, "default")
  assert.equal(reopened.getSession("permissioned")?.control_error, "existing draft")
  reopened.setPermissionPending("permissioned", null)
  assert.equal(reopened.getSession("permissioned")?.permission_pending, null)
  reopened.close()
})

test("manual snooze persists exactly across restart, expires atomically, and Archive clears it", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-storage-snooze-"))
  const path = join(dir, "ui.db")
  const exact = "2026-07-14T08:45:12.345Z"
  let s = createStorage(path, "p")
  s.upsertSession(row({ slug: "snoozed", state: "open" }))
  s.setSnoozedUntil("snoozed", exact)
  assert.equal(s.getSession("snoozed")?.snoozed_until, exact)
  s.close()

  s = createStorage(path, "p")
  assert.equal(s.getSession("snoozed")?.snoozed_until, exact, "migration-backed value survives server restart byte-for-byte")
  assert.equal(s.clearExpiredSnoozes("2026-07-14T08:45:12.344Z"), 0)
  assert.equal(s.clearExpiredSnoozes(exact), 1, "the exact deadline is due, not one tick later")
  assert.equal(s.getSession("snoozed")?.snoozed_until, null)

  s.setSnoozedUntil("snoozed", exact)
  s.setState("snoozed", "archived")
  assert.equal(s.getSession("snoozed")?.snoozed_until, null, "Archive is terminal lifecycle state and drops stale snooze")
  s.setState("snoozed", "open")
  assert.equal(s.getSession("snoozed")?.snoozed_until, null, "Reopen never resurrects an old wake deadline")
  s.close()
})

test("a snooze carrying a prompt outlives its deadline for the waker, and the pair is written/cleared atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-storage-snooze-prompt-"))
  const path = join(dir, "ui.db")
  const exact = "2026-07-14T08:45:12.345Z"
  let s = createStorage(path, "p")
  s.upsertSession(row({ slug: "bumps", state: "open" }))
  s.upsertSession(row({ slug: "reminds", state: "open" }))
  s.setSnoozedUntil("bumps", exact, "Check whether CI went green.")
  s.setSnoozedUntil("reminds", exact)
  s.close()

  s = createStorage(path, "p")
  assert.equal(s.getSession("bumps")?.snooze_prompt, "Check whether CI went green.", "the follow-up survives restart")
  // THE LOAD-BEARING ASYMMETRY: the board sweeps elapsed snoozes on every refresh, far more often than
  // the waker ticks. If it swept a prompt-carrying row the scheduled bump would be silently lost.
  assert.equal(s.clearExpiredSnoozes(exact), 1, "only the promptless reminder expires here")
  assert.equal(s.getSession("reminds")?.snoozed_until, null)
  assert.equal(s.getSession("bumps")?.snoozed_until, exact, "the armed bump is the scheduler's to settle, not the board's")

  s.setSnoozedUntil("bumps", null)
  assert.equal(s.getSession("bumps")?.snooze_prompt, null, "wake-now disarms the prompt with the instant")

  s.setSnoozedUntil("bumps", exact, "Land it.")
  s.setState("bumps", "archived")
  assert.deepEqual(
    (({ snoozed_until, snooze_prompt }) => ({ snoozed_until, snooze_prompt }))(s.getSession("bumps")!),
    { snoozed_until: null, snooze_prompt: null },
    "Archive can never leave an armed prompt behind a cleared deadline",
  )
  s.close()
})

test("runtime generations make permission commits compare-and-swap safe", () => {
  const s = store()
  s.upsertSession(row({
    slug: "generation",
    permission_mode: "default",
    permission_pending: "bypassPermissions",
  }))

  const initial = s.getSession("generation")!
  assert.equal(initial.runtime_generation, 0)
  const generation = s.beginRuntimeGeneration(
    "generation",
    { sessionId: initial.session_id, generation: 0, permissionPending: "bypassPermissions" },
    "2026-07-01T03:00:00.000Z",
  )
  assert.equal(generation, 1)
  assert.equal(s.getSession("generation")?.spawned_at, "2026-07-01T03:00:00.000Z")

  assert.equal(
    s.setPermissionStateIfCurrent(
      "generation",
      { sessionId: initial.session_id, generation: 0, permissionPending: "bypassPermissions" },
      { permissionMode: "bypassPermissions", permissionPending: null, controlError: null, exited: false },
    ),
    false,
  )
  assert.equal(
    s.setPermissionStateIfCurrent(
      "generation",
      { sessionId: initial.session_id, generation, permissionPending: "bypassPermissions" },
      { permissionMode: "bypassPermissions", permissionPending: null, controlError: null, exited: false },
    ),
    true,
  )
  assert.equal(
    s.setObservedPermissionIfCurrent("generation", initial.session_id, generation, "bypassPermissions"),
    false,
    "an identical observation is a no-op instead of a WAL write",
  )
  assert.equal(
    s.setObservedPermissionIfCurrent("generation", initial.session_id, generation, "default"),
    true,
  )
  assert.equal(s.getSession("generation")?.permission_mode, "default")

  const replacement = row({
    slug: "generation",
    session_id: "replacement-owner",
    runtime_generation: 0,
    unread: 0,
    exited: 0,
    rested_at: null,
    transcript_id: null,
    state: "archived",
    archived: 1,
  })
  s.upsertSession(replacement)
  s.setState("generation", "archived")
  assert.equal(s.setUnreadIfCurrent("generation", initial.session_id, generation, true), false)
  assert.equal(s.setExitedIfCurrent("generation", initial.session_id, generation, true), false)
  assert.equal(s.setRestedAtIfCurrent(
    "generation", initial.session_id, generation, "2026-07-01T04:00:00.000Z",
  ), false)
  assert.equal(s.setTranscriptIdIfCurrent("generation", initial.session_id, generation, "stale-transcript"), false)
  assert.equal(s.setStateIfCurrent("generation", initial.session_id, generation, "open"), false)
  assert.deepEqual(
    (({ session_id, unread, exited, rested_at, transcript_id, state, archived }) => ({
      session_id, unread, exited, rested_at, transcript_id, state, archived,
    }))(s.getSession("generation")!),
    {
      session_id: "replacement-owner",
      unread: 0,
      exited: 0,
      rested_at: null,
      transcript_id: null,
      state: "archived",
      archived: 1,
    },
  )
})

test("completeIfCurrent atomically settles one exact runtime generation", () => {
  const s = store()
  try {
    s.upsertSession(row({
      slug: "complete",
      session_id: "complete-owner",
      runtime_generation: 4,
      unread: 1,
      exited: 0,
      state: "open",
      archived: 0,
      snoozed_until: "2026-07-15T09:00:00.000Z",
    }))

    assert.equal(s.completeIfCurrent("complete", "stale-owner", 4), false)
    assert.deepEqual(
      (({ exited, state, archived, unread, snoozed_until }) => ({ exited, state, archived, unread, snoozed_until }))(s.getSession("complete")!),
      { exited: 0, state: "open", archived: 0, unread: 1, snoozed_until: "2026-07-15T09:00:00.000Z" },
      "a CAS miss leaves every lifecycle field untouched",
    )

    assert.equal(s.completeIfCurrent("complete", "complete-owner", 4), true)
    assert.deepEqual(
      (({ exited, state, archived, unread, snoozed_until }) => ({ exited, state, archived, unread, snoozed_until }))(s.getSession("complete")!),
      { exited: 1, state: "archived", archived: 1, unread: 0, snoozed_until: null },
      "one statement makes the terminal lifecycle state internally consistent",
    )
  } finally {
    s.close()
  }
})

test("explicit thread title: replaces the generated fallback, clears title_auto, and survives reopen/resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-storage-title-"))
  const path = join(dir, "ui.db")
  const s = createStorage(path, "p")
  s.upsertSession(row({ slug: "generated-slug", title: "generated-slug", title_auto: 1 }))

  s.setTitle("generated-slug", "Human-readable thread title")
  let saved = s.getSession("generated-slug")!
  assert.equal(saved.title, "Human-readable thread title")
  assert.equal(saved.title_auto, 0, "a committed human title must never remain eligible for AI-title replacement")

  // Resume paths spread the existing row through the shared upsert; the explicit-title bit must stick.
  s.upsertSession({ ...saved, exited: 0, spawned_at: "2026-07-01T02:00:00.000Z" })
  saved = s.getSession("generated-slug")!
  assert.equal(saved.title, "Human-readable thread title")
  assert.equal(saved.title_auto, 0)
  s.close()

  const reopened = createStorage(path, "p")
  assert.equal(reopened.getSession("generated-slug")?.title, "Human-readable thread title")
  assert.equal(reopened.getSession("generated-slug")?.title_auto, 0)
  reopened.close()
})

test("conditional AI title commit cannot overwrite a manual rename or replacement session", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-storage-title-cas-"))
  const s = createStorage(join(dir, "ui.db"), "p")
  s.upsertSession(row({ slug: "rename-race", session_id: "old-session", title: "Old title", title_auto: 1 }))
  const expected = { sessionId: "old-session", title: "Old title", titleAuto: 1 }

  s.setTitle("rename-race", "Manual title wins")
  assert.equal(s.setTitleIfCurrent("rename-race", "AI title", expected), false)
  assert.equal(s.getSession("rename-race")?.title, "Manual title wins")

  const manual = s.getSession("rename-race")!
  s.upsertSession({ ...manual, session_id: "replacement-session", title: "Replacement title", title_auto: 1 })
  assert.equal(s.setTitleIfCurrent("rename-race", "AI title", expected), false)
  assert.equal(s.getSession("rename-race")?.title, "Replacement title")
  s.close()
})

// `setAgentTitle` is the WORKER's own considered name, from `mcp__frizz__title`. It writes what the
// auto-title CAS writes and is gated on the same lock, but keyed on the SLUG alone: its caller is the
// live worker's MCP server, which knows only the slug frizz stamped into its env. Both backends reach
// it — unlike the CAS, which the tailer runs for codex rows alone — because a Claude thread's name comes
// from the provider's titler and is never persisted at all, so before this a rested Claude row fell all
// the way back to the raw prompt chop.
test("a worker's own title persists on either backend, and a human's rename refuses it", () => {
  const s = store()
  s.upsertSession(row({ slug: "claude-named", session_id: "sid", title: "Is this true? We should probably…", title_auto: 1 }))
  assert.equal(s.getSession("claude-named")?.title_agent, 0, "a freshly dispatched row holds its chop")

  assert.equal(s.setAgentTitle("claude-named", "Audit the Zod 4.5 docs"), true)
  assert.equal(s.getSession("claude-named")?.title, "Audit the Zod 4.5 docs")
  assert.equal(s.getSession("claude-named")?.title_agent, 1, "the flag the display reads once telemetry is gone")
  // DELIBERATELY untouched: which machine wrote the current text does not change the row's display
  // provenance, and leaving it set is what keeps a later human rename outranking this name.
  assert.equal(s.getSession("claude-named")?.title_auto, 1)

  // A second, better name from the same worker still lands — the task can genuinely turn out to be
  // something else, and nothing about the first registration is a claim on the row.
  assert.equal(s.setAgentTitle("claude-named", "Document z.properties"), true)
  assert.equal(s.getSession("claude-named")?.title, "Document z.properties")

  // THE HUMAN OUTRANKS IT, in both directions: a rename locks the row against every later worker name…
  s.setTitle("claude-named", "Named by hand")
  assert.equal(s.setAgentTitle("claude-named", "Too late"), false)
  assert.equal(s.getSession("claude-named")?.title, "Named by hand")
  assert.equal(s.getSession("claude-named")?.title_agent, 0, "the human's text replaced the worker's, so its provenance goes too")

  // …and a row a human never touched is never locked by the worker writing to it.
  s.upsertSession(row({ slug: "still-open", session_id: "sid2", title: "chop", title_auto: 1 }))
  assert.equal(s.setAgentTitle("still-open", "A considered name"), true)
  assert.equal(sessionTitleLocked(s.getSession("still-open")!), false)
})

test("automatic title CAS persists provenance and rejects manual, native-session, generation, and replacement races", () => {
  const s = store()
  s.upsertSession(row({
    slug: "codex-title",
    session_id: "frizz-session",
    runtime_generation: 3,
    title: "raw initial prompt",
    title_auto: 1,
  }))
  // Dispatch intentionally writes backend identity through dedicated setters after the shared upsert.
  s.setBackend("codex-title", "codex")
  s.setAgentSession("codex-title", "codex-native")
  const expected = { sessionId: "frizz-session", nativeSessionId: "codex-native", runtimeGeneration: 3 }

  assert.equal(s.getSession("codex-title")?.title_agent, 0, "a freshly dispatched row holds its chop, not a worker's name")
  assert.equal(s.setAutoTitleIfCurrent("codex-title", "Useful generated title", expected), true)
  assert.equal(s.getSession("codex-title")?.title, "Useful generated title")
  assert.equal(s.getSession("codex-title")?.title_auto, 1, "automatic provenance stays eligible for a better native title")
  // The flag the display side reads once telemetry is gone: this text is the WORKER's name for the
  // task, so a rested/archived/post-restart row can show it instead of falling back to "Untitled".
  assert.equal(s.getSession("codex-title")?.title_agent, 1)
  assert.equal(
    s.setAutoTitleIfCurrent("codex-title", "Wrong native", { ...expected, nativeSessionId: "other-native" }),
    false,
  )
  assert.equal(
    s.setAutoTitleIfCurrent("codex-title", "Old generation", { ...expected, runtimeGeneration: 2 }),
    false,
  )

  s.setTitle("codex-title", "Manual title wins")
  assert.equal(s.setAutoTitleIfCurrent("codex-title", "Late generated title", expected), false)
  assert.equal(s.getSession("codex-title")?.title, "Manual title wins")
  assert.equal(s.getSession("codex-title")?.title_agent, 0, "a human's rename replaced the text, so the worker's provenance goes with it")

  s.upsertSession(row({
    slug: "codex-title",
    session_id: "replacement-session",
    runtime_generation: 0,
    title: "Replacement fallback",
    title_auto: 1,
  }))
  s.setAgentSession("codex-title", "replacement-native")
  assert.equal(s.setAutoTitleIfCurrent("codex-title", "Old transcript title", expected), false)
  assert.equal(s.getSession("codex-title")?.title, "Replacement fallback")
  assert.equal(s.getSession("codex-title")?.title_agent, 0, "a re-dispatch writes a fresh chop; the previous worker's name is gone")
  s.close()
})

test("a dispatch title a CALLER hard-coded is displayable but replaceable; only a human's locks", () => {
  const s = store()
  // What the GitHub batch and `mcp__frizz__spawn_thread` write: a real-looking name (title_auto 0, so the
  // UI never hides it behind a placeholder) that no human chose (title_locked 0).
  s.upsertSession(row({
    slug: "gh-thread",
    session_id: "frizz-session",
    runtime_generation: 0,
    title: "Investigate acme/app#391",
    title_auto: 0,
    title_locked: 0,
  }))
  s.setBackend("gh-thread", "codex")
  s.setAgentSession("gh-thread", "codex-native")
  const expected = { sessionId: "frizz-session", nativeSessionId: "codex-native", runtimeGeneration: 0 }

  assert.equal(s.setAutoTitleIfCurrent("gh-thread", "Cache key collides on normalized ids", expected), true)
  assert.equal(s.getSession("gh-thread")?.title, "Cache key collides on normalized ids")
  assert.equal(s.getSession("gh-thread")?.title_auto, 0, "the row still holds a real name, not a guess")
  assert.equal(s.getSession("gh-thread")?.title_locked, 0, "and stays open to a better native title")

  // The human renaming it is the ONLY thing that locks — and it locks against every later signal.
  s.setTitle("gh-thread", "Resolver cache bug")
  assert.equal(s.getSession("gh-thread")?.title_locked, 1)
  assert.equal(s.setAutoTitleIfCurrent("gh-thread", "Late generated title", expected), false)
  assert.equal(s.getSession("gh-thread")?.title, "Resolver cache bug")
  s.close()
})

test("a row written without title_locked keeps the pre-split rule: any non-guessed title is the human's", () => {
  const s = store()
  // Every pre-existing caller (and every fixture) omits the column. Absent must read as LOCKED for a
  // real title and UNLOCKED for a machine guess, or the split would silently reopen legacy renames.
  s.upsertSession(row({ slug: "legacy-named", session_id: "sid-a", title: "Legacy renamed thread", title_auto: 0 }))
  s.upsertSession(row({ slug: "legacy-guess", session_id: "sid-b", title: "fix the parser bug", title_auto: 1 }))
  assert.equal(s.getSession("legacy-named")?.title_locked, 1)
  assert.equal(s.getSession("legacy-guess")?.title_locked, 0)

  assert.equal(
    s.setAutoTitleIfCurrent("legacy-named", "generated-slug", { sessionId: "sid-a", nativeSessionId: null, runtimeGeneration: 0 }),
    false,
  )
  assert.equal(
    s.setAutoTitleIfCurrent("legacy-guess", "Parser fix", { sessionId: "sid-b", nativeSessionId: null, runtimeGeneration: 0 }),
    true,
  )
  s.close()
})

// allSessions() is memoised (it was 32% of the server's CPU when it re-read the whole table on every
// tailer tick). These pin the two things the cache must never get wrong: it has to see EVERY kind of
// write, and it must never latch a read taken inside a transaction that then rolls back.
test("allSessions: the cached read reflects every write, and repeats are the same array", () => {
  const s = store()
  assert.equal(s.allSessions().length, 0)

  s.upsertSession(row({ slug: "one", session_id: "sid-1" }))
  assert.deepEqual(s.allSessions().map((r) => r.slug), ["one"], "an insert invalidates")
  const first = s.allSessions()
  assert.equal(s.allSessions(), first, "an unchanged table serves the identical array")

  // A narrow column UPDATE — the shape the tailer/board write constantly — has to invalidate too.
  s.setState("one", "archived")
  assert.equal(s.allSessions()[0].state, "archived", "an update invalidates")
  assert.notEqual(s.allSessions(), first, "…with a freshly-read array")

  s.markRead("one", "2026-08-11T00:00:00.000Z")
  assert.equal(s.allSessions()[0].last_read_at, "2026-08-11T00:00:00.000Z")

  s.forgetSession("one")
  assert.equal(s.allSessions().length, 0, "a delete invalidates")
})

test("allSessions: getSession rides the same snapshot and never lags it", () => {
  const s = store()
  s.upsertSession(row({ slug: "one", session_id: "sid-1", title: "before" }))
  s.allSessions() // prime the snapshot getSession will read off
  assert.equal(s.getSession("one")?.title, "before")

  s.setTitle("one", "after")
  assert.equal(s.getSession("one")?.title, "after", "a write invalidates the single-row read too")

  // A row the snapshot has never seen still resolves — a miss falls through to the database.
  s.upsertSession(row({ slug: "two", session_id: "sid-2" }))
  assert.equal(s.getSession("two")?.session_id, "sid-2")
  assert.equal(s.getSession("never-dispatched"), undefined)

  s.forgetSession("one")
  assert.equal(s.getSession("one"), undefined, "a delete invalidates it")
})

test("allSessions: a rolled-back transaction never leaves the cache holding data that was undone", () => {
  const s = store()
  s.upsertSession(row({ slug: "keeper", session_id: "sid-1", title: "before" }))
  assert.equal(s.allSessions()[0].title, "before")

  assert.throws(() => {
    s.db.transaction(() => {
      s.setTitle("keeper", "during")
      // Reading here is what used to poison the cache: total_changes() has already moved, and a
      // ROLLBACK does not wind it back, so this row would have outlived the transaction that wrote it.
      assert.equal(s.allSessions()[0].title, "during", "inside the transaction the write is visible")
      throw new Error("roll it back")
    })()
  }, /roll it back/)

  assert.equal(s.allSessions()[0].title, "before", "the rolled-back title is gone from the cache too")
})

test("forgetSession: DELETEs the row and returns it; the slug is gone", () => {
  const s = store()
  s.upsertSession(row({ slug: "phantom", session_id: "sid-1" }))
  s.recordSubAgentSteer({ slug: "phantom", subAgentId: "child", deliveryId: "d1", message: "follow up", sentAtMs: 1 })
  assert.ok(s.getSession("phantom"), "row exists before forget")

  const forgotten = s.forgetSession("phantom")
  assert.equal(forgotten?.slug, "phantom")
  assert.equal(forgotten?.session_id, "sid-1")
  assert.equal(s.getSession("phantom"), undefined, "the row is hard-deleted")
  assert.deepEqual(s.listSubAgentSteers("phantom", "child"), [], "its child-message journal is deleted too")
  assert.equal(s.allSessions().length, 0)
})

test("forgetSession: tombstones session_id AND any discovered transcript_id", () => {
  const s = store()
  s.upsertSession(row({ slug: "drifted", session_id: "sid-2", transcript_id: "drifted-transcript" }))
  s.forgetSession("drifted")
  const tombs = s.forgottenIds()
  assert.ok(tombs.has("sid-2"), "the pinned session id is tombstoned")
  assert.ok(tombs.has("drifted-transcript"), "the discovered transcript id is tombstoned")
})

test("forgetSession: no transcript_id → only the session id is tombstoned", () => {
  const s = store()
  s.upsertSession(row({ slug: "plain", session_id: "sid-3" }))
  s.forgetSession("plain")
  assert.deepEqual([...s.forgottenIds()], ["sid-3"])
})

test("forgetSession: idempotent — forgetting an absent/already-forgotten slug is a no-op", () => {
  const s = store()
  assert.equal(s.forgetSession("never-existed"), undefined)
  s.upsertSession(row({ slug: "once", session_id: "sid-4" }))
  s.forgetSession("once")
  // A second forget finds no row and adds no new tombstone (the first one stays).
  assert.equal(s.forgetSession("once"), undefined)
  assert.deepEqual([...s.forgottenIds()], ["sid-4"])
})

test("forgetSession: a fresh re-dispatch of the same slug (NEW session_id) is unaffected by the tombstone", () => {
  const s = store()
  s.upsertSession(row({ slug: "reused", session_id: "old-sid" }))
  s.forgetSession("reused")
  // Re-dispatch reuses the freed slug with a brand-new session id — the row comes back, and the old
  // session id stays tombstoned (harmless: nothing points at it).
  s.upsertSession(row({ slug: "reused", session_id: "new-sid" }))
  assert.equal(s.getSession("reused")?.session_id, "new-sid")
  const tombs = s.forgottenIds()
  assert.ok(tombs.has("old-sid"))
  assert.ok(!tombs.has("new-sid"), "the live session's id is never tombstoned")
})

// ── the session-guarded park ────────────────────────────────────────────────────────────────────────

test("setSnoozedUntilIfCurrent parks only the current session+generation and leaves the bump untouched", () => {
  const s = store()
  s.upsertSession(row({ slug: "aw6", session_id: "sid", state: "open" }))
  assert.equal(s.setSnoozedUntilIfCurrent("aw6", "stale", 0, "2099-07-14T08:45:00.000Z"), false)
  assert.equal(s.setSnoozedUntilIfCurrent("aw6", "sid", 0, "2099-07-14T08:45:00.000Z"), true)
  assert.equal(s.getSession("aw6")?.snoozed_until, "2099-07-14T08:45:00.000Z")
})

test("setPermissionMode stamps the operator set-time; the observed write-back never touches it", () => {
  const s = store()
  s.upsertSession(row({ slug: "px", backend: "codex", permission_mode: "default" }))
  assert.equal(s.getSession("px")?.permission_set_at ?? null, null, "not stamped until the operator sets it")

  s.setPermissionMode("px", "bypassPermissions")
  const setAt = s.getSession("px")?.permission_set_at
  assert.ok(setAt && !Number.isNaN(Date.parse(setAt)), "the operator set-time is stamped as an ISO instant")
  assert.equal(s.getSession("px")?.permission_mode, "bypassPermissions")

  // The tailer's observed write-back changes the mode but must NOT re-stamp the operator set-time,
  // or the board's set-time-vs-observed comparison would always look freshly-operator-set.
  const gen = s.getSession("px")?.runtime_generation ?? 0
  s.setObservedPermissionIfCurrent("px", s.getSession("px")!.session_id, gen, "default")
  assert.equal(s.getSession("px")?.permission_set_at, setAt, "observed write-back leaves permission_set_at untouched")
})

test("setProfile stamps the operator set-time; the observed write-back never touches it", () => {
  const s = store()
  s.upsertSession(row({ slug: "pf", backend: "codex", model: "gpt-5.6-sol", effort: "xhigh" }))
  assert.equal(s.getSession("pf")?.profile_set_at ?? null, null, "not stamped until the operator sets it")

  s.setProfile("pf", "gpt-5.6-sol", "low")
  const setAt = s.getSession("pf")?.profile_set_at
  assert.ok(setAt && !Number.isNaN(Date.parse(setAt)), "the operator set-time is stamped as an ISO instant")
  assert.equal(s.getSession("pf")?.effort, "low")

  // The tailer's observed profile write-back changes model/effort but must NOT re-stamp the set-time,
  // or the board's set-time-vs-observed comparison would always look freshly-operator-set.
  const gen = s.getSession("pf")?.runtime_generation ?? 0
  s.setObservedProfileIfCurrent("pf", { sessionId: s.getSession("pf")!.session_id, generation: gen }, { model: "gpt-5.6-sol", effort: "xhigh" })
  assert.equal(s.getSession("pf")?.profile_set_at, setAt, "observed write-back leaves profile_set_at untouched")
})

test("the observed write-back never overwrites an operator's pick on a claude row, but still converges a codex one", () => {
  const s = store()

  // CLAUDE: model/effort are fixed at fork time, so a pick is a target for the NEXT fork and the daemon
  // still running the old model keeps writing records that report it. Those readings must not take the
  // pick back — which is what they did, silently, until 2026-09-03: `opus` set on a live thread reverted
  // to `fable` within minutes, and the composer's selector reads the same row, so the pick just vanished.
  // `backend` is not one of upsertSession's columns — it is its own write, exactly as dispatch does it.
  s.upsertSession(row({ slug: "cl", model: "fable", effort: "xhigh" }))
  s.setBackend("cl", "claude")
  const claude = s.getSession("cl")!
  const expectClaude = { sessionId: claude.session_id, generation: claude.runtime_generation ?? 0 }
  assert.equal(
    s.setObservedProfileIfCurrent("cl", expectClaude, { model: "opus", effort: "high" }),
    true,
    "with nobody having chosen, the transcript's reading is the only one there is",
  )

  s.setProfile("cl", "opus", "xhigh")
  assert.equal(
    s.setObservedProfileIfCurrent("cl", expectClaude, { model: "fable", effort: "xhigh" }),
    false,
    "the daemon's own reading cannot overwrite the pick made for the next fork",
  )
  assert.equal(s.getSession("cl")?.model, "opus")
  assert.equal(s.getSession("cl")?.effort, "xhigh")

  // CODEX takes model/effort per turn, so the next turn genuinely runs on the pick and the turn_context
  // it writes is a true reading of that. Convergence there is deliberate — see resolveSessionProfile.
  s.upsertSession(row({ slug: "cx", session_id: "sid-cx", model: "gpt-5.6-sol", effort: "low" }))
  s.setBackend("cx", "codex")
  const codex = s.getSession("cx")!
  s.setProfile("cx", "gpt-5.6-sol", "low")
  assert.equal(
    s.setObservedProfileIfCurrent("cx", { sessionId: codex.session_id, generation: codex.runtime_generation ?? 0 }, { model: "gpt-5.6-sol", effort: "xhigh" }),
    true,
    "a codex row still converges on what its turn actually ran with",
  )
  assert.equal(s.getSession("cx")?.effort, "xhigh")
  s.close()
})

// ---- thread_watch: a worker's registered wait on its own running work (2026-08-26) ----
//
// The registry that was retired on 2026-08-14 and is coming back for the reason its own retirement note
// records: a fence has the LIFETIME of the message carrying it, so a worker must restate the same wait at
// every rest or lose it. A row does not need restating. See plans/rest-by-registration.md.
//
// What makes a durable row safe this time is the two columns the old table lacked: a stored KIND, and a
// REQUIRED expiry that cancels the row and wakes the thread rather than letting a registration outlive
// its own relevance.
test("a registered watch is idempotent by (thread, kind, target), and re-registering never moves its expiry", () => {
  const s = store()
  try {
    const at = 1_700_000_000_000
    const first = s.armThreadWatch({ id: "wch_1", slug: "t", kind: "shell", target: "bzvtnt3ig", createdAtMs: at, expiresAtMs: at + 3600_000 })
    assert.equal(first.state, "armed")
    assert.equal(first.expires_at, at + 3600_000)

    // A worker woken by an expiry re-registers the same wait; a worker that simply calls twice must not
    // leave two rows to drop. The EXISTING row comes back — replacing it would silently move an expiry
    // the human may already be reading off the card.
    const again = s.armThreadWatch({ id: "wch_2", slug: "t", kind: "shell", target: "bzvtnt3ig", createdAtMs: at + 5_000, expiresAtMs: at + 99_999_999 })
    assert.equal(again.id, "wch_1", "the armed row is returned, not a second one")
    assert.equal(again.expires_at, at + 3600_000, "and its expiry is untouched")
    assert.equal(s.listThreadWatches("t", { armedOnly: true }).length, 1)

    // The triple is the key, so the same target under a different KIND is a different wait — and so is
    // the same target on another thread.
    s.armThreadWatch({ id: "wch_3", slug: "t", kind: "agent", target: "bzvtnt3ig", createdAtMs: at, expiresAtMs: at + 3600_000 })
    s.armThreadWatch({ id: "wch_4", slug: "other", kind: "shell", target: "bzvtnt3ig", createdAtMs: at, expiresAtMs: at + 3600_000 })
    assert.deepEqual(s.listThreadWatches("t", { armedOnly: true }).map((w) => w.id), ["wch_1", "wch_3"])
    assert.deepEqual(s.listThreadWatches("other", { armedOnly: true }).map((w) => w.id), ["wch_4"])
  } finally {
    s.close()
  }
})

test("an elapsed watch is due, a dropped one is not, and one thread can never drop another's row", () => {
  const s = store()
  try {
    const at = 1_700_000_000_000
    s.armThreadWatch({ id: "wch_soon", slug: "t", kind: "shell", target: "a", createdAtMs: at, expiresAtMs: at + 60_000 })
    s.armThreadWatch({ id: "wch_later", slug: "t", kind: "shell", target: "b", createdAtMs: at, expiresAtMs: at + 7200_000 })

    assert.deepEqual(s.expiredThreadWatches(at + 30_000).map((w) => w.id), [], "nothing is due before its timeout")
    assert.deepEqual(s.expiredThreadWatches(at + 60_000).map((w) => w.id), ["wch_soon"], "due AT the instant, not after it")

    // The worker's own unwatch, scoped to its thread.
    assert.equal(s.dropThreadWatch("other", "wch_later", at + 1_000), false, "another thread cannot drop it")
    assert.equal(s.dropThreadWatch("t", "wch_later", at + 1_000), true)
    assert.equal(s.dropThreadWatch("t", "wch_later", at + 2_000), false, "and dropping is not repeatable")
    assert.deepEqual(s.expiredThreadWatches(at + 99_999_999).map((w) => w.id), ["wch_soon"], "a dropped row is never due")

    // Dropping frees the triple, so the same wait can be registered again — the unique index is partial.
    const rearmed = s.armThreadWatch({ id: "wch_again", slug: "t", kind: "shell", target: "b", createdAtMs: at + 3_000, expiresAtMs: at + 3600_000 })
    assert.equal(rearmed.id, "wch_again")

    // Settling records that the row is no longer a reason to wait; the runtime's own notification is what
    // actually woke the thread, so this only closes the row.
    assert.equal(s.settleThreadWatch("wch_soon", at + 4_000), true)
    assert.equal(s.getThreadWatch("wch_soon")?.state, "settled")
    assert.equal(s.settleThreadWatch("wch_soon", at + 5_000), false, "and only once")
    assert.equal(s.settleThreadWatch("wch_again", at + 6_000, "expired"), true)
    assert.equal(s.getThreadWatch("wch_again")?.state, "expired", "an elapsed timeout closes the row as expired, not settled")

    // The scheduler's MACHINE-WIDE sweep, which has to ask every armed row whether its work is still
    // running. Only armed rows: the three closed above are settled business.
    s.armThreadWatch({ id: "wch_x", slug: "other", kind: "agent", target: "c", createdAtMs: at, expiresAtMs: at + 3600_000 })
    assert.deepEqual(s.armedThreadWatches().map((w) => w.id), ["wch_x"])
  } finally {
    s.close()
  }
})

// ---- thread_question: a worker's registered question for the human (2026-08-26) ----
//
// The other half of plans/rest-by-registration.md. What separates it from thread_watch is that it waits
// on a PERSON: there is no expiry, so nothing but an answer, a withdrawal or a dismissal ever closes it.
test("a question is registered, answered, and delivered as three separate facts", () => {
  const s = store()
  try {
    const at = 1_700_000_000_000
    const row = s.askThreadQuestion({ id: "q_1", slug: "t", spec: '{"text":"SQLite or JSON?"}', askedAtMs: at })
    assert.deepEqual({ state: row.state, answer: row.answer, delivered: row.delivered }, { state: "open", answer: null, delivered: 0 })

    // NEVER IDEMPOTENT, unlike a watch: two identically-worded questions are two things the human owes
    // an answer to, and collapsing them would silently drop one.
    s.askThreadQuestion({ id: "q_2", slug: "t", spec: '{"text":"SQLite or JSON?"}', askedAtMs: at + 1 })
    assert.deepEqual(s.listThreadQuestions("t", { openOnly: true }).map((q) => q.id), ["q_1", "q_2"])

    assert.equal(s.answerThreadQuestion("q_1", '{"q_1":"SQLite"}', at + 10), true)
    assert.equal(s.answerThreadQuestion("q_1", '{"q_1":"JSON"}', at + 20), false, "an answered question cannot be answered twice")
    assert.equal(s.getThreadQuestion("q_1")?.answer, '{"q_1":"SQLite"}')

    // ANSWERING AND DELIVERING ARE SEPARATE, exactly as they are for a wake: an answer given while the
    // worker's process was down has to survive the gap, or it is lost in the same silence the fenced
    // question used to lose the QUESTION in.
    assert.deepEqual(s.undeliveredSettlements().map((q) => q.id), ["q_1"])
    assert.equal(s.markSettlementDelivered("q_1"), true)
    assert.equal(s.markSettlementDelivered("q_1"), false, "and only once")
    assert.deepEqual(s.undeliveredSettlements(), [])
  } finally {
    s.close()
  }
})

// The delivery composes the Answers card the human reads back, and the question cards rendered in asked
// order — so a batch answered in one click (one `settled_at` for every row, random `qst_…` ids) must come
// back in asked order, not shuffled by the id tiebreak. Same bug as the 2026-08-28 rowid fix on the
// question list, one statement over.
test("a batch of answers is delivered in ASKED order, not shuffled by id", () => {
  const s = store()
  try {
    const at = 1_700_000_000_000
    // Ids deliberately out of lexicographic order relative to insertion, same askedAtMs across the batch
    // (the router stamps one `now` per ask call) — an `id` tiebreak would read this back q_a, q_b, q_c.
    for (const id of ["q_c", "q_a", "q_b"]) s.askThreadQuestion({ id, slug: "t", spec: "{}", askedAtMs: at })
    for (const id of ["q_c", "q_a", "q_b"]) s.answerThreadQuestion(id, `{"${id}":"x"}`, at + 10)
    assert.deepEqual(s.undeliveredSettlements().map((q) => q.id), ["q_c", "q_a", "q_b"])
  } finally {
    s.close()
  }
})

test("withdrawn and dismissed are DIFFERENT settlements, and neither is deliverable", () => {
  const s = store()
  try {
    const at = 1_700_000_000_000
    s.askThreadQuestion({ id: "q_w", slug: "t", spec: "{}", askedAtMs: at })
    s.askThreadQuestion({ id: "q_d", slug: "t", spec: "{}", askedAtMs: at + 1 })
    s.askThreadQuestion({ id: "q_open", slug: "other", spec: "{}", askedAtMs: at + 2 })

    // `unask` is the WORKER's, and thread-scoped so one thread can never withdraw another's question.
    assert.equal(s.withdrawThreadQuestion("other", "q_w", at + 5), false)
    assert.equal(s.withdrawThreadQuestion("t", "q_w", at + 5), true)
    assert.equal(s.withdrawThreadQuestion("t", "q_w", at + 6), false, "and not repeatable")

    // The human's x is NOT thread-scoped — it is the human's own action on their own board.
    assert.equal(s.dismissThreadQuestion("q_d", at + 7), true)

    // The two states answer different questions about what happened, and the worker is told which.
    assert.equal(s.getThreadQuestion("q_w")?.state, "withdrawn")
    assert.equal(s.getThreadQuestion("q_d")?.state, "dismissed")
    // A WITHDRAWAL is never handed over — the worker did that itself, so telling it would be reading its
    // own move back to it. A DISMISSAL is, because "the human decided not to answer" is news it needs.
    assert.deepEqual(s.undeliveredSettlements().map((q) => q.id), ["q_d"])
    assert.deepEqual(s.listThreadQuestions("t", { openOnly: true }), [])
    // A settled question cannot be answered back into life.
    assert.equal(s.answerThreadQuestion("q_w", '{"x":1}', at + 8), false)

    // The machine-wide open set — what the `done` gate and the board both read.
    assert.deepEqual(s.openThreadQuestions().map((q) => q.id), ["q_open"])
  } finally {
    s.close()
  }
})

test("pinned_at: a pre-pin unified file gains the column, the pin persists, and Archive leaves it", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-storage-pin-"))
  const path = join(dir, "ui.db")
  // THE FILE EVERY LIVE INSTALL HAS: a unified db created before the column existed. Built from the
  // real DDL with the one line stripped, so the ALTER in ensureStorageSchema is what must add it back —
  // CREATE TABLE IF NOT EXISTS alone would leave this file columnless and every session write throwing.
  const prePin = new Database(path)
  const stripped = STORAGE_SCHEMA.replace(/^\s*pinned_at\s+TEXT,\n/m, "")
  assert.notEqual(stripped, STORAGE_SCHEMA, "the strip found the column line (keep this regex with the DDL)")
  prePin.exec(stripped)
  prePin.close()

  const at = "2026-09-02T17:00:00.000Z"
  let s = createStorage(path, "p")
  try {
    s.upsertSession(row({ slug: "pinned", state: "open" }))
    s.setPinnedAt("pinned", at)
    assert.equal(s.getSession("pinned")?.pinned_at, at)
    s.close()

    s = createStorage(path, "p")
    assert.equal(s.getSession("pinned")?.pinned_at, at, "the pin survives a server restart byte-for-byte")
    // The pin outranks Done: Archive clears a snooze (lifecycle above) but must NOT clear a pin — a
    // pinned thread that finishes stays on the pinned shelf until the human unpins it.
    s.setState("pinned", "archived")
    assert.equal(s.getSession("pinned")?.pinned_at, at, "Archive leaves the pin in place")
    s.setPinnedAt("pinned", null)
    assert.equal(s.getSession("pinned")?.pinned_at, null, "unpin clears it")
  } finally {
    s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── the batched registry reads ──────────────────────────────────────────────────────────────────────
// The board reads five per-thread tables for EVERY row it assembles, and it used to ask each of them
// one thread at a time: 2,790 statements per rebuild on the maintainer's 558-thread board, all of it
// synchronous and all of it on the event loop. The `…BySlug` readers ask each table once instead. That
// is only safe while each one answers EXACTLY what the per-thread call answers — same predicate, same
// order, same empty — so this pins the two against each other rather than against a hand-written
// expectation, which would drift the moment either statement is edited.
test("the batched registry reads answer exactly what the per-thread reads answer", () => {
  const s = store()
  const NOW = 1_800_000_000_000
  const slugs = ["alpha", "beta", "gamma", "delta", "epsilon"]
  // `epsilon` is deliberately given NOTHING: a thread with no rows must read back as the empty array
  // the per-thread call returns, not as a missing map entry a caller forgot to default.
  for (const [index, slug] of slugs.slice(0, 4).entries()) {
    for (let k = 0; k < 3; k++) {
      // TIES ON PURPOSE. Every one of these orders on a time column the rows here SHARE, so only the
      // secondary key can separate them — `id` for the registries, `rowid` for the questions, which is
      // insertion order and the only thing that keeps one ask's questions in the order it wrote them.
      const timerId = `tmr_${index}${k}`
      s.armThreadTimer({ id: timerId, slug, prompt: `p${k}`, fireAtMs: NOW + 60_000, createdAtMs: NOW })
      if (k === 0) s.cancelThreadTimer(slug, timerId, NOW)

      const prId = `prw_${index}${k}`
      s.armPrWatch({ id: prId, slug, owner: "o", repo: "r", number: 10 + k, createdAtMs: NOW, expiresAtMs: NOW + 60_000 })
      if (k === 1) s.dropPrWatch(slug, prId, NOW)

      const watchId = `wch_${index}${k}`
      s.armThreadWatch({ id: watchId, slug, kind: k % 2 ? "agent" : "shell", target: `t${k}`, createdAtMs: NOW, expiresAtMs: NOW + 60_000 })
      if (k === 2) s.settleThreadWatch(watchId, NOW, "expired")

      const questionId = `qst_${index}${k}`
      s.askThreadQuestion({ id: questionId, slug, spec: `{"q":${k}}`, askedAtMs: NOW })
      if (k === 0) s.answerThreadQuestion(questionId, "yes", NOW)
      if (k === 1) s.dismissThreadQuestion(questionId, NOW)
    }
    if (index % 2 === 0) s.markThreadDone(slug, `done ${index}`, NOW)
  }

  const timers = s.armedThreadTimersBySlug()
  const prWatches = s.armedPrWatchesBySlug()
  const watches = s.armedThreadWatchesBySlug()
  const questions = s.threadQuestionsBySlug()
  const done = s.threadDoneBySlug()
  for (const slug of slugs) {
    // deepEqual over an ARRAY is order-sensitive, which is what pins the ORDER BY.
    assert.deepEqual(timers.get(slug) ?? [], s.listThreadTimers(slug, { armedOnly: true }), `timers: ${slug}`)
    assert.deepEqual(prWatches.get(slug) ?? [], s.listPrWatches(slug, { armedOnly: true }), `pr watches: ${slug}`)
    assert.deepEqual(watches.get(slug) ?? [], s.listThreadWatches(slug, { armedOnly: true }), `watches: ${slug}`)
    // UNFILTERED, matching the board: it takes the open questions AND the just-answered ones off this
    // one list, so an `openOnly` batched read would silently drop `answersInFlight`.
    assert.deepEqual(questions.get(slug) ?? [], s.listThreadQuestions(slug), `questions: ${slug}`)
    assert.deepEqual(done.get(slug), s.getThreadDone(slug), `done: ${slug}`)
  }

  // The predicate is load-bearing, so prove the fixture can see it: each armed-only read must be a
  // STRICT subset of the unfiltered one, or the comparisons above would pass on an empty difference.
  assert.equal(timers.get("alpha")!.length, 2, "one of alpha's three timers is cancelled")
  assert.equal(prWatches.get("alpha")!.length, 2, "one of alpha's three PR watchers is dropped")
  assert.equal(watches.get("alpha")!.length, 2, "one of alpha's three watches is expired")
  assert.equal(questions.get("alpha")!.length, 3, "questions are read whole, settled ones included")
  assert.equal(timers.get("epsilon"), undefined, "a thread with no rows is absent, and reads back as []")
  assert.equal(done.get("beta"), undefined, "so is a thread with no completion")
  s.close()
})
