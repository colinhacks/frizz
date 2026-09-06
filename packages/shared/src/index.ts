import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { InteractionLifecycle, InteractionOpaqueId, InteractionRevision, InteractionThreadSlug } from "./interactions.ts"
import { ThreadSlug } from "./thread-slug.ts"

// ---- Attachment intake (drag/drop, paste, file picker) ----
// What a worker can actually GET AT. A format qualifies two ways: an agent's Read/file tool consumes
// it with no conversion step (images, PDF, text, code), or its bytes are a documented container the
// agent cracks with a tool it installs in one command — openpyxl/pandas for a spreadsheet, python-docx
// and python-pptx for a document, duckdb/pyarrow for a columnar dump, the sqlite3 CLI for a database,
// unzip/tar for an archive, and pandoc or LibreOffice (often already on the machine) for most of the
// rest. Office, columnar and archive formats were REFUSED until 2026-08-27 on the theory that they'd
// reach the agent as opaque zip/XML garbage; that underrates the agent, and the cost of the refusal
// landed on the person, who had to convert the file by hand before Frizz would take it. A dropped file
// lands on disk and its absolute path — inserted as plain text into the message — is what the worker
// opens; nothing here is parsed, rendered or extracted by Frizz itself.
//
// Widening this list widens NOTHING else. /local-image serves only its own content-type map (which
// mirrors ATTACHMENT_IMAGE_EXTENSIONS), and the desktop-open action gates on trusted ROOTS rather than
// on extension (local-file.ts). What the list decides is exactly: what /attach writes to disk, what the
// file picker offers, and which standalone path lines become openable chips (web lib/imagePaths.ts).

// Inline-renderable raster images: served back to the chat via the gated /local-image proxy and seen
// visually by the agent. SVG is DELIBERATELY not here — it is an XSS vector when served as an image
// (which is why the server's /local-image content-type map omits it), so an attached .svg is treated
// as a document (an openable chip + the agent reads its XML), never rendered inline.
export const ATTACHMENT_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const
// Read straight as text by both backends — or, for PDF, rendered natively by Claude's Read.
export const ATTACHMENT_TEXT_EXTENSIONS = [
  "pdf", "svg", "txt", "text", "log", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson",
  "yaml", "yml", "toml", "ini", "xml", "html", "htm", "css", "scss", "sql",
  "sh", "bash", "zsh", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go",
  "rs", "java", "kt", "c", "h", "cpp", "cc", "hpp", "cs", "php", "swift", "lua", "r",
] as const
// Office and open-document formats. Each is a zip of XML (or, for the pre-2007 binaries, a documented
// OLE container) that one install reads: openpyxl, python-docx, python-pptx, odfpy, striprtf.
export const ATTACHMENT_OFFICE_EXTENSIONS = [
  "xlsx", "xlsm", "xls", "docx", "doc", "pptx", "ppt", "odt", "ods", "odp", "rtf", "epub",
] as const
// Analytical dumps. duckdb and pyarrow read the whole columnar set; the sqlite3 CLI ships with macOS
// and most Linux; .ipynb is JSON, which Claude's Read renders as cells and NotebookEdit writes back.
export const ATTACHMENT_DATA_EXTENSIONS = [
  "parquet", "avro", "orc", "arrow", "feather", "ipynb", "db", "sqlite", "sqlite3",
] as const
// Archives. `unzip` and `tar` are on every machine an agent runs on, and refusing a .zip while
// accepting .docx — which IS a zip — was never coherent. Frizz never extracts one: the file sits on
// disk and the worker unpacks it deliberately, or does not.
export const ATTACHMENT_ARCHIVE_EXTENSIONS = ["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z"] as const
// Everything that is NOT rendered inline as an image: the chip set, and the alternation behind the
// chat's standalone-path detection.
export const ATTACHMENT_DOC_EXTENSIONS = [
  ...ATTACHMENT_TEXT_EXTENSIONS,
  ...ATTACHMENT_OFFICE_EXTENSIONS,
  ...ATTACHMENT_DATA_EXTENSIONS,
  ...ATTACHMENT_ARCHIVE_EXTENSIONS,
] as const
export const ATTACHMENT_EXTENSIONS = [...ATTACHMENT_IMAGE_EXTENSIONS, ...ATTACHMENT_DOC_EXTENSIONS] as const

// Cap on the /attach base64 payload (~chars). A screenshot is small; a PDF can be larger, so the cap
// is generous but bounded — base64 is ~4/3 the byte size, so this is ~18MB of binary.
export const ATTACHMENT_MAX_BASE64_CHARS = 25_000_000
// The equivalent RAW-byte budget (base64 inflates ~4/3), for a client-side pre-check that rejects an
// oversized file with a clear message before it spends time encoding a doomed upload.
export const ATTACHMENT_MAX_BYTES = Math.floor(ATTACHMENT_MAX_BASE64_CHARS / 4) * 3

const ATTACHMENT_EXT_SET: ReadonlySet<string> = new Set(ATTACHMENT_EXTENSIONS)
// Lowercased extension (no dot) of a filename, or "" when it has none.
export function attachmentExtension(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name.trim())
  return m ? m[1].toLowerCase() : ""
}
export function isAllowedAttachmentName(name: string): boolean {
  return ATTACHMENT_EXT_SET.has(attachmentExtension(name))
}
// The <input accept> value for the file picker: every allowed extension as `.ext`.
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(",")

// ---- Frizz board vocabulary (mirrors board/config.mjs) ----

// Declaration order IS the lifecycle order (STATUS_ORDER = FrizzStatus.options), consumed by the
// status pickers and the roadmap-count ordering. `needs-human` is a FIRST-CLASS status — the declared
// "awaiting a human" state and THE queue definition — and sits at the human gate between `active`
// (work in flight) and `blocked` (now narrowed to machine-waits only: blocking_threads / revalidate_at).
export const FrizzStatus = z.enum(["planning", "planned", "active", "needs-human", "blocked", "done", "dismissed"])
export type FrizzStatus = z.infer<typeof FrizzStatus>

// How a blocked thread unblocks. `human` = the awaiting-you queue.
export const BlockMechanism = z.enum(["human", "threads", "timer"])
export type BlockMechanism = z.infer<typeof BlockMechanism>

// ---- Runtime state of the Claude process bound to a thread ----

export const RuntimeState = z.enum([
  "none", // no session ever spawned for this thread
  "spawning",
  "running", // process alive, turn in flight
  "perm-prompt", // process alive, paused on an interactive permission prompt (answer in the terminal)
  "turn-idle", // process alive, waiting at the prompt
  "exited", // the worker process that owned this session is gone, or is no longer driving its turn
])
export type RuntimeState = z.infer<typeof RuntimeState>

// Which agent CLI a dispatch/thread runs on (Codex-support epic, Phase 3). Mirrors BackendKind in
// server/backend/types.ts (the wire can't import it — it lives behind the server boundary). A model
// selection drives this: a Claude model ⇒ "claude", an OpenAI/GPT model ⇒ "codex".
export const Backend = z.enum(["claude", "codex"])
export type Backend = z.infer<typeof Backend>

// One selectable Codex model, derived server-side from the AUTHORITATIVE ~/.codex/models_cache.json
// (the codexModels RPC) rather than a hand-maintained list — the source of two live breakages (a bare
// `gpt-5.6` that codex 400s, and a single hardcoded effort set that's wrong per-model). `slug` is the
// `codex -m` id; `efforts` is exactly that model's supported reasoning levels (5.6 → …/max/ultra, 5.5 →
// …/xhigh), so the effort dropdown offers only what the chosen model actually accepts. Ordered by the
// cache's `priority` (index 0 = the codex default). See .frizz/codex-model-cache.md.
export const CodexModel = z.object({
  slug: z.string(),
  displayName: z.string(),
  defaultEffort: z.string(),
  efforts: z.array(z.string()),
})
export type CodexModel = z.infer<typeof CodexModel>

// A provider-scoped launch profile. The server is the catalogue authority for existing threads:
// callers receive only models that belong to the row's exact backend and each model carries its
// complete supported effort set. The intentionally generic shape also lets a future backend expose
// its own native ids without teaching the browser how to classify model names.
export const ThreadProfileOption = z.object({
  model: z.string().min(1),
  label: z.string().min(1),
  defaultEffort: z.string().min(1),
  efforts: z.array(z.string().min(1)).min(1),
})
export type ThreadProfileOption = z.infer<typeof ThreadProfileOption>

export const ThreadAgent = z.object({
  id: z.string(),
  label: z.string().optional(),
  state: z.string().optional(),
})

// A LIVE background sub-agent the thread's worker dispatched and is now resting against — derived by
// the JSONL tailer from Agent-tool dispatches + their task-notifications, NOT the .frizz file. This is
// what makes a "dispatched a sub-agent, then came to rest" worker read as in-motion rather than idle.
// `running` = the child's transcript is still being appended to; `stale` = no output for a while (a
// completion record we likely missed). Distinct from `ThreadAgent`/`agents` (frizz frontmatter).
export const SubAgentView = z.object({
  label: z.string(), // the dispatch's `description` (e.g. "Investigate nubjs/nub GitHub issue 376")
  startedAt: z.string(), // ISO8601 of the dispatch record
  // running — appending to its transcript now. stale — tracked, but quiet past the staleness ceiling.
  // rested — its RUN ended (the harness notified `completed`/`failed`) while its own fan-out kept
  // running. Not a phantom and not a lie: `completed` does not mean finished — the same notification
  // says outright that a stopped agent can be resumed and may notify again — and a child that rests
  // holding live grandchildren used to take the entire branch off the board with it. See anchorRoots in
  // tailer.ts. Only ever emitted for a DIRECT child that still has something running under it, so it
  // clears itself when that work does. Every liveness reading keys on "running", so a rested row holds
  // nothing back: it does not block a rest, hold the queue, or gate Mark-as-done.
  state: z.enum(["running", "stale", "rested"]),
  // The worker-profile cell (model+effort) for the dispatch — RESOLVED, not the raw `subagent_type`:
  // an effort-only profile carries no model, so the server composes it from the call's own `model` or
  // the dispatching turn's (server/subagent-profile.ts). It is NO LONGER drawn as a tag on the child
  // rows under the prompt box (maintainer 2026-07-27: the profile belongs to the prompt box's own
  // control one line up, not repeated on every child line); the transcript's dispatch card shows it,
  // the sidebar rail carries it in the row tooltip, and the drill-in passes it to the drawer.
  // Optional — absent when nothing about the child's runtime is known.
  subagentType: z.string().optional(),
  // The dispatch tool_use id (the stable correlation key: same id on the Agent tool_use block, the
  // completion <task-notification>, and the transcript AgentBlock). Optional — absent on a pre-restart
  // server that doesn't emit it yet → the drill-in drawer's entry point is simply not offered. Present
  // → the banner row / AgentBlock is clickable and resolves this exact child's transcript.
  id: z.string().optional(),
  // The RUNTIME agent id — the `agentId: a01b2d20b32feab11` line of the Agent tool's launch ack, which
  // is the only id the MODEL is ever shown for its child (the tool_use id above is invisible to it). So
  // it is the string a worker writes in an `agents:` fence line or registers a `watch` against, exactly
  // as BgShellView.taskId is for a shell. Every liveness reading accepts both. Absent for a codex row
  // and for a Claude row between its tool_use and its launch ack.
  taskId: z.string().optional(),
  // Can frizz actually END this child's work right now? Computed SERVER-side (board.ts, the one place
  // holding both the session row and the tailer's telemetry) and never re-derived by a client — the
  // same discipline as `steerable`, and for the same reason: the policy depends on the thread's
  // TRANSPORT, which the browser has no honest way to know.
  //
  // It exists because the × that offers to stop a child must not appear on a row where stopping is
  // impossible (maintainer 2026-07-30: "We shouldn't show the X if it doesn't fucking work"). Only a
  // broker-backed Claude thread has a per-child control channel (`Query.stopTask`); a codex thread runs
  // its sub-agents inside its own app-server process, which exposes no such channel.
  // Absent/false on a pre-restart server's snapshot ⇒ the × is simply not offered on a RUNNING row,
  // which fails toward showing no control rather than a false one.
  stoppable: z.boolean().optional(),
  // ISO8601 of the child transcript's last append (its output file's mtime — the SAME signal that
  // decides running vs stale). Surfaced so a row can show "last active 6 min ago": the state alone only
  // says quiet-for-15-min, not HOW quiet. Optional — absent before the output path resolves, or on a
  // pre-restart server. Minute-bucketed into the board signature server-side, so a running child's
  // steadily-advancing mtime does not spam deltas.
  lastActivityAt: z.string().optional(),
  // ---- what the child is actually DOING, from the provider's own task_* event stream ----
  // A live sub-agent used to be a name and a spinner: start, stop, nothing in between. These come off
  // the Claude Agent SDK's typed task lifecycle (stream-only — none of it is in the session JSONL), so
  // they are present for a BROKER thread and absent for a codex one, an older CLI, or a pre-restart
  // server. Render each only when set; never assume they arrive together.
  activity: z.string().optional(), // the tool the child is running right now (e.g. "Bash", "Edit")
  // What the current step IS, in words — the provider rewrites it per tool call ("Running Print
  // current date and time"). Measured against a real session this is the richest LIVE field: `summary`
  // stayed empty on every progress event and only arrived with the terminal notification.
  activityDetail: z.string().optional(),
  summary: z.string().optional(), // the provider's rolling one-line summary of the child's work
  toolUses: z.number().optional(), // tool calls the child has made so far
  tokens: z.number().optional(), // total tokens the child has spent so far
  durationMs: z.number().optional(), // the provider's own working-time measure (excludes paused)
  // ---- NESTING: a sub-agent's sub-agent, and so on down ----
  // 1 = a child this thread's worker dispatched itself (the only kind that used to reach any surface).
  // 2 = a grandchild, 3 = a great-grandchild, … Its dispatch is in an ANCESTOR's transcript rather than
  // this thread's, so it is derived from claude's flat descendant sidecars, not from the fold — see the
  // DESCENDANTS note in tailer.ts. Absent on a pre-restart server's snapshot, which is why every reader
  // treats absent as 1 (`isDirectSubAgent`) instead of testing for the field.
  depth: z.number().optional(),
  // The dispatch tool_use id of the sub-agent that dispatched THIS one — the `id` of another row in the
  // same list. Absent at depth 1 (the thread itself is the parent). Present → the row indents under it.
  parentId: z.string().optional(),
})
export type SubAgentView = z.infer<typeof SubAgentView>

// A sub-agent THIS thread's worker dispatched itself, as opposed to one of its descendants.
//
// Every LIVENESS reading keys on this and never on the raw list. A descendant has no retirement signal
// in this thread's transcript — a direct child clears on its <task-notification>, but a sidecar is
// written once and never deleted — so counting descendants as live work would hold a thread out of the
// queue (hasLiveBackgroundWork) for the full staleness window after a grandchild finished, which is
// exactly the invisible-for-hours failure the queue exists to prevent. Descendants are a RENDERING
// concern: they show what is happening under the thread, and they change no thread state.
export function isDirectSubAgent(agent: { depth?: number }): boolean {
  return (agent.depth ?? 1) === 1
}

// A LIVE background SHELL the worker launched (Bash run_in_background:true) — same tailer tracking as a
// sub-agent (dispatch → launch output path → task-notification clear). Foreground-blocking waits keep
// the turn in-flight, so the spinner already covers them; this is for ops that PERSIST across a rest
// (a CI watcher, a long build). New servers include the stable tool-use id so the row can open its
// read-only output drawer; it stays optional for old snapshots. The raw command remains behind that
// drawer's scoped RPC rather than inflating or exposing it in every board snapshot.
export const BgShellView = z.object({
  label: z.string(), // the command's `description`, else its first-line summary
  startedAt: z.string(), // ISO8601 of the launch record
  state: z.enum(["running", "stale"]),
  id: z.string().optional(),
  // Can frizz actually END this shell right now? The same contract as SubAgentView.stoppable — computed
  // server-side, never re-derived by a client — but it takes TWO answers, because a shell's control
  // handle is not implied by the thread's transport alone:
  //   · the TAILER contributes "we hold a provider task handle for this shell" (its launch ack names
  //     one, or the task stream paired one to its tool_use id);
  //   · the BOARD contributes "this thread has a control channel at all" (broker-backed Claude).
  // Both must hold. The tailer's half is what closes the seconds-long window between a shell's row
  // appearing (at its tool_use) and its task id arriving (at its launch ack), where an × keyed only on
  // the transport would render and then fail — "We shouldn't show the X if it doesn't fucking work".
  //
  // Until 2026-08-01 this field did not exist and no shell could be stopped: the server refused
  // categorically, on the belief that frizz "holds no handle on its process". That was measured wrong —
  // a background Bash is a TASK in the same session-wide registry a sub-agent lives in, so
  // `Query.stopTask` ends it (verified end-to-end in backend/_live_shell_stop.mts: the OS process is
  // gone inside a second).
  stoppable: z.boolean().optional(),
  // Frizz cannot read this shell's output, so the row must NOT offer a drill-in. True only for a CODEX
  // background exec: codex keeps a yielded command's output inside its own session and hands it back
  // only when the model polls, so there is no file for frizz to tail — unlike a Claude shell, whose
  // output file frizz reads directly. Absent ⇒ readable, which is every row that predates codex shells.
  //
  // A positive flag for the EXCEPTION rather than a `readable` that every existing row would have to
  // start setting: an old snapshot then keeps its drill-in instead of silently losing it.
  outputUnavailable: z.boolean().optional(),
  // The command this shell runs, when frizz knows it independently of the label. Set only on a CODEX
  // row, where it is the ONE thing the board's copy of the shell and the transcript's copy share — see
  // lib/childOps.ts mergeBackgroundShells, which reconciles the two on it. A Claude row leaves it
  // absent: its two copies already reconcile on the launch tool_use id, and a `command` that merely
  // repeated the label would make two identically-described shells collide into one row.
  command: z.string().optional(),
  // ISO8601 of the shell output file's last write — "last active 6 min ago" for a quiet-but-live
  // watcher. Optional (see SubAgentView.lastActivityAt).
  lastActivityAt: z.string().optional(),
  // The PROVIDER's session-wide background-task handle (`bzvtnt3ig`), as distinct from `id`, which is
  // the launch tool_use id. Both name the same shell and neither is a substitute for the other:
  // `id` is what the two copies of a row reconcile on, and this is the handle the runtime hands the
  // MODEL — "Command running in background with ID: bzvtnt3ig" is the only id a worker ever sees, so
  // it is the one it registers a `shell` watcher against. Matching on `id`/`label` alone meant every
  // such watcher was unfireable (scheduler.evalWatchers, 2026-08-14). Absent for a CODEX row, whose
  // single `processId` IS its `id`, and for a Claude row between its tool_use and its launch ack.
  taskId: z.string().optional(),
})
export type BgShellView = z.infer<typeof BgShellView>

// WHY "Mark as done" stopped to ask instead of ending the session outright. The server already knows
// the exact evidence it refused on (an executing turn, named live children, or no telemetry at all) —
// this carries it to the confirm dialog so the human reads "2 sub-agents and 1 background shell are
// still running, here they are" rather than a bare "this thread is still running". Labels are the same
// worker-authored strings the board's ops strip already renders; the lists are capped and the true
// totals travel separately so a long list can say "+N more" instead of silently truncating.
export const CompletionHoldOp = z.object({
  label: z.string(),
  state: z.enum(["running", "stale"]),
})
export type CompletionHoldOp = z.infer<typeof CompletionHoldOp>
export const CompletionHold = z.object({
  turnInFlight: z.boolean().default(false), // the session's own turn is mid-execution
  // Telemetry is missing entirely (live runtime, unreadable transcript). We can neither confirm nor
  // rule out work in flight, so the dialog says exactly that rather than inventing a specific cause.
  unobservable: z.boolean().default(false),
  subAgents: z.array(CompletionHoldOp).default([]),
  subAgentCount: z.number().default(0), // total live sub-agents (≥ subAgents.length)
  bgShells: z.array(CompletionHoldOp).default([]),
  bgShellCount: z.number().default(0), // total live background shells (≥ bgShells.length)
  // The worker is DEAD and its recorded turn never ended — cut off by a reboot, a signal or a crash
  // mid-tool-call (router.cutOffHold). Nothing is running, so nothing will be killed; the hold exists
  // because the thread is not finished and Done would say it was. Optional rather than defaulted so it
  // is absent (⇒ false) on every hold that is not this one, and a pre-change client reads them unchanged.
  cutOff: z.boolean().optional(),
})
export type CompletionHold = z.infer<typeof CompletionHold>

// A PENDING native AskUserQuestion — the worker (or any session) called Claude Code's AskUserQuestion
// tool and is frozen at its TUI dialog, no tool_result yet. Safety net for pre-contract / adopted
// sessions that bypass the thread-file ask channel: we surface the REAL question(s) so the human knows
// what's being asked, and route them to answer in the terminal (a deny-hook enforces the contract
// channel for compliant workers; answering here is deliberately NOT wired — too fragile). Structured
// input is capped defensively (never trust a foreign tool's payload shape).
export const AskOption = z.object({
  label: z.string(),
  description: z.string().optional(),
})
export const AskQuestion = z.object({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(AskOption),
})
export const PendingAsk = z.object({
  questions: z.array(AskQuestion),
})
export type AskOption = z.infer<typeof AskOption>
export type AskQuestion = z.infer<typeof AskQuestion>
export type PendingAsk = z.infer<typeof PendingAsk>

// Cap a foreign string defensively (AskUserQuestion is an UNTRUSTED tool payload — never let it
// fatten a snapshot or a projected transcript). Caps chosen so the read-only render stays a compact card.
function capAsk(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Parse an AskUserQuestion tool_use `input.questions` into the capped structured shape. Defensive at
 *  every level: a missing/misshaped field is skipped, never thrown. Empty result → treat as "no ask".
 *  Shared by the tailer (the pending-ask safety net) and the transcript projector (the settled call's
 *  read-only question card), so the two can never cap or shape the same payload differently. */
export function parseAskUserQuestionInput(input: unknown): AskQuestion[] {
  const qs = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(qs)) return []
  const out: AskQuestion[] = []
  for (const q of qs.slice(0, 8)) {
    if (!q || typeof q !== "object") continue
    const qq = q as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown }
    const question = typeof qq.question === "string" && qq.question.trim() ? capAsk(qq.question.trim(), 400) : ""
    if (!question) continue
    const header = typeof qq.header === "string" && qq.header.trim() ? capAsk(qq.header.trim(), 60) : undefined
    const multiSelect = qq.multiSelect === true ? true : undefined
    const options: AskOption[] = []
    if (Array.isArray(qq.options)) {
      for (const o of qq.options.slice(0, 12)) {
        if (!o || typeof o !== "object") continue
        const oo = o as { label?: unknown; description?: unknown }
        const label = typeof oo.label === "string" && oo.label.trim() ? capAsk(oo.label.trim(), 160) : undefined
        if (!label) continue
        const description = typeof oo.description === "string" && oo.description.trim() ? capAsk(oo.description.trim(), 300) : undefined
        options.push({ label, description })
      }
    }
    out.push({ question, header, multiSelect, options })
  }
  return out
}

/** Parse an answered AskUserQuestion's structured tool result (`toolUseResult.answers` — a record
 *  keyed by question text) into the per-question answer list, parallel to `questions`. Null when the
 *  result carries no readable answers at all (the withdrawn / denied case). */
export function parseAskUserQuestionAnswers(result: unknown, questions: readonly AskQuestion[]): (string | null)[] | null {
  const answers = (result as { answers?: unknown } | null)?.answers
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null
  const byQuestion = answers as Record<string, unknown>
  let any = false
  const out = questions.map((q) => {
    // The result keys carry the UNCAPPED question text; a capped `q.question` still matches by prefix.
    const key = Object.keys(byQuestion).find((k) => k === q.question || capAsk(k.trim(), 400) === q.question)
    const raw = key === undefined ? undefined : byQuestion[key]
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.filter((v) => typeof v === "string").join(", ") : ""
    if (!text.trim()) return null
    any = true
    return capAsk(text.trim(), 600)
  })
  return any ? out : null
}

// ---- THE AWAITING FENCE ---------------------------------------------------------------------------
// A worker ends every turn in ONE terminal state: it needs the human, it is waiting on work that is
// actually running, or it is finished. Each is now said EITHER by a fence or by a registration — an
// open `thread_question` row is a standing sign-off on its own, and so is an armed watch or a recorded
// done, which is why a worker with a pending question rests normally and writes no fence at all. This
// is the FENCE form of the middle one, and it is PURE STRUCTURE — a list of things frizz can look up,
// a duration, and one line of prose.
//
//   shells: [<runtime task id>, …]   background shells it launched   → checked against live telemetry
//   agents: [<runtime agent id>, …]  sub-agents it dispatched        → checked against live telemetry
//   timers: [tmr_…, …]               timers it set                   → checked against thread_timer
//   prs:    [owner/repo#123, …]      PR watchers it registered       → checked against its PR registry
//   for:    2h                       REQUIRED. How long the park may stand (parseAwaitingDurationRaw).
//                                    Capped at a day — or at PR_WATCH_FOR_MAX_MS when every item is a
//                                    `prs:` entry, because an external PR does not move on a day's clock.
//   title:  Waiting on the CI run    OPTIONAL. The resting card's heading, in the worker's own words.
//
// THE FRONTMATTER IS REAL YAML (2026-08-24), parsed by the `yaml` package — the keys are PLURAL and take
// SEQUENCES, block or flow. A bare scalar where a sequence is expected is accepted and normalised to a
// one-element list, because that is the shape a worker most often reaches for and refusing it buys
// nothing. Everything the human reads is prose below the `---`.
//
// …then, after a `---` line, as much arbitrary Markdown as the worker wants (2026-08-17). The structural
// lines are FRONTMATTER; the delimiter is what makes "is this line structural?" answerable, which is what
// lets a retired or unknown kind be refused by name instead of silently swallowed as prose.
//
// IT IS YAML SINCE 2026-08-24, AND THE ONE THING THAT MADE IT IMPOSSIBLE BEFORE WAS `reason:`. This block
// used to read "IT IS NOT YAML, AND MUST NOT BECOME YAML", on three measurements taken 2026-08-17 against
// the real `yaml` package. All three still reproduce — and two of them are about PROSE, not structure:
//
//   `reason: waiting on your merge: the propKeys revert`  → parse error (nested mappings)
//   `reason: see #6422`                                   → silently {"reason":"see"} (` #` opens a comment)
//   two `shell:` lines                                    → parse error (map keys must be unique)
//
// A worker's prose carries colons and `#`-refs constantly, and no YAML parser will take the rest of a
// line verbatim. So `reason:` is RETIRED (below) — the `---` body had already superseded it — and with it
// gone the frontmatter is pure data. The duplicate-key objection is what the plural keys answer; the old
// note conceded arrays would fix it and judged them not worth it, which was right while `reason:` was
// still in the frontmatter and wrong once it left. Re-measured 2026-08-24: `prs: [owner/repo#123]` parses
// correctly (no space before the `#`, so it is not a comment), as do block sequences and mixed kinds.
//
// TWO NEW FAILURE MODES COME WITH IT, and both are handled rather than hoped away: a TAB indent is a hard
// parse error (so a parse failure must BUMP the worker with the error, never park it), and a key with
// nothing under it yields `null` silently (so an empty sequence is refused, not read as a park).
//
// REGISTRATION IS ORTHOGONAL TO THIS FENCE (maintainer 2026-08-15). Dispatching a shell or a sub-agent,
// setting a timer, registering a PR watcher — none of that is a fence, and none of it parks anything.
// Those things simply exist and frizz watches them. The fence is only how a worker declares that it has
// STOPPED, and names which of them it stopped for.
//
// EVERY NAME IS CHECKED, THE MOMENT THE FENCE LANDS. All valid ⇒ the thread goes to Held. Any name that
// is dead, unknown, or another thread’s ⇒ the worker is BUMPED immediately. It does not fail open and it
// does not park: a wait that cannot resolve must never be able to look like one that can.
//
// WHAT WAS DELETED, AND WHY, BECAUSE EACH ONE WAS A WAY TO STALL SILENTLY:
//   `human: <person>`  parked a thread in Held and NOTHING EVER FIRED IT. Waiting on a person is a
//                      ```question — that is what a question is for.
//   `timer: <instant>` an absolute instant the worker computed. One was written 5h55m in the past; it
//                      parsed, armed nothing, and stalled its thread for 5.5 hours. `for:` is a duration
//                      precisely so this cannot be expressed (see parseAwaitingDurationRaw).
//   `pr-watch: ref`    free text the poller armed from. A PR is now a registered watcher with an id.
//   `watch: id`        superseded: a shell is named directly by its runtime handle.
//   `ci:`/`session:`   legacy conditions nothing has fired for a long time.
//   the SINGULAR keys  `shell:`/`agent:`/`timer:`/`pr:` — one line per item, repeated. YAML cannot express
//                      a repeated key, so they became the plural sequence keys above (2026-08-24).
//   `reason:`          the last prose in the frontmatter, and the reason it could not be YAML. It moves
//                      below the `---`, where it always belonged and where it has no length limit.
//   prose bodies       narrowed to `reason:` so the fence is machine-checkable — then given back in full
//                      below the `---` delimiter, where prose cannot be mistaken for structure.
export const AwaitingHint = z.object({
  kind: z.enum(["shell", "agent", "timer", "pr", "for", "title"]),
  value: z.string(),
})
export type AwaitingHint = z.infer<typeof AwaitingHint>

/** The hint kinds that USED to exist, so a worker still writing one can be told rather than ignored.
 *
 *  A worker's contract is frozen into its system prompt at dispatch, so every session started before the
 *  2026-08-15 cut keeps writing these — and a deleted kind does not parse, so it falls into the fence BODY
 *  as prose and the fence silently becomes a park that names nothing. Measured three times in two days,
 *  each as a separate bug report: a `for:`-only fence, a card printing `watch: bvg44v4ij`, and a Goal
 *  loop re-writing `pr-watch:` every six seconds.
 *
 *  Falling through quietly is the whole problem: the worker cannot see which line frizz ignored, so it
 *  writes the same one again. Recognising them by name is what lets the bump say "you wrote `pr-watch:`,
 *  that kind is gone, here is what replaced it" (maintainer 2026-08-17: "BLOCK THEM with an error
 *  message… tell them what is now supported"). */
export const RETIRED_AWAITING_KINDS = ["watch", "pr-watch", "human", "ci", "session", "shell", "agent", "timer", "pr", "reason"] as const
export type RetiredAwaitingKind = (typeof RETIRED_AWAITING_KINDS)[number]

const RETIRED_LINE_RE = new RegExp(`^\\s*(${RETIRED_AWAITING_KINDS.join("|")}):\\s*\\S`, "im")

/** Every retired kind a fence body still carries, in the order the grammar lists them — deduped, because
 *  a worker repeating `pr-watch:` for three PRs has ONE thing to learn, not three. */
export function retiredAwaitingKindsIn(body: string): RetiredAwaitingKind[] {
  if (!body || !RETIRED_LINE_RE.test(body)) return []
  const found: RetiredAwaitingKind[] = []
  for (const line of body.split("\n")) {
    const m = /^\s*([a-z-]+):\s*\S/i.exec(line)
    const kind = m?.[1].toLowerCase()
    if (!kind) continue
    const hit = RETIRED_AWAITING_KINDS.find((k) => k === kind)
    if (hit && !found.includes(hit)) found.push(hit)
  }
  return found
}

/** What each retired kind became, so the bump can say it in one line rather than restating the grammar. */
export const RETIRED_AWAITING_REPLACEMENT: Record<RetiredAwaitingKind, string> = {
  "watch": "`shells: [<the id your runtime gave you>]` (or `agents: [<id>]`) — the same id, in the current sequence",
  "pr-watch": "register the PR with `mcp__frizz__watch_pr`, then name it `prs: [owner/repo#123]`",
  "human": "there is no human gate any more — if you need a person, ask a ```question instead of parking",
  "ci": "CI is not a wait of its own: register the PR with `mcp__frizz__watch_pr` and you are woken when its checks settle",
  "session": "there is no cross-session wait — name the sub-agent you dispatched with `agents: [<id>]`",
  // THE 2026-08-24 CUTOVER. The frontmatter is YAML now, and YAML has no repeated keys — so the four
  // one-per-line item kinds became plural sequences, and `reason:` (the prose that made YAML impossible)
  // moved below the `---`. Every worker dispatched before the cut has the old grammar frozen into its
  // system prompt and will keep writing these, which is exactly what these five lines are for.
  "shell": "`shells: [<id>, <id>]` — one YAML sequence, not one line per shell",
  "agent": "`agents: [<id>, <id>]` — one YAML sequence, not one line per sub-agent",
  "timer": "`timers: [tmr_…]` — one YAML sequence, not one line per timer",
  "pr": "`prs: [owner/repo#123]` — one YAML sequence, not one line per PR",
  "reason": "put it below the `---` as ordinary Markdown — the frontmatter is YAML now and takes no prose",
}

/** The four kinds that NAME A LIVE THING. Every one is checked against something frizz can look up — a
 *  runtime handle in this thread's telemetry, or a row in one of its registries — which is the whole
 *  point of the grammar. `for`/`reason` describe the park itself and name nothing. */
/** THE ONE FENCE-FRONTMATTER PARSER, and it lives here because there used to be TWO.
 *
 *  The server folds a fence out of the transcript to decide whether the thread PARKS; the client parses
 *  the same fence to decide how it RENDERS. Those were separate implementations with a comment on each
 *  begging the next reader to keep them in step — and on 2026-08-24 the YAML cutover moved one and not
 *  the other, so a correct fence parked correctly on the server and printed its own raw frontmatter at
 *  the human in the in-chat card. That is the exact bug class the twin comments predicted, and the only
 *  fix that ends it is a single function both sides call.
 *
 *  DEFENSIVE BY CONTRACT: it runs on whatever an LLM wrote, so it never throws. A parse failure, a
 *  non-mapping document, a key holding the wrong type, or an empty sequence all yield NO hints — which
 *  makes the fence name less than it claimed and gets the worker BUMPED rather than parked. Silently
 *  parking on a fence frizz could not read is the one outcome that must be impossible.
 */

/** Any `key: value` line at the top level of the frontmatter. Deliberately WIDER than the grammar: its
 *  job is to spot a line that CLAIMS to be structural, so an unrecognised key can be refused BY NAME.
 *  Hyphens are in the class because the oldest retired kind is `pr-watch:`, and a regex that could not
 *  see it let one pass as prose. */
const AWAITING_KEY_RE = /^([a-z][a-z-]*):\s*(\S.*)?$/i

/** The YAML keys the frontmatter recognises: four PLURAL sequences of things frizz can look up, plus the
 *  two scalars `for:` and `title:`. Anything else is not structure and falls through to the body. */
const AWAITING_YAML_KEYS = new Set(["shells", "agents", "timers", "prs", "for", "title"])

/** Which singular hint kind each plural sequence key produces. The WIRE SHAPE is unchanged by the
 *  2026-08-24 cutover — every consumer still reads a flat `{kind, value}` list with SINGULAR kinds — so
 *  only the grammar the worker WRITES moved to YAML. */
const AWAITING_SEQUENCE_KEYS: { [key: string]: AwaitingItemKind | undefined } = {
  shells: "shell",
  agents: "agent",
  timers: "timer",
  prs: "pr",
}

/** Defensive caps, shared so the sidebar gloss and the in-chat card can never render a divergent row. */
export const AWAITING_HINT_MAX = 8
export const AWAITING_HINT_VALUE_MAX = 200

/** `title:` — the resting card's heading in the WORKER'S OWN WORDS, replacing the derived one
 *  ("Awaiting" / "Background shells running", see awaitingBackgroundLabel).
 *
 *  IT IS A HEADING, NOT A SENTENCE, and the cap is what keeps it one. The card already carries the
 *  worker's full prose below it and a row per awaited thing under that, so a title that restates either
 *  is the doubling this card has been trimmed for twice.
 *
 *  40 IS MEASURED, NOT CHOSEN. The heading renders at 16px/600 in whichever font the reader has set, and
 *  it WRAPS rather than truncating — so the cap has to fit the NARROWEST card on ONE line or a long park
 *  grows a two-line heading. Measured in a real browser on the queue card at its 368px content box
 *  (awaiting-bg-fixture, 500px viewport): MONO is the binding font at 8.40px per character against sans's
 *  7.21px, and in mono even an all-wide-glyph 40 ("WmWm…") draws 351.88px and still fits. 44 does not —
 *  a 43-character heading measured 369.47px in mono and wrapped to two line boxes.
 *
 *  Longer is TRIMMED on a word boundary rather than refused: a worker that overruns still meant something
 *  specific, and "Waiting on the three-platform CI run…" says more than falling back to "Awaiting".
 *
 *  Sentence case, like every other piece of copy in the app (CLAUDE.md), and the trim never invents
 *  capitalisation. */
export const AWAITING_TITLE_MAX = 40

/** The title as it will RENDER: collapsed to one line, cap-trimmed on a word boundary. Applied at PARSE
 *  time so the stored hint is already what the card draws — every consumer then agrees by construction,
 *  and nothing downstream has to re-trim. */
export function trimAwaitingTitle(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim()
  if (flat.length <= AWAITING_TITLE_MAX) return flat
  const cut = flat.slice(0, AWAITING_TITLE_MAX)
  const space = cut.lastIndexOf(" ")
  return `${(space > AWAITING_TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[.,;:–—-]$/, "").trimEnd()}…`
}

/** Split an ```awaiting fence body into its hints and its prose.
 *
 *  FRONTMATTER, THEN MARKDOWN: structural lines first, a `---` line ends them, everything after is
 *  arbitrary prose. No delimiter ⇒ the whole fence is frontmatter, which is how every fence written
 *  before 2026-08-17 parses.
 *
 *  A RETIRED or UNKNOWN key never reaches the YAML parser, and that is not an optimisation. A retired key
 *  would otherwise surface as an opaque "map keys must be unique" or a nested-mapping error, when the
 *  worker needs to be told BY NAME what replaced it — the scheduler reads those lines back out of the
 *  BODY with `retiredAwaitingKindsIn`, exactly as it did under the line grammar. */
export function splitAwaitingFrontmatter(raw: string): { body: string; hints: AwaitingHint[] } {
  const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""))
  const delimiter = lines.findIndex((l) => /^\s*---+\s*$/.test(l))
  const frontmatter = delimiter === -1 ? lines : lines.slice(0, delimiter)
  const after = delimiter === -1 ? [] : lines.slice(delimiter + 1)
  const rest: string[] = []
  const yamlLines: string[] = []
  // `structural` tracks whether the line we are on belongs to the YAML document. A block sequence's items
  // and any indented continuation belong to the KEY ABOVE THEM, so they follow that key's fate — which is
  // what keeps a retired `pr:` with its list underneath from orphaning a bare sequence into the parser.
  let structural = true
  for (const line of frontmatter) {
    const m = line.match(AWAITING_KEY_RE)
    const key = m?.[1].toLowerCase()
    if (m && key) structural = AWAITING_YAML_KEYS.has(key)
    // A LINE THAT IS NOT A KEY AND NOT A CONTINUATION IS PROSE, exactly as it was under the line grammar:
    // a worker that omits the `---` and writes its handoff straight into the frontmatter must still park.
    // Feeding that sentence to YAML would be a parse error and would cost it the whole fence.
    else if (line.trim() !== "" && !/^\s/.test(line) && !/^\s*-\s/.test(line)) structural = false
    ;(structural ? yamlLines : rest).push(line)
  }
  const parsed = parseAwaitingYaml(yamlLines.join("\n"))
  // Unparsed lines go to the BODY rather than being dropped: the worker has to be able to see what it
  // wrote, or the correction it gets is about a fence it can no longer read.
  if (!parsed.ok) rest.push(...yamlLines)
  rest.push(...after)
  return { body: rest.join("\n").trim(), hints: parsed.hints.slice(0, AWAITING_HINT_MAX) }
}

function parseAwaitingYaml(text: string): { ok: boolean; hints: AwaitingHint[] } {
  if (!text.trim()) return { ok: true, hints: [] }
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch {
    return { ok: false, hints: [] } // not YAML at all — a tab indent, a stray bracket, an unclosed quote
  }
  // A frontmatter that parses to a scalar or a sequence is not a mapping of keys, so it names nothing —
  // and the worker still needs to see it, hence `ok: false` rather than an empty success.
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, hints: [] }
  const hints: AwaitingHint[] = []
  const push = (kind: AwaitingHint["kind"], raw: unknown) => {
    // A number or a boolean is a value a worker plausibly wrote unquoted; anything structural is not a
    // name and cannot be looked up, so it is dropped rather than stringified into nonsense.
    if (raw === null || raw === undefined || typeof raw === "object") return
    const value = String(raw).trim()
    if (!value) return
    hints.push({ kind, value: value.slice(0, AWAITING_HINT_VALUE_MAX) })
  }
  for (const [rawKey, raw] of Object.entries(doc as { [key: string]: unknown })) {
    // Case-insensitive, because the line grammar was and a worker that shouts `PRS:` means `prs:`. YAML
    // itself is case-sensitive, so without this the key would parse and then silently match nothing.
    const key = rawKey.toLowerCase()
    const itemKind = AWAITING_SEQUENCE_KEYS[key]
    if (itemKind) {
      // A BARE SCALAR IS ACCEPTED where a sequence is expected — `prs: acme/app#1` is what a worker
      // reaches for with one item, and refusing it would fail a fence that says exactly the right thing.
      for (const entry of Array.isArray(raw) ? raw : [raw]) push(itemKind, entry)
    } else if (key === "for") {
      push("for", raw)
    } else if (key === "title") {
      // Capped HERE rather than at the card, so the hint on the wire is already the string that renders
      // and no consumer can draw a longer one. `push` slices at AWAITING_HINT_VALUE_MAX after this, which
      // a trimmed title is always well inside.
      if (typeof raw === "string" || typeof raw === "number") push("title", trimAwaitingTitle(String(raw)))
    }
  }
  return { ok: true, hints }
}

/** The heading this fence asked for, already trimmed — null when it named none, which is every fence
 *  written before 2026-08-26 and most written after. The LAST one wins: YAML cannot hold a repeated key,
 *  so this can only be reached by a hand-built hint list, and the last write is the ordinary reading. */
export function awaitingFenceTitle(hints: readonly AwaitingHint[] | undefined): string | null {
  let title: string | null = null
  for (const h of hints ?? []) {
    if (h.kind !== "title") continue
    const value = trimAwaitingTitle(h.value)
    if (value) title = value
  }
  return title
}

export const AWAITING_ITEM_KINDS = ["shell", "agent", "timer", "pr"] as const
export type AwaitingItemKind = (typeof AWAITING_ITEM_KINDS)[number]
export function isAwaitingItemKind(kind: string): kind is AwaitingItemKind {
  return (AWAITING_ITEM_KINDS as readonly string[]).includes(kind)
}

/** `for: 2h` — how long this park may stand before frizz bumps the worker to re-check everything.
 *
 *  A DURATION, NEVER AN INSTANT, and that is the entire point. The grammar this replaced took an absolute
 *  ISO instant, which a worker has to compute — and on 2026-08-15 one wrote `timer: 2026-08-14T19:45:00Z`
 *  into a fence it published at `01:39:59Z`, an instant already 5h55m gone. It parsed (the old validator
 *  checked shape only), armed nothing (an already-past timer is never registered — the boot no-mass-fire
 *  guard), and the thread sat 5.5 hours looking parked with nothing able to wake it. A duration cannot be
 *  written in the past, needs no clock arithmetic and carries no timezone, so that failure is not merely
 *  caught here — it is unrepresentable. */
const AWAITING_DURATION_RE = /^(\d{1,5})(s|m|h|d)$/
const DURATION_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
/** The park's ceiling for a wait on the thread's OWN running work — a background shell, a sub-agent.
 *  A worker may ask for less; anything longer is capped rather than refused, so a fat-fingered
 *  `for: 9999d` still parks — it just cannot disappear a thread for a decade.
 *
 *  A DAY IS RIGHT FOR THIS KIND AND ONLY THIS KIND. A shell or a sub-agent lives inside the session
 *  that launched it, so a wait on one that has stood for a day is almost always a wait on something
 *  already dead. A PULL REQUEST is nothing like that and gets its own, far higher ceiling — see
 *  PR_WATCH_FOR_MAX_MS. */
export const AWAITING_FOR_MAX_MS = 24 * 60 * 60 * 1000
/** Milliseconds as WRITTEN, uncapped — for a caller that has to know whether the ceiling bit. Every
 *  wait applies one; none of them may apply it silently. */
export function parseAwaitingDurationRaw(value: string): number | null {
  const m = AWAITING_DURATION_RE.exec(value.trim())
  if (!m) return null
  const ms = Number(m[1]) * DURATION_UNIT_MS[m[2]]
  if (!Number.isFinite(ms) || ms <= 0) return null
  return ms
}

// A user-chosen snooze is UI lifecycle state, not agent-authored transcript state. The browser
// serializes local date/time input with Date#toISOString, so the wire/storage representation is one
// unambiguous UTC instant. Keeping this stricter than the legacy awaiting-timer grammar avoids locale
// strings and offset-normalization surprises at the RPC boundary.
export const SnoozeUntil = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  "Snooze time must be an ISO-8601 UTC instant",
).refine((value) => {
  const instant = Date.parse(value)
  // Date.parse normalizes impossible calendar dates in some runtimes (for example February 31).
  // Round-trip the canonical UTC serialization so the durable deadline is a real exact instant.
  return Number.isFinite(instant) && new Date(instant).toISOString() === value
}, "Snooze time must be valid")
export type SnoozeUntil = z.infer<typeof SnoozeUntil>

// The follow-up a snooze carries. Its presence is what turns a snooze from a passive reminder (the
// card re-surfaces, you act) into a SCHEDULED BUMP (frizz resumes the agent with this text at the
// deadline). Trimmed at the boundary so whitespace can never arm a wake that delivers nothing, and
// capped like a composer message because it is delivered as an ordinary user turn.
export const SNOOZE_PROMPT_MAX = 4000
export const SnoozePrompt = z.string().trim().min(1).max(SNOOZE_PROMPT_MAX)
export type SnoozePrompt = z.infer<typeof SnoozePrompt>

// ---- THE RECURRING PROMPT (scheduler SOURCES 4 and 5) --------------------------------------------
// ONE piece of text, and up to two independent reasons to send it:
//
//   ON REST      (SOURCE 5) — every time the thread comes to a stop. No clock and nothing to tune: if
//                it stopped, it is prompted. This is what drives an effort forward.
//   ON SCHEDULE  (SOURCE 4) — every N minutes on a clock the operator sets, consulting nothing about
//                what the thread is doing and DELIVERED MID-TURN. This is what reaches a thread that
//                never stops.
//
// Either, both, or neither. NEITHER IS THE OFF STATE — there is deliberately no separate enable switch,
// because with both triggers off nothing can fire and a third toggle would only be a way to disagree
// with the other two (maintainer 2026-08-03: "we can delete the top-level toggle since you can now
// achieve that by just disabling both of the other two toggles").
//
// WHY ONE PROMPT AND NOT TWO FEATURES. These shipped as separate features with separate prompts, and
// the argument for keeping them apart rested on something that is no longer true. While a beat was held
// until the thread rested, a schedule could only ever deliver AT a rest — and the rest trigger fires at
// every rest — so with one shared text the schedule's deliveries were a strict subset of the rest
// trigger's: same words, same instants, nothing added. Mid-turn delivery is what pulled the two apart,
// and once they genuinely diverge, "nudge this thread whenever it stops, and at least every N minutes
// even if it doesn't" is ONE intent that used to cost two prompts and two toggles to express.
//
// What that costs, stated plainly: you can no longer run two DIFFERENT texts on the two triggers.
// Weighed and accepted — the shared-intent case is the common one.
export const RECURRING_PROMPT_MAX = SNOOZE_PROMPT_MAX
// One minute floor: a delivery is read at the agent's next sampling boundary, so a sub-minute cadence
// buys no promptness — it only churns the outbox and talks over the work. One day ceiling keeps a
// forgotten schedule from being indistinguishable from a dead one.
export const RECURRING_MIN_INTERVAL_SECONDS = 60
export const RECURRING_MAX_INTERVAL_SECONDS = 24 * 60 * 60
export const RecurringPromptText = z.string().trim().min(1).max(RECURRING_PROMPT_MAX)

// WHAT THE PANEL PREFILLS on a thread that has never armed one. The overwhelmingly common reason an
// operator reaches for this control is the same one every time — the thread stopped with work left in it
// — so the panel writes that sentence for them rather than making them phrase it again. It is a starting
// point, not a fixed string: it is seeded into an editable textarea and anything typed over it wins, and
// it arms NOTHING until the operator switches a trigger on (see RecurringPromptControl).
//
// IT IS DELIBERATELY LOPSIDED (maintainer 2026-08-14: "should bias the agent strongly towards continuing
// with its work if there is incomplete work, unless there is a pressing or imminent decision that is
// needed from the human"). It lands on a thread that has already stopped, so the only outcome worth
// buying is the one where it starts again — hence it sends the worker straight back to the work.
//
// MAINTAINER-AUTHORED, VERBATIM (2026-08-24: "when did this get so fcking wordy?" … "Use my suggestion
// verbatim"). The text below is the maintainer's own wording, byte for byte — do not grow it back. It
// had grown twice: `0092d21c` added the decide-don't-ask clause and an enumeration of the endings a
// worker mistakes for one, `b2d7dc58` cut it to one sentence on the maintainer's instruction, and
// `b7cb8723` grew it again to 92 words carrying two ceiling guards. Those guards were real — traced
// 2026-08-17 on `investigate-nubjs-nub-642`, dispatched to TRIAGE issue #642, which produced the
// analysis, waited 36 hours on an unanswered question, and then — bumped by this prompt at every rest,
// with no ceiling on "keep going" — decided the question itself and shipped seven commits. But the
// guards no longer need to live HERE: the worker contract states the ceiling at length (discovered work
// is a finding to report, a triage/review/plan is finished when its write-up is), and the fence-less-rest
// nudge (`SIGNOFF_NUDGE_MESSAGE`, pinned in `signoff-nudge.test.ts`) repeats it. So this string went
// back to the instruction alone.
//
// NO BACKTICKED FENCE NAMES IN HERE. This text is rendered as markdown wherever the operator sees it,
// and a lone ``` opens a code block that swallows the rest of the card.
//
// Nothing here teaches the ```done exit, because the trailer already does (`OPT_OUT_NOTE`), on every
// delivery, whatever the operator has typed over this text.
export const DEFAULT_RECURRING_PROMPT =
  "If additional work remains on the original task, keep going. Make decisions autonomously."
export const RecurringIntervalSeconds = z
  .number()
  .int()
  .min(RECURRING_MIN_INTERVAL_SECONDS)
  .max(RECURRING_MAX_INTERVAL_SECONDS)

// What the board renders for a thread carrying one. The three triggers are independent booleans rather
// than one `enabled` flag, and the text survives all of them being switched off so re-arming costs no
// retyping. `intervalSeconds` is present whenever a schedule has ever been set, INCLUDING while the
// heartbeat is off — otherwise flipping the schedule back on would lose the cadence the operator chose.
export const ThreadRecurringPrompt = z.object({
  prompt: z.string(),
  /** The three mechanisms, named as the panel labels them. `stopHook` fires at every rest; `heartbeat`
   *  fires on `intervalSeconds`; `postCompaction` fires whenever the harness summarizes the thread's
   *  context away. The latter two both reach the agent mid-turn. */
  stopHook: z.boolean(),
  heartbeat: z.boolean(),
  postCompaction: z.boolean(),
  intervalSeconds: z.number().int().positive().optional(),
  armedAt: z.string(),
  /** Last delivery per trigger; stamped separately so each reads its own clock. */
  lastRestFiredAt: z.string().optional(),
  lastScheduleFiredAt: z.string().optional(),
  lastCompactFiredAt: z.string().optional(),
}).strict()
export type ThreadRecurringPrompt = z.infer<typeof ThreadRecurringPrompt>

// ---- The opt-out ---------------------------------------------------------------------------------
// THE OPT-OUT IS THE ```done FENCE, as of 2026-08-11. A worker that signs off as done has said "there
// is no further work here", and frizz stops prompting it — every trigger, because a run that keeps
// being woken has not stalled and the whole point of the signal is that it has finished.
//
// IT USED TO BE A SENTINEL WORD, `ALLDONE`, and collapsing the two is the change. One vocabulary beats
// two: the worker already has to end its turn with a fence, and a second magic token that ALSO means
// "stop" was a rule to remember on top of a rule to remember. Maintainer 2026-08-11: "we should drop
// ALLDONE in favor of simply ```done".
//
// It is not a "skip this one" — it is the end of the arrangement, and nothing but new activity on the
// thread reopens it. Every delivered message therefore names it in one de-emphasized line and warns
// against it in the same breath: the failure it guards is a worker that signs off to look tidy and
// silently parks an effort nobody is watching.
//
// Mechanically it needs no stored state at all, which is what makes it honest: both the fence and the
// legacy sentinel are folded off the FINAL assistant message, so either holds for exactly as long as
// that message is the thread's last word. Anything the thread says or receives afterwards reopens the
// loop by itself.

// Claude Code narrates its OWN control action into the transcript: every turn cut short leaves a bare
// `[Request interrupted by user]` user record. Frizz cuts turns short as a feature — "send now" (⌘⏎ and
// the queue's push-through button) interrupts the running turn so the worker reads the queue at once —
// so the marker landed as a human bubble directly above the very message that caused it, saying nothing
// the reader did not just do (maintainer 2026-08-14). The broker's own shutdown writes the same record,
// which is worse: nobody typed anything at all.
//
// EXACT match on the trimmed text, deliberately not a prefix: all 306 of these records across the 3933
// transcripts on this machine are one of these two strings ALONE in a single text block, so a human
// message that opens by quoting the marker keeps its bubble.
//
// Lives HERE rather than in transcript.ts (its first caller) because the tailer needs it too — an
// interrupt receipt is the one `user` record that means the turn is OVER, not starting — and
// transcript.ts already imports from tailer.ts, so the other direction would close a cycle.
const INTERRUPT_MARKERS = ["[Request interrupted by user]", "[Request interrupted by user for tool use]"]
export function isInterruptMarker(text: string): boolean {
  return INTERRUPT_MARKERS.includes(text.trim())
}

/** LEGACY. The sentinel that used to be the opt-out, superseded by the ```done fence on 2026-08-11.
 *
 * STILL HONOURED, and deliberately: workers dispatched before the change are running right now with
 * trailers that told them to reply `ALLDONE`, and a scheduler that stopped recognizing it the same day
 * would silently take their exit away and loop them forever. It is no longer ADVERTISED anywhere — see
 * `OPT_OUT_NOTE` — so nothing new learns it, and the recogniser can be deleted once no session predates
 * the change. */
export const ALLDONE_SENTINEL = "ALLDONE"

/** Does this assistant text defer its recurring prompt? True iff some line, stripped of markdown
 * emphasis/backticks and trailing punctuation, IS the sentinel.
 *
 * CASE-SENSITIVE, which is load-bearing now that the word is `AWAITING`: frizz's own signal-fence
 * grammar opens with ```awaiting, and a worker parking on a fence writes that token constantly. Lowered
 * case would make every ```awaiting fence silently suppress a bump as well. */
export function saysAllDone(text: string | undefined): boolean {
  if (typeof text !== "string") return false
  for (const line of text.split(/\r?\n/)) {
    // Tolerate the ways a model dresses a line: a list bullet, bold/italic, code ticks, a quote marker,
    // and trailing punctuation. The comparison itself is EXACT and case-sensitive — "all done" is prose,
    // and only the shouted token is the opt-out.
    const bare = line.trim().replace(/^[*_`>\s-]+/, "").replace(/[*_`.!\s]+$/, "")
    if (bare === ALLDONE_SENTINEL) return true
  }
  return false
}

// THE TRAILER, in one de-emphasized line, on both sources.
//
// It has two jobs pulling against each other: a worker being re-prompted needs to know the opt-out
// exists at all, and it must not reach for it. So the line OFFERS and WARNS in the same breath, and
// stays parenthetical — the operator's own words are the message; this is a footnote about the
// machinery. Expanding it is how a worker starts treating "am I allowed to stop?" as the question,
// instead of the work it was actually sent.
const OPT_OUT_NOTE =
  "To stop these, sign off with a ```done fence — but ONLY when the work is genuinely finished:" +
  " it files this thread away, and nothing but new work from the human reopens it."

/** What frizz delivers when the ON REST trigger fires: the operator's words VERBATIM, then the trailer.
 * Kept beside the parser so the wording sent and the wording recognized can never drift apart.
 *
 * IT DOES NOT ADVERTISE THE OTHER EXIT, and that is a budget decision rather than an oversight. An
 * ```awaiting fence on a wait the scheduler owns now holds this trigger too (scheduler
 * `parkedOnAWaitItCannotAdvance`), so a parked worker could in principle be told so here — but the
 * trailer is capped at a footnote, the shared note already spends all of it, and the worker contract
 * teaches the park at length. A worker that parks stops being bumped, so it never reads this line
 * again; the one that does read it is mid-work, where ```done is the only exit worth naming.
 *
 * `overQuestion` IS THE ONE CASE THAT NEEDS MORE THAN A FOOTNOTE. The rest trigger fires over an
 * unanswered ```question fence (scheduler `restMessageIsSignedOff`), so this delivery can land on a
 * worker whose own last word was a question to the human. Handed the bare goal there, the honest thing
 * for it to do is ask again — its question really is unanswered — and the operator gets the same card
 * twice, which is precisely the loop the old question hold existed to prevent. So the delivery that
 * crosses a pending question SAYS SO: no answer is coming, make the call yourself. The clause carries no
 * parenthesis, because `RECURRING_TRAILER` matches the trailer up to the first one. */
export function restPromptMessage(prompt: string, opts: { overQuestion?: boolean } = {}): string {
  const note = opts.overQuestion ? `${OVER_QUESTION_NOTE} ${OPT_OUT_NOTE}` : OPT_OUT_NOTE
  return `${prompt.trim()}\n\n(Goal — sent each time you come to rest. ${note})`
}

// What the trailer adds when the bump crosses the worker's own unanswered question. It has to do two
// things the plain note does not: overrule the worker's correct instinct to re-ask, and tell it what to
// do with the decision instead — because a call the operator cannot see is worse than the question.
//
// It named an operator SETTING until 2026-08-16 ("the operator has AUTONOMOUS MODE on"), which stopped
// being true when the question hold was deleted: arming a Goal at all is now the whole of that consent.
// Maintainer, on dropping the switch: "If somebody enables the stop hook goal, then that kind of implies
// to me that they don't really want to answer any more questions."
const OVER_QUESTION_NOTE =
  "Your ```question is still unanswered, and a Goal armed at rest means the operator is not waiting" +
  " to answer it: decide it yourself, say in one line which way you went and what would reverse it," +
  " and carry on. Do NOT re-ask it."

/** What frizz delivers when the POST-COMPACTION trigger fires (scheduler SOURCE 7).
 *
 * This one lands in a context that has just been summarized away, which is the whole reason it exists —
 * so unlike its two siblings the trailer must first say WHERE the reader is, or the operator's words
 * arrive with nothing to attach to. It also answers the compaction preamble in the same breath: a
 * worker reading "a previous conversation that ran out of context" routinely treats it as a report on
 * ITSELF and starts winding down, and this delivery is the one piece of frizz text guaranteed to land
 * in that exact window.
 *
 * Like the schedule trigger's, it may arrive MID-TURN — a compaction does not stop the work. */
export function compactionPromptMessage(prompt: string): string {
  return (
    `${prompt.trim()}\n\n(Goal — your context was just compacted. This is what you asked to` +
    " be handed back: re-ground on it before doing anything else, and treat it as authoritative over" +
    " anything the summary implies. The window is close to empty again, which is normal and not a reason" +
    ` to wind down or hand off. ${OPT_OUT_NOTE})`
  )
}

/** What frizz delivers when the ON SCHEDULE trigger fires. Same text, same shape, and it names the
 * cadence — which is the ONE thing that distinguishes the two deliveries now that the prompt is shared.
 * A worker needs that distinction: a scheduled delivery may arrive MID-TURN, so reading one does not
 * mean it has stopped.
 *
 * The trailer's exact wording is pinned by `parseRecurringPrompt` below and by the prompt goldens —
 * change one and you must change all three. */
export function schedulePromptMessage(prompt: string, intervalSeconds: number): string {
  return `${prompt.trim()}\n\n(Goal — sent every ${formatIntervalLabel(intervalSeconds)}. ${OPT_OUT_NOTE})`
}

/** "10m" / "1h 30m" / "90s" — whole units only, because a cadence printed to the second promises a
 * precision the delivery does not have (it is read at the agent's next sampling boundary).
 *
 * The house duration grammar (`web/src/lib/durationLabels.ts`), which is also why an hour and a half
 * is `1h 30m` rather than the `1.5 hr` this printed until 2026-08-31. That decimal was not only off
 * the house grammar, it broke the round trip: `RECURRING_TRAILER` stops the cadence capture at the
 * first `.`, so a 90-minute goal's trailer never parsed back into a wake divider. */
export function formatIntervalLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

/** What a delivered recurring prompt looks like once it is back out of the transcript.
 *
 * The chat needs to tell a delivery from a human message, and to say WHICH TRIGGER fired, and the
 * transcript carries no structure — a delivery is an ordinary user turn. So this parses the trailer the
 * two composers above emit, exactly as `parseGithubWakeSteer` parses the steer its own formatter writes.
 * That is not a text GUESS: the format is frizz's, it is defined ten lines up, and both directions live
 * in this file so they cannot drift. Anything that does not match returns undefined and renders as it
 * did before — text is never lost to a parse. */
export interface RecurringPrompt {
  kind: "rest" | "schedule" | "compaction" | "signoff"
  /** The cadence as the trailer stated it ("10 min"); absent for a rest or post-compaction delivery. */
  every?: string
  /** The operator's own words, with the trailer removed. */
  prompt: string
}
// The LEGACY alternates matter: transcripts written before the two features merged carry
// "Stop hook — …" / "Heartbeat — sent every …", and those messages are still sitting in every open
// thread on disk. Dropping them from the pattern would not lose the text (a non-match falls through to
// plain rendering) but it would silently demote a whole thread's history from wake dividers to prose.
//
// The post-compaction alternate does not say "sent …" at all — its trailer opens by telling the reader
// where they are, because it lands in a window that was just emptied. So it is matched on its own
// opening clause rather than bent into the shared "sent X" shape.
const RECURRING_TRAILER =
  /\n\n\((?:Goal|Recurring prompt|Stop hook|Heartbeat) — (?:sent (?:(each time you come to rest)|every ([^.)]+))|(your context was just compacted))\. [^)]*\)$/
export function parseRecurringPrompt(text: string | undefined): RecurringPrompt | undefined {
  if (typeof text !== "string") return undefined
  // Frizz's built-in sign-off reminder (scheduler SOURCE 9). It carries no trailer — it is not the
  // operator's text with a note attached, it IS frizz's text — so it is matched on its own opening
  // marker and collapsed like any other repeating frizz delivery. Left as a card it dominated the queue
  // item it was complaining about (maintainer 2026-08-12, with a screenshot of exactly that).
  if (text.trimStart().startsWith(SIGNOFF_NUDGE_MARKER)) return { kind: "signoff", prompt: "" }
  const m = RECURRING_TRAILER.exec(text.trimEnd())
  if (!m) return undefined
  const prompt = text.trimEnd().slice(0, m.index).trim()
  if (!prompt) return undefined
  if (m[3]) return { kind: "compaction", prompt }
  return m[2]
    ? { kind: "schedule", every: m[2].trim(), prompt }
    : { kind: "rest", prompt }
}

// ---- ONE-OFF TIMERS (scheduler SOURCE 6) ---------------------------------------------------------
// A worker's own alarm clock: text it asks frizz to hand back at ONE instant, once. It is the recurring
// prompt's ON SCHEDULE trigger with the repetition taken out — same durable outbox, same mid-turn
// delivery — and a thread may hold ARBITRARILY MANY at a time, which is the whole reason they are rows
// of their own rather than another set of `recurring_*` columns on the session (one row can hold one
// arrangement; a worker that wants "check the deploy in 10 min AND re-read the spec in an hour" needs
// two).
//
// MID-TURN, like the heartbeat and unlike the human's snooze. A timer set for 15:00 that a busy thread
// only hears at 15:50 has not kept its promise, and "in ten minutes" is the instruction being obeyed.
// Both transports take a queued mid-turn message without aborting the work in flight.
//
// NO ALLDONE OPT-OUT, and no trailer teaching one. That sentinel exists because a RECURRING trigger is
// an infinite bump generator with no terminating condition; a one-off has exactly one delivery in it, so
// the only thing worth saying in the trailer is that this was a timer and it will not fire again.
export const TIMER_PROMPT_MAX = SNOOZE_PROMPT_MAX
// Ten seconds is the scheduler's own tick, so a shorter delay would promise a precision the delivery
// cannot have. Thirty days is far past any real "come back to this later" while still rejecting a
// mistyped epoch. The armed CAP is what makes "arbitrarily many" safe: a looping tool call cannot fill
// the table, and 64 outstanding alarms is well beyond what any real effort schedules.
export const TIMER_MIN_DELAY_SECONDS = 10
export const TIMER_MAX_DELAY_SECONDS = 30 * 24 * 60 * 60
export const TIMER_MAX_ARMED = 64

export const TimerPromptText = z.string().trim().min(1).max(TIMER_PROMPT_MAX)

/** What frizz delivers when a one-off timer fires: the worker's own words VERBATIM, then a one-line
 *  trailer naming the INSTANT — with several timers armed at once, the instant is the only thing that
 *  says WHICH one this is.
 *
 *  Deliberately NOT parsed back out for a bespoke transcript line, unlike a recurring delivery. That
 *  parser exists because a recurring prompt repeats the same paragraph down the whole transcript and has
 *  to collapse to a divider; a one-off is said once, so the chat's generic first-party wake card — the
 *  one already written for "a CI/timer/limit wake" — shows it correctly with no new component. */
/** What frizz delivers when one of a thread's background shells finishes while the thread is RESTING.
 *
 *  There is no operator text to carry — nobody asked for this wake, a finished shell simply happened —
 *  so the message IS the news, and it has two jobs: say WHICH shell precisely enough to act on, and say
 *  why frizz is the one saying it. The second matters because the agent has a runtime notification for
 *  exactly this event and will reasonably wonder why it did not arrive: it only ever reaches a RUNNING
 *  turn, so a shell that finishes behind a rested worker is never reported by anyone else. */
// ---- THE AGENT-FACING TRAILERS, AS CONSTANTS ------------------------------------------------------
// Each of these is a paragraph frizz writes FOR THE WORKER at the end of a wake it composed: what the
// registration is, whether it is still armed, and which tool drops it. A human reading the transcript
// has no watcher to re-register and no tool to call, so none of it is ever news to them.
//
// THEY ARE CONSTANTS SO ONE FUNCTION CAN STRIP ALL OF THEM (`stripWakeTrailer`, beside the rest of the
// wake grammar). The dividers already drop the trailer by never rendering it — but that only holds for
// a delivery some parser RECOGNIZED, and the browser is the half that routinely cannot: a tab is a
// build behind whenever frizz restarts under it, so the first delivery in a shape its bundle predates
// falls through to the raw-text card and prints this boilerplate to the operator (maintainer
// 2026-09-04, on a conflict wake an hour-old tab could not parse: "this should just never show up").
// Stripping in the display projection makes that impossible for a tab of ANY age, and for any wake
// shape, including the ones not written yet.
//
// The WORKER's copy is untouched — the projection narrows what is shown, never what was delivered.
export const PR_WATCH_SPENT_TRAILER = "(This watcher is spent — there is nothing further to report on a finished PR.)"
export const PR_WATCH_ARMED_TRAILER = "(Registered PR watcher — STILL ARMED. It reports again on the next CI change, review,"
  + " comment, label, conflict or review request. Drop it with `mcp__frizz__watch_pr` when it stops"
  + " mattering.)"
export const SHELL_DONE_TRAILER = "(Frizz sends this because it finished after you came to rest, where your runtime's own completion"
  + " notification does not reach you. Read its output if you still need it.)"

/** What frizz delivers when a REGISTERED PR WATCHER has something to report.
 *
 *  Two things can move and the message names which: CI reaching a terminal verdict, and new review or
 *  comment activity. Both in one message when both happened in one poll — a worker woken twice for one
 *  glance at the same PR is a wasted turn.
 *
 *  It says the watcher is STILL ARMED, because the opposite is the expensive mistake: a worker that
 *  thinks its watcher is spent will re-register (a duplicate, so two wakes per event) or stop waiting.
 *
 *  Its STATUS lines read back out through `parsePrWatchWake`, which lives with the rest of the wake
 *  grammar (the `WAKE_REF` pattern it shares is declared there). That is the pair the chat renders a
 *  hairline divider from — change the wording of a line here and change it there in the same edit. */
export function prWatchWakeMessage(input: {
  target: string
  checks?: {
    verdict: "passing" | "failing" | "gated"
    passed: number
    failed: number
    failing: string[]
    /** Terminal but asserted nothing — printed beside a green tally so a rollup of skips can never again
     *  read as a build. Optional: a report held across the 2026-09-04 upgrade carries neither this nor
     *  the two below, and folding one forward must not invent them. */
    skipped?: number
    /** `gated` only: how many workflows GitHub is holding for an approval, and which. */
    gated?: number
    gating?: string[]
  }
  /** What changed about the PR itself — a conflict appearing, a label moving, a reviewer being asked.
   *  ONE LINE for all of them, joined with semicolons, because each is a clause and not a headline: a
   *  separate line per fact would give a label edit the same weight as a red build. */
  changes?: string[]
  review?: string
  merged?: boolean
  closed?: boolean
}): string {
  const lines: string[] = []
  if (input.merged || input.closed) {
    lines.push(`\u23f0 ${input.target} was ${input.merged ? "MERGED" : "CLOSED"}.`, "")
    lines.push(PR_WATCH_SPENT_TRAILER)
    return lines.join("\n")
  }
  if (input.checks) {
    const c = input.checks
    if (c.verdict === "gated") {
      // THE ONE REPORT THAT NAMES ITS OWN DEAD END. Every other line here says what CI did; this says CI
      // has not been allowed to start, and no amount of waiting changes that — a human has to press the
      // button. A worker parked on the watcher alone would sit out its whole `for:` and learn nothing.
      const held = c.gated ?? c.gating?.length ?? 0
      lines.push(
        `⏸️ CI on ${input.target} is WAITING FOR APPROVAL — ${held} workflow${held === 1 ? "" : "s"} held${c.gating?.length ? `: ${c.gating.join(", ")}` : ""}.`,
        "",
        "Nothing has run on this commit. GitHub holds a fork or first-time contributor's workflows until a"
          + " maintainer approves them, so this does not clear on its own — ask for the approval rather than"
          + " waiting on it.",
      )
    } else if (c.verdict === "passing") {
      // The skip count rides beside the green tally because leaving it out is how "15 checks green" got
      // said about 3 label bots and 12 skips (nodejs/node#65795, 2026-09-04).
      const skipped = c.skipped ?? 0
      lines.push(`\u2705 CI PASSED on ${input.target} — ${c.passed} check${c.passed === 1 ? "" : "s"} green${skipped > 0 ? `, ${skipped} skipped` : ""}.`)
    } else {
      lines.push(`\u274c CI FAILED on ${input.target}${c.failing.length ? `: ${c.failing.join(", ")}` : ""}.`)
    }
  }
  if (input.changes?.length) {
    if (lines.length) lines.push("")
    lines.push(`🔔 ${input.target}: ${input.changes.join("; ")}.`)
  }
  if (input.review) {
    if (lines.length) lines.push("")
    lines.push(input.review)
  }
  lines.push("", PR_WATCH_ARMED_TRAILER)
  return lines.join("\n")
}

export function shellDoneMessage(shell: { taskId?: string; label: string; status: "completed" | "failed" | "killed" }): string {
  const what = shell.taskId ? `\`${shell.taskId}\` — ${shell.label}` : shell.label
  const verb = shell.status === "failed" ? "FAILED" : shell.status === "killed" ? "was STOPPED" : "finished"
  return (
    `\u23f0 Your background shell ${verb}: ${what}.\n\n${SHELL_DONE_TRAILER}`
  )
}

/** The delivered shell-done wake, read back — `null` for anything else.
 *
 *  Same producer/parser pair, and the same reason for it, as the PR-watch status line: the chat draws
 *  this event as a hairline and has nothing but the text to draw it from.
 *
 *  IT EXISTS TO MAKE ONE EVENT READ AS ONE EVENT. A background shell finishing while the worker is
 *  RUNNING is reported by the runtime, and the transcript has always drawn that as a wake divider
 *  (`backgroundWakeLabel` — "Background task «…» finished"). The very same shell finishing while the
 *  worker RESTS is reported by frizz instead, because the runtime's notification only ever reaches a
 *  running turn — and that one arrived as a full-width card. So whether a shell's completion was a
 *  hairline or a panel came down to whether anyone happened to be awake, which is not a distinction the
 *  transcript should be drawing at all (maintainer 2026-08-19, extending the pr-watch fix: "yes").
 *
 *  The trailer is not parsed and not rendered: "frizz sends this because your runtime's own completion
 *  notification does not reach you" explains frizz to the agent, and the human it is shown to never had
 *  that expectation to correct. */
export interface ShellDoneWake {
  taskId?: string
  label: string
  outcome: "finished" | "failed" | "stopped"
}

const SHELL_DONE = /^⏰ Your background shell (finished|FAILED|was STOPPED): (?:`([^`]+)` — )?(.+)\.$/

export function parseShellDoneWake(text: string): ShellDoneWake | null {
  // The FIRST line, unlike the PR-watch scan: this delivery is composed alone and never rides beside
  // another part, so a match anywhere else would mean the agent quoted the message back at itself.
  const m = SHELL_DONE.exec(text.trim().split("\n")[0]?.trim() ?? "")
  if (!m) return null
  const outcome = m[1] === "FAILED" ? "failed" : m[1] === "was STOPPED" ? "stopped" : "finished"
  return { ...(m[2] ? { taskId: m[2] } : {}), label: m[3], outcome }
}

// ---- THE BUILT-IN SIGN-OFF NUDGE (scheduler SOURCE 9) --------------------------------------------
// The rules arrive when they are ABOUT TO BE USED, rather than 200k tokens earlier in a system prompt
// the agent has long since stopped attending to. Maintainer 2026-08-11: "the agent seems to often
// forget about this stuff when it's added to the additional system prompt anyway."
//
// Delivered ONLY to a rest that carried NO fence at all — a thread that signed off correctly never sees
// it, so the whole cost of the mechanism is paid by exactly the rests that were about to produce an
// untriageable queue item. That is the invariant it exists to buy: every item in the queue is a
// question you can answer or a checkmark you can archive.
//
// IT REACHES EVERY THREAD, including one driving itself on an armed Goal. That case was carved out for a
// day (2026-08-13 → 2026-08-14, when the Goal still carried a question-hold switch) on the reading that
// the invariant is about a queue a HUMAN triages, so a thread nobody is waiting on does not need it. Two
// things sank that: this text now opens by sending a half-finished thread back to the WORK rather than
// offering a menu of ways to stop, so it no longer pulls against the Goal arriving beside it; and it is
// the only delivery that names the ```awaiting park at all (the Goal's own trailer deliberately does not
// — see restPromptMessage), so silencing it left the longest-running threads — the self-driving ones, the
// ones most likely to hold background work — with no way to learn how to park on it.
//
// SHORT, because it competes with the agent's own conclusion for attention, and because a long one
// invites the agent to treat "how do I sign off?" as the task. Three facts and a shape.
//
// IT LEADS WITH "GO BACK TO THE WORK", not with the fence menu (2026-08-14, the same change that made
// `DEFAULT_RECURRING_PROMPT` lopsided — see the comment there). The two deliveries land on the SAME rest
// and must not pull against each other: a nudge whose first instruction is "pick one of these three ways
// to stop" hands a half-finished thread a menu with no correct entry on it, and the agent picks the
// closest — usually `done`, which is a dismissal. So the fence menu is now the OTHERWISE branch, and the
// first branch says the fence is not what a thread with parts left owes. Nothing is lost from the
// invariant: a thread that goes back to work leaves the queue by SPINNING, which is the outcome the
// reminder wanted anyway.
/** The nudge's opening line, exported because it does DOUBLE DUTY: it tells the agent whose message
 *  this is, and it is what the transcript matches on to collapse the delivery to one hairline rather
 *  than rendering frizz's boilerplate as a card over the agent's own words. A text match is honest here
 *  — frizz writes this string and frizz reads it, both from this file. */
export const SIGNOFF_NUDGE_MARKER = "**This message is from frizz, not from the human.**"

/** The live things a thread could legitimately park on, appended to the reminder so the agent does not
 *  have to go looking for ids it cannot see. Maintainer 2026-08-14: "the handoff lists out all of the
 *  background shells and sub-agents with their identifiers so that it's really easy for the agent to
 *  produce an awaiting fence that lists out the IDs properly."
 *
 *  It goes at the END and stays short. A long preamble is what made an agent omit half its handoff once
 *  already, and this section is a lookup table, not an instruction. */
export interface SignoffLiveOps {
  /** Running background shells, named by the handle the RUNTIME gave the worker — the string it was
   *  actually shown ("Command running in background with ID: bzvtnt3ig"), not the launch tool_use id.
   *  These are what a `shell:` line names. */
  shells: { id?: string; label: string }[]
  /** Running sub-agents, named the same way. A fence may park on one, though it does not need to: a
   *  finished sub-agent re-invokes its parent by itself. */
  subAgents: { id?: string; label: string }[]
  /** Armed one-off timers, by row id (`tmr_…`) — what a `timer:` line names. */
  timers?: { id?: string; label: string }[]
  /** Registered pull requests, by ref (`owner/repo#N`) — what a `pr:` line names. */
  prs?: { id?: string; label: string }[]
}

// THE NUDGE PRINTS THE IDS, and that is not a convenience — it is what makes the fence writable at all.
// The awaiting grammar references live things BY ID, so a worker that has lost them (a compaction, a long
// turn) cannot write a correct fence and will be bumped for naming something wrong. Giving it the exact
// lines here closes that loop at the one moment it is provably needed: it just rested without a fence.
// `mcp__frizz__activity` returns the same list on demand, from the same source.
/** The four registries as `kind: id` lines a fence can copy verbatim, or `[]` when nothing is running.
 *
 *  Shared with SOURCE 12's corrections, and that sharing is the point rather than tidiness: a worker
 *  dispatched before `mcp__frizz__activity` existed CANNOT call it — its MCP server is frozen at dispatch
 *  — so a correction whose only remedy is that tool teaches the oldest threads nothing, which is exactly
 *  the population most likely to be writing a bad fence. Printing the ids needs no tool at all. */
export function liveOpsLines(ops?: SignoffLiveOps): string[] {
  const lines: string[] = []
  const section = (heading: string, kind: string, items: { id?: string; label: string }[]) => {
    if (!items.length) return
    lines.push("", heading)
    for (const i of items) lines.push(`- \`${kind}: ${i.id ?? "?"}\`  — ${i.label}`)
  }
  section("Background shells still running:", "shell", ops?.shells ?? [])
  section("Sub-agents still running (they re-invoke you on their own, so parking on one is optional):", "agent", ops?.subAgents ?? [])
  section("Timers you have armed:", "timer", ops?.timers ?? [])
  section("Pull requests you registered:", "pr", ops?.prs ?? [])
  return lines
}

export function signoffNudgeMessage(ops?: SignoffLiveOps): string {
  const lines = liveOpsLines(ops)
  if (lines.length) {
    lines.push("", "An ```awaiting fence takes one such line per thing you are ACTUALLY waiting on, plus a")
    lines.push("required `for:` duration (`30s`/`15m`/`2h`/`3d`), then a `---` line and whatever prose you want")
    lines.push("(optional). Frizz checks every id: name something that is not running and you are bumped")
    lines.push("rather than parked.")
  }
  return lines.length === 0 ? SIGNOFF_NUDGE_MESSAGE : `${SIGNOFF_NUDGE_MESSAGE}\n${lines.join("\n")}`
}

export const SIGNOFF_NUDGE_MESSAGE = [
  `${SIGNOFF_NUDGE_MARKER} Nothing about your task has changed, and no new work is being asked of you.`,
  "",
  "You rested without a fence, so this thread cannot be triaged.",
  "",
  "**IF THE TASK STILL HAS PARTS LEFT, THE FENCE IS NOT WHAT YOU OWE — THE WORK IS.** If ANY part of the",
  "original task is unfinished, unverified, or deferred, resume it NOW, in THIS turn, and sign off once it",
  "is genuinely finished. A milestone, a green test run and a long turn are none of them endings, and",
  "neither is naming the next step or writing it into a scratch file.",
  "",
  "**AND THAT TASK IS ALSO THE CEILING — finish it, and nothing else.** Work you notice on the way is a",
  "FINDING TO REPORT in your sign-off, never work to take on: the bug beside the one you were sent for,",
  "the refactor the code obviously wants, the second issue the first one touches. Widening the job is not",
  "thoroughness — it is a different job nobody asked for, and it buries the answer they did ask for under",
  "changes they now have to review. If it should be done, name it in one line and let the human dispatch",
  "it.",
  "",
  "**IF WHAT YOU WERE ASKED FOR IS A DOCUMENT, THE DOCUMENT IS THE ENDING.** A triage, a review, an",
  "investigation, a recommendation, a plan — when that is the deliverable, the finished write-up IS the",
  "work. Implementing what it proposes is the NEXT job, and not yours unless you were asked. Sign off with",
  "the write-up.",
  "",
  "**DECIDE RATHER THAN ASK.** Stop only for a decision that is genuinely the human's AND that blocks you",
  "right now: ask that one in a question fence. Every other open choice INSIDE the task — a name, a",
  "default, a reversible design call — is yours to make: decide it, say in one line which way you went and",
  "what would reverse it, and carry on. A choice that would ENLARGE the task is not one of those: an",
  "unanswered question is not permission to go build the answer.",
  "",
  "Otherwise, add a fence at the END of your next message:",
  "",
  "- `` ```question `` — you need the human. One question per fence, lettered options, one recommended.",
  "- `` ```done `` — genuinely FINISHED. A DISMISSAL: the card is filed away and nobody looks again, so",
  "  if anything is still owed, it is not done. Body: 1-3 sentences, then bullets, each opening with a",
  "  **bolded verb phrase**.",
  "- `` ```awaiting `` — you are WAITING on work that is actually running. FRONTMATTER, THEN MARKDOWN:",
  "  one structural line per thing you are waiting on, a REQUIRED `for:` duration, then a `---` line and",
  "  as much prose as you want. The prose is OPTIONAL; the lines above it are not.",
  "",
  "  ```awaiting",
  "  shell: <the id your runtime gave you>",
  "  pr: owner/repo#123",
  "  for: 2h",
  "  ---",
  "  What you are waiting for, in your own words — this is what the human reads on your card.",
  "  ```",
  "",
  "  Frizz CHECKS every line: name something that is not running and you are bumped rather than parked.",
  "  A fence that names NOTHING is not a park at all — if you are not waiting on anything, you are not",
  "  awaiting, you are done. Register a PR with `mcp__frizz__watch_pr` and a timer with",
  "  `mcp__frizz__timer`; `mcp__frizz__activity` reads back everything you have running, with its id.",
  "",
  "**STILL OWED counts things you are not going to do yourself.** A decision you are RECOMMENDING, a",
  "draft you wrote but did not send, follow-up work you discovered — all of it dies with the card, even",
  "the part that is someone else's to do. Each ends on a question with your recommendation as option A,",
  "or you DO it first — a sub-agent's result comes BACK to you, so it lands on your card; a new card via",
  "`mcp__frizz__spawn_thread` is the LAST resort, since nothing it learns returns to you or its siblings.",
  "None of them is a `done`. And what is not",
  "worth a card is not worth a SENTENCE: delete the dangling \"one thing to carry forward\", never park it",
  "in the handoff.",
  "",
  "**DO NOT REPEAT YOURSELF.** If the message you just wrote already stands on its own, reply with the",
  "fence ALONE — the human reads both together, so restating it costs them the second read for nothing.",
  "The same holds inside one message: the card is the ledger of what shipped, the prose is only what a",
  "ledger cannot hold, and a sentence that reads the same in either belongs in exactly one of them.",
  "",
  "Only if it does NOT stand alone, fix that first, briefly. It has to be readable cold: the human has",
  "seen nothing since their own last message — the Goal, this reminder, a watcher wake all came from",
  "frizz — so anything you assumed they had followed, they have not.",
].join("\n")

// ---- THE FENCE CORRECTIONS (scheduler SOURCE 12) -------------------------------------------------
// Frizz refusing a park and telling the worker why: a fence naming something that is not running, a
// fence naming nothing at all, a fence written in a line kind that no longer exists.
//
// THEY ARE INVISIBLE IN THE CHAT, and that is the whole reason these two strings live here. A
// correction is frizz talking to the AGENT about its own grammar — there is no news in it and nothing
// for the human to do — and left as a first-party card it dominated the very handoff it was complaining
// about, then sat above the worker's re-fence as a second, louder copy of a conversation the human was
// never part of (maintainer 2026-08-19, with a screenshot of exactly that). It is the same verdict the
// sign-off nudge got on 2026-08-12, one step further: that one collapses to a hairline, this one is
// dropped from the transcript entirely.
//
// The LEADS are matched rather than a marker being minted, so the corrections already sitting in every
// open thread on disk disappear too — a marker would only ever reach the ones written after it shipped.
// A text match is honest for the same reason it is honest for `SIGNOFF_NUDGE_MARKER`: frizz writes these
// strings and frizz reads them, and the formatter in scheduler.ts builds its heads FROM them, so the two
// cannot drift.
//
// `⏰ Your wait expired` is deliberately NOT one of them. That is not a correction — the fence was right
// and the clock ran out — it is the wake that ENDED the park, and the reason the thread is moving again.
// The scheduler draws the same line for its bump cap (`cause !== "expired"`).
export const PARK_CORRECTION_NAMES_LEAD = "⚠️ Your ```awaiting fence names "
export const PARK_CORRECTION_RETIRED_LEAD = "⛔ Your ```awaiting fence uses "
/** The third refusal (2026-08-28): the fence was well-formed and everything it named was live, but a
 *  REGISTERED QUESTION stood open on the thread. A question outranks a park everywhere else — the queue
 *  rule, the resting card — so the fence is refused rather than drawn beside the ask (maintainer: "it
 *  should not be allowed, basically"). */
export const PARK_CORRECTION_QUESTION_LEAD = "⚠️ Your ```awaiting fence landed while "
/** Is this delivered wake one of frizz's fence corrections? */
export function isParkCorrection(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith(PARK_CORRECTION_NAMES_LEAD) || t.startsWith(PARK_CORRECTION_RETIRED_LEAD) || t.startsWith(PARK_CORRECTION_QUESTION_LEAD)
}

export function timerPromptMessage(prompt: string, fireAt: string): string {
  return `${prompt.trim()}\n\n(One-off timer, set for ${fireAt}. It has fired and will not repeat.)`
}

/** A fired one-off timer, read back out of its delivery.
 *
 *  THIS ONE KEEPS ITS BODY, and it is the only wake in the family that does. Everything else frizz
 *  composes is frizz's own sentence about something outside the turn, so a hairline says all of it; this
 *  is the WORKER'S OWN prose, arbitrary and up to TIMER_PROMPT_MAX long. The recurring prompt collapses
 *  to a bare label for a reason that does NOT hold here — its text is the ARMED text, still legible and
 *  editable in the footer panel, so repeating it inline adds nothing (see RecurringPromptLine). A fired
 *  one-off has no such second home: the registration is gone the instant it delivers, so a bare hairline
 *  would destroy the only rendering of that text anywhere in the app.
 *
 *  Hence a hairline WITH a disclosure — the family's shape, the body one click away (maintainer
 *  2026-08-19, choosing that over both a card and a bare line).
 *
 *  Matched on the TRAILER, exactly like `parseRecurringPrompt`: frizz writes it and frizz reads it, both
 *  from this file, and the prompt above it is arbitrary text no pattern could anchor on. */
export interface TimerWake {
  prompt: string
  /** The instant it was set for. With several timers armed at once this is the only thing that says
   *  WHICH one fired — the same reason the producer puts it in the trailer. */
  at: string
}

const TIMER_TRAILER = /\n\n\(One-off timer, set for (\S+?)\. It has fired and will not repeat\.\)$/

export function parseTimerWake(text: string): TimerWake | null {
  const trimmed = text.trimEnd()
  const m = TIMER_TRAILER.exec(trimmed)
  if (!m) return null
  const prompt = trimmed.slice(0, m.index).trim()
  // A trailer with nothing above it is not a timer delivery — the worker's text IS the message here.
  return prompt ? { prompt, at: m[1] } : null
}

/** The message a worker receives when the usage window that cut it off has rolled over.
 *
 *  MOVED HERE FROM THE SCHEDULER on 2026-08-19, when this became the last frizz-composed wake still
 *  arriving as a card. It could not be a hairline while it lived in the server package: the chat has
 *  nothing but the delivered text to draw from, so the parser has to sit beside the formatter, and only
 *  this package is reachable from both sides. Every other wake formatter is here for that same reason.
 *
 *  Deliberately a plain continue — the agent's own transcript already holds everything it was doing, so
 *  the useful thing to add is only WHY it stopped and that it should pick the work back up rather than
 *  re-plan or re-report. */
export function limitResumeSteer(window: LimitWindow): string {
  const which = window === "weekly" ? "weekly usage limit" : window === "session" ? "session usage limit" : window === "model" ? "model usage limit" : "usage limit"
  return `⏳ The ${which} that interrupted you has reset. Continue exactly where you left off.`
}

/** The message a worker receives when frizz answered a MODEL-SCOPED cap by moving the thread down a rung.
 *
 *  The provider's own line says it outright — "Switch to another model … to continue" — so the account
 *  is not out of capacity, this MODEL is, and waiting out a weekly window is the wrong answer. Frizz
 *  takes the provider's advice on the thread's behalf and restarts it on the next model down (see
 *  claudeFallbackModel), which is why this wake says nothing has reset: the cap is still standing.
 *
 *  Named at the same altitude as the human's own vocabulary — the models by their catalogue LABELS
 *  ("Fable", "Opus"), never their argv slugs — because the operator reads this line in the transcript
 *  and the composer's selector beside it says exactly the same word. */
export function limitModelSwitchSteer(capped: string, to: string): string {
  return `⏳ The ${capped} limit that interrupted you is still closed — frizz restarted this thread on ${to}. Continue exactly where you left off.`
}

const LIMIT_MODEL_SWITCH = /^⏳ The (.+?) limit that interrupted you is still closed — frizz restarted this thread on (.+?)\. Continue exactly where you left off\.$/

/** Which model was capped and which one the thread now runs, or `null` when this is not a switch wake. */
export function parseLimitModelSwitchWake(text: string): { capped: string; to: string } | null {
  const m = LIMIT_MODEL_SWITCH.exec(text.trim())
  return m ? { capped: m[1], to: m[2] } : null
}

const LIMIT_RESUME = /^⏳ The (weekly usage limit|session usage limit|model usage limit|usage limit) that interrupted you has reset\. Continue exactly where you left off\.$/

/** Which window reset, or `null` when this is not a limit-resume wake. The chat draws one hairline from
 *  it; the amber pause card already standing above it carries the weight of the interruption itself. */
export function parseLimitResumeWake(text: string): { window: LimitWindow } | null {
  const m = LIMIT_RESUME.exec(text.trim())
  if (!m) return null
  return { window: m[1] === "weekly usage limit" ? "weekly" : m[1] === "session usage limit" ? "session" : m[1] === "model usage limit" ? "model" : "unknown" }
}

// ---- THE PARK-INTEGRITY WAKES (scheduler SOURCE 12) ------------------------------------------------
// THE RULE THIS FILE ALREADY STATES, applied to the three formatters that never made it here: a wake
// frizz composes ITSELF is a hairline, because it is one line of news about something outside the turn,
// and the instructions under that line are addressed to the WORKER — its own registrations, its own
// fence grammar, the tools it should call. Left in the server package a formatter has no parser the chat
// can reach, so it fell through `FrizzWake`'s legacy fallback and printed VERBATIM: a bordered "Frizz"
// card of agent-contract prose, in the human's transcript (maintainer 2026-08-24, on a card reading
// "THE ONLY LINE KINDS NOW SUPPORTED": "frizz cards that seem to be exposing internals").
//
// Measured before the move: 73 of 12 891 delivered wakes on this machine drew that raw card, and every
// live one was one of the three below. So they move here for the same reason `limitResumeSteer` did on
// 2026-08-19 — "the parser has to sit beside the formatter, and only this package is reachable from both
// sides". The agent-facing wording is UNCHANGED, byte for byte: workers read it and it is carefully
// written; what changes is that the human now gets the one line it is news about.

/** Scheduler SOURCE 12, cause `expired`: the `for:` ran out and nothing resolved. `status` is the live
 *  readout of what the fence named, already formatted by the caller. */
export function parkExpiredWakeMessage(status: readonly string[]): string {
  return [
    "⏰ Your wait expired, nothing resolved. Check back in on everything.",
    "",
    ...status,
    "",
    "Re-park if they are genuinely still going — there is no limit on that, and a long job is not a",
    "failure. If something is finished, read its result. If nothing is left, end in ```done or ask a",
    "```question.",
  ].join("\n")
}

/** Scheduler SOURCE 12, cause `dead` where every named item FINISHED: the park is simply over. */
export function parkFinishedWakeMessage(status: readonly string[], several: boolean): string {
  return [
    `✅ ${several ? "Everything you parked on has FINISHED" : "The work you parked on has FINISHED"}, so the park is over and your thread is back in the queue.`,
    "",
    ...status,
    "",
    "READ ITS OUTPUT AND CARRY ON. This is not a broken fence and there is nothing to fix: the wait",
    "you declared simply ended. Do NOT relaunch the same work — its result is already on disk.",
    "",
    "Then park on whatever comes next, or end in ```done or a ```question if nothing is left.",
  ].join("\n")
}

/** Scheduler SOURCE 11: a registered PR watcher whose own `for:` ran out. */
export function prWatchExpiredWakeMessage(ref: string): string {
  return (
    `⏰ Your watcher on ${ref} has expired and is no longer armed — nothing on that PR will wake ` +
    `you now.\n\nIf you still care about it, register it again with \`mcp__frizz__watch_pr\` and a ` +
    `fresh \`for:\`. If you do not, and it was the only thing you were waiting on, end in a proper ` +
    `terminal state instead of parking on it again.`
  )
}

/** The wake a REGISTERED WATCH sends when its `for:` runs out — the twin of prWatchExpiredWakeMessage
 *  above, and here for the same reason: the scheduler mints it and nothing else may re-word it.
 *
 *  Expiry CANCELS the row rather than extending it, which is the whole mechanism that stops a
 *  registration outliving its own relevance: the worker is put back in front of the decision it made
 *  once, with the wait no longer standing, and re-registers only if it still means it. */
export function ownWatchExpiredWakeMessage(kind: "shell" | "agent", target: string): string {
  const what = kind === "agent" ? "sub-agent" : "background shell"
  return (
    `⏰ Your watch on the ${what} \`${target}\` has expired and is no longer armed — nothing about it ` +
    `will wake you now, and it is no longer holding your thread out of the queue.\n\nIf you are still ` +
    `waiting on it, register it again with \`mcp__frizz__watch\` and a fresh \`for:\`. If you are not, ` +
    `and it was the only thing you were waiting on, end in a proper terminal state instead of parking ` +
    `on it again.`
  )
}

/** One park-integrity wake, read back out of its delivery. `items` is the status readout the message
 *  carried — the only part of the body a human has any use for, and the reason the divider can open. */
export interface ParkWake {
  kind: "expired" | "finished"
  items: string[]
}

const PARK_EXPIRED_HEAD = /^⏰ Your wait expired, nothing resolved\./
const PARK_FINISHED_HEAD = /^✅ (?:The work you parked on has|Everything you parked on has) FINISHED, so the park is over/

/** The status lines between the head and the instruction paragraph. They are the worker's own item
 *  labels (`- \`shell: bkjf8exat\` — still running`), which is the one thing here a human reads. */
function parkWakeItems(body: string): string[] {
  return body.split("\n").filter((line) => line.trimStart().startsWith("- "))
}

export function parseParkWake(text: string): ParkWake | null {
  const trimmed = text.trim()
  if (PARK_EXPIRED_HEAD.test(trimmed)) return { kind: "expired", items: parkWakeItems(trimmed) }
  if (PARK_FINISHED_HEAD.test(trimmed)) return { kind: "finished", items: parkWakeItems(trimmed) }
  return null
}

const PR_WATCH_EXPIRED_HEAD = /^⏰ Your watcher on (\S+) has expired and is no longer armed\b/

/** The PR whose watcher lapsed, or null. One hairline: the registration is gone, and the ref is the
 *  only thing on it a reader can act on. */
export function parsePrWatchExpiredWake(text: string): { ref: string } | null {
  const m = PR_WATCH_EXPIRED_HEAD.exec(text.trim())
  return m ? { ref: m[1] } : null
}

/** What is being waited ON: one of the worker's own background shells, or a pull request. */
// NEITHER KIND HAS A REGISTRY ROW BEHIND IT any more (2026-08-14). Both are derived from the worker's
// own ```awaiting fence — `shell` from its `shells:` list, `github` from its `prs:` list — so this strip
// lists exactly what will wake the thread and cannot drift from it.
//
// `github` became a view kind first (2026-08-13). A PR wait lives in the worker's
// ```awaiting fence — that is deliberate and settled (`f366e2d`, "the fence owns PR watching") — but the
// operator still wants to SEE it standing, in the same strip under the prompt box that lists sub-agents
// and background shells: "showing the active watchers underneath the prompt box, similar to how
// subagents work… now GitHub watchers can be included in the ranks of those" (maintainer 2026-08-13).
// So the board SYNTHESIZES one row per parseable `prs:` entry on the thread's standing fence. It is
// derived state, not a registration: it appears when the worker parks, vanishes when it says anything
// else, and carries no drop affordance, because there is no row to drop.
export const ThreadWatchKind = z.enum(["shell", "github", "timer"])
export type ThreadWatchKind = z.infer<typeof ThreadWatchKind>

/** How a watched PR's checks stand right now, in the shape GitHub's own merge box states it: a rollup
 *  verdict plus the counts behind it, and whether the PR can actually be merged.
 *
 *  IT DECIDES A QUEUE RULE, not just a readout (maintainer 2026-08-14: "if there is a GitHub watcher
 *  registered and the GitHub actions are still running, then that should remain in the running active
 *  rail. Only if CI has failed or completed successfully should it show up back in the queue"). So it
 *  has to travel — a card that renders check state the board cannot also read would put the two out of
 *  step, which is the drift that produced two cards saying different things about the same wait. */
export const GithubChecksState = z.enum(["none", "running", "passing", "failing"])
export type GithubChecksState = z.infer<typeof GithubChecksState>

/** Can GitHub merge it? `blocked` covers a required review or a failing required check — GitHub reports
 *  the two the same way, and neither is something frizz should claim to distinguish. */
export const GithubMergeState = z.enum(["mergeable", "blocked", "conflicting", "unknown"])
export type GithubMergeState = z.infer<typeof GithubMergeState>

export const GithubWatchStatus = z.object({
  checks: GithubChecksState,
  /** The counts behind the verdict, so the card can say "3 running, 12 passed" the way GitHub does
   *  rather than only "checks are running". */
  running: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Checks that reached a terminal state without asserting anything — GitHub's `SKIPPED` and `STALE`.
   *  Counted apart from `passed` since 2026-09-04: they were folded into it, so a rollup of 12 skipped
   *  no-ops and 3 label bots rendered and reported as "15 checks green". Defaulted, because a reading
   *  written before that date carries neither this nor `gated`. */
  skipped: z.number().int().nonnegative().default(0),
  /** Workflows held at `action_required` — GitHub's "Approve and run" gate on a fork or first-time
   *  contributor's PR. They produce NO check run, so they are absent from the rollup entirely and the
   *  poll cannot see them there; the head's workflow runs are where they show up. Non-zero means CI has
   *  not started and will not until a maintainer presses the button. */
  gated: z.number().int().nonnegative().default(0),
  /** The gated workflow NAMES, capped — "Test Linux, Test macOS, Linters" says what is being withheld,
   *  where a bare count does not. */
  gating: z.array(z.string()).max(8).default([]),
  /** The failing job NAMES, capped — what a human actually needs to decide whether to look. */
  failing: z.array(z.string()).max(8).default([]),
  merge: GithubMergeState,
  /** OPEN | CLOSED | MERGED, lowercased. A merged or closed PR ends the wait outright. */
  state: z.enum(["open", "closed", "merged"]),
  /** When frizz last heard from GitHub. A poll can fail or be rate-limited, and a stale reading stated
   *  as current is worse than no reading. */
  polledAt: z.string(),
  /** The head commit this verdict was reached on. A PR watcher reports a CI verdict when it is NEWS, and
   *  "red again on a new commit" is news that the bare word `failing` cannot express. Optional because a
   *  reading taken before 2026-08-17 carries none. */
  head: z.string().optional(),
  /** A digest of WHICH jobs are failing right now. The head commit alone cannot express a re-run of the
   *  same job, or a slower job going red after the first — both of which are a second failure the worker
   *  must hear about. Empty when nothing is failing. */
  failureSig: z.string().optional(),
}).strict()
export type GithubWatchStatus = z.infer<typeof GithubWatchStatus>

/** One wait the thread has out, as the board states it.
 *
 *  A `shell` row is DERIVED FROM THE FENCE — a `shells:` entry checked against live telemetry — and has
 *  no registration behind it: it lives exactly as long as the fence that declares it, which is also
 *  exactly as long as the scheduler watches it. A `github` row mirrors a REGISTERED PR watcher and a
 *  `timer` row an ARMED timer (`thread_timer`), fence or no fence — a registration is live work that
 *  WILL wake the thread. Either way the coupling is the point: the strip lists precisely what will
 *  actually wake the thread, and the two cannot drift into claiming different things. */
export const ThreadWatchView = z.object({
  id: z.string(),
  kind: ThreadWatchKind,
  target: z.string(),
  state: z.enum(["armed", "fired", "dropped"]),
  createdAt: z.string(),
  /** `github` rows only, and absent until the first successful poll. */
  github: GithubWatchStatus.optional(),
  /** `timer` rows only: the armed timer's own registration, which is everything the row renders — the
   *  worker's prompt is the row's NAME (a `tmr_…` id names nothing to a human) and the fire instant is
   *  its status. Unlike `github` there is no polled half to be absent: a timer that exists is fully
   *  known, so a timer row always carries this. */
  timer: z.object({ fireAt: z.string(), prompt: z.string() }).strict().optional(),
}).strict()
export type ThreadWatchView = z.infer<typeof ThreadWatchView>

/** A PR watcher's own ceiling, and it is a YEAR — deliberately nothing like AWAITING_FOR_MAX_MS.
 *
 *  A shell dies with its session; a pull request in a repo nobody here controls does not. It sits
 *  unreviewed for as long as its maintainers take, and a watcher shorter than that expires against a PR
 *  that has not changed — which wakes the thread, produces nothing, and costs a re-arm. Measured on the
 *  live board: a worker's PR into `vercel/ai` re-armed at the 24h ceiling four days running, four wakes,
 *  zero maintainer activity (maintainer 2026-09-02: "for an external PR that we have no control over,
 *  you could snooze basically for like a year … much easier just to let the user hit the snooze button").
 *
 *  It is a CEILING, not a recommendation for every PR — a worker watching CI on its own PR still wants
 *  hours. What the ceiling buys is that the long wait is now REPRESENTABLE, so the guidance can ask for
 *  it and the answer is no longer capped back to a day behind the worker's back. */
export const PR_WATCH_FOR_MAX_MS = 365 * 24 * 60 * 60 * 1000

/** What an old worker's `watch_pr` gets when its MCP binary predates `for` and cannot send one. Still
 *  BOUNDED — the point of the field is that an unrenewed watcher eventually stops polling — but no
 *  longer short enough to be its own source of wakes: a worker that cannot choose was re-arming every
 *  6h forever, which is the exact noise the ceiling above exists to end. */
export const PR_WATCH_DEFAULT_FOR_MS = 30 * 24 * 60 * 60 * 1000

/** The ceiling on registered PR watchers per thread. A tool call in a loop cannot fill the table, and
 *  the refusal names the number so a worker drops one rather than retrying. */
export const PR_WATCH_MAX_ARMED = 32

/** One registered PR watcher, as the worker's own tool reads it back. */
export const PrWatchView = z.object({
  id: z.string(),
  /** `owner/repo#N`, normalized — the same string the board's row and the status book are keyed by. */
  target: z.string(),
  state: z.enum(["armed", "dropped", "settled"]),
  createdAt: z.string(),
  /** The PR's checks/mergeability as the poller last saw it. Absent until the first successful poll. */
  github: GithubWatchStatus.optional(),
}).strict()
export type PrWatchView = z.infer<typeof PrWatchView>

export const AddOwnPrWatchInput = z.object({
  slug: ThreadSlug,
  /** `owner/repo#123` or a PR URL. Parsed server-side; an unparseable ref is refused rather than stored,
   *  because a watcher that can never fire is worse than none — the worker rests believing it is covered. */
  target: z.string().trim().min(1).max(200),
  /** How long to watch, as a DURATION (`2h`, `3d`, `180d` — parseAwaitingDurationRaw, capped at
   *  PR_WATCH_FOR_MAX_MS).
   *
   *  A PR nobody ever reviews would otherwise be polled forever, and a thread parked on it would wait
   *  forever with it — the same unbounded wait the awaiting fence's `for:` closes, one level down. A
   *  duration rather than an instant for the same reason it is one there: it cannot be written in the
   *  past (maintainer 2026-08-15, asking for it explicitly).
   *
   *  BOUNDED IS NOT THE SAME AS SHORT, and conflating them is what made this field a noise source. The
   *  bound exists so a forgotten watcher stops polling eventually, which a year satisfies exactly as
   *  well as a day — and a day spent it against every external PR, which does not move on that clock.
   *
   *  REQUIRED BY THE TOOL, OPTIONAL ON THE WIRE, and the asymmetry is deliberate. A worker's MCP server
   *  outlives every frizz restart, so a session dispatched before this existed still holds a binary that
   *  cannot send it — and making the RPC reject that would break `watch_pr` outright for every thread
   *  already running, with no recourse from inside those threads. Absent ⇒ PR_WATCH_DEFAULT_FOR, which
   *  still BOUNDS the poll; the point of the field is that a worker chooses, and one that cannot choose
   *  is better bounded than broken. */
  for: z.string().trim().min(1).max(16).optional(),
}).strict()
export type AddOwnPrWatchInput = z.infer<typeof AddOwnPrWatchInput>

export const AddOwnPrWatchResult = z.object({
  id: z.string(),
  target: z.string(),
  /** True when this exact PR was ALREADY watched by this thread, so the call registered nothing new.
   *  Re-registering after a compaction is the common case, and a duplicate would double every wake. */
  alreadyArmed: z.boolean(),
  /** When this watcher runs out. Read back so the worker sees the duration it ACTUALLY got rather than
   *  the one it asked for — on a re-registration that is the original expiry, which the call left alone. */
  expiresAt: z.string(),
  /** The `for:` the worker wrote, present ONLY when it exceeded the ceiling and was capped. A clamp
   *  nobody is told about is a worker resting on a year of coverage it does not have. */
  clampedFrom: z.string().optional(),
  watches: z.array(PrWatchView),
}).strict()
export type AddOwnPrWatchResult = z.infer<typeof AddOwnPrWatchResult>

export const DropOwnPrWatchInput = z.object({
  slug: ThreadSlug,
  id: z.string().min(1).max(64),
}).strict()
export type DropOwnPrWatchInput = z.infer<typeof DropOwnPrWatchInput>

export const DropOwnPrWatchResult = z.object({
  dropped: z.boolean(),
  watches: z.array(PrWatchView),
}).strict()
export type DropOwnPrWatchResult = z.infer<typeof DropOwnPrWatchResult>

// ---- THE WORKER'S OWN WATCHES on its own running work (2026-08-26) -----------------------------------
// `mcp__frizz__watch` / `mcp__frizz__unwatch`. See plans/rest-by-registration.md: a wait stops being a
// line the worker restates at every rest and becomes a row it creates once.
//
// ONE VERB ACROSS KINDS, unlike the four narrow item kinds the fence grammar has. A shell and a sub-agent
// are the same act — "bring me back when this finishes" — and splitting them into two tools would teach
// two things where there is one. A PR keeps its own verb because it is not the same act: `watch_pr`
// creates a REPEATING poll against a service frizz has to reach, and it can fail for reasons a runtime
// handle never can (signed out, an SSO-gated org, no `gh`).
export const OwnWatchKind = z.enum(["shell", "agent"])
export type OwnWatchKind = z.infer<typeof OwnWatchKind>

export const AddOwnWatchInput = z.object({
  slug: ThreadSlug,
  /** What KIND of thing the target is. Stored, and checked against the thread's live telemetry before the
   *  row is written — see the note on `target`. */
  kind: OwnWatchKind,
  /** The handle the worker was shown: a runtime task id ("Command running in background with ID: …"), a
   *  launch tool_use id, or the op's own label.
   *
   *  VALIDATED AGAINST LIVE TELEMETRY, NOT AGAINST ITS SHAPE. A PR ref is checkable by shape because
   *  `owner/repo#123` looks like nothing else; a shell handle and a sub-agent handle are both opaque
   *  runtime strings and overlap completely, so shape can only ever be a guess. What frizz CAN answer
   *  exactly is whether this thread has a live shell — or a live sub-agent — answering to this handle, and
   *  that is both the stronger check and the one that catches the real mistake: naming a sub-agent under
   *  `kind: "shell"`, which is what put two sub-agents under a "Background shells" heading on 2026-08-26. */
  target: z.string().trim().min(1).max(200),
  /** REQUIRED, and a DURATION (`30m`, `2h`, `3d` — parseAwaitingDurationRaw, capped at 24h).
   *
   *  STILL A DAY, where a PR watcher now gets a year: this names a shell or a sub-agent, which lives
   *  inside the session that launched it, so a wait standing longer than a day is one whose target is
   *  almost certainly already gone.
   *
   *  No default and no wire-level optionality, unlike `AddOwnPrWatchInput.for`: that field is optional
   *  only to keep working for sessions dispatched before it existed, and this RPC has no such sessions.
   *  On elapse the row is CANCELLED and the thread woken to re-decide, which is what stops a registration
   *  outliving its own relevance — the one thing an un-restated fence could never do wrong. */
  for: z.string().trim().min(1).max(16),
}).strict()
export type AddOwnWatchInput = z.infer<typeof AddOwnWatchInput>

export const OwnWatchView = z.object({
  id: z.string(),
  kind: OwnWatchKind,
  target: z.string(),
  /** The op's own label where the target resolved to one, so a read-back names the work rather than an
   *  opaque handle. Absent when the target no longer resolves — the row still stands and names itself. */
  label: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
}).strict()
export type OwnWatchView = z.infer<typeof OwnWatchView>

export const AddOwnWatchResult = z.object({
  id: z.string(),
  kind: OwnWatchKind,
  target: z.string(),
  /** True when this exact (kind, target) was already watched, so the call registered nothing new and the
   *  existing expiry stands. Re-registering after a wake or a compaction is the common, correct case. */
  alreadyArmed: z.boolean(),
  /** The `for:` the worker wrote, present ONLY when it exceeded the ceiling and was capped — the twin of
   *  `AddOwnPrWatchResult.clampedFrom`, for the same reason: a silent clamp is a worker resting on
   *  coverage it does not have. */
  clampedFrom: z.string().optional(),
  watches: z.array(OwnWatchView),
}).strict()
export type AddOwnWatchResult = z.infer<typeof AddOwnWatchResult>

export const DropOwnWatchInput = z.object({
  slug: ThreadSlug,
  id: z.string().min(1).max(64),
}).strict()
export type DropOwnWatchInput = z.infer<typeof DropOwnWatchInput>

export const DropOwnWatchResult = z.object({
  dropped: z.boolean(),
  watches: z.array(OwnWatchView),
}).strict()
export type DropOwnWatchResult = z.infer<typeof DropOwnWatchResult>

/** How many watches one thread may hold at once. A bound, not an opinion — the same shape as
 *  PR_WATCH_MAX_ARMED, and generous enough that no honest fan-out meets it. */
export const OWN_WATCH_MAX_ARMED = 24

// ---- THE WORKER'S REGISTERED QUESTIONS (2026-08-26) ------------------------------------------------
// `mcp__frizz__ask` / `mcp__frizz__unask`. See plans/rest-by-registration.md.
//
// WHY A ROW AND NOT A FENCE. A ```question block has the lifetime of the MESSAGE carrying it: the
// tailer recomputes `pendingQuestion` from the latest assistant text on every assistant record
// (`lastAssistantHasQuestion = hasQuestionBlock(raw)`, an assignment and not an OR), and clears it on
// any human turn. So a worker that asks and then says one more sentence has silently un-asked, and a
// steer that was not an answer discharges a question the human still owed. A row survives both.
//
// THE AUTHORING SHAPE, not the render shape. `ParsedQuestion` (web/lib/questionBlocks.ts) is what the
// CARD consumes — flat, markdown-oriented, options as bare strings, because it is recovered by parsing
// prose. This is what a worker WRITES, and an adapter maps it onto that same card, exactly as
// lib/interactionQuestion.ts already does for a typed interaction. One card, three producers.
//
// THE VOCABULARY IS THE FENCE'S, deliberately: `kind` is QuestionKind (`question` | `multi`) and
// `danger` is orthogonal to it, so nothing here invents a second name for a thing the renderer already
// has a name for. A FREE-TEXT question is one with no options — which the card already renders, since
// its "something else…" row is unconditional — rather than a third kind.
export const AskQuestionKind = z.enum(["question", "multi"])
export type AskQuestionKind = z.infer<typeof AskQuestionKind>

export interface AskedOption {
  label: string
  /** The trade-off, or the evidence. ONE LINE renders inline after the label (the fence's em-dash
   *  join); MORE THAN ONE LINE renders as a full-markdown body INSIDE the option — a list, a code
   *  block, the diff the option would produce — visible before the human picks anything, because a
   *  detail that decides a choice is useless once the choice is already made. */
  description?: string
  /** Marks the one option the worker recommends. At most one per question — a second is refused, since
   *  "recommended" means nothing if it is on two of three choices. */
  recommended?: boolean
  /** RETIRED 2026-09-01 (it revealed markdown under the option only once picked — detail that should
   *  inform a choice arrived after the choice; maintainer: "you should just be rendering it as part of
   *  the answer before I click on it"). Still ACCEPTED, never refused: stored rows and in-flight
   *  workers carry it, and the card now folds it into the option's always-visible body. New workers
   *  never see it — the `ask` tool schema no longer offers it; a rich `description` is the shape. */
  preview?: string
  /** Questions that become live only if the human picks THIS option — the static tree. A branch nobody
   *  took returns nothing, so an unpicked follow-up is not a question anyone owes an answer to. */
  followUps?: AskedQuestion[]
}

export interface AskedQuestion {
  question: string
  /** A very short chip label for the card's heading (<= 12 chars), as the fence's own convention. */
  header?: string
  kind: AskQuestionKind
  /** The destructive gate — force-merge, deletion, history rewrite, prod rollback. It changes TWO
   *  things: the card wears the `risk` tone, and the human's × cannot reach it. A generic close icon is
   *  not consent for something irreversible; declining is an OPTION inside the question. */
  danger?: boolean
  /** Absent or empty ⇒ a free-text question. */
  options?: AskedOption[]
}

/** How deep a follow-up tree may go. Three: a question, a follow-up on the option taken, and one more.
 *  Past that the human is filling in a form rather than answering a question, and the worker should be
 *  deciding the rest itself.
 *
 *  THE ONE COUNT THE TOOL STILL BOUNDS. The options per question, the questions per call, the
 *  follow-ups per option and the open set per thread all carried caps (8 / 4 / 4 / 12) until
 *  2026-09-03, when the maintainer had them removed as arbitrary ("what other stupid limits are
 *  there?"). The depth stays only because the MCP schema INLINES the tree to exactly this depth — no
 *  `$ref`, since some clients drop one (cc-worker/bin/frizz-mcp.mjs) — so it can be raised, never
 *  unbounded. */
export const ASK_MAX_DEPTH = 3

const AskedOptionSchema: z.ZodType<AskedOption> = z.lazy(() => z.object({
  // 400, not the 120 it launched with (2026-09-03): a label is a chip line, but "Post the drafted
  // comment as written" plus its qualifier runs long, and the fence has no cap at all. The answer's
  // `chosen` carries labels, so its per-item cap matches this one.
  label: z.string().trim().min(1).max(400),
  // 20000, not the 4000 the retired `preview` had (2026-09-03): a description is allowed to BE the rich
  // body — a diff, a drafted comment, a table — and a real diff exceeds 4000.
  description: z.string().trim().max(20000).optional(),
  recommended: z.boolean().optional(),
  preview: z.string().max(4000).optional(),
  // No count cap, like `options` (2026-09-03); the tree is bounded by ASK_MAX_DEPTH instead.
  followUps: z.array(AskedQuestionSchema).optional(),
}).strict())

export const AskedQuestionSchema: z.ZodType<AskedQuestion> = z.lazy(() => z.object({
  // 4000, not the 600 it launched with (2026-09-03): this field is the whole card context — everything
  // the human needs to answer cold — and a question that carries its own evidence needs the room. The
  // answer restates it, so QuestionAnswerSchema's cap matches.
  question: z.string().trim().min(1).max(4000),
  header: z.string().trim().max(24).optional(),
  kind: AskQuestionKind,
  danger: z.boolean().optional(),
  // UNBOUNDED, deliberately. This carried `.max(8)` from launch until 2026-09-03, when the maintainer
  // asked for the cap to go ("allow arbitrary numbers of options"): a `multi` over a long list — which
  // gates to run, which of twenty findings to act on — is a real shape, and the card letters past 26
  // (`AA.`) already. The count is the worker's to choose; the answer's `chosen` is unbounded to match.
  options: z.array(AskedOptionSchema).optional(),
}).strict())

/** The depth of a question tree, counting the root as 1. Separate from the schema because zod's `lazy`
 *  cannot bound its own recursion — the RPC refuses on this, with a message naming the limit. */
export function askedQuestionDepth(q: AskedQuestion): number {
  let deepest = 1
  for (const option of q.options ?? []) {
    for (const child of option.followUps ?? []) deepest = Math.max(deepest, 1 + askedQuestionDepth(child))
  }
  return deepest
}

/** Every way a tree can be malformed beyond its shape, as prose the worker can act on. Empty ⇒ fine. */
export function askedQuestionFaults(q: AskedQuestion): string[] {
  const faults: string[] = []
  const walk = (node: AskedQuestion, path: string) => {
    const options = node.options ?? []
    // A MULTI-SELECT WITH NO OPTIONS IS A FREE-TEXT BOX WEARING THE WRONG LABEL, and it renders as one —
    // silently, so the worker never learns its `multi` did nothing.
    if (node.kind === "multi" && options.length === 0) faults.push(`${path}: \`kind: "multi"\` needs options — a question with none is free text`)
    if (options.filter((o) => o.recommended).length > 1) faults.push(`${path}: only ONE option may be \`recommended\` — a recommendation on two of three choices says nothing`)
    // FOLLOW-UPS HANG OFF AN OPTION, so a free-text question cannot carry one: there is no answer to
    // branch on. A worker wanting a second question should register a second ROOT.
    for (const [i, option] of options.entries()) {
      if ((option.followUps ?? []).length > 0 && node.kind === "multi") {
        faults.push(`${path}: a \`multi\` option cannot carry follow-ups — several picked options would open several branches at once`)
      }
      for (const child of option.followUps ?? []) walk(child, `${path} → ${option.label}`)
      void i
    }
  }
  walk(q, "question")
  if (askedQuestionDepth(q) > ASK_MAX_DEPTH) {
    faults.push(`the follow-up tree is ${askedQuestionDepth(q)} levels deep; the limit is ${ASK_MAX_DEPTH} — past that you are asking the human to fill in a form`)
  }
  return faults
}

export const AskInput = z.object({
  slug: ThreadSlug,
  // No cap on the count (four until 2026-09-03): the tool's own text says "several at once is one
  // call — register them together", and a cap here told a worker with six to batch and then refused it.
  questions: z.array(AskedQuestionSchema).min(1),
}).strict()
export type AskInput = z.infer<typeof AskInput>

/** One registered question, as every reader sees it: the worker's read-back, the board, and the card. */
export const RegisteredQuestionView = z.object({
  /** Minted by frizz. The worker never chose it, which is why an answer RESTATES the question text —
   *  an id alone cannot be correlated back to what was asked. */
  id: z.string(),
  spec: AskedQuestionSchema,
  askedAt: z.string(),
}).strict()
export type RegisteredQuestionView = z.infer<typeof RegisteredQuestionView>

export const AskResult = z.object({
  registered: z.array(RegisteredQuestionView),
  /** Everything still open on this thread afterwards, so a worker never needs a second call. */
  open: z.array(RegisteredQuestionView),
}).strict()
export type AskResult = z.infer<typeof AskResult>

export const UnaskInput = z.object({
  slug: ThreadSlug,
  id: z.string().min(1).max(64),
}).strict()
export type UnaskInput = z.infer<typeof UnaskInput>

export const UnaskResult = z.object({
  withdrawn: z.boolean(),
  open: z.array(RegisteredQuestionView),
}).strict()
export type UnaskResult = z.infer<typeof UnaskResult>

/** One question's answer, as the worker receives it.
 *
 *  IT RESTATES THE QUESTION. The worker never saw `questionId` — frizz minted it at registration — so
 *  the id alone cannot be correlated back to anything the worker wrote. The text is what makes the
 *  payload readable on its own, and it is why this is not simply `{id: choice}`. */
export interface QuestionAnswer {
  questionId: string
  question: string
  /** The labels the human picked — one for a `question`, any number for a `multi`, none for free text. */
  chosen: string[]
  /** What they typed, when they typed instead of (or as well as) picking. */
  text?: string
  /** Answers to the follow-ups under the option they took. A branch NOT taken contributes nothing: the
   *  answered set plus the branch taken is the whole payload, so an absent follow-up means "not asked",
   *  never "asked and skipped". */
  followUps?: QuestionAnswer[]
}

const QuestionAnswerSchema: z.ZodType<QuestionAnswer> = z.lazy(() => z.object({
  questionId: z.string().min(1).max(64),
  question: z.string().min(1).max(4000),
  // No count cap: a `multi` may carry any number of options (see AskedQuestionSchema), and the human
  // may pick every one of them. The per-item cap is the option label's.
  chosen: z.array(z.string().max(400)),
  text: z.string().max(8000).optional(),
  followUps: z.array(QuestionAnswerSchema).optional(),
}).strict())

export const AnswerQuestionsInput = z.object({
  slug: ThreadSlug,
  /** SUBMITTED AS A UNIT. The card sends whatever was answered in one call, because a per-question send
   *  would half-wake a turn: the worker would come back to a payload it cannot act on and would have to
   *  ask again for the rest. */
  answers: z.array(QuestionAnswerSchema).min(1),
}).strict()
export type AnswerQuestionsInput = z.infer<typeof AnswerQuestionsInput>

export const AnswerQuestionsResult = z.object({
  /** The ids that were open and are now answered. An id that was already settled is silently absent
   *  rather than an error: two browser tabs answering the same card is a race nobody should see. */
  answered: z.array(z.string()),
  open: z.array(RegisteredQuestionView),
}).strict()
export type AnswerQuestionsResult = z.infer<typeof AnswerQuestionsResult>

export const DismissQuestionsInput = z.object({
  slug: ThreadSlug,
  ids: z.array(z.string().min(1).max(64)).min(1),
}).strict()
export type DismissQuestionsInput = z.infer<typeof DismissQuestionsInput>

export const DismissQuestionsResult = z.object({
  dismissed: z.array(z.string()),
  open: z.array(RegisteredQuestionView),
}).strict()
export type DismissQuestionsResult = z.infer<typeof DismissQuestionsResult>

/** THE HEADER OF THE ONE WIRE FORMAT AN ANSWER TRAVELS IN, and the reason it is declared in shared
 *  rather than beside either producer: two of them write this line — the fence path's `composeAnswerWire`
 *  in the browser and `questionAnswerMessage` below — and ONE parser in the chat reads it
 *  (`parseBuriedAnswersMessage`). A private copy in each of the three is three chances to drift, and the
 *  failure is silent: the message still delivers, it just stops being the human's answer on screen. */
export const BURIED_ANSWERS_HEADER = "Answers to earlier questions:"

/** THE FOLLOW-UP MARKER on an answer row — U+2937, the app's one "branches from its parent" glyph
 *  (`CHILD_ARROW` in the web's lib/childOps.ts, which every child surface shares; U+21B3 is banned there
 *  outright, and the two are six pixels apart on screen). Declared here because the SERVER writes it and
 *  the browser's parser reads it, so a literal on either side is a chance to drift. */
export const ANSWER_FOLLOW_UP_MARKER = "⤷"

/** What a DISMISSED question carries in place of an answer. One row like any other (see below), so it
 *  reads to the human as what it is — a question sent on with nothing chosen — while still telling the
 *  worker what to do with it. */
export const DISMISSED_ANSWER = "(dismissed — decide it yourself; do not re-ask)"

/** A question the human waved away, as the answer message needs it: the TEXT, never the id. The worker
 *  never saw an id — frizz minted it — so a list of ids names nothing it can act on. */
export interface QuestionDismissal {
  question: string
}

/** The answer as it reaches the worker — one message, composed here so the RPC, the delivery and any
 *  read-back cannot word it three ways.
 *
 *  IT IS THE HUMAN'S OWN TURN AND IT MUST READ AS ONE. The chat renders any user message in this wire
 *  form as the structured Answers card — each question restated above the chip carrying what was chosen
 *  or typed — and it checks for that form BEFORE it checks whether frizz delivered the message, so
 *  matching the format is the whole of the attribution. Until 2026-08-27 this composed
 *  `Answers to the questions you registered:` over `- ` bullets, which matched no parser: a registered
 *  question's answer landed in the transcript as frizz's own notification card, full of agent-facing
 *  prose, over the human's own words (maintainer: "Why did you regress how this looks when I answer a
 *  question? They used to look good. It just showed it, reiterated the question as well as my selected
 *  or typed answer", then, of the header: "Why would this show up in the UI?").
 *
 *  SO THE TREE IS FLATTENED — one numbered row per answered node, a follow-up marked `⤷` before its
 *  quote. Indenting a child under its parent is what the fence form does NOT support: the parser reads
 *  any line after a row that is not itself a row as a CONTINUATION of that row's answer, so an indented
 *  follow-up renders inside its parent's answer chip. The rows stay in tree order, so the shape is still
 *  legible; the marker is what says which is which.
 *
 *  A DISMISSAL RIDES ALONG rather than waking anybody. The human dismissing questions is almost always
 *  dismissing several in a row and is sitting right there, so each × marking the row and waking the
 *  worker would be a turn per click. They are told at the next wake, in this same message — as ROWS, for
 *  the same reason the follow-ups are: a trailing paragraph is swallowed into the last answer. */
export function questionAnswerMessage(answers: readonly QuestionAnswer[], dismissed: readonly QuestionDismissal[] = []): string {
  // NO ANSWERS AT ALL is its own message, not the answers one with an empty list. It reaches exactly one
  // thread: an AUTONOMOUS one, whose questions were cancelled wholesale when its Goal was armed and
  // which has no next steer for them to ride (scheduler.evalQuestionAnswers). Wording it as "answers"
  // would tell that worker the human replied, when the whole point is that nobody is going to. Frizz is
  // speaking here rather than the human, so the chat draws it as a hairline — see questionsCancelledWake.
  if (answers.length === 0) return questionsCancelledWakeMessage(dismissed.length)
  const rows: string[] = []
  const push = (a: QuestionAnswer, followUp: boolean): void => {
    const said = [a.chosen.join(", "), a.text].filter(Boolean).join(" — ")
    rows.push(`${followUp ? `${ANSWER_FOLLOW_UP_MARKER} ` : ""}“${a.question}” → ${said || "(no answer)"}`)
    for (const child of a.followUps ?? []) push(child, true)
  }
  for (const a of answers) push(a, false)
  for (const d of dismissed) rows.push(`“${d.question}” → ${DISMISSED_ANSWER}`)
  return `${BURIED_ANSWERS_HEADER}\n${rows.map((row, i) => `${i + 1}. ${row}`).join("\n")}`
}

/** THE ONE WAKE ON THIS PATH FRIZZ WRITES IN ITS OWN VOICE, so it is the one the chat draws as a
 *  hairline instead of a card (FrizzWake's rule: frizz's own news is a line, someone else's prose keeps
 *  the card). It says nobody is coming — the thread went autonomous while questions were still open, so
 *  they were cancelled wholesale and there is no next steer for them to ride. */
export function questionsCancelledWakeMessage(count: number): string {
  return (
    `${count} question${count === 1 ? "" : "s"} you registered ${count === 1 ? "was" : "were"} CANCELLED without an answer. ` +
    `Decide ${count === 1 ? "it" : "them"} yourself and carry on — say which way you went in your write-up. Do not re-ask.`
  )
}

const QUESTIONS_CANCELLED_WAKE = /^(\d+) questions? you registered (?:was|were) CANCELLED without an answer\./

/** The count, or undefined when this is not that message. Lives beside the producer for the reason every
 *  parser in this file does: a wording change on one that forgets the other puts agent-facing prose back
 *  in front of the human. */
export function parseQuestionsCancelledWake(text: string): { count: number } | undefined {
  const m = QUESTIONS_CANCELLED_WAKE.exec(text.trim())
  return m ? { count: Number(m[1]) } : undefined
}

/** The worker's own completion. `body` is the markdown the card renders — the same thing the ```done
 *  fence carried, minus the fence. */
export const MarkOwnDoneInput = z.object({
  slug: ThreadSlug,
  body: z.string().trim().min(1).max(20_000),
}).strict()
export type MarkOwnDoneInput = z.infer<typeof MarkOwnDoneInput>

/** What still holds the thread open, when something does. The call is REFUSED in that case and this is
 *  the refusal's material: the worker is told exactly what to resolve, by id, so it can act rather than
 *  guess. There is deliberately NO `force` flag anywhere in this contract — a bypass riding the gated
 *  call gets learned (the first refusal teaches it, it is then passed pre-emptively) and the gate
 *  degrades to a two-token tax. Any gate whose escape hatch is a parameter on the gated call is not a
 *  gate; the escape hatches here are `unask` and `unwatch`, which are the worker deciding on purpose. */
export const MarkOwnDoneResult = z.object({
  done: z.boolean(),
  /** Open questions, by id and question text. */
  blockingQuestions: z.array(z.object({ id: z.string(), question: z.string() }).strict()),
  /** Armed registrations, by id and what each names. Watches, PR watchers and timers alike. */
  blockingWatches: z.array(z.object({ id: z.string(), what: z.string() }).strict()),
}).strict()
export type MarkOwnDoneResult = z.infer<typeof MarkOwnDoneResult>

export const ListOwnPrWatchesInput = z.object({ slug: ThreadSlug }).strict()
export type ListOwnPrWatchesInput = z.infer<typeof ListOwnPrWatchesInput>

export const OwnPrWatchesResult = z.object({ watches: z.array(PrWatchView) }).strict()
export type OwnPrWatchesResult = z.infer<typeof OwnPrWatchesResult>

/** One armed (or just-settled) timer, as the worker's own tool reads it back. */
export const ThreadTimerView = z.object({
  id: z.string(),
  prompt: z.string(),
  /** The exact UTC instant it fires — the same string the delivered trailer names. */
  fireAt: z.string(),
  state: z.enum(["armed", "fired", "cancelled"]),
  createdAt: z.string(),
}).strict()
export type ThreadTimerView = z.infer<typeof ThreadTimerView>

// The signal fence on a thread's FINAL assistant message — the fence language IS the state, the
// body is the message. `done` = checked success card in the queue until the human Archives it (the
// fence itself MUTATES NOTHING — maintainer-settled); `awaiting` = a parked human/timer wait.
// Only excuses WHILE it is the final message — any newer activity clears it. ```question fences
// keep their own machinery (pendingQuestion / questionBlocks) and are NOT an excusal.
export const ThreadFence = z.object({
  kind: z.enum(["done", "awaiting"]),
  body: z.string(), // fence body minus hint lines, capped server-side; may be ""
  hints: z.array(AwaitingHint).default([]),
  // Present only on a completion the worker REGISTERED (`mcp__frizz__done`, board.registeredDoneFence)
  // rather than wrote as a ```done fence in its final message. The two are one fence to every predicate,
  // but the TRANSCRIPT draws a fence card from the message text it parses — so a registered done, which
  // is in no message, needs the client to know it must draw the card itself at the bottom of the thread
  // (maintainer 2026-08-27: a thread that signed off by tool rested with no card at all).
  registered: z.literal(true).optional(),
})
export type ThreadFence = z.infer<typeof ThreadFence>

// ---- Subscription usage-limit pause (auto-resume) ------------------------------------------------
// Which metered subscription window the provider says is exhausted. "session" is the 5-hour rolling
// window (Claude's "You've hit your session limit"); "weekly" is the 7-day window; "model" is a
// MODEL-SCOPED weekly cap ("You've reached your Fable 5 limit. Switch to another model…", CLI
// ≥2.1.251 — the usage endpoint reports it as a `weekly-<model>` scoped window); "unknown" is a limit
// stop whose phrasing we could not attribute — never auto-resumed on a text-derived clock.
export const LimitWindow = z.enum(["session", "weekly", "model", "unknown"])
export type LimitWindow = z.infer<typeof LimitWindow>

// A thread whose turn was cut off mid-work by an exhausted subscription window, plus what frizz will
// do about it. `resumesAt` is a unix-seconds instant resolved from the provider's own reset clock (or
// its usage endpoint) — absent when neither source could supply one, in which case `autoResume` is
// false and the thread stays a normal human handoff.
export const LimitPause = z.object({
  backend: Backend,
  window: LimitWindow,
  at: z.string(), // ISO8601 of the limit record — "when the agent got cut off"
  resumesAt: z.number().optional(), // unix seconds the window rolls
  // Whether frizz intends to deliver its own "continue" once `resumesAt` passes. False when the
  // setting is off, the instant is unresolvable, or the pause is too old to safely resume.
  autoResume: z.boolean(),
})
export type LimitPause = z.infer<typeof LimitPause>

// Provider-authored failure data, never inferred from assistant prose. Unknown codes are retained so
// a new provider error cannot silently turn into an ordinary rest. Render the message as plain text.
export const ProviderError = z.object({
  message: z.string(),
  code: z.string().optional(),
  details: z.string().optional(),
  retrying: z.boolean().optional(),
  at: z.string().optional(),
})
export type ProviderError = z.infer<typeof ProviderError>

// One sidebar row: frizz board thread + runtime overlay.
export const ThreadView = z.object({
  id: ThreadSlug, // slug; filename is <slug>.md
  title: z.string(),
  status: FrizzStatus,
  statusText: z.string().optional(),
  // Form-constrained gerund label (≤100 chars, e.g. "Awaiting CI on PR #391") the worker maintains;
  // the listing row's at-a-glance gloss. Optional → absent on old threads renders nothing. Distinct
  // from statusText, which keeps its own surfaces (queue cards / board gloss).
  activity: z.string().optional(),
  next: z.string().optional(),
  // DERIVED (board shell-out, from the body): the thread keeps a `## Plan` section, i.e. it carries a
  // plan document → the sidebar renders a quiet PLAN badge. NOT a status and NOT a frontmatter flag
  // (that was deliberately rejected). Defaults false so an old snapshot / pre-restart server (which
  // omits it) parses.
  hasPlan: z.boolean().default(false),
  mechanism: BlockMechanism.nullable(), // set only when status=blocked
  humanBlocked: z.boolean(),
  ready: z.boolean(), // deps cleared, auto-fire candidate
  dependsOn: z.array(ThreadSlug),
  externalDeps: z.array(z.string()),
  owner: z.string().optional(),
  revalidate: z.string().optional(), // ISO8601
  agents: z.array(ThreadAgent),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  // runtime overlay (from the UI server, not the .frizz file)
  runtime: RuntimeState,
  sessionId: z.string().optional(),
  threadName: z.string().optional(),
  unread: z.boolean(),
  archived: z.boolean(), // user hid the row from the nav; respawn/resume un-archives
  lastAssistant: z.string().optional(), // trimmed preview of last assistant text
  spawnedAt: z.string().optional(), // ISO8601
  lastActivityAt: z.string().optional(), // ISO8601, from jsonl tail — ANY record (incl. sub-agent/system)
  // ISO8601 of the agent's OWN last output (Claude: last assistant record; Codex: turn-end/final text).
  // This is the "rest time" — when the thread's own turn last came to rest — and UNLIKE lastActivityAt
  // it is NOT bumped by a background sub-agent's completion notification (a promptSource:system record).
  // The queue/rested-band order key and the at-rest "Last active" label both key off this. Optional so
  // old snapshots parse; the client falls back to lastActivityAt/spawnedAt when absent.
  lastAssistantAt: z.string().optional(),
  aiTitle: z.string().optional(), // Claude's own auto-generated session title (latest ai-title record)
  // True when `title` is a machine-guessed dispatch slug (title_auto=1), NOT a real name — the display
  // then shows a "Spinning up a thread…" placeholder instead of the guess until aiTitle lands. Optional
  // (absent ⇒ legacy/slim row) so old snapshots parse; absent is treated as "not provisional".
  titleAuto: z.boolean().optional(),
  // True when a HUMAN named this thread (rename / native /rename / an adopted file heading) and no
  // backend auto-title may replace it. FALSE is the interesting case: a title hard-coded by a dispatch
  // CALLER — `Investigate acme/app#391`, a parent agent's guess through spawn_thread — reads as a real
  // name (titleAuto false) yet still yields to the worker's own aiTitle, which is usually the more
  // informative one. Optional (absent ⇒ legacy/slim row): the display then derives it the pre-split way,
  // treating any non-guessed title as the human's. The server enforces this too by withholding aiTitle
  // from a locked row; the client keeps its own copy so a stale record can never win on either side.
  titleLocked: z.boolean().optional(),
  // Live background sub-agents the worker dispatched (tailer-derived). Defaults to [] so an old
  // snapshot/row (or a pre-restart server that doesn't emit the field yet) parses without breaking.
  subAgents: z.array(SubAgentView).default([]),
  // Live background SHELLS the worker launched (tailer-derived). Same default-[] discipline. Rendered
  // in the anchored background-ops strip alongside sub-agents; ids make current rows drillable.
  bgShells: z.array(BgShellView).default([]),
  // The thread's ARMED WATCHERS — registry-derived, not folded from the transcript, which is what makes
  // them survive the worker saying one more sentence. Same default-[] discipline as the two above.
  //
  // These NEVER park the thread: a row with an armed watcher stays a visible queue handoff, and Snooze
  // remains the only way to hide one (maintainer 2026-08-12, choosing this over auto-Held for every
  // kind). So this field is for the operator to SEE what a thread is waiting on — it deliberately feeds
  // no queue-membership rule.
  watches: z.array(ThreadWatchView).default([]),
  // A pending native AskUserQuestion the session is frozen on (tailer-derived). Optional — absent
  // when there's no unanswered ask. Feeds needsAction + the read-only question render + "Answer in Terminal".
  pendingAsk: PendingAsk.optional(),
  // Derived safety net (tailer): at rest with an unanswered ```question the worker asked in chat but
  // never encoded as blocked. Defaults false so old snapshots/rows parse. Feeds needsAction.
  pendingQuestion: z.boolean().default(false),
  // The worker's REGISTERED questions, still open (thread_question). Distinct from `pendingQuestion`
  // beside it, and the difference is the whole point of the registry: that boolean is recomputed from
  // the LATEST assistant text on every assistant record and cleared by any human turn, so it cannot
  // outlive the message that carried it. These rows can, and they carry the question itself rather than
  // merely asserting one exists — the card renders from this instead of re-parsing prose.
  questions: z.array(RegisteredQuestionView).default([]),
  /** The answer the human has already SENT that the worker has not received yet, as the exact message
   *  the delivery will carry (board.answersInFlight → questionAnswerMessage). The chat parses it with
   *  the same reader it uses on the delivered turn, so the in-flight card and the landed one are the
   *  same card and the swap is invisible. Absent whenever there is nothing in flight, which is almost
   *  always — it exists for the seconds between the human sending and the worker being handed it. */
  answersInFlight: z.string().optional(),
  // ISO8601 of the newest REAL user interaction (answer/steer/dispatch) — the chronological listing
  // sort key. Optional; the listing falls back to spawnedAt when absent (a dispatch IS an interaction).
  lastUserAt: z.string().optional(),
  // Runtime provider-auth rejection (claude-auth plan): the session's provider positively rejected
  // its credential (Claude: synthetic isApiErrorMessage 401 record, or the 401/login text on a
  // boot-failed pane). Bounded by design — only the typed category travels, never raw provider/pane
  // text. Drives the trusted sign-in recovery card. Optional so old snapshots/servers parse.
  providerFault: z.object({
    backend: z.enum(["claude", "codex"]),
    category: z.enum(["authentication_required", "authentication_rejected"]),
  }).optional(),
  // The session's turn was cut off by an exhausted SUBSCRIPTION window. Distinct from providerFault:
  // the credential is fine, the account is simply out of quota until the window rolls, so the recovery
  // is to WAIT and continue — not to sign in. Same discipline as providerFault: only typed data
  // travels, never the provider's own error text. Optional so old snapshots/servers parse.
  limitPause: LimitPause.optional(),
  providerError: ProviderError.optional(),

  // ---- Session-first fields (ALL optional: absent ⇒ a legacy .frizz-file row / pre-restart server;
  // the client treats such rows as Legacy-shelf material). Deliberately not zod-defaulted so server
  // constructors that predate the model still typecheck and old snapshots parse unchanged. ----
  // "session" = a session-backed thread (the working rail's unit); "legacy" (or absent) = a .frizz
  // file row, rendered read-only in the collapsed Legacy shelf.
  kind: z.enum(["session", "legacy"]).optional(),
  // No registry row (a maintainer terminal discovered from the JSONL dir): read-only transcript,
  // no lifecycle verbs (no composer / kill / resume), never in Needs-you, no archive/seen state.
  foreign: z.boolean().optional(),
  // ui.db lifecycle for session threads (open|archived) — written ONLY by explicit Archive/Reopen.
  state: z.enum(["open", "archived"]).optional(),
  // Exact durable user snooze. While this instant is in the future, an otherwise-resting thread is
  // suppressed from Queue and shown dimmed in Held. Hard interactive gates (question, permission,
  // native approval, crash) deliberately break through it. Expired values are cleared server-side.
  snoozedUntil: SnoozeUntil.optional(),
  // The prompt this snooze will deliver at its deadline, when it carries one. Present ⇒ the wake is an
  // AUTO-bump (the scheduler resumes the agent with exactly this text) rather than a reminder, which is
  // the distinction the held row's tooltip renders. Absent ⇒ the card merely re-surfaces.
  snoozePrompt: z.string().optional(),
  // The instant the human PINNED this thread (absent = not pinned). A pinned thread leaves the rail's
  // band system entirely — Rested/Active/Snoozed/Done — and holds the pinned band at the very top, in
  // this instant's order. Lifecycle metadata like the snooze: written only by the pin/unpin verb, and
  // it outranks every derived state (a pinned thread that finishes stays pinned).
  pinnedAt: z.string().optional(),
  /** The EVENT snooze on the resting card is armed for this exact rest — the human has said "hide this
   *  until something reports". Distinct from `snoozedUntil`, which is a wall-clock park on the whole
   *  thread: this one has no deadline and clears itself when the thread comes to a NEW rest.
   *
   *  It travels because the chat has to honour it too (2026-08-14). Until then only the QUEUE did, on
   *  the reasoning that the card states a FACT the drawer must keep showing or it blanks at rest and
   *  reads as "the agent died". That reasoning holds for a thread nobody has parked; once the human has
   *  explicitly parked THIS rest, showing them the same card with the same button one surface over is
   *  not information, and they said so. */
  bgSnoozed: z.boolean().optional(),
  // Which Claude transport serves this thread. "broker" — a session-broker-owned Agent SDK session with
  // a typed control channel — is the only one there is; ABSENT means a row dispatched before the broker
  // became the sole transport, which frizz can no longer reach that way. Only the broker can be asked to
  // reload its plugin closure in place, so the board needs this to decide whether to offer that verb at
  // all rather than render a button that throws.
  claudeRuntime: z.literal("broker").optional(),
  // The thread's recurring prompt, when one has been written. Present with BOTH triggers false ⇒ the
  // text and the cadence are kept but nothing fires — that pair of falses IS the off state, which is
  // why there is no separate enable flag here to disagree with them.
  recurringPrompt: ThreadRecurringPrompt.optional(),
  // The signal fence on the final assistant message, present only while the thread is excused by it.
  lastFence: ThreadFence.optional(),
  // SERVER-DERIVED queue membership: explicit questions, checked/done handoffs, plus the process-level
  // blocks (perm-prompt / pendingAsk / crash) that a view can't clear. The client renders the
  // queue off this bit alone for session threads (legacy rows keep needsAction()).
  needsYou: z.boolean().optional(),
  // True only for the crash/stall branch (pane exited while the transcript still says in-flight).
  // Once every ordinary rest also queues, runtime=exited + needsYou is no longer enough for clients
  // to distinguish a failed worker from a clean completed process.
  crashed: z.boolean().optional(),
  // The queued reason is "resting while its OWN background work (sub-agents / shells) is still live,
  // with no human ask": the agent came to rest awaiting results it dispatched, not awaiting the human.
  // The card renders the informational awaiting-background banner + an event-Snooze that hides it until
  // the work returns (the parent re-rests). True only when this is the SOLE queue reason (no question /
  // ask / native input / done fence outranks it) and no event-snooze is armed for the current rest.
  // Optional like needsYou/crashed: absent ⇒ a pre-restart server or a non-session row; the client
  // treats absence as false.
  awaitingBackground: z.boolean().optional(),
  // Exact typed-interaction presence for this CURRENT registered session. The board already derives
  // this from the scoped durable journal to compute needsYou; exposing the reason lets React avoid a
  // pendingInteractions RPC for every unrelated question/completion card. Optional preserves rolling
  // compatibility: a client paired with an older server treats absence as "unknown" and keeps the
  // previous query behavior, while a current server always emits true/false for owned session rows.
  pendingInteraction: z.boolean().optional(),
  // True only while a durable typed interaction still needs a USER decision. This is deliberately
  // distinct from pendingInteraction: after the human answers, provider delivery can remain queued or
  // sent (and therefore pending/readable) without remaining a hard gate that disables Snooze.
  // Optional keeps rolling client/server reloads compatible; current servers always emit the bit.
  actionableInteraction: z.boolean().optional(),
  // ISO8601 read/seen telemetry (threadSeen RPC — recorded when the human opens the thread). Kept for
  // compatibility and analytics only; viewing never acknowledges or removes a queue handoff.
  seenAt: z.string().optional(),
  // Which agent backend runs this thread (Codex-support epic, Phase 3) — drives the subtle per-row
  // rail badge. Optional so a legacy/foreign/pre-restart row parses; absent OR "claude" ⇒ no badge
  // (Claude is the unmarked default), "codex" ⇒ the small Codex badge.
  backend: Backend.optional(),
  // The backend-native permission/sandbox profile this session was launched (or explicitly
  // re-attached) with. Persisted per thread: never inferred from mutable Settings. Optional for
  // migrated/foreign sessions whose actual process mode is unknown.
  permissionMode: z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  // A durable requested mode that has not yet appeared in backend telemetry. The UI renders this as
  // pending beside permissionMode; it never replaces the observed value optimistically.
  permissionPending: z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  // Raw durable barrier bit. Unlike permissionPending this remains true for a future/corrupt value,
  // so rolling clients fail closed instead of enabling another composer while ownership is unknown.
  permissionChangePending: z.boolean().optional(),
  // The last DENIAL the worker's permission POLICY made for this thread (cc-worker/hooks/
  // perm-policy.mjs), and how many times it has denied. A refusal changes what the worker can do, so
  // it earns a card. Approvals and deferrals are deliberately absent: a deferral already shows as a
  // permission prompt / Needs you, and an approval blocks nobody — the quiet line that used to report
  // one stuck to the bottom of the thread forever, describing a command the reader had long moved past.
  permPolicy: z.object({
    decision: z.literal("deny"),
    rule: z.string(),
    reason: z.string(),
    tool: z.string().nullable(),
    at: z.string(),
    command: z.string().optional(),
  }).optional(),
  permDenies: z.number().optional(),
  // Atomic model+effort handoff state. The displayed model/effort remain the last committed launch
  // target until both pending values are attached and readiness-proven for a new generation.
  profilePendingModel: z.string().optional(),
  profilePendingEffort: z.string().optional(),
  profileChangePending: z.boolean().optional(),
  // One durable runtime-control owner serializes reattach/resume/native-composer mutations. Unknown
  // future owner values still disable the composer rather than being treated as idle.
  runtimeControlPending: z.boolean().optional(),
  // controlError is an actionable reason the controller failed closed (for example a busy thread).
  controlError: z.string().optional(),
  // The session's concrete model + reasoning effort: pinned launch metadata for new dispatches,
  // refined/backfilled from backend transcript telemetry where available (Claude records model;
  // Codex records both). Never derived from current Settings. Strings keep future backend-native
  // values forward-compatible; absent when neither durable source knows → the UI renders no guess.
  model: z.string().optional(),
  effort: z.string().optional(),
  // How full the session's context window is right now — the footer's fullness readout. BOTH halves
  // are provider-measured and the field is emitted ONLY when both are present, so a client never has
  // to decide what to do with half a fraction: absent ⇒ no reading, never a 0% dial. Codex reports
  // both on every `token_count`; a Claude row gets `tokens` from each assistant record's usage but
  // `window` only once its first broker turn has ended (and never at all for a foreign row, or one
  // dispatched before the broker became the only Claude transport).
  // `tokens` legitimately DROPS after a compaction — the context really did get smaller.
  context: z.object({ tokens: z.number(), window: z.number() }).optional(),
})
export type ThreadView = z.infer<typeof ThreadView>

/**
 * Whether a thread is IN THE QUEUE — the maintainer's "rested" band, the one with a card per row.
 *
 * ONE definition for both sides of the wire. `needsYou` is derived on the server (board.ts) and is
 * the queue; the two guards around it are display facts the server also enforces (it clears
 * `needsYou` on an archived row, and a foreign session never queues because its interaction surface
 * is the terminal the human is already sitting in). The web's sidebar and queue read it through
 * groups.ts `queued`; the server counts it per project for the rail's badges — and a badge that
 * disagreed with the rail it sits beside would be worse than no badge.
 */
export function queuedThread(t: Pick<ThreadView, "kind" | "foreign" | "needsYou" | "state">): boolean {
  return t.kind === "session" && t.foreign !== true && t.needsYou === true && t.state !== "archived"
}

// STRUCTURED board error — a machine-readable companion to the legacy `errors: string[]` so the
// client can tell a REPAIRABLE error from an inert one and which file it names. `no-frontmatter` is
// the one-click-repairable case (a thread .md written with no YAML frontmatter, invisible to the
// queue/status system until healed); everything else is `other` (a dangling dep, a bad status, a
// board-read failure) and renders as today with no repair affordance. Additive: the legacy string
// array is untouched, this is a PARALLEL field. `file` is the .md basename (or "" for a board-level
// failure with no single file).
export const BoardErrorItem = z.object({
  file: z.string(),
  kind: z.enum(["no-frontmatter", "other"]),
  message: z.string(),
})
export type BoardErrorItem = z.infer<typeof BoardErrorItem>

export const BoardSnapshot = z.object({
  projectDir: z.string(),
  projectName: z.string(),
  projectLabel: z.string(), // "owner/repo" from the git origin remote; falls back to projectName
  // "owner/repo" ONLY when that origin remote is github.com — the link target the rendered-markdown
  // autolinker turns `#123` and a bare commit hash into. Deliberately NOT projectLabel, which is a
  // host-agnostic DISPLAY name: a GitLab origin yields an owner/repo there too, and pointing its `#12`
  // at github.com would be a wrong destination rather than a missing one. Absent means the
  // augmentation stays off (no remote, another forge, or a pre-restart server).
  githubRepo: z.string().optional(),
  // This project's URL slug — the `<slug>` in `/project/<slug>`. The client cannot derive it: a
  // PREFIXED page reads it off its own path, but the LAUNCHING project is served unprefixed and so has
  // nothing to read, which left `/` — the all-projects GRID — as the only URL its queue could name.
  // Optional so a pre-restart server keeps working; absent means "fall back to `/`", i.e. the old
  // behaviour. Registry-derived, so it is the same slug every other surface links to.
  projectSlug: z.string().optional(),
  // The server's home directory — the expansion of a `~` a worker wrote in prose. Agents reference
  // files that way constantly (`~/.claude/CLAUDE.md`), and the browser has no way to derive it, so a
  // `~`-anchored Markdown link had no absolute path to become and stayed a same-origin anchor that
  // navigated out of Frizz. The client only ever uses it to build a path it then hands BACK to the
  // server, which realpath-gates it exactly as it gates one the author typed in full. Optional so a
  // pre-restart server keeps working; absent means `~` links stay unresolved, i.e. the old behaviour.
  homeDir: z.string().optional(),
  // (No `.frizz/ exists` bit here on purpose. Threads are session-first — the ui.db registry IS the
  // board — so `.frizz/` presence says nothing about whether this project has one. Its only consumer
  // was a shell gate that dead-ended `.frizz`-less repos; the server still probes the directory
  // locally where it genuinely matters, for scratchpad storage.)
  threads: z.array(ThreadView),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  // Structured mirror of `errors` (see BoardErrorItem). Optional so a pre-restart server / old
  // snapshot that omits it still parses; the client treats absent as "no structured errors" and
  // falls back to rendering the plain `errors` strings.
  errorItems: z.array(BoardErrorItem).optional(),
})
export type BoardSnapshot = z.infer<typeof BoardSnapshot>

// ---- Provider quota (subscription rate-limit windows) ----
// A single usage window for a provider's plan — the 5-hour rolling window or the weekly window that
// Claude/Codex subscriptions meter against. `usedPercent` is 0..100 (how much of the window is spent,
// so remaining = 100 - usedPercent); `resetsAt` is a unix-seconds instant the window rolls over.
export const QuotaWindow = z.object({
  key: z.string(), // stable id: "5h" | "weekly" (provider-neutral)
  label: z.string(), // short human label for the chip ("5h", "Weekly") — house duration grammar
  usedPercent: z.number(), // 0..100
  resetsAt: z.number().optional(), // unix seconds; absent when the source doesn't report it
})
export type QuotaWindow = z.infer<typeof QuotaWindow>

// One provider's quota. `status: "ok"` carries live windows; "unavailable" means we could not read it
// (no recent session, endpoint unreachable, not logged in) and the UI shows a neutral dash + `detail`.
export const ProviderQuota = z.object({
  status: z.enum(["ok", "unavailable"]),
  planType: z.string().optional(), // "pro" / "max" / etc. when the source reports it
  windows: z.array(QuotaWindow),
  detail: z.string().optional(), // why unavailable, or an extra note
})
export type ProviderQuota = z.infer<typeof ProviderQuota>

// The polled quota snapshot the sidebar status bar renders — one entry per agent backend.
export const QuotaSnapshot = z.object({
  claude: ProviderQuota,
  codex: ProviderQuota,
})
export type QuotaSnapshot = z.infer<typeof QuotaSnapshot>

// ---- Provider auth (local credential presence) ----
// Whether a provider's LOCAL credential exists — the signal the new-thread dispatch gate keys on.
// DISTINCT from quota's "unavailable": that is overloaded with transient endpoint failures, whereas
// this reports credential presence only. "signed-out" = we positively found no credential; "unknown" =
// we couldn't determine it (read error). The gate BLOCKS on "signed-out" and FAILS OPEN on "unknown".
export const ProviderAuth = z.enum(["authed", "signed-out", "unknown"])
export type ProviderAuth = z.infer<typeof ProviderAuth>

// WHICH account each credential belongs to — the email the provider's own on-disk account record
// carries. Purely informational (the quota popover answers "signed in as who?"); nothing gates on it,
// so every field is optional and an unreadable record simply yields nothing rather than an error.
// Deliberately a SIBLING of the per-provider auth verdicts rather than nested with them: the gate's
// shape (`snapshot[backend] === "signed-out"`) is load-bearing in dispatch and must not move.
export const AccountEmails = z.object({
  claude: z.string().max(320).optional(),
  codex: z.string().max(320).optional(),
})
export type AccountEmails = z.infer<typeof AccountEmails>

// The per-provider auth snapshot the new-thread gate reads — one entry per agent backend.
export const AuthSnapshot = z.object({
  claude: ProviderAuth,
  codex: ProviderAuth,
  emails: AccountEmails,
})
export const AccountLogoutInput = z.object({ backend: z.enum(["claude", "codex"]) }).strict()
export type AccountLogoutInput = z.infer<typeof AccountLogoutInput>
// Result of the typed provider logout action. "blocked" = refused because the provider had live
// turns (account state is process-global; changing it mid-request produces ambiguous failures);
// "failed" = the CLI errored AND the credential still reads present. `auth` is the post-attempt
// credential state so the client can refresh its snapshot without another round-trip.
export const AccountLogoutResult = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  auth: ProviderAuth,
  activeThreads: z.number().int().positive().optional(),
  detail: z.string().max(200).optional(),
})
export type AccountLogoutResult = z.infer<typeof AccountLogoutResult>
// Slice B login utility: start/inspect/cancel the restricted `claude auth login` terminal. The
// attempt id is slug-shaped so it can ride the hardened /term/<slug> transport; it is server-issued
// and opaque — the client never constructs one.
export const AccountLoginStartInput = z.object({ backend: z.enum(["claude", "codex"]) }).strict()
export type AccountLoginStartInput = z.infer<typeof AccountLoginStartInput>
export const AccountLoginStartResult = z.object({ attemptId: ThreadSlug })
export type AccountLoginStartResult = z.infer<typeof AccountLoginStartResult>
export const AccountLoginStatusInput = z.object({ attemptId: ThreadSlug }).strict()
export type AccountLoginStatusInput = z.infer<typeof AccountLoginStatusInput>
// `auth` is the live credential re-read; the client treats state:"exited" + auth:"authed" as a
// completed sign-in. The NEXT real provider request remains the validity proof (an expired token
// also reads "authed" here — the runtime 401 classifier covers that).
export const AccountLoginStatusResult = z.object({
  state: z.enum(["running", "exited", "unknown"]),
  auth: ProviderAuth,
})
export type AccountLoginStatusResult = z.infer<typeof AccountLoginStatusResult>
export type AuthSnapshot = z.infer<typeof AuthSnapshot>

// ---- Settings ----

export const PermissionMode = z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"])
export type PermissionMode = z.infer<typeof PermissionMode>

// Where a vetted local artifact link opens. This is intentionally a server-owned setting: the
// browser never gets permission to navigate to file:// or choose an arbitrary executable.
export const LocalFileOpener = z.enum(["system", "cursor", "vscode", "finder", "copy"])
export type LocalFileOpener = z.infer<typeof LocalFileOpener>

export const Settings = z.object({
  // The mode NEW Claude workers launch in. Settings surfaces exactly two of them — `bypassPermissions`
  // (--dangerously-skip-permissions, the shipped default since 0.7.2) and `auto` — because those are the only two
  // an unattended worker can actually run in; the server's workerDispatchPermission enforces that same
  // floor, so a restrictive value left here by an older build cannot reach a spawn.
  permissionMode: PermissionMode,
  model: z.string().optional(), // the agent's --model value; undefined = CLI default
  // The agent backend the selected model runs on (Codex-support epic, Phase 3). Persisted ALONGSIDE
  // `model` — a Claude model pins "claude", a GPT/Codex model pins "codex" — so the dependent controls
  // (permission-mode vs sandbox, the effort set) know which axis to present. Optional so an old blob
  // parses; absent ⇒ "claude" (derivable from `model` too, via backendForModel in web/lib/options).
  backend: Backend.optional(),
  // Reasoning effort. The ladder spans BOTH backends' universes: Claude's (low..max, plus "ultracode")
  // and codex's (adds "ultra" — a 5.6-sol/terra level above max). Which subset is OFFERED is
  // backend/model-gated in the UI (a codex model exposes exactly its cache `efforts`; "ultracode" is
  // offered only on an xhigh-capable Claude model), and the server passes the chosen value through per
  // backend — so the wire enum is simply the union.
  //
  // "ultracode" is a Claude rung with no `--effort` equivalent: Claude Code's effort flag stops at max,
  // and ultracode is a separate session-scoped setting meaning "xhigh + standing dynamic-workflow
  // orchestration". It travels the wire as an effort because that is how Claude Code's own `/effort`
  // presents it; resolveClaudeEffort (server/backend/claude-effort.ts) translates it at the spawn edge.
  effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]).optional(),
  notifications: z.boolean(),
  /**
   * The permanent column of project icons. OFF by default, on purpose.
   *
   * A rail of every project on the machine is a standing invitation to leave the thread you are in —
   * "just too tempting" (maintainer 2026-08-06). Frizz's home is one board; the grid is a page you go
   * to, not furniture you sit beside. Hidden, the way back is a breadcrumb in the status bar, which
   * costs a click exactly when you meant to switch and nothing when you did not.
   *
   * Machine-level, like the font: which chrome you want is a property of the person, not the repo.
   */
  projectRail: z.boolean(),
  // UI type family. `mono` (default) is the mono-forward system; `sans` swaps prose/UI chrome to a
  // sans stack while code / tool lines / the terminal stay mono. Optional so an old settings blob
  // parses; defaultSettings pins "mono".
  font: z.enum(["mono", "sans"]).optional(),
  // Default action for a vetted non-image local path in agent markdown. Image clicks always use the
  // OS default viewer so screenshots retain their expected behavior.
  localFileOpener: LocalFileOpener.optional(),
  // The token count at which a NEW Claude worker auto-compacts its conversation. Frizz requests the
  // 1M context window on every dispatch (resolveClaudeLaunchModel), so without this a worker grows
  // toward 1M before it ever compacts — and every turn past 200K re-sends up to 5x the conversation a
  // 200K TUI session would, which is the single largest reason a Frizz thread spends quota faster than
  // the TUI (measured 2026-08-26). Reaches the worker as CLAUDE_CODE_AUTO_COMPACT_WINDOW, which Claude
  // Code caps to the model's real window. Optional so an old blob parses; defaultSettings pins 500_000
  // (maintainer 2026-08-26: "a default compaction window of 500k by default").
  autoCompactWindow: z.number().int().positive().optional(),
  // The prompt-cache tier a NEW Claude worker writes to. "auto" leaves the CLI's own choice (1h on a
  // subscription); "5m" and "1h" reach the worker as CLAUDE_CODE_PROMPT_CACHE_TTL (and the sub-agent
  // twin). The 1h tier bills a cache write at 2x input against 1.25x for 5m; on 2026-09-03 cache
  // writes were 51% of a day's spend while the entries were invalidated every 15–30 minutes anyway
  // (see claudePromptCacheEnv). Optional so an old blob parses; defaultSettings pins "auto".
  promptCacheTtl: z.enum(["auto", "5m", "1h"]).optional(),
  // The GitHub batch-dispatch prompt template (the picker's per-item worker prompt). Optional: when
  // unset OR blank the server falls back to its exported DEFAULT_GITHUB_PROMPT. Substitution tokens
  // the server fills: {repo} {n} {title} {url} {labels} {body}. The leading `THREAD: <slug>` tag is
  // prepended by the server (not part of the editable template) so a custom prompt can never break the
  // thread↔.frizz-file binding. Optional so old settings blobs parse.
  //
  // ONE field, not one per kind. Issue and PR each had their own template until 2026-08-15, and the two
  // said the same thing twice: read the whole thread, be skeptical, cite what you checked, post nothing.
  // A person tuning "be more dubious" had to make the same edit in two boxes and keep them in step. The
  // ONE thing that genuinely differs per kind — which `gh` command reads the item — is a line in the
  // metadata block, so the merged template just carries both, and the worker picks the one that applies.
  //
  // There is no migration off the two old keys, and that is deliberate (the maintainer's call): Settings
  // is a non-strict z.object, so `githubIssuePrompt`/`githubPrPrompt` are STRIPPED the moment an old
  // blob is parsed. Any existing override is dropped and the reader gets the new shipped default —
  // exactly the intended backfill. Merging two customized templates into one has no correct answer.
  githubPrompt: z.string().optional(),
})
export type Settings = z.infer<typeof Settings>

// The new-thread composer's durable choices — MACHINE-wide, one record for every project the server
// serves (server/dispatch-preferences.ts), because the profile belongs to the operator, not to a
// repository. Keep one profile per runtime so
// moving between Claude and Codex never overwrites the other runtime's model, effort, or permission
// selection. Fields stay optional for the first-run/default case: a displayed fallback is not stored
// as user intent until the human actually chooses it.
export const DispatchProviderPreferences = z.object({
  model: z.string().trim().min(1).max(200).optional(),
  effort: Settings.shape.effort,
  permissionMode: PermissionMode.optional(),
})
export type DispatchProviderPreferences = z.infer<typeof DispatchProviderPreferences>

export const DispatchPreferences = z.object({
  backend: Backend,
  claude: DispatchProviderPreferences,
  codex: DispatchProviderPreferences,
})
export type DispatchPreferences = z.infer<typeof DispatchPreferences>

// One complete launch profile. GitHub batch dispatch carries this whole tuple — read from the
// durable new-thread preference its own footer selector writes — instead of consulting Settings
// again: backend owns the model, and effort is part of the same atomic profile cell.
export const DispatchProfileSnapshot = z.object({
  backend: Backend,
  model: z.string().trim().min(1).max(200),
  effort: Settings.shape.effort.unwrap(),
  // IGNORED: dispatch permission is decided server-side (workerDispatchPermission) from the
  // non-interactive floor plus the operator's Settings choice, never per dispatch. Optional so old
  // clients that still send it parse.
  permissionMode: PermissionMode.optional(),
}).strict()
export type DispatchProfileSnapshot = z.infer<typeof DispatchProfileSnapshot>

// Atomic updates avoid read/modify/write races between the sidebar form and the anywhere composer.
// A matrix-cell selection is one complete model+effort profile mutation; permission remains an
// independent axis. Every provider-owned update names its runtime so a delayed request can never
// contaminate the other profile.
export const SetDispatchPreferenceInput = z.discriminatedUnion("field", [
  z.object({ field: z.literal("backend"), value: Backend }),
  z.object({
    field: z.literal("profile"),
    backend: Backend,
    model: z.string().trim().min(1).max(200),
    effort: Settings.shape.effort.unwrap(),
  }),
  z.object({ field: z.literal("model"), backend: Backend, value: z.string().trim().min(1).max(200) }),
  z.object({ field: z.literal("effort"), backend: Backend, value: Settings.shape.effort.unwrap() }),
])
export type SetDispatchPreferenceInput = z.infer<typeof SetDispatchPreferenceInput>

// ---- RPC inputs ----

export const DispatchInput = z.object({
  // Optional: when omitted, dispatch derives a fallback title from the prompt (Claude later renames
  // the session via ai-title, which the UI prefers for display). The thread FILE always gets a
  // concrete title regardless — frizz requires one.
  title: z.string().min(1).optional(),
  prompt: z.string().min(1),
  slug: ThreadSlug.optional(), // derived from title if omitted
  // IGNORED: dispatch permission is decided server-side (workerDispatchPermission) from the
  // non-interactive floor plus the operator's Settings choice, never per dispatch. Accepted-but-ignored
  // so old clients still parse.
  permissionMode: PermissionMode.optional(),
  model: z.string().optional(),
  // The agent backend for THIS dispatch (Codex-support epic, Phase 3). Omitted ⇒ the dispatcher
  // defaults to "claude", keeping the legacy RPC path byte-identical. The router forwards it into
  // `dispatch(input, { backend })`; the model picker sets it from the chosen model's family.
  backend: Backend.optional(),
  effort: Settings.shape.effort,
})
export type DispatchInput = z.infer<typeof DispatchInput>

export const ADOPT_THREAD_MESSAGE_MAX_CHARS = 64 * 1024
export const AdoptThreadInput = z.object({
  slug: ThreadSlug,
  message: z.string().max(ADOPT_THREAD_MESSAGE_MAX_CHARS).optional(),
}).strict()
export type AdoptThreadInput = z.infer<typeof AdoptThreadInput>
export const AdoptThreadResult = z.object({ slug: ThreadSlug, sessionId: z.string().min(1) }).strict()
export type AdoptThreadResult = z.infer<typeof AdoptThreadResult>

// Take over one of the human's OWN terminals — a session listed in the rail's External band. The id
// is the one the board row carries, which for a foreign thread IS its session id. `title` is the name
// the row already displays, passed through so the adopted thread keeps the name the human just read
// rather than being re-derived from a transcript the server would have to re-open.
export const AdoptSessionInput = z.object({
  sessionId: ThreadSlug, // a bare session uuid — the same contract every other thread id satisfies
  backend: z.enum(["claude", "codex"]),
  title: z.string().max(200).optional(),
}).strict()
export type AdoptSessionInput = z.infer<typeof AdoptSessionInput>

export const FollowUpInput = z.object({
  slug: ThreadSlug,
  // Binds the call to the session the tab is looking at, so a stale page cannot deliver a follow-up
  // into a thread that has since been re-dispatched (merged from origin/main, 2026-07-21).
  sessionId: z.string().min(1),
  message: z.string().min(1),
  // Generated once before the optimistic clear so a transport replay can be idempotent.
  deliveryId: z.string().min(1).max(200).optional(),
  // Retire the worker's live process before delivering, so this message lands in a `claude` that has
  // just started. The operator's "Restart worker" verb — the ONLY caller that sets it — exists because
  // a worker inherits its plugin/hooks AND its system prompt at process start and can never pick up a
  // newer frizz build in place (hooks are read once, at startup). Everything else that needs a fresh
  // process derives it server-side; see needsFreshProcessForLimit.
  freshProcess: z.boolean().optional(),
  // PREEMPT the operation the worker is running right now, so this message is read at once instead of
  // when that operation finishes. The operator's "Interrupt and send" verb, and opt-in for the same
  // reason `freshProcess` is: it costs the in-flight tool call's result and the worker's in-memory
  // sub-agents.
  //
  // It exists because delivery is ALREADY as fast as queueing can be. Measured over 14 days of this
  // project's own transcripts, Claude Code drains its queue at the first sampling boundary that
  // exists; the wait an operator feels is the remaining time of whatever was in flight (a long `Bash`,
  // or one 73–133s reasoning+answer generation), which put mid-turn operator prose at p50 13.8s,
  // p90 49s, p99 2.5m. Preempting is the only lever left.
  //
  // Broker-backed Claude only — that is every Claude thread dispatched since the broker cutover. On
  // any other runtime the message is delivered normally and this is ignored, never refused: a send
  // that arrives is always better than a send that errors.
  interrupt: z.boolean().optional(),
})
export type FollowUpInput = z.infer<typeof FollowUpInput>

// Take a follow-up back out of the provider's queue — the operator clicked their own queued bubble to
// unqueue it and get the text back in the prompt box. Keyed by the same `deliveryId` the send carried,
// which IS the uuid the provider queued the message under.
export const UnqueueFollowUpInput = z.object({
  slug: ThreadSlug,
  // Same staleness guard as followUp: a stale tab must not unqueue against a re-dispatched session.
  sessionId: z.string().min(1),
  deliveryId: z.string().min(1).max(200),
}).strict()
export type UnqueueFollowUpInput = z.infer<typeof UnqueueFollowUpInput>
// `unqueued:false` is a real, expected outcome, NOT an error: the message had already been dequeued for
// execution. It is reported rather than thrown precisely because the operator must be able to tell
// "I took it back" from "it's already on its way" — `reason` is what the surface shows them.
export const UnqueueFollowUpResult = z.object({
  unqueued: z.boolean(),
  reason: z.string().optional(),
}).strict()
export type UnqueueFollowUpResult = z.infer<typeof UnqueueFollowUpResult>

// PUSH IT THROUGH NOW — the ↑ on a queued bubble. Carries no message, because there is nothing left to
// send: the words are already sitting in the provider's queue, and the only thing between the agent and
// them is the turn it is currently running. So this is the interrupt half of followUp's `interrupt`
// flag, on its own. Same order-is-the-contract (deliver, THEN interrupt) — here the delivery happened
// whenever the operator hit Enter, which is precisely why the decision no longer has to be made at send
// time the way the composer's old ⚡ demanded.
//
// It preempts the TURN, not one message: the SDK opens the next turn on everything queued, so with
// several bubbles waiting this delivers all of them, in order. The button's copy says so.
export const DeliverQueuedNowInput = z.object({
  slug: ThreadSlug,
  // Same staleness guard as unqueueFollowUp: a stale tab must not preempt a re-dispatched session.
  sessionId: z.string().min(1),
}).strict()
export type DeliverQueuedNowInput = z.infer<typeof DeliverQueuedNowInput>
// `interrupted:false` is an expected outcome, NOT an error: there was no live turn to preempt (the
// daemon is gone, or the agent is already resting), and the queued message is read the ordinary way.
// Reported rather than thrown so the surface can say which happened — the same truthfulness rule
// UnqueueFollowUpResult is built on.
export const DeliverQueuedNowResult = z.object({
  interrupted: z.boolean(),
  reason: z.string().optional(),
}).strict()
export type DeliverQueuedNowResult = z.infer<typeof DeliverQueuedNowResult>

export const SetThreadSnoozeInput = z.object({
  slug: ThreadSlug,
  sessionId: z.string().min(1),
  // null is the explicit "wake now"/cancel operation; presets and custom local input send UTC.
  until: SnoozeUntil.nullable(),
  // Optional scheduled follow-up. Omitted/null ⇒ a plain reminder snooze; a prompt ⇒ the thread is
  // automatically bumped with it at `until`. Always cleared together with the instant, so a wake-now
  // can never leave an armed prompt behind.
  prompt: SnoozePrompt.nullable().optional(),
}).strict()
export type SetThreadSnoozeInput = z.infer<typeof SetThreadSnoozeInput>

// Pin/unpin a thread out of the rail's band system (the pinned band at the very top of the rail).
// Session-guarded like the snooze: the verb lives on a row a stale tab may still be showing.
export const SetThreadPinnedInput = z.object({
  slug: ThreadSlug,
  sessionId: z.string().min(1),
  pinned: z.boolean(),
}).strict()
export type SetThreadPinnedInput = z.infer<typeof SetThreadPinnedInput>

// The recurring prompt's OPERATOR half — the footer popover, arming and disarming in ONE call. The
// text, the two triggers and the cadence are all views of one row, and splitting them into separate
// mutations would let a tab holding only some of them clobber the rest on save.
//
// Session-guarded like every other browser write: a tab looking at a thread that has since been
// re-dispatched fails closed rather than arming whatever now owns the slug.
//
// `prompt: null` clears the row entirely. A prompt with both triggers false keeps the text and the
// cadence parked and silent — that IS the off state, and it is why there is no `enabled` field.
// `intervalSeconds` is required when `heartbeat` is true, because a schedule nobody chose is exactly
// the ambiguity the minutes field exists to remove.
export const SetThreadRecurringPromptInput = z.object({
  slug: ThreadSlug,
  sessionId: z.string().min(1),
  prompt: RecurringPromptText.nullable(),
  stopHook: z.boolean(),
  heartbeat: z.boolean(),
  // The POST-COMPACTION trigger (scheduler SOURCE 7, added 2026-08-06). Defaulted rather than required
  // so a client that predates it — an older tab, an older MCP server — keeps writing the row correctly
  // with the trigger off, which is the honest reading of a caller that has never heard of it.
  postCompaction: z.boolean().default(false),
  intervalSeconds: RecurringIntervalSeconds.optional(),
}).strict()
// z.input, not z.infer: `postCompaction` is `.default(false)`, so the parsed OUTPUT has it
// required while the wire INPUT does not — and rpc-contract.ts compares the client type against
// z.input. Inferring the output here is what made the drift gate fire.
export type SetThreadRecurringPromptInput = z.input<typeof SetThreadRecurringPromptInput>

// The WORKER half, through `mcp__frizz__goal` (which POSTs the same `/rpc/*` surface the
// board uses). A worker has no other way to keep a long effort moving — Claude Code's own in-session
// schedulers cannot fire in the runtime frizz spawns — so this is the counterpart to the operator's
// control above, writing the same row.
//
// Deliberately NOT session-guarded, unlike the operator's input: the MCP server is spawned with its
// thread's slug and keeps it across a resume, while the session id and generation bump underneath it.
// A guard here would fail on exactly the long-lived thread this exists for. The slug is stamped into
// that server's env by frizz, not supplied by the model.
//
// There is deliberately no thread parameter a model could aim elsewhere: a worker may only ever arm its
// OWN thread. One agent making a DIFFERENT thread loop forever is not a capability frizz hands out.
//
// `prompt: null` is the explicit stop, which is how a worker ends its own loop deliberately rather than
// by falling back on the ALLDONE sentinel.
export const SetOwnThreadRecurringPromptInput = z.object({
  slug: ThreadSlug,
  prompt: RecurringPromptText.nullable(),
  stopHook: z.boolean(),
  heartbeat: z.boolean(),
  // The POST-COMPACTION trigger (scheduler SOURCE 7, added 2026-08-06). Defaulted rather than required
  // so a client that predates it — an older tab, an older MCP server — keeps writing the row correctly
  // with the trigger off, which is the honest reading of a caller that has never heard of it.
  postCompaction: z.boolean().default(false),
  /** ACCEPTED AND IGNORED. The question hold was deleted 2026-08-16 (see scheduler.ts) and no caller in
   *  this repo sends it any more — but this object is `.strict()`, and the caller on the other end is a
   *  DETACHED worker daemon holding the `frizz-mcp.mjs` it was spawned with. Those outlive a server
   *  restart by design, so for as long as any pre-2026-08-16 worker is alive a `start` would otherwise
   *  come back as a validation error on a field the model cannot see it is sending. Tolerated here rather
   *  than in the router so the shape stays one declaration; delete it once no such worker can be running.
   *  The BROWSER input above needs no such clause — a stale tab is one reload away. */
  pauseOnQuestions: z.boolean().optional(),
  intervalSeconds: RecurringIntervalSeconds.optional(),
}).strict()
// z.input, not z.infer: `postCompaction` is `.default(false)`, so the parsed OUTPUT has it
// required while the wire INPUT does not — and rpc-contract.ts compares the client type against
// z.input. Inferring the output here is what made the drift gate fire.
export type SetOwnThreadRecurringPromptInput = z.input<typeof SetOwnThreadRecurringPromptInput>

// What the write ANSWERS with: the row it just overwrote. A `start` REPLACES whatever the thread held —
// including text the HUMAN edited in the footer panel — and the writer could not previously see what it
// destroyed. Returning the superseded row lets the tool say so in the same breath, so a blind overwrite
// is at least a REPORTED one. `null` when the thread held nothing.
export const SetOwnThreadRecurringPromptResult = z.object({
  replaced: ThreadRecurringPrompt.nullable(),
}).strict()
export type SetOwnThreadRecurringPromptResult = z.infer<typeof SetOwnThreadRecurringPromptResult>

// The READ half, from `mcp__frizz__goal` with `action: "get"`. Without it a worker can only
// write: it cannot tell whether it is armed at all, what text it armed before its context was compacted
// away, or whether the human has since edited it in the footer. Same caller rules as the write above —
// keyed on the slug alone, and no thread parameter a model could aim at anyone else's row.
export const GetOwnThreadRecurringPromptInput = z.object({
  slug: ThreadSlug,
}).strict()
export type GetOwnThreadRecurringPromptInput = z.infer<typeof GetOwnThreadRecurringPromptInput>

// `null` — rather than an omitted field — because "nothing is armed" is the answer a worker most needs
// to be able to tell apart from "this server is too old to know", which arrives as an HTTP 404 instead.
export const OwnThreadRecurringPromptResult = z.object({
  recurringPrompt: ThreadRecurringPrompt.nullable(),
}).strict()
export type OwnThreadRecurringPromptResult = z.infer<typeof OwnThreadRecurringPromptResult>

// ---- THE ONE-OFF TIMER's three worker procedures -------------------------------------------------
// Same caller and therefore the same rules as the recurring prompt above: no session guard (the MCP
// server outlives the session ids underneath it), and no thread parameter a model could aim elsewhere.
//
// `fireAt` is an exact UTC instant, resolved by the TOOL from whichever of "in N seconds" / "at this
// instant" the worker gave it — one representation reaches the server, so the row, the trailer and the
// scheduler all name the same string.
export const SetOwnThreadTimerInput = z.object({
  slug: ThreadSlug,
  prompt: TimerPromptText,
  fireAt: SnoozeUntil,
}).strict()
export type SetOwnThreadTimerInput = z.infer<typeof SetOwnThreadTimerInput>

export const CancelOwnThreadTimerInput = z.object({
  slug: ThreadSlug,
  id: z.string().min(1).max(64),
}).strict()
export type CancelOwnThreadTimerInput = z.infer<typeof CancelOwnThreadTimerInput>

export const ListOwnThreadTimersInput = z.object({
  slug: ThreadSlug,
}).strict()
export type ListOwnThreadTimersInput = z.infer<typeof ListOwnThreadTimersInput>

// Every one of the three answers with the thread's CURRENT armed set, so a worker never has to make a
// second call to see what it now holds — and so a `set` that lands while an earlier timer is still armed
// shows both.
export const OwnThreadTimersResult = z.object({
  timers: z.array(ThreadTimerView),
}).strict()
export type OwnThreadTimersResult = z.infer<typeof OwnThreadTimersResult>

// ---- THE ACTIVITY READOUT -------------------------------------------------------------------------
// EVERY kind of background work a thread has out, with the id the awaiting fence names it by, in ONE
// call. The fence is structural — it references things by id — so a worker that has lost its ids (a
// compaction, a long turn, a wake it did not expect) cannot write a correct fence at all. This is how it
// gets them back, and it is the same list the sign-off nudge prints, so the two can never disagree.
export const ThreadActivityItem = z.object({
  kind: z.enum(["shell", "agent", "timer", "pr"]),
  /** The string a `<kind>:` fence line must carry. For a shell that is the runtime task id the worker
   *  was shown; for a PR, `owner/repo#N`; for a timer, its `tmr_…` row id. */
  id: z.string(),
  label: z.string(),
  /** ISO8601 of when it started or was armed — absent when frizz has no instant for it. */
  since: z.string().optional(),
  /** A timer's fire instant, or a PR's expiry. Absent for shells and sub-agents. */
  until: z.string().optional(),
  /** The `wch_…` id of the REGISTERED WATCH holding this item, when the worker armed one — so a readout
   *  that exists to hand ids back also hands back the one `unwatch` takes. A separate ROW per watch was
   *  the alternative and it would list the same shell twice, which is exactly the duplication that put
   *  two sub-agents under a "Background shells" heading. */
  watchId: z.string().optional(),
}).strict()
export type ThreadActivityItem = z.infer<typeof ThreadActivityItem>

export const ListOwnThreadActivityInput = z.object({
  slug: ThreadSlug,
}).strict()
export type ListOwnThreadActivityInput = z.infer<typeof ListOwnThreadActivityInput>

export const OwnThreadActivityResult = z.object({
  activity: z.array(ThreadActivityItem),
  /** Every question still owed an answer. NOT a `ThreadActivityItem` and deliberately its own list: a
   *  question is not running work, it waits on a PERSON, and there is no `questions:` key in the awaiting
   *  fence for it to be written into. Until 2026-08-28 a worker could read its open questions back only
   *  as a side effect of `ask` (which registers another) or `unask` (which withdraws one) — so the ids
   *  that block `done` were readable only by mutating something (maintainer: "Is there a way for the
   *  agent to read out the current set of watchers and questions?"). */
  questions: z.array(RegisteredQuestionView).default([]),
}).strict()
export type OwnThreadActivityResult = z.infer<typeof OwnThreadActivityResult>

export const SetOwnThreadTimerResult = z.object({
  id: z.string(),
  fireAt: z.string(),
  timers: z.array(ThreadTimerView),
}).strict()
export type SetOwnThreadTimerResult = z.infer<typeof SetOwnThreadTimerResult>

export const CancelOwnThreadTimerResult = z.object({
  cancelled: z.boolean(),
  timers: z.array(ThreadTimerView),
}).strict()
export type CancelOwnThreadTimerResult = z.infer<typeof CancelOwnThreadTimerResult>

// ---- The SUPERSEDED worker shapes, kept alive for MCP servers already in flight -----------------
//
// A worker's `frizz-mcp.mjs` is spawned ONCE, out of the promoted build its session was dispatched with,
// and it lives as long as that session — across every frizz server restart. The server meanwhile gets
// restarted from newer source whenever the operator promotes a build. So `/rpc` is a VERSIONED CONTRACT
// between two processes that update INDEPENDENTLY, and renaming a procedure a worker's MCP server calls
// strands every session already running.
//
// Not hypothetical: merging the old `stop_hook` and `heartbeat` tools into one `recurring_prompt` renamed
// this procedure, and every worker holding an older MCP server started getting a bare HTTP 404 for its
// only means of keeping a long effort moving. The two shapes below are what those builds actually send;
// the router folds them onto the merged row above. Retire them only once no build that sends them can
// still be running — the cost of keeping them is two thin aliases, the cost of dropping them early is a
// live worker silently losing a capability mid-effort.
//
// The trigger each one owns is fixed: the stop hook was the ON-REST feature.
export const SetOwnThreadStopHookInput = z.object({
  slug: ThreadSlug,
  prompt: RecurringPromptText.nullable(),
  enabled: z.boolean(),
}).strict()
export type SetOwnThreadStopHookInput = z.infer<typeof SetOwnThreadStopHookInput>

// The heartbeat was the ON-SCHEDULE feature. This covers BOTH of its generations: the older one (posted
// as `setThreadHeartbeat`) carried no `enabled` field and signalled its stop with `prompt: null` alone,
// which is why `enabled` is optional here rather than required.
export const SetOwnThreadHeartbeatInput = z.object({
  slug: ThreadSlug,
  prompt: RecurringPromptText.nullable(),
  intervalSeconds: RecurringIntervalSeconds.optional(),
  enabled: z.boolean().optional(),
}).strict()
export type SetOwnThreadHeartbeatInput = z.infer<typeof SetOwnThreadHeartbeatInput>

// What an in-place plugin reload changed, as the board reports it. Counts answer "did my edit land?";
// `mcpServers` carries NAMES because a reload that changes MCP tools is the one with a real cost — the
// provider re-reads the whole conversation instead of using its prompt cache.
export const ThreadPluginReloadResult = z.object({
  plugins: z.number().int().min(0),
  commands: z.number().int().min(0),
  agents: z.number().int().min(0),
  mcpServers: z.array(z.string()),
  errorCount: z.number().int().min(0),
}).strict()
export type ThreadPluginReloadResult = z.infer<typeof ThreadPluginReloadResult>

// A human-authored display title for a registered session. Trimming happens at the RPC boundary so
// storage never has to distinguish whitespace-only names from real intent; the web input mirrors the
// same cap. This is metadata-only and therefore works identically for Claude and Codex sessions.
export const RenameThreadInput = z.object({
  slug: ThreadSlug,
  title: z.string().trim().min(1).max(200),
})
export type RenameThreadInput = z.infer<typeof RenameThreadInput>

// Claude-only native title generation. The server submits Claude Code's exact `/rename` command,
// observes the resulting custom-title transcript record, and returns the title it durably saved.
// Codex intentionally has no analog: its thread header exposes the manual metadata rename only.
export const AiRenameThreadInput = z.object({ slug: ThreadSlug })
export type AiRenameThreadInput = z.infer<typeof AiRenameThreadInput>
export const AiRenameThreadResult = z.object({ title: z.string().min(1).max(200) })
export type AiRenameThreadResult = z.infer<typeof AiRenameThreadResult>

// THE WORKER NAMING ITS OWN THREAD, from `mcp__frizz__title`. Both backends get a name automatically at
// spawn — Claude from the provider's own titler, Codex from the first-line `<!-- frizz title="…" -->`
// marker — and both are minted from the raw dispatch prompt before the worker has read a single line of
// the repo, so they can only ever paraphrase what the operator typed. That is how a zod thread came out
// named "Zon4.5 features and z.properties documentation audit": the titler copied the operator's typo
// verbatim, because at that instant nothing in the session knew the product is called Zod.
//
// This is the SECOND, considered pass: the worker registers a real name once it understands the task.
//
// Unlike RenameThreadInput it never LOCKS the row — the name is machine-authored, so a human rename
// still outranks it. Unguarded on session/generation for `SetOwnThreadRecurringPromptInput`'s reasons:
// the MCP server knows only the slug frizz stamped into its env, and a model chooses the TEXT, never
// the thread.
export const SetOwnThreadTitleInput = z.object({
  slug: ThreadSlug,
  title: z.string().trim().min(1).max(200),
}).strict()
export type SetOwnThreadTitleInput = z.infer<typeof SetOwnThreadTitleInput>

// What the write answers with: whether it landed, and the name the thread carries NOW. A refusal is not
// an error — a human who has renamed the thread owns its name — so it comes back as a flag the tool can
// explain rather than a throw the model will retry.
export const SetOwnThreadTitleResult = z.object({
  accepted: z.boolean(),
  title: z.string(),
  lockedByHuman: z.boolean(),
}).strict()
export type SetOwnThreadTitleResult = z.infer<typeof SetOwnThreadTitleResult>

export const SetThreadPermissionInput = z.object({
  slug: ThreadSlug,
  permissionMode: PermissionMode,
})
export type SetThreadPermissionInput = z.infer<typeof SetThreadPermissionInput>

export const SetThreadPermissionResult = z.object({
  // "next-turn" is the Codex mid-turn answer: `thread/settings/update` ACCEPTS a sandbox change while a
  // turn is running, but the running turn keeps the policy it started with (verified live — a turn that
  // attempted a write after the flip to danger-full-access was still refused). So the change is real and
  // durable, yet it does not reach work already executing. Distinct from "next-resume", which means
  // nothing was applied to the live session at all.
  //
  // It is ALSO the Claude answer, arrived at from the opposite direction: a permission mode is a LAUNCH
  // flag there, so frizz retires the idle worker process and the next turn cold-resumes under the new
  // one (router `setThreadPermission`). Same promise to the operator — stored, and true from the next
  // turn on — reached by restarting rather than by retuning.
  effect: z.enum(["applied", "next-turn", "next-resume"]),
})
export type SetThreadPermissionResult = z.infer<typeof SetThreadPermissionResult>

export const ThreadProfileOptionsInput = z.object({ slug: ThreadSlug }).strict()
export type ThreadProfileOptionsInput = z.infer<typeof ThreadProfileOptionsInput>
export const ThreadProfileOptionsResult = z.object({
  backend: Backend,
  options: z.array(ThreadProfileOption),
})
export type ThreadProfileOptionsResult = z.infer<typeof ThreadProfileOptionsResult>

// The thread's invocable skills, for the composer's `/` typeahead. Always the HARNESS's own list —
// Claude's `supportedCommands()` through the broker, Codex's `skills/list` through the app-server —
// never a frizz-side scan of skill directories, which could only drift from what the session actually
// loaded. `description` may be empty (Claude's init-frame names carry no descriptions for entries the
// command list omits).
//
// `source` is where the harness resolved the skill FROM, normalized to one vocabulary so the typeahead
// renders "project" the same whether Claude called it `projectSettings` or Codex called it `repo`. It
// is OPTIONAL, and deliberately so: the promise is "show it if we know it", and a harness that reports
// a scope frizz has no mapping for must degrade to an unlabelled row rather than to a wrong label.
export const ThreadSkillSource = z.enum(["project", "user", "builtin", "plugin"])
export type ThreadSkillSource = z.infer<typeof ThreadSkillSource>
export const ThreadSkill = z.object({
  name: z.string().min(1).max(512),
  description: z.string().max(1024),
  source: ThreadSkillSource.optional(),
}).strict()
export type ThreadSkill = z.infer<typeof ThreadSkill>

export const ThreadSkillsInput = z.object({ slug: ThreadSlug }).strict()
export type ThreadSkillsInput = z.infer<typeof ThreadSkillsInput>
export const ThreadSkillsResult = z.object({ skills: z.array(ThreadSkill).max(1024) }).strict()
export type ThreadSkillsResult = z.infer<typeof ThreadSkillsResult>

export const SetThreadProfileInput = z.object({
  slug: ThreadSlug,
  model: z.string().trim().min(1).max(200),
  effort: z.string().trim().min(1).max(100),
}).strict()
export type SetThreadProfileInput = z.infer<typeof SetThreadProfileInput>
export const SetThreadProfileResult = z.object({
  effect: z.enum(["applied", "next-resume"]),
})
export type SetThreadProfileResult = z.infer<typeof SetThreadProfileResult>

// ---- DISPATCH TASK BANNER (composer ↔ transcript) -------------------------------------------------
// The loud fence frizz puts between its own dispatch orientation and the human operator's prompt. It is
// BOTH the worker's system→human handoff cue and the transcript's display boundary, so it lives here,
// next to the other exact presentation markers, rather than in either consumer.
//
// The rule the banner buys is: NOTHING of frizz's sits below it. Everything the worker needs to be told
// about the framing goes ABOVE — below the banner is the operator's prompt, byte for byte, and the
// first user bubble shows exactly that. (Until 2026-07-26 an explanation line and a bare `TASK:` marker
// sat between the banner and the prompt; that marker was the display cut, which is why the retired
// envelope is still recognized in transcript.ts.)
export const DISPATCH_TASK_BANNER = [
  "===============================================================",
  "======================    YOUR TASK    ========================",
  "===============================================================",
].join("\n")

// The exact cut: the banner on its own lines, followed by one blank line, then the prompt. Requiring
// the surrounding newlines keeps a banner quoted inside prose from being read as the boundary.
export const DISPATCH_TASK_BANNER_MARKER = `\n${DISPATCH_TASK_BANNER}\n\n`

// ---- GitHub-first batch dispatch (server ↔ web mirror; wrapper in server/github.ts) ----

// Exact, versioned presentation boundary in a GitHub batch-dispatch prompt. The worker receives the
// whole prompt; transcript normalization exposes only the generated lead above this line as
// `displayText`. Namespacing + versioning make an ordinary HTML comment or markdown example inert.
export const GITHUB_DISPATCH_UI_BOUNDARY = "<!-- frizz:github-dispatch-ui-boundary:v1 -->"

// ---- WAKE-DELIVERY TOKEN (scheduler ↔ transcript) ------------------------------------------------
// The scheduler appends this to every wake it delivers so the worker's own next user record proves the
// delivery landed (the outbox ack is `lastUserText.includes(wakeDeliveryToken(id))`) — which is exactly
// why the token must stay in the STORED text and can only ever be projected out for display.
//
// PRODUCER AND STRIPPER LIVE TOGETHER ON PURPOSE. The delivered message is recorded as an ordinary user
// turn, and the chat renders user text VERBATIM (a pre-wrap bubble, not markdown), so an unstripped
// token is shown to the human as literal `<!-- frizz-wake:… -->`. A format change on one side without the
// other silently brings that back; keeping the pair adjacent is the guard.
// WHAT TIME IT IS, AND HOW LONG YOU HAVE BEEN GONE — because a broker-run worker is told neither.
//
// Measured 2026-08-19 on `read-the-file-read-up` (`claude_runtime = broker`, as 181 of that project's 338
// sessions are): its transcript contains ZERO system-reminders and ZERO date injections across its whole
// life. The runtime's env block does not reach a broker daemon, so these workers have no idea what day it
// is, let alone how long they have been parked.
//
// That is the root of arbitrary `for:` values. A worker writing `for: 1h` is not estimating badly — it
// has no clock to estimate against, and no way to notice that its last four parks each lasted four
// minutes. ELAPSED is the number that teaches it: "you last spoke 3h 12m ago" is the feedback that makes
// the next `for:` an actual judgement.
//
// Frizz cannot fix the runtime's env block, but every wake IT sends lands in the worker's context, so
// this rides along on all of them — one line, at the point every delivery passes through.
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "an unknown time"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`
}

/** One line of wall clock, prepended to every frizz delivery. Local time, because that is the clock the
 *  human reading the transcript is on. `lastAssistantAt` absent ⇒ the elapsed clause is dropped rather
 *  than guessed. */
export function wakeTimeHeader(nowMs: number, lastAssistantAt?: string | null): string {
  const d = new Date(nowMs)
  const p2 = (n: number) => String(n).padStart(2, "0")
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
  const since = lastAssistantAt ? Date.parse(lastAssistantAt) : NaN
  const elapsed = Number.isFinite(since) && nowMs >= since ? ` — you last spoke ${formatElapsed(nowMs - since)} ago` : ""
  return `⏱ ${stamp}${elapsed}.`
}

// PRODUCER AND STRIPPER LIVE TOGETHER, the same pairing (and the same reason) as the human-gap note
// below: the line above is written FOR THE WORKER — it has no clock of its own — and it rides on a
// message the transcript then shows to a human, who has one. Rendered it is pure noise at the foot of
// every wake card, and on the one wake that is the human's OWN words (an answer to a registered
// question) it is worse than noise: the answers parser reads a trailing line as a continuation of the
// last answer, so frizz's clock printed INSIDE the chip holding what the human chose. That exact defect
// was reported for the gap note on 2026-08-25 ("the freaking time stamps are still showing up in my
// question answers") and this is the same line arriving by the other door.
//
// Anchored to end-of-text on a line of its own and matched down to the wall clock, so prose that merely
// quotes one — a bug report pasting the line — stays in the bubble. Stripping is a DISPLAY projection
// only: the stored text keeps the stamp, which is the whole point of sending it.
const WAKE_TIME_HEADER_TAIL = /\n+⏱ \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: — you last spoke [^\n]*? ago)?\.[ \t]*$/

/** Display projection: a frizz wake without the clock line frizz appended for the worker. */
export function stripWakeTimeHeader(text: string): string {
  return text.replace(WAKE_TIME_HEADER_TAIL, "")
}

// The trailers frizz writes for the WORKER at the end of a wake it composed, declared with their
// producers above. Every one of them is a sentence about a registration the reader does not hold and a
// tool the reader cannot call.
//
// THE TIMER'S TRAILER IS DELIBERATELY NOT HERE. `parseTimerWake` matches ON it — a fired one-off is the
// worker's own arbitrary prose, and that parenthetical is the only anchor saying which timer this was —
// so stripping it upstream would cost the divider it is there to draw. It comes off in the parser
// instead, which is the same outcome by the other route.
const WAKE_TRAILERS = [PR_WATCH_ARMED_TRAILER, PR_WATCH_SPENT_TRAILER, SHELL_DONE_TRAILER]

/** Display projection: a frizz wake without the agent-facing trailer frizz appended for the worker.
 *
 *  Anchored to END-OF-TEXT, after the clock line and the delivery token have already come off (see
 *  `userDisplayText`, which composes the three in that order — the order they were appended in). Exact
 *  strings, never a shape: a paragraph that merely LOOKS like a trailer — a worker quoting one back, a
 *  human pasting one into a bug report — keeps it, and only the bytes frizz itself wrote are dropped. */
export function stripWakeTrailer(text: string): string {
  for (const trailer of WAKE_TRAILERS) {
    const at = text.lastIndexOf(trailer)
    if (at < 0 || text.slice(at + trailer.length).trim() !== "") continue
    const head = text.slice(0, at).trimEnd()
    // A wake whose whole body IS the trailer keeps it. Nothing composes one today, but showing an empty
    // bubble is a worse failure than showing the boilerplate, and it is one line to make impossible.
    return head === "" ? text : head
  }
  return text
}

/** The gap the HUMAN left before replying, as a line frizz appends to their message.
 *
 *  A worker has no clock of its own (a broker-run one is told neither the date nor the time by its
 *  runtime), so an answer arriving after four hours is indistinguishable from one arriving after four
 *  seconds. That matters for more than tone: a worker resuming on a stale premise will happily re-run a
 *  build whose result has since gone cold, or re-park on a shell that finished while nobody was reading.
 *
 *  Below the floor it returns undefined — a live back-and-forth needs no stamp on every turn, and a note
 *  on each one is noise that teaches nothing.
 *
 *  ATTRIBUTED, because the message it rides on is the human's and this line is not. Frizz names itself
 *  here for the same reason SIGNOFF_NUDGE_MARKER does. */
export const HUMAN_GAP_FLOOR_MS = 20 * 60_000

export function humanGapNote(nowMs: number, lastAssistantAt?: string | null): string | undefined {
  const since = lastAssistantAt ? Date.parse(lastAssistantAt) : NaN
  if (!Number.isFinite(since) || nowMs - since < HUMAN_GAP_FLOOR_MS) return undefined
  const d = new Date(nowMs)
  const p2 = (n: number) => String(n).padStart(2, "0")
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
  return `⏱ Frizz: the message above arrived ${formatElapsed(nowMs - since)} after your last one. It is now ${stamp}.`
}

// PRODUCER AND STRIPPER LIVE TOGETHER, for the reason the wake token's pair does — except this one is
// worse if it drifts, because the text it rides on is the HUMAN'S OWN. The router appends the note only
// to the copy handed to the worker and leaves the bubble and the delivery ledger untouched; but the chat
// does not read either of those. It reads the worker's TRANSCRIPT, where the note is simply part of the
// user record — so it rendered inside the operator's own right-justified bubble, over their own words,
// as if they had typed it (reported 2026-08-20: "can we make these invisible? they're showing up in my
// own user messages"). Stripping it is a DISPLAY projection only: the stored text keeps the note, which
// is the whole point of sending it.
//
// Anchored to end-of-text on a line of its own, and required to match the note's FULL shape down to the
// wall clock, so a message that merely quotes one — a bug report pasting the line, this comment's own
// wording — is left in the bubble intact. The round-trip test over humanGapNote is what keeps a wording
// change on the producer from silently putting the note back in front of the human.
const HUMAN_GAP_NOTE_TAIL = /\n+⏱ Frizz: the message above arrived [^\n]* after your last one\. It is now \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.[ \t]*$/

/** Display projection: the human's message without the clock note frizz appended for the worker. */
export function stripHumanGapNote(text: string): string {
  return text.replace(HUMAN_GAP_NOTE_TAIL, "")
}

export function wakeDeliveryToken(id: string): string {
  return `<!-- frizz-wake:${id} -->`
}

// Anchored to end-of-text with its leading blank line, matching how context.ts appends it. Requiring
// that trailing position (rather than matching anywhere) keeps prose that merely quotes the token —
// this comment's own wording, a bug report pasting one — intact in the bubble.
const WAKE_DELIVERY_TOKEN_TAIL = /\n*<!-- frizz-wake:[A-Za-z0-9_-]+ -->\s*$/

// The token wherever it sits ON A LINE OF ITS OWN. That is how the scheduler always writes it, and it
// is never how prose quotes one — a human asking "why is <!-- frizz-wake:… --> in my bubble?" writes it
// mid-sentence, which this deliberately leaves alone (see the transcript test of exactly that).
//
// The tail anchor above is the RULE; this is the BACKSTOP. The tail is only correct while one record
// holds one delivery, and the runtime breaks that whenever two land while the worker is mid-turn
// (splitWakeDeliveries, below). Splitting restores the anchor — but the split has to model how the
// runtime joins, and that is not frizz's format to pin. So the display strip refuses to depend on it:
// a token on its own line is machine plumbing wherever it ended up, and no shape the runtime invents
// next can put one in front of the human again.
const WAKE_DELIVERY_TOKEN_LINE = /(?:^|\n)[ \t]*<!-- frizz-wake:[A-Za-z0-9_-]+ -->[ \t]*(?=\n|$)/g

// Display projection: the steer the human is meant to read, without the machine-facing token.
export function stripWakeDeliveryToken(text: string): string {
  const out = text.replace(WAKE_DELIVERY_TOKEN_LINE, "")
  // The blank line the token sat behind is its punctuation, not the message's — a token that LED the
  // text leaves one at the top, one that closed it leaves one at the bottom. Both go with it, and only
  // when something was actually removed, so an ordinary message with trailing whitespace does not
  // acquire a display projection (userDisplayText treats "changed" as "worth sending to the client").
  return out === text ? text.replace(WAKE_DELIVERY_TOKEN_TAIL, "") : out.replace(/^\n+/, "").replace(/\s+$/, "")
}

// Was this user turn WRITTEN BY FRIZZ rather than by the human? The token rides only on a scheduler
// delivery, so its presence is the one unambiguous tell — and it matters for presentation: a wake
// rendered in the human's own off-white right-justified bubble claims the operator typed it, when in
// fact frizz is reporting something it noticed. The chat renders these as a first-party card instead.
export function isWakeDelivery(text: string): boolean {
  return WAKE_DELIVERY_TOKEN_TAIL.test(text)
}

// A COALESCED delivery: several outbox messages merged by the runtime into ONE user record.
//
// Everything above assumes one record carries one delivery — the token is anchored to the END, and both
// the display strip and every downstream parse (the recurring-prompt trailer, the GitHub steer) read
// from there. That assumption breaks whenever two deliveries land while the worker is mid-turn: the
// runtime hands the model one user message holding both, joined by a newline, each still carrying its
// own token. The record then ends in a token — so `isWakeDelivery` says yes and the strip takes the
// LAST one — while the first delivery's own token and trailer are stranded in the middle, where no
// anchored parse can see them. That is exactly how a recurring prompt lost its `Recurring prompt · at
// rest` divider and rendered instead as a generic bell card with the whole run of deliveries inside it,
// interior `<!-- frizz-wake:… -->` and all (measured: 14 of 380 real deliveries on this machine).
//
// So cut the record back into the deliveries the scheduler actually sent, and let each one be projected
// on its own. A boundary is a token line WITH MORE CONTENT AFTER IT — the token ends a delivery, so
// anything below it came from the next one. Deliberately not keyed on the runtime's joiner (measured
// today as a single "\n"): that is its format, not frizz's, and a fix that hard-codes it silently stops
// working the day it changes. Whitespace between segments is dropped with the join.
/** One user record → the deliveries it carries, each ending in its own token. `[text]` when it carries
 *  a single delivery (or none), so every caller can treat the split as the general case. */
export function splitWakeDeliveries(text: string): string[] {
  const out: string[] = []
  let start = 0
  for (const m of text.matchAll(WAKE_DELIVERY_TOKEN_LINE)) {
    const end = m.index + m[0].length
    if (!text.slice(end).trim()) break // the LAST token — it closes the record, so nothing follows it
    out.push(text.slice(start, end))
    start = end
  }
  if (out.length === 0) return [text]
  const rest = text.slice(start).replace(/^\s*\n/, "")
  if (rest.trim()) out.push(rest)
  return out
}

// ---- harness plumbing that arrives dressed as a user turn -----------------------------------------
// A user record that is not the human speaking: a task-notification from a background child, a bare
// system-reminder wrapper, a frizz orchestrator pulse. Matched on the LEADING tag so a human message
// that merely QUOTES one of these somewhere inside still counts as the human.
//
// THIS IS THE SHARED CLASSIFIER, and it is shared for a reason. It used to live in transcript.ts alone,
// so the chat DROPPED these records while the tailer's fold counted them as ordinary user turns — two
// projections of one transcript disagreeing about whether the human had spoken. That is what let a
// thread render an unanswered ```question card and the working shimmer AT THE SAME TIME, in the Active
// rail rather than the queue (maintainer 2026-08-24: "this needs to be structurally impossible").
// Anything that decides what the HUMAN owes must ask this question the same way the chat does.
const NOISE_PREFIXES = ["<task-notification>", "[SYSTEM NOTIFICATION", "<system-reminder>", "<frizz-", "[frizz]"]
export function isInjectedNoise(text: string): boolean {
  const t = text.trimStart()
  return NOISE_PREFIXES.some((p) => t.startsWith(p))
}

/** Is this whole record plumbing? The prefix check above answers that for ONE message, and a record may
 *  hold several — a coalesced record LED by a relay is plumbing in its first segment and a real delivery
 *  in its second, and dropping it whole would silently swallow the delivery. */
export function isAllInjectedNoise(text: string): boolean {
  return splitWakeDeliveries(text).every(isInjectedNoise)
}

// ---- THE agent-to-agent UPWARD message (a sub-agent reporting to its parent) ----------------------
// Claude Code's own wrapper for a message that arrived through the agent-to-agent channel — what a
// BACKGROUND CHILD produces by calling `SendMessage({to:"main"})`. It is delivered into the parent's
// input queue exactly like a human follow-up, so the parent's transcript records it as a user turn
// carrying this wrapper as its literal text. Recognizing it is what stops a child's report from
// rendering as the operator's own bubble with raw XML showing (the `wake` defect, one channel over).
//
// Anchored to the START of the text and required to close, so prose that merely QUOTES a wrapper — this
// repo's own tests and docs do — is left alone. `from` is the sender label; today that is the child's
// `subagent_type` (the worker dispatch hook strips `name`), so it is NOT unique across siblings — the
// delivery record's `origin.senderTaskId` is the unambiguous id, and the parser deliberately does not
// invent one here.
const AGENT_MESSAGE_WRAPPER = /^<agent-message from="([^"]*)">\n?([\s\S]*?)\n?<\/agent-message>\s*$/

// Parse an upward agent-to-agent message into its sender label and body, or undefined when `text` is
// not one. The body is returned verbatim (minus the wrapper's own framing newlines) — it is the part a
// human actually reads, and the part the transcript projects as `displayText`.
export function parseAgentMessage(text: string): { from: string; body: string } | undefined {
  const m = AGENT_MESSAGE_WRAPPER.exec(text.trim())
  if (!m) return undefined
  const from = m[1].trim()
  const body = m[2]
  // A wrapper with no readable body, or none naming its sender, is plumbing rather than a report. Both
  // degrade to the ordinary user path (a plain bubble) instead of an empty or unattributed child card —
  // the label is the whole point of the card, so inventing one would be worse than not drawing it.
  if (!body.trim() || !from) return undefined
  return { from, body }
}

// ---- THE PR-WATCHER WAKE STEER (scheduler ↔ chat card) -------------------------------------------
// FORMATTER AND PARSER LIVE TOGETHER, for the same reason the token and its stripper do. The scheduler
// composes this string and pastes it into a worker's composer; the chat then has nothing BUT that
// string to rebuild a first-party card from, because the structured activity lives in the scheduler's
// own cursor (keyed by fence generation) and never reaches the transcript. Two definitions of one
// format in two packages is a silent drift waiting to happen — a wording tweak on the producer would
// quietly downgrade every card in the chat to a plain text blob. Keeping the pair adjacent, with a
// round-trip test over both, is the guard.

// Zod rather than a bare interface because the SERVER hands the parsed steer to the chat on the
// transcript message (TranscriptMessage.wakeSteer), so it has to survive wire validation.
export const GithubWakeItem = z.object({
  label: z.string(), // the activity's noun ("comment", "approval", "change request", …)
  actor: z.string(), // GitHub login, no leading @
  bot: z.boolean(), // drives the 🤖/👤 icon; an app files most of what wakes this watcher
  at: z.string().optional(), // ISO8601
  url: z.string().optional(), // the item's own permalink
})
export type GithubWakeItem = z.infer<typeof GithubWakeItem>

export const GithubWakeSteer = z.object({
  ref: z.string(), // owner/repo#N
  items: z.array(GithubWakeItem),
  omitted: z.number(), // fresh items counted but not named (the enumeration cap)
})
export type GithubWakeSteer = z.infer<typeof GithubWakeSteer>

const WAKE_SCOPE = "ignore older activity you have already handled"

function wakeItemTail(item: GithubWakeItem): string {
  // The URL goes LAST and carries no trailing punctuation, so terminal autolinkers cannot swallow a
  // following period into the href.
  return `${item.at ? ` at ${item.at}` : ""}${item.url ? `: ${item.url}` : ""}`
}

// ---- the review-read tail -------------------------------------------------------------------------
// A review's substance is routinely NOT its body. A review app files an empty-bodied review carrying N
// inline comments, so the permalink above lands on an anchor whose obvious read — `gh api …/reviews/ID`
// — hands back `body: ""` and the worker has to GUESS where the content went.
//
// A worker woken by exactly that spent FOUR calls getting to it (2026-07-31, nubjs/nub#587): the body,
// the body again in full to be sure, a `…/pulls/N/comments` sweep filtered by `pull_request_review_id`
// that silently hit the 100-item default page, and finally the same sweep with `--paginate`. The one
// endpoint that answers the question in a single call — `…/pulls/N/reviews/ID/comments` — was never
// reached. So the steer names that call outright, fully materialized, once per review it woke for.
//
// The tail is DERIVED from the items and never stored: the parser drops these lines and rebuilds the
// steer from the header and item lines alone, which is what keeps the round-trip exact without adding a
// field to GithubWakeSteer. It is also invisible to the human — FrizzWake renders from the PARSE,
// not from this text — so it costs the card nothing to speak to the worker here.
const WAKE_REVIEW_LEAD = "A review's body is often empty because its substance is inline comments. Read them, one call each:"

// The review permalink is the only place the review id exists, but owner/repo/number come from `ref`,
// which the wake format already validates — so a surprising URL costs the hint, never a wrong command.
function wakeReviewReads({ ref, items }: GithubWakeSteer): string[] {
  const [repo, number] = ref.split("#")
  const ids = new Set<string>()
  for (const item of items) {
    const id = /#pullrequestreview-(\d+)$/.exec(item.url ?? "")?.[1]
    if (id) ids.add(id)
  }
  return [...ids].map((id) => `gh api --paginate repos/${repo}/pulls/${number}/reviews/${id}/comments`)
}

function wakeReviewTail(steer: GithubWakeSteer): string {
  const reads = wakeReviewReads(steer)
  return reads.length ? `\n\n${WAKE_REVIEW_LEAD}\n${reads.join("\n")}` : ""
}

// ---- the BACKLOG tail -----------------------------------------------------------------------------
// The one wake that names activity which is NOT new: the first time a thread parks on a given PR, the
// watcher hands over whatever was already sitting there (maintainer 2026-08-12, choosing this over a
// card that merely mentions it). A worker had parked on colinhacks/zod#6318 saying "waiting on review"
// with two unread reviews already on it, and the old baseline recorded them as handled — so the watcher
// slept on the very thing it was watching for.
//
// It rides as a derived TAIL on the ordinary burst shape rather than a third header, for the reason the
// parser documents below: an unrecognized line under the header is DROPPED, so every already-open tab
// renders this card exactly as before. A new header shape would have made them all fall back to prose.
//
// `backlog` is deliberately NOT a GithubWakeSteer field — it is an argument. Putting it in the schema
// would break the parse round-trip (the parser cannot recover it from the text), and that round-trip is
// the contract that keeps formatter and parser from drifting.
const WAKE_BACKLOG_TAIL =
  "These were already on the PR when you parked, so you may have handled some. Check what is still" +
  " unaddressed, deal with it, and re-park — this is the only time frizz replays a PR's existing" +
  " activity to you."

/** Is this delivered steer the FIRST-PARK REPLAY rather than news?
 *
 *  The chat needs to tell them apart, because they read as opposite things: activity that landed while
 *  the worker was parked is an event, and a PR's pre-existing history is not (maintainer 2026-08-13:
 *  "That already is preexisting on the PR, which I find quite weird… For PRs that have been around for a
 *  long time, it's going to render like a hundred reviews").
 *
 *  Matched on the TAIL rather than carried in `GithubWakeSteer`, which keeps the formatter's round-trip
 *  intact — see the note above on why `backlog` is an argument and not a field. A legacy transcript
 *  written before the tail existed simply reads as not-a-backlog, which is what it was. */
export function isGithubWakeBacklog(text: string | undefined): boolean {
  return typeof text === "string" && text.includes(WAKE_BACKLOG_TAIL)
}

export function formatGithubWakeSteer({ ref, items, omitted }: GithubWakeSteer, opts: { backlog?: boolean } = {}): string {
  const icon = items.some((i) => !i.bot) ? "👤" : "🤖"
  const reviewTail = wakeReviewTail({ ref, items, omitted }) + (opts.backlog ? `\n\n${WAKE_BACKLOG_TAIL}` : "")
  if (items.length === 1 && omitted === 0) {
    const item = items[0]
    const url = item.url ? `: ${item.url}` : "."
    return `${icon} New GitHub ${item.label} on ${ref} from @${item.actor}${item.at ? ` at ${item.at}` : ""}. Read that exact ${item.label} — ${WAKE_SCOPE} — and continue${url}${reviewTail}`
  }
  const more = omitted > 0 ? `\n- …and ${omitted} more not listed — check ${ref} for the rest` : ""
  // The blank line separates the instruction from the items. Frizz's transcript renders a delivered
  // wake as PLAIN TEXT with line breaks preserved, so this buys a paragraph break rather than an <li>,
  // and it keeps the two readable as distinct parts in a terminal composer too.
  // Each line carries its OWN 🤖/👤. A burst routinely mixes a maintainer's comment with a review
  // app's output, and "who is a person here" is the first thing both the worker and a human scanning
  // the card want — the header icon alone cannot say it, and a login is not a reliable tell (@pullfrog
  // is a GitHub App with no `[bot]` suffix). It is also what makes the format round-trip losslessly.
  const lines = items.map((i) => `- ${i.bot ? "🤖" : "👤"} ${i.label} from @${i.actor}${wakeItemTail(i)}`).join("\n")
  return `${icon} ${items.length + omitted} new GitHub items on ${ref}. Read exactly these — ${WAKE_SCOPE} — and continue:\n\n${lines}${more}${reviewTail}`
}

const WAKE_REF = String.raw`[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*#\d+`
const WAKE_SINGLE = new RegExp(
  String.raw`^(👤|🤖) New GitHub (.+?) on (${WAKE_REF}) from @(\S+?)(?: at (\S+?))?\. Read that exact .+? — ` +
    WAKE_SCOPE +
    String.raw` — and continue(?::\s*(\S+)|\.)$`,
)
const WAKE_MULTI_HEAD = new RegExp(
  String.raw`^(👤|🤖) (\d+) new GitHub items on (${WAKE_REF})\. Read exactly these — ` + WAKE_SCOPE + String.raw` — and continue:$`,
)
const WAKE_ITEM = /^- (👤|🤖) (.+?) from @(\S+?)(?: at (\S+?))?(?:: (\S+))?$/
const WAKE_MORE = /^- …and (\d+) more not listed — check .+ for the rest$/

// Rebuild the structured wake from its delivered text. `null` for anything that is not one of the two
// shapes above — the chat then falls back to rendering the text as-is, so a format the parser does not
// know costs a card, never the message.
//
// It is the FALLBACK path now: the server parses at projection time and hands the result over on
// `TranscriptMessage.wakeSteer`, so a current client never re-derives the card from prose. This still
// runs for a legacy transcript and for a server too old to send the field.
//
// UNRECOGNIZED LINES ARE DROPPED, not refused. That is the correction for a real defect: the steer
// gained a review-read tail (c741fb1), the parser learned an allowlist for exactly those two line
// shapes — and every ALREADY-OPEN tab, whose bundle predated it, started rendering the raw-text
// fallback card instead of the divider. Nothing reloads those tabs: `web/api/boot.ts` adopts a new
// server boot id in place on purpose, so an unsent draft survives a restart, which means a promoted
// artifact routinely leaves an old parser reading a new format. An allowlist has to be taught each new
// line and is wrong until it is; dropping what it does not recognize is right in advance. Structural
// integrity rides on the header's own COUNT instead (below), which is what actually catches a
// misread — a truncated or padded burst still returns null.
export function parseGithubWakeSteer(text: string): GithubWakeSteer | null {
  // Absent fields are OMITTED rather than set to undefined, so a parsed steer is deep-equal to the one
  // the formatter was handed — which is what makes the round-trip test a real contract.
  const item = (label: string, actor: string, bot: boolean, at?: string, url?: string): GithubWakeItem => ({
    label,
    actor,
    bot,
    ...(at ? { at } : {}),
    ...(url ? { url } : {}),
  })
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  // The FIRST line decides the shape. Anything below a single-item steer is agent-facing prose the
  // formatter derived (today the review-read tail, tomorrow whatever the next steer gains) — the card
  // has nothing to render from it, so it never gets a say in whether the card renders at all.
  const single = WAKE_SINGLE.exec(lines[0] ?? "")
  if (single) {
    return { ref: single[3], omitted: 0, items: [item(single[2], single[4], single[1] === "🤖", single[5], single[6])] }
  }
  const head = WAKE_MULTI_HEAD.exec(lines[0] ?? "")
  if (!head) return null
  const items: GithubWakeItem[] = []
  let omitted = 0
  for (const line of lines.slice(1)) {
    const more = WAKE_MORE.exec(line)
    if (more) {
      omitted = Number(more[1])
      continue
    }
    const m = WAKE_ITEM.exec(line)
    if (!m) continue // prose below the burst, not an item — see the header-count check below
    items.push(item(m[2], m[3], m[1] === "🤖", m[4], m[5]))
  }
  // The header's own count is the authority on how many landed; disagreeing with it means we misread.
  // Now that an unrecognized line is skipped rather than refused, this is the WHOLE integrity check —
  // a burst that lost a line to truncation, gained one to corruption, or whose item shape drifted out
  // from under this parser lands here and returns null, exactly as before.
  if (!items.length || items.length + omitted !== Number(head[2])) return null
  return { ref: head[3], omitted, items }
}

// ---- THE PR-WATCH STATUS LINE --------------------------------------------------------------------
// The other half of what a registered PR watcher says, and the half that had no parser: a PR reaching a
// terminal state, and CI reaching a terminal verdict. `prWatchWakeMessage` (above) writes both; this
// reads them back, and the pair round-trips in github-wake.test.ts for the same reason the steer's pair
// does — one wording tweak on the producer would otherwise silently downgrade every one of these to a
// raw-text blob in the chat.
//
// Which is exactly what it was doing. A watcher's REVIEW activity has rendered as a hairline divider
// since the card died (see FrizzWake), but "#760 was CLOSED" and "CI PASSED on #761" fell through
// to the fallback card — so the same watcher, on the same PR, spoke in two completely different voices
// down one transcript, and the louder voice was the one carrying the least news (maintainer 2026-08-18,
// with a screenshot of two full-width CLOSED cards under a run of hairlines: "these callouts should
// obviously be hairlines").
//
// It reads ONE line out of a delivery that may carry several parts — a CI verdict and a review steer
// arrive together when one poll saw both — so the caller parses this AND `parseGithubWakeSteer`, and
// renders a divider per part. Everything else in the message is the agent-facing trailer (the
// still-armed / watcher-is-spent parenthetical), which is boilerplate frizz wrote for the worker and
// has nothing to say to a human.
export type PrWatchWake =
  | { ref: string; kind: "merged" | "closed" }
  // `passed` is absent on a failure because the FORMATTER does not write it — a red line names the
  // failing jobs, not the tally. Never invent a field the text does not carry. `skipped` is absent on a
  // green line that had none, for the same reason: the formatter omits the clause entirely.
  | { ref: string; kind: "ci"; verdict: "passing" | "failing"; passed?: number; skipped?: number; failing: string[] }
  // CI HELD FOR AN APPROVAL, which is neither a pass nor a failure and must not be drawn as one.
  | { ref: string; kind: "ci"; verdict: "gated"; gated: number; gating: string[] }

const PR_WATCH_FINISHED = new RegExp(String.raw`^⏰ (${WAKE_REF}) was (MERGED|CLOSED)\.$`)
// The skip clause is OPTIONAL because the formatter omits it when nothing was skipped — a green line
// with no skips reads exactly as it did before 2026-09-04, so every delivery already in a transcript
// still parses.
const PR_WATCH_CI_PASSED = new RegExp(String.raw`^✅ CI PASSED on (${WAKE_REF}) — (\d+) checks? green(?:, (\d+) skipped)?\.$`)
const PR_WATCH_CI_GATED = new RegExp(String.raw`^⏸️ CI on (${WAKE_REF}) is WAITING FOR APPROVAL — (\d+) workflows? held(?:: (.+?))?\.$`)
const PR_WATCH_STATE = new RegExp(String.raw`^🔔 (${WAKE_REF}): (.+)\.$`)

/** The PR's own state moving — a conflict appearing, a label added or dropped, a reviewer requested.
 *
 *  ITS OWN PARSER RATHER THAN A `PrWatchWake` VARIANT, because it coexists with one: a poll that sees CI
 *  go red AND a label move says both, and `parsePrWatchWake` returns the FIRST line it recognizes. Two
 *  parsers means two dividers, which is what the CI line and the review steer already do down the same
 *  delivery. The clauses are kept as ONE opaque string: they are prose frizz composed for the worker,
 *  and the chat's job is to show them, not to re-derive what they meant. */
export interface PrWatchStateWake { ref: string; detail: string }

export function parsePrWatchStateWake(text: string): PrWatchStateWake | null {
  for (const raw of text.split("\n")) {
    const m = PR_WATCH_STATE.exec(raw.trim())
    if (m) return { ref: m[1], detail: m[2] }
  }
  return null
}
const PR_WATCH_CI_FAILED = new RegExp(String.raw`^❌ CI FAILED on (${WAKE_REF})(?:: (.+?))?\.$`)

/** The PR-watch status part of a delivered wake, or `null` when the text carries none.
 *
 *  SCANS rather than reading line 0, unlike `parseGithubWakeSteer`: this line can sit above a review
 *  steer, below it in a legacy delivery, or alone. The three shapes are specific enough that scanning
 *  costs nothing — each names its own emoji, its own verb and an `owner/repo#N`. */
export function parsePrWatchWake(text: string): PrWatchWake | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const done = PR_WATCH_FINISHED.exec(line)
    if (done) return { ref: done[1], kind: done[2] === "MERGED" ? "merged" : "closed" }
    const passed = PR_WATCH_CI_PASSED.exec(line)
    if (passed) {
      return {
        ref: passed[1], kind: "ci", verdict: "passing", passed: Number(passed[2]), failing: [],
        ...(passed[3] ? { skipped: Number(passed[3]) } : {}),
      }
    }
    const gated = PR_WATCH_CI_GATED.exec(line)
    // Same comma-split caveat as the failing branch below, and the same cost: a workflow whose name
    // contains ", " is listed as two. Never the divider, never the verdict.
    if (gated) return { ref: gated[1], kind: "ci", verdict: "gated", gated: Number(gated[2]), gating: gated[3] ? gated[3].split(", ") : [] }
    const failed = PR_WATCH_CI_FAILED.exec(line)
    // The formatter joins the job names with ", ", so a job whose own name contains a comma-space splits
    // wrong here. It costs a label that lists one job as two — never the divider, and never the verdict.
    if (failed) return { ref: failed[1], kind: "ci", verdict: "failing", failing: failed[2] ? failed[2].split(", ") : [] }
  }
  return null
}

// The server's gh-CLI availability signal. `installed`/`inRepo`/`nameWithOwner` are STABLE for the
// process lifetime (resolved once at boot); `authed` can flip mid-session (the user runs
// `gh auth login`) so it is re-checked live on each githubStatus query.
export const GithubStatus = z.object({
  installed: z.boolean(),
  inRepo: z.boolean(),
  nameWithOwner: z.string().nullable(),
  authed: z.boolean(),
})
export type GithubStatus = z.infer<typeof GithubStatus>

// ── Hovercards for the GitHub references autolinked into prose ───────────────────────────────────
//
// One card = one `#123` / `owner/repo#123` / commit hash the autolinker turned into an anchor
// (web/lib/githubAutolink.ts). The wire shape is FLAT and every field past `kind` is optional rather
// than a discriminated union, because the same card renders an issue, a PR and a commit: a union
// would triple the schema and the rpc-contract gate for three shapes that differ by four fields.
//
// `ref` is the canonical key both sides cache on — `owner/repo#123` for an issue or PR,
// `owner/repo@<sha>` for a commit — and it is echoed back so a batched response can be matched to
// its request without positional assumptions.
export const GithubRefCard = z.object({
  ref: z.string(),
  kind: z.enum(["issue", "pr", "commit"]),
  repo: z.string(), // owner/repo, for the card's header line
  url: z.string(),
  title: z.string(),
  body: z.string(), // already truncated server-side to the card's excerpt budget
  state: z.string(), // OPEN | CLOSED | MERGED | DRAFT — empty for a commit, which has no state
  stateReason: z.string().optional(), // COMPLETED | NOT_PLANNED | REOPENED — GitHub's closed-issue nuance
  at: z.string().optional(), // ISO: opened-at for an issue/PR, committed-at for a commit
  authorLogin: z.string().optional(),
  authorName: z.string().optional(), // commits carry a git author name with no GitHub account behind it
  authorAvatar: z.string().optional(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })).default([]),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  comments: z.number().int().nonnegative().optional(),
  // Epoch ms of the fetch this card came from. The CLIENT owns the freshness decision (render the
  // cached card instantly, then revalidate if it is old), so it has to be able to see the age.
  fetchedAt: z.number().int().nonnegative(),
})
export type GithubRefCard = z.infer<typeof GithubRefCard>

// ONE request for every reference on the page. The whole point of the batch is that a hover costs no
// round trip at all: the client asks for a screenful of refs as the prose renders and answers the
// hover out of its own store. `refresh` is the revalidation half — set only for the handful of refs
// the client is actually looking at, it makes the server bypass its TTL for those.
export const GithubRefPreviewInput = z.object({
  refs: z.array(z.string().min(3).max(120)).min(1).max(100),
  refresh: z.boolean().default(false),
})
export type GithubRefPreviewInput = z.infer<typeof GithubRefPreviewInput>

// `missing` is a real answer, not a failure: a `#123` in prose can name an issue that does not exist
// (a worker misremembered, or the repo is private to someone else). The client caches it so the
// anchor never asks twice. `error` is set only when the whole batch failed — no gh, no token, rate
// limit — and the client keeps the plain link with no card rather than showing a broken one.
export const GithubRefPreviewResult = z.object({
  cards: z.array(GithubRefCard),
  missing: z.array(z.string()),
  error: z.string().optional(),
})
export type GithubRefPreviewResult = z.infer<typeof GithubRefPreviewResult>

// One row in the picker list. `reactions` is summed server-side across reactionGroups (the list ORDER
// already reflects the sort; this is a display badge). `comments` is optional (present for issues).
export const GithubItem = z.object({
  kind: z.enum(["issue", "pr"]),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  reactions: z.number().int().nonnegative(),
  updatedAt: z.string(),
  comments: z.number().int().nonnegative().optional(),
  // GitHub-mirror row fields — all optional/defaulted so a pre-restart snapshot still parses.
  createdAt: z.string().optional(), // for "opened <when>"
  author: z.string().optional(), // login
  labels: z.array(z.object({ name: z.string(), color: z.string() })).default([]),
  state: z.string().optional(), // OPEN | CLOSED | MERGED
  isDraft: z.boolean().optional(), // PRs only
  // ISSUES only: the pull requests whose bodies carry a closing keyword for this issue (GitHub's own
  // "linked pull requests"). Present means someone is already on it — the row paints the PR glyph so
  // a dispatch doesn't duplicate work in flight. `count` is what the badge shows, mirroring the
  // github.com issue list; `number`/`url`/`state` describe the PRIMARY one (open outranks merged),
  // which the badge links to and names in its tooltip. Absent for PRs and for unclaimed issues.
  linkedPrs: z
    .object({
      count: z.number().int().positive(),
      number: z.number().int().positive(),
      url: z.string(),
      state: z.string(), // OPEN | MERGED
      isDraft: z.boolean().optional(),
    })
    .optional(),
})
export type GithubItem = z.infer<typeof GithubItem>

// One PAGE request. `page` is 1-based; the server clamps it into GitHub's servable window and
// reports back which page it actually served.
export const GithubListInput = z.object({
  kind: z.enum(["issues", "prs"]),
  sort: z.enum(["recent", "reactions"]),
  page: z.number().int().min(1).default(1),
  perPage: z.number().int().min(1).max(100).default(30),
})
export type GithubListInput = z.infer<typeof GithubListInput>

// One page of rows plus what the pager needs to draw itself. `total` is every open item matching the
// query (not just this page); `pageCount` is that clamped to the search API's 1000-result window, so
// the pager never offers a page GitHub will refuse to serve.
export const GithubListResult = z.object({
  items: z.array(GithubItem),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageCount: z.number().int().positive(),
})
export type GithubListResult = z.infer<typeof GithubListResult>

// Minimal batch payload — the server re-hydrates title/body/url fresh from gh at dispatch (always
// current, small wire payload). Deliberately UNCAPPED: the picker pages through the whole repo and a
// human may well want every issue on a page (or several pages' worth) investigated at once. The
// server dispatches them SEQUENTIALLY, so a large batch is a long request, never a spawn burst.
export const GithubBatchInput = DispatchProfileSnapshot.extend({
  items: z.array(z.object({ kind: z.enum(["issue", "pr"]), number: z.number().int().positive() })).min(1),
}).strict()
export type GithubBatchInput = z.infer<typeof GithubBatchInput>

export const GithubBatchResult = z.object({
  dispatched: z.array(z.object({ number: z.number(), kind: z.string(), slug: ThreadSlug })),
  failed: z.array(z.object({ number: z.number(), kind: z.string(), error: z.string() })),
})
export type GithubBatchResult = z.infer<typeof GithubBatchResult>

// ---- SSE events on the global /events channel ----
// The channel is DELTA-based (see delta.ts): a full "board" frame is the connect keyframe and the
// resync frame; steady-state changes ship as "board-delta" (only the threads that actually changed).
// A one-thread status change ships one ThreadView, not the whole ~310KB board — that is the byte win.

// Board-level (non-thread) fields, diffed as a unit and shipped only when they change (BoardDelta.meta).
export const BoardMeta = z.object({
  projectDir: z.string(),
  projectName: z.string(),
  projectLabel: z.string(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  // Structured mirror of `errors` (see BoardErrorItem), diffed + shipped with the rest of the board
  // meta so the repair affordance survives a delta (not just the connect keyframe). Optional for the
  // same pre-restart back-compat reason as on BoardSnapshot.
  errorItems: z.array(BoardErrorItem).optional(),
})
export type BoardMeta = z.infer<typeof BoardMeta>

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("board"),
    board: BoardSnapshot,
    // Monotonic publish counter this keyframe corresponds to (the client adopts it, then applies
    // deltas seq+1, seq+2 …). `bootId` is the server's per-process id. BOTH optional so a pre-restart
    // server's frame (which omits them) still parses; a new client treats absent seq as "no delta
    // tracking yet" and absent bootId as "unknown — no reload check".
    seq: z.number().optional(),
    bootId: z.string().optional(),
  }),
  z.object({
    // Keyed per-thread delta. `upserts` are COMPLETE ThreadViews for threads whose serialization
    // changed (or are new); `removed` are ids gone from the board; `meta` is present only when a
    // board-level field changed. Emitted only by a post-restart server → seq/bootId are required here.
    type: z.literal("board-delta"),
    seq: z.number(),
    bootId: z.string(),
    upserts: z.array(ThreadView),
    removed: z.array(ThreadSlug),
    meta: BoardMeta.optional(),
  }),
  z.object({
    type: z.literal("notify"),
    slug: ThreadSlug,
    kind: z.enum(["needs-decision", "turn-done", "exited"]),
    title: z.string(),
    body: z.string().optional(),
  }),
  z.object({
    // Payload-free invalidation for future interaction cards. Provider-controlled command/diff/form
    // metadata never rides the global event bus; clients re-read the authorization-scoped RPC instead.
    type: z.literal("interactions-invalidated"),
    slug: InteractionThreadSlug,
    sessionId: InteractionOpaqueId,
    interactionId: InteractionOpaqueId,
    lifecycle: InteractionLifecycle,
    recordRevision: InteractionRevision,
  }).strict(),
])
export type ServerEvent = z.infer<typeof ServerEvent>
export type BoardEvent = Extract<ServerEvent, { type: "board" }>
export type BoardDelta = Extract<ServerEvent, { type: "board-delta" }>

// Pure delta engine + client apply/decision helpers (kept in a sibling module, re-exported here so
// `@frizz/shared` stays the single entry point).
export * from "./claim.ts"
export * from "./code-fences.ts"
export * from "./delta.ts"
export * from "./drainable-worker.ts"
export * from "./interactions.ts"
export * from "./receipt-bus.ts"
export * from "./relay-protocol.ts"
export * from "./shell-writes.ts"
export * from "./thread-slug.ts"

// ---- Rendered conversation (parsed mechanically from the session JSONL — no AI) ----

// Structured file-edit payload for Edit/Write/MultiEdit tool calls, so the client can render a
// syntax-highlighted diff instead of an opaque "edited file.ts" line. Write → old: "" (whole file
// is new); MultiEdit → one TranscriptToolCall per sub-edit. Both strings are capped (see
// transcript.ts EDIT_CAP) so transcripts stay light.
export const TranscriptEdit = z.object({
  file: z.string(),
  old: z.string(),
  new: z.string(),
  // Line counts of the UNCAPPED sides, taken at projection time — `old`/`new` above are capped for
  // transport, so a diffstat recomputed from them undercounts any large edit.
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
})
export type TranscriptEdit = z.infer<typeof TranscriptEdit>

// One row of an agent's built-in TO-DO LIST. Set only for a call that ITSELF carries the whole list —
// Claude Code's `TaskList` (whose result enumerates every task), codex's `update_plan` and Claude's
// legacy `TodoWrite` (both of which pass the entire list on every call). The server normalizes those
// onto this one row so one client card renders all three.
//
// Deliberately NOT reconstructed for Claude's per-task deltas (`TaskCreate`/`TaskUpdate`, whose payload
// is `{taskId:"3", status:"completed"}` and nothing more). Deriving a list from them would mean the
// projector accumulating list state across the transcript, which is not its job (maintainer 2026-07-29:
// "don't bother with maintaining your own state here"). Those calls render as ordinary tool cards.
export const TranscriptTodo = z.object({
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
})
export type TranscriptTodo = z.infer<typeof TranscriptTodo>

export const TranscriptToolCall = z.object({
  name: z.string(),
  detail: z.string().optional(), // file path / command / description — whatever the input reveals
  edit: TranscriptEdit.optional(), // set only for Edit/Write/MultiEdit blocks
  // The model-authored one-line description of a Bash command (Claude Code's `description` input
  // field) — the collapsed block's title.
  desc: z.string().optional(),
  // Raw (multi-line) command, set only for a Bash call whose command spans multiple lines or runs
  // long — the client renders it as its own code block instead of the flattened one-line `detail`.
  command: z.string().optional(),
  // Capped human-readable input/source for any tool that has useful payload beyond its one-line
  // detail. Generic cards expand this exactly like Bash expands `command`; specialized cards may
  // retain it as failure context (for example a wrapped apply_patch that did not apply).
  input: z.string().optional(),
  // A capped excerpt of a Read call's tool_result (the file content it returned) — set only for Read
  // calls whose result shipped as text. The client renders it as a collapsed, bordered card (same
  // family as Bash/Edit) that expands to the excerpt. Absent for older transcripts / pre-restart
  // servers, in which case the client falls back to the compact one-line Read summary.
  read: z.string().optional(),
  // A capped excerpt of a tool's captured result. Codex records results for shell calls and for its
  // unified custom-tool wrapper; the client renders this as a second pane below either the Bash body
  // or a generic input body. Absent for Claude calls whose result isn't present in the transcript.
  output: z.string().optional(),
  // Absolute path to an IMAGE the tool returned in its result — e.g. a `take_screenshot` (chrome-devtools
  // MCP) or any tool whose tool_result carries a base64 image block. The server decodes the image once to
  // a content-hashed file under the OS temp dir and records the path here; the client renders it inline in
  // the tool card via the gated /local-image route (tmpdir is a trusted root). Absent for text-only results.
  outputImage: z.string().optional(),
  // Tool lifecycle inferred from call/result pairs. A just-appended call is `pending`; the matching
  // result promotes it to completed/failed/cancelled. Background launches deliberately remain pending
  // after their launch acknowledgement: a later provider-native completion is the only terminal fact.
  // Kept optional for pre-restart transcript data.
  // `exitCode` is present for shell-like results that expose it.
  status: z.enum(["pending", "completed", "failed", "cancelled"]).optional(),
  // A non-terminal shell has a durable, provider-neutral lifecycle identity. `background` means the
  // provider confirmed a live child/session; `unknown` means we saw a poll for an unpaired session.
  // Neither is rendered as done merely because the wrapper call returned.
  backgroundState: z.enum(["background", "unknown"]).optional(),
  // The launching tool_use id of a `background` shell — the SAME key the tailer tracks that shell under
  // (BgShellView.id), and therefore the only exact way to tell "the board's row and this transcript card
  // are one process" from "two processes the model described identically".
  //
  // The ops strip lists a live shell from BOTH sources, and it used to reconcile them on
  // label+startedAt. That key cannot hold: the board's instant is the tool_use RECORD's timestamp while
  // the transcript's is the projected MESSAGE's, and an assistant turn whose prose lands before its call
  // makes those differ by seconds (measured: 19:11:28.190 vs 19:11:32.200 on one real launch), so the
  // same shell rendered twice — once clickable, once not. Optional: absent on codex (whose background
  // execs are transcript-native and have no board row to collide with) and on pre-restart servers,
  // which fall back to the label+startedAt key.
  shellId: z.string().optional(),
  exitCode: z.number().int().optional(),
  // Execution context/result metadata that is useful in a compact card header without dumping a
  // backend envelope. `cwd` comes from exec_command's workdir/cwd, `sessionId` identifies a yielded
  // PTY process (and later write_stdin polls), and `durationMs` is result wall time when recorded.
  cwd: z.string().optional(),
  sessionId: z.union([z.string(), z.number()]).optional(),
  durationMs: z.number().nonnegative().optional(),
  // ---- Agent (sub-agent dispatch) block ----
  // Set only for an `Agent` tool_use that carried a `prompt`. The client promotes such a call into an
  // AgentBlock (same collapsed-card family as Bash/Read): the `detail` is the dispatch description,
  // `subagentType` the model+effort cell, and expanding reveals the (capped) dispatch `prompt`. All
  // optional so a pre-restart server / older transcript falls back to the plain `Agent(detail)` line.
  prompt: z.string().optional(), // the capped dispatch prompt (the AgentBlock's expanded body)
  // The RESOLVED model+effort cell (e.g. "frizz:opus-high"), not `subagent_type` verbatim: a modern
  // profile is effort-only, so the server folds the call's `model` — or, when omitted, the model the
  // dispatching turn itself ran at — back into the cell. See server/subagent-profile.ts.
  subagentType: z.string().optional(),
  agentId: z.string().optional(), // the Agent tool_use id — the correlation key to the live tracked sub-agent
  // Terminal outcome of the dispatched sub-agent, back-filled when a matching completion
  // <task-notification> appears LATER in the transcript. Drives the AgentBlock header's finished state
  // ("finished 35m" / "failed 12m"). Absent while the child is still live (or its completion was
  // missed) — in which case the live tracked-sub-agent overlay supplies "running Nm" instead.
  agentStatus: z.enum(["completed", "failed", "killed"]).optional(),
  agentElapsedMs: z.number().optional(), // dispatch → completion elapsed, for the finished-state label
  // TRUE only on the copy of the dispatch call the server re-emits, as its own standalone message, at
  // the position the completion <task-notification> landed (see transcript.ts completionEvents). That
  // copy is a TIMELINE MARKER, not a second tool call, so the client renders it as the centered wake
  // divider a background shell's completion already uses — never as a second AgentBlock card
  // (maintainer 2026-07-27: converge an agent finishing onto the background-shell rendering, which is
  // "more visually distinct in a big sea of tool call blocks"). The LAUNCH card, which carries the same
  // agentStatus/agentElapsedMs after back-fill, never sets this and stays an expandable prompt card.
  // Optional + additive: an old client ignores it and shows the previous duplicate-card rendering.
  agentCompletion: z.boolean().optional(),
  // ---- SendMessage (peer / agent-to-agent messaging) block ----
  // Set only for a `SendMessage` tool_use (an orchestrator steering a sub-agent, or a teammate note).
  // The client promotes such a call into the centred WAKE DIVIDER the sub-agent completion and upward
  // report already draw (maintainer 2026-07-31: "render 'Steered' or SendMessage using the same full
  // width notifications, the horizontal rule style component that we render when an agent completes").
  // `sendTo` is the recipient agent id/name, `sendSummary` the short recap, `sendBody` the (capped)
  // message body, and `sendType` the message type when it is NOT a plain "message" (e.g.
  // "shutdown_request"). Summary and body are retained because the SUB-AGENT DRAWER — where the same
  // call is read as the child's own record — still needs them; the parent's divider renders neither.
  // All optional so a pre-restart server / older transcript falls back to a bare divider.
  sendTo: z.string().optional(), // recipient agent id/name (the SendMessage `to`)
  sendSummary: z.string().optional(), // the short recap (the SendMessage `summary`)
  sendBody: z.string().optional(), // the capped message body (the SendMessage `message`/`content`)
  sendType: z.string().optional(), // the message type when not a plain "message" (e.g. "shutdown_request")
  // The steer's DRILL-IN pair, set only when the server could resolve `sendTo` to a child this same
  // transcript dispatched. A Claude `SendMessage` addresses its target by AGENT ID, which is both
  // meaningless to a reader and not a key any drawer resolves — every sub-agent lookup goes through the
  // DISPATCH tool_use id. The server owns that translation (childDispatchIds, the one record where a
  // child's two identities meet) and ships the result: `sendDispatchId` is what the divider's title
  // opens, `sendTargetLabel` the dispatch's own description, which is what the title reads.
  // Absent on codex (its peer tools name a target that was never dispatch-acked here) and on `to:"main"`
  // — in both cases the divider degrades to plain text rather than a link to an unavailable drawer.
  sendDispatchId: z.string().optional(),
  sendTargetLabel: z.string().optional(),
  // ---- SendUserFile (Claude Code file delivery) block ----
  // Set only for a `SendUserFile` tool_use — the worker surfacing files (screenshots, artifacts) to the
  // human. The client promotes such a call into a SentFilesCard that renders the delivered files inline
  // instead of a generic tool block: `sentImages` are absolute paths the server COPIED into its servable
  // screenshot cache (the sources are often scratchpad paths /local-image won't serve), each rendered
  // inline via the gated /local-image route; `sentFiles` are the basenames of any NON-image files
  // (rendered as openable chips); `caption` is the model's one-line caption, shown below. All optional so
  // a pre-restart server / older transcript falls back to the generic tool card.
  sentImages: z.array(z.string()).optional(),
  sentFiles: z.array(z.string()).optional(),
  caption: z.string().optional(),
  // ---- To-do list block ----
  // The whole to-do list, for the calls that carry it (see TranscriptTodo). The client promotes such a
  // call into a TodoBlock — a checklist card, one row per task with its status. Optional, so a
  // pre-restart server / older transcript falls back to the generic card.
  todos: z.array(TranscriptTodo).optional(),
  // ---- Native question (AskUserQuestion) block ----
  // The structured questions an `AskUserQuestion` tool_use asked, so a SETTLED call renders as a
  // read-only question card at its place in the transcript instead of a generic tool line buried in a
  // disclosure. This is what keeps a question the human saw from vanishing: a follow-up sent instead
  // of an answer retires the pending interaction card (the broker denies the parked call), and without
  // this field nothing in the transcript ever said what was asked. Optional, so a pre-restart server /
  // older transcript falls back to the generic card.
  ask: z.array(AskQuestion).optional(),
  // The human's answers, parallel to `ask` (null = that question got no answer), parsed from the
  // call's structured tool result. Absent entirely when the call settled unanswered — the withdrawn /
  // denied case — which the client renders as "Not answered".
  askAnswers: z.array(z.string().nullable()).optional(),
})
export type TranscriptToolCall = z.infer<typeof TranscriptToolCall>

// One block-ordered PART of an assistant turn — the fidelity fix. A turn's content interleaves text
// and tool_use blocks in a meaningful order (a "Let me draft the notes:" lead-in sits DIRECTLY above
// the call it introduces). The legacy split text/tools fields discarded that order (all tools rendered
// before all prose); `parts` preserves it. Contiguous same-kind blocks coalesce into one part.
export const TranscriptPart = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("tools"), tools: z.array(TranscriptToolCall) }),
])
export type TranscriptPart = z.infer<typeof TranscriptPart>

export const TranscriptMessage = z.object({
  // Stable identity of this PROVIDER-NEUTRAL projected message. The server derives it from the
  // transcript incarnation plus the source record that opened the rendered unit; clients use it only
  // for overlap reconciliation, keyed rendering, and scroll anchoring. Optional for rolling upgrades.
  sourceId: z.string().min(1).max(768).optional(),
  // Latest-window projection may pin an unresolved background shell whose original launch message
  // has scrolled into paginated history. The synthetic tools-only card points back to that canonical
  // source so loading the earlier page can replace (not duplicate) it.
  pinnedFromSourceId: z.string().min(1).max(768).optional(),
  role: z.enum(["user", "assistant"]),
  text: z.string(), // markdown; empty when the message was tool-calls only
  // Optional presentation-only projection of `text`. The full text remains available to persistence,
  // search, and transcript logic; shared chat surfaces use this compact form for generated prompts
  // whose machine-facing tail would otherwise dominate the first user bubble.
  displayText: z.string().optional(),
  providerError: ProviderError.optional(),
  tools: z.array(TranscriptToolCall),
  at: z.string().optional(), // ISO8601
  // Additive message variant. "event" is transcript PUNCTUATION emitted inline at the position a
  // sub-agent completion <task-notification> was seen (text like `Agent "…" finished — 35m`).
  // "reasoning" is a Codex model-reasoning SUMMARY (the plaintext `summary[]` of a rollout reasoning
  // record — Claude's thinking is redacted at every seam, so this is Codex-only); `text` holds the
  // summary markdown, rendered as a collapsed-by-default expandable block. Absent (undefined) → an
  // ordinary user/assistant message. Old clients that don't know a `kind` render it as a plain
  // assistant line, which is a graceful (if unstyled) degrade.
  kind: z.enum(["event", "reasoning"]).optional(),
  // Wall-clock the model spent THINKING, in ms — set only on a `kind:"reasoning"` message. Derived from
  // the rollout's per-step reasoning timestamps (Σ of each reasoning step's gap from the event before it,
  // which excludes tool-execution time). NOT rendered: it used to caption the reasoning disclosure as
  // "Thought for N seconds", and a permanent row reporting how long the model paused is exactly what the
  // transcript no longer carries (see ReasoningBlock). Kept because it is the server's own measurement
  // and costs nothing to project. Optional: absent on non-reasoning messages and on any reasoning block
  // whose timing couldn't be derived.
  durationMs: z.number().nonnegative().optional(),
  // A turn-BOUNDARY marker: this `kind:"event"` line was emitted at the position a turn opened or
  // closed, so it renders as a centered divider rule carrying the cause label — without it, two
  // consecutive assistant turns (each with its own trailing signal) paint as one seamless bubble.
  // Additive + optional: an old client ignores it and shows the plain quiet event line (graceful
  // degrade).
  //
  // It names WHICH KIND of boundary, because several unrelated events earn the divider and the client
  // has to tell them apart to put the right glyph on each:
  //   wake       — a background task/shell completion `<task-notification>` re-invoked the agent
  //   compaction — the provider rewrote the conversation and dropped everything above this point
  //   rest       — the agent CAME TO REST: its turn ended and nothing further is in flight
  // It was a bare boolean until the dividers grew icons (a shell glyph on a compaction line is simply
  // wrong), and the kind has to come from the SERVER: the alternative is the client sniffing the label
  // text, which is the guess this codebase refuses everywhere else. A string stays truthy, so any
  // surviving `if (boundary)` reads exactly as it did — including on a client that predates `rest`,
  // which draws it as an iconless divider rather than dropping it.
  boundary: z.enum(["wake", "compaction", "rest"]).optional(),
  // Block-ordered content for an assistant turn (see TranscriptPart). Defaults to [] so a pre-restart
  // server (which ships only text/tools) parses; the client renders `parts` when non-empty and falls
  // back to the legacy tools-then-text layout when it's empty. `text`/`tools` stay populated for that
  // fallback window and for consumers (useLiveAnswering, previews) that read the flat fields.
  parts: z.array(TranscriptPart).default([]),
  // A human follow-up SENT to a mid-turn worker that Claude Code has QUEUED but not yet delivered into
  // the agent's context (an `enqueue` queue-operation with no matching delivery record yet). Rendered as
  // a grayed user bubble — the SAME affordance the client uses for its own optimistic send. Flips to
  // undefined/false once the delivery (a `queued_command` attachment) materializes the message. Additive
  // + optional: a pre-restart client ignores it; an old server simply never sets it. NB: the client ALSO
  // sets this transiently on an optimistic local send (see web hooks.ts) — same meaning, same styling.
  queued: z.boolean().optional(),
  // Server-side delivery-ledger identity for a Claude follow-up (delivery-ledger.ts): set on a queued
  // bubble the ledger projects (or tags), so the client's optimistic copy of the SAME send is consumed
  // by id instead of by exact text — the text-match path stays only for id-less legacy flows. Additive.
  deliveryId: z.string().optional(),
  // The ledger's own state for that send. "pending": injected, no JSONL evidence yet. "enqueued":
  // Claude Code's queue holds it (positive receipt, undelivered). "delivered": the transport's receipt
  // proved the provider took it straight into a turn, but its transcript record has not reached disk
  // yet — renders as an ordinary (un-grayed) user bubble. "unconfirmed": no evidence appeared within
  // the timeout — the injection likely mutated/never landed; the client renders a quiet warning.
  // Once the real transcript record lands the ledger drops the item and this field goes with it.
  // Additive + optional.
  deliveryState: z.enum(["pending", "enqueued", "delivered", "unconfirmed"]).optional(),
  // FRIZZ wrote this user turn, not the human: it is a scheduler wake delivery (isWakeDelivery). The
  // client renders it as a first-party card rather than the human's off-white right-justified bubble,
  // which was claiming the operator had typed a message the watcher composed. Additive + optional: an
  // old client ignores it and shows the plain bubble (the previous behavior), and an old server simply
  // never sets it.
  wake: z.boolean().optional(),
  // The STRUCTURED wake, parsed by the server from the same text the same build formatted. The chat
  // renders the divider from this rather than re-deriving it from prose in the browser.
  //
  // It exists because re-deriving it in the browser is version-skewed by construction. `web/api/boot.ts`
  // adopts a new server boot id IN PLACE (so an unsent draft survives a restart), so a promoted artifact
  // swaps the server under tabs that keep their old bundle — and on 2026-07-31 a steer that gained two
  // agent-facing lines met parsers that predated them, which cost every open tab its card and dumped the
  // raw `gh api …` text into the transcript instead. Server-side, formatter and parser can never
  // disagree. Additive + optional: absent from a legacy transcript or an older server, and the client
  // falls back to `parseGithubWakeSteer` on the text.
  wakeSteer: GithubWakeSteer.optional(),
  // Input delivered INTO a sub-agent by its coordinator or another agent. It is a user-side turn in
  // that CHILD's conversation, but it is not the human speaking. The drawer's live projection keeps
  // these messages even when the ordinary 300-message tail has moved past them — clicking a parent's
  // "Steered"/"Followed up" divider promises the corresponding instruction remains readable there.
  // Additive + optional: ordinary thread transcripts never set it.
  agentInstruction: z.literal(true).optional(),
  // A SUB-AGENT (or peer session) wrote this user turn, not the human — the same defect class `wake`
  // above corrects. Claude Code's agent-to-agent channel (a background child calling
  // `SendMessage({to:"main"})`) delivers UPWARD into the parent's queue like any follow-up, so the
  // parent's transcript records it as an ordinary user turn whose text is the raw
  // `<agent-message from="…">…</agent-message>` wrapper. Left alone that renders as the operator's own
  // off-white bubble with the XML showing — claiming the human typed what a child reported.
  //
  // `peerFrom` is the sender label the wrapper carries (today the child's `subagent_type`, e.g.
  // `frizz:opus-high`, because the worker dispatch hook strips `name`), and `displayText` carries the
  // unwrapped body.
  //
  // `peerDispatchId` is what makes the chat's report line CLICKABLE: it is the child's Agent DISPATCH
  // tool_use id, which is the key `tailer.subAgent()` resolves a drawer against (live map, retired ring
  // and descendant sidecars are all keyed by it — see TranscriptToolCall.agentId, the same id).
  //
  // It is deliberately NOT the child's own agentId. The delivery record supplies `origin.senderTaskId`,
  // which IS that agentId and is the unambiguous sender identity when several children share one profile
  // label — but the drawer cannot resolve it, so handing it over would open an "unavailable" drawer. The
  // two identities meet in exactly one place: the dispatch's launch-ack record, whose `toolUseResult`
  // carries the new child's `agentId` beside the `tool_use_id` that spawned it. The parser correlates
  // there and stores the DISPATCH id here. Additive + optional: absent when the ack was never seen (a
  // resumed session whose dispatch scrolled out), and the line then renders as plain text, not a dead link.
  peerFrom: z.string().optional(),
  peerDispatchId: z.string().optional(),
  // …and the tell that `peerFrom` is ONLY that subagent_type — that the parser could not resolve the
  // dispatch's own description for this sender. It matters because a profile cell is not a name: every
  // child dispatched at `frizz:opus-high` reports under the identical string, so a divider reading
  // «frizz:opus-high» names the MODEL, not the work, and two siblings are indistinguishable
  // (maintainer 2026-08-06: "I'm also still occasionally seeing things like 'Agent <OPUS:HIGH>
  // rested'"). The client renders an unnamed sender as "Sub-agent reported" and keeps the cell in the
  // tooltip, rather than promoting a profile to a title.
  //
  // Resolution is genuinely late-arriving, not merely missing: the description comes from the DISPATCH
  // record, so a report rendered while the window has not yet reached that record is unnamed and gains
  // its title once it has. Set only on the Claude path — a codex peer names a real task.
  peerUnnamed: z.literal(true).optional(),
  // The sender's own RUNTIME agent id (`origin.senderTaskId`) — kept so a LATER pass can finish the job
  // the fold could not. The paged transcript RPC folds a bounded window, so a report whose dispatch
  // scrolled above the page start has no description available at fold time; the tailer still holds the
  // pairing, and `projectTranscriptPeerNames` uses this id to ask it. Never a drawer key on its own —
  // that is `peerDispatchId`, which the same pass can also supply once this resolves.
  peerSenderTaskId: z.string().optional(),
  // FRIZZ REFUSED the ```awaiting fence this message ends in — it named something that is not running,
  // or named nothing at all, or used a retired line kind (see `isParkCorrection`). The fence is not a
  // park, so the chat draws nothing for it: an hourglass card with a park button asserts a wait that
  // frizz declined to arm, and the settled-fence prose beneath it is a handoff the worker is about to
  // write again in its re-fence. Set by the server when it drops the correction that followed, so the
  // signal and the thing it is derived from can never disagree in the browser.
  //
  // Additive + optional: an old client ignores it and renders the fence as it did before.
  fenceRefused: z.literal(true).optional(),
})
export type TranscriptMessage = z.infer<typeof TranscriptMessage>

// Backward transcript pagination is cursor-based rather than an arbitrary message-count offset. A
// cursor is opaque to the browser and binds one projected boundary to its exact session/transcript
// incarnation. `reachedTurnBoundary:false` is the explicit continuation-within-turn contract used
// only when one pathological turn crosses the bounded page ceiling.
export const TranscriptPageCursor = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/)
export type TranscriptPageCursor = z.infer<typeof TranscriptPageCursor>

// A file the thread's worker has WRITTEN — one row of the fullscreen rail's "Edited files", derived
// server-side over the WHOLE projected transcript rather than the latest window the page carries.
// The distinction is the whole reason it rides the page: a worker edits in the middle of an effort
// and verifies at the end, so by the time anyone opens the thread every Edit sits hundreds of
// messages above the window (this repo's own threads: last Edit at record 633 of 2113, 2026-08-28).
export const EditedFile = z.object({
  path: z.string().min(1),
  edits: z.number().int().positive(),
  lastEditedAt: z.string().optional(),
  // The file's diffstat, summed over its write calls (each call's counts are the line counts of its
  // raw old/new sides). A Write counts as all additions — what it replaced is unknowable here.
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
}).strict()
export type EditedFile = z.infer<typeof EditedFile>

export const TranscriptPage = z.object({
  messages: z.array(TranscriptMessage),
  beforeCursor: TranscriptPageCursor.nullable(),
  hasEarlier: z.boolean(),
  reachedTurnBoundary: z.boolean(),
  transcriptKey: z.string().min(1).max(256),
  // The LATEST page only (see EditedFile); an earlier page is settled history and carries none.
  editedFiles: z.array(EditedFile).optional(),
}).strict()
export type TranscriptPage = z.infer<typeof TranscriptPage>

export const TranscriptEarlierInput = z.object({
  slug: ThreadSlug,
  cursor: TranscriptPageCursor,
}).strict()
export type TranscriptEarlierInput = z.infer<typeof TranscriptEarlierInput>

// ---- Terminal WebSocket protocol (ws://host/term/:slug) ----
// client -> server: {t:"input", d:string} | {t:"resize", cols:number, rows:number}
// server -> client: raw utf8 terminal output frames
export type TermClientMsg = { t: "input"; d: string } | { t: "resize"; cols: number; rows: number }

// ---- /ws multiplex protocol (ws://host/ws) — stage 2: ONE socket for board + transcript + notify ----
// The board & notify frames REUSE the stage-1 ServerEvent shapes verbatim (wrapped in {t:"event"}), so the
// client feeds them through the exact same delta/seq/boot handler as SSE (see web/api/board-stream.ts).
// Transcript frames replace the 1.5s threadTranscript poll with server PUSH for subscribed slugs. Terminals
// keep their own /term/:slug socket. Coexists with /events as a graceful fallback (a pre-restart server has
// no /ws route → the client degrades to SSE + polling).

// Client -> server (zod-validated server-side): subscribe / unsubscribe a thread's transcript push.
// Keep the wire identifier aligned with every server-owned thread slug. Besides bounding retained
// subscription state, the shape excludes path separators/control text before it can reach transcript
// lookup code. Foreign session ids are UUID-shaped and remain valid under this grammar.
export const SocketTranscriptSlug = ThreadSlug
// A local file a reader has open — the /full split viewer's or the Markdown drawer's document. The
// bound matches the read RPCs' own; the server gates the path exactly as it gates the read, so a
// file the reader could not read is a file it cannot watch either.
export const SocketFilePath = z.string().min(1).max(4096)
const SocketTranscriptClientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), topic: z.literal("transcript"), slug: SocketTranscriptSlug }).strict(),
  z.object({ t: z.literal("unsub"), topic: z.literal("transcript"), slug: SocketTranscriptSlug }).strict(),
])
// The FILE topic: "tell me when this file changes on disk". The server answers with `file-changed`
// frames carrying the path AS SUBSCRIBED, and the reader re-reads through its gated RPC — the push is a
// notice, never the bytes.
const SocketFileClientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), topic: z.literal("file"), path: SocketFilePath }).strict(),
  z.object({ t: z.literal("unsub"), topic: z.literal("file"), path: SocketFilePath }).strict(),
])
export const SocketClientMsg = z.union([SocketTranscriptClientMsg, SocketFileClientMsg])
export type SocketClientMsg = z.infer<typeof SocketClientMsg>

// server -> client (hand-built by the server, parsed defensively by the client — a plain union, no zod):
//   - {t:"event"}      wraps a ServerEvent (board keyframe / board-delta / notify)
//   - {t:"transcript"} the pushed transcript for a subscribed slug (replaces the poll response)
//   - {t:"payload-too-large"} is a stable, typed transport downgrade. A board overflow moves the client
//     to SSE once; a transcript overflow pauses only that subscription and leaves explicit HTTP refresh.
//   - {t:"resource-limited"} rejects one transcript subscription when the process/origin read budget is
//     exhausted. The board socket stays healthy and the client exposes an explicit retry instead of churn.
//   - {t:"file-changed"} a subscribed local file changed on disk; `path` is the path the client
//     subscribed with, so it keys straight back into the reader's query. No bytes ride this frame.
//   - {t:"hb"}         10s heartbeat so the client's staleness watchdog works as it did over SSE
export type SocketServerMsg =
  | { t: "event"; event: ServerEvent }
  | { t: "transcript"; slug: ThreadSlug; messages: TranscriptMessage[] }
  | { t: "file-changed"; path: string }
  | { t: "payload-too-large"; channel: "board"; actualBytes: number; maxBytes: number }
  | { t: "payload-too-large"; channel: "transcript"; slug: ThreadSlug; actualBytes: number; maxBytes: number }
  | {
      t: "resource-limited"
      resource: "transcript-read"
      scope: "origin" | "global"
      slug: ThreadSlug
      retryAfterMs: number
    }
  | { t: "hb" }

/**
 * One card on the machine's project grid.
 *
 * Everything here comes from the registry index, which is why listing every project costs one file
 * read and never opens a database: the grid must stay cheap enough to be the home page even with
 * forty projects, and opening them to draw cards is exactly the cost lazy activation exists to avoid.
 */
export const ProjectCard = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  path: z.string(),
  lastOpenedAt: z.string(),
  /** The directory is gone — moved or deleted. The card stays so it can be reopened or forgotten. */
  stale: z.boolean(),
  /**
   * When this project's icon was last established, or absent if it never has been.
   *
   * Carried purely so the client can hang it off the `/_frizz/project-icon` URL: the icon bytes are
   * cached hard (a rail of forty squares is forty requests, and none of them should recur), which
   * means a newly uploaded icon would otherwise stay invisible behind the cached old one. A changed
   * version is a changed URL, so the swap is immediate without weakening the caching for everyone.
   *
   * Deliberately NOT "does this project have an icon". Answering that for a project nobody has
   * scanned yet would mean scanning it, and this list is one file read on purpose.
   */
  iconVersion: z.string().optional(),
  /**
   * Whether this project HAS an icon — and crucially, whether we have even looked.
   *
   * Three states, not a boolean, because the two "no icon to draw right now" cases must behave
   * differently and a boolean collapses them:
   *   · `icon`    — one is stored; draw it.
   *   · `none`    — scanned, nothing found. Draw the monogram and DO NOT request the icon route,
   *                 which is what stops an iconless project flashing its initials and then swapping.
   *   · `unknown` — never scanned. The monogram shows, but the request MUST still go out, because
   *                 that request is what triggers the (lazy, cached) scan in the first place.
   *
   * Collapsing `unknown` into `none` deadlocks the whole feature: no image element is rendered, so
   * the icon route is never called, so the scan never runs, so the project stays `unknown` forever.
   * Measured 2026-08-06 — a rail of 29 projects had scanned exactly ONE, and only because a probe
   * had fetched that one's URL by hand.
   */
  iconStatus: z.enum(["icon", "none", "unknown"]),
  /** An operator's uploaded icon, rather than one the scan found. Drives what the menu offers. */
  iconIsCustom: z.boolean().optional(),
})
export type ProjectCard = z.infer<typeof ProjectCard>

/** Formats the icon route will serve — a browser renders each of these in an `<img>`. */
export const PROJECT_ICON_EXTENSIONS = ["png", "svg", "ico", "webp", "jpg", "jpeg", "gif"] as const

/** 4 MB of base64. An app icon that does not fit in this is not an app icon. */
export const PROJECT_ICON_MAX_BASE64_CHARS = 4 * 1024 * 1024

/**
 * What the machine's folder picker came back with.
 *
 * `cancelled` is not an error — it is the commonest outcome after a mis-click, and rendering it as
 * one would put a red message on screen every time someone changed their mind.
 */
export const DirectoryPickResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("picked"), project: ProjectCard }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
])
export type DirectoryPickResult = z.infer<typeof DirectoryPickResult>

/** Where a thread slug actually lives, for a link that no longer says which project it belongs to. */
export const ThreadLocation = z.object({ projectSlug: z.string(), projectName: z.string() })
export type ThreadLocation = z.infer<typeof ThreadLocation>

/**
 * Everything Frizz itself serves lives under this prefix, so the top level stays free for the project
 * routes (`/project/<slug>`) and for the SPA's own route names. Without a reserved namespace the
 * deny-list is a growing list of route names that breaks the day someone clones a repo called
 * `settings`.
 *
 * One constant, exported to both sides, because a server route and the client URL that calls it
 * drifting apart is a 404 that looks like a hung request. The client end is `apiBase()`
 * (web/src/lib/base-path.ts), which appends the project slug; ARCHITECTURE.md § URL shape has the map.
 *
 * (This docstring sat ~80 lines up the file, stacked on ProjectCard's own, until 2026-08-07 — which is
 * why nothing here said where the client half lived.)
 */
export const FRIZZ_ROUTE_PREFIX = "/_frizz"
export function frizzRoute(path: string): string {
  return `${FRIZZ_ROUTE_PREFIX}${path.startsWith("/") ? path : `/${path}`}`
}

/**
 * `http://localhost:9393`.
 *
 * Unassigned in the IANA registry on both TCP and UDP — its neighbours `9390` (OpenVAS) and `9396`
 * are registered and it is not — clear of both Chromium's and Firefox's blocklists (the highest port
 * either blocks is 10080), no dev-tool default, and below every platform's ephemeral floor.
 *
 * Port choice CANNOT buy robustness on Windows: Hyper-V/WSL reservations reported at
 * microsoft/WSL#5514 and #5306 cover 89% of 1024-9999 between them, and every four-digit repeating
 * port is inside a block on at least one of those machines — as are Vite's 5173 and Postgres's 5432.
 * Robustness lives entirely in the fallback below.
 */
export const DEFAULT_PORT = 9393

/**
 * The dev server's own default, so `frizz-dev` never fights the singleton for `9393`.
 *
 * Picked off the same verified shortlist as DEFAULT_PORT: IANA-unassigned on TCP and UDP, on neither
 * browser's blocklist, no tool default. Adjacent by sight for the same reason the fallback is.
 */
export const DEFAULT_DEV_PORT = 9494

/**
 * The primary with a `1` in front: 9393 → 19393.
 *
 * Lands in `10896-24265`, a 13,370-port gap clean on both reported Windows machines, above the
 * highest browser-blocked port and below Linux's ephemeral floor (32768). The band is wide enough
 * that "clean" picks no winner, so the tiebreak is explicability — someone meeting
 * `localhost:19393` is meeting it while something is already going wrong, and it should read at a
 * glance as the same app on its backup port.
 */
export function fallbackPort(base: number): number {
  return base + 10_000
}
// A thread's stable identity string, `frizz-<slug>`. It named a tmux session once; frizz has no tmux,
// and this survives as the integrity check on the session row's `thread_name` column — a row whose
// stored name does not re-derive from its own slug has been tampered with or mis-keyed.
export const threadIdentityName = (slug: string) => `frizz-${ThreadSlug.parse(slug)}`
