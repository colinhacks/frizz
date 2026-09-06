import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import {
  DISPATCH_TASK_BANNER_MARKER,
  GITHUB_DISPATCH_UI_BOUNDARY,
  ATTACHMENT_IMAGE_EXTENSIONS,
  attachmentExtension,
  isAllInjectedNoise,
  isInjectedNoise,
  isInterruptMarker,
  isParkCorrection,
  isWakeDelivery,
  parseAgentMessage,
  parseAskUserQuestionAnswers,
  parseAskUserQuestionInput,
  parseGithubWakeSteer,
  splitWakeDeliveries,
  stripHumanGapNote,
  stripWakeDeliveryToken,
  stripWakeTimeHeader,
  stripWakeTrailer,
  type GithubWakeSteer,
  type TranscriptMessage,
  type TranscriptPage,
  type TranscriptTodo,
  type TranscriptToolCall,
} from "@frizz/shared"
import type { Project } from "./project.ts"
import type { Storage } from "./storage.ts"
import type { AgentBackend, NormalizedEvent } from "./backend/types.ts"
import { parseDeliveryLedger, projectDeliveryLedger, suppressCancelledDeliveries, attachmentPromptText } from "./delivery-ledger.ts"
import { editedFilesOf } from "./edited-files.ts"
import { repoCarriedEditedFiles } from "./repo-files.ts"
import { stripDeliveryMarkers } from "./delivery-marker.ts"
import { RELAYED_MARKER, relayNotificationBlock } from "./completion-relay.ts"
import { CODEX_FIRST_FINAL_TITLE_TRANSPORT, CODEX_LEGACY_FIRST_FINAL_TITLE_TRANSPORT, parseCodexLine, createCodexBackend, extractCodexFrizzTitle } from "./backend/codex.ts"
import { discoverTranscriptDir, discoverTranscriptId, DISCOVERY_GRACE_MS } from "./discover.ts"
import { isClaudeAuthErrorText, parseSignalFence } from "./tailer.ts"
import { redactCredentialStructure, redactCredentialSyntax } from "./credential-redaction.ts"
import { hasEscapingBackgroundJob } from "../../../cc-worker/hooks/bash-background.mjs"
import { frizzTempDir, isPromptAttachmentPath } from "./frizz-paths.ts"
import { dispatchProfileCell } from "./subagent-profile.ts"

// Parse a session JSONL into a renderable conversation — mechanically, no AI. Same defensive
// posture as the tailer: bad line → skip, unknown type → ignore, never throw. Assistant messages
// arrive one record per content block sharing message.id, so consecutive assistant records with
// the same id merge into one rendered message. User records carrying only tool_result blocks are
// tool plumbing, not something the human typed — skipped.

type Raw = Record<string, any>

export const MAX_MESSAGES = 300

// How far PAST that cap the latest window may reach to keep the human's last message inside it, and the
// all-or-nothing rule that governs the reach — see latestWindowStart. One earlier page's worth, which is
// exactly what the reader would have got for one click of "Load earlier messages".
export const LATEST_WINDOW_ASK_REACH_ITEMS = 100
export const LATEST_WINDOW_ASK_REACH_BYTES = 512 * 1024

// The runtime's own interrupt receipt — see isInterruptMarker (moved to @frizz/shared when the tailer
// needed it too). Dropped from the chat here; read as "the turn is over" by the fold there.

// ---- context compaction ------------------------------------------------------------------------
// BOTH providers rewrite a long conversation into a summary and drop everything above it, and until
// this landed neither said so in the chat: claude's carry-over summary rendered as a 20 000-character
// user bubble the human never typed, and codex's compaction rendered as nothing at all. It is the one
// event that explains why an agent suddenly re-reads its scratchpad or forgets what was just agreed,
// so it earns the boundary divider — the same affordance an external wake uses (see EventLine).
// One label, both providers: the token bracket is what makes the loss concrete.
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
// The pre→post bracket is shown only when it is REAL evidence of shrinkage. Codex derives it from the
// token_count readings either side of the event and one rollout in 2282 reported the same number twice
// (a stale pre-reading); an unshrunk "13k → 13k" is noise, so it degrades to the bare label instead.
function compactionLabel(preTokens?: number, postTokens?: number): string {
  const shrank = preTokens !== undefined && postTokens !== undefined && postTokens < preTokens
  return shrank ? `Context compacted — ${formatTokens(preTokens!)} → ${formatTokens(postTokens!)} tokens` : "Context compacted"
}
function compactionMessage(sourceId: string, at: string | undefined, preTokens?: number, postTokens?: number): TranscriptMessage {
  return { sourceId, role: "assistant", kind: "event", boundary: "compaction", text: compactionLabel(preTokens, postTokens), tools: [], parts: [], at }
}

// ---- the agent came to rest --------------------------------------------------------------------
// The one boundary that CLOSES a turn rather than opening one. Every other divider marks something
// arriving (a wake, a child returning, the provider dropping the context); this marks the agent
// STOPPING — its turn ended, nothing is in flight, and whatever it said last is its handoff. Without
// it a reader cannot tell "the agent finished and is waiting on you" from "the agent is still working
// and this is just the newest thing it has said" — the transcript looks identical either way
// (maintainer 2026-08-02).
//
// That ambiguity turned out to be POSITIONAL, and the projection deliberately does not encode which
// position a boundary landed in: every rest is emitted here, and the client drops the ones whose
// surroundings already say it (web/src/lib/restDividers.ts). Filtering server-side would mean a
// trailing rest that disappears and then reappears the moment a human replies — a mid-array insertion
// the live transcript push has no reason to handle — and the queue card would lose the flag it keys its
// own suppression on.
//
// Both providers hand us an authoritative signal for it, which is why this is a server projection and
// not the client sniffing the shape of the messages around it: claude writes `stop_reason:"end_turn"`
// on the record that ends the turn, codex brackets the turn with task_complete/turn_aborted. Those are
// the SAME two signals the tailer's turn model already runs on (backend/claude.ts, backend/codex.ts),
// so the divider and the board's idle state can never disagree.
const REST_LABEL = "Agent rested"
function restMessage(sourceId: string, at: string | undefined): TranscriptMessage {
  return { sourceId, role: "assistant", kind: "event", boundary: "rest", text: REST_LABEL, tools: [], parts: [], at }
}

// Normalize line endings to LF. A human follow-up injected through the agent's TERMINAL round-trips with
// CARRIAGE-RETURN separators (the tty translates newlines to \r), so a multi-line message — notably the
// composed "Answers:\r1. …\r2. …" — arrives CR-separated. The client renders user text in a
// `white-space: pre-wrap` bubble, which honors \n but NOT a lone \r, so those breaks silently collapse
// into a run-on. Normalizing here fixes every downstream consumer at once (render, the answers-card
// detection, AND the client's optimistic-vs-server text match, which compares raw strings).
function normalizeNewlines(s: string): string {
  // Also drop frizz's invisible delivery marker (delivery-marker.ts). Every path that turns a raw record
  // into rendered text funnels through here, so stripping once makes the marker unobservable to the
  // human — in the drawer, in search, in copied text — while the correlator upstream still reads it off
  // the RAW record. A no-op (single `includes`) for the overwhelming majority of text, which is unmarked.
  return stripDeliveryMarkers(s).replace(/\r\n?/g, "\n")
}

// Display-only projection for the FIRST user turn of a generated GitHub dispatch. Deliberately
// require the complete server-generated envelope, including the exact versioned marker, so ordinary
// HTML comments and code examples stay literal. `text` itself is never changed: workers, persistence,
// search, and transcript logic retain the full machine-facing prompt below the boundary.
export function githubDispatchDisplayText(text: string): string | undefined {
  const marker = `\n\n${GITHUB_DISPATCH_UI_BOUNDARY}\n\n`
  const cut = text.indexOf(marker)
  if (cut === -1) return undefined
  const head = text.slice(0, cut)
  const match = head.match(/^THREAD: [a-z0-9][a-z0-9-]*\n\n(Investigate this issue and make recommendations\n\n(?:Issue|PR) #\d+: [^\n]+\nRepository: [^\n]+\nURL: \S+)$/)
  return match?.[1]
}

// The retired first-prompt envelope. Until 2026-07-26 composePrompt put an explanation line and a bare
// `TASK:` marker BELOW the banner, and that marker — not the banner — was the display cut. Recognizing
// the exact retired preamble (rather than just hunting for `\nTASK:\n` below the banner) is what keeps a
// NEW dispatch whose task legitimately contains a "TASK:" line from being truncated at it.
const LEGACY_TASK_MARKER = "\nTASK:\n"
const LEGACY_BANNER_PREAMBLE =
  "Everything ABOVE this line is frizz system orientation. Everything BELOW the `TASK:` marker is the human operator's own prompt, verbatim."

// Display-only projection for the FIRST user turn of a frizz dispatch: strip frizz's own envelope
// (scratchpad orientation + project instructions + the YOUR TASK banner) so the bubble is the human
// operator's prompt and nothing else. Everything below DISPATCH_TASK_BANNER_MARKER is verbatim theirs.
//
// This is the ONLY place the envelope is cut, which is the point: a broker thread's first prompt
// arrives as a `queue-operation` enqueue record, a pre-broker thread's as an ordinary `user` record, and a
// resumed one as a `queued_command` attachment. The old cut lived inline in the plain-`user` arm alone,
// so under the broker the whole composed prompt — orientation, instructions, banner and all — rendered
// in the chat bubble. Returns undefined when `text` carries no envelope (any turn but the first).
export function frizzDispatchDisplayText(text: string): string | undefined {
  const cut = text.indexOf(DISPATCH_TASK_BANNER_MARKER)
  if (cut === -1) {
    // Pre-banner dispatches carried the bare marker with no banner at all.
    const legacy = text.indexOf(LEGACY_TASK_MARKER)
    return legacy === -1 ? undefined : text.slice(legacy + LEGACY_TASK_MARKER.length).trim()
  }
  const below = text.slice(cut + DISPATCH_TASK_BANNER_MARKER.length)
  if (below.startsWith(LEGACY_BANNER_PREAMBLE)) {
    const legacy = below.indexOf(LEGACY_TASK_MARKER)
    if (legacy !== -1) return below.slice(legacy + LEGACY_TASK_MARKER.length).trim()
  }
  return below.trim()
}

// The display projection for ONE user turn — undefined when the stored text is already what to show.
// Three independent reasons a user record can carry machine-facing text, composed in order:
//   • frizz's own dispatch envelope (FIRST turn only — orientation + instructions above the banner);
//   • a generated GitHub dispatch (FIRST turn only — the envelope is what opens the thread). It sits
//     BELOW frizz's banner, so it is peeled from the remainder, not from the raw record;
//   • the scheduler's wake-delivery token, which rides ANY turn a wake lands on. That's the case the
//     old `out.length === 0` gate missed entirely: a wake is by definition a later turn, so its token
//     reached the pre-wrap user bubble and rendered as literal `<!-- frizz-wake:… -->`;
//   • the clock note frizz appends to a human follow-up after a long gap. The router adds it to the
//     worker's copy ONLY — but the chat renders this transcript, not the ledger the router wrote, so the
//     note showed up inside the operator's own bubble underneath their own words.
// `text` is never narrowed — the outbox acks a delivery by finding that token in the worker's own
// record, the queued-bubble map keys on the raw enqueued content, and persistence/search keep the full
// machine-facing prompt.
function userDisplayText(text: string, first: boolean): string | undefined {
  let projected = text
  if (first) {
    projected = frizzDispatchDisplayText(projected) ?? projected
    projected = githubDispatchDisplayText(projected) ?? projected
  }
  projected = stripWakeDeliveryToken(projected)
  // The token comes off FIRST and the clock second, because that is the order they were appended in
  // (scheduler.withClock, then context's delivery token) and each is anchored to end-of-text.
  projected = stripWakeTimeHeader(projected)
  projected = stripHumanGapNote(projected)
  // And frizz's own agent-facing trailer LAST, once the two riders above have uncovered it. The dividers
  // never render it, but a divider only happens for a delivery the browser's parsers RECOGNIZE — and a
  // tab is a build behind whenever frizz restarts under it, so a wake in a shape its bundle predates
  // falls through to the raw-text card and prints "STILL ARMED … drop it with `mcp__frizz__watch_pr`" at
  // the operator. Stripping it HERE — on the side that composed it, and can never be behind itself —
  // makes that impossible for a tab of any age and for wake shapes not written yet.
  projected = stripWakeTrailer(projected)
  return projected === text ? undefined : projected
}

// The full presentation projection for one user turn: its display text, plus whether FRIZZ wrote it.
// Both derive from the same raw record, and every site that pushes a user message needs both — keeping
// them in one helper is what stops a new push site from shipping the display projection while silently
// dropping the wake flag (which would put a scheduler steer back in the human's own bubble).
function userProjection(text: string, first: boolean): { displayText?: string; wake?: true; wakeSteer?: GithubWakeSteer; peerFrom?: string } {
  // An UPWARD agent-to-agent message — a background child calling `SendMessage({to:"main"})` — is not
  // the human's text at all, so it is settled FIRST and returns on its own. Its body, not the
  // `<agent-message>` wrapper, is what a reader wants, and none of the projections below apply: the
  // dispatch/wake strippers target envelopes this text never carries. `peerDispatchId` is deliberately not
  // set here — only the delivery record names the sender, so the attachment arm resolves and adds it.
  const peer = parseAgentMessage(text)
  if (peer) return { displayText: peer.body, peerFrom: peer.from }
  const displayText = userDisplayText(text, first)
  if (!isWakeDelivery(text)) return { ...(displayText ? { displayText } : {}) }
  // Parse the steer HERE, not in the browser. The formatter that composed this text and the parser
  // reading it are the same build on this side, so they cannot disagree; a browser tab is routinely a
  // build behind (see TranscriptMessage.wakeSteer), and when it is, the chat used to lose the divider
  // and dump the raw agent-facing steer into the transcript instead. `displayText ?? text` because the
  // delivery token has to be off before the steer will parse, and that is exactly what the projection
  // above stripped. A steer this build cannot read stays absent and the client falls back to its own
  // parse — never worse than before.
  const steer = parseGithubWakeSteer(displayText ?? text)
  return { ...(displayText ? { displayText } : {}), wake: true as const, ...(steer ? { wakeSteer: steer } : {}) }
}

// Push ONE user record as the message(s) it actually carries.
//
// Normally that is one message and this is `out.push` with a projection. But the runtime merges
// deliveries that land while the worker is mid-turn into a single record (see splitWakeDeliveries), and
// a merged record must not render as one blob: its parts are separate frizz messages that happened to
// arrive together, and each has its own presentation — a recurring prompt collapses to a divider, a
// relay is plumbing the chat drops, a GitHub wake gets its card. Every segment therefore takes the
// SAME route a lone delivery takes, `isInjectedNoise` included, so a coalesced thread reads exactly
// like one where the same messages arrived a second apart.
//
// A sourceId is the chat's per-message handle — the scroll anchor, `data-frizz-msg`, and the React key
// — so two rendered messages must never share one. The lone delivery keeps the record's bare sourceId
// (it is the same one message it always was, and these anchors should not churn); anything beyond it
// takes a `#u<i>` suffix. The `u` namespace matters: when this record ALSO drew completion dividers
// they already claimed `#0`, `#1`, … and the collision is silent on the server — it surfaces only as a
// React duplicate-key warning in the browser, which is where this was actually caught.
function pushUserRecord(out: TranscriptMessage[], sourceId: string, text: string, at: string | undefined, dropCorrection: CorrectionSink, shareId = true): void {
  for (const [i, segment] of splitWakeDeliveries(text).entries()) {
    if (isInjectedNoise(segment)) continue
    if (dropCorrection(segment)) continue
    const projection = userProjection(segment, out.length === 0)
    const id = i === 0 && shareId ? sourceId : `${sourceId}#u${i}`
    out.push({ sourceId: id, role: "user", text: segment, ...projection, tools: [], parts: [], at })
  }
}

// A FENCE CORRECTION IS NOT A MESSAGE (see isParkCorrection): the record carrying it never renders, and
// the one mark it leaves on the chat is that the fence it refused stops drawing.
//
// It is a per-fold closure because ONE delivery reaches the JSONL through up to three carriers — the
// `queue-operation enqueue`, the `queued_command` attachment, and the plain user record — and every one
// of them has to be dropped or the correction simply renders through the carrier that was missed. That
// is also why the MARK is deduped by text: the attachment routinely lands well after the worker has
// already replied (measured p50 20.9s, max 9.6min), so a second walk from there would reach past the
// refused fence and mark the worker's re-fence, which is the good one.
type CorrectionSink = (text: string) => boolean
function createCorrectionSink(out: TranscriptMessage[]): CorrectionSink {
  const marked = new Set<string>()
  return (text: string) => {
    if (!isParkCorrection(text)) return false
    if (!marked.has(text)) {
      marked.add(text)
      markFenceRefused(out)
    }
    return true
  }
}

// The rest a correction answers is the newest assistant PROSE message, because that is the only fence
// the scheduler ever corrects: SOURCE 12 reads `tele.lastFence`, minted at `tele.lastAssistantAt`, and
// only ever speaks while the thread is idle. So the walk steps over dividers and tool-only messages
// (neither carries a fence), takes the first message that has prose, and stops — at a user turn it stops
// without marking anything, because a correction never reaches back past one.
//
// A fence that does not parse as `awaiting` leaves the message untouched rather than falling through to
// an older one. The correction is about THIS rest; if its fence cannot be read, nothing is refused.
function markFenceRefused(out: TranscriptMessage[]): void {
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m.role === "user") return
    if (m.kind || !m.text.trim()) continue
    if (parseSignalFence(m.text)?.kind === "awaiting") m.fenceRefused = true
    return
  }
}

// Append a text block to a message's ordered parts, coalescing into a trailing text part (so several
// text blocks in a row read as one prose run) — otherwise starting a fresh text part after a tools run.
function pushTextPart(m: TranscriptMessage, text: string): void {
  const last = m.parts[m.parts.length - 1]
  if (last && last.kind === "text") last.text = last.text ? `${last.text}\n\n${text}` : text
  else m.parts.push({ kind: "text", text })
}
// Append a tool call, coalescing into a trailing tools part (a contiguous run of calls = one card
// band) — otherwise starting a fresh tools part after a text run, which is what keeps a lead-in colon
// directly above ITS band and not hoisted above earlier prose.
function pushToolPart(m: TranscriptMessage, call: TranscriptToolCall): void {
  const last = m.parts[m.parts.length - 1]
  if (last && last.kind === "tools") last.tools.push(call)
  else m.parts.push({ kind: "tools", tools: [call] })
}

// ── Queued-follow-up delivery shapes ────────────────────────────────────────────────────────────────
// A queued human message is matched to its DELIVERY by raw text (see the queue-operation handling in the
// fold). Three harness paths deliver text that is no longer byte-identical to what was enqueued, so the
// exact-key lookup misses and the gray bubble becomes IMMORTAL — the "stuck enqueued" bug. Each shape
// below reconstructs the enqueued text STRUCTURALLY rather than fuzzy-matching: a plain
// `deliveredText.includes(queuedText)` was measured against all 681 transcripts on this machine and
// produced four false positives (a message that merely MENTIONS "`/reload-plugins`" or "/etc/docker/
// config.json" resolves a genuinely-pending `/reload-plugins` or `/config`), which would silently
// un-gray a message the agent never received.

// SHAPE 1 — the SDK path coalesces the whole queue into ONE user record. Claude Code 2.1.220 with
// `promptSource:"sdk"` emits N content-less `dequeue`s and then a single user record whose content is the
// N queued texts joined by "\n" (verified byte-exact). Neither key matches, so BOTH bubbles stuck AND the
// merged record rendered as a third copy of the same words. Reconstruction is exact and must consume the
// ENTIRE delivered text, walking pending entries in FIFO (Map insertion) order — a partial drain leaves
// the rest pending, which is correct. 2 such deliveries in the corpus, covering 5 queued messages.
//
// The walk may SKIP a pending entry, because not every entry is still in the queue when it drains: an
// UNQUEUED send leaves only a contentless `dequeue` behind (see cancelDelivery — the CLI writes nothing
// content-bearing), so its enqueue bubble is still registered here and sits in the middle of the FIFO
// order. Breaking on it broke the whole reconstruction: the maintainer queued five sends, retracted the
// 3rd and 4th to fix dictation typos, and the delivered record was sends 1+2+5 — the old walk matched
// 1 and 2, hit the retracted 3rd, bailed, and all three delivered bubbles stayed gray while the record
// rendered a fourth copy (2026-08-24, `i-want-to-design-a-framework-2`). Skipping keeps the match exact
// — the ENTIRE text must still be a "\n"-join of a FIFO subsequence — and a skipped entry stays pending,
// where its cancellation tombstone (or the FIFO backstop) accounts for it. Backtracking, not greedy: a
// consumed prefix that strands the remainder must be retried as a skip, or key sets like ["a","a\nb"]
// mis-resolve.
export function coalescedQueuedKeys(deliveredText: string, pendingKeys: Iterable<string>): string[] {
  if (!deliveredText) return []
  const keys = [...pendingKeys]
  const dead = new Set<number>() // (cursor, index) pairs proven unwinnable, so repeats stay linear
  const walk = (cursor: number, index: number): string[] | null => {
    if (index >= keys.length) return null
    const state = cursor * (keys.length + 1) + index
    if (dead.has(state)) return null
    const key = keys[index]
    if (key && deliveredText.startsWith(key, cursor)) {
      const next = cursor + key.length
      if (next === deliveredText.length) return [key]
      if (deliveredText.startsWith("\n", next)) {
        const rest = walk(next + 1, index + 1)
        if (rest) return [key, ...rest]
      }
    }
    const skipped = walk(cursor, index + 1)
    if (skipped) return skipped
    dead.add(state)
    return null
  }
  return walk(0, 0) ?? []
}

// SHAPE 2 — a slash command is enqueued as the human TYPED it ("/effort", "/loop <prompt>") but delivered
// as the expansion envelope `<command-message>…</command-message>\n<command-name>/loop</command-name>\n
// <command-args>…</command-args>`. Rebuilding "name[ args]" from the envelope recovers the typed text
// exactly. 83 such deliveries in the corpus.
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/
export function commandEnvelopeQueuedKey(deliveredText: string): string | undefined {
  const name = COMMAND_NAME_RE.exec(deliveredText)?.[1]?.trim()
  if (!name) return undefined
  const args = COMMAND_ARGS_RE.exec(deliveredText)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

// SHAPE 3 — a message from a PEER Claude session. Claude Code delivers it as an isMeta user record that
// wraps the enqueued text in a fixed preamble plus trailing handling guidance, so the isMeta splice below
// (which drops harness plumbing the human never typed) missed it and left the bubble gray. Anchoring on
// the exact preamble AT THE START keeps this precise: 51 deliveries matched in the corpus, zero false
// positives — where bare containment matched prose that merely quoted a queued slash command.
const PEER_SESSION_PREAMBLE = "Another Claude session sent a message:\n"
export function peerSessionQueuedKey(deliveredText: string, pendingKeys: Iterable<string>): string | undefined {
  if (!deliveredText.startsWith(PEER_SESSION_PREAMBLE)) return undefined
  for (const key of pendingKeys) if (deliveredText.startsWith(key, PEER_SESSION_PREAMBLE.length)) return key
  return undefined
}

// ---- Instructions delivered INTO a Claude sub-agent ------------------------------------------------
// Claude writes parent/peer instructions as isMeta user records in the CHILD's own JSONL. The generic
// isMeta arm correctly drops harness plumbing from a normal thread, but it also erased these messages
// from the sub-agent drawer — despite the provider preserving their plaintext there. Two stable wrappers
// exist in the local corpus:
//
//   • coordinator → child: 197 records, a fixed preamble/suffix around the exact message;
//   • peer session → child: 6 records, an <agent-message> nested inside a security-guidance wrapper.
//
// Parse only the exact, anchored provider shapes and only when the record itself says isSidechain. An
// ordinary user quoting either phrase remains ordinary text, and main-session isMeta plumbing stays
// invisible. Returning the authored BODY (not the provider framing) also lets the drawer-steer journal
// dedupe a future provider record against the exact text Frizz sent.
const CLAUDE_COORDINATOR_INSTRUCTION_PREFIX = "The coordinator sent a message while you were working:\n"
const CLAUDE_COORDINATOR_INSTRUCTION_SUFFIX = "\n\nAddress this before completing your current task."
const CLAUDE_PEER_INSTRUCTION_PREFIX = "Another Claude session sent a message while you were working:\n"

function claudeSidechainInstruction(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.startsWith(CLAUDE_COORDINATOR_INSTRUCTION_PREFIX) && trimmed.endsWith(CLAUDE_COORDINATOR_INSTRUCTION_SUFFIX)) {
    const body = trimmed.slice(
      CLAUDE_COORDINATOR_INSTRUCTION_PREFIX.length,
      -CLAUDE_COORDINATOR_INSTRUCTION_SUFFIX.length,
    ).trim()
    return body || undefined
  }
  if (!trimmed.startsWith(CLAUDE_PEER_INSTRUCTION_PREFIX)) return undefined
  const wrapperStart = trimmed.indexOf("<agent-message ", CLAUDE_PEER_INSTRUCTION_PREFIX.length)
  const wrapperEnd = trimmed.lastIndexOf("</agent-message>")
  if (wrapperStart < 0 || wrapperEnd < 0) return undefined
  return parseAgentMessage(trimmed.slice(wrapperStart, wrapperEnd + "</agent-message>".length))?.body.trim() || undefined
}

// ── The clock backstop ──────────────────────────────────────────────────────────────────────────────
// The three shapes above are the ones that EXIST. The fold recognizes a delivery by its record shape, so
// a shape a future harness version invents is unrecognized by construction — and the FIFO backstop only
// heals a stranded bubble once a LATER delivery is recognized, which never comes for the NEWEST message.
// That is the case a human actually sees, and it is how this bug was reported: the parser already carried
// a fix for Claude Code 2.1.207's SDK shape, and 2.1.220 changed it again.
//
// So the render layer applies the shape-independent rule the fold cannot: a queued bubble this old is
// stale no matter what its delivery looked like. Measured over the 3223 deliveries in this machine's
// corpus, a legitimately-queued message waits p50 0.1s, p99 2.5min, p99.9 5.2min, MAX 54min (one; none
// above an hour) — a mid-turn queue lasts as long as its turn, so the ceiling is generous rather than
// tight. At 2h nothing measured is touched, and an unrecognized shape degrades to "renders as an ordinary
// message" instead of "gray forever". Never a splice: a sent message must not vanish, and the text here
// is the human's own. This is the transcript twin of ageDeliveries' UNCONFIRMED_DROP_MS, which fixed the
// identical immortality for the ledger's own bubbles.
export const QUEUED_STALE_MS = 2 * 60 * 60_000
export function retireStaleQueuedBubbles(messages: TranscriptMessage[], nowMs: number = Date.now()): TranscriptMessage[] {
  // Fast path: almost every read has nothing queued, and must not pay a copy.
  let stale = false
  for (const m of messages) {
    if (!m.queued) continue
    const at = m.at === undefined ? NaN : Date.parse(m.at)
    if (Number.isFinite(at) && nowMs - at > QUEUED_STALE_MS) {
      stale = true
      break
    }
  }
  if (!stale) return messages
  // COPY-ON-WRITE. These objects are owned by the retained fold and are mutated in place when a real
  // delivery lands; rewriting one here would make the retirement permanent and defeat that.
  return messages.map((m) => {
    if (!m.queued) return m
    const at = m.at === undefined ? NaN : Date.parse(m.at)
    // An unparseable timestamp is not evidence of staleness — leave those queued.
    return Number.isFinite(at) && nowMs - at > QUEUED_STALE_MS ? { ...m, queued: false } : m
  })
}

// ── Retained incremental Claude parse ───────────────────────────────────────────────────────────────
// The single-pass fold that turns a Claude JSONL into renderable messages, made RESUMABLE: every piece
// of closure state (the `out` array + the pending-tool / queued-follow-up / agent-dispatch / background-
// shell maps + the thinking/merge anchors) lives for the life of the fold, and lines are fed through
// `ingest` incrementally. A one-shot parse is `ingest(whole) + finalize()`; the retained-parse cache
// (readTranscript) keeps a fold alive per file and feeds it ONLY the bytes appended since the last read,
// so an append that mutates a message far behind the tail (a queued_command un-graying, a tool_result
// back-fill, a sub-agent completion) "just works" — the maps still hold the same object references.
// `processLine` is byte-for-byte the legacy per-line body (`continue` → `return`). sourceId stays
// `${identityPrefix}:${lineOffset}` where lineOffset counts bytes INCLUDING newlines, cumulative from
// byte 0 — identical to a one-shot `raw.split("\n")` fold, preserved exactly across chunk boundaries.
export interface TranscriptFold {
  ingest(chunk: string): void
  finalize(): void
  // Capped to the latest render window (latestWindowStart — what parseTranscript/readTranscript return).
  messages(): TranscriptMessage[]
  // The full retained projection, uncapped (what projectClaudeTranscript returns).
  allMessages(): TranscriptMessage[]
  // Total bytes the fold has ingested (offset of the committed frontier + any buffered trailing partial).
  // Monotonically non-decreasing across ingests; used by the cache's correctness net, not for framing.
  consumedBytes(): number
}

export function createTranscriptFold(identityPrefix = "claude"): TranscriptFold {
  const out: TranscriptMessage[] = []
  const dropCorrection = createCorrectionSink(out)
  let lastAssistantId: string | null = null
  // Tool calls awaiting their tool_result, keyed by tool_use id. Claude records every result as a
  // later synthetic `user` record, so the call card starts pending and is back-filled in place with
  // terminal state, elapsed time, and a bounded/redacted result excerpt. MultiEdit fans one tool_use
  // out into several cards; all share the one result lifecycle.
  const pendingTools = new Map<string, { calls: TranscriptToolCall[]; name: string; at?: string }>()
  // Live Agent dispatches keyed by tool_use id → the dispatch's timestamp + the emitted call object.
  // When a matching completion <task-notification> streams by we (a) back-fill the call's terminal
  // state and (b) emit an inline "event" punctuation message at that position. Delete-on-emit dedupes
  // a task-id that re-notifies. (This mirrors the tailer's completion correlation; kept separate here
  // so the transcript's mechanical parse stays decoupled from the tailer's liveness telemetry.)
  const agentDispatches = new Map<string, { at?: string; call: TranscriptToolCall }>()
  // Background Bash launch ids are provider-native lifecycle keys. Their immediate tool_result is
  // only a launch acknowledgement; task-notification is the terminal observation.
  const backgroundShells = new Map<string, { at?: string; call: TranscriptToolCall }>()
  // SHELLS ALREADY DRAWN, and the rest-epoch each was drawn in. A completion is routinely delivered
  // twice — once mid-turn as the runtime folds it in, and again afterwards as the thing that re-invokes
  // the agent — and de-duping the second one is right only while the agent never stopped in between. See
  // `completionEvents` for the wake this recovers.
  const consumedShells = new Map<string, { epoch: number; call: TranscriptToolCall }>()
  // RUNTIME task id → tool_use id, captured from background launch acks (mirrors the tailer's
  // launchTaskId). Needed because two terminal signals carry NO <tool-use-id>: the Monitor-timeout
  // notification (task-id only) and a manual TaskStop result (task_id only).
  const backgroundTaskIds = new Map<string, string>()
  // Relay task-ids whose uncorrelated divider has already been drawn. The correlated paths dedupe by
  // DELETING the map entry they matched ("the same completion arriving via two carriers is a no-op"), and
  // the uncorrelated one has no entry to delete — so it needs its own memory or it draws twice. It does:
  // frizz writes each repair as BOTH a queue-operation and a user record, which is exactly two carriers.
  const relayedWakesDrawn = new Set<string>()
  // A CHILD's own agentId → the tool_use id of the Agent dispatch that spawned it, captured from the
  // launch ack (see attachToolResults). An upward report names its sender by agentId but every drawer
  // lookup is keyed by the dispatch id, so this is the translation the peer arm needs. Forward-only, and
  // that is sound: a child must exist before it can report, so its ack always precedes its message.
  const childDispatchIds = new Map<string, string>()
  // Dispatch tool_use id → that dispatch's DESCRIPTION, and unlike `agentDispatches` it is never
  // consumed. It exists because the completion arm DELETES from `agentDispatches` to dedupe a task-id
  // that re-notifies (see dispatches.delete in completionEvents), which silently took the child's title
  // with it: a child that FINISHES before its upward report is materialized into the parent's context
  // had its report relabelled against an entry that was already gone, so the divider fell back to
  // `origin.from` and read «frizz:opus-high» — the profile, identical across every child sharing that
  // cell. Measured on the maintainer's own thread, 2 of 11 reports landed after their child's
  // notification and lost their titles exactly this way. The two lifetimes are genuinely different —
  // completion correlation is one-shot, a title is wanted for as long as the transcript renders — so
  // they are two maps rather than one with a subtler consume rule.
  const dispatchLabels = new Map<string, string>()
  // Human follow-ups QUEUED to a mid-turn worker (Claude Code's message queue). A human message sent
  // while the agent is working NEVER lands as a normal user record — the session JSONL records the
  // lifecycle only as sidecar: an `enqueue` queue-operation, a `remove`/`dequeue`, and finally a
  // `queued_command` attachment that materializes the text into the agent's context. Without the two
  // handlers below the message is SWALLOWED entirely. `queuedPending` holds a still-undelivered
  // message's TEXT alongside its emitted (grayed) bubble, so the delivering attachment (which carries
  // the prompt verbatim) resolves its enqueue regardless of the timestamp drift between the two records.
  //
  // An ORDERED LIST, not a Map keyed by text: two queued messages may carry the SAME words, and under a
  // Map the second `set` silently overwrote the first, orphaning the first bubble in `out` where nothing
  // could ever resolve it. Measured in this machine's corpus (pullfrog-app 11610c49): four identical
  // "asdf" sends queued at once, delivered as the single coalesced record "asdf\nasdf\nasdf\nasdf" —
  // one map key, so coalescedQueuedKeys could not reconstruct the delivery, all four bubbles stayed gray
  // AND the joined record rendered as a fifth copy. That is the maintainer's "they show up as dequeued
  // but the enqueued versions stick around as well", exactly. A list keeps one entry per SEND, so the
  // FIFO reconstruction below walks repeats one at a time.
  interface QueuedEntry { key: string; message: TranscriptMessage }
  const queuedPending: QueuedEntry[] = []
  // A just-delivered queued message's text — so an immediately-following NORMAL user record carrying the
  // identical text (a belt-and-suspenders guard; unobserved in the evidence) doesn't double-render.
  let deliveredDedupe: string | null = null
  // The rest divider (see restMessage) for a turn that has ended, held back until we know the resting
  // message is really finished. It is DEFERRED rather than pushed on the spot because one assistant
  // MESSAGE can be split across several records and `stop_reason:"end_turn"` rides EVERY one of them —
  // 9 such message ids across 12 of this machine's transcripts. Pushing per record would both repeat the
  // divider and break the split-record merge: a divider sitting at out's tail is `kind:"event"`, which
  // fails the merge check below, so the message's remaining blocks would land in a SECOND bubble
  // underneath it. Holding it until a record arrives that is not a continuation of `msgId` keeps one
  // divider, in the right place, under one bubble.
  let pendingRest: { sourceId: string; at?: string; msgId: string | null } | null = null
  // How many times the agent has come to REST so far. It is what tells a re-notify that merely repeats a
  // completion already drawn from the one that RE-INVOKED the agent across a rest — see `consumedShells`.
  const restEpoch = { n: 0 }
  function flushRest(): void {
    if (!pendingRest) return
    out.push(restMessage(pendingRest.sourceId, pendingRest.at))
    restEpoch.n++
    pendingRest = null
    lastAssistantId = null // the divider breaks the assistant-record merge chain, like every other event
  }

  // The still-gray keys, in FIFO order. `queuedPending` also retains entries the backstop below has
  // already un-grayed (so their own delivery can still resolve the SAME object rather than render a
  // second copy), and those must not take part in matching.
  // Duplicates INCLUDED: a run of N identical queued messages contributes N keys, which is what lets
  // coalescedQueuedKeys rebuild a delivery record that repeats the same words.
  function unresolvedQueuedKeys(): string[] {
    const keys: string[] = []
    for (const entry of queuedPending) if (entry.message.queued) keys.push(entry.key)
    return keys
  }
  // The entry a delivery for `key` refers to: the OLDEST still-gray one (FIFO — Claude Code's queue
  // drains in order), falling back to the oldest registered one because the remove/attachment pair
  // deliberately leaves an entry registered after un-graying it, so the attachment can re-resolve the
  // SAME object instead of pushing a second copy. For a unique key this is exactly the old Map.get.
  function findQueued(key: string): QueuedEntry | undefined {
    return queuedPending.find((e) => e.key === key && e.message.queued) ?? queuedPending.find((e) => e.key === key)
  }
  function dropQueued(entry: QueuedEntry): void {
    const i = queuedPending.indexOf(entry)
    if (i !== -1) queuedPending.splice(i, 1)
  }
  // FIFO backstop. Claude Code's queue drains in order, so a delivery that positively resolves entry K
  // PROVES every entry enqueued before K already left the queue — whatever shape its own delivery record
  // took. Without this, ONE unrecognized delivery shape strands its bubble gray forever (the failure this
  // whole block exists to prevent), and every future harness format drift re-creates it. The older bubbles
  // are UN-GRAYED, never spliced: they are the human's words, and a sent message must never disappear
  // from the transcript once queued. They also stay REGISTERED — de-registering them made their real
  // delivery record fall through and push a duplicate bubble (caught A/B-ing the corpus: 21 spurious
  // messages across the uncapped transcripts).
  function resolveQueuedThrough(entry: QueuedEntry): void {
    for (const e of queuedPending) {
      if (e === entry) break
      e.message.queued = false
    }
  }
  // Resolve a pending bubble IN PLACE — same object, same position, just un-gray it — plus everything
  // queued ahead of it. Returns whether the bubble is ALREADY IN `out` (true even when the backstop
  // un-grayed it early), which is what tells a caller not to render a second copy; false means this
  // delivery has no bubble yet and the caller should emit one.
  function resolveQueued(key: string): boolean {
    const entry = findQueued(key)
    if (!entry) return false
    if (entry.message.queued) resolveQueuedThrough(entry)
    dropQueued(entry)
    entry.message.queued = false
    return true
  }

  // Incremental line framing. `offset` is the byte position of `buffer[0]` in the overall stream (or,
  // when buffer is empty, of the next unprocessed byte). `buffer` holds a trailing line whose newline
  // has NOT yet arrived and which was not optimistically consumed; it is prepended to the next chunk.
  // Byte counts include the '\n' terminator so a line's offset matches a one-shot fold exactly.
  let offset = 0
  let buffer = ""

  function processLine(line: string, lineOffset: number): void {
    if (!line.trim()) return
    const sourceId = `${identityPrefix}:${lineOffset}`
    let rec: Raw
    try {
      rec = JSON.parse(line)
    } catch {
      return
    }

    // A held-back rest divider lands HERE — ahead of whatever record follows the turn that ended, so it
    // sits between the two turns. The one record that must not flush it is another chunk of the SAME
    // assistant message (see pendingRest): that is still the resting turn's own body.
    if (pendingRest && !(rec.type === "assistant" && typeof rec.message?.id === "string" && rec.message.id === pendingRest.msgId)) {
      flushRest()
    }

    // Sub-agent / background-shell completion notifications (any of the three carriers — see
    // notificationCarrierText) re-render each finished dispatch's AgentBlock card inline at this
    // position (clickable into the run-log drawer), back-fill the original launch cards' terminal
    // state, and emit a boundary line per woken shell.
    const evs = completionEvents(rec, agentDispatches, backgroundShells, backgroundTaskIds, relayedWakesDrawn, consumedShells, restEpoch)
    // Did this record already spend its bare sourceId on a divider? Only a coalesced record reaches the
    // user branch below after drawing one, and then the delivery must not reuse it (see pushUserRecord).
    let drewEvents = false
    if (evs.length > 0) {
      // A user-record carrier can in principle also carry tool_result blocks — never skip their back-fill.
      attachToolResults(rec, pendingTools, backgroundShells, backgroundTaskIds, childDispatchIds)
      evs.forEach((ev, i) => {
        ev.sourceId = i === 0 ? sourceId : `${sourceId}#${i}` // keep sourceIds unique per rendered message
        out.push(ev)
      })
      lastAssistantId = null // the completion card breaks the assistant-record merge chain
      // A coalesced record can be BOTH at once: relay plumbing that draws these dividers AND a real
      // delivery merged in beside it. Bail out only when the plumbing is all there was — otherwise fall
      // through so the delivery underneath still reaches the chat, below its own dividers.
      if (isAllInjectedNoise(notificationCarrierText(rec) ?? "")) return
      drewEvents = true
    }

    // A long THINKING window used to be surfaced here as a `Thought for Ns` event line. It is not any
    // more: Claude's thinking CONTENT is redacted in the JSONL (a `signature` + an empty `thinking`
    // field), so the line could only ever report a DURATION — a permanent row in the transcript whose
    // entire content was "the model paused here". The live shimmer already says `Thinking…` while it
    // happens, which is when that fact is worth anything (maintainer 2026-08-01: "If the agent is in
    // fact thinking, then we could show thinking in the shimmer, but it should never show up
    // persistently like that").
    const thisTs = typeof rec.timestamp === "string" ? rec.timestamp : undefined

    // CONTEXT COMPACTION — everything above this line left the agent's context. Claude writes the
    // boundary as its own system record and hands us the exact token bracket; the ~20 000-character
    // carry-over summary that follows is dropped in the user arm below.
    if (rec.type === "system" && rec.subtype === "compact_boundary") {
      const meta = rec.compactMetadata
      const pre = typeof meta?.preTokens === "number" ? meta.preTokens : undefined
      const post = typeof meta?.postTokens === "number" ? meta.postTokens : undefined
      out.push(compactionMessage(sourceId, thisTs, pre, post))
      lastAssistantId = null // the divider breaks the assistant-record merge chain
      return
    }

    // A QUEUED human follow-up's enqueue/removal (the completion <task-notification> queue-operations were
    // already consumed above). `enqueue` emits a pending grayed bubble; a CONTENT-BEARING removal
    // supersedes it (see below); the delivery itself is the `queued_command` attachment handled next.
    if (rec.type === "queue-operation") {
      const op = typeof rec.operation === "string" ? rec.operation : ""
      const content = typeof rec.content === "string" ? normalizeNewlines(rec.content) : ""
      if (op === "enqueue" && content.trim() && !isInjectedNoise(content) && !dropCorrection(content)) {
        // Undelivered → a grayed "queued" user bubble (queued:true reuses the client's optimistic-send
        // styling). Do NOT reset lastAssistantId: this bubble is transient (it may be spliced out on
        // delivery), and the assistant-merge tail-role check already blocks merging across a live bubble.
        // `text` stays the RAW queued content — it is the key `queuedPending` matches the delivery
        // attachment against — so a wake token riding a queued follow-up is dropped only for display.
        const queuedProjection = userProjection(content, out.length === 0)
        const m: TranscriptMessage = { sourceId, role: "user", text: content, ...queuedProjection, tools: [], parts: [], at: thisTs, queued: true }
        out.push(m)
        queuedPending.push({ key: content, message: m })
      } else if ((op === "remove" || op === "dequeue" || op === "popAll") && content.trim()) {
        // A content-bearing removal is Claude Code DEQUEUEING the message into the turn. Resolve the
        // bubble IN PLACE — un-gray it where the human sent it — and leave it registered so the
        // `queued_command` attachment that follows re-resolves the SAME object instead of pushing a
        // second copy.
        //
        // This used to SPLICE the bubble out and rely on that attachment to re-render it, which made the
        // message VANISH from the chat — briefly for everyone (the attachment lands 1 to 19 records
        // later, p50 2, measured over 263 dequeues), and PERMANENTLY for any queued message carrying an
        // image, because that attachment's `prompt` is an array of content blocks and the delivery
        // branch below only accepted a string, so the re-render never happened at all. A sent message
        // must never disappear from the transcript once it has been queued.
        //
        // The splice existed for CANCELLATION (the human ESC-ing a queued message). Across all 533
        // transcripts on this machine there are 517 content-bearing removals and every one is followed
        // by its delivery — the three that first looked like cancellations were image-bearing messages
        // whose attachment this parser was silently dropping. So the case it protected against does not
        // appear in practice, while the vanish it caused does. An EMPTY-content removal remains ignored:
        // it is the ordinary handshake and matching it by anything but exact text could evict a
        // genuinely-still-pending bubble when an unrelated queue item is dequeued.
        const entry = findQueued(content)
        // Deliberately NOT resolveQueued(): the entry stays registered so the attachment that follows
        // re-resolves this same object. The FIFO backstop still applies — this removal proves the queue
        // drained past everything ahead of it.
        if (entry) {
          resolveQueuedThrough(entry)
          entry.message.queued = false
        }
      }
      return
    }

    // The DELIVERY of a queued human follow-up: Claude Code materializes the queued text into the agent's
    // context as a `queued_command` attachment. This is the ONLY record carrying the delivered text in a
    // renderable place, so it renders as the human's user message at its position in the flow. Only
    // origin.kind "human" + commandMode "prompt" is a plain typed message; other commandModes (notably
    // "task-notification" — a sub-agent completion materialized the same way) are harness plumbing → skip.
    //
    // …and `origin` is a TUI-ONLY field — only an interactive `claude` process writes it, which is how
    // every pre-broker thread ran. The SDK/broker path writes none, so requiring it made this
    // whole branch STRUCTURALLY DEAD on every broker thread: the delivery record was ignored and the gray
    // bubble waited for the much later `queue-operation remove` to clear it. Measured over this machine's
    // corpus, that wait is p50 20.9s, p90 130s, max 9.6min AFTER the agent already had the message — long
    // enough that the agent's REPLY routinely renders above a message still styled as "pending", which is
    // the "unnecessarily long delay before it renders as a real message" report. The counts: 1664 tui
    // prompt attachments carry origin.kind "human" and ALL 78 sdk ones carry none, while every sdk one
    // carries `source_uuid` (the id frizz itself passed to sendInput) and no task-notification attachment
    // ever does. So an origin-less prompt attachment bearing a source_uuid is the human delivery it says
    // it is. origin.kind "peer" (17 in the corpus) stays excluded from THIS human branch — it is a child's
    // upward SendMessage, not the operator's words — and is handled by its own branch just below.
    if (rec.type === "attachment" && rec.attachment?.type === "queued_command") {
      const att = rec.attachment
      const humanDelivery = att.origin?.kind === "human" || (att.origin === undefined && typeof att.source_uuid === "string")
      // `prompt` is a plain string for a typed message but an ARRAY of content blocks when the human
      // attached an image to a queued follow-up (10 such in this machine's corpus, every one
      // text+image). Reading only the string shape dropped those on the floor entirely — combined with
      // the removal above, an image-bearing queued message disappeared from the chat for good.
      const prompt = normalizeNewlines(attachmentPromptText(att.prompt))
      if (prompt.trim() && humanDelivery && att.commandMode === "prompt" && !isInjectedNoise(prompt) && !dropCorrection(prompt)) {
        // Resolve the pending bubble IN PLACE — same object, same position, just un-gray it. Never emit
        // a second copy (the enqueue already placed it where the human hit send).
        if (!resolveQueued(prompt)) {
          // Attachment-only: an older session with no queue-operations, or an enqueue that scrolled out of
          // the render window. Emit the delivered message fresh at the attachment's position.
          const deliveredProjection = userProjection(prompt, out.length === 0)
          out.push({ sourceId, role: "user", text: prompt, ...deliveredProjection, tools: [], parts: [], at: thisTs })
        }
        deliveredDedupe = prompt
        lastAssistantId = null // …and breaks the assistant-record merge chain, like any user message
      }
      // A PEER delivery — an UPWARD `SendMessage({to:"main"})` from a background sub-agent. It is not a
      // human delivery (so it must never take the branch above, and the `humanDelivery` gate keeps it
      // out), but it is the ONLY record that names the SENDER: `origin.senderTaskId` is the child's own
      // agentId, and it is the sole unambiguous identity when several children share one profile label
      // (the worker dispatch hook strips `name`, so `origin.from` is just the subagent_type). The
      // enqueue arm has already placed and un-grayed the bubble, so the work here is to STAMP that id
      // onto it — plus the same attachment-only fallback the human path keeps, because a child's report
      // must not vanish when its enqueue scrolled out of the window.
      const peerOrigin = att.origin?.kind === "peer" ? att.origin : undefined
      if (peerOrigin && att.commandMode === "prompt") {
        const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
        const senderTaskId = str(peerOrigin.senderTaskId)
        // TRANSLATE the sender's agentId into its DISPATCH tool_use id — the only id a drawer can resolve
        // (see peerDispatchId in shared). Absent when the ack was never seen, in which case the report line
        // stays plain text rather than becoming a link to an "unavailable" drawer.
        const dispatchId = senderTaskId ? childDispatchIds.get(senderTaskId) : undefined
        // Take the entry BEFORE resolving: resolveQueued de-registers it, and we still need the message
        // object it points at in order to stamp the id onto the bubble already rendered in `out`.
        const entry = prompt.trim() ? findQueued(prompt) : undefined
        if (entry) {
          resolveQueued(prompt)
          // Guard on peerFrom: only a bubble the enqueue actually recognized as a child's report gets the
          // child's id. Stamping it on an unattributed bubble would assert an origin nothing established.
          if (dispatchId && entry.message.peerFrom) entry.message.peerDispatchId = dispatchId
          // RELABEL to the child's DESCRIPTION. `origin.from` is only ever the subagent_type, because
          // frizz's own worker dispatch hook strips `name` — so an upward report rendered as
          // «frizz:opus-xhigh», which names the profile rather than the work and is identical across
          // every child sharing that cell. `senderTaskId` is the child's agentId, and childDispatchIds
          // already translates that into the DISPATCH tool_use id — the same translation `dispatchId`
          // above performs.
          //
          // Read from `dispatchLabels`, NOT from `agentDispatches`: the completion arm consumes the
          // latter, so a child that FINISHED before its report was materialized into the parent's context
          // relabelled against an entry that was already gone and fell back to the profile. That is the
          // common case, not the edge — a mid-flight report and the child's own completion are often
          // queued together, and the completion notification wins the race into the transcript.
          //
          // Falls back to the profile when the dispatch was never folded at all (an older or truncated
          // session), which is strictly what it rendered before.
          const described = dispatchId ? dispatchLabels.get(dispatchId) : undefined
          if (entry.message.peerFrom) {
            // Resolved → the description IS the name. Unresolved → say so, rather than leaving the
            // profile cell standing in as one; see TranscriptMessage.peerUnnamed. The sender's own agent
            // id rides along either way, so a later pass can resolve what this bounded fold could not.
            if (described) entry.message.peerFrom = described
            else entry.message.peerUnnamed = true
            if (senderTaskId) entry.message.peerSenderTaskId = senderTaskId
          }
          lastAssistantId = null // …so it breaks the assistant-record merge chain too
        } else {
          // ATTACHMENT-ONLY: the enqueue scrolled out of the render window, or an older session never
          // wrote one. Prefer this record's STRUCTURED fields — it carries `from` and `body` already
          // separated — and fall back to parsing the wrapper out of `prompt` when they are absent.
          const parsed = prompt.trim() ? parseAgentMessage(prompt) : undefined
          // Same relabel as the resolved-bubble arm above, and it has to be repeated here rather than
          // hoisted: this branch BUILDS the message instead of stamping an existing one, so there is no
          // shared assignment to patch. The dispatch's description wins over `origin.from`, which is only
          // ever the subagent_type once frizz's worker dispatch hook has stripped `name`.
          const describedHere = dispatchId ? dispatchLabels.get(dispatchId) : undefined
          const from = describedHere || str(peerOrigin.from) || str(peerOrigin.name) || parsed?.from || ""
          const body = parsed?.body ?? (typeof peerOrigin.body === "string" ? peerOrigin.body : "")
          // Unattributable or bodiless → render NOTHING. That is the long-standing behavior for a peer
          // record this build cannot resolve, and it is the SAFER failure: a child's words wearing the
          // operator's own bubble is a worse bug than a missing line, because it invents a human turn.
          if (from && body.trim()) {
            out.push({
              sourceId,
              role: "user",
              text: prompt || body, // raw when we have it — it is the key a later removal matches on
              displayText: body,
              peerFrom: from,
              // Unresolved ⇒ `from` is the profile cell (or a raw wrapper attribute), which is not a
              // name — see the resolved arm above and TranscriptMessage.peerUnnamed.
              ...(describedHere ? {} : { peerUnnamed: true as const }),
              ...(senderTaskId ? { peerSenderTaskId: senderTaskId } : {}),
              ...(dispatchId ? { peerDispatchId: dispatchId } : {}),
              tools: [],
              parts: [],
              at: thisTs,
            })
            lastAssistantId = null
          }
        }
      }
      return
    }

    if (rec.type === "user") {
      // Back-fill any Read excerpts this record carries FIRST — a tool_result record is dropped as a
      // human bubble (isMeta / tool_result-only), but it still holds the file content we want to show.
      attachToolResults(rec, pendingTools, backgroundShells, backgroundTaskIds, childDispatchIds)
      // isMeta marks harness-injected user records (hook feedback, reminders, autonomous /loop
      // wakeups) — plumbing the human never typed, so it must not render as their bubble. But an
      // autonomous /loop wakeup is ENQUEUED like any follow-up (emitting a gray queued bubble),
      // then delivered as THIS isMeta record — unlike a human follow-up, which delivers non-isMeta.
      // The enqueue can't know the eventual delivery is harness plumbing, so its bubble would linger
      // as a stuck "queued" message forever. Splice out any pending bubble this record resolves
      // BEFORE returning; the enqueue's own text key matches (verified byte-identical in practice).
      // The carry-over summary claude writes after compacting ("This session is being continued from a
      // previous conversation…") is addressed to the AGENT, not to the reader: ~20 000 characters of
      // machine-facing recap that rendered as a giant bubble attributed to the human. The compact_boundary
      // divider above already says what happened, at the right position.
      if (rec.isCompactSummary === true) return
      if (rec.isMeta === true) {
        const metaText = userText(rec)
        if (metaText) {
          // A message from a PEER Claude session is enqueued raw but delivered WRAPPED in a fixed
          // preamble + trailing guidance (SHAPE 3), so the byte-identical key misses. Recover it before
          // the splice, or the bubble sits gray forever — this is the shape that stranded a live thread's
          // <agent-message> follow-up.
          const key = findQueued(metaText) ? metaText : peerSessionQueuedKey(metaText, unresolvedQueuedKeys())
          const pending = key === undefined ? undefined : findQueued(key)
          if (pending) {
            resolveQueuedThrough(pending)
            dropQueued(pending)
            const i = out.indexOf(pending.message)
            if (i !== -1) out.splice(i, 1)
          }
          const instruction = rec.isSidechain === true ? claudeSidechainInstruction(metaText) : undefined
          if (instruction) {
            out.push({
              sourceId,
              role: "user",
              text: instruction,
              agentInstruction: true,
              tools: [],
              parts: [{ kind: "text", text: instruction }],
              at: rec.timestamp,
            })
            lastAssistantId = null
          }
        }
        return
      }
      let text = userText(rec)
      // Harness/orchestrator injections that arrive as ordinary user records (task-notifications,
      // system reminders, frizz pulses) are ALSO not the human's words — drop them from the chat.
      if (text && isAllInjectedNoise(text)) return
      // …and so is the runtime's own interrupt receipt (see isInterruptMarker). Dropped BEFORE the
      // queued-bubble matching below: it resolves nothing, and every shape there keys on the human's
      // words, which this record does not carry.
      if (text && isInterruptMarker(text)) return
      if (text) {
        // Claude Code 2.1.207's print/SDK path emits enqueue → empty dequeue → the ordinary user
        // record (no queued_command attachment). Resolve an identical pending bubble in place; adding
        // another here duplicated the first prompt in a real disposable session.
        const queued = findQueued(text)?.message
        if (queued) {
          const wasQueued = queued.queued
          resolveQueued(text)
          if (wasQueued) queued.at = rec.timestamp
          lastAssistantId = null
          return
        }
        // …and 2.1.220's SDK path coalesces SEVERAL queued messages into that one record (SHAPE 1).
        // Resolve every message it carries in place. Falling through instead re-rendered the whole run
        // as one extra bubble BELOW the originals, which stayed gray — the same words three times.
        const coalesced = coalescedQueuedKeys(text, unresolvedQueuedKeys())
        if (coalesced.length > 0) {
          for (const key of coalesced) resolveQueued(key)
          lastAssistantId = null
          return
        }
        // A slash command typed into the queue arrives as its expansion envelope (SHAPE 2). Resolve the
        // bubble carrying what the human actually typed, and drop the envelope — rendering it would show
        // raw `<command-name>` markup underneath a permanently-gray "/effort".
        const commandKey = commandEnvelopeQueuedKey(text)
        if (commandKey !== undefined && resolveQueued(commandKey)) {
          lastAssistantId = null
          return
        }
        // Belt-and-suspenders: a normal user record that echoes a JUST-delivered queued message would
        // otherwise render it twice. Skip the immediately-following identical text. (Unobserved in the
        // evidence — the queued text only ever arrives via the attachment — but cheap to guard.)
        if (deliveredDedupe !== null && text === deliveredDedupe) {
          deliveredDedupe = null
          return
        }
        deliveredDedupe = null
        // The first user message is the composed dispatch prompt (scratchpad orientation + project
        // instructions + banner + TASK). Only what sits below the banner is the human's words — that
        // narrowing is a DISPLAY projection (userDisplayText), never a rewrite of the stored text.
        pushUserRecord(out, sourceId, text, rec.timestamp, dropCorrection, !drewEvents)
        lastAssistantId = null
      }
      return
    }

    if (rec.type === "assistant") {
      const msg = rec.message
      if (!msg || !Array.isArray(msg.content)) return
      // A synthetic provider AUTH-error record (isApiErrorMessage + the 401/login text) is app
      // state, not something the model said: its ONLY surface is the trusted recovery card driven by
      // ThreadView.providerFault. Rendering it as an assistant bubble was the exact dead-end the
      // claude-auth plan removes ("Please run /login" as a chat message). Other API errors
      // (overloaded, rate-limit) keep their bubble — no card replaces them.
      if (rec.isApiErrorMessage === true) {
        const errText = msg.content
          .filter((b: Raw) => b?.type === "text" && typeof b.text === "string")
          .map((b: Raw) => b.text)
          .join("\n")
        if (isClaudeAuthErrorText(errText)) return
      }
      const id = typeof msg.id === "string" ? msg.id : null
      // Never merge into an EVENT line (a compaction note or an "Agent … finished" line sits at the tail
      // with role:"assistant") — an event is punctuation, not a message body.
      const tail = out.length > 0 ? out[out.length - 1] : undefined
      const target =
        id !== null && id === lastAssistantId && tail && tail.role === "assistant" && tail.kind === undefined
          ? tail
          : null
      const m: TranscriptMessage = target ?? { sourceId, role: "assistant", text: "", tools: [], parts: [], at: rec.timestamp }
      // Walk blocks in ARRAY ORDER (and record order for the split-record case), appending to `parts`
      // so text↔tool interleaving is preserved — a "Let me draft the notes:" lead-in stays directly
      // above the call it introduces. Contiguous same-kind blocks coalesce into one part. The legacy
      // flat text/tools fields stay populated for the pre-restart client window + flat-field consumers.
      for (const block of msg.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          pushTextPart(m, block.text)
          m.text = m.text ? `${m.text}\n\n${block.text}` : block.text
        } else if (block?.type === "tool_use") {
          const calls = toolCalls(block, { turnModel: msg.model, turnEffort: rec.effort })
          for (const call of calls) {
            call.status = "pending"
            pushToolPart(m, call)
            m.tools.push(call)
            // An Agent dispatch is registered by its tool_use id so a later completion notification can
            // back-fill its terminal state and drop an inline event line into the flow.
            if (call.agentId) agentDispatches.set(call.agentId, { at: rec.timestamp, call })
            // …and its TITLE separately, because the map above is consumed on completion (see dispatchLabels).
            if (call.agentId && call.detail?.trim()) dispatchLabels.set(call.agentId, call.detail.trim())
            // A STEER's drill-in pair. `sendTo` is the recipient's AGENT ID, which no drawer resolves and
            // no reader can read; childDispatchIds turns it into the DISPATCH tool_use id every sub-agent
            // lookup is keyed by, and that dispatch's own description is the title the divider shows.
            // Ordering is safe by construction: the launch ack that populates childDispatchIds is the
            // record that HANDED the model this agentId, so it always precedes any steer naming it.
            // `main` is the upward direction (a child reporting to its dispatcher) and never a child of
            // this transcript, so it is excluded rather than looked up and missed.
            if (call.sendTo && call.sendTo !== "main") {
              const dispatchId = childDispatchIds.get(call.sendTo)
              const described = dispatchId ? dispatchLabels.get(dispatchId) : undefined
              if (dispatchId) call.sendDispatchId = dispatchId
              if (described) call.sendTargetLabel = described
            }
            // The launch id rides the CALL as well as this map: the client reconciles its ops-strip row
            // against the board's tracked shell by exactly this key (see TranscriptToolCall.shellId).
            if (call.backgroundState === "background" && typeof block.id === "string") {
              call.shellId = block.id
              backgroundShells.set(block.id, { at: rec.timestamp, call })
            }
          }
          if (typeof block.id === "string" && calls.length > 0) {
            // A Read of a prompt attachment is flagged on the RAW input path (the card's `detail` is
            // redacted and capped, so it is not the thing to test); the result branch reads the flag.
            const promptAttachment = block.name === "Read" && typeof block.input?.file_path === "string" && isPromptAttachmentPath(block.input.file_path)
            pendingTools.set(block.id, { calls, name: String(block.name ?? "tool"), at: rec.timestamp, ...(promptAttachment ? { promptAttachment } : {}) })
          }
        }
        // thinking blocks are deliberately not rendered
      }
      const rendered = Boolean(m.text) || m.tools.length > 0
      if (!target && rendered) out.push(m)
      // Only claim the merge anchor when this record actually became — or extended — out's tail. A
      // record that rendered NOTHING (a thinking-only record, ubiquitous with extended thinking) must
      // NOT advance the anchor to its own id: out's tail is still the PREVIOUS turn, so the next
      // same-id record would fold into that stale tail and glue two turns' text+tools into one bubble
      // (the interleave "wall of text" — tool calls landing under an earlier turn, texts coalesced).
      if (target || rendered) lastAssistantId = id
      deliveredDedupe = null // the turn moved on; the delivered-message dedupe window only spans the very next record
      // …and if THIS is the record that ended the turn, arm the rest divider. Only a turn that actually
      // rendered gets one: a text-less end_turn (an aborted or empty final record) has no bubble for the
      // divider to close, and a rule floating under the previous turn's tools would name a rest the
      // reader can't see happening. `stop_sequence` and friends are deliberately NOT rest — they are the
      // usage-limit/synthetic stops (see backend/usage-limit.ts), which the board reports its own way.
      if (msg.stop_reason === "end_turn" && (target || rendered)) {
        pendingRest = { sourceId: `${sourceId}#rest`, at: rec.timestamp, msgId: id }
      }
      return
    }

    // Any other record type (attachment, queue-operation, ai-title, …) is sidecar — ignore, but
    // a non-user/assistant record between assistant chunks shouldn't break merging, so no reset.
  }

  // A trailing partial (a line with no newline yet) is consumed IMMEDIATELY only when it PARSES — proof
  // it is a complete record and not a mid-write cut (a torn write cannot produce valid JSON). Otherwise
  // it stays buffered for the next ingest. Returns true iff consumed (so the caller advances past it).
  function tryConsumePartial(text: string, at: number): boolean {
    if (!text.trim()) return false
    try {
      JSON.parse(text)
    } catch {
      return false
    }
    processLine(text, at)
    return true
  }

  function ingest(chunk: string): void {
    if (!chunk) return
    const data = buffer + chunk
    buffer = ""
    let pos = offset
    const lastNl = data.lastIndexOf("\n")
    if (lastNl === -1) {
      // No complete line yet — the whole thing is a trailing partial.
      if (tryConsumePartial(data, pos)) offset = pos + Buffer.byteLength(data)
      else {
        buffer = data
        offset = pos
      }
      return
    }
    // Everything up to the last '\n' is complete lines; split EXACTLY as the one-shot fold does. The
    // final element after the trailing '\n' is always "" — the loop bound drops it so byteOffset lands
    // on the next real byte (not one past it), which matters for the appended-bytes cache path.
    const complete = data.slice(0, lastNl + 1)
    const rest = data.slice(lastNl + 1)
    const segs = complete.split("\n")
    for (let i = 0; i < segs.length - 1; i++) {
      const line = segs[i]
      const lineOffset = pos
      pos += Buffer.byteLength(line) + 1
      processLine(line, lineOffset)
    }
    if (rest === "") {
      offset = pos
    } else if (tryConsumePartial(rest, pos)) {
      // Consumed optimistically: advance PAST its bytes (no +1 — its '\n' has not arrived). The next
      // ingest's leading '\n' is absorbed as an empty line, keeping offsets in step with a one-shot fold.
      offset = pos + Buffer.byteLength(rest)
    } else {
      buffer = rest
      offset = pos
    }
  }

  // One-shot path only: flush any remaining trailing partial exactly as the legacy fold did (a final line
  // with no newline is still projected; a parse failure is skipped). The incremental cache never calls
  // this — its buffered partial waits for the newline (or an optimistic parse) on the next appended read.
  function finalize(): void {
    if (buffer === "") return
    processLine(buffer, offset)
    offset += Buffer.byteLength(buffer)
    buffer = ""
  }

  // `out` plus a still-held rest divider. The trailing rest is surfaced HERE rather than flushed in
  // `finalize()` because the incremental cache never calls finalize — and the trailing rest is the one
  // that matters most, since it is the CURRENT one: the agent has stopped and it is the reader's move.
  // Reading it through the accessor also keeps the incremental fold and a one-shot re-parse projecting
  // the identical array, which is exactly what verifyIncrementalParse asserts.
  function projected(): TranscriptMessage[] {
    return pendingRest ? [...out, restMessage(pendingRest.sourceId, pendingRest.at)] : out
  }
  return {
    ingest,
    finalize,
    // The SAME window the paged reader returns (latestTranscriptWindow), because this is the OTHER producer:
    // the /ws push renders from here while the RPC page renders from there, and a push whose head sat
    // further forward than the page's would splice the human's ask straight back out of a card that had
    // just anchored on it (reconcileLiveMessages replaces the window wholesale).
    messages: () => latestTranscriptWindow(projected()),
    allMessages: projected,
    consumedBytes: () => offset + Buffer.byteLength(buffer),
  }
}

export function projectClaudeTranscript(raw: string, identityPrefix = "claude"): TranscriptMessage[] {
  const fold = createTranscriptFold(identityPrefix)
  fold.ingest(raw)
  fold.finalize()
  return fold.allMessages()
}

export function parseTranscript(raw: string, identityPrefix = "claude"): TranscriptMessage[] {
  const fold = createTranscriptFold(identityPrefix)
  fold.ingest(raw)
  fold.finalize()
  return fold.messages()
}

function userText(rec: Raw): string | null {
  const c = rec.message?.content
  if (typeof c === "string") return normalizeNewlines(c).trim() || null
  if (Array.isArray(c)) {
    const texts = c.filter((b: Raw) => b?.type === "text" && typeof b.text === "string").map((b: Raw) => b.text)
    const joined = normalizeNewlines(texts.join("\n\n")).trim()
    return joined || null // tool_result-only records land here as null
  }
  return null
}

// Per-string cap on structured edit payloads: transcripts ride the board snapshot and can hold
// hundreds of messages, so a single huge Write must not bloat the channel. Truncated content is
// still useful for a diff preview; the marker signals the client not to treat it as complete.
const EDIT_CAP = 4000
const TRUNC_MARKER = "\n… (truncated)"

// Tool payloads can contain copied credentials (shell exports/output, file excerpts, MCP arguments)
// or Codex collaboration's opaque encrypted `message` blobs. The transcript is a broad UI surface,
// so redact common secret forms before any payload is retained or summarized. This is deliberately
// presentation-only: the raw JSONL remains untouched.
// What a redacted Fernet token becomes. Shared so codexPeerMessageCall can recognise an encrypted
// inter-agent body by the marker this redactor mints, instead of keeping a rival copy of the pattern.
const ENCRYPTED_PAYLOAD = "[encrypted payload]"

function redactToolPayload(s: string): string {
  return redactCredentialSyntax(s)
    // Fernet payloads commonly end in base64 padding. A trailing word-boundary left that padding
    // behind (`[encrypted payload]==`) and made the redaction visibly incomplete.
    .replace(/gAAAA[A-Za-z0-9_-]{40,}={0,2}/g, ENCRYPTED_PAYLOAD)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, "[redacted private key]")
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{16,}|sk_live_[A-Za-z0-9]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[redacted]")
    // Inputs are usually JSON, so the key's closing quote sits between the word and colon. Accept it
    // here (and a quoted value) rather than protecting only shell-style `Authorization=...` forms.
    .replace(/(\bAuthorization\b["']?\s*[:=]\s*)(?:"(?:Bearer\s+)?[^"]*"|'(?:Bearer\s+)?[^']*'|(?:Bearer\s+)?[^\s,;]+)/gi, "$1[redacted]")
    .replace(
      /(\b(?:[a-z][a-z0-9_]*(?:_api_key|_token|_secret|_password|_passwd)|api[_-]?key|access[_-]?token|auth[_-]?token|token|credential|secret|password|passwd|cookie)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      "$1[redacted]",
    )
}

// The line count of one side of an edit, on the RAW string — the capped transport copy undercounts.
// "" is zero lines (a Write's old side, an empty new file), anything else counts its newlines + 1.
function editLines(s: string): number {
  return s === "" ? 0 : s.split("\n").length
}

function capEdit(s: string): string {
  const safe = redactToolPayload(s)
  return safe.length > EDIT_CAP ? safe.slice(0, EDIT_CAP) + TRUNC_MARKER : safe
}

// An Agent dispatch prompt is a full worker contract — often thousands of chars. Cap it like the
// edit/command payloads so a transcript riding the board snapshot stays light; the marker signals the
// client's AgentBlock body that the prompt is truncated.
const AGENT_PROMPT_CAP = 4000
function capAgentPrompt(s: string): string {
  const safe = redactToolPayload(s)
  return safe.length > AGENT_PROMPT_CAP ? safe.slice(0, AGENT_PROMPT_CAP) + TRUNC_MARKER : safe
}

// A SendMessage body is peer-to-peer prose — usually short, but a steer can run long. Cap it like the
// prompt/edit payloads so a transcript riding the board snapshot stays light; the marker signals the
// client's SendMessageCard that the body is truncated.
const SEND_BODY_CAP = 4000
function capSendBody(s: string): string {
  const safe = redactToolPayload(s)
  return safe.length > SEND_BODY_CAP ? safe.slice(0, SEND_BODY_CAP) + TRUNC_MARKER : safe
}

// EVERY Bash call ships its `command` so the client renders it as a collapsed BashBlock card (the
// one-liner tool rendering was retired — every tool call is a card now). Multi-line/long commands
// expand to their full body; a short one-liner's body simply echoes its header. Capped so a huge
// command can't bloat the transcript channel.
const COMMAND_CAP = 2000
function capCommand(s: string): string {
  const safe = redactToolPayload(s)
  return safe.length > COMMAND_CAP ? safe.slice(0, COMMAND_CAP) + TRUNC_MARKER : safe
}
const TOOL_INPUT_CAP = 4000
function capToolInput(s: string): string {
  const safe = redactToolPayload(s)
  return safe.length > TOOL_INPUT_CAP ? safe.slice(0, TOOL_INPUT_CAP) + TRUNC_MARKER : safe
}
// One-line summary for a block command: its first non-blank line, with a trailing ellipsis when more
// content follows. Feeds the inline renderer and dense card previews; the full command rides `command`.
function bashSummary(cmd: string): string {
  const lines = redactToolPayload(cmd).split("\n")
  const first = (lines.find((l) => l.trim()) ?? "").trim()
  const hasMore = cmd.trim() !== first
  const base = first.length > 120 ? first.slice(0, 119) + "…" : first
  return hasMore && !base.endsWith("…") ? base + "…" : base
}

// A Read call's result excerpt: the file content it returned, capped like the edit/command payloads
// so a big file can't bloat the transcript channel (transcripts ride the board snapshot). Cap by BOTH
// a line budget and a byte budget — whichever bites first — and mark truncation so the client's
// "Show all N lines" affordance reads honestly.
const READ_LINE_CAP = 200
const READ_BYTE_CAP = 16000
function capRead(s: string): string {
  let out = redactToolPayload(s)
  const lines = out.split("\n")
  if (lines.length > READ_LINE_CAP) out = lines.slice(0, READ_LINE_CAP).join("\n") + TRUNC_MARKER
  if (out.length > READ_BYTE_CAP) out = out.slice(0, READ_BYTE_CAP) + TRUNC_MARKER
  return out
}

// Map a base64 image block's media_type to a file extension the /local-image route can serve. The route
// whitelists exactly these content types (app.ts). An unrecognized/absent media_type — notably svg, which
// the route deliberately omits as an XSS vector — is NEVER guessed at; such a block is skipped entirely so
// the card falls back to its text result rather than mislabeling foreign bytes as png.
const IMAGE_MEDIA_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

// Directory for decoded tool-result screenshots. Under the OS temp dir so it is already a trusted root
// for the /local-image route (app.ts) — the client serves these paths without any allowlist change.
// Per-install: pruneScreenshotCache() unlinks the oldest entries past a cap across the WHOLE
// directory, so a shared one means one install deleting another's cache. Filenames are id-hashed,
// so nothing needs per-project isolation here — only the sweep does.
const SCREENSHOT_CACHE_DIR = frizzTempDir("frizz-tool-images")
// Defensive cap on retained decoded images: a long-lived server driving many screenshot QA loops would
// otherwise grow the cache without bound. Oldest-by-mtime are pruned past this on the rare write path.
const SCREENSHOT_CACHE_MAX = 200
// Bound the base64 we will decode into memory for a single image block (~24 MB of image); a real
// screenshot is far below this. Guards against a pathologically large embedded payload.
const SCREENSHOT_MAX_BASE64 = 32_000_000
let screenshotTmpSeq = 0

// Only persist bytes that ACTUALLY are the image type the block claims — a garbage/mismatched/svg payload
// is skipped so the card shows its text result instead of a broken <img>. Matches the leading magic bytes.
function looksLikeImage(buf: Buffer, ext: string): boolean {
  if (ext === "png") return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  if (ext === "jpg") return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  if (ext === "gif") return buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 // "GIF"
  if (ext === "webp") return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP"
  return false
}

// Best-effort prune so the cache dir can't grow without bound. Cheap because it only runs on the RARE
// first-persist write path (never on a re-parse that hit the existsSync short-circuit). Opportunistic —
// any fs error is swallowed; pruning is never load-bearing.
function pruneScreenshotCache(): void {
  try {
    const entries = readdirSync(SCREENSHOT_CACHE_DIR).filter((n) => !n.startsWith("."))
    if (entries.length <= SCREENSHOT_CACHE_MAX) return
    const byMtime = entries
      .map((n) => {
        try {
          return { n, m: statSync(join(SCREENSHOT_CACHE_DIR, n)).mtimeMs }
        } catch {
          return { n, m: 0 }
        }
      })
      .sort((a, b) => b.m - a.m)
    for (const { n } of byMtime.slice(SCREENSHOT_CACHE_MAX)) {
      try {
        unlinkSync(join(SCREENSHOT_CACHE_DIR, n))
      } catch {
        /* already gone / concurrent unlink */
      }
    }
  } catch {
    /* dir missing or unreadable — nothing to prune */
  }
}

// A tool_result whose content carries a base64 image (chrome-devtools MCP `take_screenshot`, an image
// Read, any tool that returns a picture) → decode it ONCE to a file under the OS temp dir and return its
// absolute path, so the chat can render the screenshot inline via /local-image. The filename derives from
// the tool_use id (`idKey`), NOT the image bytes, so the existsSync guard short-circuits BEFORE the
// expensive base64 decode + write: the transcript parser runs on every poll and must not re-decode
// already-persisted screenshots each time. Persists only a KNOWN servable image type whose bytes match its
// magic signature. Publishes atomically (temp file + rename) so a concurrent /local-image read never sees a
// half-written image. Any fs error yields undefined → the card falls back to its text/summary rendering.
// Returns the FIRST qualifying image block (screenshots are single-image).
function persistResultImage(content: unknown, idKey: string): string | undefined {
  if (!Array.isArray(content) || !idKey) return undefined
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "image") continue
    const source = (block as { source?: unknown }).source
    if (!source || typeof source !== "object") continue
    const s = source as { type?: string; media_type?: string; data?: string }
    if (s.type !== "base64" || typeof s.data !== "string" || !s.data) continue
    const persisted = persistBase64Image(s.media_type, s.data, idKey)
    if (persisted) return persisted
  }
  return undefined
}

// The codex form of the same picture: a `data:image/png;base64,…` URL off an `input_image` result part
// (an MCP `take_screenshot`, which for a screenshot taken without `filePath` is the ONLY copy that
// exists). Same cache, same id-derived name, same guarantees as the Claude block above.
function persistDataUrlImage(dataUrl: string | undefined, idKey: string): string | undefined {
  if (!dataUrl || !idKey) return undefined
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return undefined // a non-base64 data URL (or a plain URL) is not ours to decode
  return persistBase64Image(match[1], match[2], idKey)
}

// Decode base64 image bytes to the servable cache ONCE and return the absolute path. The filename derives
// from `idKey` (the tool_use / call id), NOT the bytes, so the existsSync guard short-circuits BEFORE the
// expensive decode + write: the transcript parser runs on every poll and must not re-decode already
// persisted screenshots each time. Persists only a KNOWN servable image type whose bytes match its magic
// signature — a mislabeled or svg payload is skipped so the card falls back to text rather than mounting a
// broken <img>. Publishes atomically (temp + rename) so a concurrent /local-image read never sees a
// half-written file. Any fs error yields undefined.
function persistBase64Image(mediaType: string | undefined, data: string, idKey: string): string | undefined {
  const ext = IMAGE_MEDIA_EXT[typeof mediaType === "string" ? mediaType.toLowerCase() : ""]
  if (!ext || !data) return undefined // unrecognized/absent media type (incl. svg) — never guess
  const name = createHash("sha256").update(idKey).digest("hex").slice(0, 32) // hashes the id, not the image (cheap)
  const path = join(SCREENSHOT_CACHE_DIR, `${name}.${ext}`)
  try {
    if (existsSync(path)) return path // already persisted this tool call — no decode, no write
    if (data.length > SCREENSHOT_MAX_BASE64) return undefined
    const buf = Buffer.from(data, "base64")
    if (buf.length === 0 || !looksLikeImage(buf, ext)) return undefined // not the image it claims
    mkdirSync(SCREENSHOT_CACHE_DIR, { recursive: true })
    const tmp = join(SCREENSHOT_CACHE_DIR, `.${name}.${process.pid}.${screenshotTmpSeq++}.tmp`)
    writeFileSync(tmp, buf)
    renameSync(tmp, path) // atomic publish
    pruneScreenshotCache()
    return path
  } catch {
    return undefined
  }
}

// Max source image we will copy (bytes). A statSync check BEFORE readFileSync bounds memory — never load
// a multi-GB path the model named into a Buffer. A real screenshot is far below this.
const SENT_IMAGE_MAX_BYTES = 24_000_000
// Max files rendered from one SendUserFile call — a delivery of more than this is pathological; the extra
// are dropped so the card can't mount hundreds of images/chips.
const SENT_FILES_MAX = 24
// SendUserFile ships ABSOLUTE SOURCE paths (often a scratch file the worker will overwrite on its next
// iteration). For each IMAGE file, copy it ONCE into the screenshot cache and return the cached absolute
// path so the chat renders it inline via /local-image; a non-image, oversized, unreadable, or
// mismatched-bytes file → undefined (the caller records its basename as an openable chip instead).
// `idKey` (tool_use id + file index) makes the cache name UNIQUE PER CALL — so a re-projection on every
// poll short-circuits on existsSync, while a later call that reuses the same PATH with new content (a
// worker overwriting `shot.png`) gets a fresh copy instead of the stale first one. SVG is excluded (not
// in ATTACHMENT_IMAGE_EXTENSIONS — an XSS vector the /local-image route omits). Any fs error → undefined.
function persistSentFile(srcPath: string, idKey: string): string | undefined {
  const ext = attachmentExtension(srcPath)
  if (!(ATTACHMENT_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return undefined
  const outExt = ext === "jpeg" ? "jpg" : ext // /local-image serves png/jpg/gif/webp
  try {
    const name = createHash("sha256").update(idKey).digest("hex").slice(0, 32) // hashes the call+index, not the bytes (cheap)
    const dest = join(SCREENSHOT_CACHE_DIR, `${name}.${outExt}`)
    if (existsSync(dest)) return dest // already copied for this call — no re-read/write
    const size = statSync(srcPath).size // bound memory BEFORE reading (never buffer a huge file)
    if (size === 0 || size > SENT_IMAGE_MAX_BYTES) return undefined
    const buf = readFileSync(srcPath)
    if (!looksLikeImage(buf, outExt)) return undefined // not the image it claims → chip fallback
    mkdirSync(SCREENSHOT_CACHE_DIR, { recursive: true })
    const tmp = join(SCREENSHOT_CACHE_DIR, `.${name}.${process.pid}.${screenshotTmpSeq++}.tmp`)
    writeFileSync(tmp, buf)
    renameSync(tmp, dest) // atomic publish so a concurrent /local-image read never sees a half-written file
    pruneScreenshotCache()
    return dest
  } catch {
    return undefined
  }
}

// Codex's `view_image` tool — the model pulling a picture off disk INTO its own context. The rollout's
// result is `[{type:"input_image", image_url:"data:…;base64,…"}]`, which backend/codex deliberately
// collapses to the "[image output]" placeholder rather than pumping megabytes of base64 through the
// tailer's event stream. So the picture is recovered from the CALL's `path` instead: copy the real file
// into the screenshot cache (exactly as a SendUserFile delivery does) and hand the card an `outputImage`,
// so the reader SEES what the model looked at instead of a bare path.
//
// The copy is about FIDELITY, not servability — /local-image would happily serve the source path (it is
// deliberately unconfined; see local-image.ts). Workers overwrite one screenshot path over and over while
// iterating (`shot.mjs out.png`, fix, re-shoot, re-view), so rendering the LIVE file would show every card
// in that loop the same final image — a transcript that lies about what the model saw at step 1. Keying
// the cache copy on the CALL id snapshots each view independently. Best-effort: the copy happens on first
// projection, so only a transcript projected after the fact (never a live one, which polls within a tick
// of the call) can miss a rewrite — still strictly better than serving the live path. A missing,
// unreadable, oversized, or magic-byte-mismatched file yields undefined → the card degrades to its plain
// header, never a broken <img>. So does a view of the human's own prompt attachment, on purpose: their
// bubble already shows that picture, and the card would repeat it (isPromptAttachmentPath).
function viewImageCall(path: string | undefined, idKey: string | undefined): TranscriptToolCall {
  const image = path && idKey && !isPromptAttachmentPath(path) ? persistSentFile(path, idKey) : undefined // reads the REAL path
  return {
    name: "View image",
    detail: path ? redactToolPayload(path) : undefined, // the DISPLAYED path is redacted, as everywhere else
    ...(image ? { outputImage: image } : {}),
  }
}

// Pull the text payload out of a tool_result block's content (string, or an array of text parts).
// Non-text results (e.g. an image Read) yield nothing → the call keeps its plain one-line summary.
function toolResultText(content: any): string | null {
  if (typeof content === "string") return content.trim() || null
  if (Array.isArray(content)) {
    const joined = content
      .filter((b: Raw) => b?.type === "text" && typeof b.text === "string")
      .map((b: Raw) => b.text)
      .join("\n")
    return joined.trim() ? joined : null
  }
  return null
}

// `promptAttachment`: the call is a Read of a file the human attached to a prompt (see
// isPromptAttachmentPath) — its image result is NOT lifted onto the card, because the human's own
// bubble already shows that picture and the card would repeat it directly beneath.
type PendingClaudeTool = { calls: TranscriptToolCall[]; name: string; at?: string; promptAttachment?: boolean }

function elapsedBetween(start: unknown, end: unknown): number | undefined {
  const a = typeof start === "string" ? Date.parse(start) : NaN
  const b = typeof end === "string" ? Date.parse(end) : NaN
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : undefined
}

function cancelledToolResult(text: string): boolean {
  const t = text.trimStart()
  return (
    /^(?:cancelled|canceled|interrupted|aborted|killed)\b/i.test(t) ||
    /^(?:tool|command|process|operation|request|task)\s+(?:was\s+)?(?:cancelled|canceled|interrupted|aborted|killed)\b/i.test(t)
  )
}

// The harness's AUTO-BACKGROUND handoff: a foreground `Bash` that outlives its `timeout` is not
// cancelled and has not failed — it is now a detached shell that will notify on exit, exactly like one
// launched with `run_in_background`. Kept in lockstep with the tailer's AUTO_BACKGROUND_ACK_RE.
function autoBackgroundedToolResult(text: string): boolean {
  return /^\s*Command did not complete within its .{0,40}?and was moved to the background/.test(text)
}

// Back-fill real Claude tool results. Read keeps its dedicated excerpt field; ordinary tools expose a
// bounded result pane. Successful edits suppress their redundant prose acknowledgement (the diff is
// already the useful payload), while failures retain it. Agent's immediate result is only launch
// metadata explicitly marked non-user-facing, so its card stays pending until completionEvent.
function attachToolResults(
  rec: Raw,
  pending: Map<string, PendingClaudeTool>,
  backgroundShells: Map<string, { at?: string; call: TranscriptToolCall }>,
  backgroundTaskIds: Map<string, string>,
  childDispatchIds: Map<string, string>,
): void {
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const b of content) {
    if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue
    const entry = pending.get(b.tool_use_id)
    if (!entry) continue
    pending.delete(b.tool_use_id)
    // THE ONE RECORD WHERE A CHILD'S TWO IDENTITIES MEET. An Agent launch ack carries the new child's own
    // `agentId` in its structured `toolUseResult`, beside the `tool_use_id` of the dispatch that spawned
    // it. Nothing else in the transcript pairs them: a later upward report names its sender by agentId
    // (`origin.senderTaskId`), while every drawer lookup is keyed by the DISPATCH id. Recorded here so the
    // peer arm can turn one into the other. Gated on `entry.call.agentId`, which the projector sets only
    // for an Agent dispatch — so a Bash or Monitor ack can never land in this map.
    const ackAgentId = typeof rec.toolUseResult?.agentId === "string" ? rec.toolUseResult.agentId.trim() : ""
    // One tool_use can project several cards, so find the one carrying `agentId` — the projector sets it
    // only for an Agent dispatch (to the tool_use id itself), which both identifies the dispatch and
    // filters out a Bash or Monitor ack that happens to carry an agentId of its own.
    const dispatchId = entry.calls.find((c) => typeof c.agentId === "string" && c.agentId)?.agentId
    if (ackAgentId && dispatchId) childDispatchIds.set(ackAgentId, dispatchId)
    const text = toolResultText(b.content)
    // A TaskList's RESULT is the list — the only to-do call whose payload is an enumeration, and the only
    // reason this family needs the result at all (the same shape as a Read taking its excerpt from here).
    if (text && entry.name === "TaskList") {
      const todos = parseTodoListResult(text)
      if (todos) for (const call of entry.calls) call.todos = todos
    }
    // A manual TaskStop is a terminal signal for the op it killed — the SAME correlation the tailer
    // reads (its structured result carries `task_id`; no notification ever follows). Without this a
    // background card whose op was stopped by hand spins forever in the timeline.
    if (text && /Successfully stopped task/.test(text)) {
      const stoppedId = text.match(/"task_id"\s*:\s*"([^"]+)"/)?.[1]
      const toolUseId = stoppedId ? backgroundTaskIds.get(stoppedId) : undefined
      const shell = toolUseId ? backgroundShells.get(toolUseId) : undefined
      if (toolUseId && shell) {
        backgroundShells.delete(toolUseId)
        shell.call.status = "cancelled"
        const stoppedMs = elapsedBetween(shell.at, rec.timestamp)
        if (stoppedMs !== undefined) shell.call.durationMs = stoppedMs
      }
    }
    // A foreground `Bash` that outlives its `timeout` is AUTO-BACKGROUNDED by the harness, which says so
    // only here, in the result ("Command did not complete within its 590s timeout and was moved to the
    // background (ID: …)"). From this record on it is an ordinary detached shell, so the card must become
    // one: registered in `backgroundShells` and marked background, which both keeps it pending (its
    // terminal signal is now the <task-notification>, not this ack) and routes it through the branch
    // below that captures its runtime task id. Without this the launch card read COMPLETED the moment the
    // shell went into the background, and its real completion landed on nothing — the transcript half of
    // "a background bash script completed, but it did not resume the agent" (2026-07-30).
    const promoted = entry.calls[0]
    if (promoted && text && autoBackgroundedToolResult(text) && b.is_error !== true) {
      for (const call of entry.calls) {
        call.backgroundState = "background"
        // Same launch key as a deliberate background launch — the tailer parks an auto-backgrounded
        // shell under its original tool_use id too, so the strip can still reconcile the two rows.
        call.shellId = b.tool_use_id
      }
      if (!backgroundShells.has(b.tool_use_id)) backgroundShells.set(b.tool_use_id, { at: entry.at, call: promoted })
    }
    // A successful Agent result is launch metadata, not child completion. Keep waiting for the
    // task-notification in that case. A launch error, however, may never produce a notification and
    // must not leave the card spinning forever.
    if (
      (entry.name === "Agent" || entry.calls.some((call) => call.backgroundState === "background")) &&
      b.is_error !== true &&
      !(text && (cancelledToolResult(text) || failedToolResult(text)))
    ) {
      // Capture the launch ack's RUNTIME task id (Bash "…with ID: <id>", Monitor "(task <id>", the
      // auto-background handoff's "moved to the background (ID: <id>)", and an ASYNC AGENT's own
      // `agentId`) so the tool-use-id-less terminal signals above/in completionEvent can still find
      // this card.
      //
      // The AGENT arm is the one this map was missing, and it is the ONE divergence from the tailer's
      // `launchTaskId` — which has carried the fourth pattern all along. A sub-agent's completion
      // notification arrives in two shapes, and the second names the child ONLY by its agent id:
      //
      //   <task-notification>
      //   <task-id>aab99c3e7b670a3ae</task-id>
      //   <status>completed</status>
      //   <summary>Agent "Survey bun-compiled OSS projects" finished</summary>
      //
      // The tailer correlated that (findLiveByTaskId) and retired the row, so the child's line left the
      // rail, the queue card and the ops strip — while THIS parser resolved the task-id against a map
      // that only ever held shells, emitted no `agentCompletion` divider, and left the launch card
      // pending forever. The child simply vanished with nothing said, which is exactly how the
      // maintainer found it ("some sub-agents have disappeared from the rendered list … but I don't see
      // any notification of it", 2026-07-30, nub thread we-need-to-get-the-ball). Measured over this
      // machine's whole transcript corpus (682 files, 1905 Agent dispatches): 1671 terminals carried a
      // tool-use-id, 155 — 8.1% — carried ONLY the task-id and so said nothing at all.
      //
      // The STRUCTURED `agentId` is preferred over the ack's prose (all 1858 async acks in that corpus
      // carry both, and a field cannot drift the way an English sentence can); the regex mirrors the
      // tailer so a shape that only ever spells it out still correlates.
      const taskId =
        text?.match(/Command running in background with ID:\s*(\S+)/)?.[1]?.replace(/\.$/, "") ??
        text?.match(/was moved to the background \(ID:\s*([^)\s]+)\)/)?.[1] ??
        text?.match(/Monitor started \(task\s+(\w+)/)?.[1] ??
        (dispatchId ? (ackAgentId || text?.match(/agentId:\s*(\S+)/)?.[1]) : undefined)
      if (taskId) backgroundTaskIds.set(taskId, b.tool_use_id)
      continue
    }
    // Claude reports tool failures with `is_error`; keep a narrow text fallback for older logs that
    // omitted the flag. An unanchored search misclassified successful output such as "0 failed".
    const failed = b.is_error === true || Boolean(text && /^(?:error|failed|permission denied)\b/i.test(text.trim()))
    const status: NonNullable<TranscriptToolCall["status"]> = text && cancelledToolResult(text) ? "cancelled" : failed ? "failed" : "completed"
    const durationMs = elapsedBetween(entry.at, rec.timestamp)
    // A screenshot / image tool_result (e.g. chrome-devtools `take_screenshot`) carries a base64 image
    // block instead of — or alongside — text. Decode it to a temp file (keyed by the tool_use id) so the
    // card can render it inline. `b.tool_use_id` is a verified string by the guard at the loop head.
    // A Read of the human's own prompt attachment keeps its plain header instead (PendingClaudeTool).
    const outputImage = status !== "failed" && status !== "cancelled" && !entry.promptAttachment ? persistResultImage(b.content, b.tool_use_id) : undefined
    for (const call of entry.calls) {
      call.status = status
      if (durationMs !== undefined) call.durationMs = durationMs
      if (outputImage) call.outputImage = outputImage
      // An AskUserQuestion's structured result carries the human's answers keyed by question text —
      // lift them onto the card so the settled question renders answered. The prose result ("Your
      // questions have been answered: …", or the withdrawal boilerplate on a deny) restates what the
      // card already draws, so an ask call never grows an output pane.
      if (call.ask) {
        const answers = b.is_error === true ? null : parseAskUserQuestionAnswers(rec.toolUseResult, call.ask)
        if (answers) call.askAnswers = answers.map((a) => (a === null ? null : redactToolPayload(a)))
        continue
      }
      if (!text) continue
      if (entry.name === "Read") call.read = capRead(text)
      else if (!call.edit || status !== "completed") call.output = capRead(text)
    }
  }
}

// Expand one tool_use block into transcript tool calls. Usually one, but MultiEdit fans out to one
// call per sub-edit so each renders as its own diff. Edit/Write/MultiEdit additionally carry a
// structured `edit` payload (Write's old side is "" — the whole file is new).
// `turn` is the dispatching assistant record's own model + effort — what a sub-agent dispatched
// without an explicit `model` inherits (see subagent-profile.ts). Only the Agent branch reads it.
function toolCalls(block: any, turn: { turnModel?: string; turnEffort?: string } = {}): TranscriptToolCall[] {
  const name = redactToolPayload(String(block?.name ?? "tool"))
  const input = block?.input
  const detail = toolDetail(input)

  if (input && typeof input === "object") {
    // The built-in to-do list, ahead of every other case: these calls carry a `description` field, which
    // the generic detail fallback would otherwise promote to the card's title.
    const todoCall = claudeTodoCall(name, input as Record<string, unknown>)
    if (todoCall) return [todoCall]
    const file = typeof input.file_path === "string" ? redactToolPayload(input.file_path) : undefined
    if (name === "Edit" && file && typeof input.old_string === "string" && typeof input.new_string === "string") {
      return [{ name, detail, edit: { file, old: capEdit(input.old_string), new: capEdit(input.new_string), added: editLines(input.new_string), removed: editLines(input.old_string) } }]
    }
    if (name === "Write" && file && typeof input.content === "string") {
      return [{ name, detail, edit: { file, old: "", new: capEdit(input.content), added: editLines(input.content), removed: 0 } }]
    }
    if (name === "MultiEdit" && file && Array.isArray(input.edits)) {
      const calls = input.edits
        .filter((e: any) => e && typeof e.old_string === "string" && typeof e.new_string === "string")
        .map((e: any) => ({ name, detail, edit: { file, old: capEdit(e.old_string), new: capEdit(e.new_string), added: editLines(e.new_string), removed: editLines(e.old_string) } }))
      if (calls.length) return calls
    }
    if (name === "Bash" && typeof input.command === "string" && input.command.trim()) {
      const desc = typeof input.description === "string" && input.description.trim() ? redactToolPayload(input.description.trim()).slice(0, 160) : undefined
      const backgroundState =
        input.run_in_background === true
          ? "background" as const
          : hasEscapingBackgroundJob(input.command)
            ? "unknown" as const
            : undefined
      return [{
        name,
        detail: bashSummary(input.command),
        command: capCommand(input.command),
        desc,
        // A background Bash result only acknowledges that the child was launched. Keep the card live
        // until its later task-notification; no launch result can truthfully mean "done".
        // Shell job control is visible immediately, even though no lifecycle id exists. Current Frizz
        // workers reject the attempt before execution; historical calls that escaped the guard remain
        // honestly UNKNOWN instead of folding into an opaque "Ran N tool calls" disclosure.
        backgroundState,
      }]
    }
    // An Agent dispatch carrying a prompt renders as its own AgentBlock card (Bash/Read family): the
    // description is the header one-liner, `subagentType` the resolved model+effort cell (composed from
    // the profile, the call's own `model`, and this turn's — see subagent-profile.ts), the (capped)
    // prompt the expandable body, and block.id the correlation key to the live child + its drawer.
    if (name === "Agent" && typeof input.prompt === "string" && input.prompt.trim()) {
      const description = typeof input.description === "string" && input.description.trim() ? redactToolPayload(input.description.trim()) : undefined
      const subagentType = dispatchProfileCell({
        subagentType: typeof input.subagent_type === "string" ? redactToolPayload(input.subagent_type) : undefined,
        model: typeof input.model === "string" ? redactToolPayload(input.model) : undefined,
        ...turn,
      })
      const agentId = typeof block.id === "string" ? block.id : undefined
      return [{ name, detail: description ?? detail, prompt: capAgentPrompt(input.prompt), subagentType, agentId }]
    }
    // A SendMessage (peer/agent-to-agent) renders as its own SendMessageCard (Bash/Agent family): the
    // recipient (`to`, alias `recipient`) rides the header as "→ <name>", the `summary` is the one-line
    // recap, the body (`message`, alias `content`) is the expandable card body, and a non-"message"
    // `type` (e.g. "shutdown_request") is surfaced as the label. `to` and `content`/`message` are the
    // canonical fields; `recipient`/`content` are duplicate aliases some emitters ship — take either.
    if (name === "SendMessage") {
      const to = strField(input.to) ?? strField(input.recipient)
      const bodyRaw = typeof input.message === "string" ? input.message : typeof input.content === "string" ? input.content : ""
      const summary = strField(input.summary)
      const sendType = strField(input.type)
      const body = normalizeNewlines(bodyRaw)
      if (to || body.trim() || summary) {
        return [{ name, detail: summary ?? to, sendTo: to, sendSummary: summary, sendBody: capSendBody(body), sendType }]
      }
    }
    // SendUserFile (Claude Code file delivery) → a SentFilesCard that shows the delivered files inline
    // instead of a generic tool block: image files are copied into the servable cache and rendered as
    // pictures; non-image (or display:"attach") files become openable chips; the `caption` shows below.
    if (name === "SendUserFile") {
      const raw = Array.isArray(input.files) ? input.files : typeof input.files === "string" ? [input.files] : []
      // Cap the count so a pathological call can't trigger hundreds of copies / <img> mounts.
      const files = raw.filter((f: unknown): f is string => typeof f === "string" && f.trim().length > 0).slice(0, SENT_FILES_MAX)
      if (files.length) {
        const caption = strField(input.caption)?.slice(0, 600) // one-line caption; bound it like other fields
        const attachOnly = strField(input.display) === "attach"
        const idBase = typeof block?.id === "string" && block.id ? block.id : caption ?? files[0]
        const sentImages: string[] = []
        const sentFiles: string[] = [] // full ABSOLUTE source paths (the client links them + shows the basename)
        files.forEach((f: string, i: number) => {
          const img = attachOnly ? undefined : persistSentFile(f, `${idBase}:${i}`) // reads the REAL path
          if (img) sentImages.push(img)
          else sentFiles.push(redactToolPayload(f)) // redact the DISPLAYED/linked path (as every other file_path)
        })
        return [{
          name,
          detail: caption ?? `${files.length} file${files.length === 1 ? "" : "s"} sent`,
          sentImages: sentImages.length ? sentImages : undefined,
          sentFiles: sentFiles.length ? sentFiles : undefined,
          caption,
        }]
      }
    }
    // A native AskUserQuestion carries its structured questions onto the card, so the SETTLED call
    // renders as a read-only question card at its place in the transcript. This is the durable record
    // of a question the human saw: a follow-up sent instead of an answer retires the pending
    // interaction card (the broker denies the parked call), and without this the ask vanished into a
    // generic tool line inside a "Ran N tool calls" disclosure.
    if (name === "AskUserQuestion") {
      const ask = parseAskUserQuestionInput(input).map((q) => ({
        question: redactToolPayload(q.question),
        header: q.header === undefined ? undefined : redactToolPayload(q.header),
        multiSelect: q.multiSelect,
        options: q.options.map((o) => ({
          label: redactToolPayload(o.label),
          description: o.description === undefined ? undefined : redactToolPayload(o.description),
        })),
      }))
      if (ask.length) return [{ name, detail: ask[0].header ?? ask[0].question.slice(0, 80), ask }]
    }
    // A Monitor is ALWAYS a detached background watcher (Claude Code runs it detached; its launch
    // result is only an ack). Mark it background so it registers in backgroundShells and its card
    // stays truthfully "running" until the stream-end / timeout / TaskStop signal — the launch ack
    // must never complete it.
    if (name === "Monitor") {
      // `desc` feeds the wake-boundary label («desc» timed out / stopped), same as a Bash description.
      const desc = typeof input.description === "string" && input.description.trim() ? redactToolPayload(input.description.trim()).slice(0, 160) : undefined
      return [{ name, detail, desc, input: renderToolInput(input), backgroundState: "background" }]
    }
  }

  return [{ name, detail, input: renderToolInput(input) }]
}

// A trimmed non-empty string field, else undefined — for optional input fields (SendMessage's
// to/summary/type) where empty/absent should collapse to undefined, not "".
function strField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? redactToolPayload(v.trim()) : undefined
}

// ── THE BUILT-IN TO-DO LIST ──────────────────────────────────────────────────────────────────────
//
// Two shapes reach the projector, and only one of them is a LIST:
//
//   Claude Code   TaskList — its RESULT enumerates every task (`#1 [pending] <subject>` per line). That
//                 result is the list, so it renders as a checklist. Its siblings TaskCreate/TaskUpdate/
//                 TaskGet are per-task DELTAS (`{taskId:"3", status:"completed"}`) that carry no list at
//                 all; reconstructing one would mean accumulating list state across the transcript,
//                 which the projector deliberately does not do (maintainer 2026-07-29). They get an
//                 honest one-line title instead — the fix that actually mattered, since the generic
//                 detail fallback was picking their `description` and turning a paragraph-long
//                 maintainer ruling into the card's title.
//   codex         `update_plan`, and Claude's legacy `TodoWrite` — the WHOLE list on every call, in the
//                 INPUT. Nothing to accumulate; the call is already the list.
type TodoStatus = TranscriptTodo["status"]

function todoStatus(v: unknown): TodoStatus | undefined {
  return v === "pending" || v === "in_progress" || v === "completed" ? v : undefined
}

// The rows of a whole-list payload: `{todos:[{content, status}]}` (TodoWrite) or `{plan:[{step, status}]}`
// (codex update_plan). Bounded so a pathological call can't mount ten thousand rows.
const TODO_ROWS_MAX = 200
function todoRows(raw: unknown): TranscriptTodo[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: TranscriptTodo[] = []
  for (const item of raw.slice(0, TODO_ROWS_MAX)) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const text = strField(row.content) ?? strField(row.subject) ?? strField(row.step) ?? strField(row.text)
    if (!text) continue
    out.push({ text: capTodoText(text), status: todoStatus(row.status) ?? "pending" })
  }
  return out.length ? out : undefined
}

// A row is a one-line title. Cap it so a model that wrote a paragraph into a `subject` can't stretch
// the card — the client truncates for display, but the payload should stay light too.
const TODO_TEXT_CAP = 300
function capTodoText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > TODO_TEXT_CAP ? `${flat.slice(0, TODO_TEXT_CAP - 1)}…` : flat
}

// A whole-list call → the checklist card. `input` carries the model's own commentary when it wrote any
// (a codex plan `explanation`), rendered as a second pane below the list.
function wholeListTodoCall(name: string, todos: TranscriptTodo[], input?: string): TranscriptToolCall {
  return { name, todos, input }
}

// Claude Code's Task* family. TaskList becomes a checklist card once its result lands (see
// parseTodoListResult); the deltas get a title that describes the CHANGE — never their `description`,
// which stays available as the card's expandable body.
function claudeTodoCall(name: string, input: Record<string, unknown>): TranscriptToolCall | undefined {
  const body = strField(input.description)
  if (name === "TaskList") return { name, detail: undefined, input: undefined }
  if (name === "TaskCreate") {
    const subject = strField(input.subject)
    return subject ? { name, detail: capTodoText(subject), input: body ? capToolInput(body) : undefined } : undefined
  }
  if (name === "TaskUpdate" || name === "TaskGet") {
    const id = strField(input.taskId) ?? strField(input.task_id)
    if (!id) return undefined
    const subject = strField(input.subject)
    // The harness's `in_progress` is a wire value, not copy — sentence case for anything a human reads.
    const status = typeof input.status === "string" ? input.status.replace(/_/g, " ") : undefined
    // "#8 → completed", "#8 Implement the object syntax → in progress", or — for an update that only
    // rewrote fields — "#7 · description". The id is the only identity the call carries; the SUBJECT
    // would need the list, which is exactly what this no longer reconstructs.
    const changed = Object.keys(input).filter((k) => k !== "taskId" && k !== "task_id")
    const head = [`#${id}`, subject ? capTodoText(subject) : undefined].filter(Boolean).join(" ")
    const detail =
      name === "TaskGet" ? head : status ? `${head} → ${status}` : changed.length ? `${head} · ${changed.join(", ")}` : head
    return { name, detail, input: body ? capToolInput(body) : undefined }
  }
  if (name === "TodoWrite") {
    const rows = todoRows(input.todos)
    return rows ? wholeListTodoCall(name, rows) : undefined
  }
  return undefined
}

// A TaskList result IS the list — the one place the harness enumerates every task it holds. One
// `#<id> [<status>] <subject>` line each; "No tasks found" when the list is empty (→ an empty checklist,
// which the card renders as "empty" rather than as a missing body).
function parseTodoListResult(resultText: string): TranscriptTodo[] | undefined {
  if (/^\s*No tasks found\s*$/i.test(resultText)) return []
  const out: TranscriptTodo[] = []
  for (const line of resultText.split("\n").slice(0, TODO_ROWS_MAX)) {
    const m = line.match(/^#(\S+)\s+\[(\w+)\]\s+(.+)$/)
    if (!m) continue
    const text = strField(m[3])
    if (text) out.push({ text: capTodoText(text), status: todoStatus(m[2]) ?? "pending" })
  }
  return out.length ? out : undefined
}

// One human-scannable hint per tool call, in preference order of what the input reveals.
function toolDetail(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined
  if (typeof input.pattern === "string" && input.pattern.trim()) {
    const path = typeof input.path === "string" && input.path.trim() ? ` · ${input.path.trim()}` : ""
    return redactToolPayload(`${input.pattern.trim()}${path}`).slice(0, 400)
  }
  let cand: unknown =
    input.file_path ?? input.path ?? input.command ?? input.description ?? input.pattern ?? input.query ?? input.url
  // Generic fallback so a tool outside the known set (Monitor, custom MCP tools, …) still shows a
  // hint instead of rendering as a bare name: the first non-empty string-valued input field.
  if (typeof cand !== "string" || !cand.trim()) {
    for (const [key, v] of Object.entries(input)) {
      if (typeof v === "string" && v.trim()) {
        // A generic tool's first string field is often itself a credential (`TOKEN: value`). Once
        // detached from its key, the value alone is no longer recognizable by key-based redaction.
        // Preserve the key only when doing so proves the value is sensitive; otherwise retain the
        // concise value-only detail used by existing cards.
        const keyed = redactToolPayload(`${key}=${v.trim()}`)
        cand = keyed.includes("[redacted]") || keyed.includes("[encrypted payload]") ? keyed : v
        break
      }
    }
  }
  if (typeof cand !== "string" || !cand.trim()) return undefined
  const s = redactToolPayload(cand.trim()).replace(/\s+/g, " ")
  // Generous cap: an 80-char cut ate file paths mid-word (and its "…" broke the client's path-link
  // detection). Display truncation is the CLIENT's job (CSS ellipsis over the card's full width).
  return s.length > 400 ? `${s.slice(0, 399)}…` : s
}

// A concise cause label for the turn-boundary line emitted when a background-shell completion wakes
// the agent: "Background task «<desc>» exited N" (failed, exit code parsed from the notification
// <summary>), "… finished" (completed), "… stopped" (killed), or "… timed out" (a Monitor that hit
// its timeout_ms — detected by the sentinel, since that record carries no status). `desc` prefers the Bash
// `description`, falling back to the command summary; kept short so the divider label stays tidy.
// The subject is the TASK, not the wake — the passive "Woken by …" spent the label's opening on the
// one fact the divider's own position already conveys. "Background task" is deliberate, and NOT
// "Agent": only a background SHELL reaches this label (an Agent completion carries its own divider
// text, built client-side from the `agentCompletion` call — see ChatView's AgentCompletionLine), so
// borrowing the Agent card's noun would mislabel every line it prints.
function backgroundWakeLabel(call: TranscriptToolCall, status: string, raw: string): string {
  const rawDesc = (call.desc ?? call.detail ?? "background command").trim()
  const desc = rawDesc.length > 64 ? `${rawDesc.slice(0, 63)}…` : rawDesc
  let outcome: string
  if (raw.includes("<event>[Monitor timed out")) outcome = "timed out"
  else if (status === "completed") outcome = "finished"
  else if (status === "killed") outcome = "stopped"
  else {
    const code = raw.match(/exit code (\d+)/)?.[1]
    outcome = code ? `exited ${code}` : "failed"
  }
  // A RECOVERED completion says so. The event is the same one either way, but "frizz had to carry this"
  // is the tell that the runtime dropped a notification (upstream anthropics/claude-code#20754) — and it
  // is the difference between a reader trusting the timeline and hunting a log for why the agent moved.
  const relayed = raw.includes(RELAYED_MARKER) ? " (completion relayed)" : ""
  return `Background task «${desc}» ${outcome}${relayed}`
}

// The same label for a wake with NO card to correlate to, built from the notification's own summary.
// Split from backgroundWakeLabel rather than folded into it because that one reads a TranscriptToolCall
// for its description and here there is, by definition, no call to read.
function uncorrelatedWakeLabel(rawDesc: string, status: string, raw: string): string {
  const desc = rawDesc.length > 64 ? `${rawDesc.slice(0, 63)}…` : rawDesc
  let outcome: string
  if (raw.includes("<event>[Monitor timed out")) outcome = "timed out"
  else if (status === "completed") outcome = "finished"
  else if (status === "killed") outcome = "stopped"
  else {
    const code = raw.match(/exit code (\d+)/)?.[1]
    outcome = code ? `exited ${code}` : "failed"
  }
  const relayed = raw.includes(RELAYED_MARKER) ? " (completion relayed)" : ""
  return `Background task «${desc}» ${outcome}${relayed}`
}

// The text carrier of a completion <task-notification>, mirroring the tailer's notificationText:
// notifications ride THREE record shapes and the timeline must read all of them, not just (a) —
// (a) queue-operation records with a top-level `content` string,
// (b) USER records whose message.content (string, or text blocks) embeds the XML (newer harness
//     versions emit this shape), and
// (c) `attachment` records (type:"queued_command") whose `attachment.prompt` carries it. (c) is
//     LOAD-BEARING for the mid-turn race: a shell completing MID-TURN gets its queue-operation (a)
//     flushed at a file position BEFORE its own launch record — folded first, it finds no registered
//     card and is lost — while the attachment is written inline AFTER the launch. Reading only (a)
//     left the card "running" forever even though the live chip retired (the tailer fixed the same
//     race on 2026-07-22).
function notificationCarrierText(rec: Raw): string | undefined {
  if (typeof rec.content === "string") return rec.content
  if (typeof rec.attachment?.prompt === "string") return rec.attachment.prompt
  const c = rec.message?.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    const text = c
      .map((b: Raw) => (b && typeof b === "object" && b.type === "text" ? String(b.text ?? "") : ""))
      .join("\n")
    return text || undefined
  }
  return undefined
}

// Completion <task-notification>s (see notificationCarrierText for the carriers). Terminal statuses:
// completed/failed/killed, `stopped` (the recovery notification a NEW session emits for background ops
// the previous process orphaned — the owning process is gone, so it is just as terminal; without it the
// orphans' cards stayed "running" forever after the live chips were recovered), and the status-less
// Monitor-timeout record. A non-terminal "running" ping and status-less Monitor progress events also
// exist and must retire nothing. Per terminal block, EVERY correlated op retires — a record can carry
// several blocks, and one recovery block names every orphan at once (tool-use-ids, task-ids, or both):
//   • A tracked AGENT dispatch → re-emit its call inline at the notification's position, flagged
//     `agentCompletion` so the client draws the centered wake divider (clickable into the run-log
//     drawer right there in the timeline), and back-fill the launch card.
//   • A tracked background SHELL → back-fill the shell card's terminal state AND emit a `boundary` event
//     line (the wake re-invoked the agent, opening a fresh turn that would otherwise merge visually).
// Empty when nothing correlates (an unrelated process, or an already-consumed child). Deletes each
// matched entry so a re-notify — the same completion arriving via two carriers — is a no-op.
function completionEvents(
  rec: Raw,
  dispatches: Map<string, { at?: string; call: TranscriptToolCall }>,
  backgroundShells: Map<string, { at?: string; call: TranscriptToolCall }>,
  backgroundTaskIds: Map<string, string>,
  relayedWakesDrawn: Set<string>,
  consumedShells: Map<string, { epoch: number; call: TranscriptToolCall }> = new Map(),
  restEpoch: { n: number } = { n: 0 },
): TranscriptMessage[] {
  const carrier = notificationCarrierText(rec)
  // A completion frizz REPAIRED arrives as prose, not as a notification (see relayNotificationBlock).
  // Translating it back here — rather than teaching this function a second shape — is what makes a
  // relayed completion project identically to a delivered one: same divider, same card back-fill, same
  // broken merge chain, all from the code below that already does it.
  // …and per SEGMENT, because a relay is one of the deliveries the runtime coalesces (splitWakeDeliveries):
  // `relayNotificationBlock` anchors its tag to the start of the text, so a relay merged UNDER another
  // delivery matched nothing and its divider was simply never drawn. Segments that are not relays are
  // rejoined untouched — the guard below still requires a real `<task-notification>`.
  const raw =
    carrier === undefined ? undefined : splitWakeDeliveries(carrier).map((s) => relayNotificationBlock(s) ?? s).join("\n")
  if (!raw || !raw.includes("<task-notification>")) return []
  const at = typeof rec.timestamp === "string" ? rec.timestamp : undefined
  const out: TranscriptMessage[] = []
  for (const block of raw.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    const rawStatus = block.match(/<status>([^<]*)<\/status>/)?.[1]
    // A Monitor that hits its timeout_ms emits ONE notification with NO <status> and NO <tool-use-id> —
    // only <task-id> + an <event> carrying the harness's timeout sentinel. Key STRICTLY on the sentinel:
    // ordinary Monitor progress events also have <event> and no <status>, so "missing status ⇒ terminal"
    // would retire every live monitor on its first event. The sentinel is harness prose and could drift —
    // same fragility as the launch-ack strings this parser already depends on.
    const timedOut = block.includes("<event>[Monitor timed out")
    const status =
      rawStatus === "completed" || rawStatus === "failed" || rawStatus === "killed"
        ? rawStatus
        : rawStatus === "stopped" || timedOut
          ? "killed"
          : undefined
    if (!status) continue
    const ids = new Set<string>()
    for (const m of block.matchAll(/<tool-use-id>([^<]*)<\/tool-use-id>/g)) ids.add(m[1])
    for (const m of block.matchAll(/<task-id>([^<]*)<\/task-id>/g)) {
      if (m[1].startsWith("__orphan_summary__")) continue // internal scan sentinel — correlates to nothing
      const toolUseId = backgroundTaskIds.get(m[1])
      if (toolUseId) ids.add(toolUseId)
    }
    // A RELAY that correlates to nothing still has to draw its divider, and this is the case that sent a
    // maintainer digging through server logs on 2026-08-05. An op adopted from an earlier process — or one
    // whose launch simply is not in this file — has no card here at all: the measured example's tool-use id
    // (`toolu_01CGAQsRn1rB5xjtNBNcWuKt`) appears ONLY in its own two queue-operation records, never as a
    // `tool_use` block. Correlation therefore cannot succeed, and both paths fall silent — so the ONE wake
    // the reader most needs explained is the one guaranteed to render as nothing.
    //
    // Scoped deliberately to relays. An uncorrelated notification on the DELIVERED path is usually an
    // unrelated process or an already-consumed child (see below), and drawing dividers for those would add
    // noise and risk double-rendering. A relay is different by construction: frizz only relays an op it was
    // tracking, and only after the agent came to rest without it — so it is always a real wake, and the
    // summary alone carries enough to name it.
    const relayedFallback = (): void => {
      if (!block.includes(RELAYED_MARKER)) return
      const relayId = block.match(/<task-id>([^<]*)<\/task-id>/)?.[1]?.trim()
      if (!relayId || relayedWakesDrawn.has(relayId)) return
      relayedWakesDrawn.add(relayId)
      const summary = block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim()
      if (!summary) return
      const desc = summary.match(/"([^"]+)"/)?.[1] ?? summary
      out.push({ role: "assistant", kind: "event", boundary: "wake", text: uncorrelatedWakeLabel(desc, status, block), tools: [], parts: [], at })
    }
    if (ids.size === 0) relayedFallback()
    for (const id of ids) {
      const d = dispatches.get(id)
      if (!d) {
        const shell = backgroundShells.get(id)
        if (!shell) {
          // ALREADY DRAWN — but a completion is delivered TWICE in the ordinary case: once while the
          // agent is still mid-turn (folded in at that position), and again afterwards as the thing that
          // actually RE-INVOKES it. De-duping the second is right only while the agent never stopped in
          // between; across a REST it deletes the one divider that explains why the thread started again.
          //
          // Measured on `investigate-nubjs-nub-642` (maintainer 2026-08-17: "the agent came to rest, but
          // then it starts up again, and I have no idea why. What restarted it? Kind of mysterious"):
          // shell `bfpp19dew` finished at 07:10:15 and drew its divider mid-turn; the agent rested at
          // 07:10:24.613; the SAME completion arrived again 46ms later and re-invoked it, and fell in
          // here — so the transcript read [rest] → [work] with nothing in between. The neighbouring rest
          // at 07:10:50 shows the correct shape, which is what made the gap look arbitrary.
          const drawn = consumedShells.get(id)
          if (drawn && restEpoch.n > drawn.epoch) {
            consumedShells.set(id, { epoch: restEpoch.n, call: drawn.call })
            out.push({ role: "assistant", kind: "event", boundary: "wake", text: backgroundWakeLabel(drawn.call, status, block), tools: [], parts: [], at })
            continue
          }
          relayedFallback()
          continue // an unrelated process, or a re-notify inside the same turn
        }
        backgroundShells.delete(id)
        consumedShells.set(id, { epoch: restEpoch.n, call: shell.call })
        const elapsedMs = elapsedBetween(shell.at, rec.timestamp)
        shell.call.status = status === "completed" ? "completed" : status === "killed" ? "cancelled" : "failed"
        if (elapsedMs !== undefined) shell.call.durationMs = elapsedMs
        // The shell's disclosure card already carries the terminal status above; but this notification
        // also RE-INVOKES the agent, opening a fresh turn with no boundary from the prior one — two turns
        // paint as one bubble. Emit a `boundary` event line at the wake point so the timeline shows a
        // divider carrying the cause ("Background task «…» exited N"). The caller resets lastAssistantId,
        // so this also breaks the assistant-record merge chain across the wake.
        out.push({ role: "assistant", kind: "event", boundary: "wake", text: backgroundWakeLabel(shell.call, status, block), tools: [], parts: [], at })
        continue
      }
      dispatches.delete(id)
      const start = d.at ? Date.parse(d.at) : NaN
      const end = at !== undefined ? Date.parse(at) : NaN
      const elapsedMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined
      d.call.agentStatus = status
      d.call.agentElapsedMs = elapsedMs
      d.call.status = status === "completed" ? "completed" : status === "killed" ? "cancelled" : "failed"
      if (elapsedMs !== undefined) d.call.durationMs = elapsedMs
      // Re-emit the dispatch's tool call inline at the completion point — now carrying its terminal
      // status + duration — so the finished agent is clickable into its run-log drawer RIGHT where it
      // landed in the timeline, not only up-thread at the launch card. A shallow copy keeps the two
      // out-entries from sharing one mutable object. `agentCompletion` marks THIS copy as the timeline
      // marker: the client renders it as the same centered wake divider a background shell's completion
      // emits above, instead of a second AgentBlock card indistinguishable from the launch one.
      const finishedCall: TranscriptToolCall = { ...d.call, agentCompletion: true }
      out.push({ role: "assistant", text: "", tools: [finishedCall], parts: [{ kind: "tools", tools: [finishedCall] }], at })
    }
  }
  return out
}

// ── Retained incremental parse cache ────────────────────────────────────────────────────────────────
// readTranscript is the hot path: the /ws producer calls it via readThreadTranscript on every tailer
// tick for every subscribed thread, and today it re-reads + re-parses the WHOLE JSONL from byte 0 each
// time. This LRU keeps the fold's closure state alive per file and feeds it only the bytes appended
// since the last read (the fold's in-place mutations back-fill earlier messages transparently). Bounded
// at 16 files. A file that shrank/rotated or whose identityPrefix changed drops its entry → full re-fold.
interface TranscriptCacheEntry {
  identityPrefix: string
  fold: TranscriptFold
  // File bytes handed to the decoder so far (the read cursor). Decoupled from fold.consumedBytes():
  // the StringDecoder may retain a torn trailing multibyte sequence across reads, so the fold can lag
  // this by a few bytes — but bytesRead is always the true file position we've consumed up to.
  bytesRead: number
  // Cross-read UTF-8 boundary safety: reading only [bytesRead, size) can slice a multibyte character;
  // the decoder emits complete characters and holds any incomplete trailing bytes for the next read.
  decoder: StringDecoder
  // dev:ino:birthtime — a rotation/replacement of the same path (unlink + recreate) invalidates the fold
  // even when the new file is the same size or larger.
  fileId: string
}
const TRANSCRIPT_CACHE_CAP = 16
const transcriptCache = new Map<string, TranscriptCacheEntry>()
// ~1/50 of cache-hit reads are re-parsed from scratch and deep-compared against the incremental result
// when FRIZZ_TRANSCRIPT_PARSE_VERIFY=1 — a loud, non-throwing correctness net for the appended-bytes fold.
const PARSE_VERIFY_SAMPLE = 1 / 50

/** Bytes decoded to a string at once. Any value well under Node's ~512MB string cap will do. */
const TRANSCRIPT_DECODE_WINDOW = 16 * 1024 * 1024

/**
 * Feed `[entry.bytesRead, to)` into the retained fold in BOUNDED WINDOWS.
 *
 * Both readers used to do one `decoder.write()` over the whole unread range. On a warm cache that is
 * a few KB and fine; on a COLD fold of a large transcript it is the entire file, and Node caps a
 * string at ~512MB — so a 566MB transcript threw ERR_STRING_TOO_LONG and readTranscript's
 * `catch { return [] }` (annotated for the transient "file not written yet" case) turned it into an
 * EMPTY CHAT, silently and permanently.
 *
 * Worse, `bytesRead` was advanced BEFORE the decode, so the throw left the shared cache entry parked
 * at EOF with an empty fold: every later call saw nothing left to read and returned nothing, in 0ms,
 * without touching the file. Measured on the real file — call #1 113ms, calls #2 and #3 0ms, all zero
 * messages, while a 68MB control returned 300.
 *
 * So: advance `bytesRead` only AFTER a window has been ingested. A partial failure then costs the
 * unread tail, not the whole thread. Windowing is safe without any line alignment because both layers
 * already handle their own boundaries — StringDecoder buffers a split UTF-8 sequence, and the fold
 * buffers a trailing partial LINE (see ingest: "preserved exactly across chunk boundaries").
 */
function ingestBounded(
  entry: { bytesRead: number; decoder: { write(buf: Buffer): string }; fold: { ingest(chunk: string): void } },
  to: number,
  read: (from: number, length: number) => Buffer,
): void {
  while (entry.bytesRead < to) {
    const buf = read(entry.bytesRead, Math.min(TRANSCRIPT_DECODE_WINDOW, to - entry.bytesRead))
    if (buf.length === 0) break
    const chunk = entry.decoder.write(buf)
    entry.bytesRead += buf.length
    if (chunk) entry.fold.ingest(chunk)
  }
}

function readAppendedBytes(fd: number, from: number, to: number): Buffer {
  const buf = Buffer.allocUnsafe(to - from)
  let filled = 0
  while (filled < buf.length) {
    const n = readSync(fd, buf, filled, buf.length - filled, from + filled)
    if (n === 0) break
    filled += n
  }
  return filled === buf.length ? buf : buf.subarray(0, filled)
}

// Resolve the retained fold for a file, dropping a stale entry first. Shared by BOTH readers of a claude
// JSONL — readTranscript (the /ws producer) and the paged reader's projectSnapshot — because they are
// provably the same fold: each derives its identityPrefix from the very id that NAMES the file
// (`claude:${id}` ↔ `.../${id}.jsonl`), so identityPrefix is a function of the path and one path-keyed
// entry serves both. Before this they kept SEPARATE caches and folded the same 30 MB twice on a cold
// drawer open — once for the RPC, once for the socket push — and retained two copies forever after.
function retainedFoldEntry(path: string, identityPrefix: string, fileId: string, size: number): { entry: TranscriptCacheEntry; hit: boolean } {
  let entry = transcriptCache.get(path)
  // Drop a stale entry: the file shrank (truncation), rotated (new inode), or is being parsed under a
  // different identity. Any of these means the retained fold no longer describes byte 0..size.
  if (entry && (entry.identityPrefix !== identityPrefix || entry.fileId !== fileId || size < entry.bytesRead)) {
    transcriptCache.delete(path)
    entry = undefined
  }
  const hit = entry !== undefined
  if (!entry) {
    entry = { identityPrefix, fold: createTranscriptFold(identityPrefix), bytesRead: 0, decoder: new StringDecoder("utf8"), fileId }
  } else {
    transcriptCache.delete(path) // LRU touch — re-insert to move to the most-recently-used end.
  }
  transcriptCache.set(path, entry)
  // Evict the least-recently-used entries beyond the cap (the first keys in insertion order).
  while (transcriptCache.size > TRANSCRIPT_CACHE_CAP) {
    const oldest = transcriptCache.keys().next().value
    if (oldest === undefined) break
    transcriptCache.delete(oldest)
  }
  return { entry, hit }
}

export function readTranscript(project: Project, sessionId: string): TranscriptMessage[] {
  const path = resolveTranscriptPath(project, sessionId)
  const identityPrefix = `claude:${sessionId}`
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const st = fstatSync(fd)
    const size = st.size
    const fileId = `${st.dev}:${st.ino}:${Math.trunc(st.birthtimeMs)}`

    const { entry, hit } = retainedFoldEntry(path, identityPrefix, fileId, size)

    ingestBounded(entry, size, (from, length) => readAppendedBytes(fd!, from, from + length))
    // size == bytesRead → no read, no ingest; the retained projection is already current.

    const messages = entry.fold.messages()
    if (hit && process.env.FRIZZ_TRANSCRIPT_PARSE_VERIFY === "1" && Math.random() < PARSE_VERIFY_SAMPLE) {
      verifyIncrementalParse(path, identityPrefix, messages)
    }
    // Defensive shallow slice: keeps per-message identity (all that matters downstream) while protecting
    // the RETAINED array from callers that append synthetic tail rows — projectDeliveryLedger pushes
    // queued bubbles into the array it's handed, which would otherwise pollute the fold across reads.
    // Same clock backstop as projectSnapshot: this is the other reader funnel (readThreadTranscript).
    return retireStaleQueuedBubbles([...messages])
  } catch {
    return [] // file not created yet (agent still booting) — the UI shows the spinner
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// Correctness net for the retained fold: re-parse the whole file from scratch and deep-compare (by JSON
// stringification) against the incremental result. Logs a loud structured line on divergence; NEVER
// throws — a false alarm from a mid-write torn read must not break the read path.
function verifyIncrementalParse(path: string, identityPrefix: string, incremental: TranscriptMessage[]): void {
  try {
    const fresh = parseTranscript(readFileSync(path, "utf8"), identityPrefix)
    const a = JSON.stringify(incremental)
    const b = JSON.stringify(fresh)
    if (a !== b) {
      console.error(
        JSON.stringify({
          event: "transcript_parse_divergence",
          path,
          identityPrefix,
          incrementalCount: incremental.length,
          freshCount: fresh.length,
          incrementalBytes: a.length,
          freshBytes: b.length,
        }),
      )
    }
  } catch {
    /* verification is best-effort — a read/parse error here must never affect the live read */
  }
}

// Test-only: drop the retained parse cache so a fresh read re-folds from byte 0. Exported for the
// incremental-parse tests; production never needs to clear it (LRU + identity/shrink invalidation cover
// every real case).
export function __clearTranscriptCacheForTests(): void {
  transcriptCache.clear()
}

// A thread slug that is ITSELF a session id — a FOREIGN thread (a maintainer terminal) has no registry
// row, and its thread id IS its session id. The regex admits only hex + dashes (a uuid shape), which
// forecloses path separators so the session-id join in readTranscript can't traverse out of the log dir.
export const FOREIGN_SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/

// The Claude Code per-project transcript dir: ~/.claude/projects/<cwdSlug>/. (Mirrors the tailer's.)
function logDirOf(project: Project): string {
  return join(homedir(), ".claude", "projects", project.cwdSlug)
}

// Where a session's transcript ACTUALLY is. The project's own log dir answers for every thread born
// under the project's current path; a thread born before the checkout was renamed or moved lives in the
// bucket for its ORIGINAL cwd and stays there forever, so the drawer has to follow it or it renders an
// empty conversation over a transcript that is right there on disk (see discover.ts). The miss path is
// the only one that pays a sweep, and a hit is memoized across the whole project.
//
// EVERY reader resolves through here, and that is the whole point. There are two producers of a rendered
// transcript — this file's whole-file reader (readTranscript → readThreadTranscript, which the /ws push
// and the drawer use) and the PAGED one below (sourceForThread → readLatestThreadTranscriptPage, which
// the `threadTranscript` RPC serves to the queue card and the standalone /full page). The paged one built
// `join(logDirOf(project), …)` by hand, so the rename recovery reached one producer and not the other:
// measured on this machine, 386 of 430 frizz threads returned messages through readThreadTranscript and
// an EMPTY page through the RPC, which is exactly the "No message yet." / "No conversation yet." the
// maintainer was looking at while the same thread's drawer rendered fine.
function resolveTranscriptPath(project: Project, sessionId: string): string {
  const path = join(logDirOf(project), `${sessionId}.jsonl`)
  try {
    if (statSync(path).size > 0) return path
  } catch {
    // absent — fall through to the cross-dir sweep
  }
  const stranded = discoverTranscriptDir(logDirOf(project), sessionId)
  return stranded ? join(stranded, `${sessionId}.jsonl`) : path
}

// ---- Codex rollout → renderable conversation ----
// Codex writes a DIFFERENT transcript schema than Claude: each rollout line is {timestamp,type,payload}
// (see ~/.codex/sessions/**/rollout-*.jsonl). The AUTHORITATIVE record→event mapping already lives in
// backend/codex.ts parseCodexLine — the SAME mapping the tailer folds for board telemetry — so we reuse
// it verbatim here; the drawer and the board can then never disagree about what a codex record means.
// This function GROUPS that normalized event stream into the TranscriptMessage[] the chat drawer
// renders: the codex analogue of parseTranscript. Event handling (see NormalizedEvent):
//   assistant-text → assistant prose (commentary + final_answer both render; final carries the fence)
//   tool-call      → a tool card (exec_command/shell → Bash; apply_patch → diff; else generic)
//   tool-result    → back-filled onto the matching call's `output` by call_id
//   user-message   → a human bubble (the first strips the dispatch scaffolding + discovery sentinel)
//   reasoning      → a standalone expandable "reasoning" message (codex's plaintext summary[])
//   agent-report   → a wake divider: the completion copy of the child's dispatch card (final), or the
//                    peer report line (mid-flight) — the same two the Claude path draws
//   turn-start     → ignored (a bracket, not content)
//   turn-end       → ignored unless it carries finalText no assistant-text already surfaced (defensive)
//   title          → ignored (board telemetry only)
// Same defensive posture as parseTranscript: a bad line → parseCodexLine [] → skipped, never throws.
export function projectCodexTranscript(raw: string, identityPrefix = "codex"): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  const dropCorrection = createCorrectionSink(out)
  // The open assistant message the current turn's text/tool events append to. A user turn closes it
  // (→ null) so the next assistant content starts a fresh message.
  let cur: TranscriptMessage | null = null
  // Tool calls awaiting their function_call_output, keyed by call_id — the codex analogue of pendingReads.
  type ShellOwner = { call: TranscriptToolCall; at?: string; background: boolean }
  const pendingCalls = new Map<string, {
    call: TranscriptToolCall
    at?: string
    owner?: ShellOwner
    interruptedOwner?: ShellOwner
    orphanPoll?: boolean
    explicitBackground?: boolean
  }>()
  // Codex yielded PTYs identify the real shell lifecycle by `session_id`, not by the wrapper call id.
  // Keep this map while projecting so later write_stdin polls back-fill the originating Bash card.
  const shellSessions = new Map<string, ShellOwner>()
  // Live `Spawn agent` cards by TASK NAME, so a child's later `agent-report` can find the dispatch that
  // launched it. The report names its sender by agent PATH ("/root/b14_launcher_bootstrap") and the
  // spawn by bare task name — the tail segment joins them, exactly as codex-subagents.ts's agentLabel
  // does. Latest-wins, which is also codex's own rule: it reuses a task name only once the previous
  // holder is gone. A REJECTED spawn is removed (see the tool-result arm) — it produced no child, so
  // nothing may ever correlate to it.
  const agentDispatches = new Map<string, { call: TranscriptToolCall; at?: string }>()
  // The last FINAL assistant text rendered, so a task_complete.last_agent_message that merely echoes it
  // isn't surfaced twice (the common case); a genuinely-different finalText is a defensive fallback.
  let lastFinalText: string | null = null
  // Whether the CURRENT turn already emitted a FINAL answer (agent_message/final_answer) — reset by
  // turn-start / a user turn. Gates the turn-end fallback: only a turn that produced NO final answer
  // falls back to task_complete.last_agent_message, so a commentary-only turn whose answer lives ONLY
  // on the bracket is still surfaced, while a normal turn's echoed answer never double-renders. Tracked
  // as a flag (not read off `cur`) because TS can't narrow the closure-mutated `cur`.
  let sawFinalAnswer = false
  // The CURRENT turn's reasoning block. Codex emits its reasoning as a SEQUENCE of `reasoning` records
  // across the turn (think → act → think → act), each a short summary step. We COALESCE them into one
  // expandable "train of thought" block per turn — appending each step to this message — so the reader
  // sees the whole chain in one place rather than scattered single-step teasers. Reset (→ null) at each
  // turn boundary (turn-start / a human turn) so the next turn opens a fresh block.
  let turnReasoning: TranscriptMessage | null = null
  // The most recent reasoning HEADER, waiting to caption the next tool card (see codexReasoningCaption).
  // Codex's exec_command carries no `description` field the way Claude's Bash does, so a codex tool card
  // could only ever be titled by its own flattened command. But codex thinks immediately before nearly
  // every call (30772 reasoning steps vs 29104 tool cards across 386 real rollouts — very close to 1:1),
  // and that step's bold header ("**Planning worktree inspection and commit**") is precisely the status
  // line its TUI prints above the command. Hand it to the card as `desc` and a codex transcript reads
  // like a Claude one, with the command still a click away in the card body. Consumed by the FIRST card
  // that follows, so a batch is captioned once rather than repeating the same line down the batch.
  let pendingCaption: string | undefined
  let lastProviderError: { fingerprint: string; message: TranscriptMessage } | undefined
  // Timestamp of the PREVIOUS event (any kind), so each reasoning step's THINKING time is its gap from
  // the event before it. Summed onto the turn's reasoning block as durationMs — a measurement nothing
  // renders any more (see TranscriptMessage.durationMs), kept because it costs nothing and is the only
  // place the number exists. Tool-EXECUTION time never lands here: it's the gap on a function_call_output,
  // not on a reasoning record, so it's excluded. The large idle between turns sits on a turn-start, also
  // excluded.
  let prevEventAt: string | undefined
  // Context-compaction bracket. Codex records the event but measures nothing, so the size of the loss
  // comes from the token_count readings on either side: `lastContextTokens` is the newest reading seen,
  // and a compaction divider stays in `openCompaction` only until the NEXT reading arrives (always the
  // very next telemetry record — 2282/2282 across the corpus) to be rewritten with the real bracket.
  let lastContextTokens: number | undefined
  let openCompaction: { message: TranscriptMessage; preTokens?: number } | null = null
  // A child's first inbound NEW_TASK is its original assignment; every later one is a follow-up.
  // Codex encrypts both payloads today, so sequence is the only honest distinction the projection can
  // make. The marker remains useful: it pins the arrival to the exact point in the child's timeline.
  let agentInstructionCount = 0
  // Codex may omit Frizz's requested first-final marker, then provide one on a later finalized
  // response. Strip an exact first-line marker from every final so a valid recovery signal never
  // leaks into rendered prose. Ordinary examples remain literal unless they occupy that control slot.

  const openAssistant = (at: string | undefined, sourceId: string, prose = false): TranscriptMessage => {
    // Each complete prose event starts a new message if this one already has prose. Keeping a turn in
    // `cur` makes its opening, intermediate captions and final answer one collapse anchor:
    // the queue can hide the tools, but none of the narration between them. Tool-only
    // batches still coalesce, and their first prose stays attached to the work it describes.
    if (prose && cur?.text) cur = null
    if (cur) return cur
    cur = { sourceId, role: "assistant", text: "", tools: [], parts: [], at }
    out.push(cur)
    return cur
  }

  let byteOffset = 0
  for (const line of raw.split("\n")) {
    const lineOffset = byteOffset
    byteOffset += Buffer.byteLength(line) + 1
    if (!line.trim()) continue
    let eventOrdinal = 0
    for (const ev of parseCodexLine(line)) {
      const sourceId = `${identityPrefix}:${lineOffset}:${eventOrdinal++}`
      switch (ev.kind) {
        case "provider-error": {
          const fingerprint = JSON.stringify({ ...ev.error, at: undefined })
          // Older journals can report the same failure separately and again on task_complete.
          if (fingerprint === lastProviderError?.fingerprint) {
            // The fold uses the terminal echo's timestamp. Keep the single visible card on that
            // same stamp, or the runtime-status fallback mistakes it for a different failure.
            lastProviderError.message.providerError = ev.error
            lastProviderError.message.at = ev.at
            break
          }
          cur = null
          turnReasoning = null
          const message: TranscriptMessage = { sourceId, role: "assistant", kind: "event", text: ev.error.message, providerError: ev.error, tools: [], parts: [], at: ev.at }
          lastProviderError = { fingerprint, message }
          out.push(message)
          break
        }
        case "assistant-text": {
          // New sessions send the invisible attribute comment in their first commentary message,
          // before any tool call. Strip that transport from every phase. Legacy H1/comment syntax is
          // final-only so normal commentary headings remain ordinary prose.
          let text = extractCodexFrizzTitle(ev.text, ev.final).text
          if (text) {
            const m = openAssistant(ev.at, sourceId, true)
            pushTextPart(m, text)
            m.text = m.text ? `${m.text}\n\n${text}` : text
          }
          if (ev.final) {
            lastFinalText = text
            sawFinalAnswer = true
          }
          break
        }
        case "tool-call": {
          const m = openAssistant(ev.at, sourceId)
          const call = codexToolCall(ev.name, ev.input, ev.id)
          call.status = "pending"
          // Caption this card with the thinking step that preceded it, unless the card already carries
          // a purpose-built title. Consumed either way: a poll folding into its owner must still spend
          // the caption, or a stale header would surface on some later, unrelated command.
          if (pendingCaption) {
            if (!call.desc) call.desc = pendingCaption
            pendingCaption = undefined
          }
          const isPoll = (call.name === "Poll process" || call.name === "Wait") && call.sessionId !== undefined
          const owner = isPoll ? shellSessions.get(runningKey(call.name, call.sessionId!)) : undefined
          const interruptedOwner = call.name === "Interrupt process" && call.sessionId !== undefined
            ? shellSessions.get(runningKey("Poll process", call.sessionId))
            : undefined
          // Polls are lifecycle updates, not independent shell work. An unpaired poll is marked UNKNOWN
          // so a partial/reloaded transcript never fabricates a completed command. That state does NOT
          // buy it a dedicated card — it launched nothing, so the client folds it into the ordinary
          // activity run (web/lib/toolActivity.orphanedPoll); only a real detached job keeps a card.
          if (!owner) {
            if (isPoll) call.backgroundState = "unknown"
            pushToolPart(m, call)
            m.tools.push(call)
          }
          if (call.name === "Spawn agent" && call.detail) agentDispatches.set(call.detail, { call, at: ev.at })
          if (ev.id) pendingCalls.set(ev.id, {
            call,
            at: ev.at,
            owner,
            interruptedOwner,
            orphanPoll: isPoll && !owner,
            explicitBackground: codexExplicitBackground(ev.name, ev.input),
          })
          break
        }
        case "tool-result": {
          const pending = ev.id ? pendingCalls.get(ev.id) : undefined
          if (!pending) break
          pendingCalls.delete(ev.id)
          const result = codexToolResult(ev.text)
          if (result.durationMs === undefined) result.durationMs = elapsedBetween(pending.at, ev.at)
          // A result that CARRIED a picture (an MCP `take_screenshot`) → decode the data URL to the
          // servable cache so the card shows the shot instead of the "[image output]" stand-in. Keyed on
          // the call id, so a re-projection on every poll short-circuits on existsSync. A failed/cancelled
          // call is skipped for the same reason the Claude path skips it: whatever it returned is not the
          // screenshot that was asked for.
          if (ev.image && result.status !== "failed" && result.status !== "cancelled") {
            const shot = persistDataUrlImage(ev.image, ev.id)
            if (shot) (pending.owner ?? pending).call.outputImage = shot
          }
          if (pending.owner) {
            // A known poll belongs to its originating exec_command disclosure. A PTY poll ends on an
            // explicit exit code; the older cell/wait generation instead says `Script completed`,
            // `Script failed`, or `Script terminated` with no numeric code. Either is terminal.
            const priorDuration = pending.owner.call.durationMs
            applyCodexToolResult(pending.owner.call, result)
            if (result.terminal !== true) {
              pending.owner.call.status = "pending"
              pending.owner.call.backgroundState = pending.owner.background ? "background" : undefined
            } else {
              shellSessions.delete(runningKey(pending.call.name, pending.call.sessionId!))
              const total = elapsedBetween(pending.owner.at, ev.at)
              // Transcript timestamps are sometimes coalesced by a rollout writer. Prefer a real
              // positive start→exit span; otherwise preserve the yielded result's own duration rather
              // than replacing it with a near-zero final poll wrapper duration.
              if (total !== undefined && total > 0) pending.owner.call.durationMs = total
              else if (priorDuration !== undefined) pending.owner.call.durationMs = priorDuration
            }
          } else if (pending.orphanPoll) {
            // No launch record to attach this poll to (history truncation/reload). Preserve the fact
            // that something may still exist, but never call that unknown process done.
            pending.call.status = "pending"
            pending.call.backgroundState = "unknown"
            if (result.output) pending.call.output = capRead(result.output)
          } else {
            applyCodexToolResult(pending.call, result)
            // A rejected spawn (the "agent thread limit reached" class) created no child, so retract it
            // from the correlation map — applyCodexToolResult has just cleared its drill-in id for the
            // same reason, and a later same-named report must not be attributed to a dispatch that
            // never ran.
            if (pending.call.name === "Spawn agent" && !pending.call.agentId && pending.call.detail) {
              if (agentDispatches.get(pending.call.detail)?.call === pending.call) agentDispatches.delete(pending.call.detail)
            }
            // Ctrl-C is a terminal lifecycle event for the command it targeted. The interrupt card
            // remains visible as the control action, while the command stops reading "running".
            if (pending.interruptedOwner && result.status !== "failed") {
              pending.interruptedOwner.call.status = "cancelled"
              shellSessions.delete(runningKey("Poll process", pending.call.sessionId!))
              const total = elapsedBetween(pending.interruptedOwner.at, ev.at)
              if (total !== undefined && total > 0) pending.interruptedOwner.call.durationMs = total
            }
            // Ctrl-C is a one-shot control action, never a detached process launch. Its receipt can
            // echo the target session id without meaning the interrupt itself remains live.
            if (pending.call.name !== "Interrupt process" && result.sessionId !== undefined && result.exitCode === undefined) {
              pending.call.sessionId = result.sessionId
              pending.call.status = "pending"
              pending.call.backgroundState = pending.explicitBackground ? "background" : undefined
              shellSessions.set(runningKey("Poll process", result.sessionId), {
                call: pending.call,
                at: pending.at,
                background: pending.explicitBackground === true,
              })
            }
            // The same shape one protocol generation earlier: a script that yielded announces
            // "Script running with cell ID N" and is polled by `wait` rather than by write_stdin.
            // Registered under its own key namespace because cell ids and PTY session ids are
            // independent counters that DO co-occur in one rollout — cell 49 is not session 49.
            if (result.cellId !== undefined && result.exitCode === undefined) {
              shellSessions.set(runningKey("Wait", result.cellId), {
                call: pending.call,
                at: pending.at,
                background: pending.explicitBackground === true,
              })
              pending.call.status = "pending"
              pending.call.backgroundState = pending.explicitBackground ? "background" : undefined
            }
          }
          break
        }
        case "reasoning": {
          // Codex's plaintext reasoning SUMMARY (summary[] of a rollout reasoning record). All of a
          // turn's reasoning steps COALESCE into one expandable block (turnReasoning): the first step
          // creates + positions the block at the top of the turn; each later step APPENDS to it, so the
          // reader gets the whole train of thought in one place. Null `cur` so the next assistant text/
          // tool opens a fresh message BELOW the reasoning row.
          const text = normalizeNewlines(ev.text).trim()
          if (text) {
            // This step's thinking time: its gap from the immediately-preceding event (clamped ≥0).
            const gap = prevEventAt && ev.at ? Date.parse(ev.at) - Date.parse(prevEventAt) : NaN
            const stepMs = Number.isFinite(gap) && gap > 0 ? gap : 0
            if (turnReasoning) {
              turnReasoning.text = `${turnReasoning.text}\n\n${text}`
              turnReasoning.durationMs = (turnReasoning.durationMs ?? 0) + stepMs
              // NO `cur = null` HERE. This step pushed nothing: it appended to a block already sitting
              // UPSTREAM in `out`, so closing the open assistant message cannot move any content below
              // anything — it only starts a second message that renders in the very same place.
              //
              // Codex thinks before nearly every tool call (~1:1 across the corpus), so nulling on the
              // append fragmented every batch into singletons. Measured on a real 17-child orchestration
              // rollout: 104 tool calls in 84 runs, 73 of them ONE call — a column of "Ran 1 tool call"
              // rows where the reader should see "Ran 9 tool calls" (maintainer 2026-09-04: "Tool call
              // collapsing is also totally broken"). Only the CREATE below closes the message, which is
              // the case the comment above was ever describing.
            } else {
              turnReasoning = { sourceId, role: "assistant", kind: "reasoning", text, tools: [], parts: [], at: ev.at, ...(stepMs ? { durationMs: stepMs } : {}) }
              out.push(turnReasoning)
              cur = null
            }
            pendingCaption = codexReasoningCaption(text) ?? pendingCaption
          }
          break
        }
        case "user-message": {
          cur = null // a human turn closes the assistant message and breaks the merge chain
          turnReasoning = null // …and starts a fresh reasoning block for the coming turn
          sawFinalAnswer = false
          let text = typeof ev.text === "string" ? normalizeNewlines(ev.text).trim() : ""
          // This must run before the general sentinel stripper: the strict complete suffix proves the
          // title reminder was Frizz's append, rather than similarly-worded task prose.
          if (out.length === 0) text = stripCodexFirstPromptTitleTransport(text)
          text = stripCodexSentinel(text)
          if (!text || isAllInjectedNoise(text)) break
          // The first user message is the composed dispatch prompt (orientation + banner + TASK +
          // sentinel). Only what sits below the banner is the human's words, and — as in parseTranscript
          // — that narrowing is a DISPLAY projection, so the stored text keeps the machine-facing prompt.
          if (text) pushUserRecord(out, sourceId, text, ev.at, dropCorrection)
          break
        }
        case "agent-report": {
          // A CHILD reporting upward. Both shapes render as the wake dividers the Claude path already
          // draws, because they are the same two events: a sub-agent finishing, and a sub-agent
          // reporting mid-flight. Both CLOSE the open assistant message, for the reason the compaction
          // arm below closes it: the divider is pushed at this position in `out`, so text the parent
          // writes afterwards must start a NEW message — appending it to `cur` would render it above a
          // divider it happened after.
          cur = null
          turnReasoning = null
          const label = ev.author.split("/").filter(Boolean).pop() ?? ev.author
          const dispatch = agentDispatches.get(label)
          if (ev.final) {
            // The child's terminal return. Re-emit its dispatch card at THIS position, flagged
            // `agentCompletion`, so the client draws the centred "Sub-agent «…» completed" divider
            // clickable into the finished child's run log — exactly what completionEvents does for a
            // Claude <task-notification>. The launch card keeps its own state; this is a copy.
            // With no dispatch to copy (the launch scrolled out of a resumed rollout) there is no card
            // to clone and nothing renders — the same degradation completionEvents takes.
            // The dispatch deliberately STAYS in the map. A child that is warm-resumed (`followup_task`)
            // finishes again and sends a second FINAL_ANSWER, which is a real second completion — the
            // tailer's tracker resurrects and re-retires that same child under the same dispatch id.
            // Consuming the entry would silence every round after the first (122 of 263 in the
            // reference rollout) and orphan the later reports' drill-in link.
            if (!dispatch) break
            const elapsedMs = elapsedBetween(dispatch.at, ev.at)
            dispatch.call.agentStatus = "completed"
            if (elapsedMs !== undefined) {
              dispatch.call.agentElapsedMs = elapsedMs
              dispatch.call.durationMs = elapsedMs
            }
            const finished: TranscriptToolCall = { ...dispatch.call, agentCompletion: true }
            out.push({ sourceId, role: "assistant", text: "", tools: [finished], parts: [{ kind: "tools", tools: [finished] }], at: ev.at })
            break
          }
          // A mid-flight progress report. `peerFrom` + `peerDispatchId` are precisely the pair the
          // client's SubAgentReportLine consumes; the id is the DISPATCH call_id (what a drawer
          // resolves), never the child's own path. The body rides `text`/`displayText` so the drawer
          // and search keep it, while the line itself renders no excerpt of it by design.
          out.push({
            sourceId,
            role: "user",
            text: ev.text,
            displayText: ev.text,
            peerFrom: label,
            ...(dispatch?.call.agentId ? { peerDispatchId: dispatch.call.agentId } : {}),
            tools: [],
            parts: [],
            at: ev.at,
          })
          break
        }
        case "agent-instruction": {
          cur = null
          turnReasoning = null
          const first = agentInstructionCount++ === 0
          const text = ev.text || (ev.encrypted
            ? `${first ? "Task" : "Follow-up"} instructions received. Codex encrypted the message body, so Frizz can't display it.`
            : `${first ? "Task" : "Follow-up"} instructions received.`)
          out.push({
            sourceId,
            role: "user",
            text,
            displayText: text,
            agentInstruction: true,
            tools: [],
            parts: [{ kind: "text", text }],
            at: ev.at,
          })
          break
        }
        case "compaction": {
          // Everything above left the model's context. Emitted as the SAME boundary divider claude's
          // compaction uses, so one affordance means one thing in both providers' transcripts. Closing
          // `cur`/`turnReasoning` matters here: compaction lands MID-turn, and without it the turn's
          // later text and reasoning steps would keep appending to blocks that now sit ABOVE the
          // divider — content rendered on the wrong side of the boundary it happened after.
          const m = compactionMessage(sourceId, ev.at, lastContextTokens, undefined)
          out.push(m)
          openCompaction = { message: m, preTokens: lastContextTokens }
          cur = null
          turnReasoning = null
          break
        }
        case "context-usage": {
          // The first reading AFTER a compaction is its post-size — rewrite the divider in place with the
          // real bracket. Ordinary readings just advance the running context size for the next compaction.
          if (openCompaction) {
            openCompaction.message.text = compactionLabel(openCompaction.preTokens, ev.tokens)
            openCompaction = null
          }
          lastContextTokens = ev.tokens
          break
        }
        case "turn-start":
          lastProviderError = undefined
          sawFinalAnswer = false // a fresh turn opens; a later final_answer sets this
          turnReasoning = null // …and its reasoning steps coalesce into a new block
          break
        case "turn-end": {
          // Defensive: a turn that produced NO final_answer but whose task_complete carried a distinct
          // last_agent_message still surfaces it (commentary-only turns). The lastFinalText dedupe keeps
          // the ordinary case — where final_answer already rendered the identical text — from doubling.
          let finalText = ev.finalText
          if (finalText !== undefined) finalText = extractCodexFrizzTitle(finalText).text
          const ft = finalText?.trim()
          if (ft && !sawFinalAnswer && ft !== lastFinalText?.trim()) {
            const m = openAssistant(ev.at, sourceId, true)
            pushTextPart(m, finalText!)
            m.text = m.text ? `${m.text}\n\n${finalText!}` : finalText!
            sawFinalAnswer = true
          }
          // The turn is bracketed — the agent came to rest. Codex needs no deferral the way the claude
          // fold does: task_complete/turn_aborted is a single record arriving strictly AFTER the turn's
          // content, so the divider goes in where it is seen. It also closes `cur`, so the next turn
          // opens a fresh bubble BELOW the rule rather than appending above it — until now only a human
          // message closed one, which is why two back-to-back codex turns painted as a single bubble.
          //
          // Guarded on there being something to close: an empty replay, or a second bracket for a turn
          // already marked (turn_aborted can follow task_complete), must not stack rules on rules.
          const prev = out.length > 0 ? out[out.length - 1] : undefined
          if (prev && prev.boundary !== "rest") {
            out.push(restMessage(`${sourceId}#rest`, ev.at))
            cur = null
          }
          break
        }
        // title: sidecar, not renderable content.
        default:
          break
      }
      // Advance the previous-event clock for the NEXT reasoning step's thinking-gap measurement.
      // `context-usage` is excluded deliberately: it is bookkeeping emitted at the same instant as the
      // response it accounts for, so letting it start the clock would silently shorten every measured
      // thinking window that happened to have a token_count in front of it.
      if ("at" in ev && typeof ev.at === "string" && ev.kind !== "context-usage") prevEventAt = ev.at
    }
  }

  return out
}

export function parseCodexTranscript(raw: string, identityPrefix = "codex"): TranscriptMessage[] {
  const out = projectCodexTranscript(raw, identityPrefix)
  return latestTranscriptWindow(out)
}

const MAX_PINNED_BACKGROUND_OPERATIONS = 128

// Keep unresolved shells visible after their launch message scrolls beyond the normal latest window.
// This is the reload/restart contract: the projector rebuilt the shellSessions lifecycle from the full
// rollout, so slicing away the still-pending launch card at the very end discarded known live state.
// Pin a tools-only projection at the tail, adjacent to the composer: putting it at the historical head
// would leave it above the queue card's most-recent-user window and therefore still invisible. The
// paginated history carries the canonical message and the client replaces this synthetic card when
// that page is loaded.
// Where the latest window BEGINS: the last MAX_MESSAGES, pulled further back when that cut would land
// past the human's own last message.
//
// The queue card anchors itself on that message (`lastUserIdx` in TodosView) and shows everything after
// it, so a window that does not contain it leaves the card with nothing to anchor on — it falls back to
// the window head and opens mid-turn, on an assistant sentence answering a question the reader can no
// longer see. That is exactly what the maintainer has now objected to twice (2026-08-12: "queue cards
// STILL need to go all the way back to the last user message"; 2026-08-18 on a `nub` card that opened on
// "It replaced a generic 'keep going' stop-hook prompt"). The EARLIER-page reader has always had this
// boundary rule (pageProjectedTranscript); the latest reader was a blind `slice(-MAX_MESSAGES)`, so the
// two disagreed about where a turn starts and only the paginated one was right.
//
// `role === "user"` alone is not the human — the same trap pageProjectedTranscript documents. Frizz
// writes as the user (Goal delivery, sign-off reminder, watcher wake), all carrying `wake`; a queued
// send has not been delivered; and `agentInstruction` is a coordinator/peer speaking into a CHILD's
// user side. The measured card had 14 user records in its window and 13 of them were Frizz's own; the
// human's ask sat 13 messages above the head.
//
// THE REACH IS ALL-OR-NOTHING. A partial extension buys no anchor and still ships the extra megabyte, so
// when the ask is further back than one earlier page's allowance the window stays exactly where it was
// and "Load earlier messages" remains the route to it.
export function latestWindowStart(messages: readonly TranscriptMessage[]): number {
  const tail = Math.max(0, messages.length - MAX_MESSAGES)
  if (tail === 0) return 0
  let boundary = -1
  for (let i = tail - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user" && !m.wake && !m.queued && !m.agentInstruction) {
      boundary = i
      break
    }
  }
  if (boundary < 0) return tail
  let start = tail
  let bytes = 0
  while (start > boundary && tail - start < LATEST_WINDOW_ASK_REACH_ITEMS) {
    const nextBytes = messageBytes(messages[start - 1])
    if (bytes + nextBytes > LATEST_WINDOW_ASK_REACH_BYTES) break
    start--
    bytes += nextBytes
  }
  return start === boundary ? start : tail
}

export function latestTranscriptWindow(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  const start = latestWindowStart(messages)
  if (start === 0) return [...messages]
  // A parent's "Steered" / "Followed up" divider deliberately carries no body and tells the reader to
  // open the child's drawer. That contract fails if the child's 300-message tail has since moved past
  // the input: the link opens successfully but the promised message is gone. Keep every earlier
  // instruction as a small chronological prefix. Codex bodies are encrypted markers (4258 observed,
  // max 236 in one rollout); Claude's plaintext bodies are rarer (207 observed, max 24), so this stays
  // far smaller than returning a whole 129 MB child rollout while making every steer reachable.
  const earlierInstructions = messages.slice(0, start).filter((message) => message.agentInstruction)
  const pinned: TranscriptMessage[] = []
  for (let i = 0; i < start; i++) {
    const message = messages[i]
    if (!message.sourceId) continue
    const tools = message.tools.filter(
      (call) => call.status === "pending" && call.backgroundState === "background",
    )
    if (tools.length === 0) continue
    pinned.push({
      sourceId: `pinned-bg:${createHash("sha256").update(message.sourceId).digest("base64url").slice(0, 24)}`,
      pinnedFromSourceId: message.sourceId,
      role: "assistant",
      text: "",
      tools,
      parts: [{ kind: "tools", tools }],
      at: message.at,
    })
  }
  return [...earlierInstructions, ...messages.slice(start), ...pinned.slice(-MAX_PINNED_BACKGROUND_OPERATIONS)]
}

// Codex currently has two tool protocols: legacy function_call records and the unified custom exec
// wrapper whose raw JavaScript invokes tools.exec_command, tools.apply_patch, tools.update_plan, etc.
// Decode only static strings/structure from that wrapper (never evaluate it), then normalize both
// protocols onto the same Bash/Edit/generic card family. Unknown calls retain capped input, so the
// renderer always has something more useful than a bare tool name.
function codexToolCall(name: string, input: unknown, callId?: string): TranscriptToolCall {
  if (name === "exec" && typeof input === "string") return codexExecWrapperCall(input, callId)

  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const direct = codexDirectToolCall(name, obj, callId)
  if (direct) return direct
  const cmd = extractShellCommand(obj)
  if (cmd) {
    const cwd = strField(obj.workdir) ?? strField(obj.cwd)
    return { name: "Bash", detail: bashSummary(cmd), command: capCommand(cmd), cwd }
  }
  const patch = name === "apply_patch" || name === "patch" ? extractPatch(input, obj) : undefined
  if (patch) {
    const edit = parseApplyPatch(patch)
    if (edit) return { name: "Edit", detail: edit.file, edit, input: capToolInput(patch) }
    return { name: "Edit", detail: patchSummary(patch), input: capToolInput(patch) }
  }
  return {
    name: name && name.trim() ? codexToolLabel(redactToolPayload(name.trim())) : "tool",
    detail: toolDetail(input),
    input: renderToolInput(input),
  }
}

function codexDirectToolCall(name: string, obj: Record<string, unknown>, callId?: string): TranscriptToolCall | undefined {
  const target = strField(obj.target)
  switch (name) {
    case "spawn_agent":
      // The dispatch call_id is the SAME key the tailer tracks this child under (it is
      // sub_agent_activity's `event_id`), so handing it over as `agentId` makes the card a drill-in
      // AgentBlock — click through to the child's own transcript. Codex encrypts the dispatch
      // `message`, so unlike a Claude Agent block there is NO prompt to expand; the model+effort cell
      // rides `subagentType` and the tool input keeps the fork/service details.
      return {
        name: "Spawn agent",
        detail: strField(obj.task_name) ?? "sub-agent",
        subagentType: codexAgentCell(obj),
        agentId: callId,
        input: compactFields(obj, ["agent_type", "fork_context", "fork_turns", "service_tier"]),
      }
    case "send_message":
      return codexPeerMessageCall("Send message", target, obj)
    case "followup_task":
      return codexPeerMessageCall("Follow up", target, obj)
    case "write_stdin": {
      // Codex's unified exec drives a yielded PTY through write_stdin — but the overwhelming majority
      // of these calls send `chars: ""` purely to POLL for more output (4551/4695 = 96.9% across 386
      // real rollouts). The WRAPPER protocol already normalizes them (codexExecWrapperCall below), but
      // without the same case here the DIRECT function_call form fell through to codexToolCall's
      // generic tail and rendered as its own card literally named `write_stdin` — 4706 of them, the
      // second most common card in the whole corpus, and one long-running command alone minted 153.
      // Normalizing onto the same shape lets projectCodexTranscript's poll fold-in (which keys on
      // "Poll process" + sessionId) collapse them into the originating Bash card for BOTH protocols.
      const sessionId = typeof obj.session_id === "number" || typeof obj.session_id === "string" ? obj.session_id : undefined
      const chars = typeof obj.chars === "string" ? obj.chars : undefined
      const isPoll = chars === "" || chars === undefined
      const isInterrupt = chars === "\u0003"
      return {
        name: isPoll ? "Poll process" : isInterrupt ? "Interrupt process" : "Write stdin",
        detail: sessionId !== undefined ? `session ${sessionId}` : "running process",
        input: isPoll ? undefined : capToolInput(isInterrupt ? "Ctrl-C" : chars!),
        sessionId,
      }
    }
    case "update_plan": {
      // Codex's to-do list. The direct function_call form ships real JSON, so the plan is already an
      // array of objects here; the JS-wrapper form goes through codexExecWrapperCall's scanner instead.
      const rows = todoRows(obj.plan)
      const explanation = strField(obj.explanation)
      if (rows) return wholeListTodoCall("Todos", rows, explanation ? capToolInput(explanation) : undefined)
      return undefined
    }
    case "list_agents":
      return { name: "Agents", detail: "list live agents" }
    case "interrupt_agent":
      return { name: "Interrupt", detail: target }
    case "wait_agent": {
      const ms = typeof obj.timeout_ms === "number" ? obj.timeout_ms : undefined
      return { name: "Wait for agents", detail: ms !== undefined ? `up to ${formatCompactDuration(ms)}` : "mailbox update" }
    }
    case "wait": {
      // Carries the cell id as `sessionId` so the poll fold-in can find its owning script, exactly as a
      // write_stdin poll carries the PTY session id. runningKey keeps the two id spaces apart.
      const cell = typeof obj.cell_id === "number" || typeof obj.cell_id === "string" ? obj.cell_id : undefined
      return { name: "Wait", detail: cell !== undefined ? `cell ${cell}` : "running tool", sessionId: cell }
    }
    case "view_image": {
      // Without this case a direct view_image function_call fell to the generic branch: the raw
      // snake_case name, no picture, and — because codexResultSummary suppresses the placeholder only
      // for the "View image" label — a card whose whole body was the literal text "[image output]".
      const path = strField(obj.path) ?? strField(obj.file_path)
      return viewImageCall(path, callId ?? path)
    }
    case "take_screenshot": {
      // The chrome-devtools MCP shot. Its picture normally arrives INLINE on the result (an
      // `input_image` data URL, decoded in the tool-result branch of projectCodexTranscript) — this case
      // exists for the header, which the generic branch rendered as `take_screenshot  png`: `toolDetail`
      // has no case for these args, so its first-string-field fallback picked `format`, captioning every
      // shot with its file extension. Say what was actually captured instead.
      const filePath = strField(obj.filePath) ?? strField(obj.file_path) ?? strField(obj.path)
      const detail = filePath ? redactToolPayload(filePath) : obj.fullPage === true ? "full page" : "viewport"
      // The `--filePath` variant writes to DISK and returns no inline image. Copy it in the same way a
      // view_image call is copied, so that shape renders too; a missing/denied path just yields undefined
      // and the inline decode (when there is one) overwrites this at result time either way.
      const fromDisk = filePath ? persistSentFile(filePath, callId ?? filePath) : undefined
      return { name: "Screenshot", detail, ...(fromDisk ? { outputImage: fromDisk } : {}) }
    }
    default:
      return undefined
  }
}

// Key for the live-process registry. Codex has two independent generations of yielded execution — a
// PTY `session_id` polled by write_stdin, and a script `cell_id` polled by `wait` — whose id counters
// are unrelated and which appear together in the same rollout, so "cell 49" must never resolve to
// "session 49". The poll card's own name is what says which registry it is asking about.
function runningKey(pollName: string, id: string | number): string {
  return `${pollName === "Wait" ? "cell" : "pty"}:${id}`
}

// A yielded process is not automatically a background operation. Ordinary foreground commands yield
// a session/cell handle whenever they outlive one tool-call budget; the caller still owns and polls
// them inline. The unified exec protocol's deliberate background handoff is explicit: it calls
// `yield_control()` before awaiting the process. Keep that distinction structural (outside strings and
// comments), so a command which merely prints or documents `yield_control()` is never misclassified.
function codexExplicitBackground(name: string, input: unknown): boolean {
  return name === "exec" && typeof input === "string" && hasExecutableCall(input, "yield_control")
}

function hasExecutableCall(source: string, name: string): boolean {
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === "\"" || c === "'" || c.charCodeAt(0) === 96) {
      i = skipJsString(source, i)
      continue
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2)
      if (end === -1) return false
      i = end
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      if (end === -1) return false
      i = end + 1
      continue
    }
    if (!source.startsWith(name, i)) continue
    const before = source[i - 1]
    const after = source[i + name.length]
    if ((before && /[\w$]/.test(before)) || (after && /[\w$]/.test(after))) continue
    let cursor = i + name.length
    while (/\s/.test(source[cursor] ?? "")) cursor++
    if (source[cursor] === "(") return true
  }
  return false
}

// The one-line caption a codex reasoning step offers the tool card that follows it. Codex writes its
// summary as markdown bold headers — 30752 of 30772 summary blocks across 386 real rollouts are header
// lines and nothing else — so the LAST header in the step is the thought immediately preceding the call.
// Returns undefined for a step that is plain prose (the 0.1% case), leaving the previous caption in
// place rather than titling a command with a half-sentence of narration.
function codexReasoningCaption(text: string): string | undefined {
  let caption: string | undefined
  for (const line of text.split("\n")) {
    const m = /^\s*\*\*(.+?)\*\*\s*$/.exec(line)
    if (m) caption = m[1].trim()
  }
  return caption && caption.length <= CAPTION_MAX ? caption : undefined
}
// A caption replaces the command summary in the card header, so an over-long one would push the
// command out of view entirely. Codex headers run ~30-60 chars; anything past this is not a header.
const CAPTION_MAX = 120

// Codex's peer-messaging tools (`send_message` steers a live sub-agent; `followup_task` queues more
// work onto one). Both used to render as a bare `{name, detail: target}` generic card — a row that
// named the recipient and showed NOTHING of what was said, which is exactly why the maintainer could
// not tell what a "FOLLOW UP" card had done. Promote them onto the same SendMessageCard family Claude's
// SendMessage uses, so the verb leads and the body is expandable.
//
// The body is usually unrecoverable: codex Fernet-encrypts inter-agent `message` payloads (821/821
// across 386 real rollouts — send_message, followup_task AND spawn_agent alike), and the tool's own
// result is an empty string, so there is no plaintext anywhere in the parent transcript to render.
// Say so IN the card rather than leaving an empty row that reads like a frizz bug. A message that does
// arrive in the clear (older/unencrypted codex builds) still renders verbatim.
function codexPeerMessageCall(label: string, target: string | undefined, obj: Record<string, unknown>): TranscriptToolCall {
  // strField has ALREADY run redactToolPayload, so an encrypted body arrives here as the redaction
  // marker, never as the raw Fernet token. Detect that marker rather than re-testing the token shape:
  // one authority decides what "encrypted" looks like, so this can't drift out of step with it.
  const redacted = strField(obj.message)
  const encrypted = redacted === ENCRYPTED_PAYLOAD
  const body = !redacted
    ? undefined
    : encrypted
      ? "_Codex encrypts inter-agent message bodies — the text is not recoverable from the rollout. The recipient's transcript marks when it arrived, but can't display the encrypted text._"
      : capToolInput(redacted)
  return {
    name: label,
    detail: target,
    sendTo: target,
    sendSummary: target,
    ...(body ? { sendBody: body } : {}),
    // Drives the card's verb. "Steered" (the SendMessage default) is wrong for a queued follow-up.
    ...(label === "Follow up" ? { sendType: "codex_followup" } : {}),
  }
}

// A codex dispatch's model+effort cell ("gpt-5.6-terra/high"), the analogue of a Claude dispatch's
// `subagent_type` tag. Matches the label codex-subagents.ts puts on the live tracked entry.
function codexAgentCell(obj: Record<string, unknown>): string | undefined {
  const model = strField(obj.model)
  const effort = strField(obj.reasoning_effort)
  return model && effort ? `${model}/${effort}` : (model ?? effort)
}

function compactFields(obj: Record<string, unknown>, keys: string[]): string | undefined {
  const projected: Record<string, unknown> = {}
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") projected[key] = value
  }
  return Object.keys(projected).length ? renderToolInput(projected) : undefined
}

// The house duration grammar (`packages/web/src/lib/durationLabels.ts`), including its hour rung: a
// flat-minutes reading of a long wait renders as a small capital M on the card's petite-caps meta line
// and reads as a count rather than a duration.
function formatCompactDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 60)}h`
}

interface WrappedInvocation {
  name: string
  args: string
}

function codexExecWrapperCall(source: string, callId?: string): TranscriptToolCall {
  const calls = wrappedInvocations(source)
  if (calls.length !== 1) {
    return {
      name: "Exec",
      detail: calls.length ? wrappedRunSummary(calls) : bashSummary(source),
      input: capToolInput(source.trim()),
    }
  }

  const call = calls[0]
  if (call.name === "exec_command") {
    const cmd = jsStringProperty(call.args, "cmd") ?? jsStringProperty(call.args, "command")
    const cwd = jsStringProperty(call.args, "workdir") ?? jsStringProperty(call.args, "cwd")
    if (cmd) return { name: "Bash", detail: bashSummary(cmd), command: capCommand(cmd), cwd }
  }

  if (call.name === "apply_patch") {
    const patch = wrappedPatch(source, call.args)
    if (patch) {
      const edit = parseApplyPatch(patch)
      if (edit) return { name: "Edit", detail: edit.file, edit, input: capToolInput(patch) }
      return { name: "Edit", detail: patchSummary(patch), input: capToolInput(patch) }
    }
  }

  if (call.name === "update_plan") {
    const rows = wrappedPlanRows(call.args)
    if (rows.length) {
      const explanation = jsStringProperty(call.args, "explanation")
      return wholeListTodoCall("Todos", rows, explanation ? capToolInput(redactToolPayload(explanation)) : undefined)
    }
    return { name: "Todos", detail: planSummary(call.args), input: capToolInput(call.args) }
  }

  if (call.name === "write_stdin") {
    const sessionId = jsNumberProperty(call.args, "session_id")
    const chars = jsStringProperty(call.args, "chars")
    const isPoll = chars === "" || chars === undefined
    const isInterrupt = chars === "\u0003"
    return {
      name: isPoll ? "Poll process" : isInterrupt ? "Interrupt process" : "Write stdin",
      detail: sessionId !== undefined ? `session ${sessionId}` : "running process",
      input: !isPoll ? capToolInput(isInterrupt ? "Ctrl-C" : chars!) : undefined,
      sessionId,
    }
  }

  if (call.name === "view_image") {
    const path = jsStringProperty(call.args, "path")
    return viewImageCall(path, callId ?? path)
  }

  if (call.name === "web__run") return wrappedWebCall(call.args)

  return {
    name: wrappedToolLabel(call.name),
    detail: wrappedArgumentDetail(call.args),
    input: capToolInput(call.args || source.trim()),
  }
}

// Find direct tools.name(...) invocations while respecting strings, comments, and balanced parens.
// This is intentionally a tiny structural scanner, not a JavaScript evaluator.
function wrappedInvocations(source: string): WrappedInvocation[] {
  const out: WrappedInvocation[] = []
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === "\"" || c === "'" || c.charCodeAt(0) === 96) {
      i = skipJsString(source, i)
      continue
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2)
      if (end === -1) break
      i = end
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      if (end === -1) break
      i = end + 1
      continue
    }
    if (!source.startsWith("tools.", i) || (i > 0 && /[\w$.]/.test(source[i - 1]))) continue
    const nameStart = i + "tools.".length
    const nameMatch = source.slice(nameStart).match(/^([A-Za-z_$][\w$]*)/)
    if (!nameMatch) continue
    const name = nameMatch[1]
    let open = nameStart + name.length
    while (/\s/.test(source[open] ?? "")) open++
    if (source[open] !== "(") continue
    const close = matchingParen(source, open)
    if (close === -1) break
    out.push({ name, args: source.slice(open + 1, close).trim() })
    i = close
  }
  return out
}

function matchingParen(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (c === "\"" || c === "'" || c.charCodeAt(0) === 96) {
      i = skipJsString(source, i)
      continue
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2)
      if (end === -1) return -1
      i = end
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      if (end === -1) return -1
      i = end + 1
      continue
    }
    if (c === "(") depth++
    else if (c === ")" && --depth === 0) return i
  }
  return -1
}

function skipJsString(source: string, start: number): number {
  const quote = source[start]
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++
    else if (source[i] === quote) return i
  }
  return source.length - 1
}

function readJsString(source: string, start: number): { value: string; end: number } | undefined {
  const quote = source[start]
  if (quote !== "\"" && quote !== "'" && quote.charCodeAt(0) !== 96) return undefined
  const end = skipJsString(source, start)
  if (end <= start || source[end] !== quote) return undefined
  const raw = source.slice(start + 1, end)
  let value = ""
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      value += raw[i]
      continue
    }
    const n = raw[++i]
    if (n === undefined) {
      value += "\\"
      break
    }
    if (n === "n") value += "\n"
    else if (n === "r") value += "\r"
    else if (n === "t") value += "\t"
    else if (n === "b") value += "\b"
    else if (n === "f") value += "\f"
    else if (n === "v") value += "\v"
    else if (n === "0") value += "\0"
    else if (n === "\n" || n === "\r") {
      if (n === "\r" && raw[i + 1] === "\n") i++
    } else if (n === "x" && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))) {
      value += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 3), 16))
      i += 2
    } else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) {
      value += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16))
      i += 4
    } else value += n
  }
  return { value, end }
}

function jsStringProperty(source: string, key: string): string | undefined {
  const re = new RegExp("(?:[\\\"']?" + key + "[\\\"']?)\\s*:\\s*", "g")
  const m = re.exec(source)
  if (!m) return undefined
  return readJsString(source, re.lastIndex)?.value
}

function jsNumberProperty(source: string, key: string): number | undefined {
  const re = new RegExp("(?:[\\\"']?" + key + "[\\\"']?)\\s*:\\s*(-?\\d+(?:\\.\\d+)?)")
  const raw = re.exec(source)?.[1]
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function wrappedStringBindings(source: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    const parsed = readJsString(source, re.lastIndex)
    if (parsed) out.set(m[1], parsed.value)
  }
  return out
}

function wrappedPatch(source: string, args: string): string | undefined {
  const direct = readJsString(args, 0)?.value
  if (direct?.includes("Begin Patch")) return direct
  const id = args.match(/^([A-Za-z_$][\w$]*)\b/)?.[1]
  const bound = id ? wrappedStringBindings(source).get(id) : undefined
  return bound?.includes("Begin Patch") ? bound : undefined
}

// The plan rows out of a JS-WRAPPER `tools.update_plan({plan:[{step:"…",status:"…"}]})` argument list.
// That source is a JavaScript object literal, not JSON — codex mixes quoted and bare keys in the SAME
// call (`{step:"…","status":"pending"}`), so JSON.parse cannot read it and this stays a scanner, like
// every other reader of the wrapper in this file. It walks `step`/`status` string properties IN ORDER:
// a `step` opens a row, a `status` fills the row it follows. Order is the only structure needed — a
// status ahead of its own step (never observed) would attach to the previous row, which is why a row
// with no step is dropped rather than guessed at.
function wrappedPlanRows(args: string): TranscriptTodo[] {
  const out: TranscriptTodo[] = []
  const re = /["']?(step|status)["']?\s*:\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(args))) {
    const parsed = readJsString(args, re.lastIndex)
    if (!parsed) continue
    re.lastIndex = parsed.end
    if (m[1] === "step") {
      const text = strField(parsed.value)
      if (text && out.length < TODO_ROWS_MAX) out.push({ text: capTodoText(text), status: "pending" })
    } else if (out.length) {
      out[out.length - 1].status = todoStatus(parsed.value) ?? out[out.length - 1].status
    }
  }
  return out
}

function planSummary(args: string): string {
  const total = (args.match(/["']?step["']?\s*:/g) ?? []).length
  const complete = (args.match(/["']?status["']?\s*:\s*["']completed["']/g) ?? []).length
  if (!total) return "update plan"
  return complete === total ? total + " steps · complete" : total + " steps · " + complete + "/" + total + " complete"
}

function wrappedRunSummary(calls: WrappedInvocation[]): string {
  const counts = new Map<string, number>()
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
  const kinds = [...counts].map(([tool, count]) => (count > 1 ? tool + " ×" + count : tool)).join(", ")
  return calls.length + " calls · " + kinds
}

function wrappedToolLabel(name: string): string {
  return codexToolLabel(name)
}

// A human label for a codex tool card. Codex names its tools in snake_case and, unlike Claude, ships
// no display name, so the generic branch was titling cards `navigate_page`, `evaluate_script`,
// `take_snapshot`, `wait_for`, `resize_page`, `click` — raw identifiers sitting beside proper labels
// like "Bash" and "Screenshot". The named cases are the tools worth a verb of their own; everything
// else falls back to sentence case, so a tool nobody has enumerated yet still reads as a label rather
// than as code (and stays in step with the repo's sentence-case copy rule).
function codexToolLabel(name: string): string {
  const known: Record<string, string> = {
    request_user_input: "Ask",
    view_image: "View image",
    navigate_page: "Navigate",
    evaluate_script: "Evaluate",
    take_snapshot: "Snapshot",
    list_pages: "Pages",
    new_page: "New page",
    close_page: "Close page",
    select_page: "Select page",
    list_console_messages: "Console",
    get_console_message: "Console message",
    list_network_requests: "Network",
    get_network_request: "Network request",
    press_key: "Press key",
    fill_form: "Fill form",
    handle_dialog: "Dialog",
    upload_file: "Upload",
    wait_for: "Wait for",
    resize_page: "Resize",
  }
  const hit = known[name]
  if (hit) return hit
  // A fully-namespaced MCP id (`mcp__chrome_devtools__resize_page`) is the worst card title of all.
  // The server segment is already implied by the surrounding thread, so keep only the tool and label
  // THAT — via the same table, so a namespaced tool and its bare twin read identically.
  const ns = name.split("__")
  if (ns.length > 2 && ns[0] === "mcp" && ns[ns.length - 1]) return codexToolLabel(ns[ns.length - 1])
  // Only reshape a plain snake_case/lowercase identifier. Anything already capitalized or otherwise
  // punctuated is left exactly as codex named it.
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name)) return name
  const words = name.split("_")
  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? ` ${words.slice(1).join(" ")}` : "")
}

function wrappedArgumentDetail(args: string): string | undefined {
  for (const key of ["file_path", "path", "uri", "url", "query", "q", "ref_id", "pattern", "location", "ticker", "target", "question", "prompt"]) {
    const value = jsStringProperty(args, key)
    if (value) return bashSummary(value)
  }
  return undefined
}

function wrappedWebCall(args: string): TranscriptToolCall {
  const kind = /\bsearch_query\s*:/.test(args)
    ? "Search web"
    : /\bopen\s*:/.test(args)
      ? "Open web"
      : /\bfind\s*:/.test(args)
        ? "Find on page"
        : /\bweather\s*:/.test(args)
          ? "Weather"
          : /\bfinance\s*:/.test(args)
            ? "Finance"
            : "Web"
  return { name: kind, detail: wrappedArgumentDetail(args), input: capToolInput(args) }
}

function renderToolInput(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim() ? capToolInput(input.trim()) : undefined
  if (!input || typeof input !== "object") return undefined
  try {
    const json = JSON.stringify(redactCredentialStructure(input), null, 2)
    return json && json !== "{}" ? capToolInput(json) : undefined
  } catch {
    return undefined
  }
}

// The shell command a codex exec/shell tool ran. exec_command ships it as `cmd` (a string); the older
// `shell`/`local_shell` tool ships `command` as either a string or an argv array (often ["bash","-lc",
// "<script>"] — we surface the script the shell actually runs). Returns undefined for a non-shell tool.
function extractShellCommand(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.cmd === "string" && obj.cmd.trim()) return obj.cmd.trim()
  const command = obj.command
  if (typeof command === "string" && command.trim()) return command.trim()
  if (Array.isArray(command) && command.length) {
    const parts = command.filter((c): c is string => typeof c === "string")
    const flag = parts.findIndex((c) => c === "-c" || c === "-lc" || c === "-lic")
    if (flag !== -1 && typeof parts[flag + 1] === "string" && parts[flag + 1].trim()) return parts[flag + 1].trim()
    const joined = parts.join(" ").trim()
    if (joined) return joined
  }
  return undefined
}

// The V4A patch text an apply_patch call carried — `{input|patch|diff: "*** Begin Patch…"}`, or the raw
// string when codex passes the patch positionally. Undefined when no patch body is present.
function extractPatch(input: unknown, obj: Record<string, unknown>): string | undefined {
  if (typeof input === "string" && input.includes("Begin Patch")) return input
  return strField(obj.input) ?? strField(obj.patch) ?? strField(obj.diff)
}

// Best-effort parse of a codex apply_patch V4A body into a SINGLE-file diff. Handles the common
// "Update File"/"Add File" single-file hunk; anything more complex (multi-file, delete) returns
// undefined so the caller falls back to rendering the raw patch. old/new are reconstructed from the hunk
// lines (context shared, '-' removed-only, '+' added-only) with the leading marker stripped. CAVEATS
// (acceptable for a best-effort card): a multi-hunk single-file update concatenates its `@@` regions
// into one old/new pair (the hunk headers are dropped), and a `*** Move to:` rename renders the diff
// under the SOURCE path (the move directive is ignored) rather than the destination.
function parseApplyPatch(patch: string): TranscriptToolCall["edit"] | undefined {
  const lines = patch.split("\n")
  let file: string | undefined
  let mode: "update" | "add" | undefined
  const oldLines: string[] = []
  const newLines: string[] = []
  let started = false
  for (const raw of lines) {
    const m = raw.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/)
    if (m) {
      if (file) return undefined // a second file → multi-file, bail to raw render
      file = m[2].trim()
      mode = m[1] === "Add" ? "add" : m[1] === "Update" ? "update" : undefined
      if (!mode) return undefined // Delete (no reconstructable body) → bail to raw render
      started = true
      continue
    }
    if (!started) continue
    if (raw.startsWith("*** ")) continue // *** End Patch / next-file marker
    if (raw.startsWith("@@")) continue // hunk header
    if (raw.startsWith("+")) newLines.push(raw.slice(1))
    else if (raw.startsWith("-")) oldLines.push(raw.slice(1))
    else {
      const ctx = raw.startsWith(" ") ? raw.slice(1) : raw
      oldLines.push(ctx)
      newLines.push(ctx)
    }
  }
  if (!file) return undefined
  return { file, old: mode === "add" ? "" : capEdit(oldLines.join("\n")), new: capEdit(newLines.join("\n")) }
}

// The file an apply_patch touches, for the fallback command-card header.
function patchSummary(patch: string): string {
  const m = patch.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)
  return m ? m[1].trim() : "apply_patch"
}

// Strip the trailing per-dispatch discovery sentinel (`<!-- frizz-session:… -->`) buildSpawn appends to
// the FIRST codex prompt so post-spawn discovery can pin the rollout — plumbing the human never typed.
function stripCodexSentinel(text: string): string {
  return text.replace(/\n*<!--\s*frizz-session:[^>]*-->\s*$/, "").replace(/\s+$/, "")
}

// The spawn path appends one of these exact contracts plus the Frizz-owned discovery sentinel after the
// human's task. Strip only that complete suffix from the first projected prompt: similar ordinary prose,
// or a title-transport sentence without the Frizz sentinel, remains the user's text.
function stripCodexFirstPromptTitleTransport(text: string): string {
  for (const transport of [CODEX_FIRST_FINAL_TITLE_TRANSPORT, CODEX_LEGACY_FIRST_FINAL_TITLE_TRANSPORT]) {
    const marker = `\n\n${transport}\n\n<!-- frizz-session:`
    const at = text.lastIndexOf(marker)
    if (at === -1) continue
    const sentinel = text.slice(at + marker.length)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*-->$/i.test(sentinel)) {
      return text.slice(0, at).trimEnd()
    }
  }
  return text
}

interface CodexToolResult {
  output?: string
  status: NonNullable<TranscriptToolCall["status"]>
  // Lifecycle verdict for a yielded process poll. PTYs carry an exit code; cell/wait results use a
  // `Script completed|failed|terminated` envelope without one.
  terminal?: boolean
  exitCode?: number
  durationMs?: number
  sessionId?: string | number
  // A yielded SCRIPT's cell id (the `wait`-polled generation), kept separate from sessionId — see runningKey.
  cellId?: string | number
}

// Unified exec returns response-content text blocks. Once backend/codex flattens them, the first block
// is a script envelope and the second is usually the nested tool's JSON result. Recover output, exit
// code, and status without depending on a particular nested tool name.
function codexToolResult(text: string): CodexToolResult {
  const unified = unifiedToolResult(text)
  if (unified) return unified

  const output = cleanExecOutput(text)
  const exitMatch = text.match(/(?:Process exited with code|Exit code:)\s*(\d+)/)
  const exitCode = exitMatch ? Number(exitMatch[1]) : undefined
  const scriptTerminal = text.match(/^Script (completed|failed|terminated)\b/)?.[1]
  const status: CodexToolResult["status"] =
    scriptTerminal === "failed"
      ? "failed"
      : scriptTerminal === "terminated"
        ? "cancelled"
        : exitCode !== undefined
      ? exitCode === 0
        ? "completed"
        : "failed"
      : cancelledToolResult(text)
        ? "cancelled"
      : failedToolResult(text)
        ? "failed"
        : "completed"
  const seconds = Number(text.match(/(?:Wall time:?|Wall time seconds:)\s*([0-9.]+)/i)?.[1])
  const durationMs = Number.isFinite(seconds) ? seconds * 1000 : undefined
  // A command that YIELDED rather than exited says so in the same envelope slot the exit code would
  // occupy: "Process running with session ID 53228". That id is what the model's later write_stdin
  // calls poll, and registering it here is what lets projectCodexTranscript fold those polls into this
  // command's card (the wrapper protocol got the id from its JSON result; the direct protocol had no
  // reader at all, so every direct-form poll stayed an orphan card).
  const sessionMatch = text.match(/(?:Process running with session ID\s*|^SESSION_ID=)(\d+)/m)
  const sessionId = sessionMatch ? Number(sessionMatch[1]) : undefined
  // The script generation's equivalent announcement, polled by `wait` instead of write_stdin.
  const cellMatch = text.match(/Script running with cell ID\s*(\d+)/)
  const cellId = cellMatch ? Number(cellMatch[1]) : undefined
  return {
    output: output || undefined,
    status,
    terminal: exitCode !== undefined || scriptTerminal !== undefined,
    exitCode,
    durationMs,
    sessionId,
    cellId,
  }
}

// Result text is untrusted command/tool output: words such as "0 failed" and documentation about a
// killed process are ordinary successful output, not lifecycle telemetry. Prefer structured error
// envelopes, then narrow leading failure phrases. Explicit wrapper status/exit codes win above.
function failedToolResult(text: string): boolean {
  const t = text.trimStart()
  try {
    const parsed = JSON.parse(t) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (obj.error != null || obj.success === false || obj.ok === false || obj.status === "failed" || obj.status === "error") return true
    }
  } catch {
    // Plain text is the common result shape.
  }
  if (/^(?:0\s+failed\b|no\s+(?:errors?|failures?)\b)/i.test(t)) return false
  return (
    /^(?:error|failed|failure|permission denied|verification failed|script error|unknown process id)\b/i.test(t) ||
    /^(?:tool(?: call)?|command|process|operation|request|task|collab spawn|apply_patch)\s+(?:verification\s+)?failed\b/i.test(t)
  )
}

function unifiedToolResult(text: string): CodexToolResult | undefined {
  const raw = typeof text === "string" ? text : ""
  const header = raw.match(/^Script (completed|failed|terminated)\r?\nWall time:?\s*([0-9.]+) seconds\r?\nOutput:\r?\n/)
  if (!header) return undefined
  const wrapperStatus: CodexToolResult["status"] =
    header[1] === "failed" ? "failed" : header[1] === "terminated" ? "cancelled" : "completed"
  const wrapperDurationMs = Number(header[2]) * 1000
  const body = raw.slice(header[0].length).trim()
  if (!body || body === "{}") return { status: wrapperStatus, durationMs: wrapperDurationMs, terminal: true }

  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const exitCode = typeof obj.exit_code === "number" && Number.isInteger(obj.exit_code) ? obj.exit_code : undefined
      const output = typeof obj.output === "string" ? obj.output.replace(/\s+$/, "") : undefined
      const nestedSeconds = typeof obj.wall_time_seconds === "number" && Number.isFinite(obj.wall_time_seconds) ? obj.wall_time_seconds : undefined
      const sessionId = typeof obj.session_id === "number" || typeof obj.session_id === "string" ? obj.session_id : undefined
      const nestedStatus: CodexToolResult["status"] =
        exitCode !== undefined
          ? exitCode === 0
            ? "completed"
            : "failed"
          : cancelledToolResult(output ?? body)
            ? "cancelled"
            : wrapperStatus === "failed" || failedToolResult(body)
              ? "failed"
              : "completed"
      return {
        output: output || undefined,
        status: nestedStatus,
        terminal: exitCode !== undefined || sessionId === undefined,
        exitCode,
        durationMs: nestedSeconds !== undefined ? nestedSeconds * 1000 : wrapperDurationMs,
        sessionId,
      }
    }
  } catch {
    // A non-JSON result is still useful verbatim below.
  }

  const output = body.replace(/^Script error:\r?\n/, "").trim()
  // Some wrappers surface a yielded nested exec as a plain SESSION_ID marker, then return from the
  // wrapper itself. The process is still live: register the id so subsequent direct write_stdin polls
  // update this originating Bash card instead of minting one UNKNOWN poll card per check.
  const escapedSessionMatch = output.match(/^SESSION_ID=(\d+)$/m)
  const sessionId = escapedSessionMatch ? Number(escapedSessionMatch[1]) : undefined
  return {
    output: output || undefined,
    status:
      wrapperStatus === "cancelled" || cancelledToolResult(output)
        ? "cancelled"
        : wrapperStatus === "failed" || failedToolResult(output)
          ? "failed"
          : "completed",
    durationMs: wrapperDurationMs,
    terminal: sessionId === undefined,
    sessionId,
  }
}

function applyCodexToolResult(call: TranscriptToolCall, result: CodexToolResult): void {
  call.status = result.status
  // A REJECTED spawn (codex answers with a bare error sentence) created no child, so drop the drill-in
  // id — otherwise the card offers a clickable title that can only ever resolve to "unavailable". The
  // tailer's tracker discards the same dispatch on the same signal.
  if (call.name === "Spawn agent" && result.status === "failed") call.agentId = undefined
  if (result.exitCode !== undefined) call.exitCode = result.exitCode
  if (result.durationMs !== undefined) call.durationMs = result.durationMs
  if (result.sessionId !== undefined) {
    call.sessionId = typeof result.sessionId === "string" ? redactToolPayload(result.sessionId) : result.sessionId
  }
  if (!result.output) return

  const summary = codexResultSummary(call.name, result.output)
  if (summary) call.output = capRead(summary)
}

function codexResultSummary(name: string, output: string): string | undefined {
  // "[image output]" is OUR OWN stand-in for a picture (backend/codex stringifyOutput), minted so the
  // base64 never enters the text channel. The card now renders the real image, so every occurrence of the
  // marker is a caption for something the reader can already see — strip it wherever it appears rather
  // than only when it is the entire body, because an MCP screenshot glues it onto its result sentence
  // ("Took a screenshot of the current page's viewport.[image output]").
  // An MCP tool result opens with its own envelope — "Wall time: 0.0580 seconds\nOutput:" — and because
  // the parts join with no separator, its `Output:` label runs straight into the first real sentence.
  // The wall time is ALREADY the card's duration meta, so displaying it again under a screenshot is the
  // same number twice and a dangling label. Stripped for DISPLAY ONLY, here rather than in
  // unifiedToolResult: that function also derives status/exitCode/sessionId, and widening its header
  // match would reroute every MCP result through a parser written for the exec wrapper.
  let text = output.replace(/^Wall time:?\s*[0-9.]+ seconds\r?\nOutput:[ \t]*\r?\n?/, "")
  // "[image output]" is OUR OWN stand-in for a picture (backend/codex stringifyOutput), minted so the
  // base64 never enters the text channel. The card now renders the real image, so every occurrence of the
  // marker is a caption for something the reader can already see — strip it wherever it appears rather
  // than only when it is the entire body, because an MCP screenshot glues it onto its result sentence
  // ("Took a screenshot of the current page's viewport.[image output]").
  text = text.split("[image output]").join("").trim()
  if (!text) return undefined
  if (text !== output) output = text
  if (name === "Agents") {
    try {
      const parsed = JSON.parse(output) as { agents?: Array<{ agent_status?: unknown }> }
      if (Array.isArray(parsed.agents)) {
        const states = new Map<string, number>()
        for (const agent of parsed.agents) {
          const raw = agent?.agent_status
          const state = typeof raw === "string" ? raw : raw && typeof raw === "object" ? Object.keys(raw)[0] ?? "unknown" : "unknown"
          states.set(state, (states.get(state) ?? 0) + 1)
        }
        const detail = [...states].map(([state, count]) => `${count} ${state}`).join(" · ")
        return `${parsed.agents.length} agents${detail ? ` · ${detail}` : ""}`
      }
    } catch {
      // Fall through to the bounded raw result.
    }
  }
  if (name === "Wait for agents") {
    try {
      const parsed = JSON.parse(output) as { timed_out?: unknown; message?: unknown }
      if (parsed.timed_out === true) return "Timed out without an update"
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim()
    } catch {
      // Fall through.
    }
  }
  if (name === "Interrupt") {
    try {
      const parsed = JSON.parse(output) as { previous_status?: unknown }
      if (typeof parsed.previous_status === "string") return `Previous status: ${parsed.previous_status}`
    } catch {
      // Fall through.
    }
  }
  return output
}

// Codex's exec_command output rides an envelope: "Chunk ID: …\nWall time: …\nProcess exited with code
// N\nOriginal token count: …\nOutput:\n<stdout/stderr>". Strip it to the actual output, prepending a
// compact "[exit N]" only when the command FAILED (a non-zero exit is signal the reader wants). A result
// that doesn't match the envelope (a `shell`-tool result, an already-bare string) is returned trimmed.
function cleanExecOutput(text: string): string {
  const t = typeof text === "string" ? text : ""
  const marker = t.indexOf("\nOutput:\n")
  if (marker === -1) return t.trim()
  const body = t.slice(marker + "\nOutput:\n".length).replace(/\s+$/, "")
  const exit = t.match(/Process exited with code (\d+)/)
  if (exit && exit[1] !== "0") return `[exit ${exit[1]}]${body ? `\n${body}` : ""}`
  return body
}

// A lazily-built default CodexBackend for the render path when no per-request backendFor is threaded
// (e.g. a unit test that calls readThreadTranscript directly). Uses $CODEX_HOME (default ~/.codex), so
// prod behavior is identical whether or not the caller passes its wired backendFor.
let _defaultCodexBackend: AgentBackend | null = null
function defaultCodexBackend(): AgentBackend {
  return (_defaultCodexBackend ??= createCodexBackend({}))
}

// ── bounded, turn-aligned backward pagination ──────────────────────────────────────────────────────
// The normal live transcript remains the latest MAX_MESSAGES projection. Older history is fetched only
// on demand. A page walks backward to the previous PROJECTED user message; provider records that do not
// render have already disappeared by this point, so Claude/Codex plumbing can never manufacture a turn
// boundary. Pathological single turns continue in bounded chunks instead of creating an unbounded RPC.
export const TRANSCRIPT_EARLIER_MAX_ITEMS = 100
export const TRANSCRIPT_EARLIER_MAX_BYTES = 512 * 1024

interface TranscriptSourceBinding {
  slug: string
  sessionId: string
  nativeId: string
  backend: "claude" | "codex"
  runtimeGeneration: number
  path: string
}

interface FixedTranscriptSnapshot extends TranscriptSourceBinding {
  /** LAZY — materialises the whole file as a string. Only the codex projector needs it. */
  raw: string
  /** LAZY — materialises the whole file as a Buffer. Prefer `size` and `readRange`. */
  bytes: Buffer
  /** The file's size at snapshot time, without reading a byte of it. */
  size: number
  /** Read `[from, from + length)` on demand, re-verifying the file's identity. */
  readRange(from: number, length: number): Buffer
  fileKey: string
  transcriptKey: string
}

interface TranscriptCursorPayload {
  v: 1
  slug: string
  sessionId: string
  nativeId: string
  backend: "claude" | "codex"
  runtimeGeneration: number
  fileKey: string
  snapshotBytes: number
  prefixDigest: string
  anchorSourceId: string
}

function sourceForThread(
  project: Project,
  storage: Storage,
  slug: string,
  backendFor?: (kind?: string) => AgentBackend,
): TranscriptSourceBinding | undefined {
  const row = storage.getSession(slug)
  if (row) {
    const backend = row.backend === "codex" ? "codex" : "claude"
    const nativeId = backend === "codex"
      ? row.agent_session_id ?? row.session_id
      : row.transcript_id ?? row.session_id
    const path = backend === "codex"
      ? (backendFor?.("codex") ?? defaultCodexBackend()).transcriptPath(nativeId)
      : resolveTranscriptPath(project, nativeId)
    if (!path) return undefined
    return {
      slug,
      sessionId: row.session_id,
      nativeId,
      backend,
      runtimeGeneration: row.runtime_generation ?? 0,
      path,
    }
  }
  if (!FOREIGN_SESSION_ID_RE.test(slug)) return undefined
  // A FOREIGN thread — a terminal frizz did not start, so there is no row to read the backend off.
  // Both agents mint a bare uuid, so the id itself cannot say which one wrote it and the binding has
  // to be PROBED. Claude first because its probe is a single stat of a known path; codex's walks the
  // global sessions tree (~10ms warm on a 1,586-rollout corpus, and this runs per VIEW, not per tick).
  // Before the External band this returned "claude" unconditionally, which was right while the Claude
  // log dir was the only place a foreign thread could come from — a codex rollout would have rendered
  // as an empty conversation with nothing to say why.
  const claudePath = resolveTranscriptPath(project, slug)
  if (existsSync(claudePath)) {
    return { slug, sessionId: slug, nativeId: slug, backend: "claude", runtimeGeneration: 0, path: claudePath }
  }
  const rollout = (backendFor?.("codex") ?? defaultCodexBackend()).transcriptPath(slug)
  if (rollout) {
    return { slug, sessionId: slug, nativeId: slug, backend: "codex", runtimeGeneration: 0, path: rollout }
  }
  // Neither found it. Keep the Claude binding rather than returning undefined: the caller renders an
  // empty page either way, and a thread whose transcript has not been written YET must still bind.
  return { slug, sessionId: slug, nativeId: slug, backend: "claude", runtimeGeneration: 0, path: claudePath }
}

function discoveredClaudeSource(
  project: Project,
  storage: Storage,
  slug: string,
  expectedNativeId?: string,
): TranscriptSourceBinding | undefined {
  const row = storage.getSession(slug)
  if (!row || row.backend === "codex" || row.transcript_id) return undefined
  if (Date.now() - Date.parse(row.spawned_at) < DISCOVERY_GRACE_MS) return undefined
  const exclude = new Set<string>()
  for (const candidate of storage.allSessions()) {
    if (candidate.slug === row.slug) continue
    exclude.add(candidate.session_id)
    if (candidate.transcript_id) exclude.add(candidate.transcript_id)
  }
  const nativeId = discoverTranscriptId(logDirOf(project), row.session_id, { exclude })
  if (!nativeId || (expectedNativeId !== undefined && nativeId !== expectedNativeId)) return undefined
  return {
    slug,
    sessionId: row.session_id,
    nativeId,
    backend: "claude",
    runtimeGeneration: row.runtime_generation ?? 0,
    // `nativeId` was just found INSIDE logDirOf, so the resolver's first stat answers and this is the
    // same path either way. Routed through it anyway: one rule with no exception to remember beats
    // three call sites where two must resolve and the third happens not to need to.
    path: resolveTranscriptPath(project, nativeId),
  }
}

function fixedSnapshot(source: TranscriptSourceBinding): FixedTranscriptSnapshot | undefined {
  let fd: number | undefined
  try {
    fd = openSync(source.path, "r")
    const before = fstatSync(fd)
    if (!Number.isSafeInteger(before.size) || before.size < 0) throw new Error("transcript is too large to page safely")
    // NOT SLURPED. This used to read the entire file into a Buffer before anything consulted the
    // cache — 566MB per call on the maintainer's biggest thread, twice past 1.2GB RSS for two drawer
    // opens, in a process that now serves EVERY project. The lazy `raw` below already avoided the
    // whole-file STRING; it did not avoid the whole-file BUFFER.
    //
    // The identity check that made the eager read look necessary is preserved differently: the file is
    // re-stat'd here, and every range read below re-opens and re-checks dev/ino/size, so a file
    // swapped or truncated mid-page is still caught — by the same fileKey the paging protocol already
    // validates against.
    const after = fstatSync(fd)
    if (after.dev !== before.dev || after.ino !== before.ino || after.size < before.size) {
      throw new Error("transcript changed while it was being read; retry")
    }
    const size = before.size
    const path = source.path
    /** Read `[from, from+length)` on demand, re-verifying identity so a rotated file cannot be mixed. */
    const readRange = (from: number, length: number): Buffer => {
      const rfd = openSync(path, "r")
      try {
        const st = fstatSync(rfd)
        if (st.dev !== before.dev || st.ino !== before.ino || st.size < size) {
          throw new Error("transcript changed while it was being read; retry")
        }
        const want = Math.max(0, Math.min(length, size - from))
        const buf = Buffer.allocUnsafe(want)
        let filled = 0
        while (filled < want) {
          const n = readSync(rfd, buf, filled, want - filled, from + filled)
          if (n === 0) break
          filled += n
        }
        return filled === want ? buf : buf.subarray(0, filled)
      } finally {
        closeSync(rfd)
      }
    }
    // The whole-file Buffer, materialised ONLY if something genuinely needs it (the codex projector
    // and the full digest). Everything on the claude path goes through readRange instead.
    let allBytes: Buffer | undefined
    const fileKey = `${before.dev}:${before.ino}:${Math.trunc(before.birthtimeMs)}`
    const transcriptKey = createHash("sha256")
      .update(`${source.slug}\0${source.sessionId}\0${source.nativeId}\0${source.backend}\0${source.runtimeGeneration}\0${fileKey}`)
      .digest("base64url")
      .slice(0, 32)
    // `raw` is LAZY: the cached projection below folds only the APPENDED byte range, so a warm read of a
    // 30 MB transcript must never pay to materialize the whole file as a JS string. Only the codex
    // projector (non-incremental) and a cold claude fold ever touch it.
    let rawText: string | undefined
    return {
      ...source,
      get raw() {
        if (rawText === undefined) rawText = this.bytes.toString("utf8")
        return rawText
      },
      get bytes() {
        if (allBytes === undefined) allBytes = readRange(0, size)
        return allBytes
      },
      size,
      readRange,
      fileKey,
      transcriptKey,
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// The paged reader's projection. readLatestThreadTranscriptPage used to re-fold the WHOLE JSONL from
// byte 0 on every threadTranscript RPC — measured at 2.3–3.9s for a 30 MB session, synchronously on the
// event loop, which is most of why opening a thread drawer sat on its spinner (9.4s observed; worse on a
// busy board, where these queue behind each other and behind the tailer tick). It now shares the SAME
// retained fold as readTranscript (see retainedFoldEntry): an unchanged file costs no parse work, a live
// one costs only the appended delta, and the two readers no longer fold the same bytes twice.
function projectSnapshot(snapshot: FixedTranscriptSnapshot): TranscriptMessage[] {
  const prefix = `${snapshot.backend}:${snapshot.nativeId}`
  // The codex projector parses a rollout whole — no incremental fold to retain, and rollouts are small.
  // It emits no queued bubbles today (codex's gray bubbles come only from the delivery ledger, which
  // ages its own out), so the backstop is a no-op here — applied anyway so the guarantee is a property
  // of the reader rather than of one backend's current parser.
  if (snapshot.backend === "codex") return retireStaleQueuedBubbles(projectCodexTranscript(snapshot.raw, prefix))

  const { entry } = retainedFoldEntry(snapshot.path, prefix, snapshot.fileKey, snapshot.size)
  // Reads ONLY the appended delta — the reason the whole-file buffer is no longer materialised.
  ingestBounded(entry, snapshot.size, (from, length) => snapshot.readRange(from, length))
  // Deliberately NO finalize(): it is the one-shot path's trailing-partial flush and advances the fold
  // past bytes a later ingest would then re-fold, duplicating messages. A complete final record that
  // simply lacks its newline is still projected — the fold consumes it optimistically (tryConsumePartial)
  // — so this matches both the readTranscript cache and, for settled files, the one-shot projection.

  // Shallow copy: callers append synthetic tail rows (projectDeliveryLedger pushes queued bubbles into
  // the array it is handed), which would otherwise pollute the RETAINED projection across reads.
  // retireStaleQueuedBubbles runs HERE rather than further down: it must see the fold's OWN bubbles and
  // not the ledger's synthetic ones, which carry their own aging (ageDeliveries) and states.
  return retireStaleQueuedBubbles([...entry.fold.allMessages()])
}

// sha256 over the whole snapshot, memoized per file identity+length. Cursor minting hashes the ENTIRE
// transcript on every latest-page read; at 30 MB that is real event-loop time to repeat for a file that
// has not changed. Only the full-length digest is memoized — the cursor VALIDATION path digests an
// arbitrary historical prefix, which is a one-off per request and stays uncached.
const fullDigestCache = new Map<string, string>()
const FULL_DIGEST_CACHE_CAP = 16

function digestPrefix(bytes: Buffer, length = bytes.length): string {
  return createHash("sha256").update(bytes.subarray(0, length)).digest("base64url")
}

function fullDigest(snapshot: FixedTranscriptSnapshot): string {
  const key = `${snapshot.fileKey}\0${snapshot.size}`
  const hit = fullDigestCache.get(key)
  if (hit !== undefined) {
    fullDigestCache.delete(key)
    fullDigestCache.set(key, hit)
    return hit
  }
  // STREAMED. This hashed the whole file as one Buffer, so every snapshot of a 566MB transcript
  // resident-set another 566MB even though the digest itself is cached — two drawer opens reached
  // 1.4GB RSS. The hash is incremental by nature; only the reader was not.
  const hash = createHash("sha256")
  for (let at = 0; at < snapshot.size; ) {
    const buf = snapshot.readRange(at, Math.min(TRANSCRIPT_DECODE_WINDOW, snapshot.size - at))
    if (buf.length === 0) break
    hash.update(buf)
    at += buf.length
  }
  const digest = hash.digest("base64url")
  fullDigestCache.set(key, digest)
  while (fullDigestCache.size > FULL_DIGEST_CACHE_CAP) {
    const oldest = fullDigestCache.keys().next().value
    if (oldest === undefined) break
    fullDigestCache.delete(oldest)
  }
  return digest
}

function encodeTranscriptCursor(snapshot: FixedTranscriptSnapshot, anchorSourceId: string): string {
  const payload: TranscriptCursorPayload = {
    v: 1,
    slug: snapshot.slug,
    sessionId: snapshot.sessionId,
    nativeId: snapshot.nativeId,
    backend: snapshot.backend,
    runtimeGeneration: snapshot.runtimeGeneration,
    fileKey: snapshot.fileKey,
    snapshotBytes: snapshot.size,
    prefixDigest: fullDigest(snapshot),
    anchorSourceId,
  }
  return Buffer.from(JSON.stringify(payload)).toString("base64url")
}

function decodeTranscriptCursor(cursor: string): TranscriptCursorPayload {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) throw new Error("invalid transcript cursor")
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    throw new Error("invalid transcript cursor")
  }
  const p = value as Partial<TranscriptCursorPayload> | null
  const validText = (s: unknown, max: number) => typeof s === "string" && s.length > 0 && s.length <= max && !/[\0\r\n]/.test(s)
  if (
    !p || p.v !== 1 || !validText(p.slug, 256) || !validText(p.sessionId, 256) ||
    !validText(p.nativeId, 256) || (p.backend !== "claude" && p.backend !== "codex") ||
    !Number.isSafeInteger(p.runtimeGeneration) || (p.runtimeGeneration ?? -1) < 0 ||
    !validText(p.fileKey, 256) || !Number.isSafeInteger(p.snapshotBytes) || (p.snapshotBytes ?? -1) < 0 ||
    !validText(p.prefixDigest, 128) || !validText(p.anchorSourceId, 768)
  ) throw new Error("invalid transcript cursor")
  return p as TranscriptCursorPayload
}

function messageBytes(message: TranscriptMessage): number {
  return Buffer.byteLength(JSON.stringify(message))
}

export interface ProjectedEarlierPage {
  start: number
  messages: TranscriptMessage[]
  reachedTurnBoundary: boolean
}

// Pure page selection over the canonical projection. `anchor` is excluded: it is already rendered.
export function pageProjectedTranscript(
  messages: readonly TranscriptMessage[],
  anchor: number,
  limits: { maxItems?: number; maxBytes?: number } = {},
): ProjectedEarlierPage {
  if (!Number.isSafeInteger(anchor) || anchor <= 0 || anchor > messages.length) {
    return { start: Math.max(0, Math.min(messages.length, anchor || 0)), messages: [], reachedTurnBoundary: true }
  }
  // THE BOUNDARY IS THE HUMAN'S LAST MESSAGE, not merely the last `user` record.
  //
  // Frizz writes as the user — a Goal delivery, the sign-off reminder, a watcher wake are all `user`
  // records (`wake: true`, set by the server that composed them). Stopping at one cuts the page in the
  // middle of a stretch the human has never seen, which is the opposite of what this page is for: the
  // reader is opening a card cold and needs everything back to the last thing THEY said (maintainer
  // 2026-08-12: "queue cards STILL need to go all the way back to the last user message. that's
  // important context that needs to be surfaced").
  //
  // A queued send is skipped for a different reason: it has not been delivered, so it is not yet part of
  // the exchange being summarised. An `agentInstruction` is also user-side but belongs to a CHILD's
  // coordinator/peer conversation, never the operator's turn.
  let boundary = 0
  for (let i = anchor - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user" && !m.wake && !m.queued && !m.agentInstruction) {
      boundary = i
      break
    }
  }
  const maxItems = Math.max(1, Math.floor(limits.maxItems ?? TRANSCRIPT_EARLIER_MAX_ITEMS))
  const maxBytes = Math.max(1, Math.floor(limits.maxBytes ?? TRANSCRIPT_EARLIER_MAX_BYTES))
  let start = anchor
  let bytes = 0
  while (start > boundary && anchor - start < maxItems) {
    const nextBytes = messageBytes(messages[start - 1])
    // One canonical message is atomic. Fail explicitly instead of truncating its text/tools or silently
    // violating the response ceiling; ordinary provider output is well below this defensive bound.
    if (nextBytes > maxBytes) throw new Error("one transcript message exceeds the earlier-page byte limit")
    if (bytes + nextBytes > maxBytes) break
    start--
    bytes += nextBytes
  }
  return {
    start,
    messages: messages.slice(start, anchor),
    reachedTurnBoundary: start === boundary,
  }
}

function emptyTranscriptPage(source?: TranscriptSourceBinding): TranscriptPage {
  const keySeed = source
    ? `${source.slug}\0${source.sessionId}\0${source.nativeId}\0${source.backend}\0${source.runtimeGeneration}\0missing`
    : "unavailable"
  return {
    messages: [],
    beforeCursor: null,
    hasEarlier: false,
    reachedTurnBoundary: true,
    transcriptKey: createHash("sha256").update(keySeed).digest("base64url").slice(0, 32),
    editedFiles: [],
  }
}

export function readLatestThreadTranscriptPage(
  project: Project,
  storage: Storage,
  slug: string,
  backendFor?: (kind?: string) => AgentBackend,
): TranscriptPage {
  let source = sourceForThread(project, storage, slug, backendFor)
  if (!source) return emptyTranscriptPage()
  let snapshot = fixedSnapshot(source)
  if (!snapshot) {
    const discovered = discoveredClaudeSource(project, storage, slug)
    const discoveredSnapshot = discovered ? fixedSnapshot(discovered) : undefined
    if (!discoveredSnapshot) return emptyTranscriptPage(source)
    source = discovered!
    snapshot = discoveredSnapshot
  }
  let projected = projectSnapshot(snapshot)
  // Match the legacy reader's gated, bounded drift recovery for old Claude sessions whose real file
  // was minted under a different native id. The cursor binds that discovered id; the follow-up read
  // repeats the same sentinel proof until the tailer persists the re-link.
  if (!projected.length) {
    const discovered = discoveredClaudeSource(project, storage, slug)
    const discoveredSnapshot = discovered ? fixedSnapshot(discovered) : undefined
    if (discoveredSnapshot) {
      source = discovered!
      snapshot = discoveredSnapshot
      projected = projectSnapshot(snapshot)
    }
  }
  const latest = latestTranscriptWindow(projected)
  // The cursor has to name the window's REAL head, not the raw MAX_MESSAGES cut: once the window reaches
  // back for the human's ask, a cursor anchored at the cut sits INSIDE what was already sent, and the
  // first "Load earlier messages" click would page over messages the card is already showing.
  const canonicalStart = latestWindowStart(projected)
  // The latest window carries the delivery-ledger projection (same as readThreadTranscript): a tracked
  // follow-up renders as its gray queued bubble at the tail even before any JSONL evidence exists. The
  // LATEST page only — earlier pages are settled history a pending send can never belong to.
  // Codex included: its ledger entry is the ONLY thing rendering a just-sent steer until the rollout
  // materialises it, and this paginated reader is what the drawer loads with — excluding codex here
  // meant the bubble was present over the socket push but ABSENT on load and on every refetch.
  const row = storage.getSession(slug)
  const pageMessages = row
    ? projectDeliveryLedger(latest, parseDeliveryLedger(row.delivery_ledger))
    : latest
  return {
    messages: pageMessages,
    beforeCursor: canonicalStart > 0 ? encodeTranscriptCursor(snapshot, projected[canonicalStart].sourceId!) : null,
    hasEarlier: canonicalStart > 0,
    reachedTurnBoundary: true,
    transcriptKey: snapshot.transcriptKey,
    // Over the WHOLE projection, not the window — see EditedFile in @frizz/shared. The project dir is
    // what scopes the SHELL-write reading: a redirect names any path the worker felt like, and only the
    // ones inside this checkout belong on the rail (edited-files.ts). Then git drops whatever the
    // repository would not carry — scratch, build output — leaving the rail an account of repo work
    // (repo-files.ts).
    editedFiles: repoCarriedEditedFiles(project.dir, editedFilesOf(projected, project.dir)),
  }
}

export function readEarlierThreadTranscriptPage(
  project: Project,
  storage: Storage,
  slug: string,
  cursor: string,
  backendFor?: (kind?: string) => AgentBackend,
): TranscriptPage {
  const payload = decodeTranscriptCursor(cursor)
  if (payload.slug !== slug) throw new Error("transcript cursor belongs to another thread")
  let source = sourceForThread(project, storage, slug, backendFor)
  if (
    source && source.sessionId === payload.sessionId && source.backend === payload.backend &&
    source.runtimeGeneration === payload.runtimeGeneration && source.nativeId !== payload.nativeId
  ) {
    source = discoveredClaudeSource(project, storage, slug, payload.nativeId) ?? source
  }
  if (
    !source || source.sessionId !== payload.sessionId || source.nativeId !== payload.nativeId ||
    source.backend !== payload.backend || source.runtimeGeneration !== payload.runtimeGeneration
  ) throw new Error("transcript cursor is stale because the session was replaced")
  const snapshot = fixedSnapshot(source)
  if (!snapshot || snapshot.fileKey !== payload.fileKey || snapshot.size < payload.snapshotBytes) {
    throw new Error("transcript cursor is stale because the transcript was replaced")
  }
  if (digestPrefix(snapshot.readRange(0, payload.snapshotBytes)) !== payload.prefixDigest) {
    throw new Error("transcript cursor is stale because prior transcript bytes changed")
  }
  const projected = projectSnapshot(snapshot)
  const anchor = projected.findIndex((message) => message.sourceId === payload.anchorSourceId)
  if (anchor < 0) throw new Error("transcript cursor boundary is no longer present")
  const page = pageProjectedTranscript(projected, anchor)
  // SUPPRESSION ONLY — deliberately not the full projection. An earlier page is settled history and a
  // pending send can never belong there, so no queued bubble is ever added here. A CANCELLED send's
  // orphan is the opposite case: the JSONL's `queue-operation enqueue` scrolls into history like any
  // other record, and left alone the retracted message reappears the moment the operator scrolls back.
  const earlierRow = storage.getSession(slug)
  const messages = earlierRow
    ? suppressCancelledDeliveries(page.messages, parseDeliveryLedger(earlierRow.delivery_ledger))
    : page.messages
  return {
    messages,
    beforeCursor: page.start > 0 ? encodeTranscriptCursor(snapshot, projected[page.start].sourceId!) : null,
    hasEarlier: page.start > 0,
    reachedTurnBoundary: page.reachedTurnBoundary,
    transcriptKey: snapshot.transcriptKey,
  }
}

// Parse a codex rollout from an ABSOLUTE file path (the located ~/.codex/sessions/**/rollout-*.jsonl).
// Missing/unreadable file → [] (the drawer renders its spinner / "transcript unavailable" state).
export function readCodexTranscriptFile(absPath: string, nativeId = absPath): TranscriptMessage[] {
  try {
    return parseCodexTranscript(readFileSync(absPath, "utf8"), `codex:${nativeId}`)
  } catch {
    return []
  }
}

// Resolve a thread slug to its rendered transcript: a registry row's DISCOVERED transcript (transcript_id)
// if one was cached, else its pinned session_id; for a foreign thread the slug itself as a session id;
// else empty. When the pinned transcript renders empty and nothing's been cached yet, a best-effort
// content discovery (scratchpad sentinel, same as the tailer) re-links a drifted transcript so the drawer
// isn't blank while the tailer catches up. The single resolution the threadTranscript RPC and the /ws
// transcript producer share, so foreign threads render identically on both paths. Degrades to [].
export function readThreadTranscript(
  project: Project,
  storage: Storage,
  slug: string,
  backendFor?: (kind?: string) => AgentBackend,
): TranscriptMessage[] {
  const row = storage.getSession(slug)
  if (row) {
    // Codex threads write a DIFFERENT transcript schema in a DIFFERENT place (~/.codex/sessions,
    // date-sharded, located by the discovered rollout id) — route them through the codex reader+parser
    // so the drawer renders codex messages + tool calls instead of an empty pane. The rollout id is
    // `agent_session_id` (the id codex minted, pinned post-discovery); until discovery pins it,
    // transcriptPath returns undefined → [] and the drawer keeps its spinner (the tailer catches up).
    if (row.backend === "codex") {
      const backend = backendFor?.("codex") ?? defaultCodexBackend()
      const nativeId = row.agent_session_id ?? row.session_id
      const path = backend.transcriptPath(nativeId)
      // Codex carries the ledger too, for RENDERING only — see the append in router.followUp. Without
      // this a just-sent steer lives solely in the client's optimistic bubble, which the ghost floor
      // retires after the transcript advances 60s; the rollout is slower than that often enough to
      // matter (8 of 75 measured sends).
      const codexLedger = parseDeliveryLedger(row.delivery_ledger)
      return projectDeliveryLedger(path ? readCodexTranscriptFile(path, nativeId) : [], codexLedger)
    }
    // Claude rows carry the follow-up delivery ledger: project every not-yet-delivered send as its gray
    // queued bubble (server truth — reload-safe; the client's optimistic copy consumes it by deliveryId).
    // Applied at each return AFTER the discovery gates below, which must judge the RAW parse — a
    // projected bubble on an otherwise-empty transcript must not suppress discovery.
    const ledger = parseDeliveryLedger(row.delivery_ledger)
    const msgs = readTranscript(project, row.transcript_id ?? row.session_id)
    if (msgs.length || row.transcript_id) return projectDeliveryLedger(msgs, ledger)
    // The pinned transcript rendered empty and nothing's cached. GATE the fallback on the spin-up grace:
    // a fresh dispatch renders empty simply because its file isn't written yet, and this path runs on
    // every drawer view / WS subscribe — an ungated per-view directory scan would be wasted work on the
    // common case. Only a genuinely-overdue thread engages discovery (bounded; see discover.ts).
    if (Date.now() - Date.parse(row.spawned_at) < DISCOVERY_GRACE_MS) return projectDeliveryLedger(msgs, ledger)
    // Exclude ids owned by OTHER rows (their pinned + discovered transcripts) — never steal a claimed one.
    const exclude = new Set<string>()
    for (const r of storage.allSessions()) {
      if (r.slug === row.slug) continue
      exclude.add(r.session_id)
      if (r.transcript_id) exclude.add(r.transcript_id)
    }
    const found = discoverTranscriptId(logDirOf(project), row.session_id, { exclude })
    return projectDeliveryLedger(found ? readTranscript(project, found) : msgs, ledger)
  }
  // A FOREIGN slug binds the same way the paged reader binds it (sourceForThread): the Claude log dir
  // if the file is there, else the codex rollout tree. This producer feeds the /ws push, and until
  // 2026-08-24 it read the Claude path unconditionally — so an external CODEX row rendered its page
  // over HTTP, then the socket's keyframe arrived as [] and blanked it to "No conversation yet." until
  // the client's 7s watchdog refetched the page (reproduced on a disposable stack: messages at 138ms,
  // empty at 749ms, back at 7058ms; a Claude row never flashed). One binding for both readers means
  // the two cannot disagree about which file a foreign thread is.
  if (FOREIGN_SESSION_ID_RE.test(slug)) {
    const source = sourceForThread(project, storage, slug, backendFor)
    if (!source) return []
    return source.backend === "codex" ? readCodexTranscriptFile(source.path, slug) : readTranscript(project, slug)
  }
  return []
}

export interface AgentLifecycleProjection {
  startedAt?: string
  finishedAt?: string
  outcome?: "completed" | "failed" | "killed"
}

// Overlay the tailer's retained CHILD lifecycle onto Agent launch cards. Provider tool results measure
// only the spawn CALL, so `durationMs` must never be promoted to an agent runtime. Both the paginated
// RPC and the live WebSocket reader call this same projection; keeping it here prevents a socket refresh
// from replacing an enriched initial page with raw dispatch latency.
export function projectTranscriptAgentLifecycles(
  messages: readonly TranscriptMessage[],
  lookup: (id: string) => AgentLifecycleProjection | undefined,
): TranscriptMessage[] {
  const cache = new Map<string, AgentLifecycleProjection | undefined>()
  const projectTool = (tool: TranscriptToolCall): TranscriptToolCall => {
    if (!tool.agentId || tool.agentStatus) return tool
    if (!cache.has(tool.agentId)) cache.set(tool.agentId, lookup(tool.agentId))
    const lifecycle = cache.get(tool.agentId)
    if (!lifecycle?.outcome) return tool
    const start = lifecycle.startedAt ? Date.parse(lifecycle.startedAt) : Number.NaN
    const finish = lifecycle.finishedAt ? Date.parse(lifecycle.finishedAt) : Number.NaN
    const elapsed = Number.isFinite(start) && Number.isFinite(finish) && finish >= start ? finish - start : undefined
    return {
      ...tool,
      agentStatus: lifecycle.outcome,
      ...(elapsed === undefined ? {} : { agentElapsedMs: elapsed }),
    }
  }
  return messages.map((message) => ({
    ...message,
    tools: message.tools.map(projectTool),
    parts: message.parts.map((part) => part.kind === "tools" ? { ...part, tools: part.tools.map(projectTool) } : part),
  }))
}

// A background op the operator RETIRED with the × is no longer live, and the TRANSCRIPT is the second
// place that has to learn it. The board row leaves on the click; this call does not, because the fold
// derives it from a `tool_use` whose terminal partner never arrives — the provider writes nothing to
// the JSONL when it stops a shell (server/backend/_live_shell_stop_notice.mts). So the ops strip drew
// the row again from the TRANSCRIPT side, this time with no × on it at all (nothing to address), and
// the transcript card went on reading "RUNNING · 3433 MIN". That is the maintainer's screenshot.
//
// `cancelled` rather than `completed`: the operator ended it, and the card should say so.
// The retired-op set for one thread, resolved the same way by BOTH transcript producers. It exists as
// its own export because there are two of them — the `threadTranscript` RPC and the /ws push
// (app-socket.ts makeTranscriptReader) — and the live UI reads the SECOND one. Applying the projection
// to only the RPC left the killed shell's card reading "RUNNING" in the browser while the RPC returned
// "cancelled", which is precisely how this was found.
export function retiredOpsFor(storage: Pick<Storage, "getSession" | "retiredOps">, slug: string): ReadonlySet<string> {
  const row = storage.getSession(slug)
  return row ? storage.retiredOps(slug, row.session_id) : EMPTY_RETIRED_OPS
}
const EMPTY_RETIRED_OPS: ReadonlySet<string> = new Set()

export function projectRetiredBackgroundOps(
  messages: readonly TranscriptMessage[],
  retired: ReadonlySet<string>,
  // The thread's OWNING PROCESS is gone. A second, thread-wide retirement cause with exactly the same
  // consequence as the ×, and for a stronger reason: a background Bash/Monitor is a CHILD of the agent
  // process, so when that process dies every still-pending background card is terminal — no id needed,
  // because none of them can be running.
  //
  // Without this the ops strip resurrected precisely what the board had retired. The strip is
  // `mergeBackgroundShells(board.bgShells, transcriptBackgroundShells(messages))`, a UNION whose
  // transcript side reads liveness as nothing more than `status === "pending"`. So emptying the board's
  // list (what a dead owner does) did not remove the row — it moved it to the transcript side, where it
  // kept rendering "running". Measured on the real JSONL of thread invoices-just-went-out-for-august:
  // projected at the last record written before the successor daemon resumed it, the backfill shell's
  // card was STILL `pending` seven hours after the process owning it had died.
  ownerGone = false,
): TranscriptMessage[] {
  if (retired.size === 0 && !ownerGone) return messages as TranscriptMessage[]
  // Keyed on `shellId` — the launch tool_use id, which is exactly what the × was addressed at. A call
  // with no shellId was never a tracked background op and is left alone (that guard holds for the
  // owner-gone arm too: it retires TRACKED background ops, not every pending tool call).
  const isRetired = (tool: TranscriptToolCall): boolean =>
    tool.shellId !== undefined && (ownerGone || retired.has(tool.shellId)) && tool.status === "pending"
  // `backgroundState` SURVIVES the retirement. It briefly did not, and erasing it is what put a shell
  // killed two days earlier into the live shimmer: that field is the marker the client's
  // `isToolActivityException` reads to keep a background op OUT of the coalesced tool run, so a
  // retired call stripped of it became an ordinary tool call — and `liveToolActivityTail` reads the
  // newest ordinary call in the tail, so the bottom row read "Restarting the census sweep · 11m 57s"
  // (maintainer 2026-08-01). Nothing needed the erasure: every live reading — the ops strip
  // (isLiveTranscriptBackgroundTool), the liveness dot (hasRunningToolIndicator), the "background
  // running" label — is already gated on `status === "pending"`, which `cancelled` fails on its own.
  const projectTool = (tool: TranscriptToolCall): TranscriptToolCall =>
    isRetired(tool) ? { ...tool, status: "cancelled" } : tool
  const out: TranscriptMessage[] = []
  for (const message of messages) {
    // A PINNED projection (latestTranscriptWindow) is a synthetic tools-only copy appended after the
    // real tail, purely to keep an UNRESOLVED shell visible once its launch message fell out of the
    // window. A retired shell IS resolved, so the pin has nothing left to keep visible — and because
    // the windower runs before this projection, it would otherwise be re-minted on every read, forever,
    // carrying a days-old `at` at the bottom of the conversation. The canonical message keeps its
    // cancelled card at its own position in paginated history.
    if (message.pinnedFromSourceId && message.tools.length > 0 && message.tools.every(isRetired)) continue
    out.push({
      ...message,
      tools: message.tools.map(projectTool),
      parts: message.parts.map((part) => part.kind === "tools" ? { ...part, tools: part.tools.map(projectTool) } : part),
    })
  }
  return out
}

// A child's upward report names its sender by RUNTIME agent id; the fold turns that into the child's
// dispatch description only when the dispatch's launch ack sits inside the same window it folded. The
// paged RPC folds a BOUNDED window, so a report near the tail whose dispatch scrolled above the page
// start came back with no title — and read as the profile cell, which names the model and not the work
// and is identical across every sibling in that cell. The socket's full-transcript read has always
// resolved it, which is why the same line "later resolves into the actual title" (maintainer
// 2026-08-06).
//
// This closes that gap from the other side: the TAILER holds agentId → (dispatch id, label) for as long
// as it tracks the child at all — live, retired, or a descendant — so it can answer what the page could
// not. It only ever ADDS a resolution: a message the fold already named is returned untouched, and an id
// the tailer cannot place stays unnamed rather than gaining an invented title or a dead drill-in link.
export function projectTranscriptPeerNames(
  messages: readonly TranscriptMessage[],
  lookup: (taskId: string) => { id: string; label: string } | undefined,
): TranscriptMessage[] {
  const cache = new Map<string, { id: string; label: string } | undefined>()
  let changed = false
  const out = messages.map((message) => {
    if (!message.peerUnnamed || !message.peerSenderTaskId) return message
    const key = message.peerSenderTaskId
    if (!cache.has(key)) cache.set(key, lookup(key))
    const resolved = cache.get(key)
    // A tracked child with no description of its own resolves to the fold's own placeholder, which is no
    // better a title than the profile — leave the line unnamed rather than promoting "sub-agent".
    if (!resolved || !resolved.label.trim() || resolved.label === "sub-agent") return message
    changed = true
    const { peerUnnamed: _dropped, ...rest } = message
    return { ...rest, peerFrom: resolved.label, peerDispatchId: message.peerDispatchId ?? resolved.id }
  })
  return changed ? out : (messages as TranscriptMessage[])
}

export function projectTranscriptPageAgentLifecycles(
  page: TranscriptPage,
  lookup: (id: string) => AgentLifecycleProjection | undefined,
  peerLookup?: (taskId: string) => { id: string; label: string } | undefined,
): TranscriptPage {
  const named = peerLookup ? projectTranscriptPeerNames(page.messages, peerLookup) : page.messages
  return { ...page, messages: projectTranscriptAgentLifecycles(named, lookup) }
}

// Parse a transcript from an ABSOLUTE file path (vs. project+session_id). Used for a sub-agent's own
// JSONL (the tracked outputFile, a symlink to ~/.claude/projects/<cwd>/subagents/agent-<id>.jsonl),
// which shares the session record format exactly — so the same mechanical block/tool extraction
// applies. Missing/unreadable file → [] (the drawer renders its "transcript unavailable" state).
export function readTranscriptFile(absPath: string): TranscriptMessage[] {
  try {
    const pathKey = createHash("sha256").update(absPath).digest("base64url").slice(0, 16)
    return parseTranscript(readFileSync(absPath, "utf8"), `claude-file:${pathKey}`)
  } catch {
    return []
  }
}
