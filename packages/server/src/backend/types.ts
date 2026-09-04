import type { LimitWindow, PermissionMode } from "@frizz/shared"
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
}

// ---- The agent-backend abstraction (Codex-support epic, Phase 1) ----
// One interface, one implementation per agent CLI. The server holds an AgentBackend per session and
// routes spawn / resume / transcript-location / line-folding through it, so the tailer + dispatcher
// stay backend-blind. Phase 1 ships ClaudeBackend as the sole implementation with byte-for-byte
// identical observable behavior; Phase 2 adds CodexBackend behind this same interface.

export type BackendKind = "claude" | "codex"

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
  | { kind: "turn-end"; at?: string; finalText?: string } // a turn finished (→ idle); finalText carries the fence
  | { kind: "assistant-text"; at?: string; text: string; final: boolean } // streamed assistant text (final=the answer, not commentary)
  | { kind: "user-message"; at?: string; text?: string; synthetic: boolean } // human turn (synthetic=peer/notification/tool-result echo — never bumps lastUserAt)
  | { kind: "tool-call"; at?: string; id: string; name: string; input: unknown }
  // `image` is a `data:image/…;base64,…` URL when the result CARRIED a picture (an MCP
  // `take_screenshot`, codex `view_image`). It is deliberately a SEPARATE channel from `text`: the text
  // is what the board fold, summaries and the output pane consume, and splicing megabytes of base64 into
  // it would push the blob through every one of them. Carrying the already-parsed string by reference
  // costs nothing; only the transcript projection reads it, and only to decode it to disk once.
  | { kind: "tool-result"; at?: string; id: string; text: string; image?: string }
  | { kind: "reasoning"; at?: string; text: string } // model-reasoning SUMMARY (Codex plaintext summary[]; Claude thinking is redacted → never emitted)
  // A CHILD sub-agent reporting UPWARD into this session — codex's inter-agent `agent_message` record,
  // whose `author` is the child's agent path and whose `recipient` is ours. `final` splits the child's
  // TERMINAL return (codex "FINAL_ANSWER" — the completion notification) from a mid-flight progress
  // report ("MESSAGE"); the two render as the two wake dividers the Claude path already draws. This is
  // the child's output, NOT this session's, so the fold treats it as activity and nothing more.
  // Codex-only: Claude delivers both upward shapes as ordinary (synthetic) user records instead.
  | { kind: "agent-report"; at?: string; author: string; text: string; final: boolean }
  | { kind: "title"; title: string } // backend's own session auto-title (ai-title / codex thread title)
  // Context COMPACTION: the harness replaced the conversation with a summary, so everything above this
  // point is gone from the agent's context. Both providers record it (Claude: a system/compact_boundary
  // record carrying preTokens/postTokens; codex: a top-level `compacted` envelope carrying none), which
  // is why the token fields are optional — a backend that doesn't measure it still reports the event.
  | { kind: "compaction"; at?: string; preTokens?: number; postTokens?: number }
  // Tokens occupying the model's context after its latest request (codex token_count). Pure telemetry:
  // it moves no turn state. It exists so a consumer can bracket a compaction it can't measure directly —
  // the codex reading is the token_count immediately before/after the `compacted` envelope — and so the
  // footer can render how full the context is. `window` is the model's context size AS THE PROVIDER
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
  aiTitle?: string
  lastUserAt?: string
  lastUserText?: string // latest genuine human message (used to confirm wake-token delivery)
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
  apiFault?: boolean // the final assistant record is a synthetic API-ERROR record (see FoldState.apiFault)
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
  lastUserAt?: string // ISO8601 of the newest GENUINE (non-synthetic) human turn — the listing sort key
  lastUserText?: string // exact text of that genuine human turn when the backend records it
  // The FIRST genuine human turn, kept forever — set once and never overwritten. It is what names an
  // EXTERNAL session (one of the human's own terminals) when its harness has not named it: both
  // Claude Code's and Codex's own resume pickers fall back to exactly this, verified by driving each
  // picker 2026-08-24. Distinct from lastUserText, which tracks the NEWEST turn for wake confirmation
  // and would drift off the topic the session started on.
  firstUserText?: string
  lastFence?: FenceView // done/awaiting excusal fence on the final message (cleared by any user turn)
  lastAssistantHasQuestion: boolean // the final message carries an unanswered ```question fence
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
  // re-prompts a thread whose every turn is failing. Boolean because the discipline of this fold is
  // that raw provider text never leaves it, and no consumer needs more than the fact.
  apiFault?: boolean
  // Subscription usage-limit pause (auto-resume). Set when the backend records a limit stop — for
  // Claude the synthetic record carrying the structured `error:"rate_limit"` category, never a text
  // match — and cleared by the next real assistant text OR any user record. That clearing rule is
  // what makes a delivered "continue" supersede the fault it was fired for.
  limitFault?: LimitFault
  // ---- context occupancy (the footer's fullness readout) ----
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
  // this field, ThreadView.context, the footer dial — carries one number with one meaning.
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

// Frizz mounts NO browser. The only MCP server it injects into a worker is the unified `frizz`
// server above (claude: an inline `--mcp-config` in dispatch.ts; codex: `-c` TOML overrides on the
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
// How long a FOREGROUND Bash call runs before Claude Code moves it to the background. Claude Code's
// default is 120_000 (2 min) with a ceiling of 600_000 (10 min); we sit BELOW both at 60_000, which
// the maintainer chose on 2026-08-01 — reversing the same-day call to take the ceiling.
//
// WHY: the earlier reasoning optimized for the long gate (`nub run test` is ~5 min) and paid for it
// with a turn that can sit blocked for ten minutes on one call. A blocked turn is the worse failure:
// the worker is doing nothing recoverable, the board shows a card that cannot be steered, and the
// operator cannot tell a slow gate from a wedged one. Bouncing at a minute costs a poll cycle to
// recover the result and keeps the turn moving in the meantime.
//
// THAT REASONING STILL GOVERNS THE DEFAULT, and only the default. It is about the call the worker did
// NOT think about: a hung `curl` should bounce in a minute, not sit on the turn. It says nothing about
// a call the worker sized deliberately, which is the case the CEILING below governs.
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
// The Bash tool's own description interpolates both (`` `timeout` is in milliseconds: default ${...},
// max ${...}``), so the worker is told these numbers rather than a stale pair.
//
// This does NOT relax the escaping-background-job rule that hooks/bash-background.mjs enforces. That
// hook is about lifecycle identity (`cmd &` leaves a child frizz and Claude cannot wake on); this is
// only about how long a tracked foreground call is allowed to take before the harness backgrounds it
// ITSELF, which keeps the task id and the wake. The two are independent.
//
// Do not "verify" this value from a stand-in harness: neither `claude -p` nor a raw SDK session
// reproduces the auto-background bounce that real dispatched workers get, so a behavioral check
// there passes identically with and without the variable. See the NOT ASSERTED note in
// _live_sdk_worker_env.mts.
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
  BASH_DEFAULT_TIMEOUT_MS: "60000",
  BASH_MAX_TIMEOUT_MS: String(24 * 60 * 60 * 1000),
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
