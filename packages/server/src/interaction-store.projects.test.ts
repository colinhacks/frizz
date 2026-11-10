// ONE DATABASE, EVERY PROJECT, for the interaction journal too.
//
// Each project's Storage builds its own interaction store over the one shared connection. Until
// 2026-11-10 that store prepared its statements straight on the connection, so the ones that reach rows
// by something other than their owner (a deadline, a session, a provider's RPC id) saw every project's.
// These drive two real Storages over one real file, the way a server with two projects open does.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InteractionRequest } from "@frizz/shared"
import Database from "./sqlite.ts"
import { InteractionStoreError } from "./interaction-store.ts"
import { createStorage } from "./storage.ts"

const PROVIDER = "codex-app-server"

function approval(projectId: string, opts: { expiresAt?: string | null; thread?: string; session?: string; n?: number } = {}) {
  const n = opts.n ?? 1
  return InteractionRequest.parse({
    protocolVersion: 1,
    contentFormat: "plain-text",
    provider: { kind: "codex", version: "0.144.1" },
    source: { kind: "runtime", id: "runtime-1", label: "Codex" },
    owner: {
      projectId,
      threadSlug: opts.thread ?? "fix-auth",
      sessionId: opts.session ?? `session-${projectId}`,
      turnId: `turn-${n}`,
      itemId: `item-${n}`,
      sessionEpoch: 1,
      capabilityRevision: 1,
    },
    providerRequestId: `request-${projectId}-${n}`,
    allowedDecisions: [
      { id: "approve-once", semantic: "approve", label: "Approve once" },
      { id: "deny", semantic: "deny", label: "Deny" },
      { id: "cancel", semantic: "cancel", label: "Cancel" },
    ],
    payload: { kind: "command-approval", title: "Command approval", command: { summary: "Run tests", preview: "pnpm test", redacted: true } },
    expiresAt: opts.expiresAt ?? null,
  })
}

// What a project's Codex bridge passes: its own connection epoch, counted from 1, and the app-server's
// own JSON-RPC id, counted from 0. Two projects reach the same pair on their first request.
const binding = (projectId: string, epoch = 1, rpcRequestId = 0) => ({
  provider: PROVIDER,
  logicalRequestId: `logical-${projectId}-${epoch}-${rpcRequestId}`,
  method: "item/commandExecution/requestApproval",
  connectionEpoch: epoch,
  rpcRequestId,
  providerContext: { fingerprint: "a".repeat(64) },
})

const scopeOf = (projectId: string, thread = "fix-auth", session = `session-${projectId}`) => ({ projectId, threadSlug: thread, sessionId: session })

function twoProjects(prepare?: (db: Database) => void) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-interaction-projects-"))
  const db = new Database(join(dir, "ui.db"))
  db.pragma("busy_timeout = 5000")
  db.pragma("journal_mode = WAL")
  prepare?.(db)
  const a = createStorage(db, "project-a")
  const b = createStorage(db, "project-b")
  return { db, a, b, close() { a.close(); b.close(); db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const code = (fn: () => unknown): string | undefined => {
  try { fn() } catch (error) { return error instanceof InteractionStoreError ? error.code : `threw ${String(error)}` }
  return undefined
}

// The sweep runs from every open project's board rebuild. A's used to expire B's overdue approval card
// and announce it to A's listeners, which drop a change that is not theirs; B's listeners, the board
// and the bridge that answers B's blocked worker, heard nothing, and B's own sweep then found nothing
// left to announce.
test("a project's sweep expires its own cards alone, and the project that owns a card is the one told", async () => {
  const h = twoProjects()
  try {
    const heardByA: string[] = []
    const heardByB: string[] = []
    h.a.interactions.subscribe((change) => heardByA.push(`${change.projectId}:${change.lifecycle}`))
    h.b.interactions.subscribe((change) => heardByB.push(`${change.projectId}:${change.lifecycle}`))
    const soon = new Date(Date.now() + 5_000).toISOString()
    const later = new Date(Date.now() + 10_000).toISOString()
    const mine = h.a.interactions.create(approval("project-a", { expiresAt: soon })).interaction
    const theirs = h.b.interactions.create(approval("project-b", { expiresAt: soon })).interaction
    await new Promise((resolve) => setImmediate(resolve))
    heardByA.length = 0
    heardByB.length = 0

    const sweptByA = h.a.interactions.expireDue(later)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(sweptByA.map((record) => record.id), [mine.id], "A's sweep ends A's card")
    assert.equal(h.b.interactions.get(scopeOf("project-b"), theirs.id)?.lifecycle, "pending", "and leaves B's for B")
    assert.deepEqual(heardByA, ["project-a:expired"])
    assert.deepEqual(heardByB, [], "nothing of B's has changed yet")

    const sweptByB = h.b.interactions.expireDue(later)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(sweptByB.map((record) => record.id), [theirs.id])
    assert.deepEqual(heardByB, ["project-b:expired"], "B's own listeners hear B's card expire")
    assert.deepEqual(heardByA, ["project-a:expired"], "and A hears nothing more")
  } finally { h.close() }
})

test("ending a session's cards reaches that project's session only, even where a slug and a session id repeat", () => {
  const h = twoProjects()
  try {
    const mine = h.a.interactions.create(approval("project-a", { session: "same-session" })).interaction
    const theirs = h.b.interactions.create(approval("project-b", { session: "same-session" })).interaction
    const cancelled = h.a.interactions.cancelForSession("fix-auth", "same-session", "session-replaced")
    assert.deepEqual(cancelled.map((record) => record.id), [mine.id])
    assert.equal(h.b.interactions.get(scopeOf("project-b", "fix-auth", "same-session"), theirs.id)?.lifecycle, "pending")
  } finally { h.close() }
})

// Every project's bridge counts its connection epochs from 1 and a provider numbers its requests from
// 0, so (1, 0) is the first approval either project ever raises. The second one used to be refused
// "provider request id is already bound to another interaction", and the worker saw no card.
test("two projects each hold a provider request on the same connection epoch and request id", () => {
  const h = twoProjects()
  try {
    const first = h.a.interactions.createProviderRequest(approval("project-a"), binding("project-a"))
    const second = h.b.interactions.createProviderRequest(approval("project-b"), binding("project-b"))
    assert.equal(first.effect, "created")
    assert.equal(second.effect, "created")
    assert.notEqual(first.interaction.id, second.interaction.id)

    // …and each project's bridge then finds its OWN delivery by that pair, never the other's.
    const answer = (interaction: typeof first.interaction) => ({
      slug: interaction.owner.threadSlug,
      sessionId: interaction.owner.sessionId,
      interactionId: interaction.id,
      sessionEpoch: interaction.owner.sessionEpoch,
      capabilityRevision: interaction.owner.capabilityRevision,
      expectedRecordRevision: interaction.recordRevision,
      responseId: `response-${interaction.id}`,
      decisionId: interaction.allowedDecisions[0]!.id,
    })
    assert.equal(h.a.interactions.queueProviderResponse(scopeOf("project-a"), answer(first.interaction), { decision: "accept" }).effect, "queued")
    assert.deepEqual(h.a.interactions.listQueuedProviderResponses(PROVIDER, 1).map((d) => d.interactionId), [first.interaction.id])
    assert.deepEqual(h.b.interactions.listQueuedProviderResponses(PROVIDER, 1), [], "B's bridge is not handed A's queued answer")
    assert.equal(code(() => h.b.interactions.claimProviderResponseForSend(first.interaction.id, 1, 0)), "not-found", "nor can it send it")
  } finally { h.close() }
})

test("a project's store refuses to journal a card for another project", () => {
  const h = twoProjects()
  try {
    assert.equal(code(() => h.a.interactions.create(approval("project-b"))), "owner-mismatch")
    assert.equal(code(() => h.a.interactions.createProviderRequest(approval("project-b"), binding("project-b"))), "owner-mismatch")
    assert.deepEqual(h.b.interactions.listPending(scopeOf("project-b")), [])
    // Its reads answer for its own project too: A cannot list B's cards by naming B as the owner.
    const theirs = h.b.interactions.create(approval("project-b")).interaction
    assert.deepEqual(h.a.interactions.listPending(scopeOf("project-b")), [])
    assert.equal(h.a.interactions.get(scopeOf("project-b"), theirs.id), undefined)
  } finally { h.close() }
})

// A constraint written into CREATE TABLE cannot be dropped, so the 2026-08-27 change that meant to scope
// this by project left it standing in every database made before 2026-11-10. This is that table, as
// those files hold it, with a row in it.
const BEFORE = (contextColumn: boolean) => `
  CREATE TABLE interaction_provider_delivery (
    interaction_id         TEXT PRIMARY KEY REFERENCES interaction_journal(id) ON DELETE CASCADE,
    project_id             TEXT NOT NULL,
    provider               TEXT NOT NULL,
    logical_request_id     TEXT NOT NULL,
    request_method         TEXT NOT NULL,
    connection_epoch       INTEGER NOT NULL CHECK (connection_epoch >= 0),
    rpc_request_id_json    TEXT NOT NULL,
    state                  TEXT NOT NULL CHECK (state IN ('awaiting-user', 'queued', 'sent', 'acknowledged', 'cancelled')),
    response_id            TEXT,
    provider_response_json TEXT,
    ${contextColumn ? "provider_context_json  TEXT," : ""}
    resolution_json        TEXT,
    attempts               INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    sent_at                TEXT,
    acknowledged_at        TEXT,
    UNIQUE (provider, connection_epoch, rpc_request_id_json),
    UNIQUE (project_id, response_id)
  );
`
const machineWide = (db: Database): boolean =>
  db.prepare<[], { name: string; origin: string }>("PRAGMA index_list(interaction_provider_delivery)").all()
    .filter((index) => index.origin === "u")
    .some((index) => db.prepare<[], { name: string }>(`PRAGMA index_info("${index.name}")`).all().map((c) => c.name).join(",") === "provider,connection_epoch,rpc_request_id_json")

for (const contextColumn of [true, false]) {
  test(`a database made before the fix loses the machine-wide constraint and keeps its rows (${contextColumn ? "current columns" : "before provider_context_json"})`, () => {
    const dir = mkdtempSync(join(tmpdir(), "frizz-interaction-rebuild-"))
    const path = join(dir, "ui.db")
    try {
      // A current file first, so the journal and its schema row are real, then the delivery table put
      // back the way an older server made it.
      const seed = createStorage(path, "project-a")
      const held = seed.interactions.createProviderRequest(approval("project-a"), binding("project-a")).interaction
      seed.db.exec(`
        ALTER TABLE interaction_provider_delivery RENAME TO delivery_now;
        ${BEFORE(contextColumn)}
        INSERT INTO interaction_provider_delivery (interaction_id, project_id, provider, logical_request_id, request_method, connection_epoch, rpc_request_id_json, state, attempts, created_at, updated_at)
          SELECT interaction_id, project_id, provider, logical_request_id, request_method, connection_epoch, rpc_request_id_json, state, attempts, created_at, updated_at FROM delivery_now;
        DROP TABLE delivery_now;
      `)
      assert.equal(machineWide(seed.db), true, "control: this is the table the old schema made")
      seed.close()

      const db = new Database(path)
      const a = createStorage(db, "project-a")
      const b = createStorage(db, "project-b")
      assert.equal(machineWide(db), false, "the constraint is gone")
      const delivery = a.interactions.providerDelivery(scopeOf("project-a"), held.id)
      assert.equal(delivery?.state, "awaiting-user", "A's delivery came through the rebuild")
      assert.equal(delivery?.connectionEpoch, 1)
      assert.equal(a.interactions.listPending(scopeOf("project-a")).length, 1)
      assert.equal(b.interactions.createProviderRequest(approval("project-b"), binding("project-b")).effect, "created", "B's first approval is no longer refused")
      // Per project it still holds: the same pair for a DIFFERENT card of A's is a conflict.
      assert.equal(code(() => a.interactions.createProviderRequest(approval("project-a", { n: 2 }), binding("project-a"))), "provider-id-conflict")
      const indexes = db.prepare<[], { name: string }>("PRAGMA index_list(interaction_provider_delivery)").all().map((index) => index.name)
      for (const name of ["interaction_provider_delivery_queue", "interaction_provider_delivery_logical", "interaction_provider_delivery_rpc_unique_project", "interaction_provider_delivery_response_unique"]) {
        assert.ok(indexes.includes(name), `${name} is back on the rebuilt table`)
      }
      assert.equal(db.prepare("PRAGMA foreign_key_check(interaction_provider_delivery)").get(), undefined)
      a.close(); b.close(); db.close()

      // Opening it again changes nothing: there is no constraint left to find.
      const again = createStorage(path, "project-a")
      assert.equal(again.interactions.providerDelivery(scopeOf("project-a"), held.id)?.state, "awaiting-user")
      again.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
