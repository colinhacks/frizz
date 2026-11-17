import { test } from "node:test"
import assert from "node:assert/strict"
import { humanGapNote, type TranscriptMessage } from "@frizz/shared"
import {
  parseDeliveryLedger,
  serializeDeliveryLedger,
  correlateDeliveryRecord,
  ageDeliveries,
  projectDeliveryLedger,
  PENDING_TIMEOUT_MS,
  UNCONFIRMED_DROP_MS,
  MAX_LEDGER_ITEMS,
  MAX_CANCELLED_ITEMS,
  trimLedger,
  suppressCancelledDeliveries,
  type DeliveryLedgerItem,
} from "./delivery-ledger.ts"
import { encodeDeliveryMarker } from "./delivery-marker.ts"

const T0 = Date.parse("2026-07-21T12:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()
const item = (over: Partial<DeliveryLedgerItem> = {}): DeliveryLedgerItem => ({
  id: "d-1",
  text: "fix the bug",
  state: "pending",
  at: iso(T0),
  updatedAt: iso(T0),
  ...over,
})
const msg = (over: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
  role: "user",
  text: "fix the bug",
  tools: [],
  parts: [],
  ...over,
})

// ---- parse / serialize ----
test("parse tolerates null, garbage, and malformed entries", () => {
  assert.deepEqual(parseDeliveryLedger(null), [])
  assert.deepEqual(parseDeliveryLedger("not json"), [])
  assert.deepEqual(parseDeliveryLedger(JSON.stringify([{ id: "x" }, item()])), [item()])
  assert.equal(serializeDeliveryLedger([]), null)
})

// ---- correlation ----
test("an enqueue record matching a pending item moves it to enqueued", () => {
  const out = correlateDeliveryRecord([item()], { type: "queue-operation", operation: "enqueue", content: "fix the bug\n", timestamp: iso(T0 + 500) }, iso(T0 + 500))
  assert.equal(out[0].state, "enqueued")
})

test("a queued_command attachment delivers (drops) the item", () => {
  const out = correlateDeliveryRecord(
    [item({ state: "enqueued" })],
    { type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "human" }, prompt: "fix the bug" }, timestamp: iso(T0 + 9000) },
    iso(T0 + 9000),
  )
  assert.deepEqual(out, [])
})

test("a plain user record delivers the item (idle submit / dead-session resume)", () => {
  const out = correlateDeliveryRecord([item()], { type: "user", message: { role: "user", content: "fix the bug" }, timestamp: iso(T0 + 3000) }, iso(T0 + 3000))
  assert.deepEqual(out, [])
})

test("an isMeta user record is never delivery evidence", () => {
  const out = correlateDeliveryRecord([item()], { type: "user", isMeta: true, message: { role: "user", content: "fix the bug" }, timestamp: iso(T0 + 3000) }, iso(T0 + 3000))
  assert.equal(out.length, 1)
})

test("a record timestamped BEFORE the send never resolves it (restart replay of old history)", () => {
  const out = correlateDeliveryRecord([item()], { type: "user", message: { role: "user", content: "fix the bug" }, timestamp: iso(T0 - 60_000) }, iso(T0))
  assert.equal(out.length, 1)
  const enq = correlateDeliveryRecord([item()], { type: "queue-operation", operation: "enqueue", content: "fix the bug", timestamp: iso(T0 - 60_000) }, iso(T0))
  assert.equal(enq[0].state, "pending")
})

test("non-matching text leaves the ledger untouched (same array identity)", () => {
  const items = [item()]
  const out = correlateDeliveryRecord(items, { type: "user", message: { role: "user", content: "unrelated" }, timestamp: iso(T0 + 1000) }, iso(T0 + 1000))
  assert.equal(out, items)
})

// ---- aging ----
test("a pending item times out to unconfirmed; enqueued never does", () => {
  const out = ageDeliveries([item(), item({ id: "d-2", state: "enqueued" })], T0 + PENDING_TIMEOUT_MS + 1000)
  assert.equal(out.find((i) => i.id === "d-1")?.state, "unconfirmed")
  assert.equal(out.find((i) => i.id === "d-2")?.state, "enqueued")
})

test("an unconfirmed item is dropped after the drop window", () => {
  const out = ageDeliveries([item({ state: "unconfirmed" })], T0 + UNCONFIRMED_DROP_MS + 1000)
  assert.deepEqual(out, [])
})

// ---- merged submissions (the "Delivery unconfirmed" bug) ----
// frizz pastes a follow-up into Claude Code's composer and sends Enter. When the TUI swallows that Enter
// mid-render the text STAYS in the composer, and the next follow-up's paste lands after it — so one
// Enter submits the accumulation and Claude Code records ONE enqueue whose content is the concatenation.
// Byte shapes below are taken from the maintainer's own transcript (2026-07-23, `why-when-i-try-to-change`),
// where four such sends all reached the agent and all four rendered "Delivery unconfirmed" forever.
const merged = (a: string, b: string, sep = "") => ({
  type: "queue-operation", operation: "enqueue", timestamp: iso(T0 + 1000), content: `${a}${sep}${b}`,
})

test("a merged enqueue confirms EVERY send it is composed of (newline-joined)", () => {
  const a = item({ id: "d-a", text: "You should probably also investigate how the client and server ever got out of sync." })
  const b = item({ id: "d-b", text: "You have to remind me again why we are not just using the SDK for codex." })
  const out = correlateDeliveryRecord([a, b], merged(a.text, b.text, "\n"), iso(T0 + 1000))
  assert.deepEqual(out.map((i) => i.state), ["enqueued", "enqueued"])
})

test("a merged enqueue confirms both sends when the composer joined them with NO separator", () => {
  const a = item({ id: "d-a", text: "http://127.0.0.1:4919/thread/why-when-i-try-to-change" })
  const b = item({ id: "d-b", text: "> codex remote-control start|stop|pair — you sure this is the same kind of thing?" })
  const out = correlateDeliveryRecord([a, b], merged(a.text, b.text), iso(T0 + 1000))
  assert.deepEqual(out.map((i) => i.state), ["enqueued", "enqueued"])
})

test("a merged queued_command DELIVERS every send it is composed of", () => {
  const a = item({ id: "d-a", text: "the first long follow-up the composer swallowed" })
  const b = item({ id: "d-b", text: "the second follow-up whose Enter submitted both" })
  const rec = {
    type: "attachment", timestamp: iso(T0 + 1000),
    attachment: { type: "queued_command", commandMode: "prompt", prompt: `${a.text}\n${b.text}` },
  }
  assert.deepEqual(correlateDeliveryRecord([a, b], rec, iso(T0 + 1000)), [])
})

test("an ALREADY-unconfirmed item is rescued by a late enqueue", () => {
  // Observed: 87s and 12min between the send and the enqueue record, because the composer held the
  // paste. PENDING_TIMEOUT_MS is 60s, so the item had already gone amber — and used to stay that way.
  const stale = item({ state: "unconfirmed" })
  const out = correlateDeliveryRecord([stale], {
    type: "queue-operation", operation: "enqueue", timestamp: iso(T0 + 90_000), content: stale.text,
  }, iso(T0 + 90_000))
  assert.equal(out[0].state, "enqueued")
})

test("a merged record leaves an item it does NOT contain alone", () => {
  const a = item({ id: "d-a", text: "the first long follow-up the composer swallowed" })
  const other = item({ id: "d-b", text: "an unrelated send that never reached the composer" })
  const out = correlateDeliveryRecord([a, other], merged(a.text, "trailing text nobody sent", "\n"), iso(T0 + 1000))
  assert.deepEqual(out.map((i) => i.state), ["enqueued", "pending"])
})

test("a SHORT send is never resolved by merely appearing inside an unrelated message", () => {
  // The whole safety of the composition rule: a segment may only match mid-record when it is long
  // enough to be unambiguous. "continue" typed inside a human's own terminal message must not confirm
  // a pending "continue" frizz sent.
  const items = [item({ text: "continue" })]
  const rec = { type: "user", timestamp: iso(T0 + 1000), message: { content: "ok, please continue with the plan" } }
  // Same array identity: nothing matched, so the caller writes nothing back to the row.
  assert.equal(correlateDeliveryRecord(items, rec, iso(T0 + 1000)), items)
})

// ---- channel rewrites (the "Delivery unconfirmed" bug class) ----
// The pre-broker steer channel pasted into Claude Code's TUI: an LF→CR paste boundary composed with the
// TUI's own paste handler (CR/CRLF→LF, TAB→four spaces). Measured against a live claude 2.1.219 TUI driven through frizz's own
// paste sequence: a tab becomes four spaces and a CRLF becomes TWO newlines. Both classes stranded a
// send that the agent had already read. TABBED below is the maintainer's own stranded text
// (2026-07-25, `were-taking-over-from-another-agent`).
const TABBED = '> <tmp>: "r"\tno, but lossy vs intent\tsilently widens to rw on both\nWhy does this happen?'
const EXPANDED = TABBED.replace(/\t/g, "    ")
// The measured composition, applied the way the real channel applies it.
const throughChannel = (s: string) => s.replace(/\r\n|\r/g, "\n\n").replace(/\t/g, "    ")

test("a CRLF send survives the channel doubling its line breaks", () => {
  const text = "Review the sandbox design.\r\nThe ACL cleanup matters most.\r\nShip it when green."
  const out = correlateDeliveryRecord(
    [item({ text })],
    { type: "user", message: { role: "user", content: throughChannel(text) }, timestamp: iso(T0 + 40) },
    iso(T0 + 40),
  )
  assert.deepEqual(out, [])
})

test("tabs and CRLF together still deliver", () => {
  const text = "col1\tcol2\r\nrow2\tvalue\r\nand a closing line of prose"
  const out = correlateDeliveryRecord(
    [item({ text })],
    { type: "user", message: { role: "user", content: throughChannel(text) }, timestamp: iso(T0 + 40) },
    iso(T0 + 40),
  )
  assert.deepEqual(out, [])
})

test("a re-wrapped record (line breaks moved entirely) still delivers", () => {
  // Invariance, not channel-modelling: a future rewrite that re-flows lines must not resurrect the bug.
  const text = "the quick brown fox jumps over the lazy dog and keeps running"
  const rewrapped = "the quick brown fox\njumps over the lazy\ndog and keeps running"
  const out = correlateDeliveryRecord(
    [item({ text })],
    { type: "user", message: { role: "user", content: rewrapped }, timestamp: iso(T0 + 40) },
    iso(T0 + 40),
  )
  assert.deepEqual(out, [])
})

test("a user record whose tabs the TUI expanded still delivers the item", () => {
  const out = correlateDeliveryRecord(
    [item({ text: TABBED })],
    { type: "user", message: { role: "user", content: EXPANDED }, timestamp: iso(T0 + 34) },
    iso(T0 + 34),
  )
  assert.deepEqual(out, [])
})

test("a tab-expanded enqueue record still receipts the item", () => {
  const out = correlateDeliveryRecord(
    [item({ text: TABBED })],
    { type: "queue-operation", operation: "enqueue", content: EXPANDED, timestamp: iso(T0 + 500) },
    iso(T0 + 500),
  )
  assert.equal(out[0].state, "enqueued")
})

test("tab expansion does not break the merged-submission composition", () => {
  const a = item({ id: "d-a", text: "the first long follow-up\tthe composer swallowed" })
  const b = item({ id: "d-b", text: "the second follow-up\twhose Enter submitted both" })
  const rec = merged(a.text.replace(/\t/g, "    "), b.text.replace(/\t/g, "    "), "\n")
  assert.deepEqual(correlateDeliveryRecord([a, b], rec, iso(T0 + 1000)).map((i) => i.state), ["enqueued", "enqueued"])
})

test("the projection dedups against an already-delivered copy whose tabs were expanded", () => {
  // Without this the ledger appends a SECOND, amber copy of a message the transcript already renders —
  // the duplicate bubble the operator actually saw.
  const out = projectDeliveryLedger([msg({ text: EXPANDED, sourceId: "s:5" })], [item({ text: TABBED })])
  assert.equal(out.length, 1)
  assert.equal(out[0].deliveryId, undefined)
})

test("differing WORDS are still never matched — only whitespace is forgiven", () => {
  const items = [item({ text: "restart\tthe server" })]
  const rec = { type: "user", timestamp: iso(T0 + 1000), message: { content: "restart    the  daemon" } }
  assert.equal(correlateDeliveryRecord(items, rec, iso(T0 + 1000)), items)
})

test("a SHORT send is still never resolved by appearing inside an unrelated message, tabs or not", () => {
  const items = [item({ text: "\tcontinue" })]
  const rec = { type: "user", timestamp: iso(T0 + 1000), message: { content: "ok, please    continue with the plan" } }
  assert.equal(correlateDeliveryRecord(items, rec, iso(T0 + 1000)), items)
})

// ---- identity: the invisible delivery marker ----
// Text correlation is inference over a channel that rewrites bytes. The marker replaces it with an id
// lookup, so a send is confirmed even when the recorded text no longer resembles what frizz sent.
const marked = (id: string, text: string) => text + encodeDeliveryMarker(id)

test("a record whose TEXT was destroyed still delivers, because the marker identifies it", () => {
  // The strongest statement of the fix: nothing about this prose matches, and it resolves anyway.
  const it = item({ id: "d-x", text: "restart the daemon and re-run the suite" })
  const rec = { type: "user", timestamp: iso(T0 + 40), message: { content: marked("d-x", "totally different prose the channel invented") } }
  assert.deepEqual(correlateDeliveryRecord([it], rec, iso(T0 + 40)), [])
})

test("a marked enqueue receipts the item by id", () => {
  const out = correlateDeliveryRecord(
    [item({ id: "d-x" })],
    { type: "queue-operation", operation: "enqueue", content: marked("d-x", "fix the bug"), timestamp: iso(T0 + 500) },
    iso(T0 + 500),
  )
  assert.equal(out[0].state, "enqueued")
})

test("a glued submission resolves EVERY send by its own marker", () => {
  const a = item({ id: "d-a", text: "the first follow-up" })
  const b = item({ id: "d-b", text: "the second follow-up" })
  const glued = marked("d-a", a.text) + "\n" + marked("d-b", b.text)
  assert.deepEqual(correlateDeliveryRecord([a, b], { type: "user", timestamp: iso(T0 + 40), message: { content: glued } }, iso(T0 + 40)), [])
})

test("a marker for a DIFFERENT send never resolves this one", () => {
  const it = item({ id: "d-mine", text: "my send" })
  const rec = { type: "user", timestamp: iso(T0 + 40), message: { content: marked("d-someone-else", "unrelated text") } }
  const out = correlateDeliveryRecord([it], rec, iso(T0 + 40))
  assert.equal(out.length, 1)
  assert.equal(out[0].state, "pending")
})

test("a marker is still refused when the record PREDATES the send (replay safety holds)", () => {
  const it = item({ id: "d-x" })
  const rec = { type: "user", timestamp: iso(T0 - 60_000), message: { content: marked("d-x", "fix the bug") } }
  assert.equal(correlateDeliveryRecord([it], rec, iso(T0)).length, 1)
})

test("a MIXED record — one marked send glued ahead of an unmarked one — resolves both", () => {
  // The upgrade case: an item already in flight when this shipped carries no marker, and must still be
  // confirmed by text from the same record that identifies its marked neighbour by id.
  const a = item({ id: "d-a", text: "the freshly marked follow-up that frizz stamped" })
  const b = item({ id: "d-b", text: "an older in-flight send with no marker at all" })
  const glued = marked("d-a", a.text) + "\n" + b.text
  assert.deepEqual(correlateDeliveryRecord([a, b], { type: "user", timestamp: iso(T0 + 40), message: { content: glued } }, iso(T0 + 40)), [])
})

test("the projection dedups a delivered copy whose marker the renderer already stripped", () => {
  const it = item({ id: "d-x", text: "a marked send" })
  const out = projectDeliveryLedger([msg({ text: "a marked send", sourceId: "s:5" })], [it])
  assert.equal(out.length, 1)
  assert.equal(out[0].deliveryId, undefined)
})

test("the projection dedups against a copy that STILL carries the raw marker", () => {
  const it = item({ id: "d-x", text: "a marked send" })
  const out = projectDeliveryLedger([msg({ text: marked("d-x", "a marked send"), sourceId: "s:5" })], [it])
  assert.equal(out.length, 1)
})

// ---- dequeue ----
// Claude Code emits `queue-operation remove` (content-bearing, 2398/2398 in the corpus) the moment it
// takes a message OUT of its queue and into the turn — 1 to 19 records before the queued_command
// attachment frizz used to wait for. For that window the send was already being worked on while frizz
// still rendered it queued, which pins it below the working indicator.
test("a content-bearing remove resolves the item at DEQUEUE, not at the later attachment", () => {
  const out = correlateDeliveryRecord(
    [item({ state: "enqueued" })],
    { type: "queue-operation", operation: "remove", content: "fix the bug", timestamp: iso(T0 + 9000) },
    iso(T0 + 9000),
  )
  assert.deepEqual(out, [])
})

test("a dequeue resolves by MARKER even when the echoed text was rewritten", () => {
  const it = item({ id: "d-x", state: "enqueued", text: "col1\tcol2\r\nand some prose to follow" })
  const echoed = ("col1\tcol2\r\nand some prose to follow" + encodeDeliveryMarker("d-x")).replace(/\r\n/g, "\n\n").replace(/\t/g, "    ")
  const out = correlateDeliveryRecord([it], { type: "queue-operation", operation: "remove", content: echoed, timestamp: iso(T0 + 9000) }, iso(T0 + 9000))
  assert.deepEqual(out, [])
})

test("a CONTENTLESS remove/dequeue is never evidence (the bare handshake)", () => {
  // All 1032 `dequeue` records in the corpus carry no content; an empty handshake cannot be attributed
  // to any particular send, so it must leave the ledger untouched.
  const items = [item({ state: "enqueued" })]
  assert.equal(correlateDeliveryRecord(items, { type: "queue-operation", operation: "dequeue", timestamp: iso(T0 + 9000) }, iso(T0 + 9000)), items)
  assert.equal(correlateDeliveryRecord(items, { type: "queue-operation", operation: "remove", content: "   ", timestamp: iso(T0 + 9000) }, iso(T0 + 9000)), items)
})

test("a remove for SOMEONE ELSE's queue entry leaves our send alone", () => {
  const items = [item({ state: "enqueued", text: "my steer" })]
  const rec = { type: "queue-operation", operation: "remove", content: "<task-notification>a sub-agent finished</task-notification>", timestamp: iso(T0 + 9000) }
  assert.equal(correlateDeliveryRecord(items, rec, iso(T0 + 9000)), items)
})

test("an enqueued item is no longer immortal — it drops after the same hour as unconfirmed", () => {
  // It used to age never and drop never, so ONE missed delivery record left a gray bubble pinned below
  // the working indicator for the life of the row.
  assert.deepEqual(ageDeliveries([item({ state: "enqueued" })], T0 + UNCONFIRMED_DROP_MS + 1000), [])
  // …but a queue entry inside a legitimately long turn is still left completely alone.
  const live = [item({ state: "enqueued" })]
  assert.equal(ageDeliveries(live, T0 + PENDING_TIMEOUT_MS * 10), live)
})

test("aging is identity-stable when nothing changes", () => {
  const items = [item({ state: "enqueued" })]
  assert.equal(ageDeliveries(items, T0 + 5000), items)
})

// The escape hatch for a send whose delivery record the correlator could not attribute. The provider's
// queue is FIFO, so a user turn at or after the send's own instant means the queue already moved past it.
// Every live state goes — `unconfirmed`'s amber "no receipt from the worker" warning is falsified by a later user
// turn exactly as squarely as an `enqueued` claim is.
test("a user turn at/after an outstanding send is proof it was delivered — every live state drops", () => {
  const live = [
    item({ id: "d-pending", state: "pending" }),
    item({ id: "d-enqueued", state: "enqueued" }),
    item({ id: "d-unconfirmed", state: "unconfirmed" }),
  ]
  assert.deepEqual(ageDeliveries(live, T0 + 5000, iso(T0 + 1)), [])
  assert.deepEqual(ageDeliveries(live, T0 + 5000, iso(T0)), [], "same instant counts — the record can share the send's ms")
})

test("a user turn BEFORE the send proves nothing, and neither does a missing/garbage one", () => {
  const items = [item({ state: "enqueued" })]
  assert.equal(ageDeliveries(items, T0 + 5000, iso(T0 - 1)), items, "the turn this send is answering is not evidence of its delivery")
  assert.equal(ageDeliveries(items, T0 + 5000, undefined), items, "a thread with no observed user turn ages exactly as before")
  assert.equal(ageDeliveries(items, T0 + 5000, "not a date"), items)
})

test("a tombstone survives a later user turn — it is suppressing a record, not describing a send", () => {
  const items = [item({ state: "cancelled" })]
  assert.equal(ageDeliveries(items, T0 + 5000, iso(T0 + 90_000)), items)
})

// THE BUG THIS EXISTS FOR (nub `idea-from-jdx-creator-of-mise`, 2026-08-14). Two follow-ups were queued
// and submitted as ONE composed record; the live fold never attributed the first, so it sat `enqueued`
// for the hour before UNCONFIRMED_DROP_MS. `hasFreshDelivery` (board.ts) reads an outstanding send as
// "the human already answered, so this thread is not waiting on them" and had the thread OUT of the queue
// that whole time: it answered, asked a fresh ```question, and still showed a rested rail row with no
// card behind it — clicking it opened a drawer instead of scrolling to one.
test("a send stranded by a missed correlation drops on the next user turn, not an hour later", () => {
  const stranded = [item({ id: "d-stranded", state: "enqueued", text: "Should this field be artifacts level or slot level?" })]
  const answeredAt = T0 + 57_000 // the composed record that delivered it, un-attributed
  assert.deepEqual(ageDeliveries(stranded, answeredAt + 1000, iso(answeredAt)), [])
  // …and without the evidence it really would have sat there for the full hour.
  assert.equal(ageDeliveries(stranded, answeredAt + 1000), stranded)
})

// ---- projection ----
test("an untracked send projects as a queued bubble at the tail", () => {
  const out = projectDeliveryLedger([msg({ text: "earlier", sourceId: "s:1" })], [item()])
  assert.equal(out.length, 2)
  const bubble = out[1]
  assert.equal(bubble.sourceId, "delivery:d-1")
  assert.equal(bubble.queued, true)
  assert.equal(bubble.deliveryId, "d-1")
  assert.equal(bubble.deliveryState, "pending")
})

test("the JSONL's own enqueue bubble is tagged, not double-rendered", () => {
  const existing = msg({ queued: true, sourceId: "s:9" })
  const out = projectDeliveryLedger([existing], [item({ state: "enqueued" })])
  assert.equal(out.length, 1)
  assert.equal(out[0].sourceId, "s:9", "the fold's bubble, not a projected one")
  assert.equal(out[0].deliveryId, "d-1")
  assert.equal(out[0].deliveryState, "enqueued")
  // Copy-on-write: the socket's read has already measured this object through its JSON memo, so a tag
  // written onto it here would go out stale (projectDeliveryLedger).
  assert.equal(existing.deliveryId, undefined, "the fold's retained object is untouched")
  assert.equal(existing.deliveryState, undefined)
})

// THE DOUBLE RENDER (maintainer 2026-08-24, zod `eaf90e17`): the router appends the human-gap clock
// note to the WORKER's copy of a follow-up and deliberately leaves the ledger untouched, so the fold's
// enqueue bubble carries `text + note` while the item carries bare `text`. The strict compare missed,
// the projection appended its own delivery:<id> bubble beside the fold's, and both display-strip the
// note — two identical gray queued bubbles for one send. Built with the real producer so a wording
// change on humanGapNote cannot silently reopen the gap.
test("an enqueue bubble carrying the human-gap note is still tagged, not double-rendered", () => {
  const note = humanGapNote(T0, iso(T0 - 5 * 3_600_000))
  assert.ok(note, "the gap producer must emit above its floor")
  const existing = msg({ queued: true, sourceId: "s:9", text: `fix the bug\n\n${note}` })
  const out = projectDeliveryLedger([existing], [item({ state: "enqueued" })])
  assert.equal(out.length, 1, "no second bubble")
  assert.equal(out[0].deliveryId, "d-1")
  assert.equal(out[0].deliveryState, "enqueued")
  assert.equal(existing.deliveryId, undefined, "copy-on-write — the fold's retained object is untouched")
})

// The ghost-styling variant of the same miss: a follow-up landing on an IDLE thread opens `delivered`
// (the turn it starts is already evaluating it), and the projection un-grays the fold's enqueue bubble
// through the SAME text compare. With the note breaking the match, the gray bubble survived — pinned
// under a thinking shimmer that was visibly working the very message it claimed was still queued.
test("a delivered item un-grays the fold's bubble even when it carries the gap note", () => {
  const note = humanGapNote(T0, iso(T0 - 5 * 3_600_000))
  const existing = msg({ queued: true, sourceId: "s:9", text: `fix the bug\n\n${note}` })
  const out = projectDeliveryLedger([existing], [item({ state: "delivered" })])
  assert.equal(out.length, 1, "no second bubble")
  assert.equal(out[0].queued, false, "the fold's bubble is un-grayed")
  assert.equal(out[0].deliveryId, "d-1")
  assert.equal(existing.queued, true, "copy-on-write — the fold's retained object is untouched")
})

test("a cancelled send's orphan bubble is suppressed even when it carries the gap note", () => {
  const note = humanGapNote(T0, iso(T0 - 5 * 3_600_000))
  const messages = [msg({ text: `retracted\n\n${note}`, sourceId: "s:2", at: iso(T0 + 1000) })]
  const out = suppressCancelledDeliveries(messages, [item({ id: "t", state: "cancelled", text: "retracted", updatedAt: iso(T0 + 4000) })])
  assert.deepEqual(out, [], "the noted orphan is gone")
})

test("an already-delivered copy suppresses projection entirely (prune race)", () => {
  const out = projectDeliveryLedger([msg({ sourceId: "s:5" })], [item()])
  assert.equal(out.length, 1)
  assert.equal(out[0].deliveryId, undefined)
})

test("two untracked sends of the SAME text project TWO bubbles, not one", () => {
  // The second item must not adopt the bubble the first one just appended.
  const out = projectDeliveryLedger([msg({ text: "earlier", sourceId: "s:1" })], [item({ id: "d-1" }), item({ id: "d-2" })])
  assert.equal(out.length, 3)
  assert.deepEqual(out.slice(1).map((m) => m.sourceId), ["delivery:d-1", "delivery:d-2"])
  assert.deepEqual(out.slice(1).map((m) => m.deliveryId), ["d-1", "d-2"])
})

test("two outstanding sends of the SAME text never collapse onto one bubble", () => {
  // Both items matched the one rendered bubble by text, so the second tagged it with ITS id and then
  // skipped projecting: the operator saw ONE queued bubble for two messages they had sent, and the
  // first send's optimistic client copy (which consumes by deliveryId) was never accounted for.
  const existing = msg({ queued: true, sourceId: "s:9" })
  const out = projectDeliveryLedger([existing], [item({ id: "d-1", state: "enqueued" }), item({ id: "d-2", state: "enqueued" })])
  assert.equal(out.length, 2, "the second send still gets its own bubble")
  assert.equal(out[0].deliveryId, "d-1", "the rendered bubble belongs to the FIRST send")
  assert.equal(out[1].sourceId, "delivery:d-2")
  assert.equal(out[1].queued, true)
})

// ---- identity: the broker echoes frizz's own input id back ----
// frizz passes a uuid with every SDK input; the SDK returns it as the delivered `user` record's `uuid`
// or the `queued_command` attachment's `source_uuid`. Verified byte-exact against a live claude 2.1.220
// broker session. This is what makes two simultaneous dequeues resolve exactly instead of by prose.
test("a queued_command attachment resolves the item whose id is its source_uuid", () => {
  const items = [item({ id: "11111111-1111-4111-8111-111111111111", text: "first" }), item({ id: "22222222-2222-4222-8222-222222222222", text: "second" })]
  const rec = {
    type: "attachment", timestamp: iso(T0 + 500),
    attachment: { type: "queued_command", commandMode: "prompt", source_uuid: "22222222-2222-4222-8222-222222222222", prompt: "second" },
  }
  const out = correlateDeliveryRecord(items, rec, iso(T0 + 500))
  assert.deepEqual(out.map((i) => i.id), ["11111111-1111-4111-8111-111111111111"], "only the id's own item leaves")
})

test("identity resolves even when the delivered text no longer matches at all", () => {
  const items = [item({ id: "33333333-3333-4333-8333-333333333333", text: "the words frizz sent" })]
  const rec = {
    type: "attachment", timestamp: iso(T0 + 500),
    attachment: { type: "queued_command", commandMode: "prompt", source_uuid: "33333333-3333-4333-8333-333333333333", prompt: "something else entirely" },
  }
  assert.deepEqual(correlateDeliveryRecord(items, rec, iso(T0 + 500)), [])
})

test("a user record whose uuid is the item's id resolves it (immediate delivery)", () => {
  const items = [item({ id: "44444444-4444-4444-8444-444444444444", text: "hello" })]
  const rec = { type: "user", uuid: "44444444-4444-4444-8444-444444444444", timestamp: iso(T0 + 500), message: { role: "user", content: "hello" } }
  assert.deepEqual(correlateDeliveryRecord(items, rec, iso(T0 + 500)), [])
})

test("an echoed id from BEFORE the send never resolves it (replayed transcript)", () => {
  const items = [item({ id: "55555555-5555-4555-8555-555555555555", text: "continue" })]
  const rec = { type: "user", uuid: "55555555-5555-4555-8555-555555555555", timestamp: iso(T0 - 60_000), message: { role: "user", content: "continue" } }
  assert.equal(correlateDeliveryRecord(items, rec, iso(T0)), items, "a stale record is not evidence")
})

test("an unrelated uuid degrades to the text path rather than resolving anything", () => {
  const items = [item({ id: "66666666-6666-4666-8666-666666666666", text: "fix the bug" })]
  const rec = { type: "user", uuid: "99999999-9999-4999-8999-999999999999", timestamp: iso(T0 + 500), message: { role: "user", content: "unrelated prose" } }
  assert.equal(correlateDeliveryRecord(items, rec, iso(T0 + 500)), items)
})

// ---- codex: the ledger as a RENDERING guarantee ----
// Codex has no provider-side queue and no composer of its own, so its ledger entry exists only to keep the
// queued bubble on screen until the rollout materialises the message. Measured against frizz's own
// delivery records: 8 of 75 codex sends took longer than the client's 60s ghost floor to appear (steers
// at 71s, 212s and 4.6h), so without this the only copy of the message could be retired from the drawer.
const codexUser = (text: string, at: number) => ({
  timestamp: iso(at), type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
})

test("a codex rollout user message resolves its ledger entry", () => {
  const out = correlateDeliveryRecord([item({ state: "enqueued" })], codexUser("fix the bug", T0 + 3000), iso(T0 + 3000))
  assert.deepEqual(out, [])
})

test("a codex entry resolves by MARKER-free whitespace invariance too", () => {
  const it = item({ state: "enqueued", text: "col1\tcol2\r\nsecond line of the steer" })
  const rec = codexUser("col1    col2\n\nsecond line of the steer", T0 + 3000)
  assert.deepEqual(correlateDeliveryRecord([it], rec, iso(T0 + 3000)), [])
})

test("a codex entry opens ENQUEUED so it can never age into the amber warning", () => {
  // `pending` is what becomes `unconfirmed` ("no receipt from the worker") — meaningless for an
  // app-server thread, whose RPC return IS the receipt. Enqueued skips that path entirely.
  const enqueued = [item({ state: "enqueued" })]
  assert.equal(ageDeliveries(enqueued, T0 + PENDING_TIMEOUT_MS + 5000), enqueued)
  assert.equal(ageDeliveries(enqueued, T0 + PENDING_TIMEOUT_MS + 5000)[0].state, "enqueued")
})

test("an unrelated codex user message leaves the entry alone", () => {
  const items = [item({ state: "enqueued", text: "my steer" })]
  assert.equal(correlateDeliveryRecord(items, codexUser("something else entirely", T0 + 3000), iso(T0 + 3000)), items)
})

test("a codex record predating the send is still not evidence", () => {
  const items = [item({ state: "enqueued" })]
  assert.equal(correlateDeliveryRecord(items, codexUser("fix the bug", T0 - 60_000), iso(T0)), items)
})

// ---- cancellation tombstones ----
// A cancelled send is the only ledger row that outlives its own message: the CLI's `queue-operation
// enqueue` record stays on disk forever and keeps rendering, so the row exists to suppress it.

test("a cancelled item projects NOTHING and removes the JSONL bubble it left behind", () => {
  const tombstone = item({ state: "cancelled", text: "wait, not that", updatedAt: iso(T0 + 4000) })
  const out = projectDeliveryLedger(
    [msg({ text: "earlier", sourceId: "s:1" }), msg({ text: "wait, not that", sourceId: "s:2", at: iso(T0 + 1000), queued: true })],
    [tombstone],
  )
  assert.deepEqual(out.map((m) => m.text), ["earlier"])
})

test("the orphan is removed even after the FIFO backstop UN-GRAYED it", () => {
  // transcript.ts un-grays every bubble queued ahead of a delivered one, so by the time a later send
  // lands the cancelled bubble no longer carries `queued` — matching on that flag would miss exactly
  // the case that renders a never-read message as a sent one.
  const out = projectDeliveryLedger(
    [msg({ text: "wait, not that", sourceId: "s:2", at: iso(T0 + 1000) })],
    [item({ state: "cancelled", text: "wait, not that", updatedAt: iso(T0 + 4000) })],
  )
  assert.deepEqual(out, [])
})

test("a tombstone never eats a LATER re-send of the same words", () => {
  // The likely next thing the operator does: unqueue hands the text back to the prompt box, they
  // change their mind and send it again. That copy is outside the send→cancel window.
  const out = projectDeliveryLedger(
    [msg({ text: "wait, not that", sourceId: "s:9", at: iso(T0 + 90_000) })],
    [item({ state: "cancelled", text: "wait, not that", updatedAt: iso(T0 + 4000) })],
  )
  assert.deepEqual(out.map((m) => m.sourceId), ["s:9"])
})

test("one tombstone removes at most ONE bubble", () => {
  const out = projectDeliveryLedger(
    [msg({ text: "again", sourceId: "s:1", at: iso(T0 + 500) }), msg({ text: "again", sourceId: "s:2", at: iso(T0 + 1000) })],
    [item({ state: "cancelled", text: "again", updatedAt: iso(T0 + 4000) })],
  )
  assert.equal(out.length, 1)
})

test("live items still project alongside a tombstone", () => {
  const out = projectDeliveryLedger(
    [msg({ text: "retracted", sourceId: "s:1", at: iso(T0 + 500) })],
    [item({ id: "d-c", state: "cancelled", text: "retracted", updatedAt: iso(T0 + 4000) }), item({ id: "d-2", text: "still going" })],
  )
  assert.deepEqual(out.map((m) => [m.text, m.deliveryId]), [["still going", "d-2"]])
})

test("a tombstone never ages out — a timeout would resurrect the bubble an hour later", () => {
  const items = [item({ state: "cancelled", updatedAt: iso(T0 + 1000) })]
  assert.equal(ageDeliveries(items, T0 + UNCONFIRMED_DROP_MS * 5), items)
})

test("no later record can resolve a tombstone away", () => {
  // The suppression must survive everything the tailer folds in afterwards: an enqueue echo, the
  // delivery of a DIFFERENT send carrying the same words, and the identity path.
  const items = [item({ id: "d-c", state: "cancelled", text: "fix the bug", updatedAt: iso(T0 + 1000) })]
  const enqueue = { type: "queue-operation", operation: "enqueue", content: "fix the bug", timestamp: iso(T0 + 2000) }
  assert.equal(correlateDeliveryRecord(items, enqueue, iso(T0 + 2000)), items)
  const removal = { type: "queue-operation", operation: "remove", content: "fix the bug", timestamp: iso(T0 + 2000) }
  assert.equal(correlateDeliveryRecord(items, removal, iso(T0 + 2000)), items)
  const echo = { type: "user", uuid: "d-c", message: { role: "user", content: "fix the bug" }, timestamp: iso(T0 + 2000) }
  assert.equal(correlateDeliveryRecord(items, echo, iso(T0 + 2000)), items)
})

test("a tombstone's own delivery marker is not evidence either", () => {
  const items = [item({ id: "d-c", state: "cancelled", text: "fix the bug", updatedAt: iso(T0 + 1000) })]
  const marked = { type: "user", message: { role: "user", content: `${encodeDeliveryMarker("d-c")}fix the bug` }, timestamp: iso(T0 + 2000) }
  assert.equal(correlateDeliveryRecord(items, marked, iso(T0 + 2000)), items)
})

// ---- tombstones are bounded, but never by the LIVE cap ----
// Sharing one cap was a real resurrection path: twenty ordinary follow-ups after a retraction evicted
// its tombstone, and the orphaned enqueue bubble came back as a message the agent never read.

test("a run of ordinary sends never evicts a tombstone", () => {
  const tomb = item({ id: "tomb", state: "cancelled", text: "retracted" })
  const live = Array.from({ length: MAX_LEDGER_ITEMS + 5 }, (_, i) => item({ id: `d-${i}`, text: `send ${i}` }))
  const out = trimLedger([tomb, ...live])
  assert.ok(out.some((i) => i.id === "tomb"), "the tombstone survives")
  assert.equal(out.filter((i) => i.state !== "cancelled").length, MAX_LEDGER_ITEMS, "live items are capped")
  // Oldest live items go first, and order is otherwise preserved (matchComposedText consumes in order).
  assert.deepEqual(out.filter((i) => i.state !== "cancelled").map((i) => i.id), live.slice(5).map((i) => i.id))
})

test("tombstones are still bounded by their own cap, oldest first", () => {
  const tombs = Array.from({ length: MAX_CANCELLED_ITEMS + 3 }, (_, i) => item({ id: `t-${i}`, state: "cancelled", text: `retracted ${i}` }))
  const out = trimLedger(tombs)
  assert.equal(out.length, MAX_CANCELLED_ITEMS)
  assert.deepEqual(out.map((i) => i.id), tombs.slice(3).map((i) => i.id))
})

test("a ledger under both caps is returned untouched", () => {
  const items = [item({ id: "t", state: "cancelled" }), item({ id: "d" })]
  assert.equal(trimLedger(items), items)
})

// ---- the suppression reaches SCROLLBACK, where no bubble may ever be projected ----

test("an earlier page suppresses a cancelled orphan without projecting anything", () => {
  const messages = [msg({ text: "kept", sourceId: "s:1" }), msg({ text: "retracted", sourceId: "s:2", at: iso(T0 + 1000) })]
  const items = [item({ id: "t", state: "cancelled", text: "retracted", updatedAt: iso(T0 + 4000) }), item({ id: "d", text: "still queued" })]
  const out = suppressCancelledDeliveries(messages, items)
  assert.deepEqual(out.map((m) => m.text), ["kept"], "the orphan is gone")
  assert.ok(!out.some((m) => m.text === "still queued"), "and a live send is NOT projected into settled history")
})

test("an earlier page with no tombstones is returned untouched", () => {
  const messages = [msg({ text: "kept", sourceId: "s:1" })]
  assert.equal(suppressCancelledDeliveries(messages, [item()]), messages)
  assert.equal(suppressCancelledDeliveries(messages, []), messages)
})

// ---- the delivered state: the receipt proved the message went straight into a turn ----
// A codex followUp (its receipt names the turn it steered or started) and a Claude follow-up to a
// thread with no turn in flight open the ledger item as `delivered`. It renders as an ORDINARY user
// bubble — the agent is already working on it — while still guaranteeing the message cannot vanish
// before the provider's own record reaches disk.
test("a delivered item projects as an ordinary (un-grayed) bubble at the tail", () => {
  const out = projectDeliveryLedger([msg({ text: "earlier", sourceId: "s:1" })], [item({ state: "delivered" })])
  assert.equal(out.length, 2)
  assert.equal(out[1].sourceId, "delivery:d-1")
  assert.equal(out[1].queued, false)
  assert.equal(out[1].deliveryState, "delivered")
})

test("a delivered item un-grays the JSONL's own enqueue bubble copy-on-write", () => {
  // The SDK still writes enqueue → dequeue → user in that order on an idle submit, so the fold's gray
  // bubble can render behind a receipt that already proved delivery. The projection must un-gray it —
  // WITHOUT mutating the fold's retained object, whose queued flag the fold's own delivery match still
  // resolves in place.
  const existing = msg({ queued: true, sourceId: "s:9" })
  const out = projectDeliveryLedger([existing], [item({ state: "delivered" })])
  assert.equal(out.length, 1, "no second bubble")
  assert.equal(out[0].queued, false)
  assert.equal(out[0].deliveryId, "d-1")
  assert.equal(out[0].deliveryState, "delivered")
  assert.equal(existing.queued, true, "the fold's retained object is untouched")
})

test("an enqueue record never downgrades a delivered item", () => {
  const out = correlateDeliveryRecord(
    [item({ state: "delivered" })],
    { type: "queue-operation", operation: "enqueue", content: "fix the bug", timestamp: iso(T0 + 500) },
    iso(T0 + 500),
  )
  assert.equal(out[0].state, "delivered")
})

test("a delivered item is consumed by its record like any other", () => {
  const out = correlateDeliveryRecord(
    [item({ state: "delivered" })],
    { type: "user", message: { content: "fix the bug" }, timestamp: iso(T0 + 500) },
    iso(T0 + 500),
  )
  assert.deepEqual(out, [])
})

test("a delivered item never goes amber, and drops after the same hour as enqueued", () => {
  const aged = ageDeliveries([item({ state: "delivered" })], T0 + PENDING_TIMEOUT_MS + 1000)
  assert.equal(aged[0].state, "delivered", "no 'no receipt' warning for a message the model read")
  assert.deepEqual(ageDeliveries([item({ state: "delivered" })], T0 + UNCONFIRMED_DROP_MS + 1000), [])
})

test("a delivered item survives parse round-trip", () => {
  const round = parseDeliveryLedger(serializeDeliveryLedger([item({ state: "delivered" })]))
  assert.equal(round[0]?.state, "delivered")
})
