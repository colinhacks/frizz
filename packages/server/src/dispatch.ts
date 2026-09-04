import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, mkdirSync, rmSync, type Stats } from "node:fs"
import { basename, join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import {
  AdoptSessionInput,
  AdoptThreadInput,
  DISPATCH_TASK_BANNER_MARKER,
  DispatchInput,
  THREAD_SLUG_MAX_CHARS,
  ThreadSlug,
  slugify,
  threadIdentityName,
  type Settings,
  type PermissionMode,
  type ProviderAuth,
} from "@frizz/shared"
import { log as frizzLog } from "./logging.ts"
import { PERM_DIR_ENV, permRequestDir, type Project } from "./project.ts"
import type { SessionRow, Storage } from "./storage.ts"
import type { BoardManager } from "./board.ts"
import type { AgentBackend, BackendKind, BuiltCommand, FrizzMcp } from "./backend/types.ts"
import { workerMcpServers, type WorkerMcpServers } from "./backend/project-mcp-servers.ts"
import { FRIZZ_MCP, WORKER_DISALLOWED_TOOLS, claudeWorkerEnv, frizzMcpEnv } from "./backend/types.ts"
// The lifted worker caps live beside the shared worker environment they belong to (backend/types.ts).
// Re-exported here because this is where callers have always reached for them.
export { WORKER_MAX_WEB_SEARCHES, WORKER_MAX_SUBAGENTS, WORKER_MAX_CONCURRENT_SUBAGENTS } from "./backend/types.ts"
import { resolveWorkerPluginDir } from "./worker-plugin-dir.ts"
import { buildWorkerPrompt } from "./workerPrompt.ts"
import { codexSandbox, CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS } from "./backend/codex.ts"
import type { CodexAppServerBridge } from "./backend/codex-app-server.ts"
import { claudeBrokerBridgeEnabled, type ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import { claudeUltracodeFlags, resolveClaudeEffort } from "./backend/claude-effort.ts"
import { ProviderAuthRequiredError } from "./backend/auth-status.ts"
import { readBoard, type FrizzBoard, type FrizzThread } from "./frizz.ts"
import { SYSTEM_PROMPT_DIR, cleanupAdoptionSessionFiles, systemPromptPath } from "./session-files.ts"
import {
  ADOPTION_ATTEMPT_LEASE_MS,
  abandonAdoptionAttempt,
  reconcileAdoptionClaims,
  type AdoptionRecoveryRuntime,
  productionRuntime as productionAdoptionRuntime,
} from "./adoption-recovery.ts"

// Dispatch = provision the thread's scratch DIRECTORY + compose the full prompt + fork a detached
// BROKER DAEMON for the session + register the session row. There is no terminal, no multiplexer and
// no TUI anywhere in that chain — see the invariant in ARCHITECTURE.md. A Claude thread is
// `claude_runtime="broker"`, forked by claude-broker-host.ts with `detached: true` into its own
// process group; a Codex thread runs its turns inside the app-server daemon. (Some thirty comments
// below narrated a terminal pane in the present tense until 2026-08-19, which is how reader after
// reader — human and agent — kept re-deriving a transport frizz stopped having.)
// Session-first (2026-07-09): a new dispatch
// writes NO .frizz/<slug>.md thread file — the session IS the thread, and it gets an empty folder
// (.frizz/threads/<sessionId>/) to use as it likes. The prompt is the ONLY intelligence: the worker
// contract + this repo's FRIZZ.md + the scratch orientation + the task. Project-specific conventions
// live in FRIZZ.md alone — the old settings `dispatchPreamble` was retired in favour of it, so there is
// exactly ONE operator-authored surface.

// title -> slug. The rule itself lives in @frizz/shared beside the ThreadSlug contract (the
// registry's boot repair recognises dispatch-minted slugs with it); re-exported here because every
// caller reaches for it through the dispatcher.
export { slugify }

// Derive a concrete thread title from the prompt when the human didn't supply one: the first ~6
// words of the prompt's first line, capped at 48 chars, ellipsized if anything was dropped. The
// thread FILE always needs a title (frizz requires one) and the slug derives from it, so this never
// returns empty. Claude later renames the session (ai-title), which the UI prefers for display.
// Leading filler that carries no topic ("also spin up…", "please go ahead and…") and trailing
// function words a truncation must never end on (the old first-6-words cut produced slugs like
// "also-spin-up-a-sub-agent-to" — a dangling mid-phrase chop that reads as garbage in .frizz/).
const LEAD_FILLER = new Set(["also", "please", "and", "then", "now", "ok", "okay", "hey", "just", "so", "well", "next", "go", "ahead", "lets", "let's", "can", "you", "could", "would"])
const TRAIL_STOP = new Set([
  "to", "a", "an", "the", "of", "for", "with", "in", "on", "at", "by", "and", "or", "but", "that",
  "this", "it", "is", "are", "be", "as", "into", "from", "my", "our", "your", "their",
])

export function fallbackTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n", 1)[0].trim()
  let allWords = firstLine.split(/\s+/).filter(Boolean)
  // Strip topic-free lead-ins, but never below two words of substance.
  while (allWords.length > 2 && LEAD_FILLER.has(allWords[0].toLowerCase().replace(/[^a-z]/g, ""))) allWords = allWords.slice(1)
  let words = allWords.slice(0, 6)
  // Never END on a dangling function word — back off (keeping at least two words).
  while (words.length > 2 && TRAIL_STOP.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ""))) words = words.slice(0, -1)
  let t = words.join(" ")
  let truncated = words.length < allWords.length
  if (t.length > 48) {
    t = t.slice(0, 47).trimEnd()
    truncated = true
  }
  if (truncated) t += "…"
  return t || "thread"
}

// First free slug: <base>, then <base>-2, -3, … skipping any existing .frizz/<slug>.md AND any taken
// registry slug (session-first: new dispatches have no .frizz file, so uniqueness must also clear the
// storage rows — else two fileless sessions could collide on a slug). `taken` is the row predicate.
export function resolveSlug(frizzDir: string, base: string, taken?: (slug: string) => boolean): string {
  base = ThreadSlug.parse(base)
  const isTaken = (slug: string) => existsSync(join(frizzDir, `${slug}.md`)) || (taken?.(slug) ?? false)
  if (!isTaken(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const stem = base.slice(0, THREAD_SLUG_MAX_CHARS - suffix.length).replace(/-+$/g, "") || "thread"
    const candidate = ThreadSlug.parse(`${stem}${suffix}`)
    if (!isTaken(candidate)) return candidate
  }
}

interface LegacyThreadFileIdentity {
  path: string
  realPath: string
  contents: Buffer
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  digest: string
}

function sameFileStat(a: LegacyThreadFileIdentity, b: LegacyThreadFileIdentity): boolean {
  return a.path === b.path && a.realPath === b.realPath && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.digest === b.digest
}

// Resolve an adoption source without ever accepting an indirect path. Both `.frizz` and the selected
// markdown file must be real (not symlink) direct children of the real project root. Reading the file
// into the identity digest closes replacement/content races across the fresh-board authorization pass.
export function resolveLegacyThreadFile(projectDir: string, value: unknown): LegacyThreadFileIdentity | null {
  const parsed = ThreadSlug.safeParse(value)
  if (!parsed.success) return null
  try {
    const projectRoot = realpathSync(projectDir)
    const frizzPath = join(projectRoot, ".frizz")
    const frizzStat = lstatSync(frizzPath)
    if (!frizzStat.isDirectory() || frizzStat.isSymbolicLink()) return null
    const realFrizz = realpathSync(frizzPath)
    if (dirname(realFrizz) !== projectRoot || basename(realFrizz) !== ".frizz") return null

    const path = join(realFrizz, `${parsed.data}.md`)
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink()) return null
    const realPath = realpathSync(path)
    if (dirname(realPath) !== realFrizz || basename(realPath) !== `${parsed.data}.md`) return null
    let contents: Buffer
    let openedBefore: Stats
    let openedAfter: Stats
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      openedBefore = fstatSync(fd)
      contents = readFileSync(fd)
      openedAfter = fstatSync(fd)
    } finally {
      closeSync(fd)
    }
    const after = lstatSync(path)
    if (before.dev !== openedBefore.dev || before.ino !== openedBefore.ino ||
        openedBefore.dev !== openedAfter.dev || openedBefore.ino !== openedAfter.ino ||
        openedBefore.size !== openedAfter.size || openedBefore.mtimeMs !== openedAfter.mtimeMs ||
        openedBefore.ctimeMs !== openedAfter.ctimeMs || after.dev !== openedAfter.dev ||
        after.ino !== openedAfter.ino || after.size !== openedAfter.size ||
        after.mtimeMs !== openedAfter.mtimeMs || after.ctimeMs !== openedAfter.ctimeMs ||
        !openedAfter.isFile() || !after.isFile() || after.isSymbolicLink()) {
      return null
    }
    return {
      path,
      realPath,
      contents,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      digest: createHash("sha256").update(contents).digest("hex"),
    }
  } catch {
    return null
  }
}

const ADOPTABLE_LEGACY_STATUSES = new Set(["planning", "planned", "active", "needs-human", "blocked"])

export function isAdoptableLegacyBoardThread(thread: FrizzThread, slug: string): boolean {
  return thread.id === slug &&
    ADOPTABLE_LEGACY_STATUSES.has(thread.status) &&
    thread.owner == null &&
    Array.isArray(thread.agents) && thread.agents.length === 0 &&
    Array.isArray(thread.errors) && thread.errors.length === 0
}

function boardAuthorizesAdoption(board: FrizzBoard, slug: string): boolean {
  const matches = board.threads.filter((thread) => thread.id === slug)
  if (matches.length !== 1 || !isAdoptableLegacyBoardThread(matches[0], slug)) return false
  return !board.errorItems.some((item) => item.file === `${slug}.md`)
}

function ensureSafeDirectDirectory(parent: string, name: string): string {
  const path = join(parent, name)
  try {
    mkdirSync(path)
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (code !== "EEXIST") throw error
  }
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe project directory")
  const real = realpathSync(path)
  if (dirname(real) !== parent || basename(real) !== name) throw new Error("unsafe project directory")
  return real
}

// ---- THE THREAD SCRATCH DIRECTORY ----------------------------------------------------------------
// `.frizz/threads/<sessionId>/` — a folder the worker and its sub-agents may use however they like, and
// nothing more than that. NOTHING is provisioned into it: no skeleton, no reserved filename, no format.
//
// It REPLACED a canonical `scratch.md` (2026-08-06, maintainer's call). That pad was one file every
// worker was told to maintain, whose head a hook spliced into the context after a compaction, and whose
// sharing with sub-agents needed a whole merge-only contract — an epilogue per backend, a legend line in
// every provisioned pad, and a paragraph of the worker contract — all of it existing only to stop
// children clobbering the one file. A folder deletes that surface outright: each agent writes its OWN
// file, so there is nothing to merge and nothing to clobber.
//
// What replaced the compaction injection is `mcp__frizz__goal`'s POST-COMPACTION trigger
// (scheduler SOURCE 7). The worker links whatever doc it wrote here and frizz hands that link back the
// moment the context is summarized away. Durable in SQLite, and visible to the operator — which the hook
// injection never was.
export function scratchDirRelPath(sessionId: string): string {
  return `.frizz/threads/${sessionId}`
}

// Provision the thread's scratch directory. Creates the folder and NOTHING inside it, returning the
// project-relative path. sessionId is a fresh UUID at both dispatch and adopt, so this never collides.
export function writeScratchDir(projectDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId)) throw new Error("invalid session id")
  const projectRoot = realpathSync(projectDir)
  const frizzDir = ensureSafeDirectDirectory(projectRoot, ".frizz")
  const threadsDir = ensureSafeDirectDirectory(frizzDir, "threads")
  ensureSafeDirectDirectory(threadsDir, sessionId)
  return scratchDirRelPath(sessionId)
}

// The FIXED worker system prompt for `kind`, compiled in via workerPrompt.ts (single source of truth).
// Not user-modifiable — project-specific conventions ride FRIZZ.md (frizzConfigBlock), appended
// separately. Thin adapter kept so existing callers (spawn/adopt/resume builders + tests) are untouched.
export function loadWorkerPrompt(kind: BackendKind = "claude"): string {
  return buildWorkerPrompt(kind, { monitorsDir: monitorScriptsDir() })
}

// The portable CI/review monitors, which ship inside the worker plugin (`sync-portable-monitors.mjs`
// copies `monitors/` there, and `runtime/cc-worker` carries them in a published artifact). Claude finds
// them through the `frizz:gh` skill; codex has no skills, so its prompt needs the absolute path or the
// model writes its own poll loop instead. Verified against a real file rather than assumed, so a layout
// change degrades to the prompt's relative fallback instead of naming a directory that isn't there.
export function monitorScriptsDir(): string | undefined {
  const plugin = workerPluginDir()
  if (!plugin) return undefined
  const dir = join(plugin, "skills", "gh", "scripts")
  return existsSync(join(dir, "ci-watch.mjs")) ? dir : undefined
}

// ---- scratch-directory re-orientation (always on) ----
// Deliberately NOT settings-gated. A worker that has just lost its context should always be told what
// it left itself, and that is not a posture a project opts into. Claude needs no plumbing at all here
// (the plugin's hooks.json is always registered); codex does, because its hooks can only arrive as
// per-conversation config.
//
// Measured against codex-cli 0.144.6, and the reason this is config rather than argv or a file:
// `codex exec` runs NO hooks from ANY discovery path (repo `.codex/hooks.json`,
// `$CODEX_HOME/hooks.json`, `-c hooks.…`), with or without trust bypass — while the app-server DOES
// run them when they arrive as config overrides on the conversation. `bypass_hook_trust` is required
// because codex SILENTLY SKIPS untrusted hook definitions, which is indistinguishable from a broken
// feature.
//
// NOTE the deliberate asymmetry with Claude: codex exposes NO PreCompact/PostCompact context-injection
// wire type (only SessionStart / UserPromptSubmit / PostToolUse / PreToolUse / PermissionRequest /
// SubagentStart have one), so the summarizer-steering channel is Claude-only. The load-bearing
// channel — restoring the pad on SessionStart(compact) — is available on both.
export function codexScratchpadHookConfig(
  hookScript: string | undefined,
  sessionId: string
): Record<string, unknown> {
  if (!hookScript || !sessionId) return {}
  // `--session` is mandatory: codex reports its OWN rollout session id to the hook, so without frizz's
  // thread id the hook would resolve a scratchpad path that does not exist.
  const cmd = (mode: string) => ({
    hooks: [
      {
        type: "command",
        command: `node ${JSON.stringify(hookScript)} --session=${JSON.stringify(sessionId)} ${mode}`,
      },
    ],
  })
  const bashBackgroundHook = join(dirname(hookScript), "bash-background.mjs")
  return {
    bypass_hook_trust: true,
    hooks: {
      // Codex canonicalizes both direct and unified exec_command calls as Bash and exposes their
      // command at tool_input.command. Register the same lifecycle guard as Claude; the explicit flag
      // is necessary because the shared app-server daemon cannot carry a per-conversation env marker.
      PreToolUse: [{
        matcher: "^Bash$",
        hooks: [{
          type: "command",
          command: `node ${JSON.stringify(bashBackgroundHook)} --frizz-thread`,
        }],
      }],
      // Native Codex children inherit the root scratch-directory instruction even with
      // `fork_turns:"none"`. Constrain it structurally at child start: its OWN file, never another
      // agent's.
      SubagentStart: [cmd("--mode=subagent-start")],
      SessionStart: [cmd("--mode=session-start")],
      UserPromptSubmit: [cmd("--mode=nudge")],
      PostToolUse: [cmd("--mode=nudge --event=PostToolUse")],
    },
  }
}

/** Absolute path to the scratchpad hook inside the discovered worker plugin, when there is one. */
export function scratchpadHookScript(): string | undefined {
  const plugin = workerPluginDir()
  return plugin ? join(plugin, "hooks", "scratchpad.mjs") : undefined
}

// The first USER message a dispatched agent receives: scratch-directory orientation + custom
// instructions + task. Session-first (2026-07-09) — the old thread-ownership contract is REPLACED by
// this orientation (a new dispatch owns no .frizz file). The fixed worker prompt (workerPrompt.ts) and
// the same scratch line at SYSTEM level travel via --append-system-prompt (see buildClaudeCommand) so
// they survive compaction and re-apply on resume; this composes the visible-message half.
export function composePrompt(sessionId: string, prompt: string, kind: BackendKind = "claude"): string {
  // The sub-agent clause is the ONE thing that differs between backends here: Claude's children are
  // dispatched with a prompt this worker writes, so it must be told to name the directory in it; codex's
  // native children inherit the conversation and already have it.
  const children =
    kind === "codex"
      ? "Native sub-agents share it — have each write its OWN file rather than all editing one."
      : "Name it in a sub-agent's prompt when you want its notes to land somewhere you can read; give each child its OWN file rather than having them all edit one."
  const scratch =
    `Your scratch directory is \`.frizz/threads/${sessionId}/\` — yours to use however you like, for as many files as you like. It is EMPTY and nothing is expected in it: a single direct task usually needs nothing, and writing notes is never a substitute for doing the work. ${children} Nothing here is read automatically; if you ever want a note to come back after a compaction, \`mcp__frizz__goal\` with \`post_compaction: true\` re-sends a prompt of your choosing — one that can link a file here — into the emptied window.`
  // The banner makes the system→human handoff unmistakable to the worker, and NOTHING of frizz's is
  // allowed below it: the framing note goes here, ABOVE, so everything past the banner is the
  // operator's prompt byte for byte. That is also what the transcript projectors cut on
  // (DISPATCH_TASK_BANNER_MARKER), so the first chat bubble shows the operator's words alone.
  const handoff =
    "\n\nEverything above the banner below is frizz system orientation. Everything below it is the human operator's own prompt, verbatim — that, and nothing else, is your task."
  return `${scratch}${handoff}\n\n\n${DISPATCH_TASK_BANNER_MARKER}${prompt}`
}

// The SYSTEM-level scratch-directory orientation (survives compaction, rebuilds on every resume).
// Passed as extraSystemPrompt on dispatch, adopt, AND the followUp resume path.
//
// It names the POST-COMPACTION trigger as an available capability, never a prescription (maintainer
// 2026-08-28: say the directory is there if the worker wants it and that the goal hooks exist — do
// not push arming as the thing to do).
export function scratchpadOrientation(sessionId: string, kind: BackendKind = "claude"): string {
  const children =
    kind === "codex"
      ? "native sub-agents share it, so give each its own file"
      : "name it in a sub-agent's prompt when you want its notes back, and give each child its own file"
  return `SCRATCH DIRECTORY: .frizz/threads/${sessionId}/ — yours, free-form, as many files as you like, and nothing is expected in it. A single direct task usually needs none; writing notes is never a substitute for doing the work (${children}). Nothing in this directory is read automatically; if you want a note back after a compaction, mcp__frizz__goal with post_compaction: true re-sends a prompt of your choosing.`
}

// A project can ship a repo-committed `FRIZZ.md` at its root to steer frizz workers with its OWN
// engineering-PROCESS norms — gates, review depth, commit/PR conventions — which OVERRIDE frizz's
// built-in PROCESS defaults (NOT the frizz-mechanical contract: signal fences, scratchpad, sub-agent
// dispatch and the question handback stay in force — the injected header says so, matching the "Defer"
// section of the worker contract). When present, its contents are injected into every worker's SYSTEM
// prompt (dispatch, adopt, AND resume; both backends) under that header, so both see it without relying on the
// agent choosing to open the file. Read fresh on every spawn/resume, so an edit takes effect on the
// next launch.
//
// The read is guarded by statSync BEFORE readFileSync: only a regular file under a size cap is read.
// That keeps one accidental/hostile FRIZZ.md from wedging the server's event loop on EVERY dispatch and
// resume — a FIFO would make readFileSync block forever, a symlink loop throws, a directory/device
// isn't a regular file, and a runaway/generated file is rejected by size rather than fully slurped.
// The surviving content is then clipped to keep token/context cost bounded. Returns "" when
// absent/oversized/non-regular/empty — the caller drops it from the composed extra-system-prompt.
//
// THE CLIP IS SILENT TO EVERYONE WHO MATTERS, so the cap has to clear a REAL file rather than look
// prudent. At 12,000 it did not: this repo's own FRIZZ.md was 16,522 characters on 2026-08-28, so
// every worker frizz dispatched here lost the last 4,522 — beginning exactly at "## Git: land on
// local `main` — NEVER open a pull request", the rule CLAUDE.md calls the most-violated one in the
// repo. The marker says `[FRIZZ.md truncated]`, and nobody reads their own system prompt to find it.
// 24,000 characters is ~6k tokens, against a contract already several times that, and it clears the
// real file with 45% headroom. `frizzConfigBlock injects this repo's own FRIZZ.md IN FULL` fails
// LOUDLY the next time the file outgrows it, which is the actual guard — the number is only a number.
const FRIZZ_MD_MAX_CHARS = 24_000
const FRIZZ_MD_MAX_BYTES = 64 * 1024
export function frizzConfigBlock(projectDir: string): string {
  const path = join(projectDir, "FRIZZ.md")
  let body: string
  try {
    const st = statSync(path) // follows a symlink to its target; ENOENT/ELOOP throw → caught
    if (!st.isFile() || st.size > FRIZZ_MD_MAX_BYTES) return "" // not a regular file, or runaway size
    body = readFileSync(path, "utf8").trim()
  } catch {
    return "" // no FRIZZ.md, unreadable, symlink loop, etc. → inject nothing
  }
  if (!body) return ""
  const clipped = body.length > FRIZZ_MD_MAX_CHARS ? `${body.slice(0, FRIZZ_MD_MAX_CHARS)}\n\n[FRIZZ.md truncated]` : body
  return `PROJECT FRIZZ CONFIG (from this repo's FRIZZ.md) — the project's own conventions for frizz workers. They OVERRIDE the frizz worker PROCESS defaults above (review depth, gates, git/PR conventions, the quality bar) wherever they conflict; follow them. They do NOT relax the frizz-mechanical contract — the signal fences, the scratchpad, sub-agent dispatch and the question handback still bind:\n\n${clipped}`
}

// Workers have NO coherent interactive-plan-mode semantics: plan mode stays read-only until an
// INTERACTIVE ExitPlanMode approval, which a headless dashboard worker can't satisfy (no one is at
// the keyboard) and which blocks all edits until then — a softlock. A worker "plans" by writing a
// durable plan file and asking via a ```question fence, never via interactive plan
// mode. So a worker is NEVER spawned in plan mode: `plan` is coerced to the safe frizz default
// (`auto`). Applied inside BOTH spawn builders so dispatch, adopt, AND resume are all covered. (The
// dispatch UI still OFFERS "plan" in its permission-mode dropdown — dropping it in web/options.ts is
// a follow-up for UI honesty; this coercion is the actual enforcement + the softlock fix.)
function workerPermissionMode(m: PermissionMode): PermissionMode {
  return m === "plan" ? "auto" : m
}

// Every frizz-CREATED worker launches maximally non-interactive: an unattended headless worker cannot
// answer an interactive prompt, so a RESTRICTIVE dispatch-time permission choice is a footgun, not a
// feature — it just stalls the thread on a modal nobody is watching. Claude gets `auto`; codex gets
// `bypassPermissions` (→ `-s danger-full-access`). These are the FLOOR the dispatch/adopt paths stamp
// (a client-sent permissionMode is still ignored); the only thing that moves it is the operator's own
// Settings choice — see workerDispatchPermission, which can only relax it further.
export const WORKER_DISPATCH_PERMISSION: Record<BackendKind, PermissionMode> = {
  claude: "auto",
  codex: "bypassPermissions",
}

// The permission mode a NEW worker of `kind` actually launches with, given the operator's Settings.
//
// Only ONE deviation from WORKER_DISPATCH_PERMISSION is honored: a Claude worker may be dispatched in
// `bypassPermissions` (claude's `--dangerously-skip-permissions`) when Settings asks for it. That
// direction is safe for a headless worker BECAUSE it is strictly more permissive than `auto` — nothing
// can stall on an unanswerable prompt. The restrictive modes stay unreachable on purpose: `default`,
// `acceptEdits` and `plan` are the softlock this function's floor exists to prevent, so a stored value
// left over from an older build (Settings.permissionMode predates this control and accepts the whole
// enum) coerces back to the floor rather than quietly wedging every dispatch. Codex has no equivalent
// axis to raise — it already launches at danger-full-access.
export function workerDispatchPermission(kind: BackendKind, settings: Pick<Settings, "permissionMode">): PermissionMode {
  if (kind === "claude" && settings.permissionMode === "bypassPermissions") return "bypassPermissions"
  return WORKER_DISPATCH_PERMISSION[kind]
}

// Canonical value that describes the permission policy the backend ACTUALLY receives. Claude's
// headless-worker plan request is coerced to auto (above); Codex's three sandbox levels share the
// PermissionMode storage field, so all workspace-write aliases collapse to `default`.
export function effectivePermissionMode(kind: BackendKind, mode: PermissionMode): PermissionMode {
  if (kind === "claude") return workerPermissionMode(mode)
  if (mode === "plan" || mode === "bypassPermissions") return mode
  return "default"
}

// The assembled system prompt (worker norms + spawn-specific orientation) is ~16KB — passing it
// inline as `--append-system-prompt <text>` puts all 16KB on the launch command line. That is what
// broke every spawn on 2026-07-09 (100% of dispatch/adopt/resume): the terminal multiplexer frizz
// launched workers through back then capped its command length and failed each one with a silent
// "command too long". That launch path is retired, but a command line is a bounded resource in its
// own right (execvp's ARG_MAX), so the fix stays: claude accepts `--append-system-prompt-file
// <path>`, so we write the prompt to a per-session file and pass the (short) path instead — the argv
// stays tiny. Written per invocation (dispatch AND resume) into a stable per-session path, so a resume
// after OS temp-cleanup just rewrites it. Returns the flag pair to splice into argv (empty if no
// system prompt). NOTE: keep using `--append-system-prompt` for genuinely SHORT text would also
// work, but a single file path is uniformly safe regardless of prompt growth.
function systemPromptFlags(sessionId: string, system: string): string[] {
  if (!system) return []
  mkdirSync(SYSTEM_PROMPT_DIR, { recursive: true })
  const path = systemPromptPath(sessionId)
  writeFileSync(path, system)
  return ["--append-system-prompt-file", path]
}

/** Where the frizz MCP server should look for the running server, and whose board it acts on. */
export interface FrizzMcpTarget {
  /** THIS project's state dir. Identity, and the lock path a pre-singleton server published. */
  stateDir: string
  /** The LAUNCHING project's `server.lock` — the only one this process writes. See FrizzMcp. */
  serverLock?: string
  /** THIS project's registry id, so the script addresses `/_frizz/<id>/rpc/…` and not the launcher's. */
  projectId?: string
}

// Resolve the descriptor for the unified frizz MCP server: the abs path to the stdio server script
// (shipped as a sibling of bin/frizz in the worker plugin dir, so it rides the SAME ship+resolve path
// that already carries the plugin to prod) + where the script finds the running server and which
// project it addresses. Returns undefined when the plugin dir or script can't be found — the worker
// then simply lacks the frizz tools rather than failing to spawn. `env`/`moduleUrl` injectable for
// tests. A bare state dir is still accepted (one project, one server: the pre-singleton shape).
export function resolveFrizzMcp(
  target: string | FrizzMcpTarget,
  moduleUrl = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
  slug?: string,
): FrizzMcp | undefined {
  const { stateDir, serverLock, projectId } = typeof target === "string" ? { stateDir: target } : target
  const pluginDir = resolveWorkerPluginDir(moduleUrl, env)
  if (!pluginDir) return undefined
  const scriptPath = join(pluginDir, "bin", FRIZZ_MCP.script)
  if (!existsSync(scriptPath)) return undefined
  return {
    scriptPath,
    stateDir,
    ...(serverLock ? { serverLock } : {}),
    ...(projectId ? { projectId } : {}),
    ...(slug ? { slug } : {}),
  }
}

// Claude flags that mount a worker's MCP servers via ONE inline `--mcp-config` JSON and PRE-APPROVE
// the frizz server's tools (`--allowedTools`) so a headless worker never blocks on a permission prompt
// it has nobody to answer. The argv is exec'd with NO shell in between, so the JSON travels literally.
// The unified `frizz` server is the ONLY server frizz itself injects, and only when its descriptor
// resolved — frizz injects no browser and nothing else (see backend/types.ts). Everything else a
// worker mounts is the PROJECT's: since 2026-09-03 every worker runs under `--strict-mcp-config`, so
// the CLI discovers no `.mcp.json` and no user-scope server on its own, and the project's approved
// servers ride this same inline config (`project`, from project-mcp-servers.ts — which is also where
// the reasons live: a user-scope stdio server was booting in EVERY worker, twice over).
export interface ClaudeMcpStdioConfig { command: string; args?: string[]; env?: Record<string, string> }
export interface ClaudeMcpConfig { mcpServers: WorkerMcpServers; allowedTools: string[] }

// The structured frizz MCP mount, shared by the `claude` CLI argv (rendered to --mcp-config/
// --allowedTools flags below) AND the broker SDK path (passed straight into query()'s mcpServers/
// allowedTools). One source of truth so both forms mount the SAME servers with the SAME pre-approvals.
export function claudeMcpConfig(mcp?: FrizzMcp, project?: WorkerMcpServers): ClaudeMcpConfig {
  const mcpServers: WorkerMcpServers = {}
  const allowedTools: string[] = []
  if (mcp) {
    // command is the ABSOLUTE node path (process.execPath — the node running the frizz server), NOT bare
    // "node": Claude spawns the MCP-server process itself, and a worker's PATH varies by launch context
    // (a GUI-launched frizz, a login-shell difference) — if `node` isn't on it, the MCP server never
    // starts and the tool silently never appears in the worker. An absolute path removes that dependency.
    // FRIZZ_THREAD_SLUG is the MCP server's CALLER IDENTITY — the channel through which a tool could act
    // on its own thread. The MCP server is spawned per worker and nothing in the MCP protocol carries a
    // caller identity, so its env is the only place this can come from; a resume keeps the same slug, so
    // it stays correct for the whole life of the thread. TEN tools read it (`title`, `ask`, `unask`,
    // `done`, `watch`, `unwatch`, `watch_pr`, `timer`, `goal`, `activity`) and every one of them fails
    // without it — the comment here said "No SHIPPED tool reads it today" long after that stopped being
    // true, and the codex side went unfixed behind that belief until 2026-09-04.
    // FRIZZ_SERVER_LOCK and FRIZZ_PROJECT_ID (frizzMcpEnv) are what make the tools work in a project
    // the singleton did NOT launch from: the first says where the one published lock is, the second
    // says whose board to act on. Both omitted ⇒ the script keeps its original behaviour (this
    // project's own lock, unprefixed RPC), which is exactly right for one project on its own server.
    const env = frizzMcpEnv(mcp)
    mcpServers[FRIZZ_MCP.name] = { command: process.execPath, args: [mcp.scriptPath], env }
    // SERVER-level, not per tool: every tool the unified frizz server exposes (today
    // `mcp__frizz__spawn_thread`) is pre-approved, so adding one never needs an allow-list edit.
    allowedTools.push(`mcp__${FRIZZ_MCP.name}`)
  }
  // The project's servers underneath, frizz's on top: a project cannot shadow `frizz` by naming a server
  // after it. Only the frizz server is pre-approved — a project server keeps the approval story it had.
  return { mcpServers: workerMcpServers(project, mcpServers), allowedTools }
}

// The argv rendering of claudeMcpConfig above.
export function claudeMcpFlags(mcp?: FrizzMcp, project?: WorkerMcpServers): string[] {
  const { mcpServers, allowedTools } = claudeMcpConfig(mcp, project)
  // `--strict-mcp-config` ALWAYS, even with nothing to mount: the flag is what keeps the operator's
  // user-scope servers out of the worker, and a worker with no servers is still one that must not boot
  // them. NOTHING mounted ⇒ no OTHER flags. That state became reachable when the always-on browser
  // mount was removed (a checkout whose worker plugin does not resolve has no frizz descriptor either),
  // and an empty `--allowedTools=` is not the same as omitting it — it hands the CLI one rule that is
  // the empty string. Emit neither rather than two empty ones.
  const argv = ["--strict-mcp-config"]
  if (Object.keys(mcpServers).length === 0) return argv
  const config = JSON.stringify({ mcpServers })
  // ONE comma-joined `--allowedTools=` in EQUALS form: the flag is VARIADIC, so a space-separated
  // value with a positional right behind it (e.g. the minimal no-system-prompt argv, where the prompt
  // directly follows) would be swallowed as a second rule. The equals form binds exactly one token —
  // immune to argv reordering. Verified live: `claude -p --allowedTools=mcp__frizz <prompt>` runs the
  // tools unprompted with the prompt surviving as the positional.
  argv.push("--mcp-config", config)
  if (allowedTools.length > 0) argv.push(`--allowedTools=${allowedTools.join(",")}`)
  return argv
}

// A frizz worker runs under a dashboard, not a live chat, so a BLOCKING question tool would hang the
// session invisibly — there is nobody at the keyboard to click it. Remove it at spawn rather than
// arguing against it in prose: the contract used to spend a paragraph on "NEVER invoke it" AND a
// PreToolUse hook denied it, three mechanisms for one prohibition. Taking the tool away is the cheap
// one, and it makes the other two unnecessary (the hook stays as belt-and-braces for a session that
// somehow reaches the tool anyway). EQUALS form for the same reason as --allowedTools: the flag is
// variadic and a space-separated value would swallow the positional prompt behind it.
//
// This is the CLI-argv path only. The broker deliberately does NOT drop the same tool — it can put the
// question in front of the operator as a card — so the list lives in WORKER_DISALLOWED_TOOLS
// (backend/types.ts) where that asymmetry is written down rather than being inferable only from a
// missing call site.
export function workerDisallowedToolFlags(): string[] {
  return [`--disallowedTools=${WORKER_DISALLOWED_TOOLS.join(",")}`]
}

// The `claude` argv for a fresh dispatch. session-id is PINNED so we can resume the exact
// conversation later. claudeBin is injectable so tests build the command without spawning.
export function buildClaudeCommand(opts: {
  sessionId: string
  permissionMode: PermissionMode
  model?: string
  effort?: string
  prompt: string
  claudeBin?: string
  pluginDir?: string
  // Injectable for tests; defaults to the compiled-in worker contract ("" disables the append).
  workerPrompt?: string
  // Extra spawn-specific system-prompt text appended AFTER the worker norms (e.g. the adoption
  // orientation) — system-level so the visible transcript carries only the human's own words.
  extraSystemPrompt?: string
  frizzMcp?: FrizzMcp
  projectMcpServers?: WorkerMcpServers
}): string[] {
  const argv = [opts.claudeBin ?? "claude", "--session-id", opts.sessionId, "--permission-mode", workerPermissionMode(opts.permissionMode)]
  // NO 1M window here, deliberately. The broker spawn requests it (claude-context-window.ts), but only
  // because it can pair the request with `fallbackModel` — and `--fallback-model` is documented
  // "(only works with --print)", which this interactive argv is not. An unpaired `[1m]` is a hard 400
  // that kills the session on any subscription without the long-context beta, so this path asks for
  // nothing. It costs no live thread: every claude row is stamped claude_runtime="broker" at dispatch
  // and never migrated (isBrokerClaudeRow), so this argv is the legacy transport.
  if (opts.model) argv.push("--model", opts.model)
  // "ultracode" is a settings flag, not an --effort value, and it only takes when the pinned effort is
  // xhigh — see resolveClaudeEffort.
  const effort = resolveClaudeEffort(opts.effort)
  if (effort.effort) argv.push("--effort", effort.effort)
  argv.push(...claudeUltracodeFlags(effort))
  if (opts.pluginDir) argv.push("--plugin-dir", opts.pluginDir)
  argv.push(...claudeMcpFlags(opts.frizzMcp, opts.projectMcpServers))
  argv.push(...workerDisallowedToolFlags())
  // The fixed worker norms live in the SYSTEM prompt: rebuilt on every invocation (incl. resume)
  // and immune to compaction, unlike a first user message.
  const worker = opts.workerPrompt ?? loadWorkerPrompt()
  const system = [worker, opts.extraSystemPrompt?.trim()].filter(Boolean).join("\n\n")
  argv.push(...systemPromptFlags(opts.sessionId, system))
  argv.push(opts.prompt)
  return argv
}

// The frizz-worker plugin directory. The implementation lives in worker-plugin-dir.ts: it moved there
// so backend/types.ts could resolve the plugin's bin/ for the browser-MCP proxy without importing this
// module and closing an import cycle. That mount is gone (2026-08-26) and nothing outside this file
// imports the leaf any more, but the split is harmless and moving it back would churn every caller —
// it is re-exported here because this is where every caller and every test has always reached for it.
export { resolveWorkerPluginDir } from "./worker-plugin-dir.ts"

// Whether the "no worker plugin" alarm has already sounded in this process — the condition is a
// property of the INSTALL, not of any one dispatch, so it is worth exactly one loud line.
let missingPluginReported = false

/**
 * The production entry point for the plugin directory. `resolveWorkerPluginDir` stays the pure,
 * injectable one that tests drive with a synthetic module URL and legitimately expect `undefined` from.
 *
 * IT SHOUTS WHEN IT CANNOT RESOLVE, because every consumer of this value FAILS OPEN and does so in
 * silence: `if (opts.pluginDir) argv.push(…)`, `if (!pluginDir) return undefined`, `return plugin ? … :
 * undefined`. A worker dispatched without it loses the worker-contract hooks, the `frizz:*` sub-agent
 * profiles, the frizz MCP tools (spawn_thread / goal / timer), the on-demand skills AND the
 * portable monitors — all five ride this one directory — and it still boots perfectly happily.
 * Measured against the real CLI on 2026-08-11: with the plugin dir a worker reports 16 `frizz:*` agent
 * types; with a path that does not exist it answers the prompt normally, exit 0, no error, no warning.
 * Nothing on the board would ever say so.
 *
 * That fail-open-and-say-nothing shape is not hypothetical here. The three defects a single directory
 * rename caused this week — a `core.hooksPath` into the old path, an untrusted codex project, and every
 * transcript stranded in the old bucket — were each invisible for days for exactly this reason. So the
 * one thing this MUST not do is fail quietly too.
 */
export function workerPluginDir(): string | undefined {
  const dir = resolveWorkerPluginDir()
  if (!dir && !missingPluginReported) {
    missingPluginReported = true
    frizzLog.error(
      "dispatch",
      "worker plugin NOT FOUND (no cc-worker/.claude-plugin/plugin.json among this module's ancestors, and " +
        "FRIZZ_WORKER_PLUGIN_DIR is unset or unverifiable). Workers dispatched now will silently lack the " +
        "worker contract hooks, the frizz:* sub-agent profiles, the frizz MCP tools and the portable monitors.",
    )
  }
  return dir
}

// The argv builder's own additions on top of that. The two profile masks stay ARGV-ONLY: they exist
// because a `claude` process inherits a shell's environment, and the broker's worker environment is
// composed rather than inherited.
export function claudeWorkerEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    ...claudeWorkerEnv(env),
    CLAUDE_CODE_SUBAGENT_MODEL: "",
    CLAUDE_CODE_EFFORT_LEVEL: "",
  }
}

// The `claude` argv to RESUME an existing session with a follow-up — the COLD form, which reopens the
// pinned conversation from disk because there is no live worker left to hand the message to.
export function buildClaudeResumeCommand(opts: {
  sessionId: string
  permissionMode: PermissionMode
  model?: string
  effort?: string
  message?: string
  claudeBin?: string
  pluginDir?: string
  workerPrompt?: string
  // Extra system-prompt text appended AFTER the worker norms (e.g. the scratchpad orientation) — the
  // system prompt is rebuilt per invocation, so a resume must re-carry it or the scratchpad is forgotten.
  extraSystemPrompt?: string
  // The frizz MCP server must ride resume too (a resumed worker keeps the capability).
  frizzMcp?: FrizzMcp
  projectMcpServers?: WorkerMcpServers
}): string[] {
  const argv = [opts.claudeBin ?? "claude", "--permission-mode", workerPermissionMode(opts.permissionMode)]
  if (opts.model) argv.push("--model", opts.model)
  // Ultracode is session-scoped, so a resume must re-carry it exactly like the system prompt above.
  const effort = resolveClaudeEffort(opts.effort)
  if (effort.effort) argv.push("--effort", effort.effort)
  argv.push(...claudeUltracodeFlags(effort))
  if (opts.pluginDir) argv.push("--plugin-dir", opts.pluginDir)
  argv.push(...claudeMcpFlags(opts.frizzMcp, opts.projectMcpServers))
  argv.push(...workerDisallowedToolFlags())
  // The system prompt is rebuilt per invocation — the resume must re-carry the worker norms too.
  // Same file-based path as buildClaudeCommand (see systemPromptFlags): inline would put the whole
  // ~16KB on the command line.
  const worker = opts.workerPrompt ?? loadWorkerPrompt()
  const system = [worker, opts.extraSystemPrompt?.trim()].filter(Boolean).join("\n\n")
  argv.push(...systemPromptFlags(opts.sessionId, system))
  argv.push("-r", opts.sessionId)
  if (opts.message) argv.push(opts.message)
  return argv
}

export interface Dispatcher {
  // `opts.backend` selects the agent backend for THIS dispatch (Codex-support epic, Phase 2); omitted /
  // "claude" is the default, so the RPC path (which passes no opts until the Phase-3 UI picker wires
  // DispatchInput.backend through) is byte-identical to before. A codex dispatch pre-arms the cwd trust
  // gate, spawns the codex TUI, then sentinel-discovers + pins the rollout id on the row.
  dispatch(input: DispatchInput, opts?: { backend?: BackendKind }): Promise<{ slug: string; sessionId: string }>
  // Cold-adopt an EXISTING thread frizz didn't originate (e.g. a repo with a pre-existing .frizz
  // board): spawn a fresh worker pointed at the thread file. Frizz's contract makes this sound —
  // the doc, not the conversation, is the durable context; the worker reads it and continues.
  adopt(slug: string, message?: string): Promise<{ slug: string; sessionId: string }>
  // Take over an EXTERNAL session — one of the human's own `claude`/`codex` terminals, listed in the
  // rail's External band. Distinct from `adopt` above, which cold-starts a fresh worker on a thread
  // FILE: this one binds frizz to a conversation that already exists and continues it.
  adoptSession(input: { sessionId: string; backend: BackendKind; title?: string }): Promise<{ slug: string; sessionId: string }>
}

export interface DispatchDeps {
  project: Project
  storage: Storage
  board: BoardManager
  // Adoption never authorizes from the BoardManager's potentially stale cache. Re-scan the legacy
  // board at click time, after the selected file has passed the direct-file containment check.
  readBoard?: typeof readBoard
  getSettings: () => Settings
  claudeBin?: string // injectable (tests / a stand-in command)
  // Inert since the broker became the only transport: dispatch spawns through the bridge, and the
  // rollback these seams performed — killing the terminal a worker had been claimed in — has nothing
  // left to kill. Both stay as accepted-and-ignored seams so existing fixtures still typecheck.
  spawn?: unknown
  killExpectedAdoptionPane?: unknown
  // Per-session agent-backend resolver that builds the spawn argv + injection (Codex-support epic).
  // Injected by the composition layer (context.ts); when absent (tests) dispatch falls back to the
  // local Claude argv builder, producing a byte-identical command. Selected by `opts.backend`.
  backendFor?: (kind?: string) => AgentBackend
  // The Codex app-server bridge (context.ts). A codex dispatch runs SOLELY over the JSON-RPC bridge
  // (persisted session + turn/start); the interactive-TUI transport it replaced is gone. Absent ⇒ a
  // codex dispatch fails loudly rather than falling back to a retired path.
  codexAppServer?: CodexAppServerBridge
  // The Claude session-broker bridge (context.ts). Every claude dispatch runs over it — headless, in a
  // detached daemon, with no terminal and no PTY. Absent ⇒ a claude dispatch fails loudly.
  claudeBroker?: ClaudeAgentBrokerBridge
  // Failure cleanup targets only the exact freshly-spawned slug and its session-id-keyed files
  // (cleanupDispatchFiles), so a failed dispatch can never disturb a neighbouring thread.
  // Provider auth preflight (claude-auth plan, Slice A): resolves the target provider's credential
  // state BEFORE any thread state exists; a positive "signed-out" rejects the dispatch with
  // ProviderAuthRequiredError. Injected by the composition layer (context.ts: `claude auth status
  // --json` for Claude, the local auth.json read for Codex). Absent (tests) ⇒ no preflight, so unit
  // tests never shell out or depend on the developer's real credential state.
  preflightAuth?: (kind: BackendKind) => Promise<ProviderAuth>
  // Codex-only: is the `codex` executable actually runnable? Auth says a credential EXISTS; this says
  // whether the binary the dispatch needs is installed. "missing" (a positive ENOENT) rejects EARLY,
  // before any thread state, with a message that names the real problem instead of the deep
  // "daemon exited before it became ready" a missing binary otherwise produces. Fails open on
  // "unknown". Absent (tests) ⇒ no probe.
  preflightCodexBinary?: () => Promise<"present" | "missing" | "unknown">
  // Durable adoption recovery seams. The production runtime is INERT since the transport cutover —
  // it answers "absent" to every lookup, because the terminal panes its token-aware exact-match
  // implementation used to identify no longer exist — so recovery now rests entirely on the durable
  // SQLite claim/token ledger; focused tests inject an in-memory runtime and deterministic time.
  adoptionRuntime?: AdoptionRecoveryRuntime
  adoptionNow?: () => number
  adoptionAttemptToken?: () => string
}

export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const readBoardSource = deps.readBoard ?? readBoard
  const frizzDir = join(deps.project.dir, ".frizz")
  const adoptionRuntime: AdoptionRecoveryRuntime = deps.adoptionRuntime ?? productionAdoptionRuntime

  // Build the detached-spawn command through the backend seam for the chosen `kind` (falling back to
  // the local Claude builder when no resolver is injected — identical argv). Returns argv + prewrites.


  function cleanupPrewrites(built: BuiltCommand): void {
    for (const path of new Set(built.prewrite.map((file) => file.path))) {
      try {
        rmSync(path, { force: true })
      } catch {
        // Best-effort: these session-id-keyed files are inert and never identify another worker.
      }
    }
  }

  function cleanupDispatchFiles(scratchRel: string, built: BuiltCommand, sessionId: string): void {
    cleanupPrewrites(built)
    try {
      // `recursive` because this is a DIRECTORY now, not one file. A failed dispatch has produced no
      // agent and therefore nothing in it, but removing it whole is what keeps a rejected dispatch from
      // leaving a trace — and the path is session-id-keyed, so it can never name another worker.
      rmSync(join(deps.project.dir, scratchRel), { force: true, recursive: true })
    } catch {
      // The session-id-keyed scratch directory is inert and never identifies another worker.
    }
    cleanupAdoptionSessionFiles(deps.project.dir, sessionId)
  }

  return {
    async dispatch(input, opts) {
      // Dispatcher is a server boundary too: tests, schedulers, and future transports may call it
      // without traversing the RPC parser. Reject malformed explicit slugs before scratch/spawn/SQLite.
      input = DispatchInput.parse(input)
      const settings = deps.getSettings()
      const kind: BackendKind = opts?.backend ?? "claude"
      // Auth preflight (Slice A): block ONLY on a positive "signed-out" — "unknown" (flaky read,
      // missing binary, timeout) fails OPEN so a network blip never traps a logged-in user. Runs
      // before the scratchpad/spawn/registry so a rejected dispatch leaves zero trace; the browser
      // keeps the draft and opens the sign-in modal off the sentinel message.
      if (deps.preflightAuth && (await deps.preflightAuth(kind).catch((): ProviderAuth => "unknown")) === "signed-out") {
        throw new ProviderAuthRequiredError(kind)
      }
      // Codex needs the `codex` executable, not just a credential. Probe it here, in the same
      // zero-trace window as the auth preflight, so a missing binary fails with an actionable message
      // BEFORE any scratchpad/registry state is created — instead of proceeding to a deep app-server
      // "daemon exited before it became ready". Fails open on "unknown" (see readCodexBinaryState).
      if (kind === "codex" && deps.preflightCodexBinary &&
        (await deps.preflightCodexBinary().catch((): "unknown" => "unknown")) === "missing") {
        throw new Error("Codex is not installed, or the `codex` executable is not on PATH. Install the Codex CLI and retry.")
      }
      // Title: explicit human title, else the heuristic chop. (A headless `claude -p` titling pass
      // was tried and REMOVED — print mode is going away for Max subscription auth, which is the
      // whole reason a frizz worker has never been a `-p` invocation: it runs as a full interactive
      // session, today inside the broker daemon. Claude's own evolving ai-title
      // takes over the display name seconds after the session starts; only the slug is heuristic.)
      const title = input.title?.trim() || fallbackTitle(input.prompt)
      const base = input.slug ?? slugify(title)
      const slug = resolveSlug(frizzDir, base, (s) => deps.storage.getSession(s) !== undefined)
      // Codex TUI does not reliably emit either a native title or Frizz's requested hidden marker.
      // Keep the already bounded, deterministic dispatch title as the durable automatic fallback.
      // Unlike the full composed prompt, fallbackTitle is capped and topic-oriented; a later valid
      // provider/Frizz signal may still replace it through the title_auto CAS.
      const registryTitle = title
      const sessionId = randomUUID()
      const permissionMode = workerDispatchPermission(kind, settings)
      // Resolve the profile ONCE for this session. It feeds both the CLI argv and the persisted row,
      // so the thread UI describes what this dispatch actually launched with rather than whatever the
      // mutable global defaults happen to be when the drawer is opened later.
      const model = input.model ?? settings.model
      const effort = input.effort ?? settings.effort

      // Session-first: provision the thread's scratch DIRECTORY (empty; the worker fills it or does
      // not) — NO .frizz/<slug>.md file. It keys on the frizz-minted sessionId, which stays the row's
      // session_id for BOTH backends (codex's discovered rollout id is pinned separately on
      // agent_session_id).
      const scratchRel = writeScratchDir(deps.project.dir, sessionId)

      const prompt = composePrompt(sessionId, input.prompt, kind)

      // Codex app-server transport: a PERSISTED JSON-RPC session + the prompt as its first turn. No
      // terminal and no rollout discovery — the bridge returns the codex session id, which the tailer
      // locates on disk exactly like a discovered rollout (identical filename suffix). This is the SOLE
      // codex transport: the interactive TUI path was retired, so a codex dispatch that can't reach the
      // bridge fails loudly rather than degrading. The worker contract + scratchpad orientation ride
      // baseInstructions, and the frizz title protocol rides developerInstructions.
      if (kind === "codex") {
        const bridge = deps.codexAppServer
        if (!bridge) {
          cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
          throw new Error("Codex app-server is unavailable; cannot start this thread. Check that `codex` is installed and its app-server protocol matches the pinned revision (re-pin if you upgraded codex).")
        }
        const extraSystemPrompt = [scratchpadOrientation(sessionId, kind), frizzConfigBlock(deps.project.dir)]
          .filter(Boolean).join("\n\n")
        try {
          const spawned = await bridge.spawnDispatch({
            threadSlug: slug,
            sessionId,
            cwd: deps.project.dir,
            prompt,
            model,
            effort,
            sandbox: codexSandbox(permissionMode) as "read-only" | "workspace-write" | "danger-full-access",
            baseInstructions: [loadWorkerPrompt("codex"), extraSystemPrompt].filter(Boolean).join("\n\n"),
            developerInstructions: CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS,
            config: { model_reasoning_summary: "detailed", ...codexScratchpadHookConfig(scratchpadHookScript(), sessionId) },
          })
          deps.storage.upsertSession({
            slug,
            session_id: sessionId,
            thread_name: threadIdentityName(slug),
            spawned_at: new Date().toISOString(),
            last_read_at: null,
            unread: 0,
            exited: 0,
            archived: 0,
            rested_at: null,
            title_auto: input.title?.trim() ? 0 : 1,
            title_locked: 0, // a caller's hard-coded title is not a human's — the worker may rename it
            title: registryTitle,
            state: "open",
            meta: null,
            seen_at: null,
            transcript_id: null,
            model: model ?? null,
            effort: effort ?? null,
            permission_mode: permissionMode,
          })
          // NO GOAL ON A BRAND-NEW THREAD (2026-08-16). Every thread used to be born with the stop-hook Goal
          // armed, because a worker that rested without signing off had nothing to bring it back. The built-in
          // handoff bump does that now — it fires on exactly the rests that need it, carries the three terminal
          // states and lists the thread's live work with the ids a fence needs — so arming a Goal as well is the
          // same nudge twice, and the maintainer called it redundant. Arming one is the FOOTER PANEL's job now,
          // and that panel prefills the default text without switching any trigger on.
          deps.storage.setBackend(slug, "codex")
          // The codex SESSION id (not the thread id) matches the rollout filename the tailer scans for.
          deps.storage.setAgentSession(slug, spawned.binding.codexSessionId)
          deps.storage.setCodexRuntime(slug, "app-server")
          void deps.board.rebuild().catch(() => {})
          return { slug, sessionId }
        } catch (err) {
          // No second transport — the app-server is the sole codex one. If it can't be reached (or the
          // installed codex drifted from the pinned protocol), fail LOUDLY with an actionable hint rather
          // than silently degrading to the retired TUI path. Clean up the scratchpad + any partial bridge
          // binding so a failed dispatch leaves no trace.
          try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch { /* best-effort */ }
          cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
          throw new Error(`Codex app-server could not start this thread: ${(err as Error).message}. Check that \`codex\` is installed and its app-server protocol matches the pinned revision (re-pin if you upgraded codex).`)
        }
      }

      // Claude session-broker transport, the SOLE claude transport — exactly the shape the codex branch
      // above already has. A DETACHED daemon owns the Claude Agent SDK session over a local socket, so
      // the session OUTLIVES frizz: a restart reconnects to the LIVE session instead of cold
      // resume-from-disk, and permissions stay structured and TYPED (no terminal, no PTY, no TUI
      // scraping — none of which frizz has had since the cutover). FRIZZ_CLAUDE_BROKER_BRIDGE="0" is a
      // kill switch, not a fallback: with the bridge absent (that switch, or a test context) there is no
      // other path left, so the dispatch fails loudly rather than degrading. The worker contract +
      // scratchpad orientation ride the appended system prompt, and persistSession makes the daemon
      // write the tailer-readable transcript JSONL — the same format and the same reader every claude
      // thread has always used — so the board/tailer treat this row as headless via isHeadlessRow.
      if (kind === "claude") {
        const bridge = deps.claudeBroker
        if (!bridge) {
          cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
          throw new Error("Claude session broker is unavailable; cannot start this thread.")
        }
        const appendSystemPrompt = [
          loadWorkerPrompt("claude"),
          scratchpadOrientation(sessionId, kind),
          frizzConfigBlock(deps.project.dir),
        ].filter(Boolean).join("\n\n")
        try {
          await bridge.spawnDispatch({
            threadSlug: slug,
            sessionId,
            cwd: deps.project.dir,
            prompt,
            permissionMode,
            appendSystemPrompt,
            model,
            effort,
          })
          deps.storage.upsertSession({
            slug,
            session_id: sessionId,
            thread_name: threadIdentityName(slug),
            spawned_at: new Date().toISOString(),
            last_read_at: null,
            unread: 0,
            exited: 0,
            archived: 0,
            rested_at: null,
            title_auto: input.title?.trim() ? 0 : 1,
            title_locked: 0, // a caller's hard-coded title is not a human's — the worker may rename it
            title: registryTitle,
            state: "open",
            meta: null,
            seen_at: null,
            transcript_id: null,
            model: model ?? null,
            effort: effort ?? null,
            permission_mode: permissionMode,
          })
          // NO GOAL ON A BRAND-NEW THREAD (2026-08-16). Every thread used to be born with the stop-hook Goal
          // armed, because a worker that rested without signing off had nothing to bring it back. The built-in
          // handoff bump does that now — it fires on exactly the rests that need it, carries the three terminal
          // states and lists the thread's live work with the ids a fence needs — so arming a Goal as well is the
          // same nudge twice, and the maintainer called it redundant. Arming one is the FOOTER PANEL's job now,
          // and that panel prefills the default text without switching any trigger on.
          deps.storage.setBackend(slug, "claude")
          deps.storage.setClaudeRuntime(slug, "broker")
          void deps.board.rebuild().catch(() => {})
          return { slug, sessionId }
        } catch (err) {
          // No second transport to fall back to once the broker has this dispatch: fail LOUDLY and leave
          // no trace. Release any partial daemon binding and roll back the scratchpad.
          try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch { /* best-effort */ }
          cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
          throw new Error(`Claude session broker could not start this thread: ${(err as Error).message}.`)
        }
      }

      // Both backends have exactly one transport now (codex → app-server, claude → broker) and each
      // branch above either returns or throws. A `kind` outside that pair is a programming error, not
      // a runtime state a dispatch should silently degrade on.
      cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
      throw new Error(`unsupported backend for dispatch: ${String(kind)}`)
    },

    // ---- PROMOTION: the human steered one of their own terminals, so it becomes a frizz thread ----
    //
    // There is no "adopt" button and no separate ceremony (maintainer 2026-08-24: "once the user steers
    // an external thread, it should then be essentially promoted to operate as a regular thread"). The
    // External band's rows carry an ordinary composer; sending the first message calls this, and by the
    // time that message is delivered the row is registered and every other surface treats it as normal.
    //
    // It creates a ROW and stops — no worker is started here. The session is at rest (the band lists
    // nothing else), so the follow-up that triggered this resumes it through the SAME broker path every
    // other rested thread takes. Spawning here too would be a second, parallel resume path to keep
    // correct forever.
    //
    // THE ID DOES NOT CHANGE. The slug, the session id and the external transcript id are all the same
    // value, and that is load-bearing rather than lazy: the promotion happens UNDER a composer that is
    // already mounted, and every piece of optimistic client state around it — the queued bubble, the
    // steer overlay, the per-slug send queue, the draft key — is keyed by slug. Minting a fresh readable
    // slug would strand all of it on an id that no longer exists, mid-send. A session uuid satisfies the
    // slug contract (lowercase hex + hyphens), and the row still DISPLAYS its real title, so the only
    // cost is a uuid in the URL.
    //
    // Codex additionally pins the same id on `agent_session_id`, because that is the column its rollout
    // is located by; claude needs nothing extra, since its transcript IS `<session_id>.jsonl`. Either
    // way the id now belongs to a registry row, so the foreign scan stops surfacing it and the session
    // leaves the External band on the next tick — there is no separate hand-off to forget.
    async adoptSession(input) {
      const parsed = AdoptSessionInput.safeParse(input)
      if (!parsed.success) throw new Error("that session cannot be adopted")
      const { sessionId: externalId, backend, title } = parsed.data
      // The id must be genuinely UNOWNED. Checking the registry (rather than trusting the caller's
      // claim that this came from the External band) is what stops a crafted request from minting a
      // second row over a thread frizz is already driving.
      for (const row of deps.storage.allSessions()) {
        if (row.session_id === externalId || row.agent_session_id === externalId || row.transcript_id === externalId) {
          throw new Error("that session is already a frizz thread")
        }
      }
      const displayTitle = title?.trim() || `Session ${externalId.slice(0, 8)}`
      const slug = externalId
      const sessionId = externalId
      // The worker's scratch directory keys on the row's OWN session_id, matching dispatch — so a
      // promoted thread's scratch dir is named for the transcript it inherited.
      writeScratchDir(deps.project.dir, sessionId)
      deps.storage.upsertSession({
        slug,
        session_id: sessionId,
        thread_name: threadIdentityName(slug),
        spawned_at: new Date().toISOString(),
        last_read_at: null,
        unread: 0,
        exited: 0,
        archived: 0,
        rested_at: new Date().toISOString(),
        // The name came from the session's OWN title (Claude's ai-title) or a short id — a real name
        // either way, not the dispatch chop, so it is not marked provisional. It stays replaceable:
        // the worker's own later title for the task is nearly always the more informative one.
        title_auto: 0,
        title: displayTitle,
        transcript_id: null,
        state: "open",
        meta: null,
        seen_at: null,
      })
      deps.storage.setBackend(slug, backend)
      if (backend === "codex") deps.storage.setAgentSession(slug, externalId)
      // The TRANSPORT, without which the follow-up that triggered this promotion has nowhere to go.
      // Every claude thread is broker-backed — the legacy path throws "frizz has no other claude
      // transport" — and a row that never went through dispatch does not get this stamped for free.
      else deps.storage.setClaudeRuntime(slug, "broker")
      return { slug, sessionId }
    },

    async adopt(slug, message) {
      const unavailable = () => new Error("thread is not available for adoption")
      const parsed = AdoptThreadInput.safeParse({ slug, message })
      if (!parsed.success) throw unavailable()
      slug = parsed.data.slug
      message = parsed.data.message

      // Authorization is deliberately reconstructed from current raw inputs instead of trusting a
      // browser affordance or the BoardManager cache: exact direct file identity + one fresh, valid,
      // nonterminal, unowned, agentless board row + no registry row and no adoption claim already
      // owning the slug. Every precondition shares
      // one non-oracular failure and occurs before ensureServer, scratch creation, spawn, or storage.
      const source = resolveLegacyThreadFile(deps.project.dir, slug)
      if (!source) throw unavailable()
      let freshBoard: FrizzBoard
      try {
        freshBoard = await readBoardSource(deps.project.dir)
        if (!boardAuthorizesAdoption(freshBoard, slug)) throw unavailable()
      } catch {
        throw unavailable()
      }
      // A registry row owns its slug regardless of whether its worker is currently alive, exited, or
      // archived. Adoption is a cold-start path, never a replacement/resume path.
      try {
        if (deps.storage.getSession(slug)) throw unavailable()
      } catch {
        throw unavailable()
      }

      // Retry performs the same leased reconciliation as boot. A stale attempt can be removed only
      // after its token is absent (or its exact tuple was killed); an active/finalized/conflicted claim
      // remains authoritative and returns the same non-oracular response as every other ineligible row.
      try {
        const outcome = reconcileAdoptionClaims({
          storage: deps.storage,
          projectDir: deps.project.dir,
          now: deps.adoptionNow,
          runtime: adoptionRuntime,
          slug,
        }).get(slug)
        // A retired-token orphan has no live claim by design. Its reconciliation outcome is therefore
        // an independent ownership fence: do not infer safety solely from the row/claim registry.
        if (outcome && outcome !== "recovered-stale-attempt") throw unavailable()
        if (deps.storage.getSession(slug) || deps.storage.getAdoptionClaim(slug)) throw unavailable()
      } catch {
        throw unavailable()
      }

      const recheckedSource = resolveLegacyThreadFile(deps.project.dir, slug)
      if (!recheckedSource || !sameFileStat(source, recheckedSource)) throw unavailable()

      const settings = deps.getSettings()
      const sessionId = randomUUID()
      const attemptToken = deps.adoptionAttemptToken?.() ?? randomUUID()
      const now = deps.adoptionNow ?? Date.now
      const reservedAtMs = now()
      try {
        if (!deps.storage.reserveAdoptionClaim({
          slug,
          attemptToken,
          sessionId,
          reservedAtMs,
          leaseExpiresAtMs: reservedAtMs + ADOPTION_ATTEMPT_LEASE_MS,
        })) {
          throw unavailable()
        }
      } catch {
        throw unavailable()
      }

      let scratchRel: string | undefined
      const rollback = (): void => {
        let abandoned = false
        try {
          abandoned = abandonAdoptionAttempt({
            storage: deps.storage,
            projectDir: deps.project.dir,
            slug,
            attemptToken,
            sessionId,
            runtime: adoptionRuntime,
          })
        } catch {
          // Leave the durable claim for boot recovery if storage is temporarily unavailable.
        }
        if (!abandoned) return
        if (scratchRel) cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
        else cleanupAdoptionSessionFiles(deps.project.dir, sessionId)
      }

      // The adoption orientation is SYSTEM-level (the visible transcript carries only the human's own
      // words). Session-first: the legacy file is prior CONTEXT to read first, NOT a contract to maintain
      // — the worker works session-first from here (scratchpad + end-of-turn fences), leaving the file's
      // frontmatter untouched.
      const adoption =
        "ADOPTION: this thread predates you and has prior context recorded in `.frizz/" +
        slug +
        ".md` (a previous agent or session worked it — you have no access to that conversation, and you don't need it). READ THAT FILE FIRST for context: `## Goal` is the mission, `## Status`/`## Decisions`/`## Next step` are where things stand. It is CONTEXT, not a contract — do NOT edit its frontmatter. You work session-first from here: keep your working state in your scratchpad and signal end-of-turn with the done/awaiting fences. The human's message below is your steer on top of that context."
      const task = message?.trim() || "Pick up this thread and continue from where the file says things stand."
      // Provision a scratch directory too (the adopted worker's own space); the legacy file stays read-only.
      try {
        scratchRel = writeScratchDir(deps.project.dir, sessionId)
      } catch {
        rollback()
        throw unavailable()
      }
      const prompt = composePrompt(sessionId, task)
      const permissionMode = workerDispatchPermission("claude", settings)

      // Adoption spawns through the broker, exactly like a fresh dispatch. It used to claim a terminal
      // pane under a leased attempt token and rebind the pane identity across slow post-create setup —
      // a multi-process protocol whose entire purpose was making a PANE claim safe. There is no pane
      // to claim now: the daemon record plus the session id is the identity, so the attempt token
      // stays (it still fences two frizz processes racing the same slug) and everything pane-shaped goes.
      const bridge = deps.claudeBroker
      if (!bridge) {
        rollback()
        throw unavailable()
      }
      // Re-check the authorized file identity immediately before spawning: local provisioning above is
      // the window in which the source could have been replaced under us.
      const beforeSpawn = resolveLegacyThreadFile(deps.project.dir, slug)
      if (!beforeSpawn || !sameFileStat(source, beforeSpawn)) {
        rollback()
        throw unavailable()
      }
      try {
        await bridge.spawnDispatch({
          threadSlug: slug,
          sessionId,
          cwd: deps.project.dir,
          prompt,
          permissionMode,
          appendSystemPrompt: [
            loadWorkerPrompt("claude"),
            scratchpadOrientation(sessionId),
            frizzConfigBlock(deps.project.dir),
            adoption,
          ].filter(Boolean).join("\n\n"),
          model: settings.model,
          effort: settings.effort,
        })
      } catch {
        try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch { /* best-effort */ }
        rollback()
        throw unavailable()
      }

      const adopted = {
        slug,
        session_id: sessionId,
        thread_name: threadIdentityName(slug),
        spawned_at: new Date(now()).toISOString(),
        last_read_at: null,
        unread: 0,
        exited: 0,
        archived: 0,
        rested_at: null,
        title_auto: 0, // adopted threads keep their file title
        title_locked: 1, // …and that heading is human-authored, so no auto-title may overwrite it
        title: null,
        state: "open",
        meta: null,
        seen_at: null,
        transcript_id: null,
        // Adoption starts a NEW session using the dispatch defaults in force at that moment. Pin those
        // values now; a later settings change must not relabel this adopted conversation.
        model: settings.model ?? null,
        effort: settings.effort ?? null,
        permission_mode: permissionMode,
        // Adoption always starts a fresh Claude session. Keep both identity columns in the SAME atomic
        // insert so a prior/competing Codex owner can never leak its native id into this row.
        backend: "claude",
        agent_session_id: null,
      } satisfies SessionRow

      let claimed = false
      try {
        claimed = deps.storage.finalizeAdoptionClaim(slug, attemptToken, adopted, now())
      } catch {
        rollback()
        throw unavailable()
      }
      if (!claimed) {
        rollback()
        throw unavailable()
      }

      deps.storage.setClaudeRuntime(slug, "broker")
      void deps.board.rebuild().catch(() => {})
      return { slug, sessionId }
    },
  }
}
