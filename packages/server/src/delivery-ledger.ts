import { stripHumanGapNote, stripWakeDeliveryToken, type TranscriptMessage } from "@frizz/shared"
import type { Storage } from "./storage.ts"
import { decodeDeliveryMarkers, deliveryTag, stripDeliveryMarkers } from "./delivery-marker.ts"

// ── The Claude follow-up delivery ledger ───────────────────────────────────────────────────────────────
// Frizz's Claude steer path used to be fire-and-forget: keystrokes went into the worker's own terminal
// and the ONLY record that a follow-up existed was the CLIENT's optimistic gray bubble, reconciled by
// exact text match against whatever later appeared in the JSONL. That made the queued/delivered
// rendering an inference — a mangled injection (the multiline split), a slash command, or a plain
// reload made the message ghost or vanish. This ledger makes the send a server-owned state machine
// instead:
//
//   followUp(deliveryId) ──▶ pending ──(enqueue record matches)──▶ enqueued ──(queued_command /
//   user record matches)──▶ dropped from the ledger — the real transcript record takes over
//   pending ──(no evidence for PENDING_TIMEOUT_MS)──▶ unconfirmed (kept, projected with a warning,
//   dropped after UNCONFIRMED_DROP_MS — after which sending it again is the only recovery)
//
//   …and the state a send OPENS in depends on what the transport's receipt actually proved. `pending`
//   and `enqueued` both mean "not yet read"; `delivered` means the provider took the message straight
//   INTO A TURN — a codex followUp (its receipt names the turn it steered or started) and a Claude
//   follow-up to a thread with no turn in flight (idle daemon, or a cold resume where this message IS
//   what starts the turn). A delivered item renders as an ORDINARY user bubble, never the gray queued
//   one: the agent is already working on it, and graying it is how a message reads as "still enqueued"
//   for the whole seconds-to-minutes window before the provider's own record reaches disk (measured:
//   codex rollout materialization p50 3.3s with tails past an hour; a Claude cold resume ~3s). It still
//   leaves the ledger the same way everything else does — the correlator consumes it when its record
//   lands — and it is deliberately NOT retired by the daemon-death/restart sweeps, which retire only
//   claims about an unread message sitting in a dead process's queue.
//
// The ledger is persisted on the session row (`delivery_ledger`, a small JSON array), correlated by the
// tailer as it folds new JSONL records, and PROJECTED into
// the rendered transcript by readThreadTranscript: a pending/enqueued item renders as the gray queued
// bubble (sourceId `delivery:<id>`) so the queued affordance is server truth — reload-safe, and consumed
// by the client's optimistic bubble via deliveryId rather than text.
//
// An enqueue record is positive evidence Claude Code holds the message in its own queue, and a mid-turn
// queue legitimately lasts as long as the turn does — so `enqueued` outlives the pending timeout. It is
// not IMMORTAL, though, and both of its escape hatches exist because a missed correlation left one
// pinned to a row it no longer described: a LATER USER TURN drops it on the spot (the queue is FIFO, so
// the transcript has moved past it), and failing that it ages out with the unconfirmed items. See
// ageDeliveries.

export const PENDING_TIMEOUT_MS = 60_000
export const UNCONFIRMED_DROP_MS = 60 * 60_000
export const MAX_LEDGER_ITEMS = 20
// Tombstones are capped SEPARATELY from live sends, and the reason is that they are not competing for
// the same thing. A live item is a send in flight and ages out on its own; a tombstone is suppressing
// a JSONL record that will still be there tomorrow, so evicting one resurrects a message the agent
// never read. Sharing one cap meant twenty ordinary follow-ups silently un-retracted an earlier
// cancellation — reachable in an afternoon on a busy thread, not a remote edge. They still need a
// bound (the row holds each message's text), so they get their own, and the oldest goes first.
export const MAX_CANCELLED_ITEMS = 12

// `cancelled` is not a delivery state at all — it is a TOMBSTONE, and the only one that outlives its
// own message. The other three describe a send making its way to the agent; this one records a send the
// operator took BACK out of the provider's queue (see cancelDelivery), and it exists purely to keep the
// transcript honest afterwards.
//
// It has to exist because the JSONL never forgets. Claude Code writes a `queue-operation enqueue`
// record the moment it accepts a follow-up, and transcript.ts renders that record as the gray queued
// bubble. Cancelling removes the message from the CLI's queue but cannot unwrite that record.
//
// Nor does the CLI leave anything frizz could attribute the cancellation TO. Measured live
// (_live_sdk_cancel_queued.mts): the cancelled send got its `enqueue` and then nothing that names it —
// no content-bearing `remove`, no `queued_command` attachment, no user record. (A contentless
// `dequeue` was written around the same instant; contentless ops carry no send identity and both the
// parser and the correlator ignore them, so nothing here rests on what produced it.)
//
// Left alone the enqueue bubble therefore outlives the cancellation, and the FIFO backstop in transcript.ts eventually
// UN-GRAYS it when a later message delivers — rendering a message the agent provably never read as a
// message the human sent it. So frizz has to remember the cancellation itself.
export type DeliveryState = "pending" | "enqueued" | "delivered" | "unconfirmed" | "cancelled"

export interface DeliveryLedgerItem {
  id: string
  text: string
  state: DeliveryState
  at: string // ISO8601 — when frizz accepted/injected the follow-up
  updatedAt: string
  // LEGACY COUNTER, read by nothing. How many times the submit-confirmer re-sent a BARE Enter because
  // this item was still provably sitting in the worker's own composer — capped at MAX_SUBMIT_ATTEMPTS,
  // after which the item aged straight to `unconfirmed` so the drawer said so. It was absent on every
  // row that predated it and is absent on every row written since: delivery-confirm.ts and that cap
  // went with the rest of the terminal-control apparatus (8a57e29), and a broker send has no keystroke
  // to re-send. Kept on the type as the record of what an old persisted row may still carry.
  submitAttempts?: number
}

// The form every text comparison in this module runs in.
//
// The steer channel REWROTE frizz's bytes before they reached the JSONL, so the text frizz sent and the
// text the transcript recorded were not equal and an exact compare stranded the send as `unconfirmed`
// forever. That channel was a COMPOSITION of two rewriters frizz did not own — the paste transport
// (LF→CR) and Claude Code's TUI paste handler (`/\r\n|\r/`→`\n`, `\t`→four spaces) — and measuring it
// against a live claude 2.1.219 TUI, driven through frizz's own paste sequence, showed:
//
//     sent          recorded          note
//     \t            "    "            four spaces, not a tab stop
//     \r\n          \n\n              the line break DOUBLES (CR→LF then LF→newline)
//     \r            \n
//     trailing " ", unicode, nbsp, long unwrapped lines — preserved verbatim
//
// Two distinct classes, not one. The maintainer hit the tab class (2026-07-25,
// `were-taking-over-from-another-agent`: a 1448-char send with two tabs recorded as 1454 chars with
// none, 34ms after the send, and still marked unconfirmed at the 60s timeout). The CRLF class was worse
// and just as reachable — anything pasted from a Windows-authored source or many web textareas — and a
// comparison that preserved line COUNT still stranded it.
//
// So do not model the channel; be INVARIANT to it. Every whitespace run — spaces, tabs, newlines alike
// — collapses to a single space, which was stable under every rewrite above and is stable under any
// future re-flow in the same family (a re-wrap, a trailing-space trim, a different tab width). A broker
// send reaches the JSONL unrewritten, so those two classes cannot recur — but the separator a COALESCED
// record inserts between two glued sends is exactly this kind of difference, so the canonical form is
// still what lets composition line up. What actually keeps it safe is unchanged and lives elsewhere:
// evidence must be CONTEMPORANEOUS, a mid-record match must clear COMPOSED_ANCHOR_MIN, and composition
// consumes items in order. Precedent: the far more dangerous decision this system ever made — whether
// to press Enter on a live composer — was gated on FULL whitespace removal (`squash`, in the since
// deleted delivery-confirm.ts). Applied to BOTH sides of every comparison, so the composition offsets
// in matchComposedText stay internally consistent.
//
// What this deliberately does NOT forgive: differing WORDS. A send whose recorded text differs beyond
// whitespace still ages to `unconfirmed`, which is the warning doing its job.
const canon = (s: string): string => s.replace(/\s+/g, " ").trim()

function isItem(v: unknown): v is DeliveryLedgerItem {
  if (!v || typeof v !== "object") return false
  const i = v as Partial<DeliveryLedgerItem>
  return typeof i.id === "string" && typeof i.text === "string" && typeof i.at === "string" &&
    typeof i.updatedAt === "string" && (["pending", "enqueued", "delivered", "unconfirmed", "cancelled"] as const).includes(i.state as DeliveryState)
}

export function parseDeliveryLedger(json: string | null | undefined): DeliveryLedgerItem[] {
  if (!json) return []
  try {
    const doc = JSON.parse(json)
    return Array.isArray(doc) ? doc.filter(isItem) : []
  } catch {
    return []
  }
}

export function serializeDeliveryLedger(items: DeliveryLedgerItem[]): string | null {
  return items.length ? JSON.stringify(items) : null
}

// Record a freshly accepted follow-up. Idempotent on id (an RPC retry must not double-project), capped
// so a wedged session can't grow the row without bound (oldest evicted first — they're the stalest
// unconfirmed sends, and the terminal is their recovery surface).
// `state` defaults to `pending` — a Claude send is fire-into-a-composer and has no receipt until the
// JSONL shows one. A CODEX send passes `enqueued` instead, because the app-server RPC returning a turn
// id IS the receipt: the provider has positively accepted the text. That distinction matters beyond
// bookkeeping — `pending` is what ages into the amber "no receipt from the worker" warning, and a codex
// app-server thread has no terminal composer to check, so it must never enter that state.
// Bound the row, oldest-first, counting live sends and tombstones against their OWN caps so a run of
// ordinary follow-ups can never evict a cancellation. Order is otherwise preserved: matchComposedText
// consumes items in send order, so a reshuffle here would silently change how a coalesced record is
// attributed.
export function trimLedger(items: DeliveryLedgerItem[]): DeliveryLedgerItem[] {
  const overLive = items.filter((i) => i.state !== "cancelled").length - MAX_LEDGER_ITEMS
  const overCancelled = items.filter((i) => i.state === "cancelled").length - MAX_CANCELLED_ITEMS
  if (overLive <= 0 && overCancelled <= 0) return items
  let dropLive = Math.max(0, overLive)
  let dropCancelledCount = Math.max(0, overCancelled)
  return items.filter((item) => {
    if (item.state === "cancelled") {
      if (dropCancelledCount > 0) { dropCancelledCount--; return false }
      return true
    }
    if (dropLive > 0) { dropLive--; return false }
    return true
  })
}

export function appendDelivery(
  storage: Storage,
  slug: string,
  item: { id: string; text: string; now?: number; state?: DeliveryState },
): void {
  const row = storage.getSession(slug)
  if (!row) return
  const items = parseDeliveryLedger(row.delivery_ledger)
  if (items.some((existing) => existing.id === item.id)) return
  const at = new Date(item.now ?? Date.now()).toISOString()
  items.push({ id: item.id, text: item.text, state: item.state ?? "pending", at, updatedAt: at })
  storage.setDeliveryLedger(slug, serializeDeliveryLedger(trimLedger(items)))
}

// Has this exact send already been recorded as delivered? The entry is written only once
// `resumeThread` returns, so a hit is positive evidence the text crossed into the worker. This makes a
// replayed deliveryId a no-op — defense-in-depth against a replay from any source (a stale tab, an
// at-least-once transport). It is NOT what makes the client retry safe: because the append trails the
// injection, a hit only ever exists for an ALREADY-delivered send, never for the pre-injection refusals
// the client actually replays. Keeping every retryable throw upstream of the first write is the real
// guarantee; a miss here proves nothing.
// Turn an outstanding send into a cancellation TOMBSTONE — called only once the provider has positively
// confirmed the message left its queue. Returns the item's text (what the operator gets back in their
// prompt box) or null when there is no such outstanding item.
//
// The row keeps its id and text on purpose: the id is what makes `hasDelivery` keep refusing a replayed
// send of the cancelled deliveryId, and the text is what `projectDeliveryLedger` matches the orphaned
// JSONL enqueue bubble against. `updatedAt` becomes the cancellation instant, which bounds that match
// (see the projection) so a LATER re-send of the same words is never mistaken for the retracted copy.
export function cancelDelivery(storage: Storage, slug: string, id: string, now?: number): string | null {
  const row = storage.getSession(slug)
  if (!row) return null
  const items = parseDeliveryLedger(row.delivery_ledger)
  const index = items.findIndex((item) => item.id === id)
  if (index < 0 || items[index].state === "cancelled") return null
  const at = new Date(now ?? Date.now()).toISOString()
  const next = items.map((item, i) => (i === index ? { ...item, state: "cancelled" as const, updatedAt: at } : item))
  storage.setDeliveryLedger(slug, serializeDeliveryLedger(next))
  return items[index].text
}

/**
 * Retire every still-outstanding send on a session whose worker process has just been REPLACED, and
 * report how many went. Returns 0 when there was nothing to retire.
 *
 * A restart is positive evidence about exactly these items. `pending`/`enqueued` mean "frizz handed
 * this to a process and is still waiting for the transcript to show it"; `killBroker` then SIGTERMs
 * that process. Anything the agent actually read is already in the JSONL, where the tailer correlates
 * it and drops the row on its own — so what is left at this moment is provably unread, and its queued
 * bubble is now a claim about a process that no longer exists. Left alone it lingers for the rest of
 * UNCONFIRMED_DROP_MS (an hour), and cannot be dismissed by hand either: the unqueue click asks the
 * NEW daemon to cancel a uuid it never heard of, gets `false`, and answers "Too late — that message
 * has already left the queue" — the precise opposite of the truth.
 *
 * DROPPED, not tombstoned. A `cancelled` tombstone suppresses a matching JSONL enqueue bubble, so
 * using one here would hide a message that DID land in the sliver before the kill but that the tailer
 * had not yet correlated. Dropping only stops frizz projecting its own synthetic bubble; if a real
 * record exists it renders on its own. Same reasoning, and the same words, as the age-out in
 * `ageDeliveries`: this only stops PROJECTING it; nothing about the real message is touched.
 */
export function retireOutstandingDeliveries(storage: Storage, slug: string): number {
  const row = storage.getSession(slug)
  if (!row) return 0
  const items = parseDeliveryLedger(row.delivery_ledger)
  const next = items.filter((item) => item.state !== "pending" && item.state !== "enqueued")
  if (next.length === items.length) return 0
  storage.setDeliveryLedger(slug, serializeDeliveryLedger(next))
  return items.length - next.length
}

/**
 * Mark every still-outstanding send on a session DELIVERED, and report how many moved. Returns 0 when
 * there was nothing outstanding.
 *
 * The receipt is a LANDED INTERRUPT — the operator forcing the queue through, from ⌘⏎ or from the ↑ on
 * a queued bubble. The SDK's interrupt aborts the turn WITHOUT discarding queued input, so the next
 * turn opens on exactly what is queued: these sends are read, not waiting, which is what `delivered`
 * says (see the state machine above). Without it the whole point of the gesture is invisible — the
 * bubbles stay gray, pinned below the working indicator that is already answering them, for the entire
 * window before their delivery records reach disk.
 *
 * EVERY outstanding item moves, not just the one the operator pointed at: the queue is FIFO and the
 * interrupt preempts the TURN standing in front of all of them.
 *
 * The one send this can misreport is one handed to a daemon too old to know the interrupt frame, which
 * ignores it and reads the message at the ordinary time (see the bridge's interruptTurn). It renders
 * as delivered a little early; the maintainer took that trade over the wait.
 */
export function deliverOutstandingDeliveries(storage: Storage, slug: string): number {
  const row = storage.getSession(slug)
  if (!row) return 0
  const items = parseDeliveryLedger(row.delivery_ledger)
  const at = new Date().toISOString()
  let moved = 0
  const next = items.map((item) => {
    if (item.state !== "pending" && item.state !== "enqueued") return item
    moved++
    return { ...item, state: "delivered" as const, updatedAt: at }
  })
  if (!moved) return 0
  storage.setDeliveryLedger(slug, serializeDeliveryLedger(next))
  return moved
}

/** The ledger row for one send, or null when nothing outstanding carries that id. */
export function deliveryItem(storage: Storage, slug: string, id: string): DeliveryLedgerItem | null {
  const row = storage.getSession(slug)
  if (!row) return null
  return parseDeliveryLedger(row.delivery_ledger).find((item) => item.id === id) ?? null
}

export function hasDelivery(storage: Storage, slug: string, id: string): boolean {
  const row = storage.getSession(slug)
  if (!row) return false
  return parseDeliveryLedger(row.delivery_ledger).some((item) => item.id === id)
}

// The text of a `queued_command` attachment's prompt. A typed follow-up carries a bare string; one the
// human attached an image to carries an ARRAY of content blocks, with the words in the `text` ones —
// 10 such in this machine's corpus, every one text+image. Both readers (correlation here, rendering in
// transcript.ts) share this so a send with a screenshot attached behaves exactly like a typed one.
// Lives here rather than in transcript.ts because transcript.ts already imports this module.
export function attachmentPromptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt
  if (!Array.isArray(prompt)) return ""
  return prompt
    .filter((b): b is { type: string; text: string } =>
      Boolean(b) && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n")
}

// Extract the plain text of a user record (string content, or the joined text blocks) — mirrors the
// transcript parser's reading, minimally.
function userRecordText(rec: Record<string, unknown>): string {
  const message = rec.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => Boolean(b) && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
      .map((b) => b.text)
      .join("\n")
  }
  return ""
}

// A codex rollout's own user-message records. Codex writes the human turn TWICE, and both count as
// evidence the text reached it:
//   • the SEMANTIC record — `event_msg` / `user_message` (payload.message, a plain string) up to codex
//     0.152, and `event_msg` / `item_completed` wrapping a `UserMessage` item (item.content[]) from
//     0.153. This is the one the transcript renderer treats as the authoritative human turn (see
//     backend/codex.ts, which reads both spellings for the same reason).
//   • `response_item` / `message` role:"user" — payload.content[], the model-facing copy, 424 here.
//     UNCHANGED across the 0.153 rewrite, which is the only reason this ledger kept working through it.
// Deliberately narrow on all three so a claude record can never fall down this branch, and vice versa.
function isCodexUserMessage(r: Record<string, unknown>): boolean {
  const payload = r.payload as { type?: unknown; role?: unknown; item?: unknown } | undefined
  if (!payload) return false
  if (r.type === "event_msg" && payload.type === "user_message") return true
  if (r.type === "event_msg" && payload.type === "item_completed") {
    return (payload.item as { type?: unknown } | undefined)?.type === "UserMessage"
  }
  return payload.type === "message" && payload.role === "user"
}

function codexUserMessageText(r: Record<string, unknown>): string {
  const payload = r.payload as { content?: unknown; message?: unknown; item?: unknown } | undefined
  if (typeof payload?.message === "string") return payload.message
  const item = payload?.item as { content?: unknown } | undefined
  const content = item?.content ?? payload?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b): b is { type: string; text: string } =>
      Boolean(b) && typeof (b as { text?: unknown }).text === "string" &&
      ((b as { type?: unknown }).type === "input_text" || (b as { type?: unknown }).type === "text"))
    .map((b) => b.text)
    .join("\n")
}

// The id frizz itself supplied for this input, if the record is one the SDK minted FROM a frizz input.
// Deliberately narrow — only the two record shapes measured to echo it — so nothing else in a
// transcript can be mistaken for a delivery receipt. Returns null for every pre-broker record.
export function echoedInputId(rec: Record<string, unknown>): string | null {
  if (rec.type === "attachment") {
    const att = rec.attachment as { type?: unknown; commandMode?: unknown; source_uuid?: unknown } | undefined
    if (att?.type !== "queued_command" || att.commandMode !== "prompt") return null
    return typeof att.source_uuid === "string" && att.source_uuid ? att.source_uuid : null
  }
  // A tool_result echo is also `type:"user"` but carries no prompt of its own; requiring a non-meta
  // record keeps this to records that represent a human turn.
  if (rec.type === "user" && rec.isMeta !== true && typeof rec.uuid === "string" && rec.uuid) return rec.uuid
  return null
}

// Fold ONE freshly appended JSONL record into the ledger. Pure: returns the same array when nothing
// matched, a new array otherwise. `nowIso` stamps updatedAt (injectable for tests).
export function correlateDeliveryRecord(
  items: DeliveryLedgerItem[],
  rec: unknown,
  nowIso: string,
): DeliveryLedgerItem[] {
  if (!items.length || !rec || typeof rec !== "object") return items
  const r = rec as Record<string, unknown>
  // Evidence must be CONTEMPORANEOUS: a server-restart prime replays the whole JSONL through this
  // correlator, and an OLD user record that happens to repeat a pending item's text ("continue") must
  // not count as its delivery. A record timestamped before the send (small skew allowance) never
  // resolves an item; an untimestamped record is accepted (every observed shape carries one).
  const recMs = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN
  const contemporaneous = (item: DeliveryLedgerItem): boolean => {
    if (!Number.isFinite(recMs)) return true
    const born = Date.parse(item.at)
    return !Number.isFinite(born) || recMs >= born - 5_000
  }

  // Claude Code accepted the message into its own queue → positive receipt, still undelivered.
  // Deliberately NOT gated on state==='pending': the evidence can arrive long after PENDING_TIMEOUT_MS
  // aged the item to 'unconfirmed' (87s and 12min observed in the maintainer's own transcript, because
  // the composer can hold a paste for minutes before the TUI submits it). An enqueue record is positive
  // proof the message reached Claude Code's queue, so it must clear the amber warning whenever it lands.
  if (r.type === "queue-operation" && r.operation === "enqueue" && typeof r.content === "string") {
    const matched = accountFor(items, r.content, contemporaneous)
    if (matched.size === 0) return items
    // Only ever an UPGRADE from "no receipt yet". A `delivered` item must not regress to enqueued when
    // its own enqueue record folds in behind the receipt: on the SDK path an idle submit still writes
    // enqueue → dequeue → user in that order, and the receipt already proved the message went straight
    // into the turn.
    return items.map((item, index) =>
      matched.has(index) && (item.state === "pending" || item.state === "unconfirmed") ? { ...item, state: "enqueued", updatedAt: nowIso } : item,
    )
  }

  // DEQUEUE — Claude Code taking the message back OUT of its own queue and into the turn.
  //
  // frizz used to learn this only from the `queued_command` attachment that follows, and the gap is real:
  // across 263 dequeues in this machine's transcripts the attachment lands 1 to 19 records later (p50 2,
  // p95 6). For that whole window the send is already being worked on while frizz still renders it as a
  // gray queued bubble — which the chat pins BELOW the working indicator, so the spinner appears above
  // the very message it is answering. Resolving on the dequeue closes the window.
  //
  // `remove` is the usable signal: all 2398 in the corpus carry their content, so they can be
  // correlated. The `dequeue` operation is NOT — all 1032 of them carry no content at all, and a bare
  // handshake cannot be attributed to a specific send. `popAll` never appeared.
  //
  // A content-bearing `remove` is also what a CANCELLATION looks like (the human ESC-ing a queued
  // message in the terminal). Dropping the item is right either way: the message is provably no longer
  // queued, so continuing to render frizz's own synthetic bubble for it would be a lie in both readings,
  // and the transcript's own records go on telling the true story.
  if (r.type === "queue-operation" && r.operation === "remove" && typeof r.content === "string" && r.content.trim()) {
    const dequeued = accountFor(items, r.content, contemporaneous)
    if (dequeued.size === 0) return items
    return items.filter((_, index) => !dequeued.has(index))
  }

  // ── IDENTITY, the exact path (broker/SDK rows) ──────────────────────────────────────────────────
  // frizz hands the SDK a `uuid` with every input (claude-agent-broker-bridge → sendInput), and the SDK
  // ECHOES IT BACK on the record that materializes that input:
  //   • delivered straight away → the `user` record's own `uuid`
  //   • delivered out of the queue → the `queued_command` attachment's `source_uuid`
  // Both verified byte-exact against a live claude 2.1.220 broker session, and `source_uuid` is present
  // on 78/78 sdk prompt attachments in this machine's corpus. No prose is compared, so the case text
  // matching gets WRONG — two sends the agent dequeues in the same instant, either of which the fuzzy
  // matcher can attribute to the other — resolves exactly. Degrades to the text paths below whenever the
  // id is absent (every pre-broker row, and the coalesced record, which mints a fresh uuid of its own).
  const echoed = echoedInputId(r)
  if (echoed !== null) {
    const index = items.findIndex((item) => item.id === echoed && item.state !== "cancelled")
    if (index >= 0 && contemporaneous(items[index])) return items.filter((_, i) => i !== index)
  }

  // Delivery into the agent's context: the queued_command attachment (mid-turn/turn-start pickup) or a
  // plain user record (idle submit / dead-session resume / the 2.1.207 print-path shape). Either one
  // resolves the item — delivered items leave the ledger; the real transcript record renders from here.
  let deliveredText: string | null = null
  if (r.type === "attachment") {
    const att = r.attachment as { type?: unknown; commandMode?: unknown; prompt?: unknown } | undefined
    if (att?.type === "queued_command" && att.commandMode === "prompt") {
      // Array-shaped for an image-bearing follow-up; the same reader the transcript uses, so a send
      // with a screenshot attached correlates exactly like a typed one.
      const text = attachmentPromptText(att.prompt)
      if (text) deliveredText = text
    }
  } else if (r.type === "user" && r.isMeta !== true) {
    const text = userRecordText(r)
    if (text) deliveredText = text
  } else if (isCodexUserMessage(r)) {
    // CODEX rollout shape: {timestamp, type:"response_item", payload:{type:"message", role:"user",
    // content:[{type:"input_text", text}]}}. The app-server RPC already receipted this send, so the
    // ledger item exists only to render the bubble until the rollout materialises it — which measured
    // 3.3s at p50 but 71s, 212s and 4.6h in the tail, well past the client ghost floor that would
    // otherwise retire the only copy of the message on screen.
    const text = codexUserMessageText(r)
    if (text) deliveredText = text
  }
  if (deliveredText === null) return items
  const delivered = accountFor(items, deliveredText, contemporaneous)
  if (delivered.size === 0) return items
  return items.filter((_, index) => !delivered.has(index))
}

// Which ledger items one evidence record accounts for — BY IDENTITY first, by text only as the fallback.
//
// frizz used to stamp every follow-up it pasted with an invisible marker carrying that send's
// deliveryId (delivery-marker.ts), so the normal path was an exact lookup: no prose compared at all and
// no rewrite of the surrounding text — tab expansion, CRLF doubling, a re-wrap, a future mangling
// nobody had met yet — could break it. A record that glued several sends together carried every
// constituent's marker, so all of them resolved from the one record. A broker send needs none of that
// (the SDK echoes frizz's own `uuid` back — see the IDENTITY section in correlateDeliveryRecord), so nothing
// stamps a marker now; this branch still reads one out of an older transcript.
//
// The text path remains for everything neither a marker nor an echoed id covers: sends already in
// flight across an upgrade, a record from a worker frizz adopted rather than launched, and any send
// whose marker the old channel destroyed. It runs on the STRIPPED text so a marker never perturbs the
// comparison.
export function accountFor(
  items: readonly DeliveryLedgerItem[],
  recordText: string,
  contemporaneous: (item: DeliveryLedgerItem) => boolean,
): Set<number> {
  const matched = new Set<number>()
  const tags = decodeDeliveryMarkers(recordText)
  if (tags.length) {
    const wanted = new Set(tags)
    // A tag held by more than one outstanding item is ambiguous — refuse the shortcut for those and let
    // the text path decide, rather than resolving an arbitrary one of them.
    const owners = new Map<number, number[]>()
    items.forEach((item, index) => {
      if (item.state === "cancelled") return // a tombstone is never evidence of its own delivery
      const tag = deliveryTag(item.id)
      if (wanted.has(tag)) owners.set(tag, [...(owners.get(tag) ?? []), index])
    })
    for (const [, indexes] of owners) {
      if (indexes.length !== 1) continue
      const index = indexes[0]
      if (contemporaneous(items[index])) matched.add(index)
    }
  }
  // The text path then runs over the WHOLE ledger, not just the leftovers. Letting it re-consume an
  // item a marker already resolved costs nothing (both sides union into one set) and is what keeps a
  // MIXED record working: when a marked send is glued ahead of an unmarked one, the composition still
  // walks the marked text first and so meets the unmarked item at a clean prefix boundary.
  for (const index of matchComposedText(items, canon(stripDeliveryMarkers(recordText)), contemporaneous)) {
    matched.add(index)
  }
  return matched
}

// A merged submission's constituent text must be at least this long before it may be matched at a
// non-zero offset (i.e. after content this ledger never sent — a draft the operator had already typed
// into the worker's own composer). Whole-record and prefix-anchored matches are exact and are not
// length-gated; this bound exists so a short generic send ("continue") can't be resolved by merely
// APPEARING inside an unrelated message the human typed themselves.
const COMPOSED_ANCHOR_MIN = 24

// Which ledger items a single JSONL evidence record accounts for.
//
// The naive rule — whole-string equality — is what shipped, and it is wrong for the case the operator
// actually hit. frizz injected a follow-up by pasting into Claude Code's composer and sending Enter,
// and the TUI could SWALLOW that Enter while it was mid-render: the text stayed in the composer, the
// NEXT follow-up's paste landed after it, and its Enter submitted the ACCUMULATION as one message.
// Claude Code then wrote exactly one `queue-operation enqueue` and one `queued_command` attachment
// whose text was the CONCATENATION of the N sends. Verified byte-exact against the maintainer's own
// transcript (2026-07-23, thread `why-when-i-try-to-change`): a 709-char enqueue = item(565) + "\n" +
// item(143), and a 379-char enqueue = item(196) + item(183) with no separator at all. Under
// whole-string equality NONE of the four constituents matched, all four aged to `unconfirmed`, and the
// drawer told the operator to "check the terminal" for four messages the agent had already read and
// acted on.
//
// So: consume the record left-to-right, taking any unconsumed item whose text is a PREFIX of what's
// left (skipping the newline a glued submission may carry between two sends). Every consumed segment is
// a whole item text anchored at a boundary the previous items produced, so this is strictly a
// generalization of equality — it can only match MORE of a record that the ledger genuinely composed,
// never a coincidental substring in the middle of an unrelated message. Still live, not history: a
// COALESCED record mints a fresh uuid of its own, so the echoed-id path cannot resolve one and this
// path must (see the IDENTITY section in correlateDeliveryRecord).
export function matchComposedText(
  items: readonly DeliveryLedgerItem[],
  recordText: string,
  contemporaneous: (item: DeliveryLedgerItem) => boolean,
): Set<number> {
  const matched = new Set<number>()
  if (!recordText) return matched
  let rest = recordText
  // The record may open with content this ledger never sent (a draft the human had typed into the
  // worker's own composer). Anchor once on the earliest long-enough item that occurs in the record,
  // then compose forward from it — every later segment must be a clean prefix of what remains.
  let anchored = false
  const candidate = (index: number): string | null => {
    if (matched.has(index)) return null
    const item = items[index]
    // A tombstone is not an outstanding send: the provider confirmed it left the queue, so no later
    // record can be evidence of its delivery, and matching one would silently retire the very row that
    // keeps its orphaned enqueue bubble suppressed.
    if (item.state === "cancelled") return null
    if (!contemporaneous(item)) return null
    const text = canon(item.text)
    return text || null
  }
  for (let guard = 0; guard < items.length && rest.length > 0; guard++) {
    let hit: { index: number; at: number; length: number } | null = null
    // Prefix matches always win — they are exact composition, and never length-gated.
    for (let index = 0; index < items.length; index++) {
      const text = candidate(index)
      if (text && rest.startsWith(text)) { hit = { index, at: 0, length: text.length }; break }
    }
    if (!hit && !anchored) {
      for (let index = 0; index < items.length; index++) {
        const text = candidate(index)
        if (!text || text.length < COMPOSED_ANCHOR_MIN) continue
        const at = rest.indexOf(text)
        if (at > 0 && (!hit || at < hit.at)) hit = { index, at, length: text.length }
      }
    }
    if (!hit) break
    matched.add(hit.index)
    anchored = true
    // Any whitespace the composer left at the seam is separator, not content — the same argument that
    // already let a newline be skipped here, widened to match the canonical form above.
    rest = rest.slice(hit.at + hit.length).replace(/^\s+/, "")
  }
  return matched
}

// Level-triggered aging, run every tick: a pending item with no evidence for PENDING_TIMEOUT_MS becomes
// 'unconfirmed' (the injection likely mutated or never landed — the projection flags it); an unconfirmed
// item older than UNCONFIRMED_DROP_MS is dropped entirely.
//
// `observedUserAt` is the timestamp of the newest USER RECORD the tailer has folded out of this thread's
// transcript, and it is the escape hatch for a send whose own delivery record the correlator missed. The
// provider's queue is FIFO, so a user turn at or after an outstanding send's `at` means the queue has
// ALREADY moved past that send — it was delivered, and the transcript record the correlator failed to
// attribute is sitting right there. Keeping the item past that point is not a cautious guess, it is a
// claim the transcript contradicts, and it costs more than a stale bubble: `hasFreshDelivery` (board.ts)
// reads pending/enqueued as "the human already answered, so this thread is not waiting on them" and
// takes the thread OUT OF THE QUEUE. Observed 2026-08-14 on nub's `idea-from-jdx-creator-of-mise`: one
// `enqueued` item from 22:37:14, delivered at 22:38:11 inside a COMPOSED record (two queued sends
// submitted as one message), left un-correlated by the live fold. The thread answered, asked a fresh
// ```question at 22:59, and never carded — it sat in the rested rail with no card behind it, which is
// exactly the 2026-07-29 report ("there's no card for it in the UI — when I click it, it opens it in a
// drawer") reaching the same place down a different path. `enqueued` only ages out after an HOUR, so
// that is how long the thread stayed invisible.
//
// It cannot fire early on a send that really is still queued: an undelivered message is BEHIND every
// user record in the transcript by construction, so nothing newer than it exists until it lands — and
// the record that DOES land is both the thing that bumps this timestamp and the thing the correlator
// consumes the item on. The window this closes is only the one where those two disagree.
export function ageDeliveries(items: DeliveryLedgerItem[], nowMs: number, observedUserAt?: string): DeliveryLedgerItem[] {
  if (!items.length) return items
  let changed = false
  const userAtMs = Date.parse(observedUserAt ?? "")
  const supersededByUserTurn = (item: DeliveryLedgerItem): boolean => {
    if (!Number.isFinite(userAtMs)) return false
    const born = Date.parse(item.at)
    return Number.isFinite(born) && userAtMs >= born
  }
  const next: DeliveryLedgerItem[] = []
  for (const item of items) {
    // A tombstone never ages. It is not describing a send in flight — it is suppressing a JSONL record
    // that will still be there tomorrow, so a timeout would simply resurrect the cancelled bubble one
    // hour later. It is bounded the other way instead: MAX_LEDGER_ITEMS evicts the oldest rows as new
    // sends arrive, by which point the orphaned enqueue is far up in settled history.
    if (item.state === "cancelled") { next.push(item); continue }
    // Delivered, on the transcript's own evidence — see `supersededByUserTurn`. Applies to `unconfirmed`
    // as well: that state's amber "no receipt from the worker" warning is a claim about a send nobody read, and a
    // later user turn falsifies it just as squarely as it does a live one.
    if (supersededByUserTurn(item)) { changed = true; continue }
    const born = Date.parse(item.at)
    if (item.state === "pending" && Number.isFinite(born) && nowMs - born > PENDING_TIMEOUT_MS) {
      next.push({ ...item, state: "unconfirmed", updatedAt: new Date(nowMs).toISOString() })
      changed = true
      continue
    }
    if (item.state === "unconfirmed" && Number.isFinite(born) && nowMs - born > UNCONFIRMED_DROP_MS) {
      changed = true // dropped
      continue
    }
    // `enqueued` used to be IMMORTAL: nothing aged it and nothing dropped it, so a single missed
    // delivery record left a gray queued bubble pinned below the working indicator for the life of the
    // row — the "it still says queued long after the agent answered it" report. The reasoning for never
    // timing it out was sound (a mid-turn queue legitimately lasts as long as the turn) but it left no
    // escape hatch at all. Give it the same hour the unconfirmed items get: past that, a queue entry is
    // not a live queue entry, and the transcript's own records are a better witness than frizz's
    // synthetic bubble. This only stops PROJECTING it; nothing about the real message is touched.
    if (item.state === "enqueued" && Number.isFinite(born) && nowMs - born > UNCONFIRMED_DROP_MS) {
      changed = true // dropped
      continue
    }
    // Same hour bound for `delivered` — its record is expected imminently, and the codex rollout tail
    // has been observed past an hour, but a record that never lands must not leave a synthetic bubble
    // forever. It never goes amber: `unconfirmed` warns about a send NOBODY read, and this one was read.
    if (item.state === "delivered" && Number.isFinite(born) && nowMs - born > UNCONFIRMED_DROP_MS) {
      changed = true // dropped
      continue
    }
    next.push(item)
  }
  return changed ? next : items
}

// The canonical form for matching a LEDGER item against a RENDERED transcript message.
//
// The worker's copy of a follow-up can carry riders the ledger deliberately never records: the
// human-gap clock note (humanGapNote — appended by the router to any follow-up landing ≥20min after
// the agent last spoke) and the wake delivery token. The JSONL records that copy verbatim, so the
// fold's queued bubble for a noted send is the ledger text PLUS the note — and comparing with bare
// `canon` misses it, which made projectDeliveryLedger append a SECOND bubble for the very send the
// fold already rendered: two identical gray bubbles, since the note is display-stripped on both
// (the maintainer's 2026-08-24 double render). Correlation never had this problem — its composed
// matcher takes the item as a PREFIX of the record — but the projection compares whole strings, so
// it must shed the riders first. Applied to BOTH sides, so a message that genuinely ends in a
// quoted note still matches its own record.
const renderMatchKey = (s: string): string => canon(stripHumanGapNote(stripWakeDeliveryToken(stripDeliveryMarkers(s))))

// How far past the cancellation instant a rendered bubble may still be the cancelled send. Covers the
// clock skew between frizz's own timestamp and the CLI's record, and nothing more: the bound is what
// keeps a LATER re-send of the same words — the likely next thing the operator does, since unqueueing
// hands them the text back in the prompt box — from being eaten by its own tombstone.
const CANCEL_MATCH_SLACK_MS = 5_000

// Remove the orphaned rendering of every CANCELLED send, and return the live items.
//
// The JSONL's `queue-operation enqueue` for a cancelled send is still on disk and still renders — as a
// queued bubble, or as an UN-GRAYED one once transcript.ts's FIFO backstop passes over it when a later
// message delivers. Drop it: the provider confirmed the agent never read those words, so showing them
// in the conversation is a lie in either styling. Bounded to one bubble per tombstone, and to the
// window between the send and its cancellation, so nothing outside that window can be claimed.
type LiveDeliveryItem = DeliveryLedgerItem & { state: Exclude<DeliveryState, "cancelled"> }

// The suppression half alone, for readers that must NOT project queued bubbles.
//
// An EARLIER page is settled history: a pending send can never belong there, so it never gets the
// projection. But a cancelled one's orphan absolutely can — a retracted message scrolls out of the
// latest window like any other, and without this it reappears intact the moment the operator scrolls
// back, un-grayed by the FIFO backstop and indistinguishable from a message they really sent.
export function suppressCancelledDeliveries(messages: TranscriptMessage[], items: DeliveryLedgerItem[]): TranscriptMessage[] {
  return items.length ? dropCancelled(messages, items).messages : messages
}

function dropCancelled(
  messages: TranscriptMessage[],
  items: DeliveryLedgerItem[],
): { messages: TranscriptMessage[]; live: LiveDeliveryItem[] } {
  const live = items.filter((item): item is LiveDeliveryItem => item.state !== "cancelled")
  if (live.length === items.length) return { messages, live }
  const dropped = new Set<number>()
  for (const item of items) {
    if (item.state !== "cancelled") continue
    const text = renderMatchKey(item.text)
    const from = Date.parse(item.at) - 5_000
    const to = Date.parse(item.updatedAt) + CANCEL_MATCH_SLACK_MS
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "user" || dropped.has(i)) continue
      if (renderMatchKey(m.text) !== text) continue
      // An untimestamped bubble cannot be placed in the window; nothing but this send could have
      // rendered it, so accepting it is safe and leaving it on screen is not.
      const at = m.at ? Date.parse(m.at) : NaN
      if (Number.isFinite(at) && Number.isFinite(from) && Number.isFinite(to) && (at < from || at > to)) continue
      dropped.add(i)
      break
    }
  }
  return { messages: dropped.size ? messages.filter((_, i) => !dropped.has(i)) : messages, live }
}

// Project the ledger into a rendered transcript: every follow-up whose record has not reached the JSONL
// yet renders as a user bubble — gray queued styling while it is genuinely waiting to be read, ordinary
// styling once the transport's receipt proved it went into a turn (state `delivered`) — reload-safe
// server truth replacing the client-only optimistic bubble. Rules, per item:
//  • a CANCELLED item is a tombstone — it renders nothing and REMOVES the JSONL bubble it left behind;
//  • the JSONL's own queued (enqueue) bubble already renders it → tag that bubble with the deliveryId
//    (the client's optimistic copy consumes by id) and don't double-render — un-graying it first when
//    the item says `delivered`;
//  • a delivered copy already renders (correlation prune races a read by ≤1 tick) → skip entirely;
//  • otherwise append a bubble at the tail, where a just-sent follow-up belongs.
export function projectDeliveryLedger(messages: TranscriptMessage[], items: DeliveryLedgerItem[]): TranscriptMessage[] {
  if (!items.length) return messages
  const cancelled = dropCancelled(messages, items)
  messages = cancelled.messages
  if (!cancelled.live.length) return messages
  // One rendered message accounts for at most ONE ledger item. Without this, two outstanding sends that
  // happen to carry the SAME words both resolved to the same bubble — the second item tagged it with
  // its own deliveryId and then skipped projecting, so the operator saw ONE queued bubble for two
  // messages they had sent, and the first send's optimistic client copy (which consumes by deliveryId)
  // was never accounted for. Bubbles this loop APPENDS are claimed too — the scan below re-reads
  // `messages.length` each pass, so without that a second item simply adopted the bubble the first one
  // had just projected, which is the same collapse by another route (seen live: two identical sends,
  // ledger holding both, exactly one gray bubble on screen).
  const claimed = new Set<number>()
  for (const item of cancelled.live) {
    const text = renderMatchKey(item.text)
    const tag = deliveryTag(item.id)
    let handled = false
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "user" || claimed.has(i)) continue
      // Same order as correlation: identity if the rendered copy still carries our marker, text
      // otherwise. Transcript text is stripped for display before it reaches here, so in practice this
      // is the text compare — the tag check costs nothing and covers any surface that keeps the raw.
      if (!decodeDeliveryMarkers(m.text).includes(tag) && renderMatchKey(m.text) !== text) continue
      if (m.queued) {
        if (item.state === "delivered") {
          // The provider took this send straight into a turn, but the fold has only seen its enqueue
          // record so far (SDK order on an idle submit: enqueue → dequeue → user). Un-gray the fold's
          // bubble COPY-ON-WRITE — the object is owned by the retained fold, and the fold's own
          // delivery match must still find it queued and resolve it in place.
          messages[i] = { ...m, queued: false, deliveryId: item.id, deliveryState: item.state }
        } else {
          m.deliveryId = item.id
          m.deliveryState = item.state
        }
      }
      claimed.add(i)
      handled = true // queued (tagged in place) or already delivered — either way, no projection
      break
    }
    if (handled) continue
    claimed.add(messages.length)
    messages.push({
      sourceId: `delivery:${item.id}`,
      role: "user",
      text: item.text,
      tools: [],
      parts: [],
      at: item.at,
      // A `delivered` send is already inside a turn — it renders as an ordinary user bubble. Only a
      // send still waiting to be read wears the gray queued styling.
      queued: item.state !== "delivered",
      deliveryId: item.id,
      deliveryState: item.state,
    })
  }
  return messages
}
