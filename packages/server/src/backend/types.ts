import type { LimitWindow, LiveTool, PermissionMode, ProviderError } from "@frizz/shared"
import type { FenceView, SubAgentView, BgShellView, PendingAskData, TurnState } from "../tailer.ts"

// A turn cut off by an exhausted SUBSCRIPTION window, as a backend's fold observed it. Carries only
// typed data — which window, when it happened, and the provider's stated reset clock in structured
// form. The raw error text never leaves the fold, matching the authFault discipline.
export interface LimitFault {
  window: LimitWindow
  at: string // ISO8601 of the limit record — when the agent got cut off
  resetClock?: { hour: number; minute: number; timeZone: string }
  // For a MODEL-scoped cap ("You've reached your Fable 5 limit"): the model name as the provider wrote
  // it. The scheduler matches it against the usage endpoint's `weekly-<model>` scoped window, which is
  // where this cap's live percent and reset instant actually live (the text itself carries neither).
  model?: string
  // Codex does not identify the exhausted window. Credits require a positive credit reading; other
  // limits can recover from fresh headroom across ALL reported windows. Neither guesses a reset.
  codex?: "usage" | "credits"
}

// ---- The agent-backend abstraction (Codex-support epic, Phase 1) ----
// One interface, one implementation per agent CLI. The server holds an AgentBackend per session and
// routes spawn / resume / transcript-location / line-folding through it, so the tailer + dispatcher
// stay backend-blind. Phase 1 ships ClaudeBackend as the sole implementation with byte-for-byte
// identical observable behavior; Phase 2 adds CodexBackend behind this same interface.

export type BackendKind = "claude" | "codex" | "acp"

// A backend-neutral transcript record: the vocabulary a backend's parser emits, and — for a backend
// whose turn model maps cleanly onto it (codex's explicit task_started/task_complete brackets) — the
// unit the tailer's generic fold would consume. Each backend maps its raw transcript lines onto this
// union; sidecar/unknown lines map to nothing (skipped).
//
// NOTE (Phase 1): Claude's OWN fold does NOT route through this union. Claude's turn signal is the
// 3-way assistant `stop_reason` (end_turn / tool_use / unknown-with-5s-backstop) that computeTurn and
// the corpus-verified tailer tests depend on, and that distinction cannot be expressed by
// turn-start/turn-end/assistant-text{final} without information loss. So ClaudeBackend keeps its
// corpus-verified applyRecord fold (AgentBackend.foldLine) and exposes parseLine only as the
// normalized VIEW — the codex-facing seam + the unit-test surface.
export type NormalizedEvent =
  | { kind: "turn-start"; at?: string } // a turn began (→ in-flight)
  | { kind: "turn-end"; at?: string; finalText?: string; successful?: boolean } // a turn finished (→ idle); finalText carries the fence
  | { kind: "provider-error"; at?: string; error: ProviderError }
  // `streamed` marks the text as ONE FLUSHED PIECE of a longer message rather than a whole one: the ACP
  // bridge writes an agent message's text out every second, so one message is several of these sharing a
  // messageId (absent when the agent names none — then every piece up to the next tool call is one
  // message, as the bridge's own `messageText` reads it). The fold joins the pieces before it reads a
  // ```question fence off them (FoldState.assistantMessage): a piece can end halfway through a fence, or
  // begin inside the code block that QUOTES one.
  | { kind: "assistant-text"; at?: string; text: string; final: boolean; streamed?: { messageId?: string } } // streamed assistant text (final=the answer, not commentary)
  | { kind: "user-message"; at?: string; text?: string; synthetic: boolean } // human turn (synthetic=peer/notification/tool-result echo — never bumps lastUserAt)
  | { kind: "tool-call"; at?: string; id: string; name: string; input: unknown }
  // `image` is a `data:image/…;base64,…` URL when the result CARRIED a picture (an MCP
  // `take_screenshot`, codex `view_image`). It is deliberately a SEPARATE channel from `text`: the text
  // is what the board fold, summaries and the output pane consume, and splicing megabytes of base64 into
  // it would push the blob through every one of them. Carrying the already-parsed string by reference
  // costs nothing; only the transcript projection reads it, and only to decode it to disk once.
  // `images` is every such picture in result order (`image` is its first entry): one exec-wrapper
  // script can view several files, and its one result carries one part per view.
  | { kind: "tool-result"; at?: string; id: string; text: string; image?: string; images?: string[] }
  | { kind: "reasoning"; at?: string; text: string } // model-reasoning SUMMARY (Codex plaintext summary[]; Claude thinking is redacted → never emitted)
  // A CHILD sub-agent reporting UPWARD into this session — codex's inter-agent `agent_message` record,
  // whose `author` is the child's agent path and whose `recipient` is ours. `final` splits the child's
  // TERMINAL return (codex "FINAL_ANSWER" — the completion notification) from a mid-flight progress
  // report ("MESSAGE"); the two render as the two wake dividers the Claude path already draws. This is
  // the child's output, NOT this session's, so the fold treats it as activity and nothing more.
  // Codex-only: Claude delivers both upward shapes as ordinary (synthetic) user records instead.
  | { kind: "agent-report"; at?: string; author: string; text: string; final: boolean }
  // A PARENT instruction arriving in this CHILD session. Codex records the plaintext envelope but
  // Fernet-encrypts the payload in current builds, so `text` is absent there; preserving the event
  // still lets the child's drawer show WHEN another task/steer arrived instead of silently skipping
  // the entire turn. An older/future build that records plaintext carries it verbatim.
  | { kind: "agent-instruction"; at?: string; author: string; text?: string; encrypted: boolean }
  | { kind: "title"; title: string } // backend's own session auto-title (ai-title / codex thread title)
  // Context COMPACTION: the harness replaced the conversation with a summary, so everything above this
  // point is gone from the agent's context. Both providers record it (Claude: a system/compact_boundary
  // record carrying preTokens/postTokens; codex: a top-level `compacted` envelope carrying none), which
  // is why the token fields are optional — a backend that doesn't measure it still reports the event.
  | { kind: "compaction"; at?: string; preTokens?: number; postTokens?: number }
  // Tokens occupying the model's context after its latest request (codex token_count). Pure telemetry:
  // it moves no turn state. It exists so a consumer can bracket a compaction it can't measure directly —
  // the codex reading is the token_count immediately before/after the `compacted` envelope — and so the
  // header can render how full the context is. `window` is the model's context size AS THE PROVIDER
  // REPORTS IT on the same event (codex: `info.model_context_window`), never a table we maintain: a
  // hardcoded window goes stale on exactly the schedule the codex version pin did. Optional because a
  // backend may measure the numerator without naming the denominator.
  | { kind: "context-usage"; at?: string; tokens: number; window?: number }

// The shape a backend's fold produces per session — the SAME shape board.ts already consumes as
// SessionTelemetry, minus `permPrompt` (which is sniffed off a live terminal screen, not folded from
// the transcript).
// A documented contract for what every backend's fold must surface; Phase-1 Claude realizes it as
// SessionTelemetry directly (see tailer.get()).
export interface NormalizedTail {
  turn: TurnState
  // Backend-observed session profile when its transcript records it. Claude assistant records expose
  // the actual model but not effort; codex turn_context exposes both. Optional by design.
  model?: string
  effort?: string
  profileAt?: string
  profileRevision?: number
  // Backend-observed permission/sandbox state. Codex emits this in turn_context and
  // thread_settings_applied; Claude emits permission-mode sidecars.
  permissionMode?: PermissionMode
  // Timestamp of the Codex profile event. Claude's permission-mode sidecar has no timestamp, so it
  // remains undefined there. Used to distinguish a pre-reattach Codex turn_context from a later
  // manual /permissions change.
  permissionModeAt?: string
  lastActivityAt?: string
  lastAssistantAt?: string // ISO8601 of the agent's OWN last output (rest time; excludes sub-agent/system bumps)
  lastAssistant?: string
  // The first non-empty line of the same text, newlines honoured — see FoldState.lastAssistantLine.
  lastAssistantLine?: string
  // The newest tool call awaiting its result (Claude only) — see TailState.liveTools in tailer.ts.
  liveTool?: LiveTool
  aiTitle?: string
  lastUserAt?: string
  // The newest delivery the worker took MID-TURN — see FoldState.lastMidTurnDeliveryAt.
  lastMidTurnDeliveryAt?: string
  // When the human last TYPED a message to the thread — see FoldState.restFromAt. Absent reads as `lastUserAt`.
  restFromAt?: string
  // When the worker last rested on a fence that needed the human — see FoldState.handoffAt.
  handoffAt?: string
  // When Frizz last delivered a ```question fence correction — see FoldState.questionCorrectedAt.
  questionCorrectedAt?: string
  lastUserText?: string // the newest drawn user turn's text, Frizz's deliveries included (confirms wake-token delivery)
  // The FIRST genuine human turn. Read by the board to NAME an external session whose harness has not
  // named it — see foreignThreadView. Optional everywhere: a transcript with no human turn has none.
  firstUserText?: string
  lastFence?: FenceView // parsed by the shared fence grammar from the final message
  pendingQuestion: boolean
  // The final message carries the AWAITING sentinel — the worker's answer to a stop hook when
  // nothing in it is actionable. Optional (absent ⇒ false) because it is an additive observation, not
  // a new required fact about a session; see scheduler.ts SOURCE 5.
  lastAssistantAllDone?: boolean
  // Live sub-agents. Claude fills these from its Agent dispatches (the tailer's trackDispatches); codex
  // from its `spawn_agent` children (codex-subagents.ts). Both land in the same TailState maps.
  subAgents: SubAgentView[]
  bgShells: BgShellView[] // codex: always [] (codex has no background-shell tool)
  pendingAsk?: PendingAskData // codex: undefined
  authFault?: "authentication_rejected" // runtime provider-auth rejection (see FoldState.authFault)
  apiFault?: boolean // the turn ended in a provider failure (see FoldState.apiFault)
  providerError?: ProviderError
  limitFault?: LimitFault // subscription window exhausted mid-turn (see FoldState.limitFault)
  contextTokens?: number // tokens the last request carried (see FoldState.contextTokens)
  contextWindow?: number // the context size this session RUNS IN (see FoldState.contextWindow)
  // ISO8601 of the newest CONTEXT COMPACTION, or absent if this session has never been compacted. It is
  // the trigger clock for scheduler SOURCE 7 (the recurring prompt's post-compaction delivery): a new
  // compaction necessarily carries a new instant, so "at most one delivery per compaction" falls out of
  // delivery-id uniqueness, exactly as the rest trigger gets it from lastActivityAt.
  lastCompactionAt?: string
}

// The backend-NEUTRAL fold accumulator: the running derivation a backend folds each transcript line
// into, and exactly the fields needed to produce a NormalizedTail. This is the state `foldLine`
// mutates — decoupled from the tailer's private TailState (which EXTENDS this, adding byte-cursor
// bookkeeping + Claude-only sub-agent/ask tracking + Claude's stop_reason turn inputs), so this
// interface no longer leaks Claude internals. A backend whose turn model maps onto NormalizedEvent
// (codex's explicit task_started/task_complete brackets) drives this via `applyEvent`; Claude reuses
// its corpus-verified `applyRecord` over the richer TailState (see the NOTE on NormalizedEvent).
/** One assistant message's ```question fences, kept so the registrar can mint their rows. `text` is
 *  the fences alone — each block's source, opener to closer — so a long handoff costs the tail cache only
 *  the part anyone will read, and `questionFenceBlocks` re-reads it exactly. */
export interface QuestionSighting {
  /** The record's own timestamp: the question's `asked_at`, and which rest it belongs to. */
  at: string
  text: string
}

export interface FoldState {
  turn: TurnState // in-flight while a turn runs; idle once it brackets closed
  sawRecords: boolean // any substantive record folded yet (a fresh/booting session guard)
  model?: string // latest concrete backend-observed model
  effort?: string // latest concrete backend-observed reasoning effort
  profileAt?: string // timestamp of latest model/effort record
  profileRevision?: number // increments even when a profile record repeats
  permissionMode?: PermissionMode // latest concrete backend-observed permission/sandbox mode
  permissionModeAt?: string // timestamp of the latest timestamped permission profile event
  permissionModeRevision?: number // increments for every profile record, even when the value repeats
  lastActivityAt?: string // ISO8601 of the latest timestamped event (ANY line, incl. sub-agent/system)
  lastAssistantAt?: string // ISO8601 of the agent's OWN last output — the rest-time key (see NormalizedTail)
  lastAssistant?: string // ~200-char preview of the latest assistant text
  // The first non-empty line of that same text, markdown intact — the handoff's verdict line. The
  // preview above cannot give it back: it collapses newlines to spaces, and its every reader (the
  // notification bodies, the tests pinning the flat shape) wants that. Set with it, always.
  lastAssistantLine?: string
  aiTitle?: string // the backend's own session auto-title (latest non-empty wins)
  // A backend may carry one in-band auto-title candidate on its first finalized response. Recording
  // that first final lets a backend distinguish a later recovery signal from an initial title; only a
  // replaceable automatic fallback may accept that later signal.
  titleCandidateFinalSeen?: boolean
  // Raw text of that first finalized response. Codex repeats the answer on task_complete; remembering
  // it lets the fold strip the same hidden marker from the echo without treating a later turn as a
  // second title candidate.
  titleCandidateFinalText?: string
  // Provenance for Codex's auto title. A bounded dispatch fallback exists only so an omitted in-band
  // signal never leaves the board on an internal slug; a later valid Frizz signal may replace it.
  // A generated signal or provider-native title is final for automatic naming (manual titles are
  // guarded separately by storage's title_auto CAS).
  autoTitleSource?: "fallback" | "frizz" | "native"
  // ISO8601 of the newest non-synthetic user turn — the human's, or a delivery of Frizz's (a wake, an
  // answer, a steer). The row-order key; `restFromAt` below is when the HUMAN last typed.
  lastUserAt?: string
  // WHEN THE WORKER LAST TOOK A DELIVERY MID-TURN. A message queued behind a running turn reaches the
  // model at its next tool boundary as a `queued_command` attachment, and no user record ever follows
  // it, so `lastUserAt` never moves for it. Anything asking "has the worker got the answer yet?"
  // reads the later of the two (board answersReceivedAt). Kept apart from `lastUserAt` on purpose: that
  // one also orders the rows and closes rests, and neither has been measured against mid-turn
  // deliveries. Stamped with the attachment's own timestamp, which is when the message was QUEUED.
  lastMidTurnDeliveryAt?: string
  // WHEN THE HUMAN LAST TYPED A MESSAGE TO THIS THREAD (shared isHumanTypedMessage) — the boundary an
  // open question stands across (question-fences.ts standingQuestions). Unlike `lastUserAt` it does NOT
  // move for anything Frizz delivers: a wake of any kind, a correction, a Goal prompt, an answer's
  // delivery, another thread's steer. Those all land as user records, and reading them as "the human
  // replied past the question" took a question out of the queue the moment a shell woke its worker
  // (2026-10-13). `lastUserAt` itself keeps moving on every one of them: it is the row-order key, and
  // how every "the agent spoke last" guard knows a delivery is unanswered.
  // A message typed while the worker is mid-turn moves it at the instant it was QUEUED, which is when
  // the human wrote it (applyRecord, noteQueuedMessage). Absent (a tail cached before 2026-10-13) reads
  // as `lastUserAt`.
  restFromAt?: string
  // WHEN THE WORKER LAST RESTED ON A HANDOFF: an ```awaiting fence answering `status: needs_input` (or
  // listing `steps:`). Unlike `lastFence` it is NOT cleared by a user record, because what it records is
  // an obligation on the reader, like a question: a later wake carrying no news let the worker re-park
  // `status: watching` and bury the handoff in Snoozed while the human still owed it a merge
  // (2026-10-27). The board holds such a thread in the queue until the human types past it or snoozes it
  // (board handoffStands).
  handoffAt?: string
  // The human messages QUEUED and not yet seen delivered, oldest first — so the record that delivers one
  // does not move `restFromAt` a second time, to an instant later than the human wrote it. Bounded.
  queuedHumanTexts?: string[]
  // When Frizz last DELIVERED a ```question fence correction (QUESTION_FENCE_CORRECTION_LEAD, alone or
  // inside a merged delivery). Every fault in a message older than this has been told to the worker, so
  // SOURCE 14 reports only the ones after it.
  questionCorrectedAt?: string
  lastUserText?: string // exact text of that same turn when the backend records it — a wake's carries its delivery token
  // The FIRST genuine human turn, kept forever — set once and never overwritten. It is what names an
  // EXTERNAL session (one of the human's own terminals) when its harness has not named it: both
  // Claude Code's and Codex's own resume pickers fall back to exactly this, verified by driving each
  // picker 2026-08-24. Distinct from lastUserText, which tracks the NEWEST turn for wake confirmation
  // and would drift off the topic the session started on.
  firstUserText?: string
  lastFence?: FenceView // done/awaiting excusal fence on the final message (cleared by any user turn)
  lastAssistantHasQuestion: boolean // the final message carries an unanswered ```question fence
  // Every assistant message that carried a ```question fence, newest last, capped (QUESTION_SIGHTINGS_MAX
  // in tailer.ts). NOT cleared by a user turn, unlike the two above: a fence registers a ROW, and the row
  // must be minted whether or not the worker said anything after it, so the server's registrar reads
  // these whatever has happened since (server question-fences.ts). Absent on a state folded before
  // 2026-10-13, which the fold-schema digest invalidates anyway.
  questionSightings?: QuestionSighting[]
  // The assistant message a NORMALIZED backend is in the middle of, for the sightings above: the instant
  // it began, and — when it arrives in streamed pieces (ACP) — its id and the text so far. Two readers:
  // a piece's fences are read off the whole message, never the piece, and a turn's closing bracket
  // echoing this message's text notes it at THIS instant, so the echo is the same sighting and not a
  // second one a beat later. Ended by a tool call, a user message or the next turn. Claude's fold never
  // sets it: its records are whole content blocks.
  assistantMessage?: { at?: string; id?: string; pieces?: string }
  // The final message answers a stop hook with AWAITING (scheduler.ts SOURCE 5). Folded and
  // cleared on exactly the same lifecycle as the question flag above: set per assistant text, wiped by
  // any user record — so the next bump the operator sends re-opens the loop by itself.
  lastAssistantAllDone: boolean
  // Runtime provider-auth rejection (claude-auth plan, Slice A). Set when the backend records a
  // SYNTHETIC auth-error response (Claude: isApiErrorMessage + 401/login text) — never from user or
  // ordinary assistant content — and cleared by the next real assistant text (a genuine response
  // proves the credential works). Only this typed category ever leaves the fold; raw error/terminal
  // text stays out of persisted state.
  authFault?: "authentication_rejected"
  // THE TURN NEVER REACHED THE MODEL, whatever the reason. The GENERAL case of the two faults either
  // side of it: set whenever the backend records a synthetic API-error response, cleared by the next
  // real assistant text, on exactly authFault's lifecycle. It exists because the specific classifiers
  // recognise only two categories — an auth rejection by its text, a usage limit by its structured
  // `error:"rate_limit"` — so every OTHER API error (a 400 for a context window the conversation has
  // outgrown, a 500, a transport failure) was indistinguishable from the agent taking a turn and
  // resting. Anything that treats "the agent spoke last" as "the agent rested" needs this, or it
  // re-prompts a thread whose every turn is failing. The scheduler needs only this fact; Codex also
  // carries sanitized display text in providerError so the operator can see why the request failed.
  apiFault?: boolean
  providerError?: ProviderError
  // Subscription usage-limit pause (auto-resume). Set when the backend records a limit stop — for
  // Claude the synthetic record carrying the structured `error:"rate_limit"` category, never a text
  // match — and cleared by the next real assistant text OR any user record. That clearing rule is
  // what makes a delivered "continue" supersede the fault it was fired for.
  limitFault?: LimitFault
  // ---- context occupancy (the header's fullness readout) ----
  // How many tokens the model's LAST request actually carried — i.e. how full its context is right
  // now. Both providers measure this themselves and both write it to their transcript, so this is
  // always a reading, never an estimate: codex reports `last_token_usage.total_tokens`; Claude's
  // per-assistant `message.usage` sums input + cache-creation + cache-read (the three components of
  // one request's input). It falls back down after a compaction, exactly as it should.
  contextTokens?: number
  // The context size this session actually RUNS IN. Deliberately not a per-model table: the window
  // depends on the concrete variant in play (a `[1m]` Claude alias reports 1_000_000 where the same
  // canonical model otherwise reports 200_000), so only the provider can answer for THIS session.
  // Codex names it on every token_count; Claude names it on the SDK `result` message, which means a
  // Claude row has a numerator from its first assistant record but no denominator until its first turn
  // ends — and a pre-broker/foreign Claude row never gets one at all. Absent ⇒ NO reading is rendered.
  //
  // "Runs in", not "the model's size", because a Claude worker's AUTO-COMPACT CEILING lowers it: frizz
  // dispatches at the 1M window and then hands the CLI a 500K CLAUDE_CODE_AUTO_COMPACT_WINDOW, and
  // Claude Code's effective window is `min` of the two — so the room this session has is 500K and
  // dividing by 1M reported it a comfortable 25% full at the moment it was half full (2026-09-01). The
  // lowering happens once, in ClaudeRuntimeIngest.contextWindow, so every reader downstream of it —
  // this field, ThreadView.context, the header's context reading — carries one number with one meaning.
  contextWindow?: number
  // Newest context compaction — the post-compaction trigger's clock (see NormalizedTail.lastCompactionAt).
  // The two backends observe it differently and neither has a second signal: Claude injects its
  // carry-over summary as an ordinary user record flagged `isCompactSummary`, while codex emits an
  // explicit `compaction` normalized event. Both are the harness's work, not the agent's, so this is the
  // ONLY field either of them moves — turn state, preview, fence and row order all stay put.
  lastCompactionAt?: string
}

// A file a backend needs on disk BEFORE the detached spawn (e.g. codex's session-scoped AGENTS.md).
// Claude's system prompt rides a file too, but buildClaudeCommand writes it as a side effect, so
// ClaudeBackend returns an empty prewrite list.
export interface PrewriteFile {
  path: string
  contents: string
  // Sensitive prompt transports should be owner-only while the spawned CLI is consuming them.
  // Optional so existing backend prewrites retain their current platform default.
  mode?: number
}

export interface BuiltCommand {
  argv: string[]
  env: Record<string, string>
  prewrite: PrewriteFile[]
}

// The ONE unified frizz MCP server every worker gets: mounted under the name `frizz`, so its tools are
// addressed as `mcp__frizz__<tool>` (`spawn_thread`, `goal` and `timer` today — new
// worker-facing frizz capabilities join the same server's registry in cc-worker/bin/frizz-mcp.mjs rather
// than mounting a second server). The dispatch layer pre-approves it at SERVER level (`mcp__frizz`), so a
// tool added there needs no allow-list change here.
export const FRIZZ_MCP = {
  name: "frizz",
  script: "frizz-mcp.mjs", // resolved under <worker plugin dir>/bin/
} as const

// Present ⇒ mount FRIZZ_MCP for this worker. Carries the abs path to the stdio MCP server script and
// the project state dir it reads `server.lock` from. Computed by the dispatch layer
// (resolveWorkerPluginDir + project.stateDir) and threaded through both backends; absent in tests /
// when the plugin dir or script can't be resolved (→ no injection, worker simply lacks the tools).
export interface FrizzMcp {
  scriptPath: string
  stateDir: string
  // WHERE THE PORT ACTUALLY IS. `server.lock` is written for the project the singleton was LAUNCHED
  // from and for no other (index.ts, "status publication"), so a worker in any OTHER open project
  // read its own project's state dir and found nothing — every frizz tool died on
  // "could not read the frizz server lock … ENOENT", or worse, on a stale lock from the last time
  // that repo ran its own server (a dead port ⇒ "dispatch request failed: fetch failed"). Absent ⇒
  // the script falls back to `<stateDir>/server.lock`, which is what a pre-singleton server passed.
  serverLock?: string
  // WHICH PROJECT the tools act on, as the immutable registry id — the script addresses
  // `/_frizz/<projectId>/rpc/…`. An UNPREFIXED `/_frizz/rpc/…` is the LAUNCHING project by design
  // (splitTenantRequest), so without this a worker in project B spawned its thread onto project A's
  // board. The id rather than the slug because a project can be renamed under a live detached worker.
  projectId?: string
  // The thread this MCP server belongs to, passed through as FRIZZ_THREAD_SLUG so a tool CAN act on its
  // OWN thread. Nothing in the MCP protocol identifies the caller, and the server is spawned per worker,
  // so its env is the only channel for this.
  //
  // IT IS LOAD-BEARING NOW. This once read "currently read by no shipped tool", which was true when the
  // only tool was `spawn_thread`. Ten tools resolve their caller through it today — `title`, `ask`,
  // `unask`, `done`, `watch`, `unwatch`, `watch_pr`, `timer`, `goal`, `activity` — and every one of
  // them FAILS without it. Absent on codex until 2026-09-04, because the codex mount is process-wide
  // (see codex-mcp.ts `codexThreadMcpConfig` for what that cost and how it is carried now).
  slug?: string
}

/**
 * The env the frizz MCP server process is spawned with — ONE builder, because both backends mount the
 * same script and a field added on only one side is a capability that silently works under claude and
 * not under codex (or the reverse), discoverable only by running a worker.
 */
export function frizzMcpEnv(mcp: FrizzMcp): Record<string, string> {
  return {
    FRIZZ_STATE_DIR: mcp.stateDir,
    ...(mcp.serverLock ? { FRIZZ_SERVER_LOCK: mcp.serverLock } : {}),
    ...(mcp.projectId ? { FRIZZ_PROJECT_ID: mcp.projectId } : {}),
    ...(mcp.slug ? { FRIZZ_THREAD_SLUG: mcp.slug } : {}),
  }
}

// ---- The worker command line ---------------------------------------------------------------------
// `frizzctl` (cc-worker/bin/) is how a worker reaches Frizz: every worker capability is a command it
// runs from its own shell, on every backend, and none of them is a tool in the model's registry. So
// what a backend owes a worker is no longer a mount; it is an ENVIRONMENT — the command on PATH, and
// the handful of facts the command reads to find the server and to know who is calling.
export const FRIZZ_CLI = {
  name: "frizzctl", // resolved under <worker plugin dir>/bin/
} as const

// Present ⇒ this worker's shell can run FRIZZ_CLI. Computed by the dispatch layer (resolveFrizzCli)
// and threaded through every backend; absent in tests / when the plugin dir can't be resolved.
export interface FrizzCli {
  // The directory that goes on the worker's PATH: `<worker plugin dir>/bin`. The STABLE plugin path
  // where there is one (dispatch.ts launchableWorkerPluginDir), so a worker that outlives an update
  // runs the updated command — a shell resolves it per call, which is exactly what an MCP server
  // spawned once per session could not do.
  binDir: string
  stateDir: string
  // See FrizzMcp: the machine address, and the immutable registry id the command addresses
  // `/_frizz/<projectId>/rpc/…` by.
  serverLock?: string
  projectId?: string
}

/**
 * What `frizzctl` reads, as the variables a worker's shell must hold — ONE builder for every backend,
 * for the reason frizzMcpEnv is one: a variable set on one side only is a capability that works under
 * claude and not under codex, discoverable only by running a worker.
 *
 * `slug` is the caller's identity and belongs here only where the process this environment is for
 * serves ONE thread (an ACP agent daemon, a codex thread's own shell). A codex app-server serves every
 * thread in its project, so its process environment cannot name one — see codexThreadShellConfig.
 *
 * IT IS FRIZZ_THREAD_SLUG, NEVER FRIZZ_THREAD. The two read the same to `frizzctl`, but FRIZZ_THREAD is
 * also the orphan reaper's ownership tag (orphan-reaper.ts): a process carrying it is reaped once it is
 * two minutes old unless a live `claude`/`codex` session root carries the same slug. A Claude worker
 * has that root, and its broker stamps FRIZZ_THREAD itself. A codex thread's shell runs under a
 * per-project app-server that carries no slug, and an ACP agent is neither `claude` nor `codex`, so the
 * tag there would have the reaper SIGKILL a codex thread's two-minute build and an ACP agent with its
 * whole subtree.
 *
 * FRIZZ_NODE is the node this server runs on: the command's launcher tries it before a bare `node`,
 * because a worker's PATH varies by launch context and the launcher must not depend on it.
 */
export function frizzCliEnv(cli: FrizzCli, slug?: string, nodeBin: string = process.execPath): Record<string, string> {
  return {
    FRIZZ_STATE_DIR: cli.stateDir,
    ...(cli.serverLock ? { FRIZZ_SERVER_LOCK: cli.serverLock } : {}),
    ...(cli.projectId ? { FRIZZ_PROJECT_ID: cli.projectId } : {}),
    FRIZZ_NODE: nodeBin,
    ...(slug ? { FRIZZ_THREAD_SLUG: slug } : {}),
  }
}

/**
 * `env` with the command's directory FIRST on its PATH, under whatever spelling the key already has
 * (Windows calls it `Path`). An environment with no PATH at all is left without one: a PATH holding
 * only our directory would take `/usr/bin` away from every other command the worker runs.
 *
 * Not needed for a Claude worker — Claude Code puts an enabled plugin's `bin/` on its Bash PATH
 * itself — and harmless there.
 */
export function withFrizzCliOnPath(env: Record<string, string>, cli: FrizzCli, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const key = Object.keys(env).find((k) => (platform === "win32" ? k.toUpperCase() === "PATH" : k === "PATH"))
  if (!key || !env[key]) return env
  const delimiter = platform === "win32" ? ";" : ":"
  if (env[key].split(delimiter).includes(cli.binDir)) return env
  return { ...env, [key]: `${cli.binDir}${delimiter}${env[key]}` }
}

// Frizz mounts NO browser. The only MCP server it injects into a worker is the unified `frizz`
// server above (claude: a `--mcp-config` file in dispatch.ts; codex: `-c` TOML overrides on the
// app-server argv in codex-mcp.ts). A `chrome-devtools` mount used to ride every dispatch on both
// backends, together with a lazy proxy in `cc-worker/bin/` that answered `tools/list` from a
// committed schema snapshot; all of it was removed 2026-08-26. Two reasons: its 29 tool schemas cost
// ~6,400 prefix tokens on EVERY worker session, and most workers never open a page — and mounting a
// browser nobody asked for is an opinion Frizz has no business holding. A project or an operator that
// wants one brings it themselves, the same way they would in any other Claude Code or codex session:
// a project `.mcp.json` (this repo has one, pinned `--headless --isolated`). Since 2026-09-03 a worker
// mounts under `--strict-mcp-config`, so `claude mcp add --scope user` reaches the operator's own
// sessions but not the fleet — a user-scope stdio server was booting in every worker, twice over; see
// project-mcp-servers.ts. Do not re-add a mount here.

// The environment EVERY frizz Claude worker gets, on EVERY spawn path. Kept as one record with one
// spread per call site (the bridge's `workerEnv` for the broker daemon, the SDK's key allowlist, and
// claudeWorkerEnvironment() for the argv builder) so a new entry cannot reach one path and silently
// miss the other. Spread it, never re-spell a key — a typo here is silent, and each failure mode
// below is quiet.
//
// Distinct from claudeWorkerEnvironment()'s CAPS, which only ever reached a worker frizz launched as
// its own `claude` process: these are settings a worker needs on whichever path it was dispatched
// through.
//
// ── CLAUDE_CODE_TOTAL_TOKENS_REMINDER ──────────────────────────────────────────────────────────
// The token budget a Claude worker is TOLD it has. Claude Code's `totalTokensReminder` writes a
// `<total_tokens>N tokens left</total_tokens>` block into the system prompt and after every
// tool-result batch; `infinite` renders the literal `Infinite`. Default is `off` — no block at all.
//
// WHY A FRIZZ WORKER OVERRIDES THAT DEFAULT: with no block, the model has no signal about its budget
// and it GUESSES — badly, and always downward. Claude Code injects nothing else about context: no
// system-reminder in cli 2.1.220 mentions tokens, and the "Context is N% full" warning is `/context`
// TUI text the model never sees. Measured on a real worker (nub session 5258ebe4, transcript line
// 31014) it wrote "I'm near my context limit, so I'm not starting the linker change here" at a live
// fill of 667,277 tokens, against auto-compact boundaries that fired at ~1,000,000 — a third of the
// window still free. Earlier in that same session, 13 consecutive turns declared "I'm out of context"
// at fills of 176k–244k (under a quarter of the window), and at line 20628 it named the pattern
// itself: "I've been treating 'low context' as a stopping condition for the last several turns and
// winding down instead of working." Eight other long worker sessions END at 616k–940k with 25–38% of
// the window unused. Compaction is not cutting these sessions off — they are quitting early.
//
// `infinite` and not `countdown`: a live remaining-token count is still a shrinking number, which is
// the exact input to the bad inference. Claude Code's own autocompact system prompt already tells the
// model "your conversation with the user is not limited by the context window" — `Infinite` restates
// that in the one place the model looks for a budget, and it is TRUE for a frizz worker, whose session
// compacts and continues rather than ending.
//
// The env var is the highest-precedence source, ahead of `totalTokensReminder` in settings and the
// server-side `tengu_lapis_anchor` flag (verified against cli 2.1.220). Its failure mode if dropped
// is a worker that quits at 60% of its window.
//
// ── BASH_DEFAULT_TIMEOUT_MS ────────────────────────────────────────────────────────────────────
// How long a FOREGROUND Bash call that names no `timeout` runs before Claude Code moves it to the
// background. DELIBERATELY NOT SET: a worker runs on Claude Code's own default, 120_000 (2 min) in cli
// 2.1.293, and follows it if Claude Code moves it (maintainer 2026-10-10: "we should just let the
// agent follow its own best practices here as much as possible").
//
// Frizz pinned it at 60_000 from 2026-08-01 until then, so that a call the worker had not thought
// about — a hung `curl` — bounced in a minute rather than sitting on the turn. Do not bring the pin
// back to shorten a blocked turn: two minutes is the harness's own answer to that, and the ceiling
// below governs the call a worker sized deliberately. With nothing set here, a value the operator
// exported before launching Frizz reaches the worker like any other variable (see worker-env.ts).
//
// ── BASH_MAX_TIMEOUT_MS ────────────────────────────────────────────────────────────────────────
// The ceiling on an EXPLICIT `timeout`, lifted from Claude Code's 600_000 to 24 hours on 2026-08-11
// (maintainer: "lift the cap globally, so a worker can block on anything it chooses").
//
// A worker can now block for as long as the thing it is blocking on actually takes. The value that
// makes this safe is not the ceiling, it is that a blocking wait is DELIBERATE: frizz's own watcher
// tools require a timeout, and a Bash call that names one has been sized by a worker that knew what it
// was waiting for. The failure the old ceiling guarded — an opaque turn nobody can distinguish from a
// wedged one — is answered instead by the live tool caption, which names what is running for as long as
// it runs.
//
// 24 HOURS rather than "no limit", because that is already frizz's word for the longest thing a worker
// may ask for anywhere else (RECURRING_MAX_INTERVAL_SECONDS). One ceiling vocabulary, not two.
//
// The Bash tool's own description interpolates the default and this ceiling (`` `timeout` is in
// milliseconds: default ${...}, max ${...}``), so the worker is told these numbers rather than a stale
// pair.
//
// This does NOT relax the escaping-background-job rule that hooks/bash-background.mjs enforces. That
// hook is about lifecycle identity (`cmd &` leaves a child frizz and Claude cannot wake on); this is
// only about how long a tracked foreground call is allowed to take before the harness backgrounds it
// ITSELF, which keeps the task id and the wake. The two are independent.

// Claude Code caps WebSearch at 200 calls per SESSION (verified in the 2.1.220 bundle:
// `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION ?? 200`, enforced in the WebSearch tool against a
// `taskRegistry` counter). A frizz worker is long-lived and research-heavy — it burns that budget on
// work a chat session never would — and past the cap the tool stops searching and merely returns
// "this session has used its web search budget", which reads to the model as a dead end rather than
// as a quota. Raise it far enough that a real effort never hits it, while keeping a finite backstop
// against a runaway search loop; Claude Code has no unlimited sentinel, so a large integer is the
// only expression of "effectively uncapped".
export const WORKER_MAX_WEB_SEARCHES = 10000

// The SAME quiet-cap problem, on the sub-agent path (verified in the same 2.1.220 bundle — all three
// read `Z.<VAR> ?? <default>` through the identical `int({min:1,digitsOnly:true})` parser):
//
//   CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION  default 200 — TOTAL Task spawns for the whole session.
//     Past it every spawn throws "Subagent spawn limit reached (N of 200 agents spawned)… ask the user
//     to raise CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION". A frizz worker is long-lived and dispatches a
//     helper per prong across many turns, so it reaches 200 on work a chat session never would — and
//     the failure reads to the model as "stop delegating", not as a quota. Lifted like the search
//     budget: no machine cost to a high ceiling, since this counts spawns over time, not live ones.
//
//   CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS   default 20 — LIVE agents at once. Past it a spawn throws
//     "Concurrent subagent limit reached… Do not retry", so a fan-out wider than 20 silently loses its
//     tail. Raised, but NOT to the same sentinel: every live sub-agent is a real process and API
//     stream on this machine, so this one is a genuine resource dial (the orphan-reaper work exists
//     because runaway fan-out really does burn the box). 100 clears any real fan-out with a bound left.
//
// NOT lifted: CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH. Its default is not a constant at all — it resolves
// through a server-gated feature value — but the worker contract already tells workers to keep fan-out
// shallow because a rested sub-agent is not reliably re-woken by grandchildren. Raising the nesting cap
// would buy depth that frizz's own wake path cannot deliver on, so the cap and the contract agree.
export const WORKER_MAX_SUBAGENTS = 10000
export const WORKER_MAX_CONCURRENT_SUBAGENTS = 100

// Claude Code parses these variables as a strictly-digits integer >= 1 (`int({min:1,digitsOnly:true})`)
// and silently falls back to its own default on anything else, so an operator override is honored
// only in exactly that shape.
function workerCap(name: string, lifted: number, env: NodeJS.ProcessEnv): string {
  const override = env[name]
  if (override !== undefined && /^[1-9][0-9]*$/.test(override)) return override
  return String(lifted)
}

// Claude Code reads these inherited process variables as sub-agent profile defaults. A Frizz worker
// chooses its profile explicitly through the launch argv and plugin agent profiles, so let neither
// a shell nor a globally configured Claude session silently replace that selection. An EMPTY entry
// here overrides the inherited value while preserving every auth/config variable.
//
// The CAPS are the deliberate exception to that masking: a profile override hijacks the worker's
// identity, but a cap is operator policy, so an explicitly configured one is passed through rather
// than overridden. They are always set EXPLICITLY (never left to inheritance) because inheritance is
// not a stable source: a worker used to be launched inside a long-lived multiplexer server whose own
// environment was captured whenever IT first started, which could predate the current frizz process
// by days. Nothing inherits that way now, but an explicit value is still the only one that cannot
// drift with the launch context.

export const CLAUDE_WORKER_ENV = {
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "infinite",
  BASH_MAX_TIMEOUT_MS: String(24 * 60 * 60 * 1000),
  // Claude Code 2.1.302 turned fork sub-agents ON by default for Agent SDK sessions: the Agent tool
  // began offering `subagent_type: "fork"`, a child that inherits the parent's whole conversation.
  // The worker contract (workerPrompt.ts) tells every worker the opposite — no fork exists, each child
  // starts fresh, and handing it context is the worker's lever — so this keeps the tool matching the
  // contract. Measured on 2.1.302 through the real SDK path: the Agent tool's description named fork
  // six times with this unset and not at all with it set to "0", exactly as on 2.1.301.
  CLAUDE_CODE_FORK_SUBAGENT: "0",
} as const

// EVERY Claude worker's environment, on EVERY transport — the static entries in CLAUDE_WORKER_ENV plus
// the lifted caps above. One function, spread whole at each call site, because the caps spent their
// whole life on the argv builder alone: `claudeWorkerEnvironment()` set them, nothing but the retired
// argv path called it, and the broker — the only transport there is — spread CLAUDE_WORKER_ENV, which
// did not carry them. So every lift documented above reached no worker at all, and a real frizz worker
// ran on Claude Code's own 200/200/20 defaults (found 2026-08-19 while clearing out the multiplexer's
// remains). Add a cap HERE, never at a call site, and it cannot miss a path again.
export function claudeWorkerEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    ...CLAUDE_WORKER_ENV,
    CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: workerCap("CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION", WORKER_MAX_WEB_SEARCHES, env),
    CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: workerCap("CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION", WORKER_MAX_SUBAGENTS, env),
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: workerCap("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", WORKER_MAX_CONCURRENT_SUBAGENTS, env),
  }
}

// The auto-compact ceiling a Claude worker runs under, from Settings. Claude Code reads
// CLAUDE_CODE_AUTO_COMPACT_WINDOW as a token count and caps it to the model's real window, so a value
// above a 200K model's window is harmless. Unset ⇒ nothing is passed and the CLI uses its own default
// for the model — the whole 1M window on a `[1m]` model, which is exactly the growth this exists to
// stop (Settings.autoCompactWindow explains the cost). Composed into the worker environment on every
// fresh daemon fork; a daemon already running keeps the value it was forked with.
export const CLAUDE_AUTO_COMPACT_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW"

export function claudeCompactionEnv(settings: { autoCompactWindow?: number } | undefined): Record<string, string> {
  const window = settings?.autoCompactWindow
  if (window === undefined || !Number.isInteger(window) || window <= 0) return {}
  return { [CLAUDE_AUTO_COMPACT_WINDOW_ENV]: String(window) }
}

// The context window a Codex thread runs with, from Settings — the codex twin of claudeCompactionEnv.
// Codex reads `model_context_window` as a config override and clamps it to the model's
// `max_context_window` (codex-rs models-manager `with_config_overrides`), so a value above the cap is
// harmless; its auto-compact threshold follows at 90% of the resolved window, so this is also the
// compaction dial. Unset ⇒ nothing is sent and the model's stock window applies. Rides the `config`
// bag of `thread/start` and every cold `thread/resume` (CodexAppServerBridge.threadConfig), so it takes
// effect on the next thread and on a thread the app-server picks back up — never on a thread whose
// app-server already holds it. Measured 2026-09-11 on codex-cli 0.153.2 against gpt-5.6-sol: no
// override → 258_400 reported (272K × 95% usable), 600_000 → 570_000, 1_000_000 → 828_400 (872K cap).
export const CODEX_CONTEXT_WINDOW_KEY = "model_context_window"

export function codexContextWindowConfig(settings: { codexContextWindow?: number } | undefined): Record<string, unknown> {
  const window = settings?.codexContextWindow
  if (window === undefined || !Number.isInteger(window) || window <= 0) return {}
  return { [CODEX_CONTEXT_WINDOW_KEY]: window }
}

// The prompt-cache tier a Claude worker writes to, from Settings. Claude Code reads
// CLAUDE_CODE_PROMPT_CACHE_TTL as "5m" or "1h"; unset, it picks 1h on a subscription within its usage
// limits (the CLI's own help text for the variable, 2.1.259). The tiers differ in the WRITE price: a
// 1h entry bills at 2x the input rate, a 5m entry at 1.25x. Measured 2026-09-03 across every worker:
// cache writes were 51% of the day's spend, all on the 1h tier, while the per-session entries were
// invalidated every 15–30 minutes by something outside the session (every active session in every
// project lost its entry within the same minute, 61 times in one morning) — the hour of warmth was
// paid for and rarely delivered. "auto" (or anything unrecognised) passes nothing, so the CLI keeps
// its own choice. Composed into the environment of every fresh daemon fork beside the compaction
// window; a daemon already running keeps the tier it was forked with. The sub-agent variable rides
// along so a worker's helpers write to the same tier as their parent.
export const CLAUDE_PROMPT_CACHE_TTL_ENV = "CLAUDE_CODE_PROMPT_CACHE_TTL"
export const CLAUDE_SUBAGENT_PROMPT_CACHE_TTL_ENV = "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL"

export function claudePromptCacheEnv(settings: { promptCacheTtl?: string } | undefined): Record<string, string> {
  const ttl = settings?.promptCacheTtl
  if (ttl !== "5m" && ttl !== "1h") return {}
  return { [CLAUDE_PROMPT_CACHE_TTL_ENV]: ttl, [CLAUDE_SUBAGENT_PROMPT_CACHE_TTL_ENV]: ttl }
}

// The ceiling READ BACK OUT of a composed worker environment — the same value `claudeCompactionEnv`
// wrote, recovered where the number matters rather than the variable. Two callers, both of which must
// agree with what the CLI is actually running under: the daemon stamps it onto its record at fork
// (BrokerRecord.compactionWindow), and the bridge reports it to the runtime ingest, which lowers the
// board's context denominator to it (ClaudeRuntimeIngest.noteCompactionWindow). Round-tripping through
// the environment rather than re-reading Settings is the whole point — Settings moves, a forked daemon
// does not. Anything unparseable reads as absent; a fabricated denominator is worse than none.
export function claudeCompactionWindowOf(env: Record<string, string> | undefined): number | undefined {
  const raw = env?.[CLAUDE_AUTO_COMPACT_WINDOW_ENV]
  if (raw === undefined) return undefined
  const window = Number(raw)
  return Number.isInteger(window) && window > 0 ? window : undefined
}

// Tools an ARGV-SPAWNED Claude worker never gets — the argv turns this into `--disallowedTools=…`.
//
// ARGV PATH ONLY, and the asymmetry is deliberate. A worker frizz launched as its own interactive
// `claude` process answered AskUserQuestion with a native TUI dialog on a terminal screen nobody was
// watching, so the question had literally nowhere to go and the session froze invisibly. The BROKER
// path — how every Claude thread is dispatched today — does NOT pass this: it intercepts the same call
// at canUseTool and renders a real dashboard question card whose answer reaches the model
// (claude-agent-broker.ts says so at the query site).
//
// The other hazard — a parked turn swallowing a follow-up the operator typed instead of answering —
// argued for blocking it on both paths for a few hours on 2026-08-02. It is handled where it actually
// lives instead: the bridge retires an open card when a follow-up arrives, which unwinds the tool call
// and lets the turn read the message. See `retirePendingFor`.
export const WORKER_DISALLOWED_TOOLS = ["AskUserQuestion"] as const

export interface SpawnOpts {
  sessionId: string // claude: pinned via --session-id. codex: advisory (id is discovered post-spawn)
  cwd: string
  prompt: string // the composed first user message (task + orientation)
  workerContract: string // workerPrompt.ts norms — injected at system level per backend
  extraSystemPrompt?: string // scratchpad/plan orientation
  permissionMode: PermissionMode
  model?: string
  effort?: string
  frizzMcp?: FrizzMcp
}
export interface ResumeOpts extends Omit<SpawnOpts, "prompt"> {
  // Omitted when frizz is only re-attaching an idle saved conversation to apply a per-thread
  // permission change. Present for an ordinary dead-session follow-up.
  message?: string
}

export interface AgentBackend {
  readonly kind: BackendKind

  // ---- spawn / resume (argv + injection) ----
  // Build the detached-spawn argv + any files that must exist on disk first: a caller launches the
  // provider CLI itself with that argv, cwd and env once the prewrite files are on disk. No dispatch
  // path does that today — a Claude thread runs inside the session broker daemon and a codex thread
  // inside the app-server daemon — so this survives as the argv contract its unit tests pin
  // (CodexBackend's implementation throws outright).
  buildSpawn(opts: SpawnOpts): BuiltCommand
  // Resume/reattach the pinned session; `message` starts a turn when present, otherwise the CLI opens
  // idle at its prompt (used for a controlled permission-profile restart).
  buildResume(opts: ResumeOpts): BuiltCommand

  // ---- transcript location ----
  // Deterministic path for a session's transcript (claude: <logDir>/<sessionId>.jsonl), or undefined
  // when it can't be computed yet (codex: the rollout id isn't known until the process writes
  // session_meta — discoverSession then resolves it).
  transcriptPath(sessionId: string): string | undefined
  // Phase 2 (codex) only — ClaudeBackend omits it (its path is deterministic from the pinned id).
  discoverSession?(cwd: string, spawnedAtMs: number): { sessionId: string; path: string } | undefined

  // ---- parsing ----
  // Pure, defensive NORMALIZED view of one raw transcript line (bad line → []). The codex-facing seam
  // + the unit-test surface. A backend whose turn model maps onto NormalizedEvent drives its fold off
  // this; Claude does not (see the NOTE on NormalizedEvent).
  parseLine(line: string): NormalizedEvent[]
  // The AUTHORITATIVE per-backend fold the tailer's driver invokes: fold one raw transcript line into
  // the backend-neutral session accumulator (FoldState). Claude reuses its corpus-verified applyRecord
  // (narrowing FoldState back to the concrete TailState the tailer hands it); a codex backend can
  // implement this as `for (const ev of this.parseLine(line)) applyEvent(state, ev)`.
  foldLine(state: FoldState, line: string): void
}
