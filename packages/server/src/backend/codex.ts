import { join } from "node:path"
import { homedir } from "node:os"
import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from "node:fs"
import type { PermissionMode } from "@frizz/shared"
import { applyEvent } from "../tailer.ts"
import type { AgentBackend, BuiltCommand, FoldState, NormalizedEvent, ResumeOpts, SpawnOpts } from "./types.ts"

// CodexBackend: everything Codex-CLI-specific behind the AgentBackend seam (Codex-support epic,
// Phase 2). Unlike ClaudeBackend — which reuses the tailer's corpus-verified applyRecord — codex's
// rollout brackets turns EXPLICITLY (event_msg/task_started .. task_complete|turn_aborted), so its turn model maps
// cleanly onto NormalizedEvent and its authoritative fold IS `for (ev of parseLine) applyEvent(state,
// ev)` (the generic driver added in the Phase-2 PREP refactor). This module owns: the interactive-TUI
// spawn/resume argv, the worker-contract injection (prompt-prepend — see the AGENTS.md-placement note
// below), the transcript LOCATION (codex has no --session-id pin, so the rollout id is DISCOVERED
// post-spawn), and the rollout→NormalizedEvent parser. Everything is grounded in real captured
// rollouts from codex-cli 0.144.1 (see ./codex.fixtures/*.jsonl).

// ---- codex home / sessions dir ----
// Codex writes rollouts under $CODEX_HOME/sessions (default ~/.codex/sessions), date-sharded
// (YYYY/MM/DD) with the session UUID embedded in the filename: rollout-<ISO8601>-<uuid>.jsonl.
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim() ? process.env.CODEX_HOME : join(homedir(), ".codex")
}
function sessionsDir(codexHome: string): string {
  return join(codexHome, "sessions")
}

// The fixed worker contract still travels in the first user turn, but title creation has a stronger,
// invocation-scoped instruction below. Keep this tiny user-turn reminder as a redundant compatibility
// belt: it is machine metadata, stripped from the chat by the transcript projector, and requests an
// invisible attribute-style comment rather than a visible Markdown heading.
export const CODEX_FIRST_FINAL_TITLE_TRANSPORT =
  'FRIZZ TITLE TRANSPORT (required): your very first assistant message must begin with one concise `<!-- frizz title="Concise thread title" -->` comment before any commentary, acknowledgement, or tool call. Frizz removes that comment from chat and uses only its quoted title as this thread\'s automatic title.'

// Codex exposes no dedicated `--append-system-prompt` flag. Its app-server `newSession` takes a
// `developerInstructions` field instead — a higher-priority, non-rendered surface — so the small title
// protocol rides that rather than a task-adjacent user instruction alone (dispatch.ts passes it there).
// The full ~18KB worker contract goes through the sibling `baseInstructions` field, which is the surface
// meant for bulk; this one is for a short protocol note. Spawn-only: replaying it on a resumed session
// would incorrectly request a second title from an existing conversation.
export const CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS =
  'FRIZZ UI metadata protocol (mandatory): the very first assistant message in this new session, before any commentary, acknowledgement, tool call, or other action, MUST begin on its first line with exactly one `<!-- frizz title="..." -->` HTML comment. Replace `...` with a concise human-readable 3-8 word title for the user\'s task. Put no text before the comment. You may continue the message normally after it. Emit this title comment exactly once. Do not explain the protocol. Frizz removes the comment before displaying the conversation.'

// Historical first prompts used a visible H1 as the transport. It remains a parse-compatible title
// signal, and the transcript projector recognizes this exact retired trailer so old dispatch metadata
// never appears as human chat content.
export const CODEX_LEGACY_FIRST_FINAL_TITLE_TRANSPORT =
  "FRIZZ TITLE TRANSPORT (required): on your first final answer, put one concise `# Title` H1 on its first line before the answer. Frizz removes that H1 from chat and uses it only as this thread's automatic title."

// ---- codex reasoning-effort universe ----
// Codex reasoning-effort universe (per ~/.codex/models_cache.json): low/medium/high/xhigh/max/ultra.
// It is PER-MODEL which of these a given model accepts (gpt-5.6-sol/terra → all six, luna → …max, 5.5 →
// …xhigh) — that gating happens in the UI, which offers only the chosen model's cache `efforts`. This
// server-side check is just the OUTER universe: pass through any real codex effort (no more max→xhigh
// clamp, which WRONGLY downgraded a 5.6 model that supports max/ultra); only a genuinely-unknown value →
// undefined (codex then uses the model's default_reasoning_level).
const CODEX_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"])
export function codexEffort(effort?: string): string | undefined {
  if (!effort) return undefined
  if (CODEX_EFFORTS.has(effort)) return effort
  return undefined
}

// frizz permissionMode → codex --sandbox. codex "sandbox" is a different axis than Claude "permission
// mode" (§6), so this is a best-effort map, not an isomorphism: plan → read-only (no writes),
// bypassPermissions → danger-full-access (unrestricted), everything else → workspace-write (edit inside
// the repo, denied elsewhere). Approvals are ALWAYS `never` so an unattended worker NEVER blocks on an
// approval modal (a sandbox-denied action fails back to the model instead of prompting).
export function codexSandbox(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return "read-only"
    case "bypassPermissions":
      return "danger-full-access"
    default:
      return "workspace-write"
  }
}

export interface CodexBackendOptions {
  codexHome?: string // $CODEX_HOME override (~/.codex); tests inject a tmp dir
  codexBin?: string // dispatch executable ("codex" by default); tests use a stand-in
}

const FRIZZ_TITLE_MAX = 200
// The current, invisible title transport. Keep it intentionally strict: a first-line Frizz comment
// with exactly one quoted title attribute. An ordinary HTML comment must remain ordinary prose.
const FRIZZ_TITLE_ATTRIBUTE = /^<!--\s*frizz\s+title="((?:[^"\\\r\n]|\\[^\r\n])*)"\s*-->(?:\r?\n|$)/
const FRIZZ_TITLE_LINE = /^<!-- frizz-title: (.*) -->(?:\r?\n|$)/
const FRIZZ_TITLE_H1 = /^# ([^\r\n]*)(?:\r?\n|$)/
// Unicode's Bidi_Control property includes ALM/LRM/RLM as well as the embedding, override, and
// isolate ranges; a handwritten range is easy to leave incomplete. Default-ignorables are likewise
// replaced unless they carry real shaping/emoji semantics (joiners, variation selectors, emoji tags).
const TITLE_CONTROL_OR_BIDI = /[\p{Cc}\p{Bidi_Control}]/u
const TITLE_DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u
const TITLE_MARK = /\p{M}/u
const TITLE_GRAPHEME_SEGMENTER = new Intl.Segmenter("und", { granularity: "grapheme" })

function titleCodePoint(char: string | undefined): number | undefined {
  return char?.codePointAt(0)
}

function isTitleVariationSelector(codePoint: number | undefined): boolean {
  return codePoint !== undefined && (
    (codePoint >= 0x180b && codePoint <= 0x180d) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  )
}

// A base must have independently visible content. Marks and default-ignorables can modify a base but
// cannot make an otherwise invisible title valid on their own.
function isVisibleTitleBase(char: string | undefined): boolean {
  return Boolean(
    char &&
    !/\s/u.test(char) &&
    !TITLE_MARK.test(char) &&
    !TITLE_CONTROL_OR_BIDI.test(char) &&
    !TITLE_DEFAULT_IGNORABLE.test(char),
  )
}

function hasVisibleBaseBeforeAttachedModifiers(chars: string[], index: number): boolean {
  let before = index - 1
  while (
    before >= 0 &&
    (TITLE_MARK.test(chars[before]) || isTitleVariationSelector(titleCodePoint(chars[before])))
  ) before--
  return isVisibleTitleBase(chars[before])
}

function emojiTagIndexes(chars: string[]): Set<number> {
  const meaningful = new Set<number>()
  for (let i = 0; i < chars.length; i++) {
    if (chars[i].codePointAt(0) !== 0x1f3f4) continue // BLACK FLAG is the emoji tag-sequence base
    let end = i + 1
    while (end < chars.length) {
      const codePoint = chars[end].codePointAt(0)!
      if (codePoint < 0xe0020 || codePoint > 0xe007e) break
      end++
    }
    if (end === i + 1 || chars[end]?.codePointAt(0) !== 0xe007f) continue // CANCEL TAG terminator
    for (let tag = i + 1; tag <= end; tag++) meaningful.add(tag)
    i = end
  }
  return meaningful
}

function meaningfulTitleDefaultIgnorable(
  chars: string[],
  codePoint: number,
  index: number,
  semanticEmojiTags: Set<number>,
): boolean {
  if (semanticEmojiTags.has(index)) return true // only inside a complete black-flag tag sequence
  if (isTitleVariationSelector(codePoint)) return isVisibleTitleBase(chars[index - 1])
  if (codePoint !== 0x200c && codePoint !== 0x200d) return false

  // ZWNJ/ZWJ must connect meaningful content on both sides. The left base may carry attached marks
  // (for example Devanagari virama) and/or variation selectors before the joiner; walk through that
  // modifier sequence, but keep the right-side visible-base requirement immediate and strict.
  return hasVisibleBaseBeforeAttachedModifiers(chars, index) && isVisibleTitleBase(chars[index + 1])
}

function sanitizeFrizzTitleValue(raw: string): string {
  const chars = Array.from(raw)
  const semanticEmojiTags = emojiTagIndexes(chars)
  let safe = ""
  for (const [index, char] of chars.entries()) {
    const codePoint = char.codePointAt(0)!
    const unsafe =
      TITLE_CONTROL_OR_BIDI.test(char) ||
      (TITLE_DEFAULT_IGNORABLE.test(char) && !meaningfulTitleDefaultIgnorable(
        chars,
        codePoint,
        index,
        semanticEmojiTags,
      ))
    safe += unsafe ? " " : char
  }
  const normalized = safe.replace(/\s+/g, " ").trim()
  return Array.from(normalized).some(isVisibleTitleBase) ? normalized : ""
}

// Retain the historical 200-code-point bound, but stop before a whole grapheme that would cross it.
// The caller sanitizes once more afterward because some scripts place ZWNJ at a grapheme boundary;
// that second pass removes any joiner/selector/tag that truncation could otherwise orphan.
function capFrizzTitleValue(raw: string): string {
  let count = 0
  let capped = ""
  for (const { segment } of TITLE_GRAPHEME_SEGMENTER.segment(raw)) {
    const size = Array.from(segment).length
    if (count + size > FRIZZ_TITLE_MAX) break
    capped += segment
    count += size
  }
  return sanitizeFrizzTitleValue(capped)
}

export interface CodexFrizzTitleSignal {
  text: string
  title?: string
  markerFound: boolean
}

function decodeFrizzTitleAttribute(value: string): string {
  const backslashDecoded = value.replace(/\\(.)/g, (_whole, escaped: string) => {
    switch (escaped) {
      case "n": return "\n"
      case "r": return "\r"
      case "t": return "\t"
      default: return escaped
    }
  })
  return backslashDecoded
    .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
}

// New workers emit a first-line attribute comment, which is invisible Markdown and carries a concise
// display title. H1 and `frizz-title:` remain parse-only compatibility for already-running/old sessions.
// Every recognized transport is strict first-line only: ordinary comments and later headings stay prose.
export function extractCodexFrizzTitle(text: string, allowLegacy = true): CodexFrizzTitleSignal {
  const attribute = text.match(FRIZZ_TITLE_ATTRIBUTE)
  const h1 = attribute || !allowLegacy ? undefined : text.match(FRIZZ_TITLE_H1)
  const comment = attribute || h1 || !allowLegacy ? undefined : text.match(FRIZZ_TITLE_LINE)
  const match = attribute ?? h1 ?? comment
  if (!match) return { text, markerFound: false }
  let visible = text.slice(match[0].length)
  // During the prior H1 transition a worker could emit an H1 followed by the old sidecar. Keep that
  // compatibility pair hidden; the new comment transport is fully self-contained.
  if (h1) {
    const compatibility = visible.match(FRIZZ_TITLE_LINE)
    if (compatibility) visible = visible.slice(compatibility[0].length)
  }
  let title = sanitizeFrizzTitleValue(attribute ? decodeFrizzTitleAttribute(match[1]) : match[1])
  // Angle brackets would make the supposedly one-line value look like markup on another surface.
  if (!title || /[<>]/.test(title)) return { text: visible, markerFound: true }
  title = capFrizzTitleValue(title)
  return { text: visible, title: title || undefined, markerFound: true }
}

// ---- rollout → NormalizedEvent parser ----
// Every rollout line is {timestamp, type, payload}. The mapping (grounded in captured 0.144.1
// rollouts, §2.2-2.4):
//   event_msg/task_started        → turn-start           (a turn opened → in-flight)
//   event_msg/task_complete       → turn-end(finalText=last_agent_message)  (turn bracketed → idle)
//   event_msg/turn_aborted        → turn-end             (an INTERRUPTED turn's only bracket → idle)
//   event_msg/agent_message       → assistant-text(final = phase==="final_answer")  (text in .message)
//   event_msg/user_message        → user-message (genuine human turn; codex has no synthetic peer echo)
//   event_msg/item_completed      → the >=0.153 spelling of the two above, as a typed `item`:
//                                   item.AgentMessage → assistant-text, item.UserMessage → user-message.
//                                   Every other item type is a duplicate of a response_item this parser
//                                   already reads (see the case for the full list and why).
//   response_item/function_call        → tool-call  (args JSON in .arguments, id in .call_id)
//   response_item/function_call_output → tool-result (output in .output, id in .call_id)
//   response_item/custom_tool_call        → tool-call  (freeform tools — apply_patch: .input is the raw
//                                          V4A patch STRING, not a JSON args object; id in .call_id)
//   response_item/custom_tool_call_output → tool-result (output in .output, id in .call_id)
// DELIBERATELY SKIPPED (the no-double-count rule, §6):
//   response_item/message          — the raw API echo of agent_message (role=assistant) AND the prompt
//                                    echo (role=user/developer). Counting it would double the assistant
//                                    text / fabricate user turns. The SEMANTIC events live in event_msg.
//   response_item/reasoning        — the raw chain-of-thought (`encrypted_content`) is opaque and
//                                    stays dropped, BUT the plaintext `summary[]` (present because Frizz
//                                    launches codex with model_reasoning_summary; see FRIZZ_CODEX_OUTPUT_DEFAULTS) is
//                                    surfaced as a `reasoning` event → an expandable summary block.
//   event_msg/token_count, thread_settings_applied, session_meta, turn_context, world_state — sidecar
//   for the renderable event stream. turn_context's model/effort are folded separately as session
//   profile telemetry (parseCodexSessionProfile), never emitted as conversation content.
// Pure + defensive: a malformed line, or one with no derivable events, yields [].
export function parseCodexSessionProfile(
  line: string,
): { model?: string; effort?: string; profileAt?: string; permissionMode?: PermissionMode; permissionModeAt?: string } | undefined {
  const s = line.trim()
  if (!s) return undefined
  let rec: unknown
  try {
    rec = JSON.parse(s)
  } catch {
    return undefined
  }
  if (!rec || typeof rec !== "object") return undefined
  const envelope = rec as { timestamp?: unknown; type?: unknown; payload?: unknown }
  if (!envelope.payload || typeof envelope.payload !== "object") return undefined
  const outer = envelope.payload as Record<string, unknown>
  const isTurnContext = envelope.type === "turn_context"
  const isThreadSettings =
    envelope.type === "event_msg" && outer.type === "thread_settings_applied" && outer.thread_settings && typeof outer.thread_settings === "object"
  if (!isTurnContext && !isThreadSettings) return undefined
  const payload = (isThreadSettings ? outer.thread_settings : outer) as Record<string, unknown>
  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : undefined
  let effort = typeof payload.effort === "string" && payload.effort.trim() ? payload.effort.trim() : undefined
  // Some codex versions repeat the value only under collaboration_mode.settings.
  if (!effort && payload.collaboration_mode && typeof payload.collaboration_mode === "object") {
    const settings = (payload.collaboration_mode as { settings?: unknown }).settings
    if (settings && typeof settings === "object") {
      const nested = (settings as { reasoning_effort?: unknown }).reasoning_effort
      if (typeof nested === "string" && nested.trim()) effort = nested.trim()
    }
  }
  const sandbox = payload.sandbox_policy && typeof payload.sandbox_policy === "object"
    ? (payload.sandbox_policy as { type?: unknown }).type
    : undefined
  const profile = payload.permission_profile && typeof payload.permission_profile === "object"
    ? (payload.permission_profile as { type?: unknown }).type
    : undefined
  const active = payload.active_permission_profile && typeof payload.active_permission_profile === "object"
    ? (payload.active_permission_profile as { id?: unknown }).id
    : undefined
  let permissionMode: PermissionMode | undefined
  if (sandbox === "danger-full-access" || profile === "disabled" || active === ":danger-full-access") permissionMode = "bypassPermissions"
  else if (sandbox === "read-only" || active === ":read-only") permissionMode = "plan"
  else if (sandbox === "workspace-write" || profile === "managed" || active === ":workspace") permissionMode = "default"
  const permissionModeAt = permissionMode && typeof envelope.timestamp === "string" ? envelope.timestamp : undefined
  const profileAt = (model || effort) && typeof envelope.timestamp === "string" ? envelope.timestamp : undefined
  return model || effort || permissionMode ? { model, effort, profileAt, permissionMode, permissionModeAt } : undefined
}

export function parseCodexLine(line: string): NormalizedEvent[] {
  const s = line.trim()
  if (!s) return []
  let rec: { timestamp?: unknown; type?: unknown; payload?: unknown }
  try {
    const v = JSON.parse(s)
    if (!v || typeof v !== "object") return []
    rec = v as typeof rec
  } catch {
    return []
  }
  const at = typeof rec.timestamp === "string" ? rec.timestamp : undefined
  const type = rec.type
  const payload = rec.payload
  // Context compaction. A TOP-LEVEL envelope (not event_msg/response_item): everything before it left
  // the model's context, replaced by payload.replacement_history. Checked before the payload guard —
  // the event is the whole signal, and its payload carries nothing we render (`message` is empty in all
  // 2282 records across the 355 rollouts that have one; the replacement history is opaque/encrypted).
  if (type === "compacted") return [{ kind: "compaction", at }]
  if (!payload || typeof payload !== "object") return []
  const p = payload as Record<string, unknown>
  const pt = typeof p.type === "string" ? p.type : undefined

  if (type === "event_msg") {
    switch (pt) {
      case "task_started":
        return [{ kind: "turn-start", at }]
      case "task_complete": {
        // The final message (with the fence) is authoritative here; agent_message/final_answer usually
        // carries the same text a beat earlier, but task_complete is the definitive turn bracket.
        const finalText = typeof p.last_agent_message === "string" ? p.last_agent_message : undefined
        return [{ kind: "turn-end", at, finalText }]
      }
      // The OTHER closing bracket. An INTERRUPTED turn (`reason: "interrupted"` — what turn/interrupt
      // produces, now that stopping a Codex thread actually stops it) never reaches task_complete.
      // Without this the rollout's last word stays task_started, so the tailer holds the turn in-flight
      // forever: a thread the operator deliberately STOPPED cards as still running, then trips the
      // app-server stall grace and cards as crashed/"Stalled" with a Retry it never earned. An aborted
      // turn carries no final text by construction (there was no answer), so it brackets the turn and
      // nothing else — no fence, no excusal.
      case "turn_aborted":
        return [{ kind: "turn-end", at }]
      case "agent_message": {
        const text = typeof p.message === "string" ? p.message : ""
        if (!text) return []
        // phase discriminates the ANSWER (final_answer) from intermediate narration (commentary); only
        // the final answer may carry a done/awaiting excusal fence (a quoted fence in commentary must
        // never excuse the thread — applyEvent's final:false arm refreshes only the preview).
        return [{ kind: "assistant-text", at, text, final: p.phase === "final_answer" }]
      }
      // Per-request usage telemetry. `last_token_usage.total_tokens` is what the LAST request actually
      // carried — i.e. the size of the context at that moment — which is the reading codex's own TUI
      // uses for its remaining-context meter. `model_context_window` rides the same event and is the
      // DENOMINATOR for the footer's fullness readout: codex names the window itself, so frizz never
      // has to keep a per-model table that would go stale the moment a model ships a bigger context.
      // Consumed by the compaction bracket and by the fold's contextTokens/contextWindow.
      case "token_count": {
        const info = p.info && typeof p.info === "object" ? (p.info as Record<string, unknown>) : undefined
        const last = info?.last_token_usage && typeof info.last_token_usage === "object" ? (info.last_token_usage as Record<string, unknown>) : undefined
        const tokens = typeof last?.total_tokens === "number" ? last.total_tokens : undefined
        const raw = info?.model_context_window
        const window = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined
        return tokens === undefined ? [] : [{ kind: "context-usage", at, tokens, ...(window === undefined ? {} : { window }) }]
      }
      case "user_message": {
        const text = typeof p.message === "string" ? p.message : undefined
        // Codex's rollout has no peer/notification/tool-result-echo user record (Claude's promptSource:
        // "system"), so a user_message is ALWAYS a genuine human turn (synthetic:false → bumps the row).
        return [{ kind: "user-message", at, text, synthetic: false }]
      }
      // Codex >= 0.153 folded every semantic event onto ONE `item_completed` envelope carrying a typed
      // `item`, and stopped emitting the flat `agent_message` / `user_message` / `sub_agent_activity`
      // payloads above (verified across the whole 0.153.2 corpus on this machine: 0 of each, and 789
      // item_completed). The turn BRACKETS did not move — task_started/task_complete/turn_aborted and
      // token_count are still flat — which is exactly why the regression was so quiet: a codex thread
      // still went in-flight and still came to rest, so the board looked alive while every word the
      // agent said, the human's own opening prompt, the `<!-- frizz title -->` signal and every
      // done/awaiting/question fence fell on the floor. Both spellings are read, because the old ones
      // are still on disk in every rollout written before the upgrade and the foreign scan folds those.
      case "item_completed": {
        const item = p.item && typeof p.item === "object" ? (p.item as Record<string, unknown>) : undefined
        switch (item?.type) {
          case "AgentMessage": {
            const text = codexItemText(item.content)
            if (!text) return []
            // Same phase discrimination as the flat form above: only final_answer may carry a fence.
            return [{ kind: "assistant-text", at, text, final: item.phase === "final_answer" }]
          }
          case "UserMessage":
            return [{ kind: "user-message", at, text: codexItemText(item.content) || undefined, synthetic: false }]
          // EVERY OTHER ITEM TYPE IS A DUPLICATE, and must stay dropped under the no-double-count rule
          // (§6 above). Reasoning, CommandExecution, FileChange, McpToolCall, Extension and
          // CollabAgentToolCall each have a `response_item` twin that this parser already reads —
          // counting the item as well would paint every codex tool call and reasoning block twice.
          // ContextCompaction is the top-level `compacted` envelope's twin. SubAgentActivity is a
          // different axis entirely and rides parseCodexSubAgentLine, never this union.
          default:
            return []
        }
      }
      default:
        return []
    }
  }

  if (type === "response_item") {
    if (pt === "function_call") {
      const id = typeof p.call_id === "string" ? p.call_id : ""
      const name = typeof p.name === "string" ? p.name : ""
      return [{ kind: "tool-call", at, id, name, input: parseToolArguments(p.arguments) }]
    }
    if (pt === "function_call_output") {
      const id = typeof p.call_id === "string" ? p.call_id : ""
      const text = typeof p.output === "string" ? p.output : stringifyOutput(p.output)
      return [{ kind: "tool-result", at, id, text, ...imageField(p.output) }]
    }
    // Freeform ("custom") tools — codex delivers apply_patch (its file-edit tool) this way, NOT as a
    // function_call. The payload carries `input` as a RAW STRING (the V4A patch for apply_patch), so we
    // pass it through as-is; the renderer/fold sees a normal tool-call and maps the patch to a diff.
    // Without this, every codex file edit was invisible in the board fold AND the chat drawer.
    if (pt === "custom_tool_call") {
      const id = typeof p.call_id === "string" ? p.call_id : ""
      const name = typeof p.name === "string" ? p.name : ""
      return [{ kind: "tool-call", at, id, name, input: typeof p.input === "string" ? p.input : (p.input ?? {}) }]
    }
    if (pt === "custom_tool_call_output") {
      const id = typeof p.call_id === "string" ? p.call_id : ""
      const text = typeof p.output === "string" ? p.output : stringifyOutput(p.output)
      return [{ kind: "tool-result", at, id, text, ...imageField(p.output) }]
    }
    if (pt === "reasoning") {
      // The raw CoT (`encrypted_content`) is opaque, but codex also emits a plaintext `summary`: an
      // array of {type:"summary_text", text} items (the gray reasoning headers its TUI shows), present
      // because Frizz sets model_reasoning_summary. Join the items into one markdown body and surface it
      // as a reasoning event. An empty/absent summary (encryption-only) yields no event — unchanged.
      const summary = Array.isArray(p.summary) ? p.summary : []
      const text = summary
        .map((it) => (it && typeof it === "object" && typeof (it as { text?: unknown }).text === "string" ? (it as { text: string }).text : ""))
        .filter((t) => t.trim())
        .join("\n\n")
      return text ? [{ kind: "reasoning", at, text }] : []
    }
    // Codex's INTER-AGENT channel. A `spawn_agent` child does not return through the parent's tool
    // result (that only carries the spawn ack) — it reports back LATER, as its own `agent_message`
    // record addressed `author` → `recipient`, and that record IS the completion notification the
    // worker keeps saying it received. Without this arm all 383 of them in a real orchestration
    // rollout were dropped on the floor, so a codex thread running a dozen children showed a run of
    // Spawn-agent cards and then nothing ever coming back.
    //
    // DIRECTION GUARD: the same record type carries the parent's NEW_TASK/MESSAGE in the CHILD's
    // rollout. That direction is not a report, but it is not worthless: even when Codex encrypts the
    // body, its timestamp is the only durable evidence in the child's own transcript that another
    // instruction arrived. Preserve it as an agent-instruction so the drawer can mark the turn.
    if (pt === "agent_message") {
      const author = typeof p.author === "string" ? p.author : ""
      const recipient = typeof p.recipient === "string" ? p.recipient : ""
      if (!author || !recipient) return []
      const message = parseCodexAgentMessage(p.content)
      if (!message) return []
      if (author.startsWith(`${recipient}/`)) {
        if (message.type !== "FINAL_ANSWER" && message.type !== "MESSAGE") return []
        return [{ kind: "agent-report", at, author, text: message.body, final: message.type === "FINAL_ANSWER" }]
      }
      // Everything else addressed to this rollout is an incoming instruction. Most are parent → child,
      // but Codex also permits sibling → sibling sends (248 real records in the local corpus: 234
      // MESSAGE + 14 NEW_TASK), whose paths share a parent rather than containing one another. The
      // recipient's rollout is the only one that records the agent_message, so requiring ancestry here
      // silently erased every lateral steer from the recipient's drawer.
      if (author !== recipient && (message.type === "NEW_TASK" || message.type === "MESSAGE")) {
        return [{
          kind: "agent-instruction",
          at,
          author,
          ...(message.body ? { text: message.body } : {}),
          encrypted: message.encrypted,
        }]
      }
      return []
    }
    // response_item/message (the duplicate API echo) is intentionally dropped.
    return []
  }

  // session_meta / turn_context / world_state and any unknown envelope type: sidecar → no events.
  return []
}

// The plaintext half of an inter-agent `agent_message`. Its content array holds an `input_text` block
// carrying a fixed four-line envelope and then the body:
//
//   Message Type: FINAL_ANSWER        ← the child's terminal return; MESSAGE = a mid-flight report
//   Task name: /root                  ← the recipient (us), already on the record as `recipient`
//   Sender: /root/b14_launcher_bootstrap   ← ditto, `author`
//   Payload:
//   <the child's markdown>
//
// The structured `author`/`recipient` fields are preferred over the prose lines (same values, no
// parsing), so only the type and the body are read here. An unrecognized type surfaces nothing rather
// than guessing: NEW_TASK is an OUTBOUND shape (see the direction guard) and a future type is not
// something to render blind.
//
// An EMPTY body is still a report. The two types split cleanly on this — across the reference
// orchestration rollout every one of the 263 FINAL_ANSWERs carries its markdown here while all 125
// MESSAGEs are empty, their text riding the sibling `encrypted_content` block instead. Suppressing the
// empty ones would hide mid-flight progress entirely, and it would cost nothing to show: the report
// line renders no excerpt of the body by design (maintainer 2026-07-29), so the divider IS the signal.
function parseCodexAgentMessage(content: unknown): { type: string; body: string; encrypted: boolean } | undefined {
  if (!Array.isArray(content)) return undefined
  let text: string | undefined
  let encrypted = false
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === "encrypted_content") encrypted = true
    if (b.type === "input_text" && typeof b.text === "string") {
      text = b.text
    }
  }
  if (!text) return undefined
  const type = text.match(/^Message Type:[ \t]*(\S+)/)?.[1]
  if (!type) return undefined
  const marker = text.match(/^Payload:[ \t]*$/m)
  if (!marker || marker.index === undefined) return undefined
  const body = text.slice(marker.index + marker[0].length).replace(/^\n/, "").trim()
  return { type, body, encrypted }
}

// ---- codex MULTI-AGENT signals (sub-agent visibility) ----
// Codex spawns real sub-agents (`spawn_agent`), each a CHILD THREAD with its own rollout file. None of
// that maps onto NormalizedEvent — those events describe THIS session's turn, and a child's lifecycle
// is a separate axis — so the tracker (codex-subagents.ts) consumes this parallel signal instead.
//
// Corpus-verified against every rollout under ~/.codex/sessions (550 files, 47 742 sub_agent_activity
// records, 1414 list_agents outputs; surveyed 2026-07-23):
//   • response_item/function_call name="spawn_agent" — arguments {task_name, model, reasoning_effort,
//     agent_type, message}. `message` is FERNET-ENCRYPTED, so a codex dispatch has NO readable prompt.
//   • event_msg/sub_agent_activity — ALWAYS keyed (agent_path, agent_thread_id, event_id, kind,
//     occurred_at_ms). `kind` was one of exactly three values on the FLAT (<=0.152) record: "started" |
//     "interacted" | "interrupted" — no "completed", which is why liveness came from the child's own
//     rollout. The >=0.153 `SubAgentActivity` item DOES emit "completed" (16 of them beside 16 spawns in
//     one real rollout), so the fold now gets the answer directly; the rollout inference stays as the
//     backstop for a child codex never reports on, and for every older rollout still on disk.
//     `event_id` is always the PARENT's tool call_id (spawn_agent→started, send_message/followup_task
//     →interacted), so it joins a `started` back to the spawn that caused it.
//   • `agent_thread_id` is the child's own codex rollout id → findRolloutsByIds locates its transcript.
//   • list_agents output {agents:[{agent_name, agent_status}]} — an authoritative FULL snapshot.
//     agent_status is "running" | "pending_init" | "interrupted" | {completed:…} | {errored:…}.
export type CodexAgentStatus = "running" | "pending_init" | "interrupted" | "completed" | "errored"
export type CodexSubAgentSignal =
  // A spawn_agent CALL — the dispatch metadata, seen one record BEFORE its `started` confirmation.
  | { kind: "spawn"; at?: string; callId: string; taskName?: string; model?: string; effort?: string; agentType?: string }
  // A list_agents CALL. Carries nothing itself; the caller records the id so the OUTPUT record — which
  // names no tool — can be attributed back to it (that is the only way to recognize a roster).
  | { kind: "roster-call"; at?: string; callId: string }
  // The spawn's RESULT. `ok:false` is a rejected dispatch (codex returns a bare error string, not JSON):
  // no child was created and no `started` will ever arrive, so the pending dispatch must be discarded.
  | { kind: "spawn-result"; at?: string; callId: string; ok: boolean }
  // The child actually started — joins `callId` to the canonical agent path + the child's rollout id.
  | { kind: "started"; at?: string; callId: string; path: string; threadId: string }
  // The parent sent the child more work (send_message / followup_task): a finished child re-opens.
  | { kind: "interacted"; at?: string; path: string; threadId: string }
  | { kind: "interrupted"; at?: string; path: string; threadId: string }
  // The child FINISHED, said so by codex itself. Only the >=0.153 `SubAgentActivity` item carries this
  // (the flat `sub_agent_activity` payload it replaced had no such kind, which is the whole reason the
  // tracker learned to infer liveness from the child's own turn brackets). That inference still runs and
  // is still the backstop for a child codex never reports on; this is simply the authoritative answer
  // when it arrives, and it arrives seconds before the fold could reach the same conclusion.
  | { kind: "finished"; at?: string; path: string; threadId: string }
  // A list_agents snapshot — the only authoritative per-child status the PARENT rollout ever carries.
  | { kind: "roster"; at?: string; agents: { path: string; status: CodexAgentStatus }[] }

// Parse one rollout line into a multi-agent signal, or undefined for the ~99% that carry none.
// Stateless EXCEPT for list_agents: its output arrives as a function_call_output keyed only by
// call_id, so the caller passes the name it recorded for that id (see the tracker's `toolNames`).
export function parseCodexSubAgentLine(line: string, toolNameFor: (callId: string) => string | undefined): CodexSubAgentSignal | undefined {
  const s = line.trim()
  if (!s) return undefined
  // Cheap pre-filter: skip the JSON.parse for records that cannot possibly be a multi-agent signal.
  // `function_call_output` has to be let through even though it names no tool — a tool RESULT is
  // exactly where the spawn verdict and the list_agents roster live, and the name is recoverable only
  // via the caller's call_id→name map. (Dropping outputs here was the bug that made every roster and
  // every rejected spawn invisible.)
  if (
    !s.includes("sub_agent_activity") &&
    !s.includes("SubAgentActivity") &&
    !s.includes("spawn_agent") &&
    !s.includes("list_agents") &&
    !s.includes("function_call_output")
  ) return undefined
  let rec: { timestamp?: unknown; type?: unknown; payload?: unknown }
  try {
    const v = JSON.parse(s)
    if (!v || typeof v !== "object") return undefined
    rec = v as typeof rec
  } catch {
    return undefined
  }
  const at = typeof rec.timestamp === "string" ? rec.timestamp : undefined
  const p = rec.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>) : undefined
  if (!p) return undefined
  const pt = typeof p.type === "string" ? p.type : undefined

  // The two spellings of the same signal. FLAT (<=0.152): event_msg/sub_agent_activity, the call id on
  // `event_id`. ITEM (>=0.153): event_msg/item_completed wrapping a `SubAgentActivity`, the call id on
  // the item's own `id` — verified to be the spawn's `call_id` on 17 of 17 dispatches in a real
  // orchestration rollout, which is what keeps a `started` joinable to the pending spawn metadata.
  // Both are read: the old rollouts are still on disk and the foreign scan still folds them.
  const activity =
    rec.type === "event_msg" && pt === "sub_agent_activity"
      ? { fields: p, callId: typeof p.event_id === "string" ? p.event_id : "" }
      : rec.type === "event_msg" && pt === "item_completed" && p.item && typeof p.item === "object" && (p.item as Record<string, unknown>).type === "SubAgentActivity"
        ? { fields: p.item as Record<string, unknown>, callId: typeof (p.item as Record<string, unknown>).id === "string" ? ((p.item as Record<string, unknown>).id as string) : "" }
        : undefined
  if (activity) {
    const f = activity.fields
    const path = typeof f.agent_path === "string" ? f.agent_path : ""
    const threadId = typeof f.agent_thread_id === "string" ? f.agent_thread_id : ""
    if (!path) return undefined
    if (f.kind === "started") return threadId && activity.callId ? { kind: "started", at, callId: activity.callId, path, threadId } : undefined
    if (f.kind === "interacted") return { kind: "interacted", at, path, threadId }
    if (f.kind === "interrupted") return { kind: "interrupted", at, path, threadId }
    // `completed` exists only on the item form. Its `id` is a synthetic "subagent-completed-<thread>"
    // rather than a call id, so it is matched by PATH like interacted/interrupted, never by call id.
    if (f.kind === "completed") return { kind: "finished", at, path, threadId }
    return undefined
  }

  if (rec.type !== "response_item") return undefined
  const callId = typeof p.call_id === "string" ? p.call_id : ""
  if (!callId) return undefined

  if (pt === "function_call" && p.name === "list_agents") return { kind: "roster-call", at, callId }
  if (pt === "function_call" && p.name === "spawn_agent") {
    const args = parseToolArguments(p.arguments)
    const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
    return { kind: "spawn", at, callId, taskName: str(a.task_name), model: str(a.model), effort: str(a.reasoning_effort), agentType: str(a.agent_type) }
  }
  if (pt !== "function_call_output") return undefined
  const name = toolNameFor(callId)
  if (name === "spawn_agent") {
    // Success is `{"task_name":"/root/x","nickname":"Sartre"}`; a REJECTED dispatch is a bare sentence
    // ("Full-history forked agents inherit the parent agent type…"). Only a task_name means a child exists.
    const parsed = jsonOutput(p.output)
    return { kind: "spawn-result", at, callId, ok: Boolean(parsed && typeof parsed.task_name === "string") }
  }
  if (name !== "list_agents") return undefined
  const parsed = jsonOutput(p.output)
  const rows = parsed && Array.isArray(parsed.agents) ? parsed.agents : undefined
  if (!rows) return undefined
  const agents: { path: string; status: CodexAgentStatus }[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const r = row as Record<string, unknown>
    const path = typeof r.agent_name === "string" ? r.agent_name : ""
    const status = codexAgentStatus(r.agent_status)
    if (path && status) agents.push({ path, status })
  }
  return agents.length ? { kind: "roster", at, agents } : undefined
}

// A codex tool output is a JSON *string*; decode it to an object or give up (a plain-sentence error).
function jsonOutput(output: unknown): Record<string, unknown> | undefined {
  const text = typeof output === "string" ? output : undefined
  if (!text || !text.trimStart().startsWith("{")) return undefined
  try {
    const v = JSON.parse(text)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// list_agents reports a terminal status as a SINGLE-KEY OBJECT carrying the child's final report
// ({completed:"…"} / {errored:…}) and a non-terminal one as a bare string. Anything else → undefined
// (an unknown status must not be guessed into "running", which would hold the thread Active forever).
function codexAgentStatus(raw: unknown): CodexAgentStatus | undefined {
  if (raw === "running" || raw === "pending_init" || raw === "interrupted") return raw
  if (!raw || typeof raw !== "object") return undefined
  if ("completed" in raw) return "completed"
  if ("errored" in raw) return "errored"
  return undefined
}

// A function_call's `arguments` is a JSON STRING (e.g. {"cmd":"cat x","workdir":"/p"}); parse it to the
// object form (matching Claude tool-call input shape) or fall back to the raw string on any surprise.
function parseToolArguments(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {}
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}
// The `image` half of a structured tool result, as its own event field. An MCP `take_screenshot` (and
// codex's own `view_image`) answers with an `input_image` part whose `image_url` is a base64 data URL —
// the ONLY copy of that picture for a screenshot taken without a `filePath`, so unlike the text channel
// it cannot be recovered from anywhere else and must survive parsing. `stringifyOutput` still reduces the
// part to the "[image output]" placeholder for `text`; this returns the data URL BY REFERENCE alongside
// it (no copy, no decode) and only the transcript projection ever reads it. Returns {} when there is no
// image, so spreading it adds no key at all to the overwhelmingly common case.
function imageField(output: unknown): { image?: string } {
  if (!Array.isArray(output)) return {}
  for (const part of output) {
    if (!part || typeof part !== "object") continue
    const p = part as Record<string, unknown>
    if (p.type !== "input_image" && p.type !== "output_image" && p.type !== "image") continue
    const url = typeof p.image_url === "string" ? p.image_url : typeof p.url === "string" ? p.url : undefined
    // Only an inline data URL is ours to render. A remote http(s) image is someone else's fetch — the
    // transcript never reaches out to the network to draw a tool card.
    if (url?.startsWith("data:image/")) return { image: url }
  }
  return {}
}

// The text of an `item_completed` item's `content` array, in order. Codex spells the part type with a
// CAPITAL on an AgentMessage (`{type:"Text",text}`) and lowercase on a UserMessage (`{type:"text",text}`)
// — both appear in the same rollout — so the comparison is case-insensitive rather than two branches
// that would each go stale on the next casing change. Anything that is not a text part is skipped: an
// image or attachment part carries no words for the preview, the title signal or a fence.
function codexItemText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const c = part as { type?: unknown; text?: unknown }
    if (typeof c.type !== "string" || c.type.toLowerCase() !== "text") continue
    if (typeof c.text === "string") parts.push(c.text)
  }
  return parts.join("")
}

// Legacy function-call results are strings. Unified custom-tool results are an ordered response-content
// array (`[{type:"input_text",text}, …]`) — flatten those text blocks in order so transcript parsing
// can recover the wrapper status/result instead of receiving an opaque one-line JSON serialization.
// Unknown structured results still degrade to JSON text.
function stringifyOutput(output: unknown): string {
  if (output == null) return ""
  if (Array.isArray(output)) {
    const parts = output.flatMap((part) => {
      if (!part || typeof part !== "object") return []
      const p = part as Record<string, unknown>
      if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string") return [p.text]
      if ((p.type === "input_image" || p.type === "output_image" || p.type === "image") && (typeof p.image_url === "string" || typeof p.url === "string")) return ["[image output]"]
      return []
    })
    if (parts.length) return parts.join("")
  }
  try {
    return JSON.stringify(output)
  } catch {
    return ""
  }
}

// ---- transcript discovery (codex has NO --session-id pin) ----
// Recursively collect rollout-*.jsonl under $CODEX_HOME/sessions (flat legacy files + date-sharded
// YYYY/MM/DD dirs), spending the budget NEWEST-FIRST so a `budget` truncation can never drop the
// just-spawned rollout: subdirectories are visited in DESCENDING name order (2026 before 2025, the
// newest date shard first) BEFORE this dir's own files, and the flat legacy files that live directly
// under sessions/ (pre-date-sharding, hence oldest) are therefore collected last. Within a dir, files
// sort descending too (rollout-<ISO8601> filenames sort lexically = chronologically). The final
// mtime sort in allRolloutsByMtime still orders results; this ordering only governs WHAT the budget
// keeps. Defensive: any fs error degrades to fewer/no results, never throws.
const descByName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)
function collectRollouts(dir: string, out: { path: string; mtimeMs: number }[], budget: { n: number }): void {
  if (budget.n <= 0) return
  const entries = safeReaddir(dir)
  const dirs = entries.filter((e) => e.isDirectory()).sort(descByName)
  const files = entries.filter((e) => e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")).sort(descByName)
  // Newest date-shards first, so today's shard (holding a fresh spawn) always fits the budget.
  for (const d of dirs) {
    if (budget.n <= 0) return
    collectRollouts(join(dir, d.name), out, budget)
  }
  for (const f of files) {
    if (budget.n <= 0) return
    let mtimeMs: number
    try {
      mtimeMs = statSync(join(dir, f.name)).mtimeMs
    } catch {
      continue
    }
    out.push({ path: join(dir, f.name), mtimeMs })
    budget.n--
  }
}
// readdir with dirents, degrading to [] on any fs error (missing dir, permissions) — never throws.
function safeReaddir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function allRolloutsByMtime(codexHome: string, cap = 4096): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = []
  collectRollouts(sessionsDir(codexHome), out, { n: cap })
  // Filesystems commonly give concurrent rollouts the same coarse mtime. Keep ordering deterministic
  // in that case; sentinel discovery does not depend on the order, while legacy cwd-only callers get a
  // stable newest-filename tie-break instead of readdir-order roulette.
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0))
  return out
}

// Locate an ALREADY-DISCOVERED session's rollout by its codex id (filename suffix -<id>.jsonl). Used by
// the tailer once the id is pinned on the registry row. Returns the path or undefined (not yet written).
export function findRolloutById(sessionId: string, codexHome = defaultCodexHome()): string | undefined {
  const suffix = `-${sessionId}.jsonl`
  for (const r of allRolloutsByMtime(codexHome)) {
    if (r.path.endsWith(suffix)) return r.path
  }
  return undefined
}

// BATCH form of findRolloutById: resolve many codex ids in ONE sessions-tree walk. A codex thread that
// spawned N sub-agents needs N child rollouts located, and each is its own thread id — resolving them
// one at a time would re-walk the (capped, but still recursive) tree N times on the very tick a fan-out
// lands, and again on every restart replay. Unresolved ids are simply absent from the returned map.
export function findRolloutsByIds(sessionIds: readonly string[], codexHome = defaultCodexHome()): Map<string, string> {
  const out = new Map<string, string>()
  const wanted = new Set(sessionIds.filter((id) => id))
  if (!wanted.size) return out
  for (const r of allRolloutsByMtime(codexHome)) {
    for (const id of wanted) {
      if (r.path.endsWith(`-${id}.jsonl`)) {
        out.set(id, r.path)
        wanted.delete(id)
        break
      }
    }
    if (!wanted.size) break
  }
  return out
}

// ---- codex's OWN name for a thread ----
//
// A rollout carries NO title record — checked against every record type and every title-shaped key in
// the newest 12 real rollouts (2026-08-24): `session_meta`, `turn_context`, `response_item`,
// `event_msg`, `world_state`, `compacted`, and nothing among them names the thread. Codex keeps the
// name in a SIDECAR instead: `$CODEX_HOME/session_index.jsonl`, one `{id, thread_name, updated_at}`
// per line.
//
// COVERAGE IS THIN, and the caller must be ready for a miss rather than treating this as the answer:
// on this machine it held 22 entries against 1,586 rollouts — 4 of the 319 written in the last 30
// days. Codex's own picker behaves accordingly: driven 2026-08-24, it showed the first USER MESSAGE
// for every unindexed session rather than a generated name. So this is the preferred title and the
// first user turn is the fallback, which is the same order Claude Code's picker uses.
const SESSION_INDEX_MAX_BYTES = 4 * 1024 * 1024
/** id → the name codex gave that thread, for every entry in the sidecar index. Empty on any fs or
 *  parse surprise — a missing name degrades to the first-user-turn fallback, never to an error. */
export function readCodexThreadNames(codexHome = defaultCodexHome()): Map<string, string> {
  const out = new Map<string, string>()
  let raw: string
  try {
    const path = join(codexHome, "session_index.jsonl")
    if (statSync(path).size > SESSION_INDEX_MAX_BYTES) return out
    raw = readFileSync(path, "utf8")
  } catch {
    return out
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
      // LAST WRITER WINS: the file is append-only, so a renamed thread appears twice and the newer
      // line is the current name.
      if (typeof r.id === "string" && typeof r.thread_name === "string" && r.thread_name.trim()) {
        out.set(r.id, r.thread_name.trim())
      }
    } catch {
      // one malformed line must not cost the whole index
    }
  }
  return out
}

// ---- FOREIGN rollout discovery (a codex session in this project that frizz did NOT dispatch) ----
//
// The Claude side of this is a directory listing: Claude shards its transcripts by the cwd a session
// was born in, so "every session in this project" is one readdir. Codex has ONE GLOBAL TREE for every
// project on the machine, so the project filter lives INSIDE each file — `session_meta.payload.cwd` on
// line 1 — and the scan has to open a candidate to know whether it belongs here at all.
//
// That is affordable only because the freshness window comes FIRST. Measured on the maintainer's real
// corpus (1,586 rollouts, 2026-08-19): the recursive walk plus one stat per file is 10ms warm (266ms on
// a cold FS cache, once), and of those files exactly 3 fell inside a 24h window and cost 1.3ms to
// head-read. Widen the window to 30 days and it is 621 files and 452ms — so the window is not a
// nicety here the way it is for Claude, it is what makes the scan cheap enough to run at all.
//
// TWO FILTERS BEYOND FRESHNESS, both of which produce a wrong board row if skipped:
//   • SUB-AGENT CHILDREN. A codex thread's children get their own rollouts in the same tree — 332 of
//     the 621 files in a 30-day window on this machine. Each would otherwise list as its own session.
//   • THE PROJECT. `cwd` is compared against BOTH the project dir and its realpath: a rollout records
//     the cwd the process actually had, which on macOS is `/private/tmp/x` where frizz holds `/tmp/x`.
const FOREIGN_ROLLOUT_HEAD_BYTES = 256 * 1024 // line 1 inlines `base_instructions`; 16KB truncates it
export interface ForeignRolloutScan {
  cwds: readonly string[] // the project dir and any alias of it (realpath); a rollout matching ANY belongs here
  nowMs: number
  freshMs: number
  exclude: ReadonlySet<string> // ids owned by a registry row — never surface one of those as foreign
  max: number
}
/** Rollouts in THIS project, fresh, human-started, and not owned by a frizz row — newest first.
 *  Telemetry-grade: any fs/parse surprise skips that file, never throws. */
export function scanForeignRollouts(scan: ForeignRolloutScan, codexHome = defaultCodexHome()): { id: string; path: string }[] {
  const wanted = new Set(scan.cwds)
  const out: { id: string; path: string }[] = []
  for (const r of allRolloutsByMtime(codexHome)) {
    if (out.length >= scan.max) break
    if (scan.nowMs - r.mtimeMs > scan.freshMs) continue
    const id = rolloutIdOf(r.path)
    if (!id || scan.exclude.has(id)) continue
    const meta = readSessionMeta(r.path)
    if (!meta || !meta.cwd || !wanted.has(meta.cwd)) continue
    // A child rollout is not a session anybody opened; it is a tool call with a transcript.
    if (meta.threadSource === "subagent" || meta.parentThreadId) continue
    out.push({ id, path: r.path })
  }
  return out
}

/** The session uuid a rollout filename ends with (`rollout-<ISO8601>-<uuid>.jsonl`), or undefined. */
function rolloutIdOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1)
  // The ISO timestamp between the prefix and the id contains hyphens too, so anchor on the TAIL: a
  // canonical uuid is the last 36 characters before `.jsonl`.
  const stem = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name
  const tail = stem.slice(-36)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tail) ? tail.toLowerCase() : undefined
}

/** Line 1's `session_meta` payload, reduced to the three fields the foreign scan reads. */
function readSessionMeta(path: string): { cwd?: string; threadSource?: string; parentThreadId?: string } | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const buf = Buffer.allocUnsafe(FOREIGN_ROLLOUT_HEAD_BYTES)
    const n = readSync(fd, buf, 0, FOREIGN_ROLLOUT_HEAD_BYTES, 0)
    const line = buf.toString("utf8", 0, n).split("\n", 1)[0]
    const record = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> }
    if (record.type !== "session_meta" || !record.payload) return undefined
    const p = record.payload
    return {
      cwd: typeof p.cwd === "string" ? p.cwd : undefined,
      threadSource: typeof p.thread_source === "string" ? p.thread_source : undefined,
      parentThreadId: typeof p.parent_thread_id === "string" ? p.parent_thread_id : undefined,
    }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best-effort */ }
    }
  }
}

export function createCodexBackend(opts: CodexBackendOptions = {}): AgentBackend {
  const codexHome = opts.codexHome ?? defaultCodexHome()

  return {
    kind: "codex",

    // The interactive-CLI transport was retired: codex now runs SOLELY on the app-server bridge
    // (backend/codex-app-server.ts), inside a detached daemon. These argv builders exist only to satisfy
    // the AgentBackend interface; nothing should call them for a codex row anymore.
    buildSpawn(_o: SpawnOpts): BuiltCommand {
      throw new Error("codex runs via the app-server bridge; this argv builder has no live caller")
    },

    buildResume(_o: ResumeOpts): BuiltCommand {
      throw new Error("codex runs via the app-server bridge; this argv builder has no live caller")
    },

    // Codex's id is minted by codex and not known until it writes session_meta, so there is no
    // deterministic path from the frizz-advisory sessionId. Once the DISCOVERED id is pinned on the row,
    // the tailer calls this with that id and we locate the (date-sharded) rollout by filename suffix.
    transcriptPath(sessionId: string): string | undefined {
      return findRolloutById(sessionId, codexHome)
    },

    // Codex's rollout brackets turns explicitly, so — unlike Claude — its authoritative fold DOES route
    // through the normalized union: drive parseCodexLine through the generic applyEvent. Pure/defensive
    // (a bad line → parseCodexLine [] → no applyEvent calls).
    parseLine(line: string): NormalizedEvent[] {
      return parseCodexLine(line)
    },

    foldLine(state: FoldState, line: string): void {
      const profile = parseCodexSessionProfile(line)
      if (profile?.model) state.model = profile.model
      if (profile?.effort) state.effort = profile.effort
      if (profile?.model || profile?.effort) {
        state.profileAt = profile.profileAt
        state.profileRevision = (state.profileRevision ?? 0) + 1
      }
      if (profile?.permissionMode) {
        state.permissionMode = profile.permissionMode
        state.permissionModeAt = profile.permissionModeAt
        state.permissionModeRevision = (state.permissionModeRevision ?? 0) + 1
      }
      const applyTitleSignal = (signal: CodexFrizzTitleSignal, firstFinal: boolean) => {
        // Native provider events always win. A valid later signal may repair only the bounded dispatch
        // fallback created after an omitted/malformed first signal; it cannot churn a good title.
        if (state.autoTitleSource === "native") return
        if (signal.title && (!state.aiTitle || state.autoTitleSource === "fallback")) {
          applyEvent(state, { kind: "title", title: signal.title })
          state.autoTitleSource = "frizz"
          return
        }
        // The dispatcher already persisted a bounded, topic-oriented automatic title. Record only
        // its provenance here: applying a generic telemetry title would overwrite that useful value.
        if (firstFinal && !state.aiTitle) state.autoTitleSource = "fallback"
      }
      for (const ev of parseCodexLine(line)) {
        if (ev.kind === "assistant-text") {
          // The new developer instruction puts the title on Codex's very first assistant message,
          // which is normally commentary emitted before the first tool call. Attribute comments are
          // therefore recognized and hidden on every assistant phase. H1/legacy transports remain
          // final-only so an ordinary commentary heading can never be mistaken for metadata.
          const signal = extractCodexFrizzTitle(ev.text, ev.final)
          applyEvent(state, { ...ev, text: signal.text })
          applyTitleSignal(signal, false)
          if (!ev.final) continue
          const firstFinal = !state.titleCandidateFinalSeen
          if (firstFinal) {
            state.titleCandidateFinalSeen = true
            state.titleCandidateFinalText = ev.text
          }
          applyTitleSignal(signal, firstFinal)
          continue
        }
        if (ev.kind === "turn-end" && ev.finalText !== undefined && !state.titleCandidateFinalSeen) {
          state.titleCandidateFinalSeen = true
          state.titleCandidateFinalText = ev.finalText
          const signal = extractCodexFrizzTitle(ev.finalText)
          applyEvent(state, { ...ev, finalText: signal.text })
          applyTitleSignal(signal, true)
          continue
        }
        if (
          ev.kind === "turn-end" &&
          ev.finalText !== undefined &&
          ev.finalText === state.titleCandidateFinalText
        ) {
          // task_complete repeats the same first final_answer. Hide its transport line as part of the
          // same response, but never extract another candidate from a later, different final answer.
          applyEvent(state, { ...ev, finalText: extractCodexFrizzTitle(ev.finalText).text })
          continue
        }
        if (ev.kind === "turn-end" && ev.finalText !== undefined) {
          const signal = extractCodexFrizzTitle(ev.finalText)
          applyEvent(state, { ...ev, finalText: signal.text })
          applyTitleSignal(signal, false)
          continue
        }
        if (ev.kind === "title") {
          applyEvent(state, ev)
          state.autoTitleSource = "native"
          continue
        }
        applyEvent(state, ev)
      }
    },
  }
}
