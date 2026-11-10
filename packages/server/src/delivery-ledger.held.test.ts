import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptMessage } from "@frizz/shared"
import { createStorage } from "./storage.ts"
import {
  ageDeliveries,
  appendDelivery,
  beginDelivery,
  cancelDelivery,
  correlateDeliveryRecord,
  deliverOutstandingDeliveries,
  dropHeldDelivery,
  failHeldDeliveries,
  heldDeliveries,
  heldSendMustWait,
  holdDelivery,
  holdStrandedDeliveries,
  MAX_LEDGER_ITEMS,
  nextHeldRelease,
  parseDeliveryLedger,
  projectDeliveryLedger,
  retireOutstandingDeliveries,
  trimLedger,
  UNCONFIRMED_DROP_MS,
  type DeliveryLedgerItem,
} from "./delivery-ledger.ts"

// HELD: a message the operator sent TO THE QUEUE — Frizz keeps it until the agent rests, and until then
// no transport has been handed anything. Everything else in the ledger is a claim about a send some
// provider has; these pin that a held one is inert to all the machinery built for those claims, because
// each of them, applied here, would either lose the only copy of the words or deliver them early.
const T0 = Date.parse("2026-10-11T10:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-held-ledger-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession({
    slug: "t", session_id: "s", thread_name: "frizz-t", spawned_at: iso(T0), last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  return {
    storage,
    items: () => parseDeliveryLedger(storage.getSession("t")?.delivery_ledger),
    dispose: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

const held = (over: Partial<DeliveryLedgerItem> = {}): DeliveryLedgerItem => ({
  id: "d-held", text: "after this, rebase onto main", state: "held", at: iso(T0), updatedAt: iso(T0), ...over,
})
const msg = (over: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ role: "user", text: "after this, rebase onto main", tools: [], parts: [], ...over })

test("holding is idempotent on id, and a held send releases as a fresh write-ahead entry", () => {
  const l = ledger()
  try {
    assert.equal(holdDelivery(l.storage, "t", { id: "d-1", text: "later", now: T0 }), true)
    assert.equal(holdDelivery(l.storage, "t", { id: "d-1", text: "later", now: T0 + 5_000 }), true, "a replay is not an error")
    assert.deepEqual(l.items().map((i) => [i.id, i.state, i.at]), [["d-1", "held", iso(T0)]])
    assert.deepEqual(heldDeliveries(l.storage, "t").map((i) => i.id), ["d-1"])
    // A replayed "Send to queue" reaching the ordinary path must not deliver early.
    assert.equal(beginDelivery(l.storage, "t", { id: "d-1", text: "later", now: T0 + 6_000 }), "duplicate")
    assert.equal(l.items()[0].state, "held")
    // The release: `sending`, and re-stamped — this is the moment a transport first sees it, and `at`
    // is what correlation and aging measure a send from.
    assert.equal(beginDelivery(l.storage, "t", { id: "d-1", text: "later", now: T0 + 60_000, release: true }), "begin")
    assert.deepEqual(l.items().map((i) => [i.state, i.at]), [["sending", iso(T0 + 60_000)]])
    appendDelivery(l.storage, "t", { id: "d-1", text: "later", state: "delivered", now: T0 + 61_000 })
    assert.equal(l.items()[0].state, "delivered")
    assert.deepEqual(heldDeliveries(l.storage, "t"), [])
  } finally { l.dispose() }
})

test("taking a held send back drops it outright and returns its words", () => {
  const l = ledger()
  try {
    holdDelivery(l.storage, "t", { id: "d-1", text: "never mind", now: T0 })
    assert.equal(cancelDelivery(l.storage, "t", "d-1"), null, "the provider-queue tombstone is not for a send no provider has")
    assert.equal(dropHeldDelivery(l.storage, "t", "d-1"), "never mind")
    assert.deepEqual(l.items(), [])
    assert.equal(dropHeldDelivery(l.storage, "t", "d-1"), null, "already gone — released or taken back")
  } finally { l.dispose() }
})

test("a worker restart and a forced interrupt both leave a held send held", () => {
  const l = ledger()
  try {
    holdDelivery(l.storage, "t", { id: "d-1", text: "later", now: T0 })
    assert.equal(retireOutstandingDeliveries(l.storage, "t"), 0, "it was never the dead process's to lose")
    assert.equal(deliverOutstandingDeliveries(l.storage, "t"), 0, "an interrupt frees the PROVIDER's queue, and it is not in one")
    assert.equal(l.items()[0].state, "held")
  } finally { l.dispose() }
})

// A record carrying the same words is ANOTHER send's — the operator steering the same sentence past
// their own queued copy, or a boot replay re-folding an older one. Matching would retire the only copy
// of a message the agent has not been given.
test("no transcript record is evidence about a held send", () => {
  const items = [held()]
  const at = iso(T0 + 1_000)
  assert.equal(correlateDeliveryRecord(items, { type: "queue-operation", operation: "enqueue", content: items[0].text, timestamp: at }, at), items)
  assert.equal(correlateDeliveryRecord(items, { type: "queue-operation", operation: "remove", content: items[0].text, timestamp: at }, at), items)
  assert.equal(correlateDeliveryRecord(items, { type: "user", uuid: "d-held", message: { role: "user", content: items[0].text }, timestamp: at }, at), items)
})

test("a held send never ages out and a later user turn does not retire it", () => {
  const items = [held()]
  const muchLater = T0 + UNCONFIRMED_DROP_MS * 5
  assert.equal(ageDeliveries(items, muchLater), items, "it waits as long as the turn runs — that is the request")
  assert.equal(ageDeliveries(items, muchLater, iso(T0 + 30_000)), items, "the operator steered past it; no queue moved past it")
})

test("a run of ordinary sends never evicts a held one", () => {
  const live = Array.from({ length: MAX_LEDGER_ITEMS + 3 }, (_, i): DeliveryLedgerItem => ({
    id: `d-${i}`, text: `send ${i}`, state: "enqueued", at: iso(T0 + 1_000 + i), updatedAt: iso(T0 + 1_000 + i),
  }))
  const trimmed = trimLedger([held(), ...live])
  assert.ok(trimmed.some((i) => i.id === "d-held"), "Frizz is the only place its words exist")
})

test("a held send always projects its own gray bubble, never adopting one with the same words", () => {
  // The same sentence, already sent as a steer and rendered by the transcript.
  const rendered = [msg({ sourceId: "fold-1", at: iso(T0 + 1_000) })]
  const out = projectDeliveryLedger([...rendered], [held()])
  assert.equal(out.length, 2)
  assert.equal(out[0].deliveryId, undefined, "the steer's bubble is not claimed")
  assert.deepEqual(
    { sourceId: out[1].sourceId, queued: out[1].queued, deliveryId: out[1].deliveryId, deliveryState: out[1].deliveryState },
    { sourceId: "delivery:d-held", queued: true, deliveryId: "d-held", deliveryState: "held" },
  )
})

// THE QUEUE GOES OUT ONE MESSAGE AT A TIME (2026-10-20): a release hands over the oldest held message
// alone, and only once nothing handed over before it is still on its way. Decided here, in one place, for
// the rest and for Send now alike.
test("a release hands over the oldest held message, alone", () => {
  const next = (items: DeliveryLedgerItem[]) => nextHeldRelease(items)?.id ?? null
  assert.equal(next([]), null)
  assert.equal(next([held({ id: "a" }), held({ id: "b" }), held({ id: "c" })]), "a")
})

test("the next held message waits for every send ahead of it whose turn has not ended", () => {
  const next = (items: DeliveryLedgerItem[], force = false) => nextHeldRelease(items, { force })?.id ?? null
  const a = held({ id: "a" })
  const sent = (state: DeliveryLedgerItem["state"]): DeliveryLedgerItem => ({ id: `x-${state}`, text: "earlier", state, at: iso(T0), updatedAt: iso(T0) })
  for (const state of ["sending", "pending", "enqueued", "delivered"] as const) {
    assert.equal(next([sent(state), a]), null, `behind a ${state} send, whose turn has not ended`)
    assert.equal(next([sent(state), a], true), "a", "unless the operator pressed Send now")
    assert.equal(heldSendMustWait([sent(state)]), true, "and a new send to the queue waits behind it too, even at rest")
  }
  for (const state of ["failed", "unconfirmed", "cancelled"] as const) {
    assert.equal(next([sent(state), a]), "a", `a ${state} send is not on its way, so it holds nothing up`)
    assert.equal(heldSendMustWait([sent(state)]), false)
  }
  assert.equal(heldSendMustWait([a]), true, "a new send never overtakes a held one")
  assert.equal(heldSendMustWait([]), false, "with nothing ahead it is an ordinary send")
})

test("a send a runtime's queue stranded goes back to held, in place, and a wake with no entry draws nothing", () => {
  const { storage, dispose } = ledger()
  try {
    appendDelivery(storage, "t", { id: "a", text: "first", state: "enqueued" })
    appendDelivery(storage, "t", { id: "b", text: "answered", state: "delivered" })
    assert.equal(holdStrandedDeliveries(storage, "t", [{ id: "a", text: "first + gap note" }, { id: "w", text: "<wake>" }, { id: "b", text: "answered" }]), 2)
    const items = parseDeliveryLedger(storage.getSession("t")!.delivery_ledger)
    assert.deepEqual(items.map((i) => [i.id, i.state, i.text, i.silent]), [
      ["a", "held", "first", undefined],
      ["b", "delivered", "answered", undefined],
      ["w", "held", "<wake>", true],
    ])
    assert.equal(projectDeliveryLedger([], items).some((m) => m.text === "<wake>"), false)
    assert.equal(beginDelivery(storage, "t", { id: "a", text: "first", release: true }), "begin", "the ordinary release takes it")
  } finally { dispose() }
})

test("a held send on a thread put away turns failed with its words kept and can be retried; a silent one goes", () => {
  const { storage, dispose } = ledger()
  try {
    holdDelivery(storage, "t", { id: "a", text: "cherry" })
    holdStrandedDeliveries(storage, "t", [{ id: "w", text: "<wake>" }])
    assert.equal(failHeldDeliveries(storage, "t", "The session ended before this message was sent."), 2)
    const items = parseDeliveryLedger(storage.getSession("t")!.delivery_ledger)
    assert.deepEqual(items.map((i) => [i.id, i.state, i.retryable, i.error]), [["a", "failed", true, "The session ended before this message was sent."]])
    const bubble = projectDeliveryLedger([], items)[0]!
    assert.equal(bubble.deliveryState, "failed")
    assert.equal(bubble.queued, false)
  } finally { dispose() }
})
